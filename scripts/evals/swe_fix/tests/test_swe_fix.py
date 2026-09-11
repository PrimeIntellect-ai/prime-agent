"""Model-free self-tests for the swe-fix-loop eval harness.

Validates fixture integrity (the seeded bug fails exactly one test, the
golden patch makes the suite pass, and the patch applies cleanly) and the
scorer rubric with synthetic outcomes and transcripts. No agent or model
is invoked.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HARNESS))
import scorer  # noqa: E402

FIXTURES = HARNESS / "fixtures"


class TempCopy:
    def __init__(self, fixture_name: str):
        self.source = FIXTURES / fixture_name
        self.workdir = Path(tempfile.mkdtemp(prefix="swe-fix-test-"))
        self.repo = self.workdir / "repo"

    def __enter__(self) -> Path:
        shutil.copytree(self.source, self.repo)
        return self.repo

    def __exit__(self, *_exc) -> None:
        shutil.rmtree(self.workdir, ignore_errors=True)


def run_tests(cwd: Path, command: str) -> int:
    completed = subprocess.run(command, shell=True, cwd=cwd, capture_output=True, text=True, timeout=120)
    return completed.returncode


def fixture_manifest(name: str) -> dict:
    return json.loads((FIXTURES / name / "fixture.json").read_text())


class FixtureIntegrity(unittest.TestCase):
    def test_ts_fixture_seed_fails_and_golden_patch_passes(self):
        manifest = fixture_manifest("ts-date-utils")
        with TempCopy("ts-date-utils") as repo:
            self.assertNotEqual(run_tests(repo, manifest["test_command"]), 0)
            subprocess.run(["git", "apply", manifest["golden_patch"]], cwd=repo, check=True)
            self.assertEqual(run_tests(repo, manifest["test_command"]), 0)

    def test_py_fixture_seed_fails_and_golden_patch_passes(self):
        manifest = fixture_manifest("py-budget")
        with TempCopy("py-budget") as repo:
            self.assertNotEqual(run_tests(repo, manifest["test_command"]), 0)
            subprocess.run(["git", "apply", manifest["golden_patch"]], cwd=repo, check=True)
            self.assertEqual(run_tests(repo, manifest["test_command"]), 0)


class ScorerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_manifest("ts-date-utils")

    def passing_outcome(self) -> dict:
        return {
            "changed_files": ["src/dates.js"],
            "target_test_passes": True,
            "pre_existing_tests_pass": True,
            "test_run_evidence": True,
            "usage": {"tokens": 12_000, "turns": 4},
        }

    def test_full_resolution(self):
        result = scorer.score_fixture(self.fixture, self.passing_outcome())
        self.assertTrue(result["resolved"])
        self.assertEqual(result["tokens_used"], 12_000)
        self.assertEqual(result["turns"], 4)

    def test_missing_evidence_blocks_resolution(self):
        outcome = self.passing_outcome()
        outcome["test_run_evidence"] = False
        self.assertFalse(scorer.score_fixture(self.fixture, outcome)["resolved"])

    def test_regression_blocks_resolution(self):
        outcome = self.passing_outcome()
        outcome["pre_existing_tests_pass"] = False
        self.assertFalse(scorer.score_fixture(self.fixture, outcome)["resolved"])

    def test_diff_containment_tolerance(self):
        outcome = self.passing_outcome()
        # One allowed file: tolerance max(1, 0.3) = 1 extra file is contained.
        outcome["changed_files"] = ["src/dates.js", "README.md"]
        result = scorer.score_fixture(self.fixture, outcome)
        self.assertTrue(result["diff_contained"])
        # Two extras exceed the tolerance.
        outcome["changed_files"] = ["src/dates.js", "README.md", "package.json"]
        result = scorer.score_fixture(self.fixture, outcome)
        self.assertFalse(result["diff_contained"])
        self.assertEqual(result["extra_changed_files"], ["README.md", "package.json"])

    def test_test_run_evidence_detects_bash_call(self):
        transcript = json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "npm test"}}
                    ],
                },
            }
        )
        self.assertTrue(scorer.test_run_evidence(transcript, "npm test"))

    def test_test_run_evidence_ignores_other_tools(self):
        transcript = json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "c1",
                            "name": "ipython",
                            "arguments": {"command": "npm test"},
                        }
                    ],
                },
            }
        )
        self.assertFalse(scorer.test_run_evidence(transcript, "npm test"))

    def test_test_run_evidence_ignores_malformed_lines(self):
        transcript = "not json\n" + json.dumps({"type": "message", "message": {"role": "user"}})
        self.assertFalse(scorer.test_run_evidence(transcript, "npm test"))

    def test_summarize_usage(self):
        def assistant(tokens: int) -> str:
            return json.dumps(
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "usage": {"input": 10, "output": tokens - 10, "totalTokens": tokens},
                    },
                }
            )

        session = assistant(100) + "\n" + assistant(50) + "\n" + json.dumps({"type": "message"})
        self.assertEqual(scorer.summarize_usage(session), {"tokens": 150, "turns": 2})


if __name__ == "__main__":
    unittest.main()
