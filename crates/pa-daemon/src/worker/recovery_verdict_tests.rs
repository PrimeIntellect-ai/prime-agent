//! Worker tests.
mod completed;
mod panic;

use super::*;
use crate::engine::{
    CompactionOutcome, CompactionRequest, PromptRequest, SessionEngine, SideQuestionOutcome,
    SideQuestionRequest,
};
use std::path::Path;

mod cancellation;

/// Holds the engine before the first or second durable user row. Shutdown
/// closes input before the async test releases the blocking thread.
struct BeforeUserRowEngine {
    entered: Arc<Notify>,
    captured: std::sync::Mutex<Option<Value>>,
    boundary: UserRowBoundary,
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
        *self.captured.lock().unwrap() = Some(json!({
            "message": request.message,
            "images": request.images,
            "batch": request.batch.iter().map(|row| json!({
                "text": row.text, "images": row.images,
            })).collect::<Vec<_>>(),
        }));
        if matches!(
            self.boundary,
            UserRowBoundary::AfterFirst | UserRowBoundary::AfterFirstPanic
        ) {
            let mut content = vec![json!({ "type": "text", "text": request.message })];
            content.extend(request.images.iter().map(|image| {
                json!({
                    "type": "image", "data": image.data, "mimeType": image.mime_type,
                })
            }));
            assert!(
                emit(EngineEvent::UserMessage(json!({
                    "role": "user", "content": content, "timestamp": 1,
                }))),
                "the first input must reach the real worker persistence callback"
            );
        }
        self.entered.notify_one();
        // Dropping the sender on a failed assertion releases this blocking
        // thread too, so a red test cannot hang the Tokio runtime teardown.
        if self.release.lock().unwrap().recv().is_err() {
            emit(EngineEvent::DoneAborted);
            return;
        }
        if matches!(self.boundary, UserRowBoundary::AfterFirstPanic) {
            // The persistence callback has returned and the channel guard has
            // dropped. This panic cannot poison the worker core or gate mutex.
            assert!(
                aborted(),
                "shutdown must close input before the engine panic"
            );
            panic!("isolated engine panic after the durable first input");
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
    worker_with_journal_in(&dir)
}

fn worker_with_journal_in(dir: &Path) -> Arc<Worker> {
    std::fs::create_dir_all(dir).unwrap();
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
    let (steering, follow_up, _) = WorkerRecoveryJournal::read_queue_snapshot(
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
    admit_kernel_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        crate::engine::KernelNotice::bash_completion(4321, "sleep 12; echo RW_WAKE_DONE", 0),
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
    let (steering, _, _) = WorkerRecoveryJournal::read_queue_snapshot(
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
    admit_kernel_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        crate::engine::KernelNotice::bash_completion(99, "make gates", 2),
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
    admit_kernel_notice(
        &worker.recovery,
        &worker.core,
        &notify,
        crate::engine::KernelNotice::bash_completion(4321, "sleep 12; echo RW_WAKE_DONE", 0),
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
        Some(worker.engine.as_ref()),
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
        /*engine*/
        None, // A retired engine must not prevent withdrawal or its checkpoint.
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
    let (steering, follow_up, _) = WorkerRecoveryJournal::read_queue_snapshot(
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
    let (steering, follow_up, _) = WorkerRecoveryJournal::read_queue_snapshot(
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

/// The supervisor may escalate the stop as soon as the worker's shutdown
/// reply lands. That reply must therefore prove the final recovery verdict
/// is durable: an exit-path write can be lost to the escalation, and the
/// boot would then revive (or drop) the session off a stale row.
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

/// The shutdown close still acknowledges when the final verdict cannot
/// persist (a journal that cannot be written): the close must complete —
/// the supervisor owns the recovery. (Restored from Kevin Thomas's original
/// `shutdown_does_not_ack_when_its_final_verdict_cannot_persist`, with the
/// assertion flipped to the ruled ACK-on-failed-write behavior.)
#[tokio::test]
async fn shutdown_still_acks_when_its_final_verdict_cannot_persist() {
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
        reply.success,
        "the lost verdict must not wedge the close; the boot owns the recovery"
    );
    let _ = std::fs::remove_dir_all(fixture_dir);
}

#[tokio::test]
async fn shutdown_before_first_user_row_preserves_the_picked_prompt() {
    shutdown_preserves_picked_batch(UserRowBoundary::BeforeFirst).await;
}

#[tokio::test]
async fn shutdown_after_first_user_row_preserves_the_unaccepted_batch_tail() {
    shutdown_preserves_picked_batch(UserRowBoundary::AfterFirst).await;
}

#[derive(Clone, Copy)]
enum UserRowBoundary {
    BeforeFirst,
    AfterFirst,
    AfterFirstPanic,
}

async fn shutdown_preserves_picked_batch(boundary: UserRowBoundary) {
    let fixture = tempfile::tempdir().unwrap();
    let fixture_dir = fixture.path();
    let worker = worker_with_journal_in(fixture_dir);
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
    let mut store = SessionFile::create(fixture_dir.to_str().unwrap(), None, 0);
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
            (
                "batched second",
                match boundary {
                    UserRowBoundary::BeforeFirst => Vec::new(),
                    UserRowBoundary::AfterFirst | UserRowBoundary::AfterFirstPanic => {
                        vec![pa_agent::types::ImageContent {
                            data: "REVG".to_string(),
                            mime_type: "image/png".to_string(),
                        }]
                    }
                },
            ),
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
        captured: std::sync::Mutex::new(None),
        boundary,
        release: std::sync::Mutex::new(release_rx),
    });
    let entered_notify = Arc::clone(&engine.entered);
    let entered = entered_notify.notified();
    let runner = gated_turn_runner(&worker, engine.clone());
    let running = tokio::spawn(async move { runner.run().await });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered)
        .await
        .expect("turn never reached the pre-row gate");
    {
        let core = worker.core.lock().unwrap();
        assert!(
            core.busy && core.steering.is_empty() && core.follow_up.is_empty(),
            "runner picked the batch"
        );
        assert_eq!(
            core.store.as_ref().unwrap().message_count(),
            match boundary {
                UserRowBoundary::BeforeFirst => 0,
                UserRowBoundary::AfterFirst | UserRowBoundary::AfterFirstPanic => 1,
            }
        );
    }

    let tail_images = match boundary {
        UserRowBoundary::BeforeFirst => json!([]),
        UserRowBoundary::AfterFirst | UserRowBoundary::AfterFirstPanic => {
            json!([{ "data": "REVG", "mimeType": "image/png" }])
        }
    };
    if matches!(
        boundary,
        UserRowBoundary::AfterFirst | UserRowBoundary::AfterFirstPanic
    ) {
        let disk_rows: Vec<Value> = std::fs::read_to_string(fixture_dir.join("session.jsonl"))
            .expect("first input must already be in the physical transcript")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|row| row["type"] == "message" && row["message"]["role"] == "user")
            .map(|row| row["message"].clone())
            .collect();
        assert_eq!(
            disk_rows,
            vec![json!({
                "role": "user", "timestamp": 1,
                "content": [
                    { "type": "text", "text": "original with image" },
                    { "type": "image", "data": "QUJD", "mimeType": "image/png" },
                ],
            })],
            "the first-row control proves durable acceptance before shutdown, not inferred text matching"
        );
    }
    assert_eq!(
        engine.captured.lock().unwrap().as_ref().unwrap(),
        &json!({
            "message": "original with image",
            "images": [{ "data": "QUJD", "mimeType": "image/png" }],
            "batch": [{ "text": "batched second", "images": tail_images }],
        }),
        "the held engine owns the original text, image and batched tail"
    );

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
    tokio::time::timeout(std::time::Duration::from_secs(5), running)
        .await
        .expect("the gated runner never exited")
        .expect("the gated runner panicked");
    if matches!(boundary, UserRowBoundary::AfterFirstPanic) {
        let core = worker
            .core
            .lock()
            .expect("an engine panic outside the callback must not poison the core");
        assert!(core.shutdown_requested && core.abort_requested);
        assert!(
            !core.busy,
            "the panicked engine must settle its actual turn"
        );
    }
    // Recover from the files, not the picked batch or the old in-memory store.
    // Either durable user rows or pending queue rows may retain the input;
    // this oracle does not prescribe which persistence boundary owns it.
    let transcript = match std::fs::read_to_string(fixture_dir.join("session.jsonl")) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => panic!("read the isolated transcript: {error}"),
    };
    let mut recovered: Vec<String> = transcript
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|row| row["type"] == "message" && row["message"]["role"] == "user")
        .map(|row| {
            let content = &row["message"]["content"];
            match content.as_str() {
                Some(text) => text.to_string(),
                None => content
                    .as_array()
                    .expect("user content is text or content blocks")
                    .iter()
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(""),
            }
        })
        .collect();
    let (steering, follow_up, _) = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("shutdown queue snapshot");
    if matches!(boundary, UserRowBoundary::AfterFirstPanic) {
        let pending: Vec<Value> = steering
            .iter()
            .chain(&follow_up)
            .filter(|item| {
                item.message != crate::update_restore::UPDATE_RESTART_CONTINUATION_PROMPT
            })
            .map(|item| serde_json::to_value(item).unwrap())
            .collect();
        assert_eq!(
            pending,
            vec![json!({
                "message": "batched second",
                "priority": "human",
                "preview": "preview batched second",
                "queue_key": "key:batched second",
                "queue_visible": true,
                "policy": "queued",
                "forced_batch": false,
                "images": [{ "data": "REVG", "mimeType": "image/png" }],
            })],
            "panic must not replay the physically accepted primary alongside its unaccepted tail"
        );
    }
    let recovered_payloads = if matches!(
        boundary,
        UserRowBoundary::AfterFirst | UserRowBoundary::AfterFirstPanic
    ) {
        let mut payloads: Vec<Value> = transcript
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|row| row["type"] == "message" && row["message"]["role"] == "user")
            .map(|row| {
                let content = row["message"]["content"].as_array().unwrap();
                let text = content
                    .iter()
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("");
                let images: Vec<_> = content
                    .iter()
                    .filter(|block| block["type"] == "image")
                    .map(|block| json!({ "data": block["data"], "mimeType": block["mimeType"] }))
                    .collect();
                json!({ "text": text, "images": images })
            })
            .collect();
        payloads.extend(
            steering
                .iter()
                .chain(&follow_up)
                .filter(|item| item.message != crate::update_restore::UPDATE_RESTART_CONTINUATION_PROMPT)
                .map(|item| {
                    let record = serde_json::to_value(item).unwrap();
                    json!({ "text": item.message, "images": record.get("images").cloned().unwrap_or_else(|| json!([])) })
                }),
        );
        Some(payloads)
    } else {
        None
    };
    recovered.extend(
        steering
            .into_iter()
            .chain(follow_up)
            .map(|item| item.message),
    );
    // A generic continuation may coexist, but cannot stand in for either
    // original. Preserve every other row to catch duplicates and wrong input.
    recovered.retain(|text| text != crate::update_restore::UPDATE_RESTART_CONTINUATION_PROMPT);
    assert_eq!(
        recovered,
        vec![
            "original with image".to_string(),
            "batched second".to_string(),
        ],
        "shutdown lost or duplicated original input at the held batch boundary"
    );
    if let Some(payloads) = recovered_payloads {
        assert_eq!(
            payloads,
            vec![
                json!({ "text": "original with image", "images": [{ "data": "QUJD", "mimeType": "image/png" }] }),
                json!({ "text": "batched second", "images": [{ "data": "REVG", "mimeType": "image/png" }] }),
            ],
            "partial-batch recovery must preserve exact image association without duplicates"
        );
    }
}

