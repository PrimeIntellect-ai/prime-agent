//! Supervisor wire-shape tests for the protocol-breadth waves b6-b9
//! (roadmap item 7): every new command
//! rides the real supervisor + worker over the socket and answers the
//! exact TS wire shape (success and error paths), the same harness the
//! supervisor e2e suite uses.
// Pedantic-gate dispositions (fleet-uniform ruling; see this lane's PR for
// the full rationale).
// Stack-resident futures by design on the daemon's hot paths; boxing the
// call sites for a lint tick is a perf regression with zero correctness gain.
#![allow(clippy::large_futures)]
// 64-bit-only targets; the narrowing casts sit at OS boundaries
// (pid/fd/time/size) where the values are bounded by the kernel - the
// dead-guard expect()s would add panic paths where silent wrap was
// deliberate.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// The fn-length threshold is a style gate, not correctness; the structure
// campaign owns the god-fn splits as a follow-up.
#![allow(clippy::too_many_lines)]
// API-shape opinions, not defects; the surfaces are deliberate.
#![allow(
    clippy::unnecessary_wraps,
    clippy::zero_sized_map_values,
    clippy::struct_excessive_bools,
    clippy::struct_field_names
)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
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
fn spawn_daemon(socket: &std::path::Path, agent_dir: &std::path::Path) -> Daemon {
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
        // into later test binaries: the worker's supervisor-lost exit (TS
        // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
        // instead of the 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket.exists() {
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

#[allow(dead_code)]
impl Client {
    fn connect(socket: &std::path::Path) -> (Self, serde_json::Value) {
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
        (client, hello)
    }

    fn send(&mut self, value: &serde_json::Value) {
        let mut line = serde_json::to_string(value).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn send_command(&mut self, id: &str, command: serde_json::Value) {
        self.send(&serde_json::json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }));
    }

    fn read_line(&mut self) -> serde_json::Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(15);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => {
                    return serde_json::from_str(line.trim()).expect("parse response line");
                }
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    /// Read lines until one answers the given command id.
    fn read_response(&mut self, id: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return line;
            }
        }
    }

    /// Read until the response for `id`, buffering the outbound lines seen
    /// first: the daemon emits events before the command reply (TS order),
    /// so a bare `read_response` would discard them.
    fn read_response_and_lines(
        &mut self,
        id: &str,
    ) -> (
        serde_json::Value,
        std::collections::VecDeque<serde_json::Value>,
    ) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut lines = std::collections::VecDeque::new();
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return (line, lines);
            }
            lines.push_back(line);
        }
    }

    /// The first buffered-or-live outbound line of `line_type`. Buffered
    /// lines of other types stay buffered; live lines of other types are
    /// skipped, like a filtering read loop.
    fn next_line_of_type(
        &mut self,
        lines: &mut std::collections::VecDeque<serde_json::Value>,
        line_type: &str,
    ) -> serde_json::Value {
        if let Some(index) = lines.iter().position(|l| l["type"] == line_type) {
            return lines.remove(index).expect("indexed line");
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no {line_type} line arrived");
            let line = self.read_line();
            if line["type"] == line_type {
                return line;
            }
        }
    }

    /// The first buffered-or-live `session_event` of `event_type`.
    fn take_session_event(
        &mut self,
        lines: &mut std::collections::VecDeque<serde_json::Value>,
        event_type: &str,
    ) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no {event_type} event arrived");
            let line = self.next_line_of_type(lines, "session_event");
            if line["event"]["type"] == event_type {
                return line["event"].clone();
            }
        }
    }
}

/// The wave tests spawn real supervisor + worker process trees; the box
/// is small, so one daemon tree runs at a time (a test binary's tests
/// otherwise race each other's process startup windows).
static SERIAL: Mutex<()> = Mutex::new(());

