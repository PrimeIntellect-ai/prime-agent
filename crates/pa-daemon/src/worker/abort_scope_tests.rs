//! The scoped `abort` (scope `background_cell`): the idle cancel contract.
use super::*;

/// The scoped abort targets only a detached kernel execution: with no
/// kernel running it answers success and changes NOTHING — the queue
/// suspension and abort request of the full funnel stay unset, the parked
/// rows stay — while the unscoped abort runs the full funnel, and an
/// unknown scope is rejected without any abort at all.
#[tokio::test]
async fn the_scoped_abort_targets_only_the_detached_cell() {
    let worker = agent_message_tests::created_worker().await;
    // A parked row the queue-mutating aborts would touch.
    let queued = worker
        .dispatch("steer", &json!({ "message": "parked row" }))
        .await;
    assert!(queued.success, "steer failed: {queued:?}");

    // The scoped abort: success, and nothing else.
    let scoped = worker
        .dispatch("abort", &json!({ "scope": "background_cell" }))
        .await;
    assert!(scoped.success, "the scoped abort failed: {scoped:?}");
    {
        let core = worker.core.lock().unwrap();
        assert!(
            !core.abort_requested,
            "the scoped arm never requests the full abort"
        );
        assert!(!core.turn_cancelled, "the scoped arm never cancels a turn");
        assert!(
            !core.queued_input_suspended,
            "the scoped arm never suspends the queue"
        );
        assert!(
            !core.steering.is_empty(),
            "the parked row survives the scoped abort"
        );
    }

    // An unknown scope is rejected without any abort.
    let unknown = worker
        .dispatch("abort", &json!({ "scope": "nonsense" }))
        .await;
    assert!(
        !unknown.success,
        "an unknown scope must be rejected: {unknown:?}"
    );
    {
        let core = worker.core.lock().unwrap();
        assert!(!core.abort_requested, "a rejected scope never aborts");
        assert!(
            !core.queued_input_suspended,
            "a rejected scope never suspends the queue"
        );
        assert!(!core.steering.is_empty(), "the parked row stays");
    }

    // The unscoped abort runs the full funnel (the contrast arm): the
    // suspension and the abort request are its own semantics.
    let full = worker.dispatch("abort", &json!({})).await;
    assert!(full.success, "the full abort failed: {full:?}");
    {
        let core = worker.core.lock().unwrap();
        assert!(core.abort_requested, "the full abort requests the abort");
        assert!(
            core.queued_input_suspended,
            "the full abort suspends the queue"
        );
    }
}
