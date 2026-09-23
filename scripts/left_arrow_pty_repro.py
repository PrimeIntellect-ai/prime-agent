#!/usr/bin/env python3
"""Kevin's live repro on a RAW PTY (no tmux): the harness is the terminal.

A kitty-capable terminal in miniature: it watches the client's byte
stream, answers the kitty keyboard-protocol query and the primary
device attributes query (BOTH answers, or crossterm 0.28's probe thread
parks the shared event reader forever and the app freezes), and sends
keys in the encoding the client's pushed flags call for — kitty CSI-u
press/release pairs once `\x1b[>7u` was pushed, legacy sequences before.

Scenarios, per side (`ts` = the deployed TS release, `rust` = this
branch's build, `dogfood` = the box's public Rust build — the behavior
Kevin ran):

- `left-instant`: a bare LEFT ~0.3s after launch (Kevin's "hit it
  immediately"). TS parity: the empty editor's agents-back hands the
  pane to the agents view — the client stays alive; nobody may print
  "shutdown stalled; forced exit."
- `left-frame`: the same key once the chat painted.
- `left-slow-answer`: the kitty answer is delayed past the whole probe
  window, so the key lands while the probe is in flight and the chat
  teardown races it. TS has no exit deadline on a view switch; the Rust
  client must stay alive and complete the handoff.
- `wedge-force-quit`: a JSONL proxy holds `get_session_stats` requests;
  the first faux turn completes, the loop parks in the post-turn stats
  refresh (its 10s bound), and a double Ctrl+C pair arrives while the
  loop is parked — the force-quit watchdog fires. The forced exit MUST
  restore the terminal: the stop-set bytes (paste off, kitty pop,
  modifyOtherKeys reset, mouse off, leave alt screen, cursor show) on
  the stream and a cooked tty (canonical input + echo) after the exit.

Facts per scenario: alive/exited + exit code, the "shutdown stalled"
message, the kitty push/pop balance, the stop-set presence, the pty
termios after a leave, whether the handoff painted the roster surface.

Each scenario runs against its OWN daemon on its OWN sandboxed socket
(the client auto-spawns it; the wedge scenario fronts it with the
stalling proxy). Daemons are reaped by their unique socket path, never
by pattern.
"""

import argparse
import fcntl
import glob
import json
import os
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import visual_parity as vp  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import ts_identity  # noqa: E402

SIZE = (120, 36)

#: The deployed TS release binary (the parity side; the PATH
#: `prime-agent` may be this repo's dogfood build — ts_identity guards
#: against playing that as TS).
_release_glob = os.path.expanduser(
    "~/.local/share/prime-agent/releases/0.9.5-linux-x64-*/prime-agent"
)
_release_hits = sorted(glob.glob(_release_glob))
TS_BIN = os.environ.get("TS_BIN") or (_release_hits[-1] if _release_hits else "prime-agent")
RUST_BIN = os.environ.get(
    "PA_RUST_BINARY",
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "prime-agent"
    ),
)
DOGFOOD_BIN = os.environ.get("PA_DOGFOOD_BINARY", "/usr/local/bin/prime-agent")

#: The kitty query answer: flags 1|2|4 (what a terminal supporting all
#: three pushed modes answers), then the DA1 answer — crossterm's probe
#: blocks reading the primary device attributes after the flags answer.
KITTY_FLAGS_ANSWER = b"\x1b[?7u"
DA1_ANSWER = b"\x1b[?62;c"
KITTY_QUERY = b"\x1b[?u"

#: Byte markers whose balance proves the terminal modes come back.
KITTY_PUSH = b"\x1b[>7u"
KITTY_POP = b"\x1b[<u"
PASTE_OFF = b"\x1b[?2004l"
MODIFY_RESET = b"\x1b[>4;0m"
MOUSE_OFF = b"\x1b[?1006l"
LEAVE_ALT = b"\x1b[?1049l"
CURSOR_SHOW = b"\x1b[?25h"

#: The needles: the chat settle marker (the same one the tmux harnesses
#: use), the faux reply, and the agents-view roster surface.
CHAT_SETTLE = b"Collapsed mode"
FAUX_REPLY = b"arrow repro"
AGENTS_VIEW_NEEDLE = b" idle, "

#: The worker-role marker in a daemon worker's environment; the wedge
#: scenario SIGSTOPs the sandbox's worker so the next prompt request
#: parks the UI loop in its 10s bound while the reader thread stays
#: alive to observe the Ctrl+C pair (the session traffic rides the
#: direct worker transport, so a supervisor-socket proxy cannot hold it).
WORKER_ROLE_MARKER = b"PRIME_AGENT_INTERNAL_DAEMON_WORKER=1"

FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": "faux-1",
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 18,
    "responses": [{"text": "left arrow repro reply"}],
}


def side_binary(side):
    if side == "ts":
        return TS_BIN
    if side == "dogfood":
        return DOGFOOD_BIN
    return RUST_BIN


def side_env(side, sandbox):
    # This harness may itself run inside a prime-agent daemon worker:
    # the inherited PRIME_AGENT_INTERNAL_* role vars would start an
    # explicitly spawned daemon in WORKER mode against the box's real
    # supervisor (the auto-spawn path strips the same set).
    env = {k: v for k, v in os.environ.items() if not k.startswith("PRIME_AGENT_INTERNAL_")}
    env.update(
        {
            "HOME": sandbox["home"],
            "TMPDIR": sandbox["tmp"],
            "PRIME_AGENT_CODING_AGENT_DIR": sandbox["agent"],
            "PRIME_AGENT_FAUX_SCRIPT": sandbox["faux_script"],
            "PRIME_AGENT_DISABLE_ANALYTICS": "1",
        }
    )
    env.pop("TMUX", None)
    if side in ("rust", "dogfood"):
        env["PI_PACKAGE_DIR"] = os.environ.get("PI_PACKAGE_DIR") or vp.find_runtime_package_dir()
    return env


class PtyClient:
    """One TUI client on a raw pty: the harness is the terminal."""

    def __init__(self, side, sandbox, answer_policy):
        self.side = side
        self.sandbox = sandbox
        self.answer_policy = answer_policy
        self.master = None
        self.pid = None
        self.stream = bytearray()
        self.exited = False
        self.exit_code = None
        self.pushes = 0
        self.pops = 0
        self.queries_scheduled = 0

    def start(self, socket_path):
        self.master, slave = pty_open_raw()
        pid = os.fork()
        if pid == 0:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            os.close(self.master)
            os.chdir(self.sandbox["cwd"])
            env = side_env(self.side, self.sandbox)
            argv = [side_binary(self.side), "--daemon-socket", socket_path,
                    "--model", vp.TS_SCRIPT_MODEL]
            os.execve(argv[0], argv, env)
        self.pid = pid
        os.close(slave)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", SIZE[1], SIZE[0], 0, 0))
        return pid

    def send_bytes(self, data):
        try:
            os.write(self.master, data)
        except OSError:
            pass

    def send_left(self):
        if self.pushes > self.pops:
            # Kitty flags pushed: a real terminal sends the CSI-u
            # press/release pair for the arrow (codepoint 57417).
            self.send_bytes(b"\x1b[57417;1:1u")
            time.sleep(0.02)
            self.send_bytes(b"\x1b[57417;1:3u")
        else:
            self.send_bytes(b"\x1b[D")

    def send_text(self, text):
        self.send_bytes(text.encode())

    def send_ctrl_c(self):
        if self.pushes > self.pops:
            self.send_bytes(b"\x1b[99;5:1u")
            time.sleep(0.02)
            self.send_bytes(b"\x1b[99;5:3u")
        else:
            self.send_bytes(b"\x03")

    def pump(self, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            self.pump_once(0.05)

    def pump_once(self, timeout):
        ready, _, _ = select.select([self.master], [], [], timeout)
        if ready:
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            self.stream.extend(chunk)
            self.pushes += chunk.count(KITTY_PUSH)
            self.pops += chunk.count(KITTY_POP)
            self.schedule_answers()
        return True

    def schedule_answers(self):
        """Answer every kitty query seen exactly once, on the policy's
        delay (measured from when the query appeared in the stream)."""
        seen = bytes(self.stream).count(KITTY_QUERY) - self.queries_scheduled
        if seen <= 0 or not self.answer_policy.get("answer", True):
            return
        self.queries_scheduled += seen
        delay = self.answer_policy.get("delay_ms", 0) / 1000.0
        if delay <= 0:
            self._write_answers()
        else:
            threading.Timer(delay, self._write_answers).start()

    def _write_answers(self):
        # Two separate writes: TS's kitty-response handler pattern is
        # line-anchored, so the flags answer must arrive as its own chunk.
        self.send_bytes(KITTY_FLAGS_ANSWER)
        time.sleep(0.02)
        self.send_bytes(DA1_ANSWER)

    def alive(self):
        if self.exited:
            return False
        pid, status = os.waitpid(self.pid, os.WNOHANG)
        if pid == self.pid:
            self.exited = True
            self.exit_code = os.waitstatus_to_exitcode(status)
            return False
        return True

    def wait_exit(self, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.pump_once(0.1)
            if not self.alive():
                return True
        return False

    def termios_cooked(self):
        try:
            attrs = termios.tcgetattr(self.master)
        except termios.error:
            return {"error": "tcgetattr failed"}
        return {
            "icanon": bool(attrs[3] & termios.ICANON),
            "echo": bool(attrs[3] & termios.ECHO),
        }

    def kill(self):
        if not self.exited:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except OSError:
                pass
        try:
            os.waitpid(self.pid, 0)
        except (ChildProcessError, OSError):
            pass
        if self.master is not None:
            try:
                os.close(self.master)
            except OSError:
                pass


def pty_open_raw():
    import pty as pty_mod

    return pty_mod.openpty()


def stream_has(client, needle):
    """Match a text needle on the ANSI-stripped stream: styled or wrapped
    output interleaves escape sequences inside the raw bytes."""
    if isinstance(needle, bytes):
        needle = needle.decode()
    return needle in visible_text(client.stream)


def wait_for_needle(client, needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        client.pump_once(0.2)
        if stream_has(client, needle):
            return True
        if not client.alive():
            return stream_has(client, needle)
    return stream_has(client, needle)


def visible_text(stream):
    text = bytes(stream)
    text = re.sub(b"\x1b\\[\\??[0-9;:]*[a-zA-Z]", b"", text)
    text = re.sub(b"\x1b\\][^\x07\x1b]*(\x07|\x1b\\\\)", b"", text)
    return text.decode(errors="replace")


def daemon_pids_for(socket_path):
    """Live `--mode daemon` processes whose argv references this socket."""
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as f:
                cmdline = f.read()
        except OSError:
            continue
        if b"--mode" in cmdline and socket_path.encode() in cmdline:
            found.append(int(entry))
    return found


def kill_daemons(socket_path):
    for pid in daemon_pids_for(socket_path):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    time.sleep(0.5)
    for pid in daemon_pids_for(socket_path):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def sandbox_worker_pids(sandbox):
    """Daemon worker processes belonging to THIS sandbox: the worker-role
    env marker plus the sandbox agent dir in the environment (never a
    bare pattern; other daemons on the box are untouched)."""
    agent_marker = sandbox["agent"].encode()
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/environ", "rb") as f:
                environ = f.read()
        except OSError:
            continue
        if WORKER_ROLE_MARKER in environ and agent_marker in environ:
            found.append(int(entry))
    return found


def run_scenario(side, sandbox, label, answer_policy, wedge=False):
    socket_path = os.path.join(sandbox["agent"], f"daemon-{label}-{side}.sock")
    stopped_workers = []
    facts = {"side": side, "scenario": label}
    client = PtyClient(side, sandbox, answer_policy)
    try:
        client.start(socket_path)
        if label == "left-instant":
            time.sleep(0.3)
            client.send_left()
        else:
            facts["chat_settled"] = wait_for_needle(client, CHAT_SETTLE, timeout=60)
            if label == "left-frame":
                client.pump(0.6)
                client.send_left()
            elif label == "left-slow-answer":
                client.pump(0.4)
                client.send_left()
            elif label == "wedge-force-quit":
                client.send_text("hello\r")
                facts["reply_streamed"] = wait_for_needle(client, FAUX_REPLY, timeout=60)
                # Freeze this sandbox's worker, then submit again: the
                # prompt request rides the direct worker transport into
                # the stopped worker and parks the UI loop in its 10s
                # bound. The Ctrl+C pair lands while the loop is parked
                # (the reader thread still observes it), so the
                # force-quit watchdog fires — the exit_guard's exact
                # contract for a wedged daemon request.
                client.pump(1.0)
                stopped_workers.extend(sandbox_worker_pids(sandbox))
                facts["workers_stopped"] = len(stopped_workers)
                for pid in stopped_workers:
                    os.kill(pid, signal.SIGSTOP)
                client.send_text("again\r")
                client.pump(1.0)
                client.send_ctrl_c()
                client.pump(0.3)
                client.send_ctrl_c()
        deadline = time.time() + 12
        while time.time() < deadline and client.alive():
            client.pump_once(0.2)
        facts["alive"] = client.alive()
        if not facts["alive"]:
            client.wait_exit(3)
            facts["exit_code"] = client.exit_code
        text = bytes(client.stream)
        facts["shutdown_stalled"] = b"shutdown stalled" in text
        facts["kitty_pushes"] = client.pushes
        facts["kitty_pops"] = client.pops
        facts["handoff_painted"] = AGENTS_VIEW_NEEDLE.decode() in visible_text(text)
        facts["stop_set"] = {
            "paste_off": PASTE_OFF in text,
            "kitty_pop": KITTY_POP in text,
            "modify_reset": MODIFY_RESET in text,
            "mouse_off": MOUSE_OFF in text,
            "leave_alt": LEAVE_ALT in text,
            "cursor_show": CURSOR_SHOW in text,
        }
        facts["push_pop_balanced"] = client.pops >= client.pushes
        if not facts["alive"]:
            facts["termios_after"] = client.termios_cooked()
            facts["tail_text"] = visible_text(client.stream)[-400:]
    finally:
        client.kill()
        for pid in stopped_workers:
            try:
                os.kill(pid, signal.SIGCONT)
            except OSError:
                pass
        kill_daemons(socket_path)
    return facts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sides", default=None, help="comma list: ts,rust,dogfood")
    parser.add_argument("--scenarios", default=None, help="comma list of scenario labels")
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()

    sides = args.sides.split(",") if args.sides else ["ts", "rust", "dogfood"]
    if "ts" in sides:
        ts_identity.assert_ts_side_is_the_ts_product(ts_bin=TS_BIN)

    base = tempfile.mkdtemp(prefix="left-arrow-pty-")
    print(f"sandbox root: {base}")
    shared_cwd, script_path, sandboxes = vp.prepare_sandbox(base)
    with open(script_path, "w") as f:
        json.dump(FAUX_SCRIPT, f, indent=2)
    for sandbox in sandboxes.values():
        sandbox["cwd"] = shared_cwd
        sandbox["faux_script"] = script_path
        # The Rust settings loader keys onboarding on `onboardingShown`
        # (the TS sandbox key is `onboardingCompleted`): write both, or a
        # fresh Rust client opens the trace-consent screen and the LEFT
        # goes to its selector instead of the chat editor.
        with open(os.path.join(sandbox["agent"], "settings.json"), "w") as f:
            json.dump({"onboardingCompleted": True, "onboardingShown": True}, f)
    dogfood_sandbox = {
        "home": os.path.join(base, "dogfood", "home"),
        "agent": os.path.join(base, "dogfood", "agent"),
        "tmp": os.path.join(base, "dogfood", "tmp"),
        "cwd": shared_cwd,
        "faux_script": script_path,
    }
    for key in ("home", "agent", "tmp"):
        os.makedirs(dogfood_sandbox[key], exist_ok=True)
    os.makedirs(os.path.join(dogfood_sandbox["agent"], "sessions"), exist_ok=True)
    with open(os.path.join(dogfood_sandbox["agent"], "settings.json"), "w") as f:
        json.dump({"onboardingCompleted": True, "onboardingShown": True}, f)
    sandbox_for = {
        "ts": sandboxes["ts"],
        "rust": sandboxes["rust"],
        "dogfood": dogfood_sandbox,
    }

    all_scenarios = ["left-instant", "left-frame", "left-slow-answer", "wedge-force-quit"]
    scenarios = args.scenarios.split(",") if args.scenarios else all_scenarios

    results = {}
    try:
        for side in sides:
            for label in scenarios:
                policy = {"answer": True, "delay_ms": 0}
                if label == "left-slow-answer":
                    policy = {"answer": True, "delay_ms": 2600}
                wedge = label == "wedge-force-quit"
                facts = run_scenario(side, sandbox_for[side], label, policy, wedge=wedge)
                results[f"{side}:{label}"] = facts
                print(f"[pty] {side} {label}: {json.dumps(facts)[:900]}", flush=True)
    finally:
        if not args.keep:
            subprocess.run(["rm", "-rf", base], check=False)

    failures = []
    for key, facts in results.items():
        side, label = key.split(":")
        if label.startswith("left-"):
            if facts.get("shutdown_stalled"):
                failures.append(f"{key}:forced-exit-on-left")
            if facts.get("alive") is False:
                failures.append(f"{key}:client-died")
        # The wedge stop-set gate holds only for this branch's build:
        # TS has no force-quit watchdog at all (it stays alive), and the
        # dogfood side is the recorded "before" — its missing restore
        # writes are the bug being fixed, not a regression.
        if label == "wedge-force-quit" and side == "rust":
            if facts.get("exit_code") is None:
                failures.append(f"{key}:no-force-quit")
            if facts.get("shutdown_stalled") is not True:
                failures.append(f"{key}:no-stall-message")
            stop = facts.get("stop_set") or {}
            for part in (
                "paste_off",
                "kitty_pop",
                "modify_reset",
                "mouse_off",
                "leave_alt",
                "cursor_show",
            ):
                if stop.get(part) is not True:
                    failures.append(f"{key}:missing-{part}")
            termios_state = facts.get("termios_after") or {}
            if termios_state.get("icanon") is not True or termios_state.get("echo") is not True:
                failures.append(f"{key}:tty-not-cooked")
    for failure in failures:
        print(f"FAIL {failure}")
    print("LEFT-ARROW PTY REPRO:", "RED" if failures else "GREEN")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
