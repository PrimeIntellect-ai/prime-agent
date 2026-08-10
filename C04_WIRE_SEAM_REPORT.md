# C03 generic safe-terminal envelope report

## Contract delivered

C03 now owns one durable terminal-envelope variant only: `rlm_safe_terminal_result` with the exact `details` shape `{ kind: "safe_terminal_result_v1", projection: string }`. The `projection` is an opaque caller-produced safe JSON string. C03 checks its JavaScript string type and UTF-8 byte size only as part of the full stable terminal-message 64 KiB cap. It never parses, validates, sanitizes, or reserializes the projection's JSON.

`content` is separately supplied bounded human presentation (16,384 characters). It is intentionally not compared with or derived from `projection`. The exported `createRlmSafeTerminalResultTerminalMessage(content, projection, timestamp)` constructor accepts these already-sanitized caller inputs and creates the exact envelope.

The generic envelope is accepted by the existing durable ledger/outbox/inbox/consumed transport. Stable-message digest identity and restart recovery therefore retain the exact message once. Legacy terminal variants retain their established 16,384-character and 24 KiB envelope bounds.

## Focused proof

The focused seam test proves exact keys, verbatim opaque projection retention, arbitrary mismatched human presentation, full-envelope near-cap rejection, legacy-cap isolation, deterministic digest/idempotence, outbox/inbox round-trip, restart/materialization, and malformed JSONL recovery. It uses only temporary local artifacts; no provider or queue is involved.
