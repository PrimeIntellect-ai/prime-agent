//! The remote plugins-catalog snapshot source for resolution: the validated
//! last-good disk cache (written by the fetch lane at
//! `<agent-dir>/mcp-service-catalog.v2.json`), else the packaged bundled
//! snapshot (`<package-dir>/mcp-services.bundled.json`), else nothing (the
//! compiled linear/notion fallback still resolves). Read-only: fetching,
//! cadence, and cache writing live in the fetch lane; this module only
//! parses what is already on disk, fail-closed.
//!
//! The cache read mirrors TS `CatalogCache.get` over the fetch lane's disk
//! form (`{url, scope, fetchedAt, etag?, payload}`): the snapshot must
//! belong to THIS catalog url and the public scope, `fetchedAt` must be a
//! finite number, and it serves at ANY age — last-good, because a failed
//! refresh keeps yesterday's truth instead of inventing absence.
//! Historical cache locations (beside the agent files, and the
//! intermediate `catalog/` directory) stay readable so an upgrade never
//! costs a cold fetch.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::catalog_schema::{parse_plugins_catalog, PluginsCatalog};
use pa_models::cache::PUBLIC_SCOPE;
use pa_models::fetch::MCP_SERVICE_CATALOG_URL;

/// The validated last-good disk cache the fetch lane (pa-models) writes;
/// the plugins side only reads it — fetching, cadence, and the cache write
/// live with the fetch layer.
pub const PLUGINS_CACHE_FILE: &str = "mcp-service-catalog.v2.json";

/// The snapshot envelope the fetch lane writes atomically (pa-models
/// `SnapshotFile`, the TS `CatalogCache` disk `Snapshot<T>`): `url`,
/// `scope`, `fetchedAt`, and the catalog document as `payload`. Keys the
/// reader does not need (the refresh `etag`) are tolerated, like the TS
/// reader.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEnvelope {
    url: String,
    scope: String,
    fetched_at: f64,
    payload: serde_json::Value,
}

/// The validated catalog inside one snapshot file, when the file is a
/// well-formed snapshot of THIS catalog: the url and scope must match and
/// the payload must parse as a plugins catalog. Any age serves
/// (last-good); a snapshot for anything else is not this catalog's truth.
fn snapshot_catalog(bytes: &[u8]) -> Option<PluginsCatalog> {
    let envelope: SnapshotEnvelope = serde_json::from_slice(bytes).ok()?;
    if envelope.url != MCP_SERVICE_CATALOG_URL
        || envelope.scope != PUBLIC_SCOPE
        || !envelope.fetched_at.is_finite()
    {
        return None;
    }
    let payload = serde_json::to_vec(&envelope.payload).ok()?;
    parse_plugins_catalog(&payload).ok()
}

/// The cache file candidates in TS order: the primary path inside the
/// agent dir first, then the historical locations beside the agent files
/// and in the intermediate `catalog/` directory (read-only fallbacks).
fn cache_candidates(agent_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![agent_dir.join(PLUGINS_CACHE_FILE)];
    if let Some(parent) = agent_dir.parent() {
        candidates.push(parent.join(PLUGINS_CACHE_FILE));
        candidates.push(parent.join("catalog").join(PLUGINS_CACHE_FILE));
    }
    candidates
}

/// Read the best available remote snapshot (the validated disk cache, then
/// the bundled asset). Every parse error yields `None` — the caller keeps
/// the compiled built-ins and never surfaces the error into a session.
pub fn remote_plugins_snapshot(agent_dir: &Path) -> Option<PluginsCatalog> {
    cache_plugins_snapshot(agent_dir).or_else(bundled_plugins_snapshot)
}

/// The validated last-good disk cache: the primary path inside the agent
/// dir, then the historical locations. The packaged bundle is deliberately
/// NOT part of this read — the cache alone answers whether the fetch
/// lane's truth is on disk.
fn cache_plugins_snapshot(agent_dir: &Path) -> Option<PluginsCatalog> {
    for path in cache_candidates(agent_dir) {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Some(catalog) = snapshot_catalog(&bytes) {
                return Some(catalog);
            }
            // An unusable candidate falls through to the next one.
        }
    }
    None
}

