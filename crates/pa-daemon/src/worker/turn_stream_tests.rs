//! The turn runner's stream tests (moved with the turn concern).
use super::*;
use crate::engine::{
    CompactionOutcome, CompactionRequest, PromptRequest, SessionEngine, SideQuestionOutcome,
    SideQuestionRequest,
};

// The families moved to child modules at the same tree position
// (turn_stream_tests::{queue,feed,broadcast,burst,park}); the shared
// fixtures stay here (burst_runner, turn_session_events, positions_of)
// - every family drives them, and the children reach them + the worker
// namespace through `use super::*`.
mod abort_idle_race;
mod broadcast;
mod burst;
mod feed;
mod park;
mod queue;

/// A minimal turn runner over a fresh session core: exactly what
/// `run_turn` touches (the store stays `None`, the roster push is a
/// no-op link, no supervisor socket).
fn burst_runner(engine: Arc<dyn SessionEngine>) -> TurnRunner {
    let core = Arc::new(Mutex::new(SessionCore {
        active_session_id: "burst-session".to_string(),
        generation: "gen".to_string(),
        last_event_sequence: 0,
        store: None,
        cwd: String::new(),
        steering: VecDeque::new(),
        follow_up: VecDeque::new(),
        busy: false,
        created: false,
        attached_client_ids: Vec::new(),
        abort_requested: false,
        suppress_aborted_row: false,
        shutdown_requested: false,
        compacting: false,
        auto_compaction_enabled: true,
        last_activity_ms: 0,
        last_action_snapshot: Some(SessionActionSnapshot::default()),
        rlm_depth: 0,
        runtime_kind: "top-level".to_string(),
        rlm_child_id: None,
        parent_active_session_id: None,
        parent_session_id: None,
        child_script: None,
        service_tier: None,
        active_service_tier: None,
        steering_mode: "all".to_string(),
        follow_up_mode: "one-at-a-time".to_string(),
        forced_all_steering: false,
        scoped_models: Vec::new(),
        retry_abort_requested: false,
        queued_input_suspended: false,
        pending_next_turn: Vec::new(),
        active_action: None,
        running_tool_calls: std::collections::HashSet::new(),
    }));
    TurnRunner {
        core,
        input_pauses: crate::session_input_pause::InputPauseTable::new(),
        prompt_admissions: crate::prompt_admission::WorkerAdmissions::new(),
        work_notify: Arc::new(Notify::new()),
        idle_notify: Arc::new(Notify::new()),
        events: Arc::new(EventPump::new()),
        engine,
        recovery: Arc::new(Mutex::new(None)),
        active_session_id: "burst-session".to_string(),
        roster_pushes: crate::roster_activity::RosterPushQueue::disabled(),
        user_bash: std::sync::Arc::new(crate::user_bash::UserBash::new()),
        passivation: crate::worker::turn::PassivationContext {
            agent_dir: std::path::PathBuf::from("/tmp"),
            link: std::sync::Arc::new(crate::supervisor_link::SupervisorLink::new(
                std::path::PathBuf::from("/nonexistent-supervisor.sock"),
            )),
            worker_token: String::new(),
        },
    }
}

async fn turn_session_events(engine: Arc<dyn SessionEngine>) -> Vec<Value> {
    let runner = burst_runner(Arc::clone(&engine));
    let mut subscription = runner.events.subscribe();
    runner
        .run_turn(
            engine,
            vec![QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "burst".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
            }],
        )
        .await;
    let mut events = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type == "session_event" {
            if let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) {
                events.push(outbound["event"].clone());
            }
        }
    }
    events
}

fn positions_of(events: &[Value], frame_type: &str) -> Vec<usize> {
    events
        .iter()
        .enumerate()
        .filter(|(_, event)| event.get("type").and_then(Value::as_str) == Some(frame_type))
        .map(|(index, _)| index)
        .collect()
}

// The abort gate's arm semantics (the fallback closer's silence
// association), pinned on the wire: a scripted engine replays the
// sighting frames through the worker's own gated emit with the flag
// preset (`run_turn` driven directly - the pickup's delivery-scoped
// clear never ran), so the final-emit race is deterministic.
struct GateProbeEngine {
    frames: Vec<EngineEvent>,
}

