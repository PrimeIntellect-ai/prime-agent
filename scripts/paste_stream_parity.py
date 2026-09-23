#!/usr/bin/env python3
"""Paste-during-streaming verifier: a paste mid-turn must register in the
editor instantly (the input path never blocks on transcript processing).

Resumes the ~40MB drag corpus session (the perf family's heavy transcript),
starts a paced faux streaming turn on top of it, and pastes into the editor
while the stream renders — the flagship input-latency contract:

  * while the turn streams and the view follows the tail, a 12-line
    bracketed paste lands as the collapsed `[paste #N +12 lines]`
    indicator within one coalesced frame plus capture overhead — never
    waiting on a transcript-sized layout pass;
  * a marker-less keystroke burst (the tmux 3.2a `paste-buffer` shape)
    lands the same way mid-stream;
  * the same paste while the view is PAUSED mid-history (wheel up) — the
    adversarial case: every streaming delta appends while the window is
    pinned far above the tail, exactly the path that used to run a full
    geometry resolve per append — still registers instantly;
  * the turn keeps streaming through every paste window (the words
    advance past the marker the verifier saw before the pause), and the
    queued editor text submits whole after the turn: the session file
    carries every pasted line and the scripted ack.

The per-paste registration latencies are measured (evidence, not just
asserted) against the STEP_BUDGET_S budget — the same coalesced-frame
budget the drag verifier uses. The Rust side gates the budget; the TS
side runs the identical scenario for parity evidence (behavior must
match: registration, collapse indicator, follow hint, submission
integrity) with its latencies reported for reference.

tmux rules: default socket only (`env -u TMUX`), pastep-* session names,
no kill-server; the session is killed individually and the daemon reaped
at the end (leaked workers starve later suites).
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)
from drag_select_parity import NEEDLE, TURNS, corpus_path, find_runtime_package_dir

REPO = Path(__file__).resolve().parent.parent

CAPTURE_POLL_S = 0.005
STEP_TIMEOUT_S = 5.0
# One coalesced frame (16ms) plus tmux capture overhead, with CI headroom —
# the drag verifier's budget: above this the input lag is visible.
STEP_BUDGET_S = 0.35

# The paced streaming answer: 150 numbered words so the pane shows exactly
# how far the stream advanced at every measurement point. ~640 faux tokens
# at 30 tokens/second ≈ 20s of streaming — a wide mid-stream window for the
# three paste measurements.
STREAM_WORDS = 150
STREAM_TEXT = " ".join(f"streaming-word-{i:03d}" for i in range(STREAM_WORDS))
PASTE_ACK = "PASTE STREAM ACK 7f3d"
PROMPT = "begin the paced paste stream test"

# Paste payloads: the collapsed bracketed block (>10 lines -> the
# `[paste #N +12 lines]` indicator) and the marker-less 3-line burst
# (the tmux 3.2a shape: inline in the editor, unique words so the pane
# capture proves the exact bytes landed).
FOLLOW_PASTE = [f"follow paste line {i:02d} aabb" for i in range(12)]
BURST_PASTE = ["bursthorse-one first", "bursthorse-two second", "bursthorse-three third"]
PAUSED_PASTE = [f"paused paste line {i:02d} ccdd" for i in range(12)]

FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": "faux-1",
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 30,
    "responses": [
        {"content": [{"type": "text", "text": STREAM_TEXT}]},
        {"content": [{"type": "text", "text": PASTE_ACK}]},
    ],
}

# The TS extension registers the same paced faux provider from
# PRIME_AGENT_FAUX_SCRIPT (shared harness contract).
TS_FAUX_EXTENSION = open(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "ts_faux_extension.js"),
    encoding="utf-8",
).read()

# The working loader row (spinner + activity + elapsed + the token counter)
# is the in-pane proof a turn is still streaming; both products render it.
STREAMING_RE = re.compile(r"(Waiting|tokens)")


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


def sgr_hex(sequence):
    return [f"{byte:02x}" for byte in sequence.encode()]


def send_bytes(session, sequence):
    tmux("send-keys", "-t", session, "-H", *sgr_hex(sequence))


def wheel_up(row):
    return f"\x1b[<64;1;{row}M"


def wait_for(session, needle, timeout, poll=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        pane = capture(session, escape=False)
        if needle in pane:
            return pane
        time.sleep(poll)
    raise TimeoutError(f"session {session} never showed {needle!r}")


def wait_gone(session, pattern, timeout, poll=0.1):
    deadline = time.time() + timeout
    while time.time() < deadline:
        pane = capture(session, escape=False)
        if not re.search(pattern, pane):
            return pane
        time.sleep(poll)
    raise TimeoutError(f"session {session} never dropped /{pattern}/")


def bracketed_paste(lines):
    return "\x1b[200~" + "\r\n".join(lines) + "\x1b[201~"


def measure_registration(session, payload, needle, label, out_dir):
    """Send the paste bytes and poll the pane until the paste's visible
    marker appears; return the registration latency."""
    send_bytes(session, payload)
    started = time.monotonic()
    raw = None
    # The diff renderer may write the row in styled segments, so the pane
    # capture is matched by the marker's words, not one contiguous string.
    parts = needle.split()
    while time.monotonic() - started < STEP_TIMEOUT_S:
        raw = capture(session)
        if all(part in raw for part in parts):
            return time.monotonic() - started
        time.sleep(CAPTURE_POLL_S)
    (out_dir / f"{label}-stuck.raw").write_text(raw or "")
    raise AssertionError(
        f"{label}: the editor never registered the paste (no {needle!r})"
    )


def side_command(binary, sandbox, script_path, corpus):
    """The pane command line for one side (mirrors visual_parity.py)."""
    env = (
        f"HOME={sandbox['home']} TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
        f"PRIME_AGENT_FAUX_SCRIPT={script_path} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    if binary == "ts":
        command = (
            f"prime-agent --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model faux-1 --resume {corpus}"
        )
    else:
        rust = os.environ.get(
            "PA_RUST_BINARY", str(REPO / "target" / "release" / "prime-agent")
        )
        package_dir = os.environ.get("PI_PACKAGE_DIR") or find_runtime_package_dir()
        command = (
            f"PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model faux-1 --resume {corpus}"
        )
    return f"{env} {command}"


def read_tail(path, tail_bytes=2 * 1024 * 1024):
    with open(path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - tail_bytes))
        return handle.read().decode("utf-8", errors="replace")


def run_side(binary, corpus, script_path, out_dir, width, height):
    """One binary through the full scenario; returns the evidence dict."""
    sandbox_root = out_dir / binary
    sandbox = {
        "home": sandbox_root / "home",
        "agent": sandbox_root / "agent",
        "tmp": sandbox_root / "tmp",
    }
    for path in (sandbox["home"], sandbox["agent"], sandbox["tmp"]):
        path.mkdir(parents=True, exist_ok=True)
    (sandbox["agent"] / "settings.json").write_text(
        json.dumps({"onboardingCompleted": True})
    )
    if binary == "ts":
        # The TS daemon loads the faux-provider driver extension from the
        # agent dir (visual_parity.py's shared extension source).
        ext_dir = sandbox["agent"] / "extensions"
        ext_dir.mkdir(exist_ok=True)
        (ext_dir / "paste-stream-faux.js").write_text(TS_FAUX_EXTENSION)

    session = f"pastep-{binary}"
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height), "-c", "/tmp")
    tmux(
        "send-keys", "-t", session,
        side_command(binary, sandbox, script_path, corpus), "Enter",
    )
    failures = []
    try:
        # The resumed 40MB transcript: the first frame walks it once.
        wait_for(session, NEEDLE, timeout=180)
        time.sleep(0.5)
        (out_dir / f"{binary}-resumed.txt").write_text(capture(session))

        # Start the paced streaming turn.
        tmux("send-keys", "-t", session, PROMPT, "Enter")
        wait_for(session, f"streaming-word-{30:03d}", timeout=40)

        # Paste 1: mid-stream, following the tail — the collapsed indicator.
        follow_ms = measure_registration(
            session,
            bracketed_paste(FOLLOW_PASTE),
            "[paste #1 +12 lines]",
            f"{binary}-follow-paste",
            out_dir,
        )

        # Paste 2: the marker-less burst, later in the same stream.
        wait_for(session, f"streaming-word-{60:03d}", timeout=40)
        burst_ms = measure_registration(
            session,
            "\r\n".join(BURST_PASTE),
            "bursthorse-three third",
            f"{binary}-burst-paste",
            out_dir,
        )

        # Paste 3: paused mid-history while the stream appends — the
        # adversarial case (per-delta appends far above the window).
        wait_for(session, f"streaming-word-{90:03d}", timeout=40)
        for _ in range(12):
            send_bytes(session, wheel_up(5))
        time.sleep(0.6)
        if "to follow" not in capture(session, escape=False):
            failures.append("the wheel-up never paused into history")
        paused_ms = measure_registration(
            session,
            bracketed_paste(PAUSED_PASTE),
            "[paste #2 +12 lines]",
            f"{binary}-paused-paste",
            out_dir,
        )

        # Back to the tail: the stream must have kept advancing through the
        # paused paste window (the words past the pre-pause marker prove
        # the turn was live while the paste registered).
        tmux("send-keys", "-t", session, "C-S-Down")
        wait_for(session, f"streaming-word-{STREAM_WORDS - 1:03d}", timeout=40)
        # The turn completes: the loader row drops.
        wait_gone(session, STREAMING_RE, timeout=40)
        (out_dir / f"{binary}-stream-done.txt").write_text(capture(session))

        # The queued editor text submits whole after the turn.
        tmux("send-keys", "-t", session, "Enter")
        wait_for(session, PASTE_ACK, timeout=40)
        (out_dir / f"{binary}-submitted.txt").write_text(capture(session))

        # Submission integrity from the session file (ground truth, both
        # products append JSONL): every pasted line verbatim.
        tail = read_tail(corpus)
        for line in FOLLOW_PASTE + BURST_PASTE + PAUSED_PASTE:
            if line not in tail:
                failures.append(f"the submitted message lost {line!r}")
        if PASTE_ACK not in tail:
            failures.append("the scripted ack never reached the session file")

        return {
            "binary": binary,
            "follow_paste_ms": round(follow_ms * 1000, 1),
            "burst_paste_ms": round(burst_ms * 1000, 1),
            "paused_paste_ms": round(paused_ms * 1000, 1),
            "failures": failures,
        }
    finally:
        tmux("kill-session", "-t", session, check=False)
        batterylib.reap_daemons(
            socket_paths=[Path(sandbox["agent"]) / "daemon.sock"],
            cwd_roots=[Path(sandbox["agent"])],
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=120)
    parser.add_argument("--height", type=int, default=36)
    parser.add_argument(
        "--binary", choices=["rust", "ts", "both"], default="both",
        help="which side to drive (the rust side gates the latency budget)",
    )
    args = parser.parse_args()

    ts_identity.assert_ts_side_is_the_ts_product()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = Path(__file__).resolve().parent / "paste-stream-runs" / stamp
    out_dir.mkdir(parents=True)
    # Reuse the drag family's 40MB corpus (shared cache location).
    corpus_root = Path(__file__).resolve().parent / "drag-select-runs"
    corpus_root.mkdir(exist_ok=True)
    corpus = corpus_path(corpus_root)
    script_path = out_dir / "faux-script.json"
    script_path.write_text(json.dumps(FAUX_SCRIPT))
    print(f"corpus: {corpus} ({corpus.stat().st_size / 1024 / 1024:.0f}MB)")

    sides = ["rust", "ts"] if args.binary == "both" else [args.binary]
    evidence = {
        "corpus": {"turns": TURNS, "size_mb": round(corpus.stat().st_size / 1024 / 1024, 1)}
    }
    failed = False
    for side in sides:
        result = run_side(side, corpus, script_path, out_dir, args.width, args.height)
        evidence[side] = result
        print(
            f"{side}: follow {result['follow_paste_ms']}ms burst "
            f"{result['burst_paste_ms']}ms paused {result['paused_paste_ms']}ms"
            + (f" failures={result['failures']}" if result["failures"] else "")
        )
        if result["failures"]:
            failed = True
        if side == "rust":
            worst = max(
                result["follow_paste_ms"], result["burst_paste_ms"], result["paused_paste_ms"]
            )
            if worst > STEP_BUDGET_S * 1000:
                print(
                    f"FAIL ({side}): a paste registration took {worst}ms "
                    f"(budget {STEP_BUDGET_S * 1000:.0f}ms) — the input path "
                    "blocked on transcript processing"
                )
                failed = True
            else:
                print(
                    f"PASS ({side}): every paste registered within "
                    f"{worst}ms (budget {STEP_BUDGET_S * 1000:.0f}ms) mid-stream"
                )
    (out_dir / "evidence.json").write_text(json.dumps(evidence, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
