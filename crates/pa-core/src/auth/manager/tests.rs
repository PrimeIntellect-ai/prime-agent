//! The `AuthStorage` unit battery: the candidate memo + staleness
//! machinery, the resolution precedence, the OAuth refresh contract, and
//! the Prime Inference credential + team writes (hermetic `ScriptedEnv`).

use super::*;

/// Fixed environment credential source: hermetic against the ambient
/// process env (e.g. this sandbox exports `PRIME_API_KEY` globally).
struct ScriptedEnv(HashMap<String, String>);

impl EnvCredentialSource for ScriptedEnv {
    fn key_names(&self, provider: &str) -> Option<Vec<String>> {
        let names = pa_ai::env_api_keys::get_api_key_env_vars(provider)?
            .into_iter()
            .filter(|name| self.0.get(*name).is_some_and(|value| !value.is_empty()))
            .map(str::to_string)
            .collect::<Vec<_>>();
        (!names.is_empty()).then_some(names)
    }

    fn api_key(&self, provider: &str) -> Option<String> {
        let first = self.key_names(provider)?.first()?.clone();
        self.0.get(&first).cloned().filter(|v| !v.is_empty())
    }

    fn prime_team_id(&self) -> Option<String> {
        self.0.get("PRIME_TEAM_ID").cloned()
    }

    fn ambient_identity_material(&self, provider: &str) -> String {
        format!("{provider}:scripted-ambient")
    }
}

fn storage_with(data: &serde_json::Value) -> AuthStorage {
    storage_with_env(data, ScriptedEnv(HashMap::new()))
}

fn storage_with_env(data: &serde_json::Value, env: ScriptedEnv) -> AuthStorage {
    let data = AuthStorageData(data.as_object().cloned().unwrap_or_default());
    AuthStorage::in_memory_with_env(&data, Arc::new(NoOAuth), Arc::new(env))
}

#[test]
fn runtime_override_wins() {
    // Non-prime provider: runtime beats stored; stored outranks env,
    // so ambient env cannot interfere.
    let mut auth = storage_with(&serde_json::json!({
        "anthropic": { "type": "api_key", "key": "stored-key" }
    }));
    assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("stored-key"));
    auth.set_runtime_api_key("anthropic", "runtime-key".to_string());
    assert_eq!(
        auth.get_api_key("anthropic").as_deref(),
        Some("runtime-key")
    );
    auth.remove_runtime_api_key("anthropic");
    assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("stored-key"));
}

#[test]
fn stale_marking_skips_source_and_clears() {
    let mut auth = storage_with(&serde_json::json!({
        "prime-inference": { "type": "api_key", "key": "sk-stale" }
    }));
    assert!(auth.mark_auth_stale("prime-inference"));
    assert_eq!(auth.get_api_key("prime-inference"), None);
    let status = auth.get_auth_status("prime-inference");
    assert_eq!(status.source, Some(AuthSource::Stale));
    auth.clear_auth_stale("prime-inference");
    assert_eq!(
        auth.get_api_key("prime-inference").as_deref(),
        Some("sk-stale")
    );
}

#[test]
fn candidate_memos_supersede_exactly_when_material_changes() {
    // The memo is keyed by the hashed material: a changed env value re-resolves to
    // the new fingerprint, so a stale marking of the old value never gates the new one.
    let mut auth = storage_with_env(
        &serde_json::json!({}),
        ScriptedEnv(HashMap::from([(
            "ANTHROPIC_API_KEY".to_string(),
            "sk-one".to_string(),
        )])),
    );
    assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("sk-one"));
    assert!(auth.mark_auth_stale("anthropic"));
    assert_eq!(
        auth.get_api_key("anthropic"),
        None,
        "the marked value is gated"
    );
    // A changed value changes the memo key, so the new value resolves.
    auth.env_credentials = Arc::new(ScriptedEnv(HashMap::from([(
        "ANTHROPIC_API_KEY".to_string(),
        "sk-two".to_string(),
    )])));
    assert_eq!(
        auth.get_api_key("anthropic").as_deref(),
        Some("sk-two"),
        "the memo must not serve the superseded candidate"
    );
    // The marked material's candidate re-serves when its value returns.
    auth.env_credentials = Arc::new(ScriptedEnv(HashMap::from([(
        "ANTHROPIC_API_KEY".to_string(),
        "sk-one".to_string(),
    )])));
    assert_eq!(auth.get_api_key("anthropic"), None);
    auth.clear_auth_stale("anthropic");
    assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("sk-one"));
    // The stored arm: a replaced credential changes the hashed material,
    // so the old stale marking never gates it.
    let mut auth = storage_with(&serde_json::json!({
        "anthropic": { "type": "api_key", "key": "sk-old" }
    }));
    assert!(auth.mark_auth_stale("anthropic"));
    auth.set(
        "anthropic",
        AuthCredential::ApiKey {
            key: "sk-new".into(),
            prime_team: None,
        },
    );
    assert!(
        auth.has_auth("anthropic"),
        "the replaced credential is not the stale-marked material"
    );
}

