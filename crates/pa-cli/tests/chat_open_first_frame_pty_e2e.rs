//! Real-pty e2e for the chat-open first frame (the operator's
//! 2026-09-26 layout-shift report: the panel and its divider under the
//! prompt bar painted ~1s after the view opened, and the splash
//! butterfly flashed one row under the title before scrolling out on
//! agents-view opens): the product's terminal renderer runs on a pty in
//! a child process group, opening an existing session directly into
//! content over a mock supervisor that delays the dock's data
//! responses — the loaded-daemon repro.
//!
//! The pinned contract: a direct open paints ONE complete frame — the
//! transcript, the pinned title row, and the activity dock together —
//! and never paints the brand splash at any point. A splash-first
//! startup frame (the flash and the one-row shift under the title) or a
//! late dock repaint (the layout shift: the transcript rows repaint two
//! rows up when the panel pops in) both fail the byte audit.
//!
//! The harness reuses the cursor-visibility e2e's structure (child in
//! its own process group inside this runner's session, mock supervisor
//! socket, non-blocking pty master); the byte-level waits serialize
//! through the same static lock.

#![cfg(unix)]

use std::io::{BufRead, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::fcntl::{fcntl, FcntlArg::F_SETFL, OFlag};
use nix::pty::{openpty, Winsize};
use nix::unistd::Pid;
use serde_json::{json, Value};

use pa_tui::interactive::{
    run_interactive, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};

/// The child-mode socket: set (with the socket path) only when this very
/// binary is re-executed as the product-under-test.
const CHILD_SOCKET_ENV: &str = "PA_CHAT_OPEN_CHILD_SOCKET";

/// The loaded-daemon stand-in: the dock's data requests answer this
/// late — far past any honest first frame, and short enough to sit
/// well inside the attach's bounded waits.
const DOCK_DATA_DELAY_MS: u64 = 300;

/// The child half of the e2e: runs the real interactive loop in
/// terminal mode against the parent's mock supervisor. A plain
/// `cargo test` run (no `CHILD_SOCKET_ENV`) passes trivially — only the
/// parent test drives the real path.
#[test]
fn chat_open_first_frame_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _ = runtime.block_on(run_interactive(options, UiMode::Terminal));
}

/// The pty harnesses serialize: each drives a raw pty; concurrent
/// byte-level waits flake on the shared sandbox CPUs.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn chat_open_first_frame_pins_the_first_paint() {
    if !session_runner() {
        return;
    }
    match nix::unistd::setsid() {
        Ok(_) => {}
        Err(error) => panic!("the harness could not start a fresh session: {error}"),
    }
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = ChatOpenHarness::start();

    // The one complete frame: the transcript content, the pinned title
    // row, and the dock's panel row all land. Each wait is an
    // observable-readiness barrier — the mock's delayed responses ride
    // the attach's own round trip, so the waits measure the fold, not a
    // wall-clock window.
    harness.wait_from_start("settled answer", "the transcript painted");
    harness.wait_from_start("layout probe", "the pinned title row painted");
    harness.wait_from_start("\u{25f7} 1 heartbeat", "the dock panel painted");

    // Let the surface settle so the audit covers every repaint the
    // open can produce, then read the whole byte stream.
    harness.drain_until_quiet(10);
    let collected = harness.output();
    let stream: &[u8] = &collected;

    // The brand splash never paints: no splash-first startup frame (the
    // flash), so the butterfly never shifts a row under the title bar.
    assert!(
        find_subsequence(stream, b"prime agent").is_none(),
        "the brand splash never paints for a direct open into content — \
         the whole stream carries the splash bytes"
    );

    // The transcript painted exactly once: a late dock repaint would
    // shift the window two rows up and repaint every transcript row —
    // the operator's layout shift.
    let content_paints = count_occurrences(stream, b"settled answer");
    assert_eq!(
        content_paints, 1,
        "the transcript rows paint exactly once — a second paint is the \
         layout shift of the dock arriving late"
    );

    // The divider rule and the panel row are part of the same first
    // paint: the dock data folded with the attach, never after it.
    assert!(
        find_subsequence(stream, "\u{25f7} 1 heartbeat".as_bytes()).is_some(),
        "the dock's heartbeat panel row painted"
    );

    harness.finish();
}

