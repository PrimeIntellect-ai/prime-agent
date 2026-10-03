use super::*;
use crate::protocol::{response_failure, response_success};
use pa_types::platform::transport::bind_transport;
use pa_types::session::AgentMessage;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// How the fake supervisor answers a child `kill`.
enum FakeKill {
    Success,
    /// The child session is gone (the route failure a supervisor
    /// answers for a non-resident child).
    UnknownSession,
    /// The kill fails for a real reason (a stuck worker).
    Failure,
}

/// How the fake answers the child link: healthy, a failing `prompt`,
/// or a failing `get_state` (unreachable).
#[derive(Clone, Copy)]
enum FakeChild {
    Healthy,
    PromptFails,
    Unreachable,
    /// The worker leaves right after the settle answer is captured:
    /// every later child read fails.
    LeavesAfterSettle,
    /// Unreachable; the watcher's give-up poll parks until the test
    /// lands a reader's verdict.
    UnreachableUntilVerdict,
}

/// A scripted JSONL supervisor for the watcher tests: creates one child
/// session, reports it idle with a final answer, and captures the
/// `follow_up` commands routed to the parent (the terminal-notice
/// deliveries). `idle_delay_ms` paces `wait_for_idle` so a test can act
/// while the child is still "running". `child` scripts the child link
/// (`FakeChild`).
async fn spawn_fake_supervisor(
    socket: std::path::PathBuf,
    follow_up_tx: mpsc::UnboundedSender<Value>,
    idle_delay_ms: u64,
    kill_tx: mpsc::UnboundedSender<Value>,
    kill_behavior: FakeKill,
    child: FakeChild,
    child_subagents: Arc<FakeChildSubagents>,
) {
    let kill_behavior = std::sync::Arc::new(kill_behavior);
    // Per-fake child session file: a fixed path would let a leftover file
    // from another test (or run) carry the prompt text, flip the
    // prompt-retry arbitration to `landed`, and turn an expected failure
    // row into a no-reply notice.
    let child_session_file = std::sync::Arc::new(
        std::env::temp_dir()
            .join(format!(
                "pa-rlm-watch-child-{}.jsonl",
                uuid::Uuid::new_v4().simple()
            ))
            .to_string_lossy()
            .to_string(),
    );
    let listener = bind_transport(&socket).await.unwrap();
    tokio::spawn(async move {
        // Shared across link connections: a left worker fails every child
        // read on whichever connection carries it.
        let gone = Arc::new(AtomicBool::new(false));
        // Shared across link connections: the give-up gate counts the
        // child's state reads on whichever connection carries them.
        let state_reads = Arc::new(AtomicU32::new(0));
        loop {
            let Ok(stream) = listener.accept().await else {
                return;
            };
            let follow_up_tx = follow_up_tx.clone();
            let kill_tx = kill_tx.clone();
            let kill_behavior = std::sync::Arc::clone(&kill_behavior);
            let gone = Arc::clone(&gone);
            let state_reads = Arc::clone(&state_reads);
            let child_session_file = std::sync::Arc::clone(&child_session_file);
            let child_subagents = Arc::clone(&child_subagents);
            tokio::spawn(async move {
                let (reader, mut writer) = stream.split();
                let mut reader = BufReader::new(reader);
                writer
                    .write_all(
                        b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                    )
                    .await
                    .unwrap();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).await.unwrap() == 0 {
                        return;
                    }
                    let value: Value = serde_json::from_str(line.trim()).unwrap();
                    let id = value["id"].as_str().unwrap_or_default().to_string();
                    let command = value["command"].clone();
                    let command_type: &str = command["type"].as_str().unwrap_or_default();
                    let response = match command_type {
                        _ if matches!(
                            (child, command_type),
                            (FakeChild::PromptFails, "prompt")
                                | (
                                    FakeChild::Unreachable | FakeChild::UnreachableUntilVerdict,
                                    "get_state",
                                )
                        ) =>
                        {
                            // Two get_state reads per watcher pass for the
                            // parked variant (the refresh read, then the
                            // liveness poll): the last one is the give-up
                            // poll. Only that variant counts, so a plain
                            // unreachable child keeps its instant refusal.
                            if matches!(child, FakeChild::UnreachableUntilVerdict)
                                && state_reads.fetch_add(1, Ordering::SeqCst) + 1
                                    == 2 * WATCH_MAX_UNREACHABLE_POLLS
                            {
                                GIVE_UP_POLL.notify_one();
                                VERDICT_LANDED.notified().await;
                            }
                            response_failure(
                                Some(&id),
                                command_type,
                                "refused by the fake supervisor",
                                None,
                            )
                        }
                        "get_state" | "wait_for_idle" if gone.load(Ordering::SeqCst) => {
                            response_failure(
                                Some(&id),
                                command_type,
                                "Unknown active session: child-live",
                                None,
                            )
                        }
                        "create" => response_success(
                            Some(&id),
                            command_type,
                            Some(json!({
                                "activeSessionId": "child-live",
                                "sessionId": "child-file",
                                "sessionFile": *child_session_file,
                                "sessionName": "f20-worker",
                            })),
                        ),
                        "prompt" => response_success(Some(&id), command_type, None),
                        "wait_for_idle" => {
                            tokio::time::sleep(std::time::Duration::from_millis(idle_delay_ms))
                                .await;
                            // The quiescence arm also waits out the
                            // child's own running subagents.
                            if command["waitForRlmQuiescence"] == true {
                                child_subagents
                                    .quiescent_waits
                                    .fetch_add(1, Ordering::SeqCst);
                                while child_subagents.running.load(Ordering::SeqCst) {
                                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                                }
                            }
                            response_success(Some(&id), command_type, None)
                        }
                        "get_state" => response_success(
                            Some(&id),
                            command_type,
                            Some(json!({
                                "isStreaming": false,
                                "hasRunningSubagents": child_subagents.running.load(Ordering::SeqCst),
                                "sessionActions": { "queuedCount": 0 },
                            })),
                        ),
                        "get_last_assistant_text" => {
                            // The settle capture: with the knob set, the
                            // worker leaves right after its final answer.
                            if matches!(child, FakeChild::LeavesAfterSettle) {
                                gone.store(true, Ordering::SeqCst);
                            }
                            response_success(
                                Some(&id),
                                command_type,
                                Some(json!({ "text": "the child final answer" })),
                            )
                        }
                        "kill" => {
                            let _ = kill_tx.send(command.clone());
                            match *kill_behavior {
                                FakeKill::Success => {
                                    response_success(Some(&id), command_type, None)
                                }
                                FakeKill::UnknownSession => response_failure(
                                    Some(&id),
                                    command_type,
                                    "Unknown active session: child-live",
                                    None,
                                ),
                                FakeKill::Failure => response_failure(
                                    Some(&id),
                                    command_type,
                                    "kill refused by the fake supervisor",
                                    None,
                                ),
                            }
                        }
                        "follow_up" => {
                            let _ = follow_up_tx.send(command.clone());
                            response_success(
                                Some(&id),
                                command_type,
                                Some(json!({ "queued": true })),
                            )
                        }
                        other => response_failure(Some(&id), other, "unexpected command", None),
                    };
                    let mut line = serde_json::to_string(&response).unwrap();
                    line.push('\n');
                    if writer.write_all(line.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
}

async fn sessions_with_fake_supervisor(
    follow_up_tx: mpsc::UnboundedSender<Value>,
    idle_delay_ms: u64,
    kill_behavior: FakeKill,
    child: FakeChild,
) -> (SupervisorChildSessions, mpsc::UnboundedReceiver<Value>) {
    sessions_with_fake_child_subagents(
        follow_up_tx,
        idle_delay_ms,
        kill_behavior,
        child,
        Arc::new(FakeChildSubagents::default()),
    )
    .await
}

/// The fake child's own subagents: whether one still runs (the child
/// reports `hasRunningSubagents`, and a `waitForRlmQuiescence` idle wait
/// holds until it finishes), and how many such waits started.
#[derive(Default)]
struct FakeChildSubagents {
    running: AtomicBool,
    quiescent_waits: std::sync::atomic::AtomicUsize,
}

/// [`sessions_with_fake_supervisor`] whose child reports its own running
/// subagents from `child_subagents` (a grandchild still running).
async fn sessions_with_fake_child_subagents(
    follow_up_tx: mpsc::UnboundedSender<Value>,
    idle_delay_ms: u64,
    kill_behavior: FakeKill,
    child: FakeChild,
    child_subagents: Arc<FakeChildSubagents>,
) -> (SupervisorChildSessions, mpsc::UnboundedReceiver<Value>) {
    let socket = std::env::temp_dir().join(format!(
        "pa-rlm-watch-{}.sock",
        uuid::Uuid::new_v4().simple()
    ));
    let (kill_tx, kill_rx) = mpsc::unbounded_channel();
    spawn_fake_supervisor(
        socket.clone(),
        follow_up_tx,
        idle_delay_ms,
        kill_tx,
        kill_behavior,
        child,
        child_subagents,
    )
    .await;
    let link = Arc::new(crate::supervisor_link::SupervisorLink::new(socket));
    let sessions = SupervisorChildSessions::new(
        link,
        std::env::temp_dir(),
        "parent-live".to_string(),
        std::sync::Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
            std::env::temp_dir(),
            /*telemetry_disabled*/ true,
        )),
    );
    // A live parent carries its resolved model on the identity; the
    // spawn path resolves the child's model from it.
    sessions.set_identity(ParentIdentity {
        model: Some("mock/mock-1".to_string()),
        cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
        ..ParentIdentity::with_default_depth()
    });
    (sessions, kill_rx)
}

async fn spawn_child(sessions: &SupervisorChildSessions) -> RlmSpawnHandle {
    sessions
        .spawn(RlmSpawnRequest {
            prompt: "f20 child task".to_string(),
            name: Some("f20-worker".to_string()),
            model: None,
            thinking: None,
            cell_source_code: None,
            spawned_by_request_id: None,
        })
        .await
        .expect("spawn must succeed against the fake supervisor")
}

#[tokio::test]
async fn roster_snapshot_does_not_wait_for_a_slow_child_worker() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 1_000, FakeKill::Success, FakeChild::Healthy)
            .await;
    sessions
        .push_test_child(RlmChildIdentity {
            rlm_child_id: "child-id".to_string(),
            active_session_id: "child-live".to_string(),
            session_id: Some("child-file".to_string()),
            session_name: "slow-child".to_string(),
        })
        .await;
    let roster = tokio::time::timeout(Duration::from_millis(10), sessions.list_subagents())
        .await
        .expect("roster must not make a supervisor round trip")
        .expect("roster snapshot");
    assert_eq!(roster.len(), 1);
    assert_eq!(roster[0].status, "running");
}

/// A child that settles without replying delivers the no-reply terminal
/// notice to the parent session as an injected follow-up turn.
#[tokio::test]
async fn a_settled_child_without_a_reply_delivers_the_terminal_notice() {
    let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, FakeChild::Healthy).await;
    let handle = spawn_child(&sessions).await;
    // The worker releases the detached prompt at its turn boundary.
    sessions.notify_turn_done();

    let follow_up = tokio::time::timeout(std::time::Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("the watcher must deliver the notice")
        .expect("the follow_up channel stays open");
    assert_eq!(follow_up["type"], "follow_up");
    assert_eq!(follow_up["activeSessionId"], "parent-live");
    let custom = &follow_up["customMessage"];
    assert_eq!(custom["role"], "custom");
    assert_eq!(custom["customType"], "rlm_child_terminal_notice");
    assert!(
        follow_up["rlmNoticeNonce"].as_str().is_some(),
        "the notice carries the one-shot capability the parent's queue admission consumes"
    );
    assert_eq!(
        custom["content"],
        "[child-exited: no-reply child:f20-worker]\n\nLast assistant text: the child final answer"
    );
    assert_eq!(custom["details"]["childId"], handle.rlm_child_id);
    assert_eq!(custom["details"]["sessionName"], "f20-worker");
    // Exactly one notice lands: the watcher delivers once.
    let extra =
        tokio::time::timeout(std::time::Duration::from_millis(300), follow_up_rx.recv()).await;
    assert!(extra.is_err(), "no second notice may arrive");
}

/// The settle grace re-marks only a BUSY child as running: a worker that
/// leaves inside the grace (the idle passivation's stop, a crash) keeps
/// the settled verdict, and the settle tail (notice, funnel) still runs.
#[tokio::test]
async fn a_worker_leaving_inside_the_settle_grace_keeps_the_verdict() {
    let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) = sessions_with_fake_supervisor(
        follow_up_tx,
        0,
        FakeKill::Success,
        FakeChild::LeavesAfterSettle,
    )
    .await;
    let settled = sessions.settle_notified();
    spawn_child(&sessions).await;
    sessions.notify_turn_done();

    tokio::time::timeout(Duration::from_secs(10), settled)
        .await
        .expect("the settle funnel fires although the worker left");
    assert!(!sessions.any_running().await);
    let roster = sessions.list_subagents().await.expect("child roster");
    assert_eq!(roster[0].status, "completed");
    let notice = follow_up_rx
        .try_recv()
        .expect("the no-reply notice is still owed");
    assert!(notice["customMessage"]["content"]
        .as_str()
        .is_some_and(|content| content.contains("the child final answer")));
}

