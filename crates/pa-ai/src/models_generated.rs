//! Static model catalog ported from `packages/ai/src/models.generated.ts`.
//!
//! The TS catalog is an object literal (32 providers, 1281 models); the Rust
//! port keeps the same data as JSON in [`models.generated.json`] (regenerate
//! with `scripts/generate-models.py`) and deserializes it into
//! [`pa_types::ai::Model`] values on first use. The wire shapes match the TS
//! exactly (camelCase fields), so no per-field conversion is needed.
//!
//! This file is generated data plumbing; it is exempt from the module-size
//! split rule because its size is a direct function of the TS catalog size,
//! not of hand-written logic.

use std::collections::HashMap;
use std::sync::LazyLock;

use crate::types::Model;

const MODELS_JSON: &str = include_str!("models.generated.json");

type ProviderCatalog = HashMap<String, HashMap<String, Model>>;

fn catalog() -> &'static ProviderCatalog {
    static CATALOG: LazyLock<ProviderCatalog> = LazyLock::new(|| {
        let parsed: ProviderCatalog = serde_json::from_str(MODELS_JSON)
            .expect("models.generated.json is valid and matches the Model serde shape");
        parsed
    });
    &CATALOG
}

/// Look up a model by provider and model id (`getModel` in the TS).
pub fn get_model(provider: &str, model_id: &str) -> Option<&'static Model> {
    catalog().get(provider)?.get(model_id)
}

/// All providers in the catalog (`getProviders` in the TS).
pub fn get_providers() -> Vec<&'static str> {
    let mut providers: Vec<&'static str> = catalog().keys().map(String::as_str).collect();
    providers.sort_unstable();
    providers
}

/// All models for one provider, in catalog order (`getModels` in the TS).
pub fn get_models(provider: &str) -> Vec<&'static Model> {
    let Some(models) = catalog().get(provider) else {
        return Vec::new();
    };
    // JSON object order equals insertion order in serde_json? No: keys are
    // sorted during parse, so keep the same stable ordering as the TS catalog
    // by sorting by id (matches the generated file's alphabetical layout).
    let mut models: Vec<&'static Model> = models.values().collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ModelExt;

    #[test]
    fn catalog_loads_and_matches_ts_scale() {
        let providers = get_providers();
        assert!(providers.len() >= 30, "expected the full TS provider list");
        let total: usize = providers
            .iter()
            .map(|provider| get_models(provider).len())
            .sum();
        assert!(
            total >= 1200,
            "expected the full TS model list, got {total}"
        );
    }

    #[test]
    fn looks_up_known_models() {
        let model = get_model("anthropic", "claude-fable-5-1")
            .or_else(|| get_model("amazon-bedrock", "anthropic.claude-fable-5-1"))
            .expect("fable model present");
        assert!(model.reasoning);
        assert!(model.context_window > 0);
        assert!(model.cost.input.as_f64() >= 0.0);
    }

    /// Port of #2505: grok-4.7 is selectable on every provider that
    /// serves it — the xAI API key, OpenRouter, the Vercel AI Gateway,
    /// and OpenCode Go — with the regenerated catalog's context and
    /// pricing metadata. (The TS grok-subscription surface builds its
    /// rows from these at runtime; the Rust branch has no ported xAI
    /// OAuth login yet.)
    #[test]
    fn grok_4_7_is_served_on_every_serving_provider() {
        let direct = get_model("xai", "grok-4.7").expect("the xAI API key serves grok-4.7");
        assert_eq!(direct.name, "Grok 4.7");
        assert!(direct.reasoning);
        assert_eq!(direct.context_window, 500_000);
        assert_eq!(direct.max_tokens, 500_000);

        let openrouter =
            get_model("openrouter", "x-ai/grok-4.7").expect("OpenRouter serves grok-4.7");
        assert!(openrouter.reasoning);
        assert_eq!(openrouter.context_window, 500_000);

        let gateway =
            get_model("vercel-ai-gateway", "spacexai/grok-4.7").expect("the gateway serves it");
        assert!(gateway.reasoning);
        assert_eq!(gateway.context_window, 500_000);

        let opencode = get_model("opencode-go", "grok-4.7").expect("OpenCode Go serves it");
        assert!(opencode.reasoning);
        assert_eq!(opencode.context_window, 500_000);
    }

    #[test]
    fn unknown_lookups_are_none() {
        assert!(get_model("nope", "nope").is_none());
        assert!(get_models("nope").is_empty());
    }

    /// Port of the #2519 regenerated catalog: Prime Inference GLM routes
    /// declare their reasoning controls from the live catalog — glm-5.3 is
    /// an effort route, glm-4.7 a reasoning-object toggle.
    #[test]
    fn prime_inference_glm_routes_declare_catalog_reasoning_controls() {
        let glm_53 = get_model("prime-inference", "z-ai/glm-5.3").expect("compiled");
        let Some(crate::types::CompatKind::OpenAiCompletions(compat)) = glm_53.compat_kind() else {
            panic!("glm-5.3 carries a compat object");
        };
        assert_eq!(compat.supports_reasoning_effort, Some(true));
        assert_eq!(compat.thinking_format, None);
        assert_eq!(
            glm_53
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get(&crate::types::ModelThinkingLevel::High)),
            Some(&Some("high".to_string()))
        );

        let glm_47 = get_model("prime-inference", "z-ai/glm-4.7").expect("compiled");
        let Some(crate::types::CompatKind::OpenAiCompletions(compat)) = glm_47.compat_kind() else {
            panic!("glm-4.7 carries a compat object");
        };
        assert_eq!(compat.supports_reasoning_effort, Some(false));
        assert_eq!(
            compat.thinking_format,
            Some(crate::types::ThinkingFormat::Openrouter)
        );
        assert!(
            glm_47
                .thinking_level_map
                .as_ref()
                .expect("toggle routes carry a thinking-level map")
                .get(&crate::types::ModelThinkingLevel::Off)
                .is_none(),
            "toggle routes expose no off level"
        );
    }

    /// Port of the TS fix (#2459): Prime Inference rejects `enable_thinking`
    /// with a 400, so no prime-inference route may carry the zai thinking
    /// format in its compat — request shaping would send the parameter on
    /// every reasoning request.
    #[test]
    fn prime_inference_routes_never_carry_the_zai_thinking_format() {
        for model in get_models("prime-inference") {
            let Some(crate::types::CompatKind::OpenAiCompletions(compat)) = model.compat_kind()
            else {
                continue;
            };
            assert_ne!(
                compat.thinking_format,
                Some(crate::types::ThinkingFormat::Zai),
                "prime-inference model {} must not carry the zai thinking format",
                model.id
            );
        }
        // The direct z.ai provider keeps the toggle.
        let glm = get_model("zai", "glm-5.3").expect("direct zai glm-5.3 is compiled");
        assert!(matches!(
            glm.compat_kind(),
            Some(crate::types::CompatKind::OpenAiCompletions(compat))
                if compat.thinking_format == Some(crate::types::ThinkingFormat::Zai)
        ));
    }
}
