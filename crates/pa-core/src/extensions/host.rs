//! Extension sidecar process lifecycle (design doc stage 1): locate and
//! spawn `node` with the host script, run the protocol-1 `hello` handshake
//! over [`RpcClient`], ping health checks, and orderly shutdown
//! (§2.4: send `shutdown`, wait briefly, then kill). The sidecar is killed
//! with the rest of the process tree when this host is dropped without a
//! shutdown.
//!
//! Restart/backoff (§2.4) is deliberately absent in stage 1: the caller
//! observes death through `is_alive()` and the notifications channel, and
//! spawns a fresh host when it needs one. The session-engine seam that
//! decides *when* to restart is a later stage.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use pa_types::extension_rpc::{
    EventParams, HelloParams, HelloResult, ShutdownParams, ToolExecuteParams, ToolExecuteResult,
    EXTENSION_HOST_NODE_MAJOR_FLOOR, EXTENSION_RPC_PROTOCOL, METHOD_EVENT, METHOD_HELLO,
    METHOD_PING, METHOD_SHUTDOWN, METHOD_TOOL_EXECUTE,
};
use pa_types::JsonMap;
use serde_json::Value;
use tokio::process::{Child, ChildStdin};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::client::{CtxCallHandler, RpcClient, SidecarNotification};
use super::framing::LineLimits;
use super::script::materialize_host_script;

/// Timeouts for the sidecar lifecycle. Settings-owned defaults arrive with
/// the session-engine seam; these are the generous load-time defaults
/// (design doc §2.4).
#[derive(Debug, Clone, Copy)]
pub struct HostTimeouts {
    /// `hello` handshake (includes stage-2 module loading).
    pub hello: Duration,
    /// Per-RPC request timeout (`ping`, `event` dispatch).
    pub rpc: Duration,
    /// How long `shutdown` waits for the exit before killing.
    pub shutdown_wait: Duration,
}

impl Default for HostTimeouts {
    fn default() -> Self {
        HostTimeouts {
            hello: Duration::from_secs(30),
            rpc: Duration::from_secs(30),
            shutdown_wait: Duration::from_secs(10),
        }
    }
}

/// Which host script the sidecar runs.
#[derive(Debug, Clone)]
pub enum HostScript {
    /// The bundled stage-1 script, materialized content-addressed under
    /// `<agent_dir>/extension-host/` ([`materialize_host_script`]).
    Bundled,
    /// A specific host script on disk (integration tests; the stage-2 jiti
    /// bundle installs the same way).
    At(PathBuf),
}

/// Everything needed to spawn one sidecar incarnation.
#[derive(Clone)]
pub struct ExtensionHostSpec {
    /// The `node` binary to run. Not probed for version here: the host
    /// script checks the major-version floor in the handshake so the
    /// failure surfaces with a clear protocol message.
    pub node: PathBuf,
    pub cwd: PathBuf,
    pub agent_dir: PathBuf,
    pub script: HostScript,
    /// Resolved extension paths (discovery runs in Rust; §1.1). Empty in
    /// stage 1 - the bundled script loads nothing yet.
    pub extension_paths: Vec<String>,
    /// CLI flag values that override registered defaults.
    pub flag_values: JsonMap,
    /// Answers ctx-action calls the sidecar makes while a handler runs.
    /// `None` rejects every ctx action with a `not bound` error.
    pub ctx_handler: Option<Arc<dyn CtxCallHandler>>,
    pub timeouts: HostTimeouts,
}

impl ExtensionHostSpec {
    pub fn new(cwd: impl Into<PathBuf>, agent_dir: impl Into<PathBuf>) -> Self {
        ExtensionHostSpec {
            node: PathBuf::from("node"),
            cwd: cwd.into(),
            agent_dir: agent_dir.into(),
            script: HostScript::Bundled,
            extension_paths: Vec::new(),
            flag_values: JsonMap::new(),
            ctx_handler: None,
            timeouts: HostTimeouts::default(),
        }
    }
}

/// One live extension sidecar: the child process plus its RPC client. The
/// read loop and stderr drain are spawned by [`ExtensionHost::start`].
pub struct ExtensionHost {
    client: Arc<RpcClient<ChildStdin>>,
    /// Taken by [`ExtensionHost::shutdown`]; a host dropped while the child
    /// is still set kills the process group (§2.4 crash isolation).
    child: Option<Child>,
    notifications: Option<mpsc::Receiver<SidecarNotification>>,
    timeouts: HostTimeouts,
    /// The handshake result: the registrations the load produced, and the
    /// per-path load errors (never fatal).
    hello: HelloResult,
}

