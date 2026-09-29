//! The attach surface: the telemetry attach guard and the chunked-snapshot
//! attach stream (begin/chunk/end) against live TS goldens.

use super::*;

/// Telemetry attach guard (TS `assertTelemetryAttachAllowed` parity): a
/// telemetry-disabled client may not attach to a worker running with
/// telemetry enabled, with the TS error text; attaching to a
/// telemetry-disabled worker stays allowed.
#[test]
fn telemetry_disabled_attach_guard_matches_ts_error() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);

    // Session 1: telemetry-enabled (no `telemetryDisabled` on create).
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [{ "text": "ok", "delayMs": 0 }] }).to_string(),
    )
    .expect("write script");
    let session_config = serde_json::json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": agent_dir.join("sessions").to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });
    client.send_command(
        "tc1",
        &serde_json::json!({ "type": "create", "config": session_config }),
    );
    let created = client.read_response("tc1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();

    // Disabled attach to an enabled worker: the exact TS error.
    client.send_command(
        "ta1",
        &serde_json::json!({
            "type": "attach",
            "activeSessionId": session_id,
            "telemetryDisabled": true,
        }),
    );
    let rejected = client.read_response("ta1");
    assert_eq!(
        rejected["success"], false,
        "attach must be refused: {rejected}"
    );
    assert_eq!(
        rejected["error"],
        "Cannot attach to this active agent while telemetry is disabled for the current invocation. Stop the agent and retry so it can restart without telemetry."
    );

    // Enabled attach to the same worker stays fine (guard does not over-block).
    client.send_command(
        "ta2",
        &serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("ta2");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // Session 2: created with telemetry disabled — a disabled attach is
    // allowed against its worker.
    client.send_command(
        "tc2",
        &serde_json::json!({
            "type": "create",
            "config": session_config,
            "telemetryDisabled": true,
        }),
    );
    let created2 = client.read_response("tc2");
    assert_eq!(created2["success"], true, "create 2 failed: {created2}");
    let session_id2 = created2["data"]["id"]
        .as_str()
        .or_else(|| created2["data"]["sessionId"].as_str())
        .expect("session id in create 2 response")
        .to_string();
    client.send_command(
        "ta3",
        &serde_json::json!({
            "type": "attach",
            "activeSessionId": session_id2,
            "telemetryDisabled": true,
        }),
    );
    let attached2 = client.read_response("ta3");
    assert_eq!(
        attached2["success"], true,
        "disabled attach to disabled worker failed: {attached2}"
    );
}

/// Chunked snapshot streaming on the attach path (live TS goldens in
/// `tests/goldens/chunked-attach-live-ts.json`): a `chunked_snapshot`
/// client gets the attach response with the transcript stripped, followed
/// by `session_snapshot_begin` / `session_snapshot_chunk` /
/// `session_snapshot_end` records whose reassembly equals the full
/// snapshot legacy clients receive.
#[test]
fn chunked_snapshot_attach_streams_begin_chunk_end() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("../goldens/chunked-attach-live-ts.json"))
            .expect("golden fixture");

    // A scripted turn whose answer is large enough to split the transcript
    // into several chunks under the 512 KiB budget.
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({
            "responses": [{ "text": "x".repeat(700_000) }]
        })
        .to_string(),
    )
    .expect("write script");
    let (mut client, _hello) = Client::connect(&socket);
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

    // A plain (capability-less) client attaches first so the turn's events
    // stream; its result is also the no-capability echo golden.
    client.send_command(
        "a0",
        &serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let plain_attach = client.read_response("a0");
    assert_eq!(plain_attach["success"], true, "plain attach failed");
    assert_eq!(
        plain_attach["data"]["client"]["capabilities"],
        golden["legacyClient"]["noCapabilityAttachEchoesDefaultCapabilities"]
    );

    client.send_command(
        "p1",
        &serde_json::json!({
            "type": "prompt",
            "activeSessionId": session_id,
            "message": "give me a big answer"
        }),
    );
    let (prompt_ack, mut turn_lines) = client.read_response_and_lines("p1");
    assert_eq!(prompt_ack["success"], true, "prompt failed");
    // The turn_end event may precede the prompt reply (TS order).
    let _ = client.take_session_event(&mut turn_lines, "turn_end");

    // Attach with the chunked_snapshot capability.
    let caps = serde_json::json!([
        "attach_snapshot",
        "event_sequence",
        "slim_attach",
        "chunked_snapshot"
    ]);
    client.send_command(
        "a1",
        &serde_json::json!({
            "type": "attach",
            "activeSessionId": session_id,
            "capabilities": caps,
        }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    let data = attached["data"].clone();
    let golden_data_keys: Vec<&str> = golden["attachResponse"]["dataKeys"]
        .as_array()
        .expect("golden data keys")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    let mut data_keys: Vec<String> = data
        .as_object()
        .expect("attach data object")
        .keys()
        .cloned()
        .collect();
    data_keys.sort();
    let mut sorted_golden: Vec<String> = golden_data_keys
        .iter()
        .map(std::string::ToString::to_string)
        .collect();
    sorted_golden.sort();
    assert_eq!(data_keys, sorted_golden, "attach result key set");
    // The transcript is gone from the streamed result.
    assert_eq!(data["snapshot"]["messages"], serde_json::json!([]));
    assert!(
        data.get("messages").is_none(),
        "slim result has no top-level messages"
    );
    assert_eq!(
        data["client"]["capabilities"], caps,
        "client capabilities echo"
    );
    let target_chunk_bytes = &golden["begin"]["targetChunkBytes"];
    let stream = &data["snapshotStream"];
    assert_eq!(stream["targetChunkBytes"], *target_chunk_bytes);
    assert_eq!(
        stream["messageCount"],
        data["snapshot"]["summary"]["messageCount"]
    );
    let snapshot_id = stream["id"].as_str().expect("snapshot id").to_string();

    // begin / chunk / end records follow the response.
    let mut begin: Option<serde_json::Value> = None;
    let mut chunks: Vec<serde_json::Value> = Vec::new();
    let end = loop {
        let line = client.read_line();
        match line["type"].as_str() {
            Some("session_snapshot_begin") => begin = Some(line),
            Some("session_snapshot_chunk") => chunks.push(line),
            Some("session_snapshot_end") => break line,
            other => panic!("unexpected line during snapshot transfer: {other:?} {line}"),
        }
    };
    let begin = begin.expect("session_snapshot_begin");
    let golden_begin_keys: Vec<String> = golden["begin"]["keys"]
        .as_array()
        .expect("golden begin keys")
        .iter()
        .map(|v| v.as_str().expect("key").to_string())
        .collect();
    let mut begin_keys: Vec<String> = begin
        .as_object()
        .expect("begin object")
        .keys()
        .cloned()
        .collect();
    begin_keys.sort();
    let mut sorted_begin_golden = golden_begin_keys;
    sorted_begin_golden.sort();
    assert_eq!(begin_keys, sorted_begin_golden, "begin key set");
    assert_eq!(begin["purpose"], "attach");
    assert_eq!(begin["purpose"], golden["begin"]["purpose"]);
    assert_eq!(begin["messageCount"], stream["messageCount"]);
    assert_eq!(begin["targetChunkBytes"], *target_chunk_bytes);
    assert_eq!(
        begin["snapshot"], data["snapshot"],
        "begin carries the header"
    );
    assert_eq!(begin["activeSessionId"], serde_json::json!(session_id));

    // Snapshot id: <activeSessionId>-<generation>-<sequence> from the event
    // cursor, shared by the response descriptor and every record.
    let cursor = &end["lastEventCursor"];
    assert_eq!(
        snapshot_id,
        format!(
            "{}-{}-{}",
            session_id,
            cursor["generation"].as_str().expect("generation"),
            end["lastEventSequence"].as_u64().expect("sequence")
        )
    );
    for record in [&begin, &end].into_iter().chain(chunks.iter()) {
        assert_eq!(record["snapshotId"], serde_json::json!(snapshot_id));
    }

    // Chunks: sequential indices, each record within the byte budget
    // (a single oversized message travels alone).
    let golden_chunk_keys: Vec<String> = golden["chunk"]["keys"]
        .as_array()
        .expect("golden chunk keys")
        .iter()
        .map(|v| v.as_str().expect("key").to_string())
        .collect();
    let budget = target_chunk_bytes.as_u64().expect("budget") as usize;
    assert!(
        chunks.len() >= 2,
        "the 700 KB transcript must split, got {} chunks",
        chunks.len()
    );
    for (index, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk["index"], serde_json::json!(index), "index order");
        assert_eq!(chunk["activeSessionId"], serde_json::json!(session_id));
        let mut chunk_keys: Vec<String> = chunk
            .as_object()
            .expect("chunk object")
            .keys()
            .cloned()
            .collect();
        chunk_keys.sort();
        let mut sorted_chunk_golden = golden_chunk_keys.clone();
        sorted_chunk_golden.sort();
        assert_eq!(chunk_keys, sorted_chunk_golden, "chunk key set");
        let serialized = serde_json::to_string(chunk).expect("serialize chunk");
        assert!(
            serialized.len() <= budget
                || chunk["messages"].as_array().is_some_and(|m| m.len() == 1),
            "chunk {index} over budget at {} bytes",
            serialized.len()
        );
    }

    // End record closes the transfer with the counts and cursor.
    let golden_end_keys: Vec<String> = golden["end"]["keys"]
        .as_array()
        .expect("golden end keys")
        .iter()
        .map(|v| v.as_str().expect("key").to_string())
        .collect();
    let mut end_keys: Vec<String> = end
        .as_object()
        .expect("end object")
        .keys()
        .cloned()
        .collect();
    end_keys.sort();
    let mut sorted_end_golden = golden_end_keys;
    sorted_end_golden.sort();
    assert_eq!(end_keys, sorted_end_golden, "end key set");
    assert_eq!(end["chunkCount"], serde_json::json!(chunks.len()));
    assert_eq!(end["lastEventSequence"], data["lastEventSequence"]);
    assert_eq!(end["lastEventCursor"], data["lastEventCursor"]);

    // A legacy client still gets the full snapshot inside the response,
    // and the reassembled chunk transcript equals it exactly.
    let (mut legacy, _hello) = Client::connect(&socket);
    legacy.send_command(
        "a2",
        &serde_json::json!({
            "type": "attach",
            "activeSessionId": session_id,
            "capabilities": ["attach_snapshot", "event_sequence", "slim_attach"],
        }),
    );
    let legacy_attach = legacy.read_response("a2");
    assert_eq!(
        legacy_attach["success"], true,
        "legacy attach failed: {legacy_attach}"
    );
    let legacy_data = &legacy_attach["data"];
    assert!(
        legacy_data.get("snapshotStream").is_none(),
        "no stream for legacy clients"
    );
    assert!(
        legacy_data["snapshot"]["messages"]
            .as_array()
            .is_some_and(|m| !m.is_empty()),
        "legacy snapshot carries the transcript"
    );
    let mut reassembled: Vec<serde_json::Value> = Vec::new();
    for chunk in &chunks {
        reassembled.extend(
            chunk["messages"]
                .as_array()
                .expect("chunk messages")
                .iter()
                .cloned(),
        );
    }
    assert_eq!(
        serde_json::json!(reassembled),
        legacy_data["snapshot"]["messages"],
        "reassembled chunk transcript equals the full snapshot"
    );
    assert_eq!(
        legacy_data["client"]["capabilities"],
        serde_json::json!(["attach_snapshot", "event_sequence", "slim_attach"])
    );
}
