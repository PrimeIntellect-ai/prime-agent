//! The sandbox operations the bot manager needs. [`PrimePlatform`] adapts the
//! Prime Sandboxes client; tests drive the manager through a fake.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::FutureExt;
use pa_sandbox::{
    CommandSessionClient, CommandSessionErrorCode, CommandSessionEvent, CommandSessionOptions,
    CommandSpec, HeaderRule, InputChannel, OutputChannel, PlatformGatewayAuthSource,
    PrimeSandboxClient, SandboxError, SandboxErrorCode, SandboxStatus, SendInputOptions,
    SendSignalOptions, StartOptions, StartRequest, StreamOptions, VmCreateRequest, VmSignal,
    MAX_PROCESS_INPUT_BYTES, NO_TIMEOUT_MINUTES,
};

use super::credentials;
use super::exec_stream::{spawn_exec_halves, ExecStreamHalves, SandboxAuthSource};
use super::BotStatus;

/// The parts of a sandbox the manager reads.
#[derive(Debug, Clone, PartialEq)]
pub struct BotSandbox {
    pub id: String,
    pub name: String,
    pub status: BotStatus,
    pub labels: Vec<String>,
    /// RFC 3339; newest wins among duplicates.
    pub created_at: String,
    pub error_message: Option<String>,
}

/// One checkpoint the platform reports for a bot's sandboxes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotCheckpoint {
    pub id: String,
    /// True once the checkpoint outlives its source sandbox and can be
    /// restored; a pending or failed one cannot.
    pub durable: bool,
    /// RFC 3339; newest wins among the durable ones.
    pub created_at: String,
}

/// One VM create.
#[derive(Debug, Clone, PartialEq)]
pub struct BotCreate {
    pub name: String,
    pub image: String,
    pub labels: Vec<String>,
    pub idempotency_key: String,
    /// Restore the disk from this checkpoint instead of booting the image.
    pub checkpoint_id: Option<String>,
    /// Header rules that put the provider keys on the guest's API requests.
    pub network_rules: BTreeMap<String, HeaderRule>,
}

/// What a guest needs to call its model provider without holding a key.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GuestCredentials {
    /// The sandbox's header rules (set at create).
    pub network_rules: BTreeMap<String, HeaderRule>,
    /// The guest's `auth.json`, holding placeholders for the injected keys.
    pub auth_json: Option<serde_json::Value>,
    /// The guest's `mcpServers` entries for the injected MCP logins.
    pub mcp_servers: Option<serde_json::Value>,
    /// The guest's MCP connection records for the injected catalog logins.
    pub mcp_connections: Option<serde_json::Value>,
}

/// One finished guest command.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExecOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Platform failures, by what the manager does next.
#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    /// The sandbox or checkpoint does not exist.
    #[error("not found: {0}")]
    NotFound(String),
    /// HTTP 409; retried with backoff.
    #[error("conflict: {0}")]
    Conflict(String),
    /// Network, timeout, 429, or 5xx; retried with backoff.
    #[error("{0}")]
    Transient(String),
    /// HTTP 429 because the team's checkpoint storage is full; not retried.
    #[error("the team's checkpoint storage is full: {0}")]
    CheckpointQuota(String),
    /// Anything else; not retried.
    #[error("{0}")]
    Other(String),
}

pub type PlatformResult<T> = Result<T, PlatformError>;

