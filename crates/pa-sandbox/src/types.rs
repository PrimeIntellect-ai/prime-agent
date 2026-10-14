//! The lifecycle wire vocabulary: statuses, the create request, the sandbox
//! record, and the shared timing defaults. Port of the type half of
//! `prime-sandbox-client.ts` (TS branch `feat/direct-cloud-sandbox`),
//! verified against the `prime_sandboxes` SDK and the platform backend.
//!
//! Deliberate narrowing for this slice: `Sandbox` carries the fields with a
//! lifecycle consumer (id, name, image, status, resources, errors,
//! timestamps-as-strings, ownership, egress lists, labels). The TS record
//! additionally validates the `environmentVars`/`secrets` echo and the
//! `diskMountPath`/`kubernetesJobId`/`registryCredentialsId`/
//! `pendingImageBuildId` fields; those are added when a consumer needs them.
//! Timestamps are validated as non-empty strings, not parsed dates (the
//! crate carries no datetime dependency; consumers convert on demand).

use std::collections::BTreeMap;
use std::time::Duration;

/// Create retry budget: transient transport failures retry up to this many
/// attempts reusing the same server-side idempotency key (TS
/// `PRIME_SANDBOX_CREATE_MAX_ATTEMPTS`).
pub const PRIME_SANDBOX_CREATE_MAX_ATTEMPTS: usize = 3;

/// Default per-request deadline (TS `DEFAULT_REQUEST_TIMEOUT_MS` = 30 s).
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Default overall wait budget (TS `DEFAULT_WAIT_TIMEOUT_MS` = 10 min).
pub const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(600);

/// Default wait poll interval (TS `DEFAULT_WAIT_POLL_INTERVAL_MS` = 2 s).
pub const DEFAULT_WAIT_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The sandbox lifecycle statuses (TS `PRIME_SANDBOX_STATUSES`, wire names
/// uppercase).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxStatus {
    /// Created, not yet provisioning.
    Pending,
    /// Provisioning resources.
    Provisioning,
    /// Running and reachable.
    Running,
    /// Paused.
    Paused,
    /// Failed; terminal.
    Error,
    /// Terminated by the platform or a caller; terminal.
    Terminated,
    /// Lifetime or idle deadline hit; terminal.
    Timeout,
}

impl SandboxStatus {
    /// Parse the wire name; `None` for unknown statuses (the caller maps
    /// that to an `invalid_response` error, TS `parsePrimeSandbox`).
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "PENDING" => Some(Self::Pending),
            "PROVISIONING" => Some(Self::Provisioning),
            "RUNNING" => Some(Self::Running),
            "PAUSED" => Some(Self::Paused),
            "ERROR" => Some(Self::Error),
            "TERMINATED" => Some(Self::Terminated),
            "TIMEOUT" => Some(Self::Timeout),
            _ => None,
        }
    }

    /// The wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Provisioning => "PROVISIONING",
            Self::Running => "RUNNING",
            Self::Paused => "PAUSED",
            Self::Error => "ERROR",
            Self::Terminated => "TERMINATED",
            Self::Timeout => "TIMEOUT",
        }
    }

    /// True for the statuses a sandbox never leaves (TS
    /// `TERMINAL_SANDBOX_STATUSES`).
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Error | Self::Terminated | Self::Timeout)
    }
}

/// The request methods the lifecycle endpoints use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// `GET`.
    Get,
    /// `POST`.
    Post,
    /// `DELETE`.
    Delete,
}

impl Method {
    /// The HTTP verb.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Delete => "DELETE",
        }
    }
}

impl std::fmt::Display for Method {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A process to start without invoking a shell (the VM start command form;
/// `executable` plus `args`, never a shell line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartCommand {
    /// The executable path or name; non-empty, NUL-free.
    pub executable: String,
    /// The arguments; NUL-free strings.
    pub args: Vec<String>,
}

/// A create request for a VM-backed sandbox. The client always sends
/// `vm: true` (container creates are out of scope for this slice) and an
/// `idempotency_key` (the request's when set, else a fresh UUID).
///
/// `region` is deliberately unrepresentable: it is not caller-selectable
/// for VM sandboxes, so the TS runtime guard becomes a compile-time
/// exclusion in Rust.
#[derive(Clone)]
pub struct VmCreateRequest {
    /// Sandbox name; non-empty, at most 100 characters.
    pub name: String,
    /// VM image reference; non-empty, whitespace-free.
    pub docker_image: String,
    /// CPU cores; 0.1 to 16, finite.
    pub cpu_cores: f64,
    /// Memory in GB; 0.1 to 64, finite.
    pub memory_gb: f64,
    /// Disk size in GB; 0.1 to 1000, finite.
    pub disk_size_gb: f64,
    /// GPU count; 0 to 8 (requires `gpu_type` when > 0).
    pub gpu_count: u32,
    /// GPU type/model; required with `gpu_count > 0`, forbidden otherwise.
    /// An empty string is treated as unset (TS behavior).
    pub gpu_type: Option<String>,
    /// Structured VM start command; `None` keeps the image default.
    pub start_command: Option<StartCommand>,
    /// VM-only egress allowlist; mutually exclusive with
    /// `network_denylist`.
    pub network_allowlist: Option<Vec<String>>,
    /// VM-only egress denylist; mutually exclusive with
    /// `network_allowlist`.
    pub network_denylist: Option<Vec<String>>,
    /// Sandbox lifetime cap in minutes; 1 to 1440.
    pub timeout_minutes: i64,
    /// Terminate after this many minutes without activity; at least 1 and
    /// at most `timeout_minutes`.
    pub idle_timeout_minutes: Option<i64>,
    /// Environment variables in the sandbox; shell-identifier keys.
    pub environment_vars: Option<BTreeMap<String, String>>,
    /// Secrets in the sandbox; shell-identifier keys.
    pub secrets: Option<BTreeMap<String, String>>,
    /// Free-form labels; non-empty, at most 256 characters each.
    pub labels: Vec<String>,
    /// Create idempotency key; 1-128 characters of letters, digits, dots,
    /// underscores, or dashes, starting with a letter or digit. The server
    /// returns the same sandbox for repeated creates carrying the same key.
    pub idempotency_key: Option<String>,
}

impl std::fmt::Debug for VmCreateRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VmCreateRequest")
            .field("name", &self.name)
            .field("docker_image", &self.docker_image)
            .field("cpu_cores", &self.cpu_cores)
            .field("memory_gb", &self.memory_gb)
            .field("disk_size_gb", &self.disk_size_gb)
            .field("gpu_count", &self.gpu_count)
            .field("gpu_type", &self.gpu_type)
            .field("start_command", &self.start_command)
            .field("network_allowlist", &self.network_allowlist)
            .field("network_denylist", &self.network_denylist)
            .field("timeout_minutes", &self.timeout_minutes)
            .field("idle_timeout_minutes", &self.idle_timeout_minutes)
            .field(
                "environment_vars",
                &self.environment_vars.as_ref().map(|_| "[redacted]"),
            )
            .field("secrets", &self.secrets.as_ref().map(|_| "[redacted]"))
            .field("labels", &self.labels)
            .field("idempotency_key", &self.idempotency_key)
            .finish()
    }
}

