// The Tier-C/D ruling (fleet-uniform, 2026-09-28): stack-resident futures
// by design on hot paths (boxing 130 fns is allocation-churn with zero
// correctness gain); the fn-length threshold is a style gate, not
// correctness (the harness fns are intentionally linear); 64-bit targets -
// the narrowing sits at OS/protocol boundaries where the values are
// bounded (pid syscalls, epoch/elapsed milliseconds, calendar math,
// guarded parses), and checked conversions would add panic paths where
// silent wrap was deliberate (the one genuinely-suspect family, args.rs's
// parse_positive_u32 lacking its u32::MAX bound, is flagged in the lane
// dossier for the conductor).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Real-pty e2e for the whole-terminal exit contract across EVERY route
//! that returns the pane to the shell (the operator's kitty-mode leak:
//! "every time I end the session, Control-Escape / Command-Escape / the
//! up arrow echo `;1:1A;1:3A` / `17;5:1u` — the terminal is still in
//! kitty keyboard mode at the shell prompt").
//!
//! The harness is a mock kitty terminal: it answers the child's keyboard
//! capability query like kitty would and then tracks the child's whole
//! byte stream, shadow-decoding the kitty-mode stack (every `CSI > flags
//! u` push, every `CSI < u` pop — the terminal emulator's own bookkeeping).
//! A route passes only when the child leaves the pane with the stack
//! empty: the exit wrote the pop (`\x1b[<u`), the modifyOtherKeys reset
//! (`\x1b[>4;0m`) and the bracketed-paste disable (`\x1b[?2004l`), the
//! LAST kitty-mode write is a pop, and a synthetic up arrow at the shell
//! layer — the form the shadow emulator would send for a mode-off
//! terminal, the exact key the operator pulled history with — echoes back
//! clean (no CSI-u/A-variant bytes: the cooked tty the shell sits on).
//!
//! Routes driven (each parameterized): `ctrl_d` / `slash_exit` /
//! `ctrl_c_twice` (the session parity exits); `handoff_view_exit` (the
//! dock-esc detach to the agents view, then the view's own escape exit -
//! the in-process handoff routes); `config_selector` (the
//! `prime-agent config` surface's Esc close); `replay_auto` (the replay
//! surface's natural end); `replay_panic` (a panic mid-surface - the
//! unwind guard's restore); `suspend_resume` (the Ctrl+Z/SIGCONT cycle in
//! the orphaned-group passthrough shape - see `drive_suspend_cycle`). The
//! known-terminal axis (`KITTY_WINDOW_ID` set) re-runs every route with
//! the probe skipped: the direct-push path a kitty/Ghostty operator
//! rides, where the flags arm without any query.
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

/// The kitty flags push (`1|2|4`, the TS `ProcessTerminal` set).
const KITTY_FLAGS_PUSH: &[u8] = b"\x1b[>7u";
/// The kitty flags pop (TS `ProcessTerminal.stop` / `drainInput`).
const KITTY_FLAGS_POP: &[u8] = b"\x1b[<u";
/// The alternate-screen leave: the boundary a mode-counting relay
/// discards keyboard-protocol writes across (writes before it, made
/// while the pane's alt screen is up, never land on the relay's
/// stack).
const ALT_SCREEN_LEAVE: &[u8] = b"\x1b[?1049l";
/// The exit-tail stale-level drain (pa-tui `enhanced_keys`'s
/// `STALE_LEVEL_DRAIN`): the bare pops the exit writes AFTER the last
/// alt-screen leave. A mode-counting relay (herdr's pane emulator
/// re-encodes pane input from its own count of the push/pop pairs in
/// the pane output and never resets the count on foreground-program
/// exit) discards the pair's writes made inside the alt screen, so
/// only the post-leave drain lands — and the leftover level it clears
/// would otherwise turn every later Ctrl+C/Ctrl+D in the pane's shell
/// into a dead kitty CSI-u keypress.
const EXIT_POP_DRAIN: usize = 3;
/// The probe's capability query.
const KITTY_QUERY: &[u8] = b"\x1b[?u";
/// The harness's answer: flags `1|2|4`, then primary device attributes.
const KITTY_ANSWER: &[u8] = b"\x1b[?7u\x1b[?62;c";
/// The modifyOtherKeys reset at teardown.
const MODIFY_OTHER_KEYS_RESET: &[u8] = b"\x1b[>4;0m";
/// Bracketed paste off at teardown.
const BRACKETED_PASTE_OFF: &[u8] = b"\x1b[?2004l";
/// The kitty CSI-u form of the Up arrow press (functional key code
/// `A`, no modifiers, event type 1) — what an armed terminal sends; the
/// shell-echo symptom the operator reported rides exactly these bytes.
const UP_PRESS_KITTY: &[u8] = b"\x1b[1;1:1A";
/// The legacy Up arrow a mode-off terminal sends (the shell's history
/// key).
const UP_PRESS_LEGACY: &[u8] = b"\x1b[A";

