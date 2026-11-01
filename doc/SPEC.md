# Stencil Core, Specification v0.2 (draft)

Stencil is two documents:

| Document | Contents | Stability |
|---|---|---|
| SPEC.md (this file), *Core* | Syntax, resolution, units, resolved form, versioning, diagnostics | Small; freeze early |
| VOCABULARY.md, *Vocabulary std/0* | What `layer`, `site`, `rule`, ... mean and which attributes they take | Expected to churn while the project is young |

The Core knows nothing about semiconductors. It defines how to write
objects with attributes, how to compose them across files, and how
to turn them into a flat, exact, hashed JSON that tools read. All
domain meaning lives in the vocabulary, a schema that can grow without
touching the parser. This is the Liberty / Devicetree / HCL pattern;
LEF/DEF is the counterexample (vocabulary baked into grammar, so LEF 5.8
had to smuggle new rules through `PROPERTY LEF58_* "..."` strings).

Tags: [PROPOSED] recommended default, [OPEN] needs a decision.
RFC 2119 keywords (MUST, SHOULD, MAY) are normative.

---

## 1. Principles

1. Small grammar, large vocabulary. The Core has 4 keywords, 4 literal
   words and 1 sigil (section 2.5). Everything else is a name checked against the
   vocabulary.
2. Declarative and total. No loops, recursion, user-defined functions
   or I/O. Every description resolves in finite time.
3. Exact. Rational arithmetic and explicit units. No silent rounding.
4. Composable and order-independent. Importing A then B gives the
   same result as B then A.
5. Consumers read the resolved form. Only a Stencil front end needs to
   understand modules, parameters and patches. Every other tool reads flat
   JSON (section 5).
6. Live-tool friendly. Parsing and resolution recover from errors,
   report precise locations, and map every resolved value back to its
   source (section 7). This is what makes a live editor and visualizer possible.

## 2. Syntax

### 2.1 Lexical rules

- UTF-8. Comments run from `#` to end of line.
- Names: `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive. Vocabulary words use
  `snake_case` (`cut_spacing`, `share_rails`); there are no hyphens, so
  `a-b` is always subtraction.
- Numbers: `3`, `0.5`, `-1`. A decimal point must be followed by a digit,
  so `1..4` lexes as a range.
- Lengths: a number immediately followed by a unit: `45nm`, `0.045um`.
  [PROPOSED] Units in v0.1: `nm`, `um`.
- Strings: `"..."` with `\"` and `\\` escapes. Used only for paths and free
  text.
- Statements end at a newline or `;`. Newlines inside `[ ]` or `( )` are
  ignored.

### 2.2 Statements

Five statement forms make up the whole language:

```
stencil 0.1                              # header (first line)

CPP = 45nm                               # 1. assignment: a parameter (top level)
                                         #    or an attribute (inside a body)

layer M1 { role = conductor }            # 2. object: KIND NAME { body }
technology { grid = 1nm }                #    the name is optional

import "lib/frontside" as fs { MP1 = 30nm }    # 3. import, optional parameter bindings

&fs.M1 { masks = 1 }                     # 4. patch an existing object

drop fs.VR                               # 5. remove an object
```

A body (`{ ... }`) contains assignments, nested objects, patches and drops.
Nested objects are how structured attributes are written:

```
site CORE {
  height = 240nm
  rail VDD { layer = M0; edge = top }    # nested object, named
  table { width = [0nm, 30nm] }          # nested object, unnamed
}
```

### 2.3 Values and expressions

| Form | Example | Meaning |
|---|---|---|
| number | `3`, `1.5` | Exact rational |
| length | `45nm` | Exact rational length |
| string | `"gt2n/device"` | Text |
| name / reference | `vertical`, `M1`, `dev.CPP`, `SHEET.width` | Enum value, object, parameter or attribute (section 3.2) |
| list | `[W1, W2, W3]` | Ordered list |
| range | `1..4`, `20nm..60nm` | Closed interval. Integer or continuous, as the vocabulary says |
| arithmetic | `2/3 * dev.CPP`, `MP1/2` | `+ - * /` with usual precedence, parentheses |
| comparison | `M1.pitch >= M1.width + 13nm` | `< <= > >= == !=`, lowest precedence; gives `true`/`false` |
| call | `grow(NW_SRC, 10nm)`, `snap(x)` | Function from the vocabulary's closed list |
| literal words | `true` `false` `none` `required` | `none` is the explicit "nothing" value; the vocabulary gives it meaning (std/0: `direction = none`, `cut = none`). `required` marks a parameter that importers must bind |

