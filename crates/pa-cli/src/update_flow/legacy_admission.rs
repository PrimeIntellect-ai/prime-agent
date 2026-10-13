//! TS shutdown admission keeps old clients from relaunching a competing
//! supervisor while the Rust coordinator restores their socket. The record
//! and empty `.guard` directory follow shipped proper-lockfile clients.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};

const REGISTRY_OVERRIDE: &str = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const LEASE_MS: u64 = 5_000;

pub(super) struct Admission {
    directories: Vec<PathBuf>,
    record: Value,
}

impl Admission {
    pub(super) fn directories() -> Result<Vec<PathBuf>> {
        let mut directories = if let Some(path) = std::env::var_os(REGISTRY_OVERRIDE) {
            vec![PathBuf::from(path)]
        } else {
            let home =
                pa_types::platform::home_dir().context("resolve supervisor registry home")?;
            vec![
                home.join(".prime/supervisor-owners"),
                pa_daemon::socket::default_daemon_socket_path()
                    .parent()
                    .context("resolve legacy supervisor registry")?
                    .join("supervisor-owners"),
            ]
        };
        directories.sort();
        directories.dedup();
        Ok(directories)
    }

    pub(super) async fn acquire(directories: &[PathBuf]) -> Result<Self> {
        for directory in directories {
            std::fs::create_dir_all(directory)?;
            pa_core::platform::restrict_dir(directory)?;
        }
        let now = crate::util_time::now_iso8601();
        let identity = super::status::coordinator_identity();
        let mut admission = Self {
            directories: Vec::new(),
            record: json!({"version":1,"token":uuid::Uuid::new_v4().to_string(),
                "pid":identity.pid,"createdAt":now,"updatedAt":now,
                "expiresAt":pa_daemon::util::iso_from_unix_ms(crate::util_time::now_ms()+LEASE_MS)}),
        };
        if let Some(start_id) = identity.process_start_id {
            admission.record["processStartId"] = json!(start_id);
        }
        // Acquisition never overwrites an active foreign lease. If the second
        // registry is busy, release the first before waiting and retry both.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let mut blocked = false;
            for directory in directories {
                let result = guarded(directory, || {
                    let path = directory.join("shutdown-admission.json");
                    if read_record(&path)?.as_ref().is_some_and(record_is_active) {
                        return Ok(false);
                    }
                    super::legacy_restart::persist(&path, &admission.record)?;
                    Ok(true)
                })
                .await;
                match result {
                    Ok(true) => admission.directories.push(directory.clone()),
                    Ok(false) => {
                        blocked = true;
                        break;
                    }
                    Err(error) => {
                        admission.release().await?;
                        return Err(error);
                    }
                }
            }
            if !blocked {
                return Ok(admission);
            }
            admission.release().await?;
            anyhow::ensure!(
                tokio::time::Instant::now() < deadline,
                "another TypeScript daemon shutdown is still running"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
            admission.record["expiresAt"] = json!(pa_daemon::util::iso_from_unix_ms(
                crate::util_time::now_ms() + LEASE_MS
            ));
        }
    }

    pub(super) async fn refresh(&mut self) -> Result<()> {
        self.record["updatedAt"] = json!(crate::util_time::now_iso8601());
        self.record["expiresAt"] = json!(pa_daemon::util::iso_from_unix_ms(
            crate::util_time::now_ms() + LEASE_MS
        ));
        for directory in &self.directories {
            guarded(directory, || {
                let path = directory.join("shutdown-admission.json");
                let current =
                    read_record(&path)?.context("TypeScript shutdown admission disappeared")?;
                anyhow::ensure!(
                    current["token"] == self.record["token"],
                    "TypeScript shutdown admission ownership changed"
                );
                super::legacy_restart::persist(&path, &self.record)
            })
            .await?;
        }
        Ok(())
    }

    pub(super) async fn release(&mut self) -> Result<()> {
        for directory in &self.directories {
            guarded(directory, || {
                let path = directory.join("shutdown-admission.json");
                if read_record(&path)?.is_some_and(|record| record["token"] == self.record["token"])
                {
                    std::fs::remove_file(path)?;
                }
                Ok(())
            })
            .await?;
        }
        self.directories.clear();
        Ok(())
    }
}

fn read_record(path: &Path) -> Result<Option<Value>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes)?;
            anyhow::ensure!(
                value["version"] == 1
                    && value["token"].is_string()
                    && value["pid"].as_u64().is_some_and(|pid| pid > 0)
                    && value["expiresAt"]
                        .as_str()
                        .and_then(pa_daemon::util::iso_to_unix_ms)
                        .is_some(),
                "invalid TypeScript shutdown admission at {}",
                path.display()
            );
            Ok(Some(value))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn record_is_active(record: &Value) -> bool {
    let unexpired = record["expiresAt"]
        .as_str()
        .and_then(pa_daemon::util::iso_to_unix_ms)
        .is_some_and(|expires| expires > crate::util_time::now_ms());
    if !unexpired {
        return false;
    }
    let Some(pid) = record["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
    else {
        return true;
    };
    if matches!(pa_daemon::lease::is_process_alive(pid), Ok(false)) {
        return false;
    }
    !matches!((record["processStartId"].as_str(), pa_daemon::lease::get_process_start_id(pid)),
        (Some(expected), Some(observed)) if expected != observed)
}

/// No foreign stale guard is reclaimed here. TS owns that recovery protocol;
/// an abandoned guard produces a bounded failure rather than an unsafe write.
async fn guarded<T>(directory: &Path, operation: impl FnOnce() -> Result<T>) -> Result<T> {
    let path = directory.join(".guard");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        match std::fs::create_dir(&path) {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                anyhow::ensure!(
                    tokio::time::Instant::now() < deadline,
                    "TypeScript registry guard is busy: {}",
                    path.display()
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) => return Err(error.into()),
        }
    }
    // Keep this section synchronous and much shorter than TS's five-second
    // stale threshold. Never remove a guard another process has replaced.
    let modified = std::fs::metadata(&path)?.modified()?;
    let result = operation();
    anyhow::ensure!(
        std::fs::metadata(&path)?.modified()? == modified,
        "TypeScript registry guard changed during the transaction"
    );
    std::fs::remove_dir(path)?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn release_preserves_a_replacement_owners_token() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shutdown-admission.json");
        let successor = json!({"version":1,"token":"successor","pid":std::process::id(),
            "expiresAt":"2099-01-01T00:00:00.000Z"});
        super::super::legacy_restart::persist(&path, &successor).unwrap();
        let mut admission = Admission {
            directories: vec![directory.path().to_path_buf()],
            record: json!({"token":"old"}),
        };
        admission.release().await.unwrap();
        assert_eq!(read_record(&path).unwrap(), Some(successor));
    }

    #[tokio::test]
    async fn refresh_refuses_a_replacement_owners_token() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shutdown-admission.json");
        let successor = json!({"version":1,"token":"successor","pid":std::process::id(),
            "expiresAt":"2099-01-01T00:00:00.000Z"});
        super::super::legacy_restart::persist(&path, &successor).unwrap();
        let mut admission = Admission {
            directories: vec![directory.path().to_path_buf()],
            record: json!({"token":"old"}),
        };
        assert!(admission.refresh().await.is_err());
        assert_eq!(read_record(&path).unwrap(), Some(successor));
    }
}
