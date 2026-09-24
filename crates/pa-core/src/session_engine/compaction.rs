//! Context compaction: pure decision logic. Port of core/compaction/compaction.ts
//! (token estimation, cut points, summarization prompts). The LLM summarizer
//! call and file-op details land with the provider integration slice.

use pa_types::session::{AgentMessage, FileEntry};

/// Default compaction settings (TS DEFAULT_COMPACTION_SETTINGS).
pub const DEFAULT_RESERVE_TOKENS: u64 = 16_384;
pub const DEFAULT_KEEP_RECENT_TOKENS: u64 = 20_000;

/// The percentage of the context window past which a threshold compaction
/// always fires (guards estimate drift on large windows).
pub const COMPACT_THRESHOLD_RATIO: f64 = 0.95;

/// The smallest headroom kept under the combined input+output ceiling (the
/// chars/4 estimate error); `reserve_tokens` raises it when larger.
pub const COMBINED_LIMIT_HEADROOM_FLOOR: u64 = 4_096;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CompactionSettings {
    pub enabled: bool,
    /// Headroom under the combined input+output ceiling (a floor of
    /// [`COMBINED_LIMIT_HEADROOM_FLOOR`]): combined-limit providers reject
    /// `input + requested output > contextWindow`, so the trigger fires
    /// before the requested output budget no longer fits.
    pub reserve_tokens: u64,
    pub keep_recent_tokens: u64,
}

impl Default for CompactionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            reserve_tokens: DEFAULT_RESERVE_TOKENS,
            keep_recent_tokens: DEFAULT_KEEP_RECENT_TOKENS,
        }
    }
}

/// Context tokens from usage: `totalTokens` when present, else the sum.
/// Output counts: the response becomes part of the next prompt.
pub fn calculate_context_tokens(usage: &pa_types::ai::Usage) -> u64 {
    if usage.total_tokens > 0 {
        usage.total_tokens
    } else {
        usage.input + usage.output + usage.cache_read + usage.cache_write
    }
}

fn assistant_usage(message: &AgentMessage) -> Option<pa_types::ai::Usage> {
    let AgentMessage::Assistant(assistant) = message else {
        return None;
    };
    match assistant.stop_reason {
        pa_types::ai::StopReason::Aborted | pa_types::ai::StopReason::Error => None,
        _ => Some(assistant.usage),
    }
}

/// Last non-aborted assistant usage from session entries.
pub fn get_last_assistant_usage(entries: &[FileEntry]) -> Option<pa_types::ai::Usage> {
    for entry in entries.iter().rev() {
        if let FileEntry::Message { message, .. } = entry {
            if let Some(usage) = assistant_usage(message) {
                return Some(usage);
            }
        }
    }
    None
}

/// Chars/4 heuristic token estimate (conservative; overestimates).
pub fn estimate_tokens(message: &AgentMessage) -> u64 {
    let chars = |text: &str| text.chars().count() as u64;
    match message {
        AgentMessage::User(user) => match &user.content {
            pa_types::ai::UserContent::Text(text) => div4(chars(text)),
            pa_types::ai::UserContent::Blocks(blocks) => div4(
                blocks
                    .iter()
                    .filter_map(|block| match block {
                        pa_types::ai::UserContentBlock::Text(text) => Some(chars(&text.text)),
                        _ => None,
                    })
                    .sum(),
            ),
        },
        AgentMessage::Assistant(assistant) => {
            let mut total = 0u64;
            for block in &assistant.content {
                match block {
                    pa_types::ai::AssistantContentBlock::Text(text) => total += chars(&text.text),
                    pa_types::ai::AssistantContentBlock::Thinking(thinking) => {
                        total += chars(&thinking.thinking)
                    }
                    pa_types::ai::AssistantContentBlock::ToolCall(call) => {
                        total += chars(&call.name)
                            + serde_json::to_string(&call.arguments)
                                .map(|json| json.chars().count() as u64)
                                .unwrap_or(0);
                    }
                }
            }
            div4(total)
        }
        AgentMessage::Custom(custom) => match &custom.content {
            pa_types::ai::UserContent::Text(text) => div4(chars(text)),
            pa_types::ai::UserContent::Blocks(blocks) => div4(
                blocks
                    .iter()
                    .map(|block| match block {
                        pa_types::ai::UserContentBlock::Text(text) => chars(&text.text),
                        pa_types::ai::UserContentBlock::Image(_) => 4_800, // ~1200 tokens
                        // Un-modeled blocks have no modeled size; TS sizes
                        // only typed blocks, so estimate zero.
                        pa_types::ai::UserContentBlock::Raw(_) => 0,
                    })
                    .sum(),
            ),
        },
        AgentMessage::ToolResult(result) => div4(
            result
                .content
                .iter()
                .map(|block| match block {
                    pa_types::ai::UserContentBlock::Text(text) => chars(&text.text),
                    pa_types::ai::UserContentBlock::Image(_) => 4_800,
                    pa_types::ai::UserContentBlock::Raw(_) => 0,
                })
                .sum(),
        ),
        AgentMessage::BashExecution(bash) => div4(chars(&bash.command) + chars(&bash.output)),
        AgentMessage::BranchSummary(summary) => div4(chars(&summary.summary)),
        AgentMessage::CompactionSummary(summary) => div4(chars(&summary.summary)),
    }
    .saturating_add(0) // keep type u64
}

