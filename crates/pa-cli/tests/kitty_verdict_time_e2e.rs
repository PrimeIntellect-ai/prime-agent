// large_futures: stack futures on hot paths by design. Casts: 64-bit targets;
// narrowing sits at bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::too_many_lines
)]

//! Real-pty e2e for the kitty probe's VERDICT TIME: the probe resolves at the
//! answer on kitty and DA1-answering terminals; only the fully-silent pty
//! class pays the 250ms deadline (a late flags reply never upgrades past the
//! conclusion; a raced suspend stalls behind the mode lock).
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

/// The probe's capability query (the leading half of the flags+DA1 pair).
const KITTY_QUERY: &[u8] = b"\x1b[?u";
/// The flags push when the probe answers true (the upgrade proof).
const KITTY_FLAGS_PUSH: &[u8] = b"\x1b[>7u";
/// A DA1-only answer (a non-kitty terminal that answers device attributes).
const DA1_ANSWER: &[u8] = b"\x1b[?62;c";
/// A kitty answer: flags reply then DA1 (both — answering only the flags
/// query wedges crossterm's DA1 flush read).
const KITTY_ANSWER: &[u8] = b"\x1b[?7u\x1b[?62;c";
/// The suspend keybinding's byte (`app.suspend`, default ctrl+z).
const SUSPEND_KEY: &[u8] = b"\x1a";
/// The suspend teardown's paste-off, written AFTER it takes the mode lock
/// the probe holds — the oracle's needle (the mount enables the `h` form).
const PASTE_DISABLE: &[u8] = b"\x1b[?2004l";
/// The teardown's mouse release, written BEFORE the mode lock wait: pins the
/// suspend route as the writer.
const MOUSE_DISABLE: &[u8] = b"\x1b[?1006l\x1b[?1003l\x1b[?1002l";
/// The liveness key: `Q` appears nowhere in the harness chrome, so the painted cell is unambiguous.
const EARLY_KEY: &[u8] = b"Q";
/// The verdict's red/green line: the raced teardown lands with the dispatch,
/// far under it, on answered classes; the silent class is pinned to the
/// 250ms deadline. A future cut below it must re-justify against the late-kitty catch window.
const VERDICT_BOUND: Duration = Duration::from_millis(200);
/// The silent arm's generous upper bound: deadline plus teardown path, with CI-load headroom.
const SILENT_RESTORE_MAX: Duration = Duration::from_millis(700);
/// Set (with the socket path) only when this very binary is re-executed as the product-under-test.
const CHILD_SOCKET_ENV: &str = "PA_VERDICT_CHILD_SOCKET";
/// The characterization sweep's opt-in (a VM-only instrument; CI never sets it).
const SWEEP_ENV: &str = "PA_KITTY_VERDICT_SWEEP";

/// The child half of the e2e: runs the real chat surface in terminal mode against
/// the mock supervisor (a plain `cargo test` run passes trivially).
#[test]
fn verdict_child_mode() {
    let Ok(socket) = std::env::var(CHILD_SOCKET_ENV) else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    // A current-thread runtime keeps the child's thread count down.
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

/// The pty harnesses serialize: concurrent process-group signals and raw ptys flake on shared CPUs.
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn a_da1_terminal_concludes_before_the_ms60_late_kitty_reply() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = VerdictHarness::start();

    // Served-path #1: the probe ran (an env-hint short-circuit would be vacuously fast).
    let t_query = harness
        .chunk_time_of(KITTY_QUERY)
        .expect("the kitty capability query is on the wire");
    // The DA1-answering class: the answer lands at +15ms.
    VerdictHarness::sleep_until(t_query + Duration::from_millis(15));
    harness.write(DA1_ANSWER);
    // The late kitty reply at +60ms: past the DA1 conclusion, inside the open window.
    VerdictHarness::sleep_until(t_query + Duration::from_millis(60));
    harness.write(KITTY_ANSWER);
    // Let the whole answer window lapse and drain the stream.
    VerdictHarness::sleep_until(t_query + Duration::from_millis(700));
    harness.drain_until_quiet(10);

    // The conclusion at the DA1 CLOSED the window: the +60ms reply never upgrades.
    assert!(
        !contains(&harness.output(), KITTY_FLAGS_PUSH),
        "a DA1-answering terminal upgraded from a +60ms flags reply — the \
         conclusion did not happen at the DA1 answer, so the verdict waits \
         for the window and the ~50ms pole is gone"
    );
    // The parked late reply must stay inert — the surface keeps rendering input
    // (the flags/DA1 events park behind the app reader's filter forever).
    harness.write(EARLY_KEY);
    let latency = harness
        .time_until_painted_since(EARLY_KEY, Duration::from_secs(5))
        .expect("the post-verdict key rendered");
    assert!(
        latency < Duration::from_millis(150),
        "the post-verdict key rendered in {latency:?}"
    );
    harness.assert_query_count(1);
    harness.finish();
}

