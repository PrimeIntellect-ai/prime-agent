//! Queue lane priority, snapshot, and arming tests.
use super::*;

fn priority_test_item(message: &str, policy: TurnPolicy) -> QueuedItem {
    QueuedItem {
        message: message.to_string(),
        priority: QueuePriority::Human,
        preview: None,
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: None,
        client_admission_id: None,
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy,
        forced_batch: false,
        kernel_notice: false,
        delivery_scoped: false,
    }
}

#[test]
fn queue_priority_interleaves_lanes_fifo_and_preserves_explicit_order() {
    let mut core = SessionCore::test_core(None, "/tmp".to_string());
    core.steering_mode = "one-at-a-time".to_string();
    core.follow_up_mode = "one-at-a-time".to_string();
    let add = |core: &mut SessionCore, lane: Lane, text: &str, priority| {
        let mut item = priority_test_item(text, TurnPolicy::Queued);
        item.priority = priority;
        match lane {
            Lane::Steering => enqueue_priority(&mut core.steering, item),
            Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
        }
    };
    add(
        &mut core,
        Lane::FollowUp,
        "machine follow 1",
        QueuePriority::Background,
    );
    add(
        &mut core,
        Lane::Steering,
        "machine steer 1",
        QueuePriority::Background,
    );
    add(
        &mut core,
        Lane::FollowUp,
        "human follow 1",
        QueuePriority::Human,
    );
    add(
        &mut core,
        Lane::Steering,
        "human steer 1",
        QueuePriority::Human,
    );
    add(
        &mut core,
        Lane::Steering,
        "machine steer 2",
        QueuePriority::Background,
    );
    add(
        &mut core,
        Lane::FollowUp,
        "human follow 2",
        QueuePriority::Human,
    );
    add(
        &mut core,
        Lane::Steering,
        "human steer 2",
        QueuePriority::Human,
    );
    assert_eq!(
        session_snapshot(&core).steering,
        [
            "human steer 1",
            "human steer 2",
            "machine steer 1",
            "machine steer 2"
        ]
    );
    assert_eq!(
        session_snapshot(&core).follow_ups,
        ["human follow 1", "human follow 2", "machine follow 1"]
    );
    core.steering.swap(0, 2); // explicit user reorder crosses priority boundary
    add(
        &mut core,
        Lane::Steering,
        "human steer 3",
        QueuePriority::Human,
    );
    assert_eq!(
        session_snapshot(&core).steering,
        [
            "machine steer 1",
            "human steer 2",
            "human steer 1",
            "human steer 3",
            "machine steer 2"
        ]
    );
    assert_eq!(
        gather_delivery_batch(&mut core, Lane::Steering)[0].message,
        "machine steer 1"
    );
    assert_eq!(
        gather_delivery_batch(&mut core, Lane::Steering)[0].message,
        "human steer 2"
    );
    core.steering.clear();
    assert_eq!(
        gather_delivery_batch(&mut core, Lane::FollowUp)[0].message,
        "human follow 1"
    );
}

#[test]
fn queue_priority_drains_four_tiers_and_pinned_front() {
    let mut core = SessionCore::test_core(None, "/tmp".to_string());
    core.steering_mode = "one-at-a-time".to_string();
    core.follow_up_mode = "one-at-a-time".to_string();
    for (lane, text, priority) in [
        (Lane::FollowUp, "machine follow", QueuePriority::Background),
        (Lane::Steering, "machine steer", QueuePriority::Background),
        (Lane::FollowUp, "human follow", QueuePriority::Human),
        (Lane::Steering, "human steer", QueuePriority::Human),
        (Lane::FollowUp, "pinned follow", QueuePriority::Pinned),
    ] {
        let mut item = priority_test_item(text, TurnPolicy::Queued);
        item.priority = priority;
        match lane {
            Lane::Steering => enqueue_priority(&mut core.steering, item),
            Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
        }
    }
    let mut delivered = Vec::new();
    while !core.steering.is_empty() || !core.follow_up.is_empty() {
        let lane = if core.steering.is_empty() {
            Lane::FollowUp
        } else {
            Lane::Steering
        };
        delivered.push(gather_delivery_batch(&mut core, lane).remove(0).message);
    }
    assert_eq!(
        delivered,
        [
            "human steer",
            "machine steer",
            "pinned follow",
            "human follow",
            "machine follow"
        ]
    );
}

