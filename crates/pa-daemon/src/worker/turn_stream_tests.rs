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
        turn_cancelled: false,
        turn_completed: false,
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
        kernel_bash_creators: std::collections::VecDeque::new(),
        kernel_bash_activity: std::sync::Arc::new(tokio::sync::Notify::new()),
        running_client_admissions: Vec::new(),
        running_wire_admissions: Vec::new(),
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
            Lane::Steering,
            vec![QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "burst".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                client_admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
                kernel_notice: false,
                delivery_scoped: false,
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
            Lane::Steering,
            vec![QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "gate".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                client_admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
                kernel_notice: false,
                delivery_scoped: false,
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

/// A late abort sighting on the trailing `Done` of a self-completed run keeps the
/// fallback closer that pairs the run's `agent_start`.
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

/// A turn whose settle frame the abort gate swallowed (the engine
/// stopped consuming — the outcome cell never fills) still resolves
/// every waiting `prompt_and_wait` through the honest abort fallback:
/// the item's done sender learns `TurnSettle::Aborted`, never a
/// dropped channel's "Prompt did not complete". Removing the
/// fallback leaves the waiter unresolved (the timeout below fails).
#[tokio::test]
async fn a_swallowed_settle_resolves_the_waiting_prompt_through_the_abort_fallback() {
    let engine: Arc<dyn SessionEngine> = Arc::new(GateProbeEngine {
        // One non-settle frame: the armed abort gate swallows it, the
        // probe engine stops, and NO settle event ever lands.
        frames: vec![EngineEvent::UserMessage(json!({
            "role": "user",
            "content": "held",
            "timestamp": 0,
        }))],
        ..GateProbeEngine::default()
    });
    let runner = burst_runner(Arc::clone(&engine));
    {
        let mut core = runner.core.lock().unwrap();
        core.abort_requested = true;
    }
    let (done_tx, done_rx) = oneshot::channel::<TurnSettle>();
    runner
        .run_turn(
            engine,
            Lane::Steering,
            vec![QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "held".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                client_admission_id: None,
                images: Vec::new(),
                done: Some(done_tx),
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
                kernel_notice: false,
                delivery_scoped: false,
            }],
        )
        .await;
    let settle = tokio::time::timeout(std::time::Duration::from_secs(5), done_rx)
        .await
        .expect("the swallowed settle resolves the waiting prompt")
        .expect("the settle channel stays open");
    assert_eq!(
        settle,
        TurnSettle::Aborted,
        "the fallback classifies the swallowed settle as the honest abort"
    );
}

/// `DoneAborted` with no engine `agent_end` (the pre-run abort, or a run a compaction or
/// tree move detached): the fallback still closes the delivery's `agent_start`.
#[tokio::test]
async fn an_aborted_settle_closes_the_run() {
    for suppress_aborted_row in [false, true] {
        let events =
            gate_sighting_events(vec![EngineEvent::DoneAborted], true, suppress_aborted_row).await;
        assert_eq!(
            positions_of(&events, "agent_end").len(),
            1,
            "the aborted settle pairs the opening agent_start: {events:?}"
        );
    }
}

/// A later run of the same delivery (a retry or continuation) whose end never
/// reaches the wire still gets the fallback closer, after the earlier run's own end.
#[tokio::test]
async fn a_later_run_without_its_end_still_gets_the_fallback_closer() {
    let events = gate_sighting_events(
        vec![
            EngineEvent::AgentEnd {
                messages: Vec::new(),
            },
            EngineEvent::AgentStart,
            EngineEvent::Done(Ok(())),
        ],
        false,
        false,
    )
    .await;
    let starts = positions_of(&events, "agent_start");
    let ends = positions_of(&events, "agent_end");
    assert_eq!(ends.len(), 2, "both runs close: {events:?}");
    assert!(
        ends[1] > *starts.last().unwrap(),
        "the closer follows the later run's start: {events:?}"
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
                Lane::Steering,
                vec![QueuedItem {
                    priority: QueuePriority::Human,
                    preview: None,
                    message: "aborted".to_string(),
                    custom_message: None,
                    agent_message: None,
                    queue_key: None,
                    admission_id: None,
                    client_admission_id: None,
                    images: Vec::new(),
                    done: None,
                    queue_visible: true,
                    policy: TurnPolicy::Queued,
                    forced_batch: false,
                    kernel_notice: false,
                    delivery_scoped: false,
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
            Lane::Steering,
            vec![QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "tools".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                client_admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
                kernel_notice: false,
                delivery_scoped: false,
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
/// `suppress_aborted_row` is set; the fallback still closes the run.
#[tokio::test]
async fn the_suppressed_row_sighting_drops_the_settle_frame() {
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
    assert_eq!(
        positions_of(&events, "agent_end").len(),
        1,
        "the fallback closes the detached run: {events:?}"
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
                Lane::Steering,
                vec![QueuedItem {
                    priority: QueuePriority::Human,
                    preview: None,
                    message: "probe".to_string(),
                    custom_message: None,
                    agent_message: None,
                    queue_key: None,
                    admission_id: None,
                    client_admission_id: None,
                    images: Vec::new(),
                    done: None,
                    queue_visible: true,
                    policy: TurnPolicy::Queued,
                    forced_batch: false,
                    kernel_notice: false,
                    delivery_scoped: false,
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
                Lane::Steering,
                vec![QueuedItem {
                    priority: QueuePriority::Human,
                    preview: None,
                    message: "go".to_string(),
                    custom_message: None,
                    agent_message: None,
                    queue_key: None,
                    admission_id: None,
                    client_admission_id: None,
                    images: Vec::new(),
                    done: None,
                    queue_visible: true,
                    policy: TurnPolicy::Queued,
                    forced_batch: false,
                    kernel_notice: false,
                    delivery_scoped: false,
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

/// The pickup-identity probes' engine: the goal driver's turn-end mint
/// of the next continuation runs at the REAL pickup's running
/// identities (the real `admit_goal_follow_up` reads them under the
/// core lock mid-turn), and the probe records the minted row's stamp
/// before the turn ends — the identity every later turn of that loop
/// carries, and the A2A consumer (`a2a::events`) resolves runs by.
#[derive(Default)]
struct PickupIdentityEngine {
    core: Mutex<Option<Arc<Mutex<SessionCore>>>>,
    observed: Mutex<Vec<Option<String>>>,
    minted_injected: Mutex<Vec<bool>>,
}

impl SessionEngine for PickupIdentityEngine {
    fn run_prompt(
        &self,
        _index: usize,
        _request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        let core = self.core.lock().unwrap().clone().unwrap();
        admit_goal_follow_up(
            &std::sync::Mutex::new(None),
            &core,
            &Arc::new(EventPump::new()),
            &Arc::new(Notify::new()),
            crate::engine::GoalTurnEndWork::Continuation(crate::engine::GoalContinuation {
                request: PromptRequest {
                    batch: vec![],
                    message: "the next goal continuation".into(),
                    images: vec![],
                    source: "user".into(),
                    agent_message_id: None,
                    custom_message: None,
                },
                goal_update: None,
                pending_handle: None,
            }),
        );
        {
            let mut guard = core.lock().unwrap();
            let minted = guard.follow_up.back().expect("the minted continuation");
            self.observed
                .lock()
                .unwrap()
                .push(minted.client_admission_id.clone());
            self.minted_injected
                .lock()
                .unwrap()
                .push(crate::worker::is_injected_prompt_item(minted));
            guard.follow_up.clear();
            guard.steering.clear();
            guard.shutdown_requested = true;
        }
        emit(EngineEvent::Done(Ok(())));
    }
    fn run_side_question(
        &self,
        request: SideQuestionRequest,
        signal: &pa_agent::abort::AbortSignal,
        sink: &pa_core::session_engine::side_question::SideQuestionSink,
    ) -> SideQuestionOutcome {
        GateProbeEngine::default().run_side_question(request, signal, sink)
    }
    fn run_compaction(
        &self,
        request: CompactionRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        GateProbeEngine::default().run_compaction(request, signal)
    }
    fn run_branch_summary(
        &self,
        request: crate::engine::BranchSummaryRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::BranchSummaryOutcome {
        GateProbeEngine::default().run_branch_summary(request, signal)
    }
    fn rebuild_session_context(
        &self,
        branch: Vec<pa_types::session::FileEntry>,
        reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        GateProbeEngine::default().rebuild_session_context(branch, reload)
    }
}

/// One queued row shaped exactly as its producer builds it.
fn pickup_probe_row(
    custom_message: Option<Value>,
    client_admission_id: Option<String>,
) -> QueuedItem {
    QueuedItem {
        message: match custom_message {
            Some(ref row) => row
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("child finished")
                .to_string(),
            None => "a queued prompt".to_string(),
        },
        priority: if custom_message.is_some() {
            QueuePriority::Background
        } else {
            QueuePriority::Human
        },
        preview: None,
        custom_message,
        agent_message: None,
        queue_key: None,
        admission_id: None,
        client_admission_id,
        images: vec![],
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
        kernel_notice: false,
        delivery_scoped: false,
    }
}

/// The stamped RLM child terminal notice (children spawned by a
/// running delivery — the daemon stamps the spawning delivery's id on
/// the notice row) runs as the delivery's OWN continuation: the run
/// anchor tags `engineContinuation` beside the delivery's
/// `clientAdmissionId`, and the goal continuation owed behind the
/// children mints at that turn's end with the SAME stamp — the
/// consumer credits the notice turn and every later turn of the loop
/// to the waiting task, and a withdrawal of the id stops the loop.
#[tokio::test]
async fn a_stamped_child_notice_runs_as_the_deliverys_own_continuation() {
    let engine = Arc::new(PickupIdentityEngine::default());
    let runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
    *engine.core.lock().unwrap() = Some(Arc::clone(&runner.core));
    let mut subscription = runner.events.subscribe();
    runner
        .core
        .lock()
        .unwrap()
        .follow_up
        .push_back(pickup_probe_row(
            Some(serde_json::json!({
                "role": "custom",
                "customType": pa_core::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
                "content": "child finished",
                "display": true,
                "timestamp": 0
            })),
            Some("task-1".to_string()),
        ));
    tokio::time::timeout(std::time::Duration::from_secs(10), runner.run())
        .await
        .expect("the runner drains the notice turn");
    let observed = engine.observed.lock().unwrap().clone();
    let mut starts = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type == "session_event" {
            if let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) {
                if outbound["event"]["type"] == "agent_start" {
                    starts.push(outbound["event"].clone());
                }
            }
        }
    }
    assert_eq!(starts.len(), 1, "the notice turn is one run: {starts:?}");
    assert_eq!(
        starts[0]["clientAdmissionId"], "task-1",
        "the notice run names the spawning delivery: {starts:?}"
    );
    assert_eq!(
        starts[0]["engineContinuation"], true,
        "the notice run is the delivery's own continuation: {starts:?}"
    );
    assert_eq!(
        observed,
        vec![Some("task-1".to_string())],
        "the goal continuation owed behind the children carries the same stamp: {observed:?}"
    );
}

/// The RLM child terminal notice is the session's own internal row (a
/// daemon-provenance custom row the notice capability admits): its
/// pickup NEVER mints a worker-admission identity, so the goal
/// continuation owed behind the children mints at that turn's end as
/// the session's own work — unstamped — and the loop's later turns
/// credit to the waiting task instead of a fresh mint naming a
/// delivery no task owns (the consumer would refuse every one of
/// them and the task would settle with its pre-children text while
/// reporting success).
#[tokio::test]
async fn an_rlm_notice_turns_owed_goal_mint_stays_session_owned() {
    let engine = Arc::new(PickupIdentityEngine::default());
    let runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
    *engine.core.lock().unwrap() = Some(Arc::clone(&runner.core));
    runner
        .core
        .lock()
        .unwrap()
        .follow_up
        .push_back(pickup_probe_row(
            Some(serde_json::json!({
                "role": "custom",
                "customType": pa_core::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
                "content": "child finished",
                "display": true,
                "timestamp": 0
            })),
            None,
        ));
    tokio::time::timeout(std::time::Duration::from_secs(10), runner.run())
        .await
        .expect("the runner drains the notice turn");
    let observed = engine.observed.lock().unwrap().clone();
    assert_eq!(
        observed,
        vec![None],
        "the goal loop owed behind the session's own RLM children stays session-owned: {observed:?}"
    );
}

/// The session's own idle-minted goal continuation (the
/// owed-continuation retry that delivers while no delivery runs, so
/// its row is unstamped) keeps its whole chain session-owned through
/// the real pickup: no worker-admission mint names the loop's next
/// continuation either, so the consumer credits each turn of the
/// loop to the waiting task.
#[tokio::test]
async fn an_idle_minted_goal_chain_stays_session_owned_through_the_real_pickup() {
    let engine = Arc::new(PickupIdentityEngine::default());
    let runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
    *engine.core.lock().unwrap() = Some(Arc::clone(&runner.core));
    // The idle mint: the real producer on an idle core (the settle
    // cleared the running identities; the owed-continuation retry
    // mints after the descendants settle).
    admit_goal_follow_up(
        &std::sync::Mutex::new(None),
        &runner.core,
        &Arc::new(EventPump::new()),
        &Arc::new(Notify::new()),
        crate::engine::GoalTurnEndWork::Continuation(crate::engine::GoalContinuation {
            request: PromptRequest {
                batch: vec![],
                message: "goal continuation 1".into(),
                images: vec![],
                source: "user".into(),
                agent_message_id: None,
                custom_message: None,
            },
            goal_update: None,
            pending_handle: None,
        }),
    );
    {
        let core = runner.core.lock().unwrap();
        let row = core.follow_up.front().expect("the idle-minted row");
        assert!(
            row.client_admission_id.is_none() && row.admission_id.is_none(),
            "the idle mint is unstamped (session-owned): {row:?}"
        );
    }
    tokio::time::timeout(std::time::Duration::from_secs(10), runner.run())
        .await
        .expect("the runner drains the continuation turn");
    let observed = engine.observed.lock().unwrap().clone();
    assert_eq!(
        observed,
        vec![None],
        "the session's own continuation chain stays unstamped through the real pickup: {observed:?}"
    );
}

/// A plain daemon delivery (the TUI's and every plain client's shape)
/// still names its minted continuations through the REAL runner: the
/// supervisor assigns plain prompts NO wire id, so the runner's pickup
/// MINTS one (the identity fallback), and the minted goal row carries
/// it. The stamp is what an event consumer needs — an unstamped engine
/// continuation carries no proof of ownership at all, and a consumer
/// that credits it to whatever task happens to be waiting credits a
/// foreign prompt's own goal loop to that task. Driven through
/// `TurnRunner::run` on both lanes, never a copy of the pickup's field
/// assignments: the pickup's mint is the behavior under test.
#[tokio::test]
async fn a_plain_deliverys_minted_continuation_carries_its_wire_admission() {
    for lane in [Lane::Steering, Lane::FollowUp] {
        let engine = Arc::new(PickupIdentityEngine::default());
        let runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
        *engine.core.lock().unwrap() = Some(Arc::clone(&runner.core));
        let item = pickup_probe_row(None, None);
        {
            let mut core = runner.core.lock().unwrap();
            match lane {
                Lane::Steering => core.steering.push_back(item),
                Lane::FollowUp => core.follow_up.push_back(item),
            }
        }
        tokio::time::timeout(std::time::Duration::from_secs(10), runner.run())
            .await
            .expect("the runner drains the plain delivery's turn");
        let observed = engine.observed.lock().unwrap().clone();
        let minted_injected = engine.minted_injected.lock().unwrap().clone();
        assert!(
            observed.len() == 1
                && observed[0]
                    .as_deref()
                    .is_some_and(|owner| owner.starts_with("worker-admission:")),
            "the real pickup stamps the plain delivery's goal with its minted wire id ({lane:?}): {observed:?}"
        );
        assert_eq!(
            minted_injected,
            vec![true],
            "the minted row is still the engine's own injected continuation"
        );
    }
}

/// A turn that ends FAILED or ABORTED removes no queued row naming its
/// own delivery: the failed-turn sweep the A2A taskId continuation
/// once needed went with the continuation (every continuation answers
/// -32004 before it ever queues, and a failed turn mints none), so a
/// row the delivery still names stays for the runner's next pickup —
/// the failed turn's unwind never withdraws its conversation's queued
/// work (the sweep's reintroduction would delete it).
#[tokio::test]
async fn a_failed_turn_keeps_the_deliverys_queued_row() {
    let engine = Arc::new(GateProbeEngine {
        frames: vec![EngineEvent::Done(Err("provider failed".into()))],
        ..GateProbeEngine::default()
    });
    let dynamic: Arc<dyn SessionEngine> = engine.clone();
    let runner = burst_runner(Arc::clone(&dynamic));
    let running = pickup_probe_row(None, Some("own-delivery".to_string()));
    let mut queued_behind = pickup_probe_row(None, Some("own-delivery".to_string()));
    queued_behind.message = "the delivery's own queued row".to_string();
    {
        let mut core = runner.core.lock().unwrap();
        core.running_client_admissions
            .push("own-delivery".to_string());
        core.follow_up.push_back(queued_behind);
    }
    runner
        .run_turn(dynamic, Lane::FollowUp, vec![running])
        .await;
    let queued: Vec<String> = runner
        .core
        .lock()
        .unwrap()
        .follow_up
        .iter()
        .map(|item| item.message.clone())
        .collect();
    assert_eq!(
        queued,
        vec!["the delivery's own queued row".to_string()],
        "a failed turn keeps the queued row its delivery named"
    );
}

/// The busy-admission class the kernel-notice lane pins run under: the
/// session's state at the real producer's admission.
enum NoticeAdmission {
    /// The notice lands while a turn runs: the visible, queued shape.
    BusySession,
    /// The notice wakes an idle session: the invisible, injected shape.
    IdleSession,
}

/// A kernel notice admitted through the REAL `admit_kernel_notice`
/// producer runs as the session's own continuation on an idle AND a
/// busy session alike: the producer flags the row's provenance (the
/// flag, never the busy-dependent policy — a busy notice queues
/// visibly like a client's steer, but it is the session's own work),
/// so its run carries the `engineContinuation` tag — an A2A task cut
/// by a mid-turn `[bash-done]` credits the notice turn's continuation
/// instead of settling truncated — and the pickup mints no
/// worker-admission id, so the goal loop owed behind the notice stays
/// session-owned (a mint would stamp an id no waiting task owns and
/// the consumer would refuse every later turn of the loop as foreign).
async fn kernel_notice_turn(admission: NoticeAdmission) {
    let busy = matches!(admission, NoticeAdmission::BusySession);
    let engine = Arc::new(PickupIdentityEngine::default());
    let runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
    *engine.core.lock().unwrap() = Some(Arc::clone(&runner.core));
    let mut subscription = runner.events.subscribe();
    runner.core.lock().unwrap().busy = busy;
    admit_kernel_notice(
        &std::sync::Mutex::new(None),
        &runner.core,
        &Arc::new(Notify::new()),
        crate::engine::KernelNotice::bash_completion(4321, "sleep 3; echo done", 0),
        || false,
    );
    {
        let mut core = runner.core.lock().unwrap();
        let row = core.steering.front().expect("the admitted notice row");
        assert!(
            crate::worker::is_kernel_notice_item(row),
            "the producer flags its row (busy={busy}): {row:?}"
        );
        assert_eq!(
            (row.policy, row.queue_visible),
            if busy {
                (TurnPolicy::Queued, true)
            } else {
                (TurnPolicy::Injected, false)
            },
            "the busy and idle shapes stay what the producer admits: {row:?}"
        );
        core.busy = false;
    }
    tokio::time::timeout(std::time::Duration::from_secs(10), runner.run())
        .await
        .expect("the runner drains the notice turn");
    let mut starts = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type == "session_event" {
            if let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) {
                if outbound["event"]["type"] == "agent_start" {
                    starts.push(outbound["event"].clone());
                }
            }
        }
    }
    let observed = engine.observed.lock().unwrap().clone();
    assert_eq!(
        starts.len(),
        1,
        "the notice turn is one run (busy={busy}): {starts:?}"
    );
    assert_eq!(
        starts[0]["engineContinuation"], true,
        "the session's own kernel notice runs as its continuation (busy={busy}): {starts:?}"
    );
    assert_eq!(
        observed,
        vec![None],
        "the goal loop owed behind the session's own kernel notice stays session-owned (busy={busy}): {observed:?}"
    );
}

/// The busy-admitted kernel notice: the visible, queued shape the
/// mid-turn `[bash-done]` lands as.
#[tokio::test]
async fn a_busy_kernel_notice_runs_as_the_sessions_own_continuation() {
    kernel_notice_turn(NoticeAdmission::BusySession).await;
}

/// The idle control: the same producer, the invisible injected shape
/// the class already held.
#[tokio::test]
async fn an_idle_kernel_notice_runs_as_the_sessions_own_continuation() {
    kernel_notice_turn(NoticeAdmission::IdleSession).await;
}

/// A kernel bash completion carries its CREATING delivery's identity:
/// the launch-time binding (the pid the runtime reported at the launch,
/// recorded while that delivery's turn ran) resolves at the admission,
/// so the notice turn runs as that delivery's own continuation — its
/// frames credit to the delivery's task and an identity-scoped
/// withdrawal aborts it — while a launch that left no binding (an
/// internal continuation's bash, a worker restart) keeps the
/// session-owned unstamped class.
#[tokio::test]
async fn a_kernel_bash_notice_carries_its_creating_delivery() {
    let engine = Arc::new(PickupIdentityEngine::default());
    let runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
    let core = Arc::clone(&runner.core);
    {
        let mut guard = core.lock().unwrap();
        crate::worker::record_kernel_bash_creator(&mut guard, 4321, "task-own".into());
    }
    admit_kernel_notice(
        &std::sync::Mutex::new(None),
        &core,
        &Arc::new(Notify::new()),
        crate::engine::KernelNotice::bash_completion(4321, "sleep 3; echo own", 0),
        || false,
    );
    let bound_creator = {
        let guard = core.lock().unwrap();
        let bound = guard.steering.front().expect("the admitted notice row");
        assert_eq!(
            bound.client_admission_id.as_deref(),
            Some("task-own"),
            "the completion row names its creating delivery: {bound:?}"
        );
        bound.client_admission_id.clone()
    };
    assert_eq!(bound_creator.as_deref(), Some("task-own"));
    // The binding leaves with its use: a second notice for the same pid
    // (a replayed row) and an unbound pid both stay session-owned.
    admit_kernel_notice(
        &std::sync::Mutex::new(None),
        &core,
        &Arc::new(Notify::new()),
        crate::engine::KernelNotice::bash_completion(4321, "sleep 3; echo own", 0),
        || false,
    );
    admit_kernel_notice(
        &std::sync::Mutex::new(None),
        &core,
        &Arc::new(Notify::new()),
        crate::engine::KernelNotice::bash_completion(9999, "untracked launch", 0),
        || false,
    );
    let later: Vec<_> = core
        .lock()
        .unwrap()
        .steering
        .iter()
        .skip(1)
        .map(|row| row.client_admission_id.clone())
        .collect();
    assert_eq!(
        later,
        vec![None, None],
        "the consumed binding stamps no replay and an unbound launch stays session-owned"
    );
}
