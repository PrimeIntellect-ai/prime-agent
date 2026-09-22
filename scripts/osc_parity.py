#!/usr/bin/env python3
"""OSC 133 zone-marker parity verifier: byte-capture the raw terminal stream
of the Rust interactive TUI and the installed TS binary and compare the
shell-integration markers they emit (TS `user-message.ts` /
`assistant-message.ts` / `slash-command-message.ts`).

Note on tmux: tmux parses (and, before 3.3, silently swallows) OSC 133, so
`capture-pane -e` cannot show these sequences — the pane never stores them.
This verifier therefore drives both binaries through the scripted faux
session under a raw pty and records every output byte before any terminal
parser sits in between (scripts/visual_parity.py owns the visible-frame
diff; this one owns the zero-width control sequences).

Checks, per binary and across binaries:
  - the zone-start (`133;A`) and end/final (`133;B` then `133;C`) sequences
    are emitted at the same terminal rows;
  - every marked assistant/user message row pair (A row before B/C row)
    exists on both sides.

Exit code is non-zero when the marker shapes or rows differ.
"""

import argparse
import os
import pty
import re
import select
import signal
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
A_ROW = re.compile(rb"\x1b\[(\d+);1H(?:\x1b\[2K)?\x1b\]133;A\x07")
B_ROW = re.compile(rb"\x1b\[(\d+);1H(?:\x1b\[2K)?(?:\x1b\]133;B\x07\x1b\]133;C\x07)")


def run_pty(command, env_extra, cwd, keys_script, total_seconds):
    """Run `command` under a raw pty; return every output byte."""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", HEIGHT, WIDTH, 0, 0))
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env.update(env_extra)
    proc = subprocess.Popen(
        command, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=cwd
    )
    os.close(slave)
    out = bytearray()

    def pump(dur):
        deadline = time.time() + dur
        while time.time() < deadline:
            readable, _, _ = select.select([master], [], [], 0.1)
            if master in readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return False
                if not chunk:
                    return False
                out.extend(chunk)
        return True

    keys_script(master, pump)
    time.sleep(0.5)
    try:
        proc.terminate()
        proc.wait(5)
    except Exception:
        proc.kill()
    os.close(master)
    return bytes(out)


def session_keys(master, pump):
    """Drive the scripted faux turn: wait for the splash, submit the prompt."""
    pump(6)
    os.write(master, vp.PROMPT.encode() + b"\r")
    pump(35)


def capture(binary, sandbox, shared_cwd, script_path):
    agent = sandbox["agent"]
    common = {
        "HOME": sandbox["home"],
        # Isolated TMPDIR: the TS supervisor's socket (the default
        # daemon-socket dir) stays under this run's sandbox, so the
        # cleanup reap can sweep by path alone.
        "TMPDIR": sandbox["tmp"],
        "PRIME_AGENT_CODING_AGENT_DIR": agent,
        "PRIME_AGENT_FAUX_SCRIPT": script_path,
        "PRIME_AGENT_DISABLE_ANALYTICS": "1",
    }
    if binary == "ts":
        command = [
            "prime-agent",
            "--daemon-socket",
            os.path.join(agent, "daemon.sock"),
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
            os.path.join(agent, "daemon.sock"),
            "--model",
            vp.TS_SCRIPT_MODEL,
        ]
    return run_pty(command, common, shared_cwd, session_keys, 45)


def marker_rows(raw):
    a_rows = sorted({int(m.group(1)) for m in A_ROW.finditer(raw)})
    b_rows = sorted({int(m.group(1)) for m in B_ROW.finditer(raw)})
    return a_rows, b_rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep the sandbox dir")
    parser.add_argument("--raw-out", default=None, help="directory for raw captures")
    args = parser.parse_args()

    import tempfile
    import shutil

    # Fail fast before any launch: a non-TS `prime-agent` on PATH plays a
    # Rust build as the "ts" side and reports false divergences.
    vp.ts_identity.assert_ts_side_is_the_ts_product()

    base = tempfile.mkdtemp(prefix="osc-parity-sandbox-")
    out_dir = args.raw_out or tempfile.mkdtemp(prefix="osc-parity-raw-")
    os.makedirs(out_dir, exist_ok=True)
    shared_cwd, script_path, sandboxes = vp.prepare_sandbox(base)
    try:
        raw = {}
        for binary in ("ts", "rust"):
            raw[binary] = capture(binary, sandboxes[binary], shared_cwd, script_path)
            with open(os.path.join(out_dir, f"{binary}-raw.bin"), "wb") as f:
                f.write(raw[binary])
            a_rows, b_rows = marker_rows(raw[binary])
            print(f"{binary}: {len(raw[binary])} bytes; A rows {a_rows}; B/C rows {b_rows}")
            if not a_rows or not b_rows:
                print(f"FAIL {binary}: no OSC 133 markers in the raw stream")
                return 1

        ts_a, ts_b = marker_rows(raw["ts"])
        rust_a, rust_b = marker_rows(raw["rust"])
        if ts_a != rust_a or ts_b != rust_b:
            print(f"FAIL: marker rows differ (ts A {ts_a} B {ts_b}; rust A {rust_a} B {rust_b})")
            return 1
        for a in ts_a:
            if not any(b > a for b in ts_b):
                print(f"FAIL: zone-start row {a} has no matching end row below it")
                return 1
        print(f"PASS: both binaries mark the same rows (A {ts_a}, B/C {ts_b})")
        return 0
    finally:
        # Rmtree alone leaks the scenario daemons (the pty kill does not
        # take the detached daemon/supervisor pair down; #223): sweep
        # every daemon this run spawned before deleting the sandbox.
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
