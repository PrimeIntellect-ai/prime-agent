//! Prime Inference model catalog: parse, build, disk cache, and refresh.
//! Port of prime-inference-model-catalog.ts.

use std::collections::HashMap;

use pa_types::ai::{Model, ModelCompat, ModelCost, ModelInput};
use pa_types::JsNumber;
use serde::{Deserialize, Serialize};

use super::prime_inference::{is_private_prime_inference_model_id, PRIME_INFERENCE_BASE_URL};

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MIN_CATALOG_COVERAGE: f64 = 0.5;

/// One parsed catalog entry (packages/ai PrimeInferenceCatalogEntry).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrimeInferenceCatalogEntry {
    pub id: String,
    pub name: Option<String>,
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub vision: Option<bool>,
    pub reasoning: Option<bool>,
}

fn non_negative(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|number| number.is_finite() && *number >= 0.0)
}

fn positive_u64(value: &serde_json::Value) -> Option<u64> {
    value.as_u64().filter(|number| *number > 0)
}

fn strip_control(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() && !('\u{7f}'..='\u{9f}').contains(c))
        .collect::<String>()
        .trim()
        .to_string()
}

fn string_array(value: &serde_json::Value) -> Option<Vec<String>> {
    value.as_array().and_then(|items| {
        items
            .iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect::<Option<Vec<String>>>()
    })
}

/// Parse the catalog payload; invalid entries drop out, duplicates fail.
pub fn parse_prime_inference_model_catalog(
    payload: &serde_json::Value,
    allow_empty: bool,
) -> Result<Vec<PrimeInferenceCatalogEntry>, String> {
    let data = payload
        .get("data")
        .and_then(|data| data.as_array())
        .ok_or_else(|| "Invalid Prime Inference model catalog".to_string())?;
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in data {
        let Some(id) = item.get("id").and_then(|id| id.as_str()) else {
            continue;
        };
        if id.is_empty() || id.len() > 1024 {
            continue;
        }
        if id
            .chars()
            .any(|c| c.is_control() || ('\u{7f}'..='\u{9f}').contains(&c))
        {
            continue;
        }
        if !seen.insert(id.to_string()) {
            return Err(format!("Duplicate Prime Inference model {id}"));
        }
        let pricing = item.get("pricing").cloned().unwrap_or_default();
        let Some(input) = non_negative(
            &pricing
                .get("input_usd_per_mtok")
                .cloned()
                .unwrap_or_default(),
        ) else {
            continue;
        };
        let Some(output) = non_negative(
            &pricing
                .get("output_usd_per_mtok")
                .cloned()
                .unwrap_or_default(),
        ) else {
            continue;
        };
        let name = item
            .get("display_name")
            .and_then(|name| name.as_str())
            .map(strip_control)
            .filter(|name| !name.is_empty());
        let specs = item.get("specs").cloned().unwrap_or_default();
        let modalities = specs.get("modalities").cloned().unwrap_or_default();
        let input_modalities =
            string_array(modalities.get("input").unwrap_or(&serde_json::Value::Null));
        let output_modalities =
            string_array(modalities.get("output").unwrap_or(&serde_json::Value::Null));
        let context_window = positive_u64(
            specs
                .get("context_window")
                .unwrap_or(&serde_json::Value::Null),
        );
        let max_tokens = positive_u64(
            specs
                .get("max_output_tokens")
                .unwrap_or(&serde_json::Value::Null),
        );
        let reasoning = specs
            .get("supports_reasoning")
            .and_then(|reasoning| reasoning.as_bool());
        let has_specs = context_window.is_some()
            && max_tokens.is_some()
            && reasoning.is_some()
            && input_modalities.is_some()
            && output_modalities.is_some();
        let entry = PrimeInferenceCatalogEntry {
            id: id.to_string(),
            name,
            input,
            output,
            cache_read: non_negative(
                &pricing
                    .get("cache_read_usd_per_mtok")
                    .cloned()
                    .unwrap_or_default(),
            ),
            cache_write: non_negative(
                &pricing
                    .get("cache_write_usd_per_mtok")
                    .cloned()
                    .unwrap_or_default(),
            ),
            context_window: if has_specs { context_window } else { None },
            max_tokens: if has_specs {
                max_tokens.map(|m| m.min(context_window.unwrap()))
            } else {
                None
            },
            vision: has_specs.then(|| {
                input_modalities
                    .as_ref()
                    .is_some_and(|m| m.iter().any(|modality| modality == "image"))
            }),
            reasoning: if has_specs { reasoning } else { None },
        };
        models.push(entry);
    }
    if models.is_empty() && !allow_empty {
        return Err("Prime Inference model catalog is empty".to_string());
    }
    Ok(models)
}

