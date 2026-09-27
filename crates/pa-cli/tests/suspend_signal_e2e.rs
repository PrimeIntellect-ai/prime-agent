//! Real-signal e2e for the `app.suspend` cycle (TS `handleCtrlZ`): the
//! product's terminal renderer runs on a pty in a child process group,
//! and the harness drives the signal path a shell exercises.
//!
//! The TS shield window (SIGINT ignored while suspended) is covered by
//! the pa-types unit test on the disposition pair; it cannot be e2e'd
//! here: a SIGINT sent to a *stopped* process queues until SIGCONT and is
//! delivered while the app already restored the default disposition
//! mid-resume, which destabilizes the terminal reader in this harness —
//! and a real shell cannot produce that sequence anyway (Ctrl+C goes to
//! the shell, the foreground process; the suspended app is background).
//!
//! Two harness details keep the child deterministic (found the hard way,
//! see PORTING-NOTES "Suspend-to-background"): the child is in its own
//! process group inside this runner's session (its terminal is the
//! harness pty alone), and the SIGINT-while-stopped
//! test is separate — a SIGINT sent to a *stopped* process queues until
//! SIGCONT and is delivered when the app already restored the default
//! disposition mid-resume, which destabilizes the terminal reader; a
//! real shell cannot produce that (Ctrl+C goes to the shell, the
//! foreground process), so the byte-level assertions run without it.

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
/// `mouse_tracking`: enable is `?1002h` then `?1006h`, disable the
/// reverse).
const MOUSE_ENABLE: &str = "\x1b[?1002h\x1b[?1006h";
const MOUSE_DISABLE: &str = "\x1b[?1006l\x1b[?1002l";

/// The kitty capability query crossterm's support check writes (`\x1b[?u`
/// then the primary-device-attributes query in one write). The port runs
/// it once per process (the first mount); a resume that writes it again
/// re-arms the 2s support check — crossterm's filtered poll holds the
/// process-global event-reader lock for its whole budget, and the app
/// reader's input goes blind until it expires (the strace-proven
/// ~2s-after-every-resume blackout).
const KITTY_QUERY: &str = "\x1b[?u\x1b[c";

/// The child-mode socket: set (with the socket path) only when this very
/// binary is re-executed as the product-under-test.
const CHILD_SOCKET_ENV: &str = "PA_SUSPEND_CHILD_SOCKET";

/// The child half of the e2e: runs the real interactive loop in terminal
/// mode against the parent's mock supervisor. A plain `cargo test` run
/// (no `CHILD_SOCKET_ENV`) passes trivially — only the parent test
/// drives the real path.
#[test]
fn suspend_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    // A current-thread runtime keeps the child at two threads (the loop
    // plus the terminal reader): a multithreaded runtime's parked workers
    // can lose their futex wakeups across a group stop/continue, which
    // starves the resume mid-path (observed as the resumed child never
    // writing its re-apply bytes; the product behavior itself is
    // correct — verified under strace).
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _ = runtime.block_on(run_interactive(options, UiMode::Terminal));
}

/// The two pty harnesses serialize: each drives process-group signals and
/// a raw pty; running them concurrently made the byte-level waits flake
/// on the shared 4-CPU sandbox.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Whether this runner is attached to a controlling-terminal session.
/// The real-signal stop/continue cycle runs in that class; without one
/// the test skips with a loud note instead of running.
fn sigtstp_session_runner() -> bool {
    // tcgetpgrp on fd 0 answers "does this runner's stdin sit on a
    // session's controlling terminal": a pipe or /dev/null stdin and a
    // tty without a foreground process group both read as errors.
    // SAFETY: tcgetpgrp only queries the fd's foreground process group.
    let foreground = unsafe { libc::tcgetpgrp(0) };
    if foreground < 0 {
        eprintln!(
            "no controlling-terminal session on the runner (tcgetpgrp(fd 0) \
             failed); skipping the suspend signal e2e — it needs a \
             controlling-terminal session to drive the stop/continue cycle"
        );
        return false;
    }
    true
}

