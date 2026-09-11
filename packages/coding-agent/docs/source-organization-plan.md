# Completing coding-agent source organization

Status: Kevin approved implementation on September 11, 2026, with GPT-Astra delegation, full feature/backward compatibility and extensive Prime Sandbox validation. Audited stack base: `254666f2cfb70b4740ea5b5a67703a34ada44ffc`. The two ownership follow-ups implement the session and kernel/runtime tables below; combined validation is in progress. Later package-wide assignments remain subject to detailed review. This supersedes the older flat, top-level goals/compaction/refinement proposal in ENG-5934; the architecture guide remains the placement rule. The repository-wide [refactoring guide](../../../docs/refactoring.md) records the reusable method.

## What the first stack missed

The five PRs extracted behavior from AgentSession, but left existing parts of the same features in `core/`. The plan did not specify how to finish those migrations or organize the rest of the package. A smaller facade is useful, but it is not completion of the codebase cleanup.

The audited stack base contains 343 TypeScript files. The following table records that baseline, before the ownership completion below. Physical LOC includes comments and blank lines. Assets, JavaScript templates/vendor files, Python runtime, tests, and generated output are outside that count.

| Current location | Direct TypeScript files | Physical LOC in those files | Problem |
| --- | ---: | ---: | --- |
| `src/` | 8 | 5,002 | CLI implementation, configuration and migrations mixed with entry points. |
| `src/core/` | 64 | 28,211 | Session, configuration, authentication, models, resources, process support and presentation have no consistent grouping. |
| `src/session/` | 1 | 277 | Prepared action contracts/factories sit outside their input owner. |
| `src/modes/daemon/` | 30 | 23,349 | Worker lifecycle, public/private protocol, catalog, scheduling and snapshots are flat; two large classes still combine them. |
| `src/modes/interactive/` | 11 | 11,740 | The 10,175-line interactive shell still owns substantial feature behavior. |
| `src/modes/interactive/components/` | 59 | 12,263 | Transcript, editor, authentication, settings and generic UI components share one bucket. |

This is a full path/size inventory and import/export survey, with detailed implementation review of compaction, refinement, kernel/provisioner, runtime/services, input actions, messaging and related lifecycle code. Other destinations below are planning assignments, not claims that every implementation has been fully reviewed or is ready to move.

## Boundary to standardize

1. A session feature owns its contracts, algorithms, state, persistence adapters and cleanup together. Goals stay in `session/goals/`; compaction and refinement follow the same rule. Reading a goal or compaction result from the SDK/UI does not transfer ownership.
2. Independent capabilities have a named home outside session. Python environment setup and process transport work without a session; model catalogs, credentials and package discovery also have independent consumers. Their session-specific selection/bindings remain session-owned.
3. Cross-feature composition is explicit. `session/agent-session.ts` may remain beside feature directories because it composes them. It must not accumulate their state again. `session/runtime/` is reserved for construction, replacement, configuration and owned resource setup/disposal, not queues, turns or arbitrary helpers.
4. A parent directory primarily groups features. Its direct files are entry points, composition, or clearly named contracts spanning those children. A leaf feature directory contains implementation files directly. Add a subdirectory only for a coherent responsibility; neither zero loose files nor a fixed maximum LOC is the goal.
5. Use descriptive filenames within a feature: `controller.ts`, `execution.ts`, `summary.ts`, `persistence.ts`. Avoid repetitive paths such as `compaction/compaction-execution.ts` and vague files such as `shared.ts` that mix contracts with side effects.
6. A feature owns its public contracts even with several consumers. Use lightweight direct imports; do not load runtime barrels for types or introduce a global contracts dumping ground. Kevin explicitly requires backward compatibility for this work: retain thin explicit old-path export facades where needed, with no duplicated implementation, and migrate internal consumers to canonical paths. Keep existing supported package exports intact.
7. Every move includes consumers, tests, assets, build references and documentation. Record remaining exceptions by exact responsibility and workstream; `core/` cannot remain an indefinite destination.

## Proposed package map

Kevin approved the kernel/session-runtime distinction with the implementation request. The map applies the existing session ownership rule. Omitted files under each leaf remain with that feature; this is a boundary map, not a file-per-function prescription. Compatibility facades at legacy paths are documented exceptions and must contain no feature implementation.

