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

The existing `ActionStore` in `core/session-action-store.ts` owns queued actions, their transitions, and delivery/completion tickets. `AgentSession` still prepares and dispatches those actions, serializes transcript commits, and coordinates goals, child agents, and compaction. These responsibilities can move separately without making the scheduler depend on the session's storage, kernel, or extension APIs.

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

The next extraction should move action preparation and dispatch into a separate owner while preserving their delivery, rollback, and cross-feature ordering rules.

## Validation

Controller tests live in `test/goals/`. Session integration coverage remains in `test/suite/agent-session-goal.test.ts`, `test/suite/agent-session-compaction-continuation.test.ts`, and `test/goal-continuation-quiescence.test.ts`.

Scheduler and commit-fence tests live in `test/session/`. Existing queue, action-contract, action-race, and compaction suites cover the integration with `AgentSession`, including pause, cancellation, restart, branch navigation, and goal continuation.

Run the focused files from the coding-agent package root with the repository's prescribed Vitest command, then run `npm run check` from the repository root. Use faux providers for session tests.
