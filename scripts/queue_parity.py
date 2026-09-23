#!/usr/bin/env python3
"""Prompt-surface parity: frame-diff the queued-prompt strip and the live
editor highlight against the installed TS prime-agent binary in tmux.

Drives both binaries to the same defined states and compares what the user
sees:

- the queued strip behind a slow running turn — one steering prompt (Enter)
  and one follow-up prompt (alt+enter), drained after delivery — with the
  strip rows compared ANSI byte-exact (the TS prompt-highlight styling: dim
  previews, accent on a leading slash command's `/name` segment,
  success/mdLink on @path/--flag tokens);
- a second parked lane with slash-command and token-bearing prompts, so the
  accent styling itself is compared byte-exact (captured before delivery,
  aborted away after);
- the streaming follow-up hint (TS `getTrayOverrideLabel`'s streaming
  arm): while the slow turn streams and a draft sits in the editor, the
  tray row reads `<followUp> to queue message` — compared ANSI
  byte-exact, and its departure with the cleared draft is asserted;
- the live editor with a slash command and argument tokens typed but not
  submitted — cursor at the end (command segment accented, tokens colored)
  and cursor moved inside the command token (accent suppressed), the
  editor's text row compared byte-exact;
- the transcript prompt-highlight surfaces (TS `PromptTokenMask` +
  `SlashCommandMessageComponent`): a token-bearing user-message row (the
  `success`/`mdLink` token colors inside the `userMessageText` body on the
  `userMessageBg` block), a session-command echo row (accent `/name`,
  default-fg rest, same block), and a command-bearing user row (`/hotkeys`
  echoed as a user message with its whole command segment in accent).

The command-bearing user row runs in its own tmux session at 120x130: the
`/hotkeys` guide rendered under it (markdown tables, one border row per
table row) is taller than the 120x36 viewport, so the user block would
scroll off a 36-row capture (the row bytes are width-bound, and the width
stays 120). Everything else runs at the default size.

Exit code is non-zero when any state's visible rows differ.

Reuses the visual_parity faux-provider harness (tmux rules: default socket,
vplane-* session names, sessions killed individually).
"""

import argparse
import difflib
import json
import os
import re
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import visual_parity as vp

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

# Turn 1/4 stream slowly (6 tokens/s) so the window stays open for the
# parked submissions; turns 2/3 answer the queued prompts.
QUEUE_FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": vp.TS_SCRIPT_MODEL,
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 6,
    "responses": [
        # The token-user-row turn answers quickly so the transcript state
        # settles; the queue turns follow (the first of them streams
        # slowly).
        {"content": [{"type": "text", "text": "token user row delivered"}]},
        {
            "content": [
                {
                    "type": "text",
                    "text": "The first turn streams slowly and keeps going for a good while so the parked preview strip has plenty of time to render before this turn settles and the queue drains.",
                }
            ]
        },
        {"content": [{"type": "text", "text": "steering delivered"}]},
        {"content": [{"type": "text", "text": "follow-up delivered"}]},
        {
            "content": [
                {
                    "type": "text",
                    "text": "The second turn streams even more slowly and keeps going for a while so the parked slash command strip has plenty of time to render before the turn settles and the queue drains.",
                }
            ]
        },
    ],
}

FIRST_PROMPT = "tell me something slowly"
STEERING_PROMPT = "steering prompt text"
FOLLOW_UP_PROMPT = "follow-up prompt text"
SECOND_PROMPT = "tell me something slowly again"

# The editor states type a recognized argument-taking command with both
# argument-token forms. The parked slash prompts are session commands
# (`/compact`, `/goal`): client commands execute immediately instead of
# parking, while session commands queue behind the running turn and render
# in the accent-styled strip — captured before delivery and aborted away.
EDITOR_COMMAND = "/new @docs/plan.md --draft"
SLASH_STEERING_PROMPTS = [
    "/compact focus the summary on tests",
    "/goal finish the port @docs/plan.md --verbose",
    "fix @Cargo.toml --quiet now",
]

