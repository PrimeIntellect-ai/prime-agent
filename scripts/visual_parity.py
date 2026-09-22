#!/usr/bin/env python3
"""Interactive TUI visual-parity verifier: frame-diff the Rust interactive
UI against the installed TS prime-agent binary in tmux.

Drives both binaries to the same defined states (fresh start, one turn with a
tool call, a second turn rendering a markdown table and links, thinking
visible via Ctrl+O, the working spinner mid-turn, the mouse-wheel
scroll/follow cycle driven by byte-identical SGR wheel reports, and the
in-app mouse selection: a press-drag-release over rendered transcript
text whose OSC 52 clipboard copy is byte-compared from the pane's raw
output) at 120x36 and 220x50, captures the rendered
panes with escape sequences, normalizes volatile content, and reports
per-state frame diffs. Exit code is non-zero when any state differs.

The TS side is driven through the faux provider registered by a sandbox
extension (the harness equivalent of the test suite's registerFauxProvider
fixtures); the Rust side runs the real agent engine over the same scripted
faux provider through `PRIME_AGENT_FAUX_SCRIPT` ({"engine": "faux", ...}).

tmux rules: default socket only (`env -u TMUX`), vplane-* session names,
no kill-server; sessions are killed individually at the end.
"""

import argparse
import base64
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

TS_SCRIPT_MODEL = "faux-1"
SIZES = [("120", "36"), ("220", "50")]

# The scripted queue both binaries consume, in request order. Turn 1 makes
# two model requests — the response below (thinking, a text block, an ipython
# tool call), then a continuation after the tool result — and turn 2 makes
# one. A toolUse response always consumes the next queued response too, so
# turn 1 takes two scripted responses. Content is identical on both sides so
# the frames compare content-for-content.
# The table/link-bearing turn: exercises the GFM table block (header,
# delimiter row, body rows) and both link forms, including a mixed-width
# CJK cell so column measurement shows up in the frame diff.
TABLE_AND_LINKS_TURN = (
    "Here is the status board:\n"
    "\n"
    "| Task | State | Notes |\n"
    "| --- | --- | --- |\n"
    "| alpha | done | shipped in v1.0 |\n"
    "| beta \u6570\u636e | running | wraps when narrow |\n"
    "| gamma | pending | blocked on upstream |\n"
    "\n"
    "See the [docs](https://example.com/docs) and the [changelog](https://example.com/log)."
)

SECOND_PROMPT = "Show me the status table."

# Turn 1's final answer, served to the post-tool continuation request (the
# daemon re-requests the model after a toolUse response) so state b settles
# on the tool-call card plus this answer.
TURN1_FINAL_ANSWER = "The check printed the expected marker. Anything else?"

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
                    "thinking": "The user wants a quick check. I will run a short Python cell in the persistent kernel and report the result.",
                },
                {"type": "text", "text": "Let me run a quick check."},
                {
                    "type": "toolCall",
                    "name": "ipython",
                    "id": "toolu_visual01",
                    "arguments": {"code": "print('visual parity ok')"},
                },
            ]
        },
        # Turn 1 continuation after the ipython tool result (state b).
        {"content": [{"type": "text", "text": TURN1_FINAL_ANSWER}]},
        # Turn 2: markdown table + links (state e_table_and_links).
        {"content": [{"type": "text", "text": TABLE_AND_LINKS_TURN}]},
    ],
}

# The TS extension registers the faux provider and scripts its responses from
# PRIME_AGENT_FAUX_SCRIPT (mirrors the test-suite registerFauxProvider fixture).
# It also serves the daemon's post-turn dashboard status-line request from a
# canned empty verdict, so a daemon whose status line falls back to the session
# model cannot consume a scripted response and desync the queue.
# Shared with tool_card_parity.py and compact_parity.py: one extension source
# for every harness.
TS_FAUX_EXTENSION = open(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "ts_faux_extension.js"),
    encoding="utf-8",
).read()

PROMPT = "Run a quick check."

# Spinner + working-icon frames (chat.rs LOADER_FRAMES / WORKING_ICON_FRAMES).
SPINNER_CHARS = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f\u25f4\u25f7\u25f6\u25f5\u25cb\u25f8\u25fb\u25fc"
# A character class over the spinner glyphs: `re.search(SPINNER_CHARS, ...)`
# would match the literal sequence instead of any single glyph.
SPINNER_CLASS = "[" + SPINNER_CHARS + "]"


