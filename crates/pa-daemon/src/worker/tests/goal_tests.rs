//! Goal continuation and compact-mint e2e tests.
use super::*;

/// The telemetry send enters a real sink and stays there until released.
#[derive(Default)]
struct GoalControlGatedSink {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    released: std::sync::atomic::AtomicBool,
    delivered: std::sync::Mutex<Vec<String>>,
    delivered_notify: tokio::sync::Notify,
}

impl pa_telemetry::TelemetrySink for GoalControlGatedSink {
    fn send_batch<'a>(
        &'a self,
        _install_id: &'a str,
        events: Vec<pa_telemetry::TelemetryEvent>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = pa_telemetry::SinkOutcome> + Send + 'a>>
    {
        Box::pin(async move {
            self.entered.notify_one();
            while !self.released.load(std::sync::atomic::Ordering::SeqCst) {
                // `notify_one` keeps a permit if release beat this waiter.
                self.release.notified().await;
            }
            let mut delivered = self.delivered.lock().unwrap();
            delivered.extend(events.into_iter().map(|event| event.name));
            self.delivered_notify.notify_one();
            pa_telemetry::SinkOutcome::Sent
        })
    }
}

/// A scripted goal session's dispatch worker.
async fn goal_dispatch_worker(goal: serde_json::Value) -> std::sync::Arc<Worker> {
    let dir = std::env::temp_dir().join(format!("pa-worker-goal-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "goal-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({
            "responses": ["ack"],
            "goal": goal,
        })),
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "goal" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

/// TS `compact()`'s active-goal branch: a successful compact mints the owed continuation.
#[tokio::test]
async fn compact_with_active_goal_schedules_the_continue() {
    let worker = goal_dispatch_worker(json!({
        "status": "active",
        "objective": "land the post-compact continue",
        "message": "[goal: continuation]\n\nkeep pursuing the goal",
    }))
    .await;
    let mut subscription = worker.events.subscribe();
    let compact = worker
        .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
        .await;
    assert!(compact.success, "scripted compact failed: {compact:?}");
    // The scheduled continue drives the continuation turn; the idle
    // wait settles only after it ran.
    let idle = worker.dispatch("wait_for_idle", &json!({})).await;
    assert!(idle.success, "never went idle: {idle:?}");
    let events = session_events_since(&mut subscription);
    // The mint's `goal_update` surfaces first, then the continuation
    // turn: the goal-context custom row plus its model turn.
    let goal_updates: Vec<&Value> = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("goal_update"))
        .collect();
    assert_eq!(goal_updates.len(), 1, "events: {events:?}");
    assert_eq!(goal_updates[0]["goal"]["status"], "active");
    let custom_rows: Vec<&Value> = events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_start")
                && event["message"]["customType"] == "goal_context"
        })
        .collect();
    assert_eq!(custom_rows.len(), 1, "events: {events:?}");
    assert_eq!(
        custom_rows[0]["message"]["content"],
        "[goal: continuation]\n\nkeep pursuing the goal"
    );
    assert!(
        events
            .iter()
            .any(|event| event.get("type").and_then(Value::as_str) == Some("turn_end")),
        "the continuation turn never ran: {events:?}"
    );
    // The resume site crossed the #234 suspension gate: a plain prompt
    // is admitted again.
    let plain = worker
        .dispatch(
            "prompt_and_wait",
            &json!({ "activeSessionId": "goal-session", "message": "after the continue" }),
        )
        .await;
    assert!(plain.success, "still suspended: {plain:?}");
}

#[tokio::test]
async fn compact_with_active_goal_and_parked_work_skips_the_mint() {
    let worker = goal_dispatch_worker(json!({
        "status": "active",
        "objective": "land the post-compact continue",
    }))
    .await;
    let mut subscription = worker.events.subscribe();
    {
        // Park one queued follow-up behind the suspension gate, like a
        // steer that arrived mid-compact-window.
        let mut core = worker.core.lock().unwrap();
        core.queued_input_suspended = true;
        core.follow_up.push_back(QueuedItem {
            priority: QueuePriority::Human,
            preview: None,
            message: "parked queued work".to_string(),
            custom_message: None,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        });
    }
    let compact = worker
        .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
        .await;
    assert!(compact.success, "scripted compact failed: {compact:?}");
    let idle = worker.dispatch("wait_for_idle", &json!({})).await;
    assert!(idle.success, "never went idle: {idle:?}");
    let events = session_events_since(&mut subscription);
    assert!(
        events.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_start")
                && event["message"]["role"] == "user"
                && event["message"]["content"] == "parked queued work"
        }),
        "the parked item never ran: {events:?}"
    );
    assert!(
        !events.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_start")
                && event["message"]["customType"] == "goal_context"
        }),
        "a continuation was minted over the parked work: {events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|event| event.get("type").and_then(Value::as_str) == Some("goal_update")),
        "a mint emitted a goal_update: {events:?}"
    );
}

