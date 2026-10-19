//! The delete of an RLM child whose worker process is gone: the resident
//! delete completes without a worker handshake, and a retry after the
//! ledger boundary already stands succeeds only once the worker is gone.

use super::*;

struct Fixture {
    _dir: tempfile::TempDir,
    supervisor: Arc<Supervisor>,
    child_file: String,
    ledger: Arc<crate::rlm_ledger::RlmSpawnLedger>,
}

async fn fixture() -> Fixture {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let supervisor = Arc::new(
        Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir,
        })
        .expect("supervisor"),
    );
    let child_file = sessions_dir.join("child-dead.jsonl");
    std::fs::write(
        &child_file,
        "{\"type\":\"session\",\"version\":3,\"id\":\"child-dead\",\"timestamp\":\"t\",\"cwd\":\"/c\"}\n",
    )
    .unwrap();
    let parent_file = sessions_dir.join("parent.jsonl");
    std::fs::write(&parent_file, "{\"type\":\"session\",\"id\":\"p\"}\n").unwrap();
    let ledger = supervisor
        .rlm_spawn_ledger_for(None)
        .await
        .expect("the spawn ledger resolves");
    let child_file = child_file.to_string_lossy().into_owned();
    ledger
        .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
            child_id: "sub-dead".to_string(),
            parent: parent_file.to_string_lossy().into_owned(),
            child: child_file.clone(),
            depth: 1,
            name: "dead-worker".to_string(),
        })
        .expect("the spawn edge appends");
    Fixture {
        _dir: dir,
        supervisor,
        child_file,
        ledger,
    }
}

/// The child worker's descriptor, persisted under the supervisor's descriptor dir.
fn child_descriptor(
    supervisor: &Supervisor,
    child_file: &str,
    pid: u32,
    start_id: Option<&str>,
) -> (DaemonWorkerDescriptor, std::path::PathBuf) {
    let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
        "version": 2,
        "workerId": "w-child",
        "pid": pid,
        "processStartId": start_id,
        "socketPath": "/tmp/none.sock",
        "recoveryJournalPath": "/tmp/none.jsonl",
        "supervisorSocketPath": supervisor.options.socket_path.to_string_lossy(),
        "authenticationToken": "token",
        "rootActiveSessionId": "w-child",
        "sessionFile": child_file,
        "createdAt": "t",
        "updatedAt": "t",
        "lifecycle": "ready",
        "createCommand": { "rlmDepth": 1, "rlmChildId": "sub-dead" },
        "consecutiveFailures": 0,
    }))
    .expect("descriptor");
    let path = supervisor.descriptor_dir.join("w-child.json");
    crate::descriptor::persist_worker(&path, &descriptor).expect("descriptor persists");
    (descriptor, path)
}

/// A pid that provably belonged to a process which has exited and been reaped.
fn reaped_pid() -> (u32, Option<String>) {
    let mut child = std::process::Command::new("true")
        .spawn()
        .expect("spawn true");
    let pid = child.id();
    let start_id = crate::lease::get_process_start_id(pid);
    child.wait().expect("reap true");
    (pid, start_id)
}

async fn route_delete(supervisor: &Arc<Supervisor>) -> Value {
    let (targeted_tx, _targeted_rx) = tokio::sync::mpsc::channel::<Arc<Value>>(16);
    let attached = subscribers::ClientSubscriptions::new("c".to_string(), targeted_tx);
    let command: DaemonCommand = serde_json::from_value(json!({
        "type": "kill",
        "activeSessionId": "w-child",
        "rlmLedgerDelete": "user",
        "rlmChildId": "sub-dead",
    }))
    .expect("command");
    let (lines, _) = supervisor
        .route_client_command(
            &command,
            "c",
            &attached,
            "k-1".to_string(),
            "kill".to_string(),
            None,
        )
        .await;
    lines.into_iter().next().expect("one response line")
}

/// A reaped worker awaiting its relaunch can never answer the kill: the delete
/// succeeds from the ledger boundary alone instead of answering the route's
/// not-connected failure after the stop already ran.
#[tokio::test]
async fn a_delete_of_a_dead_workers_child_completes_without_a_handshake() {
    let Fixture {
        _dir,
        supervisor,
        child_file,
        ledger,
    } = fixture().await;
    let (pid, start_id) = reaped_pid();
    let (descriptor, descriptor_path) =
        child_descriptor(&supervisor, &child_file, pid, start_id.as_deref());
    let resident = ResidentWorker::new("w-child".to_string(), descriptor, descriptor_path.clone());
    resident.note_session_ready();
    supervisor.registry.insert(Arc::clone(&resident)).await;

    let response = route_delete(&supervisor).await;

    assert_eq!(response["success"], json!(true), "{response}");
    assert!(supervisor.registry.get("w-child").await.is_none());
    assert!(
        !descriptor_path.exists(),
        "the dead worker's descriptor retires"
    );
    assert!(ledger.live_edges().expect("edges").is_empty());
}

