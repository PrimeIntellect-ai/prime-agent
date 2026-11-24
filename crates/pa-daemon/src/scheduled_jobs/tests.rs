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

/// The fire-chain e2e behind the dogfood P0 (a kernel-created heartbeat never
/// fired): the mutation hook re-arms the scheduler, fires the job, and records the run.
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
        work_notify: Arc::new(crate::worker::WorkNotify::new(Arc::default())),
        user_bash: Arc::new(crate::user_bash::UserBash::new()),
        store: Arc::new(AgentCronJobStore::for_session_artifacts()),
        recovery: Arc::new(std::sync::Mutex::new(None)),
        events: Arc::new(crate::worker::EventPump::new()),
        inbox_seam: Mutex::new(None),
    };
    // The dead-target cancel registers the artifact partition itself (a fresh store knows
    // nothing of the session yet).
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

/// A heartbeat parks as the injected `heartbeat_prompt` row with the TS preview (the
/// queue strip reads `Heartbeat prompt: <content>`, the turn text keeps the raw content).
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
        work_notify: Arc::new(crate::worker::WorkNotify::new(Arc::default())),
        user_bash: Arc::new(crate::user_bash::UserBash::new()),
        store: Arc::new(AgentCronJobStore::for_session_artifacts()),
        recovery: Arc::new(std::sync::Mutex::new(None)),
        events: Arc::new(crate::worker::EventPump::new()),
        inbox_seam: Mutex::new(None),
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
        // The spawned fire parks its item before its settle wait; the runner is absent,
        // so the item stays parked until this test pops it (releasing the settle).
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

/// The failure propagation behind the backoff (dogfood incident: a failing
/// heartbeat re-fired ~120x): a real error settles as a run, abort/withdrawal
/// as a clean run and a skip.
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
            work_notify: Arc::new(crate::worker::WorkNotify::new(Arc::default())),
            user_bash: Arc::new(crate::user_bash::UserBash::new()),
            store: Arc::new(AgentCronJobStore::for_session_artifacts()),
            recovery: Arc::new(std::sync::Mutex::new(None)),
            events: Arc::new(crate::worker::EventPump::new()),
            inbox_seam: Mutex::new(None),
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

    // A provider failure surfaces: the scheduler records it and backs off (the incident's
    // 404).
    let failure = "404 No endpoints found that support tool use.".to_string();
    let error = settle_one(&session, crate::worker::TurnSettle::Failed(failure.clone()))
        .await
        .expect_err("the failed settle surfaces");
    assert_eq!(error.to_string(), failure);
    // A provider failure whose text happens to equal the abort wire text still fails
    // (the typed settle never reads the text).
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

    // The kernel host handler's store mutation, the same live binding the
    // engine's kernel cron wiring binds: `rlm_heartbeat.create`.
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

    // The mutation hook the worker installs: withdraws dropped queued
    // fires, then re-arms the scheduler.
    let hook = worker.scheduled.mutation_hook();
    hook(
        pa_core::session_engine::host_requests::RlmHeartbeatMutation {
            job: job.clone(),
            drop_queued: false,
        },
    )
    .await;

    // The re-armed timer fires within the interval: the job's prompt lands on the steer
    // lane, the turn runs, and the store records the run (`runCount` + `lastRunAt`).
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
    // injected `heartbeat_prompt` custom row, never a plain user message.
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

/// A heartbeat stored in `store` and claimed the way the scheduler claims
/// a due job: the returned snapshot is what `run_job` receives.
fn claimed_heartbeat(
    store: &AgentCronJobStore,
    session: &(String, std::path::PathBuf),
    prompt: &str,
    delivery_mode: DeliveryMode,
) -> AgentCronJob {
    let artifact_dir = session_artifact_dir(&session.1, &session.0).unwrap();
    std::fs::create_dir_all(&artifact_dir).unwrap();
    store.register_session_artifact(&session.0, &artifact_dir);
    let job = store
        .create_rlm_heartbeat(&CreateAgentCronJobInput {
            active_session_id: session.0.clone(),
            session_id: session.0.clone(),
            session_file: session.1.to_string_lossy().to_string(),
            cwd: "/w".to_string(),
            prompt: prompt.to_string(),
            schedule_text: "every 10s".to_string(),
            delivery_mode: Some(delivery_mode),
            now: Some(1),
            ..Default::default()
        })
        .unwrap();
    store.claim_due(20_000, 20_000).unwrap();
    store
        .get_claimed_job(&job.id)
        .expect("the due job is claimed")
}