#[tokio::test]
async fn compact_with_paused_goal_never_continues() {
    let worker = goal_dispatch_worker(json!({
        "status": "paused",
        "objective": "land the post-compact continue",
    }))
    .await;
    let mut subscription = worker.events.subscribe();
    let compact = worker
        .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
        .await;
    assert!(compact.success, "scripted compact failed: {compact:?}");
    let rejected = worker
        .dispatch(
            "prompt_and_wait",
            &json!({ "activeSessionId": "goal-session", "message": "hi" }),
        )
        .await;
    assert_eq!(rejected.error.as_deref(), Some(QUEUED_INPUT_SUSPENDED));
    let events = session_events_since(&mut subscription);
    assert!(
        !events
            .iter()
            .any(|event| event.get("type").and_then(Value::as_str) == Some("goal_update")),
        "a paused goal minted a continuation: {events:?}"
    );
}

/// The goal continuation loop at the natural turn end (TS
/// `_getGoalContinuationMessages` + `_getContinuationMessages`): a
/// multi-continuation goal session driven to completion end to end
/// through the worker. The turn runner's queue drives each minted
/// continuation (the engine consults at every settled boundary, the
/// admission sink queues the follow-up, the runner wakes), the
/// budget-free loop keeps prompting until the kernel's
/// `goal.complete()` (the scripted ipython tool call, the f18
/// completion surface) settles the goal, and the completion's
/// boundary mints nothing more. The completing cell needs a
/// bootable kernel: a gate run needs the kernel venv, bootstrapped
/// or built with uv on PATH (the guard inside names the
/// recipe when the cell fails instead of letting the loop drain
/// the faux script into a misleading count mismatch).
#[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
#[tokio::test]
async fn goal_turn_end_loop_runs_to_completion() {
    let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("pa-worker-goal-loop-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "goal-loop-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({
            "engine": "faux",
            "responses": [
                "first pursuit turn",
                "second pursuit turn",
                { "content": [
                    { "type": "toolCall", "name": "python_repl",
                      "arguments": { "code": "import goal; await goal.complete()" } },
                ] },
                "wrap-up after the completion",
                "after the loop settled",
            ],
        })),
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "goal-loop" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let mut subscription = worker.events.subscribe();
    let start = worker
        .dispatch(
            "prompt_and_wait",
            &json!({
                "activeSessionId": "goal-loop-session",
                "message": "/goal drive the loop to completion",
            }),
        )
        .await;
    assert!(start.success, "the goal start failed: {start:?}");
    // The loop owns the session until the goal settles: the idle wait
    // returns only when the completion turn's boundary minted nothing.
    let idle = worker.dispatch("wait_for_idle", &json!({})).await;
    assert!(idle.success, "the goal loop never settled: {idle:?}");
    let events = session_events_since(&mut subscription);
    // A gate run without the kernel environment (the kernel venv, or
    // uv on PATH to build it) fails the
    // completing ipython cell: the goal stays active and the loop
    // keeps minting (TS parity: goal continuations are unbounded while
    // the goal is active) until the faux script runs dry. Fail with
    // the diagnosis instead of the misleading continuation-count
    // mismatch.
    let kernel_failure = events.iter().find(|event| {
        event.get("type").and_then(Value::as_str) == Some("message_end")
            && event["message"]["role"] == "toolResult"
            && event["message"]["isError"] == json!(true)
    });
    if let Some(failure) = kernel_failure {
        panic!(
            "the completing ipython cell failed — this test needs the kernel \
                 environment (the bootstrapped kernel venv, or uv on PATH to build it): {failure:?}"
        );
    }
    let goal_rows: Vec<&Value> = events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_start")
                && event["message"]["customType"] == "goal_context"
        })
        .collect();
    assert_eq!(goal_rows.len(), 3, "events: {events:?}");
    assert_eq!(goal_rows[0]["message"]["details"]["kind"], "continuation");
    assert_eq!(goal_rows[1]["message"]["details"]["continuationsUsed"], 1);
    assert_eq!(goal_rows[2]["message"]["details"]["continuationsUsed"], 2);
    let assistant_rows = events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_end")
                && event["message"]["role"] == "assistant"
        })
        .count();
    assert!(assistant_rows >= 4, "events: {events:?}");
    // The goal state settled complete through the worker's host
    // handlers.
    let complete_update = events
        .iter()
        .rev()
        .find(|event| {
            event.get("type").and_then(Value::as_str) == Some("goal_update")
                && event["goal"]["status"] == "complete"
        })
        .expect("the completion surfaced as a goal_update");
    assert_eq!(
        complete_update["goal"]["objective"],
        "drive the loop to completion"
    );
    assert_eq!(complete_update["goal"]["continuationsUsed"], 2);
    assert!(
        complete_update["goal"]["tokensUsed"].as_u64().unwrap_or(0) > 0,
        "usage accounting ran: {complete_update:?}"
    );
    let queue = worker
        .dispatch(
            "get_queue",
            &json!({ "activeSessionId": "goal-loop-session" }),
        )
        .await;
    assert!(queue.success, "queue read failed: {queue:?}");
    let plain = worker
        .dispatch(
            "prompt_and_wait",
            &json!({
                "activeSessionId": "goal-loop-session",
                "message": "after the loop",
            }),
        )
        .await;
    assert!(plain.success, "a post-goal prompt failed: {plain:?}");
}

