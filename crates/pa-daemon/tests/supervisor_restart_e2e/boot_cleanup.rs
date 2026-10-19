use super::*;

use std::os::unix::fs::PermissionsExt;

#[test]
fn boot_cleanup_preserves_unverifiable_journals_and_waiting_callers_status() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let socket = dir.path().join("daemon.sock");
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(&agent_dir, &socket);
    std::fs::create_dir_all(&descriptor_dir).expect("descriptors");
    let mut preserved = Vec::new();
    for worker_id in ["unowned", "malformed", "unsupported", "unreadable", "owned"] {
        let journal = descriptor_dir.join(format!("{worker_id}.recovery.jsonl"));
        let bytes = json!({
            "activeSessionId": worker_id,
            "sessionId": worker_id,
            "busy": false,
            "operation": "turn_end",
            "recordedAt": "2026-10-07T00:00:00Z",
            "retainedQueue": ["work that must survive cleanup"],
        })
        .to_string()
        .into_bytes();
        std::fs::write(&journal, &bytes).expect("journal fixture");
        let descriptor_path = descriptor_dir.join(format!("{worker_id}.json"));
        match worker_id {
            "unowned" => {}
            "malformed" => {
                std::fs::write(&descriptor_path, "not json").expect("malformed descriptor");
            }
            "unsupported" | "unreadable" | "owned" => {
                let descriptor = json!({
                    "version": if worker_id == "unsupported" { 3 } else { 2 },
                    "workerId": worker_id,
                    "pid": std::process::id(),
                    "socketPath": dir.path().join(format!("{worker_id}.sock")),
                    "recoveryJournalPath": journal,
                    "supervisorSocketPath": socket,
                    "authenticationToken": "isolated-fixture-token",
                    "rootActiveSessionId": worker_id,
                    "createdAt": "2026-10-07T00:00:00Z",
                    "updatedAt": "2026-10-07T00:00:00Z",
                    "lifecycle": "ready",
                    "createCommand": {},
                    "consecutiveFailures": 0,
                });
                std::fs::write(&descriptor_path, descriptor.to_string())
                    .expect("descriptor fixture");
                if worker_id == "unreadable" {
                    std::fs::set_permissions(
                        &descriptor_path,
                        std::fs::Permissions::from_mode(0o0),
                    )
                    .expect("unreadable descriptor");
                }
            }
            _ => unreachable!("fixture worker id"),
        }
        preserved.push((journal, bytes));
    }

    let status_dir = agent_dir.join("update-restarts");
    std::fs::create_dir_all(&status_dir).expect("status dir");
    let mut exited_coordinator = Command::new("true")
        .current_dir(dir.path())
        .spawn()
        .expect("fixture coordinator");
    let exited_coordinator_pid = exited_coordinator.id();
    exited_coordinator.wait().expect("reap fixture coordinator");
    for (index, phase) in ["starting", "complete", "skipped", "failed", "malformed"]
        .into_iter()
        .enumerate()
    {
        let status_path = status_dir.join(format!("{index:016x}-fixture.json"));
        let bytes = if phase == "malformed" {
            b"not json".to_vec()
        } else {
            json!({
                "version": 1,
                "requestId": "fixture",
                "socketPath": dir.path().join("other-daemon.sock"),
                "phase": phase,
                "coordinator": {
                    "pid": if phase == "starting" {
                        std::process::id()
                    } else {
                        exited_coordinator_pid
                    },
                },
                "counts": { "total": 0, "restored": 0, "resumed": 0, "failed": 0 },
                "startedAt": "2026-10-07T00:00:00Z",
                "updatedAt": "2026-10-07T00:00:00Z",
            })
            .to_string()
            .into_bytes()
        };
        std::fs::write(&status_path, &bytes).expect("status fixture");
        preserved.push((status_path, bytes));
    }

    let live_session = dir.path().join("live-session.jsonl");
    std::fs::write(&live_session, "{}\n").expect("live session");
    let live_lease = pa_daemon::lease::acquire_runtime_session_lease(&live_session, &agent_dir)
        .expect("live lease");
    let dead_lease = agent_dir.join("session-leases/dead.lock");
    std::fs::create_dir_all(&dead_lease).expect("dead lease");
    std::fs::write(
        dead_lease.join("owner.json"),
        json!({
            "version": 1,
            "token": "dead-fixture",
            "pid": 0,
            "sessionPath": dir.path().join("dead-session.jsonl"),
            "createdAt": "2026-10-07T00:00:00Z",
        })
        .to_string(),
    )
    .expect("dead owner");
    let corrupt_lease = agent_dir.join("session-leases/corrupt.lock");
    std::fs::create_dir_all(&corrupt_lease).expect("corrupt lease");
    let corrupt_owner = corrupt_lease.join("owner.json");
    std::fs::write(&corrupt_owner, "not json").expect("corrupt owner");
    preserved.push((corrupt_owner, b"not json".to_vec()));
    let obsolete_cache = agent_dir.join("prime-inference-models-cache.json");
    std::fs::write(&obsolete_cache, "{}").expect("obsolete cache");

    let _daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        if log.contains("boot cleanup: removed") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "boot cleanup did not finish: {log}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    std::fs::set_permissions(
        descriptor_dir.join("unreadable.json"),
        std::fs::Permissions::from_mode(0o600),
    )
    .expect("restore fixture permissions");
    for (path, bytes) in preserved {
        assert_eq!(
            std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display())),
            bytes,
            "cleanup must preserve {} byte for byte",
            path.display()
        );
    }
    assert!(
        !dead_lease.exists(),
        "the provably dead lease was reclaimed"
    );
    assert!(
        !obsolete_cache.exists(),
        "the unused root cache was removed"
    );
    assert!(
        pa_daemon::lease::acquire_runtime_session_lease(&live_session, &agent_dir).is_err(),
        "the live fixture still owns its session"
    );
    live_lease.release();
}
