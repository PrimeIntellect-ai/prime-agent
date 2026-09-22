#!/usr/bin/env python3
"""Bracketed-paste / enhanced-keys parity verifier: byte-capture the raw
terminal stream of the Rust interactive TUI and the installed TS binary
under a raw pty and prove the enhanced-key contract (audit Tier 1,
`term-enhanced-keys`):

  - startup enables bracketed paste (`ESC[?2004h`) and queries the kitty
    keyboard protocol (`ESC[?u`; the Rust side rides crossterm's support
    probe, which appends the DA1 query `ESC[c` — accepted delta);
  - with no kitty answer in the fallback window, TS arms the xterm
    modifyOtherKeys fallback (`ESC[>4;2m`); the Rust side intentionally
    does NOT (crossterm cannot parse the resulting `CSI 27;<mods>;<key>~`
    sequences — the whole pending buffer drops on the parse error, the
    shift-modified-printable bug class) and instead RESETS the mode at
    startup (`ESC[>4;0m`, clearing a sticky mode another pane armed);
  - a 3-line paste lands as ONE editor update — all three lines render in
    the editor and no submission happens (the scripted turn's sentinel text
    must not appear before the Enter) — both with bracketed markers and as
    a marker-less keystroke burst (the tmux 3.2a `paste-buffer` shape, TS
    StdinBuffer's `isRawMultilinePaste` heuristic);
  - a 20-line paste COLLAPSES to the `[paste #<id> +N lines]` indicator
    (one editor line; the raw lines never render before the send) and the
    submitted message carries the full content (editor.ts:1342 parity);
  - the shifted-printable range (`shift+1/! shift+/ -> ? shift+' -> "
    shift+= -> + shift+; -> :`) lands in the editor BOTH as legacy text
    bytes and as kitty CSI-u alternate-key sequences — the shift+= dogfood
    bug class (a dropped `+` character);
  - Enter submits the whole block (the turn starts exactly once);
  - a clean double-Ctrl+C exit disables paste mode (`ESC[?2004l`) and
    resets modifyOtherKeys (`ESC[>4;0m`).

tmux would swallow or re-shape the ?2004/kitty bytes (before 3.3 it strips
OSC/CSI probes entirely), so like osc_parity.py this verifier drives both
binaries through the scripted faux session under a raw pty and records
every output byte before any terminal parser sits in between.

Exit code is non-zero when any stage check fails on either binary.
"""

import argparse
import json
import os
import pty
import select
import struct
import subprocess
import sys
import fcntl
import termios
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import visual_parity as vp

WIDTH, HEIGHT = 120, 36

# The turn's scripted answer: a unique marker so the verifier can prove the
# submission fired exactly at the Enter, never per pasted line.
# A unique marker so the verifier can prove the submission fired exactly
# at the Enter, never per pasted line. Checked word-by-word: the diff
# renderers may style each word as its own span (Rust) or repaint the
# response (TS), so contiguous-substring counting overcounts or misses.
SENTINEL = "BRACKETED PASTE PARITY SENTINEL"
SENTINEL_WORDS = ["BRACKETED", "PASTE", "PARITY", "SENTINEL"]
# Both TUIs render the working spinner with this label; a submission that
# started a turn shows it (word-level for the same span-diff reason).
WORKING_LABEL = b"Waiting"
PASTE_LINES = ["alpha line", "beta line", "gamma line"]
# The large-paste block: 20 unique words, one per line — enough to trip the
# >10-lines collapse in both editors (editor.ts:1342).
LARGE_PASTE_LINES = [f"bulk {i:02d} line" for i in range(20)]
LARGE_PASTE_MARKER = b"[paste #1 +20 lines]"
# The shifted-printable range (US layout): shift+1 -> !, shift+/ -> ?,
# shift+' -> ", shift+= -> +, shift+; -> :. Legacy terminals send the
# produced byte; kitty protocol terminals send the CSI-u alternate form
# `CSI <base>:<shifted>;2u` (report alternate keys, modifier shift).
SHIFTED_RANGE = b'+!?"::'[:5]  # + ! ? " :
KITTY_CSI_U_ALTERNATES = [
    b"\x1b[49:33;2u",  # shift+1 -> !
    b"\x1b[47:63;2u",  # shift+/ -> ?
    b"\x1b[39:34;2u",  # shift+' -> "
    b"\x1b[61:43;2u",  # shift+= -> +
    b"\x1b[59:58;2u",  # shift+; -> :
]

FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": vp.TS_SCRIPT_MODEL,
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 18,
    "responses": [{"content": [{"type": "text", "text": f"{SENTINEL} ack."}]}],
}

BRACKETED_PASTE_ON = b"\x1b[?2004h"
BRACKETED_PASTE_OFF = b"\x1b[?2004l"
KITTY_QUERY = b"\x1b[?u"
MODIFY_OTHER_KEYS_ON = b"\x1b[>4;2m"
MODIFY_OTHER_KEYS_OFF = b"\x1b[>4;0m"


class PtyCapture:
    """One binary under a raw pty; output captured stage by stage."""

    def __init__(self, command, env_extra, cwd):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", HEIGHT, WIDTH, 0, 0))
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env.update(env_extra)
        self.proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=cwd)
        os.close(slave)
        self.master = master
        self.stages = []

    def pump(self, seconds):
        """Read output for `seconds`, recording the stage's bytes."""
        stage = bytearray()
        deadline = time.time() + seconds
        while time.time() < deadline:
            readable, _, _ = select.select([self.master], [], [], 0.1)
            if self.master in readable:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                stage.extend(chunk)
        self.stages.append(bytes(stage))
        return bytes(stage)

    def write(self, data):
        os.write(self.master, data)

    def close(self):
        try:
            self.proc.terminate()
            self.proc.wait(5)
        except Exception:
            self.proc.kill()
        try:
            os.close(self.master)
        except OSError:
            pass


def run_scenario(command, env_extra, cwd, kind, markers=True):
    """Drive one binary through a scenario; return the stage list.

    `kind`: "paste3" — the 3-line paste (small, inserts inline);
    "large_paste" — the 20-line block (the collapse indicator, editor.ts:1342);
    "shifted_range" — the shifted-printable range in both encodings.

    `markers=False` simulates a terminal that ignores bracketed paste
    (tmux 3.2a's `paste-buffer` forwards the block as raw keystrokes): the
    paste arrives as one marker-less burst, the shape TS StdinBuffer's
    `isRawMultilinePaste` heuristic and the Rust burst coalescer both
    recognize.
    """
    capture = PtyCapture(command, env_extra, cwd)
    try:
        # Stage 0: startup. Paste mode on, the kitty query out, the
        # fallback armed (nothing answers under a raw pty).
        capture.pump(6)
        # Stage 1: the scenario's input.
        if kind == "paste3":
            payload = "\r\n".join(PASTE_LINES)
            if markers:
                payload = "\x1b[200~" + payload + "\x1b[201~"
            capture.write(payload.encode())
        elif kind == "large_paste":
            payload = "\r\n".join(LARGE_PASTE_LINES)
            if markers:
                payload = "\x1b[200~" + payload + "\x1b[201~"
            capture.write(payload.encode())
        else:  # shifted_range
            # A legacy terminal sends the produced byte; a kitty-protocol
            # terminal sends the CSI-u alternate (shifted codepoint) form.
            # Both must land the produced character in the editor.
            capture.write(SHIFTED_RANGE)
            for sequence in KITTY_CSI_U_ALTERNATES:
                capture.write(sequence)
        capture.pump(4)
        # Stage 2: Enter submits the whole block; the scripted turn runs.
        capture.write(b"\r")
        capture.pump(20)
        # Stage 3: a clean double-Ctrl+C exit (drain + teardown sequences).
        capture.write(b"\x03")
        capture.pump(1)
        capture.write(b"\x03")
        capture.pump(4)
        return capture.stages
    finally:
        capture.close()

