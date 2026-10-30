//! Cross-boundary family wire types: the v3 family surface of the cloud
//! session protocol.
//!
//! Port of the family-messaging slice of
//! `packages/coding-agent/src/core/cloud/protocol.ts` (protocol v3, TS
//! `origin/feat/direct-cloud-sandbox @ 193d42bf`): `CloudFamilyInfo`,
//! `CloudAgentMessageSender`, `CloudFamilyRow`, the guest-to-local
//! `family_roster_request` / `agent_message_request` events, the
//! local-to-guest `family_roster_result` / `agent_message_result` commands,
//! the `send_message` cloud command, and the terminal receipt payload. Field
//! names, kind discriminants, bounds, and problem strings match the TS wire
//! exactly, so a Rust endpoint serializes byte-identical frames and rejects
//! malformed ones with the TS messages.
//!
//! String bounds count UTF-16 code units (TS `.length` semantics), including
//! the astral plane, so an id or selector valid here is valid in TS and vice
//! versa.
//!
//! Receipts never claim delivery on this surface: a `CloudAgentMessageReceipt`
//! exists only after the receiving side admitted the message (the journaled
//! `agent_message_result` carries it), so "durably admitted but unanswered"
//! is a request state, never a receipt state.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::JsonMap;

pub const CLOUD_PROTOCOL_NAME: &str = "prime-agent.cloud";
/// Version 3 adds the cross-boundary family surface; hello requires an exact
/// match, so a mixed-version pair refuses attachment (TS
/// `CLOUD_PROTOCOL_VERSION`).
pub const CLOUD_PROTOCOL_VERSION: u64 = 3;
/// The hello capability that gates the family surface (TS `family_messages`).
pub const CLOUD_CAPABILITY_FAMILY_MESSAGES: &str = "family_messages";

pub const CLOUD_MAX_MESSAGE_BYTES: usize = 1_048_576;
pub const CLOUD_MAX_JSON_DEPTH: usize = 64;
pub const CLOUD_MAX_ID_CHARS: usize = 128;
pub const CLOUD_MAX_PROMPT_CHARS: usize = 65_536;
pub const CLOUD_MAX_ERROR_CHARS: usize = 2_048;
pub const CLOUD_MAX_TIMESTAMP_CHARS: usize = 64;
pub const CLOUD_MAX_PATH_CHARS: usize = 4_096;
pub const CLOUD_MAX_SESSION_NAME_CHARS: usize = 128;
/// Bound on one remote-family roster batch (`family_roster_result` entries).
pub const CLOUD_MAX_FAMILY_ROWS: usize = 64;
/// Bound on the terminal receipt `result` payload (canonical JSON string).
pub const CLOUD_MAX_RECEIPT_RESULT_CHARS: usize = 2_048;
/// Bound on an agent-message request id and a remote target selector.
pub const CLOUD_MAX_SELECTOR_CHARS: usize = 128;

/// TS `CloudEvent.kind` one-of list, joined exactly as the TS validator
/// reports it (used for the problem string; only the family kinds have typed
/// shapes here).
pub const CLOUD_EVENT_KINDS: &str = "command_accepted, command_state, session_status, output_delta, session_entry, session_event, session_meta, roster_delta, child_update, usage, family_roster_request, agent_message_request";
/// TS `CloudCommandRequest.kind` one-of list, joined exactly as the TS
/// validator reports it.
pub const CLOUD_COMMAND_KINDS: &str = "open_session, prompt, steer, follow_up, abort, send_message, set_model, set_thinking_level, set_session_name, compact, cancel_child, delete_child, extension_ui_response, release, family_roster_result, agent_message_result";

// ---------------------------------------------------------------------------
// Deterministic JSON (TS protocol.ts canonicalJson)
// ---------------------------------------------------------------------------

/// Deterministic JSON: recursively sorted keys, no whitespace, plain
/// values only, finite numbers, depth bounded by [`CLOUD_MAX_JSON_DEPTH`].
/// Two deep-equal values serialize to the same bytes, so digests are stable
/// across processes and key order never matters (TS `canonicalJson`).
///
/// # Errors
///
/// Returns a problem string when the value nests deeper than
/// [`CLOUD_MAX_JSON_DEPTH`].
pub fn canonical_json(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    canonicalize_into(&mut out, value, 0)?;
    Ok(out)
}

fn json_string(out: &mut String, text: &str) -> Result<(), String> {
    let encoded = serde_json::to_string(text).map_err(|error| error.to_string())?;
    out.push_str(&encoded);
    Ok(())
}

