//! The live request-auth seam: the built session's stream re-resolves
//! request auth from the credential store on every provider call (the TS
//! streamFn's per-call `getApiKeyAndHeaders`), so a credential rotated by
//! another process (`/login`) or refreshed at expiry serves the live
//! session's next request without a restart.
use std::sync::Arc;

use pa_agent::stream::{LlmContext, StreamFn, StreamRequestOptions};
use pa_agent::types::Model as AgentModel;

use super::*;

/// A custom provider whose configured key is a placeholder: the stored
/// OAuth credential wins over it, so the request auth follows the store.
fn write_credential_backed_faux_provider(agent_dir: &std::path::Path) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "battery": {
                    "api": "faux", "baseUrl": "http://localhost:0", "apiKey": "sk-config-fallback",
                    "models": [{
                        "id": "mock-1", "name": "Mock 1",
                        "contextWindow": 128_000, "maxTokens": 16384,
                    }],
                }
            }
        })
        .to_string(),
    )
    .unwrap();
}

/// One stored OAuth credential for the custom provider, the shape `/login`
/// writes from another process.
fn write_oauth_credential(agent_dir: &std::path::Path, access: &str) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("auth.json"),
        json!({
            "battery": { "type": "oauth", "access": access, "refresh": "r",
                "expires": 4_102_444_800_000i64 }
        })
        .to_string(),
    )
    .unwrap();
}

fn live_auth_engine(
    dir: &std::path::Path,
    api_key: Option<&str>,
    provider: &str,
    model_id: &str,
) -> std::sync::Arc<AgentSessionEngine> {
    live_auth_engine_with_oauth(dir, api_key, provider, model_id, None)
}

/// [`live_auth_engine`] with a scripted request-auth OAuth integration,
/// swapped in before the engine is shared (production sets it once at
/// construction; the per-call resolution reads it).
fn live_auth_engine_with_oauth(
    dir: &std::path::Path,
    api_key: Option<&str>,
    provider: &str,
    model_id: &str,
    request_auth_oauth: Option<std::sync::Arc<dyn pa_core::auth::OAuthIntegration>>,
) -> std::sync::Arc<AgentSessionEngine> {
    let mut engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.to_path_buf(),
        agent_dir: dir.join("agent"),
        provider: Some(provider.to_string()),
        model: Some(model_id.to_string()),
        api_key: api_key.map(str::to_string),
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .expect("engine");
    if let Some(oauth) = request_auth_oauth {
        engine.request_auth_oauth = oauth;
    }
    let engine = Arc::new(engine);
    // The worker registers the engine's own arc: the live-auth resolver
    // upgrades it per provider call.
    engine.register_arc();
    engine
}

/// One registered faux provider serving `api: "faux"`, recording every
/// request's api key.
fn register_recording_faux() -> pa_ai::faux::FauxProviderRegistration {
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            api: Some("faux".to_string()),
            ..Default::default()
        });
    registration.set_repeat_last_response(true);
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
        pa_ai::faux::faux_assistant_text_message(
            "ok",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ),
    )]);
    registration
}

/// Drive one provider call through the built session's stream.
fn call_stream_once(engine: &AgentSessionEngine, stream_fn: &StreamFn) {
    engine.runtime.block_on(async {
        let mut stream = stream_fn(
            AgentModel::unknown(),
            LlmContext::default(),
            StreamRequestOptions::default(),
        )
        .await
        .expect("the stream call succeeds");
        stream.result().await.expect("the stream settles");
    });
}

/// The api keys the faux provider served, in order.
fn served_keys(registration: &pa_ai::faux::FauxProviderRegistration) -> Vec<Option<String>> {
    registration.received_api_keys()
}

/// The reported scenario at the seam: a fresh credential another process
/// wrote (`/login`) reaches the LIVE session's next provider call — no
/// restart, no `/reload`, no rebuild.
#[test]
fn the_built_sessions_stream_picks_up_an_external_reauth_per_call() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_faux_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "stale-access");
    let registration = register_recording_faux();
    let engine = live_auth_engine(dir.path(), None, "battery", "mock-1");
    let model = engine.resolve_model().expect("the custom model resolves");
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();

    // The build-time resolution: the stored credential serves.
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        served_keys(&registration).last(),
        Some(&Some("stale-access".to_string())),
        "the build-time credential serves the first call"
    );

    // A `/login` from ANOTHER process replaces the stored credential.
    write_oauth_credential(&agent_dir, "fresh-access");
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        served_keys(&registration).last(),
        Some(&Some("fresh-access".to_string())),
        "the fresh credential serves the very next provider call, live"
    );
    registration.unregister();
}

