/// The dock segments' column spans (the click regions, operator
/// directive 2026-09-29): each group's segment covers exactly its own
/// rendered cells — the separators between groups stay inert — in the
/// group order the row renders, and a truncated row keeps no region
/// for groups the truncation dropped.
#[test]
fn the_dock_segments_cover_each_groups_own_cells() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let dock = ActivityDock {
        subagents_running_direct: 2,
        heartbeats: 3,
        heartbeats_paused: 1,
        bash_running: 1,
        factory_group: true,
        ..ActivityDock::default()
    };
    let (frame, segments) = render_activity_dock_segments(&dock, &theme, 120);
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        text,
        " ◆ 2 subagents  ·  ◷ 3 heartbeats · ◐ 1 paused  ·  ▸ 1 shell  ·  ⚙ 0 factory"
    );
    let ordered: Vec<ActivityGroup> = segments.iter().map(|segment| segment.group).collect();
    assert_eq!(
        ordered,
        vec![
            ActivityGroup::Subagents,
            ActivityGroup::Heartbeats,
            ActivityGroup::Bash,
            ActivityGroup::Factory,
        ],
        "the segments follow the row's group order"
    );
    // Each segment covers exactly its own cells: the subagents segment
    // starts at the row's leading space end and ends before the
    // separator; the heartbeat segment covers the paused cluster too
    // (the cluster is the heartbeats group's own readout).
    let of = |text: &str| text.find(text).map(|_| 0);
    let _ = of;
    let subagents = &segments[0].cols;
    let heartbeats = &segments[1].cols;
    let bash = &segments[2].cols;
    // The recorded columns are display cells, and the row's glyphs are
    // one cell wide: slice the text by char, never by byte.
    let cells = |cols: &std::ops::Range<usize>| -> String {
        text.chars()
            .skip(cols.start)
            .take(cols.end - cols.start)
            .collect()
    };
    assert_eq!(cells(subagents), "◆ 2 subagents");
    assert_eq!(cells(heartbeats), "◷ 3 heartbeats · ◐ 1 paused");
    assert_eq!(cells(bash), "▸ 1 shell");
    // The separators between the segments stay inert.
    let between = |a: &std::ops::Range<usize>, b: &std::ops::Range<usize>| -> String {
        text.chars().skip(a.end).take(b.start - a.end).collect()
    };
    assert_eq!(between(subagents, heartbeats), "  ·  ");
    assert_eq!(between(heartbeats, bash), "  ·  ");
    // A truncation that drops the trailing group keeps no region for
    // it: the segments clamp to the row the terminal kept.
    let (frame, segments) = render_activity_dock_segments(&dock, &theme, 20);
    let used = crate::width::spans_width(&frame[1]);
    assert!(used <= 20, "the row truncates inside the width");
    for segment in &segments {
        assert!(
            segment.cols.start < used,
            "a dropped segment records no span"
        );
        assert!(segment.cols.end <= used);
    }
    // The goal group rides the segments when its row mounts.
    let dock = ActivityDock {
        goal_label: Some("Pursuing goal (0s)".to_string()),
        ..ActivityDock::default()
    };
    let (_, segments) = render_activity_dock_segments(&dock, &theme, 120);
    assert_eq!(
        segments.last().map(|segment| segment.group),
        Some(ActivityGroup::Goal)
    );
}

/// The tray's `← manage` hint reports its own cells (the click region,
/// operator directive 2026-09-29): the hint spans exactly the arrow and
/// the label — never the depth metadata beside them — and a tray whose
/// left label is an override or hidden reports none.
#[test]
fn the_tray_reports_the_manage_hints_own_cells() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let state = ChromeState {
        show_manage: true,
        tray_depth: Some(2),
        ..Default::default()
    };
    let (line, hint) = render_tray_with_hint(&state, &theme, 120);
    let hint = hint.expect("the manage hint reports its cells");
    let text = line
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        text.chars()
            .skip(hint.start)
            .take(hint.end - hint.start)
            .collect::<String>(),
        "\u{2190} manage"
    );
    assert_eq!(
        text.chars().skip(hint.end).take(2).collect::<String>(),
        "  ",
        "the depth label stays outside the hint's span"
    );
    // The override label replaces the hint: no region.
    let state = ChromeState {
        show_manage: true,
        tray_override: Some("Press ctrl+c again to exit".to_string()),
        ..Default::default()
    };
    let (_, hint) = render_tray_with_hint(&state, &theme, 120);
    assert_eq!(hint, None, "an override label carries no hint region");
    // A hidden hint (a non-attachable run) carries none either.
    let state = ChromeState::default();
    let (_, hint) = render_tray_with_hint(&state, &theme, 120);
    assert_eq!(hint, None, "a hidden manage hint carries no region");
}