Braces only ever mean a body. Lists use `[ ]`, ranges use `..`. This
removes any set/block/range ambiguity.

### 2.4 Grammar (EBNF)

```ebnf
file    = header , { sep } , { stmt , sep } ;
header  = "stencil" , VERSION ;
(* Blocks and expressions nest at most 256 levels deep; deeper is C001. *)

stmt    = assign | object | import | patch | drop ;
assign  = NAME , "=" , expr ;
object  = NAME , [ NAME ] , body ;          (* kind, optional name *)
import  = "import" , STRING , "as" , NAME , [ body ] ;
patch   = "&" , ref , body ;
drop    = "drop" , ref ;
body    = "{" , { sep } , { stmt , sep } , "}" ;   (* no import inside *)

expr    = range , [ cmp , range ] ;            (* comparisons are not chained *)
cmp     = "<" | "<=" | ">" | ">=" | "==" | "!=" ;
range   = sum , [ ".." , sum ] ;
sum     = prod , { ( "+" | "-" ) , prod } ;
prod    = unary , { ( "*" | "/" ) , unary } ;
unary   = [ "-" ] , atom ;
atom    = NUMBER , [ UNIT ] | STRING | call | ref | list
        | "(" , expr , ")" | "true" | "false" | "none" | "required"
        | "required" , "(" , NAME , ")" ;   (* only as a parameter's whole value *)
call    = NAME , "(" , [ expr , { "," , expr } ] , ")" ;
list    = "[" , [ expr , { "," , expr } , [ "," ] ] , "]" ;
ref     = NAME , { "." , NAME } ;

sep     = NEWLINE | ";" ;
```

The grammar is LL(2) and does not depend on the vocabulary. A parser
written once never changes when the vocabulary grows.

### 2.5 Reserved words

| Kind | Words |
|---|---|
| Keywords | `stencil` `import` `as` `drop` |
| Literal words | `true` `false` `none` `required` |
| Sigil | `&` (patch) |
| Reserved attributes (any object) | `base` (inherit, section 3.4), `note` (free text kept in output) |

## 3. Resolution semantics

### 3.1 Modules and instances

- One file is one module. A project is a main file plus everything it
  imports.
- Module paths: `"gt2n/device"` is relative to the project root;
  `"./x"` and `"../x"` are relative to the importing file. `.stencil` is
  added when missing. A missing file is C011; an import cycle is C010.
- Optional metadata object: `module { version = "1.2.0" }`.
- Top-level assignments are the module's parameters. A parameter
  with value `required` must be bound by the importer (C012, reported at
  the import and at the parameter).
- Typed parameters. `X = required(T)` declares the type the importer
  must supply; `T` is `len`, `number`, `area`, `string`, `bool`, `name`
  (an enum word), `any`, or an object kind (`layer`, `site`, ...).
  `required(T)` is only valid as a parameter's value; untyped `required`
  accepts anything. A parameter with a default (`MP = 30nm`) can only be
  rebound to a value of the default's evaluated type, inferred for
  numbers, lengths, areas, strings, booleans, names and object references;
  defaults that are lists, ranges or `one_of(...)` do not constrain the
  binding. A mismatch is C014 at the binding; binding one parameter twice
  in an import is C020. A reference to an object that is dropped later keeps
  its kind for this check (the drop then cascades as usual). Bindings are checked even
  when nothing uses the parameter. Anything beyond the
  type (ranges, relations) belongs in a `check`, which can name the
  parameter: `check { holds = MP >= 2 * M1.width }`.
