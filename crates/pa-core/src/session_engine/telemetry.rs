//! Session telemetry: the agent-event state machine behind the
//! `agent started` / `agent run completed` / `agent session ended` /
//! `tool executed` events. Behavioral port of the TS `installAgentTelemetry`
//! subscriber (`packages/coding-agent/src/core/telemetry.ts`).
//!
//! Divergence from the TS state machine, documented: the TS subscriber tracks
//! `turnActionActive` because the TS session loop can span several agent runs
//! inside one queued turn action. The Rust loop pairs every `AgentStart` with
//! exactly one `AgentEnd` per admitted run, so one run == one
//! `AgentStart..AgentEnd` window and no turn-action tracking is needed.
//!
//! Privacy contract: this module emits counter/duration/category facts only —
//! never prompt text, model output, tool arguments or results. Property
//! schema: `docs/telemetry-events.md` (schema version 1).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use pa_agent::agent::Subscription;
use pa_agent::types::{AgentEvent, AssistantMessage, StopReason, Usage};
use pa_telemetry::{base_properties, Properties, TelemetryClient, TelemetryClientConfig};
use serde_json::Value;

/// The execution mode the wiring layer resolved for this process, e.g.
/// "interactive" or "unknown" (TS `AgentExecutionMode` surface).
pub const EXECUTION_MODE_UNKNOWN: &str = "unknown";

/// Telemetry wiring supplied by the composition root (`SessionEngineConfig`).
/// `None` telemetry (opt-out) installs nothing.
pub struct TelemetryWiring {
    /// The shared client (base properties are stamped here, per event).
    pub client: TelemetryClient,
    /// Execution mode for base properties.
    pub execution_mode: Option<String>,
    /// Injectable clock (millis since epoch); defaults to system time.
    /// Tests pass a controlled clock to assert duration math.
    pub now: Option<Arc<dyn Fn() -> u64 + Send + Sync>>,
}

/// Installed session telemetry: the event subscription plus the in-memory
/// state the live agent events feed. The handle outlives the agent events and
/// finalizes the session on `end()`.
pub struct SessionTelemetry {
    client: TelemetryClient,
    state: Arc<Mutex<TelemetryState>>,
    execution_mode: String,
    /// `end()` runs exactly once (session close and later kill/shutdown
    /// paths may both reach it; only the first emits the ended event).
    ended: std::sync::atomic::AtomicBool,
    _subscription: Option<Subscription>,
}

impl SessionTelemetry {
    /// A handle with no live subscription: tests drive the state machine via
    /// [`handle_event`] against the shared state and use this handle for the
    /// finalize/end surface.
    #[cfg(test)]
    pub(crate) fn detached(
        client: TelemetryClient,
        state: Arc<Mutex<TelemetryState>>,
        execution_mode: String,
    ) -> Self {
        Self {
            client,
            state,
            execution_mode,
            ended: std::sync::atomic::AtomicBool::new(false),
            _subscription: None,
        }
    }
}

/// Everything the subscriber accumulates. Guarded by one mutex because the
/// agent delivers events serially, but the tracker is also fed from
/// compaction call sites outside the event stream.
pub(crate) struct TelemetryState {
    session_id: String,
    started_at: u64,
    totals: SessionTotals,
    active_run: Option<ActiveRun>,
    tool_starts: HashMap<String, u64>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

#[derive(Default)]
struct SessionTotals {
    run_count: u64,
    successful_run_count: u64,
    failed_run_count: u64,
    aborted_run_count: u64,
    prompt_count: u64,
    tool_call_count: u64,
    compaction_count: u64,
    usage: UsageTotals,
}

#[derive(Default)]
struct UsageTotals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total_tokens: u64,
    model_call_count: u64,
}

impl UsageTotals {
    fn add(&mut self, usage: &Usage) {
        self.input += usage.input;
        self.output += usage.output;
        self.cache_read += usage.cache_read;
        self.cache_write += usage.cache_write;
        self.total_tokens += usage.total_tokens;
        self.model_call_count += 1;
    }

    fn merge(&mut self, other: &UsageTotals) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.total_tokens += other.total_tokens;
        self.model_call_count += other.model_call_count;
    }
}

struct ActiveRun {
    started_at: u64,
    /// AgentEnd fired but the run is not finalized yet: the post-run
    /// compaction drain still counts into it (TS keeps the run open until
    /// the turn action deactivates; the Rust analog defers to the next
    /// AgentStart or session end).
    ended: bool,
    /// Wall time of AgentEnd: the run's duration freezes here (TS finalizes
    /// at turn-action deactivation, a few ms after AgentEnd; deferring the
    /// finalize must not stretch the duration across the idle gap).
    ended_at: Option<u64>,
    first_turn_started_at: Option<u64>,
    first_model_event_ms: Option<u64>,
    visible_ttft_ms: Option<u64>,
    current_turn_started_at: Option<u64>,
    model_latency_ms: u64,
    max_model_latency_ms: u64,
    turn_count: u64,
    tool_call_count: u64,
    tool_error_count: u64,
    compaction_count: u64,
    retry_count: u64,
    failover_count: u64,
    usage: UsageTotals,
    last_assistant: Option<AssistantMessage>,
}

/// Skills present at session start (adoption counts on `agent started`).
pub struct SkillCounts {
    pub skill_count: usize,
    pub python_skill_count: usize,
}

