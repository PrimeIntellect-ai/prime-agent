//! The `/heartbeats` view's unit battery.

use super::*;
use crate::theme::{ColorMode, Theme};

fn kb() -> KeybindingsManager {
    KeybindingsManager::new()
}

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

fn job_value(id: &str, source: &str, status: &str) -> Value {
    serde_json::json!({
        "job": {
            "id": id,
            "status": status,
            "source": source,
            "activeSessionId": "live-1",
            "sessionId": "sess-1",
            "prompt": format!("tick {id}"),
            "schedule": {"kind": "interval", "expression": "every 10m", "intervalMs": 600_000},
            "createdAt": "2026-01-01T00:00:00.000Z",
            "nextRunAt": "2026-01-01T00:10:00.000Z",
            "runCount": 2,
        },
        "sessionName": "the session",
    })
}

fn entries() -> Vec<HeartbeatEntry> {
    let data = serde_json::json!({
        "heartbeats": [
            job_value("agent-1", "rlm_heartbeat", "active"),
            job_value("user-1", "heartbeat", "paused"),
        ]
    });
    let mut parsed = parse_heartbeats(&data);
    sort_heartbeats(&mut parsed);
    parsed
}

fn frame_text(frame: &[Line]) -> Vec<String> {
    frame
        .iter()
        .map(|line| line.iter().map(|span| span.content.as_str()).collect())
        .collect()
}

#[test]
fn parse_reads_the_wire_shape() {
    let parsed = entries();
    assert_eq!(parsed.len(), 2);
    let user = parsed
        .iter()
        .find(|entry| entry.job.id == "user-1")
        .expect("user row");
    assert_eq!(user.job.status, "paused");
    assert_eq!(user.job.source.as_deref(), Some("heartbeat"));
    assert_eq!(user.job.schedule_expression, "every 10m");
    assert_eq!(user.job.run_count, 2);
    assert_eq!(user.session_name.as_deref(), Some("the session"));
}

#[test]
fn sort_puts_user_created_first_within_a_session() {
    let parsed = entries();
    assert_eq!(parsed[0].job.id, "user-1");
    assert_eq!(parsed[1].job.id, "agent-1");
}

#[test]
fn scoping_keeps_own_and_child_sessions() {
    let mut all = entries();
    let agent = all
        .iter_mut()
        .find(|entry| entry.job.id == "agent-1")
        .expect("agent row");
    agent.job.session_id = "other-session".to_string();
    agent.job.active_session_id = "child-live".to_string();
    let scoped = scope_heartbeats(
        all.clone(),
        Some("live-1"),
        Some("sess-1"),
        &["child-live".to_string()],
    );
    assert_eq!(scoped.len(), 2);
    let scoped = scope_heartbeats(all, Some("live-1"), Some("sess-1"), &[]);
    assert_eq!(scoped.len(), 1);
    assert_eq!(scoped[0].job.id, "user-1");
    assert!(scope_heartbeats(entries(), None, None, &[]).is_empty());
}

#[test]
fn a_carried_selection_opens_on_that_row() {
    let catalog = entries();
    let ids: Vec<_> = catalog.iter().map(|entry| entry.job.id.clone()).collect();
    let picker = HeartbeatsPicker::new(catalog.clone(), None, Some(ids[1].clone()), 24);
    assert_eq!(
        picker.selected_heartbeat_id.as_deref(),
        Some(ids[1].as_str())
    );
    let picker = HeartbeatsPicker::new(catalog, None, Some("missing".to_string()), 24);
    assert_eq!(picker.selected_heartbeat_id.as_deref(), Some("user-1"));
}

#[test]
fn the_list_renders_columned_rows_and_one_hint() {
    let picker = HeartbeatsPicker::new(entries(), None, None, 24);
    let frame = picker.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("Heartbeats")));
    assert!(text.iter().any(|row| row.contains("1 active · 1 paused")));
    let header = text
        .iter()
        .find(|row| row.contains("Interval") && row.contains("Next run"))
        .expect("a column header row");
    assert!(header.contains("Label"));
    assert!(header.contains("Status"));
    // The fixture's next run is long past, so the one-second floor renders ("in 1s").
    let row = text
        .iter()
        .find(|row| row.contains("every 10m"))
        .expect("a columned row");
    assert!(row.contains("tick user-1"));
    assert!(row.contains("in 1s"));
    assert!(row.contains("paused"));
    assert!(!text.iter().any(|row| row.starts_with("  created")));
    assert_eq!(
        text.iter().filter(|row| row.contains("Esc close")).count(),
        1,
        "the close hint appears once: {text:?}"
    );
    assert!(text
        .iter()
        .any(|row| row.contains("↑/↓ move · Enter/→ open · ←/Esc close")));
    for line in &frame {
        assert!(
            crate::width::spans_width(line) <= 70,
            "every row fits the width"
        );
    }
}

