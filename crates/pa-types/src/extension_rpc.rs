//! Extension host RPC: the private, versioned wire protocol between the
//! pa-core extension host and the Node sidecar (both shipped in the same
//! release, so they always match).
//!
//! Design: `docs/extensions-runner-design.md` §2.2-2.3 - newline-delimited
//! JSON over the sidecar's stdio, correlation ids, `protocol: 1` handshake.
//! pa-core owns framing and dispatch; these types live in pa-types because the
//! daemon protocol also carries `extension_error` and extension UI dialogs to
//! attached clients (§3.1, §3.7 of the design doc).
//!
//! Field names are camelCase on the wire (the sidecar is JavaScript). The
//! protocol is private, so unlike the TS-parity wire types these structs are
//! strict (no unknown-field catch-all): both ends ship together.
//!
//! Stage status (design doc §4): stage 1 = process lifecycle + RPC framing;
//! stage 2 = host script runtime + extension loading. The event payload
//! table (§1.4) and ctx/UI actions beyond what the host runtime forwards
//! here land with the event-surface stages.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::JsonMap;

/// Protocol version of the extension host RPC. Bumped on any wire change;
/// both ends ship in the same release and reject mismatches in the
/// handshake. Protocol 2 = stage 2: the sidecar loads extension modules
/// (vendored jiti), lands registrations, and executes tools
/// (`tool_execute` + `tool_update`); protocol 1 was the stage-1 protocol
/// peer (empty hello, no tool execution).
pub const EXTENSION_RPC_PROTOCOL: u32 = 2;

/// Hard floor for the Node runtime the sidecar requires (detected by the host
/// script, surfaced as a handshake failure; jiti needs only the JS runtime).
pub const EXTENSION_HOST_NODE_MAJOR_FLOOR: u32 = 18;

// --- Method names (Rust -> sidecar requests / sidecar -> Rust ctx calls) ---

/// Handshake + extension load request. Reply: [`HelloResult`].
pub const METHOD_HELLO: &str = "hello";
/// Emit one extension event; the reply carries the accumulated handler result.
pub const METHOD_EVENT: &str = "event";
/// Orderly unload: the sidecar emits `session_shutdown`, replies, then exits.
pub const METHOD_SHUTDOWN: &str = "shutdown";
/// Liveness probe.
pub const METHOD_PING: &str = "ping";
/// Notification: cancel the in-flight event dispatch named by `token`.
pub const METHOD_CANCEL: &str = "cancel";

/// Notification (sidecar -> Rust): an extension handler or registration threw
/// inside the error boundary; never fatal (design doc §1.5, §2.4).
pub const METHOD_EXTENSION_ERROR: &str = "extension_error";
/// Request (Rust -> sidecar): execute one registered extension tool. The
/// sidecar streams `tool_update` notifications, then replies with the final
/// result (design doc §2.3 `tool_execute`).
pub const METHOD_TOOL_EXECUTE: &str = "tool_execute";
/// Notification (sidecar -> Rust): a partial result from a running
/// extension tool (the `onUpdate` callback of `ToolDefinition.execute`).
pub const METHOD_TOOL_UPDATE: &str = "tool_update";
/// Request (Rust -> sidecar): dispatch a registered extension slash command
/// by invocation name (design doc §2.3 `command_execute`).
pub const METHOD_COMMAND_EXECUTE: &str = "command_execute";
/// Request (Rust -> sidecar): dispatch a registered extension keybinding.
pub const METHOD_SHORTCUT_EXECUTE: &str = "shortcut_execute";

/// Notification (sidecar -> Rust): registrations changed after the handshake
/// (post-bind `registerTool`/`registerCommand`/... from a handler).
pub const METHOD_REGISTRATION: &str = "registration";

// --- Envelopes -------------------------------------------------------------

/// RPC error shape used by both directions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

impl RpcError {
    pub fn message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            stack: None,
        }
    }
}

/// A request the Rust host sends to the sidecar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// The Rust host's reply to a sidecar ctx call (correlated by `ctxToken`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostReply {
    pub ctx_token: String,
    pub result: Value,
}

/// The Rust host's error reply to a sidecar ctx call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostErrorReply {
    pub ctx_token: String,
    pub error: RpcError,
}

/// A notification the Rust host sends to the sidecar (no reply expected).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostNotification {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// A message from the sidecar, parsed from one NDJSON line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum SidecarMessage {
    /// Reply to a [`HostRequest`]: `result` or `error`, never both.
    Response {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    /// Request from extension code running in a handler, correlated by
    /// `ctxToken`; the host replies with [`HostReply`] or [`HostErrorReply`].
    Request {
        ctx_token: String,
        method: String,
        #[serde(default)]
        params: Value,
    },
    /// Fire-and-forget from the sidecar (`extension_error`, registration).
    Notification {
        method: String,
        #[serde(default)]
        params: Value,
    },
}

