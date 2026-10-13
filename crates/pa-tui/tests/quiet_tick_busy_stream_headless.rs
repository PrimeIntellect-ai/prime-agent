//! Headless e2e for the quiet tick under a busy stream: one loop-local deadline that stream
//! wakes cannot restart materializes a parked autocomplete request mid-reply, while a
//! keystroke still restarts the window, so a typed command plus Enter submits as typed.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

/// The stream's cadence: intervals shorter than the tick's 50ms window, so stream wakes alone
/// keep a per-iteration sleep from completing.
const STREAM_INTERVAL_MS: u64 = 20;
/// Deltas past the render barriers' budget, so a starved tick cannot wait out the stream.
const STREAM_DELTAS: usize = 130;
const BARRIER_TIMEOUT_MS: u64 = 1200;

/// Serve one client: attach answers with the empty-session snapshot and spawns the streaming
/// reply; every other command gets one success response.
fn serve(listener: &UnixListener) {
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
        let command_type = envelope
            .get("command")
            .and_then(|command| command.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match command_type.as_str() {
            "attach" => {
                write_json(&mut writer, &attach_data(id));
                // The reply streams on its own handle while this loop keeps answering.
                let stream_writer = writer.try_clone().expect("clone stream socket");
                std::thread::spawn(move || stream_reply(stream_writer));
            }
            // create, get_commands, get_session_stats, detach: one success covers all.
            _ => {
                write_json(
                    &mut writer,
                    &json!({
                        "type": "response",
                        "id": id,
                        "command": command_type,
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
        }
    }
}

/// Stream one reply: a turn start, assistant deltas at the stream cadence, then the turn end.
fn stream_reply(mut writer: UnixStream) {
    let event = |payload: Value| {
        json!({
            "type": "session_event",
            "activeSessionId": "s1",
            "event": payload,
        })
    };
    write_json(&mut writer, &event(json!({ "type": "turn_start" })));
    for delta in 0..STREAM_DELTAS {
        std::thread::sleep(Duration::from_millis(STREAM_INTERVAL_MS));
        write_json(
            &mut writer,
            &event(json!({
                "type": "message_update",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": format!("reply delta {delta}") }],
                },
                "assistantMessageEvent": { "type": "text_delta", "delta": " more text" },
            })),
        );
    }
    write_json(&mut writer, &event(json!({ "type": "turn_end" })));
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The attach result: one empty, quiet session.
fn attach_data(id: &str) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": "attach",
        "success": true,
        "data": {
            "activeSessionId": "s1",
            "snapshot": {
                "state": {
                    "sessionId": "sess-1",
                    "sessionName": "busy stream session",
                    "isStreaming": false,
                },
                "messages": [],
            },
        },
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

/// Run one plan against the mock and return the rendered frames.
fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    // Scrub the ambient TMUX variable: its startup notice must not reach the frames.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let listener = UnixListener::bind(&socket).expect("bind mock socket");
    let handle = std::thread::spawn(move || serve(&listener));
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

/// A parked autocomplete request materializes while the reply streams: the second barrier
/// releases only on the dropdown's selected row, and its budget is shorter than the stream,
/// so a tick that waits for the stream to pause times the barrier out instead.
#[test]
fn the_quiet_tick_materializes_autocomplete_while_a_reply_streams() {
    let frames = run_plan(vec![
        // The `/` must land mid-stream: the barrier waits for a rendered delta first.
        HeadlessStep::WaitRender {
            needle: "reply delta".to_string(),
            timeout_ms: BARRIER_TIMEOUT_MS,
        },
        HeadlessStep::Type("/".to_string()),
        HeadlessStep::WaitRender {
            needle: "\u{203a} settings".to_string(),
            timeout_ms: BARRIER_TIMEOUT_MS,
        },
    ]);
    let all = frames.join("\n");
    assert!(
        !all.contains("timed out waiting"),
        "a render barrier timed out: the tick starved while the stream ran:\n{all}"
    );
}

/// A keystroke restarts the window: a typed command plus its Enter in one burst submits as
/// typed, instead of a mid-burst dropdown's Enter completing the command into its args.
#[test]
fn a_typed_command_burst_submits_as_typed() {
    let mut steps = vec![
        // The burst lands mid-stream, like a fast typist over a busy turn.
        HeadlessStep::WaitRender {
            needle: "reply delta".to_string(),
            timeout_ms: BARRIER_TIMEOUT_MS,
        },
    ];
    // The keys land 15ms apart: each gap stays far inside the 50ms window, their sum
    // crosses it, so a window anchored at the first key closes mid-burst.
    for key in ["/", "n", "a", "m", "e"] {
        steps.push(HeadlessStep::Type(key.to_string()));
        steps.push(HeadlessStep::WaitMs(15));
    }
    // The Enter rides with the burst's tail, the typed-ahead submit path.
    steps.push(HeadlessStep::Type("\r".to_string()));
    steps.push(HeadlessStep::WaitRender {
        needle: "Session name: busy stream session".to_string(),
        timeout_ms: BARRIER_TIMEOUT_MS,
    });
    let all = run_plan(steps).join("\n");
    assert!(
        all.contains("Session name: busy stream session"),
        "the burst's Enter completed a mid-burst dropdown instead of submitting /name:\n{all}"
    );
}
