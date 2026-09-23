#!/usr/bin/env python3
"""Prompt-menu behavior harness: drive the BASE and BRANCH Rust builds
through the prompt-menu states and verify the prompt-menu-unification
behaviors (the family's deliberate divergences, verified on the branch).

Both sides are driven like a user in tmux with the faux provider engine
(`PRIME_AGENT_FAUX_SCRIPT`, the same harness seam visual_parity uses):
tmux launches the binary against an isolated HOME/agent dir, keys are sent
at the editor, and the rendered pane is captured after each state settles.

The states:

- a_empty_tab: Tab on the empty prompt. BEFORE (base): the forced file
  completion lists the whole cwd (junk like a `.claude` directory). AFTER
  (branch): nothing happens - no menu.
- b_slash_menu: `/m` opens the slash-command dropdown. AFTER: the dropdown
  renders through the unified menu grammar (the `›` marker on the selected
  row, the shared status rows).
- c_model_picker / d_mcp_menu: bare `/model` and `/mcp` open their menus.
- e_esc_menu_streaming: a slow faux turn streams; `./` + Tab opens the cwd
  completion menu; Esc closes it. AFTER: the menu closes AND the rollout
  CONTINUES (the loader still streams, no aborted row). BEFORE (base): Esc
  also interrupts the turn.
- f_model_arg_rejection: `/model <arg>` + Enter. AFTER: the usage error row
  with the text kept in the editor. BEFORE (base): the picker opens with the
  search prefilled.
- g_model_tab_filtered: `/model <partial>` + Tab. AFTER: the model picker
  opens with the partial as its filter. BEFORE: no picker (the Tab is file
  completion of the partial).
- h_mcp_tab_filtered: `/mcp <partial>` + Tab. AFTER: the connections view
  opens with the partial as its filter. BEFORE: no view.

Exit code is non-zero when any branch assertion fails. The report and the
per-state frames go to stdout and --out.
"""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)

# Per-invocation suffix: concurrent runs must not reuse (and kill) each
# other's sessions.
SESSION_BASE = f"pmenu-base-{os.getpid()}"
SESSION_BRANCH = f"pmenu-branch-{os.getpid()}"
WIDTH, HEIGHT = 110, 34
SETTLE = 1.0
TS_SCRIPT_MODEL = "faux-1"

# The slow streaming turn for the Esc state: a long thinking block at 4
# tokens/second keeps the loader alive while the menu interaction runs.
STREAM_FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": TS_SCRIPT_MODEL,
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 4,
    "responses": [
        {
            "content": [
                {
                    "type": "thinking",
                    "thinking": (
                        "A long slow thinking pass so the streaming loader stays up while the "
                        "completion menu opens and Escape closes it: the turn must still be "
                        "streaming after the key lands, proving the menu consumed the Escape "
                        "instead of the abort. This block is long on purpose so the faux "
                        "provider keeps streaming it for a good while before any visible "
                        "text appears in the transcript."
                    ),
                },
                {"type": "text", "text": "the final answer streams after the menu check"},
            ]
        },
        {"content": [{"type": "text", "text": "second turn"}]},
    ],
}

SPINNERS = "".join(
    "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f"
    "\u25f4\u25f7\u25f6\u25f5\u25cb\u25f8\u25fb\u25fc"
)
SPINNER_CLASS = "[" + SPINNERS + "]"


