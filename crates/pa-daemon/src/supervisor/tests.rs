use super::*;

/// The crash-path failure count: spawn-dies-fast churn accumulates to
/// the give-up cap (the storm's counter could never grow while
/// relaunch-spawns kept resetting it); a child that lived past the
/// stable window was healthy, so its death starts a fresh count.
#[test]
fn churn_accumulates_and_a_stable_lifetime_resets() {
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
        "version": 2,
        "workerId": "test-worker",
        "pid": 0,
        "socketPath": "/tmp/none.sock",
        "recoveryJournalPath": "/tmp/none.jsonl",
        "supervisorSocketPath": "/tmp/none.sock",
        "authenticationToken": "test",
        "rootActiveSessionId": "none",
        "createdAt": "2026-09-23T00:00:00Z",
        "updatedAt": "2026-09-23T00:00:00Z",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let resident = ResidentWorker::new(
        "test-worker".to_string(),
        descriptor,
        std::path::PathBuf::from("/tmp/none"),
    );
    let now = 1_000_000_000u64;
    // No spawn time (an adopted pid): plain accumulation.
    assert_eq!(Supervisor::next_failure_count(&resident, now), 1);
    assert_eq!(Supervisor::next_failure_count(&resident, now), 2);
    // A stable lifetime: the healthy death starts a fresh count.
    resident
        .spawned_at_ms
        .store(now - STABLE_LIFETIME_MS - 1, Ordering::SeqCst);
    assert_eq!(Supervisor::next_failure_count(&resident, now), 1);
    // A spawn that lived past the stable window but died young still accumulates.
    resident
        .spawned_at_ms
        .store(now - STABLE_LIFETIME_MS + 10_000, Ordering::SeqCst);
    assert_eq!(Supervisor::next_failure_count(&resident, now), 2);
}

/// A relaunch that FAILS produced no worker, so the count must
/// accumulate to the give-up cap instead of resetting against the old spawn.
#[tokio::test(start_paused = true)]
async fn a_failed_relaunch_accumulates_to_the_give_up_cap() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    // The relaunch fails deterministically: the logs dir cannot be created
    // (a file stands where it would go), so every spawn dies at the worker
    // stderr log's open.
    std::fs::write(agent_dir.join("logs"), "not a directory").unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
        "version": 2,
        "workerId": "w-relaunch",
        "pid": 0,
        "socketPath": "/tmp/none.sock",
        "recoveryJournalPath": dir.path().join("journal.jsonl").to_string_lossy(),
        "supervisorSocketPath": "/tmp/none.sock",
        "authenticationToken": "token",
        "rootActiveSessionId": "w-relaunch",
        "createdAt": "t",
        "updatedAt": "t",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let resident = Arc::new(ResidentWorker::new(
        "w-relaunch".to_string(),
        descriptor,
        dir.path().join("w-relaunch.descriptor.json"),
    ));
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("the clock is after the epoch")
        .as_millis() as u64;
    resident
        .spawned_at_ms
        .store(now_ms - STABLE_LIFETIME_MS - 1, Ordering::SeqCst);
    supervisor.registry.insert(Arc::clone(&resident)).await;
    tokio::time::timeout(
        Duration::from_secs(60),
        Arc::clone(&supervisor).watch_worker(Arc::clone(&resident), None, 0),
    )
    .await
    .expect("the watch loop gives up instead of spinning");
    assert!(
        supervisor.registry.get("w-relaunch").await.is_none(),
        "the give-up removes the worker from the registry"
    );
    assert_eq!(
        resident.descriptor.lock().await.lifecycle,
        DaemonWorkerLifecycle::Failed
    );
}

/// A stop that lands while the watch loop is on the give-up cap leaves
/// the terminal state to the stop: the give-up arm returns without
/// persisting `Failed` (the stop's tombstone already owns the next boot's
/// verdict) and without removing the resident (the stop path owns the
/// removal), so a cleanly stopped worker is not adopted as `GaveUp`.
#[tokio::test(start_paused = true)]
async fn a_stop_during_the_storm_leaves_the_terminal_state_to_the_stop() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(agent_dir.join("logs"), "not a directory").unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
        "version": 2,
        "workerId": "w-storm-stop",
        "pid": 0,
        "socketPath": "/tmp/none.sock",
        "recoveryJournalPath": dir.path().join("journal.jsonl").to_string_lossy(),
        "supervisorSocketPath": "/tmp/none.sock",
        "authenticationToken": "token",
        "rootActiveSessionId": "w-storm-stop",
        "createdAt": "t",
        "updatedAt": "t",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let resident = Arc::new(ResidentWorker::new(
        "w-storm-stop".to_string(),
        descriptor,
        dir.path().join("w-storm-stop.descriptor.json"),
    ));
    // The storm is at the cap and the stop already landed (the stop
    // path sets the flag before it finalizes the worker).
    resident
        .consecutive_failures
        .store(MAX_CONSECUTIVE_FAILURES, Ordering::SeqCst);
    resident.intentional_stop.store(true, Ordering::SeqCst);
    supervisor.registry.insert(Arc::clone(&resident)).await;
    tokio::time::timeout(
        Duration::from_secs(60),
        Arc::clone(&supervisor).watch_worker(Arc::clone(&resident), None, 0),
    )
    .await
    .expect("the give-up arm returns instead of spinning");
    assert_eq!(
        resident.descriptor.lock().await.lifecycle,
        DaemonWorkerLifecycle::Ready,
        "the give-up must not persist Failed over a concurrent stop"
    );
    assert!(
        supervisor.registry.get("w-storm-stop").await.is_some(),
        "the stop path owns the worker's removal"
    );
}

