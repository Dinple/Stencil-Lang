"""Python-specific API behaviour: loading, errors, input forms. The query
semantics themselves are in the shared cases (test_queries.py)."""
import json
import os
import re
import shutil
import sys
import unittest
from fractions import Fraction
from pathlib import Path

import stencil
from stencil import (AmbiguousError, ResolveError, Shape, StencilError, Technology, UnknownName,
                     UnresolvedRuleError)

HERE = Path(__file__).parent
DATA = HERE / "data"
EXAMPLES = HERE.parent.parent / "examples"
NODE = os.environ.get("STENCIL_NODE") or shutil.which("node")


def fixture(name):
    return Technology.from_json(DATA / "examples" / f"{name}.json")


class Loading(unittest.TestCase):
    def test_from_json_reads_a_bundle_a_resolved_form_or_a_mapping(self):
        bundle = json.loads((DATA / "examples" / "gt2n_bspdn.json").read_text(encoding="utf-8"))
        a = Technology.from_json(DATA / "examples" / "gt2n_bspdn.json")
        b = Technology.from_json(bundle["resolved"])
        c = Technology.from_json(bundle)
        self.assertEqual(a.hash, b.hash)
        self.assertEqual(a.hash, c.hash)
        self.assertTrue(a.hash.startswith("sha256:"))
        self.assertTrue(a.complete)
        self.assertEqual(b.diagnostics, ())

    def test_not_a_technology(self):
        with self.assertRaises(StencilError):
            Technology.from_json({"stencil": "0.1"})

    def test_an_incomplete_form_is_refused_unless_allowed(self):
        r = dict(json.loads((DATA / "examples" / "level0_routing.json").read_text(encoding="utf-8"))["resolved"], complete=False)
        with self.assertRaises(ResolveError):
            Technology.from_json(r)
        self.assertFalse(Technology.from_json(r, allow_incomplete=True).complete)

    @unittest.skipUnless(NODE, "needs Node")
    def test_load_resolves_like_the_fixture(self):
        t = Technology.load(EXAMPLES / "pdk" / "gt2n" / "bspdn.stencil", root=EXAMPLES, node=NODE)
        self.assertEqual(t.hash, fixture("gt2n_bspdn").hash)
        self.assertEqual([d for d in t.diagnostics if d.severity == "error"], [])

    @unittest.skipUnless(NODE, "needs Node")
    def test_load_reports_resolution_errors(self):
        with self.assertRaises(ResolveError) as e:
            Technology.load(DATA / "src" / "broken.stencil", node=NODE)
        self.assertTrue(any(d.severity == "error" and d.line == 3 for d in e.exception.diagnostics))
        self.assertIn("broken.stencil:3", str(e.exception))
        t = Technology.load(DATA / "src" / "broken.stencil", node=NODE, allow_incomplete=True)
        self.assertFalse(t.complete)

    def test_load_needs_the_file(self):
        with self.assertRaises(FileNotFoundError):
            Technology.load(DATA / "src" / "missing.stencil", node=NODE or "node")


