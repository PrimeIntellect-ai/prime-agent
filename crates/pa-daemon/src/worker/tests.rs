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

/// A fake supervisor link endpoint (unix): greets the link handshake,
/// answers every request line with success, and records the full command
/// values in arrival order. The callers read the field they need (roster
/// deltas read `command["summary"]`, message probes filter the type).
#[cfg(unix)]
pub(crate) fn fake_supervisor(
    socket: &std::path::Path,
) -> (
    std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let listener = tokio::net::UnixListener::bind(socket).unwrap();
    let recorded = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let sink = std::sync::Arc::clone(&recorded);
    let server = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let sink = std::sync::Arc::clone(&sink);
            tokio::spawn(async move {
                let (reader, mut writer) = stream.into_split();
                writer
                    .write_all(
                        b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                    )
                    .await
                    .unwrap();
                let mut lines = BufReader::new(reader);
                loop {
                    let mut line = String::new();
                    if lines.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(request) = serde_json::from_str::<Value>(line.trim()) else {
                        continue;
                    };
                    let command = request["command"].clone();
                    sink.lock().unwrap().push(command.clone());
                    let response =
                        crate::protocol::response_line(&crate::protocol::response_success(
                            request["id"].as_str(),
                            command["type"].as_str().unwrap_or_default(),
                            None,
                        ));
                    writer
                        .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                        .await
                        .unwrap();
                    writer.write_all(b"\n").await.unwrap();
                }
            });
        }
    });
    (recorded, server)
}

mod abort_boundary_tests;
mod connection_state_tests;
mod goal_tests;
mod kill_broadcast_tests;
mod navigation_pause_tests;
mod queue_tests;
mod sidecar_exit_tests;
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
