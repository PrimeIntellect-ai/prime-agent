//! Worker tests.
use super::*;

/// A created worker over the scripted engine.
async fn created_dispatch_worker() -> std::sync::Arc<Worker> {
    let dir = std::env::temp_dir().join(format!("pa-worker-susp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: std::path::PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "suspension-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
        decision_child: false,
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "suspension" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

/// The session events seen by an attached client since `mark`, in
/// wire order.
fn session_events_since(
    subscription: &mut tokio::sync::broadcast::Receiver<Arc<OutboundFrame>>,
) -> Vec<Value> {
    let mut events = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type == "session_event" {
            if let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) {
                events.push(outbound["event"].clone());
            }
        }
    }
    events
}

mod abort_boundary_tests;
mod connection_state_tests;
mod goal_tests;
mod kill_broadcast_tests;
mod queue_tests;
mod summary_tests;
mod warning_marker_tests;
mod windowed_attach_tests;
#[tokio::test]
async fn background_refinement_event_is_fenced_to_its_review_session() {
    let dir = std::env::temp_dir().join(format!("pa-refine-event-{}", uuid::Uuid::new_v4()));
    let worker = Worker::new(
        WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "refinement-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": [] })),
            decision_child: false,
        },
        None,
    );
    let mut subscription = worker.events.subscribe();
    let original = SessionFile::create("/tmp", None, 0);
    let original_id = original.session_id().to_string();
    worker.core.lock().unwrap().store = Some(original);
    assert!(emit_refinement_event_for_session(
        &worker.core,
        &worker.events,
        &original_id,
        json!({ "type": "refine_complete" }),
    ));
    assert_eq!(session_events_since(&mut subscription).len(), 1);

    worker.core.lock().unwrap().store = Some(SessionFile::create("/tmp", None, 0));
    assert!(!emit_refinement_event_for_session(
        &worker.core,
        &worker.events,
        &original_id,
        json!({ "type": "refine_complete" }),
    ));
    assert!(!emit_refinement_event_for_session(
        &worker.core,
        &worker.events,
        &original_id,
        json!({ "type": "refine_failed", "error": "old session" }),
    ));
    assert!(session_events_since(&mut subscription).is_empty());
}
