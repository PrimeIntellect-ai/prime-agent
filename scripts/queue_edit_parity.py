#!/usr/bin/env python3
"""Queue-edit parity (TS vs Rust), tmux frame-diff, both key byte forms.

The queue-edit flow under test (TS keybindings.ts + custom-editor.ts):
alt+up selects a parked steer/follow-up message - its text loads into the
editor with the dim browse header; alt+down walks back to the draft;
Enter re-queues the edit onto the steering lane (the daemon-side
`mutate_queued_message` replace, TS `enter steers`); an empty submit
deletes; Escape cancels back to the draft.

Two byte forms drive the same "alt+up" identity:

- the xterm parameter form `\x1b[1;3A` (tmux M-Up) — both products
  handle it natively, so the TS and Rust captures diff byte-exact per
  state (strip rows, browse header, editor text row);
- the meta-wrapped form `\x1b\x1b[A` (macOS Terminal "use option as
  meta key") — TS-main's keys.test.ts pins the wrapped identity
  (matchesKey("\x1b\x1b[1;5A", "ctrl+alt+up") et al.), but the live TS
  pipeline splits the bytes first (StdinBuffer extractCompleteSequences
  emits `\x1b\x1b`, then `[`, `A`; observed: the escape-repeat arms, the
  session tree opens, the turn aborts and the queue drains). The Rust
  reader repairs the wrapped identity instead (merge_legacy_meta_escapes),
  so the Rust wrapped capture must equal the Rust parameter capture
  byte-exact — the same "alt+up" identity reaching the same states.

Exit code is non-zero when any state differs.

Reuses the visual_parity faux-provider harness (tmux rules: default
socket, vplane-* session names, sessions killed individually) and the
#226 shared daemon reap.
"""

import argparse
import difflib
import glob
import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import visual_parity as vp
import queue_parity as qp

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

STEERING_PROMPT = "steering prompt text"
FOLLOW_UP_PROMPT = "follow-up prompt text"
EDITED_PROMPT = f"{FOLLOW_UP_PROMPT} edited"
DRAFT = "draft text"
FIRST_PROMPT = "tell me something slowly"

STEERING_ROW = f"Steering: {STEERING_PROMPT}"
FOLLOW_UP_ROW = f"Follow-up: {FOLLOW_UP_PROMPT}"
EDITED_ROW = f"Steering: {EDITED_PROMPT}"
HINT_ROW = "to browse and edit queued messages"
# The browse header is the only surface that quotes the affordances ("enter
# steers"); the strip hint row only says "browse and edit".
HEADER_MARK = "enter steers"

# Turn 1 streams long enough (600 tokens at 6 tokens/s) to cover the whole
# edit flow; the remaining queue delivers at the boundary afterwards.
QUEUE_EDIT_FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": vp.TS_SCRIPT_MODEL,
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 6,
    "responses": [
        {
            "content": [
                {
                    "type": "text",
                    "text": "The first turn streams slowly for a very long time so the parked queue has plenty of time to be browsed and edited before this turn settles and the queue drains. " * 8,
                }
            ]
        },
        {"content": [{"type": "text", "text": "steering delivered"}]},
        {"content": [{"type": "text", "text": "follow-up delivered"}]},
    ],
}

# The meta-wrapped byte forms macOS Terminal sends with "use option as
# meta key" (TS matchesKey's double-ESC branch): Option+Up/Down wrap the
# whole arrow sequence in an extra ESC.
WRAPPED_UP = "\x1b\x1b[A"
WRAPPED_DOWN = "\x1b\x1b[B"


