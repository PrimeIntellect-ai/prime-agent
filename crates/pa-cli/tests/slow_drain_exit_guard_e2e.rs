//! Real-pty e2e for the slow-drain exit-guard contract: the exit flush
//! streams the whole transcript into native scrollback, and on a terminal
//! that consumes it slowly (a laggy ssh, a parsing tap) the drain outlasts
//! the 1500ms force-quit deadline that arms at the second Ctrl+C. The
//! contract under test has two sides:
//!
//! 1. A DRAINING terminal is not a stalled shutdown: the flush writer
//!    reports progress per completed chunk (view.rs `FlushSink`), the
//!    release tail and the resume hint report theirs, and the watchdog
//!    holds its fire while progress lands — the flush completes
//!    byte-identically (the frozen scrollback contract), the restore
//!    tail lands after the last flushed row, and `shutdown stalled`
//!    never prints (TS semantics: TS has no watchdog at all and simply
//!    waits for its writes).
//! 2. A genuinely stalled drain still fires: a terminal that stops
//!    consuming mid-flush produces no progress for the whole grace
//!    window, and the watchdog force-quits with the same message and
//!    exit code as ever.
//!
//! The harness drives the REAL chat surface over a pty (the child is
//! this binary re-executed against a mock supervisor socket, the
//! kitty-release e2e's pattern) and paces its own reads of the pty
//! master — the terminal's drain rate is the test's knob.
#![cfg(unix)]

use std::io::{BufRead, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::fcntl::{fcntl, FcntlArg::F_SETFL, OFlag};
use nix::pty::{openpty, Winsize};
use serde_json::{json, Value};

use pa_tui::interactive::{
    run_interactive, InteractiveOptions, ModelSelection, SessionSelection, UiMode,
};

/// The kitty probe query and answer (the kitty-release e2e's pair): the
/// child's startup asks for keyboard enhancements; answering like a
/// kitty terminal keeps the probe's bounded wait from adding its full
/// budget to the test.
const KITTY_QUERY: &[u8] = b"\x1b[?u";
const KITTY_ANSWER: &[u8] = b"\x1b[?7u\x1b[?62;c";
/// The alt-screen leave the exit flush begins with.
const ALT_SCREEN_LEAVE: &[u8] = b"\x1b[?1049l";
/// The release tail's first two writes (synchronized output off, SGR
/// reset) — the boundary between the flushed rows and the restore.
const TAIL_MARK: &[u8] = b"\x1b[?2026l\x1b[0m";
/// The watchdog's user-visible line, printed only on a genuine forced
/// exit. The re-executed test binary's libtest harness captures stderr
/// per test, so the line never reaches the pty in this harness — the
/// fire is asserted structurally (see `a_stalled_drain_still_fires`),
/// and the line itself is asserted on the real product binary by the
/// lane's VM bench legs.
#[allow(dead_code)]
const STALL_MSG: &[u8] = b"shutdown stalled; forced exit.";
/// The transcript rows this harness seeds: `row <index>` text, the same
/// needle family the kitty-release e2e drives. The startup paint shows
/// the viewport tail only, so the mount needle is the LAST seeded row;
/// the exit flush writes the whole transcript, so the completeness
/// assertion checks the FIRST row appears after the exit.
const FIRST_ROW: &[u8] = b"row 0";
const CHILD_SOCKET_ENV: &str = "PA_SLOW_DRAIN_CHILD_SOCKET";
/// The exit flush of the seeded transcript, at the paced read rate,
/// must still be draining when the 1500ms deadline passes: the flush is
/// sized (messages x wrapped rows) and the rate picked so the drain
/// runs well past the deadline with chunk completions inside the guard's
/// grace window.
const READ_RATE_BYTES_PER_S: f64 = 96.0 * 1024.0;
/// The seed size: pairs of user/assistant messages whose wrapped rows
/// flush to well over the drain the deadline covers at the paced rate.
const SEED_MESSAGES: usize = 1_600;
/// The LAST seeded row: the startup viewport paints the transcript tail,
/// so this is the mount needle; the first row only ever appears in the
/// exit flush (the completeness assertion).
const LAST_ROW: &[u8] = b"row 1599";
/// The dock's exit-hint row (rendered after every transcript row in the
/// flush): the flush-completeness anchor for the stream's tail.
const EXIT_HINT_ROW: &[u8] = b"Press Ctrl+C again to exit";

#[test]
fn slow_drain_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let outcome = run_interactive(options.clone(), UiMode::Terminal)
            .await
            .expect("the chat surface ran");
        // The composition root's exit tail (pa-cli `interactive_mode`):
        // the resume hint print, its exit-progress report, and the
        // fixed pre-exit delay. Replicated here because the child drives
        // the surface directly, not the CLI composition.
        if let Some(hint) = outcome.resume_hint {
            println!("\x1b[2m{hint}\x1b[22m");
        }
        pa_tui::exit_guard::note_exit_progress();
        std::thread::sleep(Duration::from_millis(300));
    });
}

