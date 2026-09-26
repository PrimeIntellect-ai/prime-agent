//! Scope-keyed last-good catalog cache with hourly, coalesced refresh.
//!
//! Port of `CatalogCache<T>` in `model-catalog-cache.ts`:
//! - one last-good snapshot per source URL; a scope change discards the
//!   previous view entirely (an account's models never leak across scopes);
//! - `get` serves the validated in-memory snapshot, or loads + re-validates
//!   the disk snapshot (`{url, scope, fetchedAt, etag?, payload}` written
//!   atomically at mode 0600);
//! - `refresh` is fire-and-forget safe: in-flight refreshes coalesce per
//!   source, hourly gating skips fetches attempted less than an hour ago,
//!   every failure keeps the last-good snapshot, and 401/403 clears only
//!   the requesting (non-public) scope;
//! - `PI_OFFLINE` skips the network entirely.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::fetch::{CatalogFetcher, FetchOutcome};
use crate::offline::is_catalog_offline;
use crate::CATALOG_REFRESH_INTERVAL_MS;

/// The unauthenticated scope shared by both remote catalog URLs.
pub const PUBLIC_SCOPE: &str = "public";

/// Parser turning a fetched payload into the cache's value type.
pub type CatalogParse<T> = Arc<dyn Fn(&serde_json::Value, &str) -> Result<T, String> + Send + Sync>;

/// One validated last-good snapshot (`Snapshot<T>` in the TS reference).
#[derive(Clone)]
struct Snapshot<T> {
    scope: String,
    fetched_at: u64,
    etag: Option<String>,
    payload: serde_json::Value,
    models: T,
}

/// The disk form of a snapshot (`{url, scope, fetchedAt, etag?, payload}`).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFile {
    url: String,
    scope: String,
    fetched_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    payload: serde_json::Value,
}

struct InFlight<T> {
    result: OnceLock<Option<T>>,
    notify: tokio::sync::Notify,
}

impl<T> InFlight<T> {
    fn new() -> Self {
        Self {
            result: OnceLock::new(),
            notify: tokio::sync::Notify::new(),
        }
    }
}

struct CacheState<T> {
    scope: Option<String>,
    snapshot: Option<Snapshot<T>>,
    pending: Option<Arc<InFlight<T>>>,
    last_attempt: Option<u64>,
    generation: u64,
}

/// Options for [`CatalogCache::refresh`].
#[derive(Default)]
pub struct RefreshOptions {
    /// Skip the hourly gating window (startup, picker open, auth change).
    pub force: bool,
    /// Extra request headers (credentials for the Prime Inference catalog).
    pub headers: Vec<(String, String)>,
    /// Additional staleness guard consulted before applying any result.
    pub is_current: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

/// The last-good cache for one catalog source.
pub struct CatalogCache<T> {
    url: Arc<str>,
    cache_path: Option<PathBuf>,
    fetcher: Arc<CatalogFetcher>,
    parse: CatalogParse<T>,
    state: Mutex<CacheState<T>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

impl<T: Clone + Send + Sync + 'static> CatalogCache<T> {
    /// A cache for `url`, persisted beside `cache_path` when given.
    pub fn new(
        url: &str,
        cache_path: Option<PathBuf>,
        fetcher: Arc<CatalogFetcher>,
        parse: CatalogParse<T>,
    ) -> Self {
        Self {
            url: Arc::from(url),
            cache_path,
            fetcher,
            parse,
            state: Mutex::new(CacheState {
                scope: None,
                snapshot: None,
                pending: None,
                last_attempt: None,
                generation: 0,
            }),
        }
    }

    /// The source URL this cache fetches.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The disk cache path, when persistence is enabled.
    pub fn cache_path(&self) -> Option<&Path> {
        self.cache_path.as_deref()
    }

