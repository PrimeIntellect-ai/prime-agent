use super::*;

fn more() -> Option<SavedMore> {
    Some(SavedMore {
        cursor: "page-two".to_string(),
        remaining: 1,
    })
}

#[test]
fn an_empty_saved_page_waits_for_navigation_or_search() {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.apply_saved_loaded(Vec::new());
    mode.rebuild_rows();
    mode.finish_saved_page(more());
    assert!(
        mode.next_saved_fetch().is_none(),
        "an empty frame must not drain the store automatically"
    );
    mode.handle_key("down");
    assert_eq!(
        mode.next_saved_fetch(),
        Some(("page-two".to_string(), Some(SAVED_CATALOG_PAGE_FILES)))
    );
    mode.saved_page_requested = false;
    mode.query = "older".to_string();
    assert_eq!(
        mode.next_saved_fetch(),
        Some(("page-two".to_string(), None))
    );
}

#[test]
fn a_saved_anchor_beyond_the_first_page_remains_pending_until_it_arrives() {
    let mut mode = mode_with_anchor(Some("older"), Vec::new());
    mode.apply_saved_loaded(vec![saved_catalog_row("/x/new.jsonl", "new", "newer")]);
    mode.rebuild_rows();
    mode.finish_saved_page(more());
    assert!(mode.anchor_selection_pending);
    mode.handle_key("enter");
    assert!(
        mode.opened.is_none(),
        "Enter cannot confirm the wrong row while the anchor is pending"
    );
    assert_eq!(
        mode.next_saved_fetch(),
        Some(("page-two".to_string(), Some(SAVED_CATALOG_PAGE_FILES)))
    );
    mode.upsert_saved(vec![saved_catalog_row("/x/older.jsonl", "older", "older")]);
    mode.rebuild_rows();
    mode.finish_saved_page(None);
    mode.handle_key("enter");
    assert_eq!(
        mode.opened.map(|row| row.selection),
        Some(SessionSelection::Resume(PathBuf::from("/x/older.jsonl")))
    );
}

#[test]
fn a_carried_partial_catalog_keeps_waiting_for_a_missing_anchor() {
    let mut mode = mode_with_anchor(Some("older"), Vec::new());
    mode.apply_saved_loaded(vec![saved_catalog_row("/x/new.jsonl", "new", "newer")]);
    mode.rebuild_rows();
    mode.finish_saved_page(more());
    assert!(mode.saved_catalog_loaded);
    mode.settle_carried_anchor();
    assert!(
        mode.anchor_selection_pending,
        "a carried page is not the complete catalog"
    );
    assert!(mode.next_saved_fetch().is_some());
    mode.handle_key("enter");
    assert!(mode.opened.is_none());
    mode.finish_saved_page(None);
    mode.settle_carried_anchor();
    assert!(
        !mode.anchor_selection_pending,
        "an exhausted catalog settles a missing anchor"
    );
}

#[test]
fn a_failed_continuation_retries_from_its_cursor() {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.apply_saved_loaded(vec![saved_catalog_row("/x/new.jsonl", "new", "newer")]);
    mode.rebuild_rows();
    mode.finish_saved_page(more());
    // The continuation page fails (the loop's `SavedFailed` arm).
    mode.saved_fetch_failed = true;
    assert!(mode.next_saved_fetch().is_none());
    mode.handle_key("o");
    assert!(
        !mode.take_saved_fetch_rearm(),
        "the retry never refetches the first page over the loaded rows"
    );
    assert_eq!(
        mode.next_saved_fetch(),
        Some(("page-two".to_string(), None)),
        "the search resumes the failed page's cursor"
    );
}
