use super::*;
use serde_json::json;

fn fixture() -> String {
    let mut rows = vec![
        json!({"type":"session","id":"s","version":3,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
        json!({"type":"thinking_level_change","id":"settings","parentId":null,"thinkingLevel":"high"}),
    ];
    let mut parent = "settings".to_owned();
    for i in 0..220 {
        let id = format!("u{i}");
        rows.push(json!({"type":"message","id":id,"parentId":parent,"message":{"role":"user","content":if i == 0 { "x".repeat(CHUNK_BYTES * 3) } else { format!("hello {i}") },"timestamp":0}}));
        parent = id;
    }
    rows.push(json!({"type":"compaction","id":"compact","parentId":parent,"summary":"summary","firstKeptEntryId":"u210","tokensBefore":999}));
    // A sibling compaction must not replace the one on the active path.
    rows.push(json!({"type":"compaction","id":"sibling","parentId":"u0","summary":"wrong","firstKeptEntryId":"u0","tokensBefore":999}));
    rows.push(json!({"type":"message","id":"leaf","parentId":"compact","message":{"role":"user","content":"latest","timestamp":0}}));
    rows.into_iter().map(|row| row.to_string() + "\n").collect()
}

/// An attribution targeting a discarded-prefix (older-path) assistant:
/// the older-path stats must carry the assistant's cumulative aggregate
/// (TS `applyChildUsageAttributions` over the whole file), not its raw
/// row — otherwise the child spend attributed to a pre-window assistant
/// vanishes from the windowed `get_session_stats` while a full open
/// counts it.
#[test]
fn older_path_stats_fold_child_usage_attributions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("older-attribution.jsonl");
    let mut rows = vec![
        json!({"type":"session","id":"s","version":3,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
        json!({"type":"message","id":"old-a","parentId":null,"message":{"role":"assistant","provider":"p","model":"m",
            "content":[{"type":"text","text":"old"}],"timestamp":0,
            "usage":{"input":100,"output":10,"cacheRead":5,"cacheWrite":0,"totalTokens":115,
            "cost":{"input":0.1,"output":0.01,"cacheRead":0.0,"cacheWrite":0.0,"total":0.11}}}}),
    ];
    let mut parent = "old-a".to_owned();
    for i in 0..220 {
        let id = format!("u{i}");
        rows.push(json!({"type":"message","id":id,"parentId":parent,"message":{"role":"user","content":format!("hello {i}"),"timestamp":0}}));
        parent = id;
    }
    rows.push(json!({"type":"compaction","id":"compact","parentId":parent,"summary":"summary","firstKeptEntryId":"u210","tokensBefore":999}));
    rows.push(json!({"type":"child_usage_attributed","id":"attr","parentId":"compact","targetId":"old-a","origin":"spawn_task",
        "childUsage":{"input":50,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":55,
        "cost":{"input":0.05,"output":0.005,"cacheRead":0,"cacheWrite":0,"total":0.055}},
        "aggregateUsage":{"input":150,"output":15,"cacheRead":5,"cacheWrite":0,"totalTokens":115,
        "cost":{"input":0.15,"output":0.015,"cacheRead":0,"cacheWrite":0,"total":0.165}}}));
    rows.push(json!({"type":"message","id":"leaf","parentId":"attr","message":{"role":"user","content":"latest","timestamp":0}}));
    let body: String = rows
        .into_iter()
        .map(|row| {
            row.to_string()
                + "
"
        })
        .collect();
    std::fs::write(&path, &body).unwrap();
    let store = WindowedSessionStore::open(&path).unwrap().unwrap();
    // The discarded assistant reports the aggregate (150/15/5, $0.165),
    // never the raw row (100/10/5, $0.11) and never raw-plus-child.
    let stats = store.older_path_stats();
    assert_eq!(stats.assistant_messages, 1);
    assert_eq!(stats.user_messages, 210);
    assert_eq!(
        (
            stats.input,
            stats.output,
            stats.cache_read,
            stats.cache_write
        ),
        (150, 15, 5, 0)
    );
    assert!((stats.cost - 0.165).abs() < 1e-9);
}

/// The walk keeps a target's LAST cumulative aggregate for the fold
/// even when more attributions follow it in file order: the walk runs
/// newest-first, so the FIRST aggregate seen per target is the last
/// one written — the cumulative aggregate the TS fold ends with.
#[test]
fn older_path_stats_keep_a_targets_last_aggregate() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("older-attribution-batches.jsonl");
    let mut rows = vec![
        json!({"type":"session","id":"s","version":3,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
        json!({"type":"message","id":"old-a","parentId":null,"message":{"role":"assistant","provider":"p","model":"m",
            "content":[{"type":"text","text":"old"}],"timestamp":0,
            "usage":{"input":100,"output":10,"cacheRead":5,"cacheWrite":0,"totalTokens":115,
            "cost":{"input":0.1,"output":0.01,"cacheRead":0.0,"cacheWrite":0.0,"total":0.11}}}}),
    ];
    let mut parent = "old-a".to_owned();
    for i in 0..220 {
        let id = format!("u{i}");
        rows.push(json!({"type":"message","id":id,"parentId":parent,"message":{"role":"user","content":format!("hello {i}"),"timestamp":0}}));
        parent = id;
    }
    rows.push(json!({"type":"compaction","id":"compact","parentId":parent,"summary":"summary","firstKeptEntryId":"u210","tokensBefore":999}));
    rows.push(json!({"type":"child_usage_attributed","id":"attr1","parentId":"compact","targetId":"old-a","origin":"spawn_task",
        "childUsage":{"input":50,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":55,
        "cost":{"input":0.05,"output":0.005,"cacheRead":0,"cacheWrite":0,"total":0.055}},
        "aggregateUsage":{"input":150,"output":15,"cacheRead":5,"cacheWrite":0,"totalTokens":115,
        "cost":{"input":0.15,"output":0.015,"cacheRead":0,"cacheWrite":0,"total":0.165}}}));
    rows.push(json!({"type":"child_usage_attributed","id":"attr2","parentId":"attr1","targetId":"old-a","origin":"agent_message",
        "childUsage":{"input":30,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":33,
        "cost":{"input":0.03,"output":0.003,"cacheRead":0,"cacheWrite":0,"total":0.033}},
        "aggregateUsage":{"input":180,"output":18,"cacheRead":5,"cacheWrite":0,"totalTokens":115,
        "cost":{"input":0.18,"output":0.018,"cacheRead":0,"cacheWrite":0,"total":0.198}}}));
    rows.push(json!({"type":"message","id":"leaf","parentId":"attr2","message":{"role":"user","content":"latest","timestamp":0}}));
    let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
    std::fs::write(&path, &body).unwrap();
    let store = WindowedSessionStore::open(&path).unwrap().unwrap();
    let stats = store.older_path_stats();
    // The LAST aggregate (the walk keeps the newest-first first-seen)
    // folds the row.
    assert!((stats.cost - 0.198).abs() < 1e-9);
}

/// A MALFORMED aggregate (null, a scalar) must not replace a valid row
/// usage with zeros: the capture gate accepts objects only, so the raw
/// row stays the counted bill — the same skip the session-store fold
/// applies to a non-object aggregate.
#[test]
fn older_path_stats_skip_malformed_aggregates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("older-attribution-malformed.jsonl");
    let mut rows = vec![
        json!({"type":"session","id":"s","version":3,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
        json!({"type":"message","id":"old-a","parentId":null,"message":{"role":"assistant","provider":"p","model":"m",
            "content":[{"type":"text","text":"old"}],"timestamp":0,
            "usage":{"input":100,"output":10,"cacheRead":5,"cacheWrite":0,"totalTokens":115,
            "cost":{"input":0.1,"output":0.01,"cacheRead":0.0,"cacheWrite":0.0,"total":0.125}}}}),
    ];
    let mut parent = "old-a".to_owned();
    for i in 0..220 {
        let id = format!("u{i}");
        rows.push(json!({"type":"message","id":id,"parentId":parent,"message":{"role":"user","content":format!("hello {i}"),"timestamp":0}}));
        parent = id;
    }
    rows.push(json!({"type":"compaction","id":"compact","parentId":parent,"summary":"summary","firstKeptEntryId":"u210","tokensBefore":999}));
    rows.push(json!({"type":"child_usage_attributed","id":"attr","parentId":"compact","targetId":"old-a","origin":"spawn_task",
        "childUsage":{"input":50,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":55,
        "cost":{"input":0.05,"output":0.005,"cacheRead":0,"cacheWrite":0,"total":0.0625}},
        "aggregateUsage":null}));
    rows.push(json!({"type":"message","id":"leaf","parentId":"attr","message":{"role":"user","content":"latest","timestamp":0}}));
    let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
    std::fs::write(&path, &body).unwrap();
    let store = WindowedSessionStore::open(&path).unwrap().unwrap();
    let stats = store.older_path_stats();
    // The malformed aggregate never folds (the raw row's $0.125 stays
    // the counted bill).
    assert!((stats.cost - 0.125).abs() < 1e-9);
}

/// The boundary model the per-model usage fold seeds its timeline with:
/// the newest `model_change` in the discarded prefix — NOT the leaf's
/// model. A post-compaction switch inside the retained window must not
/// re-label the boundary's early summarizer spend (the Bugbot/Macroscope
/// window-seed round: seeding with the leaf's model billed the boundary
/// rows on the wrong side of the switch).
#[test]
fn boundary_model_is_the_prefixs_newest_model_change_not_the_leafs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("boundary-model.jsonl");
    let mut rows = vec![
        json!({"type":"session","id":"s","version":3,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
        json!({"type":"model_change","id":"m-a","parentId":null,"provider":"openai","modelId":"gpt-a"}),
    ];
    let mut parent = "m-a".to_owned();
    for i in 0..220 {
        let id = format!("u{i}");
        rows.push(json!({"type":"message","id":id,"parentId":parent,"message":{"role":"user","content":format!("hello {i}"),"timestamp":0}}));
        parent = id;
    }
    rows.push(json!({"type":"compaction","id":"compact","parentId":parent,"summary":"summary","firstKeptEntryId":"u210","tokensBefore":999}));
    // A switch AFTER the boundary: the retained window runs on gpt-b, the
    // boundary itself still billed on gpt-a.
    rows.push(json!({"type":"model_change","id":"m-b","parentId":"compact","provider":"anthropic","modelId":"gpt-b"}));
    rows.push(json!({"type":"message","id":"leaf","parentId":"m-b","message":{"role":"user","content":"latest","timestamp":0}}));
    let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
    std::fs::write(&path, &body).unwrap();
    let store = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert_eq!(
        store.boundary_model(),
        Some(&("openai".to_string(), "gpt-a".to_string())),
        "the seed is the prefix's newest model_change, not the leaf's"
    );
    // The leaf model stays what it is (the context's own semantics are
    // unchanged): the latest model identity on the active path.
    assert_eq!(
        store.context().model,
        Some(("anthropic".to_string(), "gpt-b".to_string()))
    );
}

#[test]
fn warm_cache_reads_only_header_and_suffix_and_append_stays_warm() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("warm.jsonl");
    let body = fixture();
    std::fs::write(&path, &body).unwrap();
    let cold = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(!cold.read_stats().cache_hit);
    let warm = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(warm.read_stats().cache_hit);
    assert!(warm.read_stats().jsonl_bytes < body.len() as u64 / 2);
    assert_eq!(
        serde_json::to_value(warm.context().messages).unwrap(),
        serde_json::to_value(cold.context().messages).unwrap()
    );
    let row =
        json!({"type":"thinking_level_change","id":"new","parentId":"leaf","thinkingLevel":"low"});
    append_cached(
        &path,
        format!("{row}\n").as_bytes(),
        AppendOwnership::SessionLeaseHeld,
    )
    .unwrap();
    let appended = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(appended.read_stats().cache_hit);
    assert_eq!(appended.context().thinking_level, "low");
    assert_eq!(appended.leaf_id(), "new");
    let expected = build_session_context(
        &super::super::parse_session_entries(&std::fs::read_to_string(&path).unwrap()),
        None,
    );
    assert_eq!(
        serde_json::to_value(appended.context().messages).unwrap(),
        serde_json::to_value(expected.messages).unwrap()
    );
}

#[tokio::test]
async fn historical_refinement_is_read_only_on_trigger_not_in_hot_cache() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("audit.jsonl");
    let marker = "historical-audit-payload-".to_owned() + &"z".repeat(32_000);
    let mut rows: Vec<serde_json::Value> = fixture()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let position = rows.iter().position(|row| row["id"] == "u0").unwrap();
    let parent = rows[position]["parentId"].clone();
    rows.insert(position, json!({"type":"custom","id":"audit","parentId":parent,"customType":"prime-agent.refinement","data":{"summary":marker}}));
    rows[position + 1]["parentId"] = json!("audit");
    let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
    std::fs::write(&path, &body).unwrap();
    let cold = WindowedSessionStore::open(&path).unwrap().unwrap();
    let warm = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(warm.read_stats().cache_hit);
    let sidecar = std::fs::read(path.with_extension("window-cache.json")).unwrap();
    assert!(!String::from_utf8_lossy(&sidecar).contains(&marker));
    let manager =
        super::super::manager::SessionManager::open_windowed(dir.path(), dir.path(), &path)
            .await
            .unwrap();
    let historical = manager.history_snapshot().await.unwrap();
    assert!(historical.iter().any(|entry| matches!(entry, FileEntry::Custom { payload, .. } if payload.custom_type == "prime-agent.refinement" && payload.data.as_ref().is_some_and(|data| data["summary"] == marker))));
    assert_eq!(cold.context().messages, warm.context().messages);
}

#[test]
fn blank_rows_and_uncompacted_context_are_warm() {
    let dir = tempfile::tempdir().unwrap();
    for (name, body) in [("blank", fixture().replace('\n', "\n\n")), ("plain", r#"{"type":"session","version":3,"id":"s","cwd":"/tmp","timestamp":"now"}\n{"type":"message","id":"m","parentId":null,"message":{"role":"user","content":"hi","timestamp":0}}\n"#.replace("\\n", "\n"))] {
        let path = dir.path().join(name);
        std::fs::write(&path, &body).unwrap();
        WindowedSessionStore::open(&path).unwrap().unwrap();
        let warm = WindowedSessionStore::open(&path).unwrap().unwrap();
        assert!(warm.read_stats().cache_hit);
        let expected = build_session_context(&super::super::parse_session_entries(&body), None);
        assert_eq!(serde_json::to_value(warm.context().messages).unwrap(), serde_json::to_value(expected.messages).unwrap());
    }
}

#[test]
fn valid_goal_and_physical_metadata_survive_invalid_newer_branch_goal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("goal.jsonl");
    let mut rows: Vec<serde_json::Value> = fixture()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    rows[1]["parentId"] = json!("valid-goal");
    rows.insert(1, json!({"type":"custom","id":"valid-goal","parentId":null,"customType":"thread_goal_state","data":{"active":true,"status":"active","objective":"work","goalId":"goal","tokensUsed":9,"timeUsedSeconds":0,"continuationsUsed":0}}));
    rows.push(json!({"type":"session_info","id":"offpath","parentId":null,"name":"physical"}));
    rows.push(json!({"type":"custom","id":"invalid-goal","parentId":"leaf","customType":"thread_goal_state","data":{"bad":true}}));
    let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
    std::fs::write(&path, body).unwrap();
    for _ in 0..2 {
        let store = WindowedSessionStore::open(&path).unwrap().unwrap();
        assert_eq!(store.goal_state().unwrap().goal_id.as_deref(), Some("goal"));
        assert_eq!(store.compaction_count(), 2);
        assert_eq!(store.context().thinking_level, "high");
    }
}

/// The Anthropic subscription warning's once-per-session-lifecycle marker
/// hydrates from the discarded prefix exactly like the goal row (operator
/// directive 2026-09-29): the walk parses on-path custom rows beyond the
/// retained window, so a resume of a long session reads the marker without
/// paying a full-file parse — and the cached sidecar serves it warm. The
/// matcher is honest about the payload: a row with `data.shown` false is
/// not a marker.
#[test]
fn anthropic_warning_marker_hydrates_from_before_the_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("warning.jsonl");
    let mut rows: Vec<serde_json::Value> = fixture()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    // Put the marker deep in the discarded prefix, on the active chain
    // (the same rewiring the goal fixture uses: u0 parents to the marker,
    // the marker parents to the settings row).
    rows[2]["parentId"] = json!("marked");
    rows.insert(
        2,
        json!({"type":"custom","id":"marked","parentId":"settings","customType":crate::session::ANTHROPIC_WARNING_SHOWN_CUSTOM_TYPE,"data":{"shown":true}}),
    );
    let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
    std::fs::write(&path, body).unwrap();
    // Twice: the cold walk, then the warm sidecar reload — both must
    // serve the hydrated gate.
    for _ in 0..2 {
        let store = WindowedSessionStore::open(&path).unwrap().unwrap();
        assert!(
            store.anthropic_warning_shown(),
            "the marker beyond the retained window hydrates the gate"
        );
        assert_eq!(store.compaction_count(), 2);
    }
    // The plain fixture never hydrates the gate.
    let plain = dir.path().join("plain.jsonl");
    std::fs::write(&plain, fixture()).unwrap();
    let store = WindowedSessionStore::open(&plain).unwrap().unwrap();
    assert!(!store.anthropic_warning_shown());
}

/// A `custom` row with the marker's type but `data.shown` false is not the
/// marker: the gate's payload check keeps a future un-show payload (or a
/// foreign row borrowing the type) from suppressing the warning.
#[test]
fn an_unshown_marker_row_never_hydrates_the_gate() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unshown.jsonl");
    let mut rows: Vec<serde_json::Value> = fixture()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    rows[2]["parentId"] = json!("unshown");
    rows.insert(
        2,
        json!({"type":"custom","id":"unshown","parentId":"settings","customType":crate::session::ANTHROPIC_WARNING_SHOWN_CUSTOM_TYPE,"data":{"shown":false}}),
    );
    let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
    std::fs::write(&path, body).unwrap();
    let store = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(!store.anthropic_warning_shown());
}

#[test]
fn unleased_append_invalidates_without_certification() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unleased.jsonl");
    std::fs::write(&path, fixture()).unwrap();
    WindowedSessionStore::open(&path).unwrap().unwrap();
    let row = json!({"type":"session_info","id":"info","parentId":"leaf","name":"updated"});
    append_cached(
        &path,
        format!("{row}\n").as_bytes(),
        AppendOwnership::Unleased,
    )
    .unwrap();
    let reopened = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(!reopened.read_stats().cache_hit);
    assert_eq!(reopened.leaf_id(), "info");
}

#[test]
fn cached_accounting_preserves_subtotal_bits() {
    let stats = WindowStats {
        cost: f64::from_bits(0x4077_f98b_7a3a_c6b1),
        ..WindowStats::default()
    };
    let bytes = serde_json::to_vec(&stats).unwrap();
    let restored: WindowStats = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(restored.cost.to_bits(), stats.cost.to_bits());
}

#[test]
fn explicit_null_tier_append_stays_warm() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tier.jsonl");
    std::fs::write(&path, fixture()).unwrap();
    WindowedSessionStore::open(&path).unwrap().unwrap();
    let first =
        json!({"type":"service_tier_change","id":"tier","parentId":"leaf","serviceTier":"default"});
    append_cached(
        &path,
        format!("{first}\n").as_bytes(),
        AppendOwnership::SessionLeaseHeld,
    )
    .unwrap();
    let clear =
        json!({"type":"service_tier_change","id":"clear","parentId":"tier","serviceTier":null});
    append_cached(
        &path,
        format!("{clear}\n").as_bytes(),
        AppendOwnership::SessionLeaseHeld,
    )
    .unwrap();
    let window = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(window.read_stats().cache_hit);
    assert!(window.has_service_tier());
    assert_eq!(window.context().service_tier, None);
}

