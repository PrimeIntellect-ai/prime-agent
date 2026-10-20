//! `/reload`'s session half: the request auth rebinds from the credential
//! store, the store a `/login` from another process writes.
use super::*;
use pa_core::session_engine::provider_adapter::ProviderTarget;

/// A custom provider whose configured key is a placeholder: the stored
/// credential wins over it, so the request auth follows the store (the
/// re-login scenario the reload must cover).
fn write_credential_backed_provider(agent_dir: &std::path::Path) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-config-fallback",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096,
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
}

/// One stored OAuth credential for the custom provider.
fn write_oauth_credential(agent_dir: &std::path::Path, access: &str) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("auth.json"),
        serde_json::json!({
            "battery": {
                "type": "oauth",
                "access": access,
                "refresh": "r",
                "expires": 4_102_444_800_000i64,
            }
        })
        .to_string(),
    )
    .unwrap();
}

fn credential_backed_engine_with_override(
    dir: &std::path::Path,
    api_key: Option<&str>,
) -> AgentSessionEngine {
    AgentSessionEngine::new(AgentEngineConfig {
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
    .expect("engine")
}

fn credential_backed_engine(dir: &std::path::Path) -> AgentSessionEngine {
    AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.to_path_buf(),
        agent_dir: dir.join("agent"),
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .expect("engine")
}

/// A credential another process wrote (the `/login` scenario) reaches the
/// running session through the reload: the provider target rebinds.
#[test]
fn reload_rebinds_the_request_auth_from_the_credential_store() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "stale-access");
    let engine = credential_backed_engine(dir.path());
    let model = engine.resolve_model().expect("the custom model resolves");
    // The session's build-time target: the credential the engine saw.
    *engine
        .provider_target
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ProviderTarget {
        service_tier: None,
        api_key: Some("stale-access".to_string()),
        model,
        headers: None,
    });
    // A re-login from another process replaces the stored credential.
    write_oauth_credential(&agent_dir, "fresh-access");
    engine.reload_live_inputs().expect("the reload applies");
    let target = engine
        .provider_target
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .expect("the reload keeps the target set");
    assert_eq!(
        target.api_key.as_deref(),
        Some("fresh-access"),
        "the reload rebinds the request auth to the fresh stored credential"
    );
}

/// With nothing stored or configured for the live model the reload keeps
/// the slot's model but drops the key: the session serves what a fresh
/// resolution yields, which is nothing.
#[test]
fn reload_with_nothing_resolvable_drops_the_key() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let engine = credential_backed_engine(dir.path());
    assert!(
        engine.resolve_model().is_err(),
        "no models.json: nothing resolves"
    );
    let model: pa_types::ai::Model =
        pa_core::session_engine::provider_adapter::json_round_trip(&serde_json::json!({
            "id": "mock-1",
            "name": "Mock 1",
            "api": "openai-completions",
            "provider": "battery",
            "baseUrl": "http://127.0.0.1:9",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128_000,
            "maxTokens": 4096,
        }))
        .expect("the model converts");
    *engine
        .provider_target
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ProviderTarget {
        service_tier: None,
        api_key: Some("stale-access".to_string()),
        model,
        headers: None,
    });
    engine.reload_live_inputs().expect("the reload applies");
    let target = engine
        .provider_target
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .expect("the target stays");
    assert_eq!(target.model.id, "mock-1", "the reload keeps the model");
    assert!(
        target.api_key.is_none(),
        "a key nothing resolves any more stops serving"
    );
}

/// The two-model pair the retarget guard uses: the text model the
/// selection pins and a second model standing in for a routed episode's
/// serving target.
fn write_two_model_provider(agent_dir: &std::path::Path) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-config-fallback",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096,
                        },
                        {
                            "id": "mock-vision",
                            "name": "Mock Vision",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096,
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
}

