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
            tracing::warn!(%error, "worker native signal identity unavailable");
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

pub(crate) fn recorded(descriptor: &DaemonWorkerDescriptor) -> Option<NativeSignalIdentity> {
    match parse(
        descriptor.rest.get(KEY),
        descriptor.pid,
        descriptor.worker_instance_id.as_deref(),
    ) {
        Ok(identity) => identity.map(|identity| identity.identity),
        Err(error) => {
            tracing::warn!(%error, worker_id = %descriptor.worker_id, "unverifiable worker native signal identity");
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
}
