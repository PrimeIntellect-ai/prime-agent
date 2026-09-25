//! Headless e2e for daemon request rejections in the interactive loop: a
//! mock supervisor answers with `success: false` for chosen commands, and
//! the TUI must render the TS `showError` row and keep running — a daemon
//! refusal (empty prompt, suspended admission, queue capacity, unknown
//! session) never exits the client. Only transport failures (a dead
//! connection) stay fatal.
//!
//! TS parity anchors (packages/coding-agent/src/modes/interactive):
//! `handleFollowUp` guards `if (!text || !this.editor.onSubmit) return;`
//! before dispatching — an empty alt+enter never reaches the daemon — and
//! `onSubmit`'s prompt catch restores the draft and calls `showError`
//! instead of exiting.
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

/// The real worker admission refusal (worker.rs `QUEUED_INPUT_SUSPENDED`),
/// the stand-in for every daemon-side "alive but refusing THIS request".
const SUSPENDED_ADMISSION: &str =
    "Cannot admit a session action while queued session input is suspended.";

/// How long the first turn stays open so the rejected follow-up is provably
/// mid-turn (the steer-rejection window).
const HOLD_TURN_OPEN_MS: u64 = 700;

struct MockSupervisor {
    listener: UnixListener,
    /// Every recorded `prompt` request payload.
    prompt_requests: Arc<Mutex<Vec<Value>>>,
    /// Every recorded `create` request payload (the update-restart wait's
    /// retry count reads its length).
    create_requests: Arc<Mutex<Vec<Value>>>,
    /// Reject the prompt at this 0-based dispatch index with
    /// [`SUSPENDED_ADMISSION`] instead of streaming a turn.
    reject_prompt_index: Option<usize>,
    /// Hold each accepted turn open this long before its `turn_end`.
    hold_turn_ms: u64,
    /// Drop the connection when the next prompt arrives (the dead-daemon
    /// transport case: the request gets no answer at all).
    close_on_prompt: bool,
    /// Reject the `create` command with this message (the saved-session
    /// open refusal: "session worker create failed: Session is already
    /// active in <id>: <file>").
    reject_create: Option<String>,
    /// Per-create answers, one popped per create (the update-restart
    /// window's scripted sequence): `None` accepts, `Some((message,
    /// error_info))` refuses with the message and the typed info. An
    /// empty queue falls through to `reject_create` (then accept).
    create_answers: Vec<Option<(String, Option<Value>)>>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            prompt_requests: Arc::new(Mutex::new(Vec::new())),
            create_requests: Arc::new(Mutex::new(Vec::new())),
            reject_prompt_index: None,
            hold_turn_ms: 0,
            close_on_prompt: false,
            reject_create: None,
            create_answers: Vec::new(),
        }
    }

    /// Serve one client connection until it goes quiet (bounded, so the
    /// plan teardown join always finishes).
    fn serve(mut self) {
        self.listener
            .set_nonblocking(true)
            .expect("nonblocking mock listener");
        let idle_window = std::time::Duration::from_millis(1500);
        let idle_until = std::time::Instant::now() + idle_window;
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
                "create" => {
                    {
                        let mut requests = self.create_requests.lock().unwrap();
                        requests.push(command.clone());
                    }
                    // The scripted answer queue first (one entry per
                    // create): the update-restart window's refusal
                    // sequence. The head entry serves this create, then
                    // pops for the next (a single trailing entry serves
                    // every later create). An exhausted queue falls
                    // through.
                    let queued = if self.create_answers.is_empty() {
                        None
                    } else {
                        let head = self.create_answers.first().cloned();
                        if self.create_answers.len() > 1 {
                            self.create_answers.remove(0);
                        }
                        head
                    };
                    if let Some(answer) = queued {
                        match answer {
                            Some((message, error_info)) => {
                                let mut refusal = json!({
                                    "type": "response",
                                    "id": id,
                                    "command": "create",
                                    "success": false,
                                    "error": message,
                                });
                                if let Some(error_info) = error_info {
                                    refusal["errorInfo"] = error_info;
                                }
                                write_json(&mut writer, &refusal);
                            }
                            None => write_json(
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
                            ),
                        }
                        continue;
                    }
                    if let Some(message) = &self.reject_create {
                        write_json(
                            &mut writer,
                            &json!({
                                "type": "response",
                                "id": id,
                                "command": "create",
                                "success": false,
                                "error": message,
                            }),
                        );
                        continue;
                    }
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
                "prompt" => {
                    let index = {
                        let mut requests = self.prompt_requests.lock().unwrap();
                        requests.push(command.clone());
                        requests.len() - 1
                    };
                    if self.close_on_prompt {
                        // The dead-daemon case: no answer, dead socket —
                        // dropping both halves fails the in-flight request
                        // with the transport error.
                        break;
                    }
                    if Some(index) == self.reject_prompt_index {
                        write_json(
                            &mut writer,
                            &json!({
                                "type": "response",
                                "id": id,
                                "command": "prompt",
                                "success": false,
                                "error": SUSPENDED_ADMISSION,
                            }),
                        );
                        continue;
                    }
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "prompt",
                            "success": true,
                        }),
                    );
                    // One model turn held open: the client streams the
                    // message until the delayed `turn_end` settles it.
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
                                    { "type": "text", "text": "the streamed answer" },
                                ],
                            },
                            "assistantMessageEvent": {
                                "type": "text_delta",
                                "delta": "the streamed answer",
                            },
                        }),
                    );
                    if self.hold_turn_ms == 0 {
                        write_session_event(
                            &mut writer,
                            &json!({
                                "type": "message_end",
                                "message": {
                                    "role": "assistant",
                                    "stopReason": "stop",
                                    "content": [
                                        { "type": "text", "text": "the streamed answer" },
                                    ],
                                },
                            }),
                        );
                        write_session_event(&mut writer, &json!({ "type": "turn_end" }));
                    } else {
                        let mut delayed = writer.try_clone().expect("clone delayed writer");
                        let delay = self.hold_turn_ms;
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(delay));
                            write_session_event(
                                &mut delayed,
                                &json!({
                                    "type": "message_end",
                                    "message": {
                                        "role": "assistant",
                                        "stopReason": "stop",
                                        "content": [
                                            { "type": "text", "text": "the streamed answer" },
                                        ],
                                    },
                                }),
                            );
                            write_session_event(&mut delayed, &json!({ "type": "turn_end" }));
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
                    "sessionName": "rejection session",
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

