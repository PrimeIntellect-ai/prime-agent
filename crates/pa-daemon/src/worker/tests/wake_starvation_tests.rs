//! BUG 2: auto-background wake starvation. Every wake mechanism — the
//! cell wake, its pending probe, and the run-stop probe — reads the
//! steering lane alone, so a busy turn holding a sleeping cell must see
//! an arriving user steer or a wakesCell notice on that lane, never
//! parked on the follow-up lane where it starves until the cell settles.

use super::*;

/// A created worker over the faux agent engine (the engine that wires the
/// worker's cell wake), with no runner started: rows stay queued.
async fn faux_engine_worker(name: &str) -> (std::sync::Arc<Worker>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("pa-worker-wake-{}-{name}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: std::path::PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "wake-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({
            "engine": "faux",
            "responses": ["ack", "ack"],
        })),
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": dir.to_string_lossy(), "name": name }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    (worker, dir)
}

/// The busy-window user steer (the ACP adapter's wire shape after BUG 2's
/// fix: `streamingBehavior: "steer"`) takes the steering lane and fires
/// the cell wake, so a sleeping cell auto-backgrounds and the turn stops
/// at its next boundary instead of starving the message.
#[tokio::test]
async fn a_busy_sessions_user_steer_takes_the_steering_lane_and_wakes_the_cell() {
    let (worker, dir) = faux_engine_worker("steer").await;
    worker.core.lock().unwrap().busy = true;
    let engine = worker
        .agent_engine
        .clone()
        .expect("the faux engine wires the worker cell wake");
    let mut wake = engine.cell_wake.subscribe();
    let accepted = worker
        .dispatch(
            "prompt",
            &json!({
                "activeSessionId": "wake-session",
                "message": "steer over the sleeping cell",
                "streamingBehavior": "steer",
            }),
        )
        .await;
    assert!(accepted.success, "prompt failed: {accepted:?}");
    {
        let core = worker.core.lock().unwrap();
        assert_eq!(core.steering.len(), 1, "the steer rides the steering lane");
        assert!(core.follow_up.is_empty(), "nothing parks behind the cell");
    }
    tokio::time::timeout(std::time::Duration::from_secs(2), wake.awakened())
        .await
        .expect("the steering admission fires the cell wake");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A wakesCell kernel notice (the bash-completion shape) takes the
/// steering lane and fires the cell wake while the session is busy — the
/// inbox-routed arrival and the legacy full-row steer share the lane.
#[tokio::test]
async fn a_busy_sessions_wakes_cell_notice_takes_the_steering_lane_and_wakes() {
    let (worker, dir) = faux_engine_worker("notice").await;
    worker.core.lock().unwrap().busy = true;
    let engine = worker
        .agent_engine
        .clone()
        .expect("the faux engine wires the worker cell wake");
    let mut wake = engine.cell_wake.subscribe();
    // Drive the real `bash.completed` host handler: its sink admits the
    // notice through the worker's lanes and fires the wake.
    let mut handlers = pa_core::kernel::shared::HostRequestHandlers::default();
    engine.register_kernel_notice_host_handlers(&mut handlers);
    let completion = handlers
        .get(pa_core::kernel::shared::BASH_COMPLETED_REQUEST_TYPE)
        .expect("the bash completion handler is registered")
        .clone();
    let reply = completion(pa_core::kernel::shared::HostRequestPayload {
        data: json!({ "pid": 4321, "command": "sleep 300; echo WAKE", "exitCode": 0 }),
    })
    .await;
    assert!(reply.is_ok(), "the notice admitted: {reply:?}");
    let queued = {
        let core = worker.core.lock().unwrap();
        core.steering
            .iter()
            .chain(core.follow_up.iter())
            .filter(|item| row_wakes_a_cell(item))
            .count()
    };
    assert_eq!(queued, 1, "the wakesCell notice queued a wakeable row");
    {
        let core = worker.core.lock().unwrap();
        assert!(
            core.follow_up.is_empty(),
            "the notice never parks on the follow-up lane: {:?}",
            core.follow_up
                .iter()
                .map(|item| item.message.as_str())
                .collect::<Vec<_>>()
        );
    }
    tokio::time::timeout(std::time::Duration::from_secs(2), wake.awakened())
        .await
        .expect("the wakesCell notice fires the cell wake");
    let _ = std::fs::remove_dir_all(&dir);
}
