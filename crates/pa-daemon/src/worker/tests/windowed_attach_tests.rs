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

/// One display-transcript page, optionally anchored to the attached branch leaf.
async fn page(worker: &Worker, page: Value, leaf: Option<&str>) -> DaemonResponse {
    let mut payload = json!({ "page": page, "capabilities": TUI_CAPABILITIES });
    if let Some(leaf) = leaf {
        payload["historyLeafId"] = json!(leaf);
    }
    worker.dispatch("get_messages", &payload).await
}

fn row_id(message_index: usize) -> String {
    format!("m{:07}", message_index + 1)
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
    let omitted = 198;
    assert_eq!(
        snapshot["historyBeforeEntryId"],
        json!(row_id(omitted)),
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
        &full[omitted..],
        "the tail is a suffix of the walk"
    );
    assert_eq!(
        snapshot["lastUserPromptMs"], 1000,
        "the newest user timestamp rides the windowed snapshot"
    );
    let head = page(
        &worker,
        json!({ "from": "end", "before": row_id(omitted), "limit": 1000 }),
        None,
    )
    .await;
    assert!(head.success, "the head fetch failed: {head:?}");
    let head = head.data.expect("head data");
    assert_eq!(head["more"], false, "the page reaches the session start");
    assert_eq!(head["firstEntryId"], json!(row_id(0)));
    assert_eq!(head["lastEntryId"], json!(row_id(omitted - 1)));
    let head_messages = head["messages"].as_array().expect("head messages");
    assert_eq!(
        head_messages.len(),
        omitted,
        "the page serves the omitted prefix"
    );
    assert_eq!(
        head_messages[197]["content"][1]["data"], "",
        "the image payload leaves the page"
    );
    assert_eq!(
        head_messages[197]["content"][1]["elidedBytes"], 8,
        "the elided marker rides the page"
    );

    let plain = attach(&worker, &["attach_snapshot", "event_sequence"]).await;
    let plain_messages = plain["snapshot"]["messages"].as_array().expect("messages");
    assert_eq!(
        plain_messages.len(),
        1000,
        "a non-windowed attach keeps the full snapshot"
    );
    assert!(
        plain["snapshot"].get("historyBeforeEntryId").is_none()
            && plain["snapshot"].get("lastUserPromptMs").is_none(),
        "the unwindowed snapshot keeps today's shape"
    );
}

#[tokio::test]
async fn pages_continue_into_pre_compaction_history_with_one_summary() {
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
    fixture.row(|prev, id| message_row(prev, id, &assistant_message("retained")));
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
    let data = attach(&worker, TUI_CAPABILITIES).await;
    let snapshot = &data["snapshot"];
    let tail = snapshot["messages"]
        .as_array()
        .expect("tail messages")
        .clone();
    let tail_first = snapshot["historyBeforeEntryId"]
        .as_str()
        .expect("older history exists above the tail")
        .to_string();
    let older = page(
        &worker,
        json!({ "from": "end", "before": tail_first, "limit": 1000 }),
        None,
    )
    .await;
    assert!(older.success, "the older page failed: {older:?}");
    let older = older.data.expect("older data");
    assert_eq!(older["more"], false);
    let mut display = older["messages"]
        .as_array()
        .expect("older messages")
        .clone();
    display.extend(tail);
    let texts: Vec<&str> = display
        .iter()
        .map(|message| {
            message["content"][0]["text"]
                .as_str()
                .or_else(|| message["summary"].as_str())
                .unwrap_or_default()
        })
        .collect();
    let expected: Vec<&str> = std::iter::repeat_n("compacted away", 10)
        .chain(std::iter::repeat_n("retained", retained))
        .chain(["the story"])
        .chain(std::iter::repeat_n("after compaction", post))
        .collect();
    assert_eq!(
        texts, expected,
        "the display walk is the whole branch in order with the summary once at the compaction"
    );

    // A zero limit is an empty page at either end, never a panic under the core lock.
    for empty in [
        json!({ "from": "end", "limit": 0 }),
        json!({ "from": "start", "until": tail_first, "limit": 0 }),
    ] {
        let response = page(&worker, empty, None).await;
        assert!(response.success, "a zero-limit page failed: {response:?}");
        assert_eq!(
            response.data.expect("empty page data")["messages"],
            json!([])
        );
    }

    // The head page and a newer page stop at their bounds.
    let head = page(
        &worker,
        json!({ "from": "start", "until": tail_first, "limit": 5 }),
        None,
    )
    .await;
    let head = head.data.expect("head data");
    assert_eq!(head["messages"], json!(display[..5]));
    assert_eq!(head["more"], true);
    let rest = page(
        &worker,
        json!({ "from": "start", "after": head["lastEntryId"], "until": tail_first, "limit": 1000 }),
        None,
    )
    .await;
    let rest = rest.data.expect("rest data");
    assert_eq!(
        rest["more"], false,
        "the newer page closes the gap to the tail"
    );
    assert_eq!(
        rest["messages"],
        json!(older["messages"].as_array().unwrap()[5..]),
        "the newer page ends right before the tail"
    );
}

