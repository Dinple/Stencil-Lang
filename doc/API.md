# Stencil query API (v0.1)

A small, read-only API that answers the questions a cell generator asks of a
technology, so a generator never parses the resolved JSON or re-implements
rule semantics. Python (`python/stencil`) and JavaScript
(`core/query.js`, camelCase), the same queries, held to one set of test cases.

## Design rules

1. One resolver. Only `core/resolve.js` resolves Stencil. Python's
   `Technology.load()` runs it through Node; `Technology.from_json()` reads its
   output and needs no Node.
2. Exact numbers. Every length is nm as an exact rational (Python
   `fractions.Fraction`, JavaScript `Q` from `core/rational.js`); areas nm^2.
   Inputs accept integers, rationals, and strings in one grammar,
   `-?\d+(\.\d+)?([eE][+-]?\d+)?` or `-?\d+/\d+` (nonzero denominator), of any length.
   Floats: Python takes their exact binary value, JavaScript numbers are read
   as their shortest decimal (so `dbu(0.3)` on a 0.1 nm grid succeeds only in
   JavaScript), pass strings or rationals for portable calls. `t.dbu(x)` /
   `t.nm(n)` convert to and from database units (JavaScript: within
   `Number.MAX_SAFE_INTEGER`, else `RangeError`). A resolved form holding an
   integer beyond +/-(2^53 − 1) is refused (`StencilError`): JSON readers do not
   hold it exactly.
3. Spec-defined meaning. Rule queries apply VOCABULARY.md section 3. A rule the
   query cannot decide raises `UnresolvedRuleError`; it is never ignored.
4. Names are resolved names, what the resolved JSON and the playground
   show, after renames and prefixes.
5. Typed errors. `StencilError` -> `ResolveError` (`.diagnostics`),
   `UnknownName` (also a `LookupError`), `AmbiguousError`, `UnresolvedRuleError`
   (`.rules`: `(rule, what it needs)` pairs). A bad input value (off grid,
   outside a size domain, an unknown limit or mode) is `ValueError`
   (JavaScript `RangeError`); an unknown option, an option or argument of the
   wrong type (`same_net=0`, `scopes="HOT"`, a kind or operand that is not a
   string, a `role`/`side`/`lower`/`upper` filter that is not a name, a
   mapping where a collection of names is expected, `diagnostics` that is not a
   list, `allow_incomplete=[]`), or a coordinate that is not a number, is
   `TypeError`. Names in results (rules, crosses, profile findings) are strings
   or null. `dbu()` / `nm()` stay within +/-(2^53 − 1) in both languages. `None` / `null` / omitted
   all mean "not given", for every optional argument and option, in both
   languages (`limit`, `ignore`, `units`, `markers`, `mode`, ...); boolean
   options must be booleans.
6. Native checker in both languages. The rule checker, cell-template
   expansion and profile checks are ported statement for statement to Python
   and kept in step with JavaScript by tests (below).

## Loading

```python
from stencil import Technology
t = Technology.load("pdk/gt2n/bspdn.stencil", root="examples")   # Node >= 18 ($STENCIL_NODE or PATH)
t = Technology.from_json("bspdn.json")   # resolved form, or the bundle of `cli.mjs resolve --with-diagnostics`
```
```js
import { Technology } from './core/query.js';
const t = Technology.fromProject({ main, load });   // in-process; also fromSource(src), fromResolved(json)
```

`load(main, root=None, *, allow_incomplete=False, node=None, cli=None)`. A
relative `main` is relative to `root` when one is given. Node must be >= 18
(checked). The resolver is `cli`, else `$STENCIL_CLI` (either must exist),
else the copy packaged with the module (`tools/vendor_resolver.py`, run before
building a wheel), else the checkout the package lives in. Raises
`ResolveError` when resolution has errors, unless `allow_incomplete=True`; on
an incomplete technology, rules the resolver marked invalid, the rule itself or
one of its tables, alternatives or cases, are never decided (queries) and are
reported unsupported (`check()`).
The constructor checks the structure (objects with `kind`, `attrs`,
`children`). Properties: `hash` (sha256 of the canonical form; computed when
the form carries none), `complete`, `diagnostics`, `resolved` (the raw form,
DBU), plus `sites()` and `profiles()` (names).

