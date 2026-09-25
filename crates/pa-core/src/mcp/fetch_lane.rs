//! The plugins service-catalog fetch lane: the background keep-warm for
//! the `/mcp` view's remote catalog. The view's resolution side
//! ([`super::remote_source`]) reads the validated last-good disk cache
//! this lane writes — fetching, cadence, and the cache write live here;
//! the reader stays read-only and fail-closed.
//!
//! The chain reuses the models-catalog machinery (pa-models'
//! [`CatalogCache`]: scope-keyed last-good snapshots, hourly gating,
//! in-flight coalescing, ETag, atomic 0600 writes, failure keeps the
//! last-good snapshot, `PI_OFFLINE` skips the network) over the plugins
//! catalog URL, with the plugins parser injected as the parse closure
//! (pa-core depends on pa-models — never the other way).
//!
//! TS parity note (the sanctioned divergence): the TS picker's
//! `SERVICE_CATALOG` is compile-time baked — TS never fetches the catalog
//! at runtime. The Rust port carries the remote chain (URL + ETag fetch +
//! validated disk cache) so the catalog stays fresh between releases;
//! the daemon supervisor keeps the cache warm — a forced startup refresh
//! plus the hourly loop, both fire-and-forget, one log line per failure.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use pa_models::cache::{CatalogCache, CatalogParse, RefreshOptions, PUBLIC_SCOPE};
use pa_models::fetch::{CatalogFetcher, MCP_SERVICE_CATALOG_URL};
use pa_models::offline::is_catalog_offline;
use pa_models::CATALOG_REFRESH_INTERVAL_MS;

use super::catalog_schema::parse_plugins_catalog;
use super::remote_source::PLUGINS_CACHE_FILE;

/// The parsed plugins catalog (the fetch lane's cached value). Re-exported
/// here so the cache's public signatures name reachable types.
pub use super::catalog_schema::PluginsCatalog;

/// The plugins-catalog parse seam for the generic cache: the fetched
/// payload parses through the same fail-closed validator the reader uses
/// (a snapshot that does not parse never lands on disk).
fn plugins_parse(payload: &serde_json::Value, _scope: &str) -> Result<PluginsCatalog, String> {
    let bytes = serde_json::to_vec(payload).map_err(|error| format!("payload encode: {error}"))?;
    parse_plugins_catalog(&bytes)
}

/// The process-shared plugins-catalog caches, keyed by the cache path.
type SharedCaches = HashMap<Option<PathBuf>, Arc<CatalogCache<PluginsCatalog>>>;

fn shared() -> &'static Mutex<SharedCaches> {
    static SHARED: OnceLock<Mutex<SharedCaches>> = OnceLock::new();
    SHARED.get_or_init(Default::default)
}

/// The process-shared plugins-catalog cache for `agent_dir` (`None` = an
/// in-memory cache with no disk persistence): one cache per agent dir, so
/// the supervisor's fetch lane and any test-installed cache share the
/// same snapshots (the models chain's `catalog_for` shape).
pub fn plugins_catalog_cache_for(agent_dir: Option<&Path>) -> Arc<CatalogCache<PluginsCatalog>> {
    let cache_path = agent_dir.map(|dir| dir.join(PLUGINS_CACHE_FILE));
    let mut shared = shared().lock().unwrap();
    Arc::clone(shared.entry(cache_path.clone()).or_insert_with(move || {
        Arc::new(CatalogCache::new(
            MCP_SERVICE_CATALOG_URL,
            cache_path,
            Arc::new(CatalogFetcher::new()),
            Arc::new(plugins_parse) as CatalogParse<PluginsCatalog>,
        ))
    }))
}

/// Install a caller-built cache for `agent_dir` (hermetic tests: a cache
/// whose URL points at a local server), mirroring the models chain's
/// `install_catalog`.
pub fn install_plugins_catalog_cache(agent_dir: &Path, cache: CatalogCache<PluginsCatalog>) {
    let cache_path = agent_dir.join(PLUGINS_CACHE_FILE);
    shared()
        .lock()
        .unwrap()
        .insert(Some(cache_path), Arc::new(cache));
}

/// One fire-and-forget refresh of the plugins service catalog. The
/// cache's contract keeps the last-good snapshot on every failure path;
/// `None` (nothing served) logs one line — the packaged bundled snapshot
/// keeps serving (the reader's fail-closed chain).
async fn refresh_plugins_catalog(cache: Arc<CatalogCache<PluginsCatalog>>, force: bool) {
    if is_catalog_offline() {
        return;
    }
    let fresh = cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force,
                headers: Vec::new(),
                is_current: None,
            },
        )
        .await;
    if fresh.is_none() {
        eprintln!(
            "pa-daemon: plugins service catalog refresh produced nothing; the bundled snapshot keeps serving ({})",
            cache.url()
        );
    }
}

