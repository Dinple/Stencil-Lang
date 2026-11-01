# Stencil for VS Code

Language support for [Stencil](https://github.com/Dinple/Stencil-Lang) technology
descriptions (`.stencil`), with the same live drawing as the online
playground, beside your editor.

## Features

- Live preview (`Ctrl+K V`, or the preview button in the editor title):
  top view of the cell template with layer toggles, pan and zoom; the layer
  stack with vias and rules; the device card; the resolved JSON. It follows
  the active file and the cursor, and clicking a shape or a row jumps to its
  source.
- Diagnostics as you type, across imported modules, with quick fixes
  (e.g. snap an off-grid value, fix a misspelt name) and *Stencil: Apply All
  Quick Fixes in This File*. A module imported by an open file shows what its
  importer's bindings make of it, not its standalone errors.
- Completion of object kinds, attributes of the enclosing kind, enum
  values, declared names and functions, from the std/0 vocabulary.
- Hover documentation for kinds, attributes and functions.
- Outline of the objects in a file, and Go to Definition across modules.
- *Stencil: Show Resolved JSON* opens the resolved form beside the editor.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `stencil.root` | `""` | Folder that import paths are resolved from, relative to the workspace folder |
| `stencil.diagnostics.delay` | `250` | Milliseconds to wait after an edit before resolving again |

## Building from source

```bash
cd vscode
npm install
npm run build            # dist/extension.js, dist/preview.js
npm test                 # unit tests
npm run package          # stencil-lang-<version>.vsix
code --install-extension stencil-lang-0.1.0.vsix
```

`npm run test:integration` runs the integration suite in a downloaded VS Code
(needs a display); on WSL without one, `test/integration/run-windows.sh` runs
it in the Windows VS Code instead.

The extension bundles the language from `../core` and the renderer from
`../playground`, so it always matches the command line and the playground.
