//! `/elicit` on the prompt path: the answer is applied ahead of admission so it
//! never steers (a steer interrupts the very tool call waiting for it).
use super::*;
use crate::agent_engine::mcp_elicitation::{AnswerField, ElicitationDecision, FieldKind};
use crate::engine::SessionEngine as _;
use serde_json::json;

fn real_worker(dir: &std::path::Path) -> Arc<Worker> {
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "target-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        // No script: the worker builds the real agent engine (the concrete
        // engine the elicitation answer is applied through).
        script: None,
    };
    Arc::new(Worker::new(config, None))
}

/// A `/elicit accept` prompt answers the pending request and leaves both lanes
/// empty: it is not a turn, and it must not steer a running one.
///
/// The tooth: remove the `handle_prompt` interception and this test fails — the
/// prompt lands in the steering lane and the pending request stays unanswered
/// (`try_recv` finds no decision). That steer is what killed the tool call in
/// the ConPTY run this regression came from.
#[tokio::test]
async fn an_elicit_prompt_answers_without_entering_a_lane() {
    let dir = std::env::temp_dir().join(format!("pa-worker-elicit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let worker = real_worker(&dir);
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": dir.display().to_string(), "name": "target" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let engine = worker
        .agent_engine
        .as_ref()
        .expect("the unscripted worker builds the real engine")
        .clone();
    let rows = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink_rows = Arc::clone(&rows);
    engine.set_mcp_notification_row_sink(Arc::new(move |message| {
        sink_rows.lock().unwrap().push(message.custom_type);
    }));
    let (_id, mut rx) = engine
        .mcp_elicitations
        .open(AnswerField {
            name: "name".to_string(),
            kind: FieldKind::Text,
        })
        .unwrap();
    // The TUI sends a mid-turn submission with `streamingBehavior: "steer"`.
    let response = worker
        .dispatch(
            "prompt",
            &json!({ "message": "/elicit accept Jev", "streamingBehavior": "steer" }),
        )
        .await;
    assert!(response.success, "prompt failed: {response:?}");
    assert_eq!(
        rx.try_recv().expect("the request was answered"),
        ElicitationDecision::Accept(json!("Jev"))
    );
    let core = worker.core.lock().unwrap();
    assert!(core.steering.is_empty(), "no steering item");
    assert!(core.follow_up.is_empty(), "no follow-up item");
}

/// A `/elicit` with nothing pending answers with the status row rather than a
/// turn (and still never enters a lane).
#[tokio::test]
async fn an_elicit_prompt_with_nothing_pending_is_not_a_turn() {
    let dir = std::env::temp_dir().join(format!("pa-worker-elicit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let worker = real_worker(&dir);
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": dir.display().to_string(), "name": "target" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let response = worker
        .dispatch("prompt", &json!({ "message": "/elicit" }))
        .await;
    assert!(response.success, "prompt failed: {response:?}");
    let core = worker.core.lock().unwrap();
    assert!(core.steering.is_empty(), "no steering item");
    assert!(core.follow_up.is_empty(), "no follow-up item");
}
