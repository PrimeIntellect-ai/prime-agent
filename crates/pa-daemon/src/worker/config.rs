//! The worker's spawn configuration: `WorkerConfig`, read from the
//! supervisor-provided environment.
use super::*;

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

use crate::paths;

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub socket_path: PathBuf,
    pub supervisor_socket_path: PathBuf,
    pub token: String,
    pub worker_instance_id: String,
    pub active_session_id: String,
    pub agent_dir: PathBuf,
    pub recovery_journal_path: PathBuf,
    pub script: Option<Value>,
    /// Telemetry opt-out inherited from the create command ("1" = disabled;
    /// absent/other = enabled). Sessions created on this worker install no
    /// telemetry subscriber.
    pub telemetry_disabled: Option<bool>,
}

impl WorkerConfig {
    /// Read the worker spawn env pair into a config: the socket path,
    /// the authentication token, the root active session id, and the
    /// agent dir; the script, the telemetry-disabled flag, the supervisor
    /// socket path, and the recovery journal path all default when unset
    /// or unreadable.
    ///
    /// # Errors
    ///
    /// Returns an error when a required env pair is missing (the socket
    /// path, the authentication token, or the root active session id),
    /// or the agent dir cannot be resolved.
    pub fn from_env() -> Result<Self> {
        let socket_path: PathBuf = std::env::var_os(WORKER_SOCKET_ENV)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow!("worker socket path is required ({WORKER_SOCKET_ENV})"))?;
        let token =
            std::env::var(WORKER_TOKEN_ENV).context("worker authentication token is required")?;
        let active_session_id = std::env::var(WORKER_ACTIVE_SESSION_ID_ENV)
            .context("worker root active session id is required")?;
        let supervisor_socket_path = std::env::var_os(WORKER_SUPERVISOR_SOCKET_ENV)
            .map(PathBuf::from)
            .unwrap_or_default();
        let agent_dir = paths::agent_dir()?;
        let recovery_journal_path = std::env::var_os(WORKER_RECOVERY_JOURNAL_ENV).map_or_else(
            || {
                agent_dir
                    .join("daemon-workers")
                    .join(format!("{active_session_id}.recovery.jsonl"))
            },
            PathBuf::from,
        );
        let script = std::env::var_os(WORKER_SCRIPT_ENV)
            .map(PathBuf::from)
            .and_then(|path| {
                let content = std::fs::read_to_string(path).ok()?;
                serde_json::from_str::<Value>(&content).ok()
            });
        let telemetry_disabled =
            std::env::var_os(WORKER_TELEMETRY_DISABLED_ENV).map(|value| value == "1");
        Ok(WorkerConfig {
            socket_path,
            supervisor_socket_path,
            token,
            worker_instance_id: std::env::var(WORKER_INSTANCE_ID_ENV).unwrap_or_default(),
            active_session_id,
            agent_dir,
            recovery_journal_path,
            script,
            telemetry_disabled,
        })
    }
}
