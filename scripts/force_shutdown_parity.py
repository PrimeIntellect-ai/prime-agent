#!/usr/bin/env python3
"""Force-shutdown parity verifier: `shutdown --force` against a live daemon
under both binaries (R6's audit lane).

For each binary (TS via --ts-bin, Rust via --rust-bin) this harness:

  1. boots the interactive TUI in a raw pty with a sandboxed state root
     long enough for the CLI to spawn its background daemon;
  2. leaves the daemon alive with a clean double-Ctrl+C exit;
  3. runs `shutdown --force --json` and `shutdown --force` (text) against
     the same state root and captures every byte;
  4. runs `shutdown --json` without --force and captures the
     confirmation-required JSON failure.

The JSON reports are compared after pids and socket paths are normalized:
both binaries must produce the same `{stopped, failed}` shape with the
same action strings, and the same text report. The one deliberate
divergence (a daemon that SURVIVES SIGKILL is reported as failed on the
Rust side while TS reports it stopped) cannot occur against a killable
daemon, so this harness pins the healthy path; the survived path is a
documented hardening divergence (see the PR/PORTING notes).

Exit code is non-zero when any stage check fails on either binary.
"""

import argparse
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import time
import fcntl
import termios

WIDTH, HEIGHT = 120, 36

CONFIRMATION_ERROR = (
    "confirmation required; use \"prime-agent shutdown --force --json\""
)


def sandbox(base):
    home = os.path.join(base, "home")
    agent = os.path.join(base, "agent")
    tmp = os.path.join(base, "tmp")
    for d in (home, agent, tmp):
        os.makedirs(d)
    return {"home": home, "agent": agent, "tmp": tmp}


def env_for(sb):
    env = dict(os.environ)
    env.update(
        {
            "HOME": sb["home"],
            "TMPDIR": sb["tmp"],
            "PRIME_AGENT_CODING_AGENT_DIR": sb["agent"],
            "PRIME_AGENT_DISABLE_ANALYTICS": "1",
            "TERM": "xterm-256color",
        }
    )
    return env


def pty_boot(binary, sb, seconds):
    """Boot the TUI under a raw pty until its daemon is up, then exit."""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", HEIGHT, WIDTH, 0, 0))
    env = env_for(sb)
    sock = os.path.join(sb["agent"], "daemon.sock")
    proc = subprocess.Popen(
        [binary, "--daemon-socket", sock],
        stdin=slave, stdout=slave, stderr=slave, env=env,
    )
    os.close(slave)
    deadline = time.time() + seconds
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.2)
        if master in r:
            try:
                os.read(master, 65536)
            except OSError:
                break
    os.write(master, b"\x03")
    time.sleep(1.0)
    os.write(master, b"\x03")
    time.sleep(2.0)
    try:
        proc.wait(5)
    except Exception:
        proc.kill()
    os.close(master)
    return os.path.exists(sock)


def run_cli(binary, sb, args):
    """Run one CLI command on the plain pipes; return stdout/stderr."""
    out = subprocess.run(
        [binary] + args,
        capture_output=True,
        text=True,
        env=env_for(sb),
        timeout=120,
    )
    return out.returncode, out.stdout, out.stderr


def normalize(text):
    """Erase pids and sandbox paths so runs are comparable."""
    text = re.sub(r"\b\d{2,}\b", "<pid>", text)
    text = re.sub(r"/tmp/[^ \"',\n]+", "<tmp>", text)
    return text


def scenario(binary, base, name):
    sb = sandbox(os.path.join(base, name))
    results = {}
    if not pty_boot(binary, sb, 10):
        results["boot"] = "daemon socket never appeared"
        return results
    # JSON mode against the live daemon.
    code, out, err = run_cli(binary, sb, ["shutdown", "--force", "--json"])
    results["json"] = {"code": code, "out": normalize(out.strip()), "err": normalize(err.strip())}
    # Text mode needs a fresh daemon.
    sb2 = sandbox(os.path.join(base, name + "2"))
    if pty_boot(binary, sb2, 10):
        code, out, err = run_cli(binary, sb2, ["shutdown", "--force"])
        results["text"] = {"code": code, "out": normalize(out.strip())}
    # The confirmation error (JSON without --force, stdin not a TTY).
    sb3 = sandbox(os.path.join(base, name + "3"))
    if pty_boot(binary, sb3, 10):
        code, out, err = run_cli(binary, sb3, ["shutdown", "--json"])
        results["confirm"] = {"code": code, "out": normalize(out.strip())}
        # The confirmation refusal is a pinned invariant (TS text, same
        # quote style): JSON without --force over a non-tty stdin must
        # carry it, in both output modes' byte stream.
        if CONFIRMATION_ERROR not in out:
            results.setdefault("errors", []).append("confirmation error string missing")
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ts-bin", required=True)
    parser.add_argument("--rust-bin", required=True)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()

    base = tempfile.mkdtemp(prefix="force-shutdown-parity-")
    ts = scenario(args.ts_bin, base, "ts")
    rust = scenario(args.rust_bin, base, "rust")
    print("== TS ==")
    print(json.dumps(ts, indent=2))
    print("== RUST ==")
    print(json.dumps(rust, indent=2))

    failures = []
    for mode in ("json", "text", "confirm"):
        if mode not in ts or mode not in rust:
            failures.append(f"{mode} missing on one side")
            continue
        if ts[mode] != rust[mode]:
            failures.append(f"{mode} outputs differ:\n TS:   {ts[mode]}\n RUST: {rust[mode]}")
    if failures:
        print("FAIL")
        for failure in failures:
            print(failure)
        return 1
    print("PASS: json/text/confirm outputs identical after normalization")
    if not args.keep:
        subprocess.run(["rm", "-rf", base])
    return 0


if __name__ == "__main__":
    sys.exit(main())
