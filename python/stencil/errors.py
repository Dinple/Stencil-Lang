"""Typed errors of the query API."""
from __future__ import annotations


class StencilError(Exception):
    """Base class of every error the query API raises."""


class ResolveError(StencilError):
    """The technology did not resolve cleanly; `.diagnostics` says why."""

    def __init__(self, message, diagnostics=()):
        super().__init__(message)
        self.diagnostics = tuple(diagnostics)


class UnknownName(StencilError, LookupError):
    """No object of the expected kind has that name."""


class AmbiguousError(StencilError):
    """The query matches several answers (or none) where it needs exactly one."""


class UnresolvedRuleError(StencilError):
    """A rule query cannot be decided from the conditions given.

    `.rules` lists (rule name, what it needs), pass the condition, or leave
    the rule out deliberately with ignore=(...)."""

    def __init__(self, rules):
        self.rules = tuple(rules)
        super().__init__("cannot decide " + "; ".join(f"{name} (needs {need})" for name, need in self.rules)
                         + ", pass the condition, or ignore=(...) to leave a rule out")