/// A cancelled run's watcher settle leaves the display `running`, so a
/// restart relists the child as `error` instead of `completed`.
#[tokio::test]
async fn a_cancelled_child_keeps_its_display_running_through_the_watcher_settle() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 500, FakeKill::Success, FakeChild::Healthy)
            .await;
    let (hook_tx, mut hook_rx) = mpsc::unbounded_channel();
    sessions.set_settle_hook(Arc::new(move || {
        let _ = hook_tx.send(());
    }));
    let handle = spawn_child(&sessions).await;
    let display_file = Path::new(&handle.session_dir).join("rlm-subagent.json");
    std::fs::write(
        &display_file,
        json!({ "type": "rlm_subagent", "childId": handle.rlm_child_id,
                "sessionDir": handle.session_dir, "status": "running" })
        .to_string(),
    )
    .unwrap();
    sessions.notify_turn_done();
    assert!(sessions.cancel_child_run(&handle.rlm_child_id).await);
    // One settle hook from the cancel, one from the watcher's settle tail.
    for _ in 0..2 {
        tokio::time::timeout(Duration::from_secs(10), hook_rx.recv())
            .await
            .expect("both settle hooks fire")
            .expect("hook channel open");
    }
    let display = crate::rlm_ledger::read_rlm_subagent_display(Path::new(&handle.session_dir))
        .expect("display entry stays readable");
    assert_eq!(display.status, "running");
}

