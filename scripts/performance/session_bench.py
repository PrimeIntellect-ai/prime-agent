#!/usr/bin/env python3
"""Offline Rust PR session workloads; see README.md."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import shutil
import subprocess
import tempfile
import time
import uuid

from terminal import Terminal
from resources import process_tree_rss
from provenance import harness_sha256
from runtime import wait_listener

SCENARIOS = {
    "small": (0, 0, False),
    "large": (10, 0, False),
    "catalog": (1, 150, False),
    "concurrent_large": (10, 0, True),
}
METRICS = ("cold_first_paint_ms", "cold_tail_ms", "cold_ready_ms", "agents_ms", "open_tail_ms", "open_ready_ms",
           "reopen_tail_ms", "reopen_ready_ms", "tree_rss_after_cold_bytes", "tree_rss_after_reopen_bytes")


def stop_daemon(daemon) -> None:
    # Only an unreaped owned leader anchors this process-group identity. A poll
    # that already reaped it invalidates any later signal by its former PID.
    if daemon.returncode is not None:
        return
    try:
        os.killpg(daemon.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        daemon.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(daemon.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        daemon.wait(timeout=5)


def fixture(root: Path, size_mb: int, catalog: int) -> tuple[Path, Path]:
    agent = root / "agent"
    sessions = agent / "sessions"
    sessions.mkdir(parents=True)
    (agent / "settings.json").write_text(json.dumps({"onboardingShown": True}))
    (agent / "models.json").write_text(json.dumps({"providers": {"prime-inference": {
        "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/v1", "apiKey": "benchmark-dummy",
        "models": [{"id": "mock-1", "name": "Offline fixture", "contextWindow": 128000,
                    "maxTokens": 4096}]}}}))
    for index in range(catalog + 2):
        sid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"pa-performance-{index}"))
        path = sessions / f"{sid}.jsonl"
        entries = [{"type": "session", "version": 3, "id": sid,
                    "timestamp": "2026-01-01T00:00:00.000Z", "cwd": str(root), "rlmDepth": 0},
                   {"type": "session_info", "id": "name", "parentId": None,
                    "timestamp": "2026-01-01T00:00:00.000Z", "name": f"bench-target-{index}"}]
        count = max(2, size_mb * 1024) if index < 2 else 2
        for row in range(count):
            entries.append({"type": "message", "id": f"m{row}",
                            "parentId": f"m{row - 1}" if row else "name",
                            "timestamp": "2026-01-01T00:00:00.000Z",
                            "message": {"role": "assistant" if row % 2 else "user",
                                        "content": [{"type": "text", "text":
                                                     f"TAIL-{index}" if row == count - 1 else "x" * 1024}]}})
        with path.open("w") as output:
            output.write("".join(json.dumps(entry) + "\n" for entry in entries))
            output.flush()
            os.fsync(output.fileno())
    # Flush only owned fixture files, avoiding a host-wide sync on the user's Mac.
    if platform.system() == "Linux":
        directory_fd = os.open(sessions, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    return agent, sessions / f"{uuid.uuid5(uuid.NAMESPACE_URL, 'pa-performance-0')}.jsonl"


def measure(binary: Path, runtime: Path, scenario: str, evidence: Path) -> dict:
    size, catalog, concurrent = SCENARIOS[scenario]
    # Short Unix socket paths also leave room for worker socket suffixes on macOS.
    with tempfile.TemporaryDirectory(prefix="pa-perf-", dir="/tmp") as temporary:
        root = Path(temporary)
        agent, target = fixture(root, size, catalog)
        (root / "home").mkdir()
        (root / "tmp").mkdir()
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(root / "home"),
               "TMPDIR": str(root / "tmp"), "TERM": "xterm-256color",
               "PRIME_AGENT_CODING_AGENT_DIR": str(agent), "PRIME_AGENT_TELEMETRY": "0",
               "PRIME_AGENT_KERNEL_PYTHON": str(runtime), "UV_OFFLINE": "1",
               "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}
        socket = str(root / "d.sock")
        argv = [str(binary), "--daemon-socket", socket, "--offline", "--provider", "prime-inference",
                "--model", "mock-1", "--resume", str(target)]
        apps = []
        # The daemon's process group is exclusively ours, including workers/kernels.
        with (evidence / "daemon.log").open("wb") as log:
            started = time.perf_counter()
            daemon = subprocess.Popen([str(binary), "--mode", "daemon", "--daemon-socket", socket, "--offline"],
                                      env=env, cwd=root, stdout=log, stderr=log, start_new_session=True)
            try:
                wait_listener(socket, daemon)
                app = Terminal(argv, root, env, evidence / "main")
                apps.append(app)
                app.until(lambda display: bool(display.text().strip()), 60)
                first_paint = (time.perf_counter() - started) * 1000
                app.until(lambda display: "TAIL-0" in display.text(), 60)
                result = {"cold_first_paint_ms": first_paint, "cold_tail_ms": (time.perf_counter() - started) * 1000}
                result["cold_ready_ms"] = (app.started - started + app.ready(60)) * 1000
                readiness = {'cold': dict(app.last_ready)}
                resources = {"after_cold_ready": process_tree_rss([daemon.pid, app.child.pid])}
                for iteration in range(2):
                    # Warm navigation has a fixed idle cadence after typing.
                    # Early editor echo can precede completion of session-open
                    # handoff; cold paint/echo timings above remain unchanged.
                    app.settle(1.0)
                    t0 = time.perf_counter()
                    app._send("\x1b[D")
                    app.until(lambda display: "Enter/→ open" in display.text() and
                              "TAIL-0" not in display.text(), 30)
                    if iteration == 0:
                        result["agents_ms"] = (time.perf_counter() - t0) * 1000
                    # The agents view retains its prior filter across reattach.
                    # A row label is not acknowledgment of its search editor.
                    # This untimed setup types one character per rendered echo,
                    # with balanced clear/retry if the handler isn't ready yet.
                    search_deadline = time.perf_counter() + 30
                    for length in range(1, len("bench-target-0") + 1):
                        prefix = "bench-target-0"[:length]
                        app._send(('\x15' if length == 1 else '') + prefix[-1])
                        while True:
                            try:
                                app.until(lambda display: any(line.lstrip().startswith('>') and
                                          line.lstrip()[1:].strip() == prefix
                                          for line in display.text().splitlines()), .2)
                                break
                            except TimeoutError:
                                if time.perf_counter() >= search_deadline:
                                    raise TimeoutError('agents search editor did not acknowledge typing')
                                app._send('\x15' + prefix)
                    if concurrent:
                        other = target.with_name(f"{uuid.uuid5(uuid.NAMESPACE_URL, 'pa-performance-1')}.jsonl")
                        background = Terminal(argv[:-1] + [str(other)], root, env,
                                              evidence / f"background-{iteration}")
                        apps.append(background)
                        background.until(lambda display: 'TAIL-1' in display.text(), 60)
                        background.ready(60)
                        app.peers.append(background)
                    t0 = time.perf_counter()
                    app._send("\r")
                    app.until(lambda display: "TAIL-0" in display.text() and
                              "Enter/→ open" not in display.text(), 60)
                    prefix = "open" if iteration == 0 else "reopen"
                    result[f"{prefix}_tail_ms"] = (time.perf_counter() - t0) * 1000
                    # Terminal.ready returns an offset from terminal launch; subtract the action offset.
                    result[f"{prefix}_ready_ms"] = (app.ready(60) - (t0 - app.started)) * 1000
                    readiness[prefix] = dict(app.last_ready)
                    if concurrent:
                        app.peers.remove(background)
                        background.close()
                        apps.remove(background)
                resources["after_reopen_ready"] = process_tree_rss([daemon.pid, app.child.pid])
                result["tree_rss_after_cold_bytes"] = resources["after_cold_ready"]["rss_bytes"]
                result["tree_rss_after_reopen_bytes"] = resources["after_reopen_ready"]["rss_bytes"]
                return {"metrics": result, "loadavg": list(os.getloadavg()), "resources": resources,
                        "readiness_diagnostics": readiness}
            finally:
                close_errors = []
                for app in apps:
                    try:
                        app.close()
                    except Exception as error:
                        close_errors.append(str(error))
                stop_daemon(daemon)
                if (agent / "logs").exists():
                    shutil.copytree(agent / "logs", evidence / "logs")
                if close_errors:
                    raise RuntimeError(f"terminal cleanup failed: {close_errors}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for side in ("base", "head"):
        parser.add_argument(f"--{side}-bin", type=Path, required=True)
        parser.add_argument(f"--{side}-sha", required=True)
        parser.add_argument(f"--{side}-runtime", type=Path, required=True)
        parser.add_argument(f"--{side}-runtime-manifest", type=Path)
    parser.add_argument("--trials", type=int, default=10)
    parser.add_argument("--scenario", choices=SCENARIOS, action="append")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.trials <= 30:
        parser.error("trials must be 1..30")
    if not all(re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (args.base_sha, args.head_sha)):
        parser.error("baseline and head revisions must be full lowercase commit SHAs")
    args.out.mkdir(parents=True, exist_ok=False)
    scenarios = tuple(dict.fromkeys(args.scenario or SCENARIOS))
    report = {"schema": 1, "base_sha": args.base_sha, "head_sha": args.head_sha,
              "harness_sha256": harness_sha256(),
              "dependency_lock_sha256": hashlib.sha256(Path(__file__).with_name("requirements.lock").read_bytes()).hexdigest(),
              "fixture_version": 2, "scenario_config": SCENARIOS,
              "trials": args.trials, "host": {"os": platform.platform(), "cpu": platform.processor(),
                                             "cores": os.cpu_count()}, "sides": {}}
    for side in ("base", "head"):
        binary = getattr(args, f"{side}_bin").resolve(strict=True)
        report["sides"][side] = {"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                                  "runtime_command_sha256": hashlib.sha256(getattr(args, f'{side}_runtime').read_bytes()).hexdigest(),
                                  "runtime_manifest_sha256": hashlib.sha256(getattr(args, f'{side}_runtime_manifest').read_bytes()).hexdigest() if getattr(args, f'{side}_runtime_manifest') else None,
                                  "samples": {name: [] for name in scenarios}}
    try:
        for scenario in scenarios:
            for trial in range(args.trials):
                # ABBA over adjacent trials, baseline and head share a host.
                for side in (("base", "head") if trial % 2 == 0 else ("head", "base")):
                    evidence = args.out / f"{scenario}-{trial}-{side}"
                    evidence.mkdir()
                    sample = measure(getattr(args, f"{side}_bin").resolve(),
                                     getattr(args, f"{side}_runtime").absolute(), scenario, evidence)
                    report["sides"][side]["samples"][scenario].append(sample)
        report["status"] = "completed"
    except Exception:
        report["status"] = "failed"
        raise
    finally:
        (args.out / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
