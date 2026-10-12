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

#[test]
fn hydration_after_an_uncertain_append_does_not_lose_child_usage() {
    use pa_core::session_engine::rlm_usage::attribute_child_usage;
    use pa_types::session::ChildUsageOrigin;

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
    let mut live = SessionFile::open_windowed(&path).unwrap();
    assert!(live.window.is_some(), "exercise production hydration path");

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
    live.install_full_history(SessionFile::open(&path).unwrap());
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
