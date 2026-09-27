#!/usr/bin/env python3
"""Custom-message decoration parity verifier: frame-diff the Rust TUI
against the installed TS prime-agent binary rendering the SAME session
transcript containing every decorated custom-message row:

  - a received agent message (icon + label + participant + body),
  - an ipython cell that sent an agent message (the sent receipt rows
    render below the code, body in the expanded view),
  - a heartbeat prompt (pulse + schedule),
  - a goal-context continuation row,
  - a restored-python-kernel row,
  - the three RLM child rows (a finished terminal notice, a failed child,
    a cancelled terminal notice),
  - a background-shell completion,
  - a compaction outcome,
  - a refinement outcome,
  - an autonomous-status row (the generic custom box),
  - a skill invocation user message (the persisted `<skill>` block a
    user-typed `/skill:<name> [args]` expands into: the compact
    expandable `[skill]` card collapsed, the markdown body expanded, the
    args as their own user block, never the raw block text).

The session JSONL is assembled from real captured rows and resumed in the
TS binary (`prime-agent -r <path>`) and replayed in the Rust TUI
(`pa-tui-replay <path>`), both live in tmux at 120x90 (tall enough that
the expanded transcript stays in the viewport for the reach checks). States: the idle
transcript (collapsed) and the expanded view (Ctrl+O twice, where the
agent-message bodies and shell-completion output open up). Frames are
normalized for volatile content and diffed; the exit code is non-zero when
any state differs.

One documented divergence (operator directive 2026-09-25): the
agent-message rows render the viewer-relative notice on the Rust side —
the shared `Agent message` label, the ↑/↓ arrow from the row's
actual direction (↓ received, ↑ sent/queued), and the
counterpart agent's name only, with no collapsed body preview — where the
TS frames render the direction word plus the `from/to <role> <name>`
participant. The collapsed body preview the Rust side used to render (the
Kevin directive 2026-09-21 divergence) is gone with it, so its strip and
assert are retired. The diff canonicalizes the whole summary composition
to one marker per frame and the run separately asserts each side's exact
row; the TS side is expected to adopt the same shape so the
canonicalization can be dropped.

Second documented divergence (Kevin directive 2026-09-23, product
improvement BEYOND TS): the RLM child rows render the
`\u25c6 Subagent <name> finished|failed|cancelled` diamond rows on the Rust
side (the diamond marker carries the row's semantic color — the same style
the label renders in, success green / error red / cancelled yellow, per the
same directive's icon-follows-text rule — plus the failure error and the
cancellation reason as the expandable body, no reply-preview anywhere),
where the TS binary still shows the generic muted `RLM child status` label
over the full content markdown. The diff drops the RLM child rows from
BOTH frames and the run separately asserts the Rust diamond rows ARE
present (collapsed labels, expanded reason bodies, no preview, and the
diamond sharing the label's exact SGR color run per outcome) and the TS
frames show the old generic label (the baseline the TS team is expected to
adopt).

Third documented divergence (operator directive 2026-09-23): the heartbeat
prompt row renders the `\u25f7` clock glyph — the unified activity dock's
Heartbeats group icon — on the Rust side, where the TS binary still
renders the `\u2665` heart. The diff canonicalizes the row's glyph on both
frames (the label and schedule still diff) and the run separately asserts
each side's glyph (Rust clock, TS heart baseline).

Fourth documented divergence (Kevin directive 2026-09-24): the
agent-message rows render the `\u2709` mail envelope as the row icon — the
a2a rows read as agent mail — on the Rust side (the received transcript
rows and the ipython sent/queued receipt rows share the one summary
line), where the TS binary still renders the `\u25c6` diamond. The diff
canonicalizes the row's glyph on both frames (the label and participant
still diff; the glyph sits in its own accent SGR run, so the
canonicalization spans the escapes between the glyph and the label) and
the run separately asserts each side's glyph (Rust envelope, TS diamond
baseline).


Fifth documented divergence (Kevin/Sebastian directive 2026-09-23, product
improvement BEYOND TS): the expanded refinement outcome hangs on the
branch grammar — the expanded content carries the dim `╰─ `
gutter on the first row hanging off the `◆` header and a
four-space continuation indent after, instead of the TS
`ExpandableEventMessage`'s plain one-column chat inset (the same grammar
the expanded ipython cells and the agent-message bodies use). The diff
drops the refinement row's expanded rows from BOTH frames (the collapsed
row keeps byte-parity), but the dropped rows do not leave the comparison:
their visible content must match word for word (whitespace collapsed, the
gutter glyphs dropped — the intended divergence is the indentation and
the wrap points it forces, never the Title/Description/section values
themselves). The run separately asserts the Rust expanded rows carry the
branch and the TS frames keep the plain-inset baseline (the shape the TS
team is expected to adopt).

tmux rules: default socket only (`env -u TMUX`), cmparity-* session names,
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

SIZES = [("120", "90")]

# The transcript skeleton (entries copied from real captured sessions so
# both binaries parse byte-identical payloads). Timestamps are re-stamped
# sequentially; the parent chain is linear.
# (custom_type, content, extra fields): the content lives per row so the
# two terminal-notice shapes (finished, cancelled) and the failure row all
# carry their own wire content.
CUSTOM_ROWS = [
    ("agent_message",
     "[agent-message from child:model-probe]\n\nDecorations parity: the received row renders with the diamond, label, and participant.",
     {"display": True, "details": {
        "id": "agentmsg_cmparity",
        "message": "Decorations parity: the received row renders with the diamond, label, and participant.",
        "from": {"sessionName": "model-probe", "sessionId": "sess-probe", "activeSessionId": "aaa111", "runtimeKind": "subagent"},
        "fromRelationship": "child",
    }}),
    ("heartbeat_prompt", "[heartbeat: every 10m run#3]\n\nContinue the mission.", {"display": True, "details": {
        "jobId": "job-1", "schedule": "every 10m", "status": "running", "runCount": 3,
    }}),
    ("goal_context", "[goal: continuation]\n\nContinue the goal.", {"display": True, "details": {
        "kind": "continuation", "goalId": "goal-1",
        "objective": "Keep the parity harnesses green.",
        "status": "active", "continuationsUsed": 1,
    }}),
    ("ipython_state_restored", "[python-state-restored]\n\nKernel state revived.", {"display": True, "details": {"restored": True}}),
    # The three RLM child rows (the product-improvement divergence): a
    # finished child (the reply preview stays out of the row), a failed
    # child, a cancelled child. The reasons double as the strip needles.
    ("rlm_child_terminal_notice",
     "[child-exited: no-reply child:lane-decorations]\n\nLast assistant text: the legacy preview that must not render",
     {"display": True, "details": {
         "kind": "completed_without_reply", "childId": "sub-1", "sessionName": "lane-decorations",
         "lastAssistantTextPreview": "the legacy preview that must not render",
     }}),
    ("rlm_child_failure",
     "[child-failed child:boom-worker]\n\nthe model stream died",
     {"display": True, "details": {
         "childId": "sub-2", "sessionName": "boom-worker", "error": "the model stream died",
     }}),
    ("rlm_child_terminal_notice",
     "[child-exited: cancelled child:cancel-worker]\n\nDeleted by parent orchestrator",
     {"display": True, "details": {
         "kind": "cancelled", "childId": "sub-3", "sessionName": "cancel-worker",
         "reason": "Deleted by parent orchestrator",
     }}),
    ("async_bash_completion", "[bash-done pid:4371 exit:0]\n\nCommand: \"seq 1 3\"", {"display": True, "details": {"pid": 4371, "command": "seq 1 3", "exitCode": 0}}),
    ("compaction_outcome", "Compaction skipped: below the token threshold.", {"display": True, "details": {"reason": "threshold", "outcome": "skipped"}}),
    ("refinement_outcome", "Refinement complete: Create one local memory.", {"display": True, "details": {
        "refinementId": "refine_cmparity", "summary": "Create one local memory.", "scope": "local",
        "edits": [{
            "action": "create", "kind": "memory", "id": "cmparity-memory", "applied": True,
            "title": "Parity memory", "content": "The harness stays green.",
            "after": {"id": "cmparity-memory", "kind": "memory", "title": "Parity memory",
                      "content": "The harness stays green.", "scope": "local"},
        }],
    }}),
    ("autonomous_status", "[autonomous-status: off]\n\nContinuations: 0/0. Turns: 0/0.", {"display": True, "details": {"enabled": False}}),
]

MARKER_TEXT = "decorations parity transcript complete"

# The persisted shape of a user-typed `/skill:web-search find rust tuis`
# submission (TS `_expandSkillCommand` output): the card renders the name
# collapsed and the content expanded; the args render as their own user
# block below it.
SKILL_BLOCK_MESSAGE = (
    "<skill name=\"web-search\" location=\"/skills/web-search/SKILL.md\">\n"
    "References are relative to /skills/web-search.\n\n"
    "Run one web search and report the titles.\n"
    "</skill>\n\n"
    "find rust tuis"
)
SKILL_CARD_SUMMARY = "[skill] web-search"
SKILL_CARD_BODY = "Run one web search and report the titles."
SKILL_ARGS = "find rust tuis"


def newest_assistant_message(sessions):
    """A real assistant message envelope (api/provider/usage fields) so the
    synthetic replies deserialize in BOTH loaders: the Rust loader degrades
    a malformed message to an unknown entry that renders nothing, which
    would silently drop the rows the verifier waits for. The SMALLEST
    captured envelope wins: replaying a large one ballooned the TS daemon
    to ~12GB RSS on this fixture. The provider/model fields are rewritten
    to a model the TS daemon can restore, so the resumed session does not
    render a model-restore warning the Rust replay would not show."""
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


def session_paths():
    return sorted(
        glob.glob(os.path.expanduser("~/.prime/agent/sessions/**/*.jsonl"), recursive=True),
        key=os.path.getmtime,
    )


def assistant_with(template, text, ms):
    """Clone the captured assistant envelope around one text block. The
    provider/model point at the model the TS daemon restores by default, so
    the resume never renders a model-restore warning."""
    message = json.loads(json.dumps(template))
    message["content"] = [{"type": "text", "text": text}]
    message["provider"] = "prime-inference"
    message["model"] = "z-ai/glm-5.3"
    message["timestamp"] = ms
    return message


def build_session(path, source_header, assistant_template, cwd):
    """Assemble the parity session: one user turn, one assistant reply,
    then every custom row, then a closing assistant reply. The header cwd
    must match the sandbox cwd: the TS resume rejects sessions that belong
    to a different project."""
    # A synthetic root-session header: the TS resume follows a cloned real
    # session id (and its parentSession chain) into the live multi-GB
    # sessions on this box, which ballooned the resume client to ~12GB
    # RSS and wedged the render. Only the wire shape is preserved.
    header = {
        "type": "session",
        "version": source_header.get("version", 3),
        "id": "cmparity-session",
        "cwd": cwd,
        "timestamp": source_header.get("timestamp", "2026-09-18T00:00:00.000Z"),
    }
    entries = [header]
    base_ms = 1_700_000_000_000
    def entry(type_, fields, ms):
        row = {"type": type_}
        row.update(fields)
        # Unique sequential ids: the TS resume follows the parentId chain,
        # and a self-referential id (an earlier bug produced `e0000` for
        # every row) made the TS loader loop until the process ballooned
        # to ~12GB RSS.
        row["id"] = f"e{ms - 1_700_000_000_000:04d}"
        row["parentId"] = entries[-1]["id"]
        row["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ms / 1000))
        return row
    entries.append(entry("message", {
        "message": {"role": "user", "content": "Run the decoration checks.", "timestamp": base_ms},
    }, base_ms))
    base_ms += 1
    entries.append(entry("message", {
        "message": assistant_with(
            assistant_template, "Rows below cover every decorated custom message.", base_ms
        ),
    }, base_ms))
    # One ipython turn that sent an agent message: the sent receipt rows
    # (summary always, body expanded) render inside the tool card on both
    # sides (TS `renderSentAgentMessages`).
    base_ms += 1
    sender = assistant_with(assistant_template, "", base_ms)
    sender["content"] = [
        {"type": "text", "text": "Sending one receipt now."},
        {
            "type": "toolCall",
            "name": "ipython",
            "id": "toolu_sent01",
            "arguments": {"code": "await agent_message.send(\"Ping.\", receiver_role=\"parent\")"},
        },
    ]
    sender["stopReason"] = "toolUse"
    entries.append(entry("message", {"message": sender}, base_ms))
    base_ms += 1
    entries.append(entry("message", {
        "message": {
            "role": "toolResult",
            "toolCallId": "toolu_sent01",
            "toolName": "ipython",
            "content": [{"type": "text", "text": ""}],
            "details": {
                "status": "ok",
                "durationMs": 3,
                "sentAgentMessages": [
                    {
                        "id": "agentmsg_sent01",
                        "message": "Ping.\nThen report back.",
                        "deliveryStatus": "delivered",
                        "receiverRole": "parent",
                        "target": {
                            "activeSessionId": "worker-active",
                            "sessionId": "worker-session",
                            "sessionName": "Worker",
                        },
                    }
                ],
            },
            "isError": False,
            "timestamp": base_ms,
        },
    }, base_ms))
    for custom_type, content, extra in CUSTOM_ROWS:
        base_ms += 1
        fields = {"customType": custom_type, "content": content}
        fields.update(extra)
        entries.append(entry("custom_message", fields, base_ms))
    base_ms += 1
    entries.append(entry("message", {
        "message": {"role": "user", "content": SKILL_BLOCK_MESSAGE, "timestamp": base_ms},
    }, base_ms))
    base_ms += 1
    entries.append(entry("message", {
        "message": assistant_with(assistant_template, MARKER_TEXT, base_ms),
    }, base_ms))
    with open(path, "w") as f:
        for row in entries:
            f.write(json.dumps(row) + "\n")
    return path


def newest_session_header():
    """A real session header (current on-disk format) for the synthetic file."""
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


def normalize(frame, root):
    frame = frame.replace(root, "<SANDBOX>")
    # Pre-existing replay-binary chrome gap (reproduced on origin/main with
    # the box debug binary): the TS resume splash prints its version, the
    # restored model, and the session cwd on the art rows; the Rust replay
    # splash prints `prime agent v` (build-provided version, empty in
    # sandbox builds) and no model/cwd echo, so the splash cannot match
    # row-for-row. The whole splash block (art + label rows) drops from
    # BOTH frames; the diff covers the transcript, which is what this
    # harness owns.
    def chrome_row(line):
        plain = re.sub(r"\x1b\[[0-9;]*m", "", line)
        # The splash ASCII art rows carry the labels, so the whole splash
        # block (any block-element glyph row, plus the label rows) drops
        # from both frames.
        return (
            "prime agent" in plain
            or "cwd" in plain
            or plain.strip().startswith("model ")
            or re.search("[\u2580-\u259f]", plain) is not None
        )
    frame = re.sub(r"v\d+\.\d+\.\d+", "vX.X.X", frame)
    frame = re.sub(r"\b[0-9a-f]{12}\b", "<SID>", frame)
    frame = re.sub(r"\b\d+(\.\d+)?(ms|s)\b", "<T>", frame)
    frame = re.sub(r"\d+(\.\d+)?[kM]? \(\d+%\)", "<TOK> (<PCT>)", frame)
    frame = re.sub(r"[\u2193\u2191] [\d.kM]+ tokens", "<DIR> <TOK> tokens", frame)
    spinners = "".join("\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f")
    frame = re.sub("[" + spinners + "]", "<SPIN>", frame)
    # Third carried divergence (see the module docstring): the heartbeat
    # prompt row's glyph — Rust renders the ◷ clock, TS the ♥ heart. The
    # glyph and its label live in separate styled spans, so the frames
    # compare ANSI-ful: canonicalize the single chars to one marker (no
    # other row carries either glyph in this fixture) so the row's label
    # and schedule still diff; the run separately asserts each side's
    # glyph.
    frame = frame.replace("\u2665", "<HBICON>")
    frame = frame.replace("\u25f7", "<HBICON>")
    # Fourth carried divergence (see the module docstring): the
    # agent-message rows' icon — Rust renders the ✉ mail envelope, TS the
    # ◆ diamond. The diamond ALSO fronts the refinement header row (and
    # the dropped RLM child rows), so the canonicalization is scoped to
    # the agent-message compositions: the glyph followed by its SGR runs
    # and the margin space up to the row label (received/sent/queued all
    # start `Agent message`). The run separately asserts each side's
    # glyph.
    frame = re.sub(
        "[\u25c6\u2709]((?:\x1b\[[0-9;]*m| )*)Agent message",
        r"<AMICON>\1Agent message",
        frame,
    )
    # The label/participant composition (see the module docstring, the
    # operator's 2026-09-25 directive): Rust renders the shared
    # `Agent message` label with the viewer-relative arrow plus the
    # counterpart name only (↓ received, ↑ sent/queued), TS the direction
    # word plus the `from/to <role> <name>` participant. The summary row
    # is its own line, so the whole composition canonicalizes to one
    # marker per frame; the run separately asserts each side's exact row.
    frame = re.sub(r"<AMICON>[^\n]*", "<AMICON><AMROW>", frame)
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
    frame = re.sub("\x1b\[39m\n", "\n", frame)
    frame = re.sub("\n\x1b\[39m(?= )", "\n", frame)
    frame = re.sub("\x1b\[49m\n", "\n", frame)
    frame = re.sub("\n\x1b\[49m(?= )", "\n", frame)
    frame = re.sub(
        r" +((?:\x1b\[[0-9;]*m)*(?:faux-1 \u00b7 )?<TOK> \(<PCT>\)\s*)$",
        r" <TRAY-RIGHT>\1",
        frame,
        flags=re.MULTILINE,
    )
    # The Rust replay harness renders the transcript without the TS
    # client chrome: the top info bar (`cwd ... $0.00`) and the bottom nav
    # bar (`← manage ...`). Drop those rows and trim the viewport blank
    # rows at the frame edges so the diff covers the transcript only.
    kept = []
    for line in frame.split("\n"):
        if "cwd" in line and "$0.00" in line:
            continue
        # The nav arrow and the manage label are separated by ANSI color
        # codes in the capture, so match them independently.
        if "←" in line and "manage" in line:
            continue
        if chrome_row(line):
            continue
        kept.append(line)
    while kept and not kept[0].strip():
        kept.pop(0)
    while kept and not kept[-1].strip():
        kept.pop()
    return "\n".join(kept)


def capture_plain_text(frame):
    """Strip ANSI codes so content assertions match the visible text."""
    return re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", frame)


# The fixture agent-message body (the expandable body of the received
# row; the collapsed row carries no preview since the 2026-09-25
# directive — see the module docstring).
AGENT_MESSAGE_BODY = (
    "Decorations parity: the received row renders with the diamond, "
    "label, and participant."
)

# The RLM child rows (the second carried divergence, see the module
# docstring): the Rust diamond rows replace the TS generic label.
RLM_CHILD_LABELS = [
    ("lane-decorations", "finished"),
    ("boom-worker", "failed"),
    ("cancel-worker", "cancelled"),
]
RLM_CHILD_REASONS = ["the model stream died", "Deleted by parent orchestrator"]
RLM_CHILD_NEEDLES = (
    ["RLM child status", "Last assistant text", "[child-failed", "[child-exited"]
    + RLM_CHILD_REASONS
    + [f"Subagent {name} {outcome}" for name, outcome in RLM_CHILD_LABELS]
)


def strip_rlm_child_rows(frame):
    """Drop the RLM child row lines from BOTH frames: the Rust side renders
    the diamond rows (the headers plus the reason bodies expanded), the TS
    side renders the generic label and the full content markdown. The
    harness separately asserts each side's shapes.

    The row-count divergence also shifts the bottom-anchored viewport: the
    Rust window covers more of the splash region above the transcript than
    the TS one, so background-color escapes land on different rows around
    the first transcript row and extra visually-blank splash spacers leak
    into the normalized frame. Both are anchor artifacts, not render
    regressions, so background escapes drop and blank runs collapse to one
    row (visually blank = whitespace once the ANSI codes are stripped)."""
    def visually_blank(line):
        return re.sub(r"\x1b\[[0-9;]*m", "", line).strip() == ""

    kept = []
    blank = False
    for line in frame.split("\n"):
        plain = re.sub(r"\x1b\[[0-9;]*m", "", line)
        if any(needle in plain for needle in RLM_CHILD_NEEDLES):
            continue
        # Anchor artifact: background escapes whose placement shifts
        # across the row boundary when the window anchors differently.
        line = re.sub(r"\x1b\[4[0-9;]*m", "", line)
        if not visually_blank(line):
            kept.append(line)
            blank = False
            continue
        # Both sides render different row counts here (the Rust rows are
        # one line plus the reason body, the TS side the full content
        # markdown), so blank runs collapse to one blank row before the
        # diff; the dedicated assertions below own the row shapes.
        if not blank:
            kept.append(line)
        blank = True
    # The window-anchor shift shows as extra visually-blank spacers at
    # the frame edges; drop them (normalize's own edge trim only sees
    # ASCII whitespace, not ANSI-only rows).
    while kept and visually_blank(kept[0]):
        kept.pop(0)
    while kept and visually_blank(kept[-1]):
        kept.pop()
    # Keep a trailing newline: normalize's line-boundary escape rules
    # (the `\x1b[39m\n` / `\x1b[49m\n` cleanups) must see the same frame
    # shape on both sides even when the trailing blank rows popped here
    # made the last content row the frame's final line.
    return "\n".join(kept) + ("\n" if kept else "")


def assert_heartbeat_row(side, collapsed, expanded):
    """The heartbeat prompt row contract per side: the Rust frames show the
    ◷ clock glyph (the unified activity dock's Heartbeats icon, the
    operator-directed 2026-09-23 divergence); the TS frames show the ♥
    heart (the baseline the improvement diverges from)."""
    row = " Heartbeat prompt \u00b7 every 10m"
    if side == "rust":
        assert "\u25f7" + row in collapsed, "rust: clock heartbeat row missing collapsed"
        assert "\u25f7" + row in expanded, "rust: clock heartbeat row missing expanded"
        assert "\u2665" not in collapsed, "rust: heart glyph rendered"
        assert "\u2665" not in expanded, "rust: heart glyph rendered expanded"
    else:
        assert "\u2665" + row in collapsed, "ts: heart row missing (baseline)"
        assert "\u2665" + row in expanded, "ts: heart row missing expanded (baseline)"
        assert "\u25f7" + row not in collapsed, "ts: clock glyph rendered"
        assert "\u25f7" + row not in expanded, "ts: clock glyph rendered expanded"


def assert_agent_message_rows(side, collapsed, expanded):
    """The agent-message row contract per side. Icon divergence (the
    Kevin-directed 2026-09-24 directive): the Rust frames render the
    \u2709 mail envelope on every agent-message row (the received
    transcript row and the sent receipt row); the TS frames render the
    \u25c6 diamond (the baseline the divergence moves away from). The
    \u25c6 stays correct on the OTHER diamond rows (the refinement
    header renders on both sides). Label/participant divergence (the
    operator's 2026-09-25 directive): the Rust rows render the shared
    `Agent message` label with the viewer-relative arrow plus the
    counterpart agent's name only (\u2193 received, \u2191 sent/queued);
    the TS rows keep the direction word plus the `from/to <role> <name>`
    participant, and the collapsed Rust row carries no body preview."""
    if side == "rust":
        received = "Agent message \u00b7 \u2193 model-probe"
        sent = "Agent message \u00b7 \u2191 Worker"
        assert "\u2709 " + received in collapsed, (
            "rust: envelope received row missing collapsed"
        )
        assert "\u2709 " + sent in collapsed, "rust: envelope sent row missing collapsed"
        assert "\u25c6 " + received not in collapsed, "rust: diamond received row rendered"
        assert "\u25c6 " + sent not in collapsed, "rust: diamond sent row rendered"
    else:
        received = "Agent message received \u00b7 from child model-probe"
        sent = "Agent message sent \u00b7 to parent Worker"
        assert "\u25c6 " + received in collapsed, "ts: diamond received row missing (baseline)"
        assert "\u25c6 " + sent in collapsed, "ts: diamond sent row missing (baseline)"
        assert "\u2709 " not in collapsed, "ts: envelope glyph rendered"
        assert "\u2709 " not in expanded, "ts: envelope glyph rendered expanded"


def assert_rlm_child_rows(side, collapsed, expanded):
    """The RLM child row contract per side: the Rust frames show the three
    diamond rows (collapsed labels, reason bodies expanded, no reply
    preview anywhere); the TS frames show the old generic label (the
    baseline the improvement diverges from)."""
    if side == "rust":
        for name, outcome in RLM_CHILD_LABELS:
            label = f"\u25c6 Subagent {name} {outcome}"
            assert label in collapsed, f"rust: {label!r} missing collapsed"
            assert label in expanded, f"rust: {label!r} missing expanded"
        for reason in RLM_CHILD_REASONS:
            assert reason not in collapsed, f"rust: reason body visible collapsed: {reason!r}"
            assert reason in expanded, f"rust: reason body missing expanded: {reason!r}"
        assert "Last assistant text" not in collapsed, "rust: reply preview rendered"
        assert "Last assistant text" not in expanded, "rust: reply preview rendered expanded"
        assert "RLM child status" not in collapsed, "rust: old generic label rendered"
    else:
        assert "RLM child status" in collapsed, "ts: generic label missing (baseline)"
        assert "RLM child status" in expanded, "ts: generic label missing expanded (baseline)"
        for name, _outcome in RLM_CHILD_LABELS:
            assert f"Subagent {name}" not in collapsed, "ts: diamond row rendered"



def _sgr_fg_color(run):
    """The foreground color parameter inside one SGR run (truecolor
    `38;2;r;g;b` or 256-color `38;5;N`), None when the run sets no fg."""
    found = re.search(r"38;2;\d+;\d+;\d+|38;5;\d+", run or "")
    return found.group(0) if found else None


def _row_header_runs(frame, label):
    """The SGR runs directly before the diamond marker and the label text
    of one rendered `◆ <label>` header row (the escape-bearing frame):
    (icon_run, label_run) or None when the row never renders."""
    for line in frame.split("\n"):
        plain = re.sub(r"\x1b\[[0-9;]*m", "", line)
        if f"\u25c6 {label}" in plain:
            icon = re.search(r"((?:\x1b\[[0-9;]*m)+)\u25c6", line)
            text = re.search(r"((?:\x1b\[[0-9;]*m)+)" + re.escape(label), line)
            if icon and text:
                return icon.group(1), text.group(1)
    return None


def assert_rlm_child_icon_colors(frames):
    """The icon-follows-text color contract for the Rust RLM child rows
    (Kevin directive 2026-09-23, same directive as the row divergence):
    the diamond marker renders in the row's semantic color — the exact fg
    run the label uses — so the icon no longer stays on the fixed accent.
    The kernel-restored row in the same fixture keeps its accent diamond
    (TS parity), which doubles as the accent baseline the three semantic
    colors must differ from."""
    for state in ("a_collapsed", "b_expanded"):
        frame = frames[state]
        kernel = _row_header_runs(frame, "Restored Python kernel state")
        assert kernel, f"rust: kernel-restored header missing in {state}"
        accent_fg = _sgr_fg_color(kernel[0])
        assert accent_fg, f"rust: kernel diamond carries no fg color in {state}"
        icon_fgs = {}
        for name, outcome in RLM_CHILD_LABELS:
            label = f"Subagent {name} {outcome}"
            runs = _row_header_runs(frame, label)
            assert runs, f"rust: diamond header for {label!r} missing in {state}"
            icon_fg = _sgr_fg_color(runs[0])
            label_fg = _sgr_fg_color(runs[1])
            assert icon_fg, f"rust: {label} diamond carries no fg color in {state}"
            assert label_fg, f"rust: {label} label carries no fg color in {state}"
            assert icon_fg == label_fg, (
                f"rust: {label} diamond fg {icon_fg} != label fg {label_fg} in {state}"
            )
            assert icon_fg != accent_fg, (
                f"rust: {label} diamond still on the accent color in {state}"
            )
            icon_fgs[label] = icon_fg
        assert len(set(icon_fgs.values())) == len(RLM_CHILD_LABELS), (
            f"rust: the three RLM child outcomes share one icon color in {state}: {icon_fgs}"
        )


def assert_sent_reach(side, collapsed, expanded):
    """The Ctrl+O contract for this fixture: collapsed frames show the
    agent-message and sent-receipt summaries only; the expanded frames show
    the \u2570\u2500-guttered bodies. Any miss means the expand toggle
    does not reach the agent-message rows. The summary strings follow the
    per-side row contract (see assert_agent_message_rows)."""
    if side == "rust":
        assert "Agent message \u00b7 \u2193 model-probe" in collapsed, (
            f"{side}: summary missing collapsed"
        )
        assert "Agent message \u00b7 \u2191 Worker" in collapsed, (
            f"{side}: sent receipt summary missing collapsed"
        )
    else:
        assert "Agent message received" in collapsed, f"{side}: summary missing collapsed"
        assert "Agent message sent \u00b7 to parent Worker" in collapsed, (
            f"{side}: sent receipt summary missing collapsed"
        )
    assert "\u2570\u2500 Decorations parity" not in collapsed, (
        f"{side}: received body visible while collapsed"
    )
    assert "\u2570\u2500 Ping." not in collapsed, f"{side}: sent body visible while collapsed"
    assert "\u2570\u2500 Decorations parity" in expanded, (
        f"{side}: Ctrl+O did not expand the received body"
    )
    assert "\u2570\u2500 Ping." in expanded, (
        f"{side}: Ctrl+O did not expand the sent body"
    )


def assert_skill_reach(side, collapsed, expanded):
    """The skill-invocation card contract: collapsed shows the one-line
    `[skill] <name>` card and the args user block; expanded adds the
    markdown body; the raw block text never floods either state."""
    assert SKILL_CARD_SUMMARY in collapsed, f"{side}: skill card summary missing collapsed"
    assert SKILL_ARGS in collapsed, f"{side}: skill args missing collapsed"
    assert SKILL_CARD_BODY not in collapsed, f"{side}: skill body visible while collapsed"
    assert "<skill name=" not in collapsed, f"{side}: raw skill block visible collapsed"
    assert SKILL_CARD_BODY in expanded, f"{side}: Ctrl+O did not expand the skill body"
    assert "<skill name=" not in expanded, f"{side}: raw skill block visible expanded"
    assert SKILL_ARGS in expanded, f"{side}: skill args missing expanded"


# The refinement row's expanded content (the third carried divergence, see
# the module docstring): the needles cover the expanded block's rows —
# the expanded summary, the meta, the edit section (label, fields, diff
# content) — all unique to the expanded state; the collapsed rows carry no
# branch geometry and stay in the byte diff.
REFINEMENT_EXPANSION_NEEDLES = [
    "Create one local memory.",  # the expanded summary (branch-guttered Rust)
    "Refinement refine_cmparity",  # the meta row
    "cmparity-memory",  # the edit-section label
    "Parity memory",  # the Title diff content
    "The harness stays green.",  # the Description value
]


def split_refinement_expansion(frame, state):
    """Split the refinement row's expanded rows out of the frame,
    returning `(kept, removed)`.

    The kept rows byte-diff (the expanded state's rows hang on the
    branch grammar on the Rust side — the carried indent divergence; the
    collapsed state is untouched). The removed rows do NOT leave the
    comparison: `assert_refinement_content` matches their visible
    content word for word, so a truncated, omitted, or changed
    Title/Description/section value fails the run instead of vanishing
    from the byte diff. The field-label rows match by exact stripped
    text (an indented `Title` on the Rust side, a plain-inset `Title` on
    the TS side)."""
    if state != "b_expanded":
        return frame, []
    kept, removed = [], []
    for line in frame.split("\n"):
        plain = re.sub(r"\x1b\[[0-9;]*m", "", line)
        if any(needle in plain for needle in REFINEMENT_EXPANSION_NEEDLES):
            removed.append(line)
            continue
        if plain.strip() in ("Title", "Description"):
            removed.append(line)
            continue
        kept.append(line)
    return "\n".join(kept), removed


def assert_refinement_content(ts_removed, rust_removed):
    """The removed expansion rows' visible content must match between the
    products: ANSI-stripped, the branch gutter glyphs dropped, whitespace
    collapsed. The intended divergence is the indentation and the wrap
    points the narrower branch content width forces — never the values
    themselves, so the comparison is over words, not bytes. A frame that
    never rendered the block fails loudly (the removed set is empty)."""

    def collapsed_content(rows):
        text = capture_plain_text("\n".join(rows))
        return re.sub(r"\s+", " ", text.replace("╰─", " ")).strip()

    ts = collapsed_content(ts_removed)
    rust = collapsed_content(rust_removed)
    assert ts, "ts: the refinement expansion rows are missing from the frame"
    assert rust, "rust: the refinement expansion rows are missing from the frame"
    assert ts == rust, (
        "the refinement expansion content differs:\n"
        f"  ts:   {ts}\n"
        f"  rust: {rust}"
    )


def assert_refinement_branch(side, collapsed, expanded):
    """The third carried divergence: the Rust expanded refinement block
    hangs on the branch grammar (the `╰─ ` gutter off the
    `◆` header, four-space continuation indent); the TS binary keeps
    the plain one-column chat inset (the baseline)."""
    summary = "Create one local memory."
    meta = "Harness refined · 1 memory created · Refinement refine_cmparity · local"
    gutter = "╰─ "
    indent = "    "
    if side == "rust":
        # Collapsed keeps the TS shape: plain inset, no branch.
        assert " " + summary in collapsed, f"rust: summary missing collapsed"
        assert gutter + summary not in collapsed, "rust: branch rendered collapsed"
        # Expanded hangs the summary on the gutter, the meta on the
        # continuation indent, the edit section re-branches.
        assert " " + gutter + summary in expanded, "rust: expanded summary missing the branch gutter"
        assert indent + meta in expanded, "rust: meta missing the continuation indent"
        assert " " + gutter + "Created local memory `cmparity-memory`" in expanded, (
            "rust: edit-section label missing the branch gutter"
        )
        assert indent + "Compacted" not in expanded
    else:
        assert " " + summary in expanded, "ts: summary missing expanded (baseline)"
        assert gutter + summary not in expanded, "ts: unexpectedly renders the branch"
        assert " " + meta in expanded, "ts: meta missing expanded (baseline)"
        assert " " + "Created local memory `cmparity-memory`" in expanded, (
            "ts: edit-section label missing expanded (baseline)"
        )


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
    at details, the Rust replay at overview), so fixed press counts
    desync the compared states: drive both sides to the same label
    instead."""
    for _ in range(max_presses):
        if mode_label(session) == target:
            return True
        tmux("send-keys", "-t", session, "C-o")
        time.sleep(1.2)
    return mode_label(session) == target


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


def run_ts(session_path, sandbox, size, out_dir):
    session = f"cmparity-ts-{size[0]}x{size[1]}"
    tmux("kill-session", "-t", session, check=False)
    tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        size[0],
        "-y",
        size[1],
        "-c",
        sandbox["cwd"],
        # A plain shell: the box tmux default-shell is herdr's prime-agent
        # launcher (every new pane boots a live agent TUI, hijacking the
        # harness's send-keys contract). herdr's documented opt-out keeps
        # the pane a plain interactive shell.
        "-e",
        "HERDR_PLAIN_SHELL=1",
    )
    env = (
        f"HOME={sandbox['home']} "
        f"TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    # A dedicated daemon socket keeps the sandbox main daemon off the
    # shared socket path; the isolated TMPDIR keeps its supervisor off
    # the shared box root too, so the cleanup reap can sweep both.
    command = (
        f"{env} prime-agent --daemon-socket {sandbox['agent']}/daemon.sock "
        f"--offline -r {session_path}"
    )
    tmux("send-keys", "-t", session, command, "Enter")
    wait_for(session, MARKER_TEXT, timeout=60)
    time.sleep(1.5)
    # Label-driven states: both sides park at Collapsed for the first
    # capture, then drive to Expanded for the second (fixed press counts
    # desync: the TS resume starts at details, the Rust at overview).
    if not press_until_mode(session, "Collapsed"):
        raise TimeoutError(f"session {session} never reached Collapsed mode")
    frames = {"a_collapsed": capture(session)}
    if not press_until_mode(session, "Expanded"):
        raise TimeoutError(f"session {session} never reached Expanded mode")
    time.sleep(0.5)
    frames["b_expanded"] = capture(session)
    tmux("kill-session", "-t", session, check=False)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"ts-{state}-{size[0]}x{size[1]}.txt"), "w") as f:
            f.write(frame)
    return frames


