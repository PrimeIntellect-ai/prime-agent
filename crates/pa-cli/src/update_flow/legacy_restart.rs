//! Post-install restart handoff from shipped TypeScript updaters. Those
//! callers have already activated the release and supply a fresh status path;
//! they cannot enter the staged Rust activation transaction.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use pa_types::daemon::update_flow::{
    UpdateId, UpdateProcessIdentity, UpdateRoster, UpdateTimeoutBudget,
};
use pa_types::daemon::DaemonCommand;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::successor::{identity_from_hello, spawn_supervisor, wait_for_exit, wait_for_hello};

pub(super) async fn run(
    socket: &Path,
    status_path: &Path,
    agent_dir: &Path,
    origin: Option<&str>,
) -> Result<i32> {
    let directories = super::legacy_admission::Admission::directories()?;
    run_in(socket, status_path, agent_dir, origin, &directories).await
}

async fn run_in(
    socket: &Path,
    status_path: &Path,
    agent_dir: &Path,
    origin: Option<&str>,
    directories: &[std::path::PathBuf],
) -> Result<i32> {
    let id = UpdateId::from(format!(
        "legacy-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let now = crate::util_time::now_iso8601();
    let status = Arc::new(Mutex::new(json!({
        "version": 1, "requestId": id, "socketPath": socket,
        "phase": "starting", "coordinator": super::status::coordinator_identity(),
        "counts": {"total":0,"restored":0,"resumed":0,"failed":0},
        "startedAt":now,"updatedAt":now,"heartbeatAt":now
    })));
    persist(status_path, &*status.lock().await)?;
    let socket_text = socket.to_string_lossy();
    match super::intent::acquire(agent_dir, &socket_text, &id, status_path)? {
        super::intent::AcquireOutcome::Acquired => {}
        super::intent::AcquireOutcome::Join { .. } => {
            let mut value = status.lock().await;
            value["phase"] = json!("failed");
            value["message"] =
                json!("Another update restart is already running; retry after it completes");
            persist(status_path, &value)?;
            return Ok(1);
        }
    }
    let result = async {
        let mut admission = super::legacy_admission::Admission::acquire(directories).await?;
        let operation = restart(socket, status_path, agent_dir, &id, origin, &status);
        tokio::pin!(operation);
        let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
        let outcome = loop {
            tokio::select! {
                result = &mut operation => break result,
                _ = heartbeat.tick() => {
                    if let Err(error) = admission.refresh().await {
                        break Err(error);
                    }
                    let mut value = status.lock().await;
                    value["heartbeatAt"] = json!(crate::util_time::now_iso8601());
                    if let Err(error) = persist(status_path, &value) {
                        break Err(error);
                    }
                }
            }
        };
        let release = admission.release().await;
        outcome.and(release)
    }
    .await;
    let mut value = status.lock().await;
    if let Err(error) = &result {
        value["phase"] = json!("failed");
        value["message"] = json!(format!("{error:#}"));
    }
    value["updatedAt"] = json!(crate::util_time::now_iso8601());
    let final_write = persist(status_path, &value);
    let release = super::intent::release(agent_dir, &socket_text);
    final_write?;
    release?;
    Ok(i32::from(result.is_err()))
}

async fn restart(
    socket: &Path,
    status_path: &Path,
    agent_dir: &Path,
    id: &UpdateId,
    origin: Option<&str>,
    status: &Arc<Mutex<Value>>,
) -> Result<()> {
    let budget = UpdateTimeoutBudget::from_env();
    let recovery_dir = agent_dir.join("legacy-update-recovery");
    let socket_key = pa_daemon::paths::hash_key(&socket.to_string_lossy(), 64);
    let roster_path = recovery_dir.join(format!("{socket_key}.json"));
    let attempt_path = recovery_dir.join(format!("{socket_key}.attempt.json"));
    let source_path = agent_dir
        .join("daemon-update-restarts")
        .join(format!("{socket_key}.json"));
    let connection = pa_tui::daemon_client::DaemonClient::connect(socket).await;
    let (client, _events) = match connection {
        Ok(connection) => connection,
        Err(error) => {
            // A reachable but incompatible daemon is not an absent daemon.
            if pa_daemon::socket::can_connect(socket, Duration::from_secs(1)).await {
                return Err(error).context("connect to the previous daemon");
            }
            match recover_prepared(&roster_path, &attempt_path, &source_path, socket, None)? {
                Some(roster) => {
                    let predecessor = UpdateProcessIdentity {
                        pid: roster.supervisor.pid,
                        process_start_id: roster.supervisor.process_start_id.clone(),
                        supervisor_generation: Some(roster.supervisor.generation.clone()),
                        supervisor_owner_token: None,
                        rest: serde_json::Map::new(),
                    };
                    anyhow::ensure!(
                        wait_for_exit(&predecessor, budget.predecessor_exit_ms).await,
                        "the checkpoint predecessor has not verifiably exited"
                    );
                    return boot_roster(
                        socket,
                        status_path,
                        &roster_path,
                        &roster,
                        status,
                        &budget,
                    )
                    .await;
                }
                None => anyhow::ensure!(
                    !attempt_path.exists(),
                    "preparation attempt is pending; retain it until its manifest is available"
                ),
            }
            status.lock().await["phase"] = json!("skipped");
            return Ok(());
        }
    };
    let hello = client.hello().clone();
    let predecessor = identity_from_hello(&hello);
    anyhow::ensure!(
        predecessor.pid > 0,
        "previous daemon supplied no process identity"
    );
    {
        let mut value = status.lock().await;
        value["phase"] = json!("preparing");
        value["predecessor"] = json!(predecessor);
        persist(status_path, &value)?;
    }
    let roster = if let Some(roster) = recover_prepared(
        &roster_path,
        &attempt_path,
        &source_path,
        socket,
        Some(&hello),
    )? {
        roster
    } else {
        anyhow::ensure!(
            !attempt_path.exists(),
            "preparation attempt is pending; retry after its manifest is durable"
        );
        std::fs::create_dir_all(&recovery_dir)?;
        // Write the owner binding before the RPC: TS commits and stops its
        // workers before replying, so a disconnected caller must recover disk.
        let previous = match std::fs::read_to_string(&source_path) {
            Ok(text) => Some(pa_daemon::paths::hash_key(&text, 64)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        persist(
            &attempt_path,
            &json!({
                "socket": socket, "version": crate::config::version(), "hello": hello,
                "startedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis(),
                "previousDigest": previous, "updateId": id, "origin": origin,
            }),
        )?;
        let response = client
            .request_supervisor_with_id(
                DaemonCommand::PrepareUpdateRestart {
                    id: None,
                    update_id: None,
                    rest: serde_json::Map::new(),
                },
                &format!("daemon_{}-prepare", id.0),
                // The shipped TS coordinator allows 120s; its own preparation
                // deadline is 100s, followed by worker commit and shutdown.
                budget.prepare_ms.max(120_000),
            )
            .await;
        let refused = response.as_ref().is_ok_and(|response| !response.success);
        let manifest = match response {
            Ok(response) if response.success => response
                .data
                .context("previous daemon supplied no session recovery manifest"),
            Ok(response) => Err(anyhow::anyhow!(
                "could not prepare TypeScript sessions: {}",
                response.error.unwrap_or_default()
            )),
            Err(error) => {
                Err(error).context("prepare TypeScript sessions before stopping the daemon")
            }
        };
        match manifest {
            Ok(manifest) => {
                let roster = super::legacy_roster::convert(&manifest, &hello, id, socket, origin)?;
                validate_recovery(&roster, socket, crate::config::version())?;
                persist(&roster_path, &serde_json::to_value(&roster)?)?;
                roster
            }
            Err(error) => {
                if let Some(roster) = recover_prepared(
                    &roster_path,
                    &attempt_path,
                    &source_path,
                    socket,
                    Some(&hello),
                )? {
                    roster
                } else {
                    if refused {
                        std::fs::remove_file(&attempt_path)?;
                    }
                    return Err(error);
                }
            }
        }
    };
    {
        let mut value = status.lock().await;
        value["phase"] = json!("stopping");
        value["counts"]["total"] = json!(roster.sessions.len());
        persist(status_path, &value)?;
    }
    // A lost prepare reply can also close the connection. Reconnect before
    // shutdown and verify we still address the recorded predecessor.
    drop(client);
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(socket).await?;
    anyhow::ensure!(
        identity_from_hello(client.hello()) == predecessor,
        "predecessor changed before shutdown"
    );
    // TS deduplicates by client ID and envelope ID across connections.
    // A reconnected client's default counter restarts at daemon_1, which
    // would replay the prepare result instead of executing shutdown.
    let shutdown = client
        .request_supervisor_with_id(
            DaemonCommand::Shutdown {
                id: None,
                force: None,
                rest: serde_json::Map::new(),
            },
            &format!("daemon_{}-shutdown", id.0),
            30_000,
        )
        .await;
    // TS shutdown waits for client sockets to close before exiting.
    // Drop the writer here; `close()` alone leaves its channel alive.
    drop(client);
    anyhow::ensure!(
        wait_for_exit(&predecessor, budget.predecessor_exit_ms).await,
        "previous daemon did not stop: {shutdown:?}"
    );
    boot_roster(socket, status_path, &roster_path, &roster, status, &budget).await
}

// A source TS manifest contains no owner identity. Only adopt one written
// during an attempt whose durable owner/socket binding we recorded ourselves.
fn recover_prepared(
    roster_path: &Path,
    attempt_path: &Path,
    source_path: &Path,
    socket: &Path,
    live_hello: Option<&Value>,
) -> Result<Option<UpdateRoster>> {
    let roster = match std::fs::read(roster_path) {
        Ok(bytes) => Some(serde_json::from_slice::<UpdateRoster>(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(roster) = roster {
        validate_recovery(&roster, socket, crate::config::version())?;
        if let Some(hello) = live_hello {
            let owner = identity_from_hello(hello);
            anyhow::ensure!(
                owner.pid == roster.supervisor.pid
                    && owner.process_start_id == roster.supervisor.process_start_id
                    && owner.supervisor_generation.as_deref()
                        == Some(roster.supervisor.generation.as_str()),
                "recovery checkpoint belongs to another predecessor"
            );
        }
        return Ok(Some(roster));
    }
    let attempt: Value = match std::fs::read(attempt_path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    anyhow::ensure!(
        attempt["socket"] == socket.to_string_lossy().as_ref()
            && attempt["version"] == crate::config::version(),
        "prepared attempt belongs to another socket or release"
    );
    let recorded = identity_from_hello(&attempt["hello"]);
    anyhow::ensure!(
        recorded.pid > 0
            && recorded.process_start_id.is_some()
            && recorded.supervisor_generation.is_some(),
        "prepared attempt has no fixed predecessor identity"
    );
    if let Some(hello) = live_hello {
        anyhow::ensure!(
            identity_from_hello(hello) == recorded,
            "prepared attempt belongs to another predecessor"
        );
    }
    let text = match std::fs::read_to_string(source_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if attempt["previousDigest"] == pa_daemon::paths::hash_key(&text, 64) {
        return Ok(None);
    }
    let modified = std::fs::metadata(source_path)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis();
    let started = attempt["startedAt"]
        .as_u64()
        .context("prepared attempt has no start time")?;
    anyhow::ensure!(
        modified + 1000 >= u128::from(started),
        "TypeScript recovery manifest is stale"
    );
    let manifest: Value = serde_json::from_str(&text)?;
    let id: UpdateId = serde_json::from_value(attempt["updateId"].clone())?;
    let roster = super::legacy_roster::convert(
        &manifest,
        &attempt["hello"],
        &id,
        socket,
        attempt["origin"].as_str(),
    )?;
    validate_recovery(&roster, socket, crate::config::version())?;
    persist(roster_path, &serde_json::to_value(&roster)?)?;
    Ok(Some(roster))
}

fn validate_recovery(roster: &UpdateRoster, socket: &Path, version: &str) -> Result<()> {
    anyhow::ensure!(
        roster.socket_path == socket.to_string_lossy()
            && roster.binary.to_version == version
            && roster.format_version == 1
            && roster.rest.get("legacy_ts_restart") == Some(&Value::Bool(true)),
        "legacy recovery checkpoint does not match this socket and installed release"
    );
    Ok(())
}

async fn boot_roster(
    socket: &Path,
    status_path: &Path,
    roster_path: &Path,
    roster: &UpdateRoster,
    status: &Arc<Mutex<Value>>,
    budget: &UpdateTimeoutBudget,
) -> Result<()> {
    {
        let mut value = status.lock().await;
        value["phase"] = json!("starting_daemon");
        persist(status_path, &value)?;
    }
    let spawned_pid = spawn_supervisor(
        &std::env::current_exe()?,
        socket,
        Some(roster_path),
        &std::env::current_dir()?,
    )?;
    let successor = wait_for_hello(socket, budget.boot_ms)
        .await
        .context("replacement daemon did not start")?;
    anyhow::ensure!(
        successor.pid == spawned_pid,
        "a different daemon won the socket during migration"
    );
    let (replacement, _events) = pa_tui::daemon_client::DaemonClient::connect(socket).await?;
    let replacement_hello = replacement.hello().clone();
    replacement.close();
    validate_successor(&replacement_hello, spawned_pid, crate::config::version())?;
    {
        let mut value = status.lock().await;
        value["phase"] = json!("restoring");
        value["successor"] = json!(successor);
        persist(status_path, &value)?;
    }
    let (counts, failures) = super::phases::restore_report(socket, budget).await;
    anyhow::ensure!(
        counts.total == roster.sessions.len() as u64,
        "replacement daemon did not finish restoring all migrated sessions"
    );
    {
        let mut value = status.lock().await;
        value["counts"] = json!(counts);
        value["failures"] = json!(failures);
        value["phase"] = json!("complete");
    }
    if counts.failed == 0 {
        std::fs::remove_file(roster_path)?;
        match std::fs::remove_file(roster_path.with_extension("attempt.json")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn validate_successor(hello: &Value, pid: u64, version: &str) -> Result<()> {
    anyhow::ensure!(
        hello.get("appVersion").and_then(Value::as_str) == Some(version)
            && hello.get("schemaId").and_then(Value::as_str)
                == Some(pa_types::daemon::DAEMON_SCHEMA_ID)
            && hello.get("supervisorPid").and_then(Value::as_u64) == Some(pid),
        "replacement daemon does not match the spawned process and installed release"
    );
    Ok(())
}

pub(super) fn persist(path: &Path, value: &Value) -> Result<()> {
    use std::io::Write;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn lost_prepare_reply_adopts_durable_manifest_before_shutdown() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("old.sock");
        let source = directory.path().join("daemon-update-restarts");
        std::fs::create_dir(&source).unwrap();
        let key = pa_daemon::paths::hash_key(&socket.to_string_lossy(), 64);
        let source = source.join(format!("{key}.json"));
        let checkpoint = directory
            .path()
            .join("legacy-update-recovery")
            .join(format!("{key}.json"));
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let (sent, received) = tokio::sync::oneshot::channel();
        let source_copy = source.clone();
        let next_turn = json!([{"customType":"pending","content":"queued witness","display":false,"timestamp":1}]);
        let actions = json!({"formatVersion":1,"actions":[{"payload":{"kind":"turn","message":"queued action"}}]});
        let manifest = json!({"formatVersion":1,"createdAt":"2026-10-09T00:00:00Z","sessions":[{
            "activeSessionId":"old-active", "sessionId":"durable-session", "sessionFile":"/sessions/test.jsonl",
            "cwd":"/project", "config":{}, "queue":{"nextTurn":next_turn,"actions":actions}, "shouldResume":true
        }]});
        let hello = json!({"type":"daemon_hello", "supervisorPid":std::process::id(),
            "supervisorProcessStartId":"fixed-start", "supervisorGeneration":"generation",
            "appVersion":"0.6.0", "protocol":{"name":"prime-agent.daemon","version":7}});
        let owner = hello.clone();
        let server = tokio::spawn(async move {
            let mut prepare_key = None;
            for phase in ["prepare_update_restart", "shutdown"] {
                let (stream, _) = listener.accept().await.unwrap();
                let (read, mut write) = stream.into_split();
                write
                    .write_all(format!("{hello}\n").as_bytes())
                    .await
                    .unwrap();
                let mut lines = BufReader::new(read).lines();
                let command: Value =
                    serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
                assert_eq!(command["command"]["type"], phase);
                let key = (command["clientId"].clone(), command["id"].clone());
                if phase == "prepare_update_restart" {
                    prepare_key = Some(key);
                    persist(&source_copy, &manifest).unwrap();
                    // The durable commit succeeds but its response disappears.
                    drop(write);
                } else {
                    assert_ne!(
                        Some(key),
                        prepare_key,
                        "TS would replay prepare instead of executing shutdown"
                    );
                    sent.send(()).unwrap();
                    std::future::pending::<()>().await;
                    return;
                }
            }
        });
        let task_dir = directory.path().to_path_buf();
        let task_socket = socket.clone();
        let operation = tokio::spawn(async move {
            run_in(
                &task_socket,
                &task_dir.join("status.json"),
                &task_dir,
                None,
                &[task_dir.join("owners")],
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), received)
            .await
            .expect("lost reply must recover and reach shutdown")
            .unwrap();
        operation.abort();
        server.abort();
        let _ = operation.await;
        let _ = server.await;
        assert!(source.exists(), "retain the TS source until adoption");
        let roster = recover_prepared(
            &checkpoint,
            &checkpoint.with_extension("attempt.json"),
            &source,
            &socket,
            Some(&owner),
        )
        .unwrap()
        .unwrap();
        assert_eq!(roster.supervisor.pid, u64::from(std::process::id()));
        assert_eq!(
            serde_json::to_value(&roster.sessions[0].queue).unwrap(),
            json!({"next_turn":next_turn,"actions":actions})
        );
        let mut other = owner;
        other["supervisorProcessStartId"] = json!("replacement-start");
        assert!(recover_prepared(
            &checkpoint,
            &checkpoint.with_extension("attempt.json"),
            &source,
            &socket,
            Some(&other)
        )
        .is_err());
    }

    #[test]
    fn persisted_manifest_must_be_new_for_the_recorded_attempt() {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("daemon.sock");
        let source = directory.path().join("source.json");
        let attempt = directory.path().join("attempt.json");
        let checkpoint = directory.path().join("roster.json");
        let manifest = json!({"formatVersion":1,"createdAt":"now","sessions":[]});
        persist(&source, &manifest).unwrap();
        let digest = pa_daemon::paths::hash_key(&std::fs::read_to_string(&source).unwrap(), 64);
        persist(&attempt, &json!({"socket":socket,"version":crate::config::version(),
            "hello":{"supervisorPid":42,"supervisorProcessStartId":"start","supervisorGeneration":"generation"},
            "startedAt":0,"previousDigest":digest,"updateId":"old-attempt"})).unwrap();
        assert!(
            recover_prepared(&checkpoint, &attempt, &source, &socket, None)
                .unwrap()
                .is_none()
        );
        assert!(!checkpoint.exists());
    }

    #[test]
    fn successor_must_be_the_spawned_process_with_the_expected_schema() {
        let hello = json!({"appVersion":"1.0.0","schemaId":pa_types::daemon::DAEMON_SCHEMA_ID,"supervisorPid":42});
        assert!(validate_successor(&hello, 42, "1.0.0").is_ok());
        assert!(validate_successor(&hello, 43, "1.0.0").is_err());
        assert!(validate_successor(&hello, 42, "1.0.1").is_err());
        let mut wrong_schema = hello;
        wrong_schema["schemaId"] = json!("old-typescript-schema");
        assert!(validate_successor(&wrong_schema, 42, "1.0.0").is_err());
    }

    #[tokio::test]
    async fn absent_daemon_does_not_skip_an_incompatible_recovery_checkpoint() {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("absent.sock");
        let recovery = directory.path().join("legacy-update-recovery");
        std::fs::create_dir(&recovery).unwrap();
        let mut roster = super::super::legacy_roster::convert(
            &json!({"formatVersion":1,"createdAt":"2026-10-09T00:00:00.000Z","sessions":[]}),
            &json!({"supervisorPid":42,"appVersion":"0.9.8"}),
            &UpdateId::from("previous-attempt".to_string()),
            &socket,
            None,
        )
        .unwrap();
        assert!(validate_recovery(&roster, &socket, crate::config::version()).is_ok());
        roster.binary.to_version = "a-different-release".to_string();
        let key = pa_daemon::paths::hash_key(&socket.to_string_lossy(), 64);
        let checkpoint = recovery.join(format!("{key}.json"));
        persist(&checkpoint, &serde_json::to_value(&roster).unwrap()).unwrap();
        let status_path = directory.path().join("status.json");
        assert_eq!(
            run_in(
                &socket,
                &status_path,
                directory.path(),
                None,
                &[directory.path().join("registry")]
            )
            .await
            .unwrap(),
            1
        );
        let status: Value = serde_json::from_slice(&std::fs::read(status_path).unwrap()).unwrap();
        assert_eq!(status["phase"], "failed");
        assert!(
            checkpoint.exists(),
            "keep the checkpoint for deliberate recovery"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preparation_refusal_reports_failure_without_stopping_the_old_daemon() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("old.sock");
        let status_path = directory.path().join("status.json");
        let source_dir = directory.path().join("daemon-update-restarts");
        std::fs::create_dir(&source_dir).unwrap();
        let key = pa_daemon::paths::hash_key(&socket.to_string_lossy(), 64);
        persist(
            &source_dir.join(format!("{key}.json")),
            &json!({"formatVersion":1,"createdAt":"old","sessions":[]}),
        )
        .unwrap();
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let hello = json!({"type":"daemon_hello","supervisorPid":std::process::id(),
                "supervisorProcessStartId":"start", "supervisorGeneration":"generation",
                "protocol":{"name":"prime-agent.daemon","version":7}});
            write
                .write_all(format!("{hello}\n").as_bytes())
                .await
                .unwrap();
            let mut lines = BufReader::new(read).lines();
            let command: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(command["command"]["type"], "prepare_update_restart");
            assert!(command["command"].get("updateId").is_none());
            let response = json!({"type":"response","id":command["id"],"command":"prepare_update_restart",
                "success":false,"error":"session checkpoint failed"});
            write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
            while let Some(line) = lines.next_line().await.unwrap() {
                assert!(line.is_empty(), "no shutdown command after refusal: {line}");
            }
        });
        assert_eq!(
            run_in(
                &socket,
                &status_path,
                directory.path(),
                None,
                &[directory.path().join("registry")]
            )
            .await
            .unwrap(),
            1
        );
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("the refused connection closes")
            .unwrap();
        let status: Value = serde_json::from_slice(&std::fs::read(status_path).unwrap()).unwrap();
        assert_eq!(status["phase"], "failed");
        let key = pa_daemon::paths::hash_key(&socket.to_string_lossy(), 64);
        assert!(
            !directory
                .path()
                .join("legacy-update-recovery")
                .join(format!("{key}.attempt.json"))
                .exists(),
            "definitive refusal must not block a fresh attempt"
        );
        assert!(status["message"]
            .as_str()
            .unwrap()
            .contains("session checkpoint failed"));
    }

    #[tokio::test]
    async fn legacy_caller_without_a_staged_status_receives_a_ts_terminal_record() {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("absent.sock");
        let status_path = directory.path().join("status.json");
        assert_eq!(
            run_in(
                &socket,
                &status_path,
                directory.path(),
                None,
                &[directory.path().join("registry")]
            )
            .await
            .unwrap(),
            0
        );
        let status: Value = serde_json::from_slice(&std::fs::read(status_path).unwrap()).unwrap();
        assert_eq!(status["phase"], "skipped");
        assert_eq!(status["version"], 1);
        assert!(status["requestId"].is_string());
        assert!(status["coordinator"]["pid"].as_u64().unwrap() > 0);
        assert_eq!(
            status["counts"],
            json!({"total":0,"restored":0,"resumed":0,"failed":0})
        );
        for field in ["startedAt", "updatedAt", "heartbeatAt"] {
            assert!(status[field].is_string(), "{field}");
        }
    }
}
