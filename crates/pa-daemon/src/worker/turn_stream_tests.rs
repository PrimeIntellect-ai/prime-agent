//! The turn runner's stream tests (moved with the turn concern).
use super::*;
use crate::engine::{
    CompactionOutcome, CompactionRequest, PromptRequest, SessionEngine, SideQuestionOutcome,
    SideQuestionRequest,
};

/// One scripted turn that streams `deltas` partial-message updates
/// (one full-snapshot `message_update` frame per provider delta, the
/// wire shape a fast provider produces on a big turn) and settles
/// with one final assistant message. `spacing_ms` paces the deltas so
/// the flusher tick can interleave (the realistic case: a provider
/// that outruns 20 updates/second).
struct BurstStreamEngine {
    deltas: usize,
    spacing_ms: u64,
}

impl BurstStreamEngine {
    fn message_with(text: &str) -> Value {
        json!({
            "role": "assistant",
            "provider": "faux",
            "model": "faux-1",
            "content": [{ "type": "text", "text": text }],
        })
    }

    fn delta_text(&self, index: usize) -> String {
        "x".repeat((index + 1) * 4)
    }

    fn full_text(&self) -> String {
        self.delta_text(self.deltas)
    }
}

/// A turn that settles without a model turn (the session-command /
/// pre-model-failure shape): only the trailing `Done` reaches the
/// worker, so the run closes on the bare fallback frames.
struct DoneOnlyEngine;

impl SessionEngine for DoneOnlyEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        _request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        emit(EngineEvent::Done(Ok(())));
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

impl SessionEngine for BurstStreamEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        _request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        for index in 0..=self.deltas {
            let message = Self::message_with(&self.delta_text(index));
            let stream_event = if index == 0 {
                json!({ "type": "start" })
            } else {
                json!({ "type": "text_delta", "delta": "xxxx" })
            };
            if !emit(EngineEvent::AssistantUpdate {
                message,
                stream_event: Some(stream_event),
            }) {
                return;
            }
            if self.spacing_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(self.spacing_ms));
            }
        }
        if !emit(EngineEvent::AssistantMessage(Self::message_with(
            &self.full_text(),
        ))) {
            return;
        }
        emit(EngineEvent::Done(Ok(())));
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
        last_action_snapshot: Some(SessionActionSnapshot::default()),
        rlm_depth: 0,
        runtime_kind: "top-level".to_string(),
        rlm_child_id: None,
        parent_active_session_id: None,
        parent_session_id: None,
        child_script: None,
        service_tier: None,
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
    }
}

/// Run one scripted turn and return its session-event frames in wire
/// order.
/// The suspension parks the turn runner (TS `_scheduleSessionInputPump`
/// refuses while `_sessionInputPumpSuspended`): a queued steering item
/// survives undelivered until the flag clears, then runs.
#[tokio::test]
async fn suspended_runner_parks_a_queued_item_until_resumed() {
    let engine = ScriptedEngine::default();
    let runner = burst_runner(Arc::new(engine));
    let (done_tx, mut done_rx) = oneshot::channel();
    {
        let mut core = runner.core.lock().unwrap();
        core.queued_input_suspended = true;
        core.steering.push_back(QueuedItem {
            priority: QueuePriority::Human,
            preview: None,
            message: "parked steer".to_string(),
            custom_message: None,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: Some(done_tx),
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        });
    }
    let parked = std::sync::Arc::clone(&runner.core);
    let work_notify = std::sync::Arc::clone(&runner.work_notify);
    let running = tokio::spawn(async move { runner.run().await });
    // The runner idles through the suspension window without
    // starting the queued turn.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    {
        let core = parked.lock().unwrap();
        assert!(!core.busy, "the runner started a turn while suspended");
        assert_eq!(
            core.steering.len(),
            1,
            "the queued item was consumed while suspended"
        );
    }
    // A resume site clears the flag and wakes the runner: the parked
    // turn completes.
    {
        let mut core = parked.lock().unwrap();
        core.queued_input_suspended = false;
    }
    work_notify.notify_one();
    let done = tokio::time::timeout(std::time::Duration::from_secs(5), &mut done_rx).await;
    assert!(done.is_ok(), "the parked turn never ran after resume");
    running.abort();
}

