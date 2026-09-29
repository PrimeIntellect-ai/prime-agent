//! Cloud session protocol frames (TS `protocol.ts` v3): the bounded JSON
//! frames exchanged between a gateway, a remote client, and a session
//! executor over any reliable transport.
//!
//! - `hello`: client -> gateway, attach to a pre-allocated session.
//! - `snapshot`: gateway -> client, bounded session state plus an event
//!   tail; also the catch-up answer to `subscribe`.
//! - `events`: gateway -> client, live ordered events, bounded batches.
//! - `subscribe`: client -> gateway, request every event after a cursor.
//! - `submit`: client -> gateway, idempotent command submission; the
//!   response is a command receipt frame.
//! - `get_command`: client -> gateway, poll one receipt, or executor ->
//!   gateway, claim the next dispatchable command.
//! - `command`: gateway -> client/executor, command receipt, the response
//!   to `submit` and `get_command`.
//! - `ack`: client -> gateway, durably imported events by advancing the
//!   cursor.
//! - `inference_*`: guest -> local brokered inference, the sandbox's agent
//!   loop asks the local daemon to run one model call.
//!
//! Sessions are allocated before any compute and never created by hello.
//! The protocol version is negotiated once in hello; frames carry no
//! version. Field names and bounds match the TS wire exactly. Nothing here
//! is wired to a transport: parse/serialize plus validation only.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::base::{
    CloudClientId, CloudCommandId, CloudCommandReceipt, CloudCommandRequest, CloudCursor,
    CloudEvent, CloudSessionId, CloudSessionState, CloudSessionStatus,
};
use super::canonical_json;
use super::CLOUD_MAX_MESSAGE_BYTES;
use crate::daemon::cloud::message_validation::cloud_message_problem;
use crate::JsonMap;

/// TS `CLOUD_MESSAGE_TYPES`, joined exactly as the TS validator reports
/// it.
pub const CLOUD_MESSAGE_TYPES: &str = "hello, snapshot, subscribe, events, submit, get_command, command, ack, inference_request, inference_event, inference_end, inference_error";
/// Domain separation for request digests (TS `CLOUD_REQUEST_DIGEST_DOMAIN`,
/// `${CLOUD_PROTOCOL_NAME}.request.v1`).
pub const CLOUD_REQUEST_DIGEST_DOMAIN: &str = "prime-agent.cloud.request.v1";

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/// TS `CloudHello`: attach to a pre-allocated session; sessions are never
/// created by hello.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHello {
    /// Negotiated once in hello; frames carry no version. Must equal
    /// [`CLOUD_PROTOCOL_VERSION`].
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub protocol_version: u64,
    /// Event-log generation the client last observed; stale attachments are
    /// fenced off.
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub generation: u64,
    pub client_id: CloudClientId,
    /// Pre-allocated session to attach.
    pub session_id: CloudSessionId,
    /// Protocol authentication secret for transports that terminate outside
    /// the trusted VM boundary (e.g. a public tunnel edge). Loopback
    /// transports may omit it; a tunnel bridge always requires it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,
    /// The client's last consumed position; its generation must match
    /// `generation`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<CloudCursor>,
    /// The client's capabilities; absent means the v1 event stream only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

/// TS `CloudSnapshot`: bounded session state plus an event tail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSnapshot {
    pub session_id: CloudSessionId,
    /// Event-log epoch this tail belongs to.
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub generation: u64,
    /// Position covered by this snapshot; equals the last event sequence.
    pub cursor: CloudCursor,
    pub status: CloudSessionStatus,
    pub state: CloudSessionState,
    /// Bounded tail of events after the client's cursor.
    pub events: Vec<CloudEvent>,
    /// Capabilities this gateway supports; absent means the v1 event stream
    /// only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

/// TS `CloudSubscribe`: request every event after a cursor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSubscribe {
    pub session_id: CloudSessionId,
    pub cursor: CloudCursor,
}

/// TS `CloudEvents`: live ordered events pushed after a subscribe, in
/// bounded batches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudEventsFrame {
    pub session_id: CloudSessionId,
    /// Event-log epoch the batch belongs to.
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub generation: u64,
    pub events: Vec<CloudEvent>,
}

/// TS `CloudSubmit`: idempotent command submission.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSubmit {
    pub session_id: CloudSessionId,
    /// Event-log generation the client last observed; stale attachments are
    /// fenced off.
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub generation: u64,
    /// Client-chosen id; retries reuse it to stay idempotent.
    pub command_id: CloudCommandId,
    pub request: CloudCommandRequest,
    /// Must equal [`cloud_request_digest`] of the request; validated on
    /// receipt.
    pub digest: String,
}

/// TS `CloudGetCommand`: read-only receipt poll for one command, or an
/// executor claim of the next dispatchable command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudGetCommand {
    pub session_id: CloudSessionId,
    /// Event-log generation the sender last observed; stale attachments are
    /// fenced off.
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<CloudCommandId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<bool>,
}

/// TS `CloudCommand`: command receipt, the response to `submit` and
/// `get_command`; an executor state report carries the updated receipt, and
/// a claim handoff adds the request payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCommand {
    pub session_id: CloudSessionId,
    /// Event-log generation the receipt belongs to; stamps every command
    /// frame.
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub generation: u64,
    pub receipt: CloudCommandReceipt,
    /// Canonical JSON of the claimed command's request, present only on a
    /// claim handoff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
}

/// TS `CloudAck`: acknowledge durably imported events by advancing the
/// cursor; the gateway may only trim through it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAck {
    pub session_id: CloudSessionId,
    /// Durable imported-event position.
    pub cursor: CloudCursor,
}

