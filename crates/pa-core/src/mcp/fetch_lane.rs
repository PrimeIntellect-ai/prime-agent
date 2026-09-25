//! The plugins service-catalog fetch lane: the background keep-warm for
//! the `/mcp` view's remote catalog. The view's resolution side
//! ([`super::remote_source`]) reads the validated last-good disk cache
//! this lane writes — fetching, cadence, and the cache write live here;
//! the reader stays read-only and fail-closed.
//!
//! The chain reuses the models-catalog machinery (pa-models'
//! [`CatalogCache`]: scope-keyed last-good snapshots, hourly gating,
//! in-flight coalescing, `ETag`, atomic 0600 writes, failure keeps the
//! last-good snapshot, `PI_OFFLINE` skips the network) over the plugins
//! catalog URL, with the plugins parser injected as the parse closure
//! (pa-core depends on pa-models — never the other way).
//!
//! TS parity note (the sanctioned divergence): the TS picker's
//! `SERVICE_CATALOG` is compile-time baked — TS never fetches the catalog
//! at runtime. The Rust port carries the remote chain (URL + `ETag` fetch +
//! validated disk cache) so the catalog stays fresh between releases;
//! the daemon supervisor keeps the cache warm — a forced startup refresh
//! plus the hourly loop, both fire-and-forget; the settle log is one
//! debug line, mirroring the models chain.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use pa_models::cache::{CatalogCache, CatalogParse, RefreshOptions, PUBLIC_SCOPE};
use pa_models::fetch::{CatalogFetcher, MCP_SERVICE_CATALOG_URL};
use pa_models::CATALOG_REFRESH_INTERVAL_MS;

use super::catalog_schema::{parse_plugins_catalog, PluginsCatalog};
use super::remote_source::PLUGINS_CACHE_FILE;

/// The plugins-catalog parse seam for the generic cache: the fetched
/// payload parses through the same fail-closed validator the reader uses
/// (a snapshot that does not parse never lands on disk).
fn plugins_parse(payload: &serde_json::Value, _scope: &str) -> Result<PluginsCatalog, String> {
    let bytes = serde_json::to_vec(payload).map_err(|error| format!("payload encode: {error}"))?;
    parse_plugins_catalog(&bytes)
}

/// One plugins-catalog cache: the generic cache plus the per-instance
/// hourly-loop guard (the models chain guards its loop the same way, so
/// one loop runs per agent dir, not per process).
struct PluginsCatalogCache {
    cache: CatalogCache<PluginsCatalog>,
    hourly_loop: OnceLock<()>,
}

impl PluginsCatalogCache {
    /// A cache writing `cache_path`, fetched from `url`.
    fn at_url(url: &str, cache_path: PathBuf) -> Self {
        Self {
            cache: CatalogCache::new(
                url,
                Some(cache_path),
                Arc::new(CatalogFetcher::new()),
                Arc::new(plugins_parse) as CatalogParse<PluginsCatalog>,
            ),
            hourly_loop: OnceLock::new(),
        }
    }
}

/// The process-shared plugins-catalog caches, keyed by the cache path.
type SharedCaches = HashMap<PathBuf, Arc<PluginsCatalogCache>>;

fn shared() -> &'static Mutex<SharedCaches> {
    static SHARED: OnceLock<Mutex<SharedCaches>> = OnceLock::new();
    SHARED.get_or_init(Default::default)
}

/// The process-shared plugins-catalog cache for `agent_dir`: one cache per
/// agent dir, so the supervisor's startup refresh and its hourly loop
/// share the same snapshots, hourly gating, and in-flight coalescing (the
/// models chain's `catalog_for` shape).
fn plugins_catalog_cache_for(agent_dir: &Path) -> Arc<PluginsCatalogCache> {
    let cache_path = agent_dir.join(PLUGINS_CACHE_FILE);
    let mut shared = shared().lock().unwrap();
    Arc::clone(shared.entry(cache_path.clone()).or_insert_with(move || {
        Arc::new(PluginsCatalogCache::at_url(
            MCP_SERVICE_CATALOG_URL,
            cache_path,
        ))
    }))
}

/// One fire-and-forget refresh of the plugins service catalog: the
/// cache's contract keeps the last-good snapshot on every failure path
/// (including `PI_OFFLINE`, where the cache serves without the network),
/// and the settle log is one debug line, mirroring the models chain.
async fn refresh_plugins_catalog(cache: &PluginsCatalogCache, force: bool) {
    let fresh = cache
        .cache
        .refresh(
            PUBLIC_SCOPE,
            RefreshOptions {
                force,
                headers: Vec::new(),
                is_current: None,
            },
        )
        .await;
    tracing::debug!(
        forced = force,
        entries = fresh.as_ref().map(|catalog| catalog.entries.len()),
        "plugins service catalog refresh settled"
    );
}