#[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
#[tokio::test]
async fn goal_pause_withdraws_the_queued_continuation() {
    let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = std::env::temp_dir().join(format!("pa-worker-goal-pause-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "goal-pause-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({
            "engine": "faux",
            "responses": [
                "start turn",
                "one continuation turn at most",
            ],
        })),
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "goal-pause" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let start = worker
        .dispatch(
            "prompt_and_wait",
            &json!({
                "activeSessionId": "goal-pause-session",
                "message": "/goal pause right after the start",
            }),
        )
        .await;
    assert!(start.success, "the goal start failed: {start:?}");
    let pause = worker
        .dispatch(
            "prompt_and_wait",
            &json!({ "activeSessionId": "goal-pause-session", "message": "/goal pause" }),
        )
        .await;
    assert!(pause.success, "the pause never ran: {pause:?}");
    // The loop is quiet: the idle wait settles without consuming
    // further turns (a live continuation would starve it).
    let idle = worker.dispatch("wait_for_idle", &json!({})).await;
    assert!(idle.success, "the loop never went quiet: {idle:?}");
    let goal = worker.engine.goal_state_value();
    assert_eq!(goal["status"], "paused", "goal state: {goal}");
    assert!(
        goal["continuationsUsed"].as_u64().unwrap_or(0) <= 2,
        "the pause never withdrew the loop: {goal}"
    );
}

/// A scripted goal session's dispatch worker with a durable session
/// file, so the `thread_goal_state` mirror is observable.
async fn goal_dispatch_worker_with_store(
    goal: serde_json::Value,
) -> (std::sync::Arc<Worker>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("pa-worker-goal-{}", uuid::Uuid::new_v4()));
    let session_dir = dir.join("sessions");
    std::fs::create_dir_all(&session_dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "goal-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({
            "responses": ["ack"],
            "goal": goal,
        })),
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({
                "cwd": dir.to_string_lossy(),
                "name": "goal",
                "sessionDir": session_dir.to_string_lossy(),
            }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let file = std::fs::read_dir(&session_dir)
        .expect("session dir readable")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .expect("session file created");
    (worker, file)
}

/// The session file's `thread_goal_state` custom rows, in order.
fn thread_goal_state_rows(path: &std::path::Path) -> Vec<Value> {
    crate::session_store::parse_session_entries(&std::fs::read_to_string(path).expect("read"))
        .into_iter()
        .filter(|entry| {
            entry.get("type").and_then(Value::as_str) == Some("custom")
                && entry.get("customType").and_then(Value::as_str)
                    == Some(pa_core::goals::GOAL_STATE_CUSTOM_TYPE)
        })
        .collect()
}

