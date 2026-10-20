//! Wires the session runtime (goal + rlm-heartbeat host bridge) and the Python kernel
//! into the session engine build (the product-path equivalent of the TS `AgentSession`
//! host-request controllers): the kernel provisioner receives the host-handler registry,
//! and the agent loop gains the `ipython` tool backed by that kernel.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::runtime::QueuedGoalContextPurge;
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

/// RLM inputs the session composition supplies: a shared model registry and the daemon
/// child-session host; defaults derive from `agent_dir` or the no-children behavior.
#[derive(Default)]
pub struct RlmWiring {
    /// Registry `rlm.find_models` searches. Defaults to the `agent_dir` catalog.
    pub model_registry: Option<Arc<crate::models::registry::ModelRegistry>>,
    /// Child-session machinery backing `rlm.spawn`/`rlm.create_session` and
    /// the roster/collect/delete surface.
    pub subagent_host: Option<Arc<dyn RlmSubagentHost>>,
    pub usage_store: Option<Arc<dyn super::rlm_usage::RlmChildUsageStore>>,
    /// Announces every accepted `rlm.progress.note`; `None` keeps the store
    /// the only surface.
    pub progress_note_emit: Option<super::rlm_host::RlmProgressNoteEmit>,
}

/// The embedding's cron wiring for the kernel's `rlm_heartbeat.*` host
/// requests: the shared store plus the durable session identity the
/// kernel-created jobs bind to.
#[derive(Clone)]
pub struct KernelCronWiring {
    /// The daemon worker's scheduled-jobs store.
    pub store: std::sync::Arc<crate::cron::store::AgentCronJobStore>,
    /// `None` until the embedding knows it (the engine falls back to the
    /// in-memory manager's identity).
    pub binding: Option<KernelCronBinding>,
    /// The post-mutation seam for kernel `rlm_heartbeat.*` requests;
    /// `None` leaves mutations unannounced (the embedded default).
    pub mutation_hook: Option<super::host_requests::RlmHeartbeatMutationHook>,
}

/// The live/durable session identity for kernel-created rlm heartbeats.
#[derive(Clone, Debug)]
pub struct KernelCronBinding {
    /// The live active session id the daemon routes commands by.
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
            // `..` documents the deliberately-opaque store + hook.
            .finish_non_exhaustive()
    }
}

/// Session-scoped runtime wiring: the shared session manager handle,
/// the kernel host-handler registry, and the runtime itself.
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

