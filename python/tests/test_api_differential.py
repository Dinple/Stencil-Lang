"""Differential test of the two query APIs: python/stencil/technology.py against
core/query.js, on the example technologies and on mutated resolved forms.

Every public query is called with generated arguments on both; the answers
(in the shared encoding of query_cases.json) or the error classes must be the
same. Needs Node; skipped otherwise. STENCIL_API_MUTANTS=<n> sets the count.
"""
import json
import os
import random
import unittest

import stencil
from stencil import Technology

from .test_differential import NODE, REFERENCE, VALUES, mutate, reference
from .test_queries import HERE, call, encode

N_FORMS = int(os.environ.get("STENCIL_API_MUTANTS", "400"))
BASES = {f.stem: json.loads(f.read_text(encoding="utf-8")) for f in sorted((HERE / "data" / "examples").glob("*.json"))}


def error_class(e):
    for cls in (stencil.UnresolvedRuleError, stencil.AmbiguousError, stencil.UnknownName, stencil.ResolveError, stencil.StencilError):
        if isinstance(e, cls):
            out = {"error": cls.__name__}
            if cls is stencil.UnresolvedRuleError:
                out["rules"] = [list(r) for r in e.rules]
            return out
    if isinstance(e, ValueError):
        return {"error": "ValueError"}
    if isinstance(e, TypeError):
        return {"error": "TypeError"}
    return {"error": f"crash:{type(e).__name__}"}


# Inputs for the unit conversions and for argument validation (no floats: the two
# languages read floats differently by design, doc/API.md design rule 2).
NUMBERS = ["14", "-3.5", "1e2", "29/2", "1/0", "\u00851", " 7 ", "\u20037", "+1", "0x10", "\u0661\u0662", "1.", ".5", "",
           12, -4, 0, 2 ** 53, None, True, [1], {"n": 1}]
ODD = [None, 5, "", "\u0000", "M1\u0000", ["M1"], {"ref": "M1"}, True, "x_kind"]


def nested_mutate(rng, resolved):
    """mutate(), plus nested values, invalid flags and odd names."""
    r = mutate(rng, resolved)
    objs = r["objects"]
    for _ in range(rng.randint(0, 2)):
        o = rng.choice(objs)
        roll = rng.random()
        if roll < 0.3:
            o["invalid"] = True
        elif roll < 0.5 and o.get("children"):
            rng.choice(o["children"])["name"] = json.loads(json.dumps(rng.choice(ODD)))
        else:                                       # an element inside a list or object value
            vals = [v for v in o["attrs"].values() if isinstance(v, (list, dict)) and v]
            if vals:
                v = rng.choice(vals)
                k = rng.randrange(len(v)) if isinstance(v, list) else rng.choice(list(v))
                v[k] = json.loads(json.dumps(rng.choice(VALUES)))
    return r


def python_api(resolved, incomplete, calls):
    try:
        t = Technology(resolved, allow_incomplete=incomplete)
    except Exception as e:      # noqa: BLE001
        return {"construct": error_class(e), "results": []}
    results = []
    for name, args, kw, then in calls:
        try:
            x = call(t, [name, args, kw])
            if then:
                x = call(x, then)
            results.append(json.loads(json.dumps(encode(x))))
        except Exception as e:  # noqa: BLE001
            results.append(error_class(e))
    return {"construct": "ok", "results": results}


def maybe(rng, values, p=0.5):
    return rng.choice(values) if rng.random() < p else None


