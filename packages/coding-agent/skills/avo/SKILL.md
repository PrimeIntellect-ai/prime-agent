---
name: avo
description: Prime's default candidate-evaluate-revise lifecycle for every root task. Always use this skill before completing general, coding, or research work; the host automatically chooses the internal evaluation adapter and task horizon, keeping direct tasks lightweight while enabling lineage, NOOA memory, recovery, and trajectory supervision when needed.
---

# Universal AVO

Prime has one AVO substrate. General, coding, and research are evaluation
adapters; direct, iterative, and long are task horizons. The TypeScript host
owns canonical state and lineage. This Python package is a typed bridge.

AVO is always active for a root task; it is not a mode the user has to enter.
The host selects the adapter and horizon automatically from the task. Do not ask
the user to choose an adapter. The model cannot select an environment and may
only escalate the horizon to `iterative` or `long`. A user may override the
horizon through the `/avo horizon` command.
After a task passes its stop gate, the next root task starts a fresh task run;
the prior candidate/evaluation lineage is archived while verified memory remains
available across runs.

Do not inspect the module or guess API signatures. Begin with
`await avo.initialize(objective)` for a new run,
or `await avo.get_state()` after restart. Use the returned execution contract.
Never pass or request an environment override.

## Required iterative loop

1. Record a candidate with `add_candidate`. A candidate may be an answer,
   action, artifact, patch, implementation, plan, or hypothesis. The host
   stores a digest rather than trusting a model-supplied hash.
2. For an executable check, call `run_evaluation(candidate_id, command)`. The
   host runs one recognized direct test/build/lint/benchmark/runtime/filesystem/
   git command and creates the immutable environment receipt from its actual
   exit status and output. Shell composition is rejected.
3. For a real web/API/connector result, call
   `bind_tool_result(candidate_id, tool_call_id, exact_quote)`. The host resolves
   the completed external tool call from the current task transcript, verifies
   that the exact quote occurs in its non-error result, and binds argument,
   result, source, timestamp, and candidate digests into an external receipt.
4. Use `record_evaluation` only for subjective self/reviewer judgment. It only
   accepts `authority="model_opinion"`; callers cannot mint host, environment,
   or external authority.
5. Complete the cycle with `complete_cycle`. The host derives accept/reject/
   revise/inconclusive from receipts; callers cannot declare their own outcome.
6. Inspect the checkpoint and revise. Direct automatically escalates to
   iterative after a failed attempt. Repeated stagnation can escalate iterative
   to long. Automatic routing never lowers an active horizon.
7. Finish only after `stop_gate()` passes. Model opinion alone cannot pass it.

Long runs bind a retained generic supervisor. Iterative runs bind one only when
the host detects stagnation. Direct tasks never pay that cost.

## Example

```python
import avo

await avo.initialize(
    "Fix the parser race without regressions",
)
candidate = await avo.add_candidate({
    "candidate_id": "patch-parser-lock",
    "kind": "patch",
    "summary": "Serialize parser cache mutation",
    "payload": {"diff_sha256": "..."},
})
await avo.run_evaluation(
    candidate["candidate"]["candidateId"],
    "python -m pytest -q tests/test_parser_race.py",
)
await avo.complete_cycle({"candidate_id": "patch-parser-lock"})
await avo.stop_gate()
```

## Memory

Memory namespaces are `general`, `coding`, `research`, and `shared`. Recall
uses the active environment plus `shared`. Promote a memory to `shared` only
with at least two environment-qualified source IDs from distinct environments,
for example `coding:test-123` and `research:review-456`. Promotion runs only
after the host resolves every ID to an accepted candidate, cycle,
authoritative passing evaluation, or canonical adapter-progress entry in the
current/archived AVO lineage. Syntactically plausible IDs are rejected. NOOA 0.0.8
runs in its pinned Python 3.13 sidecar; host lexical recall remains the lossless
fallback. Canonical memory remains host-owned.