#[test]
fn set_and_remove_credentials() {
    let mut auth = storage_with(&serde_json::json!({}));
    auth.set(
        "anthropic",
        AuthCredential::ApiKey {
            key: "sk-ant".into(),
            prime_team: None,
        },
    );
    assert!(auth.has("anthropic"));
    assert!(auth.has_auth("anthropic"));
    assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("sk-ant"));
    // The generic `set` keeps the TS omit shape: a non-prime key
    // carries no `primeTeam` property.
    assert!(!auth
        .get_all()
        .get("anthropic")
        .unwrap()
        .as_object()
        .unwrap()
        .contains_key("primeTeam"));
    auth.logout("anthropic");
    assert!(!auth.has("anthropic"));
    assert_eq!(auth.get_api_key("anthropic"), None);
}

#[test]
fn command_keys_resolve() {
    let mut auth = storage_with(&serde_json::json!({
        "anthropic": { "type": "api_key", "key": "!echo cmd-key" }
    }));
    assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("cmd-key"));
}

#[test]
fn env_key_priority_for_prime_inference() {
    let mut auth = storage_with_env(
        &serde_json::json!({
            "prime-inference": { "type": "api_key", "key": "stored-key" }
        }),
        ScriptedEnv(HashMap::from([(
            "PRIME_API_KEY".to_string(),
            "env-key".to_string(),
        )])),
    );
    assert_eq!(
        auth.get_api_key("prime-inference").as_deref(),
        Some("env-key")
    );
}

#[test]
fn fallback_resolver_last_resort() {
    let mut auth = storage_with(&serde_json::json!({}));
    auth.set_fallback_resolver(Arc::new(|provider| {
        (provider == "custom").then(|| "fb-key".to_string())
    }));
    assert_eq!(auth.get_api_key("custom").as_deref(), Some("fb-key"));
}

#[test]
fn provider_headers_team_selection() {
    let auth = storage_with(&serde_json::json!({
        "prime-inference": {
            "type": "api_key",
            "key": "pi-key",
            "primeTeam": { "teamId": "team-1", "name": "Team 1" }
        }
    }));
    let headers = auth
        .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
        .unwrap();
    assert_eq!(
        headers.get("X-Prime-Team-ID").map(String::as_str),
        Some("team-1")
    );
    assert!(auth.get_provider_headers("anthropic").is_none());
    // The stored team survives an ambient environment key: PRIME_API_KEY
    // supplies the key, the stored login's team still scopes the header.
    let mut auth = storage_with_env(
        &serde_json::json!({
            "prime-inference": {
                "type": "api_key",
                "key": "pi-key",
                "primeTeam": { "teamId": "team-1", "name": "Team 1" }
            }
        }),
        ScriptedEnv(HashMap::from([(
            "PRIME_API_KEY".to_string(),
            "env-key".to_string(),
        )])),
    );
    assert_eq!(
        auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID).as_deref(),
        Some("env-key")
    );
    let headers = auth
        .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
        .unwrap();
    assert_eq!(
        headers.get("X-Prime-Team-ID").map(String::as_str),
        Some("team-1")
    );
    // The stored team survives a runtime API-key override too.
    let mut auth = storage_with(&serde_json::json!({
        "prime-inference": {
            "type": "api_key",
            "key": "pi-key",
            "primeTeam": { "teamId": "team-1", "name": "Team 1" }
        }
    }));
    auth.set_runtime_api_key(PRIME_INFERENCE_PROVIDER_ID, "runtime-key".to_string());
    assert_eq!(
        auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID).as_deref(),
        Some("runtime-key")
    );
    let headers = auth
        .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
        .unwrap();
    assert_eq!(
        headers.get("X-Prime-Team-ID").map(String::as_str),
        Some("team-1")
    );
    // PRIME_TEAM_ID env wins over the stored selection.
    let auth = storage_with_env(
        &serde_json::json!({
            "prime-inference": {
                "type": "api_key",
                "key": "pi-key",
                "primeTeam": { "teamId": "team-1", "name": "Team 1" }
            }
        }),
        ScriptedEnv(HashMap::from([(
            "PRIME_TEAM_ID".to_string(),
            "env-team".to_string(),
        )])),
    );
    let headers = auth
        .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
        .unwrap();
    assert_eq!(
        headers.get("X-Prime-Team-ID").map(String::as_str),
        Some("env-team")
    );
}