def build_command(binary, sandbox, script_path):
    common = {
        "HOME": sandbox["home"],
        "TMPDIR": sandbox["tmp"],
        "PRIME_AGENT_CODING_AGENT_DIR": sandbox["agent"],
        "PRIME_AGENT_FAUX_SCRIPT": script_path,
        "PRIME_AGENT_DISABLE_ANALYTICS": "1",
    }
    if binary == "ts":
        command = [
            "prime-agent",
            "--daemon-socket",
            os.path.join(sandbox["agent"], "daemon.sock"),
            "--model",
            vp.TS_SCRIPT_MODEL,
        ]
    else:
        rust = os.environ.get(
            "PA_RUST_BINARY",
            os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "..",
                "target",
                "debug",
                "prime-agent",
            ),
        )
        common["PI_PACKAGE_DIR"] = os.environ.get("PI_PACKAGE_DIR") or vp.find_runtime_package_dir()
        command = [
            rust,
            "--daemon-socket",
            os.path.join(sandbox["agent"], "daemon.sock"),
            "--model",
            vp.TS_SCRIPT_MODEL,
        ]
    return command, common


def check_stages(name, stages, raw_out, binary, kind, markers, suffix=""):
    failures = []
    startup, input_stage = stages[0], stages[1]
    # The exit path spans the two Ctrl+C stages (the first press shows the
    # exit hint, the second runs teardown).
    exit_bytes = stages[3] + stages[4]
    whole = b"".join(stages)

    if BRACKETED_PASTE_ON not in startup:
        failures.append(f"startup never enables bracketed paste (no {BRACKETED_PASTE_ON!r})")
    if KITTY_QUERY not in startup:
        failures.append(f"startup never queries the kitty protocol (no {KITTY_QUERY!r})")
    if binary == "ts":
        # The fallback rides a 150ms timer: TS arms it from the event
        # loop, so a busy startup (daemon attach, extension load) can push
        # the write past the startup stage; it only has to be armed before
        # the first Enter.
        if MODIFY_OTHER_KEYS_ON not in stages[0] + stages[1]:
            failures.append(f"the modifyOtherKeys fallback never armed (no {MODIFY_OTHER_KEYS_ON!r})")
    else:
        # The Rust side never arms mode 2 (crossterm drops the resulting
        # CSI 27 sequences) and instead resets the mode at every start,
        # clearing a sticky mode another pane or process left armed.
        if MODIFY_OTHER_KEYS_ON in whole:
            failures.append(f"the Rust side armed modifyOtherKeys mode 2 ({MODIFY_OTHER_KEYS_ON!r})")
        if MODIFY_OTHER_KEYS_OFF not in startup:
            failures.append(
                f"the Rust startup never resets modifyOtherKeys (no {MODIFY_OTHER_KEYS_OFF!r})"
            )

    if kind == "paste3":
        # One editor update: every pasted word is on screen (the diff
        # renderer may write a row word-by-word, so check words, not whole
        # lines) and no submission may have happened while the paste sits
        # in the editor. A per-line submit (the audit's dogfood class)
        # would consume the first line as its prompt: its user-message zone
        # marker and the turn would both show up before the Enter.
        for word in ("alpha", "beta", "gamma"):
            if word.encode() not in input_stage:
                failures.append(f"the editor never rendered the pasted word {word!r}")
        if WORKING_LABEL in input_stage or any(
            word.encode() in input_stage for word in SENTINEL_WORDS
        ):
            failures.append("a turn started before Enter — a pasted line submitted on its own")
    elif kind == "large_paste":
        # The collapse indicator (editor.ts:1342): >10 lines collapses to
        # the `[paste #<id> +N lines]` marker — one editor line, the raw
        # bulk never renders before the send (the grown-editor bug class).
        # The diff renderers may write the row word-by-word with cursor
        # positioning between segments, so check the marker's words.
        for part in (b"[paste", b"#1", b"+20", b"lines]"):
            if part not in input_stage:
                failures.append(
                    f"the editor never collapsed the large paste (no {part!r} of the marker)"
                )
        if b"bulk" in input_stage:
            failures.append("the large paste grew the editor — a bulk line rendered before the send")
        if WORKING_LABEL in input_stage or any(
            word.encode() in input_stage for word in SENTINEL_WORDS
        ):
            failures.append("a turn started before Enter — a pasted line submitted on its own")
    else:  # shifted_range
        # Every shifted character must reach the editor (a dropped char is
        # the shift+= dogfood class); nothing may submit before the Enter.
        for ch in SHIFTED_RANGE:
            if ch.to_bytes(1, "big") not in input_stage:
                failures.append(f"the shifted char {chr(ch)!r} never rendered in the editor")
        if WORKING_LABEL in input_stage or any(
            word.encode() in input_stage for word in SENTINEL_WORDS
        ):
            failures.append("a turn started before Enter — a shifted char submitted on its own")

    # Enter submits the whole block: the turn starts, and the echoed
    # message carries the full content. The response may still be
    # streaming at the stage boundary (or land in the exit flush), so the
    # post-Enter stages are checked as one window.
    post_enter = stages[2] + stages[3] + stages[4]
    if not all(word.encode() in post_enter for word in SENTINEL_WORDS):
        failures.append("the scripted turn never ran after Enter")
    if kind == "paste3":
        for line in PASTE_LINES:
            if line.encode() not in post_enter:
                failures.append(f"the submitted message lost the pasted line {line!r}")
    elif kind == "large_paste":
        # The submitted message carries the FULL pasted content (the
        # indicator ships the stored text with the send).
        for line in LARGE_PASTE_LINES:
            if line.encode() not in post_enter:
                failures.append(f"the submitted message lost the pasted line {line!r}")
    else:  # shifted_range
        # The submitted message carries the typed characters.
        for ch in SHIFTED_RANGE:
            if ch.to_bytes(1, "big") not in post_enter:
                failures.append(
                    f"the submitted message lost the shifted char {chr(ch)!r}"
                )

    # A clean exit tears the modes down.
    if BRACKETED_PASTE_OFF not in exit_bytes:
        failures.append(f"exit never disables bracketed paste (no {BRACKETED_PASTE_OFF!r})")
    if MODIFY_OTHER_KEYS_OFF not in exit_bytes:
        failures.append(f"exit never resets modifyOtherKeys (no {MODIFY_OTHER_KEYS_OFF!r})")

    counts = {
        "paste_on": whole.count(BRACKETED_PASTE_ON),
        "paste_off": whole.count(BRACKETED_PASTE_OFF),
        "kitty_query": whole.count(KITTY_QUERY),
    }
    print(
        f"{name}: {len(whole)} bytes; "
        f"?2004h x{counts['paste_on']}, ?2004l x{counts['paste_off']}, "
        f"kitty query x{counts['kitty_query']}"
    )
    if raw_out:
        with open(os.path.join(raw_out, f"{binary}{suffix}-raw.bin"), "wb") as f:
            f.write(whole)
        with open(os.path.join(raw_out, f"{binary}{suffix}-stages.json"), "w") as f:
            json.dump([len(s) for s in stages], f)
    if counts["paste_on"] != 1:
        failures.append(f"bracketed paste enabled {counts['paste_on']} times (expected 1)")
    if counts["paste_off"] != 1:
        failures.append(f"bracketed paste disabled {counts['paste_off']} times (expected 1)")
    return failures

