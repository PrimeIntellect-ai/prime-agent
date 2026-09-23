#!/usr/bin/env python3
"""Mouse SGR escape-leak parity verifier: drive the Rust interactive TUI
and the installed TS binary through the same mouse-report byte streams
under a raw pty and prove the leak contract (the "random escape
sequences typed into the editor" defect, TS `packages/tui/src/stdin-buffer.ts`):

  - a real terminal emits SGR mouse reports as one write per report; the
    reader's OS-read boundary can land anywhere inside them. crossterm's
    parser commits a lone trailing `ESC` at every partial-read tail, and
    the sequence it opened then arrives as plain `Char` presses — during
    a drag that is the report body (`[<32;14;2M`) typed into the editor.
    TS never commits that early: `StdinBuffer` holds the `ESC` until the
    next chunk completes the sequence (within its 10 ms window) or proves
    it stood alone. The Rust side ports that discipline as the reader's
    `SequenceGuard` (crates/pa-tui/src/sequence_guard.rs);
  - the injection reproduces the boundary deterministically: the opening
    `ESC` is written alone, the continuation ~2 ms later (inside the hold
    window, across two OS reads). Every report of the drag corpus
    (press, drags, a three-way split, wheel, release) must reach the
    editor as NOTHING — no report body may render on either binary, and
    no turn may start on its own;
  - the reader must stay healthy after the drag: typing `hi` + Enter
    submits exactly `hi` (the submission is the leak detector — anything
    the drag had typed would ride along) and runs the scripted turn once;
  - a genuinely lone `ESC` (>hold later, nothing continues it) flushes as
    the Esc key press on both binaries, and typing `ok` + Enter right
    after still submits exactly `ok` (the flush path must not wedge or
    duplicate input);
  - startup wire parity: both binaries arm button-event SGR tracking
    (`ESC[?1002h` + `ESC[?1006h`) and disarm it on exit.

tmux cannot reproduce the OS-read boundary (it re-shapes the bytes), so
like bracketed_paste_parity.py this verifier drives both binaries through
the scripted faux session under a raw pty.

`--defect-demo BASE_BINARY` runs the drag scenario against a pre-fix Rust
build and prints the leak signals it still emits (expected: the report
bodies render as typed text) — the before/after half of the evidence;
exit code is 0 in demo mode.

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

# Unique per-scenario markers: the submission detector (word-level, the
# same span-diff reason as bracketed_paste_parity.py).
SENTINEL_DRAG = "MOUSE SGR PARITY SENTINEL"
SENTINEL_ESC = "LONE ESC PARITY SENTINEL"
SENTINEL_WORDS = ["SENTINEL"]
WORKING_LABEL = b"Waiting"

FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": vp.TS_SCRIPT_MODEL,
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 18,
    "responses": [{"content": [{"type": "text", "text": "{sentinel} ack."}]}],
}

# The wire modes both binaries must arm/disarm (mouse_tracking.rs:44/50 ==
# terminal.ts:580).
SGR_ON = b"\x1b[?1002h\x1b[?1006h"
SGR_OFF = b"\x1b[?1006l\x1b[?1002l"

# The drag corpus: what each report's body renders as when the reader
# leaks it (crossterm commits the `ESC`, the body arrives as Char presses).
# A leak renders the body text verbatim in the editor and in the echo of
# whatever the user submits next.
REPORT_BODIES = [
    b"[<0;13;2M",   # left press
    b"[<32;14;2M",  # left drag
    b"[<32;15;3M",  # left drag (three-way split)
    b"[<64;20;5M",  # wheel up (three-way split)
    b"[<0;15;3m",   # left release (injected whole, the control)
]

# The gap between the `ESC` write and its continuation: well inside the
# 10 ms hold (TS StdinBuffer.timeout == SequenceGuard::HOLD) so the
# sequence reassembles, but across two OS reads so the boundary the lane
# fixes actually happens.
SPLIT_GAP_S = 0.0012


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
        self.gaps = []

    def pump(self, seconds):
        """Read output for `seconds`, recording the stage's bytes."""
        stage = bytearray()
        deadline = time.time() + seconds
        while time.time() < deadline:
            readable, _, _ = select.select([self.master], [], [], 0.05)
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

    def wait_session_modes(self, timeout=40):
        """Startup stage: read until the session owns the terminal.

        The launcher cold start (bun, daemon attach) is slow and variable
        (run 2026-09-22: the TS side reached the alt screen well past a
        fixed 6 s window, so a fixed sleep raced the injection into the
        tty's echoed canonical buffer). The deterministic signal is the
        alt-screen enter plus the SGR-tracking arm: the injection (and
        every assertion about tracking modes) starts only once the binary
        has both up. The arm can trail the alt screen by seconds (the
        daemon attach sits between them on the Rust side), hence the
        two-marker wait.
        """
        stage = bytearray()
        deadline = time.time() + timeout
        while time.time() < deadline:
            if b"\x1b[?1049h" in stage and b"\x1b[?1002h" in stage:
                break
            readable, _, _ = select.select([self.master], [], [], 0.1)
            if self.master in readable:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                stage.extend(chunk)
        # A short settle in the same stage: the editor's first frame lands
        # before the injection. (Not self.pump — that would append its own
        # stage and shift every index-based assertion.)
        settle = time.time() + 0.5
        while time.time() < settle:
            readable, _, _ = select.select([self.master], [], [], 0.05)
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

    def write_split(self, chunks, gap=SPLIT_GAP_S):
        """One sequence whose bytes the OS delivers in separate reads.

        Each chunk is its own pty write; the gap keeps the reads apart
        while staying inside the hold window the guard (and TS's
        StdinBuffer) reassemble within. The gap is busy-waited to
        microsecond precision: a plain sleep stretches under load (run
        2026-09-22: a 2 ms sleep exceeded the 10 ms hold, both products
        then correctly flush the `ESC` and type the body — the
        late-continuation contract, not a divergence), which would turn
        the in-hold reassembly case into the flush case.
        """
        for index, chunk in enumerate(chunks):
            if index:
                start = time.perf_counter()
                target = start + gap
                time.sleep(gap * 0.5)
                while time.perf_counter() < target:
                    pass
                self.gaps.append(time.perf_counter() - start)
            self.write(chunk)

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


