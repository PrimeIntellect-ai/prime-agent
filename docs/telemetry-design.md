# pa-telemetry: modular telemetry library (design)

Status: **implemented** (crate + seams landed on `lane/telemetry`; catalog
lives in `docs/telemetry-events.md`). Section 11 records the reviewed decisions.
Roadmap item 7. TS ground truth: `packages/coding-agent/src/core/telemetry.ts` (+ its test
suite). Operator intent: a modular, well-integrated telemetry library against our PostHog
endpoint so usage / feature adoption is easy to track.

## 1. Goals

1. One small crate (`pa-telemetry`) that owns event emission end to end: schema, queueing,
   batching, sinks, install identity, opt-in resolution.
2. PostHog as the primary sink (batched capture API), endpoint + project key configurable so
   the whole stack is self-hostable.
3. Emission seams at well-defined product points (section 6), each carrying a stable,
   versioned, documented property schema.
4. Adoption backbone: every new product feature ships its adoption event in the same PR as
   the feature. Proposed as a repo convention in AGENTS.md (section 8).
5. User-observable transparency: a local JSONL mirror of everything emitted.

Non-negotiable privacy contract (unchanged from TS):

- Pseudonymous only: an anonymous installation id + session id. No user identity, no auth
  tokens, no machine hostnames.
- NEVER prompt/session content, model output text, tool arguments/results, file paths, or
  repository data. Sinks receive property maps only, and the client rejects property values
  that are not JSON primitives (string/number/bool/null).
- Opt-out posture identical to the TS product: default-on with disclosure + one-line opt-out.

## 2. Crate placement and public API

`pa-telemetry` sits at the bottom of the dependency graph beside `pa-types` and depends on no
workspace crate. Consumers: `pa-core` (session seams), `pa-daemon` (supervision seams),
`pa-cli` (startup/onboarding seams). pa-tui keeps depending on pa-types only; the TUI seams
are owned by the composition root (pa-cli) through the existing sink trait pattern it already
implements for onboarding persistence.

Public API (everything else `pub(crate)`):

```rust
/// Primitive-only property map (JSON primitives enforced at the boundary).
pub struct Properties(/* serde_json::Map<String, Value>, primitives only */);
impl Properties { pub fn set(&mut self, key: &str, value: impl Into<Value>); }

/// A single telemetry event (PostHog `capture` row).
pub struct TelemetryEvent { pub name: String, pub timestamp: OffsetDateTime-or-ms, pub properties: Properties }

/// Where batches go. Implementations must never fail the agent; errors are
/// reported and the batch is dropped or re-queued per policy.
pub trait TelemetrySink: Send + Sync {
    fn send_batch(&self, install_id: &str, events: Vec<TelemetryEvent>)
        -> impl Future<Output = SinkOutcome> + Send;
}

pub enum SinkOutcome { Sent, Dropped /* best-effort, offline-safe */ }

/// The client: track() never blocks; a background task owns queue/batch/flush.
pub struct TelemetryClient;
impl TelemetryClient {
    pub fn spawn(config: TelemetryClientConfig) -> anyhow::Result<Self>;
    pub fn track(&self, name: &str, properties: Properties);     // channel send, non-blocking
    pub async fn flush(&self) -> anyhow::Result<()>;              // drain queue now
    pub async fn shutdown(self) -> anyhow::Result<()>;            // flush once, stop worker
}

pub struct TelemetryClientConfig {
    pub install_id: InstallId,        // created/loaded by pa-telemetry from <agentDir>/telemetry.json
    pub base_properties: Properties,   // enrichment: version, os, arch, install_method, execution_mode...
    pub batch_size: usize,             // default 10 (TS parity)
    pub flush_interval: Duration,      // default 10s (TS parity)
    pub request_timeout: Duration,     // default 1.5s (TS parity)
    pub queue_capacity: usize,         // default 1024; drop-oldest on overflow
    pub sinks: Vec<Arc<dyn TelemetrySink>>, // fan-out, all sinks get every batch
}

/// Env-only opt-in resolution shared by every host crate (pa-core owns the
/// settings half; pa-telemetry never depends on pa-core).
pub fn env_allows_telemetry() -> bool; // PI_OFFLINE, DO_NOT_TRACK, PRIME_AGENT_TELEMETRY

/// Sinks shipped in-crate.
pub struct PostHogSink;   // POST {endpoint}/batch/ — see section 5
pub struct FileSink;      // append JSONL batches to <agentDir>/telemetry.jsonl
pub struct NoopSink;      // opted-out fast path
pub struct MockSink;      // test fixture, also used by downstream crate tests
```

