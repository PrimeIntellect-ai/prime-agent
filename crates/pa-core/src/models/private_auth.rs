//! Private Prime Inference models: bundled table, team-authorized fetch,
//! HMAC-fingerprinted disk cache. Port of prime-inference-models.ts plus the
//! registry's private-prime authorization cache.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use hmac::{Hmac, Mac};
use pa_types::ai::Model;
use sha2::Sha256;

use super::prime_inference::is_private_prime_inference_model_id;
use super::prime_inference_catalog::{
    build_prime_inference_models_with_minimum, fetch_prime_inference_model_catalog,
    parse_prime_inference_model_catalog, PrimeInferenceCatalogEntry,
};

const PRIVATE_PRIME_AUTHORIZATION_CACHE_FILE: &str = "prime-inference-private-models.json";
pub const PRIVATE_PRIME_AUTHORIZATION_CACHE_TTL_MS: u64 = 5 * 60_000;

/// Foreground entitlement fetch timeout (TS `PRIVATE_MODEL_REFRESH_TIMEOUT_MS`).
pub const PRIVATE_MODEL_TIMEOUT_MS: u64 = 10_000;
/// Stale-cache background refresh timeout.
pub const PRIVATE_BACKGROUND_TIMEOUT_MS: u64 = 3_000;

/// The bundled private model table (cloned, like the TS accessor).
pub fn get_private_prime_inference_models() -> Vec<Model> {
    super::prime_inference::private_prime_inference_models()
}

