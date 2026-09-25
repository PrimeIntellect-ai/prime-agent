//! Session JSONL entry format, ported from
//! `packages/coding-agent/src/core/session-manager.ts` (entries) and
//! `packages/coding-agent/src/core/messages.ts` (coding-agent message roles).
//!
//! Session files are append-only JSONL: the first line is a [`FileEntry::Header`]
//! (session header), every following line is one [`FileEntry`] entry. Entry
//! timestamps are ISO-8601 strings; message timestamps are Unix milliseconds.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::{
    AssistantMessage, ServiceTier, ToolResultMessage, Usage, UserContent, UserMessage,
};
use crate::JsonMap;

// ---------------------------------------------------------------------------
// Git context
// ---------------------------------------------------------------------------

/// Git repository identity captured alongside session headers and `git_state` entries.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

// ---------------------------------------------------------------------------
// Session header
// ---------------------------------------------------------------------------

/// First line of a session file (`type: "session"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHeader {
    /// Session format version; v1 sessions have no `version` field.
    ///
    /// Field order is the TS `SessionHeader` declaration order
    /// (`type` tag, `version`, `id`, `timestamp`, `cwd`, `parentSession`,
    /// `rlmDepth`, `git`); the serialized line must byte-match the TS
    /// session file's first line, and the JSON map preserves this order
    /// (the workspace's `serde_json` runs with `preserve_order`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    pub id: String,
    /// ISO-8601 creation timestamp.
    pub timestamp: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rlm_depth: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitContext>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

// ---------------------------------------------------------------------------
// Coding-agent message roles (JSONL `message` entries)
// ---------------------------------------------------------------------------

/// `role: "bashExecution"`: a `!`-command execution, rendered as a user turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BashExecutionMessage {
    pub command: String,
    pub output: String,
    /// Exit status; absent while the command is still running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    pub cancelled: bool,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_output_path: Option<String>,
    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
    /// True excludes this message from LLM context (`!!` prefix).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude_from_context: Option<bool>,
}

/// `role: "custom"`: extension/bookkeeping message with a `customType` tag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMessage {
    pub custom_type: String,
    pub content: UserContent,
    pub display: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// `role: "branchSummary"`: summary of a branch the conversation returned from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummaryMessage {
    pub summary: String,
    pub from_id: String,
    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
}

/// `role: "compactionSummary"`: compaction result presented as a user turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionSummaryMessage {
    pub summary: String,
    pub tokens_before: u64,
    /// Retained messages that precede this summary in transcript presentation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_message_count: Option<u64>,
    /// User instructions that guided the summary (`/compact <instructions>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_instructions: Option<String>,
    /// Harness digest snapshot attached mechanically at compaction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_digest: Option<String>,
    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
}

/// Conversation message stored in `message` entries: the provider-facing
/// messages from [`crate::ai`] plus the coding-agent-only roles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum AgentMessage {
    User(UserMessage),
    Assistant(AssistantMessage),
    ToolResult(ToolResultMessage),
    BashExecution(BashExecutionMessage),
    Custom(CustomMessage),
    BranchSummary(BranchSummaryMessage),
    CompactionSummary(CompactionSummaryMessage),
}

// ---------------------------------------------------------------------------
// Session entries
// ---------------------------------------------------------------------------

/// `type: "message"`: one conversation message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMessageEntry {
    pub message: AgentMessage,
}

/// `type: "thinking_level_change"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingLevelChangeEntry {
    pub thinking_level: String,
}

/// `type: "service_tier_change"`; `serviceTier` may be an explicit null.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTierChangeEntry {
    #[serde(default, deserialize_with = "deserialize_nullable_service_tier")]
    pub service_tier: Option<ServiceTier>,
}

fn deserialize_nullable_service_tier<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ServiceTier>, D::Error> {
    let value: Option<ServiceTier> = Option::deserialize(deserializer)?;
    Ok(value)
}

/// `type: "model_change"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChangeEntry {
    pub provider: String,
    pub model_id: String,
}

/// `type: "compaction"`: compaction performed at this point in the tree.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionEntry {
    pub summary: String,
    pub first_kept_entry_id: String,
    pub tokens_before: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_hook: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// Harness digest snapshot taken at compaction time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_digest: Option<String>,
}

/// `type: "branch_summary"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummaryEntry {
    pub from_id: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_hook: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

