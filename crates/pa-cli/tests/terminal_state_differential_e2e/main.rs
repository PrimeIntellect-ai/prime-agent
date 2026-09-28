// The Tier-C/D ruling (fleet-uniform, 2026-09-28): stack-resident futures by
// design on hot paths; 64-bit targets - the narrowing sits at OS/protocol
// boundaries where the values are bounded (pid syscalls, epoch/elapsed
// milliseconds), and checked conversions would add panic paths where silent
// wrap was deliberate.
#![allow(
    clippy::large_futures,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::too_many_lines
)]

//! The terminal-state differential: a recording mock terminal over a
//! real pty asserts that EVERY terminal mode the TUI arms comes back
//! off on EVERY exit route.
//!
//! The operator's directive (2026-09-28, the kitty-exit-leak sweep):
//! "if the kitty protocol is leaking to my shell, check if OTHER things
//! are leaking too." The confirmed kitty leak has its own lane; this
//! harness is the systematic net for everything else. The mock terminal
//! (the harness itself, over the pty master) records every
//! mode-affecting byte the child writes, answers the kitty capability
//! query like a kitty terminal would, drives one exit route, and then
//! asserts THE MODE DELTA IS EMPTY: the terminal state the child hands
//! back equals the state it received. A leak — any mode left armed,
//! any kitty flag pushed and not popped, an SGR left dangling, a
//! termios bit left raw — fails the route.
//!
//! The tracked state, per the inventory (handoffs/TERMINAL-LEAK-AUDIT.md):
//! - DEC private modes (`ESC[?NNNh/l`): bracketed paste 2004, mouse
//!   1000/1002/1003/1006, cursor visibility 25, alt screen 47/1047/1049,
//!   synchronized output 2026, wrap 7, focus reporting 1004, flow control
//!   33 — every mode number the stream writes, known or not: an unknown
//!   mode behaves exactly like a known one (set without reset = leak);
//! - the kitty keyboard protocol: `>Nu` pushes, `<u` pops, `=Nu` sets
//!   (the flags stack depth), plus `>4;Nm` modifyOtherKeys;
//! - SGR: the attribute state at exit must be empty (a dangling color
//!   would paint the shell's own output after the exit);
//! - OSC 8 hyperlinks: every open closed (a dangling open makes the
//!   shell's output a live link); one-shot OSC 52 clipboard writes and
//!   OSC 133 shell-integration markers are counted, not owed;
//! - writes the product does not own today — DECKPAM/DECKPNM
//!   (`ESC=`/`ESC>`), DECSCUSR cursor shapes, margin sets, OSC 0/2 title
//!   sets — any appearance is a finding, so the net catches a future
//!   surface arming one without its restore;
//! - the pty's termios (raw mode lives there, not in the byte stream):
//!   the whole flag set and control characters must return equal.
//!
//! The exit routes parameterize the table (the kitty-exit-leak lane's
//! enumeration): the parity exit (`/exit` and the Ctrl+C pair), the
//! detach handoff to the agents view, the agents-view returns (a fresh
//! entry and the roster-failure error route behind a preserved
//! handoff), the picker exits (the config selector's close, its
//! remapped exit, and the toggle error), the force-quit watchdog from a
//! wedged loop, the panic unwind (the replay surface's panic driver),
//! the error returns, the suspend cycle's mid-run release (the shell
//! gets the terminal while the process is stopped), and the pre-mount
//! daemon refusal (which must restore NOTHING — nothing was armed).
#![cfg(unix)]

mod harness;
mod ledger;

use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use harness::{
    child_options, find_subsequence, harness_lock, quiet_child_epilogue, spawn_child, view_options,
    ChildSpec, DifferentialHarness, PtyReader, Termios,
};
use ledger::ModeLedger;