#[test]
fn stale_corrupt_and_replaced_cache_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stale.jsonl");
    std::fs::write(&path, fixture()).unwrap();
    WindowedSessionStore::open(&path).unwrap().unwrap();
    let changed = fixture().replace("high", "low ");
    std::fs::write(&path, changed).unwrap();
    let stale = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(!stale.read_stats().cache_hit);
    assert_eq!(stale.context().thinking_level, "low ");
    std::fs::write(path.with_extension("window-cache.json"), "broken").unwrap();
    // The live snapshot is still valid for the unchanged file; drop it so
    // this open really exercises the corrupt on-disk sidecar.
    super::super::window_cache::evict_live_snapshot(&path);
    assert!(
        !WindowedSessionStore::open(&path)
            .unwrap()
            .unwrap()
            .read_stats()
            .cache_hit
    );
    let replacement = dir.path().join("replacement");
    std::fs::write(&replacement, fixture()).unwrap();
    std::fs::rename(replacement, &path).unwrap();
    assert!(
        !WindowedSessionStore::open(&path)
            .unwrap()
            .unwrap()
            .read_stats()
            .cache_hit
    );
}

#[tokio::test]
async fn context_and_hydration_match_full_reader() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    let body = fixture();
    std::fs::write(&path, &body).unwrap();
    let full = super::super::parse_session_entries(&body);
    let expected = build_session_context(&full, Some("leaf"));
    let mut window = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(window.entries().len() < full.len());
    let actual = window.context();
    assert_eq!(
        serde_json::to_vec(&actual.messages).unwrap(),
        serde_json::to_vec(&expected.messages).unwrap()
    );
    assert_eq!(
        (actual.thinking_level, actual.service_tier, actual.model),
        (
            expected.thinking_level,
            expected.service_tier,
            expected.model
        )
    );
    window.ensure_full_history().await.unwrap();
    assert_eq!(
        serde_json::to_vec(window.entries()).unwrap(),
        serde_json::to_vec(&full).unwrap()
    );
    assert_eq!(std::fs::read_to_string(path).unwrap(), body);
}

