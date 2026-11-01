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

//! Scratch repro for the user-reported scrollback-flush follow bug: with the
//! settle flush on, a streamed turn that grows past one screen must keep the
//! visible frame pinned to the streaming tail, and the turn's settle flush
//! must paint the tail after the final delta. Running the test with
//! `PRIME_AGENT_TUI_EXIT_FLUSH=0` in the environment turns the feature off in
//! the child and swaps the flush-region waits for quiet drains (the control
//! leg: the streaming-follow contract alone).

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
const CHILD_SOCKET_ENV: &str = "PA_SCROLLBACK_FOLLOW_CHILD_SOCKET";
/// The wait bound for one settle flush: the mock turn streams well inside it.
const FLUSH_WAIT: Duration = Duration::from_secs(20);
/// The pause between the turn's start and its streamed content: the settle detection
/// snapshots `turn_active` per iteration, so the start must land in its own batch.
const TURN_PACING: Duration = Duration::from_millis(300);
/// The pause between streamed deltas: the TUI paints a frame between them.
const DELTA_PACING: Duration = Duration::from_millis(250);
/// The streaming watch's poll interval.
const POLL: Duration = Duration::from_millis(150);
/// The overall bound for the turn-two streaming watch.
const STREAM_WINDOW: Duration = Duration::from_secs(60);
/// The bound for the tail marker to paint once the final delta was sent.
const TAIL_WINDOW: Duration = Duration::from_secs(5);
const MARKERS_PER_TURN: usize = 120;
const DELTAS_PER_TURN: usize = 10;
const LINES_PER_DELTA: usize = MARKERS_PER_TURN / DELTAS_PER_TURN;

/// The mock's streaming progress, packed `turn * 1000 + deltas`: a stale turn-one read
/// can never read as turn-two progress.
struct FollowProgress(AtomicUsize);

impl FollowProgress {
    fn new() -> Self {
        Self(AtomicUsize::new(0))
    }

    fn store(&self, turn: usize, deltas: usize) {
        self.0.store(turn * 1000 + deltas, Ordering::SeqCst);
    }

    fn load(&self) -> (usize, usize) {
        let packed = self.0.load(Ordering::SeqCst);
        (packed / 1000, packed % 1000)
    }
}

/// One streaming-watch sample: what the mock had sent, and what the pty had painted.
struct Sample {
    at_ms: u128,
    turn: usize,
    deltas: usize,
    len: usize,
    grew: bool,
    highest: usize,
}

