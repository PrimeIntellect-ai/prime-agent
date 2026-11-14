//! RLM kernel layer: persistent Python REPL lifecycle.
//!
//! The kernel is a JSON-lines subprocess (`python -m rlm.repl`): requests on stdin,
//! events on stdout, stderr kept as a diagnostics tail. The protocol is documented in
//! `prime-agent-runtime/src/rlm/repl.md` (protocol version 3).

pub mod bootstrap;
pub mod cancellation;
pub mod live_kernels;
pub mod manager;
pub mod orphan_journal;
pub mod protocol;
pub mod provisioner;
pub(crate) mod python_env;
pub mod rlm_runtime;
pub mod shared;
pub mod state_snapshot;

pub use bootstrap::{
    build_rlm_bootstrap_code, ensure_kernel_python, kernel_venv_dir, EnsureKernelPythonOptions,
    KernelBootstrapProgressHandler, KernelPythonSkill, PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER,
};
pub use cancellation::AbortSignal;
pub use manager::ReplKernelManager;
pub use provisioner::IpythonKernelProvisioner;
pub use rlm_runtime::{
    create_default_rlm_subagent_session_name, find_rlm_model_matches,
    find_unique_rlm_short_form_model_match, format_rlm_model_rejected_error,
    format_rlm_model_unavailable_error, normalize_requested_rlm_subagent_model,
    normalize_requested_rlm_subagent_session_name, normalize_requested_rlm_subagent_thinking_level,
    RlmModelInfo, RlmModelMatch, THINKING_LEVELS,
};
pub use shared::{
    HostRequestHandler, HostRequestHandlers, HostRequestPayload, KernelDiffDisplay,
    KernelManagerOptions, KernelSentAgentMessage, KernelShutdownOptions, KernelSnapshotConfig,
    StreamName, EXECUTE_STATUS_ABORTED, EXECUTE_STATUS_ERROR, EXECUTE_STATUS_OK,
};
pub use state_snapshot::{manifest_path_in, snapshot_path_in, RestoreResult, SnapshotResult};

/// Environment for a Python process: ambient Python import roots and the
/// default user site are disabled before interpreter initialization.
#[must_use]
pub fn python_process_environment(
) -> std::collections::HashMap<std::ffi::OsString, std::ffi::OsString> {
    python_env::inherited_python_env()
}