#[test]
fn activity_dock_frames_one_row_with_running_paused_and_goal_counts() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let dock = ActivityDock {
        subagents_running_direct: 1,
        subagents_running_nested: 1,
        heartbeats: 3,
        heartbeats_paused: 1,
        bash_running: 1,
        factory_group: true,
        goal_label: Some("Pursuing goal (0s)".to_string()),
        ..ActivityDock::default()
    };
    // The heartbeat cluster and the goal label widen the row: the
    // fixture renders at 120 so the full line stays untruncated.
    let frame = render_activity_dock(&dock, &theme, 120);
    assert_eq!(frame.len(), 2, "a muted separator rule plus the row");
    let rule = frame[0]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(rule.chars().next(), Some('─'));
    assert_eq!(rule.chars().count(), 120);
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        text,
        " ◆ 2 subagents  ·  ◷ 3 heartbeats · ◐ 1 paused  ·  ▸ 1 shell  ·  ⚙ 0 factory  ·  Pursuing goal (0s)"
    );
    // The color-coding (the operator's 2026-09-24 directive): every
    // above-zero count segment and the active goal render green.
    let success = theme.fg_style(ThemeColor::Success).fg;
    let colored = |text: &str, color| {
        frame[1]
            .iter()
            .any(|span| span.content.contains(text) && span.style.fg == color)
    };
    assert!(colored("◆ 2 subagents", success));
    assert!(colored("◷ 3 heartbeats", success));
    assert!(colored("▸ 1 shell", success));
    assert!(colored("Pursuing goal", success));
    // A paused goal stays on the dock (the tray cluster is gone) in
    // the warning color — every live goal state keeps a surface.
    let dock = ActivityDock {
        goal_label: Some("Goal paused (0s)".to_string()),
        factory_group: true,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 100);
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    let warning = theme.fg_style(ThemeColor::Warning).fg;
    assert!(
        text.contains("Goal paused (0s)"),
        "the paused row renders: {text}"
    );
    assert!(
        frame[1]
            .iter()
            .any(|span| span.content.contains("Goal paused") && span.style.fg == warning),
        "the paused goal reads amber"
    );
    // A running count of zero still renders: a long idle roster must
    // read as quiet, not as uniformly busy — and the count segments
    // go neutral at zero.
    let dock = ActivityDock {
        heartbeats: 1,
        factory_group: true,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 100);
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        text,
        " ◆ 0 subagents  ·  ◷ 1 heartbeat  ·  ▸ 0 shells  ·  ⚙ 0 factory"
    );
    // The all-zero dock renders its own empty state — the zero
    // readout — and the zero segments stay neutral, never green. The
    // factory lane is advertised here (the unadvertised lane's row is
    // the pin of its own).
    let advertised = ActivityDock {
        factory_group: true,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&advertised, &theme, 100);
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        text,
        " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells  \u{b7}  \u{2699} 0 factory"
    );
    assert!(frame[1]
        .iter()
        .all(|span| span.style.fg != theme.fg_style(ThemeColor::Success).fg));
    // An overflowing row (every group plus the goal) truncates INSIDE
    // the width: the ellipsis reserves its own column, so the row
    // never renders past the terminal frame (the bot-round fix).
    let dock = ActivityDock {
        subagents_running_direct: 1,
        subagents_running_nested: 2,
        heartbeats: 4,
        heartbeats_paused: 2,
        bash_running: 2,
        goal_label: Some("Pursuing goal (12m 05s)".to_string()),
        ..ActivityDock::default()
    };
    for width in 20..=45 {
        let frame = render_activity_dock(&dock, &theme, width);
        let row = &frame[1];
        let used = crate::width::spans_width(row);
        assert!(
            used <= width,
            "the truncated row stays inside {width}: {used}"
        );
        let text = row
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(
            text.ends_with('\u{2026}'),
            "the truncation carries the ellipsis: {text:?}"
        );
    }
    // A row that fits whole keeps every character — the ellipsis
    // column is only borrowed when truncation actually happens.
    let frame = render_activity_dock(&dock, &theme, 120);
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert!(
        !text.contains('\u{2026}'),
        "the untruncated row keeps its characters: {text:?}"
    );
    assert!(text.contains("Pursuing goal (12m 05s)"));
}