/// Whether this runner is attached to a controlling-terminal session (the
/// child re-exec needs a session it can leave and re-enter safely).
fn session_runner() -> bool {
    // SAFETY: tcgetpgrp only queries the fd's foreground process group.
    let foreground = unsafe { libc::tcgetpgrp(0) };
    if foreground < 0 {
        eprintln!(
            "no controlling-terminal session on the runner (tcgetpgrp(fd 0) \
             failed); skipping the chat-open first-frame e2e — it needs a \
             controlling-terminal session to drive the pty child"
        );
        return false;
    }
    true
}

/// One pty-backed product child plus the mock supervisor it attaches to.
struct ChatOpenHarness {
    child: Child,
    /// The mock-supervisor server thread's join handle (it exits with the
    /// child's connection).
    _server: std::thread::JoinHandle<()>,
    master: PtyReader,
}

impl ChatOpenHarness {
    fn start() -> ChatOpenHarness {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("tui.sock");
        let supervisor = MockSupervisor::bind(&socket);
        let server = std::thread::spawn(move || supervisor.serve());

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

        let child = spawn_child(&socket, &pty.slave);
        // Leak the temp dir's socket path on purpose: the child needs the
        // socket for the lifetime of the test, and the whole tree dies
        // with the child at teardown.
        std::mem::forget(dir);
        ChatOpenHarness {
            child,
            _server: server,
            master: PtyReader::new(pty.master),
        }
    }

    fn wait_from_start(&mut self, needle: &str, what: &str) {
        self.master.wait_from(0, needle, what);
    }

    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        self.master.drain_until_quiet(quiet_polls);
    }

    fn output(&self) -> Vec<u8> {
        self.master.output.clone()
    }

    fn finish(mut self) {
        let _ = self.child.kill();
        // Reap the child so no zombie is left behind.
        let _ = self.child.wait();
    }
}

