//! Agent-message command tests.
use super::*;

fn test_worker() -> Arc<Worker> {
    let dir = std::env::temp_dir().join(format!("pa-worker-am-{}", uuid::Uuid::new_v4()));
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
    Arc::new(Worker::new(config, None))
}

async fn created_worker() -> Arc<Worker> {
    let worker = test_worker();
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

fn queue_texts(core: &Mutex<SessionCore>, lane: Lane) -> Vec<String> {
    let core = core.lock().unwrap();
    match lane {
        Lane::Steering => &core.steering,
        Lane::FollowUp => &core.follow_up,
    }
    .iter()
    .map(|item| item.message.clone())
    .collect()
}

/// Receipt shape: id, source, target, sender echo, delivered status + timestamp,
/// and the rendered prompt on the steering lane.
#[tokio::test]
async fn deliver_message_answers_the_ts_receipt_shape() {
    let worker = created_worker().await;
    let response = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "ping from the first session",
                "sender": {
                    "activeSessionId": "source-session",
                    "sessionId": "source-file",
                    "sessionName": "source-agent",
                    "runtimeKind": "top-level",
                    "clientId": "cli-1",
                },
            }),
        )
        .await;
    assert!(response.success, "deliver failed: {response:?}");
    assert_eq!(response.command, "worker_deliver_message");
    let data = response.data.expect("receipt data");
    assert!(
        data["id"]
            .as_str()
            .unwrap_or_default()
            .starts_with("agentmsg_"),
        "receipt id: {data}"
    );
    assert_eq!(data["source"], "agent_message");
    assert_eq!(data["message"], "ping from the first session");
    assert_eq!(data["deliveryStatus"], "delivered");
    assert_eq!(data["deliveryMode"], "steer");
    assert!(
        data["deliveredAt"].as_str().is_some(),
        "deliveredAt: {data}"
    );
    assert!(
        data.get("queuedAt").is_none(),
        "queuedAt on delivery: {data}"
    );
    assert_eq!(data["target"]["activeSessionId"], "target-session");
    assert_eq!(data["target"]["sessionName"], "target");
    assert!(!data["target"]["sessionId"]
        .as_str()
        .unwrap_or_default()
        .is_empty());
    assert_eq!(data["from"]["sessionName"], "source-agent");
    assert_eq!(
        queue_texts(&worker.core, Lane::Steering),
        vec!["[agent-message from source-agent]\n\nping from the first session"],
        "steering lane"
    );
    assert!(queue_texts(&worker.core, Lane::FollowUp).is_empty());
}

/// The row's content is the rendered prompt; the details carry the identity the
/// collapsed card reads, and the marker still targets `agent_messages_clear`/`pause`.
#[tokio::test]
async fn deliver_message_carries_the_agent_message_custom_row() {
    let worker = created_worker().await;
    let response = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "the research is done",
                "sender": {
                    "activeSessionId": "source-session",
                    "sessionId": "source-file",
                    "sessionName": "research-lane",
                    "runtimeKind": "subagent",
                    // The child label derives from this parent edge,
                    // never from the runtime kind alone.
                    "parentActiveSessionId": "target-session",
                },
            }),
        )
        .await;
    assert!(response.success, "deliver failed: {response:?}");
    let data = response.data.expect("receipt data");
    let prompt = "[agent-message from child:research-lane]\n\nthe research is done";
    let (custom, message, agent_message, preview) = {
        let core = worker.core.lock().unwrap();
        let item = core.steering.front().expect("the delivery queued");
        (
            item.custom_message
                .clone()
                .expect("the agent_message row rides the delivery"),
            item.message.clone(),
            item.agent_message.clone(),
            item.preview.clone(),
        )
    };
    // The queue strip serves the TS labeled preview.
    assert_eq!(
        preview.as_deref(),
        Some("Agent message received: the research is done")
    );
    assert_eq!(custom["role"], "custom");
    assert_eq!(custom["customType"], "agent_message");
    assert_eq!(custom["content"], prompt);
    assert_eq!(custom["display"], true);
    assert_eq!(custom["details"]["id"], data["id"]);
    assert_eq!(custom["details"]["message"], "the research is done");
    assert_eq!(
        custom["details"]["from"]["activeSessionId"],
        "source-session"
    );
    assert_eq!(custom["details"]["fromRelationship"], "child");
    assert_eq!(
        custom["details"]["target"]["activeSessionId"],
        "target-session"
    );
    // The turn still runs on the rendered prompt, and the marker the
    // clear/pause arms read is untouched.
    assert_eq!(message, prompt);
    assert_eq!(agent_message.as_deref(), Some("the research is done"));
}

