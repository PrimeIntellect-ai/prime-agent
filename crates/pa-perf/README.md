# pa-perf

The prime-agent performance tooling: a deterministic corpus generator over
the product's real on-disk layout, and a pty bench harness that drives the
REAL release binary (`target/release/prime-agent`) headlessly. A dev/CI
crate at the top of the workspace dependency graph — nothing depends on it,
and it never ships (the release lanes build `-p pa-cli --bin prime-agent`
only).

## Scope and non-goals

- Scope: faking realistic agent-dir state at scale (sessions, subagent
  trees, artifacts, the spawn ledger, the cwd project tree), and measuring
  the interactive surfaces (start, agents view, open/switch session,
  @ completion) through the real binary.
- Non-goals: benchmarks of provider/LLM paths (the harness stays offline),
  and any product-code changes. The new `vt100` screen-model dependency
  is described below; clap and nix were already in the tree.

## The corpus generator

```
pa-perf corpus --profile medium --out DIR [--seed N] [knob overrides]
```

`DIR` must be absent or empty. A populated output is rejected before any writes,
so stale sessions cannot enter the new corpus or its restore baseline. Choose a
fresh directory for another standalone generation. The suite command can be run
again in the same output: it replaces only its own corpus directories after
verifying their manifests, and refuses unrelated populated directories.

Writes the product's real layout under `DIR/`:

```
DIR/
  corpus.json                      # manifest: counts, needle markers, the file-set baseline
  project/                         # the sessions' cwd + @-completion tree
  agent/                           # point PRIME_AGENT_CODING_AGENT_DIR here
    settings.json                  # onboarding pre-answered, traces off
    sessions/<uuid>.jsonl          # current-format session files (flat)
    sessions-archive/<uuid>.jsonl
    rlm-ledger/<hash16>.jsonl      # written through pa-daemon's RlmSpawnLedger
    session-artifacts/...          # kernel-state stubs, harness/, sub-<id>/ trees
```

Row payloads are serialized from the product's own types (pa-types message
shapes inside pa-daemon's `SessionEntry` envelope and `session_header_line`
header) — no hand-copied JSON. Entry ids are counter-based unique 8-hex: the
product's own ids are uuid4 prefixes with a 100-try collision check, which
collide around ~22K rows and silently break branch reconstruction.

### Knobs

`--profile small|medium|large|xl` picks the defaults; every knob overrides:

| flag | meaning | small | medium | large | xl |
|---|---|---|---|---|---|
| `--sessions` | top-level sessions | 10 | 100 | 1,000 | 2,500 |
| `--rows` | rows per session | 100 | 2,000 | 10,000 | 400 |
| `--huge-rows` | rows of the huge marker session | 2,000 | 4,000 | 20,000 | 2,000 |
| `--child-rows` | rows per subagent child | 40 | 100 | 150 | 80 |
| `--fanout` | children per parent per level | 2 | 3 | 3 | 2 |
| `--depth` | subagent tree depth | 2 | 2 | 3 | 2 |
| `--tree-parents` | sessions growing a tree | 2 | 5 | 8 | 10 |
| `--wide-children` | one parent's direct children (the operator's ~110-wide real parent) | 0 | 0 | 110 | 0 |
| `--archive` | sessions in sessions-archive/ | 3 | 20 | 200 | 500 |
| `--cwd-files` | files in the project tree | 200 | 2,000 | 4,000 | 2,000 |
| `--artifacts` | per-session artifact partitions (on/off) | on | on | on | on |
| `--cache` | cold/warm (see below) | cold | cold | cold | cold |
| `--seed` | the deterministic seed | 7 | 7 | 7 | 7 |

Total rows: small ~3.5K, medium ~250K, large ~10.1M, xl ~1.2M (medium is
~210 MB on disk; large ~3.5 GB; xl ~1 GB, generated in ~5 s).

### Determinism

Same seed + same canonical path => a byte-identical tree, file mtimes
included (roster order is mtime-desc). Two stamps are the product writer's
own wall clock and are excluded from that contract: the ledger records'
`at` fields, and the corpus-root path embedded in child headers/ledger
records (`parentSession`/`child` are canonical paths).

### Caches (cold vs warm)

