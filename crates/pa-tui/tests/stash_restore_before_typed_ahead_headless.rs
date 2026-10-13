//! Headless e2e for the opening phase's stash ordering (the pre-bar
//! review's finding: the stash restore must precede typed-ahead
//! acceptance AND exit-arm evaluation on a session-reopen launch).
//!
//! The two-run shape reproduces the operator's exact reopen flow: the
//! first run opens the session, types a draft, and leaves for the agents
//! view (the draft auto-stashes as the session's restore-on-open head);
//! the second run reopens the SAME session against a supervisor whose
//! attach stalls, and presses Ctrl+D — the `app.exit` key — while the
//! open is still in flight.
//!
//! The contract: base restores the stashed draft BEFORE consuming any
//! input, so Ctrl+D lands on a NONEMPTY editor (a delete-forward, not an
//! exit) and the typed-ahead dispatches after the restore. An opening
//! loop that evaluates the exit arm against the pre-restore EMPTY
//! editor exits the session silently instead — the run ends with no
//! restore, no draft, no frames.
#![cfg(unix)]
#![allow(clippy::too_many_lines, clippy::large_futures)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// How long the reopen's attach stalls: far past the plan's first step,
/// so the Ctrl+D provably lands while the open is still in flight.
const REOPEN_ATTACH_STALL_MS: u64 = 1_500;

/// Ctrl+D (the default `app.exit` key).
fn ctrl_d() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL)
}

/// Ctrl+Q (user-bound to `app.session.resume` for the first run's way
/// out to the agents view — the action that fires with a draft in the
/// editor, unlike agents-back's empty-editor gate).
fn ctrl_q() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL)
}

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve the two connections of the flow: the first open (fast
    /// attach) then the reopen (stalled attach). Each connection is
    /// served to EOF, so the runs sequence naturally.
    fn serve(self) {
        let (first, _) = self.listener.accept().expect("accept first");
        serve_connection(first, false);
        let (second, _) = self.listener.accept().expect("accept second");
        serve_connection(second, true);
    }
}

fn serve_connection(stream: UnixStream, stall_attach: bool) {
    let write_stream = stream.try_clone().expect("clone mock socket");
    let mut writer = write_stream;
    let mut reader = BufReader::new(stream);

    let hello = json!({
        "type": "daemon_hello",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "serverCapabilities": ["kernel_bash_activity"],
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
                if stall_attach {
                    std::thread::sleep(std::time::Duration::from_millis(REOPEN_ATTACH_STALL_MS));
                }
                write_json(&mut writer, &attach_data(id));
            }
            "heartbeats_list" => {
                write_json(
                    &mut writer,
                    &json!({
                        "type": "response",
                        "id": id,
                        "command": "heartbeats_list",
                        "success": true,
                        "data": { "heartbeats": [] },
                    }),
                );
            }
            "list_kernel_bash" => {
                write_json(
                    &mut writer,
                    &json!({
                        "type": "response",
                        "id": id,
                        "command": "list_kernel_bash",
                        "success": true,
                        "data": { "activities": [] },
                    }),
                );
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

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The attach result: one live session with an empty transcript.
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
                    "sessionName": "stash reopen probe",
                    "model": "faux-1",
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

fn options(
    socket: PathBuf,
    keybindings: pa_tui::keybindings::KeybindingsManager,
) -> InteractiveOptions {
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
        keybindings,
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
    }
}

/// The stashed-draft reopen flow: the draft typed in the first run
/// returns in the second run's editor BEFORE the reopen's queued Ctrl+D
/// is evaluated — so the exit key is a delete-forward on the restored
/// draft, never a silent session exit.
///
/// Red on the pre-wave head: the opening loop evaluated `app.exit`
/// against the pre-restore empty editor and exited the run during the
/// stalled attach (no restore, no draft, empty frames).
#[test]
fn the_reopen_restores_the_stash_before_the_queued_exit_key_evaluates() {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve());

    // The shared stash store: the first run's auto-stash is the second
    // run's restore-on-open head.
    let stash: std::sync::Arc<std::sync::Mutex<pa_tui::prompt_stash::PromptStashStore>> =
        std::sync::Arc::default();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    // Run one: type the draft, then leave for the agents view — the draft
    // auto-stashes as the session's restore-on-open head on the way out.
    let mut first = options(socket.clone(), agents_view_exit_bindings());
    first.prompt_stash = std::sync::Arc::clone(&stash);
    let first_plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::Type("the stashed draft".to_string()),
            HeadlessStep::Key(ctrl_q()),
        ],
        width: 100,
        height: 30,
    };
    let first_outcome = runtime
        .block_on(run_interactive(first, UiMode::Headless(first_plan)))
        .expect("first interactive run");

    // Run two: reopen the SAME session against the stalled attach and
    // press Ctrl+D while the open is still in flight.
    let mut second = options(socket, pa_tui::keybindings::KeybindingsManager::new());
    second.prompt_stash = std::sync::Arc::clone(&stash);
    let second_plan = HeadlessPlan {
        steps: vec![
            HeadlessStep::Key(ctrl_d()),
            HeadlessStep::WaitRender {
                needle: "the stashed draft".to_string(),
                timeout_ms: 8_000,
            },
            HeadlessStep::WaitRender {
                needle: "Restored stashed prompt".to_string(),
                timeout_ms: 8_000,
            },
        ],
        width: 100,
        height: 30,
    };
    let second_outcome = runtime
        .block_on(run_interactive(second, UiMode::Headless(second_plan)))
        .expect("second interactive run");
    handle.join().expect("mock supervisor finished");

    let frames = second_outcome.frames.join("\n");
    assert!(
        frames.contains("the stashed draft"),
        "the stashed draft must return to the reopened editor before any \
         queued input dispatches; frames:\n{frames}"
    );
    assert!(
        frames.contains("Restored stashed prompt"),
        "the restore notice must land with the restored draft; frames:\n{frames}"
    );
    // The run itself must NOT be the Ctrl+D exit: the exit path returns
    // the outcome with no frames at all, so non-empty frames prove the
    // exit key was consumed as the editor's delete-forward instead.
    assert!(
        !second_outcome.frames.is_empty(),
        "the run exited during the stalled reopen instead of restoring the draft"
    );
    // The first run must have taken the agents-view way out (the handoff
    // that auto-stashes): the draft rode the shared store into run two.
    assert!(
        first_outcome.return_to_agents_view,
        "the first run must hand off to the agents view so its draft \
         auto-stashes as the restore-on-open head"
    );
}

/// `app.session.resume` user-bound to Ctrl+Q: the one agents-view way
/// out that fires with a draft in the editor (agents-back's
/// empty-editor gate would turn the exit key into a cursor motion).
fn agents_view_exit_bindings() -> pa_tui::keybindings::KeybindingsManager {
    use std::collections::BTreeMap;
    let config = [("app.session.resume".to_string(), vec!["ctrl+q".to_string()])]
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    pa_tui::keybindings::KeybindingsManager::with_user_bindings(config)
}
