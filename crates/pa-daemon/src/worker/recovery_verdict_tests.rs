//! Worker tests.
use super::*;
use super::queue::{checkpoint_picked_input, queue_item_record};
use crate::engine::{
    CompactionOutcome, CompactionRequest, PromptRequest, SessionEngine, SideQuestionOutcome,
    SideQuestionRequest,
};

/// Holds the blocking engine thread before it can emit the first durable user
/// row. The test's async task releases it only after shutdown has closed input.
struct BeforeUserRowEngine {
    entered: Arc<Notify>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    emit_first_before_gate: bool,
}

impl SessionEngine for BeforeUserRowEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        request: PromptRequest,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        if self.emit_first_before_gate {
            assert!(emit(EngineEvent::UserMessage(json!({
                "role": "user", "content": request.message, "timestamp": 1,
            }))));
        }
        self.entered.notify_one();
        // Dropping the sender on a failed assertion releases this blocking
        // thread too, so a red test cannot hang the Tokio runtime teardown.
        if self.release.lock().unwrap().recv().is_err() {
            emit(EngineEvent::DoneAborted);
            return;
        }
        if aborted() {
            emit(EngineEvent::DoneAborted);
        } else if !self.emit_first_before_gate {
            emit(EngineEvent::UserMessage(json!({
                "role": "user", "content": request.message, "timestamp": 1,
            })));
            emit(EngineEvent::Done(Ok(())));
        } else {
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

fn gated_runner(worker: &Arc<Worker>, engine: Arc<dyn SessionEngine>) -> TurnRunner {
    TurnRunner {
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
    }
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
    assert!(
        !latest.busy,
        "parked input cannot auto-replay after the ack"
    );
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
        emit_first_before_gate: false,
    });
    let entered_notify = Arc::clone(&engine.entered);
    let entered = entered_notify.notified();
    let runner = gated_runner(&worker, engine);
    let running = tokio::spawn(async move { runner.run().await });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered)
        .await
        .expect("turn never reached the pre-row gate");
    {
        let core = worker.core.lock().unwrap();
        assert!(
            core.busy && core.steering.is_empty(),
            "runner picked the batch"
        );
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
    assert_eq!(steering.len(), 2, "untouched originals need no generic continuation");
    assert_eq!(steering[0].message, "original with image");
    assert_eq!(steering[1].message, "batched second");
    assert_eq!(
        steering[0].preview.as_deref(),
        Some("preview original with image")
    );
    assert_eq!(
        steering[0].queue_key.as_deref(),
        Some("key:original with image")
    );
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
    let reopened = WorkerRecoveryJournal::open(&worker.config.recovery_journal_path).unwrap();
    let (restored, _) = restore_queue_snapshot_reconciled(
        &reopened,
        "target-session",
        &fixture_dir.join("session.jsonl"),
    )
    .unwrap();
    assert_eq!(restored.len(), 2);
    assert_eq!(restored[0].message, "original with image");
    assert_eq!(restored[0].images[0].data, "QUJD");
    assert_eq!(restored[0].admission_id.as_deref(), Some("admit:original with image"));
    running.abort();
    let _ = std::fs::remove_dir_all(fixture_dir);
}