#[test]
fn a_da1_terminal_concludes_before_the_ms100_late_kitty_reply() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = VerdictHarness::start();
    let t_query = harness
        .chunk_time_of(KITTY_QUERY)
        .expect("the kitty capability query is on the wire");
    VerdictHarness::sleep_until(t_query + Duration::from_millis(15));
    harness.write(DA1_ANSWER);
    VerdictHarness::sleep_until(t_query + Duration::from_millis(100));
    harness.write(KITTY_ANSWER);
    VerdictHarness::sleep_until(t_query + Duration::from_millis(700));
    harness.drain_until_quiet(10);
    // The +100ms reply is load-robust headroom: a load-smeared conclusion still
    // closes the window before +100ms; a broken DA1 path upgrades.
    assert!(
        !contains(&harness.output(), KITTY_FLAGS_PUSH),
        "a DA1-answering terminal upgraded from a +100ms flags reply — the \
         DA1 early conclusion broke"
    );
    harness.assert_query_count(1);
    harness.finish();
}

#[test]
fn the_same_ms100_reply_on_a_silent_pty_still_upgrades() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = VerdictHarness::start();
    let t_query = harness
        .chunk_time_of(KITTY_QUERY)
        .expect("the kitty capability query is on the wire");
    // The fully-silent class up to the reply: nothing answers the query.
    VerdictHarness::sleep_until(t_query + Duration::from_millis(100));
    harness.write(KITTY_ANSWER);
    // The differential control: the SAME reply upgrades here — no verdict has
    // happened yet (also the late-kitty catch contract over a slow hop).
    let mark = harness.mark();
    harness.wait_from(mark, KITTY_FLAGS_PUSH, "the late flags push");
    harness.assert_query_count(1);
    harness.finish();
}

#[test]
fn the_kitty_control_upgrades_at_the_answer() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = VerdictHarness::start();
    let t_query = harness
        .chunk_time_of(KITTY_QUERY)
        .expect("the kitty capability query is on the wire");
    // The kitty control: the flags reply at the answer upgrades.
    VerdictHarness::sleep_until(t_query + Duration::from_millis(15));
    harness.write(KITTY_ANSWER);
    let mark = harness.mark();
    harness.wait_from(mark, KITTY_FLAGS_PUSH, "the answered flags push");
    harness.assert_query_count(1);
    harness.finish();
}

#[test]
fn a_raced_suspend_on_a_da1_terminal_does_not_wait_for_the_deadline() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = VerdictHarness::start();
    let t_query = harness
        .chunk_time_of(KITTY_QUERY)
        .expect("the kitty capability query is on the wire");
    VerdictHarness::sleep_until(t_query + Duration::from_millis(15));
    harness.write(DA1_ANSWER);
    // Race the suspend's teardown at +60ms: the verdict happened at the DA1, so
    // the teardown bytes land with the dispatch, far under the deadline.
    VerdictHarness::sleep_until(t_query + Duration::from_millis(60));
    let mark = harness.mark();
    harness.write(SUSPEND_KEY);
    let t_restore = harness
        .suspend_teardown_time(mark)
        .expect("the raced suspend's teardown bytes");
    let waited = t_restore.saturating_duration_since(t_query);
    assert!(
        waited < VERDICT_BOUND,
        "the raced suspend's teardown landed at {waited:?} after the query \
         on a DA1-answered terminal — the mode transition waited for the \
         probe window, so the verdict did not happen at the DA1 answer"
    );
    harness.assert_query_count(1);
    harness.finish();
}

