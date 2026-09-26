//! Headless e2e for the tray model label's effort suffix (TS
//! `getModelContextLabel`'s `model:effort` arm): a mock supervisor serves
//! one attached session whose state reports the model's reasoning and the
//! live thinking level, and the plan drives `/effort` through the same
//! editor submit path a user's keystrokes take.
//!
//! Verifies the parity contract: the tray under the prompt bar renders
//! `model:effort` while the session's model supports reasoning, keeps the
//! bare model id when it does not, and the label follows a `/effort`
//! switch live.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// The session the mock serves: the `model` state block (with its
/// `reasoning` flag), the available thinking levels, and the live level
/// (the value `set_thinking_level` moves). `fail_state_after_switch`
/// makes every state read AFTER a thinking switch fail, pinning the
/// client's failed-read fallback (no stale suffix survives a switch).
struct MockSession {
    model: Value,
    levels: Vec<String>,
    level: String,
    fail_state_after_switch: bool,
}

/// A reasoning model at the default level (the engine's `medium`, TS
/// `DEFAULT_THINKING_LEVEL`).
fn reasoning_session() -> MockSession {
    MockSession {
        model: json!({ "id": "glm-5.3", "name": "GLM 5.3", "provider": "zai", "reasoning": true }),
        levels: vec![
            "off".to_string(),
            "minimal".to_string(),
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
        ],
        level: "medium".to_string(),
        fail_state_after_switch: false,
    }
}

/// A model without reasoning: the daemon clamps its level to "off".
fn plain_session() -> MockSession {
    MockSession {
        model: json!({
            "id": "gpt-4o-mini",
            "name": "GPT 4o mini",
            "provider": "openai",
            "reasoning": false
        }),
        levels: vec!["off".to_string()],
        level: "off".to_string(),
        fail_state_after_switch: false,
    }
}

impl MockSession {
    fn bind(self, socket: &std::path::Path) -> MockSupervisor {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            session: self,
        }
    }
}

/// One mock supervisor serving a single attached session: the state
/// blocks report the session's model and live level, and
/// `set_thinking_level` moves that level so the client's state re-reads
/// observe the switch.
struct MockSupervisor {
    listener: UnixListener,
    session: MockSession,
}

impl MockSupervisor {
    /// Serve one connection: attach an empty session, then answer the
    /// state reads and the thinking switch off the live level.
    fn serve(mut self) {
        // Armed by `set_thinking_level` when the session pins the
        // failed-read fallback: every later state read refuses.
        let mut state_reads_fail = false;
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
                "create" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "create",
                            "success": true,
                            "data": {
                                "activeSessionId": "s1",
                                "id": "s1",
                                "sessionId": "sess-1",
                                "sessionFile": "/tmp/sess-1.jsonl",
                            },
                        }),
                    );
                }
                "attach" => {
                    write_json(&mut writer, &self.attach_data(id));
                }
                "get_state" | "get_connection_state" => {
                    if state_reads_fail {
                        write_json(
                            &mut writer,
                            &json!({
                                "type": "response",
                                "id": id,
                                "command": command_type,
                                "success": false,
                                "error": "the state read failed",
                            }),
                        );
                    } else {
                        write_json(&mut writer, &self.state_data(id, &command_type));
                    }
                }
                "set_thinking_level" => {
                    if let Some(level) = command.get("level").and_then(Value::as_str) {
                        self.session.level = level.to_string();
                    }
                    state_reads_fail = self.session.fail_state_after_switch;
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "set_thinking_level",
                            "success": true,
                            "data": null,
                        }),
                    );
                }
                "detach" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "detach",
                            "success": true,
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

    /// The slim attach result: one empty session whose state reports the
    /// model and its thinking level (the tray label's inputs).
    fn attach_data(&self, id: &str) -> Value {
        json!({
            "type": "response",
            "id": id,
            "command": "attach",
            "success": true,
            "data": {
                "protocol": { "name": "prime-agent.daemon", "version": 7 },
                "activeSessionId": "s1",
                "snapshot": {
                    "activeSessionId": "s1",
                    "summary": { "id": "s1", "cwd": "/tmp" },
                    "state": {
                        "activeSessionId": "s1",
                        "cwd": "/tmp",
                        "sessionId": "sess-1",
                        "sessionName": "effort session",
                        "model": self.session.model,
                        "thinkingLevel": self.session.level,
                        "availableThinkingLevels": self.session.levels,
                        "serviceTier": "auto",
                        "isStreaming": false,
                        "isCompacting": false,
                        "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                    },
                    "messages": [],
                    "lastEventSequence": 0,
                    "lastEventCursor": null,
                },
                "client": { "id": "mock", "capabilities": [] },
                "lastEventSequence": 0,
                "lastEventCursor": null,
            },
        })
    }

    /// The live session state (the `get_state`/`get_connection_state`
    /// data block): the model with its reasoning flag and the level
    /// `/effort` writes.
    fn state_data(&self, id: &str, command: &str) -> Value {
        json!({
            "type": "response",
            "id": id,
            "command": command,
            "success": true,
            "data": {
                "model": self.session.model,
                "thinkingLevel": self.session.level,
                "availableThinkingLevels": self.session.levels,
                "isStreaming": false,
                "isCompacting": false,
                "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
            },
        })
    }
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

fn options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
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
        session: SessionSelection::New,
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
        client_settings: None,
    }
}

