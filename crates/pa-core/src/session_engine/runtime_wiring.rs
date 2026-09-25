//! Wires the session runtime (goal + rlm-heartbeat host bridge) and the
//! Python kernel into the session engine build. This is the product-path
//! equivalent of the TS `AgentSession` host-request controllers: the kernel
//! provisioner receives the host-handler registry, and the agent loop gains
//! the `ipython` tool backed by that kernel.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::runtime::QueuedGoalContextPurge;
use crate::cron::store::AgentCronJobStore;
use crate::kernel::bootstrap::KernelPythonSkill;
use crate::kernel::provisioner::{
    IpythonKernelProvisioner as KernelProvisioner, IpythonKernelProvisionerOptions,
};
use crate::kernel::shared::HostRequestHandlers;
use crate::session::manager::SessionManager;
use crate::skills::{get_python_skill_runtime_info, Skill};
use crate::tools::ipython::{
    IpythonKernelProvisioner, IpythonToolOptions, KernelAttachment, KernelErrorInfo,
    KernelExecError, KernelExecuteOptions, KernelExecutor,
};

use super::host_requests::SessionBinding;
use super::rlm_host::{register_rlm_host_handlers, RlmHostBridge, RlmSubagentHost};
use super::runtime::SessionRuntime;

/// RLM inputs the session composition supplies: a shared model registry and
/// the daemon child-session host. Both optional; defaults are derived from
/// `agent_dir` (registry) or the no-children behavior (host).
#[derive(Default)]
pub struct RlmWiring {
    /// Registry `rlm.find_models` searches. Defaults to the `agent_dir` catalog.
    pub model_registry: Option<Arc<crate::models::registry::ModelRegistry>>,
    /// Child-session machinery backing `rlm.spawn`/`rlm.create_session` and
    /// the roster/collect/delete surface.
    pub subagent_host: Option<Arc<dyn RlmSubagentHost>>,
}

/// The embedding's cron wiring for the kernel's `rlm_heartbeat.*` host
/// requests (TS daemon-mode wires its `AgentCronJobStore.forSessionArtifacts()`
/// into the session runtime): the shared store plus the durable session
/// identity the kernel-created jobs bind to.
#[derive(Clone)]
pub struct KernelCronWiring {
    /// The daemon worker's scheduled-jobs store.
    pub store: std::sync::Arc<crate::cron::store::AgentCronJobStore>,
    /// The session identity kernel-created jobs bind to; `None` until the
    /// embedding knows it (the engine falls back to the in-memory
    /// manager's identity).
    pub binding: Option<KernelCronBinding>,
    /// The post-mutation seam for kernel `rlm_heartbeat.*` requests (TS
    /// daemon-mode's `removeQueuedHeartbeatFollowUp` +
    /// `cronScheduler.wake()` inside its rlm heartbeat controllers):
    /// the daemon worker's hook; `None` leaves mutations unannounced
    /// (the embedded/standalone default).
    pub mutation_hook: Option<super::host_requests::RlmHeartbeatMutationHook>,
}

/// The live/durable session identity for kernel-created rlm heartbeats.
#[derive(Clone, Debug)]
pub struct KernelCronBinding {
    /// The live active session id the daemon routes commands by (TS
    /// `options.activeSessionId`): the supervisor's `heartbeat_manage`
    /// resolves it.
    pub active_session_id: String,
    /// The durable session id the store partitions by.
    pub session_id: String,
    /// The durable session file the rebind pass moves jobs through.
    pub session_file: String,
    /// The session working directory.
    pub cwd: String,
}

// Opaque like the store it carries: the store handle has no meaningful
// debug form, and config structs embedding the wiring derive `Debug`.
impl std::fmt::Debug for KernelCronWiring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KernelCronWiring")
            .field("binding", &self.binding)
            .finish()
    }
}

/// Session-scoped runtime wiring: the shared session manager handle, the
/// kernel host-handler registry, and the runtime itself.
pub struct SessionKernelWiring {
    pub session: Arc<tokio::sync::Mutex<SessionManager>>,
    pub handlers: HostRequestHandlers,
    pub runtime: Arc<SessionRuntime>,
    /// The RLM bridge: progress-note state the daemon roster reads.
    pub rlm: Arc<RlmHostBridge>,
    /// The child-usage attribution producer the daemon's children
    /// registry drives after the engine is built.
    pub rlm_usage: Arc<super::rlm_usage::RlmChildUsageAttributions>,
}

