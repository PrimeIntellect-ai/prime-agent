//! Headless e2e for the compaction-window queued prompt: a queued prompt
//! renders once and the compaction path never refetches. The mock still
//! answers `get_messages`, so a refetch would be recorded.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

const QUEUED_TEXT: &str = "queued while compacting";
const SUMMARY_TEXT: &str = "the compacted summary";

fn session_event(event: &Value, sequence: u64) -> Value {
    json!({
        "type": "session_event",
        "activeSessionId": "s1",
        "event": event,
        "meta": { "sequence": sequence, "generation": "s1" },
    })
}

/// The compaction summary message the store walk synthesizes.
fn compaction_summary_message() -> Value {
    json!({
        "role": "compactionSummary",
        "summary": SUMMARY_TEXT,
        "tokensBefore": 100u64,
        "retainedMessageCount": 0u64,
        "timestamp": 300u64,
    })
}

/// The manual compaction's settled pair, then the queued prompt's delivery
/// frames — one burst, in wire order.
fn compaction_and_queued_frames() -> Vec<Value> {
    let user_message = json!({
        "role": "user",
        "content": QUEUED_TEXT,
        "timestamp": 400u64,
    });
    vec![
        session_event(
            &json!({ "type": "compaction_start", "reason": "manual" }),
            1,
        ),
        session_event(
            &json!({
                "type": "compaction_end",
                "reason": "manual",
                "result": {
                    "summary": SUMMARY_TEXT,
                    "firstKeptEntryId": "e1",
                    "tokensBefore": 100,
                },
                "aborted": false,
                "willRetry": false,
            }),
            2,
        ),
        session_event(
            &json!({ "type": "message_start", "message": user_message }),
            3,
        ),
        session_event(
            &json!({ "type": "message_end", "message": user_message }),
            4,
        ),
        session_event(&json!({ "type": "turn_end" }), 5),
        session_event(&json!({ "type": "agent_end" }), 6),
    ]
}

/// A compaction pair with no turn frames around it: the settled-compaction
/// refresh must fire on the transition alone.
fn compaction_only_frames() -> Vec<Value> {
    vec![
        session_event(
            &json!({ "type": "compaction_start", "reason": "manual" }),
            1,
        ),
        session_event(
            &json!({
                "type": "compaction_end",
                "reason": "manual",
                "result": {
                    "summary": SUMMARY_TEXT,
                    "firstKeptEntryId": "e1",
                    "tokensBefore": 100,
                },
                "aborted": false,
                "willRetry": false,
            }),
            2,
        ),
    ]
}

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    /// Serve one client connection; returns the command types it saw.
    /// `attach_frames` rides the wire right after the attach response.
    fn serve(self, attach_frames: &[Value]) -> Vec<String> {
        let (stream, _) = self.listener.accept().expect("accept mock client");
        let mut writer = stream.try_clone().expect("clone mock socket");
        let mut reader = BufReader::new(stream);

        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": [],
            "clientId": "mock",
        });
        write_json(&mut writer, &hello);

        let mut commands = Vec::new();
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
            commands.push(command_type.clone());
            match command_type.as_str() {
                "create" => write_json(&mut writer, &create_response(id)),
                "attach" => {
                    write_json(&mut writer, &attach_response(id));
                    for frame in attach_frames {
                        write_json(&mut writer, frame);
                    }
                }
                // The PRE-FIX tree's rebuild fetch: the queued row is already
                // persisted, so the fetched transcript contains it too.
                "get_messages" => write_json(&mut writer, &raced_fetch_response(id)),
                command => write_json(&mut writer, &generic_response(id, command)),
            }
        }
        commands
    }
}

fn attach_response(id: &str) -> Value {
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
                    "sessionName": "compaction race",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": [],
                "lastEventSequence": 0,
                "lastEventCursor": null,
            },
            "replay": { "status": "complete", "toSequence": 0 },
            "lastEventSequence": 0,
            "lastEventCursor": null,
            "client": { "id": "mock", "capabilities": [] },
        },
    })
}

/// The `create` response: a fresh durable session identity.
fn create_response(id: &str) -> Value {
    json!({
        "type": "response", "id": id, "command": "create",
        "success": true,
        "data": {
            "activeSessionId": "s1",
            "sessionId": "sess-1",
            "sessionFile": "/tmp/sess-1.jsonl",
        },
    })
}