impl SessionEngine for GateProbeEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        _request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        for frame in &self.frames {
            if !emit(frame.clone()) {
                return;
            }
        }
    }

    fn run_side_question(
        &self,
        _request: SideQuestionRequest,
        _signal: &pa_agent::abort::AbortSignal,
        _sink: &pa_core::session_engine::side_question::SideQuestionSink,
    ) -> SideQuestionOutcome {
        SideQuestionOutcome::Failed {
            answer: String::new(),
            error: "unsupported".to_string(),
        }
    }

    fn run_compaction(
        &self,
        _request: CompactionRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        CompactionOutcome::Skipped {
            message: "nothing to compact".to_string(),
        }
    }

    fn run_branch_summary(
        &self,
        _request: crate::engine::BranchSummaryRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::BranchSummaryOutcome {
        crate::engine::BranchSummaryOutcome::Failed {
            error: "unsupported".to_string(),
        }
    }

    fn rebuild_session_context(
        &self,
        _branch_entries: Vec<pa_types::session::FileEntry>,
        _goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        Ok(())
    }
}

/// One gated sighting battery: the scripted frames through the worker's
/// turn with the abort flag (and the suppressed-row class) preset.
async fn gate_sighting_events(
    frames: Vec<EngineEvent>,
    abort_requested: bool,
    suppress_aborted_row: bool,
) -> Vec<Value> {
    let engine: Arc<dyn SessionEngine> = Arc::new(GateProbeEngine { frames });
    let runner = burst_runner(Arc::clone(&engine));
    {
        let mut core = runner.core.lock().unwrap();
        core.abort_requested = abort_requested;
        core.suppress_aborted_row = suppress_aborted_row;
    }
    let mut subscription = runner.events.subscribe();
    runner
        .run_turn(
            engine,
            vec![QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "gate".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
            }],
        )
        .await;
    let mut events = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type == "session_event" {
            if let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) {
                events.push(outbound["event"].clone());
            }
        }
    }
    events
}

/// The finding's final-emit race, made deterministic: an abort flag
/// sighting on the trailing `Done` of a run that completed on its own
/// (the session-command / pre-model-failure shape - no aborted outcome,
/// no suppressed row) must not arm the fallback's silence: the closer
/// still pairs the run's opening `agent_start` (TS: an abort of a
/// finished run no-ops).
#[tokio::test]
async fn a_late_abort_sighting_on_a_completed_runs_done_keeps_the_fallback_closer() {
    let events = gate_sighting_events(vec![EngineEvent::Done(Ok(()))], true, false).await;
    let starts = positions_of(&events, "agent_start");
    let ends = positions_of(&events, "agent_end");
    assert_eq!(starts.len(), 1, "the run opens one agent_start: {events:?}");
    assert_eq!(
        ends.len(),
        1,
        "the fallback closer pairs the opening agent_start: {events:?}"
    );
    assert!(
        ends[0] > starts[0],
        "the closer lands after the open: {events:?}"
    );
}

/// The admission consult's settle: `DoneAborted` with no engine
/// `agent_end` - the aborted-outcome carrier arms the silence, the
/// suppressed-run wire shape holds (no synthesized closer for the
/// aborted turn).
#[tokio::test]
async fn done_aborted_arms_the_fallback_silence() {
    let events = gate_sighting_events(vec![EngineEvent::DoneAborted], true, false).await;
    assert!(
        positions_of(&events, "agent_end").is_empty(),
        "the aborted settle keeps the suppressed-run silence: {events:?}"
    );
}

/// The suppressed-row class (the compact path's detached run): a settle
/// frame that would forward on a plain flag sighting (the closer test's
/// shape) drops when `suppress_aborted_row` is set - the arm is what the
/// assertion discriminates on, not the flag: without the suppress term
/// the same `ToolResultMessage` reaches the wire as its message pair.
#[tokio::test]
async fn the_suppressed_row_sighting_drops_and_arms_the_silence() {
    let events = gate_sighting_events(
        vec![
            EngineEvent::ToolResultMessage(json!({
                "role": "toolResult",
                "text": "the aborted tool's error result",
            })),
            EngineEvent::Done(Ok(())),
        ],
        true,
        true,
    )
    .await;
    assert!(
        positions_of(&events, "message_start").is_empty()
            && positions_of(&events, "message_end").is_empty(),
        "the suppressed settle frame never reaches the wire: {events:?}"
    );
    assert!(
        positions_of(&events, "agent_end").is_empty(),
        "the suppressed-row sighting arms the silence: {events:?}"
    );
}
