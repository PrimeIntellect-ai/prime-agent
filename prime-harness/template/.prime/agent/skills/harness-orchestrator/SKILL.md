---
name: harness-orchestrator
description: Disciplined delegation and task-state management for this project. Use BEFORE spawning any subagent and at the start of every substantive task. Provides typed task state that survives kernel loss (new_task/load_task_state/save_task_state), an admission policy for delegation (admit), roster-based specialist spawning with a mandatory structured output contract (spawn/collect/pending/followup), goal-budget introspection (budget_status), and Continual Harness snapshot/diff for governed /refine (harness_snapshot/harness_diff). Call `await harness_orchestrator()` for a status overview.
---

# harness-orchestrator

The control-plane discipline for this repository. Raw `rlm.run(...)` calls are
**not allowed** in this project — always delegate through `spawn()` so that
duplicate-task prevention, budgets, and the output contract apply.

## Start of every task

```python
state = harness_orchestrator.new_task("integrator-042", "Implement and verify X", working_branch="agent/integrator-042")
# or resume:
state = harness_orchestrator.load_task_state()
await harness_orchestrator()   # status overview: state, children, budget, last gate
```

Keep `state` updated (assumptions, unresolved_claims, evidence_ids,
next_actions) and `save_task_state(state)` after every meaningful step —
this file is how you recover after compaction or kernel loss.

## Delegation

```python
decision = await harness_orchestrator.admit("symbolic-auditor", task_text,
    independent_subproblem=True, objective_verifier_available=True)
if decision:
    info = await harness_orchestrator.spawn("symbolic-auditor", task_text,
        context={"claim": "...", "assumptions": {...}})
# ... end your turn; child results arrive as agent messages and files ...
result = harness_orchestrator.collect(info["name"])     # validated dict
await harness_orchestrator.followup(info["name"], "Also check x<0")
```

Roles come from `harness/roster.yaml`. Children must return the structured
JSON contract; `collect()` raises with instructions when they do not.
`pending()` lists children that have not reported. Spawn independent children
in separate calls and end your turn instead of polling.

## Budget

`await budget_status()` returns the persistent goal and `remaining_tokens`.
`admit()` refuses spawns when the remaining goal budget is under the
configured floor (harness/config.json).

## Governed refinement

```python
harness_orchestrator.harness_snapshot("before-refine")
# then: await refine.run("...")   # local scope; applies at the turn boundary
print(harness_orchestrator.harness_diff())   # exactly what changed
```

Promote a refinement only after the verification gate passes on held-out
work. Rollback is a HUMAN action: report the refinement id to the operator
and ask them to run `/refine rollback <refinement-id>`.

## Live compatibility self-check

After installing into a new Prime Agent version or recovering a kernel, run:

```python
report = await harness_orchestrator.selfcheck()
```

`selfcheck()` performs only read-only host round-trips and validates the
load-bearing RLM, goal, messaging, compaction, refinement, observation,
heartbeat, harness-CRUD, depth, governance, and telemetry contracts. It
returns a detailed passing report or raises `SelfcheckError` with every API
drift found. Session-optional goal, compaction, refinement, heartbeat,
messaging, and observation controllers that are not provisioned are recorded
under `capabilities` and `warnings` instead of being misreported as drift;
malformed responses from a provisioned controller still fail.
In the upstream prime-harness repo, the opt-in `tests/test_live_kernel_e2e.py` runs this same
check inside a live kernel; it is not part of the installed bundle (see
`.prime/agent/harness-tests/BUNDLE.md`).

## Goal-completion coverage check

Immediately before `goal.complete()`, after clearing `unresolved_claims`, run:

```python
report = harness_orchestrator.completion_check()  # 240s outer timeout; final check is 180s
assert report["status"] == "pass"
```

This executes the non-vacuous `final` gate profile, whose required check runs
the outside-kernel scorecard in `--completion --fail-on critical` mode. It
requires a resolvable ancestor-based non-empty task churn interval, a monotonic
highest-observed-HEAD high-water mark, and the full evidence-ledger coverage
schema, and enforces non-weakening configurable
per-top-level-directory churn coverage, rejects critical alerts and HEAD races,
and checkpoints `quality_gate_status.completion_coverage`. There is no boolean
coverage bypass.

When churn is genuinely inapplicable, construct the only accepted explicit
disposition metadata with
`coverage_disposition_assumptions(["directory"], "specific reason...")`, then
record it with `evidence_ledger.record(status="verified",
claim_type="verification-coverage-disposition", verifier="named independent
verifier", assumptions=metadata, artifacts=[...])` and add the returned ID to
task state. Invalidated, unsigned, stale-base, malformed, or out-of-task rows do
not waive coverage.

