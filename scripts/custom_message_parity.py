#!/usr/bin/env python3
"""Custom-message decoration parity verifier: frame-diff the Rust TUI
against the installed TS prime-agent binary rendering the SAME session
transcript containing every decorated custom-message row:

  - a received agent message (diamond + participant + preview + body),
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

One documented divergence (Kevin directive 2026-09-21, live dogfood): the
Rust received agent-message header renders the collapsed one-line body
preview (`... \u00b7 <preview>`) that the TS `agentMessageSummaryLine`
signature supports but no current TS caller passes. The diff normalizes
that preview segment out of the Rust frames and the run separately asserts
the preview IS present; the TS side is expected to adopt the same preview
so the normalization can be dropped.

Second documented divergence (Kevin directive 2026-09-23, product
improvement BEYOND TS): the RLM child rows render the
`\u25c6 Subagent <name> finished|failed|cancelled` diamond rows on the Rust
side (accent diamond, semantic label colors, the failure error and the
cancellation reason as the expandable body, no reply-preview anywhere),
where the TS binary still shows the generic muted `RLM child status` label
over the full content markdown. The diff drops the RLM child rows from
BOTH frames and the run separately asserts the Rust diamond rows ARE
present (collapsed labels, expanded reason bodies, no preview) and the TS
frames show the old generic label (the baseline the TS team is expected to
adopt).

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


# The fixture agent-message body (the Rust-only preview source, see the
# module docstring for the divergence).
AGENT_MESSAGE_BODY = (
    "Decorations parity: the received row renders with the diamond, "
    "label, and participant."
)


def strip_rust_agent_message_preview(frame):
    """Remove the Rust-only collapsed body preview segment
    (`\u00b7 <preview>`) from the received agent-message header so the
    frame diff covers the shapes the TS binary renders today. The harness
    separately asserts the preview IS present on the Rust side."""
    return re.sub(
        r" \u00b7 " + re.escape(AGENT_MESSAGE_BODY[:40]) + r"[^\n]*", "", frame
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


def assert_sent_reach(side, collapsed, expanded):
    """The Ctrl+O contract for this fixture: collapsed frames show the
    agent-message and sent-receipt summaries only; the expanded frames show
    the \u2570\u2500-guttered bodies. Any miss means the expand toggle
    does not reach the agent-message rows."""
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
    tmux("new-session", "-d", "-s", session, "-x", size[0], "-y", size[1], "-c", sandbox["cwd"])
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
    frames = {"a_collapsed": capture(session)}
    # Ctrl+O twice: all mode (expanded bodies and shell output).
    tmux("send-keys", "-t", session, "C-o")
    tmux("send-keys", "-t", session, "C-o")
    time.sleep(1.5)
    frames["b_expanded"] = capture(session)
    tmux("kill-session", "-t", session, check=False)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"ts-{state}-{size[0]}x{size[1]}.txt"), "w") as f:
            f.write(frame)
    return frames


def run_rust(session_path, sandbox, size, out_dir):
    session = f"cmparity-rust-{size[0]}x{size[1]}"
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", size[0], "-y", size[1], "-c", sandbox["cwd"])
    rust = os.environ.get(
        "PA_RUST_REPLAY",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "pa-tui-replay"),
    )
    env = f"HOME={sandbox['home']}"
    command = f"{env} {rust} {session_path}"
    tmux("send-keys", "-t", session, command, "Enter")
    wait_for(session, MARKER_TEXT, timeout=60)
    time.sleep(1.5)
    frames = {"a_collapsed": capture(session)}
    tmux("send-keys", "-t", session, "C-o")
    tmux("send-keys", "-t", session, "C-o")
    time.sleep(1.5)
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
                assert_skill_reach(side, collapsed, expanded)
            for state in ("a_collapsed", "b_expanded"):
                ts_norm = normalize(strip_rlm_child_rows(ts_frames[state]), base)
                rust_norm = normalize(
                    strip_rlm_child_rows(strip_rust_agent_message_preview(rust_frames[state])),
                    base,
                )
                # The carried divergence: the Rust header shows the
                # collapsed preview; the TS binary does not (yet).
                rust_plain = capture_plain_text(rust_frames[state])
                assert " \u00b7 " + AGENT_MESSAGE_BODY[:40] in rust_plain, (
                    f"rust preview missing in {state}"
                )
                assert " \u00b7 " + AGENT_MESSAGE_BODY[:40] not in capture_plain_text(
                    ts_frames[state]
                ), f"ts unexpectedly renders the preview in {state}"
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
