//! The model-resolution tests (catalog, allowlist, restore/switch/configure, the thinking clamp).
use super::*;

/// A models.json custom provider (name has no env-key mapping), with an
/// apiKey the registry must resolve for request auth (the env-key map
/// alone cannot find it).
fn write_custom_provider_models_json(agent_dir: &std::path::Path, base_url: &str) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": base_url,
                    "apiKey": "sk-battery",
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

/// A models.json custom-provider pair for the thinking clamp: a
/// reasoning model (up to `high`) and a non-reasoning one (`off`).
fn write_thinking_pair_models_json(agent_dir: &std::path::Path, base_url: &str) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": base_url,
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-reason",
                            "name": "Mock Reasoning",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096,
                            "reasoning": true,
                        },
                        {
                            "id": "mock-plain",
                            "name": "Mock Plain",
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

#[test]
fn create_config_flags_reach_the_engine_model_resolution() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");

    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        // No process-level fallback: the wire flags must be the source.
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    engine.configure_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
    });
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "battery");
    assert_eq!(model.id, "mock-1");
    // The registry resolves the models.json apiKey (the provider name has
    // no env-key mapping), so the engine can authenticate without env.
    assert_eq!(
        engine.resolve_request_api_key(&model).as_deref(),
        Some("sk-battery")
    );
}

#[test]
fn settings_default_drives_unflagged_resolution() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    let mut settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
    settings
        .set_default_model_and_provider("battery", "mock-1")
        .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "battery");
    assert_eq!(model.id, "mock-1");
}

/// A scripted loopback HTTP server (the pa-core tests/common pattern,
/// in-crate): answers from a queue of raw responses and records every
/// request head. Nothing leaves loopback.
struct MockCatalogServer {
    port: u16,
    requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl MockCatalogServer {
    async fn start(responses: Vec<Vec<u8>>) -> Self {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock catalog server");
        let port = listener.local_addr().unwrap().port();
        let requests: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let queue = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from(
            responses,
        )));
        let request_log = std::sync::Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let requests = std::sync::Arc::clone(&request_log);
                let queue = std::sync::Arc::clone(&queue);
                tokio::spawn(async move {
                    let mut buffer = [0u8; 8_192];
                    let mut read = 0usize;
                    loop {
                        let Ok(n) = socket.read(&mut buffer[read..]).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        read += n;
                        if buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                        if read == buffer.len() {
                            break;
                        }
                    }
                    let head = String::from_utf8_lossy(&buffer[..read]).to_string();
                    requests.lock().unwrap().push(head);
                    let response = queue.lock().unwrap().pop_front().unwrap_or_else(|| {
                        b"HTTP/1.1 500 Drained\r\ncontent-length: 0\r\n\r\n".to_vec()
                    });
                    let _ = socket.write_all(&response).await;
                    let _ = socket.flush().await;
                });
            }
        });
        Self { port, requests }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }

    fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

