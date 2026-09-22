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

    #[test]
    fn unknown_lookups_are_none() {
        assert!(get_model("nope", "nope").is_none());
        assert!(get_models("nope").is_empty());
    }
}