/// The live model never retargets through a reload: a routed image
/// episode serves on its own target and an unflagged session must not
/// follow a changed settings default — only the request auth rebinds.
#[test]
fn reload_keeps_the_live_model_and_rebinds_its_auth() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_two_model_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "fresh-access");
    let engine = credential_backed_engine(dir.path());
    // The selection pins mock-1; the slot holds a routed episode's target
    // on a DIFFERENT model.
    let session_model = engine.resolve_model().expect("the pinned model resolves");
    assert_eq!(session_model.id, "mock-1");
    let routed: pa_types::ai::Model =
        pa_core::session_engine::provider_adapter::json_round_trip(&serde_json::json!({
            "id": "mock-vision",
            "name": "Mock Vision",
            "api": "openai-completions",
            "provider": "battery",
            "baseUrl": "http://127.0.0.1:9",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128_000,
            "maxTokens": 4096,
        }))
        .expect("the routed model converts");
    *engine
        .provider_target
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ProviderTarget {
        service_tier: None,
        api_key: Some("stale-access".to_string()),
        model: routed,
        headers: None,
    });
    engine.reload_live_inputs().expect("the reload applies");
    let target = engine
        .provider_target
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .expect("the reload keeps the target set");
    assert_eq!(
        target.model.id, "mock-vision",
        "the reload never retargets the live model"
    );
    assert_eq!(
        target.api_key.as_deref(),
        Some("fresh-access"),
        "the live model's request auth rebinds from the store"
    );
}

/// Before the session's first build there is no live target to refresh:
/// the reload installs nothing (the build binds its own target) — the MCP
/// re-read alone runs.
#[test]
fn reload_without_a_live_target_installs_nothing() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "fresh-access");
    let engine = credential_backed_engine(dir.path());
    engine.reload_live_inputs().expect("the reload applies");
    assert!(
        engine
            .provider_target
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_none(),
        "the reload never installs a target"
    );
}

/// Arms an image route on `mock-vision` whose target serves `route_key`
/// and whose saved session target (on the pinned `mock-1`) serves
/// `session_key`.
fn arm_image_route(engine: &AgentSessionEngine, route_key: &str, session_key: &str) {
    let session_model = engine.resolve_model().expect("the pinned model resolves");
    let routed: pa_types::ai::Model =
        pa_core::session_engine::provider_adapter::json_round_trip(&serde_json::json!({
            "id": "mock-vision",
            "name": "Mock Vision",
            "api": "openai-completions",
            "provider": "battery",
            "baseUrl": "http://127.0.0.1:9",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128_000,
            "maxTokens": 4096,
        }))
        .expect("the routed model converts");
    let override_model: pa_agent::types::Model =
        pa_core::session_engine::provider_adapter::json_round_trip(&routed)
            .expect("the override model converts");
    *engine
        .image_route
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some(crate::image_route::ImageRoute {
            target: ProviderTarget {
                service_tier: None,
                api_key: Some(route_key.to_string()),
                model: routed,
                headers: None,
            },
            agent_override: pa_agent::agent::AgentModelOverride {
                model: override_model,
                thinking_level: pa_agent::types::ThinkingLevel::default(),
            },
            session_target: Some(ProviderTarget {
                service_tier: None,
                api_key: Some(session_key.to_string()),
                model: session_model,
                headers: None,
            }),
        });
}

/// The armed route's target and its saved session target keys.
fn armed_route_keys(engine: &AgentSessionEngine) -> (Option<String>, Option<String>) {
    let route = engine
        .image_route
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .expect("the reload keeps the armed route");
    assert_eq!(
        route.target.model.id, "mock-vision",
        "the armed route keeps its routed model"
    );
    let saved = route
        .session_target
        .expect("the saved session target stays");
    (route.target.api_key, saved.api_key)
}

/// A routed image episode re-applies its armed target on every model-turn
/// attempt (overflow retries, failover restores): the reload must refresh
/// the armed route's auth too, or the next attempt reinstalls the stale
/// credentials a re-login just replaced. The saved session target a
/// failing route clear restores re-binds with the rest.
#[test]
fn reload_refreshes_the_armed_image_route_target_auth() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_two_model_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "fresh-access");
    let engine = credential_backed_engine(dir.path());
    arm_image_route(&engine, "stale-access", "stale-session-access");
    engine.reload_live_inputs().expect("the reload applies");
    let (route_key, session_key) = armed_route_keys(&engine);
    assert!(
        route_key.as_deref() == Some("fresh-access"),
        "the armed route's request auth rebinds from the store"
    );
    assert!(
        session_key.as_deref() == Some("fresh-access"),
        "the saved session target's request auth rebinds from the store"
    );
}

