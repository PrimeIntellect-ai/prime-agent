//! The stop-escalation e2e (the Codex daemon-comparison finding #5): a
//! worker that ignores the graceful stop cannot outlive the command
//! holding its session lease. The wire kill's stop aftermath runs on every
//! route outcome (TS's root-kill `finally`), and the retire pass
//! escalates — the bounded `shutdown` route, SIGTERM, the TERM grace,
//! SIGKILL, the post-kill hard deadline — so a hung worker dies inside one
//! bounded window, its session lease frees through the dead-owner
//! reclaim, and a well-behaved worker keeps the clean stop.
//!
//! Linux-only e2e (`AF_UNIX` sockets, `/proc`, pidfd signaling): compiles
//! to nothing elsewhere, like the other pa-daemon e2e verifiers.
#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
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

// The timeout panic path cannot wait on the child; the test process exits
// immediately afterwards, reaping it.
#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Daemon {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("PRIME_API_KEY")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if UnixStream::connect(socket).is_ok() {
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// Liveness that ignores zombies (a killed child nobody has reaped yet
/// keeps its `/proc` entry until the status is collected).
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

/// One client connection over the supervisor socket.
struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = UnixStream::connect(socket).expect("connect");
        let writer = stream.try_clone().expect("clone");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_mins(5);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
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

    fn send_command(&mut self, id: &str, command: Value) {
        let mut line = serde_json::to_string(&json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }))
        .expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn request(&mut self, id: &str, command: Value) -> Value {
        self.send_command(id, command);
        loop {
            let response = self.read_line();
            if response.get("id").and_then(Value::as_str) == Some(id) {
                return response;
            }
        }
    }
}

/// One session over the daemon: its addressable id and the durable id the
/// descriptor and the session file carry.
struct Session {
    active_id: String,
    session_id: String,
}

fn create_session(client: &mut Client, id: &str, dir: &Path, agent_dir: &Path) -> Session {
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("session dir");
    let script = write_script(dir);
    let created = client.request(
        id,
        json!({
            "type": "create",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
                "name": "stop-escalation",
            },
        }),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
    Session {
        active_id: created["data"]["activeSessionId"]
            .as_str()
            .or_else(|| created["data"]["id"].as_str())
            .expect("active session id")
            .to_string(),
        session_id: created["data"]["sessionId"]
            .as_str()
            .expect("durable session id")
            .to_string(),
    }
}

fn write_script(dir: &Path) -> PathBuf {
    let script = dir.join("faux.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [{ "text": "the lane works on" }],
        })
        .to_string(),
    )
    .expect("write faux script");
    script
}

/// The session's durable file (TS `get_session_stats` -> sessionFile).
fn session_file_of(client: &mut Client, active_id: &str) -> PathBuf {
    let stats = client.request(
        "stats",
        json!({ "type": "get_session_stats", "activeSessionId": active_id }),
    );
    assert_eq!(stats["success"], true, "stats failed: {stats}");
    PathBuf::from(
        stats["data"]["sessionFile"]
            .as_str()
            .expect("session file in stats"),
    )
}

/// The stopped session's descriptor: its path and the worker pid it
/// names (the retirement removes the file when the stop proves the
/// process gone).
fn worker_descriptor_of(agent_dir: &Path, socket: &Path, session_id: &str) -> (PathBuf, u32) {
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(agent_dir, socket);
    let found = std::fs::read_dir(&descriptor_dir)
        .expect("descriptor dir readable")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("json")
                && std::fs::read_to_string(path).is_ok_and(|content| content.contains(session_id))
        })
        .expect("the session worker's descriptor");
    let descriptor: Value =
        serde_json::from_str(&std::fs::read_to_string(&found).expect("descriptor readable"))
            .expect("descriptor json");
    let pid = descriptor["pid"].as_u64().expect("worker pid") as u32;
    (found, pid)
}

/// The session file's latest `session_state` status.
fn session_state(session_file: &Path) -> String {
    let mut state = String::new();
    for line in std::fs::read_to_string(session_file)
        .expect("session file readable")
        .lines()
    {
        let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) == Some("session_state") {
            if let Some(status) = entry["state"]["status"].as_str() {
                state = status.to_string();
            }
        }
    }
    state
}