/// The `follow_up` carries exactly the TS failure row (`createRlmChildFailureMessage`).
fn assert_failure_row(follow_up: &Value, child_id: &str, error: &str) {
    let custom = &follow_up["customMessage"];
    let timestamp = custom["timestamp"].as_u64().expect("failure row timestamp");
    let expected = create_rlm_child_failure_message(child_id, "f20-worker", error, timestamp);
    assert_eq!(
        *custom,
        serde_json::to_value(AgentMessage::Custom(expected)).unwrap()
    );
}

/// A child whose task prompt cannot be routed settles `error`, delivers
/// the TS failure row and releases the owed continuation.
#[tokio::test]
async fn a_child_whose_task_prompt_cannot_be_routed_delivers_the_failure_notice() {
    let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, FakeChild::PromptFails)
            .await;
    let (hook_tx, mut hook_rx) = mpsc::unbounded_channel();
    sessions.set_settle_hook(Arc::new(move || {
        let _ = hook_tx.send(());
    }));
    let handle = spawn_child(&sessions).await;
    // The worker releases the detached prompt at its turn boundary.
    sessions.notify_turn_done();

    let follow_up = tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("the failed child must deliver its failure notice")
        .expect("the follow_up channel stays open");
    assert_failure_row(
        &follow_up,
        &handle.rlm_child_id,
        "prompt RLM child session child-live: refused by the fake supervisor",
    );
    let entries = sessions.list_subagents().await.expect("child roster");
    assert_eq!(entries[0].status, "error");
    tokio::time::timeout(Duration::from_secs(10), hook_rx.recv())
        .await
        .expect("the failed child releases the owed continuation")
        .expect("hook channel open");
    // Exactly one failure row lands: the claim admits one writer.
    let extra = tokio::time::timeout(Duration::from_millis(300), follow_up_rx.recv()).await;
    assert!(extra.is_err(), "no second notice may arrive");
}