def tmux(*args, check=True):
    result = subprocess.run(
        ["env", "-u", "TMUX", "tmux", *args], capture_output=True, text=True
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def ansi_stripped(text):
    text = re.sub("\x1b\\][^\x07]*(\x07|\x1b\\\\)", "", text)
    text = re.sub("\x1b\\[[0-?]*[ -/]*[@-~]", "", text)
    return text


def capture(session):
    raw = tmux("capture-pane", "-t", session, "-p", "-e")
    lines = [ansi_stripped(line).rstrip() for line in raw.splitlines()]
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def wait_for(session, needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        pane = capture(session)
        if needle in pane:
            return pane
        time.sleep(0.3)
    raise TimeoutError(f"session {session} never showed {needle!r}")


def wait_or_none(session, needle, timeout):
    try:
        return wait_for(session, needle, timeout)
    except TimeoutError:
        return None


def find_runtime_package_dir():
    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    if not os.path.isdir(releases):
        raise SystemExit("no TS release sidecar; set PI_PACKAGE_DIR")
    candidates = [
        entry
        for entry in sorted(os.listdir(releases))
        if os.path.isdir(os.path.join(releases, entry, "prime-agent-runtime"))
    ]
    if not candidates:
        raise SystemExit("no release with prime-agent-runtime/")
    return os.path.join(releases, candidates[-1])


def make_sandbox(base):
    home = os.path.join(base, "home")
    agent = os.path.join(base, "agent")
    tmp = os.path.join(base, "tmp")
    for path in (home, tmp, os.path.join(agent, "sessions")):
        os.makedirs(path, exist_ok=True)
    with open(os.path.join(agent, "settings.json"), "w") as handle:
        json.dump({"onboardingCompleted": True}, handle)
    return home, agent, tmp


def launch(session, binary, sandbox, script_path, shared_cwd):
    home, agent, tmp = sandbox
    tmux("kill-session", "-t", session, check=False)
    tmux(
        "new-session", "-d", "-s", session, "-x", str(WIDTH), "-y", str(HEIGHT),
        "-c", shared_cwd,
    )
    time.sleep(0.5)
    # The pane's shell parses the typed command: every path is
    # shell-quoted (an --out with spaces must not split the environment
    # assignment) and the binary resolves to an absolute path first (a
    # relative one would be looked up under shared_cwd, the new
    # session's cwd, not the checkout the harness ran from).
    package_dir = os.environ.get("PI_PACKAGE_DIR") or find_runtime_package_dir()
    # The pane shell inherits the harness process environment, so any
    # inherited `RLM_*` variable (e.g. RLM_DEPTH=debug) leaks into the
    # launched agent and can panic its env parsing: scrub them first.
    rlm_unset = " ".join(
        f"-u {shlex.quote(name)}" for name in os.environ if name.startswith("RLM_")
    )
    env = " ".join(
        f"{name}={shlex.quote(value)}"
        for name, value in (
            ("HOME", home),
            ("TMPDIR", tmp),
            ("PRIME_AGENT_CODING_AGENT_DIR", agent),
            ("PRIME_AGENT_FAUX_SCRIPT", script_path),
            ("PRIME_AGENT_DISABLE_ANALYTICS", "1"),
            ("PI_PACKAGE_DIR", package_dir),
        )
    )
    command = (
        f"env {rlm_unset} {env} {shlex.quote(os.path.abspath(binary))} "
        f"--daemon-socket {shlex.quote(os.path.join(agent, 'daemon.sock'))} "
        f"--model {TS_SCRIPT_MODEL}"
    )
    tmux("send-keys", "-t", session, command, "Enter")
    wait_for(session, "Collapsed mode", timeout=60)


def send(session, *keys):
    for key in keys:
        tmux("send-keys", "-t", session, key)
        time.sleep(0.12)


def run_states(session, out_dir, label, verify_branch):
    """Drive every state; return the assertion results."""
    frames = {}
    results = []

    def check(name, ok, detail):
        results.append((name, ok, detail))

    def clear_editor():
        send(session, "C-u")

    # (a) empty Tab
    send(session, "Tab")
    time.sleep(SETTLE)
    frames[f"{label}_a_empty_tab"] = capture(session)
    menu_open = "alpha.txt" in frames[f"{label}_a_empty_tab"]
    if verify_branch:
        check("empty_tab_is_a_noop", not menu_open, f"cwd_menu_open={menu_open}")
    else:
        check("BASE_empty_tab_opens_cwd_menu", menu_open, f"cwd_menu_open={menu_open}")

    # (b) slash dropdown grammar
    send(session, "/", "m")
    time.sleep(SETTLE + 0.6)
    frames[f"{label}_b_slash_menu"] = capture(session)
    pane = frames[f"{label}_b_slash_menu"]
    marker_rows = re.findall(r"^\s*› \S+", pane, re.M)
    if verify_branch:
        check(
            "slash_menu_uses_menu_grammar",
            len(marker_rows) == 1 and "model" in pane and "(" in pane,
            f"marker_rows={marker_rows}",
        )
    send(session, "Escape")
    time.sleep(0.4)
    clear_editor()

    # (c) bare /model opens the picker. The trailing space completes the
    # command token BEFORE Enter (the base's takes_argument completion
    # would otherwise consume Enter to append its separator; the branch's
    # menu-only /mcp//model complete without the separator).
    send(session, "/model ")
    send(session, "Enter")
    frames[f"{label}_c_model_picker"] = wait_for(session, "Search models", timeout=15)
    if verify_branch:
        check(
            "bare_model_opens_picker",
            "Search models" in frames[f"{label}_c_model_picker"],
            "picker search field",
        )
    send(session, "Escape")
    time.sleep(SETTLE)

    # (d) bare /mcp opens the connections view (the daemon may serve the
    # builtin catalog's service rows, so the frame needle is the view's
    # search field, not the empty-roster row).
    send(session, "/mcp ")
    send(session, "Enter")
    frames[f"{label}_d_mcp_menu"] = wait_for(
        session, "Search MCP connections", timeout=15
    )
    if verify_branch:
        check(
            "bare_mcp_opens_menu",
            "Search MCP connections" in frames[f"{label}_d_mcp_menu"],
            "connections view frame",
        )
    send(session, "Escape")
    time.sleep(SETTLE)

    # (e) Esc closes the open menu while a turn streams
    send(session, "Run the check.")
    send(session, "Enter")
    wait_for(session, "Thinking", timeout=30)
    send(session, ".", "/")
    send(session, "Tab")
    frames[f"{label}_e_menu_open_streaming"] = wait_for(
        session, "alpha.txt", timeout=10
    )
    menu_open = "alpha.txt" in frames[f"{label}_e_menu_open_streaming"]
    check(
        f"{'BRANCH' if verify_branch else 'BASE'}_stream_menu_opens",
        menu_open,
        "the cwd menu lists the sandbox files",
    )
    send(session, "Escape")
    time.sleep(1.2)
    frames[f"{label}_e_after_escape"] = capture(session)
    after = frames[f"{label}_e_after_escape"]
    menu_closed = "alpha.txt" not in after
    if verify_branch:
        still_streaming = bool(re.search(SPINNER_CLASS, after))
        aborted = "aborted" in after
        check(
            "esc_closes_menu_not_the_rollout",
            menu_closed and still_streaming and not aborted,
            f"menu_closed={menu_closed} streaming={still_streaming} "
            f"aborted={aborted}",
        )
    else:
        base_interrupted = "aborted" in after and not re.search(SPINNER_CLASS, after)
        check(
            "BASE_esc_also_interrupts",
            menu_closed and base_interrupted,
            f"menu_closed={menu_closed} interrupted={base_interrupted}",
        )
    # Drain the turn so the later command states dispatch.
    send(session, "Escape")
    wait_or_none(session, "aborted", 20)
    time.sleep(1.0)
    clear_editor()

    # (f) /model <arg> + Enter
    send(session, "/model gpt-5. ")
    send(session, "Enter")
    time.sleep(SETTLE + 0.6)
    frames[f"{label}_f_model_arg"] = capture(session)
    pane = frames[f"{label}_f_model_arg"]
    if verify_branch:
        rejected = "Usage: /model" in pane
        kept = "/model gpt-5" in pane
        check(
            "model_arg_rejected",
            rejected and kept and "Search models" not in pane,
            f"rejected={rejected} kept={kept}",
        )
    else:
        opened = "Enter select" in pane
        check(
            "BASE_model_arg_opens_filtered_picker",
            opened,
            "base: the arg prefills the picker search",
        )
    send(session, "Escape")
    time.sleep(SETTLE)
    clear_editor()

    # (g) /model <partial> + Tab
    send(session, "/model gp")
    send(session, "Tab")
    frame = wait_or_none(session, "Enter select", timeout=8)
    frames[f"{label}_g_model_tab"] = frame or capture(session)
    if verify_branch:
        opened = frame is not None and re.search(
            r"> gp\b", frames[f"{label}_g_model_tab"]
        )
        check(
            "model_tab_opens_filtered_picker",
            opened,
            "picker open with the partial as its filter",
        )
    else:
        check(
            "BASE_model_tab_is_file_completion",
            frame is None,
            "base: no picker on Tab in the argument context",
        )
    if frame is not None:
        send(session, "Escape")
        time.sleep(SETTLE)
    clear_editor()

    # (h) /mcp <partial> + Tab
    send(session, "/mcp lin")
    send(session, "Tab")
    frame = wait_or_none(session, "navigate", timeout=8)
    frames[f"{label}_h_mcp_tab"] = frame or capture(session)
    if verify_branch:
        opened = frame is not None and re.search(
            r"> lin\b", frames[f"{label}_h_mcp_tab"]
        )
        check(
            "mcp_tab_opens_filtered_menu",
            opened,
            "connections view open with the partial as its filter",
        )
    else:
        check(
            "BASE_mcp_tab_is_file_completion",
            frame is None,
            "base: no view on Tab in the argument context",
        )
    if frame is not None:
        send(session, "Escape")

    for name, frame in frames.items():
        with open(os.path.join(out_dir, f"{name}.txt"), "w") as handle:
            handle.write(frame + "\n")
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="/tmp/prompt-menu-parity")
    parser.add_argument(
        "--base-binary",
        default=os.environ.get("PA_BASE_BINARY", ""),
        help="the pre-change binary (the origin/rust build)",
    )
    parser.add_argument(
        "--branch-binary",
        default=os.environ.get(
            "PA_RUST_BINARY",
            os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "..",
                "target",
                "debug",
                "prime-agent",
            ),
        ),
        help="the with-change binary (the worktree build)",
    )
    parser.add_argument(
        "--skip-base", action="store_true", help="verify only the branch build"
    )
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)

    base = os.path.join(args.out, "sandbox")
    shared_cwd = os.path.join(base, "cwd")
    os.makedirs(shared_cwd, exist_ok=True)
    with open(os.path.join(shared_cwd, "alpha.txt"), "w") as handle:
        handle.write("alpha\n")
    with open(os.path.join(shared_cwd, "beta.md"), "w") as handle:
        handle.write("# beta\n")
    os.makedirs(os.path.join(shared_cwd, "gamma"), exist_ok=True)

    script_path = os.path.join(base, "faux-script.json")
    with open(script_path, "w") as handle:
        json.dump(STREAM_FAUX_SCRIPT, handle, indent=2)

    all_results = []
    sockets = []
    # Reap any daemons a previous (possibly crashed) run leaked on this
    # harness's sockets before launching fresh sides.
    stale_sandbox = os.path.join(args.out, "sandbox")
    stale_sockets = []
    for side in ("base", "branch"):
        socket = os.path.join(stale_sandbox, side, "agent", "daemon.sock")
        if os.path.exists(socket):
            stale_sockets.append(socket)
    if stale_sockets:
        # cwd_roots scopes the detached-worker sweep, which kills ANY
        # process working under the roots: only the harness-owned sandbox
        # dir belongs there (`--out .` or `--out /tmp` must not sweep
        # unrelated processes).
        batterylib.reap_daemons(
            socket_paths=stale_sockets,
            needles=(args.out,),
            cwd_roots=(stale_sandbox,),
        )
    # Each side tears down in a finally: a wait_for timeout or a tmux
    # error mid-run must not leak the session or its daemon, and the
    # final reap must run even when a side raises.
    try:
        if not args.skip_base:
            if not args.base_binary:
                raise SystemExit("set --base-binary (or PA_BASE_BINARY)")
            sandbox = make_sandbox(os.path.join(base, "base"))
            sockets.append(os.path.join(sandbox[1], "daemon.sock"))
            try:
                launch(
                    SESSION_BASE, args.base_binary, sandbox, script_path, shared_cwd
                )
                all_results += run_states(
                    SESSION_BASE, args.out, "base", verify_branch=False
                )
            finally:
                tmux("kill-session", "-t", SESSION_BASE, check=False)

        sandbox = make_sandbox(os.path.join(base, "branch"))
        sockets.append(os.path.join(sandbox[1], "daemon.sock"))
        try:
            launch(
                SESSION_BRANCH, args.branch_binary, sandbox, script_path, shared_cwd
            )
            all_results += run_states(
                SESSION_BRANCH, args.out, "branch", verify_branch=True
            )
        finally:
            tmux("kill-session", "-t", SESSION_BRANCH, check=False)
    finally:
        batterylib.reap_daemons(
            socket_paths=sockets, needles=(args.out,), cwd_roots=(base,)
        )

    failed = 0
    print("\n== prompt-menu harness ==")
    for name, ok, detail in all_results:
        status = "PASS" if ok else "FAIL"
        if not ok:
            failed += 1
        print(f"[{status}] {name}: {detail}")
    print(f"\n{len(all_results) - failed}/{len(all_results)} checks passed")
    print(f"frames under {args.out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