- Every `import` creates an instance: the module's objects and
  parameters, evaluated with that import's bindings and options. Two
  imports of one file with different bodies are two instances. Imports
  without a body share one instance (diamond imports), but only within one
  transform scope: the nearest enclosing import that has `rename`,
  `gds` or `scale` options (or the main module). The same file reached
  under different options is a different instance, so it never silently
  takes the options of whichever importer came first.
- The import body holds bindings (`MP1 = 2/3 * dev.CPP`) and the
  option blocks `rename { }`, `gds { }` and `scale { }` (section 3.10). Binding a
  name the module does not declare is C013. Binding expressions are
  evaluated in the importer's scope.
- Every expression keeps the scope it was written in: a module's own
  attributes see its own parameters; a patch written in the importer sees
  the importer's names; inherited attributes keep the scope of the object
  they came from.
- Any module may contain a `technology` block; only the main module's
  grid and stack decide. An imported grid that is not a multiple or
  divisor of the main grid is W031.
- Path resolution against a search path or lockfile is still open
  (Appendix B).

### 3.2 Names and references

- Within a module, top-level names (objects, parameters, import aliases)
  are unique across all kinds (C020).
- Nested objects are scoped to their parent: `CORE.VDD`.
- Objects and parameters of an import are reached through its alias:
  `fs.M1`, `dev.CPP`, and through nested aliases: `pdk.fs.M1`.
- `X.attr` reads an attribute of object `X`. A parameter bound to an object
  works the same way: with `L = be.MET1`, `L.pitch` is MET1's pitch.
- A reference that does not resolve is an error (C021) with a "did you
  mean" hint and fix; for qualified names the error is reported where the
  reference is written.

### 3.3 Evaluation

- Expressions are evaluated lazily, after all imports, bindings, patches,
  drops and `base` have been applied, so a patched value is seen by
  everything that depends on it. Dependency cycles are C030.
- Arithmetic is exact rational. Dimensions are checked: `length * number
  -> length`, `length * length -> area`, `length / length -> number`;
  `length + number` is C031.
- Comparisons `< <= > >= == !=` produce `true`/`false`; they are not
  chained. Both sides must have the same dimension; `==`/`!=` also compare
  names, strings and booleans. Ranges and `one_of(...)` cannot be compared
  (C031).
- `all(...)`, `any(...)`, `not(...)` combine comparisons.
- Calls that the vocabulary marks as *geometric* (e.g. `grow`, `minus`)
  are not evaluated during resolution. They describe operations on a
  finished layout and pass into the resolved form as expression trees.
  Their arguments are type-checked against the vocabulary's signatures.

### 3.4 Inheritance: `base`

`base = OTHER` copies `OTHER`'s attributes and nested objects into this
object before this object's own body is applied. `OTHER` may live in an
imported module (`base = dev.CORE`), and nested objects may have their own
`base` (`rail R { base = A.R }`). Merge is deep:

- assignment: this body wins;
- nested named object: merged by name, recursively;
- nested unnamed object: at most one per kind per parent, merged by kind;
- lists are replaced whole, not appended.

`base` must name an object of the same kind (C040). Inheritance cycles are
an error (C041).

### 3.5 Patches and drops

- `&ref { ... }` merges its body into an existing object, in this module or
  an imported one (`&fs.M1 { masks = 1 }`), with the same deep merge as
  `base`. Patching a missing object is C050. Patches apply innermost module
  first, so an importer's patch wins over its imports' patches.
- Two modules that do not import one another must not patch the same
  attribute of a shared object to different values (compared after
  evaluation, each in its own scope): C052. The same holds for structure:
  one dropping a child, attribute or object that the other sets, declares,
  or patches directly (`&c.S.R { ... }`), whether the drop is written inside
  a patch (`&c.S { drop R }`) or as a qualified statement (`drop c.S.R`,
  `drop c.L`), including drops of an ancestor of the patched object; or
  the two declaring children of different kinds under one name. Their
  common importer settles it with its own patch or drop, of the same
  attribute, or of the object or any of its ancestors; a module may always
  drop or patch what its own imports declare. Identical effects (the same
  value, or two drops) are not conflicts. "Imports" means reachable in the
  import graph, not only through the first import of a shared instance.
  Patching an object that one of the module's own imports dropped is C051.
  The decision is taken after every patch and drop is applied, so it does
  not depend on import order.