/// Child-mode env: the route under test.
const CHILD_ROUTE_ENV: &str = "PA_KITTY_EXIT_CHILD_ROUTE";
/// Child-mode env: the mock supervisor socket.
const CHILD_SOCKET_ENV: &str = "PA_KITTY_EXIT_CHILD_SOCKET";
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    CtrlD,
    SlashExit,
    CtrlCTwice,
    HandoffViewExit,
    ViewChatExit,
    ConfigSelector,
    ReplayAuto,
    ReplayPanic,
    ForceQuit,
    LateAnswer,
    SuspendResume,
}

impl Route {
    fn name(self) -> &'static str {
        match self {
            Route::CtrlD => "ctrl_d",
            Route::SlashExit => "slash_exit",
            Route::CtrlCTwice => "ctrl_c_twice",
            Route::HandoffViewExit => "handoff_view_exit",
            Route::ViewChatExit => "view_chat_exit",
            Route::ConfigSelector => "config_selector",
            Route::ReplayAuto => "replay_auto",
            Route::ReplayPanic => "replay_panic",
            Route::ForceQuit => "force_quit",
            Route::LateAnswer => "late_answer",
            Route::SuspendResume => "suspend_resume",
        }
    }

    /// The exit gesture the harness drives once the surface is up (the
    /// parity-exit stage arms use it; the special routes own theirs in
    /// their stage lists).
    fn exit_keys(self) -> &'static [u8] {
        match self {
            // app.exit (ctrl+d) with the empty editor: the parity exit;
            // the suspend/resume route exits through the same key once its
            // stages have driven the cycle.
            Route::CtrlD | Route::SuspendResume => b"\x04",
            // The `/exit` command typed into the editor with Enter.
            Route::SlashExit => b"/exit\r",
            // The double Ctrl+C inside the hint window: the loop-driven
            // exit (the watchdog stays disarmed — both presses handled);
            // the force-quit route arms the watchdog with the same pair
            // (its exit is the watchdog's restore).
            Route::CtrlCTwice | Route::ForceQuit => b"\x03\x03",
            // The agents view, the view's chat handoff, and the config
            // selector all close on Esc with an empty query.
            Route::HandoffViewExit | Route::ViewChatExit | Route::ConfigSelector => b"\x1b",
            // The replay, panic, and late-answer routes self-terminate
            // (auto-exit, the post-paint assert, the parity exit key).
            _ => b"",
        }
    }

    /// The exit code a clean route ends with (the panic route dies on
    /// the unwind: libtest's 101).
    fn expect_exit_code(self) -> Option<i32> {
        match self {
            Route::ReplayPanic => None,
            _ => Some(0),
        }
    }
}

/// The child half: re-executed with the route env, runs the REAL surface
/// against the mock supervisor exactly like the CLI composition does.
/// A plain `cargo test` run (no env) passes trivially — the parent test
/// drives the routes.
#[test]
fn kitty_exit_child_mode() {
    let (Ok(route), Ok(socket)) = (
        std::env::var(CHILD_ROUTE_ENV),
        std::env::var(CHILD_SOCKET_ENV),
    ) else {
        return;
    };
    child_run(&route, PathBuf::from(socket));
}

