# SARK → prime-agent: Concepts, Gap Analysis, What Not to Import

Read this doc when you need the *why* behind the retained-tools design: what SARK actually ships, how its concepts map onto prime-agent, and which SARK ideas were deliberately not imported. For the design itself, start at [retained-tools.md](../retained-tools.md).

## What SARK is

SARK ("Strategic and Adaptive Resourceful Kernel") is a Java 21 / Maven / Spring Boot 3.4.5 framework for AI-agent development. Eight Maven modules; all depend on `sark-commons` (core interfaces: tools, workflow, llm, config, auth, error, notification, validation). Key modules:

- `sark-commons` — core interfaces/models (incl. `CompositeTool` representation)
- `sark-agentic-workflow` — LLM-driven workflow engine (`DefaultWorkflowEngine`, the implemented `apilearning` package, prompt templates)
- `sark-command-service` — tool registry, command execution, semantic (vector) tool discovery, usage tracking, composite-tool execution
- `sark-reporting`, `sark-api-gateway`, `sark-mcp-integration`, `sark-cli`, `sark-migration`

Runs standalone (single JVM) or distributed (API gateway).

## SARK's self-extending mechanism (what the user meant by "SARK")

The core requirement is **REQ-AGENTIC-WORKFLOW-701** (`doc/requirements/AGENTIC_WORKFLOW.md` §8): "The system shall identify and register successful combinations of tools used to solve specific problems as composite tools." — i.e. *retain solved tasks as new tools*. What SARK actually ships around it:

- **CompositeTool representation (implemented):** `sark-commons/.../tools/composite/CompositeTool.java` — a `Tool` subclass (`@JsonTypeName("composite")`): `steps` (`CompositeStep{toolName, parameters with ${var.prop} substitution, outputVariable, dependsOn (DAG), condition, errorHandling (FAIL_FAST/CONTINUE/RETRY/COMPENSATE), maxRetries, timeoutMs}`), `executionMode` (SEQUENTIAL/PARALLEL/CONDITIONAL), `sharedContext`, `finalResultExpression`. A retained tool is a **declarative JSON schema, not code**, and a first-class registry citizen (`ToolType.COMPOSITE`).
- **Persistence (implemented, REQ-705):** `FileBasedToolRepository` — JSON files under `./data/tools/`, automatic backups (60-min interval, keep 10), rotation.
- **Indexing + semantic discovery (implemented, DISC-1):** `HnswlibVectorStorage` + `SentenceTransformerEmbeddingService` (DJL, `sentence-transformers/all-mpnet-base-v2`) + `ToolVectorProcessor`; `DefaultToolDiscoveryService.findToolsBySimilarity` (cosine + threshold) and `recommendToolsForTask`.
- **Fuzzy tool-name recovery (implemented):** `DefaultWorkflowEngine.findToolByFlexibleMatching` — when the LLM emits a malformed tool name, semantic top-5 candidates are offered.
- **Dynamic selection scoring (WF-4, implemented):** keyword match + usage stats + success rate + domain relevance (DECISION_LOG 2025-05-16).
- **Quality gates (implemented, REQ-702/703/704):** `ToolUsageService` tracks invocations/success/failure/execution time; flag tools with 10+ calls and <90% success; auto-disable at 10+ calls and <50% success until manual review.
- **Result storage (implemented, TOOL-8):** `FileBasedToolResultRepository` captures every execution (parameters, output, status, duration, workflowId).
- **Execution (partially implemented):** `DefaultCompositeToolExecutor` — sequential/parallel/conditional execution, variable substitution, cycle detection, async execution, error-handling modes. **Sandboxing is not implemented** (SEC-3 🗲 TODO in `TASK_LIST.md`).
- **API Learning Workflow (implemented, API-LEARN-1):** `apilearning/` package (~19 files) — capability-gap detection → OpenAPI/MCP/web endpoint discovery → relevance scoring → endpoint→tool registration → feedback loop back into the capability mapping. User confirmation before learning (REQ-API-LEARN-205).

### Docs-vs-reality caveat (imported lesson)

Two verified facts that shaped this design:

1. **REQ-701 auto-detection was never implemented in SARK.** Unlike REQ-702…705, it has no "COMPLETED" status line; composite-tool creation today is manual via `CompositeToolController` (REST POST). The framing "SARK retains solutions as new tools" overstates SARK's shipped state: it ships the *representation, persistence, retrieval, tracking, and quality infrastructure*, a manual creation path, and a separate implemented API-learning loop — not the detection loop.
2. SARK's `TASK_LIST.md` carries a 2025-08-05 "CRITICAL EMERGENCY" section (CLI tool execution pipeline broken for end users, `bug-report-20250805_162748.json`) alongside "ALL TESTS PASSING" claims.

