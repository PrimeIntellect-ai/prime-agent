//! Base wire types of the cloud session protocol (TS `protocol.ts` v3):
//! session/command states, cursors, receipts, roster rows, session state,
//! model metadata, and the full command-request and event unions.
//!
//! Field names, kind discriminants, and bounds match the TS wire exactly
//! (port of `origin/feat/direct-cloud-sandbox @ 193d42bf`), so a Rust
//! endpoint serializes byte-identical frames. Typed shapes are the
//! construction/reading surface; the runtime validators in
//! [`super::request_validation`] and [`super::event_validation`] are the
//! gate that untrusted input must pass first.
//!
//! The family kinds of both unions embed the family slice's value types
//! (TS `CloudFamilyInfo`, `CloudAgentMessageSender`, `CloudFamilyRow`,
//! `CloudAgentMessageReceipt`); their validation delegates to the family
//! validators in [`super::validation`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::family::{
    CloudAgentMessageSender, CloudFamilyInfo, CloudFamilyRelationship, CloudFamilyRow,
};
use crate::JsonMap;

pub type CloudSessionId = String;
pub type CloudClientId = String;
pub type CloudCommandId = String;
pub type CloudTaskId = String;

/// TS `CLOUD_SESSION_STATUSES`, joined exactly as the TS validator reports
/// it.
pub const CLOUD_SESSION_STATUSES: &str = "starting, idle, busy, stopping, stopped, failed";
/// TS `CLOUD_COMMAND_STATES`, joined exactly as the TS validator reports
/// it.
pub const CLOUD_COMMAND_STATES: &str = "accepted, running, completed, failed, cancelled";
/// TS `CLOUD_CAPABILITIES`, joined exactly as the TS validator reports it.
/// This slice ships the wire list and its validation only — no side
/// advertises or negotiates capabilities.
pub const CLOUD_CAPABILITY_KINDS: &str =
    "event_stream, command_receipts, session_entries, session_events, roster_stream, family_messages, extension_ui, artifact_refs";

/// TS `CloudSessionStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudSessionStatus {
    Starting,
    Idle,
    Busy,
    Stopping,
    Stopped,
    Failed,
}

/// TS `CloudCommandState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudCommandState {
    Accepted,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl CloudCommandState {
    /// TS `isTerminalCloudCommandState`: a terminal state never transitions
    /// again.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// TS `CloudCursor`: a validated event-log position. Comparable only inside
/// one generation; a generation gap forces a resnapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCursor {
    /// Event-log epoch; bumped whenever the log is rewritten, so stale
    /// cursors resnapshot.
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub generation: u64,
    /// Last event sequence the holder consumed; 0 means nothing yet.
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub sequence: u64,
}

impl CloudCursor {
    /// TS `cloudCursor`.
    ///
    /// # Errors
    ///
    /// Returns the TS problem string for a non-positive generation or a
    /// negative sequence.
    pub fn new(generation: u64, sequence: u64) -> Result<Self, String> {
        if generation < 1 {
            return Err("cursor generation must be an integer of at least 1".to_string());
        }
        Ok(Self {
            generation,
            sequence,
        })
    }

    /// TS `advanceCursor`: the position after consuming one event.
    #[must_use]
    pub fn advance(self) -> Self {
        Self {
            generation: self.generation,
            sequence: self.sequence + 1,
        }
    }

    /// TS `cursorAtOrBefore`: ordering inside one generation.
    ///
    /// # Errors
    ///
    /// Returns the TS problem string when the cursors belong to different
    /// generations.
    pub fn at_or_before(self, later: Self) -> Result<bool, String> {
        if self.generation != later.generation {
            return Err(format!(
                "cursors from generations {} and {} are not comparable",
                self.generation, later.generation
            ));
        }
        Ok(self.sequence <= later.sequence)
    }
}

/// TS `canonicalCloudModelSelector`: the canonical `provider/modelId`
/// form. The model id may itself contain slashes (e.g.
/// `prime-inference/internal/glm-5.3-fast` addresses the provider
/// `prime-inference` and the model id `internal/glm-5.3-fast`).
#[must_use]
pub fn canonical_cloud_model_selector(provider: &str, model_id: &str) -> String {
    format!("{provider}/{model_id}")
}

