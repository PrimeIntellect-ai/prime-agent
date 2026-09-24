//! The compaction phase-trace measurement harness: one threshold
//! auto-compaction over a seeded ~50MB session, with
//! `PA_COMPACTION_TRACE` capturing every phase boundary of the daemon's
//! compaction pipeline and the client recording the wire arrival times of
//! the compaction frames (the loader window a user sees).
//!
//! Measurement, not a behavioral contract: the run prints the phase
//! table (trace deltas + wire gaps) and writes a JSON summary next to
//! the trace. The behavioral assertions land with the completion-latency
//! fix this measurement grounds.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// One fattening assistant reply (the seeded session bulk).
const FATTENING_TURNS: usize = 8;
const FATTEN_REPLY_CHARS: usize = 6 * 1024 * 1024;

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

/// An OpenAI-compatible SSE mock: every request is answered with the
/// scripted reply; the crossing turn (request index FATTENING_TURNS
/// plus one) reports the over-threshold usage so the post-turn
/// threshold check fires a compaction over the fattened session.
struct MegaMock {
    requests: Arc<Mutex<Vec<Value>>>,
    port: u16,
}

impl MegaMock {
    fn start() -> MegaMock {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let requests_for_thread = Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let requests = Arc::clone(&requests_for_thread);
                std::thread::spawn(move || {
                    let _ = serve(stream, requests);
                });
            }
        });
        MegaMock { requests, port }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    /// Every request the mock answered (the seeded turns, the crossing
    /// turn, the compaction's summarizer call, the status-line recaps).
    fn request_count(&self) -> usize {
        self.requests.lock().expect("mock lock").len()
    }
}

fn chunk(delta: Value, finish_reason: Option<&str>, usage: Value) -> String {
    json!({
        "id": "chatcmpl-test",
        "object": "chat.completion.chunk",
        "created": 1750000000,
        "model": "mock-1",
        "choices": [{
            "index": 0,
            "delta": delta,
            "finish_reason": finish_reason,
        }],
        "usage": usage,
    })
    .to_string()
}

fn small_usage() -> Value {
    json!({
        "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
        "prompt_tokens_details": {"cached_tokens": 0},
    })
}

/// The crossing turn's reported usage: over the tiny reserve, so the
/// settled turn's threshold check fires.
fn crossing_usage() -> Value {
    json!({
        "prompt_tokens": 126000, "completion_tokens": 10, "total_tokens": 126010,
        "prompt_tokens_details": {"cached_tokens": 80},
    })
}

fn serve(mut stream: TcpStream, requests: Arc<Mutex<Vec<Value>>>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        head.push_str(&line);
        if line == "\r\n" {
            break;
        }
    }
    let mut content_length = 0usize;
    for line in head.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body_bytes = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body_bytes)?;
    }
    let body: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
    let index = requests.lock().expect("mock lock").len();
    requests.lock().expect("mock lock").push(body);
    // The crossing turn is the last one (index FATTENING_TURNS + 1, after
    // the seed turn): its usage crosses the seeded reserve.
    let crossing = index == FATTENING_TURNS + 1;
    let usage = if crossing {
        crossing_usage()
    } else {
        small_usage()
    };
    let reply = if crossing {
        "crossing reply".to_string()
    } else {
        "a".repeat(FATTEN_REPLY_CHARS)
    };
    let mut payload = String::new();
    for data in [
        chunk(
            json!({"role": "assistant", "content": reply}),
            None,
            small_usage(),
        ),
        chunk(json!({}), Some("stop"), usage.clone()),
        json!({
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1750000000,
            "model": "mock-1",
            "choices": [],
            "usage": usage,
        })
        .to_string(),
    ] {
        payload.push_str(&format!("data: {data}\n\n"));
    }
    payload.push_str("data: [DONE]\n\n");
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path, trace_path: &Path) -> Supervisor {
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
        .env("PA_COMPACTION_TRACE", trace_path)
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

struct TimedClient {
    reader: BufReader<std::os::unix::net::UnixStream>,
    writer: std::os::unix::net::UnixStream,
    /// Every parked session event with its wire arrival time.
    events: Vec<(Value, Instant)>,
}

impl TimedClient {
    fn connect(socket: &Path) -> TimedClient {
        let stream = std::os::unix::net::UnixStream::connect(socket).expect("connect");
        let writer = stream.try_clone().expect("clone");
        let mut client = TimedClient {
            reader: BufReader::new(stream),
            writer,
            events: Vec::new(),
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
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
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(600);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
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

    /// Read lines until the response for `id` arrives, parking broadcast
    /// session events with their arrival times.
    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(600);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
            if line.get("type").and_then(Value::as_str) == Some("session_event") {
                self.events.push((line["event"].clone(), Instant::now()));
            }
        }
    }
}

/// Parse the trace lines into a (phase, elapsed micros) table.
fn read_trace(path: &Path) -> Vec<(String, u128, Value)> {
    let content = std::fs::read_to_string(path).unwrap_or_default();
    content
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("compaction-trace: ")?;
            let value: Value = serde_json::from_str(rest).ok()?;
            let phase = value.get("phase")?.as_str()?.to_string();
            let elapsed = value.get("elapsedMicros")?.as_u64()? as u128;
            let detail = value.get("detail").cloned().unwrap_or(Value::Null);
            Some((phase, elapsed, detail))
        })
        .collect()
}