def run_rust(session_path, sandbox, size, out_dir):
    session = f"cmparity-rust-{size[0]}x{size[1]}"
    tmux("kill-session", "-t", session, check=False)
    tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        size[0],
        "-y",
        size[1],
        "-c",
        sandbox["cwd"],
        # A plain shell: the box tmux default-shell is herdr's prime-agent
        # launcher (every new pane boots a live agent TUI, hijacking the
        # harness's send-keys contract). herdr's documented opt-out keeps
        # the pane a plain interactive shell.
        "-e",
        "HERDR_PLAIN_SHELL=1",
    )
    rust = os.environ.get(
        "PA_RUST_REPLAY",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "pa-tui-replay"),
    )
    env = f"HOME={sandbox['home']}"
    command = f"{env} {rust} {session_path}"
    tmux("send-keys", "-t", session, command, "Enter")
    wait_for(session, MARKER_TEXT, timeout=60)
    time.sleep(1.5)
    if not press_until_mode(session, "Collapsed"):
        raise TimeoutError(f"session {session} never reached Collapsed mode")
    frames = {"a_collapsed": capture(session)}
    if not press_until_mode(session, "Expanded"):
        raise TimeoutError(f"session {session} never reached Expanded mode")
    time.sleep(0.5)
    frames["b_expanded"] = capture(session)
    tmux("kill-session", "-t", session, check=False)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"rust-{state}-{size[0]}x{size[1]}.txt"), "w") as f:
            f.write(frame)
    return frames


