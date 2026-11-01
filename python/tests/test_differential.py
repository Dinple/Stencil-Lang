"""Differential tests: the Python ports against the JavaScript reference, live.

Random layouts are checked (and devices recognized) by both checkers, random
cell templates expanded by both, tool profiles evaluated by both; any
difference in the raw output fails. Needs Node ($STENCIL_NODE or `node` on
PATH); skipped otherwise. STENCIL_FUZZ=<n> raises the number of layouts.
"""
import json
import os
import random
import shutil
import subprocess
import unittest
from pathlib import Path

from stencil.profile import check_profile
from stencil.rulecheck import check_rules, recognize_devices
from stencil.template import expand_site

HERE = Path(__file__).parent
REFERENCE = HERE.parent.parent / "tests" / "reference.mjs"
NODE = os.environ.get("STENCIL_NODE") or shutil.which("node")
N_LAYOUTS = int(os.environ.get("STENCIL_FUZZ", "400"))


def reference(requests, chunk=1000):
    """The JavaScript reference's answers, in batches (one Node process per batch)."""
    out = []
    for i in range(0, len(requests), chunk):
        p = subprocess.run([NODE, str(REFERENCE)], input=json.dumps(requests[i:i + chunk]), capture_output=True, text=True,
                           encoding="utf-8")
        if p.returncode:
            raise RuntimeError(f"the reference failed on requests {i}..{i + chunk}: {p.stderr[-2000:]}")
        out += json.loads(p.stdout)
    return [{"error": True} if isinstance(r, dict) and "error" in r and len(r) == 1 else r for r in out]


def py(fn, *args):
    """The Python port's answer in JSON form; any exception counts as an error,
    as any exception thrown by the reference does (their classes differ)."""
    try:
        return json.loads(json.dumps(fn(*args)))
    except Exception:            # noqa: BLE001
        return {"error": True}


TECH = """stencil 0.1
technology { grid = 1nm }
layer CH { role = channel }
layer A  { role = conductor; masks = 2 }
layer A2 { role = conductor }
layer V  { role = cut }
layer B  { role = conductor }
layer MK { role = marker }
layer LV { role = marker }
layer GA { role = marker; from = grow(A, 1nm) }
region SA { from = shrink(A, 1nm) }
region IAB { from = intersect(A, B) }
region MAB { from = minus(A, B) }
region UAB { from = union(A, B) }
region TA { from = touching(A, MK) }
region XA { from = avoiding(A, MK) }
connector C { lower = A; cut = V; upper = B }
connector D { lower = [A, A2]; cut = V; upper = B }
rule W1 { kind = width; on = A; value = 4nm }
rule W2 { kind = width; on = A; axis = y; limit = max; value = 9nm }
rule W3 { kind = width; on = B; limit = exact; value = 6nm; scope = MK }
rule L1 { kind = min_length; on = A; value = 8nm }
rule L2 { kind = length; on = B; axis = x; value = 7nm }
rule AR { kind = area; on = A; value = 40nm * 1nm }
rule S1 { kind = spacing; on = A; value = 5nm }
rule S2 { kind = spacing; on = A; axis = x; prl = 3nm; value = 7nm }
rule S3 { kind = spacing; on = [A, B]; value = 2nm }
rule S4 { kind = spacing; on = A; same_net = false; value = 6nm }
rule S5 { kind = spacing; on = A; same_color = true; value = 9nm }
rule S6 { kind = spacing; on = A; width_below = 6nm; value = 4nm }
rule S7 { kind = spacing; on = B; width_above = 5nm; value = 8nm }
rule S8 { kind = spacing; on = B
  table { width = [0nm, 6nm]; prl = [0nm, 10nm]; values = [[3nm, 4nm], [5nm, 7nm]] } }
rule S9 { kind = spacing; on = GA; value = 3nm }
rule SR { kind = spacing; on = SA; value = 4nm }
rule CS1 { kind = cut_spacing; on = C; value = 5nm }
rule CS2 { kind = cut_spacing; on = C; measure = center; value = 9nm }
rule CS3 { kind = cut_spacing; on = V; axis = y; measure = center; value = 8nm }
rule CS4 { kind = cut_spacing; on = V; value = 3.5nm }
rule K1 { kind = corner_spacing; on = A; value = 6nm }
rule K2 { kind = corner_spacing; on = [A, B]; value = 4nm }
rule E1 { kind = eol_spacing; on = A; value = 6nm }
rule E2 { kind = eol_spacing; on = A; axis = y; within = 2nm; width_below = 8nm; value = 5nm }
rule E3 { kind = eol_spacing; on = B; same_net = true; width_above = 3nm; value = 4nm }
rule N1 { kind = enclosure; on = [V, A]; value = 2nm }
rule N2 { kind = enclosure; on = [V, B]; axis = x; value = 3nm }
rule N3 { kind = enclosure; on = C; value = 1nm }
rule N4 { kind = enclosure; on = [V, A]
  alternative a { margins = [0nm, 0nm, 3nm, 3nm] }
  alternative b { margins = [3nm, 3nm, 0nm, 0nm] } }
rule N5 { kind = enclosure; on = [V, B]; width_below = 10nm; limit = exact; value = 2nm }
rule N6 { kind = enclosure; on = D; value = 2nm }
rule X1 { kind = extension; on = [A, B]; axis = x; value = 3nm }
rule X2 { kind = extension; on = [B, A]; axis = y; value = 2nm }
rule I1 { kind = inside; on = [V, A] }
rule I2 { kind = interacting; on = [V, UAB] }
rule I3 { kind = not_interacting; on = [MK, B] }
rule I4 { kind = not_overlapping; on = [IAB, LV] }
rule I5 { kind = width; on = MAB; value = 3nm }
rule I6 { kind = width; on = TA; value = 5nm }
rule I7 { kind = spacing; on = XA; value = 3nm }
rule CK { kind = width; on = B; value = 50nm; intent = checker_only }
rule CA { kind = length; on = A
  case via_end { value = 2nm }
  case open_end { value = 3nm } }
figure FIG { layer = CH; width = 4nm }
cross DEV { gate = A; channel = FIG; faces = all
  model n_lv { polarity = n; markers = [LV] }
  model n_sv { polarity = n; exclude = [LV] }
  model p_any { polarity = p }
  model p_mk { polarity = p; markers = [MK, LV] }
}
cross CUT { gate = A; channel = FIG; faces = all; recognize = minus(intersect(A, CH), MK) }
"""

