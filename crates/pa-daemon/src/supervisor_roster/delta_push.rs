//! The roster-delta push family: the supervisor
//! fixture, the sequence-drop, the flip/push batching, and the
//! push benchmark.
use super::*;

/// A supervisor with one registered resident worker, carrying the
/// token `handle_worker_roster_delta` authenticates.
async fn supervisor_with_registered_worker(dir: &Path) -> Supervisor {
    let supervisor = Supervisor::new(crate::supervisor::SupervisorOptions {
        socket_path: dir.join("daemon.sock"),
        agent_dir: dir.join("agent"),
    })
    .expect("supervisor");
    let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
        version: 1,
        worker_id: "w-delta".to_string(),
        pid: 4242,
        process_start_id: None,
        socket_path: dir.join("worker.sock").to_string_lossy().to_string(),
        recovery_journal_path: dir.join("recovery.jsonl").to_string_lossy().to_string(),
        orphan_process_journal_path: None,
        supervisor_socket_path: dir.join("daemon.sock").to_string_lossy().to_string(),
        authentication_token: "delta-token".to_string(),
        worker_instance_id: None,
        root_active_session_id: "a-delta".to_string(),
        owner_client_id: None,
        root_session_id: None,
        session_file: Some(dir.join("session.jsonl").to_string_lossy().to_string()),
        session_dir: Some(dir.to_string_lossy().to_string()),
        telemetry_disabled: Some(true),
        created_at: "t".to_string(),
        updated_at: "t".to_string(),
        lifecycle: pa_types::daemon::DaemonWorkerLifecycle::Ready,
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
            "w-delta".to_string(),
            descriptor,
            dir.join("descriptor.json"),
        ))
        .await;
    supervisor
}

/// The worker's session summary in the wire shape `push_roster_delta`
/// sends (worker.rs `session_summary`): the busy flip carries
/// `activity: "working"` / `isStreaming: true`, the idle flip settles
/// both back.
fn flip_summary(dir: &Path, busy: bool) -> Value {
    json!({
        "id": "a-delta",
        "lifecycle": "active",
        "activity": if busy { "working" } else { "idle" },
        "isSessionActive": busy,
        "isStreaming": busy,
        "isCompacting": false,
        "activeSessionId": "a-delta",
        "sessionId": "s-delta",
        "sessionFile": dir.join("session.jsonl").to_string_lossy(),
        "sessionName": "bench",
        "cwd": dir.to_string_lossy(),
        "rlmDepth": 0,
        "runtimeKind": "top-level",
        "messageCount": 12,
        "attachedClients": 0,
        "thinkingLevel": "default",
        "lastActivityAt": "2026-09-23T00:00:00.000Z",
        "created": "2026-09-23T00:00:00.000Z",
        "modified": "2026-09-23T00:00:00.000Z",
        "workerState": "ready",
        "workerPid": 4242,
    })
}

