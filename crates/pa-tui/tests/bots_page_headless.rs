//! Headless e2e for the `/bots` page: the rows the daemon answered, the error a malformed
//! answer shows, the attach refusal, the attach into the bot's own session view, and the
//! status bar's bots group that opens the page.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{
    run_interactive, BotAttach, HeadlessPlan, HeadlessStep, InteractiveOptions, InteractiveOutcome,
    ModelSelection, SessionSelection, UiMode,
};
use serde_json::{json, Value};

const MISMATCH: &str =
    "The bot runs prime-agent 0.10.4, but this Mac runs 0.10.5. Pause the bot and resume it: its sandbox then installs prime-agent 0.10.5.";

/// One scripted daemon: the session it attaches, and the `list_bots`/`attach_bot` answers
/// (`Err` answers as a refusal).
struct Mock {
    session: &'static str,
    list_bots: Value,
    attach_bot: Result<Value, &'static str>,
    /// Drop the connection right after the attach answer (a closed bot link).
    close_after_attach: bool,
}

fn serve(listener: &UnixListener, mock: &Mock) {
    let (stream, _) = listener.accept().expect("accept");
    let mut writer = stream.try_clone().expect("clone mock socket");
    let mut reader = BufReader::new(stream);
    write_json(
        &mut writer,
        &json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            // The kernel-bash lane arms the 2s poll that refreshes the dock's bots count.
            "serverCapabilities": ["kernel_bash_activity"],
        }),
    );
    // `pause_bot`/`resume_bot` flip the named row, like the daemon's registry.
    let mut list_bots = mock.list_bots.clone();
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
        let command = envelope
            .pointer("/command/type")
            .and_then(Value::as_str)
            .unwrap_or("");
        let session = mock.session;
        let answer = match command {
            "create" => Ok(json!({"activeSessionId": session, "sessionId": session})),
            "attach" => Ok(json!({
                "activeSessionId": session,
                "snapshot": {
                    "activeSessionId": session,
                    "summary": { "id": session, "cwd": "/work" },
                    "state": {
                        "activeSessionId": session,
                        "cwd": "/work",
                        "sessionId": session,
                        "sessionName": session,
                        "model": null,
                        "isStreaming": false,
                        "isCompacting": false,
                        "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                    },
                    "messages": [],
                    "lastEventSequence": 0,
                    "lastEventCursor": null,
                },
            })),
            "get_commands" => Ok(json!({ "commands": [] })),
            "list_bots" => Ok(list_bots.clone()),
            "pause_bot" | "resume_bot" => {
                let bot_id = envelope.pointer("/command/botId").cloned();
                let rows = list_bots["bots"].as_array_mut().into_iter().flatten();
                for row in rows.filter(|row| row.get("botId") == bot_id.as_ref()) {
                    if command == "pause_bot" {
                        row["status"] = json!("paused");
                        row["statusSince"] = json!(1_795_410_642_000_i64);
                        row["pauseAt"] = Value::Null;
                    } else {
                        row["status"] = json!("running");
                        row["pauseAt"] = json!(unix_ms() + 110_000);
                    }
                }
                Ok(json!({}))
            }
            "attach_bot" => mock.attach_bot.clone(),
            _ => Ok(json!({})),
        };
        let response = match answer {
            Ok(data) => {
                json!({"type": "response", "id": id, "command": command, "success": true, "data": data})
            }
            Err(error) => {
                json!({"type": "response", "id": id, "command": command, "success": false, "error": error})
            }
        };
        write_json(&mut writer, &response);
        if mock.close_after_attach && command == "attach" {
            break;
        }
    }
}

fn unix_ms() -> i64 {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    i64::try_from(elapsed.as_millis()).unwrap()
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    writeln!(writer, "{value}").expect("write mock response");
    writer.flush().expect("flush mock response");
}

/// A row like the daemon's: stamps in Unix milliseconds.
fn bot(bot_id: &str, name: &str, status: &str, last_turn: Option<i64>) -> Value {
    json!({
        "botId": bot_id,
        "name": name,
        "ownerSessionId": "owner",
        "sandboxId": format!("sbx-{bot_id}"),
        "status": status,
        "model": "anthropic/claude-haiku-4.5",
        "version": "0.10.5",
        "checkpointId": null,
        "createdAt": 1_795_406_400_000_i64,
        "lastTurnAt": last_turn,
        "guestSessionId": format!("guest-{bot_id}"),
        "attached": false,
    })
}