#[test]
fn the_list_hint_drops_unbound_keys() {
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("app.modal.back".to_string(), Vec::new());
    let kb = KeybindingsManager::with_user_bindings(cfg);
    let picker = HeartbeatsPicker::new(entries(), None, None, 24);
    let frame = picker.render(&theme(), 70, &kb);
    let text = frame_text(&frame);
    assert!(
        text.iter()
            .any(|row| row.contains("↑/↓ move · Enter/→ open · Esc close")),
        "the emptied back binding drops the arrow: {text:?}"
    );
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("app.heartbeats.openSelected".to_string(), Vec::new());
    let kb = KeybindingsManager::with_user_bindings(cfg);
    let picker = HeartbeatsPicker::new(entries(), None, None, 24);
    let frame = picker.render(&theme(), 70, &kb);
    let text = frame_text(&frame);
    assert!(
        text.iter()
            .any(|row| row.contains("↑/↓ move · Enter open · ←/Esc close")),
        "the emptied open binding drops the arrow: {text:?}"
    );
}

/// The table fills the full width of the TUI (the operator's 2026-09-24
/// ruling): the selected row's wash spans the terminal width, the columns
/// keep their content-hug geometry.
#[test]
fn the_table_fills_the_full_width() {
    let picker = HeartbeatsPicker::new(entries(), None, None, 24);
    let frame = picker.render(&theme(), 90, &kb());
    let selected = frame
        .iter()
        .find(|line| {
            line.iter()
                .any(|span| span.style.bg.is_some() && span.content.contains("tick user-1"))
        })
        .expect("the selected row carries the wash");
    let used = crate::width::spans_width(selected);
    assert_eq!(
        used, 90,
        "the selected row's wash spans the whole terminal width: {used}"
    );
    let plain = frame
        .iter()
        .find(|line| {
            line.iter()
                .any(|span| span.content.contains("tick agent-1"))
        })
        .expect("the other row");
    assert!(crate::width::spans_width(plain) < 90);
    assert!(plain.iter().all(|span| span.style.bg.is_none()));
}

/// The selected row paints the ONE shared selection style (the operator's
/// 2026-09-28 consistency rule): the same background as the agents view's
/// and the shell view's selected rows — `Theme::selection_row_style`, not
/// a per-surface copy.
#[test]
fn the_selected_row_paints_the_shared_selection_style() {
    let theme = theme();
    let frame = HeartbeatsPicker::new(entries(), None, None, 24).render(&theme, 90, &kb());
    let selected = frame
        .iter()
        .find(|line| line.iter().any(|span| span.content.contains("tick user-1")))
        .expect("the selected row");
    let band = theme.selection_row_style();
    assert!(
        selected.iter().all(|span| span.style.bg == band.bg),
        "every span of the selected row carries the shared band: {selected:?}"
    );
    assert_eq!(
        band.bg,
        theme.hover_row_style().bg,
        "the shared selection paints the hover's own color — the one-color ruling"
    );
}

/// The shortcuts ride the pane's last rows with no rule below them (the
/// operator's 2026-09-24 /model ruling): one blank line under the hint,
/// never a `─` divider.
#[test]
fn the_footer_is_a_blank_below_the_shortcuts_never_a_rule() {
    let picker = HeartbeatsPicker::new(entries(), None, None, 24);
    let frame = picker.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let hint_index = text
        .iter()
        .position(|row| row.contains("Esc close"))
        .expect("the hint row");
    let last = text.last().expect("the pane's last row");
    assert!(
        last.trim().is_empty(),
        "one blank line rides below the shortcuts: {last:?} ({text:?})"
    );
    assert!(!last.contains("\u{2500}"), "no rule below the hint");
    assert_eq!(
        text.len() - hint_index - 1,
        1,
        "exactly one blank below the hint: {text:?}"
    );
    assert!(frame.len() <= 24);
    let mut drill = HeartbeatsPicker::new(entries(), None, None, 20);
    drill.handle_key("enter", &kb());
    let frame = drill.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let last = text.last().expect("the detail pane's last row");
    assert!(
        last.trim().is_empty(),
        "the detail footer ends on the same blank: {last:?}"
    );
}