/// Install the telemetry subscriber on an agent and emit `agent started`.
/// The subscriber consumes every [`AgentEvent`]; the state it builds is
/// reachable through the returned handle for session-end finalization.
pub async fn install_session_telemetry(
    agent: &Arc<pa_agent::agent::Agent>,
    wiring: &TelemetryWiring,
    skill_counts: Option<SkillCounts>,
) -> anyhow::Result<SessionTelemetry> {
    let execution_mode = wiring
        .execution_mode
        .clone()
        .unwrap_or_else(|| EXECUTION_MODE_UNKNOWN.to_string());
    let now = wiring.now.clone().unwrap_or_else(|| Arc::new(now_millis));
    let client = wiring.client.clone();
    let state = Arc::new(Mutex::new(TelemetryState {
        session_id: uuid(),
        started_at: now(),
        totals: SessionTotals::default(),
        active_run: None,
        tool_starts: HashMap::new(),
        now,
    }));

    let subscriber_state = Arc::clone(&state);
    let subscriber_client = client.clone();
    let subscriber_mode = execution_mode.clone();
    let subscription = agent
        .subscribe(move |event, _signal| {
            let state = Arc::clone(&subscriber_state);
            let client = subscriber_client.clone();
            let execution_mode = subscriber_mode.clone();
            Box::pin(async move {
                if let Err(error) = handle_event(&client, &execution_mode, &state, event) {
                    // Telemetry must never fail the agent: swallow to a debug log.
                    tracing::debug!(error = %error, "session telemetry event failed");
                }
                Ok(())
            })
        })
        .await;

    let mut properties = base_properties(&execution_mode);
    {
        let state = state.lock().expect("telemetry state poisoned");
        properties.set("session_id", Value::from(state.session_id.as_str()));
        if let Some(counts) = skill_counts {
            properties.set("skill_count", Value::from(counts.skill_count as u64));
            properties.set(
                "python_skill_count",
                Value::from(counts.python_skill_count as u64),
            );
        }
    }
    client.track("agent started", properties);
    Ok(SessionTelemetry {
        client,
        state,
        execution_mode,
        ended: std::sync::atomic::AtomicBool::new(false),
        _subscription: Some(subscription),
    })
}

impl SessionTelemetry {
    /// A compaction completed (feed from the compaction seams; TS
    /// `compaction_end` handling). Counts toward the active run when one
    /// exists, exactly like the TS subscriber — compactions outside a run
    /// never inflate session totals.
    pub fn note_compaction(&self) {
        let mut state = self.state.lock().expect("telemetry state poisoned");
        if let Some(run) = state.active_run.as_mut() {
            run.compaction_count += 1;
        }
    }

    /// An auto-retry started (feed from the auto-retry seam; TS
    /// `auto_retry_start` handling). Only counts inside an active run.
    pub fn note_auto_retry(&self) {
        let mut state = self.state.lock().expect("telemetry state poisoned");
        if let Some(run) = state.active_run.as_mut() {
            run.retry_count += 1;
        }
    }

    /// A provider-failover switch happened (the failed turn re-routed to
    /// another configured provider serving the same model). Only counts
    /// inside an active run.
    pub fn note_provider_failover(&self) {
        let mut state = self.state.lock().expect("telemetry state poisoned");
        if let Some(run) = state.active_run.as_mut() {
            run.failover_count += 1;
        }
    }

    /// Finalize any active run, emit `agent session ended`, and flush.
    /// The host calls this at session close (TUI exit, worker shutdown,
    /// kill); the `ended` flag makes a second close path a no-op, matching
    /// the TS single `registerDisposeCallback` firing.
    pub async fn end(&self) -> anyhow::Result<()> {
        if self.ended.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        {
            let mut state = self.state.lock().expect("telemetry state poisoned");
            finalize_run(&self.client, &self.execution_mode, &mut state);
        }
        let mut properties = self.session_properties();
        {
            let state = self.state.lock().expect("telemetry state poisoned");
            let totals = &state.totals;
            properties.set(
                "duration_ms",
                Value::from((state.now)().saturating_sub(state.started_at)),
            );
            properties.set("prompt_count", Value::from(totals.prompt_count));
            properties.set("run_count", Value::from(totals.run_count));
            properties.set(
                "successful_run_count",
                Value::from(totals.successful_run_count),
            );
            properties.set("failed_run_count", Value::from(totals.failed_run_count));
            properties.set("aborted_run_count", Value::from(totals.aborted_run_count));
            properties.set("tool_call_count", Value::from(totals.tool_call_count));
            properties.set("compaction_count", Value::from(totals.compaction_count));
            properties.set(
                "model_call_count",
                Value::from(totals.usage.model_call_count),
            );
            properties.set("input_tokens", Value::from(totals.usage.input));
            properties.set("output_tokens", Value::from(totals.usage.output));
            properties.set("cache_read_tokens", Value::from(totals.usage.cache_read));
            properties.set("cache_write_tokens", Value::from(totals.usage.cache_write));
            properties.set("total_tokens", Value::from(totals.usage.total_tokens));
        }
        self.client.track("agent session ended", properties);
        self.client.flush().await
    }

    /// `session archived` (schema v1): the session reached the archive state
    /// (daemon `kill`). Lifetime in ms; emitted before `end()` on that path.
    pub fn note_archived(&self) {
        let mut properties = self.session_properties();
        {
            let state = self.state.lock().expect("telemetry state poisoned");
            properties.set(
                "duration_ms",
                Value::from((state.now)().saturating_sub(state.started_at)),
            );
        }
        self.client.track("session archived", properties);
    }

    /// `skill used`: a `/skill:<name>` submission expanded into its skill
    /// block. Feed from the `AgentSession::prompt_with_images` expansion
    /// seam; `source` reports how the invocation arrived (`prompt`,
    /// `steer`, `follow_up`).
    pub fn note_skill_used(&self, skill_name: &str, skill_kind: &str, source: &str) {
        let mut properties = self.session_properties();
        properties.set("skill_name", Value::from(skill_name));
        properties.set("skill_kind", Value::from(skill_kind));
        properties.set("source", Value::from(source));
        self.client.track("skill used", properties);
    }

    /// `agent command used`: builtin session commands only, canonical name.
    /// Feed from `session_commands::execute_session_command` (TS
    /// `captureAgentCommandUsed`).
    pub fn note_command_used(&self, command_name: &str) {
        let mut properties = self.session_properties();
        properties.set("command_name", Value::from(command_name));
        self.client.track("agent command used", properties);
    }