    /// Serve the last-good snapshot for `scope`, loading and re-validating the
    /// disk snapshot on first access. A scope change discards the previous
    /// account's view entirely.
    ///
    /// # Panics
    ///
    /// Panics if the cache mutex is poisoned (another thread panicked while
    /// holding the lock).
    pub fn get(&self, scope: &str) -> Option<T> {
        let mut state = self.state.lock().unwrap();
        if state.scope.as_deref() == Some(scope) {
            return state
                .snapshot
                .as_ref()
                .map(|snapshot| snapshot.models.clone());
        }
        state.scope = Some(scope.to_string());
        state.generation += 1;
        state.pending = None;
        state.snapshot = None;
        state.last_attempt = None;
        let path = self.cache_path.clone()?;
        match self.read_snapshot(&path, scope) {
            Ok(snapshot) => {
                let models = snapshot.models.clone();
                state.snapshot = Some(snapshot);
                Some(models)
            }
            // Invalid or missing disk state falls back to the bundled catalog.
            Err(_) => None,
        }
    }

    /// Drop the snapshot for `scope` (401/403 revocation); other scopes keep
    /// their own snapshots.
    ///
    /// # Panics
    ///
    /// Panics if the cache mutex is poisoned (another thread panicked while
    /// holding the lock).
    pub fn clear(&self, scope: &str) {
        let mut state = self.state.lock().unwrap();
        if state.scope.as_deref() != Some(scope) {
            return;
        }
        state.snapshot = None;
        if let Some(path) = &self.cache_path {
            if let Err(error) = std::fs::remove_file(path) {
                // Read-only cache directories do not prevent model discovery.
                tracing::debug!(path = %path.display(), %error, "catalog cache clear failed");
            }
        }
    }

    /// Refresh the snapshot for `scope`: coalesces with an in-flight refresh,
    /// skips fetches attempted less than an hour ago unless forced, and
    /// returns the last-good value on every failure path.
    ///
    /// # Panics
    ///
    /// Panics if the cache mutex is poisoned (another thread panicked while
    /// holding the lock). In debug builds, also panics if a refresh
    /// settles its shared result twice, which the current code never does.
    pub async fn refresh(&self, scope: &str, opts: RefreshOptions) -> Option<T> {
        enum Gate<T> {
            Coalesced(Arc<InFlight<T>>),
            Gated,
            Start(Arc<InFlight<T>>, Option<Snapshot<T>>, u64),
        }
        let cached = self.get(scope);
        if is_catalog_offline() {
            return cached;
        }
        // The mutex guard must never live across an await: decide under the
        // lock, then act outside it.
        let gate = {
            let mut state = self.state.lock().unwrap();
            let coalesced = state
                .pending
                .clone()
                .filter(|_| state.scope.as_deref() == Some(scope));
            if let Some(pending) = coalesced {
                Gate::Coalesced(pending)
            } else {
                let checked_at = state
                    .last_attempt
                    .or_else(|| state.snapshot.as_ref().map(|snapshot| snapshot.fetched_at));
                if !opts.force
                    && checked_at.is_some_and(|at| {
                        now_ms() >= at && now_ms() - at < CATALOG_REFRESH_INTERVAL_MS
                    })
                {
                    Gate::Gated
                } else {
                    state.last_attempt = Some(now_ms());
                    let inflight = Arc::new(InFlight::new());
                    state.pending = Some(Arc::clone(&inflight));
                    Gate::Start(inflight, state.snapshot.clone(), state.generation)
                }
            }
        };
        let (inflight, previous, generation) = match gate {
            Gate::Coalesced(pending) => return await_inflight(pending).await,
            Gate::Gated => return cached,
            Gate::Start(inflight, previous, generation) => (inflight, previous, generation),
        };
        // The driver owns the gate's settlement: a caller that drops
        // `refresh` mid-fetch (a bounded wait timing out) must not leave
        // the shared `pending` gate set with no settle left to run —
        // coalesced callers would await a notify that never comes. The
        // guard resolves the gate as a failed refresh and wakes every
        // waiter, keeping the fire-and-forget-safe contract.
        let _driver = SettleOnDrop {
            cache: self,
            inflight: Arc::clone(&inflight),
        };
        let result = self.drive_refresh(scope, &opts, previous, generation).await;
        {
            let mut state = self.state.lock().unwrap();
            if state
                .pending
                .as_ref()
                .is_some_and(|pending| Arc::ptr_eq(pending, &inflight))
            {
                state.pending = None;
            }
        }
        if inflight.result.set(result.clone()).is_err() {
            // Only reachable if a future revision settles twice; the first
            // result stays authoritative for all coalesced callers.
            debug_assert!(false, "catalog refresh settled twice");
        }
        inflight.notify.notify_waiters();
        result
    }

