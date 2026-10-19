// Casts: bounded fixture arithmetic.
#![allow(
    clippy::too_many_lines,
    clippy::large_futures,
    clippy::cast_possible_truncation
)]

//! Long-session transcript scrolling through a real daemon: a session file with
//! thousands of rows and a compaction, attached headlessly and scrolled to the top.
#![cfg(unix)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use pa_types::daemon::DaemonCommand;
use serde_json::{json, Value};

/// Turns in the fixture; each turn writes a user prompt, a tool-calling assistant
/// message, its tool result, and a closing assistant message.
const TURNS: usize = 900;
/// The compaction lands after this turn and keeps the last ten turns before it.
const COMPACTED_AFTER_TURN: usize = 600;
const FIRST_KEPT_TURN: usize = 590;
const SUMMARY_TEXT: &str = "fixture compaction summary";

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        use std::io::{BufRead, BufReader, Write};
        if let Ok(stream) = std::os::unix::net::UnixStream::connect(&self.socket) {
            if let Ok(mut writer) = stream.try_clone() {
                let mut reader = BufReader::new(stream);
                let mut hello = String::new();
                let _ = reader.read_line(&mut hello);
                let command = json!({
                    "type": "command", "id": "test-shutdown",
                    "protocol": { "name": "prime-agent.daemon", "version": 7 },
                    "command": { "type": "shutdown" },
                });
                let _ = writeln!(writer, "{command}");
                let _ = reader
                    .get_ref()
                    .set_read_timeout(Some(Duration::from_secs(5)));
                let mut response = String::new();
                let _ = reader.read_line(&mut response);
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(dir: &Path) -> Supervisor {
    let socket = dir.join("daemon.sock");
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", dir.join("agent"))
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

fn marker(turn: usize) -> String {
    format!("turn-{turn:05}")
}

/// The fixture session file: `TURNS` tool-calling turns with one compaction.
fn write_long_session(path: &Path, id: &str) {
    let mut out = String::new();
    let mut line = |value: Value| {
        out.push_str(&value.to_string());
        out.push('\n');
    };
    line(json!({
        "type": "session", "version": 3, "id": id,
        "timestamp": "2026-01-01T00:00:00.000Z", "cwd": "/tmp",
    }));
    let mut parent: Option<String> = None;
    let mut counter = 0u32;
    let mut entry = |parent: &mut Option<String>, body: Value| -> Value {
        counter += 1;
        let id = format!("{counter:08x}");
        let mut value = json!({
            "id": id, "parentId": parent.clone(),
            "timestamp": "2026-01-01T00:00:00.000Z",
        });
        for (key, field) in body.as_object().expect("entry body") {
            value[key] = field.clone();
        }
        *parent = Some(id);
        value
    };
    let mut first_kept = String::new();
    for turn in 0..TURNS {
        let mark = marker(turn);
        let ts = 1_000 + turn as u64 * 10;
        let user = entry(
            &mut parent,
            json!({"type": "message", "message": {
                "role": "user", "content": format!("{mark} question"), "timestamp": ts,
            }}),
        );
        if turn == FIRST_KEPT_TURN {
            first_kept = user["id"].as_str().expect("id").to_string();
        }
        line(user);
        let call_id = format!("call-{turn}");
        line(entry(
            &mut parent,
            json!({"type": "message", "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": format!("{mark} looking")},
                    {"type": "toolCall", "id": call_id, "name": "bash",
                     "arguments": {"command": format!("echo {mark}")}},
                ],
                "stopReason": "toolUse", "timestamp": ts + 1,
            }}),
        ));
        line(entry(
            &mut parent,
            json!({"type": "message", "message": {
                "role": "toolResult", "toolCallId": call_id, "toolName": "bash",
                "content": [{"type": "text", "text": format!("{mark} output")}],
                "isError": false, "timestamp": ts + 2,
            }}),
        ));
        line(entry(
            &mut parent,
            json!({"type": "message", "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": format!("{mark} answer")}],
                "stopReason": "stop", "timestamp": ts + 3,
            }}),
        ));
        if turn == COMPACTED_AFTER_TURN {
            line(entry(
                &mut parent,
                json!({
                    "type": "compaction", "summary": SUMMARY_TEXT,
                    "firstKeptEntryId": first_kept, "tokensBefore": 123_456,
                }),
            ));
        }
    }
    std::fs::write(path, out).expect("write long session");
}

async fn create_session_from_file(socket: &Path, dir: &Path, session_path: &Path) -> String {
    let script_path = dir.join("script.json");
    std::fs::write(&script_path, json!({ "responses": ["ok"] }).to_string()).expect("write script");
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(socket)
        .await
        .expect("connect supervisor");
    let data = client
        .request_ok(DaemonCommand::Create {
            id: None,
            session_path: Some(session_path.display().to_string()),
            continue_recent: None,
            no_session: None,
            name: None,
            config: Some(json!({
                "cwd": dir.display().to_string(),
                "sessionDir": session_path.parent().expect("session dir").display().to_string(),
                "script": script_path.display().to_string(),
            })),
            telemetry_disabled: None,
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: serde_json::Map::default(),
        })
        .await
        .expect("create session from file");
    client.close();
    data.get("activeSessionId")
        .or_else(|| data.get("id"))
        .and_then(Value::as_str)
        .expect("session id")
        .to_string()
}

