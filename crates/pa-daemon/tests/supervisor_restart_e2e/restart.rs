//! The kill9 restart regression: the session re-registers and survives
use super::*;

#[test]
fn supervisor_kill9_restart_sessions_re_register_and_survive() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let supervisor_pid = daemon.child.id();
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // Each session has a slow first turn (streaming while the supervisor
    // dies) and a second turn for the post-restart attach.
    let mut sessions = Vec::new();
    for index in 0..3 {
        let script_path = dir.path().join(format!("script-{index}.json"));
        std::fs::write(
            &script_path,
            json!({ "responses": [
                { "text": format!("turn-1-{index}"), "delayMs": 1200 },
                { "text": format!("turn-2-{index}"), "delayMs": 10 },
            ] })
            .to_string(),
        )
        .expect("write script");
        client.send_command(
            &format!("c{index}"),
            &json!({
                "type": "create",
                "config": {
                    "cwd": dir.path().to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                    "script": script_path.to_string_lossy(),
                },
            }),
        );
        let created = client.read_response(&format!("c{index}"));
        assert_eq!(created["success"], true, "create {index} failed: {created}");
        let session_id = created["data"]["id"]
            .as_str()
            .or_else(|| created["data"]["sessionId"].as_str())
            .expect("session id")
            .to_string();
        client.send_command(
            &format!("a{index}"),
            &json!({ "type": "attach", "activeSessionId": session_id }),
        );
        let attached = client.read_response(&format!("a{index}"));
        assert_eq!(attached["success"], true, "attach {index} failed");
        sessions.push(session_id);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let worker_pids = loop {
        let children = child_pids_of(supervisor_pid);
        if children.len() == 3 {
            break children;
        }
        assert!(Instant::now() < deadline, "three workers never spawned");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(worker_pids.len(), 3, "one worker per session");

    let mut turn_lines: std::collections::VecDeque<Value> = std::collections::VecDeque::new();
    for (index, session_id) in sessions.iter().enumerate() {
        client.send_command(
            &format!("p{index}"),
            &json!({
                "type": "prompt",
                "activeSessionId": session_id,
                "message": "go",
            }),
        );
        let (ack, prompt_lines) = client.read_response_and_lines(&format!("p{index}"));
        assert_eq!(ack["success"], true, "prompt {index} failed: {ack}");
        turn_lines.extend(prompt_lines);
    }
    let mut started_streams = 0;
    while started_streams < 3 {
        let line = client.next_line_of_type(&mut turn_lines, "session_event");
        if line["event"]["type"].as_str() == Some("message_start") {
            started_streams += 1;
        }
    }
    assert_eq!(started_streams, 3, "all three sessions stream");

    // kill -9 the supervisor; sessions must keep running.
    daemon.child.kill().expect("kill -9 supervisor");
    let _ = daemon.child.wait();

    let mut descriptors = Vec::new();
    for session_id in &sessions {
        descriptors.push(load_worker_descriptor(&agent_dir, &socket, session_id));
    }

    // The in-flight turns complete while no supervisor exists (direct
    // worker connections).
    std::thread::sleep(Duration::from_millis(1600));
    for (descriptor, index) in descriptors.iter().zip(0..3) {
        assert!(
            process_alive(descriptor.pid),
            "worker {} survived the supervisor kill",
            descriptor.worker_id
        );
        let (mut worker, hello) = WorkerClient::connect(&descriptor.socket_path);
        assert_eq!(hello["type"], "daemon_hello");
        let auth = worker.request(
            "worker_auth",
            &json!({
                "token": descriptor.token,
                "supervisorGeneration": "sup:direct",
                "supervisorPid": 1,
                "supervisorSocketPath": socket.to_string_lossy(),
            }),
        );
        assert_eq!(auth["success"], true, "direct auth failed: {auth}");
        let answer = worker.request(
            "get_last_assistant_text",
            &json!({ "activeSessionId": descriptor.worker_id }),
        );
        assert_eq!(answer["success"], true, "last text failed: {answer}");
        assert_eq!(
            answer["data"]["text"],
            json!(format!("turn-1-{index}")),
            "in-flight turn completed without a supervisor"
        );
    }

    let restart_before = pa_daemon::util::now_iso();
    let mut daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);

    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    let deadline = Instant::now() + Duration::from_secs(15);
    let registered = loop {
        let registered = distinct(workers_registered_since(&log_path, &restart_before));
        if registered.len() == 3 {
            break registered;
        }
        assert!(
            Instant::now() < deadline,
            "sessions did not re-register after restart ({restart_before}): {registered:?}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(
        registered,
        {
            let mut expected = sessions.clone();
            expected.sort();
            expected
        },
        "the same three identities re-registered"
    );

    let (mut client2, _hello) = Client::connect(&socket);
    client2.send_command("list1", &json!({ "type": "list" }));
    let list = client2.read_response("list1");
    assert_eq!(list["success"], true, "list failed: {list}");
    let listed = list["data"]["sessions"].as_array().expect("sessions");
    assert_eq!(listed.len(), 3, "roster rebuilt from re-registration");
    let listed_ids: Vec<String> = listed
        .iter()
        .map(|summary| summary["id"].as_str().expect("id").to_string())
        .collect();
    let mut expected = sessions.clone();
    expected.sort();
    assert_eq!(distinct(listed_ids), expected);

    let target = &sessions[1];
    client2.send_command(
        "a1",
        &json!({ "type": "attach", "activeSessionId": target }),
    );
    let attached = client2.read_response("a1");
    assert_eq!(
        attached["success"], true,
        "post-restart attach failed: {attached}"
    );
    client2.send_command(
        "p1",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": target,
            "message": "second turn",
        }),
    );
    let (done, mut second_turn_lines) = client2.read_response_and_lines("p1");
    assert_eq!(done["success"], true, "post-restart prompt failed: {done}");
    let answer = loop {
        let line = client2.next_line_of_type(&mut second_turn_lines, "session_event");
        // The user row arrives as its own message_end pair first; the
        // answer is the assistant's final message_end.
        if line["event"]["type"].as_str() == Some("message_end")
            && line["event"]["message"]["role"] == "assistant"
        {
            break line["event"]["message"]["content"]
                .as_str()
                .expect("final text")
                .to_string();
        }
    };
    assert_eq!(answer, "turn-2-1", "scripted turn completed post-restart");

    client2.send_command("sd", &json!({ "type": "shutdown" }));
    let shutdown = client2.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while daemon2.child.try_wait().expect("try wait").is_none() {
        assert!(Instant::now() < deadline, "restarted supervisor exited");
        std::thread::sleep(Duration::from_millis(50));
    }
    for descriptor in &descriptors {
        let deadline = Instant::now() + Duration::from_secs(10);
        while process_alive(descriptor.pid) {
            assert!(
                Instant::now() < deadline,
                "worker {} leaked after shutdown",
                descriptor.worker_id
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
