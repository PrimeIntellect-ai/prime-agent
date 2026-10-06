use super::*;
use crate::theme::ColorMode;

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

fn queue() -> QueuedMessages {
    QueuedMessages {
        steering: vec!["turn right".to_string()],
        follow_ups: vec!["then summarize".to_string()],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    }
}

#[test]
fn empty_queue_renders_no_rows() {
    assert!(render_queue(&theme(), &QueuedMessages::default(), "alt+up", 80).is_empty());
}

/// A picked-up prompt leaves its lane at delivery (RES-1306): while its turn prepares the strip is
/// the only place it is visible — the "Starting" row, never with the browse hint.
#[test]
fn a_preparing_turn_renders_the_starting_row_alone() {
    let queue = QueuedMessages {
        steering: Vec::new(),
        follow_ups: Vec::new(),
        starting: Some("queued before compaction".to_string()),
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(rows.len(), 2, "spacer + the starting row, no hint");
    let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(text.trim(), "Starting: queued before compaction");
}

/// The "Starting" row renders above the parked lanes; the hint follows the parked lanes as before.
#[test]
fn the_starting_row_renders_above_the_parked_lanes() {
    let queue = QueuedMessages {
        steering: Vec::new(),
        follow_ups: vec!["then summarize".to_string()],
        starting: Some("queued before compaction".to_string()),
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(rows.len(), 4, "spacer + starting + follow-up + hint");
    let starting: String = rows[1].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(starting.trim(), "Starting: queued before compaction");
    let follow_up: String = rows[2].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(follow_up.trim(), "Follow-up: then summarize");
    assert!(crate::ansi::line_to_ansi(&rows[3]).contains("to browse and edit queued messages"));
}

/// The strip drops the "Starting" row the moment the projection no longer reports a preparing turn.
#[test]
fn the_starting_row_drops_with_the_projection() {
    let rows = render_queue(
        &theme(),
        &QueuedMessages {
            steering: Vec::new(),
            follow_ups: Vec::new(),
            starting: None,
            rlm_child_status: QueueLaneIndices::default(),
            injected_prompts: QueueLaneIndices::default(),
        },
        "alt+up",
        80,
    );
    assert!(rows.is_empty());
}

#[test]
fn queue_renders_labels_and_hint() {
    let rows = render_queue(&theme(), &queue(), "alt+up", 80);
    assert_eq!(rows.len(), 4, "spacer + two previews + hint");
    let expected: crate::Line = crate::width::pad_line(
        vec![
            crate::Span::raw(" "),
            crate::Span::styled(
                "Steering: turn right".to_string(),
                theme().fg_style(ThemeColor::Dim),
            ),
        ],
        80,
    );
    assert_eq!(
        rows[1], expected,
        "the steering preview is indented, dim, labeled and padded"
    );
    assert!(crate::ansi::line_to_ansi(&rows[2]).contains("Follow-up: then summarize"));
    let expected_hint: crate::Line = crate::width::pad_line(
        vec![
            crate::Span::raw(" "),
            crate::Span::styled(
                "\u{2570}\u{2500} alt+up to browse and edit queued messages".to_string(),
                theme().fg_style(ThemeColor::Dim),
            ),
        ],
        80,
    );
    assert_eq!(rows[3], expected_hint, "the hint row matches TS");
}

#[test]
fn slash_previews_render_the_command_segment_in_accent() {
    let queue = QueuedMessages {
        steering: vec!["/hotkeys".to_string()],
        follow_ups: vec!["fix @Cargo.toml --quiet".to_string()],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let theme = theme();
    let rows = render_queue(&theme, &queue, "alt+up", 80);
    assert_eq!(rows.len(), 4);
    let expected_command: crate::Line = crate::width::pad_line(
        vec![
            crate::Span::raw(" "),
            theme.fg_span(ThemeColor::Dim, "Steering: "),
            theme.fg_span(ThemeColor::Accent, "/hotkeys"),
        ],
        80,
    );
    assert_eq!(
        rows[1], expected_command,
        "a recognized command previews dim-labeled with its accent segment"
    );
    let expected_plain: crate::Line = crate::width::pad_line(
        vec![
            crate::Span::raw(" "),
            theme.fg_span(ThemeColor::Dim, "Follow-up: fix "),
            theme.fg_span(ThemeColor::Success, "@Cargo.toml"),
            theme.fg_span(ThemeColor::Dim, " "),
            theme.fg_span(ThemeColor::MdLink, "--quiet"),
        ],
        80,
    );
    assert_eq!(
        rows[2], expected_plain,
        "a plain preview stays dim with its argument tokens colored"
    );
}

#[test]
fn long_previews_truncate_with_ellipsis() {
    let queue = QueuedMessages {
        steering: vec!["x".repeat(100)],
        follow_ups: Vec::new(),
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 30);
    assert_eq!(rows.len(), 3);
    let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
    // The row pads to the width like TS (a trailing pad column follows the
    // ellipsis), so the check strips the pad.
    assert!(
        text.trim_end().ends_with("..."),
        "truncated with ellipsis: {text}"
    );
    assert!(
        crate::width::line_width(&rows[1]) <= 30,
        "row fits the width"
    );
}

#[test]
fn multiline_preview_renders_its_first_line() {
    let queue = QueuedMessages {
        steering: vec!["first line\nsecond line".to_string()],
        follow_ups: Vec::new(),
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(text.trim(), "Steering: first line");
}

#[test]
fn labeled_internal_prompts_keep_their_own_label() {
    assert_eq!(
        format_queued_message_preview("Heartbeat prompt: tick", STEERING_LABEL),
        "Heartbeat prompt: tick"
    );
    assert_eq!(
        format_queued_message_preview("run tests", FOLLOW_UP_LABEL),
        "Follow-up: run tests"
    );
    // Internal prompts never render as preview rows (the condensation tests own it).
}

#[test]
fn internal_prompts_condense_into_one_counted_row() {
    let queue = QueuedMessages {
        steering: vec![
            "Heartbeat prompt: [heartbeat: every 10m run#0]\n\nnudge".to_string(),
            "Agent message received: the research is done".to_string(),
        ],
        follow_ups: vec!["Goal context: milestone".to_string()],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(
        rows.len(),
        3,
        "spacer + the one condensed row + hint, no per-prompt rows"
    );
    let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(
        text.trim(),
        "1 agent message, 1 heartbeat, and 1 other internal prompt queued",
        "one line counts each origin across both lanes, each singular"
    );
    let joined = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !joined.contains("nudge") && !joined.contains("research") && !joined.contains("milestone"),
        "the internal prompts' content never reaches the strip: {joined}"
    );
}

#[test]
fn human_prompts_render_before_the_condensed_row() {
    let queue = QueuedMessages {
        steering: vec![
            "Heartbeat prompt: nudge".to_string(),
            "turn right".to_string(),
        ],
        follow_ups: vec![
            "then summarize".to_string(),
            "Background command finished: sleep done".to_string(),
        ],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(
        rows.len(),
        5,
        "spacer + two human previews + condensed + hint"
    );
    let texts: Vec<String> = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect();
    assert_eq!(texts[1].trim(), "Steering: turn right");
    assert_eq!(texts[2].trim(), "Follow-up: then summarize");
    assert_eq!(
        texts[3].trim(),
        "1 heartbeat and 1 other internal prompt queued",
        "the counts name the queued origins only - no agent message queued"
    );
    assert!(
        texts[4]
            .trim()
            .starts_with("\u{2570}\u{2500} alt+up to browse"),
        "the hint stays the strip's last row"
    );
}

#[test]
fn condensed_row_counts_each_origin_with_correct_plurals() {
    let queue = QueuedMessages {
        steering: vec![
            "Agent message received: one".to_string(),
            "Agent message received: two".to_string(),
            "Agent message received: three".to_string(),
            "Heartbeat prompt: nudge".to_string(),
            "Goal context: milestone".to_string(),
            "Goal context: next".to_string(),
        ],
        follow_ups: vec!["Heartbeat prompt: again".to_string()],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(rows.len(), 3);
    let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(
        text.trim(),
        "3 agent messages, 2 heartbeats, and 2 other internal prompts queued",
        "each origin's count sums across both lanes and pluralizes"
    );
}

#[test]
fn one_queued_agent_message_reads_singular() {
    let queue = QueuedMessages {
        steering: vec!["Agent message received: hi".to_string()],
        follow_ups: Vec::new(),
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(rows.len(), 3);
    let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(text.trim(), "1 agent message queued");
}

#[test]
fn condensed_row_truncates_to_the_width() {
    let queue = QueuedMessages {
        steering: vec![
            "Heartbeat prompt: nudge".to_string(),
            "Agent message received: done".to_string(),
        ],
        follow_ups: vec![],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 30);
    assert_eq!(rows.len(), 3);
    let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
    assert!(
        text.trim_end().ends_with("..."),
        "the condensed row truncates with an ellipsis: {text}"
    );
    assert!(
        crate::width::line_width(&rows[1]) <= 30,
        "the row fits the width"
    );
}

#[test]
fn internal_prompts_stay_browseable_when_condensed() {
    let queue = QueuedMessages {
        steering: vec![
            "Heartbeat prompt: nudge".to_string(),
            "turn right".to_string(),
        ],
        follow_ups: vec!["then summarize".to_string()],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let mut selection = QueueSelection::default();
    // Browsing still walks every queued item newest-first, the condensed
    // internal prompt included: draft -> follow-up -> steering, newest to oldest.
    let text = selection.browse(&queue, "draft", QueueBrowseDirection::Older);
    assert_eq!(text.as_deref(), Some("then summarize"));
    let text = selection.browse(&queue, "", QueueBrowseDirection::Older);
    assert_eq!(text.as_deref(), Some("turn right"));
    let text = selection.browse(&queue, "", QueueBrowseDirection::Older);
    assert_eq!(text.as_deref(), Some("Heartbeat prompt: nudge"));
}

#[test]
fn browse_walks_newest_first_and_ends_on_the_draft() {
    let mut selection = QueueSelection::default();
    let text = selection.browse(&queue(), "current draft", QueueBrowseDirection::Older);
    assert_eq!(text.as_deref(), Some("then summarize"));
    assert!(selection.is_browsing());
    assert_eq!(selection.selected().map(|item| item.text.clone()), text);
    let text = selection.browse(&queue(), "", QueueBrowseDirection::Older);
    assert_eq!(text.as_deref(), Some("turn right"));
    let text = selection.browse(&queue(), "", QueueBrowseDirection::Older);
    assert_eq!(
        text, None,
        "older than the oldest steering message is a noop"
    );
    let text = selection.browse(&queue(), "", QueueBrowseDirection::Newer);
    assert_eq!(text.as_deref(), Some("then summarize"));
    let text = selection.browse(&queue(), "", QueueBrowseDirection::Newer);
    assert_eq!(text.as_deref(), Some("current draft"));
    assert!(!selection.is_browsing());
    let text = selection.browse(&queue(), "current draft", QueueBrowseDirection::Newer);
    assert_eq!(text, None, "newer than the draft is a noop");
}

#[test]
fn browse_stashes_the_draft_once_and_reset_returns_it() {
    let mut selection = QueueSelection::default();
    selection.browse(&queue(), "draft one", QueueBrowseDirection::Older);
    assert!(selection.has_draft());
    // A deeper browse ignores the editor text: the stash keeps the draft the browse left.
    selection.browse(&queue(), "", QueueBrowseDirection::Older);
    // Walking back to the draft restores the stashed draft and clears the stash.
    selection.browse(&queue(), "", QueueBrowseDirection::Newer);
    let restored = selection.browse(&queue(), "", QueueBrowseDirection::Newer);
    assert_eq!(restored.as_deref(), Some("draft one"));
    assert!(!selection.is_browsing());
    assert!(!selection.has_draft());
    selection.browse(&queue(), "fresh draft", QueueBrowseDirection::Older);
    assert_eq!(selection.reset(), "fresh draft");
    assert!(!selection.has_draft());
}

#[test]
fn refresh_keeps_a_matching_selection_and_drops_a_stale_one() {
    let mut selection = QueueSelection::default();
    selection.browse(&queue(), "draft", QueueBrowseDirection::Older);
    assert_eq!(
        selection.selected().map(|i| (i.lane, i.index)),
        Some((QueueLane::FollowUp, 0))
    );
    assert_eq!(
        selection.refresh_at(&queue(), QueueLane::FollowUp, 0, "then summarize"),
        None
    );
    assert_eq!(selection.selected().map(|item| item.index), Some(0));
    // A moved item (queue changed) drops the selection and returns the stashed draft.
    let changed = QueuedMessages {
        steering: vec!["turn right".to_string()],
        follow_ups: vec!["edited".to_string()],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    assert_eq!(
        selection.refresh_at(&changed, QueueLane::FollowUp, 0, "then summarize"),
        Some("draft".to_string())
    );
    assert!(!selection.is_browsing());
}

#[test]
fn mirror_lane_move_swaps_within_the_lane_only() {
    let mut queue = QueuedMessages {
        steering: vec!["one".to_string(), "two".to_string()],
        follow_ups: vec!["later".to_string()],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    mirror_lane_move(&mut queue, QueueLane::Steering, 0, 1);
    assert_eq!(queue.steering, vec!["two", "one"]);
    assert_eq!(
        queue.follow_ups,
        vec!["later"],
        "the other lane is untouched"
    );
    mirror_lane_move(&mut queue, QueueLane::FollowUp, 0, -1);
    assert_eq!(
        queue.follow_ups,
        vec!["later"],
        "a negative target is a noop"
    );
    mirror_lane_move(&mut queue, QueueLane::FollowUp, 0, 7);
    assert_eq!(
        queue.follow_ups,
        vec!["later"],
        "an out-of-range target is a noop"
    );
}

/// A reorder through the local mirror keeps the typed provenance on the item it marks, so the
/// folded row never misclassifies before the daemon's action update lands.
#[test]
fn mirror_lane_move_rides_the_marked_indices() {
    let mut queue = QueuedMessages {
        steering: vec![
            "notice parked first".to_string(),
            "turn right".to_string(),
            "notice parked last".to_string(),
        ],
        follow_ups: Vec::new(),
        starting: None,
        rlm_child_status: QueueLaneIndices {
            steering: vec![0, 2],
            follow_up: Vec::new(),
        },
        injected_prompts: QueueLaneIndices::default(),
    };
    mirror_lane_move(&mut queue, QueueLane::Steering, 1, 0);
    assert_eq!(
        queue.steering,
        vec!["turn right", "notice parked first", "notice parked last"]
    );
    assert_eq!(
        queue.rlm_child_status.steering,
        vec![1, 2],
        "the marked index rides its item through the swap"
    );
    mirror_lane_move(&mut queue, QueueLane::Steering, 2, 1);
    assert_eq!(
        queue.steering,
        vec!["turn right", "notice parked last", "notice parked first"]
    );
    assert_eq!(
        queue.rlm_child_status.steering,
        vec![2, 1],
        "the second swap rides the other marked item too"
    );
}

#[test]
fn browse_header_quotes_lane_index_and_keys() {
    let selected = QueueSelectionItem {
        lane: QueueLane::Steering,
        index: 0,
        text: "turn right".to_string(),
        internal: false,
    };
    let keys = QueueBrowseKeys {
        navigate_older: "alt+up".to_string(),
        navigate_newer: "alt+down".to_string(),
        move_earlier: "ctrl+alt+up".to_string(),
        move_later: "ctrl+alt+down".to_string(),
        follow_up: "alt+enter".to_string(),
    };
    assert_eq!(
        browse_header_text(&selected, &keys),
        "steering 1 \u{00b7} alt+up/alt+down browse \u{00b7} ctrl+alt+up/ctrl+alt+down reorder \u{00b7} enter steers \u{00b7} alt+enter queues \u{00b7} empty deletes"
    );
}

/// The read-only header (the operator's edit-scope directive): an internal
/// item browses, but the header never offers the edit affordances.
#[test]
fn an_internal_item_headers_read_only() {
    let internal_notice = QueueSelectionItem {
        lane: QueueLane::FollowUp,
        index: 1,
        text: "[child-exited: no-reply child:lane]".to_string(),
        internal: true,
    };
    let keys = QueueBrowseKeys {
        navigate_older: "alt+up".to_string(),
        navigate_newer: "alt+down".to_string(),
        move_earlier: "ctrl+alt+up".to_string(),
        move_later: "ctrl+alt+down".to_string(),
        follow_up: "alt+enter".to_string(),
    };
    assert_eq!(
        browse_header_text(&internal_notice, &keys),
        "follow-up 2 \u{00b7} alt+up/alt+down browse \u{00b7} read-only internal prompt"
    );
}

/// The queue-fold bug (operator 2026-09-25): many child exits parked behind one busy turn rendered
/// as that many user-like rows. The wire-typed provenance folds them into the counted row — one row
/// however many notices queue, with the human previews untouched.
#[test]
fn child_status_notices_condense_by_wire_provenance() {
    let queue = QueuedMessages {
        steering: vec!["turn right".to_string()],
        follow_ups: vec![
            "[child-exited: no-reply child:lane-one]".to_string(),
            "[child-exited: no-reply child:lane-two]\n\nLast assistant text: done".to_string(),
            "then summarize".to_string(),
        ],
        starting: None,
        rlm_child_status: QueueLaneIndices {
            steering: Vec::new(),
            follow_up: vec![0, 1],
        },
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(
        rows.len(),
        5,
        "spacer + steering preview + follow-up preview + condensed row + hint"
    );
    let texts: Vec<String> = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect();
    assert_eq!(texts[1].trim(), "Steering: turn right");
    assert_eq!(texts[2].trim(), "Follow-up: then summarize");
    assert_eq!(
        texts[3].trim(),
        "2 child status notices queued",
        "both lanes' notices fold into one counted row"
    );
}

/// A marked steering-lane notice folds too (the daemon may park the notice
/// behind the steering lane's delivery window).
#[test]
fn a_steering_lane_notice_condenses_too() {
    let queue = QueuedMessages {
        steering: vec![
            "[child-exited: cancelled child:quiet]".to_string(),
            "turn right".to_string(),
        ],
        follow_ups: Vec::new(),
        starting: None,
        rlm_child_status: QueueLaneIndices {
            steering: vec![0],
            follow_up: Vec::new(),
        },
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(
        rows.len(),
        4,
        "spacer + human preview + condensed row + hint"
    );
    let texts: Vec<String> = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect();
    assert_eq!(texts[1].trim(), "Steering: turn right");
    assert_eq!(texts[2].trim(), "1 child status notice queued");
}

/// The spoof regression the operator's plan demands: provenance is the ONLY classifier for child
/// status — a user-typed message that merely looks like a notice stays a human preview row.
#[test]
fn user_typed_rows_that_look_like_notices_stay_human() {
    let queue = QueuedMessages {
        steering: vec![
            "[child-exited: no-reply child:not-a-notice]".to_string(),
            "[child-failed child:also-not-a-notice]".to_string(),
        ],
        follow_ups: vec!["RLM child status: typed by hand".to_string()],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(
        rows.len(),
        5,
        "spacer + three previews + hint — no condensed row"
    );
    let texts: Vec<String> = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect();
    assert_eq!(
        texts[1].trim(),
        "Steering: [child-exited: no-reply child:not-a-notice]"
    );
    assert_eq!(
        texts[2].trim(),
        "Steering: [child-failed child:also-not-a-notice]"
    );
    assert_eq!(
        texts[3].trim(),
        "Follow-up: RLM child status: typed by hand",
        "the lane label prepends — no label suppression without the four TS prefixes"
    );
}

/// The counted row names each origin in the fixed agent-message, heartbeat, child-status, other
/// order with plural-correct counts.
#[test]
fn mixed_origins_count_child_status_in_the_fixed_order() {
    let queue = QueuedMessages {
        steering: vec![
            "Agent message received: hi".to_string(),
            "Heartbeat prompt: nudge".to_string(),
            "[child-exited: no-reply child:worker]".to_string(),
            "[child-failed child:broken]".to_string(),
        ],
        follow_ups: vec![
            "Goal context: milestone".to_string(),
            "[child-exited: cancelled child:quiet]".to_string(),
            "edit this".to_string(),
        ],
        starting: None,
        rlm_child_status: QueueLaneIndices {
            steering: vec![2, 3],
            follow_up: vec![1],
        },
        injected_prompts: QueueLaneIndices::default(),
    };
    // Width 120 so the four-origin row reads untruncated (the row text is 88
    // chars; at 80 the strip's ellipsis cut it).
    let rows = render_queue(&theme(), &queue, "alt+up", 120);
    // spacer + the one human preview + the condensed row + the hint.
    assert_eq!(rows.len(), 4);
    let texts: Vec<String> = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect();
    assert_eq!(texts[1].trim(), "Follow-up: edit this");
    assert_eq!(
        texts[2].trim(),
        "1 agent message, 1 heartbeat, 3 child status notices, and 1 other internal prompt queued",
        "each origin counts across both lanes, child status between heartbeats and other"
    );
    assert_eq!(
        texts[3].trim(),
        "╰─ alt+up to browse and edit queued messages"
    );
    assert_eq!(
        texts
            .iter()
            .filter(|text| text.contains("child-exited"))
            .count(),
        0,
        "no notice renders its own row"
    );
    assert_eq!(
        texts
            .iter()
            .filter(|text| text.contains("edit this"))
            .count(),
        1
    );
}

/// The browse affordance still walks the parked notices (the operator's inspectability
/// requirement): the selection walks every item, oldest-first down the follow-up lane.
#[test]
fn browse_still_walks_the_parked_notices() {
    let queue = QueuedMessages {
        steering: Vec::new(),
        follow_ups: vec![
            "[child-exited: no-reply child:lane]\n\nLast assistant text: done".to_string(),
            "then summarize".to_string(),
        ],
        starting: None,
        rlm_child_status: QueueLaneIndices {
            steering: Vec::new(),
            follow_up: vec![0],
        },
        injected_prompts: QueueLaneIndices::default(),
    };
    let mut selection = QueueSelection::default();
    let text = selection.browse(&queue, "draft", QueueBrowseDirection::Older);
    assert_eq!(text.as_deref(), Some("then summarize"));
    let text = selection.browse(&queue, "", QueueBrowseDirection::Older);
    assert_eq!(
        text.as_deref(),
        Some("[child-exited: no-reply child:lane]\n\nLast assistant text: done"),
        "the notice is walkable with its full detail"
    );
    assert!(
        selection.selected().is_some_and(|item| item.internal),
        "the walked notice carries the read-only origin"
    );
}

/// The operator's mission case (2026-09-28), stated exactly: seven child-exited follow-ups parked
/// behind one busy turn plus one user steering message render as the user message's row plus the
/// one summary row — NO child-exit item rows.
#[test]
fn seven_child_exits_render_as_one_counted_row() {
    let mut follow_ups = Vec::new();
    for child in [
        "lane-one",
        "lane-two",
        "lane-three",
        "lane-four",
        "lane-five",
        "lane-six",
        "lane-seven",
    ] {
        follow_ups.push(format!("[child-exited: no-reply child:{child}]"));
    }
    let queue = QueuedMessages {
        steering: vec!["turn right".to_string()],
        follow_ups,
        starting: None,
        rlm_child_status: QueueLaneIndices {
            steering: Vec::new(),
            follow_up: vec![0, 1, 2, 3, 4, 5, 6],
        },
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(
        rows.len(),
        4,
        "spacer + the user steering row + the one summary row + hint"
    );
    let texts: Vec<String> = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect();
    assert_eq!(texts[1].trim(), "Steering: turn right");
    assert_eq!(
        texts[2].trim(),
        "7 child status notices queued",
        "the seven exits fold into the summary's count"
    );
    assert_eq!(
        texts
            .iter()
            .filter(|text| text.contains("child-exited"))
            .count(),
        0,
        "no child-exit item row renders"
    );
}

/// The engine-minted continuations (goal and threshold-compaction) park preview-less: TS's
/// projection filters them out entirely, and the `injectedPrompts` wire-typed provenance folds them
/// into the counted row's "other internal prompt" bucket — they never render their own rows.
#[test]
fn injected_continuations_condense_into_the_counted_row() {
    let queue = QueuedMessages {
        steering: vec!["[goal: continuation]\n\nKeep driving the goal.".to_string()],
        follow_ups: vec![
            "keep going".to_string(),
            "[goal: continuation]\n\nKeep driving the goal.".to_string(),
            "[autonomous continuation after compaction]".to_string(),
        ],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices {
            steering: vec![0],
            follow_up: vec![1, 2],
        },
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(
        rows.len(),
        4,
        "spacer + the one user preview + the condensed row + hint"
    );
    let texts: Vec<String> = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect();
    assert_eq!(texts[1].trim(), "Follow-up: keep going");
    assert_eq!(
        texts[2].trim(),
        "3 other internal prompts queued",
        "the continuations count into the other-internal bucket across both lanes"
    );
    assert_eq!(
        texts
            .iter()
            .filter(|text| text.contains("continuation"))
            .count(),
        0,
        "no continuation text reaches the strip rows"
    );
}

#[test]
fn an_only_internal_queue_renders_just_the_summary_row() {
    let queue = QueuedMessages {
        steering: Vec::new(),
        follow_ups: vec![
            "Heartbeat prompt: nudge".to_string(),
            "[goal: continuation]\n\nKeep driving the goal.".to_string(),
        ],
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices {
            steering: Vec::new(),
            follow_up: vec![1],
        },
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(rows.len(), 3, "spacer + the condensed row + hint");
    let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(
        text.trim(),
        "1 heartbeat and 1 other internal prompt queued",
        "every parked item counts; none renders its own row"
    );
}

/// The spoof regression for the second rider: provenance is the ONLY classifier — a user-typed
/// prompt with a continuation's exact text, no wire mark, stays the human preview row.
#[test]
fn a_same_text_user_row_never_rides_the_injected_rider() {
    let queue = QueuedMessages {
        steering: vec!["[goal: continuation]\n\nKeep driving the goal.".to_string()],
        follow_ups: Vec::new(),
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices::default(),
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 80);
    assert_eq!(
        rows.len(),
        3,
        "spacer + the human preview row + hint — no condensed row"
    );
    let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
    assert_eq!(
        text.trim(),
        "Steering: [goal: continuation]",
        "the lane label prepends and the first line renders — the human row it is"
    );
}

#[test]
fn mixed_origins_count_the_injected_continuations_as_other() {
    let queue = QueuedMessages {
        steering: vec![
            "Agent message received: hi".to_string(),
            "Heartbeat prompt: nudge".to_string(),
            "[goal: continuation]\n\nKeep driving the goal.".to_string(),
            "[child-exited: no-reply child:worker]".to_string(),
        ],
        follow_ups: vec![
            "[compaction continuation]".to_string(),
            "edit this".to_string(),
        ],
        starting: None,
        rlm_child_status: QueueLaneIndices {
            steering: vec![3],
            follow_up: Vec::new(),
        },
        injected_prompts: QueueLaneIndices {
            steering: vec![2],
            follow_up: vec![0],
        },
    };
    let rows = render_queue(&theme(), &queue, "alt+up", 120);
    assert_eq!(
        rows.len(),
        4,
        "spacer + the one human preview + the condensed row + hint"
    );
    let texts: Vec<String> = rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect();
    assert_eq!(texts[1].trim(), "Follow-up: edit this");
    assert_eq!(
        texts[2].trim(),
        "1 agent message, 1 heartbeat, 1 child status notice, and 2 other internal prompts queued",
        "the continuations join the other-internal bucket behind the fixed origin order"
    );
}

/// The browse keeps walking internal items while its edit affordances apply
/// to the user items: every walked item carries its origin for the gates.
#[test]
fn browse_items_carry_their_origin_for_the_edit_gate() {
    let queue = QueuedMessages {
        steering: vec![
            "Heartbeat prompt: nudge".to_string(),
            "turn right".to_string(),
            "[goal: continuation]\n\nKeep driving the goal.".to_string(),
        ],
        follow_ups: vec![
            "[child-exited: no-reply child:lane]".to_string(),
            "then summarize".to_string(),
        ],
        starting: None,
        rlm_child_status: QueueLaneIndices {
            steering: Vec::new(),
            follow_up: vec![0],
        },
        injected_prompts: QueueLaneIndices {
            steering: vec![2],
            follow_up: Vec::new(),
        },
    };
    let mut selection = QueueSelection::default();
    assert_eq!(
        selection
            .browse(&queue, "draft", QueueBrowseDirection::Older)
            .as_deref(),
        Some("then summarize")
    );
    assert!(
        !selection.selected().unwrap().internal,
        "the user row stays editable"
    );
    assert_eq!(
        selection
            .browse(&queue, "", QueueBrowseDirection::Older)
            .as_deref(),
        Some("[child-exited: no-reply child:lane]")
    );
    assert!(
        selection.selected().unwrap().internal,
        "the child-status notice browses read-only"
    );
    assert_eq!(
        selection
            .browse(&queue, "", QueueBrowseDirection::Older)
            .as_deref(),
        Some("[goal: continuation]\n\nKeep driving the goal.")
    );
    assert!(
        selection.selected().unwrap().internal,
        "the injected continuation browses read-only"
    );
    assert_eq!(
        selection
            .browse(&queue, "", QueueBrowseDirection::Older)
            .as_deref(),
        Some("turn right")
    );
    assert!(
        !selection.selected().unwrap().internal,
        "the user row stays editable"
    );
    assert_eq!(
        selection
            .browse(&queue, "", QueueBrowseDirection::Older)
            .as_deref(),
        Some("Heartbeat prompt: nudge")
    );
    assert!(
        selection.selected().unwrap().internal,
        "the labeled heartbeat browses read-only"
    );
}

/// A user row's reorder can swap it across an injected continuation: the injected rider rides the
/// swap like the child-status rider, so the folded classification never misreads before the
/// daemon's action update lands.
#[test]
fn mirror_lane_move_rides_the_injected_rider_too() {
    let mut queue = QueuedMessages {
        steering: vec![
            "[goal: continuation]\n\nKeep driving the goal.".to_string(),
            "turn right".to_string(),
        ],
        follow_ups: Vec::new(),
        starting: None,
        rlm_child_status: QueueLaneIndices::default(),
        injected_prompts: QueueLaneIndices {
            steering: vec![0],
            follow_up: Vec::new(),
        },
    };
    mirror_lane_move(&mut queue, QueueLane::Steering, 1, 0);
    assert_eq!(
        queue.steering,
        vec![
            "turn right",
            "[goal: continuation]\n\nKeep driving the goal."
        ]
    );
    assert_eq!(
        queue.injected_prompts.steering,
        vec![1],
        "the injected mark rides its item through the swap"
    );
}
