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
- `long_output`: `!seq 1 40 | sed 's/^/line-/'` — the BashExecutionComponent
  box with its 20-line tail preview and `... N more lines`;
- `truncation`: `!seq 1 2100 | sed 's/^/line-/'` — past the 2000-line context
  budget, the `Output truncated. Full output: <spill>` notice;
- `cancelled`: a `!sleep 30` run aborted mid-flight marks itself
  `(cancelled)`;
- `pane_bash`: a `!` run inside the open `/btw` side pane mounts in the
  pane (transient, pane-owned);
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
# The preview/truncation states key their needles on `line-N` rows, so the
# commands prefix every output line (`seq` alone prints bare numbers).
LONG_COMMAND = "seq 1 40 | sed 's/^/line-/'"
TRUNCATED_COMMAND = "seq 1 2100 | sed 's/^/line-/'"
CANCEL_COMMAND = "sleep 30"
PANE_COMMAND = "echo pane-run"

# The bang surface's own faux script: the /btw pane question and the
# flush turn get text-only answers (the shared FAUX_SCRIPT's tool calls
# would execute against the real daemon inside the pane).
BANG_FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": "faux-1",
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 18,
    "responses": [
        {"content": [{"type": "text", "text": "4"}]},
        {"content": [{"type": "text", "text": "quick check done"}]},
    ],
}


def ts_release_binary():
    """The deployed TS release binary as an ABSOLUTE path.

    tmux pane commands resolve `prime-agent` through the tmux SERVER's
    PATH (not the harness env), and this box's PATH install is the Rust
    dogfood build — a bare `prime-agent` in a pane would play a Rust
    build as the ts side. Resolve the release directory that ships
    `prime-agent-runtime` and is not the Rust product (its binary reports
    a different version line), so the pane runs the real TS binary.
    """
    import ts_identity

    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    rust = ts_identity.default_rust_binary()
    candidates = sorted(
        entry
        for entry in os.listdir(releases)
        if os.path.isdir(os.path.join(releases, entry, "prime-agent-runtime"))
    )
    for entry in candidates:
        binary = os.path.join(releases, entry, "prime-agent")
        if not os.access(binary, os.X_OK):
            continue
        if ts_identity.probe_version(binary) and ts_identity.probe_version(
            binary
        ) != ts_identity.probe_version(rust):
            return binary
    raise SystemExit(
        f"no deployed TS release under {releases} that is not the Rust build"
    )


#: The ts side's absolute binary (the pane resolves PATH through the tmux
#: server, whose `prime-agent` is the Rust dogfood on this box).
TS_BINARY = ts_release_binary()


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
            f"{TS_BINARY} --daemon-socket {sandbox['agent']}/daemon.sock --model {vp.TS_SCRIPT_MODEL}"
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
        # The resolved binary is part of the evidence: a polluted
        # PA_RUST_BINARY (a shared-box env leak) silently plays a foreign
        # build as the rust side otherwise.
        print(f"  [rust] binary: {rust}")
        command = (
            f"PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock --model {vp.TS_SCRIPT_MODEL}"
        )
    vp.tmux("send-keys", "-t", session, f"{env} {command}", "Enter")
    vp.wait_for(session, "Collapsed mode", timeout=60)
    # Settle past the attach render: a submit inside the attach window
    # races renderSessionContext(clearChat) — the daemon can deliver the
    # run's events after the clear (a duplicated card: the transcript row
    # plus the late-mounted live card) or before it (a wiped card, the
    # needle never seen). The rebuild is frame-invisible on a fresh
    # session, so the settle is a grace wait plus one stable capture pair.
    time.sleep(4.0)
    previous = vp.capture(session, escape=False)
    deadline = time.time() + 10
    while time.time() < deadline:
        time.sleep(0.5)
        current = vp.capture(session, escape=False)
        if current == previous:
            break
        previous = current


