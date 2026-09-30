//! Resident guest daemon for a cloud session (TS `cloud-daemon.ts` /
//! `cloud-protocol-server.ts`, the loopback foundation).
//!
//! The guest is a hidden internal process, started only by the uploaded
//! bridge inside a sandbox (the CLI role env below), never by a user.
//! It owns its durability end to end over the v3 cloud wire
//! ([`pa_types::daemon::cloud`]):
//!
//! - every submit is admitted through the command journal (fsync) with
//!   the canonical digest, so retries deduplicate by command id and a
//!   crash never re-executes uncertain work ([`journal`]);
//! - every event is appended to the durable outbox (fsync) before it is
//!   pushed, and replay comes from the acknowledged-cursor position,
//!   never from a memory window ([`outbox`]);
//! - hello requires the bridge token (timing-safe compare) and fences
//!   stale sandbox generations; the local claiming executor replays
//!   only admitted-not-dispatched commands, never uncertain ones
//!   ([`server`], [`dispatch`]);
//! - one real session-engine turn runs through the existing pa-core
//!   engine facade when an executor is wired ([`executor`]).
//!
//! Scope walls (the plan's offline-turn gates): no cloud-in-cloud (the
//! guest hosts no cloud spawn target at all), no master credentials
//! (the guest env carries a single scoped bridge token; no platform
//! key is read here), no production tunnel or resolver (the transport
//! is the same [`pa_types::platform::transport`] contract the daemon
//! supervisor uses, so tests drive a loopback listener), and no
//! capability advertising (snapshots carry no `capabilities` field,
//! which means the v1 event stream only, and the local daemon's
//! `default_server_capabilities` stays untouched).

pub(crate) mod dispatch;
#[cfg(test)]
mod engine_turn_tests;
pub(crate) mod executor;
pub(crate) mod journal;
pub(crate) mod outbox;
pub(crate) mod server;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_support;

use executor::EngineGuestExecutor;
use server::GuestProtocolServer;

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};

pub(crate) use crate::util::now_iso;

/// Durable outbox record cap (TS `DEFAULT_MAX_RECORDS`, shared with the
/// family slice's replay span).
pub(crate) use crate::cloud_family::DEFAULT_OUTBOX_RECORDS;

/// The hidden role env the bridge sets on the guest daemon process (TS
/// `PRIME_AGENT_INTERNAL_CLOUD_DAEMON`, checked by `main.ts` inside
/// daemon mode): never user-facing, and never a documented CLI flag.
pub const GUEST_ROLE_ENV: &str = "PRIME_AGENT_INTERNAL_CLOUD_DAEMON";

/// The guest daemon's environment (TS `CLOUD_DAEMON_ENV_KEYS` /
/// `parseCloudDaemonEnv`): the bridge provisions every coordinate, so
/// each required key's absence is a hard boot error.
pub(crate) mod env_keys {
    pub const SOCKET: &str = "PRIME_AGENT_CLOUD_DAEMON_SOCKET";
    pub const SESSION_ID: &str = "PRIME_AGENT_CLOUD_SESSION_ID";
    pub const GENERATION: &str = "PRIME_AGENT_CLOUD_GENERATION";
    pub const WORKSPACE_DIR: &str = "PRIME_AGENT_CLOUD_WORKSPACE_DIR";
    pub const AGENT_DIR: &str = "PRIME_AGENT_CLOUD_AGENT_DIR";
    pub const BRIDGE_TOKEN: &str = "PRIME_AGENT_CLOUD_BRIDGE_TOKEN";
    pub const PROMPT_PATH: &str = "PRIME_AGENT_CLOUD_PROMPT_PATH";
    pub const MODEL: &str = "PRIME_AGENT_CLOUD_MODEL";
    pub const STATE_DIR: &str = "PRIME_AGENT_CLOUD_DAEMON_STATE_DIR";
    pub const STATUS_FILE: &str = "PRIME_AGENT_CLOUD_DAEMON_STATUS_FILE";
}

/// TS `DEFAULT_STATE_DIR`.
pub(crate) const DEFAULT_STATE_DIR: &str = "/opt/prime-agent/daemon-state";

/// A missing or invalid guest env coordinate (TS `CloudDaemonEnvError`).
#[derive(Debug)]
pub(crate) struct CloudGuestEnvError(pub String);

impl std::fmt::Display for CloudGuestEnvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CloudGuestEnvError {}

/// The parsed guest daemon environment (TS `ParsedCloudDaemonEnv`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CloudGuestEnv {
    pub socket_path: PathBuf,
    pub session_id: String,
    pub generation: u64,
    pub workspace_dir: PathBuf,
    pub agent_dir: PathBuf,
    pub bridge_token: String,
    pub prompt_path: Option<PathBuf>,
    pub model: Option<String>,
    pub state_dir: PathBuf,
    pub status_file: PathBuf,
}