/// A prefix custom row does not own the picked input. If only the first
/// accepted batch row lands, shutdown replays only the still uncommitted row.
#[tokio::test]
async fn shutdown_reconciles_partial_batch_after_prefix_row() {
    let worker = worker_with_journal();
    let fixture_dir = worker.config.socket_path.parent().unwrap();
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
    store.set_path(fixture_dir.join("partial-session.jsonl"));
    {
        let mut core = worker.core.lock().unwrap();
        core.created = true;
        core.store = Some(store);
        core.pending_next_turn.push(json!({
            "role": "custom", "customType": "restored_context",
            "content": "prefix", "display": true,
        }));
        for (message, images) in [
            ("first accepted", Vec::new()),
            (
                "second with image",
                vec![pa_agent::types::ImageContent {
                    data: "QUJD".to_string(),
                    mime_type: "image/png".to_string(),
                }],
            ),
        ] {
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Human,
                preview: Some(format!("preview {message}")),
                message: message.to_string(),
                custom_message: None,
                agent_message: Some(format!("agent:{message}")),
                queue_key: Some(format!("key:{message}")),
                admission_id: Some(format!("admit:{message}")),
                images,
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: true,
            });
        }
        core.forced_all_steering = true;
    }
    worker.checkpoint_queue(QueueCheckpoint::Admitted {
        operation: "prompt_accepted",
    });
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let engine = Arc::new(BeforeUserRowEngine {
        entered: Arc::new(Notify::new()),
        release: std::sync::Mutex::new(release_rx),
        emit_first_before_gate: true,
    });
    let entered = engine.entered.notified();
    let runner = gated_runner(&worker, engine);
    let running = tokio::spawn(async move { runner.run().await });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered)
        .await
        .expect("first batch row never committed");
    {
        let core = worker.core.lock().unwrap();
        assert!(core.busy && core.steering.is_empty());
        assert_eq!(core.store.as_ref().unwrap().message_count(), 1);
        assert!(core.in_flight_input[0].committed);
        assert!(!core.in_flight_input[1].attempted);
    }
    let stopping = Arc::clone(&worker);
    let shutdown = tokio::spawn(async move {
        stopping
            .handle_shutdown(&json!({
                "daemonShutdown": true, "shutdownAttemptId": "partial-batch-attempt",
            }))
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let core = worker.core.lock().unwrap();
            if core.shutdown_requested && core.abort_requested {
                break;
            }
            drop(core);
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("shutdown never armed its abort gate");
    release_tx.send(()).expect("release held engine");
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), shutdown)
        .await
        .expect("shutdown never settled")
        .expect("shutdown task panicked");
    assert!(reply.success, "shutdown failed: {reply:?}");
    assert_eq!(
        WorkerRecoveryJournal::read_shutdown_checkpoint(
            &worker.config.recovery_journal_path,
            "partial-batch-attempt",
            &worker.config.worker_instance_id,
        )
        .unwrap(),
        Some(crate::journal::ShutdownVerdict::BusyContinued)
    );
    let (steering, _) = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("shutdown queue snapshot");
    assert_eq!(steering.len(), 1, "only the unaccepted batch row remains");
    assert_eq!(steering[0].message, "second with image");
    assert!(steering.iter().all(|item| item.message != "first accepted"));
    assert_eq!(steering[0].images[0].data, "QUJD");
    assert_eq!(steering[0].agent_message.as_deref(), Some("agent:second with image"));
    assert_eq!(steering[0].admission_id.as_deref(), Some("admit:second with image"));
    assert!(steering[0].forced_batch);
    running.abort();
    let _ = std::fs::remove_dir_all(fixture_dir);
}