/// The dock's subagents segment is one consolidated item (the
/// operator's `◆ x subagents` form): the count is the running
/// total — direct children and nested descendants summed into ONE
/// number (the operator's 2026-09-28 one-number ask; the 2026-09-25
/// `direct, nested` pair is gone) — never the descendant total and
/// never a category breakdown.
#[test]
fn prompt_bar_subagent_segment_is_the_running_count_only() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    // Two directly-running children, nothing nested: the readout is
    // the running total alone.
    let dock = ActivityDock {
        subagents_running_direct: 2,
        subagents_running_nested: 0,
        factory_group: true,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 80);
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        text,
        " ◆ 2 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells  ·  ⚙ 0 factory"
    );
    // Two running children plus seven running descendants: ONE
    // number — the summed total, never the pair, never the
    // descendant total, and no category breakdown.
    let dock = ActivityDock {
        subagents_running_direct: 2,
        subagents_running_nested: 7,
        factory_group: true,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 80);
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        text,
        " ◆ 9 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells  ·  ⚙ 0 factory"
    );
    assert!(!text.contains("2,"), "no direct/nested pair: {text}");
    assert!(!text.contains("idle"), "no category breakdown: {text}");
    assert!(
        !text.contains('5'),
        "the descendant total never renders: {text}"
    );
    // A single running descendant keeps the same shape.
    let dock = ActivityDock {
        subagents_running_direct: 0,
        subagents_running_nested: 1,
        factory_group: true,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 80);
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        text,
        " ◆ 1 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells  ·  ⚙ 0 factory"
    );
}

/// The focused dock's selection reads as the ONE shared selection
/// band (the operator's 2026-09-29 one-color ruling): the selection
/// paints the hover band's own light color — the same ONE color on
/// the dock's tab and the agents view's rows — never the accent,
/// across exactly the group's spans, while each span keeps its own
/// status color (the selection never repaints the text).
#[test]
fn activity_dock_selection_is_the_hover_colored_band() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let dock = ActivityDock {
        subagents_running_direct: 1,
        subagents_running_nested: 1,
        heartbeats: 3,
        heartbeats_paused: 1,
        bash_running: 1,
        factory_runs: 1,
        factory_group: true,
        goal_label: Some("Pursuing goal (0s)".to_string()),
        selected: ActivityGroup::Heartbeats,
        focused: true,
    };
    let frame = render_activity_dock(&dock, &theme, 120);
    let row = &frame[1];
    // The band is the theme's hover color (`Theme::hover_row_style`,
    // the one light wash — the operator's one-color ruling) with no
    // extra modifiers: the ONE style every activity surface's
    // selected row paints (`theme::selection_row_style`), never the
    // accent.
    let band = theme.selection_row_style();
    assert_eq!(band.bg, theme.hover_row_style().bg);
    assert_ne!(band.bg, theme.fg_style(ThemeColor::Accent).fg);
    assert!(band.add_modifier.is_empty());
    let span = |text: &str| {
        row.iter()
            .find(|span| span.content == text)
            .unwrap_or_else(|| panic!("missing span {text:?}"))
    };
    // The whole selected group carries the band while keeping its
    // own status colors: the running count stays success green, the
    // paused cluster stays amber, the in-group separator stays dim.
    let success = theme.fg_style(ThemeColor::Success).fg;
    let warning = theme.fg_style(ThemeColor::Warning).fg;
    let dim = theme.fg_style(ThemeColor::Dim).fg;
    assert_eq!(span("\u{25f7} 3 heartbeats").style.bg, band.bg);
    assert_eq!(span("\u{25f7} 3 heartbeats").style.fg, success);
    assert_eq!(span(" \u{b7} ").style.bg, band.bg);
    assert_eq!(span(" \u{b7} ").style.fg, dim);
    assert_eq!(span("\u{25d0} 1 paused").style.bg, band.bg);
    assert_eq!(span("\u{25d0} 1 paused").style.fg, warning);
    // The band rides exactly the selected group: the other groups
    // and the separators between them carry no band.
    let selected = ["\u{25f7} 3 heartbeats", " \u{b7} ", "\u{25d0} 1 paused"];
    for span in row {
        assert_eq!(
            span.style.bg == band.bg,
            selected.contains(&span.content.as_str()),
            "the band rides exactly the selected group: {:?}",
            span.content
        );
    }
    // The accent never rides the row as the band (the selection is
    // the hover's own light color).
    let accent = theme.fg_style(ThemeColor::Accent).fg;
    assert!(row.iter().all(|span| span.style.bg != accent));
    // The band is a focus-owned signal: the same dock without focus
    // renders no band at all.
    let unfocused = ActivityDock {
        focused: false,
        ..dock
    };
    let frame = render_activity_dock(&unfocused, &theme, 120);
    assert!(frame[1].iter().all(|span| span.style.bg.is_none()));
}