/// `type: "custom"`: opaque extension data with a `customType` tag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomEntry {
    pub custom_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// Origin of a child-usage attribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildUsageOrigin {
    SpawnTask,
    AgentMessage,
    DirectUser,
}

/// `type: "child_usage_attributed"`: RLM child usage folded into a parent
/// assistant message, kept separately for audit/UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildUsageAttributionEntry {
    pub target_id: String,
    pub child_usage: Usage,
    pub aggregate_usage: Usage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ChildUsageOrigin>,
}

/// `type: "label"`: a tree-node label set from the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelEntry {
    pub target_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// `type: "session_info"`: session display name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfoEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// `type: "session_state"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub status: SessionStateStatus,
}

/// Lifecycle status of a session file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStateStatus {
    Active,
    Archived,
    Crash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateEntry {
    pub state: SessionState,
}

/// High-level task state derived by the session's status summarizer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTaskState {
    NeedsInput,
    Completed,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_state: Option<AgentTaskState>,
    pub based_on_message_count: u64,
}

/// `type: "agent_status"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusEntry {
    pub status: AgentStatus,
}

/// `type: "git_state"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStateEntry {
    pub git: GitContext,
}

/// `type: "custom_message"`: a custom message preserved verbatim for replay
/// (content/details/display round-trip through session restore).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMessageEntry {
    pub custom_type: String,
    pub content: UserContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    pub display: bool,
    #[serde(flatten)]
    pub rest: JsonMap,
}

// ---------------------------------------------------------------------------
// File entry
// ---------------------------------------------------------------------------

