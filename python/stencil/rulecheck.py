"""Reference rule checker (VOCABULARY.md section 3, normative semantics), Python port.

    check_rules(resolved, layout, mode="generator") -> {violations, unsupported, complete}
    recognize_devices(resolved, layout) -> [...]

A statement-for-statement port of core/rulecheck.js: same inputs (integer
DBU rectangles), same output (JSON-shaped dicts), same order of evaluation, so
both checkers can be compared on raw output (tests/test_differential.py).

It decides only what the semantics define on rectangles. Anything else,
non-rectangular components, regions it cannot evaluate, missing net or colour
data, end-of-line contexts, is reported as unsupported and makes the result
incomplete; it is never silently treated as passing.
"""
from __future__ import annotations

from fractions import Fraction

from ._util import UNDEF, is_int, jindex, jlength, jref, js, js_lt, nn, qstr, same_value_zero, strict_eq, to_q, truthy, utf16
from .template import _lookup, by_name as _by_name, model_selector, select_models

ZERO = Fraction(0)
# Coordinates are bounded so that every sum and difference stays an exact
# JavaScript Number; the port keeps the same bound so both decide the same inputs.
LIMIT = 2 ** 51


class _Unsupported(Exception):
    pass


def _unsupported(why):
    raise _Unsupported(why)


MIXED = object()


def _qsq2(a, b):
    return Fraction(a * a + b * b)


# ---- rectangle geometry ------------------------------------------------------------
def _gx(a, b): return max(0, a["x0"] - b["x1"], b["x0"] - a["x1"])
def _gy(a, b): return max(0, a["y0"] - b["y1"], b["y0"] - a["y1"])
def _ox(a, b): return min(a["x1"], b["x1"]) - max(a["x0"], b["x0"])
def _oy(a, b): return min(a["y1"], b["y1"]) - max(a["y0"], b["y0"])
def _overlaps(a, b): return _ox(a, b) > 0 and _oy(a, b) > 0
def _contacts(a, b): return _ox(a, b) >= 0 and _oy(a, b) >= 0
def _contains(o, i): return o["x0"] <= i["x0"] and i["x1"] <= o["x1"] and o["y0"] <= i["y0"] and i["y1"] <= o["y1"]
def _dx(r): return r["x1"] - r["x0"]
def _dy(r): return r["y1"] - r["y0"]


def _covered(rect, rects):
    """Is `rect` covered by the union of `rects`? (coordinate compression)"""
    xs = sorted({x for x in [rect["x0"], rect["x1"], *(v for r in rects for v in (r["x0"], r["x1"]))] if rect["x0"] <= x <= rect["x1"]})
    ys = sorted({y for y in [rect["y0"], rect["y1"], *(v for r in rects for v in (r["y0"], r["y1"]))] if rect["y0"] <= y <= rect["y1"]})
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            cx2, cy2 = xs[i] + xs[i + 1], ys[j] + ys[j + 1]   # doubled centre: exact
            if not any(2 * r["x0"] <= cx2 <= 2 * r["x1"] and 2 * r["y0"] <= cy2 <= 2 * r["y1"] for r in rects):
                return False
    return True