use nix::pty::{openpty, Winsize};
use nix::sys::signal::{kill, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::Pid;

use pa_tui::agents_view::AgentsViewUiMode;
use pa_tui::config_selector::{
    run_config_selector, ConfigSelector, ConfigSelectorOptions, SelectorRow,
};
use pa_tui::interactive::{run_interactive, UiMode};

/// The kitty flags push (`1|2|4`, the TS `ProcessTerminal` set): the arm
/// proof every mounted surface must show.
const KITTY_FLAGS_PUSH: &[u8] = b"\x1b[>7u";
/// The probe's capability query (`supports_keyboard_enhancement` sends
/// the flags query followed by the primary-device-attributes query).
const KITTY_QUERY: &[u8] = b"\x1b[?u";
/// The harness's answer: flags `1|2|4` supported, then the primary
/// device attributes (what a kitty terminal replies with).
const KITTY_ANSWER: &[u8] = b"\x1b[?7u\x1b[?62;c";
/// The alt-screen leave: every route that ends the process writes it.
const ALT_SCREEN_LEAVE: &[u8] = b"\x1b[?1049l";

/// The child-mode env: which surface this re-executed binary runs.
const CHILD_MODE_ENV: &str = "PA_DIFF_CHILD_MODE";
/// The mock-supervisor socket for the chat/view surfaces.
const CHILD_SOCKET_ENV: &str = "PA_DIFF_CHILD_SOCKET";
/// The replay fixture path (the replay child mode).
const CHILD_FIXTURE_ENV: &str = "PA_DIFF_CHILD_FIXTURE";
/// Replay child flags: `panic` (panic after the first paint).
const CHILD_REPLAY_FLAGS_ENV: &str = "PA_DIFF_CHILD_REPLAY_FLAGS";
/// Selector child flags: comma-separated `fail-toggle` and `remap-exit`.
const CHILD_SELECTOR_FLAGS_ENV: &str = "PA_DIFF_CHILD_SELECTOR_FLAGS";
/// TERM the children run with: a terminal that answers the kitty query
/// but takes no capability shortcut.
const CHILD_TERM: &str = "xterm-256color";

/// The chat child: the real interactive surface against the harness's
/// mock supervisor, then — when the exit came through agents-back — the
/// agents view anchored on the session just left (the CLI composition's
/// `return_to_agents_view` arm). A roster-link failure on that second
/// surface returns quietly: the route's essence is the restore the
/// error path owes, not the child's exit code.
#[test]
fn diff_chat_child_mode() {
    let Some(socket) = std::env::var(CHILD_SOCKET_ENV).ok() else {
        return;
    };
    let options = child_options(PathBuf::from(socket));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let outcome = runtime
        .block_on(run_interactive(options.clone(), UiMode::Terminal))
        .expect("the chat surface ran");
    if outcome.return_to_agents_view {
        let anchor = (!outcome.session_id.is_empty()).then(|| outcome.session_id.clone());
        let view_options = view_options(options.socket_path, anchor);
        let view = runtime.block_on(pa_tui::agents_view::run_agents_view(
            view_options,
            AgentsViewUiMode::Terminal,
            None,
        ));
        if let Ok(view) = view {
            if let Some(link) = view.link {
                link.close();
            }
        }
    }
    quiet_child_epilogue();
}

/// The agents-view child: a fresh view run (the `prime-agent` roster
/// surface). A roster-link failure returns quietly (the error-route
/// restore still ran); a normal run closes the carried link.
#[test]
fn diff_view_child_mode() {
    let Some(socket) = std::env::var(CHILD_SOCKET_ENV).ok() else {
        return;
    };
    let options = view_options(PathBuf::from(socket), None);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let view = runtime.block_on(pa_tui::agents_view::run_agents_view(
        options,
        AgentsViewUiMode::Terminal,
        None,
    ));
    if let Ok(view) = view {
        if let Some(link) = view.link {
            link.close();
        }
    }
    quiet_child_epilogue();
}

/// The picker child: the config-selector surface over a fixed row set
/// (the CLI `config` command's picker without the package resolution).
/// The route's flags arm the two variants: a failing `on_toggle` (the
/// error route) and a remapped `app.clear` binding (the exit route).
#[test]
fn diff_selector_child_mode() {
    if std::env::var(CHILD_MODE_ENV).ok().as_deref() != Some("selector") {
        return;
    }
    let flags = std::env::var(CHILD_SELECTOR_FLAGS_ENV).unwrap_or_default();
    let fail_toggle = flags.split(',').any(|flag| flag == "fail-toggle");
    let remap_exit = flags.split(',').any(|flag| flag == "remap-exit");

    let rows = vec![
        SelectorRow::Group("Resources".to_string()),
        SelectorRow::Item {
            key: "0".to_string(),
            label: "kernel".to_string(),
            checked: true,
            type_label: "tool".to_string(),
            path: "pa-core/kernel".to_string(),
        },
    ];
    let selector = ConfigSelector::new(rows);
    let theme = pa_tui::app::load_theme("prime");
    let keybindings = if remap_exit {
        let mut bindings = pa_tui::keybindings::KeybindingsConfig::new();
        bindings.insert("app.clear".to_string(), vec!["ctrl+q".to_string()]);
        pa_tui::keybindings::KeybindingsManager::with_user_bindings(bindings)
    } else {
        pa_tui::keybindings::KeybindingsManager::new()
    };
    let options = ConfigSelectorOptions::new(theme, keybindings);
    let mut on_toggle = move |_key: &str, _enabled: bool| -> anyhow::Result<()> {
        if fail_toggle {
            anyhow::bail!("the toggle persistence failed (the error route)");
        }
        Ok(())
    };
    let _ = run_config_selector(selector, options, &mut on_toggle);
    quiet_child_epilogue();
}

/// The replay child: the replay surface (`pa-tui-replay`'s live mode)
/// over a fixture the harness wrote. The `panic` flag runs the
/// exit-restore verifier's panic driver (a real unwind on a live
/// surface).
#[test]
fn diff_replay_child_mode() {
    let Some(fixture) = std::env::var(CHILD_FIXTURE_ENV).ok() else {
        return;
    };
    let flags = std::env::var(CHILD_REPLAY_FLAGS_ENV).unwrap_or_default();
    let panic_after_frame = flags.split(',').any(|flag| flag == "panic");
    let stream =
        pa_tui::session::JsonlSessionStream::from_path(Path::new(&fixture)).expect("fixture");
    let options = pa_tui::app::AppOptions {
        theme: "prime".to_string(),
        panic_after_frame,
        ..Default::default()
    };
    let _ = pa_tui::app::run_app(Box::new(stream), options, Box::new(|_text| {}));
    quiet_child_epilogue();
}

/// The fixture session the replay child runs: a small transcript with a
/// URL row (the OSC 8 hyperlink pairs).
fn write_replay_fixture() -> String {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let path = dir.path().join("fixture.jsonl");
    let fixture = concat!(
        r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"replay row 0"}],"timestamp":1}}"#,
        "\n",
        r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"replay row 1 https://example.com/replay"}],"api":"faux:1","provider":"faux","model":"faux-1","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}}"#,
        "\n",
    );
    std::fs::write(&path, fixture).expect("write fixture");
    // The child reads the file across the process boundary: keep the
    // directory for the child's lifetime (the harness tears the whole
    // tree down with the child).
    std::mem::forget(dir);
    path.display().to_string()
}

