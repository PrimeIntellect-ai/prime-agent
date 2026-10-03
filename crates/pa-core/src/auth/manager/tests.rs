//! The `AuthStorage` unit battery (moved with its concern): the candidate
//! memo + staleness machinery, the runtime/stored/environment/fallback
//! precedence, the OAuth refresh contract, and the Prime Inference
//! credential + team writes (the hermetic `ScriptedEnv` seam against the
//! ambient env).

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

    fn prime_context(&self) -> Option<String> {
        self.0.get("PRIME_CONTEXT").cloned()
    }

    fn home_dir(&self) -> Option<std::path::PathBuf> {
        self.0
            .get("HOME")
            .map(std::path::PathBuf::from)
            .or_else(pa_types::platform::home_dir)
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
    // Non-prime provider: runtime beats stored; ambient env of the test
    // process cannot interfere (stored outranks env for these).
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
    // The stored credential is now skipped.
    assert_eq!(auth.get_api_key("prime-inference"), None);
    let status = auth.get_auth_status("prime-inference");
    assert_eq!(status.source, Some(AuthSource::Stale));
    // Explicit clear re-enables it.
    auth.clear_auth_stale("prime-inference");
    assert_eq!(
        auth.get_api_key("prime-inference").as_deref(),
        Some("sk-stale")
    );
}

#[test]
fn candidate_memos_supersede_exactly_when_material_changes() {
    // The memo is keyed by the hashed material itself (TS #2479's
    // `authCandidateMemos`): a changed env value must re-resolve to the
    // new fingerprint, so a stale marking from the old value never gates
    // the new one, and the same value keeps serving the same
    // resolution.
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
    // A changed value changes the memo key: the rebuilt candidate's
    // value fingerprint differs from the stale token's, so the new
    // value resolves.
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
    // The stored arm: replacing the credential changes the hashed
    // material, so a stale marking of the old key never gates the new
    // one.
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
    // prime-inference prefers the environment over stored.
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
    // Stored team selection surfaces as the team header.
    let headers = auth
        .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
        .unwrap();
    assert_eq!(
        headers.get("X-Prime-Team-ID").map(String::as_str),
        Some("team-1")
    );
    // Other providers have no headers.
    assert!(auth.get_provider_headers("anthropic").is_none());
    // The stored team survives an ambient environment key (the dogfood
    // box posture): PRIME_API_KEY supplies the key, the stored login's
    // team still scopes the header.
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

#[test]
fn provider_headers_follow_the_directory_context() {
    /// (case, pin, env, session dir set, expected team header)
    type Case<'a> = (
        &'a str,
        &'a str,
        &'a [(&'a str, &'a str)],
        bool,
        Option<&'a str>,
    );
    let cases: [Case; 5] = [
        (
            "team pin",
            r#"{"team_id": "pinned"}"#,
            &[],
            true,
            Some("pinned"),
        ),
        ("personal pin", r#"{"team_id": null}"#, &[], true, None),
        (
            "PRIME_TEAM_ID over pin",
            r#"{"team_id": "pinned"}"#,
            &[("PRIME_TEAM_ID", "env-team")],
            true,
            Some("env-team"),
        ),
        ("broken pin", "[]", &[], true, Some("team-1")),
        (
            "no session dir",
            r#"{"team_id": "pinned"}"#,
            &[],
            false,
            Some("team-1"),
        ),
    ];
    for (name, pin, env, with_dir, expected) in cases {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(repo.join(".prime")).unwrap();
        std::fs::write(repo.join(".prime/context.json"), pin).unwrap();
        let env = env
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()));
        let mut auth = storage_with_env(
            &serde_json::json!({
                "prime-inference": {
                    "type": "api_key",
                    "key": "pi-key",
                    "primeTeam": { "teamId": "team-1", "name": "Team 1" }
                }
            }),
            ScriptedEnv(env.collect()),
        );
        if with_dir {
            auth = auth.with_project_dir(&repo);
        }
        let header = auth
            .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
            .and_then(|headers| headers.get("X-Prime-Team-ID").cloned());
        assert_eq!(header.as_deref(), expected, "{name}");
    }
}

/// A home whose prime CLI config saves the contexts `customer` (its own
/// account) and `dev` (a non-production API), a repo under it, and the
/// stored login `pi-key` on `team-1`.
fn saved_context_layout() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let home = std::fs::canonicalize(root.path()).unwrap().join("home");
    let environments = home.join(".prime/environments");
    std::fs::create_dir_all(&environments).unwrap();
    std::fs::write(
        environments.join("customer.json"),
        r#"{"api_key": "customer-key", "team_id": "customer-team"}"#,
    )
    .unwrap();
    std::fs::write(
        environments.join("dev.json"),
        r#"{"base_url": "http://localhost:8000", "api_key": "dev-key", "team_id": "dev-team"}"#,
    )
    .unwrap();
    let repo = home.join("code/repo");
    std::fs::create_dir_all(repo.join(".prime")).unwrap();
    (root, home, repo)
}

