//! The registry's provider-model-catalog seam.
//!
//! Port of the catalog wiring `model-registry.ts` gains on the TS
//! `feat/catalog-client` branch: the registry composes the no-cold-start
//! provider catalog itself (validated last-good disk cache -> packaged
//! bundled snapshot -> compiled fallback), pinning remote payloads against
//! the bundled list exactly like the TS registry (`new CatalogCache(url,
//! path, parseProviderModelCatalog(payload, this.bundledCatalogModels))`).
//! The refresh cadence is hourly-gated, fire-and-forget, and coalesced by
//! [`pa_models::cache::CatalogCache`]; every failure keeps the last-good
//! snapshot.

use std::path::Path;
use std::sync::Arc;

use pa_models::bundled::{load_bundled_models, BundledAssets};
use pa_models::cache::{CatalogCache, CatalogParse, RefreshOptions, PUBLIC_SCOPE};
use pa_models::fetch::{CatalogFetcher, MODEL_CATALOG_URL};
use pa_models::pinning::{parse_provider_model_catalog, PinnedTemplates};
use pa_models::transports;
use pa_models::PROVIDER_CATALOG_CACHE_FILE;
use pa_types::ai::Model;

/// The no-cold-start provider catalog the registry builds its catalog from.
pub(crate) struct ProviderModelCatalog {
    cache: CatalogCache<Vec<Model>>,
    /// The bundled catalog models (TS `getBundledModels`): the packaged
    /// snapshot pinned to compiled transports, or the compiled fallback.
    /// Also the pinning template for remote payloads.
    bundled: Vec<Model>,
}

impl ProviderModelCatalog {
    /// A catalog whose disk cache lives beside `models_json_path` (None =
    /// in-memory registry use, mirroring the TS undefined cache path).
    pub(crate) fn new(models_json_path: Option<&Path>) -> Self {
        let bundled = bundled_catalog_models();
        let templates = PinnedTemplates::from_models(bundled.iter().cloned());
        let parse: CatalogParse<Vec<Model>> =
            Arc::new(move |payload, _scope| parse_provider_model_catalog(payload, &templates));
        let cache_path = models_json_path.map(|path| {
            path.parent()
                .unwrap_or(path)
                .join(PROVIDER_CATALOG_CACHE_FILE)
        });
        Self {
            cache: CatalogCache::new(
                MODEL_CATALOG_URL,
                cache_path,
                Arc::new(CatalogFetcher::new()),
                parse,
            ),
            bundled,
        }
    }

    /// The bundled catalog models: the packaged snapshot, or the compiled
    /// model definitions when the asset is missing or damaged.
    pub(crate) fn bundled_models(&self) -> &[Model] {
        &self.bundled
    }

    /// The validated last-good remote snapshot, when one exists.
    pub(crate) fn remote_models(&self) -> Option<Vec<Model>> {
        self.cache.get(PUBLIC_SCOPE)
    }

    /// Refresh the remote snapshot (hourly-gated unless forced); every
    /// failure keeps the last-good snapshot.
    pub(crate) async fn refresh(&self, force: bool) -> Option<Vec<Model>> {
        self.cache
            .refresh(
                PUBLIC_SCOPE,
                RefreshOptions {
                    force,
                    headers: Vec::new(),
                    is_current: None,
                },
            )
            .await
    }
}

/// TS `getBundledModels`: the packaged snapshot pinned to compiled
/// transports, falling back to the compiled model definitions when the
/// asset is missing or damaged (a damaged install still offers models).
fn bundled_catalog_models() -> Vec<Model> {
    let templates = PinnedTemplates::from_compiled();
    BundledAssets::at_package_root()
        .read_models()
        .and_then(|asset| load_bundled_models(&asset, &templates))
        .unwrap_or_else(|| transports::compiled_models().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_bundled_asset_falls_back_to_the_compiled_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = ProviderModelCatalog::new(Some(&dir.path().join("models.json")));
        assert_eq!(
            catalog.bundled_models().len(),
            transports::compiled_models().len()
        );
        // No disk cache: no remote snapshot.
        assert!(catalog.remote_models().is_none());
    }

    #[test]
    fn disk_cache_beats_the_compiled_fallback() {
        let dir = tempfile::tempdir().unwrap();
        // A snapshot in the CatalogCache disk shape, pinned through the
        // compiled anthropic transport.
        let compiled = transports::compiled_models();
        let anthropic = compiled
            .iter()
            .find(|m| m.provider == "anthropic")
            .expect("compiled anthropic");
        let payload = serde_json::json!({
            "schemaVersion": 1,
            "models": [{
                "id": "cached-a", "name": "cached-a",
                "api": anthropic.api, "provider": anthropic.provider,
                "baseUrl": anthropic.base_url,
                "reasoning": false, "input": ["text"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "contextWindow": 128_000, "maxTokens": 4_096,
            }]
        });
        let snapshot = serde_json::json!({
            "url": MODEL_CATALOG_URL,
            "scope": PUBLIC_SCOPE,
            "fetchedAt": 1,
            "payload": payload,
        });
        std::fs::write(
            dir.path().join(PROVIDER_CATALOG_CACHE_FILE),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let catalog = ProviderModelCatalog::new(Some(&dir.path().join("models.json")));
        let remote = catalog.remote_models().expect("validated disk cache");
        assert_eq!(remote.len(), 1);
        assert_eq!(remote[0].id, "cached-a");
    }

    #[test]
    fn non_pinned_disk_entries_never_surface() {
        let dir = tempfile::tempdir().unwrap();
        let payload = serde_json::json!({
            "schemaVersion": 1,
            "models": [{
                "id": "evil", "name": "evil",
                "api": "openai-completions", "provider": "attacker",
                "baseUrl": "https://attacker.example",
                "reasoning": false, "input": ["text"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "contextWindow": 128_000, "maxTokens": 4_096,
            }]
        });
        let snapshot = serde_json::json!({
            "url": MODEL_CATALOG_URL,
            "scope": PUBLIC_SCOPE,
            "fetchedAt": 1,
            "payload": payload,
        });
        std::fs::write(
            dir.path().join(PROVIDER_CATALOG_CACHE_FILE),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let catalog = ProviderModelCatalog::new(Some(&dir.path().join("models.json")));
        // The whole snapshot fails pinning: the compiled fallback serves.
        assert!(catalog.remote_models().is_none());
        assert_eq!(
            catalog.bundled_models().len(),
            transports::compiled_models().len()
        );
    }
}
