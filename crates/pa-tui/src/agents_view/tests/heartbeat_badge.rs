//! The heartbeat badge: the row's `◷ N` count between the status icon and
//! the title, in the dock's active/paused colors.

use super::*;

/// One catalog row wrapping a parsed job (the daemon's session-name and
/// first-message enrichment stay out of the badge's way).
fn entry(job_json: &serde_json::Value) -> crate::heartbeats_picker::HeartbeatEntry {
    crate::heartbeats_picker::HeartbeatEntry {
        job: crate::heartbeats_picker::parse_heartbeat_job(job_json).expect("job parses"),
        session_name: None,
        first_message: None,
    }
}

fn job(id: &str, status: &str, session_id: &str, active_session_id: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "status": status,
        "source": "heartbeat",
        "activeSessionId": active_session_id,
        "sessionId": session_id,
        "schedule": { "expression": "every 30m" },
    })
}

/// The row's own session's jobs count before its title: the passivated
/// stale-active-id match lands via the durable session id, another
/// session's job stays out, and the count is active plus paused — green
/// while any job is active (the dock's `running_color`), amber when all
/// are paused (the dock's `◐ N paused`).
#[test]
fn a_rows_heartbeat_count_renders_before_its_title() {
    for (jobs_json, badge, color) in [
        (
            vec![
                job("hb-1", "active", "s", "s-live"),
                job("hb-2", "paused", "s", "stale-live"),
                job("hb-3", "active", "other", "other-live"),
            ],
            "\u{25f7} 2",
            ThemeColor::Success,
        ),
        (
            vec![job("hb-1", "paused", "s", "s-live")],
            "\u{25f7} 1",
            ThemeColor::Warning,
        ),
    ] {
        let (mut mode, index) = mode_with_row("worker", "mock-1");
        mode.rows[index].summary = serde_json::json!({
            "sessionName": "worker",
            "sessionId": "s",
            "activeSessionId": "s-live",
        });
        mode.heartbeats = jobs_json.iter().map(entry).collect();
        let layout = build_layout(&mode.rows, 120);
        let line = mode.render_row(&mode.rows[index], &layout, 120, false);
        let expected: crate::Line = vec![
            crate::Span::styled(
                "\u{2022}".to_string(),
                mode.theme
                    .fg_style(ThemeColor::Warning)
                    .add_modifier(ratatui::style::Modifier::BOLD),
            ),
            crate::Span::styled(" ".to_string(), ratatui::style::Style::default()),
            crate::Span::styled(badge.to_string(), mode.theme.fg_style(color)),
            crate::Span::styled(" ".to_string(), ratatui::style::Style::default()),
            crate::Span::styled("worker".to_string(), mode.theme.fg_style(ThemeColor::Text)),
            crate::Span::styled(
                " ".repeat(layout.name_width.saturating_sub(2 + 4 + 6)),
                ratatui::style::Style::default(),
            ),
            crate::Span::styled("  ".to_string(), ratatui::style::Style::default()),
            mode.theme
                .fg(ThemeColor::Muted, cell("mock-1", layout.model_width)),
            crate::Span::styled("  ".to_string(), ratatui::style::Style::default()),
            mode.theme.fg(
                ThemeColor::Dim,
                layout.details.get("worker").cloned().unwrap_or_default(),
            ),
        ];
        assert_eq!(line, expected);
    }
    // An id-less row never counts an id-less job: the empty id is no
    // session identity (the same truth the dock's scoping holds).
    let (mut mode, index) = mode_with_row("worker", "mock-1");
    mode.heartbeats = vec![entry(&job("hb-none", "active", "", ""))];
    let layout = build_layout(&mode.rows, 120);
    let line = mode.render_row(&mode.rows[index], &layout, 120, false);
    assert!(
        !flat(&line).contains('\u{25f7}'),
        "the id-less row renders no badge for the id-less job: {line:?}"
    );
    // A name column too narrow for the row's fixed prefix plus the badge
    // renders exactly as a badge-less row: the model and cost/age cells
    // never move right (width 19 squeezes `name_width` to 5, one cell
    // short of the badge's 6-cell prefix).
    let (mut mode, index) = mode_with_row("worker", "mock-1");
    mode.rows[index].summary = serde_json::json!({
        "sessionName": "worker",
        "sessionId": "s",
        "activeSessionId": "s-live",
    });
    mode.heartbeats = [
        job("hb-1", "active", "s", "s-live"),
        job("hb-2", "paused", "s", "stale-live"),
    ]
    .iter()
    .map(entry)
    .collect();
    let layout = build_layout(&mode.rows, 19);
    let line = mode.render_row(&mode.rows[index], &layout, 19, false);
    let expected: crate::Line = vec![
        crate::Span::styled(
            "\u{2022}".to_string(),
            mode.theme
                .fg_style(ThemeColor::Warning)
                .add_modifier(ratatui::style::Modifier::BOLD),
        ),
        crate::Span::styled(" ".to_string(), ratatui::style::Style::default()),
        crate::Span::styled("wor".to_string(), mode.theme.fg_style(ThemeColor::Text)),
        crate::Span::styled(String::new(), ratatui::style::Style::default()),
        crate::Span::styled("  ".to_string(), ratatui::style::Style::default()),
        mode.theme
            .fg(ThemeColor::Muted, cell("mock-1", layout.model_width)),
        crate::Span::styled("  ".to_string(), ratatui::style::Style::default()),
        mode.theme.fg(
            ThemeColor::Dim,
            layout.details.get("worker").cloned().unwrap_or_default(),
        ),
    ];
    assert_eq!(line, expected);
}