/// The next-run label is natural language, anchored on one fixed clock (the label's `now` comes
/// from the same clock the wire timestamps parse with).
#[test]
fn the_next_run_label_is_natural_language() {
    let now = crate::agents_view_state::iso_to_unix_ms("2026-06-01T12:00:00.000Z")
        .expect("the base parses") as u64;
    let label = |next_run_at: &str| next_run_label(Some(next_run_at), now);
    assert_eq!(label("2026-06-01T12:00:45.000Z"), "in 45s");
    assert_eq!(label("2026-06-01T12:05:00.000Z"), "in 5m");
    assert_eq!(label("2026-06-01T22:00:00.000Z"), "in 10h");
    // Unit boundaries round up into the next unit.
    assert_eq!(label("2026-06-01T12:00:59.500Z"), "in 1m");
    assert_eq!(label("2026-06-01T12:01:00.000Z"), "in 1m");
    assert_eq!(label("2026-06-01T13:00:00.000Z"), "in 1h");
    assert_eq!(label("2026-06-02T12:00:00.000Z"), "in 1d");
    assert_eq!(label("2026-06-03T12:00:00.000Z"), "in 2d");
    assert_eq!(label("2026-06-01T11:59:30.000Z"), "in 1s");
    assert_eq!(next_run_label(None, now), "\u{2014}");
    assert_eq!(label("soon-ish"), "soon-ish");
}

/// The interval column renders the human-readable form (the operator's
/// 2026-09-24 ruling: "cron format is not human readable"); the drill-in's
/// pairs keep the raw cron reachable beside it.
#[test]
fn the_interval_column_is_human_readable() {
    assert_eq!(human_schedule("*/2 * * * *"), "every 2 minutes");
    assert_eq!(human_schedule("0 9 * * 1"), "Mondays 09:00");
    assert_eq!(human_schedule("@hourly"), "hourly");
    assert_eq!(human_schedule("0 * * * *"), "hourly");
    assert_eq!(human_schedule("0 0 * * *"), "daily 00:00");
    assert_eq!(human_schedule("0 */3 * * *"), "every 3 hours");
    assert_eq!(human_schedule("*/1 * * * *"), "every minute");
    assert_eq!(human_schedule("30 * * * *"), "hourly at :30");
    assert_eq!(human_schedule("0 0 1 * *"), "monthly 00:00");
    assert_eq!(human_schedule("*/2 9-17 * * 1-5"), "*/2 9-17 * * 1-5");
    assert_eq!(human_schedule("every 10m"), "every 10m");
    assert_eq!(human_schedule("0 9 * * 8"), "0 9 * * 8");
    // Star-only fields read as every-minute; whitespace-padded passthroughs trim (never render
    // twice).
    assert_eq!(human_schedule("* * * * *"), "every minute");
    assert_eq!(human_schedule(" every 10m "), "every 10m");

    let mut catalog = entries();
    catalog[1].job.schedule_expression = "*/2 * * * *".to_string();
    let mut picker = HeartbeatsPicker::new(catalog, None, None, 24);
    let frame = picker.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(
        text.iter().any(|row| row.contains("every 2 minutes")),
        "the interpreted interval rides the column: {text:?}"
    );
    assert!(
        !text.iter().any(|row| row.contains("*/2 * * * *")),
        "the raw cron leaves the column: {text:?}"
    );
    picker.handle_key("down", &kb());
    picker.handle_key("enter", &kb());
    let frame = picker.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let schedule_row = text
        .iter()
        .find(|row| row.starts_with("  schedule"))
        .expect("the schedule pair");
    assert!(
        schedule_row.contains("every 2 minutes (*/2 * * * *)"),
        "the pairs keep the raw cron beside the interpretation: {schedule_row}"
    );
}

