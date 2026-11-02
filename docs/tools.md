# Playground, VS Code and the command line

All three use the front end in `core/`.

## Playground

The [online playground](https://dinple.github.io/Stencil-Lang/playground/)
resolves the description on every edit and draws it:

- Stack: the layers bottom to top with their vias and rules, and a top
  view of the cell template with its rails, bands and tracks. Layers can be
  hidden; the view pans and zooms.
- Device: the transistor as described by its figures, arrays and cross.
- Resolved JSON: the exact form that tools read, with its hash.

A description with imports opens as one tab per module. Many diagnostics
offer a one-click fix, such as snapping an off-grid value to the grid or
correcting a misspelt name.

Share link copies a URL that contains the whole project, so it opens the
same files elsewhere. The page also takes a few query parameters, which
the links in these docs use:

| Parameter | Effect |
|---|---|
| `?example=PATH` | opens an example by its main file, for example `?example=transplant/probe3_asap7_grid.stencil` |
| `?layers=FIN,GATE,M2` | shows only these layers in the top view, also after an edit brings in new ones; All on leaves this mode |
| `?tab=device` or `?tab=json` | opens that view |
| `?theme=dark` or `?theme=light` | forces the colour theme |

## VS Code

The extension in `vscode/` adds, for `.stencil` files:

- the same live preview beside the editor (`Ctrl+K V`), following the
  active file and the cursor; clicking a shape jumps to its source;
- diagnostics as you type, across imported modules, with quick fixes;
- completion of kinds, attributes, enum values, names and functions;
- hover documentation, an outline, and Go to Definition across modules.

Build and install it from a checkout:

```bash
cd vscode
npm install
npm run package
code --install-extension stencil-lang-0.1.0.vsix
```

Each CI run also attaches the `.vsix` as a build artifact. The setting
`stencil.root` is the folder that import paths are relative to (default:
the workspace folder).

## Command line

```text
node cli.mjs resolve <main.stencil> [--root DIR] [--out FILE] [--with-diagnostics]
node cli.mjs check   <main.stencil> [--root DIR] [--quiet] [--profile FILE:NAME]
```

| Option | Meaning |
|---|---|
| `--root DIR` | the directory that import paths, and the `--profile` file, are relative to (default: the main file's directory) |
| `--out FILE` | write the resolved JSON to a file instead of standard output |
| `--with-diagnostics` | include the diagnostics in the JSON output |
| `--quiet` | do not print notes |
| `--profile FILE:NAME` | also check the technology against the tool profile `NAME` defined in `FILE` |

Exit codes: 0 when the description resolves cleanly, 1 when it has
errors, 3 when it resolves but the profile's tool cannot take it.

## Examples in this repository

| Main file | What it shows |
|---|---|
| `examples/level0_routing.stencil` | routing layers, a via and a site |
| `examples/level1_nanosheet.stencil`, `level1_finfet.stencil` | nanosheet and FinFET devices |
| `examples/level2_rules.stencil` | rules, cases, generator rules and derived masks |
| `examples/compose/gear_ratio.stencil` | a front-side module imported with a chosen gear ratio |
| `examples/pdk/gt2n/bspdn.stencil`, `fspdn.stencil` | GT2N with backside and with front-side power, from the same modules |
| `examples/pdk/asap7/asap7.stencil` | ASAP7 from device, front-side and upper-metal modules |
| `examples/pdk/probe3/probe3_finfet.stencil` | PROBE3 FinFET from device and front-side modules |
| `examples/transplant/probe3_asap7_grid.stencil` | PROBE3 devices under the ASAP7 metals |
| `examples/transplant/gt2n_device_probe3_grid.stencil` | GT2N devices under the PROBE3 metals |
