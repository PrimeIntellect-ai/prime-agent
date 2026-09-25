//! Bundled snapshot loading: the second step of the no-cold-start chain.
//!
//! Ported from `bundled-model-catalog.ts`: the packaged assets
//! (`models.bundled.json` + `mcp-services.bundled.json`) are generated at
//! build time and shipped beside the executable (a damaged installation
//! still offers the compiled model definitions). The models asset is parsed
//! with the strict schema, pinned to compiled transports, and joined with
//! the compiled offline Prime Inference entries so onboarding works before
//! the first credentialed fetch.

use std::path::{Path, PathBuf};

use crate::pinning::{pin_catalog_models, PinnedTemplates};
use crate::prime_inference::is_private_prime_inference_model_id;
use crate::schema::{parse_model_catalog, InvalidEntries};
use crate::transports;
use crate::Model;

/// The packaged models asset file name.
pub const PACKAGED_MODEL_CATALOG_FILE: &str = "models.bundled.json";

/// The packaged MCP services asset file name (parsed by the plugins lane).
pub const PACKAGED_MCP_CATALOG_FILE: &str = "mcp-services.bundled.json";

/// Location of the bundled catalog assets.
#[derive(Debug, Clone)]
pub struct BundledAssets {
    dir: PathBuf,
}

impl BundledAssets {
    /// The package directory: `PI_PACKAGE_DIR` when set (the wire-internal
    /// identifier, kept for TS parity), else the executable's directory.
    pub fn package_dir() -> PathBuf {
        std::env::var_os("PI_PACKAGE_DIR")
            .filter(|value| !value.is_empty())
            .map_or_else(
                || {
                    std::env::current_exe()
                        .ok()
                        .and_then(|exe| exe.parent().map(Path::to_path_buf))
                        .unwrap_or_default()
                },
                PathBuf::from,
            )
    }

    /// Assets at the package root ([`BundledAssets::package_dir`]).
    pub fn at_package_root() -> Self {
        Self {
            dir: Self::package_dir(),
        }
    }

    /// Assets at an explicit directory (tests, staged installs).
    pub fn from_dir(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The directory the assets are read from.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Raw bytes of the bundled models snapshot, when the install has one.
    pub fn read_models(&self) -> Option<String> {
        std::fs::read_to_string(self.dir.join(PACKAGED_MODEL_CATALOG_FILE)).ok()
    }

    /// Raw bytes of the bundled MCP services snapshot (the plugins lane owns
    /// parsing it).
    pub fn read_mcp_services(&self) -> Option<String> {
        std::fs::read_to_string(self.dir.join(PACKAGED_MCP_CATALOG_FILE)).ok()
    }
}

/// Load + pin the bundled models snapshot. `None` (missing/damaged asset)
/// falls back to the compiled model definitions; the same shape TS
/// `loadBundledModels` catches for.
pub fn load_bundled_models(asset: &str, templates: &PinnedTemplates) -> Option<Vec<Model>> {
    let payload: serde_json::Value = serde_json::from_str(asset).ok()?;
    let catalog = parse_model_catalog(&payload, InvalidEntries::Reject).ok()?;
    let mut models = pin_catalog_models(catalog.models.clone(), templates).ok()?;
    // Prime Inference ships compiled (110 offline entries) — the packaged
    // aggregate never carries it. Join any asset-provided prime entries
    // (pinned to the compiled tuple) plus the compiled offline entries.
    for model in catalog.models {
        if model.provider != "prime-inference"
            || model.api != "openai-completions"
            || model.base_url != crate::prime_inference::PRIME_INFERENCE_BASE_URL
            || is_private_prime_inference_model_id(&model.id)
        {
            continue;
        }
        models.push(model);
    }
    let offline = transports::prime_inference_offline_entries();
    for model in offline {
        if !models
            .iter()
            .any(|existing| existing.id == model.id && existing.provider == model.provider)
        {
            models.push(model);
        }
    }
    Some(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn asset(models: Vec<serde_json::Value>) -> String {
        serde_json::to_string_pretty(&json!({"schemaVersion": 1, "models": models})).unwrap()
    }

    fn entry(id: &str, provider: &str) -> serde_json::Value {
        let compiled = transports::compiled_models();
        let template = compiled
            .iter()
            .find(|m| m.provider == provider)
            .expect("compiled provider");
        json!({
            "id": id,
            "name": id,
            "api": template.api,
            "provider": template.provider,
            "baseUrl": template.base_url,
            "reasoning": false,
            "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 128_000,
            "maxTokens": 4_096,
        })
    }

    #[test]
    fn loads_pins_and_joins_prime_offline_entries() {
        let asset = asset(vec![entry("m1", "anthropic"), entry("m2", "openai")]);
        let models =
            load_bundled_models(&asset, &PinnedTemplates::from_compiled()).expect("loaded");
        assert!(
            models.len() > 110,
            "pinned entries + 110 offline prime entries"
        );
        assert_eq!(
            models
                .iter()
                .filter(|m| m.provider == "prime-inference")
                .count(),
            110
        );
    }

    #[test]
    fn damaged_asset_returns_none_for_the_compiled_fallback() {
        assert!(load_bundled_models("{\"not json", &PinnedTemplates::from_compiled()).is_none());
        let damaged = asset(vec![json!({"id": "broken"})]);
        assert!(load_bundled_models(&damaged, &PinnedTemplates::from_compiled()).is_none());
    }

    #[test]
    fn from_dir_reads_assets() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(PACKAGED_MCP_CATALOG_FILE), "{}").unwrap();
        let assets = BundledAssets::from_dir(dir.path());
        assert!(assets.read_mcp_services().is_some());
        assert!(assets.read_models().is_none());
        assert_eq!(assets.dir(), dir.path());
    }
}