/// The child half: runs the real interactive loop against the parent's mock supervisor; a
/// plain `cargo test` run passes trivially.
#[test]
fn scrollback_follow_child_mode() {
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
fn the_streaming_frame_follows_the_tail_across_a_long_turn() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let turns = Arc::new(AtomicUsize::new(0));
    let progress = Arc::new(FollowProgress::new());
    let mut harness = ScrollbackHarness::start(Arc::clone(&turns), Arc::clone(&progress));

    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.write(KITTY_ANSWER);
    harness.wait_from_start(
        b"Collapsed mode (Ctrl+O to expand)",
        "the session frame mounted",
    );
    harness.settle();

    // Turn one settles first: the first-settle flush definitely ran before turn two
    // starts streaming (the exact precondition of the user report).
    let mark = harness.output().len();
    harness.submit("question one");
    let (start, end) = harness.wait_settle_flush(mark, &[b"question one", b"FOLLOW A 120"]);
    let region = &harness.output()[start..end];
    assert!(
        find_subsequence(region, b"FOLLOW A 001").is_some(),
        "the turn-one flush carried only part of the transcript:\n{}",
        String::from_utf8_lossy(region)
    );

    // Turn two streams the marker ladder while the test samples the pty after every
    // delta batch: whether new bytes keep arriving, and which markers the frames painted.
    let mark_two = harness.output().len();
    let mut prev_len = harness.output().len();
    harness.submit("question two");
    let started = Instant::now();
    let mut samples: Vec<Sample> = Vec::new();
    let mut final_mark = 0;
    let mut final_sent: Option<Instant> = None;
    let mut highest;
    loop {
        std::thread::sleep(POLL);
        harness.drain();
        let output = harness.output();
        let len = output.len();
        let grew = len > prev_len;
        prev_len = len;
        highest = highest_marker(&output[mark_two..], b"FOLLOW B");
        let (turn, deltas) = progress.load();
        if turn >= 2 && deltas >= DELTAS_PER_TURN && final_sent.is_none() {
            final_mark = len;
            final_sent = Some(Instant::now());
        }
        samples.push(Sample {
            at_ms: started.elapsed().as_millis(),
            turn,
            deltas,
            len,
            grew,
            highest,
        });
        if final_sent.is_some()
            && (highest == MARKERS_PER_TURN || final_sent.unwrap().elapsed() > TAIL_WINDOW)
        {
            break;
        }
        if started.elapsed() > STREAM_WINDOW {
            break;
        }
    }
    let mut report = sample_report(&samples, &harness.output());
    assert!(
        highest == MARKERS_PER_TURN,
        "the streaming frame stopped following the tail (highest painted marker {highest});\n{report}"
    );

    // The turn-two settle flush: its region must exist and carry the turn's rows.
    let (start, end) = harness.wait_settle_flush(mark_two, &[b"question two", b"FOLLOW B 120"]);
    let output = harness.output();
    let region = &output[start..end];
    assert!(
        find_subsequence(region, b"FOLLOW B 001").is_some(),
        "the turn-two flush region lost the turn's head rows:\n{}",
        String::from_utf8_lossy(region)
    );
    // Quiet: the post-flush repaint of the live frame has fully landed.
    harness.settle();
    let output = harness.output();
    report = sample_report(&samples, &output);

    // The tail must have been painted AFTER the final delta was sent: the settle flush
    // re-paints the turn's tail into scrollback, so its last occurrence sits past the
    // output length observed when the final delta landed on the socket.
    let tail_at = rfind_subsequence(&output, b"FOLLOW B 120")
        .unwrap_or_else(|| panic!("the tail never reached the pty;\n{report}"));
    assert!(
        tail_at > final_mark,
        "the tail was never painted after the final delta (tail at {tail_at}, final-delta mark {final_mark});\n{report}"
    );

    // The visible frame after the flush shows the turn-two tail: replay the repaint
    // that follows the flush's clear into a screen grid and read what the user sees.
    let screen = replay_screen(&output);
    assert!(
        screen.contains("FOLLOW B 120"),
        "the visible frame does not show the turn-two tail; final screen:\n{screen}\n{report}"
    );
    assert!(
        !screen.contains("FOLLOW A 120"),
        "the visible frame shows the turn-one tail instead: the viewport froze at the last settle flush's position; final screen:\n{screen}\n{report}"
    );
    println!("streaming follow held through the settle flush; {report}");
}

