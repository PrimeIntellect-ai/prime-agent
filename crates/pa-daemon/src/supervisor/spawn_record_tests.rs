//! The spawn-record durability oracles: the descriptor writes around a
//! worker's create and relaunch — the fresh create's unsynced spawn
//! record, the relaunch's synced one, and the known-resident
//! registration's in-memory refresh — witnessed on the REAL launch
//! paths through the atomic-write probe (the durability class is not
//! observable in the persisted bytes).

use super::*;

/// The witness supervisor for the launch oracles: a per-test uuid
/// tempdir whose descriptor dir is the probe's drain root, with the
/// launch-probe budget pinned to 1 ms. No live worker ever answers —
/// the launch fails at the probe, after the spawn record served.
fn spawn_record_witness(tag: &str) -> (Arc<Supervisor>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("pa-spawnrec-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.join("daemon.sock"),
            agent_dir,
        })
        .expect("supervisor"),
    );
    supervisor.pin_worker_connect_budget_for_tests(Duration::from_millis(1));
    (supervisor, dir)
}

/// A known-resident registration refreshes the resident's descriptor in
/// memory and writes nothing to disk: the spawn record stays the on-disk
/// state until the create-completion persist owns the next durable
/// write.
#[tokio::test]
async fn a_known_resident_registration_writes_nothing_to_disk() {
    let dir = std::env::temp_dir().join(format!("pa-regskip-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.join("daemon.sock"),
            agent_dir: agent_dir.clone(),
        })
        .expect("supervisor"),
    );
    let descriptor_path = dir.join("w-regskip.json");
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
        "version": 2,
        "workerId": "w-regskip",
        "pid": 4242,
        "socketPath": "/tmp/w-regskip.sock",
        "recoveryJournalPath": "/tmp/none.jsonl",
        "supervisorSocketPath": "/tmp/none.sock",
        "authenticationToken": "reg-token",
        "rootActiveSessionId": "w-regskip",
        "createdAt": "2026-10-01T00:00:00Z",
        "updatedAt": "2026-10-01T00:00:00Z",
        "lifecycle": "starting",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    // The spawn record in the fresh-create shape (the atomic rename,
    // no fsync), from the same descriptor value the resident owns.
    crate::descriptor::persist_worker_at(
        &descriptor_path,
        &descriptor,
        crate::descriptor::TempSync::Unsynced,
    )
    .expect("the spawn record lands");
    let spawn_record = std::fs::read(&descriptor_path).expect("the spawn record is on disk");
    let resident =
        ResidentWorker::new("w-regskip".to_string(), descriptor, descriptor_path.clone());
    supervisor.registry.insert(Arc::clone(&resident)).await;

    let command = DaemonCommand::WorkerRegister {
        id: None,
        active_session_id: "w-regskip".to_string(),
        session_id: None,
        socket_path: "/tmp/w-regskip-live.sock".to_string(),
        worker_instance_id: "inst-live".to_string(),
        token: "reg-token".to_string(),
        pid: 4242,
        rest: Map::default(),
    };
    let response = supervisor
        .handle_worker_register("r1", "worker_register", &command)
        .await;
    assert!(
        response.success,
        "the registration itself succeeds: {response:?}"
    );

    // DISK: byte-identical to the spawn record — the registration writes
    // nothing; the create-completion persist owns the next durable state.
    let after = std::fs::read(&descriptor_path).expect("the spawn record stays readable");
    assert_eq!(
        after, spawn_record,
        "the registration must not write the descriptor"
    );

    // MEMORY: the resident's live identity still refreshes (the routing
    // surfaces read it) — the registration is not a no-op, only its
    // durable write is gone.
    let descriptor = resident.descriptor.lock().await;
    assert_eq!(descriptor.lifecycle, DaemonWorkerLifecycle::Ready);
    assert_eq!(
        descriptor.socket_path, "/tmp/w-regskip-live.sock",
        "the live socket refreshes in memory"
    );
    assert_eq!(
        descriptor.worker_instance_id.as_deref(),
        Some("inst-live"),
        "the live instance id refreshes in memory"
    );
}

