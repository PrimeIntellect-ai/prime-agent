# Risks, Open Decisions & Validation Requirements

Read this doc when a risk or open decision touches your task, or when writing phase acceptance tests. Design status: **ARCHITECTURAL HYPOTHESIS — not validated by implementation.** Effort sizes are t-shirt complexity (XXS…L), not time estimates.

## Risks (8, with mitigations)

1. **Context bloat from retained tools.** Every retained skill adds a description line to the prompt; unbounded retention turns the fix (pre-fabricated tooling) into a new context tax. *Mitigations (designed-in, not aspirative):* budgeted hybrid injection with an `archived` tier (phase D / phase C); retention proposals must justify reuse (refine rationale field, existing); a periodic "tool hygiene" refine instruction (prune/disable/archive stale tools — the refine loop is the natural place; SARK had no equivalent, this is a deliberate departure); the full-injection budget defaults high enough that current users see no change.
2. **Trust/verification of auto-generated tools.** An auto-retained *Python* skill is LLM-written code that re-executes in a kernel with the user's full OS permissions — and prime-agent's process separation is explicitly **not** a security boundary (`packages/coding-agent/docs/architecture.md`: "not security sandboxes"). SARK shipped no sandbox either (SEC-3 TODO). *Mitigations:* auto-retention is markdown-only in all default modes; Python materialization always requires explicit confirmation + scratch-venv smoke pass (phases B/E); flagged/disabled states + version snapshots give a recovery path (phase B); **long-term**: sandbox or permission-scoped execution for retained Python tools is a prerequisite for any `autoRetain` mode that applies code unattended — treat as a human decision if ever requested.
3. **SARK's docs-vs-reality caveat (imported lesson).** SARK's "ALL TESTS PASSING" coexisted with a CRITICAL EMERGENCY (CLI pipeline broken for end users), and its marquee REQ-701 loop was never built. *Design consequences already applied:* status claims verified against code where paths were checkable; every phase's acceptance criteria include a fresh-session end-user invocation of a retained tool; the auto-detection loop is scoped as prime-agent's own new build with observable criteria rather than "ported from SARK." *Residual risk:* the same failure mode can happen here — retain a tool whose smoke pass passes but whose real use fails; the honest-signal counters (phase A/C) are the designed detection path for that.
4. **Weak success signals for instruction-style skills.** Auto-disable thresholds tuned for binary tool outcomes misfire on markdown procedures. *Mitigation:* gates apply only to explicit signals (phase A honest-signal rule); Python skills may additionally use kernel error rates. *Watch item:* if explicit signals stay rare in practice, flag/disable will rarely fire and the index's value degrades to usage recency — acceptable, but review after phase C.
5. **Two sources of truth.** Skill files vs. index vs. harness spec entries can diverge. *Mitigation:* canonical/derived/reference layering (phase A doc, ADR-1); index rebuild from disk; harness entries reference by id; `description_hash` detects drift at load.
6. **Skill name collisions.** The loader is first-found-wins with precedence (`packages/coding-agent/docs/skills.md`); a project-retained tool can silently shadow a global one (or vice versa). *Mitigation:* the materializer checks for an existing same-named skill across scopes and warns/blocks; the index stores per-scope entries; `/tools list` shows scope.
7. **Embedding dependency risk (phase D).** ONNX native module or hosted-API key = new infrastructure. *Mitigation:* BM25 contingency with identical pipeline shape; phase D is the only phase gated on this decision (Q4).
8. **Refine-contract growth.** Adding materialize edits to the refine LLM contract enlarges its prompt and output surface; refine is already the most LLM-heavy subsystem. *Mitigation:* materialize fields are optional and ignored by older code paths (additive JSON); validation is strict `validateEdit`-style (fail closed).

## Open questions (human/orchestrator input)

- **Q1 — Sharing scope of project retained tools:** should project-scope retained tools live in `.prime/agent/skills/` (git-shareable, recommended) — and if a team wants them shared, is the existing package mechanism (`packages/coding-agent/docs/packages.md`) sufficient, or is a "skill gallery" wanted? (Phase G territory.) Assumed in #7.
- **Q2 — Usage stats scoping:** are usage counters global-per-name or strictly per-scope? Design says per-scope index with global view; confirm (affects multi-project users). Assumed in #3.
- **Q3 — Subagent specs:** should `kind:"subagent"` harness entries get the same retained-treatment (usage, gates, versioning)? They are declared specs, not artifacts, so this needs a design decision — flagged, not included.
- **Q4 — Embedding vendor decision** (Option A local ONNX vs B hosted vs BM25-only): required before phase D's #15 starts (STOP escalation, new infrastructure).
- **Q5 — Confirmation UX:** approve/reject as TUI dialog vs plain-text result message with `/tools approve <id>` — implementation detail, but it sets the interaction cost of every auto-retention and should be a deliberate choice, not an accident.

## Validation requirements

**REQUIRES VALIDATION THROUGH IMPLEMENTATION.** The six acceptance criteria (mapped in [build-plan.md](build-plan.md)) are the validation gates. Additionally:

- Prompt-token impact of the ranked list must be **measured (not estimated)** in phase D (#18).
- Refine pass latency with materialize edits must be **measured** in phase E (#20) — the LLM pass already "can take many seconds" per `refinement.ts` comments.
- End-user verification per phase B: the proposing session (or a fresh subagent) invokes the retained tool once in a fresh session and reports the result before a retention is considered applied.

## Explicit out-of-scope

Sandboxing/permission scoping; automatic MCP endpoint discovery and registration (phase G); declarative composite-DAG executor; prompt A/B testing; auto-application of any Python code; changes to the base system prompt; migration of non-retained skills into the index's versioning.

## Contingency options

- If hybrid retrieval underperforms keyword fallback on the regression suite, ship BM25-only and re-open embeddings.
- If honest-signal counters show <5 explicit signals per month in real use, drop auto-disable (keep flag-only) and re-baseline thresholds on SARK's data.
- If `/retain` materialization proves fiddly, degrade phase B to "retention = refined harness skill *spec* + a one-command install via skill-creator" — spec-first, artifact-second.

## Recorded ADRs

### ADR-1 — Layering: canonical skill dir / derived index / referencing harness spec

**Context.** Retained tools sit on top of three existing surfaces: the skill directories on disk, the per-scope `tools/index.json` registry this phase introduces (phase A), and the continual-harness `skill` entries in `harness_state.json`. Unlayered state across those surfaces is the two-sources-of-truth risk (risk 5 above); any new state the feature introduces must answer: canonical, derived, or reference?

**Decision.** Three layers, one canonical source:

1. **Artifact layer (canonical):** the skill directory on disk; same locations and precedence as today (`packages/coding-agent/docs/skills.md` "Locations"). A retained tool IS a skill; not a new artifact type.
2. **Registry/index layer (derived):** the JSON index per scope. Rebuildable from disk at any time; **usage counters are the only state that lives only in the index**.
3. **Spec layer (reference, not copy):** continual-harness `skill` entries (`harness_state.json`) may reference a retained tool by `id` for routing hints; they never duplicate tool content.

**Consequences.**

- The index can be deleted or corrupted at any time and rebuilt from disk; only the usage counters need a merge to survive (phase A, #2).
- Harness `skill` entries stay thin (`id`-only references) and cannot drift from tool content; drift is detected on the artifact layer via `description_hash` at load.
- Version snapshots (#6) and rollback (#9) operate on the canonical layer and the derived index; reliability status transitions (phase C) operate on the derived index. The spec layer never stores tool content.
- Any future state added by this feature must be classified as canonical, derived, or reference before it ships.