- Effects are identified by logical path (the object path inside the
  module that declares it, plus the attribute name), so a child that is
  dropped and declared again is still the same child. A drop also clashes
  with an unrelated module's setting anywhere below the dropped object
  (e.g. one module drops `S.R`, another declares `R` again with `width =
  4nm`): a common importer settles it by setting that same attribute (or
  dropping an ancestor). Re-declaring the child alone settles only that the
  child exists.
- What a drop may name (C050 otherwise). `drop X` on an object names
  something real when `X` was declared at that object's logical path by
  the dropping module earlier in its source, or by a module it imports; or
  when it is inherited there through a `base` (on the object or an
  ancestor) that the dropping module itself or one of its imports wrote. It is decided once, after inheritance, so it depends only on
  what the dropping module can see: not on unrelated imports, on their
  order, on replacements or on merges. Dropping something already dropped
  is harmless; declaring a name *after* dropping it does not make the drop
  valid.
- C051 applies when one of the patching module's own imports dropped the
  target or an object above it, and neither that module nor any of its
  imports declared it again afterwards, also when an unrelated module has
  restored it in the meantime. Paths are followed through dropped objects,
  so a patch or a drop below an object that an unrelated module dropped is
  checked the same way in every import order. Objects removed by a cascade
  (I020) are consequences, not effects, and do not take part.
- Inside a body, `drop attr` (or `drop child`) removes it, so it falls back
  to its default: `&M1 { drop masks }`. The drop is remembered through
  merges: an inherited (`base`) or existing value does not come back. A
  later assignment or declaration of the same name in a later body
  restores it.
- `drop ref` removes an object, and drops cascade:
  - an object whose *required* attribute, or whose `from`, refers to a
    dropped object is dropped too (note I020);
  - an item that refers to a dropped object is removed from a list whose
    items are alternatives (`connector.lower`, `site.pins`, ...) (I021);
    a fixed tuple such as `rule.on = [A, B]` is not a list of
    alternatives, so the rule is dropped instead;
  - an optional attribute that refers to a dropped object is removed (I021);
  - a `check` that depends on a dropped object is removed with a warning
    (W040), because the assertion no longer protects anything;
  - this repeats until nothing changes.

  A *numeric* dependency that survives the cascade (`width = M0.width`
  after `drop M0`) is an error (C051).

### 3.6 Flattening and identity

- Every top-level object gets a resolved name: an explicit `rename`
  of its instance (and of every enclosing import, innermost first) wins;
  otherwise the import's `prefix` is prepended. References in source text
  always use the original name (`fs.M1`), never the resolved one.
- Two objects with the same resolved name are C060, with a hint to rename
  or prefix one of them.
- `check` objects from imported instances are emitted under their
  instance-qualified name (`l1.PATTERNABLE`), so one check module can be
  imported once per layer it watches without renaming.
- Each object in the resolved form records its instance (`"module": "fs"`);
  nested objects keep their unqualified names.

### 3.7 Units and grid

