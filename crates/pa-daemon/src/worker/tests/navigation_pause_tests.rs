//! The navigation/fork queued-work pause (TS `_navigateTree`'s
//! `acquireQueuedWorkPause` + `waitForIdle`): a steer parked behind the
//! interrupted turn stays parked while the navigation settles and swaps,
//! then delivers on the navigated-to branch.
use super::*;

const TURN_DELAY_MS: u64 = 1500;
const SUMMARY_DELAY_MS: u64 = 600;
const STEER_TEXT: &str = "steer mid-turn";

fn seeded_session(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("sessions").join("nav-pause.jsonl");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let message = json!({ "role": "user", "content": "first prompt", "timestamp": 10u64 });
    std::fs::write(
        &path,
        format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"nav-pause-session\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}}\n\
             {{\"type\":\"message\",\"message\":{},\"id\":\"m1\",\"parentId\":null,\"timestamp\":\"2026-01-01T00:00:00.000Z\"}}\n",
            serde_json::to_string(&message).unwrap(),
        ),
    )
    .unwrap();
    path
}

async fn navigation_worker(dir: &std::path::Path, path: &std::path::Path) -> Arc<Worker> {
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: std::path::PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "nav-pause-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({
            // The branch-summary delay holds the navigation open; whichever
            // response the aborted turn leaves, the steer's reply comes from
            // this list, so the post-flow assertion stays structural.
            "responses": [
                { "text": "first scripted reply", "delayMs": TURN_DELAY_MS },
                { "text": "second scripted reply", "delayMs": 2500 },
            ],
            "branchSummary": { "responses": [
                { "summary": "the abandoned branch summary", "delayMs": SUMMARY_DELAY_MS },
            ]},
        })),
    };
    let worker = Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({
                "cwd": dir.to_string_lossy(),
                "sessionDir": dir.join("sessions").to_string_lossy(),
                "sessionPath": path.to_string_lossy(),
                "name": "nav-pause",
            }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

/// Poll the connection state until the predicate holds, panicking with the
/// last state on the deadline.
async fn wait_for_state(
    worker: &Worker,
    what: &str,
    deadline: Duration,
    predicate: impl Fn(&Value) -> bool,
) {
    let start = std::time::Instant::now();
    loop {
        let response = worker.dispatch("get_connection_state", &json!({})).await;
        assert!(
            response.success,
            "get_connection_state failed: {response:?}"
        );
        let state = response.data.expect("connection state data");
        if predicate(&state) {
            return;
        }
        assert!(
            start.elapsed() < deadline,
            "timed out waiting for {what}; last state: {state}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn steer_parked(state: &Value) -> bool {
    state
        .get("sessionActions")
        .and_then(|actions| actions.get("steering"))
        .and_then(Value::as_array)
        .is_some_and(|lane| lane.iter().any(|text| text == STEER_TEXT))
}

/// The transcript's string-content rows.
async fn transcript_texts(worker: &Worker) -> Vec<String> {
    let response = worker.dispatch("get_messages", &json!({})).await;
    assert!(response.success, "get_messages failed: {response:?}");
    response.data.expect("get_messages data")["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .filter_map(|message| {
            message
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

/// A steer parked behind the interrupted turn stays parked while the
/// navigation settles and swaps — never admitted on the abandoned branch —
/// and delivers on the navigated-to branch after the flow.
#[tokio::test]
async fn a_parked_steer_delivers_only_after_the_navigation() {
    let dir = std::env::temp_dir().join(format!("pa-nav-pause-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = seeded_session(&dir);
    let worker = navigation_worker(&dir, &path).await;

    // The slow turn holds the session busy; the steer parks behind it.
    let turn = {
        let worker = Arc::clone(&worker);
        tokio::spawn(async move {
            worker
                .dispatch("prompt_and_wait", &json!({ "message": "run one" }))
                .await
        })
    };
    wait_for_state(
        &worker,
        "the turn to start",
        Duration::from_secs(3),
        |state| state.get("isStreaming").and_then(Value::as_bool) == Some(true),
    )
    .await;
    let queued = worker
        .dispatch(
            "prompt",
            &json!({ "message": STEER_TEXT, "streamingBehavior": "steer" }),
        )
        .await;
    assert!(queued.success, "steer failed: {queued:?}");
    wait_for_state(
        &worker,
        "the steer to park",
        Duration::from_secs(3),
        steer_parked,
    )
    .await;

    // The navigation interrupts the turn and summarizes the abandoned branch.
    let navigation = {
        let worker = Arc::clone(&worker);
        tokio::spawn(async move {
            worker
                .dispatch(
                    "navigate_tree",
                    &json!({ "targetId": "m1", "summarize": true }),
                )
                .await
        })
    };

    // Witness the interrupted turn's settle, then hold the window: while the
    // branch-summary delay keeps the navigation in flight, the parked steer
    // must stay parked and nothing may run.
    wait_for_state(
        &worker,
        "the turn to settle",
        Duration::from_secs(3),
        |state| state.get("isStreaming").and_then(Value::as_bool) == Some(false),
    )
    .await;
    let start = std::time::Instant::now();
    while !navigation.is_finished() {
        let response = worker.dispatch("get_connection_state", &json!({})).await;
        let state = response.data.expect("connection state data");
        assert!(
            state.get("isStreaming").and_then(Value::as_bool) != Some(true),
            "the parked steer was admitted inside the navigation window: {state}"
        );
        assert!(
            steer_parked(&state),
            "the steer left the queue mid-navigation: {state}"
        );
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "the navigation never completed"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let navigated = navigation.await.expect("navigation task");
    assert!(navigated.success, "navigate_tree failed: {navigated:?}");

    // The released pause delivers the steer on the navigated-to branch; the
    // abandoned branch's rows are gone.
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let texts = loop {
        let texts = transcript_texts(&worker).await;
        if texts.len() >= 2 {
            break texts;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the steer never delivered on the navigated-to branch: {texts:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(
        texts[0], STEER_TEXT,
        "the steer's row leads the new branch: {texts:?}"
    );
    assert!(
        !texts.iter().any(|text| text.contains("run one")),
        "the abandoned rows must not survive the navigation: {texts:?}"
    );
    drop(turn);
}
