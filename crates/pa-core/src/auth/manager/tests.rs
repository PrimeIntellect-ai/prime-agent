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

/// A `!command` credential key runs the command only when its value is
/// actually needed (TS's deferred value material): building the
/// candidates for a status probe never spawns the command; the serving
/// lookup resolves it once and the process cache holds it afterwards.
/// The counter key is a POSIX-shell pipeline (the ambient shell on
/// Windows resolves it differently), so the test runs on Unix only.
#[cfg(unix)]
#[test]
fn a_command_keys_status_probe_never_runs_the_command() {
    let counter = std::env::temp_dir().join(format!(
        "pa-command-probe-{}-{}",
        std::process::id(),
        line!()
    ));
    let _ = std::fs::remove_file(&counter);
    let key = format!("!echo run >> {} ; echo cmd-key", counter.display());
    let mut auth = storage_with(&serde_json::json!({
        "anthropic": { "type": "api_key", "key": key }
    }));
    let runs = || std::fs::read_to_string(&counter).map_or(0, |text| text.lines().count());
    let status = auth.get_auth_status("anthropic");
    assert_eq!(status.source, Some(AuthSource::Stored));
    assert_eq!(
        runs(),
        0,
        "building the candidates for a status probe never runs the command"
    );
    assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("cmd-key"));
    assert_eq!(runs(), 1, "the serving lookup resolves the command once");
    assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("cmd-key"));
    assert_eq!(
        runs(),
        1,
        "the source token reuses the resolved value; the process cache holds it"
    );
    let _ = std::fs::remove_file(&counter);
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
/// optionally delays inside the fetch, and serves a fixed fresh credential.
struct CountingOAuth {
    calls: std::sync::atomic::AtomicUsize,
    delay_ms: u64,
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

/// Probe the persistence boundary itself: main releases the flight before this write.
#[test]
fn the_refresh_flight_stays_held_through_credential_commit() {
    struct CommitProbe {
        provider: &'static str,
        storage: crate::auth::storage::InMemoryAuthStorageBackend,
        flight_held: std::sync::Mutex<Vec<bool>>,
    }

    impl AuthStorageBackend for CommitProbe {
        fn read(&self) -> anyhow::Result<Option<String>> {
            self.storage.read()
        }

        fn with_lock(
            &self,
            update: &mut dyn FnMut(Option<String>) -> anyhow::Result<((), Option<String>)>,
        ) -> anyhow::Result<()> {
            self.flight_held
                .lock()
                .unwrap()
                .push(refresh_flight_lock(self.provider).try_lock().is_err());
            self.storage.with_lock(update)
        }
    }

    let provider = "x-flight-commit-probe";
    let backend = Arc::new(CommitProbe {
        provider,
        storage: crate::auth::storage::InMemoryAuthStorageBackend::default(),
        flight_held: std::sync::Mutex::new(Vec::new()),
    });
    let mut data = AuthStorageData::default();
    data.insert(provider, &expired_oauth("old-access"));
    let seed = serde_json::to_string(&data.0).unwrap();
    backend
        .storage
        .with_lock(&mut |_| Ok(((), Some(seed.clone()))))
        .unwrap();
    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 0,
    });
    let mut auth = AuthStorage::from_storage(backend.clone(), oauth);
    assert_eq!(
        auth.get_api_key(provider).as_deref(),
        Some("fetched-access")
    );
    assert_eq!(*backend.flight_held.lock().unwrap(), vec![true]);
}

