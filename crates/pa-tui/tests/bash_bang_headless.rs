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

/// The headless plan height: tall enough that the whole 20-row bash
/// preview plus its status rows stay inside the rendered window.
const TALL_PLAN_HEIGHT: u16 = 64;

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
    /// The chunks one bash run streams (default one `hi` line).
    bash_chunks: Vec<String>,
    /// The `bash_end` payload (None: the clean exit-0 default).
    bash_end: Option<Value>,
    /// Stream a model turn around a `prompt` request and hold it open
    /// for `turn_end_delay_ms` (the pending-bash mount's window).
    turn_end_delay_ms: u64,
    /// After the bang run's chunks stream, close the link with a
    /// `daemon_closing` update frame instead of `bash_end` (§10): the
    /// client must reattach and the resync settles the never-ended run.
    update_restart_after_bash: bool,
    /// After a side run settles, replay another client's main-thread `!`
    /// run (broadcast `bash_start`/`bash_output`/`bash_end`, no runId):
    /// the pane keeps its settled row while the transcript mounts the
    /// foreign card.
    foreign_main_run_after_side_run: bool,
    /// §10.1: set when the update restart closes the link. The old
    /// daemon stops emitting with the socket close, so a turn still in
    /// flight there (the delayed `turn_end` thread) never lands its
    /// end on the wire.
    link_closed: Arc<std::sync::atomic::AtomicBool>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            bash_requests: Arc::new(Mutex::new(Vec::new())),
            side_question_requests: Arc::new(Mutex::new(Vec::new())),
            end_delay_ms: 0,
            bash_chunks: vec!["hi\n".to_string()],
            bash_end: None,
            turn_end_delay_ms: 0,
            update_restart_after_bash: false,
            foreign_main_run_after_side_run: false,
            link_closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Serve connections until the client stops coming back (bounded, so
    /// the join at the end of a plan always finishes): attach a session,
    /// answer requests, and emit the user-bash events the daemon's
    /// user-bash slot streams. The second connection carries the §10.3
    /// `updateResume` hello a successor supervisor reports.
    fn serve(self) {
        self.listener
            .set_nonblocking(true)
            .expect("nonblocking mock listener");
        // A reconnecting client dials again about a second after the
        // closing frame (the §10.2 backoff stretches on a loaded box), so
        // the wait right after that connection closes runs long; once its
        // plan ends the client stops coming back and the short idle
        // window ends the serve, so the harness join always returns.
        let reconnect_window = std::time::Duration::from_secs(20);
        let idle_window = std::time::Duration::from_millis(1500);
        for connection in 0..5 {
            // connection 1 is the reconnect dial (the one the §10 closing
            // frame promises); every other gap is a plan teardown.
            let window = if connection == 1 && self.update_restart_after_bash {
                reconnect_window
            } else {
                idle_window
            };
            let idle_until = std::time::Instant::now() + window;
            let (stream, _) = loop {
                match self.listener.accept() {
                    Ok(accepted) => break accepted,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= idle_until {
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(_) => return,
                }
            };
            let write_stream = stream.try_clone().expect("clone mock socket");
            let mut writer = write_stream;
            let mut reader = BufReader::new(stream);

            let mut hello = json!({
                "type": "daemon_hello",
                "protocol": { "name": "prime-agent.daemon", "version": 7 },
                "serverCapabilities": [],
                "clientId": "mock",
            });
            if connection > 0 {
                hello["updateResume"] = json!({ "complete": true, "updateId": "update-1" });
            }
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
                                    "contextUsage": { "tokens": 1200, "contextWindow": 200_000 },
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
                        if self.turn_end_delay_ms > 0 {
                            // One open model turn the client streams while its
                            // bash run mounts: the assistant message stays
                            // open until the delayed end settles it.
                            let question = command
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            write_session_event(&mut writer, &json!({ "type": "turn_start" }));
                            write_session_event(
                                &mut writer,
                                &json!({
                                    "type": "message_start",
                                    "message": { "role": "user", "content": question },
                                }),
                            );
                            write_session_event(
                                &mut writer,
                                &json!({
                                    "type": "message_start",
                                    "message": {
                                        "role": "assistant",
                                        "content": [{ "type": "text", "text": "" }],
                                    },
                                    "assistantMessageEvent": { "type": "start" },
                                }),
                            );
                            write_session_event(
                                &mut writer,
                                &json!({
                                    "type": "message_update",
                                    "message": {
                                        "role": "assistant",
                                        "content": [
                                            { "type": "text", "text": "Let me run the long check." },
                                        ],
                                    },
                                    "assistantMessageEvent": {
                                        "type": "text_delta",
                                        "delta": "Let me run the long check.",
                                    },
                                }),
                            );
                            let mut delayed = writer.try_clone().expect("clone delayed writer");
                            let delay = self.turn_end_delay_ms;
                            let link_closed = self.link_closed.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(delay));
                                if link_closed.load(std::sync::atomic::Ordering::SeqCst) {
                                    return;
                                }
                                write_session_event(
                                    &mut delayed,
                                    &json!({
                                        "type": "message_end",
                                        "message": {
                                            "role": "assistant",
                                            "stopReason": "stop",
                                            "content": [
                                                { "type": "text", "text": "Let me run the long check." },
                                            ],
                                        },
                                    }),
                                );
                                write_session_event(&mut delayed, &json!({ "type": "turn_end" }));
                            });
                        }
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
                        for chunk in &self.bash_chunks {
                            write_session_event(
                                &mut writer,
                                &json!({ "type": "bash_output", "chunk": chunk }),
                            );
                        }
                        if self.update_restart_after_bash {
                            // The update restart kills the link before the
                            // run settles (§10.1): no bash_end arrives on
                            // this link; the successor supervisor reattaches
                            // the client instead. The socket close stops
                            // every other in-flight write on this link too
                            // (the still-open turn's delayed end below).
                            self.link_closed
                                .store(true, std::sync::atomic::Ordering::SeqCst);
                            write_json(
                                &mut writer,
                                &json!({
                                    "type": "daemon_closing",
                                    "reason": "update",
                                    "payload": {
                                        "resume": true,
                                        "updateId": "update-1",
                                        "estSeconds": 1,
                                        "sessions": [
                                            { "sessionId": "s1", "name": "bash session" },
                                        ],
                                    },
                                }),
                            );
                            break;
                        }
                        let end = self.bash_end.clone().unwrap_or(json!({
                            "type": "bash_end",
                            "exitCode": 0,
                            "cancelled": false,
                            "truncated": false,
                        }));
                        let end = match &run_id {
                            Some(run_id) => {
                                let mut end = end;
                                end["runId"] = json!(run_id);
                                end["transient"] = json!(true);
                                end
                            }
                            None => end,
                        };
                        if self.foreign_main_run_after_side_run && run_id.is_some() {
                            // The pane's run settled; another client's
                            // main-thread `!` run now claims the slot and
                            // the wire broadcasts it here.
                            let mut delayed = writer.try_clone().expect("clone delayed writer");
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(250));
                                write_session_event(
                                    &mut delayed,
                                    &json!({
                                        "type": "bash_start",
                                        "command": "echo main",
                                        "excludeFromContext": false,
                                    }),
                                );
                                write_session_event(
                                    &mut delayed,
                                    &json!({ "type": "bash_output", "chunk": "main-out\n" }),
                                );
                                write_session_event(
                                    &mut delayed,
                                    &json!({
                                        "type": "bash_end",
                                        "exitCode": 0,
                                        "cancelled": false,
                                        "truncated": false,
                                    }),
                                );
                            });
                        }
                        if self.end_delay_ms == 0 {
                            write_session_event(&mut writer, &end);
                        } else {
                            let mut delayed = writer.try_clone().expect("clone delayed writer");
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(
                                    self.end_delay_ms,
                                ));
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
        prompt_stash: Arc::default(),
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
    run_plan_with(steps, |supervisor| {
        supervisor.end_delay_ms = end_delay_ms;
    })
}

