# PDK descriptions

Three public technologies are described in `examples/pdk/`. Each value in
them cites the PDK file and line it came from, or says that it was
inferred from cell geometry. Each technology is split into modules along
the same lines:

- a device module: wells, implants and threshold markers, the channel and
  gate, local interconnect, the contacts up to the first metal, the device
  rules and the cell template;
- one or more interconnect modules: the metals, their vias and their rules;
- a main file that stacks the modules, binds the parameters they leave
  open, and adds whatever depends on more than one module (the rails, the
  pin layers, the in-cell tracks, cross-module checks).

Where a module needs a layer from another module, it declares a `required` parameter (`LANDING` for the metal that the
first contacts land on, `CPP` for the gate pitch that in-cell M1 follows)
and the main file binds it. This is how a module is reused under a
different technology; see {doc}`transplant`.

## GT2N

A 2 nm-class nanosheet technology with a buried power rail and backside
power delivery. 6-track cells, a 42 nm gate pitch and a 24 nm M0 pitch.

| Module | Contents | Parameters it needs |
|---|---|---|
| `gt2n/backside.stencil` | BM1 .. BM4, BRDL and their vias (the backside network) | `RAIL`: the rail BV0 lands on |
| `gt2n/rail.stencil` | the buried rail BPR and its tap VBPR to the source/drain contact | `H_ROW`, `SD_LAND`, `CHANNEL`, `GCUT` |
| `gt2n/device.stencil` | sheets, gates, SDCON, VG/VSD, markers, the site `gt2_6t`, 23 rules | `LANDING`: the metal VG and VSD land on |
| `gt2n/frontside.stencil` | M0 .. M13 and RDL, their vias, 18 rules | `CPP` |

Two main files compose them. `bspdn.stencil` is the technology as
shipped, with the backside network under the rail:

[Open in the playground](https://dinple.github.io/Stencil-Lang/playground/?example=pdk/gt2n/bspdn.stencil)

```{literalinclude} ../examples/pdk/gt2n/bspdn.stencil
:language: stencil
```

`fspdn.stencil` is the front-side power variant of the same PDK. It
imports the same rail, device and front-side modules, leaves the backside
out, and patches the rail so it is no longer a routing layer:

[Open in the playground](https://dinple.github.io/Stencil-Lang/playground/?example=pdk/gt2n/fspdn.stencil)

```{literalinclude} ../examples/pdk/gt2n/fspdn.stencil
:language: stencil
:start-at: technology
```

## ASAP7

The 7 nm predictive FinFET PDK (`asap7sc7p5t_28`, 7.5-track cells, a 54 nm
gate pitch, a 270 nm row). All values are in real (1x) dimensions; the
4x LEF that the PDK distributes for place and route is described as a
tool profile (see {doc}`checking`).

| Module | Contents | Parameters it needs |
|---|---|---|
| `asap7/device.stencil` | markers, fins, gates, gate cut, SDT/LISD/LIG, V0, the site `asap7sc7p5t`, 78 rules | `LANDING`: the metal V0 lands on; `BOUNDARY`: the cell outline layer |
| `asap7/frontside.stencil` | M1 .. M3 (36 nm pitch), the in-cell M1 grid, VIA12 and VIA23, 24 rules | `CPP`: the in-cell M1 lines follow the gate grid |
| `asap7/beol.stencil` | V3 .. M9 and the pad layer, their vias, 25 rules | `BELOW`: the metal VIA34 starts from |

[Open in the playground](https://dinple.github.io/Stencil-Lang/playground/?example=pdk/asap7/asap7.stencil)

```{literalinclude} ../examples/pdk/asap7/asap7.stencil
:language: stencil
:start-at: technology {
:end-before: LEF scaling
```

## PROBE3 FinFET

The PROBE3.0 FinFET variant with 2 fins and 4 tracks (45 nm gate pitch,
24 nm M0 and M2 pitch, 30 nm M1 pitch). The row height is
`(RT + 2) * MP0`, two tracks for the rails plus `RT` signal
tracks, so changing `RT` in the main file changes the row.

| Module | Contents | Parameters it needs |
|---|---|---|
| `probe3/device.stencil` | wells and implants, fins, gates (PC), gate cut, SDT/LISD/LIG, CA, the site `CORE` | `H_ROW`, `LANDING`, `BOUNDARY` |
| `probe3/frontside.stencil` | M0 .. M2, VIA0 and VIA1, 13 rules | none |

[Open in the playground](https://dinple.github.io/Stencil-Lang/playground/?example=pdk/probe3/probe3_finfet.stencil)

```{literalinclude} ../examples/pdk/probe3/probe3_finfet.stencil
:language: stencil
:start-at: technology {
```

## Testing a split

To check a split, resolve the single-file and the modular version and
compare the objects, leaving out the module and source line of each. The
two should have the same layers in the same order, with the same values.
The tests in
`tests/examples_compose.test.mjs` check the layer order, the bindings
(for example that ASAP7 VIA0 lands on M1 and VIA34 starts from M3) and
the site children of each composition.
