// large_futures: stack-resident futures on hot paths by design.
// too_many_lines: style gate. Casts: 64-bit targets; narrowing sits at
// bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::too_many_lines
)]

//! The terminal-state differential: a recording mock terminal over a real
//! pty asserts that EVERY terminal mode the TUI arms comes back off on EVERY
//! exit route (operator directive 2026-09-28, the kitty-exit-leak sweep):
//! the mock terminal records every mode-affecting byte the child writes,
//! answers the kitty query, drives one exit route, and asserts the delta
//! is empty.
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
use serde_json::json;

use pa_tui::agents_view::AgentsViewUiMode;
use pa_tui::config_selector::{
    run_config_selector, ConfigSelector, ConfigSelectorOptions, SelectorRow,
};
use pa_tui::interactive::{run_interactive, UiMode};

/// The kitty flags push (`1|2|4`, the TS `ProcessTerminal` set): the arm
/// proof every mounted surface must show.
const KITTY_FLAGS_PUSH: &[u8] = b"\x1b[>7u";
/// The probe's capability query (`supports_keyboard_enhancement`).
const KITTY_QUERY: &[u8] = b"\x1b[?u";
/// The harness's answer: flags supported, then the primary DA (a kitty terminal's reply).
const KITTY_ANSWER: &[u8] = b"\x1b[?7u\x1b[?62;c";
/// The alt-screen leave: every route that ends the process writes it.
const ALT_SCREEN_LEAVE: &[u8] = b"\x1b[?1049l";
/// The OSC 7501 detection query the terminal probe writes, and a supporting
/// terminal's reply.
const PROGRAM_STATUS_QUERY: &[u8] = b"\x1b]7501;?\x1b\\";
const PROGRAM_STATUS_ANSWER: &[u8] =
    b"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";
/// Every OSC 7501 report's head.
const STATUS_REPORT: &[u8] = b"\x1b]7501;state=";
/// The OSC 7501 reports the chat surface writes while a turn runs and rests.
const STATUS_WORKING: &[u8] = b"\x1b]7501;state=working:app=prime-agent\x1b\\";
const STATUS_DONE: &[u8] = b"\x1b]7501;state=done:app=prime-agent\x1b\\";
const STATUS_IDLE: &[u8] = b"\x1b]7501;state=idle:app=prime-agent\x1b\\";
const STATUS_ERROR: &[u8] = b"\x1b]7501;state=error:app=prime-agent\x1b\\";

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
/// TERM the children run with: answers the kitty query, no shortcut.
const CHILD_TERM: &str = "xterm-256color";

/// The chat child: the real interactive surface against the mock supervisor,
/// then the agents view when the exit came through agents-back
/// (`return_to_agents_view`). A roster-link failure returns quietly: the
/// error path's restore still ran.
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

/// The agents-view child: a fresh roster-surface run. A roster-link failure
/// returns quietly (the error-route restore still ran).
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

/// The picker child: the config-selector surface over a fixed row set; the
/// flags arm the error and exit variants.
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

/// The replay child: the replay surface over a harness-written fixture; the
/// `panic` flag runs the panic driver (a real unwind).
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
    let _ = pa_tui::app::run_app(Box::new(stream), &options, Box::new(|_text| {}));
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
    // The child reads the file across the process boundary.
    std::mem::forget(dir);
    path.display().to_string()
}

/// The state word of every OSC 7501 report in `stream`, in order.
fn status_reports(stream: &[u8]) -> Vec<String> {
    let mut reports = Vec::new();
    let mut rest = stream;
    while let Some(at) = find_subsequence(rest, STATUS_REPORT) {
        rest = &rest[at + STATUS_REPORT.len()..];
        let end = rest
            .iter()
            .position(|&byte| byte == b':')
            .unwrap_or(rest.len());
        reports.push(String::from_utf8_lossy(&rest[..end]).into_owned());
    }
    reports
}

/// A chat child on a terminal that answers the OSC 7501 detection, at rest
/// with its first idle report.
fn program_status_harness(spec: &ChildSpec) -> DifferentialHarness {
    let mut harness = DifferentialHarness::start(spec);
    harness.answer_terminal_probe();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");
    harness.wait_from_start(STATUS_IDLE, "the resting surface's idle report");
    harness
}