#[test]
fn a_raced_suspend_on_a_silent_pty_keeps_the_deadline() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut harness = VerdictHarness::start();
    let t_query = harness
        .chunk_time_of(KITTY_QUERY)
        .expect("the kitty capability query is on the wire");
    // The silent class: the raced teardown waits out the window — the mode lock
    // holds until the deadline (a window cut below the line reds here).
    VerdictHarness::sleep_until(t_query + Duration::from_millis(60));
    let mark = harness.mark();
    harness.write(SUSPEND_KEY);
    let t_restore = harness
        .suspend_teardown_time(mark)
        .expect("the raced suspend's teardown bytes");
    let waited = t_restore.saturating_duration_since(t_query);
    assert!(
        waited >= VERDICT_BOUND,
        "the raced suspend's teardown landed at {waited:?} after the query \
         on a silent pty — before the deadline, so the answer window no \
         longer reaches its 250ms bound"
    );
    assert!(
        waited <= SILENT_RESTORE_MAX,
        "the raced suspend's teardown landed at {waited:?} after the query \
         on a silent pty — past the deadline plus teardown path"
    );
    harness.assert_query_count(1);
    harness.finish();
}

/// The characterization sweep (VM-only, opt-in): CI never sets the env, so it
/// returns trivially there; each cell prints one `SWEEP_ROW` json line.
#[test]
fn verdict_time_characterization_sweep() {
    if std::env::var(SWEEP_ENV).is_err() {
        return;
    }
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let ms = |d: Duration| d.as_millis() as u64;
    let row = |cell: &str, mut fields: Value| {
        let mut full = json!({"cell": cell});
        if let (Value::Object(dst), Value::Object(src)) = (&mut full, &mut fields) {
            dst.append(src);
        }
        println!("SWEEP_ROW {full}");
    };

    // (A) The DA1-class conclusion scan: the kitty reply at +y brackets the verdict.
    for y in [20u64, 25, 30, 40, 50, 60, 80] {
        let mut harness = VerdictHarness::start();
        let t_query = harness
            .chunk_time_of(KITTY_QUERY)
            .expect("the kitty capability query is on the wire");
        VerdictHarness::sleep_until(t_query + Duration::from_millis(15));
        harness.write(DA1_ANSWER);
        VerdictHarness::sleep_until(t_query + Duration::from_millis(y));
        harness.write(KITTY_ANSWER);
        VerdictHarness::sleep_until(t_query + Duration::from_millis(700));
        harness.drain_until_quiet(10);
        let upgraded = contains(&harness.output(), KITTY_FLAGS_PUSH);
        row(
            "da1_conclusion_scan",
            json!({"reply_offset_ms": y, "upgraded": upgraded}),
        );
        harness.assert_query_count(1);
        harness.finish();
    }

    // (B) The silent-class upgrade cliff: the reply at +y — the answer window's tail.
    for y in [100u64, 160, 200, 230, 240, 250, 260, 280] {
        let mut harness = VerdictHarness::start();
        let t_query = harness
            .chunk_time_of(KITTY_QUERY)
            .expect("the kitty capability query is on the wire");
        VerdictHarness::sleep_until(t_query + Duration::from_millis(y));
        harness.write(KITTY_ANSWER);
        let push_mark = harness.mark();
        let t_push = harness.suspend_teardown_or_push(push_mark, KITTY_FLAGS_PUSH);
        VerdictHarness::sleep_until(t_query + Duration::from_millis(700));
        harness.drain_until_quiet(10);
        row(
            "silent_upgrade_cliff",
            json!({
                "reply_offset_ms": y,
                "upgraded": t_push.is_some(),
                "push_ms_after_query": t_push.map(|t| ms(t.saturating_duration_since(t_query))),
            }),
        );
        harness.assert_query_count(1);
        harness.finish();
    }

    // (C) The raced-suspend restore curve per class: the teardown bytes at
    // max(dispatch, verdict).
    for (class, answer) in [
        ("da1", Some(DA1_ANSWER)),
        ("silent", None),
        ("kitty", Some(KITTY_ANSWER)),
    ] {
        for x in [30u64, 60, 120, 200] {
            let mut harness = VerdictHarness::start();
            let t_query = harness
                .chunk_time_of(KITTY_QUERY)
                .expect("the kitty capability query is on the wire");
            if let Some(answer) = answer {
                VerdictHarness::sleep_until(t_query + Duration::from_millis(15));
                harness.write(answer);
            }
            VerdictHarness::sleep_until(t_query + Duration::from_millis(x));
            let mark = harness.mark();
            harness.write(SUSPEND_KEY);
            let t_restore = harness
                .suspend_teardown_time(mark)
                .expect("the raced suspend's teardown bytes");
            row(
                "raced_suspend_curve",
                json!({
                    "class": class,
                    "suspend_offset_ms": x,
                    "restore_ms_after_query": ms(t_restore.saturating_duration_since(t_query)),
                }),
            );
            harness.finish();
        }
    }

    // (D) The kitty control's push time: the verdict at the answer.
    {
        let mut harness = VerdictHarness::start();
        let t_query = harness
            .chunk_time_of(KITTY_QUERY)
            .expect("the kitty capability query is on the wire");
        VerdictHarness::sleep_until(t_query + Duration::from_millis(15));
        harness.write(KITTY_ANSWER);
        let push_mark = harness.mark();
        let t_push = harness
            .suspend_teardown_or_push(push_mark, KITTY_FLAGS_PUSH)
            .expect("the answered flags push");
        row(
            "kitty_push_time",
            json!({"push_ms_after_query": ms(t_push.saturating_duration_since(t_query))}),
        );
        harness.finish();
    }
}

