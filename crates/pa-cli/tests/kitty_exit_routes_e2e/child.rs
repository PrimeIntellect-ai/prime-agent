//! The child half of the kitty-exit self-exec harness: the child-side
//! dispatcher, the replay fixture, the interactive surface options, the
//! mock supervisor, and the wire helpers.
use super::*;

pub(super) fn child_run(route: &str, socket: PathBuf) {
    match route {
        "ctrl_d" | "slash_exit" | "ctrl_c_twice" | "late_answer" | "force_quit"
        | "suspend_resume" => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            runtime.block_on(async move {
                let outcome = run_interactive(child_options(socket), UiMode::Terminal)
                    .await
                    .expect("the chat surface ran");
                assert!(
                    !outcome.return_to_agents_view,
                    "the parity exits end the run"
                );
            });
        }
        "handoff_view_exit" => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            runtime.block_on(async move {
                let options = child_options(socket);
                let outcome = run_interactive(options.clone(), UiMode::Terminal)
                    .await
                    .expect("the chat surface ran");
                assert!(outcome.return_to_agents_view, "the dock-esc detached");
                let view_options = AgentsViewOptions {
                    socket_path: options.socket_path.clone(),
                    cwd: options.cwd.clone(),
                    session_dir: options.session_dir.clone(),
                    theme: options.theme.clone(),
                    version: options.version.clone(),
                    anchor_session_id: (!outcome.session_id.is_empty())
                        .then(|| outcome.session_id.clone()),
                    scope: None,
                    query: None,
                    expanded_ancestors: Vec::new(),
                    selected_row_identity: None,
                    selected_key: None,
                    status_message: outcome.agents_view_notice.clone(),
                    keybindings: options.keybindings.clone(),
                    show_hardware_cursor: false,
                    incident_notice_state: None,
                    create_config: serde_json::json!({}),
                };
                let view_run = run_agents_view(view_options, AgentsViewUiMode::Terminal, None)
                    .await
                    .expect("the agents view ran");
                if let Some(link) = view_run.link {
                    link.close();
                }
            });
        }
        "view_chat_exit" => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            runtime.block_on(async move {
                let options = child_options(socket);
                // The CLI composition's agents-view flow: the view opens,
                // the row's selection hands the pane to the chat, and the
                // chat's parity exit ends the whole app.
                let view_options = AgentsViewOptions {
                    socket_path: options.socket_path.clone(),
                    cwd: options.cwd.clone(),
                    session_dir: options.session_dir.clone(),
                    theme: options.theme.clone(),
                    version: options.version.clone(),
                    anchor_session_id: None,
                    scope: None,
                    query: None,
                    expanded_ancestors: Vec::new(),
                    selected_row_identity: None,
                    selected_key: None,
                    status_message: None,
                    keybindings: options.keybindings.clone(),
                    show_hardware_cursor: false,
                    incident_notice_state: None,
                    create_config: serde_json::json!({}),
                };
                let view_run = run_agents_view(view_options, AgentsViewUiMode::Terminal, None)
                    .await
                    .expect("the agents view ran");
                let Some(selection) = view_run.outcome.selection else {
                    panic!("the harness drove a row open");
                };
                let mut session_options = options.clone();
                session_options.session = selection;
                let outcome = run_interactive(session_options, UiMode::Terminal)
                    .await
                    .expect("the chat surface ran");
                assert!(
                    !outcome.return_to_agents_view,
                    "the parity exit ends the app"
                );
                if let Some(link) = view_run.link {
                    link.close();
                }
            });
        }
        "config_selector" => {
            let rows = vec![
                pa_tui::config_selector::SelectorRow::Group("Resources".to_string()),
                pa_tui::config_selector::SelectorRow::Item {
                    key: "0".to_string(),
                    label: "a-resource".to_string(),
                    checked: true,
                    type_label: "package".to_string(),
                    path: "/tmp/a".to_string(),
                },
            ];
            let selector = pa_tui::config_selector::ConfigSelector::new(rows);
            let theme = pa_tui::app::load_theme("prime");
            let options = pa_tui::config_selector::ConfigSelectorOptions {
                theme,
                keybindings: pa_tui::keybindings::KeybindingsManager::new(),
                auto_exit_ms: Some(2_000),
            };
            let mut on_toggle = |_key: &str, _enabled: bool| Ok(());
            pa_tui::config_selector::run_config_selector(selector, options, &mut on_toggle)
                .expect("the selector ran");
        }
        "replay_auto" => {
            let stream = replay_stream();
            let options = pa_tui::app::AppOptions {
                auto_exit_ms: Some(1_200),
                ..Default::default()
            };
            pa_tui::app::run_app(Box::new(stream), &options, Box::new(|_text| {}))
                .expect("the replay surface ran");
        }
        "replay_panic" => {
            let stream = replay_stream();
            let options = pa_tui::app::AppOptions {
                panic_after_frame: true,
                ..Default::default()
            };
            // The panic is the point: the unwind guard's restore is the
            // route under test. The panic escapes into libtest, which
            // fails the child test with exit 101 — the parent asserts
            // the restore bytes on the stream either way.
            let _ = pa_tui::app::run_app(Box::new(stream), &options, Box::new(|_text| {}));
        }
        other => panic!("unknown route {other}"),
    }
}

