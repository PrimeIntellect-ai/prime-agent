//! Message-less sessions: a name makes an empty session an intentional object that lists by
//! recency and opens like any other; an unnamed empty one stays hidden once inactive.

use super::*;

/// One saved-catalog row with no messages, modified after the [`saved_catalog_row`] fixtures.
fn empty_catalog_row(path: &str, id: &str, name: Option<&str>) -> serde_json::Value {
    let mut row = serde_json::json!({
        "path": path,
        "id": id,
        "cwd": "/tmp",
        "rlmDepth": 0,
        "created": "2024-02-01T00:00:00.000Z",
        "modified": "2024-02-01T00:00:00.000Z",
        "messageCount": 0,
        "firstMessage": "(no messages)",
        "allMessagesText": "",
    });
    if let Some(name) = name {
        row["name"] = serde_json::json!(name);
    }
    row
}

fn titles(mode: &AgentsViewMode) -> Vec<&str> {
    mode.rows.iter().map(|row| row.title.as_str()).collect()
}

#[test]
fn a_named_empty_session_lists_by_recency_and_opens() {
    let mut mode = mode_with_anchor(None, vec![]);
    mode.saved = vec![
        saved_catalog_row("/x/old1.jsonl", "old1", "older one"),
        saved_catalog_row("/x/old2.jsonl", "old2", "older two"),
        empty_catalog_row("/x/plan.jsonl", "plan", Some("fresh plan")),
        empty_catalog_row("/x/blank.jsonl", "blank", None),
    ];
    mode.rebuild_rows();
    assert_eq!(
        titles(&mode),
        ["fresh plan", "older one", "older two"],
        "the newest session leads even with no messages; the unnamed empty one stays hidden"
    );
    let row = &mode.rows[0];
    assert_eq!(row.section, Section::Inactive);
    assert!(row.cost.abs() < f64::EPSILON, "no spend: {}", row.cost);
    assert!(!row.age.is_empty(), "the row shows its age");
    mode.handle_key("enter");
    assert_eq!(
        mode.opened.map(|opened| opened.selection),
        Some(SessionSelection::Resume(PathBuf::from("/x/plan.jsonl"))),
        "Enter opens the named empty session"
    );
}

#[test]
fn an_empty_session_that_loses_its_name_hides_again() {
    let mut mode = mode_with_anchor(None, vec![]);
    mode.saved = vec![
        saved_catalog_row("/x/old.jsonl", "old", "older one"),
        empty_catalog_row("/x/plan.jsonl", "plan", Some("fresh plan")),
    ];
    mode.rebuild_rows();
    assert!(titles(&mode).contains(&"fresh plan"));
    mode.buffer_saved_stream_item(empty_catalog_row("/x/plan.jsonl", "plan", None));
    assert!(mode.flush_saved_stream());
    assert_eq!(titles(&mode), ["older one"]);
}
