"""Helpers shared by the ports of the JavaScript reference modules.

The ports in this package (template, rulecheck, profile) mirror core/*.js
statement for statement, so the two implementations can be compared on raw
output. These helpers stand in for the JavaScript semantics they rely on:
undefined vs null, truthiness, nullish defaults, equality, ToNumber and
relational comparison, template-literal formatting, BigInt conversion.

Input contract of the ports: a structurally valid resolved form (objects
with a `kind`, an `attrs` object and a `children` array); attribute values
may be anything JSON can hold.
"""
from __future__ import annotations

import math
import re
from decimal import Decimal
from fractions import Fraction

# JavaScript `undefined` (a missing key), as opposed to None (JSON null).
UNDEF = object()


def nn(v, default):
    """`v ?? default`: default when v is undefined or null."""
    return default if v is UNDEF or v is None else v


def _big_float(n: int) -> float:
    """An integer as a Number: Infinity past the double range."""
    try:
        return float(n)
    except OverflowError:
        return math.inf


def units16(s: str) -> list:
    """A string's UTF-16 code units, as one-unit strings (lone surrogates kept)."""
    b = s.encode("utf-16-le", "surrogatepass")
    return [b[i:i + 2].decode("utf-16-le", "surrogatepass") for i in range(0, len(b), 2)]


def _map_key(v):
    """A hashable key that is equal exactly when the values are SameValueZero."""
    t = jtype(v)
    if t == "number":
        return ("number", "nan" if v != v else float(v))
    if t in ("string", "boolean"):
        return (t, v)
    if t in ("undefined", "null"):
        return (t,)
    return ("object", id(v))


class JSMap:
    """A JavaScript Map: any JSON value as a key, compared by SameValueZero."""

    def __init__(self, pairs=()):
        self._d = {}
        for k, v in pairs:
            self.set(k, v)

    def set(self, key, value):
        k = _map_key(key)
        self._d[k] = (self._d[k][0] if k in self._d else key, value)

    def get(self, key, default=None):
        hit = self._d.get(_map_key(key))
        return hit[1] if hit else default

    def has(self, key):
        return _map_key(key) in self._d

    @property
    def items(self):
        return list(self._d.values())


def jindex(v, i):
    """`v[i]` for an integer index on a JSON value (objects use the key "i"; strings
    index UTF-16 code units)."""
    if isinstance(v, str):
        u = units16(v)
        return u[i] if 0 <= i < len(u) else UNDEF
    if isinstance(v, list):
        return v[i] if 0 <= i < len(v) else UNDEF
    if isinstance(v, dict):
        return v.get(str(i), UNDEF)
    if v is None or v is UNDEF:
        raise TypeError(f"Cannot read properties of {'null' if v is None else 'undefined'} (reading '{i}')")
    return UNDEF


def jlength(v):
    """`v.length` on a JSON value."""
    if isinstance(v, str):
        return len(v.encode("utf-16-le", "surrogatepass")) // 2
    if isinstance(v, list):
        return len(v)
    if isinstance(v, dict):
        return v.get("length", UNDEF)
    if v is None or v is UNDEF:
        raise TypeError("Cannot read properties of null (reading 'length')")
    return UNDEF


def jget(d, key):
    """`d?.[key]` on a JSON value: UNDEF when d is not an object or lacks key."""
    if isinstance(d, dict):
        return d.get(key, UNDEF)
    return UNDEF


def is_num(v) -> bool:
    """Number.isFinite on a JSON value (bool is not a number)."""
    return type(v) in (int, float) and math.isfinite(v)


def is_int(v) -> bool:
    """Number.isInteger on a JSON value."""
    return (type(v) is int) or (type(v) is float and math.isfinite(v) and v == int(v))


def truthy(v) -> bool:
    """JavaScript truthiness of a JSON value ([] and {} are true)."""
    if v is UNDEF or v is None or v is False:
        return False
    if type(v) in (int, float):
        return v == v and v != 0
    if isinstance(v, str):
        return v != ""
    return True


def is_ref(v) -> bool:
    return isinstance(v, dict) and isinstance(v.get("ref"), str)


def ref_of(v):
    """`v?.ref` with undefined and null both as None (for name lookups)."""
    return v.get("ref") if isinstance(v, dict) else None


def jref(v):
    """`v?.ref` keeping undefined (UNDEF) apart from null (None)."""
    return v.get("ref", UNDEF) if isinstance(v, dict) else UNDEF


def list_of(v, ok):
    return v if isinstance(v, list) and all(ok(x) for x in v) else None


def jtype(v) -> str:
    if v is UNDEF:
        return "undefined"
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if type(v) in (int, float):
        return "number"
    if isinstance(v, str):
        return "string"
    return "object"


def same_value_zero(a, b) -> bool:
    """SameValueZero (Set membership, Array.prototype.includes)."""
    ta, tb = jtype(a), jtype(b)
    if ta != tb:
        return False
    if ta == "number":
        return a == b or (a != a and b != b)
    if ta == "object":
        return a is b
    return ta in ("undefined", "null") or a == b