fn catalog_ok_json(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// One auth.json with a Prime Inference key + team: the file auth the
/// engine's registry reads (the private-model lane's scope).
fn write_prime_auth(agent_dir: &std::path::Path) {
    std::fs::create_dir_all(agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("auth.json"),
        serde_json::json!({
            "prime-inference": {
                "type": "api_key",
                "key": "test-key",
                "primeTeam": { "teamId": "team-1", "name": "Test Team" }
            }
        })
        .to_string(),
    )
    .unwrap();
}

/// The Prime Inference `/models` payload: every compiled offline
/// entry (the coverage gate keeps thin fetches out) plus the private
/// `internal/glm-5.3-fast` the compiled fallback lacks.
fn pi_payload() -> String {
    let mut data: Vec<Value> = pa_models::transports::prime_inference_offline_entries()
        .iter()
        .map(|model| {
            serde_json::json!({
                "id": model.id,
                "display_name": model.name,
                "pricing": {
                    "input_usd_per_mtok": 1.0, "output_usd_per_mtok": 2.0
                },
                "specs": {
                    "context_window": model.context_window,
                    "max_output_tokens": model.max_tokens,
                    "supports_reasoning": model.reasoning,
                    "modalities": { "input": ["text"], "output": ["text"] },
                },
            })
        })
        .collect();
    data.push(serde_json::json!({
        "id": "internal/glm-5.3-fast",
        "display_name": "GLM 5.3 Fast (internal)",
        "pricing": { "input_usd_per_mtok": 0.42, "output_usd_per_mtok": 2.1 },
        "specs": {
            "context_window": 400_000, "max_output_tokens": 131_072,
            "supports_reasoning": true,
            "modalities": { "input": ["text"], "output": ["text"] },
        },
    }));
    serde_json::json!({ "data": data }).to_string()
}

/// Install a loopback catalog for `agent_dir` (both fetch layers point
/// at `server`; no bundled snapshot, so the compiled fallback is the
/// base and only the fetches add the private team model).
fn install_loopback_catalog(agent_dir: &std::path::Path, server: &MockCatalogServer) {
    let catalog = pa_models::ModelCatalog::with_urls(
        Some(agent_dir.join("models")),
        None,
        &server.url("/catalog"),
        &server.url("/api/v1"),
    );
    pa_core::models::install_catalog(&agent_dir.join("models.json"), std::sync::Arc::new(catalog));
}

/// A session file whose last `model_change` row pins the private team
/// model — what a revived worker reads at create.
fn session_file_pinning_private_model(dir: &std::path::Path) -> std::path::PathBuf {
    session_file_pinning_model(dir, "prime-inference", "internal/glm-5.3-fast")
}

/// A session file whose last `model_change` row pins the given model —
/// what a revived worker reads at create.
fn session_file_pinning_model(
    dir: &std::path::Path,
    provider: &str,
    model: &str,
) -> std::path::PathBuf {
    let mut session =
        crate::session_store::SessionFile::create(dir.to_str().unwrap_or("/tmp"), None, 0);
    let path = dir.join(crate::session_store::session_file_name(
        session.session_id(),
    ));
    session.set_path(path.clone()).unwrap();
    session.append_model_change(provider, model);
    session.rewrite().unwrap();
    path
}

fn restore_test_engine(
    dir: &std::path::Path,
    provider: Option<&str>,
    model: Option<&str>,
) -> AgentSessionEngine {
    AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.to_path_buf(),
        agent_dir: dir.join("agent"),
        provider: provider.map(str::to_string),
        model: model.map(str::to_string),
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

#[test]
fn the_startup_chain_refuses_models_outside_the_allowlist() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({ "allowedModels": ["anthropic/*"] }).to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
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
    .unwrap();
    let error = engine
        .resolve_registry_model()
        .expect_err("off-allowlist model refused");
    let refusal = error
        .downcast_ref::<pa_core::models::ModelAllowlistRefusal>()
        .expect("typed refusal");
    assert_eq!(refusal.selector, "battery/mock-1");
    assert!(
        error
            .to_string()
            .contains("blocked by the daemon model allowlist"),
        "{error}"
    );

    std::fs::write(
        engine.config.agent_dir.join("settings.json"),
        serde_json::json!({ "allowedModels": ["battery/*"] }).to_string(),
    )
    .unwrap();
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "battery");
    assert_eq!(model.id, "mock-1");
}

/// The create-config key override pins the KEY, never the headers: a
/// request target with an explicit key still ships the registry's
/// merged headers (Macroscope PR #2755: `switch_model` dropped the
/// stored provider headers whenever an override was configured).
#[tokio::test]
async fn an_api_key_override_keeps_the_merged_team_headers() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    let engine = restore_test_engine(dir.path(), Some("prime-inference"), None);
    engine.configure_model(EngineModelSelection {
        provider: None,
        model: None,
        api_key: Some("explicit-override".to_string()),
        thinking: None,
    });
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "prime-inference");
    let (api_key, headers) = engine.resolve_request_key_and_headers(&model);
    assert_eq!(api_key.as_deref(), Some("explicit-override"));
    let headers = headers.expect("the override keeps the merged headers");
    assert_eq!(
        headers.get("X-Prime-Team-ID").map(String::as_str),
        Some("team-1"),
        "an explicit key override never orphans the stored team"
    );
}

