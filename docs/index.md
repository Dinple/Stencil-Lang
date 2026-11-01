# Stencil

Stencil is a small declarative language for describing a semiconductor
technology for standard-cell work: the layers and their order, routing
grids, transistors, contacts, design rules and cell templates. A
description is plain text. It can be split into modules that import and
patch each other, and it resolves to one exact, hashed JSON form that
tools read.

```stencil
stencil 0.1
technology { grid = 0.5nm }

CPP = 42nm
layer GATE { role = conductor; direction = vertical; width = 14nm }
layer M1   { role = conductor; direction = vertical; pitch = 2/3 * CPP; masks = 2 }
rule  M1_S { kind = spacing; on = M1; value = 14nm }
```

The [playground](https://dinple.github.io/Stencil-Lang/playground/) runs
in the browser. Edit a description on the left and the stack, the cell
template and the devices are drawn on the right as you type.

## What is in the repository

| Part | Where | What it does |
|---|---|---|
| Front end | `core/` | lexer, parser, resolver, the std/0 vocabulary and the canonical hash, as plain ES modules with no dependencies |
| Command line | `cli.mjs` | `resolve` and `check`, with tool profiles |
| Query API | `python/`, `core/query.js` | answers a cell generator's questions (tracks, vias, rule values, devices) with exact numbers |
| Rule checker | `core/rulecheck.js`, `python/stencil/rulecheck.py` | checks rectangles against the rules and recognizes devices |
| Playground | `playground/` | live editor with drawings |
| VS Code | `vscode/` | diagnostics, completion, hover, outline and the same live preview |
| Examples | `examples/` | tutorial levels, a two-module example, GT2N, ASAP7, PROBE3 and two transplants |

## Contents

```{toctree}
:maxdepth: 2
:caption: Guide

getting-started
tutorial
pdks
transplant
checking
tools
```

```{toctree}
:maxdepth: 1
:caption: Reference

reference/SPEC
reference/VOCABULARY
reference/API
```