fn options(socket: PathBuf, session: SessionSelection) -> InteractiveOptions {
    InteractiveOptions {
        models: None,
        socket_path: socket,
        cwd: PathBuf::from("/work"),
        session_dir: None,
        script_path: None,
        model_selection: ModelSelection::default(),
        model_catalog: Vec::new(),
        model_configured_providers: std::collections::HashSet::default(),
        model_recent_models: Vec::new(),
        default_thinking_level: None,
        no_session: false,
        session,
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

/// Run one headless plan against `mock` listening on `socket`.
fn run(
    socket: &Path,
    session: SessionSelection,
    mock: Mock,
    steps: Vec<HeadlessStep>,
) -> InteractiveOutcome {
    std::env::remove_var("TMUX");
    let listener = UnixListener::bind(socket).expect("bind mock socket");
    let server = std::thread::spawn(move || serve(&listener, &mock));
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
            options(socket.to_path_buf(), session),
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    server.join().expect("mock daemon finished");
    outcome
}

fn wait(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitRender {
        needle: needle.to_string(),
        timeout_ms: 10_000,
    }
}

fn last_frame_with<'a>(outcome: &'a InteractiveOutcome, needle: &str) -> &'a str {
    outcome
        .frames
        .iter()
        .rev()
        .find(|frame| frame.contains(needle))
        .unwrap_or_else(|| panic!("no frame contains {needle}: {:#?}", outcome.frames.last()))
}

fn local_mock(list_bots: Value, attach_bot: Result<Value, &'static str>) -> Mock {
    Mock {
        session: "owner",
        list_bots,
        attach_bot,
        close_after_attach: false,
    }
}

#[test]
fn the_page_lists_the_bots_and_counts_the_bad_rows() {
    let dir = tempfile::tempdir().unwrap();
    let list = json!({"bots": [
        bot("b1", "nightly-digest", "paused", Some(1_795_410_642_000)),
        bot("b2", "triage", "running", None),
        {"botId": "b3", "status": "running"},
    ]});
    let outcome = run(
        &dir.path().join("d.sock"),
        SessionSelection::New,
        local_mock(list, Err("unused")),
        vec![HeadlessStep::Submit("/bots".into()), wait("nightly-digest")],
    );
    let frame = last_frame_with(&outcome, "nightly-digest");
    let rows: Vec<&str> = frame.lines().collect();
    let at = |needle: &str| rows.iter().position(|row| row.contains(needle)).unwrap();
    assert!(at("Running (1)") < at("triage"), "{frame}");
    assert!(at("triage") < at("Idle (1)"), "{frame}");
    assert!(at("Idle (1)") < at("nightly-digest"), "{frame}");
    assert!(
        rows[at("nightly-digest") + 1].contains("last turn 11-23 05:10"),
        "{frame}"
    );
    assert!(rows[at("triage")].contains("v0.10.5"), "{frame}");
    assert!(frame.contains("1 malformed bot rows skipped"), "{frame}");
}

/// The /bots page shows the tree: a bot's children follow it, indented
/// with an arrow, and a bot that spawns bots carries the mark.
#[test]
fn the_page_nests_a_bots_children_under_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut parent = bot("b1", "chief-of-staff", "running", None);
    parent["spawnsBots"] = json!(true);
    let mut child = bot("b2", "scout", "running", None);
    child["parentBotId"] = json!("b1");
    let outcome = run(
        &dir.path().join("d.sock"),
        SessionSelection::New,
        local_mock(json!({"bots": [child.clone(), parent]}), Err("unused")),
        vec![HeadlessStep::Submit("/bots".into()), wait("chief-of-staff")],
    );
    let frame = last_frame_with(&outcome, "chief-of-staff");
    let rows: Vec<&str> = frame.lines().collect();
    let at = |needle: &str| rows.iter().position(|row| row.contains(needle)).unwrap();
    assert!(
        at("chief-of-staff") < at("\u{21b3} scout"),
        "the child follows: {frame}"
    );
    assert!(
        rows[at("chief-of-staff") + 1].contains("spawns bots"),
        "{frame}"
    );
}

