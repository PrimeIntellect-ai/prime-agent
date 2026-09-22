//! Model helpers: cost calculation over the shared model types.
//! Ported from `packages/ai/src/models.ts` (model registry plumbing excluded —
//! the generated catalog is ported separately). Thinking-level support,
//! clamping, and model equality moved to `pa_types::ai::thinking_levels`
//! (pure functions over the shared `Model` type, needed above `pa-ai` too);
//! they stay re-exported here for provider code.

use pa_types::JsNumber;

pub use pa_types::ai::thinking_levels::{
    clamp_thinking_level, get_supported_thinking_levels, models_are_equal, thinking_level_from_str,
    thinking_level_map, EXTENDED_THINKING_LEVELS, SUPPORTED_THINKING_LEVELS,
};

use crate::types::{Model, Usage, UsageCost};

#[derive(Debug, Clone, Default)]
pub struct CostOverrides {
    pub cache_write: Option<f64>,
}

/// Compute and write the cost breakdown for a usage, in place on `usage.cost`.
pub fn calculate_cost(model: &Model, usage: &mut Usage, overrides: Option<&CostOverrides>) {
    usage.cost = calculate_cost_values(model, usage, overrides);
}

pub fn calculate_cost_values(
    model: &Model,
    usage: &Usage,
    overrides: Option<&CostOverrides>,
) -> UsageCost {
    let cache_write_cost = overrides
        .and_then(|overrides| overrides.cache_write)
        .unwrap_or_else(|| model.cost.cache_write.as_f64());
    let input = (model.cost.input.as_f64() / 1_000_000.0) * usage.input as f64;
    let output = (model.cost.output.as_f64() / 1_000_000.0) * usage.output as f64;
    let cache_read = (model.cost.cache_read.as_f64() / 1_000_000.0) * usage.cache_read as f64;
    let cache_write = (cache_write_cost / 1_000_000.0) * usage.cache_write as f64;
    UsageCost {
        input: JsNumber::from(input),
        output: JsNumber::from(output),
        cache_read: JsNumber::from(cache_read),
        cache_write: JsNumber::from(cache_write),
        total: JsNumber::from(input + output + cache_read + cache_write),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ModelCost, ModelInput, ModelThinkingLevel};
    use pa_types::JsNumber;

    fn model(
        reasoning: bool,
        map: Option<std::collections::BTreeMap<ModelThinkingLevel, Option<String>>>,
    ) -> Model {
        Model {
            id: "m".into(),
            name: "m".into(),
            api: "openai-completions".into(),
            provider: "test".into(),
            base_url: "http://localhost".into(),
            reasoning,
            thinking_level_map: map,
            input: vec![ModelInput::Text],
            cost: ModelCost {
                input: JsNumber::from(0.0),
                output: JsNumber::from(0.0),
                cache_read: JsNumber::from(0.0),
                cache_write: JsNumber::from(0.0),
            },
            context_window: 128_000,
            max_tokens: 8192,
            featured: None,
            headers: None,
            compat: None,
        }
    }

    #[test]
    fn computes_cost() {
        let model = Model {
            cost: ModelCost {
                input: JsNumber::from(10.0),
                output: JsNumber::from(50.0),
                cache_read: JsNumber::from(1.0),
                cache_write: JsNumber::from(12.5),
            },
            ..model(false, None)
        };
        let mut usage = Usage {
            input: 1_000_000,
            output: 100_000,
            cache_read: 10_000,
            cache_write: 20_000,
            ..Usage::default()
        };
        calculate_cost(&model, &mut usage, None);
        assert!((usage.cost.input.as_f64() - 10.0).abs() < 1e-9);
        assert!((usage.cost.output.as_f64() - 5.0).abs() < 1e-9);
        assert!((usage.cost.cache_read.as_f64() - 0.01).abs() < 1e-9);
        assert!((usage.cost.cache_write.as_f64() - 0.25).abs() < 1e-9);
        assert!((usage.cost.total.as_f64() - (10.0 + 5.0 + 0.01 + 0.25)).abs() < 1e-9);
    }

    #[test]
    fn thinking_helpers_stay_re_exported() {
        // The pa-types move keeps the pa_ai::models call sites working.
        let m = model(false, None);
        assert_eq!(
            get_supported_thinking_levels(&m),
            vec![pa_types::ai::ModelThinkingLevel::Off]
        );
        assert!(models_are_equal(Some(&m), Some(&m)));
    }
}
