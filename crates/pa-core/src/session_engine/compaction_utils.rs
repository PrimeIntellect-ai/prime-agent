//! Compaction/branch-summarization utilities: file-operation tracking and
//! conversation serialization. Port of core/compaction/utils.ts.

use std::collections::BTreeSet;

use pa_types::session::AgentMessage;

/// File operations extracted from tool calls and results.
#[derive(Debug, Default, Clone)]
pub struct FileOperations {
    pub read: BTreeSet<String>,
    pub written: BTreeSet<String>,
    pub edited: BTreeSet<String>,
}

/// Maximum files kept per summary block.
const FILE_LIST_MAX_ENTRIES: usize = 200;
/// Maximum characters for a serialized tool result.
const TOOL_RESULT_MAX_CHARS: usize = 2_000;
/// Characters kept from the end of a truncated tool result.
const TOOL_RESULT_TAIL_CHARS: usize = 500;

/// Extract file ops from an assistant tool call (edit paths) or a tool
/// result (kernel edit-skill diffs in `details`).
pub fn extract_file_ops_from_message(message: &AgentMessage, file_ops: &mut FileOperations) {
    match message {
        AgentMessage::ToolResult(result) => {
            if result.tool_name != "ipython" {
                return;
            }
            let Some(details) = result.details.as_ref().and_then(|d| d.as_object()) else {
                return;
            };
            let Some(diffs) = details.get("diffs").and_then(|d| d.as_array()) else {
                return;
            };
            for diff in diffs {
                if let Some(path) = diff.get("path").and_then(|p| p.as_str()) {
                    if !path.is_empty() {
                        file_ops.edited.insert(path.to_string());
                    }
                }
            }
        }
        AgentMessage::Assistant(assistant) => {
            for block in &assistant.content {
                let pa_types::ai::AssistantContentBlock::ToolCall(call) = block else {
                    continue;
                };
                let Some(path) = call.arguments.get("path").and_then(|p| p.as_str()) else {
                    continue;
                };
                if call.name == "edit" {
                    file_ops.edited.insert(path.to_string());
                }
            }
        }
        _ => {}
    }
}

/// Final file lists: read-only files and modified files, sorted and capped.
pub fn compute_file_lists(file_ops: &FileOperations) -> (Vec<String>, Vec<String>) {
    let mut modified: BTreeSet<String> = file_ops.edited.clone();
    modified.extend(file_ops.written.iter().cloned());
    let read_only: Vec<String> = file_ops
        .read
        .iter()
        .filter(|path| !modified.contains(*path))
        .take(FILE_LIST_MAX_ENTRIES)
        .cloned()
        .collect();
    let modified_files: Vec<String> = modified.into_iter().take(FILE_LIST_MAX_ENTRIES).collect();
    (read_only, modified_files)
}

/// Format file lists as XML tags (empty when no files).
pub fn format_file_operations(read_files: &[String], modified_files: &[String]) -> String {
    let mut sections = Vec::new();
    if !read_files.is_empty() {
        sections.push(format!(
            "<read-files>\n{}\n</read-files>",
            read_files.join("\n")
        ));
    }
    if !modified_files.is_empty() {
        sections.push(format!(
            "<modified-files>\n{}\n</modified-files>",
            modified_files.join("\n")
        ));
    }
    if sections.is_empty() {
        return String::new();
    }
    format!("\n\n{}", sections.join("\n\n"))
}

/// Truncate keeping head and tail within the budget, marking the elision.
fn truncate_for_summary(text: &str, max_chars: usize) -> String {
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let marker = format!(
        "[... {} characters truncated; first {} and last {} kept ...]",
        char_count, max_chars, TOOL_RESULT_TAIL_CHARS
    );
    let marker_max = marker.chars().count();
    let head_chars = max_chars.saturating_sub(TOOL_RESULT_TAIL_CHARS + marker_max + 4);
    let elided = char_count - head_chars - TOOL_RESULT_TAIL_CHARS;
    let head: String = chars[..head_chars].iter().collect();
    let tail: String = chars[char_count - TOOL_RESULT_TAIL_CHARS..]
        .iter()
        .collect();
    format!("{head}\n\n[... {elided} characters truncated; first {head_chars} and last {TOOL_RESULT_TAIL_CHARS} kept ...]\n\n{tail}")
}

