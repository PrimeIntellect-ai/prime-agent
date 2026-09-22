#!/usr/bin/env python3
"""Perf measurement helpers for the parity battery (PERF row).

Two measurements per product side, both taken over the same tmux pane
channel a real user types through:

- startup: process launch (tmux new-session) to an interactive-ready frame
  (the input prompt plus the settled status chrome). Cold: every measured
  launch uses a fresh daemon socket, so the interactive process also spawns
  and waits for its own daemon, like a real cold start.
- typing: keystroke-to-render latency. One character at a time via tmux
  send-keys, then a capture-pane poll until the character is visible; the
  per-keystroke wall time includes the fixed tmux subprocess overhead on
  both sides, so the differential is fair.

Not part of the product.
"""

from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import batterylib as B  # noqa: E402


# Interactive-ready marker, identical for both products: the input prompt
# line, the "manage" bottom bar, and the flagged model resolved in the splash
# (TS briefly shows "model —" while the session is still loading; keystrokes
# sent in that window are swallowed, so the model id is part of ready).
READY_PROMPT = re.compile(r"^\s*>\s*$", re.MULTILINE)
READY_MODEL_ID = "mock-1"


def is_ready(side_name: str, frame: str) -> bool:
    del side_name  # the marker is product-agnostic
    return (
        bool(READY_PROMPT.search(frame))
        and "manage" in frame
        and READY_MODEL_ID in frame
    )


# The typed string: plain alphanumerics only (no tmux key-name collisions),
# distinctive enough that an accidental match elsewhere in a frame is
# implausible.
TYPING_TEXT = "zqxjvtypingfeel0123456789"

# Cold-start cleanup grace: after a wire shutdown, force-kill any process
# still holding this run's socket path in its command line.
SHUTDOWN_GRACE_S = 10.0


def stop_perf_daemon(socket_path: Path) -> None:
    """Shut the measured run's daemon down: wire `shutdown`, then a targeted
    kill of anything still referencing the socket path."""
    try:
        wire = B.Wire(socket_path)
        wire.send_command("sd", {"type": "shutdown"})
        wire.close()
    except (OSError, EOFError):
        pass
    deadline = time.time() + SHUTDOWN_GRACE_S
    needle = str(socket_path)
    while time.time() < deadline:
        if _pids_referencing(needle):
            time.sleep(0.2)
        else:
            return
    for pid in _pids_referencing(needle):
        try:
            os.kill(pid, 15)
        except (ProcessLookupError, PermissionError):
            pass
    time.sleep(0.5)


def _pids_referencing(needle: str) -> list[int]:
    hits = []
    for proc_dir in Path("/proc").iterdir():
        if not proc_dir.name.isdigit():
            continue
        try:
            cmdline = (proc_dir / "cmdline").read_bytes().decode(errors="replace")
        except (OSError, PermissionError):
            continue
        if needle in cmdline:
            hits.append(int(proc_dir.name))
    return hits


def launch_argv(side: B.Side, daemon_socket: Path) -> list[str]:
    """The interactive launch invocation every perf launch uses, onboard
    settle run included. The flagged provider/model resolve mock-1: a fresh
    install would show the first-run trace notice (both products resolve the
    startup model from settings + auth now), so the flags keep the notice
    out of the settle measurement while still exercising the readiness gate."""
    return [
        side.binary,
        "--daemon-socket",
        str(daemon_socket),
        "--provider",
        "prime-inference",
        "--model",
        "mock-1",
        "--offline",
    ]


