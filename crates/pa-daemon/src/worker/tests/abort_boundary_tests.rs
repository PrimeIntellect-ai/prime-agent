//! Post-abort/post-compact queued-input suspension e2e tests.
use super::*;

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
    // A prompt carrying streamingBehavior is a resume site.
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

/// The interrupt aborts the run AND delivers the parked queue right after the turn settles.
#[tokio::test]
// the faux registry is process-global: the guard must span the async flow
#[allow(clippy::await_holding_lock)]
async fn abort_and_send_queued_delivers_the_parked_queue_at_the_boundary() {
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
    // The two parked steers deliver as ONE co-delivered turn — a single
    // `agent_start` and ONE assistant reply for the batch; the follow-up
    // stays a turn of its own.
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

/// The sanctioned divergence: the OLDEST queued follow-up starts the next turn after the settle.
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
    // Two follow-ups park behind the running turn; the steering
    // lane stays empty — nothing armable.
    for message in ["follow-up one", "follow-up two"] {
        let follow = worker
            .dispatch("follow_up", &json!({ "message": message }))
            .await;
        assert!(follow.success, "follow_up failed: {follow:?}");
    }

    let aborted = worker.dispatch("abort_and_send_queued", &json!({})).await;
    assert!(aborted.success, "abort_and_send_queued failed: {aborted:?}");
    assert_eq!(aborted.command, "abort_and_send_queued");
    assert!(
        !worker.core.lock().unwrap().queued_input_suspended,
        "the abort must resume a follow-up-only queue"
    );
    // While the oldest runs, the second follow-up stays queued.
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

/// TS commits admission before queue delivery: a queued prompt answers
/// `owned` but does not affect the running turn unless cancelled with
/// `cancelOwned`. The running admission's `cancelOwned` aborts its turn
/// and the settle clears the admission.
#[tokio::test]
async fn cancel_owned_admission_aborts_the_running_prompt() {
    let dir = std::env::temp_dir().join(format!("pa-worker-cancel-owned-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "cancel-owned-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": [{ "text": "held reply", "delayMs": 60000 }] })),
    };
    let worker = Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "cancel-owned" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let mut subscription = worker.events.subscribe();
    let wait = tokio::spawn({
        let worker = Arc::clone(&worker);
        async move {
            worker
                .dispatch(
                    "prompt_and_wait",
                    &json!({
                        "activeSessionId": "cancel-owned-session",
                        "message": "go",
                        "admissionId": "adm-1",
                    }),
                )
                .await
        }
    });
    // The turn commits its admission before it emits `agent_start`.
    loop {
        let frame = subscription.recv().await.unwrap();
        if frame.outbound_type == "session_event"
            && serde_json::from_slice::<Value>(&frame.payload).unwrap()["event"]["type"]
                == "agent_start"
        {
            break;
        }
    }
    // The held turn keeps the session busy, so a second prompt queues
    // behind it. Admission is already owned before delivery, as in TS.
    let queued_wait = tokio::spawn({
        let worker = Arc::clone(&worker);
        async move {
            worker
                .dispatch(
                    "prompt_and_wait",
                    &json!({
                        "activeSessionId": "cancel-owned-session",
                        "message": "queued behind the held turn",
                        "admissionId": "adm-2",
                    }),
                )
                .await
        }
    });
    // The queued prompt has been accepted while its response waits on the
    // held turn; its admission is already owned, not yet settled.
    loop {
        if worker.prompt_admissions.cancel("adm-2")
            == Some(crate::prompt_admission::AdmissionStatus::Owned)
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    let queued_cancel = json!({
        "activeSessionId": "cancel-owned-session",
        "admissionId": "adm-2",
    });
    let queued_owned = worker
        .dispatch("cancel_prompt_admission", &queued_cancel)
        .await;
    assert_eq!(
        queued_owned.data,
        Some(json!({ "status": "owned" })),
        "{queued_owned:?}"
    );
    // Without cancelOwned, the queued prompt remains queued.
    let queue = worker.dispatch("get_queue", &json!({})).await;
    assert!(serde_json::to_string(&queue.data)
        .unwrap()
        .contains("queued behind the held turn"));
    let queued_removed = worker
        .dispatch(
            "cancel_prompt_admission",
            &json!({"activeSessionId": "cancel-owned-session", "admissionId": "adm-2", "cancelOwned": true}),
        )
        .await;
    assert_eq!(
        queued_removed.data,
        Some(json!({ "status": "owned" })),
        "{queued_removed:?}"
    );
    let cleared_queued = worker
        .dispatch("cancel_prompt_admission", &queued_cancel)
        .await;
    assert_eq!(cleared_queued.data, Some(json!({ "status": "unknown" })));
    // clear_queue withdraws the drained row: its admission clears with it (TS clearAdmission).
    let queued_three = worker
        .dispatch(
            "prompt",
            &json!({
                "activeSessionId": "cancel-owned-session",
                "message": "cleared by clear_queue",
                "admissionId": "adm-3",
            }),
        )
        .await;
    assert!(
        queued_three.success,
        "queued adm-3 failed: {queued_three:?}"
    );
    assert!(
        worker.dispatch("clear_queue", &json!({})).await.success,
        "clear_queue failed"
    );
    let drained_cancel = worker
        .dispatch(
            "cancel_prompt_admission",
            &json!({"activeSessionId": "cancel-owned-session", "admissionId": "adm-3"}),
        )
        .await;
    assert_eq!(
        drained_cancel.data,
        Some(json!({ "status": "unknown" })),
        "{drained_cancel:?}"
    );
    let queued_result = queued_wait.await.unwrap();
    assert!(
        !queued_result.success,
        "the withdrawn prompt cannot complete"
    );
    // Simulate the narrow settle gap: an earlier owned admission still
    // exists in the registry, but this different turn is now running.
    worker.register_prompt_admission("stale-owned");
    assert!(worker.prompt_admissions.commit("stale-owned"));
    let stale = worker
        .dispatch(
            "cancel_prompt_admission",
            &json!({"activeSessionId": "cancel-owned-session", "admissionId": "stale-owned", "cancelOwned": true}),
        )
        .await;
    assert_eq!(stale.data, Some(json!({ "status": "owned" })));
    assert!(
        !worker.core.lock().unwrap().abort_requested,
        "stale admission must not abort the unrelated running turn"
    );
    let cancel = json!({
        "activeSessionId": "cancel-owned-session",
        "admissionId": "adm-1",
        "cancelOwned": true,
    });
    let owned = worker.dispatch("cancel_prompt_admission", &cancel).await;
    assert_eq!(owned.data, Some(json!({ "status": "owned" })), "{owned:?}");
    wait.await.unwrap();
    let idle = worker.dispatch("wait_for_idle", &json!({})).await;
    assert!(idle.success, "never went idle: {idle:?}");
    let messages = worker.dispatch("get_messages", &json!({})).await;
    let messages = serde_json::to_string(&messages.data).unwrap();
    assert!(
        !messages.contains("queued behind the held turn"),
        "the cancelled admission's prompt ran: {messages}"
    );
    assert!(
        !messages.contains("held reply"),
        "the turn ran to the end: {messages}"
    );
    let cleared = worker.dispatch("cancel_prompt_admission", &cancel).await;
    assert_eq!(
        cleared.data,
        Some(json!({ "status": "unknown" })),
        "{cleared:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