/// TS `splitCloudModelSelector`: splits at the first slash so a model id
/// that itself contains slashes survives intact. A selector missing either
/// half is invalid.
///
/// Returns `(provider, model_id)`.
#[must_use]
pub fn split_cloud_model_selector(selector: &str) -> Option<(String, String)> {
    let slash = selector.find('/')?;
    if slash == 0 || slash == selector.len() - 1 {
        return None;
    }
    Some((
        selector[..slash].to_string(),
        selector[slash + 1..].to_string(),
    ))
}

/// TS `CloudModelMetadata`: bounded stub metadata for a brokered
/// (non-prime) model, sent at open so the guest can plan without the local
/// catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudModelMetadata {
    /// Display name for the guest's model stub.
    pub name: String,
    /// Context window in tokens.
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub context_window: u64,
    /// Maximum output tokens.
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub max_tokens: u64,
    /// Whether the model supports reasoning levels.
    pub reasoning: bool,
}

/// TS `CloudCommandReceipt`: the durable state of one admitted command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCommandReceipt {
    pub command_id: CloudCommandId,
    /// SHA-256 digest of the admitted request's canonical JSON.
    pub digest: String,
    pub state: CloudCommandState,
    pub submitted_at: String,
    pub updated_at: String,
    /// True when the journal restored this command without a terminal
    /// record.
    pub uncertain: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// v3 terminal result payload (canonical JSON string), e.g. the
    /// delivery status of a cross-boundary agent message. Absent on
    /// pre-v3 records and on commands that produce no payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

/// TS `CloudArtifactRef`: one artifact reference for an oversized session
/// entry payload (`artifact_refs` capability).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudArtifactRef {
    /// Guest-local path (or artifact id) the mirror can pull through the
    /// gateway.
    pub path: String,
    pub sha256: String,
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub bytes: u64,
}

/// TS roster/child run status (`"queued" | "running" | "completed" |
/// "failed" | "cancelled"`), shared by `roster_delta` rows and
/// `child_update` events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudChildStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// TS `CloudRosterRow`: one remote descendant row in a `roster_delta`
/// event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRosterRow {
    pub child_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_remote_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub status: CloudChildStatus,
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub depth: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// TS `output_delta` stream selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudOutputStream {
    Stdout,
    Stderr,
}

/// TS `session_meta` task state (`"needs_input" | "completed"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CloudTaskState {
    #[serde(rename = "needs_input")]
    NeedsInput,
    #[serde(rename = "completed")]
    Completed,
}

/// TS `usage` token totals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudUsageTotals {
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub input_tokens: u64,
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub output_tokens: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::js_number::deserialize_option_u64"
    )]
    pub cached_tokens: Option<u64>,
    #[serde(deserialize_with = "super::js_number::deserialize_u64")]
    pub requests: u64,
}

/// TS `CloudSessionState`: the bounded session state snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSessionState {
    pub cwd: String,
    pub model_id: String,
    /// Command currently claimed by the executor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_command_id: Option<CloudCommandId>,
    /// Admitted commands waiting to be claimed, oldest first.
    pub queued_command_ids: Vec<CloudCommandId>,
}

