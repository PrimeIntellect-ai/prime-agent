//! The worker's client-visible surface: summaries, snapshots, the
//! roster push, and the event emission family.
use super::*;
use super::lifecycle::active_lifecycle;

use crate::types::SessionSummary;

impl Worker {
pub(crate) fn summary_locked(&self, core: &SessionCore) -> SessionSummary {
    // The one summary composer (TS `summaryForActiveSession`): the
    // roster feed, `get_state`, and list rows all serve it, so the
    // live flags (`isRunningTools` from the core's in-flight tool
    // calls, `isBashRunning` from the user bash) never drift between
    // surfaces.
    let mut summary = session_summary(
        core,
        &self
            .engine
            .effective_thinking_level()
            .unwrap_or_else(|| "default".to_string()),
        self.engine.model_metadata(),
        self.engine.model_fallback_message(),
        self.user_bash.is_running(),
    );
    // The worker's roster-delta counter at snapshot time, and the
    // process instance that read it — the pair is one snapshot:
    // the supervisor's pull gate orders the summary against the
    // watermark of the generation that took it, so a delta still
    // in flight when the pull answered (a sequence at or below
    // the counter) is dropped instead of overwriting the pull's
    // fresher state. Both reads run under the caller's core
    // lock, and every push stamps its snapshot after the state
    // change it describes and before its counter increment, so
    // a counter this summary embeds already includes every
    // change the snapshot reflects. The PRE-first-push stamp of
    // zero is a sequenced counter (the supervisor gates it like
    // any other — a delayed pre-push pull never overwrites a
    // newer delta's state); only a summary that carries no
    // counter at all is the unsequenced legacy write.
    summary.roster_delta_sequence = Some(
        self.roster_delta_sequence
            .load(std::sync::atomic::Ordering::SeqCst),
    );
    summary.worker_instance_id = (!self.config.worker_instance_id.is_empty())
        .then(|| self.config.worker_instance_id.clone());
    summary
}

pub(crate) fn snapshot_locked(&self, core: &SessionCore) -> SessionActionSnapshot {
    session_snapshot(core)
}

/// Push one roster delta from a command arm (the model/thinking
/// switch seams): the same frame the turn runner's busy flips push,
/// so a switch reaches the subscribed roster surfaces (the agents
/// view) without a turn — the TS roster-flush parity for
/// `thinking_level_changed` and the `set_model`/`cycle_model`
/// handlers.
pub(crate) fn push_roster_delta(&self) {
    self.roster_pushes.push();
}

pub(crate) fn connection_state_locked(&self, core: &SessionCore) -> AgentConnectionState {
    let store = core.store.as_ref();
    let model = self.engine.model_metadata();
    let model_fast_mode = model
        .as_ref()
        .and_then(|model| model.get("id"))
        .and_then(Value::as_str)
        .is_some_and(supports_fast_mode);
    AgentConnectionState {
        is_streaming: core.busy,
        is_compacting: core.compacting,
        active_session_id: Some(core.active_session_id.clone()),
        cwd: core.cwd.clone(),
        model,
        thinking_level: self
            .engine
            .effective_thinking_level()
            .unwrap_or_else(|| "default".to_string()),
        // The effective tier: the preference clamped to the model's
        // fast-mode support (`priority` degrades to `default`).
        service_tier: crate::setting_switches::service_tier_wire_name(
            effective_service_tier(core.service_tier, model_fast_mode)
                .unwrap_or(pa_types::ai::ServiceTier::Auto),
        )
        .to_string(),
        // The resolved model's supported levels (TS `getSupportedThinkingLevels`
        // in `getState`): a non-reasoning model reports ["off"], which the
        // client treats as no thinking surface.
        available_thinking_levels: self
            .engine
            .supported_thinking_levels()
            .unwrap_or_else(|| vec!["off".to_string()]),
        is_bash_running: self.user_bash.is_running(),
        retry_attempt: 0,
        steering_mode: core.steering_mode.clone(),
        follow_up_mode: core.follow_up_mode.clone(),
        session_file: store.map(|s| s.path.to_string_lossy().to_string()),
        session_id: store
            .map(|s| s.session_id().to_string())
            .unwrap_or_default(),
        session_name: store.and_then(|s| s.session_name().map(str::to_string)),
        session_dir: store
            .and_then(|s| s.path.parent())
            .map(|p| p.to_string_lossy().to_string()),
        leaf_id: store.and_then(|s| s.leaf_id().map(str::to_string)),
        auto_compaction_enabled: core.auto_compaction_enabled,
        message_count: store.map_or(0, crate::session_store::SessionFile::message_count) as u32,
        session_actions: session_snapshot(core),
        compaction_count: store.map_or(0, |store| store.compaction_count() as u32),
        goal: self.engine.goal_state_value(),
        scoped_models: core.scoped_models.clone(),
        active_tool_names: Vec::new(),
        context_usage: None,
    }
}

/// Persist the queue lanes to the worker recovery journal (crash-safe
/// queue recovery; TS keeps session files free of daemon bookkeeping).
/// Call after releasing the core lock: `record_recovery` takes the locks
/// in the opposite order.
pub(crate) fn persist_queue_snapshot(&self, active_session_id: &str, lanes: &QueueLanes) {
    let mut guard = self.recovery.lock().unwrap();
    let Some(journal) = guard.as_mut() else {
        return;
    };
    let _ = journal.record_queue_snapshot(active_session_id, &lanes.steering, &lanes.follow_up);
}

/// One queue-lane recovery checkpoint through the worker's own
/// journal: the lane snapshot and the busy verdict ride one locked
/// read (`checkpoint_queue_recovery`).
pub(crate) fn checkpoint_queue(&self, checkpoint: QueueCheckpoint) {
    checkpoint_queue_recovery(&self.recovery, &self.core, checkpoint);
}

pub(crate) fn record_recovery(&self, busy: bool, operation: &str) -> Result<()> {
    let mut guard = self.recovery.lock().unwrap();
    let Some(journal) = guard.as_mut() else {
        return Ok(());
    };
    let core = self.core.lock().unwrap();
    let store = core.store.as_ref();
    journal.record(
        &core.active_session_id,
        store.map_or("", crate::session_store::SessionFile::session_id),
        store
            .map(|s| s.path.to_string_lossy().to_string())
            .as_deref(),
        busy,
        operation,
    )
}

/// Sequence and broadcast one `session_event` frame at the worker
/// level (the TS `_emit` backing for switch notifications).
pub(crate) fn emit_worker_event(&self, event: Value) {
    emit_worker_event_with(&self.core, &self.events, event);
}

/// Record one durable custom row and broadcast its
/// `message_start`/`message_end` pair (the TS `_emit` for rows the
/// session appends outside a turn: `append_custom_message`, the
/// `refine` outcome and notice, restored prefix rows).
pub(crate) fn emit_custom_row(&self, message: Value) {
    {
        let mut core = self.core.lock().unwrap();
        if let Some(store) = core.store.as_mut() {
            let _ = store.persist_entry(
                "custom_message",
                json!({
                    "customType": message.get("customType").cloned().unwrap_or(Value::Null),
                    "content": message.get("content").cloned().unwrap_or(Value::Null),
                    "display": message.get("display").cloned().unwrap_or(Value::Bool(true)),
                    "details": message.get("details").cloned().unwrap_or(Value::Null),
                }),
            );
        }
    }
    self.emit_worker_event(json!({ "type": "message_start", "message": message }));
    self.emit_worker_event(json!({ "type": "message_end", "message": message }));
}

/// Sequence and broadcast one `session_event` for the queue projection.
pub(crate) fn emit_action_update(&self, snapshot: &SessionActionSnapshot) -> Result<()> {
    let mut core = self.core.lock().unwrap();
    // TS `_emitQueueUpdate`: an unchanged projection stays silent (an
    // empty queue before and after a turn is not an update).
    if core.last_action_snapshot.as_ref() == Some(snapshot) {
        return Ok(());
    }
    core.last_action_snapshot = Some(snapshot.clone());
    let sequence = core.last_event_sequence + 1;
    core.last_event_sequence = sequence;
    let meta = create_daemon_event_meta(
        &core.active_session_id,
        sequence,
        None,
        Some(&core.generation),
    );
    let outbound = DaemonOutbound::SessionEvent {
        active_session_id: core.active_session_id.clone(),
        event: json!({ "type": "session_action_update", "actions": snapshot }),
        meta: Some(meta),
        rest: Map::default(),
    };
    let payload = serde_json::to_vec(&outbound)?;
    drop(core);
    self.events.send(OutboundFrame::session_event(payload));
    Ok(())
}

pub(crate) fn emit_session_closed(
    &self,
    active_session_id: &str,
    reason: DaemonSessionClosedReason,
) -> Result<()> {
    let mut core = self.core.lock().unwrap();
    let sequence = core.last_event_sequence + 1;
    core.last_event_sequence = sequence;
    let meta = create_daemon_event_meta(
        &core.active_session_id,
        sequence,
        None,
        Some(&core.generation),
    );
    let outbound = DaemonOutbound::SessionClosed {
        active_session_id: active_session_id.to_string(),
        reason,
        meta: Some(meta),
        rest: Map::default(),
    };
    let payload = serde_json::to_vec(&outbound)?;
    drop(core);
    self.events.send(OutboundFrame::session_event(payload));
    Ok(())
}
}

