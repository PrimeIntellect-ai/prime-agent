//! One agent turn: the runner that admits queued input, drives the
//! engine, and settles the result.
use super::{
    checkpoint_queue_recovery, compact_action_label, create_daemon_event_meta,
    emit_refinement_event_for_session, emit_refinement_row, gather_delivery_batch, json, oneshot,
    queue::{checkpoint_picked_input, queue_item_record}, session_snapshot, AssistantSnapshot, DaemonOutbound, EngineEvent,
    EventPump, Lane, Map, Notify,
    OutboundFrame, PromptRequest, QueueCheckpoint, QueuedItem, Result, SessionActionSnapshot,
    SessionCore, SessionEngine, TurnSettle, Value, WorkerRecoveryJournal,
    ABORTED_TURN_SETTLE_ERROR,
};

use std::sync::{Arc, Mutex};

pub(super) struct TurnRunner {
    pub(crate) core: Arc<Mutex<SessionCore>>,
    pub(super) input_pauses: crate::session_input_pause::InputPauseTable,
    /// The prompt-admission registry: an admitted prompt clears when its
    /// turn settles.
    pub(super) prompt_admissions: crate::prompt_admission::WorkerAdmissions,
    pub(super) work_notify: Arc<Notify>,
    pub(super) idle_notify: Arc<Notify>,
    pub(crate) events: Arc<EventPump>,
    pub(super) engine: std::sync::Arc<dyn SessionEngine>,
    pub(super) recovery: Arc<Mutex<Option<WorkerRecoveryJournal>>>,
    pub(super) active_session_id: String,
    pub(super) roster_pushes: crate::roster_activity::RosterPushQueue,
    /// The idle passivation's live-bash gate.
    pub(super) user_bash: std::sync::Arc<crate::user_bash::UserBash>,
    pub(super) passivation: PassivationContext,
    /// The shared pane-reporter slot (the Worker's `herdr` field): the
    /// runner reads it at every boundary so a create-time rebind is always
    /// current.
    pub(super) herdr: std::sync::Arc<std::sync::Mutex<crate::herdr::HerdrReporter>>,
}

/// The idle-passivation context on the turn runner: the worker token
/// for the graceful-stop request.
pub(super) struct PassivationContext {
    pub(super) agent_dir: std::path::PathBuf,
    pub(super) link: std::sync::Arc<crate::supervisor_link::SupervisorLink>,
    pub(super) worker_token: String,
}

impl TurnRunner {
    pub(super) async fn run(self) {
        loop {
            let engine = self.engine.clone();
            let item: Option<Vec<QueuedItem>> = {
                let mut core = self.core.lock().unwrap();
                if core.shutdown_requested {
                    drop(core);
                    // The shutdown handler waits on the idle notify before
                    // disposing the kernel; the runner's last chance to fire it.
                    self.idle_notify.notify_waiters();
                    return;
                }
                // A cleared suspension alone must not admit: a manual
                // compaction is a busy state the resume sites do NOT clear.
                if self.input_pauses.paused()
                    || core.queued_input_suspended
                    || core.recovery_hold
                    || core.compacting
                {
                    core.busy = false;
                    None
                } else if core.steering.front().is_some() {
                    let items = gather_delivery_batch(&mut core, Lane::Steering);
                    core.in_flight_input = items
                        .iter()
                        .map(|item| super::session_core::InFlightInput {
                            lane: Lane::Steering,
                            row_id: uuid::Uuid::new_v4().to_string(),
                            item: queue_item_record(item),
                            attempted: false,
                            committed: false,
                            cancelled: false,
                        })
                        .collect();
                    core.running_admission_ids = items
                        .iter()
                        .filter_map(|item| item.admission_id.clone())
                        .collect();
                    core.busy = true;
                    core.abort_requested = false;
                    core.retry_abort_requested = false;
                    core.running_tool_calls.clear();
                    Some(items)
                } else if core.follow_up.front().is_some() {
                    let items = gather_delivery_batch(&mut core, Lane::FollowUp);
                    core.in_flight_input = items
                        .iter()
                        .map(|item| super::session_core::InFlightInput {
                            lane: Lane::FollowUp,
                            row_id: uuid::Uuid::new_v4().to_string(),
                            item: queue_item_record(item),
                            attempted: false,
                            committed: false,
                            cancelled: false,
                        })
                        .collect();
                    core.running_admission_ids = items
                        .iter()
                        .filter_map(|item| item.admission_id.clone())
                        .collect();
                    core.busy = true;
                    core.abort_requested = false;
                    core.retry_abort_requested = false;
                    core.running_tool_calls.clear();
                    Some(items)
                } else {
                    core.busy = false;
                    None
                }
            };
            if let Some(items) = item {
                if let Err(error) = checkpoint_picked_input(&self.recovery, &self.core) {
                    eprintln!("pa-daemon: picked input checkpoint failed: {error:#}");
                    let mut core = self.core.lock().unwrap();
                    let lane = core.in_flight_input.first().map(|input| input.lane);
                    for item in items.into_iter().rev() {
                        match lane {
                            Some(Lane::Steering) => core.steering.push_front(item),
                            Some(Lane::FollowUp) => core.follow_up.push_front(item),
                            None => unreachable!("picked batch has an owned lane"),
                        }
                    }
                    core.in_flight_input.clear();
                    core.running_admission_ids.clear();
                    core.busy = false;
                    core.queued_input_suspended = true;
                    drop(core);
                    self.idle_notify.notify_waiters();
                    continue;
                }
                // The item leaves the visible queue projection before its
                // turn starts; the private picked snapshot retains ownership.
                let visible_index = items.iter().position(|item| item.queue_visible);
                let anchor = visible_index.map(|index| &items[index]);
                {
                    let mut core = self.core.lock().unwrap();
                    if let Some(anchor) = anchor {
                        core.active_action = Some(crate::types::SessionActionActive {
                            kind: "turn".to_string(),
                            phase: "preparing".to_string(),
                            label: Some(compact_action_label(
                                anchor.preview.as_deref().unwrap_or(&anchor.message),
                            )),
                        });
                    }
                    let snapshot = Self::snapshot_from(&core);
                    drop(core);
                    let _ = self.emit_action_update(&snapshot);
                }
                self.push_roster_delta();
                self.run_turn(engine, items).await;
            } else {
                self.idle_notify.notify_waiters();
                // Every park re-stamps the activity end: the idle-eviction
                // window measures from the TRUE last activity.
                {
                    let mut core = self.core.lock().unwrap();
                    core.last_activity_ms = crate::util::now_ms();
                }
                // A parked parent-owned child releases its kernel with
                // a snapshot flush; the next kernel use revives it.
                self.maybe_release_settled_child_kernel().await;
                // The whole-worker idle passivation (TS's
                // `idleEvictionMinutes` tier, worker-driven): the same park
                // state the kernel release proved, plus the idle clock. The
                // window arms for any idle unattached session under a live
                // threshold; the select's notified arm is the wake path — a
                // queued delivery wins the race and the next park re-arms.
                match self.idle_passivation_window() {
                    Some(remaining) => {
                        tokio::select! {
                            () = self.work_notify.notified() => {}
                            () = tokio::time::sleep(remaining) => {
                                self.maybe_request_idle_passivation().await;
                            }
                        }
                    }
                    None => {
                        self.work_notify.notified().await;
                    }
                }
            }
        }
    }

