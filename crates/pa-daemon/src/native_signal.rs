//! Optional authenticated identities for process-instance-bound worker stops.

use anyhow::{anyhow, Result};
use pa_core::platform::process::NativeSignalIdentity;
use pa_types::daemon::DaemonWorkerDescriptor;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const KEY: &str = "nativeSignalIdentity";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkerSignalIdentity {
    version: u32,
    worker_instance_id: String,
    identity: NativeSignalIdentity,
}

pub(crate) fn report(instance: &str) -> Option<WorkerSignalIdentity> {
    if instance.is_empty() {
        return None;
    }
    match NativeSignalIdentity::capture_current() {
        Ok(identity) => identity.map(|identity| WorkerSignalIdentity {
            version: 1,
            worker_instance_id: instance.to_string(),
            identity,
        }),
        Err(error) => {
            eprintln!("pa-daemon: worker native signal identity unavailable: {error}");
            None
        }
    }
}

pub(crate) fn parse(
    value: Option<&Value>,
    pid: u64,
    instance: Option<&str>,
) -> Result<Option<WorkerSignalIdentity>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let reported: WorkerSignalIdentity = serde_json::from_value(value.clone())?;
    if reported.version != 1
        || reported.worker_instance_id.is_empty()
        || Some(reported.worker_instance_id.as_str()) != instance
        || !reported.identity.matches_pid(u32::try_from(pid)?)
    {
        return Err(anyhow!(
            "Worker native signal identity does not match its incarnation"
        ));
    }
    Ok(Some(reported))
}

pub(crate) fn reset(descriptor: &mut DaemonWorkerDescriptor) {
    descriptor.rest.remove(KEY);
}

pub(crate) fn store(
    descriptor: &mut DaemonWorkerDescriptor,
    reported: Option<&WorkerSignalIdentity>,
) -> Result<()> {
    reset(descriptor);
    if let Some(reported) = reported {
        descriptor
            .rest
            .insert(KEY.to_string(), serde_json::to_value(reported)?);
    }
    Ok(())
}

/// Publish native stop authority only after its descriptor write succeeds.
pub(crate) fn store_durable(
    path: &std::path::Path,
    descriptor: &mut DaemonWorkerDescriptor,
    reported: Option<&WorkerSignalIdentity>,
) -> Result<()> {
    let mut candidate = descriptor.clone();
    store(&mut candidate, reported)?;
    if candidate.rest.get(KEY) != descriptor.rest.get(KEY) {
        crate::descriptor::persist_worker(path, &candidate)?;
    }
    descriptor.rest = candidate.rest;
    Ok(())
}

/// Bind the exact launch incarnation durably before creating its process.
pub(crate) fn begin_spawn(
    path: &std::path::Path,
    descriptor: &mut DaemonWorkerDescriptor,
    instance: &str,
    sync: crate::descriptor::TempSync,
) -> Result<()> {
    let mut candidate = descriptor.clone();
    reset(&mut candidate);
    candidate.worker_instance_id = Some(instance.to_string());
    crate::descriptor::persist_worker_at(path, &candidate, sync)?;
    *descriptor = candidate;
    Ok(())
}

/// Recover the planned launch from its authenticated registration before dialing
/// its socket. Stop authority still requires the independent worker-auth reply.
pub(crate) fn recover_registered_process(
    path: &std::path::Path,
    descriptor: &mut DaemonWorkerDescriptor,
    pid: u64,
    instance: Option<&str>,
    socket: &str,
    start_id: Option<String>,
) -> Result<()> {
    if descriptor.worker_instance_id.as_deref().is_some()
        && descriptor.worker_instance_id.as_deref() != instance
    {
        return Err(anyhow!(
            "Worker registration does not match the planned incarnation"
        ));
    }
    let mut candidate = descriptor.clone();
    reset(&mut candidate);
    candidate.pid = pid;
    candidate.worker_instance_id = instance.map(str::to_string);
    candidate.socket_path = socket.to_string();
    candidate.process_start_id = start_id;
    crate::descriptor::persist_worker(path, &candidate)?;
    *descriptor = candidate;
    Ok(())
}

/// Persist the parent PID binding before publishing it. A failed write must not
/// make the in-memory launch look durable or erase an early registrant's token.
pub(crate) fn bind_spawned_process_durable(
    path: &std::path::Path,
    descriptor: &mut DaemonWorkerDescriptor,
    instance: &str,
    pid: u32,
    start_id: Option<String>,
    sync: crate::descriptor::TempSync,
) -> Result<()> {
    let mut candidate = descriptor.clone();
    bind_spawned_process(&mut candidate, instance, pid, start_id)?;
    crate::descriptor::persist_worker_at(path, &candidate, sync)?;
    *descriptor = candidate;
    Ok(())
}