#[tokio::test]
async fn a_windowed_attach_preserves_iso_and_fractional_prompt_times() {
    for timestamp in [
        json!(2000.75),
        json!("1970-01-01T00:00:02.000Z"),
        json!("1970-01-01T01:00:02.000+01:00"),
    ] {
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
            assert_eq!(snapshot["historyBeforeEntryId"], json!(row_id(88)));
            assert_eq!(
                snapshot["lastUserPromptMs"], 2000,
                "latest timestamp {timestamp} at index {user_index}"
            );
        }
    }
}

/// The chunked stream's advertised count is the transcript it carries:
/// a windowed attach streams the tail alone, and the summary keeps the
/// session total.
#[tokio::test]
async fn a_chunked_windowed_attach_streams_the_count_it_carries() {
    let dir = session_dir();
    let path = dir.join("windowed-chunked.jsonl");
    let mut fixture = Fixture {
        content: header_line("windowed-chunked"),
        prev: None,
        id: 0,
    };
    for index in 0..600 {
        let message = if index == 0 {
            json!({ "role": "user", "content": "the head prompt", "timestamp": 1000u64 })
        } else {
            assistant_message("kept context")
        };
        fixture.row(|prev, id| message_row(prev, id, &message));
    }
    std::fs::write(&path, fixture.content).unwrap();

    let worker = worker_over(&dir, &path).await;
    let full = full_messages(&worker).await;
    assert_eq!(full.len(), 600, "the walk visits every message row");

    let mut capabilities = TUI_CAPABILITIES.to_vec();
    capabilities.push("chunked_snapshot");
    let data = attach(&worker, &capabilities).await;
    let snapshot = &data["snapshot"];
    let summary_count = snapshot["summary"]["messageCount"]
        .as_u64()
        .expect("summary count");
    assert_eq!(snapshot["historyBeforeEntryId"], json!(row_id(88)));
    assert_eq!(summary_count, 600);
    assert_eq!(snapshot["messages"].as_array().expect("tail").len(), 512);

    // The supervisor's streaming step (routing.rs `streamed_attach_lines`).
    let (streamed, events) = crate::snapshot_stream::stream_attach(
        data,
        "windowed-session",
        pa_types::daemon::SnapshotPurpose::Attach,
    )
    .expect("stream");
    let crate::snapshot_stream::SnapshotStreamEvents::Streamed(lines) = events else {
        panic!("the windowed tail must stream");
    };
    let begin = lines
        .iter()
        .find(|line| line["type"] == json!("session_snapshot_begin"))
        .expect("begin record");
    let carried: u64 = lines
        .iter()
        .filter(|line| line["type"] == json!("session_snapshot_chunk"))
        .map(|chunk| chunk["messages"].as_array().map_or(0, Vec::len) as u64)
        .sum();
    assert_eq!(
        begin["messageCount"], streamed["snapshotStream"]["messageCount"],
        "the begin record and the stream descriptor carry one count"
    );
    assert_eq!(
        begin["messageCount"].as_u64().expect("begin count"),
        carried,
        "the advertised count is the messages the stream carries"
    );
    assert_eq!(
        88 + carried,
        summary_count,
        "the tail plus the rows above its cursor is the session total"
    );
}

