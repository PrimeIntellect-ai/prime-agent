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

//! Real-pty e2e for the exit/backfill contract: leaving the run must
//! flush the history already loaded and never wait for an unfinished
//! older-history page — the run's own 30s request timeout must not hold
//! the exit open behind a held `get_messages`.

#![cfg(unix)]

use std::io::{BufRead, Read, Write};
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
/// The alt-screen leave the exit flush begins with.
const ALT_SCREEN_LEAVE: &[u8] = b"\x1b[?1049l";
/// The watchdog's user-visible line; the exit must go through its own path.
const STALL_MSG: &[u8] = b"shutdown stalled; forced exit.";
const CHILD_SOCKET_ENV: &str = "PA_EXIT_BACKFILL_CHILD_SOCKET";
/// The exit bound: far below the held page's 30s client timeout, generous
/// above a clean detach-and-flush exit.
const EXIT_BOUND: Duration = Duration::from_secs(5);
/// The windowed attach's cursor sits this many messages into the history.
const HISTORY_BEFORE: usize = 2_000;
/// The tail the snapshot carries: rows 0 and 8 are user rows (contiguous
/// needles; assistant rows carry SGR spans).
const TAIL_MESSAGES: usize = 9;
const FIRST_ROW: &[u8] = b"tail row 0";
const LAST_ROW: &[u8] = b"tail row 8";

/// The child half: runs the real interactive loop against the parent's
/// mock supervisor; a plain `cargo test` run passes trivially.
#[test]
fn exit_backfill_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let outcome = run_interactive(options, UiMode::Terminal)
            .await
            .expect("the chat surface ran");
        // The composition root's exit tail (pa-cli `interactive_mode`),
        // replicated because the child drives the surface directly.
        if let Some(SessionSelection::Attach(id)) = outcome.selection_request {
            println!("backfill handoff selected {id}");
        }
        if let Some(hint) = outcome.resume_hint {
            println!("\x1b[2m{hint}\x1b[22m");
        }
        pa_tui::exit_guard::note_exit_progress();
        std::thread::sleep(Duration::from_millis(300));
    });
}

/// The pty harnesses serialize: concurrent byte-level waits flake on the shared test CPUs.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn exit_does_not_wait_for_a_pending_backfill_page() {
    leave_with_pending_backfill(b"/exit\r");
}

#[test]
fn resume_does_not_wait_for_a_pending_backfill_page() {
    leave_with_pending_backfill(b"/resume s2\r");
}

/// The top key (shift+alt+up) as an escape sequence.
const TOP_KEY: &[u8] = b"\x1b[1;4A";

/// The top key as the last input: the terminal paints the key inline, so nothing but
/// the loop's own wake starts the head page, and the session start must render.
#[test]
fn the_top_key_loads_the_session_start_as_the_last_input() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let held = Arc::new(AtomicUsize::new(0));
    let served = Arc::new(AtomicUsize::new(0));
    let mut harness = ExitBackfillHarness::start(Arc::clone(&held), Some(Arc::clone(&served)));
    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.write(KITTY_ANSWER);
    harness.wait_from_start(LAST_ROW, "the attach tail rendered");
    harness.settle();
    let mark = harness.output().len();
    harness.write(TOP_KEY);
    harness.master.wait_from(
        mark,
        b"SESSION-START-ROW",
        "the session start after the top key",
    );
}

/// Older pages the window keeps resident above the tail; one more evicts the
/// chunk next to the tail.
const RESIDENT_CHUNKS: usize = 3;
const PAGE_UP: &[u8] = b"\x1b[5~";

/// Scrolled far up, the resident rows are cut off from the tail: the exit flush
/// writes the contiguous tail alone, without the far rows or the gap row, and
/// requests no page on the way out.
#[test]
fn exit_flushes_the_tail_without_a_disjoint_resident_run() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let held = Arc::new(AtomicUsize::new(0));
    let served = Arc::new(AtomicUsize::new(0));
    let mut harness = ExitBackfillHarness::start(Arc::clone(&held), Some(Arc::clone(&served)));
    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.write(KITTY_ANSWER);
    harness.wait_from_start(LAST_ROW, "the attach tail rendered");
    for _ in 0..200 {
        harness.write(PAGE_UP);
        harness.master.drain_until_quiet(1);
        if served.load(Ordering::SeqCst) > RESIDENT_CHUNKS {
            break;
        }
    }
    harness.settle();
    let served_at_exit = served.load(Ordering::SeqCst);
    assert!(
        served_at_exit > RESIDENT_CHUNKS,
        "the climb must load more older pages than stay resident (served {served_at_exit})"
    );
    let held_at_exit = held.load(Ordering::SeqCst);
    let mark = harness.output().len();
    harness.write(b"/exit\r");
    assert_eq!(
        harness.wait_child_exit(EXIT_BOUND),
        Some(0),
        "the exit completes"
    );
    harness.settle();
    let output = harness.output();
    let leave_at = mark
        + find_subsequence(&output[mark..], ALT_SCREEN_LEAVE)
            .expect("the exit left the alternate screen");
    let flushed = &output[leave_at..];
    assert!(
        find_subsequence(flushed, FIRST_ROW).is_some()
            && find_subsequence(flushed, LAST_ROW).is_some(),
        "the flush carries the tail"
    );
    assert!(
        find_subsequence(flushed, b"old row").is_none(),
        "the flush drops the resident rows cut off from the tail:\n{}",
        String::from_utf8_lossy(flushed)
    );
    assert!(
        find_subsequence(flushed, b"Loading newer history").is_none(),
        "the flush drops the gap row"
    );
    assert_eq!(
        (served.load(Ordering::SeqCst), held.load(Ordering::SeqCst)),
        (served_at_exit, held_at_exit),
        "the exit requests no page"
    );
}