/// A logout during a routed image episode clears the removed key from the
/// armed route and its saved session target, so neither the next attempt
/// nor the route clear reinstalls it.
#[test]
fn reload_clears_a_removed_credential_from_the_armed_image_route() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_two_model_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "live-access");
    let engine = credential_backed_engine(dir.path());
    arm_image_route(&engine, "live-access", "live-access");
    std::fs::write(agent_dir.join("auth.json"), "{}").unwrap();
    engine.reload_live_inputs().expect("the reload applies");
    let (route_key, session_key) = armed_route_keys(&engine);
    assert!(
        route_key.as_deref() == Some("sk-config-fallback"),
        "the armed route stops serving the removed credential"
    );
    assert!(
        session_key.as_deref() == Some("sk-config-fallback"),
        "the saved session target stops serving the removed credential"
    );
}

/// A failover's primary restore re-resolves the request auth from the
/// store: a credential rotated or removed during the failover serves the
/// fresh resolution, never the pre-failover capture; the capture only
/// backs a failed store read.
#[test]
fn restored_primary_target_serves_the_store_auth() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "fresh-access");
    let engine = credential_backed_engine(dir.path());
    let primary = engine.resolve_model().expect("the primary resolves");
    let restored =
        engine.restored_primary_target(&primary, Some("stale-capture".to_string()), None);
    assert_eq!(
        restored.api_key.as_deref(),
        Some("fresh-access"),
        "the restored primary serves the stored credential"
    );
    assert_eq!(
        restored.model.id, primary.id,
        "the restore keeps the primary model"
    );

    // A logout during the episode: the healthy store serves the fresh
    // resolution (the configured key), never the captured removed key.
    std::fs::write(agent_dir.join("auth.json"), "{}").unwrap();
    let restored =
        engine.restored_primary_target(&primary, Some("stale-capture".to_string()), None);
    assert!(
        restored.api_key.as_deref() == Some("sk-config-fallback"),
        "a logout never restores the captured key"
    );

    // An unreadable store keeps the captured pair: the fresh resolution
    // would serve the configured fallback key off a failed read.
    std::fs::write(agent_dir.join("auth.json"), "not json").unwrap();
    let restored = engine.restored_primary_target(
        &primary,
        Some("captured-key".to_string()),
        Some(team_headers("captured-team")),
    );
    assert!(
        restored.api_key.as_deref() == Some("captured-key"),
        "a failed store read keeps the last-good captured key"
    );
    assert!(
        restored.headers.as_ref() == Some(&team_headers("captured-team")),
        "a failed store read keeps the last-good captured headers"
    );
}

/// A custom `prime-inference` provider: the one provider whose stored
/// credentials can carry request headers (the team header), so the
/// reload's header replacement is observable against a real resolution.
fn write_prime_inference_provider(agent_dir: &std::path::Path) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-config-fallback",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096,
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
}

/// One stored `prime-inference` API-key credential, with or without the
/// team header `get_provider_headers` derives from `primeTeam`.
fn write_prime_inference_credential(agent_dir: &std::path::Path, key: &str, team_id: Option<&str>) {
    std::fs::create_dir_all(agent_dir).unwrap();
    let mut credential = serde_json::json!({ "type": "api_key", "key": key });
    if let Some(team_id) = team_id {
        credential["primeTeam"] =
            serde_json::json!({ "teamId": team_id, "name": format!("Team {team_id}") });
    }
    std::fs::write(
        agent_dir.join("auth.json"),
        serde_json::json!({ "prime-inference": credential }).to_string(),
    )
    .unwrap();
}

fn team_headers(team_id: &str) -> std::collections::BTreeMap<String, String> {
    [("X-Prime-Team-ID".to_string(), team_id.to_string())]
        .into_iter()
        .collect()
}

fn prime_inference_backed_engine(dir: &std::path::Path) -> AgentSessionEngine {
    AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.to_path_buf(),
        agent_dir: dir.join("agent"),
        provider: Some("prime-inference".to_string()),
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .expect("engine")
}

