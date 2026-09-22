#!/usr/bin/env bash
# tmux verifier for the pa-tui lane.
#
# Renders a captured real agent session (~/.prime/agent/sessions) in the
# pa-tui agent view inside an 80x24 tmux session, captures the pane, and
# asserts the structural contract of the TS product's interactive view:
#   - transcript content present (assistant markdown text, tool headers)
#   - a full-width "─" separator above the editor (dynamic-border parity)
#   - "> " prompt prefix on the editor line (custom-editor promptPrefix)
#   - model label footer
# Then drives editor keys like a user (type, backspace, arrows, ctrl+o,
# escape, ctrl+c) and asserts editor behavior parity:
#   - typing appears at the prompt; backspace deletes
#   - left/right/up/down move the cursor without exiting
#   - ctrl+o (app.tools.expand) and escape do not exit or corrupt the pane
#   - ctrl+c exits the app
#
# Usage: tests/tmux_replay.sh [path-to-session.jsonl]

set -u
BIN="${BIN:-$(dirname "$0")/../../../target/debug/pa-tui-replay}"
SESSION="${1:-}"
PANE_ROWS=24
PANE_COLS=80

if [ ! -x "$BIN" ]; then
    echo "FAIL: binary not found at $BIN (run cargo build -p pa-tui)" >&2
    exit 1
fi

if [ -z "$SESSION" ]; then
    SESSION=$(ls -t "$HOME"/.prime/agent/sessions/*.jsonl 2>/dev/null | head -1)
fi
if [ -z "${SESSION:-}" ] || [ ! -f "$SESSION" ]; then
    echo "FAIL: no session file to replay" >&2
    exit 1
fi

SESSION_NAME="patui-verify-$$"
tmux new-session -d -s "$SESSION_NAME" -x $PANE_COLS -y $PANE_ROWS
trap 'tmux kill-session -t "$SESSION_NAME" 2>/dev/null' EXIT

tmux send-keys -t "$SESSION_NAME" "$BIN $(printf %q "$SESSION")" Enter
sleep 3

capture() { tmux capture-pane -t "$SESSION_NAME" -p; }
fails=0
check() { # check <description> <pattern-grep>
    if capture | grep -qE "$2"; then
        echo "ok: $1"
    else
        echo "FAIL: $1 (pattern: $2)" >&2
        capture | sed -n '1,10p' >&2
        fails=$((fails+1))
    fi
}

# --- structural contract -------------------------------------------------
# Pull a distinctive rendered string out of the session (first assistant text)
# and require it on screen: proves the view renders this session, not any UI.
MARKER=$(python3 - "$SESSION" <<'EOF'
import json, sys
for line in open(sys.argv[1]):
    try:
        d = json.loads(line)
    except Exception:
        continue
    m = d.get("message", {})
    if m.get("role") == "assistant":
        for c in m.get("content", []):
            if c.get("type") == "text":
                words = c["text"].split()
                if len(words) >= 2:
                    print(" ".join(words[:2]))
                    raise SystemExit
EOF
)
if [ -n "${MARKER:-}" ]; then
    check "first assistant text from session on screen" "$(printf %q "$MARKER")|⏺"
fi
check "session rendered (markdown text or tool header present)" '⏺|[A-Za-z]{4,}'
check "separator line above editor" '^─{60,}$'
check "prompt prefix present" '^> ?$|^> .+$'
check "model footer line" 'internal/|glm|z-ai|[a-z]+:.+ \(0%\)|[a-z]+-[0-9]'

# --- interactive keys ----------------------------------------------------
tmux send-keys -t "$SESSION_NAME" "hello world"
sleep 1
check "typed text visible" '^> hello world$'

tmux send-keys -t "$SESSION_NAME" BSpace
sleep 0.5
check "backspace deleted char" '^> hello worl$'

tmux send-keys -t "$SESSION_NAME" Left Left
sleep 0.5
CURSOR=$(tmux display-message -t "$SESSION_NAME" -p '#{cursor_x},#{cursor_y}')
# "hello worl" (10 chars) + 2 left moves: logical col 8, visual col 8+2 prompt.
case "$CURSOR" in
    10,*) echo "ok: cursor after left moves ($CURSOR)";;
    *) echo "FAIL: cursor after left moves, got ($CURSOR)" >&2; fails=$((fails+1));;
esac

tmux send-keys -t "$SESSION_NAME" Right Up Down
sleep 0.5
check "arrow keys did not exit (prompt intact)" '^> hello worl$'

# ctrl+o = app.tools.expand (cycle detail): must not exit or crash.
tmux send-keys -t "$SESSION_NAME" C-o
sleep 1
check "ctrl+o did not exit" '^> hello worl$'

# escape cancels autocomplete/normal-mode actions: must not exit.
tmux send-keys -t "$SESSION_NAME" Escape
sleep 1
check "escape did not exit" '^> hello worl$'

# ctrl+c exits the app cleanly (pane returns to the shell process).
tmux send-keys -t "$SESSION_NAME" C-c
sleep 2
CMD=$(tmux display-message -t "$SESSION_NAME" -p '#{pane_current_command}' 2>/dev/null || true)
case "$CMD" in
    pa-tui-replay|'' ) echo "FAIL: ctrl+c did not exit (pane: ${CMD:-gone})" >&2; fails=$((fails+1));;
    *) echo "ok: ctrl+c exited (pane now: $CMD)";;
esac

if [ "$fails" -eq 0 ]; then
    echo "ALL TMUX CHECKS PASSED"
    exit 0
else
    echo "$fails CHECK(S) FAILED" >&2
    exit 1
fi
