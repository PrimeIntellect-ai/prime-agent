#!/usr/bin/env python3
"""OSC 8 hyperlink parity verifier: byte-capture the raw terminal stream of
the Rust interactive TUI and the deployed TS binary over the same scripted
faux turn and compare the OSC 8 hyperlink sequences each emits.

TS reference (deployed 0.9.5 binary, the parity ground truth):
`markdown.ts` `case "link"` wraps the rendered label in
`\x1b]8;;URL\x1b\\` ... `\x1b]8;;\x1b\\` only when
`getCapabilities().hyperlinks` is true; the legacy branch prints the label
plus ` (href)` when the label differs from the href (mailto stripped). The
capability gate is `terminal-image.ts detectCapabilities`: hyperlinks on
for kitty/ghostty/wezterm/iTerm2/VS Code/Alacritty, forced off under
tmux/screen and in unknown terminals. (TS-main has since started wrapping
the legacy branch too - a documented version gap, not a port divergence.)

Leg A (raw pty, TERM_PROGRAM=vscode so both sides detect hyperlinks): the
OSC 8 opens must appear in the same settled-frame rows with the same URL
and the same visible label on both sides. This is the bare-URL autolink
fix itself: marked's gfm url rule links bare http/https/ftp/www/email
shapes that the Rust used to render as plain body text.

Leg B (tmux pane, no capability env): both sides render the legacy
fallback rows identically and the captured pane contains no OSC 8 at all -
tmux 3.2a swallows the sequences, which is exactly why detectCapabilities
forces them off under tmux.

Exit code is non-zero when the sequences or rows differ.
"""

import argparse
import glob
import json
import os
import pty
import re
import select
import signal
import shutil
import struct
import subprocess
import sys
import fcntl
import termios
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)
import visual_parity as vp  # noqa: E402  (sandbox + tmux + capture helpers)

WIDTH, HEIGHT = 120, 36

# The scripted faux turn: every link shape Kevin's dogfood reported as
# plain text, one paragraph per row so the rows map 1:1.
URL_TURN = (
    "Links live here.\n"
    "\n"
    "PR: https://github.com/PrimeIntellect-ai/prime-agent/pull/182.\n"
    "\n"
    "Share: https://x.dev/share/abc123?u=1 now\n"
    "\n"
    "WWW: www.example.com/path end\n"
    "\n"
    "Email: kevin@example.co.uk bye\n"
    "\n"
    "Angle: <https://angle.dev/x> done\n"
    "\n"
    "Explicit: [docs](https://example.com/docs) and [https://bare.dev](https://bare.dev)\n"
    "\n"
    "Parens: (see https://x.dev/page_(p), thanks)\n"
)

PROMPT = "Show me the links."
URL_NEEDLES = [line.split(":")[0] + ": " for line in URL_TURN.splitlines() if ": " in line]

FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": "faux-1",
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 18,
    "responses": [{"content": [{"type": "text", "text": URL_TURN}]}],
}

OSC8_OPEN = re.compile(rb"\x1b\]8;;([^\x1b]*)\x1b\\")
SGR_RE = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")