/// The lifecycle and exec calls of one Prime account.
pub trait BotPlatform: Send + Sync {
    fn create<'a>(&'a self, request: &'a BotCreate) -> BoxFuture<'a, PlatformResult<BotSandbox>>;
    fn get<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<BotSandbox>>;
    /// Every sandbox carrying `label`, all pages, terminated ones included.
    fn list<'a>(&'a self, label: &'a str) -> BoxFuture<'a, PlatformResult<Vec<BotSandbox>>>;
    /// A missing sandbox is success.
    fn delete<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<()>>;
    /// Request a pause; returns the pause checkpoint id when the platform reports one.
    fn pause<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<Option<String>>>;
    fn resume<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<BotSandbox>>;
    /// Every checkpoint of the sandboxes carrying `label`, all pages,
    /// oldest first; deleted sandboxes' checkpoints included, so an
    /// outside pause's checkpoint stays findable after the sandbox ends.
    fn list_checkpoints<'a>(
        &'a self,
        label: &'a str,
    ) -> BoxFuture<'a, PlatformResult<Vec<BotCheckpoint>>>;
    /// Start a disk checkpoint; returns its id.
    fn checkpoint<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<String>>;
    /// Wait until the checkpoint is durable.
    fn wait_checkpoint<'a>(&'a self, checkpoint_id: &'a str) -> BoxFuture<'a, PlatformResult<()>>;
    /// True when the checkpoint exists and is durable.
    fn checkpoint_durable<'a>(
        &'a self,
        checkpoint_id: &'a str,
    ) -> BoxFuture<'a, PlatformResult<bool>>;
    /// A missing checkpoint is success.
    fn delete_checkpoint<'a>(&'a self, checkpoint_id: &'a str)
        -> BoxFuture<'a, PlatformResult<()>>;
    /// Run `bash -c script` in the guest and wait for it; `stdin` is written to the process.
    fn exec<'a>(
        &'a self,
        sandbox_id: &'a str,
        script: &'a str,
        env: &'a BTreeMap<String, String>,
        stdin: Option<&'a [u8]>,
    ) -> BoxFuture<'a, PlatformResult<ExecOutput>>;
    /// Start `command` in the guest with its stdio as a byte stream; dropping
    /// the write half ends the process.
    fn open_stream<'a>(
        &'a self,
        sandbox_id: &'a str,
        command: &'a CommandSpec,
    ) -> BoxFuture<'a, PlatformResult<ExecStreamHalves>>;
    /// The API-key secrets and guest auth for a bot, with GitHub access
    /// when `github` is set. `provider` is the bot's provider when it uses
    /// an API key; `reserved_hosts` rule hosts are left for its logins.
    fn credentials<'a>(
        &'a self,
        provider: Option<&'a str>,
        github: bool,
        reserved_hosts: usize,
    ) -> BoxFuture<'a, PlatformResult<GuestCredentials>>;
    /// The Prime account's fingerprint, which names its login secrets.
    fn owner(&self) -> &str;
    /// Make the platform secret `name` hold `value` (create or update),
    /// described by `description`.
    fn put_secret<'a>(
        &'a self,
        name: &'a str,
        value: &'a str,
        description: &'a str,
    ) -> BoxFuture<'a, PlatformResult<()>>;
    /// Replace a running or paused sandbox's header rules (a paused one
    /// gets them on resume).
    fn set_network_rules<'a>(
        &'a self,
        sandbox_id: &'a str,
        rules: &'a BTreeMap<String, HeaderRule>,
    ) -> BoxFuture<'a, PlatformResult<()>>;
}

/// Map a sandbox status onto a bot status.
#[must_use]
pub fn bot_status(status: SandboxStatus) -> BotStatus {
    match status {
        SandboxStatus::Pending | SandboxStatus::Provisioning => BotStatus::Creating,
        SandboxStatus::Running => BotStatus::Running,
        SandboxStatus::Paused => BotStatus::Paused,
        SandboxStatus::Terminated | SandboxStatus::Timeout => BotStatus::Stopped,
        SandboxStatus::Error => BotStatus::Error,
    }
}

const BOT_CPU_CORES: f64 = 2.0;
const BOT_MEMORY_GB: f64 = 4.0;
const BOT_DISK_GB: f64 = 20.0;
/// Prime's published sandbox rates in USD per hour: the sandbox API carries no price.
const USD_PER_CPU_HOUR: f64 = 0.02;
const USD_PER_MEMORY_GIB_HOUR: f64 = 0.0125;
const USD_PER_DISK_GIB_HOUR: f64 = 0.0002;
/// The estimated price of one running bot sandbox, in USD per hour.
pub const BOT_HOURLY_USD_ESTIMATE: f64 = BOT_CPU_CORES * USD_PER_CPU_HOUR
    + BOT_MEMORY_GB * USD_PER_MEMORY_GIB_HOUR
    + BOT_DISK_GB * USD_PER_DISK_GIB_HOUR;