pub(crate) fn emit_worker_event_with(
    core: &Arc<Mutex<SessionCore>>,
    events: &Arc<EventPump>,
    event: Value,
) {
    let mut core = core.lock().unwrap();
    let sequence = core.last_event_sequence + 1;
    core.last_event_sequence = sequence;
    let meta = create_daemon_event_meta(
        &core.active_session_id,
        sequence,
        None,
        Some(&core.generation),
    );
    let active_session_id = core.active_session_id.clone();
    let outbound = DaemonOutbound::SessionEvent {
        active_session_id,
        event,
        meta: Some(meta),
        rest: Map::default(),
    };
    let payload = serde_json::to_vec(&outbound).unwrap_or_default();
    drop(core);
    events.send(OutboundFrame::session_event(payload));
}

/// The worker's roster-delta push (the Rust-native form of the TS
/// `roster_delta` worker frame): the fresh session summary rides the
/// supervisor link, so subscribed roster surfaces (the agents view) see a
/// state change without polling. Shared by the turn runner's busy flips
/// and the worker's command arms (the model/thinking switches). The
/// supervisor's roster refresh still backstops every push, so this stays
/// fire-and-forget: a dead link reconnects on the next push, and a
/// supervisor restart re-seeds the entry from registration.
///
/// The TS worker flushes its roster deltas over ONE ordered supervisor
/// client socket (a coalesced window re-reads the current state), so a
/// delayed older frame can never overwrite a newer one. The Rust
/// supervisor link dials an independent socket per request — the pushes
/// arrive unordered — so every delta carries the worker's monotonic
/// counter and the supervisor's stale-delta gate drops the delayed older
/// snapshots.
pub(crate) struct RosterPushContext {
    pub(crate) core: Arc<Mutex<SessionCore>>,
    pub(crate) engine: std::sync::Arc<dyn SessionEngine>,
    pub(crate) user_bash: std::sync::Arc<crate::user_bash::UserBash>,
    pub(crate) roster_link: std::sync::Arc<crate::supervisor_link::SupervisorLink>,
    pub(crate) worker_token: String,
    pub(crate) worker_instance_id: String,
    pub(crate) roster_delta_sequence: std::sync::Arc<std::sync::atomic::AtomicU64>,
    pub(crate) roster_push_order: std::sync::Arc<std::sync::Mutex<()>>,
}

