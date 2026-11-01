"""Cell-template expansion (VOCABULARY.md section 2, site v2), Python port of core/template.js.

    expand_site(resolved, name, units=1) -> {name, width, height, bands, rails, tracks, edges, problems, cellWidth}

All coordinates are integer DBU, in the site's frame (origin bottom-left).
The output has the same JSON shape as expandSite(), so the two can be
compared directly. Statement-for-statement port: see _util for the
JavaScript semantics it mirrors.
"""
from __future__ import annotations

import math

from ._util import (UNDEF, JSMap, bigint, includes, is_int, is_num, is_ref, jget, join, jref, js, list_of, nn, strict_eq,
                    truthy)

POLS = ["n", "p"]
# Track enumeration is bounded; more in-cell tracks than this is a mistake.
MAX_TRACKS = 100000
# Inputs are bounded so that every sum the expansion forms stays an exact Number.
BOUND = 2 ** 50


def _too_big(*vs):
    return any(is_num(v) and abs(v) > BOUND for v in vs)


def _lookup(by, key):
    """`Map.get` (any key; SameValueZero)."""
    return by.get(key)


def by_name(objects):
    """`new Map(objects.filter((o) => o.name).map((o) => [o.name, o]))`."""
    return JSMap((o["name"], o) for o in objects if truthy(o.get("name", UNDEF)))


def polarities_of(st):
    v = list_of(jget(jget(st, "attrs"), "polarity"), lambda x: includes(POLS, x))
    return v if v is not None else POLS


def _width_values(v):
    """The possible values of a resolved width: [] when unset, None when not a length."""
    if v is UNDEF:
        return []
    if is_num(v):
        return [v]
    if isinstance(v, dict) and isinstance(v.get("one_of"), list) and all(is_num(x) for x in v["one_of"]):
        return v["one_of"]
    if isinstance(v, dict) and is_num(v.get("min", UNDEF)) and is_num(v.get("max", UNDEF)):
        return [v["min"], v["max"]]
    return None


def _is_span(v):
    return isinstance(v, dict) and is_num(v.get("min", UNDEF)) and is_num(v.get("max", UNDEF))


def _clean(d):
    """Drop UNDEF values (JSON.stringify drops undefined)."""
    return {k: v for k, v in d.items() if v is not UNDEF}


def _half(w):
    return w // 2 if type(w) is int else w / 2


