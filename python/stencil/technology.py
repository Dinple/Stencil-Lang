"""The query API over a resolved Stencil technology (doc/API.md)."""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path
from types import MappingProxyType
from typing import Iterable, Mapping, Optional, Sequence, Tuple, Union

from . import profile as _profile
from . import rulecheck as _rulecheck
from . import template as _template
from ._util import _JS_SPACE, dec_int, dec_str, frac_str, is_int, shown as _shown, text as _text, parse_number as _num, is_num, is_ref, same_value_zero, strict_eq, to_q, truthy, utf16
from .canon import hash_resolved
from .errors import AmbiguousError, ResolveError, StencilError, UnknownName, UnresolvedRuleError
from .types import (
    Band, CheckResult, DeviceInstance, Diagnostic, EdgeFeature, Finding, Layer, Margins, Model, Rail,
    Recognition, Rule, RuleValue, Shape, SiteTemplate, Size, SizeParam, TrackGrid, Unsupported, Via, Violation,
)

Number = Union[int, Fraction, str, float]

# Rule kinds whose operands are unordered (spacing between A and B = between B and A).
_SYMMETRIC = {"spacing", "cut_spacing", "corner_spacing"}
# Rule kinds that carry a numeric threshold.
_THRESHOLD = {"width", "length", "min_length", "area", "spacing", "cut_spacing", "corner_spacing",
              "eol_spacing", "enclosure", "extension"}
# The only kinds a query may combine: they measure the same thing.
_ALIASES = {"min_length", "length"}
# Rule attributes that are lengths (converted to nm; an area value to nm^2).
_LENGTH_ATTRS = {"value", "width_below", "width_above", "prl", "within"}
_FACES = ("top", "bottom", "left", "right")
_LIMITS = {"min": ("min", "exact"), "max": ("max", "exact"), "exact": ("exact",)}
_INVALID = "a valid definition (the resolver reported errors on this rule)"

def ref_of(v) -> Optional[str]:
    """A reference's name (a string), else None."""
    return v["ref"] if isinstance(v, Mapping) and isinstance(v.get("ref"), str) else None


def _list(v) -> list:
    """v when it is a list, else empty."""
    return v if isinstance(v, list) else []


def _name(o) -> Optional[str]:
    v = o.get("name")
    return v if isinstance(v, str) else None


def _rq(v) -> Optional[Fraction]:
    """A resolved-form value (integer, "n/d") -> Fraction, else None."""
    try:
        return to_q(v)
    except ValueError:
        return None


SAFE = 2 ** 53 - 1


def _unsafe_int(v):
    """The first integer beyond +/-(2^53 - 1) in a JSON value, else None."""
    stack = [v]
    while stack:
        x = stack.pop()
        if isinstance(x, bool):
            continue
        if isinstance(x, int) and abs(x) > SAFE:
            return x
        if isinstance(x, float) and x.is_integer() and abs(x) > SAFE:
            return int(x)
        if isinstance(x, Mapping):
            stack.extend(x.values())
        elif isinstance(x, list):
            stack.extend(x)
    return None


def _flag(name, v):
    if v is not None and not isinstance(v, bool):
        raise TypeError(f"{name} must be True, False or None, not {_shown(v)}")
    return v


def _names(name, v):
    if v is None:
        return None
    if isinstance(v, (str, Mapping)):
        raise TypeError(f"{name} is a collection of names, not {type(v).__name__}")
    out = tuple(v)
    if not all(isinstance(x, str) for x in out):
        raise TypeError(f"{name} must hold names (strings)")
    return out


