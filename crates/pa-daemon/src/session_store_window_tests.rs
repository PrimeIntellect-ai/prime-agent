use super::*;

/// The attribution fold survives the windowed fast open on both sides of
/// the compaction boundary: an in-window attribution folds into its
/// retained assistant row, an attribution targeting a discarded-prefix
/// assistant folds into that raw row too (the fold runs on every read;
/// the windowed store never loads the row). The windowed store's
/// `session_stats` equals the full open's — the ACTIVE totals (TS
/// `buildSessionContext` cuts `state.messages` at the compaction, so
/// pre-cut spend — own or attributed — stays out; the discarded prefix's
/// folded aggregate survives only on the whole-file surfaces), never
/// losing or double-counting the attributed child spend on either path.
#[test]
fn windowed_open_folds_attributions_on_both_sides_of_the_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    let mut full = SessionFile::create("/tmp", None, 0);
    full.set_path(path.clone());
    let old = full.append_message(json!({
        "role":"assistant", "provider":"openai", "model":"test", "api":"openai-responses",
        "content":[{"type":"text","text":"old"}], "stopReason":"stop", "timestamp":0,
        "usage":{"input":100,"output":10,"cacheRead":5,"cacheWrite":0,"totalTokens":115,
        "cost":{"input":0.1,"output":0.01,"cacheRead":0.0,"cacheWrite":0.0,"total":0.11}}
    }));
    let mut kept = String::new();
    for i in 0..220 {
        let id = full
            .append_message(json!({"role":"user","content":format!("message {i}"),"timestamp":i}));
        if i == 210 {
            kept = id;
        }
    }
    let kept_assistant = full.append_message(json!({
        "role":"assistant", "provider":"openai", "model":"test", "api":"openai-responses",
        "content":[{"type":"text","text":"kept"}], "stopReason":"stop", "timestamp":221,
        "usage":{"input":7,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":9,
        "cost":{"input":0.0,"output":0.0,"cacheRead":0.0,"cacheWrite":0.0,"total":0.0}}
    }));
    full.append_entry(
        "compaction",
        json!({"summary":"summary","firstKeptEntryId":kept,"tokensBefore":10000}),
    );
    full.append_entry(
        "child_usage_attributed",
        json!({
            "targetId": kept_assistant, "origin": "spawn_task",
            "childUsage":{"input":3,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":4,
            "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.03}},
            "aggregateUsage":{"input":10,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":9,
            "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.03}}
        }),
    );
    full.append_entry(
        "child_usage_attributed",
        json!({
            "targetId": old, "origin": "spawn_task",
            "childUsage":{"input":50,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":55,
            "cost":{"input":0.05,"output":0.005,"cacheRead":0,"cacheWrite":0,"total":0.055}},
            "aggregateUsage":{"input":150,"output":15,"cacheRead":5,"cacheWrite":0,"totalTokens":115,
            "cost":{"input":0.15,"output":0.015,"cacheRead":0,"cacheWrite":0,"total":0.165}}
        }),
    );
    full.append_message(json!({"role":"user","content":"after","timestamp":222}));
    full.rewrite().unwrap();

    let windowed = SessionFile::open_windowed(&path).unwrap();
    assert!(windowed.window.is_some());
    // The retained target folded on the windowed path too (raw entries carry
    // the attribution rows; the metadata parse order cannot hide the fold).
    assert_eq!(
        windowed.entry(&kept_assistant).unwrap().fields["message"]["usage"]["input"],
        json!(10)
    );
    // The pre-cut target's fold also rides its raw row (the fold runs on
    // every read, either side of the boundary), and the windowed store
    // never loads that row — the discarded prefix stays discarded.
    let full = SessionFile::open(&path).unwrap();
    assert_eq!(
        full.entry(&old).unwrap().fields["message"]["usage"]["input"],
        json!(150)
    );
    assert!(windowed.entry(&old).is_none());
    // Windowed and full opens agree on the ACTIVE stats: TS
    // `buildSessionContext` cuts `state.messages` at the compaction
    // boundary, so the pre-cut ancestry — including its attribution-folded
    // aggregate — is spend the active stats must not report; the in-window
    // attribution rides the folded rows, and neither path loses or
    // double-counts the attributed spend. (The pre-cut fold survives on
    // the whole-file surfaces — the saved rows, `/context`.)
    assert_eq!(
        crate::session_stats::session_stats(&windowed, None),
        crate::session_stats::session_stats(&full, None)
    );
    let stats = crate::session_stats::session_stats(&full, None);
    assert_eq!(stats["tokens"]["input"], json!(10));
    assert_eq!(stats["tokens"]["output"], json!(3));
    assert_eq!(stats["tokens"]["cacheRead"], json!(0));
    assert_eq!(stats["cost"].as_f64(), Some(0.03));
}

#[test]
fn window_preserves_transcript_metadata_and_append_then_hydrate() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    let mut full = SessionFile::create("/tmp", None, 0);
    full.set_path(path.clone());
    full.append_session_info("old name");
    full.append_thinking_level_change("high");
    full.append_message(json!({
        "role":"assistant", "provider":"openai", "model":"test", "api":"openai-responses",
        "content":[{"type":"toolCall","id":"call","name":"bash","arguments":{}}],
        "stopReason":"toolUse", "timestamp":0,
        "usage":{"input":10,"output":5,"cacheRead":3,"cacheWrite":2,"totalTokens":20,
        "cost":{"input":0.1,"output":0.2,"cacheRead":0.3,"cacheWrite":0.4,"total":1.0}}
    }));
    let mut kept = String::new();
    for i in 0..220 {
        let id = full
            .append_message(json!({"role":"user","content":format!("message {i}"),"timestamp":i}));
        if i == 210 {
            kept = id;
        }
    }
    full.append_entry(
        "compaction",
        json!({"summary":"summary","firstKeptEntryId":kept,"tokensBefore":10000}),
    );
    full.append_message(json!({"role":"user","content":"after","timestamp":221}));
    full.rewrite().unwrap();
    let lease = crate::lease::acquire_runtime_session_lease(&path, dir.path()).unwrap();
    let mut window = SessionFile::open_windowed(&path).unwrap();
    window.lease = Some(std::sync::Arc::new(lease));
    assert!(window.window.is_some());
    assert_eq!(window.messages(), full.messages());
    assert_eq!(
        (
            window.message_count(),
            window.first_message(),
            window.session_name()
        ),
        (
            full.message_count(),
            full.first_message(),
            full.session_name()
        )
    );
    assert_eq!(
        crate::session_stats::session_stats(&window, Some(100_000)),
        crate::session_stats::session_stats(&full, Some(100_000))
    );
    assert!(window.rewrite().is_err());
    window
        .persist_entry(
            "message",
            json!({"message":{"role":"user","content":"appended","timestamp":222}}),
        )
        .unwrap();
    let warm = pa_core::session::window::WindowedSessionStore::open(&path)
        .unwrap()
        .unwrap();
    assert!(warm.read_stats().cache_hit);
    assert!(window.has_thinking_level());
    assert_eq!(window.compaction_count(), full.compaction_count());
    window
        .persist_entry("session_info", json!({"name":"renamed"}))
        .unwrap();
    window
        .persist_entry("session_state", json!({"state":{"status":"active"}}))
        .unwrap();
    let reopened_window = SessionFile::open_windowed(&path).unwrap();
    let reopened_full = SessionFile::open(&path).unwrap();
    assert_eq!(reopened_window.messages(), reopened_full.messages());
    assert_eq!(reopened_window.session_name(), Some("renamed"));
    assert_eq!(reopened_window.state(), reopened_full.state());
    assert_eq!(
        crate::session_stats::session_stats(&reopened_window, Some(100_000)),
        crate::session_stats::session_stats(&reopened_full, Some(100_000))
    );
    window.append_session_info("pending name");
    let leaf = window.leaf_id.clone();
    window.ensure_full_history().unwrap();
    assert_eq!(window.leaf_id, leaf);
    assert_eq!(window.message_count(), 223);
    assert_eq!(window.session_name(), Some("pending name"));
    assert_eq!(window.entries.len(), full.entries.len() + 4);
    window.rewrite().unwrap();
    let reopened = SessionFile::open(&path).unwrap();
    assert_eq!(reopened.messages(), window.messages());
    assert_eq!(reopened.entries.len(), window.entries.len());
}