/// Exit through `/exit`: the program sends no OSC 7501 clear (the terminal
/// owns the record's lifetime past the process exit). Returns the whole
/// pty stream.
fn exit_without_status_clear(mut harness: DifferentialHarness, what: &str) -> Vec<u8> {
    harness.write(b"/exit\r");
    assert_eq!(harness.wait_child_exit(Duration::from_secs(20)), Some(0));
    harness.drain_until_quiet(4);
    let stream = harness.output();
    assert!(
        find_subsequence(&stream, b"\x1b]7501;state=clear").is_none(),
        "{what}: the exit must not clear the terminal's record"
    );
    harness.assert_terminal_state_restored(what);
    stream
}

/// OSC 7501 (program status): working for the whole multi-step run, idle
/// after an interrupt (Esc, then Ctrl+C), done at a run's normal end; the
/// exact report sequence proves no idle between steps and no stale done.
/// One Esc and one Ctrl+C: each interrupt key fires once, outside the Esc
/// repeat and the Ctrl+C pair windows, so the aborts stay deterministic.
#[test]
fn program_status_reports_the_run_and_its_settles() {
    let _lock = harness_lock();
    let mut harness = program_status_harness(&ChildSpec::new("chat"));
    for (input, report, what) in [
        (&b"hi\r"[..], STATUS_WORKING, "the multi-step run opened"),
        (b"\x1b[27u", STATUS_IDLE, "the Esc abort settled idle"),
        (b"finish\r", STATUS_WORKING, "the next run opened"),
        (b"finish\r", STATUS_DONE, "the run's normal end"),
        (b"hi\r", STATUS_WORKING, "a later run opened"),
        (b"\x03", STATUS_IDLE, "the Ctrl+C abort settled idle"),
    ] {
        let mark = harness.mark();
        harness.write(input);
        harness.wait_from(mark, report, what);
    }
    harness.drain_until_quiet(4);
    assert_eq!(
        status_reports(&harness.output()),
        ["idle", "working", "idle", "working", "done", "working", "idle"]
    );
    exit_without_status_clear(harness, "the program-status run route");
}

/// A terminal that answers only the DA1 (no OSC 7501 reply first) never
/// receives a report.
#[test]
fn program_status_stays_silent_without_a_detection_reply() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(&ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(PROGRAM_STATUS_QUERY, "the OSC 7501 detection query");
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");
    let mark = harness.mark();
    harness.write(b"retry\r");
    harness.wait_from(mark, b"status-retry-sentinel", "the run went on");
    let stream = exit_without_status_clear(harness, "the unsupported program-status route");
    assert!(status_reports(&stream).is_empty());
}

/// Each way a run fails or is cancelled reports exactly one settle: error
/// for a final failure, idle for a cancellation — never done, and no error
/// before a cancellation.
#[test]
fn program_status_failure_and_cancellation_have_distinct_outcomes() {
    let _lock = harness_lock();
    for (opener, command, expected) in [
        ("hi", "provider-failure", "error"),
        ("hi", "lifecycle-failure", "error"),
        ("hi", "terminal-abort", "idle"),
        ("hi", "cancel-failed", "idle"),
        ("retry", "retry-failure", "error"),
        ("retry", "retry-cancel", "idle"),
    ] {
        let mut harness = program_status_harness(&ChildSpec::new("chat"));
        let mark = harness.mark();
        harness.write(format!("{opener}\r").as_bytes());
        harness.wait_from(mark, STATUS_WORKING, "the run is working");
        let mark = harness.mark();
        harness.write(format!("{command}\r").as_bytes());
        harness.wait_from(
            mark,
            if expected == "error" {
                STATUS_ERROR
            } else {
                STATUS_IDLE
            },
            command,
        );
        harness.drain_until_quiet(4);
        assert_eq!(
            status_reports(&harness.output()[mark..]),
            [expected],
            "{command}"
        );
        exit_without_status_clear(harness, command);
    }
}

