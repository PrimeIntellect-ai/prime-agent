//! Worker tests (moved with their concerns).
    use crate::*;

    fn priority_test_item(message: &str, policy: TurnPolicy) -> QueuedItem {
        QueuedItem {
            message: message.to_string(),
            priority: QueuePriority::Human,
            preview: None,
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

    /// The delivery's relationship label is edge-derived: a subagent
    /// sender whose durable parent edge points at this session is a
    /// child; a subagent from another family never is, no matter its
    /// runtime kind (the mislabeled-ack regression — sibling lanes'
    /// messages must not render "from child:").
    #[test]
    fn sender_child_edge_decides_the_relationship_label() {
        let true_child = json!({
            "activeSessionId": "ddd444",
            "runtimeKind": "subagent",
            "parentSessionId": "sess-a",
        });
        assert!(sender_parent_edge_is(
            &true_child,
            Some("sess-a"),
            "aaa111",
            None
        ));
        let live_child = json!({
            "activeSessionId": "eee555",
            "runtimeKind": "subagent",
            "parentActiveSessionId": "aaa111",
        });
        assert!(sender_parent_edge_is(
            &live_child,
            Some("sess-a"),
            "aaa111",
            None
        ));
        let foreign_child = json!({
            "activeSessionId": "fff666",
            "runtimeKind": "subagent",
            "parentSessionId": "sess-zz",
        });
        assert!(!sender_parent_edge_is(
            &foreign_child,
            Some("sess-a"),
            "aaa111",
            None
        ));
        let edgeless = json!({ "activeSessionId": "ggg777", "runtimeKind": "subagent" });
        assert!(!sender_parent_edge_is(
            &edgeless,
            Some("sess-a"),
            "aaa111",
            None
        ));
        let moved_child = json!({
            "activeSessionId": "hhh888",
            "runtimeKind": "subagent",
            "parentSessionPath": "/old/root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
        });
        assert!(sender_parent_edge_is(
            &moved_child,
            Some("sess-a"),
            "aaa111",
            Some(std::path::Path::new(
                "/new/root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl"
            )),
        ));
    }

    /// A message-less top-level session is a draft (hidden from the agents
    /// view); a session with messages is live; a resident subagent is live
    /// before its first message (TS `activeLifecycleForSession`).
    #[test]
    fn summary_lifecycle_is_message_based() {
        let empty = SessionCore::test_core(None, "/tmp".to_string());
        assert_eq!(
            session_summary(&empty, "default", None, None, /*bash_running=*/ false).lifecycle,
            "draft"
        );
        let mut subagent = SessionCore::test_core(None, "/tmp".to_string());
        subagent.runtime_kind = "subagent".to_string();
        assert_eq!(
            session_summary(&subagent, "default", None, None, /*bash_running=*/ false).lifecycle,
            "live"
        );
        // The busy-flip roster delta fires before the store flushes the
        // admitted prompt; a busy turn is live at that wire moment (TS
        // reads the runtime's in-memory messages, which already hold it).
        let mut busy = SessionCore::test_core(None, "/tmp".to_string());
        busy.busy = true;
        busy.running_tool_calls.insert("call-1".to_string());
        // `isRunningTools` is the streaming gate over the in-flight tool
        // set (TS `isStreaming && pendingToolCalls.size > 0`): tools in
        // flight read true only while the turn streams.
        assert!(
            session_summary(&busy, "default", None, None, /*bash_running=*/ false).is_running_tools
        );
        busy.running_tool_calls.clear();
        assert!(
            !session_summary(&busy, "default", None, None, /*bash_running=*/ false)
                .is_running_tools
        );
        busy.running_tool_calls.insert("call-1".to_string());
        busy.busy = false;
        assert!(
            !session_summary(&busy, "default", None, None, /*bash_running=*/ false)
                .is_running_tools
        );
        // The user bash state rides the summary as its own flag (TS
        // `session.isBashRunning`).
        assert_eq!(
            session_summary(&busy, "default", None, None, /*bash_running=*/ true).is_bash_running,
            Some(true)
        );
        busy.busy = true;
        assert_eq!(
            session_summary(&busy, "default", None, None, /*bash_running=*/ false).lifecycle,
            "live"
        );
        let dir = std::env::temp_dir().join(format!("pa-worker-lc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
        let path = dir.join(crate::session_store::session_file_name(
            session.session_id(),
        ));
        session.set_path(path);
        session.append_message(serde_json::json!({
            "role": "user", "content": "hi", "timestamp": 1u64
        }));
        session.rewrite().unwrap();
        let with_message = SessionCore::test_core(Some(session), "/tmp".to_string());
        assert_eq!(
            session_summary(
                &with_message,
                "default",
                None,
                None,
                /*bash_running=*/ false
            )
            .lifecycle,
            "live"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- post-abort/post-compact queued-input suspension (TS parity) ---

    /// A created worker over the scripted engine (the dispatch surface the
    /// suspension tests drive).
    async fn created_dispatch_worker() -> std::sync::Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-susp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "suspension-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "suspension" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    /// `abort` (TS `requestAbort`) suspends queued-input admission: a plain
    /// prompt is rejected with the TS admission error until a resume site
    /// fires (a `steer` carries `resumeIfIdle: true`), after which a plain
    /// prompt is admitted again.
    #[tokio::test]
    async fn abort_suspends_plain_prompts_until_steer_resumes() {
        let worker = created_dispatch_worker().await;
        let aborted = worker.dispatch("abort", &json!({})).await;
        assert!(aborted.success, "abort failed: {aborted:?}");
        let rejected = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "hi" }),
            )
            .await;
        assert!(!rejected.success, "admitted while suspended: {rejected:?}");
        assert_eq!(rejected.command, "prompt_and_wait");
        assert_eq!(rejected.error.as_deref(), Some(QUEUED_INPUT_SUSPENDED));
        let rejected_prompt = worker
            .dispatch(
                "prompt",
                &json!({ "activeSessionId": "suspension-session", "message": "hi" }),
            )
            .await;
        assert_eq!(
            rejected_prompt.error.as_deref(),
            Some(QUEUED_INPUT_SUSPENDED)
        );
        // A prompt carrying streamingBehavior is a resume site (TS
        // `resumeIfIdle: command.streamingBehavior !== undefined`).
        let admitted_with_behavior = worker
            .dispatch(
                "prompt_and_wait",
                &json!({
                    "activeSessionId": "suspension-session",
                    "message": "steered",
                    "streamingBehavior": "steer"
                }),
            )
            .await;
        assert!(
            admitted_with_behavior.success,
            "steer not admitted: {admitted_with_behavior:?}"
        );
        let plain = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "plain again" }),
            )
            .await;
        assert!(plain.success, "still suspended after steer: {plain:?}");
    }

    /// A manual `compact` aborts first (TS `compact()`), so the
    /// suspension is set whatever the compaction outcome (the scripted
    /// engine always compacts; TS skips only "Session is too short" and
    /// the skip path leaves the suspension set too);
    /// `resume_queue` clears it before answering the empty queue (TS
    /// `resumeQueuedWork()` runs `_resumeSessionInputAdmission()`
    /// unconditionally).
    #[tokio::test]
    async fn compact_suspends_and_resume_queue_clears() {
        let worker = created_dispatch_worker().await;
        let compact = worker
            .dispatch(
                "compact",
                &json!({ "activeSessionId": "suspension-session" }),
            )
            .await;
        assert!(compact.success, "scripted compact failed: {compact:?}");
        let rejected = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "hi" }),
            )
            .await;
        assert_eq!(rejected.error.as_deref(), Some(QUEUED_INPUT_SUSPENDED));
        let resumed = worker.dispatch("resume_queue", &json!({})).await;
        assert!(
            !resumed.success,
            "resume_queue on the empty queue must still answer the TS failure: {resumed:?}"
        );
        assert_eq!(resumed.error.as_deref(), Some("No queued work to resume"));
        let plain = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "after resume" }),
            )
            .await;
        assert!(
            plain.success,
            "still suspended after resume_queue: {plain:?}"
        );
    }

    /// `abort_and_send_queued` (TS `abortAndSendQueued`, schema 29): with
    /// visible steering parked at a running turn's boundary, the interrupt
    /// aborts the run AND delivers the parked queue right after the aborted
    /// turn settles (TS `requestAbort()` + `resumeQueuedWork()`); the
    /// follow-up lane drains too, once the session goes idle. The aborted
    /// turn's row surfaces with the aborted shape.
    #[tokio::test]
    // the faux registry is process-global: the guard must span the async flow
    #[allow(clippy::await_holding_lock)]
    async fn abort_and_send_queued_delivers_the_parked_queue_at_the_boundary() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-abort-send-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "abort-send-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    { "text": "held reply", "delayMs": 60000 },
                    "steering one reply",
                    "steering two reply",
                    "follow-up reply",
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "abort-send" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        // The held turn parks the queue behind it (60s fetch hold).
        let prompt = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": "abort-send-session",
                    "message": "held turn for the abort-and-send probe",
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
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        // Parked steering and one follow-up behind the running turn.
        for message in ["steering one", "steering two"] {
            let steered = worker
                .dispatch("steer", &json!({ "message": message }))
                .await;
            assert!(steered.success, "steer failed: {steered:?}");
        }
        let follow = worker
            .dispatch("follow_up", &json!({ "message": "follow-up now" }))
            .await;
        assert!(follow.success, "follow_up failed: {follow:?}");
        // The interrupt: abort the run and send the parked queue.
        let aborted = worker.dispatch("abort_and_send_queued", &json!({})).await;
        assert!(aborted.success, "abort_and_send_queued failed: {aborted:?}");
        assert_eq!(aborted.command, "abort_and_send_queued");
        let idle = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            worker.dispatch("wait_for_idle", &json!({})),
        )
        .await;
        assert!(idle.is_ok(), "the session never went idle after the abort");
        assert!(idle.unwrap().success, "wait_for_idle failed");
        // The held turn aborted (its row carries the aborted shape) and
        // the parked queue delivered: steering one, steering two, then the
        // follow-up, each answered by its scripted reply.
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
                "held turn for the abort-and-send probe",
                "steering one",
                "steering two",
                "follow-up now",
            ],
            "the parked queue never delivered in order: {texts:?}"
        );
        // The one-batched-turn granularity (the steer-family lane's
        // supersede of this test's original reply-granularity
        // expectations): the two parked steers deliver as ONE co-delivered
        // turn — a single `agent_start` for both rows and ONE assistant
        // reply for the whole batch — exactly TS `abortAndSendQueued`'s
        // armed batch (`_forcedAllSteeringActionIds` +
        // `_startPreparedTurnActions`); the follow-up stays a turn of its
        // own behind it.
        let events = session_events_since(&mut subscription);
        let agent_starts = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
            .count();
        assert_eq!(
            agent_starts, 3,
            "the held turn, the steers' ONE batched turn, the follow-up's: {events:?}"
        );
        let replies: Vec<String> = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"].get("stopReason").and_then(Value::as_str) != Some("aborted")
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
        // The batch's one reply is the next scripted response; the
        // follow-up's turn takes the one after it - the steers never
        // consume one reply each.
        assert_eq!(
            replies,
            [
                "steering one reply".to_string(),
                "steering two reply".to_string()
            ],
            "ONE reply for the whole steers' batch, one for the follow-up: {events:?}"
        );
        assert!(
            events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"]["stopReason"] == "aborted"
            }),
            "the held turn never surfaced its aborted row: {events:?}"
        );
        // The queue drained and the suspension is gone (a plain prompt is
        // admissible again, unlike the plain-abort path).
        let queue = worker.dispatch("get_queue", &json!({})).await;
        assert!(queue.success, "get_queue failed: {queue:?}");
        let lanes = queue.data.as_ref().expect("the queue lanes");
        assert_eq!(lanes["steering"], json!([]), "queue: {queue:?}");
        assert_eq!(lanes["followUp"], json!([]), "queue: {queue:?}");
        assert!(
            !worker.core.lock().unwrap().queued_input_suspended,
            "the abort-and-send suspension never cleared"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The abort-only arm: `abort_and_send_queued` with no visible steering
    /// parked is a plain abort (TS `queuedSteering.length === 0` ->
    /// `requestAbort()` + `return false`) - the queued-input suspension
    /// stays set, so a plain prompt is rejected until a resume site fires.
    #[tokio::test]
    async fn abort_and_send_queued_with_an_empty_queue_is_a_plain_abort() {
        let worker = created_dispatch_worker().await;
        let aborted = worker.dispatch("abort_and_send_queued", &json!({})).await;
        assert!(aborted.success, "abort_and_send_queued failed: {aborted:?}");
        assert_eq!(aborted.command, "abort_and_send_queued");
        let rejected = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "hi" }),
            )
            .await;
        assert!(
            !rejected.success,
            "admitted after the abort-only abort: {rejected:?}"
        );
        assert_eq!(rejected.error.as_deref(), Some(QUEUED_INPUT_SUSPENDED));
    }

    /// A follow-up-only queue keeps flowing after the abort (the
    /// sanctioned divergence): the abort ends the running turn cleanly
    /// and the OLDEST queued follow-up starts the next turn right after
    /// the aborted turn settles; later follow-ups stay queued and drain
    /// one per completed turn, each row delivered exactly once, in
    /// enqueue order.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    async fn abort_and_send_queued_with_only_follow_ups_starts_the_oldest() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("pa-worker-abort-fu-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "abort-fu-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    { "text": "held reply", "delayMs": 60000 },
                    { "text": "follow-up one reply", "delayMs": 1500 },
                    "follow-up two reply",
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "abort-fu" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        let prompt = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": "abort-fu-session",
                    "message": "held turn for the follow-up abort probe",
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
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        // Two follow-ups park behind the running turn and the steering
        // lane stays empty — the interrupt keeps nothing armable, the
        // exact shape of the follow-up-only abort.
        for message in ["follow-up one", "follow-up two"] {
            let follow = worker
                .dispatch("follow_up", &json!({ "message": message }))
                .await;
            assert!(follow.success, "follow_up failed: {follow:?}");
        }
        // The interrupt: the abort ends the held turn and the queue
        // keeps flowing — the follow-up lane never parks behind the
        // abort's suspension.
        let aborted = worker.dispatch("abort_and_send_queued", &json!({})).await;
        assert!(aborted.success, "abort_and_send_queued failed: {aborted:?}");
        assert_eq!(aborted.command, "abort_and_send_queued");
        assert!(
            !worker.core.lock().unwrap().queued_input_suspended,
            "the abort must resume a follow-up-only queue"
        );
        // The OLDEST follow-up starts the next turn right after the
        // aborted turn settles (its paced reply holds the turn open):
        // while it runs, the second follow-up stays queued — the lane
        // drains one turn per completed turn, never as one batch.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let (busy, queued) = {
                let core = worker.core.lock().unwrap();
                (core.busy, core.follow_up.len())
            };
            if busy && queued == 1 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the oldest follow-up never started while the second stayed queued"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let queue = worker.dispatch("get_queue", &json!({})).await;
        assert!(queue.success, "get_queue failed: {queue:?}");
        assert_eq!(
            queue.data.as_ref().expect("the queue lanes")["followUp"],
            json!(["follow-up two"]),
            "the second follow-up must stay queued behind the first: {queue:?}"
        );
        let idle = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            worker.dispatch("wait_for_idle", &json!({})),
        )
        .await;
        assert!(
            idle.is_ok(),
            "the follow-up-only queue never drained after the abort"
        );
        assert!(idle.unwrap().success, "wait_for_idle failed");
        // Both follow-ups delivered in enqueue order, each row exactly
        // once, each in its own turn behind the aborted run.
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
                "held turn for the follow-up abort probe",
                "follow-up one",
                "follow-up two",
            ],
            "the follow-ups never drained in enqueue order: {texts:?}"
        );
        let events = session_events_since(&mut subscription);
        let agent_start_indexes: Vec<usize> = events
            .iter()
            .enumerate()
            .filter(|(_, event)| event.get("type").and_then(Value::as_str) == Some("agent_start"))
            .map(|(index, _)| index)
            .collect();
        assert_eq!(
            agent_start_indexes.len(),
            3,
            "one turn per follow-up, never a merged batch: {events:?}"
        );
        let aborted_row = events
            .iter()
            .position(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"].get("stopReason").and_then(Value::as_str) == Some("aborted")
            })
            .expect("the held turn never surfaced its aborted row");
        assert!(
            aborted_row < agent_start_indexes[1],
            "the abort must end the held turn before the first follow-up's turn starts: {events:?}"
        );
        let replies: Vec<String> = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"].get("stopReason").and_then(Value::as_str) != Some("aborted")
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
            replies,
            [
                "follow-up one reply".to_string(),
                "follow-up two reply".to_string()
            ],
            "one reply per follow-up turn: {events:?}"
        );
        {
            let core = worker.core.lock().unwrap();
            assert!(
                core.steering.is_empty() && core.follow_up.is_empty(),
                "the queue must fully drain"
            );
            assert!(
                !core.queued_input_suspended,
                "the resume never cleared the suspension"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A scripted goal session's dispatch worker (the goal section feeds
    /// `goal_state_value` and the post-compaction mint).
    async fn goal_dispatch_worker(goal: serde_json::Value) -> std::sync::Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-goal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "goal-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "responses": ["ack"],
                "goal": goal,
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "goal" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    /// The session events seen by an attached client since `mark`, in wire
    /// order (the frames carry one `event` payload each).
    fn session_events_since(
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

    /// TS `compact()`'s `didCompact` + active-goal branch: a successful
    /// compact on a session with an active goal mints the owed goal
    /// continuation (`resumeQueuedWork()`'s
    /// `_maybeResumeGoalContinuationAfterRlmWork` — the minted follow-up
    /// with the goal-context row), clears the queued-input suspension, and
    /// the scheduled continue drives the turn: the continuation runs
    /// (agent rows on the wire), the queue drains, and the session is
    /// admitted for plain prompts again (the resume site crossed the #234
    /// suspension gate).
    #[tokio::test]
    async fn compact_with_active_goal_schedules_the_continue() {
        let worker = goal_dispatch_worker(json!({
            "status": "active",
            "objective": "land the post-compact continue",
            "message": "[goal: continuation]\n\nkeep pursuing the goal",
        }))
        .await;
        let mut subscription = worker.events.subscribe();
        let compact = worker
            .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
            .await;
        assert!(compact.success, "scripted compact failed: {compact:?}");
        // The scheduled continue drives the continuation turn; the idle
        // wait settles only after it ran.
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
        let events = session_events_since(&mut subscription);
        // The mint's `goal_update` surfaces at the moment the state
        // changed, then the continuation turn: the goal-context custom row
        // plus its model turn (the scripted engine's rows).
        let goal_updates: Vec<&Value> = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("goal_update"))
            .collect();
        assert_eq!(goal_updates.len(), 1, "events: {events:?}");
        assert_eq!(goal_updates[0]["goal"]["status"], "active");
        let custom_rows: Vec<&Value> = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["customType"] == "goal_context"
            })
            .collect();
        assert_eq!(custom_rows.len(), 1, "events: {events:?}");
        assert_eq!(
            custom_rows[0]["message"]["content"],
            "[goal: continuation]\n\nkeep pursuing the goal"
        );
        assert!(
            events
                .iter()
                .any(|event| event.get("type").and_then(Value::as_str) == Some("turn_end")),
            "the continuation turn never ran: {events:?}"
        );
        // The resume site crossed the #234 suspension gate: a plain prompt
        // is admitted again.
        let plain = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "goal-session", "message": "after the continue" }),
            )
            .await;
        assert!(plain.success, "still suspended: {plain:?}");
    }

    /// Queued work parked at compact time owns the continue (TS's `||=`
    /// sets the owed-continuation flag only when the agent has NO queued
    /// messages): no fresh goal continuation is minted, the resume site
    /// releases the parked work, and the parked turn runs instead.
    #[tokio::test]
    async fn compact_with_active_goal_and_parked_work_skips_the_mint() {
        let worker = goal_dispatch_worker(json!({
            "status": "active",
            "objective": "land the post-compact continue",
        }))
        .await;
        let mut subscription = worker.events.subscribe();
        {
            // Park one queued follow-up behind the suspension gate, like a
            // steer that arrived mid-compact-window.
            let mut core = worker.core.lock().unwrap();
            core.queued_input_suspended = true;
            core.follow_up.push_back(QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "parked queued work".to_string(),
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
        let compact = worker
            .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
            .await;
        assert!(compact.success, "scripted compact failed: {compact:?}");
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
        let events = session_events_since(&mut subscription);
        // The parked item's turn ran (its user row), not a minted
        // continuation (no goal_context row, no goal_update).
        assert!(
            events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["role"] == "user"
                    && event["message"]["content"] == "parked queued work"
            }),
            "the parked item never ran: {events:?}"
        );
        assert!(
            !events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["customType"] == "goal_context"
            }),
            "a continuation was minted over the parked work: {events:?}"
        );
        assert!(
            !events
                .iter()
                .any(|event| event.get("type").and_then(Value::as_str) == Some("goal_update")),
            "a mint emitted a goal_update: {events:?}"
        );
    }

    /// Only an ACTIVE goal schedules the continue (TS checks
    /// `this._goalState.status === "active"`): a paused goal leaves the
    /// post-compact suspension set and mints nothing.
    #[tokio::test]
    async fn compact_with_paused_goal_never_continues() {
        let worker = goal_dispatch_worker(json!({
            "status": "paused",
            "objective": "land the post-compact continue",
        }))
        .await;
        let mut subscription = worker.events.subscribe();
        let compact = worker
            .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
            .await;
        assert!(compact.success, "scripted compact failed: {compact:?}");
        let rejected = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "goal-session", "message": "hi" }),
            )
            .await;
        assert_eq!(rejected.error.as_deref(), Some(QUEUED_INPUT_SUSPENDED));
        let events = session_events_since(&mut subscription);
        assert!(
            !events
                .iter()
                .any(|event| event.get("type").and_then(Value::as_str) == Some("goal_update")),
            "a paused goal minted a continuation: {events:?}"
        );
    }

    /// The goal continuation loop at the natural turn end (TS
    /// `_getGoalContinuationMessages` + `_getContinuationMessages`): a
    /// multi-continuation goal session driven to completion end to end
    /// through the worker. The turn runner's queue drives each minted
    /// continuation (the engine consults at every settled boundary, the
    /// admission sink queues the follow-up, the runner wakes), the
    /// budget-free loop keeps prompting until the kernel's
    /// `goal.complete()` (the scripted ipython tool call, the f18
    /// completion surface) settles the goal, and the completion's
    /// boundary mints nothing more. The completing cell needs a
    /// bootable kernel: a sandbox gate run must provide uv and
    /// `PI_PACKAGE_DIR` at the checkout (the guard inside names the
    /// recipe when the cell fails instead of letting the loop drain
    /// the faux script into a misleading count mismatch).
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn goal_turn_end_loop_runs_to_completion() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-goal-loop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "goal-loop-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    "first pursuit turn",
                    "second pursuit turn",
                    { "content": [
                        { "type": "toolCall", "name": "ipython",
                          "arguments": { "code": "import goal; await goal.complete()" } },
                    ] },
                    "wrap-up after the completion",
                    "after the loop settled",
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "goal-loop" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        let start = worker
            .dispatch(
                "prompt_and_wait",
                &json!({
                    "activeSessionId": "goal-loop-session",
                    "message": "/goal drive the loop to completion",
                }),
            )
            .await;
        assert!(start.success, "the goal start failed: {start:?}");
        // The loop owns the session until the goal settles: the idle wait
        // returns only when the completion turn's boundary minted nothing.
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "the goal loop never settled: {idle:?}");
        let events = session_events_since(&mut subscription);
        // A gate run without the kernel environment (uv on PATH and
        // PI_PACKAGE_DIR at the checkout — docs/parity-battery.md,
        // "Sandbox-built rust binary + kernel runtime") fails the
        // completing ipython cell: the goal stays active and the loop
        // keeps minting (TS parity: goal continuations are unbounded while
        // the goal is active) until the faux script runs dry. Fail with
        // the diagnosis instead of the misleading continuation-count
        // mismatch.
        let kernel_failure = events.iter().find(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_end")
                && event["message"]["role"] == "toolResult"
                && event["message"]["isError"] == json!(true)
        });
        if let Some(failure) = kernel_failure {
            panic!(
                "the completing ipython cell failed — this test needs the kernel \
                 environment (uv on PATH and PI_PACKAGE_DIR at the checkout; \
                 docs/parity-battery.md, \"Sandbox-built rust binary + kernel \
                 runtime\"): {failure:?}"
            );
        }
        // Each minted continuation ran as a queued follow-up turn: the
        // start row plus two continuation rows (the completion turn is the
        // second continuation's turn).
        let goal_rows: Vec<&Value> = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["customType"] == "goal_context"
            })
            .collect();
        assert_eq!(goal_rows.len(), 3, "events: {events:?}");
        assert_eq!(goal_rows[0]["message"]["details"]["kind"], "continuation");
        assert_eq!(goal_rows[1]["message"]["details"]["continuationsUsed"], 1);
        assert_eq!(goal_rows[2]["message"]["details"]["continuationsUsed"], 2);
        // The model turns all settled: the start turn, two continuation
        // turns, and the completing tool-call turn's own assistant
        // segments ride the wire as assistant rows.
        let assistant_rows = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
            })
            .count();
        assert!(assistant_rows >= 4, "events: {events:?}");
        // The goal state settled complete (the kernel completion through
        // the worker's host handlers), with the loop's counts on the books.
        let complete_update = events
            .iter()
            .rev()
            .find(|event| {
                event.get("type").and_then(Value::as_str) == Some("goal_update")
                    && event["goal"]["status"] == "complete"
            })
            .expect("the completion surfaced as a goal_update");
        assert_eq!(
            complete_update["goal"]["objective"],
            "drive the loop to completion"
        );
        assert_eq!(complete_update["goal"]["continuationsUsed"], 2);
        assert!(
            complete_update["goal"]["tokensUsed"].as_u64().unwrap_or(0) > 0,
            "usage accounting ran: {complete_update:?}"
        );
        // The completion's boundary mints nothing: the queue is empty and
        // a plain prompt is admitted again.
        let queue = worker
            .dispatch(
                "get_queue",
                &json!({ "activeSessionId": "goal-loop-session" }),
            )
            .await;
        assert!(queue.success, "queue read failed: {queue:?}");
        let plain = worker
            .dispatch(
                "prompt_and_wait",
                &json!({
                    "activeSessionId": "goal-loop-session",
                    "message": "after the loop",
                }),
            )
            .await;
        assert!(plain.success, "a post-goal prompt failed: {plain:?}");
    }

    /// The aborted turn's row through the worker gate (the #245 flagged
    /// gap: TS broadcasts AND persists it, the gate used to drop it): a
    /// turn aborted mid-provider-wait settles on its aborted assistant
    /// row, and the gate forwards the row — the attached client sees the
    /// row's `message_start/message_end` pair (stopReason "aborted", the
    /// abort error, EMPTY usage) and the session file holds the same
    /// row — while the active goal's accounting skips it (the state the
    /// goal-start turn left is unchanged after the abort).
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn aborted_turn_row_broadcasts_and_persists_through_the_worker_gate() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-aborted-row-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "aborted-row-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    "goal start reply",
                    { "text": "held reply", "delayMs": 60000 },
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "aborted-row" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        // `/goal`: the goal-start continuation turn runs to completion
        // inside the prompt, its usage accounted.
        let start = worker
            .dispatch(
                "prompt_and_wait",
                &json!({
                    "activeSessionId": "aborted-row-session",
                    "message": "/goal land the aborted row accounting",
                }),
            )
            .await;
        assert!(start.success, "the goal start failed: {start:?}");
        let goal_before = worker.engine.goal_state_value();
        assert_eq!(
            goal_before["status"],
            json!("active"),
            "state: {goal_before:?}"
        );
        assert!(
            goal_before["tokensUsed"].as_u64().unwrap_or(0) > 0,
            "the goal-start turn's usage accounted: {goal_before:?}"
        );
        // The turn-end mint queues the next continuation; the runner
        // admits it and its goal-context row rides the wire, then the
        // provider fetch holds (the 60s reply).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let events = session_events_since(&mut subscription);
            let admitted = events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["customType"] == "goal_context"
                    && event["message"]["details"]["continuationsUsed"] == json!(1)
            });
            if admitted {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the continuation turn was never admitted"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        // Let the admitted turn reach the provider: the held reply keeps
        // the fetch in flight, so the abort lands mid-provider-wait (the
        // eager fetch cancel) and the turn settles on its aborted row.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let abort = worker.dispatch("abort", &json!({})).await;
        assert!(abort.success, "abort failed: {abort:?}");
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
        // The attached client saw the row's pair: the row's own start
        // frame (a no-partial abort begins a new message) and the settled
        // end frame with the aborted shape.
        let events = session_events_since(&mut subscription);
        let aborted_start = events
            .iter()
            .find(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["role"] == "assistant"
                    && event["message"]["stopReason"] == json!("aborted")
            })
            .cloned()
            .expect("the aborted row's start frame reached the wire");
        assert_eq!(
            aborted_start["message"]["errorMessage"],
            json!("Request was aborted")
        );
        let aborted_end = events
            .iter()
            .rev()
            .find(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"]["stopReason"] == json!("aborted")
            })
            .cloned()
            .expect("the aborted row's end frame reached the wire");
        let row = &aborted_end["message"];
        assert_eq!(row["errorMessage"], json!("Request was aborted"));
        assert_eq!(row["usage"]["totalTokens"], json!(0));
        assert_eq!(row["usage"]["input"], json!(0));
        assert_eq!(row["usage"]["output"], json!(0));
        assert_eq!(row["content"], json!([{ "type": "text", "text": "" }]));
        // The terminal `turn_end` frame follows the row's pair (TS
        // `turn_end` on an aborted turn): the aborted assistant row is
        // the frame's payload with the turn's empty tool-result list, and
        // the trailing `Done` stays silent (no second, bare frame).
        let aborted_turn_end = events
            .iter()
            .rev()
            .find(|event| event.get("type").and_then(Value::as_str) == Some("turn_end"))
            .cloned()
            .expect("the aborted turn's turn_end frame reached the wire");
        assert_eq!(aborted_turn_end["message"], *row);
        assert_eq!(aborted_turn_end["toolResults"], json!([]));
        assert_eq!(aborted_turn_end.get("error"), None);
        // No bare trailing frame after the payload one: the aborted
        // turn's terminal `turn_end` is the only frame of this window's
        // aborted turn (the `Done` fallback stays silent).
        let bare_turn_end_count = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("turn_end")
                    && event.get("message").is_none()
            })
            .count();
        assert_eq!(
            bare_turn_end_count, 0,
            "no bare turn_end frames: {events:?}"
        );
        // The row persisted: the session file holds the same aborted
        // assistant row (TS `appendMessage` at the message_end hook).
        let store_row = {
            let core = worker.core.lock().unwrap();
            core.store
                .as_ref()
                .expect("the worker owns a session file")
                .messages()
                .into_iter()
                .rev()
                .find(|message| {
                    message.get("role").and_then(Value::as_str) == Some("assistant")
                        && message.get("stopReason").and_then(Value::as_str) == Some("aborted")
                })
                .expect("the aborted row persisted in the session file")
        };
        assert_eq!(store_row["errorMessage"], json!("Request was aborted"));
        assert_eq!(store_row["usage"]["totalTokens"], json!(0));
        assert_eq!(
            store_row["content"],
            json!([{ "type": "text", "text": "" }])
        );
        // The goal accounting skipped the row (TS
        // `_accountGoalUsageForAssistantMessage`'s aborted guard): the
        // accounting fields are the state the goal-start turn left (the
        // wall-clock fields are time-based).
        let goal_after = worker.engine.goal_state_value();
        assert_eq!(
            goal_after["status"],
            json!("active"),
            "state: {goal_after:?}"
        );
        assert_eq!(goal_after["tokensUsed"], goal_before["tokensUsed"]);
        assert_eq!(
            goal_after["continuationsUsed"],
            goal_before["continuationsUsed"]
        );
        assert_eq!(goal_after["objective"], goal_before["objective"]);
    }

    /// The killed close's schedule cancel (TS `cancelScheduledJobsForSession`
    /// at `closeSessionOnce("killed")`): a session with an active heartbeat
    /// job dies at kill — the job cancels durably and the session file
    /// archives, so no scheduled wake can revive the stopped session (the
    /// zombie fix's stop-side gate).
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn kill_cancels_the_sessions_scheduled_jobs() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-kill-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sessions_dir = dir.join("sessions");
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "kill-jobs-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "engine": "faux", "responses": [] })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({
                    "cwd": dir.to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                    "name": "kill-jobs",
                }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let data = created.data.expect("the create answers a summary");
        let session_id = data.get("sessionId").and_then(Value::as_str).expect("id");
        let session_file = data
            .get("sessionFile")
            .and_then(Value::as_str)
            .expect("session file");
        // A lane-liveness heartbeat on the session's artifact store.
        let job = worker
            .scheduled
            .store()
            .create(&pa_core::cron::store::CreateAgentCronJobInput {
                active_session_id: "kill-jobs-session".to_string(),
                session_id: session_id.to_string(),
                session_file: session_file.to_string(),
                cwd: dir.to_string_lossy().to_string(),
                prompt: "lane-liveness ping".to_string(),
                schedule_text: "every 10s".to_string(),
                source: Some("rlm_heartbeat".to_string()),
                now: Some(1),
                ..Default::default()
            })
            .expect("the store creates the job");
        assert_eq!(job.status, pa_core::cron::JobStatus::Active);

        let killed = worker.dispatch("kill", &json!({})).await;
        assert!(killed.success, "kill failed: {killed:?}");

        // The job cancelled durably: no later fire can wake the session.
        let stored = worker.scheduled.store().list();
        let cancelled = stored
            .iter()
            .find(|candidate| candidate.id == job.id)
            .expect("the job stays in the store");
        assert_eq!(cancelled.status, pa_core::cron::JobStatus::Cancelled);
        assert_eq!(cancelled.next_run_at, None);
        // The close archived the session file (the wake scan's state gate).
        let info =
            crate::session_store::read_session_info(std::path::Path::new(session_file)).unwrap();
        assert_eq!(info.state.as_deref(), Some("archived"));
    }

    /// The `kill` path (the #247 residue, probe-verified): TS
    /// `closeSessionOnce("killed")` fires `session.abort()` —
    /// `requestAbort()` -> `agent.abort()` — whose run-cancel lands before
    /// every close step that can wait on the running turn, so a kill during
    /// a mid-provider-wait turn cancels the fetch immediately instead of
    /// streaming the held reply out and answering the kill only after the
    /// turn settled naturally (the probe showed the blocked archive
    /// holding the kill 15s past the request). The #247 matrix holds:
    /// the aborted row still broadcasts and persists, the `archived`
    /// lifecycle entry lands ahead of the row in the session file (TS
    /// `archiveSession` precedes the abort), and the close reaches the
    /// wire as a `session_closed` frame.
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn kill_cancels_a_mid_provider_wait_turn_and_surfaces_the_aborted_row() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-kill-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "kill-path-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    { "text": "held reply", "delayMs": 60000 },
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "kill-path" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        // The turn runs detached (`prompt` answers immediately): its fetch
        // holds on the 60s reply, so the kill below lands mid-provider-wait.
        let prompt = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": "kill-path-session",
                    "message": "held turn for the kill probe",
                }),
            )
            .await;
        assert!(prompt.success, "prompt failed: {prompt:?}");
        // The turn is mid-provider-wait once the runner is busy on it: the
        // held reply (60s) keeps the fetch in flight, so no assistant
        // message_start arrives before the kill (the row only starts at
        // the abort). The busy flag is the runner's own admission marker
        // (`await_session_work_settled` parks on the same flag).
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
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        // The kill must answer on the cancelled turn, not the 60s hold:
        // the abort funnel fires before the archive/dispose work waits on
        // the session mutex the turn holds.
        let started = std::time::Instant::now();
        let killed = worker.dispatch("kill", &json!({})).await;
        assert!(killed.success, "kill failed: {killed:?}");
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(15),
            "kill waited out the held provider response ({elapsed:?})"
        );
        // The aborted row surfaced (the #247 matrix): the wire carries its
        // message_start/message_end pair with the aborted shape. Drain
        // every session-event frame: wrapped session events expose their
        // inner `event`; the close rides the same outbound type as the
        // whole frame (`emit_session_closed` sends the SessionClosed
        // payload without an `event` wrapper), so it must surface whole.
        let mut events = Vec::new();
        while let Ok(frame) = subscription.try_recv() {
            if frame.outbound_type != "session_event" {
                continue;
            }
            let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) else {
                continue;
            };
            match outbound.get("event") {
                Some(event) if event.is_object() => events.push(event.clone()),
                _ => events.push(outbound),
            }
        }
        let aborted_end = events
            .iter()
            .rev()
            .find(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"]["stopReason"] == json!("aborted")
            })
            .cloned()
            .expect("the aborted row's end frame reached the wire");
        assert_eq!(
            aborted_end["message"]["errorMessage"],
            json!("Request was aborted")
        );
        // The close reached the wire as `session_closed` (reason "killed").
        assert!(
            events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("session_closed")
                    && event.get("reason").and_then(Value::as_str) == Some("killed")
            }),
            "the kill closed the session on the wire: {events:?}"
        );
        // The durable store: the aborted assistant row persisted, and the
        // `archived` lifecycle entry lands ahead of it (TS
        // `archiveSession` -> `appendSessionState` runs before the abort
        // settles the row).
        let entries = {
            let core = worker.core.lock().unwrap();
            core.store
                .as_ref()
                .expect("the worker owns a session file")
                .entries()
                .to_vec()
        };
        let archived_at = entries
            .iter()
            .position(|entry| {
                entry.type_ == "session_state"
                    && entry.fields["state"]["status"] == json!("archived")
            })
            .expect("the session archived on kill");
        let aborted_at = entries
            .iter()
            .position(|entry| {
                entry.type_ == "message"
                    && entry.fields["message"]["role"] == json!("assistant")
                    && entry.fields["message"]["stopReason"] == json!("aborted")
            })
            .expect("the aborted row persisted in the session file");
        assert!(
            archived_at < aborted_at,
            "the archived lifecycle entry must precede the aborted row"
        );
        assert_eq!(
            entries[aborted_at].fields["message"]["errorMessage"],
            json!("Request was aborted")
        );
        // The session is closed: `created` fell with the archive.
        assert!(!worker.core.lock().unwrap().created);
    }

    /// The compact path swallows the interrupted turn's aborted row (TS
    /// `compact()` detaches from agent events — `_disconnectFromAgent()`
    /// — before the abort, so the row never reaches the wire or the
    /// session file): a turn aborted by the `compact` command's
    /// interrupt-and-settle shows no aborted assistant row on either
    /// surface, while the same abort through the `abort` command
    /// broadcasts it (the previous test).
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn compact_interrupt_swallows_the_aborted_row() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-compact-abort-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "compact-abort-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [{ "text": "held reply", "delayMs": 60000 }],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "compact-abort" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        let turn = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": "compact-abort-session",
                    "message": "held turn for the compact interrupt",
                }),
            )
            .await;
        assert!(turn.success, "the prompt failed: {turn:?}");
        // Let the admitted turn reach the provider (the 60s hold), then
        // compact: the interrupt aborts the in-flight fetch and the
        // aborted row must stay off the wire (TS `_disconnectFromAgent`).
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let compact = worker
            .dispatch(
                "compact",
                &json!({ "activeSessionId": "compact-abort-session" }),
            )
            .await;
        // The scripted faux engine's compact outcome is not the claim
        // here; either way the turn settled before it.
        let _ = compact;
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
        let events = session_events_since(&mut subscription);
        let aborted_rows = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"]["stopReason"] == "aborted"
            })
            .count();
        assert_eq!(
            aborted_rows, 0,
            "the compact path swallows the aborted row: {events:?}"
        );
        // The suppressed run's `agent_end` stays off the wire entirely (TS
        // `_disconnectFromAgent` before the abort: no `turn_end`, no
        // `agent_end` for the interrupted run) — neither the engine's
        // per-run frame (the abort gate swallows it) nor the worker's
        // trailing fallback.
        let agent_ends = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_end"))
            .count();
        assert_eq!(
            agent_ends, 0,
            "the compact path emits no agent_end for the suppressed run: {events:?}"
        );
        // And out of the session file.
        let aborted_store_rows = {
            let core = worker.core.lock().unwrap();
            core.store
                .as_ref()
                .expect("the worker owns a session file")
                .messages()
                .into_iter()
                .filter(|message| {
                    message.get("role").and_then(Value::as_str) == Some("assistant")
                        && message.get("stopReason").and_then(Value::as_str) == Some("aborted")
                })
                .count()
        };
        assert_eq!(
            aborted_store_rows, 0,
            "the compact path never persists the aborted row"
        );
    }

    /// The pause withdraws the queued minted continuation (TS
    /// `_pauseGoal` -> `_clearQueuedGoalContexts`): a prompt arriving right
    /// after the goal start runs within a turn or two of the loop, the
    /// pause purges the queued goal-context turn, and the loop goes quiet
    /// (the f18 battery's pause pattern).
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn goal_pause_withdraws_the_queued_continuation() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-goal-pause-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "goal-pause-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    "start turn",
                    "one continuation turn at most",
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "goal-pause" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let start = worker
            .dispatch(
                "prompt_and_wait",
                &json!({
                    "activeSessionId": "goal-pause-session",
                    "message": "/goal pause right after the start",
                }),
            )
            .await;
        assert!(start.success, "the goal start failed: {start:?}");
        let pause = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "goal-pause-session", "message": "/goal pause" }),
            )
            .await;
        assert!(pause.success, "the pause never ran: {pause:?}");
        // The loop is quiet: the idle wait settles without consuming
        // further turns (a live continuation would starve it).
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "the loop never went quiet: {idle:?}");
        let goal = worker.engine.goal_state_value();
        assert_eq!(goal["status"], "paused", "goal state: {goal}");
        // A settled paused goal consumed at most the start turn and one
        // continuation turn's worth of slots.
        assert!(
            goal["continuationsUsed"].as_u64().unwrap_or(0) <= 2,
            "the pause never withdrew the loop: {goal}"
        );
    }

    /// A scripted goal session's dispatch worker with a durable session
    /// file (the `noSession` create keeps everything in memory; this
    /// variant lands the store on disk so the `thread_goal_state` mirror
    /// is observable).
    async fn goal_dispatch_worker_with_store(
        goal: serde_json::Value,
    ) -> (std::sync::Arc<Worker>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("pa-worker-goal-{}", uuid::Uuid::new_v4()));
        let session_dir = dir.join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "goal-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "responses": ["ack"],
                "goal": goal,
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({
                    "cwd": dir.to_string_lossy(),
                    "name": "goal",
                    "sessionDir": session_dir.to_string_lossy(),
                }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let file = std::fs::read_dir(&session_dir)
            .expect("session dir readable")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
            .expect("session file created");
        (worker, file)
    }

    /// The session file's `thread_goal_state` custom rows, in order.
    fn thread_goal_state_rows(path: &std::path::Path) -> Vec<Value> {
        crate::session_store::parse_session_entries(&std::fs::read_to_string(path).expect("read"))
            .into_iter()
            .filter(|entry| {
                entry.get("type").and_then(Value::as_str) == Some("custom")
                    && entry.get("customType").and_then(Value::as_str)
                        == Some(pa_core::goals::GOAL_STATE_CUSTOM_TYPE)
            })
            .collect()
    }

    /// A goal-state change announced mid-turn (TS `_setGoalState` ->
    /// `_emitGoalUpdate`) mirrors into the worker session file as a
    /// `thread_goal_state` custom row: the engine's in-memory branch is
    /// not the durable store, so the mirror is what a recovery rebuild
    /// replays.
    #[tokio::test]
    async fn goal_update_events_mirror_the_durable_goal_row() {
        let (worker, file) = goal_dispatch_worker_with_store(json!({
            "emitUpdateOnPrompt": true,
            "state": {
                "active": true,
                "status": "active",
                "goalId": "goal-1",
                "objective": "ship the port",
                "tokensUsed": 340,
                "timeUsedSeconds": 9,
                "continuationsUsed": 2,
            },
        }))
        .await;
        let prompt = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "goal-session", "message": "work" }),
            )
            .await;
        assert!(prompt.success, "prompt failed: {prompt:?}");
        let rows = thread_goal_state_rows(&file);
        assert_eq!(rows.len(), 1, "rows: {rows:?}");
        assert_eq!(rows[0]["data"]["status"], "active");
        assert_eq!(rows[0]["data"]["objective"], "ship the port");
        assert_eq!(rows[0]["data"]["goalId"], "goal-1");
        assert_eq!(rows[0]["data"]["tokensUsed"], 340);
        assert_eq!(rows[0]["data"]["continuationsUsed"], 2);
    }

    /// The post-compaction mint's state change (the compact branch runs
    /// outside a turn) persists its `thread_goal_state` row before the
    /// `goal_update` announcement, so the continuation count survives a
    /// worker crash mid-goal.
    #[tokio::test]
    async fn compact_mint_persists_the_goal_state_row() {
        let (worker, file) = goal_dispatch_worker_with_store(json!({
            "status": "active",
            "objective": "ship the port",
            "state": {
                "active": true,
                "status": "active",
                "goalId": "goal-1",
                "objective": "ship the port",
                "tokensUsed": 340,
                "timeUsedSeconds": 9,
                "continuationsUsed": 1,
            },
        }))
        .await;
        let compact = worker
            .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
            .await;
        assert!(compact.success, "scripted compact failed: {compact:?}");
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
        let rows = thread_goal_state_rows(&file);
        assert_eq!(rows.len(), 1, "rows: {rows:?}");
        assert_eq!(rows[0]["data"]["status"], "active");
        assert_eq!(rows[0]["data"]["continuationsUsed"], 1);
        assert_eq!(rows[0]["data"]["objective"], "ship the port");
    }

    /// `abort_and_clear_queue` suspends like the bare `abort` (TS
    /// `requestAbort` in that arm): a plain prompt is rejected afterwards
    /// and a `follow_up` (a resume site) is admitted.
    #[tokio::test]
    async fn abort_and_clear_queue_suspends_plain_prompts() {
        let worker = created_dispatch_worker().await;
        let cleared = worker.dispatch("abort_and_clear_queue", &json!({})).await;
        assert!(cleared.success, "abort_and_clear_queue failed: {cleared:?}");
        let rejected = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "hi" }),
            )
            .await;
        assert_eq!(rejected.error.as_deref(), Some(QUEUED_INPUT_SUSPENDED));
        let resumed = worker
            .dispatch(
                "follow_up",
                &json!({
                    "activeSessionId": "suspension-session",
                    "message": "queued resume"
                }),
            )
            .await;
        assert!(resumed.success, "follow_up failed: {resumed:?}");
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
    }

    #[test]
    fn display_ids_are_twelve_hex() {
        let id = crate::util::new_display_id();
        assert_eq!(id.len(), 12);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn queue_priority_interleaves_lanes_fifo_and_preserves_explicit_order() {
        let mut core = SessionCore::test_core(None, "/tmp".to_string());
        core.steering_mode = "one-at-a-time".to_string();
        core.follow_up_mode = "one-at-a-time".to_string();
        let add = |core: &mut SessionCore, lane: Lane, text: &str, priority| {
            let mut item = priority_test_item(text, TurnPolicy::Queued);
            item.priority = priority;
            match lane {
                Lane::Steering => enqueue_priority(&mut core.steering, item),
                Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
            }
        };
        add(
            &mut core,
            Lane::FollowUp,
            "machine follow 1",
            QueuePriority::Background,
        );
        add(
            &mut core,
            Lane::Steering,
            "machine steer 1",
            QueuePriority::Background,
        );
        add(
            &mut core,
            Lane::FollowUp,
            "human follow 1",
            QueuePriority::Human,
        );
        add(
            &mut core,
            Lane::Steering,
            "human steer 1",
            QueuePriority::Human,
        );
        add(
            &mut core,
            Lane::Steering,
            "machine steer 2",
            QueuePriority::Background,
        );
        add(
            &mut core,
            Lane::FollowUp,
            "human follow 2",
            QueuePriority::Human,
        );
        add(
            &mut core,
            Lane::Steering,
            "human steer 2",
            QueuePriority::Human,
        );
        assert_eq!(
            session_snapshot(&core).steering,
            [
                "human steer 1",
                "human steer 2",
                "machine steer 1",
                "machine steer 2"
            ]
        );
        assert_eq!(
            session_snapshot(&core).follow_ups,
            ["human follow 1", "human follow 2", "machine follow 1"]
        );
        core.steering.swap(0, 2); // explicit user reorder crosses priority boundary
        add(
            &mut core,
            Lane::Steering,
            "human steer 3",
            QueuePriority::Human,
        );
        assert_eq!(
            session_snapshot(&core).steering,
            [
                "machine steer 1",
                "human steer 2",
                "human steer 1",
                "human steer 3",
                "machine steer 2"
            ]
        );
        assert_eq!(
            gather_delivery_batch(&mut core, Lane::Steering)[0].message,
            "machine steer 1"
        );
        assert_eq!(
            gather_delivery_batch(&mut core, Lane::Steering)[0].message,
            "human steer 2"
        );
        core.steering.clear();
        assert_eq!(
            gather_delivery_batch(&mut core, Lane::FollowUp)[0].message,
            "human follow 1"
        );
    }

    #[test]
    fn queue_priority_drains_four_tiers_and_pinned_front() {
        let mut core = SessionCore::test_core(None, "/tmp".to_string());
        core.steering_mode = "one-at-a-time".to_string();
        core.follow_up_mode = "one-at-a-time".to_string();
        for (lane, text, priority) in [
            (Lane::FollowUp, "machine follow", QueuePriority::Background),
            (Lane::Steering, "machine steer", QueuePriority::Background),
            (Lane::FollowUp, "human follow", QueuePriority::Human),
            (Lane::Steering, "human steer", QueuePriority::Human),
            (Lane::FollowUp, "pinned follow", QueuePriority::Pinned),
        ] {
            let mut item = priority_test_item(text, TurnPolicy::Queued);
            item.priority = priority;
            match lane {
                Lane::Steering => enqueue_priority(&mut core.steering, item),
                Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
            }
        }
        let mut delivered = Vec::new();
        while !core.steering.is_empty() || !core.follow_up.is_empty() {
            let lane = if core.steering.is_empty() {
                Lane::FollowUp
            } else {
                Lane::Steering
            };
            delivered.push(gather_delivery_batch(&mut core, lane).remove(0).message);
        }
        assert_eq!(
            delivered,
            [
                "human steer",
                "machine steer",
                "pinned follow",
                "human follow",
                "machine follow"
            ]
        );
    }

    #[tokio::test]
    async fn rpc_custom_rows_do_not_gain_human_queue_priority() {
        let worker = created_dispatch_worker().await;
        let pause = worker.dispatch("acquire_session_input_pause", &json!({
            "activeSessionId": "suspension-session", "leaseKey": "source-test", "clientId": "test"
        })).await;
        assert!(pause.success, "pause failed: {pause:?}");
        let custom = |content: &str| {
            json!({
                "role": "custom", "customType": "user", "content": content
            })
        };
        for (command, message, row) in [
            (
                "steer",
                "machine via steer",
                Some(custom("machine via steer")),
            ),
            (
                "prompt",
                "machine via prompt",
                Some(custom("machine via prompt")),
            ),
            ("steer", "human via steer", None),
            ("prompt", "human via prompt", None),
        ] {
            let mut payload =
                json!({ "activeSessionId": "suspension-session", "message": message });
            if let Some(row) = row {
                payload["customMessage"] = row;
            }
            let admitted = worker.dispatch(command, &payload).await;
            assert!(admitted.success, "{command}: {admitted:?}");
        }
        let core = worker.core.lock().unwrap();
        assert_eq!(
            session_snapshot(&core).steering,
            [
                "human via steer",
                "human via prompt",
                "machine via steer",
                "machine via prompt"
            ]
        );
        assert_eq!(
            core.steering
                .iter()
                .map(|item| item.priority)
                .collect::<Vec<_>>(),
            [
                QueuePriority::Human,
                QueuePriority::Human,
                QueuePriority::Background,
                QueuePriority::Background,
            ]
        );
    }

    #[tokio::test]
    async fn waiting_rpc_prompt_overtakes_background_steer_and_settles() {
        let worker = created_dispatch_worker().await;
        let pause = worker.dispatch("acquire_session_input_pause", &json!({
            "activeSessionId": "suspension-session", "leaseKey": "priority-test", "clientId": "test"
        })).await;
        assert!(pause.success, "pause failed: {pause:?}");
        {
            let mut core = worker.core.lock().unwrap();
            core.busy = true; // a prompt admitted behind work is queue-visible
            let mut background = priority_test_item("machine steer", TurnPolicy::Injected);
            background.priority = QueuePriority::Background;
            enqueue_priority(&mut core.steering, background);
        }
        let waiting_worker = std::sync::Arc::clone(&worker);
        let waiting = tokio::spawn(async move {
            waiting_worker
                .dispatch(
                    "prompt_and_wait",
                    &json!({
                        "activeSessionId": "suspension-session",
                        "message": "human steer",
                        "streamingBehavior": "steer",
                    }),
                )
                .await
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if worker.core.lock().unwrap().steering.len() == 2 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "waiting prompt was not queued"
            );
            tokio::task::yield_now().await;
        }
        {
            let core = worker.core.lock().unwrap();
            assert_eq!(
                session_snapshot(&core).steering,
                ["human steer", "machine steer"]
            );
        }
        let released = worker.dispatch("release_session_input_pause", &json!({
            "activeSessionId": "suspension-session", "pauseId": pause.data.as_ref().unwrap()["pauseId"],
            "clientId": "test"
        })).await;
        assert!(released.success, "release failed: {released:?}");
        let settled = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("prompt_and_wait did not settle")
            .expect("dispatch task panicked");
        assert!(settled.success, "waiting prompt failed: {settled:?}");
    }

    #[test]
    fn legacy_queue_record_priority_defaults_by_row_and_keeps_order() {
        let dir = std::env::temp_dir().join(format!("pa-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("priority-recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        let machine: crate::journal::WorkerQueueItemRecord = serde_json::from_value(json!({
            "message": "machine", "custom_message": {"role": "custom", "customType": "notice"}
        }))
        .unwrap();
        let human: crate::journal::WorkerQueueItemRecord = serde_json::from_value(json!({
            "message": "human"
        }))
        .unwrap();
        let future: crate::journal::WorkerQueueItemRecord = serde_json::from_value(json!({
            "message": "future machine", "priority": "new_tier"
        }))
        .unwrap();
        journal
            .record_queue_snapshot("legacy", &[machine, human, future], &[])
            .unwrap();
        let reopened = WorkerRecoveryJournal::open(&path).unwrap();
        let (lane, _) = restore_queue_snapshot(&reopened, "legacy");
        assert_eq!(
            lane.iter()
                .map(|item| item.message.as_str())
                .collect::<Vec<_>>(),
            ["machine", "human", "future machine"]
        );
        assert_eq!(lane[0].priority, QueuePriority::Background);
        assert_eq!(lane[1].priority, QueuePriority::Human);
        assert_eq!(lane[2].priority, QueuePriority::Background);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn queue_snapshot_round_trips_through_the_recovery_journal() {
        let dir = std::env::temp_dir().join(format!("pa-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let journal_path = dir.join("recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&journal_path).unwrap();
        // A parked heartbeat rides the journal with its full delivery row
        // (labeled preview, injected custom row, queue key), so a respawned
        // worker restores the heartbeat component instead of a plain user
        // message.
        let content = "[heartbeat: every 10m run#0]\n\nnudge the mission";
        let labeled_preview = format!(
            "{}: {content}",
            pa_core::session_engine::messages::HEARTBEAT_PROMPT_PREVIEW_LABEL
        );
        let heartbeat = crate::journal::WorkerQueueItemRecord {
            message: content.to_string(),
            priority: Some(QueuePriority::Background),
            preview: Some(labeled_preview),
            custom_message: Some(json!({
                "role": "custom",
                "customType": "heartbeat_prompt",
                "content": content,
                "display": true,
                "details": { "jobId": "hb-1" },
            })),
            queue_key: Some("heartbeat:hb-1".to_string()),
            queue_visible: true,
            policy: "injected".to_string(),
        };
        let plain = crate::journal::WorkerQueueItemRecord {
            message: "follow-me".to_string(),
            priority: Some(QueuePriority::Human),
            preview: None,
            custom_message: None,
            queue_key: None,
            queue_visible: true,
            policy: "queued".to_string(),
        };
        journal
            .record_queue_snapshot(
                "session-a",
                std::slice::from_ref(&heartbeat),
                std::slice::from_ref(&plain),
            )
            .unwrap();
        // A reopen (respawned worker) reads the latest snapshot per session.
        let reloaded = WorkerRecoveryJournal::open(&journal_path).unwrap();
        let (steering, follow_up) = restore_queue_snapshot(&reloaded, "session-a");
        assert_eq!(steering.len(), 1);
        assert_eq!(steering[0].message, heartbeat.message);
        assert_eq!(steering[0].priority, QueuePriority::Background);
        assert_eq!(steering[0].preview, heartbeat.preview);
        assert_eq!(steering[0].custom_message, heartbeat.custom_message);
        assert_eq!(steering[0].queue_key, heartbeat.queue_key);
        assert!(steering[0].queue_visible);
        assert_eq!(follow_up.len(), 1);
        assert_eq!(follow_up[0].message, "follow-me");
        assert_eq!(follow_up[0].priority, QueuePriority::Human);
        // Compaction (triggered by an all-idle record) keeps the snapshot
        // with its full rows.
        let mut compacting = WorkerRecoveryJournal::open(&journal_path).unwrap();
        compacting
            .record("session-a", "s1", None, false, "idle")
            .unwrap();
        let compacted = WorkerRecoveryJournal::open(&journal_path).unwrap();
        let (steering, _) = restore_queue_snapshot(&compacted, "session-a");
        assert_eq!(steering.len(), 1);
        assert_eq!(steering[0].custom_message, heartbeat.custom_message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A version-1 queue snapshot (the pre-item text lanes a prior binary
    /// wrote) still restores as plain rows.
    #[test]
    fn a_version_one_queue_snapshot_restores_as_plain_rows() {
        let dir = std::env::temp_dir().join(format!("pa-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let journal_path = dir.join("recovery.jsonl");
        std::fs::write(
            &journal_path,
            "{\"version\":1,\"type\":\"queue_snapshot\",\"active_session_id\":\"session-b\",\"steering\":[\"steer-me\"],\"follow_up\":[\"follow-me\"],\"recorded_at\":\"2026-09-22T00:00:00.000Z\"}\n",
        )
        .unwrap();
        let journal = WorkerRecoveryJournal::open(&journal_path).unwrap();
        let (steering, follow_up) = restore_queue_snapshot(&journal, "session-b");
        assert_eq!(steering.len(), 1);
        assert_eq!(steering[0].message, "steer-me");
        assert_eq!(steering[0].preview, None);
        assert_eq!(steering[0].custom_message, None);
        assert_eq!(steering[0].queue_key, None);
        assert!(steering[0].queue_visible);
        assert_eq!(follow_up.len(), 1);
        assert_eq!(follow_up[0].message, "follow-me");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The forced-batch arming classification (TS `abortAndSendQueued`'s
    /// `queuedSteering` filter): only the visible plain-user steering items
    /// arm — queue-visible rows whose delivery record is a user message;
    /// agent-message deliveries and injected custom rows never join, and an
    /// empty (or all-injected) lane arms nothing.
    #[tokio::test]
    async fn forced_batch_arming_classifies_the_visible_plain_rows() {
        let worker = created_dispatch_worker().await;
        {
            let mut core = worker.core.lock().unwrap();
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "steer one".to_string(),
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
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Background,
                preview: None,
                message: "agent message row".to_string(),
                custom_message: None,
                agent_message: Some("agent message row".to_string()),
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Injected,
                forced_batch: false,
            });
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Background,
                preview: None,
                message: "injected custom row".to_string(),
                custom_message: Some(json!({ "role": "custom", "customType": "x" })),
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
                preview: None,
                message: "steer two".to_string(),
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
        assert!(
            worker.arm_forced_all_steering(),
            "the armable rows exist: the arm fired"
        );
        {
            let core = worker.core.lock().unwrap();
            assert!(core.forced_all_steering, "the forced batch is armed");
            let armed: Vec<bool> = core.steering.iter().map(|item| item.forced_batch).collect();
            assert_eq!(
                armed,
                vec![true, false, false, true],
                "only the visible plain-user rows armed: {armed:?}"
            );
        }
        // A lane with nothing armable arms nothing new — the armed state
        // itself persists (TS's armed set survives until a pump selection
        // consumes or disarms it; a later abort with an empty lane runs
        // the plain `requestAbort` arm and touches nothing).
        worker.core.lock().unwrap().steering.clear();
        assert!(
            !worker.arm_forced_all_steering(),
            "an empty lane arms nothing"
        );
        {
            let core = worker.core.lock().unwrap();
            assert!(core.forced_all_steering, "the armed state persists");
            assert!(
                core.steering.iter().all(|item| !item.forced_batch),
                "no item carries the armed flag"
            );
        }
    }
