use super::*;

fn session_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pa-windowed-attach-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn header_line(id: &str) -> String {
    format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}}\n"
    )
}

fn parent_json(prev: Option<&str>) -> String {
    serde_json::to_string(&prev).unwrap()
}

fn message_row(prev: Option<&str>, id: &str, message: &Value) -> String {
    format!(
        "{{\"type\":\"message\",\"message\":{},\"id\":\"{id}\",\"parentId\":{},\"timestamp\":\"2026-01-01T00:00:00.000Z\"}}\n",
        serde_json::to_string(&message).unwrap(),
        parent_json(prev),
    )
}

fn custom_row(prev: Option<&str>, id: &str) -> String {
    format!(
        "{{\"type\":\"custom_message\",\"customType\":\"session_slash_command\",\"content\":\"head slash echo\",\"display\":true,\"id\":\"{id}\",\"parentId\":{},\"timestamp\":\"2026-01-01T00:00:00.000Z\"}}\n",
        parent_json(prev),
    )
}

fn assistant_message(text: &str) -> Value {
    json!({
        "role": "assistant",
        "content": [{ "type": "text", "text": text }],
        "timestamp": 10u64,
    })
}

fn image_tool_result_message() -> Value {
    json!({
        "role": "toolResult",
        "toolCallId": "img-call",
        "toolName": "ipython",
        "content": [
            { "type": "text", "text": "Loaded 1 image(s) into context" },
            { "type": "image", "data": "QUJDRA==", "mimeType": "image/png" }
        ],
        "isError": false,
        "timestamp": 12u64,
    })
}

fn tool_result_message() -> Value {
    json!({
        "role": "toolResult",
        "toolCallId": "call",
        "toolName": "bash",
        "content": [{ "type": "text", "text": "output" }],
        "isError": false,
        "timestamp": 11u64,
    })
}

struct Fixture {
    content: String,
    prev: Option<String>,
    id: usize,
}

impl Fixture {
    fn row(&mut self, build: impl FnOnce(Option<&str>, &str) -> String) {
        let prev = self.prev.clone();
        self.id += 1;
        let row_id = format!("m{:07}", self.id);
        self.content.push_str(&build(prev.as_deref(), &row_id));
        self.prev = Some(row_id);
    }
}

async fn worker_over(dir: &std::path::Path, path: &std::path::Path) -> std::sync::Arc<Worker> {
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "windowed-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({
                "cwd": dir.to_string_lossy(),
                "sessionDir": dir.join("sessions").to_string_lossy(),
                "sessionPath": path.to_string_lossy(),
                "name": "windowed",
            }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

async fn attach(worker: &Worker, capabilities: &[&str]) -> Value {
    let response = worker
        .dispatch(
            "attach",
            &json!({
                "activeSessionId": "windowed-session",
                "clientId": "windowed-client",
                "capabilities": capabilities,
            }),
        )
        .await;
    assert!(response.success, "attach failed: {response:?}");
    response.data.expect("attach data")
}

async fn full_messages(worker: &Worker) -> Vec<Value> {
    let response = worker.dispatch("get_messages", &json!({})).await;
    assert!(response.success, "get_messages failed: {response:?}");
    response.data.expect("get_messages data")["messages"]
        .as_array()
        .expect("messages array")
        .clone()
}

const TUI_CAPABILITIES: &[&str] = &[
    "attach_snapshot",
    "event_sequence",
    "slim_attach",
    "elide_snapshot_images",
    "windowed_snapshot",
];