/// Build the session runtime and register the `goal.*`, `rlm.*`, and —
/// only when `cron_store` wiring exists — the `rlm_heartbeat.*` host
/// handlers; `goal_complete_purge` is the embedding's queued-goal-context purge.
#[must_use]
pub fn wire_session_runtime(
    session: SessionManager,
    agent_dir: &std::path::Path,
    rlm: RlmWiring,
    goal_complete_purge: Option<QueuedGoalContextPurge>,
    cron_store: Option<KernelCronWiring>,
) -> SessionKernelWiring {
    // The embedding's durable session identity overrides the in-memory manager's
    // when supplied: kernel-created rlm heartbeats must bind the live session id the
    // supervisor routes by, plus the durable id + file (the partition the store writes
    // and the rebind pass moves onto live sessions).
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
    // An embedding-owned store, so kernel `rlm_heartbeat.*` writes reach
    // the daemon catalog. Kernel heartbeat requests need the embedding's
    // scheduler to fire the jobs they create: without cron wiring they
    // stay unregistered (TS registers only with the heartbeat controller).
    let mutation_hook = cron_store
        .as_ref()
        .and_then(|wiring| wiring.mutation_hook.clone());
    let cron_store = cron_store.map(|wiring| wiring.store);
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
        // `rlm.find_models` and child-spawn resolution search this registry, and a
        // fresh registry otherwise gates every private `internal/*` model out (only
        // the async refresh populates the authorized set).
        registry.load_private_authorization_from_cache();
        Arc::new(registry)
    });
    let rlm_usage = Arc::new(super::rlm_usage::RlmChildUsageAttributions::new(
        rlm.usage_store
            .unwrap_or_else(|| Arc::new(super::rlm_usage::SessionUsageStore(session.clone()))),
    ));
    // The daemon supplies the child-session host; an embedding without
    // one keeps the no-children behavior, whose self-rename appends the
    // session's own `session_info` name row.
    let subagent_host = rlm
        .subagent_host
        .unwrap_or_else(|| Arc::new(super::rlm_host::NoRlmChildren::new(session.clone())));
    let rlm_bridge = Arc::new(RlmHostBridge::new(
        model_registry,
        subagent_host,
        rlm_usage.clone(),
        rlm.progress_note_emit,
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

/// Bundled skills whose kernel host requests are controller-backed: the
/// skill is model-visible only when its host request is registered (the
/// registry decides, like TS `_modelVisibleSkills` reads its controllers).
const CONTROLLER_BACKED_SKILLS: [(&str, &str); 3] = [
    // skills/agent-message sends `agent_message.send`.
    ("agent-message", "agent_message.send"),
    // skills/agent-observe sends `agent_observe.list`.
    ("agent-observe", "agent_observe.list"),
    // skills/rlm-heartbeat sends `rlm_heartbeat.create`.
    ("rlm-heartbeat", "rlm_heartbeat.create"),
];

/// The model-visible skill list for a final host-handler registry: a
/// controller-backed bundled skill whose host request is not registered
/// (print/RPC builds without that wiring) drops out.
#[must_use]
pub fn model_visible_skills(skills: Vec<Skill>, handlers: &HostRequestHandlers) -> Vec<Skill> {
    skills
        .into_iter()
        .filter(|skill| {
            !CONTROLLER_BACKED_SKILLS
                .iter()
                .any(|(name, request)| skill.name == *name && handlers.get(request).is_none())
        })
        .collect()
}

/// Kernel-side Python skill modules, pre-imported at bootstrap.
#[must_use]
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

/// Build the kernel provisioner for a session: host handlers for the goal/heartbeat bridge
/// plus the pre-imported skills. The session's agent dir is propagated into the kernel env
/// (`PRIME_AGENT_CODING_AGENT_DIR`): an embedding host whose ambient env differs must not
/// leak its own paths into the kernel (#109). A persistent session's artifact dir is
/// likewise propagated (`RLM_SESSION_DIR` + `RLM_HARNESS_STATE_DIR`), so kernel-side
/// harness writes land in the session-local store. The artifact dir is keyed by the
/// durable session id (the session file's stem), exported as `RLM_SESSION_ID` for the
/// persistent `bash()` shells' assignment. `cwd` is the SESSION's working directory.
/// `shell_path` is the session-start-resolved kernel shell: an invalid `shellPath` fails
/// `create_session`, not the kernel boot.
#[allow(clippy::too_many_arguments)] // one wiring funnel, same style as AgentSession::from_session_arc
#[must_use]
pub fn kernel_provisioner(
    session_id: String,
    handlers: HostRequestHandlers,
    python_skills: Vec<KernelPythonSkill>,
    cwd: std::path::PathBuf,
    agent_dir: &std::path::Path,
    shell_path: Option<std::path::PathBuf>,
    command_prefix: Option<String>,
    serper_api_key: Option<String>,
    session_artifact_dir: Option<std::path::PathBuf>,
    on_restore: Option<crate::kernel::provisioner::RestoreCallback>,
    on_background_work_settled: Option<crate::kernel::shared::BackgroundWorkSettledCallback>,
    on_unavailable_skills: Option<crate::kernel::provisioner::UnavailableSkillsCallback>,
    on_bootstrap_result: Option<crate::kernel::provisioner::KernelBootstrapResultHandler>,
) -> Arc<KernelProvisioner> {
    let mut env = HashMap::with_capacity(3);
    env.insert(
        "PRIME_AGENT_CODING_AGENT_DIR".to_string(),
        agent_dir.to_string_lossy().to_string(),
    );
    // Always set: an unsaved session blanks an inherited id (a run started inside another
    // session's kernel), so its persistent shells never join that session.
    let rlm_session_id = session_artifact_dir
        .as_deref()
        .and_then(std::path::Path::file_name)
        .map(|id| id.to_string_lossy().to_string())
        .unwrap_or_default();
    env.insert("RLM_SESSION_ID".to_string(), rlm_session_id);
    for (key, value) in [
        ("RLM_SESSION_DIR", session_artifact_dir.clone()),
        (
            "RLM_HARNESS_STATE_DIR",
            crate::refinement::get_local_harness_state_dir(session_artifact_dir.as_deref()),
        ),
    ] {
        if let Some(value) = value {
            env.insert(key.to_string(), value.to_string_lossy().to_string());
        }
    }
    if let Some(serper_api_key) = serper_api_key {
        env.insert("SERPER_API_KEY".to_string(), serper_api_key);
    }
    Arc::new(KernelProvisioner::new(
        cwd,
        IpythonKernelProvisionerOptions {
            python: None,
            env,
            command_prefix,
            shell_path,
            session_id: Some(session_id),
            host_handlers: handlers,
            python_skills,
            // Only persistent sessions (which have an artifact dir) get
            // a revivable snapshot (TS `snapshotDir`).
            snapshot_dir: session_artifact_dir,
            ready_gate: None,
            on_restore,
            on_background_work_settled,
            on_unavailable_skills,
            on_bootstrap_result,
        },
    ))
}

/// TS `_addWebsearchKeyEnv` (agent-session.ts:11137-11158): the serper key
/// rides the kernel env only when a websearch skill is loaded, the ambient
/// env does not already carry one, and the stored `serper` credential is an
/// api key that resolves non-empty. The websearch skill's own `!command`
/// key refs cannot resolve in-kernel, so the host resolves them here; the
/// caller reads the credential and runs this off the async runtime, because
/// a `!command` key can block.
#[must_use]
pub(crate) fn websearch_api_key(
    skills: &[Skill],
    credential: Option<crate::auth::AuthCredential>,
) -> Option<String> {
    if std::env::var("SERPER_API_KEY").is_ok_and(|value| !value.trim().is_empty()) {
        return None;
    }
    if !skills.iter().any(|skill| skill.name == "websearch") {
        return None;
    }
    match credential {
        Some(crate::auth::AuthCredential::ApiKey { key, .. }) => {
            crate::auth::resolve_config_value::resolve_config_value(&key)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        }
        _ => None,
    }
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
            this.kill();
        })
    }
}

