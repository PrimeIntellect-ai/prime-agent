#!/usr/bin/env python3
"""The TUI exit-path terminal restoration battery (tmux e2e).

Kevin's live report (the paper-cut family): exiting the TUI can leave the
terminal broken three ways — the alternate screen still on (the shell
prompt renders inside the dead TUI frame, "the old TUI above it"), the tty
raw ("escape codes while typing"), and enhancement modes left armed
(kitty CSI-u / SGR mouse reports leaking into the shell). This battery
kills the TUI through every exit path on a REAL terminal (an isolated tmux
server, plain bash in the pane) and asserts the three invariants of a
whole terminal:

  (i)   the alternate screen is left — `#{alternate_on}` is 0 after the
        process exits (and 1 while the TUI runs, the vacuity gate);
  (ii)  the tty is cooked — the pane shell's `stty -g` after the exit
        matches the pre-launch capture (for the poisoned-start scenario,
        the sane baseline captured before anything ran);
  (iii) no escape bytes leak — typing `echo <literal>` into the shell
        after the exit echoes the literal line (no CSI/kitty/mouse
        sequences interleaved, `capture-pane -e`).

Scenarios (each runs against its own daemon socket + sandbox + tmux
server):

- `quit`: the canonical exit — Ctrl+C pair (hint, then exit) on a settled
  chat. The flushed inline transcript above the prompt is TS parity
  (`TUI.stop`'s exitFullscreen flush), not a failure.
- `quit-slash`: `/quit`.
- `agents-exit`: the agents view (`--resume` bare) exits via its own
  Ctrl+C pair — the view's teardown owns the same restore.
- `error-exit`: the worker is SIGSTOPped mid-session, then a prompt is
  submitted into it — the parked request's bound is the fatal error the
  loop propagates; the exit must still hand the terminal back whole.
- `wedge`: the worker stays stopped and the parked double Ctrl+C fires
  the force-quit watchdog — the exit-within-2s contract.
- `poisoned`: the shell enters `stty raw -echo` (a previous run's broken
  exit) BEFORE the launch; a normal quit must still end cooked — the
  crossterm saved-original is poisoned, so only the exit's cooked-tty
  verification/repair can fix it.
- `panic` (rust sides only): `pa-tui-replay --panic-exit` panics mid-loop
  — the unwind restore must still fire and the process must die 101.

Sides: `ts` (the deployed TS release binary), `rust` (the branch build),
`before` (the recorded pre-fix build, failures recorded not gated). The
rust-only mechanical paths (error-exit / wedge / panic) run rust sides;
the TS side runs the visible-shell-state paths it owns the same contract
for (its exits must leave the shell whole too). The force-quit watchdog
itself is a rust-only port surface (TS has no watchdog — its own loop
exit handles the pair).

Usage:
  scripts/tui_exit_restore_parity.py --sides ts,rust \
      --rust-bin target/release/prime-agent --out runs/exits
  scripts/tui_exit_restore_parity.py --sides rust --scenarios quit,poisoned

Requires tmux + a POSIX shell; the worker-pid discovery reads /proc
(Linux). On non-Linux the worker scenarios are skipped (the VM runs them).
"""

import argparse
import glob
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import visual_parity as vp  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import ts_identity  # noqa: E402

SIZE = (120, 36)

#: The deployed TS release binary (parity side).
_release_glob = os.path.expanduser(
    "~/.local/share/prime-agent/releases/0.9.5-linux-x64-*/prime-agent"
)
_release_hits = sorted(glob.glob(_release_glob))
TS_BIN = os.environ.get("TS_BIN") or (_release_hits[-1] if _release_hits else "prime-agent")
RUST_BIN = os.environ.get(
    "PA_RUST_BINARY",
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "target", "release", "prime-agent"
    ),
)
REPLAY_BIN = os.environ.get("PA_REPLAY_BINARY")

#: The chat-settle needle (side-agnostic: the TS detail hint reads
#: "Details mode", the rust port "Collapsed mode", both carry the key
#: hint) and the agents-view roster surface needle.
CHAT_SETTLE = "Ctrl+O to expand"
AGENTS_VIEW_NEEDLE = " idle, "
RESUME_HINT_NEEDLE = "Resume this session with"

