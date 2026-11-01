"""Tool profiles (SPEC.md section 6.3, VOCABULARY.md section 2.12), Python port of core/profile.js.

    check_profile(resolved, profile) -> (findings, scope)
    routing_scope(resolved, sites=None) -> [conductor layer objects]

Statement-for-statement port: see _util for the JavaScript semantics it mirrors.
"""
from __future__ import annotations

import math

from ._util import (UNDEF, JSMap, includes, jget, join, jref, js, js_le, js_max, js_min, jtype, nn, same_value_zero, strict_eq,
                    truthy)
from .template import expand_site

NEG_INF = -math.inf


_Map = JSMap


def _prop(x, key):
    if x is None or x is UNDEF:
        raise TypeError(f"Cannot read properties of {js(x)} (reading '{key}')")
    return x.get(key, UNDEF) if isinstance(x, dict) else UNDEF


def _map(v, f):
    """`v.map(f)` (TypeError unless v is an array)."""
    if not isinstance(v, list):
        raise TypeError("map is not a function")
    return [f(x) for x in v]


def tracks_mode(l):
    """Effective routing mode of a conductor layer."""
    a = l["attrs"]
    if truthy(a.get("tracks_mode", UNDEF)):
        return a["tracks_mode"]
    return "required" if "pitch" in a or truthy(a.get("tracks", UNDEF)) else "none"


def _in_range(v, r):
    if jtype(r) == "number":
        return strict_eq(v, r)
    if isinstance(r, dict) and "min" in r:
        return js_le(r["min"], v) and js_le(v, r.get("max", UNDEF))
    return True


def _rng(r):
    if jtype(r) == "number":
        return js(r)
    return f"{js(jget(r, 'min'))}..{js(jget(r, 'max'))}"


# The conditions and forms a rule uses (VOCABULARY.md section 3.5-3.6), as profile feature words.
CONDITIONS = ["axis", "same_net", "same_color", "width_below", "width_above", "prl", "within", "scope"]


def rule_features(r):
    a = r["attrs"]
    out = [c for c in CONDITIONS if c in a]
    if truthy(a.get("limit", UNDEF)) and not strict_eq(a["limit"], "min"):
        out.append(f"limit_{js(a['limit'])}")
    if strict_eq(a.get("measure", UNDEF), "center"):
        out.append("measure_center")
    for c in nn(r.get("children", UNDEF), []):
        k = c.get("kind", UNDEF)
        if includes(["table", "case", "alternative"], k) and not includes(out, k):
            out.append(k)
    return out


def _scope(resolved, site_names=None):
    """(layers, in_scope, top), a cell generator routes only inside the cell:
    from the device tier up to the highest layer the site uses for pins or
    in-cell tracks. `site_names`: the sites to consider (default: every site)."""
    objects = resolved["objects"]
    layers = [o for o in objects if o.get("kind") == "layer"]
    by_name = _Map((l.get("name", UNDEF), l) for l in layers)
    sites = [o for o in objects if o.get("kind") == "site" and (site_names is None or includes(site_names, o.get("name", UNDEF)))]

    def order(name, missing):
        lo = by_name.get(name)
        return nn(lo["attrs"].get("order", UNDEF), missing) if lo else missing

    orders = []
    for site in sites:
        orders += _map(nn(site["attrs"].get("pins", UNDEF), []), lambda x: order(_prop(x, "ref"), NEG_INF))
        orders += [order(t["layer"], NEG_INF) for t in expand_site(resolved, site.get("name", UNDEF))["tracks"]]
    top = js_max(NEG_INF, *orders)
    strata = [o for o in objects if o.get("kind") == "stratum"]
    layer_refs = [_prop(x, "ref") for st in strata for x in _map(nn(st["attrs"].get("layers", UNDEF), []), lambda x: x)]
    dev_orders = []
    for ref in layer_refs:
        lo = by_name.get(ref)
        o = lo["attrs"].get("order", UNDEF) if lo else UNDEF
        if o is not UNDEF:
            dev_orders.append(o)
    bottom = js_min(*dev_orders) if dev_orders else NEG_INF
    # Device-tier layers (strata and transistor gates) are placed, not routed.
    placed_only = layer_refs + [jref(o["attrs"].get("gate", UNDEF)) for o in objects if o.get("kind") == "cross"]

    def in_scope(l):
        # Without a site to bound it, every layer is in scope except the placed-only ones.
        if any(same_value_zero(p, l.get("name", UNDEF)) for p in placed_only):
            return False
        if top == NEG_INF:
            return True
        o = l["attrs"].get("order", UNDEF)
        return js_le(bottom, o) and js_le(o, top)

    return layers, in_scope, top


def routing_scope(resolved, sites=None):
    """The conductor layers a cell generator routes on, in resolved-form order."""
    layers, in_scope, _ = _scope(resolved, sites)
    return [l for l in layers if strict_eq(l["attrs"].get("role", UNDEF), "conductor") and in_scope(l)]