// ---------------------------------------------------------------------------
// The exit-route table (the parameterized differential)
// ---------------------------------------------------------------------------

/// Route: the parity exit through the `/exit` slash command. The normal
/// quit: the drain, the mode releases, the alt-screen leave with the
/// inline transcript flush, and the shared release tail.
#[test]
fn parity_exit_through_slash_command_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    let mark = harness.mark();
    harness.write(b"/exit\r");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the parity exit left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly through the parity exit"
    );

    harness.assert_terminal_state_restored("the parity exit (/exit)");
}

/// Route: the parity exit through the Ctrl+C pair (the operator's
/// gesture): the first press arms the exit hint, the second exits, and
/// the same teardown tail runs.
#[test]
fn parity_exit_through_the_ctrl_c_pair_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    let mark = harness.mark();
    harness.write(b"\x03");
    harness.drain_until_quiet(4);
    harness.write(b"\x03");
    harness.wait_from(mark, ALT_SCREEN_LEAVE, "the ctrl+c pair exited the surface");
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly through the ctrl+c pair"
    );

    harness.assert_terminal_state_restored("the parity exit (the ctrl+c pair)");
}

/// Route: the detach handoff to the agents view — the pane hands to a
/// second surface of the same process (the alt screen and raw mode stay
/// by design), and the VIEW's exit then releases everything. The
/// differential runs over the whole chain: the process exits with the
/// terminal it launched with.
#[test]
fn the_detach_handoff_then_the_view_exit_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    // The handoff: the LEFT press (the kitty lane's same gesture).
    let mark = harness.mark();
    harness.write(b"\x1b[D");
    harness.wait_from(
        mark,
        b"Search sessions",
        "the agents view mounts behind the handoff",
    );
    // The view's exit: Esc with an empty query.
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

    harness.assert_terminal_state_restored("the detach handoff (chat -> view -> exit)");
}

