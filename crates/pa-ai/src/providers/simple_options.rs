//! Shared simple-stream option assembly.
//! Ported from `packages/ai/src/providers/simple-options.ts`.

use crate::types::{
    Model, ModelThinkingLevel, SimpleStreamOptions, StreamOptions, ThinkingBudgets,
};

/// The per-request output cap when the caller sets no `max_tokens` (TS
/// `buildBaseOptions`: `Math.min(model.maxTokens, 32000)`).
pub const REQUEST_MAX_TOKENS_CAP: u64 = 32_000;

/// The smallest output budget a request may keep after clamping (TS
/// `adjustMaxTokensForThinking`: `minOutputTokens`).
pub const MIN_OUTPUT_TOKENS: u64 = 1_024;

/// The default per-request output budget for a model (TS `buildBaseOptions`):
/// the model's max output capped at [`REQUEST_MAX_TOKENS_CAP`], or `None` when
/// the model declares no max output (providers that default server-side).
pub fn default_request_max_tokens(model: &Model) -> Option<u64> {
    (model.max_tokens > 0).then(|| model.max_tokens.min(REQUEST_MAX_TOKENS_CAP))
}

pub fn build_base_options(
    model: &Model,
    options: Option<&SimpleStreamOptions>,
    api_key: Option<&str>,
) -> StreamOptions {
    let base = options
        .map(|options| options.base.clone())
        .unwrap_or_default();
    StreamOptions {
        temperature: base.temperature,
        max_tokens: match base.max_tokens {
            Some(tokens) => Some(tokens),
            None => default_request_max_tokens(model),
        },
        signal: base.signal,
        api_key: Some(api_key.map(|key| key.to_string()).unwrap_or_default())
            .filter(|key| !key.is_empty())
            .or(base.api_key),
        transport: base.transport,
        service_tier: base.service_tier,
        cache_retention: base.cache_retention,
        session_id: base.session_id,
        on_payload: base.on_payload,
        on_response: base.on_response,
        headers: base.headers,
        timeout_ms: base.timeout_ms,
        metadata: base.metadata,
    }
}

/// Clamp `xhigh`/`max` to `high` (mirrors `clampReasoning`).
pub fn clamp_reasoning(effort: ModelThinkingLevel) -> ModelThinkingLevel {
    match effort {
        ModelThinkingLevel::Xhigh | ModelThinkingLevel::Max => ModelThinkingLevel::High,
        other => other,
    }
}

/// Budget-based thinking token adjustment (mirrors `adjustMaxTokensForThinking`).
///
/// Returns an error mirroring the TS throw when there is not enough room for
/// thinking tokens plus the response.
pub fn adjust_max_tokens_for_thinking(
    base_max_tokens: u64,
    model_max_tokens: u64,
    reasoning_level: ModelThinkingLevel,
    custom_budgets: Option<&ThinkingBudgets>,
) -> Result<(u64, u64), String> {
    let default_budgets = ThinkingBudgets {
        minimal: Some(1024),
        low: Some(2048),
        medium: Some(8192),
        high: Some(16384),
    };
    let budgets = match custom_budgets {
        Some(custom) => ThinkingBudgets {
            minimal: custom.minimal.or(default_budgets.minimal),
            low: custom.low.or(default_budgets.low),
            medium: custom.medium.or(default_budgets.medium),
            high: custom.high.or(default_budgets.high),
        },
        None => default_budgets,
    };
    let min_output_tokens = MIN_OUTPUT_TOKENS;
    let min_thinking_tokens = 1024u64;
    let level = clamp_reasoning(reasoning_level);
    let level_budget = match level {
        ModelThinkingLevel::Minimal => budgets.minimal,
        ModelThinkingLevel::Low => budgets.low,
        ModelThinkingLevel::Medium => budgets.medium,
        ModelThinkingLevel::High | ModelThinkingLevel::Xhigh | ModelThinkingLevel::Max => {
            budgets.high
        }
        ModelThinkingLevel::Off => None,
    }
    .unwrap_or(min_thinking_tokens);
    let mut thinking_budget = level_budget.max(min_thinking_tokens);
    let max_tokens = (base_max_tokens + thinking_budget).min(model_max_tokens);
    if max_tokens <= min_thinking_tokens {
        return Err(
            "Budget-based thinking requires at least 1024 thinking tokens plus room for the response"
                .to_string(),
        );
    }
    if max_tokens <= thinking_budget {
        thinking_budget = (max_tokens.saturating_sub(min_output_tokens)).max(min_thinking_tokens);
    }
    Ok((max_tokens, thinking_budget))
}