/// A rotated credential REPLACES the request headers: a fresh key that
/// carries no team header must clear the previous credential's
/// `X-Prime-Team-ID`, never serve the stale team context on the new key.
#[test]
fn reload_clears_headers_when_the_fresh_credential_carries_none() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_inference_provider(&agent_dir);
    write_prime_inference_credential(&agent_dir, "team-key", Some("team-1"));
    let engine = prime_inference_backed_engine(dir.path());
    let model = engine.resolve_model().expect("the custom model resolves");
    // The session's build-time target: the team credential the engine saw.
    *engine
        .provider_target
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ProviderTarget {
        service_tier: None,
        api_key: Some("team-key".to_string()),
        model,
        headers: Some(team_headers("team-1")),
    });
    // A re-login without the team replaces the stored credential.
    write_prime_inference_credential(&agent_dir, "solo-key", None);
    engine.reload_live_inputs().expect("the reload applies");
    let target = engine
        .provider_target
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .expect("the reload keeps the target set");
    // The resolved credential never formats into a failure message: an
    // api key is sensitive data (CodeQL's cleartext-logging rule), so the
    // assertion compares without the assert_eq! formatting sink.
    assert!(
        target.api_key.as_deref() == Some("solo-key"),
        "the reload rebinds the request auth to the fresh stored credential"
    );
    assert!(
        target.headers.is_none(),
        "the fresh credential clears the stale team header"
    );
}

/// A failover's primary restore serves the resolved pair, never the
/// resolved key paired with the captured headers: a credential rotated
/// during the failover carries its own (empty) headers, clearing the
/// captured `X-Prime-Team-ID` the pre-failover credential pinned.
#[test]
fn restored_primary_target_serves_the_resolved_header_pair() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_inference_provider(&agent_dir);
    write_prime_inference_credential(&agent_dir, "solo-key", None);
    let engine = prime_inference_backed_engine(dir.path());
    let primary = engine.resolve_model().expect("the primary resolves");
    let restored = engine.restored_primary_target(
        &primary,
        Some("captured-key".to_string()),
        Some(team_headers("old-team")),
    );
    // The resolved credential never formats into a failure message: an
    // api key is sensitive data (CodeQL's cleartext-logging rule), so the
    // assertion compares without the assert_eq! formatting sink.
    assert!(
        restored.api_key.as_deref() == Some("solo-key"),
        "the restored primary serves the stored credential"
    );
    assert!(
        restored.headers.is_none(),
        "the resolved pair replaces the captured headers"
    );
}

/// A reload over a malformed auth store reports the failure: the store
/// cannot be parsed, so the MCP manager keeps its previous credentials
/// and the reload answers with the storage error instead of a success
/// the session did not apply.
#[test]
fn reload_reports_the_auth_store_failure() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "stale-access");
    let engine = credential_backed_engine(dir.path());
    let model = engine.resolve_model().expect("the custom model resolves");
    *engine
        .provider_target
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ProviderTarget {
        service_tier: None,
        api_key: Some("stale-access".to_string()),
        model,
        headers: None,
    });
    // Another process corrupts the store: the reload's re-read fails.
    std::fs::write(agent_dir.join("auth.json"), "not json").unwrap();
    let error = engine
        .reload_live_inputs()
        .expect_err("the malformed store fails the reload");
    assert!(!error.is_empty(), "the reload surfaces the storage error");
    // The failed reload never touched the target: the store gate ran
    // before any rebind, so the session keeps its last-good request auth
    // instead of falling to the provider's configured fallback key.
    let target = engine
        .provider_target
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .expect("the failed reload keeps the target set");
    assert!(
        target.api_key.as_deref() == Some("stale-access"),
        "a failed reload preserves the last-good request auth"
    );
    // A repaired store reloads cleanly again.
    write_oauth_credential(&agent_dir, "fresh-access");
    engine
        .reload_live_inputs()
        .expect("the repaired store reloads");
    let target = engine
        .provider_target
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .expect("the reload keeps the target set");
    assert!(
        target.api_key.as_deref() == Some("fresh-access"),
        "the repaired store rebinds the request auth"
    );
}

