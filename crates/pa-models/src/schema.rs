//! The strict `models/catalog.v1.json` schema.
//!
//! Ported from `parseModelCatalog` + `CatalogModelSchema` in
//! `packages/ai/src/model-catalog.ts`:
//! - version gate first: `schemaVersion` must be exactly `1`; anything else
//!   (including a future v3) rejects the payload, silently, forever;
//! - strict entry deserialization (`deny_unknown_fields`) — an entry
//!   carrying a `headers` key is invalid (request headers live in the
//!   compiled transport templates, never in catalog data);
//! - field constraints (lengths, control chars, ranges) checked after the
//!   structural parse;
//! - `compat` validated per `api` (`crate::compat`);
//! - duplicates reject even in skip-invalid mode;
//! - remote refresh parses with skip-invalid semantics: bad entries drop,
//!   the rest of the refresh survives.

use std::collections::BTreeMap;

use serde::Deserialize;

use pa_types::ai::{Model, ModelCompat, ModelCost, ModelInput, ThinkingLevelMap};
use pa_types::JsNumber;

use crate::compat::is_model_compat;

const MAX_MODEL_CATALOG_MODELS: usize = 20_000;

/// Parsed model catalog (`ModelCatalogV1` in the TS reference).
#[derive(Debug, Clone)]
pub struct ModelCatalogV1 {
    pub schema_version: u64,
    pub models: Vec<Model>,
}

/// How an invalid entry is handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidEntries {
    /// Remote refresh: drop bad entries, keep the rest.
    SkipInvalid,
    /// Bundled/strict loads: one bad entry rejects the payload.
    Reject,
}

/// The strict catalog entry schema (`deny_unknown_fields` — TS
/// `strictObject`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CatalogModelSchema {
    id: String,
    name: String,
    api: String,
    provider: String,
    #[serde(rename = "baseUrl")]
    base_url: String,
    reasoning: bool,
    #[serde(default)]
    thinking_level_map: Option<ThinkingLevelMap>,
    input: Vec<ModelInput>,
    cost: CatalogCost,
    #[serde(rename = "contextWindow")]
    context_window: u64,
    #[serde(rename = "maxTokens")]
    max_tokens: u64,
    #[serde(default)]
    featured: Option<bool>,
    #[serde(default)]
    compat: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCost {
    input: JsNumber,
    output: JsNumber,
    cache_read: JsNumber,
    cache_write: JsNumber,
}

#[derive(Debug, Deserialize)]
struct CatalogEnvelope {
    models: Vec<serde_json::Value>,
}

/// Parse a catalog payload against the strict schema.
///
/// # Errors
///
/// Fails on an unsupported `schemaVersion` or payload shape, a `models`
/// list that is empty or over the size limit, an invalid entry under
/// [`InvalidEntries::Reject`], duplicate `(provider, id)` pairs, or when
/// no entry survives validation.
pub fn parse_model_catalog(
    value: &serde_json::Value,
    policy: InvalidEntries,
) -> Result<ModelCatalogV1, String> {
    let Some(object) = value.as_object() else {
        return Err("Unsupported model catalog schema version".into());
    };
    if object
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err("Unsupported model catalog schema version".into());
    }
    let Some(models) = object.get("models").and_then(serde_json::Value::as_array) else {
        return Err("Invalid model catalog model count".into());
    };
    if models.is_empty() || models.len() > MAX_MODEL_CATALOG_MODELS {
        return Err("Invalid model catalog model count".into());
    }
    // The envelope accepts only the declared keys (schemaVersion literal +
    // the models array); unknown top-level keys are not rejected (TS parity).
    let envelope: CatalogEnvelope = serde_json::from_value(value.clone())
        .map_err(|_| "Invalid model catalog entry".to_string())?;
    let _ = envelope.models.len();

    let mut parsed: Vec<Model> = Vec::with_capacity(models.len());
    let mut seen: BTreeMap<(String, String), ()> = BTreeMap::new();
    for candidate in models {
        let model = match parse_entry(candidate) {
            Ok(model) => model,
            Err(error) => match policy {
                InvalidEntries::SkipInvalid => {
                    tracing::debug!(error, "skipping invalid model catalog entry");
                    continue;
                }
                InvalidEntries::Reject => return Err(error),
            },
        };
        if seen
            .insert((model.provider.clone(), model.id.clone()), ())
            .is_some()
        {
            return Err(format!(
                "Duplicate model catalog entry [\"{}\",\"{}\"]",
                model.provider, model.id
            ));
        }
        parsed.push(model);
    }
    if parsed.is_empty() {
        return Err("Model catalog has no compatible entries".into());
    }
    Ok(ModelCatalogV1 {
        schema_version: 1,
        models: parsed,
    })
}