/// The create-config key override never store-swaps: a session created with
/// an explicit config key keeps serving it across store changes.
#[test]
fn the_create_config_key_override_never_store_swaps() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_faux_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "stored-access");
    let registration = register_recording_faux();
    let engine = live_auth_engine(dir.path(), Some("sk-override"), "battery", "mock-1");
    let model = engine.resolve_model().expect("the custom model resolves");
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();

    call_stream_once(&engine, &stream_fn);
    // The store changes underneath the session: the override key stands.
    write_oauth_credential(&agent_dir, "fresh-access");
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        served_keys(&registration),
        vec![
            Some("sk-override".to_string()),
            Some("sk-override".to_string())
        ],
        "the create-config key override never swaps to a store credential"
    );
    registration.unregister();
}

/// A store that stops serving (a logout empties the credential) keeps the
/// captured pair: the configured `models.json` fallback key is not a
/// credential and never replaces a serving pair.
#[test]
fn a_logout_keeps_the_captured_pair_off_the_fallback_key() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_faux_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "stale-access");
    let registration = register_recording_faux();
    let engine = live_auth_engine(dir.path(), None, "battery", "mock-1");
    let model = engine.resolve_model().expect("the custom model resolves");
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();

    call_stream_once(&engine, &stream_fn);
    // A logout from another process empties the store.
    std::fs::write(agent_dir.join("auth.json"), "{}").unwrap();
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        served_keys(&registration),
        vec![
            Some("stale-access".to_string()),
            Some("stale-access".to_string())
        ],
        "the captured pair stands; the models.json fallback key never serves"
    );
    registration.unregister();
}

/// An expired OAuth credential whose refresh cannot serve (the dispatch for
/// a non-subscription provider has no token endpoint) falls to the captured
/// pair, never the configured fallback key — the resolution reports no
/// live credential and the stream keeps last-good.
#[test]
fn an_expired_credential_keeps_the_captured_pair() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_faux_provider(&agent_dir);
    let registration = register_recording_faux();
    // The session builds against the live credential...
    write_oauth_credential(&agent_dir, "live-access");
    let engine = live_auth_engine(dir.path(), None, "battery", "mock-1");
    let model = engine.resolve_model().expect("the custom model resolves");
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        served_keys(&registration).last(),
        Some(&Some("live-access".to_string()))
    );
    // ...then the credential expires (and this provider has no refresh
    // endpoint, so the resolution cannot serve anything fresh).
    let expired = json!({
        "battery": { "type": "oauth", "access": "expired-access", "refresh": "r", "expires": 1 }
    });
    std::fs::write(
        agent_dir.join("auth.json"),
        serde_json::to_string_pretty(&expired).unwrap(),
    )
    .unwrap();
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        served_keys(&registration).last(),
        Some(&Some("live-access".to_string())),
        "the captured pair stands when the store's credential expires without a refresh path"
    );
    registration.unregister();
}

/// An expired stored OAuth credential, the shape an expiring token leaves
/// in the store: the refresh machinery's input.
fn write_expired_oauth_credential(agent_dir: &std::path::Path, access: &str) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("auth.json"),
        json!({
            "battery": { "type": "oauth", "access": access, "refresh": "r", "expires": 1 }
        })
        .to_string(),
    )
    .unwrap();
}

/// A scripted OAuth integration counting refresh attempts: each refresh
/// serves a fresh credential (or fails, per `succeeds`).
struct CountingRefresh {
    attempts: Arc<std::sync::Mutex<usize>>,
    succeeds: bool,
}

impl pa_core::auth::OAuthIntegration for CountingRefresh {
    fn api_key_for(
        &self,
        _provider: &str,
        credential: &pa_core::auth::AuthCredential,
    ) -> Option<String> {
        match credential {
            pa_core::auth::AuthCredential::Oauth { access, .. } => Some(access.clone()),
            _ => None,
        }
    }

