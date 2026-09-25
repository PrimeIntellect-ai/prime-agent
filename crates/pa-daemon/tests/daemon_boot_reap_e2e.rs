//! Daemon-boot reap e2e: the operator's exact scenario — a supervisor dies
//! leaving a worker alive whose descriptor was deleted (the pre-reap
//! terminal-stop orphaning), a new supervisor boots on the SAME socket, and
//! opening that session must work. Before the boot-reap lane this flow
//! refused forever: the leftover worker held its runtime session lease,
//! nothing on the new daemon could reach it (no descriptor to adopt, its
//! re-registration refused), and its supervisor-lost window reset against
//! the new daemon's socket — so every create over the session file bounced
//! with `Session is already active in <leftover id>`.
//!
//! The containment rule rides along: a daemon (and its workers) on a
//! DIFFERENT socket is never touched by the reap.
//!
//! Linux-only e2e (AF_UNIX sockets, /proc): compiles to nothing elsewhere,
//! like the other pa-daemon e2e verifiers.
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

/// A supervisor with a LONG supervisor-lost window: the test's orphaned
/// worker must survive every other exit path so only the boot reap can be
/// what killed it (the harness default 15s window would let the worker
/// self-exit against a dead socket before the new daemon boots).
fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let mut command = Command::new(binary);
    let command = command
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "600000",
        );
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

