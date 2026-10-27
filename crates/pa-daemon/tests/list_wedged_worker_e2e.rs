//! The wedged-resident list latency e2e: a resident session worker that stops
//! answering must not hold the client's `list` — the supervisor serves the
//! roster's cached summary rows instead of routing `get_state` per resident.
//! The harness drives the real public daemon protocol (unix socket, newline
//! JSON frames) against a real supervisor process with a real scripted worker.
//!
//! The reproduction is the reported desktop path: one `list {all: true}` while
//! a resident worker cannot answer (here: SIGSTOP — a live, resident, silent
//! worker). The measured phase is the client-visible wall clock of the one
//! command; the bound sits far under the supervisor's per-resident summary
//! budget the pre-fix code paid (`SUMMARY_TIMEOUT_MS = 5_000`, deleted with
//! the live routes) so the test reds exactly when the list blocks on worker
//! responsiveness.
#![allow(clippy::large_futures)]
// 64-bit-only targets; the narrowing casts sit at bounded OS boundaries.
#![allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The wall bound one `list` command must fit inside while a resident worker is
/// silent. The pre-fix stall paid the full 5 s summary budget; a served
/// catalog is scan-bound (milliseconds), so the bound catches the gate and
/// nothing else on an idle box.
const LIST_BOUND: Duration = Duration::from_secs(2);

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

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path) -> Daemon {
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // A supervisor killed at teardown must not leak its session workers: the worker's
        // supervisor-lost exit runs on this short window, not the 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
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
    panic!("supervisor socket never came up");
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Self {
        let deadline = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("connect supervisor: {error}"),
            }
        };
        let write_stream = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer: write_stream,
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn send_command(&mut self, id: &str, command: &Value) {
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

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let read = self
            .reader
            .read_line(&mut line)
            .unwrap_or_else(|error| panic!("read supervisor line: {error}"));
        assert!(read > 0, "supervisor closed the connection");
        serde_json::from_str::<Value>(line.trim_end()).expect("supervisor line parses")
    }

    /// One `list` command's measured wall clock: the response for `id`, and
    /// how long the client waited for it.
    fn timed_list(&mut self, id: &str, all: bool) -> (Duration, Value) {
        self.send_command(id, &json!({ "type": "list", "all": all }));
        let start = Instant::now();
        let response = self.read_response(id);
        (start.elapsed(), response)
    }

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(70);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

fn write_script(dir: &Path, responses: &[&str]) -> PathBuf {
    let script_path = dir.join("script.json");
    let scripted: Vec<Value> = responses
        .iter()
        .map(|text| json!({ "text": text }))
        .collect();
    std::fs::write(&script_path, json!({ "responses": scripted }).to_string())
        .expect("write script");
    script_path
}

fn stop_process(pid: u32) {
    let status = Command::new("kill")
        .arg("-STOP")
        .arg(pid.to_string())
        .status()
        .expect("run kill -STOP");
    assert!(status.success(), "SIGSTOP {pid} failed");
}

fn cont_process(pid: u32) {
    let _ = Command::new("kill")
        .arg("-CONT")
        .arg(pid.to_string())
        .status();
}

fn force_kill(pid: u32) {
    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
}

/// Create one scripted session and run one turn to completion, so the worker
/// sits idle over a real transcript and its roster row exists (registration
/// pull + the turn's roster pushes). Returns the worker pid from the create
/// summary — the resident's own process.
fn create_idle_session(client: &mut Client, config: &Value) -> (String, u32) {
    client.send_command("create", &json!({ "type": "create", "config": config }));
    let created = client.read_response("create");
    assert_eq!(created["success"], true, "create failed: {created}");
    let summary = &created["data"];
    let id = summary["id"]
        .as_str()
        .or_else(|| summary["sessionId"].as_str())
        .expect("session id in create summary")
        .to_string();
    let worker_pid = summary["workerPid"]
        .as_u64()
        .expect("workerPid in create summary") as u32;
    client.send_command(
        "turn",
        &json!({ "type": "prompt_and_wait", "activeSessionId": id, "message": "go" }),
    );
    let done = client.read_response("turn");
    assert_eq!(done["success"], true, "scripted turn failed: {done}");
    (id, worker_pid)
}

fn resident_row<'a>(sessions: &'a [Value], id: &str) -> &'a Value {
    sessions
        .iter()
        .find(|row| row.get("id").and_then(Value::as_str) == Some(id))
        // Nothing session-shaped reaches the panic: the CodeQL
        // cleartext-logging gate flags the raw session id in it, and the
        // serialized row dump carries it too — a bare failure note names
        // the class.
        .unwrap_or_else(|| panic!("no list row for the scripted session"))
}

#[test]
fn a_silent_resident_worker_never_holds_the_list() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let mut daemon = spawn_daemon(&socket, &agent_dir);
    let mut client = Client::connect(&socket);

    let script_path = write_script(dir.path(), &["first scripted"]);
    let config = json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": sessions_dir.to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });
    let (session_id, worker_pid) = create_idle_session(&mut client, &config);
    assert!(worker_pid > 0, "the worker pid rode the create summary");

    // The healthy baseline: the same command the desktop sends, measured while
    // the resident answers. This bounds the catalog path itself (the scan), so
    // the wedged measurement below attributes its stall to the worker gate.
    let (healthy_elapsed, healthy) = client.timed_list("list-healthy", true);
    assert_eq!(healthy["success"], true, "healthy list failed: {healthy}");
    let healthy_rows = healthy["data"]["sessions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let healthy_row = resident_row(&healthy_rows, &session_id);
    assert_eq!(
        healthy_row["lifecycle"], "live",
        "the idle resident row is live: {healthy_row}"
    );

    // The wedged resident: a live worker process that stopped answering (a busy
    // or hung worker on the user's box). The supervisor still holds the resident.
    stop_process(worker_pid);

    let (wedged_elapsed, wedged) = client.timed_list("list-wedged", true);
    assert_eq!(wedged["success"], true, "wedged list failed: {wedged}");
    let rows = wedged["data"]["sessions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let wedged_row = resident_row(&rows, &session_id);
    assert_eq!(
        wedged_row["lifecycle"], "live",
        "the silent resident serves its roster row, not the offline fallback: {wedged_row}"
    );
    assert_eq!(
        wedged_row["cwd"].as_str().unwrap_or_default(),
        dir.path().to_string_lossy(),
        "the cached row keeps the session identity: {wedged_row}"
    );
    assert!(
        wedged_elapsed < LIST_BOUND,
        "one silent resident held the list for {wedged_elapsed:?} (baseline {healthy_elapsed:?})"
    );

    // Cleanup: a stopped process cannot act on SIGTERM — resume it so the
    // teardown paths reach it, then end it deterministically.
    cont_process(worker_pid);
    force_kill(worker_pid);
    drop(client);
    let _ = daemon.child.kill();
    let _ = daemon.child.wait();
    drop(daemon);
}