    fn refresh(
        &self,
        _provider: &str,
        _credentials: &pa_core::auth::AuthStorageData,
    ) -> Option<pa_core::auth::AuthCredential> {
        *self.attempts.lock().unwrap() += 1;
        self.succeeds.then(|| pa_core::auth::AuthCredential::Oauth {
            access: "refreshed-access".to_string(),
            refresh: Some("rotated-refresh".to_string()),
            expires: 4_102_444_800_000,
            account_id: None,
            enterprise_url: None,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
            audience_mode: None,
        })
    }
}

/// An expired credential refreshes through the engine's request-auth
/// resolution and the refreshed token serves the LIVE session's next
/// provider call (no restart): the resolution's OAuth integration is the
/// refresh path, and the refreshed credential lands in the store so a
/// later call serves it without another refresh.
#[test]
fn an_expired_credential_refreshes_and_serves_the_live_session() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_faux_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "live-access");
    let registration = register_recording_faux();
    let attempts = Arc::new(std::sync::Mutex::new(0));
    let engine = live_auth_engine_with_oauth(
        dir.path(),
        None,
        "battery",
        "mock-1",
        Some(Arc::new(CountingRefresh {
            attempts: Arc::clone(&attempts),
            succeeds: true,
        })),
    );
    let model = engine.resolve_model().expect("the custom model resolves");
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        served_keys(&registration).last(),
        Some(&Some("live-access".to_string())),
        "the build-time credential serves the first call"
    );
    assert_eq!(
        *attempts.lock().unwrap(),
        0,
        "a live credential does not refresh"
    );

    // The credential expires: the next provider call refreshes it at the
    // token endpoint and serves the fresh token, live.
    write_expired_oauth_credential(&agent_dir, "expired-access");
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        served_keys(&registration).last(),
        Some(&Some("refreshed-access".to_string())),
        "the refreshed token serves the live session's next call"
    );
    assert_eq!(*attempts.lock().unwrap(), 1, "one refresh attempt");
    // The refreshed credential landed in the store: a later call serves
    // it without another refresh.
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        served_keys(&registration).last(),
        Some(&Some("refreshed-access".to_string()))
    );
    assert_eq!(
        *attempts.lock().unwrap(),
        1,
        "the landed credential serves without another refresh"
    );
    registration.unregister();
}

/// A failed refresh makes exactly ONE attempt per resolution: the
/// resolution's single possibly-refreshing lookup never re-fetches a
/// token it just failed to refresh, and the captured pair stands.
#[test]
fn a_failed_refresh_makes_one_attempt_per_resolution() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_faux_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "live-access");
    let registration = register_recording_faux();
    let attempts = Arc::new(std::sync::Mutex::new(0));
    let engine = live_auth_engine_with_oauth(
        dir.path(),
        None,
        "battery",
        "mock-1",
        Some(Arc::new(CountingRefresh {
            attempts: Arc::clone(&attempts),
            succeeds: false,
        })),
    );
    let model = engine.resolve_model().expect("the custom model resolves");
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();
    for call in 1..=2u32 {
        write_expired_oauth_credential(&agent_dir, "expired-access");
        call_stream_once(&engine, &stream_fn);
        assert_eq!(
            served_keys(&registration).last(),
            Some(&Some("live-access".to_string())),
            "the captured pair stands while the refresh fails"
        );
        assert_eq!(
            *attempts.lock().unwrap(),
            usize::try_from(call).expect("small"),
            "exactly one refresh attempt per resolution"
        );
    }
    registration.unregister();
}

/// Runs of a counting `!command` (one line appended per execution).
fn command_runs(counter: &std::path::Path) -> usize {
    std::fs::read_to_string(counter).map_or(0, |text| text.lines().count())
}

