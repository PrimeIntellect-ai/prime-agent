#!/usr/bin/env python3
"""Interrupt-path parity (TS vs Rust): docs/parity-next-wave.md §3 —
Escape/Ctrl-C/SIGTERM/SIGHUP handling, the abort ladders, and the
no-orphaned-children contract.

Both binaries run the same scripted client (the shared faux provider, tmux
panes, isolated sandboxes) through interrupt states at fixed delays:

- `esc_stream_abort`: Escape during a streaming turn aborts it — the
  aborted assistant row renders, no card keeps a spinner;
- `esc_user_bash_abort`: Escape during a `!sleep 30` run aborts the
  user-bash run — the slot is released (a second `!echo` dispatches
  instead of tripping the already-running guard);
- `side_question_abort`: `/btw` opens the side pane, Escape aborts the
  running side question and closes the pane;
- `double_escape_tree`: a double-Escape on the idle editor opens the
  session tree;
- `ctrl_c_exits`: the first Ctrl+C shows the exit hint, the second press
  leaves the run (the exit code compares equal);
- `sigterm`: SIGTERM to the client exits gracefully (the exit code
  compares equal; TS's handler runs the same shutdown as the exit keys);
- `sighup`: SIGHUP to the client exits 129 through the emergency path
  (no restore writes to the dead terminal);
- `orphan_children`: a bash tool run (`sleep 60` with a marker) is held
  open, then every daemon-side process is SIGTERMed: the session-hosting
  process kills its tracked detached children, so no marker process may
  survive the sweep on either side.

The behavioral needles (each visible fact must hold on both sides) are the
gate; the per-state frame diffs and the normalized durable session rows
are printed as the parity evidence. The wire *commands* the interrupt
ladder emits are asserted command-for-command by the in-repo mock tests
(`crates/pa-tui/tests/interrupt_paths.rs` records the exact ladder); the
tmux harness pins the same ladders through their user-visible outcomes
(the aborted rows, the released slot, the durable `bashExecution`
cancelled rows), because the direct worker-transport upgrade routes live
session traffic around any client-side proxy.

tmux rules: default socket only (`env -u TMUX`), interrupt-* session
names, no kill-server; sessions are killed individually at the end.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import visual_parity as vp  # noqa: E402  (sandbox prep, capture, normalize)

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

SIZE = ("120", "36")

#: The TS-side binary (the deployed TS release; the box PATH `prime-agent`
#: may be a Rust dogfood install of this repo — the shared ts_identity
#: guard refuses that). Point TS_BIN at the installed TS release when it
#: is, exactly like tui_polish_parity.py.
TS_BIN = os.environ.get("TS_BIN", "prime-agent")

# A reply long enough that the 18-tokens-per-second faux stream is still
# mid-flight when the interrupt lands.
LONG_REPLY = (
    "This is the interrupt parity long reply. " * 24
)
SIDE_REPLY = "The side parity answer streams long enough to interrupt. " * 8
# The marker must survive the shell's exec optimization: a bare
# `sleep 60 # marker` lets bash exec sleep directly, dropping the comment
# (and the marker) from the process's command line; a compound command
# keeps the shell alive, so its argv carries the marker until the sweep.
ORPHAN_COMMAND = "sleep 60; echo interrupt-parity-orphan-marker"

FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": "faux-1",
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 18,
    "responses": [
        # 1) the streaming turn the first Escape aborts.
        {"text": LONG_REPLY},
        # 2) the side-question reply (still streaming at the Escape).
        {"text": SIDE_REPLY},
    ],
}

STREAM_PROMPT = "interrupt parity stream turn"
SIDE_PROMPT = "/btw interrupt parity side question"


def visible_text(frame):
    return re.sub("\x1b\[[0-9;]*m", "", frame)


def settled_pane(session):
    """The pane with volatile rows (the exit-hint tray line) filtered, so
    comparisons ignore the hint arming/expiring."""
    pane = visible_text(vp.capture(session, escape=False))
    return "\n".join(
        line for line in pane.split("\n") if "again to exit" not in line
    )


def pane_pid(session):
    return int(vp.tmux("display-message", "-p", "-t", session, "#{pane_pid}").strip())


def child_pids(parent):
    """The direct children of one pid, from /proc (the pane shell's child
    is the client process)."""
    children = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as f:
                fields = f.read().rsplit(")", 1)[1].split()
            if int(fields[1]) == parent:
                children.append(int(entry))
        except (OSError, IndexError, ValueError):
            continue
    return children


def sandbox_processes(base):
    """Every daemon-side process of this sandbox (cmdline or environ
    references the sandbox root): the supervisor, the session worker, and
    whatever else the daemon spawned. The tmux client pane is excluded by
    the caller."""
    root = os.path.realpath(base).encode()
    matches = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as f:
                cmdline = f.read()
            with open(f"/proc/{entry}/environ", "rb") as f:
                environ = f.read()
        except OSError:
            continue
        if root in cmdline or root in environ:
            matches.append(pid)
    return matches


def marker_processes():
    """Every process whose command line carries the orphan marker."""
    result = subprocess.run(
        ["pgrep", "-f", "interrupt-parity-orphan"],
        capture_output=True,
        text=True,
    )
    return [int(pid) for pid in result.stdout.split()]


def start_client(binary, sandbox, shared_cwd, script_path, session, code_path=None):
    """Start the client in a tmux pane. `code_path` wraps the command so
    the pane shell records the client's exit code (the signal-exit states
    read it back)."""
    vp.tmux("kill-session", "-t", session, check=False)
    vp.tmux(
        "new-session", "-d", "-s", session, "-x", SIZE[0], "-y", SIZE[1], "-c", shared_cwd
    )
    env = (
        f"HOME={sandbox['home']} "
        f"TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
        f"PRIME_AGENT_FAUX_SCRIPT={script_path} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    if binary == "ts":
        command = (
            f"{TS_BIN} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model {vp.TS_SCRIPT_MODEL}"
        )
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
        package_dir = os.environ.get("PI_PACKAGE_DIR") or vp.find_runtime_package_dir()
        command = (
            f"PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model {vp.TS_SCRIPT_MODEL}"
        )
    if code_path:
        command = f"{command}; echo $? > {code_path}"
    vp.tmux("send-keys", "-t", session, f"{env} {command}", "Enter")
    vp.wait_for(session, "Collapsed mode", timeout=90)
    # Settle before any typing: the splash chrome paints before the session
    # attach finishes, and keys that land in that window dispatch on a
    # transcript the attach rebuild then wipes (observed on the TS side:
    # the bang held its slot while its row never rendered). Two identical
    # captures a second apart prove the pane is stable.
    deadline = time.time() + 15
    previous = vp.capture(session, escape=False)
    while time.time() < deadline:
        time.sleep(1.0)
        current = vp.capture(session, escape=False)
        if current == previous:
            break
        previous = current


def client_pid(session):
    """The client process under the pane shell (the env-prefixed command
    runs under sh, so the shell's child chain bottoms out at the binary)."""
    pid = pane_pid(session)
    for _ in range(5):
        children = child_pids(pid)
        if not children:
            time.sleep(0.3)
            continue
        # The env-prefix chain may insert wrappers; follow the newest child.
        pid = max(children)
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmdline = f.read()
        if b"--daemon-socket" in cmdline:
            return pid
    raise RuntimeError(f"no client process under pane {session}")


def wait_exit_code(code_path, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(code_path):
            time.sleep(0.2)
            with open(code_path) as f:
                return f.read().strip()
        time.sleep(0.2)
    raise TimeoutError(f"the client never recorded its exit code ({code_path})")


def durable_rows(agent_dir):
    """The interrupt-relevant durable rows, normalized: the aborted
    assistant stop reasons, the recorded user-bash runs with their
    cancelled/excluded flags."""
    rows = []
    sessions = os.path.join(agent_dir, "sessions")
    for name in sorted(os.listdir(sessions)) if os.path.isdir(sessions) else []:
        path = os.path.join(sessions, name)
        if not name.endswith(".jsonl") or not os.path.getsize(path):
            continue
        with open(path) as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                message = entry.get("message", {})
                if not isinstance(message, dict):
                    continue
                if message.get("role") == "assistant" and message.get("stopReason") in (
                    "aborted",
                    "error",
                ):
                    rows.append({"role": "assistant", "stopReason": message["stopReason"]})
                if message.get("role") == "bashExecution":
                    # The orphan sweep's own run is excluded: its settled
                    # row races the worker's exit (the kill and the record
                    # happen in the same teardown), so it is not a stable
                    # comparison. The states session's runs (the aborted
                    # `!sleep 30` and the released-slot echo) are.
                    if message.get("command") == ORPHAN_COMMAND:
                        continue
                    rows.append(
                        {
                            "role": "bashExecution",
                            "command": message.get("command"),
                            "cancelled": message.get("cancelled") is True,
                            "excluded": message.get("excludeFromContext", False) is True,
                        }
                    )
    return rows


def run_states(binary, sandbox, shared_cwd, script_path):
    """Drive one binary through the interrupt states; returns the
    per-state frames, needles, and the durable rows."""
    session = f"interrupt-{binary}"
    frames = {}
    facts = {}
    # The pane shell records the client's exit code (the Ctrl+C pair reads
    # it back in state 5).
    code_path = os.path.join(sandbox["tmp"], "ctrl-c-exit-code")
    if os.path.exists(code_path):
        os.remove(code_path)
    start_client(binary, sandbox, shared_cwd, script_path, session, code_path=code_path)
    try:
        # (1) Escape during a streaming turn aborts it (TS handleEscape arms
        # the repeat and interrupts; the aborted message renders).
        vp.tmux("send-keys", "-t", session, STREAM_PROMPT)
        vp.tmux("send-keys", "-t", session, "Enter")
        # The reply streams for several seconds at 18 tokens/second; the
        # Escape lands mid-stream.
        time.sleep(1.5)
        vp.tmux("send-keys", "-t", session, "Escape")
        deadline = time.time() + 30
        aborted = False
        while time.time() < deadline:
            pane = visible_text(vp.capture(session, escape=False))
            if "aborted" in pane.lower():
                aborted = True
                break
            time.sleep(0.3)
        time.sleep(1.0)
        frames["esc_stream_abort"] = vp.capture(session)
        facts["esc_stream_abort"] = {
            "aborted_row": aborted,
            # The partial streamed content stays rendered under the abort
            # row on both sides (the abort settles the message, it does not
            # erase what already streamed — no content needle here, the
            # amount that streamed before the Escape is timing-dependent).
        }

        # (2) Escape during a user-bash run aborts it and releases the
        # slot: a second `!` command dispatches instead of tripping the
        # already-running guard.
        vp.tmux("send-keys", "-t", session, "!sleep 30", "Enter")
        vp.wait_for(session, "$ sleep 30", timeout=30)
        time.sleep(0.5)
        vp.tmux("send-keys", "-t", session, "Escape")
        time.sleep(2.0)
        # The output needle ("via ok") appears only in the run's output —
        # the typed command never contains it (a needle equal to the typed
        # text would match the editor echo before Enter, a false positive).
        vp.tmux("send-keys", "-t", session, "!echo slot $(echo released) via ok", "Enter")
        deadline = time.time() + 20
        released = False
        while time.time() < deadline:
            pane = visible_text(vp.capture(session, escape=False))
            if "slot released via ok" in pane:
                released = True
                break
            time.sleep(0.3)
        time.sleep(1.0)
        frames["esc_user_bash_abort"] = vp.capture(session)
        facts["esc_user_bash_abort"] = {
            "slot_released": released,
            "guard_sentence": "already running" in visible_text(frames["esc_user_bash_abort"]),
        }

        # (3) `/btw` opens the side pane; Escape aborts the running side
        # question and closes the pane back to the main thread.
        vp.tmux("send-keys", "-t", session, SIDE_PROMPT, "Enter")
        # The side reply is still streaming at the Escape.
        time.sleep(1.5)
        vp.tmux("send-keys", "-t", session, "Escape")
        deadline = time.time() + 30
        side_gone = False
        while time.time() < deadline:
            pane = visible_text(vp.capture(session, escape=False))
            if "side conversation" not in pane and "Side" not in pane:
                side_gone = True
                break
            time.sleep(0.3)
        time.sleep(1.0)
        frames["side_question_abort"] = vp.capture(session)
        facts["side_question_abort"] = {"pane_closed": side_gone}

        # (4) A double-Escape on the idle editor opens the session tree.
        time.sleep(2.6)  # settle past the 2s exit-hint window
        vp.tmux("send-keys", "-t", session, "Escape")
        time.sleep(0.2)
        vp.tmux("send-keys", "-t", session, "Escape")
        time.sleep(1.5)
        frames["double_escape_tree"] = vp.capture(session)
        tree_text = visible_text(frames["double_escape_tree"]).lower()
        facts["double_escape_tree"] = {"tree_open": "branch" in tree_text or "tree" in tree_text}
        # Close the tree (the cancel binding) so the editor owns the pane.
        vp.tmux("send-keys", "-t", session, "Escape")
        time.sleep(1.0)

        # (5) The Ctrl+C pair leaves the run; the pane shell records the
        # exit code (compare it across the sides). The editor must be
        # empty: the exit key ignores a draft.
        vp.tmux("send-keys", "-t", session, "C-c")
        time.sleep(0.3)
        vp.tmux("send-keys", "-t", session, "C-c")
        facts["ctrl_c_exit_code"] = None
        deadline = time.time() + 30
        while time.time() < deadline:
            if os.path.exists(code_path):
                with open(code_path) as f:
                    facts["ctrl_c_exit_code"] = f.read().strip()
                break
            time.sleep(0.3)
        frames["ctrl_c_exit"] = vp.capture(session)
    finally:
        vp.tmux("kill-session", "-t", session, check=False)

    # The orphan run needs a fresh client; its own durable rows and the
    # marker check follow.
    orphan_session = f"interrupt-orphan-{binary}"
    start_client(binary, sandbox, shared_cwd, script_path, orphan_session)
    try:
        # A user-bash run is the daemon-side detached child under test
        # (TS tracks every local bash child; no model turn is involved,
        # so the run starts deterministically).
        vp.tmux("send-keys", "-t", orphan_session, f"!{ORPHAN_COMMAND}", "Enter")
        deadline = time.time() + 60
        orpane = ""
        while time.time() < deadline:
            orpane = visible_text(vp.capture(orphan_session, escape=False))
            if "interrupt-parity-orphan-marker" in orpane:
                break
            time.sleep(0.3)
        else:
            print(f"  [{binary}] the orphan pane never showed the tool row; last pane:")
            print("\n".join(orpane.splitlines()[-25:]))
        # The bash tool run is live: the marker process must exist.
        deadline = time.time() + 20
        markers_before = 0
        while time.time() < deadline:
            markers_before = len(marker_processes())
            if markers_before:
                break
            time.sleep(0.3)
        facts["orphan_running"] = markers_before > 0

        # SIGTERM every daemon-side process of this sandbox (the pane's
        # client excluded): the session-hosting process must kill its
        # tracked detached children on the way out (TS daemon-mode's
        # handler; the Rust worker's handler).
        pane = pane_pid(orphan_session)
        client = client_pid(orphan_session)
        for pid in sandbox_processes(sandbox["agent"]):
            if pid in (os.getpid(), pane, client):
                continue
            subprocess.run(["kill", "-TERM", str(pid)], check=False)
        deadline = time.time() + 10
        while time.time() < deadline:
            if not marker_processes():
                break
            time.sleep(0.3)
        time.sleep(1.0)
        facts["orphaned_children"] = marker_processes()
        time.sleep(2.0)
        facts["durable_rows"] = json.dumps(durable_rows(sandbox["agent"]), indent=1)
    finally:
        vp.tmux("kill-session", "-t", orphan_session, check=False)
    return frames, facts


def run_signal_exit(binary, sandbox, shared_cwd, script_path, signal_name):
    """One fresh client killed by `signal_name` (TERM/HUP): the exit code
    is the contract (SIGTERM graceful: the exit keys' code; SIGHUP: the
    emergency 129)."""
    session = f"interrupt-{signal_name.lower()}-{binary}"
    code_path = os.path.join(sandbox["tmp"], f"{signal_name.lower()}-exit-code")
    if os.path.exists(code_path):
        os.remove(code_path)
    start_client(binary, sandbox, shared_cwd, script_path, session, code_path=code_path)
    try:
        client = client_pid(session)
        time.sleep(1.0)
        subprocess.run(["kill", f"-{signal_name}", str(client)], check=False)
        return wait_exit_code(code_path, timeout=30)
    finally:
        vp.tmux("kill-session", "-t", session, check=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep the sandbox dir")
    parser.add_argument("--out", default=None, help="captures directory")
    args = parser.parse_args()

    ts_identity.assert_ts_side_is_the_ts_product(ts_bin=TS_BIN)

    base = tempfile.mkdtemp(prefix="interrupt-parity-sandbox-")
    print(f"sandbox: {base}")
    out_dir = args.out or tempfile.mkdtemp(prefix="interrupt-parity-captures-")
    os.makedirs(out_dir, exist_ok=True)
    shared_cwd, script_path, sandboxes = vp.prepare_sandbox(base)
    # This lane's own faux script (the interrupt turns).
    with open(script_path, "w") as f:
        json.dump(FAUX_SCRIPT, f, indent=2)
    failures = []
    try:
        os.environ.pop("TMUX", None)
        results = {}
        for binary in ("ts", "rust"):
            frames, facts = run_states(binary, sandboxes[binary], shared_cwd, script_path)
            results[binary] = {"frames": frames, "facts": facts}
            sigterm_code = run_signal_exit(
                binary, sandboxes[binary], shared_cwd, script_path, "TERM"
            )
            sighup_code = run_signal_exit(
                binary, sandboxes[binary], shared_cwd, script_path, "HUP"
            )
            results[binary]["facts"]["sigterm_exit_code"] = sigterm_code
            results[binary]["facts"]["sighup_exit_code"] = sighup_code
            print(f"[parity] {binary}: {json.dumps(results[binary]['facts'])[:400]}")

        # The behavioral needles: each visible fact must hold on both sides.
        def needle(binary, key, field, expect=True):
            value = results[binary]["facts"].get(key, {}).get(field)
            if (value is False) if expect is True else (value != expect):
                failures.append(f"{binary}-{key}-{field}")
                print(f"FAIL {binary} {key}: {field} did not hold (got {value!r})")

        for binary in ("ts", "rust"):
            needle(binary, "esc_stream_abort", "aborted_row")
            needle(binary, "esc_user_bash_abort", "slot_released")
            needle(binary, "esc_user_bash_abort", "guard_sentence", expect=False)
            needle(binary, "side_question_abort", "pane_closed")
            needle(binary, "double_escape_tree", "tree_open")

        for binary in ("ts", "rust"):
            facts = results[binary]["facts"]
            if facts.get("orphan_running") is not True:
                failures.append(f"{binary}-orphan-never-ran")
                print(f"FAIL {binary}: the orphan bash run never started")
            if facts.get("orphaned_children"):
                failures.append(f"{binary}-orphaned-children")
                print(
                    f"FAIL {binary}: children survived the daemon SIGTERM: "
                    f"{facts['orphaned_children']}"
                )
            if facts.get("ctrl_c_exit_code") is None:
                failures.append(f"{binary}-ctrl-c-never-exited")
                print(f"FAIL {binary}: the Ctrl+C pair never left the run")

        # The cross-side contracts: the exit codes and the durable rows.
        if results["ts"]["facts"].get("ctrl_c_exit_code") != results["rust"]["facts"].get(
            "ctrl_c_exit_code"
        ):
            failures.append("exit-code-ctrl-c")
            print(
                "FAIL the Ctrl+C exit codes differ: "
                f"{results['ts']['facts'].get('ctrl_c_exit_code')} vs "
                f"{results['rust']['facts'].get('ctrl_c_exit_code')}"
            )
        # SIGTERM: the Rust port runs the TS-main contract (the handler's
        # `void shutdown()` — the same graceful leave as the exit keys, so
        # exit 0). The deployed TS release (0.9.5) predates interactive
        # mode's signal handler and dies by the default disposition (143);
        # its observed code is recorded as evidence, not compared — parity
        # here is against the TS repo (`interactive-mode.ts`
        # `registerSignalHandlers`), which the 0.9.5 release cannot show.
        if str(results["rust"]["facts"].get("sigterm_exit_code")) != "0":
            failures.append("exit-code-sigterm-rust-graceful")
            print(
                "FAIL the Rust SIGTERM must leave gracefully (exit 0, the "
                "TS-main handler contract), got: "
                f"{results['rust']['facts'].get('sigterm_exit_code')}"
            )
        if str(results["ts"]["facts"].get("sigterm_exit_code")) == "0":
            # The deployed release gained the handler: compare equality then.
            if str(results["ts"]["facts"].get("sigterm_exit_code")) != str(
                results["rust"]["facts"].get("sigterm_exit_code")
            ):
                failures.append("exit-code-sigterm")
                print("FAIL the SIGTERM exit codes differ")
        else:
            print(
                "NOTE the deployed TS release exits "
                f"{results['ts']['facts'].get('sigterm_exit_code')} on SIGTERM "
                "(its build predates the interactive-mode handler; TS main "
                "and the Rust port leave gracefully)"
            )
        if results["ts"]["facts"].get("sighup_exit_code") != results["rust"]["facts"].get(
            "sighup_exit_code"
        ):
            failures.append("exit-code-sighup")
            print(
                "FAIL the SIGHUP exit codes differ: "
                f"{results['ts']['facts'].get('sighup_exit_code')} vs "
                f"{results['rust']['facts'].get('sighup_exit_code')}"
            )
        else:
            # The emergency path's own contract: exit 129 (128 + SIGHUP).
            if str(results["ts"]["facts"].get("sighup_exit_code")) != "129":
                failures.append("sighup-not-129")
                print(
                    "FAIL SIGHUP must exit 129 on both sides, got: "
                    f"{results['ts']['facts'].get('sighup_exit_code')} / "
                    f"{results['rust']['facts'].get('sighup_exit_code')}"
                )
        ts_rows = json.loads(results["ts"]["facts"]["durable_rows"])
        rust_rows = json.loads(results["rust"]["facts"]["durable_rows"])
        if ts_rows != rust_rows:
            failures.append("durable-rows")
            print("FAIL the durable interrupt rows differ:")
            print(f"--- ts ----\n{json.dumps(ts_rows, indent=1)}")
            print(f"--- rust ----\n{json.dumps(rust_rows, indent=1)}")

        # The frame diff per rendered state (the parity evidence).
        for state in (
            "esc_stream_abort",
            "esc_user_bash_abort",
            "side_question_abort",
            "double_escape_tree",
            "ctrl_c_exit",
        ):
            ts_norm = vp.normalize(results["ts"]["frames"][state], base)
            rust_norm = vp.normalize(results["rust"]["frames"][state], base)
            name = f"{state}-{SIZE[0]}x{SIZE[1]}"
            if ts_norm == rust_norm:
                print(f"PASS {name}")
            else:
                report = os.path.join(out_dir, f"diff-{name}.txt")
                with open(report, "w") as f:
                    f.write(vp.diff_lines(ts_norm, rust_norm))
                print(f"DIFF {name} (renderer deviation, see {report})")
        for binary in ("ts", "rust"):
            with open(os.path.join(out_dir, f"facts-{binary}.json"), "w") as f:
                json.dump(results[binary]["facts"], f, indent=1)
            with open(os.path.join(out_dir, f"frames-{binary}.txt"), "w") as f:
                for key, frame in results[binary]["frames"].items():
                    f.write(f"\n===== {key} =====\n{frame}\n")
        print(f"captures in {out_dir}")
        return 1 if failures else 0
    finally:
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if not args.keep:
            subprocess.run(["rm", "-rf", base], check=False)


if __name__ == "__main__":
    sys.exit(main())