#[tokio::test]
async fn a_windowed_attach_serves_a_tool_result_safe_tail() {
    let dir = session_dir();
    let path = dir.join("windowed-tail.jsonl");
    let mut fixture = Fixture {
        content: header_line("windowed-tail"),
        prev: None,
        id: 0,
    };
    fixture.row(|prev, id| {
        message_row(
            prev,
            id,
            &json!({
                "role": "user",
                "content": "the head prompt",
                "timestamp": 1000u64,
            }),
        )
    });
    fixture.row(custom_row);
    fixture.row(custom_row);
    for _ in 0..194 {
        fixture.row(|prev, id| message_row(prev, id, &assistant_message("kept context")));
    }
    fixture.row(|prev, id| message_row(prev, id, &image_tool_result_message()));
    fixture.row(|prev, id| {
        message_row(
            prev,
            id,
            &json!({
                "role": "assistant",
                "content": [{ "type": "toolCall", "id": "call-1", "name": "bash", "arguments": { "command": "ls" } }],
                "timestamp": 4u64,
            }),
        )
    });
    fixture.row(custom_row);
    for _ in 0..800 {
        fixture.row(|prev, id| message_row(prev, id, &tool_result_message()));
    }
    std::fs::write(&path, fixture.content).unwrap();

    let worker = worker_over(&dir, &path).await;
    let full = full_messages(&worker).await;
    assert_eq!(
        full.len(),
        1000,
        "the walk visits every message-bearing row"
    );

    let data = attach(&worker, TUI_CAPABILITIES).await;
    let snapshot = &data["snapshot"];
    let tail = snapshot["messages"].as_array().expect("tail messages");
    let omitted = snapshot["historyBefore"].as_u64().expect("historyBefore");
    assert_eq!(
        omitted, 198,
        "the cut snaps back off the tool result and custom rows"
    );
    assert_eq!(tail.len(), 802, "the tail keeps the whole tool call run");
    assert_eq!(
        tail[0]["role"], "assistant",
        "the first tail message is never a tool result or custom row"
    );
    assert_eq!(
        tail[1]["role"], "custom",
        "the custom row rides the tail with its tool call"
    );
    assert_eq!(
        &tail[..],
        &full[(omitted as usize)..],
        "the tail is a suffix of the one walk"
    );
    assert_eq!(
        snapshot["lastUserPromptMs"], 1000,
        "the newest user timestamp rides the windowed snapshot"
    );
    let head = worker
        .dispatch("get_messages", &json!({ "before": omitted }))
        .await;
    assert!(head.success, "the head fetch failed: {head:?}");
    assert_eq!(
        head.data.expect("head data")["messages"],
        serde_json::json!(full[..omitted as usize]),
        "the before range serves the walk's omitted prefix"
    );
    let elided = worker
        .dispatch(
            "get_messages",
            &json!({
                "before": omitted,
                "capabilities": TUI_CAPABILITIES,
            }),
        )
        .await;
    assert!(elided.success, "the elided head fetch failed: {elided:?}");
    let elided_messages = elided.data.expect("elided head data")["messages"]
        .as_array()
        .expect("elided messages")
        .clone();
    assert_eq!(
        elided_messages[197]["content"][1]["data"], "",
        "the image payload leaves the backfill head"
    );
    assert_eq!(
        elided_messages[197]["content"][1]["elidedBytes"], 8,
        "the elided marker rides the backfill head"
    );

    let plain = attach(&worker, &["attach_snapshot", "event_sequence"]).await;
    let plain_messages = plain["snapshot"]["messages"].as_array().expect("messages");
    assert_eq!(
        plain_messages.len(),
        1000,
        "a non-windowed attach keeps the full snapshot"
    );
    assert!(
        plain["snapshot"].get("historyBefore").is_none()
            && plain["snapshot"].get("lastUserPromptMs").is_none(),
        "the unwindowed snapshot keeps today's shape"
    );
}

#[tokio::test]
async fn a_windowed_attach_never_cuts_inside_the_compaction_retained_segment() {
    let dir = session_dir();
    let path = dir.join("windowed-compacted.jsonl");
    let retained = 400usize;
    let post = 200usize;
    let mut fixture = Fixture {
        content: header_line("windowed-compacted"),
        prev: None,
        id: 0,
    };
    for _ in 0..10 {
        fixture.row(|prev, id| message_row(prev, id, &assistant_message("compacted away")));
    }
    let first_kept = fixture.prev.clone().expect("retained start");
    for _ in 1..retained {
        fixture.row(|prev, id| message_row(prev, id, &assistant_message("retained")));
    }
    fixture.row(|prev, id| {
        format!(
            "{{\"type\":\"compaction\",\"summary\":\"the story\",\"firstKeptEntryId\":\"{first_kept}\",\"tokensBefore\":4000,\"id\":\"{id}\",\"parentId\":{},\"timestamp\":\"2026-01-01T00:00:00.000Z\"}}\n",
            parent_json(prev),
        )
    });
    for _ in 0..post {
        fixture.row(|prev, id| message_row(prev, id, &assistant_message("after compaction")));
    }
    std::fs::write(&path, fixture.content).unwrap();

    let worker = worker_over(&dir, &path).await;
    let full = full_messages(&worker).await;
    assert_eq!(
        full[0]["role"], "compactionSummary",
        "the walk serves the summary first"
    );
    assert_eq!(full.len(), 601, "summary plus retained plus post");

    let data = attach(&worker, TUI_CAPABILITIES).await;
    let snapshot = &data["snapshot"];
    let tail = snapshot["messages"].as_array().expect("tail messages");
    let omitted = snapshot["historyBefore"].as_u64().unwrap_or(0);
    assert!(
        omitted == 0 || omitted >= 401,
        "the cut is complete history or past the retained segment, got {omitted}"
    );
    assert_eq!(tail.len(), 601 - omitted as usize);
    assert_eq!(&tail[..], &full[(omitted as usize)..]);
}

#[tokio::test]
async fn a_windowed_attach_preserves_iso_and_fractional_prompt_times() {
    for timestamp in [json!(2000.75), json!("1970-01-01T00:00:02.000Z")] {
        for user_index in [1usize, 599] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("timestamp-tail.jsonl");
            let mut fixture = Fixture {
                content: header_line("timestamp-tail"),
                prev: None,
                id: 0,
            };
            for index in 0..600 {
                let message = if index == user_index {
                    json!({ "role": "user", "content": "latest", "timestamp": timestamp })
                } else if index == 0 {
                    json!({ "role": "user", "content": "older", "timestamp": 1000 })
                } else {
                    assistant_message("continuation")
                };
                fixture.row(|prev, id| message_row(prev, id, &message));
            }
            std::fs::write(&path, fixture.content).unwrap();
            let worker = worker_over(dir.path(), &path).await;
            let data = attach(&worker, TUI_CAPABILITIES).await;
            let snapshot = &data["snapshot"];
            assert_eq!(snapshot["historyBefore"], 88);
            assert_eq!(
                snapshot["lastUserPromptMs"], 2000,
                "latest timestamp {timestamp} at index {user_index}"
            );
        }
    }
}