/// TS #2497: the auth storage is the single team-header owner. The
/// stored Prime team resolves as `X-Prime-Team-ID` on the request
/// auth — with the provider-side fallback deleted, these merged
/// headers keep the team on the wire.
#[tokio::test]
async fn request_auth_carries_the_stored_team_header() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    let engine = restore_test_engine(dir.path(), Some("prime-inference"), None);
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "prime-inference");
    let (api_key, headers) = engine.resolve_request_key_and_headers(&model);
    assert_eq!(api_key.as_deref(), Some("test-key"));
    let headers = headers.expect("merged request headers");
    assert_eq!(
        headers.get("X-Prime-Team-ID").map(String::as_str),
        Some("team-1"),
        "the stored team ships as the team header"
    );
}

/// The revival race this lane fixes (the 2026-09-23 05:57 fleet kill):
/// a revived create without model flags lands on the featured default
/// while the daemon boot's catalog fetch is still in flight; the
/// create-time restore pins the saved model after the window instead.
#[tokio::test]
async fn revived_session_restores_its_pinned_model_not_the_startup_default() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    let pi = pi_payload();
    let layer_a = serde_json::json!({ "schemaVersion": 1, "models": [] }).to_string();
    let server = MockCatalogServer::start(vec![
        catalog_ok_json(&layer_a),
        catalog_ok_json(&pi),
        catalog_ok_json(&pi),
    ])
    .await;
    install_loopback_catalog(&agent_dir, &server);
    let path = session_file_pinning_private_model(dir.path());
    let engine = restore_test_engine(dir.path(), None, None);
    engine.set_session_file(path.clone());

    let cold = engine.resolve_registry_model().expect("cold resolution");
    assert_eq!(cold.provider, "prime-inference");
    assert_eq!(cold.id, "z-ai/glm-5.3");
    assert_eq!(
        server.request_count(),
        0,
        "the cold resolution never fetches"
    );

    engine.restore_session_model(&path, None).await;
    let restored = engine
        .resolve_registry_model()
        .expect("restored resolution");
    assert_eq!(restored.provider, "prime-inference");
    assert_eq!(restored.id, "internal/glm-5.3-fast");
    assert!(
        engine.model_fallback_message().is_none(),
        "a successful restore leaves no fallback message"
    );
}

#[tokio::test]
async fn revived_session_fallback_is_on_the_record() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    // Every fetch fails instantly (the drained queue answers 500): the
    // restore misses fast, the startup chain owns the session.
    let server = MockCatalogServer::start(Vec::new()).await;
    install_loopback_catalog(&agent_dir, &server);
    let path = session_file_pinning_private_model(dir.path());
    let engine = restore_test_engine(dir.path(), None, None);
    engine.set_session_file(path.clone());

    engine.restore_session_model(&path, None).await;
    assert_eq!(
        engine.model_fallback_message().as_deref(),
        Some("Could not restore model prime-inference/internal/glm-5.3-fast. Using prime-inference/z-ai/glm-5.3"),
        "the fallback is published, never silent"
    );
    let resolved = engine.resolve_registry_model().expect("startup chain");
    assert_eq!(resolved.provider, "prime-inference");
    assert_eq!(resolved.id, "z-ai/glm-5.3");
}

#[tokio::test]
async fn create_flags_beat_the_saved_session_model() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    let path = session_file_pinning_private_model(dir.path());
    let engine = restore_test_engine(dir.path(), Some("battery"), Some("mock-1"));
    engine.set_session_file(path.clone());

    engine.restore_session_model(&path, None).await;
    let resolved = engine.resolve_registry_model().expect("flagged resolution");
    assert_eq!(resolved.provider, "battery");
    assert_eq!(resolved.id, "mock-1");
    assert!(engine.model_fallback_message().is_none());
}

#[tokio::test]
async fn fresh_session_without_a_saved_model_keeps_the_startup_chain() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    let server = MockCatalogServer::start(Vec::new()).await;
    install_loopback_catalog(&agent_dir, &server);
    let mut session =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap_or("/tmp"), None, 0);
    let path = dir.path().join(crate::session_store::session_file_name(
        session.session_id(),
    ));
    session.set_path(path.clone()).unwrap();
    session.rewrite().unwrap();
    let engine = restore_test_engine(dir.path(), None, None);
    engine.set_session_file(path.clone());

    engine.restore_session_model(&path, None).await;
    assert!(engine.model_fallback_message().is_none());
    let resolved = engine.resolve_registry_model().expect("startup chain");
    assert_eq!(resolved.id, "z-ai/glm-5.3");
}

