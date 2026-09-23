//! Session engine: tools, skills, prompts, compaction, refinement, kernel/RLM
//! manager, subagents, session manager, settings.
//!
//! Public API (crate facade): the tool-definition contract for the
//! model-facing surface. All subsystem internals are `pub(crate)`;
//! `SessionEngine` (message in -> events out) is the future facade per the
//! crate README. This lane ports the tools subsystem; its only public
//! surface is what other layers legitimately consume: the tool definitions
//! (name, schema, executor) and the pluggable operation seams.

pub(crate) mod tools;

// Tool-definition contract.
pub use tools::tool_definition::{
    AbortSignal, ExecuteFn, ExecuteFuture, ExecutionMode, OnUpdate, PrepareArgumentsFn,
    ToolContentBlock, ToolDefinition, ToolExecutionResult, ToolUpdate, WrappedTool,
};

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
    create_ipython_tool_definition, ExecuteResult, ExecuteStatus, IpythonKernelProvisioner,
    IpythonToolOptions, IpythonToolUi, KernelAttachment, KernelBusyAfterInterruptError,
    KernelErrorInfo, KernelExecError, KernelExecutor,
};
pub use tools::rlm_bootstrap::{build_rlm_bootstrap_code, PythonSkillRuntimeInfo};
// RLM kernel subsystem: persistent IPython kernel lifecycle.
pub mod agent_traces;
pub mod auth;
pub mod autonomous;
pub mod cron;
pub mod export_html;
pub mod extensions;
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
pub use kernel::ReplKernelManager;