- `--cache warm` runs the product's own `pa_core::session::window::WindowedSessionStore::open`
  over every openable session file, writing real `<id>.window-cache.json`
  sidecars. On a real store warm window-cache sidecars are the common state
  (the operator's live store: 71 of 111 sessions carry one).
- The `<id>.info-cache.json` sidecar is written only at worker lease
  release (pa-daemon, no public writer), so generated corpora carry none —
  matching real stores (9 of 111). The `agents-view-warm` scenario measures
  the warm scan via the daemon's in-process cache instead.
- `pa-perf run` generates BOTH corpora (cold for the cold scenarios, warm
  for warm-start/warm-ready) — every scenario runs on the state it needs.

## The bench harness

```
# the whole suite (CI + make perf): generates the corpora, routes every
# scenario to the corpus state it needs, writes one results/<scenario>.json
pa-perf run --binary target/release/prime-agent --profile medium --out DIR [--runs N]

# one scenario over one corpus (investigation)
pa-perf bench --binary target/release/prime-agent --corpus DIR --scenario S --runs 10 --json OUT
```

Scenarios (timed from a triggering action to an observable needle — literal
paints as byte needles, cell-diffed content through a vt100 screen model;
the liveness deadline only fails broken runs):

| scenario | corpus | trigger -> needle |
|---|---|---|
| `cold-start` | cold | exec -> the chat first paint (the splash paints before any daemon work — the product's own paint contract) |
| `cold-ready` | cold | the same launch, exec -> the tray's session-usage pill, the first attach-only content (daemon spawn + session create + attach included) |
| `warm-start` | warm | exec -> first paint, daemon pre-started |
| `warm-ready` | warm | the same launch, exec -> the attach pill |
| `agents-view` | cold | left-arrow -> the completed `Inactive (N)` roster heading in the screen model |
| `agents-view-warm` | cold | the same daemon's second populate (its in-process scan cache warm) |
| `open-session` | cold | `--resume <huge session>` -> the huge session's tail marker |
| `session-switch` | cold | enter on the uniquely-filtered switch-b row -> B's transcript marker |
| `at-completion` | cold | the `@` keystroke -> the first completion menu row |

Mechanics (the repo's pty-e2e discipline): the TUI child runs in its own
session with NO controlling tty (`setsid` pre-exec; vendored crossterm
falls back to the stdio pty), 120x36, kitty probe answered identically every
run, `PRIME_AGENT_CODING_AGENT_DIR` + `--daemon-socket` isolate it, and the
env is rebuilt from scratch (no ambient credentials leak in). Between runs
the harness restores the corpus to the manifest's file set (the product's
new session files, sidecars, logs, and leases are deleted) so every run
measures identical state. A discarded warm-up run precedes the samples.

Teardown signals only the harness's own child pids; the daemon stops by the
shutdown protocol and the run FAILS if it keeps accepting — never a
pid/name-based kill.

## report + baseline

```
pa-perf report --baseline crates/pa-perf/baseline.json --results results/*.json [--markdown OUT]
```

Prints the aggregate table (scenario/profile, median, p95, baseline, delta)
and exits nonzero ONLY when a non-report-only median exceeds twice the
baseline. Noisy scenarios (>20% spread across 3 CI runs) are marked
`report_only` in the baseline: their deltas always print, the gate never
fails. `baseline.json` is committed from CI numbers, not laptop/sandbox
ones.

## Local run

`make perf` builds the release binaries and runs the whole suite
(`pa-perf run --profile small`) with the report table printed at the end.
Run it on a quiet machine; the numbers are wall-clock latencies.

## Dependencies

pa-perf adds ONE new third-party dependency: `vt100` (MIT), the screen
model behind the content needles (the agents view's heading counts repaint
as terminal cell diffs, which the raw byte stream cannot see). The crate
never ships — the release lanes build `-p pa-cli --bin prime-agent` only —
and `make deny` stays clean.

## CI

The bench matrix runs all four profiles at 10 runs each; the xl
(2500-session) agents-view populate measures ~2.7 s on an 8-core sandbox.

`.github/workflows/perf.yml`: nightly schedule + workflow_dispatch +
label-gated pull requests (`perf-test` label, [labeled, synchronize] —
labeling is the explicit opt-in). One release build, a bench matrix over
the four profiles, and a report job writing the `$GITHUB_STEP_SUMMARY`
table with the >2x gate.
