use super::{child_usage::AppendFault, SessionFile};
use pa_core::session_engine::rlm_usage::ChildUsageAppendResult;
use pa_types::ai::Usage;
use serde_json::json;

fn fixture() -> (tempfile::TempDir, SessionFile, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = SessionFile::create("/synthetic", None, 0);
    let id = store.append_message(&json!({
        "role": "assistant", "content": [], "api": "openai-completions", "provider": "synthetic",
        "model": "synthetic", "stopReason": "stop", "timestamp": 1,
        "usage": Usage::default()
    }));
    store.set_path(dir.path().join("session.jsonl")).unwrap();
    store.rewrite().unwrap();
    (dir, store, id)
}
fn child() -> Usage {
    Usage {
        input: 10,
        ..Usage::default()
    }
}
fn rows(store: &SessionFile) -> Vec<serde_json::Value> {
    std::fs::read_to_string(&store.path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn complete_write_with_failed_sync_reuses_original_row_and_branch() {
    let (_dir, mut store, target) = fixture();
    store.child_usage_fault = Some(AppendFault::AfterWrite);
    assert!(store
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let message = store.append_message(&json!({"role":"user", "content":"later", "timestamp":2}));
    assert!(store.rewrite().is_err());
    store.branch_to(Some(&target)).unwrap();
    assert!(matches!(
        store
            .append_child_usage_once("stable", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
    assert_eq!(store.leaf_id.as_deref(), Some(target.as_str()));
    assert!(matches!(
        store
            .append_child_usage_once("stable", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Existing(_)
    ));
    let reopened = SessionFile::open(&store.path).unwrap();
    assert_eq!(
        reopened.entry(&message).unwrap().parent_id.as_deref(),
        Some("stable")
    );
    assert_eq!(
        rows(&store)
            .iter()
            .filter(|row| row["id"] == "stable")
            .count(),
        1
    );
    assert_eq!(
        reopened.entry(&target).unwrap().fields["message"]["usage"]["input"],
        json!(10)
    );
}

#[test]
fn partial_append_is_healed_before_later_persistence() {
    let (_dir, mut store, target) = fixture();
    store.child_usage_fault = Some(AppendFault::PartialWrite);
    assert!(store
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let later = store
        .persist_entry("session_info", json!({"name":"later"}))
        .unwrap();
    assert_eq!(
        store.entry(&later).unwrap().parent_id.as_deref(),
        Some("stable")
    );
    assert!(matches!(
        store
            .append_child_usage_once("stable", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
    assert_eq!(rows(&store).len(), 4);
}

#[test]
fn unreadable_reconciliation_preserves_intent_and_fences_writes_and_path_changes() {
    let (dir, mut store, target) = fixture();
    store.child_usage_fault = Some(AppendFault::AfterWrite);
    assert!(store
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let saved = dir.path().join("saved.jsonl");
    std::fs::rename(&store.path, &saved).unwrap();
    std::fs::create_dir(&store.path).unwrap();
    assert!(store
        .persist_entry("session_info", json!({"name":"blocked"}))
        .is_err());
    assert!(store.set_path(dir.path().join("other.jsonl")).is_err());
    let retained = store.append_message(
        &json!({"role":"user", "content":"retained while unreadable", "timestamp":2}),
    );
    assert_eq!(store.child_usage_pending.len(), 2);
    std::fs::remove_dir(&store.path).unwrap();
    std::fs::rename(saved, &store.path).unwrap();
    store
        .append_child_usage_once("stable", &target, child(), None)
        .unwrap();
    assert_eq!(rows(&store).len(), 4);
    assert_eq!(
        SessionFile::open(&store.path)
            .unwrap()
            .entry(&retained)
            .unwrap()
            .parent_id
            .as_deref(),
        Some("stable")
    );
}

#[test]
fn malformed_interior_and_id_conflicts_fail_closed_without_truncation() {
    let (_dir, mut store, target) = fixture();
    store.child_usage_fault = Some(AppendFault::AfterWrite);
    assert!(store
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let original = std::fs::read(&store.path).unwrap();
    let mut corrupted = original.clone();
    corrupted.extend_from_slice(b"{invalid}\n");
    std::fs::write(&store.path, &corrupted).unwrap();
    assert!(store
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    assert_eq!(std::fs::read(&store.path).unwrap(), corrupted);
    std::fs::write(&store.path, original).unwrap();
    store
        .append_child_usage_once("stable", &target, child(), None)
        .unwrap();
    assert!(store
        .append_child_usage_once("stable", &target, Usage::default(), None)
        .is_err());
}

#[test]
fn complete_eof_unknown_record_survives_recovery_and_rewrite() {
    let (_dir, mut store, target) = fixture();
    store.child_usage_fault = Some(AppendFault::AfterWrite);
    assert!(store
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let mut bytes = std::fs::read(&store.path).unwrap();
    bytes.extend_from_slice(br#"{"type":"future_record","id":"future","parentId":"stable","timestamp":"2026-10-10T00:00:00Z","futurePayload":{"kept":true}}"#);
    std::fs::write(&store.path, bytes).unwrap();
    store
        .append_child_usage_once("stable", &target, child(), None)
        .unwrap();
    assert_eq!(
        store.entry("future").unwrap().fields["futurePayload"],
        json!({"kept":true})
    );
    store.rewrite().unwrap();
    assert_eq!(rows(&store).len(), 4);
}

#[test]
fn existing_retry_returns_current_aggregate_after_other_child() {
    let (_dir, mut store, target) = fixture();
    store
        .append_child_usage_once("a", &target, child(), None)
        .unwrap();
    store
        .append_child_usage_once("b", &target, child(), None)
        .unwrap();
    let result = store
        .append_child_usage_once("a", &target, child(), None)
        .unwrap();
    let expected = Usage {
        input: 20,
        total_tokens: 10,
        ..Usage::default()
    };
    assert!(matches!(result, ChildUsageAppendResult::Existing(usage) if usage == expected));
    assert_eq!(rows(&store).len(), 4);
}

#[test]
fn incomplete_utf8_suffix_heals_but_terminated_malformed_eof_is_preserved() {
    let (_dir, mut store, target) = fixture();
    store.child_usage_fault = Some(AppendFault::AfterWrite);
    assert!(store
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let complete = std::fs::read(&store.path).unwrap();
    let mut torn = complete.clone();
    torn.extend_from_slice(b"{\"type\":\"future\",\"text\":\"\xf0\x9f");
    std::fs::write(&store.path, torn).unwrap();
    store
        .append_child_usage_once("stable", &target, child(), None)
        .unwrap();
    assert_eq!(std::fs::read(&store.path).unwrap(), complete);
    store.child_usage_fault = Some(AppendFault::AfterWrite);
    assert!(store
        .append_child_usage_once("another", &target, child(), None)
        .is_err());
    let mut malformed = std::fs::read(&store.path).unwrap();
    malformed.extend_from_slice(b"{\"type\":\"future\"\n");
    std::fs::write(&store.path, &malformed).unwrap();
    assert!(store
        .append_child_usage_once("another", &target, child(), None)
        .is_err());
    assert_eq!(std::fs::read(&store.path).unwrap(), malformed);
}

#[test]
fn recovery_evicts_same_generation_cache_and_preserves_window_derived_state() {
    use pa_core::session::window::WindowedSessionStore;
    let (_dir, mut full, _old_target) = fixture();
    full.append_entry("custom", json!({"customType":pa_core::session::ANTHROPIC_WARNING_SHOWN_CUSTOM_TYPE,"data":{"shown":true}}));
    let mut first_kept = String::new();
    for turn in 0..220 {
        let id = full.append_message(
            &json!({"role":"user","content":format!("turn {turn}"),"timestamp":turn}),
        );
        if turn == 210 {
            first_kept = id;
        }
    }
    full.append_entry(
        "compaction",
        json!({"summary":"synthetic summary","firstKeptEntryId":first_kept,"tokensBefore":2000}),
    );
    let target = full.append_message(&json!({"role":"assistant","api":"openai-completions","provider":"synthetic","model":"synthetic","content":[],"timestamp":222,"stopReason":"stop","usage":Usage::default()}));
    full.rewrite().unwrap();
    let mut store = SessionFile::open_windowed(&full.path).unwrap();
    assert!(store.window.is_some());
    assert!(store.anthropic_warning_shown());
    store.child_usage_fault = Some(AppendFault::AfterWrite);
    assert!(store
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    WindowedSessionStore::open(&store.path).unwrap().unwrap();
    assert!(
        WindowedSessionStore::open(&store.path)
            .unwrap()
            .unwrap()
            .read_stats()
            .cache_hit
    );
    let metadata = std::fs::metadata(&store.path).unwrap();
    store
        .append_child_usage_once("stable", &target, child(), None)
        .unwrap();
    let after = std::fs::metadata(&store.path).unwrap();
    assert_eq!(
        (metadata.len(), metadata.modified().unwrap()),
        (after.len(), after.modified().unwrap())
    );
    assert!(
        !WindowedSessionStore::open(&store.path)
            .unwrap()
            .unwrap()
            .read_stats()
            .cache_hit
    );
    assert!(store.window.is_none());
    assert!(store.anthropic_warning_shown());
    let reopened = SessionFile::open(&store.path).unwrap();
    assert_eq!(
        store.scan_message_scalars(),
        reopened.scan_message_scalars()
    );
    assert_eq!(
        crate::session_stats::session_stats(&store, None),
        crate::session_stats::session_stats(&reopened, None)
    );
}

#[test]
fn uncertain_float_cost_matches_its_disk_roundtrip_without_duplicate_rows() {
    let (_dir, mut store, target) = fixture();
    let mut usage = child();
    usage.cost.total = pa_types::JsNumber(f64::from_bits(0x4077_f98b_7a3a_c6b1));
    store.child_usage_fault = Some(AppendFault::AfterWrite);
    assert!(store
        .append_child_usage_once("stable", &target, usage, None)
        .is_err());
    assert!(matches!(
        store
            .append_child_usage_once("stable", &target, usage, None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
    assert!(matches!(
        store
            .append_child_usage_once("stable", &target, usage, None)
            .unwrap(),
        ChildUsageAppendResult::Existing(_)
    ));
    assert_eq!(rows(&store).len(), 3);
}

#[test]
fn recovery_preserves_blank_lines_accepted_by_normal_readers() {
    let (_dir, mut store, target) = fixture();
    store.child_usage_fault = Some(AppendFault::AfterWrite);
    assert!(store
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let original = std::fs::read(&store.path).unwrap();
    let mut with_blank_lines = b"\n \t\r\n".to_vec();
    with_blank_lines.extend_from_slice(&original);
    with_blank_lines.extend_from_slice(b" \t\n");
    std::fs::write(&store.path, &with_blank_lines).unwrap();
    store
        .append_child_usage_once("stable", &target, child(), None)
        .unwrap();
    assert_eq!(std::fs::read(&store.path).unwrap(), with_blank_lines);
    assert_eq!(SessionFile::open(&store.path).unwrap().entries().len(), 2);
}

#[test]
fn recovery_rejects_interior_headers_and_empty_ids_without_changing_bytes() {
    let (_dir, mut store, target) = fixture();
    store.child_usage_fault = Some(AppendFault::AfterWrite);
    assert!(store
        .append_child_usage_once("stable", &target, child(), None)
        .is_err());
    let original = std::fs::read(&store.path).unwrap();
    let invalid_rows = [
        json!({"type":"session","version":3,"id":"other","cwd":"/synthetic","timestamp":"2026-10-10T00:00:00Z"}),
        json!({"type":"future_record","id":"","parentId":"stable","timestamp":"2026-10-10T00:00:00Z"}),
    ];
    for invalid in invalid_rows {
        let mut bytes = original.clone();
        bytes.extend_from_slice(invalid.to_string().as_bytes());
        bytes.push(b'\n');
        std::fs::write(&store.path, &bytes).unwrap();
        assert!(store
            .append_child_usage_once("stable", &target, child(), None)
            .is_err());
        assert_eq!(std::fs::read(&store.path).unwrap(), bytes);
        assert_eq!(store.child_usage_pending.len(), 1);
    }
}