/// A registrant may already have published this launch's native token. Preserve
/// it while assigning the child PID, and reject a superseding incarnation.
pub(crate) fn bind_spawned_process(
    descriptor: &mut DaemonWorkerDescriptor,
    instance: &str,
    pid: u32,
    start_id: Option<String>,
) -> Result<()> {
    if descriptor.worker_instance_id.as_deref() != Some(instance) {
        return Err(anyhow!("Worker spawn was superseded"));
    }
    descriptor.pid = u64::from(pid);
    descriptor.process_start_id = start_id;
    descriptor.lifecycle = pa_types::daemon::DaemonWorkerLifecycle::Starting;
    Ok(())
}

pub(crate) fn recorded(descriptor: &DaemonWorkerDescriptor) -> Option<NativeSignalIdentity> {
    match parse(
        descriptor.rest.get(KEY),
        descriptor.pid,
        descriptor.worker_instance_id.as_deref(),
    ) {
        Ok(identity) => identity.map(|identity| identity.identity),
        Err(error) => {
            eprintln!(
                "pa-daemon: unverifiable native signal identity for worker {}: {error}",
                descriptor.worker_id
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report_value() -> Value {
        json!({"version":1,"workerInstanceId":"original","identity":[0,0,0,0,0,42,0,7]})
    }

    #[test]
    fn native_report_requires_authenticated_pid_and_incarnation() {
        let value = report_value();
        assert!(parse(Some(&value), 42, Some("original")).unwrap().is_some());
        assert!(parse(Some(&value), 43, Some("original")).is_err());
        assert!(parse(Some(&value), 42, Some("replacement")).is_err());
        assert!(parse(Some(&value), 42, None).is_err());
        assert!(parse(None, 42, Some("original")).unwrap().is_none());
    }

    fn fixture_descriptor() -> DaemonWorkerDescriptor {
        serde_json::from_value(json!({
            "version":2,"workerId":"w","pid":42,"workerInstanceId":"original",
            "socketPath":"/tmp/w.sock","recoveryJournalPath":"/tmp/w.jsonl",
            "supervisorSocketPath":"/tmp/s.sock","authenticationToken":"token",
            "rootActiveSessionId":"w","createdAt":"now","updatedAt":"now",
            "lifecycle":"ready","createCommand":{},"consecutiveFailures":0
        }))
        .unwrap()
    }

    #[test]
    fn persisted_identity_rejects_rebinding_and_resets_before_respawn() {
        let mut descriptor = fixture_descriptor();
        let reported = parse(Some(&report_value()), 42, Some("original")).unwrap();
        store(&mut descriptor, reported.as_ref()).unwrap();
        assert!(recorded(&descriptor).is_some());
        descriptor.worker_instance_id = Some("replacement".to_string());
        assert!(recorded(&descriptor).is_none());
        reset(&mut descriptor);
        assert!(!descriptor.rest.contains_key(KEY));
        store(&mut descriptor, None).unwrap();
        assert!(recorded(&descriptor).is_none());
    }
    #[test]
    fn failed_native_identity_write_retries_the_same_authenticated_report() {
        let dir = tempfile::tempdir().unwrap();
        let blocked_parent = dir.path().join("blocked");
        std::fs::write(&blocked_parent, b"not a directory").unwrap();
        let path = blocked_parent.join("worker.json");
        let mut descriptor = fixture_descriptor();
        let reported = parse(Some(&report_value()), 42, Some("original")).unwrap();
        assert!(store_durable(&path, &mut descriptor, reported.as_ref()).is_err());
        assert!(
            recorded(&descriptor).is_none(),
            "failed write must not publish stop authority"
        );
        std::fs::remove_file(&blocked_parent).unwrap();
        std::fs::create_dir(&blocked_parent).unwrap();
        store_durable(&path, &mut descriptor, reported.as_ref()).unwrap();
        let persisted: DaemonWorkerDescriptor =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted.rest.get(KEY), descriptor.rest.get(KEY));
        assert!(recorded(&persisted).is_some());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&blocked_parent).unwrap();
        std::fs::write(&blocked_parent, b"not a directory").unwrap();
        assert!(store_durable(&path, &mut descriptor, None).is_err());
        assert!(
            recorded(&descriptor).is_some(),
            "failed clear must remain retryable"
        );
        std::fs::remove_file(&blocked_parent).unwrap();
        std::fs::create_dir(&blocked_parent).unwrap();
        store_durable(&path, &mut descriptor, None).unwrap();
        let persisted: DaemonWorkerDescriptor =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(recorded(&persisted).is_none());
    }
    #[test]
    fn registration_recovery_and_parent_binding_are_durable_and_retryable() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let path = blocked.join("worker.json");
        let mut descriptor = fixture_descriptor();
        descriptor.process_start_id = Some("predecessor".to_string());
        let original = parse(Some(&report_value()), 42, Some("original")).unwrap();
        store(&mut descriptor, original.as_ref()).unwrap();
        let before = descriptor.clone();
        assert!(recover_registered_process(
            &path,
            &mut descriptor,
            43,
            Some("original"),
            "/tmp/live.sock",
            None
        )
        .is_err());
        assert_eq!(descriptor, before, "failed recovery publishes nothing");
        std::fs::remove_file(&blocked).unwrap();
        std::fs::create_dir(&blocked).unwrap();
        assert!(recover_registered_process(
            &path,
            &mut descriptor,
            43,
            Some("other"),
            "/tmp/live.sock",
            None
        )
        .is_err());
        assert_eq!(
            descriptor, before,
            "another incarnation cannot take the planned launch"
        );
        recover_registered_process(
            &path,
            &mut descriptor,
            43,
            Some("original"),
            "/tmp/live.sock",
            None,
        )
        .unwrap();
        let disk: DaemonWorkerDescriptor =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(disk.pid, 43);
        assert_eq!(disk.socket_path, "/tmp/live.sock");
        assert!(
            disk.process_start_id.is_none(),
            "never retain predecessor liveness"
        );
        assert!(
            recorded(&disk).is_none(),
            "registration alone grants no native authority"
        );
        // Legacy reports without native capability still require the PID write.
        recover_registered_process(
            &path,
            &mut descriptor,
            44,
            Some("original"),
            "/tmp/live.sock",
            None,
        )
        .unwrap();
        let disk: DaemonWorkerDescriptor =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(disk.pid, 44);
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&blocked).unwrap();
        std::fs::write(&blocked, b"not a directory").unwrap();
        let before = descriptor.clone();
        assert!(bind_spawned_process_durable(
            &path,
            &mut descriptor,
            "original",
            45,
            None,
            crate::descriptor::TempSync::Synced
        )
        .is_err());
        assert_eq!(
            descriptor, before,
            "failed parent binding publishes nothing"
        );
        std::fs::remove_file(&blocked).unwrap();
        std::fs::create_dir(&blocked).unwrap();
        bind_spawned_process_durable(
            &path,
            &mut descriptor,
            "original",
            45,
            None,
            crate::descriptor::TempSync::Synced,
        )
        .unwrap();
        let disk: DaemonWorkerDescriptor =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(disk.pid, 45);
    }

    #[test]
    fn launch_incarnation_is_persisted_before_auth_and_keeps_early_registration() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let path = blocked.join("worker.json");
        let mut descriptor = fixture_descriptor();
        let original = parse(Some(&report_value()), 42, Some("original")).unwrap();
        store(&mut descriptor, original.as_ref()).unwrap();
        let before = descriptor.clone();
        assert!(begin_spawn(
            &path,
            &mut descriptor,
            "launch",
            crate::descriptor::TempSync::Synced
        )
        .is_err());
        assert_eq!(
            descriptor, before,
            "failed prelaunch write must publish nothing"
        );
        std::fs::remove_file(&blocked).unwrap();
        std::fs::create_dir(&blocked).unwrap();
        begin_spawn(
            &path,
            &mut descriptor,
            "launch",
            crate::descriptor::TempSync::Synced,
        )
        .unwrap();
        let persisted: DaemonWorkerDescriptor =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted.worker_instance_id.as_deref(), Some("launch"));
        assert!(recorded(&persisted).is_none());
        let env =
            crate::descriptor::worker_launch_env(dir.path(), "/tmp/s.sock", "launch", &descriptor);
        assert_eq!(
            env.get(crate::worker::WORKER_INSTANCE_ID_ENV)
                .map(String::as_str),
            descriptor.worker_instance_id.as_deref()
        );
        // This same launch registers before spawn's parent assigns its PID.
        let early = json!({"version":1,"workerInstanceId":"launch","identity":[0,0,0,0,0,43,0,8]});
        descriptor.pid = 43;
        let reported = parse(Some(&early), 43, Some("launch")).unwrap();
        store_durable(&path, &mut descriptor, reported.as_ref()).unwrap();
        bind_spawned_process(&mut descriptor, "launch", 43, Some("new".to_string())).unwrap();
        assert_eq!(
            descriptor.rest.get(KEY),
            Some(&early),
            "parent must keep early launch authority"
        );
        descriptor.worker_instance_id = Some("replacement".to_string());
        let replacement = descriptor.clone();
        assert!(
            bind_spawned_process(&mut descriptor, "launch", 43, Some("stale".to_string())).is_err()
        );
        assert_eq!(
            descriptor, replacement,
            "late parent cannot overwrite replacement"
        );
    }
}