#[tokio::test]
async fn a_restore_decision_is_scoped_to_its_session_file() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    let pi = pi_payload();
    let layer_a = serde_json::json!({ "schemaVersion": 1, "models": [] }).to_string();
    let server = MockCatalogServer::start(vec![
        catalog_ok_json(&layer_a),
        catalog_ok_json(&pi),
        catalog_ok_json(&pi),
    ])
    .await;
    install_loopback_catalog(&agent_dir, &server);
    let pinned = session_file_pinning_private_model(dir.path());
    let engine = restore_test_engine(dir.path(), None, None);
    engine.set_session_file(pinned.clone());
    engine.restore_session_model(&pinned, None).await;
    let restored = engine
        .resolve_registry_model()
        .expect("restored resolution");
    assert_eq!(restored.id, "internal/glm-5.3-fast");

    let mut other =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap_or("/tmp"), None, 0);
    let other_path = dir
        .path()
        .join(crate::session_store::session_file_name(other.session_id()));
    other.set_path(other_path.clone()).unwrap();
    other.rewrite().unwrap();
    engine.set_session_file(other_path);
    let moved = engine.resolve_registry_model().expect("moved resolution");
    assert_eq!(moved.id, "z-ai/glm-5.3");
    assert!(
        engine.model_fallback_message().is_none(),
        "the old file's decision does not leak into the moved-to session"
    );
}

#[tokio::test]
async fn a_model_switch_never_leaks_into_the_replacement_session() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_prime_auth(&agent_dir);
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    let pi = pi_payload();
    let layer_a = serde_json::json!({ "schemaVersion": 1, "models": [] }).to_string();
    let server = MockCatalogServer::start(vec![
        catalog_ok_json(&layer_a),
        catalog_ok_json(&pi),
        catalog_ok_json(&pi),
    ])
    .await;
    install_loopback_catalog(&agent_dir, &server);

    let file_a = session_file_pinning_private_model(dir.path());
    let engine = std::sync::Arc::new(restore_test_engine(dir.path(), None, None));
    engine.set_session_file(file_a.clone());
    engine.restore_session_model(&file_a, None).await;
    let restored = engine.resolve_registry_model().expect("restored");
    assert_eq!(restored.id, "internal/glm-5.3-fast");

    // A mid-session /model switch on session A (the worker runs the
    // engine's synchronous switch on the blocking pool, like the turn
    // path — a tokio context must not block on its locks).
    let switched_engine = std::sync::Arc::clone(&engine);
    let switched = tokio::task::spawn_blocking(move || {
        switched_engine.switch_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-1".to_string()),
            api_key: None,
            thinking: None,
        })
    })
    .await
    .expect("blocking switch");
    assert!(switched);
    let switched = engine.resolve_registry_model().expect("switched");
    assert_eq!(switched.id, "mock-1");

    let file_b = session_file_pinning_private_model(dir.path());
    engine.set_session_file(file_b.clone());
    engine.restore_session_model(&file_b, None).await;
    let moved = engine.resolve_registry_model().expect("moved resolution");
    assert_eq!(
        moved.id, "internal/glm-5.3-fast",
        "the moved-to session's own file pin wins over the previous session's switch"
    );
    assert!(engine.model_fallback_message().is_none());
}

#[tokio::test]
async fn an_unpersisted_session_keeps_its_live_selection() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = std::sync::Arc::new(restore_test_engine(dir.path(), None, None));
    engine.configure_create_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-plain".to_string()),
        api_key: None,
        thinking: None,
    });
    let switched_engine = std::sync::Arc::clone(&engine);
    let switched = tokio::task::spawn_blocking(move || {
        switched_engine.switch_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-reason".to_string()),
            api_key: None,
            thinking: None,
        })
    })
    .await
    .expect("blocking switch");
    assert!(switched);

    engine
        .restore_session_model(std::path::Path::new(""), None)
        .await;
    let resolved = engine.resolve_registry_model().expect("live selection");
    assert_eq!(
        (resolved.provider.as_str(), resolved.id.as_str()),
        ("battery", "mock-reason"),
        "the live selection survives an unpersisted replacement"
    );
}

