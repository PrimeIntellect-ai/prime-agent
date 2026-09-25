//! Headless session-message stream: the same UI renders history JSONL
//! (captured sessions under `~/.prime/agent/sessions`) and live events.
//!
//! `SessionStream` is the seam the interactive mode and the replay binary
//! share; `JsonlSessionStream` implements it over pa-types session entries.

use anyhow::{Context, Result};
use pa_types::session::{AgentMessage, FileEntry};
use std::path::Path;

/// A transcript item rendered by the agent view.
#[derive(Debug, Clone, PartialEq)]
pub enum TranscriptItem {
    UserMessage {
        text: String,
    },
    /// One assistant message's rendered content (text and thinking blocks
    /// in wire order). Thinking blocks keep their type through the replay:
    /// the transcript gates them on the detail level like the live path.
    Assistant {
        blocks: Vec<crate::chat::MessageBlock>,
        /// `toolUse` when the message carried tool calls (drives the
        /// trailing spacer before its tool cards).
        has_tool_calls: bool,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: String,
        /// The parent assistant message's wire `timestamp` (Unix
        /// milliseconds): reading an existing field for the condensed
        /// runs' wall-clock - no schema change.
        timestamp: u64,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        text: String,
        /// The full wire content blocks (text and image), so replayed tool
        /// results render their image rows like live ones.
        content: Vec<serde_json::Value>,
        /// The wire `details` record (stdout/stderr/result/sent receipts),
        /// folded onto the pending tool card so replayed cells render their
        /// structured output exactly like live ones.
        details: serde_json::Value,
        is_error: bool,
        /// The message's wire `timestamp` (Unix milliseconds).
        timestamp: u64,
    },
    BashExecution {
        command: String,
        output: String,
        exit_code: Option<i64>,
        cancelled: bool,
        truncated: bool,
        full_output_path: Option<String>,
        excluded: bool,
    },
    ModelChange {
        provider: String,
        model_id: String,
    },
    /// Client-side notice (command output, errors, list rows) rendered muted.
    SystemNote {
        text: String,
    },
    /// One decoded custom-message row (agent messages, injected prompts,
    /// outcomes, and the generic custom box).
    CustomRow {
        entry: crate::chat::ChatEntry,
    },
}

/// Live event surfaced through a [`SessionStream`].
#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    /// A new transcript item appended to the view.
    Item(TranscriptItem),
    /// Stream finished (no more events).
    End,
}

/// Source of session events. Implementations range from a JSONL capture
/// (replay) to a live daemon connection.
pub trait SessionStream: Send {
    /// Pull the next event, `End` once the stream is finished.
    ///
    /// # Errors
    ///
    /// Implementations report their own transport or decode failures;
    /// the bundled JSONL replay stream never returns `Err` (its entries
    /// were validated at load).
    fn poll(&mut self) -> Result<SessionEvent>;
}

/// Stream a recorded session JSONL file entry by entry.
pub struct JsonlSessionStream {
    entries: std::vec::IntoIter<FileEntry>,
    pending: Vec<TranscriptItem>,
    finished: bool,
}

impl JsonlSessionStream {
    pub fn from_entries(entries: Vec<FileEntry>) -> Self {
        Self {
            entries: entries.into_iter(),
            pending: Vec::new(),
            finished: false,
        }
    }

    /// Load all entries from a session JSONL file (skip undecodable lines).
    ///
    /// # Errors
    ///
    /// Returns `Err` when the file cannot be read, or a non-empty line
    /// fails to decode as an entry (the error carries the line's
    /// 1-based number).
    pub fn from_path(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading session {}", path.display()))?;
        let entries = parse_jsonl(&raw)?;
        Ok(Self::from_entries(entries))
    }
}

/// Parse session JSONL text into file entries, ignoring blank lines.
///
/// # Errors
///
/// Returns `Err` on the first non-blank line that does not decode as a
/// `FileEntry` (the error carries the line's 1-based number).
pub fn parse_jsonl(raw: &str) -> Result<Vec<FileEntry>> {
    let mut entries = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<FileEntry>(line) {
            Ok(entry) => entries.push(entry),
            Err(e) => {
                return Err(anyhow::anyhow!("line {}: {}", i + 1, e))
                    .with_context(|| format!("parsing session entry {}", i + 1))
            }
        }
    }
    Ok(entries)
}

