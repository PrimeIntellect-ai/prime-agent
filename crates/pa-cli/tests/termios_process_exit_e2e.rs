// The Tier-C/D ruling (fleet-uniform, 2026-09-28): stack-resident futures by
// design on hot paths; 64-bit targets - the narrowing sits at OS/protocol
// boundaries where the values are bounded (pid syscalls, epoch/elapsed
// milliseconds), and checked conversions would add panic paths where silent
// wrap was deliberate.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! The termios + process-tree exit audit (the companion to the landed kitty
//! fix #3001 and the terminal-state differential #3002): the state BELOW
//! the escape sequences — the line discipline, the process tree, and the
//! fd set the TUI hands back to the shell.
//!
//! The differential already nets every escape-sequence mode and the
//! termios byte-equality per route; this e2e owns what the byte stream
//! cannot show:
//!
//! - **the Ctrl+S flow state**: the output stop is RUNTIME, not termios —
//!   `tcsetattr` never clears it. A Ctrl+S the line discipline processed
//!   on a cooked tty (the shell prompt before the launch, or a suspend
//!   window) must not outlive the TUI: the raw-mode brackets restart
//!   output flow (the fix), and every route here proves it with a
//!   post-exit echo round-trip on the handed-back tty;
//! - **the fd set**: after the TUI process exits, NO process may still
//!   hold the pty (a leaked grandchild holding `/dev/tty` keeps the pane
//!   busy past the exit — the audit found every probe child inheriting
//!   the tty stdin and fixed them; the scan is the net);
//! - **the process tree**: the child's exit must be real (`(0)`) and its
//!   whole tree gone with it;
//! - **the termios snapshot**: the pre-launch line discipline returns
//!   byte-equal (inherited from the differential's assert for the
//!   escape-stream modes too).
//!
//! Routes: the full chat session (with Ctrl+S pressed mid-session), the
//! launch on a Ctrl+S-stopped tty (the pre-launch stop must not eat the
//! TUI), the suspend cycle with a Ctrl+S armed in the cooked stopped
//! window (env-gated exactly like the fleet's suspend e2es — this sandbox
//! neutralizes process stops), and the agents-view exit for breadth over
//! the second surface.
//!
//! Reuses the differential's pty harness (the mock supervisor, the
//! recording master reader, the termios capture) via path-includes; the
//! harness's own routes are unchanged.
#![cfg(unix)]

// The differential's own binary exercises every harness entry; this
// binary's routes use a subset, so the shared module's wider surface is
// deliberately allowed to be unused here.
#[path = "terminal_state_differential_e2e/harness.rs"]
#[allow(dead_code)]
mod harness;
#[path = "terminal_state_differential_e2e/ledger.rs"]
#[allow(dead_code)]
mod ledger;

