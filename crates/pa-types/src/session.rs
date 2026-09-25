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
    AssistantContentBlock, AssistantMessage, AssistantMessageDiagnostic, ImageContent, ServiceTier,
    StopReason, TextContent, ThinkingContent, ToolCall, ToolResultMessage, Usage, UserContent,
    UserContentBlock, UserMessage,
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
            KnownFileEntry::GitState { payload, base } => Self::GitState { payload, base },
            KnownFileEntry::CustomMessage { payload, base } => {
                Self::CustomMessage { payload, base }
            }
        }
    }
}

/// Cold-load fast path for `message` entries.
///
/// A large session is dominated by `message` rows, and the tagged mirror pays
/// a second full buffering generation per row (the internally-tagged flatten
/// clones the entry, then the message, then every content block). This path
/// builds the same value field-by-field from the already-parsed JSON map,
/// cloning each payload exactly once into its final owner. It is strictly
/// conservative: anything it does not recognize without ambiguity returns
/// `None` and the tagged mirror decides, so acceptance (which rows degrade
/// to [`FileEntry::Unknown`], and how every `rest` catch-all is partitioned)
/// stays byte-identical to the derived path.
fn message_entry_fast(value: &Value) -> Option<FileEntry> {
    let map = value.as_object()?;
    if map.get("type")?.as_str()? != "message" {
        return None;
    }
    let message = message_entry_message(map.get("message")?)?;
    let base = message_entry_base(map)?;
    Some(FileEntry::Message { message, base })
}

/// [`EntryBase`] from the entry map: the envelope fields plus the catch-all
/// of every key the entry payload does not claim.
fn message_entry_base(map: &JsonMap) -> Option<EntryBase> {
    // `id` carries no `#[serde(default)]`; an absent or non-string id
    // (or an explicit null) defers to the mirror instead of guessing the
    // derived Option semantics.
    let id = match map.get("id") {
        Some(Value::String(id)) => Some(id.clone()),
        _ => return None,
    };
    let parent_id = catch_all_string(map.get("parentId"))?;
    let timestamp = catch_all_string(map.get("timestamp"))?;
    let rest = rest_of(map, &["type", "message", "id", "parentId", "timestamp"]);
    Some(EntryBase {
        id,
        parent_id,
        timestamp,
        rest,
    })
}

/// An optional string field: absent or null is `None`, anything but a string
/// defers to the mirror.
fn catch_all_string(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(_) => None,
    }
}

/// A required string field: absent or non-string defers to the mirror.
fn required_string(map: &JsonMap, key: &str) -> Option<String> {
    map.get(key)?.as_str().map(str::to_string)
}

/// The unclaimed keys of `map`, in source order.
fn rest_of(map: &JsonMap, claimed: &[&str]) -> JsonMap {
    let mut rest = JsonMap::new();
    for (key, value) in map {
        if !claimed.contains(&key.as_str()) {
            rest.insert(key.clone(), value.clone());
        }
    }
    rest
}

/// The [`AgentMessage`] roles a large session is made of; other roles defer
/// to the mirror, which produces the exact derived value.
fn message_entry_message(value: &Value) -> Option<AgentMessage> {
    let map = value.as_object()?;
    match map.get("role")?.as_str()? {
        "user" => Some(AgentMessage::User(user_message_fast(map)?)),
        "assistant" => Some(AgentMessage::Assistant(assistant_message_fast(map)?)),
        "toolResult" => Some(AgentMessage::ToolResult(tool_result_message_fast(map)?)),
        _ => None,
    }
}

/// An optional field of a derived shape, parsed through the mirror's own
/// derive: absent or null is `None`, a mismatch defers to the mirror.
fn optional_deserialize<T: serde::de::DeserializeOwned>(
    value: Option<&Value>,
) -> Option<Option<T>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(value) => serde_json::from_value(value.clone()).ok().map(Some),
    }
}

/// An optional boolean field.
fn catch_all_bool(value: Option<&Value>) -> Option<Option<bool>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(Value::Bool(flag)) => Some(Some(*flag)),
        Some(_) => None,
    }
}