/// Route: the force-quit watchdog from a wedged loop. The mock stalls
/// the `/list` request (answered by silence); the loop wedges in its
/// 10s bound; the Ctrl+C pair arms the 1.5s watchdog; the watchdog
/// fires the one best-effort restore and `exit(0)`s the process — the
/// terminal must come back whole from the watchdog's own byte order.
#[test]
fn the_force_quit_watchdog_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat").stall(&["list"]));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    // Wedge the loop in the stalled request, then arm the watchdog.
    harness.write(b"/list\r");
    harness.drain_until_quiet(4);
    harness.write(b"\x03");
    harness.write(b"\x03");
    harness.wait_from_start(
        ALT_SCREEN_LEAVE,
        "the force-quit restore left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the watchdog force-quit exited the process cleanly"
    );

    harness.assert_terminal_state_restored("the force-quit watchdog");
}

/// Route: the agents view's fresh entry (the `prime-agent` roster
/// surface on its own process), exited through Esc.
#[test]
fn the_agents_view_fresh_exit_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("view"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"Search sessions", "the agents view mounts");

    let mark = harness.mark();
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

    harness.assert_terminal_state_restored("the agents view's fresh exit");
}

/// Route: the agents-view error return behind a preserved handoff — the
/// roster link fails while the pane is already in TUI state (the chat's
/// teardown preserved the screen), so the surface's own release must
/// hand the terminal back before the error escapes (TS
/// `returnToAgentsView`'s `finally`).
#[test]
fn the_agents_view_roster_failure_behind_a_handoff_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    // Refuse every later connection: the handoff's view connect fails.
    harness.refuse_later_connections();

    let mark = harness.mark();
    harness.write(b"\x1b[D");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the failed handoff released the terminal",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(30));
    assert_eq!(exit, Some(0), "the child exited after the roster failure");

    harness.assert_terminal_state_restored("the agents view's roster failure behind a handoff");
}

/// Route: the picker's close (Esc) — the config selector's picker exit
/// through the close arm (restore, then a clean return).
#[test]
fn the_config_selector_esc_close_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("selector"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"Resource Configuration", "the selector mounts");

    let mark = harness.mark();
    harness.write(b"\x1b");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the selector's close left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(exit, Some(0), "the child exited cleanly through the close");

    harness.assert_terminal_state_restored("the config selector's Esc close");
}

/// Route: the picker's exit action (a remapped `app.clear` rides
/// ctrl+q): the selector's own exit arm runs the restore and exits the
/// process from inside the surface loop.
#[test]
fn the_config_selector_remapped_exit_action_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(
        ChildSpec::new("selector").env(CHILD_SELECTOR_FLAGS_ENV, "remap-exit"),
    );
    harness.answer_kitty_query();
    harness.wait_from_start(b"Resource Configuration", "the selector mounts");

    let mark = harness.mark();
    harness.write(b"\x11");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the selector's exit left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly through the exit action"
    );

    harness.assert_terminal_state_restored("the config selector's remapped exit action");
}

/// Route: the picker's error return — the toggle's persistence fails,
/// the surface loop unwinds through the one error restore, and the
/// error escapes to the caller with the terminal whole.
#[test]
fn the_config_selector_toggle_error_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(
        ChildSpec::new("selector").env(CHILD_SELECTOR_FLAGS_ENV, "fail-toggle"),
    );
    harness.answer_kitty_query();
    harness.wait_from_start(b"Resource Configuration", "the selector mounts");

    let mark = harness.mark();
    harness.write(b" ");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the error return left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(exit, Some(0), "the child exited after the toggle error");

    harness.assert_terminal_state_restored("the config selector's toggle error");
}

/// Route: the replay surface's clean exit (ctrl+c): the replay mount's
/// modes (raw, alt screen, enhanced keys) release through the replay
/// loop's own exit restore.
#[test]
fn the_replay_surface_clean_exit_restores_every_mode() {
    let _lock = harness_lock();
    let fixture = write_replay_fixture();
    let mut harness =
        DifferentialHarness::start(ChildSpec::new("replay").env(CHILD_FIXTURE_ENV, fixture));
    harness.answer_kitty_query();
    harness.wait_from_start(b"replay row 0", "the replay surface mounted");

    let mark = harness.mark();
    harness.write(b"\x03");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the replay exit left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(exit, Some(0), "the replay child exited cleanly");

    harness.assert_terminal_state_restored("the replay surface's clean exit");
}

