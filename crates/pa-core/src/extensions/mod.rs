//! Extension host: the Node sidecar that runs user-authored TS/JS extensions
//! (design doc `docs/extensions-runner-design.md`).
//!
//! One sidecar process per session, NDJSON JSON over stdio (protocol
//! [`pa_types::extension_rpc`]), with the host script and vendored jiti
//! materialized under `<agentDir>/extension-host/`. This module owns the
//! process lifecycle, the RPC protocol, and the host script runtime that
//! loads extension modules.
//!
//! Stage status (design doc §4, as landed): stage 1 = sidecar process
//! management + RPC framing/protocol (hello handshake, ping, orderly
//! shutdown). Stage 2 = the host script runtime (vendored jiti module
//! loading, registration landing, tool execution over RPC) plus the
//! registry mirror and the [`ExtensionRunner`] facade. Emission at the
//! session-engine seams, ctx-action binding, slash-command dispatch at the
//! product surface, and stale-ctx/timer semantics are later stages.
//!
//! TS ground truth: `packages/coding-agent/src/core/extensions/`
//! (loader.ts for the loading surface; runner.ts emit semantics arrive with
//! the event-surface stage).

mod client;
mod framing;
mod host;
mod registry;
mod runner;
mod script;
mod tool;

pub use client::{CtxCall, CtxCallHandler, RpcClient, SidecarNotification};
pub use framing::{encode_line, LineDecoder, LineLimits, DEFAULT_MAX_LINE_BYTES};
pub use host::{ExtensionHost, ExtensionHostSpec, HostScript, HostTimeouts};
pub use registry::{
    BuiltinKeybindings, ExtensionRegistry, RegistrationDiagnostic, ResolvedExtensionCommand,
    ResolvedShortcut, RESERVED_KEYBINDING_IDS,
};
pub use runner::ExtensionRunner;
pub use tool::ExtensionTool;
