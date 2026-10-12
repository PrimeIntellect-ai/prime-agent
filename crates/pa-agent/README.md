# pa-agent

The agent loop.

## Scope
Turn loop: drives a provider stream, dispatches tool calls, enforces max-turn and sequencing semantics, handles partial streams, retries on stream failure, propagates aborts.

## Non-goals
No tool implementations (pa-core), no providers (pa-ai), no session persistence, no UI. The loop is tool-agnostic: it receives a `ToolDispatcher` boundary.

## Public API
`run_loop` (session inputs -> stream of loop events), `ToolDispatcher` trait. Loop internals `pub(crate)`.

## Depends on
No workspace dependencies. The proxy transport uses the already-resolved
`rustls` PEM iterator and DER validation to retain the valid prefix of
`NODE_EXTRA_CA_CERTS` when a later certificate is malformed, matching Node.
reqwest's whole-bundle parser discards that prefix on error; directly using
the existing transport dependency avoids a peer dependency on pa-ai and adds
no package version or public API.
