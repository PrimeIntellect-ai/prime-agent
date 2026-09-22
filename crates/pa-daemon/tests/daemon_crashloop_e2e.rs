//! Daemon crash-loop regression suite (the 2026-09-22 flip incident): a
//! new daemon on the same socket path revived every persisted worker
//! record, the monitor watched the pre-relaunch (dead) pid, the supervisor
//! spawned duplicate workers that died instantly on the held socket, and
//! the failure counter reset on every hollow relaunch success - "failure
//! 1/5" forever at ~4 restarts/sec for 46 minutes
//! (`daemon.sock.4cd70322.log`, 15,787 restart lines).
//!
//! The fixes under test:
//! - revival guard: a relaunched worker is watched by its real child
//!   handle; a held socket is adopted or deferred, never spawned against;
//!   a record already declared failed is archived, not revived;
//! - escalation: the failure streak accumulates across unstable lives and
//!   relaunch failures, and the give-up archives the record for
//!   post-mortem instead of leaving it for the next daemon to revive;
//! - conflict detection: a holder of the worker's socket endpoint is named
//!   in the log by pid when wiring against a held endpoint fails.
//! - flush guard: a record that left the namespace while the daemon runs
//!   stays gone - the monitor stands down instead of rewriting it (the
//!   manual cleanup is not undone by a restart or shutdown flush).
//!
//! Linux-only e2e (AF_UNIX sockets, `/proc` scans): compiles to nothing
//! elsewhere, like the other pa-daemon e2e verifiers.
#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Daemon {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let debug = std::env::var("PA_TEST_DEBUG_DAEMON").is_ok();
    let stderr = if debug {
        let file = std::fs::File::create(agent_dir.join("daemon-stderr.log")).unwrap();
        Stdio::from(file)
    } else {
        Stdio::null()
    };
    let mut command = Command::new(binary);
    command
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(stderr)
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        );
    if debug {
        command.env("PA_DAEMON_DEBUG", "1");
    }
    let child = command.spawn().expect("spawn pa-daemon supervisor");
    Daemon {
        child,
        socket: socket.to_path_buf(),
    }
}

fn wait_socket_ready(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if UnixStream::connect(socket).is_ok() {
            return;
        }
        assert!(Instant::now() < deadline, "supervisor socket never came up");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn process_alive(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let Some((_, rest)) = stat.rsplit_once(')') else {
        return false;
    };
    let state = rest.split_whitespace().next().unwrap_or_default();
    !state.starts_with('Z') && !state.starts_with('X')
}

fn child_pids_of(ppid: u32) -> Vec<u32> {
    let mut pids = Vec::new();
    for entry in std::fs::read_dir("/proc").expect("read /proc").flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        fields.next();
        let Ok(parent) = fields.next().unwrap_or_default().parse::<u32>() else {
            continue;
        };
        if parent == ppid {
            pids.push(pid);
        }
    }
    pids
}