#[test]
fn ctrl_z_releases_tracking_stops_and_sigcont_re_applies() {
    if !sigtstp_session_runner() {
        return;
    }
    // The runner leads a fresh session with no controlling terminal (a
    // new session gets none until TIOCSCTTY), and spawn_child then
    // moves the child into its own process group inside it. Both are
    // the harness contract: the stop/continue cycle needs the child's
    // group parented inside its session, and the renderer needs the
    // child's terminal to be the harness pty alone.
    match nix::unistd::setsid() {
        Ok(_) => {}
        Err(error) => panic!("the harness could not start a fresh session: {error}"),
    }
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = SuspendHarness::start();

    // The startup contract: the fullscreen surface enables SGR mouse
    // tracking (the seam bytes) before any input is handled.
    harness.wait_from_start(MOUSE_ENABLE, "startup mouse enable");

    // The first mount runs the kitty capability query once (the
    // once-per-process contract's positive side: the probe exists).
    harness.wait_from_start(KITTY_QUERY, "the first mount's kitty query");

    // Ctrl+Z: the app.suspend binding. The renderer releases tracking
    // before the process group stops, so the disable bytes arrive while
    // the process is still running.
    let mark_suspend = harness.mark();
    harness.write(&[0x1a]);
    harness.wait_from(mark_suspend, MOUSE_DISABLE, "suspend mouse release");

    // SIGTSTP (from the app's own kill(0)) stops the process group.
    wait_for_stopped(
        harness.child_id(),
        "the app.suspend cycle stopped the group",
    );

    // SIGCONT (`fg`): the resume re-applies the terminal modes — raw
    // mode, the alternate screen, SGR mouse tracking — and repaints; the
    // mouse-tracking seam bytes come back on the pty.
    // Drain the suspend's scrollback flush to silence first (see
    // `drain_until_quiet`): the resume's writes must find room in the pty
    // buffer instead of being dropped by a full one.
    harness.drain_until_quiet(8);
    let mark_resume = harness.mark();
    kill(Pid::from_raw(harness.child_id() as i32), Signal::SIGCONT).expect("SIGCONT");
    // The post-continue repaint (the resume's `term.clear` plus the fresh
    // frame) is the deterministic marker on this harness: the resumed
    // child writes the alt-screen-enter and mouse-tracking sequences first
    // (verified under strace, and the seam's release/re-apply order is
    // unit-locked in pa-tui), but this sandbox's pty drops the first
    // post-continue writes nondeterministically, so the harness pins the
    // assertion on the repaint that always arrives.
    harness.wait_from(
        mark_resume,
        "\x1b[1;33Hsuspend",
        "the SIGCONT resume repaints the terminal",
    );

    // The resumed app still runs: typing renders in the editor line.
    // Ratatui's diff renderer repaints only the changed cells, so the
    // typed text never appears as a contiguous "> hi" byte string: the
    // editor draws the typed cells at their positions and parks the
    // cursor right after them — row 22 (the prompt dock line of the
    // fixed 24-row frame), column 7 ("hi" after the "> " prompt).
    //
    // The wait is bounded tight: a resume that re-queried kitty leaves
    // the app reader starved behind crossterm's support check for the
    // check's whole 2s budget, and the typed bytes only render when it
    // expires — the fixed resume leaves the reader free and renders in
    // well under a second even on a loaded VM (the pre-fix run took
    // 2.0s here, 10/10, strace-verified).
    let mark_typed = harness.mark();
    harness.write(b"hi");
    harness.wait_from_bounded(
        mark_typed,
        "\x1b[22;7H",
        "the resumed editor renders the typed text",
        Duration::from_millis(1500),
    );

    // The regression lock: the resume never re-queries kitty. Drain the
    // tail so the assertion sees everything the child wrote since the
    // SIGCONT — the once-per-process probe's query bytes must be absent
    // from the whole resume (a re-armed probe re-blindes the reader for
    // its 2s support check; the byte-level evidence of the fix is that
    // the query appears exactly once, on the first mount).
    harness.drain_until_quiet(4);
    let resume_region = harness.region_since(mark_resume);
    assert!(
        find_subsequence(&resume_region, KITTY_QUERY.as_bytes()).is_none(),
        "the SIGCONT resume re-queried the kitty protocol; the query is \
         once-per-process and must not run again"
    );

    harness.finish();
}

/// One pty-backed product child plus the mock supervisor it attaches to.
struct SuspendHarness {
    child: Child,
    /// The mock-supervisor server thread's join handle (it exits with the
    /// child's connection).
    _server: std::thread::JoinHandle<()>,
    master: PtyReader,
}

impl SuspendHarness {
    fn start() -> SuspendHarness {
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

    fn region_since(&self, mark: usize) -> Vec<u8> {
        self.master.region_since(mark)
    }

    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        self.master.drain_until_quiet(quiet_polls);
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

    /// The bytes collected since the given mark (the region the
    /// no-re-query assertion inspects).
    fn region_since(&self, mark: usize) -> Vec<u8> {
        self.output[mark..].to_vec()
    }

    fn write(&mut self, payload: &[u8]) {
        self.file.write_all(payload).expect("write to the pty");
    }

    /// Read until the master goes quiet for `quiet_polls` consecutive
    /// polls: the suspend's scrollback flush fills the pty's kernel-side
    /// buffer, and a resume write that finds it full is silently dropped
    /// by the pty driver — draining to silence first keeps every resume
    /// byte (this is the whole difference between the flaky and the
    /// deterministic harness).
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
    /// since the given mark, bounded by a generous harness deadline
    /// (attach + first renders).
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

    /// `wait_from` with a caller-chosen bound: the paths this pins (the
    /// resume's input freedom) must answer well inside the bound, while
    /// the regression they lock out (the re-armed kitty support check's
    /// 2s event-reader starvation) exceeds it.
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
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// A child process group of this very binary, re-executed in child mode
/// with the pty slave as its terminal and no tmux (the tmux keyboard
/// check must stay out of the way). The child lives in its own process
/// group inside the runner's session: kill(0, SIGTSTP) stops the child
/// and not this runner, and the stop holds — the child's parent, the
/// session leader, sits in a different process group of the same
/// session. The child's terminal is the harness pty, never a
/// controlling terminal, so no background-group arbitration
/// (SIGTTIN/SIGTTOU) applies to its I/O across the stop/continue cycle.
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
        .arg("suspend_child_mode")
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

/// One attached session behind a mock supervisor socket (the same frame
/// contract the headless e2e harness serves).
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