/// An explicit `follow_up` delivery queues behind current work instead of steering.
#[tokio::test]
async fn deliver_message_follow_up_lane_and_subagent_sender() {
    let worker = created_worker().await;
    let response = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "queue me",
                "sender": {
                    "activeSessionId": "source-session",
                    "sessionName": "source-agent",
                    "runtimeKind": "subagent",
                    // The child label derives from this parent edge,
                    // never from the runtime kind alone.
                    "parentActiveSessionId": "target-session",
                },
                "deliveryMode": "follow_up",
            }),
        )
        .await;
    assert!(response.success, "deliver failed: {response:?}");
    let data = response.data.expect("receipt data");
    assert_eq!(data["deliveryMode"], "follow_up");
    assert_eq!(
        queue_texts(&worker.core, Lane::FollowUp),
        vec!["[agent-message from child:source-agent]\n\nqueue me"],
        "follow-up lane"
    );
    assert!(queue_texts(&worker.core, Lane::Steering).is_empty());
}

/// A busy session reports `queued` with `queuedAt` (`queueIfBusy`).
#[tokio::test]
async fn deliver_message_while_busy_queues() {
    let worker = created_worker().await;
    worker.core.lock().unwrap().busy = true;
    let response = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "while busy",
                "sender": { "activeSessionId": "source-session" },
            }),
        )
        .await;
    assert!(response.success, "deliver failed: {response:?}");
    let data = response.data.expect("receipt data");
    assert_eq!(data["deliveryStatus"], "queued");
    assert!(data["queuedAt"].as_str().is_some(), "queuedAt: {data}");
    assert!(
        data.get("deliveredAt").is_none(),
        "deliveredAt while queued: {data}"
    );
}

/// Agent-message deliveries admit as background work: later user input jumps
/// them, FIFO behind earlier user input, on both lanes.
#[tokio::test]
async fn user_input_jumps_parked_agent_message_deliveries() {
    for (command, delivery_mode, lane) in [
        ("steer", "steer", "steering"),
        ("follow_up", "follow_up", "followUp"),
    ] {
        let worker = created_worker().await;
        worker.core.lock().unwrap().busy = true;
        for (text, user) in [
            ("first agent", false),
            ("second agent", false),
            ("first user", true),
            ("second user", true),
        ] {
            let response = if user {
                worker.dispatch(command, &json!({ "message": text })).await
            } else {
                worker
                    .dispatch(
                        "worker_deliver_message",
                        &json!({
                            "targetActiveSessionId": "target-session",
                            "message": text,
                            "sender": { "activeSessionId": "source-session" },
                            "deliveryMode": delivery_mode,
                        }),
                    )
                    .await
            };
            assert!(response.success, "{text}: {response:?}");
            if !user {
                assert_eq!(response.data.expect("receipt")["deliveryStatus"], "queued");
            }
        }
        let queue = worker.dispatch("get_queue", &json!({})).await;
        assert_eq!(
            queue.data.expect("queue data")[lane],
            json!([
                "first user",
                "second user",
                "Agent message received: first agent",
                "Agent message received: second agent"
            ]),
            "{lane}"
        );
    }
}