fn leave_with_pending_backfill(gesture: &[u8]) {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let held = Arc::new(AtomicUsize::new(0));
    let mut harness = ExitBackfillHarness::start(Arc::clone(&held), None);

    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.write(KITTY_ANSWER);
    harness.wait_from_start(LAST_ROW, "the attach tail rendered");
    harness.settle();

    // The windowed attach really armed an older-history page request, and it
    // is still held: the request is pending exactly where the bug waits.
    let held_at_exit = held.load(Ordering::SeqCst);
    assert!(
        held_at_exit >= 1,
        "the windowed attach must have started an older-history page request before the exit"
    );

    // Both gestures leave through the session-request route: no Ctrl+C
    // pair, so no force-quit watchdog can mask a hang.
    let keys_sent = Instant::now();
    harness.write(gesture);

    let exit_code = harness.wait_child_exit(EXIT_BOUND);
    let exit_wall = keys_sent.elapsed();
    assert_eq!(
        exit_code,
        Some(0),
        "the exit must beat the held page's 30s request timeout (wall {exit_wall:?}, \
         {held_at_exit} page request(s) held)"
    );

    harness.settle();
    let output = harness.output();
    if gesture == b"/resume s2\r" {
        assert!(
            find_subsequence(&output, b"backfill handoff selected s2").is_some(),
            "the run must return the requested session to the composition root"
        );
    }
    assert!(
        find_subsequence(&output, STALL_MSG).is_none(),
        "the exit went through its own path, never the watchdog's"
    );
    // The flush carried the loaded tail rows: their LAST copies follow the
    // alt-screen leave (the startup viewport painted the first copies).
    let leave_at =
        find_subsequence(&output, ALT_SCREEN_LEAVE).expect("the exit left the alternate screen");
    let first_row_at =
        find_subsequence_last(&output, FIRST_ROW).expect("the flush wrote the tail's first row");
    let last_row_at =
        find_subsequence_last(&output, LAST_ROW).expect("the flush wrote the tail's last row");
    assert!(
        leave_at < first_row_at && first_row_at < last_row_at,
        "the flushed tail rows follow the alt-screen leave (output {}B, leave_at {leave_at}, \
         first_row_at {first_row_at}, last_row_at {last_row_at})",
        output.len()
    );
}

/// One attached session behind a mock supervisor socket: the attach is
/// windowed (it carries a page cursor), and the older-history page request
/// is held forever; everything else answers promptly.
struct ExitBackfillHarness {
    child: Child,
    _server: std::thread::JoinHandle<()>,
    master: PtyReader,
}