#[tokio::test]
async fn resumed_queue_restarts_unsuspended_and_delivers_the_same_input() {
    let fixture = tempfile::tempdir().unwrap();
    let session_path = fixture.path().join("session.jsonl");
    let mut session = SessionFile::create(fixture.path().to_str().unwrap(), None, 0);
    session.set_path(session_path.clone());
    session.rewrite().unwrap();
    let worker = worker_with_journal_in(fixture.path());
    let created = worker
        .dispatch(
            "create",
            &json!({ "sessionPath": session_path, "cwd": fixture.path() }),
        )
        .await;
    assert!(created.success, "create isolated session: {created:?}");
    let paused = worker
        .dispatch(
            "acquire_session_input_pause",
            &json!({
                "leaseKey": "resume-restart-gate", "clientId": "synthetic-client",
            }),
        )
        .await;
    assert!(paused.success, "acquire actual input pause: {paused:?}");
    assert!(worker.input_pauses.paused());
    let admitted = worker
        .dispatch(
            "follow_up",
            &json!({ "message": "synthetic resumed queued input" }),
        )
        .await;
    assert!(
        admitted.success,
        "admit the visible queued input: {admitted:?}"
    );
    let aborted = worker.dispatch("abort", &json!({})).await;
    assert!(aborted.success, "abort parks queued input: {aborted:?}");
    // An idle abort has no turn-end checkpoint. The real update snapshot is
    // the positive durable suspension boundary before the resume under test.
    let snapshot = worker.dispatch("update_snapshot", &json!({})).await;
    assert!(
        snapshot.success,
        "persist actual parked snapshot: {snapshot:?}"
    );
    let (parked_steering, parked_follow_up, parked_suspended) =
        WorkerRecoveryJournal::read_queue_snapshot(
            &worker.config.recovery_journal_path,
            "target-session",
        )
        .unwrap()
        .expect("parked input is physically checkpointed");
    assert!(
        parked_suspended,
        "the fixture must first prove durable suspension"
    );
    assert!(parked_steering.is_empty());
    assert_eq!(parked_follow_up.len(), 1);
    assert_eq!(
        parked_follow_up[0].message,
        "synthetic resumed queued input"
    );
    let expected_queue = serde_json::to_value(&parked_follow_up).unwrap();
    let resumed = worker.dispatch("resume_queue", &json!({})).await;
    assert!(
        resumed.success,
        "resume should acknowledge queued work: {resumed:?}"
    );
    {
        let core = worker.core.lock().unwrap();
        assert!(
            !core.queued_input_suspended,
            "actual resume clears the live suspension"
        );
        assert!(core.steering.is_empty());
        assert_eq!(core.follow_up.len(), 1);
        assert_eq!(
            core.store.as_ref().unwrap().message_count(),
            0,
            "the actual input pause excludes pickup and transcript acceptance"
        );
    }
    assert!(
        worker.input_pauses.paused(),
        "resume must not release the independent input pause"
    );
    // Simulate losing this worker without graceful shutdown altering its queue.
    // The new worker must acquire the single journal/session writer leases.
    worker.release_session_lease();
    drop(worker.recovery.lock().unwrap().take());
    let reopened_snapshot = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("physical snapshot survives the original writer");
    assert_eq!(
        serde_json::to_value(&reopened_snapshot.1).unwrap(),
        expected_queue,
        "restart must retain the exact original queue record"
    );
    let restarted = worker_with_journal_in(fixture.path());
    let mut subscription = restarted.events.subscribe();
    let created = restarted
        .dispatch(
            "create",
            &json!({ "sessionPath": session_path, "cwd": fixture.path() }),
        )
        .await;
    assert!(
        created.success,
        "new worker must restore from actual disk: {created:?}"
    );
    assert!(
        !restarted.core.lock().unwrap().queued_input_suspended,
        "a restart after acknowledged resume must restore the queue unsuspended"
    );
    assert!(
        !reopened_snapshot.2,
        "resume acknowledgement must durably clear suspension"
    );
    let accepted = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let frame = subscription.recv().await.expect("new worker event stream");
            if frame.outbound_type != "session_event" {
                continue;
            }
            let outbound: Value = serde_json::from_slice(&frame.payload).unwrap();
            let event = &outbound["event"];
            if event["type"] == "message_end" && event["message"]["role"] == "user" {
                break event["message"]["content"].clone();
            }
        }
    })
    .await
    .expect("restored resumed input must actually reach the new runner");
    assert_eq!(accepted, json!("synthetic resumed queued input"));
}

