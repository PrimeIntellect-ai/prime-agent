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
    store.branch_to(fork_point.as_deref()).unwrap();
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

/// A slice's rows (index, entry id, message) and its matching total.
type Slice = (Vec<(usize, String, Value)>, usize);

/// The reference slice: Python's `rows[start:][:limit]` over the full-branch display
/// rows the role filter keeps, each with its index among them.
fn reference_messages(
    store: &SessionFile,
    start: i64,
    limit: usize,
    keep_role: impl Fn(&str) -> bool,
) -> Slice {
    let rows: Vec<(String, Value)> = reference_branch(store)
        .into_iter()
        .filter_map(|entry| {
            let message = if entry.type_ == "compaction" {
                compaction_summary_message(entry, None)
            } else {
                entry_message(entry)?.into_owned()
            };
            keep_role(message_role(&message)?).then(|| (entry.id.clone(), message))
        })
        .collect();
    let total = i64::try_from(rows.len()).unwrap();
    let begin = if start < 0 {
        (total + start).max(0)
    } else {
        start.min(total)
    };
    let slice = rows
        .into_iter()
        .enumerate()
        .skip(usize::try_from(begin).unwrap())
        .take(limit)
        .map(|(index, (id, message))| (index, id, message))
        .collect();
    (slice, usize::try_from(total).unwrap())
}

fn messages_of(store: &mut SessionFile, start: i64, limit: usize, roles: &[&str]) -> Option<Slice> {
    store
        .session_messages(
            start,
            limit,
            |role| roles.contains(&"*") || roles.contains(&role),
            &std::collections::HashSet::new(),
        )
        .map(|slice| (slice.rows, slice.total))
}

/// The cached role counts, while fresh, equal a full recount of the branch.
fn assert_counts_fresh_and_exact(store: &SessionFile) {
    if let Some(counts) = &store.branch_roles {
        assert_eq!(counts, &store.recount_branch_roles());
    }
}

/// `rlm.session.messages` slices the filtered display transcript with Python slice
/// semantics: ranges from either end, past the end, and every role filter; slices near
/// the head walk from it, the rest from the leaf.
#[test]
fn session_messages_slice_the_filtered_branch() {
    let mut store = mixed_store();
    assert_counts_fresh_and_exact(&store);
    for roles in [
        &["*"][..],
        &["user"],
        &["toolResult", "custom"],
        &["compactionSummary"],
        &["nothing"],
    ] {
        for (start, limit) in [
            (-10, 10),
            (0, 5),
            (7, 3),
            (-1000, 3),
            (-3, 10),
            (10_000, 5),
            (4, 0),
            (30, 20),
            (-60, 20),
        ] {
            let expected = reference_messages(&store, start, limit, |role| {
                roles.contains(&"*") || roles.contains(&role)
            });
            assert_eq!(
                messages_of(&mut store, start, limit, roles),
                Some(expected),
                "{roles:?} [{start}:][:{limit}]"
            );
        }
    }
    // Paging back from a tail read by its first index continues it.
    let (tail, _) = messages_of(&mut store, -10, 10, &["user"]).unwrap();
    let first = i64::try_from(tail[0].0).unwrap();
    let (before, _) = messages_of(&mut store, first - 10, 10, &["user"]).unwrap();
    let (both, _) = messages_of(&mut store, -20, 20, &["user"]).unwrap();
    assert_eq!([before, tail].concat(), both);
}

/// Every role's count matches the reference walk.
fn assert_role_totals(store: &mut SessionFile) {
    for role in [
        "user",
        "assistant",
        "toolResult",
        "bashExecution",
        "custom",
        "compactionSummary",
    ] {
        let (_, expected) = reference_messages(store, 0, 0, |kept| kept == role);
        assert_eq!(
            messages_of(store, 0, 0, &[role]),
            Some((Vec::new(), expected)),
            "{role}"
        );
    }
    assert_counts_fresh_and_exact(store);
}

