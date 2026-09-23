#!/usr/bin/env python3
"""Abort-visual parity (TS binary vs Rust build): the interrupted turn's
transcript render, in tmux, compared frame-for-frame.

The TS interrupt (`interruptOrClearInput` -> `abortAndSendQueued`, schema
29) renders no transient hint: the aborted run's own assistant component
carries the interrupt - the red "Operation aborted" row (TS
`AssistantMessageComponent.rebuild`'s aborted arm). This probe drives both
binaries through the states that define the abort UX:

- b_aborted_row: a thinking-only turn (hidden in the collapsed detail
  mode) streams slowly; Escape aborts it. The transcript shows the user
  row and the red "Operation aborted" row - no Rust-only "aborting the
  current turn" hint, no TS transient note - so the whole frame compares
  byte-exact after visual_parity's normalization.
- c_parked_strip / c_steering_delivered: a second slow turn parks one
  steering prompt at the boundary (the queue strip shows it); Escape
  aborts the run AND delivers the parked steering (TS
  `abortAndSendQueued`; the Rust `abort_and_send_queued` command). The
  strip vanishes and the steering turn's reply renders - with no
  resume-key press, the delivery IS the interrupt's own work.

Exit code is non-zero when any state's frame differs. Reuses the
visual_parity faux-provider harness (tmux rules: default socket,
vplane-* session names, sessions killed individually).
"""

import argparse
import difflib
import glob
import json
import os
import re
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import visual_parity as vp

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)


def default_ts_binary():
    """The ts side's launch command (the rules queue_edit_parity.py
    established): the box PATH `prime-agent` may itself be the Rust
    dogfood install, and the deployed 0.9.5 release predates schema 29
    (abortAndSendQueued, TS PR #2426, never reached it), so the harness
    compares against the TS-main bundle from the parity checkout.
    PA_TS_BINARY overrides (an absolute path or a full command string)."""
    override = os.environ.get("PA_TS_BINARY")
    if override:
        return override
    ts_main_cli = os.path.join(
        "/home/ubuntu/prime-agent", "packages", "coding-agent", "dist", "bundle", "cli.js"
    )
    if os.path.exists(ts_main_cli):
        return f"node {ts_main_cli}"
    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    candidates = sorted(
        glob.glob(os.path.join(releases, "0.9.5-linux-x64-*", "prime-agent"))
    )
    if not candidates:
        raise SystemExit(
            "neither the TS-main checkout nor a deployed TS release found; set PA_TS_BINARY"
        )
    return candidates[-1]

# Turns 1/2 are thinking-only and stream slowly (4 tokens/s over a long
# block): the collapsed detail mode hides the thinking, so the pane shows
# only the working loader while the turn streams - an abort there renders
# the aborted row with no partial text on screen, making the post-abort
# frame deterministic cross-side. The steering turn answers quickly.
ABORT_FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": vp.TS_SCRIPT_MODEL,
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 4,
    "responses": [
        {
            "content": [
                {
                    "type": "thinking",
                    "thinking": (
                        "The user asked for a long careful analysis of the streaming path and the abort surface. "
                        "I will think through each layer slowly so the turn stays busy long enough for the "
                        "interrupt to land mid-stream: the provider stream, the message components, the queue "
                        "lanes, and the aborted row that the assistant message renders when the run cancels. "
                        "This thinking block is long on purpose so the faux provider keeps streaming it for "
                        "a good while before any visible text would appear."
                    ),
                },
                {"type": "text", "text": "the final answer never streams"},
            ]
        },
        {
            "content": [
                {
                    "type": "thinking",
                    "thinking": (
                        "A second long thinking pass for the parked-steering abort: the interrupt must land "
                        "mid-stream here too, so the abort both cancels this run and delivers the steering "
                        "message waiting at the turn boundary, exactly like the TS abortAndSendQueued batch. "
                        "The steering turn then answers with its own quick reply so the settled frame is "
                        "deterministic cross-side."
                    ),
                },
                {"type": "text", "text": "the second final answer never streams"},
            ]
        },
        {"content": [{"type": "text", "text": "steering delivered after the abort"}]},
    ],
}

