//! Real-pty e2e for the kitty-probe window's early-typing contract: on a
//! silent (never-answering) terminal the probe holds the process-global
//! event-reader lock for its answer window, and keys typed inside the
//! window park until the probe settles. The vendored crossterm patch
//! (`read_supports_keyboard_enhancement_raw`) holds that window in short
//! poll slices, so the app reader interleaves and early typing delivers
//! while the probe listens. This e2e is the differential oracle with
//! served-path assertions on every class:
//! - the probe's query bytes must appear on the wire (the probe path was
//!   taken — an env-hint short-circuit would make the timing vacuous),
//! - the early key must RENDER inside the window (the delivery path was
//!   taken — a key that never renders proves nothing), and
//! - the answered classes must keep their contracts (the kitty answer
//!   upgrades with the flags push; a DA1-only answer settles no-kitty
//!   with NO flags push — the early-exit path).
//!
//! The once-per-process contract is asserted on the whole byte stream
//! (exactly one query per child process). The exit classes (the standdown,
//! the pop ordering, the release filtering) are covered by the exit-routes
//! and release-handoff e2es and are deliberately not duplicated here.
//! The pre-slice base delivers in-window keys at the ~250ms settle
//! (VM jzcnfbdb4mjtig1e5atyaeur, b5bf28f1d: a key at query+10/50/120/200ms
//! renders at 241.8/201.6/131.8/51.8ms p50 — the settle-coupled signature)
//! so the 150ms bound is the red/green line, not a flake: a regression to
//! the single-hold window fails it on every trial.
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

/// The probe's capability query (the flags query, the leading half of the
/// flags+DA1 pair the check writes).
const KITTY_QUERY: &[u8] = b"\x1b[?u";
/// The flags push when the probe answers true (the served-path proof of
/// the upgrade class).
const KITTY_FLAGS_PUSH: &[u8] = b"\x1b[>7u";
/// A DA1-only answer (a non-kitty terminal that answers device attributes).
const DA1_ANSWER: &[u8] = b"\x1b[?62;c";
/// A kitty answer: flags reply then DA1 (both — a harness answering only the
/// flags query wedges crossterm's DA1 flush read; see the release-handoff
/// e2e's notes).
const KITTY_ANSWER: &[u8] = b"\x1b[?7u\x1b[?62;c";
/// The early key: `Q` appears nowhere in the harness chrome (the session
/// name below is Q-free), so the painted cell is an unambiguous render
/// proof.
const EARLY_KEY: &[u8] = b"Q";
/// The differential bound: the sliced window delivers in ~3-15ms (measured
/// p50 3.2-4.5ms); the single-hold window delivers at the ~250ms settle
/// (a key sent at +30ms renders at ~222ms). CI load headroom keeps the
/// green side an order of magnitude below the red side.
const EARLY_KEY_BOUND: Duration = Duration::from_millis(150);
/// The child-mode socket: set (with the socket path) only when this very
/// binary is re-executed as the product-under-test.
const CHILD_SOCKET_ENV: &str = "PA_EARLY_TYPING_CHILD_SOCKET";

/// The child half of the e2e: runs the real chat surface in terminal mode
/// against the harness's mock supervisor. A plain `cargo test` run (no
/// `CHILD_SOCKET_ENV`) passes trivially — only the parent test drives the
/// real path.
#[test]
fn early_typing_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    // A current-thread runtime keeps the child's thread count down (the
    // suspend e2e's observation).
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let _ = run_interactive(options.clone(), UiMode::Terminal)
            .await
            .expect("the chat surface ran");
    });
}

/// The pty harnesses serialize: each drives process-group signals and a
/// raw pty; concurrent byte-level waits flake on the shared sandbox CPUs.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn early_typing_inside_the_probe_window_renders_before_the_settle() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = EarlyTypingHarness::start();

    // Served-path assertion #1: the probe ran. A terminal classified by the
    // env hints (kitty/ghostty/wezterm/dumb) skips the query, and the timing
    // below would be vacuously fast.
    let t_query = harness
        .chunk_time_of(KITTY_QUERY)
        .expect("the kitty capability query is on the wire");
    harness.assert_query_count(1);

    // The in-window key: 30ms after the query bytes, the single-hold window
    // still parks it (the settle is 250ms out); the sliced window delivers
    // it within a slice.
    harness.sleep_until(t_query + Duration::from_millis(30));
    harness.write(EARLY_KEY);
    let latency = harness
        .time_until_painted_since(EARLY_KEY, Duration::from_secs(5))
        .expect("the early key rendered");
    assert!(
        latency < EARLY_KEY_BOUND,
        "the in-window key rendered in {latency:?} (bound {EARLY_KEY_BOUND:?}) — \
         the probe window is holding early typing again"
    );

    // The post-window control: the same key path with no probe in flight —
    // the surface stays interactive and the query count holds at one.
    harness.drain_until_quiet(10);
    let mark = harness.mark();
    harness.write(b"R");
    harness.wait_from(mark, b"R", "the follow-up key renders");
    harness.assert_query_count(1);
    harness.finish();
}

