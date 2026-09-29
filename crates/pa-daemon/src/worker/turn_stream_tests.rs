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
mod broadcast;
mod abort_idle_race;
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