pub(crate) fn push_roster_delta(context: &RosterPushContext) {
    if std::env::var_os("PA_WORKER_DISABLE_ROSTER_PUSH").is_some() {
        return;
    }
    if context.worker_token.is_empty() || context.roster_link.socket_path().as_os_str().is_empty() {
        return;
    }
    // The push-order lock holds the snapshot and its sequence stamp
    // together: a busy-flip push racing a switch push must never let the
    // older snapshot carry the newer sequence (the supervisor would then
    // keep the stale row and drop the fresh one), so the pair is atomic
    // and the pairs themselves order — sequence order is snapshot order.
    let _order = context.roster_push_order.lock().unwrap();
    let mut summary = {
        let core = context.core.lock().unwrap();
        session_summary(
            &core,
            &context
                .engine
                .effective_thinking_level()
                .unwrap_or_else(|| "default".to_string()),
            context.engine.model_metadata(),
            context.engine.model_fallback_message(),
            context.user_bash.is_running(),
        )
    };
    // The embedded counter is the pre-stamp value read under the order
    // lock: every sequence this worker stamped before the snapshot is at
    // or below it. The supervisor's authoritative pulls raise their
    // watermark to it, so a delta still in flight when the pull answered
    // is dropped instead of overwriting the pull's fresher state.
    summary.roster_delta_sequence = Some(
        context
            .roster_delta_sequence
            .load(std::sync::atomic::Ordering::SeqCst),
    );
    let summary = serde_json::to_value(&summary).unwrap_or(serde_json::Value::Null);
    let link = std::sync::Arc::clone(&context.roster_link);
    let worker_token = context.worker_token.clone();
    let worker_instance_id = context.worker_instance_id.clone();
    let sequence_value = context
        .roster_delta_sequence
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    tokio::spawn(async move {
        let command = serde_json::json!({
            "type": "worker_roster_delta",
            "workerToken": worker_token,
            "summary": summary,
            "sequence": sequence_value,
            "workerInstanceId": worker_instance_id,
        });
        let _ = link
            .request(command, std::time::Duration::from_secs(10))
            .await;
    });
}