/// A create-config key override stands in memory regardless of the store:
/// when the store read fails, the restore keeps the override key and the
/// captured headers (the last-good team context), never the header-less
/// resolution the broken store produced.
#[test]
fn restored_primary_target_keeps_the_override_key_and_captured_headers_off_a_failed_store() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "stored-key");
    let engine = credential_backed_engine_with_override(dir.path(), Some("override-key"));
    let primary = engine.resolve_model().expect("the primary resolves");
    // The store becomes unreadable mid-failover.
    std::fs::write(agent_dir.join("auth.json"), "not json").unwrap();
    let restored = engine.restored_primary_target(
        &primary,
        Some("override-key".to_string()),
        Some(team_headers("team-1")),
    );
    assert!(
        restored.api_key.as_deref() == Some("override-key"),
        "the override key stands in memory off a failed store"
    );
    assert!(
        restored.headers.as_ref() == Some(&team_headers("team-1")),
        "a failed store read keeps the captured headers"
    );
    // A healthy store still resolves the override pair fresh.
    write_oauth_credential(&agent_dir, "stored-key");
    let restored = engine.restored_primary_target(
        &primary,
        Some("override-key".to_string()),
        Some(team_headers("team-1")),
    );
    assert!(
        restored.api_key.as_deref() == Some("override-key"),
        "the healthy restore keeps the override key"
    );
}

/// A healthy store that no longer holds the provider's credential (a
/// logout) stops serving the removed key: the target falls to what a fresh
/// resolution serves, here the configured models.json key.
#[test]
fn reload_stops_serving_a_credential_that_left_the_store() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "live-access");
    let engine = credential_backed_engine(dir.path());
    let model = engine.resolve_model().expect("the custom model resolves");
    *engine
        .provider_target
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ProviderTarget {
        service_tier: None,
        api_key: Some("live-access".to_string()),
        model,
        headers: None,
    });
    // Another process removes the credential: the store stays healthy,
    // but nothing is stored for the provider.
    std::fs::write(agent_dir.join("auth.json"), "{}").unwrap();
    engine.reload_live_inputs().expect("the reload applies");
    let target = engine
        .provider_target
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .expect("the reload keeps the target set");
    assert!(
        target.api_key.as_deref() == Some("sk-config-fallback"),
        "an empty store serves the configured key, not the removed credential"
    );
    // A re-login restores the credential and the rebind resumes.
    write_oauth_credential(&agent_dir, "fresh-access");
    engine.reload_live_inputs().expect("the reload applies");
    let target = engine
        .provider_target
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .expect("the reload keeps the target set");
    assert!(
        target.api_key.as_deref() == Some("fresh-access"),
        "a restored credential rebinds the request auth"
    );
}

/// A Prime login or logout notification rebinds an already-built target,
/// with the key and team header resolved together.
#[test]
fn prime_login_and_logout_rebind_the_live_target_and_team() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_inference_provider(&agent_dir);
    write_prime_inference_credential(&agent_dir, "previous-key", Some("previous-team"));
    let engine = prime_inference_backed_engine(dir.path());
    let model = engine.resolve_model().expect("custom prime model");
    *engine.provider_target.write().unwrap() = Some(ProviderTarget {
        service_tier: None,
        api_key: Some("previous-key".to_string()),
        model,
        headers: Some(team_headers("previous-team")),
    });
    write_prime_inference_credential(&agent_dir, "fresh-key", Some("fresh-team"));
    engine
        .apply_auth_changed("prime-inference")
        .expect("login applied");
    let target = engine.provider_target.read().unwrap().clone().unwrap();
    assert_eq!(target.api_key.as_deref(), Some("fresh-key"));
    assert_eq!(target.headers, Some(team_headers("fresh-team")));
    // A logout must not leave the removed key or team on the target. The
    // models.json key (or an ambient key) is what a fresh resolution serves.
    std::fs::write(agent_dir.join("auth.json"), "{}").unwrap();
    engine
        .apply_auth_changed("prime-inference")
        .expect("logout applied");
    let target = engine.provider_target.read().unwrap().clone().unwrap();
    let (fallback, headers) = engine.resolve_request_key_and_headers(&target.model);
    assert_eq!(target.api_key, fallback);
    assert_ne!(target.api_key.as_deref(), Some("fresh-key"));
    assert_eq!(target.headers, headers);
    assert_ne!(target.headers, Some(team_headers("fresh-team")));
}

