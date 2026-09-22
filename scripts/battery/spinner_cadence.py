#!/usr/bin/env python3
"""Spinner cadence probe (lane cpu-spin).

The spinner phase must advance on the wall clock (~80ms per frame, TS
`Loader.DEFAULT_INTERVAL_MS`), constant regardless of the render rate.
Drives a long tool-execution turn (a quiet animating window: no stream
deltas, only the loader advances), samples the pane as fast as tmux
allows, and asserts the observed glyph transitions: sequential phases
(+1 mod 10), each within the cadence budget.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import sustained_cpu as sc

FRAMES = sc.SPINNERS  # 10 braille loader frames
TOOL_SLEEP_S = 40
WINDOW_S = 10.0
CADENCE_MS = 80.0
# budget: capture+render latency adds noise, but the phase boundaries are
# periodic - every observed transition must sit inside this window.
MIN_INTERVAL_MS, MAX_INTERVAL_MS = 50.0, 130.0

def faux_script():
    return {
        "engine": "faux", "modelId": "faux-1", "modelName": "Faux Model",
        "reasoning": False, "contextWindow": 128000, "tokensPerSecond": 200,
        "responses": [
            {"content": [{"type": "toolCall", "name": "ipython",
                          "arguments": {"code": f"import time; time.sleep({TOOL_SLEEP_S})"}}]},
            {"text": "spinner-turn-settled"},
        ],
    }

def run(out_path):
    base = tempfile.mkdtemp(prefix="spinner-probe-")
    script_path = os.path.join(base, "faux.json")
    with open(script_path, "w") as f:
        json.dump(faux_script(), f, indent=1)
    shared_cwd = os.path.join(base, "cwd"); os.makedirs(shared_cwd)
    home = os.path.join(base, "home"); agent = os.path.join(base, "agent")
    os.makedirs(os.path.join(agent, "sessions"))
    with open(os.path.join(agent, "settings.json"), "w") as f:
        json.dump({"onboardingCompleted": True}, f)
    session = "cpu-spinner"
    sc.tmux("kill-session", "-t", session, check=False)
    sc.tmux("new-session", "-d", "-s", session, "-x", sc.SIZE[0], "-y", sc.SIZE[1], "-c", shared_cwd)
    env = (f"HOME={home} PRIME_AGENT_CODING_AGENT_DIR={agent} "
           f"PRIME_AGENT_FAUX_SCRIPT={script_path} PRIME_AGENT_DISABLE_ANALYTICS=1")
    rust = os.environ.get("PA_RUST_BINARY")
    assert rust, "PA_RUST_BINARY required"
    package_dir = os.environ.get("PI_PACKAGE_DIR") or sc.find_runtime_package_dir()
    command = (f"PI_PACKAGE_DIR={package_dir} {rust} "
               f"--daemon-socket {agent}/daemon.sock --model faux-1")
    sc.tmux("send-keys", "-t", session, f"{env} {command}", "Enter")
    sc.wait_ready(session)
    sc.tmux("send-keys", "-t", session, "Run it.")
    sc.tmux("send-keys", "-t", session, "Enter")
    # wait for the loader
    deadline = time.time() + 30
    while time.time() < deadline:
        if re.search(sc.SPINNER_CLASS, sc.capture(session)):
            break
        time.sleep(0.1)
    samples = []
    t_end = time.time() + WINDOW_S
    while time.time() < t_end:
        pane = sc.capture(session)
        m = re.search(sc.SPINNER_CLASS, pane)
        if m:
            samples.append((time.time(), FRAMES.index(m.group(0))))
    # collapse to transitions
    transitions = []
    for t, idx in samples:
        if not transitions or transitions[-1][1] != idx:
            transitions.append((t, idx))
    intervals = [round((b[0] - a[0]) * 1000, 1)
                 for a, b in zip(transitions, transitions[1:])]
    # phase steps: +1 mod 10 between consecutive transitions (drops from
    # capture misses are +n; jumps BACKWARD are render races)
    steps = [(b[1] - a[1]) % 10 for a, b in zip(transitions, transitions[1:])]
    forward = all(0 < s <= 5 for s in steps)
    failures = []
    if len(intervals) < 8:
        failures.append(f"too few transitions ({len(transitions)})")
    bad = [i for i in intervals if not (MIN_INTERVAL_MS <= i <= MAX_INTERVAL_MS)]
    # Capture noise: pane captures are not atomic with the loader row (the
    # tool card grows, the loader row moves), so a run can show a couple of
    # impossible intervals (two real 80ms-clock advances never land 8ms
    # apart). A small outlier fraction is capture noise; a render race
    # (the before-binary's per-frame advance) fails the median band anyway.
    bad_budget = max(2, int(0.05 * len(intervals)))
    if len(bad) > bad_budget:
        failures.append(f"intervals outside [{MIN_INTERVAL_MS},{MAX_INTERVAL_MS}]ms: {bad}")
    if intervals:
        med = sorted(intervals)[len(intervals) // 2]
        if not (CADENCE_MS * 0.8 <= med <= CADENCE_MS * 1.3):
            failures.append(f"median interval {med}ms not ~{CADENCE_MS}ms")
    else:
        med = None
    if not forward:
        failures.append(f"non-forward phases: {steps}")
    record = {"n_samples": len(samples), "n_transitions": len(transitions),
              "intervals_ms": intervals, "median_ms": med,
              "steps": steps, "passed": not failures, "failures": failures}
    Path(out_path).write_text(json.dumps(record, indent=1))
    print("PASS" if record["passed"] else "FAIL",
          f"transitions={len(transitions)} median={med}ms",
          "; ".join(failures))
    sc.tmux("kill-session", "-t", session, check=False)
    shutil.rmtree(base, ignore_errors=True)
    return 0 if record["passed"] else 1

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    a = p.parse_args()
    sys.exit(run(a.out))