fn canonicalize_into(out: &mut String, value: &Value, depth: usize) -> Result<(), String> {
    if depth > CLOUD_MAX_JSON_DEPTH {
        return Err(format!(
            "canonical JSON depth exceeds {CLOUD_MAX_JSON_DEPTH}"
        ));
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            // serde_json only holds finite numbers; Display renders the JSON
            // form, and TS normalizes -0 to 0.
            let rendered = number.to_string();
            if rendered == "-0.0" {
                out.push('0');
            } else {
                out.push_str(&rendered);
            }
        }
        Value::String(text) => json_string(out, text)?,
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                canonicalize_into(out, item, depth + 1)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
            keys.sort_unstable();
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                let Some(item) = map.get(*key) else {
                    return Err("canonical JSON key vanished".to_string());
                };
                json_string(out, key)?;
                out.push(':');
                canonicalize_into(out, item, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared family shapes
// ---------------------------------------------------------------------------

/// Cross-boundary family context for a spawned cloud child, passed at
/// `open_session` (TS `CloudFamilyInfo`): the guest links to its durable
/// local parent even while the tunnel is down.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFamilyInfo {
    /// The cloud child's depth under its local parent (guest-relative root
    /// is 0).
    pub depth: u64,
    pub parent_session_id: String,
    pub parent_session_file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_name: Option<String>,
}

/// The sender endpoint carried on a cross-boundary agent message (TS
/// `CloudAgentMessageSender`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentMessageSender {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_kind: Option<CloudRuntimeKind>,
}

/// TS `"top-level" | "subagent"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloudRuntimeKind {
    TopLevel,
    Subagent,
}

/// TS `CloudFamilyRelationship`: the sender's relationship from the
/// receiver's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudFamilyRelationship {
    Parent,
    Sibling,
    Child,
}

/// TS `CloudFamilyRow["status"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudFamilyRowStatus {
    Running,
    Idle,
    Inactive,
}

/// One cross-boundary family row (TS `CloudFamilyRow`): a cloud row's own
/// entry, its parent, or a sibling, as the local supervisor sees it. Depths
/// are absolute; parent linkage uses the same session-id/session-path edges
/// the local family catalog builds on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFamilyRow {
    /// Session id (cloud session id, remote session id, or local session id).
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub depth: u64,
    pub status: CloudFamilyRowStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Receipt payload
// ---------------------------------------------------------------------------

/// TS `AgentSessionMessageDeliveryStatus` on the wire: the receiver-admitted
/// delivery truth. A receipt exists only after the target admitted the
/// message; nothing in this module fabricates one before that.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudAgentMessageDeliveryStatus {
    /// The prompt became the target's next run.
    Delivered,
    /// The target admitted the message behind current work (or the guest
    /// journal durably holds it).
    Queued,
}

/// The validated receipt payload inside an `agent_message_result` (TS
/// validates a receipt as a canonical-JSON object of at most
/// [`CLOUD_MAX_RECEIPT_RESULT_CHARS`] bytes; `id` and `deliveryStatus` are
/// the fields the local deliverer checks). Remaining receipt fields
/// (`source`, `target`, `from`, `message`, `deliveredAt`/`queuedAt`,
/// `deliveryMode`, `receiverRole`) round-trip untouched through `rest`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentMessageReceipt {
    pub id: String,
    pub delivery_status: CloudAgentMessageDeliveryStatus,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty", flatten)]
    pub rest: JsonMap,
}

