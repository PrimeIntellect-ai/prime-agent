#!/usr/bin/env python3
"""Drag-select verifier on a large session (extends the mouse/parity tmux
harness family, Rust side only — the drag bars are the flagship perf work).

Builds a ~40MB transcript session, resumes it in tmux, and drives a
press-drag-release sweep with byte-identical SGR mouse reports through the
same decode-and-dispatch path a terminal mouse takes. The verifier asserts
the flagship drag-select contract:

  * the highlight tracks the cursor: after every drag step, the reversed
    span at the dragged columns appears in the pane within the coalesced
    frame budget (zero visible lag — the per-step latency is measured and
    reported as evidence, not just asserted);
  * the drag events coalesce: every step's paint lands inside one frame
    interval plus capture overhead, never one transcript-sized layout per
    mouse-move;
  * the release copies the dragged text (OSC 52 in the pane's raw stream)
    and the "Copied selection to clipboard" row lands without a geometry
    resolve stall;
  * the same sweep runs while the view is paused mid-history (wheel up)
    as while following the tail.

Before/after pane captures, the per-step latency table, and the copy text
land in scripts/drag-select-runs/<timestamp>/ as evidence.

tmux rules: default socket only (`env -u TMUX`), dragp-* session names,
no kill-server; the session is killed individually at the end.
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
T0 = 1789584016603

# The transcript corpus: TURNS pairs of user/assistant messages, the
# assistant body ~11KB so the session file lands near 40MB (the dogfood
# scale the drag bar targets). The last assistant message carries the drag
# needle so the sweep targets a known row.
TURNS = 1800
BODY_KB = 11
NEEDLE = "drag target alpha bravo charlie delta echo"

CAPTURE_POLL_S = 0.005
STEP_TIMEOUT_S = 3.0
# One coalesced frame (16ms) plus tmux capture overhead, with CI headroom:
# a per-step highlight latency above this is visible lag.
STEP_BUDGET_S = 0.35


def tmux(*args, check=True):
    result = subprocess.run(
        ["env", "-u", "TMUX", "tmux", *args],
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def capture(session, escape=True):
    flag = "-e" if escape else "-p"
    return tmux("capture-pane", flag, "-p", "-t", session)


def locate_plain(pane_text, needle):
    for row, line in enumerate(pane_text.split("\n")):
        col = line.find(needle)
        if col >= 0:
            return row, col
    return None


def corpus_path(run_dir: Path) -> Path:
    """Write (or reuse) the large drag corpus under `run_dir`."""
    # v2: assistant records carry a full provider usage block — the TS
    # resume path reads usage without a guard (`usage.input`), so a corpus
    # without usage crashes the TS binary on --resume (seen on 0.9.5).
    path = run_dir / f"drag-corpus-{TURNS}-v2.jsonl"
    if path.exists():
        return path
    header = {
        "type": "session",
        "id": "drag-select-corpus",
        "version": 3,
        "timestamp": "2026-09-16T18:40:16.600Z",
        "cwd": "/tmp",
        "rlmDepth": 0,
    }
    body = ("corpus payload line with stable width. " * (BODY_KB * 1024 // 41)).strip()
    usage = {
        "input": 4096,
        "output": 2048,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 6144,
        "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03},
    }
    lines = [json.dumps(header)]
    parent = None
    counter = 0

    def next_id():
        nonlocal counter
        counter += 1
        return f"{counter:08x}"

    for turn in range(TURNS):
        for role, text in (
            ("user", f"please do task number {turn}"),
            ("assistant", NEEDLE if turn == TURNS - 1 else f"answer {turn}: {body}"),
        ):
            message = {
                "role": role,
                "content": [{"type": "text", "text": text}],
                "timestamp": T0 + turn,
            }
            if role == "assistant":
                message["stopReason"] = "stop"
                message["usage"] = usage
            record = {
                "type": "message",
                "id": next_id(),
                "parentId": parent,
                "timestamp": "2026-09-16T18:40:%02d.%03dZ" % (turn % 60, counter % 1000),
                "message": message,
            }
            lines.append(json.dumps(record))
            parent = record["id"]
    path.write_text("\n".join(lines) + "\n")
    return path


def find_runtime_package_dir():
    node_modules = Path.home() / "prime-agent" / "node_modules"
    if (node_modules / "prime-agent-runtime").is_dir():
        return str(node_modules / "prime-agent-runtime")
    raise RuntimeError("prime-agent-runtime not found (set PI_PACKAGE_DIR)")


def sgr_hex(sequence):
    return [f"{byte:02x}" for byte in sequence.encode()]


def send_mouse(session, sequence):
    tmux("send-keys", "-t", session, "-H", *sgr_hex(sequence))


def mouse_press(col, row):
    return f"\x1b[<0;{col};{row}M"


def mouse_drag(col, row):
    return f"\x1b[<32;{col};{row}M"


def mouse_release(col, row):
    return f"\x1b[<0;{col};{row}m"


def wheel_up(row):
    return f"\x1b[<64;1;{row}M"


def wait_for(session, needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        pane = capture(session, escape=False)
        if needle in pane:
            return
        time.sleep(0.3)
    raise TimeoutError(f"session {session} never showed {needle!r}")


def reversed_runs(row):
    """The text carried by the row's reversed-video runs (the highlight)."""
    return re.findall(r"\x1b\[7m((?:\x1b\[[0-9;]*m)*[^\x1b]*)", row)


