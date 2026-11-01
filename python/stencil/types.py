"""Result types of the query API (doc/API.md). Lengths are exact Fractions in
nanometres (areas in nm^2); every type is a frozen dataclass."""
from __future__ import annotations

from dataclasses import dataclass, field
from fractions import Fraction
from typing import Mapping, Optional, Tuple

from ._util import parse_number

Q = Fraction


@dataclass(frozen=True)
class Size:
    """A dimension that may be fixed, a choice, a range, or (array counts) "fill"."""
    kind: str                       # "fixed" | "one_of" | "range" | "fill"
    values: Tuple[Q, ...]           # range: (min, max); fill: ()

    @property
    def min(self) -> Optional[Q]:
        return min(self.values) if self.values else None

    @property
    def max(self) -> Optional[Q]:
        return max(self.values) if self.values else None

    @property
    def fixed(self) -> Optional[Q]:
        return self.values[0] if self.kind == "fixed" else None

    def contains(self, x) -> bool:
        x = parse_number(x)
        if self.kind == "range":
            return self.values[0] <= x <= self.values[1]
        if self.kind == "fill":
            return x > 0 and x.denominator == 1
        return x in self.values


@dataclass(frozen=True)
class Layer:
    name: str
    order: Optional[int]            # 1 = bottom
    role: Optional[str]             # "channel" | "conductor" | "cut" | "marker"
    side: Optional[str]             # "back" | "device" | "front"
    direction: Optional[str]        # "horizontal" | "vertical" | "none"
    width: Optional[Size]
    pitch: Optional[Q]              # the layer's lattice (its own, or its track array's)
    offset: Optional[Q]
    masks: int
    tracks_mode: Optional[str]      # effective mode of a conductor: "required" | "access" | "none"
    gds: Optional[Tuple[int, int]]
    gds_pin: Optional[Tuple[int, int]]
    gds_label: Optional[Tuple[int, int]]
    derived: bool                   # computed from other layers (from = ...)
    note: Optional[str]


@dataclass(frozen=True)
class Via:
    name: str
    lower: Tuple[str, ...]
    cut: Optional[str]
    upper: Optional[str]
    size: Optional[Tuple[Q, Q]]     # (x, y)
    enclose_lower: Tuple[Q, Q]      # (x, y); (0, 0) when not given
    enclose_upper: Tuple[Q, Q]


@dataclass(frozen=True)
class Rail:
    name: str
    net: str
    layer: Optional[str]
    y: Q
    width: Optional[Q]
    shared_with: Tuple[str, ...]    # other rails merged into this one (same net, layer and height)


@dataclass(frozen=True)
class Band:
    name: str
    polarity: str                   # "n" | "p"
    stratum: Optional[str]
    y0: Q
    y1: Q
    flipped: bool


@dataclass(frozen=True)
class EdgeFeature:
    name: str
    layer: Optional[str]
    side: str                       # "left" | "right" | "top" | "bottom"
    shared: bool
    x0: Q
    y0: Q
    x1: Q
    y1: Q


@dataclass(frozen=True)
class TrackGrid:
    name: str
    layer: str
    axis: str                       # the coordinate the positions are along: "x" | "y"
    positions: Tuple[Q, ...]
    usable: Tuple[int, ...]         # indices into positions, 0-based
    span: Tuple[Q, Q]               # the row it belongs to


@dataclass(frozen=True)
class SiteTemplate:
    name: str
    width: Q                        # the placement unit
    cell_width: Q
    units: int
    height: Q
    rails: Tuple[Rail, ...]
    bands: Tuple[Band, ...]
    edges: Tuple[EdgeFeature, ...]
    pins: Tuple[str, ...]
    boundary: Optional[str]
    symmetry: Tuple[str, ...]
    grids: Tuple[TrackGrid, ...] = field(repr=False)

    def tracks(self, layer: str) -> Tuple[TrackGrid, ...]:
        """The track grids on `layer`, one per row that has one."""
        return tuple(g for g in self.grids if g.layer == layer)


@dataclass(frozen=True)
class RuleValue:
    value: Optional[Q]              # None: rules exist, none applies to the query
    limit: str                      # "min" | "max" | "exact"
    rules: Tuple[str, ...]          # the rules that set the value
    measure: str = "edge"           # "edge" | "center" (cut_spacing measure = center)


@dataclass(frozen=True)
class Margins:
    left: Q
    right: Q
    bottom: Q
    top: Q


@dataclass(frozen=True)
class Rule:
    name: str
    kind: str
    on: Tuple[str, ...]
    intent: str
    attrs: Mapping[str, object]               # lengths in nm (area values in nm^2), references as names
    children: Tuple[Mapping[str, object], ...]  # table / alternative / case: {kind, name, attrs}


@dataclass(frozen=True)
class Model:
    name: str
    polarity: Optional[str]
    markers: Tuple[str, ...]
    exclude: Tuple[str, ...]


@dataclass(frozen=True)
class SizeParam:
    name: str
    target: str                     # e.g. nfin -> FINS.count
    attr: str
    domain: Optional[Size]          # counts are plain numbers, lengths nm


@dataclass(frozen=True)
class Shape:
    layer: str
    rect: Tuple[Q, Q, Q, Q]         # x0, y0, x1, y1 in nm, on the grid
    net: Optional[str] = None
    color: Optional[int] = None
    connector: Optional[str] = None


@dataclass(frozen=True)
class Violation:
    rule: str
    kind: str
    shapes: Tuple[int, ...]         # indices into the input
    measured: str                   # in nm (nm^2 for area); "sqrt(x)" for Euclidean distances
    threshold: Optional[Q]
    limit: str
    detail: Optional[str] = None


@dataclass(frozen=True)
class Unsupported:
    rule: str
    kind: Optional[str]
    reason: str


@dataclass(frozen=True)
class CheckResult:
    complete: bool
    violations: Tuple[Violation, ...]
    unsupported: Tuple[Unsupported, ...]


@dataclass(frozen=True)
class DeviceInstance:
    device: str
    bbox: Tuple[Q, Q, Q, Q]
    markers: Tuple[str, ...]        # marker layers covering the device
    partial: Tuple[str, ...]        # marker layers touching it without covering it
    models: Mapping[str, Tuple[str, ...]]     # polarity -> candidates
    selection: Mapping[str, str]              # polarity -> "ok" | "none" | "ambiguous"


@dataclass(frozen=True)
class Finding:
    object: str
    message: str


@dataclass(frozen=True)
class Recognition:
    complete: bool
    devices: Tuple[DeviceInstance, ...]
    unsupported: Tuple[Finding, ...]          # crosses that could not be evaluated


@dataclass(frozen=True)
class Diagnostic:
    code: str
    severity: str
    message: str
    file: Optional[str]
    line: Optional[int]
    col: Optional[int]
    hint: Optional[str] = None