// --- Handshake (Rust -> sidecar `hello`) -----------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloParams {
    pub protocol: u32,
    pub cwd: String,
    pub agent_dir: String,
    pub extension_paths: Vec<String>,
    /// CLI-provided flag values that override registered defaults
    /// (runner.ts `setFlagValue` runtime override seam).
    #[serde(default)]
    pub flag_values: JsonMap,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionLoadError {
    pub path: String,
    pub error: String,
}

/// The registrations one loaded extension produced (the serializable subset of
/// the TS `Extension` object; live functions stay in the sidecar).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRegistration {
    /// The configured extension path as given (may be relative or `<...>`).
    pub path: String,
    /// Absolute path after `~` expansion and cwd resolution (loader.ts
    /// `resolvePath`).
    pub resolved_path: String,
    /// Event names with at least one handler; the host only emits events
    /// with handlers (runner.ts `hasHandlers` gating).
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub tools: Vec<ToolRegistration>,
    #[serde(default)]
    pub commands: Vec<CommandRegistration>,
    #[serde(default)]
    pub flags: Vec<FlagRegistration>,
    #[serde(default)]
    pub shortcuts: Vec<ShortcutRegistration>,
    /// Custom session message types this extension renders.
    #[serde(default)]
    pub message_renderer_types: Vec<String>,
    /// Provider registrations queued during load (flushed at bind in TS;
    /// consumed by the provider seam in a later stage).
    #[serde(default)]
    pub providers: Vec<ProviderRegistration>,
}