/// A stored `!command` api key for the serving provider resolves once at
/// build and never per provider call: candidate building defers the
/// command (TS's lazy value material), the per-call request-auth registry
/// never resolves the unrelated Prime Inference credential, and the
/// per-call lookup hits the process cache. The counter key is a
/// POSIX-shell pipeline (the ambient shell on Windows resolves it
/// differently), so the test runs on Unix only.
#[cfg(unix)]
#[test]
fn a_stored_command_key_resolves_once_at_build_and_never_per_call() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_faux_provider(&agent_dir);
    let counter = dir.path().join("battery-command-runs");
    let key = format!("!echo run >> {} ; echo cmd-key", counter.display());
    std::fs::write(
        agent_dir.join("auth.json"),
        json!({ "battery": { "type": "api_key", "key": key } }).to_string(),
    )
    .unwrap();
    let registration = register_recording_faux();
    let engine = live_auth_engine(dir.path(), None, "battery", "mock-1");
    let model = engine.resolve_model().expect("the custom model resolves");
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();
    let after_build = command_runs(&counter);
    for _ in 0..5 {
        let before = command_runs(&counter);
        call_stream_once(&engine, &stream_fn);
        assert_eq!(
            command_runs(&counter) - before,
            0,
            "a provider call must not re-run the stored credential command"
        );
        assert_eq!(
            served_keys(&registration).last(),
            Some(&Some("cmd-key".to_string()))
        );
    }
    assert!(after_build >= 1, "the build resolved the command once");
    registration.unregister();
}

/// A stored Prime Inference `!command` key never runs for ANOTHER
/// provider's provider call: the per-call request-auth registry
/// construction skips the unrelated Prime credential entirely, and its
/// candidate building defers command-backed fingerprints. The counter key
/// is a POSIX-shell pipeline (the ambient shell on Windows resolves it
/// differently), so the test runs on Unix only.
#[cfg(unix)]
#[test]
fn a_prime_command_key_never_runs_for_another_providers_call() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_faux_provider(&agent_dir);
    let counter = dir.path().join("prime-command-runs");
    let key = format!("!echo run >> {} ; echo prime-key", counter.display());
    std::fs::write(
        agent_dir.join("auth.json"),
        json!({
            "battery": { "type": "oauth", "access": "battery-access", "refresh": "r",
                "expires": 4_102_444_800_000i64 },
            "prime-inference": { "type": "api_key", "key": key }
        })
        .to_string(),
    )
    .unwrap();
    let registration = register_recording_faux();
    let engine = live_auth_engine(dir.path(), None, "battery", "mock-1");
    let model = engine.resolve_model().expect("the custom model resolves");
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();
    for _ in 0..5 {
        let before = command_runs(&counter);
        call_stream_once(&engine, &stream_fn);
        assert_eq!(
            command_runs(&counter) - before,
            0,
            "a battery provider call must not run the Prime Inference credential command"
        );
        assert_eq!(
            served_keys(&registration).last(),
            Some(&Some("battery-access".to_string()))
        );
    }
    registration.unregister();
}

/// A stored Prime Inference `!command` key whose command FAILS never runs
/// for another provider's provider call: a failed command is retried on
/// every lookup (never cached), so the per-call request-auth resolution
/// must not resolve the unrelated Prime credential at all. The counter
/// key is a POSIX-shell pipeline (the ambient shell on Windows resolves
/// it differently), so the test runs on Unix only.
#[cfg(unix)]
#[test]
fn a_failed_prime_command_key_never_runs_for_another_providers_call() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_faux_provider(&agent_dir);
    let counter = dir.path().join("failed-prime-command-runs");
    let key = format!("!echo run >> {} ; exit 1", counter.display());
    std::fs::write(
        agent_dir.join("auth.json"),
        json!({
            "battery": { "type": "oauth", "access": "battery-access", "refresh": "r",
                "expires": 4_102_444_800_000i64 },
            "prime-inference": { "type": "api_key", "key": key }
        })
        .to_string(),
    )
    .unwrap();
    let registration = register_recording_faux();
    let engine = live_auth_engine(dir.path(), None, "battery", "mock-1");
    let model = engine.resolve_model().expect("the custom model resolves");
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();
    for _ in 0..3 {
        let before = command_runs(&counter);
        call_stream_once(&engine, &stream_fn);
        assert_eq!(
            command_runs(&counter) - before,
            0,
            "a battery provider call must not run the failed Prime Inference credential command"
        );
        assert_eq!(
            served_keys(&registration).last(),
            Some(&Some("battery-access".to_string()))
        );
    }
    registration.unregister();
}