fn wait_until(deadline: Duration, mut probe: impl FnMut() -> bool) {
    let deadline = Instant::now() + deadline;
    while Instant::now() < deadline {
        if probe() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("condition not reached within {deadline:?}");
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> (Self, Value) {
        let stream = UnixStream::connect(socket).expect("connect supervisor");
        let write_stream = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer: write_stream,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn send(&mut self, value: &Value) {
        let mut line = serde_json::to_string(value).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn send_command(&mut self, id: &str, command: Value) {
        self.send(&json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }));
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    fn list_sessions(&mut self) -> Vec<Value> {
        self.send_command("list", json!({ "type": "list" }));
        let list = self.read_response("list");
        assert_eq!(list["success"], true, "list failed (daemon hang?): {list}");
        list["data"]["sessions"]
            .as_array()
            .expect("sessions array")
            .clone()
    }
}

fn daemon_log(socket: &Path, agent_dir: &Path) -> String {
    std::fs::read_to_string(pa_daemon::paths::daemon_log_path(socket, agent_dir))
        .unwrap_or_default()
}

fn log_contains(log: &str, needle: &str) -> bool {
    log.lines().any(|line| line.contains(needle))
}

/// `wait_until` for daemon-log conditions: on timeout, panics with the
/// log so the verifier output shows exactly what the daemon did (and did
/// not) do instead of just "condition not reached".
fn wait_until_log(deadline: Duration, socket: &Path, agent_dir: &Path, needle: &str) {
    let end = Instant::now() + deadline;
    while Instant::now() < end {
        if log_contains(&daemon_log(socket, agent_dir), needle) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "log never contained {needle:?}:\n{}\n--- stderr ---\n{}",
        daemon_log(socket, agent_dir),
        std::fs::read_to_string(agent_dir.join("daemon-stderr.log")).unwrap_or_default()
    );
}

fn log_count(log: &str, needle: &str) -> usize {
    log.lines().filter(|line| line.contains(needle)).count()
}

/// Create one scripted session and return (worker_id, descriptor path).
fn create_scripted_session(
    client: &mut Client,
    dir: &Path,
    agent_dir: &Path,
    socket: &Path,
) -> (String, PathBuf) {
    let script_path = dir.join("script.json");
    std::fs::write(
        &script_path,
        json!({ "responses": [ { "text": "turn-1" } ] }).to_string(),
    )
    .expect("write script");
    client.send_command(
        "create-1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("create-1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(agent_dir, socket);
    (
        session_id.clone(),
        descriptor_dir.join(format!("{session_id}.json")),
    )
}

/// A thief listener: binds a socket path, accepts connections, and drops
/// them immediately - a foreign holder that never speaks the worker
/// protocol. Run in a background thread; its pid is the supervisor-side
/// "conflicting pid" a bind conflict must name.
fn spawn_socket_thief(path: PathBuf) -> u32 {
    let pid = std::process::id();
    if path.exists() {
        std::fs::remove_file(&path).expect("remove stale socket file");
    }
    let listener = UnixListener::bind(&path).expect("bind thief socket");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            drop(stream);
        }
    });
    pid
}

/// A socket thief that waits for a live endpoint to die, then takes the
/// path over the moment it is free (polling every 1ms). The incident's
/// foreign holder arrived this way - the old-epoch worker died and an
/// orphan process held its endpoint before the restart loop's first
/// relaunch. Polling to bind (instead of bind-once) makes the takeover
/// deterministic: the thief wins the path within milliseconds of the
/// death, never racing the supervisor's 250ms relaunch backoff.
fn spawn_socket_thief_after_death(path: PathBuf) -> u32 {
    let pid = std::process::id();
    std::thread::spawn(move || loop {
        if UnixStream::connect(&path).is_ok() {
            std::thread::sleep(Duration::from_millis(1));
            continue;
        }
        let _ = std::fs::remove_file(&path);
        let Ok(listener) = UnixListener::bind(&path) else {
            std::thread::sleep(Duration::from_millis(1));
            continue;
        };
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            drop(stream);
        }
        break;
    });
    pid
}

fn kill9(pid: u32) {
    let _ = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .expect("send SIGKILL");
}

