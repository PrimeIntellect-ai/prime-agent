//! The session-stats unit battery: the counts, the kept-region
//! messages, the context usage, and the cost.

use super::*;

/// The captured-attribution fixture end to end: `get_session_stats`
/// reports the folded (attributed) totals — cost $0 → $0.0089957,
/// input 2690 → 52898 — while `totalTokens` stays 23032 (the
/// aggregate keeps the row's context size, not a sum).
#[test]
fn captured_attribution_fixture_stats_count_the_fold() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/attribution-fold-captured.jsonl");
    let store = SessionFile::open(&path).unwrap();
    let stats = session_stats(&store, None);
    assert_eq!(stats["userMessages"], json!(2));
    assert_eq!(stats["assistantMessages"], json!(1));
    assert_eq!(stats["totalMessages"], json!(3));
    assert_eq!(
        stats["tokens"],
        json!({
            "input": 52898, "output": 5863, "cacheRead": 18560, "cacheWrite": 0,
            "total": 77321,
        })
    );
    assert_eq!(stats["cost"].as_f64(), Some(0.008_995_7));
}

fn message(role: &str, fields: &Value) -> Value {
    let mut value = json!({ "role": role });
    if let (Some(object), Some(fields)) = (value.as_object_mut(), fields.as_object()) {
        for (key, field) in fields {
            object.insert(key.clone(), field.clone());
        }
    }
    value
}

fn store_with(entries: &[(&str, Value)]) -> SessionFile {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let path = dir.path().join("session.jsonl");
    let mut lines = vec![json!({
        "type": "session", "version": 3, "id": "s1",
        "timestamp": "2026-09-16T02:10:02.842Z", "cwd": "/tmp",
    })
    .to_string()];
    let mut parent_id = Option::<String>::None;
    for (index, (type_, fields)) in entries.iter().enumerate() {
        let id = format!("e{index}");
        let mut entry = json!({
            "type": type_,
            "id": id,
            "timestamp": "2026-09-16T02:11:00.000Z",
        });
        if let (Some(object), Some(fields)) = (entry.as_object_mut(), fields.as_object()) {
            for (key, field) in fields {
                object.insert(key.clone(), field.clone());
            }
            if let Some(parent) = &parent_id {
                object.insert("parentId".to_string(), json!(parent));
            }
        }
        parent_id = Some(id);
        lines.push(entry.to_string());
    }
    let content = lines.join("\n");
    std::fs::write(&path, content).expect("write session");
    SessionFile::open(&path).expect("open session file")
}

fn entry_with_usage(total_tokens: u64) -> (&'static str, Value) {
    let usage = if total_tokens > 0 {
        json!({
            "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0,
            "totalTokens": total_tokens,
            "cost": { "total": 0.25 },
        })
    } else {
        json!({
            "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0,
            "cost": { "total": 0.25 },
        })
    };
    (
        "message",
        json!({
            "message": message("assistant", &json!({
                "content": [
                    { "type": "text", "text": "hello" },
                    { "type": "toolCall", "name": "bash", "arguments": { "command": "ls" } },
                ],
                "usage": usage,
            }))
        }),
    )
}

/// A ghost-parent gap (one lost append) must not zero the token
/// totals: the usage accounting bridges the gap, while the context
/// estimate stays on the strict branch (the model-facing truth).
#[test]
fn ghost_gap_does_not_zero_the_token_totals() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("ghosted.jsonl");
    let assistant = json!({
        "role": "assistant",
        "content": [{ "type": "text", "text": "spent" }],
        "usage": {
            "input": 10, "output": 5, "cacheRead": 100, "cacheWrite": 0,
            "totalTokens": 115,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
        },
    })
    .to_string();
    let lines = [
        json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
        json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "hi"}}).to_string(),
        json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "message": serde_json::from_str::<serde_json::Value>(&assistant).unwrap()}).to_string(),
        json!({"type": "message", "id": "e3", "parentId": "8b5f0d21", "timestamp": "2026-09-22T00:00:03.000Z", "message": {"role": "user", "content": "after the gap"}}).to_string(),
    ];
    std::fs::write(&path, lines.join("\n")).unwrap();
    let store = SessionFile::open(&path).unwrap();
    assert_eq!(
        store.branch().len(),
        1,
        "the strict walk truncates at the ghost"
    );
    let stats = session_stats(&store, Some(1000));
    assert_eq!(
        stats["tokens"]["input"],
        json!(10),
        "the pre-gap usage counts"
    );
    assert_eq!(stats["tokens"]["output"], json!(5));
    assert_eq!(stats["tokens"]["cacheRead"], json!(100));
    assert_eq!(stats["tokens"]["total"], json!(115));
    assert_eq!(stats["assistantMessages"], json!(1));
    assert_eq!(stats["userMessages"], json!(2));
    // The context estimate anchors on the strict branch only: the gap
    // entry's user message estimates, the pre-gap assistant does not.
    assert_eq!(
        stats["contextUsage"]["tokens"],
        json!(4),
        "13 chars, ceil/4"
    );
}