impl CloudAgentMessageReceipt {
    /// Canonical-JSON size check the result validation applies (TS
    /// `CLOUD_MAX_RECEIPT_RESULT_CHARS`).
    ///
    /// # Errors
    ///
    /// Returns the TS problem string when the receipt is not canonical JSON
    /// or exceeds the bound.
    #[must_use]
    pub fn canonical_problem(&self) -> Option<String> {
        let value = serde_json::to_value(self).ok()?;
        match canonical_json(&value) {
            Ok(encoded) if encoded.len() <= CLOUD_MAX_RECEIPT_RESULT_CHARS => None,
            Ok(_) => Some(format!(
                "request.receipt exceeds {CLOUD_MAX_RECEIPT_RESULT_CHARS} bytes"
            )),
            Err(reason) => Some(format!("request.receipt is not canonical JSON: {reason}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Guest -> local events
// ---------------------------------------------------------------------------

/// The family slice of the guest-to-local event union (TS `CloudEvent`):
/// requests ride the guest's durable outbox; journaled result commands
/// answer them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CloudFamilyEventPayload {
    /// The guest asks for its cross-boundary family rows.
    #[serde(rename = "family_roster_request")]
    FamilyRosterRequest {
        #[serde(rename = "requestId")]
        request_id: String,
        /// The requesting remote session id (cloud root or descendant).
        #[serde(rename = "fromRemoteSessionId")]
        from_remote_session_id: String,
    },
    /// A guest session sends one agent message across the boundary.
    #[serde(rename = "agent_message_request")]
    AgentMessageRequest {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "fromRemoteSessionId")]
        from_remote_session_id: String,
        /// Target selector: session id, active session id, or session name.
        #[serde(rename = "targetSelector")]
        target_selector: String,
        message: String,
    },
}

/// One guest-to-local family event: the payload plus the outbook bookkeeping
/// every `CloudEvent` carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFamilyEvent {
    pub sequence: u64,
    pub recorded_at: String,
    #[serde(flatten)]
    pub payload: CloudFamilyEventPayload,
}

impl CloudFamilyEvent {
    /// The request id both family event kinds carry.
    #[must_use]
    pub fn request_id(&self) -> &str {
        match &self.payload {
            CloudFamilyEventPayload::FamilyRosterRequest { request_id, .. }
            | CloudFamilyEventPayload::AgentMessageRequest { request_id, .. } => request_id,
        }
    }
}

// ---------------------------------------------------------------------------
// Local -> guest journaled commands
// ---------------------------------------------------------------------------

/// The family slice of the local-to-guest command union (TS
/// `CloudCommandRequest`): answers to guest requests, journaled so a
/// replay dedupes by command id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CloudFamilyCommandPayload {
    /// Answer to a guest `family_roster_request`.
    #[serde(rename = "family_roster_result")]
    FamilyRosterResult {
        #[serde(rename = "requestId")]
        request_id: String,
        entries: Vec<CloudFamilyRow>,
    },
    /// Answer to a guest `agent_message_request`: a receipt only after the
    /// target admitted the message.
    #[serde(rename = "agent_message_result")]
    AgentMessageResult {
        #[serde(rename = "requestId")]
        request_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        receipt: Option<CloudAgentMessageReceipt>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

/// One local-to-guest family command request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFamilyCommand {
    #[serde(flatten)]
    pub payload: CloudFamilyCommandPayload,
}

impl CloudFamilyCommand {
    /// The request id both answer kinds carry.
    #[must_use]
    pub fn request_id(&self) -> &str {
        match &self.payload {
            CloudFamilyCommandPayload::FamilyRosterResult { request_id, .. }
            | CloudFamilyCommandPayload::AgentMessageResult { request_id, .. } => request_id,
        }
    }

    /// The TS journal-dedupe convention for one answer command id
    /// (`fam_${requestId}` / `msgres_${requestId}`): a duplicate submit under
    /// the same id is a no-op at the receiver's journal.
    #[must_use]
    pub fn journal_command_id(&self) -> String {
        match &self.payload {
            CloudFamilyCommandPayload::FamilyRosterResult { request_id, .. } => {
                format!("fam_{request_id}")
            }
            CloudFamilyCommandPayload::AgentMessageResult { request_id, .. } => {
                format!("msgres_{request_id}")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Local -> guest send_message command
// ---------------------------------------------------------------------------

/// The `send_message` slice of the local-to-guest command union (TS
/// `CloudCommandRequest`): one agent message addressed into the guest's
/// family. The submitter requires the tunnel attached — a local send cannot
/// be initiated while the laptop is offline (fail fast, no durable
/// local-to-cloud queue).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSendMessageRequest {
    pub target_remote_session_id: String,
    pub message: String,
    /// The sender-chosen message id, mirrored into the guest's custom entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// Sender endpoint for the guest's agent-message custom entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<CloudAgentMessageSender>,
    /// Relationship from the receiver's point of view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_relationship: Option<CloudFamilyRelationship>,
}

impl CloudSendMessageRequest {
    /// The fixed kind discriminant on the wire (TS union tag).
    pub const KIND: &'static str = "send_message";

    /// The full wire value, kind tag included, exactly as it rides a
    /// `submit` frame's `request` field.
    ///
    /// # Errors
    ///
    /// Returns a serialization error when a field cannot serialize.
    pub fn wire_value(&self) -> Result<Value, serde_json::Error> {
        let mut value = serde_json::to_value(self)?;
        if let Value::Object(map) = &mut value {
            map.insert("kind".to_string(), Value::from(Self::KIND));
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests;
mod validation;

pub use validation::{
    cloud_agent_message_sender_problem, cloud_family_command_problem, cloud_family_event_problem,
    cloud_family_info_problem, cloud_family_rows_problem, cloud_send_message_problem,
};
