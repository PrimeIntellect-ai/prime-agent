use super::*;
use crate::protocol::{response_failure, response_success};
use pa_types::platform::transport::bind_transport;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
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

/// A scripted JSONL supervisor for the watcher tests: creates one child
/// session, reports it idle with a final answer, and captures the
/// `follow_up` commands routed to the parent (the terminal-notice
/// deliveries). `idle_delay_ms` paces `wait_for_idle` so a test can act
/// while the child is still "running". `worker_leaves_after_settle`
/// fails every child read after the settle answer is captured.
async fn spawn_fake_supervisor(
    socket: std::path::PathBuf,
    follow_up_tx: mpsc::UnboundedSender<Value>,
    idle_delay_ms: u64,
    kill_tx: mpsc::UnboundedSender<Value>,
    kill_behavior: FakeKill,
    worker_leaves_after_settle: bool,
) {
    let kill_behavior = std::sync::Arc::new(kill_behavior);
    let listener = bind_transport(&socket).await.unwrap();
    tokio::spawn(async move {
        // Shared across link connections: a left worker fails every child
        // read on whichever connection carries it.
        let gone = Arc::new(AtomicBool::new(false));
        loop {
            let Ok(stream) = listener.accept().await else {
                return;
            };
            let follow_up_tx = follow_up_tx.clone();
            let kill_tx = kill_tx.clone();
            let kill_behavior = std::sync::Arc::clone(&kill_behavior);
            let gone = Arc::clone(&gone);
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
                                "sessionFile": "/tmp/child.jsonl",
                                "sessionName": "f20-worker",
                            })),
                        ),
                        "prompt" => response_success(Some(&id), command_type, None),
                        "wait_for_idle" => {
                            tokio::time::sleep(std::time::Duration::from_millis(idle_delay_ms))
                                .await;
                            response_success(Some(&id), command_type, None)
                        }
                        "get_state" => response_success(
                            Some(&id),
                            command_type,
                            Some(json!({
                                "isStreaming": false,
                                "sessionActions": { "queuedCount": 0 },
                            })),
                        ),
                        "get_last_assistant_text" => {
                            // The settle capture: with the knob set, the
                            // worker leaves right after its final answer.
                            if worker_leaves_after_settle {
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
    worker_leaves_after_settle: bool,
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
        worker_leaves_after_settle,
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
        })
        .await
        .expect("spawn must succeed against the fake supervisor")
}

#[tokio::test]
async fn roster_snapshot_does_not_wait_for_a_slow_child_worker() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 1_000, FakeKill::Success, false).await;
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
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, false).await;
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
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, true).await;
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
        sessions_with_fake_supervisor(follow_up_tx, 10_000, FakeKill::Success, false).await;
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
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 10_000, FakeKill::UnknownSession, false).await;
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
        sessions_with_fake_supervisor(follow_up_tx, 10_000, FakeKill::Failure, false).await;
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
        sessions_with_fake_supervisor(follow_up_tx, 250, FakeKill::Success, false).await;
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
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, false).await;
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
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, false).await;
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
        attributed_rows: 0,
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
