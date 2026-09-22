#!/usr/bin/env python3
"""Big-turn streaming-throughput verifier (lane: stream-rate).

Drives the interactive TUI through an UNPACED faux provider inside tmux and
measures how long each ~12k-token streamed turn takes to fully render, for
BOTH binaries (the TS product is the ground truth). The acceptance
contract: the Rust binary's per-turn render settle time stays within
SETTLE_RATIO of the TS binary's on the same corpus. The regression this
pins: a wire that broadcasts one frame per provider delta starves the
client at the flusher tick rate, so a turn the engine finishes in seconds
rendered for minutes (the compact-finish e2e diagnosis).

tmux rules: default socket only (`env -u TMUX`), vplane-* session names, no
kill-server; sessions are killed individually at the end.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import ts_identity  # the shared PATH-binary identity guard (same dir)

SESSION_NAME = "vplane-thru"
SIZE = ("120", "40")

# ~12k tokens per turn (chars/4 estimate), unpaced: the faux provider
# streams ~3000 full-partial deltas as fast as it can. MARK-nn segments let
# the pane sampler see progressive content; the tail word marks the settle.
SEGMENTS = 24
SEGMENT_WORDS = 250
TAIL_ONE = "turn-one-settled"
TAIL_TWO = "turn-two-settled"

SPINNERS = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f"
PULSES = "\u25f4\u25f7\u25f6\u25f5\u25cb\u25f8\u25fb\u25fc"
SPINNER_CLASS = "[" + SPINNERS + PULSES + "]"

# The acceptance contract: the Rust settle stays within SETTLE_RATIO of the
# TS settle OR under SETTLE_CAP seconds, whichever is looser. TS renders an
# unpaced faux turn in a fraction of a second on a fast machine, so a strict
# ratio would pin constant-factor renderer differences, not the regression
# this harness exists for (the starvation pipeline rendered one 12k-token
# turn for 60+ seconds); the cap keeps that regression out.
SETTLE_RATIO = 2.0
SETTLE_CAP = 5.0
SETTLE_TIMEOUT = 600.0


def filler_text():
    parts = []
    for segment in range(SEGMENTS):
        parts.append(f"MARK-{segment:02d}")
        parts.append(" ".join(f"word{index}" for index in range(SEGMENT_WORDS)))
    return " ".join(parts)


FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": "faux-1",
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "responses": [
        {"text": f"{filler_text()} {TAIL_ONE}"},
        {"text": f"{filler_text()} {TAIL_TWO}"},
    ],
}

PROMPT_ONE = "Write the first big answer."
PROMPT_TWO = "Write the second big answer."


def tmux(*args, check=True):
    result = subprocess.run(
        ["env", "-u", "TMUX", "tmux", *args], capture_output=True, text=True
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {result.stderr}")
    return result.stdout


def capture(session):
    return tmux("capture-pane", "-p", "-t", session)


def find_runtime_package_dir():
    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    candidates = [
        entry
        for entry in sorted(os.listdir(releases))
        if os.path.isdir(os.path.join(releases, entry, "prime-agent-runtime"))
    ]
    if not candidates:
        raise SystemExit("cannot find the prime-agent-runtime sidecar; set PI_PACKAGE_DIR")
    return os.path.join(releases, candidates[-1])


TS_FAUX_EXTENSION = open(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ts_faux_extension.js"),
    encoding="utf-8",
).read()


def wait_for(session, needle, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in capture(session):
            return True
        time.sleep(0.3)
    return False


def run_turn(session, prompt, tail_word, out_dir, binary):
    """Submit `prompt` and time how long the turn takes to fully render."""
    tmux("send-keys", "-t", session, prompt)
    tmux("send-keys", "-t", session, "Enter")
    started = time.time()
    marks = set()
    deadline = time.time() + SETTLE_TIMEOUT
    while time.time() < deadline:
        pane = capture(session)
        marks.update(word for word in re.findall(r"MARK-\d\d", pane))
        settled = tail_word in pane and not re.search(SPINNER_CLASS, pane)
        if settled:
            elapsed = time.time() - started
            print(
                f"{binary}: turn with tail {tail_word!r} rendered in "
                f"{elapsed:.2f}s ({len(marks)} segment markers seen mid-turn)"
            )
            return elapsed, len(marks)
        time.sleep(0.2)
    raise AssertionError(
        f"{binary}: the turn with tail {tail_word!r} never settled within "
        f"{SETTLE_TIMEOUT}s; last pane:" "\n{capture(session)}"
    )


def run_session(binary, sandbox, shared_cwd, script_path, out_dir):
    width, height = SIZE
    session = f"{SESSION_NAME}-{binary}"
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", width, "-y", height, "-c", shared_cwd)
    env = (
        f"HOME={sandbox['home']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
        f"PRIME_AGENT_FAUX_SCRIPT={script_path} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    if binary == "ts":
        command = (
            f"prime-agent --daemon-socket {sandbox['agent']}/daemon.sock "
            "--model faux-1"
        )
    else:
        rust = os.environ.get("PA_RUST_BINARY") or os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..",
            "..",
            "target",
            "release",
            "prime-agent",
        )
        package_dir = os.environ.get("PI_PACKAGE_DIR") or find_runtime_package_dir()
        command = (
            f"PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock "
            "--model faux-1"
        )
    tmux("send-keys", "-t", session, f"{env} {command}", "Enter")
    if not wait_for(session, "Collapsed mode", timeout=120):
        raise AssertionError(f"{binary}: the editor never came up")

    turns = []
    for prompt, tail in ((PROMPT_ONE, TAIL_ONE), (PROMPT_TWO, TAIL_TWO)):
        elapsed, marks = run_turn(session, prompt, tail, out_dir, binary)
        turns.append({"prompt": prompt, "settle_seconds": round(elapsed, 2), "marks_seen": marks})
    tmux("kill-session", "-t", session, check=False)

    evidence_path = os.path.join(out_dir, f"{binary}-throughput.json")
    os.makedirs(out_dir, exist_ok=True)
    with open(evidence_path, "w") as f:
        json.dump({"turns": turns}, f, indent=1)
    return turns


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep the sandbox dir")
    parser.add_argument("--out", default=None, help="captures directory")
    parser.add_argument("--only", default=None, help="run a single binary (ts|rust)")
    args = parser.parse_args()

    # Fail fast before any launch: a non-TS `prime-agent` on PATH plays a
    # Rust build as the "ts" side and reports false divergences.
    if args.only in (None, "ts"):
        ts_identity.assert_ts_side_is_the_ts_product()

    base = tempfile.mkdtemp(prefix="stream-throughput-sandbox-")
    out_dir = args.out or tempfile.mkdtemp(prefix="stream-throughput-captures-")
    shared_cwd = os.path.join(base, "shared-cwd")
    os.makedirs(shared_cwd, exist_ok=True)
    script_path = os.path.join(base, "faux-script.json")
    with open(script_path, "w") as f:
        json.dump(FAUX_SCRIPT, f, indent=2)
    sandboxes = {}
    for binary in ("ts", "rust"):
        home = os.path.join(base, binary, "home")
        agent = os.path.join(base, binary, "agent")
        os.makedirs(os.path.join(agent, "extensions"), exist_ok=True)
        os.makedirs(os.path.join(agent, "sessions"), exist_ok=True)
        with open(os.path.join(agent, "settings.json"), "w") as f:
            json.dump({"onboardingCompleted": True}, f)
        sandboxes[binary] = {"home": home, "agent": agent}
    with open(os.path.join(sandboxes["ts"]["agent"], "extensions", "stream-faux.js"), "w") as f:
        f.write(TS_FAUX_EXTENSION)

    try:
        if args.only:
            run_session(args.only, sandboxes[args.only], shared_cwd, script_path, out_dir)
            print(f"{args.only}: throughput run finished; captures in {out_dir}")
            return 0
        ts_turns = run_session("ts", sandboxes["ts"], shared_cwd, script_path, out_dir)
        rust_turns = run_session("rust", sandboxes["rust"], shared_cwd, script_path, out_dir)
        failures = []
        for index, (ts_turn, rust_turn) in enumerate(zip(ts_turns, rust_turns)):
            ts_seconds = ts_turn["settle_seconds"]
            rust_seconds = rust_turn["settle_seconds"]
            bound = max(ts_seconds * SETTLE_RATIO, SETTLE_CAP)
            if rust_seconds > bound:
                failures.append(
                    f"turn {index + 1}: rust rendered in {rust_seconds}s, "
                    f"ts in {ts_seconds}s (bound {bound:.1f}s = "
                    f"max({SETTLE_RATIO}x ts, {SETTLE_CAP}s cap))"
                )
        if failures:
            print("FAIL " + "; ".join(failures))
            return 1
        print(
            "PASS rust kept up: "
            + ", ".join(
                f"turn {index + 1}: ts {ts['settle_seconds']}s vs rust {rust['settle_seconds']}s"
                for index, (ts, rust) in enumerate(zip(ts_turns, rust_turns))
            )
        )
        return 0
    finally:
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
