use super::*;

/// A positive collect releases only its selected child while the parent
/// turn remains active, then waits for prompt acceptance and completion.
#[tokio::test]
async fn a_blocking_collect_mid_turn_releases_the_held_task_prompt() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let gate = Arc::new(FakePeerGate {
        armed: AtomicBool::new(true),
        ..FakePeerGate::default()
    });
    let child_subagents = Arc::new(FakeChildSubagents {
        prompt_gate: Some(Arc::clone(&gate)),
        ..FakeChildSubagents::default()
    });
    let (sessions, _kill_rx) = sessions_with_fake_child_subagents(
        follow_up_tx,
        0,
        FakeKill::Success,
        FakeChild::Healthy,
        Arc::clone(&child_subagents),
    )
    .await;
    sessions.notify_turn_started();
    let handle = spawn_child(&sessions).await;

    let poll = sessions
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .expect("zero-timeout collect is a snapshot");
    assert_eq!((poll[0].status, poll[0].settled), ("running", false));
    let record = Arc::clone(&sessions.inner.children.lock().await[0]);
    assert!(
        !record.lock().await.run.prompt_released(),
        "a zero-timeout poll keeps the task prompt held"
    );

    let collect_sessions = sessions.clone();
    let child_id = handle.rlm_child_id.clone();
    let collect =
        tokio::spawn(async move { collect_sessions.collect(vec![child_id], 5_000).await });
    tokio::time::timeout(Duration::from_secs(10), gate.copied.notified())
        .await
        .expect("the positive collect releases the selected prompt");
    let in_flight = sessions
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .expect("zero poll while prompt acceptance is held");
    assert_eq!(
        (in_flight[0].status, in_flight[0].settled),
        ("running", false)
    );
    let turn = *sessions.inner.parent_turn.borrow();
    assert!(turn.running, "collect must not end the parent turn");
    assert_eq!(turn.completed, 0);

    gate.release.notify_one();
    let result = tokio::time::timeout(Duration::from_secs(10), collect)
        .await
        .expect("collect completes after prompt acceptance")
        .expect("collect task remains alive")
        .expect("collect succeeds");
    assert_eq!((result[0].status, result[0].settled), ("done", true));
    assert_eq!(
        result[0].answer_text.as_deref(),
        Some("the child final answer")
    );
    let turn = *sessions.inner.parent_turn.borrow();
    assert!(turn.running, "collect leaves the parent turn active");
    assert_eq!(turn.completed, 0);
}

/// A positive collect releases every selected task before it waits on the first
/// prompt's admission.
#[tokio::test]
async fn a_blocking_collect_releases_all_selected_prompts_before_waiting() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let gate = Arc::new(FakePeerGate {
        armed: AtomicBool::new(true),
        ..FakePeerGate::default()
    });
    let (sessions, _kill_rx) = sessions_with_fake_child_subagents(
        follow_up_tx,
        0,
        FakeKill::Success,
        FakeChild::Healthy,
        Arc::new(FakeChildSubagents {
            prompt_gate: Some(Arc::clone(&gate)),
            ..FakeChildSubagents::default()
        }),
    )
    .await;
    sessions.notify_turn_started();
    let first = sessions
        .spawn(RlmSpawnRequest {
            prompt: "first task".to_string(),
            name: Some("batch-first".to_string()),
            model: None,
            thinking: None,
            kind: pa_core::session_engine::rlm_host::RlmSpawnKind::Subagent,
            cwd: None,
            spawned_by_request_id: None,
            factory: None,
        })
        .await
        .expect("spawn first child");
    let second = sessions
        .spawn(RlmSpawnRequest {
            prompt: "second task".to_string(),
            name: Some("batch-second".to_string()),
            model: None,
            thinking: None,
            kind: pa_core::session_engine::rlm_host::RlmSpawnKind::Subagent,
            cwd: None,
            spawned_by_request_id: None,
            factory: None,
        })
        .await
        .expect("spawn second child");

    let collect_sessions = sessions.clone();
    let first_id = first.rlm_child_id.clone();
    let second_id = second.rlm_child_id.clone();
    let collect = tokio::spawn(async move {
        collect_sessions
            .collect(vec![first_id, second_id], 5_000)
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), gate.copied.notified())
        .await
        .expect("the first selected prompt reaches its admission gate");

    let records = sessions.inner.children.lock().await.clone();
    assert_eq!(records.len(), 2);
    for record in records {
        assert!(
            record.lock().await.run.prompt_released(),
            "collect releases all selected prompts before waiting"
        );
    }

    gate.release.notify_one();
    let result = tokio::time::timeout(Duration::from_secs(10), collect)
        .await
        .expect("collect completes after both prompts are admitted")
        .expect("collect task remains alive")
        .expect("collect succeeds");
    assert_eq!(result.len(), 2);
    assert!(result
        .iter()
        .all(|child| child.status == "done" && child.settled));
}