/// Seed one persisted worker record by hand (the stale-record shapes the
/// revival guard must classify). `lifecycle` and `socket_path` choose the
/// scenario; the recorded pid is always dead.
fn seed_worker_record(
    agent_dir: &Path,
    socket: &Path,
    worker_id: &str,
    socket_path: &Path,
    lifecycle: &str,
    consecutive_failures: u64,
) -> PathBuf {
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(agent_dir, socket);
    std::fs::create_dir_all(&descriptor_dir).expect("descriptor dir");
    let record = json!({
        "version": 2,
        "workerId": worker_id,
        "pid": 999_999,
        "socketPath": socket_path.to_string_lossy(),
        "recoveryJournalPath": descriptor_dir.join(format!("{worker_id}.recovery.jsonl"))
            .to_string_lossy(),
        "supervisorSocketPath": socket.to_string_lossy(),
        "authenticationToken": "00000000-0000-0000-0000-000000000000",
        "rootActiveSessionId": worker_id,
        "createdAt": "2026-09-22T00:00:00.000Z",
        "updatedAt": "2026-09-22T00:00:00.000Z",
        "lifecycle": lifecycle,
        "createCommand": { "type": "create", "cwd": "/tmp" },
        "consecutiveFailures": consecutive_failures,
    });
    let path = descriptor_dir.join(format!("{worker_id}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&record).unwrap())
        .expect("write seeded record");
    path
}

/// The incident itself: the box flip killed a daemon and its worker, the
/// new daemon on the same socket path adopted the record ("was alive:
/// false"), relaunched the worker - and then the monitor watched the
/// stale pre-relaunch pid, declared the healthy worker crashed, and
/// restarted it forever ("failure 1/5" ~4/sec, duplicate spawns dying on
/// the bind conflict). The monitor must watch the relaunched child.
#[test]
fn dead_worker_adoption_watches_relaunched_child_not_stale_pid() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let (worker_id, descriptor_path) =
        create_scripted_session(&mut client, dir.path(), &agent_dir, &socket);

    let first_worker_pid: u32 = {
        let record: Value =
            serde_json::from_str(&std::fs::read_to_string(&descriptor_path).expect("descriptor"))
                .expect("descriptor json");
        record["pid"].as_u64().expect("pid") as u32
    };
    assert!(process_alive(first_worker_pid), "worker spawned");

    // The flip: the old daemon and its worker both die, the record stays.
    let _ = daemon.child.kill();
    let _ = daemon.child.wait();
    kill9(first_worker_pid);
    let daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let supervisor_pid = daemon2.child.id();

    // The record is revived: the relaunch lands and the worker registers.
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    wait_until(Duration::from_secs(20), || {
        log_contains(
            &daemon_log(&socket, &agent_dir),
            &format!("adopted session worker {worker_id} (was alive: false)"),
        )
    });
    wait_until(Duration::from_secs(20), || {
        daemon_log(&socket, &agent_dir)
            .contains(&format!("session worker {worker_id} registered (epoch"))
    });

    // The healthy relaunched worker ran for a while: no phantom crash, no
    // duplicate spawns, no "failure 1/5" loop (the old bug logged ~4 crash
    // lines per second here).
    std::thread::sleep(Duration::from_secs(3));
    let log = daemon_log(&socket, &agent_dir);
    assert_eq!(
        log_count(&log, "exited unexpectedly"),
        0,
        "the relaunched worker was treated as crashed: {log}"
    );
    let workers: Vec<u32> = child_pids_of(supervisor_pid)
        .into_iter()
        .filter(|pid| process_alive(*pid))
        .collect();
    assert_eq!(
        workers.len(),
        1,
        "exactly one worker process, no duplicates"
    );
    let record: Value = serde_json::from_str(
        &std::fs::read_to_string(&descriptor_path).expect("descriptor after adoption"),
    )
    .expect("descriptor json");
    let relaunched_pid = record["pid"].as_u64().expect("pid") as u32;
    assert!(
        process_alive(relaunched_pid),
        "the monitor must watch the relaunched pid, not the stale one"
    );
    assert_ne!(relaunched_pid, first_worker_pid);
    let mut client2 = Client::connect(&socket).0;
    assert_eq!(
        client2.list_sessions().len(),
        1,
        "the recovered session is served"
    );

    // Normal crash recovery still works: one stable worker dies, exactly
    // one "failure 1/5" line, a fresh relaunch, no escalation spiral.
    kill9(relaunched_pid);
    wait_until(Duration::from_secs(20), || {
        log_contains(
            &daemon_log(&socket, &agent_dir),
            &format!("session worker {worker_id} re-registered (epoch 2"),
        )
    });
    std::thread::sleep(Duration::from_secs(2));
    let log = daemon_log(&socket, &agent_dir);
    assert_eq!(
        log_count(&log, "exited unexpectedly; restarting in"),
        1,
        "one crash, one restart line"
    );
    assert!(
        !log_contains(&log, "failure 2/5"),
        "a single stable crash must not escalate: {log}"
    );
    assert!(
        !log_contains(&log, "consecutive failures"),
        "a single crash must not give up: {log}"
    );
    let _ = log_path;
    // Teardown: daemon2's Drop kills the supervisor and waits.
    drop(daemon2);
}

/// The failure-counter verifier: five consecutive launch failures escalate
/// to a logged give-up, the record is archived for post-mortem and taken
/// out of the live namespace (a corrupt session store makes every create
/// replay fail, like the fd-lifecycle loop).
#[test]
fn restart_loop_escalates_gives_up_and_archives_the_record() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");

    let daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let supervisor_pid = daemon.child.id();
    let (mut client, _hello) = Client::connect(&socket);

    let (worker_id, descriptor_path) =
        create_scripted_session(&mut client, dir.path(), &agent_dir, &socket);
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(&descriptor_path).expect("descriptor"))
            .expect("descriptor json");
    let worker_pid = record["pid"].as_u64().expect("pid") as u32;
    let session_file = record["sessionFile"]
        .as_str()
        .expect("session file")
        .to_string();

    // Corrupt the durable session file: every create replay from here on
    // fails, so each restart is a launch failure.
    std::fs::write(&session_file, "not valid jsonl\n").expect("corrupt session file");
    kill9(worker_pid);

    // The budget runs out: the give-up is logged and the roster drops the
    // session. Each failed attempt spawns a real worker process for its
    // create replay, so the deadline must survive a fully-parallel
    // workspace run where spawns take seconds (the standalone suite gives
    // up in ~10s).
    wait_until(Duration::from_secs(120), || {
        log_contains(
            &daemon_log(&socket, &agent_dir),
            &format!("session worker {worker_id} failed after"),
        )
    });

    let log = daemon_log(&socket, &agent_dir);
    for n in 1..=5 {
        assert_eq!(
            log_count(&log, &format!("(failure {n}/5)")),
            1,
            "failure counter must escalate {n}/5 exactly once: {log}"
        );
    }
    assert!(
        log_contains(
            &log,
            &format!("session worker {worker_id} gave up; record archived to")
        ),
        "the give-up must log the archive: {log}"
    );
    // Post-mortem: the record is archived and no longer revivable.
    let archived = descriptor_path.with_extension("failed.json");
    assert!(
        archived.exists(),
        "archived record at {}",
        archived.display()
    );
    assert!(
        !descriptor_path.exists(),
        "live record removed after give-up"
    );
    assert!(
        client.list_sessions().is_empty(),
        "roster drops the session"
    );
    // No orphan workers, and the supervisor is still responsive (no hang,
    // no loop): the monitor stopped restarting after the budget ran out.
    std::thread::sleep(Duration::from_millis(500));
    let orphans: Vec<u32> = child_pids_of(supervisor_pid)
        .into_iter()
        .filter(|pid| process_alive(*pid))
        .collect();
    assert!(orphans.is_empty(), "orphan workers survived: {orphans:?}");
    let crash_lines = log_count(&log, "exited unexpectedly; restarting in");
    std::thread::sleep(Duration::from_secs(2));
    let log_after = daemon_log(&socket, &agent_dir);
    assert_eq!(
        log_count(&log_after, "exited unexpectedly; restarting in"),
        crash_lines,
        "no restarts after the give-up: {log_after}"
    );
}