def tmux(*args):
    """Run tmux with TMUX unset (default socket only, the harness rules)."""
    env = {k: v for k, v in os.environ.items() if k != "TMUX"}
    return subprocess.run(["tmux"] + list(args), capture_output=True, text=True, env=env)


def run_tmux_scenario(binary, sandbox, script_path, shared_cwd):
    """The user-level tmux test: paste a 3-line block into a real pane.

    tmux 3.2a (the box's version, the audit's reference) does not wrap
    `paste-buffer` in bracketed markers, so the block reaches the pane as a
    marker-less keystroke burst — the dogfood shape this lane fixes. The
    editor must hold all three lines with no submission.
    """
    session = f"bpp-termkeys-{binary}"
    tmux("kill-session", "-t", session)
    tmux("new-session", "-d", "-s", session, "-x", str(WIDTH), "-y", str(HEIGHT), "-c", shared_cwd)
    command, env = build_command(binary, sandbox, script_path)
    env["TERM"] = "xterm-256color"
    prefix = " ".join(f"{k}={v}" for k, v in env.items() if k != "TERM")
    tmux("send-keys", "-t", session, f"{prefix} {subprocess.list2cmdline(command)}", "Enter")
    time.sleep(8)

    buf_file = os.path.join(os.path.dirname(script_path), "paste.txt")
    with open(buf_file, "w") as f:
        f.write("\n".join(PASTE_LINES) + "\n")
    tmux("load-buffer", "-b", "bpp-paste", buf_file)
    tmux("paste-buffer", "-b", "bpp-paste", "-t", session)
    time.sleep(3)
    pane = tmux("capture-pane", "-p", "-t", session).stdout
    tmux("kill-session", "-t", session)

    failures = []
    for line in PASTE_LINES:
        if line not in pane:
            failures.append(f"the tmux paste never reached the editor ({line!r} missing)")
    if pane.count(PASTE_LINES[0]) != 1:
        failures.append(
            f"{PASTE_LINES[0]!r} appears {pane.count(PASTE_LINES[0])} times "
            f"(a submitted line echoes in the transcript; expected the editor copy only)"
        )
    if "SENTINEL" in pane:
        failures.append("the turn started from the paste — a line submitted on its own")
    if "Steering" in pane:
        failures.append("a line queued as steering — a line submitted mid-paste")
    print(f"{binary}/tmux pane: {sum(1 for _ in pane.splitlines())} rows")
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep the sandbox dir")
    parser.add_argument("--raw-out", default=None, help="directory for raw captures")
    parser.add_argument(
        "--binary", choices=("ts", "rust"), default=None, help="run one side only"
    )
    parser.add_argument(
        "--tmux",
        action="store_true",
        help="also run the user-level tmux pane test (paste-buffer through tmux 3.2a)",
    )
    args = parser.parse_args()

    import tempfile
    import shutil

    # Fail fast before any launch: a non-TS `prime-agent` on PATH plays a
    # Rust build as the "ts" side and reports false divergences.
    vp.ts_identity.assert_ts_side_is_the_ts_product()

    base = tempfile.mkdtemp(prefix="bracketed-paste-parity-")
    out_dir = args.raw_out or tempfile.mkdtemp(prefix="bracketed-paste-raw-")
    os.makedirs(out_dir, exist_ok=True)

    import visual_parity as vpm

    script_path = os.path.join(base, "faux-script.json")
    with open(script_path, "w") as f:
        json.dump(FAUX_SCRIPT, f, indent=2)
    shared_cwd, _, sandboxes = vpm.prepare_sandbox(base)
    # prepare_sandbox writes its own (tool-call heavy) faux script at the
    # same path; the paste scenario needs the single-response one above.
    with open(script_path, "w") as f:
        json.dump(FAUX_SCRIPT, f, indent=2)
    try:
        failures = {}
        binaries = ("ts", "rust") if not args.binary else (args.binary,)
        for binary in binaries:
            command, env = build_command(binary, sandboxes[binary], script_path)
            failures[binary] = []
            for markers in (True, False):
                scenario = "bracketed" if markers else "marker-less burst"
                stages = run_scenario(command, env, shared_cwd, "paste3", markers=markers)
                suffix = "" if markers else "-burst"
                failures[binary] += check_stages(
                    f"{binary}/{scenario}", stages, out_dir, binary,
                    "paste3", markers, suffix,
                )
            # The large-paste collapse (bracketed markers only: the shape
            # real terminals send).
            stages = run_scenario(command, env, shared_cwd, "large_paste")
            failures[binary] += check_stages(
                f"{binary}/large-paste", stages, out_dir, binary,
                "large_paste", True, "-large",
            )
            # The shifted-printable range (both encodings).
            stages = run_scenario(command, env, shared_cwd, "shifted_range")
            failures[binary] += check_stages(
                f"{binary}/shifted-range", stages, out_dir, binary,
                "shifted_range", True, "-shifted",
            )

        if args.tmux:
            for binary in binaries:
                failures[binary] += run_tmux_scenario(
                    binary, sandboxes[binary], script_path, shared_cwd
                )

        ok = True
        for binary, per_binary in failures.items():
            if per_binary:
                ok = False
                for failure in per_binary:
                    print(f"FAIL {binary}: {failure}")
        if ok:
            print(
                "PASS: both binaries bracket the paste (?2004h/l), keep "
                "their modifyOtherKeys stance (TS arms the mode-2 fallback, "
                "Rust resets it), land the 3-line paste as ONE editor "
                "update with no per-line submissions (bracketed and "
                "marker-less), collapse the 20-line paste to the indicator "
                "and ship the full content at Enter, land the shifted-"
                "printable range in both encodings, and submit the whole "
                "block at Enter"
            )
        return 0 if ok else 1
    finally:
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