#[tokio::test]
async fn a_windowed_attach_keeps_interleaved_tool_pairs_together() {
    for scenario in [0, 1, 2] {
        let crossing = scenario != 0;
        let earlier_id = if scenario == 2 { "boundary" } else { "earlier" };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("interleaved-tools.jsonl");
        let mut fixture = Fixture {
            content: header_line("interleaved-tools"),
            prev: None,
            id: 0,
        };
        for _ in 0..20 {
            fixture.row(|prev, id| message_row(prev, id, &assistant_message("older history")));
        }
        let call = |id: &str| {
            json!({
                "role": "assistant", "timestamp": 10,
                "content": [{"type": "toolCall", "id": id, "name": "bash", "arguments": {"command": "echo paired"}}],
            })
        };
        let result = |id: &str| {
            json!({
                "role": "toolResult", "toolCallId": id, "toolName": "bash", "timestamp": 12,
                "content": [{"type": "text", "text": "paired result"}], "isError": false,
            })
        };
        if crossing {
            fixture.row(|prev, id| message_row(prev, id, &call(earlier_id)));
        }
        fixture.row(|prev, id| message_row(prev, id, &call("boundary")));
        if crossing {
            fixture.row(|prev, id| message_row(prev, id, &result(earlier_id)));
        }
        // A user !command can finish while an agent tool is still running.
        // Place this real message role exactly at the nominal 512-row cut.
        fixture.row(|prev, id| {
            message_row(
                prev,
                id,
                &json!({
                    "role": "bashExecution", "command": "echo user", "output": "user",
                    "exitCode": 0, "cancelled": false, "truncated": false, "timestamp": 11,
                }),
            )
        });
        fixture.row(|prev, id| message_row(prev, id, &result("boundary")));
        for _ in 0..510 {
            fixture.row(|prev, id| message_row(prev, id, &assistant_message("newer history")));
        }
        std::fs::write(&path, fixture.content).unwrap();
        let worker = worker_over(dir.path(), &path).await;
        let full = full_messages(&worker).await;
        let data = attach(&worker, TUI_CAPABILITIES).await;
        let snapshot = &data["snapshot"];
        assert_eq!(
            snapshot["historyBeforeEntryId"],
            json!(row_id(20)),
            "both matched pairs belong in the tail; unrelated older history stays omitted"
        );
        assert_eq!(
            snapshot["messages"],
            json!(full[20..]),
            "moving the boundary preserves the complete ordered suffix"
        );
        let head = page(
            &worker,
            json!({ "from": "end", "before": row_id(20), "limit": 1000 }),
            None,
        )
        .await;
        assert!(head.success);
        assert_eq!(
            head.data.unwrap()["messages"],
            json!(full[..20]),
            "the omitted prefix remains available without duplication"
        );
    }
}

async fn branched_worker() -> (tempfile::TempDir, std::sync::Arc<Worker>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("branched-tail.jsonl");
    let mut fixture = Fixture {
        content: header_line("branched-tail"),
        prev: None,
        id: 0,
    };
    fixture.content.push_str(&message_row(
        /*prev*/ None,
        "sibling",
        &assistant_message("other branch"),
    ));
    for index in 0..600 {
        fixture.row(|prev, id| {
            message_row(prev, id, &assistant_message(&format!("original {index}")))
        });
    }
    std::fs::write(&path, fixture.content).unwrap();
    let worker = worker_over(dir.path(), &path).await;
    (dir, worker)
}

#[tokio::test]
async fn anchored_backfill_rejects_other_client_branch_navigation() {
    for target in ["sibling", "m0000300"] {
        let (_dir, worker) = branched_worker().await;
        let data = attach(&worker, TUI_CAPABILITIES).await;
        let snapshot = &data["snapshot"];
        let leaf = snapshot["state"]["leafId"].as_str().expect("attached leaf");
        let tail_first = snapshot["historyBeforeEntryId"].clone();
        assert_eq!(tail_first, json!(row_id(88)));
        let navigated = worker
            .dispatch(
                "navigate_tree",
                &json!({"clientId": "other-client", "targetId": target}),
            )
            .await;
        assert!(navigated.success, "navigation failed: {navigated:?}");
        let current = full_messages(&worker).await;
        assert_eq!(current.len(), if target == "sibling" { 1 } else { 300 });
        let backfill = page(
            &worker,
            json!({ "from": "end", "before": tail_first, "limit": 256 }),
            Some(leaf),
        )
        .await;
        assert!(
            !backfill.success,
            "a prefix from {target} must not join the old attach tail: {backfill:?}"
        );
        assert_eq!(
            full_messages(&worker).await,
            current,
            "legacy full reads remain available"
        );
    }
}

#[tokio::test]
async fn anchored_backfill_accepts_descendant_appends_and_restored_branch() {
    let (_dir, worker) = branched_worker().await;
    let original = full_messages(&worker).await;
    let data = attach(&worker, TUI_CAPABILITIES).await;
    let snapshot = &data["snapshot"];
    let leaf = snapshot["state"]["leafId"].as_str().expect("attached leaf");
    let appended = worker
        .dispatch(
            "prompt_and_wait",
            &json!({"activeSessionId": "windowed-session", "message": "append on this branch"}),
        )
        .await;
    assert!(appended.success, "append failed: {appended:?}");
    assert!(full_messages(&worker).await.len() > original.len());
    for restore in [false, true] {
        if restore {
            for target in ["sibling", leaf] {
                let navigated = worker
                    .dispatch(
                        "navigate_tree",
                        &json!({"clientId": "other-client", "targetId": target}),
                    )
                    .await;
                assert!(navigated.success, "navigation failed: {navigated:?}");
            }
        }
        let backfill = page(
            &worker,
            json!({ "from": "end", "before": snapshot["historyBeforeEntryId"], "limit": 256 }),
            Some(leaf),
        )
        .await;
        assert!(backfill.success, "coherent prefix rejected: {backfill:?}");
        let returned = backfill.data.expect("backfill data");
        assert_eq!(returned["messages"], json!(original[..88]));
        assert_eq!(
            returned["historyLeafId"], leaf,
            "the worker acknowledges that it honored the anchor"
        );
    }
}