#[test]
fn enter_opens_the_detail_drill_in_and_runs_the_resume_action() {
    let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
    assert_eq!(
        picker.handle_key("enter", &kb()),
        HeartbeatsPickerAction::None
    );
    assert_eq!(
        picker.mode,
        Mode::Detail {
            heartbeat_id: "user-1".to_string(),
            action_index: 0,
        }
    );
    assert_eq!(
        picker.handle_key("enter", &kb()),
        HeartbeatsPickerAction::Manage {
            active_session_id: "live-1".to_string(),
            job_id: "user-1".to_string(),
            action: HeartbeatAction::Resume,
        }
    );
}

#[test]
fn the_detail_renders_the_full_prompt_created_by_and_actions() {
    let mut catalog = entries();
    catalog[0].job.prompt = "first line of the prompt\n\nsecond\nparagraph".to_string();
    let mut picker = HeartbeatsPicker::new(catalog, None, None, 40);
    picker.handle_key("enter", &kb());
    let frame = picker.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let joined = text.join("\n");
    for word in [
        "first",
        "line",
        "of",
        "the",
        "prompt",
        "second",
        "paragraph",
    ] {
        assert!(joined.contains(word), "the prompt renders {word}: {joined}");
    }
    assert!(
        text.iter().any(|row| row.starts_with("  Prompt")),
        "the prompt block carries its label"
    );
    assert!(text
        .iter()
        .any(|row| row.starts_with("  created") && row.contains("Created by you")));
    assert!(text
        .iter()
        .any(|row| row.starts_with("  session") && row.contains("the session")));
    assert!(text.iter().any(|row| row.contains("runs")));
    assert!(text.iter().any(|row| row.contains("Resume heartbeat")));
    assert!(text.iter().any(|row| row.contains("Stop heartbeat")));
    assert!(text
        .iter()
        .any(|row| row.contains("Continue scheduled deliveries")));
    assert!(text
        .iter()
        .any(|row| row.contains("↑/↓ move · Enter run · ← back · Esc close")));
}

#[test]
fn back_returns_to_the_list_and_escape_closes() {
    let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
    picker.handle_key("enter", &kb());
    assert_eq!(
        picker.handle_key("left", &kb()),
        HeartbeatsPickerAction::None
    );
    assert_eq!(picker.mode, Mode::List);
    assert_eq!(
        picker.handle_key("escape", &kb()),
        HeartbeatsPickerAction::Close
    );
    assert_eq!(
        picker.handle_key("ctrl+c", &kb()),
        HeartbeatsPickerAction::Close
    );
}

#[test]
fn navigation_moves_the_selection_by_id() {
    let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
    assert_eq!(
        picker.handle_key("down", &kb()),
        HeartbeatsPickerAction::None
    );
    assert_eq!(picker.selected_heartbeat_id.as_deref(), Some("agent-1"));
    assert_eq!(picker.handle_key("up", &kb()), HeartbeatsPickerAction::None);
    assert_eq!(picker.selected_heartbeat_id.as_deref(), Some("user-1"));
}

#[test]
fn the_detail_pane_walks_its_action_rows() {
    let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
    picker.handle_key("enter", &kb());
    assert_eq!(
        picker.handle_key("down", &kb()),
        HeartbeatsPickerAction::None
    );
    assert_eq!(
        picker.mode,
        Mode::Detail {
            heartbeat_id: "user-1".to_string(),
            action_index: 1,
        }
    );
    assert_eq!(picker.handle_key("up", &kb()), HeartbeatsPickerAction::None);
    assert_eq!(
        picker.mode,
        Mode::Detail {
            heartbeat_id: "user-1".to_string(),
            action_index: 0,
        }
    );
}

#[test]
fn a_managed_job_replaces_or_removes_its_row() {
    let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
    picker.handle_key("down", &kb());
    let mut updated = picker.heartbeats[1].job.clone();
    updated.status = "paused".to_string();
    picker.apply_managed_job(updated, false);
    assert_eq!(picker.mode, Mode::List);
    assert!(picker
        .heartbeats
        .iter()
        .any(|entry| entry.job.id == "agent-1" && entry.job.status == "paused"));
    let id = picker.heartbeats[0].job.id.clone();
    let stopped = picker.heartbeats[0].job.clone();
    picker.apply_managed_job(stopped, true);
    assert!(picker.heartbeats.iter().all(|entry| entry.job.id != id));
    assert_eq!(
        picker.selected_heartbeat_id.as_deref(),
        picker.heartbeats.first().map(|entry| entry.job.id.as_str())
    );
}