/// A heartbeat fire with the worker's inbox seam set routes its prompt
/// into the session's durable inbox (class `heartbeat`): ONE coalesced
/// wake row rides the delivery-mode lane instead of the full injected
/// delivery row, the fire counts as ran (the instruction is durable at
/// admission, so no turn-settle handshake), and a busy-window repeat
/// replaces the job's waiting fire with one built from the live job.
#[tokio::test]
async fn a_seam_set_heartbeat_fire_routes_into_the_inbox() {
    let dir = std::env::temp_dir().join(format!("pa-sched-inbox-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let session = write_active_session(&dir);
    let core = Arc::new(std::sync::Mutex::new(
        crate::worker::SessionCore::test_core(None, "/w".to_string()),
    ));
    // The faux engine stands in for the worker's live engine: the seam
    // only needs its store slot and settings gate.
    let (engine, engine_dir) = crate::agent_engine::tests::faux_engine_with_settings(
        &serde_json::json!({ "responses": ["ack"] }),
        0,
    );
    let inbox = Arc::new(pa_core::session_engine::inbox::SessionInbox::open(Some(
        engine_dir.path(),
    )));
    engine.set_inbox(Arc::clone(&inbox));
    let events = Arc::new(crate::worker::EventPump::new());
    let mut strip_updates = events.subscribe();
    let hooks = Arc::new(QueueHooks {
        core: Arc::clone(&core),
        work_notify: Arc::new(crate::worker::WorkNotify::new(Arc::default())),
        user_bash: Arc::new(crate::user_bash::UserBash::new()),
        store: Arc::new(AgentCronJobStore::for_session_artifacts()),
        recovery: Arc::new(std::sync::Mutex::new(None)),
        events,
        inbox_seam: Mutex::new(Some(InboxSeam {
            engine: Arc::downgrade(&engine),
            arrivals: pa_core::session_engine::inbox::InboxArrivals::default(),
            agent_dir: engine_dir.path().join("agent"),
        })),
    });

    // The steer heartbeat routes: one invisible wake row on the steering
    // lane, no full delivery row, and the verdict counts as ran.
    let steer = claimed_heartbeat(
        &hooks.store,
        &session,
        "steer the mission",
        DeliveryMode::Steer,
    );
    let verdict = AgentCronSchedulerHooks::run_job(&*hooks, &steer)
        .await
        .expect("the routed fire answers");
    assert_eq!(verdict, None, "a routed fire counts as ran");
    assert!(
        strip_updates.try_recv().is_ok(),
        "the admission refreshes the clients' queue strip"
    );
    {
        let core = core.lock().unwrap();
        let wake = core.steering.front().expect("the wake row queued");
        assert!(
            wake.message.contains("1 new message (heartbeat)"),
            "the wake counts the class: {}",
            wake.message
        );
        // The notice-rows layer sets the wake row's custom twin (the
        // attributed inbox_notice row); what must never park here is the
        // FULL heartbeat_prompt delivery row.
        assert!(
            wake.custom_message.as_ref().is_some_and(|row| {
                row.get("customType").and_then(serde_json::Value::as_str) == Some("inbox_notice")
            }),
            "the wake row carries its inbox-notice twin, never a full delivery row: {:?}",
            wake.custom_message
        );
        assert!(
            wake.done.is_none(),
            "the routed fire keeps no settle handshake"
        );
        assert!(core.follow_up.is_empty());
    }
    // A second fire inside the busy window, after a rewrite of the stored
    // prompt (the scheduler's snapshot still carries the old one), replaces
    // the job's waiting fire.
    core.lock().unwrap().busy = true;
    hooks
        .store
        .update_rlm_heartbeat(
            &session.0,
            &steer.id,
            &pa_core::cron::store::RlmHeartbeatUpdate {
                prompt: Some("steer the new mission".to_string()),
                ..Default::default()
            },
        )
        .unwrap()
        .expect("the rewrite lands");
    let verdict = AgentCronSchedulerHooks::run_job(&*hooks, &steer)
        .await
        .expect("the repeated fire answers");
    assert_eq!(verdict, None);
    {
        let mut core = core.lock().unwrap();
        let wake = core.steering.front().expect("the coalesced wake row");
        assert!(
            wake.message.contains("1 new message (heartbeat)"),
            "the wake row never counts the replaced fire: {}",
            wake.message
        );
        assert_eq!(core.steering.len(), 1, "never one row per fire");
        core.busy = false;
        core.steering.pop_front();
    }
    let (count, _, classes) = inbox.count();
    assert_eq!(count, 1, "one waiting fire per job");
    assert_eq!(classes["heartbeat"], 1);
    let messages = inbox.drain();
    assert_eq!(messages[0].sender.as_deref(), Some(steer.id.as_str()));
    assert!(messages[0].text.contains("[heartbeat: every 10s run#0]"));
    assert!(messages[0].text.contains("steer the new mission"));
    assert_eq!(messages[0].meta["jobId"], steer.id);

    // A follow-up heartbeat keeps its lane.
    let follow_up = claimed_heartbeat(&hooks.store, &session, "wrap up", DeliveryMode::FollowUp);
    let verdict = AgentCronSchedulerHooks::run_job(&*hooks, &follow_up)
        .await
        .expect("the follow-up fire answers");
    assert_eq!(verdict, None);
    let core = core.lock().unwrap();
    assert!(core.steering.is_empty());
    let wake = core
        .follow_up
        .front()
        .expect("the follow-up wake row queued");
    assert!(wake.message.contains("1 new message (heartbeat)"));
    // The notice-rows layer's twin rides the wake row; the full
    // heartbeat_prompt delivery row must never park here.
    assert!(
        wake.custom_message.as_ref().is_some_and(|row| {
            row.get("customType").and_then(serde_json::Value::as_str) == Some("inbox_notice")
        }),
        "the follow-up wake carries its inbox-notice twin: {:?}",
        wake.custom_message
    );
}

/// A dropped queued fire withdraws its inbox-routed message too: the
/// pause/stop/delete/rewrite mutations must not leave a durable prompt
/// (or its coalesced wake row) for a job that no longer runs — the
/// inbox route never takes the `heartbeat:{id}` queue key, so the
/// direct-lane retain alone misses it. Mutation: skipping the inbox
/// withdrawal leaves the heartbeat message waiting and its wake row
/// queued — both pins go red. A fire carrying the pre-mutation snapshot
/// that lands after the withdrawal reads the live job and parks nothing.
#[tokio::test]
async fn a_dropped_queued_fire_withdraws_its_inbox_message_and_wake_row() {
    let dir = std::env::temp_dir().join(format!("pa-sched-drop-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let session = write_active_session(&dir);
    let core = Arc::new(std::sync::Mutex::new(
        crate::worker::SessionCore::test_core(None, "/w".to_string()),
    ));
    // The faux engine stands in for the worker's live engine: the seam
    // only needs its store slot and settings gate.
    let (engine, engine_dir) = crate::agent_engine::tests::faux_engine_with_settings(
        &serde_json::json!({ "responses": ["ack"] }),
        0,
    );
    let inbox = Arc::new(pa_core::session_engine::inbox::SessionInbox::open(Some(
        engine_dir.path(),
    )));
    engine.set_inbox(Arc::clone(&inbox));
    let scheduled = Arc::new(ScheduledJobs::new(
        Arc::clone(&core),
        Arc::new(crate::worker::WorkNotify::new(Arc::default())),
        Arc::new(crate::user_bash::UserBash::new()),
        Arc::new(crate::worker::EventPump::new()),
        Arc::new(std::sync::Mutex::new(None)),
    ));
    scheduled.set_inbox_seam(
        std::sync::Arc::downgrade(&engine),
        pa_core::session_engine::inbox::InboxArrivals::default(),
        engine_dir.path().join("agent"),
    );
    // The fire routes into the inbox: the durable heartbeat message and
    // its coalesced wake row (the busy window parks the row).
    let job = claimed_heartbeat(
        scheduled.store(),
        &session,
        "steer the mission",
        DeliveryMode::Steer,
    );
    core.lock().unwrap().busy = true;
    let verdict = AgentCronSchedulerHooks::run_job(&*scheduled.hooks, &job)
        .await
        .expect("the routed fire answers");
    assert_eq!(verdict, None, "a routed fire counts as ran");
    assert_eq!(inbox.count().0, 1, "the fire's message waits in the store");
    assert!(
        !core.lock().unwrap().steering.is_empty(),
        "the coalesced wake row queued"
    );
    // The pause writes the store, then drops the queued fire.
    scheduled
        .store()
        .manage_heartbeat(
            &session.0,
            &job.id,
            HeartbeatManagementAction::Pause,
            30_000,
        )
        .unwrap()
        .expect("the pause lands");
    scheduled.remove_queued_heartbeat_follow_up(&job);
    assert_eq!(
        inbox.count().0,
        0,
        "the dropped fire's message leaves the store"
    );
    {
        let core = core.lock().unwrap();
        assert!(
            core.steering.is_empty() && core.follow_up.is_empty(),
            "no wake row survives the dropped fire: {:?} {:?}",
            core.steering
                .iter()
                .map(|item| item.queue_key.clone())
                .collect::<Vec<_>>(),
            core.follow_up
                .iter()
                .map(|item| item.queue_key.clone())
                .collect::<Vec<_>>()
        );
    }
    // The scheduler's pre-pause snapshot fires after the withdrawal.
    let verdict = AgentCronSchedulerHooks::run_job(&*scheduled.hooks, &job)
        .await
        .expect("the stale fire answers");
    assert_eq!(verdict, Some("skipped"));
    assert_eq!(inbox.count().0, 0, "nothing waits for the paused job");
    let core = core.lock().unwrap();
    assert!(
        core.steering.is_empty() && core.follow_up.is_empty(),
        "no wake row or direct row for the paused job"
    );
}

/// The heartbeat withdrawal is identity-checked like the durable push: a
/// retired or replaced slot refuses it and the captured store keeps its
/// waiting fire (the replacement's replay, not a journal record racing
/// its reopen, decides what survives).
#[tokio::test]
async fn a_retired_slot_refuses_the_heartbeat_withdrawal() {
    let dir = std::env::temp_dir().join(format!("pa-sched-retire-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let session = write_active_session(&dir);
    let (engine, engine_dir) = crate::agent_engine::tests::faux_engine_with_settings(
        &serde_json::json!({ "responses": ["ack"] }),
        0,
    );
    let inbox = Arc::new(pa_core::session_engine::inbox::SessionInbox::open(Some(
        engine_dir.path(),
    )));
    engine.set_inbox(Arc::clone(&inbox));
    let job = heartbeat_job("hb-1", "steer the mission", DeliveryMode::Steer, &session);
    let row = pa_core::session_engine::messages::create_heartbeat_prompt_message(&job, 1);
    let fields = pa_core::session_engine::inbox::heartbeat_notice_fields(&job.id, &row).unwrap();
    inbox.push(fields, 1);

    engine.clear_inbox();
    assert!(engine
        .withdraw_heartbeat_from_live_inbox(&inbox, &job.id)
        .is_none());
    let replacement = Arc::new(pa_core::session_engine::inbox::SessionInbox::open(Some(
        &dir.join("replacement"),
    )));
    engine.set_inbox(replacement);
    assert!(engine
        .withdraw_heartbeat_from_live_inbox(&inbox, &job.id)
        .is_none());
    assert_eq!(inbox.count().0, 1, "the retired store stayed untouched");
}
