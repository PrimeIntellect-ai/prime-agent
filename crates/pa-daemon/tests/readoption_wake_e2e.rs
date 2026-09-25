//! Re-adoption wake e2e: the wake paths of a session whose worker is
//! re-adopted across a supervisor kill -9 + relaunch.
//!
//! The bash-completion notify path (the kernel's `bash.completed` host
//! request, TS agent-session.ts's async-bash-completion handler): a
//! session starts a detached background `bash()` command, goes idle, the
//! supervisor dies and relaunches (the still-live worker is re-adopted),
//! and when the command finishes the session must WAKE — the
//! `[bash-done pid:N exit:M]` row injects as the next turn (the frozen-
//! watcher incident: the notification never woke the re-adopted
//! session). The scheduled-jobs wake (an `every 5s` heartbeat) keeps
//! firing across the same restart.
//!
//! Test A runs a live kernel (the prime-agent-runtime `bash`), so it
//! follows the live-kernel verifiers' ambient-state contract: it honors
//! `PA_E2E_KERNEL_PYTHON` and skips (with a note) on machines without a
//! kernel install. Test B is the scripted engine (no kernel).
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
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

/// The kernel Python with prime-agent-runtime installed; set
/// `PA_E2E_KERNEL_PYTHON` to point at an explicit interpreter instead.
fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_E2E_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_E2E_KERNEL_PYTHON {explicit.display()} not found"
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate.display()} not found; skipping live re-adoption wake e2e");
    None
}

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path, kernel_python: Option<&Path>) -> Daemon {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_pa-daemon"));
    command
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env_remove("PRIME_API_KEY")
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        // A supervisor killed at teardown must not leak its session
        // workers into later test binaries: the worker's supervisor-lost
        // exit runs on this short window instead of the 5-minute
        // default. The window is far wider than the restart gap below.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "20000",
        );
    if let Some(kernel_python) = kernel_python {
        command.env("PRIME_AGENT_KERNEL_PYTHON", kernel_python);
    }
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(15);
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

/// The sequential mock provider: one SSE answer per request in order
/// (the cell-start tool call, the turn-end reply, then the wake reply
/// every later request reads).
fn spawn_mock(next: &'static AtomicUsize) -> PathBuf {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = serve(stream, next);
            });
        }
    });
    PathBuf::from(url)
}

