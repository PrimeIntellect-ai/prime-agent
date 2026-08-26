---
name: avo
description: Run Prime's universal AVO candidate-evaluate-revise loop for iterative or long general, coding, and research tasks. Use when work needs multiple attempts, executable or external feedback, persistent lineage, namespaced NOOA memory, recovery, or trajectory supervision. Direct one-step tasks may use the host substrate without loading this full workflow.
---

# Universal AVO

Prime has one AVO substrate. General, coding, and research are evaluation
adapters; direct, iterative, and long are task horizons. The TypeScript host
owns canonical state and lineage. This Python package is a typed bridge.

Do not inspect the module or guess API signatures. Begin with
`await avo.initialize(objective, environment=..., horizon=...)` for a new run,
or `await avo.get_state()` after restart. Use the returned execution contract.

## Required iterative loop

1. Record a candidate with `add_candidate`. A candidate may be an answer,
   action, artifact, patch, implementation, plan, or hypothesis. The host
   stores a digest rather than trusting a model-supplied hash.
2. Execute the relevant environment check.
3. Record every result with `record_evaluation`. Use `authority="environment"`
   for tests/build/runtime/filesystem checks, `external` for API/web/user-defined
   evidence, `host` only for a host-issued receipt, and `model_opinion` for
   subjective self/reviewer judgment.
4. Complete the cycle with `complete_cycle`. The host derives accept/reject/
   revise/inconclusive from receipts; callers cannot declare their own outcome.
5. Inspect the checkpoint and revise. Direct automatically escalates to
   iterative after a failed attempt. Repeated stagnation can escalate iterative
   to long. Automatic routing never lowers an active horizon.
6. Finish only after `stop_gate()` passes. Model opinion alone cannot pass it.

Long runs bind a retained generic supervisor. Iterative runs bind one only when
the host detects stagnation. Direct tasks never pay that cost.

## Example

```python
import avo

await avo.initialize(
    "Fix the parser race without regressions",
    environment="coding",
    horizon="iterative",
)
candidate = await avo.add_candidate({
    "candidate_id": "patch-parser-lock",
    "kind": "patch",
    "summary": "Serialize parser cache mutation",
    "payload": {"diff_sha256": "..."},
})
await avo.record_evaluation({
    "candidate_id": candidate["candidate"]["candidateId"],
    "evaluator_id": "test",
    "status": "pass",
    "authority": "environment",
    "evidence_refs": ["pytest:test_parser_race:exit=0"],
    "metrics": {"passed": 18},
})
await avo.complete_cycle({"candidate_id": "patch-parser-lock"})
await avo.stop_gate()
```

## Memory

Memory namespaces are `general`, `coding`, `research`, and `shared`. Recall
uses the active environment plus `shared`. Promote a memory to `shared` only
with source IDs showing that it is reusable across environments. NOOA 0.0.8
runs in its pinned Python 3.13 sidecar; host lexical recall remains the lossless
fallback. Canonical memory remains host-owned.
