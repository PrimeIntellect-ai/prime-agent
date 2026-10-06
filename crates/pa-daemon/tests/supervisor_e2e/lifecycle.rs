//! The core scripted end-to-end scenario: the supervisor hello handshake,
//! session create, a turn streamed to an attached client, and session stop
//! through the real `pa-daemon` supervisor.

use std::path::Path;

use super::*;

#[test]
fn supervisor_end_to_end_scripted_session_lifecycle() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    // Differential goldens captured from the TS supervisor
    // (`prime-agent --mode daemon`, protocol 7, schema 29).
    assert_eq!(
        hello["protocol"],
        serde_json::json!({
            "name": "prime-agent.daemon", "version": 7
        })
    );
    assert_eq!(
        hello["schemaId"]
            .as_str()
            .map(std::string::ToString::to_string),
        Some("protocol-7-schema-30-8e4b17c2a9f5".to_string())
    );
    assert!(hello["supervisorOwnerToken"].is_string());
    assert!(hello["supervisorProcessStartId"]
        .as_str()
        .unwrap_or_default()
        .starts_with("proc:"));
    assert_eq!(
        hello["serverCapabilities"],
        serde_json::json!([
            "attach_snapshot",
            "event_sequence",
            "slim_attach",
            "chunked_snapshot",
            "client_owned_sessions",
            "elide_snapshot_images",
            "delete_rlm_subagent",
            "heartbeat_catalog",
            "heartbeat_management",
            "model_catalog",
            "side_question_transcript",
            "transient_bash",
            "kernel_bash_activity",
            "session_input_admission",
            "prompt_admission_cancellation",
            "owned_prompt_cancellation",
            "queue_message_mutation",
            "authoritative_child_roster",
            "owned_session_recovery_context",
            "rlm_quiescence_barrier",
            "session_input_pause",
            "acp_mcp_servers",
            "abort_and_send_queued",
            "agent_roster",
            "direct_peer_transport",
        ])
    );

    // Bare commands are rejected exactly like the TS supervisor.
    client.send(&serde_json::json!({ "type": "list", "id": "bare" }));
    let rejected = client.read_response("bare");
    assert_eq!(rejected["command"], "parse");
    assert_eq!(rejected["success"], false);
    assert_eq!(
        rejected["error"],
        "Daemon commands require protocol 7 or newer"
    );

    client.send_command("l1", &serde_json::json!({ "type": "list" }));
    let list = client.read_response("l1");
    assert_eq!(list["success"], true, "list failed: {list}");
    assert_eq!(list["data"]["sessions"], serde_json::json!([]));

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [
            { "text": "hello from scripted", "delayMs": 30 },
            { "text": "second turn" },
        ] })
        .to_string(),
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
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();

    client.send_command(
        "a1",
        &serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    // Attach wire shape (differential goldens from the TS supervisor): slim
    // attach carries summary/messages only inside the snapshot, no
    // `session_attached` convenience event precedes the response.
    let data = &attached["data"];
    let keys: Vec<&str> = data
        .as_object()
        .expect("attach data object")
        .keys()
        .map(String::as_str)
        .collect();
    // TS `createAttachResult` key order: the JSON map preserves insertion
    // order, so this is the wire byte order.
    assert_eq!(
        keys,
        vec![
            "protocol",
            "activeSessionId",
            "snapshot",
            "replay",
            "lastEventSequence",
            "lastEventCursor",
            "client",
        ]
    );
    let snapshot = &data["snapshot"];
    let snapshot_keys: Vec<&str> = snapshot
        .as_object()
        .expect("snapshot object")
        .keys()
        .map(String::as_str)
        .collect();
    // TS `createSessionSnapshot` key order.
    assert_eq!(
        snapshot_keys,
        vec![
            "activeSessionId",
            "summary",
            "state",
            "messages",
            "lastEventSequence",
            "lastEventCursor",
            "children",
        ]
    );
    assert_eq!(snapshot["children"], serde_json::json!([]));
    // The attach result echoes the client's own capability set (live TS
    // golden: a client that sent none gets the default pair, not the
    // supervisor's worker-facing set).
    assert_eq!(
        data["client"]["capabilities"],
        serde_json::json!(["attach_snapshot", "event_sequence"])
    );
    assert_eq!(data["replay"]["status"], "complete");

    client.send_command(
        "p1",
        &serde_json::json!({ "type": "prompt", "activeSessionId": session_id, "message": "hi" }),
    );
    let (prompt_ack, mut turn_lines) = client.read_response_and_lines("p1");
    assert_eq!(prompt_ack["success"], true, "prompt failed: {prompt_ack}");

    // Any streamed session event may precede the prompt reply (TS order),
    // so the lines buffered during the ack are drained first.
    let mut saw_start = false;
    let mut updates = 0usize;
    let mut final_text = String::new();
    loop {
        let line = client.next_line_of_type(&mut turn_lines, "session_event");
        let event = &line["event"];
        match event["type"].as_str() {
            Some("message_start") => saw_start = true,
            Some("message_update") => updates += 1,
            Some("message_end") => {
                // The scripted engine emits plain-string content.
                final_text = event["message"]["content"]
                    .as_str()
                    .expect("final text")
                    .to_string();
            }
            Some("turn_end") => break,
            _ => {}
        }
    }
    assert!(saw_start, "message_start streamed");
    assert!(updates > 0, "assistant updates streamed ({updates} seen)");
    assert_eq!(final_text, "hello from scripted");

    client.send_command(
        "g1",
        &serde_json::json!({
            "type": "get_last_assistant_text",
            "activeSessionId": session_id,
        }),
    );
    let final_answer = client.read_response("g1");
    assert_eq!(
        final_answer["success"], true,
        "get_last_assistant_text failed: {final_answer}"
    );
    assert_eq!(final_answer["data"]["text"], "hello from scripted");

    client.send_command("l2", &serde_json::json!({ "type": "list" }));
    let list = client.read_response("l2");
    let sessions = list["data"]["sessions"].as_array().expect("sessions");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], session_id.as_str());
    // Session-summary fields match the TS `SessionSummary` wire shape.
    assert_eq!(sessions[0]["runtimeKind"], "top-level");
    assert_eq!(sessions[0]["rlmDepth"], 0);
    assert_eq!(sessions[0]["unfinishedActionCount"], 0);
    assert!(sessions[0]["modified"]
        .as_str()
        .is_some_and(|v| v.ends_with('Z')));
    assert!(sessions[0]["lastActivityAt"]
        .as_str()
        .is_some_and(|v| v.ends_with('Z')));
    // Usage from the scripted turn: input tokens and cost, zero total absent.
    let usage = &sessions[0]["usage"];
    assert!(usage["inputTokens"].as_u64().unwrap_or_default() > 0);
    assert!(usage["outputTokens"].as_u64().unwrap_or_default() > 0);
    assert!(usage["cost"].as_f64().unwrap_or_default() >= 0.0);

    // Saved-session listing: item + progress events, then the final response
    // (differential shape from the TS supervisor's `handleSavedSessionList`).
    client.send_command("e1", &serde_json::json!({ "type": "list_saved_sessions" }));
    let rejected = client.read_response("e1");
    assert_eq!(rejected["success"], false);
    assert_eq!(
        rejected["error"],
        "The \"paths[0]\" property must be of type string, got undefined"
    );
    client.send_command(
        "sl1",
        &serde_json::json!({
            "type": "list_saved_sessions",
            "cwd": dir.path().to_string_lossy(),
            "sessionDir": agent_dir.join("sessions").to_string_lossy(),
            "scope": "all",
        }),
    );
    let mut items = 0usize;
    let mut progress = 0usize;
    let mut rows = Vec::new();
    let saved = loop {
        let line = client.read_line();
        match line["type"].as_str() {
            Some("session_list_item") => {
                items += 1;
                let session = line["session"].clone();
                assert!(session["path"]
                    .as_str()
                    .and_then(|path| Path::new(path).extension())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl")));
                assert!(session["firstMessage"].is_string());
                assert!(session["state"]["status"].is_string());
                rows.push(session);
            }
            Some("session_list_progress") => {
                progress += 1;
                assert!(line["loaded"].as_u64().unwrap_or_default() > 0);
                assert!(
                    line["total"].as_u64().unwrap_or_default()
                        >= line["loaded"].as_u64().unwrap_or_default()
                );
            }
            _ if line["id"] == "sl1" => break line,
            _ => {}
        }
    };
    assert_eq!(
        saved["success"], true,
        "list_saved_sessions failed: {saved}"
    );
    assert_eq!(items, 1, "expected exactly the one created session");
    assert!(progress >= 1);
    let sessions = saved["data"]["sessions"].as_array().expect("sessions");
    assert_eq!(sessions.len(), items);
    assert_eq!(rows[0], sessions[0]);

    // The full client-to-client shape is verified in
    // tests/peer_messaging_e2e.rs; the worker-side delivery in
    // `worker::agent_message_tests`.
    client.send_command(
        "m1",
        &serde_json::json!({
            "type": "send_message",
            "targetActiveSessionId": "no-such-session",
            "message": "anybody there?",
        }),
    );
    let send_missing = client.read_response("m1");
    assert_eq!(
        send_missing["success"], false,
        "send_message should fail: {send_missing}"
    );
    assert_eq!(send_missing["command"], "send_message");
    assert_eq!(
        send_missing["error"],
        "Unknown active session: no-such-session"
    );

    client.send_command(
        "p2",
        &serde_json::json!({
            "type": "prompt_and_wait",
            "activeSessionId": session_id,
            "message": "again",
        }),
    );
    let done = client.read_response("p2");
    assert_eq!(done["success"], true, "prompt_and_wait failed: {done}");
    client.send_command(
        "g2",
        &serde_json::json!({
            "type": "get_last_assistant_text",
            "activeSessionId": session_id,
        }),
    );
    let final_answer = client.read_response("g2");
    assert_eq!(final_answer["data"]["text"], "second turn");
}
