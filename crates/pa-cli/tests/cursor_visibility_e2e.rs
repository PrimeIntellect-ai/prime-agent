//! Real-pty byte-stream e2e for the TUI's hardware-cursor control (the
//! operator's "purple cursor teleporting/glitching around the TUI"
//! report): the product's terminal renderer runs on a pty in a child
//! process group, and the harness audits the raw escape stream across the
//! glitch's repro sequences — startup mount, editor typing (IME caret
//! positioning), picker open/close, and the ctrl+z suspend/SIGCONT resume.
//!
//! The TS contract (tui.ts): the hardware cursor is positioned at the
//! focused caret for IME on every frame, but only *shown* when
//! `showHardwareCursor` is on (default off). `TUI.start` hides it, every
//! fullscreen render ends `showCursor`-only-if-enabled, and the stop
//! paths show it exactly when the shell gets the terminal back. So with
//! the default setting, the whole session's stream may carry exactly one
//! `?25h` — the suspend release tail handing the plain terminal to the
//! shell — and every `?25l` hide that follows a show must precede the
//! next repaint. A visible cursor anywhere else is the glitch: frame
//! paints walk the cursor across changed rows while it is shown.
//!
//! The harness reuses the suspend e2e's structure (child in its own
//! process group inside this runner's session, mock supervisor socket,
//! non-blocking pty master): the byte-level waits serialize through a
//! static lock like the other pty harnesses.

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

/// The SGR tracking sequences the seam writes (the exact byte order of
/// `mouse_tracking`: enable is `?1002h` then `?1006h`).
const MOUSE_ENABLE: &str = "\x1b[?1002h\x1b[?1006h";

/// The hardware-cursor visibility bytes (`crossterm::cursor::Show`/`Hide`).
const CURSOR_SHOW: &str = "\x1b[?25h";
const CURSOR_HIDE: &str = "\x1b[?25l";

/// The child-mode socket: set (with the socket path) only when this very
/// binary is re-executed as the product-under-test.
const CHILD_SOCKET_ENV: &str = "PA_CURSOR_CHILD_SOCKET";

/// The child half of the e2e: runs the real interactive loop in terminal
/// mode against the parent's mock supervisor. A plain `cargo test` run
/// (no `CHILD_SOCKET_ENV`) passes trivially — only the parent test drives
/// the real path.
#[test]
fn cursor_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    // A current-thread runtime keeps the child's thread count down across
    // the group stop/continue cycle (the suspend e2e's observation).
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _ = runtime.block_on(run_interactive(options, UiMode::Terminal));
}

/// The pty harnesses serialize: each drives process-group signals and a
/// raw pty; concurrent byte-level waits flake on the shared sandbox CPUs.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Whether this runner is attached to a controlling-terminal session (the
/// real-signal stop/continue cycle needs one).
fn sigtstp_session_runner() -> bool {
    // SAFETY: tcgetpgrp only queries the fd's foreground process group.
    let foreground = unsafe { libc::tcgetpgrp(0) };
    if foreground < 0 {
        eprintln!(
            "no controlling-terminal session on the runner (tcgetpgrp(fd 0) \
             failed); skipping the cursor visibility e2e — it needs a \
             controlling-terminal session to drive the suspend cycle"
        );
        return false;
    }
    true
}