def find_runtime_package_dir():
    """Locate the installed TS release directory (ships prime-agent-runtime)."""
    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    if not os.path.isdir(releases):
        raise SystemExit(
            "cannot find the prime-agent-runtime sidecar; set PI_PACKAGE_DIR "
            "to a directory containing prime-agent-runtime/"
        )
    candidates = [
        entry
        for entry in sorted(os.listdir(releases))
        if os.path.isdir(
            os.path.join(releases, entry, "prime-agent-runtime")
        )
    ]
    if not candidates:
        raise SystemExit(
            "no release with prime-agent-runtime/ under " + releases
        )
    return os.path.join(releases, candidates[-1])


STATES = [
    ("a_fresh_start", "fresh splash with model and cwd lines"),
    ("b_turn_with_tool", "idle after a turn containing a tool-call card"),
    ("e_table_and_links", "idle after a turn rendering a markdown table and links"),
    ("c_thinking_visible", "conversation detail (Ctrl+O): thinking block visible"),
    ("d_spinner", "working loader mid-turn"),
    ("f_tree_pane", "the /tree selector pane over the settled session"),
    ("g_fork_pane", "the /fork user-message selector over the settled session"),
    ("f_kernel_boot", "python-kernel boot: the tool-owned loader note mid-turn"),
    ("h_mouse_scrolled", "mouse wheel-up: SGR reports scroll the transcript off the tail"),
    ("i_mouse_follow", "mouse wheel-down: back at the tail, following resumed"),
    ("j_mouse_selected", "mouse press-drag: the spanned transcript row renders selected"),
    ("k_mouse_copied", "mouse release: the selection cleared, the spanned text copied out"),
    ("l_mouse_copy", "the OSC 52 clipboard sequence the release emitted"),
]

# SGR wheel press reports, the bytes a real terminal emits with ?1002+?1006
# tracking active: ESC [ < 64;10;10 M (wheel up) / 65 (wheel down). tmux
# `send-keys -H` writes the raw bytes into the pane's stdin, so both
# binaries parse the same report stream a terminal mouse would send.
WHEEL_UP_HEX = "1b 5b 3c 36 34 3b 31 30 3b 31 30 4d".split()
WHEEL_DOWN_HEX = "1b 5b 3c 36 35 3b 31 30 3b 31 30 4d".split()

# Wheel turns per scroll state: six ups lift the view eighteen lines off the
# tail (well past one screen of transcript); eight downs over-scroll back so
# the clamp at the bottom is the settled state both sides reach.
MOUSE_WHEEL_UP_TURNS = 6
MOUSE_WHEEL_DOWN_TURNS = 8

# The transcript text the selection states drag across (the second turn's
# answer): located per binary in the rendered pane, dragged from its first
# cell to its last, so the OSC 52 copy is exactly this string.
SELECTION_NEEDLE = "Here is the status board:"


def send_wheel_report(session, report_hex, turns):
    """Send `turns` SGR wheel reports, spaced so each arrives as its own
    read (a merged chunk would coalesce into one input delivery)."""
    for _ in range(turns):
        tmux("send-keys", "-t", session, "-H", *report_hex)
        time.sleep(0.1)


def sgr_hex(sequence):
    """The `send-keys -H` hex form of one raw byte sequence."""
    return [f"{byte:02x}" for byte in sequence.encode("latin1")]


def send_mouse_report(session, sequence):
    """Send one raw SGR mouse report into the pane's stdin."""
    tmux("send-keys", "-t", session, "-H", *sgr_hex(sequence))


def mouse_press(col, row):
    """SGR left-button press at a one-based terminal cell."""
    return f"\x1b[<0;{col};{row}M"


def mouse_drag(col, row):
    """SGR left-button motion (button 0 + the motion bit) — a held drag."""
    return f"\x1b[<32;{col};{row}M"


def mouse_release(col, row):
    """SGR left-button release at a one-based terminal cell."""
    return f"\x1b[<0;{col};{row}m"


def locate_plain(pane_text, needle):
    """The needle's (row, column) in a plain (escape-free) pane capture."""
    for row, line in enumerate(pane_text.split("\n")):
        col = line.find(needle)
        if col >= 0:
            return row, col
    return None


