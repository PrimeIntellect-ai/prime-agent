//! Worker tests.
use super::*;
use crate::engine::{
    CompactionOutcome, CompactionRequest, PromptRequest, SessionEngine, SideQuestionOutcome,
    SideQuestionRequest,
};

/// Holds the blocking engine thread before it can emit the first durable user
/// row. The test's async task releases it only after shutdown has closed input.
struct BeforeUserRowEngine {
    entered: Arc<Notify>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

impl SessionEngine for BeforeUserRowEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        request: PromptRequest,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        self.entered.notify_one();
        // Dropping the sender on a failed assertion releases this blocking
        // thread too, so a red test cannot hang the Tokio runtime teardown.
        if self.release.lock().unwrap().recv().is_err() {
            emit(EngineEvent::DoneAborted);
            return;
        }
        if aborted() {
            emit(EngineEvent::DoneAborted);
        } else {
            emit(EngineEvent::UserMessage(json!({
                "role": "user", "content": request.message, "timestamp": 1,
            })));
            emit(EngineEvent::Done(Ok(())));
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
            message: "unsupported".to_string(),
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

fn worker_with_journal() -> Arc<Worker> {
    let dir = std::env::temp_dir().join(format!("pa-worker-verdict-{}", uuid::Uuid::new_v4()));
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
    // The journal is opened in `serve()`; tests open it directly so the
    // checkpoints have the same durable sink as production.
    *worker.recovery.lock().unwrap() =
        Some(WorkerRecoveryJournal::open(&worker.config.recovery_journal_path).unwrap());
    worker
}

async fn created_worker_with_journal() -> Arc<Worker> {
    let worker = worker_with_journal();
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

fn latest_record(worker: &Worker) -> crate::journal::WorkerRecoveryRecord {
    WorkerRecoveryJournal::read_latest(&worker.config.recovery_journal_path)
        .unwrap()
        .into_iter()
        .find(|record| record.active_session_id == "target-session")
        .expect("session record")
}

/// The admission (not the pickup) proves the work, so a plain boot revives the worker.
#[tokio::test]
async fn idle_time_injected_admission_is_busy_evidence() {
    let worker = created_worker_with_journal().await;
    // Settle first: the create record's busy=true must not mask the
    // admission's verdict.
    worker.dispatch("clear_queue", &json!({})).await;
    assert!(
        !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the settled session proves nothing"
    );
    let notify = Arc::new(Notify::new());
    admit_autonomous_follow_up(
        &worker.recovery,
        &worker.core,
        &notify,
        "continue the mission".to_string(),
    );
    assert!(
        WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the injected admission is live work"
    );
    let latest = latest_record(&worker);
    assert_eq!(latest.operation, "follow_up_queued");
    let (steering, follow_up) = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("the admission flushed its snapshot");
    assert!(steering.is_empty(), "steering: {steering:?}");
    assert_eq!(follow_up[0].message, "continue the mission");
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// An idle session wakes on an invisible injected row; the admission is journal busy evidence.
#[tokio::test]
async fn a_bash_completion_notice_admits_the_steering_lane_with_busy_evidence() {
    let worker = created_worker_with_journal().await;
    worker.dispatch("clear_queue", &json!({})).await;
    let notify = Arc::new(Notify::new());
    admit_bash_completion_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &crate::engine::BashCompletionNotice {
            pid: 4321,
            command: "sleep 12; echo RW_WAKE_DONE".to_string(),
            exit_code: 0,
        },
        || false,
    );
    let core = worker.core.lock().unwrap();
    let item = core
        .steering
        .front()
        .expect("the notice queues on the steering lane");
    let row = item.custom_message.as_ref().expect("the injected row");
    assert_eq!(
        row.get("customType").and_then(Value::as_str),
        Some("async_bash_completion"),
        "the row is the async-bash-completion notice: {row}"
    );
    assert_eq!(
        row["details"]["pid"],
        json!(4321),
        "the notice carries its pid: {row}"
    );
    assert!(
        item.message.starts_with("[bash-done pid:4321 exit:0]"),
        "the turn runs on the notice content: {item:?}"
    );
    assert!(
        item.preview
            .as_deref()
            .is_some_and(|preview| preview.starts_with("Background command finished: ")),
        "the queue row carries the TS preview label: {item:?}"
    );
    // An idle session's wake is an invisible injected turn.
    assert!(!item.queue_visible, "the idle wake stays invisible");
    drop(core);
    assert!(
        WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the notice admission is live work"
    );
    let latest = latest_record(&worker);
    assert_eq!(latest.operation, "steer_queued");
    let (steering, _) = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("the admission flushed its snapshot");
    assert_eq!(
        steering[0].message,
        "[bash-done pid:4321 exit:0]\n\nCommand: \"sleep 12; echo RW_WAKE_DONE\""
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// A busy session queues the notice as a visible steer row (TS `queueIfBusy`).
#[tokio::test]
async fn a_bash_completion_notice_on_a_busy_session_queues_a_visible_steer_row() {
    let worker = created_worker_with_journal().await;
    worker.core.lock().unwrap().busy = true;
    let notify = Arc::new(Notify::new());
    admit_bash_completion_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &crate::engine::BashCompletionNotice {
            pid: 99,
            command: "make gates".to_string(),
            exit_code: 2,
        },
        || false,
    );
    let core = worker.core.lock().unwrap();
    let item = core.steering.front().expect("the queued notice");
    assert!(item.queue_visible, "the busy session keeps a visible row");
    assert_eq!(item.policy, TurnPolicy::Queued);
    drop(core);
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// The withdrawal settles the busy evidence so the journal never promises a replay.
#[tokio::test]
async fn bash_consumed_withdraws_the_undelivered_notice_and_settles() {
    let worker = created_worker_with_journal().await;
    worker.dispatch("clear_queue", &json!({})).await;
    let notify = Arc::new(Notify::new());
    admit_bash_completion_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        &crate::engine::BashCompletionNotice {
            pid: 4321,
            command: "sleep 12; echo RW_WAKE_DONE".to_string(),
            exit_code: 0,
        },
        || false,
    );
    assert!(
        WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the notice admission is live work"
    );
    // A different command under a reused pid must not withdraw (TS
    // `_isAsyncBashCompletionActionFor` matches both).
    withdraw_bash_completion_notice(
        &worker.recovery,
        &worker.core,
        &crate::engine::BashConsumedNotice {
            pid: 4321,
            command: "another command".to_string(),
        },
    );
    assert!(
        worker.core.lock().unwrap().steering.len() == 1,
        "the mismatched withdrawal kept the row"
    );
    assert!(
        WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the kept row stays live work"
    );
    withdraw_bash_completion_notice(
        &worker.recovery,
        &worker.core,
        &crate::engine::BashConsumedNotice {
            pid: 4321,
            command: "sleep 12; echo RW_WAKE_DONE".to_string(),
        },
    );
    {
        let core = worker.core.lock().unwrap();
        assert!(
            core.steering.is_empty() && core.follow_up.is_empty(),
            "the consumed notice withdrew"
        );
    }
    assert!(
        !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the withdrawal settled the busy evidence"
    );
    let latest = latest_record(&worker);
    assert_eq!(latest.operation, "queue_purged");
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// Cancelling an owned queued admission settles the verdict: removed rows
/// leave no busy evidence and no replayable snapshot.
#[tokio::test]
async fn cancelled_admission_drop_settles_the_verdict() {
    let worker = created_worker_with_journal().await;
    worker.dispatch("clear_queue", &json!({})).await;
    let admitted = worker
        .dispatch("prompt", &json!({ "admissionId": "a1", "message": "go" }))
        .await;
    assert!(admitted.success, "prompt failed: {admitted:?}");
    assert!(
        WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the admitted prompt is live work"
    );
    let cancelled = worker
        .dispatch(
            "cancel_prompt_admission",
            &json!({ "admissionId": "a1", "cancelOwned": true }),
        )
        .await;
    assert_eq!(cancelled.data, Some(json!({ "status": "owned" })));
    assert!(
        !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the dropped rows leave no busy evidence"
    );
    let latest = latest_record(&worker);
    assert_eq!(latest.operation, "queue_dropped");
    let (steering, follow_up) = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("the drop flushed its snapshot");
    assert!(
        steering.is_empty() && follow_up.is_empty(),
        "lanes: {steering:?} {follow_up:?}"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// The in-flight turn is live work: only its own `turn_end` (after the idle flip) settles it.
#[tokio::test]
async fn mid_turn_withdrawal_keeps_the_in_flight_turn_busy() {
    let worker = created_worker_with_journal().await;
    // Mid-turn: the runner is streaming, and the withdrawal leaves
    // nothing queued behind it.
    worker.core.lock().unwrap().busy = true;
    worker.dispatch("clear_queue", &json!({})).await;
    let latest = latest_record(&worker);
    assert_eq!(latest.operation, "queue_cleared");
    assert!(
        latest.busy,
        "the in-flight turn keeps the withdrawal's verdict busy"
    );
    let (steering, follow_up) = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("the withdrawal flushed its snapshot");
    assert!(
        steering.is_empty() && follow_up.is_empty(),
        "the withdrawn rows left the snapshot: {steering:?} {follow_up:?}"
    );
    // The turn ends: the runner's idle flip precedes its settle, so the
    // same empty lanes now record busy=false.
    worker.core.lock().unwrap().busy = false;
    worker.dispatch("clear_queue", &json!({})).await;
    let latest = latest_record(&worker);
    assert_eq!(latest.operation, "queue_cleared");
    assert!(!latest.busy, "the settled turn leaves the session idle");
    assert!(
        !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "the settled session proves nothing"
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

/// The supervisor may SIGTERM immediately after the worker's shutdown reply.
/// That reply must therefore prove the final parked-queue verdict is durable.
#[tokio::test]
async fn shutdown_ack_has_already_settled_a_user_aborted_parked_queue() {
    let worker = created_worker_with_journal().await;
    worker.core.lock().unwrap().busy = true;
    let admitted = worker
        .dispatch("follow_up", &json!({ "message": "remain parked" }))
        .await;
    assert!(admitted.success, "admission failed: {admitted:?}");
    assert!(latest_record(&worker).busy, "admission was durable");
    {
        let mut core = worker.core.lock().unwrap();
        core.busy = false;
        core.queued_input_suspended = true;
    }
    let reply = worker
        .handle_shutdown(&json!({ "daemonShutdown": true }))
        .await;
    assert!(reply.success, "shutdown failed: {reply:?}");
    let latest = latest_record(&worker);
    assert_eq!(latest.operation, "shutdown");
    assert!(!latest.busy, "parked input cannot auto-replay after the ack");
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

#[tokio::test]
async fn shutdown_does_not_ack_when_its_final_verdict_cannot_persist() {
    let worker = created_worker_with_journal().await;
    let fixture_dir = worker.config.socket_path.parent().unwrap();
    let bad_path = fixture_dir.join("blocked-journal");
    std::fs::write(&bad_path, b"").unwrap();
    let blocked_journal = WorkerRecoveryJournal::open(&bad_path).unwrap();
    std::fs::remove_file(&bad_path).unwrap();
    std::fs::create_dir(&bad_path).unwrap();
    *worker.recovery.lock().unwrap() = Some(blocked_journal);
    let reply = worker
        .handle_shutdown(&json!({ "daemonShutdown": true }))
        .await;
    assert!(
        !reply.success,
        "an unrecorded verdict must not be acknowledged"
    );
    let _ = std::fs::remove_dir_all(fixture_dir);
}

/// A dequeued turn remains the worker's responsibility until its accepted
/// user rows are durable. Shutdown at that seam cannot replace the original
/// batched prompt and image with only a generic continuation.
#[tokio::test]
async fn shutdown_before_first_user_row_preserves_the_picked_prompt() {
    let worker = worker_with_journal();
    let fixture_dir = worker.config.socket_path.parent().unwrap();
    // Worker::new starts its ordinary runner. Let it park before installing
    // the test-owned gate runner, so only the latter can pick this batch.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if worker.core.lock().unwrap().last_activity_ms != 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("ordinary runner never parked");
    let mut store = SessionFile::create("/tmp", None, 0);
    store.set_path(fixture_dir.join("session.jsonl"));
    {
        let mut core = worker.core.lock().unwrap();
        core.created = true;
        core.store = Some(store);
        for (message, images) in [
            (
                "original with image",
                vec![pa_agent::types::ImageContent {
                    data: "QUJD".to_string(),
                    mime_type: "image/png".to_string(),
                }],
            ),
            ("batched second", Vec::new()),
        ] {
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Human,
                preview: Some(format!("preview {message}")),
                message: message.to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: Some(format!("key:{message}")),
                admission_id: Some(format!("admit:{message}")),
                images,
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
            });
        }
    }
    worker.checkpoint_queue(QueueCheckpoint::Admitted {
        operation: "prompt_accepted",
    });

    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let engine = Arc::new(BeforeUserRowEngine {
        entered: Arc::new(Notify::new()),
        release: std::sync::Mutex::new(release_rx),
    });
    let entered_notify = Arc::clone(&engine.entered);
    let entered = entered_notify.notified();
    let runner = TurnRunner {
        core: Arc::clone(&worker.core),
        input_pauses: worker.input_pauses.clone(),
        prompt_admissions: worker.prompt_admissions.clone(),
        work_notify: Arc::new(Notify::new()),
        idle_notify: Arc::clone(&worker.idle_notify),
        events: Arc::clone(&worker.events),
        engine,
        recovery: Arc::clone(&worker.recovery),
        active_session_id: worker.config.active_session_id.clone(),
        roster_pushes: worker.roster_pushes.clone(),
        user_bash: Arc::clone(&worker.user_bash),
        passivation: crate::worker::turn::PassivationContext {
            agent_dir: worker.config.agent_dir.clone(),
            link: Arc::new(crate::supervisor_link::SupervisorLink::new(
                worker.config.supervisor_socket_path.clone(),
            )),
            worker_token: String::new(),
        },
        herdr: Arc::clone(&worker.herdr),
    };
    let running = tokio::spawn(async move { runner.run().await });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered)
        .await
        .expect("turn never reached the pre-row gate");
    {
        let core = worker.core.lock().unwrap();
        assert!(core.busy && core.steering.is_empty(), "runner picked the batch");
        assert_eq!(core.store.as_ref().unwrap().message_count(), 0);
    }

    let stopping = Arc::clone(&worker);
    let shutdown = tokio::spawn(async move {
        stopping
            .handle_shutdown(&json!({ "daemonShutdown": true }))
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if worker.core.lock().unwrap().shutdown_requested {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("shutdown never closed input");
    assert!(
        worker.core.lock().unwrap().abort_requested,
        "the shutdown abort gate must be armed before releasing the engine"
    );
    release_tx.send(()).expect("release the held engine");
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), shutdown)
        .await
        .expect("shutdown never settled")
        .expect("shutdown task panicked");
    assert!(reply.success, "shutdown failed: {reply:?}");
    let (steering, _) = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("shutdown queue snapshot");
    assert_eq!(steering[0].message, "original with image");
    assert_eq!(steering[1].message, "batched second");
    assert_eq!(steering[0].preview.as_deref(), Some("preview original with image"));
    assert_eq!(steering[0].queue_key.as_deref(), Some("key:original with image"));
    assert_eq!(
        serde_json::to_value(&steering[0]).unwrap()["admissionId"],
        "admit:original with image",
        "the picked admission identity remains recoverable"
    );
    assert_eq!(
        serde_json::to_value(&steering[0]).unwrap()["images"][0]["data"],
        "QUJD",
        "the picked image remains recoverable"
    );
    running.abort();
    let _ = std::fs::remove_dir_all(fixture_dir);
}
