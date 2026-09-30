//! Durable worker descriptors on disk (fs layer over the pa-types
//! `DaemonWorkerDescriptor` contract, port of daemon-worker-protocol.ts
//! persistence). A descriptor persisted under
//! `<agent-dir>/daemon-workers/<socket-key>/<workerId>.json` lets a
//! replacement supervisor adopt or relaunch the worker's session.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use pa_types::daemon::{DaemonWorkerDescriptor, DaemonWorkerLifecycle, DurableDaemonCreateCommand};

/// TS `daemon-supervisor.ts` names this file without a JSON extension
/// (`supervisor-config`) so descriptor sweeps filtered on `.json` skip it.
pub const SUPERVISOR_CONFIG_FILE_NAME: &str = "supervisor-config";

pub type WorkerLifecycle = DaemonWorkerLifecycle;
pub type WorkerDescriptor = DaemonWorkerDescriptor;

/// Extract the durable create fields from a create command payload.
pub fn durable_create_command(payload: &Value) -> DurableDaemonCreateCommand {
    let mut rest = serde_json::Map::new();
    if let Some(object) = payload.as_object() {
        for (key, value) in object {
            if key == "type" || key == "sessionPath" || key == "noSession" {
                continue;
            }
            rest.insert(key.clone(), value.clone());
        }
    }
    DurableDaemonCreateCommand {
        session_path: payload
            .get("sessionPath")
            .and_then(Value::as_str)
            .map(str::to_string),
        no_session: payload.get("noSession").and_then(Value::as_bool),
        rest,
    }
}

/// The environment the supervisor spawns a worker with (spec §8's roster
/// `launch_env`: "env snapshot to respawn the worker identically"). One
/// definition shared by the spawn path and the update roster, so the
/// snapshot cannot drift from the real spawn env. `instance_id` is
/// per-spawn (a fresh uuid at every relaunch; the roster row pins the
/// current one as the snapshot). The session-lease owner id is stamped
/// per worker (TS `daemon-supervisor.ts` mints it at launch): a lease the
/// worker acquires must name its own active session, never an id the
/// supervisor inherited from an ancestor environment.
pub fn worker_launch_env(
    agent_dir: &Path,
    supervisor_socket: &str,
    instance_id: &str,
    descriptor: &DaemonWorkerDescriptor,
) -> std::collections::BTreeMap<String, String> {
    let cwd = descriptor
        .create_command
        .rest
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or("/")
        .to_string();
    let script = descriptor
        .create_command
        .rest
        .get("script")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut env = std::collections::BTreeMap::from([
        (crate::worker::WORKER_ROLE_ENV.to_string(), "1".to_string()),
        (
            crate::worker::WORKER_TOKEN_ENV.to_string(),
            descriptor.authentication_token.clone(),
        ),
        (
            crate::worker::WORKER_INSTANCE_ID_ENV.to_string(),
            instance_id.to_string(),
        ),
        (
            crate::worker::WORKER_ACTIVE_SESSION_ID_ENV.to_string(),
            descriptor.root_active_session_id.clone(),
        ),
        (
            crate::lease::SESSION_LEASE_OWNER_ID_ENV.to_string(),
            descriptor.root_active_session_id.clone(),
        ),
        (
            crate::worker::WORKER_SUPERVISOR_SOCKET_ENV.to_string(),
            supervisor_socket.to_string(),
        ),
        (
            crate::worker::WORKER_SOCKET_ENV.to_string(),
            descriptor.socket_path.clone(),
        ),
        (
            crate::worker::WORKER_RECOVERY_JOURNAL_ENV.to_string(),
            descriptor.recovery_journal_path.clone(),
        ),
        (crate::worker::WORKER_CWD_ENV.to_string(), cwd),
        (
            crate::paths::AGENT_DIR_ENV.to_string(),
            agent_dir.to_string_lossy().to_string(),
        ),
    ]);
    if let Some(script) = script {
        env.insert(crate::worker::WORKER_SCRIPT_ENV.to_string(), script);
    }
    if let Some(dir) = &descriptor.session_dir {
        env.insert(crate::paths::SESSION_DIR_ENV.to_string(), dir.clone());
    }
    if descriptor.telemetry_disabled == Some(true) {
        env.insert(
            crate::worker::WORKER_TELEMETRY_DISABLED_ENV.to_string(),
            "1".to_string(),
        );
    }
    env
}

/// Build the worker create payload for a durable create command.
///
/// # Panics
///
/// Panics only on an internal invariant violation: the freshly built
/// payload not being a JSON object (the `json!` literal always is, so the
/// panic is not reachable in practice).
#[must_use]
pub fn create_command_payload(durable: &DurableDaemonCreateCommand) -> Value {
    let mut payload = json!({ "type": "create" });
    let object = payload.as_object_mut().expect("object literal");
    if let Some(session_path) = &durable.session_path {
        object.insert("sessionPath".into(), json!(session_path));
    }
    if let Some(no_session) = durable.no_session {
        object.insert("noSession".into(), json!(no_session));
    }
    for (key, value) in &durable.rest {
        object.insert(key.clone(), value.clone());
    }
    payload
}