def run_pty(command, env_extra, cwd, turn_seconds):
    """Run `command` as its own session owning a fresh pty; return every
    output byte plus the byte offset where the harness resized the tty.

    `pty.fork()` makes the client the session leader with the slave as
    its controlling terminal, so the TIOCSWINSZ resize below reaches it
    as SIGWINCH and forces the full-frame repaint the settled hyperlink
    rows are captured from. Timing is driven by quiescence, not fixed
    sleeps: the prompt is typed only once the attach chrome is quiet and
    echoes back, the turn is awaited until the stream falls silent, and
    the capture ends after the post-resize repaint has quiesced.
    """
    env = dict(os.environ)
    # The harness box itself often runs under tmux; the capability probe
    # must see the terminal this pty pretends to be, not the box's session.
    for key in (
        "TMUX",
        "TMUX_PANE",
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "KITTY_WINDOW_ID",
        "WEZTERM_PANE",
        "ITERM_SESSION_ID",
        "GHOSTTY_RESOURCES_DIR",
    ):
        env.pop(key, None)
    env["TERM"] = "xterm-256color"
    env.update(env_extra)
    pid, master = pty.fork()
    if pid == 0:  # child: session leader on the new controlling terminal
        try:
            os.chdir(cwd)
            os.execve(command[0], command, env)
        except Exception:
            os._exit(127)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", HEIGHT, WIDTH, 0, 0))
    out = bytearray()

    def child_running():
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            return done == 0
        except ChildProcessError:
            return False

    def pump_until(settled, timeout, quiet=2.0):
        """Pump until `settled()` holds and the stream has been quiet."""
        start = time.time()
        last_byte = time.time()
        while time.time() - start < timeout:
            readable, _, _ = select.select([master], [], [], 0.1)
            if master in readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return False
                if not chunk:
                    return False
                out.extend(chunk)
                last_byte = time.time()
            if settled() and time.time() - last_byte >= quiet:
                return True
        return False

    def frame_settled():
        # The clients repaint their status row while idle; the splash is
        # done once the stream falls silent with the frame up.
        return b"Collapsed mode" in out

    def turn_settled():
        # The diff painters repaint streamed rows cell-by-cell, so the
        # needle rows never appear contiguous in the byte stream; the turn
        # is settled once it has begun and the stream falls quiet.
        return b"Links live here" in out

    t0 = time.time()
    alive = pump_until(frame_settled, 90, quiet=3.0)
    # Type only once the editor echoes it back: clients drop keys while
    # the attach chrome still repaints (the Rust editor starts reading
    # seconds after "Collapsed mode" first paints), so a blind write can
    # be lost entirely. Retype until the echo lands, then submit.
    echoed = False
    for _ in range(12):
        os.write(master, PROMPT.encode() + b"\r")
        echoed = pump_until(lambda: PROMPT.encode() in out, 10, quiet=0.5)
        if echoed:
            break
    print(f"  pty: prompt echoed at {time.time() - t0:.1f}s")
    alive = alive and echoed and pump_until(turn_settled, turn_seconds, quiet=4.0)
    print(f"  pty: turn settle at {time.time() - t0:.1f}s ({len(out)} bytes)")
    # Resize to force a full repaint on both sides: the diff painters only
    # emit a row's OSC 8 sequences when its cells repaint, so the settled
    # hyperlink rows must be observed after a full-frame redraw.
    resize_offset = len(out)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", HEIGHT, WIDTH - 4, 0, 0))
    alive = alive and pump_until(lambda: True, 20, quiet=3.0)
    print(f"  pty: resize settle at {time.time() - t0:.1f}s ({len(out)} bytes)")
    alive = alive and child_running()
    try:
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
    except Exception:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except Exception:
            pass
    os.close(master)
    if not alive:
        print("WARN: the client exited early or never settled under the pty")
    return bytes(out), resize_offset


def binary_command(binary, sandbox, script_path):
    agent = sandbox["agent"]
    common_env = {
        "HOME": sandbox["home"],
        "TMPDIR": sandbox["tmp"],
        "PRIME_AGENT_CODING_AGENT_DIR": agent,
        "PRIME_AGENT_FAUX_SCRIPT": script_path,
        "PRIME_AGENT_DISABLE_ANALYTICS": "1",
    }
    if binary == "ts":
        ts_bin = os.environ.get("TS_BIN") or "prime-agent"
        command = [ts_bin, "--daemon-socket", os.path.join(agent, "daemon.sock"), "--model", vp.TS_SCRIPT_MODEL]
    else:
        rust = os.environ.get(
            ts_identity.RUST_BINARY_ENV,
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "prime-agent"),
        )
        common_env["PI_PACKAGE_DIR"] = os.environ.get("PI_PACKAGE_DIR") or vp.find_runtime_package_dir()
        command = [rust, "--daemon-socket", os.path.join(agent, "daemon.sock"), "--model", vp.TS_SCRIPT_MODEL]
    return command, common_env


