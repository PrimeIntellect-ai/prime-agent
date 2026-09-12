from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_benchmarks import HEAD, SHA, fixture, observations

import cli
import worker
from controller import Canceled, Controller
from report import render
from schema import PHASE_METRICS, ProcessMemory, Request, Result, Side, load_report, write_json


def request_for(report):
    return Request(
        repository=report.repository,
        source_repository=report.repository,
        sha=SHA,
        harness_sha=SHA,
        pr=42,
        run_id=100,
        attempt=1,
        role="main",
        config=report.config,
    )


class FailureBudgetTests(unittest.TestCase):
    def run_controller(self, root, fail):
        report = fixture()
        report.config.debounce_seconds = 0
        controller = Controller(report, root, live_github=False)
        controller.client = Mock()
        controller.logs = Mock()
        calls = []

        def start(role):
            controller.sandboxes[role] = SimpleNamespace(id=role, created_at=datetime.now(UTC))

        def phase(role, phase, trial=0):
            calls.append((role, phase, trial))
            side = controller.report.main if role == "main" else controller.report.pr_head
            error = fail(role, phase, trial)
            for metric in PHASE_METRICS[phase]:
                if metric == "disk" and trial != 0:
                    continue
                if error:
                    worker.record(side, metric, trial, error=error)
                    break
                worker.record(side, metric, trial, 1.0)

        controller.start = start
        controller.phase = phase
        controller.run()
        return controller, calls

    @patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "fake"})
    def test_identical_startup_failures_stop_each_side_but_runtime_still_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            controller, calls = self.run_controller(
                root,
                lambda role, phase, trial: (
                    "TimeoutError: Editor input probe did not echo" if phase == "measure" else None
                ),
            )
            measure = [call for call in calls if call[1] == "measure"]
            self.assertEqual(
                measure,
                [("main", "measure", 0), ("pr", "measure", 0), ("pr", "measure", 1), ("main", "measure", 1)],
            )
            self.assertEqual(len([call for call in calls if call[1] == "runtime"]), 20)
            saved = load_report(root / "report.json")
            self.assertEqual(saved.status, "partial")
            self.assertEqual(len(saved.main.metrics["cold"]), 2)
            self.assertNotIn("warm", saved.main.metrics)
            self.assertTrue(any("skipped 8 remaining" in error for error in saved.errors))
            self.assertIn(
                "Editor input probe did not echo", (root / "comment.md").read_text().split("<details>")[0]
            )
            self.assertEqual(controller.logs.call_count, 2)
            self.assertEqual(controller.client.delete.call_count, 2)

    @patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "fake"})
    def test_failure_budget_is_per_side_and_resets_after_success_or_changed_cause(self):
        for failures, attempted in [
            ({0: "same", 2: "same", 3: "same"}, 4),
            ({0: "first", 1: "second", 2: "second"}, 3),
        ]:
            with self.subTest(failures=failures), tempfile.TemporaryDirectory() as directory:
                controller, calls = self.run_controller(
                    Path(directory),
                    lambda role, phase, trial, failures=failures: (
                        failures.get(trial) if role == "pr" and phase == "measure" else None
                    ),
                )
                self.assertEqual(len([c for c in calls if c[:2] == ("main", "measure")]), 10)
                self.assertEqual(len([c for c in calls if c[:2] == ("pr", "measure")]), attempted)
                self.assertEqual(controller.report.status, "partial")

    @patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "fake"})
    def test_failed_first_install_skips_dependent_phases_without_fake_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, calls = self.run_controller(
                Path(directory),
                lambda role, phase, trial: (
                    "installer failed" if role == "pr" and phase == "install" else None
                ),
            )
            self.assertEqual(len([c for c in calls if c[:2] == ("pr", "install")]), 2)
            self.assertFalse(any(c[0] == "pr" and c[1] in ("measure", "runtime") for c in calls))
            self.assertNotIn("cold", controller.report.pr_head.metrics)
            self.assertTrue(any("first installation" in e for e in controller.report.errors))

    @patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "fake"})
    def test_successful_run_preserves_paired_order_and_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, calls = self.run_controller(Path(directory), lambda *_: None)
            self.assertEqual(controller.report.status, "completed")
            cli.require_success(controller.report)
            for phase in ("install", "measure", "runtime"):
                rows = [c for c in calls if c[1] == phase]
                for index in range(0, len(rows), 2):
                    trial = index // 2
                    self.assertEqual(
                        [row[0] for row in rows[index : index + 2]],
                        ["main", "pr"] if trial % 2 == 0 else ["pr", "main"],
                    )
            self.assertTrue((Path(directory) / "comment.md").exists())

    @patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "fake"})
    def test_cancellation_cause_is_saved_and_cleanup_still_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = fixture()
            report.config.debounce_seconds = 0
            controller = Controller(report, root, live_github=False)
            controller.client = Mock()
            controller.logs = Mock()

            def start(role):
                controller.sandboxes[role] = SimpleNamespace(id=role, created_at=datetime.now(UTC))
                raise Canceled("A newer PR head superseded this run")

            controller.start = start
            controller.run()
            report = load_report(root / "report.json")
            self.assertEqual(report.status, "canceled")
            self.assertIn("newer PR head", report.errors[0])
            controller.logs.assert_called_once_with("main")
            controller.client.delete.assert_called_once_with("main")

    @patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "fake"})
    def test_failed_worker_result_is_collected_and_each_trial_keeps_its_log(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(fixture(), Path(directory), live_github=False)
            controller.sandboxes["main"] = SimpleNamespace(id="main")
            controller.client = Mock()
            controller.wait = Mock(side_effect=RuntimeError("worker failed"))
            controller.collect_result = Mock()
            for trial in (0, 1):
                with self.assertRaisesRegex(RuntimeError, "worker failed"):
                    controller.phase("main", "measure", trial)
                command = controller.client.start_background_job.call_args.args[1]
                self.assertIn(f"/measure-{trial}.log", command)
            self.assertEqual(controller.collect_result.call_count, 2)


class WorkerFailureTests(unittest.TestCase):
    def test_cold_readiness_failure_closes_transcript_and_never_claims_warm_startup(self):
        terminal = Mock()
        terminal.ready.side_effect = TimeoutError("Editor input probe did not echo")
        side = Side(sha=SHA, metrics={"install": observations(1)})
        with (
            patch("worker.Terminal", return_value=terminal) as launch,
            patch("worker.stop_processes") as stop,
            patch("worker.stop_agents") as stop_agents,
        ):
            worker.measure(request_for(fixture()), side, 0)
        self.assertEqual(launch.call_count, 1)
        terminal.close.assert_called_once()
        self.assertEqual(stop.call_count, 2)
        stop_agents.assert_not_called()
        self.assertIn("Editor input probe", side.metrics["cold"][0].error)
        self.assertNotIn("warm", side.metrics)
        self.assertNotIn("rss", side.metrics)
        self.assertNotIn("disk", side.metrics)

    def test_failed_launch_is_recorded_and_owned_processes_are_stopped(self):
        side = Side(sha=SHA, metrics={"install": observations(1)})
        with (
            patch("worker.Terminal", side_effect=OSError("launch failed")),
            patch("worker.stop_processes") as stop,
        ):
            worker.measure(request_for(fixture()), side, 0)
        self.assertEqual(side.metrics["cold"][0].error, "OSError: launch failed")
        self.assertEqual(stop.call_count, 2)

    def test_memory_failure_does_not_overwrite_successful_startup_timing(self):
        terminal = Mock()
        terminal.ready.return_value = 0.5
        side = Side(
            sha=SHA, metrics={"install": observations(1)}, runtime={"home_before_install_bytes": "100"}
        )
        with (
            patch("worker.Terminal", return_value=terminal),
            patch("worker.stop_processes"),
            patch("worker.disk_bytes", return_value=700),
            patch("worker.pwd.getpwnam", return_value=SimpleNamespace(pw_uid=1)),
            patch("worker.memory", return_value=[]),
            patch("worker.stop_agents") as stop_agents,
        ):
            worker.measure(request_for(fixture()), side, 0)
        self.assertEqual(side.metrics["cold"][0].value, 0.5)
        self.assertEqual(side.metrics["warm"][0].value, 0.5)
        self.assertIn("No owned processes", side.metrics["rss"][0].error)
        self.assertEqual(terminal.close.call_count, 2)
        stop_agents.assert_called_once()
        self.assertEqual(side.metrics["disk"][0].value, 600)

    def test_warm_failures_preserve_first_use_disk_and_measurement_diagnostics(self):
        for stage in ("ready", "settle"):
            for trial, disk_failure in ((0, False), (0, True), (1, False)):
                with self.subTest(stage=stage, trial=trial, disk_failure=disk_failure):
                    order = []
                    terminal = Mock()
                    terminal.close.side_effect = lambda order=order: order.append("closed")
                    terminal.ready.return_value = 0.5
                    if stage == "ready":
                        terminal.ready.side_effect = [0.5, TimeoutError("warm not ready")]
                    else:
                        terminal.settle.side_effect = [None, RuntimeError("terminal exited")]
                    side = Side(
                        sha=SHA,
                        metrics={"install": observations(1)},
                        runtime={"home_before_install_bytes": "100"},
                    )

                    def disk(_home, order=order, disk_failure=disk_failure):
                        self.assertEqual(order, ["stopped", "closed", "closed", "stopped"])
                        if disk_failure:
                            raise OSError("footprint unavailable")
                        return 700

                    with (
                        patch("worker.Terminal", return_value=terminal),
                        patch(
                            "worker.stop_processes",
                            side_effect=lambda _user, order=order: order.append("stopped"),
                        ),
                        patch("worker.stop_agents"),
                        patch("worker.write_json"),
                        patch("worker.pwd.getpwnam", return_value=SimpleNamespace(pw_uid=1)),
                        patch("worker.memory", return_value=[ProcessMemory(pid=1, name="agent", rss=100)]),
                        patch("worker.disk_bytes", side_effect=disk) as footprint,
                    ):
                        worker.measure(request_for(fixture()), side, trial)
                    self.assertEqual(side.metrics["cold"][0].value, 0.5)
                    self.assertEqual(side.metrics["rss"][0].value, 100)
                    if stage == "ready":
                        self.assertEqual(side.metrics["warm"][0].error, "TimeoutError: warm not ready")
                        self.assertIsNone(side.error)
                    else:
                        self.assertEqual(side.metrics["warm"][0].value, 0.5)
                        self.assertEqual(side.error, "warm settle: RuntimeError: terminal exited")
                    self.assertEqual(terminal.close.call_count, 2)
                    self.assertEqual(order, ["stopped", "closed", "closed", "stopped"])
                    if trial == 0:
                        footprint.assert_called_once()
                        if disk_failure:
                            self.assertEqual(side.metrics["disk"][0].error, "OSError: footprint unavailable")
                        else:
                            self.assertEqual(side.metrics["disk"][0].value, 600)
                    else:
                        footprint.assert_not_called()
                        self.assertNotIn("disk", side.metrics)

    def test_prior_phase_error_does_not_poison_later_independent_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = request_for(fixture())
            write_json(root / "request.json", request)
            write_json(root / "result.json", Result(request=request, side=Side(sha=SHA, error="old error")))
            with (
                patch("worker.ROOT", root),
                patch("worker.RESULTS", root),
                patch(
                    "worker.prepare", side_effect=lambda request, side: worker.record(side, "bundle", 0, 1)
                ),
                patch.object(sys, "argv", ["worker.py", "prepare"]),
            ):
                worker.main()
            result = Result.model_validate_json((root / "result.json").read_text())
            self.assertIsNone(result.side.error)
            self.assertEqual(result.side.metrics["bundle"][0].value, 1)

    def test_worker_exits_nonzero_only_after_saving_failed_or_missing_measurement(self):
        for failed in (True, False):
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                write_json(root / "request.json", request_for(fixture()))

                def measure(request, side, trial, failed=failed, root=root):
                    if failed:
                        worker.record(side, "cold", trial, error="TimeoutError: editor not ready")
                    (root / "cold-0.raw").write_text("diagnostic terminal output")

                with (
                    patch("worker.ROOT", root),
                    patch("worker.RESULTS", root),
                    patch("worker.measure", side_effect=measure),
                    patch.object(sys, "argv", ["worker.py", "measure"]),
                    self.assertRaises(SystemExit),
                ):
                    worker.main()
                result = Result.model_validate_json((root / "result.json").read_text())
                self.assertEqual(len(result.side.metrics.get("cold", [])), int(failed))
                self.assertEqual((root / "cold-0.raw").read_text(), "diagnostic terminal output")


class ExitStatusTests(unittest.TestCase):
    def test_all_unsuccessful_states_and_incomplete_completed_report_exit_nonzero(self):
        for status in ("failed", "partial", "canceled", "running", "completed"):
            report = fixture()
            report.status = status
            with self.subTest(status=status), self.assertRaises(SystemExit):
                cli.require_success(report)

    def test_missing_secret_saves_report_and_summary_before_failing_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_json(root / "report.json", fixture())
            event = root / "event.json"
            event.write_text(json.dumps({}))
            summary = root / "summary.md"
            with (
                patch.dict(
                    os.environ,
                    {
                        "GITHUB_EVENT_PATH": str(event),
                        "GITHUB_REPOSITORY": "PrimeIntellect-ai/prime-agent",
                        "GITHUB_RUN_ID": "100",
                        "GITHUB_RUN_ATTEMPT": "1",
                        "GITHUB_STEP_SUMMARY": str(summary),
                        "PRIME_SANDBOX_API_KEY": "",
                    },
                ),
                patch("cli.GitHub"),
                patch.object(sys, "argv", ["cli.py", "run", "--results", str(root)]),
                self.assertRaises(SystemExit),
            ):
                cli.main()
            self.assertEqual(load_report(root / "report.json").status, "failed")
            self.assertIn("not configured", summary.read_text())

    def test_completion_listener_downgrades_incomplete_green_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = fixture()
            write_json(root / "request.json", report)
            report.status = "completed"
            write_json(root / "report.json", report)
            report = cli.completed_report(
                root / "report.json",
                root / "request.json",
                {
                    "id": 100,
                    "run_attempt": 1,
                    "display_title": "Prime Agent benchmarks · PR #42",
                    "conclusion": "success",
                },
            )
            self.assertEqual(report.status, "partial")
            self.assertIn("failed or missing measurements", render(report))

    def test_local_cli_rejects_failed_result_without_publishing(self):
        with tempfile.TemporaryDirectory() as directory:
            report = fixture()
            report.status = "canceled"
            controller = Mock(report=report)
            with (
                patch("cli.Controller", return_value=controller),
                patch("cli.GitHub") as github,
                patch("cli.subprocess.check_output", return_value=SHA),
                patch.object(
                    sys, "argv", ["cli.py", "local", "--results", directory, "--base", SHA, "--head", HEAD]
                ),
                self.assertRaises(SystemExit),
            ):
                cli.main()
            controller.run.assert_called_once()
            github.assert_not_called()


if __name__ == "__main__":
    unittest.main()