/// TS `CloudCommandRequest`: the full 16-kind command union, tagged by
/// `kind`. Session operations map onto ordinary agent-loop semantics;
/// requests stay digest-checked, journaled, and idempotent by
/// `commandId`. The family kinds embed the family slice's value types, so
/// the family surface stays owned by [`super::family`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CloudCommandRequest {
    /// Open (or reattach) the resident guest session.
    OpenSession {
        cwd: String,
        /// Canonical resolved-model selector `provider/modelId` (split at
        /// the first slash).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thinking: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seed_transcript_artifact: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        /// v3: family context for a spawned child (absolute depth + local
        /// parent).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        family: Option<CloudFamilyInfo>,
        /// Bounded stub metadata for a brokered (non-prime) model.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model_metadata: Option<CloudModelMetadata>,
    },
    /// Prompt the session; `target_session_id` (v3) addresses one remote
    /// descendant session.
    Prompt {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_if_busy: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_session_id: Option<String>,
    },
    Steer {
        text: String,
    },
    FollowUp {
        text: String,
    },
    Abort,
    /// Local-to-guest cross-boundary agent message (v3). The submitter
    /// requires the tunnel attached — there is no durable local-to-cloud
    /// queue.
    SendMessage {
        target_remote_session_id: String,
        message: String,
        /// Sender-chosen message id, mirrored into the guest's custom
        /// entry.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        /// Sender endpoint for the guest's agent-message custom entry.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<CloudAgentMessageSender>,
        /// Relationship from the receiver's point of view.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_relationship: Option<CloudFamilyRelationship>,
    },
    SetModel {
        provider: String,
        model_id: String,
    },
    SetThinkingLevel {
        level: String,
    },
    SetSessionName {
        name: String,
    },
    Compact {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,
    },
    CancelChild {
        child_id: String,
    },
    DeleteChild {
        child_id: String,
    },
    /// A UI response to a pending extension request; `response` is
    /// arbitrary canonical JSON.
    ExtensionUiResponse {
        request_id: String,
        response: Value,
        /// v3: the remote session that owns the pending request.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_session_id: Option<String>,
    },
    Release,
    /// v3 answer to a guest `family_roster_request`.
    FamilyRosterResult {
        request_id: String,
        entries: Vec<CloudFamilyRow>,
    },
    /// v3 answer to a guest `agent_message_request` (receipt after
    /// admission). The receipt is the canonical
    /// `AgentSessionMessageReceipt` JSON, carried opaque like the TS wire.
    AgentMessageResult {
        request_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        receipt: Option<JsonMap>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

/// TS `CloudEvent`: the full 12-kind guest-to-client event union, tagged
/// by `kind`. The family kinds are journaled guest requests (the family
/// slice's outbox); everything else is the base session surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CloudEvent {
    CommandAccepted {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        receipt: CloudCommandReceipt,
    },
    CommandState {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        receipt: CloudCommandReceipt,
    },
    SessionStatus {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        status: CloudSessionStatus,
    },
    OutputDelta {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        task_id: CloudTaskId,
        stream: CloudOutputStream,
        /// Bounded live output fragment; the guest batches and caps it.
        text: String,
    },
    /// Durable mirror of one guest session-file entry
    /// (`session_entries` capability).
    SessionEntry {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        /// Remote session id (the guest's session id), not a
        /// [`CloudSessionId`].
        session_id: String,
        entry_id: String,
        /// Canonical session-file entry JSON.
        entry: JsonMap,
        /// Artifact refs for payloads stored outside the entry
        /// (`artifact_refs` capability).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifacts: Option<Vec<CloudArtifactRef>>,
    },
    /// Ephemeral live session event frame (`session_events` capability).
    SessionEvent {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        session_id: String,
        /// `AgentConnectionSessionEvent` JSON.
        event: JsonMap,
    },
    /// Latest session metadata snapshot (`session_events` capability).
    SessionMeta {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        session_id: String,
        streaming: bool,
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        running_tools: u64,
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        queue: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recap: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_state: Option<CloudTaskState>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connectivity_hints: Option<Vec<String>>,
    },
    /// Remote descendant roster rows (`roster_stream` capability).
    RosterDelta {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        rows: Vec<CloudRosterRow>,
    },
    /// One remote child run transition (`roster_stream` capability).
    ChildUpdate {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        child_id: String,
        status: CloudChildStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answer_preview: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_file: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// Token totals for one remote session (`session_events` capability).
    Usage {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        session_id: String,
        totals: CloudUsageTotals,
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        revision: u64,
    },
    /// v3: the guest asks for its cross-boundary family rows
    /// (`family_messages` capability).
    FamilyRosterRequest {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        request_id: String,
        /// The requesting remote session id (cloud root or descendant).
        from_remote_session_id: String,
    },
    /// v3: a guest session sends one agent message across the boundary.
    AgentMessageRequest {
        #[serde(deserialize_with = "super::js_number::deserialize_u64")]
        sequence: u64,
        recorded_at: String,
        request_id: String,
        from_remote_session_id: String,
        /// Target selector: session id, active session id, or session name.
        target_selector: String,
        message: String,
    },
}