- The vocabulary designates where the manufacturing grid is declared (in
  std/0: the main module's `technology { grid = ... }`).
- At the end of resolution every length is converted to integer
  database units (1 DBU = 1 grid step; areas in DBU^2). A length that is
  not an exact multiple of the grid is C070 unless wrapped in `snap()`,
  `floor()` or `ceil()`, or snapped by an import's `scale { snap = true }`.
- Integers outside +/-(2⁵³−1) cannot be written exactly as JSON numbers;
  they are C071 and emitted as decimal strings.
- Exception: rule thresholds (attributes of `rule`, `case`, `table`,
  `alternative`) are exact quantities, not geometry (VOCABULARY.md section 3.1).
  An off-grid threshold is written as the string `"n/d"` (DBU), and one
  beyond +/-(2⁵³−1) as the string `"n"`; neither is an error.

### 3.8 Vocabulary validation and checks

After resolution, the front end validates every object against the
vocabulary (section 4): known kinds, attributes, types, required attributes,
allowed nested kinds, and the vocabulary's own consistency checks. These
produce `V`-coded diagnostics defined in VOCABULARY.md.

Then every `check` object is executed (std/0 defines the kind). A check
whose `holds` is false is V100 (or a warning if its `severity` says so),
and the message shows both sides of each failing comparison and the
parameters the importer bound. A check that cannot be evaluated is V101:
an assertion that cannot be shown to hold does not hold.

### 3.9 Layer order

Vertical order is decided by the vocabulary (std/0: layers), using one
Core rule for sequencing modules:

1. Expand the main module: first the instances listed in its
   `technology.stack`, in that order (each expanded the same way), then any
   other imports in import order (W030 if layers were left out of a stack),
   then its own layers in file order.
2. Apply explicit placements. `below = X` (`above = X`) removes the layer
   and re-inserts it directly below (above) `X`; `level_with = X`
   re-inserts it directly above `X` and gives it `X`'s level. One pass
   applies every placement in sequence order; passes repeat until all
   placements hold, at most (number of placements + 1) times.
3. Verify. The guarantee of `below = X` is only that the layer ends up
   lower than `X` (a later placement may insert another layer between
   them, e.g. two layers both `below = X` keep their sequence order);
   `above` likewise; `level_with` means the same level. A placement that
   still does not hold is V031. Chains such as A above B above C settle;
   cycles cannot.

### 3.10 Import options

```
import "lib/beol" as be {
  MP = 36nm                              # binding
  rename { MET1 = M1; prefix = "BE_" }   # resolved names
  gds { shift = 1000 }                   # GDS layer numbers
  scale { xy = 36/200; z = 1/2; snap = true }
}
```

- `rename { OLD = NEW }` renames one object; `prefix = "P_"` renames all
  others. Renaming an object the module does not have is C021.
- `gds { shift = N }` adds `N` to the layer number of every `gds`,
  `gds_pin` and `gds_label` pair in the instance; nested shifts add up.
  Collisions are still checked after shifting (V021).
- `scale { xy; z; snap }` multiplies every **length literal written in the
  instance's own files** by `xy`, or by `z` when the literal ends up in a
  vertical attribute (`figure.thickness`, the pitch and offset of a z
  array). Areas scale as products of literals. Values that arrive through
  the importer's bindings are not rescaled. Nested scales multiply.
  - A parameter that feeds both horizontal and vertical attributes
    scales twice differently: W032.
  - `snap = true` rounds each scaled literal to the grid, once, before any
    arithmetic; checks run on the snapped values, and the importer gets one
    note (I030) listing what changed. Without `snap`, off-grid results are
    C070 errors.

### 3.11 Resolution order (summary)

```
load + parse every file -> build instances (imports, bindings, options)
  -> per module, imports first: its patches, then its qualified drops
  -> base -> evaluate -> parameter types -> sibling conflicts (C052)
  -> cascade drops -> resolved names -> layer order -> vocabulary validation
  -> checks -> resolved JSON + hash -> cell templates and models
```

Because every import is processed before its importers, a module sees
the patches and drops of all its imports: patching what one of them
dropped is C051, and re-declaring a child it dropped restores it. Sibling
modules (neither imports the other) are compared after all of them are
applied, so the outcome does not depend on their import order.

## 4. Vocabularies

A vocabulary is a machine-readable schema plus prose, published as a
versioned package (std/0 is in VOCABULARY.md; the schema file will live
at `vocab/std-0.yaml`). For each object kind it lists:

- attributes: type, default, whether required, one-line doc;
- allowed nested kinds and how their names are interpreted;
- enum values;
- functions (numeric or geometric) with signatures;
- consistency checks with `V` codes and message templates.

From the same schema, tools generate the reference docs, editor
autocompletion, hover help and the validator. Learners should find out
what goes in a `layer` by typing `layer M1 {` and reading the suggestions,
not by reading this spec.

### 4.1 Extensions [PROPOSED]

- Names starting with `x_` are extensions: `x_lab_curvi_spacing`. Any
  lab or tool may define them in its own schema file.
- A file lists what it depends on: `module { extensions = [x_lab] }`.
- An unknown `x_` name produces a warning (W001), not an error, unless the
  module lists it as required.
- Promotion path (as in glTF/Vulkan): one tool -> `x_<org>_` ->
  adopted by two independent tools -> standard extension -> core
  vocabulary in a minor release. None of these steps change the grammar.

## 5. Resolved form (interchange)

The resolved form is the only thing consumer tools need to read. It is
generic: it does not change shape when the vocabulary grows.

```json
{
  "stencil": "0.1",
  "vocabulary": "std/0",
  "complete": true,
  "grid_nm": "1/2",
  "hash": "sha256:...",
  "modules": [{"path": "lib/frontside.stencil", "as": "fs"}],
  "objects": [
    {"kind": "layer", "name": "M1", "module": "fs",
     "attrs": {"role": "conductor", "direction": "vertical", "masks": 2,
               "width": 48, "pitch": 84, "gds": [19, 0], "order": 6, "side": "front"},
     "defaulted": ["shapes"],
     "children": [],
     "src": "lib/frontside.stencil:12:1",
     "attr_src": {"pitch": "lib/frontside.stencil:12"}}
  ]
}
```

- `complete` is false when there were errors. Such output is for viewing
  only; a generator MUST NOT accept it as input.
- `module` names the instance an object came from (absent for the main
  module); `defaulted` lists attributes filled from vocabulary defaults.

Encoding rules:

| Source value | JSON |
|---|---|
| length | integer DBU |
| non-integer number | string `"num/den"` |
| enum word | string |
| reference | `{"ref": "M1"}` |
| range | `{"min": ..., "max": ...}` |
| list | array |
| geometric call | `{"call": "grow", "args": [ ... ]}` |

- `objects` order: the vocabulary's canonical order (std/0: layers bottom
  to top, then the other kinds by declaration order), so diffs are
  stable.
