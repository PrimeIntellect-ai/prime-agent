//! Headless e2e for the interrupt between two LLM turns of one agent run: the
//! wire `turn_end` closes one model turn, not the run (`agent_end` does), so
//! Escape after a tool turn's `turn_end` must still abort the running agent.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// The session rename that lands after the tool turn's `turn_end`: once it
/// renders, every earlier frame of the run has been applied.
const GAP_MARKER: &str = "between turns";

/// Serve one client connection: the attach starts a run whose first LLM turn
/// (a tool call) ends; the run's `agent_end` follows only an abort.
fn serve(listener: &UnixListener, commands: &Mutex<Vec<String>>) {
    let (stream, _) = listener.accept().expect("accept");
    let mut writer = stream.try_clone().expect("clone mock socket");
    let mut reader = BufReader::new(stream);
    write_json(
        &mut writer,
        &json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": [],
            "clientId": "mock",
        }),
    );
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
        let command = envelope
            .pointer("/command/type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        commands.lock().unwrap().push(command.clone());
        let data = match command.as_str() {
            "create" => json!({
                "activeSessionId": "s1",
                "id": "s1",
                "sessionId": "sess-1",
                "sessionFile": "/tmp/sess-1.jsonl",
            }),
            "attach" => attach_data(),
            _ => json!({}),
        };
        write_json(
            &mut writer,
            &json!({ "type": "response", "id": id, "command": command, "success": true, "data": data }),
        );
        match command.as_str() {
            "attach" => {
                for event in first_tool_turn() {
                    write_session_event(&mut writer, &event);
                }
            }
            "abort" => write_session_event(&mut writer, &json!({ "type": "agent_end" })),
            _ => {}
        }
    }
}

/// The run's opening frames up to the gap after its first LLM turn.
fn first_tool_turn() -> Vec<Value> {
    let assistant = json!({
        "role": "assistant",
        "content": [
            { "type": "text", "text": "Listing the files." },
            { "type": "toolCall", "id": "call-1", "name": "bash", "arguments": { "command": "ls" } },
        ],
        "stopReason": "toolUse",
        "timestamp": 1,
    });
    vec![
        json!({ "type": "agent_start" }),
        json!({ "type": "turn_start" }),
        json!({ "type": "message_end", "message": assistant }),
        json!({ "type": "tool_execution_start", "toolCallId": "call-1", "toolName": "bash", "args": { "command": "ls" } }),
        json!({
            "type": "tool_execution_end",
            "toolCallId": "call-1",
            "result": { "content": [{ "type": "text", "text": "a.txt" }] },
            "isError": false,
        }),
        json!({ "type": "turn_end", "message": assistant, "toolResults": [] }),
        json!({ "type": "session_info_changed", "name": GAP_MARKER }),
    ]
}

fn attach_data() -> Value {
    json!({
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "activeSessionId": "s1",
        "snapshot": {
            "activeSessionId": "s1",
            "summary": { "id": "s1", "cwd": "/tmp" },
            "state": {
                "activeSessionId": "s1",
                "cwd": "/tmp",
                "sessionId": "sess-1",
                "sessionName": "turn gap",
                "model": null,
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
    })
}

fn write_session_event(writer: &mut UnixStream, event: &Value) {
    write_json(
        writer,
        &json!({ "type": "session_event", "activeSessionId": "s1", "event": event }),
    );
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
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

#[test]
fn escape_between_two_llm_turns_aborts_the_run() {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let listener = UnixListener::bind(&socket).expect("bind mock socket");
    let commands = Arc::new(Mutex::new(Vec::new()));
    let mock_log = Arc::clone(&commands);
    let server = std::thread::spawn(move || serve(&listener, &mock_log));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::WaitRender {
                needle: GAP_MARKER.to_string(),
                timeout_ms: 10_000,
            },
            HeadlessStep::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            HeadlessStep::WaitIdle { timeout_ms: 10_000 },
        ],
        width: 100,
        height: 30,
    };
    runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    server.join().expect("mock supervisor finished");
    let commands = commands.lock().unwrap().clone();
    assert!(
        commands.iter().any(|command| command == "abort"),
        "Escape after the tool turn's turn_end must abort the still-running agent: {commands:?}"
    );
}
