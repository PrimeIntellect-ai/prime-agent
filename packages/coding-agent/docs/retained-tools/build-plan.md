# SARK Retained-Tools Build Plan (execution reference)

> **The GitHub issues are the live spec.** This fork tracks the full decomposition as issues [#1–#26](https://github.com/badvision/prime-agent/issues/1) (labels: `sark:retained-tools`, `sark:phase-A`…`sark:phase-G`, `sark:critical-path`, `sark:deferred`), each carrying the task brief and a concrete "Done when" checklist. The per-task specs below live in the phase docs; this page holds the execution conventions, order, and cross-task facts.

## How to read the plan

- **Task shape.** One task = one atomic concept + one session. If a task needs a second paragraph to explain, it is too big — re-plan it before starting.
- **Verification convention.** Every task's "Done when" is a concrete, quickly checkable outcome: a named test passes, a command produces specific output, or an observable behavior holds in a fresh session. A bare "tests pass" never qualifies — the SARK docs-vs-reality lesson (passing test suites coexisted with a broken user-facing pipeline) means end-user-visible checks are required where the design calls for them.
- **Dependency rule.** "Depends on" lists task IDs (or issue numbers) that must be *complete* before the task starts. The list is topologically sorted: every task appears after all of its dependencies, and no task depends on an unshipped piece of another task.
- **Component order.** Components are grouped by theme and ordered by dependency: a component that other components need comes first. Where the design allows it, parallel opportunities are called out below.
- **Flags.** `OPEN DECISION` = the design leaves a human decision open (Q1–Q5); the task states its default assumption. `ASSUMPTION` = a choice the plan makes where the design is silent. `RISK` = a known-risk note.
- **Stable IDs.** Task IDs (T01…) are stable references; renumbering is a planning error. Task ID ↔ issue number mapping is T01↔#1 … T26↔#26.

## Components and task index

| Component (phase) | Size | Tasks | Phase doc |
|---|---|---|---|
| 1. Tool index & usage tracking (A) | S | T01–T04 (#[1]–[#4](https://github.com/badvision/prime-agent/issues/1)) | [phase-a-index.md](phase-a-index.md) |
| 2. Explicit retention & versioning (B) | M | T05–T09 (#[5]–[#9](https://github.com/badvision/prime-agent/issues/5)) | [phase-b-retention.md](phase-b-retention.md) |
| 3. Reliability gates (C) | S | T10–T13 (#[10]–[#13](https://github.com/badvision/prime-agent/issues/10)) | [phase-c-gates.md](phase-c-gates.md) |
| 4. Semantic retrieval (D) | L | T14–T18 (#[14]–[#18](https://github.com/badvision/prime-agent/issues/14)) | [phase-d-retrieval.md](phase-d-retrieval.md) |
| 5. Refine-driven retention (E) | M | T19–T21 (#[19]–[#21](https://github.com/badvision/prime-agent/issues/19)) | [phase-e](phase-e-refine-retention.md) |
| 6. Auto-detection gate (F) | M | T22–T24 (#[22]–[#24](https://github.com/badvision/prime-agent/issues/22)) | [phase-f-autodetection.md](phase-f-autodetection.md) |
| 7. API-learning analog (G) | XL (deferred) | T25–T26 (#[25]–[#26](https://github.com/badvision/prime-agent/issues/25)) — placeholders, re-plan on activation | [phase-g-api-learning.md](phase-g-api-learning.md) |

**Total:** 24 core tasks across 6 components + 2 deferred placeholders.

## Build order

A → B → then C and D in any order (C's core tasks can even run in parallel with B, since T10–T12 need only components 1–2) → E → F. G stays deferred.

**Critical path (longest dependency chain, 9 tasks):** #1 → #2 → #5 → #6 → #7 → #8 → #20 → #21 → #24.

**Dependency overview:** A is a linear chain (T01→T02→T03→T04). B chains off A (T05→T06→T07→T08→T09, with T09 also needing T04). C reuses A's counters and B's status contract (T10→T11, T12→T13). D reuses only A (T14→T15→T16→T18, T15→T17→T18). E reuses B's materializer (T19→T20→T21). F reuses A, C, and E (T22→T23→T24).

**Parallel work streams.** D is fully independent of B/C after A (separate module, separate settings key) — two engineers/agents could run A→(B ∥ D) with C, E, F following the chain.

## Open decisions

| # | Decision | Blocks | Status |
|---|---|---|---|
| Q1 | Project-scope location for retained tools (`.prime/agent/skills/`, git-shareable, assumed in T07/#7) | #7 | Assumed; confirm with the user |
| Q2 | Counter scoping (per-scope index, global view in `/tools`, assumed in T03/#3) | #3 | Assumed; confirm with the user |
| Q3 | Subagent specs get retained-treatment? | — | Out of scope; design decision needed if revisited |
| Q4 | Embedding vendor (local ONNX recommended / hosted / BM25-only) | #15's full form | **Human decision required before T15**; BM25 is the contingency |
| Q5 | Confirmation UX (TUI dialog vs `/tools approve <id>`) | #21 | Default assumption: TUI dialog |

## ADRs required by the design

- **ADR-1** — canonical/derived layering for the tool registry (canonical skill dir / derived index / referencing harness spec). Recorded in #1 (T01).
- **ADR-2** — embedding vendor (local ONNX vs hosted vs BM25-only). Recorded in #15 (T15).
- **ADR-3** — auto-retention trust policy (markdown-only auto, Python always-confirmed, no sandbox). Recorded in #23 (T23).

## Acceptance-criterion map (design handoff → tasks)

| Criterion | Task / Issue |
|---|---|
| #1: `/retain` produces an active retained tool visible in a fresh session | T07 / #7 |
| #2: smoke-failing Python tool ends `disabled` with the failure recorded | T08 / #8 |
| #3: gate thresholds (active / flagged / disabled) on synthetic counter states | T10 / #10 |
| #4: above-budget prompt = core ∪ top-k ∪ recent; below-budget byte-identical to today | T16 / #16 |
| #5: double-occurrence transcript → exactly one proposal, nothing auto-applied | T23/T24 / #23/#24 |
| #6: `/tools rollback` restores prior snapshot and decrements version | T09 / #9 |

Full criterion text: phase docs and [risks-and-decisions.md](risks-and-decisions.md).

## Non-goals (context, not tasks)

Sandboxing, MCP auto-discovery in the core plan, a DAG/composite executor, A/B testing, and base-prompt changes are explicitly out of scope per the design. The pre-write snapshot hook is an optional enhancement beyond T06's lazy-snapshot approach.