/// A tiny replay transcript (the replay surface needs a live session
/// stream): two turns, then End.
fn replay_stream() -> pa_tui::session::JsonlSessionStream {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let path = dir.path().join("replay.jsonl");
    let mut entries = String::new();
    for _ in 0..2 {
        entries.push_str(
            &serde_json::to_string(&json!({
                "type": "message",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "replay row" }],
                    "timestamp": 0u64,
                },
            }))
            .expect("serialize replay entry"),
        );
        entries.push('\n');
    }
    std::fs::write(&path, entries).expect("write replay jsonl");
    std::mem::forget(dir);
    pa_tui::session::JsonlSessionStream::from_path(&path).expect("replay stream")
}

/// The route matrix: every route runs once on the probed path and the
/// parity exit runs once more on the known-terminal path (the direct
use pa_tui::agents_view::{run_agents_view, AgentsViewOptions, AgentsViewUiMode};
use pa_tui::interactive::{
    run_interactive, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};

fn child_options(socket: PathBuf) -> InteractiveOptions {
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

/// One attached session behind a mock supervisor socket (the
/// kitty-release e2e's mock: every command answers; create/attach
/// carry the shapes the surfaces need).
pub(super) struct MockSupervisor {
    listener: std::os::unix::net::UnixListener,
    /// The attach snapshot's message count: the force-quit route seeds a
    /// transcript big enough to fill the pty (the exit flush stalls
    /// mid-write, starving the progress feed the watchdog watches).
    seed_messages: usize,
}

impl MockSupervisor {
    pub(super) fn bind(socket: &std::path::Path, seed_messages: usize) -> Self {
        MockSupervisor {
            listener: std::os::unix::net::UnixListener::bind(socket).expect("bind mock socket"),
            seed_messages,
        }
    }

    pub(super) fn serve(self) {
        // One thread per connection (the real daemon's shape): a
        // handoff parks the view's roster connection for the flow's
        // next run while the chat it opened dials its own, so the mock
        // must serve both at once.
        let seed_messages = self.seed_messages;
        for stream in self.listener.incoming() {
            match stream {
                Ok(stream) => {
                    let seed = seed_messages;
                    std::thread::spawn(move || Self::serve_connection(stream, seed));
                }
                Err(_) => return,
            }
        }
    }

    fn serve_connection(stream: std::os::unix::net::UnixStream, seed_messages: usize) {
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = std::io::BufReader::new(stream);
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
            let command = envelope.get("command").cloned().unwrap_or(Value::Null);
            let command_type = command
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match command_type.as_str() {
                "roster_subscribe" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "roster_subscribe",
                            "success": true,
                            "data": {
                                "roster": [ live_roster_entry() ],
                            },
                        }),
                    );
                }
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
                    write_json(&mut writer, &attach_data(id, seed_messages));
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

/// One live roster entry (a running top-level session): the view's
/// Running row Enter opens as an attach.
fn live_roster_entry() -> Value {
    json!({
        "status": "running",
        "summary": {
            "id": "s1",
            "activeSessionId": "s1",
            "sessionId": "sess-1",
            "cwd": "/tmp",
            "lifecycle": "live",
            "runtimeKind": "root",
            "sessionName": "kitty exit e2e",
            "firstMessage": "row 0",
        },
    })
}

fn write_json(writer: &mut std::os::unix::net::UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

fn attach_data(id: &str, seed_messages: usize) -> Value {
    let messages: Vec<Value> = (0..seed_messages)
        .map(|index| {
            json!({
                "role": if index % 2 == 0 { "user" } else { "assistant" },
                "content": [{ "type": "text", "text": format!("row {index}") }],
            })
        })
        .collect();
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
                    "sessionName": "kitty exit e2e",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": messages,
                "lastEventSequence": 0,
                "lastEventCursor": null,
            },
            "client": { "id": "mock", "capabilities": [] },
            "lastEventSequence": 0,
            "lastEventCursor": null,
        },
    })
}