#[test]
fn a_fetch_error_keeps_the_rows() {
    let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
    picker.set_fetch_error(Some("daemon busy".to_string()));
    assert_eq!(picker.heartbeats.len(), 2);
    assert_eq!(picker.fetch_error.as_deref(), Some("daemon busy"));
    let frame = picker.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(text
        .iter()
        .any(|row| row.contains("Heartbeat refresh failed: daemon busy")));
    assert!(text.iter().any(|row| row.contains("tick user-1")));
}

#[test]
fn a_catalog_refresh_keeps_the_surviving_selection() {
    let mut picker = HeartbeatsPicker::new(entries(), None, None, 24);
    picker.handle_key("down", &kb());
    assert_eq!(picker.selected_heartbeat_id.as_deref(), Some("agent-1"));
    let refreshed = picker.heartbeats.clone();
    picker.apply_catalog(refreshed, None);
    assert_eq!(picker.selected_heartbeat_id.as_deref(), Some("agent-1"));
    picker.apply_catalog(Vec::new(), Some("daemon down".to_string()));
    assert!(picker.heartbeats.is_empty());
    assert_eq!(picker.selected_heartbeat_id, None);
    let frame = picker.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    assert!(text
        .iter()
        .any(|row| row.contains("No running or paused heartbeats")));
    assert!(text
        .iter()
        .any(|row| row.contains("Heartbeat refresh failed: daemon down")));
}

#[test]
fn short_viewports_never_clip_the_panes() {
    for viewport_rows in [9usize, 10, 12, 14] {
        let picker = HeartbeatsPicker::new(entries(), None, None, viewport_rows);
        let frame = picker.render(&theme(), 70, &kb());
        assert!(
            frame.len() <= viewport_rows,
            "viewport {viewport_rows} fits: pane is {} rows",
            frame.len()
        );
        let text = frame_text(&frame);
        assert!(
            text.iter().any(|row| row.contains("Esc close")),
            "the hint survives a {viewport_rows}-row viewport"
        );
    }
    // The fixed rows (name, schedule, the two action rows, the hint) always render; the prompt and
    // pairs give way.
    let mut picker = HeartbeatsPicker::new(entries(), None, None, 12);
    picker.handle_key("enter", &kb());
    let frame = picker.render(&theme(), 70, &kb());
    assert!(frame.len() <= 12, "detail pane fits: {}", frame.len());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("Stop heartbeat")));
}

#[test]
fn a_long_prompt_clips_with_a_marker() {
    let mut catalog = entries();
    catalog[0].job.prompt = (1..=40)
        .map(|n| format!("word-{n:02}"))
        .collect::<Vec<_>>()
        .join(" ");
    // The schedule pair (item 3) rides the block too, so the prompt needs one more row than the
    // fixture budgeted.
    let mut picker = HeartbeatsPicker::new(catalog, None, None, 23);
    picker.handle_key("enter", &kb());
    let frame = picker.render(&theme(), 70, &kb());
    assert!(frame.len() <= 23, "the drill-in fits: {}", frame.len());
    let text = frame_text(&frame);
    assert!(
        text.iter().any(|row| row.trim() == "…"),
        "the clipped tail carries a marker: {text:?}"
    );
    let joined = text.join(" ");
    assert!(joined.contains("word-01"));
    assert!(!joined.contains("word-40"));
}

#[test]
fn a_missing_next_run_keeps_the_columns_aligned() {
    let mut catalog = entries();
    catalog[0].job.next_run_at = None;
    let picker = HeartbeatsPicker::new(catalog, None, None, 24);
    let frame = picker.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let row = text
        .iter()
        .find(|row| row.contains("every 10m"))
        .expect("the row");
    let header = text
        .iter()
        .find(|row| row.contains("Interval") && row.contains("Next run"))
        .expect("the header");
    // The display column is a CHAR offset (the glyphs before the status cell are multi-byte UTF-8;
    // a byte offset would misalign).
    let column_of =
        |text: &str, needle: &str| text.find(needle).map(|byte| text[..byte].chars().count());
    let (Some(h), Some(r)) = (column_of(header, "Status"), column_of(row, "\u{25d0}")) else {
        panic!("header and row status cells: {header:?} {row:?}");
    };
    assert_eq!(h, r, "the status column aligns: {header:?} vs {row:?}");
}