class LoadingPaths(unittest.TestCase):
    @unittest.skipUnless(NODE, "needs Node")
    def test_a_relative_main_is_relative_to_root(self):
        here = os.getcwd()
        os.chdir(HERE)                                   # unrelated working directory
        try:
            t = Technology.load("pdk/gt2n/bspdn.stencil", root=EXAMPLES, node=NODE)
        finally:
            os.chdir(here)
        self.assertEqual(t.hash, fixture("gt2n_bspdn").hash)

    def test_an_explicit_resolver_must_exist(self):
        with self.assertRaises(StencilError):
            Technology.load(EXAMPLES / "level0_routing.stencil", node=NODE or "node", cli=DATA / "no_cli.mjs")
        old = os.environ.get("STENCIL_CLI")
        os.environ["STENCIL_CLI"] = str(DATA / "no_cli.mjs")
        try:
            with self.assertRaises(StencilError):
                Technology.load(EXAMPLES / "level0_routing.stencil", node=NODE or "node")
        finally:
            if old is None:
                del os.environ["STENCIL_CLI"]
            else:
                os.environ["STENCIL_CLI"] = old

    @unittest.skipUnless(NODE, "needs Node")
    def test_a_resolver_named_explicitly(self):
        t = Technology.load(EXAMPLES / "level0_routing.stencil", node=NODE, cli=HERE.parent.parent / "cli.mjs")
        self.assertEqual(t.hash, fixture("level0_routing").hash)

    @unittest.skipUnless(NODE, "needs Node")
    def test_a_vendored_resolver_works_outside_the_checkout(self):
        sys.path.insert(0, str(HERE.parent / "tools"))
        import vendor_resolver
        dest = HERE.parent / "build" / "resolver_test"       # project tree, not /tmp (gitignored)
        cli = vendor_resolver.vendor(dest)
        try:
            t = Technology.load(EXAMPLES / "pdk" / "gt2n" / "bspdn.stencil", root=EXAMPLES, node=NODE, cli=cli)
            self.assertEqual(t.hash, fixture("gt2n_bspdn").hash)
            imported = {m for f in (dest / "core").glob("*.js") for m in re.findall(r"from '\./([\w.]+)'", f.read_text(encoding="utf-8"))}
            self.assertTrue(imported <= {p.name for p in (dest / "core").glob("*.js")})
        finally:
            shutil.rmtree(dest)

    def test_the_hash_is_computed_when_absent(self):
        r = dict(json.loads((DATA / "examples" / "query_rules.json").read_text(encoding="utf-8"))["resolved"])
        h = r.pop("hash")
        self.assertEqual(Technology.from_json(r).hash, h)

    def test_integers_beyond_2_53_are_refused(self):
        r = json.loads((DATA / "examples" / "query_rules.json").read_text(encoding="utf-8"))["resolved"]
        with self.assertRaises(StencilError):
            Technology.from_json({**r, "objects": [*r["objects"], {"kind": "layer", "name": "Z", "attrs": {"order": 2 ** 53}}]})

    def test_lone_surrogates_hash_like_javascript(self):
        r = {"objects": [{"kind": "layer", "name": "A", "attrs": {"note": "\ud800"}, "children": []}]}
        # the digest JavaScript's hashResolved() gives for this form (tests/query_api.test.mjs checks the same value)
        self.assertEqual(Technology.from_json(r).hash, "sha256:ff0ad75012558349781af20e6f656d8b0323d03a207df41035426e04aa835975")

    def test_constructor_options(self):
        r = json.loads((DATA / "examples" / "invalid_rule.json").read_text(encoding="utf-8"))["resolved"]
        self.assertFalse(Technology(r, None, allow_incomplete=True).complete)   # diagnostics=None is "none"
        for bad in ([], 0, "yes"):
            with self.assertRaises(TypeError):
                Technology(r, allow_incomplete=bad)
        with self.assertRaises(ResolveError):
            Technology(r, allow_incomplete=None)                               # None is the default, False
        with self.assertRaises(TypeError):
            Technology(r, {}, allow_incomplete=True)                           # diagnostics is a list

    def test_structure_is_validated(self):
        r = json.loads((DATA / "examples" / "query_rules.json").read_text(encoding="utf-8"))["resolved"]
        for bad in ({**r, "objects": [*r["objects"], {"kind": "layer", "name": "X"}]},
                    {**r, "objects": [*r["objects"], {"kind": "rule", "name": "Y", "attrs": {}, "children": [None]}]},
                    {**r, "objects": "none"}):
            with self.assertRaises(StencilError):
                Technology.from_json(bad)