const CHECKPOINT_WAIT: Duration = Duration::from_mins(10);
const CHECKPOINT_POLL: Duration = Duration::from_secs(2);
/// How long a streamed guest process may take to start.
const STREAM_START_WAIT: Duration = Duration::from_secs(60);
/// A bootstrap or install command gets this long before sandboxd kills it.
const EXEC_DEADLINE_MS: u64 = 10 * 60 * 1000;
/// The daemon stops waiting on a silent gateway this long after sandboxd's kill.
const EXEC_WAIT: Duration = Duration::from_millis(EXEC_DEADLINE_MS + 60_000);
/// The daemon keeps this much of each guest output channel; the rest is dropped.
const MAX_EXEC_OUTPUT_BYTES: usize = 1024 * 1024;

/// [`BotPlatform`] over the Prime Sandboxes REST client and the VM command session.
pub struct PrimePlatform {
    client: Arc<PrimeSandboxClient>,
    /// Where the provider keys to inject are stored.
    agent_dir: PathBuf,
    /// The Prime account's fingerprint, which names its GitHub secrets.
    owner: String,
}

impl PrimePlatform {
    #[must_use]
    pub fn new(client: PrimeSandboxClient, agent_dir: &Path, owner: String) -> Self {
        Self {
            client: Arc::new(client),
            agent_dir: agent_dir.to_path_buf(),
            owner,
        }
    }

    async fn run(
        &self,
        sandbox_id: &str,
        script: &str,
        env: &BTreeMap<String, String>,
        stdin: Option<&[u8]>,
    ) -> PlatformResult<ExecOutput> {
        let auth = PlatformGatewayAuthSource::new(Arc::clone(&self.client), sandbox_id)
            .map_err(|error| map_error(&error))?;
        let sessions = CommandSessionClient::new(auth, CommandSessionOptions::default())
            .map_err(|error| PlatformError::Other(error.to_string()))?;
        let session_uuid = uuid::Uuid::new_v4().to_string();
        let request = StartRequest {
            command: CommandSpec {
                cmd: "bash".into(),
                args: vec!["-c".into(), script.into()],
                envs: env.clone(),
                cwd: Some("/".into()),
            },
            pty: None,
            stdin: stdin.is_some(),
            session_uuid: session_uuid.clone(),
        };
        // The stream does not reattach on its own: a silent reattach loses
        // output, so the loop below reattaches and marks the run attached.
        let options = StartOptions {
            stream: StreamOptions {
                max_reconnects: Some(0),
                ..StreamOptions::default()
            },
            connect_timeout_ms: Some(EXEC_DEADLINE_MS),
        };
        // A definitive answer fails now. Any other start fault may have
        // reached sandboxd, so attach to the session if it exists: a second
        // session would run the script twice at once. An attached command's
        // earlier output is lost, so it runs again after it ends; the guest
        // scripts are safe to rerun in sequence. When the gateway cannot
        // confirm the session, the guest is not up yet.
        let (mut stream, mut attached) = match sessions.start(&request, options).await {
            Ok(stream) => (stream, false),
            Err(error)
                if matches!(
                    error.code(),
                    CommandSessionErrorCode::InvalidRequest
                        | CommandSessionErrorCode::InvalidArgument
                        | CommandSessionErrorCode::TooLarge
                        | CommandSessionErrorCode::PermissionDenied
                        | CommandSessionErrorCode::Unauthenticated
                ) =>
            {
                return Err(PlatformError::Other(error.to_string()));
            }
            Err(error) => {
                let stream = sessions
                    .connect(&session_uuid, StreamOptions::default())
                    .await
                    .map_err(|_| PlatformError::Transient(error.to_string()))?;
                (stream, true)
            }
        };
        for chunk in stdin.unwrap_or_default().chunks(MAX_PROCESS_INPUT_BYTES) {
            sessions
                .send_input(
                    &session_uuid,
                    InputChannel::Stdin,
                    chunk,
                    SendInputOptions::default(),
                )
                .await
                .map_err(|error| {
                    // An attached command may have ended before it got input.
                    if attached {
                        PlatformError::Transient(error.to_string())
                    } else {
                        PlatformError::Other(error.to_string())
                    }
                })?;
        }
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        while let Some(event) = stream.next_event().await {
            let event = match event {
                Ok(event) => event,
                Err(error) if error.is_recoverable_stream_fault() => {
                    stream = sessions
                        .connect(&session_uuid, StreamOptions::default())
                        .await
                        .map_err(|_| PlatformError::Transient(error.to_string()))?;
                    attached = true;
                    continue;
                }
                Err(error) => return Err(PlatformError::Other(error.to_string())),
            };
            match event {
                CommandSessionEvent::Data { channel, data } => {
                    let buffer = if channel == OutputChannel::Stderr {
                        &mut stderr
                    } else {
                        &mut stdout
                    };
                    let room = MAX_EXEC_OUTPUT_BYTES.saturating_sub(buffer.len());
                    buffer.extend_from_slice(&data[..data.len().min(room)]);
                }
                CommandSessionEvent::End(_) if attached => {
                    return Err(PlatformError::Transient(
                        "the guest command ran without its output".into(),
                    ));
                }
                CommandSessionEvent::End(end) => {
                    return Ok(ExecOutput {
                        exit_code: end.exit_code.unwrap_or(-1),
                        stdout: String::from_utf8_lossy(&stdout).into_owned(),
                        stderr: String::from_utf8_lossy(&stderr).into_owned(),
                    });
                }
                CommandSessionEvent::Start { .. } | CommandSessionEvent::Keepalive => {}
            }
        }
        Err(PlatformError::Other(
            "the guest command stream ended before the command exited".into(),
        ))
    }
}

