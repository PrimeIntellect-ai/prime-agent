"""Model-free self-tests for the swe-fix-loop eval harness.

Validates fixture integrity (the seeded bug fails exactly one test, the
golden patch makes the suite pass, and the patch applies cleanly) and the
scorer rubric with synthetic outcomes and transcripts. No agent or model
is invoked.
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HARNESS))
import runner  # noqa: E402
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


def seeded_failure_count(repo: Path, manifest: dict) -> int:
    """Failing tests in the seeded fixture; exactly one is the contract."""
    if manifest["language"] == "typescript":
        completed = subprocess.run(
            "node --test --test-reporter=tap test/",
            shell=True,
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=120,
        )
        return sum(1 for line in completed.stdout.splitlines() if line.startswith("not ok"))
    completed = subprocess.run(
        manifest["test_command"], shell=True, cwd=repo, capture_output=True, text=True, timeout=120
    )
    output = completed.stdout + completed.stderr
    return output.count("FAIL: ") + output.count("ERROR: ")


def fixture_manifest(name: str) -> dict:
    return json.loads((FIXTURES / name / "fixture.json").read_text())


class FixtureIntegrity(unittest.TestCase):
    def test_ts_fixture_seed_fails_and_golden_patch_passes(self):
        manifest = fixture_manifest("ts-date-utils")
        with TempCopy("ts-date-utils") as repo:
            self.assertEqual(seeded_failure_count(repo, manifest), 1)
            self.assertNotEqual(run_tests(repo, manifest["target_test_command"]), 0)
            subprocess.run(["git", "apply", manifest["golden_patch"]], cwd=repo, check=True)
            self.assertEqual(run_tests(repo, manifest["test_command"]), 0)
            self.assertEqual(run_tests(repo, manifest["target_test_command"]), 0)

    def test_py_fixture_seed_fails_and_golden_patch_passes(self):
        manifest = fixture_manifest("py-budget")
        with TempCopy("py-budget") as repo:
            self.assertEqual(seeded_failure_count(repo, manifest), 1)
            self.assertNotEqual(run_tests(repo, manifest["target_test_command"]), 0)
            subprocess.run(["git", "apply", manifest["golden_patch"]], cwd=repo, check=True)
            self.assertEqual(run_tests(repo, manifest["test_command"]), 0)
            self.assertEqual(run_tests(repo, manifest["target_test_command"]), 0)


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

    def test_test_run_evidence_detects_ipython_bash_call(self):
        # The agent's only built-in tool is the ipython kernel; shell work
        # goes through its bash() helper.
        for code in ('await bash("npm test")', "h = bash('cd repo && npm test')"):
            transcript = json.dumps(
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "toolCall",
                                "id": "c1",
                                "name": "ipython",
                                "arguments": {"code": code},
                            }
                        ],
                    },
                }
            )
            self.assertTrue(scorer.test_run_evidence(transcript, "npm test"))

    def test_test_run_evidence_ignores_echo_and_comments(self):
        def block(call_id: str, name: str, key: str, value: str) -> dict:
            return {"type": "toolCall", "id": call_id, "name": name, "arguments": {key: value}}

        blocks = [
            block("c1", "bash", "command", "echo npm test"),
            block("c2", "bash", "command", "# npm test"),
            block("c3", "ipython", "code", "# bash('npm test')"),
            block("c4", "ipython", "code", 'print("npm test")'),
        ]
        transcript = json.dumps({"type": "message_end", "message": {"role": "assistant", "content": blocks}})
        self.assertFalse(scorer.test_run_evidence(transcript, "npm test"))

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
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "usage": {"input": 10, "output": tokens - 10, "totalTokens": tokens},
                    },
                }
            )

        session = assistant(100) + "\n" + assistant(50) + "\n" + json.dumps({"type": "message_end"})
        self.assertEqual(scorer.summarize_usage(session), {"tokens": 150, "turns": 2})

    def test_summarize_usage_counts_each_assistant_message_once(self):
        # --mode json repeats the assistant message on turn_end; the repeat
        # must not double the token or turn count.
        message = {"role": "assistant", "usage": {"input": 60, "output": 40, "totalTokens": 100}}
        session = (
            json.dumps({"type": "message_end", "message": message})
            + "\n"
            + json.dumps({"type": "turn_end", "message": message, "toolResults": []})
        )
        self.assertEqual(scorer.summarize_usage(session), {"tokens": 100, "turns": 1})


class RunnerTests(unittest.TestCase):
    """The runner must emit a scored result even when the agent cannot run."""

    def run_runner(self, argv: list[str]) -> tuple[int, dict]:
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            exit_code = runner.main(argv)
        return exit_code, json.loads(captured.getvalue())

    def write_agent_script(self, body: str) -> Path:
        script = Path(tempfile.mkdtemp(prefix="swe-fix-agent-")) / "agent"
        script.write_text(f"#!/bin/sh\n{body}")
        script.chmod(0o755)
        return script

    def test_missing_agent_bin_scores_unresolved(self):
        argv = [
            "--fixture",
            str(FIXTURES / "py-budget"),
            "--model",
            "test/fake",
            "--agent-bin",
            "/nonexistent-agent",
        ]
        exit_code, result = self.run_runner(argv)
        self.assertEqual(exit_code, 1)
        self.assertFalse(result["resolved"])
        self.assertFalse(result["target_test_passes"])
        self.assertTrue(result["agent_error"])

    def test_agent_timeout_still_scores(self):
        script = self.write_agent_script("exec sleep 30\n")
        argv = [
            "--fixture",
            str(FIXTURES / "py-budget"),
            "--model",
            "test/fake",
            "--agent-bin",
            str(script),
            "--timeout",
            "1",
        ]
        exit_code, result = self.run_runner(argv)
        self.assertEqual(exit_code, 1)
        self.assertFalse(result["resolved"])
        self.assertIsNone(result["exit_code"])

    def test_changed_files_include_committed_and_new_files(self):
        # The agent commits one edit and leaves a new file behind; both must
        # appear in changed_files, not just unstaged edits.
        script = self.write_agent_script(
            'cd "$6"\n'
            'echo "# agent edit" >> budget.py\n'
            "git add budget.py\n"
            "git -c commit.gpgsign=false -c user.email=agent@e -c user.name=agent commit -qm agent\n"
            "echo scratch > newfile.txt\n"
        )
        argv = [
            "--fixture",
            str(FIXTURES / "py-budget"),
            "--model",
            "test/fake",
            "--agent-bin",
            str(script),
        ]
        exit_code, result = self.run_runner(argv)
        self.assertEqual(exit_code, 1)
        # budget.py is allowed; only the untracked scratch file is extra.
        self.assertEqual(result["extra_changed_files"], ["newfile.txt"])

    def test_agent_timeout_with_partial_output_still_scores(self):
        # TimeoutExpired output arrives as bytes even with text=True; the
        # partial transcript must still decode, save, and count.
        event = json.dumps(
            {
                "type": "message_end",
                "message": {"role": "assistant", "usage": {"totalTokens": 42}},
            }
        )
        script = self.write_agent_script(f"cat <<'EVENTS'\n{event}\nEVENTS\nexec sleep 30\n")
        argv = [
            "--fixture",
            str(FIXTURES / "py-budget"),
            "--model",
            "test/fake",
            "--agent-bin",
            str(script),
            "--timeout",
            "1",
        ]
        exit_code, result = self.run_runner(argv)
        self.assertEqual(exit_code, 1)
        self.assertFalse(result["resolved"])
        self.assertIsNone(result["exit_code"])
        self.assertEqual(result["tokens_used"], 42)

    def test_shadow_runner_cannot_fake_resolution(self):
        # An agent-added repo-level unittest.py would shadow the stdlib
        # runner and fake a passing suite; it is reverted before scoring.
        script = self.write_agent_script(
            'cd "$6"\n'
            "cat > unittest.py <<'EOF'\n"
            "import sys\n"
            "sys.exit(0)\n"
            "EOF\n"
            "cat <<'EVENTS'\n"
            + json.dumps(
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "toolCall",
                                "id": "c1",
                                "name": "ipython",
                                "arguments": {"code": "await bash('python3 -m unittest -v')"},
                            }
                        ],
                    },
                }
            )
            + "\nEVENTS\n"
        )
        argv = ["--fixture", str(FIXTURES / "py-budget"), "--model", "test/fake", "--agent-bin", str(script)]
        exit_code, result = self.run_runner(argv)
        self.assertEqual(exit_code, 1)
        self.assertFalse(result["resolved"])
        self.assertFalse(result["target_test_passes"])
        self.assertIn("unittest.py", result["extra_changed_files"])

    def test_shutdown_agent_daemon_sends_shutdown_command(self):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        socket_dir = Path(tempfile.mkdtemp(prefix="swe-fix-sock-"))
        socket_path = socket_dir / "daemon.sock"
        server.bind(str(socket_path))
        server.listen(1)
        received = []

        def serve() -> None:
            connection, _ = server.accept()
            received.append(connection.recv(1024).decode())
            connection.close()

        thread = threading.Thread(target=serve)
        thread.start()
        runner.shutdown_agent_daemon(socket_path)
        thread.join(timeout=5)
        server.close()
        self.assertEqual(len(received), 1)
        envelope = json.loads(received[0])
        self.assertEqual(envelope["type"], "command")
        self.assertEqual(envelope["command"]["type"], "shutdown")

    def test_deleted_test_directory_still_scores(self):
        script = self.write_agent_script('cd "$6"\nrm -rf test\n')
        argv = [
            "--fixture",
            str(FIXTURES / "ts-date-utils"),
            "--model",
            "test/fake",
            "--agent-bin",
            str(script),
        ]
        exit_code, result = self.run_runner(argv)
        self.assertEqual(exit_code, 1)
        self.assertFalse(result["resolved"])
        self.assertFalse(result["target_test_passes"])
        self.assertIn("test/dates.test.js", result["extra_changed_files"])

    def test_run_command_timeout_returns_failure_result(self):
        workdir = Path(tempfile.mkdtemp(prefix="swe-fix-cmd-"))
        result = runner.run_command("sleep 30", workdir, timeout=1)
        self.assertNotEqual(result["exit_code"], 0)


if __name__ == "__main__":
    unittest.main()
