from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import confirm
from evaluation import candidate_fingerprint, make_baseline

from tests.fixtures import make_candidate


class ConfirmProcessTests(unittest.TestCase):
    def _inputs(
        self,
        root: Path,
        *,
        candidate_stage: str | None = None,
        baseline_stage: str | None = None,
        write_candidate_result: bool = True,
        write_baseline_result: bool = True,
    ) -> tuple[list[str], Path]:
        candidate = make_candidate()
        baseline = make_baseline(candidate)
        request = {
            "candidate_fingerprint": candidate_fingerprint(candidate),
            "findings": [
                {
                    "code": "systemic_launch_failure",
                    "task_ids": ["suite/task-00"],
                }
            ],
        }
        report = root / "report.json"
        baseline_path = root / "published-baseline.json"
        confirmation_request = root / "confirmation-request.json"
        output = root / "output"
        script_root = root / "script"
        script_root.mkdir()
        output.mkdir()
        report.write_text(json.dumps({"candidate": candidate.model_dump(mode="json")}))
        baseline_path.write_text(baseline.model_dump_json())
        confirmation_request.write_text(json.dumps(request))
        (script_root / "short-swe.json").write_text(
            json.dumps({"tasksets": [{"id": "suite", "tasks": ["task-00", "task-01"]}]})
        )
        candidate_item = {
            "taskset": "suite",
            "task": "task-00",
            "resolved": False,
            "failure_stage": candidate_stage,
        }
        baseline_item = {
            "taskset": "suite",
            "task": "task-00",
            "resolved": False,
            "failure_stage": baseline_stage,
        }
        if write_candidate_result:
            (output / "candidate.json").write_text(json.dumps({"tasks": [candidate_item]}))
        if write_baseline_result:
            (output / "baseline.json").write_text(json.dumps({"tasks": [baseline_item]}))
        argv = [
            "confirm.py",
            "--eval",
            str(root / "eval"),
            "--confirmation-request",
            str(confirmation_request),
            "--report",
            str(report),
            "--baseline",
            str(baseline_path),
            "--candidate-artifacts",
            str(root / "candidate-artifacts"),
            "--baseline-artifacts",
            str(root / "baseline-artifacts"),
            "--output",
            str(output),
        ]
        return argv, script_root

    def _run(self, argv: list[str], script_root: Path, return_codes=(0, 0)):
        processes = [SimpleNamespace(wait=lambda code=code: code) for code in return_codes]
        with (
            patch.object(sys, "argv", argv),
            patch.object(confirm, "ROOT", script_root),
            patch.object(confirm, "write_configs") as write_configs,
            patch.object(confirm.subprocess, "Popen", side_effect=processes) as popen,
        ):
            confirm.main()
        self.assertEqual(write_configs.call_count, 2)
        self.assertEqual(popen.call_count, 2)

    def test_confirmation_fails_closed_on_process_failure_or_missing_result(self):
        cases = [
            ("process failure", (0, 1), True, True),
            ("missing candidate result", (0, 0), False, True),
            ("missing baseline result", (0, 0), True, False),
        ]
        for name, return_codes, candidate_file, baseline_file in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                argv, script_root = self._inputs(
                    root,
                    write_candidate_result=candidate_file,
                    write_baseline_result=baseline_file,
                )
                with self.assertRaisesRegex(RuntimeError, "focused paired confirmation did not complete"):
                    self._run(argv, script_root, return_codes)
                self.assertFalse((root / "output/confirmation.json").exists())

    def test_systemic_confirmation_requires_candidate_only_stage_reproduction(self):
        cases = [
            ("launch", None, True),
            ("launch", "launch", False),
            ("acp", None, False),
        ]
        for candidate_stage, baseline_stage, expected in cases:
            with (
                self.subTest(
                    candidate_stage=candidate_stage,
                    baseline_stage=baseline_stage,
                ),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                argv, script_root = self._inputs(
                    root,
                    candidate_stage=candidate_stage,
                    baseline_stage=baseline_stage,
                )
                self._run(argv, script_root)
                record = json.loads((root / "output/confirmation.json").read_text())
                finding = record["findings"][0]
                self.assertEqual(finding["code"], "systemic_launch_failure")
                self.assertIs(finding["confirmed"], expected)


if __name__ == "__main__":
    unittest.main()
