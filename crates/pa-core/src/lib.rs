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

mod hooks;
pub(crate) mod tools;

// Tool-definition contract.
pub use tools::tool_definition::{
    AbortSignal, ExecuteFn, ExecuteFuture, ExecutionMode, OnUpdate, PrepareArgumentsFn,
    ToolContentBlock, ToolDefinition, ToolExecutionResult, ToolUpdate,
};

// Path-resolution helper for the CLI's `@file` expansion (cwd-relative
// resolve with the macOS filename variants).
pub use tools::path_utils::resolve_read_path;

// Result-rendering helpers: the image metadata pair the daemon's snapshot
// elision consumes alongside the tool renderers (narrow re-export).
pub use tools::render_utils::{get_image_dimensions_prefix, IMAGE_DIMENSIONS_PREFIX_BYTES};

// ipython tool: definition + kernel lifecycle seam (RLM bootstrap included).
pub use tools::ipython::{
    create_ipython_tool_definition, sent_agent_message_json, ExecuteResult, ExecuteStatus,
    IpythonKernelProvisioner, IpythonToolOptions, IpythonToolUi, KernelAttachment,
    KernelBusyAfterInterruptError, KernelErrorInfo, KernelExecError, KernelExecutor,
    LateSentAgentMessageHandler,
};
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
pub mod update;
pub mod workspace_snapshot;
pub use kernel::ReplKernelManager;
