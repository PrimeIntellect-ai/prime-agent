//! Branch summarization for tree navigation. Port of
//! core/compaction/branch-summarization.ts.

use std::collections::HashSet;

use pa_types::session::{AgentMessage, CompactionSummaryMessage, FileEntry};

use super::compaction::estimate_tokens;
use super::compaction_utils::{
    compute_file_lists, extract_file_ops_from_message, format_file_operations,
    serialize_conversation, FileOperations,
};
use super::messages::{convert_to_llm, BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX};

/// Details stored on a branch summary entry.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummaryDetails {
    pub read_files: Vec<String>,
    pub modified_files: Vec<String>,
}

/// The result of generating a branch summary.
#[derive(Debug, Default, Clone)]
pub struct BranchSummaryResult {
    pub summary: Option<String>,
    pub read_files: Vec<String>,
    pub modified_files: Vec<String>,
    pub aborted: bool,
    pub error: Option<String>,
    pub usage: Option<pa_types::ai::Usage>,
}

/// Prepared summarization inputs.
#[derive(Debug, Default)]
pub struct BranchPreparation {
    pub messages: Vec<AgentMessage>,
    pub file_ops: FileOperations,
    pub total_tokens: u64,
}

/// Entry-path info between two tree positions.
#[derive(Debug, Default)]
pub struct CollectEntriesResult {
    pub entries: Vec<FileEntry>,
    pub common_ancestor_id: Option<String>,
}

fn parent_path(entries: &[FileEntry], leaf_id: &str) -> Vec<String> {
    let mut path = Vec::new();
    let mut current = Some(leaf_id.to_string());
    while let Some(id) = current {
        let Some(entry) = entries.iter().find(|entry| entry.id() == Some(id.as_str())) else {
            break;
        };
        path.push(id.clone());
        current = entry.parent_id().map(str::to_string);
    }
    path
}

/// Entries to summarize when navigating old-leaf -> target: the old path back
/// to (excluding) the common ancestor with the target path.
pub fn collect_entries_for_branch_summary(
    entries: &[FileEntry],
    old_leaf_id: Option<&str>,
    target_id: &str,
) -> CollectEntriesResult {
    let Some(old_leaf_id) = old_leaf_id else {
        return CollectEntriesResult::default();
    };
    let old_path: HashSet<String> = parent_path(entries, old_leaf_id).into_iter().collect();
    let target_path = parent_path(entries, target_id);
    let common_ancestor_id = target_path
        .iter()
        .rev()
        .find(|id| old_path.contains(*id))
        .cloned();
    let mut collected: Vec<FileEntry> = Vec::new();
    let mut current = Some(old_leaf_id.to_string());
    while let Some(id) = current {
        if Some(&id) == common_ancestor_id.as_ref() {
            break;
        }
        let Some(entry) = entries
            .iter()
            .find(|entry| entry.id() == Some(id.as_str()))
            .cloned()
        else {
            break;
        };
        current = entry.parent_id().map(str::to_string);
        collected.push(entry);
    }
    collected.reverse();
    CollectEntriesResult {
        entries: collected,
        common_ancestor_id,
    }
}

/// The message an entry contributes to summarizer input (compaction entries
/// become their summary message; bookkeeping entries contribute nothing).
fn get_message_from_entry(entry: &FileEntry) -> Option<AgentMessage> {
    match entry {
        FileEntry::Message { message, .. } => match message {
            // Tool results stay attached to their assistant tool call.
            AgentMessage::ToolResult(_) => None,
            _ => Some(message.clone()),
        },
        FileEntry::CustomMessage { payload, .. } => {
            if payload.custom_type == "harness_digest" {
                return None;
            }
            Some(AgentMessage::Custom(pa_types::session::CustomMessage {
                custom_type: payload.custom_type.clone(),
                content: payload.content.clone(),
                display: payload.display,
                details: payload.details.clone(),
                timestamp: super::super::session::timestamp_to_millis(entry.timestamp()),
                rest: Default::default(),
            }))
        }
        FileEntry::BranchSummary { payload, .. } => Some(AgentMessage::BranchSummary(
            pa_types::session::BranchSummaryMessage {
                summary: payload.summary.clone(),
                from_id: payload.from_id.clone(),
                timestamp: super::super::session::timestamp_to_millis(entry.timestamp()),
            },
        )),
        FileEntry::Compaction { payload, .. } => {
            Some(AgentMessage::CompactionSummary(CompactionSummaryMessage {
                summary: payload.summary.clone(),
                tokens_before: payload.tokens_before,
                retained_message_count: None,
                custom_instructions: payload.custom_instructions.clone(),
                harness_digest: payload.harness_digest.clone(),
                timestamp: super::super::session::timestamp_to_millis(entry.timestamp()),
            }))
        }
        _ => None,
    }
}