/// The daemon's plugins-catalog warm-up: a forced fire-and-forget refresh
/// at startup (the disk cache fills in the background; the reader serves
/// the last-good chain immediately). Mirrors the models chain's
/// `startup_refresh`.
pub fn startup_plugins_refresh(agent_dir: &Path) {
    let cache = plugins_catalog_cache_for(Some(agent_dir));
    tokio::spawn(async move {
        refresh_plugins_catalog(cache, true).await;
    });
}

/// The daemon's hourly plugins-catalog refresh loop (one per process: the
/// shared cache's hourly gating coalesces). Mirrors the models chain's
/// `spawn_hourly_refresh`. Errors never surface; the task does not keep
/// the runtime alive.
pub fn spawn_hourly_plugins_refresh(agent_dir: &Path) {
    let cache = plugins_catalog_cache_for(Some(agent_dir));
    static HOURLY_LOOP: OnceLock<()> = OnceLock::new();
    if HOURLY_LOOP.set(()).is_err() {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(
            CATALOG_REFRESH_INTERVAL_MS,
        ));
        loop {
            interval.tick().await;
            refresh_plugins_catalog(Arc::clone(&cache), false).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The parse seam accepts the catalog schema's own fixture (the same
    /// validator the reader runs over the disk envelope's payload).
    #[test]
    fn the_parse_seam_takes_the_plugins_schema() {
        let payload = json!({
            "version": 2,
            "counts": { "entries": 1, "services": 1 },
            "services": [
                {
                    "server": "linear",
                    "label": "Linear",
                    "url": "https://mcp.linear.app/mcp",
                    "usesOAuth": true,
                    "source": "catalog",
                    "review": { "status": "metadata-reviewed" }
                }
            ]
        });
        let catalog = plugins_parse(&payload, PUBLIC_SCOPE).expect("parses");
        assert_eq!(catalog.entries.len(), 1);
        assert!(plugins_parse(&json!({ "version": 3 }), PUBLIC_SCOPE).is_err());
    }

    /// The cache writes the exact envelope the reader validates: url +
    /// public scope + fetchedAt + the catalog payload (the `SnapshotFile`
    /// form `remote_source::snapshot_catalog` accepts at any age).
    #[tokio::test]
    async fn the_cache_writes_the_readers_envelope() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");

        let catalog = json!({
            "version": 2,
            "counts": { "entries": 1, "services": 1 },
            "services": [
                {
                    "server": "linear",
                    "label": "Linear",
                    "url": "https://mcp.linear.app/mcp",
                    "usesOAuth": true,
                    "source": "catalog",
                    "review": { "status": "metadata-reviewed" }
                }
            ]
        });
        // A hermetic local fetch server: one 200 with the catalog payload.
        let server = wiremock_server(catalog).await;
        let cache = CatalogCache::new(
            server.uri(),
            Some(agent_dir.join(PLUGINS_CACHE_FILE)),
            Arc::new(CatalogFetcher::new()),
            Arc::new(plugins_parse) as CatalogParse<PluginsCatalog>,
        );
        install_plugins_catalog_cache(&agent_dir, cache);

        let shared = plugins_catalog_cache_for(Some(&agent_dir));
        let fresh = shared
            .refresh(
                PUBLIC_SCOPE,
                RefreshOptions {
                    force: true,
                    headers: Vec::new(),
                    is_current: None,
                },
            )
            .await;
        assert!(fresh.is_some(), "the fetch landed");
        // The reader accepts the written envelope: url + scope + finite
        // fetchedAt + a payload that parses (any age serves - last good).
        let snapshot = super::super::remote_source::remote_plugins_snapshot(&agent_dir);
        assert!(snapshot.is_some(), "the reader validates the written cache");
    }

    /// A tiny `wiremock`-style local server without the dev dependency: a
    /// bound `TcpListener` answering one GET with the JSON payload.
    async fn wiremock_server(payload: serde_json::Value) -> TestServer {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let body = payload.to_string();
        let handle = tokio::task::spawn_blocking(move || {
            for _ in 0..4 {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(_) => return,
                };
                let mut buffer = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buffer);
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        TestServer {
            uri: format!("http://{addr}/catalog.v2.json"),
            _handle: handle,
        }
    }

    struct TestServer {
        uri: String,
        _handle: tokio::task::JoinHandle<()>,
    }

    impl TestServer {
        fn uri(&self) -> &str {
            &self.uri
        }
    }
}
