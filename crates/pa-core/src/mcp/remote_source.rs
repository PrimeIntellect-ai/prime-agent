//! The remote plugins-catalog snapshot source for resolution: the validated
//! last-good disk cache (written by the fetch lane at
//! `<agent-dir>/mcp-service-catalog.v2.json`), else the packaged bundled
//! snapshot (`<package-dir>/mcp-services.bundled.json`), else nothing (the
//! compiled linear/notion fallback still resolves). Read-only: fetching,
//! cadence, and cache writing live in the fetch lane; this module only
//! parses what is already on disk, fail-closed.

use std::path::Path;

use super::catalog_schema::{parse_plugins_catalog, PluginsCatalog};

/// The validated last-good disk cache the fetch lane (pa-models) writes;
/// the plugins side only reads it — fetching, cadence, and the cache write
/// live with the fetch layer.
pub const PLUGINS_CACHE_FILE: &str = "mcp-service-catalog.v2.json";

/// Read the best available remote snapshot (disk cache first, then the
/// bundled asset). Every parse error yields `None` — the caller keeps the
/// compiled built-ins and never surfaces the error into a session.
pub fn remote_plugins_snapshot(agent_dir: &Path) -> Option<PluginsCatalog> {
    let cache = agent_dir.join(PLUGINS_CACHE_FILE);
    if let Ok(bytes) = std::fs::read(&cache) {
        if let Ok(catalog) = parse_plugins_catalog(&bytes) {
            return Some(catalog);
        }
        // An invalid cache falls through to the bundled snapshot.
    }
    bundled_plugins_snapshot()
}

/// The packaged bundled snapshot (`PI_PACKAGE_DIR` override included): the
/// build-time asset the packer ships beside the executable, read through
/// the fetch lane's asset reader (same package-dir resolution).
pub fn bundled_plugins_snapshot() -> Option<PluginsCatalog> {
    let assets = pa_models::bundled::BundledAssets::at_package_root();
    let raw = assets.read_mcp_services()?;
    parse_plugins_catalog(raw.as_bytes()).ok()
}
