# Retained Tools (SARK Prime)

> Design reference for the in-flight "SARK Prime" feature effort. Start here, then open only the phase doc for the work you are picking up.

**Status (2026-08-21): designed, decomposed, not implemented.** The design was produced 2026-08-20 (design proposal + SARK analysis + build plan, kept in the user's Obsidian vault under `Work/SARK Prime/`). The 26-task build plan is filed as issues [#1–#26](https://github.com/badvision/prime-agent/issues) on this fork, labeled `sark:retained-tools`, `sark:phase-A` … `sark:phase-G`, plus `sark:critical-path` and `sark:deferred` where applicable. All 26 are open.

## What this effort is

SARK ("Strategic and Adaptive Resourceful Kernel") is an external Java 21 / Spring Boot AI-agent framework. Its genuinely novel, implemented aspects: an agent that **solves tasks and retains those solutions as first-class reusable tools**, with per-tool usage tracking, reliability gates, RAG-style (semantic) selection, and versioned persistence.

This effort imports SARK's transferable delta onto prime-agent's existing substrate — skill loader, refine loop, harness, session transcripts — without porting SARK code. Note: SARK's marquee auto-detection loop (REQ-701, "auto-register successful tool combinations") was **never implemented in SARK**; here it is built natively (phase F) with observable acceptance criteria. Full background, concept map, and the docs-vs-reality caveat: [sark-concepts.md](retained-tools/sark-concepts.md).

## What gets built (five augmentations)

| # | Augmentation | Phase |
|---|---|---|
| 1 | Task→tool retention pipeline: a procedure becomes an ordinary installed skill (markdown first, Python behind smoke + confirmation) with provenance frontmatter | B (explicit), E (refine-driven), F (auto-proposal) |
| 2 | Per-tool usage index + reliability gates (flag <90% / disable <50% at 10+ uses) driven by *explicit* success signals only | A (index), C (gates) |
| 3 | Budgeted hybrid semantic skill retrieval (top-k + always-visible core + fuzzy name matching), replacing unbounded full-injection only above a budget | D |
| 4 | Versioned snapshots + rollback for retained tools (copies the harness-entry rollback pattern) | B |
| 5 | Auto-detection gate on the existing auto-refine checkpoint — the REQ-701 equivalent, default off | F |

**Explicit non-goals:** sandboxing, automatic MCP discovery/registration (phase G, deferred), a composite-DAG executor, prompt A/B testing, auto-applying any Python code, any base-system-prompt change.

## Phases and tracking

| Phase | Deliverable | Size | Depends | Issues |
|---|---|---|---|---|
| A | Tool index + usage tracking (`tools/index.json` both scopes, 4 event sources, atomic saves, rebuild/merge, read-only `/tools list`) | S | — | [#1–#4](https://github.com/badvision/prime-agent/issues/1) |
| B | Explicit retention + versioning: `/retain`, `metadata.prime-agent.retained` frontmatter, materializer, snapshots + `/tools rollback`, provenance, Python smoke | M | A | [#5–#9](https://github.com/badvision/prime-agent/issues/5) |
| C | Reliability gates: flag/disable/archive from honest counters, flagged suffix in prompt, `/tools re-enable`, refine usage table | S | A (+ B for the refine-edit path) | [#10–#13](https://github.com/badvision/prime-agent/issues/10) |
| D | Semantic retrieval: embeddings (or BM25), budgeted hybrid prompt assembly, top-k, always-visible core, fuzzy name matcher, `skillRetrieval` settings | L | A | [#14–#18](https://github.com/badvision/prime-agent/issues/14) |
| E | Refine-driven retention: materialize edits in the refine LLM contract, apply path, confirmation flow | M | B | [#19–#21](https://github.com/badvision/prime-agent/issues/19) |
| F | Auto-detection gate: procedure signatures, recurrence signals, `autoRetain` setting, retention review prompt, proposal flow | M | B, C, E | [#22–#24](https://github.com/badvision/prime-agent/issues/22) |
| G | API-learning analog (capability gap → MCP discovery → registration) — **deferred placeholders** | XL | D + existing McpManager | [#25–#26](https://github.com/badvision/prime-agent/issues/25) |

**Build order:** A → B → (C ∥ D) → E → F. G is deferred; re-plan before starting. **Critical path (9 tasks):** #1 → #2 → #5 → #6 → #7 → #8 → #20 → #21 → #24. Every issue depends only on earlier issue numbers — work the list top-to-bottom.

Execution conventions (task shape, "Done when" contract, flags, ADRs): [build-plan.md](retained-tools/build-plan.md). The GitHub issues are the *live* spec; these docs are the reference copy.

## Global invariants (do not bend without updating these docs)

- A retained tool is an **ordinary skill directory** (markdown or python skill) plus additive `metadata.prime-agent.retained` frontmatter. It is not a new artifact type.
- Three layers, one canonical source: **artifact dir** (canonical) → **derived JSON index** per scope (`~/.prime/agent/tools/index.json`, `.prime/agent/tools/index.json`; rebuildable from disk at any time; usage counters are the only index-only state) → **harness `skill` entries** reference by `id` only, never duplicate tool content.
- Reliability gates run on **explicit success signals only**; session-level success never counts as tool success. `disabled` never auto-re-enables (manual review, mirroring SARK REQ-704).
- Skill prompt injection stays **byte-identical to today's full-injection output** below the retrieval budget; hybrid top-k injection applies only above it.
- **Python materialization never auto-applies**: explicit confirmation + scratch-venv smoke in every mode. Auto-retention defaults are markdown-only; the auto-detection gate only *proposes*, never applies.
- The skill loader is **deliberately lenient** about unknown frontmatter — do not "fix" that leniency; it is what makes the additive contract migration-safe.
- **"Tests pass" is not acceptance.** Every phase's done criteria include a fresh-session end-user invocation of the retained tool (imported SARK docs-vs-reality lesson).

## Open decisions

| # | Decision | Blocks | Default assumption |
|---|---|---|---|
| Q1 | Where project-scope retained tools live | #7 | `.prime/agent/skills/` (git-shareable) |
| Q2 | Usage counter scoping | #3 | Per-scope index, global view in `/tools` |
| Q3 | Do subagent specs get retained-treatment? | — (out of scope) | No decision yet; flagged only |
| Q4 | Embedding vendor: local ONNX (recommended) / hosted / BM25-only | #15 (full form) | Local ONNX sentence-transformer; BM25 is the designed-in contingency |
| Q5 | Confirmation UX for materialize edits | #21 | TUI approve/reject dialog |

Required ADRs: **ADR-1** layering (recorded in #1), **ADR-2** embedding vendor (in #15), **ADR-3** auto-retention trust policy (in #23). Details: [risks-and-decisions.md](retained-tools/risks-and-decisions.md).

## Reading guide

| If you are… | Read |
|---|---|
| Picking up a `sark:` issue | This page, then the matching `retained-tools/phase-*.md` doc (phase design + task specs), then the issue body (live "Done when") |
| Asking *why* a design decision exists | [retained-tools/sark-concepts.md](retained-tools/sark-concepts.md) (SARK background, 17-row concept map, gap analysis, what not to import) |
| Planning work order, parallelism, or ADRs | [retained-tools/build-plan.md](retained-tools/build-plan.md) |
| Hitting a risk, an open decision, or writing acceptance tests | [retained-tools/risks-and-decisions.md](retained-tools/risks-and-decisions.md) |

Phase docs: [A](retained-tools/phase-a-index.md) · [B](retained-tools/phase-b-retention.md) · [C](retained-tools/phase-c-gates.md) · [D](retained-tools/phase-d-retrieval.md) · [E](retained-tools/phase-e-refine-retention.md) · [F](retained-tools/phase-f-autodetection.md) · [G](retained-tools/phase-g-api-learning.md)

## Notes for implementers (from the design retrospective)

- The phase B materializer and the phase A honest-signal counters contain the load-bearing decisions; everything else is additive.
- The layering rule (canonical / derived / reference) is the defense against two-sources-of-truth divergence. Any new state must answer: canonical, derived, or reference?
- The Python half of phase B (scratch-venv smoke) is predicted to grow; if it grows, split it — do not let it swallow markdown-path work.
- If hybrid retrieval underperforms the keyword fallback on the regression suite, ship BM25-only and re-open embeddings (see risks).

## Provenance

- Source design documents ("Retained Tools Design Proposal", "SARK Retained-Tools Analysis", "SARK Retained-Tools Build Plan", 2026-08-20) live in the user's Obsidian vault: `Work/SARK Prime/` (vault root `~/OneDrive-Personal/Documents/KB/Personal KB`).
- SARK evidence base: local checkout `/Users/brobert/Documents/code/SARK`; Java paths cited in [sark-concepts.md](retained-tools/sark-concepts.md) were verified there.
- The design was verified against prime-agent v0.7.4; source citations in these docs refer to this repo's tree (`packages/coding-agent/src/…`).
