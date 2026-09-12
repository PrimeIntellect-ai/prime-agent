"""Runner for the swe-fix-loop eval.

Copies a fixture repo to a temp dir, runs the agent headless against it,
records the post-state (test results, diff, transcript), and prints the
scored outcome as JSON.

Real-model runs are manual: pass --model and ensure provider auth is
configured in the environment. The harness itself is validated by
model-free self-tests (tests/test_swe_fix.py).

Usage:
    uv run --locked python runner.py --fixture fixtures/ts-date-utils --model anthropic/claude-sonnet-4-5
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scorer  # noqa: E402


def _captured_text(output: str | bytes | None) -> str:
    """Decode captured subprocess output.

    TimeoutExpired output arrives as bytes even with text=True.
    """
    if output is None:
        return ""
    if isinstance(output, bytes):
        return output.decode(errors="replace")
    return output


def run_command(command: str, cwd: Path, timeout: int = 300) -> dict:
    try:
        completed = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        # A hanging command must still score as a failure, not abort the eval.
        return {
            "exit_code": 124,
            "stdout": _captured_text(exc.stdout),
            "stderr": _captured_text(exc.stderr),
        }
    return {
        "exit_code": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def repo_changes(repo_dir: Path, initial_sha: str) -> tuple[list[str], list[str]]:
    """Tracked changes against the initial commit, and untracked (new) files."""
    tracked = subprocess.run(
        ["git", "diff", "--name-only", initial_sha],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return (
        [line for line in tracked.splitlines() if line],
        [line for line in untracked.splitlines() if line],
    )


def restore_scoring_tree(fixture: dict, repo_dir: Path, initial_sha: str) -> None:
    """Revert every change outside allowed_files, including new files.

    The scored suites then run the fixture's pristine tests and runners
    plus the agent's allowed edits, so edited tests or agent-added shadow
    runners (for example a repo-level unittest.py) cannot mask a failed
    fix.
    """
    allowed = set(fixture.get("allowed_files", []))
    tracked, untracked = repo_changes(repo_dir, initial_sha)
    reverted = [path for path in tracked if path not in allowed]
    if reverted:
        subprocess.run(["git", "checkout", initial_sha, "--", *reverted], cwd=repo_dir, check=True)
    for path in untracked:
        if path not in allowed:
            (repo_dir / path).unlink(missing_ok=True)


def fixture_outcome(fixture: dict, workdir: Path, initial_sha: str, agent_log: str) -> dict:
    # Record the diff before restoring so out-of-scope edits stay visible
    # in the containment report even though they are reverted for scoring.
    tracked, untracked = repo_changes(workdir, initial_sha)
    changed_files = sorted(set(tracked) | set(untracked))
    restore_scoring_tree(fixture, workdir, initial_sha)
    suite_result = run_command(fixture["test_command"], workdir)
    target_result = run_command(fixture["target_test_command"], workdir)
    session_text = read_session_text(agent_log)
    return {
        "changed_files": changed_files,
        "target_test_passes": target_result["exit_code"] == 0,
        "pre_existing_tests_pass": suite_result["exit_code"] == 0,
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


def first_stderr_error(stderr: str) -> str | None:
    """The first stderr line, where launch and auth failures surface."""
    for line in stderr.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return None


def shutdown_agent_daemon(socket_path: Path) -> None:
    """Stop the daemon the agent run leaves listening on the eval socket.

    The CLI spawns a detached daemon per --daemon-socket; without this,
    repeated evals accumulate orphan daemons and a timed-out run keeps
    its worker going. Client commands ride in a protocol envelope; the
    shutdown command closes the daemon's sessions before it exits.
    """
    envelope = json.dumps(
        {
            "type": "command",
            "id": "eval-shutdown",
            "protocol": {"name": "prime-agent.daemon", "version": 7},
            "command": {"type": "shutdown"},
        }
    )
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(10)
            client.connect(str(socket_path))
            client.sendall(envelope.encode() + b"\n")
            while client.recv(4096):
                pass
    except OSError:
        # No daemon on the socket (launch failure or a stub agent): done.
        pass


def agent_env(agent_home: Path) -> dict:
    """A clean, isolated environment for the agent subprocess.

    The eval agent must be an independent root session: every PRIME_AGENT_INTERNAL_*
    variable an embedding session might leak is stripped (a child inheriting
    them would try to attach to the parent's worker), the agent runs under
    its own PRIME_AGENT_CODING_AGENT_DIR / PI_CODING_AGENT_DIR (the workspace
    launcher's env prefix derives from the package config name) so it never
    touches a production agent dir, and the credential file is copied in so
    model auth works without sharing any state.
    """
    env = {key: value for key, value in os.environ.items() if not key.startswith("PRIME_AGENT_INTERNAL_")}
    for key in ("PRIME_AGENT_BASH_SHELL", "PRIME_AGENT_BASH_COMMAND_PREFIX"):
        env.pop(key, None)
    source_agent_dir = Path(env.get("PRIME_AGENT_CODING_AGENT_DIR") or Path.home() / ".prime" / "agent")
    source_auth = source_agent_dir / "auth.json"
    if source_auth.is_file():
        agent_home.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_auth, agent_home / "auth.json")
    env["PRIME_AGENT_CODING_AGENT_DIR"] = str(agent_home)
    env["PI_CODING_AGENT_DIR"] = str(agent_home)
    return env


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
    git_env = {
        "GIT_AUTHOR_NAME": "eval",
        "GIT_AUTHOR_EMAIL": "eval@eval",
        "GIT_COMMITTER_NAME": "eval",
        "GIT_COMMITTER_EMAIL": "eval@eval",
    }
    for command in (
        ["git", "init", "-q"],
        ["git", "add", "-A"],
        ["git", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"],
    ):
        # Extend the ambient environment rather than replacing it: the git
        # identity vars describe the commit author, not a new environment.
        subprocess.run(command, cwd=repo_dir, check=True, env={**os.environ, **git_env})
    initial_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    prompt = f"{task}\n\nWork in this repository, fix the bug, and make the full test suite pass."
    try:
        completed = subprocess.run(
            [
                args.agent_bin,
                "--mode",
                "json",
                "--daemon-socket",
                str(workdir / "daemon.sock"),
                "--cwd",
                str(repo_dir),
                "--session-dir",
                str(sessions_dir),
                "--model",
                args.model,
                "--",
                prompt,
            ],
            env=agent_env(workdir / "agent-home"),
            capture_output=True,
            text=True,
            timeout=args.timeout,
        )
        agent_log = completed.stdout
        stderr_text = completed.stderr
        exit_code = completed.returncode
    except subprocess.TimeoutExpired as exc:
        # A timed-out run still scores; keep whatever transcript exists.
        agent_log = _captured_text(exc.stdout)
        stderr_text = _captured_text(exc.stderr)
        exit_code = None
    except OSError as exc:
        # A missing or non-executable agent binary still produces a result.
        agent_log = ""
        stderr_text = str(exc)
        exit_code = None
    finally:
        shutdown_agent_daemon(workdir / "daemon.sock")
    (workdir / "agent.log").write_text(agent_log)
    # stderr is where launch and auth failures land; keep it with the result.
    (workdir / "agent.stderr").write_text(stderr_text)

    outcome = fixture_outcome(fixture, repo_dir, initial_sha, agent_log)
    result = scorer.score_fixture(fixture, outcome)
    result["exit_code"] = exit_code
    result["workdir"] = str(workdir)
    result["agent_error"] = first_agent_error(agent_log) or first_stderr_error(stderr_text)
    print(json.dumps(result, indent=2))
    return 0 if result["resolved"] else 1


if __name__ == "__main__":
    sys.exit(main())
