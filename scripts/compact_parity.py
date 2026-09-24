#!/usr/bin/env python3
"""Compaction-feedback parity verifier: frame-diff the Rust interactive UI
against the installed TS prime-agent binary for the /compact visible
outcome, over one shared faux script under isolated HOME/agent-dir
sandboxes in tmux at 100x30 (the interactive e2e's headless geometry):

  - the fresh-session skip: /compact on a new session shows the durable
    warning row (TS compaction_end errorMessage, warning severity),
  - the in-flight loader: the muted `Compacting context (focus: ...)
    ... (Ctrl+C to cancel)` row while the summarizer streams (TS
    startCompactionLoader),
  - the settled outcome: the `◆ Context compacted` summary row heading the
    rebuilt transcript (TS CompactionSummaryMessageComponent +
    rebuildChatFromMessages), with the compacted-away first turn gone,
  - the expanded block: Ctrl+O twice (overview -> details -> all) swaps the
    collapsed two-line EventSummary for the markdown body plus the dim
    `Compacted from N tokens` metadata row, and the third press re-collapses
    it (TS applyChatExpansion fanning toolOutputExpanded into
    CompactionSummaryMessageComponent).

Both sides run the same token-paced faux provider script; the sandbox
settings.json pins compaction.keepRecentTokens=10 so the kept tail after
the cut is a few rows and the summary row lands on screen in the default
bottom-follow view on both sides (no keybinding-dependent scrolling).
One documented divergence (Kevin/Sebastian directive 2026-09-23, product
improvement BEYOND TS): the expanded compaction block hangs on the branch
grammar — the markdown body carries the dim `╰─ ` gutter on
its first row hanging off the `◆` header, every row after the
four-space continuation indent, the metadata row on the continuation
indent — instead of the TS `ExpandableEventMessage`'s plain one-column
chat inset. The expanded state therefore compares by content, not bytes:
from the `◆ Context compacted` header down, every visible word must match
with whitespace collapsed — the intended divergence is the indentation and
the wrap points it forces, never the summary text itself, so a truncated,
omitted, or changed body fails the run instead of hiding behind the
divergence. The run separately asserts the Rust expanded rows carry the
branch and the TS frames keep the plain-inset baseline; the collapsed
states keep the byte-for-byte frame diff.
Frames are normalized for volatile content (versions, session ids,
durations, spinners) and diffed; the exit code is non-zero when any state
differs.

tmux rules: a private `-L` socket (the shared server's panes inherit the
box daemon env and hijack the Rust side's supervisor socket), cpparity-*
session names on it; the private server dies with the run.
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

SIZES = [("100", "30")]

WIDTH, HEIGHT = SIZES[0]

# One shared faux script (the TS sandbox extension and the Rust
# PRIME_AGENT_FAUX_SCRIPT harness read the same contract): a large first
# turn gives the compactor history to summarize, a small second turn is
# kept intact in full, and the third response is the summarizer's summary,
# padded so the token-paced stream holds the loader on screen long enough
# to capture on both sides.
FILLER = "history " * 600
SUMMARY_CORE = "## Summary\nthe session story of the compacted parity session, told at deliberate length so the token-paced faux stream holds the compaction loader on screen long enough for the harness to capture it on both sides. "
SUMMARY = SUMMARY_CORE + "Padding sentence to pace the stream. " * 18

FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": "faux-1",
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 100,
    "responses": [
        {"text": FILLER},
        {"text": "second turn done, kept intact"},
        {"text": SUMMARY},
    ],
}

# Shared with tool_card_parity.py: one extension source for every harness.
TS_FAUX_EXTENSION = open(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "ts_faux_extension.js"),
    encoding="utf-8",
).read()

# Sandbox settings pin the cut budget: keepRecentTokens=10 keeps only the
# small second turn after the cut, so the rebuilt transcript is a few rows
# and the summary row is visible in the bottom-follow view on both sides.
SETTINGS = {"onboardingCompleted": True, "compaction": {"keepRecentTokens": 10}}

FIRST_PROMPT = "first"
SECOND_PROMPT = "second, and please keep this second parity turn short and intact"
COMPACT_COMMAND = "/compact focus on the goal"

SPINNER_CLASS = "[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f\u25f4\u25f7\u25f6\u25f5\u25cb\u25f8\u25fb\u25fc]"

STATES = [
    # The skip warning on a fresh session (durable warning row).
    ("a_skip_warning", "the fresh-session /compact skip warning"),
    # The in-flight compaction loader (muted spinner + label + cancel hint).
    ("b_loader", "the compaction loader while the summarizer streams"),
    # The settled outcome: summary row heading the rebuilt transcript.
    ("c_post_compact", "the post-compaction rebuilt transcript"),
    # The expanded block: Ctrl+O twice (overview -> details -> all) turns
    # the collapsed `EventSummary` into the markdown body + the dim
    # `Compacted from N tokens` metadata row.
    ("d_expanded", "the summary block expanded by the Ctrl+O detail cycle"),
]


# An isolated tmux server: panes inherit the SERVER's environment, and a
# server started from an agent session carries that agent's environment —
# a herdr `SHELL` auto-launches a live agent in every pane, and a
# `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET` makes the Rust TUI
# attach to a foreign supervisor instead of the harness's own sandbox
# daemon. The private socket plus the scrubbed client environment below
# keep the harness panes self-contained; the server dies with the run.
TMUX_SOCKET = f"compact-parity-{os.getpid()}"


def tmux_client_env():
    """The environment the harness's private tmux server and panes run
    with: this process's environment minus every prime-agent/herdr
    variable, and a plain login shell as the pane default (the first
    installed one; the box has zsh, a bare VM has bash)."""
    env = {key: value for key, value in os.environ.items() if not key.startswith(("PRIME_AGENT_", "HERDR_"))}
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    env["SHELL"] = next(
        (shell for shell in ("/bin/zsh", "/bin/bash") if os.path.exists(shell)),
        "/bin/sh",
    )
    return env


def tmux(*args, check=True):
    result = subprocess.run(
        ["tmux", "-L", TMUX_SOCKET, *args],
        capture_output=True,
        text=True,
        env=tmux_client_env(),
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def capture(session):
    return tmux("capture-pane", "-e", "-p", "-t", session)


def capture_plain(session):
    return tmux("capture-pane", "-p", "-t", session)


def capture_plain_text(frame):
    """Strip ANSI codes so content assertions match the visible text."""
    return re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", frame)


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
    # The TS product's ripgrep notice (a startup environment notice when
    # rg is missing under PI_OFFLINE; the Rust build has no equivalent
    # row yet) is box environment, not transcript parity.
    kept = []
    notice = False
    for line in frame.split("\n"):
        if any(
            needle in line
            for needle in (
                "ripgrep (rg) is an optional search helper",
                "Install it with: brew install ripgrep",
                "Automatic installation was skipped because PI_OFFLINE",
                "and subagents remain available.",
            )
        ):
            # The notice's trailing blank row drops with it (the block
            # is notice + one blank on the TS side).
            notice = True
            continue
        if notice and line.strip() == "":
            notice = False
            continue
        notice = False
        kept.append(line)
    frame = "\n".join(kept)
    pulses = "".join("\u25f4\u25f7\u25f6\u25f5\u25cb\u25f8\u25fb\u25fc")
    frame = re.sub("[" + pulses + "]", "<PULSE>", frame)
    # tmux places trailing resets (foreground 39m, background 49m) at either
    # the end of the row whose styled text just ended or before the next
    # row's default margin; both describe default cells, so drop them.
    frame = re.sub(r"\x1b\[39m\n", "\n", frame)
    frame = re.sub(r"\n\x1b\[39m(?= )", "\n", frame)
    frame = re.sub(r"\x1b\[49m\n", "\n", frame)
    frame = re.sub(r"\n\x1b\[49m(?= )", "\n", frame)
    # The tray right side is right-aligned against differing token counts;
    # collapse the alignment padding so the row compares by content.
    frame = re.sub(
        r" +((?:\x1b\[[0-9;]*m)*(?:faux-1 \u00b7 )?<TOK> \(<PCT>\)\s*)$",
        r" <TRAY-RIGHT>\1",
        frame,
        flags=re.MULTILINE,
    )
    # The expanded block's metadata reports the pre-compaction context size,
    # which each side estimates with its own token counter (the shape and
    # the focus text are the parity claim; the number is per-implementation).
    frame = re.sub(r"Compacted from [0-9,]+ tokens", "Compacted from <N> tokens", frame)
    return frame


def expanded_block_signature(frame):
    """The expanded compaction block's content signature: every visible
    word from the `◆ Context compacted` header down, ANSI-stripped, the
    branch gutter glyphs dropped, whitespace collapsed.

    The expanded state's intended divergence is indentation (the branch
    grammar vs the TS plain inset) plus the wrap points the narrower
    branch content width forces; the block's CONTENT — the heading, the
    summary body, the metadata row, the focus text — must match word for
    word. Comparing by collapsed content is what makes that a real check:
    a byte diff of the diverged block can only fail by design, and
    dropping the block's rows from the comparison would let a truncated
    or changed summary body pass. Rows above the header stay out of the
    signature: the bottom-pinned windows sit at different tops when the
    diverged block's row counts differ (a window artifact, not content),
    and those transcript rows are byte-diffed by the settled
    `c_post_compact` state."""
    plain = capture_plain_text(frame)
    rows = plain.split("\n")
    start = next((i for i, row in enumerate(rows) if "Context compacted" in row), None)
    if start is None:
        return None
    block = "\n".join(rows[start:]).replace("╰─", " ")
    return re.sub(r"\s+", " ", block).strip()


def assert_compaction_branch(ts_expanded, rust_expanded):
    """The carried divergence: the Rust expanded block hangs on the branch
    grammar (`╰─ ` gutter off the `◆` header, the
    four-space continuation indent); the TS binary keeps the plain
    one-column chat inset (the baseline)."""
    gutter = "╰─ "
    assert " " + gutter + "Summary" in rust_expanded, (
        "rust: the expanded heading row missing the branch gutter"
    )
    # The faux summary opens with `## Summary`, so the heading row is
    # the one row the gutter hangs on (the branch grammar's first
    # content row); the story paragraph sits on the continuation indent
    # behind it.
    assert "    the session story" in rust_expanded, (
        "rust: the expanded body missing the continuation indent"
    )
    assert "    Compacted from" in rust_expanded, (
        "rust: the metadata row missing the continuation indent"
    )
    assert " Summary" in ts_expanded, "ts: expanded heading missing (baseline)"
    assert gutter + "Summary" not in ts_expanded, "ts: unexpectedly renders the branch"
    assert " Compacted from" in ts_expanded, "ts: metadata row missing (baseline)"


def align_frame_tops(left, right):
    """Trim the scroll-leak rows a bottom-pinned viewport shows, and only
    those.

    The compared frames are bottom-pinned viewport windows; a row-count
    delta anywhere in the content shifts one window's top over the
    other's — the longer frame's top rows are rows the shorter side
    scrolled off, a window artifact, not a row-shape divergence. The
    bottom is the anchor: the trailing rows are the same pane tail on
    both sides, so a proven common suffix must cover the whole length
    difference before any top row is dropped, and then only the length
    difference itself comes off the longer frame's top. No row is ever
    dropped because it exists somewhere in the other frame — a real
    top-of-screen regression still diffs."""
    left_rows, right_rows = left.split("\n"), right.split("\n")
    n, m = len(left_rows), len(right_rows)
    if n == m:
        return left, right
    longer, shorter = (left_rows, right_rows) if n > m else (right_rows, left_rows)
    delta = abs(n - m)
    # Prove the bottoms correspond: count the longest common suffix.
    suffix = 0
    while suffix < min(n, m) and longer[len(longer) - 1 - suffix] == shorter[len(shorter) - 1 - suffix]:
        suffix += 1
    if suffix < delta:
        # No proven bottom anchor covering the leak: leave both frames
        # whole so the diff surfaces every differing row.
        return left, right
    if n > m:
        return "\n".join(left_rows[delta:]), right
    return left, "\n".join(right_rows[delta:])


def diff_lines(left, right):
    return "\n".join(
        difflib.unified_diff(left.split("\n"), right.split("\n"), fromfile="ts", tofile="rust", lineterm="", n=1)
    )


def diff_words(left, right):
    """A readable report for the content-signature compare: a word-level
    unified diff (the signatures are single collapsed lines)."""
    return "\n".join(
        difflib.unified_diff(
            (left or "").split(), (right or "").split(), fromfile="ts", tofile="rust", lineterm="", n=2
        )
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
            json.dump(SETTINGS, f)
        # The isolated TMPDIR keeps the TS supervisor's socket (the
        # default daemon-socket dir) off the shared box root, so the
        # cleanup reap can sweep this side's daemons by path alone.
        sandboxes[binary] = {"home": home, "agent": agent, "tmp": tmp}
    with open(os.path.join(sandboxes["ts"]["agent"], "extensions", "compact-faux.js"), "w") as f:
        f.write(TS_FAUX_EXTENSION)
    return shared_cwd, script_path, sandboxes


def wait_for(session, needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in capture_plain(session):
            return
        time.sleep(0.3)
    raise TimeoutError(f"session {session} never showed {needle!r}")


def mode_label(session):
    """The conversation-detail label in the prompt-context row
    (Collapsed / Details / Expanded)."""
    match = re.search(r"(Collapsed|Details|Expanded) mode \(Ctrl\+O", capture_plain(session))
    return match.group(1) if match else None


def press_until_mode(session, target, max_presses=4):
    """Ctrl+O until the conversation-detail label reads `target`.

    The two products' resume detail levels differ (the TS resume starts
    at details, the Rust at overview), so fixed press counts desync the
    compared states: drive both sides to the same label instead."""
    for _ in range(max_presses):
        if mode_label(session) == target:
            return True
        tmux("send-keys", "-t", session, "C-o")
        time.sleep(1.2)
    return mode_label(session) == target


# The ts-identity guard (refuse when the PATH `prime-agent` is this repo's
# Rust product) is shared with every PATH-driven parity harness: see
# scripts/battery/ts_identity.py.


def launch(binary, sandbox, shared_cwd, script_path, out_dir):
    """Drive the whole compaction scenario; return the captured states."""
    session = f"cpparity-{binary}-{WIDTH}x{HEIGHT}"
    tmux("kill-session", "-t", session, check=False)
    tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        WIDTH,
        "-y",
        HEIGHT,
        "-c",
        shared_cwd,
        # The scrubbed client environment keeps the pane a plain shell (a
        # herdr `SHELL` auto-launches a live agent in every pane); the
        # explicit opt-out belt-and-braces covers a server started
        # outside the harness with the wrapper still installed.
        "-e",
        "HERDR_PLAIN_SHELL=1",
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
            f"prime-agent --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model faux-1"
        )
    else:
        rust = ts_identity.default_rust_binary()
        package_dir = os.environ.get("PI_PACKAGE_DIR") or find_runtime_package_dir()
        command = (
            f"PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model faux-1"
        )
    tmux("send-keys", "-t", session, f"{env} {command}", "Enter")

    frames = {}
    wait_for(session, "mode (Ctrl+O", timeout=60)
    time.sleep(1.0)
    # Park both sides at Collapsed: the TS resume starts at details, the
    # Rust at overview — fixed press counts desync the compared states.
    if not press_until_mode(session, "Collapsed"):
        raise TimeoutError(f"session {session} never reached Collapsed mode")

    # a_skip_warning: /compact on the fresh session skips (warning row).
    tmux("send-keys", "-t", session, COMPACT_COMMAND.split()[0], "Enter")
    wait_for(session, "too short to compact", timeout=60)
    time.sleep(0.5)
    frames["a_skip_warning"] = capture(session)

    # Grow the session: the first turn streams the big filler.
    tmux("send-keys", "-t", session, FIRST_PROMPT, "Enter")
    wait_for(session, "history history", timeout=180)
    deadline = time.time() + 120
    while time.time() < deadline:
        pane = capture_plain(session)
        if "history history" in pane and not re.search(SPINNER_CLASS, pane):
            break
        time.sleep(0.5)
    time.sleep(1.0)
    # The second turn's reply is short; wait for it to settle.
    tmux("send-keys", "-t", session, SECOND_PROMPT, "Enter")
    deadline = time.time() + 120
    while time.time() < deadline:
        pane = capture_plain(session)
        if "second turn done" in pane and "second, and please keep" in pane and not re.search(SPINNER_CLASS, pane):
            break
        time.sleep(0.5)
    time.sleep(1.0)

    # b_loader: the compaction loader while the summarizer streams (the
    # collapsed pane; Ctrl+O reaches `all` only after the run settles on
    # the Rust side, so this state stays the TS-parity spinner row).
    tmux("send-keys", "-t", session, COMPACT_COMMAND, "Enter")
    deadline = time.time() + 60
    while time.time() < deadline:
        if "Compacting context" in capture_plain(session):
            frames["b_loader"] = capture(session)
            break
        time.sleep(0.05)
    if "b_loader" not in frames:
        raise TimeoutError(f"session {session} never showed the compaction loader")

    # c_post_compact: the summary row heading the rebuilt transcript.
    wait_for(session, "Context compacted", timeout=120)
    time.sleep(1.0)
    for _ in range(20):
        if not re.search(SPINNER_CLASS, capture_plain(session)):
            break
        time.sleep(0.5)
    frames["c_post_compact"] = capture(session)
    # The compacted-away first turn dropped from the rebuilt transcript.
    pane = capture_plain(session)
    if "history history" in pane:
        raise AssertionError("the compacted-away filler still renders post-compaction")

    # d_expanded: the Ctrl+O detail cycle expands the compaction block
    # (TS `applyChatExpansion` fans `toolOutputExpanded` into
    # `CompactionSummaryMessageComponent`); drive to the Expanded label so
    # both sides reach it from wherever their cycle sits.
    if not press_until_mode(session, "Expanded"):
        raise TimeoutError(f"session {session} never reached Expanded mode")
    wait_for(session, "Compacted from", timeout=60)
    time.sleep(1.0)
    for _ in range(20):
        if not re.search(SPINNER_CLASS, capture_plain(session)):
            break
        time.sleep(0.5)
    frames["d_expanded"] = capture(session)
    # The expanded metadata rides below the markdown summary body, and the
    # block collapses again on the cycle back to Collapsed.
    pane = capture_plain(session)
    if "Context compacted" not in pane:
        raise AssertionError("the expanded state lost the compaction header")
    if not press_until_mode(session, "Collapsed"):
        raise TimeoutError(f"session {session} never re-collapsed")
    pane = capture_plain(session)
    if "Compacted from" in pane:
        raise AssertionError("the detail cycle back to Collapsed did not re-collapse the block")

    tmux("send-keys", "-t", session, "C-c")
    time.sleep(0.5)
    tmux("send-keys", "-t", session, "C-c")
    time.sleep(1.0)
    tmux("kill-session", "-t", session, check=False)

    os.makedirs(out_dir, exist_ok=True)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"{binary}-{state}-{WIDTH}x{HEIGHT}.txt"), "w") as f:
            f.write(frame)
    return frames


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--out", default=None)
    parser.add_argument("--only", default=None, choices=["ts", "rust"])
    args = parser.parse_args()

    base = tempfile.mkdtemp(prefix="compact-parity-")
    out_dir = args.out or tempfile.mkdtemp(prefix="compact-captures-")
    shared_cwd, script_path, sandboxes = prepare_sandbox(base)
    failures = []
    try:
        if args.only in (None, "ts"):
            # Fail fast before the scenario: a non-TS `prime-agent` on PATH
            # produces false parity failures (see the guard's docstring).
            ts_identity.assert_ts_side_is_the_ts_product()
        if args.only:
            launch(args.only, sandboxes[args.only], shared_cwd, script_path, out_dir)
            print(f"captures for {args.only} in {out_dir}")
            return 0
        ts_frames = launch("ts", sandboxes["ts"], shared_cwd, script_path, out_dir)
        rust_frames = launch("rust", sandboxes["rust"], shared_cwd, script_path, out_dir)
        if "d_expanded" in ts_frames and "d_expanded" in rust_frames:
            assert_compaction_branch(
                capture_plain_text(ts_frames["d_expanded"]),
                capture_plain_text(rust_frames["d_expanded"]),
            )
        for state, _ in STATES:
            if state not in ts_frames or state not in rust_frames:
                continue
            ts_norm = normalize(ts_frames[state], base)
            rust_norm = normalize(rust_frames[state], base)
            name = f"{state}-{WIDTH}x{HEIGHT}"
            if state == "d_expanded":
                # The expanded block hangs on the branch grammar (the
                # documented divergence): its content is compared, not
                # its bytes — see `expanded_block_signature`.
                ts_sig = expanded_block_signature(ts_norm)
                rust_sig = expanded_block_signature(rust_norm)
                if ts_sig is not None and ts_sig == rust_sig:
                    print(f"PASS {name}")
                else:
                    print(f"FAIL {name}")
                    report = os.path.join(out_dir, f"diff-{name}.txt")
                    with open(report, "w") as f:
                        f.write(diff_words(ts_sig, rust_sig))
                    print(f"  diff: {report}")
                    failures.append(name)
                continue
            ts_norm, rust_norm = align_frame_tops(ts_norm, rust_norm)
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
        # The private tmux server dies with the run (its sessions were
        # killed individually in launch(); this only sweeps the socket).
        tmux("kill-server", check=False)
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