/// An unreachable child delivers the failure row, not the no-reply notice.
/// A short tick keeps the paused clock's auto-advance from firing link
/// deadlines while the real-socket round trips are in flight.
#[tokio::test(start_paused = true)]
async fn an_unreachable_child_delivers_the_failure_notice_instead_of_no_reply() {
    tokio::spawn(async {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
        }
    });
    let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, FakeChild::Unreachable)
            .await;
    let handle = spawn_child(&sessions).await;
    sessions.notify_turn_done();

    let follow_up = tokio::time::timeout(Duration::from_secs(3_600), follow_up_rx.recv())
        .await
        .expect("the unreachable child must deliver its failure notice")
        .expect("follow_up channel open");
    assert_failure_row(&follow_up, &handle.rlm_child_id, "Child worker unreachable");
    // Exactly one failure row lands: the give-up claims once.
    let extra = tokio::time::timeout(Duration::from_millis(300), follow_up_rx.recv()).await;
    assert!(extra.is_err(), "no second notice may arrive");
}

/// Hand-off into the unreachable give-up's poll: the fake parks the
/// give-up poll, the test lands the reader's verdict, the fake releases
/// the poll. Only the lost-claim test uses these.
static GIVE_UP_POLL: tokio::sync::Notify = tokio::sync::Notify::const_new();
static VERDICT_LANDED: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// A reader's refresh can settle the child between the watcher's settle
/// read and its unreachable give-up claim: the claim keeps that verdict,
/// and the watcher still runs its settle tail.
#[tokio::test(start_paused = true)]
async fn a_verdict_landing_inside_the_unreachable_give_up_still_runs_the_settle_tail() {
    tokio::spawn(async {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
        }
    });
    let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) = sessions_with_fake_supervisor(
        follow_up_tx,
        0,
        FakeKill::Success,
        FakeChild::UnreachableUntilVerdict,
    )
    .await;
    let settled = sessions.settle_notified();
    spawn_child(&sessions).await;
    sessions.notify_turn_done();

    GIVE_UP_POLL.notified().await;
    {
        // What a `collect`'s `refresh_record` writes when the worker
        // answers idle.
        let record = Arc::clone(&sessions.inner.children.lock().await[0]);
        let mut record = record.lock().await;
        record.settled_status = Some("done");
    }
    VERDICT_LANDED.notify_one();

    tokio::time::timeout(Duration::from_secs(3_600), settled)
        .await
        .expect("the settle funnel fires for the reader's verdict");
    assert!(!sessions.any_running().await, "the run must mark settled");
    let notice = follow_up_rx
        .try_recv()
        .expect("the verdict's no-reply notice is still owed");
    assert_eq!(
        notice["customMessage"]["customType"],
        "rlm_child_terminal_notice"
    );
}