impl CloudGuestEnv {
    /// One per-session durable state directory: `<state-dir>/<session>.g<generation>`
    /// (TS `CloudProtocolServerOptions.stateDirectory`).
    #[must_use]
    pub fn session_state_dir(&self) -> PathBuf {
        self.state_dir
            .join(format!("{}.g{}", self.session_id, self.generation))
    }
}

/// Read the guest daemon environment (TS `parseCloudDaemonEnv`). The
/// generation is the sandbox incarnation that fences stale
/// attachments; it is an integer of at least 1.
///
/// # Errors
///
/// Returns the TS error message when a required key is missing or the
/// generation is invalid.
pub(crate) fn parse_cloud_guest_env(
    vars: &dyn Fn(&str) -> Option<String>,
    default_state_dir: Option<&std::path::Path>,
) -> std::result::Result<CloudGuestEnv, CloudGuestEnvError> {
    fn required(
        vars: &dyn Fn(&str) -> Option<String>,
        name: &str,
    ) -> Result<String, CloudGuestEnvError> {
        vars(name).filter(|value| !value.is_empty()).ok_or_else(|| {
            CloudGuestEnvError(format!("missing required environment variable {name}"))
        })
    }
    let generation_raw = required(vars, env_keys::GENERATION)?;
    let Ok(generation) = generation_raw.parse::<u64>() else {
        return Err(CloudGuestEnvError(format!(
            "invalid {}",
            env_keys::GENERATION
        )));
    };
    if generation < 1 {
        return Err(CloudGuestEnvError(format!(
            "invalid {}",
            env_keys::GENERATION
        )));
    }
    let state_dir = vars(env_keys::STATE_DIR)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| default_state_dir.map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(DEFAULT_STATE_DIR));
    let status_file = vars(env_keys::STATUS_FILE)
        .filter(|value| !value.is_empty())
        .map_or_else(|| state_dir.join("daemon-status.json"), PathBuf::from);
    Ok(CloudGuestEnv {
        socket_path: PathBuf::from(required(vars, env_keys::SOCKET)?),
        session_id: required(vars, env_keys::SESSION_ID)?,
        generation,
        workspace_dir: PathBuf::from(required(vars, env_keys::WORKSPACE_DIR)?),
        agent_dir: PathBuf::from(required(vars, env_keys::AGENT_DIR)?),
        bridge_token: required(vars, env_keys::BRIDGE_TOKEN)?,
        prompt_path: vars(env_keys::PROMPT_PATH)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from),
        model: vars(env_keys::MODEL).filter(|value| !value.is_empty()),
        state_dir,
        status_file,
    })
}

/// Boot the guest daemon from the process environment: the guest owns
/// its state (the agent dir and the daemon state dir both exist, 0700,
/// before any session or protocol file touches them), then the protocol
/// server serves until release stops it (TS `CloudGuestDaemon.start`).
///
/// # Errors
///
/// Returns the env error message, or an error when the state
/// directories cannot be prepared or the protocol server fails.
pub async fn run_guest_daemon() -> Result<()> {
    let env = parse_cloud_guest_env(&|name| std::env::var(name).ok(), None)
        .map_err(|error| anyhow!(error.0))?;
    prepare_state_dirs(&env)?;
    let server = std::sync::Arc::new(GuestProtocolServer::open(
        &env.session_state_dir(),
        &env.session_id,
        env.generation,
        &env.bridge_token,
        env.status_file.clone(),
        env.workspace_dir.display().to_string(),
        env.model.clone(),
    )?);
    let executor = EngineGuestExecutor::from_env(&env)?;
    // A hard-killed daemon leaves its socket file behind: remove the
    // stale inode before binding or the restart wedges on it forever
    // (TS `CloudProtocolServer.start`).
    let _ = std::fs::remove_file(&env.socket_path);
    let listener = pa_types::platform::transport::bind_transport(&env.socket_path)
        .await
        .with_context(|| format!("bind {}", env.socket_path.display()))?;
    // Owner-only after the bind (TS `chmodSync(socketPath, 0o700)`):
    // the platform private file mode (0600) is the same owner-only
    // boundary — connecting to a unix socket needs the write bit — so
    // the umask never decides who can reach the guest's bridge socket.
    pa_core::platform::perms::restrict_file(&env.socket_path)
        .with_context(|| format!("restrict {}", env.socket_path.display()))?;
    server.serve(listener, std::sync::Arc::new(executor)).await
}

/// Create the guest's state directories with owner-only permissions (TS
/// `CloudGuestDaemon.start`).
///
/// # Errors
///
/// Returns an error when either directory cannot be created or
/// restricted.
fn prepare_state_dirs(env: &CloudGuestEnv) -> Result<()> {
    for dir in [&env.agent_dir, &env.state_dir] {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        pa_core::platform::perms::restrict_dir(dir)
            .with_context(|| format!("restrict {}", dir.display()))?;
    }
    Ok(())
}