fn map_error(error: &SandboxError) -> PlatformError {
    let message = error.to_string();
    match (error.code(), error.status()) {
        (SandboxErrorCode::SandboxNotFound, _) | (_, Some(404)) => PlatformError::NotFound(message),
        (SandboxErrorCode::Conflict, _) => PlatformError::Conflict(message),
        (
            SandboxErrorCode::Network
            | SandboxErrorCode::Timeout
            | SandboxErrorCode::RequestTimeout,
            _,
        ) => PlatformError::Transient(message),
        // A rate limit passes: the caller retries with backoff.
        (_, Some(429))
            if error
                .details()
                .is_some_and(|details| details.contains("Checkpoint storage limit")) =>
        {
            PlatformError::CheckpointQuota(message)
        }
        (_, Some(status)) if status >= 500 || status == 429 => PlatformError::Transient(message),
        _ => PlatformError::Other(message),
    }
}

fn sandbox_view(sandbox: pa_sandbox::Sandbox) -> BotSandbox {
    BotSandbox {
        status: bot_status(sandbox.status),
        id: sandbox.id,
        name: sandbox.name,
        labels: sandbox.labels,
        created_at: sandbox.created_at,
        error_message: sandbox.error_message,
    }
}

impl BotPlatform for PrimePlatform {
    fn create<'a>(&'a self, request: &'a BotCreate) -> BoxFuture<'a, PlatformResult<BotSandbox>> {
        async move {
            // A checkpoint restore carries the checkpoint's image and disk size.
            let restoring = request.checkpoint_id.is_some();
            let create = VmCreateRequest {
                name: request.name.clone(),
                docker_image: if restoring {
                    String::new()
                } else {
                    request.image.clone()
                },
                cpu_cores: BOT_CPU_CORES,
                memory_gb: BOT_MEMORY_GB,
                disk_size_gb: if restoring { 0.0 } else { BOT_DISK_GB },
                gpu_count: 0,
                gpu_type: None,
                start_command: None,
                network_allowlist: None,
                network_denylist: None,
                // No lifetime cap; the owner's daemon pauses idle bots.
                timeout_minutes: NO_TIMEOUT_MINUTES,
                idle_timeout_minutes: None,
                environment_vars: None,
                secrets: None,
                network_rules: (!request.network_rules.is_empty())
                    .then(|| request.network_rules.clone()),
                labels: request.labels.clone(),
                idempotency_key: Some(request.idempotency_key.clone()),
                checkpoint_id: request.checkpoint_id.clone(),
            };
            self.client
                .create_vm_sandbox(&create)
                .await
                .map(sandbox_view)
                .map_err(|error| map_error(&error))
        }
        .boxed()
    }

    fn get<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<BotSandbox>> {
        async move {
            self.client
                .get_sandbox(sandbox_id)
                .await
                .map(sandbox_view)
                .map_err(|error| map_error(&error))
        }
        .boxed()
    }

