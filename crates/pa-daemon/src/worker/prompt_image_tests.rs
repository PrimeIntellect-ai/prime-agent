//! Prompt-image parsing tests (the queue concern's test mod).
use super::*;
use serde_json::json;

#[test]
fn parses_wire_images_and_drops_incomplete_entries() {
    let payload = json!({
        "message": "look",
        "images": [
            { "type": "image", "data": "QUJD", "mimeType": "image/png" },
            { "type": "image", "mimeType": "image/png" },
            { "type": "image", "data": "QQ==" },
            { "type": "text", "text": "not an image" }
        ]
    });
    let images = parse_prompt_images(&payload);
    assert_eq!(images.len(), 1);
    assert_eq!(images[0].data, "QUJD");
    assert_eq!(images[0].mime_type, "image/png");
}

#[test]
fn missing_or_empty_images_admit_text_only() {
    assert!(parse_prompt_images(&json!({ "message": "plain" })).is_empty());
    assert!(parse_prompt_images(&json!({ "images": [] })).is_empty());
    assert!(parse_prompt_images(&json!({ "images": null })).is_empty());
}

fn test_worker() -> Arc<Worker> {
    let dir = std::env::temp_dir().join(format!("pa-worker-img-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "target-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
    };
    Arc::new(Worker::new(config, None))
}

/// A `prompt` command with wire images queues the attachments with the
/// message (they ride the queue item into the engine as multimodal
/// user content).
#[tokio::test]
async fn prompt_with_images_queues_the_images_with_the_message() {
    let worker = test_worker();
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    // Busy session: the prompt lands on the follow-up lane.
    worker.core.lock().unwrap().busy = true;
    let response = worker
        .dispatch(
            "prompt",
            &json!({
                "message": "look at this",
                "images": [
                    { "type": "image", "data": "QUJD", "mimeType": "image/png" }
                ],
            }),
        )
        .await;
    assert!(response.success, "prompt failed: {response:?}");
    let images = {
        let core = worker.core.lock().unwrap();
        core.follow_up
            .iter()
            .map(|item| item.images.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(images.len(), 1, "one queued item");
    assert_eq!(
        images[0],
        vec![pa_agent::types::ImageContent {
            data: "QUJD".to_string(),
            mime_type: "image/png".to_string(),
        }],
        "the attachment rides the queue item"
    );
}
