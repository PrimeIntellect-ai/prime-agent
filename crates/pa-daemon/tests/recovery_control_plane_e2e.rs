//! Control-plane priority e2e (design R3): a supervisor booting over a
//! sessions dir full of dead workers must keep the control plane
//! (hello, list) responsive while the background recovery (descriptor
//! adoption with a capped relaunch fan-out) is still running, and every
//! queued recovery must complete. The starved shape this guards against —
//! serving awaiting the recovery — would fail both halves: the hello and
//! list answers would land only after the whole pass, past the latency
//! bound, with every relaunched worker already up.
//!
//! Linux-only e2e (AF_UNIX sockets, `kill -9` semantics): compiles to
//! nothing elsewhere, like the other pa-daemon e2e verifiers.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Daemon {
    child: Child,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // A supervisor killed at teardown must not leak its session workers
        // into later test binaries: the worker's supervisor-lost exit runs
        // on this short window instead of the 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    Daemon { child }
}

/// Wait until the supervisor socket accepts connections (file existence is
/// not readiness: a restarted supervisor replaces a stale socket file).
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

/// Pids whose parent is `ppid`.
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

/// Worker ids with a registration log line at or after `since` (the
/// log line lands after the registry records the worker, so it is the
/// "routable" signal, not just a spawned process).
fn workers_registered_since(log_path: &Path, since: &str) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(log_path) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for line in content.lines() {
        let Some(rest) = line.strip_prefix('[') else {
            continue;
        };
        let Some((timestamp, message)) = rest.split_once(']') else {
            continue;
        };
        if timestamp < since {
            continue;
        }
        let message = message.trim();
        if let Some(id) = message.strip_prefix("session worker ") {
            if let Some((worker_id, tail)) = id.split_once(" re-registered (epoch") {
                if tail.contains(')') {
                    ids.push(worker_id.to_string());
                }
            } else if let Some((worker_id, tail)) = id.split_once(" registered (epoch") {
                if tail.contains(')') {
                    ids.push(worker_id.to_string());
                }
            }
        }
    }
    ids
}

fn distinct(values: Vec<String>) -> Vec<String> {
    let mut values = values;
    values.sort();
    values.dedup();
    values
}

/// `kill -9` an arbitrary pid: the harness only holds Child handles for
/// the supervisors, while the workers are adopted pids on the wire.
fn kill9(pid: u32) {
    let status = Command::new("kill")
        .arg("-9")
        .arg(pid.to_string())
        .status()
        .expect("spawn kill");
    assert!(status.success(), "kill -9 {pid} failed: {status}");
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
}

/// One adoption wave relaunches at most `ADOPTION_CONCURRENCY` workers, so
/// twelve dead descriptors is three capped waves: a recovery that is
/// observably long enough to race the control plane, not just a blip.
const SESSIONS: usize = 12;

#[test]
fn control_plane_stays_responsive_while_a_large_adoption_pass_recovers() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        json!({ "responses": [ { "text": "one", "delayMs": 10 } ] }).to_string(),
    )
    .expect("write script");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // A large sessions dir: twelve scripted sessions, one worker each.
    let mut session_ids = Vec::new();
    for index in 0..SESSIONS {
        client.send_command(
            &format!("c{index}"),
            json!({
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
        session_ids.push(
            created["data"]["id"]
                .as_str()
                .or_else(|| created["data"]["sessionId"].as_str())
                .expect("session id")
                .to_string(),
        );
    }
    let supervisor_pid = daemon.child.id();
    let deadline = Instant::now() + Duration::from_mins(1);
    let worker_pids = loop {
        let children = child_pids_of(supervisor_pid);
        if children.len() == SESSIONS {
            break children;
        }
        assert!(Instant::now() < deadline, "twelve workers never spawned");
        std::thread::sleep(Duration::from_millis(50));
    };

    // The recovery workload: every worker dead, its descriptor persisted.
    daemon.child.kill().expect("kill -9 supervisor");
    let _ = daemon.child.wait();
    for pid in &worker_pids {
        kill9(*pid);
    }

    // Restart: the adoption pass must relaunch all twelve in the
    // background while serving starts immediately.
    let restart_before = pa_daemon::util::now_iso();
    let daemon2 = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let supervisor2_pid = daemon2.child.id();

    // The control plane answers mid-recovery: hello within the latency
    // bound while the pass is visibly unfinished (strictly fewer than
    // twelve relaunched children). If serving ever awaited the recovery,
    // this hello would land after the whole pass with all twelve up.
    let hello_start = Instant::now();
    let (mut client, hello) = Client::connect(&socket);
    let hello_latency = hello_start.elapsed();
    assert_eq!(hello["type"], "daemon_hello");
    assert!(
        hello_latency < Duration::from_secs(2),
        "hello starved behind the recovery: {hello_latency:?}"
    );
    assert!(
        child_pids_of(supervisor2_pid).len() < SESSIONS,
        "the recovery finished before the first hello; the responsiveness check is vacuous (children: {:?})",
        child_pids_of(supervisor2_pid)
    );

    // list answers mid-recovery too: it serves the registered rows instead
    // of queueing behind the rest of the pass.
    let list_start = Instant::now();
    client.send_command("list-mid-recovery", json!({ "type": "list" }));
    let list_response = client.read_response("list-mid-recovery");
    let list_latency = list_start.elapsed();
    assert_eq!(
        list_response["success"], true,
        "list mid-recovery failed: {list_response}"
    );
    assert!(
        list_latency < Duration::from_secs(2),
        "list starved behind the recovery: {list_latency:?}"
    );

    // Queued recoveries complete: every dead descriptor is relaunched and
    // registers within a bounded window. The wait is on registrations (the
    // log line lands after the registry records the worker), not on child
    // processes: a relaunched worker process exists before its create
    // replay finishes, and a routed command for a not-yet-registered
    // session correctly fails fast (the roster-scoped queue of spec 10.4
    // covers the update restore pass; plain-restart adoption is covered by
    // the client's reconnect retry).
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    let deadline = Instant::now() + Duration::from_mins(2);
    loop {
        if distinct(workers_registered_since(&log_path, &restart_before)).len() == SESSIONS {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the adoption pass did not re-register every session; log: {}",
            std::fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    // A routed command lands through the rebuilt roster: attach to one of
    // the recovered sessions.
    client.send_command(
        "attach-recovered",
        json!({ "type": "attach", "activeSessionId": session_ids[0] }),
    );
    let attached = client.read_response("attach-recovered");
    assert_eq!(
        attached["success"], true,
        "attach to a recovered session failed: {attached}"
    );
}