/// Fold a session entry into the transcript (paired tool results attach to
/// nothing here; they render as their own panel lines).
pub fn entry_to_items(entry: &FileEntry) -> Vec<TranscriptItem> {
    match entry {
        FileEntry::Message { message, .. } => message_to_items(message),
        FileEntry::ModelChange { payload, .. } => vec![TranscriptItem::ModelChange {
            provider: payload.provider.clone(),
            model_id: payload.model_id.clone(),
        }],
        // Custom rows rejoin as their wire message form and decode through
        // the same custom-type dispatch the live path uses.
        FileEntry::CustomMessage { payload, .. } => {
            let message = custom_message_wire_value(payload);
            crate::custom_message::custom_message_entries(&message)
                .into_iter()
                .map(|entry| TranscriptItem::CustomRow { entry })
                .collect()
        }
        _ => Vec::new(),
    }
}

/// Rebuild the `role: "custom"` wire message shape from a persisted
/// `custom_message` entry (the same rejoin the daemon session store and
/// the TS session manager perform on load).
fn custom_message_wire_value(payload: &pa_types::session::CustomMessageEntry) -> serde_json::Value {
    let content = match serde_json::to_value(&payload.content) {
        Ok(value) => value,
        Err(_) => serde_json::Value::Null,
    };
    serde_json::json!({
        "role": "custom",
        "customType": payload.custom_type,
        "content": content,
        "display": payload.display,
        "details": payload.details.clone().unwrap_or(serde_json::Value::Null),
    })
}

fn message_to_items(message: &AgentMessage) -> Vec<TranscriptItem> {
    match message {
        AgentMessage::User(u) => {
            // TS `readUserText` + the image-only placeholder: a prompt
            // with content but no text shows `[image]` instead of
            // rendering nothing.
            let text = user_display_text(&u.content);
            // TS `addMessageToChat`'s user case: a skill block parses into
            // the skill-invocation card (+ its trailing argument text as a
            // user block); both ride the custom-row channel so the replay
            // renders them exactly like the live path.
            match crate::custom_message::skill_invocation_entries(&text) {
                Some(entries) => entries
                    .into_iter()
                    .map(|entry| TranscriptItem::CustomRow { entry })
                    .collect(),
                None => vec![TranscriptItem::UserMessage { text }],
            }
        }
        // TS `buildConversationComponents`: one assistant component per
        // message (text and thinking blocks together, in wire order), then
        // the message's tool cards. Thinking blocks keep their type —
        // `AssistantMessageComponent` renders them gated on the detail
        // level (hidden at `overview`, dim at `details`/`all`), so a
        // replayed thinking trace renders exactly like a live one.
        AgentMessage::Assistant(a) => {
            let mut items = Vec::new();
            let mut blocks = Vec::new();
            let mut has_tool_calls = false;
            for block in &a.content {
                match block {
                    pa_types::ai::AssistantContentBlock::Text(t) => {
                        if !t.text.trim().is_empty() {
                            blocks.push(crate::chat::MessageBlock::Text(t.text.clone()));
                        }
                    }
                    pa_types::ai::AssistantContentBlock::Thinking(t) => {
                        if !t.thinking.trim().is_empty() {
                            blocks.push(crate::chat::MessageBlock::Thinking(t.thinking.clone()));
                        }
                    }
                    pa_types::ai::AssistantContentBlock::ToolCall(tc) => {
                        has_tool_calls = true;
                        items.push(TranscriptItem::ToolCall {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            arguments: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                            timestamp: a.timestamp,
                        });
                    }
                }
            }
            items.insert(
                0,
                TranscriptItem::Assistant {
                    blocks,
                    has_tool_calls,
                },
            );
            items
        }
        AgentMessage::ToolResult(t) => vec![TranscriptItem::ToolResult {
            tool_call_id: t.tool_call_id.clone(),
            tool_name: t.tool_name.clone(),
            text: tool_result_text(&t.content),
            content: t
                .content
                .iter()
                .map(|block| match serde_json::to_value(block) {
                    Ok(value) => value,
                    Err(_) => serde_json::Value::Null,
                })
                .collect(),
            details: t.details.clone().unwrap_or(serde_json::Value::Null),
            is_error: t.is_error,
            timestamp: t.timestamp,
        }],
        AgentMessage::BashExecution(b) => vec![TranscriptItem::BashExecution {
            command: b.command.clone(),
            output: b.output.clone(),
            exit_code: b.exit_code,
            cancelled: b.cancelled,
            truncated: b.truncated,
            full_output_path: b.full_output_path.clone(),
            excluded: b.exclude_from_context.unwrap_or(false),
        }],
        // Custom/branch/compaction messages carry UI-specific payloads; the
        // standard agent view skips non-displayed ones.
        _ => Vec::new(),
    }
}