#[tokio::test]
async fn cancel_owned_picked_input_withdraws_its_durable_snapshot() {
    let worker = created_worker_with_journal().await;
    let item = QueuedItem {
        priority: QueuePriority::Human,
        preview: Some("owned preview".to_string()),
        message: "owned original".to_string(),
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: Some("owned-a".to_string()),
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
    };
    {
        let mut core = worker.core.lock().unwrap();
        core.busy = true;
        core.running_admission_ids.insert("owned-a".to_string());
        core.in_flight_input.push(super::session_core::InFlightInput {
            lane: Lane::Steering,
            row_id: "picked-owned-a".to_string(),
            item: queue_item_record(&item),
            attempted: false,
            committed: false,
            cancelled: false,
        });
    }
    checkpoint_picked_input(&worker.recovery, &worker.core).unwrap();
    let reply = worker.handle_cancel_prompt_admission(&json!({
        "admissionId": "owned-a", "cancelOwned": true,
    }));
    assert!(reply.success, "cancel failed: {reply:?}");
    assert_eq!(reply.data, Some(json!({ "status": "owned" })));
    let (steering, follow_up) = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("cancel checkpoint");
    assert!(steering.is_empty() && follow_up.is_empty());
    assert!(
        !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "cancelled last picked row cannot promise crash continuation",
    );
    assert!(worker.core.lock().unwrap().in_flight_input[0].cancelled);
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

#[tokio::test]
async fn failed_cancel_checkpoint_refuses_ack_and_holds_live_input() {
    let worker = created_worker_with_journal().await;
    let item = QueuedItem {
        priority: QueuePriority::Human,
        preview: None,
        message: "picked original".to_string(),
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: Some("owned-b".to_string()),
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
    };
    {
        let mut core = worker.core.lock().unwrap();
        core.busy = true;
        core.running_admission_ids.insert("owned-b".to_string());
        core.in_flight_input.push(super::session_core::InFlightInput {
            lane: Lane::Steering,
            row_id: "picked-owned-b".to_string(),
            item: queue_item_record(&item),
            attempted: false,
            committed: false,
            cancelled: false,
        });
    }
    checkpoint_picked_input(&worker.recovery, &worker.core).unwrap();
    let fixture_dir = worker.config.socket_path.parent().unwrap();
    let blocked = fixture_dir.join("blocked-cancel-journal");
    std::fs::write(&blocked, b"").unwrap();
    let blocked_journal = WorkerRecoveryJournal::open(&blocked).unwrap();
    std::fs::remove_file(&blocked).unwrap();
    std::fs::create_dir(&blocked).unwrap();
    *worker.recovery.lock().unwrap() = Some(blocked_journal);
    let reply = worker.handle_cancel_prompt_admission(&json!({
        "admissionId": "owned-b", "cancelOwned": true,
    }));
    assert!(!reply.success, "uncertain cancellation must not ack");
    let core = worker.core.lock().unwrap();
    assert!(core.recovery_hold && core.abort_requested);
    assert!(core.in_flight_input[0].cancelled);
    drop(core);
    let _ = std::fs::remove_dir_all(fixture_dir);
}

#[tokio::test]
async fn failed_pickup_checkpoint_parks_original_before_engine_entry() {
    let worker = created_worker_with_journal().await;
    let fixture_dir = worker.config.socket_path.parent().unwrap();
    let blocked = fixture_dir.join("blocked-pickup-journal");
    std::fs::write(&blocked, b"").unwrap();
    let blocked_journal = WorkerRecoveryJournal::open(&blocked).unwrap();
    std::fs::remove_file(&blocked).unwrap();
    std::fs::create_dir(&blocked).unwrap();
    *worker.recovery.lock().unwrap() = Some(blocked_journal);
    {
        let mut core = worker.core.lock().unwrap();
        core.steering.push_back(QueuedItem {
            priority: QueuePriority::Human,
            preview: None,
            message: "original before engine".to_string(),
            custom_message: None,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        });
    }
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let engine = Arc::new(BeforeUserRowEngine {
        entered: Arc::new(Notify::new()),
        release: std::sync::Mutex::new(release_rx),
        emit_first_before_gate: false,
    });
    let runner = gated_runner(&worker, engine);
    let running = tokio::spawn(async move { runner.run().await });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if worker.core.lock().unwrap().queued_input_suspended {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("failed pickup never parked");
    let core = worker.core.lock().unwrap();
    assert_eq!(core.steering.front().unwrap().message, "original before engine");
    assert!(core.in_flight_input.is_empty());
    assert_eq!(core.store.as_ref().unwrap().message_count(), 0);
    drop(core);
    drop(release_tx);
    running.abort();
    let _ = std::fs::remove_dir_all(fixture_dir);
}

#[tokio::test]
async fn held_live_input_reconciles_stable_id_before_explicit_resume() {
    let worker = created_worker_with_journal().await;
    let fixture_dir = worker.config.socket_path.parent().unwrap();
    let session_path = fixture_dir.join("accepted.jsonl");
    std::fs::write(&session_path, b"").unwrap();
    let item = QueuedItem {
        priority: QueuePriority::Human,
        preview: None,
        message: "retry only if unaccepted".to_string(),
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: None,
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
    };
    {
        let mut core = worker.core.lock().unwrap();
        core.store.as_mut().unwrap().set_path(session_path.clone());
        core.in_flight_input.push(super::session_core::InFlightInput {
            lane: Lane::Steering,
            row_id: "stable-picked-row".to_string(),
            item: queue_item_record(&item),
            attempted: true,
            committed: false,
            cancelled: false,
        });
        core.recovery_hold = true;
        core.queued_input_suspended = true;
    }
    checkpoint_picked_input(&worker.recovery, &worker.core).unwrap();
    std::fs::write(&session_path, b"{torn\n").unwrap();
    let uncertain = worker.handle_resume_queue(&json!({
        "resumeQueueAttemptId": "invalid-session-attempt",
    }));
    assert!(!uncertain.success, "torn session row cannot justify replay");
    assert!(worker.core.lock().unwrap().recovery_hold);
    std::fs::write(&session_path, b"").unwrap();
    let resumed = worker.handle_resume_queue(&json!({
        "resumeQueueAttemptId": "live-resume-attempt",
    }));
    assert!(resumed.success, "explicit resume failed: {resumed:?}");
    {
        let core = worker.core.lock().unwrap();
        assert!(!core.recovery_hold && !core.queued_input_suspended);
        assert!(core.in_flight_input.is_empty());
        assert_eq!(core.steering.front().unwrap().message, "retry only if unaccepted");
    }
    assert!(WorkerRecoveryJournal::read_resume_checkpoint(
        &worker.config.recovery_journal_path,
        "live-resume-attempt",
        &worker.config.worker_instance_id,
    )
    .unwrap());
    let _ = std::fs::remove_dir_all(fixture_dir);
}

#[tokio::test]
async fn ordinary_busy_resume_does_not_requeue_its_active_input() {
    let worker = created_worker_with_journal().await;
    let item = QueuedItem {
        priority: QueuePriority::Human,
        preview: None,
        message: "still running".to_string(),
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: None,
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
    };
    {
        let mut core = worker.core.lock().unwrap();
        core.busy = true;
        core.in_flight_input.push(super::session_core::InFlightInput {
            lane: Lane::Steering,
            row_id: "ordinary-running-id".to_string(),
            item: queue_item_record(&item),
            attempted: false,
            committed: false,
            cancelled: false,
        });
    }
    checkpoint_picked_input(&worker.recovery, &worker.core).unwrap();
    let _ = worker.handle_resume_queue(&json!({
        "resumeQueueAttemptId": "ordinary-resume-attempt",
    }));
    let core = worker.core.lock().unwrap();
    assert!(core.busy);
    assert_eq!(core.in_flight_input.len(), 1);
    assert!(core.steering.is_empty() && core.follow_up.is_empty());
    drop(core);
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

#[tokio::test]
async fn sync_uncertain_accepted_id_is_not_replayed_on_explicit_resume() {
    let worker = created_worker_with_journal().await;
    let fixture_dir = worker.config.socket_path.parent().unwrap();
    let session_path = fixture_dir.join("uncertain-session.jsonl");
    std::fs::write(
        &session_path,
        b"{\"id\":\"accepted-stable-id\",\"type\":\"message\"}\n",
    )
    .unwrap();
    let item = QueuedItem {
        priority: QueuePriority::Human,
        preview: None,
        message: "accepted already".to_string(),
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: None,
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
    };
    {
        let mut core = worker.core.lock().unwrap();
        core.store.as_mut().unwrap().set_path(session_path);
        core.in_flight_input.push(super::session_core::InFlightInput {
            lane: Lane::Steering,
            row_id: "accepted-stable-id".to_string(),
            item: queue_item_record(&item),
            attempted: true,
            committed: false,
            cancelled: false,
        });
        core.recovery_hold = true;
        core.queued_input_suspended = true;
    }
    checkpoint_picked_input(&worker.recovery, &worker.core).unwrap();
    let reply = worker.handle_resume_queue(&json!({
        "resumeQueueAttemptId": "accepted-id-resume",
    }));
    assert!(!reply.success, "there is no unaccepted work left");
    {
        let core = worker.core.lock().unwrap();
        assert!(!core.recovery_hold && !core.queued_input_suspended);
        assert!(core.in_flight_input.is_empty());
        assert!(core.steering.is_empty() && core.follow_up.is_empty());
    }
    assert!(WorkerRecoveryJournal::read_resume_checkpoint(
        &worker.config.recovery_journal_path,
        "accepted-id-resume",
        &worker.config.worker_instance_id,
    )
    .unwrap());
    let _ = std::fs::remove_dir_all(fixture_dir);
}

#[tokio::test]
async fn abort_ack_durably_withdraws_last_picked_original() {
    let worker = created_worker_with_journal().await;
    let item = QueuedItem {
        priority: QueuePriority::Human,
        preview: None,
        message: "abort this original".to_string(),
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: None,
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
    };
    {
        let mut core = worker.core.lock().unwrap();
        core.busy = true;
        core.in_flight_input.push(super::session_core::InFlightInput {
            lane: Lane::Steering,
            row_id: "abort-picked-id".to_string(),
            item: queue_item_record(&item),
            attempted: false,
            committed: false,
            cancelled: false,
        });
    }
    checkpoint_picked_input(&worker.recovery, &worker.core).unwrap();
    let reply = worker.dispatch("abort", &json!({})).await;
    assert!(reply.success, "abort failed: {reply:?}");
    assert!(worker.core.lock().unwrap().in_flight_input[0].cancelled);
    assert!(
        !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
        "acknowledged abort cannot leave a busy replay verdict",
    );
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

#[tokio::test]
async fn closed_mutation_gate_rejects_injected_continuation() {
    let worker = created_worker_with_journal().await;
    worker.core.lock().unwrap().shutdown_requested = true;
    admit_autonomous_follow_up(
        &worker.recovery,
        &worker.core,
        &Arc::new(Notify::new()),
        "too late to continue".to_string(),
    );
    let core = worker.core.lock().unwrap();
    assert!(core.steering.is_empty() && core.follow_up.is_empty());
    drop(core);
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}

#[tokio::test]
async fn prompt_past_precheck_cannot_enqueue_after_shutdown_gate() {
    let worker = created_worker_with_journal().await;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    *worker.prompt_enqueue_gate.lock().unwrap() = Some(PromptEnqueueGate {
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
    });
    let prompt_worker = Arc::clone(&worker);
    let prompt = tokio::spawn(async move {
        prompt_worker
            .handle_prompt(
                &json!({ "message": "late prompt", "admissionId": "late-admission" }),
                false,
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
        .await
        .expect("prompt never passed its precheck");
    worker.core.lock().unwrap().shutdown_requested = true;
    release.notify_one();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), prompt)
        .await
        .expect("prompt did not leave gate")
        .expect("prompt task panicked");
    assert!(!reply.success, "late prompt cannot be acknowledged");
    let core = worker.core.lock().unwrap();
    assert!(core.steering.is_empty() && core.follow_up.is_empty());
    drop(core);
    assert_eq!(worker.prompt_admissions.cancel("late-admission"), None);
    let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
}
