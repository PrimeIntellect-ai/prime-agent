//! The print run's goal continuation loop — the #252 residue: the print
//! driver runs the same in-run continuation the TS session hosts inside one
//! `promptAndWait`.
//!
//! TS ruling (probed against the installed binary, `prime-agent --mode json
//! --goal <objective> [--goal-token-budget <n>] -p <prompt>` over the shared
//! faux-provider harness): the seeded goal's context row rides the first
//! turn; every settled turn's usage publishes a `goal_update`; the agent
//! loop's continuation hook (`getContinuationMessages`) mints one
//! goal-context turn per natural turn end INSIDE the same agent run, so the
//! continuation turns surface as `turn_end -> goal_update -> turn_start`
//! segments with no `agent_start`/`agent_end` between them; the turn that
//! crosses the token budget queues a `[goal: budget-limit]` wrap-up steer as
//! session input (`goal_update` with `budget_limited`, then a
//! `session_action_update` with the queued steering preview), the loop ends,
//! and the queue drains the steer as its own run (preparing/committing/
//! running phase frames); a failed terminal assistant message fails the
//! goal after the run's compaction arms (`goal_update` with `error`).
//!
//! The Rust mapping: the pa-core engine owns the goal arms
//! ([`SessionEngine`]'s boundary methods); this surface owns the print
//! stream — the usage-accounting subscription (message-end recording plus
//! the `goal_update` frames), the in-loop continuation hook installed on the
//! agent (the natural mint, with the threshold/requested-compaction stops
//! deferring to the turn boundary like TS `_shouldStopForThresholdCompaction`),
//! and the driver's queue arms (the budget steer and the threshold-held
//! continuation run as the print invocation's follow-up turns with the
//! TS action-phase frames). Text mode runs the same loop silently.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use pa_agent::agent::Agent;
use pa_agent::types::{AgentEvent, AgentMessage, Message};
use pa_core::session_engine::engine::SessionEngine;
use pa_core::session_engine::goal_boundary::custom_message_to_loop_row;
use pa_core::session_engine::goal_driver::UsageOutcome;
use pa_core::session_engine::provider_adapter::json_round_trip;
use pa_types::session::CustomMessage;
use serde_json::{json, Value};
use tokio::sync::Mutex;

/// Where the boundary's json events go: stdout in the product, a captured
/// buffer in tests (the same sink contract `print_boundary` uses).
pub(crate) type EventSink = std::sync::Arc<dyn Fn(&Value) + Send + Sync>;

/// TS `compactRlmText(text, 160)`: collapse whitespace, cap at 160 chars
/// with a trailing `...` (the session-action label form).
fn compact_rlm_text(text: &str, max_length: usize) -> String {
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.len() <= max_length {
        return compact;
    }
    let keep = max_length.saturating_sub(3).min(compact.len());
    let mut head = compact[..keep].to_string();
    while head.ends_with(char::is_whitespace) {
        head.pop();
    }
    format!("{head}...")
}

/// The queue lane a minted goal turn was queued through (the TS session
/// action's schedule): the preview array it rides in the queue snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueueLane {
    /// The budget-limit wrap-up steer (`_queuePreparedPrompt("steer", ...)`).
    Steering,
    /// The threshold-compaction continuation (`_createPreparedTurnAction(
    /// "followUp", ...)`, TS `_queueGoalContinuationForThresholdCompaction`).
    FollowUp,
}

/// The goal arm's consult outcome for the composed natural-turn-end hook.
pub(crate) enum NaturalContinuation {
    /// Queued session input owns the boundary (the armed budget steer): no
    /// turn mints, the run ends so the queue drains.
    QueuedInput,
    /// A pending requested compaction consumes the stop: no mint, the
    /// boundary consumes the request.
    RequestedCompaction,
    /// A threshold compaction is due: the loop stops (any owed mint is held
    /// for the post-compaction admission), the boundary compacts.
    ThresholdDue,
    /// The goal minted its next continuation row (the hook runs it inside
    /// the same agent run).
    GoalRow(Box<pa_agent::types::AgentMessage>),
    /// No goal work owns the boundary: the autonomous arm may consult.
    FallThrough,
}

/// One queued goal turn's stream bookkeeping.
struct QueuedGoalTurn {
    message: CustomMessage,
    lane: QueueLane,
}

impl QueuedGoalTurn {
    /// The full message text (the queued preview: TS `queuedAgentMessagePreview`
    /// returns the whole normalized text for a custom goal row).
    fn preview_text(&self) -> String {
        custom_message_text(&self.message)
    }
}