def strict_eq(a, b) -> bool:
    """`a === b`."""
    if jtype(a) == "number" and jtype(b) == "number":
        return a == b
    return same_value_zero(a, b)


def to_primitive(v, hint="number"):
    """ToPrimitive for a JSON value. A JSON object's own `toString` key shadows the
    inherited method with a non-callable value, so converting it is a TypeError."""
    if isinstance(v, list):
        return join(v, ",")
    if isinstance(v, dict):
        if "toString" in v:
            raise TypeError("Cannot convert object to primitive value")
        return "[object Object]"
    return v


def to_string(v) -> str:
    """ToString."""
    return js(v)


def includes(container, x) -> bool:
    """`container.includes(x)` for an array or a string; TypeError otherwise."""
    if isinstance(container, list):
        return any(same_value_zero(e, x) for e in container)
    if isinstance(container, str):                      # String.prototype.includes, on UTF-16 code units
        hay, needle = units16(container), units16(to_string(x))
        n = len(needle)
        return any(hay[i:i + n] == needle for i in range(len(hay) - n + 1))
    raise TypeError("includes() on a value that is neither an array nor a string")


def join(v, sep) -> str:
    """`v.join(sep)` for an array; TypeError otherwise."""
    if not isinstance(v, list):
        raise TypeError("join() on a value that is not an array")
    return sep.join("" if e is None or e is UNDEF else to_string(e) for e in v)


_JS_NUM = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", re.ASCII)
# ECMAScript WhiteSpace and LineTerminator (what StringToNumber trims).
_JS_SPACE = ("\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
             "\u2028\u2029\u202f\u205f\u3000\ufeff")


def js_num(v) -> float:
    """ToNumber."""
    t = jtype(v)
    if t == "undefined":
        return math.nan
    if t == "null":
        return 0.0
    if t == "boolean":
        return 1.0 if v else 0.0
    if t == "number":
        return v
    if t == "string":
        s = v.strip(_JS_SPACE)
        if s == "":
            return 0.0
        if re.fullmatch(r"0[xX][0-9a-fA-F]+", s):
            return _big_float(int(s, 16))
        if re.fullmatch(r"0[oO][0-7]+", s):
            return _big_float(int(s[2:], 8))
        if re.fullmatch(r"0[bB][01]+", s):
            return _big_float(int(s[2:], 2))
        if s in ("Infinity", "+Infinity", "-Infinity") or _JS_NUM.fullmatch(s):
            return float(s)
        return math.nan
    return js_num(to_primitive(v, "number"))


def _relational(a, b):
    """The primitives IsLessThan compares (strings stay strings only when both are)."""
    pa, pb = to_primitive(a, "number"), to_primitive(b, "number")
    if isinstance(pa, str) and isinstance(pb, str):
        return utf16(pa), utf16(pb)
    return js_num(pa), js_num(pb)


def js_lt(a, b) -> bool:
    """`a < b`."""
    x, y = _relational(a, b)
    return x < y


def js_le(a, b) -> bool:
    """`a <= b` (false when either side is NaN)."""
    x, y = _relational(a, b)
    if isinstance(x, float) and (x != x or y != y):
        return False
    return x <= y


def js_max(*vs) -> float:
    """Math.max(...vs)."""
    ns = [js_num(v) for v in vs]
    if any(n != n for n in ns):
        return math.nan
    return max(ns, default=-math.inf)


def js_min(*vs) -> float:
    ns = [js_num(v) for v in vs]
    if any(n != n for n in ns):
        return math.nan
    return min(ns, default=math.inf)


def utf16(s: str) -> bytes:
    """Sort key giving JavaScript's (UTF-16 code unit) string order."""
    return s.encode("utf-16-be", "surrogatepass")


def bigint(v) -> int:
    """BigInt(v) of a JSON number: RangeError (ValueError) unless it is an integer."""
    if jtype(v) != "number" or not is_int(v):
        raise ValueError(f"The number {js(v)} cannot be converted to a BigInt because it is not an integer")
    return int(v)


# Python caps int <-> decimal string conversion (4300 digits by default, 640 at
# the lowest setting); JavaScript's BigInt does not. These convert in chunks
# below the lowest cap.
_CHUNK = 600


def dec_int(s: str) -> int:
    """int() of a decimal string of any length."""
    neg = s.startswith("-")
    digits = s[1:] if neg or s.startswith("+") else s
    digits = digits.lstrip("0") or "0"
    n = 0
    for i in range(0, len(digits), _CHUNK):
        chunk = digits[i:i + _CHUNK]
        n = n * 10 ** len(chunk) + int(chunk)
    return -n if neg else n


