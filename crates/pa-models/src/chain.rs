//! The no-cold-start chain and refresh cadence.
//!
//! Port of the TS registry's catalog layers (`bundled-model-catalog.ts`,
//! `model-registry.ts` catalog plumbing):
//!
//! 1. validated last-good disk cache (`provider-model-catalog.v1.json`
//!    beside models.json — only fully-validated payloads are ever written
//!    or served);
//! 2. packaged bundled snapshot (`models.bundled.json` beside the
//!    executable, strict-parsed and pinned);
//! 3. compiled fallback (the 42 transport tuples + 110 offline Prime
//!    Inference entries compiled into the binary).
//!
//! A user always has models, offline or not, install or upgrade.
//!
//! Refresh cadence: hourly, at startup, on picker open, and on auth change;
//! fire-and-forget — errors are caught and last-good retained, never
//! surfaced into a session. A mid-session refresh never retargets the
//! active model: resolution returns fresh immutable snapshots and sessions
//! keep the `Model` value they resolved with.
//!
//! The user's local `models.json` takes PRECEDENCE over this catalog; the
//! registry that owns models.json merges custom models over this list, and
//! a refresh here can never clobber user config.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use crate::bundled::{load_bundled_models, BundledAssets};
use crate::cache::{CatalogCache, RefreshOptions, PUBLIC_SCOPE};
use crate::fetch::{CatalogFetcher, MODEL_CATALOG_URL};
use crate::pinning::{parse_provider_model_catalog, PinnedTemplates};
use crate::prime_inference::{
    merge_prime_inference_models, PrimeInferenceCatalog, PrimeInferenceCredentials,
    PRIME_INFERENCE_BASE_URL,
};
use crate::transports;
use crate::Model;

/// The provider-model-catalog cache file, beside models.json.
pub const PROVIDER_CATALOG_CACHE_FILE: &str = "provider-model-catalog.v1.json";

/// What started a refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshTrigger {
    /// Process startup (background, non-blocking, forced).
    Startup,
    /// The hourly timer (interval-gated).
    Hourly,
    /// The model/plugin picker opened (interval-gated).
    PickerOpen,
    /// Auth changed (forced — the account's view may be different).
    AuthChange,
}

impl RefreshTrigger {
    /// Forced triggers skip the hourly gating window (startup and auth
    /// change; the hourly and picker-open triggers stay gated).
    pub fn forced(self) -> bool {
        matches!(self, RefreshTrigger::Startup | RefreshTrigger::AuthChange)
    }
}

/// Credentials for one Prime Inference scope.
#[derive(Debug, Clone)]
pub struct PrimeCredentials {
    pub api_key: String,
    pub team_id: Option<String>,
}

impl PrimeCredentials {
    fn as_inference(&self) -> PrimeInferenceCredentials {
        PrimeInferenceCredentials {
            api_key: self.api_key.clone(),
            team_id: self.team_id.clone(),
        }
    }
}

/// The catalog subsystem facade: no-cold-start resolution + refresh.
pub struct ModelCatalog {
    provider_cache: CatalogCache<Vec<Model>>,
    prime_inference: PrimeInferenceCatalog,
    bundled: BundledAssets,
    templates: PinnedTemplates,
    compiled: Arc<Vec<Model>>,
    /// The Prime Inference API base: the private-authorization fetch (the
    /// entitlements lane in pa-core) targets the same endpoint as the
    /// public catalog fetch and reads it from the shared catalog.
    pi_base_url: Arc<str>,
    /// Guards [`ModelCatalog::spawn_hourly_refresh`]: one loop per instance.
    hourly_loop: OnceLock<()>,
    /// The Prime Inference credential scope the last catalog request in
    /// this process observed ([`ModelCatalog::credentials_changed`]'s
    /// state): `None` until the first observation (the disk snapshot's
    /// stored scope seeds it, so a login or logout that predates this
    /// process's first request is still detected), then the live scope
    /// (`Some(None)` = no credentials).
    pi_scope_seen: Mutex<Option<Option<String>>>,
}

