//! The plain-boot revival regression: only journal-busy workers revive
use super::*;

/// A plain supervisor boot (no update roster) adopts live workers and
/// revives only dead ones with durable busy evidence. The idle-at-exit
/// session completed its turn, so its journal's latest record settled to
/// `busy: false` (`turn_end` — the state a long-lived daemon accumulates
/// for every idle session); the busy-at-crash session is killed mid-turn,
/// so its journal still holds the boot `create` `busy: true` record. Only
/// the mid-turn one relaunches and re-registers.
#[test]
fn plain_boot_revives_only_journal_busy_workers() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client, _hello) = Client::connect(&socket);

    // Session 0 settles idle: its one turn completes before the kill.
    let script_idle = dir.path().join("journal-idle.json");
    std::fs::write(
        &script_idle,
        json!({ "responses": [
            { "text": "turn-idle", "delayMs": 10 },
        ] })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "c0",
        &json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script_idle.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c0");
    assert_eq!(created["success"], true, "create idle failed: {created}");
    let idle_session = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    client.send_command(
        "p0",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": idle_session,
            "message": "go",
        }),
    );
    let done = client.read_response("p0");
    assert_eq!(done["success"], true, "idle turn failed: {done}");

    // Session 1 dies busy-at-crash: its scripted turn is still open when
    // the supervisor and both workers are killed. The turn holds open
    // through its 30s scripted delay, so the kill lands mid-turn on any
    // runner pacing (the journal's admission `busy: true` record is the
    // durable evidence the kill waits for below).
    let script_busy = dir.path().join("journal-busy.json");
    let busy_text = "still streaming ".repeat(40);
    std::fs::write(
        &script_busy,
        json!({
            "responses": [ { "text": busy_text, "delayMs": 30_000 } ],
            "tokensPerSecond": 20,
        })
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
    client.send_command(
        "a1",
        &json!({ "type": "attach", "activeSessionId": busy_session }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach busy failed: {attached}");
    client.send_command(
        "p1",
        &json!({
            "type": "prompt",
            "activeSessionId": busy_session,
            "message": "go",
        }),
    );
    let (ack, busy_turn_lines) = client.read_response_and_lines("p1");
    assert_eq!(ack["success"], true, "busy prompt failed: {ack}");
    drop(busy_turn_lines);
    // The busy-at-crash premise is DURABLE EVIDENCE, never stream pacing:
    // wait for the worker's recovery journal to record the admission
    // `busy: true` for this session BEFORE the kill. The scripted turn
    // holds open through its 30s delay, so the journal's latest record
    // stays busy at the kill on any runner pacing - the loaded-host mode
    // where the old message_start race let the whole turn settle before
    // the kill landed (both workers then read idle-at-exit, and the
    // only-busy-revives signal was lost).
    wait_for_busy_journal_evidence(&agent_dir, &socket, &busy_session);

    // kill -9 the supervisor, then the workers: the descriptors stay on
    // disk with dead sockets and the journals keep their last evidence
    // (idle: a settled `turn_end` busy=false; busy: the boot `create`).
    // The workers are killed by the supervisor's live children, not the
    // descriptor pids — a mid-test replacement (crash backoff, a stop
    // re-finalization) can leave the descriptor stale, and a stale-pid
    // kill would leave the real worker streaming.
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

    // Plain boot on the same socket (no update-roster environment).
    let restart_before = pa_daemon::util::now_iso();
    let mut daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);

    // The busy-at-crash session (journal busy=true) relaunches and
    // re-registers; the idle-at-exit session never does.
    let deadline = Instant::now() + Duration::from_secs(15);
    let registered = loop {
        let registered = distinct(workers_registered_since(&log_path, &restart_before));
        if registered == vec![busy_session.clone()] {
            break registered;
        }
        assert!(
            Instant::now() < deadline,
            "busy-at-crash session did not re-register ({restart_before}): {registered:?}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(registered, vec![busy_session.clone()]);

    // The idle-at-exit session is skipped with a log line and stays off
    // the roster.
    let skip_line = format!("session worker {idle_session} was idle at exit; not revived");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains(&skip_line)
    {
        assert!(
            Instant::now() < deadline,
            "idle session never skipped: {skip_line}"
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
        vec![busy_session.clone()],
        "only the busy-at-crash session came back"
    );

    // Shutdown takes the restarted supervisor and the relaunched worker
    // down (the relaunch persisted the new pid in the descriptor). The
    // relaunched worker replays the restored queue's turn too, so the
    // shutdown's flush barrier rides out the scripted delay before its
    // reply - the budgets below absorb the whole stop pass (the barrier
    // wait, then the terminal escalation), never a fixed fast exit.
    let relaunched = load_worker_descriptor(&agent_dir, &socket, &busy_session);
    client2.send_command("sd", &json!({ "type": "shutdown" }));
    let shutdown = client2.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(45);
    while daemon2.child.try_wait().expect("try wait").is_none() {
        assert!(Instant::now() < deadline, "restarted supervisor exited");
        std::thread::sleep(Duration::from_millis(50));
    }
    let deadline = Instant::now() + Duration::from_secs(45);
    while process_alive(relaunched.pid) {
        assert!(
            Instant::now() < deadline,
            "relaunched worker leaked after shutdown"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
