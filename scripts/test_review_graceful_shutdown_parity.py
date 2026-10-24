#!/usr/bin/env python3
"""Fail-closed receipt and transcript oracle tests; these are not binary receipts."""
import copy
import json
import unittest

from review_graceful_shutdown_parity import classify_receipt, valid_control_transcript


def completed_receipt():
    common = {"original_busy_user_rows": 1, "park_not_executed": True,
              "idle_not_executed": True, "park_queue_before_shutdown_matches": True,
              "listed_park": False, "listed_idle": False,
              "park_transcript_expected": True, "idle_transcript_expected": True}
    ts = dict(common, provider_requests={"busy": 1, "park": 1, "idle": 1},
              busy_continuation_requested=False, busy_continued=False,
              listed_busy=False, continuation_user_rows=0,
              park_transcript_unchanged=False, idle_transcript_unchanged=False)
    rust = dict(common, provider_requests={"busy": 2, "park": 1, "idle": 1},
                busy_continuation_requested=True, busy_continued=True,
                listed_busy=True, continuation_user_rows=1,
                park_transcript_unchanged=True, idle_transcript_unchanged=True)
    return {"results": {kind: {"executed": True, "observed": observed}
                        for kind, observed in (("ts", ts), ("rust", rust))}}


class ReceiptTests(unittest.TestCase):
    def test_declared_feature_success_never_becomes_a_parity_claim(self):
        receipt = completed_receipt()
        classify_receipt(receipt)
        self.assertTrue(receipt["feature_contract_valid"])
        self.assertTrue(receipt["validation_complete"])
        self.assertFalse(receipt["parity"])
        self.assertEqual(receipt["differences"]["continuation_user_rows"],
                         {"ts": 0, "rust": 1})

    def test_missing_execution_and_late_errors_cannot_pass_from_plausible_observations(self):
        for mutation in ({"executed": False}, {"error": "shutdown failed"}):
            receipt = completed_receipt()
            receipt["results"]["rust"].update(mutation)
            classify_receipt(receipt)
            self.assertFalse(receipt["feature_contract_valid"])
            self.assertFalse(receipt["validation_complete"])

    def test_unexpected_calls_replay_or_completion_revival_fail(self):
        mutations = ({"provider_requests": {"busy": 3, "park": 1, "idle": 1}},
                     {"provider_requests": {"busy": 2, "park": 1, "idle": 2}},
                     {"original_busy_user_rows": 2}, {"continuation_user_rows": 2},
                     {"listed_idle": True}, {"idle_transcript_expected": False},
                     {"park_transcript_expected": False})
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                receipt = completed_receipt()
                receipt["results"]["rust"]["observed"].update(mutation)
                classify_receipt(receipt)
                self.assertFalse(receipt["feature_contract_valid"])
                self.assertFalse(receipt["parity"])

    def test_archive_control_rejects_extra_work_rewritten_prefix_and_broken_parent(self):
        row = {"type": "session_state", "id": "archive", "parentId": "completed",
               "timestamp": "2026-10-13T00:00:00Z", "state": {"status": "archived"}}
        control = {"preexisting_bytes_preserved": True, "append_parse_error": None,
                   "appended_rows": [row], "before_utf8": json.dumps({"id": "completed"}) + "\n"}
        self.assertTrue(valid_control_transcript(control, "ts"))
        self.assertFalse(valid_control_transcript(control, "rust"))
        for mutation in ({"preexisting_bytes_preserved": False},
                         {"append_parse_error": "partial row"},
                         {"appended_rows": [row, {"type": "message"}]},
                         {"appended_rows": [dict(row, parentId="unrelated")]},
                         {"appended_rows": [dict(row, id="completed")]}):
            changed = copy.deepcopy(control)
            changed.update(mutation)
            self.assertFalse(valid_control_transcript(changed, "ts"))
        control["appended_rows"] = []
        self.assertTrue(valid_control_transcript(control, "rust"))
        self.assertFalse(valid_control_transcript(control, "ts"))


if __name__ == "__main__":
    unittest.main()
