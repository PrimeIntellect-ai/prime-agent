// large_futures: stack-resident futures on hot paths by design.
// too_many_lines: style gate, not correctness. Casts: 64-bit targets;
// narrowing sits at bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Real-pty e2e for the turn-settle scrollback flush: a settled turn appends
//! its new transcript rows into the native scrollback (off the alternate
//! screen), consecutive turns append without duplication, and the
//! `PRIME_AGENT_TUI_EXIT_FLUSH=0` kill switch suppresses the automatic flush.
//! Unlike `slow_drain`/`exit_backfill`, this fixture may set the kill switch
//! because it asserts only the AUTO flush; those fixtures must keep the `None`
//! settings seam.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use nix::fcntl::{fcntl, FcntlArg::F_SETFL, OFlag};
use nix::pty::{openpty, Winsize};
use serde_json::{json, Value};

use pa_tui::interactive::{
    run_interactive, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};

/// Answering like a kitty terminal keeps the probe's bounded wait from adding its full budget.
const KITTY_QUERY: &[u8] = b"\x1b[?u";
const KITTY_ANSWER: &[u8] = b"\x1b[?7u\x1b[?62;c";
const ALT_SCREEN_LEAVE: &[u8] = b"\x1b[?1049l";
const ALT_SCREEN_ENTER: &[u8] = b"\x1b[?1049h";
const CHILD_SOCKET_ENV: &str = "PA_SCROLLBACK_FLUSH_CHILD_SOCKET";
/// The wait bound for one settle flush: the mock turn streams well inside it.
const FLUSH_WAIT: Duration = Duration::from_secs(20);
/// The pause between the turn's start and its streamed content: the settle detection
/// snapshots `turn_active` per iteration, so the start must land in its own batch.
const TURN_PACING: Duration = Duration::from_millis(300);

/// The child half: runs the real interactive loop against the parent's mock supervisor; a
/// plain `cargo test` run passes trivially.
#[test]
fn scrollback_flush_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        run_interactive(options, UiMode::Terminal)
            .await
            .expect("the chat surface ran");
        pa_tui::exit_guard::note_exit_progress();
        std::thread::sleep(Duration::from_millis(300));
    });
}

/// The pty harnesses serialize: concurrent byte-level waits flake on the shared test CPUs.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn a_settled_turn_flushes_into_native_scrollback_and_grows() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let turns = Arc::new(AtomicUsize::new(0));
    let mut harness = ScrollbackHarness::start(Arc::clone(&turns), false);

    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.write(KITTY_ANSWER);
    harness.wait_from_start(
        b"Collapsed mode (Ctrl+O to expand)",
        "the session frame mounted",
    );
    harness.settle();

    let mark = harness.output().len();
    harness.submit("hello");
    let first = harness.wait_settle_flush(mark, "hello", "first answer");
    let joined = String::from_utf8_lossy(&first);
    assert!(
        !joined.contains("Collapsed mode"),
        "the dock never lands in scrollback:\n{joined}"
    );

    // The second turn appends only ITS rows: the first turn's transcript stays put.
    let mark = harness.output().len();
    harness.submit("again");
    let second = harness.wait_settle_flush(mark, "again", "second answer");
    let joined = String::from_utf8_lossy(&second);
    assert!(
        !joined.contains("what happened") && !joined.contains("first answer"),
        "the settled base never re-appends the prior turn:\n{joined}"
    );
}

#[test]
fn the_exit_flush_kill_switch_suppresses_the_auto_flush() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let turns = Arc::new(AtomicUsize::new(0));
    let mut harness = ScrollbackHarness::start(Arc::clone(&turns), true);

    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.write(KITTY_ANSWER);
    harness.wait_from_start(
        b"Collapsed mode (Ctrl+O to expand)",
        "the session frame mounted",
    );
    harness.settle();

    let mark = harness.output().len();
    harness.submit("hello");
    harness
        .master
        .wait_from(mark, b"first answer", "the turn streamed");
    harness.settle();
    let output = harness.output();
    assert!(
        find_subsequence(&output[mark..], ALT_SCREEN_LEAVE).is_none(),
        "the kill switch suppresses the automatic settle flush"
    );
}

/// One attached session behind a mock supervisor socket: `create` + `attach` answer the
/// startup, and each `prompt` runs one streamed turn whose settle must append scrollback.
/// With `kill_switch` set, the child runs with `PRIME_AGENT_TUI_EXIT_FLUSH=0`.
struct ScrollbackHarness {
    child: Child,
    _server: std::thread::JoinHandle<()>,
    master: PtyReader,
}

