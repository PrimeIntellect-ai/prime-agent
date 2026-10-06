//! The session-store unit battery: the store lifecycle, the bounded header readers, the
//! attribution folds, the wire shapes, and the resumable scan.

use super::*;
use serde_json::json;

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pa-daemon-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// The captured-attribution fixture: real devbox session rows (content sanitized,
/// cwd/repoUrl neutralized; ids, timestamps, and usage verbatim).
fn captured_attribution_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/attribution-fold-captured.jsonl")
}

#[test]
fn bounded_header_matches_the_line_read() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/repo", None, 0);
    session.append_message(&json!({"role": "user", "content": "hi", "timestamp": 1u64}));
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    session.rewrite().unwrap();
    assert_eq!(
        read_session_header_bounded(&path),
        read_session_header(&path)
    );
    assert!(is_valid_session_file(&path));
}

#[test]
fn bounded_header_rejects_a_non_json_first_line() {
    let dir = temp_dir();
    let path = dir.join("bad.jsonl");
    fs::write(&path, "truncated junk without json\n").unwrap();
    assert_eq!(read_session_header_bounded(&path), None);
    assert!(!is_valid_session_file(&path));
}

#[test]
fn bounded_header_refuses_an_over_long_first_line() {
    let dir = temp_dir();
    // A cwd long enough to push the serialized header past the 512-byte
    // bound: the bounded read judges nothing; the line read still does.
    let mut session = SessionFile::create(&format!("/repo/{}", "x".repeat(600)), None, 0);
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    session.rewrite().unwrap();
    assert_eq!(read_session_header_bounded(&path), None);
    assert!(read_session_header(&path).is_some());
}

#[test]
fn bounded_header_reads_an_unterminated_first_line() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/repo", None, 0);
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    session.rewrite().unwrap();
    let header_line = fs::read_to_string(&path).unwrap();
    fs::write(&path, header_line.trim_end()).unwrap();
    assert_eq!(
        read_session_header_bounded(&path),
        read_session_header(&path)
    );
}

#[test]
fn bounded_header_strips_a_crlf_line_return() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/repo", None, 0);
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    session.rewrite().unwrap();
    let header_line = fs::read_to_string(&path).unwrap();
    fs::write(&path, format!("{}\r\n", header_line.trim_end())).unwrap();
    assert_eq!(
        read_session_header_bounded(&path),
        read_session_header(&path)
    );
}

#[test]
fn bounded_header_treats_an_empty_file_as_headerless() {
    let dir = temp_dir();
    let path = dir.join("empty.jsonl");
    fs::write(&path, "").unwrap();
    assert_eq!(read_session_header_bounded(&path), None);
    assert!(!is_valid_session_file(&path));
}

#[test]
fn open_folds_captured_child_usage_attributions() {
    let store = SessionFile::open(&captured_attribution_fixture()).unwrap();
    // The raw file row: input 2690 / totalTokens 23032 / cost $0. The last
    // attribution's cumulative aggregate replaces it: input 52898 /
    // totalTokens 23032 (unchanged) / cost $0.0089957. Six entries fold once, never sum.
    let assistant = store.entry("4f61089a").expect("captured target row");
    let usage = &assistant.fields["message"]["usage"];
    assert_eq!(usage["input"], json!(52898));
    assert_eq!(usage["output"], json!(5863));
    assert_eq!(usage["cacheRead"], json!(18560));
    assert_eq!(usage["cacheWrite"], json!(0));
    assert_eq!(usage["totalTokens"], json!(23032));
    assert_eq!(usage["cost"]["total"].as_f64(), Some(0.008_995_7));
}

