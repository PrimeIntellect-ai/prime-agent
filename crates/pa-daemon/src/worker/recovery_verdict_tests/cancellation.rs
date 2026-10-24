//! Explicit cancellation must win over a later graceful shutdown.
use super::*;

#[derive(Clone, Copy)]
enum Cancellation {
    Owned,
    OwnedBatch,
    BareAbort,
    UnknownAdmission,
    CompletedAdmission,
}

#[tokio::test(flavor = "current_thread")]
async fn owned_cancel_before_shutdown_does_not_revive_the_picked_input() {
    cancelled_pickup_shutdown(Cancellation::Owned).await;
}

#[tokio::test(flavor = "current_thread")]
async fn bare_abort_before_shutdown_keeps_only_remaining_parked_input() {
    cancelled_pickup_shutdown(Cancellation::BareAbort).await;
}

#[tokio::test(flavor = "current_thread")]
async fn unknown_owned_cancel_does_not_discard_shutdown_recovery() {
    cancelled_pickup_shutdown(Cancellation::UnknownAdmission).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cancelling_one_owned_batch_member_does_not_revive_the_cancelled_turn() {
    cancelled_pickup_shutdown(Cancellation::OwnedBatch).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cancelling_a_completed_admission_does_not_cancel_the_next_picked_turn() {
    cancelled_pickup_shutdown(Cancellation::CompletedAdmission).await;
}

async fn cancelled_pickup_shutdown(cancellation: Cancellation) {
    let fixture = tempfile::tempdir().unwrap();
    let session_path = fixture.path().join("session.jsonl");
    let mut session = SessionFile::create(fixture.path().to_str().unwrap(), None, 0);
    session.set_path(session_path.clone());
    session.rewrite().unwrap();
    let worker = worker_with_journal_in(fixture.path());
    let created = worker
        .dispatch(
            "create",
            &json!({ "sessionPath": session_path, "cwd": fixture.path() }),
        )
        .await;
    assert!(created.success, "create isolated session: {created:?}");
    let paused = worker
        .dispatch(
            "acquire_session_input_pause",
            &json!({ "leaseKey": "cancel-shutdown-gate", "clientId": "synthetic-client" }),
        )
        .await;
    assert!(paused.success, "pause the native runner: {paused:?}");
    if matches!(cancellation, Cancellation::CompletedAdmission) {
        let native_park = worker.idle_notify.notified();
        let completed = worker
            .dispatch(
                "prompt",
                &json!({ "message": "synthetic completed input", "admissionId": "completed-owned" }),
            )
            .await;
        assert!(completed.success, "actual prior admission: {completed:?}");
        tokio::time::timeout(std::time::Duration::from_secs(5), native_park)
            .await
            .expect("native runner must park before the prior test-owned turn");
        let items = {
            let mut core = worker.core.lock().unwrap();
            let items = gather_delivery_batch(&mut core, Lane::Steering);
            assert_eq!(items.len(), 1);
            core.running_admission_ids = items
                .iter()
                .filter_map(|item| item.admission_id.clone())
                .collect();
            core.busy = true;
            items
        };
        let (release, released) = std::sync::mpsc::channel();
        let engine = Arc::new(BeforeUserRowEngine {
            entered: Arc::new(Notify::new()),
            captured: std::sync::Mutex::new(None),
            boundary: UserRowBoundary::BeforeFirst,
            release: std::sync::Mutex::new(released),
        });
        release.send(()).unwrap();
        gated_turn_runner(&worker, engine.clone())
            .run_turn(engine, Lane::Steering, items)
            .await;
        let core = worker.core.lock().unwrap();
        assert!(!core.busy && core.running_admission_ids.is_empty());
        assert_eq!(core.store.as_ref().unwrap().message_count(), 1);
    }
    let native_park = worker.idle_notify.notified();
    if matches!(cancellation, Cancellation::OwnedBatch) {
        // Represent intake behind a prior busy turn while the real native
        // runner is paused. Ownership is committed by each actual prompt RPC;
        // the parked native runner clears this intake-only busy state below.
        worker.core.lock().unwrap().busy = true;
    }
    let streaming_behavior = matches!(cancellation, Cancellation::OwnedBatch).then_some("steer");
    let admitted = worker
        .dispatch(
            "prompt",
            &json!({
                "message": "synthetic picked input", "admissionId": "picked-owned",
                "streamingBehavior": streaming_behavior,
            }),
        )
        .await;
    assert!(admitted.success, "actual owned admission: {admitted:?}");
    if matches!(cancellation, Cancellation::OwnedBatch) {
        let second = worker
            .dispatch(
                "prompt",
                &json!({
                    "message": "synthetic co-batched input", "admissionId": "batch-owned",
                    "streamingBehavior": "steer",
                }),
            )
            .await;
        assert!(second.success, "actual second owned admission: {second:?}");
    }
    if matches!(cancellation, Cancellation::BareAbort) {
        let queued = worker
            .dispatch(
                "follow_up",
                &json!({ "message": "synthetic remaining input" }),
            )
            .await;
        assert!(queued.success, "keep a visible queue row: {queued:?}");
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), native_park)
        .await
        .expect("native runner must observe the actual input pause");
    let items = {
        let mut core = worker.core.lock().unwrap();
        assert!(!core.queued_input_suspended);
        // The native runner stays paused. Use its real pickup primitive and
        // ownership transition to drive just the test-owned gated engine.
        let items = gather_delivery_batch(&mut core, Lane::Steering);
        assert_eq!(
            items.len(),
            if matches!(cancellation, Cancellation::OwnedBatch) {
                2
            } else {
                1
            }
        );
        assert_eq!(items[0].admission_id.as_deref(), Some("picked-owned"));
        if matches!(cancellation, Cancellation::OwnedBatch) {
            assert!(items.iter().all(|item| item.policy == TurnPolicy::Queued));
            assert_eq!(items[1].admission_id.as_deref(), Some("batch-owned"));
        }
        core.running_admission_ids = items
            .iter()
            .filter_map(|item| item.admission_id.clone())
            .collect();
        core.busy = true;
        items
    };
    let (release, released) = std::sync::mpsc::channel();
    let engine = Arc::new(BeforeUserRowEngine {
        entered: Arc::new(Notify::new()),
        captured: std::sync::Mutex::new(None),
        boundary: UserRowBoundary::BeforeFirst,
        release: std::sync::Mutex::new(released),
    });
    let entered_notify = Arc::clone(&engine.entered);
    let entered = entered_notify.notified();
    let runner = gated_turn_runner(&worker, engine.clone());
    let running = tokio::spawn(async move {
        runner.run_turn(engine, Lane::Steering, items).await;
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered)
        .await
        .expect("picked admission must reach the pre-user-row gate");
    {
        let core = worker.core.lock().unwrap();
        assert!(core.busy && core.running_admission_ids.contains("picked-owned"));
        assert!(!core.abort_requested);
        assert_eq!(
            core.store.as_ref().unwrap().message_count(),
            usize::from(matches!(cancellation, Cancellation::CompletedAdmission))
        );
        if matches!(cancellation, Cancellation::OwnedBatch) {
            assert!(core.running_admission_ids.contains("batch-owned"));
        }
    }
    let cancelled = match cancellation {
        Cancellation::Owned | Cancellation::OwnedBatch => {
            worker
                .dispatch(
                    "cancel_prompt_admission",
                    &json!({ "admissionId": "picked-owned", "cancelOwned": true }),
                )
                .await
        }
        Cancellation::BareAbort => worker.dispatch("abort", &json!({})).await,
        Cancellation::UnknownAdmission => {
            worker
                .dispatch(
                    "cancel_prompt_admission",
                    &json!({ "admissionId": "unknown-owned", "cancelOwned": true }),
                )
                .await
        }
        Cancellation::CompletedAdmission => {
            worker
                .dispatch(
                    "cancel_prompt_admission",
                    &json!({ "admissionId": "completed-owned", "cancelOwned": true }),
                )
                .await
        }
    };
    assert!(cancelled.success, "actual cancellation RPC: {cancelled:?}");
    match cancellation {
        Cancellation::Owned | Cancellation::OwnedBatch => {
            assert_eq!(cancelled.data, Some(json!({ "status": "owned" })));
            let core = worker.core.lock().unwrap();
            assert!(
                core.abort_requested,
                "the cancellation matched a running admission"
            );
            assert!(
                !core.queued_input_suspended,
                "owned cancellation never parks the queue"
            );
        }
        Cancellation::BareAbort => {
            let core = worker.core.lock().unwrap();
            assert!(core.abort_requested && core.queued_input_suspended);
            assert_eq!(
                core.follow_up.len(),
                1,
                "bare abort preserves visible remaining work"
            );
        }
        Cancellation::UnknownAdmission | Cancellation::CompletedAdmission => {
            assert_eq!(cancelled.data, Some(json!({ "status": "unknown" })));
            assert!(
                !worker.core.lock().unwrap().abort_requested,
                "unknown ID must cancel nothing"
            );
        }
    }
    let stopping = Arc::clone(&worker);
    let shutdown = tokio::spawn(async move {
        stopping
            .handle_shutdown(&json!({ "daemonShutdown": true }))
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if worker.core.lock().unwrap().shutdown_requested {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("actual shutdown must close input before the engine is released");
    release.send(()).unwrap();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(5), shutdown)
        .await
        .expect("shutdown must settle")
        .unwrap();
    assert!(reply.success, "shutdown failed: {reply:?}");
    tokio::time::timeout(std::time::Duration::from_secs(5), running)
        .await
        .expect("the gated turn must settle")
        .unwrap();
    let transcript: Vec<Value> = std::fs::read_to_string(&session_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|row| row["type"] == "message" && row["message"]["role"] == "user")
        .collect();
    let expected_transcript = if matches!(cancellation, Cancellation::CompletedAdmission) {
        vec![json!({ "role": "user", "content": "synthetic completed input", "timestamp": 1 })]
    } else {
        Vec::new()
    };
    assert_eq!(
        transcript
            .iter()
            .map(|row| row["message"].clone())
            .collect::<Vec<_>>(),
        expected_transcript,
        "only the completed control crossed the physical persistence boundary"
    );
    let (steering, follow_up, suspended) = WorkerRecoveryJournal::read_queue_snapshot(
        &worker.config.recovery_journal_path,
        "target-session",
    )
    .unwrap()
    .expect("shutdown must have a durable queue snapshot");
    let expected = match cancellation {
        Cancellation::Owned | Cancellation::OwnedBatch => (Vec::new(), Vec::new(), false),
        Cancellation::BareAbort => (Vec::new(), vec!["synthetic remaining input"], true),
        Cancellation::UnknownAdmission | Cancellation::CompletedAdmission => (
            vec![
                crate::update_restore::UPDATE_RESTART_CONTINUATION_PROMPT,
                "synthetic picked input",
            ],
            Vec::new(),
            false,
        ),
    };
    assert_eq!(
        (
            steering
                .iter()
                .map(|item| item.message.as_str())
                .collect::<Vec<_>>(),
            follow_up
                .iter()
                .map(|item| item.message.as_str())
                .collect::<Vec<_>>(),
            suspended,
        ),
        expected,
        "explicit cancellation must not revive its picked input; unknown cancellation must preserve it"
    );
    assert_eq!(
        latest_record(&worker).busy,
        matches!(
            cancellation,
            Cancellation::UnknownAdmission | Cancellation::CompletedAdmission
        )
    );
}