class Technology:
    """A resolved technology and the queries a cell generator asks of it."""

    # ---- loading ------------------------------------------------------------------

    def __init__(self, resolved: Mapping, diagnostics: Optional[Iterable[Mapping]] = (), *, allow_incomplete: Optional[bool] = False):
        diagnostics = () if diagnostics is None else diagnostics
        if not isinstance(diagnostics, (list, tuple)):
            raise TypeError("diagnostics is a list")
        allow_incomplete = bool(_flag("allow_incomplete", allow_incomplete))
        if not isinstance(resolved, Mapping) or not isinstance(resolved.get("objects"), list):
            raise StencilError("not a resolved Stencil technology (no 'objects' list)")
        for i, o in enumerate(resolved["objects"]):
            if not (isinstance(o, Mapping) and isinstance(o.get("kind"), str) and isinstance(o.get("attrs"), Mapping)
                    and isinstance(o.get("children", []), list)
                    and all(isinstance(c, Mapping) and isinstance(c.get("kind"), str) and isinstance(c.get("attrs"), Mapping)
                            for c in o.get("children", []))):
                raise StencilError(f"object {i} is not a resolved object (kind, attrs, children)")
        bad = _unsafe_int(resolved)
        if bad is not None:
            raise StencilError(f"the integer {dec_str(bad)} is beyond +/-(2^53 - 1), which JSON readers do not hold exactly")
        self._r = resolved
        self.diagnostics: Tuple[Diagnostic, ...] = tuple(
            Diagnostic(d.get("code"), d.get("severity"), d.get("message"), d.get("file"), d.get("line"), d.get("col"), d.get("hint"))
            for d in diagnostics if isinstance(d, Mapping))
        self.complete: bool = resolved.get("complete", True) is not False
        self.hash: str = resolved.get("hash") or hash_resolved(resolved)
        if not self.complete and not allow_incomplete:
            errs = [d for d in self.diagnostics if d.severity == "error"]
            msg = "; ".join(f"{_text(d.file)}:{_text(d.line)}:{_text(d.col)}: {_text(d.code)}: {_text(d.message)}" for d in errs[:5]) \
                or "the resolved form is marked incomplete"
            raise ResolveError(f"technology did not resolve cleanly: {msg}", self.diagnostics)
        g = resolved.get("grid_nm")
        g = 1 if g is None else g
        self._grid = _rq(g)
        if self._grid is None or self._grid <= 0:
            raise StencilError(f"bad grid_nm {_shown(g)}")
        self._objects = list(resolved["objects"])
        self._by = {o["name"]: o for o in self._objects if isinstance(o.get("name"), str) and o["name"]}

    @staticmethod
    def _resolver(cli=None) -> Path:
        """The resolver: `cli`, $STENCIL_CLI, the copy packaged with this module
        (tools/vendor_resolver.py), or the checkout this package lives in."""
        for given, what in ((cli, "cli="), (os.environ.get("STENCIL_CLI"), "$STENCIL_CLI")):
            if given:
                if not Path(given).is_file():
                    raise StencilError(f"{what} {_text(given)} is not a file")
                return Path(given)
        here = Path(__file__).resolve().parent
        for c in (here / "_resolver" / "cli.mjs", here.parent.parent / "cli.mjs"):
            if c.is_file():
                return c
        raise StencilError("the Stencil resolver (cli.mjs) was not found: pass cli=, set STENCIL_CLI, "
                           "or install a package built with tools/vendor_resolver.py")

    @classmethod
    def load(cls, main: Union[str, os.PathLike], root: Union[str, os.PathLike, None] = None, *,
             allow_incomplete: bool = False, node: Optional[str] = None, cli: Union[str, os.PathLike, None] = None) -> "Technology":
        """Resolve a .stencil file with the JavaScript resolver (needs Node >= 18).

        A relative `main` is relative to `root` when one is given (imports
        resolve against `root`, default: the main file's folder). `node`: the
        node executable (default: $STENCIL_NODE, else `node` on PATH)."""
        node = node or os.environ.get("STENCIL_NODE") or shutil.which("node")
        if not node:
            raise StencilError("Technology.load needs Node.js >= 18 to resolve (or use Technology.from_json)")
        resolver = cls._resolver(cli)
        main = Path(main)
        if root is not None and not main.is_absolute():
            main = Path(root) / main
        if not main.is_file():
            raise FileNotFoundError(str(main))
        args = [node, str(resolver), "resolve", str(main.resolve()), "--quiet", "--with-diagnostics"]
        if root is not None:
            args += ["--root", str(Path(root).resolve())]
        try:
            v = subprocess.run([node, "--version"], capture_output=True, text=True, encoding="utf-8")
            major = int(re.match(r"v(\d+)", v.stdout.strip()).group(1))
        except (OSError, AttributeError, ValueError) as e:
            raise StencilError(f"cannot run Node ({node}): {e}") from None
        if major < 18:
            raise StencilError(f"Node {v.stdout.strip()} is too old: the resolver needs Node >= 18")
        p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
        if p.returncode not in (0, 1) or not p.stdout.strip():
            raise StencilError(f"the resolver failed ({p.returncode}): {p.stderr.strip()}")
        bundle = json.loads(p.stdout, parse_int=dec_int)
        return cls(bundle["resolved"], bundle.get("diagnostics", ()), allow_incomplete=allow_incomplete)

    @classmethod
    def from_json(cls, source: Union[str, os.PathLike, Mapping], *, allow_incomplete: bool = False) -> "Technology":
        """Read a resolved form (cli.mjs resolve --out), or the --with-diagnostics bundle.
        Needs no Node."""
        data = source if isinstance(source, Mapping) else json.loads(Path(source).read_text(encoding="utf-8"), parse_int=dec_int)
        if "resolved" in data and "objects" not in data:
            return cls(data["resolved"], data.get("diagnostics", ()), allow_incomplete=allow_incomplete)
        return cls(data, (), allow_incomplete=allow_incomplete)

    @property
    def resolved(self) -> Mapping:
        """The resolved form itself (read only; lengths in DBU)."""
        return self._r

    # ---- 1. grid and units ------------------------------------------------------------

    @property
    def grid(self) -> Fraction:
        """The manufacturing grid (one database unit) in nm."""
        return self._grid

    def dbu(self, x: Number) -> int:
        """nm -> database units; ValueError when x is not on the grid."""
        q = _num(x) / self._grid
        if q.denominator != 1:
            raise ValueError(f"{_shown(x)} nm is not on the {frac_str(self._grid)} nm grid")
        if abs(q.numerator) > SAFE:
            raise ValueError(f"{_shown(x)} nm is {dec_str(q.numerator)} database units, beyond +/-(2^53 - 1)")
        return q.numerator

    def nm(self, n: int) -> Fraction:
        """database units -> nm."""
        if isinstance(n, bool) or not isinstance(n, int):
            raise TypeError(f"database units are integers, got {_shown(n)}")
        if abs(n) > SAFE:
            raise ValueError(f"{dec_str(n)} is beyond +/-(2^53 - 1)")
        return n * self._grid

    def snap(self, x: Number, mode: str = "nearest") -> Fraction:
        """x (nm) moved onto the grid: "nearest" (ties away from zero), "down" or "up"."""
        q = _num(x) / self._grid
        mode = "nearest" if mode is None else mode
        if mode == "down":
            k = math.floor(q)
        elif mode == "up":
            k = math.ceil(q)
        elif mode == "nearest":
            k = math.floor(abs(q) + Fraction(1, 2)) * (1 if q >= 0 else -1)
        else:
            raise ValueError(f"mode must be nearest, down or up, not {_shown(mode)}")
        return k * self._grid

    def _len(self, v) -> Optional[Fraction]:
        q = _rq(v)
        return None if q is None else q * self._grid

    def _size(self, v, scale: bool = True) -> Optional[Size]:
        def f(x):
            q = _rq(x)
            if q is None:
                raise _BadSize
            return q * self._grid if scale else q

        try:
            if v is None:
                return None
            if _rq(v) is not None:
                return Size("fixed", (f(v),))
            if v == "fill":
                return Size("fill", ())
            if isinstance(v, Mapping) and isinstance(v.get("one_of"), list):
                return Size("one_of", tuple(f(x) for x in v["one_of"]))
            if isinstance(v, Mapping) and "min" in v and "max" in v:
                return Size("range", (f(v["min"]), f(v["max"])))
        except _BadSize:
            return None
        return None

    # ---- lookup helpers ------------------------------------------------------------------

    def _obj(self, name: str, kinds: Union[str, Tuple[str, ...]]):
        kinds = (kinds,) if isinstance(kinds, str) else kinds
        o = self._by.get(name) if isinstance(name, str) else None
        if o is None or o["kind"] not in kinds:
            raise UnknownName(f"no {' or '.join(kinds)} named {_shown(name)}")
        return o

    def _of_kind(self, kind: str):
        return [o for o in self._objects if o["kind"] == kind]

    # ---- 2-3. layers -------------------------------------------------------------------

    def _layer(self, o) -> Layer:
        a = o["attrs"]
        lat = a
        arr = self._by.get(ref_of(a.get("tracks")))
        if "pitch" not in a and arr and arr["kind"] == "array":
            lat = arr["attrs"]
        pair = lambda v: tuple(v) if isinstance(v, list) and len(v) == 2 else None
        order = a.get("order")
        return Layer(
            name=_name(o), order=int(order) if is_int(order) else None, role=a.get("role"), side=a.get("side"), direction=a.get("direction"),
            width=self._size(a.get("width")), pitch=self._len(lat["pitch"]) if "pitch" in lat else None,
            offset=self._len(lat["offset"]) if "offset" in lat else None,
            masks=int(a["masks"]) if is_int(a.get("masks")) else 1,
            tracks_mode=_profile.tracks_mode(o) if a.get("role") == "conductor" else None,
            gds=pair(a.get("gds")), gds_pin=pair(a.get("gds_pin")), gds_label=pair(a.get("gds_label")),
            derived=truthy(a.get("from")), note=a.get("note"))

    @staticmethod
    def _by_order(objs):
        key = lambda o: o["attrs"].get("order")
        return sorted(objs, key=lambda o: (not is_num(key(o)), key(o) if is_num(key(o)) else 0))

    def layers(self, role: Optional[str] = None, side: Optional[str] = None) -> Tuple[Layer, ...]:
        """Layers, bottom -> top, optionally of one role and/or side."""
        _optional_name("role", role)
        _optional_name("side", side)
        objs = [o for o in self._of_kind("layer")
                if (role is None or o["attrs"].get("role") == role) and (side is None or o["attrs"].get("side") == side)]
        return tuple(self._layer(o) for o in self._by_order(objs))

    def layer(self, name: str) -> Layer:
        return self._layer(self._obj(name, "layer"))

    # ---- 4. routing scope -----------------------------------------------------------------

    def routing_layers(self, site: Optional[str] = None) -> Tuple[Layer, ...]:
        """The conductors a cell generator routes on (VOCABULARY.md section 2.12), bottom -> top:
        from the device tier up to the highest layer the site (default: every site)
        uses for pins or in-cell tracks. Placed-only device layers (strata, gates) are
        never included; without a site that bounds it, every other conductor is."""
        if site is not None:
            self._obj(site, "site")
        return tuple(self._layer(o) for o in self._by_order(_profile.routing_scope(self._r, None if site is None else [site])))

    # ---- 5. vias --------------------------------------------------------------------------

    def _via(self, o) -> Via:
        a = o["attrs"]
        lower = a.get("lower")
        lowers = tuple(ref_of(x) for x in lower) if isinstance(lower, list) else ((ref_of(lower),) if truthy(lower) else ())

        def pair(v):
            if v is None:
                return None
            if isinstance(v, list) and len(v) == 2:
                return (self._len(v[0]), self._len(v[1]))
            q = self._len(v)
            return None if q is None else (q, q)

        z = (Fraction(0), Fraction(0))
        return Via(name=_name(o), lower=lowers, cut=ref_of(a.get("cut")), upper=ref_of(a.get("upper")),
                   size=pair(a.get("size")), enclose_lower=pair(a.get("enclose_lower")) or z,
                   enclose_upper=pair(a.get("enclose_upper")) or z)

    def vias(self, lower: Optional[str] = None, upper: Optional[str] = None) -> Tuple[Via, ...]:
        """Connectors, optionally between `lower` and `upper`."""
        _optional_name("lower", lower)
        _optional_name("upper", upper)
        vs = [self._via(o) for o in self._of_kind("connector")]
        return tuple(v for v in vs if (lower is None or lower in v.lower) and (upper is None or upper == v.upper))

    def via(self, lower: str, upper: str) -> Via:
        """The one connector from `lower` up to `upper`."""
        _operands([lower, upper])
        vs = self.vias(lower, upper)
        if not vs:
            raise UnknownName(f"no connector from {lower} up to {upper}")
        if len(vs) > 1:
            raise AmbiguousError(f"{len(vs)} connectors from {lower} up to {upper}: {_names_text(v.name for v in vs)}")
        return vs[0]

    # ---- 6-7. cell templates ----------------------------------------------------------------

    def sites(self) -> Tuple[str, ...]:
        """Names of the sites (cell templates)."""
        return tuple(_name(o) for o in self._of_kind("site"))

    def site(self, name: Optional[str] = None, units: int = 1) -> SiteTemplate:
        """The expanded cell template of a cell `units` placement units wide. `name`
        may be omitted when exactly one site is not a row of another."""
        if name is None:
            used = {ref_of(c["attrs"].get("site")) for s in self._of_kind("site") for c in _list(s.get("children")) if c["kind"] == "row"}
            top = [n for n in self.sites() if isinstance(n, str) and n not in used]
            if len(top) != 1:
                raise AmbiguousError(f"name the site: {', '.join(top) or 'every site is a row of another'}")
            name = top[0]
        o = self._obj(name, "site")
        units = 1 if units is None else units
        if isinstance(units, bool) or not isinstance(units, int) or units < 1:
            raise ValueError(f"units must be a positive integer, not {_shown(units)}")
        x = _template.expand_site(self._r, name, units)
        if x["problems"]:
            raise StencilError(f"site {name} does not expand cleanly: " + "; ".join(p["message"] for p in x["problems"]))
        if "cellWidth" not in x:
            raise StencilError(f"site {name} has no width or height")
        L = self._len
        a = o["attrs"]
        return SiteTemplate(
            name=name, width=L(x["width"]), cell_width=L(x["cellWidth"]), units=units, height=L(x["height"]),
            rails=tuple(Rail(r["name"], r.get("net"), r.get("layer"), L(r["y"]), L(r["width"]) if "width" in r else None,
                             tuple(n for n in r.get("shared", ()) if n != r["name"])) for r in x["rails"]),
            bands=tuple(Band(b["name"], b["polarity"], b.get("stratum"), L(b["y0"]), L(b["y1"]), b["flipped"]) for b in x["bands"]),
            edges=tuple(EdgeFeature(e["name"], e.get("layer"), e["side"], e["shared"], L(e["x0"]), L(e["y0"]), L(e["x1"]), L(e["y1"]))
                        for e in x["edges"]),
            pins=tuple(ref_of(p) for p in _list(a.get("pins"))), boundary=ref_of(a.get("boundary")),
            symmetry=tuple(_list(a.get("symmetry"))),
            grids=tuple(TrackGrid(t["name"], t["layer"], t["axis"], tuple(L(p) for p in t["positions"]), tuple(t["use"]),
                                  (L(t["span"][0]), L(t["span"][1]))) for t in x["tracks"]))

    # ---- 8-12. rules -------------------------------------------------------------------------

    def _rule(self, o) -> Rule:
        a = o["attrs"]
        area = a.get("kind") == "area"
        on = a.get("on")
        ons = tuple(ref_of(x) for x in on) if isinstance(on, list) else (ref_of(on),)

        def conv(k, v):
            if k in _LENGTH_ATTRS and _rq(v) is not None:
                return _rq(v) * (self._grid ** 2 if area and k == "value" else self._grid)
            if is_ref(v):
                return v["ref"]
            return v

        attrs = {k: conv(k, v) for k, v in a.items() if k not in ("on", "kind", "intent")}
        children = []
        for c in _list(o.get("children")):
            ca = dict(c["attrs"])
            for k in ("width", "prl", "margins"):
                if isinstance(ca.get(k), list):
                    ca[k] = tuple(self._len(x) for x in ca[k])
            if isinstance(ca.get("values"), list):
                ca["values"] = tuple(tuple(self._len(x) for x in row) if isinstance(row, list) else None for row in ca["values"])
            if "value" in ca:
                ca["value"] = self._len(ca["value"])
            children.append(MappingProxyType({"kind": c["kind"], "name": _name(c), "attrs": MappingProxyType(ca)}))
        intent = a.get("intent")
        return Rule(name=_name(o), kind=a.get("kind"), on=ons, intent="pdk" if intent is None else intent, attrs=MappingProxyType(attrs),
                    children=tuple(children))

    def rules(self, on: Optional[str] = None, kind: Union[str, Sequence[str], None] = None, *,
              include_checker_only: bool = False) -> Tuple[Rule, ...]:
        """Rules as written (lengths in nm), including extension (x_) kinds."""
        include_checker_only = bool(_flag("include_checker_only", include_checker_only))
        if on is not None and not isinstance(on, str):
            raise TypeError(f"on is a name, not {_shown(on)}")
        kinds = None if kind is None else _kinds(kind)
        return tuple(r for r in self._rules()
                     if (on is None or on in r.on) and (kinds is None or r.kind in kinds) and (include_checker_only or r.intent != "checker_only"))

    def _rules(self):
        if not hasattr(self, "_rule_cache"):
            # a rule is invalid when the resolver marked it, or one of its children (table, alternative, case)
            self._rule_cache = [(self._rule(o), o.get("invalid") is True or any(c.get("invalid") is True for c in _list(o.get("children"))))
                                for o in self._of_kind("rule")]
            self._bad = {id(r) for r, bad in self._rule_cache if bad}
        return [r for r, _ in self._rule_cache]

    def _invalid(self, rule: Rule) -> bool:
        """Did the resolver mark this rule (this record, not its name) invalid?"""
        self._rules()
        return id(rule) in self._bad

    def _decide(self, r: Rule, q: dict, axis_is_condition: bool = True):
        """("apply", threshold) | ("skip", None) | ("unknown", [needs])."""
        a = r.attrs
        needs, skip = [], False
        if self._invalid(r):
            needs.append(_INVALID)
        if any(c["kind"] == "case" for c in r.children):
            needs.append("case contexts (via_end / open_end)")
        if r.kind == "extension" and a.get("axis") is None:
            needs.append(_INVALID)
        if any(k in a and not isinstance(a[k], Fraction) for k in _LENGTH_ATTRS):
            needs.append(_INVALID)                        # a threshold or condition that is not a length
        if axis_is_condition and a.get("axis") is not None:
            if q["axis"] is None:
                needs.append("axis")
            elif not strict_eq(q["axis"], a["axis"]):
                skip = True
        num = lambda k: isinstance(a.get(k), Fraction)
        for k, test in (("width_below", lambda w, t: w < t), ("width_above", lambda w, t: w > t)):
            if k in a:
                if q["width"] is None:
                    needs.append("width")
                elif num(k) and not test(q["width"], a[k]):
                    skip = True
        if "prl" in a:
            if q["prl"] is None:
                needs.append("prl")
            elif num("prl") and q["prl"] < a["prl"]:
                skip = True
        for k in ("same_net", "same_color"):
            if k in a:
                if q[k] is None:
                    needs.append(k)
                elif not strict_eq(q[k], a[k]):
                    skip = True
        if "scope" in a:
            if q["scopes"] is None:
                needs.append("scopes")
            elif not any(same_value_zero(x, a["scope"]) for x in q["scopes"]):
                skip = True
        table = next((c for c in r.children if c["kind"] == "table"), None)
        if table is not None:
            ta = table["attrs"]
            if "width" in ta and q["width"] is None:
                needs.append("width")
            if "prl" in ta and q["prl"] is None:
                needs.append("prl")
            # each index present: lengths, starting at 0, strictly increasing (VOCABULARY.md section 3.6)
            idx_ok = all(k not in ta or (isinstance(ta[k], tuple) and ta[k] and None not in ta[k] and ta[k][0] == 0
                                         and all(x < y for x, y in zip(ta[k], ta[k][1:]))) for k in ("width", "prl"))
            rows = len(ta["width"]) if isinstance(ta.get("width"), tuple) else 1
            cols = len(ta["prl"]) if isinstance(ta.get("prl"), tuple) else 1
            vals = ta.get("values")
            if not (idx_ok and isinstance(vals, tuple) and len(vals) == rows
                    and all(isinstance(row, tuple) and len(row) == cols and None not in row for row in vals)):
                needs.append(_INVALID)
        if axis_is_condition and any(c["kind"] == "alternative" for c in r.children):
            needs.append("margin alternatives (query them with enclosure())")
        if skip:
            return "skip", None
        if needs:
            return "unknown", list(dict.fromkeys(needs))
        if table is not None:
            ta = table["attrs"]

            def pick(bps, x):
                k = 0
                for i, b in enumerate(bps):
                    if b <= x:
                        k = i
                return k

            rows = ta.get("width") or (Fraction(0),)
            cols = ta.get("prl") or (Fraction(0),)
            return "apply", ta["values"][pick(rows, q["width"] if "width" in ta else Fraction(0))][pick(cols, q["prl"] if "prl" in ta else Fraction(0))]
        return "apply", a.get("value")

    def _query(self, width, prl, axis, same_net, same_color, scopes):
        if axis not in (None, "x", "y"):
            raise ValueError(f"axis must be 'x' or 'y', not {_shown(axis)}")
        return {"width": None if width is None else _num(width), "prl": None if prl is None else _num(prl), "axis": axis,
                "same_net": _flag("same_net", same_net), "same_color": _flag("same_color", same_color), "scopes": _names("scopes", scopes)}

    def _check_names(self, names):
        for n in names:
            if not isinstance(n, str) or n not in self._by:
                raise UnknownName(f"no object named {_shown(n)}")

    def _closure(self, name):
        """Every named operand a region, computed layer or connector is computed from,
        directly or through other derived operands (intermediate ones included)."""
        out, todo = set(), [name]
        while todo:
            n = todo.pop()
            o = self._by.get(n)
            if o is None:
                continue
            a = o["attrs"]
            refs = []
            if o["kind"] == "region" or (o["kind"] == "layer" and truthy(a.get("from"))):
                def walk(e):
                    if isinstance(e, list):
                        for x in e:
                            walk(x)
                    elif isinstance(e, Mapping):
                        if isinstance(e.get("ref"), str):
                            refs.append(e["ref"])
                        else:                         # arguments: a list, or an object indexed by "0", "1", ...
                            args = e.get("args")
                            for x in (args if isinstance(args, list) else args.values() if isinstance(args, Mapping) else ()):
                                walk(x)
                walk(a.get("from"))
            elif o["kind"] == "connector":
                v = self._via(o)
                refs = [x for x in (v.cut, *v.lower, v.upper) if x]
            for x in refs:
                if x not in out and x != name:
                    out.add(x)
                    todo.append(x)
        return out

    def _derived(self, o):
        return o["kind"] == "region" or (o["kind"] == "layer" and truthy(o["attrs"].get("from")))

    def _indirect(self, rule: Rule, names, connectors: bool = True):
        """Why `rule` may constrain shapes of `names` without naming them: an operand
        computed from them, or (connectors=True) a connector whose cut or layers they are."""
        out = []
        if not all(isinstance(x, str) for x in rule.on):    # a rule with a broken operand names no layer
            return out
        for op in rule.on:
            o = self._by.get(op) if isinstance(op, str) else None
            if o is None or op in names or not (self._derived(o) or o["kind"] == "connector"):
                continue
            hit = sorted(set(names) & self._closure(op), key=utf16)
            if hit and self._derived(o):
                out.append(f"its operand {op} is computed from {', '.join(hit)}")
            elif hit and connectors:
                hint = f"query enclosure() on its cut and layers" if rule.kind == "enclosure" else f"query on {op}"
                out.append(f"it applies to connector {op}, which uses {', '.join(hit)}; {hint}")
        return out

    def _related(self, name, target):
        """`name` is `target`, or computed from it."""
        return name == target or target in self._closure(name)

    def rule_value(self, kind: Union[str, Sequence[str]], on: Union[str, Sequence[str]], *, limit: str = "min",
                   width: Optional[Number] = None, prl: Optional[Number] = None, axis: Optional[str] = None,
                   same_net: Optional[bool] = None, same_color: Optional[bool] = None,
                   scopes: Optional[Iterable[str]] = None, ignore: Iterable[str] = ()) -> Optional[RuleValue]:
        """The threshold a generator must honour for rules of `kind` on `on` (doc/API.md).

        `axis`: the direction the distance is measured along; `width`: what the
        rule's width condition measures (spacing: the wider of the two shapes;
        eol_spacing: the line end; enclosure: the outer shape); `prl`: the
        parallel run length; `scopes`: the regions either shape touches.
        `limit="min"` combines min and exact rules, `"max"` max and exact rules;
        when an exact rule applies the result is exact (limit "exact"). A rule the
        conditions cannot decide raises UnresolvedRuleError."""
        kinds = _kinds(kind)
        if not kinds or (len(kinds) > 1 and not set(kinds) <= _ALIASES):
            raise ValueError(f"kinds {', '.join(kinds) or '(none)'} cannot be combined in one query")
        for k in kinds:
            if not isinstance(k, str) or k.startswith("x_"):
                raise ValueError(f"{k}: extension kinds have no defined meaning to query; use rules()")
            if k not in _THRESHOLD:
                raise ValueError(f"rule kind {k} has no threshold")
        limit = "min" if limit is None else limit
        if not isinstance(limit, str) or limit not in _LIMITS:
            raise ValueError(f"limit must be min, max or exact, not {_shown(limit)}")
        ops = _operands(on)
        if not 1 <= len(ops) <= 2:
            raise ValueError("on names one or two operands")
        self._check_names(ops)
        q = self._query(width, prl, axis, same_net, same_color, scopes)
        ignore = set(_names("ignore", ignore) or ())
        accepted = _LIMITS[limit]

        # cut spacing of a connector's cuts: rules on its cut layer apply to them too
        alias = ()
        conn = self._by.get(ops[0]) if len(set(ops)) == 1 else None      # "C", ["C"] and ["C", "C"] alike
        if conn is not None and conn["kind"] == "connector" and "cut_spacing" in kinds and self._via(conn).cut in self._by:
            alias = (self._via(conn).cut,)

        def match_one(r: Rule, want):
            if r.kind in _SYMMETRIC:
                norm = lambda t: tuple(sorted(t * 2 if len(t) == 1 else t))
                return norm(r.on) == norm(want)
            return r.on == want

        def matches(r: Rule):
            if not all(isinstance(x, str) for x in r.on):     # a rule with a broken operand names no layer
                return False
            return match_one(r, ops) or (bool(alias) and r.kind == "cut_spacing" and match_one(r, alias))

        # a scalar enclosure on a connector: rules on its [cut, layer] pairs constrain its cuts too
        pairs = []
        if conn is not None and conn["kind"] == "connector" and "enclosure" in kinds:
            v = self._via(conn)
            pairs = [(v.cut, l) for l in (*v.lower, v.upper) if v.cut and l]

        def pair_hits(r: Rule):
            if r.kind != "enclosure" or len(r.on) != 2 or not all(isinstance(x, str) for x in r.on):
                return []
            return [f"it applies to the cuts of connector {ops[0]} in {l}; query enclosure({c}, {l})"
                    for c, l in pairs if self._related(r.on[0], c) and self._related(r.on[1], l)][:1]

        def indirect(r: Rule):
            return (self._indirect(r, ops) + (self._indirect(r, alias, connectors=False) if alias else [])
                    + (pair_hits(r) if pairs else []))

        def decide_all(rules):
            applied, unknown = [], []
            for r in rules:
                verdict, x = self._decide(r, q)
                if verdict == "apply":
                    if isinstance(x, Fraction):
                        applied.append((r, x))
                    else:
                        unknown.append((r.name, _INVALID))
                elif verdict == "unknown":
                    unknown += [(r.name, need) for need in x]
            return applied, unknown

        every = [r for r in self.rules(kind=kinds) if r.name not in ignore]
        indirect_other = [(r.name, why) for r in every if _limit(r) not in accepted and not matches(r) for why in indirect(r)]
        pool = [r for r in every if _limit(r) in accepted]
        cands = [r for r in pool if matches(r)]
        unknown = [(r.name, why) for r in pool if not matches(r) for why in indirect(r)]
        if not cands and not unknown:
            return None
        applied, more = decide_all(cands)
        unknown += more
        if unknown:
            raise UnresolvedRuleError(unknown)
        if not applied:
            return RuleValue(None, limit, (), _one_measure(applied))
        exact = [(r, v) for r, v in applied if _limit(r) == "exact"]
        bounds = [(r, v) for r, v in applied if _limit(r) != "exact"]
        # the bounds in the other direction, for consistency (min rules for a max query, and so on)
        others = [r for r in every if matches(r) and _limit(r) in ("min", "max") and _limit(r) not in accepted]
        opposite, open_ = decide_all(others)
        measure = _one_measure(applied + opposite)        # thresholds of different measures do not compare
        if exact:
            if len({v for _, v in exact}) > 1:
                raise AmbiguousError("exact thresholds disagree: " + ", ".join(f"{r.name} = {frac_str(v)}" for r, v in exact))
            v = exact[0][1]
            if open_ or indirect_other:                   # an exact answer must be checked against every bound
                raise UnresolvedRuleError(indirect_other + open_)
            clash = [(r, b) for r, b in bounds + opposite if (b > v if _limit(r) == "min" else b < v)]
            if clash:
                raise AmbiguousError(f"no value satisfies {exact[0][0].name} (exactly {frac_str(v)}) and "
                                     + ", ".join(f"{r.name} ({'at least' if _limit(r) == 'min' else 'at most'} {frac_str(b)})" for r, b in clash))
            return RuleValue(v, "exact", tuple(r.name for r, _ in exact), measure)
        best = max(v for _, v in bounds) if limit == "min" else min(v for _, v in bounds)
        clash = [(r, b) for r, b in opposite if (b < best if limit == "min" else b > best)]
        if clash:
            raise AmbiguousError(f"no value satisfies {'at least' if limit == 'min' else 'at most'} {frac_str(best)} and "
                                 + ", ".join(f"{r.name} ({'at most' if limit == 'min' else 'at least'} {frac_str(b)})" for r, b in clash))
        return RuleValue(best, limit, tuple(r.name for r, v in bounds if v == best), measure)

    def min_width(self, layer: str, axis: Optional[str] = None, **conditions) -> Optional[RuleValue]:
        return self.rule_value("width", layer, axis=axis, **conditions)

    def min_length(self, layer: str, axis: Optional[str] = None, **conditions) -> Optional[RuleValue]:
        return self.rule_value(("min_length", "length"), layer, axis=axis, **conditions)

    def min_area(self, layer: str, **conditions) -> Optional[RuleValue]:
        """In nm^2."""
        return self.rule_value("area", layer, **conditions)

    def min_spacing(self, a: str, b: Optional[str] = None, *, width: Optional[Number] = None, prl: Optional[Number] = None,
                    axis: Optional[str] = None, same_net: Optional[bool] = None, same_color: Optional[bool] = None,
                    scopes: Optional[Iterable[str]] = None, ignore: Iterable[str] = ()) -> Optional[RuleValue]:
        """Spacing between shapes of `a` (and `b`), with table lookup (`width`: the wider shape)."""
        return self.rule_value("spacing", (a,) if b is None else (a, b), width=width, prl=prl, axis=axis,
                               same_net=same_net, same_color=same_color, scopes=scopes, ignore=ignore)

    def enclosure(self, inner: str, outer: str, *, width: Optional[Number] = None,
                  scopes: Optional[Iterable[str]] = None, ignore: Iterable[str] = ()) -> Optional[Tuple[Margins, ...]]:
        """The margin sets `outer` must leave around `inner`, any one suffices.

        Combines every enclosure rule on [inner, outer] and on connectors whose
        cut is `inner` and whose lower or upper layer is `outer`. `width` is the
        outer shape's width (for width_below / width_above). None when no rule exists."""
        _operands([inner, outer])
        self._check_names((inner, outer))
        q = self._query(width, None, None, None, None, scopes)
        ignore = set(_names("ignore", ignore) or ())
        conns, related = set(), {}
        for o in self._of_kind("connector"):
            v = self._via(o)
            if _name(o) is None:                          # an unnamed connector cannot be a rule operand
                continue
            if v.cut == inner and outer in (*v.lower, v.upper):
                conns.add(_name(o))
            if v.cut and self._related(v.cut, inner):
                # every obligation [cut, layer] computed from [inner, outer], beyond the direct one
                layers = [l for l in (*v.lower, v.upper) if l and self._related(l, outer) and not (v.cut == inner and l == outer)]
                if layers:
                    related[_name(o)] = f"it applies to connector {_name(o)}, whose {v.cut} in {', '.join(layers)} is computed from {inner} in {outer}"
        pool = [r for r in self.rules(kind="enclosure") if r.name not in ignore and all(isinstance(x, str) for x in r.on)]
        direct = lambda r: r.on == (inner, outer) or (len(r.on) == 1 and r.on[0] in conns)
        cands = [r for r in pool if direct(r)]
        unknown = []
        for r in pool:
            if len(r.on) == 1 and r.on[0] in related:    # a connector with a derived obligation (direct or not)
                unknown.append((r.name, related[r.on[0]]))
            elif not direct(r):                           # rules on regions or computed layers derived from inner / outer
                unknown += [(r.name, why) for why in self._indirect(r, (inner, outer)) if not why.startswith("it applies to connector")]
        if not cands and not unknown:
            return None
        sets = [(Fraction(0),) * 4]
        for r in cands:
            if _limit(r) != "min":
                raise StencilError(f"rule {r.name}: enclosure with limit {_shown(r.attrs['limit'])}, read it with rules()")
            verdict, v = self._decide(r, q, axis_is_condition=False)
            if verdict == "unknown":
                unknown += [(r.name, need) for need in v]
                continue
            if verdict == "skip":
                continue
            alts = [c["attrs"].get("margins") for c in r.children if c["kind"] == "alternative"]
            if not alts:
                if v is None:
                    unknown.append((r.name, _INVALID))
                    continue
                z = Fraction(0)
                ax = r.attrs.get("axis")
                alts = [(v, v, z, z) if ax == "x" else (z, z, v, v) if ax == "y" else (v, v, v, v)]
            if any(not isinstance(m, tuple) or len(m) != 4 or None in m for m in alts):
                unknown.append((r.name, _INVALID))
                continue
            sets = list(dict.fromkeys(tuple(max(s[k], m[k]) for k in range(4)) for s in sets for m in alts))
        if unknown:
            raise UnresolvedRuleError(unknown)
        # drop sets that ask for more than another set on every side
        keep = [s for s in sets if not any(t != s and all(t[k] <= s[k] for k in range(4)) for t in sets)]
        return tuple(Margins(*s) for s in keep)

    # ---- 13-14. devices --------------------------------------------------------------------------

    def devices(self) -> Tuple["Device", ...]:
        return tuple(Device(self, o) for o in self._of_kind("cross"))

    def device(self, name: str) -> "Device":
        return Device(self, self._obj(name, "cross"))

    # ---- 15-16. checking ----------------------------------------------------------------------------

    def _shapes(self, shapes) -> list:
        if isinstance(shapes, (Mapping, str)) or shapes is None:
            raise TypeError("shapes is a list of shapes")
        out = []
        for i, s in enumerate(shapes):
            if isinstance(s, Shape):
                d = {"layer": s.layer, "rect": s.rect, "net": s.net, "color": s.color, "connector": s.connector}
            elif isinstance(s, Mapping):
                d = dict(s)
            elif isinstance(s, (tuple, list)) and len(s) == 2:
                d = {"layer": s[0], "rect": s[1]}
            else:
                raise TypeError(f"shape {i}: a Shape, a mapping or (layer, rect)")
            if not isinstance(d.get("layer"), str):
                raise ValueError(f"shape {i}: no layer")
            rect = d.get("rect")
            if not isinstance(rect, (tuple, list)) or len(rect) != 4:
                raise ValueError(f"shape {i}: rect is (x0, y0, x1, y1)")
            try:
                r = [self.dbu(v) for v in rect]
            except ValueError as e:
                raise ValueError(f"shape {i}: {e}") from None
            js = {"layer": d["layer"], "rect": r}
            for k in ("net", "color", "connector"):
                if d.get(k) is not None:
                    js[k] = d[k]
            out.append(js)
        return out

    def _measured(self, text: str, area: bool) -> str:
        g = self._grid ** 2 if area else self._grid
        g2 = self._grid ** 2
        fmt = frac_str
        m = re.fullmatch(r"(centre distance )?sqrt\((-?\d+(?:/\d+)?)\)", text)
        if m:
            return f"{m.group(1) or ''}sqrt({fmt(_rq(m.group(2)) * g2)})"
        m = re.fullmatch(r"(centre distance )?(-?\d+(?:/\d+)?)", text)
        if m:
            return f"{m.group(1) or ''}{fmt(_rq(m.group(2)) * g)}"
        return text

    def check(self, shapes: Iterable, mode: str = "generator") -> CheckResult:
        """The reference rule checker (VOCABULARY.md section 3) on rectangles in nm.

        mode "generator" skips checker_only rules; "checker" checks every rule."""
        mode = "generator" if mode is None else mode
        if mode not in ("generator", "checker"):
            raise ValueError(f"mode must be generator or checker, not {_shown(mode)}")
        r = _rulecheck.check_rules(self._r, {"shapes": self._shapes(shapes)}, mode)
        kinds = {_name(o): o["attrs"].get("kind") for o in self._of_kind("rule")}
        vs = []
        for v in r["violations"]:
            name = v.get("rule") if isinstance(v.get("rule"), str) else None
            area = kinds.get(name) == "area"
            t = _rq(v["threshold"]) if "threshold" in v else None
            vs.append(Violation(name, v.get("kind"), tuple(v["subjects"]), self._measured(v["measured"], area),
                                None if t is None else t * (self._grid ** 2 if area else self._grid), v["limit"], v.get("detail")))
        return CheckResult(r["complete"], tuple(vs), tuple(Unsupported(u.get("rule") if isinstance(u.get("rule"), str) else None, u.get("kind"), u["reason"]) for u in r["unsupported"]))

    def recognize(self, shapes: Iterable) -> Recognition:
        """Devices in a layout (the components of each cross's recognition region)
        with the markers over them and their candidate models."""
        out = _rulecheck.recognize_devices(self._r, {"shapes": self._shapes(shapes)})
        devs, uns = [], []
        L = self.nm
        for d in out:
            if "unsupported" in d:
                uns.append(Finding(d.get("cross") if isinstance(d.get("cross"), str) else None, d["unsupported"]))
                continue
            b = d["bbox"]
            devs.append(DeviceInstance(d.get("cross") if isinstance(d.get("cross"), str) else None, (L(b["x0"]), L(b["y0"]), L(b["x1"]), L(b["y1"])), tuple(d["markers"]),
                                       tuple(d["partial"]), MappingProxyType({k: tuple(n if isinstance(n, str) else None for n in v) for k, v in d["models"].items()}),
                                       MappingProxyType(dict(d["selection"]))))
        return Recognition(not uns, tuple(devs), tuple(uns))

    # ---- 17. tool profiles -----------------------------------------------------------------------------

    def profiles(self) -> Tuple[str, ...]:
        return tuple(_name(o) for o in self._of_kind("profile"))

    def supports(self, profile: str, *, source: Optional["Technology"] = None) -> Tuple[Finding, ...]:
        """What the tool `profile` cannot handle in this technology (empty: it can take it).
        The profile is looked up in `source` (default: this technology)."""
        if source is not None and not isinstance(source, Technology):
            raise TypeError("source is a Technology")
        src = source if source is not None else self
        p = src._obj(profile, "profile")
        findings, _ = _profile.check_profile(self._r, p)
        return tuple(Finding(f.get("object") if isinstance(f.get("object"), str) else None, f["message"]) for f in findings)

    def __repr__(self):
        return f"<Technology {len(self._objects)} objects, grid {frac_str(self._grid)} nm, {self.hash}>"