fn team(id: &str, name: &str) -> PrimeTeamCredential {
    PrimeTeamCredential {
        team_id: id.to_string(),
        name: name.to_string(),
        slug: None,
        role: None,
        created_at: None,
    }
}

#[test]
fn prime_inference_key_writes_follow_the_ts_assignment_rules() {
    let mut auth = storage_with(&serde_json::json!({}));
    auth.set_prime_inference_api_key("sk-1", PrimeTeamAssignment::Team(team("1", "Team 1")));
    assert_eq!(
        auth.get_all().credential(PRIME_INFERENCE_PROVIDER_ID),
        Some(AuthCredential::ApiKey {
            key: "sk-1".to_string(),
            prime_team: Some(team("1", "Team 1")),
        })
    );
    // TS `undefined`: the same key preserves the stored team.
    auth.set_prime_inference_api_key("sk-1", PrimeTeamAssignment::PreserveWhenKeyMatches);
    assert_eq!(
        auth.get_all().credential(PRIME_INFERENCE_PROVIDER_ID),
        Some(AuthCredential::ApiKey {
            key: "sk-1".to_string(),
            prime_team: Some(team("1", "Team 1")),
        })
    );
    // TS `undefined`: a different key drops the stored team.
    auth.set_prime_inference_api_key("sk-2", PrimeTeamAssignment::PreserveWhenKeyMatches);
    assert_eq!(
        auth.get_all().credential(PRIME_INFERENCE_PROVIDER_ID),
        Some(AuthCredential::ApiKey {
            key: "sk-2".to_string(),
            prime_team: None,
        })
    );
    // TS `null`: the personal account, explicitly.
    auth.set_prime_inference_api_key("sk-2", PrimeTeamAssignment::Team(team("2", "Team 2")));
    auth.set_prime_inference_api_key("sk-2", PrimeTeamAssignment::PersonalAccount);
    assert_eq!(
        auth.get_all().credential(PRIME_INFERENCE_PROVIDER_ID),
        Some(AuthCredential::ApiKey {
            key: "sk-2".to_string(),
            prime_team: None,
        })
    );
    // The write clears a stale marking on the stored source.
    assert!(auth.mark_auth_stale(PRIME_INFERENCE_PROVIDER_ID));
    auth.set_prime_inference_api_key("sk-3", PrimeTeamAssignment::PersonalAccount);
    assert_eq!(
        auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID).as_deref(),
        Some("sk-3")
    );
    // The TS wire shape: the personal account persists `primeTeam:
    // null`, never an omitted field.
    let stored = auth.get_all();
    let credential = stored
        .get(PRIME_INFERENCE_PROVIDER_ID)
        .unwrap()
        .as_object()
        .unwrap();
    assert_eq!(credential.get("primeTeam"), Some(&serde_json::Value::Null));
}