#[test]
fn p_pauses_the_running_bot_and_resumes_the_paused_bot() {
    let dir = tempfile::tempdir().unwrap();
    let key = |code| HeadlessStep::Key(KeyEvent::new(code, KeyModifiers::NONE));
    let mut triage = bot("b1", "triage", "running", None);
    triage["pauseAt"] = json!(unix_ms() + 110_000);
    let outcome = run(
        &dir.path().join("d.sock"),
        SessionSelection::New,
        local_mock(json!({"bots": [triage]}), Err("unused")),
        vec![
            HeadlessStep::Submit("/bots".into()),
            wait("triage"),
            key(KeyCode::Char('d')),
            wait("pauses in 2 min"),
            key(KeyCode::Char('p')),
            wait("paused since 2026-11-23T05:10:42Z"),
            key(KeyCode::Char('p')),
            wait("pauses in 2 min"),
        ],
    );
    let paused = last_frame_with(&outcome, "paused since");
    assert!(paused.contains("Idle (1)"), "{paused}");
    assert!(outcome
        .frames
        .last()
        .is_some_and(|frame| frame.contains("Running (1)")));
}

#[test]
fn the_status_bar_counts_the_running_bots_and_opens_the_page() {
    let dir = tempfile::tempdir().unwrap();
    let list = json!({"bots": [
        bot("b1", "nightly-digest", "paused", None),
        bot("b2", "triage", "running", None),
    ]});
    let outcome = run(
        &dir.path().join("d.sock"),
        SessionSelection::New,
        local_mock(list, Err("unused")),
        vec![
            wait("\u{25c8} 1 bot"),
            // Focus the dock, step subagents -> heartbeats -> shells -> bots, and open it.
            HeadlessStep::Key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::ALT)),
            HeadlessStep::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
            HeadlessStep::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
            HeadlessStep::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
            wait("1 running \u{b7} 1 alive"),
            HeadlessStep::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            wait("sandboxes this Mac owns"),
        ],
    );
    let dock = last_frame_with(&outcome, "\u{25c8} 1 bot");
    assert!(
        dock.contains("\u{25b8} 0 shells  \u{b7}  \u{25c8} 1 bot"),
        "{dock}"
    );
    assert!(last_frame_with(&outcome, "sandboxes this Mac owns").contains("nightly-digest"));
}

#[test]
fn esc_from_the_bots_command_lands_on_the_dock_bots_group() {
    let dir = tempfile::tempdir().unwrap();
    let outcome = run(
        &dir.path().join("d.sock"),
        SessionSelection::New,
        local_mock(json!({"bots": []}), Err("unused")),
        vec![
            HeadlessStep::Submit("/bots".into()),
            wait("sandboxes this Mac owns"),
            HeadlessStep::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            HeadlessStep::WaitGone {
                needle: "sandboxes this Mac owns".to_string(),
                timeout_ms: 10_000,
            },
            // The exit focused the dock's bots group: Enter reopens the page.
            HeadlessStep::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            wait("sandboxes this Mac owns"),
        ],
    );
    assert!(!outcome.return_to_agents_view);
    assert!(outcome
        .frames
        .last()
        .is_some_and(|frame| frame.contains("sandboxes this Mac owns")));
}

#[test]
fn an_answer_without_a_bots_list_is_an_error_on_the_page() {
    let dir = tempfile::tempdir().unwrap();
    let outcome = run(
        &dir.path().join("d.sock"),
        SessionSelection::New,
        local_mock(json!({"sessions": []}), Err("unused")),
        vec![HeadlessStep::Submit("/bots".into()), wait("Error:")],
    );
    let frame = last_frame_with(&outcome, "Error:");
    assert!(
        frame.contains(pa_tui::bots_view::MALFORMED_BOTS_REPLY),
        "{frame}"
    );
    assert!(
        !frame.contains("No bots."),
        "a malformed answer never reads as empty: {frame}"
    );
}

