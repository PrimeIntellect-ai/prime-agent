---
name: workflow
description: Use the host-owned workflow authority to read execution evidence and submit evidence for the current ready stage.
---

# Workflow authority

This bundled facade exposes the authenticated workflow API inside the coordinator kernel.

Use `workflow.v1.execution_evidence.read()` to read host-issued execution evidence. Use
`workflow.v1.pipeline.record(stage_id, evidence_refs)` only for the dependency-ready stage and
only with exact host-issued evidence references. The host remains the sole authority for evidence
classification, stage admission, task transitions, and the next dependency-ready launch.

Execution activity, reports, test counts, and opaque hashes do not advance a stage by themselves.
The facade cannot bypass evaluators, protected boundaries, task dependencies, or completion gates.