fn user_message_fast(map: &JsonMap) -> Option<UserMessage> {
    let content = match map.get("content")? {
        Value::String(text) => UserContent::Text(text.clone()),
        Value::Array(blocks) => UserContent::Blocks(user_content_blocks_fast(blocks)?),
        _ => return None,
    };
    let timestamp = map.get("timestamp")?.as_u64()?;
    Some(UserMessage {
        content,
        timestamp,
        rest: rest_of(map, &["role", "content", "timestamp"]),
    })
}

fn user_content_blocks_fast(blocks: &[Value]) -> Option<Vec<UserContentBlock>> {
    blocks.iter().map(user_content_block_fast).collect()
}

fn user_content_block_fast(block: &Value) -> Option<UserContentBlock> {
    let map = block.as_object()?;
    match map.get("type").and_then(Value::as_str) {
        Some("text") => Some(UserContentBlock::Text(text_content_fast(map)?)),
        Some("image") => Some(UserContentBlock::Image(image_content_fast(map)?)),
        // A missing or unknown tag stays verbatim, like the derived catch-all.
        _ => Some(UserContentBlock::Raw(block.clone())),
    }
}

fn text_content_fast(map: &JsonMap) -> Option<TextContent> {
    let text = map.get("text")?.as_str()?.to_string();
    let text_signature = catch_all_string(map.get("textSignature"))?;
    Some(TextContent {
        text,
        text_signature,
        rest: rest_of(map, &["type", "text", "textSignature"]),
    })
}

fn image_content_fast(map: &JsonMap) -> Option<ImageContent> {
    let data = map.get("data")?.as_str()?.to_string();
    let mime_type = map.get("mimeType")?.as_str()?.to_string();
    Some(ImageContent {
        data,
        mime_type,
        rest: rest_of(map, &["type", "data", "mimeType"]),
    })
}

fn thinking_content_fast(map: &JsonMap) -> Option<ThinkingContent> {
    let thinking = map.get("thinking")?.as_str()?.to_string();
    let thinking_signature = catch_all_string(map.get("thinkingSignature"))?;
    let redacted = catch_all_bool(map.get("redacted"))?;
    Some(ThinkingContent {
        thinking,
        thinking_signature,
        redacted,
        rest: rest_of(map, &["type", "thinking", "thinkingSignature", "redacted"]),
    })
}

fn tool_call_fast(map: &JsonMap) -> Option<ToolCall> {
    let id = map.get("id")?.as_str()?.to_string();
    let name = map.get("name")?.as_str()?.to_string();
    let arguments = map.get("arguments")?.as_object()?.clone();
    let thought_signature = catch_all_string(map.get("thoughtSignature"))?;
    Some(ToolCall {
        id,
        name,
        arguments,
        thought_signature,
        rest: rest_of(
            map,
            &["type", "id", "name", "arguments", "thoughtSignature"],
        ),
    })
}

fn assistant_blocks_fast(blocks: &[Value]) -> Option<Vec<AssistantContentBlock>> {
    blocks.iter().map(assistant_block_fast).collect()
}

fn assistant_block_fast(block: &Value) -> Option<AssistantContentBlock> {
    let map = block.as_object()?;
    // The derived tagged form rejects unknown block kinds; deferring keeps
    // such rows degrading to Unknown exactly like the mirror.
    match map.get("type")?.as_str()? {
        "text" => Some(AssistantContentBlock::Text(text_content_fast(map)?)),
        "thinking" => Some(AssistantContentBlock::Thinking(thinking_content_fast(map)?)),
        "toolCall" => Some(AssistantContentBlock::ToolCall(tool_call_fast(map)?)),
        _ => None,
    }
}