#[test]
fn the_pairs_shrink_before_the_prompt_starves() {
    let mut catalog = entries();
    catalog[0].job.status = "active".to_string();
    catalog[0].job.prompt = (1..=20)
        .map(|n| format!("word-{n:02}"))
        .collect::<Vec<_>>()
        .join(" ");
    let mut picker = HeartbeatsPicker::new(catalog, None, None, 19);
    picker.handle_key("enter", &kb());
    let frame = picker.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let joined = text.join(" ");
    assert!(
        joined.contains("word-01"),
        "the prompt's first line renders: {joined}"
    );
    assert!(
        joined.contains("Prompt"),
        "the prompt block label stays: {joined}"
    );
    assert!(frame.len() <= 19, "the pane fits: {}", frame.len());
}

#[test]
fn the_schedule_pair_never_hides_the_error_row() {
    let mut catalog = entries();
    catalog[0].job.last_error = Some("provider 429".to_string());
    catalog[0].job.schedule_expression = "*/2 * * * *".to_string();
    let mut picker = HeartbeatsPicker::new(catalog, None, None, 40);
    picker.handle_key("enter", &kb());
    let frame = picker.render(&theme(), 70, &kb());
    let text = frame_text(&frame);
    let joined = text.join("\n");
    assert!(
        joined.contains("every 2 minutes (*/2 * * * *)"),
        "the schedule fact rides its pair: {joined}"
    );
    assert!(
        joined.contains("last error"),
        "the error row stays in the block: {joined}"
    );
    assert!(
        joined.contains("provider 429"),
        "the error's value renders: {joined}"
    );
}

#[test]
fn a_one_row_prompt_budget_renders_the_first_line() {
    let mut catalog = entries();
    catalog[0].job.prompt = (1..=12)
        .map(|n| format!("word-{n:02}"))
        .collect::<Vec<_>>()
        .join(" ");
    // The schedule pair (item 3) rides the block too, so the one-row prompt budget needs one more
    // viewport row.
    let mut picker = HeartbeatsPicker::new(catalog, None, None, 20);
    picker.handle_key("enter", &kb());
    let frame = picker.render(&theme(), 70, &kb());
    assert!(frame.len() <= 20, "the drill-in fits: {}", frame.len());
    let text = frame_text(&frame);
    assert!(text.join(" ").contains("word-01"), "a prompt line renders");
    assert!(
        text.iter().filter(|row| row.trim() == "\u{2026}").count() == 0,
        "no lone marker: {text:?}"
    );
}

/// The scroll-indicator row is reserved exactly once: a scrolling viewport
/// uses every row it can hold (the frame constant excludes the conditional
/// indicator; `menu_list_layout` reserves it).
#[test]
fn a_scrolling_viewport_uses_every_row() {
    let mut catalog = entries();
    while catalog.len() < 10 {
        let mut extra = job_value(&format!("hb-{}", catalog.len()), "rlm_heartbeat", "active");
        extra["job"]["label"] = serde_json::json!(format!("job {}", catalog.len()));
        let job = parse_heartbeat_job(&extra["job"]).expect("job");
        catalog.push(HeartbeatEntry {
            job,
            session_name: None,
            first_message: None,
        });
    }
    let picker = HeartbeatsPicker::new(catalog, None, None, 12);
    let frame = picker.render(&theme(), 70, &kb());
    assert_eq!(
        frame.len(),
        12,
        "the scrolling pane spends the viewport exactly: {:#?}",
        frame
            .iter()
            .map(|line| line
                .iter()
                .map(|span| span.content.as_str())
                .collect::<String>())
            .collect::<Vec<_>>()
    );
}