/// The review's C1 interleaving: a `collect` that lands inside the
/// prompt-failure window (after the detached task flips
/// `prompt_admitted`, before the retry verdict) reads the alive-but-idle
/// worker as `done` — `refresh_record`'s admission-window misread, not a
/// settle verdict. The prompt arm's failure claim must ignore it: the
/// failure row still lands, the roster reports `error`, the hook fires,
/// and the run marks settled (post-#3171 an unsettled failed run parks
/// `waitForRlmQuiescence` forever).
#[tokio::test]
async fn a_collect_inside_the_prompt_failure_window_does_not_swallow_the_failure_row() {
    let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, FakeChild::PromptFails)
            .await;
    let (hook_tx, mut hook_rx) = mpsc::unbounded_channel();
    sessions.set_settle_hook(Arc::new(move || {
        let _ = hook_tx.send(());
    }));
    let handle = spawn_child(&sessions).await;
    // The window's entry condition, set deterministically: the detached
    // prompt task flips `prompt_admitted` BEFORE its first
    // `prompt_child` (host.rs), and the collect below races that task in
    // production. With the flag set and the worker alive-but-idle, the
    // real collect path scores the misread.
    sessions.inner.children.lock().await[0]
        .lock()
        .await
        .prompt_admitted = true;
    let misread = sessions
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .expect("collect inside the window");
    assert_eq!(
        misread[0].status, "done",
        "the premise: the collect misreads the pre-prompt idle worker as done"
    );

    // The task prompt now runs and fails (prompt + retry) inside the
    // window the collect already scored.
    sessions.notify_turn_done();

    let follow_up = tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("the failure row must land despite the collect's misread")
        .expect("follow_up channel open");
    assert_failure_row(
        &follow_up,
        &handle.rlm_child_id,
        "prompt RLM child session child-live: refused by the fake supervisor",
    );
    let entries = sessions.list_subagents().await.expect("child roster");
    assert_eq!(entries[0].status, "error");
    tokio::time::timeout(Duration::from_secs(10), hook_rx.recv())
        .await
        .expect("the settle funnel fires despite the misread")
        .expect("hook channel open");
    assert!(
        !sessions.any_running().await,
        "the failed run must mark settled: an unsettled run parks the quiescence barrier"
    );
    let extra = tokio::time::timeout(Duration::from_millis(300), follow_up_rx.recv()).await;
    assert!(extra.is_err(), "no second notice may arrive");
}