#[test]
fn prime_inference_team_selection_rebinds_only_the_stored_key() {
    let mut auth = storage_with(&serde_json::json!({}));
    auth.set_prime_inference_team_selection(Some(team("1", "Team 1")), None);
    assert_eq!(auth.get_all().get(PRIME_INFERENCE_PROVIDER_ID), None);
    auth.set_prime_inference_api_key("sk-1", PrimeTeamAssignment::PersonalAccount);
    auth.set_prime_inference_team_selection(Some(team("1", "Team 1")), Some("sk-1"));
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::Team(team("1", "Team 1"))
    );
    auth.set_prime_inference_team_selection(Some(team("2", "Team 2")), Some("wrong-key"));
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::Team(team("1", "Team 1"))
    );
    auth.set_prime_inference_team_selection(Some(team("2", "Team 2")), None);
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::Team(team("2", "Team 2"))
    );
    auth.set_prime_inference_team_selection(None, None);
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::PersonalAccount
    );
    let mut auth = storage_with(&serde_json::json!({
        "prime-inference": {
            "type": "oauth", "access": "a", "refresh": null, "expires": 1
        }
    }));
    auth.set_prime_inference_team_selection(Some(team("1", "Team 1")), None);
    assert_eq!(
        auth.get_all().get(PRIME_INFERENCE_PROVIDER_ID).unwrap()["access"],
        "a"
    );
}

/// A backend that serves reads but fails every write.
struct WriteFailingBackend(std::sync::Mutex<Option<String>>);

impl AuthStorageBackend for WriteFailingBackend {
    fn with_lock(
        &self,
        update: &mut dyn FnMut(Option<String>) -> anyhow::Result<((), Option<String>)>,
    ) -> anyhow::Result<()> {
        let current = self.0.lock().unwrap().clone();
        let ((), next) = update(current)?;
        match next {
            Some(_) => Err(anyhow::anyhow!("the locked write failed")),
            None => Ok(()),
        }
    }
}

#[test]
fn a_failed_prime_inference_key_write_keeps_the_stale_marking() {
    // TS: `setPrimeInferenceApiKey` throws before `clearStaleAuthSource`,
    // so a failed replacement never re-enables the server-rejected credential.
    let mut auth = AuthStorage::from_storage(
        Arc::new(WriteFailingBackend(std::sync::Mutex::new(Some(
            r#"{"prime-inference": {"type": "api_key", "key": "sk-rejected"}}"#.to_string(),
        )))),
        Arc::new(NoOAuth),
    );
    // The scripted empty env keeps the stored credential the active source
    // (an ambient PRIME_API_KEY would outrank it).
    auth.env_credentials = Arc::new(ScriptedEnv(HashMap::new()));
    assert!(auth.mark_auth_stale(PRIME_INFERENCE_PROVIDER_ID));
    auth.set_prime_inference_api_key("sk-new", PrimeTeamAssignment::PersonalAccount);
    assert!(
        !auth.drain_errors().is_empty(),
        "the failed write surfaces its error"
    );
    assert_eq!(
        auth.get_auth_status(PRIME_INFERENCE_PROVIDER_ID).source,
        Some(AuthSource::Stale)
    );
    assert_eq!(auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID), None);
}

#[test]
fn prime_inference_team_selection_reads_follow_the_ts_tri_state() {
    let auth = storage_with(&serde_json::json!({}));
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::NotSelected
    );
    let auth = storage_with(&serde_json::json!({
        "prime-inference": {
            "type": "api_key",
            "key": "pi-key",
            "primeTeam": { "teamId": "team-1", "name": "Team 1" }
        }
    }));
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::Team(team("team-1", "Team 1"))
    );
    let auth = storage_with(&serde_json::json!({
        "prime-inference": {
            "type": "api_key", "key": "pi-key", "primeTeam": null
        }
    }));
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::PersonalAccount
    );
    let auth = storage_with_env(
        &serde_json::json!({
            "prime-inference": {
                "type": "api_key", "key": "pi-key", "primeTeam": null
            }
        }),
        ScriptedEnv(HashMap::from([(
            "PRIME_TEAM_ID".to_string(),
            "env-team".to_string(),
        )])),
    );
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::NotSelected
    );
    // An environment key does NOT hide the stored selection.
    let auth = storage_with_env(
        &serde_json::json!({
            "prime-inference": {
                "type": "api_key",
                "key": "pi-key",
                "primeTeam": { "teamId": "team-1", "name": "Team 1" }
            }
        }),
        ScriptedEnv(HashMap::from([(
            "PRIME_API_KEY".to_string(),
            "env-key".to_string(),
        )])),
    );
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::Team(team("team-1", "Team 1"))
    );
    // A runtime override does not hide it either.
    let mut auth = storage_with(&serde_json::json!({
        "prime-inference": {
            "type": "api_key",
            "key": "pi-key",
            "primeTeam": { "teamId": "team-1", "name": "Team 1" }
        }
    }));
    auth.set_runtime_api_key(PRIME_INFERENCE_PROVIDER_ID, "runtime-key".to_string());
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::Team(team("team-1", "Team 1"))
    );
}

