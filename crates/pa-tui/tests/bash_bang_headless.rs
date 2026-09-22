//! Headless e2e for the `!`/`!!` bash-from-chat shortcut (TS
//! interactive-mode `onSubmit`): a mock supervisor serves one attached
//! session and answers the `execute_bash` request with the streamed
//! `bash_start`/`bash_output`/`bash_end` events the daemon's user-bash
//! slot emits.
//!
//! Verifies the TS parity contract of the shortcut:
//!
//! - `!command` runs directly (no model turn): the bash transcript card
//!   mounts with the `$ command` row, the streamed output renders, and
//!   the settled run shows `done`; the request carries
//!   `excludeFromContext: false`, so the output enters the session
//!   context (the durable `bashExecution` row joins follow-up prompts);
//! - `!!command` dispatches with `excludeFromContext: true` — excluded
//!   from the context, rendered the same way;
//! - a bare `!` is inert (never dispatched, never sent as a prompt);
//! - a second `!` while a run is still active shows the
//!   already-running guard instead of dispatching;
//! - inside a side conversation the run is transient: the request carries
//!   `transient` + `runId` + `excludeFromContext: true`, the row mounts
//!   in the pane, and (for `!`) the run seeds the follow-up side
//!   question's `previousTurns`.
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

/// How long the mock holds a bash run open before settling it (the
/// already-running guard's window).
const LONG_RUN_END_DELAY_MS: u64 = 600;

struct MockSupervisor {
    listener: UnixListener,
    /// Every recorded `execute_bash` request payload.
    bash_requests: Arc<Mutex<Vec<Value>>>,
    /// Every recorded `start_side_question` request payload.
    side_question_requests: Arc<Mutex<Vec<Value>>>,
    /// Hold each bash run's `bash_end` for this long (0 settles at once).
    end_delay_ms: u64,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            bash_requests: Arc::new(Mutex::new(Vec::new())),
            side_question_requests: Arc::new(Mutex::new(Vec::new())),
            end_delay_ms: 0,
        }
    }

    /// Serve one connection: attach a session, answer requests, and emit
    /// the user-bash events the daemon's slot streams.
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
                "get_session_stats" => {
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "get_session_stats",
                            "success": true,
                            "data": {
                                "contextUsage": { "tokens": 1200, "contextWindow": 200000 },
                                "cost": 0.01,
                            },
                        }),
                    );
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
                "start_side_question" => {
                    self.side_question_requests
                        .lock()
                        .unwrap()
                        .push(command.clone());
                    let side_question_id = command
                        .get("sideQuestionId")
                        .and_then(Value::as_str)
                        .unwrap_or("sq-1")
                        .to_string();
                    let question = command
                        .get("question")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "start_side_question",
                            "success": true,
                            "data": {},
                        }),
                    );
                    write_json(
                        &mut writer,
                        &side_question_event(&side_question_id, &question, "running", ""),
                    );
                    write_json(
                        &mut writer,
                        &side_question_event(&side_question_id, &question, "complete", "four"),
                    );
                }
                "execute_bash" => {
                    let command_text = command
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let run_id = command
                        .get("runId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let excluded = command
                        .get("excludeFromContext")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    self.bash_requests.lock().unwrap().push(command.clone());
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "execute_bash",
                            "success": true,
                            "data": {},
                        }),
                    );
                    let mut start = json!({
                        "type": "bash_start",
                        "command": command_text,
                        "excludeFromContext": excluded,
                    });
                    if let Some(run_id) = &run_id {
                        start["runId"] = json!(run_id);
                        start["transient"] = json!(true);
                    }
                    write_session_event(&mut writer, &start);
                    write_session_event(
                        &mut writer,
                        &json!({ "type": "bash_output", "chunk": "hi\n" }),
                    );
                    let end = json!({
                        "type": "bash_end",
                        "exitCode": 0,
                        "cancelled": false,
                        "truncated": false,
                    });
                    let end = match &run_id {
                        Some(run_id) => {
                            let mut end = end;
                            end["runId"] = json!(run_id);
                            end["transient"] = json!(true);
                            end
                        }
                        None => end,
                    };
                    if self.end_delay_ms == 0 {
                        write_session_event(&mut writer, &end);
                    } else {
                        let mut delayed = writer.try_clone().expect("clone delayed writer");
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(self.end_delay_ms));
                            write_session_event(&mut delayed, &end);
                        });
                    }
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

fn side_question_event(id: &str, question: &str, status: &str, answer: &str) -> Value {
    json!({
        "type": "side_question_event",
        "activeSessionId": "s1",
        "event": {
            "id": id,
            "question": question,
            "answer": answer,
            "status": status,
        },
    })
}

fn write_session_event(writer: &mut UnixStream, event: &Value) {
    write_json(
        writer,
        &json!({
            "type": "session_event",
            "activeSessionId": "s1",
            "event": event,
        }),
    );
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The slim attach result with an empty transcript.
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
                    "sessionName": "bash session",
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
        },
    })
}

fn options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: Default::default(),
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
        prompt_stash: Default::default(),
        session_has_children: false,
        client_settings: None,
    }
}

/// The run outcome the bash assertions need: the captured frames plus the
/// recorded request payloads.
#[derive(Debug)]
struct RunOutcome {
    frames: Vec<String>,
    bash_requests: Vec<Value>,
    side_question_requests: Vec<Value>,
}

