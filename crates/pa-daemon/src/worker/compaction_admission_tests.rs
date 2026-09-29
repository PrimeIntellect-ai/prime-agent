//! The compaction admission-gate tests: the racing class a manual
//! compaction must defer, the post-window delivery that keeps a
//! mid-window-cleared suspension's parked work from stranding, and the
//! frozen admission classes the gate must not touch.
//!
//! TS anchor: `_isBusyForSessionInput("pump")` rides
//! `externalBusy = isCompacting || isRetrying || isBashRunning`
//! (agent-session.ts), so a resume site that clears the suspension
//! mid-compaction (`_admitSessionInput`'s `wake: "immediate"` resume)
//! still cannot dispatch — the pump parks on `isCompacting` until
//! `compact()`'s `finally` re-schedules it. The runner's admission gate
//! is the port's pump decision point.
use super::*;

/// A created worker over the scripted engine carrying one compaction
/// script (the `delayMs` sleep IS the mid-compaction window the racing
/// steer lands in; an empty script never runs one).
async fn compaction_admission_worker(compaction: Value) -> Arc<Worker> {
    let dir = std::env::temp_dir().join(format!("pa-compacting-gate-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: std::path::PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "compaction-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({
            "responses": ["steer reply"],
            "compaction": compaction,
        })),
    };
    let worker = Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "compacting" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

/// The session events seen by an attached client, in wire order (one
/// `event` payload per frame).
fn session_events(
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

/// The text of one content part (a text part carries `text`; any other
/// block has none).
fn part_text(part: &Value) -> &str {
    part.get("text").and_then(Value::as_str).unwrap_or_default()
}

/// Whether one session event is a delivered row (a `message_start` or
/// `message_end` frame) whose message carries `text` — the wire shape a
/// landed user or assistant row takes (a plain user row carries its
/// content as the string, an assistant reply as content parts).
fn delivered_row_with_text(event: &Value, text: &str) -> bool {
    let frame = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if frame != "message_start" && frame != "message_end" {
        return false;
    }
    let Some(message) = event.get("message") else {
        return false;
    };
    let Some(content) = message.get("content") else {
        return false;
    };
    content.as_str() == Some(text)
        || content
            .as_array()
            .is_some_and(|parts| parts.iter().any(|part| part_text(part) == text))
}

/// Poll until `ready` (a bounded wait for a state the worker reaches on
/// its own).
async fn wait_for_state(readiness: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !readiness() {
        assert!(
            std::time::Instant::now() < deadline,
            "the awaited worker state never arrived"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// The racing class: a steer whose resume site fires MID-COMPACTION (the
/// suspension clears inside the window, TS `_admitSessionInput`'s
/// `wake: "immediate"` resume) must DEFER, not admit — no turn starts,
/// the parked item stays in its lane, and no user row reaches the wire
/// while the compaction holds the context. The steer then delivers
/// AFTER the window: `compact()`'s `finally` re-schedules the input
/// pump (the port's tail wake), and the wire order proves it —
/// `compaction_end` precedes the racing row. Without the wake the
/// cleared suspension would strand the parked steer forever (the lost
/// steer is worse than the racing turn).
#[tokio::test]
async fn steer_mid_compaction_defers_and_delivers_after_the_window() {
    let worker = compaction_admission_worker(json!({
        "responses": [ { "summary": "racing window summary", "delayMs": 1500 } ],
    }))
    .await;
    let mut subscription = worker.events.subscribe();

    // The compact runs on its own task: the scripted delay is the
    // mid-compaction window.
    let compacting_worker = Arc::clone(&worker);
    let compact = tokio::spawn(async move {
        compacting_worker
            .dispatch(
                "compact",
                &json!({ "activeSessionId": "compaction-session" }),
            )
            .await
    });
    wait_for_state(|| worker.core.lock().unwrap().compacting).await;

    // The racing steer: a resume site inside the window. It answers
    // queued (the lane snapshot below), exactly like TS's admitted
    // action parked behind the busy state.
    let steered = worker
        .dispatch("steer", &json!({ "message": "racing steer" }))
        .await;
    assert!(steered.success, "the racing steer was refused: {steered:?}");
    // The resume site cleared the suspension MID-WINDOW (the TS
    // resume shape): the cleared flag alone must not admit.
    assert!(
        !worker.core.lock().unwrap().queued_input_suspended,
        "the resume site did not clear the suspension mid-window"
    );

    // The racing class defers: across a bounded observation INSIDE the
    // window no turn starts, the item stays parked, and no row lands.
    // The observation accumulates the wire (a row that landed before a
    // tick must not be drained away from the check).
    let mut seen = Vec::new();
    let observation = std::time::Duration::from_millis(300);
    let started = std::time::Instant::now();
    while started.elapsed() < observation {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        {
            let core = worker.core.lock().unwrap();
            assert!(
                core.compacting,
                "the observation outlived the compaction window"
            );
            assert!(!core.busy, "the racing steer admitted mid-compaction");
            assert_eq!(
                core.steering.len(),
                1,
                "the parked steer left its lane mid-compaction"
            );
        }
        seen.extend(session_events(&mut subscription));
        assert!(
            !seen
                .iter()
                .any(|event| delivered_row_with_text(event, "racing steer")),
            "the racing user row landed mid-compaction: {seen:?}"
        );
    }

    // The window ends; the compact settled.
    let joined = tokio::time::timeout(std::time::Duration::from_secs(10), compact).await;
    let compact = match joined {
        Ok(joined) => joined.expect("the compact task panicked"),
        Err(error) => panic!("the compact never settled: {error}"),
    };
    assert!(compact.success, "scripted compact failed: {compact:?}");
    assert!(
        !worker.core.lock().unwrap().compacting,
        "the window never closed"
    );

    // Post-window delivery: the parked steer's turn runs (the tail wake
    // is its only deliverer here — no goal branch, no further resume
    // site), and the wire order carries it AFTER `compaction_end`.
    let idle = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        worker.dispatch("wait_for_idle", &json!({})),
    )
    .await
    .expect("the parked steer never drained (lost, not deferred)");
    assert!(idle.success, "never went idle: {idle:?}");

    let events = session_events(&mut subscription);
    let end_index = events
        .iter()
        .position(|event| event.get("type").and_then(Value::as_str) == Some("compaction_end"))
        .expect("the compaction_end event never reached the wire");
    let steer_row = events
        .iter()
        .position(|event| delivered_row_with_text(event, "racing steer"))
        .expect("the racing steer never delivered after the window");
    assert!(
        end_index < steer_row,
        "the racing row landed before compaction_end: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|event| delivered_row_with_text(event, "steer reply")),
        "the racing steer's turn never ran its reply: {events:?}"
    );
    let _ = std::fs::remove_dir_all(worker.config.recovery_journal_path.parent().unwrap());
}

/// The frozen admission classes: with no compaction in flight the same
/// steer and a plain prompt admit exactly as before the gate term —
/// the compacting term parks only while a compaction actually holds the
/// context (TS `isCompacting` is a live-run state, not a session
/// default).
#[tokio::test]
async fn idle_sessions_admit_the_steering_and_plain_prompt_classes() {
    let worker = compaction_admission_worker(json!({})).await;
    let mut subscription = worker.events.subscribe();

    let steered = worker
        .dispatch("steer", &json!({ "message": "idle steer" }))
        .await;
    assert!(steered.success, "the idle steer was refused: {steered:?}");
    let idle = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        worker.dispatch("wait_for_idle", &json!({})),
    )
    .await
    .expect("the idle steer never ran");
    assert!(idle.success, "never went idle: {idle:?}");
    let events = session_events(&mut subscription);
    assert!(
        events
            .iter()
            .any(|event| delivered_row_with_text(event, "idle steer")),
        "the idle steer's row never landed: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|event| delivered_row_with_text(event, "steer reply")),
        "the idle steer's reply never landed: {events:?}"
    );

    // A plain prompt admits on the same idle session (no suspension
    // was armed).
    let plain = worker
        .dispatch(
            "prompt_and_wait",
            &json!({
                "activeSessionId": "compaction-session",
                "message": "plain prompt",
            }),
        )
        .await;
    assert!(plain.success, "the plain prompt was refused: {plain:?}");
    assert!(
        !worker.core.lock().unwrap().queued_input_suspended,
        "no suspension may arm on the idle classes"
    );
    let _ = std::fs::remove_dir_all(worker.config.recovery_journal_path.parent().unwrap());
}
