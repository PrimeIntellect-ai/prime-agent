//! Session-read commands over the persisted branch against differential
//! goldens captured from the live TS daemon.

use std::path::Path;

use super::*;

// Differential goldens from the live TS daemon (protocol 7, schema 28:
// read-only `get_session_header` / `get_session_stats` on a live session).
#[test]
fn session_stats_and_header_match_live_daemon_goldens() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [{ "text": "hi", "delayMs": 0 }] }).to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        &serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    // `id` is the short display/selector id; `sessionId` is the persisted
    // session UUID (what `get_session_header` / `get_session_stats` report).
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();
    let session_uuid = created["data"]["sessionId"]
        .as_str()
        .expect("sessionId in create response")
        .to_string();

    // The turn's streamed events go to attached clients only.
    client.send_command(
        "a1",
        &serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    client.send_command(
        "p1",
        &serde_json::json!({ "type": "prompt", "activeSessionId": session_id, "message": "hi" }),
    );
    let (ack, mut turn_lines) = client.read_response_and_lines("p1");
    assert_eq!(ack["success"], true, "prompt failed: {ack}");
    // The turn's events may precede the prompt reply (TS order), so the
    // lines buffered during the ack count toward the drain.
    client.take_session_event(&mut turn_lines, "turn_end");

    // get_session_header: the TS golden shape
    // {"header": { type, version, id, timestamp, cwd, parentSession?, rlmDepth?, git? }}.
    client.send_command(
        "h1",
        &serde_json::json!({ "type": "get_session_header", "activeSessionId": session_id }),
    );
    let header = client.read_response("h1");
    assert_eq!(
        header["success"], true,
        "get_session_header failed: {header}"
    );
    let header = &header["data"]["header"];
    assert_eq!(header["type"], "session");
    assert_eq!(header["version"], 3);
    assert_eq!(header["id"], session_uuid.as_str());
    assert_eq!(header["cwd"], dir.path().to_string_lossy().to_string());
    assert!(header["timestamp"]
        .as_str()
        .is_some_and(|v| v.ends_with('Z')));
    let header_keys: Vec<&str> = header
        .as_object()
        .expect("header object")
        .keys()
        .map(String::as_str)
        .collect();
    // The TS session-file header key order (the comment above): the JSON
    // map preserves insertion order, so this is the wire byte order.
    assert_eq!(
        header_keys,
        vec!["type", "version", "id", "timestamp", "cwd", "rlmDepth"]
    );

    // get_session_stats: the TS stats shape over the scripted turn. The
    // scripted engine has no model, so `contextUsage` is omitted exactly like
    // a TS session without a model context window.
    client.send_command(
        "st1",
        &serde_json::json!({ "type": "get_session_stats", "activeSessionId": session_id }),
    );
    let stats = client.read_response("st1");
    assert_eq!(stats["success"], true, "get_session_stats failed: {stats}");
    let data = &stats["data"];
    assert_eq!(data["sessionId"], session_uuid.as_str());
    assert!(data["sessionFile"]
        .as_str()
        .and_then(|path| Path::new(path).extension())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl")));
    assert_eq!(data["userMessages"], 1);
    assert_eq!(data["assistantMessages"], 1);
    assert_eq!(data["toolCalls"], 0);
    assert_eq!(data["toolResults"], 0);
    assert_eq!(data["totalMessages"], 2);
    assert_eq!(data["cost"], 0.0);
    // Scripted usage block: input 120, output 8.
    assert_eq!(data["tokens"]["input"], 120);
    assert_eq!(data["tokens"]["output"], 8);
    assert_eq!(data["tokens"]["cacheRead"], 0);
    assert_eq!(data["tokens"]["cacheWrite"], 0);
    assert_eq!(data["tokens"]["total"], 128);
    let stats_keys: Vec<&str> = data
        .as_object()
        .expect("stats object")
        .keys()
        .map(String::as_str)
        .collect();
    // TS `SessionStats` key order: the JSON map preserves insertion order.
    assert_eq!(
        stats_keys,
        vec![
            "sessionFile",
            "sessionId",
            "userMessages",
            "assistantMessages",
            "toolCalls",
            "toolResults",
            "totalMessages",
            "tokens",
            "cost",
        ]
    );

    client.send_command(
        "h2",
        &serde_json::json!({ "type": "get_session_stats", "activeSessionId": "nope" }),
    );
    let missing = client.read_response("h2");
    assert_eq!(missing["success"], false);
    assert_eq!(missing["error"], "Unknown active session: nope");
}