#: The worker-role marker in a daemon worker's environment (this sandbox's
#: own processes only — matched with the sandbox agent dir, never a bare
#: pattern; other daemons on the box are untouched).
WORKER_ROLE_MARKER = b"PRIME_AGENT_INTERNAL_DAEMON_WORKER=1"

#: How long a parked UI request takes to hit its bound and exit fatally
#: (the error-exit scenario waits for the shell prompt on this budget).
ERROR_EXIT_WAIT_S = 90

FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": "faux-1",
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 18,
    "responses": [{"text": "exit restore reply"}],
}


def side_binary(side):
    if side == "ts":
        return TS_BIN
    if side == "before":
        return os.environ.get("PA_BEFORE_BINARY", RUST_BIN)
    return RUST_BIN


class TmuxServer:
    """One isolated tmux server (`-L` socket): the shell pane host.

    An isolated server (never the shared/default one) keeps the exit
    battery off any ambient tmux configuration (a global default-shell
    wrapper, session hooks) and lets the harness kill the whole server
    per scenario.
    """

    def __init__(self, tag):
        self.socket = f"exitrestore-{os.getpid()}-{tag}"
        self.session = "s"
        subprocess.run(["tmux", "-L", self.socket, "kill-server"], capture_output=True)

    def run(self, *args, timeout=60, check=False):
        proc = subprocess.run(
            ["tmux", "-L", self.socket, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if check and proc.returncode != 0:
            raise RuntimeError(
                f"tmux {' '.join(args[:4])} failed: {proc.returncode} {proc.stderr.strip()}"
            )
        return proc

    def new_session(self, cwd):
        self.run(
            "new-session",
            "-d",
            "-s",
            self.session,
            "-x",
            str(SIZE[0]),
            "-y",
            str(SIZE[1]),
            "-c",
            cwd,
            "bash",
            "--noprofile",
            "--norc",
            check=True,
        )

    def send(self, text):
        """Type one line into the pane and submit it with Enter (the
        established harness pattern: a literal string then the Enter
        key)."""
        self.run("send-keys", "-t", self.session, text, "Enter", check=True)

    def send_key(self, key):
        self.run("send-keys", "-t", self.session, key, check=True)

    def capture(self, escapes=False, history=None):
        args = ["capture-pane", "-p", "-t", self.session]
        if escapes:
            args.append("-e")
        if history:
            # tmux `-S` counts from the screen top: negative reaches into
            # the scrollback history above it.
            args.extend(["-S", str(history)])
        return self.run(*args).stdout

    def alternate_on(self):
        return self.run(
            "display-message", "-p", "-t", self.session, "#{alternate_on}"
        ).stdout.strip()

    def kill(self):
        self.run("kill-server")


def shell_prompt_back(server, timeout=20):
    """The client exited: the pane's last non-empty line is the plain
    bash prompt again (bash --noprofile --norc: `bash-<version>$ ` on a
    user shell, `bash-<version># ` when the pane shell runs as root —
    the VM harnesses do; the flushed exit frame may sit above it and
    trailing blank rows below — the exit frame flush is TS parity, not
    a failure)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = server.capture()
        lines = [line.strip() for line in text.splitlines()]
        while lines and not lines[-1]:
            lines.pop()
        if lines and re.match(r"^bash-[\d.]+[#$] ?$", lines[-1]):
            return True
        time.sleep(0.2)
    return False


def stty_state(server, marker, timeout=15):
    """The pane shell's tty state as one comparable token: the POSIX
    `cksum` of `stty -g`'s output (macOS prints the `gfmt1:` key=value
    form and wraps; Linux a colon-hex blob — the cksum compares either).
    """
    server.send(f"echo {marker} && stty -g | cksum")
    deadline = time.time() + timeout
    seen_marker = False
    while time.time() < deadline:
        text = server.capture()
        if marker in text:
            seen_marker = True
        if seen_marker:
            for line in text.splitlines():
                match = re.search(r"\b(\d+ \d+)$", line.strip())
                if match:
                    return match.group(1)
        time.sleep(0.2)
    return None


def typed_clean(server, timeout=15):
    """(iii) the leak check: type a literal line into the shell; the echo
    must contain the literal text with no escape bytes."""
    server.send("echo LITCHECK_OK_7f3a")
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = server.capture(escapes=True)
        if "LITCHECK_OK_7f3a" in text:
            return text
        time.sleep(0.2)
    return None


def typed_line_clean(capture_text):
    """The echoed command line must be literal: after stripping tmux's
    OSC 8 hyperlink wrappers (the pane's own rendering, not a leak), the
    line must contain no escape bytes at all — a kitty CSI-u report, an
    SGR mouse report, or a paste marker inside the echoed input is the
    leak the scenario exists to catch (stripping CSI classes before the
    check would hide exactly those)."""
    for line in capture_text.splitlines():
        if "echo LITCHECK_OK_7f3a" not in line:
            continue
        stripped = re.sub(r"\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)", "", line)
        return "\x1b" not in stripped
    return False


def launch_command(side, sandbox, socket_path, extra_args):
    env = (
        f"HOME={sandbox['home']} "
        f"TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
        f"PRIME_AGENT_FAUX_SCRIPT={sandbox['faux_script']} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    if side in ("rust", "before"):
        package_dir = os.environ.get("PI_PACKAGE_DIR") or vp.find_runtime_package_dir()
        env += f" PI_PACKAGE_DIR={package_dir}"
    command = (
        f"{env} {side_binary(side)} --daemon-socket {socket_path} "
        f"--model {vp.TS_SCRIPT_MODEL}"
    )
    if extra_args:
        command += " " + " ".join(extra_args)
    return command


def wait_settle(server, needle=CHAT_SETTLE, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in server.capture():
            return True
        time.sleep(0.3)
    return False


def sandbox_worker_pids(sandbox):
    """This sandbox's daemon worker processes (Linux /proc; the VM runs
    the worker scenarios)."""
    if not os.path.isdir("/proc"):
        return []
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


def daemon_pids_for(socket_path):
    if not os.path.isdir("/proc"):
        return []
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


def ensure_replay_fixture(sandbox):
    """A session jsonl for the replay binary: reuse one produced by the
    earlier scenarios (each run leaves a session in the sandbox agent
    dir), else a minimal fixture in the HOME the binary reads."""
    home_sessions = os.path.join(sandbox["home"], ".prime", "agent", "sessions")
    os.makedirs(home_sessions, exist_ok=True)
    sessions = sorted(glob.glob(os.path.join(sandbox["agent"], "sessions", "*.jsonl")))
    if sessions:
        target = os.path.join(home_sessions, "replay-fixture.jsonl")
        with open(sessions[-1], "rb") as src, open(target, "wb") as dst:
            dst.write(src.read())
        return target
    fixture = os.path.join(home_sessions, "replay-fixture.jsonl")
    if os.path.exists(fixture):
        return fixture
    header = {
        "type": "session",
        "sessionId": "fixture-1",
        "createdAt": "2026-09-23T00:00:00.000Z",
        "version": 1,
        "title": "fixture",
    }
    user = {
        "type": "message",
        "message": {"role": "user", "content": "hello replay"},
        "timestamp": "2026-09-23T00:00:01.000Z",
    }
    assistant = {
        "type": "message",
        "message": {"role": "assistant", "content": "replay reply"},
        "timestamp": "2026-09-23T00:00:02.000Z",
    }
    with open(fixture, "w") as f:
        for entry in (header, user, assistant):
            f.write(json.dumps(entry) + "\n")
    return fixture


def run_scenario(side, sandbox, label, out_dir):
    """One side x scenario: fresh socket + tmux server + pane.

    The launch is ONE shell line ending in the exit probes (`echo
    EXITCODE` + `stty -g > file` + its cksum): the probes run the moment
    the client exits, BEFORE the shell's line editor touches the tty
    again — so the captured state is exactly what the exit restore left,
    not what readline healed. (A standalone post-exit `stty` probe would
    read the shell's healed state and mask a raw leak.)
    """
    socket_path = os.path.join(sandbox["agent"], f"daemon-{label}-{side}.sock")
    if os.path.exists(socket_path):
        os.unlink(socket_path)
    server = TmuxServer(f"{label}-{side}")
    facts = {"side": side, "scenario": label}
    stopped_workers = []
    try:
        server.new_session(sandbox["cwd"])
        time.sleep(0.5)
        baseline = stty_state(server, "BASELINE_MARKER")
        facts["stty_baseline"] = baseline
        # The probe state file lives under the scenario's own sandbox tmp
        # (a per-scenario name): concurrent invocations of the harness must
        # never checksum another scenario's terminal state.
        probe_path = os.path.join(sandbox["tmp"], f"tty_after_exit-{label}-{side}")
        probe = (
            " ; printf 'EXITCODE:%s\\r\\n' \"$?\""
            f" ; stty -g > {probe_path}"
            " ; printf 'TTYCK:%s\\r\\n' \"$(cksum < " + probe_path + ")\""
            # The canonical-mode marker: a poisoned start ends in the
            # cooked-tty REPAIR, whose `stty sane` reconstruction is cooked
            # but not byte-identical to the pre-poison baseline — the mode
            # is the invariant there, the exact state everywhere else.
            " ; if stty -a | grep -q ' -icanon'; then printf 'TTYMODE:raw\\r\\n';"
            " else printf 'TTYMODE:cooked\\r\\n'; fi"
        )
        if label == "panic":
            # The replay surface panics mid-loop (rust sides only).
            session_fixture = ensure_replay_fixture(sandbox)
            replay = REPLAY_BIN or os.path.join(
                os.path.dirname(os.path.abspath(side_binary(side))), "pa-tui-replay"
            )
            server.send(f"{replay} --panic-exit {session_fixture}{probe}")
            facts["panic_exited"] = shell_prompt_back(server, timeout=25)
        else:
            extra_args = ["--resume"] if label == "agents-exit" else []
            poison = "stty raw -echo ; " if label == "poisoned" else ""
            command = launch_command(side, sandbox, socket_path, extra_args)
            server.send(f"{poison}{command}{probe}")
            needle = AGENTS_VIEW_NEEDLE if label == "agents-exit" else CHAT_SETTLE
            facts["settled"] = wait_settle(server, needle=needle)
            if not facts["settled"]:
                facts["pane_at_timeout"] = server.capture()
                return facts
            facts["alt_on_while_running"] = server.alternate_on()
            if label in ("quit", "agents-exit", "poisoned"):
                server.send_key("C-c")
                time.sleep(0.8)
                server.send_key("C-c")
            elif label == "quit-slash":
                server.send("/quit")
            elif label in ("error-exit", "wedge"):
                workers = sandbox_worker_pids(sandbox)
                facts["workers_found"] = len(workers)
                for pid in workers:
                    os.kill(pid, signal.SIGSTOP)
                stopped_workers.extend(workers)
                server.send("second turn please")
                time.sleep(1.5)
                if label == "wedge":
                    server.send_key("C-c")
                    time.sleep(0.4)
                    server.send_key("C-c")
                    facts["force_exited"] = shell_prompt_back(server, timeout=12)
                else:
                    # The parked request's bound is the fatal exit.
                    facts["error_exited"] = shell_prompt_back(
                        server, timeout=ERROR_EXIT_WAIT_S
                    )
        # The probes and the prompt: parse from the pane once the shell
        # is back (or the timeout passed).
        facts["prompt_back"] = shell_prompt_back(server, timeout=25)
        exit_probe = parse_exit_probe(server.capture(history=-100))
        facts["exit_code"] = exit_probe.get("exit_code")
        facts["tty_cksum"] = exit_probe.get("tty_cksum")
        facts["tty_mode"] = exit_probe.get("tty_mode")
        # (i) the alternate screen is left.
        facts["alternate_on_after"] = server.alternate_on()
        # (ii) the tty is cooked: the exit probe's state matches the sane
        # baseline — except a poisoned start, where the exit's cooked-tty
        # repair rebuilds a `stty sane`-equivalent mode that is cooked but
        # not byte-identical to the pre-poison baseline; the mode is the
        # invariant there.
        if label == "poisoned":
            facts["stty_matches_sane"] = facts["tty_mode"] == "cooked"
        else:
            facts["stty_matches_sane"] = (
                facts["tty_cksum"] is not None and facts["tty_cksum"] == baseline
            )
        # (iii) no escape bytes leak into the typed line.
        leak_text = typed_clean(server)
        facts["typed_visible"] = leak_text is not None
        facts["leak_free"] = typed_line_clean(leak_text) if leak_text is not None else None
        # Evidence: the pane as the user sees it (with history).
        history_text = server.capture(history=-400)
        evidence_path = os.path.join(out_dir, f"{side}-{label}-pane.txt")
        with open(evidence_path, "w") as f:
            f.write(history_text)
        facts["evidence_pane"] = evidence_path
        facts["resume_hint_visible"] = RESUME_HINT_NEEDLE in history_text
        return facts
    finally:
        try:
            server.kill()
        except Exception:
            pass
        for pid in stopped_workers:
            try:
                os.kill(pid, signal.SIGCONT)
            except OSError:
                pass
        kill_daemons(socket_path)


def parse_exit_probe(capture_text):
    """The EXITCODE/TTYCK lines the probe printed (either form survives a
    raw-tty staircase: printf emits explicit CR)."""
    probe = {}
    for line in capture_text.splitlines():
        m = re.search(r"EXITCODE:(-?\d+)", line)
        if m:
            probe["exit_code"] = int(m.group(1))
        m = re.search(r"TTYCK:(\d+ \d+)", line)
        if m:
            probe["tty_cksum"] = m.group(1)
        m = re.search(r"TTYMODE:(raw|cooked)", line)
        if m:
            probe["tty_mode"] = m.group(1)
    return probe


def scenario_runs(side, label):
    """Which scenarios a side runs at all."""
    if label in ("error-exit", "wedge", "panic"):
        return side in ("rust", "before")
    return True


def true_count(facts):
    """A nonzero `workers_found` read: the count arrives as a JSON int or
    a string depending on the capture path; `None` reads as zero."""
    try:
        return int(facts.get("workers_found") or 0) > 0
    except (TypeError, ValueError):
        return False


def gate_facts(key, facts):
    """The failure list for one scenario run (the `before` side records
    its failures as the pre-fix evidence; only ts/rust gate the exit)."""
    failures = []
    label = facts.get("scenario")
    if label != "panic" and facts.get("settled") is not True:
        failures.append(f"{key}:no-settle")
        return failures
    expected_exit = 101 if label == "panic" else (1 if label == "error-exit" else 0)
    if facts.get("exit_code") != expected_exit:
        failures.append(f"{key}:exit-code={facts.get('exit_code')}")
    if label == "panic":
        if facts.get("panic_exited") is not True:
            failures.append(f"{key}:panic-did-not-exit")
    else:
        if facts.get("prompt_back") is not True:
            failures.append(f"{key}:prompt-not-back")
        if str(facts.get("alt_on_while_running")) != "1":
            failures.append(f"{key}:alt-not-on-while-running")
        if label == "wedge":
            # The watchdog contract is the scenario's point: the loop was
            # parked (workers were found and stopped) and the force quit
            # fired — an ordinary quit path or a missed deadline must not
            # pass for it.
            if facts.get("workers_found") is not true_count(facts):
                failures.append(f"{key}:no-workers-to-wedge")
            if facts.get("force_exited") is not True:
                failures.append(f"{key}:force-quit-did-not-fire")
    if facts.get("alternate_on_after") != "0":
        failures.append(f"{key}:alt-on={facts.get('alternate_on_after')}")
    if facts.get("stty_matches_sane") is not True:
        # TS parity note: on the poisoned start, the TS product restores
        # its own captured `wasRaw` (the poisoned raw state) — no
        # cooked-tty verification exists there — so the ts side records
        # the divergence instead of gating (this port's repair is the
        # hardening the scenario drives).
        if facts.get("side") == "ts" and facts.get("scenario") == "poisoned":
            pass
        else:
            failures.append(f"{key}:tty-state={facts.get('tty_cksum')}")
    if facts.get("leak_free") is not True:
        # The TS product restores its captured `wasRaw` on a poisoned
        # start, so the shell's first typed line lands in the broken mode
        # (the recorded "characters eaten / escape leak" divergence —
        # Kevin's live symptom, reproduced on the TS side); the ts side
        # records it, this port's repair owns the fix.
        if facts.get("side") == "ts" and facts.get("scenario") == "poisoned":
            pass
        else:
            failures.append(f"{key}:escape-leak")
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sides", default=None, help="comma list: ts,rust,before")
    parser.add_argument("--scenarios", default=None, help="comma list of scenario labels")
    parser.add_argument("--out", default=None, help="evidence output dir")
    args = parser.parse_args()

    sides = args.sides.split(",") if args.sides else ["ts", "rust"]
    if "ts" in sides:
        # The identity guard gets the binaries THIS run executes: the ts
        # side must be the deployed TS product, checked against the rust
        # build the harness actually drives (not the module default).
        ts_identity.assert_ts_side_is_the_ts_product(ts_bin=TS_BIN, rust_bin=RUST_BIN)
    all_scenarios = [
        "quit",
        "quit-slash",
        "agents-exit",
        "error-exit",
        "wedge",
        "poisoned",
        "panic",
    ]
    scenarios = args.scenarios.split(",") if args.scenarios else all_scenarios

    base = tempfile.mkdtemp(prefix="exit-restore-")
    out_dir = args.out or os.path.join(base, "evidence")
    os.makedirs(out_dir, exist_ok=True)
    print(f"run root: {base}; evidence: {out_dir}", flush=True)

    shared_cwd, script_path, sandboxes = vp.prepare_sandbox(base)
    with open(script_path, "w") as f:
        json.dump(FAUX_SCRIPT, f, indent=2)
    side_sandboxes = {}
    for side in sides:
        if side in sandboxes:
            sandbox = dict(sandboxes[side])
        else:
            sandbox = {
                "home": os.path.join(base, side, "home"),
                "agent": os.path.join(base, side, "agent"),
                "tmp": os.path.join(base, side, "tmp"),
            }
            for key in ("home", "agent", "tmp"):
                os.makedirs(sandbox[key], exist_ok=True)
            os.makedirs(os.path.join(sandbox["agent"], "sessions"), exist_ok=True)
        sandbox["cwd"] = shared_cwd
        sandbox["faux_script"] = script_path
        # Both onboarding keys: the Rust loader keys onboarding on
        # `onboardingShown`, the TS loader on `onboardingCompleted`.
        with open(os.path.join(sandbox["agent"], "settings.json"), "w") as f:
            json.dump({"onboardingCompleted": True, "onboardingShown": True}, f)
        side_sandboxes[side] = sandbox

    results = {}
    try:
        for side in sides:
            for label in scenarios:
                if not scenario_runs(side, label):
                    continue
                if label in ("error-exit", "wedge") and not os.path.isdir("/proc"):
                    print(f"[skip] {side} {label}: /proc unavailable (non-Linux)", flush=True)
                    continue
                facts = run_scenario(side, side_sandboxes[side], label, out_dir)
                results[f"{side}:{label}"] = facts
                print(f"[exit-restore] {side} {label}: {json.dumps(facts)[:900]}", flush=True)
    finally:
        with open(os.path.join(out_dir, "results.json"), "w") as f:
            json.dump(results, f, indent=2)

    gated_failures = []
    recorded = []
    for key, facts in results.items():
        failures = gate_facts(key, facts)
        for failure in failures:
            if facts.get("side") == "before":
                recorded.append(f"RECORDED-BEFORE-FAIL {failure}")
            else:
                gated_failures.append(failure)
    for failure in recorded:
        print(failure)
    for failure in gated_failures:
        print(f"FAIL {failure}")
    print("EXIT-RESTORE TMUX E2E:", "RED" if gated_failures else "GREEN")
    return 1 if gated_failures else 0


if __name__ == "__main__":
    sys.exit(main())