/// TS `CloudInferenceRequest` model selector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInferenceModel {
    pub provider: String,
    pub model_id: String,
}

/// TS `CloudInferenceRequest` payload: canonical completion payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInferencePayload {
    pub messages: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonMap>,
}

/// TS `CloudInferenceRequest`: guest-to-local brokered inference. The local
/// side owns the model catalog and all provider credentials; the sandbox
/// never sees them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInferenceRequest {
    pub session_id: CloudSessionId,
    /// Remote session id the turn belongs to (the guest's own id
    /// namespace).
    pub remote_session_id: String,
    /// Client-chosen id; the response frames all echo it.
    pub request_id: String,
    /// Selector resolved locally against the user's full model catalog.
    pub model: CloudInferenceModel,
    /// Optional explicit reasoning level the guest's turn requested.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    pub payload: CloudInferencePayload,
}

/// TS `CloudInferenceEvent`: one streamed assistant-message event for a
/// brokered inference request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInferenceEvent {
    pub session_id: CloudSessionId,
    pub request_id: String,
    /// `AssistantMessageEvent`-shaped live frame (start/deltas/usage).
    pub event: JsonMap,
}

/// TS `CloudInferenceEnd`: terminal success for a brokered inference
/// request: the final message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInferenceEnd {
    pub session_id: CloudSessionId,
    pub request_id: String,
    /// Final `AssistantMessage`.
    pub message: JsonMap,
}

/// TS `CloudInferenceError`: terminal failure for a brokered inference
/// request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInferenceError {
    pub session_id: CloudSessionId,
    pub request_id: String,
    pub error: String,
}

/// TS `CloudMessage`: the full frame union, tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CloudMessage {
    Hello(CloudHello),
    Snapshot(CloudSnapshot),
    Subscribe(CloudSubscribe),
    Events(CloudEventsFrame),
    Submit(CloudSubmit),
    GetCommand(CloudGetCommand),
    Command(CloudCommand),
    Ack(CloudAck),
    InferenceRequest(CloudInferenceRequest),
    InferenceEvent(CloudInferenceEvent),
    InferenceEnd(CloudInferenceEnd),
    InferenceError(CloudInferenceError),
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/// TS `cloudDigest`: SHA-256 over canonical JSON, domain-separated so
/// digests cannot cross protocols.
#[must_use]
pub fn cloud_digest(canonical: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(CLOUD_REQUEST_DIGEST_DOMAIN);
    hasher.update([0]);
    hasher.update(canonical);
    let digest = hasher.finalize();
    format!("sha256:{digest:x}")
}

/// TS `cloudRequestDigest`: the digest a `submit` frame must carry. The
/// input must be a validated command request (the TS function throws on
/// non-canonical requests; the Rust form surfaces the canonical-JSON
/// problem instead).
///
/// # Errors
///
/// Returns the canonical-JSON problem when the value cannot be
/// canonicalized (depth bound).
pub fn cloud_request_digest(request: &serde_json::Value) -> Result<String, String> {
    Ok(cloud_digest(&canonical_json(request)?))
}

/// TS `isCloudDigest`: `sha256:` plus exactly 64 hex characters
/// (`[0-9a-f]`).
#[must_use]
pub fn is_cloud_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/// TS `parseCloudMessage` (wire form): parse an untrusted byte frame into
/// a validated [`CloudMessage`]. Transport-level failures (malformed or
/// oversized frames) close the stream; the returned problem string is the
/// TS `parseCloudMessage` error. The not-valid-JSON reason is
/// engine-specific (serde vs V8) and only the `message is not valid JSON:`
/// prefix is pinned.
///
/// # Errors
///
/// Returns the TS problem/error string when the frame is oversized, not
/// JSON, or fails validation.
pub fn parse_cloud_message(frame: &str) -> Result<CloudMessage, String> {
    if frame.len() > CLOUD_MAX_MESSAGE_BYTES {
        return Err(format!("message exceeds {CLOUD_MAX_MESSAGE_BYTES} bytes"));
    }
    let value: serde_json::Value = serde_json::from_str(frame)
        .map_err(|error| format!("message is not valid JSON: {error}"))?;
    if let Some(problem) = cloud_message_problem(&value) {
        return Err(problem);
    }
    // Integer fields normalize through JavaScript number semantics
    // (`1.0`, `1e0`, and >2^53 literals round through `f64` like
    // `JSON.parse`); an integral JS number above 2^64 - 2^11 has no `u64`
    // home, so the typed parse reports it there with the stable
    // `js_number` domain message (the corpus records the TS side
    // accepting such frames under `divergentParses`, and the golden test
    // pins the exact Rust rejection — the value is never saturated or
    // wrapped).
    serde_json::from_value(value).map_err(|error| error.to_string())
}

/// TS `serializeCloudMessage`: validate and canonically serialize a frame.
///
/// # Errors
///
/// Returns the TS error strings: `invalid cloud message: {problem}`, the
/// raw canonical-JSON problem, or `serialized message exceeds
/// {CLOUD_MAX_MESSAGE_BYTES} bytes`.
pub fn serialize_cloud_message(message: &CloudMessage) -> Result<String, String> {
    let value = serde_json::to_value(message).map_err(|error| error.to_string())?;
    if let Some(problem) = cloud_message_problem(&value) {
        return Err(format!("invalid cloud message: {problem}"));
    }
    let serialized = canonical_json(&value)?;
    if serialized.len() > CLOUD_MAX_MESSAGE_BYTES {
        return Err(format!(
            "serialized message exceeds {CLOUD_MAX_MESSAGE_BYTES} bytes"
        ));
    }
    Ok(serialized)
}