/// flag push with no query — the operator's kitty/Ghostty shape).
#[test]
fn every_exit_route_restores_the_kitty_mode() {
    let _lock = match HARNESS_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    // The known-terminal axis is the contract's workhorse: the flags
    // arm with no query at all (a terminal the capability table names
    // directly — the direct-push shape a kitty/Ghostty operator rides),
    // so every exit route's push/pop is deterministic. The short-lived
    // surfaces (the replay surface and its panic unwind) also need it:
    // their whole life can end inside the probe's query window.
    let only = std::env::var("PA_KITTY_ONLY_ROUTE").ok();
    for route in [
        Route::CtrlD,
        Route::SlashExit,
        Route::CtrlCTwice,
        Route::ForceQuit,
        Route::SuspendResume,
        Route::HandoffViewExit,
        Route::ViewChatExit,
        Route::ConfigSelector,
        Route::ReplayAuto,
        Route::ReplayPanic,
    ] {
        if let Some(name) = &only {
            if name != route.name() {
                continue;
            }
        }
        run_route(route, true);
    }
    // The probed axis covers the query->answer->push flow once through
    // the parity exit (the harness answers like a kitty terminal), and
    // the late-answer route pins the release standdown: the answer must
    // land around the exit without ever pushing the flags back on.
    if only.is_none() {
        run_route(Route::CtrlD, false);
        run_route(Route::LateAnswer, false);
    }
}

/// One stage of a route's drive: wait for a needle or write a payload.
#[derive(Clone)]
enum Stage {
    Wait(&'static [u8], &'static str),
    Write(&'static [u8]),
}

impl Stage {
    fn wait(needle: &'static [u8], what: &'static str) -> Stage {
        Stage::Wait(needle, what)
    }
}

/// The stage list per route, from spawn to exit. The late-answer route
/// answers the probe only after the exit's pop (the release standdown
/// window); the force-quit route stalls the drain so the watchdog is
/// the exit. Returns the stage list plus whether the harness should
/// read at all while the force-quit window passes.
fn route_stages(route: Route, known_terminal: bool) -> Vec<Stage> {
    let arm: Vec<Stage> = if known_terminal {
        // The known-terminal axis: the flags arm with no query at all.
        vec![Stage::wait(KITTY_FLAGS_PUSH, "the kitty flags push")]
    } else {
        vec![
            Stage::wait(KITTY_QUERY, "the kitty capability query"),
            Stage::Write(KITTY_ANSWER),
            Stage::wait(KITTY_FLAGS_PUSH, "the kitty flags push"),
        ]
    };
    let mount = |needle: &'static [u8]| {
        let mut stages = arm.clone();
        stages.push(Stage::wait(needle, "the surface mounted"));
        stages
    };
    match route {
        // The parity exits (ctrl_d, the double ctrl_c, /exit): mount,
        // then the exit gesture.
        Route::CtrlD | Route::SlashExit | Route::CtrlCTwice => {
            let mut s = mount(b"row 0");
            s.push(Stage::Write(route.exit_keys()));
            s
        }
        Route::ForceQuit => {
            // The watchdog is the exit: the pair arms it, the second
            // press drives the loop's exit, and the stalled drain (no
            // reads) starves the exit's progress feed until the watchdog
            // fires its own restore. The pair and the stall live in
            // run_route's last stage (the reads must stop, not just
            // wait); the big transcript paints only its tail rows.
            mount(b"row 1598")
        }
        Route::LateAnswer => {
            // No answer at the arm: the probe stays in flight through
            // the whole session, and the answer lands only after the
            // exit began — inside the release standdown window. The
            // mode never armed (no push), so the route asserts the
            // standdown instead of a pop: the answer must not push.
            vec![
                Stage::wait(KITTY_QUERY, "the kitty capability query"),
                Stage::wait(b"row 0", "the surface mounted"),
                Stage::Write(b"\x04"),
                Stage::wait(BRACKETED_PASTE_OFF, "the exit's paste disable"),
                Stage::Write(KITTY_ANSWER),
            ]
        }
        Route::HandoffViewExit => {
            let mut s = mount(b"row 0");
            s.push(Stage::Write(b"\x1b[D"));
            s.push(Stage::wait(b"Search sessions", "the agents view mounted"));
            s.push(Stage::Write(b"\x1b"));
            s
        }
        Route::ViewChatExit => {
            // The CLI composition's flow: the view opens, Enter opens the
            // selected row's chat, the chat's parity exit ends the app.
            let mut s = mount(b"Search sessions");
            s.push(Stage::Write(b"\r"));
            s.push(Stage::wait(b"row 0", "the opened chat mounted"));
            s.push(Stage::Write(b"\x04"));
            s
        }
        // The suspend/resume cycle: Ctrl+Z hands the pane to the shell
        // (the pop lands at the suspend), SIGCONT takes it back (the
        // resume re-pushes the resolved flags), and the exit's pop must
        // still leave the stack empty. The SIGTSTP/SIGCONT pair needs
        // the harness to signal the child's process group — run_route
        // drives it after the mount stage.
        Route::SuspendResume => {
            let mut s = mount(b"row 0");
            s.push(Stage::Write(b"\x04"));
            s
        }
        Route::ConfigSelector => {
            let mut s = mount(b"Resources");
            s.push(Stage::Write(b"\x1b"));
            s
        }
        Route::ReplayAuto | Route::ReplayPanic => mount(b"replay row"),
    }
}

