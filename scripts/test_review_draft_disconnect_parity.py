#!/usr/bin/env python3
"""Decision-only regression tests; these never launch either product binary."""
import copy
import unittest

from review_draft_disconnect_parity import classify_validation


def completed_observations():
    accepted = ["sentinel", "probe"]
    scenarios = {}
    for name in ("queued_close", "refusal", "rebind_close"):
        scenarios[name] = {"executed": True, "invariant_passed": True,
                           "fixture_errors": [], "prompts": accepted[:],
                           "accepted_logical_messages": accepted[:],
                           "wire_prompt_messages": accepted[:]}
    scenarios["refusal"]["prompts"] = ["sentinel", "sentinel", "probe"]
    scenarios["refusal"]["wire_prompt_messages"] = ["sentinel", "sentinel", "probe"]
    rust = {"scenarios": scenarios}
    ts = copy.deepcopy(rust)
    ts["scenarios"]["queued_close"]["wire_prompt_messages"] = ["sentinel", "sentinel", "probe"]
    ts["scenarios"]["rebind_close"] = {
        "executed": False, "invariant_passed": False, "fixture_errors": [],
        "error": "TimeoutError: reconnected attach and visible reconnect result",
        "prompts": ["sentinel"], "accepted_logical_messages": ["sentinel"],
        "wire_prompt_messages": ["sentinel"]}
    return {"results": {"ts": ts, "rust": rust}}


class ValidationDecisionTests(unittest.TestCase):
    def test_complete_shared_contracts_and_rust_extension_validate_without_full_parity(self):
        receipt = completed_observations()
        before = copy.deepcopy(receipt["results"])
        self.assertTrue(classify_validation(receipt))
        self.assertTrue(receipt["shared_contract_parity"])
        self.assertFalse(receipt["parity"])
        self.assertEqual(receipt["comparisons"]["rebind_close"]["status"], "not_comparable")
        self.assertFalse(receipt["comparisons"]["queued_close"]["same_wire_prompt_observations"])
        self.assertEqual(receipt["results"], before)

    def test_incomplete_shared_execution_fails_on_either_side(self):
        for kind in ("ts", "rust"):
            for name in ("queued_close", "refusal"):
                with self.subTest(kind=kind, name=name):
                    receipt = completed_observations()
                    receipt["results"][kind]["scenarios"][name]["executed"] = False
                    self.assertFalse(classify_validation(receipt))

    def test_changed_logical_acceptance_fails(self):
        receipt = completed_observations()
        receipt["results"]["ts"]["scenarios"]["queued_close"]["accepted_logical_messages"].append("sentinel")
        self.assertFalse(classify_validation(receipt))

    def test_shared_invariant_or_prompt_difference_fails(self):
        for kind in ("ts", "rust"):
            for name in ("queued_close", "refusal"):
                for field, value in (("invariant_passed", False), ("prompts", ["different"])):
                    with self.subTest(kind=kind, name=name, field=field):
                        receipt = completed_observations()
                        receipt["results"][kind]["scenarios"][name][field] = value
                        self.assertFalse(classify_validation(receipt))

    def test_missing_observations_fail_even_when_both_sides_omit_them(self):
        for name in ("queued_close", "refusal", "rebind_close"):
            for field in ("prompts", "accepted_logical_messages", "wire_prompt_messages"):
                with self.subTest(name=name, field=field):
                    receipt = completed_observations()
                    for kind in ("ts", "rust"):
                        del receipt["results"][kind]["scenarios"][name][field]
                    self.assertFalse(classify_validation(receipt))

    def test_unsupported_case_requires_the_exact_recorded_failure(self):
        for field, value in (("error", None), ("executed", True), ("invariant_passed", True)):
            with self.subTest(field=field):
                receipt = completed_observations()
                receipt["results"]["ts"]["scenarios"]["rebind_close"][field] = value
                self.assertFalse(classify_validation(receipt))

    def test_rust_rebind_must_execute_and_pass(self):
        for field in ("executed", "invariant_passed"):
            with self.subTest(field=field):
                receipt = completed_observations()
                receipt["results"]["rust"]["scenarios"]["rebind_close"][field] = False
                self.assertFalse(classify_validation(receipt))

    def test_unexpected_scenario_errors_fail_even_if_other_flags_are_green(self):
        for kind in ("ts", "rust"):
            for name in ("queued_close", "refusal", "rebind_close"):
                with self.subTest(kind=kind, name=name):
                    receipt = completed_observations()
                    receipt["results"][kind]["scenarios"][name]["error"] = "unexpected protocol failure"
                    self.assertFalse(classify_validation(receipt))

    def test_fixture_and_cleanup_errors_fail_on_every_scenario(self):
        for kind in ("ts", "rust"):
            for name in ("queued_close", "refusal", "rebind_close"):
                for field in ("fixture_errors", "cleanup_errors"):
                    with self.subTest(kind=kind, name=name, field=field):
                        receipt = completed_observations()
                        receipt["results"][kind]["scenarios"][name][field] = ["failed"]
                        self.assertFalse(classify_validation(receipt))

    def test_missing_results_fail(self):
        for kind in ("ts", "rust"):
            for name in ("queued_close", "refusal", "rebind_close"):
                with self.subTest(kind=kind, name=name):
                    receipt = completed_observations()
                    del receipt["results"][kind]["scenarios"][name]
                    self.assertFalse(classify_validation(receipt))
            receipt = completed_observations()
            del receipt["results"][kind]
            self.assertFalse(classify_validation(receipt))
        self.assertFalse(classify_validation({}))

    def test_preflight_or_binary_setup_errors_fail(self):
        receipt = completed_observations()
        receipt["preflight_error"] = "archive checksum mismatch"
        self.assertFalse(classify_validation(receipt))
        for kind in ("ts", "rust"):
            receipt = completed_observations()
            receipt["results"][kind]["error"] = "could not launch binary"
            self.assertFalse(classify_validation(receipt))


if __name__ == "__main__":
    unittest.main()