#[test]
fn a_second_refresh_joins_the_first_flight_instead_of_fetching_again() {
    // Two resolutions race: the flight gate serializes them, and the
    // second serves the first's fresh credential.
    let oauth = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 80,
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

/// A scripted backend for the refresh catch paths: the in-memory document
/// core plus two scripted failure points. `peer_on_lock_error` lands a
/// peer's completed refresh at the `refresh_lock` call and reports the
/// lock unavailable (a waiting peer's world: the peer's fresh credential
/// is in the store, the lock cannot be taken); `fail_writes` fails the
/// credential write, so the document keeps the expired credential.
struct CatchBackend {
    content: std::sync::Mutex<Option<String>>,
    peer_on_lock_error: Option<String>,
    fail_writes: bool,
}

impl AuthStorageBackend for CatchBackend {
    fn read(&self) -> anyhow::Result<Option<String>> {
        Ok(self.content.lock().expect("catch backend content").clone())
    }

    fn with_lock(
        &self,
        update: &mut dyn FnMut(Option<String>) -> anyhow::Result<((), Option<String>)>,
    ) -> anyhow::Result<()> {
        let mut content = self.content.lock().expect("catch backend content");
        let ((), next) = update(content.clone())?;
        if let Some(next) = next {
            anyhow::ensure!(!self.fail_writes, "the scripted credential write fails");
            *content = Some(next);
        }
        Ok(())
    }

    fn refresh_lock(&self, _provider: &str) -> anyhow::Result<Option<crate::auth::RefreshLock>> {
        match &self.peer_on_lock_error {
            Some(peer) => {
                // The peer refreshed while this flight waited for the
                // lock; the lock stays unavailable.
                *self.content.lock().expect("catch backend content") = Some(peer.clone());
                anyhow::bail!("the scripted refresh lock is unavailable")
            }
            // A single-process backend: the process-local flight gate
            // serializes the refresh.
            None => Ok(None),
        }
    }
}

/// One stored OAuth credential for `provider`, serialized like the file
/// document.
fn catch_document(provider: &str, credential: &AuthCredential) -> String {
    let mut data = AuthStorageData::default();
    data.insert(provider, credential);
    serde_json::to_string_pretty(&data.0).unwrap()
}

/// The refresh-lock catch path: a lock that cannot be taken serves the
/// stored unexpired credential (a peer's completed refresh, landed while
/// this flight waited) and never fetches a token — fetching without the
/// lock would spend the single-use refresh token a second time.
#[test]
fn an_unavailable_refresh_lock_serves_the_peer_credential_and_never_fetches() {
    let provider = "x-lock-unavailable";
    let mut peer = AuthStorageData::default();
    peer.insert(
        provider,
        &oauth_credential("peer-access", now_epoch_ms() + 3_600_000),
    );
    let backend = Arc::new(CatchBackend {
        content: std::sync::Mutex::new(Some(catch_document(
            provider,
            &expired_oauth("old-access"),
        ))),
        peer_on_lock_error: Some(serde_json::to_string_pretty(&peer.0).unwrap()),
        fail_writes: false,
    });
    let counting = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 0,
    });
    let oauth: Arc<dyn OAuthIntegration> = counting.clone();
    let mut auth =
        AuthStorage::from_storage(Arc::clone(&backend) as Arc<dyn AuthStorageBackend>, oauth);
    assert_eq!(
        auth.get_api_key(provider).as_deref(),
        Some("peer-access"),
        "the catch path serves the peer's landed credential"
    );
    assert_eq!(
        counting.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "an unavailable refresh lock never fetches a token"
    );
}

/// A scripted OAuth integration whose refresh lands a concurrent
/// `/login`'s fresh credential in the backend and then fails its token
/// call: the failed-fetch catch path must serve the landed credential.
struct LoginLandingRefresh {
    backend: Arc<CatchBackend>,
    login: String,
}

impl OAuthIntegration for LoginLandingRefresh {
    fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::Oauth { access, .. } => Some(access.clone()),
            _ => None,
        }
    }

    fn refresh(&self, _provider: &str, _credentials: &AuthStorageData) -> Option<AuthCredential> {
        // The concurrent `/login` lands while this fetch runs; the token
        // call itself fails.
        *self.backend.content.lock().expect("catch backend content") = Some(self.login.clone());
        None
    }
}