    fn list<'a>(&'a self, label: &'a str) -> BoxFuture<'a, PlatformResult<Vec<BotSandbox>>> {
        async move {
            let sandboxes = self
                .client
                .list_sandboxes(&[label.to_string()])
                .await
                .map_err(|error| map_error(&error))?;
            Ok(sandboxes.into_iter().map(sandbox_view).collect())
        }
        .boxed()
    }

    fn delete<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            match self
                .client
                .delete_sandbox(sandbox_id)
                .await
                .map_err(|error| map_error(&error))
            {
                Ok(()) | Err(PlatformError::NotFound(_)) => Ok(()),
                Err(error) => Err(error),
            }
        }
        .boxed()
    }

    fn pause<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<Option<String>>> {
        async move {
            self.client
                .pause_sandbox(sandbox_id)
                .await
                .map(|paused| paused.checkpoint_id)
                .map_err(|error| map_error(&error))
        }
        .boxed()
    }

    fn resume<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<BotSandbox>> {
        async move {
            self.client
                .resume_sandbox(sandbox_id)
                .await
                .map(sandbox_view)
                .map_err(|error| map_error(&error))
        }
        .boxed()
    }

    fn list_checkpoints<'a>(
        &'a self,
        label: &'a str,
    ) -> BoxFuture<'a, PlatformResult<Vec<BotCheckpoint>>> {
        async move {
            self.client
                .list_checkpoints(&[label.to_string()])
                .await
                .map(|checkpoints| {
                    checkpoints
                        .into_iter()
                        .map(|checkpoint| {
                            let durable = checkpoint.is_durable();
                            BotCheckpoint {
                                id: checkpoint.id,
                                durable,
                                created_at: checkpoint.created_at,
                            }
                        })
                        .collect()
                })
                .map_err(|error| map_error(&error))
        }
        .boxed()
    }

    fn checkpoint<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, PlatformResult<String>> {
        async move {
            self.client
                .create_checkpoint(sandbox_id)
                .await
                .map(|checkpoint| checkpoint.id)
                .map_err(|error| map_error(&error))
        }
        .boxed()
    }

    fn wait_checkpoint<'a>(&'a self, checkpoint_id: &'a str) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            self.client
                .wait_for_checkpoint(checkpoint_id, CHECKPOINT_WAIT, CHECKPOINT_POLL)
                .await
                .map(drop)
                .map_err(|error| map_error(&error))
        }
        .boxed()
    }

    fn checkpoint_durable<'a>(
        &'a self,
        checkpoint_id: &'a str,
    ) -> BoxFuture<'a, PlatformResult<bool>> {
        async move {
            match self.client.get_checkpoint(checkpoint_id).await {
                Ok(checkpoint) => Ok(checkpoint.is_durable()),
                Err(error) => match map_error(&error) {
                    PlatformError::NotFound(_) => Ok(false),
                    other => Err(other),
                },
            }
        }
        .boxed()
    }

    fn delete_checkpoint<'a>(
        &'a self,
        checkpoint_id: &'a str,
    ) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            match self
                .client
                .delete_checkpoint(checkpoint_id)
                .await
                .map_err(|error| map_error(&error))
            {
                Ok(()) | Err(PlatformError::NotFound(_)) => Ok(()),
                Err(error) => Err(error),
            }
        }
        .boxed()
    }

    fn exec<'a>(
        &'a self,
        sandbox_id: &'a str,
        script: &'a str,
        env: &'a BTreeMap<String, String>,
        stdin: Option<&'a [u8]>,
    ) -> BoxFuture<'a, PlatformResult<ExecOutput>> {
        async move {
            tokio::time::timeout(EXEC_WAIT, self.run(sandbox_id, script, env, stdin))
                .await
                .unwrap_or_else(|_| {
                    Err(PlatformError::Transient(
                        "the gateway sent no command result in time".into(),
                    ))
                })
        }
        .boxed()
    }

    fn open_stream<'a>(
        &'a self,
        sandbox_id: &'a str,
        command: &'a CommandSpec,
    ) -> BoxFuture<'a, PlatformResult<ExecStreamHalves>> {
        async move {
            let source = SandboxAuthSource::new(Arc::clone(&self.client), sandbox_id.to_string());
            let session_uuid = uuid::Uuid::new_v4().to_string();
            let request = StartRequest {
                command: command.clone(),
                pty: None,
                stdin: true,
                session_uuid: session_uuid.clone(),
            };
            let started = tokio::time::timeout(
                STREAM_START_WAIT,
                // The relay lives as long as the link: no deadline header
                // (sandboxd reads `Connect-Timeout-Ms: 0` as an expired
                // deadline). A silent reattach loses stdout, so a stream
                // fault ends the link.
                spawn_exec_halves(
                    &source,
                    &request,
                    StartOptions {
                        stream: StreamOptions {
                            max_reconnects: Some(0),
                            ..StreamOptions::default()
                        },
                        connect_timeout_ms: None,
                    },
                ),
            )
            .await;
            let error = match started {
                Ok(Ok(halves)) => return Ok(halves),
                Ok(Err(error)) => format!("{error:#}"),
                Err(_) => "the guest process sent no start event in time".to_string(),
            };
            // The process may have started without its start event reaching
            // us; do not leave it running.
            if let Ok(client) = source.command_client() {
                let _ = client
                    .send_signal(
                        &session_uuid,
                        VmSignal::Terminate,
                        SendSignalOptions::default(),
                    )
                    .await;
            }
            Err(PlatformError::Transient(error))
        }
        .boxed()
    }

    fn credentials<'a>(
        &'a self,
        provider: Option<&'a str>,
        github: bool,
        reserved_hosts: usize,
    ) -> BoxFuture<'a, PlatformResult<GuestCredentials>> {
        async move {
            let provisioned = credentials::provision(
                &self.client,
                &self.agent_dir,
                &self.owner,
                provider,
                github,
                reserved_hosts,
            )
            .await;
            let auth_json = provisioned.guest_auth();
            let network_rules = match provider {
                Some(provider) => provisioned
                    .rules_for(provider)
                    .map_err(|error| credential_error(&error))?,
                None => provisioned.rules(),
            };
            Ok(GuestCredentials {
                network_rules,
                auth_json,
                mcp_servers: None,
                mcp_connections: None,
            })
        }
        .boxed()
    }

    fn owner(&self) -> &str {
        &self.owner
    }

    fn put_secret<'a>(
        &'a self,
        name: &'a str,
        value: &'a str,
        description: &'a str,
    ) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            credentials::ensure_secret(&self.client, name, value, description)
                .await
                .map_err(|error| credential_error(&error))
        }
        .boxed()
    }

    fn set_network_rules<'a>(
        &'a self,
        sandbox_id: &'a str,
        rules: &'a BTreeMap<String, HeaderRule>,
    ) -> BoxFuture<'a, PlatformResult<()>> {
        async move {
            self.client
                .set_network_rules(sandbox_id, rules)
                .await
                .map_err(|error| map_error(&error))
        }
        .boxed()
    }
}

