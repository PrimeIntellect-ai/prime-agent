#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

const BACKFILL_DELAY_MS: u64 = 300;
const HISTORY_MESSAGES: usize = 4;

struct MockSupervisor {
    listener: UnixListener,
    windowed: bool,
    failures: usize,
    requests: Arc<Mutex<Vec<Value>>>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, windowed: bool, requests: Arc<Mutex<Vec<Value>>>) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            windowed,
            failures: 0,
            requests,
        }
    }

    fn serve(mut self) {
        let (stream, _) = self.listener.accept().expect("accept");
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = BufReader::new(stream);

        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": [],
            "clientId": "mock",
        });
        write_json(&mut writer, &hello);

        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Ok(envelope) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            let id = envelope.get("id").and_then(Value::as_str).unwrap_or("");
            let command = envelope.get("command").cloned().unwrap_or(Value::Null);
            let command_type = command
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match command_type.as_str() {
                "attach" => {
                    write_json(&mut writer, &attach_response(id, self.windowed));
                }
                "get_messages" => {
                    self.requests.lock().unwrap().push(command.clone());
                    if self.failures > 0 {
                        self.failures -= 1;
                        write_json(
                            &mut writer,
                            &json!({
                                "type": "response", "id": id, "command": "get_messages",
                                "success": false, "error": "temporary backfill rejection",
                            }),
                        );
                        continue;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(BACKFILL_DELAY_MS));
                    write_json(&mut writer, &get_messages_response(id, self.windowed));
                }
                "get_session_stats" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_session_stats",
                            "success": true,
                            "data": {
                                "contextUsage": { "tokens": 1200, "contextWindow": 200_000 },
                                "cost": 0.01,
                            },
                        }),
                    );
                }
                _ => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": command_type,
                            "success": true,
                            "data": {},
                        }),
                    );
                }
            }
        }
    }
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

fn message(index: usize) -> Value {
    let marker = format!("msg-{index:02}");
    let body =
        format!("{marker} line one\n{marker} line two\n{marker} line three\n{marker} line four");
    let timestamp = 100 + index;
    if index.is_multiple_of(2) {
        json!({ "role": "user", "content": body, "timestamp": timestamp })
    } else {
        json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": body }],
            "timestamp": timestamp,
        })
    }
}

fn all_messages() -> Vec<Value> {
    (0..16).map(message).collect()
}

fn attach_response(id: &str, windowed: bool) -> Value {
    let messages = all_messages();
    let (snapshot_messages, history_before) = if windowed {
        (messages[4..].to_vec(), json!(4u64))
    } else {
        (messages, Value::Null)
    };
    let mut snapshot = json!({
        "activeSessionId": "s1",
        "summary": { "id": "s1", "cwd": "/tmp" },
        "state": {
            "activeSessionId": "s1",
            "cwd": "/tmp",
            "sessionId": "sess-1",
            "sessionName": "backfill probe",
            "model": "faux-1",
            "isStreaming": false,
            "isCompacting": false,
            "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
        },
        "messages": snapshot_messages,
        "lastEventSequence": 0,
        "lastEventCursor": null,
    });
    if windowed {
        snapshot["historyBefore"] = history_before;
        snapshot["lastUserPromptMs"] = json!(114u64);
    }
    json!({
        "type": "response",
        "id": id,
        "command": "attach",
        "success": true,
        "data": {
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": "s1",
            "snapshot": snapshot,
            "replay": { "status": "complete", "toSequence": 0 },
            "lastEventSequence": 0,
            "lastEventCursor": null,
            "client": { "id": "mock", "capabilities": [] },
        },
    })
}

fn get_messages_response(id: &str, windowed: bool) -> Value {
    let messages = if windowed {
        all_messages()[..4].to_vec()
    } else {
        Vec::new()
    };
    json!({
        "type": "response",
        "id": id,
        "command": "get_messages",
        "success": true,
        "data": { "messages": messages },
    })
}

fn options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        models: None,
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session: SessionSelection::Attach("s1".to_string()),
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

fn run_attached(windowed: bool, steps: Vec<HeadlessStep>) -> (Vec<String>, Vec<Value>) {
    run_attached_with_failures(windowed, /*failures*/ 0, steps)
}

fn run_attached_with_failures(
    windowed: bool,
    failures: usize,
    steps: Vec<HeadlessStep>,
) -> (Vec<String>, Vec<Value>) {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut supervisor = MockSupervisor::bind(&socket, windowed, Arc::clone(&requests));
    supervisor.failures = failures;
    let handle = std::thread::spawn(move || supervisor.serve());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    let requests = requests.lock().unwrap().clone();
    (outcome.frames, requests)
}

fn first_marker_line(frame: &str) -> Option<String> {
    frame
        .lines()
        .find(|line| line.contains("msg-"))
        .map(|line| {
            line.split_whitespace()
                .find(|word| word.starts_with("msg-"))
                .expect("marker token")
                .to_string()
        })
}

#[test]
fn a_windowed_open_backfills_history_above_the_tail() {
    let (frames, requests) = run_attached(
        true,
        vec![
            HeadlessStep::WaitMs(1200),
            HeadlessStep::ScrollTop,
            HeadlessStep::WaitRender {
                needle: "msg-00".to_string(),
                timeout_ms: 5000,
            },
        ],
    );
    assert!(!frames.is_empty(), "frames were captured");
    assert!(
        frames[0].contains("msg-15"),
        "the first frame renders the tail's bottom: {}",
        frames[0]
    );
    assert!(
        !frames[0].contains("msg-00"),
        "the windowed first frame holds no head rows: {}",
        frames[0]
    );
    let final_frame = frames.last().expect("the settled frame renders");
    assert_eq!(
        first_marker_line(final_frame).as_deref(),
        Some("msg-00"),
        "the true top renders the first message: {final_frame}"
    );
    assert_eq!(requests.len(), 1, "exactly one backfill request");
    assert_eq!(
        requests[0]["before"],
        json!(HISTORY_MESSAGES as u64),
        "the backfill requests the omitted history range"
    );
}

#[test]
fn a_full_snapshot_attach_never_backfills() {
    let (frames, requests) = run_attached(
        false,
        vec![
            HeadlessStep::ScrollTop,
            HeadlessStep::WaitRender {
                needle: "msg-00".to_string(),
                timeout_ms: 5000,
            },
        ],
    );
    assert!(!frames.is_empty(), "frames were captured");
    assert!(
        frames[0].contains("msg-15"),
        "the full snapshot's first frame renders the tail: {}",
        frames[0]
    );
    assert!(
        frames.iter().any(|frame| frame.contains("msg-00")),
        "the full history is reachable by scrolling"
    );
    assert!(
        requests.is_empty(),
        "a complete snapshot never backfills: {requests:?}"
    );
}

#[test]
fn a_rejected_backfill_retries_then_reports_incomplete_history() {
    let (frames, requests) = run_attached_with_failures(
        true,
        /*failures*/ 2,
        vec![HeadlessStep::WaitRender {
            needle: "Older history could not be loaded".to_string(),
            timeout_ms: 5000,
        }],
    );
    assert!(frames
        .iter()
        .any(|frame| frame.contains("Older history could not be loaded")));
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], requests[1]);
}