fn stored_prime_login() -> serde_json::Value {
    serde_json::json!({
        "prime-inference": {
            "type": "api_key",
            "key": "pi-key",
            "primeTeam": { "teamId": "team-1", "name": "Team 1" }
        }
    })
}

/// A pinned saved context is the prime CLI's account in that directory:
/// its key replaces the stored login (key and team from one resolution),
/// `PRIME_API_KEY` still wins, and the stored credential is untouched.
#[test]
fn a_saved_directory_context_supplies_the_key_and_team() {
    /// (case, pin, env, expected key, expected team header)
    type Case<'a> = (
        &'a str,
        &'a str,
        &'a [(&'a str, &'a str)],
        &'a str,
        Option<&'a str>,
    );
    let cases: [Case; 7] = [
        (
            "context pin",
            r#"{"context": "customer"}"#,
            &[],
            "customer-key",
            Some("customer-team"),
        ),
        (
            "team_id over the context keeps its key",
            r#"{"context": "customer", "team_id": "t1"}"#,
            &[],
            "customer-key",
            Some("t1"),
        ),
        (
            "PRIME_API_KEY over the context key",
            r#"{"context": "customer"}"#,
            &[("PRIME_API_KEY", "env-key")],
            "env-key",
            Some("customer-team"),
        ),
        (
            "PRIME_CONTEXT over a team pin",
            r#"{"team_id": "t1"}"#,
            &[("PRIME_CONTEXT", "customer")],
            "customer-key",
            Some("customer-team"),
        ),
        (
            "team pin keeps the stored key",
            r#"{"team_id": "t1"}"#,
            &[],
            "pi-key",
            Some("t1"),
        ),
        (
            "non-production context keeps the stored login",
            r#"{"context": "dev", "team_id": "t1"}"#,
            &[],
            "pi-key",
            Some("team-1"),
        ),
        (
            "broken pin keeps the stored login",
            r#"{"context": "gone", "team_id": "t1"}"#,
            &[],
            "pi-key",
            Some("team-1"),
        ),
    ];
    for (name, pin, env, expected_key, expected_team) in cases {
        let (_root, home, repo) = saved_context_layout();
        std::fs::write(repo.join(".prime/context.json"), pin).unwrap();
        let mut env: HashMap<String, String> = env
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        env.insert("HOME".to_string(), home.display().to_string());
        let mut auth =
            storage_with_env(&stored_prime_login(), ScriptedEnv(env)).with_project_dir(&repo);
        assert_eq!(
            auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID).as_deref(),
            Some(expected_key),
            "{name}"
        );
        let header = auth
            .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
            .and_then(|headers| headers.get("X-Prime-Team-ID").cloned());
        assert_eq!(header.as_deref(), expected_team, "{name}");
        assert_eq!(
            auth.get_all().credential(PRIME_INFERENCE_PROVIDER_ID),
            Some(AuthCredential::ApiKey {
                key: "pi-key".to_string(),
                prime_team: Some(team("team-1", "Team 1")),
            }),
            "{name}: the stored login is untouched"
        );
    }
}

/// The context key reports its source, and a rejected (stale) context key
/// never falls back to the stored login: that key is another account's,
/// and the directory's team would ride on it.
#[test]
fn a_stale_context_key_does_not_fall_back_to_the_stored_login() {
    let (_root, home, repo) = saved_context_layout();
    std::fs::write(
        repo.join(".prime/context.json"),
        r#"{"context": "customer"}"#,
    )
    .unwrap();
    let env = HashMap::from([("HOME".to_string(), home.display().to_string())]);
    let mut auth =
        storage_with_env(&stored_prime_login(), ScriptedEnv(env)).with_project_dir(&repo);
    let status = auth.get_auth_status(PRIME_INFERENCE_PROVIDER_ID);
    assert_eq!(status.source, Some(AuthSource::PrimeCli));
    assert_eq!(status.label.as_deref(), Some("Prime context 'customer'"));
    assert!(auth.mark_auth_stale(PRIME_INFERENCE_PROVIDER_ID));
    assert_eq!(auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID), None);
    assert_eq!(
        auth.get_auth_status(PRIME_INFERENCE_PROVIDER_ID).source,
        Some(AuthSource::Stale)
    );
}

