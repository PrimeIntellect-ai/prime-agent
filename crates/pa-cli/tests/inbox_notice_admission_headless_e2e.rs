//! Real-admission headless e2e for the inbox notice rows: one arrival
//! notice and one reminder notice ride the REAL daemon path — the
//! kernel's detached bash completes, the inbox store takes the message,
//! `admit_inbox_notice`/`admit_inbox_reminder` queue their custom rows,
//! and the wake turns deliver them — then the headless TUI attaches to
//! that live session and renders them as their OWN attributed row class
//! (the envelope summary line plus the always-visible guttered body),
//! never as typed user messages (the operator directive). The pa-tui
//! mock pins cover the decode arms; THIS pin drives admission itself
//! end-to-end.
// Pedantic-gate dispositions: the flow is intentionally linear
// (fn-length is style, not correctness) and its async test future is
// stack-resident by shape.
#![allow(clippy::large_futures, clippy::too_many_lines)]
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use pa_types::inbox_notice::{INBOX_NOTICE_CLASS_ARRIVAL, INBOX_NOTICE_CLASS_REMINDER};

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        graceful_shutdown(&self.socket);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Stop the daemon on `socket` by protocol; kill the child when it fails.
fn graceful_shutdown(socket: &Path) {
    let Ok(stream) = UnixStream::connect(socket) else {
        return;
    };
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    let _ = reader.read_line(&mut hello); // daemon_hello
    let command = json!({
        "type": "command",
        "id": "test-shutdown",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "shutdown" },
    });
    let Ok(mut line) = serde_json::to_string(&command) else {
        return;
    };
    line.push('\n');
    let _ = writer.write_all(line.as_bytes());
    let _ = writer.flush();
    let _ = reader.read_line(&mut String::new());
}

#[allow(clippy::zombie_processes)] // the Supervisor's Drop reaps the child (graceful shutdown, kill, wait) — the reaping crosses the function boundary this lint cannot see
fn spawn_supervisor(dir: &Path, kernel_venv: &Path) -> Supervisor {
    let socket = dir.join("daemon.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        // The session kernel boots through the real runtime bootstrap out
        // of this checkout, into a private venv (never the shared one).
        .env("PRIME_AGENT_KERNEL_VENV", kernel_venv)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for var in [
        pa_daemon::worker::WORKER_ROLE_ENV,
        pa_daemon::worker::WORKER_TOKEN_ENV,
        pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
        pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
        pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
        pa_daemon::worker::WORKER_SOCKET_ENV,
        pa_daemon::worker::WORKER_INSTANCE_ID_ENV,
        pa_daemon::worker::WORKER_SCRIPT_ENV,
    ] {
        command.env_remove(var);
    }
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor { child, socket };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// The scripted mock provider: one response per provider request.
fn spawn_mock() -> PathBuf {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = serve(stream);
            });
        }
    });
    PathBuf::from(url)
}