#[test]
fn append_entry_folds_a_live_child_usage_attribution() {
    let mut store = SessionFile::create("/tmp", None, 0);
    store.append_message(&json!({"role": "user", "content": "hi", "timestamp": 1u64}));
    let assistant = store.append_message(&json!({
        "role": "assistant", "content": "hello", "provider": "p", "model": "m",
        "timestamp": 2u64,
        "usage": {"input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0,
                  "totalTokens": 12,
                  "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
    }));
    store.append_entry(
            "child_usage_attributed",
            json!({
                "targetId": assistant,
                "origin": "spawn_task",
                "childUsage": {"input": 5, "output": 1, "cacheRead": 0, "cacheWrite": 0,
                               "totalTokens": 6,
                               "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.01}},
                "aggregateUsage": {"input": 15, "output": 3, "cacheRead": 0, "cacheWrite": 0,
                                   "totalTokens": 12,
                                   "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.01}},
            }),
        );
    // The live seam folds without a reopen.
    let row = store.entry(&assistant).unwrap();
    assert_eq!(row.fields["message"]["usage"]["input"], json!(15));
    assert_eq!(row.fields["message"]["usage"]["output"], json!(3));
    assert_eq!(row.fields["message"]["usage"]["totalTokens"], json!(12));
    assert_eq!(
        row.fields["message"]["usage"]["cost"]["total"].as_f64(),
        Some(0.01)
    );
}

#[test]
fn a_malformed_aggregate_does_not_zero_the_target_row() {
    let mut store = SessionFile::create("/tmp", None, 0);
    store.append_message(&json!({"role": "user", "content": "hi", "timestamp": 1u64}));
    let assistant = store.append_message(&json!({
        "role": "assistant", "content": "hello", "provider": "p", "model": "m",
        "timestamp": 2u64,
        "usage": {"input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0,
                  "totalTokens": 12,
                  "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
    }));
    // A malformed aggregate (null / a scalar) must not overwrite the row's valid usage — the fold
    // skips it.
    store.append_entry(
        "child_usage_attributed",
        json!({"targetId": assistant, "origin": "spawn_task", "aggregateUsage": null}),
    );
    store.append_entry(
        "child_usage_attributed",
        json!({"targetId": assistant, "origin": "direct_user", "aggregateUsage": 42}),
    );
    let row = store.entry(&assistant).unwrap();
    assert_eq!(row.fields["message"]["usage"]["input"], json!(10));
    assert_eq!(row.fields["message"]["usage"]["totalTokens"], json!(12));
}

/// The end-of-load fold installs the newest cumulative aggregate (TS in-process fold parity).
#[test]
fn the_depth_two_chain_reports_the_folded_aggregate() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("depth-two.jsonl");
    let row = |id: &str, parent: Option<&str>, message: Value| {
        json!({
            "type": "message", "id": id, "parentId": parent,
            "timestamp": "2026-09-24T00:00:00.000Z",
            "message": message,
        })
        .to_string()
    };
    let assistant_usage = json!({
        "input": 1_000, "output": 40, "cacheRead": 0, "cacheWrite": 0,
        "totalTokens": 1_040,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.10 },
    });
    let lines = [
            json!({"type": "session", "version": 3, "id": "child-s1", "timestamp": "2026-09-24T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
            row("u1", None, json!({"role": "user", "content": "task"})),
            row(
                "a1",
                Some("u1"),
                json!({
                    "role": "assistant",
                    "provider": "prime-inference", "model": "internal/glm-5.3-fast",
                    "content": [{ "type": "text", "text": "hi" }],
                    "stopReason": "stop",
                    "usage": assistant_usage,
                }),
            ),
            // The grandchild's attribution into the child's spawning row: the cumulative aggregate
            // the fold installs at load.
            json!({
                "type": "child_usage_attributed", "id": "attr1", "parentId": "a1",
                "timestamp": "2026-09-24T00:00:01.000Z",
                "targetId": "a1", "origin": "spawn_task",
                "childUsage": { "input": 500, "output": 10, "cacheRead": 0, "cacheWrite": 0,
                                "totalTokens": 510,
                                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.05 } },
                "aggregateUsage": { "input": 1_500, "output": 50, "cacheRead": 0, "cacheWrite": 0,
                                    "totalTokens": 1_040,
                                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.15 } },
            })
            .to_string(),
        ];
    std::fs::write(&path, lines.join("\n")).unwrap();
    let store = SessionFile::open(&path).unwrap();
    let folded = store.entry("a1").expect("the target row");
    assert_eq!(
        folded.fields["message"]["usage"]["input"],
        json!(1_500),
        "the end-of-load fold installed the cumulative aggregate"
    );
    // The observer walk reads the FOLDED store: the depth-2 batch carries the
    // grandchild's spend (input 1,500 — the raw 1,000 would mean it vanished at depth 2).
    let (batches, next) = crate::rlm_child_usage::child_usage_batches(store.entries(), 0);
    assert_eq!(next, store.entries().len(), "the walk consumes the file");
    let spawn = batches
        .iter()
        .find(|(origin, _)| matches!(origin, pa_types::session::ChildUsageOrigin::SpawnTask))
        .expect("the spawning turn's batch");
    assert_eq!(
        spawn.1.input, 1_500,
        "the folded aggregate rides the report"
    );
    assert_eq!(spawn.1.cost.total, pa_types::JsNumber(0.15));
}

/// The Anthropic subscription warning's once-per-session-lifecycle gate
/// (operator directive 2026-09-29): [`SessionFile::mark_anthropic_warning_shown`]
/// persists the marker row durably, the live flag flips, and BOTH reopen
/// paths (the full [`SessionFile::open`] and the windowed
/// [`SessionFile::open_windowed`]) hydrate the gate from the file — the
/// reattach/resume contract: a session that warned once never warns again
/// however it reopens. A fresh session serves the gate closed.
#[test]
fn marking_the_warning_persists_and_both_reopens_hydrate_it() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/repo", None, 0);
    session.append_message(&json!({"role": "user", "content": "hi", "timestamp": 1u64}));
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    session.rewrite().unwrap();
    assert!(
        !session.anthropic_warning_shown(),
        "an unmarked session serves the gate closed"
    );

    session.mark_anthropic_warning_shown().unwrap();
    assert!(
        session.anthropic_warning_shown(),
        "the live flag flipped with the mark"
    );

    // The durable row: the exact custom entry the lifecycle reads back.
    let text = fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("\"customType\":\"anthropic_subscription_warning_shown\""),
        "the marker row reached the session file: {text}"
    );

    // The full reopen (a plain resume) and the windowed reopen (the
    // create-over-file replay of a long session) both hydrate the gate.
    let reopened = SessionFile::open(&path).unwrap();
    assert!(reopened.anthropic_warning_shown());
    let windowed = SessionFile::open_windowed(&path).unwrap();
    assert!(windowed.anthropic_warning_shown());

    // A session that never warned stays closed through both opens.
    let mut fresh = SessionFile::create("/repo", None, 0);
    let fresh_path = dir.join(session_file_name(fresh.session_id()));
    fresh.set_path(fresh_path.clone());
    fresh.rewrite().unwrap();
    assert!(!SessionFile::open(&fresh_path)
        .unwrap()
        .anthropic_warning_shown());
    assert!(!SessionFile::open_windowed(&fresh_path)
        .unwrap()
        .anthropic_warning_shown());
}