LAYERS = ["A", "A", "A", "A2", "B", "B", "V", "V", "MK", "LV", "CH"]


def random_layout(rng, span):
    shapes = []
    for _ in range(rng.randint(1, 10)):
        layer = rng.choice(LAYERS)
        x0, y0 = rng.randint(-span, span), rng.randint(-span, span)
        w, h = rng.randint(1, max(2, span // 2)), rng.randint(1, max(2, span // 2))
        if rng.random() < 0.15:
            w = h                                        # squares: eol axis cases
        s = {"layer": layer, "rect": [x0, y0, x0 + w, y0 + h]}
        if rng.random() < 0.93:
            s["net"] = rng.choice("ab")
        if layer == "A" and rng.random() < 0.8:
            s["color"] = rng.choice([1, 2])
        if layer == "V" and rng.random() < 0.85:
            s["connector"] = rng.choice(["C", "C", "D"])
        shapes.append(s)
    # sometimes a shape exactly abutting another (merging, shared edges)
    if shapes and rng.random() < 0.4:
        s = dict(shapes[0])
        x0, y0, x1, y1 = s["rect"]
        s["rect"] = [x1, y0, x1 + rng.randint(1, 6), y1]
        shapes.append(s)
    return shapes


def random_device_layout(rng):
    """Gates (A) across channel strips (CH) under random marker layers (LV, MK)."""
    shapes = []
    for _ in range(rng.randint(1, 3)):
        y = rng.randint(0, 40)
        shapes.append({"layer": "CH", "rect": [-10, y, 60, y + rng.randint(2, 8)]})
    for k in range(rng.randint(1, 4)):
        x = 14 * k + rng.randint(0, 4)
        shapes.append({"layer": "A", "rect": [x, -5, x + rng.randint(2, 6), 55]})
    for _ in range(rng.randint(0, 4)):
        x0, y0 = rng.randint(-15, 50), rng.randint(-10, 45)
        shapes.append({"layer": rng.choice(["LV", "LV", "MK"]), "rect": [x0, y0, x0 + rng.randint(3, 40), y0 + rng.randint(3, 40)]})
    rng.shuffle(shapes)
    return shapes


def random_site(rng):
    """A random (often invalid) cell template, to exercise the problem paths too."""
    h = rng.choice([40, 48, 60, 72])
    w = rng.choice([10, 12, 15, 18])
    lines = [f"site S {{ width = {w}nm; height = {h}nm"]
    for name in rng.sample(["VDD", "VSS", "VX"], rng.randint(0, 3)):
        if rng.random() < 0.5:
            lines.append(f"  rail {name} {{ layer = {rng.choice(['M0', 'BM0'])}; edge = {rng.choice(['top', 'bottom'])} }}")
        else:
            lines.append(f"  rail {name} {{ layer = M0; y = {rng.randint(-4, h + 4)}nm; width = {rng.randint(1, 12)}nm }}")
    lo = rng.randint(-2, h // 2)
    lines.append(f"  band n {{ stratum = DEV; y = {lo}nm .. {rng.randint(lo + 1, h + 2)}nm }}")
    if rng.random() < 0.7:
        lines.append(f"  band p {{ stratum = DEV; y = {rng.randint(0, h // 2)}nm .. {h}nm }}")
    r = rng.random()
    if r < 0.3:
        lines.append(f"  tracks M0 {{ use = {rng.randint(0, 2)}..{rng.randint(1, 5)} }}")
    elif r < 0.55:
        lines.append(f"  tracks T {{ layer = M0; pitch = {rng.randint(3, 13)}nm; offset = {rng.randint(0, 8)}nm }}")
    elif r < 0.75:
        lines.append(f"  tracks T {{ layer = PC; at = [{', '.join(f'{rng.randint(0, w)}nm' for _ in range(3))}] }}")
    else:
        lines.append(f"  tracks BM0 {{ use = [{rng.randint(0, 3)}, {rng.randint(0, 6)}] }}")
    if rng.random() < 0.6:
        at = rng.choice(["", "; at = left", "; at = [left, right]", "; at = [top, bottom]", "; at = right; y = 4nm .. 20nm"])
        lines.append(f"  edge_feature EF {{ layer = PC; width = {rng.choice([2, 3, 4, 8, 30])}nm; "
                     f"shared = {rng.choice(['true', 'false'])}; extend = {rng.randint(0, 3)}nm{at} }}")
    lines.append("}")
    if rng.random() < 0.5:
        lines.append(f"site H {{ width = {w}nm; height = {2 * h}nm")
        lines.append("  row R0 { site = S; y = 0nm }")
        lines.append(f"  row R1 {{ site = S; y = {h + rng.choice([0, 0, 3])}nm; flip = {rng.choice(['true', 'false'])} }}")
        lines.append("  rail TOP { layer = M0; edge = top }")
        lines.append("}")
    return lines


SITE_BASE = """stencil 0.1
technology { grid = 1nm }
layer ACT { role = channel }
layer PC  { role = conductor; direction = vertical; width = 4nm }
layer BM0 { role = conductor; direction = horizontal; pitch = 9nm; width = 3nm }
layer M0  { role = conductor; direction = horizontal; pitch = 12nm; width = 5nm }
stratum DEV { layers = [ACT, PC] }
"""


N_MUTANTS = int(os.environ.get("STENCIL_MUTANTS", "600"))
# Arbitrary JSON values that stand in for attribute values in mutated forms (integers within
# what both languages parse exactly: JavaScript rounds JSON integers beyond 2^53).
VALUES = [None, [], {}, 0, 1, 2, -3, 1.0, 1.5, 0.5, 2 ** 52, 1e21, 1e-7, "x", "", "0", "3/2", "1/0", "4", True, False,
          {"ref": None}, {"ref": "A"}, {"ref": ["A"]}, {"ref": "M1"}, {"min": 1}, {"min": "a", "max": 3}, {"min": 0, "max": 2.5},
          [None], [1, "a"], ["left", "x"], [0, 3], {"one_of": [1, 2.5]}, {"one_of": []}, {"call": []}, {"call": "grow", "args": "A1"},
          {"call": "union", "args": 5}, {"call": "grow", "args": [{"ref": "A"}, 1.5]}, "horizontal", "vertical", "both", "top", "n", "p",
          "min", "max", "exact", "center", "x", "y", [{"ref": "A"}, None], ["n", "p"], [1, 1.0], "\U0001F600", 9007199254740992, -2 ** 51, 4503599627370495]


NAMES = [None, [], True, 1, "", "\U0001F600", "\ue000", "M1\u0000", "A", "V0"]


def mutate(rng, resolved):
    """A copy of `resolved` with 1-4 attribute values replaced or removed (structure kept)."""
    r = json.loads(json.dumps(resolved))
    holders = [o["attrs"] for o in r["objects"]] + [c["attrs"] for o in r["objects"] for c in o.get("children", [])]
    for _ in range(rng.randint(1, 4)):
        if rng.random() < 0.1:                       # a top-level name
            rng.choice(r["objects"])["name"] = json.loads(json.dumps(rng.choice(NAMES)))
            continue
        tables = [c["attrs"] for o in r["objects"] for c in o.get("children", []) if c.get("kind") == "table"]
        if tables and rng.random() < 0.15:           # breakpoints out of order
            ta = rng.choice(tables)
            for k in ("width", "prl"):
                if isinstance(ta.get(k), list):
                    rng.shuffle(ta[k])
            continue
        attrs = rng.choice(holders)
        key = rng.choice(list(attrs) + ["width", "height", "y", "pitch", "offset", "order", "masks", "on", "value", "axis", "limit"])
        if key in attrs and rng.random() < 0.2:
            del attrs[key]
        else:
            attrs[key] = json.loads(json.dumps(rng.choice(VALUES)))
    return r


def example_layout(rng, resolved):
    """Random rectangles on an example technology's own layers."""
    layers = [o["name"] for o in resolved["objects"] if o.get("kind") == "layer"] or ["A"]
    shapes = []
    for _ in range(rng.randint(1, 8)):
        x0, y0 = rng.randint(0, 200), rng.randint(0, 200)
        shapes.append({"layer": rng.choice(layers), "rect": [x0, y0, x0 + rng.randint(1, 60), y0 + rng.randint(1, 60)],
                       "net": rng.choice("ab"), "color": rng.choice([1, 2])})
    return shapes


def random_profile(rng):
    keys = {"directions": [["horizontal", "vertical"], ["horizontal"], [], "horizontal", None],
            "tracks_modes": [["required"], ["required", "access", "none"], []], "needs_tracks": [True, False, 0, "yes"],
            "masks": [1, 2, {"min": 1, "max": 3}, {"min": 2}, [1, 2], None, "2"], "strata": [1, 2, {"min": 1, "max": 2}, 0],
            "sides": [["front"], ["device", "front"], [], "front"], "rule_kinds": [["width", "spacing"], [], ["width"], None],
            "rule_features": [["axis", "table"], [], ["axis", "same_net", "prl", "case"], "axis"]}
    return {k: json.loads(json.dumps(rng.choice(v))) for k, v in keys.items() if rng.random() < 0.6}


@unittest.skipUnless(NODE and REFERENCE.exists(), "needs Node and tests/reference.mjs")
class Differential(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        [r] = reference([{"op": "resolve", "source": TECH}])
        assert not r["errors"], r["errors"]
        cls.tech = r["resolved"]

    def compare(self, label, requests, ours):
        theirs = reference(requests)
        self.assertEqual(len(theirs), len(ours), f"{label}: the reference answered {len(theirs)} of {len(ours)} requests")
        bad = [(i, a, b) for i, (a, b) in enumerate(zip(ours, theirs)) if a != b]
        if bad:
            i, a, b = bad[0]
            self.fail(f"{label}: {len(bad)} of {len(ours)} differ; first #{i}\n request {json.dumps(requests[i])[:3000]}\n python {a}\n js     {b}")

    def test_random_layouts_check_alike(self):
        rng = random.Random(20261030)
        layouts = [random_layout(rng, rng.choice([8, 20, 60])) for _ in range(N_LAYOUTS)]
        layouts += [[{**s, "rect": [v * 2 ** 40 for v in s["rect"]]} for s in random_layout(rng, 8)] for _ in range(20)]
        for mode in ("generator", "checker"):
            reqs = [{"op": "check", "resolved": self.tech, "shapes": l, "mode": mode} for l in layouts]
            self.compare(f"check ({mode})", reqs, [py(check_rules, self.tech, {"shapes": l}, mode) for l in layouts])

    def test_random_layouts_recognize_alike(self):
        rng = random.Random(7)
        layouts = [random_layout(rng, 20) for _ in range(N_LAYOUTS // 4)] + [random_device_layout(rng) for _ in range(N_LAYOUTS // 2)]
        reqs = [{"op": "recognize", "resolved": self.tech, "shapes": l} for l in layouts]
        self.compare("recognize", reqs, [py(recognize_devices, self.tech, {"shapes": l}) for l in layouts])

    def test_mutated_resolved_forms_alike(self):
        """Raw resolved forms with attribute values replaced by arbitrary JSON:
        both implementations must give the same output, or both fail."""
        rng = random.Random(1234)
        bases = [self.tech] + [json.loads(f.read_text(encoding="utf-8"))["resolved"] for f in sorted((HERE / "data" / "examples").glob("*.json"))]
        reqs, ours = [], []
        for _ in range(N_MUTANTS):
            base = rng.choice(bases)
            r = mutate(rng, base)
            shapes = random_layout(rng, 20) if base is self.tech else example_layout(rng, base)
            for s in shapes:
                if rng.random() < 0.15:
                    s[rng.choice(["net", "color", "connector"])] = rng.choice(VALUES)
            reqs.append({"op": "check", "resolved": r, "shapes": shapes})
            ours.append(py(check_rules, r, {"shapes": shapes}))
            reqs.append({"op": "recognize", "resolved": r, "shapes": shapes})
            ours.append(py(recognize_devices, r, {"shapes": shapes}))
            for site in [o.get("name") for o in r["objects"] if o.get("kind") == "site"][:2]:
                units = rng.choice([1, 2, 3])
                reqs.append({"op": "expand", "resolved": r, "name": site, "units": units})
                # the name as the reference receives it: a copy (object names are looked up by identity in both)
                ours.append(py(expand_site, r, json.loads(json.dumps(site)), units))
            prof = {"kind": "profile", "name": "P", "attrs": random_profile(rng)}
            reqs.append({"op": "profile", "resolved": r, "profile": prof})
            ours.append(py(lambda r, p: dict(zip(("findings", "scope"), check_profile(r, p))), r, prof))
        self.compare("mutated forms", reqs, ours)

    def test_rejected_expansions_report_alike(self):
        """An oversized cell: both refuse it with the same (Number-arithmetic) message."""
        r = {"objects": [{"kind": "site", "name": "S", "attrs": {"width": 4503599627370495, "height": 1}, "children": []}]}
        reqs = [{"op": "expand", "resolved": r, "name": "S", "units": u} for u in (1, 3, 7)]
        ours = [py(expand_site, r, "S", u) for u in (1, 3, 7)]
        self.assertIn("13510798882111484 x 1", ours[1]["problems"][0]["message"])
        self.compare("rejected expansions", reqs, ours)

    def test_invalid_shapes_are_rejected_alike(self):
        bad = [[{"layer": "A", "rect": [0, 0, 0, 5]}], [{"layer": "A", "rect": [0, 0, 1.5, 5]}], [{"layer": "A", "rect": [0, 0, 2 ** 52, 5]}]]
        reqs = [{"op": "check", "resolved": self.tech, "shapes": l} for l in bad]
        self.compare("invalid shapes", reqs, [py(check_rules, self.tech, {"shapes": l}) for l in bad])

    def test_random_sites_expand_alike(self):
        rng = random.Random(11)
        srcs = [SITE_BASE + "\n".join(random_site(rng)) + "\n" for _ in range(150)]
        resolved = [r["resolved"] for r in reference([{"op": "resolve", "source": s} for s in srcs])]
        reqs, ours = [], []
        for r in resolved:
            for name in ("S", "H"):
                for units in (1, 3):
                    reqs.append({"op": "expand", "resolved": r, "name": name, "units": units})
                    ours.append(py(expand_site, r, name, units))
        self.compare("expand (random sites)", reqs, ours)

    def test_example_sites_and_profiles_alike(self):
        reqs, ours = [], []
        profiles = [
            {"directions": ["horizontal", "vertical"], "needs_tracks": True, "masks": {"min": 1, "max": 2}, "strata": 1, "sides": ["device", "front"],
             "rule_kinds": ["width", "spacing", "enclosure", "eol_spacing", "cut_spacing", "min_length"],
             "rule_features": ["axis", "same_net", "width_below", "prl", "table"]},
            {"directions": ["horizontal"], "tracks_modes": ["required"], "masks": 1, "strata": {"min": 2, "max": 3}},
            {"rule_features": []},
            {"sides": ["front"], "rule_kinds": ["width"]},
        ]
        for f in sorted((HERE / "data" / "examples").glob("*.json")):
            r = json.loads(f.read_text(encoding="utf-8"))["resolved"]
            for site in [o["name"] for o in r["objects"] if o["kind"] == "site"] + ["missing"]:
                for units in (1, 2, 5):
                    reqs.append({"op": "expand", "resolved": r, "name": site, "units": units})
                    ours.append(py(expand_site, r, site, units))
            for p in profiles:
                prof = {"kind": "profile", "name": "P", "attrs": p}
                reqs.append({"op": "profile", "resolved": r, "profile": prof})
                f_, scope = check_profile(r, prof)
                ours.append({"findings": f_, "scope": scope})
        self.compare("examples", reqs, ours)


if __name__ == "__main__":
    unittest.main()
