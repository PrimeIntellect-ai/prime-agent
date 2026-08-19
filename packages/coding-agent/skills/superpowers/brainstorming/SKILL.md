---
name: brainstorming
description: "Optional brainstorming support for unresolved user intent, design tradeoffs, and acceptance boundaries."
---

# Authority-First Brainstorming

Brainstorming is an optional, subordinate methodology. The workflow authority
host and its
`DecisionResolutionManifest` are authoritative for intent, authority, effects,
and progress. This skill may clarify an unresolved decision, but it cannot
create authority or make a host gate disappear.

## Prime Agent fork contract

- Contract: `role=designer; authority=methodology-only; capacity=host-assigned-luna; host-authority=commit,stage,push; write=none; commit=none; stage=none; push=none; approval=none; merge=none; completion=none`
- Contract: `standalone-design=skip-small; design-code=none; adapter=DecisionResolutionManifest; workflow-authority=subordinate; questions=bounded-batch; effects=host-gated`
- Contract: `acceptance=public-intent-boundary; unit-probes=temporary-debugging-only; mocks=mock-only-inadequate`
- Contract: `runtime>=0.147.0-alpha.10; fallback=forbidden`

The host owns every file write, approval, effect authorization, commit, merge,
and completion decision. A full-workflow authorization with frozen invariants
can take a covered task directly to the W0/public-boundary intent RED.

## Decision resolution

Before asking anything, consume the current manifest. Record one entry per
decision with these fields:

- `decision`
- `source`: `signed_user_approval`, `durable_goal`, `sealed_spec`, `invariant`, or `reversible_default`
- `confidence`
- `redTeamChallenge` and its evidence references
- `reversibility`
- `externalEffectClass`
- `resolutionRefs` and `evidenceRefs`

An entry may be auto-resolved only when it is already approved, a logically
forced hard invariant, or a reversible default proved in scope with no new
cost, preserved safety, and no external authority. Do not invent assumptions;
every avoided question cites the approving or invariant reference and the
red-team evidence that supports it.

Design selection and effect authorization are separate. Select a fail-closed
design when the design is covered, then leave deployment and other effects to
the host's later authorization gate. An external effect remains external even
when someone describes it as reversible.

Ask only for authority that is absent for user-visible intent, a signed Pareto
tradeoff, provider or material cloud spend, protected reads, legal or safety
decisions, credential actions, or an irreversible external effect. Present all
remaining questions once in one bounded approval manifest. Do not drip them
out as a sequence of preference prompts. A question count is not progress.

## Optional exploration

If the manifest leaves genuine intent unresolved, inspect the current project
context, state the user outcome and forbidden outcomes, and offer a small set
of meaningful alternatives. Keep the explanation focused on the decision that
lacks authority. When the manifest already resolves the intent, skip this
exploration and continue to the public acceptance boundary.

Artifacts are optional and host-owned. This skill does not create project
design documents, planning files, commits, or review obligations as a side
effect of brainstorming. If the caller explicitly requests a durable artifact,
the host decides whether and where to create it.