def run_drag_scenario(command, env_extra, cwd):
    """The committed-`ESC` read boundary during a drag (and a wheel tick).

    Stage 1 carries the whole corpus: press and first drag split in two,
    second drag and the wheel report split in three, the release whole
    (the control — crossterm parses complete reports fine). Stage 2 types
    `hi`, stage 3 submits it: the echo must carry exactly `hi`.
    """
    capture = PtyCapture(command, env_extra, cwd)
    try:
        capture.wait_session_modes()  # stage 0: startup + SGR arm
        capture.write(b"\x1b[<0;15;3m")  # release, whole — warms the reader
        capture.write_split([b"\x1b", b"[<0;13;2M"])  # press
        capture.write_split([b"\x1b", b"[<32;14;2M"])  # drag
        capture.write_split([b"\x1b", b"[<32;", b"15;3M"])  # drag, 3-way
        capture.write_split([b"\x1b", b"[<64;", b"20;5M"])  # wheel, 3-way
        capture.pump(1.5)  # stage 1
        capture.write(b"hi")
        capture.pump(0.8)  # stage 2
        capture.write(b"\r")
        capture.pump(18)  # stage 3: the scripted turn
        capture.write(b"\x03")
        capture.pump(1.5)  # stage 4: exit hint
        capture.write(b"\x03")
        capture.pump(10)  # stage 5: teardown (session cleanup takes seconds)
        return capture.stages, capture.gaps
    finally:
        capture.close()


def run_lone_esc_scenario(command, env_extra, cwd):
    """A genuinely lone `ESC` flushes as the key press; input keeps working.

    The `ESC` stands alone well past the hold window (nothing continues
    it), then `ok` + Enter submits exactly `ok` — the flush path must not
    wedge the reader or duplicate the keystrokes behind it.
    """
    capture = PtyCapture(command, env_extra, cwd)
    try:
        capture.wait_session_modes()  # stage 0: startup + SGR arm
        capture.write(b"\x1b")
        capture.pump(0.25)  # stage 1: the hold expires, the Esc flushes
        capture.write(b"ok")
        capture.pump(0.8)  # stage 2
        capture.write(b"\r")
        capture.pump(18)  # stage 3: the scripted turn
        capture.write(b"\x03")
        capture.pump(1.5)  # stage 4
        capture.write(b"\x03")
        capture.pump(10)  # stage 5: teardown (session cleanup takes seconds)
        return capture.stages, capture.gaps
    finally:
        capture.close()


def leak_scan(stages):
    """Every signal that report bytes reached the editor as text."""
    whole = b"".join(stages)
    hits = []
    for body in REPORT_BODIES:
        if body in whole:
            hits.append(f"report body rendered as text: {body!r}")
    if b"[<" in whole:
        hits.append("a report fragment (b'[<') rendered anywhere")
    return hits


