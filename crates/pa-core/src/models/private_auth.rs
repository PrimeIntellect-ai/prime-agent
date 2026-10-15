//! Private Prime Inference models: bundled table, team-authorized fetch,
//! HMAC-fingerprinted disk cache.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use hmac::{Hmac, Mac};
use pa_types::ai::Model;
use sha2::Sha256;

use pa_models::prime_inference::{
    build_prime_inference_models, parse_prime_inference_model_catalog, PrimeInferenceEntry,
};

use super::prime_inference::is_private_prime_inference_model_id;
use super::prime_inference_catalog::fetch_prime_inference_model_catalog;

const PRIVATE_PRIME_AUTHORIZATION_CACHE_FILE: &str = "prime-inference-private-models.json";
pub const PRIVATE_PRIME_AUTHORIZATION_CACHE_TTL_MS: u64 = 5 * 60_000;

/// Foreground entitlement fetch timeout.
pub const PRIVATE_MODEL_TIMEOUT_MS: u64 = 10_000;
/// Stale-cache background refresh timeout.
pub const PRIVATE_BACKGROUND_TIMEOUT_MS: u64 = 3_000;

/// The bundled private model table (cloned, like the TS accessor).
#[must_use]
pub fn get_private_prime_inference_models() -> Vec<Model> {
    super::prime_inference::private_prime_inference_models()
}

/// MAC the team id with the bearer token; scope string is disk-cache stable.
///
/// # Panics
///
/// The `expect` on HMAC key construction cannot fail: HMAC accepts any key length.
#[must_use]
pub fn private_prime_authorization_fingerprint(api_key: &str, team_id: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(api_key.as_bytes()).expect("hmac key");
    mac.update(b"prime-agent:private-prime-authorization:v1\0");
    mac.update(team_id.as_bytes());
    let digest = mac.finalize().into_bytes();
    digest.iter().fold(String::new(), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    })
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
    let payload = match fetch {
        Ok((payload, _entries)) => payload,
        Err(error) => {
            // 401/403 mean "no entitlements", not a failure.
            if error.contains("with status 401") || error.contains("with status 403") {
                return Ok(Vec::new());
            }
            return Err(error);
        }
    };
    private_models_from_catalog_payload(&payload, public_model_ids)
}

/// Build the team's private models from a live `/models` payload. The
/// declaration-aware pa-models parse keeps each route's supported
/// parameters and reasoning declarations, so the built models request
/// reasoning exactly the way their routes declare it.
///
/// # Errors
///
/// Propagates the catalog parse failure (a duplicate id, a payload without
/// a `data` array); the caller keeps its previous models.
fn private_models_from_catalog_payload(
    payload: &serde_json::Value,
    public_model_ids: &HashSet<String>,
) -> Result<Vec<Model>, String> {
    let parsed = parse_prime_inference_model_catalog(payload, true)?;
    let public_ids: HashSet<String> = public_model_ids
        .iter()
        .map(|id| id.to_lowercase())
        .collect();
    let bundled = super::prime_inference::private_prime_inference_models();
    let bundled_by_id: HashMap<String, &Model> = bundled
        .iter()
        .map(|model| (model.id.to_lowercase(), model))
        .collect();
    let entries_by_id: HashMap<String, &PrimeInferenceEntry> = parsed
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
        if let Some(parsed_entry) = entries_by_id.get(&lower) {
            private_entries.push((*parsed_entry).clone());
        } else if let Some(template) = bundled_by_id.get(&lower) {
            // A private id the strict parse dropped (e.g. unusable pricing)
            // still resolves through its bundled template's pricing.
            private_entries.push(PrimeInferenceEntry {
                id: id.to_string(),
                input: template.cost.input.0,
                output: template.cost.output.0,
                ..Default::default()
            });
        }
    }
    Ok(build_prime_inference_models(&bundled, &private_entries, true, Some(0)).unwrap_or_default())
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

