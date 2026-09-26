# Request timing (TS #2462 port)

Port of `packages/coding-agent/src/core/request-timing.ts` (TS PR #2462,
merged 2026-09-21) plus its doc sections in `docs/development.md` ("Request
timing") and `docs/settings.md` ("Diagnostics").

## What it adds

`requestTiming` setting / `PI_REQUEST_TIMING=1` env flag (zero overhead
when off): a per-request phase timeline written to the shared JSONL
diagnostic log (`~/.prime/agent/logs/agent.jsonl`) under the component
`coding-agent.request-timing`:

- `dispatchToPromptBuiltMs` (with `contextEntries` count) — client-side
  prompt build
- `promptBuiltToRequestSentMs` — payload build, hook chain, serialization
- `requestSentToFirstByteMs` — the wire/server phase: upload + provider
  queue + prefill
- `firstByteToFirstTokenMs`, `firstTokenToStreamDoneMs`
- `requestBytes`, `usage` (input/cacheRead/cacheWrite), `stopReason`,
  `outcome`

A long `requestSentToFirstByteMs` with a normal TTFT on the inference
dashboard = inference-side prefill or prompt-cache miss. A long
`promptBuiltToRequestSentMs` = client-side. The log answers "what is the
agent waiting for" directly.

## Enabling it

```bash
PI_REQUEST_TIMING=1 prime   # env (restart the daemon so worker processes inherit it)
```

or `"requestTiming": true` in `~/.prime/agent/settings.json` (applies to
sessions opened after the change). Either one enables the feature.

```bash
grep '"coding-agent.request-timing"' ~/.prime/agent/logs/agent.jsonl | tail -5
```

## Reading the timeline

Phases per request, in order. Each entry carries the gap it closed
(`phaseMs`) and the elapsed time since turn dispatch (`totalMs`);
`prompt-built` fires before the request has model or session fields, so
correlate it with the later entries by `requestSeq`. If a provider never
reports a phase (for example `request-sent` when no payload hook runs),
that delta is simply omitted:

| Phase | Meaning | A long gap here means |
|-------|---------|----------------------|
| `prompt-built` | Turn dispatched, prompt message array built | Client-side prompt build is slow |
| `request-sent` | Payload handed to the provider client | Client-side request build (payload hook chain, the `requestBytes` serialization) is slow |
| `first-byte` | HTTP response headers received (`requestBytes`: serialized request body size in UTF-8 bytes) | Upload of the request body plus provider TTFB (prefill, prompt-cache miss, queueing) |
| `first-token` | First streamed content block (what clears `Waiting`) | Stream parse delay; usually near zero |
| `stream-done` | Terminal event, with the summary below | Slow full stream |

The final entry (`msg: "request timing summary"`) carries every delta it
measured: `phases.dispatchToPromptBuiltMs`, `promptBuiltToRequestSentMs`,
`requestSentToFirstByteMs`, `firstByteToFirstTokenMs`,
`firstTokenToStreamDoneMs`, plus `contextEntries`, `requestBytes`,
`sessionId`, the final `usage`, and an `outcome` (`done`, `aborted` for an
early stop such as a user cancel, or `failed` when the provider failed
before or during the stream).

Reading it for a slow large-context turn:

- Large `promptBuiltToRequestSentMs` — the client is slow. Both phases
  before the request leaves are client-side.
- Large `requestSentToFirstByteMs` with a normal TTFT on the inference
  dashboard — the time is spent on the wire or inside inference before the
  dashboard's TTFT timer starts: uploading a multi-MB request body on a
  slow uplink, provider queueing, or prefilling an uncached prompt.
  `requestBytes` shows how much had to be uploaded.
- Prompt-cache miss check — the summary's `usage.cacheRead` near 0 with
  `cacheWrite` close to the full prompt size means the provider re-prefilled
  the whole context instead of reading its prompt cache.
- Every retry re-issues the turn and gets a fresh `requestSeq`, so a
  silent retry loop shows up as several request timelines.

One-shot completion calls outside the agent loop (compaction,
branch-summary, refinement) call the provider directly and are not logged.

## Rust mapping notes

| TS (#2462) | Rust |
|---|---|
| `core/request-timing.ts` | `crates/pa-core/src/session_engine/request_timing.rs` |
| `instrumentTransformContext` / `instrumentConvertToLlm` / `instrumentStreamFn` | same names, wrapping the pa-agent loop's `transform_context` / `convert_to_llm` / `stream_fn` seams at `engine.rs` `create_session` (TS `createAgentSession`) |
| WeakMap correlation by the context / LLM messages arrays | one per-session slot (the loop moves the arrays by value; one request at a time per loop) |
| `getLogger` + process sink → `logs/agent.jsonl` | `RequestTimingLog` writes `<agentDir>/logs/agent.jsonl` (same `ts`/`level`/`component`/`msg`/`pid` entry shape, 20 MiB rotation) |
| `SimpleStreamOptions.onPayload`/`onResponse` (loop options into the provider client) | `pa-agent` `StreamRequestOptions.on_payload`/`on_response`, bridged into `pa-ai` `StreamOptions` in `provider_adapter` |
| `settings-manager` `requestTiming` + `getRequestTiming()` | `crates/pa-core/src/settings`: the `requestTiming` key + `get_request_timing()` |
| vitest suite (`test/request-timing.test.ts`, 5 tests) | in-module tests in `request_timing.rs` (timeline shape: phase order, sequence identity, summary accounting, omission rules, flag-off silence, engine wiring) |

Deviations, both deliberate:

- The dispatch-marking `transform_context` seam exists only while timing
  is on. TS always wires `transformContext` (the extension context
  transform); the Rust engine has no transform seam yet, and wiring a
  pass-through one unconditionally would add a boxed closure to every
  turn of every session, flag or not. Off leaves the seam unset —
  bit-identical to before the port.
- Entry `sessionId` appears once the loop carries a session id. The Rust
  engine currently leaves the loop-level session id unset (a pre-existing
  gap — `pa-ai`'s session-affinity/prompt-cache-key path stays inert);
  TS always wires it. The seam tests cover the field directly.