/// The text of one custom row's content (the TS `normalizeMessageContent`
/// text form: the plain text, or the text blocks joined).
fn custom_message_text(message: &CustomMessage) -> String {
    match &message.content {
        pa_types::ai::UserContent::Text(text) => text.clone(),
        pa_types::ai::UserContent::Blocks(blocks) => blocks
            .iter()
            .map(|block| match block {
                pa_types::ai::UserContentBlock::Text(text) => text.text.clone(),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// The print run's goal surface: the usage-accounting publication, the
/// armed budget steer, the threshold-held continuation, and the queue-phase
/// frames the drained turns stream.
pub(crate) struct PrintGoalSurface {
    json_mode: bool,
    sink: EventSink,
    /// Whether the latest settled turn's usage crossed the goal budget (the
    /// wrap-up steer's arming; the driver consumes it).
    budget_crossed: AtomicBool,
    /// The armed budget steer (queued at the crossing turn's message end,
    /// TS `_shouldStopAfterTurn`'s budget arm).
    queued: Mutex<Option<QueuedGoalTurn>>,
    /// The label of the action the driver is admitting (the `running` frame
    /// the agent's `agent_start` completes; `None` when nothing is active).
    active_label: Mutex<Option<String>>,
    /// The next queued-turn drain completes its `running` frame at the
    /// loop's `turn_start` instead of `agent_start` (the TS order the
    /// session-command continuation drain shows, probed against the TS
    /// binary; the steer drain keeps the `agent_start` position).
    running_frame_at_turn_start: AtomicBool,
    /// The last `session_action_update` snapshot emitted (TS `_emitQueueUpdate`
    /// stays silent on an unchanged projection).
    last_action_snapshot: Mutex<Value>,
    /// The last goal state published as a `goal_update` (the publish dedupe).
    last_published_goal: Mutex<pa_types::goal::GoalState>,
}

impl PrintGoalSurface {
    pub(crate) fn new(json_mode: bool) -> Self {
        Self {
            json_mode,
            sink: Arc::new(|event| println!("{event}")),
            budget_crossed: AtomicBool::new(false),
            queued: Mutex::new(None),
            active_label: Mutex::new(None),
            running_frame_at_turn_start: AtomicBool::new(false),
            last_action_snapshot: Mutex::new(Value::Null),
            last_published_goal: Mutex::new(pa_types::goal::empty_goal_state()),
        }
    }

    /// A surface with an explicit event sink (json-mode verifiers; the
    /// product path always uses [`PrintGoalSurface::new`]).
    #[cfg(test)]
    pub(crate) fn with_sink(json_mode: bool, sink: EventSink) -> Self {
        Self {
            json_mode,
            sink,
            budget_crossed: AtomicBool::new(false),
            queued: Mutex::new(None),
            active_label: Mutex::new(None),
            running_frame_at_turn_start: AtomicBool::new(false),
            last_action_snapshot: Mutex::new(Value::Null),
            last_published_goal: Mutex::new(pa_types::goal::empty_goal_state()),
        }
    }

    fn emit(&self, event: Value) {
        if self.json_mode {
            (self.sink)(&event);
        }
    }

    /// Seed the publish dedupe's baseline from the current state: the state
    /// that exists when the stream attaches (the seeded `--goal`, or a
    /// resumed session's persisted goal) never announces itself — TS's
    /// construction-time mutations land before the print client subscribes,
    /// so the first `goal_update` on the stream is the first change the
    /// run observes.
    pub(crate) async fn seed_publish_baseline(&self, engine: &SessionEngine) {
        *self.last_published_goal.lock().await = engine.goal_state().await;
    }

    /// Publish the current goal state as a `goal_update` when it changed
    /// (TS `_setGoalState` -> `_emitGoalUpdate` at every mutation site).
    pub(crate) async fn publish_goal_update(&self, engine: &SessionEngine) {
        let goal = engine.goal_state().await;
        let changed = {
            let mut last = self.last_published_goal.lock().await;
            if *last == goal {
                false
            } else {
                *last = goal.clone();
                true
            }
        };
        if changed {
            self.emit(json!({
                "type": "goal_update",
                "goal": serde_json::to_value(&goal).unwrap_or(Value::Null),
            }));
        }
    }

    /// The queue snapshot frame (TS `getSessionActionSnapshot` ->
    /// `_emitQueueUpdate`): an unchanged projection stays silent.
    async fn emit_action_snapshot(&self, snapshot: Value) {
        let mut last = self.last_action_snapshot.lock().await;
        if *last == snapshot {
            return;
        }
        *last = snapshot.clone();
        drop(last);
        self.emit(json!({ "type": "session_action_update", "actions": snapshot }));
    }

    /// The snapshot of a queue holding one minted goal turn (the queued
    /// preview is the full row text, TS `queuedAgentMessagePreview`).
    async fn queued_snapshot(&self, turn: &QueuedGoalTurn) -> Value {
        let preview = turn.preview_text();
        match turn.lane {
            QueueLane::Steering => json!({
                "queuedCount": 1,
                "steering": [preview],
                "followUps": [],
            }),
            QueueLane::FollowUp => json!({
                "queuedCount": 1,
                "steering": [],
                "followUps": [preview],
            }),
        }
    }

    /// Queue one minted goal turn (TS `_queuePreparedPrompt` at the mint
    /// site): the queue snapshot publishes at the moment of the mint.
    async fn queue_turn(&self, turn: QueuedGoalTurn) {
        let snapshot = self.queued_snapshot(&turn).await;
        *self.queued.lock().await = Some(turn);
        self.emit_action_snapshot(snapshot).await;
    }

    /// Arm the budget-limit wrap-up steer: the crossing turn's message end
    /// queues it (the `budget_crossed` flag the driver's settle consult
    /// reads, TS `_steeringStopPending` owning the boundary).
    async fn arm_budget_steer(&self, message: CustomMessage) {
        self.budget_crossed.store(true, Ordering::SeqCst);
        self.queue_turn(QueuedGoalTurn {
            message,
            lane: QueueLane::Steering,
        })
        .await;
    }

    /// Hold the threshold-compaction continuation (TS
    /// `_queueGoalContinuationForThresholdCompaction`: the mint precedes the
    /// compaction; the held turn runs as the post-compaction turn).
    async fn hold_threshold_continuation(&self, message: CustomMessage) {
        self.queue_turn(QueuedGoalTurn {
            message,
            lane: QueueLane::FollowUp,
        })
        .await;
    }

    /// The settle consult's budget-steer read: the crossing's queued turn,
    /// consumed once. The armed crossing is the steer's own flag, so a
    /// different lane's hold can never be mistaken for it.
    pub(crate) async fn take_budget_steer(&self) -> Option<CustomMessage> {
        if !self.budget_crossed.swap(false, Ordering::SeqCst) {
            return None;
        }
        let mut queued = self.queued.lock().await;
        match queued.as_ref().map(|turn| turn.lane) {
            Some(QueueLane::Steering) => queued.take().map(|turn| turn.message),
            _ => None,
        }
    }

    /// The driver's threshold-hold read: the continuation the in-loop hook
    /// minted ahead of the boundary's compaction, consumed once.
    pub(crate) async fn take_threshold_continuation(&self) -> Option<CustomMessage> {
        let mut queued = self.queued.lock().await;
        match queued.as_ref().map(|turn| turn.lane) {
            Some(QueueLane::FollowUp) => queued.take().map(|turn| turn.message),
            _ => None,
        }
    }

    /// The `preparing` phase frame (TS action lifecycle: `selected` projects
    /// as `preparing`).
    async fn emit_action_preparing(&self, label: &str) {
        self.emit_action_phase("preparing", label).await;
    }

    /// The `committing` phase frame.
    async fn emit_action_committing(&self, label: &str) {
        self.emit_action_phase("committing", label).await;
    }

    async fn emit_action_phase(&self, phase: &str, label: &str) {
        *self.active_label.lock().await = Some(label.to_string());
        self.emit_action_snapshot(json!({
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
            "active": { "kind": "turn", "phase": phase, "label": label },
        }))
        .await;
    }

    /// The `running` phase frame: the agent's `agent_start` of the turn the
    /// driver admitted (the subscription completes the phase transition
    /// after the loop's own `agent_start` line, the TS order).
    async fn emit_action_running_if_armed(&self) {
        let mut active = self.active_label.lock().await;
        let Some(label) = active.take() else {
            return;
        };
        self.emit_action_snapshot(json!({
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
            "active": { "kind": "turn", "phase": "running", "label": label },
        }))
        .await;
    }

    /// The `session_command` action's phase frame (TS
    /// `_executeSelectedSessionCommand`'s `preparing`/`running`
    /// transitions: the snapshot's `active` entry, kind `session_command`).
    pub(crate) async fn emit_command_phase(&self, phase: &str, label: &str) {
        self.emit_action_snapshot(json!({
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
            "active": { "kind": "session_command", "phase": phase, "label": label },
        }))
        .await;
    }

    /// The queue frame of a session command that scheduled a goal
    /// continuation: the queued preview rides while the command action is
    /// still the active one (TS `_runOrQueueGoalContext` ->
    /// `_emitQueueUpdate`).
    pub(crate) async fn emit_command_queue_hold(
        &self,
        command_label: &str,
        continuation: &CustomMessage,
    ) {
        let preview = custom_message_text(continuation);
        self.emit_action_snapshot(json!({
            "queuedCount": 1,
            "steering": [],
            "followUps": [preview],
            "active": {
                "kind": "session_command",
                "phase": "running",
                "label": command_label,
            },
        }))
        .await;
    }

    /// The settled command's queue frame: the action completed, the queued
    /// continuation stays (TS `_emitQueueUpdate` after the command action
    /// settles, ahead of the queued turn's admission).
    pub(crate) async fn emit_command_queue_drain(&self, continuation: &CustomMessage) {
        let preview = custom_message_text(continuation);
        self.emit_action_snapshot(json!({
            "queuedCount": 1,
            "steering": [],
            "followUps": [preview],
        }))
        .await;
    }

    /// The empty-projection idle frame (a settled command that scheduled
    /// nothing; TS `_emitQueueUpdate` with the empty queue).
    pub(crate) async fn emit_queue_idle(&self) {
        self.emit_action_snapshot(json!({
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
        }))
        .await;
    }

    /// One durable row's `message_start`/`message_end` pair on the stream
    /// (rows appended outside the agent loop — the session-command echo,
    /// result, and status rows).
    pub(crate) fn emit_row_pair(&self, row: &CustomMessage) {
        let value = crate::headless_autonomous::custom_row_wire_value(row);
        for event_type in ["message_start", "message_end"] {
            self.emit(json!({ "type": event_type, "message": value }));
        }
    }

    /// One raw stream event (the session-command events:
    /// `compaction_start`, `compaction_end`, `refine_complete`,
    /// `refine_failed`).
    pub(crate) fn emit_stream_event(&self, event: Value) {
        self.emit(event);
    }

    /// The unconditional goal-state publish (TS `_emitGoalUpdate` in the
    /// goal command arms): the dedupe baseline follows the published state
    /// so later settled-turn publishes stay quiet until it changes again.
    pub(crate) async fn publish_goal_update_forced(&self, engine: &SessionEngine) {
        let goal = engine.goal_state().await;
        *self.last_published_goal.lock().await = goal.clone();
        self.emit(json!({
            "type": "goal_update",
            "goal": serde_json::to_value(&goal).unwrap_or(Value::Null),
        }));
    }

    /// Arm the `running`-frame-at-`turn_start` position for the next
    /// queued-turn drain (the session-command continuation's TS order).
    pub(crate) fn arm_running_frame_at_turn_start(&self) {
        self.running_frame_at_turn_start
            .store(true, Ordering::SeqCst);
    }

    /// The drained-queue frame (the admitted action completed; TS
    /// `_emitQueueUpdate` with the empty projection).
    async fn emit_action_drained(&self) {
        *self.active_label.lock().await = None;
        self.emit_action_snapshot(json!({
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
        }))
        .await;
    }

    /// Wire the goal usage accounting (and the phase/`goal_update`
    /// publications) onto the engine's event feed: settled non-error,
    /// non-aborted assistant turns spend the goal budget; the crossing arms
    /// the wrap-up steer; every state change (usage, budget, or a kernel-side
    /// complete) publishes `goal_update`; an armed action's `agent_start`
    /// completes its phase frame.
    pub(crate) async fn wire_accounting(
        self: &Arc<Self>,
        engine: &Arc<SessionEngine>,
        agent: &Arc<Agent>,
    ) -> pa_agent::agent::Subscription {
        let engine = Arc::clone(engine);
        let surface = Arc::clone(self);
        agent
            .subscribe(move |event, _signal| {
                let engine = Arc::clone(&engine);
                let surface = Arc::clone(&surface);
                Box::pin(async move {
                    if let AgentEvent::MessageEnd {
                        message: AgentMessage::Standard(Message::Assistant(assistant)),
                    } = &event
                    {
                        if let Some(wire) =
                            json_round_trip::<_, pa_types::ai::AssistantMessage>(assistant)
                        {
                            // TS `_accountGoalUsageForAssistantMessage`: only
                            // turns that were neither errors nor aborted spend
                            // the budget, and only while the goal is active;
                            // the crossing flips the goal to `budget_limited`
                            // (the state change publishes before the steer
                            // queues) and arms the wrap-up steer.
                            if !matches!(
                                wire.stop_reason,
                                pa_types::ai::StopReason::Error | pa_types::ai::StopReason::Aborted
                            ) {
                                // The message identity for the double-counting
                                // guard: the loop does not assign message ids
                                // in-process.
                                let message_id = format!("a-{}", wire.timestamp);
                                // TS `_shouldStopAfterTurn`'s catch: goal
                                // accounting must not interrupt the loop;
                                // a failed persist only warns.
                                let outcome =
                                    engine.record_goal_usage(&message_id, &wire.usage).await;
                                surface.publish_goal_update(&engine).await;
                                match outcome {
                                    Ok(UsageOutcome::BudgetReached) => {
                                        if let Some(steer) = engine.goal_budget_limit_steer().await
                                        {
                                            surface.arm_budget_steer(steer).await;
                                        }
                                    }
                                    Ok(_) => {}
                                    Err(error) => {
                                        eprintln!(
                                            "pa-cli: goal usage accounting persist failed: {error:#}"
                                        );
                                    }
                                }
                            }
                        }
                    }
                    if matches!(event, AgentEvent::AgentStart)
                        && !surface.running_frame_at_turn_start.load(Ordering::SeqCst)
                    {
                        surface.emit_action_running_if_armed().await;
                    }
                    if matches!(event, AgentEvent::TurnStart)
                        && surface
                            .running_frame_at_turn_start
                            .swap(false, Ordering::SeqCst)
                    {
                        surface.emit_action_running_if_armed().await;
                    }
                    // A goal state change from any other source (a kernel-side
                    // `goal.complete`/`goal.create` mid-turn) publishes at the
                    // moment it happened; the dedupe keeps settled turns from
                    // re-announcing.
                    surface.publish_goal_update(&engine).await;
                    Ok(())
                })
            })
            .await
    }

    /// The goal arm of the natural-turn-end consult (TS
    /// `_getContinuationMessages`'s goal arm plus its boundary gates): at
    /// each natural turn end, queued input (the armed steer) and a
    /// compaction due (requested or threshold, TS
    /// `_shouldStopForThresholdCompaction` stopping the loop) gate the mint
    /// — the threshold arm mints the goal's continuation ahead of the
    /// compaction and holds it for the driver (TS
    /// `_queueGoalContinuationForThresholdCompaction`) — and an active goal
    /// mints its next continuation turn, which the composed hook runs
    /// inside the same agent run. [`NaturalContinuation::FallThrough`]
    /// hands the boundary to the autonomous arm.
    pub(crate) async fn natural_continuation(
        &self,
        engine: &Arc<SessionEngine>,
        model: &pa_types::ai::Model,
    ) -> NaturalContinuation {
        // TS `_getContinuationMessages`: queued session input owns
        // the boundary before any goal work — the armed budget steer
        // ends the run so the queue drains it.
        if self.queued.lock().await.is_some() {
            return NaturalContinuation::QueuedInput;
        }
        // A pending requested compaction consumes the stop (TS
        // `_shouldStopForThresholdCompaction`'s first arm): no mint,
        // the boundary consumes the request.
        if engine.turn_boundary.compaction_scheduled().await {
            return NaturalContinuation::RequestedCompaction;
        }
        // The threshold arm: the crossing turn mints BEFORE the loop
        // stops (the mint's `goal_update` and queue frame land between
        // `turn_end` and `agent_end`, the TS event order); the boundary
        // compacts, and the driver runs the held turn as the
        // post-compaction turn.
        if engine.session.auto_compaction_due(model).await {
            if let Some(message) = engine.mint_goal_continuation().await {
                self.publish_goal_update(engine).await;
                self.hold_threshold_continuation(message).await;
            }
            return NaturalContinuation::ThresholdDue;
        }
        // The natural continuation mint: the goal's context turn runs
        // as the next turn of the same run (TS pendingMessages).
        match engine.mint_goal_continuation().await {
            Some(message) => {
                self.publish_goal_update(engine).await;
                match custom_message_to_loop_row(&message) {
                    Some(row) => NaturalContinuation::GoalRow(Box::new(row)),
                    None => NaturalContinuation::FallThrough,
                }
            }
            None => NaturalContinuation::FallThrough,
        }
    }

    /// The settled boundary's goal drain (the print driver's queue loop):
    /// the threshold-held continuation and the armed budget steer run as
    /// this invocation's follow-up turns, each crossing the same boundary
    /// pair; a turn that still ends in a terminal error fails an active
    /// goal once the arms could not save it (TS
    /// `_finishGoalForTerminalAssistantMessage` at `agent_end`, after
    /// `_checkCompaction`). Returns whether an active goal still owns the
    /// boundary (TS `_getContinuationMessages`: the goal arm takes
    /// exclusive priority — the autonomous arm is never consulted while a
    /// goal is active).
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn drive_boundary(
        &self,
        engine: &SessionEngine,
        boundary: &mut crate::print_boundary::TurnBoundary,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
    ) -> Result<bool, String> {
        loop {
            if let Some(message) = self.take_threshold_continuation().await {
                // A goal that went inactive mid-turn (a kernel-side
                // complete) drops its queued continuation (TS
                // `_clearQueuedGoalContexts`).
                if engine.goal_state().await.status == pa_types::goal::GoalStatus::Active {
                    self.run_queued_turn(
                        engine,
                        boundary,
                        model,
                        api_key.clone(),
                        global_harness_dir.clone(),
                        &message,
                    )
                    .await?;
                    continue;
                }
            }
            if let Some(steer) = self.take_budget_steer().await {
                self.run_queued_turn(
                    engine,
                    boundary,
                    model,
                    api_key.clone(),
                    global_harness_dir.clone(),
                    &steer,
                )
                .await?;
                continue;
            }
            if let Some(message) = crate::headless_autonomous::latest_assistant_error(engine).await
            {
                engine
                    .fail_goal_for_terminal_error(message.as_deref())
                    .await
                    .map_err(|error| format!("{error:#}"))?;
                self.publish_goal_update(engine).await;
            }
            return Ok(engine.goal_state().await.status == pa_types::goal::GoalStatus::Active);
        }
    }

    /// Admit a session command's scheduled continuation (a `/goal` start or
    /// resume) as the print invocation's next run — the TS
    /// `promptAndWait` drain, with the command surface's frame order: the
    /// action's `preparing`/`committing` frames ahead of the turn, the
    /// `running` frame at the turn's `turn_start` (the probed TS order for
    /// the command-continuation admission), the settled boundary's arms
    /// (`_checkCompaction` at `agent_end`), then the terminal-error goal
    /// fail's `goal_update`, then the drained-queue frame (the pump
    /// completing the action after the run settled).
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn run_session_command_continuation(
        &self,
        engine: &SessionEngine,
        boundary: &mut crate::print_boundary::TurnBoundary,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
        message: &CustomMessage,
    ) -> Result<(), String> {
        let label = compact_rlm_text(&custom_message_text(message), 160);
        self.arm_running_frame_at_turn_start();
        self.emit_action_preparing(&label).await;
        self.emit_action_committing(&label).await;
        boundary
            .run_pre_turn(engine, model, api_key.clone())
            .await?;
        engine
            .session
            .prompt_injected_message(message)
            .await
            .map_err(|error| format!("{error:#}"))?;
        engine.session.agent().wait_for_idle().await;
        boundary
            .run_at_settled_turn(engine, model, api_key.clone(), global_harness_dir)
            .await?;
        if let Some(error_message) =
            crate::headless_autonomous::latest_assistant_error(engine).await
        {
            engine
                .fail_goal_for_terminal_error(error_message.as_deref())
                .await
                .map_err(|error| format!("{error:#}"))?;
            self.publish_goal_update(engine).await;
        }
        self.emit_action_drained().await;
        Ok(())
    }

    /// Admit one queued goal turn as the print invocation's next run (the
    /// queue drain: TS `resumeQueuedWork` -> `_createPreparedTurnAction`
    /// admission). The action's phase frames bookend the turn — `preparing`
    /// and `committing` ahead of it, the `running` frame on the loop's
    /// `agent_start`, the drained-queue frame right after the run settles —
    /// and the turn crosses the same boundary pair every print turn crosses
    /// (TS `_prepareForCommit` -> `_runPreTurnCompaction` before, the
    /// `agent_end` checks after).
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn run_queued_turn(
        &self,
        engine: &SessionEngine,
        boundary: &mut crate::print_boundary::TurnBoundary,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
        message: &CustomMessage,
    ) -> Result<(), String> {
        let label = compact_rlm_text(&custom_message_text(message), 160);
        self.emit_action_preparing(&label).await;
        self.emit_action_committing(&label).await;
        boundary
            .run_pre_turn(engine, model, api_key.clone())
            .await?;
        engine
            .session
            .prompt_injected_message(message)
            .await
            .map_err(|error| format!("{error:#}"))?;
        engine.session.agent().wait_for_idle().await;
        self.emit_action_drained().await;
        boundary
            .run_at_settled_turn(engine, model, api_key, global_harness_dir)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
// The faux provider registry is process-global and shared across the
// print-runtime tests: one std lock serializes every test that drives it
// (the same contract print_boundary's tests hold).
mod tests {
    use super::*;
    use pa_core::session_engine::provider_adapter::json_round_trip;
    use serde_json::json;

    /// One test at a time over the global faux registry.
    static FAUX_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// One captured event line (the sink's frames, in order).
    type Frames = std::sync::Arc<std::sync::Mutex<Vec<Value>>>;

    fn capture_sink() -> (Frames, EventSink) {
        let frames: Frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: EventSink = {
            let frames = Arc::clone(&frames);
            Arc::new(move |event: &Value| {
                frames.lock().unwrap().push(event.clone());
            })
        };
        (frames, sink)
    }

    /// The goal frame kinds, in order (`goal_update` statuses and the
    /// session-action phases).
    fn frame_kinds(frames: &Frames) -> Vec<String> {
        frames
            .lock()
            .unwrap()
            .iter()
            .map(|event| {
                let kind = event["type"].as_str().unwrap_or_default().to_string();
                if kind == "goal_update" {
                    format!(
                        "goal_update:{}",
                        event["goal"]["status"].as_str().unwrap_or_default()
                    )
                } else if kind == "session_action_update" {
                    let actions = &event["actions"];
                    let queued = actions["queuedCount"].as_u64().unwrap_or_default();
                    let active = actions["active"]["phase"].as_str().unwrap_or_default();
                    format!("action:{queued}:{active}")
                } else {
                    kind
                }
            })
            .collect()
    }

    /// The transcript's custom rows in order: (customType, content head).
    async fn custom_rows(engine: &SessionEngine) -> Vec<(String, String)> {
        engine
            .session
            .entries()
            .await
            .into_iter()
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::CustomMessage { payload, .. } => Some((
                    payload.custom_type.clone(),
                    match &payload.content {
                        pa_types::ai::UserContent::Text(text) => text.clone(),
                        pa_types::ai::UserContent::Blocks(_) => String::new(),
                    },
                )),
                _ => None,
            })
            .collect()
    }

    /// The transcript's assistant turn texts in order.
    async fn assistant_texts(engine: &SessionEngine) -> Vec<String> {
        engine
            .session
            .entries()
            .await
            .into_iter()
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::Message {
                    message: pa_types::session::AgentMessage::Assistant(assistant),
                    ..
                } => match assistant.content.first() {
                    Some(pa_types::ai::AssistantContentBlock::Text(text)) => {
                        Some(text.text.clone())
                    }
                    _ => None,
                },
                _ => None,
            })
            .collect()
    }

    /// Count the agent runs (`agent_end` events) a live subscription
    /// observes: the counter handle reads after the driver settles.
    async fn agent_run_counter(
        engine: &Arc<SessionEngine>,
    ) -> (
        Arc<std::sync::atomic::AtomicU64>,
        pa_agent::agent::Subscription,
    ) {
        let counter = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counter_clone = Arc::clone(&counter);
        let agent = engine.session.agent().clone();
        let subscription = agent
            .subscribe(move |event, _signal| {
                let counter = Arc::clone(&counter_clone);
                Box::pin(async move {
                    if matches!(event, AgentEvent::AgentEnd { .. }) {
                        counter.fetch_add(1, Ordering::SeqCst);
                    }
                    Ok(())
                })
            })
            .await;
        (counter, subscription)
    }

    /// The faux engine bed: the engine, its tempdir (kept alive), the
    /// model, the wired surface (accounting + hook), and the captured
    /// frames. Compaction settings come from the caller's settings value.
    /// The optional `--goal` seed runs BEFORE the surface wires, exactly
    /// like the print runtime (the construction-time state is the publish
    /// baseline and never announces itself).
    async fn goal_bed(
        script: Value,
        settings: Value,
        seed: Option<(&str, Option<u64>)>,
    ) -> GoalBed {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(agent_dir.join("settings.json"), settings.to_string()).unwrap();
        let parsed = pa_ai::faux::script::parse_faux_script(&script).unwrap();
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                models: Some(vec![parsed.model]),
                ..Default::default()
            });
        registration.set_responses(parsed.responses);
        let model = registration.get_model();
        let stream_fn =
            pa_core::session_engine::provider_adapter::real_stream_fn(None, model.clone());
        let agent_model: pa_agent::types::Model =
            json_round_trip(&model).expect("the faux model crosses the loop boundary");
        let session_manager = pa_core::session::manager::SessionManager::persisted(
            dir.path(),
            &dir.path().join("sessions"),
        );
        let engine = Arc::new(
            pa_core::session_engine::engine::create_session(
                pa_core::session_engine::engine::SessionEngineConfig {
                    cron_store: None,
                    telemetry: None,
                    cwd: dir.path().to_path_buf(),
                    agent_dir,
                    mcp_manager: None,
                    model: Some(agent_model),
                    thinking_level: None,
                    stream_fn: Some(stream_fn),
                    tools: Vec::new(),
                    custom_system_prompt: None,
                    prompt_guidelines: Vec::new(),
                    generic_mcp_servers: Vec::new(),
                    allow_recursion: None,
                    session_manager: Some(session_manager),
                    extra_host_handlers: None,
                    conversation_log_path: None,
                    additional_skill_paths: Vec::new(),
                    additional_prompt_paths: Vec::new(),
                    extra_builtin_skill_overrides: Vec::new(),
                    rlm_subagent_host: None,
                    rlm_depth: None,
                    model_info: Some(model.clone()),
                    cli_extension_sources: Vec::new(),
                    extension_tool_allow_list: None,
                    prewarm_ipython_kernel: None,
                    queued_goal_context_purge: None,
                    queued_steering_probe: None,
                    steering_mode: None,
                    follow_up_mode: None,
                },
            )
            .await
            .unwrap(),
        );
        if let Some((objective, budget)) = seed {
            engine
                .seed_initial_goal(objective, budget)
                .await
                .expect("the seed validates");
        }
        let (frames, sink) = capture_sink();
        let surface = Arc::new(PrintGoalSurface::with_sink(true, sink));
        surface.seed_publish_baseline(&engine).await;
        let accounting = surface
            .wire_accounting(&engine, engine.session.agent())
            .await;
        let autonomous_run = std::sync::Arc::new(
            crate::headless_autonomous::HeadlessAutonomous::disabled(dir.path()),
        );
        crate::print_autonomous::wire_continuation_hook(
            &engine,
            engine.session.agent(),
            &model,
            &surface,
            &autonomous_run,
        );
        let harness_dir = dir.path().join("harness");
        GoalBed {
            engine,
            model,
            surface,
            frames,
            harness_dir,
            _accounting: accounting,
            _autonomous_run: autonomous_run,
            _dir: dir,
        }
    }

    struct GoalBed {
        engine: Arc<SessionEngine>,
        model: pa_types::ai::Model,
        surface: Arc<PrintGoalSurface>,
        frames: Frames,
        harness_dir: std::path::PathBuf,
        _accounting: pa_agent::agent::Subscription,
        /// Keeps the composed hook's autonomous arm alive for the bed's
        /// lifetime (the hook holds it weakly).
        _autonomous_run: Arc<crate::headless_autonomous::HeadlessAutonomous>,
        _dir: tempfile::TempDir,
    }

    impl GoalBed {
        /// Admit one prompt through the same driver path the print runtime
        /// uses: the pre-turn arms, the prompt (the in-loop hook runs the
        /// natural continuations inside the one run), the settled arms,
        /// and the goal boundary drain.
        async fn prompt(&self, text: &str) -> bool {
            let mut boundary = crate::print_boundary::TurnBoundary::new(false);
            boundary
                .run_pre_turn(&self.engine, &self.model, None)
                .await
                .unwrap();
            self.engine
                .session
                .prompt(text, pa_core::session_engine::PromptOptions::default())
                .await
                .unwrap();
            self.engine.session.agent().wait_for_idle().await;
            boundary
                .run_at_settled_turn(&self.engine, &self.model, None, self.harness_dir.clone())
                .await
                .unwrap();
            self.surface
                .drive_boundary(
                    &self.engine,
                    &mut boundary,
                    &self.model,
                    None,
                    self.harness_dir.clone(),
                )
                .await
                .unwrap()
        }
    }

    fn script(responses: Value, context_window: u64) -> Value {
        json!({
            "engine": "faux",
            "modelId": "faux-1",
            "modelName": "Faux Model",
            "reasoning": false,
            "contextWindow": context_window,
            "responses": responses,
        })
    }

    fn no_compaction() -> Value {
        json!({ "compaction": { "enabled": false } })
    }

    /// The `--goal` seed rides the first turn: the goal context row lands
    /// ahead of the user row (its slot still zero), and the seed itself
    /// never announces (the baseline swallows the construction state; the
    /// first `goal_update` is the first turn's own accounting).
    #[tokio::test]
    async fn seed_rides_the_first_turn_and_stays_silent() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        let bed = goal_bed(
            script(json!(["first reply"]), 128_000),
            no_compaction(),
            Some(("finish the work", Some(1_000_000))),
        )
        .await;
        let (counter, subscription) = agent_run_counter(&bed.engine).await;
        let owns = bed.prompt("work").await;
        subscription.unsubscribe().await;
        let runs = counter.load(Ordering::SeqCst);
        // The active goal mints past the one scripted reply; the second
        // turn overruns the faux queue and fails the goal (the
        // terminal-error arm), ending the run.
        assert_eq!(runs, 1, "the continuation turn shares the one run");
        assert!(!owns, "the failed goal no longer owns the boundary");
        let goal = bed.engine.goal_state().await;
        assert_eq!(goal.status, pa_types::goal::GoalStatus::Error);
        assert_eq!(goal.continuations_used, 1, "the seed itself mints nothing");
        let rows = custom_rows(&bed.engine).await;
        assert_eq!(
            rows.iter()
                .filter(|(kind, _)| kind == "goal_context")
                .count(),
            2,
            "the seeded row plus the first turn's minted context"
        );
        // The FIRST context row is the seed's: its slot is still zero and
        // it lands ahead of the user row in the transcript.
        let entries = bed.engine.session.entries().await;
        let mut kinds: Vec<String> = Vec::new();
        for entry in &entries {
            match entry {
                pa_types::session::FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type == pa_core::goals::GOAL_CONTEXT_CUSTOM_TYPE =>
                {
                    let details = payload.details.as_ref().unwrap();
                    kinds.push(format!(
                        "goal_context:{}",
                        details["continuationsUsed"].as_u64().unwrap_or_default()
                    ));
                }
                pa_types::session::FileEntry::Message { .. } => {
                    kinds.push("message".to_string());
                }
                _ => {}
            }
        }
        assert_eq!(
            kinds.first().map(String::as_str),
            Some("goal_context:0"),
            "the seeded context row leads the turn"
        );
        assert_eq!(
            kinds.get(1).map(String::as_str),
            Some("message"),
            "the user prompt follows the seeded row"
        );
        assert_eq!(
            kinds.get(2).map(String::as_str),
            Some("message"),
            "the turn's assistant reply closes the turn"
        );
        assert_eq!(
            kinds.get(3).map(String::as_str),
            Some("goal_context:1"),
            "the first turn's mint leads the next turn"
        );
        let texts = assistant_texts(&bed.engine).await;
        assert_eq!(texts, vec!["first reply".to_string()]);
        // The seed never announced: the first frame is the first turn's
        // usage accounting, then the mint's bump, then the terminal error.
        assert_eq!(
            frame_kinds(&bed.frames),
            vec![
                "goal_update:active",
                "goal_update:active",
                "goal_update:error"
            ]
        );
    }

    /// An unseeded branch reports no seed; a branched (already-seeded)
    /// session does not reseed.
    #[tokio::test]
    async fn seeding_respects_the_branch() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        let bed = goal_bed(
            script(json!(["first reply", "second reply"]), 128_000),
            no_compaction(),
            None,
        )
        .await;
        // A prompt first: the branch gains a message, blocking the seed.
        bed.prompt("work").await;
        assert!(
            !bed.engine
                .seed_initial_goal("finish the work", None)
                .await
                .unwrap(),
            "a branched session never reseeds"
        );
        assert_eq!(
            bed.engine.goal_state().await.status,
            pa_types::goal::GoalStatus::Idle
        );
    }

    /// The natural continuation loop: an unbounded-budget goal mints one
    /// continuation context per settled turn INSIDE the one agent run (no
    /// `agent_start/agent_end` between continuation turns), each mint
    /// publishing its continuationsUsed bump before the turn starts.
    #[tokio::test]
    async fn natural_loop_mints_continuations_inside_one_run() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        let bed = goal_bed(
            script(json!(["turn one reply", "turn two reply"]), 128_000),
            no_compaction(),
            Some(("finish the work", Some(1_000_000))),
        )
        .await;
        let (counter, subscription) = agent_run_counter(&bed.engine).await;
        // The third turn overruns the faux queue: its error ends the run
        // and fails the goal (the terminal-error arm below).
        let owns = bed.prompt("work").await;
        subscription.unsubscribe().await;
        let runs = counter.load(Ordering::SeqCst);
        assert_eq!(runs, 1, "the continuation turns share the one run");
        assert!(!owns, "the failed goal no longer owns the boundary");
        let texts = assistant_texts(&bed.engine).await;
        assert_eq!(
            texts,
            vec!["turn one reply".to_string(), "turn two reply".to_string()],
            "one assistant reply per continuation turn"
        );
        let rows = custom_rows(&bed.engine).await;
        let contexts = rows
            .iter()
            .filter(|(kind, _)| kind == "goal_context")
            .count();
        assert_eq!(
            contexts, 3,
            "the seed context plus one minted context per turn"
        );
        let goal = bed.engine.goal_state().await;
        assert_eq!(goal.status, pa_types::goal::GoalStatus::Error);
        assert_eq!(goal.continuations_used, 2);
        // The stream: each turn's usage bump, each mint's bump, and the
        // terminal error — in that order, with no queue frames (the
        // natural mints never queue).
        assert_eq!(
            frame_kinds(&bed.frames),
            vec![
                "goal_update:active",
                "goal_update:active",
                "goal_update:active",
                "goal_update:active",
                "goal_update:error",
            ]
        );
    }

    /// The budget-limit wrap-up steer: the crossing turn's usage flips the
    /// goal to `budget_limited` (a `goal_update` plus the queued steering
    /// preview between its `message_end` and `turn_end`), the run ends, and
    /// the steer drains as its own run (preparing/committing/running phase
    /// frames) before the queue empties.
    #[tokio::test]
    async fn budget_steer_drains_as_its_own_run() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        let bed = goal_bed(
            script(json!(["goal turn reply", "wrap-up reply"]), 128_000),
            no_compaction(),
            Some(("finish the work", Some(5))),
        )
        .await;
        let (counter, subscription) = agent_run_counter(&bed.engine).await;
        let owns = bed.prompt("work").await;
        subscription.unsubscribe().await;
        let runs = counter.load(Ordering::SeqCst);
        assert_eq!(runs, 2, "the crossing turn and the steer run");
        assert!(!owns, "the budget-limited goal no longer owns the boundary");
        let goal = bed.engine.goal_state().await;
        assert_eq!(goal.status, pa_types::goal::GoalStatus::BudgetLimited);
        assert_eq!(
            goal.last_reason.as_deref(),
            Some("Reached 5 token goal budget")
        );
        assert_eq!(goal.continuations_used, 0, "the steer consumes no slot");
        let texts = assistant_texts(&bed.engine).await;
        assert_eq!(
            texts,
            vec!["goal turn reply".to_string(), "wrap-up reply".to_string()]
        );
        let rows = custom_rows(&bed.engine).await;
        let budget_rows = rows
            .iter()
            .filter(|(kind, text)| {
                kind == "goal_context" && text.starts_with("[goal: budget-limit]")
            })
            .count();
        assert_eq!(budget_rows, 1, "the wrap-up steer's context row ran");
        // The stream order: the crossing's budget_limited goal_update, the
        // queued steering preview, the steer's three phase frames, and the
        // drained queue.
        assert_eq!(
            frame_kinds(&bed.frames),
            vec![
                "goal_update:budget_limited",
                "action:1:",
                "action:0:preparing",
                "action:0:committing",
                "action:0:running",
                "action:0:",
            ]
        );
    }

    /// The threshold arm's held continuation (a resumed session with an
    /// active goal — the print `-c` shape): the in-loop hook mints BEFORE
    /// the run stops (the slot bump entry precedes the compaction entry),
    /// the boundary compacts the resumed history, and the held turn runs as
    /// the post-compaction turn with its queue frames.
    #[tokio::test]
    async fn threshold_hold_mints_before_the_compaction_and_runs_after() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        // A small output budget keeps the 20k window's combined
        // input+output ceiling satisfiable (threshold 13_904: window
        // minus the 2_000 budget and the 4_096 estimate-error floor).
        let mut model_script = script(
            json!([
                "crossing reply",
                "the compaction summary",
                "continuation reply",
            ]),
            20_000,
        );
        model_script["maxTokens"] = json!(2_000);
        let bed = goal_bed_with_resumed_goal(
            model_script,
            json!({
                "compaction": {
                    "enabled": true,
                    "reserveTokens": 1,
                    "keepRecentTokens": 10,
                },
                "autoRefine": { "enabled": false },
            }),
        )
        .await;
        let (counter, subscription) = agent_run_counter(&bed.engine).await;
        let owns = bed.prompt("crossing turn").await;
        subscription.unsubscribe().await;
        let runs = counter.load(Ordering::SeqCst);
        // The crossing turn and the held continuation: two runs (the held
        // turn's own natural mint stays inside its run; its faux-queue
        // exhaustion ends it and fails the goal).
        assert_eq!(runs, 2, "the crossing run and the held-turn run");
        assert!(!owns, "the failed goal no longer owns the boundary");
        let texts = assistant_texts(&bed.engine).await;
        assert_eq!(
            texts,
            vec![
                "resumed history reply".to_string(),
                "crossing reply".to_string(),
                "continuation reply".to_string(),
            ],
            "the held continuation ran as the post-compaction turn"
        );
        // The mint's slot bump (the LAST goal-state entry before the
        // compaction) precedes the compaction; the held context row follows
        // the compaction as the post-compaction turn's leading row.
        let entries = bed.engine.session.entries().await;
        let mut marks: Vec<(String, u64)> = Vec::new();
        for entry in &entries {
            match entry {
                // The goal-state rows are `Custom` entries (their `data` is
                // the serialized state); the context rows are
                // `CustomMessage` entries (their `details` carries the slot).
                pa_types::session::FileEntry::Custom { payload, .. }
                    if payload.custom_type == pa_core::goals::GOAL_STATE_CUSTOM_TYPE =>
                {
                    let slot = payload
                        .data
                        .as_ref()
                        .and_then(|data| data["continuationsUsed"].as_u64())
                        .unwrap_or_default();
                    marks.push((payload.custom_type.clone(), slot));
                }
                pa_types::session::FileEntry::CustomMessage { payload, .. } => {
                    let slot = payload
                        .details
                        .as_ref()
                        .and_then(|details| details["continuationsUsed"].as_u64())
                        .unwrap_or_default();
                    marks.push((payload.custom_type.clone(), slot));
                }
                pa_types::session::FileEntry::Compaction { .. } => {
                    marks.push(("compaction".to_string(), 0));
                }
                _ => {}
            }
        }
        let compaction = marks
            .iter()
            .position(|(kind, _)| kind == "compaction")
            .expect("the threshold arm compacted");
        assert_eq!(
            marks[compaction - 1],
            (pa_core::goals::GOAL_STATE_CUSTOM_TYPE.to_string(), 1),
            "the mint's slot bump immediately precedes the compaction"
        );
        // The live CompactionSummary prevents a second threshold check from
        // writing a spurious skipped `compaction_outcome` before this turn.
        assert_eq!(
            marks[compaction + 1],
            (pa_core::goals::GOAL_CONTEXT_CUSTOM_TYPE.to_string(), 1),
            "the held context row follows the compaction as the next turn"
        );
        assert!(
            marks[compaction + 1..]
                .iter()
                .all(|(kind, _)| kind != "compaction_outcome"),
            "no repeat compaction outcome follows the live summary boundary"
        );
        // The stream: the crossing turn's usage bump, the mint's bump, the
        // held follow-up queue frame, the drain's phase frames (the held
        // turn's own accounting and natural mint land inside its run,
        // before its drain frame), and the terminal error that ends it.
        assert_eq!(
            frame_kinds(&bed.frames),
            vec![
                "goal_update:active",
                "goal_update:active",
                "action:1:",
                "action:0:preparing",
                "action:0:committing",
                "action:0:running",
                "goal_update:active",
                "goal_update:active",
                "action:0:",
                "goal_update:error",
            ]
        );
        let goal = bed.engine.goal_state().await;
        assert_eq!(goal.status, pa_types::goal::GoalStatus::Error);
        assert_eq!(
            goal.continuations_used, 2,
            "the held mint plus the held turn's own natural mint"
        );
    }

    /// The threshold bed's engine shape: a RESUMED session carrying one
    /// history turn and an active goal (the persisted goal state the
    /// driver loads at construction — the print `-c` shape). The history
    /// turn gives the threshold compaction something to summarize.
    async fn goal_bed_with_resumed_goal(script: Value, settings: Value) -> GoalBed {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(agent_dir.join("settings.json"), settings.to_string()).unwrap();
        let parsed = pa_ai::faux::script::parse_faux_script(&script).unwrap();
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                models: Some(vec![parsed.model]),
                ..Default::default()
            });
        registration.set_responses(parsed.responses);
        let model = registration.get_model();
        let stream_fn =
            pa_core::session_engine::provider_adapter::real_stream_fn(None, model.clone());
        let agent_model: pa_agent::types::Model =
            json_round_trip(&model).expect("the faux model crosses the loop boundary");
        // The resumed session: one history turn (a user row and a settled
        // assistant reply), then the active goal state.
        let mut session_manager = pa_core::session::manager::SessionManager::persisted(
            dir.path(),
            &dir.path().join("sessions"),
        );
        session_manager.materialize_session_file(Some(dir.path().join("sessions")));
        session_manager
            .append_message(pa_types::session::AgentMessage::User(
                pa_types::ai::UserMessage {
                    content: pa_types::ai::UserContent::Text(
                        // A large history turn: it crosses the reserve headroom
                        // on the crossing turn's request estimate (the resumed
                        // context rides every request), and the threshold
                        // compaction summarizes it away — the post-compaction
                        // context sits back under the headroom.
                        String::from("a resumed history turn ") + &"x".repeat(60000),
                    ),
                    timestamp: 1,
                    rest: serde_json::Map::default(),
                },
            ))
            .expect("the resumed user turn appends");
        session_manager
            .append_message(pa_types::session::AgentMessage::Assistant(
            serde_json::from_value(json!({
                "role": "assistant",
                "content": [{ "type": "text", "text": "resumed history reply" }],
                "api": "faux",
                "provider": "faux",
                "model": "faux-1",
                "usage": {
                    "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 0,
                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
                },
                "stopReason": "stop",
                "timestamp": 2,
            }))
            .expect("the history reply deserializes"),
        ))
            .expect("the resumed history reply appends");
        {
            let mut driver = pa_core::session_engine::goal_driver::GoalDriver::new();
            driver
                .start(&mut session_manager, "finish the work", Some(1_000_000))
                .unwrap();
        }
        let engine = Arc::new(
            pa_core::session_engine::engine::create_session(
                pa_core::session_engine::engine::SessionEngineConfig {
                    cron_store: None,
                    telemetry: None,
                    cwd: dir.path().to_path_buf(),
                    agent_dir,
                    mcp_manager: None,
                    model: Some(agent_model),
                    thinking_level: None,
                    stream_fn: Some(stream_fn),
                    tools: Vec::new(),
                    custom_system_prompt: None,
                    prompt_guidelines: Vec::new(),
                    generic_mcp_servers: Vec::new(),
                    allow_recursion: None,
                    session_manager: Some(session_manager),
                    extra_host_handlers: None,
                    conversation_log_path: None,
                    additional_skill_paths: Vec::new(),
                    additional_prompt_paths: Vec::new(),
                    extra_builtin_skill_overrides: Vec::new(),
                    rlm_subagent_host: None,
                    rlm_depth: None,
                    model_info: Some(model.clone()),
                    cli_extension_sources: Vec::new(),
                    extension_tool_allow_list: None,
                    prewarm_ipython_kernel: None,
                    queued_goal_context_purge: None,
                    queued_steering_probe: None,
                    steering_mode: None,
                    follow_up_mode: None,
                },
            )
            .await
            .unwrap(),
        );
        assert_eq!(
            engine.goal_state().await.status,
            pa_types::goal::GoalStatus::Active,
            "the persisted goal state loads at construction"
        );
        let (frames, sink) = capture_sink();
        let surface = Arc::new(PrintGoalSurface::with_sink(true, sink));
        surface.seed_publish_baseline(&engine).await;
        let accounting = surface
            .wire_accounting(&engine, engine.session.agent())
            .await;
        let autonomous_run = std::sync::Arc::new(
            crate::headless_autonomous::HeadlessAutonomous::disabled(dir.path()),
        );
        crate::print_autonomous::wire_continuation_hook(
            &engine,
            engine.session.agent(),
            &model,
            &surface,
            &autonomous_run,
        );
        GoalBed {
            engine,
            model,
            surface,
            frames,
            harness_dir: dir.path().join("harness"),
            _accounting: accounting,
            _autonomous_run: autonomous_run,
            _dir: dir,
        }
    }
}