#[test]
fn double_errors_reserve_both_footer_blocks() {
    let mut picker = HeartbeatsPicker::new(entries(), None, None, 14);
    picker.set_fetch_error(Some("daemon busy".to_string()));
    picker.set_action_error("management failed".to_string());
    let frame = picker.render(&theme(), 70, &kb());
    assert!(frame.len() <= 14, "the pane fits: {}", frame.len());
    let text = frame_text(&frame);
    assert!(text.iter().any(|row| row.contains("daemon busy")));
    assert!(text
        .iter()
        .any(|row| row.contains("Error: management failed")));
}

#[test]
fn a_sub_frame_viewport_never_overflows() {
    for viewport_rows in [1usize, 2, 3, 5, 7, 9] {
        let picker = HeartbeatsPicker::new(entries(), None, None, viewport_rows);
        let frame = picker.render(&theme(), 70, &kb());
        assert!(
            frame.len() <= viewport_rows,
            "viewport {viewport_rows}: pane is {} rows",
            frame.len()
        );
        let mut drill = HeartbeatsPicker::new(entries(), None, None, viewport_rows);
        drill.handle_key("enter", &kb());
        let frame = drill.render(&theme(), 70, &kb());
        assert!(
            frame.len() <= viewport_rows,
            "viewport {viewport_rows}: detail is {} rows",
            frame.len()
        );
    }
}

#[test]
fn an_escape_sequence_in_the_prompt_never_reaches_the_terminal() {
    let mut catalog = entries();
    catalog[0].job.prompt = "run \u{1b}[31mred\u{1b}[0m now".to_string();
    let mut picker = HeartbeatsPicker::new(catalog, None, None, 24);
    picker.handle_key("enter", &kb());
    let frame = picker.render(&theme(), 70, &kb());
    let joined = frame_text(&frame).join("\n");
    assert!(!joined.contains('\u{1b}'), "the escape scrubs: {joined:?}");
    assert!(joined.contains("red"), "the visible text stays");
}

/// Daemon-supplied catalog fields render inert: an ANSI/OSC sequence in a schedule, status, or
/// session label never reaches the terminal.
#[test]
fn catalog_control_sequences_scrub_at_the_parse_boundary() {
    let data = serde_json::json!({
        "heartbeats": [{
            "job": {
                "id": "esc-1",
                "status": "active\u{1b}[31m",
                "source": "heartbeat",
                "activeSessionId": "live-1",
                "sessionId": "sess-1",
                "prompt": "tick",
                "schedule": {"kind": "interval", "expression": "every 10m\u{1b}[2J"},
            },
            "sessionName": "\u{1b}]52;c;clipboard\u{7} the session",
        }]
    });
    let mut parsed = parse_heartbeats(&data);
    sort_heartbeats(&mut parsed);
    let picker = HeartbeatsPicker::new(parsed, None, None, 24);
    let frame = picker.render(&theme(), 70, &kb());
    let joined = frame_text(&frame).join("\n");
    assert!(
        !joined.contains('\u{1b}'),
        "no escapes reach the render: {joined:?}"
    );
    assert!(joined.contains("every 10m"), "the visible schedule stays");
    let data2 = serde_json::json!({
        "heartbeats": [{
            "job": {
                "id": "esc-1",
                "status": "active\u{1b}[31m",
                "source": "heartbeat",
                "activeSessionId": "live-1",
                "sessionId": "sess-1",
                "prompt": "tick",
                "schedule": {"kind": "interval", "expression": "every 10m\u{1b}[2J"},
            },
            "sessionName": "the session",
        }]
    });
    let mut catalog = parse_heartbeats(&data2);
    sort_heartbeats(&mut catalog);
    let mut drill = HeartbeatsPicker::new(catalog, None, None, 24);
    drill.handle_key("enter", &kb());
    let frame = drill.render(&theme(), 70, &kb());
    let joined = frame_text(&frame).join("\n");
    assert!(
        !joined.contains('\u{1b}'),
        "the drill-in stays inert: {joined:?}"
    );
}

#[test]
fn timestamps_cut_to_minutes_and_whitespace_collapses() {
    assert_eq!(
        format_timestamp("2026-01-02T03:04:05.000Z"),
        "2026-01-02 03:04"
    );
    assert_eq!(format_timestamp("not a date"), "not a date");
    assert_eq!(single_line("a  \n b\t c "), "a b c");
}
