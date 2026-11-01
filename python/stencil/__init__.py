"""Stencil query API: what a cell generator needs to know about a technology.

    from stencil import Technology
    t = Technology.load("pdk/gt2n/bspdn.stencil", root="examples")
    t.min_spacing("M1", axis="x").value      # Fraction, nm

See doc/API.md. Lengths are exact Fractions in nanometres.
"""
from .errors import AmbiguousError, ResolveError, StencilError, UnknownName, UnresolvedRuleError
from .technology import Device, Technology
from .types import (
    Band, CheckResult, DeviceInstance, Diagnostic, EdgeFeature, Finding, Layer, Margins, Model, Rail, Recognition,
    Rule, RuleValue, Shape, SiteTemplate, Size, SizeParam, TrackGrid, Unsupported, Via, Violation,
)

__version__ = "0.1.0"
__all__ = [
    "Technology", "Device", "StencilError", "ResolveError", "UnknownName", "AmbiguousError", "UnresolvedRuleError",
    "Band", "CheckResult", "DeviceInstance", "Diagnostic", "EdgeFeature", "Finding", "Layer", "Margins", "Model", "Rail",
    "Recognition", "Rule", "RuleValue", "Shape", "SiteTemplate", "Size", "SizeParam", "TrackGrid", "Unsupported", "Via",
    "Violation",
]
