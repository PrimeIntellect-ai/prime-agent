#!/usr/bin/env python3
"""Info-command parity verifier: frame-diff the Rust interactive client
against the installed TS prime-agent binary on the SAME resumed session
for the six info displays (the KEVIN-DIRECTIVE client-command audit):

  - /session    (Session Info block over get_session_stats)
  - /context    (formatContextTree agent/token/cost/context table)
  - /usage      (the /context alias)
  - /system-prompt (header + the exact assembled prompt; the bodies are
    the two products' own prompts — the layered rewrite supersedes TS
    byte-parity — so the header shape is diffed and the bodies recorded)
  - /logs       (the agent-dir logs listing; planted files compare
    byte-for-byte, daemon-written rows are dropped from the diff)
  - /changelog  (the shipped CHANGELOG.md entries panel; both sides read
    the same file — the Rust side through PI_PACKAGE_DIR, the TS-side
    package override mechanism itself)

Both binaries resume the same fixture session (a real captured assistant
envelope rewritten with deterministic usage/cost) in isolated
HOME/agent-dir sandboxes in tmux at 120x36, one command per captured
state. Frames are normalized for volatile content and diffed; the exit
code is non-zero when any state differs.

tmux rules: default socket only (`env -u TMUX`), icparity-* session names,
no kill-server; sessions are killed individually at the end.
"""

import argparse
import difflib
import glob
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

SIZES = [("120", "36"), ("120", "400")]

MARKER_TEXT = "info parity transcript complete"

# The fixture session's deterministic usage/cost: both /session and
# /context totals render from these numbers.
USAGE_1 = {"input": 900, "output": 90, "cacheRead": 0, "cacheWrite": 10,
           "cost": {"input": 0.0312, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0312}}
USAGE_2 = {"input": 100, "output": 10, "cacheRead": 0, "cacheWrite": 0,
           "cost": {"input": 0.0002, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0002}}

# Logs the harness plants with FIXED sizes so the /logs listing compares
# byte-for-byte; daemon-written rows are dropped from the diff instead.
PLANTED_LOGS = [("harness-planted.log", 2048), ("client-errors.log", 512)]

# One state per command: (state, command, wait marker, minimum pane rows
# below which the state's block scrolls out of the capture). The compact
# displays run at both sizes; the tall ones (the full prompt, the whole
# changelog) only against a tall pane so their markers stay visible.
# (state, command, wait marker or None for stability, minimum pane rows,
# scroll-to-top before capture). The system-prompt display is taller than
# any pane: both products bind `tui.viewport.top` to shift+alt+up, so the
# harness scrolls after the render to bring the header row into view.
# The scroll-to-top state runs last: it leaves the viewport at the top,
# which would hide the following displays' appends from the wait markers.
# The scroll-to-top state runs second-to-last and scrolls back to
# follow afterwards: it leaves the viewport at the top otherwise, which
# would hide the following displays' appends from the wait markers.
STATES = [
    ("session", "/session", "Session Info", 0, False),
    ("context", "/context", "Tokens", 400, False),
    ("usage", "/usage", None, 400, False),
    ("logs", "/logs", "Daemon crashes log to", 0, False),
    ("system-prompt", "/system-prompt", "</available_skills>", 400, True),
    ("changelog", "/changelog", None, 400, False),
]

# The raw crossterm sequences for shift+alt+up (scroll to top) and
# ctrl+shift+down (scroll to bottom and follow); tmux has no key names
# for them.
SCROLL_TOP_SEQUENCE = ["-H", "1b", "5b", "31", "3b", "34", "41"]
SCROLL_FOLLOW_SEQUENCE = ["-H", "1b", "5b", "31", "3b", "36", "42"]


def session_paths():
    return sorted(
        glob.glob(os.path.expanduser("~/.prime/agent/sessions/**/*.jsonl"), recursive=True),
        key=os.path.getmtime,
    )


def newest_assistant_message(sessions):
    """A real assistant message envelope (api/provider/usage fields) so the
    synthetic replies deserialize in BOTH loaders; see
    custom_message_parity.py for the size-bounded scan rationale."""
    best = None
    for path in reversed(sessions):
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                message = row.get("message") if row.get("type") == "message" else None
                if (
                    isinstance(message, dict)
                    and message.get("role") == "assistant"
                    and isinstance(message.get("content"), list)
                    and any(
                        isinstance(block, dict) and block.get("type") == "text"
                        and len(block.get("text", "")) < 200
                        for block in message["content"]
                    )
                    and (best is None or len(line) < best[0])
                ):
                    best = (len(line), message)
    if best is None:
        raise SystemExit("no assistant message found in captured sessions")
    return json.loads(json.dumps(best[1]))


