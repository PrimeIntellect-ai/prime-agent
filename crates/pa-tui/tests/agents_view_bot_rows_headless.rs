//! Headless e2e for the agents view's bot rows: a `list_bots` bot lists in its section, a bot
//! started while the view is open appears, and Enter on a bot row attaches through `attach_bot`
//! and opens the bot's session view.
#![cfg(unix)]

mod support;

use std::io::BufReader;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::Duration;

use pa_tui::agents_view::{run_agents_view, AgentsHeadlessPlan, AgentsStep, AgentsViewUiMode};
use pa_tui::interactive::{BotAttach, SessionSelection};
use serde_json::{json, Value};

use support::{read_line, respond, respond_failure, view_options, write_json};

/// The running bot `triage`, as `list_bots` lists it.
fn triage() -> Value {
    json!({
        "botId": "b1",
        "name": "triage",
        "ownerSessionId": "p",
        "sandboxId": "sbx-b1",
        "status": "running",
        "model": "anthropic/claude-haiku-4.5",
        "version": "0.10.5",
        "checkpointId": null,
        "createdAt": 1_795_406_400_000_i64,
        "lastTurnAt": null,
        "guestSessionId": "guest-b1",
        "attached": false,
    })
}

/// Serves one idle session, an empty saved catalog, the `list_bots` answer `bots` gives for each
/// call (numbered from 0), and the attach of `triage`; returns the bot ids the view asked to
/// attach.
fn serve(listener: &UnixListener, endpoint: &str, bots: fn(usize) -> Value) -> Vec<String> {
    let (stream, _) = listener.accept().expect("accept view connection");
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("read timeout");
    let mut writer = stream.try_clone().expect("clone socket");
    let mut reader = BufReader::new(stream);
    write_json(
        &mut writer,
        &json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": [],
        }),
    );
    let mut attached = Vec::new();
    let mut list_bots_calls = 0;
    while let Some(line) = read_line(&mut reader) {
        let Ok(envelope) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = envelope["id"].as_str().unwrap_or_default();
        let command = &envelope["command"];
        let command_type = command["type"].as_str().unwrap_or_default();
        let data = match command_type {
            "roster_subscribe" => json!({ "roster": [{
                "agentId": "p",
                "status": "idle",
                "summary": {
                    "sessionId": "p",
                    "lifecycle": "live",
                    "activeSessionId": "p-live",
                    "sessionFile": "/tmp/p.jsonl",
                    "runtimeKind": "top-level",
                    "sessionName": "release prep",
                    "messageCount": 2,
                    "rlmDepth": 0,
                },
            }] }),
            "list_saved_sessions" => json!({ "sessions": [] }),
            "list_bots" => {
                list_bots_calls += 1;
                json!({ "bots": bots(list_bots_calls - 1) })
            }
            "attach_bot" => {
                attached.push(command["botId"].as_str().unwrap_or_default().to_string());
                json!({ "botId": "b1", "endpoint": endpoint, "guestSessionId": "guest-b1" })
            }
            "roster_unsubscribe" => Value::Null,
            other => {
                respond_failure(&mut writer, id, other, "not handled by the mock");
                continue;
            }
        };
        respond(&mut writer, id, command_type, &data);
    }
    attached
}

#[tokio::test]
async fn enter_on_a_bot_row_attaches_and_opens_the_bot_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let endpoint = dir.path().join("bot.sock");
    let listener = UnixListener::bind(&socket).expect("bind mock socket");
    let endpoint_text = endpoint.display().to_string();
    let server =
        std::thread::spawn(move || serve(&listener, &endpoint_text, |_| json!([triage()])));
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2500 },
            AgentsStep::WaitRender {
                needle: "\u{2601} remote triage".to_string(),
                timeout_ms: 8000,
            },
            // The running bot leads the list, above the idle session.
            AgentsStep::Key("home".to_string()),
            AgentsStep::Key("enter".to_string()),
            // Holds the plan's end until the attach answer lands; its open ends the run.
            AgentsStep::WaitRender {
                needle: "the run ends before this renders".to_string(),
                timeout_ms: 8000,
            },
        ],
        width: 100,
        height: 30,
    };
    let outcome = Box::pin(run_agents_view(
        view_options(&socket),
        AgentsViewUiMode::Headless(plan),
        None,
    ))
    .await
    .expect("the agents view run")
    .outcome;
    let frame = outcome
        .frames
        .iter()
        .find(|frame| frame.contains("\u{2601} remote triage"))
        .expect("the bot row rendered");
    let rows: Vec<&str> = frame.lines().collect();
    let at = |needle: &str| rows.iter().position(|row| row.contains(needle)).unwrap();
    assert!(at("Running") < at("triage"), "{frame}");
    assert!(at("triage") < at("Idle"), "{frame}");
    assert!(at("Idle") < at("release prep"), "{frame}");
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Bot(BotAttach {
            bot_id: "b1".into(),
            name: "triage".into(),
            endpoint: PathBuf::from(&endpoint),
            guest_session_id: "guest-b1".into(),
        }))
    );
    assert_eq!(server.join().expect("mock"), ["b1"]);
}

/// A bot that appears while the view is open gets its row: the view polls `list_bots`.
#[tokio::test]
async fn a_bot_started_while_the_view_is_open_gets_its_row() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let listener = UnixListener::bind(&socket).expect("bind mock socket");
    let server = std::thread::spawn(move || {
        serve(&listener, "unused", |call| {
            if call == 0 {
                json!([])
            } else {
                json!([triage()])
            }
        })
    });
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2500 },
            AgentsStep::WaitRender {
                needle: "\u{2601} remote triage".to_string(),
                timeout_ms: 8000,
            },
        ],
        width: 100,
        height: 30,
    };
    let outcome = Box::pin(run_agents_view(
        view_options(&socket),
        AgentsViewUiMode::Headless(plan),
        None,
    ))
    .await
    .expect("the agents view run")
    .outcome;
    assert!(
        outcome
            .frames
            .iter()
            .any(|frame| frame.contains("\u{2601} remote triage")),
        "{:#?}",
        outcome.frames.last()
    );
    assert!(server.join().expect("mock").is_empty());
}