/// Run the headless plan against a fresh mock supervisor. `end_delay_ms`
/// holds each bash run open before its `bash_end` (the guard's window).
fn run_plan(steps: Vec<HeadlessStep>, end_delay_ms: u64) -> RunOutcome {
    // The ambient TMUX variable adds a startup notice to the transcript;
    // scrub it so the run is the same inside tmux and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let mut supervisor = MockSupervisor::bind(&socket);
    supervisor.end_delay_ms = end_delay_ms;
    let bash_requests = Arc::clone(&supervisor.bash_requests);
    let side_question_requests = Arc::clone(&supervisor.side_question_requests);
    let handle = std::thread::spawn(move || supervisor.serve());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: 40,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    let _ = handle.join();
    RunOutcome {
        frames: outcome.frames,
        bash_requests: Arc::try_unwrap(bash_requests)
            .map(|locked| locked.into_inner().unwrap())
            .unwrap_or_else(|locked| locked.lock().unwrap().clone()),
        side_question_requests: Arc::try_unwrap(side_question_requests)
            .map(|locked| locked.into_inner().unwrap())
            .unwrap_or_else(|locked| locked.lock().unwrap().clone()),
    }
}

/// `!command` runs directly and mounts the bash transcript card; `!!command`
/// dispatches excluded from the context.
#[test]
fn bang_runs_the_command_and_mounts_the_bash_card() {
    let steps = vec![
        HeadlessStep::Submit("!echo hi".to_string()),
        HeadlessStep::WaitMs(300),
        HeadlessStep::Submit("!!echo quiet".to_string()),
        HeadlessStep::WaitMs(300),
    ];
    let run = run_plan(steps, 0);
    let all = run.frames.join("\n");
    assert!(
        all.contains("$ echo hi"),
        "the ! card's command row rendered:\n{all}"
    );
    assert!(all.contains("hi"), "the streamed output rendered:\n{all}");
    assert!(
        all.contains("bash \u{b7} done") || all.contains("bash · done"),
        "the settled card shows done:\n{all}"
    );
    assert!(
        all.contains("$ echo quiet"),
        "the !! card's command row rendered:\n{all}"
    );
    assert_eq!(run.bash_requests.len(), 2, "both commands dispatched");
    assert_eq!(
        run.bash_requests[0].get("command").and_then(Value::as_str),
        Some("echo hi"),
        "the command reached the user-bash slot without the ! prefix"
    );
    assert_eq!(
        run.bash_requests[0]
            .get("excludeFromContext")
            .and_then(Value::as_bool),
        Some(false),
        "! output joins the session context"
    );
    assert_eq!(
        run.bash_requests[1]
            .get("excludeFromContext")
            .and_then(Value::as_bool),
        Some(true),
        "!! output stays excluded from the session context"
    );
    assert!(
        run.bash_requests[0].get("transient").is_none()
            && run.bash_requests[0].get("runId").is_none(),
        "main-thread runs are durable (recorded into the session)"
    );
}

/// A second `!` while a run is active shows the already-running guard and
/// never dispatches; a bare `!` is inert.
#[test]
fn the_running_guard_blocks_and_a_bare_bang_is_inert() {
    let steps = vec![
        HeadlessStep::Submit("!echo hi".to_string()),
        HeadlessStep::WaitMs(250),
        HeadlessStep::Submit("!echo second".to_string()),
        HeadlessStep::WaitMs(150),
        HeadlessStep::Submit("!".to_string()),
        HeadlessStep::WaitMs(700),
    ];
    let run = run_plan(steps, LONG_RUN_END_DELAY_MS);
    let all = run.frames.join("\n");
    assert!(
        all.contains("A bash command is already running. Press"),
        "the guard row rendered:\n{all}"
    );
    assert_eq!(
        run.bash_requests.len(),
        1,
        "the guarded and bare submissions never dispatched:\n{run:?}"
    );
}

/// Inside a side conversation the `!` run is transient (pane-rendered,
/// context-excluded) and seeds the follow-up side question's turns.
#[test]
fn a_side_conversation_bash_run_mounts_in_the_pane_and_seeds_follow_ups() {
    let steps = vec![
        HeadlessStep::Submit("/btw what is 2+2".to_string()),
        HeadlessStep::WaitMs(250),
        HeadlessStep::Submit("!echo pane".to_string()),
        HeadlessStep::WaitMs(250),
        HeadlessStep::Submit("was it four?".to_string()),
        HeadlessStep::WaitMs(250),
    ];
    let run = run_plan(steps, 0);
    let all = run.frames.join("\n");
    assert!(
        all.contains("$ echo pane"),
        "the pane-mounted bash row rendered:\n{all}"
    );
    assert_eq!(run.bash_requests.len(), 1, "the side bash dispatched");
    let request = &run.bash_requests[0];
    assert_eq!(
        request.get("excludeFromContext").and_then(Value::as_bool),
        Some(true),
        "side runs stay out of the main-session context"
    );
    assert_eq!(
        request.get("transient").and_then(Value::as_bool),
        Some(true),
        "side runs are transient (never recorded)"
    );
    assert!(
        request.get("runId").and_then(Value::as_str).is_some(),
        "the pane run carries its run identity"
    );
    // The follow-up side question seeded the bash run's output.
    assert_eq!(
        run.side_question_requests.len(),
        2,
        "the /btw turn and the follow-up both started"
    );
    let previous = run.side_question_requests[1]
        .get("previousTurns")
        .cloned()
        .unwrap_or(Value::Null);
    let turns = previous.as_array().cloned().unwrap_or_default();
    let seeded = turns.iter().any(|turn| {
        turn.get("question").and_then(Value::as_str) == Some("!echo pane")
            && turn
                .get("answer")
                .and_then(Value::as_str)
                .is_some_and(|answer| answer.contains("hi"))
    });
    assert!(
        seeded,
        "the bash run seeded the follow-up's previousTurns:\n{turns:?}"
    );
}
