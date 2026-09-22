//! Transport pinning — the security invariant of the catalog.
//!
//! Ported from `parseProviderModelCatalog` in
//! `provider-model-catalog.ts`: every remote model must match a compiled
//! `(provider, api, baseUrl)` tuple. Non-matching entries drop silently;
//! request headers come from the compiled transport templates
//! (`template?.headers ?? transport.headers`), never from catalog data;
//! prime-inference entries are skipped (that domain is fetched live).

use std::collections::HashMap;

use crate::schema::{parse_model_catalog, InvalidEntries};
use crate::Model;

/// The compiled `(provider, api, baseUrl)` template tables for pinning.
#[derive(Clone, Default)]
pub struct PinnedTemplates {
    /// `(provider, api, baseUrl)` -> transport template.
    transports: HashMap<(String, String, String), Model>,
    /// `(provider, id)` -> exact model template.
    exact: HashMap<(String, String), Model>,
}

impl PinnedTemplates {
    /// Index the compiled catalog (production use).
    pub fn from_compiled() -> Self {
        Self::from_models(crate::transports::compiled_models().iter().cloned())
    }

    /// Index an arbitrary template list (tests).
    pub fn from_models<I: IntoIterator<Item = Model>>(models: I) -> Self {
        let mut pinned = PinnedTemplates::default();
        for model in models {
            pinned
                .exact
                .insert((model.provider.clone(), model.id.clone()), model.clone());
            pinned.transports.insert(
                (
                    model.provider.clone(),
                    model.api.clone(),
                    model.base_url.clone(),
                ),
                model,
            );
        }
        pinned
    }
}

/// Catalog data can select installed transports, but cannot change where
/// credentials are sent: parse the payload with skip-invalid semantics and
/// keep only entries whose `(provider, api, baseUrl)` matches a compiled
/// tuple. `Err` means the catalog carried nothing this client supports.
pub fn parse_provider_model_catalog(
    payload: &serde_json::Value,
    templates: &PinnedTemplates,
) -> Result<Vec<Model>, String> {
    let catalog = parse_model_catalog(payload, InvalidEntries::SkipInvalid)?;
    pin_catalog_models(catalog.models, templates)
}

/// Pin an already-parsed catalog's models to compiled transports.
pub fn pin_catalog_models(
    catalog_models: Vec<Model>,
    templates: &PinnedTemplates,
) -> Result<Vec<Model>, String> {
    let mut models = Vec::with_capacity(catalog_models.len());
    for model in catalog_models {
        // Prime Inference is fetched live with credentials; the remote
        // catalog never carries it.
        if model.provider == "prime-inference" {
            continue;
        }
        let key = (
            model.provider.clone(),
            model.api.clone(),
            model.base_url.clone(),
        );
        let Some(transport) = templates.transports.get(&key) else {
            // Non-matching tuples drop silently: the catalog can never
            // introduce a transport.
            continue;
        };
        let exact = templates
            .exact
            .get(&(model.provider.clone(), model.id.clone()));
        let mut pinned = model;
        pinned.headers = exact
            .and_then(|template| template.headers.clone())
            .or_else(|| transport.headers.clone());
        models.push(pinned);
    }
    if models.is_empty() {
        return Err("Catalog has no models supported by this client".into());
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn compiled_fixture() -> PinnedTemplates {
        let mut headers = BTreeMap::new();
        headers.insert("User-Agent".to_string(), "cli/1".to_string());
        let mut exact_headers = BTreeMap::new();
        exact_headers.insert("User-Agent".to_string(), "special/2".to_string());
        let entry = |id: &str,
                     api: &str,
                     provider: &str,
                     base_url: &str,
                     headers: Option<BTreeMap<String, String>>| {
            Model {
                id: id.into(),
                name: id.into(),
                api: api.into(),
                provider: provider.into(),
                base_url: base_url.into(),
                reasoning: false,
                thinking_level_map: None,
                input: vec![],
                cost: pa_ai::types::zero_model_cost(),
                context_window: 1,
                max_tokens: 1,
                featured: None,
                headers,
                compat: None,
            }
        };
        PinnedTemplates::from_models(vec![
            entry(
                "known",
                "openai-completions",
                "prov",
                "https://prov.example",
                Some(headers),
            ),
            entry(
                "exact",
                "openai-completions",
                "prov",
                "https://prov.example",
                Some(exact_headers),
            ),
        ])
    }

    fn catalog_entry(id: &str, api: &str, provider: &str, base_url: &str) -> serde_json::Value {
        json!({
            "id": id,
            "name": id,
            "api": api,
            "provider": provider,
            "baseUrl": base_url,
            "reasoning": false,
            "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 128_000,
            "maxTokens": 4_096,
        })
    }

    #[test]
    fn keeps_only_compiled_tuples() {
        let templates = compiled_fixture();
        let payload = json!({"schemaVersion": 1, "models": [
            catalog_entry("known", "openai-completions", "prov", "https://prov.example"),
            catalog_entry("unknown", "openai-completions", "prov", "https://elsewhere.example"),
            catalog_entry("prime", "openai-completions", "prime-inference", "https://api.pinference.ai/api/v1"),
        ]});
        let models = parse_provider_model_catalog(&payload, &templates).expect("pinned");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "known");
        assert_eq!(
            models[0]
                .headers
                .as_ref()
                .unwrap()
                .get("User-Agent")
                .unwrap(),
            "cli/1"
        );
    }

    #[test]
    fn exact_template_headers_win_over_transport_headers() {
        let templates = compiled_fixture();
        let payload = json!({"schemaVersion": 1, "models": [
            catalog_entry("exact", "openai-completions", "prov", "https://prov.example"),
        ]});
        let models = parse_provider_model_catalog(&payload, &templates).expect("pinned");
        assert_eq!(
            models[0]
                .headers
                .as_ref()
                .unwrap()
                .get("User-Agent")
                .unwrap(),
            "special/2"
        );
    }

    #[test]
    fn empty_result_is_an_error() {
        let templates = compiled_fixture();
        let payload = json!({"schemaVersion": 1, "models": [
            catalog_entry("unknown", "openai-completions", "prov", "https://elsewhere.example"),
        ]});
        assert!(parse_provider_model_catalog(&payload, &templates).is_err());
    }

    #[test]
    fn catalog_never_carries_headers() {
        let templates = compiled_fixture();
        let mut evil = catalog_entry(
            "known",
            "openai-completions",
            "prov",
            "https://prov.example",
        );
        evil.as_object_mut()
            .unwrap()
            .insert("headers".into(), json!({"X-Evil": "1"}));
        let payload = json!({"schemaVersion": 1, "models": [
            evil,
            catalog_entry("exact", "openai-completions", "prov", "https://prov.example"),
        ]});
        let models = parse_provider_model_catalog(&payload, &templates).expect("pinned");
        assert_eq!(models.len(), 1, "the headers-carrying entry is dropped");
        assert_eq!(models[0].id, "exact");
        assert!(!models[0]
            .headers
            .as_ref()
            .is_some_and(|headers| headers.contains_key("X-Evil")));
    }
}