#[test]
fn counts_messages_tool_calls_and_tokens() {
    let store = store_with(&[
        (
            "message",
            json!({ "message": message("user", &json!({ "content": "hi there" })) }),
        ),
        entry_with_usage(128),
        (
            "message",
            json!({ "message": message("toolResult", &json!({ "content": "out" })) }),
        ),
    ]);
    let stats = session_stats(&store, Some(1000));
    let expected = json!({
        "sessionFile": store.path.display().to_string(),
        "sessionId": "s1",
        "userMessages": 1,
        "assistantMessages": 1,
        "toolCalls": 1,
        "toolResults": 1,
        "totalMessages": 3,
        "tokens": { "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "total": 15 },
        "cost": 0.25,
        "contextUsage": { "tokens": 129, "contextWindow": 1000, "percent": 12.9 },
    });
    assert_eq!(stats, expected);
}

#[test]
fn context_usage_sums_trailing_estimates() {
    // No usage at all: everything is estimated.
    let store = store_with(&[(
        "message",
        json!({ "message": message("user", &json!({ "content": "12345678" })) }),
    )]);
    let stats = session_stats(&store, Some(1000));
    assert_eq!(stats["contextUsage"]["tokens"], 2, "8 chars / 4");
    assert_eq!(stats["contextUsage"]["percent"], 0.2);
}

#[test]
fn compaction_without_post_usage_returns_null_tokens() {
    let store = store_with(&[
        (
            "message",
            json!({ "message": message("user", &json!({ "content": "hi" })) }),
        ),
        entry_with_usage(50),
        ("compaction", json!({ "firstKeptEntryId": "e2" })),
        (
            "message",
            json!({ "message": message("user", &json!({ "content": "again" })) }),
        ),
    ]);
    let stats = session_stats(&store, Some(1000));
    assert_eq!(stats["contextUsage"]["tokens"], Value::Null);
    assert_eq!(stats["contextUsage"]["percent"], Value::Null);
    assert_eq!(stats["contextUsage"]["contextWindow"], 1000);
}

#[test]
fn compaction_with_post_usage_estimates() {
    let store = store_with(&[
        entry_with_usage(50),
        ("compaction", json!({ "firstKeptEntryId": "e1" })),
        entry_with_usage(300),
        (
            "message",
            json!({ "message": message("user", &json!({ "content": "1234" })) }),
        ),
    ]);
    let stats = session_stats(&store, Some(1000));
    assert_eq!(
        stats["contextUsage"]["tokens"], 301,
        "300 usage + 1 estimated"
    );
}

#[test]
fn no_context_window_omits_usage() {
    let store = store_with(&[entry_with_usage(128)]);
    let stats = session_stats(&store, None);
    assert!(stats.get("contextUsage").is_none());
}

#[test]
fn aborted_assistant_usage_is_skipped() {
    let store = store_with(&[
        (
            "message",
            json!({ "message": message("assistant", &json!({
                "content": [{ "type": "text", "text": "partial" }],
                "stopReason": "aborted",
                "usage": { "input": 1, "output": 1, "totalTokens": 500 },
            })) }),
        ),
        entry_with_usage(128),
    ]);
    let stats = session_stats(&store, Some(1000));
    // The aborted turn still counts as an assistant message, but only
    // the valid usage anchors the estimate.
    assert_eq!(stats["assistantMessages"], 2);
    // Token totals sum every assistant usage, aborted or not (TS
    // getSessionStats does not filter on stopReason).
    assert_eq!(stats["tokens"]["total"], 17);
    assert_eq!(stats["contextUsage"]["tokens"], 128);
}

/// The compaction boundary against the windowed reader, on a minimal
/// synthetic compacted session (real transcripts are never committed;
/// the `#[ignore]` test below re-verifies against the local capture).
/// The pre-cut ancestry, the kept rows that precede the compaction
/// entry in file order, the summarizer's own usage riding the
/// compaction entry, and the post-compaction tail all pin their own
/// numbers, and the parent chain stays intact from leaf to root so the
/// windowed reader serves a real window that retains only the kept
/// region - the parity claim is non-trivial: the windowed store never
/// loads the pre-cut ancestry and must still report the same active
/// numbers as the full store.
#[test]
fn compaction_boundary_serves_the_windowed_reader() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("windowed-boundary.jsonl");
    let usage = |input: u64, output: u64, cache_read: u64, total: u64, cost: f64| {
        // The full `UsageCost` shape: the typed `FileEntry::Compaction`
        // payload parses `usage` (the fixture's rows must deserialize
        // in the window walk), and the cost struct requires every
        // field — a bare `{ "total": ... }` fails the payload parse and
        // the boundary never forms.
        json!({
            "input": input, "output": output, "cacheRead": cache_read,
            "cacheWrite": 0, "totalTokens": total,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": cost },
        })
    };
    let row = |id: &str, parent: Option<&str>, value: Value| {
        json!({
            "type": "message", "id": id, "parentId": parent,
            "timestamp": "2026-09-23T00:00:00.000Z",
            "message": value,
        })
        .to_string()
    };
    let user = |id: &str, parent: Option<&str>| {
        row(id, parent, message("user", &json!({ "content": "hi" })))
    };
    let assistant = |id: &str, parent: Option<&str>, spent: Value| {
        row(
            id,
            parent,
            message(
                "assistant",
                &json!({
                    "provider": "prime-inference", "model": "internal/glm-5.3-fast",
                    "content": [{ "type": "text", "text": "hi" }],
                    "stopReason": "stop",
                    "usage": spent,
                }),
            ),
        )
    };
    let lines = [
        json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-23T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
        // Pre-cut ancestry: spend the active stats must not report.
        user("u1", None),
        assistant("a1", Some("u1"), usage(1000, 200, 5000, 6200, 0.75)),
        user("u2", Some("a1")),
        assistant("a2", Some("u2"), usage(800, 150, 3000, 3950, 1.25)),
        // The kept region starts at u3 (firstKeptEntryId); the kept
        // rows precede the compaction entry in file order, as in a
        // real compacted file.
        user("u3", Some("a2")),
        assistant("a3", Some("u3"), usage(600, 120, 2000, 2720, 0.25)),
        json!({
            "type": "compaction", "id": "c1", "parentId": "a3",
            "timestamp": "2026-09-23T00:00:00.000Z",
            "summary": "summary", "firstKeptEntryId": "u3", "tokensBefore": 100,
            "usage": usage(9999, 99, 0, 10098, 0.5),
        })
        .to_string(),
        // Post-compaction tail; a5 is the leaf the window follows.
        user("u4", Some("c1")),
        assistant("a4", Some("u4"), usage(400, 80, 1000, 1480, 0.125)),
        user("u5", Some("a4")),
        assistant("a5", Some("u5"), usage(500, 100, 2500, 3100, 0.5)),
    ];
    std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
    let full = SessionFile::open(&path).unwrap();
    let windowed = SessionFile::open_windowed(&path).unwrap();
    assert!(
        windowed.window.is_some(),
        "the intact ancestry must serve a real window"
    );
    assert!(
        windowed.by_id.contains_key("u3") && !windowed.by_id.contains_key("a2"),
        "the window loads the kept region only, without the pre-cut ancestry"
    );
    let expected = json!({
        "sessionFile": path.display().to_string(),
        "sessionId": "s1",
        "userMessages": 3,
        "assistantMessages": 3,
        "toolCalls": 0,
        "toolResults": 0,
        "totalMessages": 6,
        "tokens": {
            "input": 1_500, "output": 300, "cacheRead": 5_500,
            "cacheWrite": 0, "total": 7_300,
        },
        "cost": 0.875,
        "contextUsage": {
            "tokens": 3_100, "contextWindow": 1_000, "percent": 310.0,
        },
    });
    assert_eq!(session_stats(&full, Some(1_000)), expected);
    // The windowed store (retained region) and the full store walk the
    // same kept region and must serve identical active numbers.
    assert_eq!(session_stats(&windowed, Some(1_000)), expected);
}