/// The pending-capacity guard fails with the TS error string.
#[tokio::test]
async fn deliver_message_respects_the_pending_capacity() {
    let worker = created_worker().await;
    {
        let mut core = worker.core.lock().unwrap();
        for _ in 0..DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION {
            core.follow_up.push_back(QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "occupied".to_string(),
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
        }
    }
    let response = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "over the limit",
                "sender": { "activeSessionId": "source-session" },
            }),
        )
        .await;
    assert!(!response.success, "deliver should fail: {response:?}");
    assert_eq!(
        response.error.as_deref(),
        Some("Target session has too many pending messages: 20 unfinished, limit is 20")
    );
}

/// TS `createAttachResult` key order: the slim response carries the messages
/// exactly once; the non-slim duplicate is byte-identical to the copy.
#[tokio::test]
async fn attach_response_wire_bytes_keep_the_ts_key_order() {
    let worker = created_worker().await;
    {
        let mut core = worker.core.lock().unwrap();
        let store = core.store.as_mut().expect("the created store");
        store.append_entry(
            "message",
            json!({ "message": { "role": "user", "content": "wire bytes" } }),
        );
        store.append_entry(
            "message",
            json!({ "message": { "role": "assistant", "content": "byte order" } }),
        );
    }
    for (capabilities, slim) in [(vec!["slim_attach"], true), (Vec::<&str>::new(), false)] {
        let response = worker
            .dispatch(
                "attach",
                &json!({
                    "clientId": "wire-client",
                    "capabilities": capabilities,
                }),
            )
            .await;
        assert!(response.success, "attach failed: {response:?}");
        let data = response.data.expect("attach carries data");
        let keys = data
            .as_object()
            .expect("attach data is an object")
            .keys()
            .cloned()
            .collect::<Vec<String>>();
        let expected = if slim {
            vec![
                "protocol".to_string(),
                "activeSessionId".to_string(),
                "snapshot".to_string(),
                "replay".to_string(),
                "lastEventSequence".to_string(),
                "lastEventCursor".to_string(),
                "client".to_string(),
            ]
        } else {
            vec![
                "protocol".to_string(),
                "activeSessionId".to_string(),
                "state".to_string(),
                "messages".to_string(),
                "snapshot".to_string(),
                "replay".to_string(),
                "lastEventSequence".to_string(),
                "lastEventCursor".to_string(),
                "client".to_string(),
            ]
        };
        assert_eq!(
            keys, expected,
            "the attach top-level keys keep the TS createAttachResult order"
        );
        let snapshot = data.get("snapshot").expect("the attach snapshot");
        let snapshot_keys = snapshot
            .as_object()
            .expect("the snapshot is an object")
            .keys()
            .cloned()
            .collect::<Vec<String>>();
        assert_eq!(
            snapshot_keys,
            vec![
                "activeSessionId".to_string(),
                "summary".to_string(),
                "state".to_string(),
                "messages".to_string(),
                "lastEventSequence".to_string(),
                "lastEventCursor".to_string(),
                "children".to_string(),
            ],
            "the snapshot keys keep the TS order"
        );
        let messages = snapshot.get("messages").expect("the snapshot messages");
        let content: Vec<String> = messages
            .as_array()
            .expect("messages are an array")
            .iter()
            .map(|row| {
                row.get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            })
            .collect();
        assert_eq!(
            content,
            vec!["wire bytes".to_string(), "byte order".to_string()],
            "the snapshot carries the store's transcript rows in order"
        );
        if slim {
            assert!(
                data.get("messages").is_none() && data.get("state").is_none(),
                "the slim attach duplicates no message tree at the top level"
            );
        } else {
            let top_messages = data.get("messages").expect("the top-level messages");
            assert_eq!(
                serde_json::to_string(top_messages).unwrap(),
                serde_json::to_string(messages).unwrap(),
                "the duplicated message trees serialize to identical bytes"
            );
            assert_eq!(
                data.get("state"),
                snapshot.get("summary"),
                "the top-level state is the summary the snapshot carries"
            );
        }
    }
}

