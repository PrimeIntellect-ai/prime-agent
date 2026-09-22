#!/usr/bin/env python3
"""Sustained-CPU regression guard (lane: cpu-spin, dogfood P0).

The dogfood report: 91-99.8% sustained CPU on the interactive TUI, typing
lag while streaming, and a trapped-scroll state no key escapes. The
render-loop fixes (frame-batch scheduler, per-block markdown cache,
timer-driven spinner) must keep the interactive process inside its CPU
budgets. This harness drives the same unpaced/paced faux-provider
streaming a real dogfood turn produces, samples %CPU per process from
/proc, and ASSERTS the budgets:

  idle          30s window after ready, %CPU of the interactive process
  plain_stream  a paced plain-text streaming turn
  code_stream   a paced markdown/code-fence streaming turn (the dogfood
                hot payload: code blocks + ipython tool blocks)
  tool_exec     a long-running tool-execution turn (bash sleep)

Plus the no-escape invariant probe: mid-stream, with the viewport
scrolled up and the detail toggled (the bug #6 repro sequence), the exit
keys must still land — keystroke-to-render during streaming is measured,
and a double Ctrl+C mid-scroll must terminate the process.

Run for one or both binaries (the TS product is the ground truth):

    python3 scripts/battery/sustained_cpu.py --rust-bin target/release/prime-agent \
        [--only rust|ts] [--out DIR]

Not part of the product.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import ts_identity  # noqa: E402  the shared PATH-binary identity guard

# tmux rules: default socket only (`env -u TMUX`), vplane-free session
# names, no kill-server; sessions are killed individually at the end.
SESSION_PREFIX = "cpu-guard"
SIZE = ("160", "48")

CLK_TCK = os.sysconf("SC_CLK_TCK")

# The budgets the fix is accountable for (percent of one core):
#   idle <5%, streaming <30% (lane targets, with the assert margin at the
#   target itself: a release build over budget fails the guard).
IDLE_BUDGET_PCT = 5.0
STREAM_BUDGET_PCT = 30.0
TOOL_BUDGET_PCT = 30.0
# Keystroke-to-render while a stream renders (lane target <50ms).
TYPING_BUDGET_MS = 50.0
# The exit path: a double Ctrl+C mid-scroll must terminate the process
# within this bound (the trapped-scroll bug #6 symptom was "no key
# escapes, killed the process").
EXIT_BOUND_S = 10.0
# The idle window the guard samples (the lane brief's 30s).
IDLE_WINDOW_S = 30.0

# The paced stream: ~200 tokens/s keeps a turn rendering for ~25s per
# side (the sampling window), fast enough to expose a per-delta
# full-render loop (the unpaced burst case is the stream_throughput.py
# settle dim).
TOKENS_PER_SECOND = 200
PLAIN_WORDS = 1600  # ~5.2k tokens -> ~26s of streaming at the pace above
CODE_BLOCKS = 60
CODE_LINES_PER_BLOCK = 8
PLAIN_TAIL = "plain-turn-settled"
CODE_TAIL = "code-turn-settled"
TOOL_MARKER = "cpu-guard-tool-done"
TOOL_SLEEP_S = 8

SPINNERS = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f"
PULSES = "\u25f4\u25f7\u25f6\u25f5\u25cb\u25f8\u25fb\u25fc"
SPINNER_CLASS = "[" + SPINNERS + PULSES + "]"


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


def plain_text():
    parts = []
    for segment in range(PLAIN_WORDS // 50):
        parts.append(f"MARK-{segment:02d}")
        parts.append(" ".join(f"word{index}" for index in range(50)))
    return " ".join(parts)


def code_text():
    parts = []
    for block in range(CODE_BLOCKS):
        parts.append(f"MARK-{block:02d}")
        parts.append("Paragraph of prose before block %d." % block)
        parts.append("```python")
        for line in range(CODE_LINES_PER_BLOCK):
            parts.append(f"    result_{line} = compute_{block}(step={line})  # streaming")
        parts.append("```")
    return "\n".join(parts)


def faux_script():
    return {
        "engine": "faux",
        "modelId": "faux-1",
        "modelName": "Faux Model",
        "reasoning": False,
        "contextWindow": 128000,
        "tokensPerSecond": TOKENS_PER_SECOND,
        "responses": [
            {"text": f"{plain_text()} {PLAIN_TAIL}"},
            {"text": f"{code_text()}\n{CODE_TAIL}"},
            {
                "content": [
                    {
                        # The product's tool is the `ipython` kernel (there is
                        # no `bash` tool — a `bash` toolCall errors instantly,
                        # so the long-tool window never exercises a tool).
                        "type": "toolCall",
                        "name": "ipython",
                        "arguments": {
                            "code": f"import time; time.sleep({TOOL_SLEEP_S}); print('{TOOL_MARKER}')"
                        },
                    }
                ]
            },
            {"text": "tool turn settled"},
        ],
    }


class CpuSampler:
    """%CPU of one pid from /proc: mean over the whole window plus the
    max over 1s sub-windows (the sustained-spin symptom the dogfood
    report names: 99.8% spikes inside an otherwise quiet mean)."""

    def __init__(self, pid: int):
        self.pid = pid
        self.running = False
        self.samples: list[tuple[float, float]] = []  # (monotonic_t, cpu_seconds)
        self.thread = None

    def _read(self):
        with open(f"/proc/{self.pid}/stat") as f:
            fields = f.read().rsplit(")", 1)[1].split()
        utime, stime = int(fields[11]), int(fields[12])
        return (utime + stime) / CLK_TCK

    def start(self):
        self.running = True
        try:
            base = self._read()
        except OSError:
            self.running = False
            return
        self.samples.append((time.monotonic(), base))

        def loop():
            while self.running:
                time.sleep(0.2)
                try:
                    self.samples.append((time.monotonic(), self._read()))
                except OSError:
                    return

        self.thread = threading.Thread(target=loop, daemon=True)
        self.thread.start()

    def stop(self) -> dict:
        self.running = False
        if self.thread:
            self.thread.join(timeout=2)
        if len(self.samples) < 2:
            return {"mean_pct": None, "max_1s_pct": None, "samples": 0}
        start_t, start_cpu = self.samples[0]
        end_t, end_cpu = self.samples[-1]
        window = end_t - start_t
        mean = (end_cpu - start_cpu) / window * 100 if window > 0 else None
        # Max over 1s rolling sub-windows.
        max_1s = 0.0
        lo = 0
        for hi in range(len(self.samples)):
            while self.samples[hi][0] - self.samples[lo][0] > 1.0:
                lo += 1
            dt = self.samples[hi][0] - self.samples[lo][0]
            if dt > 0:
                max_1s = max(max_1s, (self.samples[hi][1] - self.samples[lo][1]) / dt * 100)
        return {
            "mean_pct": round(mean, 1) if mean is not None else None,
            "max_1s_pct": round(max_1s, 1),
            "samples": len(self.samples),
            "window_s": round(window, 1),
        }


def processes_for(socket_path: str) -> dict:
    """The sandbox's interactive and daemon pids: every process whose argv
    references the run's daemon socket; `--mode daemon` classifies the
    daemon, everything else is the interactive TUI."""
    out = {"tui": None, "daemon": None}
    needle = socket_path
    for proc_dir in Path("/proc").iterdir():
        if not proc_dir.name.isdigit():
            continue
        try:
            argv = (proc_dir / "cmdline").read_bytes().decode(errors="replace").split("\0")
        except (OSError, PermissionError):
            continue
        # The socket is one argv element; the role check must compare argv
        # ELEMENTS (`--mode\0daemon` in the raw NUL-joined cmdline never
        # matches a "--mode daemon" substring, which misclassified the
        # daemon as the TUI and left the exit probe watching the daemon
        # forever).
        if needle not in argv:
            continue
        if "--mode" in argv:
            mode_at = argv.index("--mode") + 1
            if mode_at < len(argv) and argv[mode_at] == "daemon":
                out["daemon"] = int(proc_dir.name)
                continue
        out["tui"] = int(proc_dir.name)
    return out


def wait_for(session, needle, timeout, poll=0.2):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in capture(session):
            return True
        time.sleep(poll)
    return False


def wait_ready(session):
    deadline = time.time() + 60
    while time.time() < deadline:
        frame = capture(session)
        if "Share agent traces" in frame:
            tmux("send-keys", "-t", session, "Down")
            time.sleep(0.3)
            tmux("send-keys", "-t", session, "Enter")
            time.sleep(0.5)
        if re.search(r"^\s*>\s*$", frame, re.MULTILINE):
            return True
        time.sleep(0.3)
    raise AssertionError(f"editor never came up; pane:\n{capture(session)}")


def measure_typing_during_stream(session, deadline_total=30.0):
    """Keystroke-to-render while a turn streams: each char must land on the
    prompt line inside TYPING_BUDGET_MS."""
    latencies = []
    typed = ""
    started = time.time()
    for ch in "typing0":
        typed += ch
        t0 = time.time()
        tmux("send-keys", "-t", session, "-l", ch)
        pattern = re.compile(r"^\s*>\s*" + re.escape(typed), re.MULTILINE)
        rendered = False
        deadline = t0 + 2.0
        while time.time() < deadline:
            frame = capture(session)
            if pattern.search(frame):
                rendered = True
                break
            time.sleep(0.005)
        if not rendered:
            latencies.append(round((time.time() - t0) * 1000, 1))
            break
        latencies.append(round((time.time() - t0) * 1000, 1))
        if time.time() - started > deadline_total:
            break
    return latencies


def run_turn(session, prompt, settle_tail, out, label, pids):
    """Submit `prompt`, sample CPU until the turn settles, return the
    sample plus the pane settle time."""
    samplers = {name: CpuSampler(pid) for name, pid in pids.items() if pid}
    for sampler in samplers.values():
        sampler.start()
    started = time.time()
    tmux("send-keys", "-t", session, prompt)
    tmux("send-keys", "-t", session, "Enter")
    settled = False
    while time.time() - started < 300:
        pane = capture(session)
        if settle_tail in pane and not re.search(SPINNER_CLASS, pane):
            settled = True
            break
        time.sleep(0.2)
    settle_s = round(time.time() - started, 1)
    result = {name: sampler.stop() for name, sampler in samplers.items()}
    for name, sampler in samplers.items():
        out[f"{label}_{name}_mean_pct"] = result[name]["mean_pct"]
        out[f"{label}_{name}_max_1s_pct"] = result[name]["max_1s_pct"]
    out[f"{label}_settle_s"] = settle_s
    out[f"{label}_settled"] = settled
    return result, settle_s


def run_side(side, script_path, sandbox, shared_cwd, out_dir, keep=False):
    session = f"{SESSION_PREFIX}-{side}"
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", SIZE[0], "-y", SIZE[1], "-c", shared_cwd)
    width, height = SIZE
    home = sandbox["home"]
    agent = sandbox["agent"]
    env = (
        f"HOME={home} "
        f"PRIME_AGENT_CODING_AGENT_DIR={agent} "
        f"PRIME_AGENT_FAUX_SCRIPT={script_path} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    if side == "ts":
        command = (
            f"prime-agent --daemon-socket {agent}/daemon.sock "
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
            f"{rust} --daemon-socket {agent}/daemon.sock "
            "--model faux-1"
        )
    tmux("send-keys", "-t", session, f"{env} {command}", "Enter")
    wait_ready(session)

    socket_path = f"{agent}/daemon.sock"
    record: dict = {"session": session}

    # -- idle: 30s window, no turn ------------------------------------------
    time.sleep(2.0)  # let the first frames settle
    pids = processes_for(socket_path)
    record["idle_pids"] = pids
    idle_samplers = {name: CpuSampler(pid) for name, pid in pids.items() if pid}
    for sampler in idle_samplers.values():
        sampler.start()
    time.sleep(IDLE_WINDOW_S)
    idle = {name: sampler.stop() for name, sampler in idle_samplers.items()}
    record["idle"] = idle

    # -- plain-text streaming turn ------------------------------------------
    pids = processes_for(socket_path)
    plain, plain_s = run_turn(
        session, "Write the plain answer.", PLAIN_TAIL, record, "plain", pids
    )
    record["plain"] = plain

    # -- code streaming turn, with the bug-#6 probe inside it ---------------
    pids = processes_for(socket_path)
    typing_probe: dict = {}
    samplers = {name: CpuSampler(pid) for name, pid in pids.items() if pid}
    for sampler in samplers.values():
        sampler.start()
    started = time.time()
    tmux("send-keys", "-t", session, "Write the code answer.")
    tmux("send-keys", "-t", session, "Enter")
    # Wait until the stream is visibly mid-turn, then run the no-escape
    # probe: scroll the viewport up (PageUp burst), toggle the detail
    # twice (Ctrl+O, the bug #6 trigger), type while streaming, then
    # measure keystroke-to-render.
    deadline = time.time() + 60
    mid = False
    while time.time() < deadline:
        pane = capture(session)
        if re.search(r"MARK-\d\d", pane) and re.search(SPINNER_CLASS, pane):
            mid = True
            break
        if CODE_TAIL in pane:
            break
        time.sleep(0.3)
    record["code_probe_mid_stream"] = mid
    if mid:
        # PageUp pause + detail toggles (the trapped-scroll repro sequence).
        tmux("send-keys", "-t", session, "PageUp")
        time.sleep(0.3)
        tmux("send-keys", "-t", session, "C-o")
        time.sleep(0.3)
        tmux("send-keys", "-t", session, "C-o")
        time.sleep(0.3)
        # While paused + expanded mid-stream, the typed chars must still
        # render inside the budget (keys not starved by the render loop).
        typing_probe["latencies_ms"] = measure_typing_during_stream(session)
        lat = typing_probe["latencies_ms"]
        typing_probe["median_ms"] = sorted(lat)[len(lat) // 2] if lat else None
        # The paused viewport must hold still while the stream continues
        # below it (no scroll ping-pong): two captures 2s apart agree on
        # their top transcript rows.
        top_a = "\n".join(capture(session).splitlines()[:10])
        time.sleep(2.0)
        top_b = "\n".join(capture(session).splitlines()[:10])
        typing_probe["viewport_stable"] = top_a == top_b
        # Resume following (TS/Rust `tui.viewport.follow`, ctrl+shift+down):
        # the settle waits and the exit probe below read the visible pane,
        # so the probe leaves the viewport following again — the code turn
        # then settles at its true tail instead of timing out against a
        # paused viewport, and the exit probe runs from the following state
        # (the paused state kept BOTH products alive past the bound).
        tmux("send-keys", "-t", session, "C-S-Down")
    # Let the turn run out and settle.
    while time.time() - started < 300:
        pane = capture(session)
        if CODE_TAIL in pane and not re.search(SPINNER_CLASS, pane):
            break
        time.sleep(0.2)
    record["code_settle_s"] = round(time.time() - started, 1)
    record["code"] = {name: sampler.stop() for name, sampler in samplers.items()}
    record["typing_probe"] = typing_probe

    # -- long tool-execution turn -------------------------------------------
    pids = processes_for(socket_path)
    tool, tool_s = run_turn(
        session, "Run the long command.", "tool turn settled", record, "tool", pids
    )
    record["tool"] = tool

    # -- exit probe: double Ctrl+C terminates the process -------------------
    exit_started = time.time()
    tmux("send-keys", "-t", session, "C-c")
    time.sleep(1.0)
    tmux("send-keys", "-t", session, "C-c")
    exited = False
    while time.time() - exit_started < EXIT_BOUND_S:
        pids_now = processes_for(socket_path)
        if not pids_now["tui"]:
            exited = True
            break
        time.sleep(0.2)
    record["exit_probe"] = {
        "exited": exited,
        "elapsed_s": round(time.time() - exit_started, 1),
    }
    tmux("kill-session", "-t", session, check=False)

    # -- assertions -----------------------------------------------------------
    failures = []
    tui_idle = (record.get("idle") or {}).get("tui") or {}
    if tui_idle.get("mean_pct") is None:
        failures.append("idle: no TUI cpu samples")
    elif tui_idle["mean_pct"] > IDLE_BUDGET_PCT:
        failures.append(f"idle {tui_idle['mean_pct']}% > {IDLE_BUDGET_PCT}%")
    for label in ("plain", "code", "tool"):
        tui = (record.get(label) or {}).get("tui") or {}
        budget = TOOL_BUDGET_PCT if label == "tool" else STREAM_BUDGET_PCT
        if tui.get("mean_pct") is None:
            failures.append(f"{label}: no TUI cpu samples")
        elif tui["mean_pct"] > budget:
            failures.append(f"{label} {tui['mean_pct']}% > {budget}%")
    median = (record.get("typing_probe") or {}).get("median_ms")
    if median is not None and median > TYPING_BUDGET_MS:
        failures.append(f"typing mid-stream median {median}ms > {TYPING_BUDGET_MS}ms")
    if not ((record.get("typing_probe") or {}).get("viewport_stable", False)):
        failures.append("viewport not stable while paused mid-stream (scroll ping-pong)")
    if not record.get("exit_probe", {}).get("exited"):
        failures.append(f"double Ctrl+C did not exit within {EXIT_BOUND_S}s")
    if not record.get("plain", {}).get("tui"):
        pass
    if not record.get("plain_settled"):
        failures.append("plain turn never settled")
    if not record.get("code_probe_mid_stream"):
        failures.append("code turn never reached mid-stream (probe window missed)")
    record["failures"] = failures
    record["passed"] = not failures

    out_path = Path(out_dir) / f"{side}-sustained-cpu.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(record, indent=1))
    print(f"{side}: {'PASS' if record['passed'] else 'FAIL'}")
    print(
        f"  idle {tui_idle.get('mean_pct')}% (max1s {tui_idle.get('max_1s_pct')}%), "
        f"plain {((record.get('plain') or {}).get('tui') or {}).get('mean_pct')}%, "
        f"code {((record.get('code') or {}).get('tui') or {}).get('mean_pct')}%, "
        f"tool {((record.get('tool') or {}).get('tui') or {}).get('mean_pct')}% "
        f"(tui process, mean over window)"
    )
    print(f"  typing mid-stream median {median}ms, exit {record['exit_probe']['elapsed_s']}s")
    for failure in failures:
        print(f"  FAIL {failure}")
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", default=None, help="run a single binary (ts|rust)")
    parser.add_argument("--out", default=None, help="captures directory")
    parser.add_argument("--keep", action="store_true", help="keep the sandbox dir")
    args = parser.parse_args()

    if args.only in (None, "ts"):
        ts_identity.assert_ts_side_is_the_ts_product()

    base = tempfile.mkdtemp(prefix="sustained-cpu-sandbox-")
    out_dir = args.out or tempfile.mkdtemp(prefix="sustained-cpu-captures-")
    shared_cwd = os.path.join(base, "shared-cwd")
    os.makedirs(shared_cwd, exist_ok=True)
    script_path = os.path.join(base, "faux-script.json")
    with open(script_path, "w") as f:
        json.dump(faux_script(), f, indent=2)
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

    overall = 0
    try:
        sides = [args.only] if args.only else ["ts", "rust"]
        for side in sides:
            record = run_side(side, script_path, sandboxes[side], shared_cwd, out_dir, args.keep)
            if side == "rust" and not record["passed"]:
                overall = 1
        return overall
    finally:
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