def calls_for(rng, resolved):
    """Queries over the names a resolved form holds, with random conditions."""
    objs = [o for o in resolved.get("objects", []) if isinstance(o, dict)]
    named = lambda kind: [o["name"] for o in objs if o.get("kind") == kind and isinstance(o.get("name"), str)]
    layers, sites, devices, profiles = named("layer"), named("site"), named("cross"), named("profile")
    names = [o["name"] for o in objs if isinstance(o.get("name"), str)]
    grid = resolved.get("grid_nm", 1)
    nm = lambda v: f"{v}*" if False else str(v * (0.5 if grid == "1/2" else 1)) if isinstance(v, int) else v
    out = [["layers", [], {}, None], ["routing_layers", [], {}, None], ["vias", [], {}, None], ["sites", [], {}, None],
           ["profiles", [], {}, None], ["rules", [], {"include_checker_only": True}, None], ["grid", [], {}, None]]
    out += [["layer", [n], {}, None] for n in rng.sample(layers, min(4, len(layers)))]
    out += [["routing_layers", [s], {}, None] for s in sites[:1]]
    out += [["site", [s], {"units": rng.choice([1, 2])}, None] for s in sites]
    out += [["site", [s], {}, ["tracks", [rng.choice(layers or ["X"])], {}]] for s in sites[:1]]
    for c in [o for o in objs if o.get("kind") == "connector" and isinstance(o.get("name"), str)][:2]:
        for on in (c["name"], [c["name"]], [c["name"], c["name"]]):
            out.append(["rule_value", [rng.choice(["cut_spacing", "enclosure"]), on], {}, None])
    for c in [o for o in objs if o.get("kind") == "connector"][:3]:
        lo, up = c["attrs"].get("lower"), c["attrs"].get("upper")
        lo = lo[0] if isinstance(lo, list) and lo else lo
        out.append(["via", [(lo or {}).get("ref") if isinstance(lo, dict) else lo, up.get("ref") if isinstance(up, dict) else up], {}, None])
    rules = [o for o in objs if o.get("kind") == "rule"]
    for r in rng.sample(rules, min(10, len(rules))):
        a = r["attrs"]
        on = a.get("on")
        ops = [x.get("ref") if isinstance(x, dict) else x for x in on] if isinstance(on, list) else [on.get("ref") if isinstance(on, dict) else on]
        kw = {k: v for k, v in {
            "limit": maybe(rng, ["min", "max", "exact"], 0.3), "axis": maybe(rng, ["x", "y"]), "width": maybe(rng, ["10", "20", 30, "12.5"]),
            "prl": maybe(rng, ["0", "50", 100]), "same_net": maybe(rng, [True, False]), "same_color": maybe(rng, [True, False]),
            "scopes": maybe(rng, [[], [rng.choice(names or ["X"])]], 0.4), "ignore": maybe(rng, [[rng.choice([x["name"] for x in rules])]], 0.2),
        }.items() if v is not None}
        out.append(["rule_value", [a.get("kind"), ops if len(ops) > 1 else ops[0]], kw, None])
        if a.get("kind") == "enclosure" and len(ops) == 2:
            out.append(["enclosure", ops, {k: kw[k] for k in ("width", "scopes", "ignore") if k in kw}, None])
    for n in [n for n in layers if rng.random() < 0.3][:3]:
        out.append(["min_spacing", [n], {"axis": "x", "width": "10", "prl": "40", "same_net": False, "same_color": False}, None])
        out.append(["min_width", [n], {"axis": rng.choice(["x", "y"]), "scopes": []}, None])
    for d in devices:
        dev = next(o for o in objs if o.get("name") == d)
        sizes = [c.get("name") for c in dev.get("children", []) if c.get("kind") == "size" and isinstance(c.get("name"), str)]
        out.append(["device", [d], {}, None])
        out.append(["device", [d], {}, ["w_eff", [], {s: rng.choice([1, 2, 3, "7", "13", "31", "1/2"]) for s in sizes}]])
        out.append(["device", [d], {}, ["select_model", [rng.choice(["n", "p"]), rng.sample(layers, min(len(layers), rng.randint(0, 2)))], {}]])
    if layers:
        shapes = []
        for _ in range(rng.randint(1, 6)):
            x0, y0 = rng.randint(0, 100), rng.randint(0, 100)
            shapes.append({"layer": rng.choice(layers), "rect": [nm(x0), nm(y0), nm(x0 + rng.randint(1, 40)), nm(y0 + rng.randint(1, 40))],
                           "net": rng.choice("ab"), "color": rng.choice([1, 2])})
        out.append(["check", [shapes, rng.choice(["generator", "checker"])], {}, None])
        out.append(["recognize", [shapes], {}, None])
    out += [["supports", [p], {}, None] for p in profiles]
    # unit conversions and argument validation
    out += [["dbu", [rng.choice(NUMBERS)], {}, None] for _ in range(3)]
    out += [["nm", [rng.choice([3, -7, 2 ** 53, True, "3", None])], {}, None], ["snap", [rng.choice(NUMBERS), rng.choice([None, "up", "down", "nearest", "x"])], {}, None]]
    odd = lambda: json.loads(json.dumps(rng.choice(ODD + names[:3])))
    out += [["rule_value", [odd(), odd()], {}, None], ["rule_value", ["width", odd()], {"limit": odd()}, None],
            ["layer", [odd()], {}, None], ["site", [odd()], {}, None], ["via", [odd(), odd()], {}, None],
            ["device", [odd()], {}, None], ["supports", [odd()], {}, None], ["enclosure", [odd(), odd()], {}, None],
            ["rules", [], {"on": odd(), "kind": odd()}, None], ["min_spacing", [odd()], {"same_net": odd()}, None],
            ["min_spacing", [rng.choice(layers or ["X"])], {rng.choice(["scopes", "ignore"]): rng.choice([{}, {"a": 1}, [], "x", None])}, None],
            ["layers", [], {rng.choice(["role", "side"]): odd()}, None], ["vias", [], {rng.choice(["lower", "upper"]): odd()}, None]]
    bad_shapes = rng.choice([{}, {"a": 1}, "M1", None, 5, [None], [[]], [{}], [["A"]], [["A", [0, 0, 1]]]])
    out += [[rng.choice(["check", "recognize"]), [bad_shapes], {}, None]]
    uni = [n for n in names if any(ord(ch) > 127 for ch in n)]
    if len(uni) >= 2:                                 # pairs of Unicode operand names
        out.append(["min_spacing", rng.sample(uni, 2), {}, None])
    return out