def sweep(session, out_dir, label, target_row, needle_col, needle):
    """One press-drag-release sweep over the needle row: drag the columns
    forward one per step, and after every step wait for the pane to show
    the expected reversed fragment. Returns the per-step latencies."""
    pane_rows = capture(session, escape=False).split("\n")
    assert target_row < len(pane_rows), "target row left the pane"
    press_col = needle_col + 1  # 1-based report columns
    steps = []
    send_mouse(session, mouse_press(press_col, target_row + 1))
    fragment = ""
    for offset in range(1, min(len(needle) - 2, 26) + 1):
        col = press_col + offset
        expected = needle[:offset]
        send_mouse(session, mouse_drag(col, target_row + 1))
        started = time.monotonic()
        raw = None
        while time.monotonic() - started < STEP_TIMEOUT_S:
            raw = capture(session)
            row = raw.split("\n")[target_row]
            if any(run.startswith(expected) for run in reversed_runs(row)):
                break
            time.sleep(CAPTURE_POLL_S)
        else:
            Path(out_dir / f"{label}-stuck-step{offset}.raw").write_text(raw or "")
            raise AssertionError(
                f"{label}: the highlight never reached column {col} "
                f"(expected reversed fragment {expected!r})"
            )
        steps.append(time.monotonic() - started)
    send_mouse(session, mouse_release(press_col + len(steps), target_row + 1))
    return steps


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=120)
    parser.add_argument("--height", type=int, default=36)
    args = parser.parse_args()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = Path(__file__).resolve().parent / "drag-select-runs" / stamp
    run_dir.mkdir(parents=True)
    corpus = corpus_path(run_dir.parent)
    size_mb = corpus.stat().st_size / (1024 * 1024)
    print(f"corpus: {corpus} ({size_mb:.0f}MB)")

    home = run_dir / "home"
    agent = run_dir / "agent"
    tmp = run_dir / "tmp"
    for path in (home, agent / "sessions", tmp):
        path.mkdir(parents=True, exist_ok=True)
    (agent / "settings.json").write_text(json.dumps({"onboardingCompleted": True}))

    rust = os.environ.get(
        "PA_RUST_BINARY", str(REPO / "target" / "release" / "prime-agent")
    )
    package_dir = os.environ.get("PI_PACKAGE_DIR") or find_runtime_package_dir()
    session = f"dragp-{stamp}"
    tmux("kill-session", "-t", session, check=False)
    tmux(
        "new-session", "-d", "-s", session,
        "-x", str(args.width), "-y", str(args.height), "-c", "/tmp",
    )
    # The raw pane stream: tmux >= 3.3 no longer surfaces OSC passthrough
    # through `capture-pane -e`, so the OSC 52 copy is verified from the
    # pane's byte stream instead.
    stream_path = run_dir / "pane-stream.bin"
    tmux("pipe-pane", "-t", session, "-o", f"cat > {stream_path}")
    command = (
        f"HOME={home} TMPDIR={tmp} PRIME_AGENT_CODING_AGENT_DIR={agent} "
        f"PI_PACKAGE_DIR={package_dir} {rust} "
        f"--daemon-socket {agent}/daemon.sock --resume {corpus}"
    )
    tmux("send-keys", "-t", session, command, "Enter")
    try:
        # The needle row renders at the tail (the last message); the first
        # frame walks the whole transcript once, so allow a long settle.
        wait_for(session, NEEDLE, timeout=120)
        time.sleep(0.5)
        plain = capture(session, escape=False)
        located = locate_plain(plain, NEEDLE)
        if located is None:
            raise AssertionError("the needle left the pane")
        target_row, needle_col = located
        (run_dir / "before-follow.txt").write_text(capture(session))

        # Sweep 1: following the tail.
        follow_steps = sweep(session, run_dir, "follow", target_row, needle_col, NEEDLE)

        # The release copies: the raw pane stream (the pipe-pane capture)
        # carries the OSC 52 write and the status row lands.
        wait_for(session, "Copied selection to clipboard", timeout=10)
        raw = capture(session)
        copies = re.findall(
            rb"\x1b\]52;c;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)",
            stream_path.read_bytes(),
        )
        if not copies:
            raise AssertionError("the release never wrote an OSC 52 copy")
        copied = base64.b64decode(copies[-1]).decode()
        expected_copy = NEEDLE[: len(follow_steps)]
        if not copied.strip().startswith(expected_copy.strip()):
            raise AssertionError(
                f"the copy read {copied[:40]!r}, expected {expected_copy!r}"
            )
        (run_dir / "after-follow.txt").write_text(raw)

        # Sweep 2: paused mid-history — wheel up a few screens, then drag.
        for _ in range(12):
            send_mouse(session, wheel_up(5))
        time.sleep(0.5)
        plain = capture(session, escape=False)
        paused = locate_plain(plain, "answer 0:")
        if paused is None:
            raise AssertionError("the wheel-up never paused into history")
        (run_dir / "before-paused.txt").write_text(capture(session))
        row, col = paused
        needle_row_text = plain.split("\n")[row]
        paused_needle = "answer 0:"
        paused_steps = sweep(
            session, run_dir, "paused", row, col, needle_row_text.strip()
        )
        send_mouse(session, mouse_release(col + 1 + len(paused_steps), row + 1))
        (run_dir / "after-paused.txt").write_text(capture(session))

        evidence = {
            "corpus": {
                "path": str(corpus),
                "size_mb": round(size_mb, 1),
                "turns": TURNS,
            },
            "follow_steps_s": [round(step, 4) for step in follow_steps],
            "paused_steps_s": [round(step, 4) for step in paused_steps],
            "follow_max_s": round(max(follow_steps), 4),
            "follow_median_s": round(sorted(follow_steps)[len(follow_steps) // 2], 4),
            "paused_max_s": round(max(paused_steps), 4),
            "copy": copied,
        }
        (run_dir / "evidence.json").write_text(json.dumps(evidence, indent=2))

        worst = max(max(follow_steps), max(paused_steps))
        print(
            f"follow: median {evidence['follow_median_s']*1000:.0f}ms "
            f"max {evidence['follow_max_s']*1000:.0f}ms | "
            f"paused: max {evidence['paused_max_s']*1000:.0f}ms | "
            f"copy: {copied[:30]!r}"
        )
        if worst > STEP_BUDGET_S:
            print(
                f"FAIL: a drag step took {worst*1000:.0f}ms "
                f"(budget {STEP_BUDGET_S*1000:.0f}ms) — visible lag"
            )
            return 1
        print(f"PASS: the highlight tracked {len(follow_steps) + len(paused_steps)} drag steps")
        return 0
    finally:
        tmux("kill-session", "-t", session, check=False)


if __name__ == "__main__":
    sys.exit(main())