/// The mirror row is what a recovery rebuild replays.
#[tokio::test]
async fn goal_update_events_mirror_the_durable_goal_row() {
    let (worker, file) = goal_dispatch_worker_with_store(json!({
        "emitUpdateOnPrompt": true,
        "state": {
            "active": true,
            "status": "active",
            "goalId": "goal-1",
            "objective": "ship the port",
            "tokensUsed": 340,
            "timeUsedSeconds": 9,
            "continuationsUsed": 2,
        },
    }))
    .await;
    let prompt = worker
        .dispatch(
            "prompt_and_wait",
            &json!({ "activeSessionId": "goal-session", "message": "work" }),
        )
        .await;
    assert!(prompt.success, "prompt failed: {prompt:?}");
    let rows = thread_goal_state_rows(&file);
    assert_eq!(rows.len(), 1, "rows: {rows:?}");
    assert_eq!(rows[0]["data"]["status"], "active");
    assert_eq!(rows[0]["data"]["objective"], "ship the port");
    assert_eq!(rows[0]["data"]["goalId"], "goal-1");
    assert_eq!(rows[0]["data"]["tokensUsed"], 340);
    assert_eq!(rows[0]["data"]["continuationsUsed"], 2);
}

/// The mint persists its row before the `goal_update`, so the count survives a crash.
#[tokio::test]
async fn compact_mint_persists_the_goal_state_row() {
    let (worker, file) = goal_dispatch_worker_with_store(json!({
        "status": "active",
        "objective": "ship the port",
        "state": {
            "active": true,
            "status": "active",
            "goalId": "goal-1",
            "objective": "ship the port",
            "tokensUsed": 340,
            "timeUsedSeconds": 9,
            "continuationsUsed": 1,
        },
    }))
    .await;
    let compact = worker
        .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
        .await;
    assert!(compact.success, "scripted compact failed: {compact:?}");
    let idle = worker.dispatch("wait_for_idle", &json!({})).await;
    assert!(idle.success, "never went idle: {idle:?}");
    let rows = thread_goal_state_rows(&file);
    assert_eq!(rows.len(), 1, "rows: {rows:?}");
    assert_eq!(rows[0]["data"]["status"], "active");
    assert_eq!(rows[0]["data"]["continuationsUsed"], 1);
    assert_eq!(rows[0]["data"]["objective"], "ship the port");
}

