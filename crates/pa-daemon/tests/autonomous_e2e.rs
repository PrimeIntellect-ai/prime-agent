//! End-to-end verifier for the autonomous continuation driver: a daemon
//! worker session over the scripted faux engine must, after every settled
//! turn, run the configured quality gates, inject the gate-failure
//! continuation as a durable user row, and stop the run (durable
//! `autonomous_status` stop row + wire events) when the gates pass or a
//! configured limit is reached. Limits must stop the run the same way.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Supervisor {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Supervisor {
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
            return Supervisor {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// One client connection: request/response plus every session event that
/// streamed while the response was outstanding.
struct Client {
    reader: BufReader<std::os::unix::net::UnixStream>,
    writer: std::os::unix::net::UnixStream,
    events: Vec<Value>,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = std::os::unix::net::UnixStream::connect(socket).expect("connect");
        let writer = stream.try_clone().expect("clone");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
            events: Vec::new(),
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_mins(2);
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
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize");
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .unwrap_or_else(|error| panic!("write command {id}: {error}"));
    }

    /// The response for `id`, with every session event observed on the way.
    fn request(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_mins(3);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
            self.collect_event(&line);
        }
    }

    fn collect_event(&mut self, line: &Value) {
        if line.get("type").and_then(Value::as_str) == Some("session_event") {
            self.events.push(line["event"].clone());
        }
    }

    /// Drain pending session events until the socket stays quiet for
    /// `quiet_ms` (the supervisor buffers a routed command's events).
    fn drain_events(&mut self, quiet_ms: Duration) {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut last_line = Instant::now();
        loop {
            assert!(Instant::now() < deadline, "event drain timed out");
            let mut line = String::new();
            self.reader
                .get_mut()
                .set_read_timeout(Some(Duration::from_millis(100)))
                .expect("timeout");
            match self.reader.read_line(&mut line) {
                Ok(0) => return,
                Ok(_) => {
                    let value: Value = serde_json::from_str(line.trim()).expect("parse line");
                    self.collect_event(&value);
                    last_line = Instant::now();
                }
                Err(_) => {
                    if last_line.elapsed() >= quiet_ms {
                        return;
                    }
                }
            }
        }
    }
}

/// The harness: a supervisor, a faux-scripted session over the real agent
/// engine, and the counter file the quality gate advances.
struct Harness {
    dir: tempfile::TempDir,
    _supervisor: Supervisor,
    client: Client,
    session_id: String,
    gate: String,
}

fn setup(name: &str, responses: Value) -> Harness {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let script = dir.path().join("faux.json");
    std::fs::write(
        &script,
        json!({ "engine": "faux", "responses": responses }).to_string(),
    )
    .expect("write faux script");
    // The gate consults a counter file in the temp dir (absolute paths: the
    // engine's cwd is the worker process cwd, not the session cwd). It fails
    // the first consult (0 >= 1 is false) and passes from the second on.
    let counter = dir.path().join("gate-count");
    let gate = format!(
        "n=$(cat {0} 2>/dev/null || echo 0); echo $((n+1)) > {0}; [ $n -ge 1 ]",
        counter.display()
    );
    let socket = dir.path().join(format!("{name}.sock"));
    let supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);
    client.send_command(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
            },
        }),
    );
    let created = client.request("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string();
    client.send_command(
        "a1",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.request("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    Harness {
        dir,
        _supervisor: supervisor,
        client,
        session_id,
        gate,
    }
}

impl Harness {
    /// Run one prompt to completion and drain its events.
    fn prompt(&mut self, id: &str, message: &str) {
        self.client.send_command(
            id,
            json!({
                "type": "prompt_and_wait",
                "activeSessionId": self.session_id,
                "message": message,
            }),
        );
        let done = self.client.request(id);
        assert_eq!(done["success"], true, "prompt {id} failed: {done}");
        self.client.drain_events(Duration::from_secs(1));
    }

    /// The session file's JSONL entries (the only session in the dir).
    fn session_entries(&self) -> Vec<Value> {
        let session_dir = self.dir.path().join("agent").join("sessions");
        let file = std::fs::read_dir(&session_dir)
            .expect("session dir readable")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
            .expect("one session file");
        std::fs::read_to_string(&file)
            .expect("session file readable")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("session entry parses"))
            .collect()
    }

    /// The wire events of one kind: `message_end` frames carrying the role.
    fn message_ends(&self, role: &str) -> Vec<Value> {
        self.client
            .events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == role
            })
            .map(|event| event["message"].clone())
            .collect()
    }

    /// The durable `custom_message` entries of one `customType`.
    fn custom_entries(&self, custom_type: &str) -> Vec<Value> {
        self.session_entries()
            .into_iter()
            .filter(|entry| entry["type"] == "custom_message" && entry["customType"] == custom_type)
            .collect()
    }
}

