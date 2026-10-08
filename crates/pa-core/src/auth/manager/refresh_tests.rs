//! Deterministic probes of the refresh flight at persistence boundaries.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use super::*;

struct ProbedStorage {
    provider: &'static str,
    content: Mutex<Option<String>>,
    probes: Mutex<Vec<(&'static str, bool)>>,
    pending_reload: AtomicBool,
    fail_write: AtomicBool,
}

impl AuthStorageBackend for ProbedStorage {
    fn read(&self) -> anyhow::Result<Option<String>> {
        if self.pending_reload.swap(false, Ordering::SeqCst) {
            self.probes.lock().unwrap().push((
                "reload",
                refresh_flight_lock(self.provider).try_lock().is_err(),
            ));
        }
        Ok(self.content.lock().unwrap().clone())
    }

    fn with_lock(
        &self,
        update: &mut dyn FnMut(Option<String>) -> anyhow::Result<((), Option<String>)>,
    ) -> anyhow::Result<()> {
        self.probes.lock().unwrap().push((
            "write",
            refresh_flight_lock(self.provider).try_lock().is_err(),
        ));
        self.pending_reload.store(true, Ordering::SeqCst);
        if self.fail_write.swap(false, Ordering::SeqCst) {
            anyhow::bail!("synthetic credential commit failure");
        }
        let mut content = self.content.lock().unwrap();
        let ((), next) = update(content.clone())?;
        if let Some(next) = next {
            *content = Some(next);
        }
        Ok(())
    }
}

struct ProbedOAuth {
    storage: Arc<ProbedStorage>,
    calls: AtomicUsize,
    fail_fetch: AtomicBool,
}

impl OAuthIntegration for ProbedOAuth {
    fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::Oauth { access, .. } => Some(access.clone()),
            _ => None,
        }
    }

    fn refresh(&self, provider: &str, _credentials: &AuthStorageData) -> Option<AuthCredential> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(
            self.storage.content.try_lock().is_ok(),
            "fetch holds no document lock"
        );
        assert!(refresh_flight_lock(provider).try_lock().is_err());
        if self.fail_fetch.swap(false, Ordering::SeqCst) {
            return None;
        }
        Some(credential("fresh-access", now_epoch_ms() + 3_600_000))
    }
}

fn credential(access: &str, expires: i64) -> AuthCredential {
    AuthCredential::Oauth {
        access: access.into(),
        refresh: Some("test-refresh".into()),
        expires,
        account_id: None,
        enterprise_url: None,
        endpoint: None,
        token_endpoint: None,
        client_id: None,
        resource: None,
        issuer: None,
        audience_mode: None,
    }
}

fn fixture(provider: &'static str) -> (AuthStorage, Arc<ProbedStorage>, Arc<ProbedOAuth>) {
    let mut data = AuthStorageData::default();
    data.insert(provider, &credential("old-access", 1000));
    let storage = Arc::new(ProbedStorage {
        provider,
        content: Mutex::new(Some(serde_json::to_string(&data.0).unwrap())),
        probes: Mutex::new(Vec::new()),
        pending_reload: AtomicBool::new(false),
        fail_write: AtomicBool::new(false),
    });
    let oauth = Arc::new(ProbedOAuth {
        storage: Arc::clone(&storage),
        calls: AtomicUsize::new(0),
        fail_fetch: AtomicBool::new(false),
    });
    let mut auth = AuthStorage::from_storage(storage.clone(), oauth.clone());
    auth.env_credentials = Arc::new(NoEnvCredentials);
    (auth, storage, oauth)
}

#[test]
fn the_refresh_flight_stays_held_through_commit_and_reload() {
    let provider = "x-flight-commit-probe";
    let (mut first, storage, oauth) = fixture(provider);
    let mut second = AuthStorage::from_storage(storage.clone(), oauth.clone());
    second.env_credentials = Arc::new(NoEnvCredentials);
    assert_eq!(first.get_api_key(provider).as_deref(), Some("fresh-access"));
    assert_eq!(
        *storage.probes.lock().unwrap(),
        vec![("write", true), ("reload", true)]
    );
    assert!(refresh_flight_lock(provider).try_lock().is_ok());
    // This instance still has the old snapshot and must recheck under the gate.
    assert_eq!(
        second.get_api_key(provider).as_deref(),
        Some("fresh-access")
    );
    assert_eq!(oauth.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn a_failed_fetch_releases_the_flight_for_a_later_retry() {
    let provider = "x-flight-fetch-error-probe";
    let (mut auth, storage, oauth) = fixture(provider);
    oauth.fail_fetch.store(true, Ordering::SeqCst);
    assert_eq!(auth.get_api_key(provider), None);
    assert!(refresh_flight_lock(provider).try_lock().is_ok());
    assert!(storage.probes.lock().unwrap().is_empty());
    assert_eq!(auth.get_api_key(provider).as_deref(), Some("fresh-access"));
    assert_eq!(oauth.calls.load(Ordering::SeqCst), 2);
}

#[test]
fn a_failed_commit_reloads_under_the_flight_then_releases_it() {
    let provider = "x-flight-write-error-probe";
    let (mut auth, storage, oauth) = fixture(provider);
    storage.fail_write.store(true, Ordering::SeqCst);
    // Preserve the existing failed-write fallback to the stored credential.
    assert_eq!(auth.get_api_key(provider).as_deref(), Some("old-access"));
    assert_eq!(
        *storage.probes.lock().unwrap(),
        vec![("write", true), ("reload", true)]
    );
    assert!(refresh_flight_lock(provider).try_lock().is_ok());
    assert_eq!(auth.get_api_key(provider).as_deref(), Some("fresh-access"));
    assert_eq!(oauth.calls.load(Ordering::SeqCst), 2);
}