#[tokio::test]
async fn metadata_and_concurrent_disk_append_survive_hydration() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("metadata.jsonl");
    let body = fixture();
    std::fs::write(&path, &body).unwrap();
    let mut store = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert_eq!(store.message_count(), 221);
    assert_eq!(store.older_path_stats().user_messages, 210);
    assert_eq!(
        store.first_user_message().unwrap()["content"],
        "x".repeat(CHUNK_BYTES * 3)
    );
    assert!(store.metadata_entries().is_empty());
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    writeln!(file, "{}", json!({"type":"message","id":"appended","parentId":"leaf","message":{"role":"user","content":"new","timestamp":0}})).unwrap();
    store.ensure_full_history().await.unwrap();
    assert_eq!(store.leaf_id(), "leaf");
    assert_eq!(store.entries().last().unwrap().id(), Some("appended"));
    let expected = super::super::parse_session_entries(&std::fs::read_to_string(&path).unwrap());
    assert_eq!(
        serde_json::to_vec(store.entries()).unwrap(),
        serde_json::to_vec(&expected).unwrap()
    );
}

#[tokio::test]
async fn manager_opens_window_and_appends_without_hydration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("manager.jsonl");
    let body = fixture();
    std::fs::write(&path, &body).unwrap();
    let mut manager =
        super::super::manager::SessionManager::open_windowed(dir.path(), dir.path(), &path)
            .await
            .unwrap();
    assert!(!manager.is_full_history());
    let expected = build_session_context(&super::super::parse_session_entries(&body), Some("leaf"));
    assert_eq!(
        serde_json::to_vec(&manager.active_context().messages).unwrap(),
        serde_json::to_vec(&expected.messages).unwrap()
    );
    manager.append_session_info("resumed").unwrap();
    assert!(!manager.is_full_history());
    let after = std::fs::read_to_string(&path).unwrap();
    assert!(after.starts_with(&body));
    let reopened = super::super::manager::SessionManager::open(dir.path(), dir.path(), &path);
    assert_eq!(
        serde_json::to_vec(&manager.active_context().messages).unwrap(),
        serde_json::to_vec(&reopened.active_context().messages).unwrap()
    );
}