/// Wait configuration for [`crate::PrimeSandboxClient::wait_for_running`].
#[derive(Debug, Clone)]
pub struct WaitOptions {
    /// Overall wait budget; default 10 minutes.
    pub timeout: Duration,
    /// Poll interval; default 2 seconds.
    pub poll_interval: Duration,
}

impl Default for WaitOptions {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_WAIT_TIMEOUT,
            poll_interval: DEFAULT_WAIT_POLL_INTERVAL,
        }
    }
}

/// A sandbox record (the `GET /api/v1/sandbox/{id}` response; `camelCase`
/// wire form with `snake_case` egress lists — see the crate docs).
#[derive(Debug, Clone, PartialEq)]
pub struct Sandbox {
    /// The sandbox id; a URL-safe segment.
    pub id: String,
    /// The sandbox name.
    pub name: String,
    /// The image reference it was created from.
    pub docker_image: String,
    /// The lifecycle status.
    pub status: SandboxStatus,
    /// CPU cores.
    pub cpu_cores: f64,
    /// Memory in GB.
    pub memory_gb: f64,
    /// Disk size in GB.
    pub disk_size_gb: f64,
    /// GPU count.
    pub gpu_count: u32,
    /// GPU type/model, when GPUs were requested.
    pub gpu_type: Option<String>,
    /// True for VM-backed sandboxes.
    pub vm: bool,
    /// VM-only egress allowlist, when the create request set one.
    pub network_allowlist: Option<Vec<String>>,
    /// VM-only egress denylist, when the create request set one.
    pub network_denylist: Option<Vec<String>>,
    /// Lifetime cap in minutes.
    pub timeout_minutes: i64,
    /// Idle timeout in minutes, when set.
    pub idle_timeout_minutes: Option<i64>,
    /// Why the sandbox terminated, when it did.
    pub termination_reason: Option<String>,
    /// Free-form labels.
    pub labels: Vec<String>,
    /// Creation timestamp (ISO-8601 wire string).
    pub created_at: String,
    /// Last update timestamp (ISO-8601 wire string).
    pub updated_at: String,
    /// Start timestamp, when it started (ISO-8601 wire string).
    pub started_at: Option<String>,
    /// Termination timestamp, when it terminated (ISO-8601 wire string).
    pub terminated_at: Option<String>,
    /// Exit code, when the sandbox ran a command to completion.
    pub exit_code: Option<i64>,
    /// The platform's error classification, when it errored.
    pub error_type: Option<String>,
    /// The platform's error message, when it errored.
    pub error_message: Option<String>,
    /// The owning user id.
    pub user_id: Option<String>,
    /// The billed team id.
    pub team_id: Option<String>,
    /// The placement region, when reported.
    pub region: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_round_trip_and_classify() {
        for (status, wire) in [
            (SandboxStatus::Pending, "PENDING"),
            (SandboxStatus::Provisioning, "PROVISIONING"),
            (SandboxStatus::Running, "RUNNING"),
            (SandboxStatus::Paused, "PAUSED"),
            (SandboxStatus::Error, "ERROR"),
            (SandboxStatus::Terminated, "TERMINATED"),
            (SandboxStatus::Timeout, "TIMEOUT"),
        ] {
            assert_eq!(SandboxStatus::from_wire(wire), Some(status));
            assert_eq!(status.as_str(), wire);
        }
        assert_eq!(SandboxStatus::from_wire("RUNNING_LATER"), None);
    }

    #[test]
    fn only_error_terminated_timeout_are_terminal() {
        for status in [
            SandboxStatus::Pending,
            SandboxStatus::Provisioning,
            SandboxStatus::Running,
            SandboxStatus::Paused,
        ] {
            assert!(!status.is_terminal(), "{status:?}");
        }
        for status in [
            SandboxStatus::Error,
            SandboxStatus::Terminated,
            SandboxStatus::Timeout,
        ] {
            assert!(status.is_terminal(), "{status:?}");
        }
    }
}