#[tokio::test]
async fn a_replacement_restores_the_moved_to_sessions_saved_thinking_level() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = restore_test_engine(dir.path(), None, None);

    let mut file_a =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap_or("/tmp"), None, 0);
    let path_a = dir
        .path()
        .join(crate::session_store::session_file_name(file_a.session_id()));
    file_a.set_path(path_a.clone()).unwrap();
    file_a.append_model_change("battery", "mock-reason");
    file_a.append_thinking_level_change("low");
    file_a.rewrite().unwrap();
    engine.set_session_file(path_a.clone());
    engine.restore_session_model(&path_a, None).await;
    assert_eq!(
        engine.effective_thinking_level().as_deref(),
        Some("low"),
        "the moved-to session's saved thinking level restores, not the medium default"
    );

    let mut file_b =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap_or("/tmp"), None, 0);
    let path_b = dir
        .path()
        .join(crate::session_store::session_file_name(file_b.session_id()));
    file_b.set_path(path_b.clone()).unwrap();
    file_b.append_model_change("battery", "mock-plain");
    file_b.append_thinking_level_change("high");
    file_b.rewrite().unwrap();
    engine.set_session_file(path_b.clone());
    engine.restore_session_model(&path_b, None).await;
    assert_eq!(
        engine.effective_thinking_level().as_deref(),
        Some("off"),
        "the saved level re-clamps against the restored non-reasoning model"
    );
}

#[tokio::test]
async fn a_compacted_session_restores_its_post_compaction_model() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
    let mut session =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap_or("/tmp"), None, 0);
    let path = dir.path().join(crate::session_store::session_file_name(
        session.session_id(),
    ));
    session.set_path(path.clone()).unwrap();
    session.append_model_change("battery", "mock-reason");
    let kept = session.append_message(&serde_json::json!({
        "role": "assistant",
        "provider": "battery",
        "model": "mock-plain",
        "api": "openai-responses",
        "content": [],
        "stopReason": "stop",
        "timestamp": 0u64,
        "usage": {
            "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
            "cost": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0 }
        }
    }));
    session.append_entry(
        "compaction",
        serde_json::json!({
            "summary": "summary",
            "firstKeptEntryId": kept,
            "tokensBefore": 100
        }),
    );
    session.rewrite().unwrap();

    let engine = restore_test_engine(dir.path(), None, None);
    engine.set_session_file(path.clone());
    engine.restore_session_model(&path, None).await;
    let restored = engine
        .resolve_registry_model()
        .expect("restored resolution");
    assert_eq!(
        (restored.provider.as_str(), restored.id.as_str()),
        ("battery", "mock-plain"),
        "the post-compaction assistant message pins the restored model, not the superseded model_change"
    );
    assert!(engine.model_fallback_message().is_none());
}

#[tokio::test]
async fn create_flags_survive_a_session_replacement() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = std::sync::Arc::new(restore_test_engine(dir.path(), None, None));
    engine.configure_create_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-plain".to_string()),
        api_key: None,
        thinking: None,
    });

    let switched_engine = std::sync::Arc::clone(&engine);
    let switched = tokio::task::spawn_blocking(move || {
        switched_engine.switch_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-reason".to_string()),
            api_key: None,
            thinking: None,
        })
    })
    .await
    .expect("blocking switch");
    assert!(switched);
    let switched = engine.resolve_registry_model().expect("switched");
    assert_eq!(switched.id, "mock-reason");

    let moved = session_file_pinning_model(dir.path(), "battery", "mock-reason");
    engine.set_session_file(moved.clone());
    engine.restore_session_model(&moved, None).await;
    let resolved = engine.resolve_registry_model().expect("flagged resolution");
    assert_eq!(
        (resolved.provider.as_str(), resolved.id.as_str()),
        ("battery", "mock-plain"),
        "the create command's flags survive the replacement"
    );
    assert!(
        engine.model_fallback_message().is_none(),
        "a flagged restore never records a fallback"
    );
}

