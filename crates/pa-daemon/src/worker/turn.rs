//! One agent turn: the runner that admits queued input, drives the
//! engine, and settles the result.
use super::*;

use std::sync::{Arc, Mutex};

pub(super) struct TurnRunner {
    pub(crate) core: Arc<Mutex<SessionCore>>,
    /// The input-pause table (the admission gate holds queued input).
    pub(super) input_pauses: crate::session_input_pause::InputPauseTable,
    /// The prompt-admission registry: a queued admitted prompt commits
    /// when its turn starts and clears when the turn settles.
    pub(super) prompt_admissions: crate::prompt_admission::WorkerAdmissions,
    pub(super) work_notify: Arc<Notify>,
    pub(super) idle_notify: Arc<Notify>,
    pub(crate) events: Arc<EventPump>,
    pub(super) engine: std::sync::Arc<dyn SessionEngine>,
    /// Shared worker recovery journal (queue snapshot persistence).
    pub(super) recovery: Arc<Mutex<Option<WorkerRecoveryJournal>>>,
    pub(super) active_session_id: String,
    /// The coalescing roster push queue: the busy flips enqueue here and
    /// the queue's consumer composes and ships the summary (the
    /// event-driven arm lives in [`crate::roster_activity`]).
    pub(super) roster_pushes: crate::roster_activity::RosterPushQueue,
}

impl TurnRunner {
    pub(super) async fn run(self) {
        loop {
            let engine = self.engine.clone();
            let item: Option<Vec<QueuedItem>> = {
                let mut core = self.core.lock().unwrap();
                if core.shutdown_requested {
                    drop(core);
                    // The shutdown handler waits on the idle notify for
                    // the in-flight run to settle before it disposes the
                    // kernel; this is the runner's last chance to fire it
                    // (the parking arm below never runs once shutdown is
                    // requested, and the runner always reaches this point
                    // with the previous run already settled).
                    self.idle_notify.notify_waiters();
                    return;
                }
                // The input-admission gate (TS
                // `_sessionInputAdmissionPauses`): held pauses keep
                // queued input queued until the release wakes the runner.
                // The abort-suspension gate (TS `_sessionInputPumpSuspended`,
                // which parks the pump after `requestAbort`/manual `compact`):
                // already-queued items survive parked until a resume site
                // clears the flag.
                if self.input_pauses.paused() || core.queued_input_suspended {
                    core.busy = false;
                    None
                } else if core.steering.front().is_some() {
                    let items = gather_delivery_batch(&mut core, Lane::Steering);
                    core.busy = true;
                    core.abort_requested = false;
                    core.retry_abort_requested = false;
                    // The run starts with no tool calls in flight (TS
                    // resets `pendingToolCalls` at run start).
                    core.running_tool_calls.clear();
                    Some(items)
                } else if core.follow_up.front().is_some() {
                    let items = gather_delivery_batch(&mut core, Lane::FollowUp);
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
                // No pickup checkpoint by design: every path that
                // admits work into the lanes has already recorded its
                // busy=true evidence at admission (`prompt_accepted`,
                // `steer_queued`/`follow_up_queued`, `actions_restored`),
                // so the whole in-flight window reads as interrupted
                // work without another journal write on the runner; the
                // settle's `turn_end` verdict is what parks the session
                // later.
                // The pickup projection (TS `_pumpSessionInputs` emits the
                // queue update at the action's `preparing` transition): the
                // delivered item leaves the queue projection BEFORE its
                // turn starts, so a client's queue strip drops the row at
                // delivery time. Without it the strip keeps the delivered
                // message for the whole turn (dogfood P0: the steered
                // message sends but still shows in the queue) and a browse
                // edit addressed at the stale row is rejected as changed.
                // A queue-visible delivery carries the active action
                // through its TS phase transitions: `preparing` projects
                // here at pickup, then `committing` at the turn's first
                // row (the moment the prompt becomes visible in the
                // conversation — TS's commit fence) and `running` at the
                // turn's first assistant frame, both emitted by the
                // runner's event path, cleared at the settle. The
                // `preparing` projection is what a client renders as the
                // queued strip's "Starting" row (TS #2063): the prompt
                // left its lane, and until the turn's rows land the strip
                // is the only place it is visible. An invisible item (an
                // idle session's direct prompt admission, injected goal
                // and autonomous continuations) projects the plain pickup
                // like TS's `queueVisible` filter, so an all-invisible
                // batch sets no active action at all.
                // The active label is the delivery's labeled preview when
                // it carries one (TS #2063 `queuedAgentMessagePreview`:
                // `payload.preview ?? payload.text`) — an agent-message
                // delivery shows its "Agent message received: ..." row,
                // not the raw envelope.
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
                    let snapshot = self.snapshot_from(&core);
                    drop(core);
                    let _ = self.emit_action_update(&snapshot);
                }
                // The busy flip reaches the supervisor's roster before the
                // turn runs (TS pushes the same transition).
                self.push_roster_delta();
                self.run_turn(engine, items).await;
            } else {
                self.idle_notify.notify_waiters();
                self.work_notify.notified().await;
            }
        }
    }