def prepare_sandbox(base):
    cwd = os.path.join(base, "cwd")
    os.makedirs(cwd, exist_ok=True)
    sandboxes = {}
    for binary in ("ts", "rust"):
        home = os.path.join(base, binary, "home")
        agent = os.path.join(base, binary, "agent")
        tmp = os.path.join(base, binary, "tmp")
        os.makedirs(home, exist_ok=True)
        os.makedirs(tmp, exist_ok=True)
        os.makedirs(os.path.join(agent, "sessions"), exist_ok=True)
        with open(os.path.join(agent, "settings.json"), "w") as f:
            json.dump({"onboardingCompleted": True}, f)
        # The isolated TMPDIR keeps the TS supervisor's socket (the
        # default daemon-socket dir) off the shared box root, so the
        # cleanup reap can sweep the side's daemons by path alone.
        sandboxes[binary] = {"home": home, "agent": agent, "cwd": cwd, "tmp": tmp}
    return sandboxes


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

    base = tempfile.mkdtemp(prefix="custom-message-parity-")
    out_dir = args.out or tempfile.mkdtemp(prefix="custom-message-captures-")
    sandboxes = prepare_sandbox(base)
    sessions = session_paths()
    session_path = build_session(
        os.path.join(base, "parity-session.jsonl"),
        newest_session_header(),
        newest_assistant_message(sessions),
        os.path.join(base, "cwd"),
    )
    print(f"session: {session_path}")
    failures = []
    try:
        if args.only:
            runner = run_ts if args.only == "ts" else run_rust
            frames = runner(session_path, sandboxes[args.only], sizes[0], out_dir)
            print(f"captures for {args.only} in {out_dir}: {sorted(frames)}")
            return 0
        for size in sizes:
            ts_frames = run_ts(session_path, sandboxes["ts"], size, out_dir)
            rust_frames = run_rust(session_path, sandboxes["rust"], size, out_dir)
            # The Ctrl+O reach check: the agent-message bodies (the
            # \u2570\u2500 gutter) must be absent collapsed and present
            # expanded on BOTH sides.
            for side, frames in (("ts", ts_frames), ("rust", rust_frames)):
                collapsed = capture_plain_text(frames["a_collapsed"])
                expanded = capture_plain_text(frames["b_expanded"])
                assert_sent_reach(side, collapsed, expanded)
                assert_rlm_child_rows(side, collapsed, expanded)
                assert_heartbeat_row(side, collapsed, expanded)
                assert_agent_message_rows(side, collapsed, expanded)
                assert_skill_reach(side, collapsed, expanded)
                assert_refinement_branch(side, collapsed, expanded)
                # The icon-follows-text color contract (the same directive as
                # the row divergence): the escape-bearing Rust frames carry
                # it; the TS frames have no icon to check (the generic label).
                assert_rlm_child_icon_colors(rust_frames)
            for state in ("a_collapsed", "b_expanded"):
                ts_kept, ts_removed = split_refinement_expansion(
                    strip_rlm_child_rows(ts_frames[state]), state
                )
                rust_kept, rust_removed = split_refinement_expansion(
                    strip_rlm_child_rows(rust_frames[state]),
                    state,
                )
                # The expanded block's rows leave the byte diff (the
                # carried indent divergence) but not the comparison: their
                # content must match word for word.
                if state == "b_expanded":
                    assert_refinement_content(ts_removed, rust_removed)
                ts_norm = normalize(ts_kept, base)
                rust_norm = normalize(rust_kept, base)
                # The carried label/arrow divergence: the collapsed Rust
                # row carries no body preview (the 2026-09-25 directive),
                # exactly like the TS header — the body only opens up in
                # the expanded view (the `\u2570\u2500` gutter, never the
                # `\u00b7` preview segment).
                rust_plain = capture_plain_text(rust_frames[state])
                assert " \u00b7 " + AGENT_MESSAGE_BODY[:40] not in rust_plain, (
                    f"rust preview rendered in {state}"
                )
                assert " \u00b7 " + AGENT_MESSAGE_BODY[:40] not in capture_plain_text(
                    ts_frames[state]
                ), f"ts unexpectedly renders the preview in {state}"
                name = f"{state}-{size[0]}x{size[1]}"
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