/// One walk and parse per instance: a pin edited after the first read
/// applies from the next instance (or `reload`).
#[test]
fn the_directory_context_resolves_once_per_instance() {
    let (_root, home, repo) = saved_context_layout();
    let pin = repo.join(".prime/context.json");
    std::fs::write(&pin, r#"{"team_id": "pinned"}"#).unwrap();
    let env = HashMap::from([("HOME".to_string(), home.display().to_string())]);
    let mut auth =
        storage_with_env(&stored_prime_login(), ScriptedEnv(env)).with_project_dir(&repo);
    let team_header = |auth: &AuthStorage| {
        auth.get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
            .and_then(|headers| headers.get("X-Prime-Team-ID").cloned())
    };
    assert_eq!(team_header(&auth).as_deref(), Some("pinned"));
    std::fs::remove_file(&pin).unwrap();
    assert_eq!(team_header(&auth).as_deref(), Some("pinned"));
    auth.reload();
    assert_eq!(team_header(&auth).as_deref(), Some("team-1"));
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
    // A team write binds the team to the key.
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
    // The write clears a stale marking on the stored source (TS
    // `clearStaleAuthSource`).
    assert!(auth.mark_auth_stale(PRIME_INFERENCE_PROVIDER_ID));
    auth.set_prime_inference_api_key("sk-3", PrimeTeamAssignment::PersonalAccount);
    assert_eq!(
        auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID).as_deref(),
        Some("sk-3")
    );
    // The stored document carries the TS wire shape: the personal
    // account persists `primeTeam: null` (TS writes the key
    // explicitly), never an omitted field.
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
    // Without a stored credential the selection is a no-op.
    auth.set_prime_inference_team_selection(Some(team("1", "Team 1")), None);
    assert_eq!(auth.get_all().get(PRIME_INFERENCE_PROVIDER_ID), None);
    // With the key it rebinds the team; the key must match when the
    // caller pins it.
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
    // A non-api-key credential is never rebound.
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

/// A backend that serves reads but fails every write (the locked
/// write erroring before the reload, storage.rs's failure arm).
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
    // TS: `setPrimeInferenceApiKey` throws before
    // `clearStaleAuthSource`, so a failed replacement never re-enables
    // the server-rejected credential.
    let mut auth = AuthStorage::from_storage(
        Arc::new(WriteFailingBackend(std::sync::Mutex::new(Some(
            r#"{"prime-inference": {"type": "api_key", "key": "sk-rejected"}}"#.to_string(),
        )))),
        Arc::new(NoOAuth),
    );
    // The scripted empty env keeps the stored credential the active
    // source (an ambient PRIME_API_KEY would outrank it for
    // prime-inference and change what `mark_auth_stale` marks).
    auth.env_credentials = Arc::new(ScriptedEnv(HashMap::new()));
    assert!(auth.mark_auth_stale(PRIME_INFERENCE_PROVIDER_ID));
    auth.set_prime_inference_api_key("sk-new", PrimeTeamAssignment::PersonalAccount);
    assert!(
        !auth.drain_errors().is_empty(),
        "the failed write surfaces its error"
    );
    // The rejected credential stays stale: the failed replacement
    // did not re-enable it.
    assert_eq!(
        auth.get_auth_status(PRIME_INFERENCE_PROVIDER_ID).source,
        Some(AuthSource::Stale)
    );
    assert_eq!(auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID), None);
}

#[test]
fn prime_inference_team_selection_reads_follow_the_ts_tri_state() {
    // No credential: no selection.
    let auth = storage_with(&serde_json::json!({}));
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::NotSelected
    );
    // A stored team selection reads back.
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
    // A stored personal account reads back.
    let auth = storage_with(&serde_json::json!({
        "prime-inference": {
            "type": "api_key", "key": "pi-key", "primeTeam": null
        }
    }));
    assert_eq!(
        auth.get_prime_inference_team_selection(),
        StoredPrimeTeam::PersonalAccount
    );
    // PRIME_TEAM_ID hides the stored selection (the env pin owns the
    // team).
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
    // An environment key (the active source for prime-inference) does
    // NOT hide the stored selection: the stored primeTeam survives the
    // override (fleet P5, the dogfood daemon posture — no PRIME_TEAM_ID
    // pin needed).
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
    // A runtime override (the active source) does not hide it either.
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

/// A scripted OAuth integration for the refresh-flow tests: counts
/// refresh calls, optionally delays inside the fetch, and serves a
/// fixed fresh credential.
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
    // The fetch runs outside every lock: a locked writer lands
    // mid-fetch, and the write phase keeps the peer's fresher
    // credential instead of overwriting it with this attempt's own
    // fetched token.
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

#[test]
fn a_second_refresh_joins_the_first_flight_instead_of_fetching_again() {
    // Two resolutions of the same expired provider race: the flight
    // gate serializes them, and the second serves the first's fresh
    // credential without spending its own token fetch.
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
