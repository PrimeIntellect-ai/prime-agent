from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from pydantic import ValidationError

from cli import completed_report, main, validate_completion, workflow_source
from controller import Canceled, Controller, cleanup, labels, side_complete
from github import TITLE, GitHub
from report import MARKER, METRICS, comparison, render
from schema import (
    DEFAULT_MODEL,
    Config,
    Observation,
    Price,
    ProcessMemory,
    Report,
    Request,
    Side,
    finite_number,
    load_report,
    write_json,
)
from terminal import QUERIES, Display, Terminal
from worker import install, measure, read_messages, usage_for

SHA = "a" * 40
HEAD = "b" * 40


def fixture() -> Report:
    return Report(
        repository="PrimeIntellect-ai/prime-agent",
        head_repository="PrimeIntellect-ai/prime-agent",
        pr=42,
        run_id=100,
        attempt=1,
        harness_sha=SHA,
        base_sha=SHA,
        head_sha=HEAD,
        started_at=datetime(2026, 9, 9, tzinfo=UTC),
        model=DEFAULT_MODEL,
        config=Config.load(),
        price=Price(input=2.5, output=15),
        main=Side(sha=SHA),
        pr_head=Side(sha=HEAD),
    )


def observations(*numbers: float) -> list[Observation]:
    return [Observation(trial=index, value=value) for index, value in enumerate(numbers)]


class TerminalTests(unittest.TestCase):
    def test_real_pty_detects_injected_startup_and_answer_delays(self):
        script = """
import os, sys, time, tty
tty.setraw(0)
time.sleep(float(sys.argv[1]))
os.write(1, b'agents/resume\\r\\n> ')
while True:
    byte = os.read(0, 1)
    if byte == b'\\x7f':
        os.write(1, b'\\b \\b')
    elif byte == b'\\r':
        os.write(1, b'\\r\\n\\x1b[3mQUARTZ\\x1b[23m\\r\\n')
        time.sleep(0.15)
        os.write(1, b' Q')
        time.sleep(0.05)
        os.write(1, b'UARTZ')
    elif byte == b'\\x03':
        break
    else:
        os.write(1, byte)
"""
        measurements = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "fixture.py"
            path.write_text(script)
            for delay in (0.05, 0.6):
                terminal = Terminal(
                    [sys.executable, str(path), str(delay)],
                    root,
                    os.environ.copy(),
                    root / f"transcript-{delay}",
                )
                try:
                    measurements.append(terminal.ready())
                    terminal.child.send("quartz")
                    terminal.until(lambda display: "quartz" in display.text(), 2)
                    started = time.perf_counter()
                    terminal.child.send("\r")
                    first = terminal.until(lambda display: display.answer_prefix() is not None, 2)
                    self.assertGreater(first - started, 0.12)
                    self.assertLess(first - started, 2)
                    terminal.until(lambda display: display.answer_prefix() == "QUARTZ", 2)
                finally:
                    terminal.close()
        self.assertGreater(measurements[1] - measurements[0], 0.25)

    def test_queries_split_at_every_boundary(self):
        for query, reply in QUERIES.items():
            for boundary in range(len(query) + 1):
                with self.subTest(query=query, boundary=boundary):
                    replies = []
                    display = Display(replies.append)
                    display.feed("prefix" + query[:boundary])
                    display.feed(query[boundary:] + "suffix")
                    self.assertEqual(replies, [reply])
                    self.assertTrue(display.text().startswith("prefixsuffix"))

    def test_answer_does_not_match_echo_status_or_thinking(self):
        display = Display(lambda _: None)
        display.feed("Reply with only the uppercase form of quartz.\r\n")
        display.feed("Qwen3 · Waiting\r\n\x1b[38;2;161;161;170mQUARTZ\x1b[39m\r\n")
        display.feed("\x1b[3mQUARTZ\x1b[23m\r\n")
        self.assertIsNone(display.answer_prefix())
        display.feed(" Q")
        self.assertEqual(display.answer_prefix(), "Q")
        display.feed("UARTZ")
        self.assertEqual(display.answer_prefix(), "QUARTZ")

    def test_repaint_does_not_keep_a_cleared_answer(self):
        display = Display(lambda _: None)
        display.feed(" QUARTZ")
        self.assertEqual(display.answer_prefix(), "QUARTZ")
        display.feed("\r\x1b[2K Waiting")
        self.assertIsNone(display.answer_prefix())


