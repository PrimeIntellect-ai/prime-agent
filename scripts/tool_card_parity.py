#!/usr/bin/env python3
"""Tool-call card parity verifier: frame-diff the Rust interactive UI
against the installed TS prime-agent binary across all THREE conversation
detail modes, over a scripted session that exercises the tool-card states:

  - a bash call with enough output to trigger the collapsed preview
    truncation (`... N earlier lines`) and the expanded full output,
  - an ipython cell with multi-line stdout (collapsed summary line, expanded
    code + output rows),
  - an ipython error cell (error marker, ename, traceback treatment).

Both binaries run the same faux provider script (TS via the sandbox
extension, Rust via PRIME_AGENT_FAUX_SCRIPT) under isolated HOME/agent-dir
sandboxes in tmux at 120x36. States captured per binary:
  a_fresh_start, b_collapsed (overview after the turn),
  c_details (Ctrl+O x1), d_all (Ctrl+O x2), plus e_running (the first bash
  card while the spinner is live). Frames are normalized for volatile
  content (versions, session ids, durations, spinners) and diffed; the exit
  code is non-zero when any state differs.

tmux rules: default socket only (`env -u TMUX`), tcparity-* session names,
no kill-server; sessions are killed individually at the end.
"""

import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

SIZES = [("120", "36")]

# One turn: text, a bash call with 12-line output (preview truncation), an
# ipython python cell with 4-line stdout, an ipython error cell, done.
# Content is identical on both sides so frames compare content-for-content.
FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": "faux-1",
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 18,
    "responses": [
        {
            "content": [
                {
                    "type": "thinking",
                    "thinking": "I will run the scripted checks: a bash call, a python cell, then an error cell.",
                },
                {"type": "text", "text": "Running the card checks now."},
                {
                    "type": "toolCall",
                    "name": "bash",
                    "id": "toolu_bash01",
                    # Two seconds of sleep hold the running state long
                    # enough to capture e_running on both sides, then the
                    # 12 lines drive the collapsed-preview truncation.
                    "arguments": {"command": "sleep 2 && seq 1 12"},
                },
            ]
        },
        {
            "content": [
                {"type": "text", "text": "Now the python cell."},
                {
                    "type": "toolCall",
                    "name": "ipython",
                    "id": "toolu_py001",
                    "arguments": {
                        "code": "for i in range(3):\n    print(f'line {i}')\nprint('cell done')"
                    },
                },
            ]
        },
        {
            "content": [
                {"type": "text", "text": "Now the error cell."},
                {
                    "type": "toolCall",
                    "name": "ipython",
                    "id": "toolu_err001",
                    "arguments": {"code": "raise ValueError('boom')"},
                },
            ]
        },
        {"content": [{"type": "text", "text": "All card states shown."}]},
    ],
}

# Shared with visual_parity.py: one extension source for every harness.
TS_FAUX_EXTENSION = open(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "ts_faux_extension.js"),
    encoding="utf-8",
).read()

PROMPT = "Run the card checks."

SPINNER_CHARS = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f\u25f4\u25f7\u25f6\u25f5\u25cb\u25f8\u25fb\u25fc"
# A character class over the spinner glyphs: `re.search(SPINNER_CHARS, ...)`
# would match the literal sequence instead of any single glyph.
SPINNER_CLASS = "[" + SPINNER_CHARS + "]"

STATES = [
    ("a_fresh_start", "fresh splash"),
    ("b_collapsed", "overview after the scripted turn"),
    ("c_details", "details mode (Ctrl+O once)"),
    ("d_all", "all mode (Ctrl+O twice)"),
    # The running state is momentary on both sides (the harness captures
    # it opportunistically); compared only when both frames exist.
    ("e_running", "the first bash card while the turn is live"),
]