    /// Base properties + `session_id` for per-event properties.
    fn session_properties(&self) -> Properties {
        let mut properties = base_properties(&self.execution_mode);
        let state = self.state.lock().expect("telemetry state poisoned");
        properties.set("session_id", Value::from(state.session_id.as_str()));
        properties
    }
}

/// One agent event → state machine step. Split from `install` so tests can
/// drive scripted event sequences without a live agent.
fn handle_event(
    client: &TelemetryClient,
    execution_mode: &str,
    state: &Arc<Mutex<TelemetryState>>,
    event: AgentEvent,
) -> anyhow::Result<()> {
    let mut state = state.lock().expect("telemetry state poisoned");
    let now = (state.now)();
    match event {
        AgentEvent::AgentStart => {
            // The previous run finalizes here (not at AgentEnd): a post-run
            // compaction drained between AgentEnd and this start must land in
            // that run, exactly like the TS turn-action window. A missing
            // AgentEnd (misbehaving emitter) still cannot lose run facts.
            finalize_run_locked(client, execution_mode, &mut state);
            state.active_run = Some(ActiveRun {
                started_at: now,
                ended: false,
                ended_at: None,
                first_turn_started_at: None,
                first_model_event_ms: None,
                visible_ttft_ms: None,
                current_turn_started_at: None,
                model_latency_ms: 0,
                max_model_latency_ms: 0,
                turn_count: 0,
                tool_call_count: 0,
                tool_error_count: 0,
                compaction_count: 0,
                retry_count: 0,
                failover_count: 0,
                usage: UsageTotals::default(),
                last_assistant: None,
            });
        }
        AgentEvent::MessageStart { message } => {
            if message.role() == "user" {
                state.totals.prompt_count += 1;
            }
        }
        AgentEvent::TurnStart => {
            if let Some(run) = state.active_run.as_mut() {
                if run.first_turn_started_at.is_none() {
                    run.first_turn_started_at = Some(now);
                }
                run.current_turn_started_at = Some(now);
                run.turn_count += 1;
            }
        }
        AgentEvent::MessageUpdate {
            assistant_message_event,
            ..
        } => {
            if let Some(run) = state.active_run.as_mut() {
                if run.first_model_event_ms.is_none() {
                    if let Some(first_turn) = run.first_turn_started_at {
                        run.first_model_event_ms = Some(now.saturating_sub(first_turn));
                    }
                }
                if run.visible_ttft_ms.is_none() {
                    if let Some(first_turn) = run.first_turn_started_at {
                        let is_text_delta = matches!(
                            assistant_message_event.as_ref(),
                            pa_agent::stream::AssistantMessageEvent::TextDelta { delta, .. } if !delta.is_empty()
                        );
                        if is_text_delta {
                            run.visible_ttft_ms = Some(now.saturating_sub(first_turn));
                        }
                    }
                }
            }
        }
        AgentEvent::MessageEnd { message } => {
            if let pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(
                assistant,
            )) = message
            {
                if let Some(run) = state.active_run.as_mut() {
                    run.usage.add(&assistant.usage);
                    run.last_assistant = Some(assistant);
                    if let Some(turn_started) = run.current_turn_started_at.take() {
                        let latency = now.saturating_sub(turn_started);
                        run.model_latency_ms += latency;
                        run.max_model_latency_ms = run.max_model_latency_ms.max(latency);
                    }
                }
            }
        }
        AgentEvent::ToolExecutionStart { tool_call_id, .. } => {
            state.tool_starts.insert(tool_call_id, now);
        }
        AgentEvent::ToolExecutionEnd {
            tool_call_id,
            tool_name,
            is_error,
            ..
        } => {
            let started_at = state.tool_starts.remove(&tool_call_id);
            let duration_ms = started_at.map_or(0, |start| now.saturating_sub(start));
            if let Some(run) = state.active_run.as_mut() {
                run.tool_call_count += 1;
                if is_error {
                    run.tool_error_count += 1;
                }
            }
            state.totals.tool_call_count += 1;
            // `tool executed` (new v1 event): tool name + duration + outcome.
            let mut properties = base_properties(execution_mode);
            properties.set("session_id", Value::from(state.session_id.as_str()));
            properties.set("tool_name", Value::from(tool_name.as_str()));
            properties.set("duration_ms", Value::from(duration_ms));
            properties.set("is_error", Value::from(is_error));
            client.track("tool executed", properties);
        }
        AgentEvent::AgentEnd { .. } => {
            if let Some(run) = state.active_run.as_mut() {
                run.ended = true;
                run.ended_at = Some(now);
            }
        }
        // TurnEnd carries no facts the TS subscriber used (turn_count comes
        // from TurnStart); ToolExecutionUpdate is mid-execution progress.
        AgentEvent::TurnEnd { .. } | AgentEvent::ToolExecutionUpdate { .. } => {}
    }
    Ok(())
}

/// Finalize the active run and emit `agent run completed` (TS
/// `finalizeRun`), merging run totals into session totals.
fn finalize_run(client: &TelemetryClient, execution_mode: &str, state: &mut TelemetryState) {
    finalize_run_locked(client, execution_mode, state);
}