/// The concatenated text of a replayed tool result's text blocks
/// (un-modeled blocks have no display text, TS renders only typed text
/// blocks).
fn tool_result_text(content: &[pa_types::ai::UserContentBlock]) -> String {
    content
        .iter()
        .map(|block| match block {
            pa_types::ai::UserContentBlock::Text(text) => text.text.clone(),
            pa_types::ai::UserContentBlock::Image(_) | pa_types::ai::UserContentBlock::Raw(_) => {
                String::new()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The user-message display text (TS `conversation-components`' user
/// branch): the text blocks joined, or the `[image]` placeholder when the
/// message carries content but no text.
fn user_display_text(content: &pa_types::ai::UserContent) -> String {
    let text = content.text();
    if !text.is_empty() {
        return text;
    }
    match content {
        pa_types::ai::UserContent::Text(text) if !text.is_empty() => "[image]".to_string(),
        pa_types::ai::UserContent::Blocks(blocks) if !blocks.is_empty() => "[image]".to_string(),
        _ => String::new(),
    }
}

impl SessionStream for JsonlSessionStream {
    fn poll(&mut self) -> Result<SessionEvent> {
        loop {
            if let Some(item) = self.pending.first().cloned() {
                self.pending.remove(0);
                return Ok(SessionEvent::Item(item));
            }
            if self.finished {
                return Ok(SessionEvent::End);
            }
            match self.entries.next() {
                Some(entry) => {
                    let items = entry_to_items(&entry);
                    if items.is_empty() {
                        continue;
                    }
                    self.pending = items[1..].to_vec();
                    return Ok(SessionEvent::Item(items[0].clone()));
                }
                None => {
                    self.finished = true;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_message_entries_rejoin_and_decode() {
        // A persisted custom_message entry rejoins as its wire shape and
        // decodes through the same custom-type dispatch the live path
        // uses; a non-display row renders nothing.
        let entry = |display: bool| FileEntry::CustomMessage {
            payload: pa_types::session::CustomMessageEntry {
                custom_type: "agent_message".to_string(),
                content: pa_types::ai::UserContent::Text(
                    "[agent-message from child:lane]\n\nhi".to_string(),
                ),
                details: Some(serde_json::json!({
                    "id": "agentmsg_t1",
                    "message": "hi",
                    "from": { "sessionName": "lane" },
                    "fromRelationship": "child",
                })),
                display,
                rest: serde_json::Map::new(),
            },
            base: pa_types::session::EntryBase {
                id: Some("e1".to_string()),
                parent_id: None,
                timestamp: None,
                rest: serde_json::Map::new(),
            },
        };
        let items = entry_to_items(&entry(true));
        let [TranscriptItem::CustomRow { entry: chat_entry }] = items.as_slice() else {
            panic!("custom row: {items:?}");
        };
        match chat_entry {
            crate::chat::ChatEntry::AgentMessage(row) => {
                assert_eq!(row.counterpart, "lane");
                assert_eq!(row.message, "hi");
            }
            other => panic!("agent row: {other:?}"),
        }
        assert!(entry_to_items(&entry(false)).is_empty());
    }

    #[test]
    fn a_skill_block_user_message_replays_as_the_card() {
        // TS `addMessageToChat`'s user case parses a `<skill>` block out
        // of the persisted user message: the replay renders the card plus
        // the trailing argument text as a user block, never the raw
        // block text.
        let entry = FileEntry::Message {
            message: AgentMessage::User(pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text(
                    "<skill name=\"websearch\" location=\"/s/SKILL.md\">\nRun one query.\n</skill>\n\nfind parity tuis"
                        .to_string(),
                ),
                timestamp: 1,
                rest: serde_json::Map::new(),
            }),
            base: pa_types::session::EntryBase {
                id: Some("e1".to_string()),
                parent_id: None,
                timestamp: None,
                rest: serde_json::Map::new(),
            },
        };
        let items = entry_to_items(&entry);
        let [TranscriptItem::CustomRow { entry: card }, TranscriptItem::CustomRow { entry: args }] =
            items.as_slice()
        else {
            panic!("skill items: {items:?}");
        };
        match card {
            crate::chat::ChatEntry::SkillInvocation(row) => {
                assert_eq!(row.name, "websearch");
                assert_eq!(row.content, "Run one query.");
            }
            other => panic!("card: {other:?}"),
        }
        assert_eq!(
            args,
            &crate::chat::ChatEntry::User {
                text: "find parity tuis".to_string()
            }
        );
    }

    #[test]
    fn replay_keeps_thinking_blocks_and_tool_flags() {
        // A replayed assistant message keeps its thinking blocks' type (the
        // dim/gated treatment) alongside the text, and flags its tool calls
        // for the trailing spacer — one Assistant item before the ToolCall
        // items, TS `buildConversationComponents` order.
        let line = r#"{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"probe the replay trace","thinkingSignature":"sig-1"},{"type":"text","text":"body after thinking"},{"type":"toolCall","id":"toolu_1","name":"bash","arguments":{"command":"ls"}}],"api":"openai-completions","provider":"prime-inference","model":"m","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1},"id":"e1"}"#;
        let entries = parse_jsonl(line).unwrap();
        let items = entry_to_items(&entries[0]);
        let [TranscriptItem::Assistant {
            blocks,
            has_tool_calls,
        }, TranscriptItem::ToolCall { name, .. }] = items.as_slice()
        else {
            panic!("replay items: {items:?}");
        };
        assert_eq!(
            blocks,
            &vec![
                crate::chat::MessageBlock::Thinking("probe the replay trace".to_string()),
                crate::chat::MessageBlock::Text("body after thinking".to_string()),
            ]
        );
        assert!(has_tool_calls);
        assert_eq!(name, "bash");
    }

    #[test]
    fn thinking_signature_round_trips_through_the_file_entry() {
        // The persisted thinking block's provider signature survives the
        // replay round-trip verbatim, so a resumed session can replay its
        // reasoning context to the provider unchanged.
        let line = r#"{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"keep my signature","thinkingSignature":"sig-abc","redacted":false},{"type":"text","text":"done"}],"api":"openai-completions","provider":"prime-inference","model":"m","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1},"id":"e1"}"#;
        let entries = parse_jsonl(line).unwrap();
        let wire = serde_json::to_string(&entries[0]).unwrap();
        let reloaded: FileEntry = serde_json::from_str(&wire).unwrap();
        let rewire = serde_json::to_string(&reloaded).unwrap();
        let FileEntry::Message { message, .. } = reloaded else {
            panic!("reloaded: {reloaded:?}");
        };
        let AgentMessage::Assistant(assistant) = message else {
            panic!("message: {message:?}");
        };
        let thinking = assistant
            .content
            .iter()
            .find_map(|block| match block {
                pa_types::ai::AssistantContentBlock::Thinking(t) => Some(t),
                _ => None,
            })
            .expect("thinking block survives the round-trip");
        assert_eq!(thinking.thinking, "keep my signature");
        assert_eq!(thinking.thinking_signature.as_deref(), Some("sig-abc"));
        // The re-serialized wire keeps the signature key (computed before
        // the destructure moves the entry): the replay feeds the provider
        // the same reasoning context it produced.
        assert!(
            rewire.contains("\"thinkingSignature\":\"sig-abc\""),
            "wire: {rewire}"
        );
    }

    #[test]
    fn loads_real_session() {
        let dir = std::path::Path::new("/home/ubuntu/.prime/agent/sessions");
        if !dir.is_dir() {
            return; // sandbox without agent state
        }
        let mut loaded = 0;
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if parse_jsonl(&raw).is_ok() {
                    loaded += 1;
                }
            }
        }
        assert!(loaded > 0, "no sessions parsed");
    }
}