/// A child that already replied still delivers the failure row when its
/// task prompt fails: TS sends the catch-arm row regardless of reply
/// count (`agent-session.ts:13026-13045`).
#[tokio::test]
async fn a_replied_child_whose_prompt_fails_still_delivers_the_failure_row() {
    let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, FakeChild::PromptFails)
            .await;
    let handle = spawn_child(&sessions).await;
    sessions.mark_replied("child-live").await;
    sessions.notify_turn_done();

    let follow_up = tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("the replied child must still deliver the failure row")
        .expect("follow_up channel open");
    assert_failure_row(
        &follow_up,
        &handle.rlm_child_id,
        "prompt RLM child session child-live: refused by the fake supervisor",
    );
    let extra = tokio::time::timeout(Duration::from_millis(300), follow_up_rx.recv()).await;
    assert!(extra.is_err(), "no second notice may arrive");
}

/// A parent counts as running while any descendant runs: the child's own
/// turn is done, but while it reports a running grandchild the parent's
/// row stays `running` and the registry keeps the parent's summary busy;
/// once the grandchild finishes, the child settles and the parent is
/// quiet again.
#[tokio::test]
async fn a_child_with_a_running_grandchild_keeps_the_parent_running() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let grandchild = Arc::new(FakeChildSubagents {
        running: AtomicBool::new(true),
        ..FakeChildSubagents::default()
    });
    let (sessions, _kill_rx) = sessions_with_fake_child_subagents(
        follow_up_tx,
        0,
        FakeKill::Success,
        FakeChild::Healthy,
        Arc::clone(&grandchild),
    )
    .await;
    assert!(!sessions.has_running_children());
    let mut running = sessions.subscribe_running();
    let settled = sessions.settle_notified();
    spawn_child(&sessions).await;
    assert!(running.has_changed().unwrap());
    assert!(*running.borrow_and_update());
    sessions.notify_turn_done();

    // The child is idle on its own, but its grandchild still runs: the
    // watcher's idle wait holds for the child's whole subtree.
    wait_for_quiescent_wait(&grandchild).await;
    let roster = sessions.list_subagents().await.expect("child roster");
    assert_eq!(roster[0].status, "running");
    assert!(sessions.has_running_children());

    grandchild.running.store(false, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(10), settled)
        .await
        .expect("the child settles once its grandchild finished");
    let roster = sessions.list_subagents().await.expect("child roster");
    assert_eq!(roster[0].status, "completed");
    assert!(!sessions.has_running_children());
    assert!(running.has_changed().unwrap());
}

/// A `collect` with a timeout waits out a child whose own turn ended but
/// whose grandchild still runs, instead of answering `running` at once.
#[tokio::test]
async fn collect_with_a_timeout_waits_for_a_running_grandchild() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let grandchild = Arc::new(FakeChildSubagents {
        running: AtomicBool::new(true),
        ..FakeChildSubagents::default()
    });
    let (sessions, _kill_rx) = sessions_with_fake_child_subagents(
        follow_up_tx,
        0,
        FakeKill::Success,
        FakeChild::Healthy,
        Arc::clone(&grandchild),
    )
    .await;
    let handle = spawn_child(&sessions).await;
    sessions.notify_turn_done();
    wait_for_quiescent_wait(&grandchild).await;

    let finish = Arc::clone(&grandchild);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        finish.running.store(false, Ordering::SeqCst);
    });
    let results = sessions
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .expect("collect the child");
    assert_eq!(results[0].status, "done");
    assert!(!grandchild.running.load(Ordering::SeqCst));
}

