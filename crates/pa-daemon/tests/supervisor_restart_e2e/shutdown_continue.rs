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
                    { "toolCallId": "call-1", "toolName": "bash", "args": {}, "result": "listed", "delayMs": 5_000 },
                    { "toolCallId": "call-2", "toolName": "bash", "args": {}, "result": "unfinished" }
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
        "observe-busy",
        &json!({ "type": "attach", "activeSessionId": busy_session }),
    );
    let attached = client.read_response("observe-busy");
    assert_eq!(attached["success"], true, "attach busy failed: {attached}");
    client.send_command(
        "p1",
        &json!({
            "type": "prompt",
            "activeSessionId": busy_session,
            "message": "go",
        }),
    );
    let (ack, mut busy_lines) = client.read_response_and_lines("p1");
    assert_eq!(ack["success"], true, "busy prompt failed: {ack}");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let line = client.next_line_of_type(&mut busy_lines, "session_event");
        if line["activeSessionId"] == busy_session
            && line["event"]["type"] == "tool_execution_start"
            && line["event"]["toolCallId"] == "call-1"
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the first busy tool never reached its actual execution-start event"
        );
    }
    // The first scripted tool's delay is intentionally not abortable. Its
    // terminal tool frames can still settle after shutdown requests an abort.
    // A second tool remains unfinished: its start is rejected by the abort
    // gate, so the engine reports cancellation instead of Done(Ok).

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

    let finished_tools: Vec<String> = std::fs::read_to_string(&busy_session_file)
        .expect("interrupted transcript")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("transcript row"))
        .filter(|entry| entry["message"]["role"] == "toolResult")
        .map(|entry| {
            entry["message"]["toolCallId"]
                .as_str()
                .expect("tool result id")
                .to_string()
        })
        .collect();
    assert_eq!(
        finished_tools,
        vec!["call-1".to_string()],
        "shutdown must leave the second declared tool unfinished before restart"
    );

    let restart_before = pa_daemon::util::now_iso();
    let mut daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let registered = distinct(workers_registered_since(&log_path, &restart_before));
        if registered == vec![busy_session.clone()] {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the interrupted session did not re-register ({restart_before}): {registered:?}; log: {}",
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
        vec![busy_session],
        "only the interrupted session came back"
    );
    assert_eq!(
        std::fs::read(&paused_session_file).expect("paused transcript after restart"),
        paused_bytes,
        "a user-aborted session must not execute its parked queue after restart"
    );

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

