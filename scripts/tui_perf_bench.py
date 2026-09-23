#!/usr/bin/env python3
"""Large-session TUI perf regression bench (lane tui-large-session-perf).

Generates a synthetic large session (a big transcript with a bounded
post-compaction window, many passivated subagent transcripts, and a spawn
ledger), then drives a REAL pa-cli daemon + TUI in tmux and measures:

  - open_cold:  fresh daemon -> resume the target -> session view painted
  - switch_to_agents / switch_to_session: the agents-back round trip
  - switch_*_2: the second round trip (warm)

Budgets (default, on the synthetic fixture): open_cold <= 6s,
switch_to_session_2 <= 2s. Exits nonzero when a budget is breached - a
regression in the open/switch paths (ledger re-seeding, re-parsing,
blocking hydration) shows up as a budget blowup.

Usage:
  python3 scripts/tui_perf_bench.py --bin <prime-agent> [--keep-fixture]
The fixture + daemon live under /tmp/pa-tui-perf-bench-* (never the real
agent dir). Requires tmux; TERM must not be set to a dumb value.
"""
import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

TMUX_SOCK = "pabench" + uuid.uuid4().hex[:6]


def tmux(*args, check=True):
    cmd = ["tmux", "-L", TMUX_SOCK] + list(args)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"tmux {args}: {r.stderr}")
    return r.stdout


def env(agent_dir, kernel_venv=None):
    e = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/root"),
        "TERM": "xterm-256color",
        "PRIME_AGENT_CODING_AGENT_DIR": agent_dir,
        "PRIME_AGENT_TELEMETRY": "0",
    }
    if kernel_venv:
        e["PRIME_AGENT_KERNEL_VENV"] = kernel_venv
    for stale in ("PRIME_AGENT_SESSION_DIR",):
        e.pop(stale, None)
    return e


def write_line(path, value):
    with open(path, "ab") as f:
        f.write(json.dumps(value).encode() + b"\n")


def make_fixture(root, transcript_mb, children, child_mb):
    """A synthetic saved session family: one big parent transcript with a
    bounded post-compaction window, `children` passivated subagent
    transcripts, and a spawn ledger pointing at them."""
    agent_dir = os.path.join(root, "agent")
    sessions = os.path.join(agent_dir, "sessions")
    artifacts = os.path.join(agent_dir, "session-artifacts")
    parent_id = "01bench0000-0000-7000-8000-%012d" % children
    os.makedirs(sessions, exist_ok=True)
    parent_file = os.path.join(sessions, parent_id + ".jsonl")
    parent = {
        "type": "session",
        "version": 3,
        "id": parent_id,
        "timestamp": "2026-01-01T00:00:00.000Z",
        "cwd": root,
        "rlmDepth": 0,
    }
    write_line(parent_file, parent)
    # Pre-compaction bulk: enough message entries to reach ~transcript_mb.
    target_bytes = transcript_mb * 1024 * 1024
    filler = "x" * 1024
    written = 0
    index = 0
    while written < target_bytes:
        for role in ("user", "assistant"):
            entry = {
                "type": "message",
                "id": "m%d" % index,
                "parentId": "m%d" % (index - 1) if index else None,
                "timestamp": "2026-01-01T00:00:00.000Z",
                "message": {
                    "role": role,
                    "content": [{"type": "text", "text": filler}],
                },
            }
            write_line(parent_file, entry)
            written += 1100
            index += 1
    # The compaction boundary: everything above collapses; the window below
    # is what the attach snapshot carries.
    write_line(parent_file, {
        "type": "compaction",
        "id": "cmp1",
        "parentId": "m%d" % (index - 1),
        "timestamp": "2026-01-01T00:00:00.000Z",
        "summary": "synthetic compaction boundary",
        "tokensBefore": 200000,
    })
    # The visible window: what the session view must paint on open.
    marker = "BENCH-FIXTURE-MARKER final tail"
    for i in range(40):
        write_line(parent_file, {
            "type": "message",
            "id": "w%d" % i,
            "parentId": "cmp1" if i == 0 else "w%d" % (i - 1),
            "timestamp": "2026-01-01T00:00:00.000Z",
            "message": {
                "role": "assistant" if i == 39 else "user",
                "content": [{"type": "text", "text": marker if i == 39 else "window entry %d" % i}],
            },
        })
    # The passivated children: one transcript each under the parent's
    # artifacts dir, wired by spawn-ledger edges. Each child transcript is
    # `child_mb` MB - the ledger-seed walk re-reads every one of them on
    # every roster subscribe in the regressed shape, so the fixture must
    # carry realistic (multi-MB) children to catch that class.
    parent_artifacts = os.path.join(artifacts, parent_id)
    edges = [{
        "v": 1,
        "op": "meta",
        "at": "2026-01-01T00:00:00.000Z",
        "sessionsDir": sessions,
    }]
    for c in range(children):
        child_id = "01benchchild%04d-0000-7000-8000-%012d" % (c, c)
        sub_dir = os.path.join(parent_artifacts, "sub-%06d" % c)
        os.makedirs(sub_dir, exist_ok=True)
        child_file = os.path.join(sub_dir, child_id + ".jsonl")
        write_line(child_file, {
            "type": "session", "version": 3, "id": child_id,
            "timestamp": "2026-01-01T00:00:00.000Z",
            "cwd": root, "parentSession": parent_file,
            "rlmDepth": 1,
        })
        child_target = child_mb * 1024 * 1024
        child_written = 0
        m = 0
        while child_written < child_target:
            write_line(child_file, {
                "type": "message",
                "id": "c%d" % m,
                "parentId": "c%d" % (m - 1) if m else None,
                "timestamp": "2026-01-01T00:00:00.000Z",
                "message": {
                    "role": "user" if m == 0 else "assistant",
                    "content": [{"type": "text", "text": filler}],
                },
            })
            child_written += 1100
            m += 1
        edges.append({
            "v": 1, "op": "spawn", "at": "2026-01-01T00:00:00.000Z",
            "childId": "sub-%06d" % c,
            "parent": parent_file,
            "child": child_file,
            "name": "bench-worker-%d" % c,
            "depth": 1,
        })
    ledger_hash = hashlib.sha256(os.path.realpath(sessions).encode()).hexdigest()[:16]
    ledger_dir = os.path.join(agent_dir, "rlm-ledger")
    os.makedirs(ledger_dir, exist_ok=True)
    ledger_file = os.path.join(ledger_dir, ledger_hash + ".jsonl")
    with open(ledger_file, "wb") as f:
        for edge in edges:
            f.write(json.dumps(edge).encode() + b"\n")
    return agent_dir, parent_file, marker