fn options_with_session(socket: PathBuf, session: SessionSelection) -> InteractiveOptions {
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
        session,
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

/// One alt+enter key event (the follow-up key, TS `app.message.followUp`).
fn alt_enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT)
}

/// One plain Enter key event.
fn enter() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

#[derive(Debug)]
struct RunOutcome {
    frames: Vec<String>,
    prompt_requests: Vec<Value>,
    create_requests: Vec<Value>,
    return_to_agents_view: bool,
    agents_view_notice: Option<String>,
}

/// Run the headless plan against a configured mock supervisor.
fn run_plan_with(
    steps: Vec<HeadlessStep>,
    configure: impl FnOnce(&mut MockSupervisor),
) -> anyhow::Result<RunOutcome> {
    run_plan_with_selection(steps, SessionSelection::New, configure)
}

fn run_plan_with_selection(
    steps: Vec<HeadlessStep>,
    selection: SessionSelection,
    configure: impl FnOnce(&mut MockSupervisor),
) -> anyhow::Result<RunOutcome> {
    run_plan(steps, selection, false, configure)
}

/// The agents-view open route (TS `openAgentsViewSession`, TS #2391): the
/// same harness through `run_interactive_agents_view_open`.
fn run_agents_view_plan_with_selection(
    steps: Vec<HeadlessStep>,
    selection: SessionSelection,
    configure: impl FnOnce(&mut MockSupervisor),
) -> anyhow::Result<RunOutcome> {
    run_plan(steps, selection, true, configure)
}

