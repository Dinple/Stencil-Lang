"""Canonical bytes and hash of a resolved description (SPEC.md section 5), port of core/canon.js.

JCS (RFC 8785) over the resolved form: sorted keys (UTF-16 order) and
JSON.stringify scalars; source locations, the invalid flag and the hash
itself are not content."""
from __future__ import annotations

import hashlib
import json

from ._util import js_number_str, utf16

NOT_CONTENT = {"src", "attr_src", "invalid", "hash"}


_SHORT = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def json_string(s: str) -> str:
    """JSON.stringify of a string (well-formed: lone surrogates escaped as \\udxxx)."""
    out = []
    for ch in s:
        c = ord(ch)
        if ch in _SHORT:
            out.append(_SHORT[ch])
        elif c < 0x20 or 0xD800 <= c <= 0xDFFF:          # a surrogate left in a Python str is a lone one
            out.append(f"\\u{c:04x}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def _scalar(v) -> str:
    if v is None or v is True or v is False:
        return json.dumps(v)
    if isinstance(v, str):
        return json_string(v)
    if isinstance(v, (int, float)):
        return "null" if v != v or v in (float("inf"), float("-inf")) else js_number_str(v)
    raise TypeError(f"not JSON: {type(v).__name__}")


def canonical(v) -> str:
    if isinstance(v, list):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted((k for k in v if k not in NOT_CONTENT), key=utf16)
        return "{" + ",".join(f"{json_string(k)}:{canonical(v[k])}" for k in keys) + "}"
    return _scalar(v)


def hash_resolved(resolved) -> str:
    return "sha256:" + hashlib.sha256(canonical(resolved).encode("utf-8")).hexdigest()
