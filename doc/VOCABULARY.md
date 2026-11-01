# Stencil Vocabulary std/0 (draft)

This file says what Stencil objects mean. The syntax, composition and
resolved form are in SPEC.md (the *Core*) and do not change when this file
changes. std/0 is expected to churn: renaming an attribute here is a
vocabulary edit, not a language change.

A machine-readable version of this file (`vocab/std-0.yaml`)
will drive validation, docs and editor autocompletion. Until it exists,
the tables below are the source of truth.

Tags: [PROPOSED], [OPEN].

---

## 1. Learn it in levels

Every attribute has a sensible default, so you only write what you need.
Each level adds a few object kinds; you can stop at any level.

| Level | You describe | Object kinds | Roughly equivalent to |
|---|---|---|---|
| 0 | Routing layers, vias, a cell row | `technology` `layer` `connector` `site` | Tech LEF |
| 1 | Transistors | `figure` `array` `cross` `stratum` |, (new) |
| 2 | Design rules, derived masks | `rule` `region`, `layer.from` | LEF58 rules, DRC derivations |
| 3 | Mixing PDKs | `import`, `&patch`, `drop`, `base`, `technology.stack` |, (new) |
| 4 | Tool capabilities, extensions | `profile`, `x_*` |, |

### Level 0: a complete technology in 20 lines

```
stencil 0.1

technology { grid = 1nm }

# Layers are listed bottom to top; the order is the vertical stack.
layer M0 { role = conductor; direction = horizontal; width = 20nm; pitch = 40nm; gds = [15, 0] }
layer V0 { role = cut; gds = [18, 0] }
layer M1 { role = conductor; direction = vertical; width = 24nm; pitch = 48nm; gds = [19, 0] }

connector VIA0 { lower = M0; cut = V0; upper = M1; size = [20nm, 20nm] }

site CORE {
  width  = 48nm
  height = 240nm
  rail VDD { layer = M0; edge = top }
  rail VSS { layer = M0; edge = bottom }
  pins = [M1]
}
```

A newcomer who has seen a LEF file recognizes every line.

### Level 1: transistors (nanosheet, with FinFET and planar in comments)

```
CPP   = 45nm
H_row = 240nm

layer CH   { role = channel }
layer GATE { role = conductor; direction = vertical }
layer MD   { role = conductor }

figure SHEET   { layer = CH; width = one_of(W1, W2, W3); thickness = T_sh }
figure GATE_LN { layer = GATE; width = L_g; extend = CH; extend_by = E_cap }

array SHEETS { of = SHEET;   axis = z; pitch = P_sh; count = 3 }
array GATES  { of = GATE_LN; axis = x; pitch = CPP;  count = fill }

cross FET {
  gate = GATE; channel = SHEETS; faces = all
  size w { sets = SHEET.width }            # netlist parameter w -> sheet width
}
# FinFET: figure FIN  { layer = CH; width = W_fin; thickness = H_fin }
#         array  FINS { of = FIN; axis = y; pitch = FP; count = 1..4 }
#         cross  FET  { gate = GATE; channel = FINS; faces = [top, left, right]
#                       size nfin { sets = FINS.count } }
# planar: figure DIFF { layer = CH; width = W_min..W_max }
#         cross  FET  { gate = GATE; channel = DIFF; faces = [top]
#                       size w { sets = DIFF.width } }

stratum DEV { layers = [CH, MD]; polarity = [n, p] }

&CORE {
  band p { stratum = DEV; y = H_row/2 .. H_row }
  band n { stratum = DEV; y = 0nm .. H_row/2 }
}
```

The only difference between a FinFET and a nanosheet is which axis the
channel figure is arrayed along and which faces the gate covers.

### Level 2: rules and derived masks

```
rule V0_COLOR { kind = cut_spacing; on = V0; same_color = true; value = S_v0_sc }

rule M1_LEN {                              # context-dependent minimum length
  kind = min_length; on = M1
  case via_end  { value = L_via }
  case open_end { value = L_open }
}

rule M1_EOL { kind = eol_spacing; on = M1; width_below = W_eol; value = S_eol }

rule M1_SP_GEN {                           # generator policy, stricter than the PDK
  kind = spacing; on = M1; value = 12nm; intent = generator
  note = "PDK allows 5nm; generator uses 12nm"
}

layer NW   { role = marker; gds = [1, 0]; from = grow(band(p), E_nw) }
layer GCUT { role = marker; gds = [9, 0]; from = gaps(GATE, x) }
region SD  { from = minus(CH, GATE) }      # used by rules, never emitted
```