fn div4(chars: u64) -> u64 {
    chars.div_ceil(4)
}

/// The effective compaction threshold: the earlier of two ceilings.
///
/// 1. PERCENTAGE — `context_window * COMPACT_THRESHOLD_RATIO`: estimate
///    drift on large windows must not ride the last 5% of the window.
/// 2. COMBINED-LIMIT — `context_window - max_output_tokens - headroom`:
///    combined-limit providers reject `input + requested output >
///    contextWindow` (the live 400: 1,017,457 input + 32,000 requested
///    output on a 1,048,576 window), so the trigger fires while the next
///    request's output budget still fits. `headroom` is
///    `max(reserve_tokens, COMBINED_LIMIT_HEADROOM_FLOOR)`, covering the
///    chars/4 estimate error.
///
/// The TS `shouldCompact` checks only `contextWindow - reserveTokens`
/// (compaction.ts:223); reserving the output budget is a deliberate
/// Rust-side fix — without it a request can overflow while the trigger
/// says "not due". A non-positive threshold disables the trigger (the TS
/// degenerate-config semantics: compaction cannot fix it; overflow
/// recovery remains the backstop).
pub fn compaction_threshold(
    context_window: u64,
    max_output_tokens: u64,
    settings: &CompactionSettings,
) -> u64 {
    let percentage = (context_window as f64 * COMPACT_THRESHOLD_RATIO) as u64;
    let headroom = settings.reserve_tokens.max(COMBINED_LIMIT_HEADROOM_FLOOR);
    let combined = context_window
        .saturating_sub(max_output_tokens)
        .saturating_sub(headroom);
    percentage.min(combined)
}

/// Whether compaction should trigger.
pub fn should_compact(
    context_tokens: u64,
    context_window: u64,
    max_output_tokens: u64,
    settings: &CompactionSettings,
) -> bool {
    if !settings.enabled {
        return false;
    }
    if context_window == 0 {
        return false;
    }
    let threshold = compaction_threshold(context_window, max_output_tokens, settings);
    threshold > 0 && context_tokens > threshold
}

/// The effective requested output budget of the session's next model call:
/// the per-request default `min(model.maxTokens, 32000)`, plus the thinking
/// budget budget-folding providers (Anthropic/Bedrock models without
/// adaptive thinking) add on top of it for the session's reasoning level,
/// capped at the model's declared max output; 0 when the model declares no
/// max output. The combined input+output ceiling reserves what the request
/// will actually claim, or a budget-folded request can overflow while the
/// trigger still says "not due".
pub fn request_output_budget(
    model: &pa_types::ai::Model,
    thinking: pa_types::ai::ModelThinkingLevel,
) -> u64 {
    pa_ai::effective_request_max_tokens(model, thinking)
}