#[test]
#[ignore = "requires a captured local session path"]
fn captured_window_matches_full_transcript_and_stats() {
    let source = PathBuf::from(std::env::var("PA_WINDOW_FIXTURE").unwrap());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("capture.jsonl");
    std::fs::copy(source, &path).unwrap();
    let lease = std::sync::Arc::new(
        crate::lease::acquire_runtime_session_lease(&path, dir.path()).unwrap(),
    );
    let start = std::time::Instant::now();
    let full = SessionFile::open(&path).unwrap();
    let full_elapsed = start.elapsed();
    for phase in ["cold", "warm", "append-warm"] {
        let start = std::time::Instant::now();
        let mut window = SessionFile::open_windowed(&path).unwrap();
        window.lease = Some(lease.clone());
        let elapsed = start.elapsed();
        assert!(
            window.window.is_some(),
            "fixture must exercise window reader"
        );
        let reference = SessionFile::open(&path).unwrap();
        assert_eq!(window.messages(), reference.messages());
        assert_eq!(
            crate::session_stats::session_stats(&window, Some(200_000)),
            crate::session_stats::session_stats(&reference, Some(200_000))
        );
        assert_eq!(
            (
                window.message_count(),
                window.first_message(),
                window.session_name()
            ),
            (
                reference.message_count(),
                reference.first_message(),
                reference.session_name()
            )
        );
        let probe = pa_core::session::window::WindowedSessionStore::open(&path)
            .unwrap()
            .unwrap();
        assert!(probe.read_stats().cache_hit);
        eprintln!("phase={phase} full={full_elapsed:?} open={elapsed:?} bytes={} jsonl_bytes={} ranges={:?} entries={}/{}", path.metadata().unwrap().len(), probe.read_stats().jsonl_bytes, probe.read_stats().jsonl_ranges, window.entries.len(), full.entries.len());
        if phase == "warm" {
            let original = std::fs::read(&path).unwrap();
            let started = std::time::Instant::now();
            window
                .persist_entry("session_state", json!({"state":{"status":"active"}}))
                .unwrap();
            eprintln!("resume_active_append={:?}", started.elapsed());
            assert!(std::fs::read(&path).unwrap().starts_with(&original));
            let maintained = pa_core::session::window::WindowedSessionStore::open(&path)
                .unwrap()
                .unwrap();
            assert!(
                maintained.read_stats().cache_hit,
                "resume append must maintain warm cache"
            );
        }
    }
}

