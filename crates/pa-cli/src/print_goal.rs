//! The print run's goal continuation loop: the usage-accounting publication, the
//! in-loop continuation hook, and the driver's queue arms (the in-run shape
//! probed against the TS binary; budget/threshold stops).

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

/// Where the boundary's json events go: stdout in the product, a captured buffer in tests (the same
/// sink contract `print_boundary` uses).
pub(crate) type EventSink = std::sync::Arc<dyn Fn(&Value) + Send + Sync>;

/// Collapse whitespace, cap at 160 chars with a trailing `...` (the session-action label form).
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

/// The queue lane a minted goal turn was queued through: which preview array it rides in the queue
/// snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueueLane {
    Steering,
    FollowUp,
}

/// The goal arm's consult outcome for the composed natural-turn-end hook.
pub(crate) enum NaturalContinuation {
    /// Queued session input owns the boundary (the armed budget steer): no turn mints, the run ends
    /// so the queue drains.
    QueuedInput,
    /// A pending requested compaction consumes the stop: no mint, the boundary consumes the
    /// request.
    RequestedCompaction,
    /// A threshold compaction is due: the loop stops (any owed mint is held for the post-compaction
    /// admission), the boundary compacts.
    ThresholdDue,
    /// The goal minted its next continuation row.
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
    /// The full message text (the queued preview returns the whole normalized text).
    fn preview_text(&self) -> String {
        custom_message_text(&self.message)
    }
}

/// The text of one custom row's content: the plain text, or the text blocks joined.
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

/// The print run's goal surface: the usage accounting, the armed budget
/// steer, the threshold-held continuation, and the queue-phase frames.
pub(crate) struct PrintGoalSurface {
    json_mode: bool,
    sink: EventSink,
    /// Whether the latest settled turn's usage crossed the goal budget (the driver consumes it).
    budget_crossed: AtomicBool,
    /// The queued goal turn (the armed budget steer or the held continuation).
    queued: Mutex<Option<QueuedGoalTurn>>,
    /// The label of the action the driver is admitting (`None` when nothing is active).
    active_label: Mutex<Option<String>>,
    /// The next queued-turn drain completes its `running` frame at `turn_start`
    /// (the steer drain keeps `agent_start`).
    running_frame_at_turn_start: AtomicBool,
    /// The last `session_action_update` snapshot emitted (unchanged projections stay silent).
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

    /// A surface with an explicit event sink (json-mode verifiers).
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

    fn emit(&self, event: &Value) {
        if self.json_mode {
            (self.sink)(event);
        }
    }

    /// Seed the publish dedupe's baseline: the state at attach time never announces itself.
    pub(crate) async fn seed_publish_baseline(&self, engine: &SessionEngine) {
        *self.last_published_goal.lock().await = engine.goal_state().await;
    }

    /// Publish the current goal state as a `goal_update` when it changed.
    pub(crate) async fn publish_goal_update(&self, engine: &SessionEngine) {
        let goal = engine.goal_state().await;
        let changed = {
            let mut last = self.last_published_goal.lock().await;
            // The dedupe is age-invariant: the timer's age ticks with the wall
            // clock (a boundary between reads must not re-emit an unchanged goal).
            if pa_core::goals::goal_update_dedupe_projection(&last)
                == pa_core::goals::goal_update_dedupe_projection(&goal)
            {
                false
            } else {
                *last = goal.clone();
                true
            }
        };
        if changed {
            self.emit(&json!({
                "type": "goal_update",
                "goal": serde_json::to_value(&goal).unwrap_or(Value::Null),
            }));
        }
    }

    /// The queue snapshot frame: an unchanged projection stays silent.
    async fn emit_action_snapshot(&self, snapshot: Value) {
        let mut last = self.last_action_snapshot.lock().await;
        if *last == snapshot {
            return;
        }
        *last = snapshot.clone();
        drop(last);
        self.emit(&json!({ "type": "session_action_update", "actions": snapshot }));
    }

