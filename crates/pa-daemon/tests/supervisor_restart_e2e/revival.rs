//! The revival-fixture regressions: the parked/stopped/given-up/fresh
//! busy-evidence shapes.
use super::*;

/// One captured-shape revival fixture: a durable session file, a dead
/// worker's descriptor, and the worker's recovery journal — the on-disk
/// state a supervisor boots into on the rust-agent box after a failure
/// era (the 17:07 storm slots and the stopped fleet sessions). The
/// shapes mirror the captured artifacts: descriptor
/// `daemon-workers/<socket-key>/<workerId>.json`, journal
/// `<workerId>.recovery.jsonl` (the busy-record shape of
/// `93320d14c7d3`, busy written at 12:02 and read at 17:07), and a
/// session file with an explicit `session_state` row.
struct RevivalFixture {
    worker_id: String,
    session_file: PathBuf,
    session_bytes: Vec<u8>,
}

fn write_revival_fixture(
    dir: &Path,
    agent_dir: &Path,
    socket: &Path,
    session_state: &str,
    lifecycle: &str,
    busy_recorded_at: &str,
) -> RevivalFixture {
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let worker_id = format!("w{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let mut session =
        pa_daemon::session_store::SessionFile::create(&dir.to_string_lossy(), None, 0);
    session.append_message(&json!({
        "role": "user", "content": "lane work", "timestamp": 1u64
    }));
    session.append_session_state(session_state);
    let session_id = session.session_id().to_string();
    let session_file = sessions_dir.join(format!("{session_id}.jsonl"));
    session.set_path(session_file.clone());
    session.rewrite().expect("session file");
    let session_bytes = std::fs::read(&session_file).expect("session bytes");

    // A script the relaunched create would drive: on the unpatched base
    // the fixture's worker comes back as a registered live worker; the
    // gate must park it instead.
    let script = dir.join(format!("{worker_id}-script.json"));
    std::fs::write(
        &script,
        json!({ "responses": [ { "text": "ok", "delayMs": 10 } ] }).to_string(),
    )
    .expect("write script");

    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(agent_dir, socket);
    std::fs::create_dir_all(&descriptor_dir).expect("descriptor dir");
    let journal_path = descriptor_dir.join(format!("{worker_id}.recovery.jsonl"));
    std::fs::write(
        &journal_path,
        json!({
            "activeSessionId": worker_id,
            "sessionId": session_id,
            "sessionFile": session_file.to_string_lossy(),
            "busy": true,
            "operation": "create",
            "recordedAt": busy_recorded_at,
        })
        .to_string()
            + "\n",
    )
    .expect("write journal");
    let now = pa_daemon::util::now_iso();
    std::fs::write(
        descriptor_dir.join(format!("{worker_id}.json")),
        json!({
            "version": 2,
            "workerId": worker_id,
            "pid": 4_194_303u64,
            "socketPath": dir.join(format!("{worker_id}.sock")).to_string_lossy(),
            "recoveryJournalPath": journal_path.to_string_lossy(),
            "supervisorSocketPath": socket.to_string_lossy(),
            "authenticationToken": format!("token-{worker_id}"),
            "rootActiveSessionId": worker_id,
            "rootSessionId": session_id,
            "sessionFile": session_file.to_string_lossy(),
            "sessionDir": sessions_dir.to_string_lossy(),
            "createdAt": now,
            "updatedAt": now,
            "lifecycle": lifecycle,
            "createCommand": {
                "sessionPath": session_file.to_string_lossy(),
                "rest": {
                    "cwd": dir.to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                    "script": script.to_string_lossy(),
                },
            },
            "consecutiveFailures": 0,
        })
        .to_string(),
    )
    .expect("write descriptor");
    RevivalFixture {
        worker_id,
        session_file,
        session_bytes,
    }
}

/// Boot one fixture supervisor, wait out the adoption pass, and answer the
/// (park log line, registered worker ids, listed session ids) the boot
/// produced — the shared assert core of the park regressions.
fn boot_and_observe(agent_dir: &Path, socket: &Path) -> (Daemon, PathBuf, String) {
    let daemon = spawn_supervisor(socket, agent_dir);
    wait_socket_ready(socket);
    let log_path = pa_daemon::paths::daemon_log_path(socket, agent_dir);
    let boot_before = pa_daemon::util::now_iso();
    // The adoption pass runs concurrently with the accept loop; give it a
    // bounded window to reach every descriptor before the assertions read
    // the log and the roster. A boot that revives instead of parking (the
    // unpatched base) never writes the line and falls through — the park
    // assertions below carry the failure with the log dump.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains("not revived")
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    (daemon, log_path, boot_before)
}

/// The 17:07 storm, as a regression: a plain boot must not relaunch a
/// dead descriptor whose journal busy record is hours old — the captured
/// 93320d14c7d3 shape (busy written at 12:02, read at the 17:07 boot)
/// resurrects on the unpatched base as a registered worker.
#[test]
fn plain_boot_parks_stale_busy_evidence() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let busy_at = pa_daemon::util::iso_from_unix_ms(pa_daemon::util::now_ms() - 5 * 60 * 60 * 1000);
    let fixture =
        write_revival_fixture(dir.path(), &agent_dir, &socket, "active", "ready", &busy_at);

    let (_supervisor, log_path, boot_before) = boot_and_observe(&agent_dir, &socket);

    let park_line = format!(
        "session worker {} not revived: its busy evidence is stale (recorded {busy_at}); not revived (reopens on the next client open)",
        fixture.worker_id
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains(&park_line)
    {
        assert!(
            Instant::now() < deadline,
            "stale-evidence worker never parked: {park_line}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        workers_registered_since(&log_path, &boot_before).is_empty(),
        "the stale-evidence worker resurrected"
    );
    let (mut client, _hello) = Client::connect(&socket);
    client.send_command("list1", &json!({ "type": "list" }));
    let list = client.read_response("list1");
    assert_eq!(list["success"], true, "list failed: {list}");
    let listed = list["data"]["sessions"].as_array().expect("sessions");
    assert!(
        listed.is_empty(),
        "the parked session must not come back as a worker"
    );
    // Preserve the session file: the park never touches it.
    assert_eq!(
        std::fs::read(&fixture.session_file).expect("session bytes"),
        fixture.session_bytes,
        "the parked session file must stay byte-identical"
    );
}

/// The stopped-session resurrection, as a regression: even FRESH busy
/// evidence must not revive a session whose durable state is the stop
/// lifecycle's `archived` belt (#2592) — the captured zombie shape (a
/// fleet lane stopped at 15:57, journal still busy from its last turn).
#[test]
fn plain_boot_never_revives_a_stopped_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let busy_at = pa_daemon::util::now_iso();
    let fixture = write_revival_fixture(
        dir.path(),
        &agent_dir,
        &socket,
        "archived",
        "ready",
        &busy_at,
    );

    let (_supervisor, log_path, boot_before) = boot_and_observe(&agent_dir, &socket);

    let park_line = format!(
        "session worker {} not revived: its session is archived (stopped); not revived (reopens on the next client open)",
        fixture.worker_id
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains(&park_line)
    {
        assert!(
            Instant::now() < deadline,
            "stopped session never parked: {park_line}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        workers_registered_since(&log_path, &boot_before).is_empty(),
        "the stopped session resurrected as a worker"
    );
    // The archived belt survives the boot untouched.
    assert_eq!(
        std::fs::read(&fixture.session_file).expect("session bytes"),
        fixture.session_bytes,
        "the archived session file must stay byte-identical"
    );
}

/// The storm-cycle breaker, as a regression: a descriptor the supervisor
/// already gave up on (`lifecycle: failed`) never relaunches at a later
/// boot — the give-up verdict is durable (the 12:00 → 17:07 recurrence).
#[test]
fn plain_boot_never_revives_a_given_up_worker() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let busy_at = pa_daemon::util::now_iso();
    let fixture = write_revival_fixture(
        dir.path(),
        &agent_dir,
        &socket,
        "active",
        "failed",
        &busy_at,
    );

    let (_supervisor, log_path, boot_before) = boot_and_observe(&agent_dir, &socket);

    let park_line = format!(
        "session worker {} not revived: was failed at the last give-up; not revived (reopens on the next client open)",
        fixture.worker_id
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains(&park_line)
    {
        assert!(
            Instant::now() < deadline,
            "given-up worker never parked: {park_line}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        workers_registered_since(&log_path, &boot_before).is_empty(),
        "the given-up worker resurrected"
    );
}

/// The gate keeps the genuine case: a worker whose journal proves live
/// work that just crashed — fresh busy evidence, an active session, no
/// give-up, no lease holder — still relaunches at a plain boot (the
/// no-false-negative half of #2584's contract, driven through the same
/// captured fixture shape the park regressions use).
#[test]
fn plain_boot_still_revives_fresh_busy_evidence() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let busy_at = pa_daemon::util::now_iso();
    let fixture =
        write_revival_fixture(dir.path(), &agent_dir, &socket, "active", "ready", &busy_at);

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    let boot_before = pa_daemon::util::now_iso();

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let registered = distinct(workers_registered_since(&log_path, &boot_before));
        if registered == vec![fixture.worker_id.clone()] {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "fresh-busy worker did not revive ({boot_before}): {registered:?}; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    let (mut client, _hello) = Client::connect(&socket);
    let relaunched = load_worker_descriptor(&agent_dir, &socket, &fixture.worker_id);
    client.send_command("sd", &json!({ "type": "shutdown" }));
    let shutdown = client.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while daemon.child.try_wait().expect("try wait").is_none() {
        assert!(Instant::now() < deadline, "supervisor exited");
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