/// The saved-session surfaces (the `list --all` summary row and the
/// `list_saved_sessions` catalog row) carry the persisted thinking
/// level: the agents-view Model column renders "model:level" for
/// sessions without a live worker, top-level and subagent alike.
/// TS #2506's `serializeSavedSessionInfo`: the listing arm's bucket
/// attach publishes `deletedDescendantUsage` on the saved row - the
/// agents-view recursive rollup's deleted-descendant term. Absent
/// rows (no tombstoned descendants) carry no field, matching the
/// optional wire shape.
#[test]
fn saved_session_rows_publish_deleted_descendant_usage() {
    let dir = std::env::temp_dir().join(format!("pa-saved-dd-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
    let path = dir.join(format!("{}.jsonl", session.session_id()));
    session.set_path(path.clone());
    session.rewrite().unwrap();
    let mut info = crate::session_store::read_session_info(&path).unwrap();
    assert!(
        info.deleted_descendant_usage.is_none(),
        "the file scan never sets the ledger-derived field"
    );
    info.deleted_descendant_usage = Some(crate::session_usage::SessionUsageSummary {
        input_tokens: 1_100,
        output_tokens: 110,
        cost: 0.5,
    });
    let row = saved_session_row(&info);
    assert_eq!(
        row["deletedDescendantUsage"],
        json!({ "inputTokens": 1_100, "outputTokens": 110, "cost": 0.5 })
    );
    // Absent again: the field never rides as a null.
    info.deleted_descendant_usage = None;
    let row = saved_session_row(&info);
    assert!(row.get("deletedDescendantUsage").is_none());
}

#[test]
fn saved_session_rows_carry_the_persisted_thinking_level() {
    let dir = std::env::temp_dir().join(format!("pa-saved-tl-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
    let path = dir.join(format!("{}.jsonl", session.session_id()));
    session.set_path(path.clone());
    session.append_model_change("p", "m");
    session.append_thinking_level_change("high");
    session.append_message(&json!({"role": "user", "content": "hi", "timestamp": 1u64}));
    session.rewrite().unwrap();
    let info = crate::session_store::read_session_info(&path).unwrap();
    assert_eq!(info.thinking_level.as_deref(), Some("high"));
    let summary = saved_session_summary(&info);
    assert_eq!(summary["thinkingLevel"], json!("high"));
    assert!(summary["model"].is_null(), "saved rows carry no model");
    let row = saved_session_row(&info);
    assert_eq!(row["thinkingLevel"], json!("high"));
    assert_eq!(row["model"], json!({ "provider": "p", "modelId": "m" }));
    // A session file without a persisted level stays bare (a fresh
    // draft, or a model that cannot think).
    let mut draft = crate::session_store::SessionFile::create("/tmp", None, 0);
    let draft_path = dir.join(format!("{}.jsonl", draft.session_id()));
    draft.set_path(draft_path.clone());
    draft.rewrite().unwrap();
    let draft_info = crate::session_store::read_session_info(&draft_path).unwrap();
    assert_eq!(draft_info.thinking_level, None);
    assert!(saved_session_summary(&draft_info)
        .get("thinkingLevel")
        .is_none());
    assert!(saved_session_row(&draft_info)
        .get("thinkingLevel")
        .is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

/// The saved-session surfaces publish the scan's own-usage summary (TS
/// `serializeSavedSessionInfo` and `summaryForInactiveSession`): the
/// agents-view spend columns and the archived-row keep-condition read
/// `usage.cost`; a session with no billable work stays bare, exactly
/// like TS's undefined serialization.
#[test]
fn saved_session_rows_publish_the_own_usage_summary() {
    let dir = std::env::temp_dir().join(format!("pa-saved-usage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
    let path = dir.join(format!("{}.jsonl", session.session_id()));
    session.set_path(path.clone());
    session.append_message(&json!({
        "role": "assistant", "content": "done", "provider": "p", "model": "m",
        "timestamp": 1u64,
        "usage": {
            "input": 100, "output": 10, "cacheRead": 5, "cacheWrite": 0,
            "totalTokens": 115,
            "cost": { "input": 0.0, "output": 0.25, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.25 }
        }
    }));
    session.rewrite().unwrap();
    let info = crate::session_store::read_session_info(&path).unwrap();
    let row = saved_session_row(&info);
    assert_eq!(
        row["usage"],
        json!({ "inputTokens": 105, "outputTokens": 10, "cost": 0.25 })
    );
    let summary = saved_session_summary(&info);
    assert_eq!(
        summary["usage"],
        json!({ "inputTokens": 105, "outputTokens": 10, "cost": 0.25 })
    );
    // A draft with no billable work stays bare on both surfaces.
    let mut draft = crate::session_store::SessionFile::create("/tmp", None, 0);
    let draft_path = dir.join(format!("{}.jsonl", draft.session_id()));
    draft.set_path(draft_path.clone());
    draft.rewrite().unwrap();
    let draft_info = crate::session_store::read_session_info(&draft_path).unwrap();
    assert!(saved_session_row(&draft_info).get("usage").is_none());
    assert!(saved_session_summary(&draft_info).get("usage").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

/// TS `summaryForInactiveSession` publishes the header binding: a saved
/// row carries its `parentSessionPath` (only when one is recorded — TS's
/// `undefined` is omitted) and its `rlmDepth`, so a non-resident bound
/// session keeps its family edge for the family classifiers.
#[test]
fn saved_session_summaries_carry_the_parent_binding() {
    let dir = std::env::temp_dir().join(format!("pa-saved-binding-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut bound = crate::session_store::SessionFile::create("/tmp", Some("/s/p.jsonl"), 1);
    let bound_path = dir.join(format!("{}.jsonl", bound.session_id()));
    bound.set_path(bound_path.clone());
    bound.append_message(&json!({"role": "user", "content": "hi", "timestamp": 1u64}));
    bound.rewrite().unwrap();
    let bound_info = crate::session_store::read_session_info(&bound_path).unwrap();
    let summary = saved_session_summary(&bound_info);
    assert_eq!(
        (summary.get("parentSessionPath"), summary.get("rlmDepth")),
        (Some(&json!("/s/p.jsonl")), Some(&json!(1)))
    );

    let mut root = crate::session_store::SessionFile::create("/tmp", None, 0);
    let root_path = dir.join(format!("{}.jsonl", root.session_id()));
    root.set_path(root_path.clone());
    root.append_message(&json!({"role": "user", "content": "hi", "timestamp": 1u64}));
    root.rewrite().unwrap();
    let root_info = crate::session_store::read_session_info(&root_path).unwrap();
    let summary = saved_session_summary(&root_info);
    assert_eq!(
        (summary.get("parentSessionPath"), summary.get("rlmDepth")),
        (None, Some(&json!(0)))
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn worker_probe_fails_at_the_deadline_and_names_the_worker() {
    let dir = std::env::temp_dir().join(format!("pa-probe-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("never.sock");
    let expired = tokio::time::Instant::now() - Duration::from_millis(1);
    let error = probe_worker_socket("worker-abc", &socket, expired)
        .await
        .expect_err("expired budget errors");
    assert_eq!(
        error.to_string(),
        "session worker worker-abc did not come up in time"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn worker_probe_accepts_a_live_socket() {
    let dir = std::env::temp_dir().join(format!("pa-probe-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("live.sock");
    let listener = pa_types::platform::transport::bind_transport(&socket)
        .await
        .unwrap();
    let deadline = worker_connect_deadline();
    probe_worker_socket("worker-abc", &socket, deadline)
        .await
        .expect("a live worker socket satisfies the probe");
    let _ = std::fs::remove_file(&socket);
    drop(listener);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The boot roster seed runs exactly once, in the background, once
/// adoption settles: the adoption pass hands back the seed task's
/// handle, and the seed roots are the registry's residents. An empty
/// descriptor dir adopts nothing; the pre-registered root anchors the
/// family the seed must publish.
#[tokio::test]
async fn adoption_settles_then_seeds_the_roster_once() {
    let dir = std::env::temp_dir().join(format!("pa-adopt-seed-{}", uuid::Uuid::new_v4()));
    let agent_dir = dir.join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let root_file = sessions_dir.join("root-1.jsonl");
    let child_file = sessions_dir.join("sub-9.jsonl");
    for path in [&root_file, &child_file] {
        std::fs::write(
            path,
            "{\"type\":\"session\",\"version\":3,\"id\":\"persisted-id\",\"timestamp\":\"t\",\"cwd\":\"/the/real/cwd\"}\n{\"type\":\"model_change\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":\"t\",\"provider\":\"p\",\"modelId\":\"m\"}\n{\"type\":\"thinking_level_change\",\"id\":\"t1\",\"parentId\":\"m1\",\"timestamp\":\"t\",\"thinkingLevel\":\"high\"}\n",
        )
        .unwrap();
    }
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .unwrap(),
    );
    let ledger = crate::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
    ledger
        .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
            child_id: "sub-9".to_string(),
            parent: root_file.to_string_lossy().to_string(),
            child: child_file.to_string_lossy().to_string(),
            depth: 1,
            name: "lane".to_string(),
        })
        .unwrap();
    let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
        version: 1,
        worker_id: "w-root".to_string(),
        pid: 4242,
        process_start_id: None,
        socket_path: "/tmp/none.sock".to_string(),
        recovery_journal_path: "/tmp/none.jsonl".to_string(),
        orphan_process_journal_path: None,
        supervisor_socket_path: "/tmp/none.sock".to_string(),
        authentication_token: "root-token".to_string(),
        worker_instance_id: None,
        root_active_session_id: "w-root".to_string(),
        owner_client_id: None,
        root_session_id: None,
        session_file: Some(root_file.to_string_lossy().to_string()),
        session_dir: Some(sessions_dir.to_string_lossy().to_string()),
        telemetry_disabled: Some(true),
        created_at: "t".to_string(),
        updated_at: "t".to_string(),
        lifecycle: DaemonWorkerLifecycle::Ready,
        create_command: pa_types::daemon::DurableDaemonCreateCommand {
            session_path: None,
            no_session: None,
            rest: Map::default(),
        },
        consecutive_failures: 0,
        stop_requested_at: None,
        archive_on_stop: None,
        last_failure_at: None,
        last_error: None,
        rest: Map::default(),
    };
    supervisor
        .registry
        .insert(ResidentWorker::new(
            "w-root".to_string(),
            descriptor,
            root_file.with_extension("descriptor.json"),
        ))
        .await;

    // Adoption adopts nothing (the descriptor dir is empty) and hands
    // back the boot seed task; the seed publishes the anchored family.
    supervisor
        .adopt_persisted_workers(AdoptionBoot::PlainStartup)
        .await;
    crate::supervisor_roster_seed::tests::drain_pending_seeds_for_tests(&supervisor).await;
    let row = supervisor
        .roster
        .lock()
        .unwrap()
        .entries()
        .into_iter()
        .find(|entry| entry.summary.get("rlmChildId").and_then(Value::as_str) == Some("sub-9"))
        .expect("the boot seed hydrated the family");
    assert_eq!(row.summary["cwd"], "/the/real/cwd");
    assert_eq!(
        row.summary["model"],
        json!({ "provider": "p", "modelId": "m" })
    );
    assert_eq!(row.summary["thinkingLevel"], json!("high"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// The shutdown gate: a create dispatched while the supervisor stops
/// must fail instead of launching a worker the stop pass would miss
/// (a late create racing a shutdown would orphan its worker process).
#[tokio::test]
async fn a_create_while_shutting_down_is_refused() {
    let dir = tempfile::TempDir::new().unwrap();
    let options = SupervisorOptions {
        socket_path: dir.path().join("daemon.sock"),
        agent_dir: dir.path().join("agent"),
    };
    let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
    supervisor.shutting_down.store(true, Ordering::SeqCst);
    let create = DaemonCommand::Create {
        id: None,
        session_path: None,
        continue_recent: None,
        no_session: None,
        name: None,
        config: None,
        telemetry_disabled: None,
        runtime_metadata: None,
        lifecycle: None,
        env: None,
        launch_env: None,
        rest: Map::default(),
    };
    let refused = supervisor
        .launch_worker(&create, None)
        .await
        .err()
        .expect("the shutting-down supervisor accepted a create");
    assert_eq!(
        refused.to_string(),
        "Supervisor is shutting down",
        "the refusal error: {refused:#}"
    );
}

/// The shutdown gate and the accept loop's exit flag are separate: the
/// gate refuses creates the moment a terminal stop begins, but the
/// loop must stay up until `begin_shutdown` finishes stopping the workers.
#[tokio::test]
async fn begin_shutdown_sets_the_accept_exit_after_the_stop_pass() {
    let dir = tempfile::TempDir::new().unwrap();
    let options = SupervisorOptions {
        socket_path: dir.path().join("daemon.sock"),
        agent_dir: dir.path().join("agent"),
    };
    let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
    supervisor.shutting_down.store(true, Ordering::SeqCst);
    assert!(
        !supervisor.accept_exit.load(Ordering::SeqCst),
        "the gate alone must not exit the accept loop"
    );
    supervisor.begin_shutdown().await;
    assert!(
        supervisor.accept_exit.load(Ordering::SeqCst),
        "the completed stop pass must exit the accept loop"
    );
}

/// A kill whose stop never durably started — the stop tombstone's
/// persist fails, the only `Err` `stop_worker` takes — must not run
/// the kill's belt: the worker is untouched and the kill stays
/// retryable (TS `stopWorkerUntracked` throws before any teardown).
/// The belt otherwise cancels the session tree's jobs, archives the
/// root file, and — for a ledger delete — sweeps the child's
/// artifacts against a live worker whose resident still serves the
/// file (its stores may still grow).
#[tokio::test]
async fn a_failed_stop_persist_gates_the_kill_stop_belt() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let session_file = sessions_dir.join("live-1.jsonl");
    std::fs::write(
        &session_file,
        "{\"type\":\"session\",\"version\":3,\"id\":\"live-1\",\"timestamp\":\"t\",\"cwd\":\"/c\"}\n",
    )
    .unwrap();
    // The live child's artifact partition: a ledger delete's belt
    // would sweep it; the gated belt must leave it in place.
    let artifacts = agent_dir.join("session-artifacts").join("live-1");
    std::fs::create_dir_all(&artifacts).unwrap();
    std::fs::write(artifacts.join("scheduled-jobs.json"), "{}").unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
        version: 1,
        worker_id: "w-live".to_string(),
        pid: 4242,
        process_start_id: None,
        socket_path: "/tmp/none.sock".to_string(),
        recovery_journal_path: "/tmp/none.jsonl".to_string(),
        orphan_process_journal_path: None,
        supervisor_socket_path: "/tmp/none.sock".to_string(),
        authentication_token: "token".to_string(),
        worker_instance_id: None,
        root_active_session_id: "w-live".to_string(),
        owner_client_id: None,
        root_session_id: Some("live-1".to_string()),
        session_file: Some(session_file.to_string_lossy().to_string()),
        session_dir: Some(sessions_dir.to_string_lossy().to_string()),
        telemetry_disabled: None,
        created_at: "t".to_string(),
        updated_at: "t".to_string(),
        lifecycle: DaemonWorkerLifecycle::Ready,
        create_command: pa_types::daemon::DurableDaemonCreateCommand {
            session_path: None,
            no_session: None,
            rest: Map::default(),
        },
        consecutive_failures: 0,
        stop_requested_at: None,
        archive_on_stop: None,
        last_failure_at: None,
        last_error: None,
        rest: Map::default(),
    };
    // The persist target is a directory: the stop tombstone's
    // atomic write cannot land there (the rename onto a directory
    // fails), so the stop never durably starts.
    let persist_target = sessions_dir.join("w.d");
    std::fs::create_dir(&persist_target).unwrap();
    let resident = ResidentWorker::new("w-live".to_string(), descriptor, persist_target);
    supervisor.registry.insert(resident.clone()).await;

    // A ledger-delete kill (delete_subagent's shape: the rest carries
    // the marker, so the plain-kill path owns it).
    let rest = Map::from_iter([
        ("rlmLedgerDelete".to_string(), json!("user")),
        ("rlmChildId".to_string(), json!("child-1")),
    ]);
    supervisor.finish_plain_kill_stop(&resident, &rest).await;

    // The stop never started: the resident stays owned (retryable)
    // and the live child's artifacts survive the belt.
    assert!(
        supervisor.registry.get("w-live").await.is_some(),
        "the stop never durably started, so the worker stays owned"
    );
    assert!(
        artifacts.join("scheduled-jobs.json").is_file(),
        "a belt gated behind a failed stop must not sweep a live child's artifacts"
    );
}

/// A plain kill holds the route-side tombstone when its stop's
/// redundant re-write fails: the durable intent is already on disk,
/// so the stop proceeds (the escalation runs, the registry row goes,
/// the stop is intentional) instead of aborting and leaving the
/// killed worker running on its session lease until the next boot —
/// the finding-#5 symptom. The belt gate stays keyed on the stop
/// that never durably started: no tombstone at all still fails.
#[tokio::test]
async fn an_existing_tombstone_carries_the_stop_past_its_failed_re_write() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
        version: 1,
        worker_id: "w-live".to_string(),
        pid: 4242,
        process_start_id: None,
        socket_path: "/tmp/none.sock".to_string(),
        recovery_journal_path: "/tmp/none.jsonl".to_string(),
        orphan_process_journal_path: None,
        supervisor_socket_path: "/tmp/none.sock".to_string(),
        authentication_token: "token".to_string(),
        worker_instance_id: None,
        root_active_session_id: "w-live".to_string(),
        owner_client_id: None,
        root_session_id: Some("live-1".to_string()),
        session_file: None,
        session_dir: Some(sessions_dir.to_string_lossy().to_string()),
        telemetry_disabled: None,
        created_at: "t".to_string(),
        updated_at: "t".to_string(),
        lifecycle: DaemonWorkerLifecycle::Ready,
        create_command: pa_types::daemon::DurableDaemonCreateCommand {
            session_path: None,
            no_session: None,
            rest: Map::default(),
        },
        consecutive_failures: 0,
        // The route-side tombstone the plain kill's pre-route persist
        // wrote before the forward.
        stop_requested_at: Some("2026-09-26T00:00:00Z".to_string()),
        archive_on_stop: Some(true),
        last_failure_at: None,
        last_error: None,
        rest: Map::default(),
    };
    // The persist target is a directory: the tombstone's redundant
    // re-write fails (the rename onto a directory cannot land).
    let persist_target = sessions_dir.join("w.d");
    std::fs::create_dir(&persist_target).unwrap();
    let resident = ResidentWorker::new("w-live".to_string(), descriptor, persist_target);
    supervisor.registry.insert(resident.clone()).await;

    supervisor
        .stop_worker(&resident)
        .await
        .expect("the durable tombstone must carry the stop past its failed re-write");

    assert!(
        supervisor.registry.get("w-live").await.is_none(),
        "the stop completed: the worker left the registry"
    );
    assert!(
        resident.intentional_stop.load(Ordering::SeqCst),
        "the stop is intentional"
    );
}

/// The first OS signal's drain: the gate rejects new work, every
/// client gets the `daemon_closing` event, and the running turn
/// settles inside its worker's routed `shutdown` before the stop
/// pass retires the worker (descriptor gone - no supervisor-lost
/// lingering) and lets the accept loop exit. The fake worker holds
/// its `shutdown` reply on a test-controlled settle, so a pass that
/// does not wait for the flush barrier fails the assertions below.
#[cfg(unix)] // the signal-drain state machine: unix signal source
#[tokio::test]
async fn first_signal_drains_a_settling_turn_and_rejects_new_work() {
    let dir = tempfile::TempDir::new().unwrap();
    let options = SupervisorOptions {
        socket_path: dir.path().join("daemon.sock"),
        agent_dir: dir.path().join("agent"),
    };
    let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
        "version": 2,
        "workerId": "w-signal",
        "pid": 0,
        "socketPath": "/tmp/none.sock",
        "recoveryJournalPath": "/tmp/none.jsonl",
        "supervisorSocketPath": "/tmp/none.sock",
        "authenticationToken": "test",
        "rootActiveSessionId": "w-signal",
        "createdAt": "t",
        "updatedAt": "t",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let descriptor_dir = dir.path().join("descriptors");
    std::fs::create_dir_all(&descriptor_dir).unwrap();
    let descriptor_path = descriptor_dir.join("w-signal.descriptor.json");
    let resident = Arc::new(ResidentWorker::new(
        "w-signal".to_string(),
        descriptor,
        descriptor_path.clone(),
    ));
    // The fake worker connection: the routed `shutdown` reply is the
    // flush barrier, so it is held until the test releases the turn's
    // settle.
    // The bounded command-channel type (the backpressure lane's
    // request-path bound): one slot is plenty for the single routed
    // `shutdown`.
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<WorkerRequest>(1);
    *resident.cmd_tx.lock().await = Some(cmd_tx);
    let (shutdown_routed_tx, shutdown_routed_rx) = oneshot::channel::<()>();
    let (turn_settled_tx, turn_settled_rx) = oneshot::channel::<()>();
    let (settle_release_tx, settle_release_rx) = oneshot::channel::<()>();
    let pump_resident = Arc::clone(&resident);
    let pump = tokio::spawn(async move {
        let request = cmd_rx.recv().await.expect("the drain routes a command");
        assert_eq!(request.command_type, "shutdown");
        let _ = shutdown_routed_tx.send(());
        settle_release_rx.await.expect("the turn settles first");
        let _ = turn_settled_tx.send(());
        let reply = pump_resident
            .pending
            .lock()
            .await
            .remove(&request.request_id)
            .expect("the routed shutdown holds a reply slot");
        let _ = reply.send(WorkerReply::Typed(crate::protocol::response_success(
            None, "shutdown", None,
        )));
    });
    supervisor.registry.insert(Arc::clone(&resident)).await;
    let mut events = supervisor.events.subscribe();
    let create = DaemonCommand::Create {
        id: None,
        session_path: None,
        continue_recent: None,
        no_session: None,
        name: None,
        config: None,
        telemetry_disabled: None,
        runtime_metadata: None,
        lifecycle: None,
        env: None,
        launch_env: None,
        rest: Map::default(),
    };
    assert!(
        supervisor.begin_signal_drain(),
        "the first signal must start the drain"
    );
    let refused = supervisor
        .launch_worker(&create, None)
        .await
        .err()
        .expect("a create during the drain must be rejected");
    assert_eq!(
        refused.to_string(),
        "Supervisor is shutting down",
        "the refusal error: {refused:#}"
    );
    let (routing, closing) = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .expect("the drain broadcasts daemon_closing")
        .expect("the events channel stays open");
    assert!(
        matches!(routing, ClientRouting::Broadcast),
        "every client learns the closing"
    );
    assert_eq!(
        *closing,
        json!({ "type": "daemon_closing", "reason": "shutdown" })
    );
    tokio::time::timeout(Duration::from_secs(2), shutdown_routed_rx)
        .await
        .expect("the drain routes the worker's shutdown")
        .expect("the routed channel stays open");
    // While the settle is held the pass can never finish (the routed
    // reply is the flush barrier), so assert it stays unexited across
    // a polled window: a fire-and-forget drain that retired the
    // worker early fails here deterministically, not on one fixed
    // sleep.
    let hold_deadline = std::time::Instant::now() + Duration::from_millis(100);
    while std::time::Instant::now() < hold_deadline {
        assert!(
            !supervisor.accept_exit.load(Ordering::SeqCst),
            "the stop pass must wait for the settling turn"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let _ = settle_release_tx.send(());
    tokio::time::timeout(Duration::from_secs(2), turn_settled_rx)
        .await
        .expect("the turn settles within the drain")
        .expect("the settle channel stays open");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !supervisor.accept_exit.load(Ordering::SeqCst) {
        assert!(
            std::time::Instant::now() < deadline,
            "the completed stop pass must exit the accept loop"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        supervisor.registry.list().await.is_empty(),
        "the drained worker leaves the registry"
    );
    assert!(
        !descriptor_path.exists(),
        "the drained worker's descriptor is retired with it"
    );
    assert!(
        !supervisor.begin_signal_drain(),
        "a second signal while shutting down forces"
    );
    pump.abort();
}

/// Every signal that finds a shutdown already in flight is the force
/// request: the drain's own second signal, a signal racing the
/// shutdown command's gate, and a signal racing an update exit - the
/// last without flipping the gate, so the update's
/// descriptor-preserving exit never becomes a terminal stop pass.
#[cfg(unix)] // the signal-drain state machine: unix signal source
#[tokio::test]
async fn a_signal_during_an_in_flight_shutdown_forces() {
    let dir = tempfile::TempDir::new().unwrap();
    let options = SupervisorOptions {
        socket_path: dir.path().join("daemon.sock"),
        agent_dir: dir.path().join("agent"),
    };
    let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
    assert!(
        supervisor.begin_signal_drain(),
        "the first signal starts the drain"
    );
    assert!(
        !supervisor.begin_signal_drain(),
        "the second signal forces the exit"
    );

    // A client-command shutdown already flipped the gate: a signal
    // racing it forces.
    let dir = tempfile::TempDir::new().unwrap();
    let options = SupervisorOptions {
        socket_path: dir.path().join("daemon.sock"),
        agent_dir: dir.path().join("agent"),
    };
    let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
    supervisor.shutting_down.store(true, Ordering::SeqCst);
    assert!(
        !supervisor.begin_signal_drain(),
        "a signal racing the shutdown command forces"
    );

    // An update exit published accept_exit before the gate: the
    // signal forces without flipping the gate.
    let dir = tempfile::TempDir::new().unwrap();
    let options = SupervisorOptions {
        socket_path: dir.path().join("daemon.sock"),
        agent_dir: dir.path().join("agent"),
    };
    let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
    supervisor.accept_exit.store(true, Ordering::SeqCst);
    assert!(
        !supervisor.begin_signal_drain(),
        "a signal racing the update exit forces"
    );
    assert!(
        !supervisor.shutting_down.load(Ordering::SeqCst),
        "the update exit must not become a terminal stop pass"
    );

    // The update's committed stop window (the coordinator's Stopping
    // state, before exit_for_update publishes accept_exit): a signal
    // forces without flipping the gate, so the terminal pass can never
    // tombstone and delete the descriptors the successor must adopt.
    let dir = tempfile::TempDir::new().unwrap();
    let options = SupervisorOptions {
        socket_path: dir.path().join("daemon.sock"),
        agent_dir: dir.path().join("agent"),
    };
    let supervisor = Arc::new(Supervisor::new(options).expect("supervisor"));
    let update_id = UpdateId::from("u-signal".to_string());
    let budget = UpdateTimeoutBudget::from_env();
    supervisor
        .update_prepare
        .begin(update_id.clone(), util::now_ms(), &budget);
    supervisor.update_prepare.drain_complete(&update_id);
    supervisor
        .update_prepare
        .snapshot_written(&update_id, util::now_ms(), &budget);
    supervisor.update_prepare.prepare_acked(&update_id);
    supervisor.update_prepare.commit(&update_id);
    assert_eq!(
        supervisor.update_prepare.active_state(),
        Some(PrepareState::Stopping),
        "the transaction reached the committed stop window"
    );
    assert!(
        !supervisor.begin_signal_drain(),
        "a signal racing the committed update stop forces"
    );
    assert!(
        !supervisor.shutting_down.load(Ordering::SeqCst),
        "the committed update stop must not become a terminal stop pass"
    );
}

// ---------------------------------------------------------------------------
// The worker-driven idle passivation handler (TS `idleEvictionMinutes`).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn idle_passivation_requires_the_worker_token() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    // An unknown token answers the authentication failure.
    let response = supervisor
        .handle_worker_idle_passivation("c1", "worker_idle_passivation", "no-such-token", Some(1))
        .await;
    assert!(!response.success);
    assert!(
        response
            .error
            .as_deref()
            .unwrap_or("")
            .contains("authentication failed"),
        "the unauthenticated ask is refused: {response:?}"
    );
}

#[tokio::test]
async fn idle_passivation_refuses_client_owned_and_in_memory_workers() {
    // The refusal gate (TS `canEvictWorker`'s `hasOwnerClient` arm,
    // widened): a client-owned worker never passivates itself, and an
    // in-memory (noSession) root has no file to wake from. An unowned
    // sessioned root passes this gate; with a route in flight, its ask
    // defers instead of stopping the worker underneath it (the e2e
    // drives the pass side end to end).
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
        version: 1,
        worker_id: "w-owned".to_string(),
        pid: 4242,
        process_start_id: None,
        socket_path: "/tmp/none.sock".to_string(),
        recovery_journal_path: "/tmp/none.jsonl".to_string(),
        orphan_process_journal_path: None,
        supervisor_socket_path: "/tmp/none.sock".to_string(),
        authentication_token: "owned-token".to_string(),
        worker_instance_id: None,
        root_active_session_id: "w-owned".to_string(),
        owner_client_id: Some("client-1".to_string()),
        root_session_id: Some("root-1".to_string()),
        session_file: None,
        session_dir: None,
        telemetry_disabled: None,
        created_at: "t".to_string(),
        updated_at: "t".to_string(),
        lifecycle: DaemonWorkerLifecycle::Ready,
        create_command: pa_types::daemon::DurableDaemonCreateCommand {
            session_path: None,
            no_session: None,
            rest: Map::default(),
        },
        consecutive_failures: 0,
        stop_requested_at: None,
        archive_on_stop: None,
        last_failure_at: None,
        last_error: None,
        rest: Map::default(),
    };
    let in_memory = {
        let mut descriptor = descriptor.clone();
        descriptor.worker_id = "w-mem".to_string();
        descriptor.authentication_token = "mem-token".to_string();
        descriptor.owner_client_id = None;
        descriptor.create_command.no_session = Some(true);
        descriptor
    };
    let idle = pa_types::daemon::DaemonWorkerDescriptor {
        worker_id: "w-idle".to_string(),
        authentication_token: "idle-token".to_string(),
        owner_client_id: None,
        ..descriptor.clone()
    };
    let resident = ResidentWorker::new("w-owned".to_string(), descriptor, dir.path().join("w.d"));
    supervisor.registry.insert(resident).await;
    let response = supervisor
        .handle_worker_idle_passivation("c1", "worker_idle_passivation", "owned-token", Some(1))
        .await;
    assert!(!response.success);
    assert!(
        response
            .error
            .as_deref()
            .unwrap_or("")
            .contains("client-owned or in-memory (noSession) worker"),
        "the client-owned worker's ask is refused: {response:?}"
    );
    let resident = ResidentWorker::new("w-mem".to_string(), in_memory, dir.path().join("w-mem.d"));
    supervisor.registry.insert(resident).await;
    let response = supervisor
        .handle_worker_idle_passivation("c2", "worker_idle_passivation", "mem-token", Some(1))
        .await;
    assert!(!response.success);
    assert!(
        response
            .error
            .as_deref()
            .unwrap_or("")
            .contains("client-owned or in-memory (noSession) worker"),
        "the in-memory worker's ask is refused: {response:?}"
    );
    // The eviction fence (TS `withEvictionFence`): a request in flight
    // when the ask arrives defers the passivation — no stop, no
    // tombstone — and the same ask stops the worker once the route
    // drains.
    let resident = ResidentWorker::new("w-idle".to_string(), idle, dir.path().join("w-idle.d"));
    supervisor.registry.insert(resident.clone()).await;
    let in_flight = Arc::clone(&resident.inflight).try_acquire_owned().unwrap();
    supervisor
        .handle_worker_idle_passivation("c3", "worker_idle_passivation", "idle-token", None)
        .await;
    assert!(
        supervisor.registry.get("w-idle").await.is_some(),
        "the deferred ask never stopped the worker"
    );
    assert!(
        resident.descriptor.lock().await.stop_requested_at.is_none(),
        "the deferred ask left no stop tombstone on the live worker"
    );
    drop(in_flight);
    supervisor
        .handle_worker_idle_passivation("c4", "worker_idle_passivation", "idle-token", None)
        .await;
    assert!(
        supervisor.registry.get("w-idle").await.is_none(),
        "the drained worker's ask stops it"
    );
}

/// The roster wake's reuse arm (Macroscope's concurrent-wake finding,
/// the reuse half): a prompt for a passivated child's active-session id
/// whose roster row resolves to a session file a CONCURRENT revival
/// already hosts must join the resident — no second launch.
#[tokio::test]
async fn a_passivated_row_prompt_joins_an_already_hosting_resident() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    // The child's file lives in the session-artifacts tree (the RLM
    // child shape): the saved-session catalog never resolves it, so the
    // wake falls to the roster row.
    let artifacts = agent_dir.join("session-artifacts").join("child-1");
    std::fs::create_dir_all(&artifacts).unwrap();
    let session_file = artifacts.join("child-1.jsonl");
    std::fs::write(
        &session_file,
        "{\"type\":\"session\",\"version\":3,\"id\":\"child-1\",\"timestamp\":\"t\",\"cwd\":\"/c\"}\n",
    )
    .unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    // The passive roster row: the active-session id the stripped routing
    // left and the durable session file.
    supervisor.roster.lock().unwrap().write_seeded(
        json!({
            "agentId": "sub-passive-1",
            "type": "subagent",
            "name": "child-1",
            "activeSessionId": "passive-routing-1",
            "sessionFile": session_file.to_string_lossy(),
            "status": "done",
        }),
        false,
    );
    // The concurrent revival's resident: already hosting the row's file.
    let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
        version: 1,
        worker_id: "w-revived".to_string(),
        pid: 4243,
        process_start_id: None,
        socket_path: "/tmp/none.sock".to_string(),
        recovery_journal_path: "/tmp/none.jsonl".to_string(),
        orphan_process_journal_path: None,
        supervisor_socket_path: "/tmp/none.sock".to_string(),
        authentication_token: "token".to_string(),
        worker_instance_id: None,
        root_active_session_id: "w-revived".to_string(),
        owner_client_id: None,
        root_session_id: Some("child-1".to_string()),
        session_file: Some(session_file.to_string_lossy().into_owned()),
        session_dir: Some(artifacts.to_string_lossy().into_owned()),
        telemetry_disabled: None,
        created_at: "t".to_string(),
        updated_at: "t".to_string(),
        lifecycle: DaemonWorkerLifecycle::Ready,
        create_command: pa_types::daemon::DurableDaemonCreateCommand {
            session_path: None,
            no_session: None,
            rest: Map::default(),
        },
        consecutive_failures: 0,
        stop_requested_at: None,
        archive_on_stop: None,
        last_failure_at: None,
        last_error: None,
        rest: Map::default(),
    };
    let resident = ResidentWorker::new("w-revived".to_string(), descriptor, artifacts.join("w.d"));
    supervisor
        .registry
        .insert(std::sync::Arc::clone(&resident))
        .await;
    let before = supervisor.registry.list().await.len();
    // The wake: the roster row resolves, the reuse arm finds the hosting
    // resident, and NO second launch runs.
    let route = supervisor.wake_saved_session("passive-routing-1").await;
    match route {
        super::routing::WakeRoute::Woken(woken) => {
            assert!(
                std::sync::Arc::ptr_eq(&woken, &resident),
                "the wake must join the already-hosting resident"
            );
        }
        super::routing::WakeRoute::Fallthrough(message) => {
            panic!("expected a woken resident, got the fallthrough: {message}");
        }
    }
    assert_eq!(
        supervisor.registry.list().await.len(),
        before,
        "the reuse arm must not launch a second worker"
    );
}

/// The roster wake's failure arm: with no resident hosting the row's
/// file and the launch refused (the shutdown gate stands in for any
/// launch failure), the wake falls through to the caller's error — the
/// concurrent-revival race's loser only fails when the rival never
/// registered.
#[tokio::test]
async fn a_passivated_row_prompt_with_no_rival_falls_through_the_failed_launch() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let artifacts = agent_dir.join("session-artifacts").join("child-2");
    std::fs::create_dir_all(&artifacts).unwrap();
    let session_file = artifacts.join("child-2.jsonl");
    std::fs::write(
        &session_file,
        "{\"type\":\"session\",\"version\":3,\"id\":\"child-2\",\"timestamp\":\"t\",\"cwd\":\"/c\"}\n",
    )
    .unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    supervisor.roster.lock().unwrap().write_seeded(
        json!({
            "agentId": "sub-passive-2",
            "type": "subagent",
            "name": "child-2",
            "activeSessionId": "passive-routing-2",
            "sessionFile": session_file.to_string_lossy(),
            "status": "done",
        }),
        false,
    );
    // The launch gate: any launch is refused (a deterministic stand-in
    // for the race's losing launch).
    supervisor.shutting_down.store(true, Ordering::SeqCst);
    let route = supervisor.wake_saved_session("passive-routing-2").await;
    match route {
        super::routing::WakeRoute::Fallthrough(message) => {
            assert!(
                message.contains("shutting down") || message.contains("Unknown active session"),
                "the failed launch must surface, got: {message}"
            );
        }
        super::routing::WakeRoute::Woken(woken) => {
            panic!(
                "expected a fallthrough, got a woken resident: {:?}",
                woken.worker_id
            );
        }
    }
}

/// The passivation-aware delete: a Kill carrying the `rlmLedgerDelete`
/// marker aimed at a STOPPED child (no resident worker) resolves the
/// ledger edge and tombstones it — the deletion boundary without a
/// worker (TS `recordRlmSubagentDeletion` after a whole-worker
/// eviction).
#[tokio::test]
async fn a_ledger_delete_of_a_stopped_child_tombstones_without_a_worker() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    // A live ledger edge for a stopped child (the passivation's leftover:
    // the session file survives, the worker is gone).
    let child_file = sessions_dir.join("child-gone.jsonl");
    std::fs::write(
        &child_file,
        "{\"type\":\"session\",\"version\":3,\"id\":\"child-gone\",\"timestamp\":\"t\",\"cwd\":\"/c\"}\n",
    )
    .unwrap();
    // The child's artifact partition exists (the stopped child's leftover):
    // the delete must sweep it exactly like a live child's kill route.
    let artifacts = agent_dir.join("session-artifacts").join("child-gone");
    std::fs::create_dir_all(&artifacts).unwrap();
    std::fs::write(artifacts.join("scheduled-jobs.json"), "{}").unwrap();
    let parent_file = sessions_dir.join("parent.jsonl");
    std::fs::write(&parent_file, "{\"type\":\"session\",\"id\":\"p\"}\n").unwrap();
    let ledger = supervisor
        .rlm_spawn_ledger_for(None)
        .await
        .expect("the spawn ledger resolves");
    ledger
        .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
            child_id: "sub-gone".to_string(),
            parent: parent_file.to_string_lossy().into_owned(),
            child: child_file.to_string_lossy().into_owned(),
            depth: 1,
            name: "parked-worker".to_string(),
        })
        .expect("the spawn edge appends");
    assert_eq!(ledger.live_edges().expect("edges").len(), 1);

    // The parent's delete rides the kill route with the marker; the
    // route finds no resident and the passivation-aware arm must answer
    // success WITH the tombstone applied.
    let outcome = supervisor
        .tombstone_saved_rlm_child(
            "child-gone",
            Some("sub-gone"),
            crate::rlm_ledger::RlmLedgerDeleteReason::User,
        )
        .await;
    assert!(
        outcome.is_ok(),
        "the stopped child's delete must tombstone: {outcome:?}"
    );
    let edges = ledger.live_edges().expect("edges after");
    assert!(
        edges.is_empty(),
        "the tombstone retires the live edge: {edges:?}"
    );
    let tombstones = ledger.edges(true).expect("tombstones");
    assert_eq!(
        tombstones[0].deleted,
        Some(crate::rlm_ledger::RlmLedgerDeleteReason::User)
    );

    // An unknown selector with no ledger edge is a clean failure (the
    // caller answers the delete error, never a silent success).
    let miss = supervisor
        .tombstone_saved_rlm_child(
            "no-such-child",
            None,
            crate::rlm_ledger::RlmLedgerDeleteReason::User,
        )
        .await;
    assert!(miss.is_err(), "a selector with no edge must not delete");
    // The stopped child's delete teardown mirrors the resident delete's
    // end state (the second bot round's leftover-partition finding): the
    // artifact partition is swept and the session file carries the
    // archived state.
    assert!(
        !artifacts.exists(),
        "the deleted child's artifact partition must be swept"
    );
    assert!(
        std::fs::read_to_string(&child_file)
            .expect("the child file survives (archived, not unlinked)")
            .contains("archived"),
        "the stopped child's delete must archive the session file"
    );
}

/// The stopped-child delete settles the roster the way the resident
/// delete does (the D1b composition with the idle passivation): a
/// `rlmLedgerDelete` aimed at an idle-passivated child finds no stop to
/// settle the row, so the passivation's unowned row would linger while
/// the bucket bills the captured spend on the parent - the same child
/// billed twice until some later stop's unowned sweep catches the row.
/// The delete's own push carries both halves together: the parent's
/// refreshed bucket AND the child's row removal, one `roster_update`.
#[tokio::test]
async fn the_stopped_childs_delete_removes_its_row_and_bills_the_parent() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    // The parent's roster row: the bucket's target.
    let parent_file = sessions_dir.join("parent.jsonl");
    std::fs::write(&parent_file, "{\"type\":\"session\",\"id\":\"p\"}\n").unwrap();
    let parent_row = json!({
        "sessionId": "p",
        "activeSessionId": "p-live",
        "runtimeKind": "top-level",
        "sessionFile": parent_file.to_string_lossy(),
        "sessionName": "parent",
        "status": "idle",
    });
    supervisor.write_roster_summary(&parent_row, None);
    // The idle-passivated child: its transcript lives under
    // session-artifacts (the real RLM-delete shape - the flat catalog
    // never lists it, so the bucket is its only billing surface), one
    // billed assistant turn ($0.30) the delete captures into the
    // tombstone, and the passivation's lingering unowned roster row.
    let child_transcript = agent_dir
        .join("session-artifacts")
        .join("root-1")
        .join("sub-gone")
        .join("sub-gone.jsonl");
    std::fs::create_dir_all(child_transcript.parent().expect("artifact dir")).unwrap();
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&child_transcript)
            .expect("open the child transcript");
        writeln!(
            file,
            "{}",
            json!({
                "type": "session", "version": 3, "id": "sub-gone",
                "timestamp": "2026-09-29T00:00:00.000Z", "cwd": "/the/stopped/cwd",
                "parentSession": parent_file.to_string_lossy(), "rlmDepth": 1
            })
        )
        .expect("the child header");
        writeln!(
            file,
            "{}",
            json!({
                "type": "message", "id": "dm1a", "parentId": null,
                "timestamp": "2026-09-29T00:00:02.100Z",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "parked work"}],
                    "timestamp": 2100,
                    "usage": {
                        "input": 60, "output": 6, "cacheRead": 0, "cacheWrite": 0,
                        "totalTokens": 66,
                        "cost": {"input": 0.0, "output": 0.3, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.3}
                    }
                }
            })
        )
        .expect("the billed turn");
    }
    let child_row = json!({
        "sessionId": "sub-gone-persisted",
        "activeSessionId": "sub-gone-live",
        "runtimeKind": "subagent",
        "rlmChildId": "sub-gone",
        "rlmDepth": 1,
        "sessionFile": child_transcript.to_string_lossy(),
        "sessionName": "parked-worker",
        "cwd": "/the/stopped/cwd",
        "parentSessionPath": parent_file.to_string_lossy(),
        "status": "done",
        "usage": { "inputTokens": 60, "outputTokens": 6, "cost": 0.3 },
    });
    let child_agent_id = supervisor
        .write_roster_summary(&child_row, None)
        .expect("the child row")
        .agent_id;
    // A live ledger edge for the stopped child (the whole-worker idle
    // stop left the edge behind).
    let ledger = supervisor
        .rlm_spawn_ledger_for(None)
        .await
        .expect("the spawn ledger resolves");
    ledger
        .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
            child_id: "sub-gone".to_string(),
            parent: parent_file.to_string_lossy().into_owned(),
            child: child_transcript.to_string_lossy().into_owned(),
            depth: 1,
            name: "parked-worker".to_string(),
        })
        .expect("the spawn edge appends");
    let mut events = supervisor.events.subscribe();
    // The parent's delete of its stopped child.
    supervisor
        .tombstone_saved_rlm_child(
            "sub-gone",
            Some("sub-gone"),
            crate::rlm_ledger::RlmLedgerDeleteReason::User,
        )
        .await
        .expect("the stopped child's delete tombstones");
    // ONE push carries both halves of the settle: the parent's
    // refreshed bucket and the child's row removal.
    let mut pushes = Vec::new();
    loop {
        match events.try_recv() {
            Ok((ClientRouting::RosterSubscribers, payload)) => pushes.push((*payload).clone()),
            Ok(_) => {}
            Err(
                tokio::sync::broadcast::error::TryRecvError::Empty
                | tokio::sync::broadcast::error::TryRecvError::Closed,
            ) => break,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(missed)) => {
                panic!("roster push subscriber lagged by {missed}");
            }
        }
    }
    assert_eq!(
        pushes.len(),
        1,
        "the stopped child's delete settles in one push: {pushes:?}"
    );
    let parent_after = supervisor
        .roster
        .lock()
        .unwrap()
        .entries()
        .into_iter()
        .find(|entry| entry.summary.get("sessionId").and_then(Value::as_str) == Some("p"))
        .expect("the parent row");
    assert_eq!(
        pushes[0]["changed"],
        serde_json::to_value(vec![parent_after]).expect("serialized parent"),
        "the push carries the parent's refreshed row: {pushes:?}"
    );
    assert_eq!(
        pushes[0]["changed"][0]["summary"]["deletedDescendantUsage"],
        json!({ "inputTokens": 60, "outputTokens": 6, "cost": 0.3 }),
        "the deleted child's captured spend bills through the parent"
    );
    assert_eq!(
        pushes[0]["removed"],
        json!([child_agent_id]),
        "the lingering row is removed in the same push: {pushes:?}"
    );
    assert!(
        supervisor
            .roster
            .lock()
            .unwrap()
            .entries()
            .into_iter()
            .all(|entry| {
                entry.summary.get("rlmChildId").and_then(Value::as_str) != Some("sub-gone")
            }),
        "the deleted child's row is gone from the roster"
    );
}

/// The delete's edge resolution must match BOTH the selector's stem and
/// the explicit child id on the SAME edge (Macroscope's shared-id
/// finding): two live edges sharing a child id never let a delete
/// tombstone the unrelated one.
#[tokio::test]
async fn a_ledger_delete_never_tombstones_an_unrelated_edge_sharing_the_child_id() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    let seed = |stem: &str| {
        let file = sessions_dir.join(format!("{stem}.jsonl"));
        std::fs::write(
            &file,
            format!("{{\"type\":\"session\",\"version\":3,\"id\":\"{stem}\",\"timestamp\":\"t\",\"cwd\":\"/c\"}}\n"),
        )
        .unwrap();
        file.to_string_lossy().into_owned()
    };
    let file_a = seed("child-a");
    let file_b = seed("child-b");
    let parent = seed("parent");
    let ledger = supervisor
        .rlm_spawn_ledger_for(None)
        .await
        .expect("the spawn ledger resolves");
    for (child, stem) in [(&file_a, "child-a"), (&file_b, "child-b")] {
        ledger
            .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
                child_id: "sub-shared".to_string(),
                parent: parent.clone(),
                child: child.clone(),
                depth: 1,
                name: stem.to_string(),
            })
            .expect("the spawn edge appends");
    }
    assert_eq!(ledger.live_edges().expect("edges").len(), 2);
    // The delete targets child-a by its stem WITH the shared id: only
    // child-a's edge may retire.
    supervisor
        .tombstone_saved_rlm_child(
            "child-a",
            Some("sub-shared"),
            crate::rlm_ledger::RlmLedgerDeleteReason::User,
        )
        .await
        .expect("the delete resolves the stem-matching edge");
    let live = ledger.live_edges().expect("edges after");
    assert_eq!(
        live.len(),
        1,
        "the unrelated edge sharing the child id must stay live: {live:?}"
    );
    assert_eq!(live[0].child, file_b, "the survivor is child-b's edge");
}

