# Checks, rules and profiles

Stencil checks a technology at three levels, and each answers a different
question.

| What | Where it is written | Question it answers |
|---|---|---|
| `check` objects | in the description | are the values consistent with each other? |
| `rule` objects and the reference checker | in the description; run on rectangles | does a given piece of layout obey the rules? |
| `profile` objects | published by a tool | can this tool take this technology at all? |

## `check`: conditions on the description

A `check` holds a boolean expression over resolved values. It runs during
resolution, so a description that breaks one of its own checks does not
resolve:

```stencil
check ROW_TRACKS { holds = mod(dev.H_ROW, fs.MP0) == 0nm
                   message = "the row height is not a whole number of M0 pitches" }
```

```text
error V100: check ROW_TRACKS failed: the row height is not a whole number of M0 pitches,
mod(dev.H_ROW, fs.MP0) == 0nm is 4nm == 0nm
```

The message shows the expression and the values it had. Checks are most
useful in modules and in main files that combine modules: a module states
what it needs from its importer (the GT2N and compose examples check that
an M1 pitch still fits a wire plus the minimum spacing), and a main file
states what has to be true of the combination (see {doc}`transplant`).

## Rules and the reference checker

A `rule` has a `kind` (width, spacing, enclosure, min_length, area,
eol_spacing, cut_spacing and others), the layers it is `on`, a `value`,
and optionally conditions, tables of values and cases. The exact meaning
of each kind is normative and written down in {doc}`reference/VOCABULARY`,
section 3.

The reference checker implements that meaning on rectangles. It exists so
that a cell generator, a rule deck and the description can be compared
against one definition. From Python:

```python
from stencil import Technology

t = Technology.load("pdk/gt2n/bspdn.stencil", root="examples")
r = t.check([("M1", (0, 0, 14, 100)), ("M1", (20, 0, 34, 100))])
r.violations
# (Violation(rule='M1_S', kind='spacing', shapes=(0, 1), measured='6',
#            threshold=Fraction(14, 1), limit='min', detail=None),)
r.complete            # False: three rules need a placed cell template
r.unsupported[0]
# Unsupported(rule='NSEL_W', kind='width',
#             reason='region function band() needs a placed cell template')
```

A rule the checker cannot evaluate on the given input is listed in
`unsupported`, and `complete` is false. With
`mode="generator"` (the default) rules marked `intent = checker_only` are
skipped; `mode="checker"` checks every rule.

`t.recognize(shapes)` finds the devices in the same input: each region
where a gate crosses a channel, the markers over it and the models it can
be.

The same functions exist in JavaScript in `core/rulecheck.js`, and the
Python port is tested against it case by case.

## Query API

A cell generator usually needs the rule values themselves. The query
API returns them as exact rational numbers in nm:

```python
t.min_spacing("M1", axis="x").value       # Fraction(14, 1)
t.via("M0", "M1").size                    # (Fraction(14, 1), Fraction(12, 1))
```

When a rule depends on something the query did not say (an axis, a
width, a parallel run length, a net relation), it raises
`UnresolvedRuleError` naming the rule and what it needs. The full list of queries is in
{doc}`reference/API`.

## Tool profiles

A `profile` lists what a tool can handle: routing directions, whether it
needs tracks, mask counts, the number of device tiers, which sides of the
wafer, which rule kinds and rule features. `check --profile FILE:NAME`
compares a technology against it before any run, and lists everything the
tool would not be able to take:

```bash
node cli.mjs check examples/pdk/asap7/asap7.stencil --root examples \
  --profile pdk/asap7/asap7.stencil:innovus_asap7_4x
```

```text
profile innovus_asap7_4x: routing scope from the cell template: M1, M2
profile innovus_asap7_4x: M1: direction none is not supported (supports horizontal, vertical)
profile innovus_asap7_4x: 1 problem; the tool cannot take this technology as is
```

The profile file is resolved relative to `--root`. ASAP7 draws M1 in both
directions inside its cells, and the profile lists horizontal and vertical only, so M1 is reported.
The command exits with 3 when there are findings.

From Python, `t.supports("innovus_asap7_4x", source=asap7)` returns the
same findings as a tuple (empty when the tool can take the technology).

Only the layers a cell generator routes are checked: conductors from the
device tier up to the highest layer the site uses for pins or in-cell
tracks. The attributes a profile can set are listed in
{doc}`reference/VOCABULARY`, section 2.12.