fn finalize_run_locked(client: &TelemetryClient, execution_mode: &str, state: &mut TelemetryState) {
    let Some(run) = state.active_run.take() else {
        return;
    };
    let now = (state.now)();
    let run_end = run.ended_at.unwrap_or(now);
    let outcome = run_outcome(run.last_assistant.as_ref());
    state.totals.run_count += 1;
    state.totals.tool_call_count += run.tool_call_count;
    state.totals.compaction_count += run.compaction_count;
    match outcome {
        "success" => state.totals.successful_run_count += 1,
        "aborted" => state.totals.aborted_run_count += 1,
        _ => state.totals.failed_run_count += 1,
    }
    state.totals.usage.merge(&run.usage);

    let mut properties = base_properties(execution_mode);
    properties.set("session_id", Value::from(state.session_id.as_str()));
    properties.set("outcome", Value::from(outcome));
    properties.set(
        "duration_ms",
        Value::from(run_end.saturating_sub(run.started_at)),
    );
    properties.set("visible_ttft_ms", opt_value(run.visible_ttft_ms));
    properties.set("first_model_event_ms", opt_value(run.first_model_event_ms));
    properties.set("model_latency_ms", Value::from(run.model_latency_ms));
    properties.set(
        "max_model_latency_ms",
        Value::from(run.max_model_latency_ms),
    );
    properties.set("model_call_count", Value::from(run.usage.model_call_count));
    properties.set("turn_count", Value::from(run.turn_count));
    properties.set("tool_call_count", Value::from(run.tool_call_count));
    properties.set("tool_error_count", Value::from(run.tool_error_count));
    properties.set("input_tokens", Value::from(run.usage.input));
    properties.set("output_tokens", Value::from(run.usage.output));
    properties.set("cache_read_tokens", Value::from(run.usage.cache_read));
    properties.set("cache_write_tokens", Value::from(run.usage.cache_write));
    properties.set("total_tokens", Value::from(run.usage.total_tokens));
    properties.set("compaction_count", Value::from(run.compaction_count));
    properties.set("retry_count", Value::from(run.retry_count));
    properties.set("failover_count", Value::from(run.failover_count));
    properties.set(
        "provider_category",
        Value::from(provider_category(
            run.last_assistant.as_ref().map(|m| m.provider.as_str()),
        )),
    );
    properties.set(
        "model_category",
        Value::from(
            run.last_assistant
                .as_ref()
                .map_or("unknown", |m| model_category(&m.model)),
        ),
    );
    properties.set(
        "error_category",
        error_category(run.last_assistant.as_ref()),
    );
    client.track("agent run completed", properties);
}

/// Track a supervision-lifecycle event (`daemon event`, schema v1): kinds
/// and counts only, never session payload. `exit_reason` rides only the
/// `worker_exited` kind.
pub fn track_daemon_event(client: &TelemetryClient, kind: &str, exit_reason: Option<&str>) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from(kind));
    if let Some(reason) = exit_reason {
        properties.set("exit_reason", Value::from(reason));
    }
    client.track("daemon event", properties);
}

/// Track the disk-archive sweep's `daemon event` (schema v1, kind
/// `sessions_archived`): a count only, never session payload.
pub fn track_sessions_archived(client: &TelemetryClient, count: usize) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from("sessions_archived"));
    properties.set("count", Value::from(count));
    client.track("daemon event", properties);
}

/// Track the live-catalog warm-up settle's `daemon event` (schema v1,
/// kind `catalog_refresh`): how many models the resolved
/// no-cold-start chain serves after the daemon's startup refresh. A
/// count only, never model ids, credentials, or catalog payloads.
pub fn track_catalog_refresh(client: &TelemetryClient, count: usize) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from("catalog_refresh"));
    properties.set("count", Value::from(count));
    client.track("daemon event", properties);
}

/// Track the abort supervision's terminal declaration (`daemon event`,
/// schema v1, kind `compaction_abort_declared`): the supervisor declared
/// a wedged worker's compaction aborted after its abort grace expired. A
/// count only, never session payload.
pub fn track_compaction_abort_declared(client: &TelemetryClient) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from("compaction_abort_declared"));
    properties.set("count", Value::from(1));
    client.track("daemon event", properties);
}

/// Track the parent-death child close's `daemon event` (schema v1, kind
/// `worker_children_closed`): how many resident RLM children the
/// supervisor stopped with a hard-killed parent worker. A count only,
/// never session payload.
pub fn track_worker_children_closed(client: &TelemetryClient, count: usize) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from("worker_children_closed"));
    properties.set("count", Value::from(count));
    client.track("daemon event", properties);
}

/// Build the product telemetry client from settings (opt-in already
/// resolved by the caller): PostHog sink when endpoint+key are configured
/// (env `PRIME_AGENT_TELEMETRY_ENDPOINT`/`_API_KEY` override settings
/// `telemetry.posthog.*`), the no-op sink when they are not (the operator
/// supplies values at deploy time), plus the local JSONL transparency
/// mirror (default on, `telemetry.localMirror` disables it). Never fails:
/// a broken install id falls back to a no-op client (TS parity — capture
/// disables itself when the installation identity cannot be created).
pub fn build_client(
    settings: &crate::settings::SettingsManager,
    agent_dir: &std::path::Path,
) -> TelemetryClient {
    let mut config = TelemetryClientConfig::new("disabled");
    let install_id = pa_telemetry::install_id(agent_dir);
    match install_id {
        Ok(id) => {
            config.install_id = id;
            let mut sinks: Vec<Arc<dyn pa_telemetry::TelemetrySink>> = Vec::new();
            let endpoint = posthog_endpoint(settings);
            if let Some(endpoint) = endpoint {
                sinks.push(Arc::new(pa_telemetry::PostHogSink::new(&endpoint)));
            } else {
                // Empty configuration: events queue nowhere (no-op), the
                // same posture an opt-out installs.
                sinks.push(Arc::new(pa_telemetry::NoopSink));
            }
            let local_mirror = settings
                .settings()
                .telemetry
                .as_ref()
                .and_then(|telemetry| telemetry.local_mirror)
                .unwrap_or(true);
            if local_mirror {
                sinks.push(Arc::new(pa_telemetry::FileSink::new(agent_dir)));
            }
            config.sinks = sinks;
        }
        Err(error) => {
            tracing::warn!(error = %error, "telemetry install id unavailable; telemetry disabled");
            config.sinks = vec![Arc::new(pa_telemetry::NoopSink)];
        }
    }
    TelemetryClient::spawn(config).unwrap_or_else(|error| {
        // No runtime on this thread: an inert client whose tracks are
        // counted as dropped. Telemetry must never fail the session.
        tracing::warn!(error = %error, "telemetry worker unavailable; events will drop");
        TelemetryClient::inert()
    })
}

