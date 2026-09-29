//! The queue-admission family (moved with its concern): the suspension
//! park, the steering/follow-up batching policies, the forced batch, the
//! abort-and-send-queued flow, and the pump fixtures (`runner_events`,
//! `queued_prompt`, `drain_pump`, `delivered_rows`).
use super::*;

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
        ScriptedEngine::from_value(&json!({ "responses": ["batched reply"] })).unwrap_or_default(),
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
        ScriptedEngine::from_value(&json!({ "responses": ["batched reply"] })).unwrap_or_default(),
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
        ScriptedEngine::from_value(&json!({ "responses": ["settled reply"] })).unwrap_or_default(),
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
        ScriptedEngine::from_value(&json!({ "responses": ["batch reply"] })).unwrap_or_default(),
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
        for item in &mut core.steering {
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
        ScriptedEngine::from_value(&json!({ "responses": ["lane reply"] })).unwrap_or_default(),
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
        ScriptedEngine::from_value(&json!({ "responses": ["follow-up batch reply"] }))
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
    // The TS acceptance case's positive-signal discipline (ENG-5991's
    // `waitForToolStart`): the abort must land on the REGISTERED run —
    // `core.busy` flips at the runner's pickup, before the engine's
    // admission, so a busy-only sync races the first turn's session
    // build and the abort lands in the admission prefix (the
    // abort-and-send idle race: the consult aborts the turn before its
    // provider call, the faux step the held turn never consumed leaks
    // to the batch turn, and the batch inherits the 600s hold). The
    // run slot is the registration signal: once it exists the abort
    // lands on the run itself, the shape this family means to pin.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let registered = worker
            .agent_engine
            .as_ref()
            .and_then(|engine| {
                engine
                    .turn_agent
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone()
            })
            .and_then(|agent| agent.signal())
            .is_some();
        if registered {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the held turn's run never registered"
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