fn user_text(content: &pa_types::ai::UserContent) -> String {
    match content {
        pa_types::ai::UserContent::Text(text) => text.clone(),
        pa_types::ai::UserContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                pa_types::ai::UserContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

/// Serialize conversation messages to text so the model summarizes rather
/// than continues. Tool results are truncated.
pub fn serialize_conversation(messages: &[AgentMessage]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for message in messages {
        match message {
            AgentMessage::User(user) => {
                let content = user_text(&user.content);
                if !content.is_empty() {
                    parts.push(format!("[User]: {content}"));
                }
            }
            AgentMessage::Assistant(assistant) => {
                let mut text_parts: Vec<String> = Vec::new();
                let mut thinking_parts: Vec<String> = Vec::new();
                let mut tool_calls: Vec<String> = Vec::new();
                for block in &assistant.content {
                    match block {
                        pa_types::ai::AssistantContentBlock::Text(text) => {
                            text_parts.push(text.text.clone());
                        }
                        pa_types::ai::AssistantContentBlock::Thinking(thinking) => {
                            thinking_parts.push(thinking.thinking.clone());
                        }
                        pa_types::ai::AssistantContentBlock::ToolCall(call) => {
                            let args = call
                                .arguments
                                .iter()
                                .map(|(key, value)| {
                                    format!(
                                        "{key}={}",
                                        serde_json::to_value(value).unwrap_or_default()
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join(", ");
                            tool_calls.push(format!("{}({args})", call.name));
                        }
                    }
                }
                if !thinking_parts.is_empty() {
                    parts.push(format!(
                        "[Assistant thinking]: {}",
                        thinking_parts.join("\n")
                    ));
                }
                if !text_parts.is_empty() {
                    parts.push(format!("[Assistant]: {}", text_parts.join("\n")));
                }
                if !tool_calls.is_empty() {
                    parts.push(format!("[Assistant tool calls]: {}", tool_calls.join("; ")));
                }
            }
            AgentMessage::ToolResult(result) => {
                let content: String = result
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        pa_types::ai::UserContentBlock::Text(text) => Some(text.text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                if !content.is_empty() {
                    parts.push(format!(
                        "[Tool result]: {}",
                        truncate_for_summary(&content, TOOL_RESULT_MAX_CHARS)
                    ));
                }
            }
            AgentMessage::Custom(custom) => {
                let content = user_text(&custom.content);
                if !content.is_empty() {
                    parts.push(format!("[Custom]: {content}"));
                }
            }
            AgentMessage::BashExecution(bash) => {
                parts.push(format!("[Bash execution]: {}", bash.command));
            }
            AgentMessage::BranchSummary(summary) => {
                parts.push(format!("[Branch summary]: {}", summary.summary));
            }
            AgentMessage::CompactionSummary(summary) => {
                parts.push(format!("[Compaction summary]: {}", summary.summary));
            }
        }
    }
    parts.join("\n\n")
}

/// The summarizer's system prompt.
pub const SUMMARIZATION_SYSTEM_PROMPT: &str = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str) -> AgentMessage {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: Default::default(),
        })
    }

    fn assistant_with_tool_call() -> AgentMessage {
        let mut arguments = serde_json::Map::new();
        arguments.insert("path".to_string(), serde_json::json!("/src/main.rs"));
        AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: vec![
                pa_types::ai::AssistantContentBlock::Text(pa_types::ai::TextContent {
                    text: "doing it".to_string(),
                    text_signature: None,
                    rest: Default::default(),
                }),
                pa_types::ai::AssistantContentBlock::ToolCall(pa_types::ai::ToolCall {
                    id: "tc1".to_string(),
                    name: "edit".to_string(),
                    arguments,
                    thought_signature: None,
                    rest: Default::default(),
                }),
            ],
            api: "openai-completions".to_string(),
            provider: "p".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::ToolUse,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Default::default(),
        })
    }

    #[test]
    fn file_ops_from_edit_tool_call() {
        let mut ops = FileOperations::default();
        let message = assistant_with_tool_call();
        extract_file_ops_from_message(&message, &mut ops);
        assert!(ops.edited.contains("/src/main.rs"));
        let (read, modified) = compute_file_lists(&ops);
        assert!(read.is_empty());
        assert_eq!(modified, vec!["/src/main.rs".to_string()]);
        assert!(format_file_operations(&read, &modified).contains("<modified-files>"));
    }

    #[test]
    fn file_ops_from_kernel_diffs() {
        let mut ops = FileOperations::default();
        ops.read.insert("/tmp/other.rs".to_string());
        let result = AgentMessage::ToolResult(pa_types::ai::ToolResultMessage {
            tool_call_id: "c".to_string(),
            tool_name: "ipython".to_string(),
            content: vec![],
            details: Some(serde_json::json!({
                "diffs": [{ "path": "/pkg/lib.rs", "oldStr": "a", "newStr": "b" }]
            })),
            is_error: false,
            timestamp: 0,
            rest: Default::default(),
        });
        extract_file_ops_from_message(&result, &mut ops);
        assert!(ops.edited.contains("/pkg/lib.rs"));
        let (read, modified) = compute_file_lists(&ops);
        // Read-only list excludes modified files.
        assert!(read.iter().all(|path| !modified.contains(path)));
    }

    #[test]
    fn serialization_format() {
        let messages = vec![user("do the thing"), assistant_with_tool_call()];
        let text = serialize_conversation(&messages);
        assert!(text.starts_with("[User]: do the thing"));
        assert!(text.contains("[Assistant]: doing it"));
    }

    #[test]
    fn tool_result_truncated() {
        let long = "x".repeat(10_000);
        let result = AgentMessage::ToolResult(pa_types::ai::ToolResultMessage {
            tool_call_id: "c".to_string(),
            tool_name: "bash".to_string(),
            content: vec![pa_types::ai::UserContentBlock::Text(
                pa_types::ai::TextContent {
                    text: long,
                    text_signature: None,
                    rest: Default::default(),
                },
            )],
            details: None,
            is_error: false,
            timestamp: 0,
            rest: Default::default(),
        });
        let text = serialize_conversation(std::slice::from_ref(&result));
        assert!(text.contains("characters truncated; first"));
        assert!(text.contains("last 500 kept"));
        // The serialized result stays within the budget (plus markers).
        assert!(text.chars().count() < TOOL_RESULT_MAX_CHARS + 200);
    }
}