/// Env overrides first, then settings `telemetry.posthog`.
fn posthog_endpoint(
    settings: &crate::settings::SettingsManager,
) -> Option<pa_telemetry::PostHogEndpoint> {
    if let Some(endpoint) = pa_telemetry::PostHogEndpoint::from_env() {
        return Some(endpoint);
    }
    let posthog = settings.settings().telemetry.as_ref()?.posthog.as_ref()?;
    let (endpoint, api_key) = (posthog.endpoint.as_deref()?, posthog.api_key.as_deref()?);
    if endpoint.trim().is_empty() || api_key.trim().is_empty() {
        return None;
    }
    Some(pa_telemetry::PostHogEndpoint::new(endpoint, api_key))
}

/// Run outcome per the TS `runOutcome`: aborted beats error beats success.
fn run_outcome(last_assistant: Option<&AssistantMessage>) -> &'static str {
    match last_assistant {
        Some(message) => match message.stop_reason {
            StopReason::Aborted => "aborted",
            StopReason::Error => "error",
            _ => "success",
        },
        None => "error",
    }
}

fn opt_value(value: Option<u64>) -> Value {
    value.map_or(Value::Null, Value::from)
}

/// TS `telemetryProviderCategory`.
pub fn provider_category(provider: Option<&str>) -> String {
    let Some(provider) = provider else {
        return "unknown".to_string();
    };
    let normalized = provider.to_ascii_lowercase();
    let categories = [
        "anthropic",
        "openai",
        "google",
        "prime",
        "openrouter",
        "bedrock",
        "vertex",
        "mistral",
        "groq",
        "xai",
    ];
    categories
        .iter()
        .find(|category| normalized.contains(*category))
        .map(|category| category.to_string())
        .unwrap_or_else(|| "custom".to_string())
}

/// TS `modelCategory`.
fn model_category(model: &str) -> &str {
    let normalized = model.to_ascii_lowercase();
    let categories = [
        "claude", "gpt", "o1", "o3", "o4", "gemini", "glm", "kimi", "qwen", "deepseek", "llama",
        "mistral",
    ];
    categories
        .iter()
        .find(|category| normalized.contains(*category))
        .copied()
        .unwrap_or("custom")
}

/// TS `errorCategory`: classify the assistant error message; null when the
/// run did not end in an error. Regex ports:
/// `\b401\b|\b403\b|auth|api.?key|credential|unauthori[sz]ed|forbidden` etc.
fn error_category(last_assistant: Option<&AssistantMessage>) -> Value {
    let Some(message) = last_assistant else {
        return Value::Null;
    };
    if message.stop_reason != StopReason::Error {
        return Value::Null;
    }
    let error = message
        .error_message
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let authentication = error.contains("auth")
        || error.contains("credential")
        || error.contains("unauthori")
        || error.contains("forbidden")
        || contains_any(&error, &["401", "403"])
        || near(&error, "api", "key");
    if authentication {
        return Value::from("authentication");
    }
    if contains_any(&error, &["429"]) || near(&error, "rate", "limit") || error.contains("quota") {
        return Value::from("rate_limit");
    }
    if error.contains("timeout") || error.contains("timed out") {
        return Value::from("timeout");
    }
    let context_limit = error.contains("context")
        || contains_in_order(&error, "token", "limit")
        || error.contains("too long")
        || contains_in_order(&error, "maximum", "length");
    if context_limit {
        return Value::from("context_limit");
    }
    if error.contains("network")
        || error.contains("socket")
        || error.contains("connection")
        || error.contains("fetch")
    {
        return Value::from("network");
    }
    if looks_like_5xx(&error) || error.contains("overload") || error.contains("unavailable") {
        return Value::from("provider_unavailable");
    }
    Value::from("other")
}

/// TS `a.?b` two-word match: the words with at most one character between.
fn near(haystack: &str, first: &str, second: &str) -> bool {
    haystack.match_indices(first).any(|(index, _)| {
        let rest = &haystack[index + first.len()..];
        rest.find(second).is_some_and(|offset| offset <= 1)
    })
}