# Transcript prompt-highlight states (TS `PromptTokenMask` on user rows,
# `SlashCommandMessageComponent` for the echo): a plain prompt carrying
# @path/--flag tokens (user row, byte-exact), the same session command the
# parked lane types (durable echo row, byte-exact — the fresh session skips
# compaction with the TS warning row), and the /hotkeys client command
# (command-bearing user row, byte-exact, own 120x80 session).
USER_TOKEN_PROMPT = "fix @Cargo.toml --quiet now"
TOKEN_TURN_RESPONSE = "token user row delivered"
ECHO_COMMAND = "/compact focus the summary on tests"
HOTKEYS_COMMAND = "/hotkeys"
HOTKEYS_SIZE = (120, 130)

# Strip rows both binaries must render (the visible queue surface).
STEERING_ROW = f"Steering: {STEERING_PROMPT}"
FOLLOW_UP_ROW = f"Follow-up: {FOLLOW_UP_PROMPT}"
HINT_ROW = "to browse and edit queued messages"

# The streaming follow-up hint (TS `getTrayOverrideLabel`): while a turn
# streams and a draft sits in the editor, the tray's location label is
# replaced by `<followUp> to queue message` (the default binding on this
# platform is alt+enter on both binaries).
HINT_DRAFT = "draft not sent yet"
STREAMING_HINT_ROW = "Alt+Enter to queue message"

ANSI_PATTERN = re.compile("\x1b\\[[0-9;]*[A-Za-z]")


def strip_ansi(text):
    return ANSI_PATTERN.sub("", text)


def normalize_sgr_boundaries(frame):
    """Canonicalize tmux's row-boundary reset placement (the same rules
    visual_parity applies before its byte-diffs): the trailing fg/bg reset
    attaches to the end of the styled row or the start of the next one
    depending on timing, and both describe identical cells."""
    frame = re.sub("\x1b\\[39m\n", "\n", frame)
    frame = re.sub("\n\x1b\\[39m(?= )", "\n", frame)
    frame = re.sub("\x1b\\[49m\n", "\n", frame)
    frame = re.sub("\n\x1b\\[49m(?= )", "\n", frame)
    return frame


def strip_rows(frame):
    """The queue-strip rows of one frame, ANSI-stripped, in render order."""
    return [
        line.strip()
        for line in strip_ansi(frame).split("\n")
        if any(marker in line for marker in ("Steering: ", "Follow-up: ", HINT_ROW))
    ]


def styled_rows(frame, markers):
    """The rows of one frame containing any marker, ANSI bytes intact."""
    frame = normalize_sgr_boundaries(frame)
    return [
        line
        for line in frame.split("\n")
        if any(marker in strip_ansi(line) for marker in markers)
    ]


def strip_rows_styled(frame):
    """The queue-strip rows with their ANSI styling, for byte-exact compare."""
    return styled_rows(
        frame, ("Steering: ", "Follow-up: ", HINT_ROW)
    )


def editor_rows_styled(frame):
    """The editor's typed-text row with its ANSI styling, for byte-exact
    compare (the prompt dock row holding the command)."""
    return styled_rows(frame, ("@docs/plan.md",))


def exact_rows_styled(frame, text):
    """The transcript rows whose ANSI-stripped text equals `text`, ANSI
    bytes intact, for byte-exact compare (the user block's content row and
    the session-command echo row)."""
    frame = normalize_sgr_boundaries(frame)
    return [
        line
        for line in frame.split("\n")
        if strip_ansi(line).strip() == text
    ]


def prepare_queue_sandbox(base):
    """The visual_parity fixture with the queue-specific faux script."""
    shared_cwd, script_path, sandboxes = vp.prepare_sandbox(base)
    script_path = os.path.join(base, "queue-faux-script.json")
    with open(script_path, "w") as f:
        json.dump(QUEUE_FAUX_SCRIPT, f, indent=2)
    return shared_cwd, script_path, sandboxes


