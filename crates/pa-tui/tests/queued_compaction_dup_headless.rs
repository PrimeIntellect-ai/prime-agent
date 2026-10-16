//! Headless e2e for the compaction-window queued prompt: the post-compaction
//! transcript rebuild must not double-render a row whose live frame raced the
//! rebuild's fetch.
//!
//! The regression: `compaction_end` arms a full transcript refetch; a prompt
//! QUEUED DURING the compaction delivers in exactly that window, so its
//! persisted user row is in BOTH the fetched transcript and the in-flight
//! `message_start` frame the loop applies after the rebuild — the transcript
//! rendered the user row twice. The daemon stamps the fetch with the store
//! read's event sequence; the rebuild anchors on it and drops the row-bearing
//! frames the fetch already covered.
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
const REPLY_TEXT: &str = "the raced turn reply";
/// The store read's sequence (the fetch floor): after the queued row's frames
/// (5, 6), before the reply's stream (7+).
const FETCH_FLOOR: u64 = 7;

fn session_event(event: &Value, sequence: u64) -> Value {
    json!({
        "type": "session_event",
        "activeSessionId": "s1",
        "event": event,
        "meta": { "sequence": sequence, "generation": "s1" },
    })
}

/// The delivery's wire frames for the queued prompt's turn, as the worker
/// emits them (persist precedes the frames; the reply streams after).
fn raced_turn_frames() -> Vec<Value> {
    let user_message = json!({
        "role": "user",
        "content": QUEUED_TEXT,
        "timestamp": 400,
    });
    let assistant_snapshot = |text: &str, usage: u64| {
        json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": text }],
            "provider": "faux", "model": "faux-1",
            "usage": { "input": 10, "output": usage, "totalTokens": 10 + usage },
            "timestamp": 401,
        })
    };
    vec![
        session_event(&json!({ "type": "agent_start" }), 3),
        session_event(&json!({ "type": "turn_start" }), 4),
        session_event(
            &json!({ "type": "message_start", "message": user_message }),
            5,
        ),
        session_event(
            &json!({ "type": "message_end", "message": user_message }),
            6,
        ),
        session_event(
            &json!({
                "type": "message_update",
                "message": assistant_snapshot("", 0),
                "assistantMessageEvent": { "type": "start" },
            }),
            8,
        ),
        session_event(
            &json!({
                "type": "message_update",
                "message": assistant_snapshot(REPLY_TEXT, 0),
                "assistantMessageEvent": { "type": "text_delta", "delta": REPLY_TEXT },
            }),
            9,
        ),
        session_event(
            &json!({
                "type": "message_end",
                "message": assistant_snapshot(REPLY_TEXT, 4),
            }),
            10,
        ),
        session_event(
            &json!({ "type": "turn_end", "message": assistant_snapshot(REPLY_TEXT, 4) }),
            11,
        ),
        session_event(&json!({ "type": "agent_end" }), 12),
    ]
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

    fn serve(self) {
        // Blocking reads: the thread serves one client connection and ends
        // when the run's teardown closes it (read_line's Ok(0)).
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
                "create" => write_json(&mut writer, &create_response(id)),
                "attach" => {
                    write_json(&mut writer, &attach_response(id));
                    // The compaction runs while the queued prompt parks in the
                    // steering lane; its window ends and the compact settles.
                    for frame in compaction_events() {
                        write_json(&mut writer, &frame);
                    }
                }
                "get_messages" => {
                    // The fetch raced the queued prompt's delivery: the row
                    // the delivery persisted is in the fetched transcript, and
                    // the read is stamped with its event sequence.
                    write_json(&mut writer, &raced_fetch_response(id));
                    // The delivery's frames were in flight across the fetch;
                    // the loop applies them after the rebuild.
                    for frame in raced_turn_frames() {
                        write_json(&mut writer, &frame);
                    }
                }
                "get_session_stats" => write_json(&mut writer, &stats_response(id)),
                command => write_json(&mut writer, &generic_response(id, command)),
            }
        }
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

/// The manual compaction's settled event pair.
fn compaction_events() -> Vec<Value> {
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
                    "summary": "the compacted summary",
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

/// The raced transcript fetch: the row the delivery persisted is in the
/// response, stamped with the store read's event sequence.
fn raced_fetch_response(id: &str) -> Value {
    json!({
        "type": "response", "id": id, "command": "get_messages",
        "success": true,
        "data": {
            "messages": [
                { "role": "user", "content": QUEUED_TEXT, "timestamp": 400 },
            ],
            "lastEventSequence": FETCH_FLOOR,
        },
    })
}

/// The `get_session_stats` response the post-compaction tray refresh reads.
fn stats_response(id: &str) -> Value {
    json!({
        "type": "response", "id": id, "command": "get_session_stats",
        "success": true,
        "data": {
            "contextUsage": { "tokens": 100, "contextWindow": 200_000 },
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

/// The raced queued row renders once: once from the rebuilt transcript, never
/// again from the live frame the fetch already covered.
#[test]
fn a_row_racing_the_post_compaction_rebuild_renders_once() {
    // The ambient TMUX variable adds a startup notice to the
    // transcript; scrub it so the run is the same inside tmux and out.
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
        steps: vec![HeadlessStep::WaitRender {
            needle: REPLY_TEXT.to_string(),
            timeout_ms: 5000,
        }],
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");

    let final_frame = outcome.frames.last().expect("at least one rendered frame");
    let queued_rows = final_frame.matches(QUEUED_TEXT).count();
    let reply_rows = final_frame.matches(REPLY_TEXT).count();
    assert_eq!(
        queued_rows, 1,
        "the queued row renders once (the rebuilt transcript and the live frame share one row):\n{final_frame}"
    );
    assert_eq!(
        reply_rows, 1,
        "the turn's reply renders once:\n{final_frame}"
    );
}
