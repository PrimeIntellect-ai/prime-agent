//! Agent engine configuration: the create-command contract and the
//! private handle/sink types.

/// Configuration for the real engine.
#[derive(Clone)]
pub struct AgentEngineConfig {
    pub cwd: std::path::PathBuf,
    pub agent_dir: std::path::PathBuf,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    /// Requested thinking level from the process-level fallback; the
    /// create command (`--thinking`) overrides it via
    /// [`SessionEngine::configure_model`].
    pub thinking: Option<pa_types::ai::ModelThinkingLevel>,
    /// Session persistence directory (JSONL sessions live under it).
    pub session_dir: Option<std::path::PathBuf>,
    /// Conversation-log path for the system prompt: the daemon worker
    /// owns the session file, so the in-session manager stays
    /// in-memory.
    pub session_file: Option<std::path::PathBuf>,
    /// Verification seam: a scripted faux provider (`{"responses": [...]}`).
    /// Never set by the product.
    pub faux_script: Option<String>,
    /// Supervisor socket + own active session id for the worker's
    /// supervisor link. Present only inside a daemon worker (it enables
    /// the kernel's `agent_message/agent_observe` requests).
    pub supervisor_link: Option<SupervisorLinkConfig>,
    /// Telemetry opt-out from the create command (Some(true) installs no
    /// telemetry).
    pub telemetry_disabled: Option<bool>,
    /// The worker's kernel cron wiring: the shared scheduled-jobs store
    /// the kernel `rlm_heartbeat.*` host requests read and write, so
    /// agent-created heartbeats reach the catalog the `heartbeats_list`
    /// command reads. Enriched per build from the session identity.
    pub cron_store: Option<pa_core::session_engine::runtime_wiring::KernelCronWiring>,
    /// TS `_steeringStopPending` (the session's stop hooks): `true` while
    /// the steering lane holds a queued item, so the running turn stops at
    /// the next boundary and the steer delivers next (the follow-up lane
    /// never stops the run).
    pub queued_steering_probe: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
}

/// Supervisor-link coordinates for a daemon worker.
#[derive(Clone, Debug)]
pub struct SupervisorLinkConfig {
    pub socket_path: std::path::PathBuf,
    /// The worker's own active session id, stamped on outgoing messages
    /// for supervisor attribution.
    pub active_session_id: String,
    /// The worker's authentication token for supervisor requests that act
    /// on this worker's behalf.
    pub worker_token: String,
}

/// The worker's autonomous admission sink: a held threshold
/// continuation's text, queued into the follow-up lane.
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

/// The session-model restore decision for one session file: the pinned
/// model computed once at the create/replace seam, or the on-record
/// fallback. Scoped to `session_file`: a replacement recomputes its own.
#[derive(Clone)]
pub(super) struct RestoredSessionModel {
    pub(super) session_file: std::path::PathBuf,
    /// `None` when the restore missed after the readiness window.
    pub(super) model: Option<(String, String)>,
    pub(super) fallback_message: Option<String>,
}

/// A create command's session flags, under the TS `AgentSessionRuntimeConfig` names.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct CreateSessionResources {
    pub(crate) system_prompt: Option<String>,
    pub(crate) append_system_prompt: Vec<String>,
    pub(crate) skills: Vec<String>,
    pub(crate) prompt_templates: Vec<String>,
    pub(crate) autonomous: Option<pa_core::autonomous::AgentAutonomousConfig>,
    /// The creating client's mode (`interactive`, `acp`, ...) for the
    /// session's telemetry; absent reports `unknown` (TS parity).
    pub(crate) execution_mode: Option<String>,
}

/// The create command's `--models` scope inputs: the startup chain picks
/// the first scoped model (or the saved default when in scope) for a
/// fresh session; a continuing session keeps its own model.
#[derive(Clone)]
pub(super) struct StartupScope {
    pub(super) scoped_models: Vec<pa_core::models::ScopedModel>,
    pub(super) is_continuing: bool,
}

/// The daemon-side adapter onto the engine's attribution producer: the
/// children registry's observation sites deliver per-origin batches
/// through this sink.
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

#[cfg(test)]
mod tests {
    use super::CreateSessionResources;
    use serde::Deserialize as _;

    /// The create payload's `executionMode` reaches the session telemetry;
    /// a create without one (an agent-spawned session) stays `None`
    /// (reported as `unknown`, TS parity).
    #[test]
    fn create_resources_read_the_execution_mode() {
        let payload = serde_json::json!({ "cwd": "/tmp", "executionMode": "interactive" });
        let resources = CreateSessionResources::deserialize(&payload).unwrap();
        assert_eq!(resources.execution_mode.as_deref(), Some("interactive"));
        let resources =
            CreateSessionResources::deserialize(&serde_json::json!({ "cwd": "/tmp" })).unwrap();
        assert_eq!(resources.execution_mode, None);
    }
}