/// The message-anchored context estimate over the live loop context (TS
/// `estimateContextTokens`): the last valid assistant usage anchors the
/// estimate, and messages after it add their chars/4 heuristic estimates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextTokensEstimate {
    /// Usage tokens plus trailing estimates (TS `estimate.tokens`).
    pub tokens: u64,
    /// The live-message index the estimate anchored on (TS `lastUsageIndex`;
    /// `None` when the context carries no valid assistant usage).
    pub last_usage_index: Option<usize>,
}

pub fn estimate_context_tokens(messages: &[AgentMessage]) -> ContextTokensEstimate {
    match messages
        .iter()
        .rposition(|message| assistant_usage(message).is_some())
    {
        Some(index) => {
            let usage = assistant_usage(&messages[index]).expect("index from rposition");
            let trailing: u64 = messages[index + 1..].iter().map(estimate_tokens).sum();
            ContextTokensEstimate {
                tokens: calculate_context_tokens(&usage) + trailing,
                last_usage_index: Some(index),
            }
        }
        None => ContextTokensEstimate {
            tokens: messages.iter().map(estimate_tokens).sum(),
            last_usage_index: None,
        },
    }
}

/// A message's timestamp (millis since the epoch; every role carries one).
fn message_timestamp(message: &AgentMessage) -> u64 {
    match message {
        AgentMessage::User(user) => user.timestamp,
        AgentMessage::Assistant(assistant) => assistant.timestamp,
        AgentMessage::Custom(custom) => custom.timestamp,
        AgentMessage::ToolResult(result) => result.timestamp,
        AgentMessage::BashExecution(bash) => bash.timestamp,
        AgentMessage::BranchSummary(summary) => summary.timestamp,
        AgentMessage::CompactionSummary(summary) => summary.timestamp,
    }
}

/// The threshold-crossing check behind the TS `_checkCompaction` threshold
/// arm (TS `_getThresholdContextTokens` + `shouldCompact`): whether the
/// live context crossed the effective threshold ([`compaction_threshold`]:
/// the percentage or the combined input+output ceiling, whichever comes
/// first) and an automatic compaction should run. `messages` is the
/// session's live loop context; the newest `CompactionSummary` in it is
/// the latest compaction boundary — usage from
/// before it reflects the pre-compaction context and never re-triggers
/// (the TS `assistantIsFromBeforeCompaction` / stale-usage guards).
pub fn threshold_compaction_due(
    messages: &[AgentMessage],
    context_window: u64,
    max_output_tokens: u64,
    settings: &CompactionSettings,
) -> bool {
    if !settings.enabled || context_window == 0 {
        return false;
    }
    let compaction_timestamp = messages.iter().rev().find_map(|message| match message {
        AgentMessage::CompactionSummary(summary) => Some(summary.timestamp),
        _ => None,
    });
    let estimate = estimate_context_tokens(messages);
    let context_tokens = match estimate.last_usage_index {
        Some(index) => {
            // The usage anchor must postdate the latest compaction.
            if compaction_timestamp
                .is_some_and(|timestamp| message_timestamp(&messages[index]) <= timestamp)
            {
                return false;
            }
            estimate.tokens
        }
        // TS fallback: no valid usage in the context — the last assistant
        // message's raw usage decides; error turns never trigger.
        None => {
            let Some(AgentMessage::Assistant(assistant)) = messages
                .iter()
                .rev()
                .find(|message| matches!(message, AgentMessage::Assistant(_)))
            else {
                return false;
            };
            if assistant.stop_reason == pa_types::ai::StopReason::Error {
                return false;
            }
            if compaction_timestamp.is_some_and(|timestamp| assistant.timestamp <= timestamp) {
                return false;
            }
            calculate_context_tokens(&assistant.usage)
        }
    };
    should_compact(context_tokens, context_window, max_output_tokens, settings)
}

