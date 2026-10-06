//! Headless e2e for the `/model` picker's current-model resolution across
//! providers: with the session on `prime-inference/z-ai/glm-5.3` and the
//! catalog listing the SAME id under openrouter too, the picker must
//! resolve the session's OWN provider's entry, not the openrouter row.
#![cfg(unix)]
// Casts: structurally bounded terminal-layout arithmetic; guarded conversions add panic paths.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Render routes are flat tables (one arm per route); splitting adds indirection.
#![allow(clippy::too_many_lines)]
// Widget state structs carry independent flag bits.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// Futures are bounded by the surface's lifetime; boxing adds a steady-state allocation.
#![allow(clippy::large_futures)]
// The wrappers preserve a uniform Result-returning API surface.
#![allow(clippy::unnecessary_wraps)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use pa_types::ai::Model;
use serde_json::{json, Value};

/// One catalog model: the id `z-ai/glm-5.3` under a provider, with a provider-distinct name so the
/// picker's rows identify by name.
fn duplicate_id_model(provider: &str, name: &str) -> Model {
    serde_json::from_value(json!({
        "id": "z-ai/glm-5.3", "name": name, "api": "openai-completions", "provider": provider,
        "baseUrl": "https://example.invalid/v1", "reasoning": false,
        "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128_000, "maxTokens": 4096,
    }))
    .expect("mock model deserializes")
}

/// The catalog the daemon serves and the run opens with: openrouter's z-ai/glm-5.3 entry FIRST,
/// prime-inference's second — the first-match order the id-only find resolved from before the fix.
fn duplicate_id_catalog() -> Vec<Model> {
    vec![
        duplicate_id_model("openrouter", "GLM 5.3 Open"),
        duplicate_id_model("prime-inference", "GLM 5.3 Prime"),
    ]
}

/// The mock supervisor: one attached session whose state reports `prime-inference/z-ai/glm-5.3`,
/// serving the duplicate-id catalog to both the startup snapshot and the refresh.
struct MockSupervisor {
    listener: UnixListener,
    catalog: Vec<Model>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path, catalog: Vec<Model>) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            catalog,
        }
    }

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
                    write_json(&mut writer, &Self::attach_data(id));
                }
                "get_model_catalog" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_model_catalog",
                            "success": true,
                            "data": {
                                "models": self.catalog,
                                "configuredProviders": ["prime-inference", "openrouter"],
                            },
                        }),
                    );
                }
                "get_state" | "get_connection_state" => {
                    write_json(&mut writer, &Self::state_data(id, &command_type));
                }
                "prompt" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "prompt",
                            "success": true,
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

    /// The slim attach result: the state carries the current model identity — the id AND the
    /// provider (`state.model.provider`).
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
                        "sessionName": "provider session",
                        "model": { "id": "z-ai/glm-5.3", "provider": "prime-inference" },
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

    /// The live session state: the same prime-inference model identity.
    fn state_data(id: &str, command: &str) -> Value {
        json!({
            "type": "response",
            "id": id,
            "command": command,
            "success": true,
            "data": {
                "model": { "id": "z-ai/glm-5.3", "provider": "prime-inference" },
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

fn options(socket: PathBuf, catalog: Vec<Model>) -> InteractiveOptions {
    // The startup snapshot mirrors the daemon's `get_model_catalog` answer exactly: the background
    // refresh can land before or after the picker opens; either snapshot must render the same rows.
    let mut configured_providers = std::collections::HashSet::new();
    configured_providers.insert("prime-inference".to_string());
    configured_providers.insert("openrouter".to_string());
    InteractiveOptions {
        models: None,
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: catalog,
        model_configured_providers: configured_providers,
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
        restore_dock_focus: false,
        client_settings: None,
    }
}

fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket, duplicate_id_catalog());
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
        .block_on(run_interactive(
            options(socket, duplicate_id_catalog()),
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

/// The operator's duplicate-id repro: the session runs `prime-inference/z-ai/glm-5.3`, the catalog
/// lists the same id under openrouter FIRST — the prime-inference row carries `current`.
#[test]
fn the_picker_marks_the_sessions_own_provider_current() {
    let frames = run_plan(vec![
        HeadlessStep::Submit("/model".to_string()),
        HeadlessStep::WaitRender {
            needle: "GLM 5.3 Prime".to_string(),
            timeout_ms: 30_000,
        },
    ]);
    let last = frames.last().expect("a frame with the picker open");
    let rows: Vec<&str> = last.split('\n').collect();
    let prime_row = rows
        .iter()
        .find(|row| row.contains("GLM 5.3 Prime"))
        .expect("the prime-inference row renders");
    assert!(
        prime_row.contains("current") && prime_row.contains("prime-inference"),
        "the session's own provider's row is the current model: {prime_row}"
    );
    assert!(
        prime_row.starts_with("\u{203a}"),
        "the selection band lands on the session's own provider's row: {prime_row}"
    );
    let open_row = rows
        .iter()
        .find(|row| row.contains("GLM 5.3 Open"))
        .expect("the openrouter row renders");
    assert!(
        !open_row.contains("current"),
        "another provider's same-id row is NOT the current model: {open_row}"
    );
    assert!(
        !open_row.starts_with("\u{203a}"),
        "another provider's same-id row is NOT selected: {open_row}"
    );
}