def tmux(*args, check=True):
    result = subprocess.run(["env", "-u", "TMUX", "tmux", *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def capture(session):
    return tmux("capture-pane", "-e", "-p", "-t", session)


def capture_plain(session):
    return tmux("capture-pane", "-p", "-t", session)


def normalize(frame, root):
    frame = frame.replace(root, "<SANDBOX>")
    frame = re.sub(r"v\d+\.\d+\.\d+", "vX.X.X", frame)
    frame = re.sub(r"\b[0-9a-f]{12}\b", "<SID>", frame)
    frame = re.sub(r"\b\d+(\.\d+)?(ms|s)\b", "<T>", frame)
    frame = re.sub(r"\d+(\.\d+)?[kM]? \(\d+%\)", "<TOK> (<PCT>)", frame)
    frame = re.sub(r"[\u2193\u2191] [\d.kM]+ tokens", "<DIR> <TOK> tokens", frame)
    frame = re.sub(r"\b\d+s\b", "<S>", frame)
    spinners = "".join("\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f")
    frame = re.sub("[" + spinners + "]", "<SPIN>", frame)
    pulses = "".join("\u25f4\u25f7\u25f6\u25f5\u25cb\u25f8\u25fb\u25fc")
    frame = re.sub("[" + pulses + "]", "<PULSE>", frame)
    # tmux places trailing resets (foreground 39m, background 49m) at either
    # the end of the row whose styled text just ended or before the next
    # row's default margin; both describe default cells, so drop them.
    frame = re.sub("\x1b\[39m\n", "\n", frame)
    frame = re.sub("\n\x1b\[39m(?= )", "\n", frame)
    frame = re.sub("\x1b\[49m\n", "\n", frame)
    frame = re.sub("\n\x1b\[49m(?= )", "\n", frame)
    # The tray right side is right-aligned against differing token counts;
    # collapse the alignment padding so the row compares by content.
    frame = re.sub(
        r" +((?:\x1b\[[0-9;]*m)*(?:faux-1 \u00b7 )?<TOK> \(<PCT>\)\s*)$",
        r" <TRAY-RIGHT>\1",
        frame,
        flags=re.MULTILINE,
    )
    return frame


def diff_lines(left, right):
    return "\n".join(
        difflib.unified_diff(left.split("\n"), right.split("\n"), fromfile="ts", tofile="rust", lineterm="", n=1)
    )


def find_runtime_package_dir():
    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    if not os.path.isdir(releases):
        raise SystemExit("cannot find the prime-agent-runtime sidecar; set PI_PACKAGE_DIR")
    candidates = [
        entry
        for entry in sorted(os.listdir(releases))
        if os.path.isdir(os.path.join(releases, entry, "prime-agent-runtime"))
    ]
    if not candidates:
        raise SystemExit("no release with prime-agent-runtime/ under " + releases)
    return os.path.join(releases, candidates[-1])


def prepare_sandbox(base):
    shared_cwd = os.path.join(base, "shared-cwd")
    os.makedirs(shared_cwd, exist_ok=True)
    script_path = os.path.join(base, "faux-script.json")
    with open(script_path, "w") as f:
        json.dump(FAUX_SCRIPT, f, indent=2)
    sandboxes = {}
    for binary in ("ts", "rust"):
        home = os.path.join(base, binary, "home")
        agent = os.path.join(base, binary, "agent")
        tmp = os.path.join(base, binary, "tmp")
        os.makedirs(home, exist_ok=True)
        os.makedirs(tmp, exist_ok=True)
        os.makedirs(os.path.join(agent, "extensions"), exist_ok=True)
        os.makedirs(os.path.join(agent, "sessions"), exist_ok=True)
        with open(os.path.join(agent, "settings.json"), "w") as f:
            json.dump({"onboardingCompleted": True}, f)
        # The isolated TMPDIR keeps the TS supervisor's socket (the
        # default daemon-socket dir) off the shared box root, so the
        # cleanup reap can sweep this side's daemons by path alone.
        sandboxes[binary] = {"home": home, "agent": agent, "tmp": tmp}
    with open(os.path.join(sandboxes["ts"]["agent"], "extensions", "tool-card-faux.js"), "w") as f:
        f.write(TS_FAUX_EXTENSION)
    return shared_cwd, script_path, sandboxes


def wait_for(session, needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in capture_plain(session):
            return
        time.sleep(0.3)
    raise TimeoutError(f"session {session} never showed {needle!r}")


def run_session(binary, sandbox, shared_cwd, script_path, size, out_dir):
    width, height = size
    session = f"tcparity-{binary}-{width}x{height}"
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", width, "-y", height, "-c", shared_cwd)
    env = (
        f"HOME={sandbox['home']} "
        f"TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
        f"PRIME_AGENT_FAUX_SCRIPT={script_path} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    if binary == "ts":
        command = (
            f"prime-agent --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model faux-1"
        )
    else:
        rust = os.environ.get(
            "PA_RUST_BINARY",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "prime-agent"),
        )
        package_dir = os.environ.get("PI_PACKAGE_DIR") or find_runtime_package_dir()
        command = (
            f"PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model faux-1"
        )
    tmux("send-keys", "-t", session, f"{env} {command}", "Enter")

    frames = {}
    wait_for(session, "Collapsed mode", timeout=40)
    time.sleep(1.0)
    frames["a_fresh_start"] = capture(session)

    tmux("send-keys", "-t", session, PROMPT)
    tmux("send-keys", "-t", session, "Enter")

    # First bash card runs while the turn is live (running marker).
    deadline = time.time() + 60
    while time.time() < deadline:
        pane = capture_plain(session)
        if "card checks now" in pane and "running" in pane:
            frames["e_running"] = capture(session)
            break
        time.sleep(0.1)

    # The Rust kernel bootstrap (cold uv cache in the sandbox) can hold a
    # turn open for over a minute, so the settle window is generous.
    deadline = time.time() + 300
    while time.time() < deadline:
        pane = capture_plain(session)
        if "All card states shown." in pane and not re.search(SPINNER_CLASS, pane):
            break
        time.sleep(0.5)
    time.sleep(1.0)
    # The settle poll can race a spinner frame: re-check before capturing.
    for _ in range(20):
        if not re.search(SPINNER_CLASS, capture_plain(session)):
            break
        time.sleep(0.5)
    frames["b_collapsed"] = capture(session)

    # Ctrl+O once: details mode.
    tmux("send-keys", "-t", session, "C-o")
    try:
        wait_for(session, "Details mode", timeout=10)
    except TimeoutError:
        pass
    time.sleep(1.0)
    frames["c_details"] = capture(session)

    # Ctrl+O twice: all mode (expanded).
    tmux("send-keys", "-t", session, "C-o")
    try:
        wait_for(session, "Expanded mode", timeout=10)
    except TimeoutError:
        pass
    time.sleep(1.0)
    frames["d_all"] = capture(session)

    tmux("send-keys", "-t", session, "C-c")
    time.sleep(0.5)
    tmux("send-keys", "-t", session, "C-c")
    time.sleep(1.0)
    tmux("kill-session", "-t", session, check=False)

    os.makedirs(out_dir, exist_ok=True)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"{binary}-{state}-{width}x{height}.txt"), "w") as f:
            f.write(frame)
    return frames


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", default=",".join(f"{w}x{h}" for w, h in SIZES))
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--out", default=None)
    parser.add_argument("--only", default=None, choices=["ts", "rust"])
    args = parser.parse_args()
    sizes = [tuple(entry.split("x")) for entry in args.sizes.split(",")]

    # Fail fast before any launch: a non-TS `prime-agent` on PATH plays a
    # Rust build as the "ts" side and reports false divergences.
    if args.only in (None, "ts"):
        ts_identity.assert_ts_side_is_the_ts_product()

    base = tempfile.mkdtemp(prefix="tool-card-parity-")
    out_dir = args.out or tempfile.mkdtemp(prefix="tool-card-captures-")
    shared_cwd, script_path, sandboxes = prepare_sandbox(base)
    failures = []
    try:
        if args.only:
            run_session(args.only, sandboxes[args.only], shared_cwd, script_path, sizes[0], out_dir)
            print(f"captures for {args.only} in {out_dir}")
            return 0
        for size in sizes:
            ts_frames = run_session("ts", sandboxes["ts"], shared_cwd, script_path, size, out_dir)
            rust_frames = run_session("rust", sandboxes["rust"], shared_cwd, script_path, size, out_dir)
            for state, _ in STATES:
                if state not in ts_frames or state not in rust_frames:
                    continue
                ts_norm = normalize(ts_frames[state], base)
                rust_norm = normalize(rust_frames[state], base)
                name = f"{state}-{size[0]}x{size[1]}"
                if ts_norm == rust_norm:
                    print(f"PASS {name}")
                else:
                    print(f"FAIL {name}")
                    report = os.path.join(out_dir, f"diff-{name}.txt")
                    with open(report, "w") as f:
                        f.write(diff_lines(ts_norm, rust_norm))
                    print(f"  diff: {report}")
                    failures.append(name)
    finally:
        # Rmtree alone leaks the scenario daemons (a killed TUI pane does
        # not take its detached daemon/supervisor pair down; #223): sweep
        # every daemon this run spawned before deleting the sandbox.
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)
    if failures:
        print(f"{len(failures)} state(s) differ; captures in {out_dir}")
        return 1
    print(f"all states match; captures in {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