/// The summary scalars the old full-clone fold computed: the reverse
/// `find_map` timestamp, the assistant usage sums, and the message count.
/// This is the exact extraction `summaryForActiveSession` ran over
/// `messages()` before the scan existed — the reference the scan must
/// reproduce for every window shape.
fn fold_reference_scalars(store: &SessionFile) -> (Option<u64>, u64, u64, f64, usize) {
    let messages = store.messages();
    let last_timestamp = messages
        .iter()
        .rev()
        .find_map(crate::types::message_timestamp_ms);
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut cost = 0.0f64;
    for message in &messages {
        if crate::types::message_role(message) != Some("assistant") {
            continue;
        }
        let Some(usage) = message.get("usage") else {
            continue;
        };
        input_tokens += usage
            .get("input")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        input_tokens += usage
            .get("cacheRead")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        input_tokens += usage
            .get("cacheWrite")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        output_tokens += usage
            .get("output")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        cost += usage
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or_default();
    }
    (
        last_timestamp,
        input_tokens,
        output_tokens,
        cost,
        messages.len(),
    )
}

fn assert_scan_matches_fold(label: &str, store: &SessionFile) {
    let (last_timestamp, input_tokens, output_tokens, cost, count) = fold_reference_scalars(store);
    let scalars = store.scan_message_scalars();
    assert_eq!(
        scalars.last_timestamp_ms, last_timestamp,
        "{label}: newest timestamp"
    );
    assert_eq!(scalars.input_tokens, input_tokens, "{label}: input tokens");
    assert_eq!(
        scalars.output_tokens, output_tokens,
        "{label}: output tokens"
    );
    assert_eq!(scalars.cost, cost, "{label}: cost");
    assert_eq!(scalars.message_count, count, "{label}: message count");
}

fn assistant(usage: &Value, timestamp: u64) -> Value {
    json!({
        "role": "assistant",
        "content": [{"type": "text", "text": "work"}],
        "usage": usage,
        "timestamp": timestamp,
    })
}

fn usage_of(input: u64, output: u64, cache_read: u64, total: f64) -> Value {
    json!({
        "input": input, "output": output, "cacheRead": cache_read, "cacheWrite": 0,
        "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": total}
    })
}

