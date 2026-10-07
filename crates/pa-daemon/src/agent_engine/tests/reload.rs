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
    engine.reload_live_inputs();
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

/// With nothing stored for the live model the reload keeps the slot
/// untouched (a models.json lost mid-session loses nothing) — the MCP
/// re-read alone still runs.
#[test]
fn reload_with_nothing_stored_keeps_the_target() {
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
    engine.reload_live_inputs();
    let target = engine
        .provider_target
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .expect("the target stays");
    assert_eq!(
        target.api_key.as_deref(),
        Some("stale-access"),
        "an unresolvable model leaves the target untouched"
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
    engine.reload_live_inputs();
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
    engine.reload_live_inputs();
    assert!(
        engine
            .provider_target
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_none(),
        "the reload never installs a target"
    );
}

/// A routed image episode re-applies its armed target on every model-turn
/// attempt (overflow retries, failover restores): the reload must refresh
/// the armed route's auth too, or the next attempt reinstalls the stale
/// credentials a re-login just replaced.
#[test]
fn reload_refreshes_the_armed_image_route_target_auth() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_two_model_provider(&agent_dir);
    write_oauth_credential(&agent_dir, "fresh-access");
    let engine = credential_backed_engine(dir.path());
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
                api_key: Some("stale-access".to_string()),
                model: routed,
                headers: None,
            },
            agent_override: pa_agent::agent::AgentModelOverride {
                model: override_model,
                thinking_level: pa_agent::types::ThinkingLevel::default(),
            },
            // The saved session target a failing route clear restores: it
            // carries the pre-login key and must re-bind with the rest.
            session_target: Some(ProviderTarget {
                service_tier: None,
                api_key: Some("stale-session-access".to_string()),
                model: session_model,
                headers: None,
            }),
        });
    engine.reload_live_inputs();
    let armed = engine
        .image_route
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .expect("the reload keeps the armed route");
    assert_eq!(
        armed.target.model.id, "mock-vision",
        "the armed route keeps its routed model"
    );
    assert_eq!(
        armed.target.api_key.as_deref(),
        Some("fresh-access"),
        "the armed route's request auth rebinds from the store"
    );
    let saved = armed
        .session_target
        .as_ref()
        .expect("the saved session target stays");
    assert_eq!(
        saved.api_key.as_deref(),
        Some("fresh-access"),
        "the saved session target's request auth rebinds from the store"
    );
}

/// A failover's primary restore re-resolves the request auth from the
/// store: a credential rotated (and reloaded) during the failover serves
/// from the store, never the pre-failover capture; the capture only backs
/// a resolution that yields nothing.
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

    // A provider with nothing configured anywhere: the capture backs the
    // restore, not an empty key.
    let ghost: pa_types::ai::Model =
        pa_core::session_engine::provider_adapter::json_round_trip(&serde_json::json!({
            "id": "ghost-1",
            "name": "Ghost 1",
            "api": "openai-completions",
            "provider": "ghost",
            "baseUrl": "http://127.0.0.1:9",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128_000,
            "maxTokens": 4096,
        }))
        .expect("the ghost model converts");
    let restored = engine.restored_primary_target(&ghost, Some("stale-capture".to_string()), None);
    assert_eq!(
        restored.api_key.as_deref(),
        Some("stale-capture"),
        "a resolution that yields nothing falls back to the capture"
    );
}