fn chat_options(socket: &Path, dir: &Path, active: String) -> InteractiveOptions {
    InteractiveOptions {
        models: None,
        socket_path: socket.to_path_buf(),
        cwd: dir.to_path_buf(),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: SessionSelection::Attach(active),
        initial_message: None,
        show_images: true,
        fullscreen_mouse: true,
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

struct LongSession {
    _dir: tempfile::TempDir,
    supervisor: Supervisor,
    dir: PathBuf,
    active: String,
}

async fn open_long_session() -> LongSession {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let session_dir = dir.path().join("agent").join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let durable = "01a0tw-000000000001";
    let path = session_dir.join(format!("{durable}.jsonl"));
    write_long_session(&path, durable);
    let active = create_session_from_file(&supervisor.socket, dir.path(), &path).await;
    LongSession {
        dir: dir.path().to_path_buf(),
        _dir: dir,
        supervisor,
        active,
    }
}

async fn run_plan(session: &LongSession, steps: Vec<HeadlessStep>, height: u16) -> Vec<String> {
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height,
    };
    run_interactive(
        chat_options(
            &session.supervisor.socket,
            &session.dir,
            session.active.clone(),
        ),
        UiMode::Headless(plan),
    )
    .await
    .expect("interactive run")
    .frames
}

fn key(code: crossterm::event::KeyCode) -> HeadlessStep {
    HeadlessStep::Key(crossterm::event::KeyEvent::new(
        code,
        crossterm::event::KeyModifiers::NONE,
    ))
}

/// The turn markers of a frame, top to bottom, one per run of rows.
fn turn_markers(frame: &str) -> Vec<usize> {
    let mut seen: Vec<usize> = Vec::new();
    for token in frame.split(|c: char| !c.is_ascii_alphanumeric() && c != '-') {
        if let Some(turn) = token.strip_prefix("turn-").and_then(|t| t.parse().ok()) {
            if seen.last() != Some(&turn) {
                seen.push(turn);
            }
        }
    }
    seen
}

/// `batches` repetitions of `key`, pausing between batches so arrived pages apply
/// between keystrokes as they do for a user.
fn paced_keys(code: crossterm::event::KeyCode, batches: usize) -> Vec<HeadlessStep> {
    let mut steps = Vec::new();
    for _ in 0..batches {
        steps.extend((0..5).map(|_| key(code)));
        steps.push(HeadlessStep::WaitMs(60));
    }
    steps
}

fn attached() -> Vec<HeadlessStep> {
    vec![HeadlessStep::WaitRender {
        needle: marker(TURNS - 1),
        timeout_ms: 10_000,
    }]
}

const SUMMARY_ROW: &str = "Context compacted";

#[tokio::test]
async fn the_top_of_a_long_session_is_its_first_message_across_a_compaction() {
    let session = open_long_session().await;
    // The top key jumps to the session start.
    let mut steps = attached();
    steps.push(HeadlessStep::ScrollTop);
    steps.push(HeadlessStep::WaitRender {
        needle: marker(0),
        timeout_ms: 10_000,
    });
    let frames = run_plan(&session, steps, 40).await;
    let last = frames.last().expect("frames rendered");
    assert_eq!(
        turn_markers(last).first(),
        Some(&0),
        "the top key must reach the session's first message:\n{last}"
    );
    // Paging walks there too, through the compaction.
    let mut steps = attached();
    steps.extend(paced_keys(crossterm::event::KeyCode::PageUp, 200));
    let frames = run_plan(&session, steps, 40).await;
    let last = frames.last().expect("frames rendered");
    assert_eq!(
        turn_markers(last).first(),
        Some(&0),
        "paging up must reach the session's first message:\n{last}"
    );
    assert!(
        frames.iter().any(|frame| frame.contains(SUMMARY_ROW)),
        "the climb passed the compaction summary"
    );
}

#[tokio::test]
async fn the_compaction_summary_renders_once_across_eviction_and_refetch() {
    let session = open_long_session().await;
    // Climb far enough above the compaction that its chunk is evicted, then descend
    // past it again so it is refetched.
    let mut steps = attached();
    steps.extend(paced_keys(crossterm::event::KeyCode::PageUp, 90));
    steps.extend(paced_keys(crossterm::event::KeyCode::PageDown, 75));
    let frames = run_plan(&session, steps, 40).await;
    let highest = frames
        .iter()
        .enumerate()
        .min_by_key(|(_, frame)| turn_markers(frame).first().copied().unwrap_or(usize::MAX))
        .map(|(index, _)| index)
        .expect("frames rendered");
    let highest_turn = turn_markers(&frames[highest])[0];
    assert!(
        highest_turn + 300 < COMPACTED_AFTER_TURN,
        "the climb must pass the compaction by more than the resident window, \
         reached turn {highest_turn}:\n{}",
        frames[highest]
    );
    for (index, frame) in frames.iter().enumerate() {
        assert!(
            frame.matches(SUMMARY_ROW).count() <= 1,
            "frame {index} renders the compaction summary twice:\n{frame}"
        );
        let mut rows = HashSet::new();
        for line in frame.lines().filter(|line| line.contains("turn-")) {
            assert!(
                rows.insert(line.trim()),
                "frame {index} renders the row {line:?} twice:\n{frame}"
            );
        }
    }
    // At the boundary the summary sits once between the last compacted turn and the
    // first later one, on the way up and again on the way back down.
    let boundary = |frame: &str| {
        let before = frame.find(&format!("{} answer", marker(COMPACTED_AFTER_TURN)));
        let summary = frame.find(SUMMARY_ROW);
        let after = frame.find(&format!("{} question", marker(COMPACTED_AFTER_TURN + 1)));
        matches!((before, summary, after), (Some(b), Some(s), Some(a)) if b < s && s < a)
            && frame.matches(SUMMARY_ROW).count() == 1
    };
    assert!(
        frames[..highest].iter().any(|frame| boundary(frame)),
        "the climb shows the summary once at its boundary"
    );
    assert!(
        frames[highest..].iter().any(|frame| boundary(frame)),
        "the descent shows the refetched summary once at its boundary: {}",
        frames.last().map_or("", String::as_str)
    );
}