def _merge(rects):
    """Merge rectangles into components (touching or overlapping rectangles merge)."""
    parent = list(range(len(rects)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            if _contacts(rects[i], rects[j]):
                parent[find(i)] = find(j)
    groups = {}
    for i, r in enumerate(rects):
        groups.setdefault(find(i), []).append(r)
    out = []
    for rs in groups.values():
        bbox = {"x0": min(r["x0"] for r in rs), "y0": min(r["y0"] for r in rs),
                "x1": max(r["x1"] for r in rs), "y1": max(r["y1"] for r in rs)}

        def meta(key, rs=rs):
            vals = []                                   # a Set: SameValueZero
            for r in rs:
                v = r.get(key, UNDEF)
                if not any(same_value_zero(v, w) for w in vals):
                    vals.append(v)
            return vals[0] if len(vals) == 1 else MIXED

        out.append({"rects": rs, "bbox": bbox, "rectangular": _covered(bbox, rs),
                    "ids": [i for r in rs for i in r.get("ids", [])],
                    "net": meta("net"), "color": meta("color"), "connector": meta("connector")})
    return out


def _in_range(rects):
    """Derived geometry must stay inside the exact range too."""
    if any(abs(r[k]) > LIMIT for r in rects for k in ("x0", "y0", "x1", "y1")):
        _unsupported("derived geometry outside +/-2^51 DBU")
    return rects


def _prop(x, key):
    """`x.key` on a JSON value: TypeError on null / undefined, undefined when absent."""
    if x is None or x is UNDEF:
        raise TypeError(f"Cannot read properties of {js(x)} (reading '{key}')")
    return x.get(key, UNDEF) if isinstance(x, dict) else UNDEF


def _refs(v):
    """`Array.isArray(v) ? v.map((x) => x.ref) : [v?.ref]`."""
    return [_prop(x, "ref") for x in v] if isinstance(v, list) else [jref(v)]


class _Cache:
    """A Map keyed by SameValueZero (any JSON value as the key)."""

    def __init__(self):
        self.items = []

    def get(self, key, make):
        for k, v in self.items:
            if same_value_zero(k, key):
                return v
        v = make()
        self.items.append((key, v))
        return v


def _with(p, **kw):
    q = dict(p)
    q.update(kw)
    return q


# ---- layout geometry -----------------------------------------------------------------

def _geometry(resolved, layout):
    """Merged components per layer, and evaluation of regions / computed markers (section 3.2)."""
    objects = nn(resolved.get("objects", UNDEF), [])
    by_name = _by_name(objects)
    shapes = []
    for sid, s in enumerate(nn(layout.get("shapes", UNDEF), [])):
        rect = _prop(s, "rect")
        if rect is None or rect is UNDEF or not isinstance(rect, (list, str)):
            raise TypeError(f"shape {sid}: rect is not iterable")
        x0, y0, x1, y1 = (list(rect) + [UNDEF] * 4)[:4]
        if not (all(is_int(v) and abs(v) <= LIMIT for v in (x0, y0, x1, y1)) and x1 > x0 and y1 > y0):
            raise ValueError(f"shape {sid}: rect must be integer [x0, y0, x1, y1] (|v| <= 2^51) with positive size")
        sh = {"id": sid, "ids": [sid], "layer": s.get("layer", UNDEF), "x0": int(x0), "y0": int(y0), "x1": int(x1), "y1": int(y1)}
        for k in ("net", "color", "connector"):
            if k in s:
                sh[k] = s[k]
        shapes.append(sh)
    layer_comps = _Cache()

    def comps_of_layer(name):
        return layer_comps.get(name, lambda: _merge([s for s in shapes if strict_eq(s["layer"], name)]))

    def eval_operand(name, depth=0):
        o = _lookup(by_name, name)
        if not o:
            _unsupported(f"unknown operand '{js(name)}'")
        attrs = o["attrs"]
        if o["kind"] == "layer" and not truthy(attrs.get("from")):
            return comps_of_layer(name)
        if (o["kind"] == "layer" and truthy(attrs.get("from"))) or o["kind"] == "region":
            return eval_geom(attrs.get("from", UNDEF), depth + 1)
        _unsupported(f"'{js(name)}' is a {js(o['kind'])}, not a layer or region")

    def rects_of(comps):
        return [r for c in comps for r in c["rects"]]

    def eval_geom(e, depth):
        if depth > 20:
            _unsupported("region nesting too deep")
        if isinstance(e, dict) and "ref" in e:
            return eval_operand(e["ref"], depth)
        if not isinstance(e, dict) or not truthy(e.get("call", UNDEF)):
            _unsupported("unsupported region expression")
        args = nn(e.get("args", UNDEF), [])
        call = e["call"]

        def more(i):
            """`i < args.length` (an object's length is its "length" key)."""
            return js_lt(i, jlength(args))

        def sub(i):
            return eval_geom(jindex(args, i), depth + 1)

        # Region operations are regularized: results of zero area (shared edges,
        # points) are dropped. Results keep the first operand's provenance.
        if call == "intersect":
            acc = rects_of(sub(0))
            i = 1
            while more(i):
                b = rects_of(sub(i))
                acc = [_with(p, x0=max(p["x0"], q["x0"]), y0=max(p["y0"], q["y0"]), x1=min(p["x1"], q["x1"]), y1=min(p["y1"], q["y1"]))
                       for p in acc for q in b if _overlaps(p, q)]
                i += 1
            return _merge(acc)
        if call in ("grow", "shrink"):
            d = to_q(jindex(args, 1))
            if d is None or d.denominator != 1 or d < 0:
                _unsupported(f"{call} by a negative or non-integer distance")
            k = int(d)
            if k > LIMIT:
                _unsupported(f"{call} distance too large")
            # grow distributes over the figures; shrink works on whole components
            if call == "grow":
                return _merge(_in_range([_with(r, x0=r["x0"] - k, y0=r["y0"] - k, x1=r["x1"] + k, y1=r["y1"] + k) for r in rects_of(sub(0))]))
            out = []
            for c in sub(0):
                if not c["rectangular"]:
                    _unsupported("shrink of a non-rectangular component")
                b = c["bbox"]
                # the component's own (possibly mixed) metadata, not one figure's
                r = {"ids": c["ids"], "x0": b["x0"] + k, "y0": b["y0"] + k, "x1": b["x1"] - k, "y1": b["y1"] - k}
                for key in ("net", "color", "connector"):
                    if c[key] is not UNDEF:
                        r[key] = c[key]
                if r["x1"] > r["x0"] and r["y1"] > r["y0"]:
                    out.append(r)
            return _merge(out)
        if call in ("touching", "avoiding"):
            a, b = sub(0), rects_of(sub(1))
            want = call == "touching"
            return [c for c in a if any(_contacts(r, q) for r in c["rects"] for q in b) == want]
        if call == "union":
            if not isinstance(args, list):
                raise TypeError("args.flatMap is not a function")
            return _merge([r for i in range(len(args)) for r in rects_of(sub(i))])
        if call == "minus":
            # closure of A \ B: each figure minus each cutter, as up to four rectangles
            acc = rects_of(sub(0))
            i = 0
            while more(i := i + 1):
                for q in rects_of(sub(i)):
                    nxt = []
                    for p in acc:
                        if not _overlaps(p, q):
                            nxt.append(p)
                            continue
                        if q["y1"] < p["y1"]: nxt.append(_with(p, y0=q["y1"]))                       # above
                        if q["y0"] > p["y0"]: nxt.append(_with(p, y1=q["y0"]))                       # below
                        y0, y1 = max(p["y0"], q["y0"]), min(p["y1"], q["y1"])
                        if q["x0"] > p["x0"]: nxt.append(_with(p, y0=y0, y1=y1, x1=q["x0"]))         # left
                        if q["x1"] < p["x1"]: nxt.append(_with(p, y0=y0, y1=y1, x0=q["x1"]))         # right
                    acc = nxt
            return _merge(acc)
        _unsupported(f"region function {js(call)}() needs a placed cell template")

    return by_name, comps_of_layer, eval_operand, eval_geom


# ---- the checker ---------------------------------------------------------------------

def check_rules(resolved, layout, mode=None):
    mode = nn(UNDEF if mode is None else mode, "generator")
    objects = nn(resolved.get("objects", UNDEF), [])
    by_name = _by_name(objects)
    violations = []
    unsupported_list = []
    _, comps_of_layer, eval_operand, _ = _geometry(resolved, layout)

    for rule in (o for o in objects if o.get("kind") == "rule"):
        a = rule["attrs"]
        if strict_eq(mode, "generator") and strict_eq(a.get("intent", UNDEF), "checker_only"):
            continue
        try:
            _check_rule(rule, by_name, comps_of_layer, eval_operand, violations)
        except _Unsupported as e:
            u = {"rule": rule.get("name", UNDEF), "kind": a.get("kind", UNDEF), "reason": str(e)}
            unsupported_list.append({k: v for k, v in u.items() if v is not UNDEF})
    return {"violations": violations, "unsupported": unsupported_list, "complete": not unsupported_list}


def _check_rule(rule, by_name, comps_of_layer, eval_operand, violations):
    a = rule["attrs"]
    kind = a.get("kind", UNDEF)
    if rule.get("invalid", UNDEF) is True or any(c.get("invalid", UNDEF) is True for c in nn(rule.get("children", UNDEF), [])):
        _unsupported("the resolver reported errors on this rule")
    if not isinstance(kind, str) or kind.startswith("x_"):
        _unsupported(f"extension kind {js(kind)}")
    limit = nn(a.get("limit", UNDEF), "min")
    children = nn(rule.get("children", UNDEF), [])
    if any(c.get("kind") == "case" for c in children):
        _unsupported("case contexts (via_end / open_end) need per-end connection data")
    table = next((c for c in children if c.get("kind") == "table"), None)
    alts = [c for c in children if c.get("kind") == "alternative"]
    value = to_q(a["value"]) if "value" in a else None

    def has(k):
        return k in a

    def pass_(q, t):
        c = (q > t) - (q < t)
        return c >= 0 if strict_eq(limit, "min") else c <= 0 if strict_eq(limit, "max") else c == 0

    def pass_sq(sq, t):   # Euclidean: compare squares
        if t < 0:
            _unsupported("a negative distance threshold")
        return pass_(sq, t * t)

    def report(subjects, measured, threshold, detail=None):
        v = {"rule": rule.get("name", UNDEF), "kind": kind, "subjects": [i for c in subjects for i in nn(c.get("ids", UNDEF), [])], "measured": measured}
        if threshold is not None:
            v["threshold"] = qstr(threshold)
        v["limit"] = limit
        if detail:
            v["detail"] = detail
        violations.append({k: x for k, x in v.items() if x is not UNDEF})

    def rect(c):
        if not c["rectangular"]:
            _unsupported("a non-rectangular component")
        return c["bbox"]

    scope = [r for c in eval_operand(jref(a["scope"])) for r in c["rects"]] if truthy(a.get("scope", UNDEF)) else None

    def in_scope(c):
        return scope is None or any(_contacts(r, s) for r in c["rects"] for s in scope)

    # Operands
    on = a.get("on", UNDEF)
    on_refs = _refs(on)
    conn = None
    if not isinstance(on, list):
        o = _lookup(by_name, jref(on))
        if o and o.get("kind") == "connector":
            conn = o

    def cut_comps(c):
        cut_layer = jref(c["attrs"].get("cut", UNDEF))
        if not truthy(cut_layer):
            _unsupported(f"connector {js(c.get('name', UNDEF))} has no cut layer")
        comps = eval_operand(cut_layer)                    # a computed cut layer is evaluated, keeping provenance
        if any(x["connector"] is MIXED or x["connector"] is UNDEF for x in comps):
            _unsupported(f"cuts on {js(cut_layer)} without a connector name")
        return [x for x in comps if strict_eq(x["connector"], c.get("name", UNDEF))]

    op_cache = _Cache()

    def operand(i):
        n = on_refs[i] if i < len(on_refs) else UNDEF
        return op_cache.get(n, lambda: eval_operand(n))

    # Pair conditions
    def meta(c, key):
        if c[key] is UNDEF or c[key] is MIXED:
            _unsupported(f"{'net' if key == 'net' else 'mask colour'} data needed by {'same_net' if key == 'net' else 'same_color'}")
        return c[key]

    def pair_ok(c1, c2, r1, r2, widths=True):
        if has("same_net") and not strict_eq(strict_eq(meta(c1, "net"), meta(c2, "net")), a["same_net"]):
            return False
        if has("same_color") and not strict_eq(strict_eq(meta(c1, "color"), meta(c2, "color")), a["same_color"]):
            return False
        if widths and (has("width_below") or has("width_above")):
            w = Fraction(max(min(_dx(r1), _dy(r1)), min(_dx(r2), _dy(r2))))
            if has("width_below") and not (w < to_q(a["width_below"])):
                return False
            if has("width_above") and not (w > to_q(a["width_above"])):
                return False
        return True

    def prl_of(r1, r2):
        if strict_eq(a.get("axis", UNDEF), "x"):
            return max(0, _oy(r1, r2))
        if strict_eq(a.get("axis", UNDEF), "y"):
            return max(0, _ox(r1, r2))
        if _overlaps(r1, r2):
            return 0
        if _gx(r1, r2) > 0 and _gy(r1, r2) == 0:
            return max(0, _oy(r1, r2))
        if _gy(r1, r2) > 0 and _gx(r1, r2) == 0:
            return max(0, _ox(r1, r2))
        return 0

    def pairs(A, B):
        out = []
        if B is A:
            for i in range(len(A)):
                for j in range(i + 1, len(A)):
                    out.append((A[i], A[j]))
        else:
            out = [(p, q) for p in A for q in B if p is not q]
        # one operand: both are subjects, so the pair counts when either is in scope
        return [(p, q) for p, q in out if in_scope(p) or (B is A and in_scope(q))]

    def table_lookup(w, prl):
        def idx(key):
            v = nn(table["attrs"].get(key, UNDEF), [0])
            if not isinstance(v, list):
                raise TypeError(f"{key}.map is not a function")
            return [to_q(x) for x in v]

        rows, cols = idx("width"), idx("prl")

        def pick(bps, x):
            k = 0
            for i, b in enumerate(bps):
                if b <= x:
                    k = i
            return k

        return to_q(jindex(jindex(table["attrs"].get("values", UNDEF), pick(rows, Fraction(w))), pick(cols, Fraction(prl))))

    if kind in ("width", "length", "min_length", "area"):
        for c in [c for c in operand(0) if in_scope(c)]:
            r = rect(c)
            if kind == "area":
                q = Fraction(_dx(r) * _dy(r))
            elif strict_eq(a.get("axis", UNDEF), "x"):
                q = Fraction(_dx(r))
            elif strict_eq(a.get("axis", UNDEF), "y"):
                q = Fraction(_dy(r))
            else:
                q = Fraction(min(_dx(r), _dy(r)) if kind == "width" else max(_dx(r), _dy(r)))
            if not pass_(q, value):
                report([c], qstr(q), value)
        return

    if kind in ("spacing", "cut_spacing", "corner_spacing"):
        if conn:
            if kind != "cut_spacing":
                _unsupported("only cut_spacing applies to a connector")
            A = B = cut_comps(conn)
        else:
            A = operand(0)
            B = operand(1) if len(on_refs) > 1 else A
        axis = a.get("axis", UNDEF)
        for c1, c2 in pairs(A, B):
            r1, r2 = rect(c1), rect(c2)
            if not pair_ok(c1, c2, r1, r2):
                continue
            if kind == "spacing" and has("prl") and Fraction(prl_of(r1, r2)) < to_q(a["prl"]):
                continue
            if kind == "corner_spacing":
                if not (_gx(r1, r2) > 0 and _gy(r1, r2) > 0):
                    continue                                       # corner pairs only (diagonal)
                sq = _qsq2(_gx(r1, r2), _gy(r1, r2))
                if not pass_sq(sq, value):
                    report([c1, c2], f"sqrt({qstr(sq)})", value)
                continue
            if _overlaps(r1, r2):
                report([c1, c2], "overlap", None)
                continue
            t = table_lookup(max(min(_dx(r1), _dy(r1)), min(_dx(r2), _dy(r2))), prl_of(r1, r2)) if table else value
            if kind == "cut_spacing" and strict_eq(a.get("measure", UNDEF), "center"):
                # doubled centre coordinates keep the arithmetic in integers
                cx = abs((r1["x0"] + r1["x1"]) - (r2["x0"] + r2["x1"]))
                cy = abs((r1["y0"] + r1["y1"]) - (r2["y0"] + r2["y1"]))
                ax, ay = strict_eq(axis, "x"), strict_eq(axis, "y")
                if ax and _oy(r1, r2) < 0:
                    continue
                if ay and _ox(r1, r2) < 0:
                    continue
                if t < 0:
                    _unsupported("a negative distance threshold")
                t2 = t * 2
                if ax:
                    ok = pass_(Fraction(cx), t2)
                elif ay:
                    ok = pass_(Fraction(cy), t2)
                else:
                    ok = pass_(_qsq2(cx, cy), t2 * t2)
                if not ok:
                    m = qstr(Fraction(cx if ax else cy, 2)) if truthy(axis) else f"sqrt({qstr(_qsq2(cx, cy) / 4)})"
                    report([c1, c2], f"centre distance {m}", t)
                continue
            if strict_eq(axis, "x"):
                if _oy(r1, r2) < 0:
                    continue
                if not pass_(Fraction(_gx(r1, r2)), t):
                    report([c1, c2], f"{_gx(r1, r2)}", t)
                continue
            if strict_eq(axis, "y"):
                if _ox(r1, r2) < 0:
                    continue
                if not pass_(Fraction(_gy(r1, r2)), t):
                    report([c1, c2], f"{_gy(r1, r2)}", t)
                continue
            sq = _qsq2(_gx(r1, r2), _gy(r1, r2))
            if not pass_sq(sq, t):
                report([c1, c2], f"sqrt({qstr(sq)})", t)
        return

    if kind == "eol_spacing":
        comps = operand(0)
        within = to_q(a["within"]) if has("within") else ZERO   # None fails at the comparison, as in JavaScript
        for s in [c for c in comps if in_scope(c)]:
            S = rect(s)
            axis = a.get("axis", UNDEF)
            if axis is UNDEF or axis is None:
                axis = "x" if _dx(S) > _dy(S) else "y" if _dy(S) > _dx(S) else _unsupported("a square end-of-line subject needs axis")
            end_width = Fraction(_dy(S) if strict_eq(axis, "x") else _dx(S))
            if has("width_below") and not (end_width < to_q(a["width_below"])):
                continue
            if has("width_above") and not (end_width > to_q(a["width_above"])):
                continue
            for t in comps:
                if t is s:
                    continue
                T = rect(t)
                if not pair_ok(s, t, S, T, False):              # eol width conditions are on the end, above
                    continue
                if _overlaps(S, T):
                    report([s, t], "overlap", value)
                    continue
                trans = _gy(S, T) if strict_eq(axis, "x") else _gx(S, T)
                if Fraction(trans) > within:
                    continue
                if strict_eq(axis, "x"):
                    ends = [(T["x1"] > S["x1"], max(0, T["x0"] - S["x1"])), (T["x0"] < S["x0"], max(0, S["x0"] - T["x1"]))]
                else:
                    ends = [(T["y1"] > S["y1"], max(0, T["y0"] - S["y1"])), (T["y0"] < S["y0"], max(0, S["y0"] - T["y1"]))]
                for selected, gap in ends:
                    if selected and not pass_(Fraction(gap), value):
                        report([s, t], f"{gap}", value)
        return

    if kind == "enclosure":
        if conn:
            lowers = _refs(conn["attrs"].get("lower", UNDEF))
            cuts = cut_comps(conn)
            # computed endpoint layers are evaluated like any operand (an absent one holds nothing)
            def layer_comps(n):
                return [] if n is UNDEF or n is None else eval_operand(n)

            obligations = [(cuts, [c for l in lowers for c in layer_comps(l)]), (cuts, layer_comps(jref(conn["attrs"].get("upper", UNDEF))))]
        else:
            obligations = [(operand(0), operand(1))]
        for inner, outer in obligations:
            for ic in [c for c in inner if in_scope(c)]:
                I = rect(ic)
                holders = [oc for oc in outer if oc["rectangular"] and _contains(oc["bbox"], I)]
                if any(not oc["rectangular"] and any(_contacts(r, I) for r in oc["rects"]) for oc in outer):
                    _unsupported("enclosure by a non-rectangular component")
                if not holders:
                    report([ic], "not enclosed", value)
                    continue

                def holds(oc):
                    O = oc["bbox"]
                    w = Fraction(min(_dx(O), _dy(O)))
                    if has("width_below") and not (w < to_q(a["width_below"])):
                        return True                                 # rule does not apply to this outer
                    if has("width_above") and not (w > to_q(a["width_above"])):
                        return True
                    m = [Fraction(x) for x in (I["x0"] - O["x0"], O["x1"] - I["x1"], I["y0"] - O["y0"], O["y1"] - I["y1"])]
                    if alts:
                        def margins(alt):
                            v = alt["attrs"].get("margins", UNDEF)
                            if not isinstance(v, list):
                                raise TypeError("margins.every is not a function")
                            return v
                        return any(all(pass_(m[k], to_q(t)) for k, t in enumerate(margins(alt))) for alt in alts)
                    ax = a.get("axis", UNDEF)
                    idx = [0, 1] if strict_eq(ax, "x") else [2, 3] if strict_eq(ax, "y") else [0, 1, 2, 3]
                    return all(pass_(m[k], value) for k in idx)

                if not any(holds(oc) for oc in holders):
                    report([ic], "margins", value, "no alternative holds" if alts else None)
        return

    if kind == "extension":
        if not truthy(a.get("axis", UNDEF)):
            _unsupported("extension without axis")
        for ec, bc in pairs(operand(0), operand(1)):
            E, B = rect(ec), rect(bc)
            if not _overlaps(E, B):
                continue
            m = [B["x0"] - E["x0"], E["x1"] - B["x1"]] if strict_eq(a["axis"], "x") else [B["y0"] - E["y0"], E["y1"] - B["y1"]]
            if not all(pass_(Fraction(x), value) for x in m):
                report([ec, bc], f"{min(m)}", value)
        return

    if kind in ("inside", "interacting", "not_interacting", "not_overlapping"):
        S = [c for c in operand(0) if in_scope(c)]
        T = [r for c in operand(1) for r in c["rects"]]
        # per merged subject component
        for c in S:
            def touch(f, c=c):
                return any(f(r, t) for r in c["rects"] for t in T)
            if kind == "inside":
                bad = not all(_covered(r, T) for r in c["rects"])
            elif kind == "interacting":
                bad = not touch(_contacts)
            elif kind == "not_interacting":
                bad = touch(_contacts)
            else:
                bad = touch(_overlaps)
            if bad:
                report([c], kind, None)
        return

    _unsupported(f"unknown rule kind {kind}")


# ---- device recognition --------------------------------------------------------------

def recognize_devices(resolved, layout):
    """Device recognition (VOCABULARY.md section 2, cross / model); see core/rulecheck.js."""
    by_name, comps_of_layer, eval_operand, eval_geom = _geometry(resolved, layout)
    out = []
    def entry(**kw):
        return {k: v for k, v in kw.items() if v is not UNDEF}

    for cross in (o for o in nn(resolved.get("objects", UNDEF), []) if o.get("kind") == "cross"):
        a = cross["attrs"]
        name = cross.get("name", UNDEF)
        expr = a.get("recognize", UNDEF)
        if not truthy(expr):
            ch = _lookup(by_name, jref(a.get("channel", UNDEF)))
            if ch and ch.get("kind") == "array":
                ch = _lookup(by_name, jref(ch["attrs"].get("of", UNDEF)))
            ch_layer = jref(ch["attrs"].get("layer", UNDEF)) if ch else UNDEF
            if not truthy(jref(a.get("gate", UNDEF))) or not truthy(ch_layer):
                out.append(entry(cross=name, unsupported="no gate or channel layer"))
                continue
            expr = {"call": "intersect", "args": [a["gate"], {"ref": ch_layer}]}
        try:
            comps = eval_geom(expr, 1)
        except _Unsupported as e:
            out.append(entry(cross=name, unsupported=str(e)))
            continue
        models = [model_selector(c) for c in nn(cross.get("children", UNDEF), []) if c.get("kind") == "model"]
        marker_names = list(dict.fromkeys(x for m in models for x in (*m["markers"], *m["exclude"])))
        # markers may be computed (from = ...): evaluate them like any operand
        marker_rects = {}
        try:
            for mk in marker_names:
                marker_rects[mk] = [r for x in eval_operand(mk) for r in x["rects"]]
        except _Unsupported as e:
            out.append(entry(cross=name, unsupported=f"marker: {e}"))
            continue
        for c in comps:
            covering, touching = [], []
            for mk in marker_names:
                rs = marker_rects[mk]
                if any(_overlaps(r, q) for r in c["rects"] for q in rs):
                    touching.append(mk)
                if all(_covered(r, rs) for r in c["rects"]):
                    covering.append(mk)
            by_pol, selection = {}, {}
            for pol in ("n", "p"):
                by_pol[pol] = [m["name"] for m in select_models(cross, set(covering), set(touching), pol)]
                selection[pol] = "ok" if len(by_pol[pol]) == 1 else "ambiguous" if by_pol[pol] else "none"
            partial = [x for x in touching if x not in covering]
            out.append(entry(cross=name, bbox=dict(c["bbox"]), markers=sorted(covering, key=lambda m: utf16(js(m))), partial=partial,
                             models=by_pol, selection=selection))
    return out