class _BadSize(Exception):
    pass


def _names_text(names) -> str:
    """Names for a message, as JavaScript's join renders them (null as empty)."""
    return ", ".join("" if n is None else str(n) for n in names)


def _optional_name(what, v):
    if v is not None and not isinstance(v, str):
        raise TypeError(f"{what} is a name, not {_shown(v)}")


def _kinds(kind) -> tuple:
    """A rule kind, or a list of them."""
    kinds = (kind,) if isinstance(kind, str) else tuple(kind) if isinstance(kind, (list, tuple)) else None
    if kinds is None or not all(isinstance(k, str) for k in kinds):
        raise TypeError(f"kind is a rule kind or a list of them, not {_shown(kind)}")
    return kinds


def _operands(on) -> tuple:
    """One name, or a list of names."""
    ops = (on,) if isinstance(on, str) else tuple(on) if isinstance(on, (list, tuple)) else None
    if ops is None or not all(isinstance(x, str) for x in ops):
        raise TypeError(f"on is a name or a list of names, not {_shown(on)}")
    return ops


def _one_measure(applied):
    """The common measure of applied rules (AmbiguousError when they differ)."""
    measures = []
    for r, _ in applied:
        m = _measure(r)
        if not any(same_value_zero(m, x) for x in measures):
            measures.append(m)
    if len(measures) > 1:
        raise AmbiguousError(f"rules measure differently (edge and center): {', '.join(r.name or '?' for r, _ in applied)}")
    return measures[0] if measures else "edge"