    /// Release a parked parent-owned child's kernel; the engine owns the
    /// remaining gates. Failure leaves the kernel resident.
    async fn maybe_release_settled_child_kernel(&self) {
        let release = {
            let core = self.core.lock().unwrap();
            core.rlm_depth > 0
                && core.attached_client_ids.is_empty()
                && !core.compacting
                && !core.shutdown_requested
        };
        if release {
            self.engine.release_settled_child_kernel().await;
        }
    }

    /// The idle-eviction window for an unowned session (TS's
    /// `idleEvictionMinutes` consumer, worker-side; TS `canEvictWorker`
    /// reaches roots and children alike): `Some(remaining)` when the
    /// park state holds (unattached, not compacting, not shutting down,
    /// no live background bash, no queued input in the lanes — TS
    /// `isSessionActive`'s pending-prompt-admissions arm) and the
    /// setting is a live threshold; `None` otherwise (attached
    /// sessions, `"off"`, and any state the engine gates would reject
    /// stay parked without a timer). The client-owned refusal is
    /// supervisor-side (the descriptor's `ownerClientId`). The engine gate
    /// (`SessionEngine::can_passivate_worker`) is re-checked at the fire
    /// inside [`Self::maybe_request_idle_passivation`] — the
    /// fresh-snapshot fence — so this window only decides whether to
    /// arm.
    pub(super) fn idle_passivation_window(&self) -> Option<std::time::Duration> {
        let (attached, compacting, shutdown, queued, last_activity, cwd) = {
            let core = self.core.lock().unwrap();
            (
                core.attached_client_ids.is_empty(),
                core.compacting,
                core.shutdown_requested,
                // Queued work lives only on this resident worker, so
                // the passivation must never discard it.
                !core.steering.is_empty()
                    || !core.follow_up.is_empty()
                    || !core.pending_next_turn.is_empty()
                    // A paused pump or an input pause keeps the session resident:
                    // a revival starts un-suspended and would accept a post-abort prompt.
                    || core.queued_input_suspended
                    || self.input_pauses.paused(),
                core.last_activity_ms,
                core.cwd.clone(),
            )
        };
        if !attached || compacting || shutdown || queued {
            return None;
        }
        // A live background bash keeps the worker resident (a snapshot
        // cannot resurrect a live process).
        if self.user_bash.is_running() {
            return None;
        }
        let settings =
            pa_core::settings::SettingsManager::create(&cwd, &self.passivation.agent_dir);
        let minutes = match settings.get_idle_eviction() {
            pa_core::settings::IdleEviction::Off => return None,
            pa_core::settings::IdleEviction::Minutes(minutes) => minutes,
        };
        let now = crate::util::now_ms();
        let idle_ms = now.saturating_sub(last_activity);
        let threshold_ms = minutes.saturating_mul(60_000);
        Some(std::time::Duration::from_millis(
            threshold_ms.saturating_sub(idle_ms),
        ))
    }

    /// Re-check the gates on a fresh snapshot, then ask the supervisor
    /// for the graceful stop. A failed request leaves the worker resident.
    pub(super) async fn maybe_request_idle_passivation(&self) {
        let (attached, compacting, shutdown, queued, last_activity, cwd) = {
            let core = self.core.lock().unwrap();
            (
                core.attached_client_ids.is_empty(),
                core.compacting,
                core.shutdown_requested,
                !core.steering.is_empty()
                    || !core.follow_up.is_empty()
                    || !core.pending_next_turn.is_empty()
                    || core.queued_input_suspended
                    || self.input_pauses.paused(),
                core.last_activity_ms,
                core.cwd.clone(),
            )
        };
        // Any state change since the window armed cancels the
        // passivation.
        if !attached || compacting || shutdown || queued {
            return;
        }
        if self.user_bash.is_running() {
            return;
        }
        let settings =
            pa_core::settings::SettingsManager::create(&cwd, &self.passivation.agent_dir);
        let minutes = match settings.get_idle_eviction() {
            pa_core::settings::IdleEviction::Off => return,
            pa_core::settings::IdleEviction::Minutes(minutes) => minutes,
        };
        // The idle threshold still holds on the fresh clock.
        if crate::util::now_ms().saturating_sub(last_activity) < minutes.saturating_mul(60_000) {
            return;
        }
        // The engine gate's one definition lives with the engine
        // (`SessionEngine::can_passivate_worker`); a failing worker stays resident.
        if !self.engine.can_passivate_worker().await {
            return;
        }
        // The post-await revalidation (the fresh bots' race findings):
        // the engine gate's await opened a window - a bash admitted, a
        // prompt parked in a lane, a replay prefix restored, a manual
        // compaction started, a CLIENT ATTACHED, or the worker's own
        // graceful SHUTDOWN starting during it must all cancel the stop
        // (the shutdown would cancel the compaction and disconnect the
        // new client; a stop ask under a running shutdown races the
        // worker's own exit). The shutdown arm is stricter than TS:
        // daemon-mode.ts `passivateSession` checks `shuttingDown` only
        // BEFORE its fresh-snapshot await, not after it. The bash that
        // started in the window keeps the worker resident exactly like
        // the pre-gate check.
        {
            let core = self.core.lock().unwrap();
            if core.compacting
                || core.shutdown_requested
                || core.queued_input_suspended
                || !core.attached_client_ids.is_empty()
                || !core.steering.is_empty()
                || !core.follow_up.is_empty()
                || !core.pending_next_turn.is_empty()
            {
                return;
            }
        }
        if self.input_pauses.paused() {
            return;
        }
        if self.user_bash.is_running() {
            return;
        }
        let command = serde_json::json!({
            "type": "worker_idle_passivation",
            "workerToken": self.passivation.worker_token,
            "idleMinutes": minutes,
        });
        // The timeout only bounds the ask, not the stop: the supervisor's
        // stop path runs the routed shutdown back into this worker.
        let _ = self
            .passivation
            .link
            .request(command, std::time::Duration::from_secs(30))
            .await;
    }