```text
src/
  index.ts                  public package exports
  cli.ts                    executable entry point
  postinstall.ts            installation entry point
  sdk/                      public factories and service composition
  cli/                      CLI parsing, commands and startup
  config/                   paths, settings and config migrations
  auth/                     credential storage and login services
  models/                   catalog, resolution and provider policy
  resources/                package discovery, skills and prompt templates
  kernel/                   Python provisioning, transport and snapshots
  tools/                    tool execution adapters
  extensions/               extension API, loading and execution
  mcp/                      MCP integration
  session/
    agent-session.ts        public session composition
    runtime/                construction, replacement and kernel binding
    input/                  admission, action store, queues and recovery
    turns/                  execution, events, retry and continuation order
    goals/                  goal state, contracts and accounting
    autonomy/               autonomous budgets, gates and continuation
    compaction/             controller, execution and summary generation
    refinement/             controller, planning and harness updates
    context/                model-facing messages, projections and prompts
    history/                persisted transcript/tree, paths and leases
    children/               child records, runs, contracts and accounting
    side-questions/         temporary questions over cloned conversation context
    tools/                  session tool selection and shell lifecycle
    extensions/             this session's extension bindings
    models/                 this session's model preferences and selection
  coordination/             agent-family messaging, observation and schedules
  diagnostics/              logs, traces, telemetry and request ledgers
  modes/                    execution/presentation entry points
    daemon/                 worker lifecycle, catalog, protocol and snapshots
    agent-connection/       client connection contracts and implementations
    interactive/            shell, transcript, composer, dialogs and status
    agents-view/            catalog view, selection and rendering
    acp/                    ACP adapter
    rpc/                    RPC adapter
  bun/                      Bun entry adapters
  node/                     Node entry adapters
  utils/                    small domain-independent primitives only
```

Keep `modes/` in this pass: it names the existing application boundary. Its internal feature organization matters more than removing another layer. Do not add generic `core/`, `services/` or `helpers/` layers beneath the new owners.

Some repeated names still represent deliberate capability/integration pairs: `tools/` defines executable tools while `session/tools/` selects them and owns session shell state; `extensions/` implements the extension system while `session/extensions/` binds it to one session; `models/` owns the catalog while `session/models/` owns the selected model. These are explicit exceptions, not permission to split algorithms from controllers arbitrarily. An adapter whose sole responsibility is construction/binding may belong in runtime composition. Stateless feature parsing or policy still belongs with its feature.

## First consolidated stack update

Implemented in one consolidated follow-up PR on the stack, with context and input/child changes in separate reviewable commits. The five existing PRs remain unchanged. Historical paths in this table remain explicit compatibility exports; canonical application consumers use the destinations.

| Current source | Destination/responsibility |
| --- | --- |
| `core/agent-session.ts` | `session/agent-session.ts`; retain public composition and ordering. |
| `core/session-action-store.ts` | Action queue, transitions and tickets to `session/input/action-store.ts`; daemon eviction/passivation policy to the daemon residency owner. Separate these responsibilities before moving. |
| `session/prepared-actions.ts` | `session/input/prepared-actions.ts`; contracts and factories belong to input even when turns/context consume them. |
| `core/prompt-admission.ts` | `session/input/prompt-admission.ts`. |
| `core/compaction/compaction.ts` | Summary preparation/generation to `session/compaction/summary.ts`; shared context token estimation to `session/context/token-estimate.ts`. |
| `core/compaction/branch-summarization.ts` | `session/context/branch-summary.ts`, consumed by branch navigation. |
| `core/compaction/utils.ts` | Purpose-named helpers in `session/context/`: conversation serialization is shared with refinement; file tracking is shared by compaction and branch summarization. |
| `session/compaction/compaction.ts`, `compaction-execution.ts` | `session/compaction/controller.ts`, `execution.ts`. |
| `core/refinement/refinement.ts` | Planning/review, harness state persistence/application, and lightweight contracts/formatting within `session/refinement/`. Split by those responsibilities rather than relocating the entire mixed module. |
| `session/refinement/refinement.ts`, `auto-refinement.ts`, `refinement-execution.ts` | `session/refinement/controller.ts`, `automatic.ts`, `execution.ts`. |
| `core/autonomous.ts`, `session/turns/autonomous-continuation.ts` | `session/autonomy/`; same budget/gate/continuation ownership rule as goals. General turn scheduling stays in turns. |
| `core/rlm-runtime.ts`, `rlm-max-depth.ts` | Child contracts/spawn adapters to children; model search to models; async bash notice adapters to input. No wholesale move of this mixed file into runtime. |
| `core/context-tree.ts`, `messages.ts`, `session-stats.ts`, `usage.ts`, `system-prompt.ts`, `prompts/` | `session/context/`; message, usage and prompt contracts remain lightweight and callable by history, UI and SDK consumers. |

