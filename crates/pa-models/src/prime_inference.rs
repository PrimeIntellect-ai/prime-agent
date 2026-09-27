//! Prime Inference: the live, credentialed model catalog.
//!
//! Ported from `packages/coding-agent/src/core/prime-inference-model-catalog.ts`
//! and `packages/ai/src/prime-inference-model-catalog.ts`:
//! - fetched live from `https://api.pinference.ai/api/v1/models` with
//!   `Authorization: Bearer <api key>` and `X-Prime-Team-ID` when a team is
//!   configured — this is what makes private/internal models appear for
//!   entitled users;
//! - the disk cache is scope-keyed by an HMAC-SHA256 fingerprint of the key
//!   over the team id, so one account's private models can never leak into
//!   another scope; 401/403 clears only that scope;
//! - the same hourly background cadence, with the compiled 110-entry
//!   offline fallback so onboarding works before the first credentialed
//!   fetch;
//! - entries without a compiled template are accepted only when they carry
//!   full specs; the coverage gate (>= 50% of compiled entries) keeps a
//!   partial/failed fetch from replacing a good snapshot;
//! - the live routes' `supported_parameters`/`reasoning` declarations drive
//!   their reasoning request controls (effort routes, reasoning-object
//!   toggles, `enable_thinking` routes), so stale bundled templates never
//!   override what the gateway accepts.

use std::path::PathBuf;
use std::sync::Arc;

use hmac::{Hmac, Mac};
use pa_types::ai::{
    CompatKind, Model, ModelCompat, ModelCost, ModelInput, ModelThinkingLevel,
    OpenAiCompletionsCompat, ThinkingFormat, ThinkingLevelMap,
};
use pa_types::JsNumber;
use serde::Deserialize;
use sha2::Sha256;

use crate::cache::{CatalogCache, RefreshOptions};
use crate::fetch::CatalogFetcher;
use crate::transports;

/// The Prime Inference API base URL (models at `/models`).
pub const PRIME_INFERENCE_BASE_URL: &str = "https://api.pinference.ai/api/v1";

/// Hard response cap for the credentialed fetch (2 MiB in the TS reference).
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Minimum share of compiled entries a live fetch must cover.
const MIN_CATALOG_COVERAGE: f64 = 0.5;

const CACHE_FILE: &str = "prime-inference-models-cache.json";

/// One entry of the Prime Inference `/models` response.
#[derive(Debug, Clone, Default)]
pub struct PrimeInferenceEntry {
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
    /// Request parameter names the live route declares; absent when the
    /// route reports none.
    pub supported_parameters: Option<Vec<String>>,
    /// Reasoning effort values the live route declares; absent when the
    /// route has no effort selector.
    pub reasoning_efforts: Option<Vec<String>>,
    /// Whether the live route rejects requests that disable reasoning.
    pub reasoning_mandatory: Option<bool>,
}

/// Reasoning request controls derived from a live Prime Inference catalog
/// entry (`getPrimeInferenceReasoningControls` in the TS reference). The
/// gateway validates reasoning values per route and rejects undeclared
/// efforts, so only declared values are ever sent.
#[derive(Debug, Clone, PartialEq)]
pub struct PrimeInferenceReasoningControls {
    /// Whether the route accepts a top-level `reasoning_effort` parameter.
    pub supports_reasoning_effort: bool,
    /// Thinking format required to address the route's declared reasoning
    /// parameters.
    pub thinking_format: Option<ThinkingFormat>,
    /// Local-to-route effort map; absent when the route exposes no reasoning
    /// parameter.
    pub thinking_level_map: Option<ThinkingLevelMap>,
}

/// The reasoning effort levels of the request vocabulary, in ladder order
/// (`REASONING_EFFORT_LEVELS` in the TS reference).
const REASONING_EFFORT_LEVELS: [ModelThinkingLevel; 6] = [
    ModelThinkingLevel::Minimal,
    ModelThinkingLevel::Low,
    ModelThinkingLevel::Medium,
    ModelThinkingLevel::High,
    ModelThinkingLevel::Xhigh,
    ModelThinkingLevel::Max,
];

/// Derive reasoning request controls from the parameters a live route
/// declares. Returns `None` when the route does not report parameter
/// support; callers then keep their bundled template compat instead of
/// guessing.
pub fn prime_inference_reasoning_controls(
    entry: &PrimeInferenceEntry,
) -> Option<PrimeInferenceReasoningControls> {
    let supported = entry.supported_parameters.as_ref()?;
    let includes = |parameter: &str| supported.iter().any(|p| p == parameter);
    let supports_reasoning_effort = includes("reasoning_effort");
    let mandatory = entry.reasoning_mandatory == Some(true);
    let mut thinking_level_map = None;
    if supports_reasoning_effort && entry.reasoning_efforts.is_some() {
        // Efforts are only addressable through reasoning_effort; without
        // that parameter the route falls through to the reasoning-object
        // toggle.
        let efforts = entry.reasoning_efforts.as_deref().unwrap_or_default();
        let mut map = ThinkingLevelMap::new();
        // Mandatory routes cannot disable reasoning; non-mandatory effort
        // routes accept "none" as the disable value even when they do not
        // list it.
        map.insert(
            ModelThinkingLevel::Off,
            (!mandatory).then(|| "none".to_string()),
        );
        for level in REASONING_EFFORT_LEVELS {
            map.insert(
                level,
                efforts
                    .contains(&level.wire_name().to_string())
                    .then(|| level.wire_name().to_string()),
            );
        }
        thinking_level_map = Some(map);
    } else if includes("reasoning") {
        // The route can only toggle reasoning on or off; expose a single
        // generic level.
        let mut map = ThinkingLevelMap::new();
        if mandatory {
            map.insert(ModelThinkingLevel::Off, None);
        }
        for level in [
            ModelThinkingLevel::Minimal,
            ModelThinkingLevel::Low,
            ModelThinkingLevel::Medium,
            ModelThinkingLevel::Xhigh,
            ModelThinkingLevel::Max,
        ] {
            map.insert(level, None);
        }
        map.insert(ModelThinkingLevel::High, Some("high".to_string()));
        thinking_level_map = Some(map);
    }
    let thinking_format = if includes("enable_thinking") {
        Some(ThinkingFormat::Zai)
    } else if includes("reasoning") && !supports_reasoning_effort {
        Some(ThinkingFormat::Openrouter)
    } else {
        None
    };
    Some(PrimeInferenceReasoningControls {
        supports_reasoning_effort,
        thinking_format,
        thinking_level_map,
    })
}