/// The failed-fetch catch path: a refresh whose token call fails serves a
/// credential that landed meanwhile (a peer's refresh or a concurrent
/// `/login`) instead of nothing.
#[test]
fn a_failed_fetch_serves_a_credential_that_landed_meanwhile() {
    let provider = "x-fetch-failed";
    let mut login = AuthStorageData::default();
    login.insert(
        provider,
        &oauth_credential("login-access", now_epoch_ms() + 3_600_000),
    );
    let backend = Arc::new(CatchBackend {
        content: std::sync::Mutex::new(Some(catch_document(
            provider,
            &expired_oauth("old-access"),
        ))),
        peer_on_lock_error: None,
        fail_writes: false,
    });
    let oauth: Arc<dyn OAuthIntegration> = Arc::new(LoginLandingRefresh {
        backend: Arc::clone(&backend),
        login: serde_json::to_string_pretty(&login.0).unwrap(),
    });
    let mut auth =
        AuthStorage::from_storage(Arc::clone(&backend) as Arc<dyn AuthStorageBackend>, oauth);
    assert_eq!(
        auth.get_api_key(provider).as_deref(),
        Some("login-access"),
        "the failed fetch serves the credential that landed meanwhile"
    );
}

/// The failed-write catch path: a refresh whose credential write fails
/// serves only an unexpired credential — the expired stored credential is
/// not a refresh outcome (serving it would adopt an expired token as a
/// live pair at the stream seam).
#[test]
fn a_failed_write_serves_no_expired_credential() {
    let provider = "x-write-failed";
    let backend = Arc::new(CatchBackend {
        content: std::sync::Mutex::new(Some(catch_document(
            provider,
            &expired_oauth("old-access"),
        ))),
        peer_on_lock_error: None,
        fail_writes: true,
    });
    let counting = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 0,
    });
    let oauth: Arc<dyn OAuthIntegration> = counting.clone();
    let mut auth =
        AuthStorage::from_storage(Arc::clone(&backend) as Arc<dyn AuthStorageBackend>, oauth);
    assert_eq!(
        auth.get_api_key(provider),
        None,
        "the expired stored credential is not a refresh outcome"
    );
    assert_eq!(
        counting.calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the fetch ran once before the scripted write failed"
    );
    assert_eq!(
        backend
            .content
            .lock()
            .expect("catch backend content")
            .as_deref(),
        Some(catch_document(provider, &expired_oauth("old-access")).as_str()),
        "the failed write left the expired credential in the document"
    );
}

/// A scripted backend for the refresh-lock wait: `refresh_lock` first
/// lands a scripted store change — the world a waiting flight sees when
/// it finally gets past the lock — then either reports the lock
/// unavailable or grants it (`Ok(None)`, the single-process shape).
struct LockWaitChangeBackend {
    content: std::sync::Mutex<Option<String>>,
    change_on_lock: Option<String>,
    lock_error: bool,
}

impl AuthStorageBackend for LockWaitChangeBackend {
    fn read(&self) -> anyhow::Result<Option<String>> {
        Ok(self.content.lock().expect("lock-wait content").clone())
    }

    fn with_lock(
        &self,
        update: &mut dyn FnMut(Option<String>) -> anyhow::Result<((), Option<String>)>,
    ) -> anyhow::Result<()> {
        let mut content = self.content.lock().expect("lock-wait content");
        let ((), next) = update(content.clone())?;
        if let Some(next) = next {
            *content = Some(next);
        }
        Ok(())
    }

    fn refresh_lock(&self, _provider: &str) -> anyhow::Result<Option<crate::auth::RefreshLock>> {
        if let Some(change) = &self.change_on_lock {
            *self.content.lock().expect("lock-wait content") = Some(change.clone());
        }
        if self.lock_error {
            anyhow::bail!("the scripted refresh lock is unavailable")
        }
        Ok(None)
    }
}

/// One resolution over an expired stored grant whose `refresh_lock` first
/// lands `change_on_lock`, then grants or refuses the lock. Returns the
/// served key, the token fetches, and the stored document.
fn resolve_over_lock_wait(
    provider: &str,
    change_on_lock: Option<String>,
    lock_error: bool,
) -> (Option<String>, usize, Option<String>) {
    let backend = Arc::new(LockWaitChangeBackend {
        content: std::sync::Mutex::new(Some(catch_document(
            provider,
            &expired_oauth("old-access"),
        ))),
        change_on_lock,
        lock_error,
    });
    let counting = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 0,
    });
    let oauth: Arc<dyn OAuthIntegration> = counting.clone();
    let mut auth =
        AuthStorage::from_storage(Arc::clone(&backend) as Arc<dyn AuthStorageBackend>, oauth);
    let key = auth.get_api_key(provider);
    let fetches = counting.calls.load(std::sync::atomic::Ordering::SeqCst);
    let stored = backend.content.lock().expect("lock-wait content").clone();
    (key, fetches, stored)
}

