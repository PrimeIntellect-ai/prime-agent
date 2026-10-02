//! Session telemetry: the agent-event state machine behind the session
//! events `agent started`, `agent run completed` (one per user turn, every
//! per-call fact folded into it as aggregates), and `agent session ended`
//! (with the per-session counters); the TUI client reports `agent command
//! used`. Behavioral port of the TS `installAgentTelemetry` subscriber
//! (`packages/coding-agent/src/core/telemetry.ts`) plus the #2117 v2
//! enrichment.
//!
//! Divergence from the TS state machine, documented: the TS subscriber tracks
//! `turnActionActive` because the TS session loop can span several agent runs
//! inside one queued turn action. The Rust loop pairs every `AgentStart` with
//! exactly one `AgentEnd` per admitted run, so one run == one
//! `AgentStart..AgentEnd` window and no turn-action tracking is needed.
//! A retried turn re-enters the loop, so each retry attempt is its own
//! window: the failed window reports the error occurrence, the retry
//! window reports the recovery.
//!
//! Privacy contract: this module emits counter/duration/category facts only —
//! never prompt text, model output, tool arguments or results. Failed
//! model calls classify through [`super::error_classify`]: only fixed
//! diagnostics and reviewed fixed strings ride events.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use pa_agent::agent::Subscription;
use pa_agent::types::{AgentEvent, AssistantMessage, StopReason, Usage};
use pa_telemetry::{
    base_properties, Properties, RunTrigger, TelemetryClient, TelemetryClientConfig, ToolCategory,
};
use serde_json::Value;

use super::auto_retry::AutoRetryEvent;
use super::error_classify::classify_error_message;

// The one-shot daemon/worker event trackers (the `daemon event` and
// `model refused` one-shot surfaces the supervisor notes/adoption/sessions
// and model-allowlist seams call once per lifecycle event) moved to the
// child module at the same tree position (session_engine::telemetry::track);
// every member keeps its pub level and the pub use re-exports keep every
// external track_* path stable. ZERO bumps.
mod track;
pub use track::{
    track_catalog_refresh, track_compaction_abort_declared, track_daemon_event_summary,
    track_deleted_child_usage_captured, track_model_refused, track_sessions_archived,
    track_worker_adoption, track_worker_children_closed,
};

// The outcome/provider/model/error classification family (the TS
// `runOutcome`/`telemetryProviderCategory`/`modelCategory`/`errorCategory`
// ports and their string-matching helpers) moved to the child module at the
// same tree position (session_engine::telemetry::classify); provider_category
// keeps its pub level through the re-export (the external callers), and the
// four pub(super) bumps serve the facade's finalize_run_locked bare calls
// (and the childrens' use-super globs); the near/contains_* helpers stay
// private (classify-internal callers).
mod classify;
pub use classify::provider_category;

mod status;
use classify::{error_category, model_category, opt_value, run_outcome};
pub use status::{
    set_telemetry_enabled_text, telemetry_endpoint, telemetry_status_text, telemetry_switch,
    TelemetrySwitch,
};

// The inline unit battery moved to the child module at the same tree
// position (session_engine::telemetry::tests); its use-super glob keeps
// resolving through the facade bindings and re-exports above.
#[cfg(test)]
mod tests;

/// The execution mode the wiring layer resolved for this process, e.g.
/// "interactive" or "unknown" (TS `AgentExecutionMode` surface).
pub const EXECUTION_MODE_UNKNOWN: &str = "unknown";

