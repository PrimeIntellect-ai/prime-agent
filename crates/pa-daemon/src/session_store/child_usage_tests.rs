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
