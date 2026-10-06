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

//! Real-signal e2e for the `app.suspend` cycle (TS `handleCtrlZ`): the
//! renderer runs on a pty in a child process group, driven like a shell.
//! The TS SIGINT shield window lives in the pa-types disposition-pair
//! unit test: a SIGINT to a stopped process queues until SIGCONT.

#![cfg(unix)]

use std::io::{BufRead, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::fcntl::{fcntl, FcntlArg::F_SETFL, OFlag};
use nix::pty::{openpty, Winsize};
use nix::sys::signal::{kill, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::Pid;
use serde_json::{json, Value};

use pa_tui::interactive::{
    run_interactive, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};

/// Enable is `?1002h`, `?1003h` (the hover affordance), then `?1006h`; disable reverses.
const MOUSE_ENABLE: &str = "\x1b[?1002h\x1b[?1003h\x1b[?1006h";
const MOUSE_DISABLE: &str = "\x1b[?1006l\x1b[?1003l\x1b[?1002l";

/// The kitty capability query. It runs once per process: a resume that
/// writes it again re-arms the 2s support check, blinding input.
const KITTY_QUERY: &str = "\x1b[?u\x1b[c";

/// Set (with the socket path) only when this very binary is re-executed as the product-under-test.
const CHILD_SOCKET_ENV: &str = "PA_SUSPEND_CHILD_SOCKET";

/// The mock's wire traffic in arrival order, for the timeout diagnostics.
static WIRE_LOG: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn log_wire(frame: &str) {
    WIRE_LOG
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(frame.to_string());
}

fn wire_log_dump() -> String {
    WIRE_LOG
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .join("\n")
}

/// The child half: the real interactive loop against the parent's mock supervisor.
#[test]
fn suspend_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    // A current-thread runtime keeps the child at two threads: parked workers of a
    // multithreaded runtime can lose their futex wakeups across a group stop.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _ = runtime.block_on(run_interactive(options, UiMode::Terminal));
}

/// The two pty harnesses serialize: concurrent runs flaked on the shared sandbox.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Whether this runner is attached to a controlling-terminal session (the test skips otherwise).
fn sigtstp_session_runner() -> bool {
    // tcgetpgrp(0) errors for a pipe or /dev/null stdin and a tty with no fg group.
    // SAFETY: tcgetpgrp only queries the fd's foreground process group.
    let foreground = unsafe { libc::tcgetpgrp(0) };
    if foreground < 0 {
        eprintln!(
            "no controlling-terminal session on the runner (tcgetpgrp(fd 0) \
             failed); skipping the tests that need one to drive the \
             stop/continue signal cycle"
        );
        return false;
    }
    true
}

/// Whether the runner had a controlling-terminal session, sampled before the single `setsid`.
fn lead_fresh_session() -> bool {
    static HAD_CTTY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *HAD_CTTY.get_or_init(|| {
        let had = sigtstp_session_runner();
        if let Err(error) = nix::unistd::setsid() {
            panic!("the harness could not start a fresh session: {error}");
        }
        had
    })
}

#[test]
fn ctrl_z_releases_tracking_stops_and_sigcont_re_applies() {
    if !lead_fresh_session() {
        return;
    }
    // The runner leads a fresh session; `spawn_child` owns the process-group contract.
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = SuspendHarness::start(/*editor*/ None);

    harness.wait_from_start(MOUSE_ENABLE, "startup mouse enable");

    harness.wait_from_start(KITTY_QUERY, "the first mount's kitty query");
    // The prompt row is derived from the caret park, never hard-coded.
    harness.wait_from_start(" >  ", "the first frame's prompt row rendered");
    let prompt_row = harness.wait_caret_row_from(0, 5, "the first frame's empty editor rendered");

    // Ctrl+Z: the renderer releases tracking BEFORE the group stops.
    let mark_suspend = harness.mark();
    harness.write(&[0x1a]);
    harness.wait_from(mark_suspend, MOUSE_DISABLE, "suspend mouse release");

    // SIGTSTP (from the app's own kill(0)) stops the process group.
    wait_for_stopped(
        harness.child_id(),
        "the app.suspend cycle stopped the group",
    );

    // Drain the scrollback flush to silence first (see `drain_until_quiet`): the
    // resume's writes must find room in the pty buffer.
    harness.drain_until_quiet(8);
    let mark_resume = harness.mark();
    kill(Pid::from_raw(harness.child_id() as i32), Signal::SIGCONT).expect("SIGCONT");
    // The post-continue repaint is the deterministic marker (the pty drops the first writes).
    harness.wait_from(
        mark_resume,
        "\x1b[1;33Hsuspend",
        "the SIGCONT resume repaints the terminal",
    );

    // Ratatui's diff renderer repaints only changed cells: the typed text shows as the
    // caret's park right after it. The bound is tight: a re-queried kitty starves 2s.
    let mark_typed = harness.mark();
    harness.write(b"hi");
    harness.wait_from_bounded(
        mark_typed,
        &format!("\x1b[{prompt_row};7H"),
        "the resumed editor renders the typed text",
        Duration::from_millis(1500),
    );

    // The regression lock: the once-per-process query must be absent from the whole resume.
    harness.drain_until_quiet(4);
    let resume_region = harness.region_since(mark_resume);
    assert!(
        find_subsequence(&resume_region, KITTY_QUERY.as_bytes()).is_none(),
        "the SIGCONT resume re-queried the kitty protocol; the query is \
         once-per-process and must not run again"
    );

    harness.finish();
}

/// Real-tty e2e for `app.editor.external` (TS `openExternalEditor`): ctrl+g hands the
/// terminal to `$VISUAL`; the resumed surface strips one trailing newline.
#[test]
fn ctrl_g_hands_the_terminal_to_the_external_editor() {
    use std::os::unix::fs::PermissionsExt;

    // The child's raw-mode enable must land on the harness pty alone.
    lead_fresh_session();
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    // The editor stand-in first SIGINTs its own process group, proving the TUI's SIGINT shield.
    let dir = tempfile::TempDir::new().expect("temp dir");
    let editor = dir.path().join("editor.sh");
    std::fs::write(
        &editor,
        "#!/bin/sh\ntrap '' INT\nkill -INT 0\nprintf 'edited externally\n' > \"$1\"\n",
    )
    .expect("write editor script");
    std::fs::set_permissions(&editor, std::fs::Permissions::from_mode(0o755))
        .expect("chmod editor script");
    let mut harness = SuspendHarness::start(Some(&editor));

    harness.wait_from_start(MOUSE_ENABLE, "startup mouse enable");

    // The first content frame is the readiness marker (earlier keystrokes race the kitty probe).
    harness.wait_from_start(" >  ", "the first frame's prompt row rendered");
    let prompt_row = harness.wait_caret_row_from(0, 5, "the first frame's empty editor rendered");

    // Each typed key paints its own cell: the draft's arrival is the caret's park.
    let mark_draft = harness.mark();
    harness.write(b"draft");
    harness.wait_from(
        mark_draft,
        &format!("\x1b[{prompt_row};10H"),
        "the draft rendered in the editor",
    );

    let mark_edit = harness.mark();
    harness.write(&[0x07]);
    harness.wait_from(
        mark_edit,
        "edited externally",
        "the editor child's text replaced the draft",
    );

    // The strip proof: one newline removed, so the caret parks at the end of the
    // edited line (a leftover would park it on the wrapped second line).
    let mark_typed = harness.mark();
    harness.write(b"x");
    harness.wait_from_bounded(
        mark_typed,
        &format!("\x1b[{prompt_row};22H"),
        "the editor parked the caret after the single-line edit",
        Duration::from_secs(10),
    );

    harness.finish();
}

/// One pty-backed product child plus the mock supervisor it attaches to.
struct SuspendHarness {
    child: Child,
    /// The mock-supervisor server thread's join handle (it exits with the child's connection).
    _server: std::thread::JoinHandle<()>,
    master: PtyReader,
}

impl SuspendHarness {
    fn start(editor: Option<&std::path::Path>) -> SuspendHarness {
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

        let child = spawn_child(&socket, &pty.slave, editor);
        // Leak the socket dir on purpose: the child needs it for the test's lifetime.
        std::mem::forget(dir);
        SuspendHarness {
            child,
            _server: server,
            master: PtyReader::new(pty.master),
        }
    }

    fn child_id(&self) -> u32 {
        self.child.id()
    }

    fn mark(&self) -> usize {
        self.master.mark()
    }

    fn write(&mut self, payload: &[u8]) {
        self.master.write(payload);
    }

    fn wait_from_start(&mut self, needle: &str, what: &str) {
        self.master.wait_from(0, needle, what);
    }

    fn wait_from(&mut self, mark: usize, needle: &str, what: &str) {
        self.master.wait_from(mark, needle, what);
    }

    fn wait_from_bounded(&mut self, mark: usize, needle: &str, what: &str, bound: Duration) {
        self.master.wait_from_bounded(mark, needle, what, bound);
    }

    /// Wait until a caret parks at `column` and return its row (DERIVED, not assumed).
    fn wait_caret_row_from(&mut self, mark: usize, column: u16, what: &str) -> String {
        self.master.wait_caret_row_from(mark, column, what)
    }

    fn region_since(&self, mark: usize) -> Vec<u8> {
        self.master.region_since(mark)
    }

    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        self.master.drain_until_quiet(quiet_polls);
    }

    fn finish(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Non-blocking reader over the pty master, collecting the raw byte stream the child writes.
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

    fn mark(&self) -> usize {
        self.output.len()
    }

    /// The bytes collected since the given mark.
    fn region_since(&self, mark: usize) -> Vec<u8> {
        self.output[mark..].to_vec()
    }

    fn write(&mut self, payload: &[u8]) {
        self.file.write_all(payload).expect("write to the pty");
    }

    /// Read until quiet for `quiet_polls` polls: a write into a full kernel buffer is
    /// dropped, so drain to silence before every resume write.
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

    /// Drain until the needle appears since the mark (bounded by a generous deadline).
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
                    "timeout waiting for {what} (needle {needle:?}); wire log:\n{}\npty tail since mark:\n{text}",
                    wire_log_dump()
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// `wait_from` with a caller-chosen bound (the regression's 2s starvation exceeds it).
    fn wait_from_bounded(&mut self, mark: usize, needle: &str, what: &str, bound: Duration) {
        let deadline = Instant::now() + bound;
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
                    "{what} missed the {bound:?} bound (needle {needle:?}); \
                     pty tail since mark:\n{text}"
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Wait (the plain wait's 30s bound) until a caret paints at `column` and return its row.
    fn wait_caret_row_from(&mut self, mark: usize, column: u16, what: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(row) = caret_row_at_column(&self.output[mark..], column) {
                return row;
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
                    "timeout waiting for {what} (a caret at column {column}); \
                     pty tail since mark:\n{text}"
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The row of the LAST caret parked at `column` (startup paints transient carets).
fn caret_row_at_column(stream: &[u8], column: u16) -> Option<String> {
    let suffix = format!(";{column}H").into_bytes();
    let mut from = 0;
    let mut row = None;
    while let Some(at) = find_subsequence(&stream[from..], &suffix) {
        let head = &stream[from..from + at];
        let digits_start = head
            .iter()
            .rposition(|byte| !byte.is_ascii_digit())
            .map_or(0, |last_non_digit| last_non_digit + 1);
        let digits = &head[digits_start..];
        let esc = head[..digits_start].ends_with(b"\x1b[");
        if esc && !digits.is_empty() {
            row = Some(String::from_utf8_lossy(digits).into_owned());
        }
        from += at + suffix.len();
    }
    row
}

/// A child process group of this very binary, re-executed with the pty slave as
/// its terminal (no tmux, no controlling terminal: no SIGTTIN/SIGTTOU). kill(0,
/// SIGTSTP) stops the child, not this runner, and the stop holds.
fn spawn_child(
    socket: &std::path::Path,
    slave: &OwnedFd,
    editor: Option<&std::path::Path>,
) -> Child {
    // Runs between fork and exec in the child: setpgid into its own group.
    fn make_process_group() -> std::io::Result<()> {
        nix::unistd::setpgid(Pid::from_raw(0), Pid::from_raw(0))?;
        Ok(())
    }
    let mut command = Command::new(std::env::current_exe().expect("test binary"));
    command
        .arg("--exact")
        .arg("suspend_child_mode")
        .env(CHILD_SOCKET_ENV, socket)
        .env_remove("TMUX");
    if let Some(editor) = editor {
        command.env("VISUAL", editor);
    }
    command
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

/// Poll the child until SIGTSTP's default disposition stops it.
fn wait_for_stopped(pid: u32, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match waitpid(
            Pid::from_raw(pid as i32),
            Some(WaitPidFlag::WNOHANG | WaitPidFlag::WUNTRACED),
        ) {
            Ok(WaitStatus::Stopped(_, _)) => return,
            Ok(WaitStatus::Exited(..)) => panic!("{what}: the child exited instead"),
            _ if Instant::now() > deadline => panic!("timeout waiting for SIGTSTP: {what}"),
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// One attached session behind a mock supervisor socket (the family's frame contract).
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
        log_wire("[accept] the child connected");
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
            log_wire(&format!("[req] {line}"));
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
    log_wire(&format!("[res] {line}"));
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write mock frame");
    writer.flush().expect("flush mock frame");
}

fn attach_data(id: &str) -> Value {
    let messages: Vec<Value> = (0..4)
        .map(|index| {
            json!({
                "role": if index % 2 == 0 { "user" } else { "assistant" },
                "content": [{ "type": "text", "text": format!("row {index}") }],
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
                    "sessionName": "suspend session",
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