fn default_compat() -> ModelCompat {
    serde_json::from_value(serde_json::json!({
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens",
        "supportsStrictMode": false
    }))
    .expect("default compat serializes")
}

/// Build models from catalog entries over the bundled templates.
pub fn build_prime_inference_models(
    bundled_models: &[Model],
    entries: &[PrimeInferenceCatalogEntry],
    include_private: bool,
) -> Option<Vec<Model>> {
    build_prime_inference_models_with_minimum(bundled_models, entries, include_private, None)
}

/// Like [`build_prime_inference_models`] with an explicit coverage floor
/// (`None` keeps the 50% default; `Some(0)` disables the check).
pub fn build_prime_inference_models_with_minimum(
    bundled_models: &[Model],
    entries: &[PrimeInferenceCatalogEntry],
    include_private: bool,
    minimum_models: Option<usize>,
) -> Option<Vec<Model>> {
    let bundled: HashMap<String, &Model> = bundled_models
        .iter()
        .map(|model| (model.id.to_lowercase(), model))
        .collect();
    let mut models = Vec::new();
    for entry in entries {
        if !include_private && is_private_prime_inference_model_id(&entry.id) {
            continue;
        }
        let template = bundled.get(&entry.id.to_lowercase());
        if template.is_none()
            && (entry.context_window.is_none()
                || entry.max_tokens.is_none()
                || entry.reasoning.is_none())
        {
            continue;
        }
        let template = template.map(|model| model as &Model);
        let context_window = entry
            .context_window
            .or_else(|| template.map(|t| t.context_window))
            .unwrap_or(0);
        let max_tokens = entry
            .max_tokens
            .or_else(|| template.map(|t| t.max_tokens))
            .unwrap_or(0)
            .min(context_window);
        let mut compat = template
            .and_then(|t| t.compat.clone())
            .unwrap_or_else(default_compat);
        let anthropic = entry.id.to_lowercase().starts_with("anthropic/");
        if anthropic {
            compat.raw.insert(
                "cacheControlFormat".to_string(),
                serde_json::Value::String("anthropic".to_string()),
            );
        }
        let cache_read = entry
            .cache_read
            .or_else(|| template.map(|t| t.cost.cache_read.0))
            .unwrap_or(if anthropic { entry.input * 0.1 } else { 0.0 });
        let cache_write = entry
            .cache_write
            .or_else(|| template.map(|t| t.cost.cache_write.0))
            .unwrap_or(if anthropic { entry.input * 1.25 } else { 0.0 });
        let vision = entry.vision.unwrap_or(false)
            || template.is_some_and(|t| t.input.contains(&ModelInput::Image));
        models.push(Model {
            id: entry.id.clone(),
            name: entry
                .name
                .clone()
                .or_else(|| template.map(|t| t.name.clone()))
                .unwrap_or_else(|| entry.id.clone()),
            api: "openai-completions".to_string(),
            provider: "prime-inference".to_string(),
            base_url: PRIME_INFERENCE_BASE_URL.to_string(),
            reasoning: entry
                .reasoning
                .or_else(|| template.map(|t| t.reasoning))
                .unwrap_or(false),
            thinking_level_map: template.and_then(|t| t.thinking_level_map.clone()),
            input: if vision {
                vec![ModelInput::Text, ModelInput::Image]
            } else {
                vec![ModelInput::Text]
            },
            cost: ModelCost {
                input: JsNumber::from(entry.input),
                output: JsNumber::from(entry.output),
                cache_read: JsNumber::from(cache_read),
                cache_write: JsNumber::from(cache_write),
            },
            context_window,
            max_tokens,
            featured: template.and_then(|t| t.featured),
            headers: None,
            compat: Some(compat),
        });
    }
    let minimum = minimum_models
        .unwrap_or_else(|| ((bundled.len() as f64) * MIN_CATALOG_COVERAGE).ceil() as usize);
    let covered = models
        .iter()
        .filter(|model| bundled.contains_key(&model.id.to_lowercase()))
        .count();
    if covered >= minimum {
        Some(models)
    } else {
        None
    }
}