/// A credential provisioning failure; a platform blip is retried.
fn credential_error(error: &anyhow::Error) -> PlatformError {
    let message = format!("{error:#}");
    match error.downcast_ref::<SandboxError>().map(map_error) {
        Some(PlatformError::Transient(_)) => PlatformError::Transient(message),
        Some(PlatformError::Conflict(_)) => PlatformError::Conflict(message),
        Some(
            PlatformError::NotFound(_)
            | PlatformError::CheckpointQuota(_)
            | PlatformError::Other(_),
        )
        | None => PlatformError::Other(message),
    }
}

#[cfg(test)]
mod tests {
    use pa_sandbox::types::Method;
    use pa_sandbox::SandboxError;

    use super::{map_error, PlatformError};

    #[test]
    fn a_rate_limit_is_retried() {
        let error = SandboxError::http("Sandbox list failed with HTTP 429").with_http_context(
            Method::Get,
            "https://api.test/sandbox",
            Some(429),
            None,
        );
        assert!(matches!(map_error(&error), PlatformError::Transient(_)));
    }

    #[test]
    fn a_full_checkpoint_storage_is_not_retried() {
        let error = SandboxError::http("Sandbox pause failed with HTTP 429").with_http_context(
            Method::Post,
            "https://api.test/sandbox/sb-1/pause",
            Some(429),
            Some("Checkpoint storage limit reached: 27376.7GiB used of 20480GiB allowed.".into()),
        );
        assert!(matches!(
            map_error(&error),
            PlatformError::CheckpointQuota(_)
        ));
    }
}