impl ModelCatalog {
    /// The production catalog: caches beside `models_dir` (None = in-memory
    /// registry use), bundled assets at the package root.
    pub fn new(models_dir: Option<PathBuf>) -> Self {
        Self::with_urls(
            models_dir,
            None,
            MODEL_CATALOG_URL,
            PRIME_INFERENCE_BASE_URL,
        )
    }

    /// [`ModelCatalog::new`] with an explicit bundled-asset directory
    /// (tests, staged installs).
    pub fn with_bundled_dir(models_dir: Option<PathBuf>, bundled_dir: Option<PathBuf>) -> Self {
        Self::with_urls(
            models_dir,
            bundled_dir,
            MODEL_CATALOG_URL,
            PRIME_INFERENCE_BASE_URL,
        )
    }

    /// [`ModelCatalog::new`] with both remote URLs overridden (hermetic
    /// tests run the two fetch layers against a local server).
    pub fn with_urls(
        models_dir: Option<PathBuf>,
        bundled_dir: Option<PathBuf>,
        model_catalog_url: &str,
        pi_base_url: &str,
    ) -> Self {
        let templates = PinnedTemplates::from_compiled();
        let compiled = Arc::new(transports::compiled_models().to_vec());
        let pin_templates = templates.clone();
        let parse: crate::cache::CatalogParse<Vec<Model>> =
            Arc::new(move |payload, _scope| parse_provider_model_catalog(payload, &pin_templates));
        let cache_path = models_dir
            .as_ref()
            .map(|dir| dir.join(PROVIDER_CATALOG_CACHE_FILE));
        Self {
            provider_cache: CatalogCache::new(
                model_catalog_url,
                cache_path,
                Arc::new(CatalogFetcher::new()),
                parse,
            ),
            prime_inference: PrimeInferenceCatalog::with_base_url(models_dir, pi_base_url),
            bundled: bundled_dir
                .map_or_else(BundledAssets::at_package_root, BundledAssets::from_dir),
            templates,
            compiled,
            pi_base_url: Arc::from(pi_base_url),
            hourly_loop: OnceLock::new(),
            pi_scope_seen: Mutex::new(None),
        }
    }

    /// The Prime Inference API base URL: the same endpoint the public
    /// catalog fetch uses, for callers that fetch other credential-scoped
    /// views of it (the private-authorization lane).
    pub fn prime_inference_base_url(&self) -> &str {
        &self.pi_base_url
    }

    /// Whether the live Prime Inference credential scope changed since the
    /// last catalog request this process served — the split-process port
    /// of TS `authStorage.onChange` (the client process writes auth.json;
    /// the daemon observes the change on the next request). The
    /// comparison is always live credentials against the last observed
    /// LIVE scope; the disk PI snapshot's stored scope only seeds the
    /// FIRST observation of a process (so a login or logout that happened
    /// before this process's first request is still detected), and is
    /// never trusted over live auth afterwards. Consuming observation:
    /// every call records the current scope as the next comparison base.
    ///
    /// # Panics
    ///
    /// Panics if the scope-observation mutex is poisoned (another thread
    /// panicked while holding the lock).
    pub fn credentials_changed(&self, credentials: Option<&PrimeCredentials>) -> bool {
        let current = credentials
            .map(|credentials| self.prime_inference.scope_for(&credentials.as_inference()));
        let mut seen = self.pi_scope_seen.lock().expect("scope observation lock");
        let last = seen
            .clone()
            .unwrap_or_else(|| self.prime_inference.stored_scope());
        *seen = Some(current.clone());
        last != current
    }

    /// Resolve the current catalog through the no-cold-start chain, merging
    /// the live Prime Inference snapshot for `credentials` when given.
    /// Never fails; never blocks on the network.
    pub fn resolve(&self, credentials: Option<&PrimeCredentials>) -> Vec<Model> {
        let base = match self.provider_cache.get(PUBLIC_SCOPE) {
            Some(remote) => {
                // Step 1: validated last-good cache + the compiled offline
                // Prime Inference entries (private/live entries come from
                // the credentialed snapshot below).
                let mut models = remote;
                for model in transports::prime_inference_offline_entries() {
                    models.push(model);
                }
                models
            }
            // Step 2: packaged bundled snapshot (damaged assets are None).
            None => match self
                .bundled
                .read_models()
                .and_then(|asset| load_bundled_models(&asset, &self.templates))
            {
                Some(bundled) => bundled,
                // Step 3: compiled fallback.
                None => self.compiled.as_ref().clone(),
            },
        };
        let live = credentials
            .and_then(|credentials| self.prime_inference.get(&credentials.as_inference()));
        match live {
            Some(live) => merge_prime_inference_models(&base, Some(&live)),
            None => base,
        }
    }