### Level 3: composing modules

```
# file lib/frontside.stencil
stencil 0.1
module { version = "1.2.0" }
MP1     = required                         # the importer must bind these
LANDING = required
layer M0 { role = conductor; direction = horizontal; pitch = MP1 }
# ...
```

```
# file ns2_bspdn.stencil
stencil 0.1
module { version = "1.0.0" }

import "gt2n/device"      as dev
import "gt2n/backside"    as bs
import "lib/frontside"    as fs { MP1 = 2/3 * dev.CPP; LANDING = dev.MD }   # gear ratio
import "common/eol_rules" as eol

technology { grid = 0.5nm; stack = [bs, dev, fs] }     # bottom to top

site CORE {
  base = dev.CORE                          # inherit, then change the rails
  rail VDD { layer = bs.BM0 }
  rail VSS { layer = bs.BM0 }
}
&fs.M1 { masks = 1 }                       # single-patterned M1
drop fs.VR                                 # no front-side rail via
```

### Level 4: tool profiles

```
profile router_unidir {
  directions   = [horizontal, vertical]
  needs_tracks = true
  masks        = 1..3
  strata       = 1
  rule_kinds   = [width, spacing, enclosure, eol_spacing, cut_spacing, min_length]
}
```

`stencil check ns2_bspdn.stencil --profile router_unidir` lists every
object the tool cannot handle before any run starts.

---

## 2. Object reference

Notation: `Len` length, `Num` number, `Int` integer, `Ref<k>` reference
to an object of kind *k*, `one_of(...)` a discrete choice, `a..b` a range.

### 2.1 `technology` (unnamed; one per module, the main module's decides)

| Attribute | Type | Default | Doc |
|---|---|---|---|
| `grid` | Len | required | Manufacturing grid; 1 DBU in the resolved form |
| `stack` | list of import aliases | [this module] | Vertical order of modules, bottom to top |
| `pdk` | string |, | Source PDK URL |
| `revision` | string |, | Source PDK revision |

### 2.2 `layer`

| Attribute | Type | Default | Doc |
|---|---|---|---|
| `role` | `channel` \| `conductor` \| `cut` \| `marker` | required | |
| `masks` | Int >= 1 | 1 | Colors under multi-patterning |
| `direction` | `horizontal` \| `vertical` \| `none` | `none` | Conductors only. `none` = both directions |
| `width` | Len \| `one_of(...)` \| range |, | Legal wire widths (conductors) |
| `pitch`, `offset` | Len | -, 0 | Shorthand for a routing-track array (Level 0) |
| `tracks` | Ref<array> |, | Explicit track array; replaces `pitch`/`offset`. With neither, the layer is routed by shape |
| `shapes` | `rect` \| `polygon` | `rect` | `polygon` permits non-Manhattan figures |
| `gds` | [Int, Int] |, | Drawing layer/datatype. Required for drawn layers |
| `gds_pin`, `gds_label` | [Int, Int] |, | Pin shape and pin text layer/datatype |
| `from` | geometric expression |, | Marker layers only: computed from other layers on the finished layout |
| `below`, `above` | Ref<layer> |, | Place this layer lower / higher than another one (inserted next to it; SPEC.md section 3.9) |
| `level_with` | Ref<layer> |, | Same level as another layer (e.g. gate and source/drain contact) |
| `side` | `back` \| `device` \| `front` | inferred | Wafer side |
| `tracks_mode` | `required` \| `access` \| `none` |, | `required`: wires on tracks; `access`: pins on tracks, wires free; `none`: route by shape |

Vertical order (decided): layers are ordered by where they appear in
their module, bottom to top (as in LEF). `technology.stack` orders whole
modules (SPEC.md section 3.9). `below` / `above` / `level_with` move single
layers, for example a backside layer added by a delta file, or a long via
that skips a level. Resolved `order` counts from the bottom; layers at the
same level share a number.