class Values(unittest.TestCase):
    def setUp(self):
        self.t = fixture("query_rules")

    def test_lengths_are_exact_fractions(self):
        v = self.t.min_length("M1", scopes=["HOT"]).value
        self.assertIsInstance(v, Fraction)
        self.assertEqual(v, Fraction(121, 2))
        self.assertIsInstance(self.t.via("M1", "M2").size[0], Fraction)

    def test_inputs_accept_int_fraction_str_and_float(self):
        for w in (20, Fraction(20), "20", 20.0, "20.0"):
            self.assertEqual(self.t.min_spacing("M1", width=w, prl=60, same_net=False, same_color=False).value, 18)
        with self.assertRaises(TypeError):
            self.t.dbu(True)
        with self.assertRaises(ValueError):
            self.t.dbu("wide")

    def test_errors_are_typed(self):
        self.assertTrue(issubclass(UnknownName, LookupError))
        for err in (UnknownName, AmbiguousError, UnresolvedRuleError, ResolveError):
            self.assertTrue(issubclass(err, StencilError))
        with self.assertRaises(UnresolvedRuleError) as e:
            self.t.min_width("M1")
        self.assertEqual(e.exception.rules, (("M1_WX", "axis"),))
        self.assertIn("M1_WX (needs axis)", str(e.exception))

    def test_results_are_frozen(self):
        v = self.t.min_area("M1")
        with self.assertRaises(Exception):
            v.value = 0
        fet = self.t.device("FET")
        with self.assertRaises(AttributeError):
            fet.name = "X"
        for field in ("name", "sizes", "_t"):
            with self.assertRaises(AttributeError):
                delattr(fet, field)
        with self.assertRaises(TypeError):
            fet.sizes["x"] = 1
        with self.assertRaises(TypeError):
            self.t.rules(kind="spacing")[0].attrs["value"] = 0

    def test_ignore_may_be_any_iterable(self):
        more = fixture("query_more")
        self.assertEqual(more.enclosure("V", "A", ignore=iter(["V_GA"])), more.enclosure("V", "A", ignore=["V_GA"]))
        self.assertEqual(more.min_width("A", ignore=(n for n in ["RA_W"])).value, 6)

    def test_size_contains_uses_the_number_grammar(self):
        w = self.t.layer("M1").width                       # a range, 10 .. 40 nm
        self.assertTrue(w.contains("12.5") and w.contains(Fraction(20)) and not w.contains("41"))
        for bad, err in ((True, TypeError), ("+1", ValueError), ("1/0", ValueError), (None, TypeError)):
            with self.assertRaises(err):
                w.contains(bad)

    def test_floats_are_read_exactly(self):
        # the approved float policy: a float is its exact binary value (JavaScript reads 0.3 as 3/10)
        r = json.loads((DATA / "examples" / "level0_routing.json").read_text(encoding="utf-8"))["resolved"]
        fine = Technology.from_json({**r, "grid_nm": "1/10"})
        with self.assertRaises(ValueError):
            fine.dbu(0.3)
        self.assertEqual(fine.dbu("0.3"), 3)
        self.assertEqual(fine.dbu(Fraction(3, 10)), 3)


