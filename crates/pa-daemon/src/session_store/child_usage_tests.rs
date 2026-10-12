use super::SessionFile;
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
    store.set_path(dir.path().join("session.jsonl"));
    store.rewrite().unwrap();
    (dir, store, id)
}

fn child() -> Usage {
    Usage {
        input: 10,
        ..Usage::default()
    }
}

fn attribution_rows(store: &SessionFile) -> Vec<serde_json::Value> {
    std::fs::read_to_string(&store.path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|row| row["type"] == "child_usage_attributed")
        .collect()
}

/// A retried row id appends nothing: the retry answers `Existing` with the
/// target's current aggregate (a later child may have advanced it), and the
/// transcript keeps exactly the rows that first landed — after a reopen too.
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
    assert!(
        matches!(result, ChildUsageAppendResult::Existing(usage) if usage == expected),
        "the retry reuses the current aggregate: {result:?}"
    );
    assert_eq!(attribution_rows(&store).len(), 2);
    let mut reopened = SessionFile::open(&store.path).unwrap();
    let result = reopened
        .append_child_usage_once("a", &target, child(), None)
        .unwrap();
    assert!(
        matches!(result, ChildUsageAppendResult::Existing(usage) if usage == expected),
        "the reopened store answers from its durable index: {result:?}"
    );
    assert_eq!(attribution_rows(&reopened).len(), 2);
}

// Test-only exact postcondition injection: the real append has written/synced
// its complete JSONL row, but the caller sees an error before indexing it.
// This models complete-write/sync-error recovery; it does not induce OS fsync failure.
std::thread_local! {
    pub(super) static FAIL_AFTER_CHILD_APPEND: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(super) static AFTER_CHILD_OBSERVE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    pub(super) static FAIL_CHILD_CONFIRM_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(super) static PARTIAL_CHILD_APPEND: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
    pub(super) static FAIL_CHILD_TAIL_COMPLETION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[test]
fn completed_append_error_retry_keeps_one_physical_attribution() {
    let (_dir, mut store, target) = fixture();
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("report-a", &target, child(), None)
        .is_err());
    assert_eq!(
        attribution_rows(&store).len(),
        1,
        "the fault is after physical append"
    );
    let result = store
        .append_child_usage_once("report-a", &target, child(), None)
        .unwrap();
    let mut expected = Usage::default();
    pa_core::session_engine::rlm_usage::attribute_child_usage(&mut expected, &child());
    let confirmed = match result {
        ChildUsageAppendResult::Created(usage) | ChildUsageAppendResult::Existing(usage) => usage,
    };
    assert_eq!(confirmed, expected);
    assert_eq!(
        attribution_rows(&store).len(),
        1,
        "same stable report must not append twice"
    );
}

fn windowed_fixture() -> (tempfile::TempDir, SessionFile, String, Usage) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.jsonl");
    let mut full = SessionFile::create("/synthetic", None, 0);
    full.set_path(path.clone());
    let mut first_kept = String::new();
    for i in 0..220 {
        let id = full.append_message(&json!({
            "role": "user", "content": format!("fixture {i}"), "timestamp": i
        }));
        if i == 210 {
            first_kept = id;
        }
    }
    let raw = Usage {
        input: 1000,
        total_tokens: 4096,
        ..Usage::default()
    };
    let target = full.append_message(&json!({
        "role":"assistant", "content":[], "api":"openai-completions",
        "provider":"synthetic", "model":"synthetic", "stopReason":"stop",
        "timestamp":221, "usage":raw
    }));
    full.append_entry(
        "compaction",
        json!({
            "summary":"fixture", "firstKeptEntryId":first_kept, "tokensBefore":10000
        }),
    );
    full.rewrite().unwrap();
    let live = SessionFile::open_windowed(&path).unwrap();
    assert!(live.window.is_some(), "exercise production hydration path");

    (dir, live, target, raw)
}