#[test]
fn a_kitty_terminal_upgrades_and_a_da1_terminal_settles_without_flags() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    // The kitty class: the answered probe upgrades (served-path: the flags
    // push is on the wire) and early keys deliver.
    let mut kitty = EarlyTypingHarness::start();
    let t_query = kitty
        .chunk_time_of(KITTY_QUERY)
        .expect("the kitty capability query is on the wire");
    kitty.sleep_until(t_query + Duration::from_millis(20));
    kitty.write(KITTY_ANSWER);
    let mark = kitty.mark();
    kitty.wait_from(mark, KITTY_FLAGS_PUSH, "the kitty flags push");
    // An answered terminal settles at the answer, so a key after it
    // renders immediately on either side of the probe implementation.
    kitty.sleep_until(t_query + Duration::from_millis(80));
    kitty.write(EARLY_KEY);
    let latency = kitty
        .time_until_painted_since(EARLY_KEY, Duration::from_secs(5))
        .expect("the post-answer key rendered");
    assert!(
        latency < EARLY_KEY_BOUND,
        "the post-answer key rendered in {latency:?} — the answered-terminal \
         path regressed"
    );
    kitty.assert_query_count(1);
    kitty.finish();

    // The DA1 class: a non-kitty terminal that answers device attributes
    // proves liveness — the probe settles no-kitty at the answer (the
    // early-exit path) and NEVER pushes the flags. Served-path: the DA1
    // answer is written and the stream is audited for the absent push.
    let mut da1 = EarlyTypingHarness::start();
    let t_query = da1
        .chunk_time_of(KITTY_QUERY)
        .expect("the kitty capability query is on the wire");
    da1.sleep_until(t_query + Duration::from_millis(20));
    da1.write(DA1_ANSWER);
    da1.sleep_until(t_query + Duration::from_millis(500));
    da1.drain_until_quiet(10);
    assert!(
        !contains(&da1.output(), KITTY_FLAGS_PUSH),
        "a DA1-only answer pushed the kitty flags — the early-exit contract \
         broke: the terminal proved itself non-kitty"
    );
    da1.sleep_until(t_query + Duration::from_millis(520));
    da1.write(EARLY_KEY);
    let latency = da1
        .time_until_painted_since(EARLY_KEY, Duration::from_secs(5))
        .expect("the post-DA1 key rendered");
    assert!(
        latency < EARLY_KEY_BOUND,
        "the post-DA1 key rendered in {latency:?}"
    );
    da1.assert_query_count(1);
    da1.finish();
}

/// One pty-backed product child plus the mock supervisor it attaches to,
/// with a chunk-accurate timing ledger over the raw byte stream.
struct EarlyTypingHarness {
    child: Child,
    /// The mock-supervisor server thread's join handle (it exits with the
    /// child's connection).
    _server: std::thread::JoinHandle<()>,
    master: LedgerReader,
}

impl EarlyTypingHarness {
    fn start() -> EarlyTypingHarness {
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
        // socket for the lifetime of the test, and the whole tree dies with
        // the child at teardown.
        std::mem::forget(dir);
        EarlyTypingHarness {
            child,
            _server: server,
            master: LedgerReader::new(pty.master),
        }
    }

    fn mark(&self) -> usize {
        self.master.mark()
    }

    fn write(&mut self, payload: &[u8]) {
        self.master.write(payload);
    }