/// Wait until the settle watcher parks in the child's subtree idle wait.
async fn wait_for_quiescent_wait(child_subagents: &FakeChildSubagents) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while child_subagents.quiescent_waits.load(Ordering::SeqCst) == 0 {
        assert!(
            Instant::now() < deadline,
            "the watcher never waited for the child's subtree"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// One child row exists and is running before the close tests run.
async fn one_running_child(sessions: &SupervisorChildSessions) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let entries = sessions.list_subagents().await.expect("child roster");
        if let Some(row) = entries.first() {
            assert_eq!(row.status, "running");
            return;
        }
        assert!(Instant::now() < deadline, "child row never appeared");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// `close_children` (TS `closeChildSessions` at the replacement
/// teardown / session close): every tracked child is stopped through
/// the supervisor - a plain stop, no delete marker, so the ledger edge
/// and passive roster row survive - the registry empties, and no
/// terminal notice is owed to the closing parent session.
#[tokio::test]
async fn close_children_stops_the_child_and_clears_the_roster() {
    let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
    // A long idle keeps the child mid-run while the close fires, so the
    // settle watcher is parked instead of raced.
    let (sessions, mut kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 10_000, FakeKill::Success, FakeChild::Healthy)
            .await;
    spawn_child(&sessions).await;
    sessions.notify_turn_done();
    one_running_child(&sessions).await;

    sessions
        .close_children(ChildCloseReason::Killed)
        .await
        .expect("close children");

    // The stop carried no delete marker: the spawn edge survives (TS
    // `closeSessionOnce` archives; only `recordRlmSubagentDeletion`
    // tombstones).
    let kill = kill_rx
        .recv()
        .await
        .expect("the close must stop the child through the supervisor");
    assert_eq!(kill["type"], "kill");
    assert!(
        !kill.to_string().contains("rlmLedgerDelete"),
        "the replacement close is a stop, not a delete"
    );
    // The registry the replacement session reads starts empty.
    let entries = sessions.list_subagents().await.expect("child roster");
    assert!(
        entries.is_empty(),
        "the closed child stays listed: {entries:?}"
    );
    // No terminal notice is delivered to the closing parent session.
    let extra = tokio::time::timeout(Duration::from_millis(300), follow_up_rx.recv()).await;
    assert!(extra.is_err(), "a closed child must not deliver a notice");
}

/// A child whose session is already gone is a completed no-op (the TS
/// `sessions.has` early return in `closeSessionOnce`), not a close
/// failure: the registry drops it and the close succeeds.
#[tokio::test]
async fn close_children_treats_an_already_gone_child_as_a_no_op() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) = sessions_with_fake_supervisor(
        follow_up_tx,
        10_000,
        FakeKill::UnknownSession,
        FakeChild::Healthy,
    )
    .await;
    spawn_child(&sessions).await;
    sessions.notify_turn_done();
    one_running_child(&sessions).await;

    sessions
        .close_children(ChildCloseReason::Killed)
        .await
        .expect("an already-gone child must not fail the close");

    let entries = sessions.list_subagents().await.expect("child roster");
    assert!(
        entries.is_empty(),
        "the gone child stays listed: {entries:?}"
    );
}

/// A real close failure propagates and keeps the child tracked, so the
/// caller (the replacement teardown) fails exactly like TS
/// `teardownForReplacement` rethrowing `disposeHostedSubagentRuntimes`.
#[tokio::test]
async fn close_children_keeps_a_failed_child_tracked() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 10_000, FakeKill::Failure, FakeChild::Healthy)
            .await;
    spawn_child(&sessions).await;
    sessions.notify_turn_done();
    one_running_child(&sessions).await;

    let error = sessions
        .close_children(ChildCloseReason::Killed)
        .await
        .expect_err("a real close failure must propagate");
    assert!(
        format!("{error:#}").contains("kill refused"),
        "the close error must surface the kill failure: {error:#}"
    );

    let entries = sessions.list_subagents().await.expect("child roster");
    assert_eq!(entries.len(), 1, "the failed child stays tracked for retry");
}

/// A child that sent an agent message back gets no terminal notice: the
/// reply is the parent's report (TS `_parentReplyCount`).
#[tokio::test]
async fn a_replied_child_gets_no_terminal_notice() {
    let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
    // A slow idle wait keeps the child "running" while the test marks
    // the reply.
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 250, FakeKill::Success, FakeChild::Healthy)
            .await;
    let handle = spawn_child(&sessions).await;
    assert!(!handle.rlm_child_id.is_empty());
    sessions.mark_replied("child-live").await;
    // The worker releases the detached prompt at its turn boundary.
    sessions.notify_turn_done();

    let extra = tokio::time::timeout(std::time::Duration::from_secs(2), follow_up_rx.recv()).await;
    assert!(extra.is_err(), "a replied child must not deliver a notice");
}

