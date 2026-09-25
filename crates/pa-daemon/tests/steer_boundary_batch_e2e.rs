//! End-to-end verifier for the multi-steer tool-boundary batching (the
//! product default, Kevin's spec): a long multi-tool-call turn parks
//! several steering messages mid-run, and at the next tool-call boundary
//! ALL of them co-deliver as ONE batched turn — one delivery
//! `agent_start`, every steer row in lane order, ONE assistant reply
//! addressing the whole batch — exactly like the abort path's armed
//! batch (`abort_and_send_queued`, which stays untouched). The TS
//! product's default (`steeringMode: "one-at-a-time"`) delivers one
//! steer per boundary; the batched-at-the-boundary default is the
//! deliberate divergence (Kevin 2026-09-23: "if we have many messages in
//! the steer queue, then ALL of them should be sent after the next tool
//! call"), with "one-at-a-time" still selectable through the same
//! setting surface. The follow-up lane never merges into the batch: it
//! drains behind it as its own turn.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The kernel Python with prime-agent-runtime installed; the release dir
/// ships the runtime sidecar. Skipped (with a note) on machines without a
/// live install.
fn kernel_python() -> Option<PathBuf> {
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!(
        "kernel python {} not found; skipping live kernel test",
        candidate.display()
    );
    None
}

fn release_dir() -> Option<PathBuf> {
    let releases = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.local/share/prime-agent/releases".to_string(),
        |home| format!("{home}/.local/share/prime-agent/releases"),
    ));
    let Ok(entries) = std::fs::read_dir(&releases) else {
        eprintln!(
        "no releases dir at {}; skipping live kernel test",
        releases.display()
    );
        return None;
    };
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("prime-agent-runtime").is_dir())
        .collect();
    candidates.sort();
    candidates.pop()
}

