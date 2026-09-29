#[test]
fn activity_dock_frames_one_row_with_running_paused_and_goal_counts() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let dock = ActivityDock {
        subagents_running_direct: 1,
        subagents_running_nested: 1,
        heartbeats: 3,
        heartbeats_paused: 1,
        bash_running: 1,
        bash_total: 2,
        goal_label: Some("Pursuing goal (0s)".to_string()),
        ..ActivityDock::default()
    };
    // The heartbeat cluster and the goal label widen the row: the
    // fixture renders at 120 so the full line stays untruncated.
    let frame = render_activity_dock(&dock, &theme, 120).unwrap();
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
        " ◆ 2 subagents  ·  ◷ 3 heartbeats · ◐ 1 paused  ·  ▸ 1 shell  ·  Pursuing goal (0s)"
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
        subagents_total: 1,
        goal_label: Some("Goal paused (0s)".to_string()),
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 100).unwrap();
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
        subagents_total: 2,
        heartbeats: 1,
        bash_total: 3,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 100).unwrap();
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(text, " ◆ 0 subagents  ·  ◷ 1 heartbeat  ·  ▸ 0 shells");
    // A dead-only roster keeps the dock mounted and its Subagents
    // group selectable (finished subagents are browsable history):
    // the rendered count stays running-only and reads zero.
    let dock = ActivityDock {
        subagents_total: 154,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 100).unwrap();
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        text,
        " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells"
    );
    // The zero segments stay neutral, never green.
    assert!(frame[1]
        .iter()
        .all(|span| span.style.fg != theme.fg_style(ThemeColor::Success).fg));
    // Finished-only bash rows keep the dock mounted (the bash view's
    // history stays reachable) while the indicator reads zero live
    // runs.
    let dock = ActivityDock {
        bash_total: 2,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 100).unwrap();
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert!(text.contains("▸ 0 shells"));
    assert!(render_activity_dock(&ActivityDock::default(), &theme, 100).is_none());
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
        let frame = render_activity_dock(&dock, &theme, width).unwrap();
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
    let frame = render_activity_dock(&dock, &theme, 120).unwrap();
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
        subagents_total: 40,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 80).unwrap();
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(text, " ◆ 2 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells");
    // Two running children plus seven running descendants: ONE
    // number — the summed total, never the pair, never the
    // descendant total, and no category breakdown.
    let dock = ActivityDock {
        subagents_running_direct: 2,
        subagents_running_nested: 7,
        subagents_total: 50,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 80).unwrap();
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(text, " ◆ 9 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells");
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
        subagents_total: 1,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 80).unwrap();
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(text, " ◆ 1 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells");
    // A quiet roster (history but nothing running) keeps the plain
    // zero readout — the running count only renders while work
    // runs.
    let dock = ActivityDock {
        subagents_total: 5,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 80).unwrap();
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(text, " ◆ 0 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells");
}

/// The focused dock's selection reads as the ONE shared selection
/// band (the operator's 2026-09-28 visibility and consistency
/// directives): the accent purple restored as a FULLY OPAQUE
/// background — the 2026-09-26 dark-green `ToolSuccessBg` band read
/// near-invisible — with the selected group's text bold, across
/// exactly the group's spans, while each span keeps its own status
/// color (the selection never repaints the text).
#[test]
fn activity_dock_selection_is_the_purple_opaque_bold_band() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let dock = ActivityDock {
        subagents_running_direct: 1,
        subagents_running_nested: 1,
        subagents_total: 2,
        heartbeats: 3,
        heartbeats_paused: 1,
        bash_running: 1,
        bash_total: 2,
        goal_label: Some("Pursuing goal (0s)".to_string()),
        selected: ActivityGroup::Heartbeats,
        focused: true,
    };
    let frame = render_activity_dock(&dock, &theme, 120).unwrap();
    let row = &frame[1];
    // The band is the theme's accent purple (prime #7c6faf — the
    // original selection shade) at FULL opacity, with bold text:
    // the ONE style every activity surface's selected row paints
    // (`theme::selection_row_style`), never the 2026-09-26
    // dark-green panel background.
    let band = theme.selection_row_style();
    assert_eq!(band.bg, Some(Color::Rgb(0x7c, 0x6f, 0xaf)));
    assert!(band.add_modifier.contains(Modifier::BOLD));
    let span = |text: &str| {
        row.iter()
            .find(|span| span.content == text)
            .unwrap_or_else(|| panic!("missing span {text:?}"))
    };
    // The whole selected group carries the band and the bold
    // modifier while keeping its own status colors: the running
    // count stays success green, the paused cluster stays amber,
    // the in-group separator stays dim.
    let success = theme.fg_style(ThemeColor::Success).fg;
    let warning = theme.fg_style(ThemeColor::Warning).fg;
    let dim = theme.fg_style(ThemeColor::Dim).fg;
    assert_eq!(span("\u{25f7} 3 heartbeats").style.bg, band.bg);
    assert_eq!(span("\u{25f7} 3 heartbeats").style.fg, success);
    assert!(span("\u{25f7} 3 heartbeats")
        .style
        .add_modifier
        .contains(Modifier::BOLD));
    assert_eq!(span(" \u{b7} ").style.bg, band.bg);
    assert_eq!(span(" \u{b7} ").style.fg, dim);
    assert_eq!(span("\u{25d0} 1 paused").style.bg, band.bg);
    assert_eq!(span("\u{25d0} 1 paused").style.fg, warning);
    assert!(span("\u{25d0} 1 paused")
        .style
        .add_modifier
        .contains(Modifier::BOLD));
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
    // The band is a focus-owned signal: the same dock without focus
    // renders no band at all.
    let unfocused = ActivityDock {
        focused: false,
        ..dock
    };
    let frame = render_activity_dock(&unfocused, &theme, 120).unwrap();
    assert!(frame[1].iter().all(|span| span.style.bg.is_none()));
}

