//! RLM kernel layer: persistent Python REPL lifecycle.
//!
//! The kernel is a JSON-lines subprocess (`python -m rlm.repl`): requests on
//! stdin, events on stdout, stderr kept as a diagnostics tail. The protocol is
//! documented in `prime-agent-runtime/src/rlm/repl.md` (protocol version 3).
//!
//! Ported from the TypeScript product's `core/kernel/` (repl-manager.ts,
//! bootstrap.ts, shared.ts, state-snapshot.ts, boot-gate.ts) and
//! `core/rlm-runtime.ts`.

pub mod bootstrap;
pub mod cancellation;
pub mod live_kernels;
pub mod manager;
pub mod orphan_journal;
pub mod protocol;
pub mod provisioner;
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
    find_unique_rlm_short_form_model_match, format_rlm_model_unavailable_error,
    normalize_requested_rlm_subagent_model, normalize_requested_rlm_subagent_session_name,
    normalize_requested_rlm_subagent_thinking_level, RlmModelInfo, RlmModelMatch, THINKING_LEVELS,
};
pub use shared::{
    HostRequestHandler, HostRequestHandlers, HostRequestPayload, KernelBusyAfterInterruptError,
    KernelDiffDisplay, KernelManagerOptions, KernelSentAgentMessage, KernelShutdownOptions,
    KernelSnapshotConfig, StreamName, EXECUTE_STATUS_ABORTED, EXECUTE_STATUS_ERROR,
    EXECUTE_STATUS_OK,
};
pub use state_snapshot::{manifest_path_in, snapshot_path_in, RestoreResult, SnapshotResult};