/// The bots' round on the full open (the PR's Medium): the gate rides
/// the ACTIVE branch — a marker on an abandoned or sibling branch must
/// never suppress the warning for the open leaf. The windowed walk
/// already followed the active chain; the full open's all-entries scan
/// disagreed, so the two reopen paths answered differently on the same
/// file (and `install_full_history` could overwrite the windowed
/// answer with the full scan's).
#[test]
fn an_off_branch_marker_never_hydrates_the_full_open_gate() {
    let dir = temp_dir();
    let row = |id: &str, parent: Option<&str>, message: Value| {
        json!({
            "type": "message", "id": id, "parentId": parent,
            "timestamp": "2026-09-30T00:00:00.000Z",
            "message": message,
        })
        .to_string()
    };
    let marker = |id: &str, parent: &str| {
        json!({
            "type": "custom", "id": id, "parentId": parent,
            "timestamp": "2026-09-30T00:00:01.000Z",
            "customType": "anthropic_subscription_warning_shown",
            "data": { "shown": true },
        })
        .to_string()
    };
    let header = |id: &str| {
        json!({"type": "session", "version": 3, "id": id, "timestamp": "2026-09-30T00:00:00.000Z", "cwd": "/tmp"}).to_string()
    };

    // The marker hangs off u1 as a SIBLING of the live branch: the open
    // leaf (the last row, b1) walks u1 -> header and never meets it.
    let path = dir.join("off-branch-marker.jsonl");
    std::fs::write(
        &path,
        [
            header("off-1"),
            row("u1", None, json!({"role": "user", "content": "hi"})),
            marker("m1", "u1"),
            row(
                "b1",
                Some("u1"),
                json!({"role": "user", "content": "the sibling turn"}),
            ),
        ]
        .join("\n"),
    )
    .unwrap();
    assert!(
        !SessionFile::open(&path).unwrap().anthropic_warning_shown(),
        "an off-branch marker never hydrates the full open's gate"
    );
    assert!(
        !SessionFile::open_windowed(&path)
            .unwrap()
            .anthropic_warning_shown(),
        "the windowed walk agrees: the active chain carries no marker"
    );

    // The same marker ON the active branch answers open — the sibling
    // branch's rows stay irrelevant.
    let path_on = dir.join("on-branch-marker.jsonl");
    std::fs::write(
        &path_on,
        [
            header("on-1"),
            row("u1", None, json!({"role": "user", "content": "hi"})),
            marker("m1", "u1"),
            row(
                "b1",
                Some("m1"),
                json!({"role": "user", "content": "after the marker"}),
            ),
        ]
        .join("\n"),
    )
    .unwrap();
    assert!(SessionFile::open(&path_on)
        .unwrap()
        .anthropic_warning_shown());
    assert!(SessionFile::open_windowed(&path_on)
        .unwrap()
        .anthropic_warning_shown());
}

#[test]
fn creates_and_loads_a_session() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/tmp", None, 0);
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    session.append_session_state("active");
    session.append_message(&json!({"role": "user", "content": "hi", "timestamp": 1u64}));
    session.append_message(&json!({"role": "assistant", "content": "hello", "provider": "p", "model": "m", "timestamp": 2u64}));
    session.rewrite().unwrap();

    let loaded = SessionFile::open(&path).unwrap();
    assert_eq!(loaded.session_id(), session.session_id());
    assert_eq!(loaded.message_count(), 2);
    assert_eq!(loaded.state().as_deref(), Some("active"));
    let messages = loaded.messages();
    assert_eq!(messages.len(), 2);
    assert_eq!(crate::types::message_text(&messages[0]), "hi");

    let info = read_session_info(&path).unwrap();
    assert_eq!(info.message_count, 2);
    assert_eq!(info.first_message, "hi");
    assert_eq!(
        info.model.as_ref().map(|(p, m)| (p.as_str(), m.as_str())),
        Some(("p", "m"))
    );
    let _ = fs::remove_dir_all(&dir);
}

/// A cyclic file would otherwise hang the create's blocking task.
#[test]
fn a_cyclic_parent_chain_terminates_the_branch_walk() {
    let mut session = SessionFile::create("/tmp", None, 0);
    session.append_message(&json!({"role": "user", "content": "a", "timestamp": 1u64}));
    session.append_message(&json!({"role": "user", "content": "b", "timestamp": 2u64}));
    let first = session.entries[0].id.clone();
    let second = session.entries[1].id.clone();
    session.entries[0].parent_id = Some(second);
    session.entries[1].parent_id = Some(first);
    let branch = session.branch();
    assert!(
        branch.len() <= 2,
        "the cyclic walk terminates: {:?}",
        branch
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>()
    );
    // The root-to-leaf typed walk (the restore's reader) terminates too.
    let typed = session.branch_file_entries();
    assert!(typed.len() <= 2, "branch_file_entries terminates");
}

/// A malformed or empty level never replaces a prior good one.
#[test]
fn scan_keeps_the_latest_persisted_thinking_level() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/tmp", None, 0);
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    session.append_thinking_level_change("medium");
    session.append_thinking_level_change("high");
    session.rewrite().unwrap();
    let info = read_session_info(&path).unwrap();
    assert_eq!(info.thinking_level.as_deref(), Some("high"));
    let _ = fs::remove_dir_all(&dir);
}