/// A positive collect during deletion keeps the task prompt held while the
/// delete's delayed kill is in flight.
#[tokio::test]
async fn a_blocking_collect_does_not_release_a_prompt_during_delete() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let gate = Arc::new(FakePeerGate {
        armed: AtomicBool::new(true),
        ..FakePeerGate::default()
    });
    let (sessions, mut kill_rx) = sessions_with_fake_child_subagents(
        follow_up_tx,
        0,
        FakeKill::SuccessAfterMs(1_500),
        FakeChild::Healthy,
        Arc::new(FakeChildSubagents {
            prompt_gate: Some(Arc::clone(&gate)),
            ..FakeChildSubagents::default()
        }),
    )
    .await;
    sessions.notify_turn_started();
    let handle = spawn_child(&sessions).await;
    let delete_sessions = sessions.clone();
    let delete_id = handle.rlm_child_id.clone();
    let delete = tokio::spawn(async move { delete_sessions.delete_subagent(delete_id).await });
    let kill = tokio::time::timeout(Duration::from_secs(10), kill_rx.recv())
        .await
        .expect("delete reaches its delayed kill")
        .expect("kill receiver remains open");
    assert_eq!(kill["type"], "kill");

    let collect_result = tokio::time::timeout(
        Duration::from_millis(500),
        sessions.collect(vec![handle.rlm_child_id.clone()], 5_000),
    )
    .await
    .expect("collect exits when it sees the retiring child")
    .expect("collect succeeds");
    let record = Arc::clone(&sessions.inner.children.lock().await[0]);
    assert!(
        !record.lock().await.run.prompt_released(),
        "collect does not release a task prompt during delete"
    );
    assert_eq!(
        (collect_result[0].status, collect_result[0].settled),
        ("running", false)
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), gate.copied.notified())
            .await
            .is_err(),
        "delete in flight keeps the prompt gate unopened"
    );

    let deleted = tokio::time::timeout(Duration::from_secs(5), delete)
        .await
        .expect("delayed delete completes")
        .expect("delete task remains alive")
        .expect("delete succeeds");
    assert_eq!(deleted.outcome, Some("deleted"));
}

