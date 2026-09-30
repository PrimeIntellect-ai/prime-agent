//! The edge jumps: home/end and their variants, their rebinding, and the
//! viewport that follows.

use super::*;

/// A large forest of idle top-level sessions (the churn roster's
/// shape, scaled): one-row arrows cannot cross it in a sitting.
fn forest_roster(count: usize) -> Vec<serde_json::Value> {
    (1..=count)
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
                    "messageCount": 1,
                    "rlmDepth": 0,
                    "lastActivityAt": "2025-01-01T00:00:00.000Z",
                }),
            )
        })
        .collect()
}

/// The edge jump keys (home/end and their ctrl/super variants) select the first/last row in
/// one press, and the arrows keep moving one row from either edge.
#[test]
fn home_and_end_jump_the_selection_to_the_list_edges() {
    let mut mode = fresh_mode(forest_roster(120));
    assert_eq!(mode.rows.len(), 120);
    for key in ["home", "ctrl+home", "super+home", "super+up"] {
        mode.selected = 60;
        mode.handle_key(key);
        assert_eq!(mode.selected, 0, "{key} selects the first row");
    }
    let last = mode.rows.len() - 1;
    for key in ["end", "ctrl+end", "super+end", "super+down"] {
        mode.selected = 60;
        mode.handle_key(key);
        assert_eq!(mode.selected, last, "{key} selects the last row");
    }
    assert_eq!(
        mode.selected_identity.as_deref(),
        Some(mode.rows[last].identity.as_str()),
        "the jump syncs the carried identity onto the landed row"
    );
    mode.handle_key("up");
    assert_eq!(mode.selected, last - 1);
    mode.handle_key("home");
    mode.handle_key("down");
    assert_eq!(mode.selected, 1);
}

/// A user override moves the jump with the handler; the default key goes inert, and the hint
/// slot renders the override (the #184 binding-test pattern).
#[test]
fn edge_jump_keys_can_be_rebound() {
    let mut mode = mode_with_user_bindings(&[("tui.select.top", "ctrl+j")]);
    mode.handle_key("down");
    let before = mode.selected;
    mode.handle_key("home");
    assert_eq!(mode.selected, before, "home is inert after the override");
    mode.handle_key("ctrl+j");
    assert_eq!(mode.selected, 0, "the override jumps");
    assert!(
        flat(&mode.render_hints(120, None)).contains("Ctrl+J/End first/last"),
        "the jump hint renders the override"
    );
}

/// The jump is an explicit user choice: it ends the entry anchor's wait, so a later anchor
/// landing cannot override the jumped-to row.
#[test]
fn edge_jump_ends_the_entry_anchor_wait() {
    let mut mode = mode_with_anchor(
        Some("nowhere"),
        vec![
            roster_entry("s1", "idle", &parent_summary("s1")),
            roster_entry("s2", "idle", &parent_summary("s2")),
        ],
    );
    assert!(mode.anchor_selection_pending);
    mode.handle_key("end");
    assert!(!mode.anchor_selection_pending, "the jump ends the wait");
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s2");
}

/// The render window follows the jump: on a large forest the landed row renders inside the
/// viewport (the selected row's display index drives the window).
#[test]
fn the_viewport_follows_the_edge_jump() {
    let mut mode = fresh_mode(forest_roster(80));
    mode.handle_key("end");
    let texts: Vec<String> = mode
        .render_list(120, 10, 0)
        .iter()
        .map(|line| line.iter().map(|s| s.content.as_str()).collect())
        .collect();
    let last_title = mode.rows[mode.selected].title.clone();
    assert!(
        texts.iter().any(|t| t.contains(last_title.as_str())),
        "the last row renders in the window: {texts:?}"
    );
}
