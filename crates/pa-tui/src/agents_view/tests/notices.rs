//! The notice panel: multi-line notices render as the dismissible panel,
//! single-line ones stay on the status line.

use super::*;

/// One mode over the given notice (the previous run's failure).
fn mode_with_notice(notice: &str) -> AgentsViewMode {
    let mut mode = AgentsViewMode::new(AgentsViewOptions {
        socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
        cwd: PathBuf::from("/tmp"),
        session_dir: None,
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: Some(notice.to_string()),
        keybindings: crate::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: serde_json::json!({}),
    });
    mode.rebuild_rows();
    mode
}

/// A multi-line notice — the cross-product lease refusal with its two
/// ways out — renders as the panel: the full text stays visible and
/// wrapped, never truncated to the single hint line, and any key
/// dismisses it.
#[test]
fn a_multiline_refusal_notice_renders_as_a_dismissible_panel() {
    let refusal = "This session is currently open in another Rust build of Prime Agent \
(active in 6b558be357e3) — another daemon or window of this product holds the file's \
runtime lease.\n\n• Continue where you left off:\n  prime-agent --daemon-socket \
<socket> --resume 'sess-1'\n  (<socket> is that instance's daemon socket, from the \
shell where you started it — that daemon owns this session)\n\n• Take over on this \
daemon:\n  kill 4242 # the holder is prime-agent\n  Then retry — the file unlocks when \
the holder exits.";
    let render = |mode: &mut AgentsViewMode| {
        let (lines, _) = mode.render_frame(120, 40);
        lines
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut mode = mode_with_notice(refusal);
    let shown = render(&mut mode);
    for way_out in [
        "Continue where you left off",
        "--daemon-socket <socket> --resume 'sess-1'",
        "Take over on this daemon",
        "kill 4242 # the holder is prime-agent",
    ] {
        assert!(
            shown.contains(way_out),
            "the panel shows {way_out:?} in full:\n{shown}"
        );
    }
    // Any key dismisses the panel; the hint line returns.
    mode.handle_key("down");
    let dismissed = render(&mut mode);
    assert!(
        !dismissed.contains("Take over on this daemon"),
        "the panel leaves the frame on any key:\n{dismissed}"
    );
}

/// A single-line notice keeps the hint-line status: the panel arms only
/// for notices with lines to show.
#[test]
fn a_single_line_notice_keeps_the_status_line() {
    let mode = mode_with_notice("Saved sessions unavailable: no such directory");
    assert!(mode.notice.is_none());
    assert_eq!(
        mode.status_text(),
        Some("Saved sessions unavailable: no such directory")
    );
}

/// TS `setStatusMessage`'s tone rule: the explicit tone wins, the
/// `Failed` prefix reads error, everything else reads muted — and the
/// rendered hint row carries the tone's color (the #3117 SF6
/// divergence: every status used to render as an error).
#[test]
fn the_status_line_carries_its_tone() {
    let mut mode = mode_with_parent_and_child();
    mode.set_status("Renamed to new");
    assert_eq!(
        mode.status.as_ref().map(Status::tone),
        Some(StatusTone::Muted)
    );
    // The Failed prefix is an error without an explicit tone.
    mode.set_status("Failed to rename agent: nope");
    assert_eq!(
        mode.status.as_ref().map(Status::tone),
        Some(StatusTone::Error)
    );
    // An explicit tone wins over the prefix rule, and the text
    // collapses to one line (TS `formatAgentsViewStatusLine`).
    mode.set_status_tone("Saved sessions\n   unavailable", StatusTone::Error);
    assert_eq!(mode.status_text(), Some("Saved sessions unavailable"));
    assert_eq!(
        mode.status.as_ref().map(Status::tone),
        Some(StatusTone::Error)
    );
    // The rendered row paints in the tone's color, not the fixed
    // error color: a muted report renders muted.
    mode.set_status("Renaming agent...");
    let span = mode
        .render_hints(120, None)
        .last()
        .expect("the status span")
        .clone();
    assert_eq!(span.content, "Renaming agent...");
    assert_eq!(span.style, mode.theme.fg_style(StatusTone::Muted.color()));
    // An explicit error renders error.
    mode.set_status_tone("Saved sessions unavailable: gone", StatusTone::Error);
    let span = mode
        .render_hints(120, None)
        .last()
        .expect("the status span")
        .clone();
    assert_eq!(span.style, mode.theme.fg_style(StatusTone::Error.color()));
}

/// TS's 4.5s status timer, through the accessors the loop drives: the
/// line arms its expiry, holds before the deadline, clears after it —
/// and a line that REPLACED an expired one keeps its own new window
/// (TS's unchanged-line guard).
#[test]
fn the_status_expires_through_the_loop_deadline() {
    let mut mode = mode_with_parent_and_child();
    mode.set_status("Reply sent");
    let now = std::time::Instant::now();
    assert!(
        mode.status_expiry(now).is_some(),
        "a fresh line arms its timer"
    );
    assert!(
        !mode.expire_status(now),
        "before the deadline the line holds"
    );
    assert_eq!(mode.status_text(), Some("Reply sent"));
    // The deadline passed (the loop's wake arm fires at the expiry):
    // the line clears and repaints.
    let after = now + std::time::Duration::from_millis(4500);
    assert!(mode.status_expiry(after).is_none(), "the deadline passed");
    assert!(mode.expire_status(after), "the expired line clears");
    assert_eq!(mode.status_text(), None, "the cleared line renders nothing");
    // The unchanged-line guard: a replacement line's own deadline is
    // fresh again at the expired line's wake.
    mode.set_status("Reply sent again");
    assert!(
        !mode.expire_status(after),
        "the replacement keeps its own new window"
    );
    assert_eq!(mode.status_text(), Some("Reply sent again"));
}