/// A stored `!command` api key for the serving provider whose command
/// FAILS resolves EXACTLY ONCE per provider call — the resolution
/// attempt — and never again through the candidate's deferred
/// fingerprint for a source token it cannot produce: a failed command
/// retries per lookup (TS #2497), not twice per lookup. The resolution
/// serves no live credential, so the captured pair stands. The counter
/// key is a POSIX-shell pipeline (the ambient shell on Windows resolves
/// it differently), so the test runs on Unix only.
#[cfg(unix)]
#[test]
fn a_failed_serving_command_key_resolves_once_per_call() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_faux_provider(&agent_dir);
    let counter = dir.path().join("failed-serving-command-runs");
    let key = format!("!echo run >> {} ; exit 1", counter.display());
    std::fs::write(
        agent_dir.join("auth.json"),
        json!({ "battery": { "type": "api_key", "key": key } }).to_string(),
    )
    .unwrap();
    let registration = register_recording_faux();
    let engine = live_auth_engine(dir.path(), None, "battery", "mock-1");
    let model = engine.resolve_model().expect("the custom model resolves");
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();
    for _ in 0..3 {
        let before = command_runs(&counter);
        call_stream_once(&engine, &stream_fn);
        assert_eq!(
            command_runs(&counter) - before,
            1,
            "a failed serving command resolves exactly once per provider call (the attempt, never a second source-token run)"
        );
        assert_eq!(
            served_keys(&registration).last(),
            Some(&Some("sk-config-fallback".to_string())),
            "the resolution serves no live credential; the captured pair stands"
        );
    }
    registration.unregister();
}

/// One served (model, api, base-url, key) tuple per adapted provider
/// call.
type ServedAdapted = (String, String, String, Option<String>);

/// A custom `xai` provider whose model rides the faux API: the registry
/// adapts it onto `openai-responses` once a stored xAI OAuth credential
/// serves, and the live session's next provider call carries the ADAPTED
/// request model (TS `requestModel`) together with the credential.
#[test]
fn a_mid_session_xai_login_switches_the_request_model_live() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "xai": {
                    "api": "faux", "baseUrl": "http://localhost:0",
                    "apiKey": "sk-config-fallback",
                    "models": [{
                        "id": "grok-test", "name": "Grok Test",
                        "contextWindow": 128_000, "maxTokens": 16384,
                    }],
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    // The pre-login calls land on the faux API; the adapted calls land on
    // the openai-responses API (the shadow registration proves the live
    // session really switched, without any network). The built-ins
    // register first: a shadow registered before the process's first
    // dispatch would be replaced by `resolve_provider`'s one-time
    // `ensure_builtins`.
    pa_ai::registry::ensure_builtins();
    let pre_login = register_recording_faux();
    let adapted: Arc<std::sync::Mutex<Vec<ServedAdapted>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = Arc::clone(&adapted);
    let adapted_registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            api: Some("openai-responses".to_string()),
            ..Default::default()
        });
    adapted_registration.set_repeat_last_response(true);
    adapted_registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(Arc::new(
        move |_, options, _, model| {
            captured.lock().unwrap().push((
                model.id.clone(),
                model.api.clone(),
                model.base_url.clone(),
                options.and_then(|options| options.api_key.clone()),
            ));
            Ok(pa_ai::faux::faux_assistant_text_message(
                "ok",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ))
        },
    ))]);
    let engine = live_auth_engine(dir.path(), None, "xai", "grok-test");
    let model = engine.resolve_model().expect("the custom model resolves");
    assert_eq!(model.api, "faux", "the session builds on the API-key shape");
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        pre_login.received_api_keys().last(),
        Some(&Some("sk-config-fallback".to_string())),
        "the build-time shape serves via the faux API"
    );
    assert!(adapted.lock().unwrap().is_empty());

    // The login (from another process) lands a stored xAI OAuth
    // credential: the next provider call adopts the subscription-shaped
    // request model together with the credential.
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("auth.json"),
        json!({
            "xai": { "type": "oauth", "access": "grok-access", "refresh": "r",
                "expires": 4_102_444_800_000i64 }
        })
        .to_string(),
    )
    .unwrap();
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        *adapted.lock().unwrap(),
        vec![(
            "grok-test".to_string(),
            "openai-responses".to_string(),
            "https://api.x.ai/v1".to_string(),
            Some("grok-access".to_string()),
        )],
        "the live session's next call carried the adapted request model and credential"
    );

    // A logout (from another process) empties the store: the captured key
    // and request model stay — the session keeps serving on the shape it
    // was built with, never the configured fallback shape.
    std::fs::write(agent_dir.join("auth.json"), "{}").unwrap();
    call_stream_once(&engine, &stream_fn);
    assert_eq!(
        adapted.lock().unwrap().len(),
        1,
        "no further call rides the adapted registration"
    );
    assert_eq!(
        pre_login.received_api_keys().last(),
        Some(&Some("sk-config-fallback".to_string())),
        "the captured request model keeps serving the build-time shape"
    );
    pre_login.unregister();
    adapted_registration.unregister();
    // Restore the built-in the shadowed registration replaced.
    pa_ai::registry::register_builtin_api_providers();
}