/// Extension tool definition (`ToolDefinition` minus functions; `parameters` is
/// the TypeBox/JSON Schema, passed through as the wire tool schema).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRegistration {
    pub name: String,
    pub label: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_snippet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_guidelines: Option<Vec<String>>,
    pub parameters: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRegistration {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlagType {
    Boolean,
    String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagRegistration {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub r#type: FlagType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutRegistration {
    /// Normalized (lowercase) key id (runner.ts `getShortcuts`).
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Provider registration config (types.ts `ProviderConfig`). Kept as raw JSON:
/// `apiKey` is a value or an env var *name* (never resolved by the sidecar),
/// and `streamSimple`/`oauth` are v1-unsupported and reported as errors by the
/// host script rather than crossing the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRegistration {
    pub name: String,
    pub config: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub protocol: u32,
    #[serde(default)]
    pub extensions: Vec<ExtensionRegistration>,
    #[serde(default)]
    pub errors: Vec<ExtensionLoadError>,
}

// --- Requests (Rust -> sidecar) ---------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventParams {
    /// Correlates a dispatch with a `cancel` notification.
    pub event_id: String,
    /// The `ExtensionEvent` type (`session_start`, `session_before_compact`, ...).
    #[serde(rename = "type")]
    pub event_type: String,
    /// The event object minus its `type` field; the sidecar reconstructs
    /// `{ type, ...payload }` before invoking handlers.
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownParams {
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    /// The in-flight `event_id` to cancel.
    pub token: String,
}

// --- Tool execution (Rust -> sidecar `tool_execute`) -----------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecuteParams {
    pub tool_call_id: String,
    pub tool_name: String,
    #[serde(default)]
    pub args: Value,
}

/// A content block of an extension tool result (TS `AgentToolResult.content`;
/// the text/image subset that crosses the wire).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToolResultBlock {
    Text {
        text: String,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecuteResult {
    #[serde(default)]
    pub content: Vec<ToolResultBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    /// Absent on the wire when false (TS `AgentToolResult.isError` is
    /// optional); defaulting to false on read keeps both spellings valid.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecuteParams {
    /// The collision-suffixed invocation name (registry output).
    pub invocation_name: String,
    /// The raw text after the command name.
    #[serde(default)]
    pub args: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutExecuteParams {
    /// The normalized key id.
    pub key: String,
}

/// Notification payload for [`METHOD_TOOL_UPDATE`]: the partial result the
/// extension tool passed to `onUpdate` (render-only in stage 2, like the
/// tool bridge's update forwarding).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUpdateNotification {
    pub tool_call_id: String,
    #[serde(default)]
    pub result: Value,
}

// --- Notifications (sidecar -> Rust) ----------------------------------------

/// Port of types.ts `ExtensionError` (L1441-1446): the error-boundary report
/// for a throwing handler, timer, or registration. Never fatal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionError {
    pub extension_path: String,
    pub event: String,
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationNotification {
    pub extension_path: String,
    /// The changed registration items (first-wins and collision rules apply
    /// on the Rust side, runner.ts §1.5).
    #[serde(default)]
    pub registration: ExtensionRegistration,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rt<T: Serialize + for<'de> Deserialize<'de>>(json: &str) {
        let original: Value = serde_json::from_str(json).unwrap();
        let parsed: T = serde_json::from_str(json).expect("deserialize");
        let out = serde_json::to_string(&parsed).expect("serialize");
        let reparsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(original, reparsed, "round trip changed the value: {out}");
    }

    #[test]
    fn hello_params_roundtrip() {
        rt::<HelloParams>(
            r#"{"protocol":1,"cwd":"/repo","agentDir":"/home/u/.prime/agent","extensionPaths":["a.ts","<git:x>"],"flagValues":{"fast":true}}"#,
        );
    }

    #[test]
    fn hello_result_roundtrip() {
        rt::<HelloResult>(r#"{"protocol":1,"extensions":[],"errors":[]}"#);
        rt::<HelloResult>(
            r#"{"protocol":1,"extensions":[{"path":"a.ts","resolvedPath":"/repo/a.ts","events":["session_start"],"tools":[{"name":"hello","label":"Hello","description":"d","parameters":{"type":"object"}}],"commands":[],"flags":[{"name":"fast","type":"boolean","default":false}],"shortcuts":[{"key":"f1","description":"go"}],"messageRendererTypes":[],"providers":[]}],"errors":[{"path":"b.ts","error":"Failed to load extension: boom"}]}"#,
        );
    }

    #[test]
    fn sidecar_message_variants_roundtrip() {
        rt::<SidecarMessage>(r#"{"id":3,"result":{"ok":true}}"#);
        rt::<SidecarMessage>(r#"{"id":3,"error":{"message":"boom","stack":"at x"}}"#);
        rt::<SidecarMessage>(r#"{"ctxToken":"ctx-1","method":"exec","params":{"command":"ls"}}"#);
        rt::<SidecarMessage>(
            r#"{"method":"extension_error","params":{"extensionPath":"a.ts","event":"session_start","error":"boom"}}"#,
        );
    }

    #[test]
    fn host_envelopes_roundtrip() {
        rt::<HostRequest>(r#"{"id":1,"method":"hello","params":{"protocol":1}}"#);
        rt::<HostReply>(r#"{"ctxToken":"ctx-1","result":{}}"#);
        rt::<HostErrorReply>(r#"{"ctxToken":"ctx-1","error":{"message":"not bound"}}"#);
        rt::<HostNotification>(r#"{"method":"cancel","params":{"token":"e1"}}"#);
    }

    #[test]
    fn event_and_shutdown_params_roundtrip() {
        rt::<EventParams>(
            r#"{"eventId":"e1","type":"session_before_compact","payload":{"options":{}}}"#,
        );
        rt::<ShutdownParams>(r#"{"reason":"session_end"}"#);
        rt::<CancelParams>(r#"{"token":"e1"}"#);
    }

    #[test]
    fn tool_execute_roundtrip() {
        rt::<ToolExecuteParams>(
            r#"{"toolCallId":"c1","toolName":"hello","args":{"name":"world"}}"#,
        );
        rt::<ToolExecuteResult>(
            r#"{"content":[{"type":"text","text":"Hello, world!"}],"details":{"greeted":"world"},"isError":true}"#,
        );
        rt::<ToolExecuteResult>(r#"{"content":[]}"#);
        rt::<ToolExecuteResult>(r#"{"content":[],"isError":true}"#);
        rt::<ToolUpdateNotification>(r#"{"toolCallId":"c1","result":{"content":[]}}"#);
    }

    #[test]
    fn command_and_shortcut_execute_roundtrip() {
        rt::<CommandExecuteParams>(r#"{"invocationName":"greet:2","args":"hi there"}"#);
        rt::<ShortcutExecuteParams>(r#"{"key":"ctrl+g"}"#);
    }

    #[test]
    fn error_shape_matches_daemon_extension_error() {
        let e = ExtensionError {
            extension_path: "a.ts".into(),
            event: "session_start".into(),
            error: "boom".into(),
            stack: None,
        };
        let wire = serde_json::to_value(&e).unwrap();
        assert_eq!(
            wire,
            json!({"extensionPath": "a.ts", "event": "session_start", "error": "boom"})
        );
    }
}