#[tokio::test]
async fn a_replacement_re_clamps_the_thinking_level_against_the_restored_model() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = restore_test_engine(dir.path(), None, None);
    engine.configure_create_model(EngineModelSelection {
        provider: None,
        model: None,
        api_key: None,
        thinking: Some(pa_types::ai::ModelThinkingLevel::High),
    });

    let plain = session_file_pinning_model(dir.path(), "battery", "mock-plain");
    engine.set_session_file(plain.clone());
    engine.restore_session_model(&plain, None).await;
    assert_eq!(
        engine.effective_thinking_level().as_deref(),
        Some("off"),
        "the clamp follows the restored non-reasoning model, not the reset selection"
    );

    let reason = session_file_pinning_model(dir.path(), "battery", "mock-reason");
    engine.set_session_file(reason.clone());
    engine.restore_session_model(&reason, None).await;
    assert_eq!(
        engine.effective_thinking_level().as_deref(),
        Some("high"),
        "the replacement re-clamps the requested level against its restored model"
    );
}

#[test]
fn switch_model_never_poisons_the_selection_with_a_refused_candidate() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({ "allowedModels": ["battery/mock-1"] }).to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
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
    .unwrap();
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.id, "mock-1");
    let switched = engine.switch_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-2".to_string()),
        api_key: None,
        thinking: None,
    });
    assert!(!switched, "off-allowlist switch refused");
    let model = engine.resolve_registry_model().expect("still resolvable");
    assert_eq!(model.id, "mock-1");
    let switched = engine.switch_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
    });
    assert!(switched, "allowed switch proceeds");
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.id, "mock-1");
}

#[test]
fn switch_model_propagates_the_new_model_to_the_child_identity() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: Some(SupervisorLinkConfig {
            socket_path: dir.path().join("absent-supervisor.sock"),
            active_session_id: "parent-live".to_string(),
            worker_token: "test-token".to_string(),
        }),
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let children = engine
        .children
        .as_ref()
        .expect("the supervisor link wires the children registry")
        .clone();
    children.set_model("battery/mock-2".to_string());
    let switched = engine.switch_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
    });
    assert!(switched, "the switch proceeds without an allowlist");
    assert_eq!(
        children.parent_model().as_deref(),
        Some("battery/mock-1"),
        "an inherited spawn must resolve the switched-to model, not the stale build-time selector"
    );
}

#[test]
fn configure_model_merges_only_present_fields() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: Some("flag-key".to_string()),
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    engine.configure_model(EngineModelSelection {
        provider: None,
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
    });
    let model = engine.resolve_registry_model().expect("resolved model");
    assert_eq!(model.provider, "battery");
    assert_eq!(
        engine.resolve_request_api_key(&model).as_deref(),
        Some("flag-key")
    );
}

#[test]
fn agent_engine_reports_model_resolution_failures() {
    let dir = tempfile::TempDir::new().unwrap();
    // One auth-configured model keeps the available list non-empty in
    // every environment (a clean env with no credentials resolves to
    // "No models available" before the flagged-provider error, while a
    // machine with ambient env credentials reaches this test's branch).
    std::fs::create_dir_all(dir.path().join("agent")).unwrap();
    std::fs::write(
        dir.path().join("agent").join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-battery",
                    "models": [
                        { "id": "mock-1", "contextWindow": 128_000, "maxTokens": 4096 }
                    ]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: Some("no-such-provider".to_string()),
        model: Some("some-model".to_string()),
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "hi".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
    assert_eq!(events.len(), 2);
    assert!(matches!(&events[0], EngineEvent::UserMessage(_)));
    let EngineEvent::Done(Err(error)) = &events[1] else {
        panic!("expected error done");
    };
    assert!(error.contains("Unknown provider"));
}

#[test]
fn configure_model_thinking_clamps_to_the_models_supported_levels() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("models.json"),
        serde_json::json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9",
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "reasoning": true,
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: Some("battery".to_string()),
        model: Some("mock-1".to_string()),
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    // Without an explicit flag the TS default applies (medium, clamped).
    assert_eq!(engine.effective_thinking_level().as_deref(), Some("medium"));
    // The create-config flag is authoritative, clamped to model support.
    engine.configure_model(EngineModelSelection {
        provider: None,
        model: None,
        api_key: None,
        thinking: Some(pa_types::ai::ModelThinkingLevel::Max),
    });
    assert_eq!(engine.effective_thinking_level().as_deref(), Some("high"));
    engine.configure_model(EngineModelSelection {
        provider: None,
        model: None,
        api_key: None,
        thinking: Some(pa_types::ai::ModelThinkingLevel::Low),
    });
    assert_eq!(engine.effective_thinking_level().as_deref(), Some("low"));
}