/// Credentials for one Prime Inference scope.
#[derive(Debug, Clone)]
pub struct PrimeInferenceCredentials {
    pub api_key: String,
    pub team_id: Option<String>,
}

/// Whether a model id is private (internal/, dev/, or alias-qualified with `:`).
pub fn is_private_prime_inference_model_id(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();
    normalized.starts_with("internal/")
        || normalized.starts_with("dev/")
        || normalized.contains(':')
}

/// The scope key for a credential+team pair: HMAC-SHA256 of the team id over
/// the api key with a domain-separation prefix (`privatePrimeAuthorizationFingerprint`
/// in the TS reference). The api key is the MAC key, never a hashed password:
/// the fingerprint stays stable for disk cache reuse without leaking it.
///
/// # Panics
///
/// Never for any input: `Hmac::<Sha256>::new_from_slice` accepts api keys of
/// every length, so the context construction is infallible.
pub fn scope_key(api_key: &str, team_id: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(api_key.as_bytes()).expect("HMAC accepts any key length");
    mac.update(b"prime-agent:private-prime-authorization:v1\0");
    mac.update(team_id.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[derive(Debug, Deserialize)]
struct WireItem {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    pricing: WirePricing,
    #[serde(default)]
    specs: WireSpecs,
    /// The raw `supported_parameters` list: non-strings drop during
    /// sanitization, so a mixed array must not fail the whole item. Feeds
    /// both the tool-capability filter (a declaration without "tools"
    /// drops the entry: a session always attaches tools) and the reasoning
    /// controls.
    #[serde(default)]
    supported_parameters: Option<serde_json::Value>,
    /// The raw `reasoning` object (`supported_efforts`, `mandatory`).
    #[serde(default)]
    reasoning: Option<serde_json::Value>,
}

#[derive(Debug, Default, Deserialize)]
struct WirePricing {
    #[serde(default)]
    input_usd_per_mtok: Option<f64>,
    #[serde(default)]
    output_usd_per_mtok: Option<f64>,
    #[serde(default)]
    cache_read_usd_per_mtok: Option<f64>,
    #[serde(default)]
    cache_write_usd_per_mtok: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
struct WireSpecs {
    #[serde(default)]
    context_window: Option<u64>,
    #[serde(default)]
    max_output_tokens: Option<u64>,
    #[serde(default)]
    supports_reasoning: Option<bool>,
    #[serde(default)]
    modalities: WireModalities,
}

#[derive(Debug, Default, Deserialize)]
struct WireModalities {
    #[serde(default)]
    input: Vec<String>,
    #[serde(default)]
    output: Vec<String>,
}

fn positive_integer(value: Option<u64>) -> Option<u64> {
    value.filter(|value| *value > 0)
}

/// A non-empty, de-duplicated list of non-empty strings
/// (`parseStringArray` in the TS reference): absent or empty input is
/// `None`, non-strings drop silently.
fn parse_string_array(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    let mut entries: Vec<String> = Vec::with_capacity(items.len());
    // Membership goes through a HashSet (a hostile-but-valid item with tens
    // of thousands of unique strings must not turn the synchronous refresh
    // parse quadratic); `entries` keeps the first-occurrence order.
    let mut seen: std::collections::HashSet<&str> =
        std::collections::HashSet::with_capacity(items.len());
    for item in items {
        if let Some(text) = item.as_str() {
            if !text.is_empty() && seen.insert(text) {
                entries.push(text.to_string());
            }
        }
    }
    (!entries.is_empty()).then_some(entries)
}

/// Parse the Prime Inference `/models` payload. Entries with unusable data
/// drop silently; duplicate ids reject the whole payload.
///
/// # Errors
///
/// Fails when the payload carries no `data` array, on a duplicate model
/// id, or when every entry was dropped and `allow_empty` is false.
pub fn parse_prime_inference_model_catalog(
    value: &serde_json::Value,
    allow_empty: bool,
) -> Result<Vec<PrimeInferenceEntry>, String> {
    let Some(items) = value.get("data").and_then(serde_json::Value::as_array) else {
        return Err("Invalid Prime Inference model catalog".into());
    };
    let mut entries = Vec::with_capacity(items.len());
    let mut seen: std::collections::BTreeMap<String, ()> = std::collections::BTreeMap::new();
    for item in items {
        let wire: WireItem = match serde_json::from_value(item.clone()) {
            Ok(wire) => wire,
            Err(_) => continue,
        };
        if wire.id.is_empty() || wire.id.chars().count() > 1_024 {
            continue;
        }
        if wire
            .id
            .chars()
            .any(|c| (c as u32) <= 0x1f || (0x7f..=0x9f).contains(&(c as u32)))
        {
            continue;
        }
        let Some(input) = wire
            .pricing
            .input_usd_per_mtok
            .filter(|v| v.is_finite() && *v >= 0.0)
        else {
            continue;
        };
        let Some(output) = wire
            .pricing
            .output_usd_per_mtok
            .filter(|v| v.is_finite() && *v >= 0.0)
        else {
            continue;
        };
        if seen.insert(wire.id.clone(), ()).is_some() {
            return Err(format!("Duplicate Prime Inference model {}", wire.id));
        }
        let supported_parameters = parse_string_array(wire.supported_parameters.as_ref());
        // Capability filtering (documented deviation from the TS parser,
        // which never reads this field): a model that declares its
        // supported request parameters without "tools" can never serve a
        // prime-agent turn — the session always attaches its tool set and
        // the router answers `404 No endpoints found that support tool use`
        // — so it never enters the selectable catalog. Entries without the
        // field stay: no signal, historical behavior. The check reads the
        // sanitized list, so a declaration with mixed junk still keeps its
        // "tools" (a raw Value iter would drop it).
        if supported_parameters
            .as_ref()
            .is_some_and(|parameters| !parameters.iter().any(|parameter| parameter == "tools"))
        {
            continue;
        }
        let name = wire
            .display_name
            .map(|name| {
                name.chars()
                    .filter(|c| (*c as u32) > 0x1f && !(0x7f..=0x9f).contains(&(*c as u32)))
                    .collect::<String>()
                    .trim()
                    .to_string()
            })
            .filter(|name| !name.is_empty());
        let has_specs = wire.specs.context_window.is_some()
            && wire.specs.max_output_tokens.is_some()
            && wire.specs.supports_reasoning.is_some()
            && !wire.specs.modalities.input.is_empty()
            && !wire.specs.modalities.output.is_empty();
        let reasoning_spec = wire
            .reasoning
            .as_ref()
            .and_then(serde_json::Value::as_object);
        let reasoning_efforts =
            reasoning_spec.and_then(|spec| parse_string_array(spec.get("supported_efforts")));
        let reasoning_mandatory = reasoning_spec
            .and_then(|spec| spec.get("mandatory"))
            .and_then(serde_json::Value::as_bool)
            .filter(|mandatory| *mandatory);
        let mut entry = PrimeInferenceEntry {
            id: wire.id,
            name,
            input,
            output,
            cache_read: wire
                .pricing
                .cache_read_usd_per_mtok
                .filter(|v| v.is_finite() && *v >= 0.0),
            cache_write: wire
                .pricing
                .cache_write_usd_per_mtok
                .filter(|v| v.is_finite() && *v >= 0.0),
            supported_parameters,
            reasoning_efforts,
            reasoning_mandatory,
            ..PrimeInferenceEntry::default()
        };
        if has_specs {
            let context_window = positive_integer(wire.specs.context_window).unwrap_or_default();
            let max_tokens = positive_integer(wire.specs.max_output_tokens)
                .map(|max| max.min(context_window))
                .unwrap_or_default();
            entry.context_window = Some(context_window);
            entry.max_tokens = Some(max_tokens);
            entry.vision = Some(wire.specs.modalities.input.iter().any(|m| m == "image"));
            entry.reasoning = wire.specs.supports_reasoning;
        }
        entries.push(entry);
    }
    if entries.is_empty() && !allow_empty {
        return Err("Prime Inference model catalog is empty".into());
    }
    Ok(entries)
}

/// The compiled-template default compat for live entries: routes that do
/// not describe their reasoning controls get no unconfirmed
/// `reasoning_effort` parameter (live `supported_parameters` drive the
/// override in [`build_prime_inference_models`]).
fn default_compat() -> ModelCompat {
    ModelCompat::from_kind(CompatKind::OpenAiCompletions(Box::new(
        OpenAiCompletionsCompat {
            supports_store: Some(false),
            supports_developer_role: Some(false),
            supports_reasoning_effort: Some(false),
            max_tokens_field: Some(pa_types::ai::MaxTokensField::MaxTokens),
            supports_strict_mode: Some(false),
            ..OpenAiCompletionsCompat::default()
        },
    )))
}

/// Build the live model list from fetched entries against the compiled
/// templates. `None` means the coverage gate rejected the result.
///
/// # Panics
///
/// Panics if a `ThinkingFormat` fails to serialize into JSON; the format
/// is a plain string enum, so this cannot happen.
pub fn build_prime_inference_models(
    bundled: &[Model],
    entries: &[PrimeInferenceEntry],
    include_private: bool,
    minimum_models: Option<usize>,
) -> Option<Vec<Model>> {
    let templates: std::collections::HashMap<String, &Model> = bundled
        .iter()
        .map(|model| (model.id.to_ascii_lowercase(), model))
        .collect();
    let mut models = Vec::with_capacity(entries.len());
    for entry in entries {
        if !include_private && is_private_prime_inference_model_id(&entry.id) {
            continue;
        }
        let template = templates.get(&entry.id.to_ascii_lowercase()).copied();
        if template.is_none()
            && (entry.context_window.is_none()
                || entry.max_tokens.is_none()
                || entry.reasoning.is_none())
        {
            continue;
        }
        let context_window = entry
            .context_window
            .or_else(|| template.map(|t| t.context_window))
            .unwrap_or_default();
        let max_tokens = entry
            .max_tokens
            .or_else(|| template.map(|t| t.max_tokens))
            .unwrap_or_default()
            .min(context_window);
        let anthropic = entry.id.to_ascii_lowercase().starts_with("anthropic/");
        let mut compat = template
            .and_then(|t| t.compat.clone())
            .unwrap_or_else(default_compat);
        if anthropic {
            let mut raw = compat.raw.clone();
            raw.insert("cacheControlFormat".into(), serde_json::json!("anthropic"));
            compat = ModelCompat { raw };
        }
        let controls = prime_inference_reasoning_controls(entry);
        if let Some(controls) = &controls {
            // The live catalog is authoritative for which reasoning
            // parameters the route accepts; never emit one it does not
            // declare.
            compat.raw.insert(
                "supportsReasoningEffort".into(),
                serde_json::json!(controls.supports_reasoning_effort),
            );
            match controls.thinking_format {
                Some(format) => {
                    compat.raw.insert(
                        "thinkingFormat".into(),
                        serde_json::to_value(format).expect("thinking format serializes"),
                    );
                }
                None => {
                    compat.raw.remove("thinkingFormat");
                }
            }
        }
        // Live declarations rebuild the thinking levels; routes without
        // declarations keep the stale template map.
        let thinking_level_map = match &controls {
            Some(controls) => controls.thinking_level_map.clone(),
            None => template.and_then(|t| t.thinking_level_map.clone()),
        };
        let cache_read = entry.cache_read.or_else(|| {
            template.map(|t| t.cost.cache_read.as_f64()).or({
                if anthropic {
                    Some(entry.input * 0.1)
                } else {
                    Some(0.0)
                }
            })
        });
        let cache_write = entry.cache_write.or_else(|| {
            template.map(|t| t.cost.cache_write.as_f64()).or({
                if anthropic {
                    Some(entry.input * 1.25)
                } else {
                    Some(0.0)
                }
            })
        });
        let vision = entry
            .vision
            .or_else(|| {
                template.map(|t| t.input.iter().any(|mode| matches!(mode, ModelInput::Image)))
            })
            .unwrap_or(false);
        models.push(Model {
            id: entry.id.clone(),
            name: entry
                .name
                .clone()
                .or_else(|| template.map(|t| t.name.clone()))
                .unwrap_or_else(|| entry.id.clone()),
            api: "openai-completions".into(),
            provider: "prime-inference".into(),
            base_url: PRIME_INFERENCE_BASE_URL.into(),
            reasoning: entry
                .reasoning
                .or_else(|| template.map(|t| t.reasoning))
                .unwrap_or_default(),
            thinking_level_map,
            input: if vision {
                vec![ModelInput::Text, ModelInput::Image]
            } else {
                vec![ModelInput::Text]
            },
            cost: ModelCost {
                input: JsNumber::from(entry.input),
                output: JsNumber::from(entry.output),
                cache_read: JsNumber::from(cache_read.unwrap_or_default()),
                cache_write: JsNumber::from(cache_write.unwrap_or_default()),
            },
            context_window,
            max_tokens,
            featured: template.and_then(|t| t.featured),
            headers: None,
            compat: Some(compat),
        });
    }
    let minimum_models = minimum_models
        .unwrap_or_else(|| ((bundled.len() as f64) * MIN_CATALOG_COVERAGE).ceil() as usize);
    let covered = models
        .iter()
        .filter(|model| templates.contains_key(&model.id.to_ascii_lowercase()))
        .count();
    (covered >= minimum_models).then_some(models)
}

/// Replace the base list's prime-inference section with the live models.
pub fn merge_prime_inference_models(bundled: &[Model], live: Option<&[Model]>) -> Vec<Model> {
    match live {
        None => bundled.to_vec(),
        Some(live) => {
            let mut merged: Vec<Model> = bundled
                .iter()
                .filter(|model| model.provider != "prime-inference")
                .cloned()
                .collect();
            merged.extend(live.iter().cloned());
            merged
        }
    }
}

/// The scope-keyed Prime Inference catalog: one last-good snapshot per
/// credential+team scope, fetched live with credentials.
pub struct PrimeInferenceCatalog {
    cache: CatalogCache<Vec<Model>>,
}

impl PrimeInferenceCatalog {
    /// A catalog persisted beside `models_dir` (cache file
    /// `prime-inference-models-cache.json`), using the compiled entries as
    /// templates.
    pub fn new(models_dir: Option<PathBuf>) -> Self {
        let templates = Arc::new(transports::prime_inference_offline_entries());
        let cache_path = models_dir.map(|dir| dir.join(CACHE_FILE));
        let parse_templates = Arc::clone(&templates);
        let parse: crate::cache::CatalogParse<Vec<Model>> = Arc::new(move |payload, _scope| {
            let entries = parse_prime_inference_model_catalog(payload, false)?;
            build_prime_inference_models(&parse_templates, &entries, false, None)
                .ok_or_else(|| "Prime Inference catalog coverage gate failed".to_string())
        });
        Self {
            cache: CatalogCache::new(
                &format!("{PRIME_INFERENCE_BASE_URL}/models"),
                cache_path,
                Arc::new(CatalogFetcher::with_limits(
                    crate::fetch::FETCH_TIMEOUT,
                    MAX_RESPONSE_BYTES,
                )),
                parse,
            ),
        }
    }

    /// [`PrimeInferenceCatalog::new`] with an explicit API base URL (test
    /// seam for running the credentialed flow against a local server).
    pub fn with_base_url(models_dir: Option<PathBuf>, base_url: &str) -> Self {
        let templates = Arc::new(transports::prime_inference_offline_entries());
        let cache_path = models_dir.map(|dir| dir.join(CACHE_FILE));
        let parse_templates = Arc::clone(&templates);
        let parse: crate::cache::CatalogParse<Vec<Model>> = Arc::new(move |payload, _scope| {
            let entries = parse_prime_inference_model_catalog(payload, false)?;
            build_prime_inference_models(&parse_templates, &entries, false, None)
                .ok_or_else(|| "Prime Inference catalog coverage gate failed".to_string())
        });
        Self {
            cache: CatalogCache::new(
                &format!("{base_url}/models"),
                cache_path,
                Arc::new(CatalogFetcher::with_limits(
                    crate::fetch::FETCH_TIMEOUT,
                    MAX_RESPONSE_BYTES,
                )),
                parse,
            ),
        }
    }

    /// The credential scope key for `credentials`.
    pub fn scope_for(&self, credentials: &PrimeInferenceCredentials) -> String {
        scope_key(
            &credentials.api_key,
            credentials.team_id.as_deref().unwrap_or_default(),
        )
    }

    /// The scope recorded in the stored disk snapshot, when one exists (the
    /// auth-scope observation's first-request seed; a login or logout that
    /// predates the process is still detected).
    pub fn stored_scope(&self) -> Option<String> {
        self.cache.stored_scope()
    }

    /// The last-good snapshot for a scope, or None (callers fall back to the
    /// compiled offline entries).
    pub fn get(&self, credentials: &PrimeInferenceCredentials) -> Option<Vec<Model>> {
        self.cache.get(&self.scope_for(credentials))
    }

    /// Clear one scope's cache (revocation, logout).
    pub fn clear(&self, credentials: &PrimeInferenceCredentials) {
        self.cache.clear(&self.scope_for(credentials));
    }

    /// Live credentialed refresh: coalesced, hourly gated, scope-isolated;
    /// 401/403 clears only this scope. Never blocks on errors.
    pub async fn refresh(
        &self,
        credentials: &PrimeInferenceCredentials,
        force: bool,
    ) -> Option<Vec<Model>> {
        let mut headers = vec![(
            "Authorization".to_string(),
            format!("Bearer {}", credentials.api_key),
        )];
        if let Some(team_id) = &credentials.team_id {
            headers.push(("X-Prime-Team-ID".to_string(), team_id.clone()));
        }
        self.cache
            .refresh(
                &self.scope_for(credentials),
                RefreshOptions {
                    force,
                    headers,
                    is_current: None,
                },
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn wire_entry(id: &str, input: f64, output: f64) -> serde_json::Value {
        json!({
            "id": id,
            "display_name": id,
            "pricing": {"input_usd_per_mtok": input, "output_usd_per_mtok": output},
            "specs": {
                "context_window": 200_000,
                "max_output_tokens": 32_768,
                "supports_reasoning": true,
                "modalities": {"input": ["text", "image"], "output": ["text"]},
            },
        })
    }

    fn payload(ids: &[&str]) -> serde_json::Value {
        json!({"data": ids.iter().map(|id| wire_entry(id, 1.0, 2.0)).collect::<Vec<_>>()})
    }

    #[test]
    fn private_ids_are_recognized() {
        assert!(is_private_prime_inference_model_id("internal/foo"));
        assert!(is_private_prime_inference_model_id("DEV/bar"));
        assert!(is_private_prime_inference_model_id("x:y"));
        assert!(!is_private_prime_inference_model_id(
            "anthropic/claude-fable-5"
        ));
    }

    #[test]
    fn scope_keys_isolate_credentials() {
        let a = scope_key("key-a", "team-1");
        let b = scope_key("key-b", "team-1");
        let c = scope_key("key-a", "team-2");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64, "hex sha256");
    }

    /// Capability filtering: a model that declares its supported request
    /// parameters without "tools" can never serve a session (the router
    /// answers 404 "No endpoints found that support tool use"), so it
    /// never enters the catalog. Entries without the declaration stay.
    #[test]
    fn parse_filters_entries_without_tool_support() {
        let mut with_tools = wire_entry("z-ai/glm-5.3", 1.0, 2.0);
        with_tools["supported_parameters"] =
            json!(["max_tokens", "temperature", "tools", "tool_choice"]);
        let mut without_tools = wire_entry("meta-llama/Llama-3.2-1B-Instruct", 1.0, 2.0);
        without_tools["supported_parameters"] = json!(["max_tokens", "temperature", "top_p"]);
        let undeclared = wire_entry("qwen/qwen3.8-max", 1.0, 4.0);
        let value = json!({"data": [with_tools, without_tools, undeclared]});
        let entries = parse_prime_inference_model_catalog(&value, false).expect("entries");
        let ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, vec!["z-ai/glm-5.3", "qwen/qwen3.8-max"]);
    }

    #[test]
    fn parse_drops_bad_entries_and_rejects_duplicates() {
        let value = json!({"data": [
            wire_entry("good", 1.0, 2.0),
            {"id": "no-pricing"},
            {"id": "good", "pricing": {"input_usd_per_mtok": 1.0, "output_usd_per_mtok": 1.0}},
        ]});
        let err = parse_prime_inference_model_catalog(&value, false).expect_err("duplicate");
        assert!(err.contains("Duplicate"), "{err}");
        let value = json!({"data": [
            wire_entry("good", 1.0, 2.0),
            {"id": "no-pricing"},
            {"id": "", "pricing": {"input_usd_per_mtok": 1.0, "output_usd_per_mtok": 1.0}},
        ]});
        let entries = parse_prime_inference_model_catalog(&value, false).expect("kept rest");
        assert_eq!(entries.len(), 1);
        assert!(parse_prime_inference_model_catalog(&json!({"data": []}), false).is_err());
        assert!(parse_prime_inference_model_catalog(&json!({"data": []}), true).is_ok());
        assert!(parse_prime_inference_model_catalog(&json!({}), false).is_err());
    }

    #[test]
    fn build_gates_on_coverage() {
        let compiled = transports::prime_inference_offline_entries();
        let ids: Vec<&str> = compiled.iter().map(|m| m.id.as_str()).take(60).collect();
        let entries = parse_prime_inference_model_catalog(&payload(&ids), false).expect("entries");
        let built = build_prime_inference_models(&compiled, &entries, false, None)
            .expect("coverage met (60 >= 55)");
        assert_eq!(built.len(), 60);
        assert!(built.iter().all(|m| m.provider == "prime-inference"));

        let thin: Vec<&str> = compiled.iter().map(|m| m.id.as_str()).take(5).collect();
        let entries = parse_prime_inference_model_catalog(&payload(&thin), false).expect("entries");
        assert!(
            build_prime_inference_models(&compiled, &entries, false, None).is_none(),
            "coverage gate rejects thin fetches"
        );
    }

    #[test]
    fn build_requires_full_specs_without_a_template() {
        let compiled = transports::prime_inference_offline_entries();
        let unknown = json!({"data": [{
            "id": "brand/new-model",
            "pricing": {"input_usd_per_mtok": 1.0, "output_usd_per_mtok": 1.0},
        }]});
        let entries = parse_prime_inference_model_catalog(&unknown, false).expect("entries");
        let built =
            build_prime_inference_models(&compiled, &entries, false, Some(0)).expect("built");
        assert_eq!(built.len(), 0, "entry without template and specs dropped");
    }

    #[test]
    fn anthropic_entries_get_cache_economics() {
        let compiled = transports::prime_inference_offline_entries();
        let mut value = payload(
            &compiled
                .iter()
                .map(|m| m.id.as_str())
                .take(60)
                .collect::<Vec<_>>(),
        );
        // A live-only anthropic entry (no compiled template): cache economics
        // default to the Anthropic 10%/125% catalog pricing, and the compat
        // gains the anthropic cache-control wire format.
        value
            .get_mut("data")
            .and_then(Value::as_array_mut)
            .unwrap()
            .push(wire_entry("anthropic/live-only-model", 2.0, 4.0));
        let entries = parse_prime_inference_model_catalog(&value, false).expect("entries");
        let built = build_prime_inference_models(&compiled, &entries, false, None).expect("built");
        let anthropic = built
            .iter()
            .find(|m| m.id == "anthropic/live-only-model")
            .unwrap();
        assert!((anthropic.cost.cache_read.as_f64() - 0.2).abs() < 1e-9);
        assert!((anthropic.cost.cache_write.as_f64() - 2.5).abs() < 1e-9);
        assert!(anthropic
            .compat
            .as_ref()
            .unwrap()
            .raw
            .get("cacheControlFormat")
            .is_some_and(|v| v == "anthropic"));
    }

    #[test]
    fn merge_swaps_the_prime_section() {
        let compiled = transports::compiled_models();
        let mut live = transports::prime_inference_offline_entries();
        live.truncate(3);
        let merged = merge_prime_inference_models(compiled, Some(&live));
        assert_eq!(merged.len(), compiled.len() - 110 + 3);
        let kept = merge_prime_inference_models(compiled, None);
        assert_eq!(kept.len(), compiled.len());
    }

    /// Port of the TS test: the parser sanitizes the live reasoning
    /// declarations (non-strings drop, duplicates collapse, only a true
    /// `mandatory` is kept).
    #[test]
    fn parses_and_sanitizes_live_reasoning_declarations() {
        let value = json!({"data": [{
            "id": "z-ai/glm-5.3",
            "display_name": "GLM 5.3",
            "pricing": {"input_usd_per_mtok": 1.4, "output_usd_per_mtok": 4.4},
            "supported_parameters": ["max_tokens", "reasoning", "reasoning_effort", "tools", 42, null],
            "reasoning": {"supported_efforts": ["low", "high", "max", "high", null], "mandatory": true},
        }]});
        let entries = parse_prime_inference_model_catalog(&value, false).expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].supported_parameters,
            Some(
                ["max_tokens", "reasoning", "reasoning_effort", "tools"]
                    .iter()
                    .copied()
                    .map(str::to_string)
                    .collect()
            )
        );
        assert_eq!(
            entries[0].reasoning_efforts,
            Some(
                ["low", "high", "max"]
                    .iter()
                    .copied()
                    .map(str::to_string)
                    .collect(),
            )
        );
        assert_eq!(entries[0].reasoning_mandatory, Some(true));
    }

    fn declared_entry(
        supported: Option<&[&str]>,
        efforts: Option<&[&str]>,
        mandatory: Option<bool>,
    ) -> PrimeInferenceEntry {
        PrimeInferenceEntry {
            supported_parameters: supported
                .map(|parameters| parameters.iter().copied().map(str::to_string).collect()),
            reasoning_efforts: efforts
                .map(|levels| levels.iter().copied().map(str::to_string).collect()),
            reasoning_mandatory: mandatory,
            ..PrimeInferenceEntry::default()
        }
    }

    fn level_map(pairs: &[(ModelThinkingLevel, Option<&str>)]) -> ThinkingLevelMap {
        pairs
            .iter()
            .map(|(level, value)| (*level, value.map(str::to_string)))
            .collect()
    }

    /// Port of the TS test: maps live `/models` reasoning metadata onto
    /// request controls. The gateway rejects undeclared efforts, and
    /// "none" disables non-mandatory effort routes.
    #[test]
    fn maps_declared_route_shapes_onto_reasoning_controls() {
        let mandatory_map = level_map(&[
            (ModelThinkingLevel::Off, None),
            (ModelThinkingLevel::Minimal, None),
            (ModelThinkingLevel::Low, Some("low")),
            (ModelThinkingLevel::Medium, None),
            (ModelThinkingLevel::High, Some("high")),
            (ModelThinkingLevel::Xhigh, None),
            (ModelThinkingLevel::Max, Some("max")),
        ]);
        let controls = prime_inference_reasoning_controls(&declared_entry(
            Some(&["reasoning", "reasoning_effort"]),
            Some(&["low", "high", "max"]),
            Some(true),
        ))
        .expect("effort route declares controls");
        assert!(controls.supports_reasoning_effort);
        assert_eq!(controls.thinking_format, None);
        assert_eq!(controls.thinking_level_map, Some(mandatory_map));

        let optional_map = level_map(&[
            (ModelThinkingLevel::Off, Some("none")),
            (ModelThinkingLevel::Minimal, None),
            (ModelThinkingLevel::Low, None),
            (ModelThinkingLevel::Medium, None),
            (ModelThinkingLevel::High, Some("high")),
            (ModelThinkingLevel::Xhigh, Some("xhigh")),
            (ModelThinkingLevel::Max, None),
        ]);
        let controls = prime_inference_reasoning_controls(&declared_entry(
            Some(&["reasoning", "reasoning_effort"]),
            Some(&["xhigh", "high"]),
            None,
        ))
        .expect("effort route declares controls");
        assert!(controls.supports_reasoning_effort);
        assert_eq!(controls.thinking_level_map, Some(optional_map));

        // Toggle routes: the reasoning object only, through the openrouter
        // format; declared efforts without reasoning_effort stay unused.
        let toggle_map = level_map(&[
            (ModelThinkingLevel::Minimal, None),
            (ModelThinkingLevel::Low, None),
            (ModelThinkingLevel::Medium, None),
            (ModelThinkingLevel::High, Some("high")),
            (ModelThinkingLevel::Xhigh, None),
            (ModelThinkingLevel::Max, None),
        ]);
        for efforts in [None, Some(&["high"][..])] {
            let controls = prime_inference_reasoning_controls(&declared_entry(
                Some(&["reasoning"]),
                efforts,
                None,
            ))
            .expect("toggle route declares controls");
            assert!(!controls.supports_reasoning_effort);
            assert_eq!(controls.thinking_format, Some(ThinkingFormat::Openrouter));
            assert_eq!(controls.thinking_level_map, Some(toggle_map.clone()));
        }

        // Reasoning-free route: no reasoning parameter is ever sent.
        let controls =
            prime_inference_reasoning_controls(&declared_entry(Some(&["max_tokens"]), None, None))
                .expect("reasoning-free route declares controls");
        assert!(!controls.supports_reasoning_effort);
        assert_eq!(controls.thinking_format, None);
        assert_eq!(controls.thinking_level_map, None);

        // Route without declarations: no controls; callers keep templates.
        assert!(prime_inference_reasoning_controls(&declared_entry(None, None, None)).is_none());
    }

    /// `entry` in the TS reference: a full-spec live route without reasoning
    /// declarations.
    fn route_entry(id: &str) -> PrimeInferenceEntry {
        PrimeInferenceEntry {
            id: id.into(),
            input: 1.0,
            output: 2.0,
            context_window: Some(200_000),
            max_tokens: Some(20_000),
            vision: Some(true),
            reasoning: Some(false),
            ..PrimeInferenceEntry::default()
        }
    }

    fn effort_entry(id: &str) -> PrimeInferenceEntry {
        PrimeInferenceEntry {
            reasoning: Some(true),
            supported_parameters: Some(vec![
                "max_tokens".into(),
                "reasoning".into(),
                "reasoning_effort".into(),
            ]),
            reasoning_efforts: Some(vec!["low".into(), "high".into(), "max".into()]),
            reasoning_mandatory: Some(true),
            ..route_entry(id)
        }
    }

    fn toggle_entry(id: &str) -> PrimeInferenceEntry {
        PrimeInferenceEntry {
            reasoning: Some(true),
            supported_parameters: Some(vec![
                "max_tokens".into(),
                "reasoning".into(),
                "include_reasoning".into(),
            ]),
            ..route_entry(id)
        }
    }

    fn template_model(id: &str) -> Model {
        Model {
            id: id.into(),
            name: format!("Bundled {id}"),
            api: "openai-completions".into(),
            provider: "prime-inference".into(),
            base_url: PRIME_INFERENCE_BASE_URL.into(),
            reasoning: true,
            thinking_level_map: Some(
                [(ModelThinkingLevel::High, Some("high".to_string()))]
                    .into_iter()
                    .collect(),
            ),
            input: vec![ModelInput::Text],
            cost: ModelCost {
                input: JsNumber::from(9.0),
                output: JsNumber::from(10.0),
                cache_read: JsNumber::from(0.9),
                cache_write: JsNumber::from(11.25),
            },
            context_window: 100_000,
            max_tokens: 10_000,
            featured: Some(true),
            headers: None,
            compat: Some(ModelCompat::from_kind(CompatKind::OpenAiCompletions(
                Box::new(OpenAiCompletionsCompat {
                    supports_developer_role: Some(false),
                    max_tokens_field: Some(pa_types::ai::MaxTokensField::MaxTokens),
                    ..OpenAiCompletionsCompat::default()
                }),
            ))),
        }
    }

    /// The stale template: a bundled entry still carrying the zai thinking
    /// format from before the catalog declared its controls.
    fn stale_template(id: &str) -> Model {
        let mut stale = template_model(id);
        let mut raw = stale.compat.take().expect("template compat").raw;
        raw.insert("thinkingFormat".into(), serde_json::json!("zai"));
        stale.compat = Some(ModelCompat { raw });
        stale
    }

    fn compat_bool(model: &Model, key: &str) -> Option<bool> {
        model
            .compat
            .as_ref()
            .expect("live model carries compat")
            .raw
            .get(key)
            .and_then(serde_json::Value::as_bool)
    }

    fn compat_raw<'a>(model: &'a Model, key: &str) -> Option<&'a serde_json::Value> {
        model
            .compat
            .as_ref()
            .expect("live model carries compat")
            .raw
            .get(key)
    }

    /// Port of the TS build tests: the live catalog is authoritative for
    /// which reasoning parameters a route accepts, so a stale template's
    /// zai format never survives a declared route.
    #[test]
    fn live_declarations_rebuild_reasoning_controls() {
        // Effort route: reasoning_effort only; mandatory routes hide off.
        let built = build_prime_inference_models(
            &[stale_template("z-ai/glm-5.3")],
            &[effort_entry("z-ai/glm-5.3")],
            false,
            Some(0),
        )
        .expect("built");
        let live = &built[0];
        assert_eq!(compat_bool(live, "supportsReasoningEffort"), Some(true));
        assert_eq!(compat_raw(live, "thinkingFormat"), None);
        let expected: ThinkingLevelMap = [
            (ModelThinkingLevel::Off, None),
            (ModelThinkingLevel::Minimal, None),
            (ModelThinkingLevel::Low, Some("low".to_string())),
            (ModelThinkingLevel::Medium, None),
            (ModelThinkingLevel::High, Some("high".to_string())),
            (ModelThinkingLevel::Xhigh, None),
            (ModelThinkingLevel::Max, Some("max".to_string())),
        ]
        .into_iter()
        .collect();
        assert_eq!(live.thinking_level_map, Some(expected));

        // Toggle route: the reasoning object only, through the openrouter
        // format.
        let built = build_prime_inference_models(
            &[stale_template("z-ai/glm-4.7")],
            &[toggle_entry("z-ai/glm-4.7")],
            false,
            Some(0),
        )
        .expect("built");
        let live = &built[0];
        assert_eq!(compat_bool(live, "supportsReasoningEffort"), Some(false));
        assert_eq!(
            compat_raw(live, "thinkingFormat"),
            Some(&serde_json::json!("openrouter"))
        );
        let expected: ThinkingLevelMap = [
            (ModelThinkingLevel::Minimal, None),
            (ModelThinkingLevel::Low, None),
            (ModelThinkingLevel::Medium, None),
            (ModelThinkingLevel::High, Some("high".to_string())),
            (ModelThinkingLevel::Xhigh, None),
            (ModelThinkingLevel::Max, None),
        ]
        .into_iter()
        .collect();
        assert_eq!(live.thinking_level_map, Some(expected));

        // Route without live declarations keeps the stale template.
        let built = build_prime_inference_models(
            &[stale_template("z-ai/glm-5.3")],
            &[route_entry("z-ai/glm-5.3")],
            false,
            Some(0),
        )
        .expect("built");
        let live = &built[0];
        assert_eq!(compat_bool(live, "supportsReasoningEffort"), None);
        assert_eq!(
            compat_raw(live, "thinkingFormat"),
            Some(&serde_json::json!("zai"))
        );
        let expected: ThinkingLevelMap = [(ModelThinkingLevel::High, Some("high".to_string()))]
            .into_iter()
            .collect();
        assert_eq!(live.thinking_level_map, Some(expected));

        // Reasoning-free route drops the stale template format and map.
        let mut reasoning_free = route_entry("qwen/qwen3-coder");
        reasoning_free.supported_parameters = Some(vec!["max_tokens".into()]);
        let built = build_prime_inference_models(
            &[stale_template("qwen/qwen3-coder")],
            &[reasoning_free],
            false,
            Some(0),
        )
        .expect("built");
        let live = &built[0];
        assert_eq!(compat_bool(live, "supportsReasoningEffort"), Some(false));
        assert_eq!(compat_raw(live, "thinkingFormat"), None);
        assert_eq!(live.thinking_level_map, None);
    }

    /// Port of the TS test: live models without a compiled template get the
    /// conservative default compat, plus whatever their routes declare.
    #[test]
    fn new_live_models_get_the_conservative_default_plus_declared_controls() {
        let built = build_prime_inference_models(
            &[],
            &[effort_entry("vendor/new"), route_entry("vendor/plain")],
            false,
            Some(0),
        )
        .expect("built");
        let declared: Vec<Option<bool>> = built
            .iter()
            .map(|model| compat_bool(model, "supportsReasoningEffort"))
            .collect();
        assert_eq!(declared, vec![Some(true), Some(false)]);
    }
}