impl ScrollbackHarness {
    fn submit(&mut self, text: &str) {
        // One keystroke at a time: a single burst write to the pty can drop
        // characters on the slow virtiofs-backed test host.
        for ch in text.chars() {
            self.write(ch.to_string().as_bytes());
            std::thread::sleep(Duration::from_millis(15));
        }
        self.write(b"\r");
    }

    fn start(turns: Arc<AtomicUsize>, kill_switch: bool) -> ScrollbackHarness {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("tui.sock");
        let supervisor = MockSupervisor::bind(&socket, turns);
        let server = std::thread::spawn(move || supervisor.serve());

        let pty = openpty(
            Some(&Winsize {
                ws_row: 40,
                ws_col: 120,
                ws_xpixel: 0,
                ws_ypixel: 0,
            }),
            None,
        )
        .expect("open pty");

        let child = spawn_child(&socket, &pty.slave, kill_switch);
        // The child needs the socket for its lifetime.
        std::mem::forget(dir);
        ScrollbackHarness {
            child,
            _server: server,
            master: PtyReader::new(pty.master),
        }
    }

    fn write(&mut self, payload: &[u8]) {
        self.master.write(payload);
    }

    fn wait_from_start(&mut self, needle: &[u8], what: &str) {
        self.master.wait_from(0, needle, what);
    }

    /// Wait for the settled turn's scrollback flush: the alt-screen leave, the turn's rows,
    /// and the alt-screen re-enter, all after `mark`. Returns the flushed region's bytes.
    fn wait_settle_flush(&mut self, mark: usize, question: &str, answer: &str) -> Vec<u8> {
        let deadline = Instant::now() + FLUSH_WAIT;
        loop {
            let output = self.output();
            let Some(leave_at) = find_subsequence(&output[mark..], ALT_SCREEN_LEAVE) else {
                if Instant::now() > deadline {
                    let text = String::from_utf8_lossy(&output[mark..]);
                    panic!("no alt-screen leave after {mark}; pty tail since mark:\n{text}");
                }
                self.drain();
                continue;
            };
            let base = mark + leave_at;
            let Some(enter_at) = find_subsequence(&output[base..], ALT_SCREEN_ENTER) else {
                assert!(
                    Instant::now() < deadline,
                    "the flush never re-entered the alternate screen"
                );
                self.drain();
                continue;
            };
            let region = &output[base..base + enter_at];
            let question = question.as_bytes();
            let answer = answer.as_bytes();
            if find_subsequence(region, question).is_some()
                && find_subsequence(region, answer).is_some()
            {
                return region.to_vec();
            }
            assert!(
                Instant::now() < deadline,
                "the flushed region never carried the turn's rows:\n{}",
                String::from_utf8_lossy(region)
            );
            self.drain();
        }
    }

    fn drain(&mut self) {
        std::thread::sleep(Duration::from_millis(25));
        let mut buffer = [0u8; 8192];
        match self.master.file.read(&mut buffer) {
            Ok(0) | Err(_) => {}
            Ok(n) => self.master.output.extend_from_slice(&buffer[..n]),
        }
    }

    fn settle(&mut self) {
        self.master.drain_until_quiet(20);
    }

    fn output(&self) -> Vec<u8> {
        self.master.output.clone()
    }
}