    /// Push one roster delta to the supervisor (the Rust-native form of
    /// the TS `roster_delta` worker frame): the worker's summary after a
    /// busy flip, so subscribed clients see live status without polling.
    /// The queue's consumer composes and ships the summary, coalescing
    /// this request with any event-driven flush that raced the flip; a
    /// dead link reconnects on the next flush, and a supervisor restart
    /// re-seeds the entry from registration.
    pub(crate) fn push_roster_delta(&self) {
        self.roster_pushes.push();
    }

    /// One delivery: a single item, or the batch the pump gathered (TS
    /// `_startPreparedTurnActions`): the first item anchors the turn and
    /// the rest ride as co-delivered user rows of the same run.
    pub(super) async fn run_turn(
        &self,
        engine: std::sync::Arc<dyn SessionEngine>,
        items: Vec<QueuedItem>,
    ) {
        let Some((first, batched)) = items.split_first() else {
            return;
        };
        // An admitted prompt's turn started: its prompt admission commits
        // (TS `commitAdmission`) — one per batched item, in delivery order.
        for admission_id in items.iter().filter_map(|item| item.admission_id.as_ref()) {
            self.prompt_admissions.commit(admission_id);
        }
        self.emit_turn_event(json!({ "type": "agent_start" }));
        self.emit_turn_event(json!({ "type": "turn_start" }));

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
        // Live token-stream coalescing for this turn: the emit path parks
        // `message_update` frames in a single slot and a flusher task
        // broadcasts at most one parked snapshot per interval, while every
        // other frame goes out directly (flushing the parked update first,
        // so wire order matches event-sequence order exactly).
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
        let agent_dir = crate::paths::agent_dir().unwrap_or_default();
        // The settle tail's background compact-trigger servicing owns its
        // own engine clone (the turn closure below moves the shadowing
        // clone), and fences its rows on the session identity it serviced
        // (a branch move or replacement swaps the store mid-review).
        let review_engine = std::sync::Arc::clone(&engine);
        let review_session_id = {
            let core = self.core.lock().unwrap();
            core.store
                .as_ref()
                .map(|store| store.session_id().to_string())
                .unwrap_or_default()
        };
        // The turn's settled outcome reaches the waiting prompt only
        // after the runner flipped the session back to idle (TS
        // `promptAndWait` resolves after the full settle): the blocking
        // task parks the result in this slot and `run_turn` resolves the
        // waiter once the turn is fully unwound. Resolving at the `Done`
        // event instead (the pre-fix behavior) let a follow-up request
        // land in the pre-idle window where `core.busy` is still set, so
        // the suspension gate queued it behind the (indefinite)
        // suspension instead of rejecting it — the f7 suspension
        // sequence's post-abort prompt hung exactly there.
        // The batch's waiting prompts (TS `promptAndWait`): one waiter per
        // queued `prompt_and_wait` item in the delivery, each resolved at
        // the same fully-settled point. The settled admissions clear at the
        // same point (collected before the items are consumed).
        let settled_admissions: Vec<String> = items
            .iter()
            .filter_map(|item| item.admission_id.clone())
            .collect();
        let items_done: Vec<oneshot::Sender<TurnSettle>> =
            items.into_iter().filter_map(|item| item.done).collect();
        let turn_outcome = Arc::new(std::sync::Mutex::new(None::<TurnSettle>));
        let turn_outcome_slot = Arc::clone(&turn_outcome);
        // Whether the engine surfaced any `agent_end` boundary this item
        // (each agent run ends with one — retried and continued runs
        // included). The worker's trailing synthesized frame is a fallback
        // for runs that ended without a model turn (session commands,
        // pre-model failures) and stays silent once a run's own frame
        // arrived — or was swallowed by the abort gate, which TS mirrors
        // by showing no `agent_end` at all (the compact path's detached
        // run).
        let engine_agent_end = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine_agent_end_seen = Arc::clone(&engine_agent_end);
        let turn = tokio::task::spawn_blocking(move || {
            // Whether the engine already emitted its own terminal
            // `turn_end` frame this run (the loop emits one per turn —
            // settled, aborted, and failed alike). The trailing `Done`
            // fallback frame stays silent then; it exists only for runs
            // that end without a model turn (session commands, pre-model
            // failures).
            let mut engine_turn_ended = false;
            // TS #2063: whether this run's active action already flipped
            // to `committing`/`running` — each flip rides the first event
            // that marks the moment (the turn's first row commits it, the
            // first assistant frame runs it), so the queue's `preparing`
            // projection spans the real pickup -> rows-land window a
            // client renders as the strip's "Starting" row.
            let mut active_committed = false;
            let mut active_running = false;
            // Restored next-turn rows ride this delivery as PREFIX rows
            // (before the accepted prompt): they render in the
            // conversation, but they are not the prompt's rows-land moment
            // — the "Starting" row must survive them and drop at the
            // accepted row (the bots' commit-fence finding). The flip
            // closure reads the flag while the prefix loop writes it, so
            // it is a Cell (the runner is single-threaded here).
            let emitting_prefix_rows = std::cell::Cell::new(false);
            // The last error of the active retry episode (the
            // `auto_retry_start` errorMessage): the episode's durable
            // outcome row names it on success too — the final event
            // carries no error then (SANCTIONED DIVERGENCE, operator
            // ruling 2026-09-23: one outcome row replaces the per-attempt
            // error rows TS keeps).
            let mut last_retry_error: Option<String> = None;
            let mut emit = |mut event: EngineEvent| -> bool {
                // Sequence + persist under the core lock, then broadcast.
                // The abort flag lives on the session core (`abort`
                // command): a cancelled turn stops consuming its own
                // events — except the frames TS still broadcasts for an
                // interrupted turn. TS applies no post-abort gate at all:
                // the agent abort cancels the provider fetch and turns the
                // in-flight tool into an error result, and the frames that
                // settle the cancelled run reach the listeners and the
                // session store (the tool-phase probe: `abort` mid-kernel
                // cell broadcasts tool_execution_end + the aborted
                // toolResult row pair + turn_end + agent_end, exactly like
                // a settled turn). The only post-abort noise TS never
                // shows is the cancelled fetch's stream stragglers (the
                // provider stream stops at the cancel, and TS tool
                // updates stop at `acceptingUpdates = false`), so the gate
                // drops the stream-update family and forwards:
                // - the aborted assistant row (`createAbortedAssistantMessage`:
                //   the pair broadcasts, `appendMessage` persists, the
                //   trailing `turn_end` and `agent_end` carry the row),
                //   closed by `suppress_aborted_row` for the detached-run
                //   paths (TS `compact`/branch navigation);
                // - the aborted tool's settle frames (the error
                //   tool_execution_end, the toolResult row pair, the
                //   cancelled run's own turn_end/agent_end);
                // - the engine's trailing `Done` outcome, which parks the
                //   turn result so a waiting `prompt_and_wait` resolves at
                //   the settle (a dropped Done hung the response forever —
                //   the abort UX probe).
                if matches!(event, EngineEvent::TurnEnd { .. }) {
                    engine_turn_ended = true;
                }
                if matches!(event, EngineEvent::AgentEnd { .. }) {
                    engine_agent_end_seen.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                let aborted_row = matches!(
                    &event,
                    EngineEvent::AssistantMessage(message)
                        | EngineEvent::AssistantUpdate { message, .. }
                        | EngineEvent::TurnEnd { message, .. }
                        if message.get("stopReason").and_then(Value::as_str) == Some("aborted")
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
                if core.abort_requested
                    && (core.suppress_aborted_row || !(abort_settle || aborted_row))
                {
                    return false;
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
                            serde_json::json!({
                                "durableEntries": durable_entries,
                                "micros": repin_started.elapsed().as_micros(),
                            }),
                        );
                    }
                }
                match &event {
                    // The session-file form of a tool result: a `message`
                    // entry with the `role: "toolResult"` payload (TS
                    // `_processAgentEvent` appendMessage path).
                    EngineEvent::UserMessage(message)
                    | EngineEvent::AssistantMessage(message)
                    | EngineEvent::ToolResultMessage(message) => {
                        if let Some(store) = core.store.as_mut() {
                            let _ = store.persist_entry("message", json!({ "message": message }));
                        }
                    }
                    // The in-flight tool-call set (TS
                    // `session.state.pendingToolCalls`): the summary's
                    // `isRunningTools` derives from its size, and the
                    // update happens under the same core lock the frames
                    // sequence under, so the roster feed composed from a
                    // broadcast trigger frame never reads a half-applied
                    // transition.
                    EngineEvent::ToolExecutionStart { tool_call_id, .. } => {
                        core.running_tool_calls.insert(tool_call_id.clone());
                    }
                    EngineEvent::ToolExecutionEnd { tool_call_id, .. } => {
                        core.running_tool_calls.remove(tool_call_id);
                    }
                    // The session-file form of a custom row (TS
                    // `appendCustomMessageEntry`: customType/content/display/
                    // details fields on a `custom_message` entry).
                    EngineEvent::CustomMessage(message) => {
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
                    EngineEvent::Compaction { entry, .. } => {
                        // A skipped compaction carries a null entry (the
                        // skip shape): publish the event, never persist it.
                        if let Some(store) = core.store.as_mut().filter(|_| !entry.is_null()) {
                            let persist_started = std::time::Instant::now();
                            let _ = store.persist_entry("compaction", entry.clone());
                            pa_core::session_engine::compaction_trace::trace(
                                "emit.compaction_persist",
                                serde_json::json!({
                                    "micros": persist_started.elapsed().as_micros(),
                                }),
                            );
                        }
                    }
                    // The durable mirror of a goal-state change (TS
                    // `_setGoalState` -> `_persistGoalState`: the
                    // `thread_goal_state` custom entry + flush, one store
                    // with the transcript). The announcement only fires on
                    // a real state change, so each row is the new state.
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
                // TS #2063: the active action's `committing`/`running`
                // transitions ride the events that mark the moments — the
                // turn's first row commits it (the prompt becomes visible
                // in the conversation exactly then, the boundary TS's
                // strip drops its "Starting" row at: the commit fence),
                // the first assistant frame runs it.
                let mut action_frame: Option<SessionActionSnapshot> = None;
                if !emitting_prefix_rows.get()
                    && !active_committed
                    && matches!(
                        event,
                        EngineEvent::UserMessage(_) | EngineEvent::CustomMessage(_)
                    )
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
                        // The turn boundary releases RLM child prompt tasks
                        // waiting on it (the parent's continuation request
                        // is in flight before any child's first turn).
                        engine.on_turn_done();
                        pa_core::session_engine::compaction_trace::trace(
                            "turn.done_emitted",
                            serde_json::json!({
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
                        // TS emits the accepted user message as a
                        // message_start + message_end pair (the row is
                        // complete the moment it is accepted).
                        vec![
                            json!({ "type": "message_start", "message": message }),
                            json!({ "type": "message_end", "message": message }),
                        ]
                    }
                    EngineEvent::AssistantUpdate {
                        message,
                        stream_event,
                    } => {
                        // A provider `start` begins a new assistant message;
                        // later stream events update it (TS message_start vs
                        // message_update).
                        let starts_message = stream_event
                            .as_ref()
                            .and_then(|event| event.get("type"))
                            .and_then(Value::as_str)
                            == Some("start");
                        let mut event = json!({
                            "type": if starts_message { "message_start" } else { "message_update" },
                            "message": message,
                        });
                        if let Some(stream_event) = stream_event {
                            event["assistantMessageEvent"] = stream_event;
                        }
                        vec![event]
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
                    // The loop's turn-boundary frames (TS `turn_start`/
                    // `turn_end`): the terminal assistant message and the
                    // turn's tool-result messages ride `turn_end`; the rows
                    // themselves already went out through their own events,
                    // so no persist here.
                    EngineEvent::TurnStart => vec![json!({ "type": "turn_start" })],
                    EngineEvent::TurnEnd {
                        message,
                        tool_results,
                    } => vec![json!({
                        "type": "turn_end",
                        "message": message,
                        "toolResults": tool_results,
                    })],
                    // The fallback terminal frame for runs that ended
                    // without the engine's own `turn_end` (session
                    // commands, pre-model failures): unchanged shape, and
                    // silent once the engine's frame covered the run.
                    EngineEvent::Done(Ok(())) if !engine_turn_ended => {
                        vec![json!({ "type": "turn_end" })]
                    }
                    EngineEvent::Done(Err(error)) if !engine_turn_ended => {
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
                        // The episode remembers its latest error so the
                        // outcome row can name it on success (the end event
                        // carries no error then).
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
                        // The episode's ONE durable outcome row (SANCTIONED
                        // DIVERGENCE, operator ruling 2026-09-23): the
                        // chat keeps a single resolved/terminal line for
                        // the whole episode — live, through the message
                        // pair below, and rebuilt, through the session
                        // transcript — instead of one error row per failed
                        // attempt. On success the row names the error the
                        // starts reported (the end event carries none).
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
                // The phase flip's queue-update frame rides the same batch
                // (after the row frames it follows, so a client sees the
                // prompt land and then the strip drop its "Starting" row):
                // an unchanged projection stays silent, like every queue
                // emit (TS `_emitQueueUpdate`).
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
                    let is_stream_update =
                        event_json.get("type").and_then(Value::as_str) == Some("message_update");
                    // A block-end stream event (`text_end` and friends)
                    // settles the parked delta run: it must supersede
                    // nothing, so it travels direct (flushing the parked
                    // update first, in order).
                    let stream_kind = event_json
                        .get("assistantMessageEvent")
                        .and_then(|event| event.get("type"))
                        .and_then(Value::as_str);
                    let flushes_pending = matches!(
                        stream_kind,
                        Some("text_end" | "thinking_end" | "toolcall_end")
                    );
                    if is_stream_update && !flushes_pending {
                        let sequence = core.last_event_sequence + 1;
                        core.last_event_sequence = sequence;
                        // Streaming updates park in the coalescer (the
                        // newest full-partial snapshot wins, the delta run
                        // merges); `park_update` only returns false after
                        // the turn joined, which cannot race this closure.
                        let delta = event_json
                            .get("assistantMessageEvent")
                            .and_then(|event| event.get("delta"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let parked = turn_coalescer.park_update(
                            event_json.get("message").cloned().unwrap_or(Value::Null),
                            stream_kind.unwrap_or_default(),
                            delta,
                            sequence,
                        );
                        if !parked {
                            return false;
                        }
                        continue;
                    }
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
                        rest: Default::default(),
                    };
                    let payload = serde_json::to_vec(&outbound).unwrap_or_default();
                    direct_payloads.push(payload);
                }
                drop(core);
                // A batch that carries direct frames goes out immediately
                // (flushing the parked update first, preserving
                // event-sequence order); a pure-update batch leaves its
                // frame parked for the flusher.
                if !direct_payloads.is_empty() {
                    turn_coalescer.send_direct(&direct_payloads, &events);
                }
                // Park the turn's settled outcome for the post-idle
                // resolution: the waiting response must observe the
                // frames' sequences (see `ConnectionSink`) and may not be
                // written while the session is still mid-unwind (the
                // runner resolves the waiter after the idle flip).
                if let Some(result) = done_result {
                    *turn_outcome_slot.lock().unwrap() = Some(result);
                }
                true
            };
            let aborted_probe = {
                let core = Arc::clone(&core);
                // `abort_retry` stops an in-flight retry without aborting
                // the turn itself (TS `abortRetry` only reaches the retry
                // controller).
                move || {
                    core.lock().unwrap().abort_requested
                        || core.lock().unwrap().retry_abort_requested
                }
            };
            // Restored next-turn rows ride this delivery (TS
            // `prefixMessages`): emitted before the accepted prompt, the
            // same durable-row path as in-turn custom rows. They are not
            // the delivery's rows-land moment, so the committing flip
            // waits for the accepted row behind them.
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
        // The turn's emit path is joined: nothing parks from here on, a
        // stale parked partial must not surface after the settle events,
        // and the flusher task stops on its next tick.
        coalescer.close();
        flusher.abort();

        {
            let mut core = self.core.lock().unwrap();
            core.busy = false;
            core.active_action = None;
        }
        self.push_roster_delta();
        // The fallback `agent_end` for runs that ended without a model
        // turn (session commands, pre-model failures): the engine's own
        // per-run frames (one per agent run, retried and continued runs
        // included — the TS `agent_end` `messages` payload) are the real
        // frames, and a run whose `agent_end` the abort gate swallowed
        // stays silent exactly like TS (the compact path's detached run).
        if !engine_agent_end.load(std::sync::atomic::Ordering::SeqCst) {
            self.emit_turn_event(json!({ "type": "agent_end" }));
        }
        let snapshot = {
            let core = self.core.lock().unwrap();
            self.snapshot_from(&core)
        };
        // The settle checkpoint (TS `turn_end`, busy computed): the
        // journal's latest record must track liveness, not the last
        // structural write. The idle flip above precedes it, so the
        // settle's in-flight term reads false here: a turn that settled
        // with empty lanes leaves the session idle, so an unclean kill
        // from here on must NOT read as interrupted work; undelivered
        // lanes stay busy (they are admitted work a revive must
        // redeliver). The busy verdict and the queue snapshot come from
        // one locked read, so a concurrent enqueue cannot be overwritten
        // by a stale idle verdict.
        checkpoint_queue_recovery(
            &self.recovery,
            &self.core,
            QueueCheckpoint::Settle {
                operation: "turn_end",
            },
        );
        let _ = self.emit_action_update(&snapshot);
        self.idle_notify.notify_waiters();
        // The settled prompts' admissions clear (TS `clearAdmission` in
        // the prompt arm's finally).
        for admission_id in settled_admissions {
            self.prompt_admissions.clear(&admission_id);
        }
        // The turn is fully unwound (idle flip, roster, boundary frames,
        // queue projection, admission bookkeeping): the waiting prompt now
        // resolves — TS `promptAndWait`'s response lands at the same
        // fully-settled point, so a client's next request always observes
        // the idle session.
        let settled_outcome = turn_outcome.lock().unwrap().take();
        if let Some(result) = settled_outcome {
            for done in items_done {
                let _ = done.send(result.clone());
            }
        }
        // The compact-trigger review a compaction armed this run services
        // off the settle (TS `_scheduleAutoRefineAfterCompaction` ->
        // `setTimeout(0)` background `_maybeAutoRefine("compact")`): the
        // turn settled and the waiting prompts resolved, so the review's
        // model call runs as a background round and the queued next
        // prompt's admission never waits on it. The round's own gates
        // (the armed trigger, queued work) keep the trigger armed for the
        // next settle when work is queued mid-review.
        {
            let engine = review_engine;
            let core = Arc::clone(&self.core);
            let events = self.events.clone();
            let review_session_id = review_session_id.clone();
            tokio::spawn(async move {
                // The pending pre-check and the round both take the
                // engine's session mutex (`blocking_lock`): they run on
                // the blocking pool, never on this async task — a
                // `blocking_lock` from the runtime thread deadlocks the
                // settle when the mutex is contended.
                let refined = tokio::task::spawn_blocking(move || {
                    pa_core::session_engine::compaction_trace::trace(
                        "autorefine.review_started",
                        serde_json::Value::Null,
                    );
                    let outcome = engine.consume_compact_auto_refine();
                    pa_core::session_engine::compaction_trace::trace(
                        "autorefine.review_done",
                        serde_json::json!({ "ran": outcome.is_ok() }),
                    );
                    outcome
                })
                .await
                .unwrap_or_else(|error| {
                    Err(anyhow::anyhow!("auto-refinement task failed: {error}"))
                });
                match refined {
                    Ok(Some(result)) => {
                        // TS `refine()` appends the TUI outcome row and
                        // the model-facing notice (when edits applied) as
                        // durable rows: persist both to the session file
                        // and broadcast their message pairs like the
                        // `/refine` command — each row fenced on the
                        // session identity the review serviced (a branch
                        // move or replacement swaps the store mid-review;
                        // the row never lands on the moved-to session).
                        let outcome_row =
                            pa_core::session_engine::refine::create_refinement_outcome_message(
                                &result,
                            );
                        if let Ok(value) = serde_json::to_value(
                            pa_types::session::AgentMessage::Custom(outcome_row),
                        ) {
                            emit_refinement_row(&core, &events, &review_session_id, value);
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
                                emit_refinement_row(&core, &events, &review_session_id, value);
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!("pa-daemon: auto-refinement after compaction failed: {error:#}");
                    }
                }
            });
        }
    }

    /// The post-turn queue projection (TS `_emitQueueUpdate`): an unchanged
    /// snapshot stays silent.
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
            rest: Default::default(),
        };
        let payload = serde_json::to_vec(&outbound)?;
        drop(core);
        self.events.send(OutboundFrame::session_event(payload));
        Ok(())
    }

    fn snapshot_from(&self, core: &SessionCore) -> SessionActionSnapshot {
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
            rest: Default::default(),
        };
        let payload = serde_json::to_vec(&outbound).unwrap_or_default();
        drop(core);
        self.events.send(OutboundFrame::session_event(payload));
    }
}

/// The compaction cut budget the engine ran with
/// (`compaction.keepRecentTokens` from settings, TS default 20k): the
/// durable boundary re-cut in the turn callback must walk with the same
/// budget to pin the same cut.
fn keep_recent_tokens(cwd: &str, agent_dir: &std::path::Path) -> u64 {
    pa_core::settings::SettingsManager::create(cwd, agent_dir)
        .settings()
        .compaction
        .clone()
        .unwrap_or_default()
        .keep_recent_tokens
        .unwrap_or(pa_core::session_engine::compaction::DEFAULT_KEEP_RECENT_TOKENS)
}