/// Valid cut point indices: user/assistant/custom/branch/compaction-summary
/// messages plus branch_summary and custom_message entries. Never tool results.
pub fn find_valid_cut_points(
    entries: &[FileEntry],
    start_index: usize,
    end_index: usize,
) -> Vec<usize> {
    let mut cut_points = Vec::new();
    for (i, entry) in entries
        .iter()
        .enumerate()
        .take(end_index.min(entries.len()))
        .skip(start_index)
    {
        match entry {
            FileEntry::Message { message, .. } => match message {
                AgentMessage::User(_)
                | AgentMessage::Assistant(_)
                | AgentMessage::Custom(_)
                | AgentMessage::BashExecution(_)
                | AgentMessage::BranchSummary(_)
                | AgentMessage::CompactionSummary(_) => cut_points.push(i),
                AgentMessage::ToolResult(_) => {}
            },
            FileEntry::BranchSummary { .. } | FileEntry::CustomMessage { .. } => {
                cut_points.push(i);
            }
            _ => {}
        }
    }
    cut_points
}

/// The user/bashExecution message (or branch boundary) starting the turn
/// containing `entry_index`; None when no turn start exists before it.
fn find_turn_start_index(
    entries: &[FileEntry],
    entry_index: usize,
    start_index: usize,
) -> Option<usize> {
    for i in (start_index..=entry_index).rev() {
        let entry = &entries[i];
        match entry {
            FileEntry::BranchSummary { .. } | FileEntry::CustomMessage { .. } => return Some(i),
            FileEntry::Message {
                message: AgentMessage::User(_) | AgentMessage::BashExecution(_),
                ..
            } => return Some(i),
            _ => {}
        }
    }
    None
}

/// The chosen cut point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CutPointResult {
    pub first_kept_entry_index: usize,
    /// Turn start when splitting mid-turn (None otherwise).
    pub turn_start_index: Option<usize>,
    pub is_split_turn: bool,
}

/// Find the cut point keeping approximately `keep_recent_tokens`.
pub fn find_cut_point(
    entries: &[FileEntry],
    start_index: usize,
    end_index: usize,
    keep_recent_tokens: u64,
) -> CutPointResult {
    let cut_points = find_valid_cut_points(entries, start_index, end_index);
    if cut_points.is_empty() {
        return CutPointResult {
            first_kept_entry_index: start_index,
            turn_start_index: None,
            is_split_turn: false,
        };
    }
    let mut accumulated = 0u64;
    let mut cut_index = cut_points[0];
    for (i, entry) in entries
        .iter()
        .enumerate()
        .take(end_index.min(entries.len()))
        .skip(start_index)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        let FileEntry::Message { message, .. } = entry else {
            continue;
        };
        accumulated = accumulated.saturating_add(estimate_tokens(message));
        if accumulated >= keep_recent_tokens {
            cut_index = *cut_points.last().unwrap();
            for &point in &cut_points {
                if point >= i {
                    cut_index = point;
                    break;
                }
            }
            break;
        }
    }
    // Walk back to a message or compaction boundary.
    while cut_index > start_index {
        match &entries[cut_index - 1] {
            FileEntry::Compaction { .. } | FileEntry::Message { .. } => break,
            _ => cut_index -= 1,
        }
    }
    let is_user_message = matches!(
        &entries[cut_index],
        FileEntry::Message {
            message: AgentMessage::User(_),
            ..
        }
    );
    let turn_start_index = if is_user_message {
        None
    } else {
        find_turn_start_index(entries, cut_index, start_index)
    };
    CutPointResult {
        first_kept_entry_index: cut_index,
        is_split_turn: !is_user_message && turn_start_index.is_some(),
        turn_start_index,
    }
}

const SUMMARIZATION_PROMPT: &str = "The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.\n\nUse this EXACT format:\n\n## Goal\n[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]\n\n## Constraints & Preferences\n- [Any constraints, preferences, or requirements mentioned by user]\n- [Or \"(none)\" if none were mentioned]\n\n## Progress\n### Done\n- [x] [Completed tasks/changes]\n\n### In Progress\n- [ ] [Current work]\n\n### Blocked\n- [Issues preventing progress, if any]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale]\n\n## Next Steps\n1. [Ordered list of what should happen next]\n\n## Critical Context\n- [Any data, examples, or references needed to continue]\n- [Or \"(none)\" if not applicable]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.";