#[test]
fn hydration_after_an_uncertain_append_does_not_lose_child_usage() {
    use pa_core::session_engine::rlm_usage::attribute_child_usage;
    use pa_types::session::ChildUsageOrigin;

    let (_dir, mut live, target, raw) = windowed_fixture();

    let a = Usage {
        input: 10,
        ..Usage::default()
    };
    let b = Usage {
        input: 20,
        ..Usage::default()
    };
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    let result =
        live.append_child_usage_once("report-a-0", &target, a, Some(ChildUsageOrigin::SpawnTask));
    assert!(result.is_err());
    assert_eq!(
        attribution_rows(&live).len(),
        1,
        "the fault is after physical append"
    );
    live.append_child_usage_once(
        "report-b-0",
        &target,
        b,
        Some(ChildUsageOrigin::AgentMessage),
    )
    .unwrap();

    // dispatch(get_session_tree/export/navigate) opens and installs a full
    // snapshot while the same worker's frozen report A remains retryable.
    live.install_full_history(SessionFile::open(&live.path).unwrap());
    let result = live
        .append_child_usage_once("report-a-0", &target, a, Some(ChildUsageOrigin::SpawnTask))
        .unwrap();
    let confirmed = match result {
        ChildUsageAppendResult::Created(usage) | ChildUsageAppendResult::Existing(usage) => usage,
    };
    let mut expected = raw;
    attribute_child_usage(&mut expected, &a);
    attribute_child_usage(&mut expected, &b);
    assert_eq!(
        confirmed, expected,
        "both distinct child batches must survive hydration"
    );
    assert_eq!(attribution_rows(&live).len(), 2);
}

#[test]
fn recovered_created_receipts_are_acknowledged_once_and_do_not_accumulate() {
    let (_dir, mut store, target) = fixture();
    for cycle in 0..4 {
        let a = format!("recovered-{cycle}");
        let b = format!("later-{cycle}");
        FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
        assert!(store
            .append_child_usage_once(&a, &target, child(), None)
            .is_err());
        assert_eq!(store.child_usage_recovery.created.len(), 1);
        assert!(store.child_usage_recovery.pending.is_some());
        assert!(matches!(
            store
                .append_child_usage_once(&b, &target, child(), None)
                .unwrap(),
            ChildUsageAppendResult::Created(_)
        ));
        assert!(store.child_usage_recovery.pending.is_none());
        assert_eq!(store.child_usage_recovery.created.len(), 1);
        assert!(matches!(
            store
                .append_child_usage_once(&a, &target, child(), None)
                .unwrap(),
            ChildUsageAppendResult::Created(_)
        ));
        assert!(store.child_usage_recovery.created.is_empty());
        assert!(matches!(
            store
                .append_child_usage_once(&a, &target, child(), None)
                .unwrap(),
            ChildUsageAppendResult::Existing(_)
        ));
    }
    assert_eq!(attribution_rows(&store).len(), 8);
}

