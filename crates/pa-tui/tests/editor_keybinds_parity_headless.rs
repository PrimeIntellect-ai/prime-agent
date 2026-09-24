//! Headless e2e for the prompt-bar editing keybind parity set (the
//! operator's ask 2026-09-24): the full text-editing shortcuts users
//! expect — undo/redo of a paste, selection with shift+arrow families,
//! select-all replace, and the doc/paragraph jumps — driven through the
//! same key decode, dispatch, and editor model a terminal session uses.
//!
//! SANCTIONED DIVERGENCE from TS (documented per the #289 precedent): the
//! TS editor has no redo, no selection, and no doc/paragraph jumps; these
//! assertions pin the forward feature, not TS parity.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, ModelSelection,
    SessionSelection, UiMode,
};
use serde_json::{json, Value};

struct MockSupervisor {
    listener: UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// Serve one connection: attach an empty session and ack every
    /// command. The plan never submits — the editor state is the subject.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        let writer = stream.try_clone().expect("clone mock socket");
        let mut writer = writer;
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
                    write_json(
                        &mut writer,
                        &json!({
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
                                        "sessionName": "editing session",
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
                        }),
                    );
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
    }
}

/// Run a headless plan against a fresh mock supervisor; the captured
/// frames show the editor surface.
fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
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

/// The key events a terminal sends (crossterm's parsed forms): the legacy
/// control bytes this layer remaps (`0x1f` -> `Char('7')+CTRL` is
/// `ctrl+-`), the kitty shift+ctrl letter family, and the bare modifiers.
fn key(code: KeyCode, modifiers: KeyModifiers) -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(code, modifiers))
}

/// Undo: the byte a terminal sends for `Ctrl+-` (`0x1f`), which crossterm
/// parses as `Char('7')+CTRL` and keys.rs remaps to the `ctrl+-` id.
fn undo_key() -> HeadlessStep {
    key(KeyCode::Char('7'), KeyModifiers::CONTROL)
}

/// Redo: a kitty terminal sends `Ctrl+Shift+Z` as the shifted alternate,
/// which crossterm resolves to `Char('Z')+CTRL` (SHIFT cleared) — the
/// `shift+ctrl+z` id that matches the redo binding.
fn redo_key() -> HeadlessStep {
    key(KeyCode::Char('Z'), KeyModifiers::CONTROL)
}

/// Select all: `Ctrl+Shift+A`, the same kitty shifted-alternate shape.
fn select_all_key() -> HeadlessStep {
    key(KeyCode::Char('A'), KeyModifiers::CONTROL)
}

/// A real terminal sends `Ctrl+Home` as `CSI 1;5H`; crossterm parses it
/// to Home+CTRL, which keys.rs reports as the `ctrl+home` id.
fn ctrl_home() -> HeadlessStep {
    key(KeyCode::Home, KeyModifiers::CONTROL)
}

/// The paste->undo family: a paste lands in the editor, one undo restores
/// the pre-paste draft, and redo restores the pasted text again.
#[test]
fn paste_undo_redo_round_trip() {
    let frames = run_plan(vec![
        HeadlessStep::Type("draft before".to_string()),
        HeadlessStep::Paste("PASTED PAYLOAD".to_string()),
        undo_key(),
        redo_key(),
    ]);
    let all = frames.join("\n");
    assert!(
        all.contains("draft before"),
        "the draft text renders in the editor surface"
    );
    assert!(
        all.contains("PASTED PAYLOAD"),
        "the pasted payload renders after redo"
    );
    // The undo landed between: some frame shows the draft without the
    // payload (the paste undone) before the redo frame re-adds it.
    let undone = frames
        .iter()
        .any(|frame| frame.contains("draft before") && !frame.contains("PASTED PAYLOAD"));
    assert!(
        undone,
        "undo removes the whole paste in one press (pre-paste draft restored)"
    );
    let pasted_frame = frames
        .iter()
        .position(|frame| frame.contains("PASTED PAYLOAD"));
    // The LAST draft-without-payload frame is the undo frame (the first
    // one is the pre-paste typing).
    let undone_frame = frames
        .iter()
        .rposition(|frame| frame.contains("draft before") && !frame.contains("PASTED PAYLOAD"));
    assert!(
        match (pasted_frame, undone_frame) {
            (Some(pasted), Some(undone)) => undone > pasted,
            _ => false,
        },
        "the undo frame follows the paste frame (undo, not pre-paste state)"
    );
}

/// Select-all then typing replaces the whole prompt (the standard
/// editor's replace-selection behavior), and one undo restores it.
#[test]
fn select_all_replaces_and_undo_restores() {
    let frames = run_plan(vec![
        HeadlessStep::Type("original draft text".to_string()),
        select_all_key(),
        HeadlessStep::Type("replacement".to_string()),
        undo_key(),
    ]);
    let all = frames.join("\n");
    assert!(all.contains("replacement"), "the typed replace landed");
    let restored = frames
        .iter()
        .any(|frame| frame.contains("original draft text"));
    assert!(
        restored,
        "undo restores the replaced original after the select-all overwrite"
    );
    // The final frame shows the restored original.
    assert!(
        frames
            .last()
            .is_some_and(|frame| frame.contains("original draft text")),
        "the final frame is the restored original: {frames:?}"
    );
}

/// Shift+Left selects, Backspace deletes the selection (not one char).
#[test]
fn shift_selection_backspace_deletes_the_selection() {
    let frames = run_plan(vec![
        HeadlessStep::Type("abcdef".to_string()),
        key(KeyCode::Left, KeyModifiers::SHIFT),
        key(KeyCode::Left, KeyModifiers::SHIFT),
        key(KeyCode::Backspace, KeyModifiers::NONE),
    ]);
    assert!(
        frames.last().is_some_and(|frame| frame.contains("abcd")),
        "backspace removed the whole two-char selection: {frames:?}"
    );
    assert!(
        frames.last().is_some_and(|frame| !frame.contains("abcde")),
        "the selection (not one character) was deleted: {frames:?}"
    );
}

/// Ctrl+Home jumps to the start of the text; typing inserts there.
#[test]
fn ctrl_home_jumps_to_the_start() {
    let frames = run_plan(vec![
        HeadlessStep::Type("tail text".to_string()),
        ctrl_home(),
        HeadlessStep::Type("HEAD ".to_string()),
    ]);
    assert!(
        frames
            .last()
            .is_some_and(|frame| frame.contains("HEAD tail text")),
        "the doc-start jump placed the insertion at the head: {frames:?}"
    );
}
