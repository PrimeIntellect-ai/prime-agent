//! Agent inbox e2e (stage 1): machine notices (`bash.completed`,
//! `factory.progress`) route into the daemon-owned inbox instead of
//! steering their full rows; a short coalesced steering notice wakes the
//! agent mid-batch; `rlm.inbox.read()` returns the messages with their
//! time signature and drains; the journal persists under the session's
//! artifact dir; and `agentInbox.enabled: false` (the kill switch)
//! restores the direct full-row steering. Everything asserts transcript
//! row order, never wall-clock caps.
//!
//! The kernel boots through the real runtime bootstrap: the daemon gets
//! a private `PRIME_AGENT_KERNEL_VENV` (never the user's shared venv),
//! so the runtime source ships from this checkout.

// 64-bit-only targets; the narrowing casts sit at bounded OS boundaries.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Fn length is a style gate, not correctness.
#![allow(clippy::too_many_lines)]
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

/// The sequential mock: one scripted answer per provider request, in order.
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

fn chunk(delta: &Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-inbox",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

fn python_cell(code: &str) -> Value {
    json!({
        "name": "python_repl",
        "arguments": serde_json::to_string(&json!({ "code": code })).unwrap(),
    })
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
    // The scripted sequence: the inbox turn (start two detached handles,
    // count mid-turn, read and drain), its settle, the notice's wake,
    // then the kill-switch turn and ITS full-row wake.
    let request = next.fetch_add(1, Ordering::SeqCst);
    let data = match request {
        0 => [
            chunk(
                &json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call-inbox-1",
                        "type": "function",
                        "function": python_cell(
                            "from rlm import bash\nh1 = bash('sleep 2; echo INBOX_E2E_ONE')\nh2 = bash('sleep 3; echo INBOX_E2E_TWO')\nprint('two handles started')"
                        )
                    }]
                }),
                None,
            ),
            chunk(&json!({}), Some("tool_calls")),
        ],
        1 => [
            chunk(
                &json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call-inbox-2",
                        "type": "function",
                        "function": python_cell(
                            "import asyncio\nawait asyncio.sleep(4)\nfrom rlm import inbox\nc = await inbox.count()\nprint((c.count, c.oldest_arrived_at_ms > 0, dict(c.classes)))"
                        )
                    }]
                }),
                None,
            ),
            chunk(&json!({}), Some("tool_calls")),
        ],
        2 => [
            chunk(
                &json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call-inbox-3",
                        "type": "function",
                        "function": python_cell(
                            "from rlm import inbox\nmsgs = await inbox.read()\nafter = await inbox.count()\nheader = msgs[0].text.split(chr(93))[0] + chr(93)\nprint((len(msgs), msgs[0].inbox_class, header, msgs[0].arrived_at_ms > 0, after.count, dict(after.classes)))"
                        )
                    }]
                }),
                None,
            ),
            chunk(&json!({}), Some("tool_calls")),
        ],
        3 => [
            chunk(
                &json!({"role": "assistant", "content": "woken by the inbox notice"}),
                None,
            ),
            chunk(&json!({}), Some("stop")),
        ],
        4 => [
            chunk(
                &json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call-inbox-4",
                        "type": "function",
                        "function": python_cell(
                            "from rlm import bash\nh3 = bash('sleep 2; echo INBOX_E2E_LEGACY')\nprint('legacy handle started')"
                        )
                    }]
                }),
                None,
            ),
            chunk(&json!({}), Some("tool_calls")),
        ],
        5 => [
            chunk(
                &json!({"role": "assistant", "content": "legacy turn complete"}),
                None,
            ),
            chunk(&json!({}), Some("stop")),
        ],
        _ => [
            chunk(
                &json!({"role": "assistant", "content": "woken by the legacy notice"}),
                None,
            ),
            chunk(&json!({}), Some("stop")),
        ],
    };
    let mut payload = String::new();
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
        let deadline = Instant::now() + Duration::from_secs(240);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        loop {
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => line.clear(),
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

    fn request(&mut self, id: &str, command: &Value) -> Value {
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
        let deadline = Instant::now() + Duration::from_secs(240);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    fn messages(&mut self, active_session_id: &str) -> Value {
        let response = self.request(
            "gm",
            &json!({ "type": "get_messages", "activeSessionId": active_session_id }),
        );
        assert_eq!(response["success"], true, "get_messages failed: {response}");
        response["data"].clone()
    }

    fn transcript(&mut self, active_session_id: &str) -> String {
        serde_json::to_string(&self.messages(active_session_id)).expect("messages json")
    }
}

/// One transcript row's user-visible text: message rows join their text
/// blocks, custom rows carry their content field.
fn row_text(row: &Value) -> String {
    if row.get("role").and_then(Value::as_str) == Some("custom") {
        return row
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
    }
    row.get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// The transcript's delivered rows (steering rows and custom rows), with
/// tool results excluded.
fn delivered_rows(messages: &Value) -> Vec<(String, Value)> {
    messages
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages array")
        .iter()
        .map(|row| (row_text(row), row.clone()))
        .filter(|(_, row)| row.get("role").and_then(Value::as_str) != Some("tool_result"))
        .collect()
}

fn wait_until<T>(deadline: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + deadline;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "condition never became true");
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path, kernel_venv: &Path) -> Daemon {
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
        // The session kernel boots through the real runtime bootstrap out
        // of this checkout, into a private venv (never the shared one).
        .env("PRIME_AGENT_KERNEL_VENV", kernel_venv)
        // A supervisor killed at teardown must not leak its session workers.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "20000",
        );
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

#[test]
fn machine_notices_inbox_coalesce_and_the_kill_switch_restores_steering() {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let root = tempfile::TempDir::new().expect("temp dir");
    let dir = root.path().to_path_buf();
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = dir.join("daemon.sock");
    let kernel_venv = dir.join("kernel-venv");
    let url = spawn_mock(&NEXT);
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": url.to_string_lossy(),
                    "apiKey": "sk-inbox",
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

    let supervisor = spawn_daemon(&socket, &agent_dir, &kernel_venv);
    let mut client = Client::connect(&socket);
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let created = client.request(
        "c1",
        &json!({
            "type": "create",
            "name": "agent-inbox-lane",
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

    // THE INBOX TURN: two detached commands start; both finish inside the
    // same busy turn, so both notices land in the inbox while the session
    // is busy; the read then drains.
    let turn = client.request(
        "p1",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": active_id,
            "message": "run the two detached commands, count, read, and finish",
        }),
    );
    assert_eq!(turn["success"], true, "inbox turn failed: {turn}");
    let after_cut_turn = client.transcript(&active_id);
    assert!(
        after_cut_turn.contains("(2, True, {'bash-done': 2})"),
        "the mid-turn count saw both arrivals in the inbox: {after_cut_turn}"
    );

    // The coalesced wake: the queued steer cut the busy turn at its
    // boundary, ONE short steering notice delivered, and the woken turn
    // read the inbox — no full async_bash_completion custom row steers.
    let _settled = wait_until(Duration::from_secs(120), || {
        let messages = client.transcript(&active_id);
        (messages.contains("woken by the inbox notice")).then_some(messages)
    });
    let after_woken = client.transcript(&active_id);
    assert!(
        after_woken.contains("[bash-done pid:"),
        "the read returned the notice text: {after_woken}"
    );
    assert!(
        after_woken.contains("(2, 'bash-done', '[bash-done pid:")
            && after_woken.contains("exit:0]', True, 0, {})"),
        "the read drained both messages (count 0 after): {after_woken}"
    );
    let rows = client.messages(&active_id);
    let delivered = delivered_rows(&rows);
    let notice_at = delivered
        .iter()
        .position(|(text, _)| {
            text.starts_with("[inbox ")
                && text.contains("+2 arrived")
                && text.contains("2 bash-done")
        })
        .unwrap_or_else(|| panic!("the coalesced short notice never steered: {delivered:?}"));
    let notice_text = delivered[notice_at].0.clone();
    assert!(
        notice_text.contains("rlm.inbox.read()"),
        "the notice teaches the read API: {notice_text}"
    );
    let woken_at = delivered
        .iter()
        .position(|(text, _)| text == "woken by the inbox notice")
        .unwrap_or_else(|| panic!("the woken reply never landed: {delivered:?}"));
    assert!(
        notice_at < woken_at,
        "the notice steers before the reply it woke: {notice_text}"
    );
    let full_rows = delivered
        .iter()
        .filter(|(_, row)| {
            row.get("customType").and_then(Value::as_str) == Some("async_bash_completion")
        })
        .count();
    assert_eq!(
        full_rows, 0,
        "no full notice row steers while the inbox is enabled: {delivered:?}"
    );
    // The durable journal under the session's artifact dir: the message
    // record plus the read's drain marker (persistence across a restart
    // replays the unread set).
    let session_file = sessions
        .read_dir()
        .expect("sessions dir readable")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .expect("the session file landed in the configured session dir");
    let session_id = session_file
        .file_stem()
        .expect("session file stem")
        .to_string_lossy()
        .to_string();
    // The daemon resolves the per-session artifact dir off the session
    // file's grandparent (`session_artifact_dir_for_log`).
    let inbox_journal = session_file
        .parent()
        .and_then(Path::parent)
        .expect("session file grandparent")
        .join("session-artifacts")
        .join(&session_id)
        .join("inbox.jsonl");
    let journal = std::fs::read_to_string(&inbox_journal)
        .unwrap_or_else(|error| panic!("read {}: {error}", inbox_journal.display()));
    assert!(
        journal.contains("INBOX_E2E_ONE") && journal.contains("INBOX_E2E_TWO"),
        "the journal holds both message records: {journal}"
    );
    assert!(
        journal.contains("\"kind\":\"drained\""),
        "the read appended its drain marker: {journal}"
    );

    // THE KILL SWITCH: `agentInbox.enabled: false` restores the direct
    // full-row steering for the next arrival.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "agentInbox": { "enabled": false } }).to_string(),
    )
    .expect("write the kill-switch settings");
    let legacy_turn = client.request(
        "p2",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": active_id,
            "message": "start the legacy detached command and finish",
        }),
    );
    assert_eq!(
        legacy_turn["success"], true,
        "legacy turn failed: {legacy_turn}"
    );
    let _legacy_settled = wait_until(Duration::from_secs(120), || {
        let messages = client.transcript(&active_id);
        (messages.contains("woken by the legacy notice")).then_some(messages)
    });
    let rows = client.messages(&active_id);
    let delivered = delivered_rows(&rows);
    let full_row_at = delivered
        .iter()
        .position(|(text, row)| {
            row.get("customType").and_then(Value::as_str) == Some("async_bash_completion")
                && text.contains("[bash-done pid:")
                && text.contains("INBOX_E2E_LEGACY")
        })
        .unwrap_or_else(|| {
            panic!("the kill switch never restored the full notice row: {delivered:?}")
        });
    let legacy_settle_at = delivered
        .iter()
        .position(|(text, _)| text == "legacy turn complete")
        .unwrap_or_else(|| panic!("the legacy turn's settle row missing: {delivered:?}"));
    assert!(
        full_row_at > legacy_settle_at,
        "the full notice row steers after the legacy turn: {}",
        delivered[full_row_at].0
    );
    let journal = std::fs::read_to_string(&inbox_journal)
        .unwrap_or_else(|error| panic!("re-read {}: {error}", inbox_journal.display()));
    assert!(
        !journal.contains("INBOX_E2E_LEGACY"),
        "the disabled inbox never journals the legacy arrival: {journal}"
    );

    // Teardown: stop the session through the live supervisor so the
    // worker (and its kernel + sleepers) do not leak past the test.
    client.request(
        "k1",
        &json!({ "type": "kill", "activeSessionId": active_id }),
    );
    drop(client);
    drop(supervisor);
}