def default_ts_binary():
    """The ts side's launch command: the TS-main CLI from the parity
    ground-truth checkout, resolved absolutely. Two rules drive this:

    - the box PATH `prime-agent` may itself be the Rust dogfood install
      (and the tmux SERVER resolves pane commands through its own PATH),
      so the harness never launches a bare `prime-agent`;
    - the DEPLOYED 0.9.5 release binary predates TS matchesKey's
      double-ESC branch (observed: the wrapped form opens the session
      tree via the escape-repeat and types the `[A` tail literally), so
      the wrapped-byte flow must be compared against TS-main.

    PA_TS_BINARY overrides (an absolute path or a full command string).
    """
    override = os.environ.get("PA_TS_BINARY")
    if override:
        return override
    ts_main_cli = os.path.join(
        "/home/ubuntu/prime-agent", "packages", "coding-agent", "dist", "bundle", "cli.js"
    )
    if os.path.exists(ts_main_cli):
        return f"node {ts_main_cli}"
    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    candidates = sorted(glob.glob(os.path.join(releases, "0.9.5-linux-x64-*", "prime-agent")))
    if not candidates:
        raise SystemExit("neither the TS-main checkout nor a deployed TS release found; set PA_TS_BINARY")
    return candidates[-1]


def send_wrapped(session, sequence):
    """One literal write of the wrapped byte form (one terminal write, so
    the app's reader folds it exactly like macOS Terminal sends it)."""
    vp.tmux("send-keys", "-t", session, "-l", sequence)


def prepare_edit_sandbox(base):
    """The visual_parity fixture with the queue-edit faux script (a long
    slow first turn so the parked queue survives the whole edit flow)."""
    shared_cwd, _, sandboxes = vp.prepare_sandbox(base)
    script_path = os.path.join(base, "queue-edit-faux-script.json")
    with open(script_path, "w") as f:
        json.dump(QUEUE_EDIT_FAUX_SCRIPT, f, indent=2)
    return shared_cwd, script_path, sandboxes


def settle(session, samples=2, gap=0.4):
    """Wait until two captures agree (the attach chrome settles before any
    typed key dispatches on a transcript the attach rebuilds)."""
    last = vp.capture(session)
    stable = 0
    for _ in range(120):
        time.sleep(gap)
        current = vp.capture(session)
        if current == last:
            stable += 1
            if stable >= samples:
                return
        else:
            stable = 0
        last = current
    raise RuntimeError("the pane never settled after attach")


def send_up(session, key_form):
    """One Option+Up press in the given byte form."""
    if key_form == "wrapped":
        send_wrapped(session, WRAPPED_UP)
    else:
        vp.tmux("send-keys", "-t", session, "M-Up")


def send_down(session, key_form):
    """One Option+Down press in the given byte form."""
    if key_form == "wrapped":
        send_wrapped(session, WRAPPED_DOWN)
    else:
        vp.tmux("send-keys", "-t", session, "M-Down")