def _limit(r: Rule):
    """A rule's limit (`limit ?? "min"`)."""
    v = r.attrs.get("limit")
    return "min" if v is None else v


def _measure(r: Rule):
    v = r.attrs.get("measure")
    return "edge" if v is None else v


class Device:
    """A transistor structure (a `cross`): gate, channel, faces, sizes and models. Immutable."""

    __slots__ = ("_t", "_array", "_figure", "name", "gate", "channel_figure", "channel_layer", "faces", "stratum", "sizes", "models")

    def __init__(self, tech: Technology, o):
        a = o["attrs"]
        ch = tech._by.get(ref_of(a.get("channel")))
        array = ch if ch and ch["kind"] == "array" else None
        fig = tech._by.get(ref_of(ch["attrs"].get("of"))) if array else ch
        figure = fig if fig and fig["kind"] == "figure" else None
        faces = a.get("faces")
        sizes = {}
        for c in _list(o.get("children")):
            if c["kind"] != "size" or _name(c) is None:
                continue
            sets = c["attrs"].get("sets")
            sets = sets if isinstance(sets, Mapping) else {}
            target = sets.get("ref") if isinstance(sets.get("ref"), str) else None
            attr = sets.get("attr") if isinstance(sets.get("attr"), str) else None
            tobj = tech._by.get(target) if target is not None else None
            tv = tobj["attrs"].get(attr) if tobj is not None and attr is not None else None
            sizes[c["name"]] = SizeParam(c["name"], target, attr, tech._size(tv, scale=attr != "count"))
        fields = dict(
            _t=tech, _array=array, _figure=figure, name=_name(o), gate=ref_of(a.get("gate")),
            channel_figure=_name(figure) if figure else None,
            channel_layer=ref_of(figure["attrs"].get("layer")) if figure else None,
            faces=_FACES if faces == "all" else tuple(f for f in (faces if isinstance(faces, list) else ()) if f in _FACES),
            stratum=ref_of(a.get("stratum")), sizes=MappingProxyType(sizes),
            models=tuple(Model(m["name"] if isinstance(m["name"], str) else None, m["polarity"] if isinstance(m["polarity"], str) else None,
                               tuple(m["markers"]), tuple(m["exclude"]))
                         for m in (_template.model_selector(c) for c in _list(o.get("children")) if c["kind"] == "model")))
        for k, v in fields.items():
            object.__setattr__(self, k, v)

    def __setattr__(self, key, value):
        raise AttributeError(f"Device is immutable (cannot set {key})")

    def __delattr__(self, key):
        raise AttributeError(f"Device is immutable (cannot delete {key})")

    def _value(self, obj, attr, given, scale):
        """The value of obj.attr: a size parameter's if one sets it, else its own fixed value."""
        for p in self.sizes.values():
            if obj and p.target == obj["name"] and p.attr == attr and p.name in given:
                return given[p.name]
        if not obj:
            return None
        s = self._t._size(obj["attrs"].get(attr), scale=scale)
        if s is None:
            return None
        if s.kind != "fixed":
            name = next((p.name for p in self.sizes.values() if p.target == obj["name"] and p.attr == attr), None)
            raise ValueError(f"{obj['name']}.{attr} is not fixed: give the size {name}" if name else f"{obj['name']}.{attr} is not fixed")
        return s.values[0]

    def w_eff(self, **sizes) -> Fraction:
        """Effective width in nm: count x (n_wide*width + n_side*thickness), where the
        gate covers n_wide of the top/bottom faces and n_side of the left/right faces."""
        given = {}
        for k, v in sizes.items():
            p = self.sizes.get(k)
            if p is None:
                raise ValueError(f"{self.name} has no size {_shown(k)} (sizes: {', '.join(self.sizes) or 'none'})")
            if v is None:                                 # None: this size not given
                continue
            x = _num(v)
            if p.attr == "count" and (x.denominator != 1 or x < 1):
                raise ValueError(f"{k} = {_shown(v)}: a count is a positive integer")
            if p.domain is not None and not p.domain.contains(x):
                raise ValueError(f"{k} = {_shown(v)} is outside its domain {p.domain.kind} {', '.join(frac_str(x) for x in p.domain.values)}")
            given[k] = x
        if not self._figure:
            raise StencilError(f"{self.name}: no channel figure")
        n_wide = sum(f in self.faces for f in ("top", "bottom"))
        n_side = sum(f in self.faces for f in ("left", "right"))
        width = self._value(self._figure, "width", given, True) if n_wide else Fraction(0)
        thick = self._value(self._figure, "thickness", given, True) if n_side else Fraction(0)
        if width is None or thick is None:
            raise StencilError(f"{self.name}: the channel figure has no {'width' if width is None else 'thickness'}")
        count = self._value(self._array, "count", given, False) if self._array else Fraction(1)
        if count is None:
            raise StencilError(f"{self.name}: the channel array has no count")
        return count * (n_wide * width + n_side * thick)

    def select_model(self, polarity: str, markers: Iterable[str] = ()) -> Model:
        """The one model for a device of `polarity` under exactly the `markers` layers."""
        mk = set(_names("markers", markers) or ())
        hits = [m for m in self.models if m.polarity == polarity and set(m.markers) <= mk and not (set(m.exclude) & mk)]
        if len(hits) != 1:
            raise AmbiguousError(f"{self.name}: {len(hits)} models for polarity {_text(polarity)} with markers {sorted(mk, key=utf16)}"
                                 + (f": {_names_text(m.name for m in hits)}" if hits else ""))
        return hits[0]

    def __repr__(self):
        return f"<Device {self.name}: gate {self.gate}, channel {self.channel_figure} on {self.channel_layer}, faces {self.faces}>"