    /// The snapshot of a queue holding one minted goal turn (the queued preview is the full row
    /// text).
    fn queued_snapshot(turn: &QueuedGoalTurn) -> Value {
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

    /// Queue one minted goal turn: the queue snapshot publishes at the moment of the mint.
    async fn queue_turn(&self, turn: QueuedGoalTurn) {
        let snapshot = Self::queued_snapshot(&turn);
        *self.queued.lock().await = Some(turn);
        self.emit_action_snapshot(snapshot).await;
    }

    /// Arm the budget-limit wrap-up steer: the crossing turn's message end
    /// queues it (the `budget_crossed` flag the driver's settle consult reads).
    async fn arm_budget_steer(&self, message: CustomMessage) {
        self.budget_crossed.store(true, Ordering::SeqCst);
        self.queue_turn(QueuedGoalTurn {
            message,
            lane: QueueLane::Steering,
        })
        .await;
    }

    /// Hold the threshold-compaction continuation: the mint precedes the compaction; the held turn
    /// runs as the post-compaction turn.
    async fn hold_threshold_continuation(&self, message: CustomMessage) {
        self.queue_turn(QueuedGoalTurn {
            message,
            lane: QueueLane::FollowUp,
        })
        .await;
    }

    /// The budget-steer read: the crossing's queued turn, consumed once (no
    /// other lane can be mistaken for the armed crossing).
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

    /// The driver's threshold-hold read: the continuation the in-loop hook minted ahead of the
    /// boundary's compaction, consumed once.
    pub(crate) async fn take_threshold_continuation(&self) -> Option<CustomMessage> {
        let mut queued = self.queued.lock().await;
        match queued.as_ref().map(|turn| turn.lane) {
            Some(QueueLane::FollowUp) => queued.take().map(|turn| turn.message),
            _ => None,
        }
    }

    async fn emit_action_preparing(&self, label: &str) {
        self.emit_action_phase("preparing", label).await;
    }

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

    /// The `running` phase frame: the agent's `agent_start` of the turn the driver admitted.
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

    /// The `session_command` action's phase frame (the snapshot's `active` entry, kind
    /// `session_command`).
    pub(crate) async fn emit_command_phase(&self, phase: &str, label: &str) {
        self.emit_action_snapshot(json!({
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
            "active": { "kind": "session_command", "phase": phase, "label": label },
        }))
        .await;
    }

    /// The queue frame of a session command that scheduled a goal continuation:
    /// the queued preview rides while the command action is still active.
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

    /// The settled command's queue frame: the action completed, the queued continuation stays.
    pub(crate) async fn emit_command_queue_drain(&self, continuation: &CustomMessage) {
        let preview = custom_message_text(continuation);
        self.emit_action_snapshot(json!({
            "queuedCount": 1,
            "steering": [],
            "followUps": [preview],
        }))
        .await;
    }

    /// The empty-projection idle frame (a settled command that scheduled nothing).
    pub(crate) async fn emit_queue_idle(&self) {
        self.emit_action_snapshot(json!({
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
        }))
        .await;
    }

    /// One durable row's `message_start`/`message_end` pair (rows appended outside the agent loop).
    pub(crate) fn emit_row_pair(&self, row: &CustomMessage) {
        let value = crate::headless_autonomous::custom_row_wire_value(row);
        for event_type in ["message_start", "message_end"] {
            self.emit(&json!({ "type": event_type, "message": value }));
        }
    }

    /// One raw stream event (the session-command events: `compaction_start`, `compaction_end`,
    /// `refine_complete`, `refine_failed`).
    pub(crate) fn emit_stream_event(&self, event: &Value) {
        self.emit(event);
    }

    /// The unconditional goal-state publish: the dedupe baseline follows the published state until
    /// it changes again.
    pub(crate) async fn publish_goal_update_forced(&self, engine: &SessionEngine) {
        let goal = engine.goal_state().await;
        *self.last_published_goal.lock().await = goal.clone();
        self.emit(&json!({
            "type": "goal_update",
            "goal": serde_json::to_value(&goal).unwrap_or(Value::Null),
        }));
    }

    /// Arm the `running`-frame-at-`turn_start` position for the next queued-turn drain.
    pub(crate) fn arm_running_frame_at_turn_start(&self) {
        self.running_frame_at_turn_start
            .store(true, Ordering::SeqCst);
    }

    async fn emit_action_drained(&self) {
        *self.active_label.lock().await = None;
        self.emit_action_snapshot(json!({
            "queuedCount": 0,
            "steering": [],
            "followUps": [],
        }))
        .await;
    }

    /// Wire the goal usage accounting onto the engine's event feed: settled
    /// non-error turns spend the budget, the crossing arms the steer, every
    /// state change publishes `goal_update`.
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
                            // Only turns that were neither errors nor aborted spend the budget; the
                            // crossing flips the goal to `budget_limited` and arms the steer.
                            if !matches!(
                                wire.stop_reason,
                                pa_types::ai::StopReason::Error | pa_types::ai::StopReason::Aborted
                            ) {
                                // The message identity for the double-counting guard: the loop does
                                // not assign message ids in-process.
                                let message_id = format!("a-{}", wire.timestamp);
                                // Goal accounting must not interrupt the loop; a failed persist
                                // only warns.
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
                    // A kernel-side `goal.complete`/`goal.create` mid-turn publishes at the moment
                    // it happened.
                    surface.publish_goal_update(&engine).await;
                    Ok(())
                })
            })
            .await
    }

    /// The goal arm of the natural-turn-end consult: queued input (the armed
    /// steer) and a compaction due gate the mint — the threshold arm mints
    /// ahead of the compaction and holds it — and an active goal mints its
    /// next continuation turn inside the same agent run.
    pub(crate) async fn natural_continuation(
        &self,
        engine: &Arc<SessionEngine>,
        model: &pa_types::ai::Model,
    ) -> NaturalContinuation {
        // Queued session input owns the boundary before any goal work — the armed budget steer ends
        // the run so the queue drains it.
        if self.queued.lock().await.is_some() {
            return NaturalContinuation::QueuedInput;
        }
        if engine.turn_boundary.compaction_scheduled().await {
            return NaturalContinuation::RequestedCompaction;
        }
        // The threshold arm: the crossing turn mints BEFORE the loop stops; the
        // boundary compacts, and the driver runs the held turn post-compaction.
        if engine.session.auto_compaction_due(model).await {
            if let Some(message) = engine.mint_goal_continuation().await {
                self.publish_goal_update(engine).await;
                self.hold_threshold_continuation(message).await;
            }
            return NaturalContinuation::ThresholdDue;
        }
        // The natural continuation mint: the goal's context turn runs as the next
        // turn of the same run; a row that cannot convert drops the mint.
        if let Some(message) = engine.mint_goal_continuation().await {
            self.publish_goal_update(engine).await;
            engine.clear_pending_goal_continuation().await;
            return match custom_message_to_loop_row(&message) {
                Some(row) => NaturalContinuation::GoalRow(Box::new(row)),
                None => NaturalContinuation::FallThrough,
            };
        }
        NaturalContinuation::FallThrough
    }

    /// The settled boundary's goal drain: the held continuation and the armed
    /// budget steer run as this invocation's follow-up turns; a turn that
    /// still ends in a terminal error fails an active goal. Returns whether
    /// an active goal still owns the boundary.
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
                // A goal that went inactive mid-turn drops its queued continuation.
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

    /// Admit a session command's scheduled continuation (a `/goal` start or resume)
    /// as the print invocation's next run, with the command surface's frame order.
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

    /// Admit one queued goal turn as the print invocation's next run (the queue
    /// drain): the phase frames bookend the turn.
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
        // The queued goal turn's run completes its admission: the held continuation
        // leaves the hold, so the pending guard releases before the next consult.
        engine.clear_pending_goal_continuation().await;
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
// The faux provider registry is process-global: one std lock serializes every test that drives it.
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

    /// The goal frame kinds, in order (`goal_update` statuses and the session-action phases).
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

    /// Count the agent runs (`agent_end` events) a live subscription observes.
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

    /// The faux engine bed: engine, tempdir, model, wired surface (accounting +
    /// hook), and captured frames. The `--goal` seed runs BEFORE the surface wires.
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
        registration.set_repeat_last_response(parsed.repeat_last_response);
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
                    on_late_sent_agent_message: None,
                    semantic_edges: None,
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
                    prewarm_ipython_kernel: None,
                    on_background_work_settled: None,
                    queued_goal_context_purge: None,
                    queued_steering_probe: None,
                    image_model_router: None,
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
        /// Keeps the composed hook's autonomous arm alive for the bed's lifetime (the hook holds it
        /// weakly).
        _autonomous_run: Arc<crate::headless_autonomous::HeadlessAutonomous>,
        _dir: tempfile::TempDir,
    }

    impl GoalBed {
        /// Admit one prompt through the same driver path the print runtime uses
        /// (the in-loop hook runs the natural continuations inside the one run).
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

    fn script(responses: &Value, context_window: u64) -> Value {
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

    /// The context row lands ahead of the user row (its slot still zero), and the
    /// seed never announces.
    #[tokio::test]
    async fn seed_rides_the_first_turn_and_stays_silent() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        let bed = goal_bed(
            script(&json!(["first reply"]), 128_000),
            no_compaction(),
            Some(("finish the work", Some(1_000_000))),
        )
        .await;
        let (counter, subscription) = agent_run_counter(&bed.engine).await;
        let owns = bed.prompt("work").await;
        subscription.unsubscribe().await;
        let runs = counter.load(Ordering::SeqCst);
        // The active goal mints past the one scripted reply; the second turn
        // overruns the faux queue and fails the goal (the terminal-error arm).
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
        assert_eq!(
            frame_kinds(&bed.frames),
            vec![
                "goal_update:active",
                "goal_update:active",
                "goal_update:error"
            ]
        );
    }

    /// An unseeded branch reports no seed; a branched (already-seeded) session does not reseed.
    #[tokio::test]
    async fn seeding_respects_the_branch() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        let bed = goal_bed(
            script(&json!(["first reply", "second reply"]), 128_000),
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

    /// An unbounded-budget goal mints one continuation context per settled turn INSIDE
    /// the one agent run.
    #[tokio::test]
    async fn natural_loop_mints_continuations_inside_one_run() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        let bed = goal_bed(
            script(&json!(["turn one reply", "turn two reply"]), 128_000),
            no_compaction(),
            Some(("finish the work", Some(1_000_000))),
        )
        .await;
        let (counter, subscription) = agent_run_counter(&bed.engine).await;
        // The third turn overruns the faux queue: its error ends the run and fails the goal.
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
        // The stream: each turn's usage bump, each mint's bump, and the terminal
        // error — no queue frames (the natural mints never queue).
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

    /// The crossing turn's usage flips the goal to `budget_limited`, the run ends, and the
    /// steer drains as its own run.
    #[tokio::test]
    async fn budget_steer_drains_as_its_own_run() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        let bed = goal_bed(
            script(&json!(["goal turn reply", "wrap-up reply"]), 128_000),
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

    /// The threshold arm's held continuation (the print `-c` shape): the hook mints BEFORE the
    /// run stops, the boundary compacts, and the held turn runs as the post-compaction turn.
    #[tokio::test]
    async fn threshold_hold_mints_before_the_compaction_and_runs_after() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        // A small output budget keeps the 20k window's combined input+output
        // ceiling satisfiable (threshold 13_904 = window - 2_000 budget - 4_096
        // estimate floor).
        let mut model_script = script(
            &json!([
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
        // The crossing turn and the held continuation: two runs (the held turn's
        // own natural mint stays inside its run; faux-queue exhaustion fails the goal).
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
        let entries = bed.engine.session.entries().await;
        let mut marks: Vec<(String, u64)> = Vec::new();
        for entry in &entries {
            match entry {
                // The goal-state rows are `Custom` entries (`data` carries the state);
                // the context rows are `CustomMessage` entries (`details` carries the slot).
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

    /// The threshold bed: a RESUMED session carrying one history turn and an
    /// active goal (the persisted goal state the driver loads at construction).
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
        registration.set_repeat_last_response(parsed.repeat_last_response);
        let model = registration.get_model();
        let stream_fn =
            pa_core::session_engine::provider_adapter::real_stream_fn(None, model.clone());
        let agent_model: pa_agent::types::Model =
            json_round_trip(&model).expect("the faux model crosses the loop boundary");
        // The resumed session: one history turn (a user row and a settled assistant reply), then
        // the active goal state.
        let mut session_manager = pa_core::session::manager::SessionManager::persisted(
            dir.path(),
            &dir.path().join("sessions"),
        );
        session_manager.materialize_session_file(Some(dir.path().join("sessions")));
        session_manager
            .append_message(pa_types::session::AgentMessage::User(
                pa_types::ai::UserMessage {
                    content: pa_types::ai::UserContent::Text(
                        // A large history turn: it crosses the reserve headroom on the crossing
                        // turn's request estimate, and the compaction summarizes it away.
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
                    on_late_sent_agent_message: None,
                    semantic_edges: None,
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
                    prewarm_ipython_kernel: None,
                    on_background_work_settled: None,
                    queued_goal_context_purge: None,
                    queued_steering_probe: None,
                    image_model_router: None,
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