/// Non-blocking reader over the pty master, collecting the raw byte
/// stream the child writes.
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

    /// Drain the master until it goes quiet for `quiet_polls` consecutive
    /// polls: a settle window keeps every later byte (the pty driver
    /// drops writes that find its kernel-side buffer full).
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

    /// Drain the master until the needle appears in the output collected
    /// since the given mark, bounded by a generous harness deadline.
    fn wait_from(&mut self, mark: usize, needle: &str, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if find_subsequence(&self.output[mark..], needle.as_bytes()).is_some() {
                return;
            }
            let mut buffer = [0u8; 8192];
            let result = self.file.read(&mut buffer);
            match result {
                Ok(0) | Err(_) => {}
                Ok(n) => self.output.extend_from_slice(&buffer[..n]),
            }
            if Instant::now() > deadline {
                let text = String::from_utf8_lossy(&self.output[mark..]);
                panic!(
                    "timeout waiting for {what} (needle {needle:?}); pty tail since mark:\n{text}"
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn count_occurrences(haystack: &[u8], needle: &[u8]) -> usize {
    let mut count = 0;
    let mut offset = 0;
    while let Some(found) = find_subsequence(&haystack[offset..], needle) {
        count += 1;
        offset += found + needle.len();
    }
    count
}

/// A child process group of this very binary, re-executed in child mode
/// with the pty slave as its terminal and no tmux (the tmux keyboard
/// check must stay out of the way).
fn spawn_child(socket: &std::path::Path, slave: &OwnedFd) -> Child {
    // Runs between fork and exec in the child: setpgid moves it into its
    // own process group, inside the runner's session.
    fn make_process_group() -> std::io::Result<()> {
        nix::unistd::setpgid(Pid::from_raw(0), Pid::from_raw(0))?;
        Ok(())
    }
    let mut command = Command::new(std::env::current_exe().expect("test binary"));
    command
        .arg("--exact")
        .arg("chat_open_first_frame_child_mode")
        .env(CHILD_SOCKET_ENV, socket)
        .env_remove("TMUX")
        .stdin(slave_as_stdio(slave))
        .stdout(slave_as_stdio(slave))
        .stderr(slave_as_stdio(slave));
    // SAFETY: the pre_exec hook is the supported std seam for
    // process-group setup; it runs post-fork pre-exec in the child only
    // and cannot disturb this process.
    unsafe { command.pre_exec(make_process_group) };
    command.spawn().expect("spawn child")
}

fn slave_as_stdio(slave: &OwnedFd) -> Stdio {
    slave.try_clone().expect("clone pty slave").into()
}

fn child_options(socket: PathBuf) -> InteractiveOptions {
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
        // A direct open into an existing session: the agents-view hand
        // path (the operator's repro), not a fresh create.
        session: SessionSelection::Attach("s1".to_string()),
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

/// One attached session behind a mock supervisor socket: the attach
/// snapshot carries a settled exchange, and the dock's data requests
/// answer after the delay (the loaded daemon).
struct MockSupervisor {
    listener: std::os::unix::net::UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: std::os::unix::net::UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    fn serve(self) {
        let Ok((stream, _)) = self.listener.accept() else {
            return;
        };
        let write_stream = stream.try_clone().expect("clone mock socket");
        let mut writer = write_stream;
        let mut reader = std::io::BufReader::new(stream);
        write_json(
            &mut writer,
            &json!({
                "type": "daemon_hello",
                "protocol": { "name": "prime-agent.daemon", "version": 7 },
                "serverCapabilities": ["kernel_bash_activity"],
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
                "attach" => {
                    write_json(&mut writer, &attach_data(id));
                }
                "heartbeats_list" => {
                    std::thread::sleep(Duration::from_millis(DOCK_DATA_DELAY_MS));
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "heartbeats_list",
                            "success": true,
                            "data": {
                                "heartbeats": [
                                    {
                                        "job": {
                                            "id": "hb-1",
                                            "status": "active",
                                            "source": "heartbeat",
                                            "activeSessionId": "s1",
                                            "sessionId": "sess-1",
                                            "schedule": {"kind": "interval", "expression": "every 30m"},
                                        },
                                        "sessionName": "layout probe",
                                    },
                                ],
                            },
                        }),
                    );
                }
                "list_kernel_bash" => {
                    std::thread::sleep(Duration::from_millis(DOCK_DATA_DELAY_MS));
                    write_json(
                        &mut writer,
                        &json!({
                            "type": "response",
                            "id": id,
                            "command": "list_kernel_bash",
                            "success": true,
                            "data": {
                                "activities": [
                                    {
                                        "id": "run-1",
                                        "command": "echo settled",
                                        "status": "finished",
                                        "exitCode": 0,
                                    },
                                ],
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

fn write_json(writer: &mut std::os::unix::net::UnixStream, value: &Value) {
    let mut line = serde_json::to_string(value).expect("serialize mock frame");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

/// The attach result: one live session with a settled exchange — a
/// direct open into content.
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
                    "sessionName": "layout probe",
                    "model": "faux-1",
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": [
                    { "role": "user", "content": "hello", "timestamp": 1 },
                    { "role": "assistant", "content": "settled answer", "provider": "scripted", "model": "faux-1", "timestamp": 2 },
                ],
                "lastEventSequence": 0,
                "lastEventCursor": null,
            },
            "client": { "id": "mock", "capabilities": [] },
            "lastEventSequence": 0,
            "lastEventCursor": null,
        },
    })
}