/// The audit's captured devbox session (TS-written, sanitized: content
/// stripped; ids, parentIds, timestamps, roles, usage, and the
/// compaction row verbatim): one compaction at the audit-captured
/// boundary where the pre-cut ancestry carries 952 assistant turns /
/// $0.2900872 / 154,979,520 cacheRead that TS drops from the active
/// stats, and the kept region is the 2622 turns / $3.921395 TS
/// reports post-compaction. Real captured transcripts are never
/// committed; point `PA_ACTIVE_STATS_CAPTURED_FIXTURE` at a local
/// copy to run it.
#[test]
#[ignore = "set PA_ACTIVE_STATS_CAPTURED_FIXTURE to the captured session path"]
fn captured_compaction_boundary_matches_ts_active_stats() {
    let fixture = std::env::var("PA_ACTIVE_STATS_CAPTURED_FIXTURE")
        .expect("set PA_ACTIVE_STATS_CAPTURED_FIXTURE to the captured session path");
    let path = std::path::PathBuf::from(fixture);
    let full = SessionFile::open(&path).expect("fixture opens");
    let windowed = SessionFile::open_windowed(&path).expect("windowed open");
    assert!(
        windowed.window.is_some(),
        "fixture must exercise the windowed reader"
    );
    let expected = json!({
        "sessionFile": path.display().to_string(),
        "sessionId": "01a0a7fa-3d00-773b-bd1e-a97597d89476",
        "userMessages": 348,
        "assistantMessages": 2622,
        "toolCalls": 748,
        "toolResults": 748,
        "totalMessages": 3718,
        "tokens": {
            "input": 3_667_340,
            "output": 142_884,
            "cacheRead": 219_856_050,
            "cacheWrite": 269_974,
            "total": 223_936_248,
        },
        "cost": 3.921_395,
        "contextUsage": {
            "tokens": 53_519,
            "contextWindow": 200_000,
            "percent": 26.759_500_000_000_003,
        },
    });
    assert_eq!(session_stats(&full, Some(200_000)), expected);
    // The windowed store (retained region) and the full store walk the
    // same kept region and must serve identical active numbers.
    assert_eq!(session_stats(&windowed, Some(200_000)), expected);
}