fn serial_lock() -> std::sync::MutexGuard<'static, ()> {
    match SERIAL.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Create one scripted session; returns (daemon, client, session id,
/// socket path).
fn scripted_session(
    dir: &std::path::Path,
    agent_dir: &std::path::Path,
) -> (Daemon, Client, String, std::path::PathBuf) {
    let socket = dir.join("daemon.sock");
    let daemon = spawn_daemon(&socket, agent_dir);
    let (mut client, _hello) = Client::connect(&socket);
    let script_path = dir.join("script.json");
    std::fs::write(
        &script_path,
        json!({ "responses": [ { "text": "ack", "delayMs": 10 } ] }).to_string(),
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
    (daemon, client, session_id, socket)
}

/// Wave b10: the scheduling catalog rides the supervisor route and answers
/// the TS wire shapes against a live scripted session.
#[test]
fn wave_b10_scheduling_wire_shapes() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let (_daemon, mut client, session_id, _socket) = scripted_session(dir.path(), &agent_dir);

    // cron_add: the TS job wire object (source "cron", the live session
    // identity, the parsed one-shot schedule, a next run).
    client.send_command(
        "c1",
        json!({
            "type": "cron_add", "activeSessionId": session_id,
            "schedule": "in 10m", "prompt": "run me"
        }),
    );
    let response = client.read_response("c1");
    assert_eq!(response["success"], true, "{response}");
    let job = response["data"]["job"].clone();
    assert_eq!(job["status"], "active");
    assert_eq!(job["source"], "cron");
    assert_eq!(job["runtimeKind"], "top-level");
    assert_eq!(job["activeSessionId"], session_id.as_str());
    assert_eq!(job["schedule"]["kind"], "once");
    assert_eq!(job["prompt"], "run me");
    assert!(job["nextRunAt"].is_string(), "{job}");
    let job_id = job["id"].as_str().expect("job id").to_string();

    // cron_list (selector form): the job.
    client.send_command(
        "c2",
        json!({ "type": "cron_list", "activeSessionId": session_id }),
    );
    let response = client.read_response("c2");
    assert_eq!(response["success"], true, "{response}");
    let jobs = response["data"]["jobs"].as_array().expect("jobs");
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_eq!(jobs[0]["id"], job_id.as_str());

    // cron_list (selector-less): the supervisor merge over the live
    // worker plus the passive catalog.
    client.send_command("c3", json!({ "type": "cron_list" }));
    let response = client.read_response("c3");
    assert_eq!(response["success"], true, "{response}");
    let jobs = response["data"]["jobs"].as_array().expect("jobs");
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_eq!(jobs[0]["id"], job_id.as_str());

    // heartbeats_list before any heartbeat: the empty catalog.
    client.send_command("h0", json!({ "type": "heartbeats_list" }));
    let response = client.read_response("h0");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"]["heartbeats"], json!([]));

    // heartbeat_set: the TS heartbeat job (source "heartbeat", the
    // requested delivery mode).
    client.send_command(
        "h1",
        json!({
            "type": "heartbeat_set", "activeSessionId": session_id,
            "schedule": "every 10m", "prompt": "check in",
            "deliveryMode": "follow_up"
        }),
    );
    let response = client.read_response("h1");
    assert_eq!(response["success"], true, "{response}");
    let heartbeat = response["data"]["heartbeat"].clone();
    assert_eq!(heartbeat["source"], "heartbeat");
    assert_eq!(heartbeat["status"], "active");
    assert_eq!(heartbeat["deliveryMode"], "follow_up");
    let heartbeat_id = heartbeat["id"].as_str().expect("heartbeat id").to_string();

    // heartbeat_get: the session's heartbeat.
    client.send_command(
        "h2",
        json!({ "type": "heartbeat_get", "activeSessionId": session_id }),
    );
    let response = client.read_response("h2");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"]["heartbeat"]["id"], heartbeat_id.as_str());

    // heartbeats_list: the merged catalog row ({ job, sessionName?,
    // firstMessage? }).
    client.send_command("h3", json!({ "type": "heartbeats_list" }));
    let response = client.read_response("h3");
    assert_eq!(response["success"], true, "{response}");
    let heartbeats = response["data"]["heartbeats"].as_array().expect("rows");
    assert_eq!(heartbeats.len(), 1, "{heartbeats:?}");
    assert_eq!(heartbeats[0]["job"]["id"], heartbeat_id.as_str());

    // heartbeat_update (pause): the paused heartbeat.
    client.send_command(
        "h4",
        json!({
            "type": "heartbeat_update", "activeSessionId": session_id,
            "action": "pause"
        }),
    );
    let response = client.read_response("h4");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"]["heartbeat"]["status"], "paused");

    // heartbeat_manage (resume): the active heartbeat again.
    client.send_command(
        "h5",
        json!({
            "type": "heartbeat_manage", "activeSessionId": session_id,
            "jobId": heartbeat_id, "action": "resume"
        }),
    );
    let response = client.read_response("h5");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"]["heartbeat"]["status"], "active");

    // heartbeat_manage (stop): the cancelled heartbeat.
    client.send_command(
        "h6",
        json!({
            "type": "heartbeat_manage", "activeSessionId": session_id,
            "jobId": heartbeat_id, "action": "stop"
        }),
    );
    let response = client.read_response("h6");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"]["heartbeat"]["status"], "cancelled");

    // heartbeat_get with no live heartbeat: null (TS `?? null`).
    client.send_command(
        "h7",
        json!({ "type": "heartbeat_get", "activeSessionId": session_id }),
    );
    let response = client.read_response("h7");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"]["heartbeat"], Value::Null);

    // cron_cancel (selector-less): the supervisor finds the owning
    // worker and cancels through it.
    client.send_command("c4", json!({ "type": "cron_cancel", "jobId": job_id }));
    let response = client.read_response("c4");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"]["job"]["status"], "cancelled");

    // cron_cancel of an unknown job: the TS error.
    client.send_command("c5", json!({ "type": "cron_cancel", "jobId": "ghost-job" }));
    let response = client.read_response("c5");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(response["error"], "No cron job found: ghost-job");

    // heartbeat_manage of an unknown job: the TS error.
    client.send_command(
        "h8",
        json!({
            "type": "heartbeat_manage", "activeSessionId": session_id,
            "jobId": "ghost-beat", "action": "pause"
        }),
    );
    let response = client.read_response("h8");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(response["error"], "No active heartbeat found: ghost-beat");
}

/// Wave b10: a scheduled once job actually fires into the session and the
/// run bookkeeping lands in the catalog (the scheduler's
/// claim-dispatch-record loop through the worker's queue).
#[test]
fn wave_b10_scheduled_prompt_fires() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let (_daemon, mut client, session_id, _socket) = scripted_session(dir.path(), &agent_dir);

    // A one-shot `at` schedule a couple of seconds out (the `in` form
    // takes no seconds unit).
    let at = format!(
        "at {}",
        pa_daemon::util::iso_from_unix_ms(pa_daemon::util::now_ms() + 2500)
    );
    client.send_command(
        "f1",
        json!({
            "type": "cron_add", "activeSessionId": session_id,
            "schedule": at, "prompt": "fire me"
        }),
    );
    let response = client.read_response("f1");
    assert_eq!(response["success"], true, "{response}");
    let job_id = response["data"]["job"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    // The once job fires, its turn settles, and the catalog records the
    // run (completed, runCount 1, lastRunAt).
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(
            Instant::now() < deadline,
            "the scheduled prompt never fired"
        );
        client.send_command(
            "f2",
            json!({
                "type": "cron_list", "activeSessionId": session_id,
                "includeInactive": true
            }),
        );
        let response = client.read_response("f2");
        assert_eq!(response["success"], true, "{response}");
        let jobs = response["data"]["jobs"].as_array().expect("jobs");
        let job = jobs
            .iter()
            .find(|job| job["id"].as_str() == Some(job_id.as_str()))
            .expect("job listed");
        if job["status"] == "completed" {
            assert_eq!(job["runCount"], 1, "{job}");
            assert!(job["lastRunAt"].is_string(), "{job}");
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Wave b10 selector-less catalog shapes on a fresh supervisor (no live
/// workers): the TS empty-catalog objects and the routing refusals.
#[test]
fn wave_b10_fresh_supervisor_catalog() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = dir.path().join("daemon.sock");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);

    client.send_command("s1", json!({ "type": "cron_list" }));
    let response = client.read_response("s1");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"], json!({ "jobs": [] }));

    client.send_command("s2", json!({ "type": "heartbeats_list" }));
    let response = client.read_response("s2");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"], json!({ "heartbeats": [] }));

    client.send_command("s3", json!({ "type": "cron_cancel", "jobId": "ghost-job" }));
    let response = client.read_response("s3");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(response["error"], "No cron job found: ghost-job");

    client.send_command(
        "s4",
        json!({
            "type": "heartbeat_manage", "activeSessionId": "bogus-1",
            "jobId": "j", "action": "pause"
        }),
    );
    let response = client.read_response("s4");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(response["error"], "Unknown active session: bogus-1");

    client.send_command(
        "s5",
        json!({
            "type": "cron_add", "activeSessionId": "bogus-1",
            "schedule": "every 10m", "prompt": "hi"
        }),
    );
    let response = client.read_response("s5");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(response["error"], "Unknown active session: bogus-1");
}

/// Wave b11: the saved-session catalog and peer-roster wire shapes -
/// the fresh-supervisor error paths, the offline rename/delete, and the
/// live-session rename.
#[test]
fn wave_b11_saved_sessions_wire_shapes() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");

    // A fresh supervisor: the unknown-path and auth error paths.
    {
        let socket = dir.path().join("daemon.sock");
        let _daemon = spawn_daemon(&socket, &agent_dir);
        let (mut client, _hello) = Client::connect(&socket);

        client.send_command(
            "r0",
            json!({
                "type": "rename_saved_session",
                "sessionPath": "/tmp/does-not-exist-xyz.jsonl",
                "name": "renamed"
            }),
        );
        let response = client.read_response("r0");
        assert_eq!(response["success"], false, "{response}");
        assert_eq!(
            response["error"],
            "Session not found: /tmp/does-not-exist-xyz.jsonl"
        );

        client.send_command(
            "d0",
            json!({
                "type": "delete_saved_session",
                "sessionPath": "/tmp/does-not-exist-xyz.jsonl"
            }),
        );
        let response = client.read_response("d0");
        // The delete answers the TS DeleteSessionFileResult failure
        // object (success with ok:false).
        assert_eq!(response["success"], true, "{response}");
        assert_eq!(response["data"]["ok"], false, "{response}");

        client.send_command("p0", json!({ "type": "list_agent_peers" }));
        let response = client.read_response("p0");
        assert_eq!(response["success"], false, "{response}");
        assert_eq!(response["error"], "Worker authentication failed");
    }

    // A live session plus a saved one: the offline rename/delete and the
    // live rename.
    let (_daemon, mut client, session_id, _socket) = scripted_session(dir.path(), &agent_dir);
    let live_file = {
        // The live session's file: read it off the worker's state.
        client.send_command(
            "g0",
            json!({ "type": "get_state", "activeSessionId": session_id }),
        );
        let response = client.read_response("g0");
        assert_eq!(response["success"], true, "{response}");
        response["data"]["sessionFile"]
            .as_str()
            .expect("session file")
            .to_string()
    };

    // A second, saved session in the catalog.
    let saved_path = {
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
        let mut session = pa_daemon::session_store::SessionFile::create(
            dir.path().to_string_lossy().as_ref(),
            None,
            0,
        );
        let path = sessions_dir.join(pa_daemon::session_store::session_file_name(
            session.session_id(),
        ));
        session.set_path(path.clone());
        session.rewrite().expect("write saved session");
        path
    };

    // The offline rename: the session_info entry lands in the file.
    client.send_command(
        "r1",
        json!({
            "type": "rename_saved_session",
            "sessionPath": saved_path.to_string_lossy(),
            "name": "renamed"
        }),
    );
    let response = client.read_response("r1");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"], Value::Null, "{response}");
    let info =
        pa_daemon::session_store::read_session_info(&saved_path).expect("saved session readable");
    assert_eq!(info.name.as_deref(), Some("renamed"));

    // The offline delete: the file and its artifact partition go.
    client.send_command(
        "d1",
        json!({
            "type": "delete_saved_session",
            "sessionPath": saved_path.to_string_lossy()
        }),
    );
    let response = client.read_response("d1");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"]["ok"], true, "{response}");
    assert!(!saved_path.is_file(), "saved session deleted");

    // The live rename: the owning worker's arm answers the TS no-data
    // success and the live name follows.
    client.send_command(
        "r2",
        json!({
            "type": "rename_saved_session",
            "activeSessionId": session_id,
            "sessionPath": live_file,
            "name": "live name"
        }),
    );
    let response = client.read_response("r2");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"], Value::Null, "{response}");
    client.send_command(
        "g1",
        json!({ "type": "get_state", "activeSessionId": session_id }),
    );
    let response = client.read_response("g1");
    assert_eq!(response["success"], true, "{response}");
    assert_eq!(response["data"]["sessionName"], "live name", "{response}");

    // The active session refuses the delete.
    client.send_command(
        "d2",
        json!({
            "type": "delete_saved_session",
            "sessionPath": live_file
        }),
    );
    let response = client.read_response("d2");
    assert_eq!(response["success"], false, "{response}");
    assert_eq!(
        response["error"],
        "Cannot delete the currently active session"
    );
}

/// The heartbeat-catalog snapshot fallback (TS `worker.heartbeatSnapshot`):
/// a worker too busy to answer a fresh `heartbeats_list` serves its
/// last-good rows, so a slow turn cannot empty the merged catalog while its
/// scheduler keeps firing. A worker whose snapshot went stale (its own
/// `heartbeats_changed` since the snapshot) fails the response instead (TS
/// `failed`), which is the client's keep-the-last-catalog signal.
#[test]
fn wave_b10_heartbeat_snapshot_fallback() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let (_daemon, mut client, session_id, _socket) = scripted_session(dir.path(), &agent_dir);

    // One live heartbeat, then a good catalog read: the worker's snapshot
    // holds the row.
    client.send_command(
        "s1",
        json!({
            "type": "heartbeat_set", "activeSessionId": session_id,
            "schedule": "every 10m", "prompt": "check in"
        }),
    );
    let response = client.read_response("s1");
    assert_eq!(response["success"], true, "{response}");
    client.send_command("s2", json!({ "type": "heartbeats_list" }));
    let response = client.read_response("s2");
    assert_eq!(response["success"], true, "{response}");
    let heartbeats = response["data"]["heartbeats"].as_array().expect("rows");
    assert_eq!(heartbeats.len(), 1, "{heartbeats:?}");

    // Freeze the worker: the supervisor's 5s forward cannot answer, and the
    // last-good snapshot keeps the row in the merged catalog.
    let pid = worker_pid(&agent_dir);
    stop(pid);
    client.send_command("s3", json!({ "type": "heartbeats_list" }));
    let response = client.read_response("s3");
    assert_eq!(response["success"], true, "{response}");
    let heartbeats = response["data"]["heartbeats"].as_array().expect("rows");
    assert_eq!(heartbeats.len(), 1, "{heartbeats:?}");
    assert_eq!(heartbeats[0]["job"]["prompt"], "check in");
    cont(pid);

    // A worker-side mutation marks the snapshot stale; a frozen worker then
    // fails the response instead of serving the stale rows (TS `failed`).
    client.send_command(
        "s4",
        json!({
            "type": "heartbeat_update", "activeSessionId": session_id,
            "action": "pause"
        }),
    );
    let response = client.read_response("s4");
    assert_eq!(response["success"], true, "{response}");
    stop(pid);
    client.send_command("s5", json!({ "type": "heartbeats_list" }));
    let response = client.read_response("s5");
    assert_eq!(response["success"], false, "{response}");
    cont(pid);
}