/// The stat identity a cached parse is validated against: device, inode,
/// mtime (nanoseconds), and length (same shape as the auth document's
/// read-through cache). Every known writer replaces the file by atomic
/// rename or rewrites in place, so a matching identity means the cached
/// parse is what a fresh read would return.
#[derive(Clone, Copy, PartialEq, Eq)]
struct CacheFileIdentity {
    dev: u64,
    ino: u64,
    mtime_sec: i64,
    mtime_nsec: i64,
    len: u64,
}

// The fallible non-Unix twin pins the Option shape across
// platforms - unwrapping only this arm would split the contract.
#[allow(clippy::unnecessary_wraps)]
#[cfg(unix)]
fn cache_file_identity(metadata: &std::fs::Metadata) -> Option<CacheFileIdentity> {
    use std::os::unix::fs::MetadataExt;
    Some(CacheFileIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
        mtime_sec: metadata.mtime(),
        mtime_nsec: metadata.mtime_nsec(),
        len: metadata.len(),
    })
}

#[cfg(not(unix))]
fn cache_file_identity(metadata: &std::fs::Metadata) -> Option<CacheFileIdentity> {
    use std::time::UNIX_EPOCH;
    let modified = metadata.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(CacheFileIdentity {
        dev: 0,
        ino: 0,
        mtime_sec: since.as_secs() as i64,
        mtime_nsec: i64::from(since.subsec_nanos()),
        len: metadata.len(),
    })
}

/// One validated parse held in the process-wide read-through cache: the
/// port builds a fresh registry per resolution (TS kept one long-lived
/// registry), so the parse would otherwise re-run on every resolution.
struct CachedParse {
    identity: CacheFileIdentity,
    cache: PrivatePrimeAuthorizationCache,
}

fn parse_cache() -> &'static std::sync::Mutex<HashMap<PathBuf, CachedParse>> {
    static PARSE_CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, CachedParse>>> =
        std::sync::OnceLock::new();
    PARSE_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Read and validate the authorization cache; `None` on any mismatch.
/// The parse is served from the stat-identity snapshot while the file is
/// unchanged. Only a successful parse under an unchanged identity pins; a
/// failed read unpins any stale entry so the next call retries.
pub fn read_private_prime_authorization_cache(
    models_json_path: &Path,
) -> Option<PrivatePrimeAuthorizationCache> {
    let path = private_prime_authorization_cache_path(models_json_path);
    let before = std::fs::metadata(&path)
        .ok()
        .and_then(|m| cache_file_identity(&m));
    if let Some(identity) = before {
        if let Some(entry) = parse_cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&path)
        {
            if entry.identity == identity {
                return Some(entry.cache.clone());
            }
        }
    }
    let Some(cache) = parse_private_prime_authorization_cache(&path) else {
        // A failed read never pins: drop any superseded entry so the next
        // call retries the parse from the file as it stands.
        parse_cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&path);
        return None;
    };
    let after = std::fs::metadata(&path)
        .ok()
        .and_then(|m| cache_file_identity(&m));
    let mut entries = parse_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match (before, after) {
        (Some(before), Some(after)) if before == after => {
            entries.insert(
                path,
                CachedParse {
                    identity: after,
                    cache: cache.clone(),
                },
            );
        }
        _ => {
            entries.remove(&path);
        }
    }
    Some(cache)
}

/// The uncached read+parse (the read-through cache's miss arm).
fn parse_private_prime_authorization_cache(path: &Path) -> Option<PrivatePrimeAuthorizationCache> {
    let content = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    let fingerprint = parsed.get("fingerprint")?.as_str()?.to_string();
    let refreshed_at = parsed.get("refreshedAt")?.as_u64()?;
    let data = parsed.get("data")?.as_array()?;
    // Full built models (compat and thinking levels included) persist
    // verbatim, so a restart keeps the live routes' reasoning declarations.
    // A pre-declaration cache's reduced entries fail to deserialize and the
    // caller refetches.
    let models: Vec<Model> = serde_json::from_value(serde_json::Value::Array(data.clone())).ok()?;
    Some(PrivatePrimeAuthorizationCache {
        fingerprint,
        models,
        refreshed_at,
    })
}

