#!/usr/bin/env python3
"""Clipboard OSC 52 parity verifier: byte-capture the raw terminal stream of
the Rust interactive TUI and the installed TS binary while `/copy` runs, and
compare the OSC 52 clipboard sequences they emit (TS `utils/clipboard.ts`
`emitOsc52`: `ESC ] 52 ; c ; <base64> BEL`).

tmux parses (and swallows) OSC 52 like it does OSC 133, so both binaries run
under a raw pty with every byte recorded before any terminal parser sits in
between (the same capture contract scripts/osc_parity.py uses). The scenario
runs the scripted faux turn both sides consume, so the last assistant text —
and therefore the OSC 52 payload — must be byte-identical.

The clipboard tool chain is neutralized on both sides (no DISPLAY, no
WAYLAND_DISPLAY, no SSH transport), which is the TS fallback condition that
reaches the OSC 52 emitter.

Exit code is non-zero when the sequences differ or either side emits none.
"""

import argparse
import base64
import fcntl
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)
import visual_parity as vp  # noqa: E402  (the shared sandbox/faux fixtures)

WIDTH, HEIGHT = 120, 36

# The OSC 52 clipboard-set sequence: ESC ] 52 ; c ; <base64> BEL.
OSC52 = re.compile(rb"\x1b\]52;c;([A-Za-z0-9+/=]*)\x07")


def run_pty(command, env_extra, cwd, keys_script, total_seconds):
    """Run `command` under a raw pty; return every output byte."""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", HEIGHT, WIDTH, 0, 0))
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    # The copy must reach the OSC 52 fallback: no platform clipboard tools
    # answer without a display, and no SSH transport marks the session
    # remote (which would ALSO emit — but both sides then race their local
    # tool chain; the deterministic capture removes both).
    for var in (
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "SSH_CONNECTION",
        "SSH_CLIENT",
        "MOSH_CONNECTION",
        "TERMUX_VERSION",
    ):
        env.pop(var, None)
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


def copy_keys(master, pump):
    """Drive the scripted turn, then `/copy` once the answer settles."""
    pump(8)
    os.write(master, vp.PROMPT.encode() + b"\r")
    pump(30)
    # The turn's final answer is on screen; the status row after the copy is
    # the settle signal, but the raw stream is what matters — `/copy` now.
    os.write(master, b"/copy\r")
    pump(3)


def capture(binary, sandbox, shared_cwd, script_path):
    agent = sandbox["agent"]
    common = {
        "HOME": sandbox["home"],
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
    return run_pty(command, common, shared_cwd, copy_keys, 45)


def osc52_sequences(raw):
    return [m.group(0) for m in OSC52.finditer(raw)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep the sandbox dir")
    parser.add_argument("--raw-out", default=None, help="directory for raw captures")
    args = parser.parse_args()

    # Fail fast before any launch: a non-TS `prime-agent` on PATH plays a
    # Rust build as the "ts" side and reports false parity.
    vp.ts_identity.assert_ts_side_is_the_ts_product()

    base = tempfile.mkdtemp(prefix="clipboard-parity-sandbox-")
    out_dir = args.raw_out or tempfile.mkdtemp(prefix="clipboard-parity-raw-")
    os.makedirs(out_dir, exist_ok=True)
    shared_cwd, script_path, sandboxes = vp.prepare_sandbox(base)
    try:
        raw = {}
        for binary in ("ts", "rust"):
            raw[binary] = capture(binary, sandboxes[binary], shared_cwd, script_path)
            with open(os.path.join(out_dir, f"{binary}-raw.bin"), "wb") as f:
                f.write(raw[binary])
            sequences = osc52_sequences(raw[binary])
            print(f"{binary}: {len(raw[binary])} bytes; {len(sequences)} OSC 52 sequence(s)")
            for sequence in sequences:
                encoded = OSC52.search(sequence).group(1)
                text = base64.b64decode(encoded)
                print(f"  payload: {text!r}")

        ts_sequences = osc52_sequences(raw["ts"])
        rust_sequences = osc52_sequences(raw["rust"])
        if not ts_sequences:
            print("FAIL: the TS binary emitted no OSC 52 sequence (the tool chain found a clipboard?)")
            return 1
        if not rust_sequences:
            print("FAIL: the Rust binary emitted no OSC 52 sequence")
            return 1
        if ts_sequences != rust_sequences:
            print("FAIL: the OSC 52 sequences differ")
            for side in ("ts", "rust"):
                print(f"  {side}: {osc52_sequences(raw[side])}")
            return 1
        # The payload must be the scripted turn's final answer.
        text = base64.b64decode(OSC52.search(ts_sequences[0]).group(1))
        if vp.TURN1_FINAL_ANSWER.encode() not in text:
            print(f"FAIL: the payload is not the scripted answer: {text!r}")
            return 1
        print(f"PASS: both binaries copied the same text via the same OSC 52 bytes ({text!r})")
        return 0
    finally:
        # Rmtree alone leaks the scenario daemons: sweep every daemon this
        # run spawned before deleting the sandbox.
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