/// Direct controls persist before acknowledgement and withdraw pending goal work.
#[allow(clippy::await_holding_lock)] // faux provider registration spans both worker lifetimes
#[tokio::test(flavor = "current_thread")]
async fn direct_goal_control_is_durable_and_purges_queued_continuations() {
    let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();
    let path = dir.path().join("goal-control.jsonl");
    let mut store = crate::session_store::SessionFile::create(&cwd, None, 0);
    store.set_path(path.clone());
    store.append_entry(
        "custom",
        json!({
            "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
            "data": {
                "active": true,
                "status": "active",
                "goalId": "controlled-goal",
                "objective": "Original objective",
                "tokenBudget": 9000,
                "tokensUsed": 234,
                "timeUsedSeconds": 12,
                "continuationsUsed": 2,
            },
        }),
    );
    store.rewrite().unwrap();
    let worker_for = |active_session_id: &str| {
        Worker::new(
            WorkerConfig {
                socket_path: dir.path().join(format!("{active_session_id}.sock")),
                supervisor_socket_path: PathBuf::new(),
                token: "token".to_string(),
                worker_instance_id: String::new(),
                active_session_id: active_session_id.to_string(),
                agent_dir: dir.path().join("agent"),
                recovery_journal_path: dir
                    .path()
                    .join(format!("{active_session_id}.recovery.jsonl")),
                telemetry_disabled: Some(true),
                script: Some(
                    json!({ "engine": "faux", "responses": [{ "text": "should not run" }] }),
                ),
            },
            None,
        )
    };
    let first = worker_for("control-first");
    assert!(
        first
            .dispatch(
                "create",
                &json!({ "sessionPath": path.to_string_lossy(), "cwd": cwd })
            )
            .await
            .success
    );
    let agent_engine = first.agent_engine.as_ref().unwrap();
    let model = agent_engine.resolve_model().unwrap();
    agent_engine
        .ensure_core_session_async(&model)
        .await
        .unwrap();
    assert!(first.dispatch("wait_for_idle", &json!({})).await.success);
    *agent_engine.goal_backoff_wake_job_id.lock().unwrap() = Some("armed-before-cas".to_string());
    let stale = first
        .dispatch(
            "control_goal",
            &json!({
                "goalId": "controlled-goal",
                "expectedObjective": "stale",
                "action": "pause",
            }),
        )
        .await;
    assert!(!stale.success);
    assert_eq!(thread_goal_state_rows(&path).len(), 1);
    assert_eq!(
        agent_engine
            .goal_backoff_wake_job_id
            .lock()
            .unwrap()
            .as_deref(),
        Some("armed-before-cas")
    );
    {
        let mut core = first.core.lock().unwrap();
        core.busy = true;
        core.follow_up.push_back(QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: "obsolete continuation".to_string(),
            custom_message: Some(json!({ "customType": pa_core::goals::GOAL_CONTEXT_CUSTOM_TYPE })),
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: false,
            policy: TurnPolicy::Injected,
            forced_batch: false,
        });
    }
    let control = json!({
        "goalId": "controlled-goal",
        "expectedObjective": "Original objective",
        "action": "pause",
    });
    let paused = first.dispatch("control_goal", &control).await;
    assert!(paused.success, "pause failed: {paused:?}");
    let paused_goal = paused.data.as_ref().unwrap();
    assert_eq!(paused_goal["status"], "paused");
    assert_eq!(paused_goal["objective"], "Original objective");
    assert_eq!(paused_goal["tokenBudget"], 9000);
    assert_eq!(paused_goal["tokensUsed"], 234);
    assert_eq!(paused_goal["continuationsUsed"], 2);
    assert!(first.core.lock().unwrap().follow_up.is_empty());
    assert!(first
        .agent_engine
        .as_ref()
        .unwrap()
        .goal_backoff_wake_job_id
        .lock()
        .unwrap()
        .is_none());
    let rows = thread_goal_state_rows(&path);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1]["data"]["status"], "paused");
    first.core.lock().unwrap().busy = false;
    assert!(first.dispatch("kill", &json!({})).await.success);
    drop(first);

    let second = worker_for("control-second");
    assert!(
        second
            .dispatch(
                "create",
                &json!({ "sessionPath": path.to_string_lossy(), "cwd": cwd })
            )
            .await
            .success
    );
    let repeated_pause = second.dispatch("control_goal", &control).await;
    assert!(!repeated_pause.success);
    *second
        .agent_engine
        .as_ref()
        .unwrap()
        .goal_backoff_wake_job_id
        .lock()
        .unwrap() = Some("armed-before-clear".to_string());
    let cleared = second
        .dispatch(
            "control_goal",
            &json!({
                "goalId": "controlled-goal",
                "expectedObjective": "Original objective",
                "action": "clear",
            }),
        )
        .await;
    assert!(cleared.success, "clear failed: {cleared:?}");
    assert_eq!(cleared.data, Some(Value::Null));
    assert!(second
        .agent_engine
        .as_ref()
        .unwrap()
        .goal_backoff_wake_job_id
        .lock()
        .unwrap()
        .is_none());
    let rows = thread_goal_state_rows(&path);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[2]["data"]["status"], "idle");
    assert!(rows[2]["data"].get("objective").is_none());
    assert!(
        !second
            .dispatch(
                "control_goal",
                &json!({
                    "goalId": "controlled-goal",
                    "expectedObjective": "Original objective",
                    "action": "clear",
                })
            )
            .await
            .success
    );
    assert_eq!(thread_goal_state_rows(&path).len(), 3);

    // A failed worker-file mirror taints only its session. A successful
    // replacement installs a new store and clears that refusal.
    second
        .goal_control_dirty
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let rejected = second.dispatch("control_goal", &control).await;
    assert!(rejected
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("Goal persistence is uncertain"));
    let replacement = dir.path().join("goal-control-replaced.jsonl");
    let mut fresh = crate::session_store::SessionFile::create(&cwd, None, 0);
    fresh.set_path(replacement.clone());
    fresh.append_entry(
        "custom",
        json!({
            "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
            "data": {
                "active": true,
                "status": "active",
                "goalId": "fresh-goal",
                "objective": "Fresh objective",
                "tokensUsed": 0,
                "timeUsedSeconds": 0,
                "continuationsUsed": 0,
            },
        }),
    );
    fresh.rewrite().unwrap();
    let switched = second
        .dispatch(
            "switch_session",
            &json!({ "sessionPath": replacement.to_string_lossy(), "cwdOverride": cwd }),
        )
        .await;
    assert!(switched.success, "replacement failed: {switched:?}");
    let second_engine = second.agent_engine.as_ref().unwrap();
    let second_model = second_engine.resolve_model().unwrap();
    second_engine
        .ensure_core_session_async(&second_model)
        .await
        .unwrap();
    assert!(!second
        .goal_control_dirty
        .load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(
        second.engine.goal_state_value()["status"],
        "active",
        "replacement goal state: {:?}",
        second.engine.goal_state_value()
    );
    let fresh_control = second
        .dispatch(
            "control_goal",
            &json!({
                "goalId": "fresh-goal",
                "expectedObjective": "Fresh objective",
                "action": "pause",
            }),
        )
        .await;
    assert!(
        fresh_control.success,
        "fresh control failed: {fresh_control:?}"
    );
    assert_eq!(
        thread_goal_state_rows(&replacement).last().unwrap()["data"]["status"],
        "paused"
    );
}