#[tokio::test]
async fn rpc_custom_rows_do_not_gain_human_queue_priority() {
    let worker = created_dispatch_worker().await;
    let pause = worker.dispatch("acquire_session_input_pause", &json!({
        "activeSessionId": "suspension-session", "leaseKey": "source-test", "clientId": "test"
    })).await;
    assert!(pause.success, "pause failed: {pause:?}");
    let custom = |content: &str| {
        json!({
            "role": "custom", "customType": "user", "content": content
        })
    };
    for (command, message, row) in [
        (
            "steer",
            "machine via steer",
            Some(custom("machine via steer")),
        ),
        (
            "prompt",
            "machine via prompt",
            Some(custom("machine via prompt")),
        ),
        ("steer", "human via steer", None),
        ("prompt", "human via prompt", None),
    ] {
        let mut payload = json!({ "activeSessionId": "suspension-session", "message": message });
        if let Some(row) = row {
            payload["customMessage"] = row;
        }
        let admitted = worker.dispatch(command, &payload).await;
        assert!(admitted.success, "{command}: {admitted:?}");
    }
    let core = worker.core.lock().unwrap();
    assert_eq!(
        session_snapshot(&core).steering,
        [
            "human via steer",
            "human via prompt",
            "machine via steer",
            "machine via prompt"
        ]
    );
    assert_eq!(
        core.steering
            .iter()
            .map(|item| item.priority)
            .collect::<Vec<_>>(),
        [
            QueuePriority::Human,
            QueuePriority::Human,
            QueuePriority::Background,
            QueuePriority::Background,
        ]
    );
}

#[tokio::test]
async fn waiting_rpc_prompt_overtakes_background_steer_and_settles() {
    let worker = created_dispatch_worker().await;
    let pause = worker.dispatch("acquire_session_input_pause", &json!({
        "activeSessionId": "suspension-session", "leaseKey": "priority-test", "clientId": "test"
    })).await;
    assert!(pause.success, "pause failed: {pause:?}");
    {
        let mut core = worker.core.lock().unwrap();
        core.busy = true; // a prompt admitted behind work is queue-visible
        let mut background = priority_test_item("machine steer", TurnPolicy::Injected);
        background.priority = QueuePriority::Background;
        enqueue_priority(&mut core.steering, background);
    }
    let waiting_worker = std::sync::Arc::clone(&worker);
    let waiting = tokio::spawn(async move {
        waiting_worker
            .dispatch(
                "prompt_and_wait",
                &json!({
                    "activeSessionId": "suspension-session",
                    "message": "human steer",
                    "streamingBehavior": "steer",
                }),
            )
            .await
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if worker.core.lock().unwrap().steering.len() == 2 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "waiting prompt was not queued"
        );
        tokio::task::yield_now().await;
    }
    {
        let core = worker.core.lock().unwrap();
        assert_eq!(
            session_snapshot(&core).steering,
            ["human steer", "machine steer"]
        );
    }
    let released = worker.dispatch("release_session_input_pause", &json!({
        "activeSessionId": "suspension-session", "pauseId": pause.data.as_ref().unwrap()["pauseId"],
        "clientId": "test"
    })).await;
    assert!(released.success, "release failed: {released:?}");
    let settled = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
        .await
        .expect("prompt_and_wait did not settle")
        .expect("dispatch task panicked");
    assert!(settled.success, "waiting prompt failed: {settled:?}");
}

