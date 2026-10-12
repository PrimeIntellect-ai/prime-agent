//! The worker<->supervisor process contract: the environment variables the
//! supervisor passes at spawn, and the close reasons a kill carries.

use serde_json::Value;

use crate::protocol::DaemonSessionClosedReason;

/// The close reason one `kill` carries: the plain client kill is `killed`; a
/// child-close cascade passes `shutdown` or `replaced` through the `rlmCloseReason`
/// marker — `killed` cancels the jobs and archives, `shutdown` keeps the resume
/// entry, `replaced` cancels the RLM heartbeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KillCloseReason {
    Killed,
    Shutdown,
    Replaced,
}

impl KillCloseReason {
    /// The `rlmCloseReason` marker of a child-close cascade (the plain client
    /// kill carries none).
    pub(crate) fn from_payload(payload: &Value) -> Self {
        match payload.get("rlmCloseReason").and_then(Value::as_str) {
            Some("shutdown") => Self::Shutdown,
            Some("replaced") => Self::Replaced,
            _ => Self::Killed,
        }
    }

    /// The wire `session_closed` reason.
    pub(crate) fn session_closed_reason(self) -> DaemonSessionClosedReason {
        match self {
            Self::Killed => DaemonSessionClosedReason::Killed,
            Self::Shutdown => DaemonSessionClosedReason::Shutdown,
            Self::Replaced => DaemonSessionClosedReason::Replaced,
        }
    }

    /// The recovery journal's close operation.
    pub(crate) fn recovery_operation(self) -> &'static str {
        match self {
            Self::Killed => "killed",
            Self::Shutdown => "shutdown",
            Self::Replaced => "replaced",
        }
    }
}
/// TS-parity worker environment variables.
pub const WORKER_ROLE_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER";
pub const WORKER_TOKEN_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN";
pub const WORKER_INSTANCE_ID_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_INSTANCE_ID";
pub const WORKER_ACTIVE_SESSION_ID_ENV: &str =
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
/// Worker process cwd (the create command's `cwd`).
pub const WORKER_CWD_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_CWD";
pub const WORKER_SUPERVISOR_SOCKET_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET";
pub const WORKER_RECOVERY_JOURNAL_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL";
/// Scripted-engine script file for faux sessions (integration harness).
pub const WORKER_SCRIPT_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_SCRIPT";
/// Worker socket path (supervisor passes it explicitly).
pub const WORKER_SOCKET_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_SOCKET";
/// Telemetry opt-out (supervisor passes the create's `telemetryDisabled`, TS parity).
pub const WORKER_TELEMETRY_DISABLED_ENV: &str =
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TELEMETRY_DISABLED";
/// Supervisor-lost exit window (ms): a worker whose supervisor socket stays
/// unreachable for this long exits instead of lingering orphaned.
pub const WORKER_SUPERVISOR_LOST_EXIT_MS_ENV: &str =
    "PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS";
