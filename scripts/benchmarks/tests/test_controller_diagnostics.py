from __future__ import annotations

import os
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_benchmarks import fixture

from cli import completed_report, require_success
from controller import Controller
from report import render
from schema import PHASE_METRICS, Report, load_report, report_complete, write_json
from worker import record


class ControllerDiagnosticsTests(unittest.TestCase):
    def run_controller(self, root, *, measurement_error=None, teardown_error=None):
        report = fixture()
        report.config.debounce_seconds = 0
        report.config.trials = 3
        report.config.install_trials = 1
        controller = Controller(report, root, live_github=False)
        controller.client = Mock()
        controller.logs = Mock(side_effect=teardown_error)
        controller.client.delete.side_effect = teardown_error

        def start(role):
            controller.sandboxes[role] = SimpleNamespace(id=role, created_at=datetime.now(UTC))

        def phase(role, phase, trial=0):
            side = controller.report.main if role == "main" else controller.report.pr_head
            if measurement_error and phase == "measure":
                record(side, "cold", trial, error=measurement_error)
                return
            for metric in PHASE_METRICS[phase]:
                if metric != "disk" or trial == 0:
                    record(side, metric, trial, 1.0)

        controller.start = start
        controller.phase = phase
        controller.run()
        return controller

    @patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "secret-token"})
    def test_complete_measurements_keep_teardown_warnings_visible_and_persisted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            controller = self.run_controller(
                root, teardown_error=RuntimeError("service unavailable secret-token <unsafe>" + "x" * 500)
            )
            saved = load_report(root / "report.json")
            self.assertEqual(saved.status, "completed")
            self.assertTrue(report_complete(saved))
            require_success(saved)
            self.assertEqual(saved.errors, [])
            self.assertEqual(len(saved.warnings), 4)
            self.assertTrue(all(len(warning) == 500 for warning in saved.warnings))
            self.assertTrue(all("RuntimeError: service unavailable" in w for w in saved.warnings))
            self.assertTrue(all("secret-token" not in w for w in saved.warnings))
            self.assertTrue(all("[REDACTED]" in w for w in saved.warnings))
            self.assertTrue(all(not usage.deleted for usage in saved.sandboxes))
            self.assertTrue(all(usage.seconds >= saved.config.ttl_minutes * 60 for usage in saved.sandboxes))
            self.assertIsNotNone(saved.finished_at)
            self.assertEqual(controller.logs.call_count, 2)
            self.assertEqual(controller.client.delete.call_count, 2)
            rendered = (root / "comment.md").read_text().split("<details>")[0]
            self.assertIn("Operational warnings", rendered)
            self.assertIn("logs could not be collected", rendered)
            self.assertIn("cleanup deferred", rendered)
            self.assertIn("&lt;unsafe&gt;", rendered)
            self.assertNotIn("<unsafe>", rendered)
            self.assertNotIn("execution did not complete successfully", rendered)
            request = fixture()
            request.config = saved.config.model_copy(deep=True)
            write_json(root / "request.json", request)
            finalized = completed_report(
                root / "report.json",
                root / "request.json",
                {
                    "id": 100,
                    "run_attempt": 1,
                    "display_title": "Prime Agent benchmarks · PR #42",
                    "conclusion": "success",
                },
            )
            self.assertEqual(finalized.status, "completed")
            self.assertEqual(finalized.warnings, saved.warnings)

    @patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "fake"})
    def test_measurement_failure_still_fails_with_teardown_warnings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.run_controller(
                root,
                measurement_error="TimeoutError: editor not ready",
                teardown_error=RuntimeError("offline"),
            )
            saved = load_report(root / "report.json")
            self.assertEqual(saved.status, "partial")
            self.assertFalse(report_complete(saved))
            self.assertTrue(saved.errors)
            self.assertEqual(len(saved.warnings), 4)
            with self.assertRaises(SystemExit):
                require_success(saved)
            self.assertIn("Failure diagnostics", render(saved))
            self.assertIn("Operational warnings", render(saved))

    @patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "fake"})
    def test_long_repeated_failure_preserves_bounded_diagnostics_and_final_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            controller = self.run_controller(root, measurement_error="x" * 500)
            saved = load_report(root / "report.json")
            self.assertEqual(saved.status, "partial")
            self.assertIsNotNone(saved.finished_at)
            self.assertEqual(len(saved.main.metrics["cold"]), 2)
            self.assertEqual(len(saved.pr_head.metrics["cold"]), 2)
            skipped = [error for error in saved.errors if "remaining trials after" in error]
            self.assertEqual(len(skipped), 2)
            self.assertTrue(all(len(error) == 500 for error in skipped))
            self.assertTrue(all(len(error) <= 500 for error in saved.errors))
            self.assertEqual(controller.client.delete.call_count, 2)
            self.assertTrue((root / "comment.md").exists())
            with self.assertRaises(SystemExit):
                require_success(saved)

    def test_adjacent_fstrings_are_concatenated_before_the_slice(self):
        failure = "x" * 500
        role, phase, count, trial, repeated = "main", "measure", 10, 1, 2
        original = (
            f"{role} {phase}: skipped {count - trial - 1} remaining trials after "
            f"{repeated} identical consecutive failures; last cause: {failure}"[:500]
        )
        explicit = (
            f"{role} {phase}: skipped {count - trial - 1} remaining trials after "
            f"{repeated} identical consecutive failures; last cause: {failure}"
        )[:500]
        self.assertEqual(original, explicit)
        self.assertEqual(len(original), 500)

    def test_old_reports_default_to_no_operational_warnings(self):
        payload = fixture().model_dump()
        payload.pop("warnings")
        self.assertEqual(Report.model_validate(payload).warnings, [])


if __name__ == "__main__":
    unittest.main()
