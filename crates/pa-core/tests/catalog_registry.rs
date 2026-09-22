//! Registry-seam catalog verifiers: the no-cold-start order, transport
//! pinning, local `models.json` precedence, and the refresh-never-retargets
//! invariant, exercised through the public `ModelRegistry` surface the
//! daemon's model surfaces consume.

use std::path::Path;

use pa_core::auth::AuthStorage;
use pa_core::models::ModelRegistry;
use pa_models::cache::PUBLIC_SCOPE;
use pa_models::fetch::MODEL_CATALOG_URL;
use pa_models::transports;
use pa_models::PROVIDER_CATALOG_CACHE_FILE;
use pa_types::ai::Model;

fn compiled(provider: &str) -> &'static Model {
    transports::compiled_models()
        .iter()
        .find(|model| model.provider == provider)
        .unwrap_or_else(|| panic!("compiled {provider} model"))
}

/// A catalog entry pinned through a compiled `(provider, api, baseUrl)`
/// tuple of `provider`.
fn catalog_entry(id: &str, provider: &str) -> serde_json::Value {
    let template = compiled(provider);
    serde_json::json!({
        "id": id, "name": id,
        "api": template.api, "provider": template.provider,
        "baseUrl": template.base_url,
        "reasoning": false, "input": ["text"],
        "cost": {"input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 0.5},
        "contextWindow": 128_000, "maxTokens": 4_096,
    })
}

/// Write a last-good provider-catalog disk snapshot in the CatalogCache
/// shape beside `models_json`.
fn write_disk_cache(dir: &Path, models: Vec<serde_json::Value>) {
    let snapshot = serde_json::json!({
        "url": MODEL_CATALOG_URL,
        "scope": PUBLIC_SCOPE,
        "fetchedAt": 1,
        "payload": {"schemaVersion": 1, "models": models},
    });
    std::fs::write(
        dir.join(PROVIDER_CATALOG_CACHE_FILE),
        serde_json::to_string(&snapshot).unwrap(),
    )
    .unwrap();
}

fn fresh_registry(dir: &Path) -> ModelRegistry {
    let auth = AuthStorage::create(dir);
    ModelRegistry::create(auth, dir.join("models.json"))
}

/// The no-cold-start order at the registry seam: a validated disk cache
/// serves the remote catalog (replacing the compiled base) with the
/// bundled Prime Inference entries alongside; without one, the compiled
/// fallback serves.
#[test]
fn registry_serves_the_no_cold_start_chain_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let registry = fresh_registry(dir.path());
    // No cache, no bundled asset: the compiled fallback.
    assert!(registry
        .get_all()
        .iter()
        .any(|model| model.id == compiled("anthropic").id));

    write_disk_cache(dir.path(), vec![catalog_entry("cached-a", "anthropic")]);
    let registry = fresh_registry(dir.path());
    let models = registry.get_all();
    assert!(models.iter().any(|model| model.id == "cached-a"));
    // The remote snapshot replaces the compiled public providers...
    assert!(
        !models.iter().any(|model| model.provider == "openai"),
        "the remote catalog replaces the compiled public base"
    );
    // ...but the bundled Prime Inference entries still surface.
    assert!(models
        .iter()
        .any(|model| model.provider == "prime-inference"));
}

/// Transport pinning at the registry seam: a catalog entry whose
/// `(provider, api, baseUrl)` matches no compiled tuple never surfaces.
#[test]
fn registry_drops_non_pinned_catalog_entries() {
    let dir = tempfile::tempdir().unwrap();
    // An entry whose tuple matches no compiled transport, plus one that
    // tries to smuggle request headers through the catalog.
    let mut evil = catalog_entry("attacker-model", "anthropic");
    evil["provider"] = serde_json::json!("attacker");
    evil["baseUrl"] = serde_json::json!("https://attacker.example");
    evil["headers"] = serde_json::json!({"X-Evil": "1"});
    write_disk_cache(
        dir.path(),
        vec![evil, catalog_entry("pinned-a", "anthropic")],
    );
    let registry = fresh_registry(dir.path());
    let models = registry.get_all();
    assert!(models.iter().any(|model| model.id == "pinned-a"));
    assert!(
        !models.iter().any(|model| model.id == "attacker-model"),
        "a non-compiled tuple never surfaces"
    );
    assert!(
        !models.iter().any(|model| model
            .headers
            .as_ref()
            .is_some_and(|headers| headers.contains_key("X-Evil"))),
        "catalog data never carries request headers"
    );
}

/// The user's local `models.json` takes precedence over the remote catalog:
/// a custom definition wins the provider+id conflict against the cache.
#[test]
fn local_models_json_wins_over_the_remote_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let template = compiled("anthropic");
    write_disk_cache(dir.path(), vec![catalog_entry("claude-mine", "anthropic")]);
    std::fs::write(
        dir.path().join("models.json"),
        serde_json::json!({
            "providers": {
                "anthropic": {
                    "baseUrl": template.base_url,
                    "apiKey": "sk-local",
                    "models": [{
                        "id": "claude-mine",
                        "name": "My local override",
                        "contextWindow": 1000,
                        "maxTokens": 100
                    }]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let registry = fresh_registry(dir.path());
    let model = registry
        .get_all()
        .iter()
        .find(|model| model.id == "claude-mine")
        .expect("the custom model surfaces");
    assert_eq!(model.name, "My local override");
    assert_eq!(model.context_window, 1000);
}

/// A mid-session refresh never retargets the active model: the resolved
/// `Model` value the session keeps is unaffected by a later catalog change,
/// and re-resolving the same selector after the refresh keeps the pinned
/// transport identity (`api` + `baseUrl` + request headers).
#[test]
fn refresh_never_retargets_the_active_model() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("models.json"),
        serde_json::json!({
            "providers": {
                "anthropic": {
                    "baseUrl": compiled("anthropic").base_url,
                    "apiKey": "sk-ant",
                    "authHeader": true
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    write_disk_cache(
        dir.path(),
        vec![catalog_entry("claude-stable", "anthropic")],
    );
    let mut registry = fresh_registry(dir.path());
    let active = registry
        .get_available()
        .into_iter()
        .find(|model| model.id == "claude-stable")
        .expect("resolves from the remote snapshot")
        .clone();

    // The catalog changes mid-session: the entry reappears with different
    // data, still pinned through the compiled anthropic transport.
    write_disk_cache(
        dir.path(),
        vec![{
            let mut entry = catalog_entry("claude-stable", "anthropic");
            entry["name"] = serde_json::json!("Renamed upstream");
            entry
        }],
    );
    registry.refresh();
    // The session keeps its model value: identity and transport unchanged.
    assert_eq!(active.id, "claude-stable");
    assert_eq!(active.provider, "anthropic");
    assert_eq!(active.api, compiled("anthropic").api);
    assert_eq!(active.base_url, compiled("anthropic").base_url);
    assert_eq!(
        active.headers,
        compiled("anthropic").headers,
        "request headers come from the compiled transport, never the catalog"
    );
    // Re-resolution after the refresh keeps the pinned transport.
    let reresolved = registry
        .get_available()
        .into_iter()
        .find(|model| model.id == "claude-stable")
        .expect("still resolvable")
        .clone();
    assert_eq!(reresolved.api, active.api);
    assert_eq!(reresolved.base_url, active.base_url);
    assert_eq!(reresolved.headers, active.headers);
}
