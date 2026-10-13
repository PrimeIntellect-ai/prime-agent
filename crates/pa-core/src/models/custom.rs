//! models.json: custom providers/models, provider and per-model overrides.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use pa_types::ai::{Model, ModelCompat, ModelCost, ModelInput};
use pa_types::JsNumber;

/// Strip `//` line comments and trailing commas, leaving strings intact.
#[must_use]
pub fn strip_json_comments(input: &str) -> String {
    // Pass 1: remove // comments. Pass 2: remove trailing commas before } or ].
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escaped = false;
    let bytes: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < bytes.len() && bytes[i + 1] == '/' {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    // Trailing commas: `,(\s*[}\]])` outside strings.
    let mut cleaned = String::with_capacity(out.len());
    let mut in_string = false;
    let mut escaped = false;
    let chars: Vec<char> = cleaned_with_positions(&out);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            cleaned.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            cleaned.push(c);
            i += 1;
            continue;
        }
        if c == ',' {
            // Look ahead past whitespace: a closer means drop the comma.
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                i += 1;
                continue;
            }
        }
        cleaned.push(c);
        i += 1;
    }
    cleaned
}

fn cleaned_with_positions(s: &str) -> Vec<char> {
    s.chars().collect()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelCostConfig {
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelDefinition {
    pub id: String,
    pub name: Option<String>,
    pub api: Option<String>,
    pub base_url: Option<String>,
    pub reasoning: Option<bool>,
    pub thinking_level_map: Option<BTreeMap<String, Option<String>>>,
    pub input: Option<Vec<String>>,
    pub cost: Option<ModelCostConfig>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub headers: Option<BTreeMap<String, String>>,
    pub compat: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelOverride {
    pub name: Option<String>,
    pub reasoning: Option<bool>,
    pub thinking_level_map: Option<BTreeMap<String, Option<String>>>,
    pub input: Option<Vec<String>>,
    pub cost: Option<ModelCostConfig>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub headers: Option<BTreeMap<String, String>>,
    pub compat: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub api: Option<String>,
    pub headers: Option<BTreeMap<String, String>>,
    pub compat: Option<serde_json::Value>,
    pub auth_header: Option<bool>,
    pub models: Option<Vec<ModelDefinition>>,
    pub model_overrides: Option<BTreeMap<String, ModelOverride>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelsConfig {
    pub providers: BTreeMap<String, ProviderConfig>,
}

#[derive(Debug, Default)]
pub struct CustomModelsResult {
    pub models: Vec<Model>,
    pub provider_overrides: HashMap<String, ProviderOverride>,
    pub model_overrides: HashMap<String, BTreeMap<String, ModelOverride>>,
    pub error: Option<String>,
}

/// Provider override config (baseUrl, compat) without request auth.
#[derive(Debug, Clone, Default)]
pub struct ProviderOverride {
    pub base_url: Option<String>,
    pub compat: Option<ModelCompat>,
}

/// Parse the models.json document (comment/trailing-comma tolerant).
///
/// # Errors
///
/// Human-readable error when the document is not valid JSON after stripping.
pub fn parse_models_config(content: &str) -> Result<ModelsConfig, String> {
    let stripped = strip_json_comments(content);
    serde_json::from_str(&stripped).map_err(|error| format!("Invalid models.json: {error}"))
}

/// Semantic checks beyond the schema.
///
/// # Errors
///
/// Error when a provider lacks its base URL, API key, or API kind, or a
/// model lacks an id or zero limits.
pub fn validate_config(
    config: &ModelsConfig,
    built_in_providers: &dyn Fn(&str) -> bool,
) -> Result<(), String> {
    for (provider_name, provider_config) in &config.providers {
        let is_built_in = built_in_providers(provider_name);
        let models = provider_config.models.as_deref().unwrap_or_default();
        let has_model_overrides = provider_config
            .model_overrides
            .as_ref()
            .is_some_and(|overrides| !overrides.is_empty());
        if models.is_empty() {
            if provider_config.base_url.is_none()
                && provider_config.headers.is_none()
                && provider_config.compat.is_none()
                && !has_model_overrides
            {
                return Err(format!(
                    "Provider {provider_name}: must specify \"baseUrl\", \"headers\", \"compat\", \"modelOverrides\", or \"models\"."
                ));
            }
        } else if !is_built_in {
            if provider_config.base_url.is_none() {
                return Err(format!(
                    "Provider {provider_name}: \"baseUrl\" is required when defining custom models."
                ));
            }
            if provider_config.api_key.is_none() {
                return Err(format!(
                    "Provider {provider_name}: \"apiKey\" is required when defining custom models."
                ));
            }
        }
        for model in models {
            let has_model_api = model.api.is_some();
            if provider_config.api.is_none() && !has_model_api && !is_built_in {
                return Err(format!(
                    "Provider {provider_name}, model {}: no \"api\" specified. Set at provider or model level.",
                    model.id
                ));
            }
            if model.id.is_empty() {
                return Err(format!("Provider {provider_name}: model missing \"id\""));
            }
            if let Some(window) = model.context_window {
                if window == 0 {
                    return Err(format!(
                        "Provider {provider_name}, model {}: invalid contextWindow",
                        model.id
                    ));
                }
            }
            if let Some(max_tokens) = model.max_tokens {
                if max_tokens == 0 {
                    return Err(format!(
                        "Provider {provider_name}, model {}: invalid maxTokens",
                        model.id
                    ));
                }
            }
        }
    }
    Ok(())
}

fn cost_from_config(config: &ModelCostConfig) -> ModelCost {
    ModelCost {
        input: JsNumber::from(config.input.unwrap_or(0.0)),
        output: JsNumber::from(config.output.unwrap_or(0.0)),
        cache_read: JsNumber::from(config.cache_read.unwrap_or(0.0)),
        cache_write: JsNumber::from(config.cache_write.unwrap_or(0.0)),
    }
}

fn model_inputs(values: Option<&Vec<String>>) -> Vec<ModelInput> {
    values.map_or_else(
        || vec![ModelInput::Text],
        |items| {
            items
                .iter()
                .map(|item| match item.as_str() {
                    "image" => ModelInput::Image,
                    _ => ModelInput::Text,
                })
                .collect()
        },
    )
}

fn compat_from_value(value: Option<&serde_json::Value>) -> Option<ModelCompat> {
    let value = value?;
    serde_json::from_value(value.clone()).ok()
}

/// Compat merge: override fields win; nested routing objects merge.
#[must_use]
pub fn merge_compat(base: Option<&ModelCompat>, over: Option<ModelCompat>) -> Option<ModelCompat> {
    let over = over?;
    let mut merged = base.map(|compat| compat.raw.clone()).unwrap_or_default();
    for (key, value) in over.raw {
        // Routing sub-objects merge instead of replacing.
        if matches!(key.as_str(), "openRouterRouting" | "vercelGatewayRouting") {
            if let (Some(existing), Some(incoming)) = (
                merged.get(&key).and_then(|v| v.as_object()).cloned(),
                value.as_object(),
            ) {
                let mut combined = existing;
                for (sub_key, sub_value) in incoming {
                    combined.insert(sub_key.clone(), sub_value.clone());
                }
                merged.insert(key.clone(), serde_json::Value::Object(combined));
                continue;
            }
        }
        merged.insert(key.clone(), value.clone());
    }
    Some(ModelCompat { raw: merged })
}

#[must_use]
pub fn apply_model_override(model: &Model, over: &ModelOverride) -> Model {
    let mut result = model.clone();
    if let Some(name) = &over.name {
        result.name.clone_from(name);
    }
    if let Some(reasoning) = over.reasoning {
        result.reasoning = reasoning;
    }
    if let Some(thinking_level_map) = &over.thinking_level_map {
        let mut merged = serde_json::to_value(&result.thinking_level_map).unwrap_or_default();
        if let (Some(merged_obj), Some(incoming)) = (
            merged.as_object_mut(),
            serde_json::to_value(thinking_level_map)
                .ok()
                .and_then(|v| v.as_object().cloned()),
        ) {
            for (key, value) in incoming {
                merged_obj.insert(key, value);
            }
            result.thinking_level_map =
                serde_json::from_value(serde_json::Value::Object(merged_obj.clone()))
                    .unwrap_or(result.thinking_level_map);
        }
    }
    if let Some(input) = &over.input {
        result.input = model_inputs(Some(input));
    }
    if let Some(window) = over.context_window {
        result.context_window = window;
    }
    if let Some(max_tokens) = over.max_tokens {
        result.max_tokens = max_tokens;
        // An override-supplied `maxTokens` is configuration: it bypasses
        // the default output ceiling.
        result.max_tokens_explicit = true;
    }
    if let Some(cost) = &over.cost {
        let base = &result.cost;
        result.cost = ModelCost {
            input: JsNumber::from(cost.input.unwrap_or(base.input.0)),
            output: JsNumber::from(cost.output.unwrap_or(base.output.0)),
            cache_read: JsNumber::from(cost.cache_read.unwrap_or(base.cache_read.0)),
            cache_write: JsNumber::from(cost.cache_write.unwrap_or(base.cache_write.0)),
        };
    }
    if over.compat.is_some() || result.compat.is_some() {
        result.compat = merge_compat(
            result.compat.as_ref(),
            compat_from_value(over.compat.as_ref()),
        );
    }
    if let Some(headers) = &over.headers {
        let mut merged = result.headers.clone().unwrap_or_default();
        for (key, value) in headers {
            merged.insert(key.clone(), value.clone());
        }
        result.headers = Some(merged);
    }
    result
}

pub fn load_custom_models(
    content: &str,
    built_in_providers: &dyn Fn(&str) -> bool,
    built_in_defaults: &dyn Fn(&str) -> Option<(String, String)>,
) -> CustomModelsResult {
    let config = match parse_models_config(content) {
        Ok(config) => config,
        Err(error) => {
            return CustomModelsResult {
                error: Some(error),
                ..Default::default()
            }
        }
    };
    if let Err(error) = validate_config(&config, built_in_providers) {
        return CustomModelsResult {
            error: Some(error),
            ..Default::default()
        };
    }

    let mut result = CustomModelsResult::default();
    for (provider_name, provider_config) in &config.providers {
        if provider_config.base_url.is_some() || provider_config.compat.is_some() {
            result.provider_overrides.insert(
                provider_name.clone(),
                ProviderOverride {
                    base_url: provider_config.base_url.clone(),
                    compat: merge_compat(None, compat_from_value(provider_config.compat.as_ref())),
                },
            );
        }
        if let Some(overrides) = &provider_config.model_overrides {
            result
                .model_overrides
                .insert(provider_name.clone(), overrides.clone());
        }
        let model_defs = provider_config.models.as_deref().unwrap_or_default();
        if model_defs.is_empty() {
            continue;
        }
        let defaults = built_in_defaults(provider_name);
        for model_def in model_defs {
            let api = model_def
                .api
                .clone()
                .or_else(|| provider_config.api.clone())
                .or_else(|| defaults.as_ref().map(|(api, _)| api.clone()));
            let Some(api) = api else { continue };
            let base_url = model_def
                .base_url
                .clone()
                .or_else(|| provider_config.base_url.clone())
                .or_else(|| defaults.as_ref().map(|(_, url)| url.clone()));
            let Some(base_url) = base_url else { continue };
            let compat = merge_compat(None, compat_from_value(provider_config.compat.as_ref()));
            result.models.push(Model {
                id: model_def.id.clone(),
                name: model_def
                    .name
                    .clone()
                    .unwrap_or_else(|| model_def.id.clone()),
                api,
                provider: provider_name.clone(),
                base_url,
                reasoning: model_def.reasoning.unwrap_or(false),
                // The definition's `thinkingLevelMap` is the model's,
                // parsed from the same wire names the override merge uses.
                thinking_level_map: model_def.thinking_level_map.as_ref().and_then(|map| {
                    serde_json::from_value::<pa_types::ai::ThinkingLevelMap>(
                        serde_json::to_value(map).ok()?,
                    )
                    .ok()
                }),
                input: model_inputs(model_def.input.as_ref()),
                cost: model_def.cost.as_ref().map_or_else(
                    || cost_from_config(&ModelCostConfig::default()),
                    cost_from_config,
                ),
                context_window: model_def.context_window.unwrap_or(128_000),
                max_tokens: model_def.max_tokens.unwrap_or(16_384),
                // A configured `maxTokens` is explicit; the 16_384
                // default is not, so a defaulted model stays capped.
                max_tokens_explicit: model_def.max_tokens.is_some(),
                featured: None,
                headers: None,
                compat,
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_comments_and_trailing_commas() {
        let input = r#"{
            // a comment
            "providers": {
                "ollama": { "baseUrl": "http://localhost", "apiKey": "x", }, // trailing
            },
        }"#;
        let stripped = strip_json_comments(input);
        let parsed: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert!(parsed["providers"]["ollama"]["baseUrl"].is_string());
    }

    #[test]
    fn validates_custom_provider_requirements() {
        let config = parse_models_config(
            r#"{ "providers": { "custom": { "baseUrl": "http://x", "models": [ { "id": "m" } ] } } }"#,
        )
        .unwrap();
        let error = validate_config(&config, &|_| false).unwrap_err();
        assert!(error.contains("apiKey"));
        assert!(validate_config(&config, &|p| p == "custom").is_ok());
    }

    #[test]
    fn parses_custom_models_with_defaults() {
        let result = load_custom_models(
            r#"{ "providers": { "ollama": {
                "baseUrl": "http://localhost:11434",
                "apiKey": "none",
                "api": "openai-completions",
                "models": [ { "id": "llama3", "name": "Llama 3" } ]
            } } }"#,
            &|_| false,
            &|_| None,
        );
        assert!(result.error.is_none());
        assert_eq!(result.models.len(), 1);
        assert_eq!(result.models[0].id, "llama3");
        assert_eq!(result.models[0].base_url, "http://localhost:11434");
        assert_eq!(result.models[0].context_window, 128_000);
    }

    #[test]
    fn parses_a_custom_model_definition_thinking_level_map() {
        let result = load_custom_models(
            r#"{ "providers": { "battery": {
                "baseUrl": "http://127.0.0.1:9",
                "apiKey": "sk-local",
                "api": "openai-completions",
                "models": [ {
                    "id": "chat-plus",
                    "reasoning": false,
                    "thinkingLevelMap": { "off": null, "xhigh": "xhigh" }
                } ]
            } } }"#,
            &|_| false,
            &|_| None,
        );
        assert!(result.error.is_none());
        let map = result.models[0]
            .thinking_level_map
            .as_ref()
            .expect("the definition's thinkingLevelMap is the model's");
        assert_eq!(map.get(&pa_types::ai::ModelThinkingLevel::Off), Some(&None));
        assert_eq!(
            map.get(&pa_types::ai::ModelThinkingLevel::Xhigh),
            Some(&Some("xhigh".to_string()))
        );
    }

    /// TS `755-configured-max-tokens.test.ts`: a models.json `maxTokens`
    /// is explicit — the configured value reaches the provider unchanged
    /// instead of being clamped to the 32000 default ceiling.
    #[test]
    fn a_models_json_max_tokens_is_explicit() {
        let result = load_custom_models(
            r#"{ "providers": { "glm-h200": {
                "baseUrl": "http://vllm.example.test:8000/v1",
                "api": "openai-completions",
                "apiKey": "TEST_KEY",
                "models": [ { "id": "glm-5.2", "reasoning": true,
                              "contextWindow": 393216, "maxTokens": 131072 } ]
            } } }"#,
            &|_| false,
            &|_| None,
        );
        assert!(result.error.is_none());
        let model = &result.models[0];
        assert_eq!(model.max_tokens, 131_072);
        assert!(model.max_tokens_explicit);
    }

    /// A custom model that omits `maxTokens` defaults to 16384 and stays
    /// catalog-like (capped): the flag marks a CONFIGURED value only.
    #[test]
    fn a_custom_model_without_max_tokens_stays_unmarked() {
        let result = load_custom_models(
            r#"{ "providers": { "ollama": {
                "baseUrl": "http://localhost:11434",
                "apiKey": "none",
                "api": "openai-completions",
                "models": [ { "id": "llama3" } ]
            } } }"#,
            &|_| false,
            &|_| None,
        );
        assert!(result.error.is_none());
        let model = &result.models[0];
        assert_eq!(model.max_tokens, 16_384);
        assert!(!model.max_tokens_explicit);
    }

    /// TS `applyModelOverride`: an override-supplied `maxTokens` is
    /// configuration too — the flag flips true so the value bypasses the
    /// ceiling (a per-model override of a built-in model is the #755
    /// shape with no custom provider involved).
    #[test]
    fn a_per_model_override_marks_max_tokens_explicit() {
        let base: Model = serde_json::from_value(serde_json::json!({
            "id": "claude-sonnet-4-5", "name": "Claude", "api": "anthropic",
            "provider": "anthropic", "baseUrl": "https://x", "reasoning": false,
            "input": [],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200_000, "maxTokens": 65_536
        }))
        .unwrap();
        assert!(!base.max_tokens_explicit);
        let over = ModelOverride {
            max_tokens: Some(200_000),
            ..Default::default()
        };
        let merged = apply_model_override(&base, &over);
        assert_eq!(merged.max_tokens, 200_000);
        assert!(merged.max_tokens_explicit);
        // An override that does not touch maxTokens leaves the flag alone.
        let untouched = apply_model_override(&base, &ModelOverride::default());
        assert!(!untouched.max_tokens_explicit);
    }

    #[test]
    fn model_overrides_merge() {
        let base = serde_json::from_value(serde_json::json!({
            "id": "m", "name": "M", "api": "openai-completions", "provider": "p",
            "baseUrl": "http://x", "reasoning": false, "input": [],
            "cost": { "input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100
        }))
        .unwrap();
        let over = ModelOverride {
            name: Some("Renamed".to_string()),
            context_window: Some(2000),
            cost: Some(ModelCostConfig {
                output: Some(9.0),
                ..Default::default()
            }),
            ..Default::default()
        };
        let merged = apply_model_override(&base, &over);
        assert_eq!(merged.name, "Renamed");
        assert_eq!(merged.context_window, 2000);
        assert_eq!(merged.cost.output.0, 9.0);
        assert_eq!(merged.cost.input.0, 1.0);
    }
}
