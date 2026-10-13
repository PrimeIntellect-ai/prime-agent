//! Compaction on the daemon surface: `compact`/`abort_compaction`/
//! `set_auto_compaction` over the scripted engine, against live TS goldens.

use super::*;

// Response and event shapes captured read-only from the live TS daemon
// (`tests/goldens/compaction-live-ts.json`).
#[test]
fn compaction_commands_scripted_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("../goldens/compaction-live-ts.json"))
            .expect("golden fixture");
    let (mut client, _hello) = Client::connect(&socket);

    // The compaction script: (1) an abortable in-flight success, (2) the
    // TS nothing-to-compact skip, then (3) replay from the top.
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({
            "responses": [{ "text": "one turn" }],
            "compaction": { "responses": [
                {
                    "summary": "first summary",
                    "firstKeptEntryId": "",
                    "tokensBefore": 4321,
                    "details": { "readFiles": ["a.rs"], "modifiedFiles": [] },
                    "delayMs": 1500,
                },
                {
                    "summary": "second summary",
                    "firstKeptEntryId": "",
                    "tokensBefore": 5000,
                    "details": { "readFiles": ["a.rs"], "modifiedFiles": [] },
                },
                { "error": "Session is too short to compact — try again once it grows", "skipped": true },
            ] },
        })
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
        .expect("session id")
        .to_string();

    client.send_command(
        "a1",
        &serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    // The attach snapshot's connection state defaults to auto-compaction on,
    // like the TS settings default.
    assert_eq!(
        attached["data"]["snapshot"]["state"]["autoCompactionEnabled"],
        serde_json::json!(true)
    );

    client.send_command(
        "p1",
        &serde_json::json!({ "type": "prompt", "activeSessionId": session_id, "message": "hi" }),
    );
    let (prompt_ack, mut turn_lines) = client.read_response_and_lines("p1");
    assert_eq!(prompt_ack["success"], true, "prompt failed");
    // The turn_end event may precede the prompt reply (TS order).
    let _ = client.take_session_event(&mut turn_lines, "turn_end");

    client.send_command(
        "cp-missing",
        &serde_json::json!({ "type": "compact", "activeSessionId": "no-such-session" }),
    );
    let missing = client.read_response("cp-missing");
    assert_eq!(missing["success"], false);
    assert_eq!(missing["error"], golden["compact"]["unknownSessionError"]);

    client.send_command(
        "cp1",
        &serde_json::json!({
            "type": "compact",
            "activeSessionId": session_id,
            "customInstructions": "focus on the goal",
        }),
    );
    let start = loop {
        let line = client.read_line();
        if line["type"] == "session_event"
            && line["event"]["type"].as_str() == Some("compaction_start")
        {
            break line["event"].clone();
        }
    };
    assert_eq!(
        start,
        serde_json::json!({
            "type": "compaction_start",
            "reason": "manual",
            "customInstructions": "focus on the goal",
        })
    );

    let (mut second, _hello) = Client::connect(&socket);
    second.send_command(
        "a2",
        &serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let second_attach = second.read_response("a2");
    assert_eq!(
        second_attach["success"], true,
        "second attach: {second_attach}"
    );
    second.send_command(
        "st1",
        &serde_json::json!({ "type": "get_state", "activeSessionId": session_id }),
    );
    let state = second.read_response("st1");
    assert_eq!(state["success"], true, "get_state failed: {state}");
    assert_eq!(state["data"]["isCompacting"], serde_json::json!(true));
    assert_eq!(state["data"]["activity"], serde_json::json!("working"));
    assert_eq!(state["data"]["isSessionActive"], serde_json::json!(true));
    assert_eq!(state["data"]["isStreaming"], serde_json::json!(false));

    second.send_command(
        "ab1",
        &serde_json::json!({
            "type": "abort_compaction",
            "activeSessionId": session_id,
        }),
    );
    let aborted = second.read_response("ab1");
    assert_eq!(aborted["success"], true, "abort failed: {aborted}");
    assert_eq!(aborted["command"], "abort_compaction");
    assert!(aborted.get("data").is_none(), "abort carries no data");
    let (compact_aborted, mut cp1_lines) = client.read_response_and_lines("cp1");
    assert_eq!(
        compact_aborted["success"], false,
        "aborted compact: {compact_aborted}"
    );
    assert_eq!(compact_aborted["error"], golden["compact"]["abortedError"]);
    let end_aborted = client.take_session_event(&mut cp1_lines, "compaction_end");
    // The golden's aborted capture ran without instructions; the TS catch path
    // echoes the run's `customInstructions`, so expect the golden plus the field
    // this run carried.
    let mut end_aborted_expected = golden["compactionEndAborted"].clone();
    end_aborted_expected["customInstructions"] = serde_json::json!("focus on the goal");
    assert_eq!(
        end_aborted, end_aborted_expected,
        "aborted compaction_end shape"
    );

    client.send_command(
        "cp2",
        &serde_json::json!({
            "type": "compact",
            "activeSessionId": session_id,
            "customInstructions": "focus on the goal",
        }),
    );
    let (compacted, mut cp2_lines) = client.read_response_and_lines("cp2");
    assert_eq!(compacted["success"], true, "compact failed: {compacted}");
    assert_eq!(compacted["command"], "compact");
    let data = &compacted["data"];
    // A key-set check: `serde_json` objects are BTreeMap-backed (sorted),
    // while the golden preserves the TS wire's insertion order.
    let mut data_keys: Vec<&str> = data
        .as_object()
        .expect("compact data object")
        .keys()
        .map(String::as_str)
        .collect();
    data_keys.sort_unstable();
    let mut golden_keys: Vec<&str> = golden["compact"]["successResponse"]["dataKeys"]
        .as_array()
        .expect("golden data keys")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    golden_keys.sort_unstable();
    assert_eq!(data_keys, golden_keys, "CompactionResult key set");
    assert_eq!(data["summary"], serde_json::json!("second summary"));
    assert_eq!(data["tokensBefore"], serde_json::json!(5000));
    assert_eq!(
        data["details"],
        serde_json::json!({ "readFiles": ["a.rs"], "modifiedFiles": [] })
    );
    assert!(
        data.get("usage").is_none(),
        "usage never rides the compact response (TS parity)"
    );
    let start = client.take_session_event(&mut cp2_lines, "compaction_start");
    assert_eq!(start["type"], serde_json::json!("compaction_start"));

    let end_success = client.take_session_event(&mut cp2_lines, "compaction_end");
    let golden_end = &golden["compactionEndSuccess"];
    assert_eq!(end_success["type"], golden_end["type"]);
    assert_eq!(end_success["reason"], golden_end["reason"]);
    assert_eq!(end_success["result"], *data, "end result equals response");
    assert_eq!(end_success["aborted"], serde_json::json!(false));
    assert_eq!(end_success["willRetry"], serde_json::json!(false));
    assert_eq!(
        end_success["customInstructions"],
        serde_json::json!("focus on the goal")
    );
    assert!(end_success.get("errorMessage").is_none());

    // The compacted read: `compactionSummary` first (the scripted empty
    // cut keeps the whole transcript).
    client.send_command(
        "gm1",
        &serde_json::json!({ "type": "get_messages", "activeSessionId": session_id }),
    );
    let messages = client.read_response("gm1");
    assert_eq!(messages["success"], true, "get_messages failed: {messages}");
    let messages = messages["data"]["messages"].as_array().expect("messages");
    assert_eq!(messages[0]["role"], serde_json::json!("compactionSummary"));
    assert_eq!(messages[0]["summary"], serde_json::json!("second summary"));
    assert_eq!(messages[0]["tokensBefore"], serde_json::json!(5000));
    assert!(
        messages[0]["retainedMessageCount"]
            .as_u64()
            .unwrap_or_default()
            > 0,
        "the empty scripted cut retains the transcript"
    );

    let (mut third, _hello) = Client::connect(&socket);
    third.send_command(
        "a3",
        &serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let reattached = third.read_response("a3");
    assert_eq!(reattached["success"], true, "reattach failed: {reattached}");
    let snapshot_messages = reattached["data"]["snapshot"]["messages"]
        .as_array()
        .expect("snapshot messages");
    assert_eq!(
        snapshot_messages[0]["role"],
        serde_json::json!("compactionSummary")
    );
    assert_eq!(
        reattached["data"]["snapshot"]["state"]["compactionCount"],
        serde_json::json!(1)
    );

    client.send_command(
        "cp3",
        &serde_json::json!({ "type": "compact", "activeSessionId": session_id }),
    );
    let (skipped, mut cp3_lines) = client.read_response_and_lines("cp3");
    assert_eq!(skipped["success"], false, "skip must fail: {skipped}");
    assert_eq!(skipped["error"], golden["compact"]["skippedError"]);
    let end_skipped = client.take_session_event(&mut cp3_lines, "compaction_end");
    let golden_skipped = &golden["compactionEndSkipped"];
    assert_eq!(end_skipped["type"], golden_skipped["type"]);
    assert_eq!(end_skipped["reason"], golden_skipped["reason"]);
    assert_eq!(end_skipped["aborted"], golden_skipped["aborted"]);
    assert_eq!(end_skipped["willRetry"], golden_skipped["willRetry"]);
    assert_eq!(end_skipped["errorMessage"], golden_skipped["errorMessage"]);
    assert_eq!(
        end_skipped["errorSeverity"],
        golden_skipped["errorSeverity"]
    );
    assert!(
        end_skipped.get("result").is_none(),
        "skip carries no result"
    );

    client.send_command(
        "sac1",
        &serde_json::json!({
            "type": "set_auto_compaction",
            "activeSessionId": session_id,
            "enabled": false,
        }),
    );
    let disabled = client.read_response("sac1");
    assert_eq!(
        disabled,
        serde_json::json!({
            "id": "sac1",
            "type": "response",
            "command": "set_auto_compaction",
            "success": true,
        })
    );
    client.send_command(
        "a4",
        &serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let reattached = client.read_response("a4");
    assert_eq!(
        reattached["data"]["snapshot"]["state"]["autoCompactionEnabled"],
        serde_json::json!(false),
        "set_auto_compaction updates the connection state"
    );
    client.send_command(
        "sac2",
        &serde_json::json!({
            "type": "set_auto_compaction",
            "activeSessionId": session_id,
            "enabled": true,
        }),
    );
    let enabled = client.read_response("sac2");
    assert_eq!(enabled["success"], true, "re-enable failed: {enabled}");

    // abort_compaction with nothing running still succeeds (TS parity).
    client.send_command(
        "ab2",
        &serde_json::json!({
            "type": "abort_compaction",
            "activeSessionId": session_id,
        }),
    );
    let idle_abort = client.read_response("ab2");
    assert_eq!(
        idle_abort["success"], true,
        "idle abort failed: {idle_abort}"
    );
}