impl ExtensionHost {
    /// Spawn the sidecar and complete the protocol-1 `hello` handshake.
    /// On handshake failure the freshly spawned child is killed before
    /// the error propagates (nothing leaks a live sidecar).
    ///
    /// # Errors
    ///
    /// Returns an error when the host script cannot be materialized or is
    /// missing, the sidecar cannot be spawned (e.g. the Node binary is not
    /// found), its stdio cannot be piped, the `hello` params or reply cannot
    /// be (de)serialized, the handshake request fails, or the sidecar speaks
    /// a different protocol version.
    #[tracing::instrument(
        skip_all,
        fields(cwd = %spec.cwd.display(), agent_dir = %spec.agent_dir.display())
    )]
    pub async fn start(spec: ExtensionHostSpec) -> Result<ExtensionHost> {
        let script_path = match &spec.script {
            HostScript::Bundled => materialize_host_script(&spec.agent_dir)?,
            HostScript::At(path) => path.clone(),
        };
        if !script_path.is_file() {
            return Err(anyhow!(
                "extension host script not found: {}",
                script_path.display()
            ));
        }
        let mut command = tokio::process::Command::new(&spec.node);
        command
            .arg(&script_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        // Own process group: a hung sidecar is killed together with any
        // descendants it spawns (stage-2 jiti workers).
        crate::platform::set_new_process_group(command.as_std_mut());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(anyhow!(
                    "node not found at '{}' (the extension host requires Node >= {EXTENSION_HOST_NODE_MAJOR_FLOOR})",
                    spec.node.display()
                ));
            }
            Err(error) => {
                return Err(anyhow!(
                    "spawning extension host `{} {}`: {error}",
                    spec.node.display(),
                    script_path.display()
                ));
            }
        };
        let stdin = child
            .stdin
            .take()
            .context("extension host stdin was not piped")?;
        let stdout = child
            .stdout
            .take()
            .context("extension host stdout was not piped")?;
        let stderr = child
            .stderr
            .take()
            .context("extension host stderr was not piped")?;
        drain_stderr(stderr);
        let (notifications_tx, notifications) = mpsc::channel(64);
        let client = RpcClient::new(
            stdin,
            notifications_tx,
            spec.ctx_handler.clone(),
            LineLimits::default(),
        );
        let pump = Arc::clone(&client);
        tokio::spawn(async move {
            // Only the death reason matters here; the caller observes it
            // through request errors and `is_alive`.
            let _ = pump.read_loop(stdout).await;
        });

        let hello_params = serde_json::to_value(HelloParams {
            protocol: EXTENSION_RPC_PROTOCOL,
            cwd: spec.cwd.to_string_lossy().into_owned(),
            agent_dir: spec.agent_dir.to_string_lossy().into_owned(),
            extension_paths: spec.extension_paths.clone(),
            flag_values: spec.flag_values.clone(),
        })
        .context("serializing extension host hello params")?;
        let handshake = client
            .request(METHOD_HELLO, hello_params, spec.timeouts.hello)
            .await
            .context("extension host handshake failed")?;
        let hello: HelloResult =
            serde_json::from_value(handshake).context("parsing extension host hello result")?;
        if hello.protocol != EXTENSION_RPC_PROTOCOL {
            return Err(anyhow!(
                "extension host protocol mismatch: sidecar speaks {}, this build speaks {}",
                hello.protocol,
                EXTENSION_RPC_PROTOCOL
            ));
        }
        for error in &hello.errors {
            debug!(
                target: "extension_host",
                "extension load error ({}): {}",
                error.path,
                error.error
            );
        }
        Ok(ExtensionHost {
            client,
            child: Some(child),
            notifications: Some(notifications),
            timeouts: spec.timeouts,
            hello,
        })
    }

    /// The `hello` handshake result: registrations as loaded, plus
    /// per-path load errors (the stage-2 registration landing).
    pub fn hello(&self) -> &HelloResult {
        &self.hello
    }

    /// The RPC client half: shared so bridged extension tools can execute
    /// over the same connection while the host owns the process.
    pub(crate) fn client(&self) -> &Arc<RpcClient<ChildStdin>> {
        &self.client
    }

    /// Whether the RPC side is still usable (§2.4: death never crashes the
    /// session; emits degrade to no-ops and requests fail fast).
    pub fn is_alive(&self) -> bool {
        self.client.is_alive()
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(Child::id)
    }

    /// Sidecar notifications (`extension_error`, registration changes) in
    /// arrival order. Dropping this receiver makes the sidecar's
    /// notifications fall on the floor; hold it for the session lifetime.
    ///
    /// # Panics
    ///
    /// Panics when called more than once.
    pub fn take_notifications(&mut self) -> mpsc::Receiver<SidecarNotification> {
        self.notifications
            .take()
            .expect("notifications are taken exactly once")
    }

    /// Liveness probe.
    ///
    /// # Errors
    ///
    /// Returns an error when the sidecar is not running, the ping request
    /// fails or times out, or the reply is invalid.
    pub async fn ping(&self) -> Result<Value> {
        self.client
            .request(METHOD_PING, Value::Null, self.timeouts.rpc)
            .await
    }

    /// Dispatch one extension event; the reply carries the accumulated
    /// handler result (stage-1 scripts have no handlers, so `null`).
    ///
    /// # Errors
    ///
    /// Returns an error when the event params cannot be serialized or the
    /// RPC request fails (sidecar dead, RPC error, or timeout).
    pub async fn emit_event(&self, event_type: &str, payload: Value) -> Result<Value> {
        let params = serde_json::to_value(EventParams {
            event_id: uuid::Uuid::new_v4().to_string(),
            event_type: event_type.to_string(),
            payload,
        })
        .context("serializing extension event params")?;
        self.client
            .request(METHOD_EVENT, params, self.timeouts.rpc)
            .await
    }

    /// Execute one registered extension tool over the RPC (design doc §2.3
    /// `tool_execute`); the sidecar streams `tool_update` notifications while
    /// the tool runs, then replies with the final result.
    ///
    /// # Errors
    ///
    /// Returns an error when the tool params cannot be serialized, the RPC
    /// request fails, or the reply cannot be parsed as a tool result.
    pub async fn execute_tool(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        args: Value,
    ) -> Result<ToolExecuteResult> {
        let params = serde_json::to_value(ToolExecuteParams {
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            args,
        })
        .context("serializing extension tool execute params")?;
        let result = self
            .client
            .request(METHOD_TOOL_EXECUTE, params, self.timeouts.rpc)
            .await
            .context("extension tool execution failed")?;
        serde_json::from_value(result).context("parsing extension tool result")
    }

    /// Orderly shutdown (§2.4): send `shutdown`, wait briefly, then kill the
    /// process group. Returns when the child is reaped, however it died.
    ///
    /// # Errors
    ///
    /// Returns an error only when waiting for the child fails: reaping its
    /// exit status after a natural exit or after the kill times out. A
    /// sidecar that ignores or rejects the `shutdown` request is killed and
    /// reported as success.
    ///
    /// # Panics
    ///
    /// Panics when called more than once (the child handle is taken only by
    /// shutdown).
    #[tracing::instrument(skip_all, fields(pid = self.pid()))]
    pub async fn shutdown(mut self, reason: &str) -> Result<()> {
        let request = self
            .client
            .request(
                METHOD_SHUTDOWN,
                serde_json::to_value(ShutdownParams {
                    reason: reason.to_string(),
                })
                .context("serializing shutdown params")?,
                self.timeouts.shutdown_wait,
            )
            .await;
        if let Err(error) = request {
            warn!(
                target: "extension_host",
                "extension sidecar did not confirm shutdown '{reason}': {error:#}"
            );
        }
        let mut child = self.child.take().expect("child is taken only by shutdown");
        match tokio::time::timeout(self.timeouts.shutdown_wait, child.wait()).await {
            Ok(Ok(status)) => {
                if !status.success() {
                    debug!(
                        target: "extension_host",
                        "extension sidecar exited with {status} on shutdown"
                    );
                }
                Ok(())
            }
            Ok(Err(error)) => Err(error).context("waiting for extension sidecar exit"),
            Err(_) => {
                if let Some(pid) = child.id() {
                    crate::platform::kill_process_group_or_pid(pid as i32);
                }
                let status = child
                    .wait()
                    .await
                    .context("reaping extension sidecar after kill")?;
                warn!(
                    target: "extension_host",
                    "extension sidecar ignored shutdown '{reason}'; killed: {status}"
                );
                Ok(())
            }
        }
    }
}

impl Drop for ExtensionHost {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            if let Some(pid) = child.id() {
                // kill_on_drop reaps the direct child; the group kill also
                // reaches any descendants the sidecar spawned.
                crate::platform::kill_process_group_or_pid(pid as i32);
            }
        }
    }
}

/// Log the sidecar's stderr at debug until EOF: node crashes land here when
/// they never reach the handshake.
fn drain_stderr(stderr: tokio::process::ChildStderr) {
    use tokio::io::AsyncBufReadExt;
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            debug!(target: "extension_host", "sidecar stderr: {line}");
        }
    });
}
