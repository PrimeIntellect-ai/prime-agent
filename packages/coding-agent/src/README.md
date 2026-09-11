# Source organization

`src/` contains application source; tests, scripts, docs, examples, and build output stay at the package root. Put feature folders directly under `src/`, such as `goals/`, `session/`, and `kernel/`. Add another level only when a feature has distinct subparts that benefit from being grouped.

`core/` currently contains most execution logic. Migrate its responsibilities into sibling feature folders as they are extracted. `AgentSession` remains the public entry point and coordinates work across features. Each feature owner keeps its state and transitions together and receives only the dependencies it uses.

## Goals

| File | Responsibility |
| --- | --- |
| `goals/controller.ts` | Goal transitions, token and time accounting, continuation counts, and rollback checkpoints. |
| `goals/persistence.ts` | Reading the selected branch, flushing goal records, and deciding whether a branch can receive an initial goal. |
| `goals/commands.ts` | Parsing `/goal` arguments into typed commands. |
| `core/goals.ts` | Shared goal types, validation, serialization, and context-message formatting used by session clients. |

The controller depends on a load/save interface, an update callback, and a clock. It does not receive `AgentSession`, the agent loop, a kernel, or a UI object. Its state is read-only to callers; mutations go through named operations.

`AgentSession` retains responsibilities that cross features: authentication and tool readiness, queue admission, cancellation, compaction, and waiting for child agents. It validates requests and tells the goal controller when to transition or account for a message.

Three ordering rules matter during future extractions:

- Account for assistant usage before executing its tools, so a completing turn is included. Repeated delivery of the same assistant message must not count twice.
- Capture completion usage, clear stale queued goal context, and then persist and publish completion. The explicit completion callback preserves this order.
- A continuation rejected by new input restores both goal state and the accounting clock. Deferred child-work admission preserves the existing clock while restoring goal state.

The shared goal types and message formatting remain in `core/goals.ts` during this extraction; their existing consumers can migrate together in a later change. The public goal payload and persisted `thread_goal_state` format remain shared contracts. Internal organization does not require a new daemon command or schema.

## Extending this structure

Use the same ownership rule for the next extraction: move a responsibility's fields, transitions, and cleanup together. Keep request parsing and storage adapters separate when they have independent dependencies. Avoid generic helper folders, modules that receive the entire session, and duplicate copies of feature state.

## Session input scheduling

`session/input-scheduler.ts` owns the serialized pump, its preparation epoch, pause leases, and abort/restart suspension. It receives two callbacks: whether the session has work eligible for scheduling, and the operation that runs that work. The scheduler exposes read-only state and named operations; callers cannot change its pause sets or scheduling flags.

The existing `ActionStore` in `core/session-action-store.ts` owns queued actions, their transitions, and delivery/completion tickets. `session/input-dispatcher.ts` selects and batches those actions, reconciles durable delivery after dispatch, rolls undelivered work back, and settles completion or failure. `AgentSession` supplies turn execution and session-command operations and coordinates goals, child agents, and compaction. The dispatcher shares the existing `ActionStore`; it does not create a second queue or copy the transcript.

Preserve these distinctions when extending the scheduler:

- An admission pause blocks new input. A queued-work pause blocks dispatch of already admitted input. They have separate leases and release behavior.
- Starting either pause invalidates asynchronous preparation. Releasing an admission pause also advances the epoch; releasing a queued-work pause retains it. A runner must check its captured epoch after asynchronous work.
- Abort and update restart suspend future scheduling until explicitly resumed. Resume does not release outstanding pause leases. Update restart additionally prevents a custom trigger from implicitly resuming input.
- Pause-release callbacks run once, after the lease is removed. The session retains notification, deferred-message, goal-resumption, and scheduling order.
- Waiting for the pump to settle differs from waiting for the entire session to be idle. Session idle also includes the agent run, event queue, and unfinished actions.

## Session commit coordination

`session/commit-fence.ts` owns the FIFO commit queue, its current owner and waiters, asynchronous reentrancy context, and disposal signal. Prompt dispatch, session commands, and branch navigation acquire a lease and run their critical section within its owner context. The session still decides when admission is allowed and when to release the lease.

- Reentrant work shares the current owner's lease; releasing that nested lease does not release the outer operation. An asynchronous callback from an old owner must queue behind the current owner.
- Cancelling a waiter rejects it promptly but retains its place in the promise chain until its predecessor releases. Later operations cannot overtake that predecessor.
- Disposal rejects waiting and future acquisitions. An already held lease remains owned until its caller releases it. Admission checks still reject disposed sessions before a direct prompt can re-enter.
- Pending work includes queued waiters during the gap between two owners, so daemon passivation cannot mistake a commit handoff for idle.

The abortable promise helper moved unchanged to `utils/wait-for-abort.ts`, shared by commit acquisition and existing session checkpoint waits.

The input dispatcher preserves selection and settlement ordering. Batches include only adjacent compatible turns, and preselected turns remain separate. A changed preparation epoch rolls undelivered input back without replaying durable prefix messages. Cancelled actions capturing late messages remain owned until event processing releases them. Checkpoint notifications and queue events retain their distinct positions in these transitions.

## Session shell commands

`session/bash.ts` owns shell-command execution, abort controllers, the user-command slot, abort requests during extension dispatch, and deferred transcript output. Its host supplies current shell settings and working directory, extension interception, event delivery, transcript append, and session scheduling notifications. These callbacks read the current runtime so rebuilding extensions or changing settings does not retain stale dependencies.