## The queries

| # | Python | JavaScript | Returns |
|---|---|---|---|
| 1 | `t.grid`, `t.dbu(x)`, `t.nm(n)`, `t.snap(x, mode="nearest")` | same | rational, int, rational, rational (`nearest`: ties away from zero; `down`; `up`) |
| 2 | `t.layers(role=None, side=None)` | `layers({role, side})` | `Layer`s, bottom -> top |
| 3 | `t.layer(name)` | `layer(name)` | `Layer` |
| 4 | `t.routing_layers(site=None)` | `routingLayers(site)` | the conductors a cell generator routes on (section 2.12): device tier up to the highest layer the site uses for pins or in-cell tracks; placed-only device layers (strata, gates) never; with no site anchor, every other conductor |
| 5 | `t.vias(lower=None, upper=None)`, `t.via(lower, upper)` | `vias({lower, upper})`, `via(lower, upper)` | `Via`s, the one `Via` (else `UnknownName` / `AmbiguousError`) |
| 6 | `t.site(name=None, units=1)` | `site(name, {units})` | `SiteTemplate` of a cell `units` placement units wide; `name` may be omitted when one site is not a row of another; `StencilError` if it does not expand cleanly |
| 7 | `site.tracks(layer)` | same | `TrackGrid`s on that layer, one per row |
| 8 | `t.rule_value(kind, on, *, limit, width, prl, axis, same_net, same_color, scopes, ignore)` | `ruleValue(kind, on, {...camelCase})` | `RuleValue \| None` (below) |
| 9 | `t.min_width(layer, axis=None, c)`, `t.min_length(layer, axis=None, c)`, `t.min_area(layer, **c)` | `minWidth(layer, opts)`, ... | shorthands of 8; `min_length` covers kinds `min_length` and `length` |
| 10 | `t.min_spacing(a, b=None, *, width, prl, axis, same_net, same_color, scopes, ignore)` | `minSpacing(a, [b], opts)` | spacing, with table lookup |
| 11 | `t.enclosure(inner, outer, *, width, scopes, ignore)` | `enclosure(inner, outer, opts)` | `tuple[Margins, ...] \| None`, acceptable margin sets, any one suffices |
| 12 | `t.rules(on=None, kind=None, *, include_checker_only=False)` | `rules({on, kind, includeCheckerOnly})` | `Rule`s as written, `x_` kinds included |
| 13 | `t.devices()`, `t.device(name)`, `device.w_eff(**sizes)` | `devices()`, `device(name)`, `wEff({...})` | `Device`s, `Device`, rational nm |
| 14 | `device.select_model(polarity, markers=())` | `selectModel(polarity, markers)` | the one `Model` (`AmbiguousError` for zero or several) |
| 15 | `t.check(shapes, mode="generator")` | `check(shapes, mode)` | `CheckResult`, the reference rule checker on rectangles in nm; a connector's cut and endpoint layers may be computed (they are evaluated); a rule the resolver marked invalid is reported unsupported, never decided |
| 16 | `t.recognize(shapes)` | `recognize(shapes)` | `Recognition` |
| 17 | `t.supports(profile, *, source=None)` | `supports(profile, {source})` | `Finding`s, what the tool profile cannot handle (empty = it can take it); the profile is looked up in `source` (default: this technology). A rule counts when its operands, or a connector's cut and layers, or anything they are computed from, intermediate computed layers included, reach the routing scope |

Shapes are a list (any iterable but a mapping or string) of `Shape(layer, rect,
net=, color=, connector=)`, mappings with the same keys, or `(layer, rect)`;
`rect` is `(x0, y0, x1, y1)` in nm, on the grid.

### Rule values (8-10)

