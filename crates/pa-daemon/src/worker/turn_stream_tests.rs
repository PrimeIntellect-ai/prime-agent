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
        tool_use_count: 0,
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
#[derive(Default)]
struct GateProbeEngine {
    frames: Vec<EngineEvent>,
    boundaries: Mutex<Vec<Option<String>>>,
    turns_done: std::sync::atomic::AtomicUsize,
}

impl SessionEngine for GateProbeEngine {
    fn set_prompt_context_boundary(&self, leaf_id: Option<String>) {
        self.boundaries.lock().unwrap().push(leaf_id);
    }

    fn on_turn_done(&self) {
        self.turns_done
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

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
    let engine: Arc<dyn SessionEngine> = Arc::new(GateProbeEngine {
        frames,
        ..GateProbeEngine::default()
    });
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

/// A turn aborted under row suppression (a manual compaction or tree move)
/// still reaches the engine's turn boundary at its swallowed `Done`, so
/// child prompts held for that turn are released.
#[tokio::test]
async fn a_suppressed_abort_still_ends_the_engine_turn() {
    for done in [EngineEvent::Done(Ok(())), EngineEvent::DoneAborted] {
        let engine = Arc::new(GateProbeEngine {
            frames: vec![done],
            ..GateProbeEngine::default()
        });
        let dynamic: Arc<dyn SessionEngine> = engine.clone();
        let runner = burst_runner(Arc::clone(&dynamic));
        {
            let mut core = runner.core.lock().unwrap();
            core.abort_requested = true;
            core.suppress_aborted_row = true;
        }
        runner
            .run_turn(
                dynamic,
                vec![QueuedItem {
                    priority: QueuePriority::Human,
                    preview: None,
                    message: "aborted".to_string(),
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
        assert_eq!(
            engine.turns_done.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }
}

/// #4: the turn's tool executions count onto the session's `toolUseCount`
/// (TS bumps the child's counter per `tool_execution_start`), the value the
/// worker's roster deltas carry.
#[tokio::test]
async fn a_turns_tool_executions_count_onto_the_summary() {
    let engine: Arc<dyn SessionEngine> = Arc::new(GateProbeEngine {
        frames: vec![
            EngineEvent::ToolExecutionStart {
                tool_call_id: "t1".to_string(),
                tool_name: "bash".to_string(),
                args: Value::Null,
            },
            EngineEvent::ToolExecutionEnd {
                tool_call_id: "t1".to_string(),
                result: Value::Null,
                is_error: false,
            },
            EngineEvent::ToolExecutionStart {
                tool_call_id: "t2".to_string(),
                tool_name: "edit".to_string(),
                args: Value::Null,
            },
            EngineEvent::Done(Ok(())),
        ],
        ..GateProbeEngine::default()
    });
    let runner = burst_runner(Arc::clone(&engine));
    runner
        .run_turn(
            engine,
            vec![QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "tools".to_string(),
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
    let summary = {
        let core = runner.core.lock().unwrap();
        session_summary(
            &core,
            SummaryInputs {
                thinking_level: "default".to_string(),
                model: None,
                model_fallback_message: None,
                bash_running: false,
                quota_parked: false,
                subagents_running: false,
                progress_note: None,
            },
        )
    };
    let summary = serde_json::to_value(&summary).unwrap();
    assert_eq!(
        summary["toolUseCount"],
        json!(2),
        "the summary: {summary:?}"
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

/// Engine-only stores cannot persist these transitions: the worker must
/// commit both rows in the same stream order as the assistant/tool rows.
#[tokio::test]
async fn model_transitions_reach_the_worker_owned_session_file() {
    for abort_suppressed in [None, Some(false), Some(true)] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let expected = vec![
            json!({"provider": "backup", "modelId": "model/with/slashes"}),
            json!({"provider": "primary", "modelId": "model/with/slashes"}),
        ];
        let mut frames = vec![
            EngineEvent::ModelChange(pa_types::session::ModelChangeEntry {
                provider: "backup".to_string(),
                model_id: "model/with/slashes".to_string(),
            }),
            EngineEvent::AssistantMessage(
                json!({"role": "assistant", "content": [], "stopReason": "toolUse"}),
            ),
            EngineEvent::ModelChange(pa_types::session::ModelChangeEntry {
                provider: "primary".to_string(),
                model_id: "model/with/slashes".to_string(),
            }),
            EngineEvent::ToolResultMessage(
                json!({"role": "toolResult", "toolCallId": "probe", "content": []}),
            ),
            EngineEvent::Done(Ok(())),
        ];
        if abort_suppressed.is_some() {
            frames.retain(|event| {
                matches!(event, EngineEvent::ModelChange(_) | EngineEvent::Done(_))
            });
        }
        let engine: Arc<dyn SessionEngine> = Arc::new(GateProbeEngine {
            frames,
            ..GateProbeEngine::default()
        });
        let runner = burst_runner(Arc::clone(&engine));
        let mut store = crate::session_store::SessionFile::create("/fixture", None, 0);
        store.set_path(path.clone());
        store.rewrite().unwrap();
        {
            let mut core = runner.core.lock().unwrap();
            core.store = Some(store);
            core.abort_requested = abort_suppressed.is_some();
            core.suppress_aborted_row = abort_suppressed.unwrap_or(false);
        }
        runner
            .run_turn(
                engine,
                vec![QueuedItem {
                    priority: QueuePriority::Human,
                    preview: None,
                    message: "probe".to_string(),
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
        let rows: Vec<Value> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let transitions: Vec<Value> = rows
            .iter()
            .filter(|row| row["type"] == "model_change")
            .map(|row| json!({"provider": row["provider"], "modelId": row["modelId"]}))
            .collect();
        assert_eq!(transitions, expected);
        let relevant: Vec<&str> = rows
            .iter()
            .filter_map(|row| match row["type"].as_str() {
                Some("model_change") => Some("model"),
                Some("message") => row["message"]["role"].as_str(),
                _ => None,
            })
            .collect();
        assert_eq!(
            relevant,
            if abort_suppressed.is_some() {
                vec!["model", "model"]
            } else {
                vec!["model", "assistant", "model", "toolResult"]
            }
        );
    }
}

/// noSession keeps its prefix IDs in the worker's in-memory store; they
/// cannot fence the engine's durable restore. File-backed prompts capture the
/// leaf after next-turn prefix rows have persisted.
#[tokio::test]
async fn prompt_restore_boundary_is_supplied_only_for_file_backed_stores() {
    let dir = tempfile::tempdir().unwrap();
    for file_backed in [false, true] {
        let engine = Arc::new(GateProbeEngine {
            frames: vec![EngineEvent::Done(Ok(()))],
            ..GateProbeEngine::default()
        });
        let dynamic: Arc<dyn SessionEngine> = engine.clone();
        let runner = burst_runner(Arc::clone(&dynamic));
        let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
        store.append_session_info("prefix");
        assert!(store.leaf_id().is_some(), "in-memory prefixes have IDs too");
        if file_backed {
            store.set_path(dir.path().join("backed.jsonl"));
            store.rewrite().unwrap();
        }
        {
            let mut core = runner.core.lock().unwrap();
            core.store = Some(store);
            core.pending_next_turn.push(json!({
                "role":"custom", "customType":"prior_context", "content":"keep this prefix",
                "display":false,
            }));
        }
        runner
            .run_turn(
                dynamic,
                vec![QueuedItem {
                    priority: QueuePriority::Human,
                    preview: None,
                    message: "go".to_string(),
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
        let expected = if file_backed {
            let path = dir.path().join("backed.jsonl");
            let persisted = crate::session_store::SessionFile::open(&path).unwrap();
            assert!(
                std::fs::read_to_string(&path)
                    .unwrap()
                    .contains("prior_context"),
                "the captured boundary follows the prefix on disk"
            );
            vec![persisted.leaf_id().map(str::to_string)]
        } else {
            assert!(!dir.path().join("backed.jsonl").exists());
            Vec::new()
        };
        assert_eq!(
            *engine.boundaries.lock().unwrap(),
            expected,
            "boundary capture must match durable ownership (file_backed={file_backed})"
        );
    }
}