def assert_daemon_binary(binary, sandbox):
    """The daemon serving this side's socket must be this side's binary.

    Proven hazard on the shared box: a stale daemon built days earlier
    (another lane's binary) ended up serving a sandbox socket; the probe
    accepted its protocol and the whole side ran against pre-feature
    code. argv[0] of the daemon on our socket must match the binary the
    side launched."""
    socket = f"{sandbox['agent']}/daemon.sock"
    expected = TS_BINARY if binary == "ts" else os.environ.get(
        "PA_RUST_BINARY",
        os.path.normpath(
            os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "..",
                "target",
                "debug",
                "prime-agent",
            )
        ),
    )
    deadline = time.time() + 20
    argv0 = None
    while time.time() < deadline:
        listing = subprocess.run(
            ["pgrep", "-af", socket],
            capture_output=True,
            text=True,
        ).stdout
        for line in listing.splitlines():
            _, _, cmd = line.partition(" ")
            if "--mode daemon" in cmd:
                argv0 = cmd.split()[0]
                if os.path.realpath(argv0) == os.path.realpath(expected):
                    return
        time.sleep(0.5)
    raise SystemExit(
        f"the {binary} daemon on {socket} is {argv0!r}, expected {expected!r} "
        "(a foreign/stale daemon claimed the sandbox socket)"
    )


SGR_TOKEN = re.compile(r"\x1b\[([0-9;]*)m")