/// Route: the panic unwind. The replay surface's panic driver (`--panic-
/// exit`'s port) panics mid-loop after the first paint; the unwind
/// crosses the surface's unwind guard, the one exit restore runs, and
/// the process dies with the terminal whole — the exact contract the
/// guard exists for.
#[test]
fn the_panic_unwind_restores_every_mode() {
    let _lock = harness_lock();
    let fixture = write_replay_fixture();
    let mut harness = DifferentialHarness::start(
        ChildSpec::new("replay")
            .env(CHILD_FIXTURE_ENV, fixture)
            .env(CHILD_REPLAY_FLAGS_ENV, "panic"),
    );
    // The panic fires at the FIRST draw — before the kitty probe's
    // support check can even write its query, the exit release stands
    // the probe down (`release_for_exit`'s contract: no query, no
    // answer, no push). The route does not answer or require the
    // query; the ledger's kitty assertions prove the protocol clean
    // either way (a push that raced in ahead of the panic is popped by
    // the drain; one that lands after is refused by the standdown).
    harness.wait_from_start(b"replay row 0", "the replay surface mounted");

    harness.wait_from_start(
        ALT_SCREEN_LEAVE,
        "the unwind guard's restore left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(101),
        "the panic child died with the unwind's exit code (got {exit:?})"
    );

    harness.assert_terminal_state_restored("the panic unwind");
}

/// Route: the pre-mount daemon refusal. The child's daemon connect
/// fails (the harness never starts a supervisor for it), the run errors
/// BEFORE any terminal state is armed, and the error path must restore
/// NOTHING — the caller's terminal (the harness's pty) must be exactly
/// as it was, with zero mode writes in the stream.
#[test]
fn the_pre_mount_daemon_refusal_arms_nothing() {
    let _lock = harness_lock();
    // A socket path nothing listens on: the connect retries its three
    // attempts and surfaces the error before any mount.
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("dead.sock");
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
    let mut child = spawn_child(&ChildSpec::new("chat"), &socket, &pty.slave);
    let mut reader = PtyReader::new(pty.master);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let mut buffer = [0u8; 8192];
        match reader.file.read(&mut buffer) {
            Ok(0) | Err(_) => {}
            Ok(n) => reader.output.extend_from_slice(&buffer[..n]),
        }
        if child.try_wait().ok().flatten().is_some() || Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let status = child.try_wait().ok().flatten();
    assert!(
        status.is_some(),
        "the refused child exited within the budget"
    );

    // Nothing armed: the stream carries no mode writes at all (the
    // error path must not tear down a terminal it never owned).
    let mut ledger = ModeLedger::default();
    ledger.scan(&reader.output);
    assert!(
        ledger.dec_modes.is_empty() && ledger.kitty_pushes == 0 && ledger.kitty_sets.is_empty(),
        "the pre-mount failure wrote terminal modes it never owned"
    );
    ledger.assert_delta_empty("the pre-mount daemon refusal");
    let after = Termios::capture(reader.file.as_raw_fd());
    assert!(
        before.delta_is_empty(&after),
        "the pre-mount failure changed the pty's termios: {} -> {}",
        before.describe(),
        after.describe()
    );
    let _ = child.kill();
    let _ = child.wait();
}

/// Whether this runner is attached to a controlling-terminal session
/// (the suspend cycle's stop/continue needs one; the other routes run
/// under any runner).
fn sigtstp_session_runner() -> bool {
    // SAFETY: tcgetpgrp only queries the fd's foreground process group.
    let foreground = unsafe { libc::tcgetpgrp(0) };
    foreground >= 0
}