`rule_value(kind, on, ...)` considers every rule of that `kind` whose operands
are `on` (one name, or a pair; spacing kinds are unordered, others ordered),
whose `intent` is not `checker_only`, not named in `ignore`, and whose `limit`
fits the query: `limit="min"` (default) takes min and exact rules, `"max"`
max and exact rules, `"exact"` exact rules. Of the rules that apply:

- with no exact rule, the result is the largest minimum (`"min"`) or the
  smallest maximum (`"max"`);
- with exact rules, they must agree, and every bound on the operands, the
  minima *and* the maxima, whatever the query's `limit`, must allow the exact
  value; the result is that value with `limit="exact"`, so a generator
  never sees an exact obligation as a mere bound. A bound that cannot be
  decided, including an indirect one (below) in either direction, then
  raises `UnresolvedRuleError` (the exact answer could not be certified);
  disagreeing or unsatisfiable combinations raise `AmbiguousError`;
- without exact rules, decided bounds in the other direction are checked too:
  a minimum above an applying maximum (or the reverse) is `AmbiguousError`;
- every compared threshold must share one measure (edge or centre), across
  both directions; otherwise `AmbiguousError`.

Only `min_length` and `length` may be combined in one query (they measure the
same thing); any other list of kinds is a `ValueError`.

The keywords describe the situation being asked about:

| keyword | meaning | rule conditions it decides |
|---|---|---|
| `axis` | the direction the distance is measured along | `axis` |
| `width` | what the rule's width condition measures, spacing: the wider of the two shapes; eol_spacing: the line end; enclosure: the outer shape | `width_below`, `width_above`, table rows |
| `prl` | the parallel run length | `prl`, table columns |
| `same_net`, `same_color` | the two shapes' relation | `same_net`, `same_color` |
| `scopes` | the regions either shape touches (contact counts, as in the checker; `[]`: none) | `scope` |

A rule is skipped when the query contradicts one of its conditions,
applied when the query satisfies all of them, and otherwise **cannot be
decided**: the query raises `UnresolvedRuleError` naming every such rule and
condition. A table needs only the indices it has (`width`, `prl`); an absent
index is `[0]`. Never decided from a query: rules with `case` contexts
(`via_end`, `open_end`), rules the resolver marked invalid, enclosure rules
with margin alternatives (query them with `enclosure()`). Querying an `x_`
kind, or a kind without a threshold (`inside`, ...), is a `ValueError`. Returns
`None` when no rule exists on the operands; a `RuleValue` with `value=None`
when rules exist but none applies. Edge and centre `cut_spacing` thresholds
do not combine (`AmbiguousError`).

