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
) -> std::sync::Arc<AgentSessionEngine> {
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.to_path_buf(),
        agent_dir: dir.join("agent"),
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
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
    let engine = live_auth_engine(dir.path(), None);
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
    let engine = live_auth_engine(dir.path(), Some("sk-override"));
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
    let engine = live_auth_engine(dir.path(), None);
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
    let engine = live_auth_engine(dir.path(), None);
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