#[test]
fn generic_append_after_uncertain_attribution_preserves_bytes_and_branch_order() {
    let (_dir, mut store, target) = fixture();
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("a", &target, child(), None)
        .is_err());
    let before = std::fs::read(&store.path).unwrap();
    let c = store
        .persist_entry(
            "custom",
            json!({"customType":"synthetic", "data":{"marker":1}}),
        )
        .unwrap();
    assert_eq!(store.entry(&c).unwrap().parent_id.as_deref(), Some("a"));
    store
        .append_child_usage_once("b", &target, child(), None)
        .unwrap();
    let after = std::fs::read(&store.path).unwrap();
    assert!(after.starts_with(&before));
    let observed: Vec<_> = store.branch().iter().map(|row| row.id.clone()).collect();
    assert_eq!(
        observed,
        vec![target.clone(), "a".to_owned(), c, "b".to_owned()]
    );
    let mut reopened = SessionFile::open(&store.path).unwrap();
    let reopened_branch: Vec<_> = reopened.branch().iter().map(|row| row.id.clone()).collect();
    assert_eq!(reopened_branch, observed);
    assert!(matches!(
        store
            .append_child_usage_once("a", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
    assert!(matches!(
        reopened
            .append_child_usage_once("a", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Existing(_)
    ));
}

#[test]
fn failed_confirmation_keeps_pending_and_blocks_a_new_attribution() {
    let (_dir, mut store, target) = fixture();
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("a", &target, child(), None)
        .is_err());
    let before = std::fs::read(&store.path).unwrap();
    FAIL_CHILD_CONFIRM_SYNC.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("b", &target, child(), None)
        .is_err());
    assert_eq!(std::fs::read(&store.path).unwrap(), before);
    assert!(store.child_usage_recovery.pending.is_some());
    assert_eq!(store.child_usage_recovery.created.len(), 1);
    FAIL_CHILD_CONFIRM_SYNC.with(|fault| fault.set(true));
    assert!(store
        .persist_entry("custom", json!({"customType":"blocked"}))
        .is_err());
    assert_eq!(std::fs::read(&store.path).unwrap(), before);
    assert!(matches!(
        store
            .append_child_usage_once("a", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
    assert!(store.child_usage_recovery.pending.is_none());
    assert!(store.child_usage_recovery.created.is_empty());
}

#[test]
fn bootstrap_complete_error_can_confirm_one_owned_row() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = SessionFile::create("/synthetic", None, 0);
    let target = store.append_message(&json!({"role":"assistant", "content":[],
        "timestamp":1, "usage":Usage::default()}));
    store.set_path(dir.path().join("new.jsonl"));
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("a", &target, child(), None)
        .is_err());
    assert_eq!(attribution_rows(&store).len(), 1);
    assert!(matches!(
        store
            .append_child_usage_once("a", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
    assert_eq!(attribution_rows(&store).len(), 1);
    assert!(store.child_usage_recovery.pending.is_none());
}

#[test]
fn conflicting_owned_bytes_and_incomplete_tail_fail_closed_without_truncation() {
    use std::io::Write;
    let (_dir, mut store, target) = fixture();
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("a", &target, child(), None)
        .is_err());
    {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&store.path)
            .unwrap();
        file.write_all(b"{\"unrelated\":").unwrap();
    }
    let before = std::fs::read(&store.path).unwrap();
    assert!(store
        .append_child_usage_once("b", &target, child(), None)
        .is_err());
    assert_eq!(std::fs::read(&store.path).unwrap(), before);
    assert!(store.child_usage_recovery.pending.is_some());
    let mut conflict = before;
    let owned_start = conflict
        .windows(11)
        .position(|bytes| bytes == b"\"input\":10,")
        .unwrap();
    conflict[owned_start + 8] = b'2';
    std::fs::write(&store.path, &conflict).unwrap();
    assert!(store
        .append_child_usage_once("a", &target, child(), None)
        .is_err());
    assert_eq!(std::fs::read(&store.path).unwrap(), conflict);
}

#[test]
fn hydration_before_confirmation_retains_pending_and_created_receipts() {
    let (_dir, mut live, target, _raw) = windowed_fixture();
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    assert!(live
        .append_child_usage_once("a", &target, child(), None)
        .is_err());
    live.install_full_history(SessionFile::open(&live.path).unwrap());
    assert!(live.window.is_none());
    assert!(live.child_usage_recovery.pending.is_some());
    assert_eq!(live.child_usage_recovery.created.len(), 1);
    FAIL_CHILD_CONFIRM_SYNC.with(|fault| fault.set(true));
    assert!(live
        .append_child_usage_once("a", &target, child(), None)
        .is_err());
    assert!(live.child_usage_recovery.pending.is_some());
    assert!(matches!(
        live.append_child_usage_once("a", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
    assert!(live.child_usage_recovery.pending.is_none());
    assert!(live.child_usage_recovery.created.is_empty());
    assert_eq!(attribution_rows(&live).len(), 1);
}

#[test]
fn changed_session_identity_cannot_confirm_an_owned_attribution() {
    let (_dir, mut store, target) = fixture();
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("a", &target, child(), None)
        .is_err());
    let mut rows: Vec<serde_json::Value> = std::fs::read_to_string(&store.path)
        .unwrap()
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect();
    rows[0]["id"] = json!("foreign-session");
    let changed = rows
        .iter()
        .map(serde_json::Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(&store.path, &changed).unwrap();
    let error = store
        .append_child_usage_once("a", &target, child(), None)
        .unwrap_err();
    assert!(error.to_string().contains("header changed"), "{error}");
    assert_eq!(std::fs::read(&store.path).unwrap(), changed.as_bytes());
    assert!(store.child_usage_recovery.pending.is_some());
}

#[test]
fn nonzero_cost_hydration_confirms_the_complete_wire_decoded_owned_row() {
    use pa_types::ai::UsageCost;
    let (_dir, mut live, target, _raw) = windowed_fixture();
    let spend = Usage {
        input: 10,
        output: 7,
        total_tokens: 17,
        cost: UsageCost {
            input: pa_types::JsNumber(0.007_531_199_999_999_999),
            output: pa_types::JsNumber(0.001_464_499_999_999_999_9),
            total: pa_types::JsNumber(0.008_995_7),
            ..UsageCost::default()
        },
        ..Usage::default()
    };
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    assert!(live
        .append_child_usage_once("cost-a", &target, spend, None)
        .is_err());
    let before = std::fs::read(&live.path).unwrap();
    let full = SessionFile::open(&live.path).unwrap();
    let wire_expected = serde_json::from_value::<pa_types::session::ChildUsageAttributionEntry>(
        full.entry("cost-a").unwrap().fields.clone(),
    )
    .unwrap()
    .aggregate_usage;
    live.install_full_history(full);
    let confirmed = live
        .append_child_usage_once("cost-a", &target, spend, None)
        .unwrap();
    assert!(matches!(confirmed, ChildUsageAppendResult::Created(usage) if usage == wire_expected));
    assert_eq!(std::fs::read(&live.path).unwrap(), before);
    assert!(live.child_usage_recovery.created.is_empty());
}

#[test]
fn recovery_preserves_complete_wire_header_extensions_across_plain_reopen() {
    let (_dir, mut store, target) = fixture();
    store.header.rest.insert(
        "extension".to_owned(),
        json!({
            "retained": true, "cost": 0.007_531_199_999_999_999,
        }),
    );
    store.rewrite().unwrap();
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("a", &target, child(), None)
        .is_err());
    let before = std::fs::read(&store.path).unwrap();
    let reopened = SessionFile::open(&store.path).unwrap();
    assert_eq!(reopened.header.rest.get("type"), Some(&json!("session")));
    let before_header: serde_json::Value =
        serde_json::from_slice(before.split(|byte| *byte == b'\n').next().unwrap()).unwrap();
    let reopened_header = super::session_header_line(&reopened.header);
    assert_eq!(before_header, reopened_header);
    assert!(matches!(
        store
            .append_child_usage_once("a", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
    assert_eq!(std::fs::read(&store.path).unwrap(), before);
}

#[test]
fn conflicting_partial_owned_write_remains_owed_without_truncating_its_healthy_prefix() {
    let (_dir, mut store, target) = fixture();
    let prefix = std::fs::read(&store.path).unwrap();
    PARTIAL_CHILD_APPEND.with(|fault| fault.set(Some(12)));
    FAIL_CHILD_TAIL_COMPLETION.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("partial-a", &target, child(), None)
        .is_err());
    FAIL_CHILD_TAIL_COMPLETION.with(|fault| fault.set(false));
    let mut partial = std::fs::read(&store.path).unwrap();
    // A foreign change is not an owned prefix: retain every byte and fail closed.
    partial[prefix.len() + 9] = b'X';
    std::fs::write(&store.path, &partial).unwrap();
    assert!(partial.starts_with(&prefix));
    assert_eq!(partial.len(), prefix.len() + 12);
    assert!(store.child_usage_recovery.pending.is_some());
    assert!(store.child_usage_recovery.created.is_empty());
    assert!(store
        .append_child_usage_once("b", &target, child(), None)
        .is_err());
    assert!(store
        .persist_entry("custom", json!({"customType":"blocked-after-partial"}))
        .is_err());
    assert!(store
        .append_child_usage_once("partial-a", &target, child(), None)
        .is_err());
    assert_eq!(std::fs::read(&store.path).unwrap(), partial);
}

#[test]
fn recovery_preserves_valid_unterminated_eof_and_rejects_a_changed_separator() {
    let (_dir, mut store, target) = fixture();
    let mut prefix = std::fs::read(&store.path).unwrap();
    assert_eq!(prefix.pop(), Some(b'\n'));
    std::fs::write(&store.path, &prefix).unwrap();
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("a", &target, child(), None)
        .is_err());
    let healthy = std::fs::read(&store.path).unwrap();
    assert!(healthy.starts_with(&prefix));
    assert_eq!(healthy[prefix.len()], b'\n');
    let mut damaged = healthy.clone();
    damaged[prefix.len()] = b'X';
    std::fs::write(&store.path, &damaged).unwrap();
    let error = store
        .append_child_usage_once("a", &target, child(), None)
        .unwrap_err();
    assert!(error.to_string().contains("separator changed"), "{error}");
    assert_eq!(std::fs::read(&store.path).unwrap(), damaged);
    std::fs::write(&store.path, &healthy).unwrap();
    assert!(matches!(
        store
            .append_child_usage_once("a", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
    assert_eq!(std::fs::read(&store.path).unwrap(), healthy);
    assert_eq!(attribution_rows(&store).len(), 1);
}

#[test]
fn exact_owned_partial_tail_completes_without_truncation_and_unblocks_generic_writes() {
    let (_dir, mut store, target) = fixture();
    PARTIAL_CHILD_APPEND.with(|fault| fault.set(Some(12)));
    FAIL_CHILD_TAIL_COMPLETION.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("partial-a", &target, child(), None)
        .is_err());
    FAIL_CHILD_TAIL_COMPLETION.with(|fault| fault.set(false));
    let partial = std::fs::read(&store.path).unwrap();
    let mut expected = Usage::default();
    pa_core::session_engine::rlm_usage::attribute_child_usage(&mut expected, &child());
    let confirmed = store
        .append_child_usage_once("partial-a", &target, child(), None)
        .unwrap();
    assert!(matches!(confirmed, ChildUsageAppendResult::Created(usage) if usage == expected));
    let completed = std::fs::read(&store.path).unwrap();
    assert!(completed.starts_with(&partial));
    assert!(completed.len() > partial.len());
    assert_eq!(attribution_rows(&store).len(), 1);
    assert!(store.child_usage_recovery.pending.is_none());
    assert!(store.child_usage_recovery.created.is_empty());
    let c = store
        .persist_entry(
            "custom",
            json!({"customType":"after-completion", "data":{}}),
        )
        .unwrap();
    assert_eq!(
        store.entry(&c).unwrap().parent_id.as_deref(),
        Some("partial-a")
    );
    assert!(matches!(
        store
            .append_child_usage_once("partial-a", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Existing(_)
    ));
    assert_eq!(attribution_rows(&store).len(), 1);
    assert!(std::fs::read(&store.path).unwrap().starts_with(&completed));
}

#[test]
fn owned_tail_completion_obeys_a_managed_lease_and_refuses_a_released_one() {
    let (dir, mut store, target) = fixture();
    PARTIAL_CHILD_APPEND.with(|fault| fault.set(Some(12)));
    FAIL_CHILD_TAIL_COMPLETION.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("leased-a", &target, child(), None)
        .is_err());
    FAIL_CHILD_TAIL_COMPLETION.with(|fault| fault.set(false));
    let partial = std::fs::read(&store.path).unwrap();
    let stale = std::sync::Arc::new(
        crate::lease::acquire_runtime_session_lease(&store.path, dir.path()).unwrap(),
    );
    stale.release();
    store.lease = Some(stale);
    assert!(store
        .append_child_usage_once("leased-a", &target, child(), None)
        .is_err());
    assert_eq!(std::fs::read(&store.path).unwrap(), partial);
    store.lease = Some(std::sync::Arc::new(
        crate::lease::acquire_runtime_session_lease(&store.path, dir.path()).unwrap(),
    ));
    assert!(matches!(
        store
            .append_child_usage_once("leased-a", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Created(_)
    ));
    assert!(std::fs::read(&store.path).unwrap().starts_with(&partial));
    assert_eq!(attribution_rows(&store).len(), 1);
    store.lease.take().unwrap().release();
}

#[test]
fn admitted_confirmation_finishes_while_release_drains_and_later_writes_are_refused() {
    let (dir, mut store, target) = fixture();
    let lease = std::sync::Arc::new(
        crate::lease::acquire_runtime_session_lease(&store.path, dir.path()).unwrap(),
    );
    store.lease = Some(std::sync::Arc::clone(&lease));
    FAIL_AFTER_CHILD_APPEND.with(|fault| fault.set(true));
    assert!(store
        .append_child_usage_once("release-a", &target, child(), None)
        .is_err());
    assert_eq!(attribution_rows(&store).len(), 1);
    let original_bytes = std::fs::read(&store.path).unwrap();
    let (start_tx, start_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::scope(|scope| {
        let releaser = std::sync::Arc::clone(&lease);
        let release = scope.spawn(move || {
            start_rx
                .recv_timeout(std::time::Duration::from_secs(3))
                .unwrap();
            releaser.release();
        });
        let probe_lease = std::sync::Arc::clone(&lease);
        let path = store.path.clone();
        AFTER_CHILD_OBSERVE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                start_tx.send(()).unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                loop {
                    if probe_lease.with_owned_mutation(&path, || Ok(())).is_err() {
                        break;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "release did not refuse new admission"
                    );
                    std::thread::yield_now();
                }
            }));
        });
        let result = store.append_child_usage_once("release-a", &target, child(), None);
        release.join().unwrap();
        let mut expected = Usage::default();
        pa_core::session_engine::rlm_usage::attribute_child_usage(&mut expected, &child());
        assert!(
            matches!(result.unwrap(), ChildUsageAppendResult::Created(usage) if usage == expected)
        );
    });
    assert!(store.child_usage_recovery.pending.is_none());
    assert!(store.child_usage_recovery.created.is_empty());
    assert_eq!(std::fs::read(&store.path).unwrap(), original_bytes);
    assert!(store
        .persist_entry("custom", json!({"customType":"after-release"}))
        .is_err());
    assert!(store
        .append_child_usage_once("release-b", &target, child(), None)
        .is_err());
    assert_eq!(std::fs::read(&store.path).unwrap(), original_bytes);
    let mut reopened = SessionFile::open(&store.path).unwrap();
    assert!(matches!(
        reopened
            .append_child_usage_once("release-a", &target, child(), None)
            .unwrap(),
        ChildUsageAppendResult::Existing(_)
    ));
    assert_eq!(attribution_rows(&reopened).len(), 1);
}
