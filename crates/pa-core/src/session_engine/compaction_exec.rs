//! The compaction executor: assemble and run the summarization request.
//! Port of `compact()` in core/compaction/compaction.ts (summarizer call via
//! pa-ai's completion facade).

use super::compaction::{build_summarization_prompt, CutPointResult};
use super::compaction_utils::{
    compute_file_lists, extract_file_ops_from_message, format_file_operations, FileOperations,
};
use super::messages::convert_to_llm;
use pa_types::ai::{AssistantMessage, TextContent, UserContent, UserContentBlock, UserMessage};
use pa_types::session::{AgentMessage, CompactionEntry, FileEntry};
use std::fmt::Write as _;

/// Details stored on the compaction entry for file tracking.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionDetails {
    pub read_files: Vec<String>,
    pub modified_files: Vec<String>,
}

/// The result of running a compaction.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionResult {
    pub summary: String,
    pub first_kept_entry_id: String,
    pub tokens_before: u64,
    pub usage: Option<pa_types::ai::Usage>,
}

/// How the summarizer is invoked (test seam over pa-ai completion).
pub type SummarizerFn = Box<
    dyn FnOnce(
            pa_types::ai::Model,
            Vec<AgentMessage>,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = anyhow::Result<AssistantMessage>> + Send>,
        > + Send,
>;

/// Assemble the summarization messages for the conversation slice.
pub fn build_summarization_request(
    messages: &[AgentMessage],
    custom_instructions: Option<&str>,
    previous_summary: Option<&str>,
    #[allow(unused_variables)] reserve_tokens: u64,
) -> Vec<AgentMessage> {
    let llm_messages = convert_to_llm(messages);
    let conversation_text = super::compaction_utils::serialize_conversation(&llm_messages);
    let mut prompt_text = format!("<conversation>\n{conversation_text}\n</conversation>\n\n");
    if let Some(previous_summary) = previous_summary {
        let _ = write!(
            prompt_text,
            "<previous-summary>\n{previous_summary}\n</previous-summary>\n\n"
        );
    }
    prompt_text.push_str(&build_summarization_prompt(
        custom_instructions,
        previous_summary,
    ));
    vec![AgentMessage::User(UserMessage {
        content: UserContent::Blocks(vec![UserContentBlock::Text(TextContent {
            text: prompt_text,
            text_signature: None,
            rest: serde_json::Map::default(),
        })]),
        timestamp: 0,
        rest: serde_json::Map::default(),
    })]
}

/// One resolved summarizer wire call (TS `SummarySlice`): the summary text
/// and what the call billed. The no-history split arm has no wire call, so
/// its slice carries `usage: None`.
#[derive(Debug, Clone, PartialEq)]
pub struct SummarySlice {
    pub summary: String,
    pub usage: Option<pa_types::ai::Usage>,
}

/// The literal history stand-in for a split turn whose kept cut leaves no
/// history to summarize (TS `Promise.resolve({ summary: "No prior history." })`
/// — no wire call).
pub const NO_PRIOR_HISTORY: &str = "No prior history.";

/// The merged summary of a split turn (TS `compact`'s split join): the
/// history summary, the split marker, then the turn-prefix summary.
pub fn split_summary(history: &str, turn_prefix: &str) -> String {
    format!("{history}\n\n---\n\n**Turn Context (split turn):**\n\n{turn_prefix}")
}

/// The turn-prefix summarization request (TS `generateTurnPrefixSummary`):
/// the serialized prefix conversation under the turn-prefix instruction —
/// no custom instructions, no previous summary, no kernel note.
pub fn build_turn_prefix_request(messages: &[AgentMessage]) -> Vec<AgentMessage> {
    let llm_messages = convert_to_llm(messages);
    let conversation_text = super::compaction_utils::serialize_conversation(&llm_messages);
    let prompt_text = format!(
        "<conversation>\n{conversation_text}\n</conversation>\n\n{}",
        super::compaction::TURN_PREFIX_SUMMARIZATION_PROMPT
    );
    vec![AgentMessage::User(UserMessage {
        content: UserContent::Blocks(vec![UserContentBlock::Text(TextContent {
            text: prompt_text,
            text_signature: None,
            rest: serde_json::Map::default(),
        })]),
        timestamp: 0,
        rest: serde_json::Map::default(),
    })]
}

/// The live summary-delta sink (the daemon's `compaction_summary_delta`
/// broadcast seam): called with every text delta the summarizer model
/// streams, in arrival order, while the summary is being generated. The
/// compaction itself is unaffected — the sink is fire-and-forget, its
/// emissions never gate the run — and the final summary still comes
/// from the terminal assistant message, never from the sink's
/// accumulated text. A caller whose run assembles several calls into one
/// summary keeps the sink's stream in the summary's final order itself
/// (see `execute_compaction`'s split-turn flush).
pub type SummaryDeltaSink = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

/// Run one summarizer wire call through `pa_ai::complete_simple` (TS
/// `completeSimple` under `SUMMARIZATION_SYSTEM_PROMPT`). `headers` are
/// the routed model's merged request headers (TS `_resolveAuxiliaryModel`
/// returns `headers` alongside the model and key); the session-model
/// fallback passes None — its path never wired them.
/// `on_delta` is the live summary sink ([`SummaryDeltaSink`]): `Some`
/// consumes the provider stream event-by-event and forwards every text
/// delta (the live compaction block the expanded TUI renders); `None`
/// keeps the one-shot `complete_simple` completion, byte-identical to the
/// pre-streaming path.
/// `failure` labels the error-stop bail exactly like the TS throw sites:
/// "Summarization failed" for the history call, "Turn prefix
/// summarization failed" for the turn-prefix call.
///
/// # Errors
///
/// Returns an error when the summarizer wire call fails, or when its reply
/// stops with an error (labeled with `failure`).
pub async fn complete_summary_call(
    model: &pa_types::ai::Model,
    api_key: Option<String>,
    headers: Option<std::collections::BTreeMap<String, String>>,
    max_tokens: u64,
    request_messages: Vec<AgentMessage>,
    on_delta: Option<SummaryDeltaSink>,
    failure: &'static str,
) -> anyhow::Result<SummarySlice> {
    let messages = request_messages
        .into_iter()
        .filter_map(|message| match message {
            AgentMessage::User(user) => Some(pa_types::ai::Message::User(user)),
            AgentMessage::Assistant(assistant) => Some(pa_types::ai::Message::Assistant(assistant)),
            _ => None,
        })
        .collect();
    let context = pa_types::ai::Context {
        system_prompt: Some(super::compaction_utils::SUMMARIZATION_SYSTEM_PROMPT.to_string()),
        messages,
        tools: None,
    };
    let stream_options =
        pa_ai::types::SimpleStreamOptions::from_base(pa_ai::types::StreamOptions {
            max_tokens: Some(max_tokens),
            api_key,
            headers: headers.map(|headers| headers.into_iter().collect()),
            ..Default::default()
        });
    let assistant = match on_delta {
        None => pa_ai::complete_simple(model, &context, Some(stream_options)).await?,
        Some(on_delta) => {
            // The live path rides the same provider stream
            // `complete_simple` awaits the end of: every text delta is
            // forwarded to the sink as it arrives, and the terminal
            // event's message is the summary exactly like the one-shot
            // arm. Thinking deltas stay off the sink — the final summary
            // carries only the text blocks.
            let mut stream = pa_ai::stream_simple(model, &context, Some(stream_options))?;
            while let Some(event) = stream.next_event().await {
                if let pa_types::ai::AssistantMessageEvent::TextDelta { delta, .. } = &event {
                    on_delta(delta);
                }
            }
            stream.result().await
        }
    };
    if assistant.stop_reason == pa_types::ai::StopReason::Error {
        anyhow::bail!(
            "{failure}: {}",
            assistant
                .error_message
                .as_deref()
                .unwrap_or("Unknown error")
        );
    }
    let summary = assistant
        .content
        .iter()
        .filter_map(|block| match block {
            pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(SummarySlice {
        summary,
        usage: Some(assistant.usage),
    })
}

/// Sum one wire call's billed usage into a total (TS `addAssistantUsage`).
/// Token fields saturate at `u64::MAX`: JS numbers saturate to `Infinity`
/// rather than wrapping, and one overflowing persisted record must never
/// panic a whole-file reader.
pub fn add_assistant_usage(total: &mut pa_types::ai::Usage, usage: &pa_types::ai::Usage) {
    total.input = total.input.saturating_add(usage.input);
    total.output = total.output.saturating_add(usage.output);
    total.cache_read = total.cache_read.saturating_add(usage.cache_read);
    total.cache_write = total.cache_write.saturating_add(usage.cache_write);
    total.total_tokens = total.total_tokens.saturating_add(usage.total_tokens);
    let add_cost = |left: pa_types::JsNumber, right: pa_types::JsNumber| {
        pa_types::JsNumber::from(left.as_f64() + right.as_f64())
    };
    total.cost.input = add_cost(total.cost.input, usage.cost.input);
    total.cost.output = add_cost(total.cost.output, usage.cost.output);
    total.cost.cache_read = add_cost(total.cost.cache_read, usage.cost.cache_read);
    total.cost.cache_write = add_cost(total.cost.cache_write, usage.cost.cache_write);
    total.cost.total = add_cost(total.cost.total, usage.cost.total);
}

/// Remove one usage block from a total, clamping every field at zero (TS
/// `subtractAssistantUsage`: "Remove a previously added usage, clamping at
/// zero to absorb attribution drift").
pub fn subtract_assistant_usage(total: &mut pa_types::ai::Usage, usage: &pa_types::ai::Usage) {
    total.input = total.input.saturating_sub(usage.input);
    total.output = total.output.saturating_sub(usage.output);
    total.cache_read = total.cache_read.saturating_sub(usage.cache_read);
    total.cache_write = total.cache_write.saturating_sub(usage.cache_write);
    total.total_tokens = total.total_tokens.saturating_sub(usage.total_tokens);
    let sub_cost = |left: pa_types::JsNumber, right: pa_types::JsNumber| {
        pa_types::JsNumber::from((left.as_f64() - right.as_f64()).max(0.0))
    };
    total.cost.input = sub_cost(total.cost.input, usage.cost.input);
    total.cost.output = sub_cost(total.cost.output, usage.cost.output);
    total.cost.cache_read = sub_cost(total.cost.cache_read, usage.cost.cache_read);
    total.cost.cache_write = sub_cost(total.cost.cache_write, usage.cost.cache_write);
    total.cost.total = sub_cost(total.cost.total, usage.cost.total);
}

/// The compaction's billed usage summed over its wire calls (TS `compact`'s
/// slice loop: `usage ??= emptyUsage(); addAssistantUsage(...)`). A run with
/// no wire calls (the no-history split arm) records no usage.
pub fn summed_usage(slices: &[SummarySlice]) -> Option<pa_types::ai::Usage> {
    let mut total: Option<pa_types::ai::Usage> = None;
    for slice in slices {
        if let Some(usage) = &slice.usage {
            let total = total.get_or_insert_with(pa_types::ai::Usage::default);
            add_assistant_usage(total, usage);
        }
    }
    total
}

/// File operations preserved across prior compactions plus current messages.
fn extract_file_operations(
    messages: &[AgentMessage],
    entries: &[FileEntry],
    prev_compaction_index: Option<usize>,
) -> FileOperations {
    let mut ops = FileOperations::default();
    if let Some(index) = prev_compaction_index {
        if let Some(FileEntry::Compaction { payload, .. }) = entries.get(index) {
            if payload.from_hook != Some(true) {
                if let Some(details) = payload.details.clone() {
                    if let Ok(details) = serde_json::from_value::<CompactionDetails>(details) {
                        ops.read.extend(details.read_files);
                        ops.edited.extend(details.modified_files);
                    }
                }
            }
        }
    }
    for message in messages {
        extract_file_ops_from_message(message, &mut ops);
    }
    ops
}

/// Inputs to a compaction run.
pub struct CompactRequest<'a> {
    /// Conversation messages (whole context, in order).
    pub messages: &'a [AgentMessage],
    /// The chosen cut point.
    pub cut: &'a CutPointResult,
    /// Id of the first kept entry.
    pub first_kept_entry_id: &'a str,
    /// Context tokens before compaction.
    pub tokens_before: u64,
    /// `/compact <instructions>` guidance.
    pub custom_instructions: Option<&'a str>,
    /// Previous summary for update-mode summarization.
    pub previous_summary: Option<&'a str>,
    /// Budget for the summary output.
    pub reserve_tokens: u64,
    /// Model for the summarizer call.
    pub model: pa_types::ai::Model,
}

/// Run compaction over a conversation slice: summarize the dropped prefix,
/// keeping from `first_kept_entry_id`. `summarize` performs the model call.
///
/// # Errors
///
/// Returns the `summarize` call's error when the summarization fails.
pub async fn compact_with(
    request: CompactRequest<'_>,
    summarize: SummarizerFn,
) -> anyhow::Result<CompactionResult> {
    let CompactRequest {
        messages,
        cut,
        first_kept_entry_id,
        tokens_before,
        custom_instructions,
        previous_summary,
        reserve_tokens,
        model,
    } = request;
    // Messages to summarize: everything before the cut.
    let summarized = &messages[..cut.first_kept_entry_index.min(messages.len())];
    let request_messages = build_summarization_request(
        summarized,
        custom_instructions,
        previous_summary,
        reserve_tokens,
    );
    let assistant = summarize(model, request_messages).await?;
    let usage = (assistant.usage.total_tokens > 0).then_some(assistant.usage);
    let summary = assistant
        .content
        .iter()
        .filter_map(|block| match block {
            pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(CompactionResult {
        summary,
        first_kept_entry_id: first_kept_entry_id.to_string(),
        tokens_before,
        usage,
    })
}

/// The compaction entry to persist for a result.
///
/// `fromHook` carries the TS `fromExtension` origin: whether a compaction
/// extension produced the summary (`agent-session.ts` passes its
/// `fromExtension` flag into `appendCompaction`). The Rust engine has no
/// extension seam yet, so every built-in compaction records `fromHook:
/// false`, the exact durable value TS writes for its built-in path — never
/// a missing key.
pub fn compaction_entry_for(
    result: &CompactionResult,
    details: &CompactionDetails,
    custom_instructions: Option<&str>,
    harness_digest: Option<String>,
) -> CompactionEntry {
    CompactionEntry {
        summary: result.summary.clone(),
        first_kept_entry_id: result.first_kept_entry_id.clone(),
        tokens_before: result.tokens_before,
        details: Some(serde_json::to_value(details).unwrap_or_default()),
        from_hook: Some(false),
        custom_instructions: custom_instructions.map(str::to_string),
        usage: result.usage,
        harness_digest,
    }
}

/// Full-file-list details for a compact run (prev compaction ops + messages).
pub fn details_for(
    messages: &[AgentMessage],
    entries: &[FileEntry],
    prev_compaction_index: Option<usize>,
) -> CompactionDetails {
    let ops = extract_file_operations(messages, entries, prev_compaction_index);
    let (read_files, modified_files) = compute_file_lists(&ops);
    CompactionDetails {
        read_files,
        modified_files,
    }
}

/// The XML file-ops block appended to a summary presentation.
pub fn file_ops_block(read_files: &[String], modified_files: &[String]) -> String {
    format_file_operations(read_files, modified_files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::session::EntryBase;

    fn user(text: &str) -> AgentMessage {
        AgentMessage::User(UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    }

    fn summary_assistant(text: &str) -> AssistantMessage {
        AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
                rest: serde_json::Map::default(),
            })],
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        }
    }

    /// Token sums saturate at `u64::MAX` (JS `Infinity`): an overflowing
    /// record must never panic the whole-file readers that fold totals.
    #[test]
    fn add_assistant_usage_saturates_token_totals() {
        let mut total = pa_types::ai::Usage {
            input: u64::MAX,
            output: 1,
            ..Default::default()
        };
        add_assistant_usage(
            &mut total,
            &pa_types::ai::Usage {
                input: 10,
                ..Default::default()
            },
        );
        assert_eq!(total.input, u64::MAX);
        assert_eq!(total.output, 1);
    }

    /// The entry records the TS wire record: `fromHook: false` (the
    /// built-in origin — TS passes `fromExtension`), the file-operation
    /// details, the summarizer usage, and the custom instructions.
    #[test]
    fn compaction_entry_records_the_ts_wire_fields() {
        let usage = pa_types::ai::Usage {
            input: 20,
            output: 10,
            cache_read: 80,
            cache_write: 0,
            total_tokens: 110,
            cost: pa_types::ai::UsageCost::default(),
        };
        let result = CompactionResult {
            summary: "the overflow summary".to_string(),
            first_kept_entry_id: "e4".to_string(),
            tokens_before: 214,
            usage: Some(usage),
        };
        let details = CompactionDetails {
            read_files: vec!["a.rs".to_string()],
            modified_files: vec![],
        };
        assert_eq!(
            compaction_entry_for(&result, &details, Some("focus"), None),
            CompactionEntry {
                summary: "the overflow summary".to_string(),
                first_kept_entry_id: "e4".to_string(),
                tokens_before: 214,
                details: Some(serde_json::json!({
                    "readFiles": ["a.rs"],
                    "modifiedFiles": [],
                })),
                from_hook: Some(false),
                custom_instructions: Some("focus".to_string()),
                usage: Some(usage),
                harness_digest: None,
            }
        );
    }

    /// The serialized `details` block byte-matches the TS literal order:
    /// `{"readFiles":[...],"modifiedFiles":[...]}` (TS `summaryDetails` in
    /// `agent-session.ts` builds `readFiles` first). The JSON map preserves
    /// insertion order, so the struct field order is the wire byte order.
    #[test]
    fn details_serialize_in_the_ts_key_order() {
        let details = CompactionDetails {
            read_files: vec!["a.rs".to_string(), "b.rs".to_string()],
            modified_files: vec!["c.rs".to_string()],
        };
        assert_eq!(
            serde_json::to_string(&details).unwrap(),
            "{\"readFiles\":[\"a.rs\",\"b.rs\"],\"modifiedFiles\":[\"c.rs\"]}"
        );
    }

    #[tokio::test]
    async fn compact_summarizes_prefix_and_returns_result() {
        let messages = vec![user("one"), user("two"), user("three")];
        let entries: Vec<FileEntry> = messages
            .iter()
            .enumerate()
            .map(|(index, _)| FileEntry::Message {
                message: user(&format!("m{index}")),
                base: EntryBase {
                    id: Some(format!("e{index}")),
                    parent_id: None,
                    timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
                    rest: serde_json::Map::default(),
                },
            })
            .collect();
        let cut = CutPointResult {
            first_kept_entry_index: 1,
            turn_start_index: None,
            is_split_turn: false,
        };
        let model: pa_types::ai::Model = serde_json::from_value(serde_json::json!({
            "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
            "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100
        }))
        .unwrap();
        let summarize: SummarizerFn = Box::new(|_model, request| {
            Box::pin(async move {
                // The request only contains the dropped prefix.
                match &request[0] {
                    AgentMessage::User(user) => {
                        let text = user.content.text();
                        assert!(text.contains("<conversation>"));
                        assert!(text.contains("one"));
                        assert!(!text.contains("two"));
                    }
                    _ => panic!("expected user request"),
                }
                Ok(summary_assistant("## Goal\nship it"))
            })
        });
        let result = compact_with(
            CompactRequest {
                messages: &messages,
                cut: &cut,
                first_kept_entry_id: "e1",
                tokens_before: 1_000,
                custom_instructions: Some("focus"),
                previous_summary: None,
                reserve_tokens: 1_000,
                model,
            },
            summarize,
        )
        .await
        .unwrap();
        assert!(result.summary.starts_with("## Goal"));
        assert_eq!(result.first_kept_entry_id, "e1");
        assert_eq!(result.tokens_before, 1_000);
        // The persisted entry carries the summary + details.
        let details = details_for(&messages, &entries, None);
        let entry = compaction_entry_for(&result, &details, Some("focus"), None);
        assert_eq!(entry.summary, "## Goal\nship it");
        assert_eq!(entry.custom_instructions.as_deref(), Some("focus"));
    }

    /// The turn-prefix request (TS `generateTurnPrefixSummary`): the
    /// serialized prefix under the turn-prefix instruction — never the
    /// checkpoint prompt, a previous summary, or the kernel note.
    #[test]
    fn turn_prefix_request_shape() {
        let messages = vec![user("big turn"), user("more of the turn")];
        let request = build_turn_prefix_request(&messages);
        let AgentMessage::User(user) = &request[0] else {
            panic!("expected user request");
        };
        let text = user.content.text();
        assert!(text.starts_with(
            "<conversation>\n[User]: big turn\n\n[User]: more of the turn\n</conversation>\n\n"
        ));
        assert!(text.contains("This is the PREFIX of a turn that was too large to keep."));
        assert!(text.ends_with("Be concise. Focus on what's needed to understand the kept suffix."));
        assert!(!text.contains("Create a structured context checkpoint summary"));
        assert!(!text.contains("<previous-summary>"));
        assert!(!text.contains("the Python kernel keeps running"));
    }

    /// The split join (TS `compact`'s merged summary) and the no-history
    /// literal stand-in.
    #[test]
    fn split_summary_marker_format() {
        assert_eq!(
            split_summary("history summary", "turn prefix summary"),
            "history summary\n\n---\n\n**Turn Context (split turn):**\n\nturn prefix summary"
        );
        assert_eq!(NO_PRIOR_HISTORY, "No prior history.");
    }

    /// Usage sums across the compaction's wire calls (TS `compact`'s slice
    /// loop with `addAssistantUsage`): a call without usage (the no-history
    /// arm) contributes nothing, and no calls means no recorded usage.
    #[test]
    fn usage_summing_over_slices() {
        let usage = |input: u64, output: u64, cost: f64| pa_types::ai::Usage {
            input,
            output,
            cache_read: 0,
            cache_write: 0,
            total_tokens: input + output,
            cost: pa_types::ai::UsageCost {
                input: pa_types::JsNumber::from(cost),
                output: 0.0.into(),
                cache_read: 0.0.into(),
                cache_write: 0.0.into(),
                total: pa_types::JsNumber::from(cost),
            },
        };
        // Binary-exact costs so the sum assertion compares exactly.
        let (first_cost, second_cost) = (0.25, 0.5);
        let slice = |summary: &str, usage: Option<pa_types::ai::Usage>| SummarySlice {
            summary: summary.to_string(),
            usage,
        };
        // Two billed calls sum (tokens and cost).
        let summed = summed_usage(&[
            slice("a", Some(usage(10, 5, first_cost))),
            slice("b", Some(usage(3, 2, second_cost))),
        ])
        .expect("usage recorded");
        assert_eq!(summed.input, 13);
        assert_eq!(summed.output, 7);
        assert_eq!(summed.total_tokens, 20);
        assert_eq!(summed.cost.input.as_f64(), 0.75);
        assert_eq!(summed.cost.total.as_f64(), 0.75);
        // A no-usage slice (the no-history arm) contributes nothing.
        let mixed = summed_usage(&[slice("a", None), slice("b", Some(usage(3, 2, 0.0)))])
            .expect("usage recorded");
        assert_eq!(mixed.total_tokens, 5);
        // No wire calls at all means no recorded usage.
        assert_eq!(summed_usage(&[slice("a", None)]), None);
    }

    #[test]
    fn summarization_request_shape() {
        let messages = vec![user("hello"), user("world")];
        let request = build_summarization_request(&messages, Some("be brief"), None, 1_000);
        match &request[0] {
            AgentMessage::User(user) => {
                let text = user.content.text();
                assert!(text.starts_with(
                    "<conversation>\n[User]: hello\n\n[User]: world\n</conversation>"
                ));
                assert!(text.contains("<user-instructions>\nThe user provided these instructions"));
                assert!(text.ends_with("redefining them."));
            }
            _ => panic!("expected user message"),
        }
    }
}