fn assistant_message_fast(map: &JsonMap) -> Option<AssistantMessage> {
    let content = assistant_blocks_fast(map.get("content")?.as_array()?)?;
    let api = required_string(map, "api")?;
    let provider = required_string(map, "provider")?;
    let model = required_string(map, "model")?;
    let response_model = catch_all_string(map.get("responseModel"))?;
    let response_id = catch_all_string(map.get("responseId"))?;
    let diagnostics =
        optional_deserialize::<Vec<AssistantMessageDiagnostic>>(map.get("diagnostics"))?;
    let usage = serde_json::from_value::<Usage>(map.get("usage")?.clone()).ok()?;
    let stop_reason = serde_json::from_value::<StopReason>(map.get("stopReason")?.clone()).ok()?;
    let stop_reason_raw = catch_all_string(map.get("stopReasonRaw"))?;
    let error_message = catch_all_string(map.get("errorMessage"))?;
    let timestamp = map.get("timestamp")?.as_u64()?;
    Some(AssistantMessage {
        content,
        api,
        provider,
        model,
        response_model,
        response_id,
        diagnostics,
        usage,
        stop_reason,
        stop_reason_raw,
        error_message,
        timestamp,
        rest: rest_of(
            map,
            &[
                "role",
                "content",
                "api",
                "provider",
                "model",
                "responseModel",
                "responseId",
                "diagnostics",
                "usage",
                "stopReason",
                "stopReasonRaw",
                "errorMessage",
                "timestamp",
            ],
        ),
    })
}

fn tool_result_message_fast(map: &JsonMap) -> Option<ToolResultMessage> {
    let tool_call_id = required_string(map, "toolCallId")?;
    // `#[serde(default)]`: an absent name loads as empty, never null.
    let tool_name = match map.get("toolName") {
        None => String::new(),
        Some(Value::String(name)) => name.clone(),
        Some(_) => return None,
    };
    let content = user_content_blocks_fast(map.get("content")?.as_array()?)?;
    let details = match map.get("details") {
        None | Some(Value::Null) => None,
        Some(details) => Some(details.clone()),
    };
    let is_error = map.get("isError")?.as_bool()?;
    let timestamp = map.get("timestamp")?.as_u64()?;
    Some(ToolResultMessage {
        tool_call_id,
        tool_name,
        content,
        details,
        is_error,
        timestamp,
        rest: rest_of(
            map,
            &[
                "role",
                "toolCallId",
                "toolName",
                "content",
                "details",
                "isError",
                "timestamp",
            ],
        ),
    })
}

impl<'de> Deserialize<'de> for FileEntry {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        // `message` rows (the bulk of a large session) take the single-pass
        // fast path; everything else - and any shape the fast path does not
        // recognize - goes through the tagged mirror below, which keeps
        // acceptance byte-identical: known kinds parse through the mirror,
        // anything else degrades to the verbatim `Unknown` entry instead of
        // failing the load.
        if let Some(entry) = message_entry_fast(&value) {
            return Ok(entry);
        }
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

    /// The mirror value the load path produced before the `message` fast
    /// path existed (and still produces for every non-`message` row).
    fn mirror_entry(value: &Value) -> Option<FileEntry> {
        match KnownFileEntry::deserialize(value) {
            Ok(entry) => Some(FileEntry::from(entry)),
            Err(_) => match value {
                Value::Object(rest) => Some(FileEntry::Unknown { rest: rest.clone() }),
                _ => None,
            },
        }
    }