const KERNEL_PERSIST_SUMMARY_NOTE: &str = "Note: the Python kernel keeps running after this summary — every Python variable, import, and helper you defined stays available. The cells that defined them won't appear above, so record in the summary any names worth remembering so you reuse them instead of redefining them.";

/// The turn-prefix summarizer instruction (TS `TURN_PREFIX_SUMMARIZATION_PROMPT`):
/// a split turn keeps its suffix, and this prompt summarizes the cut turn's
/// prefix for the retained recent work.
pub const TURN_PREFIX_SUMMARIZATION_PROMPT: &str = "This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.\n\nSummarize the prefix to provide context for the retained suffix:\n\n## Original Request\n[What did the user ask for in this turn?]\n\n## Early Progress\n- [Key decisions and work done in the prefix]\n\n## Context for Suffix\n- [Information needed to understand the retained recent work]\n\nBe concise. Focus on what's needed to understand the kept suffix.";

const UPDATE_SUMMARIZATION_PROMPT: &str = "The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.\n\nUpdate the existing structured summary with new information. RULES:\n- PRESERVE all existing information from the previous summary\n- ADD new progress, decisions, and context from the new messages\n- UPDATE the Progress section: move items from \"In Progress\" to \"Done\" when completed\n- UPDATE \"Next Steps\" based on what was accomplished\n- PRESERVE exact file paths, function names, and error messages\n- If something is no longer relevant, you may remove it\n\nUse this EXACT format:\n\n## Goal\n[Preserve existing goals, add new ones if the task expanded]\n\n## Constraints & Preferences\n- [Preserve existing, add new ones discovered]\n\n## Progress\n### Done\n- [x] [Include previously done items AND newly completed items]\n\n### In Progress\n- [ ] [Current work - update based on progress]\n\n### Blocked\n- [Current blockers - remove if resolved]\n\n## Key Decisions\n- **[Decision]**: [Brief rationale] (preserve all previous, add new)\n\n## Next Steps\n1. [Update based on current state]\n\n## Critical Context\n- [Preserve important context, add new if needed]\n\nKeep each section concise. Preserve exact file paths, function names, and error messages.";

