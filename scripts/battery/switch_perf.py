#!/usr/bin/env python3
"""Chat -> agents view switch latency: TS vs Rust, tmux channel both sides.

Kevin's dogfood directive (2026-09-21): "Left arrow to go from chat view to
agents view is slower than in the TS version. We want this to feel instant
and snappy." This is the verifier for the switch-snappiness lane: the same
tmux pane channel a real user types through, both products, interleaved
seeds (same session counts), one number per side — keypress-to-first-
agents-view-frame — plus the flicker check (no blank or primary-screen
frame may appear between the two views; the handoff preserves the alternate
screen).

Flow per side: fresh isolated env + daemon, N seeded saved sessions plus
the live chat session, then R rounds of Left (chat -> agents view) and
Enter (agents view -> back into the chat). Each round records the switch
latency and every frame captured inside the switch window.

Not part of the product.

Usage:
    python3 scripts/battery/switch_perf.py [--trials 5] [--saved 25]
        [--ts-bin prime-agent] [--rust-bin target/release/prime-agent]
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import batterylib as B  # noqa: E402
import perf as P  # noqa: E402
import ts_identity  # noqa: E402

# Chat-ready marker: the input prompt line, the manage bar, and the resolved
# mock model (perf.py's is_ready).
# Agents-view-ready marker: the search box placeholder both products render
# (TS `SEARCH_PROMPT_PLACEHOLDER`).
AGENTS_READY = "Search sessions"

# A primary-screen frame would show a shell prompt; the handoff must never
# leave the alternate screen, so no captured frame may match.
SHELL_PROMPT = re.compile(r"^\$ $", re.MULTILINE)

# Wire-request helper over the battery's raw socket protocol.
def wire_create(wire: B.Wire, tag: str, name: str, cwd: str, session_dir: str, runtime: dict | None = None) -> str:
    # `runtimeMetadata` only rides the create when it is non-empty: the TS
    # daemon treats its mere presence as an adopt-existing-session request
    # (an empty object sends the worker down the import path and the
    # supervisor rejects the mismatched active session id).
    create_cmd = {
        "type": "create",
        "name": name,
        "config": {
            "cwd": cwd,
            "sessionDir": session_dir,
            "provider": "prime-inference",
            "model": "mock-1",
            "thinking": "high",
            "executionMode": "print",
        },
    }
    if runtime:
        create_cmd["runtimeMetadata"] = runtime
    create = wire.request(tag, create_cmd, timeout=120)
    assert create.get("success") is True, create
    return create["data"].get("activeSessionId") or create["data"].get("id")


def make_side(name: str, binary: str, run_dir: Path) -> B.Side:
    root = run_dir / name
    agent = root / "agent"
    work = root / "work"
    if agent.exists():
        shutil.rmtree(agent)
    agent.mkdir(parents=True)
    work.mkdir(parents=True, exist_ok=True)
    mock = B.MockProvider(root, [])
    mock.set_responses([{"text": "seed reply"}])
    mock.start()
    tmpdir = Path("/tmp") / f"swperf-{name}"
    if tmpdir.exists():
        shutil.rmtree(tmpdir)
    tmpdir.mkdir(parents=True)
    side = B.Side(
        name=name,
        binary=binary,
        root=root,
        agent_dir=agent,
        work_dir=work,
        daemon_socket=root / "daemon.sock",
        mock=mock,
    )
    side.env = B.scrubbed_env(agent, tmpdir)
    if name == "rust":
        side.env["PI_PACKAGE_DIR"] = str(Path(__file__).resolve().parents[2])
    side.env["PRIME_API_KEY"] = "sk-battery"
    (agent / "settings.json").write_text(json.dumps({"onboardingShown": True}))
    side.write_models_json()
    side.start_daemon()
    return side


def seed_saved(side: B.Side, count: int) -> None:
    """Seed `count` stopped sessions so the saved catalog (Inactive rows)
    has realistic scan cost on both sides."""
    session_dir = side.agent_dir / "sessions"
    session_dir.mkdir(parents=True, exist_ok=True)
    wire = B.Wire(side.daemon_socket)
    for i in range(count):
        sid = wire_create(
            wire, f"swc{i}", f"saved seed {i}", str(side.work_dir), str(session_dir)
        )
        reply = wire.request(
            f"swp{i}",
            {"type": "prompt_and_wait", "activeSessionId": sid, "message": "seed"},
            timeout=180,
        )
        assert reply.get("success") is True, reply
        kill = wire.request(f"swk{i}", {"type": "kill", "activeSessionId": sid}, timeout=120)
        assert kill.get("success") is True, kill
    wire.close()


def measure_rounds(side: B.Side, trials: int, evidence_dir: Path) -> list[dict]:
    """One pane per side: launch into the chat, then trials rounds of
    Left (chat -> agents view) measured keypress-to-first-agents-frame,
    then Enter (back into the chat) so the next round starts settled."""
    session = f"swperf-{side.name}"
    argv = [
        side.binary,
        "--daemon-socket",
        str(side.daemon_socket),
        "--provider",
        "prime-inference",
        "--model",
        "mock-1",
        "--offline",
    ]
    # A previous crashed run can leave its pane behind (the name is
    # per-side and stable); kill any stale session before relaunching.
    B.tmux_kill(session)
    B.tmux_launch(session, argv, side.env, side.work_dir)
    ready = B.tmux_wait_text(session, r"^\s*>\s*$", timeout=60, poll=0.05)
    assert P.is_ready(side.name, ready), f"chat never settled:\n{ready[-2000:]}"
    records = []
    for i in range(trials):
        # Left: chat -> agents view. Keypress to first agents-view frame.
        t0 = time.time()
        B.tmux("send-keys", "-t", session, "Left")
        window_frames: list[tuple[float, str]] = []
        switch_ms = None
        deadline = t0 + 10.0
        while time.time() < deadline:
            frame = B.tmux_capture(session)
            window_frames.append((round((time.time() - t0) * 1000, 1), frame))
            if AGENTS_READY in frame and not P.is_ready(side.name, frame):
                switch_ms = round((time.time() - t0) * 1000, 1)
                break
            time.sleep(0.001)
        blank = [t for t, f in window_frames if not f.strip()]
        shell = [t for t, f in window_frames if SHELL_PROMPT.search(f)]
        records.append(
            {
                "trial": i,
                "switch_ms": switch_ms,
                "frames_in_window": len(window_frames),
                "blank_frame_ms": blank,
                "primary_screen_frame_ms": shell,
            }
        )
        assert switch_ms is not None, f"agents view never rendered:\n{window_frames[-1][1][-2000:]}"
        assert not blank, f"blank frame inside the switch window at {blank}ms"
        assert not shell, f"primary screen leaked into the switch window at {shell}ms"
        # Enter: back into the chat (the anchor row is the selection). The
        # empty session archives on detach (TS parity), so every reopen is
        # a saved-file resume: a kernel boot, not a measured latency — the
        # settle window must tolerate a loaded box (the switch metric is
        # the Left above, not this wait).
        B.tmux_send(session, "Enter")
        settled = B.tmux_wait_text(session, r"^\s*>\s*$", timeout=180, poll=0.05)
        assert P.is_ready(side.name, settled), f"chat did not reopen:\n{settled[-2000:]}"
        print(f"[switch-perf] {side.name}: round {i} switch {switch_ms}ms, chat reopened")
    B.tmux_kill(session)
    (evidence_dir / f"{side.name}-frames.txt").write_text(
        "\n".join(json.dumps(r) for r in records)
    )
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ts-bin", default="prime-agent")
    parser.add_argument("--rust-bin", default="target/release/prime-agent")
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--saved", type=int, default=25)
    parser.add_argument(
        "--runs-root", type=Path, default=Path(__file__).parent / "runs"
    )
    parser.add_argument("--run-name", default=None)
    args = parser.parse_args()

    ts_identity.assert_ts_side_is_the_ts_product(ts_bin=args.ts_bin, rust_bin=args.rust_bin)

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = args.runs_root / f"switch-{args.run_name or stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    print(f"[switch-perf] run dir: {run_dir}")

    report: dict = {
        "run": str(run_dir),
        "trials": args.trials,
        "saved_sessions": args.saved,
        "sides": {},
    }
    for name, binary in (("rust", args.rust_bin), ("ts", args.ts_bin)):
        side = make_side(name, binary, run_dir)
        print(f"[switch-perf] {name}: seeding {args.saved} saved sessions")
        t_seed = time.time()
        seed_saved(side, args.saved)
        print(
            f"[switch-perf] {name}: seeded in {time.time() - t_seed:.1f}s, measuring {args.trials} rounds"
        )
        records = measure_rounds(side, args.trials, run_dir)
        switch = [r["switch_ms"] for r in records]
        side_report = {
            "binary": str(binary),
            "switch_ms": switch,
            "switch_summary": P.summarize(switch),
            "flicker": {
                "blank_frames": sum(len(r["blank_frame_ms"]) for r in records),
                "primary_screen_frames": sum(len(r["primary_screen_frame_ms"]) for r in records),
            },
        }
        report["sides"][name] = side_report
        print(f"[switch-perf] {name}: {json.dumps(side_report['switch_summary'])}")
        side.stop_daemon()
        side.mock.stop()

    (run_dir / "report.json").write_text(json.dumps(report, indent=1))
    rust = report["sides"]["rust"]["switch_summary"]
    ts = report["sides"]["ts"]["switch_summary"]
    print("[switch-perf] summary (median switch ms):")
    print(f"  rust: {rust.get('median')}  ts: {ts.get('median')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