    /// Push a roster delta after a busy flip, so subscribed clients see
    /// live status; the queue's consumer coalesces any racing flush.
    pub(crate) fn push_roster_delta(&self) {
        self.roster_pushes.push();
    }

    /// One delivery: the first item anchors the turn and the rest ride
    /// as co-delivered user rows of the same run.
    pub(super) async fn run_turn(
        &self,
        engine: std::sync::Arc<dyn SessionEngine>,
        items: Vec<QueuedItem>,
    ) {
        let Some((first, batched)) = items.split_first() else {
            return;
        };
        self.emit_turn_event(json!({ "type": "agent_start" }));
        self.emit_turn_event(json!({ "type": "turn_start" }));
        // The pane reporter's run boundary (TS `agent_start`): working.
        self.herdr.lock().unwrap().run_started();

        let prompt_index = {
            let core = self.core.lock().unwrap();
            core.store
                .as_ref()
                .map_or(0, crate::session_store::SessionFile::message_count)
                / 2
        };
        let request = PromptRequest {
            batch: batched
                .iter()
                .map(|item| crate::engine::PromptBatchRow {
                    text: item.message.clone(),
                    images: item.images.clone(),
                })
                .collect(),
            message: first.message.clone(),
            images: first.images.clone(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: first.custom_message.clone(),
        };
        // `message_update` frames park in a single slot; other frames go
        // out direct, flushing the parked update first (wire order matches
        // event-sequence order).
        let coalescer = {
            let core = self.core.lock().unwrap();
            Arc::new(crate::streaming::TurnStreamCoalescer::new(
                core.active_session_id.clone(),
                core.generation.clone(),
            ))
        };
        let flusher = {
            let coalescer = Arc::clone(&coalescer);
            let events = self.events.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(crate::streaming::UPDATE_FLUSH_INTERVAL).await;
                    if !coalescer.flush_pending(&events) {
                        break;
                    }
                }
            })
        };
        let engine = engine.clone();
        let core = Arc::clone(&self.core);
        let events = self.events.clone();
        let turn_coalescer = Arc::clone(&coalescer);
        let herdr = std::sync::Arc::clone(&self.herdr);
        let agent_dir = crate::paths::agent_dir().unwrap_or_default();
        // Own engine clone, fenced on the session identity it serviced:
        // a branch move or replacement swaps the store mid-review.
        let review_engine = std::sync::Arc::clone(&engine);
        let review_session_id = {
            let core = self.core.lock().unwrap();
            core.store
                .as_ref()
                .map(|store| store.session_id().to_string())
                .unwrap_or_default()
        };
        // The settled outcome reaches the waiting prompt only at full
        // settle: resolving at `Done` queued a follow-up behind the
        // indefinite suspension.
        let settled_admissions: Vec<String> = items
            .iter()
            .filter_map(|item| item.admission_id.clone())
            .collect();
        let items_done: Vec<oneshot::Sender<TurnSettle>> =
            items.into_iter().filter_map(|item| item.done).collect();
        let turn_outcome = Arc::new(std::sync::Mutex::new(None::<TurnSettle>));
        let turn_outcome_slot = Arc::clone(&turn_outcome);
        // Whether the engine surfaced any `agent_end` this run (the
        // trailing synthesized frame is only a fallback).
        let engine_agent_end = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine_agent_end_seen = Arc::clone(&engine_agent_end);
        // The pane reporter's settle hold: a run that FAILED without the
        // engine's `agent_end` (a provider error before any terminal
        // assistant row) still parks its error here, so the settle's
        // fallback report can block the pane with the message instead
        // of a false idle.
        let herdr_settle_error = Arc::new(std::sync::Mutex::new(None::<String>));
        let herdr_settle_error_seen = Arc::clone(&herdr_settle_error);
        // Whether the PANE REPORTER already received this run's end —
        // set only where `run_ended` is actually called (the engine
        // `agent_end` flag above is set on SIGHT, before the abort gate
        // can drop the event, so a swallowed `agent_end` must not make
        // the settle's pane fallback skip and strand the pane working).
        let herdr_run_end = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let herdr_run_end_seen = Arc::clone(&herdr_run_end);
        // Whether the abort gate ever observed the delivery's cancel flag
        // DURING this turn (the per-event read below): the fallback
        // `agent_end` keys its silence on THIS association — an abort
        // landing after the turn's last emitted event (a late abort
        // racing the settle) never armed the gate and must not suppress
        // the completed run's fallback (the macroscope finding: the
        // post-join flag read raced `handle_abort`).
        let abort_gate_armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let abort_gate_armed_seen = Arc::clone(&abort_gate_armed);
        let turn = tokio::task::spawn_blocking(move || {
            // The engine's own terminal `turn_end` frame keeps the
            // trailing `Done` fallback silent.
            let mut engine_turn_ended = false;
            let mut active_committed = false;
            let mut active_running = false;
            // Restored next-turn rows are PREFIX rows: the "Starting" row
            // drops at the accepted row. The flip closure reads the flag
            // while the prefix loop writes it, hence the Cell.
            let emitting_prefix_rows = std::cell::Cell::new(false);
            // The outcome row names the last `auto_retry_start` error on
            // success too: one row replaces TS's per-attempt error rows
            // (operator ruling 2026-09-23).
            let mut last_retry_error: Option<String> = None;
            let mut emit = |mut event: EngineEvent| -> bool {
                // A cancelled turn stops consuming its own events, except the frames
                // TS still broadcasts for an interrupted turn: aborted row/tool settle
                // frames and the trailing `Done` (a dropped Done hung `prompt_and_wait`
                // forever).
                if matches!(event, EngineEvent::TurnEnd { .. }) {
                    engine_turn_ended = true;
                }
                if matches!(event, EngineEvent::AgentEnd { .. }) {
                    engine_agent_end_seen.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                let aborted_row = matches!(
                    &event,
                    EngineEvent::AssistantMessage(message)
                        | EngineEvent::AssistantUpdate { message: AssistantSnapshot::Wire(message), .. }
                        | EngineEvent::TurnEnd { message, .. }
                        if message.get("stopReason").and_then(Value::as_str) == Some("aborted")
                ) || matches!(
                    &event,
                    EngineEvent::AssistantUpdate { message: AssistantSnapshot::Loop(message), .. }
                        if matches!(
                            &**message,
                            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(
                                assistant,
                            )) if assistant.stop_reason == pa_agent::types::StopReason::Aborted
                        )
                ) || matches!(
                    &event,
                    EngineEvent::AgentEnd { messages }
                        if messages.iter().any(|message| {
                            message.get("stopReason").and_then(Value::as_str) == Some("aborted")
                        })
                );
                let abort_settle = matches!(
                    &event,
                    EngineEvent::ToolExecutionEnd { .. }
                        | EngineEvent::ToolResultMessage(_)
                        | EngineEvent::TurnEnd { .. }
                        | EngineEvent::AgentEnd { .. }
                        | EngineEvent::Done(_)
                        | EngineEvent::DoneAborted
                );
                let mut core = core.lock().unwrap();
                if core.abort_requested {
                    // The sighting arms the fallback's silence only when
                    // load-bearing: a sighting on a run that completed on its own
                    // cancels nothing.
                    if core.suppress_aborted_row || !(abort_settle || aborted_row) {
                        abort_gate_armed_seen.store(true, std::sync::atomic::Ordering::SeqCst);
                        return false;
                    }
                    if aborted_row || matches!(&event, EngineEvent::DoneAborted) {
                        abort_gate_armed_seen.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                }
                // The pane reporter's engine boundaries (the TS
                // `agent_start` / `agent_end` hooks and the auto-retry
                // hold): a run start or a retry keeps the pane working,
                // and the run's end settles it — an error end holds
                // working through the retry grace first, a queued-work
                // end debounces the idle. A run whose `agent_end` the
                // abort gate swallowed above never reaches here, so the
                // pane keeps its last state exactly like the TS detached
                // run.
                match &event {
                    EngineEvent::AgentStart => {
                        herdr.lock().unwrap().run_started();
                        // A later run in the same turn (the retry, the
                        // continuation) re-opens its own end: the settle
                        // fallback keys on the flag, so a run start must
                        // clear it or an end-swallowed abort of the
                        // LATER run would skip the settle and strand the
                        // pane working.
                        herdr_run_end_seen.store(false, std::sync::atomic::Ordering::SeqCst);
                    }
                    EngineEvent::AgentEnd { messages } => {
                        let more_queued = !core.steering.is_empty() || !core.follow_up.is_empty();
                        herdr
                            .lock()
                            .unwrap()
                            .run_ended(crate::herdr::error_hold_message(messages), more_queued);
                        herdr_run_end_seen.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    EngineEvent::AutoRetryStart { .. } => {
                        herdr.lock().unwrap().retry_started();
                        // The retry re-runs the turn body: its end (when
                        // the abort gate lets it through) re-sets the
                        // flag; clearing here lets a swallowed retry end
                        // still settle at the turn's close.
                        herdr_run_end_seen.store(false, std::sync::atomic::Ordering::SeqCst);
                    }
                    _ => {}
                }
                // The engine cuts its in-memory entries; its
                // `firstKeptEntryId` never matches this store's file ids,
                // so a verbatim copy retains nothing on the durable read.
                // Re-pin the boundary to the durable cut (TS: one store,
                // ids match by construction) before persist + broadcast.
                if let EngineEvent::Compaction {
                    ref mut entry,
                    event: ref mut payload,
                } = event
                {
                    if !entry.is_null() {
                        let repin_started = std::time::Instant::now();
                        let durable_entries = core
                            .store
                            .as_ref()
                            .and_then(|store| store.branch().len().checked_sub(1))
                            .unwrap_or(0);
                        if let Some(id) = core.store.as_ref().and_then(|store| {
                            store.durable_first_kept_entry_id(keep_recent_tokens(
                                &core.cwd, &agent_dir,
                            ))
                        }) {
                            entry["firstKeptEntryId"] = json!(id);
                            if let Some(result) =
                                payload.get_mut("result").and_then(Value::as_object_mut)
                            {
                                result.insert("firstKeptEntryId".to_string(), json!(id));
                            }
                        }
                        pa_core::session_engine::compaction_trace::trace(
                            "emit.compaction_repin",
                            &serde_json::json!({
                                "durableEntries": durable_entries,
                                "micros": repin_started.elapsed().as_micros(),
                            }),
                        );
                    }
                }
                let accepted_index = if emitting_prefix_rows.get() {
                    None
                } else {
                    core.in_flight_input
                        .iter()
                        .position(|input| !input.attempted)
                        .filter(|&index| match &event {
                            EngineEvent::UserMessage(_) => {
                                core.in_flight_input[index].item.custom_message.is_none()
                            }
                            EngineEvent::CustomMessage(message) => {
                                core.in_flight_input[index].item.custom_message.as_ref()
                                    == Some(message)
                            }
                            _ => false,
                        })
                };
                let mut input_persisted = false;
                match &event {
                    // A `message` entry per row (TS's appendMessage path).
                    EngineEvent::UserMessage(message) => {
                        let entry_id = accepted_index
                            .map(|index| core.in_flight_input[index].row_id.clone());
                        if let Some(store) = core.store.as_mut() {
                            input_persisted = if let Some(id) = entry_id.as_deref() {
                                store.persist_input_entry(
                                    "message", json!({ "message": message }), id,
                                )
                            } else {
                                store.persist_entry("message", json!({ "message": message }))
                            }
                            .is_ok();
                        }
                        if let Some(index) = accepted_index {
                            core.in_flight_input[index].attempted = true;
                            core.in_flight_input[index].committed = input_persisted;
                            if !input_persisted {
                                core.recovery_hold = true;
                                core.queued_input_suspended = true;
                                core.abort_requested = true;
                            }
                        }
                    }
                    EngineEvent::AssistantMessage(message)
                    | EngineEvent::ToolResultMessage(message) => {
                        if let Some(store) = core.store.as_mut() {
                            let _ = store.persist_entry("message", json!({ "message": message }));
                        }
                    }
                    // The in-flight tool-call set, updated under the same core lock
                    // the frames sequence under: the roster feed never reads a
                    // half-applied transition.
                    EngineEvent::ToolExecutionStart { tool_call_id, .. } => {
                        core.running_tool_calls.insert(tool_call_id.clone());
                    }
                    EngineEvent::ToolExecutionEnd { tool_call_id, .. } => {
                        core.running_tool_calls.remove(tool_call_id);
                    }
                    EngineEvent::CustomMessage(message) => {
                        let entry_id = accepted_index
                            .map(|index| core.in_flight_input[index].row_id.clone());
                        if let Some(store) = core.store.as_mut() {
                            let fields = json!({
                                "customType": message.get("customType").cloned().unwrap_or(Value::Null),
                                "content": message.get("content").cloned().unwrap_or(Value::Null),
                                "display": message.get("display").cloned().unwrap_or(Value::Bool(true)),
                                "details": message.get("details").cloned().unwrap_or(Value::Null),
                            });
                            input_persisted = if let Some(id) = entry_id.as_deref() {
                                store.persist_input_entry("custom_message", fields, id)
                            } else {
                                store.persist_entry("custom_message", fields)
                            }
                            .is_ok();
                        }
                        if let Some(index) = accepted_index {
                            core.in_flight_input[index].attempted = true;
                            core.in_flight_input[index].committed = input_persisted;
                            if !input_persisted {
                                core.recovery_hold = true;
                                core.queued_input_suspended = true;
                                core.abort_requested = true;
                            }
                        }
                    }
                    EngineEvent::Compaction { entry, .. } => {
                        // A skipped compaction carries a null entry:
                        // publish the event, never persist it.
                        if let Some(store) = core.store.as_mut().filter(|_| !entry.is_null()) {
                            let persist_started = std::time::Instant::now();
                            let _ = store.persist_entry("compaction", entry.clone());
                            pa_core::session_engine::compaction_trace::trace(
                                "emit.compaction_persist",
                                &serde_json::json!({
                                    "micros": persist_started.elapsed().as_micros(),
                                }),
                            );
                        }
                    }
                    // The durable mirror of a goal-state change: each row is the new state.
                    EngineEvent::GoalUpdate { goal } => {
                        if let Some(store) = core.store.as_mut() {
                            let _ = store.persist_entry(
                                "custom",
                                json!({
                                    "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
                                    "data": goal,
                                }),
                            );
                        }
                    }
                    _ => {}
                }
                if accepted_index.is_some() && !input_persisted {
                    *turn_outcome_slot.lock().unwrap() = Some(TurnSettle::Failed(
                        "Input persistence is uncertain; queue held for recovery".to_string(),
                    ));
                    return false;
                }
                // The `committing`/`running` transitions ride the events that mark the moments.
                let mut action_frame: Option<SessionActionSnapshot> = None;
                if !active_committed && input_persisted && accepted_index.is_some()
                {
                    active_committed = true;
                    if let Some(active) = core.active_action.as_mut() {
                        active.phase = "committing".to_string();
                    }
                    action_frame = Some(session_snapshot(&core));
                } else if !active_running
                    && matches!(
                        event,
                        EngineEvent::AssistantUpdate { .. } | EngineEvent::AssistantMessage(_)
                    )
                {
                    active_running = true;
                    if let Some(active) = core.active_action.as_mut() {
                        active.phase = "running".to_string();
                    }
                    action_frame = Some(session_snapshot(&core));
                }
                let done_result = match &event {
                    EngineEvent::Done(result) => {
                        // The turn boundary releases RLM child prompt
                        // tasks waiting on it.
                        engine.on_turn_done();
                        pa_core::session_engine::compaction_trace::trace(
                            "turn.done_emitted",
                            &serde_json::json!({
                                "ok": matches!(result, Ok(())),
                            }),
                        );
                        Some(match result {
                            Ok(()) => TurnSettle::Completed,
                            Err(error) => TurnSettle::Failed(error.clone()),
                        })
                    }
                    // The aborted settle carries its classification
                    // structurally, not through the error text.
                    EngineEvent::DoneAborted => {
                        engine.on_turn_done();
                        Some(TurnSettle::Aborted)
                    }
                    _ => None,
                };
                // One event may map to several wire frames (a custom row
                // is a message_start + message_end pair).
                let mut frames: Vec<Value> = match event {
                    EngineEvent::UserMessage(message) => {
                        vec![
                            json!({ "type": "message_start", "message": message }),
                            json!({ "type": "message_end", "message": message }),
                        ]
                    }
                    EngineEvent::AssistantUpdate {
                        message,
                        stream_event,
                    } => {
                        let stream_kind = stream_event
                            .as_ref()
                            .and_then(|event| event.get("type"))
                            .and_then(Value::as_str);
                        let starts_message = stream_kind == Some("start");
                        // A block-end event settles the parked delta run, so it travels
                        // direct (flushing the parked update first, in order).
                        let settles_run = matches!(
                            stream_kind,
                            Some("text_end" | "thinking_end" | "toolcall_end")
                        );
                        if !starts_message && !settles_run {
                            // Streaming updates park in the coalescer; `park_update` only
                            // returns false after the turn joined, which cannot race this closure.
                            if let Ok(path) = std::env::var("PA_DAEMON_EVENT_LOG") {
                                use std::io::Write;
                                if let Some(value) = message.clone().into_wire() {
                                    if let Ok(mut file) = std::fs::OpenOptions::new()
                                        .create(true)
                                        .append(true)
                                        .open(&path)
                                    {
                                        let mut event = json!({
                                            "type": "message_update",
                                            "message": value,
                                        });
                                        if let Some(stream_event) = &stream_event {
                                            event["assistantMessageEvent"] = stream_event.clone();
                                        }
                                        let _ = writeln!(file, "{event}");
                                    }
                                }
                            }
                            let sequence = core.last_event_sequence + 1;
                            core.last_event_sequence = sequence;
                            let delta = stream_event
                                .as_ref()
                                .and_then(|event| event.get("delta"))
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            if !turn_coalescer.park_update(
                                message,
                                stream_kind.unwrap_or_default(),
                                delta,
                                sequence,
                            ) {
                                return false;
                            }
                            Vec::new()
                        } else {
                            match message.into_wire() {
                                Some(value) => {
                                    let mut event = json!({
                                        "type": if starts_message { "message_start" } else { "message_update" },
                                        "message": value,
                                    });
                                    if let Some(stream_event) = stream_event {
                                        event["assistantMessageEvent"] = stream_event;
                                    }
                                    vec![event]
                                }
                                // Unreachable for streamed partials; a
                                // failed conversion frames nothing.
                                None => Vec::new(),
                            }
                        }
                    }
                    EngineEvent::AssistantMessage(message) => {
                        vec![json!({ "type": "message_end", "message": message })]
                    }
                    EngineEvent::ToolExecutionStart {
                        tool_call_id,
                        tool_name,
                        args,
                    } => vec![json!({
                        "type": "tool_execution_start",
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "args": args,
                    })],
                    EngineEvent::ToolExecutionUpdate {
                        tool_call_id,
                        partial_result,
                    } => vec![json!({
                        "type": "tool_execution_update",
                        "toolCallId": tool_call_id,
                        "partialResult": partial_result,
                    })],
                    EngineEvent::ToolExecutionEnd {
                        tool_call_id,
                        result,
                        is_error,
                    } => vec![json!({
                        "type": "tool_execution_end",
                        "toolCallId": tool_call_id,
                        "result": result,
                        "isError": is_error,
                    })],
                    EngineEvent::ToolResultMessage(message)
                    | EngineEvent::CustomMessage(message) => vec![
                        json!({ "type": "message_start", "message": message }),
                        json!({ "type": "message_end", "message": message }),
                    ],
                    EngineEvent::CompactionStart { event }
                    | EngineEvent::Compaction { event, .. } => vec![event],
                    EngineEvent::GoalUpdate { goal } => vec![json!({
                        "type": "goal_update",
                        "goal": goal,
                    })],
                    EngineEvent::RefineComplete { result } => vec![json!({
                        "type": "refine_complete",
                        "result": result,
                    })],
                    EngineEvent::RefineFailed { error } => vec![json!({
                        "type": "refine_failed",
                        "error": error,
                    })],
                    // The loop's run-boundary frames (TS `agent_start`/
                    // `agent_end`): the run's whole message set rides
                    // `agent_end` (one frame per agent run — retried and
                    // continued runs included); the rows themselves
                    // already went out through their own events, so no
                    // persist here.
                    EngineEvent::AgentStart => vec![json!({ "type": "agent_start" })],
                    EngineEvent::AgentEnd { messages } => vec![json!({
                        "type": "agent_end",
                        "messages": messages,
                    })],
                    // Turn-boundary frames: the terminal message and tool
                    // results ride `turn_end`; no persist here.
                    EngineEvent::TurnStart => vec![json!({ "type": "turn_start" })],
                    EngineEvent::TurnEnd {
                        message,
                        tool_results,
                    } => vec![json!({
                        "type": "turn_end",
                        "message": message,
                        "toolResults": tool_results,
                    })],
                    // The fallback terminal frame, silent once the
                    // engine's own frame covered the run.
                    EngineEvent::Done(Ok(())) if !engine_turn_ended => {
                        vec![json!({ "type": "turn_end" })]
                    }
                    EngineEvent::Done(Err(error)) if !engine_turn_ended => {
                        herdr_settle_error_seen
                            .lock()
                            .unwrap()
                            .replace(error.clone());
                        vec![json!({ "type": "turn_end", "error": error })]
                    }
                    EngineEvent::DoneAborted if !engine_turn_ended => vec![json!({
                        "type": "turn_end",
                        "error": ABORTED_TURN_SETTLE_ERROR,
                    })],
                    EngineEvent::Done(Ok(()) | Err(_)) | EngineEvent::DoneAborted => Vec::new(),
                    EngineEvent::AutoRetryStart {
                        attempt,
                        max_attempts,
                        delay_ms,
                        error_message,
                        reason,
                    } => {
                        last_retry_error = Some(error_message.clone());
                        let mut event = json!({
                            "type": "auto_retry_start",
                            "attempt": attempt,
                            "maxAttempts": max_attempts,
                            "delayMs": delay_ms,
                            "errorMessage": error_message,
                        });
                        match reason {
                            pa_core::session_engine::auto_retry::RetryStartReason::Quick => {}
                            pa_core::session_engine::auto_retry::RetryStartReason::Backup {
                                backup_model,
                            } => {
                                event["reason"] = json!("backup");
                                event["backupModel"] = json!(backup_model);
                            }
                        }
                        vec![event]
                    }
                    EngineEvent::AutoRetryEnd {
                        success,
                        attempt,
                        final_error,
                        restored_model,
                    } => {
                        let mut event = json!({
                            "type": "auto_retry_end",
                            "success": success,
                            "attempt": attempt,
                        });
                        if let Some(final_error) = &final_error {
                            event["finalError"] = json!(final_error);
                        }
                        if let Some(restored_model) = restored_model {
                            event["restoredModel"] = json!(restored_model);
                        }
                        // The episode's ONE durable outcome row (operator ruling
                        // 2026-09-23), instead of one error row per failed attempt.
                        let error = final_error
                            .or_else(|| last_retry_error.take())
                            .unwrap_or_else(|| "Unknown error".to_string());
                        last_retry_error = None;
                        let outcome = pa_core::session_engine::messages::
                            create_provider_retry_outcome_message(success, attempt, &error);
                        let outcome = crate::session_commands::custom_message_value(&outcome);
                        if outcome.is_object() {
                            if let Some(store) = core.store.as_mut() {
                                let _ = store.persist_entry(
                                    "custom_message",
                                    json!({
                                        "customType": outcome.get("customType").cloned().unwrap_or(Value::Null),
                                        "content": outcome.get("content").cloned().unwrap_or(Value::Null),
                                        "display": outcome.get("display").cloned().unwrap_or(Value::Bool(true)),
                                        "details": outcome.get("details").cloned().unwrap_or(Value::Null),
                                    }),
                                );
                            }
                        }
                        vec![
                            event,
                            json!({ "type": "message_start", "message": outcome }),
                            json!({ "type": "message_end", "message": outcome }),
                        ]
                    }
                };
                // The phase flip's queue-update frame rides the same batch,
                // after the row frames it follows; an unchanged projection
                // stays silent.
                if let Some(snapshot) = action_frame {
                    if core.last_action_snapshot.as_ref() != Some(&snapshot) {
                        core.last_action_snapshot = Some(snapshot.clone());
                        frames.push(json!({
                            "type": "session_action_update",
                            "actions": snapshot,
                        }));
                    }
                }
                // Verification seam: dump the emitted session events for
                // harness debugging (PA_DAEMON_EVENT_LOG=<path>).
                if let Ok(path) = std::env::var("PA_DAEMON_EVENT_LOG") {
                    use std::io::Write;
                    if let Ok(mut file) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&path)
                    {
                        for frame in &frames {
                            let _ = writeln!(file, "{frame}");
                        }
                    }
                }
                let mut direct_payloads: Vec<Vec<u8>> = Vec::new();
                for event_json in frames {
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
                        event: event_json,
                        meta: Some(meta),
                        rest: Map::default(),
                    };
                    let payload = serde_json::to_vec(&outbound).unwrap_or_default();
                    direct_payloads.push(payload);
                }
                drop(core);
                // Direct frames go out immediately (flushing the parked update
                // first, preserving event-sequence order); a pure-update batch
                // stays parked for the flusher.
                if !direct_payloads.is_empty() {
                    turn_coalescer.send_direct(&direct_payloads, &events);
                }
                // The waiting response must observe the frames'
                // sequences and resolves only after the idle flip.
                if let Some(result) = done_result {
                    *turn_outcome_slot.lock().unwrap() = Some(result);
                }
                true
            };
            let aborted_probe = {
                let core = Arc::clone(&core);
                // `abort_retry` stops an in-flight retry without
                // aborting the turn itself.
                move || {
                    core.lock().unwrap().abort_requested
                        || core.lock().unwrap().retry_abort_requested
                }
            };
            let parked = {
                let mut core = core.lock().unwrap();
                std::mem::take(&mut core.pending_next_turn)
            };
            emitting_prefix_rows.set(!parked.is_empty());
            for row in parked {
                if !emit(EngineEvent::CustomMessage(row)) {
                    break;
                }
            }
            emitting_prefix_rows.set(false);
            engine.run_prompt(prompt_index, request, &aborted_probe, &mut emit);
        });
        let _ = turn.await;
        // The emit path is joined: a stale parked partial must not
        // surface after the settle events.
        coalescer.close();
        flusher.abort();

        {
            let mut core = self.core.lock().unwrap();
            core.busy = false;
            if !core.shutdown_requested && !core.recovery_hold {
                core.in_flight_input.clear();
            }
            core.active_action = None;
            core.running_admission_ids.clear();
        }
        self.push_roster_delta();
        // The fallback `agent_end` for runs that ended without a model
        // turn (session commands, pre-model failures): the engine's own
        // per-run frames (one per agent run, retried and continued runs
        // included — the TS `agent_end` `messages` payload) are the real
        // frames, and a run whose `agent_end` the abort gate swallowed
        // stays silent exactly like TS (the compact path's detached run).
        // An ABORTED settle keeps the same silence: the admission
        // consult's pre-run abort ends the turn with NO engine
        // `agent_end` at all (no run registered — the
        // compact-interrupt probe's suppressed-run wire shape, which the
        // fallback would otherwise break with a synthesized frame). The
        // association is the abort GATE's own observation during the
        // turn (the per-event flag read), never a post-join re-read of
        // the flag: an abort landing after the turn's last emitted event
        // cancels nothing of this run and must not suppress its fallback
        // (the flag stays armed until the next pickup — a settle-time
        // re-read would race `handle_abort` and silence a completed
        // session-command or pre-model-failure run).
        let engine_reported_run_end = engine_agent_end.load(std::sync::atomic::Ordering::SeqCst);
        if !engine_reported_run_end && !abort_gate_armed.load(std::sync::atomic::Ordering::SeqCst) {
            self.emit_turn_event(json!({ "type": "agent_end" }));
        }
        {
            // The settle's boundary state: the run's own `agent_end`
            // already reported (inside the emit closure) — the pane
            // flag, not the engine's sight flag, so an `agent_end` the
            // abort gate swallowed still settles here too; a run that
            // ended without one reports here — the TS fallback arm.
            // This includes the aborted settle: the run's `agent_start`
            // already flipped the pane working, so suppressing the end
            // would strand the pane working forever (the wire emit's
            // abort-gate suppression is about the TUI's frames, not the
            // pane). A failed run (Done(Err) with no `agent_end`) parks
            // its error in the settle cell and blocks like the TS
            // error-hold arm instead of reporting a false idle.
            // `core.busy` flipped to false above; queued lanes still
            // holding items keep the settle debounced so the next pickup
            // cancels the idle flip.
            let (error_hold, more_queued) = {
                let core = self.core.lock().unwrap();
                (
                    herdr_settle_error.lock().unwrap().take(),
                    !core.steering.is_empty() || !core.follow_up.is_empty(),
                )
            };
            if !herdr_run_end.load(std::sync::atomic::Ordering::SeqCst) {
                self.herdr
                    .lock()
                    .unwrap()
                    .run_ended(error_hold, more_queued);
            }
        }
        let snapshot = {
            let core = self.core.lock().unwrap();
            Self::snapshot_from(&core)
        };
        // The settle checkpoint: the idle flip precedes it, so an unclean
        // kill from here on must NOT read as interrupted work; undelivered
        // lanes stay busy (admitted work a revive must redeliver).
        checkpoint_queue_recovery(
            &self.recovery,
            &self.core,
            QueueCheckpoint::Settle {
                operation: "turn_end",
            },
        );
        let session_path = {
            let core = self.core.lock().unwrap();
            core.store.as_ref().map(|store| store.path.clone())
        };
        if let Some(path) = session_path {
            let _ =
                tokio::task::spawn_blocking(move || std::fs::File::open(&path)?.sync_all()).await;
        }
        let _ = self.emit_action_update(&snapshot);
        self.idle_notify.notify_waiters();
        for admission_id in settled_admissions {
            self.prompt_admissions.clear(&admission_id);
        }
        // The turn is fully unwound: the waiting prompt now resolves, so
        // a client's next request always observes the idle session.
        let settled_outcome = turn_outcome.lock().unwrap().take();
        if let Some(result) = settled_outcome {
            for done in items_done {
                let _ = done.send(result.clone());
            }
        }
        // The compact-trigger review services off the settle as a
        // background round: the queued next prompt's admission never
        // waits on it.
        {
            let engine = review_engine;
            let core = Arc::clone(&self.core);
            let events = self.events.clone();
            let review_session_id = review_session_id.clone();
            tokio::spawn(async move {
                // The round takes the engine's session mutex on the blocking
                // pool, never on this async task: a `blocking_lock` from the
                // runtime thread deadlocks.
                let refined = tokio::task::spawn_blocking(move || {
                    pa_core::session_engine::compaction_trace::trace(
                        "autorefine.review_started",
                        &serde_json::Value::Null,
                    );
                    let outcome = engine.consume_compact_auto_refine();
                    pa_core::session_engine::compaction_trace::trace(
                        "autorefine.review_done",
                        &serde_json::json!({ "ran": outcome.is_ok() }),
                    );
                    outcome
                })
                .await
                .unwrap_or_else(|error| {
                    Err(anyhow::anyhow!("auto-refinement task failed: {error}"))
                });
                match refined {
                    Ok(Some(result)) => {
                        // The outcome row and the model-facing notice (when edits
                        // applied) persist like the `/refine` command's rows, fenced on
                        // the serviced session.
                        let outcome_row =
                            pa_core::session_engine::refine::create_refinement_outcome_message(
                                &result,
                            );
                        if let Ok(value) = serde_json::to_value(
                            pa_types::session::AgentMessage::Custom(outcome_row),
                        ) {
                            emit_refinement_row(&core, &events, &review_session_id, &value);
                        }
                        if result.applied_edits.iter().any(|edit| edit.applied) {
                            let notice =
                                pa_core::session_engine::refine::create_refinement_notice_message(
                                    &result,
                                    pa_core::session_engine::refine::RefinementSource::Auto,
                                );
                            if let Ok(value) = serde_json::to_value(
                                pa_types::session::AgentMessage::Custom(notice),
                            ) {
                                emit_refinement_row(&core, &events, &review_session_id, &value);
                            }
                        }
                        emit_refinement_event_for_session(
                            &core,
                            &events,
                            &review_session_id,
                            crate::worker::refine_complete_event(&result),
                        );
                    }
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!("pa-daemon: auto-refinement after compaction failed: {error:#}");
                        emit_refinement_event_for_session(
                            &core,
                            &events,
                            &review_session_id,
                            json!({ "type": "refine_failed", "error": format!("{error:#}") }),
                        );
                    }
                }
            });
        }
    }

    /// The post-turn queue projection: an unchanged snapshot stays
    /// silent.
    fn emit_action_update(&self, snapshot: &SessionActionSnapshot) -> Result<()> {
        let mut core = self.core.lock().unwrap();
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

    fn snapshot_from(core: &SessionCore) -> SessionActionSnapshot {
        session_snapshot(core)
    }

    fn emit_turn_event(&self, event: Value) {
        let mut core = self.core.lock().unwrap();
        let sequence = core.last_event_sequence + 1;
        core.last_event_sequence = sequence;
        let meta = create_daemon_event_meta(
            &core.active_session_id,
            sequence,
            None,
            Some(&core.generation),
        );
        let outbound = DaemonOutbound::SessionEvent {
            active_session_id: self.active_session_id.clone(),
            event,
            meta: Some(meta),
            rest: Map::default(),
        };
        let payload = serde_json::to_vec(&outbound).unwrap_or_default();
        drop(core);
        self.events.send(OutboundFrame::session_event(payload));
    }
}

/// The compaction cut budget the engine ran with: the durable boundary
/// re-cut in the turn callback must pin the same cut.
fn keep_recent_tokens(cwd: &str, agent_dir: &std::path::Path) -> u64 {
    pa_core::settings::SettingsManager::create(cwd, agent_dir)
        .settings()
        .compaction
        .clone()
        .unwrap_or_default()
        .keep_recent_tokens
        .unwrap_or(pa_core::session_engine::compaction::DEFAULT_KEEP_RECENT_TOKENS)
}
