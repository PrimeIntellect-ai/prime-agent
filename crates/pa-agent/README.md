# pa-agent

The agent loop.

## Scope
Turn loop: drives a provider stream, dispatches tool calls, enforces max-turn and sequencing semantics, handles partial streams, retries on stream failure, propagates aborts.

## Non-goals
No tool implementations (pa-core), no providers (pa-ai), no session persistence, no UI. The loop is tool-agnostic: it receives a `ToolDispatcher` boundary.

## Public API
`run_loop` (session inputs -> stream of loop events), `ToolDispatcher` trait. Loop internals `pub(crate)`.

## Depends on
No workspace dependencies.

Tool callback callers can select `ToolHookContextMode` on `AgentOptions` or
`AgentLoopConfig`. The default `Full` preserves the callback context contract;
`Omit` supplies an empty context without cloning session history. Prime Agent's
external command hooks use `Omit` because their protocol needs only invocation
metadata. This is an additive public configuration API, with no dependency changes.
Before/after tool callback metadata includes the resolved executor name separately
from the original model call, so policy adapters can match executable aliases
without rewriting call history.

`BeforeInputFn` gates submitted batches before their message events or context
append, and may return rows (for example hook context) admitted after the batch;
`BeforeModelFn` supports deferred initialization and may return rows admitted
before the model request. Both receive the active
run's cancellation signal and execute outside agent state locks. Submitted batch
metadata includes custom rows so an embedding can restore deferred bookkeeping
when admission is refused. Internal continuation rows retain separate provenance.
`FinalStopFn` runs only when the host's continuation hook reports
`Continuation::NaturalStop` (a missing hook means every stop is natural;
`Continuation::Held` means the host owns the boundary) and allows one feedback
continuation per run. These
are additive provider-independent callback APIs, not process execution facilities.