impl Drop for ScrollbackHarness {
    fn drop(&mut self) {
        // A panicking wait must never leak the pty child (it owns its session's controlling
        // terminal).
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Non-blocking reader over the pty master, collecting the child's bytes.
struct PtyReader {
    file: std::fs::File,
    output: Vec<u8>,
}

impl PtyReader {
    fn new(master: OwnedFd) -> PtyReader {
        let fd = master.as_raw_fd();
        fcntl(fd, F_SETFL(OFlag::O_NONBLOCK)).expect("pty master non-blocking");
        PtyReader {
            file: master.into(),
            output: Vec::new(),
        }
    }

    fn write(&mut self, payload: &[u8]) {
        self.file.write_all(payload).expect("write to the pty");
    }

    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        let mut quiet = 0;
        while quiet < quiet_polls {
            let mut buffer = [0u8; 8192];
            match self.file.read(&mut buffer) {
                Ok(0) | Err(_) => quiet += 1,
                Ok(n) => {
                    self.output.extend_from_slice(&buffer[..n]);
                    quiet = 0;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn wait_from(&mut self, mark: usize, needle: &[u8], what: &str) {
        let deadline = Instant::now() + FLUSH_WAIT;
        loop {
            if find_subsequence(&self.output[mark..], needle).is_some() {
                return;
            }
            if Instant::now() > deadline {
                let text = String::from_utf8_lossy(&self.output[mark..]);
                panic!(
                    "{what}: the wait bound expired (needle {needle:?}); pty tail since mark:\n{text}"
                );
            }
            let mut buffer = [0u8; 8192];
            match self.file.read(&mut buffer) {
                Ok(0) | Err(_) => {}
                Ok(n) => self.output.extend_from_slice(&buffer[..n]),
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

/// The child runs on the pty as its controlling terminal; key and answer events otherwise
/// read through `/dev/tty`.
fn spawn_child(socket: &Path, slave: &OwnedFd, kill_switch: bool) -> Child {
    fn claim_controlling_tty(fd: i32) -> std::io::Result<()> {
        nix::unistd::setsid()?;
        let rc = unsafe { libc::ioctl(fd, libc::TIOCSCTTY as libc::c_ulong, 0) };
        if rc < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    let slave_fd = slave.as_raw_fd();
    let mut command = Command::new(std::env::current_exe().expect("test binary"));
    command
        .arg("--exact")
        .arg("scrollback_flush_child_mode")
        .arg("--nocapture")
        .env(CHILD_SOCKET_ENV, socket)
        .env_remove("TMUX")
        .stdin(slave_as_stdio(slave))
        .stdout(slave_as_stdio(slave))
        .stderr(slave_as_stdio(slave));
    if kill_switch {
        command.env("PRIME_AGENT_TUI_EXIT_FLUSH", "0");
    }
    // SAFETY: the pre_exec hook is the supported std seam for session/terminal setup; it
    // runs post-fork pre-exec in the child only and cannot allocate.
    unsafe {
        command.pre_exec(move || claim_controlling_tty(slave_fd));
    }
    command.spawn().expect("spawn pty child")
}

fn slave_as_stdio(slave: &OwnedFd) -> Stdio {
    slave.try_clone().expect("clone pty slave").into()
}

fn child_options(socket: PathBuf) -> InteractiveOptions {
    let agent_dir = tempfile::TempDir::new().expect("agent dir");
    let cwd = tempfile::TempDir::new().expect("cwd");
    // The settings handle reads a REAL SettingsManager over ISOLATED temp dirs: the store's
    // default-true `terminal.scrollbackFlush` must reach the flush gate, and the developer's
    // real `~/.prime/agent/settings.json` must never open.
    let settings: std::sync::Arc<dyn pa_tui::client_settings::ClientSettings> =
        std::sync::Arc::new(SettingsStoreSettings {
            cwd: cwd.path().to_path_buf(),
            agent_dir: agent_dir.path().to_path_buf(),
        });
    // The session cwd stays an EMPTY temp dir (the autocomplete provider indexes it on
    // open); every temp dir outlives the run untracked.
    let session_cwd = tempfile::TempDir::new().expect("session cwd");
    let session_cwd_path = session_cwd.path().to_path_buf();
    std::mem::forget((agent_dir, cwd, session_cwd));
    InteractiveOptions {
        models: None,
        socket_path: socket,
        cwd: session_cwd_path,
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
        telemetry_disabled: Some(true),
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
        client_settings: Some(settings),
    }
}

/// The client-settings seam over a real `SettingsManager` bound to isolated temp dirs: the
/// store's live read decides the flush; every other accessor answers its default.
struct SettingsStoreSettings {
    cwd: PathBuf,
    agent_dir: PathBuf,
}

impl pa_tui::client_settings::ClientSettings for SettingsStoreSettings {
    fn compaction_threshold_percent(&self) -> f64 {
        95.0
    }
    fn set_compaction_threshold_percent(&self, _percent: f64) -> anyhow::Result<()> {
        Ok(())
    }
    fn theme(&self) -> Option<String> {
        None
    }
    fn image_model(&self) -> Option<String> {
        None
    }
    fn default_service_tier(&self) -> String {
        "default".to_string()
    }
    fn set_default_service_tier(&self, _tier: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn set_theme(&self, _theme: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn show_images(&self) -> bool {
        true
    }
    fn set_show_images(&self, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn clear_on_shrink(&self) -> bool {
        false
    }
    fn set_clear_on_shrink(&self, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn show_terminal_progress(&self) -> bool {
        false
    }
    fn set_show_terminal_progress(&self, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn scrollback_flush(&self) -> bool {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
            .get_scrollback_flush()
    }
    fn image_auto_resize(&self) -> bool {
        true
    }
    fn set_image_auto_resize(&self, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn block_images(&self) -> bool {
        false
    }
    fn set_block_images(&self, _blocked: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn enable_skill_commands(&self) -> bool {
        true
    }
    fn set_enable_skill_commands(&self, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn enable_builtin_skills(&self) -> bool {
        true
    }
    fn set_enable_builtin_skills(&self, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn show_hardware_cursor(&self) -> bool {
        false
    }
    fn set_show_hardware_cursor(&self, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn editor_padding_x(&self) -> u64 {
        0
    }
    fn set_editor_padding_x(&self, _padding: u64) -> anyhow::Result<()> {
        Ok(())
    }
    fn autocomplete_max_visible(&self) -> u64 {
        5
    }
    fn set_autocomplete_max_visible(&self, _max_visible: u64) -> anyhow::Result<()> {
        Ok(())
    }
    fn quiet_startup(&self) -> bool {
        false
    }
    fn set_quiet_startup(&self, _quiet: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn idle_eviction_minutes(&self) -> String {
        "90".to_string()
    }
    fn set_idle_eviction_minutes(&self, _value: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn mermaid_rendering_mode(&self) -> String {
        "streaming".to_string()
    }
    fn set_mermaid_rendering_mode(&self, _mode: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn tree_filter_mode(&self) -> String {
        "user-only".to_string()
    }
    fn set_tree_filter_mode(&self, _mode: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn factory_enabled(&self) -> bool {
        false
    }
    fn set_factory_enabled(&self, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn chat_detail(&self) -> String {
        "overview".to_string()
    }
    fn set_chat_detail(&self, _detail: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn warnings_anthropic_extra_usage(&self) -> bool {
        true
    }
    fn set_warnings_anthropic_extra_usage(&self, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn update_channel(&self) -> Option<String> {
        None
    }
    fn set_update_channel(&self, _channel: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn effective_update_channel(&self, _version: &str) -> String {
        "stable".to_string()
    }
    fn telemetry_status(&self) -> String {
        String::new()
    }
    fn set_telemetry_enabled(&self, _enabled: bool) -> anyhow::Result<String> {
        Ok(String::new())
    }
}

/// One mock supervisor: `create` + `attach` answer the startup, every `prompt` runs one
/// paced streamed turn (its start must land in its own event batch), and everything else
/// answers promptly.
struct MockSupervisor {
    listener: std::os::unix::net::UnixListener,
    turns: Arc<AtomicUsize>,
}

impl MockSupervisor {
    fn bind(socket: &Path, turns: Arc<AtomicUsize>) -> Self {
        MockSupervisor {
            listener: std::os::unix::net::UnixListener::bind(socket).expect("bind mock socket"),
            turns,
        }
    }

    fn serve(self) {
        for stream in self.listener.incoming() {
            match stream {
                Ok(stream) => Self::serve_connection(stream, &self.turns),
                Err(_) => return,
            }
        }
    }

    fn serve_connection(stream: std::os::unix::net::UnixStream, turns: &Arc<AtomicUsize>) {
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
                "prompt" => {
                    write_json(&mut writer, &success_response(id, "prompt"));
                    let question = command
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let answer = format!("{} answer", ordinal(turns));
                    write_session_event(&mut writer, &json!({ "type": "turn_start" }));
                    // The start must settle into its own event batch before the turn ends,
                    // or the run loop's per-iteration settle detection never sees an active
                    // turn turn quiet.
                    std::thread::sleep(TURN_PACING);
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
                                "assistantMessageEvent": { "type": "start" },
                            },
                        }),
                    );
                    write_session_event(
                        &mut writer,
                        &json!({
                            "type": "message_update",
                            "message": {
                                "role": "assistant",
                                "content": [{ "type": "text", "text": answer }],
                            },
                            "assistantMessageEvent": { "type": "text_delta", "delta": answer },
                        }),
                    );
                    write_session_event(
                        &mut writer,
                        &json!({
                            "type": "message_end",
                            "message": {
                                "role": "assistant",
                                "stopReason": "stop",
                                "content": [{ "type": "text", "text": answer }],
                            },
                        }),
                    );
                    write_session_event(&mut writer, &json!({ "type": "turn_end" }));
                }
                _ => {
                    write_json(&mut writer, &success_response(id, &command_type));
                }
            }
        }
    }
}

/// The Nth turn's answer: `first`, `second`, ...
fn ordinal(turns: &Arc<AtomicUsize>) -> String {
    match turns.fetch_add(1, Ordering::SeqCst) {
        0 => "first".to_string(),
        1 => "second".to_string(),
        n => format!("{}th", n + 1),
    }
}

fn write_json(writer: &mut std::os::unix::net::UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

fn success_response(id: &str, command: &str) -> Value {
    json!({
        "type": "response",
        "id": id,
        "command": command,
        "success": true,
        "data": {},
    })
}

/// One streamed session event, routed like the daemon's event pump routes it (the
/// `session_event` envelope keyed by the active session).
fn write_session_event(writer: &mut std::os::unix::net::UnixStream, event: &Value) {
    write_json(
        writer,
        &json!({
            "type": "session_event",
            "activeSessionId": "s1",
            "event": event,
        }),
    );
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
                    "sessionName": "scrollback flush e2e",
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

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