def osc52_copies(raw):
    """The OSC 52 clipboard sequences (ESC ] 52 ; c ; <base64> BEL) a pane's
    raw output stream carried, in order."""
    return re.findall("\x1b\]52;c;([A-Za-z0-9+/=]+)\x07", raw)


def tmux(*args, check=True):
    """Run a tmux command on the default socket (never inside TMUX)."""
    result = subprocess.run(
        ["env", "-u", "TMUX", "tmux", *args],
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def capture(session, escape=True):
    flag = "-e" if escape else "-p"
    return tmux("capture-pane", flag, "-p", "-t", session)


def normalize(frame, root):
    """Normalize volatile content so stable chrome compares equal."""
    frame = frame.replace(root, "<SANDBOX>")
    # Product versions differ between the binaries.
    frame = re.sub(r"v\d+\.\d+\.\d+", "vX.X.X", frame)
    # Session ids (12-hex display ids).
    frame = re.sub(r"\b[0-9a-f]{12}\b", "<SID>", frame)
    # Durations ("2ms", "1.2s", "0.0s").
    frame = re.sub(r"\b\d+(\.\d+)?(ms|s)\b", "<T>", frame)
    # Context usage in the tray: "6.1k (5%)", "72 (0%)".
    frame = re.sub(r"\d+(\.\d+)?[kM]? \(\d+%\)", "<TOK> (<PCT>)", frame)
    # Loader token counts and elapsed seconds.
    frame = re.sub(r"[\u2193\u2191] [\d.kM]+ tokens", "<DIR> <TOK> tokens", frame)
    frame = re.sub(r"\b\d+s\b", "<S>", frame)
    # Spinner and working-icon animation frames.
    spinners = "".join("\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f")
    frame = re.sub("[" + spinners + "]", "<SPIN>", frame)
    # TS `WORKING_ICON_FRAMES` (◇◈◆◈) and the pre-parity Rust set.
    pulses = "".join("\u25c7\u25c8\u25c6\u25f4\u25f7\u25f6\u25f5\u25cb\u25f8\u25fb\u25fc")
    frame = re.sub("[" + pulses + "]", "<PULSE>", frame)
    # tmux places the trailing foreground-reset (\x1b[39m) differently for
    # identical screens: at the end of the row whose styled text just ended,
    # or before the next row's default margin. Both describe default-colored
    # cells, so drop boundary resets before comparing. The same applies to
    # the background-reset (\x1b[49m) the editor line leaves on the blank
    # rows above a message: tmux attaches it to the end of the last blank
    # row or to the message row's leading space.
    frame = re.sub("\x1b\[39m\n", "\n", frame)
    frame = re.sub("\n\x1b\[39m(?= )", "\n", frame)
    frame = re.sub("\x1b\[49m\n", "\n", frame)
    frame = re.sub("\n\x1b\[49m(?= )", "\n", frame)
    # The loader row's spinner-to-label gap: TS resets the spinner color and
    # leaves the separator space default-colored; Rust carries the label
    # color across the space. A space's foreground is invisible either way,
    # so canonicalize both to the TS shape (space before the label color).
    frame = re.sub(r"(?<=<SPIN>)\x1b\[39m (?=\x1b\[38;2;161;161;170m)", " ", frame)
    frame = re.sub(
        r"(?<=<SPIN>)\x1b\[38;2;161;161;170m (?=\S)", " \x1b[38;2;161;161;170m", frame
    )
    # The right-aligned tray: its padding shifts when the volatile context
    # usage strings (already normalized above) had different widths, so
    # collapse the padding run before the tray's model segment.
    frame = re.sub(r" +(\x1b\[38;2;113;113;122mfaux-1 \u00b7 )", r" \1", frame)
    # The selection-background row: the pi-tui writer's escape placement
    # inside the selection wrap varies between runs of the same binary
    # (bold-on for the role label, fg resets mid-row, the trailing reset
    # bundle), so the tree pane's selected row compares by visible text.
    frame = re.sub(
        "(\x1b\[38;2;[0-9;]+m)?\x1b\[48;2;34;34;38m[^\n]*",
        lambda m: re.sub("\x1b\[[0-9;]*m", "", m.group(0)),
        frame,
    )
    # Reverse-video rows (the in-app mouse-selection highlight, the follow
    # hint): the TS writer strips the span's styling and resets before and
    # after it while ratatui's diff places its reset bundle at the row end,
    # so identical reversed rows differ in escape placement alone. Those
    # rows compare by visible text.
    frame = re.sub(
        "^[^\n]*\x1b\[7m[^\n]*$",
        lambda m: re.sub("\x1b\[[0-9;]*m", "", m.group(0)),
        frame,
        flags=re.MULTILINE,
    )
    # Selector list rows (the `› ` cursor prefix): same writer variance for
    # the accent cursor and the bold selected row.
    frame = re.sub(
        "^.*› .*$",
        lambda m: re.sub("\x1b\[[0-9;]*m", "", m.group(0)),
        frame,
        flags=re.MULTILINE,
    )
    return frame


def diff_lines(left, right):
    return "\n".join(
        difflib.unified_diff(
            left.split("\n"), right.split("\n"),
            fromfile="ts", tofile="rust", lineterm="", n=1,
        )
    )


def prepare_sandbox(base):
    """Create the per-binary sandboxes and the shared cwd fixture."""
    shared_cwd = os.path.join(base, "shared-cwd")
    os.makedirs(shared_cwd, exist_ok=True)
    with open(os.path.join(shared_cwd, "alpha.txt"), "w") as f:
        f.write("alpha\n")
    with open(os.path.join(shared_cwd, "beta.md"), "w") as f:
        f.write("# beta\n")

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
    with open(
        os.path.join(sandboxes["ts"]["agent"], "extensions", "visual-faux.js"), "w"
    ) as f:
        f.write(TS_FAUX_EXTENSION)
    return shared_cwd, script_path, sandboxes


def wait_for(session, needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        pane = capture(session, escape=False)
        if needle in pane:
            return
        time.sleep(0.3)
    raise TimeoutError(f"session {session} never showed {needle!r}")


def run_session(binary, sandbox, shared_cwd, script_path, size, out_dir, session_prefix):
    """Drive one binary through the defined states, capturing each frame."""
    width, height = size
    session = f"vplane-{session_prefix}-{binary}-{width}x{height}"
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
            f"--model {TS_SCRIPT_MODEL}"
        )
    else:
        rust = os.environ.get(
            "PA_RUST_BINARY",
            os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "prime-agent"
            ),
        )
        # The Rust kernel needs the prime-agent-runtime sidecar (the TS
        # release ships it next to its binary; the Rust build tree does not).
        package_dir = os.environ.get("PI_PACKAGE_DIR") or find_runtime_package_dir()
        command = (
            f"PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model {TS_SCRIPT_MODEL}"
        )
    tmux("send-keys", "-t", session, f"{env} {command}", "Enter")

    frames = {}
    # (a) fresh start: wait for the splash + editor to settle.
    wait_for(session, "Collapsed mode", timeout=40)
    time.sleep(1.0)
    frames["a_fresh_start"] = capture(session)

    # Submit the turn.
    tmux("send-keys", "-t", session, PROMPT)
    tmux("send-keys", "-t", session, "Enter")

    # (d) spinner: the working loader mid-turn. The loader's Thinking phase
    # renders identically on both binaries (a spinner glyph, the activity
    # label, elapsed seconds, and the streaming token count) and lasts ~1s
    # at the scripted 18 tokens/second, so poll for the loader row and
    # capture immediately, still inside the phase. The Thinking-phase
    # needle must match the row as rendered ("Thinking ·"), not the
    # activity name alone.
    deadline = time.time() + 60
    while time.time() < deadline:
        pane = capture(session, escape=False)
        if re.search(r"Thinking \u00b7", pane):
            break
        time.sleep(0.1)
    else:
        raise TimeoutError(
            f"session {session} never showed the Thinking loader row"
        )
    frames["d_spinner"] = capture(session)

    # (f) kernel boot: the first ipython call boots the python kernel
    # (one-time, ~30s in a fresh sandbox HOME). While it runs, the tool
    # owns the loader note and both binaries render the same row
    # ("⠹ › setting up python kernel (one-time, ~30s)…" plus elapsed): TS
    # via the extension-UI setWorkingMessage request, Rust from the same
    # stage text carried by the tool's `starting` partials. The session-create
    # prewarm moved the boot ahead of the prompt on a warm box (the
    # runtime sidecar's venv is already installed), so the note is
    # best-effort: poll for a bounded window and capture inside it; a
    # warm boot has no note to show and the state is skipped on both
    # sides (spinner frames and elapsed seconds normalize).
    deadline = time.time() + 20
    while time.time() < deadline:
        pane = capture(session, escape=False)
        if "setting up python kernel" in pane:
            frames["f_kernel_boot"] = capture(session)
            break
        time.sleep(0.5)

    # (b) idle after the turn: the final answer rendered AND the loader row
    # is gone (the spinner line disappears once the turn ends).
    deadline = time.time() + 120
    while time.time() < deadline:
        pane = capture(session, escape=False)
        if "Anything else?" in pane and not re.search(SPINNER_CLASS, pane):
            break
        time.sleep(0.3)
    time.sleep(1.0)
    frames["b_turn_with_tool"] = capture(session)

    # (f) the /tree selector pane: opens over the settled session right
    # after the first turn (the double-Escape shortcut would need two
    # presses within 500ms; the command path is the stable one). Captured
    # before the table turn, whose scripted-response exhaustion leaves a
    # failed turn in the transcript. Esc closes it before the next state.
    tmux("send-keys", "-t", session, "/tree")
    tmux("send-keys", "-t", session, "Enter")
    wait_for(session, "Session Tree", timeout=15)
    time.sleep(1.0)
    frames["f_tree_pane"] = capture(session)
    tmux("send-keys", "-t", session, "Escape")
    time.sleep(0.5)

    # (g) the /fork user-message selector: same mount, same escape-close.
    tmux("send-keys", "-t", session, "/fork")
    tmux("send-keys", "-t", session, "Enter")
    wait_for(session, "Fork from Message", timeout=15)
    time.sleep(1.0)
    frames["g_fork_pane"] = capture(session)
    tmux("send-keys", "-t", session, "Escape")
    time.sleep(0.5)

    # (e) table + links: submit a second turn whose response carries a
    # markdown table and links; capture the settled frame. The faux queue
    # holds two responses (the first turn's post-tool continuation consumes
    # the table), so the second turn settles on its provider error — wait
    # for that row, not the table text (it already rendered in turn 1).
    tmux("send-keys", "-t", session, SECOND_PROMPT)
    tmux("send-keys", "-t", session, "Enter")
    deadline = time.time() + 120
    while time.time() < deadline:
        pane = capture(session, escape=False)
        if "No more faux responses queued" in pane and not re.search(SPINNER_CLASS, pane):
            break
        time.sleep(0.3)
    time.sleep(1.0)
    frames["e_table_and_links"] = capture(session)

    # (c) thinking visible: Ctrl+O toggles conversation detail.
    tmux("send-keys", "-t", session, "C-o")
    try:
        wait_for(session, "Details mode", timeout=10)
    except TimeoutError:
        pass
    time.sleep(1.0)
    frames["c_thinking_visible"] = capture(session)

    # (h) mouse wheel-up: byte-identical SGR wheel reports scroll the
    # transcript window three lines per turn; MOUSE_WHEEL_UP_TURNS turns
    # lift the view off the tail (the follow hint appears over the last
    # transcript row).
    send_wheel_report(session, WHEEL_UP_HEX, MOUSE_WHEEL_UP_TURNS)
    time.sleep(1.0)
    frames["h_mouse_scrolled"] = capture(session)

    # (i) mouse wheel-down: scroll back; the clamp at the bottom settles
    # both binaries at the tail with following resumed.
    send_wheel_report(session, WHEEL_DOWN_HEX, MOUSE_WHEEL_DOWN_TURNS)
    time.sleep(1.0)
    frames["i_mouse_follow"] = capture(session)

    # (j-k-l) in-app mouse selection: byte-identical SGR press/drag/release
    # reports drag across the second turn's answer text; the pane's raw
    # output stream (pipe-pane) records the OSC 52 clipboard copy the
    # release emits. The needle's rendered cell is located per binary so
    # both drag the same rendered text (the frames already compare equal
    # at this point, so the cells match).
    plain = capture(session, escape=False)
    located = locate_plain(plain, SELECTION_NEEDLE)
    if located is None:
        raise TimeoutError(
            f"session {session} never showed the selection needle {SELECTION_NEEDLE!r}"
        )
    needle_row, needle_col = located
    pane_raw = os.path.join(sandbox["tmp"], "pane-osc52.raw")
    if os.path.exists(pane_raw):
        os.remove(pane_raw)
    tmux("pipe-pane", "-t", session, f"cat > {pane_raw}")
    send_mouse_report(session, mouse_press(needle_col + 1, needle_row + 1))
    time.sleep(0.3)
    send_mouse_report(session, mouse_drag(needle_col + 1 + len(SELECTION_NEEDLE), needle_row + 1))
    time.sleep(0.5)
    frames["j_mouse_selected"] = capture(session)
    selected = capture(session)
    needle_prefix = selected.split("\n")[needle_row] if needle_row < len(
        selected.split("\n")
    ) else ""
    if "\x1b[7m" + SELECTION_NEEDLE not in needle_prefix:
        raise AssertionError(
            f"session {session} did not render the dragged text reversed mid-drag"
        )
    send_mouse_report(session, mouse_release(needle_col + 1 + len(SELECTION_NEEDLE), needle_row + 1))
    time.sleep(0.5)
    tmux("pipe-pane", "-t", session)
    frames["k_mouse_copied"] = capture(session)
    released = frames["k_mouse_copied"]
    needle_prefix = released.split("\n")[needle_row] if needle_row < len(
        released.split("\n")
    ) else ""
    if "\x1b[7m" + SELECTION_NEEDLE in needle_prefix:
        raise AssertionError(
            f"session {session} kept the selection highlighted after the release"
        )
    with open(pane_raw, "rb") as f:
        raw = f.read().decode("latin1")
    copies = osc52_copies(raw)
    if not copies:
        raise AssertionError(
            f"session {session} never emitted an OSC 52 copy for the release"
        )
    decoded = base64.b64decode(copies[-1]).decode("utf-8")
    if decoded != SELECTION_NEEDLE:
        raise AssertionError(
            f"session {session} copied {decoded!r} for the release, expected "
            f"{SELECTION_NEEDLE!r}"
        )
    frames["l_mouse_copy"] = f"\x1b]52;c;{copies[-1]}\x07"

    # Exit: ctrl+c aborts a running turn, a second press exits when idle.
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
    parser.add_argument("--keep", action="store_true", help="keep the sandbox dir")
    parser.add_argument(
        "--out", default=None, help="captures directory (default: a fresh temp dir)"
    )
    parser.add_argument(
        "--only", default=None, help="run a single binary (ts|rust) for capture shakedown"
    )
    parser.add_argument(
        "--session-prefix",
        default="vp",
        help="tmux session-name prefix (vplane-<prefix>-<binary>-WxH); distinct "
        "prefixes keep concurrent harness runs on the same box from killing "
        "each other's sessions",
    )
    args = parser.parse_args()
    sizes = []
    for entry in args.sizes.split(","):
        width, height = entry.split("x")
        sizes.append((width, height))

    # Fail fast before any launch: a non-TS `prime-agent` on PATH (e.g. a
    # Rust build symlinked there) plays a Rust build as the "ts" side and
    # reports false divergences (see the guard's docstring).
    if args.only in (None, "ts"):
        ts_identity.assert_ts_side_is_the_ts_product()

    base = tempfile.mkdtemp(prefix="visual-parity-sandbox-")
    out_dir = args.out or tempfile.mkdtemp(prefix="visual-parity-captures-")
    shared_cwd, script_path, sandboxes = prepare_sandbox(base)
    failures = []
    try:
        if args.only:
            run_session(
                args.only,
                sandboxes[args.only],
                shared_cwd,
                script_path,
                sizes[0],
                out_dir,
                args.session_prefix,
            )
            print(f"captures for {args.only} in {out_dir}")
            return 0
        for size in sizes:
            ts_frames = run_session(
                "ts", sandboxes["ts"], shared_cwd, script_path, size, out_dir, args.session_prefix
            )
            rust_frames = run_session(
                "rust", sandboxes["rust"], shared_cwd, script_path, size, out_dir, args.session_prefix
            )
            for state, _ in STATES:
                # A best-effort state (the kernel-boot note) skips only
                # when BOTH sides skipped it; one side showing what the
                # other lacks is a divergence like any other.
                if state not in ts_frames or state not in rust_frames:
                    if state not in ts_frames and state not in rust_frames:
                        print(f"SKIP {state}-{size[0]}x{size[1]} (absent on both sides)")
                        continue
                    missing = "ts" if state not in ts_frames else "rust"
                    failures.append(f"{state}-{size[0]}x{size[1]}")
                    print(f"FAIL {state}-{size[0]}x{size[1]} (absent on {missing})")
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