class ReportTests(unittest.TestCase):
    def test_slower_and_faster_have_consistent_signs_and_arrows(self):
        baseline = observations(*([2.0] * 10))
        slower = comparison(METRICS[0], baseline, observations(*([2.5] * 10)), 10)
        faster = comparison(METRICS[0], baseline, observations(*([1.5] * 10)), 10)
        self.assertEqual(slower[2:], ("**↑ +500.0 ms**", "+25.00%", "**slower**"))
        self.assertEqual(faster[2:], ("↓ -500.0 ms", "-25.00%", "faster"))

    def test_noise_and_partial_results_are_not_regressions(self):
        noisy = observations(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
        shifted = observations(1.2, 2.2, 3.2, 4.2, 5.2, 6.2, 7.2, 8.2, 9.2, 10.2)
        self.assertEqual(comparison(METRICS[0], noisy, shifted, 10)[4], "no clear change")
        shifted[-1] = Observation(trial=9, error="timed out")
        self.assertEqual(comparison(METRICS[0], noisy, shifted, 10)[4], "incomplete")
        self.assertEqual(comparison(METRICS[0], [], shifted, 10)[4], "unavailable")

    def test_zero_baseline_and_small_bundle_changes(self):
        cells = comparison(METRICS[4], observations(0), observations(65537), 1)
        self.assertEqual(cells[3], "N/A")
        self.assertIn("larger", cells[4])
        unchanged = comparison(METRICS[4], observations(10_000_000), observations(10_001_000), 1)
        self.assertEqual(unchanged[4], "no clear change")

    def test_comment_escapes_untrusted_text_and_reports_failures(self):
        report = fixture()
        report.pr_head.error = "<img src=x> | ![click](https://example.test)\n<!-- comment -->"
        text = render(report)
        self.assertTrue(text.startswith(MARKER))
        self.assertNotIn("<img", text)
        self.assertNotIn("![click]", text)
        self.assertIn("&#124;", text)
        self.assertIn("0/0", text)
        self.assertIn("direct Pinference", text)

    def test_schema_rejects_nonfinite_negative_duplicate_and_wrong_revision(self):
        for value in (float("nan"), float("inf"), -1, True, "1"):
            with self.assertRaises(ValidationError):
                Observation(trial=0, value=value)
        report = fixture().model_dump()
        report["main"]["sha"] = HEAD
        with self.assertRaises(ValidationError):
            Report.model_validate(report)
        report = fixture().model_dump()
        report["main"]["metrics"] = {"cold": [{"trial": 0, "value": 1}] * 2}
        with self.assertRaises(ValidationError):
            Report.model_validate(report)
        self.assertIsNone(finite_number(True))
        self.assertIsNone(finite_number("1"))

    def test_report_round_trip_and_size_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            report = fixture()
            write_json(path, report)
            self.assertEqual(load_report(path), report)
            path.write_bytes(b" " * 2_000_001)
            with self.assertRaises(ValueError):
                load_report(path)


class FakeGitHub(GitHub):
    def __init__(self):
        self.head = HEAD
        self.state = "open"
        self.attempt = 1
        self.runs = [{"id": 100, "run_number": 10, "run_attempt": 1, "display_title": f"{TITLE}42"}]
        self.comments = []
        self.writes = []

    def request(self, method, path, body=None):
        if method != "GET":
            self.writes.append((method, path, body))
            return {}
        if path == "pulls/42":
            return {"state": self.state, "head": {"sha": self.head}}
        if path == "actions/runs/100":
            return {"run_attempt": self.attempt, "run_number": 10}
        raise AssertionError(path)

    def pages(self, path, key=None):
        yield self.runs if key else self.comments


class PublishingTests(unittest.TestCase):
    def test_superseded_commit_and_same_commit_rerun_do_not_publish(self):
        for case in ("head", "new_run", "attempt", "closed"):
            with self.subTest(case=case):
                github = FakeGitHub()
                if case == "head":
                    github.head = SHA
                elif case == "new_run":
                    github.runs.append(
                        {"id": 101, "run_number": 11, "run_attempt": 1, "display_title": f"{TITLE}42"}
                    )
                elif case == "attempt":
                    github.attempt = 2
                else:
                    github.state = "closed"
                self.assertFalse(github.publish(fixture()))
                self.assertEqual(github.writes, [])

    def test_updates_only_its_own_sticky_comment(self):
        github = FakeGitHub()
        github.comments = [
            {"id": 1, "user": {"login": "someone"}, "body": MARKER},
            {"id": 2, "user": {"login": "github-actions[bot]"}, "body": MARKER},
        ]
        self.assertTrue(github.publish(fixture()))
        self.assertEqual(github.writes[0][:2], ("PATCH", "issues/comments/2"))

    def test_newer_comment_is_not_overwritten(self):
        github = FakeGitHub()
        github.comments = [
            {
                "id": 2,
                "user": {"login": "github-actions[bot]"},
                "body": f"{MARKER}\n<!-- run:101:1 head:{HEAD} -->",
            }
        ]
        self.assertFalse(github.publish(fixture()))
        self.assertEqual(github.writes, [])


class LifecycleTests(unittest.TestCase):
    def test_invalid_results_get_a_failure_notice_and_missing_results_preserve_pending_trust(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request, result = root / "request.json", root / "result.json"
            run = {"id": 100, "run_attempt": 1, "display_title": f"{TITLE}42", "conclusion": "cancelled"}
            write_json(request, fixture())
            self.assertEqual(completed_report(result, request, run).status, "canceled")
            result.write_text('{"forged": true}')
            report = completed_report(result, request, run)
            self.assertEqual(report.status, "failed")
            self.assertIn("validation", report.errors[0])
            result.unlink()
            pending = fixture()
            pending.status = "pending-trust"
            write_json(request, pending)
            self.assertEqual(completed_report(result, request, run).status, "pending-trust")
            self.assertIn("Waiting for contributor vouch", render(pending))

    def test_automatic_duplicates_skip_but_manual_runs_and_new_comparisons_do_not(self):
        for case in ("duplicate", "manual", "attempt", "main", "model", "config", "failed"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                event, output = root / "event.json", root / "output.txt"
                event.write_text('{"pull_request": {"number": 42}}')
                old = fixture()
                old.status = "completed" if case != "failed" else "partial"
                github = FakeGitHub()
                github.comments = [{"user": {"login": "github-actions[bot]"}, "body": render(old)}]
                report = fixture()
                if case == "main":
                    report.base_sha = report.main.sha = "c" * 40
                elif case == "model":
                    report.model = "other/model"
                elif case == "config":
                    report.config.trials = 11
                elif case == "attempt":
                    report.attempt = 2
                github.resolve = Mock(return_value=(report, "kevin"))
                with (
                    patch("cli.GitHub", return_value=github),
                    patch.object(sys, "argv", ["cli.py", "resolve", "--results", directory]),
                    patch.dict(
                        os.environ,
                        {
                            "GITHUB_EVENT_PATH": str(event),
                            "GITHUB_OUTPUT": str(output),
                            "GITHUB_EVENT_NAME": "workflow_dispatch"
                            if case == "manual"
                            else "pull_request_target",
                            "GITHUB_SHA": SHA,
                            "GITHUB_RUN_ID": "100",
                            "GITHUB_RUN_ATTEMPT": str(report.attempt),
                        },
                    ),
                ):
                    main()
                self.assertIn(f"needed={'false' if case == 'duplicate' else 'true'}", output.read_text())
                self.assertEqual(github.writes, [])

    def test_cleanup_paginates_before_deleting_and_checks_all_labels(self):
        client = Mock()
        expected = labels("owner/repo", 100, 2)
        first = SimpleNamespace(id="one", labels=expected)
        wrong = SimpleNamespace(id="other-attempt", labels=labels("owner/repo", 100, 1))
        second = SimpleNamespace(id="two", labels=expected)
        client.list.side_effect = [
            SimpleNamespace(sandboxes=[first, wrong], has_next=True),
            SimpleNamespace(sandboxes=[second], has_next=False),
        ]
        self.assertEqual(cleanup(client, "owner/repo", 100, 2), ["one", "two"])
        self.assertEqual([call[0] for call in client.mock_calls], ["list", "list", "delete", "delete"])

    def test_cleanup_attempts_remaining_deletions_after_failure(self):
        client = Mock()
        expected = labels("owner/repo", 1, 1)
        client.list.return_value = SimpleNamespace(
            sandboxes=[
                SimpleNamespace(id="one", labels=expected),
                SimpleNamespace(id="two", labels=expected),
            ],
            has_next=False,
        )
        client.delete.side_effect = [RuntimeError("unavailable"), None]
        with self.assertRaises(RuntimeError):
            cleanup(client, "owner/repo", 1, 1)
        self.assertEqual(client.delete.call_count, 2)

    def test_cancellation_still_deletes_a_created_sandbox(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "fake"}),
        ):
            report = fixture()
            report.config.debounce_seconds = 0
            controller = Controller(report, Path(directory), live_github=False)
            controller.client = Mock()
            controller.logs = Mock()
            sandbox = SimpleNamespace(id="one", created_at=datetime.now(UTC).replace(tzinfo=None))

            def start(_role):
                controller.sandboxes["main"] = sandbox
                raise Canceled()

            controller.start = start
            controller.run()
            controller.client.delete.assert_called_once_with("one")
            self.assertEqual(load_report(Path(directory) / "report.json").status, "canceled")

    def test_workflow_source_rejects_untrusted_triggers(self):
        event = {
            "workflow_run": {
                "event": "pull_request",
                "path": ".github/workflows/benchmarks.yml",
                "head_repository": {"full_name": "owner/repo"},
            }
        }
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/repo"}), self.assertRaises(ValueError):
            workflow_source(event)

    def test_fork_metadata_does_not_confuse_pr_head_with_trusted_harness(self):
        run = {
            "event": "pull_request_target",
            "path": ".github/workflows/benchmarks.yml",
            "repository": {"full_name": "PrimeIntellect-ai/prime-agent"},
            "head_repository": {"full_name": "contributor/prime-agent"},
            "head_sha": HEAD,
            "id": 100,
            "run_attempt": 1,
            "display_title": f"{TITLE}42",
        }
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "PrimeIntellect-ai/prime-agent"}):
            self.assertEqual(workflow_source({"workflow_run": run}), run)
        validate_completion(fixture(), fixture(), run)
        forged = fixture()
        forged.harness_sha = HEAD
        with self.assertRaises(ValueError):
            validate_completion(forged, fixture(), run)

    def test_dispatch_from_a_feature_branch_cannot_publish_or_clean_up(self):
        run = {
            "event": "workflow_dispatch",
            "path": ".github/workflows/benchmarks.yml",
            "repository": {"full_name": "owner/repo"},
            "head_branch": "untrusted",
        }
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/repo"}), self.assertRaises(ValueError):
            workflow_source({"workflow_run": run})