/// `clear_queue` bounces each dropped agent-message row to its sender over
/// the supervisor `send_message` route; the cleared user prompt sends
/// nothing (unix: the link endpoint is an `AF_UNIX` socket).
#[cfg(unix)]
#[tokio::test]
async fn clear_queue_bounces_dropped_agent_messages_to_their_senders() {
    assert_clear_queue_bounces(/*restore_queue*/ false).await;
}

#[cfg(unix)]
#[tokio::test]
async fn clear_queue_bounces_recovered_agent_messages_to_their_senders() {
    assert_clear_queue_bounces(/*restore_queue*/ true).await;
}

#[cfg(unix)]
async fn assert_clear_queue_bounces(restore_queue: bool) {
    let dir = std::env::temp_dir().join(format!("pa-worker-am-bounce-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("supervisor.sock");
    let (sends, _server) = crate::worker::tests::fake_supervisor(&socket);
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: socket,
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "target-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
    };
    let worker = Arc::new(Worker::new(config, None));
    // Production opens the recovery sink in serve(); direct-dispatch fixtures
    // must install it before admission so checkpoints persist synchronously.
    *worker.recovery.lock().unwrap() =
        Some(WorkerRecoveryJournal::open(&worker.config.recovery_journal_path).unwrap());
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    // Busy parks both rows in their lanes.
    worker.core.lock().unwrap().busy = true;
    let delivered = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": "please review the plan",
                "sender": {
                    "activeSessionId": "source-session",
                    "sessionName": "source-agent",
                },
            }),
        )
        .await;
    assert!(delivered.success, "deliver failed: {delivered:?}");
    let queued = worker
        .dispatch("follow_up", &json!({ "message": "plain queued prompt" }))
        .await;
    assert!(queued.success, "follow_up failed: {queued:?}");
    if restore_queue {
        // Reopen the persisted journal as a respawn would: the marker must
        // survive alongside the custom row for clear/pause/status handling.
        // A respawn acquires ownership after the old worker releases it.
        // Dropping the sink releases the journal lock; the durable admissions
        // above have already completed their synchronous checkpoint writes.
        drop(worker.recovery.lock().unwrap().take());
        let journal = WorkerRecoveryJournal::open(&worker.config.recovery_journal_path).unwrap();
        let (steering, follow_up, _) = restore_queue_snapshot(&journal, "target-session");
        assert_eq!(steering.len(), 1, "agent row checkpoint must be durable");
        assert_eq!(follow_up.len(), 1, "prompt checkpoint must be durable");
        // The replacement worker owns the reopened sink for clear's checkpoint.
        *worker.recovery.lock().unwrap() = Some(journal);
        let mut core = worker.core.lock().unwrap();
        core.steering = steering;
        core.follow_up = follow_up;
        assert_eq!(
            core.steering[0].agent_message.as_deref(),
            Some("please review the plan")
        );
    }
    let cleared = worker.dispatch("clear_queue", &json!({})).await;
    assert!(cleared.success, "clear_queue failed: {cleared:?}");
    let data = cleared.data.expect("the clear data");
    assert_eq!(
        data["steering"],
        json!(["[agent-message from source-agent]\n\nplease review the plan"]),
        "the response shape is unchanged: {data}"
    );
    assert_eq!(
        data["followUp"],
        json!(["plain queued prompt"]),
        "the response shape is unchanged: {data}"
    );
    // Exactly one bounce leaves for the agent row's sender; the cleared
    // user prompt sends nothing.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let sends = loop {
        let recorded: Vec<Value> = sends
            .lock()
            .unwrap()
            .iter()
            .filter(|command| command["type"] == "send_message")
            .cloned()
            .collect();
        if !recorded.is_empty() {
            break recorded;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the bounce never reached the supervisor link"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    };
    assert_eq!(
        sends.len(),
        1,
        "one bounce per agent row, none for the prompt: {sends:?}"
    );
    let command = &sends[0];
    assert_eq!(command["type"], "send_message");
    assert_eq!(command["targetActiveSessionId"], "source-session");
    assert_eq!(command["fromActiveSessionId"], "target-session");
    assert_eq!(command["agentOrigin"], true);
    assert_eq!(
        command["message"],
        "Your agent message was cleared from target's queue before delivery: please review the plan",
        "the bounce names the receiver and quotes the dropped body: {command}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The Decision API goal routing at the deliver seam, pinned: the
/// parent's tagged goal is consumed into the decision engine's goal
/// input without starting a turn — by the live active id or the durable
/// session id, the only two ids the parent edge matches — while a
/// sibling's ceiling goal routes as an ordinary message; it can never
/// poison the seq against the parent's later goals.
#[tokio::test]
async fn deliver_routes_only_the_parents_decision_goals() {
    // The worker builds plain first: the engine swap needs ownership
    // before the Arc wrap, unlike the shared `created_worker` helper.
    let dir = std::env::temp_dir().join(format!("pa-worker-decision-{}", uuid::Uuid::new_v4()));
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
    let mut worker = Worker::new(config, None);
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    // The decision child is the deliver seam's consuming engine; the
    // durable parent edge is the create-time runtime metadata's.
    let agent_dir = worker.config.agent_dir.clone();
    worker.engine = std::sync::Arc::new(crate::decision_engine::DecisionEngine::new(
        &agent_dir,
        &agent_dir,
        std::sync::Arc::new(crate::supervisor_link::SupervisorLink::new(
            std::path::PathBuf::new(),
        )),
        "target-session".to_string(),
        "token".to_string(),
    ));
    worker.core.lock().unwrap().parent_active_session_id = Some("parent-active".to_string());
    worker.core.lock().unwrap().parent_session_id = Some("parent-durable".to_string());
    let worker = std::sync::Arc::new(worker);
    let goal = |seq: i64, text: &str| {
        json!({"type":"decision_api.goal","seq":seq,"goal":text}).to_string()
    };
    // The parent's goal is consumed: no turn is queued.
    let parent_goal = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": goal(1, "follow the target"),
                "sender": {
                    "activeSessionId": "parent-active",
                    "sessionName": "parent",
                    "runtimeKind": "top-level",
                },
            }),
        )
        .await;
    assert!(
        parent_goal.success,
        "parent delivery failed: {parent_goal:?}"
    );
    assert_eq!(
        parent_goal.data.expect("receipt")["deliveryStatus"],
        "delivered"
    );
    assert!(
        queue_texts(&worker.core, Lane::Steering).is_empty(),
        "the parent's goal starts no turn"
    );
    // A sibling's ceiling goal routes as an ordinary message: queued as a
    // turn, labeled by name, never into the goal input.
    let sibling_goal = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": goal(i64::MAX, "steal the decision"),
                "sender": {
                    "activeSessionId": "sibling-live",
                    "sessionName": "sibling-lane",
                    "runtimeKind": "subagent",
                    "parentActiveSessionId": "parent-active",
                },
            }),
        )
        .await;
    assert!(
        sibling_goal.success,
        "sibling delivery failed: {sibling_goal:?}"
    );
    assert_eq!(
        queue_texts(&worker.core, Lane::Steering),
        vec![format!(
            "[agent-message from sibling-lane]\n\n{}",
            goal(i64::MAX, "steal the decision")
        )],
        "the sibling's goal tags route as an ordinary message"
    );
    // The parent's later goal is still consumed after the ceiling
    // attempt, identified by the durable session id this time (the live
    // id here matches no parent edge).
    let parent_again = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": "target-session",
                "message": goal(2, "turn left"),
                "sender": {
                    "sessionId": "parent-durable",
                    "activeSessionId": "another-live",
                    "sessionName": "parent",
                    "runtimeKind": "top-level",
                },
            }),
        )
        .await;
    assert!(
        parent_again.success,
        "second parent delivery failed: {parent_again:?}"
    );
    assert_eq!(
        queue_texts(&worker.core, Lane::Steering).len(),
        1,
        "only the sibling's ordinary message was ever queued"
    );
}