/// A failed attempt whose retry is pending stays working: the countdown
/// reaches the client before the attempt's `agent_end`, so no error is ever
/// reported. The resumed retry ends done; a pending retry does not survive
/// the switch to a new session.
#[test]
fn program_status_stays_working_during_provider_retry() {
    let _lock = harness_lock();
    let mut harness = program_status_harness(&ChildSpec::new("chat"));
    let start = harness.mark();
    harness.write(b"retry\r");
    harness.wait_from(
        start,
        b"status-retry-sentinel",
        "the retry countdown rendered",
    );
    let mark = harness.mark();
    harness.write(b"resume\r");
    harness.wait_from(mark, STATUS_DONE, "the resumed retry completed");
    assert_eq!(
        status_reports(&harness.output()[start..]),
        ["working", "done"],
        "the failed attempt with a pending retry never reports error"
    );

    let mark = harness.mark();
    harness.write(b"retry\r");
    harness.wait_from(mark, STATUS_WORKING, "another retry is pending");
    let mark = harness.mark();
    harness.write(b"/new\r");
    harness.wait_from(
        mark,
        STATUS_IDLE,
        "the new session drops the previous retry",
    );
    exit_without_status_clear(harness, "the retry status route");
}

/// A compaction is the program working. An overflow recovery holds the
/// failed attempt's run open through its compaction (its `agent_end` follows
/// the `compaction_start`): the re-issued turn ends done, a recovery that
/// gives up ends error — never an error while the recovery runs. A
/// threshold compaction after a settled run reports working, then the
/// run's done again. Each /copy delivers the mock's next compaction frames.
#[test]
fn program_status_compaction_works_and_overflow_recovery_settles_by_outcome() {
    let _lock = harness_lock();
    for (route, steps) in [
        ("overflow-recover", [STATUS_WORKING, STATUS_DONE].as_slice()),
        ("overflow-fail", [STATUS_WORKING, STATUS_ERROR].as_slice()),
        (
            "threshold",
            [STATUS_DONE, STATUS_WORKING, STATUS_DONE].as_slice(),
        ),
    ] {
        let mut harness = program_status_harness(&ChildSpec::new("chat"));
        let start = harness.mark();
        harness.write(format!("{route}\r").as_bytes());
        let mut mark = start;
        for (index, step) in steps.iter().enumerate() {
            if index > 0 {
                mark = harness.mark();
                harness.write(b"/copy\r");
            }
            harness.wait_from(mark, step, route);
        }
        harness.drain_until_quiet(4);
        let expected: &[&str] = match route {
            "overflow-recover" => &["working", "done"],
            "overflow-fail" => &["working", "error"],
            _ => &["working", "done", "working", "done"],
        };
        assert_eq!(
            status_reports(&harness.output()[start..]),
            expected,
            "{route}"
        );
        exit_without_status_clear(harness, route);
    }
}

/// A closed session cannot keep a provider countdown working.
#[test]
fn program_status_session_close_drops_pending_retry() {
    let _lock = harness_lock();
    let mut harness = program_status_harness(&ChildSpec::new("chat"));
    let mark = harness.mark();
    harness.write(b"retry\r");
    harness.wait_from(
        mark,
        b"status-retry-sentinel",
        "the retry countdown rendered",
    );
    harness.wait_from(mark, STATUS_WORKING, "the pending retry reports working");
    let mark = harness.mark();
    harness.write(b"/copy\r");
    harness.wait_from(
        mark,
        STATUS_IDLE,
        "the closed session drops its pending retry",
    );
    exit_without_status_clear(harness, "the closed-session retry status route");
}

/// A closed session cannot keep a settled run's outcome: the dead
/// surface reports idle, not the stale done.
#[test]
fn program_status_session_close_drops_the_settled_outcome() {
    let _lock = harness_lock();
    let mut harness = program_status_harness(&ChildSpec::new("chat"));
    let mark = harness.mark();
    harness.write(b"finish\r");
    harness.wait_from(mark, STATUS_WORKING, "the run opened");
    let mark = harness.mark();
    harness.write(b"finish\r");
    harness.wait_from(mark, STATUS_DONE, "the run settled normally");
    let mark = harness.mark();
    harness.write(b"/copy\r");
    harness.wait_from(
        mark,
        STATUS_IDLE,
        "the closed session drops its settled done",
    );
    exit_without_status_clear(harness, "the closed-session settled-outcome status route");
}

