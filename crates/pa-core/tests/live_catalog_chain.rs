//! Verifiers for the live catalog wiring (plan pieces 2-3): the
//! credentialed refresh lands the account's private `internal/*` models,
//! the catalog-repo (layer A) entries, and live pricing in the served
//! registry; without credentials the compiled fallback serves unchanged.
//! Both fetch layers run against a scripted loopback server through the
//! `with_urls` / `install_catalog` seams — nothing leaves localhost.

mod common;

use std::path::Path;
use std::sync::Arc;

use pa_core::auth::{AuthStorage, NoOAuth};
use pa_core::models::{
    find_session_model_with_readiness_wait, install_catalog, startup_refresh, ModelRegistry,
    SESSION_MODEL_RESTORE_READINESS_TIMEOUT_MS,
};
use pa_models::ModelCatalog;
use serde_json::{json, Value};

/// A catalog-repo entry the compiled fallback provably lacks (asserted as a
/// premise: the test fails loudly if the id ever lands in the compiled
/// catalog). Rides the compiled openai transport tuple — the pinning
/// invariant keeps fetched entries to compiled transports.
const LAYER_A_PROBE_ID: &str = "gpt-5.7-probe";

/// The hermetic auth storage: one Prime Inference key+team, with no
/// ambient environment credential source (an env `PRIME_API_KEY` would
/// otherwise win over the stored credential — environment before stored,
/// by design — and the test would resolve a different, team-less scope).
/// Write the file auth.json the supervisor's credential read uses: one
/// Prime Inference key+team (the warm-up and the polled registry resolve
/// through the same file auth, so their scopes match).
fn write_prime_auth(agent_dir: &Path, api_key: &str, team_id: &str) {
    std::fs::write(
        agent_dir.join("auth.json"),
        json!({
            "prime-inference": {
                "type": "api_key",
                "key": api_key,
                "primeTeam": { "teamId": team_id, "name": "Test Team" }
            }
        })
        .to_string(),
    )
    .unwrap();
}

/// The registry the supervisor's startup path would serve: file auth +
/// `models.json` (the same construction every daemon registry uses).
fn file_registry(agent_dir: &Path) -> ModelRegistry {
    let auth = AuthStorage::create(agent_dir);
    ModelRegistry::create(auth, agent_dir.join("models.json"))
}

