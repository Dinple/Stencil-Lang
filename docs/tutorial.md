# Tutorial

Five short files introduce the vocabulary one level at a time. Each one is
complete: it resolves on its own and the playground draws it. Open each in
the playground and change the values the comments suggest.

## Level 0: routing layers

A routing-only technology, about what a tech LEF holds: metal layers with
a direction, width and pitch, the cut layer between them, a via, and a
cell site with power rails.

[Open in the playground](https://dinple.github.io/Stencil-Lang/playground/?example=level0_routing.stencil)

```{literalinclude} ../examples/level0_routing.stencil
:language: stencil
```

Layers are listed bottom to top, and that order is the vertical stack.
Lengths carry a unit, and every length must land on the `grid` of the
`technology` block. Change `pitch = 48nm` on M1 to `pitch = 47.5nm` and
the resolver reports that the value is off the 1 nm grid.

## Level 1: transistors

A device is described by what it is made of. A `figure` is one drawn
shape class on a layer (a sheet, a fin, a gate line); an `array` repeats a
figure along an axis; a `cross` says where a gate crosses a channel and
which sizing option the netlist sets. The nanosheet file stacks three
sheets along z and lets the netlist set the sheet width:

[Open in the playground](https://dinple.github.io/Stencil-Lang/playground/?example=level1_nanosheet.stencil)

```{literalinclude} ../examples/level1_nanosheet.stencil
:language: stencil
```

The FinFET file is a second small technology (a 54 nm gate pitch and 7
tracks of 36 nm, with a single metal layer). Its channel is an array of
fins along y, the gate covers three faces, and the netlist sets the fin
count.

[Open in the playground](https://dinple.github.io/Stencil-Lang/playground/?example=level1_finfet.stencil)

The `site` is the cell template. Its bands say which stratum (here one
tier of n and p devices) sits in which part of the row, and `tracks` says
which routing tracks a cell may use.

## Level 2: rules and derived masks

Rules are objects with a `kind` and the layers they apply `on`. A rule can
depend on context (`case`), on a width (`width_below`), or exist only for
a generator (`intent = generator`). Marker layers with `from` are
computed from other layers.

[Open in the playground](https://dinple.github.io/Stencil-Lang/playground/?example=level2_rules.stencil)

```{literalinclude} ../examples/level2_rules.stencil
:language: stencil
```

The rule kinds and their exact meaning are listed in
{doc}`reference/VOCABULARY`, section 3.

## Level 3: modules

A module is a file that can leave some of its parameters `required`. The
importer binds them. Here a front-side module leaves its M1 pitch and the
device layer that its first via lands on to the importer:

```{literalinclude} ../examples/compose/lib/frontside.stencil
:language: stencil
```

The main file imports it next to a device module, binds the pitch as a
gear ratio of the gate pitch, and adds the rails and tracks to the
device module's site with a patch (`&dev.CORE { ... }`):

[Open in the playground](https://dinple.github.io/Stencil-Lang/playground/?example=compose/gear_ratio.stencil)

```{literalinclude} ../examples/compose/gear_ratio.stencil
:language: stencil
```

`stack` in the `technology` block gives the order of the modules' layers,
bottom to top. A `check` holds a condition over the resolved values; when
it is false, resolution fails with its message. Set `GEAR = 1/2` and the
front-side module's own `M1_FITS` check fails, because 22.5 nm cannot
hold a 14 nm wire plus 13 nm of spacing.

Modules are what make the larger examples readable. {doc}`pdks` shows
three real technologies split this way, and {doc}`transplant` combines
modules from two of them.