#[test]
fn a_version_mismatch_refuses_the_attach_on_the_page() {
    let dir = tempfile::tempdir().unwrap();
    let outcome = run(
        &dir.path().join("d.sock"),
        SessionSelection::New,
        local_mock(
            json!({"bots": [bot("b1", "triage", "paused", None)]}),
            Err(MISMATCH),
        ),
        vec![
            HeadlessStep::Submit("/bots".into()),
            wait("triage"),
            HeadlessStep::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            wait("this Mac runs 0.10.5"),
        ],
    );
    assert!(
        outcome.selection_request.is_none(),
        "a refused attach stays on the page"
    );
    assert!(last_frame_with(&outcome, "this Mac runs 0.10.5").contains("triage"));
}

#[test]
fn enter_attaches_the_bot_session_and_refuses_local_commands() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = dir.path().join("bot.sock");
    let attach = json!({"botId": "b1", "endpoint": endpoint, "guestSessionId": "guest-b1"});
    let outcome = run(
        &dir.path().join("d.sock"),
        SessionSelection::New,
        local_mock(
            json!({"bots": [bot("b1", "triage", "paused", None)]}),
            Ok(attach),
        ),
        vec![
            HeadlessStep::Submit("/bots".into()),
            wait("triage"),
            HeadlessStep::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            // The handoff leaves the run as soon as the attach lands.
            HeadlessStep::WaitGone {
                needle: "Bots · sandboxes".to_string(),
                timeout_ms: 10_000,
            },
        ],
    );
    let expected = BotAttach {
        bot_id: "b1".into(),
        name: "triage".into(),
        endpoint: endpoint.clone(),
        guest_session_id: "guest-b1".into(),
    };
    assert_eq!(
        outcome.selection_request,
        Some(SessionSelection::Bot(expected.clone()))
    );

    // The handoff opens the bot's session over the endpoint, in the normal session view.
    let guest = Mock {
        session: "guest-b1",
        list_bots: json!({}),
        attach_bot: Err("unused"),
        close_after_attach: false,
    };
    let outcome = run(
        &endpoint,
        SessionSelection::Bot(expected),
        guest,
        vec![
            wait("guest-b1"),
            HeadlessStep::Submit("/login".into()),
            wait("/login runs on this Mac"),
            HeadlessStep::Type("/mcp x".into()),
            HeadlessStep::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)),
            wait("/mcp runs on this Mac"),
        ],
    );
    assert_eq!(outcome.active_session_id, "guest-b1");
    assert!(last_frame_with(&outcome, "/mcp runs on this Mac").contains("Leave the bot view"));
}

#[test]
fn a_closed_bot_link_shows_an_error_and_never_reconnects() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = dir.path().join("bot.sock");
    let bot = BotAttach {
        bot_id: "b1".into(),
        name: "triage".into(),
        endpoint: endpoint.clone(),
        guest_session_id: "guest-b1".into(),
    };
    let guest = Mock {
        session: "guest-b1",
        list_bots: json!({}),
        attach_bot: Err("unused"),
        close_after_attach: true,
    };
    let outcome = run(
        &endpoint,
        SessionSelection::Bot(bot),
        guest,
        vec![
            wait("link to the bot triage closed"),
            HeadlessStep::WaitMs(1_500),
        ],
    );
    let last = outcome.frames.last().unwrap();
    assert!(last.contains("link to the bot triage closed"), "{last}");
    assert!(!last.contains("reconnecting"), "{last}");
}

#[test]
fn a_failed_bot_connect_hands_back_instead_of_exiting() {
    let dir = tempfile::tempdir().unwrap();
    let bot = BotAttach {
        bot_id: "b1".into(),
        name: "triage".into(),
        endpoint: dir.path().join("gone.sock"),
        guest_session_id: "guest-b1".into(),
    };
    std::env::remove_var("TMUX");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps: Vec::new(),
        width: 100,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(
            options(dir.path().join("d.sock"), SessionSelection::Bot(bot)),
            UiMode::Headless(plan),
        ))
        .expect("a failed bot connect is not a fatal error");
    assert!(outcome.return_to_agents_view);
    assert!(outcome.agents_view_notice.is_some());
}