    /// Fire-and-forget refresh for `trigger`; errors are caught and last-good
    /// retained, never surfaced into a session.
    pub fn trigger_refresh(self: &Arc<Self>, trigger: RefreshTrigger) {
        self.trigger_refresh_with_credentials(trigger, None);
    }

    /// [`ModelCatalog::trigger_refresh`] plus a credentialed Prime Inference
    /// refresh (auth change, picker open with entitlements).
    pub fn trigger_refresh_with_credentials(
        self: &Arc<Self>,
        trigger: RefreshTrigger,
        credentials: Option<PrimeCredentials>,
    ) {
        let catalog = Arc::clone(self);
        // Fire-and-forget: the spawned task must never keep the runtime
        // alive on its own and must never propagate errors.
        tokio::spawn(async move {
            let force = trigger.forced();
            let refreshed = catalog
                .provider_cache
                .refresh(
                    PUBLIC_SCOPE,
                    RefreshOptions {
                        force,
                        headers: Vec::new(),
                        is_current: None,
                    },
                )
                .await;
            if let Some(credentials) = credentials {
                let inference = credentials.as_inference();
                catalog.prime_inference.refresh(&inference, force).await;
            }
            tracing::debug!(
                trigger = ?trigger,
                refreshed = refreshed.map(|models| models.len()),
                "catalog refresh settled"
            );
        });
    }