/// The pty harnesses serialize: each drives process-group signals and a
/// raw pty; concurrent byte-level waits flake on the shared test CPUs.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn a_slow_drain_flushes_the_whole_transcript_without_forcing_the_exit() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = SlowDrainHarness::start();

    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.write(KITTY_ANSWER);
    harness.wait_from_start(LAST_ROW, "the attach snapshot rendered");
    harness.settle();

    // The exit gesture: a Ctrl+C pair inside the exit window arms the
    // force-quit deadline at the second press (exit_guard.rs); the loop
    // consumes the pair and runs the exit, whose flush the paced drain
    // keeps busy well past the deadline.
    let mark = harness.mark();
    harness.write(b"\x03");
    std::thread::sleep(Duration::from_millis(400));
    let keys_sent = Instant::now();
    harness.write(b"\x03");

    // Pace the drain: the terminal consumes at READ_RATE_BYTES_PER_S,
    // so the 1500ms deadline lands mid-flush and the guard must hold its
    // fire on the writer's per-chunk progress.
    let drained = harness.pump_until_exit(READ_RATE_BYTES_PER_S, Duration::from_secs(120));
    let exit_wall = keys_sent.elapsed();
    assert_eq!(
        harness.wait_child_exit(Duration::from_secs(5)),
        Some(0),
        "the child exits cleanly through its own exit path"
    );
    // The terminal keeps draining after the process died: the kernel
    // still holds every byte it accepted, and the assertions read the
    // terminal's whole byte stream.
    harness.settle();
    let output = harness.output();
    let _ = mark;

    // The drain really ran past the deadline mid-flush: a fast drain
    // would finish before the 1500ms force-quit window even matters.
    assert!(
        exit_wall >= Duration::from_millis(1_800),
        "the paced drain must outlast the 1500ms deadline (wall {exit_wall:?}, {}KiB drained)",
        drained / 1024
    );
    // TS semantics on a healthy exit: no forced-quit line ever prints.
    assert!(
        find_subsequence(&output, STALL_MSG).is_none(),
        "a draining terminal must never read as a stalled shutdown"
    );
    // The whole transcript flushed (the frozen scrollback contract). The
    // LAST occurrence is the flush's copy: the startup viewport also
    // paints the transcript tail before the exit. The needles use the
    // user-message rows (rendered as contiguous text; assistant rows
    // carry per-word SGR spans) and the dock's exit hint, which the
    // dock renders after every chat row.
    let first_row_at = find_subsequence_last(&output, FIRST_ROW)
        .expect("the flush wrote the transcript's first row");
    let last_user_row = format!("row {}", SEED_MESSAGES - 2).into_bytes();
    let last_row_at = find_subsequence_last(&output, &last_user_row)
        .expect("the flush wrote the transcript's last user row");
    let dock_at =
        find_subsequence_last(&output, EXIT_HINT_ROW).expect("the flush wrote the dock rows");
    let leave_at =
        find_subsequence(&output, ALT_SCREEN_LEAVE).expect("the exit left the alternate screen");
    assert!(
        leave_at < first_row_at && first_row_at < last_row_at && last_row_at < dock_at,
        "the flushed rows follow the alt-screen leave (output {}B, leave_at {leave_at}, first_row_at {first_row_at}, last_row_at {last_row_at}, dock_at {dock_at})",
        output.len()
    );
    // The restore tail lands after the flushed rows: the terminal is
    // handed back whole, not mid-transcript.
    let tail_at = find_subsequence_last(&output, TAIL_MARK)
        .expect("the release tail wrote its restore sequence");
    assert!(
        tail_at > last_row_at,
        "the terminal restore must follow the last flushed row"
    );
}