#[tokio::test]
async fn failed_window_append_returns_error_without_id_or_listener() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("manager.jsonl");
    std::fs::write(&path, fixture()).unwrap();
    let mut manager =
        super::super::manager::SessionManager::open_windowed(dir.path(), dir.path(), &path)
            .await
            .unwrap();
    let before = manager.get_leaf_id().map(str::to_owned);
    let notified = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = notified.clone();
    manager.on_persist(Box::new(move |_| {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));
    std::fs::remove_file(&path).unwrap();
    assert!(manager.append_session_info("must fail").is_err());
    assert_eq!(manager.get_leaf_id(), before.as_deref());
    assert_eq!(notified.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(!path.exists());
}

#[test]
fn sparse_settings_and_sibling_changes_match_full_context() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.jsonl");
    let mut rows: Vec<serde_json::Value> = fixture()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    rows[1]["parentId"] = json!("tier");
    rows.insert(1, json!({"type":"model_change","id":"model","parentId":null,"provider":"openai","modelId":"gpt-test"}));
    rows.insert(2, json!({"type":"service_tier_change","id":"tier","parentId":"model","serviceTier":"default"}));
    rows.insert(rows.len() - 1, json!({"type":"thinking_level_change","id":"other-settings","parentId":"sibling","thinkingLevel":"low"}));
    let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
    std::fs::write(&path, &body).unwrap();
    let expected = build_session_context(&super::super::parse_session_entries(&body), Some("leaf"));
    let actual = WindowedSessionStore::open(&path)
        .unwrap()
        .unwrap()
        .context();
    assert_eq!(
        serde_json::to_vec(&actual.messages).unwrap(),
        serde_json::to_vec(&expected.messages).unwrap()
    );
    assert_eq!(
        (actual.thinking_level, actual.service_tier, actual.model),
        (
            expected.thinking_level,
            expected.service_tier,
            expected.model
        )
    );
}