/// The stored role counts follow the leaf: appends (bookkeeping rows and a compaction
/// included) and forks keep them fresh, a reopened linear file loads them, and a
/// navigation leaves them for the next read to recount.
#[test]
fn role_counts_follow_the_active_branch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("counted.jsonl");
    let mut store = SessionFile::create("/tmp", None, 0);
    store.set_path(path.clone());
    let mut middle = None;
    for turn in 0..12 {
        append_turn(&mut store, turn);
        assert_counts_fresh_and_exact(&store);
        if turn == 6 {
            middle.clone_from(&store.leaf_id);
        }
    }
    store.append_entry(
        "compaction",
        json!({ "summary": "s", "firstKeptEntryId": middle, "tokensBefore": 10 }),
    );
    let target = store.leaf_id.clone().unwrap();
    store.append_label_change(&target, Some("here")).unwrap();
    assert!(store.branch_roles.is_some());
    assert_role_totals(&mut store);
    assert_eq!(store.branch_roles.as_ref().unwrap()["compactionSummary"], 1);

    store.rewrite().unwrap();
    let mut reopened = SessionFile::open(&path).unwrap();
    assert!(reopened.branch_roles.is_some());
    assert_role_totals(&mut reopened);

    store.branch_to(middle.as_deref()).unwrap();
    assert!(store.branch_roles.is_none());
    assert_role_totals(&mut store);
    append_turn(&mut store, 12);
    assert!(store.branch_roles.is_some());
    assert_role_totals(&mut store);

    let leaf = store.leaf_id.clone().unwrap();
    let mut forked = store.create_branched_file(&leaf, dir.path()).unwrap();
    assert!(forked.branch_roles.is_some());
    assert_role_totals(&mut forked);
    store.replace_with_branch(Some(&target)).unwrap();
    assert!(store.branch_roles.is_some());
    assert_role_totals(&mut store);
}

/// The assistant row whose tool call is still running is the step in flight: it is
/// neither returned nor counted until its call settles.
#[test]
fn the_in_flight_assistant_row_is_left_out() {
    let mut store = SessionFile::create("/tmp", None, 0);
    store.append_message(&user("read the transcript"));
    store.append_message(&call("cell"));
    let mut roles = |running: &[&str]| {
        let running = running.iter().map(ToString::to_string).collect();
        let slice = store.session_messages(-10, 10, |_| true, &running).unwrap();
        let roles: Vec<String> = slice
            .rows
            .iter()
            .map(|(_, _, message)| message_role(message).unwrap().to_string())
            .collect();
        (roles, slice.total)
    };
    assert_eq!(roles(&["cell"]), (vec!["user".to_string()], 1));
    assert_eq!(
        roles(&[]),
        (vec!["user".to_string(), "assistant".to_string()], 2)
    );
}

/// A windowed store counts its unloaded prefix: totals and indexes match the hydrated
/// store, a slice inside the window reads without the prefix, and a slice reaching
/// into it asks for hydration. Hydration carries the counts over unchanged.
#[test]
fn a_windowed_store_counts_its_prefix_and_reads_its_window() {
    let dir = tempfile::tempdir().unwrap();
    let mut windowed = windowed_store(dir.path());
    messages_of(&mut windowed, 0, 0, &["*"]).unwrap();
    assert_counts_fresh_and_exact(&windowed);
    let mut full = windowed.clone();
    full.ensure_full_history().unwrap();
    assert!(full.window.is_none());
    assert_eq!(full.branch_roles, windowed.branch_roles);
    assert_counts_fresh_and_exact(&full);
    for roles in [&["*"][..], &["user"], &["toolResult", "custom"]] {
        let (_, total) = messages_of(&mut full, 0, 0, roles).unwrap();
        assert_eq!(
            messages_of(&mut windowed, 0, 0, roles),
            Some((Vec::new(), total))
        );
        assert_eq!(
            messages_of(&mut windowed, -5, 5, roles),
            messages_of(&mut full, -5, 5, roles),
            "{roles:?}"
        );
        assert_eq!(messages_of(&mut windowed, 0, 5, roles), None, "{roles:?}");
    }
}
