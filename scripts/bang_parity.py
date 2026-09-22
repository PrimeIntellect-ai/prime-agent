#!/usr/bin/env python3
"""Bash-mode parity: drive the `!`/`!!` chat shortcut against the installed
TS prime-agent binary and the Rust build in tmux, capture the rendered
states, and report both the behavioral needles (present on both sides or
the check fails) and the per-state frame diff as evidence.

States (same inputs on both binaries):

- `bang_run`: `!echo bang-parity-hi` — the bash row mounts, the streamed
  output renders, and the run settles;
- `bangbang_run`: `!!echo excluded-row` — the excluded variant renders the
  same row shape;
- `guard`: a `!sleep 5` run is held open, then a second `!echo second`
  submission must show the already-running guard instead of dispatching
  (verified in the session file too: only the sleep row recorded);
- `bare`: a bare `!` submission is inert — nothing mounts, nothing is
  sent as a prompt (verified in the session file: no new row);
- `session_rows`: the persisted rows — `!` recorded without
  `excludeFromContext` (output joins the model context), `!!` recorded
  with it, and the bare/`!echo second` submissions recorded nothing.

The Rust side renders the run through the reused bash tool card (the
deliberate reuse this lane chose), not the TS BashExecutionComponent
border box, so the frames are expected to differ in styling; the check
pins the visible facts (the `$ command` row, the streamed output, the
guard sentence, the persisted context flags) and prints the full frame
diff per state as the parity-diff evidence.

tmux rules: default socket only (`env -u TMUX`), bang-* session names,
no kill-server; sessions are killed individually at the end.
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
RUN_COMMAND = "echo bang-parity-hi"
EXCLUDED_COMMAND = "echo excluded-row"
SLEEP_COMMAND = "sleep 5"


def start_binary(binary, sandbox, shared_cwd, script_path, session):
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
            f"prime-agent --daemon-socket {sandbox['agent']}/daemon.sock --model {vp.TS_SCRIPT_MODEL}"
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
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock --model {vp.TS_SCRIPT_MODEL}"
        )
    vp.tmux("send-keys", "-t", session, f"{env} {command}", "Enter")
    vp.wait_for(session, "Collapsed mode", timeout=60)


def visible_text(frame):
    return re.sub("\x1b\[[0-9;]*m", "", frame)


def settled_pane(session):
    """The pane with volatile rows (the exit-hint tray line) filtered, so
    inert-action comparisons ignore the hint arming/expiring."""
    pane = visible_text(vp.capture(session, escape=False))
    return "\n".join(
        line for line in pane.split("\n") if "again to exit" not in line
    )


def session_rows(agent_dir):
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
                if isinstance(message, dict) and message.get("role") in (
                    "user",
                    "bashExecution",
                ):
                    rows.append(
                        {
                            "role": message.get("role"),
                            "command": message.get("command"),
                            "text": (message.get("content") or [{}])[0].get("text"),
                            "excluded": message.get("excludeFromContext", False) is True,
                        }
                    )
    return rows


def run_states(binary, sandbox, shared_cwd, script_path):
    session = f"bang-{binary}"
    frames = {}
    start_binary(binary, sandbox, shared_cwd, script_path, session)
    try:
        # `!command`: the row mounts and the run settles. The needle is the
        # mounted `$ command` row (the typed input echoes the same words in
        # the editor before Enter, so the bare words would race the mount).
        vp.tmux("send-keys", "-t", session, f"!{RUN_COMMAND}", "Enter")
        vp.wait_for(session, f"$ {RUN_COMMAND}", timeout=30)
        time.sleep(1.0)
        frames["bang_run"] = vp.capture(session)

        # `!!command`: the excluded variant renders the same row shape.
        vp.tmux("send-keys", "-t", session, f"!!{EXCLUDED_COMMAND}", "Enter")
        vp.wait_for(session, f"$ {EXCLUDED_COMMAND}", timeout=30)
        time.sleep(1.0)
        frames["bangbang_run"] = vp.capture(session)

        # The already-running guard: hold a run open, submit a second one.
        vp.tmux("send-keys", "-t", session, f"!{SLEEP_COMMAND}", "Enter")
        vp.wait_for(session, f"$ {SLEEP_COMMAND}", timeout=30)
        time.sleep(0.5)
        vp.tmux("send-keys", "-t", session, "!echo second", "Enter")
        deadline = time.time() + 20
        guard = False
        while time.time() < deadline:
            pane = visible_text(vp.capture(session, escape=False))
            if "already running" in pane:
                guard = True
                break
            time.sleep(0.2)
        frames["guard"] = vp.capture(session)
        if not guard:
            print(f"  [{binary}] the guard sentence never rendered")
        # Cancel the held run (TS's guard names the clear key) and settle.
        # The exit hint ("Press Ctrl+C again to exit") arms on each press
        # and expires after two seconds, so settle past it before the
        # bare-! comparison frames.
        vp.tmux("send-keys", "-t", session, "C-c")
        time.sleep(2.5)
        vp.tmux("send-keys", "-t", session, "C-c")
        time.sleep(2.5)

        # A bare `!` is inert: nothing mounts, nothing is sent.
        before = settled_pane(session)
        vp.tmux("send-keys", "-t", session, "!", "Enter")
        time.sleep(2.5)
        after = settled_pane(session)
        frames["bare"] = vp.capture(session)
        frames["bare_inert"] = "1" if before == after else ""
        if before != after:
            print(f"  [{binary}] a bare ! changed the frame (should be inert)")
            frames["bare"] += "\n\nBARE NOT INERT\n" + vp.capture(session)

        # One settled model turn: the session store flushes its buffered
        # rows (the TS store appends lazily; a killed daemon would lose
        # them), so the persisted context flags become observable.
        vp.tmux("send-keys", "-t", session, vp.PROMPT, "Enter")
        try:
            vp.wait_for(session, "quick check", timeout=60)
        except TimeoutError:
            print(f"  [{binary}] the flush turn never streamed")
        time.sleep(10)
        frames["session_rows"] = json.dumps(session_rows(sandbox["agent"]), indent=1)
    finally:
        vp.tmux("kill-session", "-t", session, check=False)
    return frames


def needles(binary, frames):
    """The visible facts each state must show."""
    facts = {
        "bang_run": visible_text(frames["bang_run"]),
        "bangbang_run": visible_text(frames["bangbang_run"]),
        "guard": visible_text(frames["guard"]),
    }
    return facts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep the sandbox dir")
    parser.add_argument("--out", default=None, help="captures directory")
    args = parser.parse_args()

    ts_identity.assert_ts_side_is_the_ts_product()

    base = tempfile.mkdtemp(prefix="bang-parity-sandbox-")
    print(f"sandbox: {base}")
    out_dir = args.out or tempfile.mkdtemp(prefix="bang-parity-captures-")
    os.makedirs(out_dir, exist_ok=True)
    shared_cwd, script_path, sandboxes = vp.prepare_sandbox(base)
    failures = []
    try:
        os.environ.pop("TMUX", None)
        ts_frames = run_states("ts", sandboxes["ts"], shared_cwd, script_path)
        rust_frames = run_states("rust", sandboxes["rust"], shared_cwd, script_path)

        # The behavioral needles: each visible fact must hold on both sides.
        for command in (RUN_COMMAND, EXCLUDED_COMMAND):
            for binary, frames in (("ts", ts_frames), ("rust", rust_frames)):
                key = "bang_run" if command == RUN_COMMAND else "bangbang_run"
                if f"$ {command}" not in visible_text(frames[key]):
                    failures.append(f"{binary}-{key}-command-row")
                    print(f"FAIL {binary} {key}: no `$ {command}` row")
                if command.split()[-1] not in visible_text(frames[key]):
                    failures.append(f"{binary}-{key}-output")
                    print(f"FAIL {binary} {key}: the output never rendered")
        for binary, frames in (("ts", ts_frames), ("rust", rust_frames)):
            if "already running" not in visible_text(frames["guard"]):
                failures.append(f"{binary}-guard")
                print(f"FAIL {binary} guard: the guard sentence never rendered")
            if frames.get("bare_inert") != "1":
                failures.append(f"{binary}-bare-inert")
                print(f"FAIL {binary} bare: a bare ! was not inert")

        # The persisted context flags: `!` joins the context, `!!` does not,
        # and the guarded/bare submissions recorded nothing.
        for binary, frames in (("ts", ts_frames), ("rust", rust_frames)):
            rows = json.loads(frames["session_rows"])
            joined = [row for row in rows if row["role"] == "bashExecution" and not row["excluded"]]
            excluded = [row for row in rows if row["excluded"]]
            if not any(row["command"] == RUN_COMMAND for row in joined):
                failures.append(f"{binary}-context-join")
                print(f"FAIL {binary}: the ! run was not recorded into the session context")
            if not any(row["command"] == EXCLUDED_COMMAND for row in excluded):
                failures.append(f"{binary}-context-exclude")
                print(f"FAIL {binary}: the !! run was not recorded excluded")
            second = [row for row in rows if row["role"] == "user" and "second" in (row["text"] or "")]
            if second:
                failures.append(f"{binary}-guarded-not-sent")
                print(f"FAIL {binary}: the guarded submission leaked into the session")

        # The frame diff per rendered state (the parity evidence).
        for state in ("bang_run", "bangbang_run", "guard"):
            ts_norm = vp.normalize(ts_frames[state], base)
            rust_norm = vp.normalize(rust_frames[state], base)
            name = f"{state}-{SIZE[0]}x{SIZE[1]}"
            if ts_norm == rust_norm:
                print(f"PASS {name}")
            else:
                report = os.path.join(out_dir, f"diff-{name}.txt")
                with open(report, "w") as f:
                    f.write(vp.diff_lines(ts_norm, rust_norm))
                print(f"DIFF {name} (renderer deviation, see {report})")
        for state, frames in (
            ("ts", ts_frames),
            ("rust", rust_frames),
        ):
            with open(os.path.join(out_dir, f"frames-{state}.txt"), "w") as f:
                f.write(f"{state} session rows:\n{frames['session_rows']}\n\n")
                for key in ("bang_run", "bangbang_run", "guard", "bare"):
                    f.write(f"\n===== {key} =====\n{frames[key]}\n")
        print(f"captures in {out_dir}")
        return 1 if failures else 0
    finally:
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if not args.keep:
            subprocess.run(["rm", "-rf", base], check=False)


if __name__ == "__main__":
    sys.exit(main())