/// A relaunch REPLACES an established, already-durable descriptor, so
/// its spawn record is the synced persist — a torn unsynced replacement
/// could lose the descriptor's whole payload (the recovery journal
/// pointer and the durable create command the next boot's revival
/// replays). The oracle drives the real relaunch path; it fails at the
/// worker probe (nothing listens on the per-test socket), after the
/// spawn record served.
#[tokio::test]
async fn a_relaunch_spawn_record_serves_the_durable_persist() {
    let (supervisor, dir) = spawn_record_witness("relaunch");
    let descriptor_path = dir.join("w-relaunch.json");
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
        "version": 2,
        "workerId": "w-relaunch",
        "pid": 4242,
        "socketPath": dir.join("w-relaunch.sock").to_string_lossy(),
        "recoveryJournalPath": "/tmp/w-relaunch.recovery.jsonl",
        "supervisorSocketPath": "/tmp/none.sock",
        "authenticationToken": "spawnrec-token",
        "rootActiveSessionId": "w-relaunch",
        "createdAt": "2026-10-01T00:00:00Z",
        "updatedAt": "2026-10-01T00:00:00Z",
        "lifecycle": "ready",
        "createCommand": {},
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let resident = ResidentWorker::new(
        "w-relaunch".to_string(),
        descriptor,
        descriptor_path.clone(),
    );
    supervisor.registry.insert(Arc::clone(&resident)).await;

    let _ = crate::descriptor::atomic_write_probe::take_under(&descriptor_path);
    let outcome = supervisor.relaunch_worker(&resident).await;
    assert!(
        outcome.is_err(),
        "no live worker: the relaunch fails at the probe, after the spawn record served"
    );
    let writes = crate::descriptor::atomic_write_probe::take_under(&descriptor_path);
    let spawn_records: Vec<_> = writes
        .iter()
        .filter(|(path, _)| path == &descriptor_path)
        .collect();
    assert!(
        !spawn_records.is_empty(),
        "the relaunch wrote its spawn record"
    );
    assert!(
        spawn_records
            .iter()
            .all(|(_, sync)| matches!(sync, TempSync::Synced)),
        "the relaunch's spawn record is the synced persist: {spawn_records:?}"
    );
    // The record's content is the spawn-time `Starting` state either
    // class writes; the durability class is the probe's business.
    let persisted: DaemonWorkerDescriptor = serde_json::from_str(
        &std::fs::read_to_string(&descriptor_path).expect("the spawn record is readable"),
    )
    .expect("parse the spawn record");
    assert_eq!(persisted.lifecycle, DaemonWorkerLifecycle::Starting);
    assert!(persisted.pid > 0, "the spawned pid rides the record");
}

/// A fresh create's spawn record keeps the unsynced TS `persistWorker`
/// shape (TS's `writeFileAtomicSync` fsync is opt-in and the descriptor
/// family never requests it); the create-completion persist
/// (`launch_worker`'s post-create write) re-establishes the durable
/// write as the metadata-survival barrier. The oracle drives the real
/// launch path; it fails at the worker probe (no live worker), after
/// the spawn record served.
#[tokio::test]
async fn a_fresh_create_spawn_record_keeps_the_unsynced_shape() {
    let (supervisor, dir) = spawn_record_witness("freshcreate");
    let create = DaemonCommand::Create {
        id: None,
        session_path: Some(dir.join("s.jsonl").to_string_lossy().to_string()),
        continue_recent: None,
        no_session: None,
        name: Some("faux".to_string()),
        config: None,
        telemetry_disabled: None,
        runtime_metadata: None,
        lifecycle: None,
        env: None,
        launch_env: None,
        rest: Map::default(),
    };

    let _ = crate::descriptor::atomic_write_probe::take_under(&supervisor.descriptor_dir);
    let outcome = supervisor.launch_worker(&create, None).await;
    assert!(
        outcome.is_err(),
        "no live worker: the fresh launch fails at the probe"
    );
    let writes = crate::descriptor::atomic_write_probe::take_under(&supervisor.descriptor_dir);
    let spawn_records: Vec<_> = writes
        .iter()
        .filter(|(path, _)| path.starts_with(&supervisor.descriptor_dir))
        .collect();
    assert!(
        !spawn_records.is_empty(),
        "the fresh create wrote its spawn record"
    );
    assert!(
        spawn_records
            .iter()
            .all(|(_, sync)| matches!(sync, TempSync::Unsynced)),
        "the fresh create's spawn record stays the unsynced TS shape: {spawn_records:?}"
    );
}