/// A user-parked queue must stay parked through a revival. Losing both
/// processes without a verdict write (kill -9) leaves the journal's
/// abort-settle row proving the parked lanes, so the next boot revives the
/// session — and the restored queue must keep its suspension instead of
/// auto-running the parked prompt without the user's consent.
#[test]
fn a_revived_user_parked_queue_stays_parked() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client, _hello) = Client::connect(&socket);

    let script = dir.path().join("parked-revival.json");
    std::fs::write(
        &script,
        json!({ "responses": [
            {
                "text": "busy-turn",
                "toolCalls": [
                    { "toolCallId": "call-1", "toolName": "bash", "args": {}, "result": "listed", "delayMs": 5_000 }
                ]
            },
            { "text": "resumed-turn", "delayMs": 10 },
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
                "script": script.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let parked_session = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    let parked_session_file = created["data"]["sessionFile"]
        .as_str()
        .expect("session file")
        .to_string();
    client.send_command(
        "p1",
        &json!({ "type": "prompt", "activeSessionId": parked_session, "message": "go" }),
    );
    assert_eq!(client.read_response("p1")["success"], true);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let started = std::fs::read_to_string(&parked_session_file)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|entry| entry["message"]["role"].as_str() == Some("assistant"));
        if started {
            break;
        }
        assert!(Instant::now() < deadline, "the parked turn never started");
        std::thread::sleep(Duration::from_millis(50));
    }
    // The user abort parks the visible follow-up until an explicit resume.
    client.send_command(
        "q1",
        &json!({ "type": "follow_up", "activeSessionId": parked_session, "message": "remain parked" }),
    );
    assert_eq!(client.read_response("q1")["success"], true);
    client.send_command(
        "a1",
        &json!({ "type": "abort", "activeSessionId": parked_session }),
    );
    assert_eq!(client.read_response("a1")["success"], true);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        client.send_command(
            "w1",
            &json!({ "type": "get_state", "activeSessionId": parked_session }),
        );
        let state = client.read_response("w1");
        assert_eq!(state["success"], true);
        if state["data"]["isStreaming"] == false {
            break;
        }
        assert!(Instant::now() < deadline, "the aborted turn never settled");
        std::thread::sleep(Duration::from_millis(50));
    }
    client.send_command(
        "g1",
        &json!({ "type": "get_queue", "activeSessionId": parked_session }),
    );
    let queue = client.read_response("g1");
    assert_eq!(queue["data"]["followUp"], json!(["remain parked"]));
    let parked_bytes = std::fs::read(&parked_session_file).expect("parked transcript");

    // The parked session's worker pid rides its descriptor
    // (`<agent-dir>/daemon-workers/<shard>/<worker>.json`).
    let worker_pid = {
        let descriptor_dir = agent_dir.join("daemon-workers");
        let mut pid = None;
        'scan: for shard in std::fs::read_dir(&descriptor_dir).expect("descriptor dir") {
            let shard = shard.expect("descriptor shard").path();
            if !shard.is_dir() {
                continue;
            }
            for entry in std::fs::read_dir(&shard).expect("descriptor shard dir") {
                let path = entry.expect("descriptor entry").path();
                if path.extension().is_none_or(|ext| ext != "json") {
                    continue;
                }
                let Ok(descriptor) = serde_json::from_str::<Value>(
                    &std::fs::read_to_string(&path).unwrap_or_default(),
                ) else {
                    continue;
                };
                if descriptor["rootActiveSessionId"].as_str() == Some(parked_session.as_str()) {
                    pid = Some(descriptor["pid"].as_u64().expect("worker pid"));
                    break 'scan;
                }
            }
        }
        pid.expect("the parked session's worker descriptor")
    };

    // kill -9 the supervisor FIRST (a live supervisor would observe the
    // worker's death and settle the journal), then the worker (its SIGKILL
    // writes no verdict): the journal keeps the abort-settle row.
    daemon.child.kill().expect("kill supervisor");
    daemon.child.wait().expect("reap supervisor");
    std::process::Command::new("kill")
        .arg("-9")
        .arg(worker_pid.to_string())
        .status()
        .expect("kill the parked worker");

    let restart_before = pa_daemon::util::now_iso();
    let mut daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let registered = distinct(workers_registered_since(&log_path, &restart_before));
        if registered == vec![parked_session.clone()] {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the parked session was not revived: {registered:?}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    let (mut client2, _hello) = Client::connect(&socket);
    client2.send_command(
        "g2",
        &json!({ "type": "get_queue", "activeSessionId": parked_session }),
    );
    let queue = client2.read_response("g2");
    assert_eq!(queue["success"], true, "queue read failed: {queue}");
    assert_eq!(
        queue["data"]["followUp"],
        json!(["remain parked"]),
        "the revival restored the parked queue"
    );
    client2.send_command(
        "w2",
        &json!({ "type": "get_state", "activeSessionId": parked_session }),
    );
    let state = client2.read_response("w2");
    assert_eq!(state["success"], true);
    assert_eq!(
        state["data"]["isStreaming"], false,
        "a revived parked queue must not auto-run"
    );
    // The create replay may append its own bookkeeping rows (a session_state
    // marker); the conversation itself must be untouched until a resume.
    let message_rows = |bytes: &[u8]| -> Vec<Value> {
        String::from_utf8_lossy(bytes)
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|entry| entry["type"] == "message")
            .collect()
    };
    assert_eq!(
        message_rows(&std::fs::read(&parked_session_file).expect("parked transcript")),
        message_rows(&parked_bytes),
        "the revived worker executed the parked input without a resume"
    );

    // The suspension is the only thing holding the queue: an explicit
    // resume must run the parked item.
    client2.send_command(
        "r2",
        &json!({ "type": "resume_queue", "activeSessionId": parked_session }),
    );
    assert_eq!(client2.read_response("r2")["success"], true);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let resumed = std::fs::read_to_string(&parked_session_file)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|entry| {
                entry["message"]["role"].as_str() == Some("user")
                    && entry["message"]["content"].as_str() == Some("remain parked")
            });
        if resumed {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the resumed parked item never ran: {}",
            std::fs::read_to_string(&parked_session_file).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    client2.send_command("sd", &json!({ "type": "shutdown" }));
    let shutdown = client2.read_response("sd");
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

/// A daemon-wide shutdown whose verdict write is lost with the supervisor
/// must never archive the session: the shutdown persists the RESUMABLE stop
/// tombstone, so the boot finishes the stop without the kill variant's
/// archive cascade — the session stays on disk, unarchived and reopenable.
#[test]
fn a_lost_shutdown_verdict_never_archives_the_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client, _hello) = Client::connect(&socket);

    let script_busy = dir.path().join("lost-verdict.json");
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
    assert_eq!(created["success"], true, "create failed: {created}");
    let session = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    let session_file = created["data"]["sessionFile"]
        .as_str()
        .expect("session file")
        .to_string();
    client.send_command(
        "p1",
        &json!({ "type": "prompt", "activeSessionId": session, "message": "go" }),
    );
    assert_eq!(client.read_response("p1")["success"], true, "prompt failed");
    // Mid-turn is durable evidence, never stream pacing: the journal's
    // admission `busy: true` record proves the turn the shutdown will
    // interrupt, whatever the runner's pacing does to the stream.
    wait_for_busy_journal_evidence(&agent_dir, &socket, &session);

    // SIGSTOP freezes the worker's command pump: the routed shutdown is
    // never answered and no verdict is written.
    let worker_pids = child_pids_of(daemon.child.id());
    assert_eq!(
        worker_pids.len(),
        1,
        "one session worker under the supervisor"
    );
    let stopped = std::process::Command::new("kill")
        .arg("-STOP")
        .arg(worker_pids[0].to_string())
        .status()
        .expect("SIGSTOP the worker");
    assert!(stopped.success(), "SIGSTOP must reach the worker");

    // The daemon-wide shutdown: its reply precedes the stop pass, which
    // persists the stop tombstone before routing the shutdown into the
    // frozen pump.
    client.send_command("sd", &json!({ "type": "shutdown" }));
    let shutdown = client.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let descriptor_path =
        pa_daemon::descriptor::descriptor_dir(&agent_dir, &socket).join(format!("{session}.json"));
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let tombstoned = std::fs::read_to_string(&descriptor_path)
            .ok()
            .and_then(|content| serde_json::from_str::<Value>(&content).ok())
            .is_some_and(|descriptor| descriptor["stopRequestedAt"].is_string());
        if tombstoned {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the shutdown never persisted its stop tombstone; log: {}",
            std::fs::read_to_string(pa_daemon::paths::daemon_log_path(&socket, &agent_dir))
                .unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    // The stop pass is now waiting out the frozen worker's 30s route
    // window; kill -9 the supervisor inside it (an installer/launchd stop
    // timeout), then the worker — its SIGKILL writes no verdict.
    daemon.child.kill().expect("kill supervisor");
    daemon.child.wait().expect("reap supervisor");
    drop(client);
    std::process::Command::new("kill")
        .arg("-9")
        .arg(worker_pids[0].to_string())
        .status()
        .expect("kill the frozen worker");

    // The next boot adopts the stop tombstone and finishes the stop: the
    // descriptor's removal is the adoption's observable end.
    let mut daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if !descriptor_path.exists() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the tombstoned stop never finished; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    // THE REGRESSION: the lost verdict must not archive the session.
    assert_ne!(
        session_state(Path::new(&session_file)),
        "archived",
        "a lost shutdown verdict archived the session; log: {}",
        std::fs::read_to_string(&log_path).unwrap_or_default()
    );

    // The kept session is resumable: a client can reopen it.
    let (mut client2, _hello) = Client::connect(&socket);
    client2.send_command(
        "c2",
        &json!({
            "type": "create",
            "sessionPath": session_file,
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script_busy.to_string_lossy(),
            },
        }),
    );
    let reopened = client2.read_response("c2");
    assert_eq!(
        reopened["success"], true,
        "the kept session must reopen: {reopened}"
    );

    client2.send_command("sd2", &json!({ "type": "shutdown" }));
    assert_eq!(
        client2.read_response("sd2")["success"],
        true,
        "shutdown failed"
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    while daemon2.child.try_wait().expect("try wait").is_none() {
        assert!(
            Instant::now() < deadline,
            "restarted supervisor never exited"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
