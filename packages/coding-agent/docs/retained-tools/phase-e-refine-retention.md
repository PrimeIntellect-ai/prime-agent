# Phase E — Refine-Driven Retention (issues [#19]–[#21](https://github.com/badvision/prime-agent/issues/19), size M)

Read this doc when working on #19–#21. The continual-harness loop creating retained tools **without a human typing `/retain`**: refine proposals gain an optional materialize field, the apply path reuses phase B's materializer, and confirmation respects the trust level (markdown may auto-apply; Python never does). Depends on phase B (#5–#9, the materializer).

## Refine LLM contract extension (#19)

Extend the refine proposal contract (`REFINEMENT_SYSTEM_PROMPT` in `packages/coding-agent/src/core/refinement/refinement.ts`) with an **optional** field on `kind: "skill"` edits:

```json
"metadata": { "retain": { "materialize": true, "location": "project|global", "kind": "markdown|python", "smoke": ["..."] } }
```

Validation stays strict and fail-closed (`validateEdit` style); the field is additive so older code paths ignore it. (Mitigates design risk 8, refine-contract growth: optional, ignored when absent.)

## Materialize apply path (#20)

Extend the refine apply path (`applyRefinementProposal`) with the materializer step, reusing the phase B materializer:

1. Write the skill dir (skill-creator contract + retained frontmatter).
2. Take the pre-change snapshot (phase B store).
3. For Python skills: install into the scratch venv and run `smoke`.
4. Upsert the index entry.
5. Record a normal refinement event so the standard rollback restores the snapshot and removes the index entry.

An applied materialize edit produces a retained tool **identical in shape** to a `/retain` one (frontmatter, index entry, snapshot). A smoke-failing Python materialize ends `disabled` with the event recorded; rolling back the refinement restores the pre-materialize state.

## Confirmation flow + user-visible result (#21)

Per trust level:

- **Markdown** materialize edits: auto-apply with a user-visible result message (the existing "Refined continual harness state: N edits applied" path names the new tool).
- **Python** materialize edits: held for explicit approve/reject.
- **Rejecting** a pending edit leaves no tool behind (or rolls back the snapshot if one was taken) — no installed package, no index entry.

> **OPEN DECISION (Q5):** the exact affordance — a TUI dialog or a `/tools approve <id>` command. Default assumption: TUI dialog. This sets the interaction cost of every auto-retention; make it a deliberate choice, not an accident.

## Integration points

- `packages/coding-agent/src/core/refinement/refinement.ts` — LLM contract + `validateEdit` + apply path
- `packages/coding-agent/src/core/agent-session.ts` — result messaging, approval plumbing
- `packages/coding-agent/src/core/extensions/types.ts` — extension UI dialog support exists for the approve/reject affordance

## Tasks

| Task | Issue | Brief | Done when | Depends |
|---|---|---|---|---|
| T19 Refine LLM contract extension (materialize edits) | [#19](https://github.com/badvision/prime-agent/issues/19) | Optional `metadata.retain` field on `kind:"skill"` edits; strict fail-closed validation; additive | A well-formed materialize field passes validation; a malformed one is rejected; a proposal without the field behaves exactly as today | T05 |
| T20 Materialize apply path | [#20](https://github.com/badvision/prime-agent/issues/20) | Apply path reuses the phase B materializer (write, snapshot, smoke, index upsert, refinement event) | An applied materialize edit produces a retained tool identical in shape to a `/retain` one; a smoke-failing Python materialize ends `disabled` with the event recorded; rolling back restores the pre-materialize state; refine-pass latency with a materialize edit is measured and recorded | T07, T08, T19 |
| T21 Confirmation flow + user-visible result | [#21](https://github.com/badvision/prime-agent/issues/21) | Confirmation UX per trust level (markdown auto-apply; Python held); reject leaves no residue | A Python materialize edit is not applied until explicit approve; a markdown materialize edit is applied and the result message names the new tool; rejecting a Python edit leaves no installed package and no index entry | T20 |