- Defaults from the vocabulary are filled in, and std/0 layers get an
  explicit `order`, so consumers do not need the vocabulary to read
  values.
- Every object keeps `src` (`file:line:col`) and every attribute keeps its
  location in `attr_src` (`file:line`, the file the value was written in,
  which may be an importer's patch), for traceability and for linking a
  visualizer back to the editor. Objects with errors carry
  `"invalid": true`.
- Canonical bytes: RFC 8785 (JSON Canonicalization Scheme).
  Hash = SHA-256 of the canonical bytes, leaving out `src`,
  `attr_src`, `invalid` and `hash` itself (they are not content: editing a
  comment must not change the hash). Tools write the hash into
  every GDS/LEF they produce, so every cell traces back to the exact
  description that produced it.
- A JSON Schema for the resolved form ships with each Core version.

## 6. Versioning and conformance

### 6.1 Versions [PROPOSED]

- The header `stencil 0.1` names the Core version.
  - MINOR: backwards-compatible additions.
  - MAJOR: anything else.
  - `0.x`: no stability promise.
- The vocabulary has its own version (`std/0`, `std/1`, ...). A module may
  pin it: `module { vocabulary = "std/0" }`. Default: the latest std the
  front end ships.
- Modules carry their own semver (section 3.1).

### 6.2 Reader rules

A consumer of the resolved form:

1. MUST reject a Core MAJOR version it does not implement;
2. MUST reject unknown non-extension kinds or attributes in the
   vocabulary versions it claims to support (no silent ignore);
3. MAY ignore `x_` content, but MUST warn about it;
4. MUST NOT reinterpret an attribute's documented meaning.

### 6.3 Conformance classes

| Class | Obligation |
|---|---|
| Front end | Source -> resolved form; passes `tests/conformance/` |
| Consumer | Reads the resolved form; publishes a profile (see vocabulary) |

Two independent front ends that agree on the conformance suite are the
real test of portability. The browser playground (section 7.2) will likely be the
second one.

## 7. Tooling requirements

### 7.1 Diagnostics

Front ends MUST report diagnostics as records:

```json
{"code": "C021", "severity": "error",
 "file": "front.stencil", "instance": "fs", "line": 12, "col": 9, "end_col": 13,
 "message": "unknown reference 'M11'", "hint": "did you mean 'M1'?"}
```

- Severities: `error`, `warning`, `info` (notes such as cascaded drops).
- `file` is the file the problem is written in; `instance` names the
  import instance when the file is not the main one, because one file can
  be imported several times with different bindings.
- Codes: `C` Core, `V` vocabulary, `W` warnings, `I` notes. Codes are
  stable and are part of the conformance suite.
- A diagnostic MAY carry a `fix`: `{"from", "to", "insert", "label"}`, a
  text edit that resolves it (e.g. replace `pich` with `pitch`, add a
  missing unit, wrap an off-grid value in `snap(...)`). Fixes come from the
  front end, not from the editor, so every tool offers the same ones.
- Messages name the object and attribute and, where possible, give a fix.
  Error messages are a big part of how people learn the format.

### 7.2 Live use (playground) [PROPOSED]

So that an editor can redraw as the user types:

- The parser MUST recover from errors at statement boundaries and keep
  parsing the rest of the file.
- Resolution SHOULD be partial: objects with errors are marked invalid
  and skipped; everything else still resolves and renders.
- Resolving a typical single-file technology SHOULD take well under
  100 ms, so it can rerun on every keystroke (debounced).
- The Core front end SHOULD run in a browser with no install.
  Prototype: `core/` is plain JavaScript (ES modules, no build
  step) and runs unchanged in the browser and in Node. [OPEN] Whether this
  becomes the reference front end, or a second one next to a Python or
  Rust implementation.

## 8. Conformance suite

```
tests/conformance/
  valid/NNN-<name>/     main.stencil [+ modules]   expected.json
  invalid/NNN-<name>/   main.stencil               expected.diag.json
```

First cases:

- one valid case per statement form (section 2.2);
- deep merge: `base` and patches, including nested named and unnamed
  objects;
- order independence: the same composition with imports permuted gives
  an identical hash;
- exact arithmetic: `2/3 * 45nm` on a 1 nm grid (valid) and on a
  0.4 nm grid (C070);
- one invalid case per C code.

## Appendix A, Core diagnostic codes (initial)

| Code | Meaning |
|---|---|
| C001 | Syntax error (with expected tokens) |
| C010 | Import cycle |
| C011 | Import path not found |
| C012 | Required parameter not bound |
| C020 | Duplicate name in module |
| C021 | Unresolved reference |
| C030 | Evaluation cycle |
| C031 | Dimension mismatch |
| C040 | `base` names an object of a different kind |
| C041 | Inheritance cycle |
| C050 | Patch of a missing object, or a drop naming nothing (section 3.5) |
| C051 | Reference to a dropped object |
| C052 | Conflicting patches from sibling imports |
| C060 | Resolved-name collision |
| C070 | Length not on the manufacturing grid |
| C002 | Missing or malformed `stencil` header |
| C022 | Attribute set twice in one block (warning; last wins) |
| C032 | Unknown function or wrong arguments |
| C033 | Division by zero |
| W001 | Unknown extension name |
| C013 | Binding a parameter the imported module does not declare |
| C014 | Parameter type mismatch, or unknown type in `required(T)` |
| C071 | Integer too large to serialise exactly |
| W030 | Imported layers not listed in `technology.stack` |
| W031 | Imported grid incompatible with the main grid |
| W032 | One parameter scaled by both xy and z factors |
| W040 | A check removed because its dependencies were dropped |
| W091 | Patch inside a block (not supported) |
| I020 | Object removed by a cascading drop |
| I021 | List item or optional attribute removed by a cascading drop |
| I030 | Lengths snapped to the grid by `scale { snap = true }` |

## Appendix B, Open questions (Core)

1. Search path / lockfile for module paths (section 3.1). Root-relative and
   `./`-relative paths are decided.
2. ~~Typed module parameters~~, done in Core 0.2 (M3a): `required(T)` and default-typed bindings.
3. Sizing-dependent numeric relations (e.g. active height = fin pitch x fin
   count) need expressions that survive until a cell is sized; the resolved
   form cannot hold them yet.
4. One version number for Core and vocabulary while in 0.x, or two from the
   start (section 6.1).
5. Browser implementation route (section 7.2).
