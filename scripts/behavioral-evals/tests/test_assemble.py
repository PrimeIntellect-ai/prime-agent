from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import assemble

from tests.fixtures import make_extracted, make_request


class AssembleTests(unittest.TestCase):
    def test_convert_marks_only_an_all_infrastructure_failure_as_systemic(self):
        result = assemble.convert(make_request(), make_extracted())
        self.assertEqual(len(result.tasks), 28)
        self.assertEqual(result.tasks[3].task_id, "suite/task-03")
        self.assertEqual(result.tasks[3].trace_fact_counts, {"repeated_commands": 1})
        self.assertEqual(result.systemic_failures, [])

        failed = assemble.convert(make_request(), make_extracted(all_infrastructure_errors=True))
        self.assertEqual(failed.systemic_failures, ["launch"])

    def test_main_writes_seed_report_comment_verdict_and_action_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = root / "request.json"
            candidate = root / "candidate.json"
            output = root / "output"
            github_output = root / "github-output"
            request.write_text(json.dumps(make_request()))
            candidate.write_text(json.dumps(make_extracted()))
            argv = [
                "assemble.py",
                "--request",
                str(request),
                "--candidate",
                str(candidate),
                "--output",
                str(output),
            ]
            env = {
                "GITHUB_OUTPUT": str(github_output),
                "GITHUB_SERVER_URL": "https://github.example",
            }
            with (
                patch.object(sys, "argv", argv),
                patch.dict(os.environ, env, clear=False),
            ):
                assemble.main()

            report = json.loads((output / "report.json").read_text())
            self.assertEqual(report["schema_version"], 1)
            self.assertEqual(
                report["candidate"]["identity"]["evaluator_contract_fingerprint"],
                make_request()["evaluator_contract_fingerprint"],
            )
            self.assertEqual(report["comparison"]["status"], "seed")
            self.assertIsNone(report["baseline_generation"])
            self.assertIsNone(report["baseline_source_candidate_fingerprint"])
            self.assertEqual((output / "verdict").read_text(), "pass\n")
            self.assertIn(assemble.MARKER, (output / "comment.md").read_text())
            self.assertIn(
                "https://github.example/PrimeIntellect-ai/prime-agent/actions/runs/123",
                (output / "comment.md").read_text(),
            )
            self.assertEqual(github_output.read_text(), "needs_confirmation=false\n")
            self.assertFalse((output / "confirmation-request.json").exists())

    def test_main_writes_a_failure_without_parsing_missing_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output"
            github_output = root / "github-output"
            argv = [
                "assemble.py",
                "--request",
                str(root / "missing-request.json"),
                "--candidate",
                str(root / "missing-candidate.json"),
                "--output",
                str(output),
                "--build-outcome",
                "failure",
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.dict(os.environ, {"GITHUB_OUTPUT": str(github_output)}, clear=False),
            ):
                assemble.main()

            self.assertEqual((output / "verdict").read_text(), "fail\n")
            self.assertIn("candidate build", (output / "comment.md").read_text())
            self.assertEqual(github_output.read_text(), "needs_confirmation=false\n")


if __name__ == "__main__":
    unittest.main()