    fn is_current(&self, scope: &str, generation: u64, opts: &RefreshOptions) -> bool {
        let state = self.state.lock().unwrap();
        state.scope.as_deref() == Some(scope)
            && state.generation == generation
            && opts.is_current.as_ref().is_none_or(|check| check())
    }

    async fn drive_refresh(
        &self,
        scope: &str,
        opts: &RefreshOptions,
        previous: Option<Snapshot<T>>,
        generation: u64,
    ) -> Option<T> {
        let etag = previous.as_ref().and_then(|snapshot| snapshot.etag.clone());
        let fetch = self
            .fetcher
            .fetch_with(&self.url, etag.as_deref(), &opts.headers);
        match fetch.await {
            Ok(FetchOutcome::NotModified) => {
                if !self.is_current(scope, generation, opts) {
                    return None;
                }
                let mut snapshot = previous?;
                snapshot.fetched_at = now_ms();
                let models = snapshot.models.clone();
                self.store_snapshot(scope, &snapshot);
                Some(models)
            }
            Ok(FetchOutcome::Fresh { body, etag }) => {
                let payload: serde_json::Value = match serde_json::from_slice(&body) {
                    Ok(payload) => payload,
                    Err(_) => return self.keep_last_good(scope, generation, opts),
                };
                let Ok(models) = (self.parse)(&payload, scope) else {
                    return self.keep_last_good(scope, generation, opts);
                };
                if !self.is_current(scope, generation, opts) {
                    return None;
                }
                let snapshot = Snapshot {
                    scope: scope.to_string(),
                    fetched_at: now_ms(),
                    etag,
                    payload,
                    models,
                };
                let served = snapshot.models.clone();
                self.store_snapshot(scope, &snapshot);
                Some(served)
            }
            Err(error) => {
                if self.is_current(scope, generation, opts)
                    && scope != PUBLIC_SCOPE
                    && matches!(error.status(), Some(401 | 403))
                {
                    self.clear(scope);
                    return None;
                }
                self.keep_last_good(scope, generation, opts)
            }
        }
    }

    /// Every parse/fetch failure keeps the prior snapshot and returns it.
    fn keep_last_good(&self, scope: &str, generation: u64, opts: &RefreshOptions) -> Option<T> {
        if !self.is_current(scope, generation, opts) {
            return None;
        }
        let state = self.state.lock().unwrap();
        state
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.models.clone())
    }

    /// Publish a validated snapshot in memory and on disk (mode 0600).
    fn store_snapshot(&self, scope: &str, snapshot: &Snapshot<T>) {
        {
            let mut state = self.state.lock().unwrap();
            if state.scope.as_deref() != Some(scope) {
                return;
            }
            state.snapshot = Some(Snapshot {
                scope: snapshot.scope.clone(),
                fetched_at: snapshot.fetched_at,
                etag: snapshot.etag.clone(),
                payload: snapshot.payload.clone(),
                models: snapshot.models.clone(),
            });
        }
        if let Some(path) = &self.cache_path {
            let stored = SnapshotFile {
                url: self.url.to_string(),
                scope: snapshot.scope.clone(),
                fetched_at: snapshot.fetched_at,
                etag: snapshot.etag.clone(),
                payload: snapshot.payload.clone(),
            };
            let Ok(bytes) = serde_json::to_vec(&stored) else {
                return;
            };
            if let Err(error) = write_atomic(path, &bytes) {
                // Keep the validated in-memory snapshot if persistence fails.
                tracing::debug!(path = %path.display(), %error, "catalog cache write failed");
            }
        }
    }