/// An abort landing in a run's tool batch settles through the step's
/// ORIGINAL `toolUse` `turn_end` and the run's `agent_end` carrying the
/// abort marker: idle, not done. An Esc firing once outside the repeat
/// window keeps the abort deterministic.
#[test]
fn program_status_aborts_during_a_tool_batch_settles_idle_not_done() {
    let _lock = harness_lock();
    let mut harness = program_status_harness(&ChildSpec::new("chat"));
    let mark = harness.mark();
    harness.write(b"batch\r");
    harness.wait_from(mark, STATUS_WORKING, "the tools run opened");
    let mark = harness.mark();
    harness.write(b"\x1b[27u");
    harness.wait_from(mark, STATUS_IDLE, "the aborted run settled idle");
    harness.drain_until_quiet(4);
    assert_eq!(status_reports(&harness.output()[mark..]), ["idle"]);
    exit_without_status_clear(harness, "the program-status tool-batch abort route");
}

/// An attach that catches an in-flight compaction reports working (the
/// compaction loader) and every compaction settle (success, cancelled,
/// failed) leaves the surface at rest, never stuck working.
#[test]
fn program_status_attach_during_compaction_works_then_rests() {
    let _lock = harness_lock();
    let compaction_ends = [
        (
            json!({
                "type": "compaction_end",
                "reason": "manual",
                "result": { "summary": "compaction-settled-needle", "tokensBefore": 123 },
            }),
            &b"compaction-settled-needle"[..],
            "the compacted summary row",
        ),
        (
            json!({ "type": "compaction_end", "reason": "manual", "aborted": true }),
            &b"Compaction cancelled"[..],
            "the cancelled compaction row",
        ),
        (
            json!({
                "type": "compaction_end",
                "reason": "manual",
                "errorMessage": "compaction-error-needle",
            }),
            &b"compaction-error-needle"[..],
            "the failed compaction row",
        ),
    ];
    for (compaction_end, needle, what) in compaction_ends {
        let spec = ChildSpec::new("chat").attach_compaction_end(compaction_end);
        let mut harness = DifferentialHarness::start(&spec);
        harness.answer_terminal_probe();
        harness.wait_from_start(b"row 0", "the attach snapshot rendered");
        harness.wait_from_start(STATUS_WORKING, "the attached compaction reports working");
        let mark = harness.mark();
        harness.write(b"/copy\r");
        harness.wait_from(mark, needle, what);
        harness.wait_from(mark, STATUS_IDLE, "the settled compaction rests idle");
        harness.drain_until_quiet(4);
        assert_eq!(
            status_reports(&harness.output()),
            ["working", "idle"],
            "{what}"
        );
        exit_without_status_clear(harness, "the compaction attach route");
    }
}

/// Route: the parity exit through the `/exit` slash command.
#[test]
fn parity_exit_through_slash_command_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(&ChildSpec::new("chat"));
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

#[test]
fn parity_exit_through_the_ctrl_c_pair_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(&ChildSpec::new("chat"));
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