/// The daemon's plugins-catalog warm-up: a forced fire-and-forget refresh
/// at startup (the disk cache fills in the background; the reader serves
/// the last-good chain immediately). Mirrors the models chain's
/// `startup_refresh`.
pub fn startup_plugins_refresh(agent_dir: &Path) {
    let cache = plugins_catalog_cache_for(agent_dir);
    tokio::spawn(async move {
        refresh_plugins_catalog(&cache, true).await;
    });
}

/// The daemon's hourly plugins-catalog refresh loop (one loop per agent
/// dir: the guard rides the shared instance, so a second supervisor in
/// the same process still gets its own loop). Mirrors the models chain's
/// `spawn_hourly_refresh`. Errors never surface; the task does not keep
/// the runtime alive.
pub fn spawn_hourly_plugins_refresh(agent_dir: &Path) {
    let cache = plugins_catalog_cache_for(agent_dir);
    if cache.hourly_loop.set(()).is_err() {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(
            CATALOG_REFRESH_INTERVAL_MS,
        ));
        loop {
            interval.tick().await;
            refresh_plugins_catalog(&cache, false).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// The real shipped catalog payload (the fixture the schema's parity
    /// tests parse): what a fetch from the catalog repo returns.
    const REAL_CATALOG: &str = include_str!("../../tests/fixtures/mcp/plugins-catalog.v2.json");

    /// The production cache pins the reader's contract: the catalog-repo
    /// URL the reader's url gate requires, the cache file the reader
    /// reads, and one shared instance per agent dir (the supervisor's
    /// startup and hourly calls drive the same cache).
    #[test]
    fn the_production_cache_pins_the_readers_contract() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        let cache = plugins_catalog_cache_for(&agent_dir);
        assert_eq!(cache.cache.url(), MCP_SERVICE_CATALOG_URL);
        assert_eq!(
            cache.cache.cache_path(),
            Some(agent_dir.join(PLUGINS_CACHE_FILE).as_path()),
        );
        assert!(Arc::ptr_eq(&cache, &plugins_catalog_cache_for(&agent_dir),));
    }

    /// A fetched catalog lands as the reader's disk envelope: the
    /// `SnapshotFile` form (`url` + public scope + `fetchedAt` + the
    /// payload), with the payload intact, at the reader's cache path.
    /// (The reader's url/scope/age gates over that envelope are the
    /// reader's own tests.)
    #[tokio::test]
    async fn a_fetched_catalog_lands_as_the_readers_envelope() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        // A hermetic one-shot fetch server over the real payload.
        let server = one_shot_server(REAL_CATALOG.to_string()).await;
        let cache = PluginsCatalogCache::at_url(server.uri(), agent_dir.join(PLUGINS_CACHE_FILE));
        let fresh = cache
            .cache
            .refresh(
                PUBLIC_SCOPE,
                RefreshOptions {
                    force: true,
                    ..Default::default()
                },
            )
            .await
            .expect("the fixture fetch parses");
        assert_eq!(fresh.version, 2);
        assert_eq!(fresh.entries.len(), 68);

        let written: Value = serde_json::from_slice(
            &std::fs::read(agent_dir.join(PLUGINS_CACHE_FILE)).expect("snapshot written"),
        )
        .expect("the written file is the snapshot envelope");
        assert_eq!(written["url"], server.uri());
        assert_eq!(written["scope"], PUBLIC_SCOPE);
        assert!(written["fetchedAt"].as_u64().is_some());
        assert_eq!(
            written["payload"],
            serde_json::from_str::<Value>(REAL_CATALOG).expect("fixture parses"),
        );
    }

    /// A one-request local HTTP server answering the catalog payload: an
    /// async task (not a blocking accept), so the runtime never hangs on
    /// shutdown, and exactly the one GET a forced refresh performs.
    async fn one_shot_server(body: String) -> TestServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("the one request arrives");
            let mut head = Vec::new();
            let mut buffer = [0u8; 1024];
            loop {
                let read = socket.read(&mut buffer).await.expect("read the head");
                if read == 0 {
                    break;
                }
                head.extend_from_slice(&buffer[..read]);
                if head.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("respond");
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