@unittest.skipUnless(NODE and REFERENCE.exists(), "needs Node and tests/reference.mjs")
class ApiDifferential(unittest.TestCase):
    def run_forms(self, forms):
        reqs = [{"op": "api", "resolved": r, "incomplete": inc, "calls": calls} for r, inc, calls in forms]
        ours = [python_api(r, inc, calls) for r, inc, calls in forms]
        theirs = reference(reqs)
        self.assertEqual(len(theirs), len(ours))
        bad = []
        for i, (a, b) in enumerate(zip(ours, theirs)):
            if a["construct"] != b["construct"]:
                bad.append((i, "construct", a["construct"], b["construct"]))
                continue
            for j, (x, y) in enumerate(zip(a["results"], b["results"])):
                if x != y:
                    bad.append((i, forms[i][2][j], x, y))
        if bad:
            i, c, x, y = bad[0]
            self.fail(f"{len(bad)} answers differ; first in form #{i}, call {json.dumps(c)[:400]}\n python {json.dumps(x)[:800]}\n js     {json.dumps(y)[:800]}")

    def test_examples_answer_alike(self):
        rng = random.Random(5)
        forms = []
        for name, b in BASES.items():
            r = b["resolved"]
            for _ in range(15):
                forms.append((r, not r.get("complete", True), calls_for(rng, r)))
        self.run_forms(forms)

    def test_mutated_forms_answer_alike(self):
        rng = random.Random(77)
        forms = []
        bases = [b["resolved"] for b in BASES.values()]
        for _ in range(N_FORMS):
            base = rng.choice(bases)
            r = nested_mutate(rng, base)
            if rng.random() < 0.1:
                r["grid_nm"] = json.loads(json.dumps(rng.choice(VALUES + ["1/2", 1, None])))
            incomplete = rng.choice([True, False, False, None, 0, []])
            try:                                       # calls on the mutated form's own names, half the time
                calls = calls_for(rng, r if rng.random() < 0.5 else base)
            except Exception:                           # noqa: BLE001 - a form too broken to generate from
                calls = calls_for(rng, base)
            forms.append((r, incomplete, calls))
        self.run_forms(forms)


if __name__ == "__main__":
    unittest.main()