/// TS `a.*b` two-word match: both present, `first` before `second`.
fn contains_in_order(haystack: &str, first: &str, second: &str) -> bool {
    haystack
        .find(first)
        .and_then(|first_at| haystack[first_at + first.len()..].find(second).map(|_| ()))
        .is_some()
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

/// `\b5\d\d\b` from the TS regex, approximated on a lowercased message: a
/// 500..=599 run bounded by non-digits.
fn looks_like_5xx(error: &str) -> bool {
    let bytes = error.as_bytes();
    for index in 0..bytes.len() {
        if bytes[index] != b'5' || index + 2 >= bytes.len() {
            continue;
        }
        let (b, c) = (bytes[index + 1], bytes[index + 2]);
        if !b.is_ascii_digit() || !c.is_ascii_digit() {
            continue;
        }
        let digit_before = index > 0 && bytes[index - 1].is_ascii_digit();
        let digit_after = index + 3 < bytes.len() && bytes[index + 3].is_ascii_digit();
        if !digit_before && !digit_after {
            return true;
        }
    }
    false
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use pa_agent::stream::AssistantMessageEvent;
    use pa_agent::types::{
        AgentMessage, AssistantContent, Message as LoopMessage, StopReason, TextContent,
        ToolResultContent, Usage,
    };
    use pa_telemetry::{MockSink, TelemetryClient, TelemetryClientConfig};

    use super::*;

    /// Controllable clock: tests move it between emits.
    #[derive(Clone, Default)]
    struct TestClock {
        millis: Arc<std::sync::atomic::AtomicU64>,
    }

    impl TestClock {
        fn set(&self, millis: u64) {
            self.millis
                .store(millis, std::sync::atomic::Ordering::Relaxed);
        }
    }

    fn client_for(mock: &std::sync::Arc<MockSink>) -> TelemetryClient {
        let mut config = TelemetryClientConfig::new("install-1");
        // Flush per event so assertions see every tracked event without an
        // explicit flush round-trip.
        config.batch_size = 1;
        config.flush_interval = Duration::from_secs(600);
        config.sinks = vec![mock.clone() as Arc<dyn pa_telemetry::TelemetrySink>];
        TelemetryClient::spawn(config).expect("spawn client")
    }

    struct Fixture {
        client: TelemetryClient,
        state: Arc<Mutex<TelemetryState>>,
        clock: TestClock,
        mock: std::sync::Arc<MockSink>,
    }

    /// A subscriber fed by scripted events — the state machine without a
    /// live agent (same `handle_event` call the subscription uses).
    fn fixture() -> Fixture {
        fixture_with_clock(TestClock::default())
    }

    fn fixture_with_clock(clock: TestClock) -> Fixture {
        let mock = std::sync::Arc::new(MockSink::new());
        let client = client_for(&mock);
        let now: Arc<dyn Fn() -> u64 + Send + Sync> = {
            let millis = clock.millis.clone();
            Arc::new(move || millis.load(std::sync::atomic::Ordering::Relaxed))
        };
        let state = Arc::new(Mutex::new(TelemetryState {
            session_id: "session-1".to_string(),
            started_at: 1_000,
            totals: SessionTotals::default(),
            active_run: None,
            tool_starts: HashMap::new(),
            now,
        }));
        Fixture {
            client,
            state,
            clock,
            mock,
        }
    }

    fn emit(fixture: &Fixture, event: AgentEvent) {
        handle_event(&fixture.client, "interactive", &fixture.state, event)
            .expect("telemetry event handled");
    }

    fn assistant_message() -> AssistantMessage {
        AssistantMessage {
            content: vec![AssistantContent::Text(TextContent {
                text: "private assistant text".to_string(),
                text_signature: None,
            })],
            api: "test".to_string(),
            provider: "openai".to_string(),
            model: "gpt-test".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage {
                input: 100,
                output: 20,
                cache_read: 50,
                cache_write: 0,
                total_tokens: 170,
                cost: Default::default(),
            },
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
        }
    }

    fn assistant_with_error(error: &str) -> AssistantMessage {
        let mut message = assistant_message();
        message.stop_reason = StopReason::Error;
        message.error_message = Some(error.to_string());
        message
    }

    fn user_message() -> AgentMessage {
        AgentMessage::user("private prompt")
    }

    fn text_delta_event(message: &AssistantMessage) -> AgentEvent {
        AgentEvent::MessageUpdate {
            message: AgentMessage::Standard(LoopMessage::Assistant(message.clone())),
            assistant_message_event: Box::new(AssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "private streamed text".to_string(),
                partial: message.clone(),
            }),
        }
    }

    fn message_end_event(message: AssistantMessage) -> AgentEvent {
        AgentEvent::MessageEnd {
            message: AgentMessage::Standard(LoopMessage::Assistant(message)),
        }
    }

    fn tool_execution_event(tool: &str, is_error: bool) -> (AgentEvent, AgentEvent) {
        (
            AgentEvent::ToolExecutionStart {
                tool_call_id: format!("{tool}-1"),
                tool_name: tool.to_string(),
                args: serde_json::json!({ "command": "private command" }),
            },
            AgentEvent::ToolExecutionEnd {
                tool_call_id: format!("{tool}-1"),
                tool_name: tool.to_string(),
                result: pa_agent::types::AgentToolResult {
                    content: vec![ToolResultContent::text("private tool output")],
                    details: serde_json::Value::Null,
                    terminate: None,
                },
                is_error,
            },
        )
    }

    /// Wait for the telemetry worker to drain tracked events, then read.
    async fn event_properties(
        mock: &MockSink,
        name: &str,
    ) -> Vec<serde_json::Map<String, serde_json::Value>> {
        tokio::time::sleep(Duration::from_millis(10)).await;
        mock.events()
            .iter()
            .filter(|event| event.name == name)
            .map(|event| {
                serde_json::to_value(&event.properties)
                    .expect("properties serialize")
                    .as_object()
                    .expect("properties are an object")
                    .clone()
            })
            .collect()
    }

    /// TS "emits aggregate metrics without message or tool content": one run
    /// through the full event sequence, exact counters, and no content leak.
    #[tokio::test]
    async fn emits_aggregate_metrics_without_content() {
        let fixture = fixture();
        let assistant = assistant_message();

        fixture.clock.set(1_000);
        emit(&fixture, AgentEvent::AgentStart);
        emit(
            &fixture,
            AgentEvent::MessageStart {
                message: user_message(),
            },
        );
        fixture.clock.set(1_010);
        emit(&fixture, AgentEvent::TurnStart);
        fixture.clock.set(1_035);
        emit(&fixture, text_delta_event(&assistant));
        fixture.clock.set(1_050);
        let (tool_start, tool_end) = tool_execution_event("bash", false);
        emit(&fixture, tool_start);
        emit(&fixture, tool_end);
        fixture.clock.set(1_100);
        emit(&fixture, message_end_event(assistant.clone()));
        fixture.clock.set(1_125);
        emit(
            &fixture,
            AgentEvent::AgentEnd {
                messages: Vec::new(),
            },
        );
        // Deferred finalize: AgentEnd alone must not seal the run yet (the
        // post-run compaction window stays open).
        assert!(event_properties(&fixture.mock, "agent run completed")
            .await
            .is_empty());

        // Session end finalizes the open run and emits the session totals.
        fixture.clock.set(1_200);
        let telemetry = SessionTelemetry::detached(
            fixture.client.clone(),
            fixture.state.clone(),
            "interactive".to_string(),
        );
        telemetry.end().await.unwrap();

        let runs = event_properties(&fixture.mock, "agent run completed").await;
        assert_eq!(runs.len(), 1);
        let run = &runs[0];
        assert_eq!(run["outcome"], serde_json::json!("success"));
        assert_eq!(run["duration_ms"], serde_json::json!(125));
        assert_eq!(run["visible_ttft_ms"], serde_json::json!(25));
        assert_eq!(run["first_model_event_ms"], serde_json::json!(25));
        assert_eq!(run["model_latency_ms"], serde_json::json!(90));
        assert_eq!(run["turn_count"], serde_json::json!(1));
        assert_eq!(run["tool_call_count"], serde_json::json!(1));
        assert_eq!(run["tool_error_count"], serde_json::json!(0));
        assert_eq!(run["input_tokens"], serde_json::json!(100));
        assert_eq!(run["output_tokens"], serde_json::json!(20));
        assert_eq!(run["cache_read_tokens"], serde_json::json!(50));
        assert_eq!(run["total_tokens"], serde_json::json!(170));
        assert_eq!(run["retry_count"], serde_json::json!(0));
        assert_eq!(run["provider_category"], serde_json::json!("openai"));
        assert_eq!(run["model_category"], serde_json::json!("gpt"));
        assert_eq!(run["session_id"], serde_json::json!("session-1"));
        assert_eq!(run["execution_mode"], serde_json::json!("interactive"));
        assert_eq!(run["schema_version"], serde_json::json!(1));

        // Privacy: no private prompt/tool/assistant text anywhere.
        let all = serde_json::to_string(&fixture.mock.events()).unwrap();
        assert!(!all.contains("private"));
        assert!(!all.contains("session-1.jsonl"));

        let ended = event_properties(&fixture.mock, "agent session ended").await;
        assert_eq!(ended.len(), 1);
        assert_eq!(ended[0]["duration_ms"], serde_json::json!(200));
        assert_eq!(ended[0]["prompt_count"], serde_json::json!(1));
        assert_eq!(ended[0]["run_count"], serde_json::json!(1));
        assert_eq!(ended[0]["successful_run_count"], serde_json::json!(1));
        assert_eq!(ended[0]["total_tokens"], serde_json::json!(170));
    }

    /// TS "waits for post-run compaction before finalizing run metrics":
    /// a compaction drained after AgentEnd still counts into that run.
    #[tokio::test]
    async fn post_run_compaction_counts_into_the_open_run() {
        let fixture = fixture();
        let assistant = assistant_message();

        emit(&fixture, AgentEvent::AgentStart);
        emit(&fixture, message_end_event(assistant.clone()));
        emit(
            &fixture,
            AgentEvent::AgentEnd {
                messages: Vec::new(),
            },
        );
        assert!(event_properties(&fixture.mock, "agent run completed")
            .await
            .is_empty());

        // The scheduled compaction drains between AgentEnd and the next run.
        let telemetry = SessionTelemetry::detached(
            fixture.client.clone(),
            fixture.state.clone(),
            "interactive".to_string(),
        );
        telemetry.note_compaction();
        emit(&fixture, AgentEvent::AgentStart);

        let runs = event_properties(&fixture.mock, "agent run completed").await;
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["compaction_count"], serde_json::json!(1));
    }

    /// A compaction with no open run (between runs) does not inflate session
    /// totals — TS counts compactions only while a run exists.
    #[tokio::test]
    async fn compaction_between_runs_is_not_counted() {
        let fixture = fixture();
        emit(&fixture, AgentEvent::AgentStart);
        emit(
            &fixture,
            AgentEvent::AgentEnd {
                messages: Vec::new(),
            },
        );
        let telemetry = SessionTelemetry::detached(
            fixture.client.clone(),
            fixture.state.clone(),
            "interactive".to_string(),
        );
        // No run finalized yet (one open, ended). Finalize it, then compact.
        emit(&fixture, AgentEvent::AgentStart);
        emit(
            &fixture,
            AgentEvent::AgentEnd {
                messages: Vec::new(),
            },
        );
        emit(&fixture, AgentEvent::AgentStart);
        emit(
            &fixture,
            AgentEvent::AgentEnd {
                messages: Vec::new(),
            },
        );
        emit(&fixture, AgentEvent::AgentStart);
        telemetry.note_compaction();
        let runs = event_properties(&fixture.mock, "agent run completed").await;
        // Third run has no compaction; second run has none either.
        assert!(runs
            .iter()
            .all(|run| run["compaction_count"] == serde_json::json!(0)));
    }

    /// Error and abort outcomes carry the TS `runOutcome` semantics and the
    /// error-category classifier.
    #[tokio::test]
    async fn error_and_aborted_outcomes() {
        let fixture = fixture();
        let failed = assistant_with_error("API Error: 429 rate limit exceeded");
        emit(&fixture, AgentEvent::AgentStart);
        emit(&fixture, message_end_event(failed));
        emit(
            &fixture,
            AgentEvent::AgentEnd {
                messages: Vec::new(),
            },
        );
        emit(&fixture, AgentEvent::AgentStart);
        let mut aborted_message = assistant_message();
        aborted_message.stop_reason = StopReason::Aborted;
        emit(&fixture, message_end_event(aborted_message));
        emit(
            &fixture,
            AgentEvent::AgentEnd {
                messages: Vec::new(),
            },
        );
        emit(&fixture, AgentEvent::AgentStart);

        let runs = event_properties(&fixture.mock, "agent run completed").await;
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0]["outcome"], serde_json::json!("error"));
        assert_eq!(runs[0]["error_category"], serde_json::json!("rate_limit"));
        assert_eq!(runs[1]["outcome"], serde_json::json!("aborted"));
        assert_eq!(runs[1]["error_category"], serde_json::Value::Null);
    }

    /// Error-category classifier matrix (TS `errorCategory`).
    #[test]
    fn error_categories() {
        fn category(error: &str) -> String {
            let message = assistant_with_error(error);
            error_category(Some(&message))
                .as_str()
                .expect("category")
                .to_string()
        }
        assert_eq!(category("Unauthorized: invalid api key"), "authentication");
        assert_eq!(category("403 forbidden"), "authentication");
        assert_eq!(category("credential expired"), "authentication");
        assert_eq!(category("429 quota exceeded"), "rate_limit");
        assert_eq!(category("request timed out"), "timeout");
        assert_eq!(category("context length too long"), "context_limit");
        assert_eq!(category("maximum context length exceeded"), "context_limit");
        assert_eq!(category("network socket connection reset"), "network");
        assert_eq!(category("fetch failed"), "network");
        assert_eq!(
            category("503 overloaded, service unavailable"),
            "provider_unavailable"
        );
        assert_eq!(category("something unexpected happened"), "other");
        assert_eq!(
            error_category(Some(&assistant_message())),
            serde_json::Value::Null
        );
    }

    /// Provider/model categories (TS `telemetryProviderCategory` /
    /// `modelCategory`).
    #[test]
    fn provider_and_model_categories() {
        assert_eq!(provider_category(Some("prime")), "prime");
        assert_eq!(provider_category(Some("ANTHROPIC")), "anthropic");
        assert_eq!(provider_category(Some("custom-host")), "custom");
        assert_eq!(provider_category(None), "unknown");
        assert_eq!(model_category("glm-4.6"), "glm");
        assert_eq!(model_category("Claude-Sonnet-4"), "claude");
        assert_eq!(model_category("kimi-k2"), "kimi");
        assert_eq!(model_category("my-finetune"), "custom");
    }

    /// `tool executed` events: tool name + duration + outcome, no arguments
    /// or results, per-execution.
    #[tokio::test]
    async fn tool_executed_events_carry_name_duration_outcome() {
        let fixture = fixture();
        emit(&fixture, AgentEvent::AgentStart);
        fixture.clock.set(1_000);
        let (tool_start, tool_end) = tool_execution_event("bash", false);
        emit(&fixture, tool_start);
        fixture.clock.set(1_250);
        emit(&fixture, tool_end);
        let (fail_start, fail_end) = tool_execution_event("edit", true);
        emit(&fixture, fail_start);
        fixture.clock.set(1_300);
        emit(&fixture, fail_end);

        let tools = event_properties(&fixture.mock, "tool executed").await;
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["tool_name"], serde_json::json!("bash"));
        assert_eq!(tools[0]["duration_ms"], serde_json::json!(250));
        assert_eq!(tools[0]["is_error"], serde_json::json!(false));
        assert_eq!(tools[1]["tool_name"], serde_json::json!("edit"));
        assert_eq!(tools[1]["is_error"], serde_json::json!(true));
        let all = serde_json::to_string(&fixture.mock.events()).unwrap();
        assert!(!all.contains("private command"));
        assert!(!all.contains("private tool output"));
    }

    /// `agent command used` events: canonical command name only.
    #[tokio::test]
    async fn command_used_event_shape() {
        let fixture = fixture();
        let telemetry = SessionTelemetry::detached(
            fixture.client.clone(),
            fixture.state.clone(),
            "interactive".to_string(),
        );
        telemetry.note_command_used("compact");
        fixture.client.flush().await.unwrap();
        let commands = event_properties(&fixture.mock, "agent command used").await;
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["command_name"], serde_json::json!("compact"));
    }

    /// `skill used` events: name, kind, and arrival source; never prompt
    /// content.
    #[tokio::test]
    async fn skill_used_event_shape() {
        let fixture = fixture();
        let telemetry = SessionTelemetry::detached(
            fixture.client.clone(),
            fixture.state.clone(),
            "interactive".to_string(),
        );
        telemetry.note_skill_used("web-search", "markdown", "prompt");
        telemetry.note_skill_used("agent-message", "python", "steer");
        fixture.client.flush().await.unwrap();
        let skills = event_properties(&fixture.mock, "skill used").await;
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0]["skill_name"], serde_json::json!("web-search"));
        assert_eq!(skills[0]["skill_kind"], serde_json::json!("markdown"));
        assert_eq!(skills[0]["source"], serde_json::json!("prompt"));
        assert_eq!(skills[1]["skill_name"], serde_json::json!("agent-message"));
        assert_eq!(skills[1]["skill_kind"], serde_json::json!("python"));
        assert_eq!(skills[1]["source"], serde_json::json!("steer"));
        let all = serde_json::to_string(&fixture.mock.events()).unwrap();
        assert!(!all.contains("skill content"));
    }

    /// `build_client`: settings-provided PostHog endpoint + the local mirror.
    #[tokio::test]
    async fn build_client_resolves_settings_posthog_and_mirror() {
        let dir = tempfile::tempdir().unwrap();
        let settings =
            crate::settings::SettingsManager::create(dir.path(), dir.path().join("agent"));
        // FileSink writes to the agent dir regardless of the PostHog sink.
        let client = build_client(&settings, &dir.path().join("agent"));
        assert!(!client.install_id().is_empty());
        assert_eq!(client.dropped_count(), 0);
    }

    /// Two runs in one session: totals merge, per-run events separate.
    #[tokio::test]
    async fn multiple_runs_merge_into_session_totals() {
        let fixture = fixture();
        let assistant = assistant_message();
        for _ in 0..2 {
            emit(&fixture, AgentEvent::AgentStart);
            emit(
                &fixture,
                AgentEvent::MessageStart {
                    message: user_message(),
                },
            );
            emit(&fixture, AgentEvent::TurnStart);
            emit(&fixture, message_end_event(assistant.clone()));
            emit(
                &fixture,
                AgentEvent::AgentEnd {
                    messages: Vec::new(),
                },
            );
        }
        emit(&fixture, AgentEvent::AgentStart);
        let runs = event_properties(&fixture.mock, "agent run completed").await;
        assert_eq!(runs.len(), 2);
    }
}