Side: explicit `side`, else inferred: layers listed in a `stratum` are
`device`, layers below the lowest device layer are `back`, above the
highest are `front`. PDKs that mark backside layers (e.g. LEF58_BACKSIDE)
should state `side = back` explicitly.

### 2.3 `figure`

| Attribute | Type | Default | Doc |
|---|---|---|---|
| `layer` | Ref<layer> | required | |
| `width` | Len \| `one_of(...)` \| range | required | Fixed, discrete or free: this is the sizing model |
| `length` | Len \| `one_of(...)` \| range |, | |
| `thickness` | Len |, | Channel layers: cross-section height, used for W_eff |
| `extend`, `extend_by` | Ref<layer>, Len |, | Anchor: extend past figures on `extend` by `extend_by` (gate end cap) |

### 2.4 `array`

| Attribute | Type | Default | Doc |
|---|---|---|---|
| `of` | Ref<figure> | required | |
| `axis` | `x` \| `y` \| `z` | required | |
| `pitch` | Len |, | May be unknown, e.g. a sheet stack whose sheet pitch the PDK does not publish |
| `offset` | Len | 0 | |
| `count` | Int \| range \| `fill` | required | A range makes it a sizing knob. `fill` = as many as fit |

### 2.5 `cross`

| Attribute / child | Type | Default | Doc |
|---|---|---|---|
| `gate` | Ref<layer> | required | |
| `channel` | Ref<figure \| array> | required | Must sit on a `channel` layer |
| `faces` | `all` \| list of `top` `bottom` `left` `right` | required | Faces the gate covers |
| `stratum` | Ref<stratum> |, | The tier this transistor is built in; its models' polarities must be in the stratum's (V042) |
| `recognize` | geometric expression | `intersect(gate, <channel layer>)` | Where the devices are: each component of this expression is one device |
| child `size <param> { sets = X.attr }` | | | Maps a netlist parameter onto a figure or array attribute |
| child `model <name> { polarity; markers; exclude }` | | | SPICE model selection (below) |