/// TS #2487, the single-worker catalog: the served slice is the worker's
/// own answer, so the merged `heartbeats_list`/`cron_list` responses are
/// byte-identical to the fresh-forward catalog while a re-consult is
/// unnecessary — a frozen worker between two lists still answers through
/// its slice, and the two responses match row for row.
#[test]
fn wave_b10_single_worker_slice_is_byte_identical() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let (_daemon, mut client, session_id, _socket) = scripted_session(dir.path(), &agent_dir);
    client.send_command(
        "add",
        json!({
            "type": "cron_add", "activeSessionId": session_id,
            "schedule": "in 10m", "prompt": "run me"
        }),
    );
    let response = client.read_response("add");
    assert_eq!(response["success"], true, "{response}");
    client.send_command(
        "set",
        json!({
            "type": "heartbeat_set", "activeSessionId": session_id,
            "schedule": "every 10m", "prompt": "check in"
        }),
    );
    let response = client.read_response("set");
    assert_eq!(response["success"], true, "{response}");

    client.send_command("fresh1", json!({ "type": "heartbeats_list" }));
    let first = client.read_response("fresh1");
    assert_eq!(first["success"], true, "{first}");
    client.send_command("cron1", json!({ "type": "cron_list" }));
    let first_cron = client.read_response("cron1");
    assert_eq!(first_cron["success"], true, "{first_cron}");

    // Freeze the worker: the served slices answer both catalogs fast, and
    // the responses are byte-identical to the fresh-forward ones.
    let pid = worker_pid(&agent_dir);
    stop(pid);
    let started = Instant::now();
    client.send_command("fresh2", json!({ "type": "heartbeats_list" }));
    let second = client.read_response("fresh2");
    let served = started.elapsed();
    assert_eq!(second["success"], true, "{second}");
    assert_eq!(second["data"], first["data"], "slice != fresh forward");
    assert!(
        served < Duration::from_secs(2),
        "a re-forward would hold the 5s timeout: {served:?}"
    );
    client.send_command("cron2", json!({ "type": "cron_list" }));
    let second_cron = client.read_response("cron2");
    assert_eq!(second_cron["success"], true, "{second_cron}");
    assert_eq!(
        second_cron["data"], first_cron["data"],
        "slice != fresh forward"
    );
    cont(pid);
}

