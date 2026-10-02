//! Goal continuation and compact-mint e2e tests (moved with their concerns).
use super::*;

/// A scripted goal session's dispatch worker (the goal section feeds
/// `goal_state_value` and the post-compaction mint).
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

/// TS `compact()`'s `didCompact` + active-goal branch: a successful
/// compact on a session with an active goal mints the owed goal
/// continuation (`resumeQueuedWork()`'s
/// `_maybeResumeGoalContinuationAfterRlmWork` — the minted follow-up
/// with the goal-context row), clears the queued-input suspension, and
/// the scheduled continue drives the turn: the continuation runs
/// (agent rows on the wire), the queue drains, and the session is
/// admitted for plain prompts again (the resume site crossed the #234
/// suspension gate).
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
    // The mint's `goal_update` surfaces at the moment the state
    // changed, then the continuation turn: the goal-context custom row
    // plus its model turn (the scripted engine's rows).
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

/// Queued work parked at compact time owns the continue (TS's `||=`
/// sets the owed-continuation flag only when the agent has NO queued
/// messages): no fresh goal continuation is minted, the resume site
/// releases the parked work, and the parked turn runs instead.
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
    // The parked item's turn ran (its user row), not a minted
    // continuation (no goal_context row, no goal_update).
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

/// Only an ACTIVE goal schedules the continue (TS checks
/// `this._goalState.status === "active"`): a paused goal leaves the
/// post-compact suspension set and mints nothing.
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
                    { "type": "toolCall", "name": "ipython",
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
    // Each minted continuation ran as a queued follow-up turn: the
    // start row plus two continuation rows (the completion turn is the
    // second continuation's turn).
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
    // The model turns all settled: the start turn, two continuation
    // turns, and the completing tool-call turn's own assistant
    // segments ride the wire as assistant rows.
    let assistant_rows = events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_end")
                && event["message"]["role"] == "assistant"
        })
        .count();
    assert!(assistant_rows >= 4, "events: {events:?}");
    // The goal state settled complete (the kernel completion through
    // the worker's host handlers), with the loop's counts on the books.
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
    // The completion's boundary mints nothing: the queue is empty and
    // a plain prompt is admitted again.
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

/// The pause withdraws the queued minted continuation (TS
/// `_pauseGoal` -> `_clearQueuedGoalContexts`): a prompt arriving right
/// after the goal start runs within a turn or two of the loop, the
/// pause purges the queued goal-context turn, and the loop goes quiet
/// (the f18 battery's pause pattern).
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
    // A settled paused goal consumed at most the start turn and one
    // continuation turn's worth of slots.
    assert!(
        goal["continuationsUsed"].as_u64().unwrap_or(0) <= 2,
        "the pause never withdrew the loop: {goal}"
    );
}

/// A scripted goal session's dispatch worker with a durable session
/// file (the `noSession` create keeps everything in memory; this
/// variant lands the store on disk so the `thread_goal_state` mirror
/// is observable).
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

/// A goal-state change announced mid-turn (TS `_setGoalState` ->
/// `_emitGoalUpdate`) mirrors into the worker session file as a
/// `thread_goal_state` custom row: the engine's in-memory branch is
/// not the durable store, so the mirror is what a recovery rebuild
/// replays.
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

/// The post-compaction mint's state change (the compact branch runs
/// outside a turn) persists its `thread_goal_state` row before the
/// `goal_update` announcement, so the continuation count survives a
/// worker crash mid-goal.
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