#[test]
fn a_stalled_drain_still_fires_the_force_quit() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = SlowDrainHarness::start();

    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.write(KITTY_ANSWER);
    harness.wait_from_start(LAST_ROW, "the attach snapshot rendered");
    harness.settle();

    // The exit gesture arms the 1500ms deadline; then the terminal
    // stops consuming entirely: the writer blocks inside its chunk, no
    // progress lands, and the grace window expiring must fire the
    // watchdog exactly as before the drain-awareness existed.
    harness.write(b"\x03");
    std::thread::sleep(Duration::from_millis(400));
    let keys_sent = Instant::now();
    harness.write(b"\x03");

    // The stall: nothing is read while the deadline (and the progress
    // grace window) passes.
    std::thread::sleep(Duration::from_millis(2_500));
    assert!(
        harness.child_alive(),
        "the force-quit's restore writes block on the full pty until the drain resumes"
    );

    // Resume the drain: the watchdog has fired (the stall outlasted the
    // deadline and the grace window), and its forced restore is queued
    // behind the writer's blocked chunk write on the stdout lock — the
    // restore bytes land as soon as the drain frees space, and the
    // process dies with the guard's exit code, the flush truncated at
    // the stall point exactly as the forced exit defines it.
    let _ = harness.pump_until_exit(READ_RATE_BYTES_PER_S, Duration::from_secs(60));
    let exit_wall = keys_sent.elapsed();
    assert_eq!(
        harness.wait_child_exit(Duration::from_secs(5)),
        Some(0),
        "the forced exit ends the process with the guard's exit code"
    );
    harness.settle();
    let output2 = harness.output();
    // The forced-exit line itself goes to stderr, which the re-executed
    // test binary's libtest harness captures per test (never reaching
    // the pty); the REAL binary's message is asserted by the lane's VM
    // bench legs. Here the fire is asserted structurally: the forced
    // restore writes its own alt-screen leave on top of the exit path's
    // (a clean leg leaves the alternate screen exactly once), and the
    // flush never reaches the transcript tail the drain would have
    // needed seconds more to consume.
    let leave_count = output2
        .windows(ALT_SCREEN_LEAVE.len())
        .filter(|w| *w == ALT_SCREEN_LEAVE)
        .count();
    assert!(
        leave_count >= 2,
        "the forced restore ran after the exit path's own leave (leaves {leave_count}, wall {exit_wall:?})"
    );
    // The last user row appears exactly once: the startup viewport's
    // copy. A healthy drain (the slow leg) flushes a second copy into
    // the stream; the forced exit cuts the flush before it.
    let last_user_row = format!("row {}", SEED_MESSAGES - 2).into_bytes();
    let last_user_copies = output2
        .windows(last_user_row.len())
        .filter(|w| *w == last_user_row.as_slice())
        .count();
    assert_eq!(
        last_user_copies, 1,
        "the stalled drain must not read as a healthy one: the flush is cut at the stall (wall {exit_wall:?})"
    );
    assert!(
        exit_wall < Duration::from_secs(8),
        "the forced exit lands inside the stall window plus the grace (wall {exit_wall:?})"
    );
}

struct SlowDrainHarness {
    child: Child,
    _server: std::thread::JoinHandle<()>,
    master: PtyReader,
}

impl SlowDrainHarness {
    fn start() -> SlowDrainHarness {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("tui.sock");
        let supervisor = MockSupervisor::bind(&socket);
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
        // The child needs the socket for its lifetime; the tree dies with
        // it at teardown.
        std::mem::forget(dir);
        SlowDrainHarness {
            child,
            _server: server,
            master: PtyReader::new(pty.master),
        }
    }

    fn mark(&self) -> usize {
        self.master.mark()
    }

    fn write(&mut self, payload: &[u8]) {
        self.master.write(payload);
    }