/// The conflict-detection verifier: a foreign listener on the worker's
/// socket endpoint (an old-epoch orphan's socket, in the incident) must
// never be spawned against - the relaunch guard wires the existing
/// endpoint, and the holder pid appears in the log while the failure
/// budget escalates to the give-up.
#[test]
fn held_socket_names_the_conflicting_pid_and_never_spawns_against_it() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");

    let daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let supervisor_pid = daemon.child.id();
    let (mut client, _hello) = Client::connect(&socket);

    let (worker_id, descriptor_path) =
        create_scripted_session(&mut client, dir.path(), &agent_dir, &socket);
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(&descriptor_path).expect("descriptor"))
            .expect("descriptor json");
    let worker_pid = record["pid"].as_u64().expect("pid") as u32;
    let worker_socket = PathBuf::from(record["socketPath"].as_str().expect("socket path"));

    // The worker dies and a foreign process takes its socket endpoint
    // before the restart loop's first relaunch (the backoff window): the
    // thief is already waiting on the endpoint, so it wins the path the
    // moment the worker dies instead of racing the supervisor's relaunch.
    let thief_pid = spawn_socket_thief_after_death(worker_socket.clone());
    kill9(worker_pid);

    // The restart loop hits the held endpoint: no spawn can land, the
    // holder is named, and the budget escalates to the give-up.
    wait_until_log(
        Duration::from_secs(30),
        &socket,
        &agent_dir,
        &format!("session worker {worker_id} failed after"),
    );
    let log = daemon_log(&socket, &agent_dir);
    assert!(
        log_contains(&log, &format!("held by pid {thief_pid}")),
        "the conflicting holder pid must appear in the log: {log}"
    );
    assert!(
        log_contains(&log, "wiring the existing worker instead of spawning"),
        "the guard must log its adopt-instead-of-spawn decision: {log}"
    );
    // The guard never spawned a doomed duplicate: no fast-death conflict
    // lines, and the worker record ended archived at the give-up.
    let archived = descriptor_path.with_extension("failed.json");
    assert!(
        archived.exists(),
        "archived record at {}",
        archived.display()
    );
    assert!(
        !descriptor_path.exists(),
        "live record removed after give-up"
    );
    assert!(
        client.list_sessions().is_empty(),
        "roster drops the session"
    );
    let _ = supervisor_pid;
}

