"""Runner for the swe-fix-loop eval.

Copies a fixture repo to a temp dir, runs the agent headless against it,
records the post-state (test results, diff, transcript), and prints the
scored outcome as JSON.

Real-model runs are manual: pass --model and ensure provider auth is
configured in the environment. The harness itself is validated in CI by
model-free self-tests (tests/test_swe_fix.py).

Usage:
    uv run --locked python runner.py --fixture fixtures/ts-date-utils --model anthropic/claude-sonnet-4-5
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scorer  # noqa: E402


def run_command(command: str, cwd: Path) -> dict:
    completed = subprocess.run(
        command,
        shell=True,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=300,
    )
    return {
        "exit_code": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def fixture_outcome(fixture: dict, workdir: Path, agent_log: str) -> dict:
    test_result = run_command(fixture["test_command"], workdir)
    diff_names = subprocess.run(
        ["git", "diff", "--name-only"],
        cwd=workdir,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    changed_files = [name for name in diff_names.splitlines() if name]
    session_text = read_session_text(agent_log)
    tests_passing = test_result["exit_code"] == 0
    return {
        "changed_files": changed_files,
        "target_test_passes": tests_passing,
        "pre_existing_tests_pass": tests_passing,
        "test_run_evidence": scorer.test_run_evidence(session_text, fixture["test_command"]),
        "usage": scorer.summarize_usage(session_text),
    }


def read_session_text(agent_log: str) -> str:
    """Pull the session transcript out of the agent log.

    In --mode json the agent emits transcript events on stdout; the runner
    captures them to the log file. Scorer helpers accept any JSONL text.
    """
    return agent_log


def first_agent_error(agent_log: str) -> str | None:
    """The first error message the agent reported, for quick diagnosis.

    A zero-token unresolved run almost always means a launch or auth
    failure; surfacing the error in the result JSON saves the
    workdir-digging this field was created for.
    """
    for line in agent_log.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("message") if isinstance(entry, dict) else None
        if isinstance(message, dict) and message.get("role") == "assistant":
            error = message.get("errorMessage")
            if isinstance(error, str) and error:
                return error
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", required=True, help="Fixture directory (contains fixture.json)")
    parser.add_argument("--model", required=True, help="Model selector under test, provider/model-id")
    parser.add_argument("--timeout", type=int, default=1200, help="Agent run timeout in seconds")
    parser.add_argument("--agent-bin", default="prime-agent", help="Agent binary to invoke")
    args = parser.parse_args(argv)

    fixture_dir = Path(args.fixture).resolve()
    fixture = json.loads((fixture_dir / "fixture.json").read_text())
    task = (fixture_dir / "task.txt").read_text()

    workdir = Path(tempfile.mkdtemp(prefix="swe-fix-"))
    repo_dir = workdir / "repo"
    sessions_dir = workdir / "sessions"
    shutil.copytree(
        fixture_dir, repo_dir, ignore=shutil.ignore_patterns("fixture.json", "task.txt", "golden.patch")
    )
    for command in (
        ["git", "init", "-q"],
        ["git", "add", "-A"],
        ["git", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"],
    ):
        git_env = {
            "GIT_AUTHOR_NAME": "eval",
            "GIT_AUTHOR_EMAIL": "eval@eval",
            "GIT_COMMITTER_NAME": "eval",
            "GIT_COMMITTER_EMAIL": "eval@eval",
        }
        subprocess.run(command, cwd=repo_dir, check=True, env={**git_env})

    prompt = f"{task}\n\nWork in this repository, fix the bug, and make the full test suite pass."
    completed = subprocess.run(
        [
            args.agent_bin,
            "--mode",
            "json",
            "--cwd",
            str(repo_dir),
            "--session-dir",
            str(sessions_dir),
            "--model",
            args.model,
            "--",
            prompt,
        ],
        capture_output=True,
        text=True,
        timeout=args.timeout,
    )
    agent_log = completed.stdout
    (workdir / "agent.log").write_text(agent_log)
    # stderr is where launch and auth failures land; keep it with the result.
    (workdir / "agent.stderr").write_text(completed.stderr)

    outcome = fixture_outcome(fixture, repo_dir, agent_log)
    result = scorer.score_fixture(fixture, outcome)
    result["exit_code"] = completed.returncode
    result["workdir"] = str(workdir)
    result["agent_error"] = first_agent_error(agent_log)
    print(json.dumps(result, indent=2))
    return 0 if result["resolved"] else 1


if __name__ == "__main__":
    sys.exit(main())