/// The stale-delta gate at the handler: the worker's per-request
/// supervisor links deliver deltas unordered, so a delayed older
/// snapshot (a lower sequence) must not overwrite a newer one — the
/// TS worker never has this race (its roster deltas ride one ordered
/// supervisor client socket).
#[tokio::test]
async fn worker_roster_delta_drops_stale_sequences() {
    fn summary(level: &str) -> Value {
        serde_json::json!({
            "sessionId": "s1",
            "activeSessionId": "s1",
            "activity": "idle",
            "thinkingLevel": level,
        })
    }
    async fn delta(
        supervisor: &Arc<Supervisor>,
        token: &str,
        level: &str,
        sequence: Option<u64>,
        instance: &str,
    ) -> DaemonResponse {
        supervisor
            .handle_worker_roster_delta(
                "d",
                "worker_roster_delta",
                WorkerRosterDelta {
                    worker_token: token.to_string(),
                    summary: summary(level),
                    removed: Vec::new(),
                    sequence,
                    worker_instance_id: Some(instance.to_string()),
                },
            )
            .await
    }

    let dir = std::env::temp_dir().join(format!("pa-roster-seq-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(crate::supervisor::SupervisorOptions {
            socket_path: dir.join("supervisor.sock"),
            agent_dir: dir.join("agent"),
        })
        .expect("supervisor"),
    );
    let descriptor: pa_types::daemon::DaemonWorkerDescriptor =
        serde_json::from_value(serde_json::json!({
            "version": 2,
            "workerId": "seq-worker",
            "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "seq-token",
            "workerInstanceId": "i1",
            "rootActiveSessionId": "s1",
            "createdAt": "2026-09-23T00:00:00Z",
            "updatedAt": "2026-09-23T00:00:00Z",
            "lifecycle": "ready",
            "createCommand": {},
            "consecutiveFailures": 0,
        }))
        .expect("descriptor");
    supervisor
        .registry
        .insert(ResidentWorker::new(
            "seq-worker".to_string(),
            descriptor,
            dir.join("descriptor.json"),
        ))
        .await;
    let entry_level = || {
        supervisor
            .roster
            .lock()
            .unwrap()
            .get("s1")
            .map(|entry| entry.summary["thinkingLevel"].clone())
            .expect("the roster entry")
    };
    // A fresh worker's create/registration pull stamps the ZERO        // A fresh worker's create/registration pull stamps the ZERO
    // counter (the worker has pushed nothing yet): it starts the
    // slot and applies — the create path's first authoritative
    // write.
    let resident = supervisor
        .registry
        .get("seq-worker")
        .await
        .expect("resident");
    let mut fresh_pull = summary("off");
    fresh_pull["rosterDeltaSequence"] = serde_json::json!(0);
    fresh_pull["workerInstanceId"] = serde_json::json!("i1");
    let fresh = supervisor
        .write_roster_summary_for_resident(&resident, &fresh_pull)
        .await;
    assert!(
        fresh.is_some(),
        "a stamped-zero pull starts the slot: {fresh:?}"
    );
    assert_eq!(entry_level(), serde_json::json!("off"));
    // In-order deltas apply (the newer level lands).
    let applied = delta(&supervisor, "seq-token", "high", Some(2), "i1").await;
    assert!(applied.success, "sequence 2 applies: {applied:?}");
    assert_eq!(entry_level(), serde_json::json!("high"));
    // The delayed older snapshot (sequence 1, delivered after 2) answers
    // success but never overwrites the newer state.
    let stale = delta(&supervisor, "seq-token", "low", Some(1), "i1").await;
    assert!(
        stale.success,
        "a stale delta still answers success: {stale:?}"
    );
    assert_eq!(
        entry_level(),
        serde_json::json!("high"),
        "the stale snapshot never overwrites the newer one"
    );
    // A newer sequence applies again.
    let applied = delta(&supervisor, "seq-token", "low", Some(3), "i1").await;
    assert!(applied.success, "sequence 3 applies: {applied:?}");
    assert_eq!(entry_level(), serde_json::json!("low"));
    // The authoritative pull gates in the same lock section that
    // writes: the summary's embedded counter (the get_state snapshot
    // read the worker's counter, stamped with the answering
    // instance) applies and raises the watermark, so a delta still in
    // flight when the pull answered is dropped instead of
    // overwriting the pull's fresher state.
    let mut pulled = summary("off");
    pulled["rosterDeltaSequence"] = serde_json::json!(4);
    pulled["workerInstanceId"] = serde_json::json!("i1");
    let pull = supervisor
        .write_roster_summary_for_resident(&resident, &pulled)
        .await;
    assert_eq!(
        pull.expect("pull entry").summary["thinkingLevel"],
        serde_json::json!("off")
    );
    assert_eq!(entry_level(), serde_json::json!("off"));
    let stale = delta(&supervisor, "seq-token", "high", Some(4), "i1").await;
    assert!(
        stale.success,
        "the in-flight delta answers success: {stale:?}"
    );
    assert_eq!(
        entry_level(),
        serde_json::json!("off"),
        "a delta older than the pull never overwrites the pull"
    );
    // A pull whose counter is below the applied watermark is stale:
    // a delta stamped after the pull's snapshot already applied, so
    // the older in-flight refresh never overwrites it.
    let mut stale_pull = summary("medium");
    stale_pull["rosterDeltaSequence"] = serde_json::json!(3);
    stale_pull["workerInstanceId"] = serde_json::json!("i1");
    assert!(
        supervisor
            .write_roster_summary_for_resident(&resident, &stale_pull)
            .await
            .is_none(),
        "an older in-flight refresh drops"
    );
    assert_eq!(entry_level(), serde_json::json!("off"));
    // A delayed ZERO-counter pull is sequenced like any other: its
    // snapshot was taken before the first push, so once a newer
    // delta applied it is the stale one and drops instead of
    // overwriting the newer state with pre-change data.
    let mut zero_pull = summary("high");
    zero_pull["rosterDeltaSequence"] = serde_json::json!(0);
    zero_pull["workerInstanceId"] = serde_json::json!("i1");
    assert!(
        supervisor
            .write_roster_summary_for_resident(&resident, &zero_pull)
            .await
            .is_none(),
        "a delayed pre-push pull never overwrites a newer delta"
    );
    assert_eq!(entry_level(), serde_json::json!("off"));
    // A replacement process registers (the registration notes the
    // new generation) and its counter-restarted sequences apply —
    // never compared against the predecessor's watermark.
    supervisor
        .roster
        .lock()
        .unwrap()
        .note_worker_generation("seq-worker", "i2");
    let replacement = delta(&supervisor, "seq-token", "medium", Some(1), "i2").await;
    assert!(
        replacement.success,
        "the replacement applies: {replacement:?}"
    );
    assert_eq!(entry_level(), serde_json::json!("medium"));
    // The predecessor's delayed frames drop on the generation
    // mismatch whatever their sequence: the replacement's
    // registration made them stale by construction.
    let predecessor = delta(&supervisor, "seq-token", "high", Some(9_000_000), "i1").await;
    assert!(
        predecessor.success,
        "a superseded frame still answers success: {predecessor:?}"
    );
    assert_eq!(entry_level(), serde_json::json!("medium"));
    // A delayed pull answered by the replaced process drops the same
    // way — its high counter never pins the replacement's restarted
    // counter out of the roster.
    let mut predecessor_pull = summary("low");
    predecessor_pull["rosterDeltaSequence"] = serde_json::json!(9_000_000);
    predecessor_pull["workerInstanceId"] = serde_json::json!("i1");
    assert!(
        supervisor
            .write_roster_summary_for_resident(&resident, &predecessor_pull)
            .await
            .is_none(),
        "a superseded pull drops"
    );
    assert_eq!(entry_level(), serde_json::json!("medium"));
    // The predecessor's DELAYED zero-counter pull drops the same
    // way on the generation mismatch: the stamped zero orders
    // against the slot, it is not the unsequenced legacy value.
    let mut predecessor_zero_pull = summary("low");
    predecessor_zero_pull["rosterDeltaSequence"] = serde_json::json!(0);
    predecessor_zero_pull["workerInstanceId"] = serde_json::json!("i1");
    assert!(
        supervisor
            .write_roster_summary_for_resident(&resident, &predecessor_zero_pull)
            .await
            .is_none(),
        "a superseded zero-counter pull drops"
    );
    assert_eq!(entry_level(), serde_json::json!("medium"));
    // An unsequenced delta applies (a caller that stamped nothing).
    let unsequenced = delta(&supervisor, "seq-token", "low", None, "i2").await;
    assert!(unsequenced.success, "unsequenced applies: {unsequenced:?}");
    assert_eq!(entry_level(), serde_json::json!("low"));
    // A wrong token still fails authentication, before the gate.
    let rejected = delta(&supervisor, "wrong-token", "high", Some(9), "i2").await;
    assert!(
        !rejected.success,
        "authentication still gates: {rejected:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Wrap one delta's fields in the parsed frame shape the handler takes
/// (unsequenced: these tests exercise the batching cadence, not the
/// stale-delta gate).
fn delta_frame(worker_token: &str, summary: Value, removed: Vec<String>) -> WorkerRosterDelta {
    WorkerRosterDelta {
        worker_token: worker_token.to_string(),
        summary,
        removed,
        sequence: None,
        worker_instance_id: None,
    }
}

/// TS parity for the delta push cadence (`daemon-supervisor.ts`
/// `applyWorkerRosterDelta` + `scheduleRosterPush`): one
/// `worker_roster_delta` produces one `roster_update` — the entry
/// write and the removals batch into one coalesced flush, never one
/// push per mutation. A subscriber counts the pushes, so a duplicate
/// is wire-visible.
#[tokio::test]
async fn worker_roster_delta_pushes_one_update_per_flip() {
    let dir = tempfile::tempdir().expect("temp dir");
    let supervisor = Arc::new(supervisor_with_registered_worker(dir.path()).await);
    let mut events = supervisor.events.subscribe();

    // The busy flip of a turn start: one push, running.
    supervisor
        .handle_worker_roster_delta(
            "d1",
            "worker_roster_delta",
            delta_frame("delta-token", flip_summary(dir.path(), true), Vec::new()),
        )
        .await;
    let pushes = drain_roster_pushes(&mut events);
    assert_eq!(pushes.len(), 1, "one roster_update per delta: {pushes:?}");
    assert_eq!(pushes[0]["changed"][0]["status"], "running");
    assert_eq!(
        pushes[0]["changed"][0]["summary"]["activeSessionId"],
        "a-delta"
    );

    // The idle flip at settle: one push, idle.
    supervisor
        .handle_worker_roster_delta(
            "d2",
            "worker_roster_delta",
            delta_frame("delta-token", flip_summary(dir.path(), false), Vec::new()),
        )
        .await;
    let pushes = drain_roster_pushes(&mut events);
    assert_eq!(pushes.len(), 1, "one roster_update per delta: {pushes:?}");
    assert_eq!(pushes[0]["changed"][0]["status"], "idle");
}

/// A delta carrying removals batches them with the summary write into
/// the same single push (the TS apply writes entries and deletes
/// removals before the one `scheduleRosterPush` flush).
#[tokio::test]
async fn worker_roster_delta_batches_removals_into_the_same_push() {
    let dir = tempfile::tempdir().expect("temp dir");
    let supervisor = Arc::new(supervisor_with_registered_worker(dir.path()).await);
    let mut events = supervisor.events.subscribe();

    // A child agent the delta will remove: a subagent summary keyed
    // parent session path + child id.
    let child_summary = json!({
        "activity": "idle",
        "isSessionActive": false,
        "activeSessionId": "a-child",
        "sessionId": "s-child",
        "rlmChildId": "c-1",
        "parentSessionPath": dir
            .path()
            .join("session.jsonl")
            .to_string_lossy(),
        "runtimeKind": "subagent",
        "rlmDepth": 1,
    });
    supervisor
        .handle_worker_roster_delta(
            "d1",
            "worker_roster_delta",
            delta_frame("delta-token", child_summary, Vec::new()),
        )
        .await;
    let child_pushes = drain_roster_pushes(&mut events);
    assert_eq!(
        child_pushes.len(),
        1,
        "one roster_update per delta: {child_pushes:?}"
    );
    let child_agent_id = child_pushes[0]["changed"][0]["agentId"]
        .as_str()
        .expect("child agent id")
        .to_string();

    // One delta carrying both the parent's summary and the child
    // removal: still exactly one push, entry and removal together.
    supervisor
        .handle_worker_roster_delta(
            "d2",
            "worker_roster_delta",
            delta_frame(
                "delta-token",
                flip_summary(dir.path(), true),
                vec![child_agent_id.clone()],
            ),
        )
        .await;
    let pushes = drain_roster_pushes(&mut events);
    assert_eq!(
        pushes.len(),
        1,
        "removals batch into the delta push: {pushes:?}"
    );
    assert_eq!(pushes[0]["changed"].as_array().map(Vec::len), Some(1));
    assert_eq!(pushes[0]["removed"][0], json!(child_agent_id));
}

/// The busy/idle flip cadence benchmark: alternating deltas against a
/// subscribed supervisor, counting `roster_update` pushes and their
/// serialized payloads per flip. Each push serializes twice
/// supervisor-side (the changed entries and the outbound frame), so
/// the serialization count is double the push count. Run with
/// `cargo test -p pa-daemon roster_delta_push_benchmark -- --ignored
/// --nocapture`.
#[ignore = "manual roster delta push benchmark"]
#[tokio::test]
async fn roster_delta_push_benchmark() {
    const FLIPS: usize = 2000;
    const WARMUP_FLIPS: usize = 50;
    let dir = tempfile::tempdir().expect("temp dir");
    let supervisor = Arc::new(supervisor_with_registered_worker(dir.path()).await);
    let mut events = supervisor.events.subscribe();

    // Warm-up flips keep allocator noise out of the timed window.
    for i in 0..WARMUP_FLIPS {
        let summary = flip_summary(dir.path(), i % 2 == 0);
        supervisor
            .handle_worker_roster_delta(
                "warm",
                "worker_roster_delta",
                delta_frame("delta-token", summary.clone(), Vec::new()),
            )
            .await;
        drain_roster_pushes(&mut events);
    }

    let mut pushes = 0usize;
    let mut payload_bytes = 0usize;
    let mut handler_nanos = 0u128;
    for i in 0..FLIPS {
        let summary = flip_summary(dir.path(), i % 2 == 0);
        let start = std::time::Instant::now();
        supervisor
            .handle_worker_roster_delta(
                "b",
                "worker_roster_delta",
                delta_frame("delta-token", summary.clone(), Vec::new()),
            )
            .await;
        handler_nanos += start.elapsed().as_nanos();
        for push in drain_roster_pushes(&mut events) {
            pushes += 1;
            payload_bytes += serde_json::to_string(&push).map_or(0, |payload| payload.len());
        }
    }
    let flips = FLIPS as f64;
    println!("flips: {FLIPS}");
    println!(
        "roster_update pushes: {pushes} ({:.3}/flip)",
        pushes as f64 / flips
    );
    println!(
        "supervisor-side serializations: {} ({:.3}/flip; two per push)",
        2 * pushes,
        2.0 * pushes as f64 / flips
    );
    println!(
        "pushed payload bytes: {payload_bytes} ({:.0}/flip)",
        payload_bytes as f64 / flips
    );
    println!(
        "handler wall time: {:.2} us/flip",
        handler_nanos as f64 / flips / 1000.0
    );
}