/// Build the session runtime and register the `goal.*`, `rlm_heartbeat.*`,
/// and `rlm.*` host handlers the kernel reaches through its registry.
/// `goal_complete_purge` is the embedding's queued-goal-context purge (TS
/// `_completeGoalFromHost` -> `_clearQueuedGoalContexts`).
pub fn wire_session_runtime(
    session: SessionManager,
    agent_dir: &std::path::Path,
    rlm: RlmWiring,
    goal_complete_purge: Option<QueuedGoalContextPurge>,
    cron_store: Option<KernelCronWiring>,
) -> SessionKernelWiring {
    // The embedding's durable session identity overrides the in-memory
    // manager's when supplied (see [`KernelCronWiring`]): the daemon worker
    // owns the session file, so the engine's manager never carries it, but
    // kernel-created rlm heartbeats must bind the live session id the
    // supervisor routes commands by, plus the durable id + file (the
    // partition the store writes and the rebind pass moves onto live
    // sessions).
    let fallback_binding = || {
        (
            session.get_session_id().to_string(),
            SessionBinding {
                session_id: session.get_session_id().to_string(),
                session_file: session
                    .get_session_file()
                    .map(|path| path.display().to_string())
                    .unwrap_or_default(),
                cwd: session.get_cwd().display().to_string(),
            },
        )
    };
    let (active_session_id, binding) = match cron_store
        .as_ref()
        .and_then(|wiring| wiring.binding.as_ref())
    {
        Some(binding) => (
            binding.active_session_id.clone(),
            SessionBinding {
                session_id: binding.session_id.clone(),
                session_file: binding.session_file.clone(),
                cwd: binding.cwd.clone(),
            },
        ),
        None => fallback_binding(),
    };
    // An embedding-owned store (the daemon worker's scheduled-jobs store)
    // replaces the engine-private one, so kernel `rlm_heartbeat.*` writes
    // reach the daemon catalog; the private file store remains the
    // embedded/standalone default.
    let mutation_hook = cron_store
        .as_ref()
        .and_then(|wiring| wiring.mutation_hook.clone());
    let cron_store = cron_store.map_or_else(
        || Arc::new(AgentCronJobStore::new(agent_dir.join("cron-jobs.json"))),
        |wiring| wiring.store,
    );
    let mut runtime = SessionRuntime::new(&session, cron_store, active_session_id, binding);
    if let Some(purge) = goal_complete_purge {
        runtime.set_goal_complete_purge(purge);
    }
    if let Some(hook) = mutation_hook {
        runtime.set_cron_mutation_hook(hook);
    }
    let runtime = Arc::new(runtime);
    let session = Arc::new(tokio::sync::Mutex::new(session));
    let mut handlers = HostRequestHandlers::default();
    runtime.register_host_handlers(session.clone(), &mut handlers);
    let model_registry = rlm.model_registry.unwrap_or_else(|| {
        let auth = crate::auth::AuthStorage::create(agent_dir);
        let mut registry =
            crate::models::registry::ModelRegistry::create(auth, agent_dir.join("models.json"));
        // Adopt the on-disk private authorization before freezing the Arc:
        // `rlm.find_models` and child-spawn resolution search this registry,
        // and a fresh registry otherwise gates every private
        // `internal/*` model out (only the async refresh populates the
        // authorized set).
        registry.load_private_authorization_from_cache();
        Arc::new(registry)
    });
    let rlm_usage = Arc::new(super::rlm_usage::RlmChildUsageAttributions::new(
        session.clone(),
    ));
    let rlm_bridge = Arc::new(RlmHostBridge::new(
        model_registry,
        rlm.subagent_host,
        rlm_usage.clone(),
    ));
    register_rlm_host_handlers(&mut handlers, &rlm_bridge);
    SessionKernelWiring {
        session,
        handlers,
        runtime,
        rlm: rlm_bridge,
        rlm_usage,
    }
}

/// Kernel-side Python skill modules, pre-imported at bootstrap.
pub fn kernel_python_skills(skills: &[Skill]) -> Vec<KernelPythonSkill> {
    get_python_skill_runtime_info(skills)
        .into_iter()
        .map(|info| KernelPythonSkill {
            name: info.name,
            import_name: info.import_name,
            package_path: info.package_path,
            pyproject_path: info.pyproject_path,
        })
        .collect()
}

