# pa-telemetry

Modular telemetry: the event schema, queueing/batching, sinks, and the
pseudonymous installation identity for Prime Agent product analytics
(PostHog-backed, self-hostable).

## Scope

- `Properties`: primitive-only property maps (the privacy boundary — strings,
  numbers, booleans, null; structured values are rejected at insertion).
- `TelemetryEvent`: `{name, timestamp, properties}` records; name catalog is
  versioned in `docs/telemetry-events.md`.
- `TelemetryClient`: non-blocking `track(event, properties)`, `flush`,
  `shutdown`. One background worker, capped queue (drop-oldest), batched
  flush (size + interval + explicit), fan-out to every sink. Best-effort by
  contract: never blocks, never panics, never fails the agent.
- `TelemetrySink` trait + shipped sinks: `PostHogSink` (batched capture API,
  endpoint + project key from env/settings — nothing compiled in, empty
  configuration resolves to `NoopSink`; a 401 is terminal — bad or
  missing-scope credentials disable the sink for the process instead of
  re-requesting every flush), `FlagsClient` (PostHog decide v3
  feature flags with a 5-minute TTL cache, defaults offline; a 401 stops
  the decide polling the same way),
  `FileSink` (local JSONL transparency mirror at `<agentDir>/telemetry.jsonl`),
  `NoopSink` (opt-out fast path), `MockSink` (tests, also re-exported for
  downstream crate tests).
- `install_id`: `<agentDir>/telemetry.json` `{version, installationId}`,
  exclusive 0600 create, validated on load (TS parity).
- `rename_onto`: the shared rename-onto-destination primitive for durable
  persist writes (TS `renameOntoSync`: bounded win32 destination-busy
  retry, `10ms * attempt` backoff, every failure immediate off Windows).
  Lives in this crate because every persist owner (pa-core's settings and
  session writes, pa-daemon's descriptors/journals/session store, this
  crate's install id) already depends on it while it depends on no other
  workspace crate; pa-core re-exports it as `platform::rename_onto` so its
  platform wall stays the engine's single platform entry.
- Env override resolution for the opt-in posture: `PI_OFFLINE`,
  `DO_NOT_TRACK`, `PRIME_AGENT_TELEMETRY`.

## Non-goals

- No settings reading: the enabled/disclosure flow is owned by pa-core
  settings + pa-cli wiring (this crate only answers "does the environment
  override?").
- No event emission from this crate: seams live in pa-core/pa-daemon/pa-cli,
  which call `track` with schema-documented events.
- No prompt/session content, tool arguments, file paths, or user identity —
  by construction (primitives-only properties).
- No retries or delivery guarantees: batches are best-effort and offline-safe
  (dropped on failure), matching the TS product.

## Public API

- `TelemetryClient` / `TelemetryClientConfig` (`track`, `flush`, `shutdown`,
  `dropped_count`, `install_id`, `spawn`)
- `TelemetrySink` trait, `SinkOutcome`
- `Properties`, `TelemetryEvent`
- `install_id(agent_dir)`
- `rename_onto(from, to)`
- `env_telemetry_override()`, `parse_bool_override(value)`
- Sinks: `PostHogSink`, `FileSink`, `NoopSink`, `MockSink` (+ `RecordedBatch`)

## Placement

Depends on no workspace crate (sits beside pa-types at the bottom of the
dependency graph). Consumers: pa-core, pa-daemon, pa-cli. See
`docs/telemetry-design.md` for the full design and `ARCHITECTURE.md`.
