"""Runner for the swarm-fanout eval.

Copies a fixture repo to a temp dir, runs the parent agent headless
against it, records the post-state (RLM spawn ledger, parent transcript,
child session dirs, combined artifact), and prints the scored outcome
as JSON.

The parent is expected to fan out one RLM child per data shard and fan
the answers back in. Real-model runs are manual: pass --model and ensure
provider auth is configured in the environment. The harness itself is
validated model-free by tests/test_swarm_fanout.py.

Usage:
    uv run --locked python runner.py --fixture fixtures/json-events --model anthropic/claude-sonnet-4-5
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scorer  # noqa: E402

RLM_LEDGER_DIR = "rlm-ledger"


def _captured_text(output: str | bytes | None) -> str:
    """Decode captured subprocess output.

    TimeoutExpired output arrives as bytes even with text=True.
    """
    if output is None:
        return ""
    if isinstance(output, bytes):
        return output.decode(errors="replace")
    return output


def canonicalize_dir_path(dir_path: str) -> str:
    """Mirror the product ledger's canonicalization.

    rlmLedgerPath realpaths a sessions dir that exists and falls back to
    plain resolve otherwise, so the runner must reproduce both branches
    to land on the same ledger file the daemon writes.
    """
    resolved = os.path.abspath(dir_path)
    if os.path.exists(resolved):
        return os.path.realpath(resolved)
    return resolved


def ledger_file_candidates(agent_home: Path, sessions_dir: str) -> list[Path]:
    """Ledger path candidates for a sessions dir, most likely first.

    The daemon canonicalizes (realpaths) the sessions dir before hashing
    it into the ledger file name; the plain-resolved variant is checked
    second in case the directory did not exist when the daemon first
    constructed its ledger.
    """
    ledger_dir = Path(agent_home) / RLM_LEDGER_DIR
    candidates = []
    for variant in (canonicalize_dir_path(sessions_dir), os.path.abspath(sessions_dir)):
        digest = hashlib.sha256(variant.encode("utf-8")).hexdigest()[:16]
        candidate = ledger_dir / f"{digest}.jsonl"
        if candidate not in candidates:
            candidates.append(candidate)
    return candidates


def find_ledger_file(agent_home: Path, sessions_dir: str) -> Path | None:
    for candidate in ledger_file_candidates(agent_home, sessions_dir):
        if candidate.is_file():
            return candidate
    return None


def read_ledger_text(agent_home: Path, sessions_dir: str) -> str:
    ledger_file = find_ledger_file(agent_home, sessions_dir)
    if ledger_file is None:
        return ""
    try:
        return ledger_file.read_text()
    except OSError:
        return ""


def find_parent_session_file(sessions_dir: Path, ledger_text: str) -> Path | None:
    """Locate the parent session file in the sessions dir.

    The spawn records name the parent session file directly; when the
    ledger is empty (a no-spawn run) the newest session file is the
    parent - the eval launches exactly one client session.
    """
    session_files = sorted(sessions_dir.glob("*.jsonl"))
    if not session_files:
        return None
    records, _malformed = scorer.parse_ledger(ledger_text)
    parents = set()
    for entry in records:
        if entry.get("op") != "spawn" or not isinstance(entry.get("parent"), str):
            continue
        segments = scorer._path_segments(entry["parent"])
        if segments:
            parents.add(segments[-1])
    matching = [path for path in session_files if path.name in parents]
    if matching:
        return matching[0]
    return max(session_files, key=lambda path: path.stat().st_mtime)


def collect_child_session_dirs(sessions_dir: Path, parent_session_file: Path | None) -> dict[str, list[str]]:
    """sub-* child dirs under the parent's session artifact dir, by name.

    Child sessions live next to their parent's artifacts
    (session-artifacts/<parent-id>/sub-<uuid8>/), each holding the
    child's session JSONL. The dir-to-files mapping lets the scorer
    verify each ledger edge's recorded child file exists on disk, so a
    dir unrelated to the ledger's children cannot stand in for one.
    """
    if parent_session_file is None:
        return {}
    artifacts_root = sessions_dir.parent / "session-artifacts"
    parent_artifacts = artifacts_root / parent_session_file.stem
    if not parent_artifacts.is_dir():
        return {}
    child_dirs: dict[str, list[str]] = {}
    for child_dir in sorted(parent_artifacts.iterdir()):
        if not child_dir.is_dir() or not child_dir.name.startswith("sub-"):
            continue
        session_files = sorted(path.name for path in child_dir.glob("*.jsonl"))
        if session_files:
            child_dirs[child_dir.name] = session_files
    return child_dirs


def read_artifact_text(repo_dir: Path, artifact: str) -> str:
    try:
        return (repo_dir / artifact).read_text()
    except OSError:
        return ""


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


def shutdown_agent_daemon(socket_path: Path, retry_window_s: float = 0.0) -> None:
    """Stop the daemon the agent run leaves listening on the eval socket.

    The CLI spawns a detached daemon per --daemon-socket; without this,
    repeated evals accumulate orphan daemons and a timed-out run keeps
    its worker going. Client commands ride in a protocol envelope; the
    shutdown command closes the daemon's sessions before it exits.

    A timed-out launch can die before the detached daemon finished
    binding its socket; the daemon then comes up orphaned and never sees
    the shutdown. With a retry window the teardown waits for the socket
    to appear and still delivers the shutdown.
    """
    envelope = json.dumps(
        {
            "type": "command",
            "id": "eval-shutdown",
            "protocol": {"name": "prime-agent.daemon", "version": 7},
            "command": {"type": "shutdown"},
        }
    )
    deadline = time.monotonic() + retry_window_s
    while True:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(10)
                client.connect(str(socket_path))
                client.sendall(envelope.encode() + b"\n")
                while client.recv(4096):
                    pass
            return
        except OSError:
            if time.monotonic() >= deadline:
                # No daemon on the socket (launch failure or a stub
                # agent): done.
                return
            time.sleep(0.25)


def agent_env(agent_home: Path, sessions_dir: str) -> dict:
    """A clean, isolated environment for the agent subprocess.

    The eval agent must be an independent root session: every PRIME_AGENT_INTERNAL_*
    variable an embedding session might leak is stripped (a child inheriting
    them would try to attach to the parent's worker), the agent runs under
    its own PRIME_AGENT_CODING_AGENT_DIR / PI_CODING_AGENT_DIR (the workspace
    launcher's env prefix derives from the package config name) so it never
    touches a production agent dir, and the credential file is copied in so
    model auth works without sharing any state.

    The session dir env override matters beyond the --session-dir flag: the
    detached daemon is launched without that flag and keys its RLM spawn
    ledger on the env override, so the scorer can compute the ledger path
    deterministically.
    """
    env = {key: value for key, value in os.environ.items() if not key.startswith("PRIME_AGENT_INTERNAL_")}
    for key in (
        "PRIME_AGENT_BASH_SHELL",
        "PRIME_AGENT_BASH_COMMAND_PREFIX",
        # Depth overrides from an embedding RLM session would start the
        # eval parent at the wrong depth or block spawning shard children.
        "RLM_DEPTH",
        "RLM_MAX_DEPTH",
    ):
        env.pop(key, None)
    source_agent_dir = Path(env.get("PRIME_AGENT_CODING_AGENT_DIR") or Path.home() / ".prime" / "agent")
    source_auth = source_agent_dir / "auth.json"
    if source_auth.is_file():
        agent_home.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_auth, agent_home / "auth.json")
    env["PRIME_AGENT_CODING_AGENT_DIR"] = str(agent_home)
    env["PI_CODING_AGENT_DIR"] = str(agent_home)
    env["PRIME_AGENT_SESSION_DIR"] = sessions_dir
    env["PI_SESSION_DIR"] = sessions_dir
    env["PRIME_AGENT_CODING_AGENT_SESSION_DIR"] = sessions_dir
    env["PI_CODING_AGENT_SESSION_DIR"] = sessions_dir
    return env


def init_fixture_repo(fixture_dir: Path, repo_dir: Path) -> None:
    """Copy the fixture into a fresh git repo.

    The fixture manifest and task prompt stay out of the repo: the agent
    works on the shards alone, and expected answers never reach it.
    """
    shutil.copytree(
        fixture_dir,
        repo_dir,
        ignore=shutil.ignore_patterns("fixture.json", "task.txt"),
    )
    # Strip git location variables before initializing the temp repo: with
    # GIT_DIR, GIT_INDEX_FILE, or GIT_WORK_TREE inherited from the caller,
    # git add/commit would operate on the caller-selected repository instead
    # of repo_dir. The environment is built fresh (not layered on
    # os.environ) so a stripped variable cannot re-enter via the merge.
    git_env = {
        key: value
        for key, value in os.environ.items()
        if key
        not in {
            "GIT_DIR",
            "GIT_INDEX_FILE",
            "GIT_WORK_TREE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_COMMON_DIR",
        }
    }
    git_env.update(
        {
            "GIT_AUTHOR_NAME": "eval",
            "GIT_AUTHOR_EMAIL": "eval@eval",
            "GIT_COMMITTER_NAME": "eval",
            "GIT_COMMITTER_EMAIL": "eval@eval",
        }
    )
    for command in (
        ["git", "init", "-q"],
        ["git", "add", "-A"],
        ["git", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"],
    ):
        subprocess.run(command, cwd=repo_dir, check=True, env=git_env)


def collect_outcome(sessions_dir: Path, agent_home: Path, repo_dir: Path, agent_log: str) -> dict:
    """Gather every artifact the rubric scores from the post-run state."""
    ledger_text = read_ledger_text(agent_home, str(sessions_dir))
    parent_session_file = find_parent_session_file(sessions_dir, ledger_text)
    parent_transcript_text = ""
    if parent_session_file is not None:
        try:
            parent_transcript_text = parent_session_file.read_text()
        except OSError:
            parent_transcript_text = ""
    return {
        "ledger_text": ledger_text,
        "parent_transcript_text": parent_transcript_text,
        "child_session_dirs": collect_child_session_dirs(sessions_dir, parent_session_file),
        "artifact_text": read_artifact_text(repo_dir, "combined-index.md"),
        "usage": scorer.summarize_usage(agent_log),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", required=True, help="Fixture directory (contains fixture.json)")
    parser.add_argument("--model", required=True, help="Model selector under test, provider/model-id")
    parser.add_argument("--timeout", type=int, default=1800, help="Agent run timeout in seconds")
    parser.add_argument("--agent-bin", default="prime-agent", help="Agent binary to invoke")
    args = parser.parse_args(argv)

    if sys.platform == "win32":
        # The eval contract (per-workdir Unix daemon socket plus an
        # AF_UNIX shutdown client) has no Windows named-pipe support;
        # refuse loudly instead of failing obscurely mid-run.
        print(
            "swarm-fanout eval requires a Unix-domain-socket platform; Windows named pipes are not supported",
            file=sys.stderr,
        )
        return 1

    fixture_dir = Path(args.fixture).resolve()
    fixture = json.loads((fixture_dir / "fixture.json").read_text())
    task = (fixture_dir / "task.txt").read_text()

    workdir = Path(tempfile.mkdtemp(prefix="swarm-fanout-"))
    repo_dir = workdir / "repo"
    sessions_dir = workdir / "sessions"
    sessions_dir.mkdir()
    sessions_dir = Path(canonicalize_dir_path(str(sessions_dir)))
    agent_home = workdir / "agent-home"
    init_fixture_repo(fixture_dir, repo_dir)

    timed_out = False
    started = time.monotonic()
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
                task,
            ],
            env=agent_env(agent_home, str(sessions_dir)),
            capture_output=True,
            text=True,
            timeout=args.timeout,
        )
        agent_log = completed.stdout
        stderr_text = completed.stderr
        exit_code = completed.returncode
    except subprocess.TimeoutExpired as exc:
        # A timed-out run still scores; keep whatever transcript exists.
        timed_out = True
        agent_log = _captured_text(exc.stdout)
        stderr_text = _captured_text(exc.stderr)
        exit_code = None
    except OSError as exc:
        # A missing or non-executable agent binary still produces a result.
        agent_log = ""
        stderr_text = str(exc)
        exit_code = None
    finally:
        wall_time_s = time.monotonic() - started
        # A timed-out run may have died mid daemon-spawn: give the
        # detached daemon time to bind before shutting it down.
        shutdown_agent_daemon(workdir / "daemon.sock", retry_window_s=8.0 if timed_out else 0.0)
    (workdir / "agent.log").write_text(agent_log)
    # stderr is where launch and auth failures land; keep it with the result.
    (workdir / "agent.stderr").write_text(stderr_text)

    outcome = collect_outcome(sessions_dir, agent_home, repo_dir, agent_log)
    outcome["wall_time_s"] = wall_time_s
    result = scorer.score_fixture(fixture, outcome)
    result["exit_code"] = exit_code
    result["timed_out"] = timed_out
    result["workdir"] = str(workdir)
    result["model"] = args.model
    result["agent_error"] = first_agent_error(agent_log) or first_stderr_error(stderr_text)
    print(json.dumps(result, indent=2))
    return 0 if result["resolved"] else 1


if __name__ == "__main__":
    sys.exit(main())
