# Phase D — Semantic (RAG) Retrieval for Skill Selection (issues [#14]–[#18](https://github.com/badvision/prime-agent/issues/14), size L)

Read this doc when working on #14–#18. Budgeted hybrid selection that replaces unbounded full-injection **only when the catalog passes the budget threshold**. Independent code path (`packages/coding-agent/src/core/retrieval/`); shares the phase A index, whose schema v1 already carries the `embedding` field. Can run in parallel with phases B–C.

> **OPEN DECISION (Q4) — must be resolved before #15 (T15):** embedding vendor — (A) local ONNX sentence-transformer (recommended default, ~90 MB CPU model), (B) hosted embeddings via the existing provider stack, or (C) BM25/keyword-only contingency (same pipeline shape, zero new dependencies). **HNSW is explicitly not adopted** (see below).

## Data model

Adds one field per skill in the phase A index: `embedding: number[]` (plus `embedding_model` + `embedding_dim` at index top level). No separate vector store file — the index stays a single JSON per scope; embeddings are the index's only heavy field.

## Retrieval pipeline

1. **Index build** (at skill load: startup, `/reload`, post-retention): text = `name + "\n" + description + "\n" + (metadata tags if present)`; embed; write to the index. **Incremental:** re-embed only entries whose `description_hash` changed (hash already in the phase A model); remove entries for deleted skills; corrupted index → rebuild from disk with counters re-merged.
2. **Prompt assembly** — hybrid with a hard budget, preserving today's behavior as the default:
   - If visible-skill count ≤ `budget.count` (default 25) OR total description tokens ≤ `budget.tokens` (default ~2000): **full injection, exactly today's format** (`formatSkillsForPrompt` in `packages/coding-agent/src/core/skills.ts`). **Zero regression at current scale.**
   - Otherwise: injected set = **always-visible core** (bundled skills the runtime depends on — `refine`, `agent-message`, `agent-observe`, `compact`, `skill-creator` — plus any skill with `metadata.prime-agent.always_in_prompt: true`) ∪ **top-k by cosine** (default k=12) of the retrieval query against the index ∪ **recently used** in this session (usage-index tie-breaker; SARK WF-4's usage-stat factor).
   - Retrieval query = the most recent 1–3 user turns of the current session (cheap, no extra LLM call; re-embed only when the last user turn changes).
   - Output format stays the existing `<available_skills>` XML block, with one added header line stating the list is relevance-ranked and that `/tools list` / `/skill:<name>` reach the full catalog.
   - Invariants: the always-visible core is never dropped; `disable-model-invocation` skills are never injected.
3. **Fuzzy skill-name matching** (SARK `findToolByFlexibleMatching` equivalent; small, high-value): when `/skill:<name>` or a Python import of a known skill module fails on an unknown name, the index returns the nearest neighbor (cosine + token overlap) and the error suggests it: "Did you mean `deploy-staging-canary`?".

## Embedding choice (Q4, human decision required — STOP escalation, new infrastructure)

- **Option A (recommended default): local sentence-transformer via ONNX runtime** (e.g. all-MiniLM-L6-v2 class, ~90 MB, CPU). Rationale: offline/privacy, no key, deterministic; SARK validated the same model family (all-mpnet-base-v2) for exactly this task. Cost: one native dependency in the Node host.
- **Option B: hosted embedding model** through the existing provider stack (`packages/coding-agent/src/core/model-resolver.ts`). Zero new dependencies, but requires a working key for a feature that should work offline.
- **Contingency (no embeddings at all): BM25/keyword scoring** over the same index text. Coarser but dependency-free; the hybrid prompt-assembly logic is identical. If the human declines both A and B, phase D ships BM25-only.
- **HNSW explicitly not adopted.** Catalog size (tens to low thousands) makes in-memory brute-force cosine sub-millisecond; SARK's HNSW solved a larger registry (API endpoints included). Revisit only if index N > ~10k.

## Index lifecycle

Built on load; incremental on `description_hash` change; entries deleted for removed skills; one file per scope (global + project merged at prompt assembly, project entries shadowing same-named global ones — same precedence as skill loading); corrupted index → rebuild from disk.

## Integration points

- New `packages/coding-agent/src/core/retrieval/` module (embed, score, assemble-candidate-set)
- `packages/coding-agent/src/core/system-prompt.ts` (swap candidate set into `formatSkillsForPrompt`)
- `packages/coding-agent/src/core/skills.ts` (load hook → index upsert)
- `packages/coding-agent/src/core/settings-manager.ts` + `packages/coding-agent/docs/settings.md`: new `skillRetrieval: { mode: "full" | "hybrid", budget: {count, tokens}, topK, alwaysVisible: [] }`
- `packages/coding-agent/src/core/slash-commands.ts` (`/tools list` full-catalog view)

## Tasks

| Task | Issue | Brief | Done when | Depends |
|---|---|---|---|---|
| T14 `skillRetrieval` settings + retrieval module skeleton | [#14](https://github.com/badvision/prime-agent/issues/14) | Settings block with documented defaults, wired into prompt assembly; `mode: "full"` reproduces today's behavior | Settings parse with documented defaults; in `mode: "full"` the `<available_skills>` block for the default catalog is **byte-identical** to today's output (the zero-regression invariant) | None |
| T15 Scoring backend + index embedding build | [#15](https://github.com/badvision/prime-agent/issues/15) | `embed(text)` per the Q4 decision; index-build step at skill load; incremental re-embed; record ADR-2 | After load, every indexed skill has an embedding (or BM25 term vector); changing a skill's description re-embeds only that entry (test); a corrupted index rebuilds with counters preserved; ADR-2 recorded | T02, T14 |
| T16 Budgeted hybrid prompt assembly | [#16](https://github.com/badvision/prime-agent/issues/16) | The assembly rule above (below-budget full injection; above-budget core ∪ top-k ∪ recent + ranked-list header) | Acceptance criterion #4 (below) | T03, T14, T15 |
| T17 Fuzzy skill-name matcher | [#17](https://github.com/badvision/prime-agent/issues/17) | Nearest-neighbor "Did you mean X?" on unknown `/skill:<name>` or failed Python import | A typoed invocation (e.g. `/skill:deplo-staging-canry` against a fixed test catalog) names the nearest real skill; the exact-name path is unchanged | T15 |
| T18 Retrieval regression suite + measured token impact | [#18](https://github.com/badvision/prime-agent/issues/18) | Fixed (query, expected-skill-in-top-3) regression suite for the chosen backend; **measure (not estimate)** the prompt-token impact of the ranked list | The regression suite passes on the chosen backend, and a token-impact measurement for the ranked list is recorded in the repo docs | T16, T17 |

## Acceptance criterion (design #4 → T16/#16)

Given a catalog above the injection budget, when the prompt is assembled, then the injected set equals always-visible core ∪ top-k ∪ recently-used, the header states the list is ranked, and the full-injection mode's output for a below-budget catalog is byte-identical to today's.

## Quality gates

- Retrieval regression suite: fixed set of (query, expected-skill-in-top-3) pairs.
- Invariant tests: always-visible core is never dropped; `disable-model-invocation` skills never injected; full-injection mode byte-identical to today's output for the default catalog.
- Migration: additive; default `mode: "hybrid"` degenerates to today's full injection below the budget, so existing prompts are unchanged at current skill counts.
