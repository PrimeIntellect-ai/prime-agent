//! Worker tests (moved with their concerns).
use super::*;

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

    /// An idle-time injected continuation is journal busy evidence: the
    /// admission (not the pickup) proves the work, so a plain boot revives
    /// the worker to deliver it.
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

    /// The detached bash completion notice admits through the steering
    /// lane: an idle session wakes on an invisible injected row, and the
    /// admission is journal busy evidence (the crash between the notice
    /// and its delivery revives the worker with the row replaying — the
    /// wake survives re-adoption and revival alike).
    #[tokio::test]
    async fn a_bash_completion_notice_admits_the_steering_lane_with_busy_evidence() {
        let worker = created_worker_with_journal().await;
        worker.dispatch("clear_queue", &json!({})).await;
        let notify = Arc::new(Notify::new());
        admit_bash_completion_notice(
            &worker.recovery,
            &worker.core,
            &notify,
            crate::engine::BashCompletionNotice {
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
        // TS `queueVisible: visibleQueued`: an idle session's wake is an
        // invisible injected turn.
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

    /// A busy session queues the notice as a visible steer row (TS
    /// `queueIfBusy`), the same row with the queued delivery class.
    #[tokio::test]
    async fn a_bash_completion_notice_on_a_busy_session_queues_a_visible_steer_row() {
        let worker = created_worker_with_journal().await;
        worker.core.lock().unwrap().busy = true;
        let notify = Arc::new(Notify::new());
        admit_bash_completion_notice(
            &worker.recovery,
            &worker.core,
            &notify,
            crate::engine::BashCompletionNotice {
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

    /// The kernel read the result first: the undelivered notice withdraws
    /// (pid+command — pids are reused), and the withdrawal settles the
    /// busy evidence so the journal never promises a replay the row left.
    #[tokio::test]
    async fn bash_consumed_withdraws_the_undelivered_notice_and_settles() {
        let worker = created_worker_with_journal().await;
        worker.dispatch("clear_queue", &json!({})).await;
        let notify = Arc::new(Notify::new());
        admit_bash_completion_notice(
            &worker.recovery,
            &worker.core,
            &notify,
            crate::engine::BashCompletionNotice {
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
            crate::engine::BashConsumedNotice {
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
            crate::engine::BashConsumedNotice {
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

    /// Dropping a cancelled admission settles the verdict: the cancelled
    /// rows leave no busy evidence and no replayable snapshot.
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
        worker.drop_queued_admitted_prompt("a1");
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

    /// A withdrawal landing mid-turn settles the rows but never the
    /// verdict: the in-flight turn is live work (TS computes settled
    /// busy from `isSessionActive`, never from the lanes alone), so a
    /// crash after the withdrawal still reads interrupted. Only the
    /// turn's own `turn_end` — after the runner's idle flip — settles
    /// the same empty lanes back to idle.
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
        // The turn ends: the runner's idle flip precedes its settle, so
        // the same empty lanes now record busy=false.
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