/// A scripted OAuth integration for the refresh-flow tests: counts refresh calls,
/// optionally delays inside the fetch, and serves a fixed fresh credential;
/// `forced_outcome` scripts the force-refresh arm (`None` = no forced support).
struct CountingOAuth {
    calls: std::sync::atomic::AtomicUsize,
    delay_ms: u64,
    forced_outcome: Option<Result<AuthCredential, String>>,
}

impl CountingOAuth {
    fn fetched_credential() -> AuthCredential {
        AuthCredential::Oauth {
            access: "fetched-access".into(),
            refresh: Some("fetched-refresh".into()),
            expires: now_epoch_ms() + 3_600_000,
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
}

impl OAuthIntegration for CountingOAuth {
    fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::Oauth { access, .. } => Some(access.clone()),
            _ => None,
        }
    }

    fn refresh(&self, _provider: &str, _credentials: &AuthStorageData) -> Option<AuthCredential> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(self.delay_ms));
        }
        Some(Self::fetched_credential())
    }

    fn refresh_forced(
        &self,
        _provider: &str,
        _credentials: &AuthStorageData,
    ) -> Option<Result<AuthCredential, String>> {
        // `None` (no forced support) consults without fetching: the
        // fetch counter stays honest.
        self.forced_outcome.as_ref()?;
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(self.delay_ms));
        }
        self.forced_outcome.clone()
    }
}

fn oauth_credential(access: &str, expires: i64) -> AuthCredential {
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

fn expired_oauth(access: &str) -> AuthCredential {
    oauth_credential(access, 1000)
}

fn storage_over_backend_with(
    oauth: Arc<CountingOAuth>,
    provider: &str,
    credential: &AuthCredential,
) -> (AuthStorage, Arc<dyn AuthStorageBackend>) {
    let backend: Arc<dyn AuthStorageBackend> =
        Arc::new(crate::auth::storage::InMemoryAuthStorageBackend::default());
    let mut data = AuthStorageData::default();
    data.insert(provider, credential);
    let seed = serde_json::to_string_pretty(&data.0).unwrap_or_default();
    backend
        .with_lock(&mut |current| {
            let _ = current;
            Ok(((), Some(seed.clone())))
        })
        .ok();
    (
        AuthStorage::from_storage(Arc::clone(&backend), oauth),
        backend,
    )
}

#[test]
fn an_unexpired_oauth_credential_serves_without_a_fetch() {
    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 0,
        forced_outcome: None,
    });
    let (mut auth, _backend) = storage_over_backend_with(
        oauth.clone(),
        "x-fast",
        &oauth_credential("live-access", now_epoch_ms() + 3_600_000),
    );
    assert_eq!(auth.get_api_key("x-fast").as_deref(), Some("live-access"));
    assert_eq!(
        oauth.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the unexpired credential serves without a token fetch"
    );
}

#[test]
fn the_token_fetch_holds_no_document_lock_and_a_peer_write_keeps_its_fresher_credential() {
    // The fetch runs outside every lock: a locked writer lands mid-fetch, and the
    // write phase keeps the peer's fresher credential.
    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 120,
        forced_outcome: None,
    });
    let (mut auth, backend) =
        storage_over_backend_with(oauth.clone(), "x-peer", &expired_oauth("old-access"));
    let writer_backend = Arc::clone(&backend);
    let (wrote_tx, wrote_rx) = std::sync::mpsc::channel::<std::time::Duration>();
    std::thread::spawn(move || {
        // Mid-fetch: the resolving thread is inside the token fetch.
        std::thread::sleep(std::time::Duration::from_millis(40));
        let mut peer = AuthStorageData::default();
        peer.insert(
            "x-peer",
            &oauth_credential("peer-access", now_epoch_ms() + 3_600_000),
        );
        let content = serde_json::to_string_pretty(&peer.0).unwrap_or_default();
        let t0 = std::time::Instant::now();
        writer_backend
            .with_lock(&mut |current| {
                let _ = current;
                Ok(((), Some(content.clone())))
            })
            .ok();
        wrote_tx
            .send(t0.elapsed())
            .expect("the test main thread still waits for the write");
    });
    let api_key = auth.get_api_key("x-peer");
    let write_wall = wrote_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .expect("the peer's locked write completed; a token fetch must not hold the document lock");
    assert!(
        write_wall < std::time::Duration::from_millis(60),
        "the concurrent locked write waited {write_wall:?}: the fetch holds no lock"
    );
    assert_eq!(
        api_key.as_deref(),
        Some("peer-access"),
        "the peer's fresher credential wins over this attempt's own fetch"
    );
    let stored = auth.get_all().credential("x-peer").unwrap();
    let AuthCredential::Oauth { access, .. } = stored else {
        panic!("the stored credential stays OAuth");
    };
    assert_eq!(access, "peer-access");
    assert_eq!(
        oauth.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "exactly one fetch ran"
    );
}