/// The worker mirror callback runs while the `GoalDriver` lock still excludes
/// a turn's next mutation. This fixes the CAS-to-JSONL gap deterministically.
#[allow(clippy::await_holding_lock)] // faux provider registration spans the worker lifetime
#[tokio::test(flavor = "current_thread")]
async fn direct_goal_control_mirrors_under_driver_lock() {
    let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();
    let path = dir.path().join("goal-control-atomic.jsonl");
    let mut store = crate::session_store::SessionFile::create(&cwd, None, 0);
    store.set_path(path.clone());
    store.append_entry(
        "custom",
        json!({
            "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
            "data": {
                "active": true,
                "status": "active",
                "goalId": "atomic-goal",
                "objective": "Keep the latest goal",
                "tokensUsed": 2,
                "timeUsedSeconds": 0,
                "continuationsUsed": 0,
            },
        }),
    );
    store.rewrite().unwrap();
    let worker = Worker::new(
        WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "atomic-control".to_string(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: Some(true),
            script: Some(json!({ "engine": "faux", "responses": [{ "text": "unused" }] })),
        },
        None,
    );
    assert!(
        worker
            .dispatch(
                "create",
                &json!({ "sessionPath": path.to_string_lossy(), "cwd": cwd })
            )
            .await
            .success
    );
    let agent = worker.agent_engine.as_ref().unwrap();
    let model = agent.resolve_model().unwrap();
    agent.ensure_core_session_async(&model).await.unwrap();
    assert_eq!(
        worker.engine.goal_state_value()["status"],
        "active",
        "loaded goal state: {:?}",
        worker.engine.goal_state_value()
    );
    let mut callback_ran = false;
    let mut persist = |goal: &pa_core::goals::GoalState| -> anyhow::Result<()> {
        callback_ran = true;
        assert!(
            agent
                .goal_runtime
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .driver
                .try_lock()
                .is_err(),
            "driver must stay locked through mirror"
        );
        assert_eq!(goal.status, pa_core::goals::GoalStatus::Paused);
        Ok(())
    };
    let paused = worker
        .engine
        .control_goal(
            "atomic-goal",
            "Keep the latest goal",
            pa_core::session_engine::goal_driver::GoalControlAction::Pause,
            &mut persist,
        )
        .await
        .unwrap();
    assert!(callback_ran);
    assert_eq!(paused.unwrap().status, pa_core::goals::GoalStatus::Paused);
}

#[test]
fn stale_turn_goal_update_is_dropped_after_direct_control() {
    let captured = json!({
        "goalId": "atomic-goal",
        "objective": "Keep the latest goal",
        "status": "active",
        "tokensUsed": 2,
        "timeUsedSeconds": 3,
    });
    let mut current = captured.clone();
    current["timeUsedSeconds"] = json!(4);
    assert!(!super::super::turn::goal_update_is_superseded(
        &captured, &current
    ));
    current["status"] = json!("paused");
    assert!(super::super::turn::goal_update_is_superseded(
        &captured, &current
    ));
    current["status"] = json!("idle");
    assert!(super::super::turn::goal_update_is_superseded(
        &captured, &current
    ));
}