def expand_site(resolved, name, units=None):
    by = by_name(nn(resolved.get("objects", UNDEF), []))
    site = _lookup(by, name)
    problems = []
    sa = site["attrs"] if site else {}
    out = {"name": name, "width": sa.get("width", UNDEF), "height": sa.get("height", UNDEF),
           "bands": [], "rails": [], "tracks": [], "edges": [], "problems": problems}
    if not site or site["kind"] != "site" or not is_num(out["width"]) or not is_num(out["height"]):
        return _clean(out)
    units = nn(UNDEF if units is None else units, 1)
    W = out["width"] * units
    if type(W) is not int or abs(W) > 2 ** 53:              # a Number product: binary64 rounding
        try:
            W = float(out["width"]) * float(units)
        except OverflowError:                             # beyond any double: Infinity, as in JavaScript
            W = math.inf if (out["width"] > 0) == (units > 0) else -math.inf

    def prob(code, path, message):
        problems.append({"code": code, "path": path, "message": message})

    if _too_big(W, out["height"]) or not is_num(W):
        prob("V040", name, f"site {js(name)}: a cell {js(W)} x {js(out['height'])} DBU is beyond the exact range (+/-2^50)")
        return _clean(out)
    out["cellWidth"] = W

    def place(s, frame):
        H = s["attrs"]["height"]

        def ty(y):
            return frame["y"] + H - y if frame["flip"] else frame["y"] + y

        def tr(lo, hi):
            a, b = ty(lo), ty(hi)
            return [a, b] if a <= b else [b, a]

        for c in nn(s.get("children", UNDEF), []):
            path = f"{frame['prefix']}{js(c.get('name', UNDEF))}"
            a = c["attrs"]
            kind = c.get("kind", UNDEF)
            if kind == "band":
                pol = a.get("polarity", UNDEF)
                cname = c.get("name", UNDEF)
                polarity = pol if includes(POLS, pol) else (cname if strict_eq(cname, "n") or strict_eq(cname, "p") else UNDEF)
                if not truthy(polarity):
                    prob("V004", path, f"band {path} needs a polarity (its name is not n or p)")
                    continue
                y = a.get("y", UNDEF)
                if not truthy(y) or not _is_span(y):
                    continue
                if _too_big(y["min"], y["max"]):
                    prob("V040", path, f"band {path}: coordinates beyond +/-2^50 DBU")
                    continue
                if y["min"] < 0 or y["max"] > H or y["min"] >= y["max"]:
                    prob("V013", path, f"band {path} spans {js(y['min'])}..{js(y['max'])}, outside its row 0..{js(H)}")
                stratum = jref(a.get("stratum", UNDEF))
                pols = polarities_of(_lookup(by, stratum))
                if truthy(stratum) and not includes(pols, polarity):
                    prob("V013", path, f"band {path} is {js(polarity)}, but stratum {js(stratum)} has polarities {join(pols, ', ')}")
                y0, y1 = tr(y["min"], y["max"])
                out["bands"].append(_clean({"name": path, "src": c.get("src", UNDEF), "polarity": polarity, "stratum": stratum,
                                            "y0": y0, "y1": y1, "flipped": frame["flip"]}))
            elif kind == "rail":
                has_edge, has_y = "edge" in a, "y" in a
                if has_edge == has_y:
                    if has_edge:
                        prob("V040", path, f"rail {path} has both edge and y; give one")
                    else:
                        prob("V004", path, f"rail {path} needs edge or y")
                    continue
                local = (0 if strict_eq(a["edge"], "bottom") else H) if has_edge else a["y"]
                if not is_num(local):
                    continue
                if local < 0 or local > H:
                    prob("V040", path, f"rail {path} at y = {js(local)} is outside its row 0..{js(H)}")
                layer = jref(a.get("layer", UNDEF))
                # A width may be a choice or a range (sized later): every possible value
                # must be positive, and collisions use the largest, so none can hide.
                lo = _lookup(by, layer)
                ws = _width_values(nn(a.get("width", UNDEF), lo["attrs"].get("width", UNDEF) if lo else UNDEF))
                if ws is None:
                    prob("V040", path, f"rail {path}: its width is not a length")
                    continue
                if any(w <= 0 for w in ws):
                    prob("V040", path, f"rail {path}: width {js(min(ws))} must be positive")
                    continue
                if _too_big(local, *ws):
                    prob("V040", path, f"rail {path}: coordinates beyond +/-2^50 DBU")
                    continue
                width = max(ws) if ws else UNDEF
                out["rails"].append(_clean({"name": path, "src": c.get("src", UNDEF), "net": nn(a.get("net", UNDEF), c.get("name", UNDEF)),
                                            "layer": layer, "y": ty(local), "width": width if is_num(width) else UNDEF}))
            elif kind == "tracks":
                layer_name = nn(jref(a.get("layer", UNDEF)), c.get("name", UNDEF))
                layer = _lookup(by, layer_name)
                if not layer or layer.get("kind") != "layer":
                    continue                                          # reported by the resolver (C021 / V003)
                la = layer["attrs"]
                d = la.get("direction", UNDEF)
                if not (strict_eq(d, "horizontal") or strict_eq(d, "vertical")):
                    prob("V040", path, f"tracks {path}: layer {js(layer_name)} has no horizontal or vertical direction")
                    continue
                at = a.get("at", UNDEF)
                if truthy(at) and ("pitch" in a or "offset" in a):
                    prob("V040", path, f"tracks {path}: give at, or pitch/offset, not both")
                    continue
                axis = "y" if d == "horizontal" else "x"
                extent = H if axis == "y" else W
                if at is not UNDEF and list_of(at, is_num) is None:
                    continue                                          # reported by the resolver (V003)
                if truthy(at) and _too_big(*at):
                    prob("V040", path, f"tracks {path}: coordinates beyond +/-2^50 DBU")
                    continue
                if truthy(at):
                    local = at
                else:
                    # the layer's lattice (its pitch / offset, or its track array) unless a local pitch is given
                    arr = _lookup(by, jref(la.get("tracks", UNDEF)))
                    lat = arr["attrs"] if arr and arr.get("kind") == "array" else la
                    pitch = nn(a.get("pitch", UNDEF), lat.get("pitch", UNDEF))
                    offset = nn(a.get("offset", UNDEF), nn(lat.get("offset", UNDEF), 0) if "pitch" not in a else 0)
                    if not is_num(pitch) or pitch <= 0:
                        prob("V040", path, f"tracks {path}: no pitch (set pitch, or a pitch on {js(layer_name)})")
                        continue
                    if not is_num(offset):
                        continue                                      # reported by the resolver (V003)
                    if _too_big(pitch, offset):
                        prob("V040", path, f"tracks {path}: coordinates beyond +/-2^50 DBU")
                        continue
                    if offset < 0 or offset > extent:
                        prob("V040", path, f"tracks {path}: offset {js(offset)} lies outside 0..{js(extent)}")
                        continue
                    # both ends of the lattice count
                    q = (extent - offset) / pitch                  # Math.floor(Infinity) is Infinity
                    if (math.floor(q) if math.isfinite(q) else q) + 1 > MAX_TRACKS:
                        prob("V040", path, f"tracks {path}: more than {MAX_TRACKS} tracks in one row")
                        continue
                    local = []
                    k, p = 0, offset
                    while p <= extent:
                        local.append(p)
                        k += 1
                        p = offset + k * pitch
                if any(not is_num(p) or p < 0 or p > extent for p in local):
                    prob("V040", path, f"tracks {path}: a position lies outside 0..{js(extent)}")
                all_idx = list(range(len(local)))
                use = all_idx
                if "use" in a:
                    u = a["use"]
                    is_range = _is_span(u)
                    if list_of(u, is_int) is None and not is_range:
                        continue                                      # reported by the resolver (V003)
                    use = u if isinstance(u, list) else [i for i in all_idx if i >= u["min"] and i <= u["max"]]
                    bad = [i for i in (u if isinstance(u, list) else [u["min"], u["max"]]) if not (i >= 0 and i < len(local))]
                    if bad:
                        prob("V040", path, f"tracks {path}: index {js(bad[0])} does not exist (tracks 0..{len(local) - 1})")
                # span: the row the grid belongs to (vertical tracks run only across it)
                out["tracks"].append(_clean({"name": path, "src": c.get("src", UNDEF), "layer": layer_name, "axis": axis,
                                             "positions": [ty(p) for p in local] if axis == "y" else list(local), "use": use, "span": tr(0, H)}))
            elif kind == "edge_feature":
                w = a.get("width", UNDEF)
                if not is_num(w):
                    continue
                shared = nn(a.get("shared", UNDEF), True)
                ext = nn(a.get("extend", UNDEF), 0)
                at = nn(a.get("at", UNDEF), "both")
                sides = ["left", "right"] if strict_eq(at, "both") else at if isinstance(at, list) else [at]
                y = a.get("y", UNDEF)
                if not is_num(ext) or ("y" in a and not (truthy(y) and _is_span(y))):
                    continue                                          # reported by the resolver (V003)
                if w <= 0:
                    prob("V040", path, f"edge feature {path}: width must be positive")
                    continue
                if _too_big(w, ext, *((y["min"], y["max"]) if y is not UNDEF else ())):
                    prob("V040", path, f"edge feature {path}: coordinates beyond +/-2^50 DBU")
                    continue
                if not (ext >= 0):
                    prob("V040", path, f"edge feature {path}: extend must not be negative")
                    continue
                if truthy(y) and (y["min"] < 0 or y["max"] > H or y["min"] >= y["max"]):
                    prob("V040", path, f"edge feature {path}: y spans {js(y['min'])}..{js(y['max'])}, outside its row 0..{js(H)}")
                    continue
                lr = lambda sd: strict_eq(sd, "left") or strict_eq(sd, "right")
                if not truthy(shared) and any(w > (W if lr(sd) else H) for sd in sides):
                    prob("V040", path, f"edge feature {path}: an unshared feature {js(w)} wide does not fit inside the cell")
                    continue
                if truthy(shared) and truthy(math.fmod(w, 2)):
                    prob("V040", path, f"edge feature {path}: a shared feature needs an even width in grid units (it is split between two cells)")
                    continue

                def across(edge, lo, hi):
                    if truthy(shared):
                        return [edge - _half(w), edge + _half(w)]
                    return [lo, lo + w] if edge == lo else [hi - w, hi]

                layer = jref(a.get("layer", UNDEF))
                for side in sides:
                    if lr(side):
                        y0, y1 = tr(y["min"] - ext, y["max"] + ext) if truthy(y) else tr(-ext, H + ext)
                        x0, x1 = across(0 if strict_eq(side, "left") else W, 0, W)
                        out["edges"].append(_clean({"name": path, "src": c.get("src", UNDEF), "layer": layer, "side": side,
                                                    "shared": shared, "x0": x0, "y0": y0, "x1": x1, "y1": y1}))
                    else:
                        y0, y1 = tr(*across(0 if strict_eq(side, "bottom") else H, 0, H))
                        sd = ("bottom" if strict_eq(side, "top") else "top") if frame["flip"] else side
                        out["edges"].append(_clean({"name": path, "src": c.get("src", UNDEF), "layer": layer, "side": sd,
                                                    "shared": shared, "x0": -ext, "y0": y0, "x1": W + ext, "y1": y1}))
            elif kind == "row":
                if truthy(frame["prefix"]):
                    continue                                          # one level only (reported below)
                sub = _lookup(by, jref(a.get("site", UNDEF)))
                if not sub or sub.get("kind") != "site":
                    continue
                if sub is s:
                    prob("V040", path, f"row {path} uses its own site")
                    continue
                if any(x.get("kind") == "row" for x in nn(sub.get("children", UNDEF), [])):
                    prob("V040", path, f"row {path}: site {js(sub.get('name', UNDEF))} has rows itself; rows nest one level")
                    continue
                sw, sh = sub["attrs"].get("width", UNDEF), sub["attrs"].get("height", UNDEF)
                if not strict_eq(sw, out["width"]):
                    prob("V040", path, f"row {path}: site {js(sub.get('name', UNDEF))} is {js(sw)} wide, this site {js(out['width'])}")
                yv = nn(a.get("y", UNDEF), 0)
                if not is_num(sh) or not is_num(sw) or not is_num(yv):
                    continue                                          # reported by the resolver (V003 / V004)
                if _too_big(yv, sh):
                    prob("V040", path, f"row {path}: coordinates beyond +/-2^50 DBU")
                    continue
                if yv < 0 or bigint(yv) + bigint(sh) > bigint(H):
                    prob("V040", path, f"row {path} spans {js(yv)}..{js(yv + sh)}, outside 0..{js(H)}")
                place(sub, {"y": yv, "flip": a.get("flip", UNDEF) is True, "prefix": f"{js(c.get('name', UNDEF))}."})

    place(site, {"y": 0, "flip": False, "prefix": ""})

    # Bands of one stratum must not overlap; bands of different strata may.
    bands = out["bands"]
    for i in range(len(bands)):
        for j in range(i + 1, len(bands)):
            A, B = bands[i], bands[j]
            if strict_eq(A.get("stratum", UNDEF), B.get("stratum", UNDEF)) and min(A["y1"], B["y1"]) > max(A["y0"], B["y0"]):
                prob("V013", B["name"], f"bands {A['name']} and {B['name']} overlap in stratum {js(A.get('stratum', UNDEF))}")
    # Rails: rails of one net on one layer at one height are one shared rail (the
    # widest, which covers the others: they share the centreline). Then rails of
    # different nets on one layer must not overlap. A rail of unknown width counts as a line.
    g = lambda d, k: d.get(k, UNDEF)
    rails = []
    for r in out["rails"]:
        same = next((x for x in rails if strict_eq(g(x, "layer"), g(r, "layer")) and strict_eq(x["y"], r["y"]) and strict_eq(g(x, "net"), g(r, "net"))), None)
        if not same:
            rails.append(dict(r))
            continue
        same["shared"] = [*nn(same.get("shared", UNDEF), [same["name"]]), r["name"]]
        if "width" in r and ("width" not in same or r["width"] > same["width"]):
            same["width"] = r["width"]
    for i in range(len(rails)):
        for j in range(i + 1, len(rails)):
            x, r = rails[i], rails[j]
            if not strict_eq(g(x, "layer"), g(r, "layer")) or strict_eq(g(x, "net"), g(r, "net")):
                continue
            xy, ry = bigint(x["y"]), bigint(r["y"])
            d2 = 2 * (xy - ry if xy > ry else ry - xy)
            if d2 == 0 or d2 < bigint(nn(g(x, "width"), 0)) + bigint(nn(g(r, "width"), 0)):
                prob("V040", r["name"], f"rails {x['name']} ({js(g(x, 'net'))}) and {r['name']} ({js(g(r, 'net'))}) overlap on {js(g(r, 'layer'))}")
    out["rails"] = rails
    # Expanded coordinates beyond +/-2^52 DBU cannot be expanded exactly: say so.
    def big(v):
        return is_num(v) and abs(v) > 2 ** 52
    far = [*(b for b in out["bands"] if big(b["y0"]) or big(b["y1"])), *(r for r in out["rails"] if big(r["y"])),
           *(t for t in out["tracks"] if any(big(p) for p in t["positions"]) or any(big(p) for p in t["span"])),
           *(e for e in out["edges"] if any(big(e[k]) for k in ("x0", "y0", "x1", "y1")))]
    for x in far:
        prob("V040", x["name"], f"{x['name']}: coordinates beyond +/-2^52 DBU cannot be expanded exactly")
    return _clean(out)


# Model selection (VOCABULARY.md section 2, cross / model): which models of a cross
# can describe a device with the given markers. `covering`: marker layers that
# cover the device; `touching`: marker layers that touch it at all.
def model_selector(model):
    a = model["attrs"]

    def refs(v):
        lst = list_of(v, is_ref)
        return [x["ref"] for x in (lst or [])]

    if "markers" in a:
        markers = refs(a["markers"])
    elif is_ref(a.get("marker", UNDEF)):
        markers = [a["marker"]["ref"]]
    else:
        markers = []
    # sets: [L] and [L, L] select the same devices
    return {"name": model.get("name", UNDEF), "polarity": a.get("polarity", UNDEF), "markers": list(dict.fromkeys(markers)),
            "exclude": list(dict.fromkeys(refs(a.get("exclude", UNDEF))))}


def select_models(cross, covering, touching, polarity=UNDEF):
    out = []
    for c in nn(cross.get("children", UNDEF), []):
        if c.get("kind") != "model":
            continue
        m = model_selector(c)
        if (polarity is UNDEF or strict_eq(m["polarity"], polarity)) and all(x in covering for x in m["markers"]) \
                and not any(x in touching for x in m["exclude"]):
            out.append(m)
    return out