/// One shared walk backs both the materialized fold and the scalar scan, so
/// across every window shape — plain conversations with non-monotonic
/// timestamps, custom rows, compaction boundaries (kept id on a message
/// row, a non-bearing row, and a missing id), stacked compactions, the
/// empty session, and degenerate rows — the scan must reproduce exactly
/// the scalars the old full-clone fold computed.
#[test]
fn scan_message_scalars_match_the_materialized_fold_across_window_shapes() {
    let dir = tempfile::tempdir().unwrap();

    // Plain conversation: non-monotonic timestamps (the reverse find_map
    // takes the LAST positioned timestamp, not the maximum), assistant
    // usage with cache lanes, a custom row carrying a `usage` field (role
    // `custom` never counts), and a toolResult without a timestamp.
    {
        let path = dir.path().join("plain.jsonl");
        let mut store = SessionFile::create("/tmp", None, 0);
        store.set_path(path);
        store.append_message(json!({"role": "user", "content": "hi", "timestamp": 500u64}));
        store.append_message(assistant(&usage_of(10, 2, 3, 0.1), 300));
        store.append_entry(
            "custom_message",
            json!({"customType": "goal_context", "content": "ctx", "usage": usage_of(999, 999, 0, 99.0)}),
        );
        store.append_entry(
            "custom",
            json!({"customType": "thread_goal_state", "data": {"x": 1}}),
        );
        store.append_message(assistant(&usage_of(7, 1, 0, 0.2), 400));
        store.append_message(json!({"role": "toolResult", "toolCallId": "c", "content": []}));
        assert_scan_matches_fold("plain", &store);
    }

    // A later row with a smaller timestamp keeps the fold's reverse
    // find_map semantics: the scan reports the last positioned value.
    {
        let path = dir.path().join("nonmonotonic.jsonl");
        let mut store = SessionFile::create("/tmp", None, 0);
        store.set_path(path);
        store.append_message(assistant(&usage_of(1, 1, 0, 0.0), 900));
        store.append_message(json!({"role": "user", "content": "late", "timestamp": 200u64}));
        assert_scan_matches_fold("non-monotonic tail", &store);
        let scalars = store.scan_message_scalars();
        assert_eq!(scalars.last_timestamp_ms, Some(200));
    }

    // Compaction with the kept id on a message row: the window keeps the
    // retained prefix, and the summary message itself counts (its role
    // is `compactionSummary`, never assistant).
    {
        let path = dir.path().join("kept-on-message.jsonl");
        let mut store = SessionFile::create("/tmp", None, 0);
        store.set_path(path);
        store.append_message(json!({"role": "user", "content": "gone", "timestamp": 1u64}));
        let kept =
            store.append_message(json!({"role": "user", "content": "kept", "timestamp": 50u64}));
        store.append_message(assistant(&usage_of(4, 5, 6, 0.3), 60));
        store.append_entry(
            "compaction",
            json!({"summary": "s", "firstKeptEntryId": kept, "tokensBefore": 1000}),
        );
        store.append_message(assistant(&usage_of(8, 9, 1, 0.4), 70));
        assert_scan_matches_fold("compaction kept on message row", &store);
        let scalars = store.scan_message_scalars();
        assert_eq!(scalars.last_timestamp_ms, Some(70));
        assert_eq!(scalars.input_tokens, 4 + 6 + 8 + 1);
        assert_eq!(scalars.message_count, 4); // summary + kept + two assistants
    }

    // The kept id on a NON-bearing row never flips the keeping walk (the
    // fold skips the row before the id check), so the window holds only
    // the summary plus the post-compaction rows.
    {
        let path = dir.path().join("kept-on-custom.jsonl");
        let mut store = SessionFile::create("/tmp", None, 0);
        store.set_path(path);
        let marker = store.append_entry("custom", json!({"customType": "thread_goal_state"}));
        store.append_message(assistant(&usage_of(5, 5, 0, 0.5), 10));
        store.append_entry(
            "compaction",
            json!({"summary": "s", "firstKeptEntryId": marker, "tokensBefore": 100}),
        );
        store.append_message(assistant(&usage_of(2, 2, 0, 0.25), 20));
        assert_scan_matches_fold("kept id on non-bearing row", &store);
        let scalars = store.scan_message_scalars();
        assert_eq!(scalars.input_tokens, 2);
        assert_eq!(scalars.message_count, 2); // summary + post-compaction assistant
    }

    // A kept id that does not exist keeps nothing before the compaction.
    {
        let path = dir.path().join("kept-missing.jsonl");
        let mut store = SessionFile::create("/tmp", None, 0);
        store.set_path(path);
        store.append_message(assistant(&usage_of(50, 50, 0, 5.0), 1));
        store.append_entry(
            "compaction",
            json!({"summary": "s", "firstKeptEntryId": "does-not-exist", "tokensBefore": 10}),
        );
        store.append_message(json!({"role": "user", "content": "after", "timestamp": 2u64}));
        assert_scan_matches_fold("missing kept id", &store);
        let scalars = store.scan_message_scalars();
        assert_eq!(scalars.message_count, 2);
        assert_eq!(scalars.last_timestamp_ms, Some(2));
    }

    // Stacked compactions: only the LAST one windows the read.
    {
        let path = dir.path().join("stacked.jsonl");
        let mut store = SessionFile::create("/tmp", None, 0);
        store.set_path(path);
        store.append_message(assistant(&usage_of(1, 1, 0, 0.0), 1));
        let kept = store.append_message(json!({"role": "user", "content": "k", "timestamp": 2u64}));
        store.append_entry(
            "compaction",
            json!({"summary": "old", "firstKeptEntryId": kept, "tokensBefore": 5}),
        );
        store.append_message(assistant(&usage_of(3, 3, 0, 0.0), 3));
        store.append_entry(
            "compaction",
            json!({"summary": "new", "firstKeptEntryId": kept, "tokensBefore": 6}),
        );
        store.append_message(json!({"role": "user", "content": "tail", "timestamp": 4u64}));
        assert_scan_matches_fold("stacked compactions", &store);
    }

    // Empty session: no messages at all.
    {
        let path = dir.path().join("empty.jsonl");
        let mut store = SessionFile::create("/tmp", None, 0);
        store.set_path(path);
        assert_scan_matches_fold("empty session", &store);
        assert_eq!(
            store.scan_message_scalars(),
            MessageWindowScalars::default()
        );
    }

    // Degenerate rows: a `message` entry without its persisted message
    // contributes nothing on either path.
    {
        let path = dir.path().join("degenerate.jsonl");
        let mut store = SessionFile::create("/tmp", None, 0);
        store.set_path(path);
        store.append_entry("message", json!({"note": "no message payload"}));
        store.append_message(assistant(&usage_of(6, 7, 0, 0.6), 42));
        assert_scan_matches_fold("degenerate message row", &store);
        let scalars = store.scan_message_scalars();
        assert_eq!(scalars.message_count, 1);
        assert_eq!(scalars.last_timestamp_ms, Some(42));
    }
}