/// One attached session behind a mock supervisor socket: `create` + `attach` answer the
/// startup, and each `prompt` runs one paced streamed turn built from marker lines.
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

    fn start(turns: Arc<AtomicUsize>, progress: Arc<FollowProgress>) -> ScrollbackHarness {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("tui.sock");
        let supervisor = MockSupervisor::bind(&socket, turns, progress);
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

        let child = spawn_child(&socket, &pty.slave);
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

    /// Wait for the settled turn's scrollback flush: the alt-screen leave, the region
    /// carrying every needle, and the alt-screen re-enter, all after `mark`. Returns the
    /// flushed region's offsets in the collected output.
    fn wait_settle_flush(&mut self, mark: usize, needles: &[&[u8]]) -> (usize, usize) {
        let deadline = Instant::now() + FLUSH_WAIT;
        loop {
            self.drain();
            if let Some((start, end)) = find_flush_region(&self.output(), mark, needles) {
                return (start, end);
            }
            if Instant::now() > deadline {
                let output = self.output();
                let text = String::from_utf8_lossy(&output[mark..]);
                panic!("no settle-flush region with the turn's rows after {mark}; pty tail since mark:\n{text}");
            }
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
fn spawn_child(socket: &Path, slave: &OwnedFd) -> Child {
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
        .arg("scrollback_follow_child_mode")
        .arg("--nocapture")
        .env(CHILD_SOCKET_ENV, socket)
        .env_remove("TMUX")
        .stdin(slave_as_stdio(slave))
        .stdout(slave_as_stdio(slave))
        .stderr(slave_as_stdio(slave));
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
    progress: Arc<FollowProgress>,
}

impl MockSupervisor {
    fn bind(socket: &Path, turns: Arc<AtomicUsize>, progress: Arc<FollowProgress>) -> Self {
        MockSupervisor {
            listener: std::os::unix::net::UnixListener::bind(socket).expect("bind mock socket"),
            turns,
            progress,
        }
    }

    fn serve(self) {
        for stream in self.listener.incoming() {
            match stream {
                Ok(stream) => Self::serve_connection(stream, &self.turns, &self.progress),
                Err(_) => return,
            }
        }
    }

    fn serve_connection(
        stream: std::os::unix::net::UnixStream,
        turns: &Arc<AtomicUsize>,
        progress: &Arc<FollowProgress>,
    ) {
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
                    let turn = turns.fetch_add(1, Ordering::SeqCst) + 1;
                    let tag = if turn == 1 { "A" } else { "B" };
                    let question = command
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    progress.store(turn, 0);
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
                    for delta in 0..DELTAS_PER_TURN {
                        if delta > 0 {
                            std::thread::sleep(DELTA_PACING);
                        }
                        let first = delta * LINES_PER_DELTA + 1;
                        let last = (delta + 1) * LINES_PER_DELTA;
                        write_session_event(
                            &mut writer,
                            &json!({
                                "type": "message_update",
                                "message": {
                                    "role": "assistant",
                                    "content": [{ "type": "text", "text": marker_lines(tag, last) }],
                                },
                                "assistantMessageEvent": {
                                    "type": "text_delta",
                                    "delta": marker_lines_from(tag, first, last),
                                },
                            }),
                        );
                        progress.store(turn, delta + 1);
                    }
                    write_session_event(
                        &mut writer,
                        &json!({
                            "type": "message_end",
                            "message": {
                                "role": "assistant",
                                "stopReason": "stop",
                                "content": [{ "type": "text", "text": marker_lines(tag, MARKERS_PER_TURN) }],
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

/// The marker rows of one turn: `FOLLOW <tag> NNN`, one per line, `1..=up_to`.
fn marker_lines(tag: &str, up_to: usize) -> String {
    marker_lines_from(tag, 1, up_to)
}

fn marker_lines_from(tag: &str, first: usize, last: usize) -> String {
    (first..=last)
        .map(|n| format!("FOLLOW {tag} {n:03}"))
        .collect::<Vec<String>>()
        .join("\n")
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
                    "sessionName": "scrollback follow repro",
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

fn rfind_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len())
        .rev()
        .find(|&at| &haystack[at..at + needle.len()] == needle)
}

/// The first alt-screen leave/enter pair after `mark` whose region carries every needle.
/// Returns the offsets of the whole region, enter inclusive: the bytes after `end` are the
/// re-entered live frame's repaint.
fn find_flush_region(output: &[u8], mark: usize, needles: &[&[u8]]) -> Option<(usize, usize)> {
    let mut search = mark;
    while let Some(leave_at) = find_subsequence(&output[search..], ALT_SCREEN_LEAVE) {
        let region_start = search + leave_at;
        let after_leave = region_start + ALT_SCREEN_LEAVE.len();
        let enter_at = find_subsequence(&output[after_leave..], ALT_SCREEN_ENTER)?;
        let enter_end = after_leave + enter_at + ALT_SCREEN_ENTER.len();
        let region = &output[region_start..enter_end];
        if needles
            .iter()
            .all(|needle| find_subsequence(region, needle).is_some())
        {
            return Some((region_start, enter_end));
        }
        search = after_leave;
    }
    None
}

/// The highest `FOLLOW <tag> NNN` marker the frames have painted into the pty so far: the
/// streaming frame follows the tail exactly when this advances with the mock's deltas.
fn highest_marker(output: &[u8], tag: &[u8]) -> usize {
    let mut prefix = tag.to_vec();
    prefix.push(b' ');
    let mut high = 0;
    let mut search = 0;
    while let Some(at) = find_subsequence(&output[search..], &prefix) {
        let at = search + at;
        let rest = &output[at + prefix.len()..];
        if rest.len() >= 3 && rest[..3].iter().all(u8::is_ascii_digit) {
            let digits = &rest[..3];
            let n = ((digits[0] - b'0') as usize * 100)
                + ((digits[1] - b'0') as usize * 10)
                + (digits[2] - b'0') as usize;
            high = high.max(n);
        }
        search = at + prefix.len();
    }
    high
}

/// Each marker's first byte offset: when a given row first reached the pty.
fn marker_first_offsets(output: &[u8], tag: &[u8]) -> Vec<(usize, usize)> {
    let mut prefix = tag.to_vec();
    prefix.push(b' ');
    let mut first: std::collections::BTreeMap<usize, usize> = std::collections::BTreeMap::new();
    let mut search = 0;
    while let Some(at) = find_subsequence(&output[search..], &prefix) {
        let at = search + at;
        let rest = &output[at + prefix.len()..];
        if rest.len() >= 3 && rest[..3].iter().all(u8::is_ascii_digit) {
            let digits = &rest[..3];
            let n = ((digits[0] - b'0') as usize * 100)
                + ((digits[1] - b'0') as usize * 10)
                + (digits[2] - b'0') as usize;
            first.entry(n).or_insert(at);
        }
        search = at + prefix.len();
    }
    first.into_iter().collect()
}

/// The screen grid the pty bytes paint: cursor moves and clears applied, escape sequences
/// skipped. Replayed from the last screen clear, so the result is exactly what the child's
/// final repaint leaves on the 40x120 pane (cell-level diffs of the live frames resolve
/// into full rows).
fn replay_screen(bytes: &[u8]) -> String {
    const ROWS: usize = 40;
    const COLS: usize = 120;
    let from = rfind_subsequence(bytes, b"\x1b[2J").map_or(0, |at| at + b"\x1b[2J".len());
    let mut grid = vec![vec![b' '; COLS]; ROWS];
    let mut row = 0;
    let mut col = 0;
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            0x1b => match bytes.get(i + 1) {
                Some(b'[') => {
                    let params_start = i + 2;
                    let mut j = params_start;
                    while j < bytes.len() && !(0x40..=0x7e).contains(&bytes[j]) {
                        j += 1;
                    }
                    let Some(final_byte) = bytes.get(j) else {
                        break;
                    };
                    let params = std::str::from_utf8(&bytes[params_start..j]).unwrap_or("");
                    match final_byte {
                        b'H' => {
                            let mut parts = params.split(';');
                            let target_row = parts.next().and_then(|p| p.parse::<usize>().ok());
                            let target_col = parts.next().and_then(|p| p.parse::<usize>().ok());
                            row = target_row.unwrap_or(1).saturating_sub(1).min(ROWS - 1);
                            col = target_col.unwrap_or(1).saturating_sub(1).min(COLS - 1);
                        }
                        b'J' if params == "2" => {
                            grid = vec![vec![b' '; COLS]; ROWS];
                        }
                        _ => {}
                    }
                    i = j + 1;
                }
                Some(b']') => {
                    let mut j = i + 2;
                    while j < bytes.len() && bytes[j] != 0x07 {
                        if bytes[j] == 0x1b && bytes.get(j + 1) == Some(&b'\\') {
                            break;
                        }
                        j += 1;
                    }
                    i = if bytes.get(j) == Some(&0x07) {
                        j + 1
                    } else {
                        j + 2
                    };
                }
                _ => i += 2,
            },
            b'\r' => {
                col = 0;
                i += 1;
            }
            b'\n' => {
                if row + 1 < ROWS {
                    row += 1;
                }
                i += 1;
            }
            0x20..=0x7e => {
                grid[row][col] = bytes[i];
                if col + 1 < COLS {
                    col += 1;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    grid.iter()
        .map(|row| String::from_utf8_lossy(row).trim_end().to_string())
        .collect::<Vec<String>>()
        .join("\n")
}

fn count_subsequence(haystack: &[u8], needle: &[u8]) -> usize {
    let mut count = 0;
    let mut search = 0;
    while let Some(at) = find_subsequence(&haystack[search..], needle) {
        count += 1;
        search += at + needle.len();
    }
    count
}

/// The failure diagnostics: the streaming-watch samples, every marker's first offset, and
/// whether the flush region ever appeared.
fn sample_report(samples: &[Sample], output: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut text = String::from(
        "\nstreaming samples (t, turn, deltas sent, pty bytes, new bytes, highest marker):\n",
    );
    for sample in samples {
        let _ = writeln!(
            text,
            "  t={:>5}ms turn={} deltas={:>2} len={:>8} grew={:?} highest={}",
            sample.at_ms, sample.turn, sample.deltas, sample.len, sample.grew, sample.highest
        );
    }
    for (tag, label) in [(b"FOLLOW A".as_slice(), "A"), (b"FOLLOW B".as_slice(), "B")] {
        let offsets = marker_first_offsets(output, tag);
        let _ = writeln!(
            text,
            "first occurrence offsets, FOLLOW {label} ({} of {} seen):",
            offsets.len(),
            MARKERS_PER_TURN
        );
        let shown: Vec<String> = offsets
            .iter()
            .map(|(n, at)| format!("{n:03}@{at}"))
            .collect();
        let _ = writeln!(text, "  {}", shown.join(" "));
    }
    let _ = writeln!(
        text,
        "alt-screen leaves: {}, enters: {}",
        count_subsequence(output, ALT_SCREEN_LEAVE),
        count_subsequence(output, ALT_SCREEN_ENTER)
    );
    text
}