    #[test]
    fn message_fast_path_matches_tagged_mirror() {
        let rows = [
            // Fixture-shaped rows: user / assistant / toolResult with
            // thinking, text, tool-call, usage, and alias stop reasons.
            r#"{"type":"message","id":"a1","parentId":"h0","timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"user","content":"please do task number 1","timestamp":1789584016603}}"#,
            r#"{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"task 1: run"},{"type":"text","text":"Running."}],"toolCalls":[{"id":"call_000001","name":"ipython","arguments":{"code":"print(1)"}}],"api":"openai-completions","provider":"prime-inference","model":"mock-1","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"input":0.1,"output":0.1,"cacheRead":0,"cacheWrite":0,"total":0.2}},"stopReason":"tool_calls","timestamp":1789584016604}}"#,
            r#"{"type":"message","id":"a3","parentId":"a2","timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"toolResult","toolCallId":"call_000001","content":[{"type":"text","text":"OK"}],"isError":false,"timestamp":1789584016605}}"#,
            r#"{"type":"message","id":"a4","parentId":null,"timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"user","content":[{"type":"text","text":"blocks"}],"timestamp":1789584016606}}"#,
            r#"{"type":"message","id":"a5","parentId":"a4","timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"ipython","arguments":{"code":"1"},"thoughtSignature":"sig"}],"api":"openai-completions","provider":"prime-inference","model":"mock-1","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"input":0.1,"output":0.1,"cacheRead":0,"cacheWrite":0,"total":0.2}},"stopReason":"stop","errorMessage":null,"timestamp":1789584016607}}"#,
            r#"{"type":"message","id":"a6","parentId":"a5","timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"toolResult","toolCallId":"c","toolName":"ipython","content":[{"text":"bare"}],"details":{"x":1},"isError":true,"timestamp":1789584016608}}"#,
            // A row the fast path defers: roles it does not model.
            r#"{"type":"message","id":"a7","parentId":"a6","timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"custom","customType":"note","timestamp":1789584016609}}"#,
            // Rows both paths must reject identically into Unknown.
            r#"{"type":"message","id":"a8","timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"assistant","content":[{"type":"text","text":"x"}],"api":"openai-completions","provider":"prime-inference","model":"mock-1","stopReason":"stop","timestamp":1789584016610}}"#,
            r#"{"type":"message","id":"a9","timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"assistant","content":[{"type":"future_block","text":"x"}],"api":"openai-completions","provider":"prime-inference","model":"mock-1","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"input":0.1,"output":0.1,"cacheRead":0,"cacheWrite":0,"total":0.2}},"stopReason":"stop","timestamp":1789584016611}}"#,
            r#"{"type":"message","id":"a10","timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"assistant","content":[{"type":"text","text":42}],"api":"openai-completions","provider":"prime-inference","model":"mock-1","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"input":0.1,"output":0.1,"cacheRead":0,"cacheWrite":0,"total":0.2}},"stopReason":"stop","timestamp":1789584016612}}"#,
            r#"{"type":"message","timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"user","content":"no id","timestamp":1}}"#,
            r#"{"type":"message","id":"a11","timestamp":42,"message":{"role":"user","content":"numeric entry timestamp","timestamp":1}}"#,
            // Unknown kinds stay verbatim; non-objects stay errors.
            r#"{"type":"future_kind","id":"f1","parentId":"p1","timestamp":"2026-01-01T00:00:00.000Z"}"#,
            r#"{"type":"session","id":"s","version":3,"timestamp":"2026-09-16T18:40:16.600Z","cwd":"/tmp","rlmDepth":0}"#,
            r#""scalar""#,
            r#"42"#,
        ];
        for row in rows {
            let value: Value = serde_json::from_str(row).unwrap_or_else(|_| panic!("parse {row}"));
            let fast = message_entry_fast(&value);
            let mirror = mirror_entry(&value);
            // The fast path never invents a value the mirror would not
            // produce; rows it does not take defer to the mirror.
            if fast.is_some() {
                assert_eq!(fast, mirror, "fast path diverged from the mirror for {row}");
            }
            // End-to-end deserialization always equals the mirror's value.
            let deserialized = serde_json::from_str::<FileEntry>(row);
            assert_eq!(deserialized.ok(), mirror, "FileEntry diverged for {row}");
        }
    }

    #[test]
    fn message_fast_path_round_trips() {
        assert_roundtrips(
            r#"{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-09-16T18:40:16.600Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"run"},{"type":"text","text":"Running.","textSignature":"sig"}],"toolCalls":[{"id":"call_000001","name":"ipython","arguments":{"code":"print(1)"}}],"api":"openai-completions","provider":"prime-inference","model":"mock-1","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"input":0.1,"output":0.1,"cacheRead":0,"cacheWrite":0,"total":0.2}},"stopReason":"tool_calls","timestamp":1789584016604,"vendorExtra":{"z":1}}}"#,
        );
        assert_roundtrips(
            r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-09-16T18:40:16.600Z","entryExtra":true,"message":{"role":"user","content":[{"type":"text","text":"blocks","extra":1}],"timestamp":1789584016603,"userExtra":true}}"#,
        );
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