def leg_a_events(tail):
    """Settled-frame OSC 8 events: {row: (url, visible label)}.

    `tail` is the stream after the resize that forces both painters into a
    full-frame redraw, so the events are the settled ones. Rows are
    tracked by absolute cursor addressing (both painters emit
    `[row;colH` before painting), so an open is attributed to the row the
    cursor sits on - not to whichever row was painted next. The last
    event per row wins (the frame repaint is the final pass).
    """
    events = {}
    row = 1
    pending = None  # [row, url, label bytes] while a hyperlink region is open
    prev_end = 0
    for m in re.finditer(rb"\x1b", tail):
        if m.start() < prev_end:
            # an ESC inside a sequence already consumed (the ST of an OSC 8
            # open/close): not a new sequence start.
            continue
        between = tail[prev_end : m.start()]
        if pending is not None:
            pending[2] += between
        prev_end = m.start()
        rest = tail[m.start() :]
        if rest.startswith(b"\x1b]"):
            link = re.match(rb"\x1b\]8;;([^\x1b]*)\x1b\\", rest)
            if not link:
                # another OSC payload (shell prompt markers etc.): skip it
                # through its terminator; it neither closes nor breaks the
                # active hyperlink region.
                skip = re.search(rb"[\x07]|\x1b\\", rest[2:])
                prev_end = m.start() + 2 + (skip.end() if skip else 0)
                continue
            url = link.group(1)
            if url:
                pending = [row, url.decode("utf-8", "replace"), b""]
            elif pending is not None:
                label = re.sub(rb"[^\x20-\x7e]", b"", pending[2])
                events.setdefault(pending[0], []).append(
                    (pending[1], label.decode("utf-8", "replace"))
                )
                pending = None
            prev_end = m.start() + len(link.group(0))
        elif rest.startswith(b"\x1b["):
            move = re.match(rb"\x1b\[(\d+);(\d+)H", rest)
            if move:
                new_row = int(move.group(1))
                if pending is not None and new_row != row:
                    # the region did not close on the row it opened: the
                    # label wrapped; keep the first row's part.
                    label = re.sub(rb"[^\x20-\x7e]", b"", pending[2])
                    events.setdefault(pending[0], []).append(
                        (pending[1], label.decode("utf-8", "replace"))
                    )
                    pending = None
                row = new_row
                prev_end = m.start() + len(move.group(0))
            else:
                skip = re.match(rb"\x1b\[[0-9;?]*[A-Za-z]", rest)
                if skip:
                    prev_end = m.start() + len(skip.group(0))
                else:
                    prev_end = m.start() + 1
    return events


def leg_a(ts_bin, rust_bin, base):
    """Raw-pty capture with hyperlinks forced on: compare settled events."""
    shared_cwd, script_path, sandboxes = base
    raw = {}
    resize_at = {}
    for binary in ("ts", "rust"):
        command, env_extra = binary_command(binary, sandboxes[binary], script_path)
        env_extra["TERM_PROGRAM"] = "vscode"
        raw[binary], resize_at[binary] = run_pty(command, env_extra, shared_cwd, 150)
    events = {b: leg_a_events(raw[b][resize_at[b] :]) for b in raw}
    for b in ("ts", "rust"):
        with open(os.path.join(OUT_DIR, f"leg-a-{b}.bin"), "wb") as f:
            f.write(raw[b])
        print(f"leg A {b}: {len(raw[b])} bytes, {len(events[b])} settled OSC 8 rows")
    if not events["rust"]:
        print("FAIL leg A: the Rust side emitted no OSC 8 sequences")
        return 1
    if not events["ts"]:
        print("FAIL leg A: the TS side emitted no OSC 8 sequences")
        return 1
    if events["ts"] != events["rust"]:
        print("FAIL leg A: OSC 8 events differ")
        for row in sorted(set(events["ts"]) | set(events["rust"])):
            a = events["ts"].get(row)
            b = events["rust"].get(row)
            if a != b:
                print(f"  row {row}: ts={a} rust={b}")
        return 1
    # The lane fix itself: bare urls must be among the wrapped hrefs.
    urls = {url for links in events["ts"].values() for url, _ in links}
    for expected in (
        "https://github.com/PrimeIntellect-ai/prime-agent/pull/182",
        "https://x.dev/share/abc123?u=1",
        "http://www.example.com/path",
        "mailto:kevin@example.co.uk",
        "https://angle.dev/x",
        "https://example.com/docs",
        "https://bare.dev/",
        "https://x.dev/page_(p)",
    ):
        if expected not in urls:
            print(f"FAIL leg A: expected OSC 8 href missing: {expected}")
            return 1
    print("PASS leg A: OSC 8 rows, hrefs, and labels are identical")
    return 0