#[test]
fn legacy_queue_record_priority_defaults_by_row_and_keeps_order() {
    let dir = std::env::temp_dir().join(format!("pa-worker-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("priority-recovery.jsonl");
    let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
    let machine: crate::journal::WorkerQueueItemRecord = serde_json::from_value(json!({
        "message": "machine", "custom_message": {"role": "custom", "customType": "notice"}
    }))
    .unwrap();
    let human: crate::journal::WorkerQueueItemRecord = serde_json::from_value(json!({
        "message": "human"
    }))
    .unwrap();
    let future: crate::journal::WorkerQueueItemRecord = serde_json::from_value(json!({
        "message": "future machine", "priority": "new_tier"
    }))
    .unwrap();
    journal
        .record_queue_snapshot("legacy", &[machine, human, future], &[], false)
        .unwrap();
    drop(journal);
    let reopened = WorkerRecoveryJournal::open(&path).unwrap();
    let (lane, _, _) = restore_queue_snapshot(&reopened, "legacy");
    assert_eq!(
        lane.iter()
            .map(|item| item.message.as_str())
            .collect::<Vec<_>>(),
        ["machine", "human", "future machine"]
    );
    assert_eq!(lane[0].priority, QueuePriority::Background);
    assert_eq!(lane[1].priority, QueuePriority::Human);
    assert_eq!(lane[2].priority, QueuePriority::Background);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn queue_snapshot_round_trips_through_the_recovery_journal() {
    let dir = std::env::temp_dir().join(format!("pa-worker-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let journal_path = dir.join("recovery.jsonl");
    let mut journal = WorkerRecoveryJournal::open(&journal_path).unwrap();
    // A parked heartbeat rides the journal with its full delivery row, so a
    // respawned worker restores the heartbeat component, not a plain user row.
    let content = "[heartbeat: every 10m run#0]\n\nnudge the mission";
    let labeled_preview = format!(
        "{}: {content}",
        pa_core::session_engine::messages::HEARTBEAT_PROMPT_PREVIEW_LABEL
    );
    let heartbeat = crate::journal::WorkerQueueItemRecord {
        message: content.to_string(),
        priority: Some(QueuePriority::Background),
        preview: Some(labeled_preview),
        custom_message: Some(json!({
            "role": "custom",
            "customType": "heartbeat_prompt",
            "content": content,
            "display": true,
            "details": { "jobId": "hb-1" },
        })),
        queue_key: Some("heartbeat:hb-1".to_string()),
        queue_visible: true,
        policy: "injected".to_string(),
        forced_batch: false,
        kernel_notice: false,
        delivery_scoped: false,
        images: Vec::new(),
    };
    let plain = crate::journal::WorkerQueueItemRecord {
        message: "follow-me".to_string(),
        priority: Some(QueuePriority::Human),
        preview: None,
        custom_message: None,
        queue_key: None,
        queue_visible: true,
        policy: "queued".to_string(),
        forced_batch: false,
        kernel_notice: false,
        delivery_scoped: false,
        images: Vec::new(),
    };
    journal
        .record_queue_snapshot(
            "session-a",
            std::slice::from_ref(&heartbeat),
            std::slice::from_ref(&plain),
            false,
        )
        .unwrap();
    // A reopen (respawned worker) reads the latest snapshot per session.
    drop(journal);
    let reloaded = WorkerRecoveryJournal::open(&journal_path).unwrap();
    let (steering, follow_up, _) = restore_queue_snapshot(&reloaded, "session-a");
    assert_eq!(steering.len(), 1);
    assert_eq!(steering[0].message, heartbeat.message);
    assert_eq!(steering[0].priority, QueuePriority::Background);
    assert_eq!(steering[0].preview, heartbeat.preview);
    assert_eq!(steering[0].custom_message, heartbeat.custom_message);
    assert_eq!(steering[0].queue_key, heartbeat.queue_key);
    assert!(steering[0].queue_visible);
    assert_eq!(follow_up.len(), 1);
    assert_eq!(follow_up[0].message, "follow-me");
    assert_eq!(follow_up[0].priority, QueuePriority::Human);
    // Compaction (triggered by an all-idle record) keeps the snapshot
    // with its full rows.
    drop(reloaded);
    let mut compacting = WorkerRecoveryJournal::open(&journal_path).unwrap();
    compacting
        .record("session-a", "s1", None, false, "idle")
        .unwrap();
    drop(compacting);
    let compacted = WorkerRecoveryJournal::open(&journal_path).unwrap();
    let (steering, _, _) = restore_queue_snapshot(&compacted, "session-a");
    assert_eq!(steering.len(), 1);
    assert_eq!(steering[0].custom_message, heartbeat.custom_message);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A version-1 queue snapshot (pre-item text lanes a prior binary wrote).
#[test]
fn a_version_one_queue_snapshot_restores_as_plain_rows() {
    let dir = std::env::temp_dir().join(format!("pa-worker-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let journal_path = dir.join("recovery.jsonl");
    std::fs::write(
        &journal_path,
        "{\"version\":1,\"type\":\"queue_snapshot\",\"active_session_id\":\"session-b\",\"steering\":[\"steer-me\"],\"follow_up\":[\"follow-me\"],\"recorded_at\":\"2026-09-22T00:00:00.000Z\"}\n",
    )
    .unwrap();
    let journal = WorkerRecoveryJournal::open(&journal_path).unwrap();
    let (steering, follow_up, _) = restore_queue_snapshot(&journal, "session-b");
    assert_eq!(steering.len(), 1);
    assert_eq!(steering[0].message, "steer-me");
    assert_eq!(steering[0].preview, None);
    assert_eq!(steering[0].custom_message, None);
    assert_eq!(steering[0].queue_key, None);
    assert!(steering[0].queue_visible);
    assert_eq!(follow_up.len(), 1);
    assert_eq!(follow_up[0].message, "follow-me");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Only the visible plain-user steering items arm; agent-message deliveries
/// and injected custom rows never join, and an empty lane arms nothing.
#[tokio::test]
async fn forced_batch_arming_classifies_the_visible_plain_rows() {
    let worker = created_dispatch_worker().await;
    {
        let mut core = worker.core.lock().unwrap();
        core.steering.push_back(QueuedItem {
            priority: QueuePriority::Human,
            preview: None,
            message: "steer one".to_string(),
            custom_message: None,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            client_admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
            kernel_notice: false,
            delivery_scoped: false,
        });
        core.steering.push_back(QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: "agent message row".to_string(),
            custom_message: None,
            agent_message: Some("agent message row".to_string()),
            queue_key: None,
            admission_id: None,
            client_admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Injected,
            forced_batch: false,
            kernel_notice: false,
            delivery_scoped: false,
        });
        core.steering.push_back(QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: "injected custom row".to_string(),
            custom_message: Some(json!({ "role": "custom", "customType": "x" })),
            agent_message: None,
            queue_key: None,
            admission_id: None,
            client_admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Injected,
            forced_batch: false,
            kernel_notice: false,
            delivery_scoped: false,
        });
        core.steering.push_back(QueuedItem {
            priority: QueuePriority::Human,
            preview: None,
            message: "steer two".to_string(),
            custom_message: None,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            client_admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
            kernel_notice: false,
            delivery_scoped: false,
        });
    }
    assert!(
        worker.arm_forced_all_steering(),
        "the armable rows exist: the arm fired"
    );
    {
        let core = worker.core.lock().unwrap();
        assert!(core.forced_all_steering, "the forced batch is armed");
        let armed: Vec<bool> = core.steering.iter().map(|item| item.forced_batch).collect();
        assert_eq!(
            armed,
            vec![true, false, false, true],
            "only the visible plain-user rows armed: {armed:?}"
        );
    }
    // A lane with nothing armable arms nothing new — the armed state
    // itself persists until a pump selection consumes or disarms it.
    worker.core.lock().unwrap().steering.clear();
    assert!(
        !worker.arm_forced_all_steering(),
        "an empty lane arms nothing"
    );
    {
        let core = worker.core.lock().unwrap();
        assert!(core.forced_all_steering, "the armed state persists");
        assert!(
            core.steering.iter().all(|item| !item.forced_batch),
            "no item carries the armed flag"
        );
    }
}

/// The `kill_if_idle` refusal vocabulary the stop tails read: the
/// worker's own texts and the saturated route's typed refusal keep
/// the candidate (a worker at its in-flight bound is a busy one, and
/// the request never left the supervisor); every other failure leaves
/// the stop's contract to the caller.
#[test]
fn the_kill_refusal_vocabulary_classifies_the_overloaded_answer() {
    use pa_types::daemon::DaemonErrorInfo;
    let answer = |error: Option<&str>, error_info: Option<DaemonErrorInfo>| {
        pa_types::daemon::DaemonResponse {
            id: None,
            command: "kill_if_idle".to_string(),
            success: false,
            data: None,
            error: error.map(str::to_string),
            error_info,
        }
    };
    assert!(kill_refused_by_worker(&answer(
        None,
        Some(DaemonErrorInfo::WorkerOverloaded)
    )));
    assert!(kill_refused_by_worker(&answer(
        Some(KILL_IF_IDLE_HOLDS_WORK),
        None
    )));
    assert!(kill_refused_by_worker(&answer(
        Some(KILL_IF_IDLE_HAS_CLIENT),
        None
    )));
    assert!(
        !kill_refused_by_worker(&answer(None, None)),
        "an untyped failure leaves the stop's contract to the caller"
    );
    assert!(
        !kill_refused_by_worker(&answer(Some("unknown session"), None)),
        "a passivated worker's unknown-session route is not a refusal"
    );
}

/// Two ADMISSION-NAMED rows of the legacy daemon shape (each prompt its
/// own admission, no batch-isolation flag) co-deliver as ONE turn under
/// the "all" follow-up mode whatever their admission ids name — the
/// TS-era rule: a legacy client's queued prompts ride one turn, one
/// model call. The admission-pair split is the DELIVERY-SCOPED rows'
/// rule alone (the A2A prompt's `deliveryScoped` flag); the
/// unconditional form of the split once broke this legacy contract.
#[test]
fn legacy_admission_named_rows_batch_under_all_mode() {
    let mut core = SessionCore::test_core(None, "/tmp".to_string());
    core.follow_up_mode = "all".to_string();
    for (wire, client, text) in [
        ("wire-one", "normal-batch-1", "first admission prompt"),
        ("wire-two", "normal-batch-2", "second admission prompt"),
    ] {
        let mut item = priority_test_item(text, TurnPolicy::Queued);
        item.admission_id = Some(wire.to_string());
        item.client_admission_id = Some(client.to_string());
        core.follow_up.push_back(item);
    }
    let batch = gather_delivery_batch(&mut core, Lane::FollowUp);
    assert_eq!(
        batch.len(),
        2,
        "the distinct admission pairs co-deliver one turn: {batch:?}"
    );
}

/// A DELIVERY-SCOPED row (the A2A prompt's batch-isolation flag) never
/// co-delivers with another delivery's row, in either queue order: the
/// scoped front admits no other row, and a scoped row never joins
/// another front — one delivery, one turn, one reply per task.
#[test]
fn delivery_scoped_rows_never_batch_with_other_deliveries() {
    let scoped_row = |message: &str| {
        let mut item = priority_test_item(message, TurnPolicy::Queued);
        item.delivery_scoped = true;
        item.admission_id = Some("wire-a".to_string());
        item.client_admission_id = Some("a2a-delivery-a".to_string());
        item
    };
    let foreign_row = |message: &str| {
        let mut item = priority_test_item(message, TurnPolicy::Queued);
        item.admission_id = Some("wire-foreign".to_string());
        item.client_admission_id = Some("foreign-client".to_string());
        item
    };
    for scoped_first in [true, false] {
        let mut core = SessionCore::test_core(None, "/tmp".to_string());
        core.follow_up_mode = "all".to_string();
        let (scoped, plain) = (
            scoped_row("the a2a task"),
            foreign_row("the foreign prompt"),
        );
        if scoped_first {
            core.follow_up.push_back(scoped);
            core.follow_up.push_back(plain);
        } else {
            core.follow_up.push_back(plain);
            core.follow_up.push_back(scoped);
        }
        let batch = gather_delivery_batch(&mut core, Lane::FollowUp);
        assert_eq!(
            batch.len(),
            1,
            "the delivery-scoped row delivers solo: {batch:?}"
        );
        assert_eq!(
            batch[0].delivery_scoped, scoped_first,
            "the queue's front delivered alone: {batch:?}"
        );
    }
}