/// The in-memory index only adopts entries the file accepted.
#[test]
fn failed_persist_keeps_the_store_walkable() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/tmp", None, 0);
    let file = dir.join(session_file_name(session.session_id()));
    session.set_path(file.clone());
    let first = session
        .persist_entry(
            "message",
            json!({ "message": { "role": "user", "content": "hi" } }),
        )
        .unwrap();
    let blocker = dir.join("blocked");
    fs::create_dir_all(&blocker).unwrap();
    session.set_path(blocker);
    assert!(session
        .persist_entry(
            "message",
            json!({ "message": { "role": "user", "content": "x" } })
        )
        .is_err());
    assert_eq!(
        session.entries().len(),
        1,
        "only the persisted entry stays indexed"
    );
    assert_eq!(session.leaf_id(), Some(first.as_str()));
    session.set_path(file.clone());
    let third = session
        .persist_entry(
            "message",
            json!({ "message": { "role": "user", "content": "again" } }),
        )
        .unwrap();
    // The reloaded file chains first -> third: the failed append added nothing, so the next one
    // chains from the last persisted entry.
    let loaded = SessionFile::open(&file).unwrap();
    let chain: Vec<&str> = loaded
        .branch()
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    assert_eq!(chain, [first.as_str(), third.as_str()]);
    let _ = fs::remove_dir_all(&dir);
}

/// The replay's dedup predicate is the disclosure row's fields: the exact
/// row is recognized wherever it came from; a different disclosure stays distinct.
#[test]
fn declaration_stamped_entry_survives_reload_as_the_same_identity() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/tmp", None, 0);
    let file = dir.join(session_file_name(session.session_id()));
    session.set_path(file.clone());
    let disclosure = json!({
        "customType": "compaction_outcome",
        "content": "Compaction cancelled",
        "display": true,
        "details": { "reason": "threshold", "outcome": "cancelled" },
    });
    let declared_at = "2026-09-23T06:00:00Z";
    session
        .persist_entry_at("custom_message", disclosure.clone(), declared_at)
        .unwrap();

    // The rebuilt transcript (a fresh open) holds the exact row: the replay's fields-only dedup
    // matches it, so the row is not appended twice.
    let loaded = SessionFile::open(&file).unwrap();
    let already_disclosed =
        |entry: &SessionEntry| entry.type_ == "custom_message" && entry.fields == disclosure;
    assert!(loaded.entries().iter().any(already_disclosed));

    // The worker's own abort arm carries the same fields under its own persist-time stamp:
    // still not a duplicate.
    let mut with_own_row = SessionFile::open(&file).unwrap();
    with_own_row
        .persist_entry("custom_message", disclosure.clone())
        .unwrap();
    assert!(with_own_row.entries().iter().any(already_disclosed));

    let failed = json!({
        "customType": "compaction_outcome",
        "content": "Compaction failed: Summarization failed",
        "display": true,
        "details": { "reason": "threshold", "outcome": "failed" },
    });
    assert!(!loaded
        .entries()
        .iter()
        .any(|entry| entry.type_ == "custom_message" && entry.fields == failed));
    let _ = fs::remove_dir_all(&dir);
}

/// The missing id was minted but never persisted, so the walk continues from the gap entry's
/// file predecessor (the writer's leaf at the time).
#[test]
fn branch_bridged_bridges_ghost_parent_gaps() {
    let dir = temp_dir();
    let path = dir.join("ghosted.jsonl");
    let content = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "hi"}}),
            json!({"type": "session_state", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "state": {"status": "active"}}),
            json!({"type": "message", "id": "e3", "parentId": "8b5f0d21", "timestamp": "2026-09-22T00:00:03.000Z", "message": {"role": "user", "content": "after the gap"}}),
            json!({"type": "message", "id": "e4", "parentId": "e3", "timestamp": "2026-09-22T00:00:04.000Z", "message": {"role": "assistant", "content": "ok"}}),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&path, content).unwrap();
    let store = SessionFile::open(&path).unwrap();
    let strict: Vec<&str> = store
        .branch()
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    assert_eq!(
        strict,
        ["e3", "e4"],
        "the strict walk truncates at the ghost"
    );
    let bridged: Vec<&str> = store
        .branch_bridged()
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    assert_eq!(bridged, ["e1", "e2", "e3", "e4"]);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn branch_bridged_skips_abandoned_chains_after_a_persisted_branch_move() {
    let dir = temp_dir();
    let path = dir.join("moved.jsonl");
    let content = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "root"}}),
            json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "user", "content": "abandoned a"}}),
            json!({"type": "message", "id": "e3", "parentId": "e2", "timestamp": "2026-09-22T00:00:03.000Z", "message": {"role": "user", "content": "abandoned b"}}),
            json!({"type": "branch_summary", "id": "m1", "parentId": "e1", "timestamp": "2026-09-22T00:00:04.000Z", "fromId": "e1", "summary": "moved back"}),
            json!({"type": "message", "id": "e4", "parentId": "8b5f0d21", "timestamp": "2026-09-22T00:00:05.000Z", "message": {"role": "user", "content": "after the move"}}),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&path, content).unwrap();
    let store = SessionFile::open(&path).unwrap();
    let bridged: Vec<&str> = store
        .branch_bridged()
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    assert_eq!(bridged, ["e1", "m1", "e4"]);
    let _ = fs::remove_dir_all(&dir);
}