pub(crate) fn session_summary(
    core: &SessionCore,
    thinking_level: &str,
    model: Option<Value>,
    model_fallback_message: Option<String>,
    bash_running: bool,
) -> SessionSummary {
    let store = core.store.as_ref();
    let streaming = core.busy;
    let compacting = core.compacting;
    let queued = core.steering.len() + core.follow_up.len();
    // `modified` is the session file mtime; `lastActivityAt` prefers the
    // newest message timestamp (port of `summaryForActiveSession`).
    let modified = store
        .and_then(|store| std::fs::metadata(&store.path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .map(|time| {
            crate::util::iso_from_unix_ms(
                time.duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or_default(),
            )
        });
    let messages = store
        .map(crate::session_store::SessionFile::messages)
        .unwrap_or_default();
    let last_activity_at = messages
        .iter()
        .rev()
        .find_map(crate::types::message_timestamp_ms)
        .map(crate::util::iso_from_unix_ms)
        .or_else(|| modified.clone())
        .or_else(|| store.map(|store| store.header.timestamp.clone()));
    // Usage: summed assistant usage (`sessionUsageSummaryFrom`), absent
    // when everything is zero.
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut cost = 0.0f64;
    for message in &messages {
        if crate::types::message_role(message) != Some("assistant") {
            continue;
        }
        let Some(usage) = message.get("usage") else {
            continue;
        };
        input_tokens += usage
            .get("input")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        input_tokens += usage
            .get("cacheRead")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        input_tokens += usage
            .get("cacheWrite")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        output_tokens += usage
            .get("output")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        cost += usage
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or_default();
    }
    let usage = (input_tokens > 0 || output_tokens > 0 || cost > 0.0).then(
        || json!({ "inputTokens": input_tokens, "outputTokens": output_tokens, "cost": cost }),
    );
    SessionSummary {
        id: core.active_session_id.clone(),
        lifecycle: active_lifecycle(&core.runtime_kind, messages.is_empty(), streaming).to_string(),
        activity: if streaming || compacting {
            "working"
        } else {
            "idle"
        }
        .to_string(),
        is_session_active: streaming || compacting || queued > 0,
        has_registered_cron_job: Some(false),
        last_activity_at,
        rlm_depth: Some(core.rlm_depth),
        active_session_id: Some(core.active_session_id.clone()),
        session_id: store
            .map(|s| s.session_id().to_string())
            .unwrap_or_default(),
        session_file: store.map(|s| s.path.to_string_lossy().to_string()),
        session_name: store.and_then(|s| s.session_name().map(str::to_string)),
        cwd: core.cwd.clone(),
        thinking_level: Some(thinking_level.to_string()),
        is_streaming: streaming,
        is_compacting: compacting,
        is_bash_running: Some(bash_running),
        is_running_tools: streaming && !core.running_tool_calls.is_empty(),
        attached_clients: core.attached_client_ids.len() as u32,
        message_count: store.map_or(0, crate::session_store::SessionFile::message_count) as u32,
        session_actions: session_snapshot(core),
        streaming_message: None,
        created: store.map(|s| s.header.timestamp.clone()),
        modified,
        first_message: store.and_then(crate::session_store::SessionFile::first_message),
        parent_session_path: store.and_then(|store| store.header.parent_session.clone()),
        parent_active_session_id: core.parent_active_session_id.clone(),
        parent_session_id: core.parent_session_id.clone(),
        rlm_child_id: core.rlm_child_id.clone(),
        usage,
        worker_state: Some("ready".to_string()),
        worker_pid: Some(std::process::id()),
        // Set by the caller when the snapshot backs a roster push (the
        // push-order lock reads the pre-stamp counter); authoritative
        // pulls embed the live counter in `summary_locked` instead.
        // The push's sending instance rides the frame envelope, so the
        // summary itself never carries one here.
        roster_delta_sequence: None,
        worker_instance_id: None,
        model,
        model_fallback_message,
        runtime_kind: Some(core.runtime_kind.clone()),
        unfinished_action_count: Some(0),
    }
}

/// The queue snapshot for one core (TS `sessionActions`).
pub(crate) fn session_snapshot(core: &SessionCore) -> SessionActionSnapshot {
    // TS `queuedAgentMessagePreview`: a parked row reads the
    // delivery's labeled preview when it carries one, else the
    // message text.
    let lane = |items: &std::collections::VecDeque<QueuedItem>| {
        items
            .iter()
            .map(|item| item.preview.clone().unwrap_or_else(|| item.message.clone()))
            .collect::<Vec<String>>()
    };
    // The RLM child status notices fold by TYPED provenance: the indices
    // derive from the parked rows' injected custom rows, so the
    // classification rides the wire and a user-typed message that
    // merely looks like a notice preview never marks.
    let rlm_child_status = |items: &std::collections::VecDeque<QueuedItem>| {
        items
            .iter()
            .enumerate()
            .filter(|(_, item)| is_rlm_child_status_item(item))
            .map(|(index, _)| index)
            .collect::<Vec<usize>>()
    };
    SessionActionSnapshot {
        queued_count: (core.steering.len() + core.follow_up.len()) as u32,
        steering: lane(&core.steering),
        follow_ups: lane(&core.follow_up),
        rlm_child_status: crate::types::RlmChildStatusIndices {
            steering: rlm_child_status(&core.steering),
            follow_up: rlm_child_status(&core.follow_up),
        },
        active: core.active_action.clone(),
    }
}

/// The active action's queue label (TS `compactRlmText(text, 160)`):
/// collapse whitespace and cap at 160 chars with an ellipsis.
pub(crate) fn compact_action_label(text: &str) -> String {
    const MAX_CHARS: usize = 160;
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= MAX_CHARS {
        return compact;
    }
    let kept: String = compact.chars().take(MAX_CHARS - 3).collect();
    format!("{}...", kept.trim_end())
}