def check_profile(resolved, profile):
    """Findings [{object, message}] (empty = the tool can take it), and the routing
    scope (conductor names, or None when no site gives one)."""
    p = profile["attrs"]
    out = []

    def add(obj, message):
        out.append({"object": obj, "message": message} if obj is not UNDEF else {"message": message})

    objects = resolved["objects"]
    layers, in_scope, top = _scope(resolved)
    conductors = [o for o in layers if strict_eq(o["attrs"].get("role", UNDEF), "conductor") and in_scope(o)]
    scope_names = [l.get("name", UNDEF) for l in layers if in_scope(l)]

    def in_names(n):
        return any(same_value_zero(n, x) for x in scope_names)

    scope = [l.get("name", UNDEF) for l in conductors] if top != NEG_INF else None
    g = lambda k: p.get(k, UNDEF)
    for l in conductors:
        la = l["attrs"]
        name = l.get("name", UNDEF)
        d = nn(la.get("direction", UNDEF), "none")
        mode = tracks_mode(l)
        side = la.get("side", UNDEF)
        if truthy(g("sides")) and truthy(side) and not includes(p["sides"], side):
            add(name, f"{js(side)}-side layer; the tool routes only {join(p['sides'], ', ')}")
            continue
        if truthy(g("directions")) and not includes(p["directions"], d):
            add(name, f"direction {js(d)} is not supported (supports {join(p['directions'], ', ')})")
        if truthy(g("tracks_modes")) and not includes(p["tracks_modes"], mode):
            add(name, f"tracks_mode {js(mode)} is not supported (supports {join(p['tracks_modes'], ', ')})")
        if truthy(g("needs_tracks")) and strict_eq(mode, "none"):
            add(name, "the tool needs a routing grid, but this layer is routed by shape")
        if "masks" in p and not _in_range(nn(la.get("masks", UNDEF), 1), p["masks"]):
            add(name, f"{js(la.get('masks', UNDEF))} masks is outside the supported {_rng(p['masks'])}")
    strata = len([o for o in objects if o.get("kind") == "stratum"])
    if "strata" in p and strata and not _in_range(strata, p["strata"]):
        add("stratum", f"{strata} strata; the tool supports {_rng(p['strata'])}")
    if truthy(g("rule_kinds")) or truthy(g("rule_features")):
        missing, missing_f = _Map(), _Map()

        def refs(v):
            return [r for r in (jref(x) for x in (v if isinstance(v, list) else [v])) if truthy(r)]

        conn = _Map((c.get("name", UNDEF), c) for c in objects if c.get("kind") == "connector")
        # regions and computed (from = ...) layers both depend on the layers they are computed from
        regions = _Map((x.get("name", UNDEF), x) for x in objects
                       if x.get("kind") == "region" or (x.get("kind") == "layer" and truthy(x["attrs"].get("from", UNDEF))))

        def layers_of(expr, seen):
            if not truthy(expr) or not isinstance(expr, (dict, list)):
                return []
            if isinstance(expr, list):
                return [y for x in expr for y in layers_of(x, seen)]
            if "ref" in expr:
                ref = expr["ref"]
                if regions.has(ref) and not any(same_value_zero(ref, s) for s in seen):
                    seen.append(ref)        # keep the computed name itself as well as what it is computed from
                    return [ref, *layers_of(regions.get(ref)["attrs"].get("from", UNDEF), seen)]
                return [ref]
            # arguments: a list, or an object indexed by "0", "1", ... (as the checker reads them)
            args = nn(expr.get("args", UNDEF), [])
            return layers_of(list(args.values()) if isinstance(args, dict) else args, seen)

        # a name touches the scope when it, or a layer it is computed from, is in scope
        def in_scope_via(x):
            return in_names(x) or (regions.has(x) and any(in_names(y) for y in layers_of({"ref": x}, [])))

        def touches(r):
            for n in refs(r["attrs"].get("on", UNDEF)):
                if in_scope_via(n):
                    return True
                if conn.has(n):
                    ca = conn.get(n)["attrs"]
                    if any(in_scope_via(x) for x in [*refs(ca.get("lower", UNDEF)), *refs(ca.get("cut", UNDEF)), *refs(ca.get("upper", UNDEF))]):
                        return True
            return False

        for r in objects:
            if r.get("kind") != "rule" or strict_eq(r["attrs"].get("intent", UNDEF), "checker_only") or not (top == NEG_INF or touches(r)):
                continue
            k = r["attrs"].get("kind", UNDEF)
            if truthy(g("rule_kinds")) and not includes(p["rule_kinds"], k):
                missing.set(k, [*missing.get(k, []), r.get("name", UNDEF)])
            elif truthy(g("rule_features")):
                for f in rule_features(r):
                    if not includes(p["rule_features"], f):
                        missing_f.set(f, [*missing_f.get(f, []), r.get("name", UNDEF)])

        def lst(names):
            return f"{len(names)} rule{'s' if len(names) > 1 else ''}: {join(names[:4], ', ')}{', ...' if len(names) > 4 else ''}"

        for f, names in missing_f.items:
            add(names[0], f"rule feature {js(f)} is not supported ({lst(names)})")
        for k, names in missing.items:
            add(names[0], f"rule kind {js(k)} is not supported ({lst(names)})")
    return out, scope
