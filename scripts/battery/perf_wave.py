#!/usr/bin/env python3
"""TS-vs-Rust performance wave: the f10 dimensions plus the extended set.

Every dimension runs the TS binary and the Rust binary side by side through
the same tmux pane channel / daemon wire a real user drives, against the
same deterministic mock provider (batterylib). Medians over N interleaved
trials; the differential is the reported number.

Dimensions (each writes evidence under <run>/<dim>/<side>/):
  startup_typing  cold startup to ready + keystroke-to-render (f10 rerun)
  idle_rss        steady-state RSS after a cold launch (daemon + TUI tree)
  load_rss        RSS with 3 attached sessions, each running a kernel cell
  resume          cold resume of a 1000+ row transcript to ready
  kernel_spawn    prompt -> first ipython cell output rendered (boot + warm)
  streaming       unpaced ~12k-token turn settle (tokens/sec through TUI;
                  reuses stream_throughput.py)
  compaction      wire `compact` pipeline duration on an imported 1000+ row
                  session
  export          `session export` (HTML) wall time on the large corpus
  daemon_overhead daemon-tree RSS delta across 10 idle sessions
  sustained_cpu   30s idle + paced plain/code streaming + long tool turn
                  %CPU of the interactive process, asserted (render-loop
                  regression guard, lane cpu-spin)

Runs on the mission box or in a perf sandbox; timings are only comparable
when both sides run on the same quiet machine, so the intended execution is
a fresh Prime sandbox (see .github/workflows/benchmark.yml and
scripts/battery/run_perf_wave.sh).

Not part of the product.

Usage:
    python3 scripts/battery/perf_wave.py [--dims all] [--trials 5]
        [--runs-root scripts/battery/runs] [--ts-bin prime-agent]
        [--rust-bin target/release/prime-agent] [--run-name perf-wave]
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import batterylib as B  # noqa: E402
import perf as P  # noqa: E402
import scale_corpus  # noqa: E402
import ts_identity  # noqa: E402

NL = chr(10)

ALL_DIMS = [
    "startup_typing",
    "idle_rss",
    "load_rss",
    "resume",
    "kernel_spawn",
    "streaming",
    "compaction",
    "export",
    "daemon_overhead",
    "sustained_cpu",
]

# The 1000+ row resume/export corpus: 350 turns -> 1078 rows.
CORPUS_TURNS = 350
CORPUS_ROWS = scale_corpus.corpus_rows(CORPUS_TURNS)
# The compaction dim grows its sessions through live turns instead (see
# the PARITY NOTE above).

KERNEL_MARKER = "KERNEL_BENCH_42"
KERNEL_CODE = f"print('{KERNEL_MARKER}')"

# RSS settling: the interactive tree must be quiet for this long before a
# memory sample is taken.
RSS_QUIET_S = 3.0


class PerfWave:
    def __init__(self, run_dir: Path, ts_bin: str, rust_bin: str, dims: list[str], trials: int):
        self.run_dir = run_dir
        self.stamp = run_dir.name
        self.ts_bin = ts_bin
        self.rust_bin = rust_bin
        self.dims = dims
        self.trials = trials
        self.runid = "vwave" + self.stamp
        self.sides: dict[str, B.Side] = {}
        self.tmpdirs: dict[str, Path] = {}

    # -- setup / teardown ----------------------------------------------------

    def make_side(self, name: str, binary: str) -> B.Side:
        root = self.run_dir / name
        (root / "agent").mkdir(parents=True, exist_ok=True)
        (root / "work").mkdir(parents=True, exist_ok=True)
        mock = B.MockProvider(root, [])
        mock.set_responses([{"text": "hello"}])
        mock.start()
        tmpdir = Path("/tmp") / f"{self.runid}-{name}"
        if tmpdir.exists():
            shutil.rmtree(tmpdir)
        tmpdir.mkdir(parents=True)
        self.tmpdirs[name] = tmpdir
        side = B.Side(
            name=name,
            binary=binary,
            root=root,
            agent_dir=root / "agent",
            work_dir=root / "work",
            daemon_socket=root / "daemon.sock",
            mock=mock,
        )
        side.env = B.scrubbed_env(side.agent_dir, tmpdir)
        if name == "rust":
            # The Rust binary resolves the kernel runtime sidecar through
            # PI_PACKAGE_DIR (the checkout ships prime-agent-runtime/).
            side.env["PI_PACKAGE_DIR"] = str(Path(__file__).resolve().parents[2])
        side.env["PRIME_API_KEY"] = "sk-battery"
        side.write_models_json()
        self.sides[name] = side
        return side

    def teardown_sides(self) -> None:
        for side in self.sides.values():
            side.stop_daemon()
        for tmpdir in self.tmpdirs.values():
            shutil.rmtree(tmpdir, ignore_errors=True)
        for side in self.sides.values():
            side.mock.stop()

    def onboard(self, side: B.Side) -> None:
        """Settle first-run dialogs once (the perf.py launch gate)."""
        socket = side.root / "onboard.sock"
        socket.parent.mkdir(parents=True, exist_ok=True)
        if socket.exists():
            socket.unlink()
        session = f"{self.runid}-onboard-{side.name}"
        B.tmux_launch(session, P.launch_argv(side, socket), side.env, side.work_dir)
        deadline = time.time() + 30
        while time.time() < deadline:
            frame = B.tmux_capture(session)
            if "Share agent traces" in frame:
                B.tmux_send(session, "Down")
                time.sleep(0.5)
                B.tmux_send(session, "Enter")
                time.sleep(1.0)
            elif P.is_ready(side.name, frame):
                break
            else:
                time.sleep(0.5)
        deadline = time.time() + 30
        while time.time() < deadline:
            if P.is_ready(side.name, B.tmux_capture(session)):
                break
            time.sleep(0.5)
        B.tmux_kill(session)
        P.stop_perf_daemon(socket)

    # -- RSS sampling ---------------------------------------------------------

    def side_process_records(self, side: B.Side) -> list[dict]:
        """Every live process belonging to this side's product tree: the
        environ carries the side's isolated agent dir + TMPDIR into every
        spawned process (daemon, supervisor, TUI, workers, kernels), so the
        env is the complete, product-agnostic scope (argv-based sweeps miss
        short-argv workers)."""
        records = []
        agent_needle = str(side.agent_dir)
        tmp_needle = str(self.tmpdirs[side.name])
        socket_needle = str(side.daemon_socket)
        for proc_dir in Path("/proc").iterdir():
            if not proc_dir.name.isdigit():
                continue
            pid = int(proc_dir.name)
            if pid in (1, os.getpid()):
                continue
            try:
                argv = [
                    part.decode(errors="replace")
                    for part in (proc_dir / "cmdline").read_bytes().split(b"\0")
                    if part
                ]
            except OSError:
                continue
            environ_text = ""
            try:
                environ_text = (proc_dir / "environ").read_bytes().decode(errors="replace")
            except OSError:
                pass
            owns = (
                agent_needle in environ_text
                or tmp_needle in environ_text
                or socket_needle in " ".join(argv)
            )
            if not owns or not argv:
                continue
            try:
                status = (proc_dir / "status").read_text()
            except OSError:
                continue
            rss_kb = 0
            for line in status.splitlines():
                if line.startswith("VmRSS:"):
                    rss_kb = int(line.split()[1])
                    break
            if rss_kb == 0:
                continue
            records.append(
                {
                    "pid": pid,
                    "role": self.role_of(argv),
                    "rss_kb": rss_kb,
                    "argv": argv[:6],
                }
            )
        return records

    @staticmethod
    def role_of(argv: list[str]) -> str:
        if "--mode" in argv and "daemon" in argv:
            return "daemon"
        if "worker" in argv:
            return "worker"
        if argv[0].endswith(("python", "python3")) or "rlm.repl" in " ".join(argv):
            return "kernel"
        if "--daemon-socket" in argv:
            return "interactive"
        return "other"

    def rss_sample(self, side: B.Side, quiet_s: float = RSS_QUIET_S) -> dict:
        """Take an RSS sample once the tree is quiet: no transient
        setup/install processes (the first-touch kernel-runtime provision —
        `uv pip install`, venv creation, build backends — runs in the
        background and would otherwise land in the sample; run 3 of the
        2026-09-21 wave caught a 147 MB `uv` install on the TS side), and
        the total stable to ±2% across `quiet_s` seconds."""
        # The transient wait (kernel-runtime provisioning) is effectively
        # uncapped: a cold sandbox installs numpy/pandas-class packages and
        # `uv` can run for minutes; sampling during it reports install
        # memory as idle memory. The stability gate below still applies.
        deadline = time.time() + 600.0
        stable_since: float | None = None
        last_total = -1
        while time.time() < deadline:
            records = self.side_process_records(side)
            transient = any(
                any(
                    part in ("uv", "pip", "hatchling", "virtualenv")
                    or part.endswith("/uv")
                    or part.endswith("/pip")
                    or part.endswith("/virtualenv")
                    for part in r["argv"]
                )
                for r in records
            )
            total_kb = sum(r["rss_kb"] for r in records)
            if transient:
                stable_since = None
            elif (
                last_total >= 0
                and abs(total_kb - last_total) <= max(1.0, 0.02 * last_total)
            ):
                if stable_since is None:
                    stable_since = time.time()
                elif time.time() - stable_since >= quiet_s:
                    break
            else:
                stable_since = None
            last_total = total_kb
            time.sleep(2.0)
        records = self.side_process_records(side)
        total_kb = sum(r["rss_kb"] for r in records)
        by_role: dict[str, int] = {}
        for r in records:
            by_role[r["role"]] = by_role.get(r["role"], 0) + r["rss_kb"]
        return {
            "total_kb": total_kb,
            "by_role_kb": by_role,
            "processes": records,
        }

    def evidence(self, dim: str, side_name: str, name: str, obj) -> Path:
        path = self.run_dir / dim / side_name / name
        path.parent.mkdir(parents=True, exist_ok=True)
        text = obj if isinstance(obj, str) else json.dumps(obj, indent=1)
        path.write_text(text)
        return path

    def median(self, values: list[float]) -> float | None:
        return P.median(values)

    # -- dimension: startup + typing (the f10 rerun) ---------------------------

    def dim_startup_typing(self) -> dict:
        out: dict[str, dict] = {}
        buckets: dict[str, dict] = {}
        for side_name in ("ts", "rust"):
            buckets[side_name] = {"ready_s": [], "first_frame_s": [], "typing_ms": []}
        for i in range(self.trials):
            for side_name in ("ts", "rust"):
                side = self.sides[side_name]
                socket = side.root / "startup" / f"sock-{i}.sock"
                rec = P.measure_launch(side, f"{self.runid}-start-{side_name}-{i}", socket)
                self.evidence("startup_typing", side_name, f"launch-{i}.json", rec)
                P.stop_perf_daemon(socket)
                if rec["ready_s"] is None:
                    print(f"WARNING: {side_name} launch {i} never reached ready", file=sys.stderr)
                    continue
                bucket = buckets[side_name]
                bucket["ready_s"].append(rec["ready_s"])
                bucket["first_frame_s"].append(rec["first_frame_s"] or rec["ready_s"])
                bucket["typing_ms"].extend(rec["typing_ms"])
        for side_name in ("ts", "rust"):
            bucket = buckets[side_name]
            self.evidence("startup_typing", side_name, "summary.json", bucket)
            typing = P.summarize(bucket["typing_ms"])
            out[side_name] = {
                "ready_s_median": self.median(bucket["ready_s"]),
                "first_frame_s_median": self.median(bucket["first_frame_s"]),
                "typing_ms_median": typing.get("median"),
                "typing_ms_p95": typing.get("p95"),
                "typing_samples": typing.get("n"),
                "launches": len(bucket["ready_s"]),
            }
        return out

    # -- dimension: idle RSS ---------------------------------------------------

    def dim_idle_rss(self) -> dict:
        out: dict[str, dict] = {}
        samples: dict[str, list[dict]] = {"ts": [], "rust": []}
        for i in range(max(2, self.trials // 2 + 1)):
            for side_name in ("ts", "rust"):
                side = self.sides[side_name]
                socket = side.root / "idle" / f"sock-{i}.sock"
                socket.parent.mkdir(parents=True, exist_ok=True)
                if socket.exists():
                    socket.unlink()
                session = f"{self.runid}-idle-{side_name}-{i}"
                B.tmux_launch(
                    session, P.launch_argv(side, socket), side.env, side.work_dir
                )
                deadline = time.time() + 60
                while time.time() < deadline:
                    if P.is_ready(side_name, B.tmux_capture(session)):
                        break
                    time.sleep(0.05)
                sample = self.rss_sample(side)
                sample["trial"] = i
                samples[side_name].append(sample)
                B.tmux_kill(session)
                P.stop_perf_daemon(socket)
        for side_name in ("ts", "rust"):
            self.evidence("idle_rss", side_name, "samples.json", samples[side_name])
            totals = [s["total_kb"] for s in samples[side_name]]
            out[side_name] = {
                "total_mb_median": round(self.median(totals) / 1024.0, 1),
                "by_role_kb_median": self._median_by_role(samples[side_name]),
                "trials": len(totals),
            }
        return out

    @staticmethod
    def _median_by_role(samples: list[dict]) -> dict:
        roles: dict[str, list[int]] = {}
        for sample in samples:
            for role, kb in sample["by_role_kb"].items():
                roles.setdefault(role, []).append(kb)
        return {role: int(P.median(kbs)) for role, kbs in sorted(roles.items())}

    # -- dimension: load RSS (3 sessions with kernel activity) -----------------

    def dim_load_rss(self) -> dict:
        out: dict[str, dict] = {}
        for side_name in ("ts", "rust"):
            side = self.sides[side_name]
            self.ensure_fresh_daemon(side)
            # 3 interactive sessions on the same daemon, each running one
            # kernel cell: the mock serves one ipython tool call per pane.
            # Session-scoped mock queues: each pane's initial prompt pops a
            # per-pane ipython tool call; the post-tool continuations fall
            # through to the shared default queue (the mock excludes tool
            # results from queue matching) and get the plain done reply.
            queues = []
            for pane in range(3):
                queues.append(
                    {
                        "name": f"load-{pane}",
                        "match": [f"load bench pane {pane}"],
                        "responses": [
                            {
                                "toolCall": {
                                    "name": "ipython",
                                    "arguments": {"code": f"print('LOAD_DONE_{pane}')"},
                                }
                            }
                        ],
                    }
                )
            side.mock.set_responses(
                [{"text": f"load bench done {pane}"} for pane in range(3)], queues
            )
            panes = []
            for pane in range(3):
                session = f"{self.runid}-load-{side_name}-{pane}"
                argv = P.launch_argv(side, side.daemon_socket)
                B.tmux_launch(session, argv, side.env, side.work_dir)
                panes.append(session)
                deadline = time.time() + 90
                while time.time() < deadline:
                    if P.is_ready(side_name, B.tmux_capture(session)):
                        break
                    time.sleep(0.1)
            for pane, session in enumerate(panes):
                B.tmux_send(session, f"run load bench pane {pane}", enter=True)
            settled = 0
            deadline = time.time() + 300
            while time.time() < deadline and settled < len(panes):
                settled = 0
                for pane, session in enumerate(panes):
                    if f"LOAD_DONE_{pane}" in B.tmux_capture(session):
                        settled += 1
                time.sleep(0.5)
            if settled < len(panes):
                print(
                    f"WARNING: {side_name} load bench: only {settled}/3 panes settled",
                    file=sys.stderr,
                )
            sample = self.rss_sample(side)
            self.evidence("load_rss", side_name, "sample.json", sample)
            out[side_name] = {
                "total_mb": round(sample["total_kb"] / 1024.0, 1),
                "by_role_kb": sample["by_role_kb"],
                "panes_settled": settled,
            }
            for session in panes:
                B.tmux_kill(session)
            side.stop_daemon()
        return out

    # -- dimension: session resume ---------------------------------------------

    def corpus_path(self) -> Path:
        # Header cwd = the shared run dir (the battery's f12 pattern): one
        # corpus file, identical on both sides.
        return scale_corpus.corpus_path(CORPUS_TURNS, self.run_dir, str(self.run_dir))

    def dim_resume(self) -> dict:
        corpus = self.corpus_path()
        out: dict[str, dict] = {}
        buckets: dict[str, list] = {"ts": [], "rust": []}
        for i in range(max(3, self.trials)):
            for side_name in ("ts", "rust"):
                side = self.sides[side_name]
                socket = side.root / "resume" / f"sock-{i}.sock"
                socket.parent.mkdir(parents=True, exist_ok=True)
                if socket.exists():
                    socket.unlink()
                rec = P.measure_resume(
                    side,
                    f"{self.runid}-resume-{side_name}-{i}",
                    socket,
                    corpus,
                    timeout_s=300.0,
                )
                rec["corpus_rows"] = CORPUS_ROWS
                self.evidence("resume", side_name, f"launch-{i}.json", rec)
                P.stop_perf_daemon(socket)
                if rec["ready_s"] is None:
                    print(
                        f"WARNING: {side_name} resume {i} never reached ready",
                        file=sys.stderr,
                    )
                    continue
                buckets[side_name].append(rec["ready_s"])
        for side_name in ("ts", "rust"):
            self.evidence(
                "resume", side_name, "summary.json", {"ready_s": buckets[side_name]}
            )
            out[side_name] = {
                "ready_s_median": self.median(buckets[side_name]),
                "corpus_rows": CORPUS_ROWS,
                "launches": len(buckets[side_name]),
            }
        return out

    # -- dimension: kernel spawn -------------------------------------------------

    def dim_kernel_spawn(self) -> dict:
        """Two kernel measures, both product-level and identical on the two
        binaries:

        - cold `create -> first kernel cell ready`: daemon session create
          plus one prompt whose mock reply is an ipython tool call; the
          wire `prompt_and_wait` round trip completes only after the kernel
          booted and the first cell returned. This is the session-create
          path a user's first ipython cell pays.
        - warm `prompt -> first cell rendered`: keystroke-to-render on an
          attached interactive pane with an already-running kernel.
        """
        out: dict[str, dict] = {}
        for side_name in ("ts", "rust"):
            side = self.sides[side_name]
            self.ensure_fresh_daemon(side)
            # Cold: session create -> first kernel cell, over the wire.
            cold_trials = []
            for trial in range(max(3, self.trials)):
                side.mock.set_responses(
                    [
                        {
                            "toolCall": {
                                "name": "ipython",
                                "arguments": {"code": KERNEL_CODE},
                            }
                        },
                        {"text": f"kernel bench reply {trial}"},
                    ]
                )
                wire = B.Wire(side.daemon_socket)
                t0 = time.time()
                create = wire.request(
                    f"kc{trial}",
                    {
                        "type": "create",
                        "name": f"wave-kernel-{trial}",
                        "config": self.session_config(side),
                    },
                    timeout=120,
                )
                if create.get("success") is not True:
                    print(f"WARNING: {side_name} kernel create failed: {create}", file=sys.stderr)
                    wire.close()
                    break
                session_id = create["data"].get("activeSessionId") or create["data"].get("id")
                create_s = time.time() - t0
                prompt = wire.request(
                    f"kp{trial}",
                    {
                        "type": "prompt_and_wait",
                        "activeSessionId": session_id,
                        "message": f"kernel bench turn {trial}",
                    },
                    timeout=300,
                )
                total_s = round(time.time() - t0, 3)
                wire.close()
                self.evidence(
                    "kernel_spawn",
                    side_name,
                    f"cold-{trial}.json",
                    {
                        "create_s": round(create_s, 3),
                        "prompt_to_cell_s": round(total_s - create_s, 3),
                        "create_to_first_cell_s": total_s,
                        "prompt_success": prompt.get("success"),
                    },
                )
                if prompt.get("success") is not True:
                    print(f"WARNING: {side_name} kernel prompt failed: {prompt}", file=sys.stderr)
                    continue
                cold_trials.append({"create_s": round(create_s, 3), "first_cell_s": total_s})
            # Warm: interactive pane with a booted kernel.
            session = f"{self.runid}-kernel-{side_name}"
            B.tmux_launch(
                session, P.launch_argv(side, side.daemon_socket), side.env, side.work_dir
            )
            deadline = time.time() + 90
            while time.time() < deadline:
                if P.is_ready(side_name, B.tmux_capture(session)):
                    break
                time.sleep(0.1)
            latencies = []
            for trial in range(max(3, self.trials)):
                side.mock.set_responses(
                    [
                        {
                            "toolCall": {
                                "name": "ipython",
                                "arguments": {"code": KERNEL_CODE},
                            }
                        },
                        {"text": f"kernel bench reply {trial}"},
                    ]
                )
                t0 = time.time()
                B.tmux_send(session, f"kernel bench turn {trial}", enter=True)
                rendered = False
                deadline = t0 + 180
                while time.time() < deadline:
                    frame = B.tmux_capture(session)
                    if KERNEL_MARKER in frame:
                        rendered = True
                        break
                    time.sleep(0.05)
                if not rendered:
                    print(
                        f"WARNING: {side_name} kernel bench warm trial {trial} timed out",
                        file=sys.stderr,
                    )
                    break
                latencies.append(round(time.time() - t0, 3))
                # settle so the next sample is not polluted by residual
                # rendering
                time.sleep(2.0)
            self.evidence("kernel_spawn", side_name, "warm-trials.json", latencies)
            warm = self.median(latencies[1:]) if len(latencies) > 1 else None
            out[side_name] = {
                "create_to_first_cell_s_cold_median": self.median(
                    [t["first_cell_s"] for t in cold_trials]
                )
                if cold_trials
                else None,
                "create_to_first_cell_s_trials": cold_trials,
                "prompt_to_first_cell_s_warm_median": warm,
                "warm_trials": latencies,
            }
            B.tmux_kill(session)
            side.stop_daemon()
        return out

    # -- dimension: streaming throughput -----------------------------------------

    # -- dimension: sustained CPU (render-loop regression guard) ------------------
    #
    # The cpu-spin dogfood fix (frame-batch scheduler, per-block markdown
    # cache, timer-driven spinner) is guarded by absolute budgets, not a
    # TS ratio: a render loop that burns 90%+ of a core while idle or
    # while a stream renders is a bug at any TS-relative speed.
    # sustained_cpu.py drives the interactive TUI through the faux
    # provider (idle window, paced plain-text stream, paced code stream,
    # long tool-execution turn), samples %CPU per process from /proc, and
    # asserts: idle < 5%, streaming < 30%, typing mid-stream < 50ms, and
    # the double-Ctrl+C exit mid-scroll (bug #6's trapped-scroll repro).

    def dim_sustained_cpu(self) -> dict:
        script = Path(__file__).parent / "sustained_cpu.py"
        out_dir = self.run_dir / "sustained_cpu"
        out_dir.mkdir(parents=True, exist_ok=True)
        # NOTE: no PI_PACKAGE_DIR here either — sustained_cpu.py scopes the
        # runtime sidecar to the rust pane itself (same reason as the
        # streaming dim).
        env = dict(os.environ)
        env.pop("PI_PACKAGE_DIR", None)
        env["PA_RUST_BINARY"] = str(Path(self.rust_bin).resolve())
        proc = subprocess.run(
            ["python3", str(script), "--out", str(out_dir)],
            env=env,
            cwd=str(Path(__file__).resolve().parents[2]),
            capture_output=True,
            text=True,
            timeout=2400,
        )
        self.evidence("sustained_cpu", "shared", "sustained_cpu.log", proc.stdout + proc.stderr)
        result: dict[str, dict] = {}
        for side_name in ("ts", "rust"):
            path = out_dir / f"{side_name}-sustained-cpu.json"
            if not path.exists():
                print(f"WARNING: missing {path}", file=sys.stderr)
                continue
            data = json.loads(path.read_text())

            def tui_mean(dim):
                return ((data.get(dim) or {}).get("tui") or {}).get("mean_pct")

            result[side_name] = {
                "tui_idle_mean_pct": tui_mean("idle"),
                "tui_plain_mean_pct": tui_mean("plain"),
                "tui_code_mean_pct": tui_mean("code"),
                "tui_tool_mean_pct": tui_mean("tool"),
                "typing_ms_median": (data.get("typing_probe") or {}).get("median_ms"),
                "exit_s": (data.get("exit_probe") or {}).get("elapsed_s"),
                "passed": data.get("passed"),
            }
        result["_exit_code"] = proc.returncode
        return result

    def dim_streaming(self) -> dict:
        # stream_throughput.py runs both binaries itself (faux engine on
        # rust, the ts faux extension on ts) and settles two unpaced
        # ~12k-token turns per side.
        script = Path(__file__).parent / "stream_throughput.py"
        out_dir = self.run_dir / "streaming"
        out_dir.mkdir(parents=True, exist_ok=True)
        # NOTE: no PI_PACKAGE_DIR here — the TS binary resolves its own
        # package layout from that env and a non-release tree crashes it;
        # stream_throughput.py scopes PI_PACKAGE_DIR to the rust pane and
        # finds the runtime sidecar itself.
        env = dict(os.environ)
        env["PA_RUST_BINARY"] = str(Path(self.rust_bin).resolve())
        proc = subprocess.run(
            ["python3", str(script), "--out", str(out_dir)],
            env=env,
            cwd=str(Path(__file__).resolve().parents[2]),
            capture_output=True,
            text=True,
            timeout=1200,
        )
        self.evidence("streaming", "shared", "stream_throughput.log", proc.stdout + proc.stderr)
        result: dict[str, dict] = {}
        # ~12k tokens per turn (chars/4 estimate, the streaming harness's
        # own metric): SEGMENTS * SEGMENT_WORDS words plus segment markers.
        sys.path.insert(0, str(Path(__file__).parent))
        import stream_throughput  # noqa: E402

        tokens_per_turn = len(stream_throughput.filler_text()) // 4
        for side_name in ("ts", "rust"):
            path = out_dir / f"{side_name}-throughput.json"
            if not path.exists():
                print(f"WARNING: missing {path}", file=sys.stderr)
                continue
            data = json.loads(path.read_text())
            settles = [turn["settle_seconds"] for turn in data.get("turns", [])]
            self.evidence("streaming", side_name, "throughput.json", data)
            result[side_name] = {
                "settle_s_median": self.median(settles),
                "tokens_per_s_est": round(tokens_per_turn / self.median(settles), 0)
                if settles
                else None,
                "turns": settles,
            }
        result["_exit_code"] = proc.returncode
        return result

    # -- dimension: compaction on a large session ---------------------------------
    #
    # PARITY NOTE (found by this wave, 2026-09-21; fixed by the
    # import-compaction lane, see crates/pa-daemon/tests/
    # import_compaction_e2e.rs): growing the session by `import_jsonl`
    # used to make the TS daemon compact it while the Rust daemon answered
    # "Session is too short to compact". Root cause: the Rust session-file
    # parse degraded whole message rows to Unknown on fields the TS loader
    # tolerates (the raw provider stopReason "tool_calls", a missing
    # toolName), so the compaction walk under-counted and found no cut with
    # history. The wire parse now keeps those rows (pa-types), and the e2e
    # locks the whole flow. The benchmark still grows both sides
    # identically through `prompt_and_wait` turns (the f7 battery pattern),
    # so the measured pipeline is comparable.

    COMPACT_GROW_TURNS = 40
    # ~3k tokens of deterministic text per turn -> ~120k tokens of history,
    # well past the 20k keep-recent budget so the cut has history to
    # summarize on both sides.
    COMPACT_TURN_TEXT = "Compaction bench turn payload. " * 1050

    def dim_compaction(self) -> dict:
        out: dict[str, dict] = {}
        for side_name in ("ts", "rust"):
            side = self.sides[side_name]
            self.ensure_fresh_daemon(side)
            durations = []
            for trial in range(max(3, self.trials)):
                wire = B.Wire(side.daemon_socket)
                create = wire.request(
                    f"cc{trial}",
                    {
                        "type": "create",
                        "name": f"wave-compact-{trial}",
                        "config": self.session_config(side),
                    },
                    timeout=120,
                )
                if create.get("success") is not True:
                    print(f"WARNING: {side_name} create failed: {create}", file=sys.stderr)
                    wire.close()
                    break
                session_id = create["data"].get("activeSessionId") or create["data"].get("id")
                # Grow: every turn replies with the same deterministic big
                # text (the mock round-robins the last scripted response
                # once the queue runs dry).
                side.mock.set_responses([{"text": self.COMPACT_TURN_TEXT}])
                for turn in range(self.COMPACT_GROW_TURNS):
                    grown = wire.request(
                        f"gp{trial}-{turn}",
                        {
                            "type": "prompt_and_wait",
                            "activeSessionId": session_id,
                            "message": f"compaction bench seed turn {turn}",
                        },
                        timeout=300,
                    )
                    if grown.get("success") is not True:
                        print(
                            f"WARNING: {side_name} grow turn {turn} failed: {grown}",
                            file=sys.stderr,
                        )
                        break
                # Compact: the mock serves the summarizer reply.
                side.mock.set_responses([{"text": f"compaction summary {trial}"}])
                t0 = time.time()
                compact = wire.request(
                    f"kc{trial}",
                    {"type": "compact", "activeSessionId": session_id},
                    timeout=600,
                )
                duration = round(time.time() - t0, 3)
                self.evidence("compaction", side_name, f"compact-{trial}.json", compact)
                wire.send_command(
                    f"sp{trial}",
                    {"type": "kill", "activeSessionId": session_id},
                )
                wire.close()
                if compact.get("success") is not True:
                    print(f"WARNING: {side_name} compact failed: {compact}", file=sys.stderr)
                    continue
                durations.append(duration)
                self.evidence(
                    "compaction",
                    side_name,
                    f"grown-{trial}.json",
                    {"turns": self.COMPACT_GROW_TURNS},
                )
            side.stop_daemon()
            out[side_name] = {
                "compact_s_median": self.median(durations),
                "grown_turns": self.COMPACT_GROW_TURNS,
                "trials": durations,
            }
        return out

    # -- dimension: HTML export ----------------------------------------------------

    def dim_export(self) -> dict:
        corpus = self.corpus_path()
        out: dict[str, dict] = {}
        for side_name in ("ts", "rust"):
            side = self.sides[side_name]
            durations = []
            sizes = []
            for trial in range(max(3, self.trials)):
                output = side.root / "export" / f"export-{trial}.html"
                output.parent.mkdir(parents=True, exist_ok=True)
                t0 = time.time()
                result = B.run_cmd(
                    [side.binary, "session", "export", str(corpus), str(output)],
                    env=side.env,
                    cwd=side.work_dir,
                    timeout=300,
                )
                duration = round(time.time() - t0, 3)
                if result["exit_code"] != 0 or not output.exists():
                    print(
                        f"WARNING: {side_name} export failed: {result['exit_code']} "
                        f"{result['stderr'][-300:]}",
                        file=sys.stderr,
                    )
                    self.evidence("export", side_name, f"run-{trial}.json", result)
                    continue
                durations.append(duration)
                sizes.append(output.stat().st_size)
                output.unlink()
            out[side_name] = {
                "export_s_median": self.median(durations),
                "html_bytes_median": int(self.median([float(s) for s in sizes]))
                if sizes
                else None,
                "trials": durations,
            }
        return out

    # -- dimension: daemon per-session overhead -------------------------------------

    def dim_daemon_overhead(self) -> dict:
        out: dict[str, dict] = {}
        for side_name in ("ts", "rust"):
            side = self.sides[side_name]
            deltas = []
            per_session = []
            for trial in range(2):
                if side.daemon_socket.exists():
                    side.daemon_socket.unlink()
                side.start_daemon()
                time.sleep(3.0)
                baseline = self.rss_sample(side, quiet_s=1.0)
                wire = B.Wire(side.daemon_socket)
                created = 0
                for i in range(10):
                    create = wire.request(
                        f"dc{trial}-{i}",
                        {
                            "type": "create",
                            "name": f"wave-overhead-{trial}-{i}",
                            "config": self.session_config(side),
                        },
                        timeout=120,
                    )
                    if create.get("success") is not True:
                        print(
                            f"WARNING: {side_name} overhead create {i} failed: {create}",
                            file=sys.stderr,
                        )
                        break
                    created += 1
                wire.close()
                time.sleep(3.0)
                loaded = self.rss_sample(side, quiet_s=1.0)
                self.evidence(
                    "daemon_overhead",
                    side_name,
                    f"trial-{trial}.json",
                    {"created": created, "baseline_kb": baseline["total_kb"], "loaded": loaded},
                )
                if created == 10:
                    delta = loaded["total_kb"] - baseline["total_kb"]
                    deltas.append(delta)
                    per_session.append(delta / 10.0)
                side.stop_daemon()
            out[side_name] = {
                "delta_kb_median": int(self.median([float(d) for d in deltas]))
                if deltas
                else None,
                "per_session_kb_median": int(self.median([float(d) for d in per_session]))
                if per_session
                else None,
                "trials": deltas,
            }
        return out

    # -- config -------------------------------------------------------------------

    def ensure_fresh_daemon(self, side: B.Side) -> None:
        """Start a daemon on the side socket, first reaping anything that
        still holds it (a failed dimension can leave a live daemon; the TS
        daemon start aborts with ELOCKED while the old one lives)."""
        B.reap_daemons(
            socket_paths=[side.daemon_socket],
            needles=[str(side.daemon_socket), str(self.tmpdirs[side.name])],
        )
        if side.daemon_socket.exists():
            side.daemon_socket.unlink()
        side.start_daemon()

    def session_config(self, side: B.Side) -> dict:
        return {
            "cwd": str(side.work_dir),
            "sessionDir": str(side.agent_dir / "sessions"),
            "provider": "prime-inference",
            "model": "mock-1",
            "executionMode": "print",
        }

    # -- driver ---------------------------------------------------------------------

    def run(self) -> int:
        results: dict[str, dict] = {}
        for name in ("ts", "rust"):
            self.make_side(name, self.ts_bin if name == "ts" else self.rust_bin)
        # Settle first-run dialogs once per side before any measurement.
        for side_name in ("ts", "rust"):
            self.onboard(self.sides[side_name])
        for dim in self.dims:
            print(f"== dimension: {dim}", flush=True)
            started = time.time()
            try:
                results[dim] = getattr(self, f"dim_{dim}")()
            except Exception as exc:  # keep later dimensions running
                import traceback

                traceback.print_exc()
                results[dim] = {"error": str(exc)}
                # A half-torn dimension can leave its daemon tree alive;
                # reap both sides so the next dimension starts clean.
                for side in self.sides.values():
                    side.stop_daemon()
            print(
                f"== {dim} done in {time.time() - started:.1f}s: "
                + json.dumps(results[dim], default=str)[:400],
                flush=True,
            )
            (self.run_dir / "results.partial.json").write_text(
                json.dumps(results, indent=1, default=str)
            )
        self.teardown_sides()
        payload = {
            "run": self.stamp,
            "ts_bin": self.ts_bin,
            "rust_bin": self.rust_bin,
            "trials": self.trials,
            "corpus_rows": CORPUS_ROWS,
            "results": results,
        }
        (self.run_dir / "results.json").write_text(json.dumps(payload, indent=1, default=str))
        print(json.dumps(payload, indent=1, default=str))
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    here = Path(__file__).resolve().parent
    repo = here.parent.parent
    parser.add_argument("--dims", default=",".join(ALL_DIMS))
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--runs-root", default=str(here / "runs"))
    parser.add_argument("--run-name", default=None)
    parser.add_argument("--ts-bin", default="prime-agent")
    parser.add_argument("--rust-bin", default=str(repo / "target" / "release" / "prime-agent"))
    args = parser.parse_args()
    dims = [d.strip() for d in args.dims.split(",") if d.strip()]
    for dim in dims:
        if dim not in ALL_DIMS:
            parser.error(f"unknown dim {dim}; valid: {ALL_DIMS}")
    # Fail fast: the ts side must be the deployed TS product.
    ts_identity.assert_ts_side_is_the_ts_product(args.ts_bin, args.rust_bin)
    stale = B.rust_binary_staleness(Path(args.rust_bin), repo)
    if stale:
        print(f"STALE RUST BINARY: {stale}", file=sys.stderr)
        return 2
    stamp = args.run_name or (
        "perf-wave-"
        + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    )
    run_dir = Path(args.runs_root) / stamp
    run_dir.mkdir(parents=True, exist_ok=True)
    wave = PerfWave(run_dir, args.ts_bin, args.rust_bin, dims, args.trials)
    return wave.run()


if __name__ == "__main__":
    raise SystemExit(main())
