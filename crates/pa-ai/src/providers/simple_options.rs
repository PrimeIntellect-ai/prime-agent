//! Shared simple-stream option assembly.
//! Ported from `packages/ai/src/providers/simple-options.ts`.

use crate::types::{
    Model, ModelThinkingLevel, SimpleStreamOptions, StreamOptions, ThinkingBudgets,
};

/// The default ceiling on requested output tokens (TS
/// `DEFAULT_MAX_OUTPUT_TOKENS`): most catalog models advertise a far larger
/// `maxTokens` than a turn needs, so requests are capped unless the value
/// was configured explicitly.
pub const REQUEST_MAX_TOKENS_CAP: u64 = 32_000;

/// The smallest output budget a request may keep after clamping (TS
/// `adjustMaxTokensForThinking`: `minOutputTokens`).
pub const MIN_OUTPUT_TOKENS: u64 = 1_024;

/// The default per-request output budget for a model (TS `resolveMaxTokens`):
/// an explicitly configured `maxTokens` passes through unchanged; a catalog
/// value is capped at [`REQUEST_MAX_TOKENS_CAP`]; `None` when the model
/// declares no max output (providers that default server-side).
#[must_use]
pub fn default_request_max_tokens(model: &Model) -> Option<u64> {
    if model.max_tokens == 0 {
        return None;
    }
    if model.max_tokens_explicit {
        return Some(model.max_tokens);
    }
    Some(model.max_tokens.min(REQUEST_MAX_TOKENS_CAP))
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
        api_key: Some(
            api_key
                .map(std::string::ToString::to_string)
                .unwrap_or_default(),
        )
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
    // Saturating: an explicitly configured `maxTokens` may be any nonzero
    // u64, so the base + budget sum can reach the integer ceiling before
    // the model-max clamp ever runs.
    let max_tokens = base_max_tokens
        .saturating_add(thinking_budget)
        .min(model_max_tokens);
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

/// The `max_tokens` the provider will actually send for a request against
/// `model` with this reasoning level: budget-folding providers (Anthropic
/// and Bedrock models without adaptive thinking) add the level's thinking
/// budget on top of the base per-request budget, capped at the model's
/// declared max output ([`adjust_max_tokens_for_thinking`]); every other
/// provider (and reasoning off) sends the base budget itself. Compaction
/// thresholds must reserve this effective budget, or a request can claim
/// `input + max_tokens > contextWindow` while the trigger still says
/// "not due".
#[must_use]
pub fn effective_request_max_tokens(model: &Model, reasoning: ModelThinkingLevel) -> u64 {
    let base = default_request_max_tokens(model).unwrap_or(0);
    if matches!(reasoning, ModelThinkingLevel::Off) || base == 0 {
        return base;
    }
    let budget_folds = match model.api.as_str() {
        "anthropic" => !crate::providers::anthropic::supports_adaptive_thinking(&model.id),
        // The Bedrock fold runs only on Claude models without adaptive
        // thinking (`streamSimpleBedrock`'s own gate).
        "bedrock" => {
            crate::providers::bedrock::is_anthropic_claude_model(model)
                && !crate::providers::bedrock::supports_adaptive_thinking(
                    &model.id,
                    Some(&model.name),
                )
        }
        _ => false,
    };
    if !budget_folds {
        return base;
    }
    match adjust_max_tokens_for_thinking(base, model.max_tokens, reasoning, None) {
        Ok((max_tokens, _thinking_budget)) => max_tokens.max(base),
        Err(_) => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(api: &str, id: &str, max_tokens: u64) -> Model {
        serde_json::from_value(json!({
            "id": id, "name": id, "api": api, "provider": "p",
            "baseUrl": "http://localhost", "reasoning": true, "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 200_000, "maxTokens": max_tokens,
        }))
        .expect("test model")
    }

    fn explicit_model(api: &str, id: &str, max_tokens: u64) -> Model {
        serde_json::from_value(json!({
            "id": id, "name": id, "api": api, "provider": "p",
            "baseUrl": "http://localhost", "reasoning": true, "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 200_000, "maxTokens": max_tokens,
            "maxTokensExplicit": true,
        }))
        .expect("test model")
    }

    #[test]
    fn a_catalog_model_is_capped_at_the_default_output_ceiling() {
        // TS resolveMaxTokens: a catalog value above the ceiling clamps to
        // 32000 — most catalog models advertise far more than a turn needs.
        let catalog = model("openai-completions", "gpt-x", 131_072);
        assert_eq!(default_request_max_tokens(&catalog), Some(32_000));
        assert_eq!(
            build_base_options(&catalog, None, None).max_tokens,
            Some(32_000)
        );
    }

    #[test]
    fn an_explicitly_configured_max_tokens_passes_through_unchanged() {
        // The #755 fix: a configured value bypasses the ceiling — the
        // reporter's models.json entry asking for 131072 arrives whole.
        let explicit = explicit_model("openai-completions", "glm-5.2", 131_072);
        assert_eq!(default_request_max_tokens(&explicit), Some(131_072));
        assert_eq!(
            build_base_options(&explicit, None, None).max_tokens,
            Some(131_072)
        );
    }

    #[test]
    fn an_explicit_model_below_the_ceiling_keeps_its_value() {
        // min semantics: an explicit 8000 stays 8000.
        let small = explicit_model("openai-completions", "glm-5.2", 8_000);
        assert_eq!(
            build_base_options(&small, None, None).max_tokens,
            Some(8_000)
        );
    }

    #[test]
    fn a_model_without_max_tokens_has_no_output_budget_even_when_flagged() {
        // maxTokens <= 0 sends no cap field (providers default server-side).
        let bare = model("openai-completions", "gpt-x", 0);
        assert_eq!(default_request_max_tokens(&bare), None);
        assert_eq!(build_base_options(&bare, None, None).max_tokens, None);
        let flagged = explicit_model("openai-completions", "glm-5.2", 0);
        assert_eq!(build_base_options(&flagged, None, None).max_tokens, None);
    }

    #[test]
    fn the_effective_budget_reserves_an_explicit_output_ceiling_too() {
        // The compaction threshold consumer (`effective_request_max_tokens`)
        // must reserve the LARGER explicit budget, or a request can claim
        // input + 131072 > contextWindow while the trigger says "not due".
        // The thinking fold still caps at the model's declared max output.
        let explicit = explicit_model("anthropic", "claude-sonnet-4-5", 131_072);
        assert_eq!(
            effective_request_max_tokens(&explicit, ModelThinkingLevel::Off),
            131_072
        );
        assert_eq!(
            effective_request_max_tokens(&explicit, ModelThinkingLevel::High),
            131_072
        );
        // The fold itself still caps at the model's declared max output:
        // an explicit base IS the model's max (the flag rides the same
        // value), so the thinking fold cannot exceed it.
        let roomy = explicit_model("anthropic", "claude-sonnet-4-5", 96_000);
        assert_eq!(
            effective_request_max_tokens(&roomy, ModelThinkingLevel::Medium),
            96_000
        );
    }

    #[test]
    fn an_explicit_budget_at_the_integer_ceiling_never_overflows_the_fold() {
        // An explicitly configured maxTokens may be any nonzero u64, so the
        // thinking fold's base + budget addition must saturate before the
        // model-max clamp.
        let huge = explicit_model("anthropic", "claude-sonnet-4-5", u64::MAX);
        assert_eq!(
            effective_request_max_tokens(&huge, ModelThinkingLevel::High),
            u64::MAX
        );
        // The fold itself stays bounded at the model's declared max: the
        // wrapped sum (a few thousand) must never stand in for a huge one.
        let (max_tokens, _) = adjust_max_tokens_for_thinking(
            u64::MAX - 100,
            u64::MAX - 100,
            ModelThinkingLevel::High,
            None,
        )
        .unwrap();
        assert_eq!(max_tokens, u64::MAX - 100);
    }

    #[test]
    fn budget_folding_providers_add_the_thinking_budget_on_top() {
        // A non-adaptive Anthropic model: `high` folds 16_384 thinking
        // tokens onto the 32_000 base budget (adjustMaxTokensForThinking).
        let anthropic = model("anthropic", "claude-sonnet-4-5", 65_536);
        assert_eq!(
            effective_request_max_tokens(&anthropic, ModelThinkingLevel::Off),
            32_000
        );
        assert_eq!(
            effective_request_max_tokens(&anthropic, ModelThinkingLevel::Medium),
            32_000 + 8_192
        );
        assert_eq!(
            effective_request_max_tokens(&anthropic, ModelThinkingLevel::High),
            32_000 + 16_384
        );
    }

    #[test]
    fn the_fold_caps_at_the_model_max_output() {
        // The model's own ceiling binds before the base + thinking sum.
        let small = model("anthropic", "claude-sonnet-4-5", 36_000);
        assert_eq!(
            effective_request_max_tokens(&small, ModelThinkingLevel::High),
            36_000
        );
    }

    #[test]
    fn adaptive_and_non_budget_providers_keep_the_base_budget() {
        // Adaptive-thinking Anthropic models use effort, not budgets.
        let adaptive = model("anthropic", "claude-opus-4-6", 65_536);
        assert_eq!(
            effective_request_max_tokens(&adaptive, ModelThinkingLevel::High),
            32_000
        );
        // OpenAI-style reasoning consumes the budget from within, never on
        // top of it.
        let openai = model("openai-completions", "gpt-x", 65_536);
        assert_eq!(
            effective_request_max_tokens(&openai, ModelThinkingLevel::High),
            32_000
        );
    }

    #[test]
    fn a_per_request_max_tokens_wins_over_the_model_value_and_the_ceiling() {
        // TS `buildBaseOptions`: a per-request `options.maxTokens` keeps
        // precedence over both the model's declared value and the default
        // ceiling (the bypass #755's reporter observed, unchanged by the
        // explicit-flag fix).
        let openai = model("openai-completions", "gpt-x", 65_536);
        let options = SimpleStreamOptions {
            base: crate::types::StreamOptions {
                max_tokens: Some(64_000),
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(
            build_base_options(&openai, Some(&options), None).max_tokens,
            Some(64_000)
        );
    }

    #[test]
    fn a_model_without_a_declared_max_output_has_no_budget_to_fold() {
        let bare = model("anthropic", "claude-sonnet-4-5", 0);
        assert_eq!(
            effective_request_max_tokens(&bare, ModelThinkingLevel::High),
            0
        );
    }
}