/// The guard-path verifier: a stale record whose socket is held by a live
/// listener at boot is adopted or deferred - never crash-looped, never
/// hung, never spawned against. The daemon stays responsive, keeps the
/// record for a later retry, and names the holder in the log.
#[test]
fn boot_adoption_with_held_socket_defers_without_spawning() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");

    // A stale record (dead pid) whose socket path is held by a live
    // foreign listener.
    let worker_socket = dir.path().join("worker.sock");
    let thief_pid = spawn_socket_thief(worker_socket.clone());
    let descriptor_path = seed_worker_record(
        &agent_dir,
        &socket,
        "cafe12345678",
        &worker_socket,
        "ready",
        0,
    );

    let daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let supervisor_pid = daemon.child.id();

    // The adoption defers (the holder does not speak the worker protocol),
    // and the holder is named. Bounded: no 30s hang, no restart loop.
    wait_until(Duration::from_secs(30), || {
        log_contains(
            &daemon_log(&socket, &agent_dir),
            "could not adopt worker cafe12345678",
        )
    });
    let log = daemon_log(&socket, &agent_dir);
    assert!(
        log_contains(&log, &format!("held by pid {thief_pid}")),
        "the holder pid must appear on the failed adoption: {log}"
    );
    assert_eq!(
        log_count(&log, "exited unexpectedly"),
        0,
        "no crash loop for a held-socket record: {log}"
    );
    assert_eq!(
        log_count(&log, "restarting in"),
        0,
        "no restarts without a monitor: {log}"
    );
    // No worker was spawned against the held endpoint, the record is kept
    // for a later retry, and the daemon answers normally.
    assert!(
        child_pids_of(supervisor_pid).is_empty(),
        "no worker process was spawned"
    );
    assert!(descriptor_path.exists(), "a deferred record stays on disk");
    let mut client = Client::connect(&socket).0;
    assert!(client.list_sessions().is_empty());
    let _ = daemon;
}

/// The stale-record cleaning: a record the previous daemon already
/// declared failed (it exhausted its failure budget once) has a dead pid
/// and an unheld socket - it is a stale record, and a fresh daemon
/// archives it instead of reviving it into another restart cycle.
#[test]
fn failed_record_is_archived_at_boot_instead_of_revived() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");

    let worker_socket = dir.path().join("gone.sock");
    let descriptor_path = seed_worker_record(
        &agent_dir,
        &socket,
        "deadbeef0000",
        &worker_socket,
        "failed",
        0,
    );

    let daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let supervisor_pid = daemon.child.id();

    wait_until(Duration::from_secs(20), || {
        log_contains(
            &daemon_log(&socket, &agent_dir),
            "session worker deadbeef0000 record is failed; archived to",
        )
    });
    let archived = descriptor_path.with_extension("failed.json");
    assert!(
        archived.exists(),
        "archived record at {}",
        archived.display()
    );
    assert!(!descriptor_path.exists(), "the live record was cleaned");
    let log = daemon_log(&socket, &agent_dir);
    assert_eq!(
        log_count(&log, "exited unexpectedly"),
        0,
        "a failed record must not enter a restart cycle: {log}"
    );
    assert!(
        !log_contains(&log, "adopted session worker deadbeef0000"),
        "a failed record must not be revived: {log}"
    );
    assert!(
        child_pids_of(supervisor_pid).is_empty(),
        "no worker process was spawned for the failed record"
    );
    let mut client = Client::connect(&socket).0;
    assert!(client.list_sessions().is_empty());
    let _ = daemon;
}