use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::pty::{openpty, Winsize};
use nix::sys::signal::{kill, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::Pid;

use harness::{ChildSpec, DifferentialHarness, PtyReader, Termios};

/// The kitty flags push (the arm proof the mounted surface must show).
const KITTY_FLAGS_PUSH: &[u8] = b"\x1b[>7u";
/// The kitty capability query (the probe writes it once per process).
const KITTY_QUERY: &[u8] = b"\x1b[?u";
/// The harness's kitty answer: flags supported, then the primary DA.
const KITTY_ANSWER: &[u8] = b"\x1b[?7u\x1b[?62;c";
/// The child-mode env: which surface the re-executed binary runs.
const CHILD_MODE_ENV: &str = "PA_TERMIOS_CHILD_MODE";
/// The mock-supervisor socket for the chat/view surfaces.
const CHILD_SOCKET_ENV: &str = "PA_TERMIOS_CHILD_SOCKET";
/// TERM the children run with: answers the kitty query, no shortcut.
const CHILD_TERM: &str = "xterm-256color";
/// The alt-screen leave: every route that ends the process writes it.
const ALT_SCREEN_LEAVE: &[u8] = b"\x1b[?1049l";
/// The Ctrl+S stop byte (XOFF).
const CTRL_S: u8 = 0x13;
/// The child-mode pre-mount gate: when set, the chat child announces
/// itself on the tty and blocks on stdin until the harness releases it —
/// the launch-on-a-stopped-tty route arms the Ctrl+S stop at a
/// deterministic point in the cooked pre-mount window.
const CHILD_PREMOUNT_GATE_ENV: &str = "PA_TERMIOS_PREMOUNT_GATE";
/// The gate's announce marker (cooked-tty bytes; no mode state).
const PREMOUNT_MARKER: &[u8] = b"termios-premount-gate\r\n";

// ---------------------------------------------------------------------------
// The child modes (this binary re-executed as the product under test — the
// harness's spawn_child maps the mode names to these tests)
// ---------------------------------------------------------------------------

/// The chat child: the real interactive surface against the mock
/// supervisor (the differential's same contract; a plain `cargo test` run
/// without the env passes trivially).
#[test]
fn diff_chat_child_mode() {
    let Some(socket) = std::env::var(CHILD_SOCKET_ENV).ok() else {
        return;
    };
    // The pre-mount gate (the launch-on-a-stopped-tty route): the child
    // sits in the cooked pre-mount window until the harness arms its
    // Ctrl+S stop and releases the line.
    if std::env::var(CHILD_PREMOUNT_GATE_ENV).is_ok() {
        std::io::Write::write_all(&mut std::io::stdout(), PREMOUNT_MARKER)
            .expect("the gate marker");
        std::io::Write::flush(&mut std::io::stdout()).expect("flush the gate marker");
        let mut released = [0u8; 8];
        // SAFETY: a plain read from the child's own stdin (fd 0, the pty
        // slave): the cooked line discipline returns the release line.
        let read = unsafe { libc::read(0, released.as_mut_ptr().cast(), released.len()) };
        assert!(read > 0, "the gate release never arrived on stdin");
    }
    let options = harness::child_options(PathBuf::from(socket));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _ = runtime
        .block_on(pa_tui::interactive::run_interactive(
            options,
            pa_tui::interactive::UiMode::Terminal,
        ))
        .expect("the chat surface ran");
    harness::quiet_child_epilogue();
}

/// The view child: the agents-view roster surface, closed by the caller.
#[test]
fn diff_view_child_mode() {
    let Some(socket) = std::env::var(CHILD_SOCKET_ENV).ok() else {
        return;
    };
    let options = harness::view_options(PathBuf::from(socket), None);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let view = runtime.block_on(pa_tui::agents_view::run_agents_view(
        options,
        pa_tui::agents_view::AgentsViewUiMode::Terminal,
        None,
    ));
    if let Ok(view) = view {
        if let Some(link) = view.link {
            link.close();
        }
    }
    harness::quiet_child_epilogue();
}

// ---------------------------------------------------------------------------
// The audit assertions (the state below the escape sequences)
// ---------------------------------------------------------------------------

/// Resolve the pty slave's device path from the master fd.
fn pty_slave_path(master: &std::fs::File) -> PathBuf {
    let mut buffer = [0u8; 64];
    // SAFETY: `ptsname_r` writes the NUL-terminated slave path into
    // `buffer` and never exceeds its length.
    let rc =
        unsafe { libc::ptsname_r(master.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
    assert_eq!(rc, 0, "the harness could not resolve the pty slave path");
    let end = buffer
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(buffer.len());
    PathBuf::from(String::from_utf8_lossy(&buffer[..end]).into_owned())
}

/// The fd-set audit: after the TUI process exits, NO process may still
/// hold the pty — a leaked grandchild holding `/dev/tty` keeps the pane's
/// terminal busy past the exit. The scan reads `/proc/*/fd` for links to
/// this private pty's slave; only this test's own tree can hold it.
fn assert_no_process_holds_the_pty(master: &std::fs::File, context: &str) {
    let slave = pty_slave_path(master);
    let self_pid = std::process::id();
    let mut holders = Vec::new();
    for entry in std::fs::read_dir("/proc").expect("the sandbox mounts /proc") {
        // Processes may die mid-scan: a vanished entry is not a holder.
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if pid == self_pid {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            if let Ok(link) = std::fs::read_link(fd.path()) {
                if link == slave {
                    holders.push(pid);
                }
            }
        }
    }
    assert!(
        holders.is_empty(),
        "{context}: processes still hold the pty slave {} after the exit: \
         {holders:?} — a TUI child leaked the terminal fd",
        slave.display()
    );
}

/// The Ctrl+S flow probe: the handed-back tty must FLOW. The pty is
/// cooked again after the exit (echo + canonical), so a line written to
/// the master echoes back — unless a Ctrl+S stop state survived the TUI,
/// in which case the line discipline holds the echo and the probe times
/// out (the "frozen shell until Ctrl+Q" leak).
fn assert_the_shell_flows(master: &mut PtyReader, context: &str) {
    let mark = master.mark();
    master.write(b"flow-probe\r");
    master.wait_from(
        mark,
        b"flow-probe",
        &format!("{context}: the handed-back tty still flows (no Ctrl+S stop state)"),
    );
}

/// Run one route's whole terminal-handback contract: the terminal state
/// the child leaves equals the state it received (the mode ledger AND
/// the termios snapshot), no process still holds the pty, and the tty
/// flows after the handback.
fn assert_the_handback_is_whole(harness: &mut DifferentialHarness, context: &str) {
    harness.assert_terminal_state_restored(context);
    assert_no_process_holds_the_pty(&harness.master.file, context);
    assert_the_shell_flows(&mut harness.master, context);
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

/// Route: the full chat session -> `/exit` -> the whole handback. The
/// flow-control probe rides INSIDE the session: Ctrl+S pressed
/// mid-session lands in a raw window (IXON off — the line discipline
/// must never see it as flow control; the TUI reads it as a key event),
/// and the exit must leave the shell flowing anyway.
#[test]
fn a_full_session_with_a_mid_session_ctrl_s_exits_whole() {
    let _lock = harness::harness_lock();
    let mut harness = DifferentialHarness::start(&ChildSpec::new("chat"));
    assert!(
        harness.before.input_flow_control_on(),
        "the pre-launch pty must run software flow control for the flow probe to mean anything"
    );
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    // Ctrl+S mid-session (the raw window): consumed as a key event, the
    // tty never stops.
    let mark = harness.mark();
    harness.write(&[CTRL_S]);
    harness.drain_until_quiet(4);
    // Ctrl+S again right before the exit: the byte may land in the
    // exit's drain (raw) or its cooked tail — either way the handback
    // must flow.
    harness.write(&[CTRL_S]);

    harness.write(b"/exit\r");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the parity exit left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(exit, Some(0), "the child exited cleanly through /exit");

    assert_the_handback_is_whole(&mut harness, "the full-session exit");
}

/// Route: the launch on a Ctrl+S-STOPPED tty. The user pressed Ctrl+S
/// at the shell prompt, then launched the TUI: the gate holds the child
/// in the cooked pre-mount window while the harness arms the output
/// stop, and the mount must lift it (`cfmakeraw`'s IXON clearing is the
/// kernel's one stop-lift trigger). The first frame renders, the
/// session works, and the exit leaves a flowing shell. A bracket that
/// stops clearing IXON — or a termios path that never runs it — fails
/// this route at the first wait.
#[test]
fn a_launch_on_a_ctrl_s_stopped_tty_flows_and_exits_whole() {
    let _lock = harness::harness_lock();
    let mut harness =
        DifferentialHarness::start(&ChildSpec::new("chat").env(CHILD_PREMOUNT_GATE_ENV, "1"));
    assert!(
        harness.before.input_flow_control_on(),
        "the pre-launch pty must run software flow control for the stop to arm"
    );
    // The gate: the child sits in the cooked pre-mount window; the XOFF
    // arms the stop NOW (the line discipline consumes it while IXON is
    // on), and the release line unblocks the child — whose mount must
    // then lift the stop (the raw bracket's IXON clearing).
    harness.wait_from_start(
        &PREMOUNT_MARKER[..PREMOUNT_MARKER.len().saturating_sub(2)],
        "the pre-mount gate marker",
    );
    // Arm the stop and PROVE it armed before releasing the child: the
    // line discipline echoes cooked-tty input, and the stop holds the
    // echo — a sentinel line written now must NOT come back within the
    // settle window. The assert turns a failed arm into a loud route
    // failure instead of a silently-degenerate pass.
    // Arm the stop and PROVE it armed before releasing the child: the
    // cooked line discipline echoes input as it arrives (no newline
    // needed), and the stop holds that echo — a sentinel written now
    // must NOT come back within the settle window. The assert turns a
    // failed arm into a loud route failure instead of a silently
    // degenerate pass; the sentinel carries no newline, so the child's
    // gate read stays blocked until the release below.
    harness.write(&[CTRL_S]);
    harness.write(b"arm");
    let arm_mark = harness.mark();
    let deadline = Instant::now() + Duration::from_millis(300);
    let mut armed = true;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(30));
        harness.drain_until_quiet(1);
        if !harness.output()[arm_mark..].is_empty() {
            armed = false;
            break;
        }
    }
    assert!(
        armed,
        "the Ctrl+S write did not arm the output stop (the cooked-tty          echo came back); the route cannot prove the lift"
    );
    // The release: completes the sentinel line, so the child's gate
    // read returns and the mount runs under the armed stop.
    harness.write(b"\r\n");
    harness.answer_kitty_query();
    // The lift's proof: the first frame renders on the stopped tty.
    harness.wait_from_start(
        b"row 0",
        "the attach snapshot rendered despite the pre-mount stop",
    );

    let mark = harness.mark();
    harness.write(b"/exit\r");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the parity exit left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(exit, Some(0), "the child exited cleanly through /exit");

    assert_the_handback_is_whole(&mut harness, "the stopped-tty launch exit");
}

/// Route: the agents-view exit (breadth over the second surface — the
/// view's own raw-mode bracket and restore funnel, with the same
/// process-tree, fd-set, and flow contracts).
#[test]
fn the_agents_view_exit_exits_whole() {
    let _lock = harness::harness_lock();
    let mut harness = DifferentialHarness::start(&ChildSpec::new("view"));
    assert!(
        harness.before.input_flow_control_on(),
        "the pre-launch pty must run software flow control for the flow probe to mean anything"
    );
    harness.answer_kitty_query();
    harness.wait_from_start(b"Search sessions", "the agents view mounts");

    let mark = harness.mark();
    harness.write(&[CTRL_S]);
    harness.drain_until_quiet(4);
    harness.write(b"\x1b[27u");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the view's exit released the terminal",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly through the view exit"
    );

    assert_the_handback_is_whole(&mut harness, "the agents-view exit");
}

// ---------------------------------------------------------------------------
// The suspend-cycle route (env-gated: this sandbox class neutralizes
// process stops; the gate mirrors the fleet's suspend e2es)
// ---------------------------------------------------------------------------

/// Whether this runner can drive a real SIGTSTP stop: it needs a
/// controlling-terminal session AND a kernel/sandbox that honors stop
/// signals (the shared box neutralizes `kill -TSTP` — the route
/// self-skips there with a loud note, exactly like the mode-differential
/// lane's suspend route).
fn stop_capable_runner() -> bool {
    // SAFETY: `tcgetpgrp` only queries the fd's foreground process group.
    let foreground = unsafe { libc::tcgetpgrp(0) };
    if foreground < 0 {
        eprintln!(
            "no controlling-terminal session on the runner (tcgetpgrp(fd 0) \
             failed); skipping the suspend-cycle route — it drives a real \
             stop/continue cycle"
        );
        return false;
    }
    // The stop-capability probe: a scratch child must actually stop on
    // SIGTSTP (WUNTRACED observes it).
    let mut probe = Command::new("sleep")
        .arg("10")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the stop-capability probe");
    let pid = Pid::from_raw(probe.id() as i32);
    let capable = stop_observed(pid);
    let _ = kill(pid, Signal::SIGKILL);
    let _ = probe.wait();
    if !capable {
        eprintln!(
            "SIGTSTP does not stop processes on this runner (the sandbox \
             neutralizes job-control stops); skipping the suspend-cycle \
             route — its stop window cannot be entered"
        );
    }
    capable
}

/// Wait briefly for the scratch child to observe a SIGTSTP stop.
fn stop_observed(pid: Pid) -> bool {
    if kill(pid, Signal::SIGTSTP).is_err() {
        return false;
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match waitpid(pid, Some(WaitPidFlag::WNOHANG | WaitPidFlag::WUNTRACED)) {
            Ok(WaitStatus::Stopped(_, _)) => return true,
            Ok(WaitStatus::Exited(..)) => return false,
            _ if Instant::now() > deadline => return false,
            _ => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

/// The suspend-cycle harness: the child in its OWN process group inside
/// this runner's fresh session (the stop holds — the group is parented,
/// not orphaned), its terminal the harness pty as plain stdio (no
/// controlling terminal, so no background-group arbitration), the mock
/// supervisor from the shared differential harness serving the socket.
struct SuspendCycleHarness {
    child: Child,
    master: PtyReader,
    before: Termios,
    /// The mock socket's temp dir (the child needs it for its lifetime).
    _socket_dir: tempfile::TempDir,
    _server: Option<std::thread::JoinHandle<()>>,
}

impl SuspendCycleHarness {
    fn start() -> SuspendCycleHarness {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("tui.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind mock socket");
        let server = std::thread::spawn({
            let listener = listener.try_clone().expect("clone mock listener");
            move || harness::MockSupervisor::serve(&listener, &[])
        });
        drop(listener);

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
        let child = spawn_group_child(&socket, &pty.slave);
        SuspendCycleHarness {
            child,
            master: PtyReader::new(pty.master),
            before,
            _socket_dir: dir,
            _server: Some(server),
        }
    }
}

impl Drop for SuspendCycleHarness {
    fn drop(&mut self) {
        // A panicking wait must never leak the pty child.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A child of this very binary in its own process group (the real-signal
/// contract of the fleet's suspend e2e): `kill(0, SIGTSTP)` from inside
/// the child stops its group and not this runner, and the stop holds.
fn spawn_group_child(socket: &Path, slave: &OwnedFd) -> Child {
    // Runs between fork and exec in the child: move it into its own
    // process group inside this runner's session.
    fn make_process_group() -> std::io::Result<()> {
        nix::unistd::setpgid(Pid::from_raw(0), Pid::from_raw(0))?;
        Ok(())
    }
    let mut command = Command::new(std::env::current_exe().expect("test binary"));
    command
        .arg("--exact")
        .arg("diff_chat_child_mode")
        .env(CHILD_SOCKET_ENV, socket)
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
    // process-group setup; it runs post-fork pre-exec in the child only.
    unsafe { command.pre_exec(make_process_group) };
    command.spawn().expect("spawn the suspend-cycle child")
}

fn slave_as_stdio(slave: &OwnedFd) -> Stdio {
    slave.try_clone().expect("clone pty slave").into()
}

/// Poll the child until SIGTSTP's default disposition stops its group.
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

/// Wait for the child to exit cleanly within the bound.
fn wait_for_exit(child: &mut Child, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().expect("wait the child") {
            assert_eq!(status.code(), Some(0), "{what}: the child exited cleanly");
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{what}: the child did not exit in time"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Route: the suspend cycle with a Ctrl+S armed in the cooked stopped
/// window — the exact state the flow-control fix targets. Ctrl+Z stops
/// the group (the tty is cooked while the shell owns it); a Ctrl+S
/// written during the stop is processed by the line discipline (IXON on
/// in the restored termios) and stops the tty; on `fg` (SIGCONT) the
/// resume must restart output (a hung-looking TUI otherwise), and the
/// exit must hand the shell a FLOWING tty.
#[test]
fn a_suspend_cycle_with_a_ctrl_s_in_the_stopped_window_never_stops_the_shell() {
    if !stop_capable_runner() {
        return;
    }
    // The runner leads a fresh session so the child's group is parented
    // inside it (the stop holds; a controlling terminal is never needed
    // by the child — its stdio IS the pty).
    if let Err(error) = nix::unistd::setsid() {
        panic!("the harness could not start a fresh session: {error}");
    }
    let _lock = harness::harness_lock();

    let mut harness = SuspendCycleHarness::start();
    assert!(
        harness.before.input_flow_control_on(),
        "the pre-launch pty must run software flow control for the stop to arm"
    );
    harness
        .master
        .wait_from(0, KITTY_QUERY, "the first mount's kitty query");
    // The flags push only happens once the terminal ANSWERS the query —
    // the same answer_kitty_query contract the other routes use.
    harness.master.write(KITTY_ANSWER);
    harness
        .master
        .wait_from(0, KITTY_FLAGS_PUSH, "the kitty flags push");
    harness
        .master
        .wait_from(0, b"row 0", "the attach snapshot rendered");

    // Ctrl+Z: the app.suspend cycle hands the terminal to the shell and
    // stops the process group.
    let child_id = harness.child.id();
    harness.master.write(&[0x1a]);
    wait_for_stopped(child_id, "the app.suspend cycle stopped the group");

    // Ctrl+S in the cooked stopped window: the line discipline processes
    // it (IXON restored) — the tty stops NOW, while the shell owns it.
    harness.master.write(&[CTRL_S]);

    // `fg` (SIGCONT): the resume re-arms the modes and must restart the
    // output flow — the repaint and the typed text have to arrive.
    harness.master.drain_until_quiet(8);
    let mark_resume = harness.master.mark();
    kill(Pid::from_raw(child_id as i32), Signal::SIGCONT).expect("SIGCONT");
    // The suspend e2e's lesson: the sandbox's pty can drop the first
    // post-continue writes, so the proof pins on the typed-text render
    // that always arrives.
    harness.master.write(b"hi");
    harness.master.wait_from(
        mark_resume,
        b"\x1b[22;7H",
        "the resumed surface flows (the output stop did not survive the resume)",
    );

    // The exit: the shell must get a FLOWING tty.
    let mark = harness.master.mark();
    harness.master.write(b"/exit\r");
    harness.master.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the parity exit left the alt screen",
    );
    wait_for_exit(&mut harness.child, "the post-suspend exit");

    // The termios snapshot (this harness owns its own capture): the
    // line discipline returns byte-equal to the pre-launch state.
    harness.master.drain_until_quiet(10);
    let after = Termios::capture(harness.master.file.as_raw_fd());
    assert!(
        harness.before.delta_is_empty(&after),
        "the suspend-cycle exit changed the pty's termios: before {} after {}",
        harness.before.describe(),
        after.describe()
    );
    let context = "the suspend-cycle exit";
    assert_no_process_holds_the_pty(&harness.master.file, context);
    assert_the_shell_flows(&mut harness.master, context);
}