#[test]
fn unterminated_session_uses_repair_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("torn.jsonl");
    std::fs::write(&path, fixture().trim_end()).unwrap();
    assert!(WindowedSessionStore::open(&path).unwrap().is_none());
}

#[test]
fn reverse_reader_preserves_long_lines_and_unterminated_tail() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lines");
    let long = "é".repeat(CHUNK_BYTES * 2);
    let body = format!("first\n{long}\nlast");
    std::fs::write(&path, &body).unwrap();
    let mut reader = ReverseLines {
        file: std::fs::File::open(path).unwrap(),
        position: body.len() as u64,
        pending: Vec::new(),
        line_start: 0,
        reads: WindowReadStats::default(),
    };
    let mut lines = Vec::new();
    while let Some(line) = reader.next().unwrap() {
        lines.push(String::from_utf8(line).unwrap());
    }
    assert_eq!(lines, vec!["last".to_owned(), long, "first".to_owned()]);
}

#[test]
fn windowed_context_is_byte_identical_to_the_cold_parse() {
    // The resumed worker's first model request is built from this context:
    // the windowed open (cold scan and sidecar-warm alike) must reproduce
    // the full parse byte for byte.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("byte-parity.jsonl");
    let mut rows: Vec<serde_json::Value> = fixture()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    rows.push(serde_json::json!({"type":"model_change","id":"model","parentId":"leaf","provider":"openai","modelId":"gpt-5"}));
    rows.push(serde_json::json!({"type":"message","id":"leaf2","parentId":"model","message":{"role":"user","content":"after the switch","timestamp":0}}));
    let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
    std::fs::write(&path, &body).unwrap();
    let reference = build_session_context(&super::super::parse_session_entries(&body), None);
    let reference_bytes = serde_json::to_vec(&(
        &reference.messages,
        &reference.thinking_level,
        &reference.service_tier,
        &reference.model,
    ))
    .unwrap();
    for phase in ["cold", "warm"] {
        let store = WindowedSessionStore::open(&path).unwrap().unwrap();
        assert_eq!(store.read_stats().cache_hit, phase == "warm");
        let context = store.context();
        let bytes = serde_json::to_vec(&(
            &context.messages,
            &context.thinking_level,
            &context.service_tier,
            &context.model,
        ))
        .unwrap();
        assert_eq!(
            bytes, reference_bytes,
            "{phase} open diverged from the full parse"
        );
    }
}