def dec_str(n: int) -> str:
    """str() of an integer of any size."""
    if -10 ** _CHUNK < n < 10 ** _CHUNK:
        return str(n)
    neg, n = n < 0, abs(n)
    base, parts = 10 ** _CHUNK, []
    while n >= base:
        n, r = divmod(n, base)
        parts.append(str(r).zfill(_CHUNK))
    parts.append(str(n))
    return ("-" if neg else "") + "".join(reversed(parts))


def shown(x) -> str:
    """A value for an error message: numbers of any size, never a formatting error."""
    if isinstance(x, (int, Fraction)) and not isinstance(x, bool):
        return frac_str(x)
    try:
        return repr(x)
    except Exception:                                 # noqa: BLE001 - a huge integer inside, or a failing __repr__
        try:
            return f"<{type(x).__name__}>"
        except Exception:                             # noqa: BLE001
            return "<value>"


def text(x) -> str:
    """A string field of a message as itself; anything else via shown()."""
    return x if isinstance(x, str) else shown(x)


def frac_str(q) -> str:
    """A rational as "n" or "n/d", of any size."""
    q = Fraction(q)
    return dec_str(q.numerator) if q.denominator == 1 else f"{dec_str(q.numerator)}/{dec_str(q.denominator)}"


_Q_FRAC = re.compile(r"-?\d+/\d+", re.ASCII)
_Q_INT = re.compile(r"-?\d+", re.ASCII)


def to_q(v):
    """core/rulecheck.js toQ(): integers and "n/d" / "n" strings -> Fraction, other
    values None; a non-integral number or a zero denominator raises (RangeError)."""
    if jtype(v) == "number":
        return Fraction(bigint(v))
    if isinstance(v, str) and _Q_FRAC.fullmatch(v):
        n, d = v.split("/")
        if dec_int(d) == 0:
            raise ValueError("division by zero")
        return Fraction(dec_int(n), dec_int(d))
    if isinstance(v, str) and _Q_INT.fullmatch(v):
        return Fraction(dec_int(v))
    return None


def qstr(q: Fraction) -> str:
    return frac_str(q)


def js_number_str(x) -> str:
    """Number.prototype.toString()."""
    if x != x:
        return "NaN"
    if x in (math.inf, -math.inf):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    if type(x) is int and abs(x) < 10 ** 21:
        return str(x)
    if type(x) is int:                                  # beyond 1e21 JavaScript prints the nearest double
        try:
            x = float(x)
        except OverflowError:
            return "Infinity" if x > 0 else "-Infinity"
    x = float(x)
    sign = "-" if x < 0 else ""
    d = Decimal(repr(abs(x))).normalize()
    _, digits, exp = d.as_tuple()
    ds = "".join(map(str, digits))
    k = len(ds)
    n = exp + k                                   # value = 0.ds x 10^n
    if k <= n <= 21:
        out = ds + "0" * (n - k)
    elif 0 < n <= 21:
        out = ds[:n] + "." + ds[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + ds
    else:
        e = n - 1
        out = (ds if k == 1 else ds[0] + "." + ds[1:]) + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


def js(v) -> str:
    """Template-literal formatting of a JSON value, as in `${v}`."""
    t = jtype(v)
    if t == "undefined":
        return "undefined"
    if t == "null":
        return "null"
    if t == "boolean":
        return "true" if v else "false"
    if t == "number":
        return js_number_str(v)
    if t == "string":
        return v
    if isinstance(v, list):
        return join(v, ",")
    return to_primitive(v, "string")


# Number strings: the same grammar as the JavaScript API.
_NUM_RE = re.compile(r"(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?", re.ASCII)
_RAT_RE = re.compile(r"-?\d+/\d+", re.ASCII)


def parse_number(x) -> Fraction:
    """An input number, exactly: int, Fraction, float (its exact binary value) or a
    string "12", "-14.5", "1e-3", "29/2"."""
    if isinstance(x, bool) or x is None:
        raise TypeError(f"expected a number, got {shown(x)}")
    if isinstance(x, float):
        if not math.isfinite(x):
            raise ValueError(f"not a finite number: {shown(x)}")
        return Fraction(x)
    if isinstance(x, (int, Fraction)):
        return Fraction(x)
    if isinstance(x, str):
        s = x.strip(_JS_SPACE)                          # String.prototype.trim()
        if _RAT_RE.fullmatch(s):
            n, d = s.split("/")
            if dec_int(d) == 0:
                raise ValueError(f"not a number: {shown(x)} (zero denominator)")
            return Fraction(dec_int(n), dec_int(d))
        m = _NUM_RE.fullmatch(s)
        if m:                                       # digits of any length, as JavaScript reads them
            sign, whole, frac, exp = m.groups()
            frac = (frac or "").rstrip("0")
            q = Fraction(dec_int(whole + frac), 10 ** len(frac))
            if exp:
                e = dec_int(exp)
                q = q * 10 ** e if e >= 0 else q / 10 ** -e
            return -q if sign else q
        raise ValueError(f"not a number: {shown(x)}")
    raise TypeError(f"expected a number, got {type(x).__name__}")