fn chunk(delta: Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-wake",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

fn serve(mut stream: TcpStream, next: &AtomicUsize) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line == "\r\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    // The scripted sequence: request 1 answers with the ipython tool
    // call that starts the detached watcher, request 2 ends the turn,
    // and every later request (the wake turn) answers with the woken
    // reply.
    let request = next.fetch_add(1, Ordering::SeqCst);
    let mut payload = String::new();
    let data = match request {
        0 => [
            chunk(
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call-wake-1",
                        "type": "function",
                        "function": {
                            "name": "ipython",
                            "arguments": "{\"code\": \"bash(\\\"sleep 12; echo RW_WAKE_DONE\\\")\\nprint('watcher armed')\"}"
                        }
                    }]
                }),
                None,
            ),
            chunk(json!({}), Some("tool_calls")),
        ],
        1 => [
            chunk(
                json!({"role": "assistant", "content": "watcher started"}),
                None,
            ),
            chunk(json!({}), Some("stop")),
        ],
        _ => [
            chunk(
                json!({"role": "assistant", "content": "woken by the bash-done notice"}),
                None,
            ),
            chunk(json!({}), Some("stop")),
        ],
    };
    for data in data {
        write!(payload, "data: {data}\n\n").expect("write to String");
    }
    payload.push_str("data: [DONE]\n\n");
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )
}

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

    fn request(&mut self, id: &str, command: Value) -> Value {
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
        let deadline = Instant::now() + Duration::from_mins(2);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    fn listed_sessions(&mut self) -> Vec<(String, String)> {
        let response = self.request("list", json!({ "type": "list" }));
        assert_eq!(response["success"], true, "list failed: {response}");
        response["data"]["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|summary| {
                (
                    summary["id"].as_str().unwrap_or_default().to_string(),
                    summary["sessionId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                )
            })
            .collect()
    }

    fn messages(&mut self, active_session_id: &str) -> String {
        let response = self.request(
            "gm",
            json!({ "type": "get_messages", "activeSessionId": active_session_id }),
        );
        assert_eq!(response["success"], true, "get_messages failed: {response}");
        serde_json::to_string(&response["data"]).expect("messages json")
    }
}

fn wait_until<T>(deadline: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + deadline;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "condition never became true");
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// One live session's create through the supervisor route.
fn create_session(client: &mut Client, id: &str, dir: &Path, agent_dir: &Path) -> (String, String) {
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let created = client.request(
        id,
        json!({
            "type": "create",
            "name": "wake-lane",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions.to_string_lossy(),
                "provider": "prime-inference",
                "model": "mock-1",
            },
        }),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
    let active_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("active session id")
        .to_string();
    let session_id = created["data"]["sessionId"]
        .as_str()
        .expect("durable session id")
        .to_string();
    (active_id, session_id)
}

#[test]
fn a_detached_bash_completion_wakes_the_idle_session_across_a_supervisor_restart() {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let root = tempfile::TempDir::new().expect("temp dir");
    let dir = root.path().to_path_buf();
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = dir.join("daemon.sock");
    let url = spawn_mock(&NEXT);
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": url.to_string_lossy(),
                    "apiKey": "sk-wake",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");

    // First generation: the session starts the detached watcher and goes
    // idle (the turn settles while `sleep 12` keeps running).
    let mut supervisor = spawn_daemon(&socket, &agent_dir, Some(&kernel_python));
    let mut client = Client::connect(&socket);
    let (active_id, session_id) = create_session(&mut client, "c1", &dir, &agent_dir);
    let started = client.request(
        "p1",
        json!({
            "type": "prompt_and_wait",
            "activeSessionId": active_id,
            "message": "start the watcher and stop",
        }),
    );
    assert_eq!(started["success"], true, "first turn failed: {started}");
    let session_file = agent_dir
        .join("sessions")
        .join(format!("{session_id}.jsonl"));
    assert!(
        supervisor
            .child
            .try_wait()
            .expect("supervisor alive")
            .is_none(),
        "the first supervisor died mid-test"
    );

    // The supervisor dies hard (kill -9: the worker process survives,
    // orphaned) and relaunches over the same socket — the adoption scan
    // re-adopts the live worker.
    drop(client);
    drop(supervisor);
    std::fs::remove_file(&socket).ok();
    let _supervisor = spawn_daemon(&socket, &agent_dir, Some(&kernel_python));
    let mut client = Client::connect(&socket);
    wait_until(Duration::from_secs(30), || {
        client
            .listed_sessions()
            .iter()
            .any(|(active, id)| *active == active_id || *id == session_id)
            .then_some(())
    });

    // THE ASSERT: the detached command finishes after the re-adoption and
    // its completion notice WAKES the idle session — the bash-done row
    // lands and the woken turn runs to its reply.
    let messages = wait_until(Duration::from_mins(1), || {
        let messages = client.messages(&active_id);
        (messages.contains("bash-done") && messages.contains("woken by the bash-done notice"))
            .then_some(messages)
    });
    assert!(
        messages.contains("[bash-done pid:"),
        "the bash-done notice never landed: {messages}"
    );
    // The durable row: the async-bash-completion custom entry persisted.
    let file = std::fs::read_to_string(&session_file).expect("session file");
    assert!(
        file.contains("async_bash_completion"),
        "the async_bash_completion row never persisted"
    );

    // Teardown: stop the session through the live supervisor so the
    // worker (and its kernel + watcher) do not leak past the test.
    client.request(
        "k1",
        json!({ "type": "kill", "activeSessionId": active_id }),
    );
}

#[test]
fn a_heartbeat_keeps_firing_across_a_supervisor_restart() {
    let root = tempfile::TempDir::new().expect("temp dir");
    let dir = root.path().to_path_buf();
    let agent_dir = dir.join("agent");
    let socket = dir.join("stop.sock");
    let script = dir.join("faux.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
            ]
        })
        .to_string(),
    )
    .expect("write faux script");

    // First generation: a scripted session with a 5s heartbeat.
    let supervisor = spawn_daemon(&socket, &agent_dir, None);
    let mut client = Client::connect(&socket);
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let created = client.request(
        "c1",
        json!({
            "type": "create",
            "name": "hb-lane",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions.to_string_lossy(),
                "script": script.to_string_lossy(),
            },
        }),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
    let active_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("active id")
        .to_string();
    let session_id = created["data"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();
    let session_file = agent_dir
        .join("sessions")
        .join(format!("{session_id}.jsonl"));
    let heartbeat = client.request(
        "hb",
        json!({
            "type": "heartbeat_set",
            "activeSessionId": active_id,
            "schedule": "every 10s",
            "prompt": "liveness ping",
        }),
    );
    assert_eq!(
        heartbeat["success"], true,
        "heartbeat_set failed: {heartbeat}"
    );
    let first_turn = client.request(
        "p1",
        json!({
            "type": "prompt_and_wait",
            "activeSessionId": active_id,
            "message": "warm the lane",
        }),
    );
    assert_eq!(
        first_turn["success"], true,
        "first turn failed: {first_turn}"
    );

    // At least one scheduled fire delivered before the crash.
    let rows_before_restart = wait_until(Duration::from_secs(20), || {
        let rows = session_rows_containing(&session_file, "heartbeat_prompt");
        (rows > 0).then_some(rows)
    });

    // The supervisor dies hard and relaunches; the worker is re-adopted.
    drop(client);
    drop(supervisor);
    std::fs::remove_file(&socket).ok();
    let _supervisor = spawn_daemon(&socket, &agent_dir, None);
    let mut client = Client::connect(&socket);
    wait_until(Duration::from_secs(30), || {
        client
            .listed_sessions()
            .iter()
            .any(|(active, id)| *active == active_id || *id == session_id)
            .then_some(())
    });

    // THE ASSERT: the heartbeat keeps firing after the re-adoption — the
    // row count grows past the pre-restart snapshot (a fire delivered by
    // the re-adopted worker).
    let grew = wait_until(Duration::from_secs(30), || {
        let rows = session_rows_containing(&session_file, "heartbeat_prompt");
        (rows > rows_before_restart).then_some(rows)
    });
    assert!(
        grew > rows_before_restart,
        "no heartbeat fired after the restart ({rows_before_restart} rows)"
    );

    client.request(
        "k1",
        json!({ "type": "kill", "activeSessionId": active_id }),
    );
}