/// The packaged bundled snapshot (`PI_PACKAGE_DIR` override included): the
/// build-time asset the packer ships beside the executable, read through
/// the fetch lane's asset reader (same package-dir resolution).
pub fn bundled_plugins_snapshot() -> Option<PluginsCatalog> {
    let assets = pa_models::bundled::BundledAssets::at_package_root();
    let raw = assets.read_mcp_services()?;
    parse_plugins_catalog(raw.as_bytes()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real shipped catalog fixture (the same payload the fetch lane
    /// caches), wrapped in the fetch lane's snapshot envelope.
    fn snapshot_file(entries: serde_json::Value) -> Vec<u8> {
        let snapshot = serde_json::json!({
            "url": MCP_SERVICE_CATALOG_URL,
            "scope": PUBLIC_SCOPE,
            "fetchedAt": 1_790_082_036_135_u64,
            "etag": "W/\"abc\"",
            "payload": {
                "version": 2,
                "counts": { "total": 1 },
                "entries": entries,
            }
        });
        serde_json::to_vec(&snapshot).expect("serialize snapshot")
    }

    fn cache_only_entry() -> serde_json::Value {
        serde_json::json!({
            "server": "cache-only", "service": "cache-only", "label": "Cache Only",
            "url": "https://cache-only.example/mcp", "aliases": [],
            "transport": { "type": "http", "url": "https://cache-only.example/mcp" },
            "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
            "setup": { "status": "ready" },
            "verification": { "status": "unverified" },
            "legacyBuiltin": false, "provenance": [{ "source": "prime" }]
        })
    }

    /// The fetch lane's disk form serves: the `~/.prime/agent/
    /// mcp-service-catalog.v2.json` the fetch writes is this snapshot
    /// envelope, NOT the bare catalog document — a reader that expects
    /// the bare shape finds nothing and every installed service pins as
    /// "catalog source unavailable".
    #[test]
    fn snapshot_envelope_serves() {
        let bytes = snapshot_file(serde_json::json!([cache_only_entry()]));
        let snapshot = snapshot_catalog(&bytes).expect("the fetch lane's snapshot serves");
        assert!(snapshot
            .entries
            .iter()
            .any(|entry| entry.server == "cache-only"));
    }

    /// Last-good: TS `CatalogCache.get` serves a snapshot at ANY age — the
    /// refresh cadence belongs to the fetch lane, and an old snapshot is
    /// yesterday's truth, never invented absence.
    #[test]
    fn snapshot_serves_at_any_age() {
        let ancient = serde_json::json!({
            "url": MCP_SERVICE_CATALOG_URL,
            "scope": PUBLIC_SCOPE,
            "fetchedAt": 1,
            "payload": {
                "version": 2,
                "counts": {},
                "entries": [cache_only_entry()],
            }
        });
        let bytes = serde_json::to_vec(&ancient).expect("serialize snapshot");
        assert!(snapshot_catalog(&bytes).is_some());
    }

    /// A snapshot for another url or scope, a document that is not a
    /// snapshot at all (a bare catalog file dropped at the cache path),
    /// a non-number `fetchedAt`, or a payload that is not a catalog:
    /// never this catalog's truth — the reader falls to the next
    /// candidate and the bundled asset.
    #[test]
    fn foreign_snapshots_never_serve() {
        let entries = serde_json::json!([cache_only_entry()]);
        let other_url = serde_json::json!({
            "url": "https://example.com/other-catalog.json",
            "scope": PUBLIC_SCOPE,
            "fetchedAt": 1,
            "payload": { "version": 2, "counts": {}, "entries": entries }
        });
        assert!(snapshot_catalog(&other_url.to_string().into_bytes()).is_none());
        let other_scope = serde_json::json!({
            "url": MCP_SERVICE_CATALOG_URL,
            "scope": "private",
            "fetchedAt": 1,
            "payload": { "version": 2, "counts": {}, "entries": entries }
        });
        assert!(snapshot_catalog(&other_scope.to_string().into_bytes()).is_none());
        // A bare catalog document is not the fetch lane's snapshot form.
        let bare = serde_json::json!({ "version": 2, "counts": {}, "entries": entries });
        assert!(snapshot_catalog(&bare.to_string().into_bytes()).is_none());
        let stringy_fetched_at = serde_json::json!({
            "url": MCP_SERVICE_CATALOG_URL,
            "scope": PUBLIC_SCOPE,
            "fetchedAt": "1790082036135",
            "payload": { "version": 2, "counts": {}, "entries": entries }
        });
        assert!(
            snapshot_catalog(&stringy_fetched_at.to_string().into_bytes()).is_none()
        );
        let broken_payload = serde_json::json!({
            "url": MCP_SERVICE_CATALOG_URL,
            "scope": PUBLIC_SCOPE,
            "fetchedAt": 1,
            "payload": { "version": 2, "counts": {}, "entries": [{ "server": "nope" }] }
        });
        assert!(
            snapshot_catalog(&broken_payload.to_string().into_bytes()).is_none()
        );
        assert!(snapshot_catalog(b"not json").is_none());
    }

    /// The primary path wins; only when it is unusable do the historical
    /// locations beside the agent files and under `catalog/` serve (an
    /// upgrade never costs a cold fetch).
    #[test]
    fn legacy_locations_read_after_the_primary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        // No cache anywhere: nothing serves from disk, so the resolution
        // sees no remote slice (the compiled built-ins still resolve, and
        // the packaged bundle is a separate fallback).
        assert!(cache_plugins_snapshot(&agent).is_none());

        // A legacy snapshot beside the agent files serves.
        std::fs::write(
            dir.path().join(PLUGINS_CACHE_FILE),
            snapshot_file(serde_json::json!([cache_only_entry()])),
        )
        .expect("write legacy snapshot");
        let snapshot =
            cache_plugins_snapshot(&agent).expect("the legacy location serves");
        assert!(snapshot
            .entries
            .iter()
            .any(|entry| entry.server == "cache-only"));

        // The primary path wins over the legacy ones.
        std::fs::write(
            agent.join(PLUGINS_CACHE_FILE),
            snapshot_file(serde_json::json!([cache_only_entry(), {
                "server": "primary-only", "service": "primary-only",
                "label": "Primary Only", "url": "https://primary-only.example/mcp",
                "aliases": [],
                "transport": { "type": "http", "url": "https://primary-only.example/mcp" },
                "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
                "setup": { "status": "ready" },
                "verification": { "status": "unverified" },
                "legacyBuiltin": false, "provenance": [{ "source": "prime" }]
            }])),
        )
        .expect("write primary snapshot");
        let snapshot =
            cache_plugins_snapshot(&agent).expect("the primary path serves");
        assert!(snapshot
            .entries
            .iter()
            .any(|entry| entry.server == "primary-only"));
    }
}