/// A logout after a subscription build keeps the captured pair AND the
/// captured request model: the session built on the stored xAI
/// subscription keeps streaming the subscription shape with the
/// subscription token when the store stops serving — the resolution's
/// API-key-shaped request model (the registry computes it for xAI even
/// when no credential serves) never reaches the captured pair, and the
/// captured subscription token never rides the API-key shape.
#[test]
fn a_mid_session_xai_logout_keeps_the_captured_request_model() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "xai": {
                    "api": "faux", "baseUrl": "http://localhost:0",
                    "apiKey": "sk-config-fallback",
                    "models": [{
                        "id": "grok-test", "name": "Grok Test",
                        "contextWindow": 128_000, "maxTokens": 16384,
                    }],
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    // The subscription is in the store at build time, so the session
    // builds on the subscription shape with the subscription token.
    std::fs::write(
        agent_dir.join("auth.json"),
        json!({
            "xai": { "type": "oauth", "access": "grok-access", "refresh": "r",
                "expires": 4_102_444_800_000i64 }
        })
        .to_string(),
    )
    .unwrap();
    pa_ai::registry::ensure_builtins();
    let api_key_shape = register_recording_faux();
    let adapted: Arc<std::sync::Mutex<Vec<ServedAdapted>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = Arc::clone(&adapted);
    let adapted_registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            api: Some("openai-responses".to_string()),
            ..Default::default()
        });
    adapted_registration.set_repeat_last_response(true);
    adapted_registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(Arc::new(
        move |_, options, _, model| {
            captured.lock().unwrap().push((
                model.id.clone(),
                model.api.clone(),
                model.base_url.clone(),
                options.and_then(|options| options.api_key.clone()),
            ));
            Ok(pa_ai::faux::faux_assistant_text_message(
                "ok",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ))
        },
    ))]);
    let engine = live_auth_engine(dir.path(), None, "xai", "grok-test");
    let model = engine.resolve_model().expect("the custom model resolves");
    assert_eq!(
        model.api, "openai-responses",
        "the session builds on the subscription shape"
    );
    let agent = engine.session_agent(&model).expect("the session builds");
    let stream_fn = agent
        .stream_fn()
        .expect("the built session streams")
        .clone();
    call_stream_once(&engine, &stream_fn);
    // A logout from another process empties the store.
    std::fs::write(agent_dir.join("auth.json"), "{}").unwrap();
    call_stream_once(&engine, &stream_fn);
    let subscription_calls = adapted.lock().unwrap().clone();
    let api_key_shape_calls = api_key_shape.received_api_keys();
    api_key_shape.unregister();
    adapted_registration.unregister();
    // Restore the built-in the shadowed registration replaced.
    pa_ai::registry::register_builtin_api_providers();
    assert!(
        api_key_shape_calls.is_empty(),
        "a store that stops serving keeps the captured request model: {api_key_shape_calls:?}"
    );
    assert_eq!(
        subscription_calls.len(),
        2,
        "both calls ride the captured subscription shape: {subscription_calls:?}"
    );
    assert!(
        subscription_calls
            .iter()
            .all(|(_, _, _, key)| key.as_deref() == Some("grok-access")),
        "the captured subscription token stays on the subscription shape: {subscription_calls:?}"
    );
}
