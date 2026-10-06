//! The selection under roster churn: session-following spawns, no-op
//! re-pushes, and the list window that keeps the selection visible.

use super::*;

/// A multi-session roster for the selection-persistence probes: six
/// idle top-level sessions with distinct activity stamps (newest
/// first, matching the Idle section's recency sort).
fn churn_roster() -> Vec<serde_json::Value> {
    (1..=6)
        .map(|n| {
            roster_entry(
                &format!("s{n}"),
                "idle",
                &serde_json::json!({
                    "sessionId": format!("s{n}"), "lifecycle": "live",
                    "activeSessionId": format!("s{n}-live"),
                    "sessionFile": format!("/x/s{n}.jsonl"),
                    "runtimeKind": "top-level",
                    "sessionName": format!("session {n}"),
                    "messageCount": 2,
                    "rlmDepth": 0,
                    "lastActivityAt": format!("2025-01-{:02}T00:00:00.000Z", 7 - n),
                }),
            )
        })
        .collect()
}

/// Kevin's dogfood symptom (2026-09-21): arrowing down while the roster churns must keep the
/// selection on the same SESSION, and the window showing it. The selection is session-keyed,
/// so the render window follows the session instead of snapping back to the top.
#[test]
fn selection_follows_the_session_through_spawn_churn() {
    let roster = churn_roster();
    let mut mode = fresh_mode(roster.clone());
    for _ in 0..3 {
        mode.handle_key("down");
    }
    assert_eq!(mode.rows[mode.selected].title, "session 4");
    let mut churned = roster;
    churned[0] = roster_entry(
        "s1",
        "running",
        &serde_json::json!({
            "sessionId": "s1", "lifecycle": "live",
            "activeSessionId": "s1-live",
            "sessionFile": "/x/s1.jsonl",
            "runtimeKind": "top-level",
            "sessionName": "session 1",
            "messageCount": 2, "rlmDepth": 0,
            "lastActivityAt": "2025-01-08T00:00:00.000Z",
        }),
    );
    churned.push(roster_entry(
        "/x/s1.jsonl#child-w",
        "running",
        &child_summary("w", "s1", "spawned worker"),
    ));
    mode.apply_roster_update(churned.clone(), Vec::new(), false);
    assert_eq!(
        mode.rows[mode.selected].title, "session 4",
        "spawn churn must not move the selection off the selected session"
    );
    for _ in 0..3 {
        mode.apply_roster_update(churned.clone(), Vec::new(), false);
    }
    assert_eq!(mode.rows[mode.selected].title, "session 4");
}

/// An idle roster re-push (same sessions, same states) is a no-op — the rebuild must not
/// touch the selection at all (same row, same index, same identity).
#[test]
fn selection_untouched_by_noop_roster_updates() {
    let roster = churn_roster();
    let mut mode = fresh_mode(roster.clone());
    for _ in 0..3 {
        mode.handle_key("down");
    }
    let (index, identity, key) = (
        mode.selected,
        mode.rows[mode.selected].identity.clone(),
        mode.selected_key.clone(),
    );
    mode.apply_roster_update(roster, Vec::new(), false);
    assert_eq!(mode.selected, index);
    assert_eq!(mode.rows[mode.selected].identity, identity);
    assert_eq!(mode.selected_key, key);
}

/// The selected session left the roster (archived away, no saved row): it keeps the bounded
/// current index — never a reset to the top of the list.
#[test]
fn selected_session_gone_keeps_the_bounded_position() {
    let roster = churn_roster();
    let mut mode = fresh_mode(roster.clone());
    for _ in 0..3 {
        mode.handle_key("down");
    }
    assert_eq!(mode.rows[mode.selected].title, "session 4");
    let shrunk: Vec<serde_json::Value> = roster
        .into_iter()
        .filter(|entry| entry["agentId"] != serde_json::json!("s4"))
        .collect();
    mode.apply_roster_update(Vec::new(), vec!["s4".to_string()], false);
    assert_eq!(mode.roster.len(), shrunk.len());
    assert_eq!(mode.selected, 3);
    assert_eq!(mode.rows[mode.selected].title, "session 5");
}

/// Viewport parity: the list window centers on the selected row and clips the overflow behind
/// ellipses, so arrowing below the fold keeps the selection visible.
#[test]
fn list_window_follows_the_selection_below_the_fold() {
    let roster: Vec<serde_json::Value> = (1..=12)
        .map(|n| {
            roster_entry(
                &format!("s{n}"),
                "idle",
                &serde_json::json!({
                    "sessionId": format!("s{n}"), "lifecycle": "live",
                    "activeSessionId": format!("s{n}-live"),
                    "sessionFile": format!("/x/s{n}.jsonl"),
                    "runtimeKind": "top-level",
                    "sessionName": format!("session {n}"),
                    "messageCount": 2, "rlmDepth": 0,
                    "lastActivityAt": format!("2025-01-{:02}T00:00:00.000Z", 13 - n),
                }),
            )
        })
        .collect();
    let mut mode = fresh_mode(roster);
    assert_eq!(mode.rows.len(), 12);
    let frame_texts = |mode: &mut AgentsViewMode| -> Vec<String> {
        mode.render_list(120, 8, 0)
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect()
    };
    let texts = frame_texts(&mut mode);
    assert_eq!(texts.len(), 8);
    assert!(texts[0].contains("Session"), "legend: {texts:?}");
    assert!(texts[2].contains("Idle (12)"));
    assert!(texts[3].contains("session 1"));
    assert_eq!(texts[7].trim(), "...");
    assert!(!texts.iter().any(|t| t.contains("session 5")));
    for _ in 0..11 {
        mode.handle_key("down");
    }
    assert_eq!(mode.rows[mode.selected].title, "session 12");
    let texts = frame_texts(&mut mode);
    assert_eq!(texts.len(), 8);
    assert_eq!(texts[2].trim(), "...");
    assert!(
        texts.iter().any(|t| t.contains("session 12")),
        "the selected row must render inside the window: {texts:?}"
    );
    assert!(!texts.iter().any(|t| t.contains("session 7")));
    assert_ne!(texts.last().map(|t| t.trim()), Some("..."));
    // The selected row carries the ONE shared selection style (the operator's 2026-09-29
    // one-color ruling: `Theme::selection_row_style`, one constant).
    let selected_line = mode.render_list(120, 8, 0);
    let band = mode.theme.selection_row_style();
    let painted = selected_line
        .iter()
        .find(|line| line.iter().any(|span| span.style.bg.is_some()))
        .expect("the selected row renders with the selection background");
    assert!(
        painted.iter().all(|span| span.style.bg == band.bg),
        "every span of the selected row carries the shared band: {painted:?}"
    );
    assert_eq!(
        band.bg,
        mode.theme.hover_row_style().bg,
        "the agents view selection paints the hover's own color — the one-color ruling"
    );
    assert!(
        band.add_modifier.is_empty(),
        "no bold modifier rides the selection; the row's own styles stay"
    );
    for _ in 0..11 {
        mode.handle_key("up");
    }
    assert_eq!(mode.rows[mode.selected].title, "session 1");
    let texts = frame_texts(&mut mode);
    assert!(texts[3].contains("session 1"));
    assert_eq!(texts[7].trim(), "...");
}