/// One pty-backed product child plus its mock supervisor, with a
/// chunk-accurate timing ledger over the raw byte stream.
struct VerdictHarness {
    child: Child,
    /// The mock-supervisor server thread's join handle (exits with the child's connection).
    _server: std::thread::JoinHandle<()>,
    master: LedgerReader,
}

impl VerdictHarness {
    fn start() -> VerdictHarness {
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
        // Leak the temp dir's socket path on purpose: the child needs it, and the
        // whole tree dies with the child at teardown.
        std::mem::forget(dir);
        VerdictHarness {
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

    /// The chunk time of the first occurrence of `needle`, waited for (the ledger
    /// is chunk-accurate: the query's read chunk is the probe's start).
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

    /// The teardown/push needle's chunk time, waited for since the mark.
    fn suspend_teardown_or_push(&mut self, mark: usize, needle: &[u8]) -> Option<Instant> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            self.master.drain_once();
            if find_subsequence(&self.master.output[mark..], needle).is_some() {
                return self.master.time_of(needle);
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// The raced suspend's teardown time: waits for the paste-off since the mark,
    /// asserts the mouse release precedes it, returns the paste-off's chunk time.
    fn suspend_teardown_time(&mut self, mark: usize) -> Option<Instant> {
        let t = self.suspend_teardown_or_push(mark, PASTE_DISABLE)?;
        let paste_at = mark
            + find_subsequence(&self.master.output[mark..], PASTE_DISABLE)
                .expect("the paste-off scan just succeeded");
        assert!(
            find_subsequence(&self.master.output[mark..paste_at], MOUSE_DISABLE).is_some(),
            "the paste-off arrived without the suspend's mouse release first — \
             the needle's writer was not the suspend teardown"
        );
        Some(t)
    }

    /// How long after the CURRENT moment the needle next paints (fresh mark).
    fn time_until_painted_since(&mut self, needle: &[u8], bound: Duration) -> Option<Duration> {
        // The needle may already be on the wire from the chrome; scan past everything so far.
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

    fn sleep_until(target: Instant) {
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

    /// The once-per-process contract: exactly one capability query in the stream.
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

impl Drop for VerdictHarness {
    fn drop(&mut self) {
        // A panicking wait must never leak the pty child.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Non-blocking reader over the pty master with a per-chunk timing ledger.
struct LedgerReader {
    file: std::fs::File,
    output: Vec<u8>,
    /// (chunk arrival, cumulative end offset) — the chunk-accurate timing ledger.
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

    /// Drain until quiet for `quiet_polls` consecutive passes (25ms apart).
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

    /// Drain until the needle appears since the mark (bounded by a generous deadline).
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
    // Runs between fork and exec: become a session leader and claim the pty slave as the tty.
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
        .arg("verdict_child_mode")
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
