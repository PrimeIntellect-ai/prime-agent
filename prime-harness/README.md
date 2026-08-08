# Prime Harness

A reliability-first workflow orchestration harness for [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent),
built for long-running scientific (physics/mathematics) codebases.

**Design premise:** Prime Agent's RLM architecture shifts control-plane
complexity onto the model — it must write correct Python to delegate,
verify, and manage state, and any slip creates drift, incomplete changes, or
subtle bugs. This harness does *not* wrap Prime Agent in another agent
framework (Prime stays the authoritative runtime). Instead it installs four
narrow, deterministic layers the architecture is missing:

1. **Deterministic scientific oracles** (`sci-verify` + the composite gate)
2. **Persistent provenance** (`evidence-ledger`)
3. **Delegation & budget discipline** (`harness-orchestrator` + operating policy)
4. **Independent cross-harness criticism** (`external-critic` — your
   "Prime produces → Codex/Claude audits" loop, automated)

Everything is built against **verified Prime Agent v0.7.0 interfaces** (see
[Compatibility](#compatibility)) — real skill formats, real autonomous-gate
mechanics, real kernel APIs — not the idealized versions in blog posts.

---

## Install

```bash
# from this directory, into your project repository (forward slashes work in
# Git Bash, PowerShell, and cmd alike):
python install.py C:/path/to/your/physics-repo --check
```

`--check` runs the preflight doctor. The installer is idempotent and never
overwrites your local edits without `--force`.

Then start a **new** Prime Agent session from the repo root (Python-backed
skills install into the kernel venv at session setup — an existing session
won't see them).

### Windows notes (important)

- Prime Agent needs bash: install **Git for Windows** (the doctor checks the
  exact paths Prime Agent probes).
- The managed kernel-venv bootstrap is POSIX-shaped; on native Windows set
  `PRIME_AGENT_KERNEL_PYTHON` to a Python 3.11+ that has `ipykernel`
  installed, or run under WSL. The doctor tells you which state you're in.
- The Prime Agent binary may be `prime-agent` or `pi` depending on install
  channel; all harness tooling detects both.

## What gets installed

```
your-repo/
├── .prime/agent/
│   ├── APPEND_SYSTEM.md         # operating policy, appended to the system prompt
│   ├── settings.json            # autoRefine OFF (refinement is governed, not automatic)
│   ├── prompts/                 # /harness-task, /harness-audit, /harness-refine
│   └── skills/                  # 4 Python-backed skills (auto-installed into the kernel)
│       ├── harness-orchestrator/
│       ├── sci-verify/
│       ├── evidence-ledger/
│       └── external-critic/
├── harness/
│   ├── verify.py                # composite gate (stdlib-only; autonomous-gate safe)
│   ├── scorecard.py             # privacy-safe durable telemetry (stdlib-only)
│   ├── replay.py                # deterministic eval-snapshot scorer (stdlib-only)
│   ├── manifest.json            # gate profiles: quick / default / changed-files / holdout
│   ├── roster.yaml              # retained-specialist roster
│   ├── config.json              # caps, budget floor, critic config
│   ├── doctor.py                # preflight checks
│   └── burst.sh / burst.ps1     # bounded autonomous burst launchers
├── checks/                      # NOT named "verification/" — Prime Agent's
│   │                            # autonomous gate excludes that exact dir name
│   │                            # from changed-workspace detection
│   ├── evalset/                 # versioned 16-task corpus + baseline snapshot
│   ├── properties/              # Hypothesis property tests (example included)
│   ├── invariants/              # conservation/symmetry suites
│   ├── reference_cases/         # independent-oracle comparisons
│   └── hidden_holdout/          # human/CI-only; reward-hacking defense
└── artifacts/harness/           # runtime state (gitignored): evidence.db, task
                                 # state, child results, gate logs, snapshots
```

## The operating loop

```
/harness-task integrator-042 Implement and verify a 4th-order symplectic integrator
        │
        ▼
new_task() → working branch → evidence_ledger.search() → goal.create(budget)
        │
        ▼
small increments ── sci_verify (symbolic / numeric ladder / convergence /
        │           invariants / properties) after every claim
        ▼
spawn() specialists (admission-gated, contract-enforced) ──► collect()
        │
        ▼
composite gate passes ──► external_critic.review() ──► falsify-or-rebut
        │                                              every critical finding
        ▼
goal.complete()   (the ONLY success signal Prime Agent recognizes)
```

Bounded autonomous bursts (never a single unbounded 24/7 turn):

```bash
harness/burst.sh feature "Implement X per the persistent goal"   # Git Bash / POSIX
.\harness\burst.ps1 feature "Implement X per the persistent goal" # PowerShell
```

Profiles: `repair` (8 turns/40k/20m), `feature` (24/180k/3h), `formal`
(20/160k/3h), `simulate` (20/140k/4h) — each with a matching gate profile and
a gate timeout sized to dominate that profile's manifest budget. The gate
definition (verify.py + manifest.json) is **frozen to a temp copy at launch**,
so mid-burst edits to `harness/` cannot change what the gate checks — review
pre-burst edits to `harness/` before launching. Exit 0 means the gate passed;
exit 1 means failing-or-limit ("reaching a limit does not imply success" is
Prime Agent's own semantics, and the launcher preserves it).

## Guardrail → mechanism map

| Failure mode (observed in early Prime Agent use) | Harness mechanism | Verified interface it rides on |
|---|---|---|
| Orchestration-code slips (bad `rlm.run` calls, lost results) | `spawn()`/`collect()` with mandatory file-based JSON contract; raw `rlm.run` banned by policy | `rlm.run(prompt, name=, model=)` returns admission handles only; results via files/messages |
| Recursive explosion / duplicate work | `admit()`: depth advisory, active-children cap, task fingerprint dedup, budget floor | host-enforced `rlmMaxDepth` (default 1); `goal.get().remaining_tokens` |
| Drift / incomplete changes across compaction | file-backed `TaskState` + child registry; compaction-checklist policy | session-artifacts survive compaction; kernel vars persist |
| "Looks right" ≠ is right | `sci_verify` oracles + composite gate as the completion criterion | `/autonomous` shell gates; 6000-char gate output cap respected |
| Self-confirming knowledge | `evidence_ledger`: status/commit-filtered retrieval, verifier-required "verified", append-only invalidation | SQLite+FTS5, zero infra |
| Producing agent can't see its own bugs | `external_critic.review()` on a frozen detached worktree, restrictive CLI permission flags, JSON findings, falsify-or-rebut protocol | headless `claude -p` (tool allowlist) / `codex exec --sandbox read-only`; `git worktree add --detach` |
| Unsupervised self-modification / reward hacking | `autoRefine` disabled; snapshot→refine→diff→evaluate protocol; gate definition frozen at burst launch; gate edits require human approval; holdout gate profile | local harness state files; `/refine rollback <id>` (human-run) |
| Gate retries silently not re-running | test suites live under `checks/`, never `verification/` | Prime Agent's unchanged-workspace pathspec excludes the literal name `verification` |
| Gate flakiness burning retries | bounded gate output, full logs to files, `GATE_RESULT` machine line, per-check timeouts with tree-kill | gate retry/unchanged-workspace semantics |
| Windows breakage | doctor mirrors Prime Agent's exact bash/kernel resolution; binary auto-detect; no POSIX-isms in gate path | `utils/shell.ts` resolution order; `taskkill /T` |

## Live kernel compatibility check

After installing into a running Prime Agent version, validate the host/kernel
contract rather than trusting source-version labels:

```python
report = await harness_orchestrator.selfcheck()
```

The check is non-destructive and fails loudly on drift in RLM lifecycle/model
catalogs, goal budget shape, messaging, compact/refine status, observation,
heartbeats, harness CRUD, depth/session provisioning, governed refinement, or
telemetry enablement. The opt-in `tests/test_live_kernel_e2e.py` runs the same
check inside a Prime Agent IPython kernel and skips in ordinary offline pytest.
The complete v0.7.1 runtime findings and unresolved-surface reasons are in
`docs/prime-agent-v0.7.0-api-reference.md`.

## Outside-kernel telemetry scorecard

Generate a per-task scorecard from durable artifacts without importing Prime
Agent, starting an IPython kernel, or disabling product telemetry:

```bash
python -S harness/scorecard.py \
  --session-dir "$RLM_SESSION_DIR" \
  --output artifacts/harness/scorecard-latest.json \
  --markdown artifacts/harness/scorecard-latest.md
```

The stdlib-only reader combines root-session JSONL (including deduplicated
`child_usage_attributed` events), the append-only daemon child registry,
orchestrator `children.json` and result contracts, the read-only SQLite evidence
ledger, archived gate results, task state, persistent goal events, and Git
numstat churn. Ledger metrics include only IDs named by the task state; rows are
never assigned to a task merely because their timestamps overlap. Per-child
usage attribution uses an in-memory SHA-256 match between the parent tool call
and registry `spawnCode`; prompt, reasoning, tool source, response text,
objective text (including hashes), child summaries, and evidence claims are
never emitted.
Ambiguous mappings fail open into an unattributed bucket rather than guessing or
double-counting. Use explicit `--session-file`/`--registry` paths when running
outside an environment that exports `RLM_SESSION_DIR`. `--now` makes replay
deterministic, and `--fail-on critical` turns actionable alerts into a monitor
exit code without changing the default best-effort exit 0.

The verification-to-churn rate is a triage heuristic, **not** a correctness
score: it counts task-attributed verified/refuted/inconclusive activity per 100
changed source lines. Gate metrics explicitly say *archived* because early gate
errors may exit before creating an archive. Raw, substantive (at least one
applicable check or a failure), per-check, and per-profile rates remain separate;
a vacuous quick pass cannot recover another profile's substantive failure.
`--now` is an inclusive upper bound for replay, not just a display timestamp.

### Scorecard alert list

| Code | Severity | Meaning / action |
|---|---|---|
| `NO_TASK_STATE` | critical | Task state is missing; restore or initialize it before trusting task-scoped metrics. |
| `UNRESOLVED_CLAIMS` | critical | Resolve or explicitly disposition task claims before completion. |
| `BRANCH_MISMATCH` | critical | Switch to the working branch recorded in task state. |
| `GOAL_BUDGET_LOW` | critical | Remaining persistent-goal tokens are below the configured percentage. |
| `GATE_FAILURE` | critical | The latest archived composite gate failed or errored; fix and rerun it. |
| `GATE_PROFILE_UNRECOVERED` | critical | A profile's latest substantive run still fails even if another profile later passed vacuously. |
| `TASK_ATTRIBUTION_GAP` | critical | Task state has no evidence IDs; do not guess ownership from timestamps. |
| `EVIDENCE_ID_MISSING` | critical | A task evidence ID is absent from the readable ledger snapshot. |
| `UNVERIFIED_VERIFIER_METADATA` | critical | A `verified` ledger row lacks a named verifier; repair its provenance. |
| `DEAD_CHILD` | critical | A child has a failed/dead terminal registry state; reconcile and inspect its result. |
| `TELEMETRY_MISSING` | critical | Root session JSONL is unavailable; provide the correct session path. |
| `GOAL_MISSING` | warning | No durable `thread_goal_state` event was found. |
| `GOAL_INACTIVE` | warning | The latest durable goal snapshot is not active. |
| `NO_GATE_RUNS` | warning | No archived gate result exists inside the task window. |
| `NO_APPLICABLE_GATE_CHECKS` | warning | Gate runs exist, but every run was vacuous. |
| `GATE_VACUOUS_PASS` | warning | A passing archive executed zero applicable checks; exclude it from the substantive rate. |
| `GATE_INCOMPLETE` | warning | An archived result had missing/unknown schema fields. |
| `VERIFICATION_BEHIND_CHURN` | warning | Evidence activity is below the configurable churn heuristic; add focused verification or document why it is inapplicable. |
| `STALE_CHILD` | warning | A running child has no recent durable event; inspect before declaring it dead. |
| `ACTIVE_CHILD_MISMATCH` | warning | Task-state active names and latest registry running names disagree. |
| `UNATTRIBUTED_CHILD_USAGE` | warning | Attribution is absent or ambiguous; retain it separately rather than guessing. |
| `FUTURE_EVENT` | warning | An event later than the inclusive `--now` clock was excluded from replay. |
| `INPUT_ANOMALY` | warning | At least one input line/file/schema was missing or malformed; inspect `warnings`. |
| `GATE_HISTORY_FAILURES` | info | Earlier failures were recovered by a newer substantive pass in the same profile. |
| `EVIDENCE_OUTSIDE_TASK` | info | Time-window ledger rows not named by task `evidence_ids` were excluded. |

## Deterministic evaluation and refinement replay

`checks/evalset/corpus.json` is a versioned 16-task public baseline spanning
symbolic assumption traps, Decimal precision ladders, convergence orders, and
invariant drift. Standard-library-only `harness/replay.py` never accepts
caller-supplied answer bundles. It invokes a digest-pinned trusted adapter twice
per task, supplies the frozen local+global harness state, strips oracle fields
from each challenge, and independently verifies the returned JSON behavior.
Malformed, errored, unstable, below-threshold, or unbound runs fail closed.

```bash
python -S harness/replay.py \
  --executor checks/evalset/executors/reference_adapter.py \
  --snapshot checks/evalset/snapshots/baseline-v1.json \
  --require-perfect \
  --output artifacts/harness/replay/baseline.json
```

The reference adapter is a single-snapshot corpus self-test; its path and exact
digest are rejected for comparisons. Semantic derivatives cannot be detected
from public tasks alone and are instead barred by adapter review plus private
holdouts. A production adapter under `harness/replay_adapters/` must actually
instantiate behavior from the supplied state. Candidate provenance binds the
adapter, corpus, complete baseline bundle and state, plus exactly one append-only local
refinement event while global state remains unchanged. Comparison also requires stable repetitions,
corpus/category minimums, no task regression, and no lower total. Exit 0,
`status=pass`, and `eligible_for_promotion=true` derive from one decision.
See `checks/evalset/README.md` for protocol, confinement, and capture details.
The public corpus measures regression rather than secrecy; CI-only holdouts
remain separate.

## CI profiles and private holdouts

Fresh installs include `.github/workflows/prime-harness.yml`. Its pinned-action
matrix runs doctor first and then the existing `default` and `holdout`
profiles; it does not rewrite `harness/manifest.json`. The checked-in holdout
test is explicitly a **public transport smoke**, not a scientific holdout or a
promotion signal.

Real holdouts must remain outside the agent workspace. Use a protected private
reusable workflow, an ephemeral protected-runner mount, or a separate private
checkout with a short-lived read-only credential. Pin the candidate and test
suite by immutable commit, do not run secret-bearing jobs for untrusted forks,
and never expose test contents or detailed failures to the agent. See
`checks/hidden_holdout/README.md`; the public template intentionally contains
no secret names, credentials, repository coordinates, or private tests.

## Integrity-checked backups

`harness/backup.py` is a standard-library CLI that snapshots three roots in
one atomic ZIP archive:

- the current RLM session directory (`RLM_SESSION_DIR`, or `--session-dir`);
- project `artifacts/harness` except its `backups/` subtree; and
- global `~/.prime/agent/harness` (recorded as absent when not yet created).

It copies every `evidence.db` with SQLite's online backup API, including
committed frames from a live or crash-left uncheckpointed WAL, records a strict
manifest of paths, sizes, SHA-256 hashes, modes, and timestamps, then verifies
the completed archive before reporting success. Source and archive symlinks or
Windows reparse points, concurrent source-identity swaps, special files,
duplicate or case-colliding names, traversal/noncanonical paths, Windows ADS
or reserved-device components, privileged setuid/setgid/sticky modes,
corruption, and missing SQLite snapshot markers fail closed on every platform.

    python -S harness/backup.py create
    python -S harness/backup.py verify artifacts/harness/backups/prime-harness-....zip
    python -S harness/backup.py restore BACKUP.zip --destination ../harness-restore

Restore requires a destination path that does not yet exist, verifies before
writing, extracts into a confined sibling staging directory, and atomically renames the
staging tree into place. The restored layout has `session/`,
`project/artifacts/harness/`, and (when present) `global/harness/`; inspect it
before copying any state back into live locations. Backup files are integrity
artifacts, not encrypted secrets: store and transmit them under the same or
stronger access controls as the session and evidence ledger.

## Model routing

Roster roles accept an optional exact `provider/model` selector (from
`rlm.find_models()` inside a session — selectors are credential-bound, so the
harness never hardcodes them). Recommended split: keep the strongest model as
root synthesizer; route implementation/extraction children to cheaper models
after you've benchmarked them on your own tasks; use a *different vendor* for
`external-critic` than the root model, for genuine diversity.

## Governed refinement (`/harness-refine`)

Prime Agent's Continual Harness is powerful and, per Prime Intellect's own
case study, capable of reward-hacking its objective. Policy here:

- `autoRefine` off; refinement is a deliberate act with evidence (2+
  occurrences), via `/harness-refine`.
- Snapshot before, diff after (`harness_snapshot`/`harness_diff`), smallest
  viable edit, local scope by default.
- Before refinement, capture and deterministically replay a fresh evalset
  response bundle. After refinement, independently capture a candidate bound to
  that baseline and require a no-regression `replay.py` comparison.
- A passing replay is necessary but not sufficient: the refinement stays
  *provisional* (ledger `unverified`) until later held-out/gate-passing work
  confirms it. A replay failure or later contradiction blocks promotion and the
  agent reports the id so **you** can run `/refine rollback <id>` (rollback is
  deliberately human-only; the kernel refine skill has no rollback parameter).
- The `holdout` gate profile exists for humans/CI to catch gaming — run it
  before promoting refinements or merging.

## Compatibility

Built against Prime Agent **v0.7.0** (commit `be9e2fa0`), from its source —
key facts this harness depends on:

- Skills: `SKILL.md` (frontmatter `description` is the one hard requirement) +
  `pyproject.toml` (hatchling, `packages = ["src/<import_name>"]`) +
  `src/<import_name>/__init__.py`; editable-installed into the kernel venv;
  `run()` makes a module awaitable-callable *inside the kernel only*.
  `prime-agent-runtime` is bundled, not on PyPI — never a declared dependency.
- `rlm.run` kwargs: exactly `name` (≤64 chars, unique among siblings) and
  `model` (exact selector; failed resolution fails the spawn — no fallback).
- Autonomous flags: space-separated values only (`--flag=value` is silently
  ignored); defaults 3 continuations / 12 turns / 80k tokens / 30 min / 3 gate
  retries / 5-min gate timeout; gate streams truncated at 6000 chars.
- Goal: `goal.create(objective, token_budget)`; **only** `goal.complete()`
  signals success; `remaining_tokens` readable in-kernel.
- Refinement state: `<session-artifacts>/harness/harness_state.json` (local),
  `~/.prime/agent/harness/` (global); rollback by refinement id.
- Project config: `<cwd>/.prime/agent/` exactly (no upward walk for settings;
  `APPEND_SYSTEM.md` is project-first, first-match-only).
- The autonomous gate's unchanged-workspace detection excludes a hardcoded
  pathspec including the literal directory name `verification` — which is why
  this harness names its suites `checks/`.

If Prime Agent updates change these, `harness/doctor.py` and the skills fail
loudly rather than silently misbehaving — re-verify after major updates.

## Development

POSIX / Git Bash:

```bash
cd prime-harness
python3 -m venv .venv || python -m venv .venv
.venv/bin/pip install sympy mpmath hypothesis pytest pyyaml 2>/dev/null || .venv/Scripts/pip install sympy mpmath hypothesis pytest pyyaml
.venv/bin/python -m pytest tests/ -q 2>/dev/null || .venv/Scripts/python -m pytest tests/ -q
```

Windows PowerShell (5.1-compatible — `;` not `&&`):

```powershell
cd prime-harness
python -m venv .venv; .venv\Scripts\pip install sympy mpmath hypothesis pytest pyyaml
.venv\Scripts\python -m pytest tests\ -q
```

Tests cover the ledger, verification oracles, gate runner, admission policy,
critic output parsing, and installer idempotency — all runnable without a
Prime Agent installation (kernel interactions are stubbed).
