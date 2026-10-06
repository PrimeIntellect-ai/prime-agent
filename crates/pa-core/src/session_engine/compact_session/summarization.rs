//! Compact-session summarization math: the two summary calls'
//! completion budgets, the chars/4 request estimate, and the
//! exact-request window estimator the auxiliary-model routing consults.
use super::AgentMessage;

/// The history summary's completion budget (TS `generateSummary`:
/// `Math.floor(0.8 * reserveTokens)`): multiply before dividing, so sub-5
/// budgets round toward the true floor instead of collapsing to zero.
pub(crate) fn history_summary_completion_budget(reserve_tokens: u64) -> u64 {
    reserve_tokens.saturating_mul(4) / 5
}

/// The split-turn prefix summary's completion budget.
pub(crate) fn turn_prefix_summary_completion_budget(reserve_tokens: u64) -> u64 {
    reserve_tokens / 2
}

/// The chars the summarizer request text occupies at the chars/4
/// heuristic.
pub(crate) fn summarizer_request_tokens(request: &[AgentMessage]) -> u64 {
    let chars: usize = request
        .iter()
        .map(|message| match message {
            AgentMessage::User(user) => user.content.text().chars().count(),
            _ => 0,
        })
        .sum();
    (chars as u64).div_ceil(4)
}

/// Estimate the context window the compaction's summary calls need: the exact
/// request bodies — the largest slice wins. `recent_state_anchor` mirrors the
/// anchor block the history request carries; skipping it under-accepts a model.
pub fn estimate_summary_request_tokens(
    history: &[AgentMessage],
    turn_prefix: &[AgentMessage],
    is_split_turn: bool,
    previous_summary: Option<&str>,
    recent_state_anchor: Option<&str>,
    custom_instructions: Option<&str>,
    reserve_tokens: u64,
) -> u64 {
    let system_prompt_tokens = (super::compaction_utils::SUMMARIZATION_SYSTEM_PROMPT
        .chars()
        .count() as u64)
        .div_ceil(4);
    let mut required = 0u64;
    // The history slice runs for every compaction except a split turn whose
    // kept cut leaves no history (the literal stand-in makes no wire call).
    let issues_history_call = !history.is_empty() || !is_split_turn || turn_prefix.is_empty();
    if issues_history_call {
        let request = super::compaction_exec::build_summarization_request(
            history,
            custom_instructions,
            previous_summary,
            recent_state_anchor,
            reserve_tokens,
        );
        required = required.max(
            system_prompt_tokens
                + summarizer_request_tokens(&request)
                + history_summary_completion_budget(reserve_tokens),
        );
    }
    // The prefix summary is a separate request with its own body and a
    // smaller completion budget, so it can exceed the history slice.
    if !turn_prefix.is_empty() {
        let request = super::compaction_exec::build_turn_prefix_request(turn_prefix);
        required = required.max(
            system_prompt_tokens
                + summarizer_request_tokens(&request)
                + turn_prefix_summary_completion_budget(reserve_tokens),
        );
    }
    required
}
