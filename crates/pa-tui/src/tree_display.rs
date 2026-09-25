//! Tree-entry display text: one flat row's content (TS
//! `TreeList.getEntryDisplayText` and the search text over the same data).

use std::collections::HashMap;

use crate::theme::{Theme, ThemeColor};
use crate::Line;
use pa_types::session::{AgentMessage, FileEntry};
use serde_json::Value;

use crate::tree_nodes::TreeNodeData;

/// Tool-call info collected from assistant messages (tree tool-result rows
/// render the originating call).
#[derive(Debug, Clone)]
pub struct ToolCallInfo {
    pub name: String,
    pub arguments: Value,
}

/// Collect tool calls from assistant message entries.
pub fn collect_tool_calls(entries: &[TreeNodeData]) -> HashMap<String, ToolCallInfo> {
    let mut calls = HashMap::new();
    for node in entries {
        if let FileEntry::Message {
            message: AgentMessage::Assistant(assistant),
            ..
        } = &node.entry
        {
            for block in &assistant.content {
                if let pa_types::ai::AssistantContentBlock::ToolCall(call) = block {
                    calls.insert(
                        call.id.clone(),
                        ToolCallInfo {
                            name: call.name.clone(),
                            arguments: serde_json::to_value(&call.arguments).unwrap_or(Value::Null),
                        },
                    );
                }
            }
        }
    }
    calls
}

/// Collapse whitespace like the TS normalize (newlines and tabs to spaces).
fn normalize(s: &str) -> String {
    s.replace(['\n', '\t'], " ").trim().to_string()
}

/// Text content of a message, capped (TS `extractContent`, 200 chars).
fn extract_content(content: &pa_types::ai::UserContent) -> String {
    let text = match content {
        pa_types::ai::UserContent::Text(text) => text.clone(),
        pa_types::ai::UserContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                pa_types::ai::UserContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect(),
    };
    text.chars().take(200).collect()
}

