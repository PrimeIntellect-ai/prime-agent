// large_futures: stack futures on hot paths by design. too_many_lines:
// style gate only. Casts: 64-bit targets; narrowing sits at bounded
// OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Test-only: exact-float `assert_eq!`s assert parsed fixture values; an
// epsilon compare would weaken the assertions, not fix a lint.
#![cfg_attr(test, allow(clippy::float_cmp))]

//! Session engine: tools, skills, prompts, compaction, refinement, kernel/RLM
//! manager, subagents, session manager, settings.
//!
//! Public API: the tool-definition contract; subsystem internals are `pub(crate)`.
//! `SessionEngine` (message in -> events out) is the future facade.

pub(crate) mod tools;

// Tool-definition contract.
pub use tools::tool_definition::{
    AbortSignal, ExecuteFn, ExecuteFuture, ExecutionMode, OnUpdate, PrepareArgumentsFn,
    ToolContentBlock, ToolDefinition, ToolExecutionResult, ToolUpdate, WrappedTool,
};

// Path-resolution helper the CLI's `@file` expansion shares with the
// tools (cwd-relative resolve with the macOS filename variants).
pub use tools::path_utils::resolve_read_path;

// Result-rendering helpers: the image metadata pair the daemon's snapshot
// elision consumes alongside the tool renderers (narrow re-export).
pub use tools::render_utils::{get_image_dimensions_prefix, IMAGE_DIMENSIONS_PREFIX_BYTES};

// bash tool: definition + local/remote execution seam.
pub use tools::bash::{
    create_bash_tool_definition, create_bash_tool_definition_with_options, BashOperations,
    BashSpawnContext, BashSpawnHook, BashToolOptions, LocalBashOperations,
};

// edit tool: definition + filesystem operations seam.
pub use tools::edit::{
    create_edit_tool_definition, prepare_edit_arguments, EditOperations, LocalEditOperations,
};

// ipython tool: definition + kernel lifecycle seam (RLM bootstrap included).
pub use tools::ipython::{
    create_ipython_tool_definition, sent_agent_message_json, ExecuteResult, ExecuteStatus,
    IpythonKernelProvisioner, IpythonToolOptions, IpythonToolUi, KernelAttachment,
    KernelBusyAfterInterruptError, KernelErrorInfo, KernelExecError, KernelExecutor,
    LateSentAgentMessageHandler,
};
pub use tools::rlm_bootstrap::{build_rlm_bootstrap_code, PythonSkillRuntimeInfo};
// RLM kernel subsystem: persistent IPython kernel lifecycle.
pub mod agent_traces;
pub mod auth;
pub mod autonomous;
pub mod cron;
pub mod export_html;
pub mod goals;
pub mod kernel;
pub mod mcp;
pub mod models;
pub mod packages;
pub mod platform;
pub mod prompts;
pub mod refinement;
pub mod resources;
pub mod session;
pub mod session_engine;
pub mod settings;
pub mod skills;
pub mod slash_command_args;
// The router is consumed only by the session engine's host handler and the
// unit batteries; per the crate facade policy its surface stays crate-private.
pub(crate) mod system_router;
pub mod update;
pub mod workspace_snapshot;
pub use kernel::ReplKernelManager;
