//! The SIGTERM half of the shutdown-signal registration (lane
//! `interrupt-paths`): a SIGTERM to the interactive client must leave the
//! run gracefully (detach + normal teardown), not die by the default
//! disposition. Own test binary on purpose — the signal disposition is
//! process-global, so no other test may share the process.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

type CommandLog = Arc<Mutex<Vec<String>>>;

struct IdleSupervisor {
    listener: UnixListener,
    commands: CommandLog,
}

impl IdleSupervisor {
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
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
            self.commands.lock().unwrap().push(command_type.clone());
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
                    let mut data = attach_data();
                    data["id"] = json!(id);
                    write_json(&mut writer, &data);
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

fn write_json(writer: &mut UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

fn attach_data() -> Value {
    json!({
        "type": "response",
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
                    "sessionName": "sigterm session",
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

/// A SIGTERM while the session is attached leaves gracefully: the loop
/// breaks through the signal branch, the detach runs, and the process
/// survives (the pre-fix behavior was the default disposition's death).
#[test]
fn sigterm_leaves_the_interactive_run_gracefully() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let commands: CommandLog = Default::default();
    let supervisor = IdleSupervisor {
        listener: UnixListener::bind(&socket).expect("bind mock socket"),
        commands: Arc::clone(&commands),
    };
    let plan = HeadlessPlan {
        // The plan idles forever (the signal is what leaves).
        steps: vec![HeadlessStep::WaitMs(10_000)],
        width: 100,
        height: 30,
    };
    let options = InteractiveOptions {
        socket_path: socket.clone(),
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
        prompt_stash: Default::default(),
        session_has_children: false,
        client_settings: None,
    };
    let handle = std::thread::spawn(move || supervisor.serve());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let (outcome_tx, outcome_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = runtime.block_on(run_interactive(options, UiMode::Headless(plan)));
        let _ = outcome_tx.send(result);
    });
    // The attach command proves the loop is up (and the signal handlers
    // registered before it).
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let seen = commands.lock().unwrap().iter().any(|c| c == "attach");
        if seen {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the interactive run never attached"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // SIGTERM this process: the run must leave through the graceful path.
    libc_kill_self();
    let outcome = outcome_rx.recv_timeout(Duration::from_secs(15)).expect(
        "the SIGTERM left the run (the default disposition would have killed this process)",
    );
    let outcome = outcome.expect("interactive run succeeded");
    assert_eq!(outcome.active_session_id, "s1");
    let emitted = commands.lock().unwrap().clone();
    assert!(
        emitted.iter().any(|command| command == "detach"),
        "the graceful SIGTERM path must detach, got: {emitted:?}"
    );
    drop(handle);
}

fn libc_kill_self() {
    // SIGTERM to this very process, the scenario under test (the safe
    // nix signal wrapper — pa-tui forbids unsafe code even in tests).
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(std::process::id() as i32),
        nix::sys::signal::SIGTERM,
    )
    .expect("send SIGTERM to this process");
}