class UsageTests(unittest.TestCase):
    def test_disk_footprint_is_measured_after_interactive_first_use(self):
        order = []
        terminal = Mock()
        terminal.ready.return_value = 0.5
        terminal.display.answer_prefix.side_effect = [None, "QUARTZ"]
        terminal.until.side_effect = lambda *_args: time.perf_counter()
        terminal.close.side_effect = lambda *_args: order.append("closed")
        message = {
            "benchmark_id": "session:1",
            "stopReason": "stop",
            "content": [{"type": "text", "text": "QUARTZ"}],
            "usage": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0},
        }
        side = Side(
            sha=SHA, metrics={"install": observations(1)}, runtime={"home_before_install_bytes": "100"}
        )
        report = fixture()
        request = Request(
            repository=report.repository,
            source_repository=report.repository,
            sha=SHA,
            harness_sha=SHA,
            pr=42,
            run_id=100,
            attempt=1,
            role="main",
            config=report.config,
            model=report.model,
            price=report.price,
        )

        def disk(_home):
            self.assertEqual(order, ["closed", "closed"])
            return 700

        with (
            patch("worker.Terminal", return_value=terminal),
            patch("worker.read_messages", side_effect=[[], [message], [message]]),
            patch("worker.memory", return_value=[ProcessMemory(pid=1, name="agent", rss=100)]),
            patch("worker.pwd.getpwnam", return_value=SimpleNamespace(pw_uid=1)),
            patch("worker.stop_processes"),
            patch("worker.stop_agents"),
            patch("worker.write_json"),
            patch("worker.disk_bytes", side_effect=disk),
        ):
            measure(request, side, 0)
        self.assertEqual(side.metrics["disk"][0].value, 600)
        self.assertIsNotNone(side.metrics["ttft"][0].value)

    def test_dependency_inventory_warning_preserves_successful_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "benchmark1"
            (home / ".prime/agent/kernel-venv/bin").mkdir(parents=True)
            (home / ".prime/agent/kernel-venv/bin/python").touch()
            side = Side(sha=SHA)

            def run_as(_user, command, *_args, **_kwargs):
                if command[:2] == ["npm", "ls"]:
                    raise subprocess.CalledProcessError(1, command)
                return "0.0.0-benchmark"

            with (
                patch("worker.HOMES", root),
                patch("worker.RESULTS", root),
                patch("worker.subprocess.run"),
                patch("worker.run_as", side_effect=run_as),
                patch("worker.disk_bytes", side_effect=[100, 300]),
                patch("worker.os.chown"),
                patch("worker.pwd.getpwnam", return_value=SimpleNamespace(pw_uid=1, pw_gid=1)),
                patch("worker.stop_processes"),
            ):
                install(SimpleNamespace(model=DEFAULT_MODEL, config=Config.load()), side, 0)
            self.assertIsNotNone(side.metrics["install"][0].value)
            self.assertIsNone(side.metrics["install"][0].error)
            self.assertIn("warnings", side.runtime["dependency_inventory"])
            self.assertTrue((home / "workspace/example.py").exists())
            self.assertNotIn("disk", side.metrics)

    def test_usage_includes_cache_without_double_counting(self):
        message = {
            "stopReason": "stop",
            "usage": {"input": 1000, "output": 100, "cacheRead": 2000, "cacheWrite": 0},
        }
        usage = usage_for([message], Price(input=2, output=10, cache_read=0.2))
        self.assertEqual(usage.input_tokens, 3000)
        self.assertAlmostEqual(usage.estimated_usd, 0.0034)
        self.assertEqual(usage.incomplete_prompts, 0)

    def test_missing_and_failed_usage_remains_visible(self):
        self.assertEqual(usage_for([], Price(input=1, output=1)).incomplete_prompts, 1)
        message = {"stopReason": "error", "usage": {"input": 1, "output": 0, "cacheRead": 0, "cacheWrite": 0}}
        self.assertEqual(usage_for([message], Price(input=1, output=1)).incomplete_prompts, 1)

    def test_session_message_ids_are_independent_of_file_order(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            sessions = home / ".prime/agent/sessions"
            sessions.mkdir(parents=True)
            entry = {"type": "message", "message": {"role": "assistant", "content": []}}
            (sessions / "z.jsonl").write_text(json.dumps(entry) + "\n")
            seen = {message["benchmark_id"] for message in read_messages(home)}
            (sessions / "a.jsonl").write_text(json.dumps(entry) + "\n")
            fresh = [message for message in read_messages(home) if message["benchmark_id"] not in seen]
            self.assertEqual(len(fresh), 1)
            self.assertEqual(fresh[0]["benchmark_id"], "a.jsonl:0")

    def test_completion_requires_every_metric(self):
        self.assertFalse(side_complete(Side(sha=SHA), 10, 3))


if __name__ == "__main__":
    unittest.main()