/// One line of a session JSONL file: the header on line one, then tree entries.
///
/// Every entry shares `id`, `parentId` (null at the root), and an ISO-8601
/// `timestamp`; the `type` tag selects the payload.
///
/// Deserialization is catch-all like the TS loader (`JSON.parse` per line):
/// an entry whose `type` is not a known kind - written by a newer build, or a
/// different JSONL file in the sessions tree - is preserved verbatim as
/// [`FileEntry::Unknown`] instead of failing the whole session load. A known
/// kind that fails its own payload validation also degrades to `Unknown`
/// (lossless: the original JSON is kept), so a corrupt line can never block
/// a resume.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FileEntry {
    #[serde(rename = "session")]
    Header {
        #[serde(flatten)]
        header: SessionHeader,
    },
    Message {
        message: AgentMessage,
        #[serde(flatten)]
        base: EntryBase,
    },
    ThinkingLevelChange {
        #[serde(flatten)]
        payload: ThinkingLevelChangeEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    ServiceTierChange {
        #[serde(flatten)]
        payload: ServiceTierChangeEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    ModelChange {
        #[serde(flatten)]
        payload: ModelChangeEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    Compaction {
        #[serde(flatten)]
        payload: CompactionEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    BranchSummary {
        #[serde(flatten)]
        payload: BranchSummaryEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    Custom {
        #[serde(flatten)]
        payload: CustomEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    ChildUsageAttributed {
        #[serde(flatten)]
        payload: ChildUsageAttributionEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    Label {
        #[serde(flatten)]
        payload: LabelEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    SessionInfo {
        #[serde(flatten)]
        payload: SessionInfoEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    SessionState {
        #[serde(flatten)]
        payload: SessionStateEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    AgentStatus {
        #[serde(flatten)]
        payload: AgentStatusEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    GitState {
        #[serde(flatten)]
        payload: GitStateEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    CustomMessage {
        #[serde(flatten)]
        payload: CustomMessageEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    /// An entry this version does not model (unknown `type` tag, or a known
    /// tag whose payload failed validation); preserved verbatim.
    Unknown {
        #[serde(flatten)]
        rest: JsonMap,
    },
}

/// Derived internally-tagged deserialization form of [`FileEntry`] over the
/// known entry types; [`FileEntry`] falls back to [`FileEntry::Unknown`] for
/// anything else (see [`FileEntry`] docs).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum KnownFileEntry {
    #[serde(rename = "session")]
    Header {
        #[serde(flatten)]
        header: SessionHeader,
    },
    Message {
        message: AgentMessage,
        #[serde(flatten)]
        base: EntryBase,
    },
    ThinkingLevelChange {
        #[serde(flatten)]
        payload: ThinkingLevelChangeEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    ServiceTierChange {
        #[serde(flatten)]
        payload: ServiceTierChangeEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    ModelChange {
        #[serde(flatten)]
        payload: ModelChangeEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    Compaction {
        #[serde(flatten)]
        payload: CompactionEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    BranchSummary {
        #[serde(flatten)]
        payload: BranchSummaryEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    Custom {
        #[serde(flatten)]
        payload: CustomEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    ChildUsageAttributed {
        #[serde(flatten)]
        payload: ChildUsageAttributionEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    Label {
        #[serde(flatten)]
        payload: LabelEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    SessionInfo {
        #[serde(flatten)]
        payload: SessionInfoEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    SessionState {
        #[serde(flatten)]
        payload: SessionStateEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    AgentStatus {
        #[serde(flatten)]
        payload: AgentStatusEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    GitState {
        #[serde(flatten)]
        payload: GitStateEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
    CustomMessage {
        #[serde(flatten)]
        payload: CustomMessageEntry,
        #[serde(flatten)]
        base: EntryBase,
    },
}

impl From<KnownFileEntry> for FileEntry {
    fn from(entry: KnownFileEntry) -> Self {
        match entry {
            KnownFileEntry::Header { header } => Self::Header { header },
            KnownFileEntry::Message { message, base } => Self::Message { message, base },
            KnownFileEntry::ThinkingLevelChange { payload, base } => {
                Self::ThinkingLevelChange { payload, base }
            }
            KnownFileEntry::ServiceTierChange { payload, base } => {
                Self::ServiceTierChange { payload, base }
            }
            KnownFileEntry::ModelChange { payload, base } => Self::ModelChange { payload, base },
            KnownFileEntry::Compaction { payload, base } => Self::Compaction { payload, base },
            KnownFileEntry::BranchSummary { payload, base } => {
                Self::BranchSummary { payload, base }
            }
            KnownFileEntry::Custom { payload, base } => Self::Custom { payload, base },
            KnownFileEntry::ChildUsageAttributed { payload, base } => {
                Self::ChildUsageAttributed { payload, base }
            }
            KnownFileEntry::Label { payload, base } => Self::Label { payload, base },
            KnownFileEntry::SessionInfo { payload, base } => Self::SessionInfo { payload, base },
            KnownFileEntry::SessionState { payload, base } => Self::SessionState { payload, base },
            KnownFileEntry::AgentStatus { payload, base } => Self::AgentStatus { payload, base },
            KnownFileEntry::GitState { payload, base } => Self::GitState { payload, base },
            KnownFileEntry::CustomMessage { payload, base } => {
                Self::CustomMessage { payload, base }
            }
        }
    }
}

impl<'de> Deserialize<'de> for FileEntry {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        // Known kinds parse through the tagged mirror; anything else degrades
        // to the verbatim `Unknown` entry instead of failing the load.
        match KnownFileEntry::deserialize(&value) {
            Ok(entry) => Ok(FileEntry::from(entry)),
            Err(_) => match value {
                Value::Object(rest) => Ok(FileEntry::Unknown { rest }),
                other => Err(<D::Error as serde::de::Error>::custom(format!(
                    "session entry must be a JSON object, got {other}"
                ))),
            },
        }
    }
}

impl FileEntry {
    pub fn id(&self) -> Option<&str> {
        let base = match self {
            FileEntry::Header { header } => return Some(&header.id),
            FileEntry::Unknown { rest } => {
                return rest.get("id").and_then(|v| v.as_str());
            }
            FileEntry::Message { base, .. }
            | FileEntry::ThinkingLevelChange { base, .. }
            | FileEntry::ServiceTierChange { base, .. }
            | FileEntry::ModelChange { base, .. }
            | FileEntry::Compaction { base, .. }
            | FileEntry::BranchSummary { base, .. }
            | FileEntry::Custom { base, .. }
            | FileEntry::ChildUsageAttributed { base, .. }
            | FileEntry::Label { base, .. }
            | FileEntry::SessionInfo { base, .. }
            | FileEntry::SessionState { base, .. }
            | FileEntry::AgentStatus { base, .. }
            | FileEntry::GitState { base, .. }
            | FileEntry::CustomMessage { base, .. } => base,
        };
        base.id.as_deref()
    }

    /// Parent entry id (None for the header / roots with no parent).
    pub fn parent_id(&self) -> Option<&str> {
        let base = match self {
            FileEntry::Header { .. } => return None,
            FileEntry::Unknown { rest } => {
                return rest.get("parentId").and_then(|v| v.as_str());
            }
            FileEntry::Message { base, .. }
            | FileEntry::ThinkingLevelChange { base, .. }
            | FileEntry::ServiceTierChange { base, .. }
            | FileEntry::ModelChange { base, .. }
            | FileEntry::Compaction { base, .. }
            | FileEntry::BranchSummary { base, .. }
            | FileEntry::Custom { base, .. }
            | FileEntry::ChildUsageAttributed { base, .. }
            | FileEntry::Label { base, .. }
            | FileEntry::SessionInfo { base, .. }
            | FileEntry::SessionState { base, .. }
            | FileEntry::AgentStatus { base, .. }
            | FileEntry::GitState { base, .. }
            | FileEntry::CustomMessage { base, .. } => Some(base),
        };
        base?.parent_id.as_deref()
    }

    /// ISO-8601 entry timestamp; empty string when absent (older v1 lines).
    pub fn timestamp(&self) -> &str {
        let base = match self {
            FileEntry::Header { header } => return header.timestamp.as_str(),
            FileEntry::Unknown { rest } => {
                return rest
                    .get("timestamp")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
            }
            FileEntry::Message { base, .. }
            | FileEntry::ThinkingLevelChange { base, .. }
            | FileEntry::ServiceTierChange { base, .. }
            | FileEntry::ModelChange { base, .. }
            | FileEntry::Compaction { base, .. }
            | FileEntry::BranchSummary { base, .. }
            | FileEntry::Custom { base, .. }
            | FileEntry::ChildUsageAttributed { base, .. }
            | FileEntry::Label { base, .. }
            | FileEntry::SessionInfo { base, .. }
            | FileEntry::SessionState { base, .. }
            | FileEntry::AgentStatus { base, .. }
            | FileEntry::GitState { base, .. }
            | FileEntry::CustomMessage { base, .. } => base,
        };
        base.timestamp.as_deref().unwrap_or_default()
    }
}

/// Fields shared by every non-header entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryBase {
    pub id: Option<String>,
    /// Parent entry id; null at the root of the session tree.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// ISO-8601 timestamp.
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(flatten)]
    pub rest: JsonMap,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: &str) -> FileEntry {
        serde_json::from_str(json).expect("deserialize entry")
    }

    fn assert_roundtrips(json: &str) {
        let original: Value = serde_json::from_str(json).unwrap();
        let out = serde_json::to_string(&entry(json)).expect("serialize entry");
        let reparsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(original, reparsed, "round trip changed the value: {out}");
    }

    #[test]
    fn unknown_entry_type_is_preserved_verbatim() {
        // Live shape from a daemon semantic-edge stream: an entry kind this
        // version does not model must not fail the load.
        let json = r#"{"type":"request_started","request_id":"r","session_id":"s"}"#;
        let FileEntry::Unknown { rest } = entry(json) else {
            panic!("expected an Unknown entry");
        };
        assert_eq!(rest.get("request_id").and_then(Value::as_str), Some("r"));
        assert_roundtrips(json);
    }

    #[test]
    fn unknown_entry_keeps_tree_fields() {
        let json = r#"{"type":"future_kind","id":"f1","parentId":"p1","timestamp":"2026-01-01T00:00:00.000Z"}"#;
        let parsed = entry(json);
        assert_eq!(parsed.id(), Some("f1"));
        assert_eq!(parsed.parent_id(), Some("p1"));
        assert_eq!(parsed.timestamp(), "2026-01-01T00:00:00.000Z");
        assert_roundtrips(json);
    }

    #[test]
    fn malformed_known_entry_degrades_to_unknown_verbatim() {
        // A known tag with an invalid payload must not fail the whole session
        // load; the line is preserved exactly as written.
        let json = r#"{"type":"model_change","id":"m1","provider":123,"modelId":null}"#;
        let FileEntry::Unknown { rest } = entry(json) else {
            panic!("expected an Unknown entry");
        };
        assert_eq!(
            rest.get("type").and_then(Value::as_str),
            Some("model_change")
        );
        assert_roundtrips(json);
    }

    #[test]
    fn non_object_entry_is_rejected() {
        assert!(serde_json::from_str::<FileEntry>(r#""not an entry""#).is_err());
    }
}