/// Validate a persisted descriptor against this supervisor socket.
///
/// # Errors
///
/// Returns an error when the descriptor has an unsupported version,
/// belongs to another supervisor socket, or is missing required fields
/// (worker id, pid, socket path, authentication token, or root active
/// session id).
pub fn validate_descriptor(
    descriptor: &WorkerDescriptor,
    supervisor_socket_path: &Path,
) -> Result<()> {
    {
        if descriptor.version != 2 {
            return Err(anyhow!(
                "unsupported worker descriptor version {}",
                descriptor.version
            ));
        }
        if normalize_path(&descriptor.supervisor_socket_path)
            != normalize_path(&supervisor_socket_path.to_string_lossy())
        {
            return Err(anyhow!(
                "worker descriptor belongs to another supervisor socket"
            ));
        }
        if descriptor.worker_id.is_empty()
            || descriptor.pid == 0
            || descriptor.socket_path.is_empty()
            || descriptor.authentication_token.is_empty()
            || descriptor.root_active_session_id.is_empty()
        {
            return Err(anyhow!("worker descriptor is missing required fields"));
        }
        Ok(())
    }
}

#[must_use]
pub fn descriptor_lifecycle_str(descriptor: &WorkerDescriptor) -> String {
    serde_json::to_value(descriptor.lifecycle)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "starting".to_string())
}

fn normalize_path(value: &str) -> String {
    std::path::Path::new(value)
        .to_string_lossy()
        .trim_end_matches('/')
        .to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSupervisorConfig {
    pub version: u32,
    pub socket_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_session_dir: Option<String>,
}

#[must_use]
pub fn descriptor_dir(agent_dir: &Path, socket_path: &Path) -> PathBuf {
    agent_dir
        .join("daemon-workers")
        .join(crate::paths::hash_key(&socket_path.to_string_lossy(), 12))
}

/// Write a file atomically with 0600 permissions (port of writeFileAtomicSync).
///
/// # Errors
///
/// Returns an error when the parent directory cannot be created, or when
/// creating, writing, flushing, or syncing the temp file fails, or when
/// the final rename onto `path` fails; the 0600 restriction is best
/// effort and never fails the call.
pub fn write_file_atomic(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let file =
            std::fs::File::create(&temp).with_context(|| format!("create {}", temp.display()))?;
        let mut writer = std::io::BufWriter::new(file);
        writer.write_all(content.as_bytes())?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
    }
    let _ = pa_core::platform::perms::restrict_file(&temp);
    pa_core::platform::rename_onto(&temp, path)
        .with_context(|| format!("persist {}", path.display()))?;
    Ok(())
}

/// Persist the worker descriptor atomically with a fresh `updated_at`
/// stamp.
///
/// # Errors
///
/// Returns an error when the descriptor cannot be serialized or the
/// atomic write to `path` fails.
pub fn persist_worker(path: &Path, descriptor: &WorkerDescriptor) -> Result<()> {
    let mut descriptor = descriptor.clone();
    descriptor.updated_at = crate::util::now_iso();
    let content = serde_json::to_string_pretty(&descriptor)?;
    write_file_atomic(path, &content)
}

/// The identity-pending side record (the descriptor store's own
/// durability marker for the root-identity follow): written beside the
/// descriptor when a moved identity's persist failed on both attempts,
/// carrying the moved-to identity AND the moment of the move so a
/// restart never serves the superseded session from the stale record —
/// and never rolls a NEWER persisted identity back onto an older move
/// (the boot applies the pending only while it is fresher than the
/// record's `updated_at`). Removed by the repair — the first persist
/// that lands the repaired record.
pub(crate) fn identity_pending_path(descriptor_path: &Path) -> PathBuf {
    descriptor_path.with_extension("identity-pending")
}

/// Record the moved-to identity durably (the follow's fallback when the
/// descriptor write failed: the boot reads this and applies the moved
/// identity to the resident before any routing or relaunch).
///
/// # Errors
///
/// Returns an error when the atomic write of the side record fails.
pub(crate) fn write_identity_pending(
    descriptor_path: &Path,
    session_id: &str,
    session_file: &str,
    moved_at: &str,
) -> Result<()> {
    let record = serde_json::json!({
        "sessionId": session_id,
        "sessionFile": session_file,
        "movedAt": moved_at,
    });
    write_file_atomic(
        &identity_pending_path(descriptor_path),
        &serde_json::to_string(&record)?,
    )
}