/// Forked-off entries stay excluded; only a MISSING parent bridges.
#[test]
fn branch_bridged_matches_the_strict_walk_on_clean_files() {
    let dir = temp_dir();
    let path = dir.join("clean.jsonl");
    let content = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "root"}}),
            json!({"type": "message", "id": "fork", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "user", "content": "forked away"}}),
            json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:03.000Z", "message": {"role": "assistant", "content": "leaf chain"}}),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&path, content).unwrap();
    let store = SessionFile::open(&path).unwrap();
    let strict: Vec<&str> = store
        .branch()
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    let bridged: Vec<&str> = store
        .branch_bridged()
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    assert_eq!(strict, bridged);
    assert_eq!(strict, ["e1", "e2"], "the fork stays off the leaf chain");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn scan_builds_transcript_search_text() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/tmp", None, 0);
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    session.append_message(
        &json!({"role": "user", "content": "fix the login bug", "timestamp": 1u64}),
    );
    session.append_message(&json!({
        "role": "assistant",
        "content": [{ "type": "text", "text": "fixed in auth.rs" }],
        "provider": "p", "model": "m", "timestamp": 2u64
    }));
    // Tool traffic is counted but never enters the search corpus.
    session
        .append_message(&json!({"role": "toolResult", "content": "tool noise", "timestamp": 3u64}));
    session.rewrite().unwrap();

    let info = read_session_info(&path).unwrap();
    assert_eq!(info.all_messages_text, "fix the login bug fixed in auth.rs");
    let _ = fs::remove_dir_all(&dir);
}

/// Raw usage keyed by id, aggregates replacing raw blocks, child spend
/// subtracted — `session_usage`'s tests pin the fold, this pins the scan's wiring.
#[test]
fn scan_folds_the_saved_row_usage_summary() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/tmp", None, 0);
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    let assistant_id = session.append_message(&json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "run it" }],
            "provider": "p", "model": "m", "timestamp": 1u64,
            "usage": {
                "input": 100, "output": 10, "cacheRead": 20, "cacheWrite": 0,
                "totalTokens": 130,
                "cost": { "input": 0.0, "output": 0.5, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.5 }
            }
        }));
    session.append_entry(
            "child_usage_attributed",
            json!({
                "targetId": assistant_id, "origin": "spawn_task",
                "childUsage": {
                    "input": 30, "output": 3, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 33,
                    "cost": { "input": 0.0, "output": 0.125, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.125 }
                },
                "aggregateUsage": {
                    "input": 130, "output": 13, "cacheRead": 20, "cacheWrite": 0,
                    "totalTokens": 163,
                    "cost": { "input": 0.0, "output": 0.5, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.5 }
                }
            }),
        );
    session.append_entry(
            "compaction",
            json!({
                "summary": "kept", "firstKeptEntryId": assistant_id, "tokensBefore": 100,
                "usage": {
                    "input": 50, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 55,
                    "cost": { "input": 0.0, "output": 0.25, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.25 }
                }
            }),
        );
    session.rewrite().unwrap();

    let info = read_session_info(&path).unwrap();
    // Own: aggregate (150 in + 20 cache, 13 out, $0.5) + compaction
    // (50, 5, $0.25) - child (30, 3, $0.125).
    assert_eq!(
        info.usage,
        Some(crate::session_usage::SessionUsageSummary {
            input_tokens: 170,
            output_tokens: 15,
            cost: 0.625
        })
    );
    let _ = fs::remove_dir_all(&dir);
}