fn chunk(delta: &Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-inbox-admission",
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

fn serve(mut stream: TcpStream) -> std::io::Result<()> {
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
    // The scripted replies follow the request's last message, never the
    // request's position: the detached-handle turn, the arrival notice,
    // the reminder that counts all three (its turn reads and drains the
    // store), and an earlier reminder that a cycle sampled before the
    // last completion.
    let request: Value = serde_json::from_slice(&body).unwrap_or_default();
    let last = request["messages"]
        .as_array()
        .and_then(|messages| messages.last())
        .cloned()
        .unwrap_or_default();
    let content = last["content"].to_string();
    let data = match last["tool_call_id"].as_str() {
        None if !content.contains("[inbox ") => [
            chunk(
                &json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call-inbox-admission-1",
                        "type": "function",
                        "function": python_cell(
                            "import asyncio\nfrom rlm import bash\nhs = [bash(f'echo INBOX_ADMISSION_E2E_{n}; exit 1') for n in range(3)]\nwhile any(h.running for h in hs):\n    await asyncio.sleep(0.05)\nprint('handles finished')"
                        )
                    }]
                }),
                None,
            ),
            chunk(&json!({}), Some("tool_calls")),
        ],
        Some("call-inbox-admission-1") => [
            chunk(
                &json!({"role": "assistant", "content": "handle started; the command runs detached"}),
                None,
            ),
            chunk(&json!({}), Some("stop")),
        ],
        None if !content.contains("[inbox reminder]") => [
            chunk(
                &json!({"role": "assistant", "content": "woken by the arrival notice"}),
                None,
            ),
            chunk(&json!({}), Some("stop")),
        ],
        None if content.contains("[inbox reminder] 3 messages") => [
            chunk(
                &json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call-inbox-admission-2",
                        "type": "function",
                        "function": python_cell(
                            "from rlm import inbox\nmsgs = await inbox.read()\nprint(('read', len(msgs)))"
                        )
                    }]
                }),
                None,
            ),
            chunk(&json!({}), Some("tool_calls")),
        ],
        Some("call-inbox-admission-2") => [
            chunk(
                &json!({"role": "assistant", "content": "read and settled"}),
                None,
            ),
            chunk(&json!({}), Some("stop")),
        ],
        _ => [
            chunk(
                &json!({"role": "assistant", "content": "woken by an early reminder"}),
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

/// The last delivered notice row of `class`: an early reminder can
/// precede the arrival, so rows are addressed by class, never by order.
fn notice_row<'a>(delivered: &'a [(String, Value)], class: &str) -> (&'a str, &'a Value) {
    let (text, row) = delivered
        .iter()
        .rev()
        .find(|(_, row)| row["details"]["class"] == class)
        .unwrap_or_else(|| panic!("the {class} notice row never delivered: {delivered:?}"));
    (text.as_str(), row)
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

fn chat_options(socket: PathBuf, cwd: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        models: None,
        socket_path: socket,
        cwd,
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: SessionSelection::New,
        initial_message: None,
        show_images: true,
        fullscreen_mouse: false,
        theme: "prime".to_string(),
        code_block_indent: "  ".to_string(),
        tree_filter_mode: String::new(),
        branch_summary_skip_prompt: false,
        version: "0.0.0".to_string(),
        onboarding: None,
        telemetry_disabled: None,
        client_auth: None,
        traces: None,
        provider_auth: None,
        update_commands: None,
        telemetry: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
    }
}

/// The guttered body's first rendered line: the always-visible notice
/// text under its own class's gutter.
fn guttered_head(text: &str) -> String {
    let head: String = text.chars().take(30).collect();
    format!("\u{2570}\u{2500} {head}")
}

#[tokio::test]
async fn admitted_notices_render_as_their_own_rows_never_user_messages() {
    let root = tempfile::TempDir::new().expect("temp dir");
    let dir = root.path().to_path_buf();
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    // The inbox lane is ON with a fast reminder cycle, so the flow
    // delivers one arrival notice and then one reminder notice through
    // the REAL admission and delivery.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "agentInbox": { "enabled": true, "reminderIntervalMs": 300 } }).to_string(),
    )
    .expect("write settings.json");
    let url = spawn_mock();
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": url.to_string_lossy(),
                    "apiKey": "sk-inbox-admission",
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

    let kernel_venv = dir.join("kernel-venv");
    let supervisor = spawn_supervisor(&dir, &kernel_venv);
    let mut client = Client::connect(&supervisor.socket);
    let created = client.request(
        "c1",
        &json!({
            "type": "create",
            "name": "inbox-admission-lane",
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

    // THE REAL ADMISSION: the turn starts three detached handles that fail
    // and holds its cell until all three exit. Their completion notices
    // leave the kernel together when the cell ends, so they coalesce into
    // one arrival notice (a batch split across two wakes would show, and
    // so consume, every message). The row only counts three failures, so
    // they stay unread, and the reminder that counts all three wakes the
    // turn that reads and drains the store.
    let turn = client.request(
        "p1",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": active_id,
            "message": "start the detached handle and finish",
        }),
    );
    assert_eq!(
        turn["success"], true,
        "the detached-handle turn failed: {turn}"
    );
    let _settled = wait_until(Duration::from_secs(180), || {
        let messages = client.transcript(&active_id);
        (messages.contains("woken by the arrival notice") && messages.contains("read and settled"))
            .then_some(messages)
    });

    // THE REAL-PATH ROW PINS: the delivered notice rows carry the inbox
    // system's attribution — never the user role.
    let rows = client.messages(&active_id);
    let delivered = delivered_rows(&rows);
    let (arrival_text, arrival_row) = notice_row(&delivered, INBOX_NOTICE_CLASS_ARRIVAL);
    let (reminder_text, reminder_row) = notice_row(&delivered, INBOX_NOTICE_CLASS_REMINDER);
    assert!(
        arrival_text.starts_with("[inbox ") && !arrival_text.starts_with("[inbox reminder]"),
        "the arrival notice row's text: {arrival_text}"
    );
    assert!(
        reminder_text.starts_with("[inbox reminder] 3 messages"),
        "the reminder notice row's text: {reminder_text}"
    );
    for (row, class) in [
        (arrival_row, INBOX_NOTICE_CLASS_ARRIVAL),
        (reminder_row, INBOX_NOTICE_CLASS_REMINDER),
    ] {
        assert_eq!(
            row["role"], "custom",
            "the {class} notice row's role: {row}"
        );
        assert_eq!(
            row["customType"], "inbox_notice",
            "the {class} notice row's customType: {row}"
        );
        assert_eq!(
            row["details"]["sender"], "Agent inbox",
            "the {class} notice row's sender identity: {row}"
        );
        assert_eq!(
            row["details"]["class"], class,
            "the {class} notice row's class word: {row}"
        );
    }

    // THE HEADLESS RENDER: the TUI attaches to the live session and
    // paints the transcript the real daemon delivered. Each inbox run
    // starts collapsed to its one dim counter line; Ctrl+O steps the chat
    // detail to details, then to all, which expands the runs back into
    // the per-notice rows.
    let ctrl_o = HeadlessStep::Key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('o'),
        crossterm::event::KeyModifiers::CONTROL,
    ));
    let mut options = chat_options(supervisor.socket.clone(), dir.clone());
    options.session = SessionSelection::Attach(active_id.clone());
    let outcome = run_interactive(
        options,
        UiMode::Headless(HeadlessPlan {
            steps: vec![
                HeadlessStep::WaitIdle { timeout_ms: 30_000 },
                HeadlessStep::WaitRender {
                    needle: "\u{2709} Agent inbox \u{b7} 3 waiting".to_string(),
                    timeout_ms: 15_000,
                },
                ctrl_o.clone(),
                HeadlessStep::WaitRender {
                    needle: "Details mode".to_string(),
                    timeout_ms: 15_000,
                },
                ctrl_o,
                HeadlessStep::WaitRender {
                    needle: "\u{2709} Agent inbox \u{b7} 3 unread messages".to_string(),
                    timeout_ms: 15_000,
                },
            ],
            width: 100,
            // Tall enough to hold the expanded transcript in one frame.
            height: 90,
        }),
    )
    .await
    .expect("the headless attach run");
    assert_eq!(
        outcome.active_session_id, active_id,
        "the attach held the live session"
    );
    // The collapsed runs: one counter line per run, the arrival's new
    // messages by class and the reminder's waiting count.
    let collapsed = outcome
        .frames
        .iter()
        .find(|frame| frame.contains("\u{2709} Agent inbox \u{b7} 3 waiting"))
        .expect("a collapsed frame");
    assert!(
        collapsed.contains("\u{2709} Agent inbox \u{b7} 3 new (3 bash-done)"),
        "the arrival run's counter line renders: {collapsed}"
    );
    let last = outcome.frames.last().expect("a settled frame");
    // The expanded envelope summary lines: the inbox system's own row
    // class, both notice classes delivered by the real admission, each
    // with its count.
    assert!(
        last.contains("\u{2709} Agent inbox \u{b7} 3 new messages"),
        "the arrival summary line renders: {last}"
    );
    assert!(
        last.contains("\u{2709} Agent inbox \u{b7} 3 unread messages"),
        "the reminder summary line renders: {last}"
    );
    // The expanded bodies render under the gutter: the counts and the
    // read call-to-action.
    assert!(
        last.contains(&guttered_head(arrival_text)),
        "the arrival body renders guttered: {last}"
    );
    assert!(
        last.contains(&guttered_head(reminder_text)),
        "the reminder body renders guttered: {last}"
    );
    assert!(
        last.contains("rlm.inbox.read()"),
        "the read hint stays visible: {last}"
    );
    // The user message keeps its user block; the notices render only in
    // their own guttered class, never as typed user input.
    assert!(
        last.contains("start the detached handle and finish"),
        "the user message still renders: {last}"
    );
    for row in last.split('\n') {
        if row.contains("[inbox") {
            assert!(
                row.contains("\u{2570}\u{2500}"),
                "the notice text renders only in its own guttered class: {row}"
            );
        }
    }

    // Teardown: stop the session through the live supervisor so the
    // worker (and its kernel + sleeper) does not leak past the test.
    client.request(
        "k1",
        &json!({ "type": "kill", "activeSessionId": active_id }),
    );
    drop(client);
    drop(supervisor);
}
