// large_futures: stack-resident futures on hot paths by design.
// too_many_lines: style gate. Casts: 64-bit targets; narrowing sits at
// bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::too_many_lines
)]

//! The pty harness: the recording mock terminal, the termios differential,
//! the mock supervisor, and the child-mode plumbing (this binary
//! re-executed under the pty as the product under test).

use std::io::{BufRead, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::fcntl::{fcntl, FcntlArg::F_SETFL, OFlag};
use nix::pty::{openpty, Winsize};
use serde_json::{json, Value};

use pa_tui::agents_view::AgentsViewOptions;
use pa_tui::interactive::{InteractiveOptions, ModelSelection, SessionSelection};

use crate::ledger::ModeLedger;
use crate::{
    CHILD_MODE_ENV, CHILD_SOCKET_ENV, CHILD_TERM, KITTY_ANSWER, KITTY_FLAGS_PUSH, KITTY_QUERY,
};

// The pty harness.

/// One pty-backed product child: a mock-supervisor socket, a raw pty, and a
/// pre-spawn termios snapshot.
pub(crate) struct DifferentialHarness {
    pub(crate) child: Child,
    pub(crate) master: PtyReader,
    /// A route may shut it down to refuse later connections.
    listener: Option<std::os::unix::net::UnixListener>,
    _server: Option<std::thread::JoinHandle<()>>,
    /// The mock socket's path (the refusal determinism polls it).
    socket_path: PathBuf,
    /// The pty's termios before the child spawned.
    pub(crate) before: Termios,
}

impl DifferentialHarness {
    /// Spawn a child (this binary re-executed in a child mode) on a fresh
    /// pty against a mock supervisor that answers everything but the stall.
    pub(crate) fn start(spec: &ChildSpec) -> DifferentialHarness {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("tui.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind mock socket");
        let server = std::thread::spawn({
            let listener = listener.try_clone().expect("clone mock listener");
            let stall = spec.stall;
            move || MockSupervisor::serve(&listener, stall)
        });

        let pty = openpty(
            Some(&Winsize {
                ws_row: 24,
                ws_col: 80,
                ws_xpixel: 0,
                ws_ypixel: 0,
            }),
            None,
        )
        .expect("open pty");
        let before = Termios::capture(pty.master.as_raw_fd());
        let child = spawn_child(spec, &socket, &pty.slave);
        // The child needs the socket and the temp dir for its lifetime.
        std::mem::forget(dir);
        DifferentialHarness {
            child,
            master: PtyReader::new(pty.master),
            listener: Some(listener),
            _server: Some(server),
            socket_path: socket,
            before,
        }
    }

    pub(crate) fn mark(&self) -> usize {
        self.master.mark()
    }

    pub(crate) fn write(&mut self, payload: &[u8]) {
        self.master.write(payload);
    }

    /// A write that tolerates the child being gone (the answer can race the process death).
    pub(crate) fn try_write(&mut self, payload: &[u8]) {
        self.master.try_write(payload);
    }

    pub(crate) fn wait_from_start(&mut self, needle: &[u8], what: &str) {
        self.master.wait_from(0, needle, what);
    }

    pub(crate) fn wait_from(&mut self, mark: usize, needle: &[u8], what: &str) {
        self.master.wait_from(mark, needle, what);
    }

    pub(crate) fn drain_until_quiet(&mut self, quiet_polls: usize) {
        self.master.drain_until_quiet(quiet_polls);
    }

    pub(crate) fn output(&self) -> Vec<u8> {
        self.master.output.clone()
    }

    pub(crate) fn wait_child_exit(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().ok().flatten() {
                return status.code();
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Answer the kitty query like a kitty terminal (query, answer, push).
    pub(crate) fn answer_kitty_query(&mut self) {
        self.wait_from_start(KITTY_QUERY, "the kitty capability query");
        self.write(KITTY_ANSWER);
        self.wait_from_start(KITTY_FLAGS_PUSH, "the kitty flags push");
    }

    /// Refuse every later daemon connection (the roster-failure route): the
    /// shutdown fails the pending accept; once no live descriptor remains,
    /// later connects get ECONNREFUSED while served ones stay alive.
    pub(crate) fn refuse_later_connections(&mut self) {
        if let Some(listener) = self.listener.take() {
            // SAFETY: `shutdown` only invalidates the listening socket's
            // accept queue — the harness owns it and serves nothing on it.
            unsafe {
                libc::shutdown(listener.as_raw_fd(), libc::SHUT_RDWR);
            }
            drop(listener);
            let socket = self.socket_path.clone();
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if std::os::unix::net::UnixStream::connect(&socket).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            panic!("the harness could not refuse later connections in time");
        }
    }

    /// The whole-route assertion: the child exited, the ledger is empty,
    /// and the termios equals the pre-spawn snapshot.
    pub(crate) fn assert_terminal_state_restored(&mut self, context: &str) {
        self.drain_until_quiet(10);
        let stream = self.output();
        // Failure triage: keep the recorded tape next to the run.
        std::fs::write(
            std::env::temp_dir().join("terminal-state-differential-stream.bin"),
            &stream,
        )
        .ok();
        let mut ledger = ModeLedger::default();
        ledger.scan(&stream);
        ledger.assert_delta_empty(context);
        let after = Termios::capture(self.master.file.as_raw_fd());
        assert!(
            self.before.delta_is_empty(&after),
            "{context}: the pty's termios changed: before {:?} after {:?}",
            self.before.describe(),
            after.describe()
        );
    }
}

impl Drop for DifferentialHarness {
    fn drop(&mut self) {
        // A panicking wait must never leak the pty child: it owns the
        // controlling terminal of its own session.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The pty harnesses serialize: each drives process-group signals and a
/// raw pty; concurrent byte-level waits flake on the shared sandbox CPUs.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn harness_lock() -> std::sync::MutexGuard<'static, ()> {
    match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Non-blocking reader over the pty master (the mock terminal's tape).
pub(crate) struct PtyReader {
    pub(crate) file: std::fs::File,
    pub(crate) output: Vec<u8>,
}

impl PtyReader {
    pub(crate) fn new(master: OwnedFd) -> PtyReader {
        let fd = master.as_raw_fd();
        fcntl(fd, F_SETFL(OFlag::O_NONBLOCK)).expect("pty master non-blocking");
        PtyReader {
            file: master.into(),
            output: Vec::new(),
        }
    }

    pub(crate) fn mark(&self) -> usize {
        self.output.len()
    }

    pub(crate) fn write(&mut self, payload: &[u8]) {
        self.file.write_all(payload).expect("write to the pty");
    }

    /// A write that tolerates the child being gone: a closed master fails
    /// with EIO — no answer, not a failure.
    pub(crate) fn try_write(&mut self, payload: &[u8]) {
        let _ = self.file.write_all(payload);
        let _ = self.file.flush();
    }

    /// Drain the master until it goes quiet for `quiet_polls` consecutive
    /// polls: a settle window keeps every later byte.
    pub(crate) fn drain_until_quiet(&mut self, quiet_polls: usize) {
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

    /// Drain the master until the needle appears since the given mark.
    pub(crate) fn wait_from(&mut self, mark: usize, needle: &[u8], what: &str) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if find_subsequence(&self.output[mark..], needle).is_some() {
                return;
            }
            let mut buffer = [0u8; 8192];
            match self.file.read(&mut buffer) {
                Ok(0) | Err(_) => {}
                Ok(n) => self.output.extend_from_slice(&buffer[..n]),
            }
            if Instant::now() > deadline {
                let text = String::from_utf8_lossy(&self.output[mark..]);
                panic!(
                    "timeout waiting for {what} (needle {needle:?}); pty tail \
                     since mark:\n{text}"
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

pub(crate) fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// The termios differential.

/// The pty's line-discipline state (raw mode lives here — the escape
/// stream cannot show it). A pty pair shares one termios, so the master
/// reads the slave's discipline.
pub(crate) struct Termios {
    iflag: libc::tcflag_t,
    oflag: libc::tcflag_t,
    cflag: libc::tcflag_t,
    lflag: libc::tcflag_t,
    line: libc::cc_t,
    cc: [libc::cc_t; libc::NCCS],
}

impl Termios {
    pub(crate) fn capture(fd: std::os::fd::RawFd) -> Termios {
        let mut raw: libc::termios = unsafe { std::mem::zeroed() };
        // SAFETY: `tcgetattr` only reads the line discipline into `raw`.
        let rc = unsafe { libc::tcgetattr(fd, std::ptr::from_mut(&mut raw)) };
        assert!(rc == 0, "the harness could not read the pty's termios");
        Termios {
            iflag: raw.c_iflag,
            oflag: raw.c_oflag,
            cflag: raw.c_cflag,
            lflag: raw.c_lflag,
            line: raw.c_line,
            cc: raw.c_cc,
        }
    }

    pub(crate) fn delta_is_empty(&self, other: &Termios) -> bool {
        self.iflag == other.iflag
            && self.oflag == other.oflag
            && self.cflag == other.cflag
            && self.lflag == other.lflag
            && self.line == other.line
            && self.cc == other.cc
    }

    pub(crate) fn describe(&self) -> String {
        format!(
            "iflag={:#x} oflag={:#x} cflag={:#x} lflag={:#x}",
            self.iflag, self.oflag, self.cflag, self.lflag
        )
    }

    /// Whether the line discipline runs software flow control (IXON): the
    /// termios-process e2e needs it; this binary's routes do not (the dead-code allow).
    #[allow(dead_code)]
    pub(crate) fn input_flow_control_on(&self) -> bool {
        self.iflag & libc::IXON != 0
    }
}

// The mock supervisor.

/// One attached session behind a mock supervisor socket: `daemon_hello`, a
/// `create` + `attach` pair with a small transcript, a catch-all, and
/// stalls answered by silence (the force-quit wedge).
pub(crate) struct MockSupervisor;

impl MockSupervisor {
    /// One listener, every connection on its own thread: the accept loop
    /// must never block inside a connection.
    pub(crate) fn serve(
        listener: &std::os::unix::net::UnixListener,
        stall: &'static [&'static str],
    ) {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    std::thread::spawn(move || Self::serve_connection(stream, stall));
                }
                Err(_) => return,
            }
        }
    }

    pub(crate) fn serve_connection(
        stream: std::os::unix::net::UnixStream,
        stall: &'static [&'static str],
    ) {
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = std::io::BufReader::new(stream);
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
            if stall.contains(&command_type.as_str()) {
                // Answered by silence: the caller's bounded request hangs.
                continue;
            }
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

pub(crate) fn write_json(writer: &mut std::os::unix::net::UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The attach snapshot: a small transcript whose last row carries a
/// URL (the OSC 8 hyperlink pairs).
pub(crate) fn attach_data(id: &str) -> Value {
    let messages: Vec<Value> = (0..4)
        .map(|index| {
            let text = if index == 3 {
                "row 3 https://example.com/diff".to_string()
            } else {
                format!("row {index}")
            };
            json!({
                "role": if index % 2 == 0 { "user" } else { "assistant" },
                "content": [{ "type": "text", "text": text }],
            })
        })
        .collect();
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
                    "sessionName": "terminal state differential",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": messages,
                "lastEventSequence": 0,
                "lastEventCursor": null,
            },
            "client": { "id": "mock", "capabilities": [] },
            "lastEventSequence": 0,
            "lastEventCursor": null,
        },
    })
}

// The child modes (this binary re-executed as the product under test).

/// One child route's spawn spec: the surface mode, the commands the mock
/// answers by silence (the wedge), and the extra env the mode reads.
pub(crate) struct ChildSpec {
    mode: &'static str,
    stall: &'static [&'static str],
    env: Vec<(&'static str, String)>,
}

impl ChildSpec {
    pub(crate) fn new(mode: &'static str) -> ChildSpec {
        ChildSpec {
            mode,
            stall: &[],
            env: Vec::new(),
        }
    }

    pub(crate) fn stall(mut self, stall: &'static [&'static str]) -> ChildSpec {
        self.stall = stall;
        self
    }

    pub(crate) fn env(mut self, key: &'static str, value: impl Into<String>) -> ChildSpec {
        self.env.push((key, value.into()));
        self
    }
}

/// A child of this very binary, re-executed with the pty slave as its
/// terminal AND controlling terminal (`setsid` + `TIOCSCTTY`): crossterm's
/// raw-mode and event reads go through `/dev/tty`.
pub(crate) fn spawn_child(spec: &ChildSpec, socket: &Path, slave: &OwnedFd) -> Child {
    // Runs between fork and exec in the child: become a session leader
    // and claim the pty slave as the controlling terminal.
    pub(crate) fn claim_controlling_tty(fd: i32) -> std::io::Result<()> {
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
        .arg(child_mode_test_name(spec.mode))
        .env(CHILD_MODE_ENV, spec.mode)
        .env(CHILD_SOCKET_ENV, socket);
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    command
        .env("TERM", CHILD_TERM)
        .env_remove("TMUX")
        .env_remove("STY")
        .env_remove("ZELLIJ")
        .env_remove("SSH_CONNECTION")
        .env_remove("SSH_TTY")
        .env_remove("KITTY_WINDOW_ID")
        .env_remove("GHOSTTY_RESOURCES_DIR")
        .env_remove("WEZTERM_PANE")
        .env_remove("TERM_PROGRAM")
        .stdin(slave_as_stdio(slave))
        .stdout(slave_as_stdio(slave))
        .stderr(slave_as_stdio(slave));
    // SAFETY: the pre_exec hook is the supported std seam for
    // session/terminal setup; it runs post-fork pre-exec in the child only and cannot allocate.
    unsafe {
        command.pre_exec(move || claim_controlling_tty(slave_fd));
    }
    command.spawn().expect("spawn pty child")
}

pub(crate) fn slave_as_stdio(slave: &OwnedFd) -> Stdio {
    slave.try_clone().expect("clone pty slave").into()
}

pub(crate) fn child_mode_test_name(mode: &str) -> &'static str {
    match mode {
        "chat" => "diff_chat_child_mode",
        "view" => "diff_view_child_mode",
        "selector" => "diff_selector_child_mode",
        "replay" => "diff_replay_child_mode",
        other => panic!("unknown child mode {other}"),
    }
}

/// Silence the child-mode run's own epilogue: libtest's reporter writes SGR
/// colors and `ESC(B` designations on the audited pty, after the product's bytes are done.
pub(crate) fn quiet_child_epilogue() {
    let null = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/null")
        .expect("/dev/null");
    // SAFETY: dup2 only swaps this process's fd 1/2 after the surface
    // work is done; the pty slave behind them stays owned by the harness's master.
    unsafe {
        libc::dup2(null.as_raw_fd(), 1);
        libc::dup2(null.as_raw_fd(), 2);
    }
}

pub(crate) fn child_options(socket: PathBuf) -> InteractiveOptions {
    InteractiveOptions {
        models: None,
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

pub(crate) fn view_options(socket: PathBuf, anchor: Option<String>) -> AgentsViewOptions {
    AgentsViewOptions {
        socket_path: socket,
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: anchor,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    }
}