def wait_plain(session, needle, timeout=30, gone=False):
    """Poll the pane's ANSI-stripped text until `needle` appears (or is gone)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        plain = strip_ansi(vp.capture(session))
        if (needle not in plain) == gone:
            return
        time.sleep(0.3)
    raise RuntimeError(
        f"timed out waiting for {needle!r} to {'vanish' if gone else 'appear'}"
    )


def run_queue_session(binary, sandbox, shared_cwd, script_path, size, out_dir, prefix):
    """Drive one binary through the queue/editor states, capturing each frame."""
    width, height = size
    session = f"vplane-{prefix}-queue-{binary}-{width}x{height}"
    vp.tmux("kill-session", "-t", session, check=False)
    vp.tmux("new-session", "-d", "-s", session, "-x", width, "-y", height, "-c", shared_cwd)
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
            f"--model {vp.TS_SCRIPT_MODEL}"
        )
    else:
        rust = os.environ.get(
            "PA_RUST_BINARY",
            os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "prime-agent"
            ),
        )
        package_dir = os.environ.get("PI_PACKAGE_DIR") or vp.find_runtime_package_dir()
        command = (
            f"PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model {vp.TS_SCRIPT_MODEL}"
        )
    vp.tmux("send-keys", "-t", session, f"{env} {command}", "Enter")

    frames = {}
    # (a) fresh start.
    vp.wait_for(session, "Collapsed mode", timeout=60)
    # (u) the token-bearing user row: a plain prompt with @path/--flag
    # tokens submitted while idle renders the TS `PromptTokenMask` colors
    # inside the user block; the faux turn settles so the frame is stable.
    vp.tmux("send-keys", "-t", session, USER_TOKEN_PROMPT)
    vp.tmux("send-keys", "-t", session, "Enter")
    vp.wait_for(session, TOKEN_TURN_RESPONSE, timeout=60)
    time.sleep(0.5)
    frames["u_token_user_row"] = vp.capture(session)
    # (s) the session-command echo row: the same command the parked lane
    # types, submitted while idle. The fresh session skips compaction (the
    # durable TS warning row), and the durable echo row stays on screen —
    # accent `/compact`, default-fg rest, on the user-message block.
    vp.tmux("send-keys", "-t", session, ECHO_COMMAND)
    vp.tmux("send-keys", "-t", session, "Enter")
    wait_plain(session, "too short to compact", timeout=60)
    time.sleep(0.5)
    frames["s_slash_echo_row"] = vp.capture(session)
    # (e1) the editor highlight: type a slash command with argument tokens
    # without submitting, close the autocomplete, capture the editor row.
    vp.tmux("send-keys", "-t", session, EDITOR_COMMAND)
    wait_plain(session, "@docs/plan.md")
    vp.tmux("send-keys", "-t", session, "Escape")
    time.sleep(1.0)
    frames["e_editor_slash"] = vp.capture(session)
    # (e2) the cursor inside the command token suppresses its accent; the
    # argument tokens stay colored.
    for _ in range(len(EDITOR_COMMAND) - 2):
        vp.tmux("send-keys", "-t", session, "Left")
    time.sleep(1.0)
    frames["e_editor_cursor_in_command"] = vp.capture(session)
    # Clear the editor (TS escape-repeat: two presses clear the input).
    vp.tmux("send-keys", "-t", session, "Escape")
    time.sleep(0.4)
    vp.tmux("send-keys", "-t", session, "Escape")
    wait_plain(session, "@docs/plan.md", gone=True, timeout=15)

    # (q) the queue strip: submit the slow first turn, wait until it streams,
    # then park one steering prompt (Enter) and one follow-up prompt
    # (alt+enter) behind it.
    vp.tmux("send-keys", "-t", session, FIRST_PROMPT)
    vp.tmux("send-keys", "-t", session, "Enter")
    vp.wait_for(session, "streams slowly", timeout=60)
    vp.tmux("send-keys", "-t", session, STEERING_PROMPT)
    vp.tmux("send-keys", "-t", session, "Enter")
    vp.tmux("send-keys", "-t", session, FOLLOW_UP_PROMPT)
    vp.tmux("send-keys", "-t", session, "M-Enter")
    vp.wait_for(session, HINT_ROW, timeout=30)
    vp.wait_for(session, STEERING_ROW, timeout=15)
    vp.wait_for(session, FOLLOW_UP_ROW, timeout=15)
    time.sleep(0.3)
    frames["q_queue_strip"] = vp.capture(session)

    # (h) the streaming follow-up hint (TS `getTrayOverrideLabel`): while
    # the turn still streams and a draft sits in the editor, the tray row
    # becomes `<followUp> to queue message`. Type a draft without
    # submitting, capture, then clear it — the hint leaves with the empty
    # editor, and the browse state below starts from the clean editor.
    vp.tmux("send-keys", "-t", session, HINT_DRAFT)
    vp.wait_for(session, STREAMING_HINT_ROW, timeout=15)
    time.sleep(0.3)
    frames["h_streaming_hint"] = vp.capture(session)
    vp.tmux("send-keys", "-t", session, "Escape")
    time.sleep(0.4)
    vp.tmux("send-keys", "-t", session, "Escape")
    wait_plain(session, STREAMING_HINT_ROW, gone=True, timeout=15)

    # (b) the browse state: alt+up selects the newest parked message (the
    # follow-up) and shows the dim browse header.
    vp.tmux("send-keys", "-t", session, "M-Up")
    vp.wait_for(session, "browse", timeout=15)
    frames["q_browse_header"] = vp.capture(session)
    vp.tmux("send-keys", "-t", session, "M-Down")
    time.sleep(1.0)

    # (c) drained: both queued prompts delivered, strip cleared.
    vp.wait_for(session, "steering delivered", timeout=120)
    vp.wait_for(session, "follow-up delivered", timeout=120)
    for _ in range(200):
        pane = vp.capture(session, escape=False)
        if HINT_ROW not in pane:
            break
        time.sleep(0.3)
    frames["q_drained"] = vp.capture(session)

    # (s) the slash-command strip: a second slow turn, with slash-command and
    # token-bearing prompts parked behind it; captured before delivery.
    vp.tmux("send-keys", "-t", session, SECOND_PROMPT)
    vp.tmux("send-keys", "-t", session, "Enter")
    vp.wait_for(session, "even more slowly", timeout=60)
    for prompt in SLASH_STEERING_PROMPTS:
        vp.tmux("send-keys", "-t", session, prompt)
        vp.tmux("send-keys", "-t", session, "Enter")
    # The accent styling splits the row mid-text, so wait on the
    # ANSI-stripped pane.
    for prompt in SLASH_STEERING_PROMPTS:
        wait_plain(session, f"Steering: {prompt}")
    time.sleep(0.3)
    frames["q_slash_strip"] = vp.capture(session)

    # Exit: ctrl+c aborts the settled run, a second press exits.
    vp.tmux("send-keys", "-t", session, "C-c")
    time.sleep(0.5)
    vp.tmux("send-keys", "-t", session, "C-c")
    time.sleep(1.0)
    vp.tmux("kill-session", "-t", session, check=False)

    os.makedirs(out_dir, exist_ok=True)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"{binary}-{state}-{width}x{height}.txt"), "w") as f:
            f.write(frame)
    return frames


def run_hotkeys_session(binary, sandbox, shared_cwd, script_path, out_dir, prefix):
    """The command-bearing user row (`/hotkeys` echoed as a user message
    block, TS `echoLocalCommand` + `PromptTokenMask`): its own session at
    120x80 — the guide rendered under the row is taller than the 36-row
    viewport, and the row's bytes are width-bound (width stays 120)."""
    width, height = HOTKEYS_SIZE
    session = f"vplane-{prefix}-hotkeys-{binary}-{width}x{height}"
    vp.tmux("kill-session", "-t", session, check=False)
    vp.tmux(
        "new-session", "-d", "-s", session, "-x", str(width), "-y", str(height), "-c", shared_cwd
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
            f"--model {vp.TS_SCRIPT_MODEL}"
        )
    else:
        rust = os.environ.get(
            "PA_RUST_BINARY",
            os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "prime-agent"
            ),
        )
        package_dir = os.environ.get("PI_PACKAGE_DIR") or vp.find_runtime_package_dir()
        command = (
            f"PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model {vp.TS_SCRIPT_MODEL}"
        )
    vp.tmux("send-keys", "-t", session, f"{env} {command}", "Enter")
    vp.wait_for(session, "Collapsed mode", timeout=60)
    vp.tmux("send-keys", "-t", session, HOTKEYS_COMMAND)
    vp.tmux("send-keys", "-t", session, "Enter")
    # The guide under the row proves the user block settled.
    wait_plain(session, "Navigation", timeout=30)
    time.sleep(0.5)
    frame = vp.capture(session)
    vp.tmux("send-keys", "-t", session, "C-c")
    time.sleep(0.5)
    vp.tmux("send-keys", "-t", session, "C-c")
    time.sleep(1.0)
    vp.tmux("kill-session", "-t", session, check=False)
    os.makedirs(out_dir, exist_ok=True)
    with open(
        os.path.join(out_dir, f"{binary}-u_command_user_row-{width}x{height}.txt"), "w"
    ) as f:
        f.write(frame)
    return {"u_command_user_row": frame}


