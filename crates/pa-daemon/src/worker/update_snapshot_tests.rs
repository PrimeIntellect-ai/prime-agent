//! Worker tests (moved with their concerns).
    use crate::*;

    async fn snapshot_after_create() -> (Arc<Worker>, DaemonResponse) {
        let dir = std::env::temp_dir().join(format!("pa-worker-us-{}", uuid::Uuid::new_v4()));
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
        // snapshot flush has the same durable sink as production.
        *worker.recovery.lock().unwrap() =
            Some(WorkerRecoveryJournal::open(&worker.config.recovery_journal_path).unwrap());
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
            )
            .await;
        assert!(created.success, "create must succeed: {created:?}");
        let response = worker.dispatch("update_snapshot", &json!({})).await;
        (worker, response)
    }

    /// TS `queuedAgentMessagePreview`: the queue action rows serve a
    /// delivery's labeled preview when it carries one, while the raw
    /// steering lane keeps the message text (TS `getSteeringMessages`).
    #[tokio::test]
    async fn queue_action_rows_serve_the_labeled_preview() {
        let (worker, _) = snapshot_after_create().await;
        {
            let mut core = worker.core.lock().unwrap();
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Background,
                message: "[heartbeat: every 10m run#0]\n\nnudge the mission".to_string(),
                preview: Some(
                    "Heartbeat prompt: [heartbeat: every 10m run#0]\n\nnudge the mission"
                        .to_string(),
                ),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Injected,
                forced_batch: false,
            });
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Human,
                message: "plain queued prompt".to_string(),
                preview: None,
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
        let response = worker.dispatch("update_snapshot", &json!({})).await;
        assert!(response.success);
        let data = response.data.expect("snapshot data");
        assert_eq!(
            data["queue"]["actions"]["steering"],
            json!([
                "Heartbeat prompt: [heartbeat: every 10m run#0]\n\nnudge the mission",
                "plain queued prompt",
            ]),
            "the action rows must serve the labeled preview"
        );
        assert_eq!(
            data["queue"]["steering"],
            json!([
                "[heartbeat: every 10m run#0]\n\nnudge the mission",
                "plain queued prompt",
            ]),
            "the raw lane keeps the message text"
        );
        assert_eq!(data["queue"]["actions"]["queuedCount"], 2);
    }

    #[tokio::test]
    async fn update_snapshot_reports_the_session_and_flushes_the_journal() {
        let (worker, response) = snapshot_after_create().await;
        assert!(response.success, "snapshot must succeed: {response:?}");
        let data = response.data.expect("snapshot data");
        // The no-session worker has no durable session file: the active id
        // still identifies the worker's session.
        assert_eq!(data["activeSessionId"], "target-session");
        assert_eq!(data["cwd"], "/tmp");
        assert_eq!(data["busy"], false);
        assert_eq!(data["compacting"], false);
        assert_eq!(data["runtimeMetadata"]["kind"], "top-level");
        assert!(data["queue"]["actions"].is_object());
        // The flush happened before the reply: the recovery journal has a
        // queue snapshot record for this session.
        let snapshot = WorkerRecoveryJournal::read_queue_snapshot(
            &worker.config.recovery_journal_path,
            "target-session",
        )
        .expect("journal is readable");
        assert!(snapshot.is_some(), "the queue lanes were flushed");
    }

    #[tokio::test]
    async fn update_snapshot_reflects_queued_work() {
        let (worker, _) = snapshot_after_create().await;
        worker
            .dispatch("steer", &json!({ "message": "finish the build" }))
            .await;
        let response = worker.dispatch("update_snapshot", &json!({})).await;
        let data = response.data.expect("snapshot data");
        assert_eq!(data["queue"]["steering"][0], "finish the build");
        assert_eq!(
            data["queue"]["actions"]["steering"][0], "finish the build",
            "the lane snapshot and the actions projection agree"
        );
    }
    /// The wire text of one RLM child terminal notice (the exact row
    /// `rlm_children::deliver_terminal_notice` rides): the follow-up
    /// command's `message` plus the injected custom row.
    fn child_status_notice_wire(kind: &str) -> Value {
        let notice = if kind == "failure" {
            pa_core::session_engine::rlm_notices::create_rlm_child_failure_message(
                "sub-1", "lane", "boom", 1_000,
            )
        } else {
            pa_core::session_engine::rlm_notices::create_rlm_child_terminal_notice(
                &pa_core::session_engine::rlm_notices::RlmChildTerminalNotice::CompletedWithoutReply {
                    child_id: "sub-1".to_string(),
                    session_name: "lane".to_string(),
                    last_assistant_text_preview: Some("done".to_string()),
                },
                1_000,
            )
        };
        serde_json::to_value(pa_types::session::AgentMessage::Custom(notice)).unwrap()
    }

    fn queued_user_item(message: &str) -> QueuedItem {
        QueuedItem {
            priority: QueuePriority::Human,
            message: message.to_string(),
            preview: None,
            custom_message: None,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        }
    }

    /// The queue-fold bug (operator 2026-09-25): parked RLM child status
    /// notices projected as user-like rows — one per exited child behind
    /// a busy turn. The snapshot now carries TYPED provenance: the lane
    /// strings stay the raw notice texts (the TS
    /// `queuedAgentMessagePreview` projection is unchanged), and the
    /// `rlmChildStatus` rider holds the indices of exactly the injected
    /// rows — a user-typed row with the same text never flags.
    #[tokio::test]
    async fn the_action_snapshot_flags_parked_child_status_notices() {
        let (worker, _) = snapshot_after_create().await;
        let notice_text =
            "[child-exited: no-reply child:lane]\n\nLast assistant text: done".to_string();
        let failure_text = "[child-failed child:lane]\n\nboom".to_string();
        {
            let mut core = worker.core.lock().unwrap();
            core.steering.push_back(queued_user_item("turn right"));
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Background,
                message: notice_text.clone(),
                custom_message: Some(child_status_notice_wire("terminal")),
                ..queued_user_item(&notice_text)
            });
            // A user-typed row with the exact notice text: unflagged.
            core.steering.push_back(queued_user_item(&notice_text));
            core.follow_up.push_back(QueuedItem {
                priority: QueuePriority::Background,
                message: failure_text.clone(),
                custom_message: Some(child_status_notice_wire("failure")),
                ..queued_user_item(&failure_text)
            });
            core.follow_up.push_back(queued_user_item("then summarize"));
        }
        let snapshot = {
            let core = worker.core.lock().unwrap();
            worker.snapshot_locked(&core)
        };
        assert_eq!(
            snapshot.steering,
            vec!["turn right", notice_text.as_str(), notice_text.as_str()],
            "the lane strings stay the raw texts"
        );
        assert_eq!(
            snapshot.follow_ups,
            vec![failure_text.as_str(), "then summarize"],
        );
        assert_eq!(
            snapshot.rlm_child_status.steering,
            vec![1],
            "only the injected terminal-notice row flags"
        );
        assert_eq!(
            snapshot.rlm_child_status.follow_up,
            vec![0],
            "the failure row flags on the follow-up lane"
        );
        assert_eq!(snapshot.queued_count, 5);
    }

    /// The real delivery route: the notice rides the follow-up command
    /// with the one-shot capability the daemon mints in this same worker
    /// process, and the parked row carries the typed provenance. The
    /// exact spoofs are answered loudly instead — the same command
    /// without a mint, and a replay of the consumed mint — while the
    /// same-text user row still parks as a plain row. That user row is
    /// human class while the minted notice is background, so admission
    /// priority parks the user row ahead of the notice; the rider names
    /// only the notice's lane slot, whichever position it holds.
    #[tokio::test]
    async fn a_follow_up_notice_parks_with_typed_provenance() {
        let (worker, _) = snapshot_after_create().await;
        let content =
            "[child-exited: no-reply child:lane]\n\nLast assistant text: done".to_string();
        let nonce = crate::child_status_notices::mint();
        let notice = worker
            .dispatch(
                "follow_up",
                &json!({
                    "message": content,
                    "customMessage": child_status_notice_wire("terminal"),
                    "rlmNoticeNonce": nonce,
                }),
            )
            .await;
        assert!(notice.success, "the notice follow-up parks: {notice:?}");
        let replay = worker
            .dispatch(
                "follow_up",
                &json!({
                    "message": content,
                    "customMessage": child_status_notice_wire("terminal"),
                    "rlmNoticeNonce": nonce,
                }),
            )
            .await;
        assert!(
            !replay.success,
            "the consumed mint is replay-proof: {replay:?}"
        );
        let spoofed = worker
            .dispatch(
                "follow_up",
                &json!({
                    "message": content,
                    "customMessage": child_status_notice_wire("terminal"),
                }),
            )
            .await;
        assert!(
            !spoofed.success,
            "a caller-supplied reserved-kind row is rejected, never parked: {spoofed:?}"
        );
        let plain = worker
            .dispatch("follow_up", &json!({ "message": content }))
            .await;
        assert!(plain.success, "the plain follow-up parks: {plain:?}");
        let snapshot = {
            let core = worker.core.lock().unwrap();
            worker.snapshot_locked(&core)
        };
        assert_eq!(
            snapshot.follow_ups,
            vec![content.as_str(), content.as_str()],
            "the notice and the same-text user row park their raw text"
        );
        assert_eq!(
            snapshot.rlm_child_status.follow_up,
            vec![1],
            "only the minted notice row flags: the same-text human row parks ahead of it"
        );
    }

    /// The spoof matrix (the operator's anti-spoof mandate): the exact
    /// reserved kinds are refused on every client admission surface —
    /// with no mint, with a guessed mint, and on `steer`/`prompt`
    /// regardless — while lookalike kinds (prefix, case, and fused
    /// variants) park as ordinary custom rows that never flag.
    #[tokio::test]
    async fn reserved_kind_spoofs_reject_and_lookalikes_park_unflagged() {
        let (worker, _) = snapshot_after_create().await;
        let content = "[child-exited: no-reply child:lane]".to_string();
        // No mint: both queue lanes refuse the exact reserved kinds.
        for command in ["steer", "follow_up"] {
            let spoof = worker
                .dispatch(
                    command,
                    &json!({
                        "message": content,
                        "customMessage": child_status_notice_wire("failure"),
                    }),
                )
                .await;
            assert!(
                !spoof.success,
                "{command} refuses the exact reserved kind: {spoof:?}"
            );
        }
        // A guessed mint is not a live mint.
        let guessed = worker
            .dispatch(
                "follow_up",
                &json!({
                    "message": content,
                    "customMessage": child_status_notice_wire("terminal"),
                    "rlmNoticeNonce": "00000000-0000-4000-8000-000000000000",
                }),
            )
            .await;
        assert!(
            !guessed.success,
            "a guessed nonce is no capability: {guessed:?}"
        );
        // The notice route is follow-up only: `prompt` refuses the
        // reserved kinds outright.
        let prompted = worker
            .dispatch(
                "prompt",
                &json!({
                    "message": content,
                    "customMessage": child_status_notice_wire("terminal"),
                }),
            )
            .await;
        assert!(
            !prompted.success,
            "prompt refuses the reserved kinds: {prompted:?}"
        );
        // Lookalike kinds are ordinary custom rows: they park, and the
        // rider never flags them (exact, case-sensitive matching).
        for lookalike in [
            "rlm_child_terminal_notice_v2",
            "RLM_CHILD_TERMINAL_NOTICE",
            "rlmchildterminalnotice",
        ] {
            let parked = worker
                .dispatch(
                    "follow_up",
                    &json!({
                        "message": content,
                        "customMessage": {
                            "role": "custom",
                            "customType": lookalike,
                            "content": "spoof",
                        },
                    }),
                )
                .await;
            assert!(
                parked.success,
                "the lookalike {lookalike} parks as an ordinary row: {parked:?}"
            );
        }
        let snapshot = {
            let core = worker.core.lock().unwrap();
            worker.snapshot_locked(&core)
        };
        assert_eq!(
            snapshot.follow_ups.len(),
            3,
            "the three lookalikes parked their raw text"
        );
        assert!(
            snapshot.rlm_child_status.follow_up.is_empty(),
            "no lookalike ever flags as child status"
        );
    }

    /// The rider serializes only when a notice is parked: a notice-free
    /// projection keeps the TS wire shape byte-for-byte (the field is
    /// skipped), and a parked notice rides the camelCase indices.
    #[test]
    fn the_rider_serializes_only_when_a_notice_is_parked() {
        let empty = SessionActionSnapshot::default();
        let wire = serde_json::to_value(&empty).unwrap();
        assert!(
            wire.get("rlmChildStatus").is_none(),
            "a notice-free projection stays the TS wire shape: {wire}"
        );
        let parked = SessionActionSnapshot {
            queued_count: 1,
            steering: vec!["[child-exited: no-reply child:lane]".to_string()],
            follow_ups: Vec::new(),
            rlm_child_status: crate::types::RlmChildStatusIndices {
                steering: vec![0],
                follow_up: Vec::new(),
            },
            active: None,
        };
        let wire = serde_json::to_value(&parked).unwrap();
        assert_eq!(
            wire["rlmChildStatus"],
            json!({ "steering": [0] }),
            "the rider carries the lane indices in camelCase, the empty lane omitted"
        );
    }

    /// The journal round-trip preserves the typed provenance: the restore
    /// re-derives the flag from the parked row's injected custom row (the
    /// record carries it), so a respawned worker's strip still folds the
    /// notice (operator safeguard: journal restore must preserve that).
    #[tokio::test]
    async fn restored_lane_rows_keep_the_child_status_provenance() {
        let (worker, _) = snapshot_after_create().await;
        let content =
            "[child-exited: no-reply child:lane]\n\nLast assistant text: done".to_string();
        worker.persist_queue_snapshot(
            "target-session",
            &QueueLanes {
                steering: vec![crate::journal::WorkerQueueItemRecord {
                    priority: Some(QueuePriority::Background),
                    message: content,
                    preview: None,
                    custom_message: Some(child_status_notice_wire("terminal")),
                    queue_key: None,
                    queue_visible: true,
                    policy: "queued".to_string(),
                }],
                follow_up: Vec::new(),
            },
        );
        let journal = WorkerRecoveryJournal::open(&worker.config.recovery_journal_path).unwrap();
        let (steering, follow_up) = restore_queue_snapshot(&journal, "target-session");
        assert_eq!(steering.len(), 1);
        assert!(follow_up.is_empty());
        assert!(
            is_rlm_child_status_item(&steering[0]),
            "the restored row is still a flagged notice"
        );
        {
            let mut core = worker.core.lock().unwrap();
            core.steering = steering;
        }
        let snapshot = {
            let core = worker.core.lock().unwrap();
            worker.snapshot_locked(&core)
        };
        assert_eq!(snapshot.rlm_child_status.steering, vec![0]);
    }
