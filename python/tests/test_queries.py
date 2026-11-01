"""The shared query API cases (tests/query_cases.json) on the Python API.

The same file runs against the JavaScript API (tests/query.test.mjs). The
technologies come from tests/data/examples/ (resolved): no Node needed."""
import dataclasses
import json
import unittest
from fractions import Fraction
from pathlib import Path

import stencil
from stencil._util import frac_str
from stencil import Device, Technology

HERE = Path(__file__).parent
CASES = json.loads((HERE.parent.parent / "tests" / "query_cases.json").read_text(encoding="utf-8"))["cases"]
TECHS = {}


def tech(name, incomplete=False):
    if (name, incomplete) not in TECHS:
        folder = "raw" if name.startswith("raw_") else "examples"
        TECHS[name, incomplete] = Technology.from_json(HERE / "data" / folder / f"{name}.json", allow_incomplete=incomplete)
    return TECHS[name, incomplete]


def encode(x):
    """Answers in the shared encoding: lengths as exact strings, records as objects."""
    if isinstance(x, Fraction):
        return frac_str(x)
    if isinstance(x, Device):
        return {k: encode(getattr(x, k)) for k in ("name", "gate", "channel_figure", "channel_layer", "faces", "stratum", "sizes", "models")}
    if dataclasses.is_dataclass(x):
        return {f.name: encode(getattr(x, f.name)) for f in dataclasses.fields(x)}
    if isinstance(x, dict) or hasattr(x, "items"):
        return {k: encode(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [encode(v) for v in x]
    return x


def pick(x, path):
    def get(v, segs):
        if not segs:
            return v
        s, rest = segs[0], segs[1:]
        if s == "*":
            return [get(e, rest) for e in v]
        return get(v[int(s)] if isinstance(v, list) else v[s], rest)

    paths = path.split(",")
    if len(paths) == 1:
        return get(x, paths[0].split("."))
    return {p: get(x, p.split(".")) for p in paths}


def call(target, spec):
    name, args, kw = (list(spec) + [[], {}][len(spec) - 1:])[:3]
    attr = getattr(target, name)
    return attr(*args, **kw) if callable(attr) else attr


class Queries(unittest.TestCase):
    def test_cases(self):
        self.assertGreater(len(CASES), 90)
        for c in CASES:
            with self.subTest(c["name"]):
                try:
                    x = call(tech(c["tech"], c.get("incomplete", False)), c["q"])
                    if "then" in c:
                        x = call(x, c["then"])
                except Exception as e:   # noqa: BLE001 - the case says which error
                    if "error" not in c:
                        raise
                    self.assertIsInstance(e, getattr(stencil, c["error"], None) or __builtins__[c["error"]], f"{c['name']}: {e!r}")
                    if "needs" in c:
                        self.assertEqual([list(r) for r in e.rules], c["needs"])
                    continue
                if "error" in c:                       # (formatted only on failure: answers may hold huge numbers)
                    self.fail(f"{c['name']}: expected {c['error']}, got {encode(x)}")
                got = encode(x)
                if "pick" in c:
                    got = pick(got, c["pick"])
                self.assertEqual(got, c["want"])


if __name__ == "__main__":
    unittest.main()