/// TS `JSON.parse` keeps the row, so every present field survives the partial block.
#[test]
fn scan_keeps_messages_with_partial_usage_objects() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/tmp", None, 0);
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    session.append_message(&json!({"role": "user", "content": "run it", "timestamp": 1u64}));
    session.append_message(&json!({
        "role": "assistant",
        "content": [{ "type": "text", "text": "done" }],
        "provider": "p", "model": "m", "timestamp": 2u64,
        "usage": { "input": 5, "output": 1, "totalTokens": 6 }
    }));
    session.rewrite().unwrap();

    let info = read_session_info(&path).unwrap();
    assert_eq!(info.message_count, 2);
    assert_eq!(info.model, Some(("p".to_string(), "m".to_string())));
    assert!(info.all_messages_text.contains("done"));
    assert_eq!(
        info.usage,
        Some(crate::session_usage::SessionUsageSummary {
            input_tokens: 5,
            output_tokens: 1,
            cost: 0.0
        })
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn scan_omits_usage_without_billable_work() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/tmp", None, 0);
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    session.append_message(&json!({"role": "user", "content": "hi", "timestamp": 1u64}));
    session.rewrite().unwrap();

    let info = read_session_info(&path).unwrap();
    assert_eq!(info.usage, None);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn transcript_search_text_caps_at_the_ts_limit() {
    let dir = temp_dir();
    let mut session = SessionFile::create("/tmp", None, 0);
    let path = dir.join(session_file_name(session.session_id()));
    session.set_path(path.clone());
    for round in 0..3 {
        let message = "x".repeat(30 * 1024);
        session.append_message(&json!({
            "role": "user", "content": format!("{round} {message}"), "timestamp": round + 1
        }));
    }
    session.rewrite().unwrap();

    let info = read_session_info(&path).unwrap();
    assert_eq!(
        info.all_messages_text.chars().count(),
        SESSION_LIST_SEARCH_TEXT_MAX_CHARS
    );
    // Space-joined like TS: exactly one separator between messages.
    assert!(info.all_messages_text.starts_with("0 xxx"));
    assert!(info.all_messages_text.contains("1 xxx"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn search_text_char_counter_stays_in_lockstep_with_the_corpus() {
    // The O(1) running counter must equal `chars().count()` of the corpus at
    // every fold step — multibyte, mid-message cap cut, post-cap appends.
    let mut acc = SessionScanAccumulator::default();
    let texts = [
        "fix the login bug".to_string(),
        "ünïcödé — multibyte ✓ chars".to_string(),
        "x".repeat(66 * 1024),
        "post-cap tail that must not move the corpus".to_string(),
        "y".repeat(10),
    ];
    for (index, text) in texts.iter().enumerate() {
        let entry = json!({
            "type": "message",
            "id": format!("m{index}"),
            "timestamp": format!("{}", index + 1),
            "message": {"role": "user", "content": text}
        });
        fold_scan_entry(&mut acc, &entry.to_string()).unwrap();
        assert_eq!(
            acc.search_text_chars,
            acc.all_messages_text.chars().count(),
            "counter drift after fold {index}"
        );
        assert!(acc.all_messages_text.chars().count() <= SESSION_LIST_SEARCH_TEXT_MAX_CHARS);
    }
    assert_eq!(acc.first_message, "fix the login bug");
    assert_eq!(acc.message_count, 5);
    // The cap cut mid-message: the corpus holds exactly the limit.
    assert_eq!(acc.search_text_chars, SESSION_LIST_SEARCH_TEXT_MAX_CHARS);
}

#[test]
fn search_text_char_counter_matches_the_legacy_append() {
    // The reference append (the pre-counter shape: count, then extend) must produce the same
    // corpus for the same texts.
    let mut corpus = String::new();
    let mut count = 0usize;
    let texts = [
        String::new(),
        "one".to_string(),
        "twö with multibyte".to_string(),
        "z".repeat(SESSION_LIST_SEARCH_TEXT_MAX_CHARS + 10),
        "post-cap".to_string(),
    ];
    for text in &texts {
        let mut legacy = corpus.clone();
        if !text.is_empty() {
            let used = legacy.chars().count();
            if used < SESSION_LIST_SEARCH_TEXT_MAX_CHARS {
                if used > 0 {
                    legacy.push(' ');
                }
                let remaining = SESSION_LIST_SEARCH_TEXT_MAX_CHARS - legacy.chars().count();
                legacy.extend(text.chars().take(remaining));
            }
        }
        count = append_capped_search_text(&mut corpus, text, count);
        assert_eq!(corpus, legacy);
        assert_eq!(count, legacy.chars().count());
    }
}

#[test]
fn search_text_counter_lockstep_names_every_corpus_mutation_path() {
    // Every corpus-mutating path at the accumulator level: (1) a fresh fold's
    // appends, (2) the resume copy, (3) the torn-tail snapshot fold, and
    // (4) a rewritten file's fresh accumulator.
    let header_line = session_header_line(&SessionHeader {
        version: None,
        id: "s1".to_string(),
        timestamp: "2026-09-26T00:00:00.000Z".to_string(),
        cwd: "/repo".to_string(),
        parent_session: None,
        rlm_depth: None,
        git: None,
        rest: serde_json::Map::default(),
    })
    .to_string();
    let message = |text: &str, index: u64| {
        json!({
            "type": "message",
            "id": format!("m{index}"),
            "timestamp": index.to_string(),
            "message": {"role": "user", "content": text}
        })
        .to_string()
    };

    // (1) fresh fold, past the cap.
    let generation = SessionInfoGeneration {
        len: 4096,
        dev: 0,
        ino: 0,
        mtime: 0,
        mtime_ns: 0,
        ctime: 0,
        ctime_ns: 0,
    };
    let mut state = SessionScanState::fresh(generation);
    fold_scan_entry(&mut state.acc, &header_line).unwrap();
    fold_scan_entry(&mut state.acc, &message("first user turn", 1)).unwrap();
    fold_scan_entry(
        &mut state.acc,
        &message(&"x".repeat(SESSION_LIST_SEARCH_TEXT_MAX_CHARS), 2),
    )
    .unwrap();
    assert_eq!(
        state.acc.search_text_chars,
        state.acc.all_messages_text.chars().count()
    );
    assert_eq!(
        state.acc.all_messages_text.chars().count(),
        SESSION_LIST_SEARCH_TEXT_MAX_CHARS
    );

    // (2) the resume copy: the grown file's next appends fold into clone_for_resume's
    // accumulator - the counter travels in lockstep for post-cap appends.
    let mut resumed = state.clone_for_resume();
    assert_eq!(
        resumed.acc.search_text_chars,
        resumed.acc.all_messages_text.chars().count()
    );
    fold_scan_entry(&mut resumed.acc, &message("appended after cap", 3)).unwrap();
    assert_eq!(
        resumed.acc.search_text_chars,
        resumed.acc.all_messages_text.chars().count()
    );
    assert_eq!(
        resumed.acc.all_messages_text.chars().count(),
        SESSION_LIST_SEARCH_TEXT_MAX_CHARS
    );

    // (3) the torn-tail snapshot: build_info folds the torn line into a CLONE,
    // so the durable accumulator's counter stays untouched.
    let durable_before = state.acc.clone();
    let capped_info = state
            .build_info(
                Path::new("/repo/s1.jsonl"),
                || None,
                Some(r#"{"type":"message","id":"m4","timestamp":"4","message":{"role":"user","content":"torn tail"}}"#),
            )
            .unwrap();
    assert_eq!(
        capped_info.all_messages_text, durable_before.all_messages_text,
        "the cap bounds the snapshot fold too - a torn tail past it changes no corpus byte"
    );
    assert_eq!(
        state.acc.search_text_chars,
        durable_before.search_text_chars
    );
    assert_eq!(
        state.acc.search_text_chars,
        state.acc.all_messages_text.chars().count()
    );
    let mut uncapped = SessionScanState::fresh(generation);
    fold_scan_entry(&mut uncapped.acc, &header_line).unwrap();
    fold_scan_entry(&mut uncapped.acc, &message("user turn one", 1)).unwrap();
    let uncapped_durable = uncapped.acc.clone();
    let uncapped_info = uncapped
            .build_info(
                Path::new("/repo/s1.jsonl"),
                || None,
                Some(r#"{"type":"message","id":"m5","timestamp":"2","message":{"role":"user","content":"user turn two"}}"#),
            )
            .unwrap();
    assert_eq!(
        uncapped_info.all_messages_text,
        "user turn one user turn two"
    );
    assert_eq!(
        uncapped.acc.all_messages_text,
        uncapped_durable.all_messages_text
    );
    assert_eq!(
        uncapped.acc.search_text_chars,
        uncapped_durable.search_text_chars
    );

    // (4) a rewritten file re-folds from a fresh accumulator: corpus and counter restart together.
    let mut rewritten = SessionScanState::fresh(generation);
    assert_eq!(rewritten.acc.search_text_chars, 0);
    assert!(rewritten.acc.all_messages_text.is_empty());
    fold_scan_entry(&mut rewritten.acc, &header_line).unwrap();
    fold_scan_entry(&mut rewritten.acc, &message("rewrite from zero", 1)).unwrap();
    assert_eq!(
        rewritten.acc.search_text_chars,
        rewritten.acc.all_messages_text.chars().count()
    );
    assert_eq!(
        rewritten.acc.all_messages_text, "rewrite from zero",
        "a rewritten file's corpus is the fresh fold's, not the old session's"
    );
}

#[test]
fn durable_first_kept_entry_id_pins_the_boundary_the_read_retains() {
    // The parity scenario the frame diff caught: the engine reports an id that
    // never exists in the file; the re-cut must pin the boundary `messages()`
    // recognizes, or the retained tail is lost.
    let mut session = SessionFile::create("/tmp", None, 0);
    session.append_message(&json!({"role": "user", "content": "first", "timestamp": 1u64}));
    let usage = json!({
        "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
    });
    let assistant = |text: String, timestamp: u64| {
        json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": text }],
            "api": "faux", "provider": "p", "model": "m",
            "usage": usage, "stopReason": "stop", "timestamp": timestamp
        })
    };
    session.append_message(&assistant(format!("history {}", "word ".repeat(40)), 2u64));
    session.append_message(&json!({"role": "user", "content": "second turn", "timestamp": 3u64}));
    session.append_message(&assistant("second turn done".to_string(), 4u64));

    let durable_id = session.durable_first_kept_entry_id(5);
    // The cut keeps the whole second turn: its user message is the boundary (estimate: 4 + 2 >= 5
    // stops at the user entry).
    let kept = session
        .branch()
        .iter()
        .find(|entry| {
            entry.fields.get("message").and_then(|m| m.get("content"))
                == Some(&json!("second turn"))
        })
        .map(|entry| entry.id.clone())
        .expect("the second-turn user entry");
    assert_eq!(durable_id, Some(kept));

    let _ = session.persist_entry(
        "compaction",
        json!({ "summary": "the story", "firstKeptEntryId": durable_id, "tokensBefore": 12 }),
    );
    let messages = session.messages();
    // Wire order is summary-first (TS `buildSessionContext`); the retained messages follow.
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0].get("role"), Some(&json!("compactionSummary")));
    assert_eq!(crate::types::message_text(&messages[1]), "second turn");
    assert_eq!(crate::types::message_text(&messages[2]), "second turn done");
}

#[test]
fn entry_chain_links_parents() {
    let mut session = SessionFile::create("/tmp", None, 0);
    let a = session.append_entry("custom", json!({"customType": "x"}));
    let b = session.append_entry("custom", json!({"customType": "y"}));
    assert_eq!(
        session.entry(&b).unwrap().parent_id.as_deref(),
        Some(a.as_str())
    );
    assert_eq!(session.leaf_id(), Some(b.as_str()));
}

/// The id mint checks collisions against the maintained `by_id` index, not a rebuilt map.
#[test]
fn append_cost_does_not_grow_with_the_store() {
    let mut small = SessionFile::create("/tmp", None, 0);
    let mut large = SessionFile::create("/tmp", None, 0);
    for index in 0..30_000 {
        large.push_index(SessionEntry {
            type_: "custom".to_string(),
            id: format!("{index:08x}"),
            parent_id: None,
            timestamp: "2026-09-28T00:00:00.000Z".to_string(),
            fields: json!({}),
        });
    }
    // The fastest iteration per store, so a scheduler stall on one leg cannot flip the comparison.
    let mut small_fastest = std::time::Duration::MAX;
    let mut large_fastest = std::time::Duration::MAX;
    for _ in 0..500 {
        for (store, fastest) in [
            (&mut small, &mut small_fastest),
            (&mut large, &mut large_fastest),
        ] {
            let start = std::time::Instant::now();
            store.append_entry("custom", json!({}));
            store.persist_entry("custom", json!({})).unwrap();
            *fastest = (*fastest).min(start.elapsed());
        }
    }
    assert!(
        large_fastest < small_fastest * 10,
        "the fastest append on a 30k-entry store took {large_fastest:?}, on an empty store {small_fastest:?}"
    );
}

#[test]
fn skips_malformed_lines() {
    let dir = temp_dir();
    let path = dir.join("s.jsonl");
    fs::write(
            &path,
            format!(
                "{}\nnot json\n{}\n",
                json!({"type":"session","version":3,"id":"abc","timestamp":"t","cwd":"/x"}),
                json!({"type":"message","id":"aaaa1111","parentId":null,"timestamp":"t","message":{"role":"user","content":"hi"}})
            ),
        )
        .unwrap();
    let loaded = SessionFile::open(&path).unwrap();
    assert_eq!(loaded.message_count(), 1);
    let _ = fs::remove_dir_all(&dir);
}

/// The durable compaction row must byte-serialize in the TS key order
/// (verified against the TS binary's session file, battery run
/// 20260921T140248Z): type, id, parentId, timestamp, summary, firstKeptEntryId,
/// tokensBefore, details, fromHook, customInstructions?, usage, harnessDigest.
#[test]
fn durable_compaction_row_serializes_in_the_ts_key_order() {
    let entry = pa_types::session::CompactionEntry {
        summary: "pre-compaction reply 6".to_string(),
        first_kept_entry_id: "ebd5e444".to_string(),
        tokens_before: 110,
        details: Some(
            serde_json::to_value(
                &pa_core::session_engine::compaction_exec::CompactionDetails {
                    read_files: vec!["a.rs".to_string()],
                    modified_files: vec!["b.rs".to_string()],
                },
            )
            .unwrap(),
        ),
        from_hook: Some(false),
        custom_instructions: None,
        usage: Some(pa_types::ai::Usage {
            input: 20,
            output: 10,
            cache_read: 80,
            cache_write: 0,
            total_tokens: 110,
            cost: pa_types::ai::UsageCost::default(),
        }),
        harness_digest: Some("# Continual Harness State".to_string()),
        harness_state_fingerprint: None,
    };
    let fields = serde_json::to_value(&entry).unwrap();
    let mut session = SessionFile::create("/tmp", None, 0);
    session.append_entry("compaction", fields);
    let row = serde_json::to_string(session.entries.last().unwrap()).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&row).unwrap();
    let keys: Vec<&str> = parsed
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        vec![
            "type",
            "id",
            "parentId",
            "timestamp",
            "summary",
            "firstKeptEntryId",
            "tokensBefore",
            "details",
            "fromHook",
            "usage",
            "harnessDigest",
        ]
    );
    // The details block is the TS `readFiles`-first literal order, and usage keeps the TS
    // field order (input, output, cacheRead, cacheWrite, totalTokens, cost).
    let details = serde_json::to_string(parsed["details"].as_object().unwrap()).unwrap();
    assert_eq!(
        details,
        "{\"readFiles\":[\"a.rs\"],\"modifiedFiles\":[\"b.rs\"]}"
    );
    let usage: Vec<&str> = parsed["usage"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        usage,
        vec![
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "totalTokens",
            "cost"
        ]
    );
}

