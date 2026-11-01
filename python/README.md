# stencil (Python)

What a cell generator needs to know about a technology, answered from a
resolved Stencil description. Pure Python, no dependencies. Every length is
an exact `fractions.Fraction` in nanometres.

```python
from stencil import Technology

t = Technology.load("pdk/gt2n/bspdn.stencil", root="examples")   # resolves with Node >= 18
t = Technology.from_json("bspdn.resolved.json")                  # or: no Node at all

site = t.site("gt2_6t", units=2)
m0 = site.tracks("M0")[0]
signal_y = [m0.positions[i] for i in m0.usable]          # [24, 48, 72, 96, 120]
t.via("M0", "M1").size                                   # (14, 12)
t.min_spacing("M1", axis="x").value                      # 14
t.min_spacing("M1")                                      # UnresolvedRuleError: M1_S (needs axis)
t.device("GAA").w_eff(w=31)                              # 216
t.check([("M1", (0, 0, 14, 100)), ("M1", (20, 0, 34, 100))])   # the reference rule checker
```

A rule query never guesses: when a rule depends on a condition the query did
not give (an axis, a width, a net relation), it raises `UnresolvedRuleError`
naming the rule and the condition. See `doc/API.md` for every query and type.

The rule checker, cell-template expansion and tool-profile checks are native
Python, ported statement for statement from the JavaScript reference and
kept in step by tests: every rule conformance case and its variants (no Node
needed), and a differential test that checks thousands of random layouts
with both implementations (needs Node).

`Technology.load()` runs the JavaScript resolver (Node >= 18). From a
checkout it finds `../cli.mjs`; for an installed package, copy the resolver in
before building (`python tools/vendor_resolver.py`), or pass `cli=` / set
`STENCIL_CLI`. `Technology.from_json()` needs no Node at all.

```sh
python -m unittest discover -s tests -t .     # from this directory
node ../tests/python_fixtures.mjs             # regenerate tests/data after changing the JavaScript side
python tools/vendor_resolver.py && pip wheel . # a wheel that resolves without a checkout
```