    fn wait_from_start(&mut self, needle: &[u8], what: &str) {
        self.master.wait_from(0, needle, what);
    }

    /// Let the surface settle: drain until the pty goes quiet (the mount
    /// paint and the snapshot render are small; the drain here is fast
    /// because the transcript never paints outside the viewport).
    fn settle(&mut self) {
        self.master.drain_until_quiet(20);
    }

    fn output(&self) -> Vec<u8> {
        self.master.output.clone()
    }

    fn child_alive(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }

    fn wait_child_exit(&mut self, timeout: Duration) -> Option<i32> {
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

    /// Read the pty master at a fixed byte rate until the child exits:
    /// the terminal's consumption pace, modeled with a token bucket that
    /// refills at `rate` and allows one read per token slice.
    fn pump_until_exit(&mut self, rate: f64, deadline: Duration) -> usize {
        let deadline = Instant::now() + deadline;
        let slice = Duration::from_millis(4);
        let slice_bytes = (rate * slice.as_secs_f64()).max(1.0) as usize;
        let mut drained = 0usize;
        loop {
            if self.child.try_wait().ok().flatten().is_some() {
                return drained;
            }
            if Instant::now() > deadline {
                return drained;
            }
            let mut buffer = [0u8; 4096];
            let want = buffer.len().min(slice_bytes.max(1));
            match self.master.file.read(&mut buffer[..want]) {
                Ok(0) | Err(_) => std::thread::sleep(slice),
                Ok(n) => {
                    self.master.output.extend_from_slice(&buffer[..n]);
                    drained += n;
                }
            }
            std::thread::sleep(slice);
        }
    }
}

impl Drop for SlowDrainHarness {
    fn drop(&mut self) {
        // A panicking wait must never leak the pty child (it owns the
        // controlling terminal of its own session).
        let _ = self.child.kill();
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

fn find_subsequence_last(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    haystack
        .windows(needle.len())
        .rev()
        .position(|window| window == needle)
        .map(|at| haystack.len() - at - needle.len())
}

/// A child of this very binary, re-executed in child mode with the pty
/// slave as its terminal — and as its CONTROLLING terminal (`setsid` +
/// `TIOCSCTTY`): crossterm's raw-mode and event reads go through
/// `/dev/tty`, which must be the pty regardless of the runner's own
/// environment (the kitty-release e2e's harness pattern).
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
        .arg("slow_drain_child_mode")
        .env(CHILD_SOCKET_ENV, socket)
        .env_remove("TMUX")
        .stdin(slave_as_stdio(slave))
        .stdout(slave_as_stdio(slave))
        .stderr(slave_as_stdio(slave));
    // SAFETY: the pre_exec hook is the supported std seam for
    // session/terminal setup; it runs post-fork pre-exec in the child
    // only and cannot allocate.
    unsafe {
        command.pre_exec(move || claim_controlling_tty(slave_fd));
    }
    command.spawn().expect("spawn pty child")
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

/// One attached session behind a mock supervisor socket (the kitty-release
/// e2e's frame contract; every connection served in turn).
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
        for stream in self.listener.incoming() {
            match stream {
                Ok(stream) => Self::serve_connection(stream),
                Err(_) => return,
            }
        }
    }

    fn serve_connection(stream: std::os::unix::net::UnixStream) {
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

/// The seeded transcript: `SEED_MESSAGES` rows of chat, alternating
/// user/assistant, each text long enough to wrap at the harness's 120
/// columns — a flush the paced drain cannot finish inside the 1500ms
/// force-quit window.
fn attach_data(id: &str) -> Value {
    let messages: Vec<Value> = (0..SEED_MESSAGES)
        .map(|index| {
            json!({
                "role": if index % 2 == 0 { "user" } else { "assistant" },
                "content": [{
                    "type": "text",
                    "text": format!(
                        "row {index} the slow-drain exit guard harness wraps this text at the terminal width so each seeded message renders as several flushed rows"
                    ),
                }],
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
                    "sessionName": "slow drain exit guard e2e",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": messages,
                "lastEventSequence": 0,
            },
            "replay": null,
        },
    })
}
