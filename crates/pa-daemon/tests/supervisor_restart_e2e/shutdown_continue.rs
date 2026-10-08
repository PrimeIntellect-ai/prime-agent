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

    client2.send_command("sd2", &json!({ "type": "shutdown" }));
    let shutdown = client2.read_response("sd2");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(30);
    while daemon2.child.try_wait().expect("try wait").is_none() {
        assert!(Instant::now() < deadline, "restarted supervisor exited");
        std::thread::sleep(Duration::from_millis(50));
    }
}