/// TS #2388: a target whose delete receipt already returned resolves
/// immediately to the settled cancelled envelope - status `cancelled`,
/// `settled: true`, the delete reason - without spending the timeout
/// budget; unknown selectors keep erroring, and the delete selector
/// itself keeps the TS miss.
#[tokio::test]
async fn collect_answers_a_just_deleted_target_with_the_cancelled_envelope() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, FakeChild::Healthy).await;
    let handle = spawn_child(&sessions).await;
    sessions.notify_turn_done();
    // The child settles with its final answer before the delete.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let entries = sessions.list_subagents().await.expect("child roster");
        if entries.iter().any(|entry| entry.status == "completed") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "child never settled: {entries:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    sessions
        .delete_subagent(handle.rlm_child_id.clone())
        .await
        .expect("delete the settled child");

    // By child id: the settled cancelled envelope the receipt promised.
    let results = sessions
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .expect("collect the deleted child by id");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].rlm_child_id, handle.rlm_child_id);
    assert_eq!(results[0].session_name.as_deref(), Some("f20-worker"));
    assert_eq!(results[0].status, "cancelled");
    assert!(results[0].settled);
    assert_eq!(
        results[0].error.as_deref(),
        Some("Deleted by parent orchestrator")
    );
    // By session name: the same cancelled envelope.
    let results = sessions
        .collect(vec!["f20-worker".to_string()], 0)
        .await
        .expect("collect the deleted child by name");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].rlm_child_id, handle.rlm_child_id);
    assert_eq!(results[0].status, "cancelled");
    assert!(results[0].settled);
    // An unknown selector keeps the TS miss.
    let missing = sessions
        .collect(vec!["ghost".to_string()], 0)
        .await
        .expect_err("an unknown selector still errors");
    assert_eq!(
        missing.to_string(),
        "No direct RLM child matches \"ghost\" in the current parent session"
    );
    // The delete selector itself keeps its TS miss: the tombstone
    // answers collect only.
    let gone = sessions
        .delete_subagent("f20-worker".to_string())
        .await
        .expect_err("the deleted child no longer resolves for a delete");
    assert_eq!(
        gone.to_string(),
        "No direct RLM subagent matches \"f20-worker\" in the current parent session"
    );
}

/// TS #2388: the inactive delete (a settled retained child) leaves the
/// same tombstone as the live delete, so `collect` answers a
/// just-deleted selector with the settled cancelled envelope its
/// delete receipt promised.
#[tokio::test]
async fn collect_answers_the_cancelled_envelope_after_an_inactive_delete() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, FakeChild::Healthy).await;
    let handle = spawn_child(&sessions).await;
    sessions.notify_turn_done();
    // The inactive delete requires a settled child (a running child
    // answers "running").
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let entries = sessions.list_subagents().await.expect("child roster");
        if entries.iter().any(|entry| entry.status == "completed") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "child never settled: {entries:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let outcome = sessions
        .delete_inactive_subagent(&handle.rlm_child_id)
        .await
        .expect("inactive delete");
    assert_eq!(outcome, "deleted");

    let results = sessions
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .expect("collect the inactive-deleted child");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].rlm_child_id, handle.rlm_child_id);
    assert_eq!(results[0].status, "cancelled");
    assert!(results[0].settled);
    assert_eq!(
        results[0].error.as_deref(),
        Some("Deleted by parent orchestrator")
    );
}

/// The unreachable-poller's POSITIVE-status guard: a child that already
/// settled (`done` — the idle passivation's prerequisite) never re-scores
/// as an error when its worker leaves afterward; a still-RUNNING child
/// does (the crash class the error verdict exists for).
#[test]
fn an_already_settled_child_never_re_scores_as_an_unreachable_error() {
    let base = || ChildRecord {
        rlm_child_id: "child-id".to_string(),
        session_name: "lane".to_string(),
        active_session_id: "child-live".to_string(),
        session_id: Some("child-file".to_string()),
        session_dir: "/tmp".to_string(),
        label: "task".to_string(),
        started_at_ms: 0,
        settled_status: None,
        settled: false,
        answer_preview: None,
        answer_captured: false,
        replied_since_task: false,
        notice_delivered: false,
        prompt_admitted: true,
        error: None,
        closed_by_parent: false,
        session_file: None,
        attributed_rows: Some(0),
        usage_watch_live: false,
        usage_rearm: false,
        emit_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
    };
    // A running child that goes unreachable is the error class.
    assert!(super::lifecycle::should_mark_unreachable_error(&base()));
    // A settled child keeps its positive verdict.
    let mut settled = base();
    settled.settled_status = Some("done");
    assert!(
        !super::lifecycle::should_mark_unreachable_error(&settled),
        "an idle-passivated (or post-settle crashed) child keeps its settled verdict"
    );
    // A parent-closed child and a noticed child never re-score.
    let mut closed = base();
    closed.closed_by_parent = true;
    assert!(!super::lifecycle::should_mark_unreachable_error(&closed));
    let mut noticed = base();
    noticed.notice_delivered = true;
    assert!(!super::lifecycle::should_mark_unreachable_error(&noticed));
}