#[test]
fn a_second_refresh_joins_the_first_flight_instead_of_fetching_again() {
    // Two resolutions race: the flight gate serializes them, and the
    // second serves the first's fresh credential.
    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 80,
        forced_outcome: None,
    });
    let (_, backend) =
        storage_over_backend_with(oauth.clone(), "x-flight", &expired_oauth("old-access"));
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let oauth = Arc::clone(&oauth);
        let backend = Arc::clone(&backend);
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            let mut auth = AuthStorage::from_storage(backend, oauth);
            barrier.wait();
            auth.get_api_key("x-flight")
        }));
    }
    let keys: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert!(keys.iter().all(|k| k.as_deref() == Some("fetched-access")));
    assert_eq!(
        oauth.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "one flight per provider: the second caller served the first's fresh credential"
    );
}

#[test]
fn a_locally_valid_credential_force_refreshes_and_resolves() {
    // The revoked-session shape: the stored expiry is still future-dated,
    // so the ordinary lookup serves the rejected token — only the forced
    // refresh replaces it.
    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 0,
        forced_outcome: Some(Ok(CountingOAuth::fetched_credential())),
    });
    let (mut auth, _backend) = storage_over_backend_with(
        oauth.clone(),
        "x-live",
        &oauth_credential("rejected-access", now_epoch_ms() + 3_600_000),
    );
    assert_eq!(
        auth.get_api_key("x-live").as_deref(),
        Some("rejected-access"),
        "the locally-valid credential serves before the force refresh"
    );
    let refreshed = auth.force_refresh_oauth("x-live");
    assert!(matches!(
        &refreshed,
        Ok(AuthCredential::Oauth { access, .. }) if access == "fetched-access"
    ));
    assert_eq!(
        oauth.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the force refresh spent exactly one fetch"
    );
    assert_eq!(
        auth.get_api_key("x-live").as_deref(),
        Some("fetched-access"),
        "the refreshed credential resolves after the force refresh"
    );
}

#[test]
fn a_rejected_force_refresh_keeps_the_stored_credential() {
    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 0,
        forced_outcome: Some(Err(
            "OpenAI Codex token refresh failed (401): expired".to_string()
        )),
    });
    let (mut auth, _backend) = storage_over_backend_with(
        oauth.clone(),
        "x-revoked",
        &oauth_credential("rejected-access", now_epoch_ms() + 3_600_000),
    );
    let outcome = auth.force_refresh_oauth("x-revoked");
    assert_eq!(
        outcome.unwrap_err(),
        "OpenAI Codex token refresh failed (401): expired",
        "the rejection reason carries out for the re-login surface"
    );
    assert_eq!(
        auth.get_api_key("x-revoked").as_deref(),
        Some("rejected-access"),
        "the stored credential stands untouched after a rejected grant"
    );
    assert_eq!(
        oauth.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "exactly one fetch was spent"
    );
}

#[test]
fn force_refresh_without_forced_support_reports_it() {
    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 0,
        forced_outcome: None,
    });
    let (mut auth, _backend) = storage_over_backend_with(
        oauth.clone(),
        "x-plain",
        &oauth_credential("live-access", now_epoch_ms() + 3_600_000),
    );
    let outcome = auth.force_refresh_oauth("x-plain");
    assert_eq!(
        outcome.unwrap_err(),
        "x-plain has no forced-refresh support"
    );
    assert_eq!(
        oauth.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "no fetch was attempted without forced support"
    );
}