def run_edit_session(binary, sandbox, shared_cwd, script_path, size, out_dir, prefix, key_form):
    """Drive one binary through the queue-edit states with one key byte
    form; the capture names carry the form so the two Rust runs compare."""
    width, height = size
    session = f"vplane-{binary}-qedit-{width}x{height}"
    vp.tmux("kill-session", "-t", session, check=False)
    vp.tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height), "-c", shared_cwd)
    env = (
        f"HOME={sandbox['home']} "
        f"TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
        f"PRIME_AGENT_FAUX_SCRIPT={script_path} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    if binary == "ts":
        command = (
            f"{default_ts_binary()} --daemon-socket {sandbox['agent']}/daemon.sock "
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
    # Mode-neutral boot marker: TS-main opens in Details mode, the Rust
    # build (and the deployed 0.9.5 release) in Collapsed mode.
    try:
        vp.wait_for(session, "mode (Ctrl+O to expand)", timeout=90)
    except TimeoutError:
        print(f"[{binary}] boot timeout; pane contents:")
        print(vp.capture(session))
        vp.tmux("kill-session", "-t", session, check=False)
        raise
    settle(session)

    # The slow turn streams; park one steering prompt and one follow-up.
    vp.tmux("send-keys", "-t", session, FIRST_PROMPT)
    vp.tmux("send-keys", "-t", session, "Enter")
    vp.wait_for(session, "streams slowly", timeout=60)
    vp.tmux("send-keys", "-t", session, STEERING_PROMPT)
    vp.tmux("send-keys", "-t", session, "Enter")
    vp.tmux("send-keys", "-t", session, FOLLOW_UP_PROMPT)
    vp.tmux("send-keys", "-t", session, "M-Enter")
    qp_wait_plain(session, FOLLOW_UP_ROW, timeout=30)
    qp_wait_plain(session, STEERING_ROW, timeout=15)

    # A visible draft: the stash/restore shows through every state.
    vp.tmux("send-keys", "-t", session, "-l", DRAFT)
    time.sleep(0.5)

    frames = {}

    # (b1) select: alt+up picks the newest parked message (the follow-up);
    # its text loads into the editor, the header appears.
    send_up(session, key_form)
    qp_wait_plain(session, "follow-up 1", timeout=15)
    time.sleep(0.5)
    frames[f"b1_select_{key_form}"] = vp.capture(session)

    # (b2) edit + re-queue: append " edited" and Enter - the replace moves
    # the item onto the steering lane (TS `enter steers`), the header
    # clears and the stashed draft restores.
    vp.tmux("send-keys", "-t", session, "-l", " edited")
    vp.tmux("send-keys", "-t", session, "Enter")
    qp_wait_plain(session, EDITED_ROW, timeout=15)
    qp_wait_plain(session, HEADER_MARK, gone=True, timeout=15)
    time.sleep(0.5)
    frames[f"b2_requeued_{key_form}"] = vp.capture(session)

    # (b3) cancel: alt+up selects the newest (the edited item, "steering
    # 2"), alt+down walks past it back to the draft.
    send_up(session, key_form)
    qp_wait_plain(session, "steering 2", timeout=15)
    send_down(session, key_form)
    qp_wait_plain(session, HEADER_MARK, gone=True, timeout=15)
    time.sleep(0.5)
    frames[f"b3_cancel_{key_form}"] = vp.capture(session)

    # (b4) empty deletes: select the edited item, backspace it empty, Enter
    # - the delete mutation drops the row and the draft restores.
    send_up(session, key_form)
    qp_wait_plain(session, "steering 2", timeout=15)
    for _ in range(len(EDITED_PROMPT)):
        vp.tmux("send-keys", "-t", session, "Bspace")
    vp.tmux("send-keys", "-t", session, "Enter")
    qp_wait_plain(session, EDITED_ROW, gone=True, timeout=15)
    qp_wait_plain(session, HEADER_MARK, gone=True, timeout=15)
    time.sleep(0.5)
    frames[f"b4_delete_{key_form}"] = vp.capture(session)

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


def qp_wait_plain(session, needle, timeout=30, gone=False):
    qp.wait_plain(session, needle, timeout=timeout, gone=gone)


def state_rows(frame, markers):
    """The rows of one frame containing any marker, ANSI bytes intact."""
    return qp.styled_rows(frame, markers)


def require_absent(frame, text, state):
    if text in qp.strip_ansi(frame):
        raise RuntimeError(f"scenario drift in {state}: {text!r} still on screen")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", default="120x36")
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--out", default=None)
    parser.add_argument("--only", default=None, choices=("ts", "rust"))
    parser.add_argument("--key-form", default="param", choices=("param", "wrapped"))
    parser.add_argument("--session-prefix", default="vp")
    args = parser.parse_args()
    width, height = args.size.split("x")
    size = (str(width), str(height))

    if args.only in (None, "ts"):
        # The TS-main CLI prints `--version` on stderr; merge it so the
        # guard's stdout probe sees it (the pane command stays clean).
        ts_identity.assert_ts_side_is_the_ts_product(ts_bin=f"{default_ts_binary()} 2>&1")

    # Short base path: the daemon's worker socket lives under
    # `$TMPDIR/prime-agent-1000/worker-<id>.sock` and AF_UNIX paths cap at
    # 108 bytes — the default descriptive prefix pushed the worker path
    # past it (the worker dies with `listen EINVAL`).
    base = tempfile.mkdtemp(prefix="qe-", dir="/tmp")
    out_dir = args.out or tempfile.mkdtemp(prefix="queue-edit-captures-")
    shared_cwd, script_path, sandboxes = prepare_edit_sandbox(base)
    STATES = ("b1_select", "b2_requeued", "b3_cancel", "b4_delete")
    try:
        if args.only:
            run_edit_session(
                args.only, sandboxes[args.only], shared_cwd, script_path, size, out_dir,
                args.session_prefix, args.key_form,
            )
            print(f"captures for {args.only} in {out_dir}")
            return 0
        # The flow parity: both products driven with the parameter form.
        ts_frames = run_edit_session(
            "ts", sandboxes["ts"], shared_cwd, script_path, size, out_dir, args.session_prefix, "param"
        )
        rust_frames = run_edit_session(
            "rust", sandboxes["rust"], shared_cwd, script_path, size, out_dir, args.session_prefix, "param"
        )
        # The wrapped repair: the Rust build driven with the meta-wrapped
        # bytes must reach the same states (TS-main pins the identity in
        # keys.test.ts; its live pipeline splits the bytes first — see the
        # module docstring).
        rust_wrapped = run_edit_session(
            "rust", sandboxes["rust"], shared_cwd, script_path, size, out_dir, args.session_prefix, "wrapped"
        )
        # Scenario guards: the TS captures must show the state under test
        # (a too-late capture after delivery would compare empty rows).
        qp.require_markers(
            ts_frames["b1_select_param"],
            ["follow-up 1", FOLLOW_UP_ROW, STEERING_ROW],
            "b1_select_param (ts)",
        )
        qp.require_markers(
            ts_frames["b2_requeued_param"], [EDITED_ROW, STEERING_ROW, DRAFT], "b2_requeued_param (ts)"
        )
        qp.require_markers(ts_frames["b3_cancel_param"], [DRAFT, STEERING_ROW], "b3_cancel_param (ts)")
        require_absent(ts_frames["b4_delete_param"], EDITED_PROMPT, "b4_delete_param (ts)")
        require_absent(rust_frames["b4_delete_param"], EDITED_PROMPT, "b4_delete_param (rust)")
        require_absent(rust_wrapped["b4_delete_wrapped"], EDITED_PROMPT, "b4_delete_wrapped (rust)")

        failures = []
        strip_markers = ("Steering: ", "Follow-up: ", HINT_ROW, HEADER_MARK, DRAFT, FOLLOW_UP_PROMPT)
        for state in STATES:
            name = f"{state}-{args.size}"
            ts_rows = state_rows(ts_frames[f"{state}_param"], strip_markers)
            rust_rows = state_rows(rust_frames[f"{state}_param"], strip_markers)
            if ts_rows == rust_rows:
                print(f"PASS {name}: {len(ts_rows)} row(s) match (ts vs rust)")
                for row in ts_rows:
                    print(f"  | {qp.strip_ansi(row)}")
            else:
                print(f"FAIL {name} (ts vs rust)")
                print(
                    "\n".join(
                        difflib.unified_diff(
                            [qp.strip_ansi(r) for r in ts_rows],
                            [qp.strip_ansi(r) for r in rust_rows],
                            fromfile="ts", tofile="rust", lineterm="", n=1,
                        )
                    )
                )
                failures.append(name)
            # The wrapped form reaches the same states as the parameter form.
            wrapped_rows = state_rows(rust_wrapped[f"{state}_wrapped"], strip_markers)
            if wrapped_rows == rust_rows:
                print(f"PASS {name}: wrapped == parameter form ({len(rust_rows)} row(s))")
            else:
                print(f"FAIL {name} (rust wrapped vs parameter)")
                print(
                    "\n".join(
                        difflib.unified_diff(
                            [qp.strip_ansi(r) for r in rust_rows],
                            [qp.strip_ansi(r) for r in wrapped_rows],
                            fromfile="rust-param", tofile="rust-wrapped", lineterm="", n=1,
                        )
                    )
                )
                failures.append(f"{name} wrapped")
        if any(failures):
            failed = [f for f in failures if f]
            print(f"{len(failed)} state(s) differ; captures in {out_dir}")
            return 1
        print(f"all queue-edit states match; captures in {out_dir}")
        return 0
    finally:
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
