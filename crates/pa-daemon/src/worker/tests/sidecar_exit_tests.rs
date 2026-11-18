#![cfg(unix)]
//! The session-end sidecar pins: a worker that ends a session leaves a
//! current info sidecar — the next process that reads the file folds zero bytes.
use super::*;
use std::path::{Path, PathBuf};

/// The sidecar must certify the file's final generation and have consumed
/// it whole: `generation.len == file len && offset == file len`.
fn assert_sidecar_current(label: &str, session_file: &Path) {
    let file_len = std::fs::metadata(session_file).expect("session file").len();
    let sidecar = session_file.with_extension("info-cache.json");
    let bytes =
        std::fs::read(&sidecar).unwrap_or_else(|error| panic!("{label}: no sidecar: {error}"));
    let value: Value = serde_json::from_slice(&bytes).expect("the sidecar is JSON");
    let len = value["state"]["generation"]["len"]
        .as_u64()
        .expect("gen len");
    let offset = value["state"]["offset"].as_u64().expect("offset");
    assert_eq!(
        (len, offset),
        (file_len, file_len),
        "{label}: the sidecar must be current to the file's final bytes"
    );
}

fn faux_worker(dir: &Path, reply: &str) -> std::sync::Arc<Worker> {
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: std::path::PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "sidecar-exit-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "engine": "faux", "responses": [reply] })),
    };
    std::sync::Arc::new(Worker::new(config, None))
}

async fn create_and_prompt(worker: &Worker, create: &Value, message: &str) -> PathBuf {
    let created = worker.dispatch("create", create).await;
    assert!(created.success, "create failed: {created:?}");
    let session_file = created.data.expect("summary")["sessionFile"]
        .as_str()
        .expect("session file")
        .to_string();
    let prompted = worker
        .dispatch(
            "prompt_and_wait",
            &json!({"activeSessionId": "sidecar-exit-session", "message": message}),
        )
        .await;
    assert!(prompted.success, "the prompt failed: {prompted:?}");
    PathBuf::from(session_file)
}

async fn kill(worker: &Worker) {
    let killed = worker.dispatch("kill", &json!({})).await;
    assert!(killed.success, "kill failed: {killed:?}");
}

/// A worker whose turn settled: the fresh arm never folds, so the sidecar
/// is current only if the END wrote it — not a warm tail of the kill's own
/// archived row.
#[cfg(unix)]
#[tokio::test]
async fn an_ended_worker_session_leaves_a_current_info_sidecar() {
    let dir = std::env::temp_dir().join(format!("pa-sidecar-exit-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let worker = faux_worker(&dir, "sidecar reply");
    let session_file = create_and_prompt(
        &worker,
        &json!({
            "cwd": dir.to_string_lossy(),
            "sessionDir": dir.join("sessions").to_string_lossy(),
        }),
        "sidecar question",
    )
    .await;
    // The scan prime the roster pushes make in production (the push queue
    // is off in this fixture; the orphan-exit e2e covers the push path).
    let _ = crate::session_store::read_session_info(&session_file);
    kill(&worker).await;
    assert_sidecar_current("fresh + turn + kill", &session_file);
}

/// The bump-day shape: a reopened session over a dead-version sidecar ends
/// with a sidecar at the served version, current to the file's final bytes.
#[cfg(unix)]
#[tokio::test]
async fn a_reopened_session_ends_with_a_current_info_sidecar() {
    let dir = std::env::temp_dir().join(format!("pa-sidecar-reopen-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let create = json!({
        "cwd": dir.to_string_lossy(),
        "sessionPath": dir.join("sessions").join("reopen.jsonl").to_string_lossy(),
    });
    let first = faux_worker(&dir, "first reply");
    let session_file = create_and_prompt(&first, &create, "first question").await;
    let _ = crate::session_store::read_session_info(&session_file);
    kill(&first).await;
    // The dead-version sidecar a newer build must not serve.
    let sidecar = session_file.with_extension("info-cache.json");
    let mut value: Value =
        serde_json::from_slice(&std::fs::read(&sidecar).expect("the first kill wrote a sidecar"))
            .expect("the sidecar is JSON");
    value["version"] = json!(1);
    std::fs::write(&sidecar, serde_json::to_vec(&value).unwrap()).unwrap();

    let second = faux_worker(&dir, "second reply");
    create_and_prompt(&second, &create, "second question").await;
    kill(&second).await;
    assert_sidecar_current("reopen + turn + kill", &session_file);
}
