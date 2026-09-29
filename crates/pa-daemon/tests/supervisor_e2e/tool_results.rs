//! Tool-result entries (session-file parity): a real-engine turn whose
//! scripted response requests an unknown tool persists a `role: "toolResult"`
//! message entry, streams it, and counts in `get_session_stats`.

use super::*;

// Tool-result entries (session-file parity, TS `_processAgentEvent`): a
// real-engine turn whose scripted response requests an unknown tool
// persists a `role: "toolResult"` message entry, streams the message pair
// to attached clients, and counts in `get_session_stats`.
#[test]
fn tool_result_entries_persisted_and_streamed() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let sessions_dir = agent_dir.join("sessions");
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "no-such-tool", "id": "call-1", "arguments": {} },
                ] },
                { "text": "done" },
            ],
        })
        .to_string(),
    )
    .expect("write script");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    client.send_command(
        "c1",
        &serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();
    client.send_command(
        "a1",
        &serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    assert_eq!(client.read_response("a1")["success"], true, "attach failed");

    client.send_command(
        "p1",
        &serde_json::json!({ "type": "prompt", "activeSessionId": session_id, "message": "hi" }),
    );
    let (prompt_ack, mut lines) = client.read_response_and_lines("p1");
    assert_eq!(prompt_ack["success"], true, "prompt failed: {prompt_ack}");

    // Streamed events: the tool execution frames, then the toolResult
    // message pair, then the closing turn.
    let mut tool_result_message = serde_json::Value::Null;
    let mut message_pair = 0usize;
    let mut tool_execution_end = serde_json::Value::Null;
    loop {
        let event = client.next_line_of_type(&mut lines, "session_event")["event"].clone();
        match event["type"].as_str() {
            Some("tool_execution_start") => {
                assert_eq!(event["toolName"], "no-such-tool");
                assert_eq!(event["toolCallId"], "call-1");
            }
            Some("tool_execution_end") => tool_execution_end = event.clone(),
            Some("message_start" | "message_end") => {
                if event["message"]["role"] == "toolResult" {
                    message_pair += 1;
                    tool_result_message = event["message"].clone();
                }
            }
            Some("turn_end") => break,
            _ => {}
        }
    }
    assert_eq!(tool_execution_end["isError"], true);
    assert_eq!(
        tool_execution_end["toolCallId"], "call-1",
        "tool_execution_end: {tool_execution_end}"
    );
    assert_eq!(
        message_pair, 2,
        "toolResult message_start + message_end pair"
    );
    assert_eq!(tool_result_message["toolCallId"], "call-1");
    assert_eq!(tool_result_message["toolName"], "no-such-tool");
    assert_eq!(
        tool_result_message["content"][0]["text"],
        "Tool no-such-tool not found"
    );
    assert_eq!(tool_result_message["isError"], true);

    // The stats command counts the persisted entry.
    client.send_command(
        "s1",
        &serde_json::json!({ "type": "get_session_stats", "activeSessionId": session_id }),
    );
    let stats = client.read_response("s1");
    assert_eq!(stats["success"], true, "get_session_stats failed: {stats}");
    assert_eq!(stats["data"]["toolCalls"], 1, "stats: {stats}");
    assert_eq!(stats["data"]["toolResults"], 1, "stats: {stats}");
    assert_eq!(stats["data"]["totalMessages"], 4, "stats: {stats}");

    // The session file carries the entry in the TS envelope shape.
    let session_file = std::path::PathBuf::from(
        stats["data"]["sessionFile"]
            .as_str()
            .expect("session file in stats"),
    );
    let entries: Vec<serde_json::Value> = std::fs::read_to_string(&session_file)
        .expect("read session file")
        .lines()
        .map(|line| serde_json::from_str(line).expect("parse entry line"))
        .collect();
    let tool_result_entry = entries
        .iter()
        .find(|entry| entry["message"]["role"] == "toolResult")
        .expect("toolResult entry on disk")
        .clone();
    assert_eq!(tool_result_entry["type"], "message");
    assert!(tool_result_entry["id"]
        .as_str()
        .is_some_and(|id| id.len() == 8));
    assert!(tool_result_entry["parentId"].as_str().is_some());
    assert!(tool_result_entry["timestamp"].as_str().is_some());
    assert_eq!(tool_result_entry["message"]["toolCallId"], "call-1");
    assert_eq!(
        tool_result_entry["message"]["content"],
        serde_json::json!([{ "type": "text", "text": "Tool no-such-tool not found" }])
    );
    assert_eq!(tool_result_entry["message"]["isError"], true);
    assert!(tool_result_entry["message"]["timestamp"].is_u64());
}