/// The moved-to identity a failed follow left beside the descriptor,
/// with the move's timestamp (`None` when no follow is pending).
#[must_use]
pub(crate) fn read_identity_pending(descriptor_path: &Path) -> Option<(String, String, String)> {
    let content = std::fs::read_to_string(identity_pending_path(descriptor_path)).ok()?;
    let record: serde_json::Value = serde_json::from_str(&content).ok()?;
    let session_id = record.get("sessionId").and_then(Value::as_str)?;
    let session_file = record.get("sessionFile").and_then(Value::as_str)?;
    let moved_at = record.get("movedAt").and_then(Value::as_str)?;
    Some((
        session_id.to_string(),
        session_file.to_string(),
        moved_at.to_string(),
    ))
}

/// Remove the side record (the repair landed: the descriptor itself now
/// carries the moved-to identity).
///
/// # Errors
///
/// Returns an error when the removal fails — a stale side record left
/// behind could roll a later boot back onto this move, so the callers
/// surface the failure and the next repair retries the removal.
pub(crate) fn clear_identity_pending(descriptor_path: &Path) -> Result<()> {
    match std::fs::remove_file(identity_pending_path(descriptor_path)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow!("remove the identity-pending record: {error}")),
    }
}

#[must_use]
pub fn load_descriptors(
    dir: &Path,
    supervisor_socket_path: &Path,
) -> Vec<(PathBuf, WorkerDescriptor)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut loaded = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().and_then(|n| n.to_str()) == Some(SUPERVISOR_CONFIG_FILE_NAME) {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(descriptor) = serde_json::from_str::<WorkerDescriptor>(&content) else {
            continue;
        };
        if validate_descriptor(&descriptor, supervisor_socket_path).is_err() {
            continue;
        }
        loaded.push((path, descriptor));
    }
    loaded
}

/// Read persisted supervisor config when it belongs to this socket.
#[must_use]
pub fn load_supervisor_config(
    path: &Path,
    socket_path: &Path,
) -> Option<PersistedSupervisorConfig> {
    let content = std::fs::read_to_string(path).ok()?;
    let config: PersistedSupervisorConfig = serde_json::from_str(&content).ok()?;
    if config.version != 1
        || normalize_path(&config.socket_path) != normalize_path(&socket_path.to_string_lossy())
    {
        return None;
    }
    Some(config)
}

/// Persist the supervisor config atomically.
///
/// # Errors
///
/// Returns an error when the config cannot be serialized or the atomic
/// write to `path` fails.
pub fn persist_supervisor_config(path: &Path, config: &PersistedSupervisorConfig) -> Result<()> {
    write_file_atomic(path, &serde_json::to_string_pretty(config)?)
}

use std::io::Write as _;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    #[test]
    fn write_file_atomic_replaces_an_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("descriptor.json");
        std::fs::write(&path, "stale").unwrap();
        write_file_atomic(&path, "next").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "next");
        assert!(
            std::fs::read_dir(dir.path()).unwrap().count() == 1,
            "the temp file must not survive the rename"
        );
    }

    #[test]
    fn durable_create_round_trips() {
        let payload = json!({
            "type": "create",
            "sessionPath": "/a.jsonl",
            "cwd": "/tmp",
            "name": "faux",
            "script": "/script.json",
        });
        let durable = durable_create_command(&payload);
        assert_eq!(durable.session_path.as_deref(), Some("/a.jsonl"));
        let rebuilt = create_command_payload(&durable);
        assert_eq!(rebuilt["type"], "create");
        assert_eq!(rebuilt["sessionPath"], "/a.jsonl");
        assert_eq!(rebuilt["cwd"], "/tmp");
        assert_eq!(rebuilt["name"], "faux");
        assert_eq!(rebuilt["script"], "/script.json");
    }

    #[test]
    fn descriptor_validates_against_socket() {
        let descriptor = WorkerDescriptor {
            version: 2,
            worker_id: "abc123def456".to_string(),
            pid: 42,
            process_start_id: None,
            socket_path: "/tmp/w.sock".to_string(),
            recovery_journal_path: "/tmp/w.recovery.jsonl".to_string(),
            orphan_process_journal_path: None,
            supervisor_socket_path: "/tmp/daemon.sock".to_string(),
            authentication_token: "tok".to_string(),
            worker_instance_id: Some("inst".to_string()),
            root_active_session_id: "abc123def456".to_string(),
            owner_client_id: None,
            root_session_id: None,
            session_file: Some("/a.jsonl".to_string()),
            session_dir: None,
            telemetry_disabled: None,
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
            lifecycle: WorkerLifecycle::Ready,
            create_command: DurableDaemonCreateCommand {
                session_path: Some("/a.jsonl".to_string()),
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
        let json = serde_json::to_value(&descriptor).unwrap();
        assert_eq!(json["lifecycle"], "ready");
        assert_eq!(json["workerId"], "abc123def456");
        validate_descriptor(&descriptor, Path::new("/tmp/daemon.sock")).expect("valid");
        assert!(validate_descriptor(&descriptor, Path::new("/tmp/other.sock")).is_err());
    }
}