Design consequences applied throughout: (a) the auto-detection loop is scoped as prime-agent's **own new build** (phase F) with observable acceptance criteria, not a "port"; (b) **every phase's done criteria include a fresh-session end-user invocation** of the retained tool — passing tests are necessary but not sufficient.

## Evidence base

- SARK repo (local checkout, paths verified): `/Users/brobert/Documents/code/SARK` — key files: `sark-commons/.../tools/composite/CompositeTool.java`, `sark-command-service/.../api/CompositeToolController.java`, `sark-command-service/.../repository/FileBasedToolRepository.java`, `sark-command-service/.../service/vector/{HnswlibVectorStorage,SentenceTransformerEmbeddingService}.java`, `sark-command-service/.../service/DefaultToolDiscoveryService.java`, `sark-command-service/.../tracking/service/ToolUsageService.java`, `sark-command-service/.../service/DefaultCompositeToolExecutor.java`, `sark-agentic-workflow/.../agentic/workflow/apilearning/`, `doc/requirements/AGENTIC_WORKFLOW.md` §8, `doc/design/command/SEMANTIC_TOOL_DISCOVERY_DESIGN.md`, `doc/design/command/COMPOSITE_TOOL_DESIGN.md`, `doc/design/workflow/API_LEARNING_WORKFLOW.md`, `TASK_LIST.md`.
- Analyst report + key findings recovered from the 2026-08-20 deep-dive session (Obsidian vault: `Work/SARK Prime/`, working artifacts `/tmp/agents/sark-prime-agent-ideas/iteration-1/`).
- prime-agent side: this repo's source tree (all "prime-agent has X" claims are file-citable below) plus live state under `~/.prime/agent/` at design time.

## Concept map (17 rows)

Legend: **exists** = prime-agent already has an equivalent; **partial** = substrate exists, capability incomplete; **missing** = no counterpart. SARK status reflects the docs-vs-reality check (a COMPLETED marker in SARK docs is treated as a claim, verified where the path was directly checked).