/// A real telemetry sink holds delivery while the direct control response
/// completes. This guards the busy-session telemetry handoff in the worker.
#[allow(clippy::await_holding_lock)] // faux provider registration spans the worker lifetime
#[tokio::test(flavor = "current_thread")]
async fn direct_goal_control_does_not_wait_for_telemetry_delivery() {
    let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();
    let path = dir.path().join("goal-control-telemetry.jsonl");
    let mut store = crate::session_store::SessionFile::create(&cwd, None, 0);
    store.set_path(path.clone());
    store.append_entry(
        "custom",
        json!({
            "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
            "data": {
                "active": true,
                "status": "active",
                "goalId": "goal-with-telemetry",
                "objective": "Keep the response fast",
                "tokensUsed": 0,
                "timeUsedSeconds": 0,
                "continuationsUsed": 0,
            },
        }),
    );
    store.rewrite().unwrap();
    let worker = Worker::new(
        WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "goal-telemetry".to_string(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: Some(true),
            script: Some(json!({ "engine": "faux", "responses": [{ "text": "unused" }] })),
        },
        None,
    );
    let created = worker
        .dispatch(
            "create",
            &json!({ "sessionPath": path.to_string_lossy(), "cwd": cwd }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let agent_engine = worker.agent_engine.as_ref().unwrap();
    let model = agent_engine.resolve_model().unwrap();
    agent_engine
        .ensure_core_session_async(&model)
        .await
        .unwrap();
    assert!(worker.dispatch("wait_for_idle", &json!({})).await.success);
    assert_eq!(worker.engine.goal_state_value()["status"], "active");
    assert_eq!(
        worker.engine.goal_state_value()["goalId"],
        "goal-with-telemetry"
    );

    let sink = std::sync::Arc::new(GoalControlGatedSink::default());
    let mut config = pa_telemetry::TelemetryClientConfig::new("test-install");
    config.batch_size = 1;
    config.flush_interval = std::time::Duration::from_secs(600);
    config.sinks = vec![sink.clone() as std::sync::Arc<dyn pa_telemetry::TelemetrySink>];
    let client = pa_telemetry::TelemetryClient::spawn(config).unwrap();
    let agent = {
        let built = agent_engine.session.lock().await;
        std::sync::Arc::clone(built.as_ref().unwrap().session.agent())
    };
    let wiring = pa_core::session_engine::telemetry::TelemetryWiring {
        client: client.clone(),
        execution_mode: Some("headless".to_string()),
        now: None,
        telemetry_enabled: None,
    };
    let telemetry = pa_core::session_engine::telemetry::install_session_telemetry(
        &agent,
        &wiring,
        None,
        std::sync::Arc::new(pa_core::session_engine::telemetry::SessionCounters::default()),
    )
    .await
    .unwrap();
    // The autonomous boundary holds a weak session reference in current
    // upstream. Drop it while installing the test sink, then restore the
    // mirror before exercising the real worker command path.
    let mut boundary = agent_engine
        .autonomous_boundary
        .lock()
        .unwrap()
        .take()
        .expect("the built session has an autonomous boundary");
    boundary.session = std::sync::Weak::new();
    {
        let mut built = agent_engine.session.lock().await;
        let built = built.as_mut().unwrap();
        {
            let session =
                std::sync::Arc::get_mut(built).expect("the idle core session has one strong owner");
            session.telemetry = Some(std::sync::Arc::new(telemetry));
        }
        boundary.session = std::sync::Arc::downgrade(built);
    }
    *agent_engine.autonomous_boundary.lock().unwrap() = Some(boundary);
    tokio::time::timeout(std::time::Duration::from_secs(2), sink.entered.notified())
        .await
        .expect("the telemetry batch entered the hanging sink");
    assert!(!sink.released.load(std::sync::atomic::Ordering::SeqCst));

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        worker.dispatch(
            "control_goal",
            &json!({
                "goalId": "goal-with-telemetry",
                "expectedObjective": "Keep the response fast",
                "action": "pause",
            }),
        ),
    )
    .await;
    let still_hanging = sink.delivered.lock().unwrap().is_empty();
    sink.released
        .store(true, std::sync::atomic::Ordering::SeqCst);
    sink.release.notify_one();
    let response = response.expect("goal control must not await the hanging sink");
    assert!(response.success, "control failed: {response:?}");
    assert!(
        still_hanging,
        "telemetry delivery finished before the response"
    );
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if sink
                .delivered
                .lock()
                .unwrap()
                .iter()
                .any(|name| name == "goal controlled")
            {
                break;
            }
            sink.delivered_notify.notified().await;
        }
    })
    .await
    .expect("the released sink receives the goal control event");
}