#[test]
fn cursor_stays_hidden_and_positioned_across_mount_picker_and_suspend() {
    if !sigtstp_session_runner() {
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
    let mut harness = CursorHarness::start();

    // Startup: the fullscreen surface enables SGR mouse tracking before
    // any input is handled — the deterministic startup marker (the mount
    // and the attach snapshot's transcript rows settled before the
    // harness handed control back).
    harness.wait_from_start(MOUSE_ENABLE, "startup mouse enable");

    // Typing: the editor draws the typed cells and the hidden hardware
    // cursor parks right after them for IME — row 22 (the prompt dock
    // line of the fixed 24-row frame), column 7 ("hi" after the "> "
    // prompt). The position write itself is the proof the caret is still
    // tracked while the cursor stays invisible.
    let mark_typed = harness.mark();
    harness.write(b"hi");
    harness.wait_from(
        mark_typed,
        "\x1b[22;7H",
        "the editor positions the hidden cursor at the caret",
    );

    // The picker: clear the editor first (the typed `hi` still sits in
    // it — submitting `hi/model` would go to the daemon as a prompt, not
    // the slash command), then `/model` opens the model picker (an empty
    // catalog renders the empty panel, so the mount is deterministic) and
    // Escape closes it. Both overlays own the frame without a hardware
    // cursor.
    let mark_clear = harness.mark();
    harness.write(b"\x7f\x7f");
    harness.wait_from(
        mark_clear,
        "\x1b[22;5H",
        "the editor emptied back to the bare caret",
    );
    let mark_picker = harness.mark();
    harness.write(b"/model\r");
    harness.wait_from(mark_picker, "Search models", "the model picker mounts");
    harness.write(&[0x1b]);
    // The frame-end hide followed by the hidden caret write is the
    // editor-owns-the-frame marker: picker-open frames end at the bare
    // hide (no caret position exists to write), so no picker cell paint
    // can false-match this pair. The zone-marker writes may trail the
    // caret MoveTo before the sync release, so the needle stops at the
    // pair.
    harness.wait_from(
        mark_picker,
        "\x1b[?25l\x1b[22;5H",
        "the closed picker returns the caret to the empty editor",
    );
    // Let the escape settle before the next key: a byte written hot on
    // the escape's heels reads as one alt-modified key (ESC then ctrl+z
    // would become Alt+ctrl+z), and the suspend cycle would never arm.
    harness.drain_until_quiet(6);

    // Ctrl+Z: the app.suspend cycle hands the plain terminal to the
    // shell — the one place the stream shows the cursor (TS `TUI.stop`'s
    // non-preserved branch: the shell prompt needs a visible cursor).
    let mark_suspend = harness.mark();
    harness.write(&[0x1a]);
    harness.wait_from(
        mark_suspend,
        CURSOR_SHOW,
        "the suspend release tail shows the cursor for the shell",
    );
    wait_for_stopped(
        harness.child_id(),
        "the app.suspend cycle stopped the group",
    );

    // SIGCONT (`fg`): the resume hides the cursor again (TS `ui.start()`
    // on SIGCONT) BEFORE the repaint — a shown cursor at the release
    // tail's stale position through the clear + full repaint is the exact
    // glitch window.
    harness.drain_until_quiet(8);
    let mark_resume = harness.mark();
    kill(Pid::from_raw(harness.child_id() as i32), Signal::SIGCONT).expect("SIGCONT");
    harness.wait_from(
        mark_resume,
        CURSOR_HIDE,
        "the resume hides the cursor before the repaint",
    );
    harness.wait_from(
        mark_resume,
        "\x1b[1;33Hsuspend",
        "the SIGCONT resume repaints the terminal",
    );

    // Let the resumed app settle, then audit the whole byte stream.
    harness.drain_until_quiet(8);
    let collected = harness.output();
    let stream: &[u8] = &collected;

    // Exactly one cursor-show byte window in the whole session: the
    // suspend release tail. A mount, a frame, a picker, or a resume that
    // shows the cursor is the glitch.
    let shows = count_occurrences(stream, CURSOR_SHOW.as_bytes());
    assert_eq!(
        shows, 1,
        "the default-setting session shows the hardware cursor exactly \
         once (the suspend release tail for the shell)"
    );

    // The show is followed by a hide on resume before the repaint: the
    // visibility sequences stay balanced across the handoff.
    let show_at = find_subsequence(stream, CURSOR_SHOW.as_bytes())
        .expect("the suspend show is in the stream");
    let post_show = &stream[show_at..];
    let hide_at = find_subsequence(post_show, CURSOR_HIDE.as_bytes())
        .expect("the resume hide follows the suspend show");
    let repaint_at = find_subsequence(post_show, b"\x1b[1;33Hsuspend")
        .expect("the resume repaint follows the suspend show");
    assert!(
        hide_at < repaint_at,
        "the resume must hide the cursor before the repaint (hide at \
         {hide_at}, repaint at {repaint_at})"
    );

    // No show rides the hidden caret positioning: every caret MoveTo in
    // the stream is a bare position write, never ratatui's unconditional
    // show+position pair (the shape the port must not emit).
    for caret in [b"\x1b[22;5H".as_slice(), b"\x1b[22;7H".as_slice()] {
        let mut offset = 0;
        while let Some(at) = find_subsequence(&stream[offset..], caret) {
            let start = offset + at;
            let prefixed = start >= CURSOR_SHOW.len()
                && &stream[start - CURSOR_SHOW.len()..start] == CURSOR_SHOW.as_bytes();
            assert!(
                !prefixed,
                "a cursor-show byte directly precedes the caret position \
                 write at byte {start} — the hidden position write must be bare"
            );
            offset = start + caret.len();
        }
    }

    // The mount hides the cursor with the surface (TS `TUI.start`): the
    // startup window carries a hide before the first frame's paint.
    let mount_hide = find_subsequence(stream, CURSOR_HIDE.as_bytes())
        .expect("the session hides the hardware cursor");
    assert!(
        mount_hide < harness.startup_end,
        "the mount hide lands inside the startup window"
    );

    harness.finish();
}

/// One pty-backed product child plus the mock supervisor it attaches to.
struct CursorHarness {
    child: Child,
    /// The mock-supervisor server thread's join handle (it exits with the
    /// child's connection).
    _server: std::thread::JoinHandle<()>,
    master: PtyReader,
    /// The byte index where the startup window (through the attach
    /// marker) ended.
    startup_end: usize,
}

impl CursorHarness {
    fn start() -> CursorHarness {
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
        let mut harness = CursorHarness {
            child,
            _server: server,
            master: PtyReader::new(pty.master),
            startup_end: 0,
        };
        // The startup window ends where the attach marker landed: the
        // waits below measure every later window from it.
        harness.wait_from_start("row 0", "the attach snapshot rendered");
        harness.startup_end = harness.mark();
        harness
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

    fn mark(&self) -> usize {
        self.output.len()
    }

    fn write(&mut self, payload: &[u8]) {
        self.file.write_all(payload).expect("write to the pty");
    }

    /// Drain the master until it goes quiet for `quiet_polls` consecutive
    /// polls: a settle window keeps every later byte (the pty driver
    /// drops writes that find its kernel-side buffer full).
    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        let mut quiet = 0;
        while quiet < quiet_polls {
            let mut buffer = [0u8; 8192];
            match self.file.read(&mut buffer) {
                // EOF and a transient read error both count as a quiet
                // poll (the merged arms are the lint-swept form).
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
        .arg("cursor_child_mode")
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

/// One attached session behind a mock supervisor socket (the same frame
/// contract the suspend e2e harness serves).
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
        let (stream, _) = match self.listener.accept() {
            Ok(accept) => accept,
            Err(_) => return,
        };
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