/// TS #2487: the supervisor serves each worker's own catalog slice from its
/// snapshot instead of forwarding every request to every worker — a
/// `heartbeats_list` consults a worker at most once per generation. Two
/// live workers each own a heartbeat; the merged catalog carries both
/// slices; a second list serves both from the slices (the workers are not
/// re-consulted — a frozen worker that cannot answer a fresh forward still
/// appears through its slice, so the round answers fast instead of waiting
/// out the 5s catalog-forward timeout); a worker-side mutation bumps that
/// worker's generation, so the next list consults it again (a frozen
/// worker with no fresh slice fails the response, TS `failed`, instead of
/// serving the pre-mutation rows).
#[test]
fn wave_b10_catalog_slices_served_without_reforwarding() {
    let _serial = serial_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = dir.path().join("daemon.sock");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client_a, _hello_a) = Client::connect(&socket);
    let (mut client_b, _hello_b) = Client::connect(&socket);
    let session_a = create_scripted_session(&mut client_a, &agent_dir, dir.path(), "a");
    let session_b = create_scripted_session(&mut client_b, &agent_dir, dir.path(), "b");
    for (client, session, suffix) in [
        (&mut client_a, &session_a, "a"),
        (&mut client_b, &session_b, "b"),
    ] {
        client.send_command(
            "set",
            json!({
                "type": "heartbeat_set", "activeSessionId": session,
                "schedule": "every 10m", "prompt": format!("check in {suffix}")
            }),
        );
        let response = client.read_response("set");
        assert_eq!(response["success"], true, "{response}");
    }

    // The merged catalog carries each worker's own slice.
    client_a.send_command("list1", json!({ "type": "heartbeats_list" }));
    let response = client_a.read_response("list1");
    assert_eq!(response["success"], true, "{response}");
    let prompts = heartbeat_prompts(&response);
    assert_eq!(prompts.len(), 2, "{prompts:?}");
    assert!(
        prompts.iter().any(|prompt| prompt == "check in a"),
        "{prompts:?}"
    );
    assert!(
        prompts.iter().any(|prompt| prompt == "check in b"),
        "{prompts:?}"
    );

    // Both slices serve without re-consulting: both workers frozen, the
    // second list still answers fast (each frozen worker would hold the
    // 5s catalog-forward timeout on a fresh forward).
    let pid_a = worker_pid(&agent_dir);
    let pid_b = second_worker_pid(&agent_dir, pid_a);
    stop(pid_a);
    stop(pid_b);
    let started = Instant::now();
    client_a.send_command("list2", json!({ "type": "heartbeats_list" }));
    let response = client_a.read_response("list2");
    let served = started.elapsed();
    assert_eq!(response["success"], true, "{response}");
    let prompts = heartbeat_prompts(&response);
    assert_eq!(prompts.len(), 2, "{prompts:?}");
    assert!(
        served < Duration::from_secs(2),
        "a re-forward to a frozen worker would hold the 5s timeout: {served:?}"
    );

    // A worker-side mutation bumps that worker's generation: its slice is
    // stale, so the next list consults it again — the frozen mutated
    // worker fails the response (TS `failed`), not the stale pre-mutation
    // rows.
    cont(pid_a);
    cont(pid_b);
    client_b.send_command(
        "pause",
        json!({
            "type": "heartbeat_update", "activeSessionId": session_b,
            "action": "pause"
        }),
    );
    let response = client_b.read_response("pause");
    assert_eq!(response["success"], true, "{response}");
    stop(pid_a);
    stop(pid_b);
    client_a.send_command("list3", json!({ "type": "heartbeats_list" }));
    let response = client_a.read_response("list3");
    assert_eq!(response["success"], false, "{response}");
    cont(pid_a);
    cont(pid_b);
}

