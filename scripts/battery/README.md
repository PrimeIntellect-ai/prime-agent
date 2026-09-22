# Parity battery

NOTE: battery greenness ("0 gaps") covers only the scripted flows run
here over the deterministic mock provider - it is not a product-parity
statement. Flows f14-f21 are the real-surface flows (compact, a2a, refine,
/model, goal/autonomous, heartbeat, subagents, worker recovery): they drive
the daemon session plus the attached interactive TUI, frame-diff TS vs Rust
at the key moment, and record surface gaps as EXPECTED-FAIL with the owning
fix lane. See `docs/completion-matrix.md` for the evidence-based
completion picture, and `docs/parity-battery.md` for the flow list.

One-command re-run (from the repo root):

    python3 scripts/battery/run_battery.py

Each run writes `scripts/battery/runs/<UTC stamp>/` with per-side evidence
(`ts/`, `rust/`), a `report.md` comparison table, and machine-readable
`findings.json`. Requires the TS binary `prime-agent` on PATH (ground truth)
and a built Rust binary (default `target/release/prime-agent`).

Files: `run_battery.py` (driver), `batterylib.py` (shared harness; also
owns the daemon-reap sweep every standalone parity harness reuses:
`reap_daemons(needles=[...])` sweeps any `--mode daemon` process whose
argv references the given paths — the graceful `sd` shutdown first, then
the SIGTERM/SIGKILL rounds until a respawned main is gone. Every
standalone harness (visual, osc, queue, compact, tool-card,
custom-message, print-json, compaction-abort, provider-error) reaps in
its cleanup path — a sandbox tempdir must never outlive its daemons
(#223: one was observed spinning at 74% CPU on a deleted socket); the
harness sandboxes pin an isolated per-side TMPDIR so the TS supervisor's
socket lands under the sandbox root the sweep can name),
`ts_identity.py` (shared ts-identity guard: every PATH-driven parity
harness refuses to run when its "ts" binary is this repo's Rust product —
e.g. a stale Rust build symlinked onto PATH as `prime-agent`), 
`provider_error_probe.py` (provider-error shape probe: scripted
non-2xx answers, raw-socket h2 and WebSocket mocks, dead-port connection
probes — one custom provider per scenario; captures the persisted
errorMessage plus the `provider_stream_failure` / `provider_transport_failure`
diagnostics per side, TS vs Rust),
`mock_provider.py` (deterministic mock provider; responses are
session-scoped queues — a queue is selected per request by markers in the
request's user-message text, so a parent session and a concurrently running
spawned child each get their own scripted responses deterministically),
`perf.py` (f10 perf rows),
`sustained_cpu.py` (sustained-CPU regression guard, lane cpu-spin: the
interactive TUI driven through the faux provider — a 30s idle window, a
paced plain-text stream, a paced markdown/code stream, and a long
tool-execution turn — with %CPU sampled per process from /proc and
ASSERTED: idle <5% and streaming <30% of one core, keystroke-to-render
mid-stream <50ms, the paused viewport stable mid-stream, and a double
Ctrl+C mid-scroll terminating the process (bug #6's no-escape invariant).
`perf_wave.py` exposes it as the `sustained_cpu` dimension and
`perf_gate.py` tracks its medians against the baseline),
`framediff_first_run.py` (first-run frame diff),
`streaming_render.py` (live token-stream rendering verifier: pane captures
must grow progressively mid-turn over a paced faux provider, TS vs Rust
differential on the settled frame),
`scale_corpus.py` (f12 heavy-scale corpus generator).

Heavy flow (opt-in, not part of the default battery run):

    PA_BATTERY_HEAVY=1 python3 scripts/battery/run_battery.py --flows f12_scale_resume

`f12_scale_resume` generates a deterministic PA_BATTERY_HEAVY_TURNS-turn
session (default 5,000 turns = 15,261 transcript rows of user / assistant /
ipython-tool turns plus harness-digest rows) and measures interactive
`--resume` -> ready for both binaries through tmux. Gates: the Rust side
must reach ready within SCALE_RESUME_MAX_READY_S (30s) and within
SCALE_RESUME_MAX_RATIO (2.0x) of the TS side in the same run - a
regression gate for the snapshot replay/render path (per-row re-layout or
uncached preview work must not come back).