`InstallId` parity: `<agentDir>/telemetry.json` `{version: 1, installationId: uuid}` created
atomically 0600 on first use (TS `getOrCreateTelemetryInstallationId`), validated on load.

## 3. Client behavior

- `track` pushes onto an mpsc channel; a background tokio task drains into a capped queue
  (drop-oldest, counter for dropped events). Never blocks or fails the caller.
- Flush when queue reaches `batch_size`, or every `flush_interval` (whichever first), or on
  explicit `flush()`/`shutdown()`. One batch in flight; queued batches follow.
- Per-sink failure policy: HTTP failure or timeout drops the batch (TS parity — best-effort,
  offline-safe, no retry storm). FileSink failure drops too but is logged via `tracing`.
- `shutdown(timeout)` drains and flushes once, bounded (default 2s), then stops the worker.
- No timer threads/daemons; one tokio task per client, named for diagnostics.

## 4. Opt-in posture (parity + current wiring gaps)

TS behavior (telemetry.ts / agent-session-services.ts / main.ts), to preserve exactly:

1. Enabled = env override first, then settings. Env precedence: `PI_OFFLINE` truthy disables;
   `DO_NOT_TRACK` truthy disables; `PRIME_AGENT_TELEMETRY` truthy/falsy overrides.
   Settings: `telemetry.enabled` in global/project/runtime scopes, default true, AND of all
   scopes (Rust `SettingsManager::get_telemetry_enabled` already matches).
2. Disclosure: on first launch with telemetry enabled, an info diagnostic announces the
   pseudonymous metrics and the opt-out paths, then `telemetry.noticeShown` persists it.
   Deferred on the very first interactive run (onboarding owns that screen; TS
   `deferTelemetryNoticeForOnboarding`). Rust: `notice_shown` settings exist; the disclosure
   itself is missing and ships in this lane.