/// Build the kernel provisioner for a session: host handlers for the
/// goal/heartbeat bridge plus the pre-imported Python skills.
///
/// The session's agent dir is propagated explicitly into the kernel env
/// (`PRIME_AGENT_CODING_AGENT_DIR`): ambient inheritance is correct for the
/// product paths, but an embedding host whose ambient env differs from the
/// session's agent dir must not leak its own paths into the kernel. Same
/// discipline as the daemon worker env (#109).
///
/// `cwd` is the SESSION's working directory (TS
/// `new IpythonKernelProvisioner(this._cwd, ...)`), not the host process's:
/// the kernel-resident tools (bash/edit) run there, and a runtime whose
/// session cwd differs from the process cwd (a daemon worker switched onto
/// another session file) must spawn the kernel in the session's cwd.
#[allow(clippy::too_many_arguments)] // one wiring funnel, same style as AgentSession::from_session_arc
pub fn kernel_provisioner(
    session_id: String,
    handlers: HostRequestHandlers,
    python_skills: Vec<KernelPythonSkill>,
    cwd: std::path::PathBuf,
    agent_dir: &std::path::Path,
    snapshot_dir: Option<std::path::PathBuf>,
    on_restore: Option<crate::kernel::provisioner::RestoreCallback>,
    on_bootstrap_result: Option<crate::kernel::provisioner::KernelBootstrapResultHandler>,
) -> Arc<KernelProvisioner> {
    let mut env = HashMap::with_capacity(1);
    env.insert(
        "PRIME_AGENT_CODING_AGENT_DIR".to_string(),
        agent_dir.to_string_lossy().to_string(),
    );
    Arc::new(KernelProvisioner::new(
        cwd,
        IpythonKernelProvisionerOptions {
            python: None,
            env,
            command_prefix: None,
            shell_path: None,
            session_id: Some(session_id),
            host_handlers: handlers,
            python_skills,
            // Only persistent sessions (which have an artifact dir) get a
            // revivable snapshot, TS `snapshotDir` (the session artifact
            // dir).
            snapshot_dir,
            ready_gate: None,
            on_restore,
            on_bootstrap_result,
        },
    ))
}

impl IpythonKernelProvisioner for KernelProvisioner {
    fn ensure(
        &self,
        on_progress: Option<crate::tools::ipython::BootstrapProgressHandler>,
        signal: Option<crate::tools::tool_definition::AbortSignal>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Box<dyn KernelExecutor>>> + Send>> {
        let this = self.clone();
        Box::pin(async move {
            // The tool contract uses the raw cancellation token; the kernel
            // wraps it in its own abort signal.
            let signal = signal.map(crate::kernel::cancellation::AbortSignal::from_token);
            let manager = this.ensure(on_progress, signal).await?;
            Ok(Box::new(KernelManagerExecutor { manager }) as Box<dyn KernelExecutor>)
        })
    }

    fn kill(&self) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let this = self.clone();
        Box::pin(async move {
            this.kill().await;
        })
    }
}

/// Adapts the kernel manager to the ipython tool's executor contract,
/// converting the kernel protocol result to the tool-facing shape.
struct KernelManagerExecutor {
    manager: crate::kernel::manager::ReplKernelManager,
}

impl KernelExecutor for KernelManagerExecutor {
    fn execute(
        &self,
        code: &str,
        options: KernelExecuteOptions<'_>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<crate::tools::ipython::ExecuteResult, KernelExecError>>
                + Send,
        >,
    > {
        let manager = self.manager.clone();
        let code = code.to_string();
        let signal = options.signal;
        Box::pin(async move {
            let result = manager
                .execute(
                    &code,
                    crate::kernel::shared::ExecuteOptions {
                        signal: signal.map(crate::kernel::cancellation::AbortSignal::from_token),
                        ..Default::default()
                    },
                )
                .await
                .map_err(KernelExecError::Other)?;
            Ok(convert_execute_result(result))
        })
    }
}

fn convert_status(
    status: crate::kernel::shared::ExecuteStatus,
) -> crate::tools::ipython::ExecuteStatus {
    match status {
        crate::kernel::shared::ExecuteStatus::Ok => crate::tools::ipython::ExecuteStatus::Ok,
        crate::kernel::shared::ExecuteStatus::Error => crate::tools::ipython::ExecuteStatus::Error,
        crate::kernel::shared::ExecuteStatus::Aborted => {
            crate::tools::ipython::ExecuteStatus::Aborted
        }
    }
}

fn convert_execute_result(
    result: crate::kernel::shared::ExecuteResult,
) -> crate::tools::ipython::ExecuteResult {
    crate::tools::ipython::ExecuteResult {
        status: convert_status(result.status),
        stdout: result.stdout,
        stderr: result.stderr,
        result: result.result,
        duration_ms: Some(result.duration_ms),
        background_output: result.background_output,
        error: result.error.map(|error| KernelErrorInfo {
            ename: error.ename,
            evalue: error.evalue,
            traceback: error.traceback,
        }),
        attachments: result
            .attachments
            .unwrap_or_default()
            .into_iter()
            .map(|attachment| KernelAttachment {
                mime_type: attachment.mime_type,
                data: attachment.data,
            })
            .collect(),
        sent_agent_messages: result.sent_agent_messages.unwrap_or_default(),
    }
}

/// Build the ipython tool options for a wired kernel provisioner.
pub fn ipython_tool_options(provisioner: Arc<KernelProvisioner>) -> IpythonToolOptions {
    IpythonToolOptions {
        provisioner,
        ui: None,
    }
}