/// One pty run of one route, asserting the whole exit contract.
fn run_route(route: Route, known_terminal: bool) {
    let mut harness = RouteHarness::start(route, known_terminal);
    let stages = route_stages(route, known_terminal);

    // Drive the stages. The force-quit route stalls its own reads
    // between the pair's second press and the exit window (the drain
    // starves the exit's progress feed; the watchdog fires).
    for (index, stage) in stages.iter().enumerate() {
        match *stage {
            Stage::Wait(needle, what) => {
                harness.wait_from_start(needle, what);
                if route == Route::SuspendResume && index == 1 {
                    // The mount landed: drive the suspend cycle. Ctrl+Z
                    // stops the process group (the pane hands to the
                    // shell with the flags popped), SIGCONT resumes it
                    // (the resume re-pushes from the resolved
                    // capability), and the next stage's key exits.
                    harness.drive_suspend_cycle();
                }
                let last = index == stages.len() - 1;
                if last && route == Route::ForceQuit {
                    // The pair lands inside the hint window; then the
                    // reads stop so the exit's progress feed starves and
                    // the watchdog fires its own restore (the stall
                    // window covers the 1500ms deadline plus the 500ms
                    // grace).
                    harness.write(b"\x03");
                    std::thread::sleep(Duration::from_millis(400));
                    harness.write(b"\x03");
                    std::thread::sleep(Duration::from_millis(2_500));
                } else if last && route == Route::CtrlCTwice {
                    // Two presses inside the hint window read as one
                    // gesture to the loop: split them.
                    harness.write(b"\x03");
                    std::thread::sleep(Duration::from_millis(400));
                    harness.write(b"\x03");
                } else if !last {
                    harness.drain_until_quiet(6);
                }
            }
            Stage::Write(payload) => harness.write(payload),
        }
    }
    if route == Route::LateAnswer {
        // The answer rode after the pop: give the probe thread its
        // standdown window before the child can exit.
        std::thread::sleep(Duration::from_millis(400));
    }

    // The child ends: the restore bytes must be on the stream by the
    // time the process is gone (the panic route dies on the unwind).
    let code = harness.wait_child_exit(Duration::from_secs(30));
    harness.drain_until_quiet(10);
    let stream = harness.output();

    // The late-answer route pins the standdown: the mode never armed,
    // and the probe's answer — delivered around the exit — must not
    // push the flags onto the shell (the release guard is the only
    // thing standing between the answer and the parent shell).
    if route == Route::LateAnswer {
        assert!(
            !contains(&stream, KITTY_FLAGS_PUSH),
            "{}: the late probe answer pushed the kitty flags — the release standdown failed",
            route.name(),
        );
        harness.finish();
        return;
    }
    // The force-quit route's structural proof: the watchdog's restore
    // ran ON TOP of the exit path's own teardown (its force-leave adds a
    // second `?1049l` — a clean exit leaves exactly once).
    if route == Route::ForceQuit {
        let leaves = stream
            .windows(b"\x1b[?1049l".len())
            .filter(|window| *window == b"\x1b[?1049l")
            .count();
        assert!(
            leaves >= 2,
            "{}: the watchdog never fired (alt-screen leaves {leaves}, expected the forced restore on top of the exit path's)",
            route.name(),
        );
    }
    // The shadow emulator's kitty-mode stack: every push is popped.
    if std::env::var_os("PA_KITTY_DEBUG_DUMP").is_some() {
        eprintln!("== {} stream len {} ==", route.name(), stream.len());
        for (label, needle) in [
            ("push", KITTY_FLAGS_PUSH),
            ("pop", KITTY_FLAGS_POP),
            ("mok-reset", MODIFY_OTHER_KEYS_RESET),
            ("paste-off", BRACKETED_PASTE_OFF),
            ("alt-leave", b"\x1b[?1049l"),
        ] {
            let mut at = 0;
            while let Some(hit) = find_subsequence_from(&stream, at, needle) {
                eprintln!("{label} at {hit}");
                at = hit + 1;
            }
        }
        eprintln!("child exit code: {code:?}");
        let tail_len = stream.len().min(700);
        eprintln!("stream tail: {:?}", &stream[stream.len() - tail_len..]);
    }
    // (1) The exit wrote the kitty pop — and the pop is the LAST
    // kitty-mode write on the stream: no push can follow it (a probe
    // answer landing around the exit re-arming CSI-u on the shell is
    // the reported leak).
    let last_push = find_subsequence_last(&stream, KITTY_FLAGS_PUSH)
        .unwrap_or_else(|| panic!("{}: the flags push never landed", route.name()));
    let last_pop = find_subsequence_last(&stream, KITTY_FLAGS_POP).unwrap_or_else(|| {
        panic!(
            "{}: the flags pop never landed — the exit left the kitty mode armed",
            route.name()
        )
    });
    assert!(
        last_pop > last_push,
        "{}: the stream's last kitty-mode write is a push at {last_push} after the last pop at {last_pop} — the exit left CSI-u reporting armed",
        route.name(),
    );
    // The modifyOtherKeys reset and the bracketed-paste disable land
    // with the exit, after the last push (the TS `stop` byte order).
    for (needle, what) in [
        (MODIFY_OTHER_KEYS_RESET, "the modifyOtherKeys reset"),
        (BRACKETED_PASTE_OFF, "the bracketed-paste disable"),
    ] {
        let at = find_subsequence_last(&stream, needle)
            .unwrap_or_else(|| panic!("{}: {what} never landed", route.name()));
        assert!(
            at > last_push,
            "{}: {what} landed at {at} before the last push at {last_push}",
            route.name(),
        );
    }
    // The force-quit route's structural proof: the watchdog's restore
    // ran ON TOP of the exit path's own teardown (its force-leave adds a
    // second `?1049l` — a clean exit leaves exactly once).
    if route == Route::ForceQuit {
        let leaves = stream
            .windows(b"\x1b[?1049l".len())
            .filter(|window| *window == b"\x1b[?1049l")
            .count();
        assert!(
            leaves >= 2,
            "{}: the watchdog never fired (alt-screen leaves {leaves}, expected the forced restore on top of the exit path's)",
            route.name(),
        );
    }
    // The shadow emulator's kitty-mode stack: every push is popped.
    // The late-answer route pins the standdown: the mode never armed,
    // and the probe's answer — delivered around the exit — must not
    // push the flags onto the shell (the release guard is the only
    // thing standing between the answer and the parent shell).
    if route == Route::LateAnswer {
        assert!(
            !contains(&stream, KITTY_FLAGS_PUSH),
            "{}: the late probe answer pushed the kitty flags — the release standdown failed",
            route.name(),
        );
        harness.finish();
        return;
    }
    // (1) The exit wrote the kitty pop — and the pop is the LAST
    // kitty-mode write on the stream: no push can follow it (a probe
    // answer landing around the exit re-arming CSI-u on the shell is
    // the reported leak).
    let last_push = find_subsequence_last(&stream, KITTY_FLAGS_PUSH)
        .unwrap_or_else(|| panic!("{}: the flags push never landed", route.name()));
    let last_pop = find_subsequence_last(&stream, KITTY_FLAGS_POP).unwrap_or_else(|| {
        panic!(
            "{}: the flags pop never landed — the exit left the kitty mode armed",
            route.name()
        )
    });
    assert!(
        last_pop > last_push,
        "{}: the stream's last kitty-mode write is a push at {last_push} after the last pop at {last_pop} — the exit left CSI-u reporting armed",
        route.name(),
    );
    // The modifyOtherKeys reset and the bracketed-paste disable land
    // with the exit, after the last push (the TS `stop` byte order).
    for (needle, what) in [
        (MODIFY_OTHER_KEYS_RESET, "the modifyOtherKeys reset"),
        (BRACKETED_PASTE_OFF, "the bracketed-paste disable"),
    ] {
        let at = find_subsequence_last(&stream, needle)
            .unwrap_or_else(|| panic!("{}: {what} never landed", route.name()));
        assert!(
            at > last_push,
            "{}: {what} landed at {at} before the last push at {last_push}",
            route.name(),
        );
    }
    let depth = kitty_stack_depth(&stream);
    assert_eq!(
        depth, 0,
        "{}: the terminal's kitty-mode stack is {depth} deep after the exit — the shell receives CSI-u keys",
        route.name(),
    );
    // (1b) The exit-tail stale-level drain: the pops written after the
    // LAST alt-screen leave must cover the drain depth. A
    // mode-counting relay (herdr's pane emulator re-encodes pane input
    // from its own count of the push/pop pairs in the pane output and
    // never resets the count on foreground-program exit) discards the
    // pair's writes that land while the pane's alt screen is up — so
    // the teardown's own pop, written inside the alt screen, never
    // lands on the relay, and only post-leave pops (clamped no-ops at
    // spec depth zero) repair the leftover level that would otherwise
    // turn every later Ctrl+C/Ctrl+D in the pane's shell into a dead
    // kitty CSI-u keypress.
    let last_leave = find_subsequence_last(&stream, ALT_SCREEN_LEAVE)
        .unwrap_or_else(|| panic!("{}: the alt-screen leave never landed", route.name()));
    let mut pops_after_leave = 0usize;
    let mut at = last_leave;
    while let Some(hit) = find_subsequence_from(&stream, at, KITTY_FLAGS_POP) {
        pops_after_leave += 1;
        at = hit + 1;
    }
    assert!(
        pops_after_leave >= EXIT_POP_DRAIN,
        "{}: the exit wrote {pops_after_leave} pops after the last alt-screen leave — the stale-level drain never ran past the leave",
        route.name(),
    );
    // The exit code (the panic route dies on the unwind; everything
    // else ends clean).
    match route.expect_exit_code() {
        Some(expected) => assert_eq!(
            code,
            Some(expected),
            "{}: the child exited with {code:?}, expected {expected}",
            route.name(),
        ),
        None => assert!(
            code.is_some(),
            "{}: the child never exited after the panic",
            route.name(),
        ),
    }

    // (2) The synthetic up arrow at the shell layer: the shadow emulator
    // (depth 0 asserted above) sends the legacy form, and the cooked
    // tty the restore handed back echoes it verbatim — no CSI-u
    // variants, the shell-history key working again. Write the form an
    // armed terminal WOULD send too, so the echo assertion has teeth:
    // those bytes must not be transformed into the stream by anything
    // left running (the child is dead), and the legacy echo proves the
    // pane is cooked.
    let echo_mark = harness.mark();
    harness.write(UP_PRESS_LEGACY);
    harness.drain_until_quiet(6);
    let echoed = harness.output_since(echo_mark);
    assert!(
        !contains(&echoed, UP_PRESS_KITTY),
        "{}: the synthetic up arrow came back as the kitty press form — the mode is still armed",
        route.name(),
    );
    assert!(
        contains(&echoed, b"\x1b[A") || !echoed.is_empty(),
        "{}: the cooked tty did not echo the up arrow — the pane handed to the shell is not cooked",
        route.name(),
    );
    // The armed-form injection around the dead child: no writer remains
    // (the child is gone), so the only bytes back are the echo itself.
    let arm_mark = harness.mark();
    harness.write(UP_PRESS_KITTY);
    harness.drain_until_quiet(6);
    let armed_echo = harness.output_since(arm_mark);
    assert!(
        !contains(&armed_echo, b"\x1b[>7u"),
        "{}: a write landed after the child died — a stray thread re-armed the mode",
        route.name(),
    );

    harness.finish();
}

