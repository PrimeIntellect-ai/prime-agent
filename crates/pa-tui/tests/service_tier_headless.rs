//! Headless e2e for the `/tier` service-tier command (TS #2144's UX half):
//! a mock supervisor serves one attached session with an OpenRouter
//! completions model, and the plan drives the command through the same
//! editor submit path a user's keystrokes take.
//!
//! Verifies the TS parity contract: `/tier` without an argument reports the
//! current tier and the available ones; a tier the model does not support
//! errors with the available list; a supported tier applies through the
//! daemon `set_service_tier` switch and reports the applied tier; and the
//! tray badge shows the non-default tier (`fast` for priority).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: attach an OpenRouter-model session, answer
    /// `set_service_tier`, and report the applied tier on `get_state`.
    fn serve(self) {
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
                    write_json(&mut writer, &attach_data(id));
                }
                "set_service_tier" => {
                    // The daemon arm answers success with no data; the
                    // follow-up get_state read reports the applied tier.
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "set_service_tier",
                            "success": true,
                            "data": {},
                        }),
                    );
                }
                "get_state" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_state",
                            "success": true,
                            "data": {
                                "activeSessionId": "s1",
                                "sessionId": "sess-1",
                                "serviceTier": "flex",
                                "steeringMode": "one-at-a-time",
                                "model": { "id": "openai/gpt-5.5", "provider": "openrouter" },
                                "isStreaming": false,
                            },
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
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The slim attach result: one session on an OpenRouter completions model
/// (the catalog entry the eligibility predicate reads).
fn attach_data(id: &str) -> Value {
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
                    "sessionName": "tier session",
                    "model": { "id": "openai/gpt-5.5", "provider": "openrouter" },
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

/// The OpenRouter catalog entry: completions API, so flex and priority are
/// both eligible for the model.
fn openrouter_catalog() -> Vec<pa_types::ai::Model> {
    serde_json::from_value(json!({
        "id": "openai/gpt-5.5",
        "name": "OpenAI: GPT-5.5",
        "api": "openai-completions",
        "provider": "openrouter",
        "baseUrl": "https://openrouter.ai/api/v1",
        "reasoning": true,
        "input": ["text"],
        "cost": { "input": 5, "output": 30, "cacheRead": 0.5, "cacheWrite": 0 },
        "contextWindow": 272_000,
        "maxTokens": 128_000
    }))
    .map(|model| vec![model])
    .expect("catalog model")
}

fn options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: openrouter_catalog(),
        model_configured_providers: Default::default(),
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
        prompt_stash: Default::default(),
        session_has_children: false,
        client_settings: None,
    }
}

/// Run the headless plan against a fresh mock supervisor and return the
/// captured frames.
fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
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

/// `/tier` reports the current tier with the available ones; an
/// unsupported tier errors with the available list; a supported tier
/// applies through the daemon switch, reports the applied tier, and the
/// tray badge shows it.
#[test]
fn tier_command_shows_applies_and_rejects() {
    // The leading settle (the sibling harnesses' pattern): the attach
    // must land its model + provider before the first submit reads them.
    let steps = vec![
        HeadlessStep::WaitMs(400),
        HeadlessStep::Submit("/tier".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/tier scale".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/tier flex".to_string()),
        HeadlessStep::WaitMs(300),
    ];
    let frames = run_plan(steps);
    assert!(!frames.is_empty(), "frames were captured");
    let all = frames.join("\n");
    // No argument: the current tier with the model's available tiers.
    assert!(
        all.contains("Service tier: default (available: default, flex, priority)"),
        "the show note rendered:\n{all}"
    );
    // `scale` is not a user-facing choice: the TS error lists the
    // available tiers.
    assert!(
        all.contains(
            "Service tier 'scale' is not available for the current model. Available: default, flex, priority"
        ),
        "the unsupported error rendered:\n{all}"
    );
    // `flex` applies through the daemon switch; the state refresh reports
    // the applied tier and the tray badge shows it.
    assert!(
        all.contains("Service tier: flex"),
        "the applied-tier note rendered:\n{all}"
    );
    assert!(
        frames
            .iter()
            .any(|frame| frame.contains("openai/gpt-5.5 \u{00b7} flex")),
        "the tray badge rendered the applied tier:\n{all}"
    );
}
