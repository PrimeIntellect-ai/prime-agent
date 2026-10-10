//! The turn runner's stream tests.
use super::*;
use crate::engine::{
    CompactionOutcome, CompactionRequest, PromptRequest, SessionEngine, SideQuestionOutcome,
    SideQuestionRequest,
};

// The shared fixtures stay here; the child modules reach them
// through `use super::*`.
mod abort_idle_race;
mod broadcast;
mod burst;
mod feed;
mod interleave;
mod park;
mod queue;

/// A minimal turn runner over a fresh session core: exactly what `run_turn` touches.
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
        running_admission_ids: std::collections::HashSet::new(),
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
        herdr: std::sync::Arc::new(std::sync::Mutex::new(crate::herdr::HerdrReporter::default())),
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

// The abort gate's arm semantics, pinned on the wire: `run_turn` driven
// directly (the pickup's delivery-scoped clear never ran), so the final-emit
// race is deterministic.
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

/// One gated sighting battery: the scripted frames through the worker's turn with
/// the abort flag (and the suppressed-row class) preset.
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

/// A sighting on the trailing `Done` of a self-completed run must not arm the
/// fallback's silence — the closer still pairs the run's `agent_start`.
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

/// `DoneAborted` with no engine `agent_end`: the aborted-outcome carrier arms the
/// silence.
#[tokio::test]
async fn done_aborted_arms_the_fallback_silence() {
    let events = gate_sighting_events(vec![EngineEvent::DoneAborted], true, false).await;
    assert!(
        positions_of(&events, "agent_end").is_empty(),
        "the aborted settle keeps the suppressed-run silence: {events:?}"
    );
}

/// An abort landing between the run's steps settles through the run's own
/// terminal frames — the original `toolUse` `turn_end`, then an `agent_end`
/// that carries the abort marker (the wire fact an attached client's
/// idle-vs-done settle keys on).
#[tokio::test]
async fn an_abort_between_steps_marks_the_runs_agent_end() {
    let tool_message = json!({ "role": "assistant", "stopReason": "toolUse" });
    let events = gate_sighting_events(
        vec![
            EngineEvent::ToolExecutionEnd {
                tool_call_id: "t1".to_string(),
                result: json!({ "text": "the tool settled" }),
                is_error: false,
            },
            EngineEvent::TurnEnd {
                message: tool_message.clone(),
                tool_results: Vec::new(),
            },
            EngineEvent::AgentEnd {
                messages: vec![tool_message],
            },
        ],
        true,
        false,
    )
    .await;
    let turn_ends = positions_of(&events, "turn_end");
    assert_eq!(turn_ends.len(), 1, "the run's terminal frame: {events:?}");
    assert_eq!(
        events[turn_ends[0]]["message"]["stopReason"],
        json!("toolUse"),
        "the abort between steps keeps the original terminal frame: {events:?}"
    );
    let agent_ends = positions_of(&events, "agent_end");
    assert_eq!(
        agent_ends.len(),
        1,
        "the aborted run still ends: {events:?}"
    );
    assert_eq!(
        events[agent_ends[0]]["aborted"],
        json!(true),
        "the aborted run's agent_end carries the marker: {events:?}"
    );
    assert!(
        turn_ends[0] < agent_ends[0],
        "the settle pair lands in order: {events:?}"
    );
}

/// A run that settled on its own keeps the TS `agent_end` shape — the marker
/// rides aborted runs only.
#[tokio::test]
async fn a_self_settled_runs_agent_end_carries_no_marker() {
    let tool_message = json!({ "role": "assistant", "stopReason": "toolUse" });
    let events = gate_sighting_events(
        vec![
            EngineEvent::TurnEnd {
                message: tool_message.clone(),
                tool_results: Vec::new(),
            },
            EngineEvent::AgentEnd {
                messages: vec![tool_message],
            },
        ],
        false,
        false,
    )
    .await;
    let agent_ends = positions_of(&events, "agent_end");
    assert_eq!(
        agent_ends.len(),
        1,
        "the settled run's agent_end: {events:?}"
    );
    assert!(
        events[agent_ends[0]].get("aborted").is_none(),
        "the self-settled run keeps the TS frame shape: {events:?}"
    );
}

/// A settle frame that would forward on a plain flag sighting drops when
/// `suppress_aborted_row` is set.
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