#[tokio::test]
async fn failed_resume_checkpoint_keeps_live_suspension_and_exact_queued_input() {
    let fixture = tempfile::tempdir().unwrap();
    let worker = worker_with_journal_in(fixture.path());
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": fixture.path() }),
        )
        .await;
    assert!(created.success, "create isolated worker: {created:?}");
    let paused = worker
        .dispatch(
            "acquire_session_input_pause",
            &json!({ "leaseKey": "failed-resume-gate", "clientId": "synthetic-client" }),
        )
        .await;
    assert!(paused.success, "acquire actual input pause: {paused:?}");
    let admitted = worker
        .dispatch(
            "follow_up",
            &json!({ "message": "synthetic parked input after failed resume" }),
        )
        .await;
    assert!(admitted.success, "admit isolated queue input: {admitted:?}");
    assert!(worker.dispatch("abort", &json!({})).await.success);
    assert!(worker.dispatch("update_snapshot", &json!({})).await.success);
    let parked = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("actual snapshot durably parks this input");
    assert!(parked.2, "failure fixture starts durably suspended");
    assert!(parked.0.is_empty());
    assert_eq!(parked.1.len(), 1);
    let expected = {
        let core = worker.core.lock().unwrap();
        assert!(core.queued_input_suspended);
        let lanes = queue_lanes(&core);
        json!({ "steering": lanes.steering, "follow_up": lanes.follow_up })
    };
    let journal_path = &worker.config.recovery_journal_path;
    let preserved_path = fixture.path().join("preserved-recovery.jsonl");
    let preserved_bytes = std::fs::read(journal_path).unwrap();
    // The journal opens an append handle per record. Keep its existing writer
    // lease while making only this fixture's append path fail on every platform.
    std::fs::rename(journal_path, &preserved_path).unwrap();
    std::fs::create_dir(journal_path).unwrap();
    let resumed = worker.dispatch("resume_queue", &json!({})).await;
    assert!(
        !resumed.success,
        "failed persistence must be reported: {resumed:?}"
    );
    assert!(resumed.error.is_some());
    {
        let core = worker.core.lock().unwrap();
        assert!(
            core.queued_input_suspended,
            "failed resume must not publish an unsuspended live queue"
        );
        let lanes = queue_lanes(&core);
        assert_eq!(
            json!({ "steering": lanes.steering, "follow_up": lanes.follow_up }),
            expected,
            "failure must preserve every original queue field"
        );
        assert!(!core.busy, "the independent pause must exclude pickup");
        assert_eq!(core.store.as_ref().unwrap().message_count(), 0);
    }
    assert!(worker.input_pauses.paused());
    assert_eq!(std::fs::read(&preserved_path).unwrap(), preserved_bytes);
    let durable = WorkerRecoveryJournal::read_queue_snapshot(&preserved_path, "target-session")
        .unwrap()
        .expect("the original durable ownership evidence remains readable");
    assert_eq!(
        serde_json::to_value(durable).unwrap(),
        serde_json::to_value(parked).unwrap()
    );
}