#[test]
fn sequential_appends_keep_reopens_amortized() {
    // N leased appends stay O(append): every reopen is still a cache hit
    // whose file reads grow only by the appended suffix bytes — never a
    // rescan of the (much larger) pre-window history.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("flat.jsonl");
    std::fs::write(&path, fixture()).unwrap();
    WindowedSessionStore::open(&path).unwrap().unwrap();
    let baseline = WindowedSessionStore::open(&path)
        .unwrap()
        .unwrap()
        .read_stats()
        .jsonl_bytes;
    let mut appended_bytes = 0u64;
    let mut parent = "leaf".to_owned();
    for i in 0..40 {
        let id = format!("n{i}");
        let row = serde_json::json!({"type":"message","id":id,"parentId":parent,"message":{"role":"user","content":format!("appended {i}"),"timestamp":0}});
        let line = format!("{row}\n");
        appended_bytes += line.len() as u64;
        append_cached(&path, line.as_bytes(), AppendOwnership::SessionLeaseHeld).unwrap();
        let store = WindowedSessionStore::open(&path).unwrap().unwrap();
        let stats = store.read_stats();
        assert!(stats.cache_hit, "append {i} invalidated the cache");
        assert!(
            stats.jsonl_bytes <= baseline + appended_bytes,
            "append {i} rescanned beyond the appended suffix: {} > {baseline} + {appended_bytes}",
            stats.jsonl_bytes
        );
        assert_eq!(store.leaf_id(), id, "append {i} lost the leaf");
        parent = id;
    }
}

/// One-copy adoption oracle: after `adopt_window`, the manager's
/// `active_context` must be byte-identical to an un-adopted window's
/// `context()` over the same file (cold walk and sidecar-warm alike) —
/// the detach changes WHO holds the retained rows, never WHAT the
/// served context is.
#[test]
fn adopted_context_matches_unadopted_window_byte_for_byte() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("adopt-parity.jsonl");
    let mut rows: Vec<serde_json::Value> = fixture()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    rows.push(json!({"type":"model_change","id":"model","parentId":"leaf","provider":"openai","modelId":"gpt-5"}));
    rows.push(json!({"type":"message","id":"leaf2","parentId":"model","message":{"role":"user","content":"after the switch","timestamp":0}}));
    let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
    std::fs::write(&path, &body).unwrap();
    for phase in ["cold", "warm"] {
        // The reference opens FIRST in the cold pass (the adopted open in
        // the same pass warms the sidecar, which is fine — the parity is
        // about WHO holds the rows, not which side hit the cache).
        let reference = WindowedSessionStore::open(&path).unwrap().unwrap();
        assert_eq!(
            reference.read_stats().cache_hit,
            phase == "warm",
            "{phase} reference open cache state"
        );
        assert!(!reference.entries().is_empty());
        assert!(!reference.raw_entries().is_empty());
        let adopted = WindowedSessionStore::open(&path).unwrap().unwrap();
        let mut manager = super::super::manager::SessionManager::in_memory(dir.path());
        manager.adopt_window(adopted);
        let expected = reference.context();
        let actual = manager.active_context();
        let expected_bytes = serde_json::to_vec(&(
            &expected.messages,
            &expected.thinking_level,
            &expected.service_tier,
            &expected.model,
        ))
        .unwrap();
        let actual_bytes = serde_json::to_vec(&(
            &actual.messages,
            &actual.thinking_level,
            &actual.service_tier,
            &actual.model,
        ))
        .unwrap();
        assert_eq!(
            actual_bytes, expected_bytes,
            "{phase} adopted context diverged from the un-adopted window"
        );
    }
}