/// A collect waiting behind another child operation wakes when deletion starts.
#[tokio::test]
async fn a_blocking_collect_waiter_wakes_when_delete_begins() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, mut kill_rx) = sessions_with_fake_supervisor(
        follow_up_tx,
        0,
        FakeKill::SuccessAfterMs(1_500),
        FakeChild::Healthy,
    )
    .await;
    sessions.notify_turn_started();
    let handle = spawn_child(&sessions).await;
    let record = Arc::clone(&sessions.inner.children.lock().await[0]);
    let rename_lock = record.lock().await.rename_lock.clone();
    let held = rename_lock.lock().await;
    let mut delete = sessions.delete_subagent(handle.rlm_child_id.clone());
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(delete.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    let mut collect = sessions.collect(vec![handle.rlm_child_id], 5_000);
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(collect.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    assert!(record.lock().await.run.prompt_released());
    assert!(!record.lock().await.run.prompt_admitted());

    let delete = tokio::spawn(delete);
    let collect = tokio::spawn(collect);
    drop(held);
    tokio::time::timeout(Duration::from_secs(10), kill_rx.recv())
        .await
        .expect("delete reaches its delayed kill")
        .expect("kill receiver remains open");
    let result = tokio::time::timeout(Duration::from_millis(500), collect)
        .await
        .expect("collect wakes before kill confirmation")
        .expect("collect task remains alive")
        .expect("collect succeeds");
    assert_eq!((result[0].status, result[0].settled), ("running", false));
    delete.await.unwrap().expect("delete succeeds");
}

/// A delete cannot overtake a kickoff whose admission already owns the gate.
#[tokio::test]
async fn delete_waits_for_an_in_flight_prompt_admission() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let gate = Arc::new(FakePeerGate {
        armed: AtomicBool::new(true),
        ..FakePeerGate::default()
    });
    let (sessions, mut kill_rx) = sessions_with_fake_child_subagents(
        follow_up_tx,
        0,
        FakeKill::Success,
        FakeChild::Healthy,
        Arc::new(FakeChildSubagents {
            prompt_gate: Some(Arc::clone(&gate)),
            ..FakeChildSubagents::default()
        }),
    )
    .await;
    let handle = spawn_child(&sessions).await;
    tokio::time::timeout(Duration::from_secs(10), gate.copied.notified())
        .await
        .expect("the kickoff reaches prompt admission");
    let record = Arc::clone(&sessions.inner.children.lock().await[0]);
    let mut delete = sessions.delete_subagent(handle.rlm_child_id);
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(delete.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    assert!(
        !record.lock().await.retirement.retiring(),
        "BeginDelete must not overtake an in-flight prompt admission"
    );
    assert!(kill_rx.try_recv().is_err());

    gate.release.notify_one();
    tokio::time::timeout(Duration::from_secs(10), delete)
        .await
        .expect("delete proceeds after prompt admission")
        .expect("delete succeeds");
    assert_eq!(kill_rx.recv().await.unwrap()["type"], "kill");
}

/// A released sender cannot admit a task while a delete owns the child.
#[tokio::test]
async fn a_queued_prompt_does_not_start_during_delete() {
    for kill_fails in [false, true] {
        for interrupted in [false, true] {
            let kill_gate = Arc::new(FakePeerGate::default());
            let kill = if kill_fails {
                FakeKill::Failure
            } else {
                FakeKill::Success
            };
            let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
            let gate = Arc::new(FakePeerGate {
                armed: AtomicBool::new(true),
                ..FakePeerGate::default()
            });
            let (sessions, mut kill_rx) = sessions_with_fake_child_subagents(
                follow_up_tx,
                0,
                kill,
                FakeChild::Healthy,
                Arc::new(FakeChildSubagents {
                    prompt_gate: Some(Arc::clone(&gate)),
                    kill_gate: Some(Arc::clone(&kill_gate)),
                    ..FakeChildSubagents::default()
                }),
            )
            .await;
            sessions.notify_turn_started();
            let handle = spawn_child(&sessions).await;
            let record = Arc::clone(&sessions.inner.children.lock().await[0]);
            let delete_sessions = sessions.clone();
            let child_id = handle.rlm_child_id.clone();
            let mut delete =
                tokio::spawn(async move { delete_sessions.delete_subagent(child_id).await });
            tokio::time::timeout(Duration::from_secs(10), kill_rx.recv())
                .await
                .expect("delete sends its kill")
                .expect("kill receiver stays open");
            assert!(record.lock().await.retirement.retiring());

            sessions.notify_turn_done();
            assert!(
                tokio::time::timeout(Duration::from_millis(100), gate.copied.notified())
                    .await
                    .is_err(),
                "the queued kickoff must not reach the worker during deletion"
            );
            if interrupted {
                delete.abort();
                assert!(delete.await.unwrap_err().is_cancelled());
                assert!(
                    tokio::time::timeout(Duration::from_millis(100), gate.copied.notified())
                        .await
                        .is_err(),
                    "an interrupted delete still prevents kickoff admission"
                );
                let retry_sessions = sessions.clone();
                delete = tokio::spawn(async move {
                    retry_sessions.delete_subagent(handle.rlm_child_id).await
                });
                tokio::time::timeout(Duration::from_secs(10), kill_rx.recv())
                    .await
                    .expect("the retry sends its kill")
                    .expect("kill receiver stays open");
            }
            kill_gate.release.notify_waiters();
            let deleted = delete.await.unwrap();
            if kill_fails {
                assert!(deleted.is_err());
                tokio::time::timeout(Duration::from_secs(10), gate.copied.notified())
                    .await
                    .expect("a refused kill leaves the kickoff runnable");
                gate.release.notify_one();
                tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
                    .await
                    .expect("the surviving child completes")
                    .expect("follow-up receiver stays open");
            } else {
                deleted.expect("delete succeeds");
                let released = Arc::downgrade(&record);
                drop(record);
                tokio::time::timeout(Duration::from_secs(2), async {
                    while released.strong_count() != 0 {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .expect("retirement releases the detached kickoff owner");
                assert!(
                    tokio::time::timeout(Duration::from_millis(100), gate.copied.notified())
                        .await
                        .is_err(),
                    "the confirmed delete must discard the queued kickoff"
                );
            }
        }
    }
}

/// A failed task prompt wakes a positive collect instead of consuming its
/// full deadline.
#[tokio::test]
async fn a_blocking_collect_returns_promptly_when_the_prompt_fails() {
    let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
    let (sessions, _kill_rx) =
        sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success, FakeChild::PromptFails)
            .await;
    sessions.notify_turn_started();
    let handle = spawn_child(&sessions).await;

    let result = tokio::time::timeout(
        Duration::from_secs(2),
        sessions.collect(vec![handle.rlm_child_id], 60_000),
    )
    .await
    .expect("prompt failure wakes collect before its 60-second deadline")
    .expect("collect succeeds");
    assert_eq!((result[0].status, result[0].settled), ("error", true));
}

/// A collect whose shared deadline expires before prompt acceptance returns
/// the current running snapshot without waiting for the idle worker.
#[tokio::test]
async fn a_blocking_collect_timeout_keeps_an_unadmitted_child_unsettled() {
    let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
    let gate = Arc::new(FakePeerGate {
        armed: AtomicBool::new(true),
        ..FakePeerGate::default()
    });
    let child_subagents = Arc::new(FakeChildSubagents {
        prompt_gate: Some(Arc::clone(&gate)),
        ..FakeChildSubagents::default()
    });
    let (sessions, _kill_rx) = sessions_with_fake_child_subagents(
        follow_up_tx,
        0,
        FakeKill::Success,
        FakeChild::Healthy,
        Arc::clone(&child_subagents),
    )
    .await;
    sessions.notify_turn_started();
    let handle = spawn_child(&sessions).await;
    let collect_sessions = sessions.clone();
    let child_id = handle.rlm_child_id.clone();
    let collect = tokio::spawn(async move { collect_sessions.collect(vec![child_id], 40).await });
    tokio::time::timeout(Duration::from_secs(10), gate.copied.notified())
        .await
        .expect("collect released the child prompt");

    let result = tokio::time::timeout(Duration::from_secs(2), collect)
        .await
        .expect("collect uses its admission deadline")
        .expect("collect task remains alive")
        .expect("collect succeeds");
    assert_eq!((result[0].status, result[0].settled), ("running", false));
    assert_eq!(
        child_subagents
            .wait_for_idle_requests
            .load(Ordering::SeqCst),
        0,
        "collect does not call wait_for_idle before prompt admission"
    );

    gate.release.notify_one();
    tokio::time::timeout(Duration::from_secs(10), follow_up_rx.recv())
        .await
        .expect("the detached prompt owner still completes after collect times out")
        .expect("follow_up channel stays open");
}