ABORT_ROW = "Operation aborted"
HELD_PROMPT = "hold this turn while i interrupt"
HELD_PROMPT_2 = "hold a second turn while i interrupt again"
STEERING_PROMPT = "steering message parked for the abort"
STEERING_DELIVERED = "steering delivered after the abort"

ANSI_PATTERN = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def strip_ansi(text):
    return ANSI_PATTERN.sub("", text)


def prepare_abort_sandbox(base):
    """The visual_parity fixture with the abort-specific faux script."""
    shared_cwd, script_path, sandboxes = vp.prepare_sandbox(base)
    script_path = os.path.join(base, "abort-faux-script.json")
    with open(script_path, "w") as f:
        json.dump(ABORT_FAUX_SCRIPT, f, indent=2)
    return shared_cwd, script_path, sandboxes


def wait_plain(session, needle, timeout=30, gone=False):
    """Poll the pane's ANSI-stripped text until `needle` appears (or is gone)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        plain = strip_ansi(vp.capture(session, escape=False))
        if (needle not in plain) == gone:
            return
        time.sleep(0.3)
    raise RuntimeError(
        f"timed out waiting for {needle!r} to {'vanish' if gone else 'appear'}"
    )


def capture_settled(session, timeout=20):
    """Capture once the pane stops changing: the TS live transcript can
    transiently double a submitted user row (the local submit echo beside
    the daemon's message_start row) until the post-turn rebuild flushes it
    to the store's single row - a pane captured inside that window carries
    a frame the settled transcript never shows."""
    previous = None
    deadline = time.time() + timeout
    while time.time() < deadline:
        frame = vp.capture(session)
        if previous is not None and frame == previous:
            return frame
        previous = frame
        time.sleep(0.5)
    return previous or vp.capture(session)


def run_abort_session(binary, sandbox, shared_cwd, script_path, size, out_dir, prefix):
    """Drive one binary through the abort states, capturing each frame."""
    width, height = (str(size[0]), str(size[1]))
    session = f"vplane-{prefix}-abort-{binary}-{size[0]}x{size[1]}"
    vp.tmux("kill-session", "-t", session, check=False)
    vp.tmux("new-session", "-d", "-s", session, "-x", width, "-y", height, "-c", shared_cwd)
    env = (
        f"HOME={sandbox['home']} "
        f"TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
        f"PRIME_AGENT_FAUX_SCRIPT={script_path} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    if binary == "ts":
        command = (
            f"{default_ts_binary()} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model {vp.TS_SCRIPT_MODEL}"
        )
    else:
        rust = os.environ.get(
            "PA_RUST_BINARY",
            os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "prime-agent"
            ),
        )
        package_dir = os.environ.get("PI_PACKAGE_DIR") or vp.find_runtime_package_dir()
        command = (
            f"PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model {vp.TS_SCRIPT_MODEL}"
        )
    vp.tmux("send-keys", "-t", session, f"{env} {command}", "Enter")

    frames = {}
    # (a) fresh start: the detail hint row is the ready signal; the fresh
    # kernel boot plus the daemon's first-attach reconnect can take a
    # while on a cold HOME.
    wait_plain(session, "mode (Ctrl+O", timeout=150)
    # Normalize the conversation detail: TS boots with thinking visible
    # ("Details mode"), the Rust port boots collapsed (a pre-existing
    # fresh-boot default gap this harness reports, not fixes) - toggle the
    # collapsed side into Details so both products render the same
    # thinking rows in the abort states below.
    if "Collapsed mode" in strip_ansi(vp.capture(session, escape=False)):
        vp.tmux("send-keys", "-t", session, "C-o")
        wait_plain(session, "Details mode", timeout=10)
    # (b) the aborted row: submit the thinking-only turn, wait until the
    # working loader is up mid-stream (the thinking phase), then abort.
    vp.tmux("send-keys", "-t", session, HELD_PROMPT)
    vp.tmux("send-keys", "-t", session, "Enter")
    wait_plain(session, "Thinking", timeout=90)
    time.sleep(1.0)
    vp.tmux("send-keys", "-t", session, "Escape")
    # The aborted run settles on the red row - and no transient hint.
    wait_plain(session, ABORT_ROW, timeout=30)
    time.sleep(1.0)
    # Flip through the shared detail cycle into the thinking-hidden state
    # (details -> expanded -> collapsed, the same presses on both sides):
    # the aborted turn's thinking row carries however much of the block
    # streamed before the interrupt landed - a timing race between the
    # products' stream pacing that no settled frame can compare, while the
    # state's claim (the abort row, the hint row) is mode-independent.
    vp.tmux("send-keys", "-t", session, "C-o")
    vp.tmux("send-keys", "-t", session, "C-o")
    wait_plain(session, "Collapsed mode", timeout=10)
    frames["b_aborted_row"] = capture_settled(session)
    plain = strip_ansi(frames["b_aborted_row"])
    assert "aborting the current turn" not in plain, "the Rust-only abort hint rendered"
    # (c) the abort-and-send: a second thinking-only turn parks one steering
    # prompt at the boundary, and the interrupt aborts the run AND delivers
    # it. The queue strip shows the parked message before the abort.
    vp.tmux("send-keys", "-t", session, HELD_PROMPT_2)
    vp.tmux("send-keys", "-t", session, "Enter")
    wait_plain(session, "Thinking", timeout=90)
    vp.tmux("send-keys", "-t", session, STEERING_PROMPT)
    vp.tmux("send-keys", "-t", session, "Enter")
    wait_plain(session, "Steering:", timeout=30)
    # Let the streaming loader settle past its first frames: the label
    # flips from "Waiting" to "Thinking" on the first thinking delta and
    # the token counter renders with it, so a capture inside that window
    # races the label on either product.
    wait_plain(session, "Thinking", timeout=30)
    time.sleep(1.0)
    frames["c_parked_strip"] = vp.capture(session)
    vp.tmux("send-keys", "-t", session, "Escape")
    # The abort delivered the parked steering: the strip row vanishes and
    # the steering turn's reply renders. No resume-key press happens: the
    # delivery IS the interrupt's own work (abortAndSendQueued).
    wait_plain(session, "Steering:", gone=True, timeout=60)
    wait_plain(session, STEERING_DELIVERED, timeout=90)
    # Both products already sit in the thinking-hidden state (the b
    # capture's detail flip persists), so the settled frame is directly
    # comparable: the aborted turn's rows, the delivered steering turn,
    # and the detail hint.
    frames["c_steering_delivered"] = capture_settled(session)
    vp.tmux("kill-session", "-t", session, check=False)
    return frames


def compare_frame(state, ts_frame, rust_frame, root):
    """Byte-diff one state's frames (visual_parity normalization)."""
    ts = vp.normalize(ts_frame, root)
    rust = vp.normalize(rust_frame, root)
    if ts == rust:
        print(f"PASS {state}: frames match")
        return None
    print(f"FAIL {state}")
    sys.stdout.writelines(
        difflib.unified_diff(
            ts.splitlines(keepends=True), rust.splitlines(keepends=True),
            fromfile=f"ts-{state}", tofile=f"rust-{state}",
        )
    )
    return state


def parked_strip_band(frame):
    """The parked-strip state's claim: the streaming loader label and the
    queue strip rows (visual_parity normalization on the band). The full
    frame is NOT compared for this state - it carries the pre-existing
    queued-strip mount gap (the Rust strip docks above the editor; TS
    renders it directly under the working loader), which this lane
    reports but does not own."""
    plain = strip_ansi(frame)
    band = "\n".join(
        line
        for line in plain.splitlines()
        if "Thinking" in line or "Steering:" in line or "Alt+" in line
    )
    return band


def compare_parked_strip_band(ts_frame, rust_frame, root):
    """Compare the parked-strip band cross-side (normalized)."""
    ts = vp.normalize(parked_strip_band(ts_frame), root)
    rust = vp.normalize(parked_strip_band(rust_frame), root)
    if ts == rust:
        print("PASS c_parked_strip: strip + streaming-label band matches")
        return None
    print("FAIL c_parked_strip band")
    print(f"ts:   {ts!r}")
    print(f"rust: {rust!r}")
    return "c_parked_strip"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--out", default=None)
    parser.add_argument("--only", default=None, choices=("ts", "rust"))
    parser.add_argument("--session-prefix", default="vp")
    args = parser.parse_args()

    # Fail fast before any launch: a non-TS `prime-agent` on PATH plays a
    # Rust build as the "ts" side and reports false divergences.
    if args.only in (None, "ts"):
        # The TS-main bundle prints its version line to stderr: redirect
        # it into the guard's stdout probe (the queue_edit_parity rule).
        ts_identity.assert_ts_side_is_the_ts_product(f"{default_ts_binary()} 2>&1")

    base = tempfile.mkdtemp(prefix="abort-parity-sandbox-")
    out_dir = args.out or tempfile.mkdtemp(prefix="abort-parity-captures-")
    os.makedirs(out_dir, exist_ok=True)
    shared_cwd, script_path, sandboxes = prepare_abort_sandbox(base)
    try:
        if args.only:
            frames = run_abort_session(
                args.only, sandboxes[args.only], shared_cwd, script_path,
                (120, 36), out_dir, args.session_prefix,
            )
            for state, frame in frames.items():
                with open(os.path.join(out_dir, f"{args.only}-{state}.ansi"), "w") as f:
                    f.write(frame)
            print(f"captures for {args.only} in {out_dir}")
            return 0
        frames = {}
        for binary in ("ts", "rust"):
            frames[binary] = run_abort_session(
                binary, sandboxes[binary], shared_cwd, script_path,
                (120, 36), out_dir, args.session_prefix,
            )
            for state, frame in frames[binary].items():
                with open(os.path.join(out_dir, f"{binary}-{state}.ansi"), "w") as f:
                    f.write(frame)
        # Scenario guards: the compared frames must actually show the
        # abort surface (an early capture would diff equal empty panes).
        for binary in ("ts", "rust"):
            assert ABORT_ROW in strip_ansi(frames[binary]["b_aborted_row"]), (
                f"{binary} never rendered the aborted row"
            )
            assert STEERING_DELIVERED in strip_ansi(frames[binary]["c_steering_delivered"]), (
                f"{binary} never rendered the delivered steering reply"
            )
            assert "Thinking" in strip_ansi(frames[binary]["c_parked_strip"]), (
                f"{binary} never rendered the streaming label mid-thinking"
            )
        failures = []
        for state in ("b_aborted_row", "c_steering_delivered"):
            failures.append(
                compare_frame(state, frames["ts"][state], frames["rust"][state], shared_cwd)
            )
        # The parked-strip state compares band-wise (its full-frame diff is
        # the pre-existing strip-mount gap, documented above).
        failures.append(
            compare_parked_strip_band(
                frames["ts"]["c_parked_strip"], frames["rust"]["c_parked_strip"], shared_cwd
            )
        )
        failed = [f for f in failures if f]
        if failed:
            print(f"{len(failed)} state(s) differ; captures in {out_dir}")
            return 1
        print(f"all abort states match; captures in {out_dir}")
        return 0
    finally:
        # Rmtree alone leaks the scenario daemons (a killed TUI pane does
        # not take its detached daemon/supervisor pair down; #223): sweep
        # every daemon this run spawned before deleting the sandbox.
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
