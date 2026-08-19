---
name: workflow-autoresearch
python-import: autoresearch
description: Use when a host-approved workflow needs measurable experiments against competing solution mechanisms.
---

# AutoResearch

This bundled skill is a thin kernel-side facade over the built-in host-owned
AutoResearch API. It sends an experiment request and returns the bounded
evidence/proposal result owned by the host.

```python
evidence_ref = {
    "artifact_id": "evidence-1",
    "relative_path": "artifacts/evidence/evidence-1.json",
    "digest": "a" * 64,
    "size_bytes": 128,
    "source_event_sequence": 7,
}
await autoresearch.run(
    "c" * 64,
    [evidence_ref],
)
```

The host owns the experiment loop, repository/worktree isolation, metrics,
guards, evaluator, state, and approvals. The facade does not read or write
files, use the network, start subprocesses, mutate a store, or select a
frontier. Its result is evidence/proposal only and cannot authorize, promote,
or complete a workflow. Experiment output cannot promote or complete without
public-boundary evidence for both intended and forbidden outcomes. Coverage,
counts, unit tests, or mock-only results are diagnostic evidence only.

## Independent solutions only

AutoResearch searches over distinct, falsifiable mechanisms. Every candidate
must belong to a new solution family, explain a different causal mechanism,
state what evidence would falsify it, and pass an adversarial independence
review bound to the exact candidate change and baseline. Opaque digests,
renamed candidates, and self-authored “red-team” labels do not establish
independence; the host reviewer evaluates the canonical mechanism and change
semantics before any candidate process starts.

Never use AutoResearch to sweep or tune parameters of an existing mechanism.
This includes thresholds, weights, retry counts, timeouts, prompts,
temperatures, batch sizes, concurrency limits, and nearby configuration
values. A parameter may change only as an incidental requirement of a new
mechanism; the parameter change cannot be the candidate's hypothesis or the
reason it is expected to improve.

| Pressure | Required response |
|---|---|
| A previous parameter change improved the metric | Investigate why, then propose different mechanisms that address that cause. Do not continue the sweep. |
| Time is short and tuning is cheap | Run fewer independent solutions or report blocked. Cheap metric exploitation is not progress. |
| Only parameter variants remain | Stop AutoResearch. Parameter calibration requires a separately user-approved calibration workflow and cannot authorize goal progress. |

Red flags: “try a slightly larger value,” “search the neighborhood,” “continue
the trend,” “optimize the prompt,” or multiple candidates sharing one solution
family. Reject these before execution.

Use this only for a host-approved native experiment request. It is not a
general-purpose shell, Git, filesystem, network, or workflow-control API.
Unit tests are allowed only as temporary debugging probes and never count as
acceptance evidence. Required acceptance tests are public intent scenarios at
the host/store/process/restart boundaries, covering both intended and
forbidden outcomes. Permanent evidence cannot call private symbols, inspect
source text, or depend on production `*_for_test` hooks. Those probes are
temporary, nonauthorizing, and removed before terminal review. A candidate
must still be rejected when a test hook makes a private check pass while the
public outcome remains wrong. Coverage and test counts are diagnostic only.
Each failing intent scenario authorizes only its named invariant and necessary
production surface. GREEN consumes that authority; a new behavior or broader
surface requires a fresh RED unless the host accepts an adversarially reviewed
closure proving the same cross-cutting invariant requires it. Later tests never
retroactively authorize an earlier production effect.