def wait_for(marker_fn, timeout, desc, t0):
    while True:
        pane = tmux("capture-pane", "-p", "-t", "bench:0.0", "-S", "-100")
        if marker_fn(pane):
            return time.monotonic() - t0
        if time.monotonic() - t0 > timeout:
            raise TimeoutError("%s not visible in %ss; pane tail:\n%s" % (desc, timeout, pane[-1200:]))
        time.sleep(0.02)


SESSION_MARKER = "BENCH-FIXTURE-MARKER"
AGENTS_MARKER = "Search sessions"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True, help="path to the prime-agent binary to bench")
    ap.add_argument("--transcript-mb", type=int, default=30)
    ap.add_argument("--children", type=int, default=200)
    ap.add_argument("--child-mb", type=float, default=2.0)
    ap.add_argument("--open-budget", type=float, default=6.0)
    ap.add_argument("--switch-budget", type=float, default=2.0)
    ap.add_argument("--keep-fixture", action="store_true")
    args = ap.parse_args()

    root = tempfile.mkdtemp(prefix="pa-tui-perf-bench-")
    agent_dir, target, marker = make_fixture(root, args.transcript_mb, args.children, args.child_mb)
    socket = os.path.join(root, "daemon.sock")
    results = {"fixture": {"transcript_mb": args.transcript_mb,
                          "children": args.children, "child_mb": args.child_mb}}
    daemon_log = open(os.path.join(root, "daemon.log"), "wb")
    daemon = subprocess.Popen(
        [args.bin, "--mode", "daemon", "--daemon-socket", socket],
        stdout=daemon_log, stderr=daemon_log, stdin=subprocess.DEVNULL,
        env=env(agent_dir), start_new_session=True,
    )
    t0 = time.time()
    while not os.path.exists(socket):
        if time.time() - t0 > 60:
            raise RuntimeError("daemon socket never appeared")
        time.sleep(0.05)
    try:
        bin_env = env(agent_dir)
        t0 = time.monotonic()
        tmux("new-session", "-d", "-s", "bench", "-x", "200", "-y", "45", "-c", root,
             "env", "PRIME_AGENT_CODING_AGENT_DIR=" + agent_dir, "TERM=xterm-256color",
             args.bin, "--daemon-socket", socket, "--resume", target)
        results["open_cold_s"] = round(wait_for(
            lambda pane: SESSION_MARKER in pane, 90, "cold open session view", t0), 3)
        time.sleep(1.0)
        def switch(keys, desc, timeout=60):
            tmux("send-keys", "-t", "bench:0.0", keys)
            t = time.monotonic()
            return round(wait_for(
                lambda pane: AGENTS_MARKER in pane if desc.startswith("agents") else SESSION_MARKER in pane,
                timeout, desc, t), 3)
        results["switch_to_agents_s"] = switch("Left", "agents view")
        time.sleep(1.0)
        results["switch_to_session_s"] = switch("Enter", "session view")
        time.sleep(0.5)
        results["switch_to_agents_2_s"] = switch("Left", "agents view 2")
        results["switch_to_session_2_s"] = switch("Enter", "session view 2")
        tmux("send-keys", "-t", "bench:0.0", "C-c")
        time.sleep(0.2)
        tmux("send-keys", "-t", "bench:0.0", "C-c")
    finally:
        tmux("kill-server", check=False)
        daemon.terminate()
        try:
            daemon.wait(timeout=5)
        except subprocess.TimeoutExpired:
            daemon.kill()
    print(json.dumps(results, indent=2))
    failed = False
    if results["open_cold_s"] > args.open_budget:
        print("FAIL: open_cold %.2fs > budget %.2fs" % (results["open_cold_s"], args.open_budget))
        failed = True
    if results["switch_to_session_2_s"] > args.switch_budget:
        print("FAIL: warm switch %.2fs > budget %.2fs" % (results["switch_to_session_2_s"], args.switch_budget))
        failed = True
    if not args.keep_fixture:
        shutil.rmtree(root, ignore_errors=True)
    else:
        print("fixture kept at", root)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