#[test]
fn resume_tail_window_matches_the_rolling_reference() {
    let mut state = SessionScanState::fresh(SessionInfoGeneration {
        len: 0,
        dev: 0,
        ino: 0,
        mtime: 0,
        mtime_ns: 0,
        ctime: 0,
        ctime_ns: 0,
    });
    let mut reference = [b'\n'; SESSION_SCAN_RESUME_TAIL_BYTES];
    let rolling_reference = |tail: &mut [u8; SESSION_SCAN_RESUME_TAIL_BYTES], line: &[u8]| {
        let keep = SESSION_SCAN_RESUME_TAIL_BYTES - 1;
        let mut combined = Vec::with_capacity(SESSION_SCAN_RESUME_TAIL_BYTES + line.len() + 1);
        if line.len() >= keep {
            combined.extend_from_slice(&line[line.len() - keep..]);
        } else {
            combined.extend_from_slice(tail);
            combined.extend_from_slice(line);
        }
        combined.push(b'\n');
        let start = combined
            .len()
            .saturating_sub(SESSION_SCAN_RESUME_TAIL_BYTES);
        tail.copy_from_slice(&combined[start..]);
    };
    let lines: Vec<Vec<u8>> = [
        &b""[..],
        b"x",
        b"fourteen xx",
        &b"exactly fifteen"[..],
        b"sixteen bytes..",
        &b"a much longer line than the window will ever keep"[..],
        b"",
        "multibyte 世界未詠 line".as_bytes(),
        &b"final"[..],
    ]
    .into_iter()
    .map(<[u8]>::to_vec)
    .collect();
    for line in &lines {
        state.advance_tail(line);
        rolling_reference(&mut reference, line);
        assert_eq!(state.tail, reference, "line {line:?}");
    }
    // The prefix-intact read keeps proving resumes from the same bytes.
    assert_eq!(state.tail, reference);
}

#[test]
fn session_header_line_leads_with_the_type_tag() {
    let header = SessionHeader {
        version: Some(3),
        id: "abc".to_string(),
        timestamp: "t".to_string(),
        cwd: "/x".to_string(),
        parent_session: None,
        rlm_depth: Some(0),
        git: None,
        rest: serde_json::Map::new(),
    };
    let line = serde_json::to_string(&session_header_line(&header)).unwrap();
    assert!(line.starts_with("{\"type\":\"session\",\"version\":3,\"id\":\"abc\""));
}
