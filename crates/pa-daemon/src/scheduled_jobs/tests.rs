//! The scheduled-jobs unit battery: the queue hooks, the fire/defer decision,
//! and the nine protocol arms' wire shapes.
use super::*;
use crate::worker::Worker;
use std::sync::Arc;

fn persisted_worker_config(dir: &std::path::Path) -> crate::worker::WorkerConfig {
    crate::worker::WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: std::path::PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "hb-fire-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(serde_json::json!({ "responses": ["ack", "ack", "ack", "ack"] })),
    }
}

/// The fire-chain e2e behind the dogfood P0 (a heartbeat created by
/// the kernel never fired): the kernel's `rlm_heartbeat.create` store
/// mutation plus the mutation hook the worker installs must re-arm the
/// bind-time (empty) scheduler, fire the job on schedule, deliver its
/// prompt onto the session's steer lane, and record the run.
/// An active rlm heartbeat job due to fire (`every 10s`, never run).
fn heartbeat_job(
    id: &str,
    prompt: &str,
    delivery_mode: DeliveryMode,
    session: &(String, std::path::PathBuf),
) -> AgentCronJob {
    AgentCronJob {
        id: id.to_string(),
        status: JobStatus::Active,
        source: Some("rlm_heartbeat".to_string()),
        runtime_kind: None,
        delivery_mode: Some(delivery_mode),
        active_session_id: session.0.clone(),
        session_id: session.0.clone(),
        session_file: session.1.to_string_lossy().to_string(),
        cwd: "/w".to_string(),
        label: None,
        prompt: prompt.to_string(),
        schedule: pa_core::cron::AgentCronSchedule {
            kind: pa_core::cron::ScheduleKind::Interval,
            expression: "every 10s".to_string(),
            interval_ms: Some(10_000),
        },
        created_at: "2026-09-22T00:00:00.000Z".to_string(),
        updated_at: "2026-09-22T00:00:00.000Z".to_string(),
        next_run_at: None,
        last_run_at: None,
        last_skipped_at: None,
        last_error: None,
        run_count: 0,
    }
}

/// A persisted, `active`-state session file the fire's target
/// verification (TS `isPersistedCronJobRunnable`) reads.
fn write_active_session(dir: &std::path::Path) -> (String, std::path::PathBuf) {
    let mut session = crate::session_store::SessionFile::create("/w", None, 0);
    session.append_message(&serde_json::json!({
        "role": "user", "content": "hi", "timestamp": 1u64
    }));
    let path = dir.join(crate::session_store::session_file_name(
        session.session_id(),
    ));
    session.set_path(path.clone());
    let _ = session.append_session_state("active");
    session.rewrite().unwrap();
    (session.session_id().to_string(), path)
}