/// Run the headless plan against a configured mock supervisor (the
/// chunked-output, cancelled, and streaming-turn scenarios).
fn run_plan_with(
    steps: Vec<HeadlessStep>,
    configure: impl FnOnce(&mut MockSupervisor),
) -> RunOutcome {
    // The ambient TMUX variable adds a startup notice to the transcript;
    // scrub it so the run is the same inside tmux and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let mut supervisor = MockSupervisor::bind(&socket);
    configure(&mut supervisor);
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
        height: TALL_PLAN_HEIGHT,
    };
    let outcome = runtime
        .block_on(run_interactive(options(socket), UiMode::Headless(plan)))
        .expect("interactive run");
    let _ = handle.join();
    RunOutcome {
        frames: outcome.frames,
        bash_requests: Arc::try_unwrap(bash_requests).map_or_else(
            |locked| locked.lock().unwrap().clone(),
            |locked| locked.into_inner().unwrap(),
        ),
        side_question_requests: Arc::try_unwrap(side_question_requests).map_or_else(
            |locked| locked.lock().unwrap().clone(),
            |locked| locked.into_inner().unwrap(),
        ),
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
    // The BashExecutionComponent renders no status row for a clean
    // exit-0 run (only cancelled/error runs mark themselves).
    assert!(
        !all.contains("bash \u{b7} done") && !all.contains("bash · done"),
        "the settled card renders no generic tool-card done row:\n{all}"
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
        all.contains("Running... ("),
        "the held-open card owns the loader row with its cancel hint:\n{all}"
    );
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
/// The pane keeps its settled bash row after its side run ends, but the
/// row never receives a LATER run's output: `bash_output` carries no run
/// identity on the wire, so routing follows the active run (TS appends to
/// `activeBashComponent`, and a settled side component is never active).
/// A main-thread `!` run that starts while the pane holds a stale row
/// streams into its own transcript card.
#[test]
fn a_main_run_after_a_settled_pane_run_owns_its_output() {
    let steps = vec![
        HeadlessStep::Submit("/btw what is 2+2".to_string()),
        HeadlessStep::WaitMs(250),
        HeadlessStep::Submit("!echo pane".to_string()),
        HeadlessStep::WaitMs(1000),
    ];
    let run = run_plan_with(steps, |supervisor| {
        supervisor.foreign_main_run_after_side_run = true;
    });
    let all = run.frames.join("\n");
    assert_eq!(
        run.bash_requests.len(),
        1,
        "only the pane's own run dispatched; the foreign run arrived on the wire:\n{all}"
    );
    assert!(
        all.contains("$ echo main"),
        "the foreign main run mounted its transcript card:\n{all}"
    );
    assert!(
        all.contains("main-out"),
        "the foreign run's output rendered:\n{all}"
    );
    // The streamed output belongs to the transcript card: its rows sit
    // inside the card (the `$ echo main` header row and its output rows
    // are adjacent), never appended to the pane's settled row.
    let with_output = run
        .frames
        .iter()
        .find(|frame| frame.contains("$ echo main") && frame.contains("main-out"))
        .expect("a frame with the foreign card and its output");
    let row_of = |needle: &str| -> usize {
        with_output
            .lines()
            .position(|line| line.contains(needle))
            .unwrap_or_else(|| panic!("the {needle:?} row: {with_output}"))
    };
    let header_row = row_of("$ echo main");
    let output_row = row_of("main-out");
    assert!(
        output_row > header_row && output_row - header_row <= 3,
        "the output renders inside the foreign card, not the pane's stale row:\n{with_output}"
    );
    assert!(
        !all.contains("himain-out"),
        "the pane's settled row did not absorb the foreign chunks:\n{all}"
    );
}

/// A `!` run during a streaming turn mounts above the execution
/// indicator (TS `pendingMessagesContainer`) and flushes into the
/// transcript when the turn ends (TS `flushPendingBashComponents`): the
/// card sits ABOVE the assistant's open message while pending and BELOW
/// it once flushed.
#[test]
fn a_bang_during_a_streaming_turn_holds_then_flushes() {
    let steps = vec![
        HeadlessStep::Submit("run a turn".to_string()),
        // The bang must land while the turn is VISIBLY streaming: the
        // turn's text on screen means the prompt's admission round trip
        // settled and the stream events flow, so the held-card pending
        // regime exists regardless of ACK latency under load (a fixed
        // WaitMs raced the backgrounded submit's outcome and lost under
        // battery/CI load — the frame order the old blocking submit
        // guaranteed by construction).
        HeadlessStep::WaitRender {
            needle: "Let me run the long check.".to_string(),
            timeout_ms: 30_000,
        },
        HeadlessStep::Submit("!echo mid".to_string()),
        HeadlessStep::WaitMs(400),
        HeadlessStep::WaitMs(1000),
    ];
    let run = run_plan_with(steps, |supervisor| {
        supervisor.turn_end_delay_ms = 1200;
    });
    let both: Vec<&String> = run
        .frames
        .iter()
        .filter(|frame| {
            frame.contains("Let me run the long check.") && frame.contains("$ echo mid")
        })
        .collect();
    assert!(
        both.len() >= 2,
        "the run rendered frames in both the pending and flushed regimes:\n{}",
        run.frames.join("\n=====\n")
    );
    let row_of = |frame: &str, needle: &str| {
        frame
            .lines()
            .position(|line| line.contains(needle))
            .expect("the needle's row")
    };
    let pending = both[0];
    assert!(
        row_of(pending, "Let me run the long check.") < row_of(pending, "$ echo mid")
            && row_of(pending, "$ echo mid")
                < pending
                    .lines()
                    .position(|line| line.contains("Writing"))
                    .expect("the working loader row"),
        "while the turn streams the card holds above the execution indicator:\n{pending}"
    );
    let flushed = both[both.len() - 1];
    assert!(
        !flushed.contains("Writing"),
        "the flush frame is post-turn:\n{flushed}"
    );
    assert!(
        flushed.matches("$ echo mid").count() == 1,
        "the flushed card renders exactly once (not duplicated):\n{flushed}"
    );
    assert!(
        row_of(flushed, "Let me run the long check.") < row_of(flushed, "$ echo mid"),
        "after the turn ends the card sits in the transcript:\n{flushed}"
    );
}

/// A long run renders the 20-line tail preview (TS
/// `truncateToVisualLines` + the hidden logical count) and the truncation
/// notice names the spill file.
#[test]
fn a_long_truncated_run_previews_the_tail_and_names_the_spill_file() {
    let steps = vec![
        HeadlessStep::Submit("!seq 40".to_string()),
        HeadlessStep::WaitMs(500),
    ];
    let run = run_plan_with(steps, |supervisor| {
        supervisor.bash_chunks = (1..=40).map(|n| format!("line-{n}\n")).collect();
        supervisor.bash_end = Some(json!({
            "type": "bash_end",
            "exitCode": 0,
            "cancelled": false,
            "truncated": true,
            "fullOutputPath": "/tmp/bang-spill.log",
        }));
    });
    // The settled frame (the last one that shows the run) carries the
    // preview: the tail visible, the older half hidden — streaming
    // frames legitimately show the partial output as it arrives.
    let settled = run
        .frames
        .iter()
        .rev()
        .find(|frame| frame.contains("line-40"))
        .expect("the settled preview frame");
    assert!(settled.contains("line-40"), "the tail rendered:\n{settled}");
    assert!(
        settled.contains(" line-22")
            && !settled.contains(" line-21")
            && !settled.contains(" line-20"),
        "the preview shows exactly the last twenty visual lines:\n{settled}"
    );
    assert!(
        settled.contains("... 21 more lines"),
        "the hidden logical count names the cut (the trailing newline is\n its own line, TS parity):\n{settled}"
    );
    assert!(
        settled.contains("Output truncated. Full output: /tmp/bang-spill.log"),
        "the truncation notice names the spill file:\n{settled}"
    );
}

/// A cancelled run marks itself `(cancelled)` (TS `setComplete`'s
/// cancelled status outranks the exit code).
#[test]
fn a_cancelled_run_marks_the_card_cancelled() {
    let steps = vec![
        HeadlessStep::Submit("!sleep 5".to_string()),
        HeadlessStep::WaitMs(500),
    ];
    let run = run_plan_with(steps, |supervisor| {
        supervisor.bash_end = Some(json!({
            "type": "bash_end",
            "cancelled": true,
            "truncated": false,
        }));
    });
    let all = run.frames.join("\n");
    assert!(
        all.contains("(cancelled)"),
        "the cancelled marker rendered:\n{all}"
    );
    assert!(
        all.contains("$ sleep 5"),
        "the card keeps its command row:\n{all}"
    );
}

/// A bang run cut short by an update restart (§10): the link dies before
/// `bash_end`, the client reattaches, and the resync's `bashFinished`
/// edge settles the held card with an unknown exit and flushes it into
/// the rebuilt transcript (TS `renderResyncedSession` — no fake
/// `(cancelled)` marker, the hold released when no turn is streaming).
#[test]
fn an_update_restart_settles_the_held_bang_card_on_reattach() {
    let steps = vec![
        HeadlessStep::Submit("run a turn".to_string()),
        HeadlessStep::WaitMs(300),
        HeadlessStep::Submit("!echo mid".to_string()),
        HeadlessStep::WaitMs(600),
        HeadlessStep::WaitMs(2600),
    ];
    let run = run_plan_with(steps, |supervisor| {
        supervisor.turn_end_delay_ms = 1200;
        supervisor.update_restart_after_bash = true;
    });
    let all = run.frames.join("\n");
    assert!(
        all.contains("Reconnected to Prime Agent"),
        "the reattach banner landed:\n{all}"
    );
    let settled = run
        .frames
        .iter()
        .rev()
        .find(|frame| frame.contains("$ echo mid"))
        .expect("the reattached transcript kept the held card")
        .clone();
    assert!(
        !settled.contains("Running..."),
        "the held card settled on reattach:\n{settled}"
    );
    assert!(
        !settled.contains("(cancelled)") && !settled.contains("(exit "),
        "a run with no observed end renders no status marker:\n{settled}"
    );
    assert!(
        settled.contains("mid"),
        "the streamed output survived the resync:\n{settled}"
    );
}
