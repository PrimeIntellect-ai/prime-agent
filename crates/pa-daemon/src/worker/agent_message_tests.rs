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

/// A recording engine for the reply-marking seam: the delivery path only
/// calls `mark_child_reply` here (the run seams stay inert — this suite
/// drives no turn).
struct ReplyRecorderEngine {
    marks: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl SessionEngine for ReplyRecorderEngine {
    fn run_prompt(
        &self,
        _: usize,
        _: PromptRequest,
        _: &dyn Fn() -> bool,
        _: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
    }
    fn run_side_question(
        &self,
        request: crate::engine::SideQuestionRequest,
        signal: &pa_agent::abort::AbortSignal,
        sink: &pa_core::session_engine::side_question::SideQuestionSink,
    ) -> crate::engine::SideQuestionOutcome {
        ScriptedEngine::default().run_side_question(request, signal, sink)
    }
    fn run_compaction(
        &self,
        request: crate::engine::CompactionRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::CompactionOutcome {
        ScriptedEngine::default().run_compaction(request, signal)
    }
    fn run_branch_summary(
        &self,
        request: crate::engine::BranchSummaryRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::BranchSummaryOutcome {
        ScriptedEngine::default().run_branch_summary(request, signal)
    }
    fn rebuild_session_context(
        &self,
        _: Vec<pa_types::session::FileEntry>,
        _: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        Ok(())
    }
    fn mark_child_reply(&self, child_active_session_id: &str) {
        self.marks
            .lock()
            .unwrap()
            .push(child_active_session_id.to_string());
    }
}

/// A created worker whose engine records `mark_child_reply` calls.
fn recording_worker() -> (Worker, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
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
        telemetry_disabled: Some(true),
        script: Some(json!({ "responses": ["ack"] })),
    };
    let marks = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut worker = Worker::new(config, None);
    worker.engine = std::sync::Arc::new(ReplyRecorderEngine {
        marks: std::sync::Arc::clone(&marks),
    });
    (worker, marks)
}

async fn created_recording_worker() -> (
    Worker,
    std::sync::Arc<std::sync::Mutex<Vec<String>>>,
) {
    let (worker, marks) = recording_worker();
    let created = worker
        .dispatch("create", &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }))
        .await;
    assert!(created.success, "create failed: {created:?}");
    (worker, marks)
}

fn child_sender() -> Value {
    json!({
        "activeSessionId": "child-session",
        "sessionId": "child-file",
        "sessionName": "child-lane",
        "runtimeKind": "subagent",
        "parentActiveSessionId": "target-session",
    })
}

/// A sender without a live session id: deliveries from it never mark.
fn anonymous_sender() -> Value {
    json!({ "sessionName": "filler" })
}

async fn deliver_from(
    worker: &Worker,
    message: &str,
    sender: Value,
) -> crate::protocol::DaemonResponse {
    worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": worker.config.active_session_id,
                "message": message,
                "sender": sender,
            }),
        )
        .await
}

/// Every refusal arm of the delivery path — the push queue cap, the digest
/// inbox cap, and the failed durable append — must leave the child
/// unmarked: a reply that never landed cannot suppress the settle watcher's
/// terminal no-reply notice.
#[tokio::test]
async fn refused_deliveries_never_mark_the_child_replied() {
    // The push queue cap: the queue is full, so the delivery is refused
    // before the enqueue.
    let (worker, marks) = created_recording_worker().await;
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
    let response = deliver_from(&worker, "over the push cap", child_sender()).await;
    assert!(!response.success, "deliver should fail: {response:?}");
    assert!(
        marks.lock().unwrap().is_empty(),
        "a cap-refused delivery marked the child replied: {:?}",
        marks.lock().unwrap()
    );

    // The digest inbox cap: the unread inbox is at its bound, so the
    // delivery is refused inside the append's lock section.
    let (worker, marks) = created_recording_worker().await;
    worker.agent_digest.configure_pin("digest").unwrap();
    for index in 0..DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION {
        let filled = deliver_from(&worker, &format!("fill {index}"), anonymous_sender()).await;
        assert!(filled.success, "fill delivery failed: {filled:?}");
    }
    let response = deliver_from(&worker, "over the inbox cap", child_sender()).await;
    assert!(
        !response.success,
        "over-cap delivery admitted: {response:?}"
    );
    assert!(
        marks.lock().unwrap().is_empty(),
        "an inbox-cap-refused delivery marked the child replied: {:?}",
        marks.lock().unwrap()
    );

    // The failed durable append: every append to the store fails (a
    // directory as the session-file path), so the digest delivery is
    // refused with the store's error.
    let (worker, marks) = created_recording_worker().await;
    worker.agent_digest.configure_pin("digest").unwrap();
    let dir = tempfile::TempDir::new().unwrap();
    worker.core.lock().unwrap().store.as_mut().unwrap().set_path(dir.path().to_path_buf());
    let response = deliver_from(&worker, "must not mark", child_sender()).await;
    assert!(
        !response.success,
        "a failed durable append answered success: {response:?}"
    );
    assert!(
        marks.lock().unwrap().is_empty(),
        "an append-failed delivery marked the child replied: {:?}",
        marks.lock().unwrap()
    );
}

/// Both acceptance arms of the delivery path — the digest inbox's stored
/// row and the push lane's enqueue — record the child's reply exactly
/// once, so the settle watcher can withhold the no-reply notice.
#[tokio::test]
async fn accepted_deliveries_mark_the_child_replied_on_both_lanes() {
    // The digest lane: the row reaches the durable inbox.
    let (worker, marks) = created_recording_worker().await;
    worker.agent_digest.configure_pin("digest").unwrap();
    let response = deliver_from(&worker, "digested reply", child_sender()).await;
    assert!(response.success, "deliver failed: {response:?}");
    assert_eq!(
        response.data.expect("receipt data")["deliveryStatus"],
        "digest"
    );
    assert_eq!(
        marks.lock().unwrap().as_slice(),
        ["child-session"],
        "the digested reply must mark the child once"
    );

    // The push lane: the message is enqueued on the steering lane.
    let (worker, marks) = created_recording_worker().await;
    let response = deliver_from(&worker, "pushed reply", child_sender()).await;
    assert!(response.success, "deliver failed: {response:?}");
    assert_eq!(
        response.data.expect("receipt data")["deliveryStatus"],
        "delivered"
    );
    assert_eq!(
        marks.lock().unwrap().as_slice(),
        ["child-session"],
        "the queued reply must mark the child once"
    );
}