/// The delivery-side verification (TS `isPersistedCronJobRunnable`):
/// a fire whose target was killed (state `archived`) cancels the
/// session's jobs and skips instead of reviving it, and the queue
/// lanes stay empty.
#[tokio::test]
async fn a_fire_at_a_killed_session_cancels_and_skips() {
    let dir = std::env::temp_dir().join(format!("pa-sched-dead-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let (session_id, session_file) = write_active_session(&dir);
    let store = AgentCronJobStore::for_session_artifacts();
    let artifact_dir = session_artifact_dir(&session_file, &session_id).unwrap();
    std::fs::create_dir_all(&artifact_dir).unwrap();
    store.register_session_artifact(&session_id, &artifact_dir);
    let job = store
        .create(&CreateAgentCronJobInput {
            active_session_id: session_id.clone(),
            session_id: session_id.clone(),
            session_file: session_file.to_string_lossy().to_string(),
            cwd: "/w".to_string(),
            prompt: "lane-liveness ping".to_string(),
            schedule_text: "every 10s".to_string(),
            now: Some(1),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(job.status, JobStatus::Active);

    // The session is killed: the close appended the `archived` state.
    let mut session = crate::session_store::SessionFile::open(&session_file).unwrap();
    let _ = session.append_session_state("archived");
    session.rewrite().unwrap();

    let core = Arc::new(std::sync::Mutex::new(
        crate::worker::SessionCore::test_core(None, "/w".to_string()),
    ));
    let hooks = QueueHooks {
        core: Arc::clone(&core),
        work_notify: Arc::new(Notify::new()),
        user_bash: Arc::new(crate::user_bash::UserBash::new()),
        store: Arc::new(AgentCronJobStore::for_session_artifacts()),
        recovery: Arc::new(std::sync::Mutex::new(None)),
    };
    // The dead-target cancel registers the artifact partition itself
    // (a fresh store knows nothing of the session yet).
    hooks
        .store
        .register_session_artifact(&session_id, &artifact_dir);

    let verdict = AgentCronSchedulerHooks::run_job(&hooks, &job)
        .await
        .unwrap();
    assert_eq!(verdict, Some("skipped"));
    let stored = hooks.store.list();
    let cancelled = stored
        .iter()
        .find(|candidate| candidate.id == job.id)
        .expect("the job stays in the store");
    assert_eq!(cancelled.status, JobStatus::Cancelled);
    assert_eq!(cancelled.next_run_at, None);
    let core = core.lock().unwrap();
    assert!(
        core.steering.is_empty() && core.follow_up.is_empty(),
        "no fire parks at a killed session"
    );
}

/// The fire's parked shape (TS `runCronJob` -> `promptHeartbeat`): a
/// heartbeat parks on its delivery-mode lane as the injected
/// `heartbeat_prompt` row with the TS preview — the queue strip reads
/// `Heartbeat prompt: <content>` (no lane label), while the turn text
/// and the active-action label keep the raw content — and a plain cron
/// job parks as a regular follow-up prompt.
#[tokio::test]
async fn heartbeat_fire_parks_the_labeled_preview_on_its_lane() {
    let dir = std::env::temp_dir().join(format!("pa-sched-fire-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let session = write_active_session(&dir);
    let core = Arc::new(std::sync::Mutex::new(
        crate::worker::SessionCore::test_core(None, "/w".to_string()),
    ));
    let hooks = Arc::new(QueueHooks {
        core: Arc::clone(&core),
        work_notify: Arc::new(Notify::new()),
        user_bash: Arc::new(crate::user_bash::UserBash::new()),
        store: Arc::new(AgentCronJobStore::for_session_artifacts()),
        recovery: Arc::new(std::sync::Mutex::new(None)),
    });
    let steer_heartbeat = heartbeat_job("hb-1", "steer the mission", DeliveryMode::Steer, &session);
    let follow_up_heartbeat = heartbeat_job(
        "hb-2",
        "wrap the mission up",
        DeliveryMode::FollowUp,
        &session,
    );
    let plain_cron = AgentCronJob {
        source: Some("cron".to_string()),
        ..heartbeat_job("cron-1", "nightly sweep", DeliveryMode::Steer, &session)
    };
    for job in [&steer_heartbeat, &follow_up_heartbeat, &plain_cron] {
        let hooks = Arc::clone(&hooks);
        let spawned_job = job.clone();
        let run = tokio::spawn(async move {
            pa_core::cron::scheduler::AgentCronSchedulerHooks::run_job(&*hooks, &spawned_job).await
        });
        // The spawned fire parks its item before its settle wait; the
        // runner is absent, so the item stays parked until this test
        // pops it (releasing the settle).
        let park_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let (lane, item) = loop {
            let popped = {
                let mut core = core.lock().unwrap();
                core.steering
                    .pop_front()
                    .map(|item| ("steering", item))
                    .or_else(|| core.follow_up.pop_front().map(|item| ("follow_up", item)))
            };
            if let Some(popped) = popped {
                break popped;
            }
            assert!(
                std::time::Instant::now() < park_deadline,
                "the fire for {} never parked",
                job.id
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        };
        let content = item.message.clone();
        if is_heartbeat_cron_job(job) {
            assert_eq!(
                content,
                format!("[heartbeat: every 10s run#0]\n\n{}", job.prompt)
            );
            assert_eq!(
                item.preview.as_deref(),
                Some(
                    format!(
                        "{}: {content}",
                        pa_core::session_engine::messages::HEARTBEAT_PROMPT_PREVIEW_LABEL
                    )
                    .as_str()
                ),
                "the parked row must carry the labeled preview"
            );
            assert_eq!(
                item.queue_key.as_deref(),
                Some(format!("heartbeat:{}", job.id).as_str())
            );
            assert_eq!(
                item.custom_message
                    .as_ref()
                    .and_then(|row| row.get("customType"))
                    .and_then(Value::as_str),
                Some(pa_core::session_engine::messages::HEARTBEAT_PROMPT_CUSTOM_TYPE)
            );
            assert_eq!(
                lane,
                if job.delivery_mode == Some(DeliveryMode::Steer) {
                    "steering"
                } else {
                    "follow_up"
                }
            );
        } else {
            assert_eq!(content, "nightly sweep");
            assert_eq!(item.preview, None);
            assert_eq!(item.custom_message, None);
            assert_eq!(item.queue_key, None);
            assert_eq!(lane, "follow_up");
        }
        drop(item);
        let outcome = run.await.unwrap().expect("run_job");
        assert_eq!(outcome, None);
    }
}

/// The failure propagation behind the backoff (dogfood incident: a
/// failing heartbeat re-fired ~120x at its full cadence): a turn that
/// settles with a real error surfaces it to the scheduler — still a
/// run, with the error riding it — instead of the old unconditional
/// success verdict; abort- and withdrawal-shaped settles classify as
/// a clean run and a skip respectively.
#[tokio::test]
async fn settles_classify_ran_failed_or_skipped() {
    // Park one fire, settle it with `settle`, and return the verdict.
    async fn settle_one(
        session: &(String, std::path::PathBuf),
        settle: crate::worker::TurnSettle,
    ) -> anyhow::Result<Option<&'static str>> {
        let core = Arc::new(std::sync::Mutex::new(
            crate::worker::SessionCore::test_core(None, "/w".to_string()),
        ));
        let hooks = Arc::new(QueueHooks {
            core: Arc::clone(&core),
            work_notify: Arc::new(Notify::new()),
            user_bash: Arc::new(crate::user_bash::UserBash::new()),
            store: Arc::new(AgentCronJobStore::for_session_artifacts()),
            recovery: Arc::new(std::sync::Mutex::new(None)),
        });
        let job = heartbeat_job("hb-1", "steer the mission", DeliveryMode::Steer, session);
        let hooks_for_run = Arc::clone(&hooks);
        let spawned_job = job.clone();
        let run = tokio::spawn(async move {
            pa_core::cron::scheduler::AgentCronSchedulerHooks::run_job(
                &*hooks_for_run,
                &spawned_job,
            )
            .await
        });
        let park_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let popped = {
                let mut core = core.lock().unwrap();
                core.steering
                    .pop_front()
                    .or_else(|| core.follow_up.pop_front())
            };
            if let Some(item) = popped {
                let done = item.done.expect("a fire settles through done");
                let _ = done.send(settle.clone());
                break;
            }
            assert!(std::time::Instant::now() < park_deadline, "never parked");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        run.await.expect("run task")
    }

    let dir = std::env::temp_dir().join(format!("pa-sched-fail-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let session = write_active_session(&dir);

    // A provider failure surfaces: the scheduler records it and backs
    // off (the incident's 404).
    let failure = "404 No endpoints found that support tool use.".to_string();
    let error = settle_one(&session, crate::worker::TurnSettle::Failed(failure.clone()))
        .await
        .expect_err("the failed settle surfaces");
    assert_eq!(error.to_string(), failure);
    // A provider failure whose text happens to equal the abort wire
    // text still fails (the typed settle never reads the text).
    let sneaky = settle_one(
        &session,
        crate::worker::TurnSettle::Failed(crate::worker::ABORTED_TURN_SETTLE_ERROR.to_string()),
    )
    .await
    .expect_err("provider text cannot masquerade as an abort");
    assert_eq!(sneaky.to_string(), crate::worker::ABORTED_TURN_SETTLE_ERROR);
    // An aborted turn is a clean run.
    assert_eq!(
        settle_one(&session, crate::worker::TurnSettle::Aborted)
            .await
            .expect("aborted turn"),
        None
    );
    // A withdrawn fire (queue edit delete, abort cancel) skips.
    assert_eq!(
        settle_one(
            &session,
            crate::worker::TurnSettle::Withdrawn(crate::worker::QUEUED_PROMPT_DELETED.to_string()),
        )
        .await
        .expect("withdrawn fire"),
        Some("skipped")
    );
    assert_eq!(
        settle_one(
            &session,
            crate::worker::TurnSettle::Withdrawn(
                crate::worker::PROMPT_ABORTED_BEFORE_DELIVERY.to_string(),
            ),
        )
        .await
        .expect("abort-cancelled fire"),
        Some("skipped")
    );
}

#[tokio::test]
async fn rlm_heartbeat_mutation_hook_fires_into_the_session_queue() {
    let dir = std::env::temp_dir().join(format!("pa-hb-fire-{}", uuid::Uuid::new_v4()));
    let sessions_dir = dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let worker = Arc::new(Worker::new(persisted_worker_config(&dir), None));
    let created = worker
        .dispatch(
            "create",
            &json!({
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
            }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");

    // The kernel host handler's store mutation (the same live binding
    // the engine's kernel cron wiring binds): `rlm_heartbeat.create`
    // through the shared session-artifacts store.
    let job = {
        let core = worker
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (binding, _) = live_binding(&core).expect("the created session is persisted");
        worker
            .scheduled
            .store()
            .create_rlm_heartbeat(&CreateAgentCronJobInput {
                active_session_id: binding.active_session_id,
                session_id: binding.session_id,
                session_file: binding.session_file,
                cwd: binding.cwd,
                source: Some("rlm_heartbeat".to_string()),
                prompt: "print hello world".to_string(),
                schedule_text: "every 10s".to_string(),
                delivery_mode: Some(DeliveryMode::Steer),
                ..Default::default()
            })
            .expect("rlm heartbeat create")
    };
    assert_eq!(job.status, JobStatus::Active);

    // The mutation hook the worker installs on the engine's kernel
    // cron wiring (the handler invokes it right after the store
    // mutation): withdraws dropped queued fires, then re-arms the
    // scheduler (TS `removeQueuedHeartbeatFollowUp` +
    // `cronScheduler.wake()`).
    let hook = worker.scheduled.mutation_hook();
    hook(
        pa_core::session_engine::host_requests::RlmHeartbeatMutation {
            job: job.clone(),
            drop_queued: false,
        },
    )
    .await;

    // The re-armed timer fires within the interval: the job's prompt
    // lands on the session's steer lane, the turn runs, and the store
    // records the run (`runCount` + `lastRunAt`).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
    loop {
        let recorded = worker
            .scheduled
            .store()
            .list()
            .into_iter()
            .find(|listed| listed.id == job.id);
        let Some(recorded) = recorded else {
            panic!("the created heartbeat vanished from the store");
        };
        if recorded.run_count >= 1 {
            assert!(recorded.last_run_at.is_some());
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the heartbeat never fired: {recorded:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    // The fired prompt ran as the session's turn and persisted as the
    // injected `heartbeat_prompt` custom row (TS `promptHeartbeat`):
    // the ◷ Heartbeat transcript component's wire shape, never a
    // plain user message.
    let fired_row = {
        let core = worker
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(store) = core.store.as_ref() else {
            panic!("the session store vanished");
        };
        store
            .entries()
            .iter()
            .find(|entry| {
                entry.fields.get("customType").and_then(Value::as_str)
                    == Some(pa_core::session_engine::messages::HEARTBEAT_PROMPT_CUSTOM_TYPE)
            })
            .map(|entry| entry.fields.clone())
    };
    let fired_row = fired_row.expect("the heartbeat fire never persisted its prompt row");
    let content = fired_row.get("content").and_then(Value::as_str).unwrap();
    // The claimed job snapshot carries the pre-increment run count.
    assert_eq!(content, "[heartbeat: every 10s run#0]\n\nprint hello world");
    let details = fired_row.get("details").cloned().unwrap_or(Value::Null);
    assert_eq!(details["jobId"], job.id);
    assert_eq!(details["schedule"], "every 10s");
    assert_eq!(details["status"], "active");
    assert_eq!(details["runCount"], 0);
}
