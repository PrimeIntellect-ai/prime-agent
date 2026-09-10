# Session modules

`AgentSession` is the public entry point and coordinates work across features. Extracted features live here, grouped by responsibility. Each owner keeps its state and transitions together and receives only the dependencies it uses.

## Goals

| File | Responsibility |
| --- | --- |
| `goals/controller.ts` | Goal transitions, token and time accounting, continuation counts, and rollback checkpoints. |
| `goals/persistence.ts` | Reading the selected branch, flushing goal records, and deciding whether a branch can receive an initial goal. |
| `goals/commands.ts` | Parsing `/goal` arguments into typed commands. |
| `../goals.ts` | Shared goal types, validation, serialization, and context-message formatting used by session clients. |

The controller depends on a load/save interface, an update callback, and a clock. It does not receive `AgentSession`, the agent loop, a kernel, or a UI object. Its state is read-only to callers; mutations go through named operations.

`AgentSession` retains responsibilities that cross features: authentication and tool readiness, queue admission, cancellation, compaction, and waiting for child agents. It validates requests and tells the goal controller when to transition or account for a message.

Three ordering rules matter during future extractions:

- Account for assistant usage before executing its tools, so a completing turn is included. Repeated delivery of the same assistant message must not count twice.
- Capture completion usage, clear stale queued goal context, and then persist and publish completion. The explicit completion callback preserves this order.
- A continuation rejected by new input restores both goal state and the accounting clock. Deferred child-work admission preserves the existing clock while restoring goal state.

The public goal payload and persisted `thread_goal_state` format remain shared contracts. Internal organization does not require a new daemon command or schema.

## Extending this structure

Use the same ownership rule for the next extraction: move a responsibility's fields, transitions, and cleanup together. Keep request parsing and storage adapters separate when they have independent dependencies. Avoid generic helper folders, modules that receive the entire session, and duplicate copies of feature state.

The next design review should cover input admission and turn lifecycle. The existing `SessionActionStore` already owns action transitions and tickets; build around that ownership when extracting queue dispatch, pause/cancel, and continuation decisions. Do not migrate all callers in the same change as the goal extraction.

## Validation

Controller tests live in `test/session/goals/`. Session integration coverage remains in `test/suite/agent-session-goal.test.ts`, `test/suite/agent-session-compaction-continuation.test.ts`, and `test/goal-continuation-quiescence.test.ts`.

Run the focused files from the coding-agent package root with the repository's prescribed Vitest command, then run `npm run check` from the repository root. Use faux providers for session tests.
