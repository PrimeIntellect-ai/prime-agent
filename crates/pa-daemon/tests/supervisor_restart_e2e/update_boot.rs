//! The update-boot revival regression: only roster-kept workers revive
use super::*;

/// An update boot relaunches the dead workers its roster keeps, plus any
/// with durable busy evidence; an unkept idle descriptor must never revive
/// (the parked session may have a newer worker from a client reopen).
#[test]
fn update_boot_revives_only_roster_kept_workers() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client, _hello) = Client::connect(&socket);

    // Both sessions settle to `busy: false` (`turn_end`), so neither
    // carries busy evidence — only the roster's kept set can distinguish them.
    let mut sessions = Vec::new();
    for index in 0..2 {
        let script_path = dir.path().join(format!("update-{index}.json"));
        std::fs::write(
            &script_path,
            json!({ "responses": [
                { "text": format!("turn-{index}"), "delayMs": 10 },
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
            &format!("p{index}"),
            &json!({
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": "go",
            }),
        );
        let done = client.read_response(&format!("p{index}"));
        assert_eq!(done["success"], true, "turn {index} failed: {done}");
        sessions.push(session_id);
    }

    // Kill the workers by the supervisor's live children, not the
    // descriptor pids: a mid-test replacement can leave the descriptor
    // stale, and a stale-pid kill would leave the real worker running.
    let supervisor_pid = daemon.child.id();
    let worker_pids = child_pids_of(supervisor_pid);
    assert_eq!(
        worker_pids.len(),
        2,
        "two session workers under the supervisor"
    );
    daemon.child.kill().expect("kill -9 supervisor");
    let _ = daemon.child.wait();
    for pid in &worker_pids {
        std::process::Command::new("kill")
            .arg("-9")
            .arg(pid.to_string())
            .status()
            .expect("kill -9 worker");
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    for pid in &worker_pids {
        while process_alive(*pid) {
            assert!(Instant::now() < deadline, "worker {pid} never died");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    // The roster keeps only the first session's worker; no session rows
    // (the adoption pass's filter is under test).
    let roster_path = dir.path().join("update-roster.json");
    std::fs::write(
        &roster_path,
        json!({
            "format_version": 1,
            "update_id": "u-e2e-1",
            "socket_path": socket.to_string_lossy(),
            "created_at": "2026-01-01T00:00:00Z",
            "supervisor": { "pid": 1, "process_start_id": "p", "generation": "g" },
            "binary": { "from_version": "0.1", "to_version": "0.2" },
            "sessions": [],
            "workers": [{
                "worker_id": sessions[0],
                "sessions": [sessions[0]],
                "launch_env": {},
            }],
        })
        .to_string(),
    )
    .expect("write roster");

    let restart_before = pa_daemon::util::now_iso();
    let mut daemon2 = spawn_supervisor_env(
        &socket,
        &agent_dir,
        &[(
            pa_types::daemon::update_flow::UPDATE_ROSTER_ENV,
            roster_path.to_string_lossy().to_string(),
        )],
    );
    wait_socket_ready(&socket);
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);

    let deadline = Instant::now() + Duration::from_secs(15);
    let registered = loop {
        let registered = distinct(workers_registered_since(&log_path, &restart_before));
        if registered == vec![sessions[0].clone()] {
            break registered;
        }
        assert!(
            Instant::now() < deadline,
            "kept worker did not re-register ({restart_before}): {registered:?}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(registered, vec![sessions[0].clone()]);

    let skip_line = format!(
        "session worker {} was idle at exit; not revived",
        sessions[1]
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains(&skip_line)
    {
        assert!(
            Instant::now() < deadline,
            "unkept worker never skipped: {skip_line}"
        );
        std::thread::sleep(Duration::from_millis(50));
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
        vec![sessions[0].clone()],
        "only the roster-kept session came back"
    );

    let relaunched = load_worker_descriptor(&agent_dir, &socket, &sessions[0]);
    client2.send_command("sd", &json!({ "type": "shutdown" }));
    let shutdown = client2.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while daemon2.child.try_wait().expect("try wait").is_none() {
        assert!(Instant::now() < deadline, "restarted supervisor exited");
        std::thread::sleep(Duration::from_millis(50));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(relaunched.pid) {
        assert!(
            Instant::now() < deadline,
            "relaunched worker leaked after shutdown"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
