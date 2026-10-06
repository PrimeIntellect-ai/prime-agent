// large_futures: stack-resident futures on hot paths by design.
// too_many_lines: style gate. Casts: 64-bit targets; narrowing sits at
// bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! The termios + process-tree exit audit (companion to the kitty fix and the
//! terminal-state differential): the Ctrl+S output stop is RUNTIME state, not
//! termios (`tcsetattr` never clears it), so a stop armed on a cooked tty must
//! not outlive the TUI. Reuses the differential's pty harness.
#![cfg(unix)]

// This binary's routes use a subset of the shared module's surface,
// so the rest is deliberately dead here.
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
/// When set, the chat child announces itself on the tty and blocks on
/// stdin until the harness releases it.
const CHILD_PREMOUNT_GATE_ENV: &str = "PA_TERMIOS_PREMOUNT_GATE";
/// The gate's announce marker (cooked-tty bytes; no mode state).
const PREMOUNT_MARKER: &[u8] = b"termios-premount-gate\r\n";

// The child modes (spawn_child maps the mode names to these tests).

/// The chat child: the real interactive surface against the mock
/// supervisor (a plain run passes trivially).
#[test]
fn diff_chat_child_mode() {
    let Some(socket) = std::env::var(CHILD_SOCKET_ENV).ok() else {
        return;
    };
    // The pre-mount gate: the child sits in the cooked window until the
    // harness arms the Ctrl+S stop and releases it.
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

// The audit assertions.

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

/// The fd-set audit: after the TUI exits, NO process may still hold the
/// pty (a leaked grandchild keeps the pane busy).
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

/// The Ctrl+S flow probe: the pty is cooked again after the exit, so a line
/// echoes back — unless a stop state survived the TUI ("frozen shell until Ctrl+Q").
fn assert_the_shell_flows(master: &mut PtyReader, context: &str) {
    let mark = master.mark();
    master.write(b"flow-probe\r");
    master.wait_from(
        mark,
        b"flow-probe",
        &format!("{context}: the handed-back tty still flows (no Ctrl+S stop state)"),
    );
}

/// Run one route's whole terminal-handback contract.
fn assert_the_handback_is_whole(harness: &mut DifferentialHarness, context: &str) {
    harness.assert_terminal_state_restored(context);
    assert_no_process_holds_the_pty(&harness.master.file, context);
    assert_the_shell_flows(&mut harness.master, context);
}

// The routes.

/// Route: the full chat session -> `/exit`: the mid-session Ctrl+S lands
/// in a raw window (IXON off), and the exit must flow anyway.
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

    // Ctrl+S mid-session (the raw window): consumed as a key event.
    let mark = harness.mark();
    harness.write(&[CTRL_S]);
    harness.drain_until_quiet(4);
    // Ctrl+S again right before the exit: the byte may land in the drain
    // (raw) or the cooked tail — either way it must flow.
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

/// Route: the launch on a Ctrl+S-STOPPED tty: the gate holds the child in
/// the cooked window while the harness arms the stop, and the mount must
/// lift it (`cfmakeraw`'s IXON clearing).
#[test]
fn a_launch_on_a_ctrl_s_stopped_tty_flows_and_exits_whole() {
    let _lock = harness::harness_lock();
    let mut harness =
        DifferentialHarness::start(&ChildSpec::new("chat").env(CHILD_PREMOUNT_GATE_ENV, "1"));
    assert!(
        harness.before.input_flow_control_on(),
        "the pre-launch pty must run software flow control for the stop to arm"
    );
    // The gate: the XOFF arms the stop NOW; the release line unblocks the child.
    harness.wait_from_start(
        &PREMOUNT_MARKER[..PREMOUNT_MARKER.len().saturating_sub(2)],
        "the pre-mount gate marker",
    );
    // Arm the stop and PROVE it armed: the cooked discipline echoes input
    // as it arrives, and the stop holds that echo — the sentinel must NOT
    // come back (no newline, so the gate read stays blocked).
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
    // The release completes the sentinel line; the mount runs under the armed stop.
    harness.write(b"\r\n");
    harness.answer_kitty_query();
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

/// Route: the agents-view exit (breadth over the second surface).
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

// The suspend-cycle route (env-gated: this sandbox class neutralizes process stops).

/// Whether this runner can drive a real SIGTSTP stop: a controlling-terminal
/// session AND a sandbox that honors stop signals (loud skip otherwise).
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
    // The stop-capability probe: a scratch child must actually stop.
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

/// The suspend-cycle harness: the child in its OWN process group inside a
/// fresh session (the stop holds; no controlling terminal).
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

/// A child in its own process group: `kill(0, SIGTSTP)` stops its group, not this runner.
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
/// window — the exact state the flow-control fix targets: Ctrl+Z stops the
/// group, a Ctrl+S stops the tty (IXON restored), the `fg` resume must
/// restart output, and the exit hands back a FLOWING tty.
#[test]
fn a_suspend_cycle_with_a_ctrl_s_in_the_stopped_window_never_stops_the_shell() {
    if !stop_capable_runner() {
        return;
    }
    // The runner leads a fresh session so the child's group is parented inside it.
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
    // The flags push only happens once the terminal answers the query.
    harness.master.write(KITTY_ANSWER);
    harness
        .master
        .wait_from(0, KITTY_FLAGS_PUSH, "the kitty flags push");
    harness
        .master
        .wait_from(0, b"row 0", "the attach snapshot rendered");

    let child_id = harness.child.id();
    harness.master.write(&[0x1a]);
    wait_for_stopped(child_id, "the app.suspend cycle stopped the group");

    harness.master.write(&[CTRL_S]);

    harness.master.drain_until_quiet(8);
    let mark_resume = harness.master.mark();
    kill(Pid::from_raw(child_id as i32), Signal::SIGCONT).expect("SIGCONT");
    // The sandbox's pty can drop the first post-continue writes: pin on
    // the typed-text render that always arrives.
    harness.master.write(b"hi");
    harness.master.wait_from(
        mark_resume,
        b"\x1b[22;7H",
        "the resumed surface flows (the output stop did not survive the resume)",
    );

    let mark = harness.master.mark();
    harness.master.write(b"/exit\r");
    harness.master.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the parity exit left the alt screen",
    );
    wait_for_exit(&mut harness.child, "the post-suspend exit");

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