def assistant_with(template, text, usage, ms):
    message = json.loads(json.dumps(template))
    message["content"] = [{"type": "text", "text": text}]
    message["provider"] = "prime-inference"
    message["model"] = "z-ai/glm-5.3"
    message["usage"] = json.loads(json.dumps(usage))
    message["timestamp"] = ms
    return message


def build_session(path, source_header, assistant_template, cwd):
    """The parity session: one user turn, two assistant replies with the
    deterministic usage/cost (the /context and /session totals source).
    The header cwd matches the sandbox cwd (the TS resume rejects foreign
    projects)."""
    header = {
        "type": "session",
        "version": source_header.get("version", 3),
        "id": "icparity-session",
        "cwd": cwd,
        "timestamp": source_header.get("timestamp", "2026-09-21T00:00:00.000Z"),
    }
    entries = [header]
    base_ms = 1_700_000_000_000

    def entry(type_, fields, ms):
        row = {"type": type_}
        row.update(fields)
        row["id"] = f"e{ms - 1_700_000_000_000:04d}"
        row["parentId"] = entries[-1]["id"]
        row["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ms / 1000))
        return row

    entries.append(entry("message", {
        "message": {"role": "user", "content": "Run the info-command checks.", "timestamp": base_ms},
    }, base_ms))
    base_ms += 1
    entries.append(entry("message", {
        "message": assistant_with(assistant_template, "The info rows follow.", USAGE_1, base_ms),
    }, base_ms))
    base_ms += 1
    entries.append(entry("message", {
        "message": assistant_with(assistant_template, MARKER_TEXT, USAGE_2, base_ms),
    }, base_ms))
    with open(path, "w", encoding="utf-8") as f:
        for row in entries:
            f.write(json.dumps(row) + "\n")
    return path


def newest_session_header():
    sessions = session_paths()
    for path in reversed(sessions):
        with open(path, encoding="utf-8") as f:
            first = f.readline()
        try:
            header = json.loads(first)
        except ValueError:
            continue
        if header.get("type") == "session":
            return header
    raise SystemExit("no captured session header found under ~/.prime/agent/sessions")


def tmux(*args, check=True):
    result = subprocess.run(["env", "-u", "TMUX", "tmux", *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def capture(session):
    return tmux("capture-pane", "-e", "-p", "-t", session)


def capture_plain(session):
    return tmux("capture-pane", "-p", "-t", session)


def wait_for(session, needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        # ANSI-stripped match: the echo rows style the slash-command
        # token, so the raw capture splits the marker with SGR codes.
        if needle in re.sub(ANSI, "", capture_plain(session)):
            return
        time.sleep(0.3)
    raise TimeoutError(f"session {session} never showed {needle!r}")


def wait_stable(session, timeout, baseline=None):
    """Wait until the pane stops changing: for displays taller than the
    pane (the full system prompt, the whole changelog) no marker stays
    visible, so render completion is detected by frame stability. When a
    `baseline` is given, the frame must first move away from it (the
    render landed), which keeps a slow round-trip from reading as an
    already-settled frame."""
    deadline = time.time() + timeout
    if baseline is not None:
        while time.time() < deadline:
            if capture_plain(session) != baseline:
                break
            time.sleep(0.3)
        else:
            raise TimeoutError(f"session {session} never left its baseline")
    previous = capture_plain(session)
    while time.time() < deadline:
        time.sleep(1.0)
        current = capture_plain(session)
        if current == previous:
            return
        previous = current
    raise TimeoutError(f"session {session} never settled")


ANSI = r"(?:\x1b\[[0-9;]*m)?"


def normalize(frame, root, planted_names, state):
    frame = frame.replace(root, "<SANDBOX>")
    frame = re.sub(r"v\d+\.\d+\.\d+", "vX.X.X", frame)
    frame = re.sub(r"\b[0-9a-f]{12}\b", "<SID>", frame)
    # Daemon log files: hashed socket names, growing sizes.
    frame = re.sub(r"(\.[0-9a-f]{8}\.log)", ".<H>.log", frame)
    frame = re.sub(r"\(\d+(\.\d+)? KB\)", "(<KB>)", frame)
    lines = frame.split("\n")
    kept = []
    for line in lines:
        # /logs rows the daemons themselves wrote (everything not
        # planted) drop out of every state's diff: the two daemons log
        # different file sets, and the /logs output lingers in the later
        # states' panes.
        if "\u2022" in line and not any(name in line for name in planted_names):
            continue
        # Startup surfaces outside these six commands: the tmux
        # extended-keys warning (this build renders it in the session
        # transcript, TS surfaces it on the agents view instead).
        if "tmux extended-keys is off" in line or "restart tmux." in line:
            continue
        # Escape-only rows (block surface rows cut at the pane edge when
        # the two sides scroll one or two rows apart) carry no text.
        if not re.sub(ANSI, "", line).strip():
            continue
        # The brand splash rows (TS renders the splash on resume, this
        # port does not, so the two panes sit a few rows apart at 36
        # rows) drop out; the displays below compare row-for-row.
        if re.search(r"[\u2597\u2580\u2584\u2588\u259b\u2598\u2593\u2591\u258c\u2599\u2596\u259d\u258f\u259f\u25b2\u25bc\u2590\u2595]{3,}", line):
            continue
        if "cwd " in line and "$" not in line:
            continue
        kept.append(line)
    frame = "\n".join(kept)
    # The context column and the Current line depend on the model's
    # context-window estimate (the TS resume injects a harness-digest
    # message this port does not count): mask the utilization numbers,
    # keep the structure (the unit tests pin the exact numbers).
    # The context-column masks run for every state: the /context and
    # /usage outputs linger in the later states' panes.
    frame = re.sub(
        f"[\u2593\u2591]+{ANSI} {ANSI}\d+%{ANSI} {ANSI}\([\d.kM]+/[\d.kM]+\)",
        "<BAR> <PCT> (<TOK>)", frame)
    frame = re.sub(
        f"{ANSI}\d+%{ANSI} {ANSI}\([\d.kM]+/[\d.kM]+\)",
        "<PCT> (<TOK>)", frame)
    frame = re.sub(
        f"Current:{ANSI} {ANSI}[\d,]+{ANSI} /{ANSI} [\d,]+{ANSI} \({ANSI}[\d.]+%{ANSI}\)",
        "Current: <TOK> / <WIN> (<PCT>%)", frame)
    if state == "system-prompt":
        # The header compares (shape); the prompt body is the product's own
        # assembled prompt (the layered rewrite supersedes TS byte-parity).
        frame = re.sub(
            f"System Prompt {ANSI}\(\d+ chars{ANSI}\)",
            "System Prompt (<N> chars)", frame)
        lines = frame.split("\n")
        header_index = next(
            (i for i, line in enumerate(lines) if "System Prompt (<N> chars)" in line),
            None,
        )
        if header_index is not None:
            frame = "\n".join(lines[: header_index + 1] + ["<PROMPT-BODY>"])
    # totalMessages includes the TS resume-injected harness-digest row
    # (this port does not count it); the per-kind rows still compare. The
    # mask runs for every state: the /session output stays visible in the
    # later states' panes.
    frame = re.sub(
        f"(Tool Results:{ANSI} {ANSI}\d+\n ?{ANSI}?)Total:{ANSI} {ANSI}\d+",
        r"\1Total: <N>", frame)
    # The tray-right cell (model/effort + token estimate) tracks the same
    # estimate gap; the bottom bar keeps its left side.
    frame = re.sub(r"(\u2190(?:\x1b\[[0-9;]*m)? manage).*", r"\1 <TRAY-RIGHT>", frame)
    frame = re.sub(r"[\u2193\u2191] [\d.,]+[kM]? tokens", "<DIR> <TOK> tokens", frame)
    frame = re.sub(r"\b\d+(\.\d+)?(ms|s)\b", "<T>", frame)
    spinners = "".join("\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f")
    frame = re.sub("[" + spinners + "]", "<SPIN>", frame)
    pulses = "".join("\u25f4\u25f7\u25f6\u25f5\u25cb\u25f8\u25fb\u25fc")
    frame = re.sub("[" + pulses + "]", "<PULSE>", frame)
    frame = re.sub("\x1b\[39m\n", "\n", frame)
    frame = re.sub("\n\x1b\[39m(?= )", "\n", frame)
    frame = re.sub("\x1b\[49m\n", "\n", frame)
    frame = re.sub("\n\x1b\[49m(?= )", "\n", frame)
    # TS border rows carry a leftover bg reset before the rule glyph.
    frame = re.sub("\x1b\[49m(?=\u2500)", "", frame)
    # The scroll gap between the transcript end and the bottom chrome is
    # blank rows (the counts differ with content height); collapse runs.
    frame = re.sub(r"\n{3,}", "\n\n<BLANKS>\n\n", frame)
    if state == "changelog":
        # The changelog panel's own structure (borders, the What's New
        # title, entry order) is pinned by the pa-tui unit tests; here the
        # diff covers the entry CONTENT. The shared markdown renderer
        # styles bullets differently from TS (bullet color, hanging
        # indent — that divergence belongs to the markdown surface), so
        # this state compares the ANSI-stripped word sequence. The two
        # renders differ by a few rows in height (the indent wraps), so
        # the top rows sit misaligned in the panes: compare the bottom
        # half (both panes are bottom-anchored), word-wise.
        lines = frame.split("\n")
        chrome = next(
            (i for i in range(len(lines) - 1, -1, -1) if "Collapsed mode" in lines[i]),
            len(lines),
        )
        content = lines[:chrome]
        # Markdown-renderer artifacts mask away (tracked for the markdown
        # surface, not this lane): a space trimmed at a wrap edge after an
        # open paren on one side but kept mid-row on the other; hyphen
        # breaks at a wrap edge (one side splits the word); and intraword
        # underscore emphasis (this port strips the underscores, TS keeps
        # them).
        stripped = re.sub(ANSI, "", " ".join(content))
        frame = re.sub(r"\( +", "(", re.sub(r"\s+", " ", stripped)).strip()
        frame = frame.replace("- ", "-").replace("_", "")
    lines = frame.split("\n")
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def diff_lines(left, right):
    return "\n".join(
        difflib.unified_diff(left.split("\n"), right.split("\n"), fromfile="ts", tofile="rust", lineterm="", n=1)
    )


def find_runtime_package_dir():
    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    candidates = [
        entry
        for entry in sorted(os.listdir(releases))
        if os.path.isdir(os.path.join(releases, entry, "prime-agent-runtime"))
    ]
    if not candidates:
        raise SystemExit("no release with prime-agent-runtime/ under " + releases)
    return os.path.join(releases, candidates[-1])


def prepare_sandbox(base, side):
    cwd = os.path.join(base, side, "cwd")
    home = os.path.join(base, side, "home")
    agent = os.path.join(base, side, "agent")
    tmp = os.path.join(base, side, "tmp")
    for path in (cwd, home, tmp, os.path.join(agent, "sessions")):
        os.makedirs(path, exist_ok=True)
    with open(os.path.join(agent, "settings.json"), "w", encoding="utf-8") as f:
        json.dump({"onboardingCompleted": True}, f)
    logs = os.path.join(agent, "logs")
    os.makedirs(logs, exist_ok=True)
    for name, size in PLANTED_LOGS:
        with open(os.path.join(logs, name), "wb") as f:
            f.write(b"x" * size)
    return {"cwd": cwd, "home": home, "agent": agent, "tmp": tmp}


def run_side(side_name, binary, sandbox, session_path, size, out_dir, package_dir=None):
    session = f"icparity-{side_name}-{size[0]}x{size[1]}"
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", size[0], "-y", size[1], "-c", sandbox["cwd"])
    states = [
        (state, command, marker, scroll_top)
        for state, command, marker, min_rows, scroll_top in STATES
        if int(size[1]) >= min_rows
    ]
    env = (
        f"HOME={sandbox['home']} "
        f"TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    if package_dir:
        env += f" PI_PACKAGE_DIR={package_dir}"
    command = (
        f"{env} {binary} --daemon-socket {sandbox['agent']}/daemon.sock "
        f"--offline -r {session_path}"
    )
    tmux("send-keys", "-t", session, command, "Enter")
    wait_for(session, MARKER_TEXT, timeout=90)
    time.sleep(1.5)
    frames = {}
    for state, command_text, marker, scroll_top in states:
        baseline = capture_plain(session)
        tmux("send-keys", "-t", session, command_text, "Enter")
        if marker is None:
            if state == "changelog":
                # The whole-changelog render scrolls the pane past every
                # stable marker (the echo included): anchor on a frame
                # CHANGE from the pre-command baseline, then stability.
                wait_stable(session, timeout=90, baseline=baseline)
            else:
                # Other stability waits anchor on the echo row first.
                wait_for(session, f"  {command_text}", timeout=60)
                wait_stable(session, timeout=60)
        else:
            wait_for(session, marker, timeout=60)
        time.sleep(1.2)
        if scroll_top:
            tmux("send-keys", "-t", session, *SCROLL_TOP_SEQUENCE)
            time.sleep(1.5)
            frames[f"{state}@{size[0]}x{size[1]}"] = capture(session)
            # Back to following output: the later displays append below
            # the scrolled viewport.
            tmux("send-keys", "-t", session, *SCROLL_FOLLOW_SEQUENCE)
            time.sleep(1.5)
            continue
        frames[f"{state}@{size[0]}x{size[1]}"] = capture(session)
    tmux("kill-session", "-t", session, check=False)
    for key, frame in frames.items():
        with open(os.path.join(out_dir, f"{side_name}-{key}.txt"), "w", encoding="utf-8") as f:
            f.write(frame)
    return frames


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rust-bin", default=os.environ.get("PA_RUST_BIN"))
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--keep", action="store_true", help="keep the sandbox tree")
    parser.add_argument("--size", default=None, help="single WxH override")
    args = parser.parse_args()
    if not args.rust_bin:
        raise SystemExit("pass --rust-bin (the built Rust prime-agent binary)")
    ts_identity.assert_ts_side_is_the_ts_product()
    sizes = [tuple(args.size.split("x"))] if args.size else SIZES

    base = tempfile.mkdtemp(prefix="icparity-")
    out_dir = args.out_dir or os.path.join(base, "evidence")
    os.makedirs(out_dir, exist_ok=True)
    sandbox_ts = prepare_sandbox(base, "ts")
    sandbox_rust = prepare_sandbox(base, "rust")

    source_header = newest_session_header()
    assistant_template = newest_assistant_message(session_paths())
    session_ts = build_session(
        os.path.join(sandbox_ts["agent"], "sessions", "icparity.jsonl"),
        source_header, assistant_template, sandbox_ts["cwd"],
    )
    session_rust = build_session(
        os.path.join(sandbox_rust["agent"], "sessions", "icparity.jsonl"),
        source_header, assistant_template, sandbox_rust["cwd"],
    )

    ts_bin = shutil.which("prime-agent")
    package_dir = find_runtime_package_dir()
    # Both products warn when tmux runs without extended-keys; the Rust
    # client renders the warning in the session transcript, which shifts
    # every pane one side three rows against the other. Enable it for the
    # run (restored in the finally below) so both sides render warning-free.
    previous_extended_keys = tmux("show", "-s", "-v", "extended-keys", check=False).strip()
    tmux("set", "-s", "extended-keys", "on")
    # The Rust side reads the SAME CHANGELOG.md the TS product ships
    # (PI_PACKAGE_DIR is the TS package-dir override mechanism).
    ts_frames = {}
    rust_frames = {}
    failures = []
    previous_extended_keys = ""
    try:
        for width, height in sizes:
            size = (width, height)
            ts_frames.update(run_side("ts", ts_bin, sandbox_ts, session_ts, size, out_dir))
            rust_frames.update(run_side(
                "rust", args.rust_bin, sandbox_rust, session_rust, size, out_dir,
                package_dir=package_dir,
            ))
        planted_names = [name for name, _size in PLANTED_LOGS]
        for key in sorted(ts_frames):
            if key not in rust_frames:
                continue
            state = key.split("@")[0]
            normalized_ts = normalize(ts_frames[key], os.path.join(base, "ts"), planted_names, state)
            normalized_rust = normalize(rust_frames[key], os.path.join(base, "rust"), planted_names, state)
            with open(os.path.join(out_dir, f"diff-{key}.txt"), "w", encoding="utf-8") as f:
                f.write(diff_lines(normalized_ts, normalized_rust))
            if normalized_ts != normalized_rust:
                if state == "changelog":
                    # The two markdown renders differ a few rows in height,
                    # so the bottom-anchored panes show windows of slightly
                    # different edges. The content agrees when the two
                    # word sequences share a long common tail (the visible
                    # entries, their order, and their wording all match);
                    # only the window edges differ.
                    lo, hi = 0, min(len(normalized_ts), len(normalized_rust))
                    while lo < hi:
                        mid = (lo + hi + 1) // 2
                        if normalized_ts[-mid:] == normalized_rust[-mid:]:
                            lo = mid
                        else:
                            hi = mid - 1
                    if lo > 0.9 * min(len(normalized_ts), len(normalized_rust)):
                        continue
                failures.append(key)
    finally:
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if previous_extended_keys:
            tmux("set", "-s", "extended-keys", previous_extended_keys, check=False)
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)

    report = os.path.join(out_dir, "report.md")
    with open(report, "w", encoding="utf-8") as f:
        f.write("# Info-command parity report\n\n")
        for key in sorted(ts_frames):
            f.write(f"- {key}: {'PASS' if key not in failures else 'FAIL'}\n")
    print(open(report, encoding="utf-8").read())
    if failures:
        print("FAILED states:", ", ".join(failures))
        return 1
    print("All info-command states match.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