/// The detached window keeps its snapshot/settings/metadata surfaces,
/// and its transcript context moves to the owning manager — `context()`
/// on a detached window is a programming error, caught loudly.
#[test]
#[should_panic(expected = "detached window's transcript context")]
fn detached_window_serves_lookups_but_not_its_own_context() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("detached.jsonl");
    std::fs::write(&path, fixture()).unwrap();
    let mut window = WindowedSessionStore::open(&path).unwrap().unwrap();
    let (bodies, raw) = window.take_retained();
    assert!(!bodies.is_empty());
    assert!(!raw.is_empty());
    assert!(window.retained_detached());
    assert!(window.entries().is_empty());
    assert!(window.raw_entries().is_empty());
    assert_eq!(window.message_count(), 221);
    assert!(window.has_non_bootstrap_entries());
    assert!(window.has_thinking_level());
    assert_eq!(window.settings().thinking_level, "high");
    // The fixture's on-path compaction AND its off-path sibling both
    // count (compaction_count is a file-level tally of the walk).
    assert_eq!(window.compaction_count(), 2);
    assert_eq!(window.leaf_id(), "leaf");
    // The compile-checked no-op: the detached context is the manager's.
    let _ = window.context();
}

/// Post-adoption mutations keep the served context equal to a full
/// reader's: live appends (including a child-usage attribution whose
/// target is a RETAINED assistant — the manager's own fold is the
/// one-copy authority once the window's bodies are detached) must match
/// what a cold reopen of the same file serves.
#[tokio::test]
async fn adopted_manager_live_appends_match_full_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("adopt-append.jsonl");
    let mut rows: Vec<serde_json::Value> = vec![
        json!({"type":"session","id":"s","version":3,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
        json!({"type":"thinking_level_change","id":"settings","parentId":null,"thinkingLevel":"high"}),
    ];
    let mut parent = "settings".to_owned();
    for i in 0..220 {
        let id = format!("u{i}");
        rows.push(json!({"type":"message","id":id,"parentId":parent,"message":{"role":"user","content":format!("hello {i}"),"timestamp":0}}));
        parent = id;
    }
    rows.push(json!({"type":"compaction","id":"compact","parentId":parent,"summary":"summary","firstKeptEntryId":"u210","tokensBefore":999}));
    rows.push(json!({"type":"message","id":"a1","parentId":"compact","message":{"role":"assistant","provider":"p","model":"m",
        "api":"openai-completions","stopReason":"stop",
        "content":[{"type":"text","text":"in-window assistant"}],"timestamp":0,
        "usage":{"input":10,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":12,
        "cost":{"input":0.01,"output":0.002,"cacheRead":0.0,"cacheWrite":0.0,"total":0.012}}}}));
    rows.push(json!({"type":"message","id":"leaf","parentId":"a1","message":{"role":"user","content":"latest","timestamp":0}}));
    let body: String = rows.into_iter().map(|row| row.to_string() + "\n").collect();
    std::fs::write(&path, &body).unwrap();

    let mut manager =
        super::super::manager::SessionManager::open_windowed(dir.path(), dir.path(), &path)
            .await
            .unwrap();
    manager.append_model_change("live", "m2").unwrap();
    manager
        .append_message(pa_types::session::AgentMessage::User(
            pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text("live prompt".to_owned()),
                timestamp: 5,
                rest: pa_types::JsonMap::default(),
            },
        ))
        .unwrap();
    // A live attribution whose target sits INSIDE the retained window:
    // the manager folds its own copy (the detached window has none).
    manager
        .append_child_usage_attribution(
            "a1",
            pa_types::ai::Usage {
                input: 5,
                output: 1,
                cache_read: 0,
                cache_write: 0,
                total_tokens: 6,
                cost: pa_types::ai::UsageCost::default(),
            },
            pa_types::ai::Usage {
                input: 15,
                output: 3,
                cache_read: 0,
                cache_write: 0,
                total_tokens: 18,
                cost: pa_types::ai::UsageCost::default(),
            },
            None,
        )
        .unwrap();
    let live = manager.active_context();
    let reopened = super::super::manager::SessionManager::open(dir.path(), dir.path(), &path);
    let reopened_ctx = reopened.active_context();
    let live_bytes = serde_json::to_vec(&(
        &live.messages,
        &live.thinking_level,
        &live.service_tier,
        &live.model,
    ))
    .unwrap();
    let reopened_bytes = serde_json::to_vec(&(
        &reopened_ctx.messages,
        &reopened_ctx.thinking_level,
        &reopened_ctx.service_tier,
        &reopened_ctx.model,
    ))
    .unwrap();
    assert_eq!(
        live_bytes, reopened_bytes,
        "post-adopt live appends diverged from the full reader's reopen"
    );
    // The folded aggregate is visible in both (assignment, not merge).
    assert!(
        live.messages.iter().any(|m| matches!(m,
            pa_types::session::AgentMessage::Assistant(a)
                if a.usage.input == 15 && a.usage.output == 3)),
        "the live attribution fold did not reach the served context"
    );
}