/// Telemetry wiring supplied by the composition root (`SessionEngineConfig`).
/// `None` telemetry (opt-out) installs nothing.
/// A session's live opt-out switch: the enabled answer the recording
/// The recording seams ask the switch at turn boundaries (run and turn
/// starts) and cache the answer for the events in between: a mid-turn
/// opt-out is observed at the next boundary, and the client's flush
/// drops everything queued while the switch is off.
#[derive(Clone)]
pub struct RecordingSwitch {
    /// Env-then-settings resolution, asked live at the turn boundaries:
    /// false means telemetry is off right now.
    pub enabled: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl RecordingSwitch {
    /// A plain switch for the seams: recording gates live on `enabled`
    /// at the turn boundaries.
    #[must_use]
    pub fn test(enabled: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        Self { enabled }
    }
}

pub struct TelemetryWiring {
    /// The shared client (base properties are stamped here, per event).
    pub client: TelemetryClient,
    /// Execution mode for base properties.
    pub execution_mode: Option<String>,
    /// Injectable clock (millis since epoch); defaults to system time.
    /// Tests pass a controlled clock to assert duration math.
    pub now: Option<Arc<dyn Fn() -> u64 + Send + Sync>>,
    /// The live opt-out switch the recording seams consult at the turn
    /// boundaries: while it answers false there, the run state machine
    /// severs and nothing records until the next boundary, and the
    /// client drops captures queued while the switch is off. `None` is
    /// always on (tests and one-shot paths).
    pub telemetry_enabled: Option<RecordingSwitch>,
}

/// Installed session telemetry: the event subscription plus the in-memory
/// state the live agent events feed. The handle outlives the agent events and
/// finalizes the session on `end()`.
pub struct SessionTelemetry {
    client: TelemetryClient,
    state: Arc<Mutex<TelemetryState>>,
    execution_mode: String,
    counters: Arc<SessionCounters>,
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
            counters: Arc::default(),
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
    /// The live opt-out switch from the wiring: asked at the turn
    /// boundaries, never per event.
    telemetry_enabled: Option<RecordingSwitch>,
    /// The cached switch answer from the last turn boundary. Recording
    /// on any other event consults only this flag, so a streaming delta
    /// never re-reads and re-parses the settings file.
    recording: bool,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

/// Is recording on right now? `None` (tests, one-shot paths) is always
/// on; a set switch answers live. Called from under the state lock, so
/// the switch itself must never lock the telemetry state.
fn recording_on(state: &TelemetryState) -> bool {
    state
        .telemetry_enabled
        .as_ref()
        .is_none_or(|telemetry_switch| (telemetry_switch.enabled)())
}

/// While telemetry is off, the active run (if any) is severed: dropped
/// without emitting, together with its in-flight tables. The switch is
/// asked at the turn boundaries, so a run that spans an opt-out never
/// completes after the boundary that observes the off period — neither
/// its facts nor the off window's timing ride a later event.
fn sever_off_period_run(state: &mut TelemetryState) {
    state.active_run = None;
    state.tool_starts.clear();
}

/// One turn boundary (a run or turn start): ask the live switch, cache
/// the answer for the events until the next boundary, and cut the run
/// when the switch says off. Between boundaries nothing re-reads the
/// settings file — the client's flush drops everything queued while the
/// switch is off, which covers a mid-turn opt-out.
fn observe_turn_boundary(state: &mut TelemetryState) {
    state.recording = recording_on(state);
    if !state.recording {
        sever_off_period_run(state);
    }
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
    retry_count: u64,
    failover_count: u64,
    model_error_count: u64,
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

// The run's independent lifecycle flags (ended, retry pending, trigger
// pending, usage complete); an enum would not change the flow.
#[allow(clippy::struct_excessive_bools)]
struct ActiveRun {
    started_at: u64,
    /// `AgentEnd` fired but the run is not finalized yet: the post-run
    /// compaction drain still counts into it (TS keeps the run open until
    /// the turn action deactivates; the Rust analog defers to the next
    /// `AgentStart` or session end).
    ended: bool,
    /// Wall time of `AgentEnd`: the run's duration freezes here (TS finalizes
    /// at turn-action deactivation, a few ms after `AgentEnd`; deferring the
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
    /// An auto-retry (or provider failover) started after this run's
    /// failed attempt: the retried attempt's `AgentStart` continues this
    /// run instead of starting a new one (TS: one run per turn, retries
    /// counted in `retry_count`).
    retry_pending: bool,
    // v2 (#2117) per-run tracking:
    /// The run's uuid.
    run_id: String,
    /// 1-based ordinal of this run in the session.
    run_index: u64,
    /// The trigger is still undecided: a prompt-run emits its user
    /// `MessageStart` right after `AgentStart`; a continuation-run goes
    /// straight to model events.
    trigger_pending: bool,
    trigger: RunTrigger,
    first_reasoning_ms: Option<u64>,
    run_to_first_text_ms: Option<u64>,
    /// Sum of tool execution durations (the `tool` timing stage).
    tool_duration_ms: u64,
    /// Sum of auto-retry delays (the `retry_wait` timing stage).
    retry_wait_ms: u64,
    /// The largest gap between consecutive model stream events.
    max_stream_gap_ms: Option<u64>,
    last_stream_event_at: Option<u64>,
    /// Model calls whose response settled without an error stop reason.
    successful_model_call_count: u64,
    /// False once a model call ended in an error (#2117: pending or
    /// failed calls make usage incomplete).
    usage_complete: bool,
    /// Summed usage cost in USD (estimated; null when incomplete or
    /// pricing was unknown - the conservative direction).
    cost_usd: f64,
    /// Each model call's latency (the p50 on the run event).
    model_latencies: Vec<u64>,
    /// Failed model calls in the run (every retried attempt included).
    model_error_count: u64,
    /// Failed model calls by TS `error_category`.
    error_category_counts: std::collections::BTreeMap<&'static str, u64>,
    /// Summed compaction durations inside the run.
    compaction_duration_ms: u64,
    /// Per-tool aggregates, keyed by the fixed tool category (built-in
    /// tools by name, every MCP and custom tool folded into `mcp` /
    /// `custom`: no raw tool names leave the machine).
    tool_summary: HashMap<ToolCategory, ToolCategoryStats>,
}

/// One tool category's per-run aggregates.
#[derive(Debug, Default)]
struct ToolCategoryStats {
    calls: u64,
    failures: u64,
    duration_ms: u64,
    max_duration_ms: u64,
}

/// Per-session counters for the frequent per-occurrence facts that ride
/// `agent session ended` instead of their own events (skill invocations,
/// MCP connector use, kernel boots, RLM child usage, feature outcomes).
/// Shared with the engine seams that report them.
#[derive(Default)]
pub struct SessionCounters {
    inner: Mutex<CounterValues>,
    /// The live opt-out switch, installed by the engine at the counters'
    /// creation, before the MCP and kernel seams that count into them
    /// capture their handles. While it answers false the counters stop
    /// recording, so a later enable never sends what happened while
    /// telemetry was off (the TUI counters' rule). `None` (the default,
    /// used by tests and one-shot paths) is always on.
    telemetry_enabled: std::sync::OnceLock<Arc<dyn Fn() -> bool + Send + Sync>>,
}

#[derive(Default)]
struct CounterValues {
    skill_use_count: u64,
    mcp_connector_use_count: u64,
    kernel_bootstrap_count: u64,
    kernel_bootstrap_cold_count: u64,
    kernel_bootstrap_failed_count: u64,
    kernel_bootstrap_max_ms: u64,
    rlm_child_usage_count: u64,
    rlm_child_input_tokens: u64,
    rlm_child_output_tokens: u64,
    rlm_child_cache_read_tokens: u64,
    rlm_child_cache_write_tokens: u64,
    rlm_child_cost: f64,
    /// `feature_<name>_<outcome>_count` over the fixed feature vocabulary.
    feature_outcomes: std::collections::BTreeMap<String, u64>,
}

impl SessionCounters {
    /// Install the live opt-out switch. The engine calls this at the
    /// counters' creation, ahead of the MCP and kernel counting seams,
    /// so no event can count before the switch is in place. A second
    /// call is ignored (the first switch wins).
    pub fn set_telemetry_enabled(&self, telemetry_enabled: Arc<dyn Fn() -> bool + Send + Sync>) {
        let _ = self.telemetry_enabled.set(telemetry_enabled);
    }

    /// Count only while telemetry is on, so turning it on later never
    /// sends what happened while it was off.
    fn with(&self, update: impl FnOnce(&mut CounterValues)) {
        if self
            .telemetry_enabled
            .get()
            .is_some_and(|telemetry_enabled| !telemetry_enabled())
        {
            return;
        }
        update(
            &mut self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
    }

    /// An MCP connector call (the server name never uploads).
    pub fn note_mcp_connector_use(&self) {
        self.with(|values| values.mcp_connector_use_count += 1);
    }

    /// One kernel boot: cold or revived, its outcome, its duration.
    pub fn note_kernel_bootstrap(&self, cold: bool, succeeded: bool, duration_ms: u64) {
        self.with(|values| {
            values.kernel_bootstrap_count += 1;
            values.kernel_bootstrap_cold_count += u64::from(cold);
            values.kernel_bootstrap_failed_count += u64::from(!succeeded);
            values.kernel_bootstrap_max_ms = values.kernel_bootstrap_max_ms.max(duration_ms);
        });
    }

    fn write_into(&self, properties: &mut Properties) {
        self.with(|values| {
            for (key, value) in [
                ("skill_use_count", values.skill_use_count),
                ("mcp_connector_use_count", values.mcp_connector_use_count),
                ("kernel_bootstrap_count", values.kernel_bootstrap_count),
                (
                    "kernel_bootstrap_cold_count",
                    values.kernel_bootstrap_cold_count,
                ),
                (
                    "kernel_bootstrap_failed_count",
                    values.kernel_bootstrap_failed_count,
                ),
                ("kernel_bootstrap_max_ms", values.kernel_bootstrap_max_ms),
                ("rlm_child_usage_count", values.rlm_child_usage_count),
                ("rlm_child_input_tokens", values.rlm_child_input_tokens),
                ("rlm_child_output_tokens", values.rlm_child_output_tokens),
                (
                    "rlm_child_cache_read_tokens",
                    values.rlm_child_cache_read_tokens,
                ),
                (
                    "rlm_child_cache_write_tokens",
                    values.rlm_child_cache_write_tokens,
                ),
            ] {
                properties.set(key, Value::from(value));
            }
            if values.rlm_child_usage_count > 0 {
                properties.set("rlm_child_cost", Value::from(values.rlm_child_cost));
            }
            for (key, count) in &values.feature_outcomes {
                properties.set(key, Value::from(*count));
            }
        });
    }
}

/// Skills present at session start (adoption counts on `agent started`).
pub struct SkillCounts {
    pub skill_count: usize,
    pub python_skill_count: usize,
}

/// Install the telemetry subscriber on an agent and emit `agent started`.
/// The subscriber consumes every [`AgentEvent`]; the state it builds is
/// reachable through the returned handle for session-end finalization.
///
/// # Errors
///
/// The current implementation never returns `Err`; the installed telemetry
/// is always handed back in `Ok`.
///
/// # Panics
///
/// Panics if the telemetry state mutex is poisoned.
pub async fn install_session_telemetry(
    agent: &Arc<pa_agent::agent::Agent>,
    wiring: &TelemetryWiring,
    skill_counts: Option<SkillCounts>,
    counters: Arc<SessionCounters>,
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
        telemetry_enabled: wiring.telemetry_enabled.clone(),
        recording: true,
        now,
    }));
    // The counters arrive already gated: the engine installs the same
    // live switch on them at creation (the MCP and kernel seams count
    // long before this install runs), so nothing counts while telemetry
    // is off in any window.