#[test]
fn a_force_refresh_write_keeps_a_peer_s_fresher_credential() {
    // A peer refreshed against the same rejection while this fetch ran:
    // the locked write keeps the peer's fresher credential.
    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 80,
        forced_outcome: Some(Ok(CountingOAuth::fetched_credential())),
    });
    let (mut auth, backend) = storage_over_backend_with(
        oauth.clone(),
        "x-force-peer",
        &oauth_credential("rejected-access", now_epoch_ms() + 3_600_000),
    );
    let writer_backend = Arc::clone(&backend);
    std::thread::spawn(move || {
        // Mid-fetch: the peer's write lands while this fetch runs.
        std::thread::sleep(std::time::Duration::from_millis(40));
        let mut peer = AuthStorageData::default();
        peer.insert(
            "x-force-peer",
            &oauth_credential("peer-access", now_epoch_ms() + 3_600_000),
        );
        let content = serde_json::to_string_pretty(&peer.0).unwrap_or_default();
        writer_backend
            .with_lock(&mut |current| {
                let _ = current;
                Ok(((), Some(content.clone())))
            })
            .ok();
    });
    let refreshed = auth.force_refresh_oauth("x-force-peer");
    assert!(
        matches!(
            &refreshed,
            Ok(AuthCredential::Oauth { access, .. }) if access == "peer-access"
        ),
        "the peer's fresher credential wins over this attempt's own fetch"
    );
    assert_eq!(
        auth.get_api_key("x-force-peer").as_deref(),
        Some("peer-access")
    );
    assert_eq!(
        oauth.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "exactly one fetch ran"
    );
}

/// A concurrent logout (the credential vanishes while the fetch runs) must
/// stand: the locked write never resurrects the credential this refresh
/// loaded. A deletion is not "no fresher peer credential".
#[test]
fn a_concurrent_logout_wins_over_the_forced_refresh_write() {
    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 80,
        forced_outcome: Some(Ok(CountingOAuth::fetched_credential())),
    });
    let (mut auth, backend) = storage_over_backend_with(
        oauth.clone(),
        "x-logged-out",
        &oauth_credential("rejected-access", now_epoch_ms() + 3_600_000),
    );
    let peer_backend = Arc::clone(&backend);
    let writer_oauth = Arc::clone(&oauth);
    let writer = std::thread::spawn(move || {
        // Mid-fetch readiness signal: wait until the token exchange is
        // actually running, then land the logout inside its window.
        while writer_oauth.calls.load(std::sync::atomic::Ordering::SeqCst) < 1 {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let logged_out = AuthStorageData::default();
        let content = serde_json::to_string_pretty(&logged_out.0).unwrap_or_default();
        peer_backend
            .with_lock(&mut |current| {
                let _ = current;
                Ok(((), Some(content.clone())))
            })
            .ok();
    });
    let outcome = auth.force_refresh_oauth("x-logged-out");
    assert!(
        outcome.is_err(),
        "a concurrent logout fails the recovery: no usable credential remains"
    );
    assert!(
        auth.get_all().credential("x-logged-out").is_none(),
        "the logout stands: the forced write never resurrects the credential"
    );
    writer.join().expect("the logout writer settles");
    assert_eq!(
        oauth.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "exactly one fetch ran"
    );
}