    /// Load + validate a disk snapshot through the parse function; only fully
    /// validated payloads are ever served.
    fn read_snapshot(&self, path: &Path, scope: &str) -> Result<Snapshot<T>, String> {
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        let stored: SnapshotFile =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if stored.url.as_str() != self.url.as_ref() || stored.scope != scope {
            return Err("catalog cache belongs to another source or scope".into());
        }
        let models = (self.parse)(&stored.payload, scope)?;
        Ok(Snapshot {
            scope: stored.scope,
            fetched_at: stored.fetched_at,
            etag: stored.etag,
            payload: stored.payload,
            models,
        })
    }
}

/// The driving refresh's settle guard: when the driver future is dropped
/// before settling, the shared gate is resolved as a failed refresh
/// (`None`) and every waiter is woken, so dropped refreshes can never
/// poison the coalescing gate for later callers.
struct SettleOnDrop<'a, T: Clone + Send + Sync + 'static> {
    cache: &'a CatalogCache<T>,
    inflight: Arc<InFlight<T>>,
}

impl<T: Clone + Send + Sync + 'static> Drop for SettleOnDrop<'_, T> {
    fn drop(&mut self) {
        // The happy path settles before dropping (no await between the
        // settle and the scope exit), so an unset result means the driver
        // was cancelled mid-fetch.
        if self.inflight.result.get().is_some() {
            return;
        }
        {
            let mut state = self.cache.state.lock().unwrap();
            if state
                .pending
                .as_ref()
                .is_some_and(|pending| Arc::ptr_eq(pending, &self.inflight))
            {
                state.pending = None;
            }
        }
        let _ = self.inflight.result.set(None);
        self.inflight.notify.notify_waiters();
    }
}

/// Await an in-flight refresh's shared result.
async fn await_inflight<T: Clone>(inflight: Arc<InFlight<T>>) -> Option<T> {
    loop {
        let notified = inflight.notify.notified();
        if let Some(result) = inflight.result.get() {
            return result.clone();
        }
        notified.await;
        if let Some(result) = inflight.result.get() {
            return result.clone();
        }
    }
}

/// Atomic snapshot write: temp file + rename at mode 0600. The temp file
/// is unique per writer (`pid` + an in-process counter): the Rust daemon
/// runs one supervisor and many worker processes against one agent dir,
/// and a shared temp path would let concurrent fire-and-forget refreshes
/// truncate each other's temp file and publish a malformed snapshot. With
/// unique temps every rename publishes one writer's complete bytes (the
/// TS single-process reference never races here; the multi-process port
/// must).
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    #[cfg(unix)]
    let write = || {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temp)
    };
    #[cfg(not(unix))]
    let write = || {
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp)
    };
    let mut file = write()?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()?;
    std::fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The multi-process snapshot-write invariant (Macroscope on #2576):
    /// concurrent `write_atomic` writers publish one writer's complete
    /// bytes each (unique temp + atomic rename), so a reader racing the
    /// writers always parses a full document. The pre-fix shared temp path
    /// let one writer truncate another's temp file after the rename had
    /// already published it, tearing the published snapshot in place.
    #[test]
    fn concurrent_writers_never_publish_a_malformed_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("snapshot.json");
        write_atomic(&path, br#"{"writer":0}"#).unwrap();
        std::thread::scope(|scope| {
            for writer in 0..4u8 {
                let path = &path;
                scope.spawn(move || {
                    for round in 0..200usize {
                        let payload = format!(
                            r#"{{"writer":{writer},"round":{round},"padding":"{}"}}"#,
                            "x".repeat(round % 7 * 512)
                        );
                        write_atomic(path, payload.as_bytes()).unwrap();
                    }
                });
            }
            scope.spawn(|| {
                for _ in 0..500usize {
                    let bytes = std::fs::read(&path).unwrap();
                    let parsed: serde_json::Value = serde_json::from_slice(&bytes)
                        .expect("the published snapshot always parses");
                    assert!(parsed.get("writer").is_some());
                    std::hint::spin_loop();
                }
            });
        });
        // Every rename consumed its temp: no writer litter remains.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .filter(|name| name.to_string_lossy().contains(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
    }
}
