"""The rule conformance cases (VOCABULARY.md section 3) on the Python checker.

tests/data/rule_cases.json holds every case and invariance variant, resolved,
with the hand-derived verdict counts and the JavaScript checker's full result
(written by `node tests/python_fixtures.mjs`). Needs no Node."""
import json
import unittest
from pathlib import Path

from stencil.rulecheck import check_rules

DATA = json.loads((Path(__file__).parent / "data" / "rule_cases.json").read_text(encoding="utf-8"))


class Conformance(unittest.TestCase):
    def test_verdicts_match_the_hand_derived_counts(self):
        for c in DATA["cases"]:
            with self.subTest(case=c["name"], variant=c["variant"]):
                r = check_rules(DATA["techs"][c["tech"]], {"shapes": c["shapes"]})
                self.assertEqual(len(r["violations"]), c["violations"], r)
                self.assertEqual(len(r["unsupported"]), c["unsupported"], r["unsupported"])
                self.assertEqual(r["complete"], c["unsupported"] == 0)

    def test_results_equal_the_javascript_checker(self):
        for c in DATA["cases"]:
            with self.subTest(case=c["name"], variant=c["variant"]):
                self.assertEqual(check_rules(DATA["techs"][c["tech"]], {"shapes": c["shapes"]}), c["js"])

    def test_every_case_has_variants(self):
        names = {c["name"] for c in DATA["cases"]}
        self.assertGreater(len(names), 90)
        self.assertGreater(len(DATA["cases"]), 5 * len(names))


if __name__ == "__main__":
    unittest.main()
