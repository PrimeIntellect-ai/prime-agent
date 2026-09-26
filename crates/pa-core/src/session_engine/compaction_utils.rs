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
        "[... {char_count} characters truncated; first {max_chars} and last {TOOL_RESULT_TAIL_CHARS} kept ...]",
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
            .collect::<String>(),
    }
}

/// Serialize conversation messages to text so the model summarizes rather
/// than continues. Tool results are truncated.
///
/// Tool calls are serialized with a sequential `#N` prefix and results
/// repeat the matching index, so repeated calls of the same tool pair
/// unambiguously (TS #2424).
pub fn serialize_conversation(messages: &[AgentMessage]) -> String {
    let mut parts: Vec<String> = Vec::new();
    // Tool calls are serialized with a 1-based sequential index and
    // results repeat the index of their call (matched by tool call id),
    // so repeated calls of the same tool pair unambiguously in the
    // summarizer input. The short index stands in for the raw provider
    // tool call id, which can exceed 450 characters on some providers.
    let mut tool_call_indices: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut tool_call_index: usize = 0;
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
                            tool_call_index += 1;
                            tool_call_indices.insert(call.id.clone(), tool_call_index);
                            tool_calls.push(format!("#{tool_call_index} {}({args})", call.name));
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
                    .collect::<String>();
                if !content.is_empty() {
                    // Label the tool name, error status, and the index of
                    // the paired call so the summarizer can match each
                    // result to its `#N`-prefixed entry in the [Assistant
                    // tool calls] lines even when the same tool is called
                    // repeatedly in one turn. Results whose call is not
                    // part of the input (extension callers may pass
                    // partial message lists) fall back to the name-only
                    // label.
                    let index_suffix = tool_call_indices
                        .get(&result.tool_call_id)
                        .map(|index| format!(" #{index}"))
                        .unwrap_or_default();
                    let label = if result.is_error {
                        format!("[Tool result ({}, error){index_suffix}]", result.tool_name)
                    } else {
                        format!("[Tool result ({}){index_suffix}]", result.tool_name)
                    };
                    parts.push(format!(
                        "{label}: {}",
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
            rest: serde_json::Map::default(),
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
                    rest: serde_json::Map::default(),
                }),
                pa_types::ai::AssistantContentBlock::ToolCall(pa_types::ai::ToolCall {
                    id: "tc1".to_string(),
                    name: "edit".to_string(),
                    arguments,
                    thought_signature: None,
                    rest: serde_json::Map::default(),
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
            rest: serde_json::Map::default(),
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
            rest: serde_json::Map::default(),
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
        assert!(text.contains("[Assistant tool calls]: #1 edit(path=\"/src/main.rs\")"));
    }

    fn tool_result(
        text: &str,
        tool_name: &str,
        is_error: bool,
        tool_call_id: &str,
    ) -> AgentMessage {
        AgentMessage::ToolResult(pa_types::ai::ToolResultMessage {
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            content: vec![pa_types::ai::UserContentBlock::Text(
                pa_types::ai::TextContent {
                    text: text.to_string(),
                    text_signature: None,
                    rest: serde_json::Map::default(),
                },
            )],
            details: None,
            is_error,
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    }

    fn assistant_with_tool_calls(calls: &[(&str, &str, &str)]) -> AgentMessage {
        AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: calls
                .iter()
                .map(|(id, name, code)| {
                    let mut arguments = serde_json::Map::new();
                    arguments.insert("code".to_string(), serde_json::json!(code));
                    pa_types::ai::AssistantContentBlock::ToolCall(pa_types::ai::ToolCall {
                        id: id.to_string(),
                        name: name.to_string(),
                        arguments,
                        thought_signature: None,
                        rest: serde_json::Map::default(),
                    })
                })
                .collect(),
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
            rest: serde_json::Map::default(),
        })
    }

    /// Short success results label with the tool name (TS #2424:
    /// `[Tool result (bash)]`), and error results mark the failure
    /// (`[Tool result (edit, error)]`).
    #[test]
    fn tool_result_labels_carry_the_tool_name_and_error_marker() {
        assert_eq!(
            serialize_conversation(std::slice::from_ref(&tool_result(
                "the output",
                "bash",
                false,
                "tc1"
            ))),
            "[Tool result (bash)]: the output"
        );
        assert_eq!(
            serialize_conversation(std::slice::from_ref(&tool_result(
                "the failure",
                "edit",
                true,
                "tc1"
            ))),
            "[Tool result (edit, error)]: the failure"
        );
    }

    /// Repeated calls of the same tool pair with their results through the
    /// sequential `#N` index on both the call and the result label, so the
    /// summarizer can match each result to its call by position (TS
    /// #2424's pairing fix).
    #[test]
    fn repeated_same_tool_calls_pair_by_index() {
        let messages = vec![
            assistant_with_tool_calls(&[("c1", "ipython", "a"), ("c2", "ipython", "b")]),
            tool_result("first output", "ipython", false, "c1"),
            tool_result("second output", "ipython", true, "c2"),
        ];
        let expected = [
            "[Assistant tool calls]: #1 ipython(code=\"a\"); #2 ipython(code=\"b\")",
            "[Tool result (ipython) #1]: first output",
            "[Tool result (ipython, error) #2]: second output",
        ]
        .join("\n\n");
        assert_eq!(serialize_conversation(&messages), expected);
    }

    /// A result whose call was not serialized (a partial message list from
    /// an extension caller) falls back to the name-only label (TS #2424's
    /// orphan arm).
    #[test]
    fn orphan_tool_result_falls_back_to_the_name_only_label() {
        let messages = vec![
            assistant_with_tool_calls(&[("c1", "bash", "ls")]),
            tool_result("orphan output", "ipython", false, "tc-orphan"),
        ];
        let expected = [
            "[Assistant tool calls]: #1 bash(code=\"ls\")",
            "[Tool result (ipython)]: orphan output",
        ]
        .join("\n\n");
        assert_eq!(serialize_conversation(&messages), expected);
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
                    rest: serde_json::Map::default(),
                },
            )],
            details: None,
            is_error: false,
            timestamp: 0,
            rest: serde_json::Map::default(),
        });
        let text = serialize_conversation(std::slice::from_ref(&result));
        assert!(text.contains("characters truncated; first"));
        assert!(text.contains("last 500 kept"));
        // The serialized result stays within the budget (plus markers).
        assert!(text.chars().count() < TOOL_RESULT_MAX_CHARS + 200);
    }
}