/// The durable-id wake's reuse arm (the second bot round's finding: the
/// join lived only on the roster path): a revival for a ledger child
/// whose file a concurrent wake already hosts must join the resident
/// through the LEDGER path — the path children actually revive by.
#[tokio::test]
async fn a_ledger_child_wake_joins_an_already_hosting_resident() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let artifacts = agent_dir.join("session-artifacts").join("kid-1");
    std::fs::create_dir_all(&artifacts).unwrap();
    let session_file = artifacts.join("kid-1.jsonl");
    std::fs::write(
        &session_file,
        "{\"type\":\"session\",\"version\":3,\"id\":\"kid-1\",\"timestamp\":\"t\",\"cwd\":\"/c\",\"rlmDepth\":1}\n",
    )
    .unwrap();
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let parent_file = sessions_dir.join("parent.jsonl");
    std::fs::write(&parent_file, "{\"type\":\"session\",\"id\":\"p\"}\n").unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    supervisor.roster.lock().unwrap().write_seeded(
        json!({
            "agentId": "sub-kid-1",
            "type": "subagent",
            "name": "kid-1",
            "activeSessionId": "kid-routing-1",
            "sessionFile": session_file.to_string_lossy(),
            "status": "done",
        }),
        false,
    );
    let ledger = supervisor
        .rlm_spawn_ledger_for(None)
        .await
        .expect("the spawn ledger resolves");
    ledger
        .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
            child_id: "sub-kid-1".to_string(),
            parent: parent_file.to_string_lossy().into_owned(),
            child: session_file.to_string_lossy().into_owned(),
            depth: 1,
            name: "kid-1".to_string(),
        })
        .expect("the spawn edge appends");
    // The concurrent revival's resident already hosting the child's file.
    let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
        version: 1,
        worker_id: "w-kid".to_string(),
        pid: 4244,
        process_start_id: None,
        socket_path: "/tmp/none.sock".to_string(),
        recovery_journal_path: "/tmp/none.jsonl".to_string(),
        orphan_process_journal_path: None,
        supervisor_socket_path: "/tmp/none.sock".to_string(),
        authentication_token: "token".to_string(),
        worker_instance_id: None,
        root_active_session_id: "w-kid".to_string(),
        owner_client_id: None,
        root_session_id: Some("kid-1".to_string()),
        session_file: Some(session_file.to_string_lossy().into_owned()),
        session_dir: Some(artifacts.to_string_lossy().into_owned()),
        telemetry_disabled: None,
        created_at: "t".to_string(),
        updated_at: "t".to_string(),
        lifecycle: DaemonWorkerLifecycle::Ready,
        create_command: pa_types::daemon::DurableDaemonCreateCommand {
            session_path: None,
            no_session: None,
            rest: Map::default(),
        },
        consecutive_failures: 0,
        stop_requested_at: None,
        archive_on_stop: None,
        last_failure_at: None,
        last_error: None,
        rest: Map::default(),
    };
    let resident = ResidentWorker::new("w-kid".to_string(), descriptor, artifacts.join("w.d"));
    supervisor
        .registry
        .insert(std::sync::Arc::clone(&resident))
        .await;
    let before = supervisor.registry.list().await.len();
    // The wake by the child's NAME (the ledger edge's live resolution):
    // the catalog misses (the artifacts tree), the ledger matches, and
    // the REUSE arm joins — no second launch.
    let route = supervisor.wake_saved_session("kid-1").await;
    match route {
        super::routing::WakeRoute::Woken(woken) => {
            assert!(
                std::sync::Arc::ptr_eq(&woken, &resident),
                "the ledger wake must join the already-hosting resident"
            );
        }
        super::routing::WakeRoute::Fallthrough(message) => {
            panic!("expected a woken resident, got the fallthrough: {message}");
        }
    }
    assert_eq!(
        supervisor.registry.list().await.len(),
        before,
        "the ledger wake's reuse arm must not launch a second worker"
    );
}
