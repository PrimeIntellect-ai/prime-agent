# Prime Harness runtime contracts

This consumer-safe contract document is shared byte-for-byte by the upstream
suite and the installed self-test bundle. It intentionally omits upstream
installation, development-environment, and measured model-selector content.

## Scorecard alert codes

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
| `VERIFICATION_BEHIND_CHURN` | warning; critical in completion mode | Per-directory evidence activity is below the configured churn threshold; add focused verification or a signed task-scoped ledger disposition. |
| `VERIFICATION_COVERAGE_UNAVAILABLE` | critical in completion mode | The evidence schema cannot prove per-directory coverage; repair the ledger/schema rather than bypassing completion. |
| `VERIFICATION_CHURN_BASE_UNAVAILABLE` | critical in completion mode | Task base or repository HEAD cannot be resolved; restore the pinned Git interval. |
| `VERIFICATION_CHURN_INTERVAL_EMPTY` | critical in completion mode | Task base equals HEAD, which could hide a reset completion interval; create/restore a task pinned before the work. |
| `VERIFICATION_CHURN_RANGE_INVALID` | critical in completion mode | The task base does not resolve as an ancestor of HEAD; restore the pinned branch/range. |
| `VERIFICATION_HEAD_REGRESSION` | critical in completion mode | The task's highest observed HEAD is missing or no longer an ancestor of current HEAD; restore the observed work rather than completing from a reset. |
| `STALE_CHILD` | warning | A running child has no recent durable event; inspect before declaring it dead. |
| `ACTIVE_CHILD_MISMATCH` | warning | Task-state active names and latest registry running names disagree. |
| `UNATTRIBUTED_CHILD_USAGE` | warning | Attribution is absent or ambiguous; retain it separately rather than guessing. |
| `FUTURE_EVENT` | warning | An event beyond the inclusive `--now` clock and fixed live-append skew was excluded from replay. |
| `INPUT_ANOMALY` | warning | At least one input line/file/schema was missing or malformed; inspect `warnings`. |
| `GATE_HISTORY_FAILURES` | info | Earlier failures were recovered by a newer substantive pass in the same profile. |
| `EVIDENCE_OUTSIDE_TASK` | info | Time-window ledger rows not named by task `evidence_ids` were excluded. |

## Panel finding closure

Critic findings are untrusted input. A critical or major panel finding remains
open until `record_panel_verdict()` appends a `fixed` or `rebutted` disposition
with a rationale, named verifier, and live verified evidence. Every cited row
must mention the panel or finding identifier, must have been created no earlier
than the panel run, and is copied into the hash-chained verdict record for
auditability. Missing, unrelated, stale, invalidated, or self-attested evidence
cannot close a finding.