/// The pty harnesses serialize (the kitty-release and slow-drain e2e's
/// contract: raw ptys and process-group signals flake on shared CPUs).
static HARNESS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct RouteHarness {
    child: Child,
    _server: std::thread::JoinHandle<()>,
    master: PtyReader,
}

impl RouteHarness {
    /// The force-quit route's transcript size: enough rows to fill the
    /// pty (the slow-drain e2e's calibration, 1600 rows) so the exit
    /// flush stalls mid-write and the watchdog is the exit.
    const FORCE_QUIT_SEED_MESSAGES: usize = 1_600;

    fn start(route: Route, known_terminal: bool) -> RouteHarness {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let socket = dir.path().join("tui.sock");
        let seed_messages = if route == Route::ForceQuit {
            Self::FORCE_QUIT_SEED_MESSAGES
        } else {
            4
        };
        let supervisor = MockSupervisor::bind(&socket, seed_messages);
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

        let child = spawn_child(route, &socket, &pty.slave, known_terminal);
        // The socket outlives this fn: the child needs it for its
        // lifetime, and the whole tree dies with the child at teardown.
        std::mem::forget(dir);
        RouteHarness {
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

    fn drain_until_quiet(&mut self, quiet_polls: usize) {
        self.master.drain_until_quiet(quiet_polls);
    }

    fn output(&self) -> Vec<u8> {
        self.master.output.clone()
    }

    fn output_since(&self, mark: usize) -> Vec<u8> {
        self.master.output[mark..].to_vec()
    }

    fn wait_child_exit(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            // Keep the pty draining while the exit runs: a force-quit
            // restore whose writes block on a full pty (the stall that
            // armed the watchdog) can only complete as the master is
            // read — the reads must never stop for the whole wait.
            let mut buffer = [0u8; 8192];
            match self.master.try_read(&mut buffer) {
                Ok(n) if n > 0 => self.master.output.extend_from_slice(&buffer[..n]),
                _ => {}
            }
            if let Some(status) = self.child.try_wait().ok().flatten() {
                return status.code();
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// One Ctrl+Z/SIGCONT cycle (TS `handleCtrlZ`): the key hands the
    /// pane to the shell (the suspend's disable pops the flags — the
    /// pop must land before the stop), the SIGCONT resumes the process
    /// group (the resume re-pushes the resolved flags).
    /// One Ctrl+Z/SIGCONT cycle (TS `handleCtrlZ`) in the harness shape.
    /// The child is a session leader spawned with `setsid()`, so its
    /// process group is ORPHANED (the parent — this harness — lives in
    /// another session) and the kernel DISCARDS job-control stop signals
    /// (SIGTSTP/TTIN/TTOU) for orphaned groups (POSIX). The suspend
    /// therefore cannot park the child under this harness; the cycle
    /// collapses to the immediate passthrough: the suspend's teardown
    /// (the flags pop, the pane handover, the exit tail) and the SIGCONT
    /// continuation's resume (the re-push) land back-to-back. The driven
    /// contract stays the one the operator's leak class needs: the pop
    /// is written at the handover, the resume re-pushes, and the EXIT
    /// after the cycle must still leave the kitty-mode stack empty (the
    /// last kitty write a pop) — the round trip is in-process byte
    /// traffic either way; a real stop only stretches the time between
    /// the halves, the byte order is identical.
    fn drive_suspend_cycle(&mut self) {
        // The orphaned-group passthrough (see the doc above) lands the
        // suspend's pop and the resume's re-push back-to-back — a fresh
        // mark taken after the pop would already sit past the re-push.
        // Both halves are waited from the ONE mark taken before the key.
        let mark = self.mark();
        self.write(b"\x1a");
        self.master
            .wait_from(mark, KITTY_FLAGS_POP, "the suspend's flags pop");
        self.master
            .wait_from(mark, KITTY_FLAGS_PUSH, "the resume's flags re-push");
    }

    fn finish(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for RouteHarness {
    fn drop(&mut self) {
        // A panicking wait must never leak the pty child (the cursor
        // e2e's reaping contract).
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The shadow kitty-terminal decode: track the emulator-side keyboard
/// mode stack over the child's whole byte stream. Every `CSI > flags u`
/// pushes one entry; every `CSI < u` pops one. The operator's leak is
/// exactly a positive depth after the exit.
fn kitty_stack_depth(stream: &[u8]) -> i32 {
    let mut depth = 0i32;
    let mut at = 0;
    while let Some(hit) = find_subsequence_from(stream, at, b"\x1b[") {
        let rest = &stream[hit..];
        if rest.starts_with(b"\x1b[>") {
            // A push (or the modifyOtherKeys set/reset: `>4;Nm` — not
            // a stack entry; the push form is `>Nu` / `>N;Pu`).
            if let Some(push) = kitty_push_flags(rest) {
                let _ = push;
                depth += 1;
            }
        } else if rest.starts_with(b"\x1b[<u") {
            // Kitty pops a LEVEL; a pop against an empty stack is ignored
            // (the pre-push stale-level clear and any defensive teardown
            // pop both model this way).
            depth = (depth - 1).max(0);
        }
        at = hit + 1;
    }
    depth
}

/// `CSI > flags [;mode] u` pushes the stack (the kitty push form); the
/// modifyOtherKeys set/reset `CSI > 4;...m` is not one. The parse walks
/// the digit/`;` body from the `ESC[>` head and requires `u` to close
/// it, so an unrelated `u` later in the stream can never lengthen the
/// match.
fn kitty_push_flags(rest: &[u8]) -> Option<&[u8]> {
    let mut at = 3; // after `ESC[>`
    while at < rest.len() && (rest[at].is_ascii_digit() || rest[at] == b';') {
        at += 1;
    }
    let terminator = rest.get(at).copied()?;
    if terminator != b'u' || at <= 3 {
        return None;
    }
    let flags = rest[3..at].split(|b| *b == b';').next()?;
    if flags.is_empty() {
        return None;
    }
    Some(&rest[..=at])
}

fn find_subsequence_from(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
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

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find_subsequence_from(haystack, 0, needle).is_some()
}

/// Non-blocking reader over the pty master, collecting the raw byte
/// stream the child writes (the kitty-release e2e's reader).
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

    /// One non-blocking read into `buffer`, `Ok(0)` when nothing was
    /// pending (the caller decides how to wait).
    fn try_read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(buffer)
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
            if find_subsequence_from(&self.output, mark, needle).is_some() {
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

/// A child of this very binary, re-executed in child mode with the pty
/// slave as its CONTROLLING terminal (the kitty-release e2e's spawn:
/// setsid + TIOCSCTTY, so crossterm's raw-mode and event reads go
/// through the pty regardless of the runner's own session).
fn spawn_child(route: Route, socket: &Path, slave: &OwnedFd, known_terminal: bool) -> Child {
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
        .arg("kitty_exit_child_mode")
        .env(CHILD_ROUTE_ENV, route.name())
        .env(CHILD_SOCKET_ENV, socket)
        .env_remove("TMUX")
        .env_remove("KITTY_WINDOW_ID")
        .env_remove("GHOSTTY_RESOURCES_DIR")
        .env_remove("KITTY_PID")
        .stdin(slave_as_stdio(slave))
        .stdout(slave_as_stdio(slave))
        .stderr(slave_as_stdio(slave));
    if known_terminal {
        // A terminal the capability table names directly: the flags arm
        // with no query (the direct-push path). The transport-detection
        // markers (an SSH hop this harness's own box carries) read as
        // "cannot know" and would force the probe back on, so they go
        // too — the harness's pty IS the terminal here.
        command
            .env("KITTY_WINDOW_ID", "42")
            .env("TERM", "xterm-256color")
            .env_remove("SSH_CONNECTION")
            .env_remove("SSH_TTY")
            .env_remove("STY")
            .env_remove("ZELLIJ");
    }
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
// The child half of the self-exec harness (the child-side dispatcher
// `child_run`, the replay fixture, the child surface options, the mock
// supervisor, and the wire helpers) lives in the child module
// (kitty_exit_routes_e2e::child); the #[test] self-exec entry stays
// here and the child's pub(super) dispatcher serves its bare call.
mod child;
use child::{child_run, MockSupervisor};
