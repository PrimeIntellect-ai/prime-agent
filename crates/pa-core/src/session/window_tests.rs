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
    for (name, body) in [("blank", fixture().replace("\n", "\n\n")), ("plain", r#"{"type":"session","version":3,"id":"s","cwd":"/tmp","timestamp":"now"}\n{"type":"message","id":"m","parentId":null,"message":{"role":"user","content":"hi","timestamp":0}}\n"#.replace("\\n", "\n"))] {
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
    use std::io::Write;
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
fn sequential_appends_keep_reopens_flat() {
    // N leased appends must not make later opens rescan the growing suffix:
    // the certified snapshot absorbs each row, so per-open file reads stay
    // bounded by the first warm open instead of growing with N.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("flat.jsonl");
    std::fs::write(&path, fixture()).unwrap();
    WindowedSessionStore::open(&path).unwrap().unwrap();
    let baseline = WindowedSessionStore::open(&path)
        .unwrap()
        .unwrap()
        .read_stats()
        .jsonl_bytes;
    let mut parent = "leaf".to_owned();
    for i in 0..40 {
        let id = format!("n{i}");
        let row = serde_json::json!({"type":"message","id":id,"parentId":parent,"message":{"role":"user","content":format!("appended {i}"),"timestamp":0}});
        append_cached(
            &path,
            format!("{row}\n").as_bytes(),
            AppendOwnership::SessionLeaseHeld,
        )
        .unwrap();
        let store = WindowedSessionStore::open(&path).unwrap().unwrap();
        let stats = store.read_stats();
        assert!(stats.cache_hit, "append {i} invalidated the cache");
        assert!(
            stats.jsonl_bytes <= baseline,
            "append {i} grew the reopen read: {} > {baseline}",
            stats.jsonl_bytes
        );
        assert_eq!(store.leaf_id(), id, "append {i} lost the leaf");
        parent = id;
    }
}
