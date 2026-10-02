//! The live supervisor-feed family (moved with its concern): the
//! waiting-prompt settle order and the roster's live tool-activity
//! wire indicator, with the fake supervisor link + live-feed runner
//! fixtures (unix).
use super::*;

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
        ScriptedEngine::from_value(&json!({ "responses": ["settled reply"] })).unwrap_or_default(),
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
#[cfg(unix)]
fn fake_supervisor(
    socket: &std::path::Path,
) -> (Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::UnixListener::bind(socket).unwrap();
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
/// live supervisor link (the burst runner keeps them disabled). Unix
/// only: its one caller is the unix socket-harness test below.
#[cfg(unix)]
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
    crate::roster_activity::spawn_roster_activity_watch(&events, roster_pushes.clone());
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
        user_bash: std::sync::Arc::new(crate::user_bash::UserBash::new()),
        passivation: crate::worker::turn::PassivationContext {
            agent_dir: std::path::PathBuf::from("/tmp"),
            link: Arc::new(crate::supervisor_link::SupervisorLink::new(
                std::path::PathBuf::from("/nonexistent-supervisor.sock"),
            )),
            worker_token: "token".to_string(),
        },
        herdr: std::sync::Arc::new(std::sync::Mutex::new(crate::herdr::HerdrReporter::default())),
    }
}

/// The waiting/executing indicator over the wire: a working session's
/// roster deltas carry live `isRunningTools` transitions while the
/// tool executes (mid-turn pushes, not a static turn-start snapshot)
/// and end idle once the turn settles (TS `observeRosterEvent` +
/// `ROSTER_SESSION_EVENT_TRIGGERS` + `scheduleRosterFlush`).
#[cfg(unix)]
#[tokio::test]
async fn roster_feed_publishes_live_tool_activity() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    let (recorded, server) = fake_supervisor(&socket);
    let engine: Arc<dyn SessionEngine> = Arc::new(
        ScriptedEngine::from_value(&json!({
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