| # | SARK concept (evidence) | SARK status | prime-agent counterpart (repo source paths) | prime-agent status |
|---|---|---|---|---|
| 1 | Retained tool as **CompositeTool**: declarative JSON DAG of steps with variable substitution, conditions, error handling, cycle detection (see above) | implemented (representation) | Skill = `SKILL.md` dir (markdown) or markdown+Python package (`packages/coding-agent/src/core/skills.ts`: `SkillKind = "markdown" \| "python"`, `packages/coding-agent/skills/skill-creator/SKILL.md`). Harness `skill` entry = declarative call contract `{reference:{type:"python",import,callable}, arguments}` (`packages/coding-agent/src/core/refinement/refinement.ts`: `validateEdit`; `prime-agent-runtime/src/rlm/harness.py`) | **partial** — the *spec* layer (harness entries) and the *artifact* layer (skills on disk) exist; there is no spec→artifact pipeline and no retained composition semantics |
| 2 | Auto-register successful tool combinations (REQ-701) | **designed, NOT implemented** (manual REST creation only) | Auto-refine review gate: `refinement.ts`: `reviewAutoRefine`, `AutoRefineReason = "turn_interval" \| "compact"`, fires from `packages/coding-agent/src/core/agent-session.ts`, can propose harness edits | **missing** (both sides) — prime-agent's closest primitive targets knowledge entries, never executable tools |
| 3 | RAG-style semantic tool discovery: HNSW + sentence-transformer embeddings, cosine + threshold, top-k | implemented (DISC-1) | None. All visible skill name+description pairs are injected unranked: `formatSkillsForPrompt` in `packages/coding-agent/src/core/skills.ts` (`<available_skills>` XML block); no embedding/vector library in `package.json` | **missing** |
| 4 | Fuzzy matching of malformed LLM tool names (semantic top-5) | implemented | None (`/skill:<name>` resolution and Python imports are exact-name) | **missing** |
| 5 | Dynamic tool selection scoring WF-4 (keywords + usage + success rate + domain) | implemented | None — selection is description-reading by the LLM over the full injected list | **missing** |
| 6 | Tool usage tracking (REQ-702, `ToolUsageService`) | implemented (INT-3.6) | Session-level only: `packages/coding-agent/src/core/session-stats.ts` (`toolCalls`, `toolResults`) — no per-tool breakdown. Raw material exists in session JSONL transcripts | **partial** |
| 7 | Reliability monitoring (REQ-703) + auto-disable (REQ-704): 10+ calls, <90% flag, <50% disable | implemented (INT-3.6) | None (no per-tool data; frontmatter has static author-set `disable-model-invocation` only) | **missing** |
| 8 | Tool result storage (per-execution record) | implemented (TOOL-8) | Every tool call + result is in the session JSONL transcript (per-session, `packages/coding-agent/src/core/session-manager.ts` resolves the `session-artifacts` dir; see `packages/coding-agent/docs/session-format.md`); `packages/coding-agent/src/core/agent-traces.ts` | **exists** (different shape: transcript, not a per-tool indexed store) |
| 9 | Persistence with backup/rotation (`FileBasedToolRepository`) | implemented (PERS-1/2) | Skills live in real directories the user already versions (`packages/coding-agent/docs/skills.md` "Locations"); harness entries have `version`/`created_at`/`updated_at` + refinement history with rollback (`refinement.ts`, `~/.prime/agent/harness/refinements.jsonl`) | **partial** — harness has versioning+rollback; disk skills have none (skill-creator overwrites in place) |
| 10 | API Learning Workflow (gap → discovery → scoring → registration → feedback) | implemented (API-LEARN-1) | MCP: `packages/coding-agent/src/core/mcp/mcp-manager.ts` registers *user-declared* servers from settings; no gap detection, no auto-registration, no feedback loop | **missing** (MCP plumbing exists as seed) |
| 11 | Sandboxing of tool execution (SEC-3) | **NOT implemented** (TASK_LIST.md TODO) | Workers/kernels are separate processes "for lifecycle and failure containment, **not security sandboxes**" (`packages/coding-agent/docs/architecture.md`) | **missing** (both sides) |
| 12 | Adaptive system prompts embedding tool stats | implemented (LLM-4) | System prompt assembled dynamically with skill XML + harness overview (`packages/coding-agent/src/core/system-prompt.ts`, `refinement.ts`); user-defined templates (`packages/coding-agent/docs/prompt-templates.md`) | **partial** (adaptive *assembly* exists; no tool-stats-aware prioritization) |
| 13 | Prompt A/B testing framework | framework implemented | None | **missing** (low value; not imported) |
| 14 | Workflow Marketplace (conceptual, README) | conceptual | Skill distribution is real: packages bundle skills via npm/git (`packages/coding-agent/docs/packages.md`), skill repositories (`packages/coding-agent/docs/skills.md`), settings `packages`/`skills` arrays | **exists** (manual, not market-y) |
| 15 | Tree-based workflow DAG (`WorkflowTask` + `DefaultTaskManager`) | implemented | RLM subagent tree: `packages/coding-agent/src/core/rlm-runtime.ts`, `packages/coding-agent/docs/rlm.md`; goals/heartbeats/cron (`packages/coding-agent/docs/long-running-agents.md`). No declarative task DAG with dependencies/retry policies | **partial** |
| 16 | MCP integration | implemented | `packages/coding-agent/src/core/mcp/mcp-manager.ts` (McpManager, OAuth, `/mcp`) | **exists** |
| 17 | Delegation to specialized roles | n/a | Subagent specs in harness (`kind:"subagent"`) + `rlm()` runtime + `packages/coding-agent/src/core/agent-messages.ts` / `agent-observe.ts` | **exists** |

**Reading of the map.** prime-agent already has the *distribution* story (skills + packages) and a *self-modification* story (refine + harness). SARK's genuinely transferable delta is rows 1–7 and 10: **materialization of solved tasks into executable retained tools, semantic selection, per-tool quality data with gates, and versioned rollback** — all of which prime-agent lacks today.

## Gap analysis

### What prime-agent already covers (no build needed)

