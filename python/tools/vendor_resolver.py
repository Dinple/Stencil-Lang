"""Copy the JavaScript resolver into the Python package, so an installed
package can run Technology.load() without a Stencil checkout:

    python tools/vendor_resolver.py            # -> stencil/_resolver/
    python tools/vendor_resolver.py OUT_DIR

Run it before building a wheel (pyproject.toml ships stencil/_resolver/).
The copy holds cli.mjs, package.json (ES modules) and core/*.js.
"""
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHECKOUT = HERE.parent.parent                      # src/stencil (or the repository root)


def files():
    """(source, path relative to the resolver directory) for every file the resolver needs."""
    out = [(CHECKOUT / "cli.mjs", Path("cli.mjs")), (CHECKOUT / "package.json", Path("package.json"))]
    out += [(p, Path("core") / p.name) for p in sorted((CHECKOUT / "core").glob("*.js"))]
    return out


def vendor(dest: Path) -> Path:
    if dest.exists():
        shutil.rmtree(dest)
    for src, rel in files():
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest / rel)
    return dest / "cli.mjs"


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "stencil" / "_resolver"
    print(vendor(out))