Indirect rules. A rule of the queried kind whose operand is a region or
computed layer derived, directly or through other derived operands, from a
queried name (`width` on `R2 = grow(R1)` when querying `R1` or the drawn layer
under it), or a connector whose cut or layers are, or are computed from, the
queried names (`cut_spacing` on connector `C` when querying its cut layer),
constrains the queried shapes without naming them; transferring its threshold
would be unsound, so it is reported as undecidable ("its operand R2 is computed
from R1", "it applies to connector C ...; query on C"). Query the derived
operand or connector itself, or `ignore` it. `enclosure(inner, outer)` reports
an enclosure rule on a connector whose cut is (computed from) `inner` and one of
whose layers is computed from `outer`, also when another of its layers is
`outer` itself (that obligation is combined, the derived one reported). A rule whose operand is not a name
(a broken reference) names no layer and is not matched. A rule attribute that
should be a length but is not one, or a malformed table, makes the rule invalid
(never decided).

A connector's cuts. `rule_value("cut_spacing", C)` on a connector `C`
also takes the `cut_spacing` rules on `C`'s cut layer (they constrain every cut
on it, `C`'s included) and reports rules on regions derived from that cut layer
as undecidable; rules on other connectors sharing the cut are not included
(they constrain only their own cuts). `C`, `[C]` and `[C, C]` are one query.
`rule_value("enclosure", C)` reports the enclosure rules on `C`'s
[cut, layer] pairs (and on operands derived from them) as undecidable,
pointing to `enclosure(cut, layer)`, which combines them; a pair query that
meets a connector rule points to `enclosure()` likewise. A table index must start at 0 and
increase strictly, as the resolver requires, or the rule is invalid.

Directions. `axis` names one measured direction; a rule without `axis`
applies to every direction. A generator sizing both extents of a shape asks
once per direction (`min_width(L, axis="x")`, then `axis="y"`). An
`eol_spacing` value is the distance beyond the line end; the transverse window
(`within`) does not change it and is in `rules()`.

`enclosure(inner, outer)` combines every enclosure rule on `[inner, outer]`
and on connectors whose cut is `inner` and whose lower or upper layer is
`outer`. A rule's `axis` says which sides it constrains (`x`: left and right),
not a condition. Alternatives multiply out with the other rules (per side, the
largest margin), and a set that asks for more than another on every side is
dropped. Enclosures with `limit` max or exact raise `StencilError` (read them
with `rules()`).

### Types (frozen dataclasses; JavaScript: frozen objects with camelCase fields)

```python
Q = Fraction                                       # nm (areas: nm^2)

Size:        kind: "fixed" | "one_of" | "range" | "fill"; values: tuple[Q, ...]   # range: (min, max); fill: ()
             .min, .max, .fixed -> Q | None; .contains(x) -> bool (x in the number grammar)   # counts are plain numbers
Layer:       name; order: int | None (1 = bottom); role; side; direction
             width: Size | None; pitch, offset: Q | None   # the layer's lattice: its own, or its track array's
             masks: int; tracks_mode: str | None           # effective mode of a conductor
             gds, gds_pin, gds_label: tuple[int, int] | None; derived: bool; note: str | None
Via:         name; lower: tuple[str, ...]; cut: str | None; upper: str | None
             size: tuple[Q, Q] | None; enclose_lower, enclose_upper: tuple[Q, Q]   # (x, y); (0, 0) when not given
SiteTemplate: name; width (placement unit); cell_width; units; height
             rails; bands; edges; pins: tuple[str, ...]; boundary: str | None; symmetry; grids
             .tracks(layer) -> tuple[TrackGrid, ...]
Rail:        name; net; layer; y: Q; width: Q | None; shared_with: tuple[str, ...]
Band:        name; polarity: "n" | "p"; stratum: str | None; y0, y1: Q; flipped: bool
EdgeFeature: name; layer; side; shared: bool; x0, y0, x1, y1: Q
TrackGrid:   name; layer; axis: "x" | "y" (the coordinate positions are along)
             positions: tuple[Q, ...]; usable: tuple[int, ...] (0-based indices); span: (Q, Q)
RuleValue:   value: Q | None; limit ("exact" when an exact rule applies); rules: tuple[str, ...] (the rules
             that set the value); measure: "edge" | "center"
Margins:     left, right, bottom, top: Q
Rule:        name; kind; on: tuple[str, ...]; intent
             attrs: Mapping (lengths in nm, area values nm^2, references as names)
             children: tuple[{kind, name, attrs}, ...]   # table / alternative / case, lengths in nm
Device:      name; gate; channel_figure; channel_layer; faces; stratum; sizes: Mapping[str, SizeParam]; models
             .w_eff(**sizes) -> Q   # count x (n_wide*width + n_side*thickness); ValueError if a size is
                                    # missing for a non-fixed value, unknown, outside its domain, or a
                                    # count that is not a positive integer
             (immutable; JavaScript: frozen, sizes in a null-prototype object)
             .select_model(polarity, markers=()) -> Model
SizeParam:   name; target; attr; domain: Size | None      # e.g. nfin -> FINS.count, domain range(1, 3)
Model:       name; polarity; markers; exclude
CheckResult: complete: bool; violations; unsupported
Violation:   rule; kind; shapes: tuple[int, ...] (input indices); measured: str (nm, nm^2; "sqrt(...)" for
             Euclidean distances); threshold: Q | None; limit; detail: str | None
Unsupported: rule; kind; reason
Recognition: complete: bool; devices: tuple[DeviceInstance, ...]; unsupported: tuple[Finding, ...]
DeviceInstance: device; bbox: (Q, Q, Q, Q); markers (covering); partial (touching, not covering)
             models: {polarity: candidates}; selection: {polarity: "ok" | "none" | "ambiguous"}
Finding:     object; message
Diagnostic:  code; severity; message; file; line; col; hint
```

### Example

```python
t = Technology.load("pdk/gt2n/bspdn.stencil", root="examples")
site = t.site("gt2_6t", units=2)
m0 = site.tracks("M0")[0]
signal_y = [m0.positions[i] for i in m0.usable]          # [24, 48, 72, 96, 120]
t.via("M0", "M1")                                         # VIA0: size (14, 12), enclose_upper (0, 4)
t.min_spacing("M1", axis="x")                             # RuleValue(value=14, limit="min", rules=("M1_S",))
t.min_spacing("M1")                                       # UnresolvedRuleError: M1_S (needs axis)
t.min_area("M1").value                                    # 392 (nm^2)
fet = t.device("GAA")                                     # sizes: {"w": SizeParam(target="SHEET", attr="width", ...)}
fet.w_eff(w=31)                                           # 216 = 3 sheets x (2*31 + 2*5); w=20 raises ValueError
fet.select_model("n", markers=("ELVT",))                  # Model(name="nmos_elvt", ...)
```

## Tests

- `tests/query_cases.json`, 233 query -> answer cases, expectations derived
  by hand, run against both APIs (`python/tests/test_queries.py`,
  `tests/query.test.mjs`), on `python/tests/data/src/query_rules.stencil` (one
  rule per semantic case), `query_more.stencil` (tables, exact rules, indirect
  rules, routing without anchors), `query_deep.stencil` (exact rules against
  bounds, regions of regions, connectors on computed layers),
  `invalid_rule.stencil` (incomplete) and the
  public examples. Language-specific behaviour: `python/tests/test_api.py`,
  `tests/query_api.test.mjs`.
- `python/tests/test_conformance.py`, every rule conformance case and its
  invariance variants (665 runs): the hand-derived verdicts, and equality with
  the JavaScript checker's full output. No Node needed.
- `python/tests/test_differential.py`, Node live: thousands of random layouts
  through both checkers and both device recognizers, random cell templates
  (valid and invalid) through both expanders, random profiles through both
  checkers, and mutated resolved forms (attribute values replaced by
  arbitrary JSON: null, arrays, objects, floats, booleans, strings) through
  all four; any difference in raw output, or one side failing alone, fails.
  `STENCIL_FUZZ=n` / `STENCIL_MUTANTS=n` set the counts. The ports follow
  JavaScript semantics where raw values reach them: UTF-16 string indexing and
  search, ToPrimitive / ToNumber (ECMAScript whitespace, radix overflow to
  Infinity), SameValueZero and strict equality, nullish defaults. The ports' contract:
  a structurally valid resolved form; attribute values may be anything JSON
  holds, within +/-(2^53 − 1).
- `python/tests/test_api_differential.py`, Node live: the whole public query
  API, called with generated arguments on every example and on mutated
  resolved forms (and grids) in both languages; answers (shared encoding) and
  error classes must be equal. The generator also mutates nested values, sets
  invalid flags and odd names, and calls `dbu`/`nm`/`snap` and every query with
  wrongly typed arguments and constructor options. `STENCIL_API_MUTANTS=n`
  sets the count. Hand-built raw forms for inputs the resolver never produces:
  `python/tests/data/raw/`.
- `tests/python_fixtures.mjs` writes `python/tests/data/`;
  `tests/python_fixtures.test.mjs` fails when it is stale.

## Not in v0.1

Writing or patching technologies, LEF/DEF export, density / antenna rules,
parameter values (only objects are in the resolved form).
