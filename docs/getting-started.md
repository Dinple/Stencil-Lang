# Getting started

## In the browser

Open the [playground](https://dinple.github.io/Stencil-Lang/playground/).
The Examples menu has every description in this guide.

## From a checkout

The front end needs Node.js 18 or newer.

```bash
git clone -b yw-dev https://github.com/Dinple/Stencil-Lang.git
cd Stencil-Lang
node cli.mjs check examples/level0_routing.stencil
```

`check` resolves a description and prints one line per diagnostic, then a
summary:

```text
6 objects, 0 imported modules, 0 errors, 0 warnings, 0 notes, 8.7 ms, sha256:916b7e27...
```

`resolve` writes the resolved JSON:

```bash
node cli.mjs resolve examples/level1_nanosheet.stencil --out nanosheet.json
```

A description that imports other files is checked with `--root`, the
directory that import paths are relative to:

```bash
node cli.mjs check examples/pdk/gt2n/bspdn.stencil --root examples
```

The exit code is 0 when the description resolves cleanly, 1 when there
are errors (a failed `check` object is an error), and 3 when it resolves
but a tool profile given with `--profile` cannot take it.

## A local playground

```bash
python3 playground/serve.py
```

and open the URL it prints (port 8765, or the next free one). It loads the examples from your
checkout, so edits to files under `examples/` show up on reload.

## The Python package

The query API is pure Python with no dependencies. To resolve
`.stencil` files it runs the JavaScript resolver, so it needs Node.js on
the path (or in `STENCIL_NODE`); a resolved JSON file loads without Node.
Copy the resolver into the package before installing it:

```bash
python3 python/tools/vendor_resolver.py
pip install ./python
```

Inside a checkout, `python/` also works without installing: the package
finds `cli.mjs` two directories up.

```python
from stencil import Technology

t = Technology.load("pdk/gt2n/bspdn.stencil", root="examples")
t.site("gt2_6t").height          # Fraction(144, 1), in nm
t.via("M0", "M1").size           # (Fraction(14, 1), Fraction(12, 1))
```

See {doc}`checking` and the {doc}`reference/API`.

## Running the tests

```bash
node --test tests/*.test.mjs tests/conformance/*.test.mjs
cd python && STENCIL_NODE=$(which node) python3 -m unittest discover -s tests -t .
```