#[test]
#[ignore] // measurement harness: seeds ~50MB and prints the phase table
fn mega_session_threshold_compaction_phase_measurement() {
    let dir = tempfile::tempdir().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let mock = MegaMock::start();
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": mock.url(),
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128000,
                            "maxTokens": 4096,
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    // Tiny reserve + tiny keep-recent: the crossing usage fires the
    // threshold arm and the cut keeps almost nothing (the summarizer
    // request carries nearly the whole fattened history — the worst
    // case the operator's stall reports).
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "compaction": {"enabled": true, "reserveTokens": 500, "keepRecentTokens": 10} })
            .to_string(),
    )
    .expect("write settings.json");
    let trace_path = dir.path().join("compaction-trace.jsonl");
    let socket = dir.path().join("daemon.sock");
    let _supervisor = spawn_supervisor(&socket, &agent_dir, &trace_path);
    let mut client = TimedClient::connect(&socket);

    client.send_command(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "provider": "prime-inference",
                "model": "mock-1",
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("session id")
        .to_string();

    client.send_command(
        "a1",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // The seed turn (small usage): keeps the threshold quiet while the
    // fattening turns grow the session.
    client.send_command(
        "p0",
        json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": "seed turn"}),
    );
    let seeded = client.read_response("p0");
    assert_eq!(seeded["success"], true, "seed prompt failed: {seeded}");

    // Fatten the session: FATTENING_TURNS assistant replies of ~6MB each
    // persist to the session file and ride the live context.
    for turn in 0..FATTENING_TURNS {
        let id = format!("f{turn}");
        client.send_command(
            &id,
            json!({
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": format!("fattening turn {turn}"),
            }),
        );
        let reply = client.read_response(&id);
        assert_eq!(reply["success"], true, "fattening turn failed: {reply}");
    }

    // The crossing turn: its reported usage crosses the seeded reserve,
    // so the settled boundary runs the threshold auto-compaction over
    // the fattened session.
    let crossing_started = Instant::now();
    client.send_command(
        "px",
        json!({"type": "prompt_and_wait", "activeSessionId": session_id, "message": "crossing turn"}),
    );
    let crossed = client.read_response("px");
    let crossing_total = crossing_started.elapsed();
    assert_eq!(
        crossed["success"], true,
        "crossing prompt failed: {crossed}"
    );

    // The compaction's summarizer call really reached the provider
    // (past the seeded turns and the crossing turn).
    assert!(
        mock.request_count() > 1 + FATTENING_TURNS + 1,
        "the compaction's summarizer request never arrived ({})",
        mock.request_count()
    );

    // The trace table.
    let trace = read_trace(&trace_path);
    assert!(
        trace
            .iter()
            .any(|(phase, _, _)| phase == "auto.threshold_start_emitted"),
        "no threshold compaction trace lines: {trace_path:?} had {} lines",
        trace.len()
    );
    println!("== compaction phase trace ({} lines) ==", trace.len());
    let mut previous = 0u128;
    for (phase, elapsed, detail) in &trace {
        let delta = elapsed - previous;
        previous = *elapsed;
        println!("PHASE {phase:>32} elapsed={elapsed:>9}us delta={delta:>9}us {detail}");
    }

    // The wire view: the loader window a client sees.
    let mut loader_window = None;
    let mut notice_gap = None;
    for (index, (event, at)) in client.events.iter().enumerate() {
        if event.get("type").and_then(Value::as_str) == Some("compaction_start") {
            if let Some((_, end_at)) = client.events.iter().find(|(event, _)| {
                event.get("type").and_then(Value::as_str) == Some("compaction_end")
            }) {
                loader_window = Some(end_at.duration_since(*at));
                if let Some((_, notice_at)) = client.events[index..].iter().find(|(event, _)| {
                    event.get("type").and_then(Value::as_str) == Some("message_end")
                        && event["message"]["customType"] == "ipython_state"
                }) {
                    notice_gap = Some(notice_at.duration_since(*at));
                }
            }
            break;
        }
    }
    println!("== wire timings ==");
    println!("crossing prompt_and_wait total: {crossing_total:?}");
    println!("loader window (compaction_start -> compaction_end): {loader_window:?}");
    if let Some(notice_gap) = notice_gap {
        println!("[python-state] notice gap from compaction_start: {notice_gap:?}");
    }
    let session_file = session_dir
        .read_dir()
        .expect("session dir read")
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .expect("session file");
    let session_bytes = std::fs::metadata(&session_file)
        .expect("session file metadata")
        .len();
    println!("session file bytes after compaction: {session_bytes}");
    assert!(
        loader_window.is_some(),
        "the client never saw the compaction_end frame"
    );
    let summary = json!({
        "sessionBytes": session_bytes,
        "crossingTotalMicros": crossing_total.as_micros(),
        "loaderWindowMicros": loader_window.map(|d| d.as_micros()),
        "noticeGapMicros": notice_gap.map(|d| d.as_micros()),
        "trace": trace
            .iter()
            .map(|(phase, elapsed, detail)| {
                json!({"phase": phase, "elapsedMicros": elapsed, "detail": detail})
            })
            .collect::<Vec<_>>(),
    });
    let summary_path = dir.path().join("mega-measurement.json");
    std::fs::write(&summary_path, summary.to_string()).expect("write summary");
    println!("summary written: {}", summary_path.display());
    println!("trace file: {}", trace_path.display());
    // The driver's artifact dir (the tempdir dies with the test): copy the
    // trace + summary out when the harness asks for it.
    if let Ok(out_dir) = std::env::var("PA_MEGA_OUT_DIR") {
        let out_dir = PathBuf::from(out_dir);
        std::fs::create_dir_all(&out_dir).expect("artifact dir");
        std::fs::copy(&trace_path, out_dir.join("compaction-trace.jsonl")).expect("copy trace");
        std::fs::copy(&summary_path, out_dir.join("mega-measurement.json")).expect("copy summary");
        println!("artifacts copied to {out_dir:?}");
    }
}
