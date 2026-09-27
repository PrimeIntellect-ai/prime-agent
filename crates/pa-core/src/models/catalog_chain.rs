//! The process-shared live catalog chain: one [`ModelCatalog`] per models
//! dir, shared by every registry the process constructs (the worker's
//! create path, the model switcher, the RLM surface).
//!
//! TS parity: the TS daemon hosts its sessions in one process and each
//! session's `ModelRegistry` privately owns a catalog layer per session;
//! the Rust daemon runs one worker process per session, so the disk
//! caches are the cross-process state and one chain instance per process
//! serves every registry that process creates. The supervisor keeps the
//! disk caches warm (the forced startup refresh plus the hourly loop).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use pa_models::{ModelCatalog, PrimeCredentials};

use crate::auth::types::PRIME_INFERENCE_PROVIDER_ID;
use crate::auth::AuthStorage;

/// The models cache dir for a `models.json` path: `<agent-dir>/models`
/// (the TS cache dir — both catalog caches live beside `models.json`).
fn models_dir(models_json_path: &Path) -> PathBuf {
    models_json_path
        .parent()
        .unwrap_or(models_json_path)
        .join("models")
}

fn shared() -> &'static Mutex<HashMap<Option<PathBuf>, Arc<ModelCatalog>>> {
    static SHARED: OnceLock<Mutex<HashMap<Option<PathBuf>, Arc<ModelCatalog>>>> = OnceLock::new();
    SHARED.get_or_init(Default::default)
}

/// The process-shared catalog for `models_json_path` (`None` = an
/// in-memory registry, no disk caches): one [`ModelCatalog`] per models
/// dir, so every registry in the process sees the same snapshots and a
/// refresh any of them triggers serves the rest.
///
/// # Panics
///
/// Panics if the shared catalog registry mutex is poisoned.
pub fn catalog_for(models_json_path: Option<&Path>) -> Arc<ModelCatalog> {
    let key = models_json_path.map(models_dir);
    let mut shared = shared().lock().unwrap();
    Arc::clone(
        shared
            .entry(key.clone())
            .or_insert_with(move || Arc::new(ModelCatalog::new(key))),
    )
}

/// Install `catalog` as the process-shared catalog for `models_json_path`
/// (hermetic tests: a catalog whose fetch URLs point at a local server).
///
/// # Panics
///
/// Panics if the shared catalog registry mutex is poisoned.
pub fn install_catalog(models_json_path: &Path, catalog: Arc<ModelCatalog>) {
    shared()
        .lock()
        .unwrap()
        .insert(Some(models_dir(models_json_path)), catalog);
}

/// The Prime Inference credentials from the auth stored under `agent_dir`.
/// The supervisor's hourly loop re-reads auth from disk before each tick,
/// so a login or logout between ticks is picked up by the next refresh
/// (the scope-keyed caches discard the previous account's view on the
/// credential change).
pub fn prime_credentials_for_dir(agent_dir: &Path) -> Option<PrimeCredentials> {
    let mut auth = AuthStorage::create(agent_dir);
    let api_key = auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID)?;
    let team_id = auth
        .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
        .and_then(|headers| headers.get("X-Prime-Team-ID").cloned());
    Some(PrimeCredentials { api_key, team_id })
}

/// The daemon's warm-up: the shared catalog for `agent_dir` with a forced
/// [`RefreshTrigger::Startup`] refresh fired (fire-and-forget: the disk
/// caches fill in the background and every registry resolves the
/// last-good chain immediately). TS parity: the supervisor process keeps
/// the disk caches warm for the workers it spawns.
pub fn startup_refresh(agent_dir: &Path) -> Arc<ModelCatalog> {
    let catalog = catalog_for(Some(&agent_dir.join("models.json")));
    catalog.trigger_refresh_with_credentials(
        pa_models::RefreshTrigger::Startup,
        prime_credentials_for_dir(agent_dir),
    );
    catalog
}

/// The daemon's hourly refresh loop (one per process — the shared
/// catalog's own guard coalesces repeated calls). The credentials closure
/// re-reads auth from disk on every tick, so a CLI login or logout between
/// ticks changes the next refresh's scope and the scope-keyed caches
/// discard the previous account's view.
pub fn spawn_hourly_refresh(agent_dir: &Path) {
    let catalog = catalog_for(Some(&agent_dir.join("models.json")));
    let dir = agent_dir.to_path_buf();
    catalog.spawn_hourly_refresh(move || prime_credentials_for_dir(&dir));
}