fn parse_entry(candidate: &serde_json::Value) -> Result<Model, String> {
    let entry: CatalogModelSchema = serde_json::from_value(candidate.clone())
        .map_err(|_| "Invalid model catalog entry".to_string())?;
    validate_entry(&entry)?;
    if !is_model_compat(&entry.api, entry.compat.as_ref()) {
        return Err("Invalid model catalog entry".into());
    }
    Ok(Model {
        id: entry.id,
        name: entry.name,
        api: entry.api,
        provider: entry.provider,
        base_url: entry.base_url,
        reasoning: entry.reasoning,
        thinking_level_map: entry.thinking_level_map,
        input: entry.input,
        cost: ModelCost {
            input: entry.cost.input,
            output: entry.cost.output,
            cache_read: entry.cost.cache_read,
            cache_write: entry.cost.cache_write,
        },
        context_window: entry.context_window,
        max_tokens: entry.max_tokens,
        featured: entry.featured,
        headers: None,
        compat: entry.compat.map(|raw| ModelCompat { raw }),
    })
}

fn validate_entry(entry: &CatalogModelSchema) -> Result<(), String> {
    no_control_chars_nonempty(&entry.id, 1_024)?;
    no_control_chars_nonempty(&entry.name, 1_024)?;
    bounded(&entry.api, 1, 128)?;
    bounded(&entry.provider, 1, 128)?;
    bounded(&entry.base_url, 0, 2_048)?;
    if entry.input.is_empty() || entry.input.len() > 2 {
        return Err("Invalid model catalog entry".into());
    }
    for cost in [
        entry.cost.input,
        entry.cost.output,
        entry.cost.cache_read,
        entry.cost.cache_write,
    ] {
        let value = cost.as_f64();
        if !value.is_finite() || !(0.0..=1_000_000.0).contains(&value) {
            return Err("Invalid model catalog entry".into());
        }
    }
    if !(1..=100_000_000).contains(&entry.context_window)
        || !(1..=100_000_000).contains(&entry.max_tokens)
    {
        return Err("Invalid model catalog entry".into());
    }
    if let Some(map) = &entry.thinking_level_map {
        for value in map.values().flatten() {
            bounded(value, 1, 128)?;
        }
    }
    Ok(())
}

fn bounded(value: &str, min: usize, max: usize) -> Result<(), String> {
    let length = value.chars().count();
    if length < min || length > max {
        return Err("Invalid model catalog entry".into());
    }
    Ok(())
}