/// Whether this environment's SIGTSTP actually stops a process: some
/// sandboxes (the fleet's supervision wrapper) neutralize job-control
/// stops — a group `kill -TSTP` returns success and the process keeps
/// running. The suspend route needs a real stop; a probe child decides
/// whether the route runs or skips loudly, the same contract the
/// cursor-visibility e2e's session gate holds.
fn sigtstp_stops_processes() -> bool {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg("kill -TSTP 0; sleep 5")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // The probe child gets its OWN process group: `kill -TSTP 0`
        // targets the caller's group, and a probe sharing the test
        // runner's group would stop the runner itself the moment job
        // control works — the probe must only ever stop the probe.
        .process_group(0)
        .spawn()
        .expect("the stop-capability probe spawns");
    let deadline = Instant::now() + Duration::from_millis(1_500);
    let stops = loop {
        match waitpid(
            Pid::from_raw(child.id() as i32),
            Some(WaitPidFlag::WNOHANG | WaitPidFlag::WUNTRACED),
        ) {
            Ok(WaitStatus::Stopped(..)) => break true,
            Ok(WaitStatus::Exited(..) | WaitStatus::Signaled(..)) => break false,
            _ if Instant::now() > deadline => break false,
            _ => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    if !stops {
        eprintln!(
            "skipping the suspend differential: this environment's SIGTSTP \
             does not stop a process (the fleet's suspend e2e gate holds the \
             same contract)"
        );
    }
    stops
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

/// Route: the suspend cycle (ctrl+z). The shell gets the terminal
/// MID-PROCESS — the release tail runs and the process group stops — so
/// the differential asserts twice: the ledger at the stop point (the
/// state the shell sees) must be empty, and the resumed session's
/// final exit must land in the same empty state. The resume's re-arm
/// (mouse, kitty, raw, alt screen) rides the same balance as the mount.
#[test]
fn the_suspend_cycle_hands_a_whole_terminal_to_the_shell_and_back() {
    if !sigtstp_session_runner() || !sigtstp_stops_processes() {
        return;
    }
    match nix::unistd::setsid() {
        Ok(_) => {}
        Err(error) => panic!("the harness could not start a fresh session: {error}"),
    }
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");
    let child_id = harness.child.id();

    // The suspend: the release tail leaves the alt screen and shows
    // the cursor for the shell, then SIGTSTP stops the group.
    let mark = harness.mark();
    harness.write(b"\x1a");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the suspend release left the alt screen",
    );
    wait_for_stopped(child_id, "the suspend cycle stopped the group");

    // The mid-process differential: the shell's terminal equals the
    // pre-launch state while the process is stopped.
    harness.drain_until_quiet(4);
    let stopped = harness.output();
    let mut ledger = ModeLedger::default();
    ledger.scan(&stopped);
    ledger.assert_delta_empty("the suspend cycle's stop point");
    let at_stop = Termios::capture(harness.master.file.as_raw_fd());
    assert!(
        harness.before.delta_is_empty(&at_stop),
        "the suspend left the pty's termios changed: {} -> {}",
        harness.before.describe(),
        at_stop.describe()
    );

    // The resume re-arms the surface (SIGCONT), then the parity exit.
    kill(Pid::from_raw(child_id as i32), Signal::SIGCONT).expect("SIGCONT");
    let resume_mark = harness.mark();
    harness.wait_from(
        resume_mark,
        b"\x1b[?1002h",
        "the resume re-armed mouse tracking",
    );
    harness.drain_until_quiet(6);
    let mark = harness.mark();
    harness.write(b"/exit\r");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the resumed session exited through the parity exit",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly after the suspend cycle"
    );

    harness.assert_terminal_state_restored("the suspend cycle's final exit");
}

/// Route: the late kitty answer. The probe's query goes unanswered
/// through the mount (the support check settles no inside its window);
/// the exit starts (`release_for_exit` first, then the drain); the
/// answer bytes land INSIDE the exit window. The contract this route
/// nets at the stream level: whatever path takes the answer — the
/// probe standing down at the exit release, or the settled-no window
/// already closed — the stream must carry NO kitty flags push after
/// the exit began: the shell keeps a legacy-encoding terminal, not
/// CSI-u soup. The kitty-exit-leak lane owns the mode's own fix and
/// the standdown's unit test; this route is the differential's net
/// over the same window for every OTHER mode too.
#[test]
fn the_late_kitty_answer_inside_the_exit_window_is_stood_down() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(ChildSpec::new("chat"));
    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    // The exit: `/exit`, then the answer rides the drain window (the
    // write lands right after the drain's modifyOtherKeys reset — the
    // first teardown byte after the probe standdown).
    let mark = harness.mark();
    harness.write(b"/exit\r");
    harness.wait_from(mark, b"\x1b[>4;0m", "the exit's first teardown byte");
    harness.try_write(KITTY_ANSWER);
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the parity exit left the alt screen",
    );
    let exit = harness.wait_child_exit(Duration::from_secs(20));
    assert_eq!(
        exit,
        Some(0),
        "the child exited cleanly through the parity exit"
    );

    // The late answer must not have re-armed the kitty flags: the
    // stream carries no flags push at all (the answer was stood down).
    let stream = harness.output();
    assert!(
        find_subsequence(&stream, KITTY_FLAGS_PUSH).is_none(),
        "the late answer pushed the kitty flags after the exit standdown"
    );
    harness.assert_terminal_state_restored("the late kitty answer inside the exit window");
}