/// The lock-error catch path over a store that still holds the EXPIRED
/// original: nothing unexpired is served, and the refresh never fetches —
/// a fetch without the lock is the double spend the lock exists to stop.
#[test]
fn an_unavailable_refresh_lock_over_a_still_expired_store_never_fetches() {
    let (key, fetches, _stored) = resolve_over_lock_wait("x-lock-unavailable-expired", None, true);
    assert_eq!(
        fetches, 0,
        "an unavailable refresh lock never fetches a token"
    );
    assert_eq!(
        key, None,
        "the expired stored credential is not a refresh outcome"
    );
}

/// The re-read identity guard (logout): a logout that lands while this
/// flight waits for the refresh lock stops the refresh before it spends
/// the logged-out grant's refresh token; the deletion stays authoritative.
#[test]
fn a_logout_during_the_lock_wait_spends_no_refresh_token() {
    let (key, fetches, stored) =
        resolve_over_lock_wait("x-logout-during-lock-wait", Some("{}".to_string()), false);
    assert_eq!(
        fetches, 0,
        "the refresh never spends a token for a grant the store no longer holds"
    );
    assert_eq!(key, None);
    assert_eq!(stored.as_deref(), Some("{}"), "the logout stays");
}

/// The re-read identity guard (replacement): a new API-key login that
/// lands while this flight waits for the refresh lock stops the refresh
/// the same way; the replaced credential stays authoritative.
#[test]
fn a_login_during_the_lock_wait_spends_no_refresh_token() {
    let provider = "x-login-during-lock-wait";
    let mut login = AuthStorageData::default();
    login.insert(
        provider,
        &AuthCredential::ApiKey {
            key: "new-login-key".to_string(),
            prime_team: None,
        },
    );
    let login_doc = serde_json::to_string_pretty(&login.0).unwrap();
    let (key, fetches, stored) = resolve_over_lock_wait(provider, Some(login_doc.clone()), false);
    assert_eq!(
        fetches, 0,
        "the refresh never spends the replaced grant's refresh token"
    );
    assert_eq!(
        key, None,
        "the re-read stops this attempt; the next resolution's fresh load serves the login"
    );
    assert_eq!(
        stored.as_deref(),
        Some(login_doc.as_str()),
        "the login stays"
    );
}

/// A scripted backend for the failed protected re-read: `refresh_lock`
/// lands a completed peer rotation (the world a caller that waited for
/// the lock sees), the protected re-read then fails exactly once (an
/// independent credential writer holding the document lock through the
/// whole read budget), and reads after that serve the current document.
struct RereadFailingBackend {
    content: std::sync::Mutex<Option<String>>,
    reads: std::sync::atomic::AtomicUsize,
}

impl AuthStorageBackend for RereadFailingBackend {
    fn read(&self) -> anyhow::Result<Option<String>> {
        let reads = self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if reads == 2 {
            // The protected re-read: the document lock is held by an
            // independent writer through the read budget.
            anyhow::bail!("Failed to acquire auth storage lock");
        }
        Ok(self.content.lock().expect("reread content").clone())
    }

    fn with_lock(
        &self,
        update: &mut dyn FnMut(Option<String>) -> anyhow::Result<((), Option<String>)>,
    ) -> anyhow::Result<()> {
        let mut content = self.content.lock().expect("reread content");
        let ((), next) = update(content.clone())?;
        if let Some(next) = next {
            *content = Some(next);
        }
        Ok(())
    }

