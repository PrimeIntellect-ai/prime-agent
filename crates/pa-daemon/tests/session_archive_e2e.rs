//! Session-archive e2e (roadmap: the sessions directory must not grow
//! forever). Two flows against the real supervisor binary:
//!
//! 1. The boot sweep archives aged sessions into
//!    `<agent-dir>/sessions-archive` (age rule: default 30 days), spares
//!    fresh ones, spares a session pinned by an active scheduled job, and
//!    the catalog no longer lists the archived rows.
//! 2. An archived session resumes through the wake path: `send_message`
//!    by selector restores the file into the sessions dir (the archived
//!    lifecycle stays reachable via its resume selector, TS parity) and
//!    the woken worker runs the turn against the mock provider.
//!
//! Unix-only e2e (AF_UNIX sockets): compiles to nothing elsewhere, like the
//! other pa-daemon e2e verifiers.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
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

/// One always-200 SSE answer per request (the mock the woken session turns
/// against).
fn spawn_mock(answer: &'static str) -> PathBuf /* url */ {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = serve(stream, answer);
            });
        }
    });
    PathBuf::from(url)
}

fn chunk(delta: Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-archive",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

fn serve(mut stream: TcpStream, answer: &str) -> std::io::Result<()> {
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
    let mut payload = String::new();
    for data in [
        chunk(json!({"role": "assistant", "content": answer}), None),
        chunk(json!({}), Some("stop")),
    ] {
        payload.push_str(&format!("data: {data}\n\n"));
    }
    payload.push_str("data: [DONE]\n\n");
    stream.write_all(
        format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}")
            .as_bytes(),
    )
}

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path) -> Daemon {
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_MODEL_PROVIDER", "prime-inference")
        .env("PRIME_AGENT_MODEL", "mock-1")
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
    Daemon { child }
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    /// Connect once the supervisor accepts (a restarted supervisor parks
    /// on the stale socket file before replacing it, so file existence is
    /// not readiness).
    fn connect(socket: &Path) -> (Self, Value) {
        let deadline = Instant::now() + Duration::from_secs(15);
        let stream = loop {
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("connect supervisor: {error}"),
            }
        };
        let writer = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn send_command(&mut self, id: &str, command: Value) {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
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

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_mins(1);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// Poll a sync probe until it yields a value.
fn wait_until<T>(deadline: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + deadline;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "condition never became true");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A saved session fixture: header + name + one user message.
fn write_fixture(sessions_dir: &Path, name: &str) -> String {
    let mut session = pa_daemon::session_store::SessionFile::create("/work", None, 0);
    let id = session.session_id().to_string();
    session.append_session_info(name);
    session.append_message(serde_json::json!({
        "role": "user", "content": "hi", "timestamp": 1u64
    }));
    let path = sessions_dir.join(format!("{id}.jsonl"));
    session.set_path(path);
    session.rewrite().expect("write fixture session");
    id
}

/// Backdate a file's mtime (the age rule keys on it).
fn age_days(path: &Path, days: u64) {
    let seconds = days * 24 * 60 * 60;
    let mtime = filetime::FileTime::from_unix_time(seconds as i64, 0);
    filetime::set_file_mtime(path, mtime).expect("set mtime");
}

/// An active scheduled job pinning one session file (the disk analogue of
/// the TS idle-eviction `hasRegisteredCronJob` guard): the sweep must never
/// archive its target.
fn pin_with_scheduled_job(agent_dir: &Path, session_id: &str, session_file: &Path) {
    let partition = agent_dir.join("session-artifacts").join(session_id);
    std::fs::create_dir_all(&partition).expect("artifacts partition");
    // No `nextRunAt`: the job is never due, so the boot re-arm never wakes
    // it; its active status alone pins the file.
    let job = json!({
        "id": "job-pin",
        "status": "active",
        "activeSessionId": session_id,
        "sessionId": session_id,
        "sessionFile": session_file.to_string_lossy(),
        "cwd": "/work",
        "prompt": "tick",
        "schedule": { "kind": "interval", "expression": "every 1h", "intervalMs": 3_600_000 },
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
    });
    std::fs::write(
        partition.join("scheduled-jobs.json"),
        serde_json::to_string(&json!({ "jobs": [job], "dispatches": [] })).expect("job json"),
    )
    .expect("write scheduled-jobs.json");
}

/// The saved-session catalog rows (the `list_saved_sessions` final
/// response).
fn saved_rows(client: &mut Client, id: &str, cwd: &Path) -> Vec<Value> {
    client.send_command(
        id,
        json!({ "type": "list_saved_sessions", "cwd": cwd.to_string_lossy() }),
    );
    loop {
        let line = client.read_line();
        if line.get("id").and_then(Value::as_str) == Some(id) {
            if let Some(sessions) = line["data"]["sessions"].as_array() {
                return sessions.clone();
            }
        }
    }
}

/// Assert the daemon log mentions one of `needles` (the rotating log for
/// the supervisor socket under `<agent-dir>/logs`).
fn log_mentions(agent_dir: &Path, needle: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(agent_dir.join("logs")) else {
        return false;
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .any(|path| std::fs::read_to_string(&path).is_ok_and(|content| content.contains(needle)))
}

#[test]
fn boot_sweep_archives_aged_sessions_and_the_catalog_excludes_them() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");

    let aged_one = write_fixture(&sessions, "aged-one");
    let aged_two = write_fixture(&sessions, "aged-two");
    let fresh = write_fixture(&sessions, "fresh-one");
    let pinned = write_fixture(&sessions, "pinned-old");
    // The default policy (30 days) retires both aged fixtures; the fresh
    // one and the job-pinned one stay.
    age_days(&sessions.join(format!("{aged_one}.jsonl")), 40);
    age_days(&sessions.join(format!("{aged_two}.jsonl")), 40);
    age_days(&sessions.join(format!("{pinned}.jsonl")), 40);
    pin_with_scheduled_job(
        &agent_dir,
        &pinned,
        &sessions.join(format!("{pinned}.jsonl")),
    );

    let socket = dir.path().join("daemon.sock");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // The boot sweep ran: the aged sessions moved into the archive, the
    // fresh and the pinned ones stay live.
    let archive = agent_dir.join("sessions-archive");
    wait_until(Duration::from_secs(10), || {
        (archive.join(format!("{aged_one}.jsonl")).is_file()
            && archive.join(format!("{aged_two}.jsonl")).is_file())
        .then_some(())
    });
    assert!(!sessions.join(format!("{aged_one}.jsonl")).is_file());
    assert!(!sessions.join(format!("{aged_two}.jsonl")).is_file());
    assert!(
        sessions.join(format!("{fresh}.jsonl")).is_file(),
        "fresh session stays live"
    );
    assert!(
        sessions.join(format!("{pinned}.jsonl")).is_file(),
        "scheduled-job sessions are never archived"
    );
    assert!(
        !archive.join(format!("{fresh}.jsonl")).is_file()
            && !archive.join(format!("{pinned}.jsonl")).is_file(),
        "only the aged sessions archived"
    );

    // Catalog integration: the archived rows no longer surface.
    let rows = saved_rows(&mut client, "l1", dir.path());
    let names: Vec<&str> = rows.iter().filter_map(|row| row["name"].as_str()).collect();
    assert_eq!(names, vec!["fresh-one", "pinned-old"], "rows: {rows:?}");

    // The daemon logged the sweep.
    wait_until(Duration::from_secs(5), || {
        log_mentions(&agent_dir, "archived 2 session(s)").then_some(())
    });
}

#[test]
fn an_archived_session_resumes_through_the_wake() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let url = spawn_mock("archive reply");
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": url.to_string_lossy(),
                    "apiKey": "sk-archive",
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

    // Phase 1: a live session runs one turn, then stops; its file stays.
    let socket = dir.path().join("daemon.sock");
    let first = spawn_daemon(&socket, &agent_dir);
    let session_id = {
        let (mut client, hello) = Client::connect(&socket);
        assert_eq!(hello["type"], "daemon_hello");
        client.send_command(
            "c1",
            json!({
                "type": "create",
                "name": "beta",
                "config": {
                    "cwd": dir.path().to_string_lossy(),
                    "sessionDir": sessions.to_string_lossy(),
                    "provider": "prime-inference",
                    "model": "mock-1",
                },
            }),
        );
        let created = client.read_response("c1");
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
        client.send_command(
            "p1",
            json!({
                "type": "prompt_and_wait",
                "activeSessionId": active_id,
                "message": "first turn",
            }),
        );
        assert_eq!(
            client.read_response("p1")["success"],
            true,
            "first turn failed"
        );
        client.send_command(
            "k1",
            json!({ "type": "kill", "activeSessionId": active_id }),
        );
        assert_eq!(client.read_response("k1")["success"], true, "kill failed");
        session_id
    };
    drop(first);

    // Phase 2: backdate the saved file past the default age rule and
    // restart the supervisor; its boot sweep archives the session.
    let saved = sessions.join(format!("{session_id}.jsonl"));
    assert!(
        saved.is_file(),
        "killed session saved at {}",
        saved.display()
    );
    age_days(&saved, 40);
    let _second = spawn_daemon(&socket, &agent_dir);
    let archive = agent_dir.join("sessions-archive");
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    wait_until(Duration::from_secs(10), || {
        archive
            .join(format!("{session_id}.jsonl"))
            .is_file()
            .then_some(())
    });
    assert!(!saved.is_file(), "aged session left the sessions dir");

    // Phase 3: the resume. Sending by name falls back to the archive,
    // restores the file into the sessions dir, wakes its worker, and the
    // turn runs against the mock.
    client.send_command(
        "s1",
        json!({ "type": "send_message", "targetActiveSessionId": "beta", "message": "wake up" }),
    );
    let sent = client.read_response("s1");
    assert_eq!(sent["success"], true, "send by name failed: {sent}");
    let receipt = &sent["data"];
    assert_eq!(receipt["deliveryStatus"], "delivered", "{receipt}");
    let woken_id = receipt["target"]["activeSessionId"]
        .as_str()
        .expect("woken active id")
        .to_string();

    // The restored file is live again and the turn ran.
    wait_until(Duration::from_secs(10), || saved.is_file().then_some(()));
    wait_until(Duration::from_secs(30), || {
        client.send_command(
            "gm1",
            json!({ "type": "get_messages", "activeSessionId": woken_id }),
        );
        let response = client.read_response("gm1");
        assert_eq!(response["success"], true, "get_messages failed");
        let text = serde_json::to_string(&response["data"]).expect("messages json");
        text.contains("archive reply").then_some(text)
    });
    assert!(
        !archive.join(format!("{session_id}.jsonl")).is_file(),
        "restore left the archive"
    );
}
