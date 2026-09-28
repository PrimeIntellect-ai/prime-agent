//! The interactive loop's unit battery (moved with its concern): the
//! shutdown-recovery constants, the headless settle gate, and the exit
//! restore contract.

use super::*;
use std::collections::HashSet;

#[tokio::test]
async fn headless_error_returns_never_touch_the_terminal() {
    // A socket that never listens: the attach fails and the run
    // returns Err. The headless harness never owned the terminal —
    // the wrapper's restore is gated on the terminal ui mode, so a
    // headless error return must not attempt one (the terminal-mode
    // restore is the exit-restore e2e's error-exit scenario, driven
    // on a real terminal).
    let socket =
        std::env::temp_dir().join(format!("tui-exit-restore-dead-{}.sock", std::process::id()));
    let mut opts = options(ModelSelection::default());
    opts.socket_path = socket;
    // The attempts counter is process-global and the unwind-guard test
    // also moves it: this reader holds the shared state lock across
    // its whole read window.
    let _state = crate::exit_restore::TEST_STATE_LOCK.lock();
    let before = crate::exit_restore::RESTORE_ATTEMPTS.load(std::sync::atomic::Ordering::SeqCst);
    let result = run_interactive(
        opts,
        UiMode::Headless(HeadlessPlan {
            steps: Vec::new(),
            width: 80,
            height: 24,
        }),
    )
    .await;
    assert!(result.is_err(), "the dead socket must error the run");
    assert_eq!(
        crate::exit_restore::RESTORE_ATTEMPTS.load(std::sync::atomic::Ordering::SeqCst),
        before,
        "the headless error return did not attempt a restore"
    );
}

/// TS #2458's shutdown recovery constants: the announced non-update
/// closing waits the TS reconnect timeout (60s) on the TS fixed poll
/// (100ms, never doubling) — not the §10.2 resume window or the
/// hiccup loop's doubling backoff.
#[test]
fn the_shutdown_recovery_uses_the_ts_window_and_poll() {
    let before = tokio::time::Instant::now();
    let state = ReconnectLoop::start_shutdown();
    let after = tokio::time::Instant::now();
    assert_eq!(state.kind, RecoveryKind::Shutdown);
    // The window is 60s off the arming instant: the deadline sits
    // inside [before + 60s, after + 60s] (the arming ran between the
    // two clock reads — a single `now + 60s` bound can miss by the
    // nanoseconds between the reads).
    assert!(
        state.deadline >= before + DAEMON_SHUTDOWN_RECONNECT_WINDOW
            && state.deadline <= after + DAEMON_SHUTDOWN_RECONNECT_WINDOW,
        "the window is TS #2458's 60s reconnect timeout"
    );
    assert_eq!(state.delay, SHUTDOWN_RECONNECT_RETRY);
    // The first poll is the TS 100ms cadence off the same arming
    // instant, inside the same two clock reads.
    assert!(
        state.next_attempt >= before + SHUTDOWN_RECONNECT_RETRY
            && state.next_attempt <= after + SHUTDOWN_RECONNECT_RETRY,
        "the first poll is the TS 100ms cadence"
    );
    // The fixed poll never doubles.
    let state = state.next_attempt();
    assert_eq!(state.delay, SHUTDOWN_RECONNECT_RETRY);
    // The hiccup loop doubles: 1s -> 2s.
    let lost = ReconnectLoop::start_lost().next_attempt();
    assert_eq!(lost.delay, Duration::from_secs(2));
}

#[test]
fn flush_rows_write_crlf_and_keep_zone_markers() {
    // A marked row keeps its zero-width zone sequence inline (the
    // flushed row persists into scrollback, where absolute-position
    // marker re-emission cannot reach) and every row lands on its own
    // line with explicit CR (raw mode maps `\n` to a bare line feed).
    let mut marked = vec![crate::Span::raw("hello")];
    crate::osc133::mark_start(&mut marked);
    let styled = vec![crate::Span::styled(
        "world",
        ratatui::style::Style::default().fg(ratatui::style::Color::Indexed(1)),
    )];
    let mut buffer = String::new();
    write_flush_rows(&mut buffer, &[marked, styled]);
    let expected = format!(
        "\r{}hello\r\n\r\x1b[38;5;1mworld\x1b[0m\r\n",
        crate::osc133::ZONE_START
    );
    assert_eq!(buffer, expected);
    // No rows: no output.
    let mut empty = String::new();
    write_flush_rows(&mut empty, &[]);
    assert!(empty.is_empty());
}