/// A concurrent replacement with an API key must stand too: the locked
/// write never overwrites the replacement with the refreshed OAuth grant.
#[test]
fn an_api_key_replacement_wins_over_the_forced_refresh_write() {
    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 80,
        forced_outcome: Some(Ok(CountingOAuth::fetched_credential())),
    });
    let (mut auth, backend) = storage_over_backend_with(
        oauth.clone(),
        "x-swapped",
        &oauth_credential("rejected-access", now_epoch_ms() + 3_600_000),
    );
    let peer_backend = Arc::clone(&backend);
    let writer_oauth = Arc::clone(&oauth);
    let writer = std::thread::spawn(move || {
        // Mid-fetch readiness signal: wait until the token exchange is
        // actually running, then land the logout inside its window.
        while writer_oauth.calls.load(std::sync::atomic::Ordering::SeqCst) < 1 {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let mut replacement = AuthStorageData::default();
        replacement.insert(
            "x-swapped",
            &AuthCredential::ApiKey {
                key: "sk-fresh".into(),
                prime_team: None,
            },
        );
        let content = serde_json::to_string_pretty(&replacement.0).unwrap_or_default();
        peer_backend
            .with_lock(&mut |current| {
                let _ = current;
                Ok(((), Some(content.clone())))
            })
            .ok();
    });
    let outcome = auth.force_refresh_oauth("x-swapped");
    assert!(
        matches!(
            &outcome,
            Ok(AuthCredential::ApiKey { key, .. }) if key == "sk-fresh"
        ),
        "the replacement serves to the caller's rebind"
    );
    assert!(
        matches!(
            auth.get_all().credential("x-swapped"),
            Some(AuthCredential::ApiKey { key, .. }) if key == "sk-fresh"
        ),
        "the API key stands: the forced write never overwrites it"
    );
    writer.join().expect("the replacement writer settles");
    assert_eq!(
        oauth.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "exactly one fetch ran"
    );
}

/// The forced-refresh single-flight guard must still be held while the
/// refreshed credential persists: a waiter released between the fetch and
/// the write re-spends the same single-use refresh token.
#[test]
fn the_forced_refresh_flight_guards_the_write() {
    struct WriteProbingBackend {
        inner: crate::auth::InMemoryAuthStorageBackend,
        probed: std::sync::atomic::AtomicBool,
        held: std::sync::atomic::AtomicBool,
    }

    impl AuthStorageBackend for WriteProbingBackend {
        fn with_lock(
            &self,
            update: &mut dyn FnMut(Option<String>) -> anyhow::Result<((), Option<String>)>,
        ) -> anyhow::Result<()> {
            let probed = &self.probed;
            let held = &self.held;
            let mut wrapped = |current: Option<String>| -> anyhow::Result<((), Option<String>)> {
                let ((), next) = update(current)?;
                if next.is_some() && !probed.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    // The refreshed credential is being persisted: the
                    // per-provider flight must still hold — a probe that
                    // acquires it instantly means a waiter re-spends the
                    // same refresh token. The probe flags its own start so
                    // the held check can never read an unscheduled probe.
                    let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    let acquired = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    std::thread::spawn({
                        let started = Arc::clone(&started);
                        let acquired = Arc::clone(&acquired);
                        move || {
                            started.store(true, std::sync::atomic::Ordering::SeqCst);
                            let _guard = refresh_flight("x-flight-write");
                            acquired.store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                    });
                    while !started.load(std::sync::atomic::Ordering::SeqCst) {
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    held.store(
                        !acquired.load(std::sync::atomic::Ordering::SeqCst),
                        std::sync::atomic::Ordering::SeqCst,
                    );
                }
                Ok(((), next))
            };
            self.inner.with_lock(&mut wrapped)
        }
    }

    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 0,
        forced_outcome: Some(Ok(CountingOAuth::fetched_credential())),
    });
    let backend = Arc::new(WriteProbingBackend {
        inner: crate::auth::InMemoryAuthStorageBackend::default(),
        probed: std::sync::atomic::AtomicBool::new(false),
        held: std::sync::atomic::AtomicBool::new(false),
    });
    let mut seeded = AuthStorageData::default();
    seeded.insert(
        "x-flight-write",
        &oauth_credential("rejected-access", now_epoch_ms() + 3_600_000),
    );
    let seed = serde_json::to_string_pretty(&seeded.0).unwrap_or_default();
    backend
        .inner
        .with_lock(&mut |current| {
            let _ = current;
            Ok(((), Some(seed.clone())))
        })
        .ok();
    let mut auth =
        AuthStorage::from_storage(Arc::clone(&backend) as Arc<dyn AuthStorageBackend>, oauth);
    let outcome = auth.force_refresh_oauth("x-flight-write");
    assert!(
        matches!(&outcome, Ok(AuthCredential::Oauth { access, .. }) if access == "fetched-access"),
        "the forced refresh completes"
    );
    assert!(
        backend.held.load(std::sync::atomic::Ordering::SeqCst),
        "the single flight is still held while the refreshed credential persists"
    );
}