/// The arrows never skip an empty group (the operator's 2026-09-26
/// muscle-memory directive): one press steps to the neighboring
/// rendered group and wraps, so every group is visited in order
/// in both directions and N groups take exactly N presses to cycle.
#[test]
fn dock_arrows_visit_every_group_even_when_empty() {
    // The all-zero dock with the factory lane advertised: the
    // heartbeats, shells, and factory groups are empty and stay in
    // the cycle.
    let dock = ActivityDock {
        factory_group: true,
        ..ActivityDock::default()
    };
    assert_eq!(
        dock.groups(),
        vec![
            ActivityGroup::Subagents,
            ActivityGroup::Heartbeats,
            ActivityGroup::Bash,
            ActivityGroup::Factory,
        ]
    );
    // Right: the neighbors in order, the empty groups included,
    // wrapping back to the first.
    assert_eq!(
        dock.step(ActivityGroup::Subagents, ActivityDirection::Next),
        ActivityGroup::Heartbeats
    );
    assert_eq!(
        dock.step(ActivityGroup::Heartbeats, ActivityDirection::Next),
        ActivityGroup::Bash
    );
    assert_eq!(
        dock.step(ActivityGroup::Bash, ActivityDirection::Next),
        ActivityGroup::Factory
    );
    assert_eq!(
        dock.step(ActivityGroup::Factory, ActivityDirection::Next),
        ActivityGroup::Subagents,
        "the cycle wraps past the last group"
    );
    // Left: the same groups in reverse, wrapping past the first.
    assert_eq!(
        dock.step(ActivityGroup::Subagents, ActivityDirection::Prev),
        ActivityGroup::Factory,
        "the cycle wraps past the first group"
    );
    assert_eq!(
        dock.step(ActivityGroup::Factory, ActivityDirection::Prev),
        ActivityGroup::Bash
    );
    assert_eq!(
        dock.step(ActivityGroup::Bash, ActivityDirection::Prev),
        ActivityGroup::Heartbeats
    );
    assert_eq!(
        dock.step(ActivityGroup::Heartbeats, ActivityDirection::Prev),
        ActivityGroup::Subagents
    );
    // The press count is stable in both directions: N groups take
    // exactly N presses to return to the start, and no shorter run
    // does — the emptiness of a group never moves another.
    for direction in [ActivityDirection::Next, ActivityDirection::Prev] {
        let mut walked = ActivityGroup::Subagents;
        let rendered = dock.groups().len();
        for presses in 1..=rendered {
            walked = dock.step(walked, direction);
            assert_eq!(
                walked == ActivityGroup::Subagents,
                presses == rendered,
                "the cycle length is exactly the rendered group count"
            );
        }
    }
}