def leg_b(base):
    """tmux panes with no capability env: legacy fallback parity, no OSC 8."""
    shared_cwd, script_path, sandboxes = base
    panes = {}
    for binary in ("ts", "rust"):
        session = f"vplane-osc8-{binary}"
        vp.tmux("kill-session", "-t", session, check=False)
        vp.tmux("new-session", "-d", "-s", session, "-x", str(WIDTH), "-y", str(HEIGHT), "-c", shared_cwd)
        command, env_extra = binary_command(binary, sandboxes[binary], script_path)
        env = " ".join(f"{k}={v}" for k, v in env_extra.items())
        vp.tmux("send-keys", "-t", session, f"{env} {' '.join(command)}", "Enter")
        vp.wait_for(session, "Collapsed mode", timeout=40)
        time.sleep(1.0)
        vp.tmux("send-keys", "-t", session, PROMPT, "Enter")
        deadline = time.time() + 40
        while time.time() < deadline:
            pane = vp.capture(session, escape=False)
            if "Parens:" in pane:
                break
            time.sleep(0.5)
        time.sleep(2.0)
        panes[binary] = {"plain": vp.capture(session, escape=False), "escapes": vp.capture(session, escape=True)}
        vp.tmux("kill-session", "-t", session, check=False)
    for b in ("ts", "rust"):
        with open(os.path.join(OUT_DIR, f"leg-b-{b}.txt"), "w") as f:
            f.write(panes[b]["escapes"])
        if "\x1b]8;" in panes[b]["escapes"]:
            print(f"FAIL leg B: {b} pane carries OSC 8 sequences under tmux")
            return 1
    # Every link row must render the same visible legacy text on both sides.
    ts_rows = {line.strip() for line in panes["ts"]["plain"].splitlines() if line.strip()}
    rust_rows = {line.strip() for line in panes["rust"]["plain"].splitlines() if line.strip()}
    failures = []
    for needle in URL_NEEDLES:
        ts_row = next((r for r in ts_rows if r.startswith(needle)), None)
        rust_row = next((r for r in rust_rows if r.startswith(needle)), None)
        if ts_row is None or rust_row is None:
            failures.append(f"{needle!r}: ts={ts_row!r} rust={rust_row!r}")
        elif ts_row != rust_row:
            failures.append(f"{needle!r}: ts={ts_row!r} rust={rust_row!r}")
    if failures:
        print("FAIL leg B: legacy fallback rows differ")
        for f_ in failures:
            print(f"  {f_}")
        return 1
    print("PASS leg B: legacy rows identical, no OSC 8 under tmux")
    return 0


OUT_DIR = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep the sandbox dir")
    parser.add_argument("--out", default=None, help="directory for captures")
    args = parser.parse_args()

    global OUT_DIR
    OUT_DIR = args.out or tempfile.mkdtemp(prefix="osc8-parity-")
    os.makedirs(OUT_DIR, exist_ok=True)

    ts_bin = os.environ.get("TS_BIN") or shutil.which("prime-agent")
    rust_bin = os.environ.get(ts_identity.RUST_BINARY_ENV) or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "prime-agent"
    )
    if not os.path.exists(rust_bin):
        print(f"FAIL: rust binary not found at {rust_bin} (set PA_RUST_BINARY)")
        return 1
    ts_identity.assert_ts_side_is_the_ts_product(ts_bin, rust_bin)

    base_dir = tempfile.mkdtemp(prefix="osc8-parity-sandbox-")
    script_path = os.path.join(base_dir, "faux-script.json")
    with open(script_path, "w") as f:
        json.dump(FAUX_SCRIPT, f, indent=2)
    shared_cwd, _, sandboxes = vp.prepare_sandbox(base_dir)
    # prepare_sandbox writes vp.FAUX_SCRIPT; overwrite with this harness's.
    with open(script_path, "w") as f:
        json.dump(FAUX_SCRIPT, f, indent=2)
    base = (shared_cwd, script_path, sandboxes)
    try:
        rc = leg_a(ts_bin, rust_bin, base)
        if rc:
            return rc
        return leg_b(base)
    finally:
        batterylib.reap_daemons(needles=[base_dir], cwd_roots=[base_dir])
        if not args.keep:
            shutil.rmtree(base_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