    fn output(&self) -> Vec<u8> {
        self.master.output.clone()
    }

    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        self.master.drain_until_quiet(quiet_polls);
    }

    fn wait_from(&mut self, mark: usize, needle: &[u8], what: &str) {
        self.master.wait_from(mark, needle, what);
    }

    /// The chunk time of the first occurrence of `needle` in the stream,
    /// waited for (the child's mount takes a moment to reach the probe):
    /// the ledger is chunk-accurate, so the query's own read chunk is the
    /// probe's start signal.
    fn chunk_time_of(&mut self, needle: &[u8]) -> Option<Instant> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            self.master.drain_once();
            if let Some(at) = self.master.time_of(needle) {
                return Some(at);
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// How long after the CURRENT moment the needle next paints (scanned
    /// from a fresh mark): the early key's render latency.
    fn time_until_painted_since(&mut self, needle: &[u8], bound: Duration) -> Option<Duration> {
        // The needle may already be on the wire from the harness chrome;
        // start the scan past everything collected so far.
        let pre = self.master.output.len();
        let start = Instant::now();
        let deadline = start + bound;
        loop {
            self.master.drain_once();
            if find_subsequence(&self.master.output[pre..], needle).is_some() {
                return Some(start.elapsed());
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn sleep_until(&self, target: Instant) {
        loop {
            let now = Instant::now();
            if now >= target {
                return;
            }
            let left = target.saturating_duration_since(now);
            if left > Duration::from_millis(5) {
                let nap = left
                    .checked_sub(Duration::from_millis(4))
                    .unwrap_or(Duration::ZERO);
                std::thread::sleep(nap);
            } else {
                std::hint::spin_loop();
            }
        }
    }

    /// The once-per-process contract: exactly one capability query in the
    /// whole byte stream of this child.
    fn assert_query_count(&mut self, expected: usize) {
        self.master.drain_once();
        let count = find_subsequence_all(&self.master.output, KITTY_QUERY).len();
        assert_eq!(
            count, expected,
            "the capability query count broke the once-per-process contract"
        );
    }

    fn finish(mut self) {
        let _ = self.child.kill();
        // Reap the child so no zombie is left behind.
        let _ = self.child.wait();
    }
}

impl Drop for EarlyTypingHarness {
    fn drop(&mut self) {
        // A panicking wait must never leak the pty child.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Non-blocking reader over the pty master, collecting the raw byte stream
/// with a per-chunk timing ledger.
struct LedgerReader {
    file: std::fs::File,
    output: Vec<u8>,
    /// (chunk arrival, cumulative end offset) — the chunk-accurate timing
    /// ledger, the same shape the bench harness's pty driver uses.
    chunks: Vec<(Instant, usize)>,
}

impl LedgerReader {
    fn new(master: OwnedFd) -> LedgerReader {
        let fd = master.as_raw_fd();
        fcntl(fd, F_SETFL(OFlag::O_NONBLOCK)).expect("pty master non-blocking");
        LedgerReader {
            file: master.into(),
            output: Vec::new(),
            chunks: Vec::new(),
        }
    }

    fn mark(&self) -> usize {
        self.output.len()
    }

    fn write(&mut self, payload: &[u8]) {
        self.file.write_all(payload).expect("write to the pty");
    }

    /// One non-blocking drain pass.
    fn drain_once(&mut self) {
        let mut buffer = [0u8; 8192];
        match self.file.read(&mut buffer) {
            Ok(0) | Err(_) => {}
            Ok(n) => {
                self.output.extend_from_slice(&buffer[..n]);
                let at = Instant::now();
                self.chunks.push((at, self.output.len()));
            }
        }
    }

    /// Drain the master until it goes quiet for `quiet_polls` consecutive
    /// passes (25ms apart).
    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        let mut quiet = 0;
        while quiet < quiet_polls {
            let before = self.output.len();
            self.drain_once();
            if self.output.len() == before {
                quiet += 1;
            } else {
                quiet = 0;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// The ledger time of the first chunk containing `needle`.
    fn time_of(&self, needle: &[u8]) -> Option<Instant> {
        let at = find_subsequence(&self.output, needle)?;
        self.chunks
            .iter()
            .find(|(_, end)| *end > at)
            .map(|(at_chunk, _)| *at_chunk)
    }

    /// Drain until the needle appears since the mark (bounded by a generous
    /// deadline).
    fn wait_from(&mut self, mark: usize, needle: &[u8], what: &str) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if find_subsequence(&self.output[mark..], needle).is_some() {
                return;
            }
            self.drain_once();
            if Instant::now() > deadline {
                let text = String::from_utf8_lossy(&self.output[mark..]);
                panic!("timeout waiting for {what} (needle {needle:?}); pty tail:\n{text}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn spawn_child(socket: &Path, slave: &OwnedFd) -> Child {
    // Runs between fork and exec in the child: become a session leader
    // and claim the pty slave as the controlling terminal.
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
        .arg("early_typing_child_mode")
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

/// One attached session behind a mock supervisor socket (the same frame
/// contract the other pty e2e harnesses serve).
struct MockSupervisor {
    listener: std::os::unix::net::UnixListener,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: std::os::unix::net::UnixListener::bind(socket).expect("bind mock socket"),
        }
    }

    /// One listener, every connection served in turn.
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
                    "sessionName": "kitty early typing",
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

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find_subsequence(haystack, needle).is_some()
}

fn find_subsequence_all(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    let mut found = Vec::new();
    if needle.is_empty() {
        return found;
    }
    let mut at = 0;
    while let Some(offset) = find_subsequence(&haystack[at..], needle) {
        found.push(at + offset);
        at += offset + needle.len();
    }
    found
}