/// The same traversal with rows in every group: filling groups
/// changes only the rendered counts, never the group order, the
/// neighbors, or the press count.
#[test]
fn dock_arrows_visit_the_same_groups_with_items() {
    let dock = ActivityDock {
        subagents_running_direct: 1,
        subagents_running_nested: 2,
        heartbeats: 2,
        heartbeats_paused: 1,
        bash_running: 1,
        factory_group: true,
        goal_label: Some("Pursuing goal (0s)".to_string()),
        ..ActivityDock::default()
    };
    assert_eq!(
        dock.groups(),
        vec![
            ActivityGroup::Subagents,
            ActivityGroup::Heartbeats,
            ActivityGroup::Bash,
            ActivityGroup::Factory,
            ActivityGroup::Goal,
        ]
    );
    // The full cycle right: every group in order, the goal group
    // included, back to the start in five presses.
    let mut walked = ActivityGroup::Subagents;
    for expected in [
        ActivityGroup::Heartbeats,
        ActivityGroup::Bash,
        ActivityGroup::Factory,
        ActivityGroup::Goal,
        ActivityGroup::Subagents,
    ] {
        walked = dock.step(walked, ActivityDirection::Next);
        assert_eq!(walked, expected);
    }
    // The full cycle left mirrors it exactly.
    let mut walked = ActivityGroup::Subagents;
    for expected in [
        ActivityGroup::Goal,
        ActivityGroup::Factory,
        ActivityGroup::Bash,
        ActivityGroup::Heartbeats,
        ActivityGroup::Subagents,
    ] {
        walked = dock.step(walked, ActivityDirection::Prev);
        assert_eq!(walked, expected);
    }
}

/// The goal group unmounts with its row (its goal ended): the cycle
/// drops it, and a stale selection on it steps to a group the dock
/// still renders — never to a hidden segment.
#[test]
fn dock_goal_group_unmounts_with_its_row() {
    let with_goal = ActivityDock {
        goal_label: Some("Goal paused (0s)".to_string()),
        factory_group: true,
        ..ActivityDock::default()
    };
    assert!(with_goal.groups().contains(&ActivityGroup::Goal));
    let ended = ActivityDock {
        factory_group: true,
        ..ActivityDock::default()
    };
    assert!(
        !ended.groups().contains(&ActivityGroup::Goal),
        "the goal group leaves the cycle when its row unmounts"
    );
    assert_eq!(
        ended.step(ActivityGroup::Goal, ActivityDirection::Prev),
        ActivityGroup::Factory,
        "a stale goal selection lands on the row's last group"
    );
    assert_eq!(
        ended.step(ActivityGroup::Goal, ActivityDirection::Next),
        ActivityGroup::Heartbeats,
        "a stale goal selection steps from the row's first group"
    );
}

/// The factory group is the lane's opt-in surface: an unadvertised
/// `factory_activity` lane mounts no factory group anywhere — no row
/// segment, no traversal, no click region (the factory's default-off
/// gate; the dock's factory group renders exactly while the daemon
/// advertises the lane).
#[test]
fn an_unadvertised_factory_lane_mounts_no_factory_group() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    // The default dock is the unadvertised lane (the opt-in default).
    let dock = ActivityDock::default();
    assert!(
        !dock.groups().contains(&ActivityGroup::Factory),
        "the unadvertised lane stays out of the traversal cycle"
    );
    let (frame, segments) = render_activity_dock_segments(&dock, &theme, 120);
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        text, " ◆ 0 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells",
        "no factory segment renders: {text}"
    );
    assert!(
        segments
            .iter()
            .all(|segment| segment.group != ActivityGroup::Factory),
        "no factory click region records"
    );
    // The arrows wrap the remaining groups exactly: a stale Factory
    // selection steps to the row's real ends, never a hidden group.
    assert_eq!(
        dock.step(ActivityGroup::Bash, ActivityDirection::Next),
        ActivityGroup::Subagents,
        "the cycle wraps past the shells group"
    );
    assert_eq!(
        dock.step(ActivityGroup::Subagents, ActivityDirection::Prev),
        ActivityGroup::Bash,
        "the reverse cycle wraps past the subagents group"
    );
}

/// Entering an empty group still renders it: the focused selection's
/// band — the ONE shared selection style — rides the group's
/// zero-count segment on the row — the dock-level empty state is
/// the zero readout itself (the view the group opens carries the
/// pane's own empty-state row).
#[test]
fn dock_renders_the_focused_empty_group() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let dock = ActivityDock {
        selected: ActivityGroup::Heartbeats,
        focused: true,
        factory_group: true,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 100);
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        text,
        " ◆ 0 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells  ·  ⚙ 0 factory"
    );
    // The selection's band rides exactly the entered empty group's
    // zero readout, which keeps its own muted color (the selection
    // never repaints the text).
    let band = theme.selection_row_style();
    let muted = theme.fg_style(ThemeColor::Muted).fg;
    let heartbeat = frame[1]
        .iter()
        .find(|span| span.content == "◷ 0 heartbeats")
        .unwrap_or_else(|| panic!("the empty heartbeats readout renders: {text}"));
    assert_eq!(heartbeat.style.bg, band.bg);
    assert_eq!(heartbeat.style.fg, muted);
}