/// The faux provider script: the long turn's first model response calls a
/// kernel cell that sleeps (the tool-call boundary the steers queue
/// behind), and the scripted replies behind it name every delivery —
/// the batch reply for the co-delivered prefix, the drip replies for the
/// pre-fix one-per-boundary shape.
fn faux_script(dir: &Path) -> PathBuf {
    let path = dir.join("faux-script.json");
    std::fs::write(
        &path,
        json!({
            "engine": "faux",
            "modelId": "faux-1",
            "modelName": "Faux Model",
            "reasoning": false,
            "contextWindow": 128_000,
            "tokensPerSecond": 30,
            "responses": [
                {"content": [
                    {"type": "text", "text": "Running the first sleep cell."},
                    {"type": "toolCall", "name": "ipython", "id": "toolu_sleep01",
                     "arguments": {"code":
                        "import time\nopen('sleep-one-started','w').write('1')\ntime.sleep(4)\nprint('slept one')"}}
                ]},
                {"content": [{"type": "text", "text": "batch reply for all three steers"}]},
                {"content": [{"type": "text", "text": "queued reply"}]},
                {"content": [{"type": "text", "text": "queued reply"}]},
                {"content": [{"type": "text", "text": "queued reply"}]},
                {"content": [{"type": "text", "text": "queued reply"}]}
            ]
        })
        .to_string(),
    )
    .expect("write faux script");
    path
}

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
fn spawn_supervisor(socket: &Path, agent_dir: &Path, script: &Path) -> Supervisor {
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
        .env(pa_daemon::worker::WORKER_SCRIPT_ENV, script)
        .env(
            "PRIME_AGENT_KERNEL_PYTHON",
            kernel_python().expect("kernel python"),
        )
        .env("PI_PACKAGE_DIR", release_dir().expect("release dir"))
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

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    events: Vec<Value>,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = UnixStream::connect(socket).expect("connect");
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
        let deadline = Instant::now() + Duration::from_mins(1);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        loop {
            let mut line = String::new();
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

    fn request(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_mins(2);
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

    fn drain_events(&mut self, quiet_ms: Duration) {
        let deadline = Instant::now() + Duration::from_mins(1);
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

    fn send(&mut self, id: &str, command: Value) -> Value {
        self.send_command(id, command);
        self.request(id)
    }
}

/// The delivered user rows (text) and the delivery `agent_starts` after the
/// long turn's `agent_end`: the batch evidence.
#[test]
fn multi_steer_parked_mid_run_co_delivers_as_one_batched_turn() {
    let Some(_kernel) = kernel_python() else {
        return;
    };
    let Some(_release) = release_dir() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).expect("work dir");
    let script = faux_script(dir.path());
    let socket = dir.path().join("steer-batch.sock");
    let supervisor = spawn_supervisor(&socket, &agent_dir, &script);
    let mut client = Client::connect(&socket);
    let created = client.send(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": cwd.to_string_lossy(),
                "model": "faux-1",
            },
        }),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    let attached = client.send(
        "a1",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // The long turn starts: its first model response runs the sleep cell.
    let started = client.send(
        "p1",
        json!({ "type": "prompt", "activeSessionId": session_id, "message": "run the sleeps" }),
    );
    assert_eq!(started["success"], true, "prompt failed: {started}");
    // Park the steers strictly mid-tool: the cell writes its start marker,
    // then sleeps — every steer lands while the tool call runs.
    let marker = cwd.join("sleep-one-started");
    let deadline = Instant::now() + Duration::from_mins(3);
    while Instant::now() < deadline {
        if marker.exists() {
            break;
        }
        client.drain_events(Duration::from_millis(300));
    }
    assert!(
        marker.exists(),
        "the sleep cell never started; events: {:#?}",
        client.events
    );
    for (id, message) in [
        ("s1", "steer one"),
        ("s2", "steer two"),
        ("s3", "steer three"),
    ] {
        let steered = client.send(
            id,
            json!({ "type": "steer", "activeSessionId": session_id, "message": message }),
        );
        assert_eq!(steered["success"], true, "{id} failed: {steered}");
    }
    // The follow-up parks behind the steering lane (never merges in).
    let follow = client.send(
        "f1",
        json!({ "type": "follow_up", "activeSessionId": session_id, "message": "follow up last" }),
    );
    assert_eq!(follow["success"], true, "follow_up failed: {follow}");

    // Drain until the wire is quiet AND the follow-up row landed (the
    // follow-up lane delivers behind the steering lane, so its row plus a
    // quiet wire means the queue fully drained — true under either
    // delivery shape).
    let settled = Instant::now() + Duration::from_mins(3);
    loop {
        let before = client.events.len();
        client.drain_events(Duration::from_millis(500));
        let drained_quiet = client.events.len() == before;
        let texts = event_texts(&client.events);
        if drained_quiet && texts.iter().any(|text| text == "follow up last") {
            break;
        }
        assert!(
            Instant::now() < settled,
            "the queue never drained; events: {:#?}",
            event_types(&client.events)
        );
    }
    client.drain_events(Duration::from_secs(2));

    // The tool boundary ended the long turn (the queued steer owns the
    // stop hook) and the parked prefix delivered: the delivery window is
    // everything after the long turn's first agent_end.
    let types = event_types(&client.events);
    let first_agent_end = types
        .iter()
        .position(|t| t == "agent_end")
        .expect("the long turn settled");
    let delivery = &types[first_agent_end + 1..];

    // THE SPEC: one delivery agent_start for the whole batch (not one
    // per steer — the drip-feed), then the follow-up's own turn.
    let agent_starts: usize = delivery
        .iter()
        .filter(|t| *t == &"agent_start".to_string())
        .count();
    assert_eq!(
        agent_starts, 2,
        "the steer batch runs as ONE turn, the follow-up as its own: {delivery:?}"
    );

    // The three steers co-delivered as consecutive user rows of the one
    // batched turn, followed by ONE assistant reply addressing the batch
    // — then the follow-up row and its own reply.
    let texts = event_texts(&client.events);
    let steer_one = texts
        .iter()
        .position(|t| t == "steer one")
        .expect("steer one delivered");
    assert_eq!(
        &texts[steer_one..steer_one + 3],
        &[
            "steer one".to_string(),
            "steer two".to_string(),
            "steer three".to_string()
        ],
        "the steers co-delivered as one chained batch: {texts:?}"
    );
    assert_eq!(
        texts[steer_one + 3],
        "batch reply for all three steers",
        "ONE assistant reply addresses the whole batch: {texts:?}"
    );
    assert_eq!(
        texts[steer_one + 4],
        "follow up last",
        "the follow-up delivers behind the batch, never merged: {texts:?}"
    );
    let rows = event_rows(&client.events);
    let follow_up_at = rows
        .iter()
        .position(|(role, text)| role == "user" && text == "follow up last")
        .expect("the follow-up row delivered");
    assert_eq!(
        rows[follow_up_at + 1].0,
        "assistant",
        "the follow-up's own turn carries its own reply: {rows:?}"
    );
    drop(supervisor);
}

fn event_types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// The (role, text) of every `message_end` row, in wire order — the
/// delivered-message trace (user rows and assistant replies).
fn event_rows(events: &[Value]) -> Vec<(String, String)> {
    events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("message_end"))
        .filter_map(|event| {
            let message = event.get("message")?;
            let role = message.get("role").and_then(Value::as_str)?;
            let text = match message.get("content") {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Array(blocks)) => blocks
                    .iter()
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            };
            Some((role.to_string(), text))
        })
        .collect()
}

/// The flat text of every delivered user/assistant row, in wire order —
/// the delivery trace (tool results stay out of the positional asserts).
fn event_texts(events: &[Value]) -> Vec<String> {
    event_rows(events)
        .into_iter()
        .filter(|(role, _)| role == "user" || role == "assistant")
        .map(|(_, text)| text)
        .collect()
}