/// Run the headless plan against a fresh mock supervisor and return the
/// captured frames.
fn run_plan(session: MockSession, steps: Vec<HeadlessStep>) -> Vec<String> {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = session.bind(&socket);
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
    outcome.frames
}

/// `/effort` moves the tray's `model:effort` label live: the attach state
/// seeds `glm-5.3:medium`, the switch's level lands as `glm-5.3:high`,
/// and the frame that reports the switch carries the new label only.
#[test]
fn effort_command_moves_the_tray_model_label() {
    let steps = vec![
        HeadlessStep::Submit("/effort high".to_string()),
        HeadlessStep::WaitRender {
            needle: "glm-5.3:high".to_string(),
            timeout_ms: 10_000,
        },
        HeadlessStep::WaitMs(200),
    ];
    let frames = run_plan(reasoning_session(), steps);
    assert!(
        frames.iter().any(|frame| frame.contains("glm-5.3:medium")),
        "the attach state seeds the level suffix:\n{}",
        frames.join("\n---\n")
    );
    let switched = frames
        .iter()
        .rev()
        .find(|frame| frame.contains("Thinking level: high"))
        .expect("the switch's status note rendered");
    assert!(
        switched.contains("glm-5.3:high"),
        "the tray label follows the switch:\n{switched}"
    );
    assert!(
        !switched.contains("glm-5.3:medium"),
        "the pre-switch label is gone:\n{switched}"
    );
}

/// A successful `/effort` switch whose state re-read fails still moves the
/// label: the requested level renders (TS `applyThinkingLevel` patches the
/// connection state with the requested level), never the previous model's
/// stale suffix.
#[test]
fn effort_switch_with_failed_state_read_never_keeps_the_stale_suffix() {
    let mut session = reasoning_session();
    session.fail_state_after_switch = true;
    let steps = vec![
        HeadlessStep::Submit("/effort high".to_string()),
        HeadlessStep::WaitRender {
            needle: "Thinking level: high".to_string(),
            timeout_ms: 10_000,
        },
        HeadlessStep::WaitMs(200),
    ];
    let frames = run_plan(session, steps);
    let switched = frames
        .iter()
        .rev()
        .find(|frame| frame.contains("Thinking level: high"))
        .expect("the switch's status note rendered");
    assert!(
        switched.contains("glm-5.3:high"),
        "the failed read falls back to the requested level:\n{switched}"
    );
    assert!(
        !switched.contains("glm-5.3:medium"),
        "the pre-switch suffix never survives a switch:\n{switched}"
    );
}

/// A model without reasoning renders the bare id: the state's level is
/// "off" but the tray never carries a suffix.
#[test]
fn tray_label_stays_bare_without_reasoning() {
    let steps = vec![HeadlessStep::WaitRender {
        needle: "gpt-4o-mini".to_string(),
        timeout_ms: 10_000,
    }];
    let frames = run_plan(plain_session(), steps);
    let all = frames.join("\n---\n");
    assert!(
        frames.iter().any(|frame| frame.contains("gpt-4o-mini")),
        "the bare model id renders in the tray:\n{all}"
    );
    assert!(
        !all.contains("gpt-4o-mini:"),
        "a model without reasoning never carries an effort suffix:\n{all}"
    );
}
