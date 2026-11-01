# Transplants

A transplant takes the device tier of one technology and the routing of
another, to see whether the cells still fit and what has to change.

Because the PDK descriptions are split into modules with `required`
parameters (see {doc}`pdks`), a transplant is a short main file. It
imports the modules, binds their parameters, writes the cell template's
rails, pins and tracks for the new combination, and states the conditions
the combination depends on as `check` objects. If a check fails,
resolution fails with its message.

Both files are in `examples/transplant/`.

## PROBE3 devices on the ASAP7 routing grid

PROBE3 has a 45 nm gate pitch and a 24 nm M0. ASAP7 has no M0: its cells
contact M1 directly, and M1 .. M3 are on a 36 nm pitch.

[Open in the playground](https://dinple.github.io/Stencil-Lang/playground/?example=transplant/probe3_asap7_grid.stencil)

```{literalinclude} ../examples/transplant/probe3_asap7_grid.stencil
:language: stencil
```

What the main file does:

1. `stack = [dev, fs, beol]` puts the PROBE3 device layers under the
   ASAP7 metals. The grid is 0.25 nm because ASAP7 needs it; the PROBE3
   values are all on it.
2. `LANDING = fs.M1` lands the PROBE3 contact CA on ASAP7 M1. In PROBE3
   it lands on M0. The PROBE3 front-side module is not imported.
3. `H_ROW = (RT + 2) * fs.MP` keeps the PROBE3 rule for the row height
   (two tracks for the rails plus `RT` signal tracks) but measures it in
   ASAP7 tracks: 6 x 36 nm = 216 nm (PROBE3 itself has 144 nm).
4. `CPP = dev.CPP` gives the ASAP7 front side the PROBE3 gate pitch, so the
   in-cell M1 lines follow the 45 nm gates.
5. The patch on `dev.CORE` puts the rails on M1 and the signal tracks on
   M2, as ASAP7 does.

The three checks are the conditions under which this is a sensible cell:
the row is a whole number of tracks, the in-cell M1 lines, which sit one
gate pitch apart, keep the ASAP7 M1 width plus spacing, and the PROBE3 contact is no
wider than the M1 line it lands on.

To see a check fail, bind a tighter gate pitch in the import:

```stencil
import "../pdk/probe3/device" as dev { LANDING = fs.M1; BOUNDARY = OUTLINE; CPP = 34nm
                                       H_ROW = (RT + 2) * fs.MP }
```

```text
error V100: check M1_ON_GATE_GRID failed: in-cell M1 lines one gate pitch apart break the M1 width plus spacing,
dev.CPP >= fs.M1_W.value + fs.M1_S.value is 34nm >= 36nm
```

## GT2N devices on the PROBE3 routing grid

GT2N is a nanosheet technology with a buried power rail; PROBE3 is a
FinFET technology with its rails on M0. Here the GT2N device tier is used
with the PROBE3 M0 .. M2, and the rails move from the buried rail to M0.
The GT2N backside and buried-rail modules are not imported.

[Open in the playground](https://dinple.github.io/Stencil-Lang/playground/?example=transplant/gt2n_device_probe3_grid.stencil)

```{literalinclude} ../examples/transplant/gt2n_device_probe3_grid.stencil
:language: stencil
```

The GT2N row is 144 nm, which is 6 PROBE3 M0 tracks of 24 nm, so
`ROW_TRACKS` holds. Two tracks go to the rails and four carry signals,
which is the PROBE3 4-track arrangement. `M1_GEAR` asks that the gate
grid and the M1 grid line up again every five gates: five 42 nm gates are
210 nm, which is seven 30 nm M1 pitches. A gate pitch whose grids line up
sooner but not at five gates (45 nm lines up after two) fails it, so
change the 5 if a different period is wanted.

Change the PROBE3 M0 pitch in the import and the row no longer divides:

```stencil
import "../pdk/probe3/frontside" as fs { MP0 = 28nm }
```

```text
error V100: check ROW_TRACKS failed: the row height is not a whole number of PROBE3 M0 pitches,
mod(dev.H_ROW, fs.MP0) == 0nm is 4nm == 0nm
```

## From the command line

```bash
node cli.mjs check examples/transplant/probe3_asap7_grid.stencil --root examples
node cli.mjs check examples/transplant/gt2n_device_probe3_grid.stencil --root examples
```

A transplant can also be checked against a tool profile. The ASAP7 place
and route profile accepts only horizontal and vertical routing layers on a
track grid:

```bash
node cli.mjs check examples/transplant/probe3_asap7_grid.stencil --root examples \
  --profile pdk/asap7/asap7.stencil:innovus_asap7_4x
```

```text
profile innovus_asap7_4x: routing scope from the cell template: LIG, M1, M2
profile innovus_asap7_4x: LIG: direction none is not supported (supports horizontal, vertical)
profile innovus_asap7_4x: LIG: the tool needs a routing grid, but this layer is routed by shape
profile innovus_asap7_4x: M1: direction none is not supported (supports horizontal, vertical)
profile innovus_asap7_4x: 3 problems; the tool cannot take this technology as is
```

The GT2N transplant passes the same profile, because PROBE3 M0 .. M2 are
all unidirectional and on tracks.

## From Python

```python
from stencil import Technology

t = Technology.load("transplant/gt2n_device_probe3_grid.stencil", root="examples")
site = t.site("gt2_6t")
site.height                                   # 144
m0 = site.tracks("M0")[0]
[m0.positions[i] for i in m0.usable]          # 36, 60, 84, 108 (nm)
t.device("GAA").w_eff(w=31)                   # 216: three sheets, all faces
```

## Writing your own

- Import the device module of one technology and the interconnect modules
  of another. Bind every `required` parameter; the resolver names any
  that are missing.
- Put the modules in `stack` bottom to top.
- Choose a grid that every imported value is on. The resolver reports a
  value that is off the grid, with the nearest values on it.
- Patch the site with rails, `pins` and `tracks` on the new metals.
- Write each assumption you rely on as a `check`: the row height in
  tracks, the gear ratio between M1 and the gates, a contact that fits the
  metal it lands on.