def require_markers(frame, markers, state):
    """Scenario guard: every expected row must be on screen when captured,
    so a too-late capture (delivered before the frame) cannot false-pass."""
    plain = strip_ansi(frame)
    missing = [marker for marker in markers if marker not in plain]
    if missing:
        raise RuntimeError(
            f"scenario drift in {state}: expected rows not on screen: {missing}"
        )


def compare(name, ts_rows, rust_rows):
    if ts_rows == rust_rows:
        print(f"PASS {name}: {len(ts_rows)} row(s) match")
        for row in ts_rows:
            print(f"  | {row}")
        return None
    print(f"FAIL {name}")
    print(
        "\n".join(
            difflib.unified_diff(
                [str(r) for r in ts_rows], [str(r) for r in rust_rows],
                fromfile="ts", tofile="rust", lineterm="", n=1,
            )
        )
    )
    return name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", default="120x36")
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--out", default=None)
    parser.add_argument("--only", default=None, choices=("ts", "rust"))
    parser.add_argument("--session-prefix", default="vp")
    args = parser.parse_args()
    width, height = args.size.split("x")
    size = (width, height)

    # Fail fast before any launch: a non-TS `prime-agent` on PATH plays a
    # Rust build as the "ts" side and reports false divergences.
    if args.only in (None, "ts"):
        ts_identity.assert_ts_side_is_the_ts_product()

    base = tempfile.mkdtemp(prefix="queue-parity-sandbox-")
    out_dir = args.out or tempfile.mkdtemp(prefix="queue-parity-captures-")
    shared_cwd, script_path, sandboxes = prepare_queue_sandbox(base)
    try:
        if args.only:
            run_queue_session(
                args.only, sandboxes[args.only], shared_cwd, script_path, size, out_dir, args.session_prefix
            )
            print(f"captures for {args.only} in {out_dir}")
            return 0
        ts_frames = run_queue_session(
            "ts", sandboxes["ts"], shared_cwd, script_path, size, out_dir, args.session_prefix
        )
        rust_frames = run_queue_session(
            "rust", sandboxes["rust"], shared_cwd, script_path, size, out_dir, args.session_prefix
        )
        ts_hotkeys = run_hotkeys_session(
            "ts", sandboxes["ts"], shared_cwd, script_path, out_dir, args.session_prefix
        )
        rust_hotkeys = run_hotkeys_session(
            "rust", sandboxes["rust"], shared_cwd, script_path, out_dir, args.session_prefix
        )
        ts_frames.update(ts_hotkeys)
        rust_frames.update(rust_hotkeys)
        # Scenario guards: the strip states must show every parked row when
        # captured (a frame after delivery would compare empty rows).
        require_markers(
            ts_frames["q_queue_strip"],
            [STEERING_ROW, FOLLOW_UP_ROW, HINT_ROW],
            "q_queue_strip (ts)",
        )
        require_markers(
            ts_frames["q_slash_strip"],
            [f"Steering: {prompt}" for prompt in SLASH_STEERING_PROMPTS] + [HINT_ROW],
            "q_slash_strip (ts)",
        )
        require_markers(
            ts_frames["h_streaming_hint"],
            [STREAMING_HINT_ROW, HINT_DRAFT],
            "h_streaming_hint (ts)",
        )
        require_markers(
            rust_frames["h_streaming_hint"],
            [STREAMING_HINT_ROW, HINT_DRAFT],
            "h_streaming_hint (rust)",
        )
        # The transcript states must show their rows (an early capture or a
        # scrolled-off block would compare empty rows).
        for state, text in (
            ("u_token_user_row", USER_TOKEN_PROMPT),
            ("s_slash_echo_row", ECHO_COMMAND),
            ("u_command_user_row", HOTKEYS_COMMAND),
        ):
            require_markers(ts_frames[state], [text], f"{state} (ts)")
            require_markers(rust_frames[state], [text], f"{state} (rust)")
        failures = []
        # Strip rows compare ANSI byte-exact: the prompt-highlight styling
        # (dim base, accent command segment, colored tokens) is the surface
        # under test.
        failures.append(
            compare(
                f"q_queue_strip-{args.size}",
                strip_rows_styled(ts_frames["q_queue_strip"]),
                strip_rows_styled(rust_frames["q_queue_strip"]),
            )
        )
        failures.append(
            compare(
                f"q_slash_strip-{args.size}",
                strip_rows_styled(ts_frames["q_slash_strip"]),
                strip_rows_styled(rust_frames["q_slash_strip"]),
            )
        )
        # The transcript rows compare ANSI byte-exact: the TS PromptTokenMask
        # styling (accent command segment, success/mdLink tokens inside the
        # userMessageText body) and the echo row's accent command segment
        # are the surfaces under test.
        for state, text in (
            ("u_token_user_row", USER_TOKEN_PROMPT),
            ("s_slash_echo_row", ECHO_COMMAND),
            ("u_command_user_row", HOTKEYS_COMMAND),
        ):
            failures.append(
                compare(
                    f"{state}-{args.size}",
                    exact_rows_styled(ts_frames[state], text),
                    exact_rows_styled(rust_frames[state], text),
                )
            )
        # The editor's typed-text row compares byte-exact in both cursor
        # positions.
        for state in ("e_editor_slash", "e_editor_cursor_in_command"):
            failures.append(
                compare(
                    f"{state}-{args.size}",
                    editor_rows_styled(ts_frames[state]),
                    editor_rows_styled(rust_frames[state]),
                )
            )
        # The streaming follow-up hint row compares ANSI byte-exact: the
        # tray override label (muted key + description, TS
        # `getTrayOverrideLabel` -> `renderInfoLine`) is the surface under
        # test.
        failures.append(
            compare(
                f"h_streaming_hint-{args.size}",
                exact_rows_styled(ts_frames["h_streaming_hint"], STREAMING_HINT_ROW),
                exact_rows_styled(rust_frames["h_streaming_hint"], STREAMING_HINT_ROW),
            )
        )
        # The browse header and drained strip keep the plain-row compare.
        for state in ("q_browse_header", "q_drained"):
            name = f"{state}-{args.size}"
            ts_rows = strip_rows(ts_frames[state])
            rust_rows = strip_rows(rust_frames[state])
            if ts_rows == rust_rows:
                print(f"PASS {name}: {len(ts_rows)} strip row(s) match")
            else:
                print(f"FAIL {name}")
                print(
                    "\n".join(
                        difflib.unified_diff(
                            [str(r) for r in ts_rows], [str(r) for r in rust_rows],
                            fromfile="ts", tofile="rust", lineterm="", n=1,
                        )
                    )
                )
                failures.append(name)
        if any(failures):
            failed = [f for f in failures if f]
            print(f"{len(failed)} state(s) differ; captures in {out_dir}")
            return 1
        print(f"all queue/editor states match; captures in {out_dir}")
        return 0
    finally:
        # Rmtree alone leaks the scenario daemons (a killed TUI pane does
        # not take its detached daemon/supervisor pair down; #223): sweep
        # every daemon this run spawned before deleting the sandbox.
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