#[tokio::test]
async fn a_pre_read_saved_context_restores_like_the_file_read() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");

    let mut session =
        crate::session_store::SessionFile::create(dir.path().to_str().unwrap_or("/tmp"), None, 0);
    let path = dir.path().join(crate::session_store::session_file_name(
        session.session_id(),
    ));
    session.set_path(path.clone()).unwrap();
    session.append_model_change("battery", "mock-reason");
    session.append_thinking_level_change("low");
    session.rewrite().unwrap();

    // Engine A: the file-read path (no pre-read context).
    let engine_a = restore_test_engine(dir.path(), None, None);
    engine_a.set_session_file(path.clone());
    engine_a.restore_session_model(&path, None).await;

    // Engine B: the pre-read context off the create's own windowed open
    // (the exact shape the resume create passes).
    let store = crate::session_store::SessionFile::open_windowed(&path).unwrap();
    let saved = super::super::model::saved_session_context_from_parts(
        &store.restored_settings(),
        store.has_thinking_level(),
    );
    let engine_b = restore_test_engine(dir.path(), None, None);
    engine_b.set_session_file(path.clone());
    engine_b.restore_session_model(&path, Some(saved)).await;

    let resolved_a = engine_a
        .resolve_registry_model()
        .expect("file-read resolution");
    let resolved_b = engine_b
        .resolve_registry_model()
        .expect("pre-read resolution");
    assert_eq!(
        (resolved_a.provider, resolved_a.id),
        (resolved_b.provider, resolved_b.id),
        "the pre-read restore pins the same model as the file read"
    );
    assert_eq!(
        engine_a.effective_thinking_level(),
        engine_b.effective_thinking_level(),
        "the pre-read restore adopts the same thinking level"
    );
    assert_eq!(
        engine_a.model_fallback_message(),
        engine_b.model_fallback_message(),
        "the pre-read restore records the same fallback decision"
    );
    assert_eq!(
        engine_b.effective_thinking_level().as_deref(),
        Some("low"),
        "the pre-read path restores the saved level, not the default"
    );
}

#[test]
fn a_model_switch_keeps_the_agent_slot_in_sync_with_the_reported_level() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir,
        provider: Some("battery".to_string()),
        model: Some("mock-reason".to_string()),
        api_key: None,
        thinking: Some(pa_types::ai::ModelThinkingLevel::High),
        session_dir: None,
        session_file: None,
        faux_script: None,
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let model = engine.resolve_model().expect("resolves mock-reason");
    engine
        .ensure_core_session(&model)
        .expect("the session builds");
    let agent_wire_level = |engine: &AgentSessionEngine| {
        let session = engine.session.blocking_lock();
        let core = session.as_deref().expect("the built session");
        let state = engine
            .runtime
            .block_on(async { core.session.agent().state().await });
        pa_core::session_engine::provider_adapter::model_thinking_level(state.thinking_level)
            .wire_name()
            .to_string()
    };
    assert_eq!(engine.effective_thinking_level().as_deref(), Some("high"));
    assert_eq!(agent_wire_level(&engine), "high");

    // The switch onto the plain model clamps the effective level to off:
    // the agent slot must follow (the request stops carrying a level the
    // switched-to model cannot serve).
    assert!(engine.switch_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-plain".to_string()),
        api_key: None,
        thinking: None,
    }));
    assert_eq!(
        engine.effective_thinking_level().as_deref(),
        Some("off"),
        "the plain model clamps the requested high to off"
    );
    assert_eq!(
        agent_wire_level(&engine),
        "off",
        "the agent slot re-syncs to the re-clamped reported level"
    );

    assert!(engine.switch_model(EngineModelSelection {
        provider: Some("battery".to_string()),
        model: Some("mock-reason".to_string()),
        api_key: None,
        thinking: None,
    }));
    assert_eq!(
        engine.effective_thinking_level().as_deref(),
        Some("high"),
        "the requested level survives the round trip"
    );
    assert_eq!(
        agent_wire_level(&engine),
        "high",
        "the agent slot re-syncs to the restored level"
    );
}