/// The compaction boundary in miniature: the pre-cut ancestry is spend
/// the active stats must not report; the kept region — kept rows
/// before the compaction entry and a ghost-parent row whose parent
/// was minted but never persisted — is what they must. The
/// side-question FORK (cm1/a4, chained from the same compaction row
/// the active line continues from) is spend the RELOADED active list
/// does not hold: TS `buildSessionContext` walks the leaf-to-root
/// path only, so a branch moved away from (and the forks it left
/// behind) stay out of the stats — their spend survives on the
/// whole-file surfaces (the saved rows, `/context`). The
/// summarizer's own usage rides the compaction entry and stays out.
#[test]
fn compaction_boundary_drops_the_pre_cut_ancestry() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("boundary.jsonl");
    let assistant = |id: &str, parent: Option<&str>, cost: f64| {
        json!({
            "type": "message", "id": id, "parentId": parent,
            "timestamp": "2026-09-23T00:00:00.000Z",
            "message": {
                "role": "assistant",
                "provider": "prime-inference", "model": "internal/glm-5.3-fast",
                "content": [{ "type": "text", "text": "hi" }],
                "stopReason": "stop",
                "usage": { "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                           "totalTokens": 15, "cost": { "total": cost } },
            },
        })
        .to_string()
    };
    let user = |id: &str, parent: Option<&str>| {
        json!({
            "type": "message", "id": id, "parentId": parent,
            "timestamp": "2026-09-23T00:00:00.000Z",
            "message": { "role": "user", "content": "hi" },
        })
        .to_string()
    };
    let lines = [
        json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-23T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
        user("u1", None),
        assistant("a1", Some("u1"), 0.125),
        user("u2", Some("a1")),
        assistant("a2", Some("u2"), 0.25),
        // The kept region starts at u3 (firstKeptEntryId); the kept
        // rows precede the compaction entry in file order, as in a
        // real compacted file.
        user("u3", Some("a2")),
        assistant("a3", Some("u3"), 0.25),
        json!({
            "type": "compaction", "id": "c1", "parentId": "a3",
            "timestamp": "2026-09-23T00:00:00.000Z",
            "summary": "summary", "firstKeptEntryId": "u3", "tokensBefore": 100,
            "usage": { "input": 999, "output": 9, "cacheRead": 0, "cacheWrite": 0,
                       "totalTokens": 1008, "cost": { "total": 0.75 } },
        })
        .to_string(),
        json!({
            "type": "custom_message", "id": "cm1", "parentId": "c1",
            "timestamp": "2026-09-23T00:00:00.000Z",
            "customType": "agent_message", "content": "side", "display": true,
        })
        .to_string(),
        assistant("a4", Some("cm1"), 0.5),
        user("u4", Some("c1")),
        assistant("a5", Some("u4"), 0.25),
        user("u5", Some("a5")),
        assistant("a6", Some("ghost01"), 0.5),
    ];
    std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
    let full = SessionFile::open(&path).unwrap();
    let windowed = SessionFile::open_windowed(&path).unwrap();
    // The ghost parent dangles the windowed reader's chain-following,
    // so it falls back to the full reader: both stores must still
    // serve the same kept-region numbers.
    assert!(windowed.window.is_none());
    let expected = json!({
        "sessionFile": path.display().to_string(),
        "sessionId": "s1",
        "userMessages": 3,
        "assistantMessages": 3,
        "toolCalls": 0,
        "toolResults": 0,
        "totalMessages": 6,
        "tokens": { "input": 30, "output": 15, "cacheRead": 0, "cacheWrite": 0, "total": 45 },
        "cost": 1.0,
        // The strict branch truncates at the ghost parent, so the
        // context estimate anchors on the last row alone.
        "contextUsage": { "tokens": 15, "contextWindow": 1000, "percent": 1.5 },
    });
    assert_eq!(session_stats(&full, Some(1000)), expected);
    assert_eq!(session_stats(&windowed, Some(1000)), expected);
}

