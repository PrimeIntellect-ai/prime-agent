//! The sandbox operations the bot manager needs. [`PrimePlatform`] adapts the
//! Prime Sandboxes client; tests drive the manager through a fake.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::FutureExt;
use pa_sandbox::{
    CommandSessionClient, CommandSessionErrorCode, CommandSessionEvent, CommandSessionOptions,
    CommandSpec, InputChannel, OutputChannel, PlatformGatewayAuthSource, PrimeSandboxClient,
    SandboxError, SandboxErrorCode, SandboxStatus, SendInputOptions, StartOptions, StartRequest,
    VmCreateRequest, MAX_PROCESS_INPUT_BYTES, NO_TIMEOUT_MINUTES,
};

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

/// One VM create.
#[derive(Debug, Clone, PartialEq)]
pub struct BotCreate {
    pub name: String,
    pub image: String,
    pub labels: Vec<String>,
    pub idempotency_key: String,
    /// Restore the disk from this checkpoint instead of booting the image.
    pub checkpoint_id: Option<String>,
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
    /// Network, timeout, or 5xx; retried with backoff.
    #[error("{0}")]
    Transient(String),
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
const CHECKPOINT_WAIT: Duration = Duration::from_mins(10);
const CHECKPOINT_POLL: Duration = Duration::from_secs(2);
/// A bootstrap or install command gets this long before sandboxd kills it.
const EXEC_DEADLINE_MS: u64 = 10 * 60 * 1000;

/// [`BotPlatform`] over the Prime Sandboxes REST client and the VM command session.
pub struct PrimePlatform {
    client: Arc<PrimeSandboxClient>,
}

impl PrimePlatform {
    #[must_use]
    pub fn new(client: PrimeSandboxClient) -> Self {
        Self {
            client: Arc::new(client),
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
        let options = StartOptions {
            connect_timeout_ms: Some(EXEC_DEADLINE_MS),
            ..StartOptions::default()
        };
        // A start that failed on the link, or before the guest gateway
        // knows the sandbox, retries. Once the command runs, a failure is
        // final: a retry would run the script twice.
        let mut stream = sessions.start(&request, options).await.map_err(|error| {
            if error.is_recoverable_stream_fault()
                || error.code() == CommandSessionErrorCode::SandboxNotFound
            {
                PlatformError::Transient(error.to_string())
            } else {
                PlatformError::Other(error.to_string())
            }
        })?;
        for chunk in stdin.unwrap_or_default().chunks(MAX_PROCESS_INPUT_BYTES) {
            sessions
                .send_input(
                    &session_uuid,
                    InputChannel::Stdin,
                    chunk,
                    SendInputOptions::default(),
                )
                .await
                .map_err(|error| PlatformError::Other(error.to_string()))?;
        }
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        while let Some(event) = stream.next_event().await {
            match event.map_err(|error| PlatformError::Other(error.to_string()))? {
                CommandSessionEvent::Data { channel, data } => {
                    if channel == OutputChannel::Stderr {
                        stderr.extend_from_slice(&data);
                    } else {
                        stdout.extend_from_slice(&data);
                    }
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
        (_, Some(status)) if status >= 500 => PlatformError::Transient(message),
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
                network_rules: None,
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
        self.run(sandbox_id, script, env, stdin).boxed()
    }
}