- **Skill authoring & installation substrate.** Markdown skills and Python-backed skills (package installed into the persistent kernel venv). Locations, precedence, validation: `packages/coding-agent/docs/skills.md`, `loadSkills` in `packages/coding-agent/src/core/skills.ts`. The loader is **lenient on unknown frontmatter** (warns, does not fail) — the property that makes the additive `metadata.prime-agent` contract migration-safe.
- **Progressive disclosure.** At startup only name+description are injected; the model reads the full `SKILL.md` on demand. This already cuts LLM-over-reliance at the *body* level; SARK-style RAG addresses the *selection* level.
- **Self-modification loop with safety rails.** `/refine` + the `refine` Python skill (`packages/coding-agent/skills/refine/SKILL.md`): an LLM pass emits typed create/update/delete edits over four kinds (`prompt | memory | skill | subagent`), validated by `validateEdit` (base system prompt not editable; skill edits require a Python reference + arguments), applied by `applyRefinementProposal`, recorded in `refinements.jsonl` with before/after snapshots and rollback. Auto-trigger exists (`reviewAutoRefine` at turn intervals and compaction). Two scopes: session-local (`~/.prime/agent/session-artifacts/<id>/harness/harness_state.json`) and global (`~/.prime/agent/harness/harness_state.json`).
- **Declarative "tool spec" layer.** Harness `skill` entries express *what a tool call is* — `reference: {type:"python", import, callable, call_pattern}` + typed `arguments` — enforced in `prime-agent-runtime/src/rlm/harness.py` and mirrored in the refine LLM contract. The gap: specs never become installed, executable, tracked tools.
- **Delegation runtime.** `rlm()` subagents with admission handles, registry, family messaging/observation (`packages/coding-agent/src/core/rlm-runtime.ts`, `agent-messages.ts`, `agent-observe.ts`).
- **External tool ecosystem.** MCP manager for user-declared servers; extension API (`registerTool`, `packages/coding-agent/src/core/extensions/types.ts`).
- **Observability substrate.** Session JSONL transcripts capture every tool call/result; session stats; agent traces.

### What SARK adds that is genuinely new for prime-agent

1. **Semantic/RAG retrieval over the tool catalog** — prime-agent full-injects all visible skill descriptions unranked; no ranking, threshold, top-k, or fuzzy-name recovery. SARK's implemented answer is the pattern to import, scale-simplified (brute-force cosine beats HNSW at skill-count N; see phase D).
2. **Auto-generation of tools from a solved task** — refine creates *knowledge* (notes, memories, specs); a solved task becoming a first-class registered tool has no counterpart on either side *as an implemented loop*. prime-agent's advantage: its "registry" is a file directory the agent can already write (skill-creator is the manual version of this pipeline).
3. **Per-tool usage stats + reliability gates** — no per-tool counters exist; SARK's REQ-702/703/704 give ready-made threshold semantics, adapted to honest signals (markdown skills have no binary outcome).
4. **Tool composition semantics** — prime-agent's "composition" today is the LLM following multi-step markdown, Python code in the kernel, or a subagent tree. The design deliberately does **not** import the full DAG executor (below); the Python-kernel skill already composes capabilities as code.
5. **Execution→capability feedback loop** — prime-agent has the raw outcomes (transcripts, refine events) but no feedback edge into tool selection.
6. **Versioning/rollback for tools-as-artifacts** — prime-agent has this for harness entries only; disk-resident skills have no snapshot/restore.
7. **(Watch item, not core) sandboxing** — both systems lack it; for prime-agent the trust question is sharpened by auto-generated *Python* skills running in the user-permission kernel.

### Where SARK's novelty is thinner than its docs suggest (what NOT to import naively)

- **The core loop was never built** (REQ-701). Treat the auto-detection loop as prime-agent's own new build (phase F) with explicit acceptance criteria — not "porting SARK's loop."
- **CompositeTool is a JSON DAG over *registered* tools, not learned code** — its power is bounded by the primitive registry. In prime-agent the analogous "learned artifact" is better expressed as a Python package skill (code, composable by construction) or a markdown procedure (knowledge), matching the RLM programming model ("compose capabilities as code", `packages/coding-agent/docs/rlm.md`).
- **The HNSW scale justification does not transfer.** HNSW is for vector stores in the tens of thousands (SARK also indexes discovered API endpoints). prime-agent's catalog is dozens-to-hundreds of skills; in-memory cosine over a JSON index is simpler and sufficient. Revisit only if the index exceeds ~10k entries.
- **SARK's quality-gate success/failure is binary** because it executes tools and observes exit status. prime-agent's markdown skills are *instructions*; importing SARK's thresholds verbatim on weak signals would misfire auto-disable — the design uses honest counters instead (phase A/C).
- **Docs-vs-reality lesson** (above): every phase ships with an observable end-user verification step, not just unit tests.