/// A compaction written on an ABANDONED branch never bounds the
/// active list: TS `buildSessionContext` records the last compaction
/// along its leaf-to-root path only, so the active line keeps its own
/// full history (and the fork's rows — including its compaction and
/// the fork's post-compaction spend — stay out of the active stats).
#[test]
fn an_abandoned_branchs_compaction_never_bounds_the_active_list() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("fork-compaction.jsonl");
    let assistant = |id: &str, parent: Option<&str>, cost: f64| {
        json!({
            "type": "message", "id": id, "parentId": parent,
            "timestamp": "2026-09-23T00:00:00.000Z",
            "message": {
                "role": "assistant",
                "provider": "prime-inference", "model": "internal/glm-5.3-fast",
                "content": [{ "type": "text", "text": "hi" }],
                "stopReason": "stop",
                "usage": { "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                           "totalTokens": 15, "cost": { "total": cost } },
            },
        })
        .to_string()
    };
    let user = |id: &str, parent: Option<&str>| {
        json!({
            "type": "message", "id": id, "parentId": parent,
            "timestamp": "2026-09-23T00:00:00.000Z",
            "message": { "role": "user", "content": "hi" },
        })
        .to_string()
    };
    let lines = [
        json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-23T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
        user("u1", None),
        assistant("a1", Some("u1"), 0.25),
        user("u2", Some("a1")),
        assistant("a2", Some("u2"), 0.25),
        // An abandoned fork off u2: its rows AND its compaction sit in
        // the file AFTER the fork point but BEFORE the active line
        // continues.
        user("x1", Some("a2")),
        assistant("x2", Some("x1"), 0.25),
        json!({
            "type": "compaction", "id": "cx", "parentId": "x2",
            "timestamp": "2026-09-23T00:00:00.000Z",
            "summary": "fork summary", "firstKeptEntryId": "x1", "tokensBefore": 100,
            "usage": { "input": 999, "output": 9, "cacheRead": 0, "cacheWrite": 0,
                       "totalTokens": 1008, "cost": { "total": 0.75 } },
        })
        .to_string(),
        // The active line continues from a2 (the fork was abandoned).
        user("u3", Some("a2")),
        assistant("a3", Some("u3"), 0.25),
    ];
    std::fs::write(
        &path,
        format!(
            "{}
",
            lines.join(
                "
"
            )
        ),
    )
    .unwrap();
    let store = SessionFile::open(&path).unwrap();
    let stats = session_stats(&store, None);
    // The active branch keeps its own full history — the abandoned
    // fork's compaction does not bound it (a file-order walk would
    // drop u1..a2 from the "kept region" and count the fork's rows).
    assert_eq!(stats["userMessages"], json!(3));
    assert_eq!(stats["assistantMessages"], json!(3));
    assert_eq!(stats["totalMessages"], json!(6));
    assert_eq!(stats["tokens"]["input"], json!(30));
    assert_eq!(stats["tokens"]["total"], json!(45));
    assert_eq!(stats["cost"], json!(0.75));
}