/// Persist the authorization cache (best-effort atomic temp+rename write,
/// 0o600 like the TS `writeFileAtomicSync` call, which TS makes with no
/// `fsync`: a failed or lost cache write only requires a later refetch).
pub fn write_private_prime_authorization_cache(
    models_json_path: &Path,
    cache: &PrivatePrimeAuthorizationCache,
) {
    // Full built models, compat and thinking levels included: the cache
    // is a verbatim snapshot of the declaration-aware build, not a reduced
    // mirror of the wire catalog.
    let document = serde_json::json!({
        "fingerprint": cache.fingerprint,
        "data": cache.models,
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

    /// Served-path oracle (model-registry.ts:1185 passes only
    /// `{ mode: 0o600 }`): the cache write takes NO fsync branch — the
    /// refetchable cache has the weakest durability need.
    #[test]
    fn authorization_cache_write_takes_the_ts_default_no_sync() {
        let dir = tempfile::TempDir::new().unwrap();
        let models_json = dir.path().join("models.json");
        let before = crate::settings::storage::opt_in_fsync_calls();
        write_private_prime_authorization_cache(&models_json, &cache("fingerprint-a"));
        assert_eq!(
            crate::settings::storage::opt_in_fsync_calls(),
            before,
            "the TS-default cache write must not sync"
        );
        let written =
            std::fs::read_to_string(private_prime_authorization_cache_path(&models_json)).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(parsed["fingerprint"], "fingerprint-a");
        assert!(written.ends_with('}') && !written.contains('\n'));
    }

    /// A cached model priced `0.0` resolves to a model whose costs are
    /// zero — never a template's or a fallback's pricing.
    #[test]
    fn zero_priced_private_cache_models_resolve_free() {
        let dir = tempfile::TempDir::new().unwrap();
        let models_json = dir.path().join("models.json");
        let free = Model {
            id: "internal/glm-5.3-fast".to_string(),
            name: "GLM 5.3 Fast (internal)".to_string(),
            api: "openai-completions".to_string(),
            provider: "prime-inference".to_string(),
            base_url: "https://api.pinference.ai/api/v1".to_string(),
            reasoning: true,
            thinking_level_map: None,
            input: vec![pa_types::ai::ModelInput::Text],
            cost: pa_types::ai::ModelCost {
                input: pa_types::JsNumber(0.0),
                output: pa_types::JsNumber(0.0),
                cache_read: pa_types::JsNumber(0.0),
                cache_write: pa_types::JsNumber(0.0),
            },
            context_window: 1_048_576,
            max_tokens: 131_072,
            max_tokens_explicit: false,
            featured: None,
            headers: None,
            compat: None,
        };
        std::fs::write(
            private_prime_authorization_cache_path(&models_json),
            serde_json::json!({
                "fingerprint": "fingerprint-a",
                "refreshedAt": 1,
                "data": [free],
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
        // Heavy usage over the injected pricing bills $0 — not a template's or default's.
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
    fn parse_snapshot_pins_stable_parses_and_re_parses_rewrites() {
        let dir = tempfile::tempdir().unwrap();
        let models_json = dir.path().join("models.json");
        let cache_path = private_prime_authorization_cache_path(&models_json);
        write_private_prime_authorization_cache(&models_json, &cache("fingerprint-a"));
        let first = read_private_prime_authorization_cache(&models_json).expect("cache readable");
        assert_eq!(first.fingerprint, "fingerprint-a");
        // A stable parse is pinned process-wide and a repeat read is served
        // from the snapshot (the same stat identity).
        assert!(parse_cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&cache_path));
        let second = read_private_prime_authorization_cache(&models_json).expect("cache readable");
        assert_eq!(second.fingerprint, "fingerprint-a");
        // The write path's atomic rename changes the identity, so the next
        // read re-parses instead of serving the superseded entry.
        write_private_prime_authorization_cache(&models_json, &cache("fingerprint-b"));
        let third = read_private_prime_authorization_cache(&models_json).expect("cache readable");
        assert_eq!(third.fingerprint, "fingerprint-b");
    }

    #[test]
    fn parse_snapshot_never_pins_a_failed_read_or_resurrects_a_deleted_file() {
        let dir = tempfile::tempdir().unwrap();
        let models_json = dir.path().join("models.json");
        let cache_path = private_prime_authorization_cache_path(&models_json);
        std::fs::write(&cache_path, "{ not json").unwrap();
        assert!(read_private_prime_authorization_cache(&models_json).is_none());
        assert!(!parse_cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&cache_path));
        write_private_prime_authorization_cache(&models_json, &cache("fingerprint-a"));
        assert!(read_private_prime_authorization_cache(&models_json).is_some());
        // A deleted cache is never served from the snapshot.
        std::fs::remove_file(&cache_path).unwrap();
        assert!(read_private_prime_authorization_cache(&models_json).is_none());
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

    fn declaration_payload() -> serde_json::Value {
        serde_json::json!({
            "data": [{
                "id": "internal/deepseek-v4.1-flash",
                "display_name": "DeepSeek V4.1 Flash (internal)",
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
                "reasoning": {
                    "supported_efforts": ["none", "low", "high", "max"],
                    "default_effort": "high",
                    "default_enabled": false,
                    "mandatory": false,
                },
                "supported_parameters": [
                    "max_tokens", "temperature", "tools", "tool_choice",
                    "reasoning", "reasoning_effort",
                ],
            }],
        })
    }

    /// The live route declarations reach the built private model: a route
    /// that declares `reasoning_effort` must keep a compat that sends it,
    /// and the declared efforts become the thinking-level map.
    #[test]
    fn private_models_carry_live_reasoning_declarations() {
        let models = private_models_from_catalog_payload(&declaration_payload(), &HashSet::new())
            .expect("payload builds");
        let model = &models[0];
        assert_eq!(model.id, "internal/deepseek-v4.1-flash");
        assert!(model.reasoning);
        let compat = model.compat.as_ref().expect("declaration-aware compat");
        assert_eq!(
            compat.raw.get("supportsReasoningEffort"),
            Some(&serde_json::json!(true))
        );
        assert!(!compat.raw.contains_key("thinkingFormat"));
        let levels = model
            .thinking_level_map
            .as_ref()
            .expect("declared efforts become the level map");
        assert_eq!(
            levels.get(&pa_types::ai::ModelThinkingLevel::High),
            Some(&Some("high".to_string()))
        );
        assert_eq!(
            levels.get(&pa_types::ai::ModelThinkingLevel::Max),
            Some(&Some("max".to_string()))
        );
        assert_eq!(
            levels.get(&pa_types::ai::ModelThinkingLevel::Minimal),
            Some(&None)
        );
    }

    /// The cache round-trips the declaration-aware build verbatim, so a
    /// restart keeps the live route's compat and level map.
    #[test]
    fn authorization_cache_round_trips_declarations() {
        let dir = tempfile::tempdir().unwrap();
        let models_json = dir.path().join("models.json");
        let models = private_models_from_catalog_payload(&declaration_payload(), &HashSet::new())
            .expect("payload builds");
        write_private_prime_authorization_cache(
            &models_json,
            &PrivatePrimeAuthorizationCache {
                fingerprint: "fingerprint-a".to_string(),
                models,
                refreshed_at: 1,
            },
        );
        let cache = read_private_prime_authorization_cache(&models_json).expect("cache readable");
        let model = cache
            .models
            .iter()
            .find(|model| model.id == "internal/deepseek-v4.1-flash")
            .expect("the cached model resolves");
        let compat = model
            .compat
            .as_ref()
            .expect("compat survives the round trip");
        assert_eq!(
            compat.raw.get("supportsReasoningEffort"),
            Some(&serde_json::json!(true))
        );
        assert_eq!(
            model
                .thinking_level_map
                .as_ref()
                .and_then(|map| map.get(&pa_types::ai::ModelThinkingLevel::High)),
            Some(&Some("high".to_string()))
        );
    }
}