/// An idle compaction holds no picked input, so a resume during it persists
/// the cleared suspension like any idle resume: a restart before pickup must
/// not park the acknowledged work again.
#[tokio::test]
async fn resume_during_idle_compaction_durably_clears_the_suspension() {
    let fixture = tempfile::tempdir().unwrap();
    let worker = worker_with_journal_in(fixture.path());
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": fixture.path() }),
        )
        .await;
    assert!(created.success, "create isolated worker: {created:?}");
    let paused = worker
        .dispatch(
            "acquire_session_input_pause",
            &json!({ "leaseKey": "compacting-resume-gate", "clientId": "synthetic-client" }),
        )
        .await;
    assert!(paused.success, "acquire actual input pause: {paused:?}");
    let admitted = worker
        .dispatch(
            "follow_up",
            &json!({ "message": "synthetic input resumed mid-compaction" }),
        )
        .await;
    assert!(admitted.success, "admit isolated queue input: {admitted:?}");
    assert!(worker.dispatch("abort", &json!({})).await.success);
    assert!(worker.dispatch("update_snapshot", &json!({})).await.success);
    let parked = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("actual snapshot durably parks this input");
    assert!(parked.2, "the fixture starts durably suspended");
    {
        let mut core = worker.core.lock().unwrap();
        assert!(!core.busy);
        core.compacting = true;
    }
    let resumed = worker.dispatch("resume_queue", &json!({})).await;
    assert!(
        resumed.success,
        "resume acknowledges queued work: {resumed:?}"
    );
    let durable = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("the resume checkpoint keeps the queue snapshot");
    assert!(
        !durable.2,
        "an acknowledged resume during an idle compaction must durably clear the suspension"
    );
    assert_eq!(
        serde_json::to_value(&durable.1).unwrap(),
        serde_json::to_value(&parked.1).unwrap(),
        "the resume checkpoint keeps the exact queued input"
    );
}

