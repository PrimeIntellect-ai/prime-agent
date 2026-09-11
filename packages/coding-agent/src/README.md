# Source organization

`src/` contains application source; tests, scripts, docs, examples, and build output stay at the package root. Follow the [source ownership rules](../docs/architecture.md#source-ownership-and-module-boundaries) when choosing module boundaries. Session features, including goals, live below `session/`; each feature groups its state, dependencies, and lifecycle.

`session/agent-session.ts` is the public session composition point. Each feature owner keeps its state and transitions together and receives only the dependencies it uses. `core/` still contains unmigrated capabilities and compatibility exports; it is not a destination for new implementation.

The ownership follow-ups consolidate session features, the independent Python kernel, session runtime composition and SDK factories. The [completion plan](../docs/source-organization-plan.md) distinguishes implemented boundaries from remaining package work. Historical module paths forward explicit exports to canonical modules; application imports use the canonical paths. The former `SessionKernel.build()` entry has a small compatibility adapter over the same provisioner and tool assembly operations; it owns no duplicate lifecycle state.

## Goals

| File | Responsibility |
| --- | --- |
| `session/goals/controller.ts` | Goal transitions, token and time accounting, continuation counts, and rollback checkpoints. |
| `session/goals/persistence.ts` | Reading the selected branch, flushing goal records, and deciding whether a branch can receive an initial goal. |
| `session/goals/commands.ts` | Parsing `/goal` arguments into typed commands. |
| `session/goals/continuation.ts` | Goal continuation admission, budget notices, child-wait coordination, and rollback. |
| `session/goals/contracts.ts` | Lightweight goal types, validation, serialization, and context-message formatting used by session clients. |

The controller depends on a load/save interface, an update callback, and a clock. It does not receive `AgentSession`, the agent loop, a kernel, or a UI object. Its state is read-only to callers; mutations go through named operations.

`AgentSession` retains responsibilities that cross features: authentication and tool readiness, queue admission, cancellation, compaction, and waiting for child agents. It validates requests and tells the goal controller when to transition or account for a message.

Three ordering rules matter during future extractions:

- Account for assistant usage before executing its tools, so a completing turn is included. Repeated delivery of the same assistant message must not count twice.
- Capture completion usage, clear stale queued goal context, and then persist and publish completion. The explicit completion callback preserves this order.
- A continuation rejected by new input restores both goal state and the accounting clock. Deferred child-work admission preserves the existing clock while restoring goal state.

Goal state belongs to a session branch, so the controller, persistence adapter, and continuation owner share `session/goals/`. UI and protocol consumers import the lightweight contracts without loading the controller. The public goal payload and persisted `thread_goal_state` format remain unchanged; the internal move does not require a new daemon command or schema.

## Extending this structure

Apply the architecture guide's placement and dependency rules to each extraction. This document records the resulting owners and ordering invariants; update it when those boundaries change.

## Session feature folders

| Folder | Ownership |
| --- | --- |
| `session/input/` | Submission normalization, admission, scheduling, commit fencing, action queues, delivery, and recovery. |
| `session/goals/` | Goal state and contracts, accounting, persistence, command parsing, and goal-specific continuation. |
| `session/turns/` | Turn preparation and execution, session commands, ordered events, retry, and shared continuation. |
| `session/autonomy/` | Autonomous budgets, gates, continuation messages and rollback. |
| `session/compaction/` | Session compaction lifecycle, execution and summary generation. |
| `session/refinement/` | Refinement planning/application lifecycle, automatic review, and execution. |
| `session/context/` | Model-facing messages, usage, token estimates, prompts, pending context, transcript views, branch navigation, and export. |
| `session/children/` | Child records, runtime creation, execution, projections, and usage accounting. |
| `session/runtime/` | Session construction, replacement, configuration, kernel lifecycle/environment and host-handler composition. |
| `session/models/` | Model selection, thinking preferences, and authenticated availability. |
| `session/tools/` | Tool selection and shell-command execution. |
| `session/extensions/` | Extension bindings, resource reload, and tool hooks. |

`session/input/prepared-actions.ts` contains action and recovery contracts used across input, turns, and context. Shared continuation belongs to `session/turns/`, including continuation after compaction. Child usage belongs to `session/children/` because its accounting and cleanup follow child records. Compaction/refinement implementations live with their session features; their historical `core/` paths contain only explicit compatibility exports.

## Session input scheduling

`session/input/input-scheduler.ts` owns the serialized pump, its preparation epoch, pause leases, and abort/restart suspension. It receives two callbacks: whether the session has work eligible for scheduling, and the operation that runs that work. The scheduler exposes read-only state and named operations; callers cannot change its pause sets or scheduling flags.

`ActionStore` in `session/input/action-store.ts` owns queued actions, their transitions, and delivery/completion tickets. `session/input/input-dispatcher.ts` selects and batches those actions, reconciles durable delivery after dispatch, rolls undelivered work back, and settles completion or failure. `AgentSession` supplies turn execution and session-command operations and coordinates goals, child agents, and compaction. The dispatcher shares the existing `ActionStore`; it does not create a second queue or copy the transcript. Worker eviction and passivation predicates belong to `modes/daemon/workers/residency-policy.ts` and consume action-state views without owning the queue.

Preserve these distinctions when extending the scheduler:

- An admission pause blocks new input. A queued-work pause blocks dispatch of already admitted input. They have separate leases and release behavior.
- Starting either pause invalidates asynchronous preparation. Releasing an admission pause also advances the epoch; releasing a queued-work pause retains it. A runner must check its captured epoch after asynchronous work.
- Abort and update restart suspend future scheduling until explicitly resumed. Resume does not release outstanding pause leases. Update restart additionally prevents a custom trigger from implicitly resuming input.
- Pause-release callbacks run once, after the lease is removed. The session retains notification, deferred-message, goal-resumption, and scheduling order.
- Waiting for the pump to settle differs from waiting for the entire session to be idle. Session idle also includes the agent run, event queue, and unfinished actions.

## Session commit coordination

`session/input/commit-fence.ts` owns the FIFO commit queue, its current owner and waiters, asynchronous reentrancy context, and disposal signal. Prompt dispatch, session commands, and branch navigation acquire a lease and run their critical section within its owner context. The session still decides when admission is allowed and when to release the lease.

- Reentrant work shares the current owner's lease; releasing that nested lease does not release the outer operation. An asynchronous callback from an old owner must queue behind the current owner.
- Cancelling a waiter rejects it promptly but retains its place in the promise chain until its predecessor releases. Later operations cannot overtake that predecessor.
- Disposal rejects waiting and future acquisitions. An already held lease remains owned until its caller releases it. Admission checks still reject disposed sessions before a direct prompt can re-enter.
- Pending work includes queued waiters during the gap between two owners, so daemon passivation cannot mistake a commit handoff for idle.

The abortable promise helper moved unchanged to `utils/wait-for-abort.ts`, shared by commit acquisition and existing session checkpoint waits.

The input dispatcher preserves selection and settlement ordering. Batches include only adjacent compatible turns, and preselected turns remain separate. A changed preparation epoch rolls undelivered input back without replaying durable prefix messages. Cancelled actions capturing late messages remain owned until event processing releases them. Checkpoint notifications and queue events retain their distinct positions in these transitions.

## Session shell commands

`session/tools/bash.ts` owns shell-command execution, abort controllers, the user-command slot, abort requests during extension dispatch, and deferred transcript output. Its host supplies current shell settings and working directory, extension interception, event delivery, transcript append, and session scheduling notifications. These callbacks read the current runtime so rebuilding extensions or changing settings does not retain stale dependencies.

`AgentSession` keeps its public shell methods and the cross-feature decision about when to flush deferred output. It also appends messages to agent state before persistence and schedules queued input after the agent becomes idle. The shell owner does not receive the session, kernel, agent loop, or storage manager.

Execution and recording callbacks preserve dispatch through the public session methods, including wrappers installed by callers. They delegate to the shell owner's corresponding operations; they do not duplicate shell state.

- User commands reserve the slot before awaiting extensions. Direct executions may overlap and each remains independently abortable.
- Release the user slot and notify waiters before publishing `bash_end`; queued work resumes afterward.
- Extension-provided results take precedence over an abort received during interception. Otherwise, that abort prevents process execution.
- Transient commands publish their lifecycle events but never enter pending output, transcript storage, or model context. Context-excluded commands remain persisted.
- Output produced during streaming waits for the same existing prompt-preparation flush points, preserving tool-call/result ordering.
- Shell event shapes, command options, error behavior, and persisted `bashExecution` messages stay unchanged.

## Session retry handling

`session/turns/retry.ts` owns retry attempts, backoff cancellation, retry completion, and authentication-failure tracking. The session reports assistant and agent completion at their existing points in event processing. The retry owner receives current settings, model authentication operations, context inspection, and named operations for continuing or ending a turn.

- Reserve retry completion synchronously when receiving `agent_end`, before asynchronous event processing. Callers waiting for retry must observe the same pending work.
- Resolve completion before notifying waiters and scheduling queued input. Generation checks keep a rejected continuation from terminating a later retry.
- Preserve provider error classification, retry limits, delay calculation, captured credential identity, and authentication invalidation. Context overflow still belongs to compaction.
- Public retry events and session methods retain their existing shapes and ordering.

## Turn preparation and action records

`session/turns/turn-preparation.ts` contains the execution policies for direct, queued, injected, and custom-triggered turns and the ordered preparation pipeline. `TurnPreparer` receives six operations for validation, pending shell output, model selection, compaction, and refinement. The session supplies their implementations and retains transcript dispatch and context rollback.

Preserve the policy differences: direct prompts flush shell output before validation and compact after model selection; queued turns validate before flushing and compact before model selection. Conditional refinement barriers are checked when reached, so a refinement started during preparation is still awaited. Withdrawing prepared work skips the final barrier and commit. The exported `TurnExecutionPolicy` shape remains available from the session facade.

`session/input/prepared-actions.ts` contains prepared action types, delivery records, recovery contracts, input copying, action factories, and queue projections. It has no session implementation dependency. Primary messages retain their identity for durable-delivery checks; separately stored input blocks and prefix messages retain their existing copy behavior. Recovery format version 1 and the public exports from `AgentSession` stay unchanged.

## Session input and turns

| File | Responsibility |
| --- | --- |
| `session/input/submission-normalization.ts` | Copying and validating submission content, options, and provenance. |
| `session/input/prompt-submission.ts` | Prompt preparation and admission, steering, follow-ups, custom/user messages, and background shell completion messages. |
| `session/input/message-delivery.ts` | Accepted agent-message receipts, completion settlement, and restoration of late Python messages. |
| `session/input/input-admission.ts` | Readiness checks and admission predicates. |
| `session/input/input-checkpoints.ts` | Checkpoint waiters, notification, cancellation, input-dispatch barriers, and headless waiting. |
| `session/input/action-queue.ts` | Queue operations and projections over the existing ActionStore. |
| `session/input/action-recovery.ts` | Capturing and restoring pending input when the session runtime changes. |
| `session/turns/turn-execution.ts` | Executing direct, queued, injected, and custom-triggered turns. |
| `session/turns/command-execution.ts` | Executing queued session commands and recording their outcomes. |
| `session/turns/events.ts` | Ordered agent-event processing, listener delivery, and transcript/accounting coordination. |
| `session/context/pending-context.ts` | Pending messages, notices, and retention for the next turn. |
| `session/goals/continuation.ts` | Goal continuation admission, budget notices, child-wait coordination, and rollback. |
| `session/autonomy/continuation.ts` | Autonomous continuation messages, snapshots, and rollback. |
| `session/turns/turn-policy.ts` | Turn stopping, threshold compaction, and continuation decisions from current session state. |

Input has one durable ActionStore, one scheduling pump, one commit fence, and one ordered event queue. Queue operations, admission, preparation, execution, and recovery use these same owners; they do not maintain parallel queues or transcripts. Dependencies are named operations and small state views. Callbacks read the current model, controllers, and runtime where the original operation did.

- Pending-context state changes through named synchronous operations. Raw rollback restores the same messages without waking input; recovery restores copied envelopes and flushes deferred work. Message identity, shared details, and the existing copy boundaries matter for delivery and rollback.
- Goal and autonomous continuation state stays with its owner. Consuming a threshold message or harness digest and rearming it are explicit transitions. Preserve the existing Boolean abort/child-wait timing and message-keyed snapshot identity.
- Public session entry points remain live dispatch boundaries for extensions and callers. Delegates retain callback receivers and their existing synchronous or asynchronous return behavior.
- Session startup, abort, disposal, pause release, and work after compaction remain coordinated in `AgentSession` because they span several owners. Keep those operation sequences visible instead of introducing a general lifecycle framework.

## Session context

| File | Responsibility |
| --- | --- |
| `session/compaction/controller.ts` | Manual and automatic compaction lifecycle, pending requests, cancellation, thresholds, and overflow recovery. |
| `session/compaction/execution.ts` | Summary generation, extension interception, request accounting, persistence, and context rebuild ordering. |
| `session/compaction/summary.ts`, `types.ts` | Summary preparation/generation and compaction contracts. |
| `session/context/token-estimate.ts`, `conversation-text.ts`, `file-tracking.ts` | Shared context estimation, serialization and file tracking. |
| `session/context/branch-summary.ts` | Branch summary preparation and generation for history navigation. |
| `session/refinement/controller.ts` | Refinement admission, planning and application barriers, serialized plan ownership, and disposal drains. |
| `session/refinement/automatic.ts` | Review triggers, cooldowns, pending reviews, timers, and automatic operation cleanup. |
| `session/refinement/execution.ts` | Planning against current dependencies, applying harness edits, and persisting outcomes and notices. |
| `session/refinement/planning.ts`, `harness-state.ts` | Review/planning and persisted harness application/history. |
| `session/refinement/types.ts`, `format.ts` | Lightweight contracts and outcome formatting, usable without loading planning. |
| `session/turns/continuation.ts` | Resuming work after compaction, settlement, cancellation, and ownership of continuation messages. |

Each owner keeps its mutable state and cleanup together. Typed host operations connect the owners to current model, authentication, extensions, storage, and scheduling. `AgentSession` composes them and retains public methods, events, and decisions that cross features, including goal and autonomous continuation admission. Message conversion imports only refinement formatting/contracts, avoiding the former message-conversion/planning import cycle. Harness persistence retains Python's on-disk contract, atomic writes and reread-before-apply behavior.

Preserve these boundaries when changing context behavior:

- Compaction releases its operation and reconnects event handling before resuming work. Summarization request accounting completes before the transcript append; failed persistence must preserve the existing live outcome disclosure.
- Refinement planning may overlap active work. Applying a plan waits for the relevant agent, event, compaction, and branch operations to settle, and rechecks their identities before mutating context. Serialized checkpoints claim a background plan once.
- A cancelled continuation settles its own waiters. Late results cannot clear a replacement operation or consume its messages. The commit lease is released before awaiting a continued agent turn, and checkpoint waiters are removed when cancellation wins.
- Public session methods delegate without additional asynchronous wrappers. Optional waits retain their original positions, and dependency callbacks read current runtime state when invoked.

## Child agent lifecycle

| File | Responsibility |
| --- | --- |
| `session/children/children.ts` | Child registry, admission, publication, deletion retries, cancellation, quiescence, retention, and cleanup. |
| `session/children/child-run.ts` | Detached child execution, publication barriers, terminal state, and event attribution. |
| `session/children/child-runtime.ts` | Inline child construction and child-specific directory creation. |
| `session/children/child-state.ts` | Depth and maximum-depth settings, parent replies, and recap state. |
| `session/children/child-usage.ts` | Child usage attribution, origin batches, flush timers, and retry bookkeeping. |
| `session/children/child-projection.ts` | Read-only child list and snapshot projections. |
| `session/children/child-types.ts` | Child contracts and shared child data helpers. |
| `session/children/runtime-contracts.ts`, `spawn-options.ts`, `host-requests.ts` | Child host contracts, spawn option validation and child request adapters. |

The registry owns child identity and lifecycle transitions. Execution and usage components operate on the same child records; they do not create competing copies of run state. Child state exposes read-only properties and named mutations. Runtime hosts, inherited depth, model selection, and event queues are read through live operations supplied by the session.

The former RLM runtime module's model search belongs to `session/models/model-search.ts`; background shell completion request handling belongs to `session/input/bash-host-requests.ts`. Their legacy combined module forwards exports but has no implementation. Child maximum-depth policy stays with children.

- Reserve and publish children in the original order. A late completion cannot replace a newer run or clear another run's cancellation state.
- Retain deletion reservations, retryable cleanup state, and descendant quiescence until their existing completion conditions hold. Parent continuation still waits for the appropriate child work.
- Flush child usage once at the existing parent event boundary. Origin batches and timers have one cleanup owner.
- Complete child cleanup before kernel teardown. The session supplies the following teardown operation so an empty child set does not add a scheduling delay before kernel disposal begins.
- Keep calls that previously passed through public session methods live, including descendant receivers, registration, deletion, and maximum-depth status after settings updates.

The root kernel directory belongs to `session/runtime/kernel-environment.ts`. Child directory construction receives a lazy operation for that directory rather than keeping a second root-directory field. The existing child runtime-options factory retains its public parent-session contract at the facade; child owners receive only the operations they use.

## Tools, extensions, and kernel resources

| File | Responsibility |
| --- | --- |
| `session/tools/tools.ts` | Built-in tool assembly, active selection, allowlists, prompt contributions, and ACP tool updates. |
| `session/extensions/extensions.ts` | Extension runner bindings, resource reload, and extension lifecycle. |
| `session/runtime/kernel-lifecycle.ts` | Kernel preparation, snapshot restoration, prewarming, and disposal. |
| `session/runtime/kernel-environment.ts` | Kernel provisioning environment and root or ephemeral session directories. |
| `session/runtime/host-bridge.ts` | Typed host-handler composition from live session operations. |
| `kernel/provisioner.ts`, `skill-bootstrap.ts` | Reusable kernel provisioning and Python skill handle installation. |
| `kernel/repl-manager.ts`, `protocol.ts` | Python subprocess transport and protocol constants. |
| `kernel/contracts.ts` | Kernel request/result contracts without process cleanup registration. |
| `kernel/process-registry.ts`, `boot-gate.ts` | Process-wide cleanup registration and bounded kernel startup. |
| `kernel/bootstrap.ts`, `state-snapshot.ts` | Python environment discovery/setup and snapshot path operations. |

The session coordinates these owners with children, models, and input admission. A kernel replacement uses the previous kernel's disposal promise as its readiness gate. First-build restoration notices and snapshot-directory ownership stay with the kernel owner. Host handlers read the current runtime when invoked, including after replacement.

`kernel/` exposes provisioning and process operations usable by installation/bootstrap without constructing a session. `session/runtime/` binds that capability to session lifetime, transcript notices and replacement ordering. The lifecycle's `prepare()` returns the provisioner; session tools assemble definitions afterward in the existing order. The legacy `session/kernel/kernel.ts` adapter retains `build()` and delegates to both owners, preserving late-message callback receivers and inherited disposal. Other historical kernel modules forward exports; `core/kernel/bootstrap-cli.ts` remains an executable wrapper around `cli/bootstrap-kernel.ts`.

`sdk/create-session.ts` constructs sessions; `sdk/services.ts` composes their services; `sdk/contracts.ts` carries creation/service contracts. The runtime retains its injected creation factory and imports contracts directly. Public SDK barrels remain outward-facing so importing the runtime does not cycle back through SDK construction. Public exports, constructor options, session leases and replacement/disposal sequences remain unchanged.

ACP resource cleanup retains its input pause until queued work and cleanup finish, and releases the pause on failure. Extension bindings preserve public session dispatch and callback receivers, including shutdown and partial rebinding. Pure facade delegates do not add asynchronous wrappers around already asynchronous owner operations.

## Models, history, and host requests

| File | Responsibility |
| --- | --- |
| `session/models/model-selection.ts` | Model and thinking preferences, authenticated availability, preflight checks, cycling, and child-model selection. |
| `session/context/history-navigation.ts` | Switching sessions, forking, and navigating branches with their existing barriers. |
| `session/context/context-view.ts` | Context usage, session statistics, and tree views over live transcript and child usage. |
| `session/context/harness-context.ts` | Harness changes, digest consumption, and context for subsequent turns. |
| `session/context/export.ts` | Session export using current model and extension rendering dependencies. |
| `coordination/scheduling/host-requests.ts` | Heartbeat request validation and controller operations. |
| `coordination/messaging/host-requests.ts` | Message request validation and controller operations. |
| `coordination/observation/host-requests.ts` | Observation request validation, controller operations, and result encoding. |

The three host-request modules are stateless adapters. Kernel handler composition still calls the public session methods. Heartbeat and observation requests capture their controller on entry; messaging reads its controller at each operation. Compaction request interpretation belongs to the compaction owner.

Model selection captures the parent model before awaiting authenticated availability. Preserve the unauthenticated parent-model fast path, expired-credential filtering, original validation errors, and public model/thinking getter dispatch. Context and export read existing records; neither owns a second transcript.

Context views own aggregation and derived usage memos. Child usage owns the adjustment for child spend not yet indexed in the transcript. The view calls that existing operation with the same usage object and entries.

Feature contracts live with their owner, including prompt options and session events. The facade re-exports the existing public types and retains session construction configuration. Constructor-only references are readonly; replaceable runtime bindings stay mutable. A host interface should expose only the state and operations its consumer needs.

Integration regressions in `test/suite/regressions/` cover model/history boundaries, prompt and message dispatch, host-controller capture, callback receivers, and admission behavior. `test/session/pending-context.test.ts` covers pending-context identities and recovery. Existing queue, action, goal, autonomous, branch, extension, and kernel suites cover composition through the public session API.

## Validation

Controller tests live in `test/session/goals/`. Session integration coverage remains in `test/suite/agent-session-goal.test.ts`, `test/suite/agent-session-compaction-continuation.test.ts`, and `test/goal-continuation-quiescence.test.ts`.

Scheduler and commit-fence tests live in `test/session/`. Existing queue, action-contract, action-race, and compaction suites cover the integration with `AgentSession`, including pause, cancellation, restart, branch navigation, and goal continuation.

Shell-owner tests also live in `test/session/`. Session bash/persistence, prompt, queue, and side-question regression suites retain end-to-end coverage of scheduling and transcript behavior using the faux provider and controlled shell operations.

Compaction and continuation owner tests in `test/session/` exercise lifecycle and cancellation boundaries. Compaction, refinement, serialized refinement, queue, concurrency, and semantic-edge suites cover their integration with session persistence, goals, and disposal. `test/suite/session-refinement-owner.test.ts` checks the refinement owner boundary using the shared faux-provider harness.

Child usage and recursion suites cover accounting, cancellation, publication, and cleanup. Kernel, environment, and tool tests in `test/session/` cover resource ownership and replacement. The child/runtime facade regressions in `test/suite/regressions/` preserve public dispatch, callback receivers, and teardown ordering. Real Python background-bash cases require the configured runtime environment; record missing-environment skips explicitly.

Run the focused files from the coding-agent package root with the repository's prescribed Vitest command, then run `npm run check` from the repository root. Use faux providers for session tests.