/// A hung session worker — one that ignores the routed kill and the stop's
/// graceful `shutdown` — dies inside the escalation window (the two route
/// budgets, the TERM grace, the SIGKILL hard deadline), its descriptor
/// dies with it, its session lease frees (the dead-owner reclaim a fresh
/// open runs), and the session reopens. Before the fix the route timeout
/// skipped the stop entirely: the worker stayed stopped-but-alive,
/// holding the lease behind a route that never answers.
#[test]
fn a_hung_worker_is_killed_within_the_escalation_window_and_its_lease_frees() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    // The sessions dir exists before the create: the lease keys on the
    // canonical session path.
    std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
    let socket = dir.path().join("escalation.sock");
    let daemon = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);
    let session = create_session(&mut client, "create", dir.path(), &agent_dir);
    let session_file = session_file_of(&mut client, &session.active_id);
    let (descriptor, worker_pid) = worker_descriptor_of(&agent_dir, &socket, &session.session_id);

    // The live worker holds the runtime lease: a fresh open's acquire
    // refuses (the premise the escalation must break).
    assert!(
        pa_daemon::lease::acquire_runtime_session_lease(&session_file, &agent_dir).is_err(),
        "the live worker must hold the session lease"
    );

    // Hang the worker: SIGSTOP freezes its command pump, so the routed
    // kill and the stop's graceful `shutdown` both go unanswered (the
    // hung-inside-its-turn shape).
    let stopped = Command::new("kill")
        .arg("-STOP")
        .arg(worker_pid.to_string())
        .status()
        .expect("SIGSTOP the worker");
    assert!(stopped.success(), "SIGSTOP must reach the worker");

    // THE STOP: the wire kill of the hung worker. The route times out;
    // the stop completes anyway (TS's root-kill `finally`) and escalates.
    let sent = Instant::now();
    let killed = client.request(
        "kill",
        json!({ "type": "kill", "activeSessionId": session.active_id }),
    );
    let elapsed = sent.elapsed();
    assert_eq!(
        killed["success"], false,
        "the hung worker never answers: {killed}"
    );
    assert!(
        killed["error"]
            .as_str()
            .is_some_and(|error| error.contains("timed out")),
        "the refusal is the route timeout: {killed}"
    );
    // The graceful window ran before the escalation, and the whole stop
    // stayed bounded (two route budgets + TERM grace + SIGKILL hard
    // deadline).
    assert!(
        elapsed >= Duration::from_secs(30),
        "the graceful route window must run before the escalation: {elapsed:?}"
    );
    assert!(
        elapsed <= Duration::from_secs(105),
        "the escalation must stay bounded: {elapsed:?}"
    );

    // The hung worker is provably dead (only the SIGKILL half of the
    // escalation can end a SIGSTOPped process), and the stop's proof of
    // death removed its descriptor.
    assert!(
        !process_alive(worker_pid),
        "the escalation must have killed the hung worker"
    );
    assert!(
        !descriptor.exists(),
        "the provably-dead worker's descriptor must be gone"
    );
    // The kill's durable half ran on the failed route: the session file
    // carries the archived state.
    assert_eq!(session_state(&session_file), "archived");

    // The lease freed: a newcomer acquires it through the dead-owner
    // reclaim (the same acquire a fresh worker runs at open).
    let lease = pa_daemon::lease::acquire_runtime_session_lease(&session_file, &agent_dir)
        .expect("the dead worker's lease must be reclaimable");
    drop(lease);
    // The session reopens (the end-user symptom of finding #5 is gone).
    let reopened = client.request(
        "reopen",
        json!({
            "type": "create",
            "sessionPath": session_file.to_string_lossy(),
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": write_script(dir.path()).to_string_lossy(),
                "name": "stop-escalation",
            },
        }),
    );
    assert_eq!(
        reopened["success"], true,
        "the stopped session must reopen: {reopened}"
    );

    // The reopened worker is a normal citizen: the wire kill cleans it up
    // (no leftovers for the test machine).
    let reopened_id = reopened["data"]["activeSessionId"]
        .as_str()
        .or_else(|| reopened["data"]["id"].as_str())
        .expect("reopened session id");
    let cleaned = client.request(
        "cleanup",
        json!({ "type": "kill", "activeSessionId": reopened_id }),
    );
    assert_eq!(cleaned["success"], true, "cleanup kill failed: {cleaned}");

    drop(client);
    drop(daemon);
}

/// A well-behaved worker keeps the clean stop: the wire kill answers
/// success without waiting out any route budget, the worker exits on its
/// own routed close (no survivor line in the log), the descriptor dies
/// with the proven-gone process, the lease frees, and the stopped session
/// reopens.
#[test]
fn a_well_behaved_worker_keeps_the_clean_stop() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
    let socket = dir.path().join("clean.sock");
    let daemon = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);
    let session = create_session(&mut client, "create", dir.path(), &agent_dir);
    let session_file = session_file_of(&mut client, &session.active_id);
    let (descriptor, worker_pid) = worker_descriptor_of(&agent_dir, &socket, &session.session_id);

    // THE STOP: the well-behaved kill answers quickly (the graceful close
    // settles inside the route budget; no escalation window is spent).
    let sent = Instant::now();
    let killed = client.request(
        "kill",
        json!({ "type": "kill", "activeSessionId": session.active_id }),
    );
    let elapsed = sent.elapsed();
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    assert!(
        elapsed <= Duration::from_secs(25),
        "the clean stop must not wait out a route budget: {elapsed:?}"
    );

    // The worker exits on its own routed close.
    let deadline = Instant::now() + Duration::from_secs(15);
    while process_alive(worker_pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !process_alive(worker_pid),
        "the worker must exit on the stop"
    );
    assert!(
        !descriptor.exists(),
        "the cleanly stopped worker's descriptor must be gone"
    );
    assert_eq!(session_state(&session_file), "archived");
    // The clean stop never reports a survivor.
    let log = std::fs::read_to_string(pa_daemon::paths::daemon_log_path(&socket, &agent_dir))
        .unwrap_or_default();
    assert!(
        !log.contains("survived the shutdown escalation"),
        "the clean stop must not log a survivor: {log}"
    );
    // The lease freed and the session reopens.
    let lease = pa_daemon::lease::acquire_runtime_session_lease(&session_file, &agent_dir)
        .expect("the stopped session's lease must be free");
    drop(lease);
    let reopened = client.request(
        "reopen",
        json!({
            "type": "create",
            "sessionPath": session_file.to_string_lossy(),
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": write_script(dir.path()).to_string_lossy(),
                "name": "stop-escalation",
            },
        }),
    );
    assert_eq!(
        reopened["success"], true,
        "the stopped session must reopen: {reopened}"
    );

    // The reopened worker is a normal citizen: the wire kill cleans it up
    // (no leftovers for the test machine).
    let reopened_id = reopened["data"]["activeSessionId"]
        .as_str()
        .or_else(|| reopened["data"]["id"].as_str())
        .expect("reopened session id");
    let cleaned = client.request(
        "cleanup",
        json!({ "type": "kill", "activeSessionId": reopened_id }),
    );
    assert_eq!(cleaned["success"], true, "cleanup kill failed: {cleaned}");

    drop(client);
    drop(daemon);
}