/// The message's text: user/assistant rows carry content blocks, custom
/// rows a plain string.
fn text_of(message: &Value) -> String {
    match &message["content"] {
        Value::String(text) => text.clone(),
        content => content
            .as_array()
            .and_then(|blocks| blocks.first())
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

/// The durable `message` entries of one role, in order.
fn durable_messages(harness: &Harness, role: &str) -> Vec<String> {
    harness
        .session_entries()
        .into_iter()
        .filter(|entry| entry["type"] == "message" && entry["message"]["role"] == role)
        .map(|entry| text_of(&entry["message"]))
        .collect()
}

/// The durable `custom_message` rows whose content starts with `prefix`.
fn durable_autonomous_rows(harness: &Harness, prefix: &str) -> Vec<Value> {
    harness
        .custom_entries("autonomous_status")
        .into_iter()
        .filter(|entry| {
            entry["content"]
                .as_str()
                .unwrap_or_default()
                .starts_with(prefix)
        })
        .collect()
}

#[test]
fn autonomous_gate_failure_then_pass_stops_the_run_in_run() {
    let mut harness = setup(
        "gate",
        json!([{ "text": "first attempt" }, { "text": "fixed it" }]),
    );
    harness.prompt(
        "enable",
        &format!(
            "/autonomous on --max-turns 5 --gate {:?}",
            harness.gate.clone()
        ),
    );
    // The enable prompt is a session command: its durable rows are already
    // emitted and no model turn ran yet.
    assert_eq!(harness.message_ends("assistant"), Vec::<Value>::new());
    assert_eq!(
        durable_autonomous_rows(&harness, "[autonomous-status: on]").len(),
        1,
        "enable row durable"
    );

    harness.prompt("go", "build the feature");

    // Turn 1 fails the gate (counter at 0), so the driver injects the
    // gate-failure continuation; turn 2 passes the gate and the run stops.
    let assistants: Vec<String> = harness
        .message_ends("assistant")
        .iter()
        .map(text_of)
        .collect();
    assert_eq!(
        assistants,
        vec!["first attempt".to_string(), "fixed it".to_string()],
        "events: {:?}",
        harness.client.events
    );
    let user_texts: Vec<String> = harness.message_ends("user").iter().map(text_of).collect();
    assert_eq!(user_texts.len(), 2, "user rows: {user_texts:?}");
    assert_eq!(user_texts[0], "build the feature");
    assert!(
        user_texts[1].starts_with("[autonomous-continuation: gate-failed]\n\nAutonomous quality gate failed (attempt 1/3): `"),
        "gate-failure continuation: {}",
        user_texts[1]
    );
    assert!(
        user_texts[1].contains("` exited with code 1"),
        "gate exit surfaced: {}",
        user_texts[1]
    );

    // The continuation is a durable user row that reached the wire as its
    // message pair, and the gate-passed stop writes no row (the TS shape,
    // probed against the binary: the stop surfaces through the status
    // request and the headless exit contract, never the stream).
    let durable_users = durable_messages(&harness, "user");
    assert!(
        durable_users
            .iter()
            .any(|text| text.starts_with("[autonomous-continuation: gate-failed]")),
        "durable user rows: {durable_users:?}"
    );
    // The in-run ordering (the TS frame order): the continuation's user
    // row pair is preceded by the continuation turn's `turn_start`, which
    // follows the settled turn's `turn_end` with no run boundary between.
    let continuation_index = harness
        .client
        .events
        .iter()
        .position(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_end")
                && event["message"]["role"] == "user"
                && text_of(&event["message"]).starts_with("[autonomous-continuation: gate-failed]")
        })
        .expect("the continuation's wire pair");
    let preceding: Vec<&str> = harness.client.events[..continuation_index]
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .collect();
    assert_eq!(
        preceding.iter().rev().take(3).copied().collect::<Vec<_>>(),
        vec!["message_start", "turn_start", "turn_end"],
        "turn_end -> turn_start -> the continuation row, events: {:?}",
        harness.client.events
    );
    assert!(
        durable_autonomous_rows(&harness, "[autonomous-stop:").is_empty(),
        "no durable stop row"
    );
    assert!(
        harness
            .custom_entries("autonomous_status")
            .into_iter()
            .all(|entry| {
                entry["content"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("[autonomous-status:")
            }),
        "the only autonomous_status rows are the command's, events: {:?}",
        harness.client.events
    );
}

#[test]
fn autonomous_limit_reached_stops_the_run_without_a_row() {
    let mut harness = setup(
        "limit",
        json!([{ "text": "still working" }, { "text": "more work" }]),
    );
    harness.prompt(
        "enable",
        "/autonomous on --max-continuations 1 --max-turns 5",
    );
    harness.prompt("go", "build the feature");

    // Turn 1 has no terminal evidence, so it consumes the only continuation;
    // turn 2 hits the max-continuations cap and the run stops.
    let assistants: Vec<String> = harness
        .message_ends("assistant")
        .iter()
        .map(text_of)
        .collect();
    assert_eq!(
        assistants,
        vec!["still working".to_string(), "more work".to_string()]
    );
    let user_texts: Vec<String> = harness.message_ends("user").iter().map(text_of).collect();
    assert_eq!(user_texts.len(), 2, "user rows: {user_texts:?}");
    assert_eq!(user_texts[0], "build the feature");
    assert!(
        user_texts[1].starts_with("[autonomous-continuation]\n\nNo human input is available"),
        "plain continuation: {}",
        user_texts[1]
    );
    // The limit stop writes no row and no stream frame (the TS shape,
    // probed against the binary): the durable autonomous_status rows are
    // the command's alone.
    assert!(
        durable_autonomous_rows(&harness, "[autonomous-stop:").is_empty(),
        "no durable stop row"
    );
    assert!(
        harness
            .custom_entries("autonomous_status")
            .into_iter()
            .all(|entry| {
                entry["content"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("[autonomous-status:")
            }),
        "the only autonomous_status rows are the command's, events: {:?}",
        harness.client.events
    );
}