/// Liveness that ignores zombies (a re-parented child nobody reaps keeps its
/// /proc entry until the status is collected).
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
    let entries = std::fs::read_dir("/proc").expect("read /proc");
    for entry in entries.flatten() {
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

    /// The response for `id` (broadcast lines are skipped).
    fn read_response(&mut self, id: &str) -> Value {
        loop {
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// One scripted session: create + attach, returning the durable session id
/// and the worker pid.
fn create_session(
    client: &mut Client,
    dir: &Path,
    sessions_dir: &Path,
    supervisor_pid: u32,
    index: usize,
) -> (String, u32) {
    let script_path = dir.join(format!("script-{index}.json"));
    std::fs::write(
        &script_path,
        json!({ "responses": [{ "text": format!("turn-1-{index}"), "delayMs": 10 }] }).to_string(),
    )
    .expect("write script");
    client.send_command(
        &format!("c{index}"),
        json!({
            "type": "create",
            "config": {
                "cwd": dir.to_string_lossy(),
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
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response(&format!("a{index}"));
    assert_eq!(attached["success"], true, "attach {index} failed");
    // The worker child behind the session.
    let deadline = Instant::now() + Duration::from_secs(10);
    let worker_pid = loop {
        let children = child_pids_of(supervisor_pid);
        if !children.is_empty() {
            break children[0];
        }
        assert!(
            Instant::now() < deadline,
            "worker for session {index} never spawned"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    (session_id, worker_pid)
}

/// The worker descriptor path for one session on one socket (the on-disk
/// layout the terminal stop deletes and the boot reap protects).
fn descriptor_path(agent_dir: &Path, socket: &Path, session_id: &str) -> PathBuf {
    let key = pa_daemon::descriptor::descriptor_dir(agent_dir, socket);
    key.join(format!("{session_id}.json"))
}

/// One session's durable file path, from its worker descriptor (the create
/// response's `id` is the ACTIVE session id; the file on disk is named by
/// the durable session UUID).
fn session_file_of(agent_dir: &Path, socket: &Path, session_id: &str) -> PathBuf {
    let descriptor = std::fs::read_to_string(descriptor_path(agent_dir, socket, session_id))
        .expect("descriptor");
    let descriptor: Value = serde_json::from_str(&descriptor).expect("parse descriptor");
    PathBuf::from(
        descriptor
            .get("sessionFile")
            .and_then(Value::as_str)
            .expect("the descriptor names its session file"),
    )
}

/// One worker process's own socket file, from its environment (the same
/// `WORKER_SOCKET_ENV` the reap reads).
fn worker_socket_of(pid: u32) -> Option<PathBuf> {
    let environ = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    environ
        .split(|byte| *byte == 0)
        .find(|entry| {
            entry.starts_with(format!("{}=", pa_daemon::worker::WORKER_SOCKET_ENV).as_bytes())
        })
        .and_then(|entry| {
            std::str::from_utf8(entry)
                .ok()
                .and_then(|pair| pair.split_once('='))
                .map(|(_, socket)| PathBuf::from(socket))
        })
}

/// Kill the supervisor, delete the worker's descriptor: the orphaned-worker
/// precondition the old terminal stop produced (a live worker whose
/// identity on disk is gone — nothing on any later daemon can adopt,
/// register, or reuse it, while it keeps holding its session lease).
fn orphan_the_worker(daemon: &mut Daemon, agent_dir: &Path, socket: &Path, session_id: &str) {
    daemon.child.kill().expect("kill -9 supervisor");
    let _ = daemon.child.wait();
    let descriptor = descriptor_path(agent_dir, socket, session_id);
    std::fs::remove_file(&descriptor).expect("delete the worker descriptor");
}

/// The operator's exact report, end to end: shut a daemon down (here:
/// kill -9 plus the descriptor loss the old terminal stop produced), boot
/// a new daemon on the SAME socket, open the session — the new boot reaps
/// the leftover worker (its lease clears) and the open succeeds instead of
/// refusing with `Session is already active in <leftover id>`.
#[test]
fn boot_reap_clears_the_leftover_and_the_session_reopens() {
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
    let (session_id, worker_pid) =
        create_session(&mut client, dir.path(), &sessions_dir, supervisor_pid, 0);

    // The worker holds its session lease (the runtime ownership every
    // file-backed create acquires), and the session's durable file sits
    // on disk named by its UUID (the create response's `id` is the ACTIVE
    // session id, not the file name).
    let session_file = session_file_of(&agent_dir, &socket, &session_id);
    assert!(session_file.exists(), "the session file persists");

    // The leftover's own socket file (the reap removes it with the process).
    let worker_socket = worker_socket_of(worker_pid).expect("the leftover's socket env");

    // THE ENV-PROPAGATION GUARD: a process that merely INHERITED the
    // worker environment (a session kernel, a bash child - the readoption
    // regression: an env-only reap killed the session's whole process
    // tree) must survive the new daemon's boot. It runs `sleep` with the
    // worker env set but is NOT the worker role.
    let mut inherited_env_child = std::process::Command::new("sleep")
        .arg("300")
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
            socket.to_string_lossy().to_string(),
        )
        .env(
            pa_daemon::worker::WORKER_SOCKET_ENV,
            "/tmp/inherited-env-not-a-worker.sock",
        )
        .spawn()
        .expect("spawn the inherited-env child");

    orphan_the_worker(&mut daemon, &agent_dir, &socket, &session_id);
    assert!(
        process_alive(worker_pid),
        "the leftover worker survives its supervisor (the orphaning precondition)"
    );

    // The new daemon on the SAME socket: its boot reaps the leftover.
    std::fs::write(
        dir.path().join("script-reopen.json"),
        json!({ "responses": [{ "text": "turn-reopen", "delayMs": 10 }] }).to_string(),
    )
    .expect("write the reopen script");
    let daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let deadline = Instant::now() + Duration::from_secs(15);
    while process_alive(worker_pid) {
        assert!(
            Instant::now() < deadline,
            "the leftover worker survived the new daemon's boot reap"
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    // The operator's open: the same session file, through the new daemon.
    // Without the reap this create refuses with `Session is already
    // active in <leftover id>`; with it, the fresh worker's lease acquire
    // reclaims the dead holder's stale lease and the session opens.
    let (mut client2, hello2) = Client::connect(&socket);
    assert_eq!(hello2["type"], "daemon_hello");
    client2.send_command(
        "reopen",
        json!({
            "type": "create",
            "sessionPath": session_file.to_string_lossy(),
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": dir.path().join("script-reopen.json").to_string_lossy(),
            },
        }),
    );
    let reopened = client2.read_response("reopen");
    assert_eq!(
        reopened["success"], true,
        "the session must reopen after the reap (the operator's flow): {reopened}"
    );

    // The inherited-env child SURVIVED the reap (the argv gate: it is not
    // the worker role) - and dies now, at the test's own hand, so no leak.
    assert!(
        process_alive(inherited_env_child.id()),
        "an inherited-env non-worker process survives the boot reap"
    );
    let _ = inherited_env_child.kill();
    let _ = inherited_env_child.wait();

    // The reap logged its verdict, and the dead leftover's own socket
    // file left with it (a killed process cannot clean up after itself).
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    let log = std::fs::read_to_string(&log_path).unwrap_or_default();
    assert!(
        log.contains("boot reap: leftover worker"),
        "the boot reap names what it cleared: {log}"
    );
    assert!(
        !worker_socket.exists(),
        "the reaped leftover's socket file left with it: {}",
        worker_socket.display()
    );

    // A clean terminal stop for the reopened session: the new daemon's
    // own worker dies with its supervisor (no leak into later tests).
    client2.send_command("bye", json!({ "type": "shutdown" }));
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(daemon2.child.id()) {
        assert!(Instant::now() < deadline, "the new supervisor never exited");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The containment rule: a daemon (and its workers) on a DIFFERENT socket
/// is never a reap target. The new daemon on socket A clears A's leftover
/// while a healthy daemon on socket B keeps serving its live session.
#[test]
fn boot_reap_never_touches_a_different_socket_daemon() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket_a = dir.path().join("daemon-a.sock");
    let socket_b = dir.path().join("daemon-b.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    // A healthy daemon on a DIFFERENT socket with one live session.
    let daemon_b = spawn_supervisor(&socket_b, &agent_dir);
    wait_socket_ready(&socket_b);
    let (mut client_b, hello_b) = Client::connect(&socket_b);
    assert_eq!(hello_b["type"], "daemon_hello");
    let (session_b, worker_b) = create_session(
        &mut client_b,
        dir.path(),
        &sessions_dir,
        daemon_b.child.id(),
        0,
    );

    // The same-socket lineage gets the leftover: kill daemon A after its
    // session's descriptor vanished.
    let mut daemon_a = spawn_supervisor(&socket_a, &agent_dir);
    wait_socket_ready(&socket_a);
    let (mut client_a, hello_a) = Client::connect(&socket_a);
    assert_eq!(hello_a["type"], "daemon_hello");
    let (session_a, worker_a) = create_session(
        &mut client_a,
        dir.path(),
        &sessions_dir,
        daemon_a.child.id(),
        1,
    );
    orphan_the_worker(&mut daemon_a, &agent_dir, &socket_a, &session_a);
    assert!(
        process_alive(worker_a),
        "the leftover survives its supervisor"
    );

    // The new daemon on socket A: it reaps A's leftover only.
    let daemon_a2 = spawn_supervisor(&socket_a, &agent_dir);
    wait_socket_ready(&socket_a);
    let deadline = Instant::now() + Duration::from_secs(15);
    while process_alive(worker_a) {
        assert!(Instant::now() < deadline, "A's leftover survived the reap");
        std::thread::sleep(Duration::from_millis(100));
    }

    // The other-socket daemon and its worker are untouched and still
    // serving: a prompt through B completes the turn.
    assert!(
        process_alive(daemon_b.child.id()),
        "the other-socket supervisor was never a reap target"
    );
    assert!(
        process_alive(worker_b),
        "the other-socket worker was never a reap target"
    );
    client_b.send_command(
        "p-b",
        json!({ "type": "prompt", "activeSessionId": session_b, "message": "go" }),
    );
    loop {
        let line = client_b.read_line();
        if line.get("id").and_then(Value::as_str) == Some("p-b") {
            assert_eq!(
                line["success"], true,
                "the other-socket session still serves: {line}"
            );
            break;
        }
    }

    // Teardown: no workers leak into later tests. Both supervisors take
    // the protocol stop (a clean terminal stop under the fixed
    // begin_shutdown), and both processes exit inside the window.
    client_b.send_command("bye-b", json!({ "type": "shutdown" }));
    client_a_send_shutdown(&socket_a);
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(daemon_b.child.id()) || process_alive(daemon_a2.child.id()) {
        assert!(
            Instant::now() < deadline,
            "the shut-down supervisors never exited"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// daemon_a2's own shutdown (the reopened session's worker dies with it).
fn client_a_send_shutdown(socket: &Path) -> Value {
    let (mut client, _) = Client::connect(socket);
    client.send_command("bye-a2", json!({ "type": "shutdown" }));
    client.read_response("bye-a2")
}
