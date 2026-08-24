---
name: writing-plans
description: "Optional planning support for a genuinely requested multi-step task after authority is resolved."
---

# Authority-Aware Planning

Planning is optional and subordinate to the workflow host. Consume the
`DecisionResolutionManifest` before proposing plan work. A plan describes
implementation intent; it never grants permission to write, commit, deploy,
spend, use credentials, or publish.

## Prime Agent fork contract

- Contract: `role=planner; authority=methodology-only; capacity=host-assigned-luna; host-authority=commit,stage,push; output=task-graph,constraints,acceptance`
- Contract: `implementation-pseudocode=none; implementer=product-and-tests; write=none; commit=none; stage=none; push=none`
- Contract: `decision-resolution=DecisionResolutionManifest; plan-artifact=host-requested-only; effects=host-gated`
- Contract: `approval=none; merge=none; completion=none; intent=required; forbidden-outcomes=required; red=observed-recorded-before-implementation; adversarial-probes=regression-before-fix`
- Contract: `acceptance=black-box-public-boundary; unit-probes=temporary-debugging-only; mocks=mock-only-inadequate`
- Contract: `runtime>=0.147.0-alpha.10; fallback=forbidden`
- Contract: `durability=real-store-process-restart; adversarial=metamorphic,race,caller-mutation,locale,stale-replay; anti-cheating=required; green=independent-verification-adversarial-review`

The host owns every file write, plan artifact, approval, commit, merge, and
completion decision. This skill only returns methodology and acceptance intent.

## Authority-first handoff

When a full-workflow authorization and frozen invariants cover the task, do not
ask preference questions or create a project planning document. Hand the
resolved decisions and their `resolutionRefs`, `evidenceRefs`, and red-team
evidence to the host, then continue directly to the W0/public-boundary intent
RED. The host may gate deployment or another external effect later even when
the implementation design is already selected.

When a plan is genuinely requested or authority is still missing, return one
bounded task graph that names the missing authority and the exact acceptance
boundary. Batch any remaining approval questions in one manifest; do not turn
plan sections into a sequence of preference prompts. Question count is not
progress.

## Plan shape

Keep a plan concise and concrete:

- Goal and forbidden outcomes, copied from the resolved intent.
- Affected files and the public boundary each task changes.
- Interfaces and ownership without implementation pseudocode.
- One RED/GREEN acceptance scenario per behavior, with the observed RED
  recorded before product code changes.
- Adversarial checks for caller mutation, stale authority, races, locale, and
  anti-cheating where the boundary permits them.
- Real store, process, restart, or integration evidence whenever durability or
  authority is part of the outcome.

The implementer owns product code and durable intent tests. Unit probes and
mock-only results are supplemental diagnostics and cannot promote a task.
Reviewers verify the public boundary independently. A plan is not a commit
request, and this skill does not select an execution mode.

The optional read-only plan reviewer is reference material only:
`plan-document-reviewer-prompt.md`.
