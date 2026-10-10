//! The graceful-shutdown continuation regression: a daemon-wide shutdown
//! aborts a running turn, and the next boot revives the interrupted worker
//! and continues it from the restored queue.
use super::*;

#[test]
fn graceful_shutdown_continues_the_aborted_turn_after_restart() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client, _hello) = Client::connect(&socket);

    let script_busy = dir.path().join("shutdown-busy.json");
    std::fs::write(
        &script_busy,
        json!({ "responses": [
            {
                "text": "busy-turn",
                "toolCalls": [
                    { "toolCallId": "call-1", "toolName": "bash", "args": {}, "result": "listed", "delayMs": 5_000 }
                ]
            },
            { "text": "continued-turn", "delayMs": 10 },
        ] })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        &json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script_busy.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create busy failed: {created}");
    let busy_session = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    let busy_session_file = created["data"]["sessionFile"]
        .as_str()
        .expect("session file")
        .to_string();

    let script_idle = dir.path().join("shutdown-idle.json");
    std::fs::write(
        &script_idle,
        json!({ "responses": [ { "text": "idle-turn", "delayMs": 10 } ] }).to_string(),
    )
    .expect("write script");
    client.send_command(
        "c2",
        &json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script_idle.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c2");
    assert_eq!(created["success"], true, "create idle failed: {created}");
    let idle_session = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    client.send_command(
        "p2",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": idle_session,
            "message": "go",
        }),
    );
    let done = client.read_response("p2");
    assert_eq!(done["success"], true, "idle turn failed: {done}");

    // A user-aborted turn with visible queued input is deliberately parked,
    // not interrupted work that the restart may resume automatically.
    client.send_command(
        "c3",
        &json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script_busy.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c3");
    assert_eq!(created["success"], true, "create paused failed: {created}");
    let paused_session = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    let paused_session_file = created["data"]["sessionFile"]
        .as_str()
        .expect("session file")
        .to_string();
    client.send_command(
        "p3",
        &json!({ "type": "prompt", "activeSessionId": paused_session, "message": "go" }),
    );
    assert_eq!(client.read_response("p3")["success"], true);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let started = std::fs::read_to_string(&paused_session_file)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|entry| entry["message"]["role"].as_str() == Some("assistant"));
        if started {
            break;
        }
        assert!(Instant::now() < deadline, "paused turn never started");
        std::thread::sleep(Duration::from_millis(50));
    }
    client.send_command(
        "q3",
        &json!({ "type": "follow_up", "activeSessionId": paused_session, "message": "remain parked" }),
    );
    assert_eq!(client.read_response("q3")["success"], true);
    client.send_command(
        "a3",
        &json!({ "type": "abort", "activeSessionId": paused_session }),
    );
    assert_eq!(client.read_response("a3")["success"], true);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        client.send_command(
            "w3",
            &json!({ "type": "get_state", "activeSessionId": paused_session }),
        );
        let state = client.read_response("w3");
        assert_eq!(state["success"], true);
        if state["data"]["isStreaming"] == false {
            break;
        }
        assert!(Instant::now() < deadline, "user-aborted turn never settled");
        std::thread::sleep(Duration::from_millis(50));
    }
    client.send_command(
        "g3",
        &json!({ "type": "get_queue", "activeSessionId": paused_session }),
    );
    let queue = client.read_response("g3");
    assert_eq!(queue["data"]["followUp"], json!(["remain parked"]));
    let paused_bytes = std::fs::read(&paused_session_file).expect("paused transcript");

    // A noSession worker may be busy, but its conversation exists only in
    // memory. Retaining its interrupted journal would relaunch an empty
    // session with a generic continuation in place of the original history.
    let script_memory = dir.path().join("shutdown-memory.json");
    std::fs::write(
        &script_memory,
        json!({ "responses": [ { "text": "memory-turn", "delayMs": 30_000 } ] }).to_string(),
    )
    .expect("write in-memory script");
    client.send_command(
        "c4",
        &json!({
            "type": "create",
            "noSession": true,
            "config": { "cwd": dir.path().to_string_lossy(), "script": script_memory.to_string_lossy() },
        }),
    );
    let created = client.read_response("c4");
    assert_eq!(
        created["success"], true,
        "create in-memory failed: {created}"
    );
    assert_eq!(created["data"]["sessionFile"], json!(""));
    let memory_session = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("in-memory session id")
        .to_string();
    client.send_command(
        "p4",
        &json!({ "type": "prompt", "activeSessionId": memory_session, "message": "go" }),
    );
    assert_eq!(client.read_response("p4")["success"], true);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        client.send_command(
            "w4",
            &json!({ "type": "get_state", "activeSessionId": memory_session }),
        );
        let state = client.read_response("w4");
        assert_eq!(state["success"], true);
        if state["data"]["isStreaming"] == true {
            break;
        }
        assert!(Instant::now() < deadline, "in-memory turn never started");
        std::thread::sleep(Duration::from_millis(50));
    }

    client.send_command(
        "p1",
        &json!({
            "type": "prompt",
            "activeSessionId": busy_session,
            "message": "go",
        }),
    );
    let ack = client.read_response("p1");
    assert_eq!(ack["success"], true, "busy prompt failed: {ack}");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let turn_started = std::fs::read_to_string(&busy_session_file)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|entry| entry["message"]["role"].as_str() == Some("assistant"));
        if turn_started {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the busy turn never started: {}",
            std::fs::read_to_string(&busy_session_file).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    // The durable turn's stream was observed above; check the in-memory
    // worker again immediately before the stop so a slow runner cannot turn
    // this into an idle noSession case.
    client.send_command(
        "w4-final",
        &json!({ "type": "get_state", "activeSessionId": memory_session }),
    );
    let memory_state = client.read_response("w4-final");
    assert_eq!(memory_state["success"], true);
    assert_eq!(memory_state["data"]["isStreaming"], true);
    client.send_command("sd", &json!({ "type": "shutdown" }));
    let shutdown = client.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(30);
    while daemon.child.try_wait().expect("try wait").is_none() {
        assert!(Instant::now() < deadline, "supervisor never exited");
        std::thread::sleep(Duration::from_millis(50));
    }

    let restart_before = pa_daemon::util::now_iso();
    let mut daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let registered = distinct(workers_registered_since(&log_path, &restart_before));
        if registered == distinct(vec![busy_session.clone(), paused_session.clone()]) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the interrupted and parked sessions did not re-register ({restart_before}): {registered:?}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let rows = std::fs::read_to_string(&busy_session_file)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .map(|entry| {
                (
                    entry["message"]["role"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                    entry["message"]["stopReason"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                )
            })
            .collect::<Vec<_>>();
        let user_rows: Vec<usize> = rows
            .iter()
            .enumerate()
            .filter(|(_, (role, _))| role == "user")
            .map(|(at, _)| at)
            .collect();
        if user_rows.len() >= 2
            && rows
                .iter()
                .skip(user_rows[1] + 1)
                .any(|(role, stop)| role == "assistant" && stop != "aborted")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the interrupted session never continued: {rows:?}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    let (mut client2, _hello) = Client::connect(&socket);
    client2.send_command("list1", &json!({ "type": "list" }));
    let list = client2.read_response("list1");
    assert_eq!(list["success"], true, "list failed: {list}");
    let listed = list["data"]["sessions"].as_array().expect("sessions");
    let listed_ids: Vec<String> = listed
        .iter()
        .map(|summary| summary["id"].as_str().expect("id").to_string())
        .collect();
    assert_eq!(
        distinct(listed_ids),
        distinct(vec![busy_session, paused_session.clone()]),
        "only the interrupted and parked sessions came back; idle and noSession stay stopped"
    );
    // Read the adopted worker directly: attach/create would hide a missing
    // recovery by starting a new worker over the transcript instead.
    client2.send_command(
        "g3-restart",
        &json!({ "type": "get_queue", "activeSessionId": paused_session }),
    );
    let restored_queue = client2.read_response("g3-restart");
    assert_eq!(
        restored_queue["success"], true,
        "parked queue read failed after restart: {restored_queue}"
    );
    assert_eq!(
        restored_queue["data"], queue["data"],
        "restart must preserve the user-aborted queue without consuming it"
    );
    client2.send_command(
        "w3-restart",
        &json!({ "type": "get_state", "activeSessionId": paused_session }),
    );
    let restored_state = client2.read_response("w3-restart");
    assert_eq!(restored_state["success"], true);
    assert_eq!(
        restored_state["data"]["isStreaming"], false,
        "the adopted parked worker must remain idle"
    );
    let restored_bytes =
        std::fs::read(&paused_session_file).expect("paused transcript after restart");
    assert!(
        restored_bytes.starts_with(&paused_bytes),
        "restart must preserve every preexisting transcript byte"
    );
    // Reopening an adopted worker appends its existing active lifecycle row.
    // Accept exactly that one row, never a queued input or execution result.
    let lifecycle: Value = serde_json::from_slice(&restored_bytes[paused_bytes.len()..])
        .expect("exactly one appended lifecycle row");
    let previous: Value = serde_json::from_str(
        std::str::from_utf8(&paused_bytes)
            .expect("original transcript utf8")
            .lines()
            .last()
            .expect("original last row"),
    )
    .expect("original last row json");
    assert_eq!(lifecycle.as_object().expect("lifecycle object").len(), 5);
    assert_eq!(lifecycle["type"], "session_state");
    assert_eq!(lifecycle["state"], json!({ "status": "active" }));
    assert!(previous["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert_eq!(lifecycle["parentId"], previous["id"]);
    assert!(lifecycle["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(
        std::str::from_utf8(&paused_bytes)
            .expect("original transcript utf8")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("original row json"))
            .all(|entry| entry["id"] != lifecycle["id"]),
        "the lifecycle row must have a fresh entry id"
    );
    assert!(lifecycle["timestamp"]
        .as_str()
        .is_some_and(|timestamp| !timestamp.is_empty()));

    client2.send_command("sd2", &json!({ "type": "shutdown" }));
    let shutdown = client2.read_response("sd2");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(30);
    while daemon2.child.try_wait().expect("try wait").is_none() {
        assert!(
            Instant::now() < deadline,
            "restarted supervisor never exited"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
