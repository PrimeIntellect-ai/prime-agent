//! The selection under search edits: every query change, the clear
//! included, lands on the topmost row (the top-ranked hit).

use super::*;

/// Six idle top-level sessions, newest first; three of them match
/// "gateway", and the exact-name match ranks first.
fn search_roster() -> Vec<serde_json::Value> {
    let names = [
        "write docs",
        "gateway worker",
        "fix login bug",
        "deploy the gateway now",
        "refactor tests",
        "gateway",
    ];
    names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let n = index + 1;
            roster_entry(
                &format!("s{n}"),
                "idle",
                &serde_json::json!({
                    "sessionId": format!("s{n}"), "lifecycle": "live",
                    "activeSessionId": format!("s{n}-live"),
                    "sessionFile": format!("/x/s{n}.jsonl"),
                    "runtimeKind": "top-level",
                    "sessionName": name,
                    "messageCount": 2,
                    "rlmDepth": 0,
                    "lastActivityAt": format!("2025-01-{:02}T00:00:00.000Z", 7 - n),
                }),
            )
        })
        .collect()
}

fn type_query(mode: &mut AgentsViewMode, text: &str) {
    for ch in text.chars() {
        mode.handle_key(&ch.to_string());
    }
}

fn selected_title(mode: &AgentsViewMode) -> &str {
    &mode.rows[mode.selected].title
}

fn first_selectable(mode: &AgentsViewMode) -> usize {
    mode.rows
        .iter()
        .position(AgentsViewRow::selectable)
        .expect("a selectable row")
}

/// The reported bug: with the selection at the bottom of the list,
/// typing a query clamped the selection onto the LAST hit. Every
/// keystroke lands on the first row, the top-ranked hit.
#[test]
fn typing_a_query_selects_the_top_hit() {
    let mut mode = fresh_mode(search_roster());
    mode.handle_key("end");
    mode.handle_key("up");
    assert_eq!(selected_title(&mode), "refactor tests");
    for ch in "gateway".chars() {
        mode.handle_key(&ch.to_string());
        assert_eq!(
            mode.selected,
            first_selectable(&mode),
            "after {:?} the selection sits on the first hit",
            mode.query
        );
    }
    assert_eq!(mode.rows.len(), 3);
    assert_eq!(selected_title(&mode), "gateway");
    assert_eq!(
        mode.selected_identity.as_deref(),
        Some(mode.rows[mode.selected].identity.as_str()),
        "the carried identity follows the top hit"
    );
}

/// A selected session that is itself a lower-ranked hit does not hold
/// the selection: the query change still lands on the top hit, and so
/// does deleting a character while the query stays non-empty.
#[test]
fn a_matching_selection_still_moves_to_the_top_hit() {
    let mut mode = fresh_mode(search_roster());
    mode.handle_key("down");
    assert_eq!(selected_title(&mode), "gateway worker");
    type_query(&mut mode, "gateway");
    assert_eq!(selected_title(&mode), "gateway");
    mode.handle_key("down");
    assert_ne!(mode.selected, first_selectable(&mode));
    mode.handle_key("backspace");
    assert_eq!(mode.query, "gatewa");
    assert_eq!(mode.selected, first_selectable(&mode));
}

/// Clearing the query (backspace to empty, ctrl+u, or escape) is a query
/// change like any other: the full list selects its topmost row.
#[test]
fn clearing_the_query_selects_the_top_row() {
    for clear in ["backspace", "ctrl+u", "escape"] {
        let mut mode = fresh_mode(search_roster());
        mode.handle_key("down");
        mode.handle_key("down");
        type_query(&mut mode, "gate");
        mode.handle_key("down");
        if clear == "backspace" {
            for _ in 0..4 {
                mode.handle_key("backspace");
            }
        } else {
            mode.handle_key(clear);
        }
        assert!(mode.query.is_empty(), "{clear} clears the query");
        assert_eq!(mode.selected, first_selectable(&mode), "{clear}");
        assert_eq!(selected_title(&mode), "write docs", "{clear}");
    }
}
