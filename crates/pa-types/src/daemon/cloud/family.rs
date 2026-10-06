//! Cross-boundary family wire types (the v3 family slice of the cloud session
//! protocol, TS `protocol.ts`).
//!
//! The typed family surface: `CloudFamilyInfo`, `CloudAgentMessageSender`,
//! `CloudFamilyRow`, the family answer payloads, the family event/command
//! unions, and the local-to-guest `send_message` request. Field names, kind
//! discriminants, and bounds match the TS wire exactly. The family
//! validators live in [`super::validation`]; the full command/event unions
//! that embed these shapes live in [`super::base`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::canonical_json;
use super::CLOUD_MAX_RECEIPT_RESULT_CHARS;
use crate::JsonMap;

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
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
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
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
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

/// The receipt payload inside an `agent_message_result`, kept exactly as
/// wide as the wire: TS `cloudRequestProblem` accepts any canonical-JSON
/// object of at most [`CLOUD_MAX_RECEIPT_RESULT_CHARS`] bytes — the empty
/// object is protocol-valid (pinned by the TS-recorded corpus case
/// `agent_message_result_ok_empty_receipt`) — so the typed form
/// deserializes every JSON object and never rejects a protocol-valid
/// receipt. `id` and `deliveryStatus` are extracted when present and
/// well-formed; the local deliverer sets both on every real receipt (TS
/// `AgentSessionMessageReceipt`). Everything else — including mistyped
/// spellings of those two fields — round-trips verbatim through `rest`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentMessageReceipt {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_status: Option<CloudAgentMessageDeliveryStatus>,
    #[serde(skip_serializing_if = "serde_json::Map::is_empty", flatten)]
    pub rest: JsonMap,
}

impl<'de> Deserialize<'de> for CloudAgentMessageReceipt {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Any JSON object is in the wire domain (the validator rejects
        // non-objects with the TS problem string); the deliverer's fields
        // are extracted only when present and well-formed.
        let mut rest = JsonMap::deserialize(deserializer)?;
        let id = match rest.get("id") {
            Some(serde_json::Value::String(id)) => {
                let id = id.clone();
                rest.remove("id");
                Some(id)
            }
            _ => None,
        };
        let delivery_status = match rest.get("deliveryStatus") {
            Some(serde_json::Value::String(status)) => match status.as_str() {
                "delivered" => {
                    rest.remove("deliveryStatus");
                    Some(CloudAgentMessageDeliveryStatus::Delivered)
                }
                "queued" => {
                    rest.remove("deliveryStatus");
                    Some(CloudAgentMessageDeliveryStatus::Queued)
                }
                _ => None,
            },
            _ => None,
        };
        Ok(Self {
            id,
            delivery_status,
            rest,
        })
    }
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
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
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