/// The arrows never skip an empty group (the operator's 2026-09-26
/// muscle-memory directive): one press steps to the neighboring
/// rendered group and wraps, so every group is visited in order
/// in both directions and N groups take exactly N presses to cycle.
#[test]
fn dock_arrows_visit_every_group_even_when_empty() {
    // A dock mounted by subagent history alone: the heartbeats and
    // shells groups are empty and stay in the cycle.
    let dock = ActivityDock {
        subagents_total: 1,
        ..ActivityDock::default()
    };
    assert_eq!(
        dock.groups(),
        vec![
            ActivityGroup::Subagents,
            ActivityGroup::Heartbeats,
            ActivityGroup::Bash,
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
        ActivityGroup::Subagents,
        "the cycle wraps past the last group"
    );
    // Left: the same groups in reverse, wrapping past the first.
    assert_eq!(
        dock.step(ActivityGroup::Subagents, ActivityDirection::Prev),
        ActivityGroup::Bash,
        "the cycle wraps past the first group"
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
        subagents_total: 3,
        heartbeats: 2,
        heartbeats_paused: 1,
        bash_running: 1,
        bash_total: 2,
        goal_label: Some("Pursuing goal (0s)".to_string()),
        ..ActivityDock::default()
    };
    assert_eq!(
        dock.groups(),
        vec![
            ActivityGroup::Subagents,
            ActivityGroup::Heartbeats,
            ActivityGroup::Bash,
            ActivityGroup::Goal,
        ]
    );
    // The full cycle right: every group in order, the goal group
    // included, back to the start in four presses.
    let mut walked = ActivityGroup::Subagents;
    for expected in [
        ActivityGroup::Heartbeats,
        ActivityGroup::Bash,
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
        ..ActivityDock::default()
    };
    assert!(with_goal.groups().contains(&ActivityGroup::Goal));
    let ended = ActivityDock::default();
    assert!(
        !ended.groups().contains(&ActivityGroup::Goal),
        "the goal group leaves the cycle when its row unmounts"
    );
    assert_eq!(
        ended.step(ActivityGroup::Goal, ActivityDirection::Prev),
        ActivityGroup::Bash,
        "a stale goal selection lands on the row's last group"
    );
    assert_eq!(
        ended.step(ActivityGroup::Goal, ActivityDirection::Next),
        ActivityGroup::Heartbeats,
        "a stale goal selection steps from the row's first group"
    );
}

/// Entering an empty group still renders it: the focused selection's
/// band — the ONE shared purple selection style — rides the group's
/// zero-count segment on the row — the dock-level empty state is
/// the zero readout itself (the view the group opens carries the
/// pane's own empty-state row).
#[test]
fn dock_renders_the_focused_empty_group() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let dock = ActivityDock {
        subagents_total: 2,
        selected: ActivityGroup::Heartbeats,
        focused: true,
        ..ActivityDock::default()
    };
    let frame = render_activity_dock(&dock, &theme, 100).unwrap();
    let text = frame[1]
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(text, " ◆ 0 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells");
    // The selection's band rides exactly the entered empty group's
    // zero readout, which keeps its own muted color and gains the
    // shared style's bold (the selection never repaints the text).
    let band = theme.selection_row_style();
    let muted = theme.fg_style(ThemeColor::Muted).fg;
    let heartbeat = frame[1]
        .iter()
        .find(|span| span.content == "◷ 0 heartbeats")
        .unwrap_or_else(|| panic!("the empty heartbeats readout renders: {text}"));
    assert_eq!(heartbeat.style.bg, band.bg);
    assert_eq!(heartbeat.style.fg, muted);
    assert!(heartbeat.style.add_modifier.contains(Modifier::BOLD));
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
use ratatui::style::{Color, Modifier};
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

/// The title's own + subagent aggregate pair (the operator's ask):
/// both values render in the details-view cost format with the
/// labeled `(subagents)` suffix on the aggregate.
#[test]
fn top_bar_trails_the_subagent_aggregate_beside_the_own_cost() {
    let state = ChromeState {
        chat_name: "orchestrator".to_string(),
        cost_usd: Some(58.1),
        subagents_cost_usd: Some(94.36),
        ..Default::default()
    };
    let line = render_top_bar(&state, &theme(), 120);
    let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
    assert!(
        text.contains("orchestrator  $58.10 + $94.36 (subagents)"),
        "the pair renders: {text}"
    );
}

/// A zero aggregate (no subagents, or subagents with no spend)
/// omits the suffix cleanly: the title shows the own cost alone,
/// exactly like a session that never spawned.
#[test]
fn top_bar_omits_the_subagent_suffix_at_zero() {
    for subagents in [None, Some(0.0)] {
        let state = ChromeState {
            chat_name: "solo".to_string(),
            cost_usd: Some(1.0),
            subagents_cost_usd: subagents,
            ..Default::default()
        };
        let line = render_top_bar(&state, &theme(), 120);
        let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
        assert!(text.contains("solo  $1.00"), "the own cost: {text}");
        assert!(!text.contains("subagents"), "no suffix at zero: {text}");
    }
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