/// Fetch the live catalog (5s timeout, 2 MiB cap). `base_url` is the API
/// base (production: [`PRIME_INFERENCE_BASE_URL`]; tests pass a local
/// server through the shared catalog's seam).
pub(crate) async fn fetch_prime_inference_model_catalog(
    base_url: &str,
    headers: Option<&HashMap<String, String>>,
    timeout_ms: u64,
    allow_empty: bool,
) -> Result<(serde_json::Value, Vec<PrimeInferenceCatalogEntry>), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .get(format!("{base_url}/models"))
        .header("accept", "application/json");
    if let Some(headers) = headers {
        for (name, value) in headers {
            request = request.header(name, value);
        }
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Prime Inference model catalog request failed with status {status}"
        ));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("Response is too large".to_string());
    }
    let payload: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let entries = parse_prime_inference_model_catalog(&payload, allow_empty)?;
    Ok((payload, entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled() -> Vec<Model> {
        vec![serde_json::from_value(serde_json::json!({
            "id": "z-ai/glm-5.3", "name": "GLM", "api": "openai-completions",
            "provider": "prime-inference", "baseUrl": PRIME_INFERENCE_BASE_URL,
            "reasoning": true, "input": ["text"],
            "cost": { "input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 1.25 },
            "contextWindow": 128000, "maxTokens": 8192, "featured": true,
            "compat": { "maxTokensField": "max_tokens" }
        }))
        .unwrap()]
    }

    #[test]
    fn parses_catalog_entries() {
        let payload = serde_json::json!({
            "data": [
                {
                    "id": "z-ai/glm-5.3",
                    "pricing": { "input_usd_per_mtok": 0.6, "output_usd_per_mtok": 2.2 },
                    "specs": { "context_window": 200000, "max_output_tokens": 16384,
                               "supports_reasoning": true,
                               "modalities": { "input": ["text"], "output": ["text"] } }
                },
                { "id": "bad", "pricing": {} },
                { "id": "internal/x", "pricing": { "input_usd_per_mtok": 0, "output_usd_per_mtok": 0 } }
            ]
        });
        let entries = parse_prime_inference_model_catalog(&payload, false).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].context_window, Some(200_000));
        // Private ids parse but build() excludes them by default.
        let models = build_prime_inference_models(&bundled(), &entries, false).unwrap();
        assert!(models
            .iter()
            .all(|m| !is_private_prime_inference_model_id(&m.id)));
    }

    #[test]
    fn build_requires_minimum_coverage() {
        let payload = serde_json::json!({ "data": [
            { "id": "other/model", "pricing": { "input_usd_per_mtok": 1, "output_usd_per_mtok": 1 },
              "specs": { "context_window": 1000, "max_output_tokens": 500, "supports_reasoning": false,
                         "modalities": { "input": ["text"], "output": ["text"] } } }
        ]});
        let entries = parse_prime_inference_model_catalog(&payload, false).unwrap();
        // 0/1 bundled coverage < 50% -> None.
        assert!(build_prime_inference_models(&bundled(), &entries, false).is_none());
    }
}
