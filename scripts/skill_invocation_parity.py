#!/usr/bin/env python3
"""Skill-invocation parity verifier: drive the user-typed `/skill:<name>`
submission through a LIVE daemon session on both binaries and frame-diff
the result.

The bug this lane fixes (Kevin dogfood): invoking a skill dumped the full
SKILL.md content into the transcript. TS expands the submission into a
`<skill ...>` block inside the user message (TS `_expandSkillCommand`) and
the TUI renders the compact expandable card (`[skill] <name>` collapsed,
`**<name>**` + the content expanded), with the invocation arguments as
their own user block. The Rust side now expands and renders the same way.

This harness is the live end of the verifier: `custom_message_parity.py`
frame-diffs the PERSISTED block shape (resume/replay); this one proves the
submission path produces it on both binaries. Each side runs the real
daemon with a scripted faux provider (`{"engine": "faux"}` rides the
session-create script on the Rust side; the shared extension registers the
same provider in the TS daemon), a sandboxed agent dir carrying ONE
fixture skill (`web-search`), and types the same
`/skill:web-search find parity tuis` submission. States compared:

  a_collapsed: the settled transcript after the turn — the `[skill]`
      web-search card and the `find parity tuis` user block, never the raw
      block text;
  b_expanded: Ctrl+O twice — the card opens the markdown body.

The collapsed/expanded reach contract is asserted on BOTH sides before the
frame diff; the raw `<skill` block text must never surface in either state.

tmux rules: default socket only (`env -u TMUX`), skillp-* session names,
no kill-server; sessions are killed individually at the end.
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import visual_parity as vp  # the shared faux-provider + normalize harness

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

SIZES = [("120", "90")]
SESSION_PREFIX = "skillp"

# The fixture skill both sides load from their sandbox agent dir.
SKILL_NAME = "web-search"
SKILL_BODY = "Run one web search and report the titles.\n\nKeep the query short."
SKILL_MARKDOWN = (
    "---\n"
    'name: web-search\n'
    "description: Search the web and report results.\n"
    "---\n"
    f"{SKILL_BODY}"
)

# The submission under test and the reply the scripted provider serves.
SUBMISSION = f"/skill:{SKILL_NAME} find parity tuis"
SKILL_ARGS = "find parity tuis"
REPLY = "Skill invocation recorded."
FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": vp.TS_SCRIPT_MODEL,
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "tokensPerSecond": 40,
    "responses": [{"content": [{"type": "text", "text": REPLY}]}],
}

SPINNER_CLASS = "[" + "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f" + "]"


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
        if needle in capture_plain(session):
            return
        time.sleep(0.3)
    raise TimeoutError(f"session {session} never showed {needle!r}")


def prepare_sandbox(base):
    """Per-binary sandboxes + the shared fixture skill + faux script."""
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
        os.makedirs(os.path.join(agent, "sessions"), exist_ok=True)
        os.makedirs(os.path.join(agent, "extensions"), exist_ok=True)
        with open(os.path.join(agent, "settings.json"), "w") as f:
            json.dump({"onboardingCompleted": True}, f)
        # The fixture skill both resource loaders discover from
        # `<agentDir>/skills` (user scope on both sides).
        skill_dir = os.path.join(agent, "skills", SKILL_NAME)
        os.makedirs(skill_dir, exist_ok=True)
        with open(os.path.join(skill_dir, "SKILL.md"), "w") as f:
            f.write(SKILL_MARKDOWN)
        sandboxes[binary] = {"home": home, "agent": agent, "tmp": tmp, "cwd": base}
    with open(os.path.join(sandboxes["ts"]["agent"], "extensions", "visual-faux.js"), "w") as f:
        f.write(vp.TS_FAUX_EXTENSION)
    return script_path, sandboxes


def run_side(binary, sandbox, script_path, size, out_dir):
    """Type the submission, capture the collapsed and expanded frames."""
    width, height = size
    session = f"{SESSION_PREFIX}-{binary}-{width}x{height}"
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", width, "-y", height, "-c", sandbox["cwd"])
    env = (
        f"HOME={sandbox['home']} "
        f"TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
        f"PRIME_AGENT_FAUX_SCRIPT={script_path} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    if binary == "ts":
        command = (
            f"{env} prime-agent --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model {vp.TS_SCRIPT_MODEL}"
        )
    else:
        rust = os.environ.get(
            "PA_RUST_BINARY",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "prime-agent"),
        )
        package_dir = os.environ.get("PI_PACKAGE_DIR") or vp.find_runtime_package_dir()
        command = (
            f"{env} PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model {vp.TS_SCRIPT_MODEL}"
        )
    tmux("send-keys", "-t", session, command, "Enter")
    wait_for(session, "Collapsed mode", timeout=60)
    time.sleep(1.0)
    tmux("send-keys", "-t", session, SUBMISSION)
    tmux("send-keys", "-t", session, "Enter")
    # Settled: the scripted reply rendered and no loader row remains.
    deadline = time.time() + 60
    while time.time() < deadline:
        pane = capture_plain(session)
        if REPLY in pane and not re.search(SPINNER_CLASS, pane):
            break
        time.sleep(0.3)
    else:
        raise TimeoutError(f"{binary}: the turn never settled on the scripted reply")
    time.sleep(1.0)
    frames = {"a_collapsed": capture(session)}
    tmux("send-keys", "-t", session, "C-o")
    tmux("send-keys", "-t", session, "C-o")
    time.sleep(1.5)
    frames["b_expanded"] = capture(session)
    tmux("kill-session", "-t", session, check=False)
    for state, frame in frames.items():
        with open(os.path.join(out_dir, f"{binary}-{state}-{width}x{height}.txt"), "w") as f:
            f.write(frame)
    return frames


def capture_plain_text(frame):
    """Strip ANSI codes so content assertions match the visible text."""
    return re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", frame)


def assert_reach(side, frames):
    """The card contract: the compact card + args, the body only expanded,
    never the raw block text."""
    collapsed = capture_plain_text(frames["a_collapsed"])
    expanded = capture_plain_text(frames["b_expanded"])
    assert f"[skill] {SKILL_NAME}" in collapsed, (
        f"{side}: the one-line skill card is missing collapsed"
    )
    assert SKILL_ARGS in collapsed, f"{side}: the args user block is missing collapsed"
    assert "Run one web search" not in collapsed, (
        f"{side}: the skill body leaked while collapsed"
    )
    assert "<skill" not in collapsed, f"{side}: the raw skill block leaked collapsed"
    assert "Run one web search" in expanded, f"{side}: Ctrl+O did not open the skill body"
    assert "<skill" not in expanded, f"{side}: the raw skill block leaked expanded"
    assert SKILL_ARGS in expanded, f"{side}: the args user block is missing expanded"


def normalize(frame, root, agent_dir):
    """The shared volatile scrub plus the sandbox agent-dir scrub: the
    expanded skill card prints the fixture skill's `References are
    relative to <agentDir>/skills/web-search.` line, and each side's
    sandbox agent dir differs by design (`ts/agent` vs `rust/agent`), so
    both collapse to the same placeholder."""
    return vp.normalize(frame.replace(agent_dir, "<AGENT-DIR>"), root)


def diff_lines(left, right):
    return "\n".join(
        difflib.unified_diff(left.split("\n"), right.split("\n"), fromfile="ts", tofile="rust", lineterm="", n=1)
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", default=",".join(f"{w}x{h}" for w, h in SIZES))
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--out", default=None)
    parser.add_argument("--only", default=None, choices=["ts", "rust"])
    args = parser.parse_args()
    sizes = [tuple(entry.split("x")) for entry in args.sizes.split(",")]

    if args.only in (None, "ts"):
        ts_identity.assert_ts_side_is_the_ts_product()

    base = tempfile.mkdtemp(prefix="skill-invocation-parity-")
    out_dir = args.out or tempfile.mkdtemp(prefix="skill-invocation-captures-")
    os.makedirs(out_dir, exist_ok=True)
    script_path, sandboxes = prepare_sandbox(base)
    failures = []
    try:
        if args.only:
            frames = run_side(args.only, sandboxes[args.only], script_path, sizes[0], out_dir)
            assert_reach(args.only, frames)
            print(f"captures for {args.only} in {out_dir}: {sorted(frames)}")
            return 0
        for size in sizes:
            ts_frames = run_side("ts", sandboxes["ts"], script_path, size, out_dir)
            rust_frames = run_side("rust", sandboxes["rust"], script_path, size, out_dir)
            for side, frames in (("ts", ts_frames), ("rust", rust_frames)):
                assert_reach(side, frames)
            for state in ("a_collapsed", "b_expanded"):
                ts_norm = normalize(ts_frames[state], base, sandboxes["ts"]["agent"])
                rust_norm = normalize(rust_frames[state], base, sandboxes["rust"]["agent"])
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