/// The raced transcript fetch the PRE-FIX tree issues.
fn raced_fetch_response(id: &str) -> Value {
    json!({
        "type": "response", "id": id, "command": "get_messages",
        "success": true,
        "data": {
            "messages": [
                compaction_summary_message(),
                { "role": "user", "content": QUEUED_TEXT, "timestamp": 400 },
            ],
        },
    })
}

/// The catch-all success envelope every other command answers with.
fn generic_response(id: &str, command: &str) -> Value {
    json!({
        "type": "response", "id": id, "command": command,
        "success": true, "data": {},
    })
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

/// The queued row renders once and the compaction path never refetches.
#[test]
fn a_row_racing_the_post_compaction_collapse_renders_once() {
    // The ambient TMUX variable adds a startup notice to the
    // transcript; scrub it so the run is the same inside tmux and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor {
        listener: UnixListener::bind(&socket).expect("bind mock socket"),
    };
    let handle = std::thread::spawn(move || supervisor.serve(&compaction_and_queued_frames()));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![HeadlessStep::WaitRender {
            needle: QUEUED_TEXT.to_string(),
            timeout_ms: 5000,
        }],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    let commands = handle.join().expect("mock supervisor finished");

    let final_frame = outcome.frames.last().expect("at least one rendered frame");
    assert_eq!(
        final_frame.matches(QUEUED_TEXT).count(),
        1,
        "the queued row renders once:\n{final_frame}"
    );
    assert_eq!(
        final_frame.matches(SUMMARY_TEXT).count(),
        1,
        "the compaction summary row renders once:\n{final_frame}"
    );
    assert!(
        !commands.iter().any(|command| command == "get_messages"),
        "the compaction path never refetches the transcript; commands seen: {commands:?}"
    );
}

/// A compaction with no turn frames around it still refreshes the tray's
/// context usage: the mock must see the stats command land after the
/// collapse.
#[test]
fn a_settled_compaction_refreshes_the_tray_stats() {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor {
        listener: UnixListener::bind(&socket).expect("bind mock socket"),
    };
    let handle = std::thread::spawn(move || supervisor.serve(&compaction_only_frames()));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![HeadlessStep::WaitRender {
            needle: SUMMARY_TEXT.to_string(),
            timeout_ms: 5000,
        }],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    let commands = handle.join().expect("mock supervisor finished");
    outcome.frames.last().expect("at least one rendered frame");
    let stats = commands
        .iter()
        .filter(|command| *command == "get_session_stats")
        .count();
    assert_eq!(
        stats, 2,
        "the compaction transition refreshes the tray on top of the exit hint; commands: {commands:?}"
    );
}

/// Replay both sides of the daemon's atomic custom-row/collapse ordering.
#[test]
fn custom_rows_before_and_after_collapse_render_once() {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor {
        listener: UnixListener::bind(&socket).expect("bind mock socket"),
    };
    let before = json!({
        "role": "custom", "customType": "notice", "content": "custom before collapse",
        "display": true, "timestamp": 299,
    });
    let after = json!({
        "role": "custom", "customType": "notice", "content": "custom after collapse",
        "display": true, "timestamp": 301,
    });
    let frames = vec![
        session_event(
            &json!({ "type": "compaction_start", "reason": "manual" }),
            1,
        ),
        session_event(&json!({ "type": "message_start", "message": before }), 2),
        session_event(&json!({ "type": "message_end", "message": before }), 3),
        session_event(
            &json!({
                "type": "compaction_end", "reason": "manual",
                "result": { "summary": SUMMARY_TEXT, "tokensBefore": 100 },
                "aborted": false, "willRetry": false,
            }),
            4,
        ),
        session_event(&json!({ "type": "message_start", "message": after }), 5),
        session_event(&json!({ "type": "message_end", "message": after }), 6),
    ];
    let handle = std::thread::spawn(move || supervisor.serve(&frames));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: vec![HeadlessStep::WaitRender {
            needle: "custom after collapse".to_string(),
            timeout_ms: 5000,
        }],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("custom collapse replay");
    let commands = handle.join().expect("mock supervisor finished");
    let frame = outcome.frames.last().expect("a rendered frame");
    for text in [
        "custom before collapse",
        "custom after collapse",
        SUMMARY_TEXT,
    ] {
        assert_eq!(frame.matches(text).count(), 1, "{text}: {frame}");
    }
    assert!(!commands.iter().any(|command| command == "get_messages"));
}