`AgentSession` keeps its public shell methods and the cross-feature decision about when to flush deferred output. It also appends messages to agent state before persistence and schedules queued input after the agent becomes idle. The shell owner does not receive the session, kernel, agent loop, or storage manager.

Execution and recording callbacks preserve dispatch through the public session methods, including wrappers installed by callers. They delegate to the shell owner's corresponding operations; they do not duplicate shell state.

- User commands reserve the slot before awaiting extensions. Direct executions may overlap and each remains independently abortable.
- Release the user slot and notify waiters before publishing `bash_end`; queued work resumes afterward.
- Extension-provided results take precedence over an abort received during interception. Otherwise, that abort prevents process execution.
- Transient commands publish their lifecycle events but never enter pending output, transcript storage, or model context. Context-excluded commands remain persisted.
- Output produced during streaming waits for the same existing prompt-preparation flush points, preserving tool-call/result ordering.
- Shell event shapes, command options, error behavior, and persisted `bashExecution` messages stay unchanged.

## Session retry handling

`session/retry.ts` owns retry attempts, backoff cancellation, retry completion, and authentication-failure tracking. The session reports assistant and agent completion at their existing points in event processing. The retry owner receives current settings, model authentication operations, context inspection, and named operations for continuing or ending a turn.

- Reserve retry completion synchronously when receiving `agent_end`, before asynchronous event processing. Callers waiting for retry must observe the same pending work.
- Resolve completion before notifying waiters and scheduling queued input. Generation checks keep a rejected continuation from terminating a later retry.
- Preserve provider error classification, retry limits, delay calculation, captured credential identity, and authentication invalidation. Context overflow still belongs to compaction.
- Public retry events and session methods retain their existing shapes and ordering.

## Turn preparation and action records

`session/turn-preparation.ts` contains the execution policies for direct, queued, injected, and custom-triggered turns and the ordered preparation pipeline. `TurnPreparer` receives six operations for validation, pending shell output, model selection, compaction, and refinement. The session supplies their implementations and retains transcript dispatch and context rollback.

Preserve the policy differences: direct prompts flush shell output before validation and compact after model selection; queued turns validate before flushing and compact before model selection. Conditional refinement barriers are checked when reached, so a refinement started during preparation is still awaited. Withdrawing prepared work skips the final barrier and commit. The exported `TurnExecutionPolicy` shape remains available from the session facade.

`session/prepared-actions.ts` contains prepared action types, delivery records, recovery contracts, input copying, action factories, and queue projections. It has no session dependency. Primary messages retain their identity for durable-delivery checks; separately stored input blocks and prefix messages retain their existing copy behavior. Recovery format version 1 and the public exports from `AgentSession` stay unchanged.

## Session context

| File | Responsibility |
| --- | --- |
| `session/compaction.ts` | Manual and automatic compaction lifecycle, pending requests, cancellation, thresholds, and overflow recovery. |
| `session/compaction-execution.ts` | Summary generation, extension interception, request accounting, persistence, and context rebuild ordering. |
| `session/refinement.ts` | Refinement admission, planning and application barriers, serialized plan ownership, and disposal drains. |
| `session/auto-refinement.ts` | Review triggers, cooldowns, pending reviews, timers, and automatic operation cleanup. |
| `session/refinement-execution.ts` | Planning against current dependencies, applying harness edits, and persisting outcomes and notices. |
| `session/continuation.ts` | Resuming work after compaction, settlement, cancellation, and ownership of continuation messages. |

Each owner keeps its mutable state and cleanup together. Typed host operations connect the owners to current model, authentication, extensions, storage, and scheduling. `AgentSession` composes them and retains public methods, events, and decisions that cross features, including goal and autonomous continuation admission. The summary algorithms and harness storage remain in their existing `core/` feature modules.

Preserve these boundaries when changing context behavior:

- Compaction releases its operation and reconnects event handling before resuming work. Summarization request accounting completes before the transcript append; failed persistence must preserve the existing live outcome disclosure.
- Refinement planning may overlap active work. Applying a plan waits for the relevant agent, event, compaction, and branch operations to settle, and rechecks their identities before mutating context. Serialized checkpoints claim a background plan once.
- A cancelled continuation settles its own waiters. Late results cannot clear a replacement operation or consume its messages. The commit lease is released before awaiting a continued agent turn, and checkpoint waiters are removed when cancellation wins.
- Public session methods delegate without additional asynchronous wrappers. Optional waits retain their original positions, and dependency callbacks read current runtime state when invoked.

## Validation

Controller tests live in `test/goals/`. Session integration coverage remains in `test/suite/agent-session-goal.test.ts`, `test/suite/agent-session-compaction-continuation.test.ts`, and `test/goal-continuation-quiescence.test.ts`.

Scheduler and commit-fence tests live in `test/session/`. Existing queue, action-contract, action-race, and compaction suites cover the integration with `AgentSession`, including pause, cancellation, restart, branch navigation, and goal continuation.

Shell-owner tests also live in `test/session/`. Session bash/persistence, prompt, queue, and side-question regression suites retain end-to-end coverage of scheduling and transcript behavior using the faux provider and controlled shell operations.

Compaction and continuation owner tests in `test/session/` exercise lifecycle and cancellation boundaries. Compaction, refinement, serialized refinement, queue, concurrency, and semantic-edge suites cover their integration with session persistence, goals, and disposal. `test/suite/session-refinement-owner.test.ts` checks the refinement owner boundary using the shared faux-provider harness.

Run the focused files from the coding-agent package root with the repository's prescribed Vitest command, then run `npm run check` from the repository root. Use faux providers for session tests.
