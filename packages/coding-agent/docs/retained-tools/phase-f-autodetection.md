# Phase F — Auto-Detection Gate (issues [#22]–[#24](https://github.com/badvision/prime-agent/issues/22), size M)

Read this doc when working on #22–#24. The "watcher": repeated procedures in transcripts fire a one-shot retention proposal at the existing refine checkpoints. **Default off; the gate proposes — it never auto-applies executable code.** This is the REQ-701 equivalent (the loop SARK designed but never built; see [sark-concepts.md](sark-concepts.md)). Depends on phases B, C, E.

## Design stance

Build the *detection loop* natively on the auto-refine gate that already exists (`reviewAutoRefine`, `AutoRefineReason: "turn_interval" | "compact"` in `packages/coding-agent/src/core/refinement/refinement.ts`), extended with a `"retention"` reason value. No new scheduler: the gate fires from the existing turn-interval/compact checkpoints.

## Signals (heuristic, all computed from existing state)

A retention candidate fires when **any** of:

- **Intra-session recurrence:** the same normalized procedure signature appears ≥2 times in one session transcript.
- **Cross-session recurrence:** the same signature (via the phase A index) appears in ≥2 different sessions within a scope.
- **Endorsed completion:** a goal completed successfully (`packages/coding-agent/src/core/goals.ts`) whose trajectory matches a signature not yet a skill, **AND** the user explicitly endorsed the result in a following turn.

**Procedure signature (honest simplification, #22):** an ordered bag of (tool/skill names touched + coarse command/file patterns), hashed from the session JSONL (which already records every tool call, `packages/coding-agent/docs/session-format.md`), with a per-session signature record stored alongside the usage index so cross-session recurrence can be checked. This is a *recurrence detector*, not SARK's symbolic DAG: it finds "the agent did the same 6-step dance again", not "which combination graph was optimal". It is a heuristic with a known false-positive surface (two different tasks sharing a tool sequence) — which is why the gate only *proposes*.

The gate checks current tool status (phase C) so it never re-proposes a procedure already flagged or disabled.

## Proposal flow (#24)

Gate → `AutoRefineReview.shouldRefine = true` with a `retain:` instruction → the normal refine LLM pass (phase E) drafts the skill from the trajectory (this is where "solved task → tool content" synthesis happens) → **confirmation** before apply (phase E confirmation flow). The refine review system prompt (`AUTO_REFINE_REVIEW_SYSTEM_PROMPT`) is extended with the retention criteria plus signature input.

**Trust policy (ADR-3, recorded in #23):** confirmation happens before apply; markdown auto-apply only in `"markdown"` mode; Python always confirmed; bundled skills and one-shot sessions never propose.

## `autoRetain` setting

`"off" | "propose" | "markdown"`, **default `"off"`** (so phases A–E are unaffected). `"propose"` recommended once E is stable; `"markdown"` allows auto-apply of markdown-only retains (Python still gated). **Executable (Python) materialization never auto-applies in any mode without explicit confirmation** — the process separation is not a security boundary (`packages/coding-agent/docs/architecture.md`); sandboxing is a prerequisite for any unattended code-application mode and is out of scope.

## Integration points

- `packages/coding-agent/src/core/agent-session.ts` — new auto-refine reason value `"retention"`, fired from the existing checkpoints
- `packages/coding-agent/src/core/refinement/refinement.ts` — `AutoRefineReason` extension, `AUTO_REFINE_REVIEW_SYSTEM_PROMPT` extension
- `packages/coding-agent/src/core/retrieval/` (or a shared helper) — signature computation, shared with the usage index
- `packages/coding-agent/src/core/settings-manager.ts` — `autoRetain` setting

## Tasks

| Task | Issue | Brief | Done when | Depends |
|---|---|---|---|---|
| T22 Procedure signature computation | [#22](https://github.com/badvision/prime-agent/issues/22) | Ordered bag of (tool/skill names + coarse command/file patterns) hashed from the session JSONL; per-session signature record alongside the usage index | Two transcripts of the same 5-step procedure produce the same signature; one with a single changed step produces a different one | T02 |
| T23 Recurrence signals + retention gate firing | [#23](https://github.com/badvision/prime-agent/issues/23) | The three firing signals; `AutoRefineReason` extended with `"retention"`; fires from existing checkpoints; `autoRetain` setting; gate checks tool status; record ADR-3 | A synthetic transcript with the same 5-step procedure twice fires exactly one proposal at a checkpoint; a single occurrence fires none; `autoRetain: "off"` produces no refine behavior change (regression test); ADR-3 recorded | T10, T22 |
| T24 Retention review prompt + proposal flow | [#24](https://github.com/badvision/prime-agent/issues/24) | Review-prompt extension (retention criteria + signature input); gate hits route through `shouldRefine` with a `retain:` instruction; confirmation before apply; bundled skills and one-shot sessions never propose | In `autoRetain: "propose"`, a synthetic recurrence takes the exact-one-proposal path to the confirmation UI with no auto-apply; in `"markdown"` mode a markdown retain auto-applies while a Python one is held; a bundled skill's trajectory produces no proposal | T21, T23 |

## Acceptance criterion (design #5 → T23/T24)

Given a transcript containing the same procedure signature twice in one session, when `autoRetain: "propose"` and the retention checkpoint fires, then exactly one proposal is created and nothing is applied without confirmation; with a single occurrence, no proposal is created.