fn prime_auth(api_key: &str, team_id: &str) -> AuthStorage {
    AuthStorage::in_memory_without_env(
        pa_core::auth::AuthStorageData(
            json!({
                "prime-inference": {
                    "type": "api_key",
                    "key": api_key,
                    "primeTeam": { "teamId": team_id, "name": "Test Team" }
                }
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
        ),
        Arc::new(NoOAuth),
    )
}

/// Install a catalog whose both fetch layers point at the mock server and
/// whose bundled-asset dir is empty (the compiled fallback is the base).
fn install_mock_catalog(agent_dir: &Path, bundled_dir: &Path, server: &common::MockServer) {
    let catalog = ModelCatalog::with_urls(
        Some(agent_dir.join("models")),
        Some(bundled_dir.to_path_buf()),
        &server.url("/catalog"),
        &server.url("/api/v1"),
    );
    install_catalog(&agent_dir.join("models.json"), Arc::new(catalog));
}

/// A layer-A (provider catalog) entry riding a compiled transport tuple:
/// the pinning invariant keeps the fetched catalog to transports this
/// client compiled in, so a new model id must ride an existing
/// `(provider, api, baseUrl)` tuple.
fn layer_a_entry(id: &str, input: f64) -> Value {
    let compiled = pa_models::transports::compiled_models();
    assert!(
        !compiled.iter().any(|model| model.id == id),
        "the layer-A probe {id} is in the compiled catalog; pick another id"
    );
    json!({
        "id": id,
        "name": id,
        "api": "openai-responses",
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "reasoning": true,
        "input": ["text"],
        "cost": { "input": input, "output": 10.0, "cacheRead": 0.0, "cacheWrite": 0.0 },
        "contextWindow": 400_000,
        "maxTokens": 128_000,
    })
}

/// The Prime Inference `/models` payload: every compiled entry repriced
/// (`repriced_id` carries the marker price — the $0-pricing bug is that
/// production served unauthenticated defaults), a live-only public entry,
/// and the private `internal/glm-5.3-fast` the compiled fallback lacks.
fn pi_payload(repriced_id: &str, repriced_input: f64) -> String {
    let compiled = pa_models::transports::prime_inference_offline_entries();
    let mut data: Vec<Value> = compiled
        .iter()
        .map(|model| {
            json!({
                "id": model.id,
                "display_name": model.name,
                "pricing": {
                    "input_usd_per_mtok": if model.id == repriced_id { repriced_input } else { model.cost.input.as_f64() },
                    "output_usd_per_mtok": model.cost.output.as_f64(),
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
    // A public live-only entry (no compiled template): full specs keep it.
    data.push(json!({
        "id": "anthropic/live-only-model",
        "display_name": "Live Only Model",
        "pricing": { "input_usd_per_mtok": 1.0, "output_usd_per_mtok": 2.0 },
        "specs": {
            "context_window": 64_000, "max_output_tokens": 8_192,
            "supports_reasoning": false,
            "modalities": { "input": ["text"], "output": ["text"] },
        },
    }));
    // The private entitlement: absent from the compiled fallback, visible
    // only through the credentialed private-authorization lane.
    data.push(json!({
        "id": "internal/glm-5.3-fast",
        "display_name": "GLM 5.3 Fast (internal)",
        "pricing": { "input_usd_per_mtok": 0.42, "output_usd_per_mtok": 2.1 },
        "specs": {
            "context_window": 400_000, "max_output_tokens": 131_072,
            "supports_reasoning": true,
            "modalities": { "input": ["text"], "output": ["text"] },
        },
    }));
    json!({ "data": data }).to_string()
}

/// Piece 5 (a): with credentials present, the worker-boot refresh lands
/// the credentialed layers — live pricing, the private `internal/*`
/// entitlement, and the layer-A catalog-repo entry the compiled fallback
/// lacks — and the credentialed fetches carry the Bearer + team headers
/// (the $0-pricing bug: production fetched without them).
#[tokio::test]
async fn refresh_lands_live_pricing_private_models_and_layer_a_entries() {
    let agent_dir = tempfile::tempdir().unwrap();
    let bundled_dir = tempfile::tempdir().unwrap();
    let pi = pi_payload("z-ai/glm-5.3", 7.0);
    let server = common::MockServer::start(vec![
        // Layer A (unauthenticated provider catalog).
        common::ok_json(
            json!({ "schemaVersion": 1, "models": [
                layer_a_entry(LAYER_A_PROBE_ID, 1.25),
            ]})
            .to_string(),
            None,
        ),
        // Layer B (credentialed public Prime Inference).
        common::ok_json(pi.clone(), None),
        // The private-authorization fetch.
        common::ok_json(pi, None),
    ])
    .await;
    install_mock_catalog(agent_dir.path(), bundled_dir.path(), &server);

    let mut registry = ModelRegistry::create(
        prime_auth("test-key", "team-1"),
        agent_dir.path().join("models.json"),
    );
    registry.refresh_available_models().await;

    let all = registry.get_all();
    // Layer A: the catalog-repo entry the compiled fallback lacks.
    let gpt = all
        .iter()
        .find(|model| model.id == LAYER_A_PROBE_ID && model.provider == "openai")
        .expect("layer-A entry served");
    assert!((gpt.cost.input.as_f64() - 1.25).abs() < 1e-9);
    // Layer B: live pricing replaces the compiled template.
    let glm = all
        .iter()
        .find(|model| model.id == "z-ai/glm-5.3" && model.provider == "prime-inference")
        .expect("repriced model served");
    assert!((glm.cost.input.as_f64() - 7.0).abs() < 1e-9);
    assert!(
        all.iter()
            .any(|model| model.id == "anthropic/live-only-model"),
        "live-only public entry"
    );
    // The private entitlement, visible because the authorized set adopted it.
    let private = all
        .iter()
        .find(|model| model.id == "internal/glm-5.3-fast")
        .expect("private entitlement served");
    assert!((private.cost.input.as_f64() - 0.42).abs() < 1e-9);
    // Auth is configured, so the private model is also available.
    assert!(registry
        .get_available()
        .iter()
        .any(|model| model.id == "internal/glm-5.3-fast"));

    // Exactly the three fetches (layer A, layer B, private lane).
    let requests = server.recorded_requests();
    assert_eq!(requests.len(), 3, "got {}: {requests:#?}", requests.len());
    // Layer A is unauthenticated.
    assert!(requests[0].contains("GET /catalog"));
    assert!(!requests[0].to_lowercase().contains("authorization:"));
    // The credentialed fetches carry Bearer + team (TS parity).
    for request in &requests[1..] {
        let head = request.to_lowercase();
        assert!(head.contains("get /api/v1/models"), "{request}");
        assert!(head.contains("authorization: bearer test-key"), "{request}");
        assert!(head.contains("x-prime-team-id: team-1"), "{request}");
    }
}

/// Piece 3's supervisor entry point: the forced, fire-and-forget Startup
/// refresh warms the process-shared catalog, and every registry the
/// process constructs afterwards serves the refreshed chain (the
/// supervisor keeps the disk caches warm for the workers it spawns).
#[tokio::test]
async fn startup_refresh_warms_the_process_shared_catalog() {
    let agent_dir = tempfile::tempdir().unwrap();
    let bundled_dir = tempfile::tempdir().unwrap();
    write_prime_auth(agent_dir.path(), "test-key", "team-1");
    let server = common::MockServer::start(vec![
        common::ok_json(
            json!({ "schemaVersion": 1, "models": [
                layer_a_entry(LAYER_A_PROBE_ID, 1.25),
            ]})
            .to_string(),
            None,
        ),
        common::ok_json(pi_payload("z-ai/glm-5.3", 7.0), None),
    ])
    .await;
    install_mock_catalog(agent_dir.path(), bundled_dir.path(), &server);

    // Fire-and-forget: poll the served catalog until it settles.
    startup_refresh(agent_dir.path());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let mut registry = file_registry(agent_dir.path());
        registry.refresh();
        let all = registry.get_all().to_vec();
        let warmed = all.iter().any(|model| model.id == LAYER_A_PROBE_ID)
            && all.iter().any(|model| {
                model.id == "z-ai/glm-5.3"
                    && model.provider == "prime-inference"
                    && (model.cost.input.as_f64() - 7.0).abs() < 1e-9
            });
        if warmed {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "startup refresh never warmed the shared catalog"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// Piece 5 (b): without credentials (and with every fetch failing), the
/// compiled fallback serves unchanged — the no-cold-start chain.
#[tokio::test]
async fn without_credentials_the_compiled_fallback_serves_unchanged() {
    let agent_dir = tempfile::tempdir().unwrap();
    let bundled_dir = tempfile::tempdir().unwrap();
    let server =
        common::MockServer::start(vec![common::status(500, "Internal Server Error")]).await;
    install_mock_catalog(agent_dir.path(), bundled_dir.path(), &server);

    let auth = AuthStorage::in_memory_without_env(
        pa_core::auth::AuthStorageData(json!({}).as_object().cloned().unwrap_or_default()),
        Arc::new(NoOAuth),
    );
    let mut registry = ModelRegistry::create(auth, agent_dir.path().join("models.json"));
    registry.refresh_available_models().await;

    let compiled = pa_models::transports::prime_inference_offline_entries();
    let compiled_glm = compiled
        .iter()
        .find(|model| model.id == "z-ai/glm-5.3")
        .expect("compiled model");
    let all = registry.get_all();
    let glm = all
        .iter()
        .find(|model| model.id == "z-ai/glm-5.3" && model.provider == "prime-inference")
        .expect("compiled fallback model");
    // Compiled pricing, not live: no credentialed fetch ever ran.
    assert_eq!(glm.cost.input.as_f64(), compiled_glm.cost.input.as_f64());
    // No layer-A entry (the fetch failed), no private entitlement.
    assert!(!all.iter().any(|model| model.id == LAYER_A_PROBE_ID));
    assert!(!all.iter().any(|model| model.id == "internal/glm-5.3-fast"));
    // The bundled private table is present but auth-gated out.
    assert!(all.iter().any(|model| model.id == "internal/glm-5.2-fast"));
    assert!(!registry
        .get_available()
        .iter()
        .any(|model| model.id == "internal/glm-5.2-fast"));
}

/// Piece 5 (d): a catalog-repo entry absent from the compiled fallback
/// appears after the layer-A fetch (unauthenticated: no credentials
/// needed for the provider catalog).
#[tokio::test]
async fn layer_a_fetch_adds_entries_the_compiled_fallback_lacks() {
    let agent_dir = tempfile::tempdir().unwrap();
    let bundled_dir = tempfile::tempdir().unwrap();
    let server = common::MockServer::start(vec![common::ok_json(
        json!({ "schemaVersion": 1, "models": [
            layer_a_entry(LAYER_A_PROBE_ID, 1.25),
        ]})
        .to_string(),
        None,
    )])
    .await;
    install_mock_catalog(agent_dir.path(), bundled_dir.path(), &server);

    let auth = AuthStorage::in_memory_without_env(
        pa_core::auth::AuthStorageData(json!({}).as_object().cloned().unwrap_or_default()),
        Arc::new(NoOAuth),
    );
    let mut registry = ModelRegistry::create(auth, agent_dir.path().join("models.json"));
    registry.refresh_available_models().await;

    let all = registry.get_all();
    let gpt = all
        .iter()
        .find(|model| model.id == LAYER_A_PROBE_ID && model.provider == "openai")
        .expect("layer-A entry appears after the fetch");
    assert_eq!(gpt.context_window, 400_000);
    assert!((gpt.cost.input.as_f64() - 1.25).abs() < 1e-9);
    // The compiled Prime Inference section still serves beside it.
    assert!(all
        .iter()
        .any(|model| model.provider == "prime-inference" && model.id == "z-ai/glm-5.3"));
}

/// Piece 5 (e): the picker regression — the fetched catalog-repo entry
/// shows in the picker's available list (`get_available`, the same list
/// the interactive model picker renders and `get_model_catalog`'s
/// configuredProviders derives from) once its provider's auth is
/// configured in models.json; without the provider auth the entry stays in
/// the full catalog but is gated out of the picker (the production
/// openai-codex picker gap was missing auth, not missing wiring).
#[tokio::test]
async fn the_picker_available_list_shows_a_fetched_entry_once_its_provider_auth_is_configured() {
    async fn refreshed_registry_with_openai_auth(
        openai_auth_configured: bool,
    ) -> (tempfile::TempDir, ModelRegistry) {
        let agent_dir = tempfile::tempdir().unwrap();
        let bundled_dir = tempfile::tempdir().unwrap();
        let server = common::MockServer::start(vec![
            common::ok_json(
                json!({ "schemaVersion": 1, "models": [
                    layer_a_entry(LAYER_A_PROBE_ID, 1.25),
                ]})
                .to_string(),
                None,
            ),
            common::ok_json(pi_payload("z-ai/glm-5.3", 7.0), None),
        ])
        .await;
        install_mock_catalog(agent_dir.path(), bundled_dir.path(), &server);
        if openai_auth_configured {
            std::fs::write(
                agent_dir.path().join("models.json"),
                json!({
                    "providers": {
                        "openai": {
                            "apiKey": "probe-key",
                            "headers": { "X-Probe": "catalog-chain" }
                        }
                    }
                })
                .to_string(),
            )
            .unwrap();
        }
        let mut registry = ModelRegistry::create(
            prime_auth("test-key", "team-1"),
            agent_dir.path().join("models.json"),
        );
        registry.refresh_available_models().await;
        (agent_dir, registry)
    }

    // With the provider auth configured, the fetched entry is pickable.
    let (_dir, registry) = refreshed_registry_with_openai_auth(true).await;
    let available = registry.get_available();
    let probe = available
        .iter()
        .find(|model| model.provider == "openai" && model.id == LAYER_A_PROBE_ID)
        .expect("the fetched entry lists in the picker once auth is configured");
    assert!((probe.cost.input.as_f64() - 1.25).abs() < 1e-9);
    // The rlm search surface (find_models) shares the availability gate.
    assert!(registry
        .get_rlm_searchable_models()
        .iter()
        .any(|model| model.id == LAYER_A_PROBE_ID));

    // Without the provider auth: still in the full catalog, gated out of
    // the picker's available list.
    let (_bare_dir, bare_registry) = refreshed_registry_with_openai_auth(false).await;
    assert!(bare_registry
        .get_all()
        .iter()
        .any(|model| model.id == LAYER_A_PROBE_ID));
    assert!(!bare_registry
        .get_available()
        .iter()
        .any(|model| model.id == LAYER_A_PROBE_ID));

/// The session-model restore (the revival race this crate's catalog wiring
/// must cover): a saved private model missing from the cold registry
/// (no disk caches yet) restores through the readiness window while the
/// catalog fetch is still in flight. TS `findSessionModelWithReadinessWait`
/// — the sdk.ts session boot gives the daemon restart's fetch a bounded
/// window before the lookup is allowed to fail.
#[tokio::test]
async fn session_model_restore_waits_out_a_slow_catalog_fetch() {
    let agent_dir = tempfile::tempdir().unwrap();
    let bundled_dir = tempfile::tempdir().unwrap();
    let pi = pi_payload("z-ai/glm-5.3", 7.0);
    let layer_a = json!({ "schemaVersion": 1, "models": [
        layer_a_entry(LAYER_A_PROBE_ID, 1.25),
    ]})
    .to_string();
    let slow = std::time::Duration::from_millis(300);
    let server = common::MockServer::start_scripted(vec![
        common::Scripted::Delayed(common::ok_json(layer_a, None), slow),
        common::Scripted::Delayed(common::ok_json(pi.clone(), None), slow),
        common::Scripted::Delayed(common::ok_json(pi, None), slow),
    ])
    .await;
    install_mock_catalog(agent_dir.path(), bundled_dir.path(), &server);

    // The fresh worker's registry: file auth, cold disk caches — the saved
    // private model is nowhere in the compiled fallback.
    let mut registry = ModelRegistry::create(
        prime_auth("test-key", "team-1"),
        agent_dir.path().join("models.json"),
    );
    let restored = find_session_model_with_readiness_wait(
        &mut registry,
        "prime-inference",
        "internal/glm-5.3-fast",
        SESSION_MODEL_RESTORE_READINESS_TIMEOUT_MS,
    )
    .await
    .expect("the slow fetch lands inside the readiness window");
    assert_eq!(restored.provider, "prime-inference");
    assert_eq!(restored.id, "internal/glm-5.3-fast");
    assert!(registry.has_configured_auth(&restored));
}

/// The restore is bounded: a catalog fetch that never settles cannot hold a
/// revived session's boot hostage — the lookup fails after the window and
/// the caller falls back (and must say so, never silently).
#[tokio::test]
async fn session_model_restore_is_bounded_when_the_fetch_never_lands() {
    let agent_dir = tempfile::tempdir().unwrap();
    let bundled_dir = tempfile::tempdir().unwrap();
    let server = common::MockServer::start_scripted(vec![common::Scripted::Hang]).await;
    install_mock_catalog(agent_dir.path(), bundled_dir.path(), &server);

    let mut registry = ModelRegistry::create(
        prime_auth("test-key", "team-1"),
        agent_dir.path().join("models.json"),
    );
    let started = std::time::Instant::now();
    let restored = find_session_model_with_readiness_wait(
        &mut registry,
        "prime-inference",
        "internal/glm-5.3-fast",
        200,
    )
    .await;
    assert!(restored.is_none(), "the held fetch never lands");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "the bounded window is the ceiling, not the fetch timeout"
    );
}

/// The fast path: a registered, auth-configured model restores with no
/// refresh at all (TS `findRestorable`'s sync lookup — no network).
#[tokio::test]
async fn session_model_restore_fast_path_never_fetches() {
    let agent_dir = tempfile::tempdir().unwrap();
    let bundled_dir = tempfile::tempdir().unwrap();
    let pi = pi_payload("z-ai/glm-5.3", 7.0);
    let layer_a = json!({ "schemaVersion": 1, "models": [
        layer_a_entry(LAYER_A_PROBE_ID, 1.25),
    ]})
    .to_string();
    let server = common::MockServer::start(vec![
        common::ok_json(layer_a, None),
        common::ok_json(pi.clone(), None),
        common::ok_json(pi, None),
    ])
    .await;
    install_mock_catalog(agent_dir.path(), bundled_dir.path(), &server);

    let mut registry = ModelRegistry::create(
        prime_auth("test-key", "team-1"),
        agent_dir.path().join("models.json"),
    );
    registry.refresh_available_models().await;
    let requests_after_warmup = server.recorded_requests().len();

    // A zero readiness window: any refresh would fail instantly (the queue
    // drained) — only the sync fast path can answer.
    let restored = find_session_model_with_readiness_wait(
        &mut registry,
        "prime-inference",
        "internal/glm-5.3-fast",
        0,
    )
    .await
    .expect("the registered model restores without a fetch");
    assert_eq!(restored.id, "internal/glm-5.3-fast");
    assert_eq!(
        server.recorded_requests().len(),
        requests_after_warmup,
        "the fast path never fetches"
    );
}
