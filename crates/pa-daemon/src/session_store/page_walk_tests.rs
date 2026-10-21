//! The transcript page reads only its window: a step counter pins its cost, and a
//! full-branch reference (the pre-index walk) pins its rows.

use super::*;

fn user(text: &str) -> Value {
    json!({ "role": "user", "content": text, "timestamp": 1000 })
}

fn assistant(text: &str) -> Value {
    json!({
        "role": "assistant", "provider": "p", "model": "m", "timestamp": 10,
        "content": [{ "type": "text", "text": text }],
    })
}

fn call(id: &str) -> Value {
    json!({
        "role": "assistant", "provider": "p", "model": "m", "timestamp": 10,
        "content": [{ "type": "toolCall", "id": id, "name": "bash", "arguments": {} }],
    })
}

fn result(id: &str) -> Value {
    json!({
        "role": "toolResult", "toolCallId": id, "toolName": "bash", "timestamp": 12,
        "content": [{ "type": "text", "text": "out" }], "isError": false,
    })
}

fn bash_row() -> Value {
    json!({
        "role": "bashExecution", "command": "echo", "output": "", "exitCode": 0,
        "cancelled": false, "truncated": false, "timestamp": 11,
    })
}

/// One turn of varied rows: tool pairs (interleaved, duplicate ids, orphans), custom
/// rows, and bookkeeping entries that are not display rows.
fn append_turn(store: &mut SessionFile, turn: usize) {
    store.append_message(&user(&format!("prompt {turn}")));
    if turn.is_multiple_of(5) {
        store.append_model_change("provider", "model");
    }
    match turn % 6 {
        0 => {
            store.append_message(&call("a"));
            store.append_message(&result("a"));
        }
        1 => {
            let earlier = format!("e{turn}");
            store.append_message(&call(&earlier));
            store.append_message(&call("boundary"));
            store.append_message(&result(&earlier));
            store.append_message(&bash_row());
            store.append_message(&result("boundary"));
        }
        2 => {
            for _ in 0..2 {
                store.append_entry(
                    "custom_message",
                    json!({ "customType": "note", "content": "c", "display": true }),
                );
            }
        }
        3 => {
            store.append_entry("custom", json!({ "customType": "marker", "data": {} }));
            store.append_message(&result("orphan"));
        }
        4 if turn == 16 => {
            for _ in 0..12 {
                store.append_message(&result("orphan-run"));
            }
        }
        _ => {}
    }
    store.append_message(&assistant(&format!("reply {turn}")));
}

/// Branches, a mid-session compaction, and an abandoned sibling branch.
fn mixed_store() -> SessionFile {
    let mut store = SessionFile::create("/tmp", None, 0);
    let mut kept = None;
    let mut fork_point = None;
    for turn in 0..40 {
        append_turn(&mut store, turn);
        if turn == 15 {
            kept.clone_from(&store.leaf_id);
        }
        if turn == 20 {
            store.append_entry(
                "compaction",
                json!({ "summary": "s", "firstKeptEntryId": kept, "tokensBefore": 10 }),
            );
        }
        if turn == 30 {
            fork_point.clone_from(&store.leaf_id);
        }
    }
    store.leaf_id = fork_point;
    for turn in 40..55 {
        append_turn(&mut store, turn);
    }
    store
}

/// A compacted file reopened through the window, with rows appended after it.
fn windowed_store(dir: &std::path::Path) -> SessionFile {
    let path = dir.join("windowed.jsonl");
    let mut store = SessionFile::create("/tmp", None, 0);
    store.set_path(path.clone());
    let mut kept = None;
    for turn in 0..60 {
        append_turn(&mut store, turn);
        if turn == 45 {
            kept.clone_from(&store.leaf_id);
        }
    }
    store.append_entry(
        "compaction",
        json!({ "summary": "s", "firstKeptEntryId": kept, "tokensBefore": 10 }),
    );
    for turn in 60..64 {
        append_turn(&mut store, turn);
    }
    store.rewrite().unwrap();
    let mut windowed = SessionFile::open_windowed(&path).unwrap();
    assert!(windowed.window.is_some());
    for turn in 64..67 {
        append_turn(&mut windowed, turn);
    }
    windowed
}