/// The `/speed` footer row (TS `FooterComponent::render`): one dim row
/// with the readout, truncated with no ellipsis when it overflows.
#[test]
fn speed_footer_is_one_dim_row_truncated_to_width() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let row = render_speed_footer("188 tok/s · avg 200", &theme, 100);
    let text = row
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(text, "188 tok/s · avg 200");
    assert_eq!(row.len(), 1);
    let narrow = render_speed_footer("188 tok/s · avg 200", &theme, 10);
    let text = narrow
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(text.chars().count(), 10);
    assert!(!text.contains("…"));
}

use super::*;
use crate::theme::{ColorMode, Theme};
use serde_json::json;

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

#[test]
fn token_count_formats() {
    assert_eq!(format_token_count(999), "999");
    assert_eq!(format_token_count(6_123), "6.1k");
    assert_eq!(format_token_count(61_234), "61k");
    assert_eq!(format_token_count(1_234_567), "1.2M");
}

#[test]
fn splash_renders_logo_version_model_and_cwd() {
    let state = ChromeState {
        version: "0.0.0".to_string(),
        cwd: "/tmp/project".to_string(),
        model_id: Some("faux-1".to_string()),
        ..Default::default()
    };
    let lines = render_splash(&state, &theme(), 120);
    assert_eq!(lines[0], Vec::new());
    let text = |line: &Line| line.iter().map(|s| s.content.as_str()).collect::<String>();
    assert!(lines.iter().any(|l| text(l).contains("prime agent v0.0.0")));
    assert!(lines.iter().any(|l| text(l).contains("model faux-1")));
    assert!(lines.iter().any(|l| text(l).contains("cwd /tmp/project")));
    assert!(lines
        .iter()
        .any(|l| text(l).contains("\u{2597}\u{2584}\u{2584}")));
}

#[test]
fn top_bar_centers_name_with_cost() {
    let state = ChromeState {
        chat_name: "shared-cwd".to_string(),
        cost_usd: Some(0.0),
        ..Default::default()
    };
    let line = render_top_bar(&state, &theme(), 120);
    let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
    assert!(text.contains("shared-cwd  $0.00"));
    let start = text.find("shared-cwd").unwrap();
    assert_eq!(start, 55);
}

#[test]
fn tray_left_and_right_labels() {
    let state = ChromeState {
        show_manage: true,
        model_id: Some("faux-1".to_string()),
        context: Some(ContextUsage {
            tokens: 6_123,
            context_window: 128_000,
        }),
        ..Default::default()
    };
    let line = render_tray(&state, &theme(), 120);
    let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
    assert!(text.starts_with("\u{2190} manage"));
    assert!(text.contains("faux-1 \u{00b7} 6.1k (5%)"));
    assert_eq!(str_width(&text), 120);
}

/// The tray's tier badge (TS footer badge, #2144): `fast` for the
/// priority tier, the tier name for any other non-default tier, and
/// nothing for `default` or an unset tier.
#[test]
fn tray_service_tier_badge_follows_the_ts_shape() {
    let state = |tier: Option<&str>| ChromeState {
        model_id: Some("gpt-5.5".to_string()),
        service_tier: tier.map(str::to_string),
        ..Default::default()
    };
    let badge = |tier: Option<&str>| {
        let line = render_tray(&state(tier), &theme(), 120);
        line.iter().map(|s| s.content.as_str()).collect::<String>()
    };
    assert!(
        badge(Some("priority")).contains("gpt-5.5 \u{00b7} fast"),
        "priority renders the fast token"
    );
    assert!(
        badge(Some("flex")).contains("gpt-5.5 \u{00b7} flex"),
        "a non-default tier renders its name"
    );
    for tier in [Some("default"), None] {
        let text = badge(tier);
        assert!(!text.contains(" \u{00b7} "), "{tier:?} renders no badge");
    }
}