/// The dogfood stale-record revival guard (dead pid, socket gone, the
/// previous daemon's restart streak already escalating on it): boot
/// archives the record instead of relaunching it into another boot loop -
/// no revival, no crash loop, no worker spawn. A clean dead record (no
/// recorded failures) still relaunches; that shape is covered by
/// `dead_worker_adoption_watches_relaunched_child_not_stale_pid`.
#[test]
fn stale_dead_epoch_record_with_failures_is_archived_at_boot() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");

    let worker_socket = dir.path().join("gone.sock");
    let descriptor_path = seed_worker_record(
        &agent_dir,
        &socket,
        "stalecafe0001",
        &worker_socket,
        "ready",
        3,
    );

    let daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let supervisor_pid = daemon.child.id();

    wait_until(Duration::from_secs(20), || {
        log_contains(
            &daemon_log(&socket, &agent_dir),
            "session worker stalecafe0001 record is stale (dead pid, socket gone, 3 recorded failures); archived to",
        )
    });
    let archived = descriptor_path.with_extension("failed.json");
    assert!(
        archived.exists(),
        "archived record at {}",
        archived.display()
    );
    assert!(!descriptor_path.exists(), "the live record was cleaned");
    let log = daemon_log(&socket, &agent_dir);
    assert_eq!(
        log_count(&log, "exited unexpectedly"),
        0,
        "a stale record must not enter a restart cycle: {log}"
    );
    assert_eq!(
        log_count(&log, "restarting in"),
        0,
        "no restarts without a monitor: {log}"
    );
    assert!(
        !log_contains(&log, "adopted session worker stalecafe0001"),
        "a stale record must not be revived: {log}"
    );
    assert!(
        child_pids_of(supervisor_pid).is_empty(),
        "no worker process was spawned for the stale record"
    );
    let mut client = Client::connect(&socket).0;
    assert!(client.list_sessions().is_empty());
    let _ = daemon;
}

/// The restart-flush guard (the incident's manual-cleanup undo): a worker
/// record that leaves the namespace while the daemon runs (manual cleanup)
/// must stay gone. A healthy resident never rewrites it out of band; when
/// the worker then dies, the monitor stands down instead of rewriting the
/// record - a rewrite would resurrect it and re-arm the crash loop the
/// cleanup stopped - and the roster drops the session.
#[test]
fn manually_removed_record_stays_gone_the_restart_flush_stands_down() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");

    let daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let supervisor_pid = daemon.child.id();
    let (mut client, _hello) = Client::connect(&socket);

    let (worker_id, descriptor_path) =
        create_scripted_session(&mut client, dir.path(), &agent_dir, &socket);
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(&descriptor_path).expect("descriptor"))
            .expect("descriptor json");
    let worker_pid = record["pid"].as_u64().expect("pid") as u32;

    // Manual cleanup while the worker is healthy: the record leaves the
    // namespace under the running daemon.
    std::fs::remove_file(&descriptor_path).expect("remove the record (manual cleanup)");

    // A healthy resident does not resurrect its record out of band.
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        !descriptor_path.exists(),
        "a healthy resident resurrected the manually removed record"
    );

    kill9(worker_pid);

    // The failure arm stands down instead of rewriting the record: no
    // restart cycle, no resurrection, the roster drops the session.
    wait_until_log(
        Duration::from_secs(30),
        &socket,
        &agent_dir,
        &format!(
            "session worker {worker_id} record is gone from disk; standing down instead of rewriting it"
        ),
    );
    assert!(
        !descriptor_path.exists(),
        "the restart flush resurrected the manually removed record"
    );
    let log = daemon_log(&socket, &agent_dir);
    assert_eq!(
        log_count(&log, "exited unexpectedly; restarting in"),
        0,
        "a vanished record must not enter a restart cycle: {log}"
    );
    assert!(
        client.list_sessions().is_empty(),
        "the roster drops the cleaned-up session"
    );
    // No worker spawn followed the stand-down.
    std::thread::sleep(Duration::from_millis(500));
    let orphans: Vec<u32> = child_pids_of(supervisor_pid)
        .into_iter()
        .filter(|pid| process_alive(*pid))
        .collect();
    assert!(orphans.is_empty(), "orphan workers survived: {orphans:?}");
    let _ = daemon;
}