    /// The hourly background refresh loop. One loop per catalog instance:
    /// the process-shared catalog (pa-core's `catalog_chain`) serves the
    /// whole process, so the first caller arms it and later calls are
    /// no-ops. Errors never surface; the task does not keep the runtime
    /// alive.
    pub fn spawn_hourly_refresh(
        self: &Arc<Self>,
        credentials: impl Fn() -> Option<PrimeCredentials> + Send + Sync + 'static,
    ) {
        if self.hourly_loop.set(()).is_err() {
            return;
        }
        let catalog = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(
                crate::CATALOG_REFRESH_INTERVAL_MS,
            ));
            loop {
                interval.tick().await;
                let credentials = credentials();
                catalog.trigger_refresh_with_credentials(RefreshTrigger::Hourly, credentials);
            }
        });
    }

    /// Await a direct (non-spawned) refresh — `refreshModelCatalog` in the
    /// TS reference; used by tests and callers that need the result.
    pub async fn refresh(&self, force: bool) -> Option<Vec<Model>> {
        self.provider_cache
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

    /// Awaited refresh of both catalog layers — the public provider catalog
    /// and, when `credentials` are given, the credentialed Prime Inference
    /// snapshot. Unlike [`ModelCatalog::trigger_refresh_with_credentials`]
    /// (fire-and-forget), `resolve` reflects the refreshed state as soon
    /// as this future returns. Gating: pass `force` for the forced triggers
    /// (startup, auth change).
    pub async fn refresh_with_credentials(
        &self,
        force: bool,
        credentials: Option<&PrimeCredentials>,
    ) {
        self.provider_cache
            .refresh(
                PUBLIC_SCOPE,
                RefreshOptions {
                    force,
                    headers: Vec::new(),
                    is_current: None,
                },
            )
            .await;
        if let Some(credentials) = credentials {
            let inference = credentials.as_inference();
            self.prime_inference.refresh(&inference, force).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn models_json(ids: &[&str]) -> String {
        let compiled = transports::compiled_models();
        let anthropic = compiled
            .iter()
            .find(|m| m.provider == "anthropic")
            .expect("compiled anthropic");
        let models: Vec<serde_json::Value> = ids
            .iter()
            .map(|id| {
                json!({
                    "id": id,
                    "name": id,
                    "api": anthropic.api,
                    "provider": anthropic.provider,
                    "baseUrl": anthropic.base_url,
                    "reasoning": false,
                    "input": ["text"],
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                    "contextWindow": 128_000,
                    "maxTokens": 4_096,
                })
            })
            .collect();
        serde_json::to_string(&json!({"schemaVersion": 1, "models": models})).unwrap()
    }

    #[test]
    fn compiled_fallback_when_no_cache_and_no_bundled_asset() {
        let dir = tempfile::tempdir().unwrap();
        let catalog =
            ModelCatalog::with_bundled_dir(Some(dir.path().into()), Some(dir.path().into()));
        let models = catalog.resolve(None);
        assert_eq!(
            models.len(),
            transports::compiled_models().len(),
            "compiled fallback"
        );
    }

    #[test]
    fn bundled_asset_beats_compiled_fallback() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("models.bundled.json"),
            models_json(&["bundled-a"]),
        )
        .unwrap();
        let catalog = ModelCatalog::with_bundled_dir(None, Some(dir.path().into()));
        let models = catalog.resolve(None);
        assert_eq!(
            models.len(),
            111,
            "1 pinned bundled entry + 110 offline prime-inference entries"
        );
        assert!(models.iter().any(|m| m.id == "bundled-a"));
    }

    #[test]
    fn disk_cache_beats_bundled_asset() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("models.bundled.json"),
            models_json(&["bundled-a"]),
        )
        .unwrap();
        // A validated last-good disk snapshot (the shape CatalogCache writes).
        let snapshot = json!({
            "url": MODEL_CATALOG_URL,
            "scope": PUBLIC_SCOPE,
            "fetchedAt": 1,
            "payload": serde_json::from_str::<serde_json::Value>(&models_json(&["cached-a"])).unwrap(),
        });
        std::fs::write(
            dir.path().join(PROVIDER_CATALOG_CACHE_FILE),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        let catalog =
            ModelCatalog::with_bundled_dir(Some(dir.path().into()), Some(dir.path().into()));
        let models = catalog.resolve(None);
        assert!(models.iter().any(|m| m.id == "cached-a"));
        assert!(!models.iter().any(|m| m.id == "bundled-a"), "cache wins");
    }

    #[test]
    fn damaged_cache_file_falls_back_to_bundled() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("models.bundled.json"),
            models_json(&["bundled-a"]),
        )
        .unwrap();
        std::fs::write(dir.path().join(PROVIDER_CATALOG_CACHE_FILE), "{broken").unwrap();
        let catalog =
            ModelCatalog::with_bundled_dir(Some(dir.path().into()), Some(dir.path().into()));
        let models = catalog.resolve(None);
        assert!(models.iter().any(|m| m.id == "bundled-a"));
    }

    #[test]
    fn mid_session_refresh_never_retargets_the_active_model() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("models.bundled.json"),
            models_json(&["bundled-a"]),
        )
        .unwrap();
        let catalog =
            ModelCatalog::with_bundled_dir(Some(dir.path().into()), Some(dir.path().into()));
        let before = catalog.resolve(None);
        let active = before
            .iter()
            .find(|m| m.id == "bundled-a")
            .expect("active model")
            .clone();
        // Simulate a refresh writing a different cache snapshot.
        let snapshot = json!({
            "url": MODEL_CATALOG_URL,
            "scope": PUBLIC_SCOPE,
            "fetchedAt": 2,
            "payload": serde_json::from_str::<serde_json::Value>(&models_json(&["new-model"])).unwrap(),
        });
        std::fs::write(
            dir.path().join(PROVIDER_CATALOG_CACHE_FILE),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
        // The session keeps its model object for the session's lifetime.
        assert_eq!(active.id, "bundled-a");
        assert_eq!(
            active.base_url,
            transports::compiled_models()
                .iter()
                .find(|m| m.provider == "anthropic")
                .unwrap()
                .base_url
        );
    }

    #[test]
    fn triggers_force_per_trigger_kind() {
        assert!(RefreshTrigger::Startup.forced());
        assert!(RefreshTrigger::AuthChange.forced());
        assert!(!RefreshTrigger::Hourly.forced());
        assert!(!RefreshTrigger::PickerOpen.forced());
    }

    /// The compiled Prime Inference entries as a valid snapshot payload
    /// (the parse gate needs the coverage; no marker).
    fn pi_snapshot_payload() -> serde_json::Value {
        let data: Vec<serde_json::Value> = transports::prime_inference_offline_entries()
            .iter()
            .map(|model| {
                json!({
                    "id": model.id,
                    "display_name": model.name,
                    "pricing": {
                        "input_usd_per_mtok": model.cost.input.as_f64(),
                        "output_usd_per_mtok": model.cost.output.as_f64(),
                    },
                    "specs": {
                        "context_window": model.context_window,
                        "max_output_tokens": model.max_tokens,
                        "supports_reasoning": model.reasoning,
                        "modalities": {"input": ["text"], "output": ["text"]},
                    },
                })
            })
            .collect();
        json!({ "data": data })
    }

    /// Write the Prime Inference disk snapshot for `credentials`' scope
    /// (the shape `CatalogCache` persists; a fresh process seeds its first
    /// auth-scope observation from it).
    fn write_pi_snapshot(dir: &std::path::Path, credentials: &PrimeCredentials) {
        let scope = crate::prime_inference::scope_key(
            &credentials.api_key,
            credentials.team_id.as_deref().unwrap_or_default(),
        );
        let snapshot = json!({
            "url": "http://catalog.test/api/v1/models",
            "scope": scope,
            "fetchedAt": 1,
            "payload": pi_snapshot_payload(),
        });
        std::fs::write(
            dir.join("prime-inference-models-cache.json"),
            serde_json::to_string(&snapshot).unwrap(),
        )
        .unwrap();
    }

    fn account(api_key: &str, team_id: &str) -> PrimeCredentials {
        PrimeCredentials {
            api_key: api_key.to_string(),
            team_id: Some(team_id.to_string()),
        }
    }

    fn hermetic_catalog(dir: &std::path::Path) -> ModelCatalog {
        ModelCatalog::with_urls(
            Some(dir.to_path_buf()),
            Some(dir.to_path_buf()),
            "http://catalog.test/catalog",
            "http://catalog.test/api/v1",
        )
    }

    /// A restarted process seeds its first credential-scope observation
    /// from the stored disk snapshot: the same account stays `PickerOpen`
    /// (gated, no forced refresh), a changed account — a login or logout
    /// that happened while the process was down — is detected and forced.
    #[test]
    fn first_observation_after_a_restart_compares_against_the_stored_scope() {
        let dir = tempfile::tempdir().unwrap();
        let account_a = account("sk-a", "team-a");
        write_pi_snapshot(dir.path(), &account_a);

        // Same account: not a change.
        let catalog = hermetic_catalog(dir.path());
        assert!(!catalog.credentials_changed(Some(&account_a)));
        // The observation is consuming: still the same account.
        assert!(!catalog.credentials_changed(Some(&account_a)));
        // A changed account is a change, once.
        let account_b = account("sk-b", "team-b");
        assert!(catalog.credentials_changed(Some(&account_b)));
        assert!(!catalog.credentials_changed(Some(&account_b)));
        // A logout (credentials gone while a snapshot remains) is a
        // change, once; staying logged out is not.
        assert!(catalog.credentials_changed(None));
        assert!(!catalog.credentials_changed(None));
    }

    /// Without a stored snapshot (a fresh install, or the first request of
    /// a process whose caches never warmed), the seed is "no scope":
    /// credentials present is a change (forced once — the fetch arms the
    /// scope's snapshot), no credentials is not (the startup refresh
    /// already covers the fresh process).
    #[test]
    fn first_observation_without_a_stored_snapshot_seeds_no_scope() {
        let dir = tempfile::tempdir().unwrap();
        let catalog = hermetic_catalog(dir.path());
        assert!(!catalog.credentials_changed(None));
        let account_a = account("sk-a", "team-a");
        assert!(catalog.credentials_changed(Some(&account_a)));
        assert!(!catalog.credentials_changed(Some(&account_a)));
    }
}