    fn refresh_lock(&self, provider: &str) -> anyhow::Result<Option<crate::auth::RefreshLock>> {
        // The peer finished its rotation while this caller waited for
        // the lock: its fresh credential is in the document. The lock
        // itself is granted (single-process shape: the flight gate
        // serializes the callers).
        let mut peer = AuthStorageData::default();
        peer.insert(
            provider,
            &oauth_credential("peer-access", now_epoch_ms() + 3_600_000),
        );
        *self.content.lock().expect("reread content") =
            Some(serde_json::to_string_pretty(&peer.0)?);
        Ok(None)
    }
}

/// A failed protected re-read fails the refresh closed: a peer rotated
/// the single-use refresh token while this caller waited for the refresh
/// lock, and an independent writer then holds the document lock through
/// the re-read's budget. The LOAD-time grant may already be spent, so
/// no fetch ever runs on it — the refresh serves only a current
/// unexpired stored credential (the peer's).
#[test]
fn a_failed_reread_serves_the_stored_credential_and_never_fetches() {
    let provider = "x-reread-failed";
    let backend = Arc::new(RereadFailingBackend {
        content: std::sync::Mutex::new(Some(catch_document(
            provider,
            &expired_oauth("old-access"),
        ))),
        reads: std::sync::atomic::AtomicUsize::new(0),
    });
    let counting = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 0,
    });
    let oauth: Arc<dyn OAuthIntegration> = counting.clone();
    let mut auth =
        AuthStorage::from_storage(Arc::clone(&backend) as Arc<dyn AuthStorageBackend>, oauth);
    assert_eq!(
        auth.get_api_key(provider).as_deref(),
        Some("peer-access"),
        "the peer's landed credential serves; the LOAD-time grant is never fetched"
    );
    assert_eq!(
        counting.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "a failed protected re-read never spends the possibly-rotated LOAD-time token"
    );
}

/// A scripted backend for the failed LOAD read: the first read (the
/// construction reload) serves the expired credential, the refresh's
/// LOAD read fails (an independent writer holds the document lock
/// through the read budget), and reads after that serve the same
/// document again — the reload inside the catch parses it and the
/// in-memory copy stays the expired credential this refresh set out to
/// rotate.
struct LoadFailingBackend {
    content: String,
    reads: std::sync::atomic::AtomicUsize,
}

impl AuthStorageBackend for LoadFailingBackend {
    fn read(&self) -> anyhow::Result<Option<String>> {
        let reads = self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if reads == 1 {
            anyhow::bail!("Failed to acquire auth storage lock");
        }
        Ok(Some(self.content.clone()))
    }

    fn with_lock(
        &self,
        update: &mut dyn FnMut(Option<String>) -> anyhow::Result<((), Option<String>)>,
    ) -> anyhow::Result<()> {
        // Never reached in this scenario: the failed LOAD read stops the
        // refresh before the write phase.
        let ((), _next) = update(Some(self.content.clone()))?;
        Ok(())
    }
}

/// The refresh's LOAD read failing serves only a CURRENT credential: the
/// in-memory copy may be the expired credential this refresh set out to
/// rotate, and serving it would stream a known-stale token. TS's catch
/// path returns nothing and lets the environment/fallback arms serve
/// instead (auth-storage.ts reload keeps `this.data`; the lookup's
/// expired-oauth catch returns `{}`).
#[test]
fn a_failed_load_read_never_serves_the_expired_in_memory_credential() {
    let provider = "x-load-failed";
    let backend = Arc::new(LoadFailingBackend {
        content: catch_document(provider, &expired_oauth("expired-access")),
        reads: std::sync::atomic::AtomicUsize::new(0),
    });
    let counting = Arc::new(CountingOAuth {
        calls: std::sync::atomic::AtomicUsize::new(0),
        delay_ms: 0,
    });
    let oauth: Arc<dyn OAuthIntegration> = counting.clone();
    let mut auth =
        AuthStorage::from_storage(Arc::clone(&backend) as Arc<dyn AuthStorageBackend>, oauth);
    assert_eq!(
        auth.get_api_key(provider),
        None,
        "the expired in-memory credential never serves on a failed read"
    );
    assert_eq!(
        counting.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the failed LOAD read never reaches a token fetch"
    );
}