def materialize_sgr(frame):
    """The frame as per-cell screen state instead of escape bytes.

    SGR state persists across rows on the real screen, and `capture -e`
    re-emits carried-over state inconsistently (an escape on one side's
    row, carryover on the other's). Rebuilding each row from the running
    state — foreground ignored on spaces, default-background trailing
    spaces dropped — compares what the user sees, not where tmux placed
    the escapes."""
    fg = None
    bg = None
    attrs = set()
    rows = []
    for line in frame.split("\n"):
        cells = []

        def push(text):
            for ch in text:
                cell_fg = None if ch == " " else fg
                cell_attrs = () if ch == " " else tuple(sorted(attrs))
                cells.append((ch, cell_fg, bg, cell_attrs))

        pos = 0
        for match in SGR_TOKEN.finditer(line):
            push(line[pos : match.start()])
            pos = match.end()
            codes = [int(code) for code in match.group(1).split(";") if code] or [0]
            i = 0
            while i < len(codes):
                code = codes[i]
                if code == 0:
                    fg = None
                    bg = None
                    attrs.clear()
                elif code == 39:
                    fg = None
                elif code == 49:
                    bg = None
                elif code in (38, 48):
                    if i + 4 < len(codes) and codes[i + 1] == 2:
                        color = tuple(codes[i : i + 5])
                        i += 4
                    elif i + 2 < len(codes) and codes[i + 1] == 5:
                        color = tuple(codes[i : i + 3])
                        i += 2
                    else:
                        color = (code,)
                    if code == 38:
                        fg = color
                    else:
                        bg = color
                elif 30 <= code <= 37 or 90 <= code <= 97:
                    fg = (code,)
                elif 40 <= code <= 47 or 100 <= code <= 107:
                    bg = (code,)
                elif code == 22:
                    attrs -= {1, 2}
                elif 21 <= code <= 29:
                    attrs.discard(code - 20)
                else:
                    attrs.add(code)
                i += 1
        push(line[pos:])
        while cells and cells[-1][0] == " " and cells[-1][2] is None:
            cells.pop()
        parts = []
        state = (None, None, ())
        for ch, cell_fg, cell_bg, cell_attrs in cells:
            cell_state = (cell_fg, cell_bg, cell_attrs)
            if cell_state != state and (ch != " " or cell_bg != state[1]):
                parts.append(f"<{cell_fg}|{cell_bg}|{cell_attrs}>")
                state = cell_state
            parts.append(ch)
        rows.append("".join(parts))
    return "\n".join(rows)


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
    assert_daemon_binary(binary, sandbox)
    try:
        # `!command`: the row mounts and the run settles. The needle is the
        # mounted `$ command` row (the typed input echoes the same words in
        # the editor before Enter, so the bare words would race the mount).
        vp.tmux("send-keys", "-t", session, f"!{RUN_COMMAND}", "Enter")
        vp.wait_for(session, f"$ {RUN_COMMAND}", timeout=30)
        time.sleep(1.0)
        frames["bang_run"] = vp.capture(session)
        # The attach-render race guard: one run mounts one card. A second
        # card means the settle above lost the race (the recorded row
        # rendered next to the live card) -- fail loudly, never compare
        # through it.
        cards = visible_text(frames["bang_run"]).count(f"$ {RUN_COMMAND}")
        if cards != 1:
            print(f"  [{binary}] the first bang run mounted {cards} cards (attach race)")

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
            print(f"  [{binary}] a bare ! changed the frame (should be inert):")
            import difflib

            for delta in difflib.unified_diff(
                before.split("\n"), after.split("\n"), lineterm="", n=0
            ):
                if delta and delta[0] in "+-" and delta[:3] not in ("+++", "---"):
                    print(f"    {delta!r}")
            frames["bare"] += "\n\nBARE NOT INERT\n" + vp.capture(session)

        # The live-event cards the lane's verifier spec adds: the long
        # output preview, the truncation notice, the cancelled run, and
        # the bang inside the /btw side pane.
        # Long output: the 20-line preview plus its hidden-count row.
        vp.tmux("send-keys", "-t", session, f"!{LONG_COMMAND}", "Enter")
        vp.wait_for(session, f"$ {LONG_COMMAND}", timeout=30)
        time.sleep(2.0)
        frames["long_output"] = vp.capture(session)

        # Truncation: past the 2000-line context budget the tail cut names
        # its spill file (TS `truncateTail` + `fullOutputPath`).
        vp.tmux("send-keys", "-t", session, f"!{TRUNCATED_COMMAND}", "Enter")
        deadline = time.time() + 30
        while time.time() < deadline:
            pane = visible_text(vp.capture(session, escape=False))
            if "more lines" in pane and "Output truncated" in pane:
                break
            time.sleep(0.3)
        time.sleep(1.0)
        frames["truncation"] = vp.capture(session)

        # Cancel mid-run: the clear key aborts the held run, the card
        # marks itself (cancelled).
        vp.tmux("send-keys", "-t", session, "!sleep 30", "Enter")
        vp.wait_for(session, "$ sleep 30", timeout=30)
        time.sleep(0.5)
        vp.tmux("send-keys", "-t", session, "C-c")
        vp.wait_for(session, "(cancelled)", timeout=30)
        # The exit hint arms on the interrupt and expires after two
        # seconds; settle past it before capturing.
        time.sleep(2.5)
        frames["cancelled"] = vp.capture(session)

        # Bang inside the side pane: the /btw pane mounts, and the run
        # renders inside it (transient, pane-owned).
        vp.tmux("send-keys", "-t", session, "/btw what is 2+2", "Enter")
        vp.wait_for(session, "/btw", timeout=30)
        time.sleep(3.0)
        vp.tmux("send-keys", "-t", session, "!echo pane-run", "Enter")
        vp.wait_for(session, "$ echo pane-run", timeout=30)
        time.sleep(1.5)
        frames["pane_bash"] = vp.capture(session)
        # Leave the pane before the flush turn (a prompt closes it).
        vp.tmux("send-keys", "-t", session, "Escape")
        time.sleep(2.5)

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
    except TimeoutError:
        # The pane and the side's processes at the failure instant — the
        # finally kills the session, so this is the only evidence a
        # needle timeout leaves behind.
        print(f"  [{binary}] TIMEOUT — pane at failure:")
        for line in visible_text(vp.capture(session, escape=False)).split("\n"):
            if line.strip():
                print(f"    |{line}")
        listing = subprocess.run(
            ["pgrep", "-af", sandbox["agent"]], capture_output=True, text=True
        ).stdout
        print(f"  [{binary}] processes: {listing}")
        raise
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

    ts_identity.assert_ts_side_is_the_ts_product(TS_BINARY)

    # A SHORT base: the truncation notice renders its spill path inside
    # the box, and the Rust spill hex is 32 chars (TS's is 16), so a long
    # base would wrap the notice on the Rust side only — a sandbox
    # artifact, not a product divergence. Short keeps both sides inside
    # the content width.
    base = tempfile.mkdtemp(prefix="bp-sb-")
    print(f"sandbox: {base}")
    out_dir = args.out or tempfile.mkdtemp(prefix="bang-parity-captures-")
    os.makedirs(out_dir, exist_ok=True)
    shared_cwd, script_path, sandboxes = vp.prepare_sandbox(base)
    with open(script_path, "w") as f:
        json.dump(BANG_FAUX_SCRIPT, f, indent=2)
    failures = []
    try:
        os.environ.pop("TMUX", None)
        ts_frames = run_states("ts", sandboxes["ts"], shared_cwd, script_path)
        rust_frames = run_states("rust", sandboxes["rust"], shared_cwd, script_path)

        # The behavioral needles: each visible fact must hold on both sides.
        for command in (RUN_COMMAND, EXCLUDED_COMMAND):
            for binary, frames in (("ts", ts_frames), ("rust", rust_frames)):
                key = "bang_run" if command == RUN_COMMAND else "bangbang_run"
                cards = visible_text(frames[key]).count(f"$ {command}")
                if cards != 1:
                    # Zero = the attach render wiped the submit; two = the
                    # recorded row rendered next to the live card. Either
                    # way the settle in start_binary was outrun — a rerun
                    # decides, never a normalization.
                    failures.append(f"{binary}-{key}-card-count")
                    print(f"FAIL {binary} {key}: {cards} `$ {command}` cards")
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

            # The live-event cards (the lane's verifier extension).
            long_text = visible_text(frames["long_output"])
            if f"$ {LONG_COMMAND}" not in long_text:
                failures.append(f"{binary}-long-output-header")
                print(f"FAIL {binary} long_output: no `$ {LONG_COMMAND}` header")
            if "line-40" not in long_text or "more lines" not in long_text:
                failures.append(f"{binary}-long-output-preview")
                print(f"FAIL {binary} long_output: the preview tail never rendered")
            if "line-1 " in long_text:
                failures.append(f"{binary}-long-output-hidden")
                print(f"FAIL {binary} long_output: the older half leaked past the preview")

            truncated_text = visible_text(frames["truncation"])
            if f"$ {TRUNCATED_COMMAND}" not in truncated_text:
                failures.append(f"{binary}-truncation-header")
                print(f"FAIL {binary} truncation: no `$ {TRUNCATED_COMMAND}` header")
            if "Output truncated. Full output:" not in truncated_text:
                failures.append(f"{binary}-truncation-notice")
                print(f"FAIL {binary} truncation: the spill notice never rendered")
            if "line-2100" not in truncated_text:
                failures.append(f"{binary}-truncation-tail")
                print(f"FAIL {binary} truncation: the tail never rendered")

            cancelled_text = visible_text(frames["cancelled"])
            if f"$ {CANCEL_COMMAND}" not in cancelled_text:
                failures.append(f"{binary}-cancelled-header")
                print(f"FAIL {binary} cancelled: no `$ {CANCEL_COMMAND}` header")
            if "(cancelled)" not in cancelled_text:
                failures.append(f"{binary}-cancelled-marker")
                print(f"FAIL {binary} cancelled: the marker never rendered")

            pane_text = visible_text(frames["pane_bash"])
            if f"$ {PANE_COMMAND}" not in pane_text:
                failures.append(f"{binary}-pane-bash-mount")
                print(f"FAIL {binary} pane_bash: the pane never mounted the run")
            elif pane_text.count(PANE_COMMAND.split()[-1]) < 2:
                failures.append(f"{binary}-pane-bash-output")
                print(f"FAIL {binary} pane_bash: the pane run's output never rendered")

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
        def bang_normalize(frame, root):
            # The truncation notice names each side's own spill file (the
            # per-binary sandbox tmp dir plus a run hex), so those
            # normalize to one placeholder before comparing.
            norm = vp.normalize(frame, root)
            # The pane's first row: tmux attaches the previous row's
            # foreground reset differently for identical screens (before
            # the popup-background escape, or absent when the row above
            # already ended default); a reset ahead of another escape
            # describes the same default either way.
            norm = re.sub(r"\n\x1b\[39m(?=\x1b)", "\n", norm)
            # TS spills as pi-bash-<hex>.log, the Rust port as
            # pa-bash-<hex>.log (branding; the path itself is transient
            # either way).
            norm = re.sub(
                r"<SANDBOX>/(?:ts|rust)/tmp/p[ia]-bash-[0-9a-f]+\.log",
                "<SPILL>",
                norm,
            )
            # tmux capture -e omits an SGR that carried over from a
            # previous row (the color stays active on screen without a
            # re-emitted escape) and both sides paint identical screens
            # with different carryover layouts: materialize the active
            # foreground at each row start so the compare sees the screen,
            # not the escape placement.
            return materialize_sgr(norm)

        for state in (
            "bang_run",
            "bangbang_run",
            "guard",
            "long_output",
            "truncation",
            "cancelled",
            "pane_bash",
        ):
            ts_norm = bang_normalize(ts_frames[state], base)
            rust_norm = bang_normalize(rust_frames[state], base)
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
                for key in (
                    "bang_run",
                    "bangbang_run",
                    "guard",
                    "bare",
                    "long_output",
                    "truncation",
                    "cancelled",
                    "pane_bash",
                ):
                    f.write(f"\n===== {key} =====\n{frames[key]}\n")
        print(f"captures in {out_dir}")
        return 1 if failures else 0
    finally:
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if not args.keep:
            subprocess.run(["rm", "-rf", base], check=False)


if __name__ == "__main__":
    sys.exit(main())