    let subscriber_state = Arc::clone(&state);
    let subscriber_client = client.clone();
    let subscriber_mode = execution_mode.clone();
    let subscription = agent
        .subscribe(move |event, _signal| {
            let state = Arc::clone(&subscriber_state);
            let client = subscriber_client.clone();
            let execution_mode = subscriber_mode.clone();
            Box::pin(async move {
                handle_event(&client, &execution_mode, &state, event);
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
        counters,
        ended: std::sync::atomic::AtomicBool::new(false),
        _subscription: Some(subscription),
    })
}

impl SessionTelemetry {
    /// A compaction completed (feed from the compaction seams; TS
    /// `compaction_end` handling). Counts toward the active run when one
    /// exists, exactly like the TS subscriber — compactions outside a run
    /// never inflate session totals. The duration (measured centrally by
    /// the compaction executor) sums into the run's
    /// `compaction_duration_ms`.
    ///
    /// # Panics
    ///
    /// Panics if the telemetry state mutex is poisoned.
    pub fn note_compaction(&self, duration_ms: Option<u64>) {
        let mut state = self.state.lock().expect("telemetry state poisoned");
        if !state.recording {
            sever_off_period_run(&mut state);
            return;
        }
        if let Some(run) = state.active_run.as_mut() {
            run.compaction_count += 1;
            run.compaction_duration_ms += duration_ms.unwrap_or(0);
        }
    }

    /// One auto-retry event from the retry seam (TS `auto_retry_start`):
    /// `Start` counts the retry (and a backup-provider switch as a
    /// failover) into the active run, sums the retry wait, and keeps the
    /// run open, so the retried attempt continues the same run (one
    /// `agent run completed` per turn, like TS). `End` closes the retry:
    /// a retry that never ran (a cancelled wait) leaves the run to
    /// finalize at the next start instead of absorbing the next turn. The
    /// final attempt's message decides the outcome.
    ///
    /// # Panics
    ///
    /// Panics if the telemetry state mutex is poisoned.
    pub fn note_auto_retry_event(&self, event: &AutoRetryEvent) {
        let mut state = self.state.lock().expect("telemetry state poisoned");
        if !state.recording {
            // While off nothing counts, and the run severs: an off-period
            // retry never continues an on-period run across the opt-out.
            sever_off_period_run(&mut state);
            return;
        }
        let Some(run) = state.active_run.as_mut() else {
            return;
        };
        match event {
            AutoRetryEvent::Start {
                delay_ms, reason, ..
            } => {
                run.retry_count += 1;
                run.retry_wait_ms += *delay_ms;
                run.retry_pending = true;
                if matches!(reason, super::auto_retry::RetryStartReason::Backup { .. }) {
                    run.failover_count += 1;
                }
            }
            AutoRetryEvent::End { .. } => run.retry_pending = false,
        }
    }

    /// A feature attempt's observed result at a session-engine seam,
    /// counted as `feature_<name>_<outcome>_count` on `agent session
    /// ended`. The configuration choice is not reported.
    pub fn note_feature_outcome(
        &self,
        feature_name: &'static str,
        outcome: &'static str,
        _configuration_choice: Option<&'static str>,
    ) {
        if let Some(key) = pa_telemetry::feature_outcome_key(feature_name, outcome) {
            self.counters
                .with(|values| *values.feature_outcomes.entry(key).or_default() += 1);
        }
    }

    /// Finalize any active run, emit `agent session ended`, and flush.
    /// The host calls this at session close (TUI exit, worker shutdown,
    /// kill); the `ended` flag makes a second close path a no-op, matching
    /// the TS single `registerDisposeCallback` firing. A run still open
    /// across an opt-out severs before the finalize, so an off window's
    /// run never reports after a re-enable.
    ///
    /// # Errors
    ///
    /// Returns the telemetry client's flush error, if any.
    ///
    /// # Panics
    ///
    /// Panics if the telemetry state mutex is poisoned.
    pub async fn end(&self) -> anyhow::Result<()> {
        if self.ended.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        {
            let mut state = self.state.lock().expect("telemetry state poisoned");
            // Session close is the last recording seam: a run still open
            // when the cached decision says off severs here instead of
            // finalizing; the client's flush drops whatever the
            // mid-turn opt-out already queued.
            if !state.recording {
                sever_off_period_run(&mut state);
            }
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
            // v2 (#2117): the session's terminal outcome. `end()` is the
            // normal dispose path (interactive exit, worker shutdown); a
            // crash never reaches it, and the archive path emits
            // `session archived` first.
            properties.set("terminal_outcome", Value::from("success"));
            properties.set("retry_count", Value::from(totals.retry_count));
            properties.set("failover_count", Value::from(totals.failover_count));
            properties.set("model_error_count", Value::from(totals.model_error_count));
        }
        self.counters.write_into(&mut properties);
        self.client.track("agent session ended", properties);
        self.client.flush().await
    }

    /// `session archived` (schema v1): the session reached the archive state
    /// (daemon `kill`). Lifetime in ms; emitted before `end()` on that path.
    ///
    /// # Panics
    ///
    /// Panics if the telemetry state mutex is poisoned.
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

    /// A `/skill:<name>` submission expanded into its skill block (the
    /// `AgentSession::prompt_with_images` expansion seam), counted as
    /// `skill_use_count` on `agent session ended`; the skill name never
    /// uploads.
    pub fn note_skill_used(&self) {
        self.counters.with(|values| values.skill_use_count += 1);
    }

    /// One durable child-usage attribution row landed in the parent
    /// session (the RLM producer's flush), summed into the `rlm_child_*`
    /// counters on `agent session ended`.
    pub fn note_child_usage_attributed(
        &self,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
        cost: f64,
    ) {
        self.counters.with(|values| {
            values.rlm_child_usage_count += 1;
            values.rlm_child_input_tokens += input_tokens;
            values.rlm_child_output_tokens += output_tokens;
            values.rlm_child_cache_read_tokens += cache_read_tokens;
            values.rlm_child_cache_write_tokens += cache_write_tokens;
            if cost.is_finite() && cost > 0.0 {
                values.rlm_child_cost += cost;
            }
        });
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
) {
    let mut state = state.lock().expect("telemetry state poisoned");
    // The switch is asked at the turn boundaries only: a run or turn
    // start refreshes the cached decision, every other event consults
    // the cache, and the client's flush drops everything queued while
    // the switch is off. While recording is off nothing records, and the
    // run severs: its facts never enter the aggregates, so a later
    // enable can neither complete it nor merge the next run into it.
    if matches!(event, AgentEvent::AgentStart | AgentEvent::TurnStart) {
        observe_turn_boundary(&mut state);
        if !state.recording {
            return;
        }
    } else if !state.recording {
        sever_off_period_run(&mut state);
        return;
    }
    let now = (state.now)();
    match event {
        AgentEvent::AgentStart => {
            // A retried attempt continues its turn's run (TS keeps one run
            // across `auto_retry_start`: `activeRun ??= ...`).
            if let Some(run) = state.active_run.as_mut().filter(|run| run.retry_pending) {
                run.retry_pending = false;
                run.ended = false;
                run.ended_at = None;
                // The failed call is behind a retry now: the run's cost
                // stays reported (with the failed attempts' usage
                // included) unless the final attempt fails too.
                run.usage_complete = true;
                return;
            }
            // The previous run finalizes here (not at AgentEnd): a post-run
            // compaction drained between AgentEnd and this start must land in
            // that run, exactly like the TS turn-action window. A missing
            // AgentEnd (misbehaving emitter) still cannot lose run facts.
            finalize_run_locked(client, execution_mode, &mut state);
            let run_index = state.totals.run_count + 1;
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
                retry_pending: false,
                run_id: uuid(),
                run_index,
                trigger_pending: true,
                trigger: RunTrigger::Unknown,
                first_reasoning_ms: None,
                run_to_first_text_ms: None,
                tool_duration_ms: 0,
                retry_wait_ms: 0,
                max_stream_gap_ms: None,
                last_stream_event_at: None,
                successful_model_call_count: 0,
                usage_complete: true,
                cost_usd: 0.0,
                model_latencies: Vec::new(),
                model_error_count: 0,
                error_category_counts: std::collections::BTreeMap::new(),
                compaction_duration_ms: 0,
                tool_summary: HashMap::new(),
            });
        }
        AgentEvent::MessageStart { message } => {
            if message.role() == "user" {
                state.totals.prompt_count += 1;
                // A prompt-run's user message lands right after
                // `AgentStart`: the run's trigger is a fresh prompt.
                resolve_trigger(&mut state, RunTrigger::Prompt);
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
            if state.active_run.is_some() {
                // A continuation-run's first event is a model event (no
                // user message ever lands inside it): the retry/goal
                // re-entry disambiguates the trigger.
                resolve_trigger(&mut state, RunTrigger::Continuation);
                let Some(run) = state.active_run.as_mut() else {
                    return;
                };
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
                if run.run_to_first_text_ms.is_none() {
                    let is_text_delta = matches!(
                        assistant_message_event.as_ref(),
                        pa_agent::stream::AssistantMessageEvent::TextDelta { delta, .. } if !delta.is_empty()
                    );
                    if is_text_delta {
                        run.run_to_first_text_ms = Some(now.saturating_sub(run.started_at));
                    }
                }
                if run.first_reasoning_ms.is_none() {
                    let is_reasoning_delta = matches!(
                        assistant_message_event.as_ref(),
                        pa_agent::stream::AssistantMessageEvent::ThinkingDelta { delta, .. } if !delta.is_empty()
                    );
                    if is_reasoning_delta {
                        if let Some(first_turn) = run.first_turn_started_at {
                            run.first_reasoning_ms = Some(now.saturating_sub(first_turn));
                        }
                    }
                }
                // The stream gap: the largest quiet stretch between
                // consecutive model events within the run.
                if let Some(last) = run.last_stream_event_at {
                    let gap = now.saturating_sub(last);
                    run.max_stream_gap_ms =
                        Some(run.max_stream_gap_ms.map_or(gap, |max| max.max(gap)));
                }
                run.last_stream_event_at = Some(now);
            }
        }
        AgentEvent::MessageEnd { message } => {
            if let pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(
                assistant,
            )) = message
            {
                // A continuation-run without stream events (a non-streamed
                // response) still disambiguates at its first assistant
                // message end.
                resolve_trigger(&mut state, RunTrigger::Continuation);
                let is_error = assistant.stop_reason == StopReason::Error;
                let category = error_category(Some(&assistant))
                    .as_str()
                    .and_then(|category| {
                        pa_telemetry::ERROR_CATEGORIES
                            .iter()
                            .find(|known| **known == category)
                            .copied()
                    });
                let cost_total = assistant.usage.cost.total;
                if let Some(run) = state.active_run.as_mut() {
                    run.usage.add(&assistant.usage);
                    run.last_assistant = Some(assistant);
                    if let Some(turn_started) = run.current_turn_started_at.take() {
                        let latency = now.saturating_sub(turn_started);
                        run.model_latency_ms += latency;
                        run.max_model_latency_ms = run.max_model_latency_ms.max(latency);
                        run.model_latencies.push(latency);
                    }
                    if is_error {
                        run.usage_complete = false;
                        run.model_error_count += 1;
                        if let Some(category) = category {
                            *run.error_category_counts.entry(category).or_default() += 1;
                        }
                    } else {
                        run.successful_model_call_count += 1;
                    }
                    run.cost_usd += cost_total;
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
            let category = ToolCategory::from_tool_name(&tool_name);
            if let Some(run) = state.active_run.as_mut() {
                run.tool_call_count += 1;
                if is_error {
                    run.tool_error_count += 1;
                }
                run.tool_duration_ms += duration_ms;
                let tool_stats = run.tool_summary.entry(category).or_default();
                tool_stats.calls += 1;
                tool_stats.failures += u64::from(is_error);
                tool_stats.duration_ms += duration_ms;
                tool_stats.max_duration_ms = tool_stats.max_duration_ms.max(duration_ms);
            }
        }
        AgentEvent::AgentEnd { .. } => {
            if let Some(run) = state.active_run.as_mut() {
                run.ended = true;
                run.ended_at = Some(now);
            }
        }
        // TurnEnd carries no facts the TS subscriber used (turn_count comes
        // from TurnStart); ToolExecutionUpdate is mid-execution progress.
        // Both are still run-scoped events: while the cached decision is
        // off they sever (a tool whose execution spans an opt-out observed
        // at a boundary never counts into a surviving run).
        AgentEvent::TurnEnd { .. } | AgentEvent::ToolExecutionUpdate { .. } => {}
    }
}

/// Record the run's trigger the first time it disambiguates.
fn resolve_trigger(state: &mut TelemetryState, trigger: RunTrigger) {
    if let Some(run) = state.active_run.as_mut().filter(|run| run.trigger_pending) {
        run.trigger_pending = false;
        run.trigger = trigger;
    }
}

/// Finalize the active run and emit `agent run completed` (TS
/// `finalizeRun`), merging run totals into session totals.
fn finalize_run(client: &TelemetryClient, execution_mode: &str, state: &mut TelemetryState) {
    finalize_run_locked(client, execution_mode, state);
}

fn finalize_run_locked(client: &TelemetryClient, execution_mode: &str, state: &mut TelemetryState) {
    let Some(mut run) = state.active_run.take() else {
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

    state.totals.retry_count += run.retry_count;
    state.totals.failover_count += run.failover_count;
    state.totals.model_error_count += run.model_error_count;

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
    // v2 (#2117) enrichment:
    properties.set("run_id", Value::from(run.run_id.as_str()));
    properties.set("run_index", Value::from(run.run_index));
    properties.set("trigger", Value::from(run.trigger.as_str()));
    properties.set(
        "stop_reason",
        Value::from(stop_reason(run.last_assistant.as_ref())),
    );
    properties.set("terminal_outcome", Value::from(terminal_outcome(outcome)));
    properties.set(
        "successful_model_call_count",
        Value::from(run.successful_model_call_count),
    );
    if run.usage.model_call_count > 0 {
        properties.set("usage_complete", Value::from(run.usage_complete));
    }
    if run.usage_complete && run.usage.model_call_count > 0 && run.cost_usd > 0.0 {
        // Estimated cost requires known pricing and complete usage for
        // every call; the conservative direction keeps it null otherwise.
        properties.set("estimated_cost_usd", Value::from(run.cost_usd));
    }
    if run.last_assistant.as_ref().map(|m| m.stop_reason) == Some(StopReason::Error) {
        properties.set(
            "error_subtype",
            Value::from(
                classify_error_message(
                    run.last_assistant
                        .as_ref()
                        .and_then(|m| m.error_message.as_deref())
                        .unwrap_or_default(),
                )
                .subtype,
            ),
        );
    }
    properties.set("first_reasoning_ms", opt_value(run.first_reasoning_ms));
    properties.set("run_to_first_text_ms", opt_value(run.run_to_first_text_ms));
    properties.set("tool_duration_ms", Value::from(run.tool_duration_ms));
    properties.set("retry_wait_ms", Value::from(run.retry_wait_ms));
    properties.set("max_stream_gap_ms", opt_value(run.max_stream_gap_ms));
    properties.set(
        "compaction_duration_ms",
        Value::from(run.compaction_duration_ms),
    );
    properties.set(
        "model_latency_p50_ms",
        opt_value(median(&mut run.model_latencies)),
    );
    properties.set("model_error_count", Value::from(run.model_error_count));
    for (category, count) in &run.error_category_counts {
        properties.set(&format!("error_{category}_count"), Value::from(*count));
    }
    // Per built-in tool by name; every MCP and custom tool folds into the
    // `mcp_tool_*` / `custom_tool_*` aggregates (no raw tool names).
    for (category, stats) in &run.tool_summary {
        let prefix = match category {
            ToolCategory::Mcp => "mcp_tool".to_string(),
            ToolCategory::Custom | ToolCategory::Unknown => "custom_tool".to_string(),
            builtin => format!("tool_{}", builtin.as_str()),
        };
        for (suffix, value) in [
            ("call_count", stats.calls),
            ("error_count", stats.failures),
            ("duration_ms", stats.duration_ms),
            ("max_duration_ms", stats.max_duration_ms),
        ] {
            let key = format!("{prefix}_{suffix}");
            let total = properties.get(&key).and_then(Value::as_u64).unwrap_or(0);
            let value = if suffix == "max_duration_ms" {
                total.max(value)
            } else {
                total + value
            };
            properties.set(&key, Value::from(value));
        }
    }
    client.track("agent run completed", properties);
}

/// The median of the run's model-call latencies (the lower middle for an
/// even count); `None` without calls.
fn median(values: &mut [u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    Some(values[(values.len() - 1) / 2])
}

/// The #2117 `terminal_outcome` vocabulary: the legacy run outcome
/// (`success`/`error`/`aborted`) onto the terminal vocabulary (the legacy
/// `aborted` is the terminal `cancelled`).
fn terminal_outcome(run_outcome: &str) -> &'static str {
    match run_outcome {
        "success" => "success",
        "error" => "error",
        "aborted" => "cancelled",
        _ => "unknown",
    }
}

/// The #2117 `stop_reason` vocabulary for the final assistant message.
fn stop_reason(last_assistant: Option<&AssistantMessage>) -> &'static str {
    match last_assistant.map(|message| message.stop_reason) {
        Some(StopReason::Stop) => "stop",
        Some(StopReason::Length) => "length",
        Some(StopReason::ToolUse) => "toolUse",
        Some(StopReason::Error) => "error",
        Some(StopReason::Aborted) => "aborted",
        None => "unknown",
    }
}

/// Build the product telemetry client from settings: the Prime Intellect
/// analytics sink (the TS endpoint and wire format; none in debug builds,
/// see [`telemetry_endpoint`]) plus the local JSONL transparency mirror
/// (default on, `telemetry.localMirror` disables it), behind the live
/// [`telemetry_switch`] re-read before every delivery pass. Never fails: a
/// broken install id falls back to a no-op client (TS parity: capture
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
            if let Some(endpoint) = telemetry_endpoint() {
                sinks.push(Arc::new(pa_telemetry::AnalyticsSink::new(endpoint)));
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
            // `/telemetry off` (or a settings edit) applies to running
            // clients at their next delivery pass, no restart needed.
            let settings = settings.reopen();
            config.enabled = Some(Arc::new(move || {
                telemetry_switch(&settings.reopen()).enabled()
            }));
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

/// The recording seams' live opt-out switch: the same env-then-settings
/// resolution the delivery pass applies ([`telemetry_switch`]), resolved
/// live at the turn boundaries: an off (or an on) applies to the
/// recording seams at the next boundary, exactly like the client's
/// delivery gate applies it at the flush.
#[must_use]
pub fn telemetry_enabled_switch(
    cwd: &std::path::Path,
    agent_dir: &std::path::Path,
) -> RecordingSwitch {
    let settings = crate::settings::SettingsManager::create(cwd, agent_dir);
    RecordingSwitch {
        enabled: Arc::new(move || telemetry_switch(&settings.reopen()).enabled()),
    }
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