fn no_control_chars_nonempty(value: &str, max: usize) -> Result<(), String> {
    bounded(value, 1, max)?;
    if value
        .chars()
        .any(|c| (c as u32) <= 0x1f || (0x7f..=0x9f).contains(&(c as u32)))
    {
        return Err("Invalid model catalog entry".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(overrides: serde_json::Value) -> serde_json::Value {
        let mut base = json!({
            "id": "model-a",
            "name": "Model A",
            "api": "openai-completions",
            "provider": "openai",
            "baseUrl": "https://api.openai.com/v1",
            "reasoning": false,
            "input": ["text"],
            "cost": {"input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 1.25},
            "contextWindow": 128_000,
            "maxTokens": 4_096,
        });
        if let (Some(target), Some(source)) = (base.as_object_mut(), overrides.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        base
    }

    fn catalog(models: Vec<serde_json::Value>) -> serde_json::Value {
        json!({"schemaVersion": 1, "models": models})
    }

    #[test]
    fn parses_a_valid_entry() {
        let parsed = parse_model_catalog(&catalog(vec![entry(json!({}))]), InvalidEntries::Reject)
            .expect("valid");
        assert_eq!(parsed.models.len(), 1);
        assert_eq!(parsed.models[0].id, "model-a");
        assert_eq!(parsed.models[0].cost.cache_write.as_f64(), 1.25);
    }

    #[test]
    fn unsupported_version_rejects() {
        for version in [json!(2), json!(3), json!(0)] {
            let payload = json!({"schemaVersion": version, "models": [entry(json!({}))]});
            assert!(parse_model_catalog(&payload, InvalidEntries::Reject).is_err());
        }
        assert!(parse_model_catalog(&json!({"models": []}), InvalidEntries::Reject).is_err());
    }

    #[test]
    fn unknown_entry_key_rejects() {
        let payload = catalog(vec![entry(json!({"surprise": 1}))]);
        assert!(parse_model_catalog(&payload, InvalidEntries::Reject).is_err());
    }

    #[test]
    fn headers_key_rejects_the_entry() {
        let payload = catalog(vec![
            entry(json!({"id": "good"})),
            entry(json!({"id": "evil", "headers": {"User-Agent": "x/1"}})),
        ]);
        assert!(parse_model_catalog(&payload, InvalidEntries::Reject).is_err());
        let parsed = parse_model_catalog(&payload, InvalidEntries::SkipInvalid).expect("kept rest");
        let ids: Vec<&str> = parsed.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["good"], "the headers-carrying entry drops");
    }

    #[test]
    fn range_violations_reject() {
        for bad in [
            json!({"contextWindow": 0}),
            json!({"maxTokens": 0}),
            json!({"contextWindow": 200_000_000}),
            json!({"cost": {"input": 2_000_000, "output": 2, "cacheRead": 0, "cacheWrite": 0}}),
            json!({"input": []}),
            json!({"input": ["text", "text", "image"]}),
            json!({"baseUrl": "x".repeat(3_000)}),
            json!({"id": ""}),
            json!({"name": "\u{7}bad"}),
            json!({"thinkingLevelMap": {"ultra": "max"}}),
            json!({"thinkingLevelMap": {"high": ""}}),
            json!({"api": ""}),
        ] {
            let payload = catalog(vec![entry(bad)]);
            assert!(
                parse_model_catalog(&payload, InvalidEntries::Reject).is_err(),
                "expected rejection"
            );
        }
    }

    #[test]
    fn thinking_level_map_parses_levels() {
        let payload = catalog(vec![entry(json!({
            "reasoning": true,
            "thinkingLevelMap": {"off": null, "low": "low", "high": "high", "xhigh": "max"}
        }))]);
        let parsed = parse_model_catalog(&payload, InvalidEntries::Reject).expect("valid");
        let map = parsed.models[0].thinking_level_map.as_ref().expect("map");
        assert_eq!(map.len(), 4);
    }

    #[test]
    fn compat_shapes_validate_per_api() {
        let good = catalog(vec![entry(json!({
            "api": "anthropic-messages",
            "compat": {"supportsEagerToolInputStreaming": true}
        }))]);
        assert!(parse_model_catalog(&good, InvalidEntries::Reject).is_ok());
        let bad = catalog(vec![entry(json!({
            "api": "anthropic-messages",
            "compat": {"supportsStore": true}
        }))]);
        assert!(parse_model_catalog(&bad, InvalidEntries::Reject).is_err());
    }

    #[test]
    fn duplicates_reject_even_in_skip_mode() {
        let payload = catalog(vec![entry(json!({})), entry(json!({}))]);
        let err = parse_model_catalog(&payload, InvalidEntries::SkipInvalid)
            .expect_err("duplicate rejected");
        assert!(err.contains("Duplicate"), "{err}");
    }

    #[test]
    fn skip_invalid_drops_bad_entries_and_keeps_the_rest() {
        let payload = catalog(vec![
            entry(json!({"id": "bad", "contextWindow": 0})),
            entry(json!({"id": "good-1"})),
            entry(json!({"id": "bad-2", "input": []})),
            entry(json!({"id": "good-2"})),
        ]);
        let parsed = parse_model_catalog(&payload, InvalidEntries::SkipInvalid).expect("kept rest");
        let ids: Vec<&str> = parsed.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["good-1", "good-2"]);
    }

    #[test]
    fn empty_after_skipping_rejects() {
        let payload = catalog(vec![entry(json!({"contextWindow": 0}))]);
        assert!(parse_model_catalog(&payload, InvalidEntries::SkipInvalid).is_err());
    }

    #[test]
    fn envelope_allows_unknown_top_level_keys() {
        let mut payload = catalog(vec![entry(json!({}))]);
        payload
            .as_object_mut()
            .unwrap()
            .insert("generatedAt".into(), json!("2026-09-21"));
        assert!(parse_model_catalog(&payload, InvalidEntries::Reject).is_ok());
    }
}
