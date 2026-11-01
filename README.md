# Stencil

Stencil is a small, declarative language for describing a semiconductor
technology for standard-cell work: layers and their order, routing grids,
devices, connections, design rules, and cell templates. A description is
plain text, can be split into modules that import and patch each other, and
resolves to one exact, hashed JSON form that tools read.

```
stencil 0.1
technology { grid = 0.5nm }

CPP = 42nm
layer GATE { role = conductor; direction = vertical; width = 14nm }
layer M1   { role = conductor; direction = vertical; pitch = 2/3 * CPP; masks = 2 }
rule  M1_S { kind = spacing; on = M1; value = 14nm }
```

## What is here

```
core/         the reference front end (plain ES modules, no dependencies)
              lexer, parser, resolver, vocabulary (std/0), canonical hash,
              rulecheck.js  reference rule checker on rectangles + device recognition
              template.js   cell-template expansion (rows, rails, bands, tracks, edge features)
              profile.js    checks a description against a tool's published capabilities
              query.js      the query API for cell generators (JavaScript)
cli.mjs       command line: resolve [--with-diagnostics] | check [--profile FILE:NAME]
python/       the query API in Python, with native ports of the checker, templates and profiles
playground/   live editor with a side-by-side drawing of the stack, top view and devices
doc/          SPEC.md (the core language), VOCABULARY.md (the std/0 vocabulary), API.md (the query API)
examples/     tutorial levels, a multi-module example, and three PDK descriptions
tests/        node --test tests/*.test.mjs tests/conformance/*.test.mjs
vscode/       the VS Code extension (uses core/ and the playground's renderer)
site/         landing page of the online playground (GitHub Pages)
```

## Try it

- Online playground: <https://dinple.github.io/Stencil-Lang/>. Edit on the
  left and see the stack, top view and devices on the right; nothing to install.
- VS Code: the extension in [`vscode/`](vscode/) adds diagnostics with
  quick fixes, completion, hover docs, an outline, go to definition, and the
  same live preview beside the editor (`Ctrl+K V`). Build it with
  `cd vscode && npm install && npm run package`, then
  `code --install-extension stencil-lang-0.1.0.vsix` (each CI run also
  attaches the `.vsix`).

## Quick start

Requires Node.js 18 or newer (no packages to install).

```bash
node cli.mjs check examples/pdk/gt2n/bspdn.stencil --root examples
node cli.mjs resolve examples/level1_nanosheet.stencil --out nanosheet.json

python3 playground/serve.py      # then open the printed URL, e.g. http://localhost:8765/playground/
```

The playground resolves as you type, draws the result, and offers one-click
fixes for many diagnostics. `?selftest` runs its browser self-test.


## Query API for cell generators

A cell generator should not parse the resolved JSON or re-implement rule
semantics. The query API answers its questions directly, with exact numbers
(rationals, in nm), in Python and in JavaScript:

```python
from stencil import Technology                     # python/: pure Python, no dependencies

t = Technology.load("pdk/gt2n/bspdn.stencil", root="examples")
site = t.site("gt2_6t", units=2)
m0 = site.tracks("M0")[0]
[m0.positions[i] for i in m0.usable]               # signal tracks: 24, 48, 72, 96, 120 nm
t.via("M0", "M1").size                             # (14, 12)
t.min_spacing("M1", axis="x").value                # 14
t.device("GAA").w_eff(w=31)                        # 216
t.check([("M1", (0, 0, 14, 100)), ("M1", (20, 0, 34, 100))])   # the reference rule checker
```

A rule query never guesses: when a rule depends on something the query did
not say (an axis, a width, a net relation, a layer derived from the queried
one), it raises `UnresolvedRuleError` naming the rule and what it needs. The
same queries exist in JavaScript (`core/query.js`, camelCase), and one set of
cases (`tests/query_cases.json`) runs against both. See `doc/API.md`.

## Examples

| File | What it shows |
|---|---|
| `examples/level0_routing.stencil` ... `level2_rules.stencil` | the vocabulary level by level |
| `examples/compose/gear_ratio.stencil` | one front-side module imported at two gear ratios |
| `examples/pdk/gt2n/` | GT2N split into backside, buried-rail, device and front-side modules; `bspdn.stencil` composes them as shipped, `fspdn.stencil` without the backside network |
| `examples/pdk/asap7/asap7.stencil` | ASAP7 (7.5-track FinFET), every value citing its PDK file and line |
| `examples/pdk/probe3/probe3_finfet.stencil` | PROBE3.0 FinFET (2 fins, 4 tracks) |


## Status

The language and vocabulary are at an early version (Core 0.2, std/0) and
will change. Everything here works at the description level: it resolves,
composes and checks technologies. 

## License

BSD 3-Clause, see `LICENSE`.