/// Prepare entries under a token budget: newest-to-oldest until the budget
/// is hit. File ops are collected from ALL entries (cumulative tracking).
pub fn prepare_branch_entries(entries: &[FileEntry], token_budget: u64) -> BranchPreparation {
    let mut file_ops = FileOperations::default();
    // Cumulative tracking from prior branch summaries (never extension ones).
    for entry in entries {
        if let FileEntry::BranchSummary { payload, .. } = entry {
            if payload.from_hook != Some(true) {
                if let Some(details) = payload.details.clone() {
                    if let Ok(details) = serde_json::from_value::<BranchSummaryDetails>(details) {
                        file_ops.read.extend(details.read_files);
                        file_ops.edited.extend(details.modified_files);
                    }
                }
            }
        }
    }
    let mut messages: Vec<AgentMessage> = Vec::new();
    let mut total_tokens = 0u64;
    for entry in entries.iter().rev() {
        let Some(message) = get_message_from_entry(entry) else {
            continue;
        };
        extract_file_ops_from_message(&message, &mut file_ops);
        let tokens = estimate_tokens(&message);
        if token_budget > 0 && total_tokens + tokens > token_budget {
            // Compaction/branch summaries squeeze in under 90% budget.
            let boundary = matches!(
                entry,
                FileEntry::Compaction { .. } | FileEntry::BranchSummary { .. }
            );
            if boundary && total_tokens < token_budget * 9 / 10 {
                messages.insert(0, message);
                total_tokens += tokens;
            }
            break;
        }
        messages.insert(0, message);
        total_tokens += tokens;
    }
    BranchPreparation {
        messages,
        file_ops,
        total_tokens,
    }
}

const BRANCH_SUMMARY_PREAMBLE: &str = "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n";

const BRANCH_SUMMARY_PROMPT: &str = "Create a structured summary of this conversation branch for context when returning later.\n\nUse this EXACT format:\n\n## Goal\n[What was the user trying to accomplish in this branch?]\n\n## Constraints & Preferences\n- [Any constraints, preferences, or requirements mentioned]\n- [Or \"(none)\" if none were mentioned]\n\n## Progress\n### Done\n- [x] [Completed tasks/changes]\n\n### In Progress\n- [ ] [Work that was started but not finished]\n\n### Blocked\n- [Issues preventing progress, if any]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale]\n\n## Next Steps\n1. [What should happen next to continue this work]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.";

/// Build the branch-summary request messages for the model.
pub fn build_branch_summary_request(
    entries: &[FileEntry],
    token_budget: u64,
    custom_instructions: Option<&str>,
    replace_instructions: bool,
) -> (Vec<AgentMessage>, BranchPreparation) {
    let preparation = prepare_branch_entries(entries, token_budget);
    let messages = if preparation.messages.is_empty() {
        Vec::new()
    } else {
        let llm_messages = convert_to_llm(&preparation.messages);
        let conversation_text = serialize_conversation(&llm_messages);
        let instructions = match (replace_instructions, custom_instructions) {
            (true, Some(custom)) => custom.to_string(),
            (false, Some(custom)) => {
                format!("{BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: {custom}")
            }
            _ => BRANCH_SUMMARY_PROMPT.to_string(),
        };
        let prompt_text =
            format!("<conversation>\n{conversation_text}\n</conversation>\n\n{instructions}");
        vec![AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text(prompt_text),
            timestamp: 0,
            rest: Default::default(),
        })]
    };
    (messages, preparation)
}

/// Assemble the final summary text from a model response.
pub fn finalize_branch_summary(
    response_text: &str,
    preparation: &BranchPreparation,
) -> BranchSummaryResult {
    let (read_files, modified_files) = compute_file_lists(&preparation.file_ops);
    let mut summary = format!("{BRANCH_SUMMARY_PREAMBLE}{response_text}");
    summary.push_str(&format_file_operations(&read_files, &modified_files));
    BranchSummaryResult {
        summary: Some(if summary.is_empty() {
            "No summary generated".to_string()
        } else {
            summary
        }),
        read_files,
        modified_files,
        aborted: false,
        error: None,
        usage: None,
    }
}

/// Options for one branch-summary generation run (TS
/// `GenerateBranchSummaryOptions`).
pub struct GenerateBranchSummaryOptions<'a> {
    pub model: &'a pa_types::ai::Model,
    pub api_key: Option<String>,
    pub custom_instructions: Option<&'a str>,
    /// Replace the default prompt instead of appending the custom focus.
    pub replace_instructions: bool,
    /// Tokens reserved for prompt + response (TS default 16384).
    pub reserve_tokens: u64,
}