#[test]
fn auth_changed_only_rebinds_matching_provider_targets() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_two_model_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "fresh-access");
    let engine = credential_backed_engine(dir.path());
    arm_image_route(&engine, "route-old", "session-old");
    let mut live = engine
        .image_route
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .target
        .clone();
    live.model.provider = "unrelated".to_string();
    live.api_key = Some("unrelated-key".to_string());
    *engine.provider_target.write().unwrap() = Some(live);
    engine.apply_auth_changed("battery").unwrap();
    assert_eq!(
        engine
            .provider_target
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .api_key
            .as_deref(),
        Some("unrelated-key")
    );
    let (route, saved) = armed_route_keys(&engine);
    assert_eq!(route.as_deref(), Some("fresh-access"));
    assert_eq!(saved.as_deref(), Some("fresh-access"));
}

#[test]
fn failed_per_target_auth_read_preserves_the_serving_pair() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "stored-key");
    let engine = credential_backed_engine(dir.path());
    let target = ProviderTarget {
        model: engine.resolve_model().unwrap(),
        api_key: Some("last-good".to_string()),
        headers: Some(std::collections::BTreeMap::from([(
            "X-Prime-Team-ID".to_string(),
            "last-team".to_string(),
        )])),
        service_tier: None,
    };
    // An earlier MCP read succeeded; the fresh per-target read must still be checked.
    engine.mcp.lock().unwrap().reload_auth_storage().unwrap();
    std::fs::write(agent_dir.join("auth.json"), "{broken").unwrap();
    *engine.provider_target.write().unwrap() = Some(target);
    assert!(engine.apply_auth_changed("battery").is_err());
    let slot = engine.provider_target.read().unwrap();
    let target = slot.as_ref().unwrap();
    assert_eq!(target.api_key.as_deref(), Some("last-good"));
    assert_eq!(
        target
            .headers
            .as_ref()
            .unwrap()
            .get("X-Prime-Team-ID")
            .map(String::as_str),
        Some("last-team")
    );
}

#[test]
fn auth_changed_preserves_an_unrelated_armed_route() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_two_model_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "fresh-access");
    let engine = credential_backed_engine(dir.path());
    arm_image_route(&engine, "unrelated-route", "saved-old");
    engine
        .image_route
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .target
        .model
        .provider = "unrelated".to_string();
    engine.apply_auth_changed("battery").unwrap();
    let (route, saved) = armed_route_keys(&engine);
    assert_eq!(route.as_deref(), Some("unrelated-route"));
    assert_eq!(saved.as_deref(), Some("fresh-access"));
}

#[test]
fn failed_route_auth_read_preserves_both_cached_targets() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_two_model_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "stored-key");
    let engine = credential_backed_engine(dir.path());
    arm_image_route(&engine, "route-good", "saved-good");
    engine.mcp.lock().unwrap().reload_auth_storage().unwrap();
    std::fs::write(agent_dir.join("auth.json"), "{broken").unwrap();
    assert!(engine.apply_auth_changed("battery").is_err());
    let (route, saved) = armed_route_keys(&engine);
    assert_eq!(route.as_deref(), Some("route-good"));
    assert_eq!(saved.as_deref(), Some("saved-good"));
}

#[test]
fn unrelated_auth_change_does_not_read_or_replace_live_credentials() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_credential_backed_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "stored-key");
    let engine = credential_backed_engine(dir.path());
    let target = ProviderTarget {
        model: engine.resolve_model().unwrap(),
        api_key: Some("last-good".to_string()),
        headers: None,
        service_tier: None,
    };
    *engine.provider_target.write().unwrap() = Some(target);
    std::fs::write(agent_dir.join("auth.json"), "{broken").unwrap();
    engine.apply_auth_changed("anthropic").unwrap();
    assert_eq!(
        engine
            .provider_target
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .api_key
            .as_deref(),
        Some("last-good")
    );
}