fn gated_turn_runner(worker: &Worker, engine: Arc<dyn SessionEngine>) -> TurnRunner {
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

#[tokio::test(flavor = "current_thread")]
async fn already_resumed_active_turn_keeps_its_original_durable_queue_snapshot() {
    let fixture = tempfile::tempdir().unwrap();
    let session_path = fixture.path().join("session.jsonl");
    let mut session = SessionFile::create(fixture.path().to_str().unwrap(), None, 0);
    session.set_path(session_path.clone());
    session.rewrite().unwrap();
    let worker = worker_with_journal_in(fixture.path());
    let created = worker
        .dispatch(
            "create",
            &json!({ "sessionPath": session_path, "cwd": fixture.path() }),
        )
        .await;
    assert!(
        created.success,
        "create isolated durable worker: {created:?}"
    );
    let paused = worker
        .dispatch(
            "acquire_session_input_pause",
            &json!({ "leaseKey": "active-resume-gate", "clientId": "synthetic-client" }),
        )
        .await;
    assert!(paused.success, "hold the native runner: {paused:?}");
    let native_park = worker.idle_notify.notified();
    let admitted = worker
        .dispatch(
            "follow_up",
            &json!({ "message": "synthetic picked input before its first row" }),
        )
        .await;
    assert!(
        admitted.success,
        "durably admit original input: {admitted:?}"
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), native_park)
        .await
        .expect("native runner must observe the actual input pause and park");
    let before = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("admission persisted the original queue");
    assert!(!before.2, "this resume is already an unsuspended no-op");
    assert!(before.0.is_empty());
    assert_eq!(before.1.len(), 1);
    let items = {
        let mut core = worker.core.lock().unwrap();
        assert!(!core.queued_input_suspended);
        // Drive the real pickup primitive and turn callback while the actual
        // input pause keeps Worker::new's native runner parked. This is not a
        // native run-loop/release-pause scheduling race fixture.
        let items = gather_delivery_batch(&mut core, Lane::FollowUp);
        core.running_admission_ids = items
            .iter()
            .filter_map(|item| item.admission_id.clone())
            .collect();
        core.busy = true;
        items
    };
    let (release, released) = std::sync::mpsc::channel();
    let engine = Arc::new(BeforeUserRowEngine {
        entered: Arc::new(Notify::new()),
        captured: std::sync::Mutex::new(None),
        boundary: UserRowBoundary::BeforeFirst,
        release: std::sync::Mutex::new(released),
    });
    let entered_notify = Arc::clone(&engine.entered);
    let entered = entered_notify.notified();
    let runner = gated_turn_runner(&worker, engine.clone());
    let running = tokio::spawn(async move {
        runner.run_turn(engine, Lane::FollowUp, items).await;
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered)
        .await
        .expect("picked original must reach the pre-row engine gate");
    {
        let core = worker.core.lock().unwrap();
        assert!(core.busy);
        assert!(core.steering.is_empty() && core.follow_up.is_empty());
        assert_eq!(core.store.as_ref().unwrap().message_count(), 0);
    }
    let resumed = worker.dispatch("resume_queue", &json!({})).await;
    assert!(
        !resumed.success,
        "legacy no queued work response: {resumed:?}"
    );
    assert_eq!(resumed.error.as_deref(), Some("No queued work to resume"));
    let after = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("original queue recovery evidence must remain");
    assert_eq!(
        serde_json::to_value(after).unwrap(),
        serde_json::to_value(before).unwrap(),
        "an already-resumed active turn must not replace its original queue with an empty snapshot"
    );
    // Dropping the gate sender on any preceding failed assertion releases
    // the blocking engine too; successful teardown joins only this fixture.
    worker.core.lock().unwrap().abort_requested = true;
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), running)
        .await
        .expect("the test-owned turn must settle")
        .unwrap();
}