W_eff = (array count) x (total length of the gated faces of one channel
figure's cross-section).

Recognition (normative, narrow). `recognize` only says *where* the
devices of this cross are. Terminals and sizes still come from the cross
(`gate`, `channel`, `faces`, `size`). Expressions use the region functions
and regularized semantics of section 3.2, e.g. `minus(intersect(GATE, ACT), GCUT)`
when a gate cut ends a device.

Model selection. `model m { polarity = n; markers = [LVT]; exclude = [HVT] }`
(`marker = L` is shorthand for `markers = [L]`). A marker *covers* a device
when the marker's union contains the device, and *touches* it when they
overlap. A model applies to a device of its polarity when every `markers`
layer covers it and no `exclude` layer touches it. A device's polarity comes
from the cell template (its band). Exactly one model must apply per device;
zero or several is a recognition error, and a marker that touches a device
without covering it never selects a model. Two models of one cross with the
same polarity, markers and exclusions are V041. Markers may be computed
(`from = ...`); they are evaluated like rule operands. `core/rulecheck.js`
`recognizeDevices` is the reference implementation: since polarity comes
from the template, it reports, per device and per polarity, the candidate
models and `selection` = `ok` (exactly one), `none` or `ambiguous`; for the
device's actual polarity anything but `ok` is a recognition error.

### 2.6 `stratum`

| Attribute | Type | Default | Doc |
|---|---|---|---|
| `layers` | list Ref<layer> | required | Channel and contact layers of this tier |
| `polarity` | list of `n` `p` | [n, p] | Side by side in the site. Stacked devices: one stratum per polarity |

### 2.7 `connector`

| Attribute | Type | Default | Doc |
|---|---|---|---|
| `lower` | Ref<layer> \| list | required | A list means the connector may land on any of them |
| `cut` | Ref<layer> \| `none` | required | `none` = direct overlap contact (see open question 1) |
| `upper` | Ref<layer> | required | |
| `size` | Len \| [Len, Len] | required if `cut` | Cut size; one value = square |
| `enclose_lower`, `enclose_upper` | Len \| [Len, Len] | 0 | Enclosure; two values = x, y |

### 2.8 `site`

| Attribute / child | Type | Default | Doc |
|---|---|---|---|
| `width`, `height` | Len | required | Placement unit and row height |
| `pins` | list Ref<layer> |, | Pin layers |
| `boundary` | Ref<layer> |, | Cell-outline (PR boundary) layer |
| `symmetry` | list of `x` `y` `r90` |, | For LEF export |
| `abut` | `share_rails` \| `none` | `share_rails` | [OPEN] full list |
| child `rail <name> { layer; net; edge \| y; width }` | | | Exactly one of `edge` (`top` \| `bottom`) and `y` (the centreline); `net` defaults to the name; `width` to the layer width |
| child `band <name> { polarity; stratum; y }` | | | `y` is a range within the row; `polarity` defaults to the name if it is `n` or `p` (else required) and must be one of the stratum's |
| child `tracks <name> { layer; use; at \| pitch, offset }` | | | In-cell tracks (below); `layer` defaults to the name |
| child `row <name> { site; y; flip }` | | | A row made of another site (below) |
| child `edge_feature <name> { layer; at; width; extend; y; shared }` | | | Geometry along the cell edges (below) |

The expanded template is normative; `core/template.js` `expandSite`
computes it, and the resolver's checks, the playground and generators all
use it. Coordinates are in the site frame (origin at the bottom-left).
Expanded coordinates beyond +/-2^52 DBU are V040 rather than rounded; rail
overlap is decided exactly.

- Rows. `row R { site = S; y = Y; flip = F }` places S's bands, rails,
  tracks and edge features in this site: a local height v becomes `Y + v`,
  or `Y + h − v` when flipped (mirrored about the row's own centreline; h =
  S's height). Rows nest one level (S must not have rows), S must have this
  site's width, and the row must lie within the height (V040). Expanded
  children are named `R.child`. Rows of different strata may overlap.
- Bands of one stratum must not overlap; bands of different strata may
  (V013). A band must lie within its row.
- Rails of the same net and layer at the same height are one shared rail
  (two mirrored rows sharing VSS) as wide as the widest of them (they share
  the centreline, so it covers the others); then rails of different nets on
  one layer must not overlap (V040). A rail of unknown width counts as a
  line; a rail width (its own or the layer's) must be positive (V040). A
  width given as a choice or range counts as its largest value, and every
  value must be positive. Neither step depends on declaration order.
- Tracks. Positions are `at` (explicit), or `offset + k, pitch` for
  k = 0, 1, ... within the row (horizontal layers, measured in y) or the site
  width (vertical layers, in x). `pitch` and `offset` default to the layer's
  lattice: its track array (`layer.tracks`) if it has one, else its own
  `pitch` / `offset` (`offset` is 0 with a local `pitch`). Index k counts from
  0 at the bottom (left) of the row it belongs to; `use` lists the indices
  usable for signals (default: all). A flipped row keeps its local indices.
  Vertical tracks of a row run only across that row. A block named after its
  layer (`tracks M0 { ... }`) is written out with that layer's resolved name, so
  renames carry through.
- Edge features. `at` = `left`, `right`, `top`, `bottom`, `both` (= left
  and right) or a list. Left/right features sit at x = 0 and x = the cell
  width (for a cell of k placement units, k x site width), span the row (or
  `y`), and run `extend` past it at both ends; top/bottom features span the
  cell width plus `extend` at both ends. `width` is the thickness across the
  edge. `shared = true` (default) centres the feature on the edge, half in
  each abutting cell, so the neighbour must have the same feature and the
  width must be an even number of grid units; `shared = false` keeps it
  inside the cell across the edge, so it must fit (`extend` still runs it
  past the cell along the edge). `width` is positive, `extend` not
  negative, and `y` lies within the row (V040).
- Cells of several placement units (`expandSite(..., { units: k })`):
  rows still compare placement-unit widths; only left/right edge features
  move to x = k x site width. Example (GT2N): a 14nm dummy gate on every left/right
  edge, a 10nm gate cut on the top/bottom edges that runs 7nm past the cell.

### 2.9 `rule`

| Attribute / child | Type | Default | Doc |
|---|---|---|---|
| `kind` | rule kind (section 3) \| `x_*` | required | `x_` kinds are extensions (warning W001, never silently applied) |
| `on` | Ref<layer \| region \| connector> \| [A, B] | required | One layer or region, an ordered pair, or a connector; see section 3 for what `[A, B]` means per kind |
| `value` | Len \| Area \| Num | one of value / case / table | Typed by kind: `area` takes an area (`288nm * 1nm`), the others a length (V034) |
| `axis` | `x` \| `y` |, | Condition: the rule applies along this axis only |
| child `case <context> { value }` | | | Context-dependent values |
| child `table { <index> = [...]; values = [[...]] }` | | | Indexed values (e.g. width x parallel run length) |
| `intent` | `pdk` \| `generator` \| `checker_only` | `pdk` | `pdk`: a rule a generator honours; `generator`: a stricter generator policy, which may only tighten, never relax, a `pdk` rule; `checker_only`: kept for sign-off checkers, out of scope for generators (decided 2026-10-29) |
| conditions | per kind (section 3) |, | e.g. `same_color`, `width_below`, `prl`, `within` |

### 2.10 `region`

| Attribute | Type | Doc |
|---|---|---|
| `from` | geometric expression | A named area that rules can use. Never emitted to GDS |

### 2.11 `check`

An assertion evaluated after composition (decided 2026-10-29). Modules
carry their own checks, so an importer cannot forget them.

| Attribute | Type | Default | Doc |
|---|---|---|---|
| `holds` | comparison, or `all(...)` / `any(...)` / `not(...)` | required | |
| `message` | string |, | Shown when the check fails |
| `severity` | `error` \| `warning` | `error` | |

```
check M1_FITS {
  holds   = M1.pitch >= M1.width + M1_SP.value
  message = "M1 pitch cannot hold one wire plus the minimum spacing"
}
```

A failing check is V100; its message shows both sides
(`M1.pitch >= ... is 28nm >= 34nm`) and which parameters the importer
bound. A check that cannot be evaluated is V101.

### 2.12 `profile`

Published by a tool. `stencil check --profile FILE:NAME` (core/profile.js)
reports everything in a resolved technology that the tool cannot handle,
before any run.

| Attribute | Type | Checked against |
|---|---|---|
| `directions` | list of `horizontal` `vertical` `none` | each routed layer's `direction` |
| `tracks_modes` | list of `required` `access` `none` | each routed layer's effective `tracks_mode` (`required` if it has a pitch or tracks, else `none`) |
| `needs_tracks` | bool | a routed layer with `tracks_mode = none` |
| `masks` | Int or range | each routed layer's `masks` |
| `strata` | Int or range | number of `stratum` objects |
| `sides` | list of `back` `device` `front` | each routed layer's `side` |
| `rule_kinds` | list | kinds of rules on routed layers (`checker_only` rules are skipped) |
| `rule_features` | list | conditions and forms those rules use: the condition names of section 3.5, `table`, `case`, `alternative`, `limit_max`, `limit_exact`, `measure_center`. Unset: every feature |

A rule is on a routed layer when its operands, or the layers its regions
and computed markers are made from, include one.

Routing scope. A cell generator routes only inside the cell: conductor
layers from the device tier up to the highest layer the site uses for
`pins` or in-cell `tracks`, excluding layers that are placed rather than
routed (stratum layers and transistor gates). Without a site, every
conductor layer is in scope.

Tools look up layers by role and order, not by name. [OPEN] Which keys
a given tool supports is for its authors to publish.

---

## 3. Rule kinds and their semantics (normative)

This section defines what every rule kind means, so that two tools
reading the same rule agree on whether a given geometry satisfies it. The
definitions are small and geometric; LEF58 properties are an import
reference, and engine encodings (CP-SAT, ...) are implementations of them.
`core/rulecheck.js` is the reference checker for these definitions, and
`tests/conformance/rules.test.mjs` holds hand-derived pass/fail cases.

### 3.1 Geometry model

- A figure is a closed axis-aligned rectangle `[x0,x1] x [y0,y1]` with
  positive width and height, in integer DBU (the reference checker accepts
  |coordinates| <= 2^51, so that every sum and difference is exact).
- Figures on one layer that touch or overlap (closed sets intersect) merge
  into one component. Every measurement below is taken on components.
  The reference checker measures only rectangular components (whose
  union equals their bounding box); a rule that would need a measurement on
  a non-rectangular component is reported as unsupported for it.
- Thresholds, values, table entries, margins and the numeric conditions
  `width_below`, `width_above`, `prl`, `within`, are exact rationals in DBU
  (areas in DBU^2), never negative (V034). Derived geometry that leaves the
  +/-2^51 range is unsupported. Rule values, table entries, conditions and alternatives may be
  off-grid; geometry may not. Comparisons are exact; Euclidean distances are compared as squares.
  There is no epsilon and no snapping.
- For two rectangles A, B:
  `gx = max(0, A.x0 − B.x1, B.x0 − A.x1)`, `gy` likewise (gaps);
  `ox = min(A.x1,B.x1) − max(A.x0,B.x0)`, `oy` likewise (overlaps; negative
  when apart). Overlap means `ox > 0 and oy > 0`; contact (closed
  interaction) means `ox >= 0 and oy >= 0`.

### 3.2 Operands

- `on = L` names one layer or region; `on = [A, B]` is ordered (roles per
  kind below); `on = C` names a connector: `cut_spacing` then applies to the
  cuts of C's instances, and `enclosure` to each C cut enclosed by C's lower
  and by C's upper layer. Other kinds on a connector are an error (V035).
- Regions and computed markers (`from = ...`) are evaluated geometrically,
  as regularized set operations (the closure of the interior: results
  of zero area, such as the shared edge of two abutting figures, are
  empty): `intersect`, `union`, `minus` (closure of A \ B), `grow` (every
  side moves out by the distance, i.e. the square dilation, which
  distributes over figures), `shrink` (every side of a merged component
  moves in; unsupported for non-rectangular components), and
  `touching`/`avoiding` (whole components of the first operand that do / do
  not contact the second). Results keep the first operand's net, colour and
  figure identities. `band`, `gaps`, `xor` are unsupported by the reference
  checker: they need a placed cell template.
- Pairs: one operand -> every unordered pair of distinct components;
  `[A, B]` -> every (A component, B component) pair; `[A, A]` is the same as
  `A`.
- `scope = R` (any kind): the rule applies only to subject components (the
  first operand) that contact R; with one operand both members of a pair
  are subjects, and the pair counts when either contacts R. Whole
  components are selected; nothing is clipped.
- Net and mask colour come from the figures. A component whose figures
  disagree, or that lacks a net / colour that a condition needs, makes that
  rule unsupported for it.

### 3.3 Limits

`limit = min` (default) passes when `measured >= threshold`, `max` when
`<=`, `exact` when `=`. Pair rules (`spacing`, `cut_spacing`,
`corner_spacing`, `eol_spacing`) and `extension` allow only `min` (V036): a
maximum over every pair would reject a regular grid by its farthest pair.
Containment kinds take no limit.

### 3.4 Kinds

| Kind | Operands | Measured, per subject or pair | Passes when |
|---|---|---|---|
| `width` | one | rectangle extent along `axis` (`x` = horizontal extent); no axis: `min(dx, dy)` | limit holds |
| `length` (alias `min_length` = `length` with `limit = min`) | one | extent along `axis`; no axis: `max(dx, dy)` | limit holds |
| `area` | one | `dx, dy` (material area of the component) | limit holds |
| `spacing` | one, or `[A, B]` symmetric | no axis: Euclidean edge distance `sqrt(gx^2 + gy^2)`; `axis = x`: only pairs with `oy >= 0`, measuring `gx` (`y` likewise) | overlap always fails; contact measures 0 |
| `cut_spacing` | one drawn cut layer (not a region or computed layer), or a connector | as `spacing`; `measure = center`: distance between centres (Euclidean, or the absolute centre difference along `axis`) | as `spacing` |
| `corner_spacing` | one, or `[A, B]` | only pairs with no projection overlap in either axis (`gx > 0 and gy > 0`; all other pairs, overlapping ones included, are not subject): the smallest distance between a corner of one and a corner of the other | >= value |
| `eol_spacing` | one | for each end of a subject rectangle along its long axis (`axis`, else the longer extent; a square needs `axis`): every other component that reaches beyond the end (into the open half-plane past it) and whose transverse gap to the end is `<= within` (default 0); measured: the longitudinal gap | >= value; overlap fails |
| `enclosure` | `[inner, outer]` | for each inner rectangle, the outer components that contain it; margins `[left, right, bottom, top] = [I.x0−O.x0, O.x1−I.x1, I.y0−O.y0, O.y1−I.y1]` | some containing outer component has all four margins (`axis = x`: left and right; `y`: bottom and top) satisfying the limit; with `alternative` children, some alternative's four margins all hold (OR over alternatives). Not contained at all: fails |
| `extension` | `[extending, base]` | `axis` is required; for each overlapping pair: `B.x0 − E.x0` and `E.x1 − B.x1` (for `x`) | both ends >= value; pairs that do not overlap carry no obligation |
| `inside` | `[subject, container]` |, | every subject component is covered by the union of the container (shared boundary allowed) |
| `interacting` | `[subject, target]` |, | every subject component contacts the target (edge or point contact counts) |
| `not_interacting` | `[subject, target]` |, | no subject component contacts the target (contact fails) |
| `not_overlapping` | `[subject, target]` |, | no subject component overlaps the target (contact allowed) |

Edge alignment (e.g. a via's edges coinciding with the gate's) is
`enclosure` with `limit = exact`, `value = 0nm` and the axis of the aligned
edges.

### 3.5 Conditions

Conditions are ANDed with the rule. Allowed per kind (V035 otherwise):

| Condition | Meaning | Allowed on |
|---|---|---|
| `axis = x \| y` | see the kinds | width, length, spacing, cut_spacing, eol_spacing, enclosure, extension |
| `same_net = true \| false` | both components' nets equal / differ | spacing, cut_spacing, corner_spacing, eol_spacing |
| `same_color = true \| false` | both components' mask colours equal / differ | spacing, cut_spacing, corner_spacing, eol_spacing |
| `width_below = w`, `width_above = w` | strict `<` / `>` on: pair width `max(min side A, min side B)` (spacing, corner), the end width (eol), the outer rectangle's min side (enclosure) | spacing, corner_spacing, eol_spacing, enclosure |
| `prl = p` | parallel run length `>= p`: with `axis = x` PRL is `max(0, oy)`; with `y`, `max(0, ox)`; without axis, the projection overlap of side-by-side pairs (diagonal and overlapping pairs: 0) | spacing |
| `within = d` | the transverse window of an end-of-line rule | eol_spacing |
| `measure = edge \| center` | see `cut_spacing` | cut_spacing |
| `scope = R` | see 3.2 | every kind |

### 3.6 Values, tables, cases, alternatives

- A numeric rule has exactly one of `value`, `table`, `case` children;
  an enclosure may have `alternative` children instead (V038). Containment kinds (`inside`, `interacting`, `not_interacting`,
  `not_overlapping`) take none of them.
- `table` (spacing only): indices `width` (rows) and `prl` (columns), each a
  strictly increasing list starting at `0nm`; a missing index is `[0nm]`;
  `values` has one row per width entry and one column per prl entry
  (V039). Lookup takes, independently on each index, the greatest
  breakpoint `<=` the measured value (the last bin is open; no
  interpolation).
- `case` children are contexts. The only standard contexts are `via_end`
  and `open_end` on `length`; they need per-end connection data that a
  layout of rectangles does not carry, so the reference checker reports
  them unsupported. Other case names are V037.
- `alternative` children (enclosure only) each give
  `margins = [left, right, bottom, top]`; the rule passes when any
  alternative holds. List rotated variants explicitly.

### 3.7 What the reference checker reports

Violations (rule, subjects, measured, threshold, limit), the rules it
could not decide (unsupported, with the reason), and `complete = false`
whenever anything was unsupported. `intent = checker_only` rules are
skipped in generator mode. Not covered by std/0 and by the checker:
density, antenna, latch-up reach, minimum cut count, 45-degree geometry,
end-of-line contexts beyond `within`.

## 4. Functions

| Function | Kind | Signature |
|---|---|---|
| `min`, `max` | numeric | (x, y, ...) |
| `floor`, `ceil`, `snap` | numeric | (Len) -> Len on grid |
| `one_of` | value | (v, ...) -> discrete choice |
| `union`, `intersect`, `minus` | geometric | (layer, layer, ...), at least two |
| `xor` | geometric | (layer, layer) |
| `grow`, `shrink` | geometric | (layer, Len) |
| `gaps` | geometric | (layer, `x` \| `y`) |
| `touching`, `avoiding` | geometric | (layer, layer) |
| `band` | geometric | (`n` \| `p`) -> band area of the site |
| `all`, `any`, `not` | logic | combine comparisons in a `check` |

Geometric arguments are type-checked (wrong count C032, wrong type V003).

## 5. Vocabulary checks (initial)

| Code | Check |
|---|---|
| V001 | Unknown object kind (with "did you mean") |
| V002 | Unknown attribute for this kind |
| V003 | Attribute has the wrong type |
| V004 | Required attribute missing (including a rail with neither `edge` nor `y`, and a band not named n or p without `polarity`) |
| V010 | Connector: `cut` is not between `lower` and `upper` in the stack, or is not a `cut` layer |
| V011 | Cross: `channel` is not on a `channel` layer, or `gate` is not a conductor |
| V012 | Track array: figure not on this layer, or axis not perpendicular to `direction` |
| V013 | Site band: polarity not in its stratum, outside its row, or overlapping another band of the same stratum |
| V014 | Two rules with the same kind, `on` and conditions (patch one of them) |
| V021 | Two layers share a GDS layer/datatype pair (after any `gds { shift }`) |
| V030 | `technology.stack` lists something that is not an import alias |
| V031 | Contradictory or impossible `below` / `above` / `level_with` |
| V032 | Malformed import body or `rename` entry |
| V033 | Malformed `scale` or `gds` options |
| V034 | Rule value has the wrong dimension for its kind, or is negative |
| V035 | Rule operands or a condition that has no meaning for the kind (section 3.2, section 3.5) |
| V036 | A limit the kind does not take (pair rules and extension: `min` only; containment: none) |
| V037 | A `case` context the kind does not define |
| V038 | Not exactly one of `value` / `table` / `case` (or `alternative` for enclosure); malformed `margins` |
| V039 | Malformed `table`: indices not strictly increasing from `0nm`, or `values` shape != width x prl |
| V040 | Cell template: rail with both `edge` and `y`, rail overlap between nets, row out of bounds / of another width / nested, track index or position out of range, odd shared edge width |
| V041 | Model selection: `marker` and `markers` both set, or two models select the same devices |
| V042 | A model's polarity is not one of its cross's stratum |
| V100 | A `check` failed |
| V101 | A `check` could not be evaluated |
| W010 | Cut layer used by no connector |
| W011 | Layer never referenced |

---

## 6. Open questions (std/0)

- Qualified band selection. `band(p)` means every `p` band of the
  expanded template. With several rows or strata, a marker may need one of
  them (`band(B0.p)`, or `band(p, BACK)`); not yet defined.

1. Contacts without a cut. Some processes connect the gate or the
   active area to local interconnect directly, without a cut layer.
   std/0 proposes `connector ... { cut = none }`.
2. ~~Layers at the same height~~, decided: `level_with`.
3. `width` vs `length` axes. Define them once for all figures.
   Proposal: `width` is across the figure's long axis, `length` along it.
4. When `count = fill` is evaluated: per site, or per cell once its
   width is known. Proposal: per cell, so it stays the literal `fill` in
   the resolved form.
5. Rule kinds as `kind = ...` or as their own object kinds
   (`spacing M1_SP { ... }`). The current choice keeps one `rule` kind; the
   alternative reads better and has a simpler schema per kind.
6. SPICE model names -> devices. A netlist says `nfet_lvt`; which
   cross, polarity and threshold-voltage marker is that? Proposal: child
   `model nfet_lvt { polarity = n; marker = LVT }` on `cross`.
7. Track subsets. Some processes route M1 on every second track.
   Proposal: a second `array` with twice the pitch; no new attribute.
8. ~~Where the top module's own layers go~~, decided: after the stacked and other imports, in file order (SPEC.md section 3.9).
