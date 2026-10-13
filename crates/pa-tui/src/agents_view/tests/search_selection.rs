//! The selection under search edits: every query change lands on the
//! top-ranked hit, and clearing the query returns to the session the
//! selection sat on before the search began.

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
    assert_eq!(selected_title(&mode), "gateway");
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

/// The editor's word-delete binding (TS `Editor.handleInput`'s
/// `deleteWordBackward`, ctrl+w) deletes the query's trailing word.
#[test]
fn ctrl_w_deletes_the_query_s_trailing_word() {
    let mut mode = fresh_mode(search_roster());
    type_query(&mut mode, "gateway worker");
    assert_eq!(mode.query, "gateway worker");
    mode.handle_key("ctrl+w");
    assert_eq!(mode.query, "gateway ");
    mode.handle_key("alt+backspace");
    assert_eq!(mode.query, "");
    // An empty query's word-delete is a no-op that re-arms nothing.
    mode.handle_key("ctrl+w");
    assert_eq!(mode.query, "");
    assert_eq!(
        mode.rows.len(),
        6,
        "every row returns with the cleared query"
    );
}

/// The word walk is punctuation-aware like the shared editor's
/// `delete_word_backward` (TS `moveWordBackwards`): a dotted query
/// loses its trailing word run only — "error.rs" keeps "error." —
/// never the whole dotted word a whitespace-only scan would take.
#[test]
fn ctrl_w_loses_only_the_trailing_word_run_in_a_dotted_query() {
    let mut mode = fresh_mode(search_roster());
    type_query(&mut mode, "error.rs");
    assert_eq!(mode.query, "error.rs");
    mode.handle_key("ctrl+w");
    assert_eq!(mode.query, "error.");
    mode.handle_key("ctrl+w");
    assert_eq!(mode.query, "error");
    mode.handle_key("ctrl+w");
    assert_eq!(mode.query, "");
}

/// Clearing the query (backspace to empty, ctrl+u, or escape) returns
/// the selection to the session it sat on before the search began.
#[test]
fn clearing_the_query_restores_the_pre_search_selection() {
    for clear in ["backspace", "ctrl+u", "escape"] {
        let mut mode = fresh_mode(search_roster());
        mode.handle_key("down");
        mode.handle_key("down");
        assert_eq!(selected_title(&mode), "fix login bug");
        type_query(&mut mode, "gate");
        assert_eq!(mode.selected, first_selectable(&mode));
        if clear == "backspace" {
            for _ in 0..4 {
                mode.handle_key("backspace");
            }
        } else {
            mode.handle_key(clear);
        }
        assert!(mode.query.is_empty(), "{clear} clears the query");
        assert_eq!(selected_title(&mode), "fix login bug", "{clear}");
        assert_eq!(
            mode.selected_identity.as_deref(),
            Some(mode.rows[mode.selected].identity.as_str()),
        );
    }
}

/// A row the user picks while searching is their selection: clearing
/// the query keeps it instead of returning to the pre-search row.
#[test]
fn a_pick_made_while_searching_survives_the_clear() {
    let mut mode = fresh_mode(search_roster());
    type_query(&mut mode, "gateway");
    mode.handle_key("down");
    let picked = selected_title(&mode).to_string();
    assert_ne!(picked, "gateway");
    mode.handle_key("ctrl+u");
    assert_eq!(selected_title(&mode), picked);
}

/// The pre-search session left while the query was up: the clear lands
/// on the top of the list.
#[test]
fn clearing_after_the_pre_search_session_left_selects_the_top() {
    let mut mode = fresh_mode(search_roster());
    mode.handle_key("end");
    mode.handle_key("up");
    assert_eq!(selected_title(&mode), "refactor tests");
    type_query(&mut mode, "gate");
    mode.apply_roster_update(Vec::new(), vec!["s5".to_string()], false);
    mode.handle_key("escape");
    assert!(mode.query.is_empty());
    assert_eq!(mode.selected, first_selectable(&mode));
    assert_eq!(selected_title(&mode), "write docs");
}