Compaction/refinement functions are not independent just because they can be unit tested: they interpret persisted session entries and operate on session context. Keep the public SDK functions exported from the package root, redirecting them to their owner.

Refinement now separates lightweight outcome formatting from planning. Message conversion imports formatting/contracts directly; planning may consume message conversion without creating the former cycle. Harness persistence retains its shared on-disk contract with Python's `rlm.harness`, including reread-before-apply behavior.

## Kernel and runtime completion

Implemented in the second consolidated follow-up PR. Kernel/runtime and SDK ownership move together. Historical module paths remain explicit compatibility exports, except the executable bootstrap wrapper and the legacy `SessionKernel.build()` adapter described below.

| Current source | Destination/responsibility |
| --- | --- |
| `core/kernel/repl-manager.ts`, `bootstrap.ts`, `boot-gate.ts`, `state-snapshot.ts` | `kernel/`; subprocess/protocol, environment setup, startup concurrency and snapshots. |
| `core/kernel/shared.ts` | Separate `kernel/contracts.ts`, `protocol.ts`, `process-registry.ts`: importing a type must not import global cleanup registration. |
| `core/kernel/bootstrap-cli.ts` | `cli/bootstrap-kernel.ts`; update executable references and runtime path resolution. |
| Provisioner and Python skill bootstrap in `core/tools/ipython.ts` | `kernel/provisioner.ts`, `skill-bootstrap.ts`; keep the tool adapter separate from provisioning. |
| `core/agent-session-runtime.ts`, `agent-session-config.ts` | `session/runtime/runtime.ts`, `config.ts`. |
| `core/agent-session-services.ts`, construction in `core/sdk.ts` | Factories/services in `sdk/`, creation/service contracts in lightweight owner modules. Preserve the runtime's injected `CreateAgentSessionRuntimeFactory`; construction implementations use direct imports, and public re-exports stay outward-facing. Remove the runtime → SDK barrel → runtime cycle without introducing a new concrete factory dependency. |
| `session/kernel/kernel.ts`, `kernel-environment.ts` | `session/runtime/kernel-lifecycle.ts`, `kernel-environment.ts`. |
| `session/kernel/kernel-host-handlers.ts` | `session/runtime/host-bridge.ts`; composition only. |
| Session kernel message/observe/heartbeat request handlers | Respective coordination features' request adapters; host bridge supplies current session operations. |

The canonical kernel lifecycle exposes `prepare()` and its provisioner; `session/tools/` assembles built-in tools afterward. The historical `session/kernel/kernel.ts` adapter preserves `SessionKernel.build()` by calling these same owners in the original order. It shares one provisioner and inherited disposal, retaining late-message callbacks and options. No tool or lifecycle implementation is duplicated.

Keep the independent kernel capability usable by postinstall/bootstrap without a session or terminal UI. Preserve process-wide startup limiting, error repair, old-snapshot flush before replacement restore, reinstalling live skill handles after restore, and final disposal. Do not fold input/turn/child policy into `session/runtime/` to empty other directories.

## Remaining core migration ledger

The session and kernel tables above plus this ledger account for all 64 direct `core/*.ts` files and all eight existing `core/` subdirectories. These later assignments require full implementation review before edits. They are proposed ownership destinations covering the inventory, not authorization for blanket renames or deletion of functionality.