fn options(selection: ModelSelection) -> InteractiveOptions {
    InteractiveOptions {
        socket_path: PathBuf::from("/tmp/unused.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        script_path: None,
        model_selection: selection,
        model_catalog: Vec::new(),
        model_configured_providers: HashSet::default(),
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
        keybindings: crate::keybindings::KeybindingsManager::new(),
        session_rlm_depth: None,
        prompt_stash: std::sync::Arc::default(),
        session_has_children: false,
        restore_dock_focus: false,
        client_settings: None,
    }
}

#[test]
fn create_config_carries_the_requested_thinking_level() {
    let config = options(ModelSelection {
        thinking: Some(pa_types::ai::ModelThinkingLevel::Max),
        ..Default::default()
    })
    .create_config();
    assert_eq!(config["thinking"], "max");
}

#[test]
fn create_config_omits_thinking_when_no_flag_was_given() {
    let config = options(ModelSelection::default()).create_config();
    assert!(config.get("thinking").is_none());
}

#[test]
fn resume_hint_names_a_flushed_session() {
    let dir = std::env::temp_dir().join("pa-tui-resume-hint-test");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("session.jsonl");
    std::fs::write(&file, "{}").unwrap();
    let stats = json!({
        "sessionId": "s1",
        "sessionFile": file.display().to_string(),
        "userMessages": 1
    });
    assert_eq!(
        crate::session_ui::resume_hint_from_stats(&stats),
        Some("Resume this session with: prime-agent --resume s1".to_string())
    );
    // An unflushed empty session and a missing session file are both
    // unresumable (TS omits the hint for either).
    assert_eq!(
        crate::session_ui::resume_hint_from_stats(&json!({
            "sessionId": "s1",
            "sessionFile": file.display().to_string(),
            "userMessages": 0
        })),
        None
    );
    assert_eq!(
        crate::session_ui::resume_hint_from_stats(&json!({
            "sessionId": "s1",
            "sessionFile": dir.join("missing.jsonl").display().to_string(),
            "userMessages": 3
        })),
        None
    );
}

/// The headless settle snapshot: `settled()` is exactly the old exit
/// gate (every member clear), and each member that sticks is named in
/// the bound's failure — the diagnostic IS the wedge family's
/// failure name.
#[test]
fn the_headless_settle_names_every_stuck_member() {
    // Everything clear: settled, no blockers.
    let settled = HeadlessSettle::default();
    assert!(settled.settled(), "the default snapshot is the open gate");
    assert!(settled.blockers().is_empty());
    // One member at a time: each blocker names exactly its member.
    for stuck in [
        HeadlessSettle {
            pending_inputs: 2,
            ..Default::default()
        },
        HeadlessSettle {
            turn_active: true,
            ..Default::default()
        },
        HeadlessSettle {
            submits_in_flight: 1,
            ..Default::default()
        },
        HeadlessSettle {
            queued: 3,
            ..Default::default()
        },
        HeadlessSettle {
            idle_barrier: true,
            ..Default::default()
        },
        HeadlessSettle {
            dirty: true,
            ..Default::default()
        },
        HeadlessSettle {
            share_pending: true,
            ..Default::default()
        },
        HeadlessSettle {
            reload_pending: true,
            ..Default::default()
        },
        HeadlessSettle {
            traces_upload_pending: true,
            ..Default::default()
        },
        HeadlessSettle {
            auth_panel_open: true,
            ..Default::default()
        },
        HeadlessSettle {
            traces_login_pending: true,
            ..Default::default()
        },
        HeadlessSettle {
            mcp_auth_pending: true,
            ..Default::default()
        },
    ] {
        assert!(!stuck.settled(), "one stuck member holds the gate shut");
        assert_eq!(
            stuck.blockers().len(),
            1,
            "each stuck member names exactly one blocker"
        );
    }
    // The wedge family's member: a latched turn names the turn.
    let wedge = HeadlessSettle {
        turn_active: true,
        ..Default::default()
    };
    assert_eq!(
        wedge.blockers(),
        vec!["a turn still active".to_string()],
        "the exit-gate wedge's failure names its stuck member"
    );
    // Everything stuck at once: every member is reported.
    let all = HeadlessSettle {
        pending_inputs: 1,
        turn_active: true,
        submits_in_flight: 1,
        queued: 1,
        idle_barrier: true,
        dirty: true,
        share_pending: true,
        reload_pending: true,
        traces_upload_pending: true,
        auth_panel_open: true,
        traces_login_pending: true,
        mcp_auth_pending: true,
    };
    assert_eq!(all.blockers().len(), 12);
    assert!(
        all.blockers()
            .iter()
            .any(|blocker| blocker.contains("a turn still active")),
        "the joined failure keeps the member names readable"
    );
}