/// Liveness, not route state, gates the short-circuit: a live worker still
/// receives the kill.
#[tokio::test]
async fn a_delete_of_a_live_workers_child_still_routes_the_kill() {
    let Fixture {
        _dir,
        supervisor,
        child_file,
        ..
    } = fixture().await;
    let mut sleeper = std::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .expect("spawn sleep");
    let pid = sleeper.id();
    let (descriptor, descriptor_path) = child_descriptor(
        &supervisor,
        &child_file,
        pid,
        crate::lease::get_process_start_id(pid).as_deref(),
    );
    let resident = ResidentWorker::new("w-child".to_string(), descriptor, descriptor_path);
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<WorkerRequest>(4);
    *resident.cmd_tx.lock().await = Some(cmd_tx);
    let pump_resident = Arc::clone(&resident);
    let pump = tokio::spawn(async move {
        let mut seen = Vec::new();
        while let Some(request) = cmd_rx.recv().await {
            seen.push(request.command_type.clone());
            if let Some(reply) = pump_resident
                .pending
                .lock()
                .await
                .remove(&request.request_id)
            {
                let _ = reply.send(WorkerReply::Typed(crate::protocol::response_success(
                    None,
                    &request.command_type,
                    None,
                )));
            }
            if request.command_type == "shutdown" {
                break;
            }
        }
        seen
    });
    resident.note_connection_live();
    resident.note_session_ready();
    supervisor.registry.insert(Arc::clone(&resident)).await;

    let response = route_delete(&supervisor).await;

    let _ = sleeper.kill();
    let _ = sleeper.wait();
    assert_eq!(response["success"], json!(true), "{response}");
    let seen = pump.await.expect("pump");
    assert_eq!(seen.first().map(String::as_str), Some("kill"), "{seen:?}");
}

/// A retry after the boundary already stands is idempotent once the worker is
/// gone, and refused while its process still runs.
#[tokio::test]
async fn a_retried_delete_after_the_tombstone_is_gated_on_the_worker_process() {
    let Fixture {
        _dir,
        supervisor,
        child_file,
        ledger,
    } = fixture().await;
    ledger
        .append_delete(
            "sub-dead",
            &child_file,
            crate::rlm_ledger::RlmLedgerDeleteReason::User,
        )
        .expect("the first attempt's tombstone");
    let retry = || {
        supervisor.tombstone_saved_rlm_child(
            "w-child",
            Some("sub-dead"),
            crate::rlm_ledger::RlmLedgerDeleteReason::User,
        )
    };

    // The first attempt stopped after the tombstone, before archiving or
    // sweeping artifacts. A successful retry must finish that cleanup.
    let artifacts = crate::scheduled_jobs::session_artifact_dir(
        std::path::Path::new(&child_file),
        "child-dead",
    )
    .expect("artifact directory");
    std::fs::create_dir_all(&artifacts).unwrap();
    std::fs::write(
        artifacts.join("unfinished.txt"),
        "left by interrupted delete",
    )
    .unwrap();
    let (pid, start_id) = reaped_pid();
    child_descriptor(&supervisor, &child_file, pid, start_id.as_deref());
    retry()
        .await
        .expect("a dead worker no longer blocks the delete");
    assert!(!artifacts.exists(), "the retry finishes the artifact sweep");
    assert_eq!(
        crate::session_store::read_session_info(std::path::Path::new(&child_file))
            .expect("session metadata")
            .state
            .as_deref(),
        Some("archived"),
        "the retry archives the stopped session"
    );

    let mut sleeper = std::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .expect("spawn sleep");
    let live_pid = sleeper.id();
    child_descriptor(
        &supervisor,
        &child_file,
        live_pid,
        crate::lease::get_process_start_id(live_pid).as_deref(),
    );
    let ledger_before = std::fs::read(ledger.ledger_path()).unwrap();
    let refused = retry().await;
    let _ = sleeper.kill();
    let _ = sleeper.wait();
    let error = format!(
        "{:#}",
        refused.expect_err("a live worker refuses the delete")
    );
    assert!(error.contains(&format!("(pid {live_pid})")), "{error}");
    assert_eq!(std::fs::read(ledger.ledger_path()).unwrap(), ledger_before);
}