fn run_plan(
    steps: Vec<HeadlessStep>,
    selection: SessionSelection,
    agents_view_open: bool,
    configure: impl FnOnce(&mut MockSupervisor),
) -> anyhow::Result<RunOutcome> {
    // The ambient TMUX variable adds a startup notice to the transcript;
    // scrub it so the run is the same inside tmux and out.
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let mut supervisor = MockSupervisor::bind(&socket);
    configure(&mut supervisor);
    let prompt_requests = Arc::clone(&supervisor.prompt_requests);
    let create_requests = Arc::clone(&supervisor.create_requests);
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
    let options = options_with_session(socket, selection);
    let outcome = runtime.block_on(async {
        if agents_view_open {
            pa_tui::interactive::run_interactive_agents_view_open(options, UiMode::Headless(plan))
                .await
        } else {
            run_interactive(options, UiMode::Headless(plan)).await
        }
    })?;
    let _ = handle.join();
    Ok(RunOutcome {
        frames: outcome.frames,
        prompt_requests: Arc::try_unwrap(prompt_requests)
            .map(|locked| locked.into_inner().unwrap())
            .unwrap_or_else(|locked| locked.lock().unwrap().clone()),
        create_requests: Arc::try_unwrap(create_requests)
            .map(|locked| locked.into_inner().unwrap())
            .unwrap_or_else(|locked| locked.lock().unwrap().clone()),
        return_to_agents_view: outcome.return_to_agents_view,
        agents_view_notice: outcome.agents_view_notice,
    })
}

