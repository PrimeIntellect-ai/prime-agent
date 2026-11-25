//! Headless e2e for `/secrets`: the rows the supervisor lists, the on/off
//! toggle, the add flow (the value prompt is masked and the value never
//! renders), and the two-press removal of a custom secret.
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

const VALUE: &str = "s3cr3t-value-never-shown";

fn row(name: &str, kind: &str, inject: bool, status: &str, host: &str) -> Value {
    json!({
        "name": name,
        "kind": kind,
        "inject": inject,
        "status": status,
        "hosts": [host],
        "fingerprint": "A1B2C3D4E5F6",
        "removable": kind == "custom",
    })
}

/// A supervisor that keeps the secrets list and records each secrets command.
fn serve(listener: &UnixListener, commands: &Mutex<Vec<Value>>) {
    let (stream, _) = listener.accept().expect("accept");
    let mut writer = stream.try_clone().expect("clone mock socket");
    let mut reader = BufReader::new(stream);
    write_json(
        &mut writer,
        &json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": [],
        }),
    );
    let mut rows = vec![
        row(
            "prime-inference",
            "api key",
            true,
            "ok",
            "api.pinference.ai",
        ),
        row(
            "prime-agent-bots-github",
            "github",
            true,
            "ok",
            "api.github.com",
        ),
    ];
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
        let id = envelope["id"].as_str().unwrap_or("");
        let command = &envelope["command"];
        let kind = command["type"].as_str().unwrap_or("");
        let data = match kind {
            "create" => json!({"activeSessionId": "owner", "sessionId": "owner"}),
            "attach" => json!({
                "activeSessionId": "owner",
                "snapshot": {
                    "activeSessionId": "owner",
                    "summary": { "id": "owner", "cwd": "/work" },
                    "state": {
                        "activeSessionId": "owner", "cwd": "/work", "sessionId": "owner",
                        "sessionName": "owner", "model": null, "isStreaming": false,
                        "isCompacting": false,
                        "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                    },
                    "messages": [], "lastEventSequence": 0, "lastEventCursor": null,
                },
            }),
            "get_commands" => json!({ "commands": [] }),
            "list_bot_secrets"
            | "set_bot_secret_inject"
            | "add_bot_secret"
            | "remove_bot_secret" => {
                commands.lock().unwrap().push(command.clone());
                let name = command["name"].as_str().unwrap_or_default();
                match kind {
                    "set_bot_secret_inject" => {
                        let inject = command["inject"].as_bool().unwrap();
                        for entry in &mut rows {
                            if entry["name"] == name {
                                entry["inject"] = json!(inject);
                                entry["status"] = json!(if inject { "ok" } else { "off" });
                            }
                        }
                    }
                    "add_bot_secret" => rows.push(row(
                        name,
                        "custom",
                        true,
                        "ok",
                        command["host"].as_str().unwrap_or_default(),
                    )),
                    "remove_bot_secret" => rows.retain(|entry| entry["name"] != name),
                    _ => {}
                }
                json!({ "secrets": rows, "hosts": rows.len(), "maxHosts": 32 })
            }
            _ => json!({}),
        };
        write_json(
            &mut writer,
            &json!({"type": "response", "id": id, "command": kind, "success": true, "data": data}),
        );
    }
}

fn write_json(writer: &mut UnixStream, value: &Value) {
    writeln!(writer, "{value}").expect("write mock response");
    writer.flush().expect("flush mock response");
}

fn options(socket: PathBuf) -> InteractiveOptions {
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

fn wait(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitRender {
        needle: needle.to_string(),
        timeout_ms: 10_000,
    }
}

fn key(code: KeyCode) -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(code, KeyModifiers::NONE))
}

fn answer(text: &str) -> [HeadlessStep; 2] {
    [HeadlessStep::Type(text.to_string()), key(KeyCode::Enter)]
}

#[test]
fn the_secrets_view_toggles_adds_and_removes() {
    std::env::remove_var("TMUX");
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("d.sock");
    let listener = UnixListener::bind(&socket).expect("bind mock socket");
    let commands = Arc::new(Mutex::new(Vec::new()));
    let server = std::thread::spawn({
        let commands = Arc::clone(&commands);
        move || serve(&listener, &commands)
    });
    let mut steps = vec![
        HeadlessStep::Submit("/secrets".into()),
        wait("Secrets bots get"),
        key(KeyCode::Enter),
        wait("[ ] prime-inference"),
        key(KeyCode::End),
        wait("\u{203a} + Add a custom secret"),
        key(KeyCode::Enter),
        wait("Secret name"),
    ];
    steps.extend(answer("ci_token"));
    steps.push(wait("HTTPS host"));
    steps.extend(answer("*.ci.example.com"));
    steps.push(wait("Header:"));
    steps.extend(answer("Bearer"));
    steps.push(wait("Value (stored on this Mac"));
    steps.push(HeadlessStep::Type(VALUE.into()));
    steps.push(HeadlessStep::WaitMs(200));
    steps.push(key(KeyCode::Enter));
    steps.push(wait("[x] ci_token"));
    steps.push(HeadlessStep::Key(KeyEvent::new(
        KeyCode::Char('x'),
        KeyModifiers::CONTROL,
    )));
    steps.push(wait("again to remove ci_token"));
    steps.push(HeadlessStep::Key(KeyEvent::new(
        KeyCode::Char('x'),
        KeyModifiers::CONTROL,
    )));
    steps.push(HeadlessStep::WaitGone {
        needle: "ci_token".to_string(),
        timeout_ms: 10_000,
    });
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let outcome = runtime
        .block_on(run_interactive(
            options(socket),
            UiMode::Headless(HeadlessPlan {
                steps,
                width: 100,
                height: 30,
            }),
        ))
        .expect("interactive run");
    server.join().expect("mock daemon finished");

    assert!(
        outcome.frames.iter().all(|frame| !frame.contains(VALUE)),
        "the value never renders"
    );
    let listed = outcome
        .frames
        .iter()
        .find(|frame| frame.contains("[x] prime-inference"))
        .expect("the first list");
    assert!(listed.contains("2/32 hosts"), "{listed}");
    let types: Vec<Value> = commands.lock().unwrap().clone();
    assert_eq!(
        types
            .iter()
            .map(|command| command["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "list_bot_secrets",
            "set_bot_secret_inject",
            "add_bot_secret",
            "remove_bot_secret"
        ]
    );
    assert_eq!(types[1]["inject"], false);
    assert_eq!(
        (
            &types[2]["name"],
            &types[2]["host"],
            &types[2]["header"],
            &types[2]["scheme"],
            &types[2]["value"],
        ),
        (
            &json!("ci_token"),
            &json!("*.ci.example.com"),
            &json!("Authorization"),
            &json!("Bearer"),
            &json!(VALUE),
        )
    );
    assert_eq!(types[3]["name"], "ci_token");
}