/// Assistant text content (TS `hasTextContent`/`extractContent` pair).
pub fn assistant_text(message: &pa_types::ai::AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Whether an assistant message carries text (the default filter keeps it).
pub fn assistant_has_text(message: &pa_types::ai::AssistantMessage) -> bool {
    !assistant_text(message).trim().is_empty()
}

/// The user text of a message entry (TS `_extractUserMessageText`).
pub fn user_entry_text(entry: &FileEntry) -> Option<String> {
    match entry {
        FileEntry::Message {
            message: AgentMessage::User(user),
            ..
        } => {
            let text = match &user.content {
                pa_types::ai::UserContent::Text(text) => text.clone(),
                pa_types::ai::UserContent::Blocks(blocks) => blocks
                    .iter()
                    .filter_map(|block| match block {
                        pa_types::ai::UserContentBlock::Text(text) => Some(text.text.clone()),
                        _ => None,
                    })
                    .collect::<String>(),
            };
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

/// One tool-call row: `[edit: ~/path]`, `[bash: cmd…]`, `[ipython: code…]`,
/// or the truncated-JSON fallback (TS `formatToolCall`).
fn format_tool_call(theme: &Theme, name: &str, arguments: &Value) -> Line {
    let shorten_path = |p: &str| -> String {
        if let Some(home) = std::env::var("HOME").ok().filter(|home| !home.is_empty()) {
            if let Some(rest) = p.strip_prefix(&home) {
                return format!("~{rest}");
            }
        }
        p.to_string()
    };
    let shorten = |raw: &str| -> String {
        let cleaned: String = raw
            .replace(['\n', '\t'], " ")
            .trim()
            .chars()
            .take(50)
            .collect();
        if cleaned.chars().count() < raw.trim().chars().count() {
            format!("{cleaned}...")
        } else {
            cleaned
        }
    };
    let arg = |key: &str| -> String {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let text = match name {
        "edit" => format!("[edit: {}]", shorten_path(&arg("path"))),
        "bash" => format!("[bash: {}]", shorten(&arg("command"))),
        "ipython" => format!("[ipython: {}]", shorten(&arg("code"))),
        _ => {
            let serialized = serde_json::to_string(arguments).unwrap_or_default();
            let truncated: String = serialized.chars().take(40).collect();
            if serialized.chars().count() > 40 {
                format!("[{name}: {truncated}...]")
            } else {
                format!("[{name}: {truncated}]")
            }
        }
    };
    vec![theme.fg_span(ThemeColor::Muted, text)]
}

/// The flat row's content spans (TS `getEntryDisplayText`).
pub fn entry_display_text(
    theme: &Theme,
    node: &TreeNodeData,
    tool_calls: &HashMap<String, ToolCallInfo>,
) -> Line {
    let color = |color: ThemeColor, text: String| theme.fg_span(color, text);
    let plain = |text: String| crate::Span::raw(text);
    let entry = &node.entry;
    let spans: Line = match entry {
        FileEntry::Message { message, .. } => match message {
            AgentMessage::User(user) => {
                let text = normalize(&extract_content(&user.content));
                vec![color(ThemeColor::Accent, "user: ".to_string()), plain(text)]
            }
            AgentMessage::Assistant(assistant) => {
                let text = normalize(&assistant_text(assistant));
                if !text.is_empty() {
                    vec![
                        color(ThemeColor::Success, "assistant: ".to_string()),
                        plain(text),
                    ]
                } else if assistant.stop_reason == pa_types::ai::StopReason::Aborted {
                    vec![
                        color(ThemeColor::Success, "assistant: ".to_string()),
                        color(ThemeColor::Muted, "(aborted)".to_string()),
                    ]
                } else if let Some(error) = &assistant.error_message {
                    let message: String = normalize(error).chars().take(80).collect();
                    vec![
                        color(ThemeColor::Success, "assistant: ".to_string()),
                        color(ThemeColor::Error, message),
                    ]
                } else {
                    vec![
                        color(ThemeColor::Success, "assistant: ".to_string()),
                        color(ThemeColor::Muted, "(no content)".to_string()),
                    ]
                }
            }
            AgentMessage::ToolResult(result) => {
                if let Some(call) = tool_calls.get(&result.tool_call_id) {
                    format_tool_call(theme, &call.name, &call.arguments)
                } else {
                    let name = if result.tool_name.is_empty() {
                        "tool".to_string()
                    } else {
                        result.tool_name.clone()
                    };
                    vec![color(ThemeColor::Muted, format!("[{name}]"))]
                }
            }
            AgentMessage::BashExecution(execution) => vec![color(
                ThemeColor::Dim,
                format!("[bash]: {}", normalize(&execution.command)),
            )],
            AgentMessage::Custom(custom) => vec![
                color(
                    ThemeColor::CustomMessageLabel,
                    format!("[{}]: ", custom.custom_type),
                ),
                plain(normalize(&extract_content(&custom.content))),
            ],
            AgentMessage::BranchSummary(summary) => vec![
                color(ThemeColor::Success, "assistant: ".to_string()),
                plain(normalize(&summary.summary)),
            ],
            AgentMessage::CompactionSummary(summary) => vec![
                color(ThemeColor::Success, "assistant: ".to_string()),
                plain(normalize(&summary.summary)),
            ],
        },
        FileEntry::CustomMessage { payload, .. } => {
            let text = extract_content(&payload.content);
            vec![
                color(
                    ThemeColor::CustomMessageLabel,
                    format!("[{}]: ", payload.custom_type),
                ),
                plain(normalize(&text)),
            ]
        }
        FileEntry::Compaction { payload, .. } => vec![color(
            ThemeColor::BorderAccent,
            format!("[compaction: {}k tokens]", payload.tokens_before / 1000),
        )],
        FileEntry::BranchSummary { payload, .. } => vec![
            color(ThemeColor::Warning, "[branch summary]: ".to_string()),
            plain(normalize(&payload.summary)),
        ],
        FileEntry::ModelChange { payload, .. } => vec![color(
            ThemeColor::Dim,
            format!("[model: {}]", payload.model_id),
        )],
        FileEntry::ThinkingLevelChange { payload, .. } => vec![color(
            ThemeColor::Dim,
            format!("[thinking: {}]", payload.thinking_level),
        )],
        FileEntry::ServiceTierChange { payload, .. } => vec![color(
            ThemeColor::Dim,
            format!(
                "[service tier: {}]",
                payload
                    .service_tier
                    .as_ref()
                    .map(tier_name)
                    .unwrap_or("default")
            ),
        )],
        FileEntry::Custom { payload, .. } => vec![color(
            ThemeColor::Dim,
            format!("[custom: {}]", payload.custom_type),
        )],
        FileEntry::ChildUsageAttributed { payload, .. } => {
            let input = payload.child_usage.input
                + payload.child_usage.cache_read
                + payload.child_usage.cache_write;
            let output = payload.child_usage.output;
            vec![color(
                ThemeColor::Dim,
                format!("[child usage: {input} input, {output} output]"),
            )]
        }
        FileEntry::Label { payload, .. } => vec![color(
            ThemeColor::Dim,
            format!(
                "[label: {}]",
                payload
                    .label
                    .clone()
                    .unwrap_or_else(|| "(cleared)".to_string())
            ),
        )],
        FileEntry::SessionInfo { payload, .. } => {
            let name = payload.name.clone().unwrap_or_else(|| "empty".to_string());
            vec![
                color(ThemeColor::Dim, "[title: ".to_string()),
                color(ThemeColor::Dim, name),
                color(ThemeColor::Dim, "]".to_string()),
            ]
        }
        FileEntry::Header { .. }
        | FileEntry::SessionState { .. }
        | FileEntry::GitState { .. }
        | FileEntry::Unknown { .. } => Vec::new(),
    };
    spans
}

fn tier_name(tier: &pa_types::ai::ServiceTier) -> &'static str {
    match tier {
        pa_types::ai::ServiceTier::Auto => "auto",
        pa_types::ai::ServiceTier::Default => "default",
        pa_types::ai::ServiceTier::Flex => "flex",
        pa_types::ai::ServiceTier::Scale => "scale",
        pa_types::ai::ServiceTier::Priority => "priority",
    }
}

/// The searchable text of one node (TS `getSearchableText`).
pub fn searchable_text(node: &TreeNodeData) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(label) = &node.label {
        parts.push(label.clone());
    }
    match &node.entry {
        FileEntry::Message { message, .. } => {
            let role = match message {
                AgentMessage::User(_) => "user".to_string(),
                AgentMessage::Assistant(_) => "assistant".to_string(),
                AgentMessage::ToolResult(result) => result.tool_name.clone(),
                AgentMessage::BashExecution(_) => "bashExecution".to_string(),
                AgentMessage::Custom(custom) => custom.custom_type.clone(),
                AgentMessage::BranchSummary(_) => "branchSummary".to_string(),
                AgentMessage::CompactionSummary(_) => "compactionSummary".to_string(),
            };
            parts.push(role);
            match message {
                AgentMessage::User(user) => parts.push(extract_content(&user.content)),
                AgentMessage::Assistant(assistant) => parts.push(assistant_text(assistant)),
                AgentMessage::Custom(custom) => parts.push(extract_content(&custom.content)),
                AgentMessage::BashExecution(execution) => parts.push(execution.command.clone()),
                _ => {}
            }
        }
        FileEntry::CustomMessage { payload, .. } => {
            parts.push(payload.custom_type.clone());
            parts.push(extract_content(&payload.content));
        }
        FileEntry::Compaction { .. } => parts.push("compaction".to_string()),
        FileEntry::BranchSummary { payload, .. } => {
            parts.push("branch summary".to_string());
            parts.push(payload.summary.clone());
        }
        FileEntry::SessionInfo { payload, .. } => {
            parts.push("title".to_string());
            parts.extend(payload.name.clone());
        }
        FileEntry::ModelChange { payload, .. } => {
            parts.push("model".to_string());
            parts.push(payload.model_id.clone());
        }
        FileEntry::ThinkingLevelChange { payload, .. } => {
            parts.push("thinking".to_string());
            parts.push(payload.thinking_level.clone());
        }
        FileEntry::ServiceTierChange { payload, .. } => {
            parts.push("service tier".to_string());
            parts.push(
                payload
                    .service_tier
                    .as_ref()
                    .map(tier_name)
                    .unwrap_or("default")
                    .to_string(),
            );
        }
        FileEntry::Custom { payload, .. } => {
            parts.push("custom".to_string());
            parts.push(payload.custom_type.clone());
        }
        FileEntry::ChildUsageAttributed { payload, .. } => {
            parts.push("child usage".to_string());
            parts.push(payload.target_id.clone());
        }
        FileEntry::Label { payload, .. } => {
            parts.push("label".to_string());
            parts.push(payload.label.clone().unwrap_or_default());
        }
        _ => {}
    }
    parts.join(" ")
}