def check_stages(name, stages, scenario, binary, out_dir=None, suffix=""):
    failures = []
    startup, post_input = stages[0], stages[1] + stages[2]
    whole = b"".join(stages)
    post_enter = b"".join(stages[3:])

    # Wire parity: both binaries arm button-event SGR tracking at startup
    # and disarm it at teardown (mouse_tracking.rs:44/50 == terminal.ts:580).
    if SGR_ON not in startup:
        failures.append(f"startup never arms SGR tracking (no {SGR_ON!r})")
    if SGR_OFF not in stages[4] + stages[5]:
        failures.append(f"teardown never disarms SGR tracking (no {SGR_OFF!r})")

    # The leak contract: nothing the drag carried may render as text.
    failures += leak_scan(stages)

    # No turn may start from the drag (or from the lone ESC).
    sentinel = SENTINEL_DRAG if scenario == "drag" else SENTINEL_ESC
    if WORKING_LABEL in post_input:
        failures.append("a turn started before Enter")
    for word in SENTINEL_WORDS:
        if word.encode() in post_input:
            failures.append(f"the turn ran before Enter ({word} in the pre-Enter stages)")

    # The reader stays healthy: typing + Enter submits exactly the typed
    # text (anything leaked into the editor rides along in the echo).
    if not all(word.encode() in post_enter for word in SENTINEL_WORDS):
        failures.append(f"the scripted turn never ran after Enter ({sentinel} missing)")
    typed = b"hi" if scenario == "drag" else b"ok"
    if typed not in post_enter:
        failures.append(f"the submitted message lost the typed text {typed!r}")
    for body in REPORT_BODIES:
        if body in post_enter:
            failures.append(f"the submitted echo carries a leaked body {body!r}")

    print(
        f"{name}: {len(whole)} bytes; SGR_ON={'yes' if SGR_ON in startup else 'NO'}, "
        f"SGR_OFF={'yes' if SGR_OFF in stages[4] + stages[5] else 'NO'}, "
        f"{len(failures)} failures"
    )
    if out_dir:
        with open(os.path.join(out_dir, f"{binary}{suffix}-raw.bin"), "wb") as f:
            f.write(whole)
        with open(os.path.join(out_dir, f"{binary}{suffix}-stages.json"), "w") as f:
            json.dump([len(s) for s in stages], f)
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-out", default=None, help="directory for raw captures")
    parser.add_argument(
        "--binary", choices=("ts", "rust"), default=None, help="run one side only"
    )
    parser.add_argument(
        "--defect-demo",
        metavar="BASE_BINARY",
        default=None,
        help="run the drag scenario against a pre-fix Rust build and print the leak signals it emits (exit 0)",
    )
    args = parser.parse_args()

    import tempfile

    # Fail fast before any launch: a non-TS `prime-agent` on PATH plays a
    # Rust build as the "ts" side and reports false divergences.
    vp.ts_identity.assert_ts_side_is_the_ts_product()

    base = tempfile.mkdtemp(prefix="mouse-sgr-parity-")
    out_dir = args.raw_out or tempfile.mkdtemp(prefix="mouse-sgr-raw-")
    os.makedirs(out_dir, exist_ok=True)

    import visual_parity as vpm

    shared_cwd, _, sandboxes = vpm.prepare_sandbox(base)

    if args.defect_demo:
        script_path = os.path.join(base, "faux-script.json")
        with open(script_path, "w") as f:
            json.dump(FAUX_SCRIPT, f, indent=2)
        command, env = build_command("rust", sandboxes["rust"], script_path)
        command[0] = args.defect_demo
        stages, _ = run_drag_scenario(command, env, shared_cwd)
        hits = leak_scan(stages)
        if hits:
            print(f"DEFECT CONFIRMED on {args.defect_demo} (pre-fix build leaks):")
            for hit in hits:
                print(f"  - {hit}")
        else:
            print(f"defect NOT reproduced on {args.defect_demo}: no leak signals fired")
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        return 0

    failures = {}
    binaries = ("ts", "rust") if not args.binary else (args.binary,)
    for binary in binaries:
        failures[binary] = []
        for scenario, runner in (
            ("drag", run_drag_scenario),
            ("lone-esc", run_lone_esc_scenario),
        ):
            script_path = os.path.join(base, f"faux-{scenario}.json")
            script = dict(FAUX_SCRIPT)
            script["responses"] = [
                {
                    "content": [
                        {
                            "type": "text",
                            "text": f"{SENTINEL_DRAG if scenario == 'drag' else SENTINEL_ESC} ack.",
                        }
                    ]
                }
            ]
            with open(script_path, "w") as f:
                json.dump(script, f, indent=2)
            command, env = build_command(binary, sandboxes[binary], script_path)
            stages, gaps = runner(command, env, shared_cwd)
            worst = max(gaps, default=0.0)
            print(f"  ({binary}/{scenario}: {len(gaps)} split gaps, worst {worst*1000:.2f} ms vs 10 ms hold)")
            failures[binary] += check_stages(
                f"{binary}/{scenario}", stages, scenario, binary, out_dir,
                "" if scenario == "drag" else "-esc",
            )

    batterylib.reap_daemons(needles=[base], cwd_roots=[base])

    failed = {binary: fails for binary, fails in failures.items() if fails}
    if failed:
        for binary, fails in failed.items():
            print(f"{binary} FAILED:")
            for fail in fails:
                print(f"  - {fail}")
        return 1
    print("PARITY: ts and rust handle the mouse SGR corpus identically (no leak, input intact)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
