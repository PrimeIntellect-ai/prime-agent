//! Agent engine configuration: the create-command contract and the
//! private handle/sink types (moved with their concerns).

/// Configuration for the real engine.
#[derive(Clone)]
pub struct AgentEngineConfig {
    pub cwd: std::path::PathBuf,
    pub agent_dir: std::path::PathBuf,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    /// Requested thinking level from the process-level fallback. The
    /// session's create command (`--thinking`) overrides it via
    /// [`SessionEngine::configure_model`].
    pub thinking: Option<pa_types::ai::ModelThinkingLevel>,
    /// Session persistence directory (JSONL sessions live under it).
    pub session_dir: Option<std::path::PathBuf>,
    /// Conversation-log path for the system prompt: the daemon worker owns
    /// the session file, so the in-session manager stays in-memory and the
    /// prompt reads the path from here.
    pub session_file: Option<std::path::PathBuf>,
    /// Verification seam: a scripted faux provider (`{"responses": [...]}`).
    /// Never set by the product.
    pub faux_script: Option<String>,
    /// Supervisor socket + own active session id for the worker's supervisor
    /// link. Present only inside a daemon worker; it enables the kernel's
    /// `agent_message/agent_observe` host requests.
    pub supervisor_link: Option<SupervisorLinkConfig>,
    /// Telemetry opt-out from the create command (Some(true) installs no
    /// telemetry; None/Some(false) resolve the configured sinks).
    pub telemetry_disabled: Option<bool>,
    /// The worker's kernel cron wiring (TS daemon-mode wires its
    /// `AgentCronJobStore.forSessionArtifacts()` into the session runtime):
    /// the shared scheduled-jobs store kernel `rlm_heartbeat.*` host
    /// requests read and write, so agent-created heartbeats reach the same
    /// catalog the `heartbeats_list` command reads and the scheduler fires.
    /// The binding is enriched per build from the worker's live/durable
    /// session identity.
    pub cron_store: Option<pa_core::session_engine::runtime_wiring::KernelCronWiring>,
    /// TS `_steeringStopPending` (the session's stop hooks): `true` while
    /// the worker's steering lane holds a queued item, so the running turn
    /// stops at the next turn boundary and the steer delivers as the next
    /// input (the follow-up lane never stops the run).
    pub queued_steering_probe: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
}

/// Supervisor-link coordinates for a daemon worker.
#[derive(Clone, Debug)]
pub struct SupervisorLinkConfig {
    pub socket_path: std::path::PathBuf,
    /// The worker's own active session id, stamped on outgoing messages so
    /// the supervisor can attribute them to this session.
    pub active_session_id: String,
    /// The worker's authentication token, presented on supervisor requests
    /// that act on this worker's behalf (worker-to-worker peer tickets).
    pub worker_token: String,
}

/// The worker's autonomous admission sink: a held threshold continuation's
/// text, queued into the worker's follow-up lane.
pub(crate) type AutonomousAdmission = std::sync::Arc<dyn Fn(String) + Send + Sync>;

/// The goal driver and session-manager handles mirrored from the core
/// session (see `AgentSessionEngine::goal_runtime`).
#[derive(Clone)]
pub(crate) struct GoalRuntimeHandles {
    pub(crate) driver:
        std::sync::Arc<tokio::sync::Mutex<pa_core::session_engine::goal_driver::GoalDriver>>,
    pub(crate) session:
        std::sync::Arc<tokio::sync::Mutex<pa_core::session::manager::SessionManager>>,
}

/// The session-model restore decision for one session file (TS
/// `createAgentSession`'s restored-from-session step): the model the
/// session's file pins, computed once at the create/replace seam through
/// the bounded catalog-readiness wait, or the on-the-record fallback when
/// the window missed (TS `modelFallbackMessage`). Scoped to
/// `session_file`: the resolution consults it only while the engine owns
/// that file, so a replacement flow recomputes its own instead of
/// silently keeping the previous session's pin.
#[derive(Clone)]
pub(super) struct RestoredSessionModel {
    pub(super) session_file: std::path::PathBuf,
    /// `None` when the restore missed after the readiness window.
    pub(super) model: Option<(String, String)>,
    pub(super) fallback_message: Option<String>,
}

/// The daemon-side adapter onto the engine's attribution producer: the
/// children registry's observation sites deliver per-origin batches
/// through this sink (pa-core owns the target row and the durable
/// append).
pub(super) struct ProducerUsageSink(
    pub(super) std::sync::Arc<pa_core::session_engine::rlm_usage::RlmChildUsageAttributions>,
);

impl pa_core::session_engine::rlm_usage::RlmChildUsageSink for ProducerUsageSink {
    fn record(
        &self,
        report: pa_core::session_engine::rlm_usage::RlmChildUsageReport,
    ) -> std::pin::Pin<std::boxed::Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let producer = std::sync::Arc::clone(&self.0);
        Box::pin(async move {
            producer.record_child_usage(report).await;
        })
    }

    fn forget(
        &self,
        rlm_child_id: &str,
    ) -> std::pin::Pin<std::boxed::Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let producer = std::sync::Arc::clone(&self.0);
        let rlm_child_id = rlm_child_id.to_string();
        Box::pin(async move {
            producer.forget_child(&rlm_child_id).await;
        })
    }
}