/// The pre-index branch: parent-id lookups from the leaf, stopping at a cycle or the
/// window's excluded rows.
fn reference_branch(store: &SessionFile) -> Vec<&SessionEntry> {
    let mut path = Vec::new();
    let mut visited = std::collections::HashSet::new();
    let mut current = store.leaf_id.as_deref().and_then(|id| store.entry(id));
    while let Some(entry) = current {
        if !visited.insert(entry.id.as_str()) {
            break;
        }
        if let Some(window) = &store.window {
            let index = store.by_id[&entry.id];
            if index < window.loaded_entries && !window.retained_ids.contains(&entry.id) {
                break;
            }
        }
        path.push(entry);
        current = entry.parent_id.as_deref().and_then(|id| store.entry(id));
    }
    path.reverse();
    path
}

type PageView = (Vec<Value>, Option<String>, Option<String>, bool);

fn page_view(rows: TranscriptPageRows) -> PageView {
    (
        rows.messages,
        rows.first_entry_id,
        rows.last_entry_id,
        rows.more,
    )
}

/// The pre-index page: every display row of the whole branch, anchors found by scan,
/// and the cut settled over all rows.
fn reference_page(store: &SessionFile, page: &TranscriptPage) -> Option<PageView> {
    let mut rows: Vec<DisplayRow<'_>> = reference_branch(store)
        .into_iter()
        .filter_map(|entry| {
            let message = if entry.type_ == "compaction" {
                std::borrow::Cow::Owned(compaction_summary_message(entry, None))
            } else {
                entry_message(entry)?
            };
            Some((entry.id.as_str(), message))
        })
        .collect();
    let position = |rows: &[DisplayRow<'_>], id: &str| rows.iter().position(|(row, _)| *row == id);
    let (start, end, more) = match page {
        TranscriptPage::End { before, limit } => {
            let end = match before {
                Some(id) => position(&rows, id)?,
                None => rows.len(),
            };
            let start = settle_cut(&rows, end.saturating_sub(*limit));
            (start, end, start > 0 || store.window.is_some())
        }
        TranscriptPage::Start {
            after,
            until,
            limit,
        } => {
            let until = match until {
                Some(id) => position(&rows, id)?,
                None => rows.len(),
            };
            let start = match after {
                Some(id) => position(&rows, id)? + 1,
                None => 0,
            }
            .min(until);
            let end = match start.saturating_add(*limit) {
                end if end >= until => until,
                end if end == start => start,
                end => Some(settle_cut(&rows, end))
                    .filter(|cut| *cut > start)
                    .unwrap_or(until),
            };
            (start, end, end < until)
        }
    };
    rows.truncate(end);
    let page_rows = rows.split_off(start);
    Some((
        page_rows
            .iter()
            .map(|(_, message)| message.clone().into_owned())
            .collect(),
        page_rows.first().map(|(id, _)| (*id).to_string()),
        page_rows.last().map(|(id, _)| (*id).to_string()),
        more,
    ))
}

fn assert_page(store: &SessionFile, page: &TranscriptPage) -> Option<PageView> {
    let actual = store.transcript_page(page).map(page_view);
    assert_eq!(actual, reference_page(store, page), "{page:?}");
    actual
}

/// Every page boundary a client reaches (tail-first End pages, head-first Start pages
/// with and without `until`), plus every entry as an anchor and as `historyLeafId`.
fn assert_matches_reference(store: &SessionFile) {
    for entry in store.entries() {
        assert_eq!(
            store.branch_contains(&entry.id),
            reference_branch(store).iter().any(|row| row.id == entry.id),
            "{}",
            entry.id
        );
    }
    for limit in [3, 5, 8, 64] {
        let (_, tail_first, _, mut more) = assert_page(
            store,
            &TranscriptPage::End {
                before: None,
                limit,
            },
        )
        .unwrap();
        let mut before = tail_first.clone();
        while let Some(id) = before.filter(|_| more) {
            let (_, first, _, older) = assert_page(
                store,
                &TranscriptPage::End {
                    before: Some(id),
                    limit,
                },
            )
            .unwrap();
            (before, more) = (first, older);
        }
        for until in [None, tail_first.clone()] {
            let mut after = None;
            loop {
                let (_, _, last, more) = assert_page(
                    store,
                    &TranscriptPage::Start {
                        after: after.clone(),
                        until: until.clone(),
                        limit,
                    },
                )
                .unwrap();
                if !more {
                    break;
                }
                after = last;
            }
        }
        for anchor in store.entries().iter().map(|entry| Some(entry.id.clone())) {
            assert_page(
                store,
                &TranscriptPage::End {
                    before: anchor.clone(),
                    limit,
                },
            );
            for until in [None, tail_first.clone()] {
                assert_page(
                    store,
                    &TranscriptPage::Start {
                        after: anchor.clone(),
                        until,
                        limit,
                    },
                );
            }
        }
    }
}

#[test]
fn pages_match_the_full_branch_reference() {
    assert_matches_reference(&mixed_store());
    let dir = tempfile::tempdir().unwrap();
    assert_matches_reference(&windowed_store(dir.path()));
}

/// The one rule change: tool calls pair only inside the slice around the cut, so a call
/// far from its result no longer drags the page back to it.
#[test]
fn a_call_more_than_a_page_from_its_result_does_not_move_the_cut() {
    let mut store = SessionFile::create("/tmp", None, 0);
    store.append_message(&call("slow"));
    for turn in 0..100 {
        store.append_message(&assistant(&format!("reply {turn}")));
    }
    store.append_message(&result("slow"));
    for turn in 0..10 {
        store.append_message(&assistant(&format!("after {turn}")));
    }
    let page = store
        .transcript_page(&TranscriptPage::End {
            before: None,
            limit: 20,
        })
        .unwrap();
    assert_eq!(page.messages.len(), 20);
    assert!(page.more);
}

fn steps_for<T>(read: impl FnOnce() -> T) -> (T, usize) {
    CHAIN_STEPS.with(|steps| steps.set(0));
    let value = read();
    (value, CHAIN_STEPS.with(std::cell::Cell::get))
}

/// A page on a long session walks a number of entries bounded by the page, not the session.
#[test]
fn a_page_walks_only_its_window() {
    let mut store = SessionFile::create("/tmp", None, 0);
    let mut deep = String::new();
    let mut turn = 0;
    while store.entries().len() < 120_000 {
        append_turn(&mut store, turn % 15 + 50);
        if turn == 4_000 {
            deep.clone_from(store.leaf_id.as_ref().unwrap());
        }
        turn += 1;
    }
    let limit = 64;
    let bound = 8 * limit + 512;
    let pages = [
        TranscriptPage::End {
            before: None,
            limit,
        },
        TranscriptPage::End {
            before: Some(deep.clone()),
            limit,
        },
        TranscriptPage::Start {
            after: Some(deep.clone()),
            until: None,
            limit,
        },
        TranscriptPage::Start {
            after: None,
            until: None,
            limit,
        },
    ];
    for page in pages {
        let (rows, steps) = steps_for(|| store.transcript_page(&page));
        assert!(rows.is_some_and(|rows| rows.messages.len() >= limit / 2));
        assert!(steps <= bound, "{page:?} took {steps} steps");
    }
    let (contains, steps) = steps_for(|| store.branch_contains(&deep));
    assert!(contains);
    assert!(steps <= 128, "historyLeafId check took {steps} steps");
}