/// TS `getModelContextLabel`: the effort suffix is the state's
/// `thinkingLevel` behind the model's `reasoning` gate — a level on a
/// reasoning model renders, everything else keeps the bare id.
#[test]
fn effort_suffix_gates_on_model_reasoning() {
    let reasoning = json!({
        "model": { "id": "faux-1", "provider": "faux", "reasoning": true },
        "thinkingLevel": "high",
    });
    assert_eq!(
        tray_thinking_suffix(&reasoning),
        Some("high".to_string()),
        "a reasoning model's session level renders as the suffix"
    );
    let plain = json!({
        "model": { "id": "faux-1", "provider": "faux", "reasoning": false },
        "thinkingLevel": "high",
    });
    assert_eq!(
        tray_thinking_suffix(&plain),
        None,
        "no reasoning, no suffix"
    );
    assert_eq!(
        tray_thinking_suffix(&json!({ "thinkingLevel": "high" })),
        None,
        "no model block, no suffix"
    );
    let unknown = json!({
        "model": { "id": "faux-1", "provider": "faux", "reasoning": true },
        "thinkingLevel": "default",
    });
    assert_eq!(
        tray_thinking_suffix(&unknown),
        None,
        "a level outside the wire vocabulary keeps the bare id"
    );
    let off = json!({
        "model": { "id": "faux-1", "provider": "faux", "reasoning": true },
        "thinkingLevel": "off",
    });
    assert_eq!(
        tray_thinking_suffix(&off),
        Some("off".to_string()),
        "an explicit off renders `model:off` like the TS tray"
    );
}

/// The tray renders `model:effort` with a suffix and the bare model id
/// without one (TS `getModelContextLabel`'s two arms).
#[test]
fn tray_renders_the_effort_suffix_and_the_bare_id_without_it() {
    let mut state = ChromeState {
        show_manage: true,
        model_id: Some("faux-1".to_string()),
        thinking_suffix: Some("high".to_string()),
        ..Default::default()
    };
    let line = render_tray(&state, &theme(), 120);
    let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
    assert!(
        text.contains("faux-1:high"),
        "the effort suffix rides the id: {text}"
    );
    state.thinking_suffix = None;
    let line = render_tray(&state, &theme(), 120);
    let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
    assert!(text.contains("faux-1"), "the bare id still renders: {text}");
    assert!(!text.contains("faux-1:"), "no suffix, no colon: {text}");
}

/// The tray (the line below the prompt bar) never carries the goal
/// label (the operator's 2026-09-24 directive: "pursuing goal should
/// not show up in the line below prompt bar") — the goal lives in
/// the activity dock below, and the tray joins model straight to
/// context.
#[test]
fn tray_never_repeats_the_heartbeat_counts() {
    let state = ChromeState {
        show_manage: true,
        model_id: Some("mock-1".to_string()),
        context: Some(ContextUsage {
            tokens: 190,
            context_window: 128_000,
        }),
        ..Default::default()
    };
    let line = render_tray(&state, &theme(), 120);
    let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
    assert!(text.contains("mock-1 \u{b7} 190 (0%)"));
    assert!(!text.contains("Pursuing goal"));
    assert!(!text.contains("goal"));
    assert!(!text.contains("heartbeat"));
    assert!(!text.contains("Ctrl+R"));
    assert_eq!(str_width(&text), 120);
}

#[test]
fn tray_override_replaces_location_label() {
    let state = ChromeState {
        show_manage: true,
        tray_override: Some("Press Ctrl+C again to exit".to_string()),
        model_id: Some("faux-1".to_string()),
        ..Default::default()
    };
    let line = render_tray(&state, &theme(), 120);
    let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
    assert!(text.starts_with("Press Ctrl+C again to exit"));
    assert!(!text.contains("manage"));
}

#[test]
fn detail_status_label() {
    assert_eq!(
        conversation_detail_status(false, false, "Ctrl+O"),
        "Collapsed mode (Ctrl+O to expand)"
    );
    assert_eq!(
        conversation_detail_status(false, true, "Ctrl+O"),
        "Details mode (Ctrl+O to expand)"
    );
    assert_eq!(
        conversation_detail_status(true, true, "Ctrl+O"),
        "Expanded mode (Ctrl+O to collapse)"
    );
}
