//! The saved-catalog data path: progressive streaming, identity upserts,
//! and the carried seed the load flags.

use super::*;

/// The streamed catalog lands progressively: a buffered row flushes
/// as one rebuild, and the entry anchor's wait ends with the flush -
/// the row the scan streams first (newest) is selectable (and
/// Enter-able) inside the first batch window instead of after the
/// whole scan (the operator's `Still loading sessions` hold).
#[test]
fn streamed_catalog_rows_land_progressively_and_settle_the_anchor() {
    let mut mode = mode_with_anchor(
        Some("s2"),
        vec![roster_entry("s1", "idle", &parent_summary("s1"))],
    );
    assert!(mode.anchor_selection_pending, "the anchor waits on its row");
    mode.buffer_saved_stream_item(saved_catalog_row("/x/s2.jsonl", "s2", "second chat"));
    assert!(mode.flush_saved_stream(), "the flush rebuilds once");
    assert!(
        !mode.anchor_selection_pending,
        "the anchor landed from the stream, before the final response"
    );
    assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s2");
    // Enter opens the anchor now: no hint, no wait.
    mode.handle_key("enter");
    assert!(
        mode.opened.is_some(),
        "the anchor opens without waiting for the scan's end"
    );
    assert_ne!(mode.status_text(), Some(ANCHOR_LOADING_HINT));
}

/// The streamed upsert never duplicates: a row re-streamed by a
/// superseded fetch's late frames replaces by path (then durable id),
/// and the final response's authoritative array replaces the whole
/// catalog.
#[test]
fn streamed_catalog_upserts_by_identity_and_the_final_response_replaces() {
    let mut mode = mode_with_anchor(None, vec![]);
    assert!(
        !mode.flush_saved_stream(),
        "an empty buffer flushes nothing"
    );
    mode.buffer_saved_stream_item(saved_catalog_row("/x/a.jsonl", "a", "first"));
    mode.buffer_saved_stream_item(saved_catalog_row("/x/a.jsonl", "a", "first (again)"));
    mode.buffer_saved_stream_item(saved_catalog_row("/x/b.jsonl", "b", "second"));
    assert!(mode.flush_saved_stream());
    assert_eq!(
        mode.saved.len(),
        2,
        "the same path upserts, never duplicates"
    );
    assert_eq!(mode.saved[0]["name"], "first (again)");
    // A row whose path moved but id survived still upserts by id.
    mode.buffer_saved_stream_item(saved_catalog_row("/x/a-moved.jsonl", "a", "moved"));
    assert!(mode.flush_saved_stream());
    assert_eq!(mode.saved.len(), 2, "the durable id upserts too");
    assert_eq!(mode.saved[0]["path"], "/x/a-moved.jsonl");
    // The final response replaces the catalog wholesale.
    mode.drop_saved_stream();
    mode.saved = vec![saved_catalog_row(
        "/x/c.jsonl",
        "c",
        "the authoritative row",
    )];
    mode.rebuild_rows();
    assert_eq!(mode.saved.len(), 1);
    assert_eq!(mode.saved[0]["id"], "c");
    assert!(mode.saved_stream.is_empty());
}

/// The carried catalog seeds the mode (TS
/// `persistentState.savedSessions`): the surface writes the link's
/// rows into `saved` before the first rebuild, so the Inactive
/// section paints them immediately, the anchor lands from the carried
/// rows, and a terminal load flips the loaded flag for the flow's
/// next run.
#[test]
fn the_carried_catalog_paints_and_the_load_flags_the_carry() {
    let mut mode = mode_with_anchor(Some("s2"), vec![]);
    assert!(
        mode.saved.is_empty() && !mode.saved_catalog_loaded,
        "a fresh run starts with no catalog"
    );
    // The surface's seeding (the link's carried rows).
    mode.saved = vec![saved_catalog_row("/x/s2.jsonl", "s2", "carried chat")];
    mode.rebuild_rows();
    assert!(
        mode.rows
            .iter()
            .any(|row| row.summary.get("sessionId").and_then(Value::as_str) == Some("s2")),
        "the carried row renders without any fetch"
    );
    assert!(
        !mode.anchor_selection_pending,
        "the anchor lands from the carried catalog - no loading hold"
    );
    assert!(
        !mode.saved_catalog_loaded,
        "carried rows alone are not a settled catalog (a run that only carried still fetches)"
    );
    mode.apply_saved_loaded(vec![saved_catalog_row("/x/s2.jsonl", "s2", "carried chat")]);
    assert!(
        mode.saved_catalog_loaded,
        "the terminal load flags the carry for the flow's next run"
    );
}
