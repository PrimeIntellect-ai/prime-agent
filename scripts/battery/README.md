# Perf-wave battery

The perf wave measures the interactive TUI against the deployed TS
binary (the "ts" side) and a release build of this repo (the "rust"
side), gates the rust medians against the recorded baseline, and is
driven by the Makefile `perf-wave` target:

    make perf-wave

`perf-wave` runs `ci_perf_wave.sh`, the CI-shaped entry: it creates an
ephemeral Prime sandbox (4 CPU / 16 GB, the spec class the baseline was
recorded on), installs the deployed TS binary plus a fresh release build
of the checkout, runs the wave there, downloads the results, and gates
them (`perf_gate.py` against `perf-baseline.json`). Every timing comes
from the same quiet machine for both sides, which is the whole point of
the sandbox. `PA_BENCH_NO_SANDBOX=1` runs the wave directly on the host
instead (`run_perf_wave.sh` + `perf_wave.py`).

Files:

- `ci_perf_wave.sh` — the Makefile entry (sandbox lifecycle, results
  download, the gate call)
- `run_perf_wave.sh` — the local runner (same shape as the CI entry,
  without the sandbox dance)
- `perf_wave.py` — the driver (dimensions below; accepts --ts-bin /
  --rust-bin)
- `sustained_cpu.py` — the sustained-CPU dimension: the interactive TUI
  driven through the faux provider — a 30s idle window, a paced plain-text
  stream, a paced markdown/code stream, and a long tool-execution turn —
  with %CPU sampled per process from /proc and ASSERTED: idle <5% and
  streaming <30% of one core, keystroke-to-render mid-stream <50ms, the
  paused viewport stable mid-stream, and a double Ctrl+C mid-scroll
  terminating the process (bug #6's no-escape invariant)
- `stream_throughput.py` — the stream-throughput dimension (token
  throughput of the live render loop, both binaries)
- `perf.py` — the perf measurement helpers the dimensions share:
  startup launch-to-ready, keystroke-to-render typing latency, and
  cold-resume-to-ready over the same tmux pane channel a real user
  types through (both product sides)
- `scale_corpus.py` — the deterministic heavy-scale corpus the resume
  dimension replays (the 350-turn / 1078-row corpus perf_wave.py
  generates via scale_corpus for its resume dim)
- `perf_gate.py` — the gate (medians vs `perf-baseline.json`, default
  threshold 1.10)
- `perf-baseline.json` — the recorded baseline the gate compares against
- `batterylib.py` — the shared harness (side sessions, the deterministic
  mock provider, the daemon-reap sweep every harness reuses:
  `reap_daemons(needles=[...])` sweeps any `--mode daemon` process whose
  argv references the given paths — the graceful `sd` shutdown first, then
  the SIGTERM/SIGKILL rounds until a respawned main is gone; the harness
  sandboxes pin an isolated per-side TMPDIR so a supervisor's socket lands
  under the sandbox root the sweep can name)
- `mock_provider.py` — the deterministic mock provider batterylib drives
  (responses are session-scoped queues — a queue is selected per request
  by markers in the request's user-message text, so a parent session and
  a concurrently running spawned child each get their own scripted
  responses deterministically)
- `ts_identity.py` — the shared ts-identity guard: every PATH-driven
  harness refuses to run when its "ts" binary is this repo's Rust product
- `../ts_faux_extension.js` — the faux-provider driver extension the TS
  side loads (scripted responses read from PRIME_AGENT_FAUX_SCRIPT);
  verification harness only, never installed for real users
