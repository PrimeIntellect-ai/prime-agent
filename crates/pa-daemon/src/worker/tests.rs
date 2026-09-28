//! Worker tests (moved with their concerns).
use super::*;

// --- post-abort/post-compact queued-input suspension (TS parity) ---

/// A created worker over the scripted engine (the dispatch surface the
/// suspension tests drive).
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

/// The session events seen by an attached client since `mark`, in wire
/// order (the frames carry one `event` payload each).
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
mod goal_tests;
mod kill_broadcast_tests;
mod queue_tests;
mod summary_tests;