/// Adapts the kernel manager to the ipython tool's executor contract.
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
        let on_late_sent_agent_message = options.on_late_sent_agent_message;
        Box::pin(async move {
            let result = manager
                .execute(
                    &code,
                    crate::kernel::shared::ExecuteOptions {
                        signal: signal.map(crate::kernel::cancellation::AbortSignal::from_token),
                        on_late_sent_agent_message,
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
        bash_commands: result.bash_commands,
    }
}

/// Build the ipython tool options for a wired kernel provisioner.
#[must_use]
pub fn ipython_tool_options(
    provisioner: Arc<KernelProvisioner>,
    on_late_sent_agent_message: Option<crate::tools::ipython::LateSentAgentMessageHandler>,
) -> IpythonToolOptions {
    IpythonToolOptions {
        provisioner,
        ui: None,
        on_late_sent_agent_message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::store::AgentCronJobStore;
    use crate::kernel::shared::{host_handler, HostRequestHandlers};
    use serde_json::Value;

    fn cron_wiring(dir: &std::path::Path) -> KernelCronWiring {
        KernelCronWiring {
            store: Arc::new(AgentCronJobStore::new(dir.join("jobs.json"))),
            binding: None,
            mutation_hook: None,
        }
    }

    /// An engine build without cron wiring (print/RPC) serves no
    /// `rlm_heartbeat.*` requests: no scheduler fires the jobs they create.
    #[test]
    fn without_cron_wiring_the_rlm_heartbeat_handlers_stay_unregistered() {
        let dir = tempfile::tempdir().unwrap();
        let session = SessionManager::in_memory(dir.path());
        let wiring = wire_session_runtime(session, dir.path(), RlmWiring::default(), None, None);
        assert!(wiring.handlers.get("rlm_heartbeat.create").is_none());
        assert!(wiring.handlers.get("rlm_heartbeat.list").is_none());
        // The goal surface needs no scheduler and stays registered.
        assert!(wiring.handlers.get("goal.get").is_some());
    }

    #[test]
    fn with_cron_wiring_the_rlm_heartbeat_handlers_register() {
        let dir = tempfile::tempdir().unwrap();
        let session = SessionManager::in_memory(dir.path());
        let wiring = wire_session_runtime(
            session,
            dir.path(),
            RlmWiring::default(),
            None,
            Some(cron_wiring(dir.path())),
        );
        assert!(wiring.handlers.get("rlm_heartbeat.create").is_some());
    }

    fn skill_named(name: &str) -> crate::skills::Skill {
        use crate::skills::{create_synthetic_source_info, SkillKind, SourceScope};
        crate::skills::Skill {
            name: name.to_string(),
            description: "a skill".to_string(),
            file_path: std::path::PathBuf::from("/skills/SKILL.md"),
            base_dir: std::path::PathBuf::from("/skills"),
            source_info: create_synthetic_source_info("/skills", "user", SourceScope::User, None),
            disable_model_invocation: false,
            kind: SkillKind::Markdown,
            python: None,
        }
    }

    /// A controller-backed bundled skill whose host request is not
    /// registered drops out; the registered ones and plain skills stay.
    #[test]
    fn model_visible_skills_follow_the_handler_registry() {
        let skills = vec![
            skill_named("agent-message"),
            skill_named("agent-observe"),
            skill_named("rlm-heartbeat"),
            skill_named("websearch"),
        ];
        let mut handlers = HostRequestHandlers::default();
        handlers.register(
            "agent_message.send",
            host_handler(|_payload| Box::pin(async { Ok(Value::Null) })),
        );
        let visible = model_visible_skills(skills, &handlers);
        let names: Vec<&str> = visible.iter().map(|skill| skill.name.as_str()).collect();
        assert_eq!(names, ["agent-message", "websearch"]);

        handlers.register(
            "agent_observe.list",
            host_handler(|_payload| Box::pin(async { Ok(Value::Null) })),
        );
        handlers.register(
            "rlm_heartbeat.create",
            host_handler(|_payload| Box::pin(async { Ok(Value::Null) })),
        );
        let visible = model_visible_skills(
            vec![
                skill_named("agent-message"),
                skill_named("agent-observe"),
                skill_named("rlm-heartbeat"),
            ],
            &handlers,
        );
        assert_eq!(visible.len(), 3);
    }
}