impl ExitBackfillHarness {
    fn start(held: Arc<AtomicUsize>, history: Option<Arc<AtomicUsize>>) -> ExitBackfillHarness {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("tui.sock");
        let supervisor = MockSupervisor::bind(&socket, held, history);
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
        ExitBackfillHarness {
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

    /// Drain until the pty goes quiet (the transcript never paints outside
    /// the viewport, so this is fast).
    fn settle(&mut self) {
        self.master.drain_until_quiet(20);
    }

    fn output(&self) -> Vec<u8> {
        self.master.output.clone()
    }

    /// Poll for the child's exit while draining the master, bounded by
    /// `timeout`; `None` when the child is still alive at the bound.
    fn wait_child_exit(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().ok().flatten() {
                return status.code();
            }
            let mut buffer = [0u8; 8192];
            match self.master.file.read(&mut buffer) {
                Ok(0) | Err(_) => {}
                Ok(n) => self.master.output.extend_from_slice(&buffer[..n]),
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

impl Drop for ExitBackfillHarness {
    fn drop(&mut self) {
        // A panicking wait must never leak the pty child (it owns its
        // session's controlling terminal).
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

/// A child of this very binary, with the pty slave as its terminal AND
/// controlling terminal (`setsid` + `TIOCSCTTY`): crossterm's raw-mode and
/// event reads go through `/dev/tty`.
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
        .arg("exit_backfill_child_mode")
        // The parent observes the child's handoff result through the PTY.
        .arg("--nocapture")
        .env(CHILD_SOCKET_ENV, socket)
        .env_remove("TMUX")
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
        // A direct open into an existing session: the attach drives the
        // windowed snapshot.
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

/// One attached session behind a mock supervisor socket: the attach carries
/// a windowed snapshot. Without `history`, every page request is held forever;
/// with it, older pages are served and only newer pages are held. Every other
/// request answers promptly.
struct MockSupervisor {
    listener: std::os::unix::net::UnixListener,
    held: Arc<AtomicUsize>,
    history: Option<Arc<AtomicUsize>>,
}

impl MockSupervisor {
    fn bind(socket: &Path, held: Arc<AtomicUsize>, history: Option<Arc<AtomicUsize>>) -> Self {
        MockSupervisor {
            listener: std::os::unix::net::UnixListener::bind(socket).expect("bind mock socket"),
            held,
            history,
        }
    }

    fn serve(self) {
        for stream in self.listener.incoming() {
            match stream {
                Ok(stream) => Self::serve_connection(stream, &self.held, self.history.as_ref()),
                Err(_) => return,
            }
        }
    }

    fn serve_connection(
        stream: std::os::unix::net::UnixStream,
        held: &Arc<AtomicUsize>,
        history: Option<&Arc<AtomicUsize>>,
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
            match command_type.as_str() {
                "attach" => {
                    write_json(&mut writer, &attach_data(id));
                }
                // With history served: an older page or the head page of `old row`s.
                "get_messages"
                    if history.is_some()
                        && (command["page"]["from"] == "end"
                            || command["page"].get("after").is_none()) =>
                {
                    history
                        .expect("history mode")
                        .fetch_add(1, Ordering::SeqCst);
                    write_json(&mut writer, &history_page(id, &command["page"]));
                }
                // A page request: counted and held — the run loop starts it
                // from the windowed attach's cursor, and the exit must not
                // wait for it.
                "get_messages" if command.get("page").is_some() => {
                    held.fetch_add(1, Ordering::SeqCst);
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

/// One page over `HISTORY_BEFORE` messages `old row 0..`, ids `e<index>`: an
/// older page, or the head page.
fn history_page(id: &str, page: &Value) -> Value {
    let cursor = |key: &str| {
        page[key]
            .as_str()
            .and_then(|cursor| cursor[1..].parse::<usize>().ok())
    };
    let limit = page["limit"].as_u64().expect("page limit") as usize;
    let (start, end) = if page["from"] == "end" {
        let end = cursor("before").expect("older page cursor");
        (end.saturating_sub(limit), end)
    } else {
        (0, limit.min(cursor("until").expect("head page bound")))
    };
    let messages: Vec<Value> = (start..end)
        .map(|index| match index {
            // A row the terminal's cell diff must write whole: it shares no cell with an
            // `old row` line.
            0 => json!({ "role": "user", "content": "SESSION-START-ROW" }),
            _ => json!({ "role": "user", "content": format!("old row {index}") }),
        })
        .collect();
    json!({
        "type": "response", "id": id, "command": "get_messages", "success": true,
        "data": {
            "messages": messages,
            "firstEntryId": format!("e{start}"),
            "lastEntryId": format!("e{}", end - 1),
            "more": if page["from"] == "end" { start > 0 } else { end < HISTORY_BEFORE },
            "historyLeafId": "attach-leaf",
        },
    })
}

/// The attach snapshot: a small windowed tail over an unfinished older
/// history (its page cursor).
fn attach_data(id: &str) -> Value {
    let messages: Vec<Value> = (0..TAIL_MESSAGES)
        .map(|index| {
            json!({
                "role": if index % 2 == 0 { "user" } else { "assistant" },
                "content": [{
                    "type": "text",
                    "text": format!(
                        "tail row {index} the held-backfill exit harness wraps this text at the terminal width"
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
                    "leafId": "attach-leaf",
                    "sessionName": "exit backfill e2e",
                    "model": null,
                    "isStreaming": false,
                    "isCompacting": false,
                    "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
                },
                "messages": messages,
                "historyBeforeEntryId": format!("e{HISTORY_BEFORE}"),
                "lastEventSequence": 0,
            },
            "replay": null,
        },
    })
}