/// The compaction boundary shapes pin the materialized fold itself (the
/// scan's reference): the exact windowed sequence, including the summary
/// message's retained count, the skip of non-bearing rows before the kept
/// id, and the post-compaction tail.
#[test]
fn walk_pins_the_compaction_boundary_sequences() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pin.jsonl");
    let mut store = SessionFile::create("/tmp", None, 0);
    store.set_path(path);
    store.append_message(json!({"role": "user", "content": "u1", "timestamp": 1u64}));
    store.append_entry(
        "custom",
        json!({"customType": "thread_goal_state", "data": {}}),
    );
    let kept = store.append_message(json!({"role": "user", "content": "u2", "timestamp": 2u64}));
    store.append_entry(
        "custom_message",
        json!({"customType": "goal_context", "content": "ctx"}),
    );
    store.append_message(assistant(&usage_of(1, 1, 0, 0.0), 3));
    store.append_entry(
        "compaction",
        json!({"summary": "sum", "firstKeptEntryId": kept, "tokensBefore": 9}),
    );
    store.append_message(json!({"role": "user", "content": "u3", "timestamp": 4u64}));

    let messages = store.messages();
    let roles: Vec<&str> = messages
        .iter()
        .map(|message| {
            message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(
        roles,
        ["compactionSummary", "user", "custom", "assistant", "user"]
    );
    assert_eq!(messages[0]["retainedMessageCount"], json!(3));
    assert_eq!(messages[0]["tokensBefore"], json!(9));
    assert_eq!(messages[1]["content"], "u2");
    assert_eq!(messages[2]["role"], "custom");
    assert_eq!(messages[4]["content"], "u3");
}