/// Route: the detach handoff to the agents view — the pane hands to a second
/// surface of the same process (alt screen and raw mode stay by design), and
/// the VIEW's exit then releases everything.
#[test]
fn the_detach_handoff_then_the_view_exit_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(&ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    let mark = harness.mark();
    harness.write(b"\x1b[D");
    harness.wait_from(
        mark,
        b"Search sessions",
        "the agents view mounts behind the handoff",
    );
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

/// Route: the force-quit watchdog from a wedged loop: the mock stalls the
/// `/list` request, the loop wedges, the Ctrl+C pair arms the watchdog, and
/// its own byte order must hand the terminal back whole.
#[test]
fn the_force_quit_watchdog_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(&ChildSpec::new("chat").stall(&["list"]));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

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

#[test]
fn the_agents_view_fresh_exit_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(&ChildSpec::new("view"));
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
/// roster link fails while the pane is in TUI state, so the surface's own
/// release must hand the terminal back before the error escapes (TS
/// `returnToAgentsView`'s `finally`).
#[test]
fn the_agents_view_roster_failure_behind_a_handoff_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(&ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

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

#[test]
fn the_config_selector_esc_close_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(&ChildSpec::new("selector"));
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

#[test]
fn the_config_selector_remapped_exit_action_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(
        &ChildSpec::new("selector").env(CHILD_SELECTOR_FLAGS_ENV, "remap-exit"),
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

#[test]
fn the_config_selector_toggle_error_restores_every_mode() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(
        &ChildSpec::new("selector").env(CHILD_SELECTOR_FLAGS_ENV, "fail-toggle"),
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

#[test]
fn the_replay_surface_clean_exit_restores_every_mode() {
    let _lock = harness_lock();
    let fixture = write_replay_fixture();
    let mut harness =
        DifferentialHarness::start(&ChildSpec::new("replay").env(CHILD_FIXTURE_ENV, fixture));
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

/// Route: the panic unwind: the panic driver panics mid-loop after the first
/// paint; the unwind crosses the guard, the exit restore runs, and the
/// process dies with the terminal whole.
#[test]
fn the_panic_unwind_restores_every_mode() {
    let _lock = harness_lock();
    let fixture = write_replay_fixture();
    let mut harness = DifferentialHarness::start(
        &ChildSpec::new("replay")
            .env(CHILD_FIXTURE_ENV, fixture)
            .env(CHILD_REPLAY_FLAGS_ENV, "panic"),
    );
    // The panic fires at the FIRST draw, before the probe's support check
    // writes its query: the exit release stands the probe down (a push that
    // raced ahead is popped by the drain; one after is refused).
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

/// Route: the pre-mount daemon refusal: the run errors BEFORE any
/// terminal state is armed, so the error path must restore NOTHING.
#[test]
fn the_pre_mount_daemon_refusal_arms_nothing() {
    let _lock = harness_lock();
    // A socket path nothing listens on: the connect surfaces the error.
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

/// Whether this runner has a controlling-terminal session (the suspend
/// cycle's stop/continue needs one).
fn sigtstp_session_runner() -> bool {
    // SAFETY: tcgetpgrp only queries the fd's foreground process group.
    let foreground = unsafe { libc::tcgetpgrp(0) };
    foreground >= 0
}

/// Whether this environment's SIGTSTP actually stops a process: some
/// sandboxes neutralize job-control stops (`kill -TSTP` returns success and
/// the process keeps running). The suspend route needs a real stop.
fn sigtstp_stops_processes() -> bool {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg("kill -TSTP 0; sleep 5")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // The probe child gets its OWN process group: sharing the runner's
        // group would stop the runner itself the moment job control works.
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
/// MID-PROCESS, so the differential asserts twice: at the stop point and
/// at the resumed session's final exit.
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
    let mut harness = DifferentialHarness::start(&ChildSpec::new("chat"));
    harness.answer_kitty_query();
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");
    let child_id = harness.child.id();

    let mark = harness.mark();
    harness.write(b"\x1a");
    harness.wait_from(
        mark,
        ALT_SCREEN_LEAVE,
        "the suspend release left the alt screen",
    );
    wait_for_stopped(child_id, "the suspend cycle stopped the group");

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

/// Route: the late kitty answer: the probe's query goes unanswered
/// through the mount, and the answer bytes land INSIDE the exit window.
/// Whatever path takes the answer, the stream must carry NO kitty flags push after the exit began.
#[test]
fn the_late_kitty_answer_inside_the_exit_window_is_stood_down() {
    let _lock = harness_lock();
    let mut harness = DifferentialHarness::start(&ChildSpec::new("chat"));
    harness.wait_from_start(KITTY_QUERY, "the kitty capability query");
    harness.wait_from_start(b"row 0", "the attach snapshot rendered");

    // The answer rides the drain window: write it right after the drain's modifyOtherKeys reset.
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

    let stream = harness.output();
    assert!(
        find_subsequence(&stream, KITTY_FLAGS_PUSH).is_none(),
        "the late answer pushed the kitty flags after the exit standdown"
    );
    harness.assert_terminal_state_restored("the late kitty answer inside the exit window");
}