/// The boot-time wake interplay with the storm gates (the ~200-agent
/// boot crash class): one plain boot after a supervisor kill -9 — the
/// ADOPTED-ALIVE worker with a due heartbeat fires (the wake survives
/// re-adoption), while the KILLED sibling (archived, jobs cancelled,
/// stop tombstoned) never resurrects (the #2592/#2642 gates hold; the
/// parked scheduler wakes only its own session, never a dead one).
#[test]
fn a_boot_fires_the_adopted_worker_due_job_and_never_resurrects_the_killed_sibling() {
    let root = tempfile::TempDir::new().expect("temp dir");
    let dir = root.path().to_path_buf();
    let agent_dir = dir.join("agent");
    let socket = dir.join("storm.sock");
    let script = dir.join("faux.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
            ]
        })
        .to_string(),
    )
    .expect("write faux script");

    let supervisor = spawn_daemon(&socket, &agent_dir, None);
    let mut client = Client::connect(&socket);
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let mut created_ids = Vec::new();
    for name in ["wake-lane", "dead-lane"] {
        let created = client.request(
            name,
            json!({
                "type": "create",
                "name": name,
                "config": {
                    "cwd": dir.to_string_lossy(),
                    "sessionDir": sessions.to_string_lossy(),
                    "script": script.to_string_lossy(),
                },
            }),
        );
        assert_eq!(created["success"], true, "create failed: {created}");
        created_ids.push((
            created["data"]["id"]
                .as_str()
                .or_else(|| created["data"]["activeSessionId"].as_str())
                .expect("active id")
                .to_string(),
            created["data"]["sessionId"]
                .as_str()
                .expect("session id")
                .to_string(),
        ));
    }
    let (wake_active, wake_session) = created_ids[0].clone();
    let (dead_active, dead_session) = created_ids[1].clone();
    let wake_file = agent_dir
        .join("sessions")
        .join(format!("{wake_session}.jsonl"));

    // The wake lane carries the due heartbeat; the dead lane is wire-
    // killed (its jobs cancel and its file archives — the stop gates).
    let heartbeat = client.request(
        "hb",
        json!({
            "type": "heartbeat_set",
            "activeSessionId": wake_active,
            "schedule": "every 10s",
            "prompt": "liveness ping",
        }),
    );
    assert_eq!(
        heartbeat["success"], true,
        "heartbeat_set failed: {heartbeat}"
    );
    let killed = client.request(
        "kill",
        json!({ "type": "kill", "activeSessionId": dead_active }),
    );
    assert_eq!(killed["success"], true, "kill failed: {killed}");

    // At least one fire delivered before the crash.
    let rows_before_restart = wait_until(Duration::from_secs(20), || {
        let rows = session_rows_containing(&wake_file, "heartbeat_prompt");
        (rows > 0).then_some(rows)
    });

    // The supervisor dies hard and relaunches: the wake lane's worker is
    // adopted alive (its due fire must continue), the killed lane's stop
    // finishes at the boot scan instead of resurrecting.
    drop(client);
    drop(supervisor);
    std::fs::remove_file(&socket).ok();
    let _supervisor = spawn_daemon(&socket, &agent_dir, None);
    let mut client = Client::connect(&socket);
    wait_until(Duration::from_secs(30), || {
        client
            .listed_sessions()
            .iter()
            .any(|(active, id)| *active == wake_active || *id == wake_session)
            .then_some(())
    });

    // THE STORM GATE: the killed lane never resurrects across the boot
    // window, while the adopted worker's due fire keeps landing.
    let window = Instant::now() + Duration::from_secs(20);
    while Instant::now() < window {
        let roster = client.listed_sessions();
        assert!(
            !roster
                .iter()
                .any(|(active, id)| *active == dead_active || *id == dead_session),
            "the killed session resurrected at boot: {roster:?}"
        );
    }
    let grew = wait_until(Duration::from_secs(30), || {
        let rows = session_rows_containing(&wake_file, "heartbeat_prompt");
        (rows > rows_before_restart).then_some(rows)
    });
    assert!(
        grew > rows_before_restart,
        "no heartbeat fired after the restart ({rows_before_restart} rows)"
    );

    client.request(
        "k1",
        json!({ "type": "kill", "activeSessionId": wake_active }),
    );
}

fn session_rows_containing(session_file: &Path, needle: &str) -> usize {
    std::fs::read_to_string(session_file).map_or(0, |content| {
        content.lines().filter(|line| line.contains(needle)).count()
    })
}