/// The paused/active prompts in a merged `heartbeats_list` response.
fn heartbeat_prompts(response: &Value) -> Vec<String> {
    response["data"]["heartbeats"]
        .as_array()
        .expect("rows")
        .iter()
        .filter_map(|heartbeat| heartbeat["job"]["prompt"].as_str().map(str::to_string))
        .collect()
}

/// A second resident worker's pid (distinct from `first`).
fn second_worker_pid(agent_dir: &std::path::Path, first: u32) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let mut pids = Vec::new();
        for entry in std::fs::read_dir(agent_dir.join("daemon-workers")).expect("dir") {
            let Ok(entry) = entry else { continue };
            for descriptor in std::fs::read_dir(entry.path()).expect("worker dir") {
                let Ok(descriptor) = descriptor else { continue };
                let path = descriptor.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(value): Result<Value, _> = serde_json::from_str(&text) else {
                    continue;
                };
                if let Some(pid) = value["pid"].as_u64().filter(|pid| *pid as u32 != first) {
                    pids.push(pid as u32);
                }
            }
        }
        if let Some(pid) = pids.first() {
            return *pid;
        }
        assert!(
            Instant::now() < deadline,
            "second worker descriptor never appeared"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Create one scripted live session on `client` (the `scripted_session`
/// helper's shape, for a second session on a shared daemon).
fn create_scripted_session(
    client: &mut Client,
    agent_dir: &std::path::Path,
    dir: &std::path::Path,
    suffix: &str,
) -> String {
    let script_path = dir.join(format!("script-{suffix}.json"));
    std::fs::write(
        &script_path,
        json!({ "responses": [ { "text": "ack", "delayMs": 10 } ] }).to_string(),
    )
    .expect("write script");
    client.send_command(
        format!("create-{suffix}").as_str(),
        json!({
            "type": "create",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response(format!("create-{suffix}").as_str());
    assert_eq!(created["success"], true, "create failed: {created}");
    created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string()
}

/// The resident worker's pid from its persisted descriptor.
fn worker_pid(agent_dir: &std::path::Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let mut paths: Vec<PathBuf> = std::fs::read_dir(agent_dir.join("daemon-workers"))
            .expect("daemon-workers dir")
            .filter_map(std::result::Result::ok)
            .filter_map(|entry| std::fs::read_dir(entry.path()).ok())
            .flatten()
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .collect();
        paths.sort();
        if let Some(path) = paths.last() {
            let descriptor: Value =
                serde_json::from_str(&std::fs::read_to_string(path).expect("descriptor read"))
                    .expect("descriptor parse");
            if let Some(pid) = descriptor["pid"].as_u64() {
                return pid as u32;
            }
        }
        assert!(
            Instant::now() < deadline,
            "worker descriptor never appeared"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn stop(pid: u32) {
    assert!(
        Command::new("kill")
            .args(["-STOP", &pid.to_string()])
            .status()
            .expect("kill -STOP")
            .success(),
        "SIGSTOP {pid} failed"
    );
}

fn cont(pid: u32) {
    assert!(
        Command::new("kill")
            .args(["-CONT", &pid.to_string()])
            .status()
            .expect("kill -CONT")
            .success(),
        "SIGCONT {pid} failed"
    );
}