/// The session-event frames off the runner's event pump (the same
/// wire shape the outer tests' `session_events_since` collects).
fn runner_events(
    subscription: &mut tokio::sync::broadcast::Receiver<Arc<OutboundFrame>>,
) -> Vec<Value> {
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

/// A queued plain-prompt item for the pump tests.
fn queued_prompt(message: &str, policy: TurnPolicy) -> QueuedItem {
    QueuedItem {
        priority: QueuePriority::Human,
        preview: None,
        message: message.to_string(),
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: None,
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy,
        forced_batch: false,
    }
}

/// Run the pump until both lanes drain (the runner keeps idling; the
/// task is aborted by the test's end).
async fn drain_pump(core: &Arc<Mutex<SessionCore>>, work_notify: &Arc<Notify>) {
    work_notify.notify_one();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        {
            let core = core.lock().unwrap();
            let drained = core.steering.is_empty() && core.follow_up.is_empty() && !core.busy;
            if drained {
                return;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the pump never drained the lanes"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// The settled user/assistant rows of the session events, in wire
/// order (the `message_end` frames; the scripted engine carries the
/// text as a plain string content, the real engine as content parts).
fn delivered_rows(events: &[Value]) -> Vec<(String, String)> {
    events
        .iter()
        .filter_map(|event| {
            if event.get("type").and_then(Value::as_str) != Some("message_end") {
                return None;
            }
            let message = event.get("message")?;
            let row_role = message.get("role").and_then(Value::as_str)?.to_string();
            let content = message.get("content")?;
            let text = content
                .as_str()
                .map(str::to_string)
                .or_else(|| {
                    content
                        .as_array()
                        .and_then(|parts| parts.first())
                        .and_then(|part| part.get("text"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .or_else(|| {
                    content
                        .as_array()
                        .and_then(|parts| {
                            parts.iter().find(|part| {
                                part.get("type").and_then(Value::as_str) == Some("text")
                            })
                        })
                        .and_then(|part| part.get("text"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })?;
            Some((row_role, text))
        })
        .collect()
}

/// TS `_pumpSessionInputs` under queue mode "all"
/// (`turnExecutionPoliciesEqual` + the mode gate): the same-lane
/// same-class prefix co-delivers as ONE batched turn — one
/// `agent_start`/`turn_start` pair, every user row in delivery order,
/// one assistant reply for the whole batch.
#[tokio::test]
async fn steering_mode_all_batches_the_queued_prefix_into_one_turn() {
    let engine: Arc<dyn SessionEngine> = Arc::new(
        ScriptedEngine::from_value(json!({ "responses": ["batched reply"] })).unwrap_or_default(),
    );
    let runner = burst_runner(Arc::clone(&engine));
    {
        let mut core = runner.core.lock().unwrap();
        core.steering_mode = "all".to_string();
        core.steering
            .push_back(queued_prompt("steer one", TurnPolicy::Queued));
        core.steering
            .push_back(queued_prompt("steer two", TurnPolicy::Queued));
        core.steering
            .push_back(queued_prompt("steer three", TurnPolicy::Queued));
    }
    let mut subscription = runner.events.subscribe();
    let core = std::sync::Arc::clone(&runner.core);
    let work_notify = std::sync::Arc::clone(&runner.work_notify);
    let running = tokio::spawn(async move { runner.run().await });
    drain_pump(&core, &work_notify).await;
    running.abort();

    let events = runner_events(&mut subscription);
    let starts = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
        .count();
    let turn_starts = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("turn_start"))
        .count();
    assert_eq!(starts, 1, "one agent_start for the whole batch");
    assert_eq!(turn_starts, 1, "one turn_start for the whole batch");
    let rows = delivered_rows(&events);
    assert_eq!(
        rows,
        vec![
            ("user".to_string(), "steer one".to_string()),
            ("user".to_string(), "steer two".to_string()),
            ("user".to_string(), "steer three".to_string()),
            ("assistant".to_string(), "batched reply".to_string()),
        ],
        "the batched prefix delivered as one turn: {rows:?}"
    );
}

/// The product default: with no explicit mode set, the steering
/// lane co-delivers the queued same-class prefix as ONE batched turn
/// at the boundary.
#[tokio::test]
async fn the_default_mode_co_delivers_the_queued_steering_prefix() {
    let engine: Arc<dyn SessionEngine> = Arc::new(
        ScriptedEngine::from_value(json!({ "responses": ["batched reply"] })).unwrap_or_default(),
    );
    let runner = burst_runner(Arc::clone(&engine));
    {
        let mut core = runner.core.lock().unwrap();
        assert_eq!(core.steering_mode, "all", "the default is the batched mode");
        core.steering
            .push_back(queued_prompt("steer one", TurnPolicy::Queued));
        core.steering
            .push_back(queued_prompt("steer two", TurnPolicy::Queued));
        core.steering
            .push_back(queued_prompt("steer three", TurnPolicy::Queued));
    }
    let mut subscription = runner.events.subscribe();
    let core = std::sync::Arc::clone(&runner.core);
    let work_notify = std::sync::Arc::clone(&runner.work_notify);
    let running = tokio::spawn(async move { runner.run().await });
    drain_pump(&core, &work_notify).await;
    running.abort();

    let events = runner_events(&mut subscription);
    let starts = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
        .count();
    assert_eq!(
        starts, 1,
        "the default batches the whole prefix: {events:?}"
    );
    let rows = delivered_rows(&events);
    assert_eq!(
        rows,
        vec![
            ("user".to_string(), "steer one".to_string()),
            ("user".to_string(), "steer two".to_string()),
            ("user".to_string(), "steer three".to_string()),
            ("assistant".to_string(), "batched reply".to_string()),
        ],
        "the default mode co-delivers every parked steer: {rows:?}"
    );
}

/// Queue mode "one-at-a-time" (selectable via the `steeringMode`
/// setting; the product default is "all"): each queued steer is its
/// own turn — one reply each, delivered in order.
#[tokio::test]
async fn one_at_a_time_delivers_each_queued_steer_as_its_own_turn() {
    // The burst harness has no session store, so the scripted engine
    // serves its first response for EVERY turn (prompt_index stays
    // 0): the turns are discriminated by the agent_start count and
    // the user-row order, not the reply text.
    let engine: Arc<dyn SessionEngine> = Arc::new(
        ScriptedEngine::from_value(json!({ "responses": ["settled reply"] })).unwrap_or_default(),
    );
    let runner = burst_runner(Arc::clone(&engine));
    {
        let mut core = runner.core.lock().unwrap();
        core.steering_mode = "one-at-a-time".to_string();
        core.steering
            .push_back(queued_prompt("steer one", TurnPolicy::Queued));
        core.steering
            .push_back(queued_prompt("steer two", TurnPolicy::Queued));
    }
    let mut subscription = runner.events.subscribe();
    let core = std::sync::Arc::clone(&runner.core);
    let work_notify = std::sync::Arc::clone(&runner.work_notify);
    let running = tokio::spawn(async move { runner.run().await });
    drain_pump(&core, &work_notify).await;
    running.abort();

    let events = runner_events(&mut subscription);
    let starts = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
        .count();
    assert_eq!(starts, 2, "one agent_start per steer: {events:?}");
    let rows = delivered_rows(&events);
    assert_eq!(
        rows,
        vec![
            ("user".to_string(), "steer one".to_string()),
            ("assistant".to_string(), "settled reply".to_string()),
            ("user".to_string(), "steer two".to_string()),
            ("assistant".to_string(), "settled reply".to_string()),
        ],
        "one-at-a-time delivers in order, one turn each: {rows:?}"
    );
}

/// The forced steering batch (TS `abortAndSendQueued`'s
/// `_forcedAllSteeringActionIds`): the armed prefix co-delivers as ONE
/// turn even under queue mode "one-at-a-time" (pinned explicitly —
/// the product default is "all"); an item queued after the arm stays
/// out of the batch and delivers next.
#[tokio::test]
async fn forced_batch_delivers_the_armed_prefix_as_one_turn() {
    // (The burst harness serves the first scripted response for every
    // turn — see one_at_a_time above.)
    let engine: Arc<dyn SessionEngine> = Arc::new(
        ScriptedEngine::from_value(json!({ "responses": ["batch reply"] })).unwrap_or_default(),
    );
    let runner = burst_runner(Arc::clone(&engine));
    {
        let mut core = runner.core.lock().unwrap();
        core.steering_mode = "one-at-a-time".to_string();
        core.steering
            .push_back(queued_prompt("armed one", TurnPolicy::Queued));
        core.steering
            .push_back(queued_prompt("armed two", TurnPolicy::Queued));
        core.forced_all_steering = true;
        for item in core.steering.iter_mut() {
            item.forced_batch = true;
        }
        // An un-armed steer queued behind the armed prefix (a steer
        // that arrived after the abort): it never joins the batch.
        core.steering
            .push_back(queued_prompt("late steer", TurnPolicy::Queued));
    }
    let mut subscription = runner.events.subscribe();
    let core = std::sync::Arc::clone(&runner.core);
    let work_notify = std::sync::Arc::clone(&runner.work_notify);
    let running = tokio::spawn(async move { runner.run().await });
    drain_pump(&core, &work_notify).await;
    running.abort();

    let events = runner_events(&mut subscription);
    let starts = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
        .count();
    assert_eq!(
        starts, 2,
        "the armed batch runs as one turn, the late steer its own"
    );
    let rows = delivered_rows(&events);
    assert_eq!(
        rows,
        vec![
            ("user".to_string(), "armed one".to_string()),
            ("user".to_string(), "armed two".to_string()),
            ("assistant".to_string(), "batch reply".to_string()),
            ("user".to_string(), "late steer".to_string()),
            ("assistant".to_string(), "batch reply".to_string()),
        ],
        "the armed prefix batched; the late steer never joined: {rows:?}"
    );
}

/// TS `turnExecutionPoliciesEqual`: mode "all" never batches across
/// turn-execution classes — a client steer and an injected heartbeat
/// row deliver as separate turns even under "all".
#[tokio::test]
async fn mode_all_never_batches_across_policy_classes() {
    // (The burst harness serves the first scripted response for every
    // turn — see one_at_a_time above.)
    let engine: Arc<dyn SessionEngine> = Arc::new(
        ScriptedEngine::from_value(json!({ "responses": ["lane reply"] })).unwrap_or_default(),
    );
    let runner = burst_runner(Arc::clone(&engine));
    {
        let mut core = runner.core.lock().unwrap();
        core.steering_mode = "all".to_string();
        core.steering
            .push_back(queued_prompt("client steer", TurnPolicy::Queued));
        core.steering
            .push_back(queued_prompt("nudge the mission", TurnPolicy::Injected));
    }
    let mut subscription = runner.events.subscribe();
    let core = std::sync::Arc::clone(&runner.core);
    let work_notify = std::sync::Arc::clone(&runner.work_notify);
    let running = tokio::spawn(async move { runner.run().await });
    drain_pump(&core, &work_notify).await;
    running.abort();

    let events = runner_events(&mut subscription);
    let starts = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
        .count();
    assert_eq!(starts, 2, "policy classes never share a turn");
    let rows = delivered_rows(&events);
    assert_eq!(
        rows,
        vec![
            ("user".to_string(), "client steer".to_string()),
            ("assistant".to_string(), "lane reply".to_string()),
            ("user".to_string(), "nudge the mission".to_string()),
            ("assistant".to_string(), "lane reply".to_string()),
        ],
        "each policy class delivered its own turn: {rows:?}"
    );
}

/// The follow-up lane batches under its own mode (TS `followUpMode`):
/// two queued follow-ups co-deliver as one turn with "all".
#[tokio::test]
async fn follow_up_mode_all_batches_the_follow_up_lane() {
    let engine: Arc<dyn SessionEngine> = Arc::new(
        ScriptedEngine::from_value(json!({ "responses": ["follow-up batch reply"] }))
            .unwrap_or_default(),
    );
    let runner = burst_runner(Arc::clone(&engine));
    {
        let mut core = runner.core.lock().unwrap();
        core.follow_up_mode = "all".to_string();
        core.follow_up
            .push_back(queued_prompt("follow up one", TurnPolicy::Queued));
        core.follow_up
            .push_back(queued_prompt("follow up two", TurnPolicy::Queued));
    }
    let mut subscription = runner.events.subscribe();
    let core = std::sync::Arc::clone(&runner.core);
    let work_notify = std::sync::Arc::clone(&runner.work_notify);
    let running = tokio::spawn(async move { runner.run().await });
    drain_pump(&core, &work_notify).await;
    running.abort();

    let events = runner_events(&mut subscription);
    let starts = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
        .count();
    assert_eq!(starts, 1, "the follow-up lane batched under mode all");
    let rows = delivered_rows(&events);
    assert_eq!(
        rows,
        vec![
            ("user".to_string(), "follow up one".to_string()),
            ("user".to_string(), "follow up two".to_string()),
            ("assistant".to_string(), "follow-up batch reply".to_string()),
        ],
        "the follow-up prefix batched into one turn: {rows:?}"
    );
}

/// Kevin's acceptance case (the multi-steer abort flow, TS
/// `abortAndSendQueued` + `interactive-mode.ts`'s Ctrl+C path): on the
/// abort of a streaming turn, ALL visible queued plain-user steering
/// messages send together as the next batched turn — the follow-up
/// lane stays queued behind it (never discarded, never merged), then
/// runs in order once the session goes idle; the arm co-delivers
/// under any mode (the product default is "all"), and the queue
/// parks only when the abort leaves nothing visible behind (the
/// plain-abort shape).
#[tokio::test]
#[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
async fn abort_and_send_queued_delivers_the_steering_batch_then_the_follow_ups() {
    let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("pa-worker-abort-send-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "abort-send-family".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({
            "engine": "faux",
            "responses": [
                { "text": "held reply", "delayMs": 600_000 },
                "batch reply",
                "follow-up reply"
            ],
        })),
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "abort-send-family" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let mut subscription = worker.events.subscribe();
    // The held turn parks the queue behind it (the 600s fetch hold).
    let prompt = worker
        .dispatch(
            "prompt",
            &json!({
                "activeSessionId": "abort-send-family",
                "message": "held turn for the batch abort",
            }),
        )
        .await;
    assert!(prompt.success, "prompt failed: {prompt:?}");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if worker.core.lock().unwrap().busy {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the held turn was never admitted"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    // Two steering messages and one follow-up behind the streaming
    // turn (the real wire admission path: queue-visible, policy-queued
    // rows).
    for message in ["steering one", "steering two"] {
        let steered = worker
            .dispatch("steer", &json!({ "message": message }))
            .await;
        assert!(steered.success, "steer failed: {steered:?}");
    }
    let follow = worker
        .dispatch(
            "follow_up",
            &json!({ "message": "follow up after the batch" }),
        )
        .await;
    assert!(follow.success, "follow_up failed: {follow:?}");
    // The funnel (the wire command's body — #2599's handler calls it):
    // arm the visible plain-user steering, abort the run, resume the
    // pump. The arm carries the batch under any mode; the default
    // itself is asserted below (the product default "all").
    let sent = worker.abort_and_send_queued();
    assert!(sent, "the armed steering batch sent with the abort");
    let idle = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        worker.dispatch("wait_for_idle", &json!({})),
    )
    .await;
    assert!(idle.is_ok(), "the session never went idle after the abort");
    assert!(idle.unwrap().success, "wait_for_idle failed");
    // The aborted turn's row + the batched steers + the follow-up, in
    // order: the two steers share ONE turn (one reply), the follow-up
    // runs after it as its own turn.
    let messages = worker.dispatch("get_messages", &json!({})).await;
    assert!(messages.success, "get_messages failed: {messages:?}");
    let wire_messages = messages
        .data
        .as_ref()
        .and_then(|data| data.get("messages"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let texts: Vec<String> = wire_messages
        .iter()
        .filter(|message| crate::types::message_role(message) == Some("user"))
        .map(crate::types::message_text)
        .collect();
    assert_eq!(
        texts,
        [
            "held turn for the batch abort",
            "steering one",
            "steering two",
            "follow up after the batch",
        ],
        "the steering batch sent as one turn; the follow-up ran after it: {texts:?}"
    );
    // The reply granularity: the aborted row, then ONE assistant
    // reply for the whole steering batch, then the follow-up's own
    // reply (never one per steer).
    let replies: Vec<String> = wire_messages
        .iter()
        .filter(|message| crate::types::message_role(message) == Some("assistant"))
        .map(crate::types::message_text)
        .collect();
    assert_eq!(
        replies.len(),
        3,
        "the aborted row, the batch's one reply, the follow-up's reply: {replies:?}"
    );
    assert_eq!(
        &replies[1..],
        &["batch reply".to_string(), "follow-up reply".to_string()],
        "one reply for the batch, one for the follow-up: {replies:?}"
    );
    // The wire frames: each batched user row broadcasts exactly once
    // (the accepted-row emission — never the engine's loop re-emission).
    let events = runner_events(&mut subscription);
    let wire_user_starts: Vec<String> = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("message_start"))
        .filter(|event| {
            let message = event.get("message").unwrap_or(&Value::Null);
            message.get("role").and_then(Value::as_str) == Some("user")
        })
        .filter_map(|event| {
            let message = event.get("message")?;
            let content = message.get("content")?;
            content
                .as_array()
                .and_then(|parts| parts.first())
                .and_then(|part| part.get("text"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    assert_eq!(
        wire_user_starts,
        vec![
            "held turn for the batch abort".to_string(),
            "steering one".to_string(),
            "steering two".to_string(),
            "follow up after the batch".to_string(),
        ],
        "every user row broadcast exactly once: {wire_user_starts:?}"
    );
    {
        let core = worker.core.lock().unwrap();
        assert!(
            core.steering.is_empty() && core.follow_up.is_empty(),
            "both lanes drained in order"
        );
        assert_eq!(
            core.steering_mode, "all",
            "the default mode is the batched-at-the-boundary product default"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// The abort's acknowledgment never waits for the queue's delivery:
/// with the aborted turn AND the queued follow-up's reply both held,
/// `abort_and_send_queued` answers immediately and the resumed pump
/// starts the follow-up's own turn behind the ack. A second, bare
/// `abort` (the API surface) then ends that turn cleanly, delivers
/// no duplicate of the follow-up's row, and parks the emptied queue
/// behind the suspension like the TS plain abort.
#[tokio::test]
#[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
async fn abort_and_send_queued_acks_before_the_follow_up_delivery() {
    let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("pa-worker-abort-ack-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "abort-ack-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({
            "engine": "faux",
            "responses": [
                { "text": "held reply", "delayMs": 60000 },
                { "text": "follow-up reply", "delayMs": 60000 },
            ],
        })),
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "abort-ack" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let prompt = worker
        .dispatch(
            "prompt",
            &json!({
                "activeSessionId": "abort-ack-session",
                "message": "held turn for the ack probe",
            }),
        )
        .await;
    assert!(prompt.success, "prompt failed: {prompt:?}");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if worker.core.lock().unwrap().busy {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the held turn was never admitted"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let follow = worker
        .dispatch("follow_up", &json!({ "message": "ack follow-up" }))
        .await;
    assert!(follow.success, "follow_up failed: {follow:?}");
    // The ack: the aborted turn's settle AND the follow-up's own
    // reply are both held, so a funnel that awaited the settle or
    // the delivery would never answer inside the bound.
    let aborted = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        worker.dispatch("abort_and_send_queued", &json!({})),
    )
    .await;
    assert!(
        aborted.is_ok(),
        "the abort ack never arrived while everything downstream was held"
    );
    let aborted = aborted.unwrap();
    assert!(aborted.success, "abort_and_send_queued failed: {aborted:?}");
    assert_eq!(aborted.command, "abort_and_send_queued");
    // The follow-up starts promptly behind the ack: its turn runs
    // (the paced reply holds it) and its row left the queue.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let (busy, queued) = {
            let core = worker.core.lock().unwrap();
            (core.busy, core.follow_up.len())
        };
        if busy && queued == 0 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the follow-up never started after the abort ack"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let messages = worker.dispatch("get_messages", &json!({})).await;
    assert!(messages.success, "get_messages failed: {messages:?}");
    let texts: Vec<String> = messages
        .data
        .as_ref()
        .and_then(|data| data.get("messages"))
        .and_then(Value::as_array)
        .map(|wire| {
            wire.iter()
                .filter(|message| crate::types::message_role(message) == Some("user"))
                .map(crate::types::message_text)
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        texts,
        [
            "held turn for the ack probe".to_string(),
            "ack follow-up".to_string()
        ],
        "the follow-up row must deliver exactly once: {texts:?}"
    );
    // The API abort surface: a bare `abort` ends the follow-up's
    // own turn cleanly and parks the emptied queue behind the
    // suspension (the TS plain-abort park the Ctrl+C funnel
    // deliberately does not take).
    let aborted_again = worker.dispatch("abort", &json!({})).await;
    assert!(
        aborted_again.success,
        "the bare abort failed: {aborted_again:?}"
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while worker.core.lock().unwrap().busy {
        assert!(
            std::time::Instant::now() < deadline,
            "the follow-up's turn never settled on the bare abort"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    {
        let core = worker.core.lock().unwrap();
        assert!(
            core.steering.is_empty() && core.follow_up.is_empty(),
            "the queue must stay drained"
        );
        assert!(
            core.queued_input_suspended,
            "the bare abort parks the queue behind the suspension"
        );
    }
    // The second abort ends the follow-up's turn — it never
    // re-delivers or duplicates the follow-up's row.
    let messages = worker.dispatch("get_messages", &json!({})).await;
    assert!(messages.success, "get_messages failed: {messages:?}");
    let texts: Vec<String> = messages
        .data
        .as_ref()
        .and_then(|data| data.get("messages"))
        .and_then(Value::as_array)
        .map(|wire| {
            wire.iter()
                .filter(|message| crate::types::message_role(message) == Some("user"))
                .map(crate::types::message_text)
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        texts,
        [
            "held turn for the ack probe".to_string(),
            "ack follow-up".to_string()
        ],
        "the follow-up row survived the bare abort exactly once: {texts:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The waiting prompt resolves only after the turn fully unwinds (TS
/// `promptAndWait` settles the completion after the whole turn settle):
/// the `done` waiter fires after the idle flip and the queue projection,
/// so a client's follow-up request never lands in the pre-idle window
/// where the suspension gate would queue it behind the suspension
/// instead of rejecting it (the f7 suspension sequence's post-abort
/// prompt hung exactly there).
#[tokio::test]
async fn the_waiting_prompt_resolves_only_after_the_turn_settles() {
    let engine: Arc<dyn SessionEngine> = Arc::new(
        ScriptedEngine::from_value(json!({ "responses": ["settled reply"] })).unwrap_or_default(),
    );
    let runner = burst_runner(Arc::clone(&engine));
    let (done_tx, mut done_rx) = oneshot::channel();
    let core = std::sync::Arc::clone(&runner.core);
    let turn = tokio::spawn(async move {
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
                    done: Some(done_tx),
                    queue_visible: true,
                    policy: TurnPolicy::Queued,
                    forced_batch: false,
                }],
            )
            .await;
    });
    let settled = tokio::time::timeout(std::time::Duration::from_secs(5), &mut done_rx).await;
    let outcome = settled
        .expect("the waiting prompt never resolved")
        .expect("the waiter sender dropped without an outcome");
    assert_eq!(
        outcome,
        TurnSettle::Completed,
        "the settled turn's outcome: {outcome:?}"
    );
    // The idle flip (and the queue projection after it) already
    // happened when the waiter resolved.
    {
        let core = core.lock().unwrap();
        assert!(!core.busy, "the waiter resolved before the idle flip");
    }
    turn.await.expect("the turn task panicked");
}

/// A fake supervisor link endpoint: every `worker_roster_delta`
/// command's summary is recorded in arrival order.
async fn fake_supervisor(
    socket: std::path::PathBuf,
) -> (Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let recorded = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = Arc::clone(&recorded);
    let server = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let sink = Arc::clone(&sink);
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
                let (reader, mut writer) = stream.into_split();
                writer
                    .write_all(b"{\"type\":\"daemon_hello\"}\n")
                    .await
                    .unwrap();
                let mut lines = BufReader::new(reader);
                loop {
                    let mut line = String::new();
                    if lines.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(request) = serde_json::from_str::<Value>(line.trim()) else {
                        continue;
                    };
                    sink.lock()
                        .unwrap()
                        .push(request["command"]["summary"].clone());
                    let response =
                        crate::protocol::response_line(&crate::protocol::response_success(
                            request["id"].as_str(),
                            "worker_roster_delta",
                            None,
                        ));
                    writer
                        .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                        .await
                        .unwrap();
                    writer.write_all(b"\n").await.unwrap();
                }
            });
        }
    });
    (recorded, server)
}

/// A turn runner whose roster pushes and activity watcher ship to a
/// live supervisor link (the burst runner keeps them disabled).
fn live_feed_runner(engine: Arc<dyn SessionEngine>, socket: std::path::PathBuf) -> TurnRunner {
    let core = Arc::new(Mutex::new(SessionCore::test_core(None, "/tmp".to_string())));
    let user_bash = Arc::new(crate::user_bash::UserBash::new());
    let events = Arc::new(EventPump::new());
    let roster_pushes =
        crate::roster_activity::RosterPushQueue::spawn(crate::worker::RosterPushContext {
            core: Arc::clone(&core),
            engine: std::sync::Arc::clone(&engine),
            user_bash,
            roster_link: Arc::new(crate::supervisor_link::SupervisorLink::new(socket)),
            worker_token: "token".to_string(),
            worker_instance_id: "instance".to_string(),
            roster_delta_sequence: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            roster_push_order: Arc::new(std::sync::Mutex::new(())),
        });
    crate::roster_activity::spawn_roster_activity_watch(Arc::clone(&events), roster_pushes.clone());
    TurnRunner {
        recovery: Arc::new(Mutex::new(None)),
        core,
        input_pauses: crate::session_input_pause::InputPauseTable::new(),
        prompt_admissions: crate::prompt_admission::WorkerAdmissions::new(),
        work_notify: Arc::new(Notify::new()),
        idle_notify: Arc::new(Notify::new()),
        events,
        engine,
        active_session_id: "feed-session".to_string(),
        roster_pushes,
    }
}

/// The waiting/executing indicator over the wire: a working session's
/// roster deltas carry live `isRunningTools` transitions while the
/// tool executes (mid-turn pushes, not a static turn-start snapshot)
/// and end idle once the turn settles (TS `observeRosterEvent` +
/// `ROSTER_SESSION_EVENT_TRIGGERS` + `scheduleRosterFlush`).
#[tokio::test]
async fn roster_feed_publishes_live_tool_activity() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    let (recorded, server) = fake_supervisor(socket.clone()).await;
    let engine: Arc<dyn SessionEngine> = Arc::new(
        ScriptedEngine::from_value(json!({
            "responses": [{
                "text": "ran the tool",
                "toolCalls": [{
                    "toolCallId": "call-1",
                    "toolName": "bash",
                    "args": { "command": "ls" },
                    "result": "listing",
                    "delayMs": 250,
                }],
            }],
        }))
        .unwrap_or_default(),
    );
    let runner = live_feed_runner(Arc::clone(&engine), socket);
    // The pickup's busy flip (the run loop's arm before `run_turn`).
    runner.core.lock().unwrap().busy = true;
    runner
        .run_turn(
            engine,
            vec![QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "run the tool".to_string(),
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
    // The settle push is in flight once the turn returns; the last
    // delta composes the idle state.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let settled = recorded
            .lock()
            .unwrap()
            .last()
            .is_some_and(|summary| summary["isStreaming"] == json!(false));
        if settled || std::time::Instant::now() > deadline {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let summaries = recorded.lock().unwrap().clone();
    let statuses = |key: &str| {
        summaries
            .iter()
            .filter(|summary| summary["isStreaming"] == json!(true))
            .any(|summary| summary[key] == json!(true))
    };
    assert!(
        statuses("isRunningTools"),
        "no mid-turn delta carried isRunningTools=true: {summaries:?}"
    );
    assert!(
        !summaries.is_empty(),
        "the worker never pushed a roster delta"
    );
    let last = summaries.last().cloned().unwrap_or(Value::Null);
    assert_eq!(
        last["isStreaming"],
        json!(false),
        "the settled worker's roster row must read idle (isRunningTools={}): {summaries:?}",
        last["isRunningTools"]
    );
    assert_eq!(
        last["isRunningTools"],
        json!(false),
        "an idle session cannot report tools in flight: {summaries:?}"
    );
    assert_eq!(
        last["activity"],
        json!("idle"),
        "the settled worker's activity is idle: {summaries:?}"
    );
    // The working turns' deltas carry the mid-turn flags.
    let working: Vec<&Value> = summaries
        .iter()
        .filter(|summary| summary["isStreaming"] == json!(true))
        .collect();
    assert!(
        working
            .iter()
            .any(|summary| summary["isRunningTools"] == json!(true)),
        "the tool execution never showed in the feed: {summaries:?}"
    );
    // The post-tool intermediate state (streaming, no tools in flight)
    // is not asserted: the coalescer may collapse it into the turn's
    // next flush — the feed's contract is the mid-tool live state and
    // the settled idle row, both asserted above.
    server.abort();
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

/// Run one scripted turn and return its session-event frames in wire
/// order, with the queued item carrying an injected custom row.
async fn turn_session_events_with_custom_message(
    engine: Arc<dyn SessionEngine>,
    custom_message: Value,
) -> Vec<Value> {
    let runner = burst_runner(Arc::clone(&engine));
    let mut subscription = runner.events.subscribe();
    runner
        .run_turn(
            engine,
            vec![QueuedItem {
                priority: QueuePriority::Background,
                preview: None,
                message: "[child-exited: no-reply child:lane]".to_string(),
                custom_message: Some(custom_message),
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Injected,
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

/// An injected custom row replaces the turn's user row: the wire carries
/// the custom message's `message_start`/`message_end` pair and no
/// user-message frame, while the model turn still runs on the notice
/// text (the RLM child terminal-notice path).
#[tokio::test]
async fn an_injected_custom_turn_replaces_the_user_row() {
    let engine = Arc::new(
        ScriptedEngine::from_value(json!({
            "responses": ["notice acknowledged"],
        }))
        .unwrap_or_default(),
    );
    let custom = json!({
        "role": "custom",
        "customType": "rlm_child_terminal_notice",
        "content": "[child-exited: no-reply child:lane]",
        "display": true,
        "details": {
            "kind": "completed_without_reply",
            "childId": "sub-1",
            "sessionName": "lane",
        },
    });
    let events = turn_session_events_with_custom_message(engine, custom).await;

    let starts = positions_of(&events, "message_start");
    let ends = positions_of(&events, "message_end");
    // The custom row opens as a message_start pair; the scripted
    // assistant reply opens as a `message_update` (the scripted
    // harness carries no provider `start` stream event), so exactly
    // one start is on the wire and both rows settle.
    assert_eq!(starts.len(), 1, "only the custom row opens a start");
    assert_eq!(
        ends.len(),
        2,
        "the custom row and the assistant reply settle"
    );
    // The first row is the custom notice, not a user message.
    assert_eq!(events[starts[0]]["message"]["role"], "custom");
    assert_eq!(
        events[starts[0]]["message"]["customType"],
        "rlm_child_terminal_notice"
    );
    // No user row was recorded for the turn.
    let user_rows = events.iter().any(|event| {
        event.get("type").and_then(Value::as_str) == Some("message_start")
            && event["message"]["role"] == "user"
    });
    assert!(!user_rows, "the injected turn must not emit a user row");
    // The model turn ran on the notice text and settled the reply
    // (the scripted engine carries the reply as a plain string).
    assert_eq!(events[ends[1]]["message"]["role"], "assistant");
    assert_eq!(events[ends[1]]["message"]["content"], "notice acknowledged");
}

/// A delivered agent message (the `worker_deliver_message` arm) runs
/// as its `agent_message` custom row: the accepted-row frames carry
/// the custom pair the collapsed card decodes from, no plain user row
/// reaches the wire, and the model turn still runs on the rendered
/// prompt.
#[tokio::test]
async fn a_delivered_agent_message_turn_emits_the_custom_row() {
    let dir = std::env::temp_dir().join(format!("pa-worker-amw-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "target-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
    };
    let worker = Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    // A busy session parks the delivery on the steering lane, so the
    // queued item is exactly what the served runner would pop.
    worker.core.lock().unwrap().busy = true;
    let delivered = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "the research is done",
                "sender": {
                    "activeSessionId": "source-session",
                    "sessionName": "research-lane",
                    "runtimeKind": "subagent",
                    // The child label derives from this parent edge,
                    // never from the runtime kind alone.
                    "parentActiveSessionId": "target-session",
                },
            }),
        )
        .await;
    assert!(delivered.success, "deliver failed: {delivered:?}");
    let item = worker
        .core
        .lock()
        .unwrap()
        .steering
        .pop_front()
        .expect("the delivery parked on the steering lane");
    let engine: Arc<dyn SessionEngine> =
        Arc::new(ScriptedEngine::from_value(json!({ "responses": ["ack"] })).unwrap_or_default());
    let runner = burst_runner(Arc::clone(&engine));
    let mut subscription = runner.events.subscribe();
    runner.run_turn(engine, vec![item]).await;
    let mut events = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type == "session_event" {
            if let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) {
                events.push(outbound["event"].clone());
            }
        }
    }
    // The accepted row is the agent_message custom pair - the
    // collapsed card's wire form - and no user row rides the turn.
    let starts = positions_of(&events, "message_start");
    assert_eq!(
        starts.len(),
        1,
        "only the custom row opens a start: {events:?}"
    );
    assert_eq!(events[starts[0]]["message"]["role"], "custom");
    assert_eq!(events[starts[0]]["message"]["customType"], "agent_message");
    assert_eq!(
        events[starts[0]]["message"]["content"],
        "[agent-message from child:research-lane]\n\nthe research is done"
    );
    let user_rows = events.iter().any(|event| {
        event.get("type").and_then(Value::as_str) == Some("message_start")
            && event["message"]["role"] == "user"
    });
    assert!(!user_rows, "the delivered turn must not emit a user row");
    // The model turn ran on the rendered prompt and settled the reply.
    let ends = positions_of(&events, "message_end");
    assert_eq!(ends.len(), 2, "the custom row and the reply settle");
    assert_eq!(events[ends[1]]["message"]["role"], "assistant");
}

/// A settled turn's wire `agent_end` (TS parity): the engine's per-run
/// frame carries the run's message set — the accepted user row and the
/// settled assistant row — and the worker's trailing synthesized frame
/// stays silent (the fallback exists only for runs that ended without
/// a model turn; TS emits one `agent_end` per agent run).
#[tokio::test]
async fn a_settled_turn_broadcasts_the_engine_agent_end_with_its_messages() {
    let engine = Arc::new(
        ScriptedEngine::from_value(json!({ "responses": ["settled reply"] })).unwrap_or_default(),
    );
    let events = turn_session_events(engine).await;
    let agent_ends = positions_of(&events, "agent_end");
    assert_eq!(
        agent_ends.len(),
        1,
        "exactly one agent_end per run: {events:?}"
    );
    let agent_end = &events[agent_ends[0]];
    assert!(
        agent_end.get("messages").is_some(),
        "the frame carries the TS messages payload: {agent_end:?}"
    );
    let messages = agent_end["messages"]
        .as_array()
        .cloned()
        .expect("the messages payload");
    let roles = messages
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<&str>>();
    assert_eq!(roles, ["user", "assistant"], "the run's message set");
    assert_eq!(
        messages[0]["content"],
        json!("burst"),
        "the accepted user row rides the payload"
    );
    assert_eq!(
        messages[1]["content"],
        json!("settled reply"),
        "the settled assistant row rides the payload"
    );
    // The frame order: the terminal `turn_end` precedes the run's
    // `agent_end`.
    let turn_ends = positions_of(&events, "turn_end");
    assert_eq!(turn_ends.len(), 1, "the scripted turn's turn_end");
    assert!(
        turn_ends[0] < agent_ends[0],
        "turn_end precedes agent_end: {events:?}"
    );
}

/// The bare `agent_end` fallback (a Rust-only shape kept for the TUI's
/// silent-failure backstop): a turn that ended without a model turn —
/// no `turn_end`, no `agent_end` from the engine — still closes with
/// the bare pair, like a session-command or pre-model-failure run.
#[tokio::test]
async fn a_turn_without_a_model_turn_keeps_the_bare_fallback_frames() {
    let events = turn_session_events(Arc::new(DoneOnlyEngine)).await;
    let turn_ends = positions_of(&events, "turn_end");
    assert_eq!(turn_ends.len(), 1, "the fallback turn_end: {events:?}");
    assert!(
        events[turn_ends[0]]
            .as_object()
            .is_some_and(|object| object.len() == 1),
        "the fallback turn_end carries no payload: {events:?}"
    );
    let agent_ends = positions_of(&events, "agent_end");
    assert_eq!(agent_ends.len(), 1, "the fallback agent_end: {events:?}");
    assert!(
        events[agent_ends[0]]
            .as_object()
            .is_some_and(|object| object.len() == 1),
        "the fallback agent_end carries no payload: {events:?}"
    );
    assert!(
        turn_ends[0] < agent_ends[0],
        "the fallback pair closes the turn in order: {events:?}"
    );
}

/// One `agent_end` per agent run on the wire (TS parity on a retried
/// turn): the failed run's frame carries the accepted rows plus the
/// failed assistant row, the retry run re-opens with its own
/// `agent_start` + `turn_start` frames (a boundary already passed), and
/// its `agent_end` carries only the retry's messages. No bare
/// synthesized frame trails the runs.
#[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
#[tokio::test]
async fn a_retried_turn_broadcasts_one_agent_end_per_run() {
    fn roles_of(frame: &Value) -> Vec<String> {
        frame["messages"]
            .as_array()
            .map(|messages| {
                messages
                    .iter()
                    .map(|message| message["role"].as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default()
    }
    let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!(
        "pa-worker-agent-end-retry-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(dir.join("agent")).unwrap();
    std::fs::write(
        dir.join("agent").join("settings.json"),
        json!({ "retry": { "enabled": true, "maxRetries": 1, "baseDelayMs": 10 } }).to_string(),
    )
    .unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "agent-end-retry-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({
            "engine": "faux",
            "responses": [
                { "stopReason": "error", "errorMessage": "faux provider overloaded" },
                { "text": "recovered reply" },
            ],
        })),
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "agent-end-retry" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let mut subscription = worker.events.subscribe();
    let prompt = worker
        .dispatch(
            "prompt",
            &json!({
                "activeSessionId": "agent-end-retry-session",
                "message": "retried turn for the agent end probe",
            }),
        )
        .await;
    assert!(prompt.success, "prompt failed: {prompt:?}");
    // The turn runs detached (`prompt` answers immediately) and the
    // faux retry settles in milliseconds, so the busy flag is not a
    // reliable admission marker: drain the stream until both runs'
    // `agent_end` frames arrived.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut events = Vec::new();
    loop {
        while let Ok(frame) = subscription.try_recv() {
            if frame.outbound_type != "session_event" {
                continue;
            }
            let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) else {
                continue;
            };
            if let Some(event) = outbound.get("event") {
                events.push(event.clone());
            }
        }
        let agent_ends = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_end"))
            .count();
        if agent_ends >= 2 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the retried turn never settled: {events:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    // The turn settled: drain the trailing frames (the settle-side
    // queue snapshot rides after the final `agent_end`).
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type != "session_event" {
            continue;
        }
        let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) else {
            continue;
        };
        if let Some(event) = outbound.get("event") {
            events.push(event.clone());
        }
    }
    let agent_ends = positions_of(&events, "agent_end");
    assert_eq!(
        agent_ends.len(),
        2,
        "one agent_end per agent run: {events:?}"
    );
    let first = &events[agent_ends[0]];
    assert_eq!(
        roles_of(first),
        ["custom", "user", "assistant"],
        "the failed run's message set (the deferred digest rides first): {events:?}"
    );
    assert_eq!(
        first["messages"][2]["stopReason"],
        json!("error"),
        "the failed run ends on the error row"
    );
    let second = &events[agent_ends[1]];
    assert_eq!(
        roles_of(second),
        ["assistant"],
        "the retried run carries only its own messages: {events:?}"
    );
    assert_eq!(
        second["messages"][0]["content"],
        json!([{ "type": "text", "text": "recovered reply" }]),
        "the retried run's settled row"
    );
    // The retry run restarted with its own opening frames: two
    // `agent_start` and two `turn_start` frames total (the worker's
    // run-opening pair plus the forwarded retry-run pair), the retry
    // run's frames after the retry start.
    let agent_starts = positions_of(&events, "agent_start");
    assert_eq!(agent_starts.len(), 2, "one agent_start per run: {events:?}");
    let turn_starts = positions_of(&events, "turn_start");
    assert_eq!(
        turn_starts.len(),
        2,
        "the run-opening turn_start plus the retry run's: {events:?}"
    );
    let retry_starts = positions_of(&events, "auto_retry_start");
    assert_eq!(retry_starts.len(), 1, "the retry start frame: {events:?}");
    assert!(
        agent_ends[0] < retry_starts[0]
            && retry_starts[0] < agent_starts[1]
            && agent_starts[1] < turn_starts[1]
            && turn_starts[1] < agent_ends[1],
        "the retry run's frames sit between the two agent_ends: {events:?}"
    );
    // No bare synthesized frame trails the runs: every agent_end on
    // the wire carries the messages payload.
    assert!(
        events.iter().all(|event| {
            event.get("type").and_then(Value::as_str) != Some("agent_end")
                || event.get("messages").is_some()
        }),
        "no bare agent_end frames: {events:?}"
    );
}

fn positions_of(events: &[Value], frame_type: &str) -> Vec<usize> {
    events
        .iter()
        .enumerate()
        .filter(|(_, event)| event.get("type").and_then(Value::as_str) == Some(frame_type))
        .map(|(index, _)| index)
        .collect()
}

fn texts_at(events: &[Value], positions: &[usize]) -> Vec<String> {
    positions
        .iter()
        .filter_map(|index| {
            events[*index]["message"]["content"][0]["text"]
                .as_str()
                .map(str::to_string)
        })
        .collect()
}

/// A provider that outruns the flush tick still broadcasts at most one
/// parked update per tick — never one wire frame per delta (the
/// pre-fix path flooded the wire with every delta and the client
/// starved at the tick rate; a 12k-token turn took minutes to render).
#[tokio::test]
async fn a_provider_burst_broadcasts_one_coalesced_update_per_tick_not_per_delta() {
    const DELTAS: usize = 120;
    // 1ms spacing: the burst spans ~120ms, so the 50ms flusher tick
    // flushes at most a handful of mid-burst snapshots.
    let engine = Arc::new(BurstStreamEngine {
        deltas: DELTAS,
        spacing_ms: 1,
    });
    let events = turn_session_events(engine).await;

    assert_eq!(
        positions_of(&events, "message_start").len(),
        1,
        "one message_start frame opens the stream"
    );
    let updates = positions_of(&events, "message_update");
    let end = positions_of(&events, "message_end");
    assert_eq!(end.len(), 1, "the turn settles with one message_end");
    assert!(
        !updates.is_empty(),
        "the parked snapshots must reach the wire"
    );
    assert!(
        updates.len() * 10 < DELTAS,
        "{DELTAS} spaced deltas must coalesce to a handful of wire updates, saw {}",
        updates.len()
    );
    // The latest snapshot wins: the flushed update carries the full
    // message so far, and superseded snapshots are dropped.
    assert_eq!(
        texts_at(&events, &updates).last().map(String::len),
        Some((DELTAS + 1) * 4),
        "the last flushed update must carry the full text"
    );
    // Event-sequence order: every update precedes the settle frame.
    assert!(
        updates.iter().all(|index| *index < end[0]),
        "a superseded snapshot must never follow message_end"
    );
}

/// An instant burst (the provider outruns the tick entirely) parks one
/// snapshot at a time; the settle frame flushes the final snapshot
/// before `message_end`, so the client sees the full message without a
/// tick waiting period and nothing lands out of order.
#[tokio::test]
async fn an_instant_burst_flushes_the_final_snapshot_with_its_settle_frame() {
    const DELTAS: usize = 200;
    let engine = Arc::new(BurstStreamEngine {
        deltas: DELTAS,
        spacing_ms: 0,
    });
    let events = turn_session_events(engine).await;

    let updates = positions_of(&events, "message_update");
    let end = positions_of(&events, "message_end");
    assert_eq!(end.len(), 1, "the turn settles with one message_end");
    assert!(
        updates.len() <= 3,
        "an instant burst broadcasts at most the settle-flushed snapshot (a mid-burst tick race adds one per 50ms stall), saw {}",
        updates.len()
    );
    assert!(
        texts_at(&events, &updates)
            .iter()
            .any(|text| text.len() == (DELTAS + 1) * 4),
        "the flushed snapshot must carry the full message"
    );
    assert!(
        updates.iter().all(|index| *index < end[0]),
        "the flushed snapshot precedes message_end"
    );
}