/// The instruction part of the summarization prompt (initial or update
/// template, user instructions, kernel persistence note).
pub fn build_summarization_prompt(
    custom_instructions: Option<&str>,
    previous_summary: Option<&str>,
) -> String {
    let mut base = if previous_summary.is_some() {
        UPDATE_SUMMARIZATION_PROMPT
    } else {
        SUMMARIZATION_PROMPT
    }
    .to_string();
    if let Some(custom_instructions) = custom_instructions {
        base.push_str(&format!(
            "\n\n<user-instructions>\nThe user provided these instructions for this summary. Follow them with high priority while keeping the section format above: emphasize what they ask to focus on, and preserve verbatim anything they ask to remember.\n{custom_instructions}\n</user-instructions>"
        ));
    }
    format!("{base}\n\n{KERNEL_PERSIST_SUMMARY_NOTE}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::session::EntryBase;

    fn message_entry(id: &str, parent: &str, message: AgentMessage) -> FileEntry {
        FileEntry::Message {
            message,
            base: EntryBase {
                id: Some(id.to_string()),
                parent_id: Some(parent.to_string()),
                timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
                rest: Default::default(),
            },
        }
    }

    fn user_entry(id: &str, parent: &str, text: &str) -> FileEntry {
        message_entry(
            id,
            parent,
            AgentMessage::User(pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text(text.to_string()),
                timestamp: 0,
                rest: Default::default(),
            }),
        )
    }

    fn assistant_entry(id: &str, parent: &str) -> FileEntry {
        message_entry(
            id,
            parent,
            AgentMessage::Assistant(pa_types::ai::AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: "ok".to_string(),
                        text_signature: None,
                        rest: Default::default(),
                    },
                )],
                api: "openai-completions".to_string(),
                provider: "p".to_string(),
                model: "m".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_types::ai::Usage {
                    input: 100,
                    output: 50,
                    cache_read: 0,
                    cache_write: 0,
                    total_tokens: 150,
                    cost: Default::default(),
                },
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
                rest: Default::default(),
            }),
        )
    }

    fn user_message(text: &str, timestamp: u64) -> AgentMessage {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text(text.to_string()),
            timestamp,
            rest: Default::default(),
        })
    }

    fn assistant_message(usage_total: u64, timestamp: u64) -> AgentMessage {
        AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: "ok".to_string(),
                    text_signature: None,
                    rest: Default::default(),
                },
            )],
            api: "openai-completions".to_string(),
            provider: "p".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage {
                input: usage_total,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                total_tokens: usage_total,
                cost: Default::default(),
            },
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp,
            rest: Default::default(),
        })
    }

    fn compaction_summary(timestamp: u64) -> AgentMessage {
        AgentMessage::CompactionSummary(pa_types::session::CompactionSummaryMessage {
            summary: "the story so far".to_string(),
            tokens_before: 100,
            retained_message_count: None,
            custom_instructions: None,
            harness_digest: None,
            harness_state_fingerprint: None,
            timestamp,
        })
    }

    #[test]
    fn estimate_context_tokens_anchors_on_the_last_valid_usage() {
        // The last valid assistant usage anchors the estimate; messages
        // after it add their chars/4 estimates (TS estimateContextTokens).
        let messages = vec![
            user_message("turn one", 1),
            assistant_message(1_000, 2),
            user_message("12345678", 3), // 8 chars -> 2 trailing tokens
        ];
        let estimate = estimate_context_tokens(&messages);
        assert_eq!(estimate.last_usage_index, Some(1));
        assert_eq!(estimate.tokens, 1_002);
        // No valid usage: everything falls back to the chars/4 heuristic.
        let messages = vec![user_message("12345678", 1)];
        let estimate = estimate_context_tokens(&messages);
        assert_eq!(estimate.last_usage_index, None);
        assert_eq!(estimate.tokens, 2);
    }

    #[test]
    fn threshold_crosses_the_reserve_headroom() {
        // The f14 battery shape: 126_010 tokens on a 128k window with a
        // 127_500 reserve leaves a 500-token combined ceiling (a model
        // declaring no output budget) — the crossing fires.
        let settings = CompactionSettings {
            enabled: true,
            reserve_tokens: 127_500,
            keep_recent_tokens: 10,
        };
        let messages = vec![
            user_message("f14 auto seed turn", 1),
            assistant_message(110, 2),
            user_message("f14 threshold crossing turn", 3),
            assistant_message(126_010, 4),
        ];
        assert!(threshold_compaction_due(&messages, 128_000, 0, &settings));
        // Below the headroom nothing fires (the seed turn's default usage).
        let messages = vec![
            user_message("f14 auto seed turn", 1),
            assistant_message(110, 2),
        ];
        assert!(!threshold_compaction_due(&messages, 128_000, 0, &settings));
        // Disabled settings and unknown windows never compact.
        let disabled = CompactionSettings {
            enabled: false,
            reserve_tokens: 127_500,
            keep_recent_tokens: 10,
        };
        assert!(!threshold_compaction_due(&messages, 128_000, 0, &disabled));
        assert!(!threshold_compaction_due(&messages, 0, 0, &settings));
    }

    #[test]
    fn threshold_fires_before_a_combined_limit_overflow() {
        // The live 400 shape: 1_017_457 input tokens under the old trigger
        // (window - reserve = 1_032_192) but over the combined ceiling once
        // the 32_000 requested output no longer fits — the new trigger
        // fires first.
        let settings = CompactionSettings::default();
        let messages = vec![
            user_message("live session turn", 1),
            assistant_message(1_017_457, 2),
        ];
        assert!(threshold_compaction_due(
            &messages, 1_048_576, 32_000, &settings
        ));
        // Below both ceilings (the old reserve line at 1_032_192 included)
        // nothing fires.
        let messages = vec![
            user_message("live session turn", 1),
            assistant_message(990_000, 2),
        ];
        assert!(!threshold_compaction_due(
            &messages, 1_048_576, 32_000, &settings
        ));
        // A 64k output budget pushes the combined ceiling below the
        // percentage one (1_048_576 - 65_536 - 16_384 = 966_656): 970_000
        // fires on the combined ceiling alone — under the old reserve line
        // AND under 95% of the window.
        let messages = vec![
            user_message("live session turn", 1),
            assistant_message(970_000, 2),
        ];
        assert!(threshold_compaction_due(
            &messages, 1_048_576, 65_536, &settings
        ));
        assert!(!threshold_compaction_due(
            &messages, 1_048_576, 0, &settings
        ));
    }

    #[test]
    fn threshold_percentage_ceiling_guards_large_windows() {
        // Past 95% of a large window the percentage ceiling fires before
        // the combined ceiling (1_048_576 * 0.95 = 996_147).
        let settings = CompactionSettings::default();
        assert!(should_compact(996_148, 1_048_576, 32_000, &settings));
        assert!(!should_compact(996_000, 1_048_576, 32_000, &settings));
    }

    #[test]
    fn threshold_combined_ceiling_guards_small_windows() {
        // A 128k window with a 32k output budget: pure 95% (124_518) would
        // under-reserve — the combined ceiling (131_072 - 32_768 - 16_384
        // = 81_920) comes first.
        let settings = CompactionSettings::default();
        assert_eq!(compaction_threshold(131_072, 32_768, &settings), 81_920);
        assert!(should_compact(82_000, 131_072, 32_768, &settings));
        assert!(!should_compact(81_000, 131_072, 32_768, &settings));
    }

    #[test]
    fn threshold_headroom_floor_covers_estimate_error() {
        // A tiny reserve still keeps the 4_096 estimate-error floor:
        // 131_072 - 32_768 - 4_096 = 94_208 < the 95% ceiling.
        let settings = CompactionSettings {
            enabled: true,
            reserve_tokens: 1,
            keep_recent_tokens: 10,
        };
        assert_eq!(compaction_threshold(131_072, 32_768, &settings), 94_208);
        // An output budget that cannot fit any context disables the
        // trigger (the TS degenerate-config semantics: compaction cannot
        // fix it; overflow recovery remains the backstop).
        assert_eq!(
            compaction_threshold(128_000, 124_000, &CompactionSettings::default()),
            0
        );
        assert!(!should_compact(
            126_000,
            128_000,
            124_000,
            &CompactionSettings::default()
        ));
    }

    #[test]
    fn stale_pre_compaction_usage_never_retriggers() {
        // After a compaction the retained tail still carries its
        // pre-compaction usage; the newer compaction boundary guards it.
        let settings = CompactionSettings {
            enabled: true,
            reserve_tokens: 127_500,
            keep_recent_tokens: 10,
        };
        let messages = vec![
            compaction_summary(10),
            user_message("kept turn", 5),
            assistant_message(126_010, 6),
        ];
        assert!(!threshold_compaction_due(&messages, 128_000, 0, &settings));
        // A post-compaction usage crossing still fires.
        let messages = vec![
            compaction_summary(10),
            user_message("new turn", 11),
            assistant_message(126_010, 12),
        ];
        assert!(threshold_compaction_due(&messages, 128_000, 0, &settings));
    }

    #[test]
    fn token_estimation() {
        let user = AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text("12345678".to_string()), // 8 chars -> 2 tokens
            timestamp: 0,
            rest: Default::default(),
        });
        assert_eq!(estimate_tokens(&user), 2);
        // Usage math: totalTokens wins.
        let usage = pa_types::ai::Usage {
            input: 10,
            output: 5,
            cache_read: 1,
            cache_write: 1,
            total_tokens: 100,
            cost: Default::default(),
        };
        assert_eq!(calculate_context_tokens(&usage), 100);
    }

    #[test]
    fn should_compact_threshold() {
        let settings = CompactionSettings::default();
        // No output budget: the default reserve headroom decides.
        assert!(should_compact(120_000, 128_000, 0, &settings)); // > 128k - 16k
        assert!(!should_compact(100_000, 128_000, 0, &settings));
        let disabled = CompactionSettings {
            enabled: false,
            ..settings
        };
        assert!(!should_compact(200_000, 128_000, 0, &disabled));
        assert!(!should_compact(1, 0, 0, &settings));
    }

    #[test]
    fn cut_points_never_tool_results() {
        let entries = vec![
            user_entry("u1", "root", "hello there"),
            assistant_entry("a1", "u1"),
            message_entry(
                "t1",
                "a1",
                AgentMessage::ToolResult(pa_types::ai::ToolResultMessage {
                    tool_call_id: "c".to_string(),
                    tool_name: "bash".to_string(),
                    content: vec![pa_types::ai::UserContentBlock::Text(
                        pa_types::ai::TextContent {
                            text: "result".to_string(),
                            text_signature: None,
                            rest: Default::default(),
                        },
                    )],
                    details: None,
                    is_error: false,
                    timestamp: 0,
                    rest: Default::default(),
                }),
            ),
        ];
        let points = find_valid_cut_points(&entries, 0, 3);
        assert_eq!(points, vec![0, 1]); // no tool result
    }

    #[test]
    fn cut_point_keeps_recent_tokens() {
        // Several turns; a large keep budget keeps everything from the first turn.
        let entries = vec![
            user_entry("u1", "root", "turn one"),
            assistant_entry("a1", "u1"),
            user_entry("u2", "a1", "turn two"),
            assistant_entry("a2", "u2"),
            user_entry("u3", "a2", "turn three"),
        ];
        let keep_all = find_cut_point(&entries, 0, 5, 10_000);
        assert_eq!(keep_all.first_kept_entry_index, 0);
        assert!(!keep_all.is_split_turn);
        // A tiny budget keeps from the last cut point that crosses it —
        // here the final user message itself.
        let keep_little = find_cut_point(&entries, 0, 5, 1);
        assert!(keep_little.first_kept_entry_index > 0);
        assert!(!keep_little.is_split_turn);

        // An assistant-final session cuts mid-turn: the split needs a turn
        // start prefix summary.
        let assistant_final = vec![
            user_entry("u1", "root", "turn one"),
            assistant_entry("a1", "u1"),
            user_entry("u2", "a1", "turn two"),
            assistant_entry("a2", "u2"),
        ];
        let keep_small = find_cut_point(&assistant_final, 0, 4, 1);
        assert!(keep_small.is_split_turn);
        assert_eq!(keep_small.turn_start_index, Some(2));
    }

    #[test]
    fn summarization_prompt_shapes() {
        let initial = build_summarization_prompt(None, None);
        assert!(initial.contains("Create a structured context checkpoint summary"));
        assert!(initial.contains("the Python kernel keeps running"));
        let update = build_summarization_prompt(None, Some("old summary"));
        assert!(update.contains("NEW conversation messages to incorporate"));
        let custom = build_summarization_prompt(Some("focus on tests"), None);
        assert!(custom.contains("<user-instructions>\nThe user provided these instructions"));
        assert!(custom.contains("focus on tests"));
    }

    #[test]
    fn last_assistant_usage_skips_aborted() {
        let entries = vec![
            assistant_entry("a1", "root"),
            message_entry(
                "a2",
                "a1",
                AgentMessage::Assistant(pa_types::ai::AssistantMessage {
                    content: vec![],
                    api: "openai-completions".to_string(),
                    provider: "p".to_string(),
                    model: "m".to_string(),
                    response_model: None,
                    response_id: None,
                    diagnostics: None,
                    usage: pa_types::ai::Usage {
                        input: 1,
                        output: 1,
                        cache_read: 0,
                        cache_write: 0,
                        total_tokens: 2,
                        cost: Default::default(),
                    },
                    stop_reason: pa_types::ai::StopReason::Aborted,
                    stop_reason_raw: None,
                    error_message: None,
                    timestamp: 0,
                    rest: Default::default(),
                }),
            ),
        ];
        let usage = get_last_assistant_usage(&entries).unwrap();
        assert_eq!(usage.total_tokens, 150);
    }
}