def measure_launch(side: B.Side, tag: str, daemon_socket: Path) -> dict:
    """One cold interactive launch: startup numbers plus the typing
    measurement taken in the same session. The record carries `session`,
    `first_frame_s`, `ready_s`, `typing_ms`, and the ready frame."""
    session = tag
    daemon_socket.parent.mkdir(parents=True, exist_ok=True)
    if daemon_socket.exists():
        daemon_socket.unlink()
    argv = launch_argv(side, daemon_socket)
    t0 = time.time()
    B.tmux_launch(session, argv, side.env, side.work_dir)
    first_frame_s = None
    ready_s = None
    ready_frame = ""
    deadline = t0 + 60.0
    while time.time() < deadline:
        frame = B.tmux_capture(session)
        if first_frame_s is None and frame.strip():
            first_frame_s = round(time.time() - t0, 3)
        if is_ready(side.name, frame):
            ready_s = round(time.time() - t0, 3)
            ready_frame = frame
            break
        time.sleep(0.01)
    typing_ms: list[float] = []
    if ready_s is not None:
        typing_ms = measure_typing(session, side.name)
    B.tmux_kill(session)
    return {
        "session": session,
        "first_frame_s": first_frame_s,
        "ready_s": ready_s,
        "typing_ms": typing_ms,
        "ready_frame": ready_frame,
    }


def measure_typing(session: str, side_name: str, text: str = TYPING_TEXT) -> list[float]:
    """Per-keystroke keystroke-to-render latencies (ms) while typing `text`."""
    latencies: list[float] = []
    typed = ""
    for ch in text:
        typed += ch
        t0 = time.time()
        B.tmux("send-keys", "-t", session, "-l", ch)
        # Rendered = the typed prefix sits on the input prompt line (a
        # whole-frame substring match would false-positive on the cwd).
        pattern = re.compile(r"^\s*>\s*" + re.escape(typed), re.MULTILINE)
        rendered = False
        deadline = t0 + 2.0
        while time.time() < deadline:
            frame = B.tmux_capture(session)
            # `is_ready` demands an empty prompt line, which is false the
            # moment the first keystroke renders: here the prompt line
            # carrying the typed prefix plus the bottom bar is the evidence.
            if pattern.search(frame) and "manage" in frame:
                rendered = True
                break
            time.sleep(0.001)
        if not rendered:
            # Keep the sequence honest: a lost keystroke surfaces as a
            # timeout-shaped latency so medians do not silently drop it.
            latencies.append(round((time.time() - t0) * 1000, 1))
            break
        latencies.append(round((time.time() - t0) * 1000, 1))
        time.sleep(0.03)
    return latencies


def measure_resume(
    side: B.Side,
    tag: str,
    daemon_socket: Path,
    corpus: Path,
    timeout_s: float,
) -> dict:
    """One interactive `--resume <corpus>` launch, measured to the ready
    frame (prompt line + manage bar + resolved model id). The record
    carries `session`, `first_frame_s`, `ready_s`, and the ready frame: the
    ready time is snapshot ingest plus first full layout, the path a
    transcript-scale resume pays before the user can type."""
    session = tag
    daemon_socket.parent.mkdir(parents=True, exist_ok=True)
    if daemon_socket.exists():
        daemon_socket.unlink()
    argv = launch_argv(side, daemon_socket) + ["--resume", str(corpus)]
    t0 = time.time()
    B.tmux_launch(session, argv, side.env, side.work_dir)
    first_frame_s = None
    ready_s = None
    ready_frame = ""
    deadline = t0 + timeout_s
    while time.time() < deadline:
        frame = B.tmux_capture(session)
        if first_frame_s is None and frame.strip():
            first_frame_s = round(time.time() - t0, 3)
        if is_ready(side.name, frame):
            ready_s = round(time.time() - t0, 3)
            ready_frame = frame
            break
        time.sleep(0.05)
    B.tmux_kill(session)
    return {
        "session": session,
        "first_frame_s": first_frame_s,
        "ready_s": ready_s,
        "ready_frame_rows": len(ready_frame.splitlines()) if ready_frame else 0,
        "ready_frame_tail": ready_frame[-2000:] if ready_frame else "",
    }


def summarize(values: list[float]) -> dict:
    ordered = sorted(values)
    if not ordered:
        return {"n": 0}

    def pct(p: float) -> float:
        idx = min(len(ordered) - 1, int(round(p / 100 * (len(ordered) - 1))))
        return round(ordered[idx], 1)

    return {
        "n": len(ordered),
        "min": round(ordered[0], 1),
        "median": pct(50),
        "p95": pct(95),
        "max": round(ordered[-1], 1),
    }


def median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0