/// A no-compaction fixture: the walk retains every row, so the window
/// covers the whole file (`retained_whole_file`).
fn full_history_fixture() -> String {
    let mut rows = vec![
        json!({"type":"session","id":"s","version":3,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
    ];
    let mut parent: Option<String> = None;
    for i in 0..5 {
        let id = format!("u{i}");
        rows.push(json!({"type":"message","id":id.clone(),"parentId":parent,"message":{"role":"user","content":format!("hello {i}"),"timestamp":0}}));
        parent = Some(id);
    }
    // One refinement audit row: the in-session history class the refine
    // transcript's audit scan reads through this snapshot.
    rows.push(json!({"type":"custom","id":"audit","parentId":parent,"customType":"prime-agent.refinement","data":{"id":"refine_0","summary":"seed","rationale":"r","expectedOutcome":"o","appliedEdits":[]}}));
    rows.into_iter().map(|row| row.to_string() + "\n").collect()
}

/// The historical snapshot over a full-history window serves the retained
/// rows without the file: with the sole-writer lease held, deleting the
/// session file cannot fail the snapshot (the fast path never touches the
/// path), and the served entries are the historical read's exact result.
#[tokio::test]
async fn full_history_snapshot_serves_retained_rows_without_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("full.jsonl");
    let body = full_history_fixture();
    std::fs::write(&path, &body).unwrap();
    let store = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(
        store.retained_whole_file(),
        "no compaction boundary: the walk covered the file"
    );
    drop(store);
    // The flag survives the sidecar round-trip (the cache-warm open).
    let warm = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(
        warm.read_stats().cache_hit,
        "the second open served the sidecar"
    );
    assert!(
        warm.retained_whole_file(),
        "the covered flag must round-trip through the snapshot cache"
    );
    drop(warm);
    let expected = super::super::parse_session_entries(&body);
    let mut manager =
        super::super::manager::SessionManager::open_windowed(dir.path(), dir.path(), &path)
            .await
            .unwrap();
    manager.set_append_ownership(AppendOwnership::SessionLeaseHeld);
    // The served-path assertion: a hidden fallback to the historical
    // read would fail on the missing file.
    std::fs::remove_file(&path).unwrap();
    let snapshot = manager.history_snapshot().await.unwrap();
    assert_eq!(
        serde_json::to_value(&snapshot).unwrap(),
        serde_json::to_value(&expected).unwrap(),
        "the memory-served snapshot must be the historical read's exact result"
    );
}

/// Without the sole-writer lease another writer may have appended out of
/// band, so the gate stays closed and the historical read still serves
/// whatever the file gained.
#[tokio::test]
async fn full_history_snapshot_without_lease_keeps_the_historical_read() {
    use std::io::Write as _;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unleased-full.jsonl");
    std::fs::write(&path, full_history_fixture()).unwrap();
    let manager =
        super::super::manager::SessionManager::open_windowed(dir.path(), dir.path(), &path)
            .await
            .unwrap();
    // An out-of-band append (the unleased world's other writer).
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    file.write_all(b"{\"type\":\"message\",\"id\":\"oob\",\"parentId\":\"audit\",\"message\":{\"role\":\"user\",\"content\":\"external\",\"timestamp\":0}}\n").unwrap();
    drop(file);
    let snapshot = manager.history_snapshot().await.unwrap();
    assert!(
        snapshot.iter().any(|entry| entry.id() == Some("oob")),
        "the unleased manager must keep re-reading the file"
    );
}

/// A compaction boundary window discards a prefix by design: the fast
/// path must never claim coverage, and the historical read must keep
/// serving the pre-window rows even under the lease.
#[tokio::test]
async fn boundary_window_snapshot_keeps_the_historical_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("boundary.jsonl");
    std::fs::write(&path, fixture()).unwrap();
    let store = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(
        !store.retained_whole_file(),
        "the boundary discarded a prefix"
    );
    drop(store);
    let warm = WindowedSessionStore::open(&path).unwrap().unwrap();
    assert!(
        warm.read_stats().cache_hit,
        "the second open served the sidecar"
    );
    assert!(
        !warm.retained_whole_file(),
        "the partial flag must round-trip through the snapshot cache"
    );
    drop(warm);
    let mut manager =
        super::super::manager::SessionManager::open_windowed(dir.path(), dir.path(), &path)
            .await
            .unwrap();
    manager.set_append_ownership(AppendOwnership::SessionLeaseHeld);
    let snapshot = manager.history_snapshot().await.unwrap();
    assert!(
        snapshot.iter().any(|entry| entry.id() == Some("u0")),
        "the pre-window row must stay served through the historical read"
    );
}