/// An empty follow-up submission (alt+enter on the empty editor) is TS
/// `handleFollowUp`'s silent no-op: nothing is dispatched, no error row
/// renders, and the client stays alive — the next turn still runs.
#[test]
fn empty_follow_up_is_a_silent_noop_and_the_client_stays_alive() {
    let steps = vec![
        HeadlessStep::Key(alt_enter()),
        HeadlessStep::Type("after the no-op".to_string()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(300),
    ];
    let run = run_plan_with(steps, |_| {}).expect("interactive run");
    let all = run.frames.join("\n");
    assert!(
        !all.contains("Prompt cannot be empty"),
        "the empty follow-up never reached the daemon:\n{all}"
    );
    assert!(
        !all.contains("\u{26a0} Error"),
        "the silent no-op renders no error row:\n{all}"
    );
    // The no-op consumed nothing: the next submit is dispatch 0 and its
    // turn streams normally (the client provably kept running).
    assert_eq!(run.prompt_requests.len(), 1, "one prompt dispatched");
    assert_eq!(
        run.prompt_requests[0]
            .get("message")
            .and_then(Value::as_str),
        Some("after the no-op")
    );
    assert!(
        all.contains("the streamed answer"),
        "the post-no-op turn rendered:\n{all}"
    );
}

/// A daemon refusal on a mid-turn follow-up submission renders the TS
/// error row and keeps the client mounted: the draft returns to the
/// editor, the open turn keeps streaming, and the run finishes normally.
#[test]
fn rejected_mid_turn_submission_renders_the_error_row_and_keeps_running() {
    let steps = vec![
        HeadlessStep::Type("first turn".to_string()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Type("steer me".to_string()),
        HeadlessStep::Key(alt_enter()),
        HeadlessStep::WaitMs(400),
    ];
    let run = run_plan_with(steps, |supervisor| {
        supervisor.hold_turn_ms = HOLD_TURN_OPEN_MS;
        supervisor.reject_prompt_index = Some(1);
    })
    .expect("interactive run stays mounted through the refusal");
    let all = run.frames.join("\n");
    assert_eq!(run.prompt_requests.len(), 2, "both prompts dispatched");
    // The TS `showError` row with the daemon's refusal message. The row
    // wraps at the render width, so compare the whitespace-flattened
    // frames.
    let flat = all.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        flat.contains(&format!(
            "\u{26a0} Error: the daemon rejected the prompt request: {SUSPENDED_ADMISSION}"
        )),
        "the refusal renders as the error row:\n{all}"
    );
    // The refused draft returns to the editor (TS restores the input).
    assert!(
        all.contains("steer me"),
        "the refused draft returned to the editor:\n{all}"
    );
    // The open turn kept streaming while the refusal surfaced.
    assert!(
        all.contains("the streamed answer"),
        "the held turn still rendered:\n{all}"
    );
}

/// A genuinely dead connection is still fatal: the transport failure
/// surfaces as the run's error, not an inline row — real daemon loss
/// must not be swallowed.
#[test]
fn dead_connection_on_prompt_still_exits_the_run() {
    let steps = vec![
        HeadlessStep::Type("hello".to_string()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(300),
    ];
    let error = run_plan_with(steps, |supervisor| {
        supervisor.close_on_prompt = true;
    })
    .expect_err("a dead connection on the prompt request must exit the run");
    assert!(
        !pa_tui::daemon_client::is_daemon_rejection(&error),
        "a dead connection is a transport failure, not a rejection: {error}"
    );
    assert!(
        error.to_string().contains("closed"),
        "the transport failure names the closed connection: {error}"
    );
}

/// A slash-prefixed follow-up keeps the follow-up lane (TS `onSubmit`
/// passes its captured `streamingBehavior` to the fallthrough prompt, so
/// alt+enter on unknown slash text parks on the follow-up lane, not the
/// steering lane — Bugbot's lost-lane finding on the submit-ladder reroute).
#[test]
fn slash_fallthrough_follow_up_keeps_the_follow_up_lane() {
    let steps = vec![
        HeadlessStep::Type("first turn".to_string()),
        HeadlessStep::Key(enter()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Type("/qqzz-not-a-command".to_string()),
        HeadlessStep::Key(alt_enter()),
        HeadlessStep::WaitMs(400),
    ];
    let run = run_plan_with(steps, |supervisor| {
        supervisor.hold_turn_ms = HOLD_TURN_OPEN_MS;
    })
    .expect("interactive run");
    assert_eq!(run.prompt_requests.len(), 2, "both prompts dispatched");
    let lane = |index: usize| {
        run.prompt_requests[index]
            .get("streamingBehavior")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    // Enter stays the steer lane; the alt+enter slash fallthrough rides
    // the follow-up lane to the daemon.
    assert_eq!(lane(0).as_deref(), Some("steer"));
    assert_eq!(
        lane(1).as_deref(),
        Some("followUp"),
        "the slash fallthrough keeps the submit's follow-up lane: {lane1:?}",
        lane1 = lane(1)
    );
    assert_eq!(
        run.prompt_requests[1]
            .get("message")
            .and_then(Value::as_str),
        Some("/qqzz-not-a-command")
    );
}

/// Opening a saved session whose create the daemon refuses — "session
/// worker create failed: Session is already active in <id>", another
/// instance holding the session file — must not exit the client (Kevin's
/// second reproducer): the run hands off to the agents view with the
/// refusal as its status line, the session-picker fallback.
#[test]
fn refused_saved_session_create_falls_back_to_the_agents_view() {
    let run = run_plan_with(vec![HeadlessStep::WaitMs(100)], |supervisor| {
        supervisor.reject_create = Some(
            "session worker create failed: Session is already active in 245ddb974b6d: /tmp/sess-1.jsonl"
                .to_string(),
        );
    })
    .expect("the refused create hands off instead of exiting");
    assert!(
        run.return_to_agents_view,
        "the refused create falls back to the agents view, not exit"
    );
    let notice = run.agents_view_notice.as_deref().unwrap_or_default();
    assert!(
        notice.contains(
            "the daemon rejected the create request: session worker create failed: Session is already active"
        ),
        "the agents-view notice carries the refusal: {notice}"
    );
    assert!(
        run.prompt_requests.is_empty(),
        "no prompt ever dispatched (the session never opened)"
    );
}

/// A refused create for a RESUMED session file (the agents-view open
/// path) surfaces the descriptive refusal: the TS-identical first line
/// plus the holder guidance and next steps, never the bare lease text.
#[test]
fn refused_saved_session_create_names_the_holder_and_next_steps() {
    let run = run_plan_with_selection(
        vec![HeadlessStep::WaitMs(100)],
        SessionSelection::Resume(std::path::PathBuf::from("/tmp/sess-1.jsonl")),
        |supervisor| {
            supervisor.reject_create = Some(
                "session worker create failed: Session is already active in 245ddb974b6d: /tmp/sess-1.jsonl"
                    .to_string(),
            );
        },
    )
    .expect("the refused create hands off instead of exiting");
    assert!(
        run.return_to_agents_view,
        "the refused create falls back to the agents view, not exit"
    );
    let notice = run.agents_view_notice.as_deref().unwrap_or_default();
    // The refusal stays a TYPED `RequestRejected` (the run hands off to
    // the agents view instead of exiting) and carries the decorated
    // SINGLE-LINE text: the agents-view status strip would hide a
    // multiline notice behind its first paragraph.
    assert!(
        notice
            .matches("the daemon rejected the create request:")
            .count()
            == 1,
        "the typed rejection frames the notice exactly once: {notice}"
    );
    assert!(
        notice.contains("Session is already active in 245ddb974b6d: /tmp/sess-1.jsonl"),
        "the notice keeps the daemon's refusal line verbatim: {notice}"
    );
    assert!(
        notice.contains("Holder: session 245ddb974b6d (no worker on this daemon serves it"),
        "the notice names the unreachable holder: {notice}"
    );
    assert!(
        notice.contains("Restarting this daemon reaps same-socket leftovers"),
        "the notice suggests the daemon-restart next step: {notice}"
    );
    assert!(
        notice.contains("The file unlocks when that process exits"),
        "the notice names the holder's exit as the other way around: {notice}"
    );
    assert!(
        !notice.contains("retry shortly"),
        "the false retry promise is gone from the ghost-holder arm: {notice}"
    );
    assert!(
        !notice.contains('\n'),
        "the notice rides ONE status line: {notice:?}"
    );
}

/// TS #2391 "agents view open during a daemon update restart": a create
/// rejected during the preparing-restart window is retried, the session
/// opens, and the wait notice surfaces — the session's status row and the
/// view's status line — never a bare failure.
#[test]
fn an_agents_view_open_waits_through_the_update_restart_window() {
    let run = run_agents_view_plan_with_selection(
        vec![
            // The wait's retry cadence is 500ms: let the retry land before
            // the agents-back key exits the run.
            HeadlessStep::WaitMs(1500),
            HeadlessStep::Key(KeyEvent::new(KeyCode::F(2), KeyModifiers::NONE)),
        ],
        SessionSelection::Resume(std::path::PathBuf::from("/tmp/sess-1.jsonl")),
        |supervisor| {
            supervisor.create_answers = vec![
                Some((
                    "Daemon is preparing an update restart".to_string(),
                    Some(json!({"code": "update_restarting"})),
                )),
                None,
            ];
        },
    )
    .expect("the wait opens the session");
    // The refused create was retried: exactly two creates.
    assert_eq!(run.create_requests.len(), 2, "one refusal, one retry");
    // The session OPENED and shows the wait row (the TS startup notice).
    let frames = run.frames.join("\n");
    assert!(
        frames.contains(
            "Waited for the Prime Agent daemon update restart to finish before opening this agent"
        ),
        "the session shows the wait row: {frames}"
    );
    // The agents-back handoff carries the notice for the view's status
    // line (TS `persistentState.statusMessage`).
    assert!(run.return_to_agents_view);
    assert_eq!(
        run.agents_view_notice.as_deref(),
        Some(
            "Waited for the Prime Agent daemon update restart to finish before opening this agent"
        )
    );
}

/// TS #2391's unmasked permanent failure: a create refused permanently
/// after the preparing-restart refusal surfaces with the refusal itself —
/// exactly two wire creates, no third attempt through the window, and no
/// wait notice for an open that never completed.
#[test]
fn a_permanent_create_failure_after_the_window_surfaces_unmasked() {
    let run = run_agents_view_plan_with_selection(
        vec![HeadlessStep::WaitMs(1500)],
        SessionSelection::Resume(std::path::PathBuf::from("/tmp/sess-1.jsonl")),
        |supervisor| {
            supervisor.create_answers = vec![
                Some((
                    "Daemon is preparing an update restart".to_string(),
                    Some(json!({"code": "update_restarting"})),
                )),
                Some(("File not found: /tmp/scope.jsonl".to_string(), None)),
            ];
        },
    )
    .expect("the run hands off instead of exiting");
    assert_eq!(run.create_requests.len(), 2, "no retry through the window");
    assert!(
        run.return_to_agents_view,
        "the unmasked refusal falls back to the agents view, not exit"
    );
    let notice = run.agents_view_notice.as_deref().unwrap_or_default();
    assert!(
        notice.contains("File not found: /tmp/scope.jsonl"),
        "the refusal surfaces unmasked: {notice}"
    );
    assert!(
        !notice.contains("Waited for the Prime Agent daemon update restart"),
        "no wait notice for an open that never completed: {notice}"
    );
}