class DigitLimit(unittest.TestCase):
    def test_the_shared_cases_pass_at_the_lowest_integer_string_limit(self):
        """Python can cap int <-> str conversion at 640 digits (PYTHONINTMAXSTRDIGITS)."""
        import subprocess
        env = dict(os.environ, PYTHONINTMAXSTRDIGITS="640", PYTHONDONTWRITEBYTECODE="1")
        p = subprocess.run([sys.executable, "-m", "unittest", "tests.test_queries"], cwd=HERE.parent, env=env,
                           capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(p.returncode, 0, p.stderr[-3000:])
        self.assertIn("OK", p.stderr)


class HugeValues(unittest.TestCase):
    """Rejections keep their typed errors whatever the size of the rejected value."""

    def setUp(self):
        self.t = fixture("query_rules")
        self.n = 10 ** 5000

    def test_typed_errors_survive_huge_arguments(self):
        n = self.n
        with self.assertRaises(StencilError):
            Technology.from_json({"objects": [], "x": n})
        for call, err in ((lambda: self.t.rules(include_checker_only=n), TypeError), (lambda: self.t.nm(Fraction(n, 3)), TypeError),
                          (lambda: self.t.layers(role=n), TypeError), (lambda: self.t.layers(role=[n]), TypeError),
                          (lambda: self.t.nm(n), ValueError), (lambda: self.t.dbu(n), ValueError),
                          (lambda: self.t.min_spacing("M1", same_net=n), TypeError), (lambda: self.t.site("CORE", units=-n), ValueError),
                          (lambda: self.t.device("FET").w_eff(nfin=n), ValueError), (lambda: self.t.layer(n), UnknownName)):
            with self.assertRaises(err):
                call()

    def test_typed_errors_in_messages_built_from_odd_values(self):
        n = self.n
        with self.assertRaises(stencil.AmbiguousError):
            self.t.device("FET").select_model(n)
        with self.assertRaises(ResolveError):
            Technology({"objects": [], "complete": False}, [{"severity": "error", "message": n, "line": [n], "file": object()}])

        class BadRepr:
            def __repr__(self):
                raise RuntimeError("broken representation")

        for call, err in ((lambda: self.t.layers(role=BadRepr()), TypeError), (lambda: self.t.min_spacing("M1", same_net=BadRepr()), TypeError),
                          (lambda: self.t.layer(BadRepr()), UnknownName), (lambda: self.t.dbu(BadRepr()), TypeError),
                          (lambda: self.t.device("FET").select_model(BadRepr()), stencil.AmbiguousError)):
            with self.assertRaises(err):
                call()

    def test_an_enclosure_limit_that_cannot_be_printed(self):
        r = json.loads((DATA / "examples" / "query_rules.json").read_text(encoding="utf-8"))["resolved"]
        for o in r["objects"]:
            if o.get("name") == "V1_M1X":
                o["attrs"]["limit"] = {"toString": 0, "big": [self.n // 10 ** 4990]}
        with self.assertRaises(StencilError):
            Technology.from_json(r).enclosure("V1", "M1", width=20)

    def test_a_grid_of_5000_digits_prints(self):
        r = json.loads((DATA / "examples" / "level0_routing.json").read_text(encoding="utf-8"))["resolved"]
        t = Technology.from_json({**r, "grid_nm": "1/1" + "0" * 5000, "hash": None})
        self.assertIn("grid 1/1000", repr(t))

    def test_a_cell_beyond_any_double(self):
        with self.assertRaises(StencilError) as e:
            self.t.site("CORE", units=10 ** 309)
        self.assertIn("beyond the exact range", str(e.exception))


class Equivalences(unittest.TestCase):
    """X, [X] and [X, X] are one query for the symmetric kinds, on every fixture."""

    def outcome(self, t, *args, **kw):
        try:
            return ("ok", t.rule_value(*args, **kw))
        except StencilError as e:
            return (type(e).__name__, getattr(e, "rules", None))

    def test_one_name_three_ways(self):
        n = 0
        for f in sorted((DATA / "examples").glob("*.json")):
            b = json.loads(f.read_text(encoding="utf-8"))
            t = Technology(b["resolved"], allow_incomplete=True)
            names = [o["name"] for o in b["resolved"]["objects"] if o["kind"] in ("layer", "region", "connector")]
            for kind in ("spacing", "cut_spacing", "corner_spacing"):
                for x in names:
                    for kw in ({}, {"axis": "x", "width": 20, "prl": 40, "same_net": False, "same_color": False, "scopes": []}):
                        one = self.outcome(t, kind, x, **kw)
                        self.assertEqual(self.outcome(t, kind, [x], **kw), one, (f.name, kind, x))
                        self.assertEqual(self.outcome(t, kind, [x, x], **kw), one, (f.name, kind, x))
                        n += 1
        self.assertGreater(n, 1000)


class Shapes(unittest.TestCase):
    def setUp(self):
        self.t = fixture("query_rules")
        self.pair = [("M1", (0, 0, 100, 10)), ("M1", (0, 15, 100, 25))]

    def test_shape_forms_agree(self):
        as_shapes = [Shape("M1", (0, 0, 100, 10), net="a", color=1), Shape("M1", (0, 15, 100, 25), net="b", color=1)]
        as_dicts = [{"layer": "M1", "rect": [0, 0, 100, 10], "net": "a", "color": 1}, {"layer": "M1", "rect": ["0", "15", "100", "25"], "net": "b", "color": 1}]
        self.assertEqual(self.t.check(as_shapes), self.t.check(as_dicts))
        self.assertEqual(len(self.t.check(as_shapes).violations), 4)

    def test_missing_net_data_is_unsupported_not_passing(self):
        r = self.t.check(self.pair)                              # tuples: no nets or colours
        self.assertFalse(r.complete)
        self.assertIn("M1_SN", {u.rule for u in r.unsupported})
        self.assertIn("M1_SC", {u.rule for u in r.unsupported})

    def test_bad_shapes(self):
        for bad in ([("M1", (0, 0, 10))], [("M1", (0, 0, 10, 10), 3)], [{"rect": (0, 0, 1, 1)}], [("M1", (10, 0, 0, 10))]):
            with self.assertRaises((ValueError, TypeError)):
                self.t.check(bad)

    def test_mode(self):
        with self.assertRaises(ValueError):
            self.t.check(self.pair, mode="strict")


class Sites(unittest.TestCase):
    def test_a_site_that_does_not_expand_cleanly(self):
        r = json.loads((DATA / "examples" / "query_rules.json").read_text(encoding="utf-8"))["resolved"]
        objects = [dict(o) for o in r["objects"]]
        core = next(o for o in objects if o.get("name") == "CORE")
        core["children"] = core["children"] + [{"kind": "rail", "name": "BAD", "attrs": {"layer": {"ref": "M1"}, "y": 999}}]
        t = Technology.from_json(dict(r, objects=objects))
        with self.assertRaises(StencilError) as e:
            t.site("CORE")
        self.assertIn("outside its row", str(e.exception))

    def test_the_site_name_may_be_omitted_only_when_unambiguous(self):
        self.assertEqual(fixture("level0_routing").site().name, fixture("level0_routing").sites()[0])


if __name__ == "__main__":
    unittest.main()