3. Derived `telemetryDisabled`: TS main.ts computes `telemetryDisabled = isTelemetryEnabled ?
   undefined : true` into the runtime config; sessions created with it never install the
   telemetry subscriber. Rust: the `telemetry_disabled` field exists in
   pa-cli `RuntimeConfig`, pa-types worker/command wire types, and daemon descriptors — but
   pa-cli lib.rs currently hardcodes `false` and pa-daemon hardcodes `None`. This lane wires
   them (CLI start → worker descriptor → create/attach commands) and ports the TS
   `assertTelemetryAttachAllowed` guard: a telemetry-disabled client may not attach to a
   worker running with telemetry enabled ("Cannot attach to this active agent while telemetry
   is disabled...").
4. Depth: telemetry installs only for rlm-depth-0 sessions (TS parity — subagents never
   double-report).

Posture note: "opt-in" here means default-on-disclosed-with-opt-out, identical to the TS
product; nothing else changes.

## 5. PostHog integration

Wire format (PostHog capture v2 batch API):

```
POST {endpoint}/batch/
{ "api_key": "<project key>",
  "batch": [ { "event": "agent started",
               "distinct_id": "<installationId>",
               "timestamp": "<iso>",
               "properties": { ... } } ] }
```

- Endpoint resolution (approved): env `PRIME_AGENT_TELEMETRY_ENDPOINT` /
  `PRIME_AGENT_TELEMETRY_API_KEY` → settings `telemetry.posthog.endpoint` /
  `telemetry.posthog.apiKey`. No compiled-in endpoint or key ships in the
  binary; an EMPTY resolved configuration yields `NoopSink` (the operator
  supplies values at deploy time). Self-hostable by configuring both. The TS
  private-relay wire format is out of scope.
- `distinct_id` = installation id → PostHog cohorts/breakdowns by any property (version,
  platform, model) work with zero extra machinery.
- Feature flags: `FlagsClient` hits `{endpoint}/decide/?v=3` with `{api_key, distinct_id}`,
  caches flags in-memory (5 min TTL), and returns defaults when offline. v1 ships the client +
  a `flag_enabled(name, default)` accessor; product features adopt flags gradually from there.
  No local persistence, no identified users.
- User-Agent `prime-agent/<version>` on capture/decide requests (TS parity).

Schema versioning: every event carries `schema_version: 1` (property) and the full catalog is
documented in `docs/telemetry-events.md`; breaking property changes bump the version, additive
changes do not.

## 6. Event catalog (schema v1) and seams

Base properties on every event (TS `baseProperties` parity; new fields marked +):
`version`, `os_family`, `architecture`, `install_method` (+ value `binary` for the compiled
Rust build), `execution_mode`, `schema_version` (+), and the platform-fidelity set the TS
product ships (`libc`, `libc_version`, `cpu_baseline`, `os_release`, `os_product_version` —
populated where the Rust build can determine them; `null` when unknown, never faked).

TS-matching events (names + properties kept for comparability):

| event | properties (beyond base) | seam in current Rust code |
|---|---|---|
| `agent started` | `session_id` | session creation: pa-core engine `create_session` caller side; daemon worker `handle_create`; depth-0 only |
| `agent run completed` | `outcome` (success/error/aborted), `duration_ms`, `visible_ttft_ms`, `first_model_event_ms`, `model_latency_ms`, `max_model_latency_ms`, `model_call_count`, `turn_count`, `tool_call_count`, `tool_error_count`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `compaction_count`, `retry_count`, `provider_category`, `model_category`, `error_category` | new `session_engine::telemetry` subscriber on the pa-agent `AgentEvent` stream (AgentStart/AgentEnd/TurnStart/TurnEnd/MessageStart(user)/MessageEnd/ToolExecutionEnd + auto-retry/compaction counters) — direct port of TS `installAgentTelemetry` state machine |
| `agent session ended` | `duration_ms`, `prompt_count`, `run_count`, `successful_run_count`, `failed_run_count`, `aborted_run_count`, `tool_call_count`, `compaction_count`, `model_call_count`, token totals | same subscriber, session dispose/close seam (daemon worker session close, CLI interactive exit) |
| `agent command used` | `command_name` (builtin only) | `session_engine::session_commands::execute_session_command` (the single dispatch point pa-daemon/ACP already route through) |
| `onboarding completed` | `duration_ms`, `outcome` (success/error/aborted), `auth_category`, `provider_category` | pa-cli onboarding completion (the `mark_onboarding_complete` sink trait the CLI already implements for the TUI) |

New v1 events (adoption backbone; lowercase-space naming kept for continuity):

| event | properties | seam |
|---|---|---|
| `tool executed` | `tool_name`, `duration_ms`, `is_error` | `ToolExecutionStart`/`End` pairing in the same agent-event subscriber |
| `skill used` | `skill_name`, `skill_kind` (command/python), `source` (builtin/user/package) | slash-command skill execution in `session_commands`; Python-skill adoption v1 = load inventory counts on `agent started` (`skill_count`, `python_skill_count`), not per-call kernel events |
| `mcp connector used` | `server_name`, `action` (config/refresh/login) — server name ONLY | pa-core `mcp.rs` host handlers (`mcp.config`, `mcp.refresh`, optional `mcp.begin_login`) |
| `kernel bootstrap` | `duration_ms`, `cold` (bool), `outcome` | `ReplKernelManager::start` (kernel/manager/startup.rs) |
| `startup` | `duration_ms`, `phase_timings` (primitive map), `execution_mode` | pa-cli `run()` → first interactive frame; the `PI_STARTUP_BENCHMARK` phase timers |
| `daemon event` | `kind` (worker_spawned/worker_exited/worker_restarted/attach/reattach/detach/sessions_archived/worker_children_closed), plus counts only | pa-daemon supervisor worker lifecycle + attach flows |
| `session archived` | `duration_ms` (lifetime) | session archive path (session manager archive seam) |

Prohibited by construction: any event property carrying content. Code review gate in
section 8.

## 7. FileSink (transparency)

When telemetry is enabled, a `FileSink` mirrors every batch as JSONL lines to
`<agentDir>/telemetry.jsonl` (one event per line, `{name, timestamp, properties,
distinct_id}`), so any user can see exactly what leaves the machine. Toggle via
`telemetry.localMirror` (default on). File is 0600, append-only, size-capped by simple
rotation (rename to `.1` at 5 MB).

## 8. Repo convention (AGENTS.md)

Add to the Conventions section (no branding rule exists in AGENTS.md today; this lands next to
the existing conventions):

> Every user-visible feature ships its adoption telemetry event in the same PR: the event
> name + properties are added to `docs/telemetry-events.md` (schema versioned), and the seam
> emits it from day one. Telemetry properties never carry prompt, session, or file content.

## 9. Testing

- pa-telemetry unit: queue cap/drop-oldest, batch-size and interval flush, timeout, shutdown
  drain; PostHog wire shape against a local tokio TCP HTTP stub; FileSink JSONL + rotation;
  install-id atomic create/validation (concurrent create); env resolution matrix; properties
  primitive-only enforcement. `MockSink` in-crate.
- pa-core unit: port the TS `telemetry.test.ts` behavioral cases — run/session totals, TTFT,
  error categories, abort outcome — against a scripted `AgentEvent` stream + MockSink.
- e2e (pa-cli): `PRIME_AGENT_TELEMETRY=0` / `DO_NOT_TRACK=1` → no telemetry file, no
  disclosure; enabled + endpoint pointed at a local stub server → batch arrives with the
  documented schema. Attach guard: disabled client attaching to enabled worker errors
  (differential text vs TS where feasible).
- Verifier evidence in the PR: test output + the e2e stub capture dump.

## 10. Staging (small commits on lane/telemetry)

1. Crate skeleton + properties/event/install-id + client (queue/batch/flush) + Noop/Mock/File
   sinks, unit tests.
2. PostHogSink + FlagsClient + endpoint/key config, HTTP stub tests.
3. Schema doc `docs/telemetry-events.md` (full property tables, versioned).
4. pa-core session subscriber (`session_engine::telemetry`) + `session archived`,
   `tool executed`, `agent command used`; TS test-case ports.
5. Opt-in wiring: env resolution helper, disclosure notice (deferred-on-onboarding parity),
   pa-cli `telemetry_disabled` computation, pa-daemon descriptor propagation +
   `assertTelemetryAttachAllowed` port.
6. Kernel bootstrap, startup, daemon event, mcp, skills seams.
7. AGENTS.md convention + ARCHITECTURE.md crate row/dependency diagram update.

## 11. Decisions from review

1. RESOLVED (approved): direct PostHog, config-first resolution (env → settings); empty
   configuration resolves to `NoopSink` until the operator supplies endpoint + key. No key
   committed. TS relay format out of scope.
2. RESOLVED (approved): feature flags v1 = fetch + `flag_enabled(name, default)` client
   only; no product gating in this PR.
3. `install_method` values for the Rust binary: single `binary` now, refine later
   (additive property).
4. RESOLVED (approved): FileSink local mirror stays default-on (covered in the onboarding
   disclosure).