| Current core files/folders | Owner and required boundary |
| --- | --- |
| `auth-storage.ts`, `auth-guidance.ts`, `prime-inference-auth.ts`, `websearch-credential.ts` | `auth/`; credential storage, recovery guidance and provider/service login. |
| `model-registry.ts`, `model-resolver.ts`, `prime-inference-model-catalog.ts`, `prime-inference-models.ts`, `provider-display-names.ts`, `provider-retry.ts`, `thinking-levels.ts`, `defaults.ts` | `models/`; separate model parsing from CLI validation/presentation. A shared model helper must not import CLI argument handling. |
| `prime-inference-model-selection.ts` | Interactive auth flow; its result decides whether to open a model picker after login. |
| `settings-manager.ts`, `resolve-config-value.ts` | `config/`; settings/credential-value resolution, with dependencies directed toward primitives. |
| `package-manager.ts`, `resource-loader.ts`, `skills.ts`, `skill-blocks.ts`, `prompt-templates.ts`, `source-info.ts`, `diagnostics.ts` | `resources/`; package resolution/install and discovered resources, with skills/templates grouped by feature. Remove resource-loader's concrete theme dependency by composing theme registration at the UI boundary. |
| `session-manager.ts`, `session-file-actions.ts`, `session-id.ts`, `session-resolver.ts`, `session-import-errors.ts`, `session-lease.ts` | `session/history/`; persisted session discovery/tree/writes/artifacts and exclusive ownership. Extract generic process identity from leases first because daemon ownership and orphan reaping consume it. |
| `session-cwd.ts` | Runtime working-directory validation/error data to `session/runtime/`; interactive confirmation formatting to the terminal owner. |
| `side-question.ts` | `session/side-questions/`; temporary answer runs over cloned conversation context, with their own cancellation and no writes to parent history. |
| `agent-messages.ts`, `agent-observe.ts`, `cron-jobs.ts` | `coordination/messaging/`, `observation/`, `scheduling/` with agent-family contracts owned by coordination. Split message/run-boundary classification into session input/turns. Keep daemon dispatch and actual worker residency in daemon. |
| `agent-traces.ts`, `telemetry.ts`, `semantic-edges.ts`, `event-log.ts`, `logging.ts`, `timings.ts` | `diagnostics/`, with traces/telemetry/ledger responsibilities grouped when needed; contracts must not load a session implementation. |
| `orphan-process-journal.ts` | Kernel/process journal support under `kernel/`; retain its journal environment contract and kernel-scoped reaping. Extract domain-independent identity/tree-kill primitives to utils; preserve kernel and daemon consumers. |
| `event-bus.ts` | `extensions/`; currently used for extension/resource discovery, not a universal application bus. |
| `exec.ts` | Extension execution support under `extensions/`; generic subprocess primitives remain in utils. |
| `bash-executor.ts`, `tools/` | `tools/`, after extracting kernel provisioning and terminal rendering from tool implementations. Session shell state remains session-owned. |
| `extensions/` | `extensions/`; separate execution contracts from optional terminal UI types/bindings. |
| `mcp/` | `mcp/`; protocol-specific ACP adapters stay with ACP when they have no independent MCP responsibility. |
| `export-html/` | `session/history/export-html/`; export adapter and its templates/vendor assets travel together. |
| `footer-data-provider.ts`, `keybindings.ts`, `output-guard.ts` | Terminal presentation/input support; footer stays under interactive/status, shared terminal keybindings/stdout plumbing under a named modes terminal owner. Execution receives operations rather than importing UI globals. |
| `slash-commands.ts`, `new-session-command.ts` | Named command definitions/parsers under `cli/commands/`; session-specific parsing/contracts stay with the session feature when split. Shared definitions must not import executable CLI startup or UI. |
| `index.ts` | Redirect real consumers/public root exports; retire the legacy barrel only after checking repo consumers and supported package entry points. |

Top-level `config.ts` and `migrations.ts` move to config; `main.ts`, `cli-main.ts` and `package-manager-cli.ts` belong to CLI startup/package commands. Keep tiny supported executable wrappers where packaging requires them. `themes/` needs review together with UI theme resources; do not assume its one module is redundant.

## Mode and utility organization

Keep these in the existing daemon/UI workstreams, not in a 343-file mechanical move:

- Daemon: `protocol/` for wire contracts/validation; `workers/` for process ownership/recovery/residency; `catalog/` for saved/live discovery; `scheduling/` for dispatch; `snapshots/` for transfer/cache. The daemon and supervisor entry files compose these. Public client transport remains clearly separated from supervisor implementation.
- Interactive: `transcript/`, `composer/`, `commands/`, `dialogs/`, `status/`, `theme/`; move feature-specific components alongside those owners. Reserve `components/` for genuinely shared UI primitives, not every rendered object. Keep terminal lifecycle in the interactive shell.
- Agents view: catalog/view model, selection/navigation, rendering. Connection, ACP and RPC retain their existing named owners unless their own audit identifies a mixed responsibility.
- Utilities: retain domain-independent file/async/process primitives. Rehome daemon socket paths with daemon, clipboard with terminal input, and release/changelog/update helpers with their CLI owner. Review image conversion/orientation/resizing as a coherent media capability. Do not replace `core/` with a new 64-file `utils/`.

No prescribed file-count cap substitutes for ownership. The 10,175-line interactive shell, 7,843-line daemon mode, 7,007-line supervisor, 2,443-line package manager and 2,429-line session manager still need responsibility extraction; putting them in folders does not complete that work.

## Safety and completion gates

1. Before each commit group, fully read every implementation to edit, list consumers including tests/examples/scripts, record state and cleanup owners, and confirm the proposed map against actual APIs. Start from the current stack head and inspect worktree changes before editing.
2. Split mixed responsibilities first in reviewable commits, then move files/imports. Keep feature behavior, protocol shapes and stored formats unchanged. No new universal context object, service locator, dependency or runtime migration.
3. Preserve exactly-once action settlement, commit fences and passivation behavior; goal/compaction continuation order; refinement plan claiming and concurrent harness writes; child cleanup before kernel teardown; live controller lookup and callback receivers; kernel replacement/restore order. In compaction, request accounting completes before transcript append, and failed persistence retains the existing live outcome disclosure. The detailed ordering rules in `src/README.md` remain required.
4. Use existing focused action/queue/goal/compaction/refinement/runtime/kernel suites and the faux-provider integration harness. Run every modified test file from its package root. Kernel/process integration uses the dedicated environment lanes. Record skips and failures explicitly; do not claim every edge case is proven.
5. Add an architecture check for the agreed boundaries, using the existing parser/tooling: prevent new core paths, implementation in parent grouping folders outside a small documented exception list, runtime imports of public SDK barrels, feature contracts importing controllers, and execution imports of terminal renderers. Distinguish type-only edges and use an explicit shrinking baseline for existing violations. The test must reject intentional bad-import fixtures and permit legitimate contract consumers.
6. Update package exports, extension loading, test mappings, bootstrap paths, copy-assets scripts and compiled sidecar resolution. The current `./hooks` export and example mapping reference `core/hooks`; inspect that existing discrepancy before changing exports, rather than silently deleting a supported entry. Validate the assembled artifact and SDK import separately from type checking.
7. Run `npm run check` with full output after code changes. Follow AGENTS.md for focused tests; do not run prohibited blanket dev/build/test commands. A documentation-only plan does not need application tests.
8. Benchmark identical base/head workloads using the same trusted harness and complete reports. A move alone is not evidence of faster startup or smaller artifacts. Keep the existing partial benchmark disclosed; do not substitute a successful small reproduction for its missing trial.
9. Update this ledger and `src/README.md` in the same PR as each implemented boundary. A moved owner is complete only when internal imports and assets use canonical paths, required legacy export facades are explicit and tested, conflicting conventions are gone, and affected validation passes. Report compatibility facades separately from unfinished implementation.
10. Keep local cleanup activation held while this design/implementation is pending. Rebuild from the latest UI/native integration only after the agreed gates clear; preserve current installed changes. No automatic merges or release publication.

Track session work in ENG-5938, kernel/children in ENG-5939, dependency separation in ENG-5936, daemon/UI in ENG-5940/ENG-5941, and build/artifact validation in ENG-5944. ENG-5934 is the overall plan. Keep Kevin involved at the ownership-map review and the first concrete implementation diff, rather than asking about each file move.
