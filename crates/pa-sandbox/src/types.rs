//! The lifecycle wire vocabulary: statuses, the create request, the sandbox
//! and checkpoint records, and the shared timing defaults. Timestamps are
//! validated as non-empty strings, not parsed dates.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Create retry budget: transient transport failures retry up to this many
/// attempts reusing the same server-side idempotency key.
pub const PRIME_SANDBOX_CREATE_MAX_ATTEMPTS: usize = 3;

/// Default per-request deadline.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// `timeout_minutes` value for a sandbox with no lifetime cap.
pub const NO_TIMEOUT_MINUTES: i64 = -1;

/// Default overall wait budget.
pub const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(600);

/// Default wait poll interval.
pub const DEFAULT_WAIT_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The sandbox lifecycle statuses (wire names uppercase).
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
    /// that to an `invalid_response` error).
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

    /// True for the statuses a sandbox never leaves.
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
    /// `PATCH`.
    Patch,
    /// `PUT`.
    Put,
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
            Self::Patch => "PATCH",
            Self::Put => "PUT",
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

/// A filesystem checkpoint of a sandbox (the platform's durability
/// unit): only `DURABLE` checkpoints outlive their source sandbox and
/// can be restored into a new one. The checkpoint endpoints answer in
/// `snake_case` (unlike the `camelCase` sandbox records).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SandboxCheckpoint {
    pub id: String,
    pub sandbox_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// `PENDING`, `DURABLE`, or a terminal failure state.
    pub state: String,
    pub depth: u32,
    pub docker_image: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored_bytes: Option<u64>,
    #[serde(default)]
    pub occupied_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// The states a checkpoint may take; only [`Self::Durable`] restores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxCheckpointState {
    Pending,
    Durable,
}

impl SandboxCheckpoint {
    /// The parsed state, when recognized.
    #[must_use]
    pub fn checkpoint_state(&self) -> Option<SandboxCheckpointState> {
        match self.state.as_str() {
            "PENDING" => Some(SandboxCheckpointState::Pending),
            "DURABLE" => Some(SandboxCheckpointState::Durable),
            _ => None,
        }
    }

    /// True once the checkpoint outlives its source sandbox.
    #[must_use]
    pub fn is_durable(&self) -> bool {
        self.checkpoint_state() == Some(SandboxCheckpointState::Durable)
    }
}

/// A create request for a VM-backed sandbox. The client always sends
/// `vm: true` and an
/// `idempotency_key` (the request's when set, else a fresh UUID).
///
/// `region` is deliberately unrepresentable: it is not caller-selectable
/// for VM sandboxes.
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
    /// An empty string is treated as unset.
    pub gpu_type: Option<String>,
    /// Structured VM start command; `None` keeps the image default.
    pub start_command: Option<StartCommand>,
    /// VM-only egress allowlist; mutually exclusive with
    /// `network_denylist`.
    pub network_allowlist: Option<Vec<String>>,
    /// VM-only egress denylist; mutually exclusive with
    /// `network_allowlist`.
    pub network_denylist: Option<Vec<String>>,
    /// Sandbox lifetime cap in minutes; 1 to 1440, or
    /// [`NO_TIMEOUT_MINUTES`] for no cap.
    pub timeout_minutes: i64,
    /// Terminate after this many minutes without activity; at least 1 and,
    /// when the lifetime is capped, at most `timeout_minutes`.
    pub idle_timeout_minutes: Option<i64>,
    /// Environment variables in the sandbox; shell-identifier keys.
    pub environment_vars: Option<BTreeMap<String, String>>,
    /// Secrets in the sandbox; shell-identifier keys.
    pub secrets: Option<BTreeMap<String, String>>,
    /// VM-only HTTPS header rules keyed by rule host: the platform sets
    /// the headers on the sandbox's requests to that host, resolving
    /// `${prime.secrets.<NAME>}` references outside the sandbox. A rule
    /// grants no egress: the allow or deny list must still let the host
    /// through.
    pub network_rules: Option<BTreeMap<String, HeaderRule>>,
    /// Free-form labels; non-empty, at most 256 characters each.
    pub labels: Vec<String>,
    /// Create idempotency key; 1-128 characters of letters, digits, dots,
    /// underscores, or dashes, starting with a letter or digit. The server
    /// returns the same sandbox for repeated creates carrying the same key.
    pub idempotency_key: Option<String>,
    /// Restore from a DURABLE checkpoint: the restored sandbox carries the
    /// checkpoint's image and disk size, so `docker_image` and
    /// `disk_size_gb` must be left unset on a restore.
    pub checkpoint_id: Option<String>,
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
            // Rule values may carry literal header text: show only the hosts.
            .field(
                "network_rules",
                &self
                    .network_rules
                    .as_ref()
                    .map(|rules| rules.keys().collect::<Vec<_>>()),
            )
            .field("labels", &self.labels)
            .field("idempotency_key", &self.idempotency_key)
            .field("checkpoint_id", &self.checkpoint_id)
            .finish()
    }
}

/// The headers the platform sets on a sandbox's HTTPS requests to one
/// rule host (the SDK's `HeaderRule`). A value is text with zero or more
/// `${prime.secrets.<NAME>}` references, which the platform resolves
/// outside the sandbox, so the secret never enters it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeaderRule {
    /// Header name to value template.
    pub headers: BTreeMap<String, String>,
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

/// The answer to a pause request: the sandbox record and the checkpoint
/// the pause froze. The sandbox reaches `PAUSED` asynchronously.
#[derive(Debug, Clone, PartialEq)]
pub struct PausedSandbox {
    /// The sandbox record at the time of the pause request.
    pub sandbox: Sandbox,
    /// The checkpoint the pause froze, when the platform reports one.
    pub checkpoint_id: Option<String>,
}