/// MAC the team id with the bearer token; scope string is disk-cache stable.
///
/// # Panics
///
/// The `expect` on HMAC key construction cannot fail: HMAC accepts any key
/// length, so this never panics.
pub fn private_prime_authorization_fingerprint(api_key: &str, team_id: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(api_key.as_bytes()).expect("hmac key");
    mac.update(b"prime-agent:private-prime-authorization:v1\0");
    mac.update(team_id.as_bytes());
    let digest = mac.finalize().into_bytes();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Fetch the team's authorized private models; 401/403 settle to empty.
/// `base_url` is the Prime Inference API base (the shared catalog's, so
/// hermetic tests aim the whole flow at a local server).
pub async fn fetch_authorized_private_prime_inference_models(
    base_url: &str,
    api_key: &str,
    team_headers: &HashMap<String, String>,
    public_model_ids: &HashSet<String>,
    timeout_ms: u64,
) -> Result<Vec<Model>, String> {
    if team_headers.get("X-Prime-Team-ID").is_none() {
        return Ok(Vec::new());
    }
    let mut headers = team_headers.clone();
    headers.insert("Authorization".to_string(), format!("Bearer {api_key}"));
    let fetch =
        fetch_prime_inference_model_catalog(base_url, Some(&headers), timeout_ms, true).await;
    let (payload, entries) = match fetch {
        Ok(result) => result,
        Err(error) => {
            // 401/403 mean "no entitlements", not a failure.
            if error.contains("with status 401") || error.contains("with status 403") {
                return Ok(Vec::new());
            }
            return Err(error);
        }
    };
    let public_ids: HashSet<String> = public_model_ids
        .iter()
        .map(|id| id.to_lowercase())
        .collect();
    let bundled = super::prime_inference::private_prime_inference_models();
    let bundled_by_id: HashMap<String, &Model> = bundled
        .iter()
        .map(|model| (model.id.to_lowercase(), model))
        .collect();
    let entries_by_id: HashMap<String, &PrimeInferenceCatalogEntry> = entries
        .iter()
        .map(|entry| (entry.id.to_lowercase(), entry))
        .collect();
    let Some(data) = payload.get("data").and_then(|data| data.as_array()) else {
        return Ok(Vec::new());
    };
    let mut private_entries = Vec::new();
    for item in data {
        let Some(id) = item.get("id").and_then(|id| id.as_str()) else {
            continue;
        };
        let lower = id.to_lowercase();
        if public_ids.contains(&lower) || !is_private_prime_inference_model_id(&lower) {
            continue;
        }
        if let Some(parsed) = entries_by_id.get(&lower) {
            private_entries.push((*parsed).clone());
        } else if let Some(template) = bundled_by_id.get(&lower) {
            private_entries.push(PrimeInferenceCatalogEntry {
                id: id.to_string(),
                input: template.cost.input.0,
                output: template.cost.output.0,
                ..Default::default()
            });
        }
    }
    Ok(
        build_prime_inference_models_with_minimum(&bundled, &private_entries, true, Some(0))
            .unwrap_or_default(),
    )
}

/// A cached authorization: fingerprint-scoped models with a refresh timestamp.
#[derive(Debug, Clone)]
pub struct PrivatePrimeAuthorizationCache {
    pub fingerprint: String,
    pub models: Vec<Model>,
    pub refreshed_at: u64,
}

pub fn private_prime_authorization_cache_path(models_json_path: &Path) -> PathBuf {
    models_json_path
        .parent()
        .unwrap_or(models_json_path)
        .join(PRIVATE_PRIME_AUTHORIZATION_CACHE_FILE)
}

/// Read and validate the authorization cache; `None` on any mismatch.
pub fn read_private_prime_authorization_cache(
    models_json_path: &Path,
) -> Option<PrivatePrimeAuthorizationCache> {
    let content =
        std::fs::read_to_string(private_prime_authorization_cache_path(models_json_path)).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    let fingerprint = parsed.get("fingerprint")?.as_str()?.to_string();
    let refreshed_at = parsed.get("refreshedAt")?.as_u64()?;
    let data = parsed.get("data")?.as_array()?;
    let entries = parse_prime_inference_model_catalog(&serde_json::json!({ "data": data }), true)
        .ok()?
        .into_iter()
        .filter(|entry| is_private_prime_inference_model_id(&entry.id))
        .collect::<Vec<_>>();
    let models = build_prime_inference_models_with_minimum(
        &super::prime_inference::private_prime_inference_models(),
        &entries,
        true,
        Some(0),
    )
    .unwrap_or_default();
    Some(PrivatePrimeAuthorizationCache {
        fingerprint,
        models,
        refreshed_at,
    })
}

/// Persist the authorization cache (best-effort atomic temp+rename write,
/// 0o600 like the TS `writeFileAtomicSync` call).
pub fn write_private_prime_authorization_cache(
    models_json_path: &Path,
    cache: &PrivatePrimeAuthorizationCache,
) {
    let data: Vec<serde_json::Value> = cache
        .models
        .iter()
        .map(|model| {
            serde_json::json!({
                "id": model.id,
                "display_name": model.name,
                "pricing": {
                    "input_usd_per_mtok": model.cost.input.0,
                    "output_usd_per_mtok": model.cost.output.0,
                    "cache_read_usd_per_mtok": model.cost.cache_read.0,
                    "cache_write_usd_per_mtok": model.cost.cache_write.0,
                },
                "specs": {
                    "context_window": model.context_window,
                    "max_output_tokens": model.max_tokens,
                    "modalities": { "input": model.input.iter().map(|i| match i { pa_types::ai::ModelInput::Text => "text", pa_types::ai::ModelInput::Image => "image" }).collect::<Vec<_>>(), "output": ["text"] },
                    "supports_reasoning": model.reasoning,
                }
            })
        })
        .collect();
    let document = serde_json::json!({
        "fingerprint": cache.fingerprint,
        "data": data,
        "refreshedAt": cache.refreshed_at,
    });
    let path = private_prime_authorization_cache_path(models_json_path);
    let _ = crate::settings::storage::atomic_write(
        &path,
        &serde_json::to_string(&document).unwrap_or_default(),
    );
}

/// `PI_OFFLINE=1/true/yes` disables network refreshes.
pub fn is_offline_mode_enabled() -> bool {
    match std::env::var("PI_OFFLINE") {
        Ok(value) => {
            value == "1" || value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("yes")
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache(fingerprint: &str) -> PrivatePrimeAuthorizationCache {
        PrivatePrimeAuthorizationCache {
            fingerprint: fingerprint.to_string(),
            models: get_private_prime_inference_models(),
            refreshed_at: 1,
        }
    }

    /// The injected private models keep their zero pricing end to end: a
    /// cache entry priced `0.0` (the free internal models) resolves to a
    /// model whose costs are zero, so the provider cost calculation bills
    /// nothing for them — never a template's or a fallback's pricing.
    #[test]
    fn zero_priced_private_cache_models_resolve_free() {
        let dir = tempfile::TempDir::new().unwrap();
        let models_json = dir.path().join("models.json");
        std::fs::write(
            private_prime_authorization_cache_path(&models_json),
            serde_json::json!({
                "fingerprint": "fingerprint-a",
                "refreshedAt": 1,
                "data": [{
                    "id": "internal/glm-5.3-fast",
                    "display_name": "GLM 5.3 Fast (internal)",
                    "pricing": {
                        "input_usd_per_mtok": 0.0,
                        "output_usd_per_mtok": 0.0,
                        "cache_read_usd_per_mtok": 0.0,
                        "cache_write_usd_per_mtok": 0.0,
                    },
                    "specs": {
                        "context_window": 1_048_576,
                        "max_output_tokens": 131_072,
                        "modalities": { "input": ["text"], "output": ["text"] },
                        "supports_reasoning": true,
                    },
                }],
            })
            .to_string(),
        )
        .unwrap();
        let cache = read_private_prime_authorization_cache(&models_json).expect("cache readable");
        let model = cache
            .models
            .iter()
            .find(|model| model.id == "internal/glm-5.3-fast")
            .expect("the injected model resolves");
        assert_eq!(model.cost.input.0, 0.0);
        assert_eq!(model.cost.output.0, 0.0);
        // The provider cost calculation over a heavy usage bills $0: the
        // injected pricing, not a template's or a default's.
        let usage = pa_types::ai::Usage {
            input: 21_000_000,
            output: 1_700_000,
            cache_read: 2_000_000_000,
            cache_write: 1_000_000,
            ..pa_types::ai::Usage::default()
        };
        let cost = pa_ai::models::calculate_cost_values(model, &usage, None);
        assert_eq!(cost.input.0, 0.0);
        assert_eq!(cost.output.0, 0.0);
        assert_eq!(cost.cache_read.0, 0.0);
        assert_eq!(cost.cache_write.0, 0.0);
        assert_eq!(cost.total.0, 0.0);
    }

    #[test]
    fn cache_write_is_private_and_survives_a_failed_write() {
        let dir = tempfile::tempdir().unwrap();
        let models_json = dir.path().join("models.json");
        let cache_path = private_prime_authorization_cache_path(&models_json);
        write_private_prime_authorization_cache(&models_json, &cache("fingerprint-a"));
        // The TS cache write is a 0o600 atomic write; the rename carries
        // the temp's mode onto the destination.
        #[cfg(unix)]
        assert_eq!(crate::platform::perms::file_mode(&cache_path), Some(0o600));
        assert_eq!(
            read_private_prime_authorization_cache(&models_json)
                .expect("cache readable")
                .fingerprint,
            "fingerprint-a"
        );
        // Block the temp slot with a directory: the next write fails and
        // the fingerprint-a cache survives for the next reader.
        let temp = dir.path().join(format!(
            "{}.tmp{}",
            cache_path.display(),
            std::process::id()
        ));
        std::fs::create_dir(&temp).unwrap();
        write_private_prime_authorization_cache(&models_json, &cache("fingerprint-b"));
        assert_eq!(
            read_private_prime_authorization_cache(&models_json)
                .expect("cache readable")
                .fingerprint,
            "fingerprint-a"
        );
    }
}
