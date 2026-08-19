---
name: mempalace
description: Recall and propose canonical reusable how/why/procedure knowledge through the built-in single workflow-store host boundary.
---

# MemPalace

This bundled skill is a thin kernel-side facade over the built-in MemPalace
boundary hosted by the single persisted workflow store. It can request bounded
recall and submit a source-backed canonical knowledge proposal.

```python
evidence_ref = {
    "artifact_id": "evidence-1",
    "relative_path": "artifacts/evidence/evidence-1.json",
    "digest": "a" * 64,
    "size_bytes": 128,
    "source_event_sequence": 7,
}
await mempalace.recall("deployment timeout", knowledge_kind="procedure", limit=5)
await mempalace.propose("how", [evidence_ref])
```

The host owns canonical commits, evidence, privacy/scope checks, the optional
derived local index and its durable fence, and all durable storage. Proposal kinds are only reusable
how/why/procedure knowledge with source evidence. Transient decisions or run
history (including outcomes and transient workflow state) are rejected before
a host request. Recall and proposals cannot authorize, promote, or complete a
workflow.
This facade does not read or write files, use the network, start subprocesses,
or mutate a store. Results are bounded evidence/proposals only. Coverage,
counts, and mock-only checks are diagnostic. Unit tests are temporary debugging
probes only, never acceptance. Durable knowledge claims require public
host/store/process/restart intent scenarios that prove both intended and
forbidden outcomes.

MemPalace is not a workflow journal, experiment-results store, approval path,
or general-purpose memory writer.