/// The TS default reserve budget (`reserveTokens`).
pub const DEFAULT_BRANCH_RESERVE_TOKENS: u64 = 16_384;

/// The summarizer call cap (TS `maxTokens: 2048`).
const BRANCH_SUMMARY_MAX_TOKENS: u64 = 2048;

/// Generate the abandoned-branch summary (TS `generateBranchSummary`):
/// prepare the entries under the context budget, run the summarizer with
/// the shared provider-retry policy, and fold the response into the final
/// summary text with its file-operation block.
pub async fn generate_branch_summary(
    entries: &[FileEntry],
    options: GenerateBranchSummaryOptions<'_>,
) -> BranchSummaryResult {
    let GenerateBranchSummaryOptions {
        model,
        api_key,
        custom_instructions,
        replace_instructions,
        reserve_tokens,
    } = options;
    let context_window = if model.context_window > 0 {
        model.context_window
    } else {
        128_000
    };
    let token_budget = context_window.saturating_sub(reserve_tokens);
    let (request_messages, preparation) = build_branch_summary_request(
        entries,
        token_budget,
        custom_instructions,
        replace_instructions,
    );
    // Nothing model-visible remains after filtering.
    if request_messages.is_empty() {
        let (read_files, modified_files) = compute_file_lists(&preparation.file_ops);
        return BranchSummaryResult {
            summary: Some("No content to summarize".to_string()),
            read_files,
            modified_files,
            ..Default::default()
        };
    }
    // The summarizer call follows the compaction precedent
    // (`execute_compaction`): one `complete_simple` on the session model.
    let context = pa_types::ai::Context {
        system_prompt: Some(super::compaction_utils::SUMMARIZATION_SYSTEM_PROMPT.to_string()),
        messages: convert_to_llm(&request_messages)
            .into_iter()
            .filter_map(|message| match message {
                AgentMessage::User(user) => {
                    Some(pa_types::ai::Message::User(pa_types::ai::UserMessage {
                        content: user.content,
                        timestamp: user.timestamp,
                        rest: user.rest,
                    }))
                }
                _ => None,
            })
            .collect(),
        tools: None,
    };
    let stream_options =
        pa_ai::types::SimpleStreamOptions::from_base(pa_ai::types::StreamOptions {
            max_tokens: Some(BRANCH_SUMMARY_MAX_TOKENS),
            api_key,
            ..Default::default()
        });
    let response = match pa_ai::complete_simple(model, &context, Some(stream_options)).await {
        Ok(response) => response,
        Err(error) => {
            return BranchSummaryResult {
                error: Some(format!("{error:#}")),
                ..Default::default()
            }
        }
    };
    if response.stop_reason == pa_types::ai::StopReason::Aborted {
        return BranchSummaryResult {
            aborted: true,
            ..Default::default()
        };
    }
    if response.stop_reason == pa_types::ai::StopReason::Error {
        return BranchSummaryResult {
            error: Some(
                response
                    .error_message
                    .unwrap_or_else(|| "Summarization failed".to_string()),
            ),
            ..Default::default()
        };
    }
    let response_text = response
        .content
        .iter()
        .filter_map(|block| match block {
            pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut result = finalize_branch_summary(&response_text, &preparation);
    result.usage = (response.usage.total_tokens > 0).then_some(response.usage);
    result
}

/// The presentation message users see for a branch summary.
pub fn branch_summary_presentation(summary: &str) -> String {
    format!("{BRANCH_SUMMARY_PREFIX}{summary}{BRANCH_SUMMARY_SUFFIX}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::session::EntryBase;

    fn entry(id: &str, parent: Option<&str>, message: AgentMessage) -> FileEntry {
        FileEntry::Message {
            message,
            base: EntryBase {
                id: Some(id.to_string()),
                parent_id: parent.map(str::to_string),
                timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
                rest: Default::default(),
            },
        }
    }

    fn user(text: &str) -> AgentMessage {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: Default::default(),
        })
    }

    #[test]
    fn collects_old_branch_to_common_ancestor() {
        // root -> u1 -> a1 -> u2 (old leaf)
        //        \\-> u3 (target, sibling of a1's subtree? no: sibling of u1's children)
        let entries = vec![
            entry("u1", None, user("start")),
            entry("a1", Some("u1"), user("assistant turn")),
            entry("u2", Some("a1"), user("old leaf")),
            entry("u3", Some("u1"), user("target")),
        ];
        let result = collect_entries_for_branch_summary(&entries, Some("u2"), "u3");
        assert_eq!(result.common_ancestor_id.as_deref(), Some("u1"));
        // u2 and a1 are collected (target ancestor excluded).
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].id(), Some("a1"));
        assert_eq!(result.entries[1].id(), Some("u2"));
    }

    #[test]
    fn preparation_respects_budget_and_keeps_boundaries() {
        let mut entries = Vec::new();
        for i in 0..10 {
            entries.push(entry(
                &format!("e{i}"),
                None,
                user(&format!("message {i} with padding")),
            ));
        }
        // Each message estimates to ~6 tokens; a 6-token budget keeps only
        // the newest one before the walk breaks.
        let preparation = prepare_branch_entries(&entries, 6);
        assert_eq!(preparation.messages.len(), 1);
        // A budget below any single message keeps nothing.
        let tight = prepare_branch_entries(&entries, 1);
        assert_eq!(tight.messages.len(), 0);
        let unlimited = prepare_branch_entries(&entries, 0);
        assert_eq!(unlimited.messages.len(), 10);
    }

    #[test]
    fn request_and_finalize() {
        let entries = vec![entry("e0", None, user("explore the widget"))];
        let (messages, preparation) =
            build_branch_summary_request(&entries, 0, Some("focus on x"), false);
        assert_eq!(messages.len(), 1);
        match &messages[0] {
            AgentMessage::User(user) => {
                let text = user.content.text();
                assert!(text.starts_with("<conversation>"));
                assert!(text.contains("Additional focus: focus on x"));
            }
            _ => panic!("expected user"),
        }
        let result = finalize_branch_summary("## Goal\nexplore", &preparation);
        let summary = result.summary.unwrap();
        assert!(summary.contains("The user explored a different conversation branch"));
        assert!(summary.contains("## Goal"));
        // Presentation wraps in the branch envelope.
        assert!(branch_summary_presentation("s").contains("[branch-summary]"));
    }

    #[test]
    fn compaction_entries_become_summary_messages() {
        let compaction = FileEntry::Compaction {
            payload: pa_types::session::CompactionEntry {
                summary: "prior state".to_string(),
                first_kept_entry_id: "x".to_string(),
                tokens_before: 10,
                details: None,
                from_hook: None,
                custom_instructions: None,
                usage: None,
                harness_digest: None,
            },
            base: EntryBase {
                id: Some("c0".to_string()),
                parent_id: None,
                timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
                rest: Default::default(),
            },
        };
        let message = get_message_from_entry(&compaction).unwrap();
        match message {
            AgentMessage::CompactionSummary(summary) => {
                assert_eq!(summary.summary, "prior state");
                assert_eq!(summary.tokens_before, 10);
            }
            _ => panic!("expected compaction summary"),
        }
    }

    #[tokio::test]
    async fn generates_summary_through_the_faux_provider() {
        // One faux provider per test (a process-global registry); the
        // guard is released before the awaited model call.
        static FAUX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let registration = {
            let _guard = FAUX_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            pa_ai::faux::register_faux_provider(Default::default())
        };
        let model = registration.get_model();
        let response = pa_ai::faux::faux_assistant_text_message(
            "## Goal\nexplore the tree",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        );
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(response)]);
        let entries = vec![entry("e0", None, user("explore the widget"))];
        let result = generate_branch_summary(
            &entries,
            GenerateBranchSummaryOptions {
                model: &model,
                api_key: None,
                custom_instructions: Some("focus on x"),
                replace_instructions: false,
                reserve_tokens: DEFAULT_BRANCH_RESERVE_TOKENS,
            },
        )
        .await;
        assert!(!result.aborted, "not aborted");
        assert!(result.error.is_none(), "error: {:?}", result.error);
        let summary = result.summary.expect("summary text");
        assert!(
            summary.starts_with("The user explored a different conversation branch"),
            "preamble present: {summary}"
        );
        assert!(summary.contains("## Goal"));
        registration.unregister();
    }

    #[tokio::test]
    async fn empty_branch_summarizes_to_a_note() {
        // No messages survive the budget filter: the TS short-circuit
        // returns "No content to summarize" without a model call.
        let model: pa_types::ai::Model = serde_json::from_value(serde_json::json!({
            "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
            "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100
        }))
        .unwrap();
        let result = generate_branch_summary(
            &[],
            GenerateBranchSummaryOptions {
                model: &model,
                api_key: None,
                custom_instructions: None,
                replace_instructions: false,
                reserve_tokens: DEFAULT_BRANCH_RESERVE_TOKENS,
            },
        )
        .await;
        assert_eq!(result.summary.as_deref(), Some("No content to summarize"));
        assert!(!result.aborted);
        assert!(result.error.is_none());
    }
}
