//! The registry unit battery: catalog, auth filters, cache merges, headers.
use super::*;
use crate::auth::manager::{AuthStorage, NoOAuth};
use crate::auth::types::AuthStorageData;
use std::sync::Arc;

fn auth_with(data: &serde_json::Value) -> AuthStorage {
    let data = AuthStorageData(data.as_object().cloned().unwrap_or_default());
    AuthStorage::in_memory(&data, Arc::new(NoOAuth))
}

/// Like [`auth_with`] but with ambient `PRIME_API_KEY`/`PRIME_TEAM_ID`
/// ignored: the stored credential is the only source, so credential
/// tests are hermetic on boxes that carry Prime Inference env vars.
fn auth_without_env(data: &serde_json::Value) -> AuthStorage {
    let data = AuthStorageData(data.as_object().cloned().unwrap_or_default());
    AuthStorage::in_memory_without_env(&data, Arc::new(NoOAuth))
}

fn model(id: &str, provider: &str) -> Model {
    serde_json::from_value(serde_json::json!({
        "id": id, "name": id, "api": "openai-completions", "provider": provider,
        "baseUrl": "https://example.com", "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 1000, "maxTokens": 100
    }))
    .unwrap()
}

#[test]
fn in_memory_loads_built_in_catalog() {
    let registry = ModelRegistry::in_memory(auth_with(&serde_json::json!({})));
    assert!(registry.get_error().is_none());
    assert!(!registry.get_all().is_empty());
    assert!(registry
        .get_all()
        .iter()
        .any(|m| m.id == "internal/glm-5.2-fast"));
}

/// TS `755-configured-max-tokens.test.ts`: built-in catalog models stay
/// unmarked when no override configures `maxTokens` — the default 32000
/// ceiling keeps applying to them (901 of the catalog's models declare
/// more than 32000 and their request size must not change).
#[test]
fn built_in_catalog_models_stay_unmarked() {
    let registry = ModelRegistry::in_memory(auth_with(&serde_json::json!({})));
    assert!(!registry.get_all().is_empty());
    assert!(registry
        .get_all()
        .iter()
        .all(|model| !model.max_tokens_explicit));
}

#[test]
fn available_filters_by_configured_auth() {
    let auth = auth_with(&serde_json::json!({
        "anthropic": { "type": "api_key", "key": "sk-ant" }
    }));
    let registry = ModelRegistry::in_memory(auth);
    assert!(registry.has_configured_auth(&model("m", "anthropic")));
    // An unconfigured provider is auth-gated out; the name is deliberately
    // obscure so ambient environment variables cannot authorize it.
    assert!(!registry.has_configured_auth(&model("m", "zz-no-provider")));
    let all = registry.get_all();
    let available = registry.get_available();
    assert!(available.iter().all(|available_model| {
        all.iter().any(|model| {
            model.id == available_model.id && model.provider == available_model.provider
        })
    }));
}

#[test]
fn rlm_searchable_models_gate_one_stale_provider_across_its_models() {
    // The per-provider status memo must answer every model of a provider
    // with the same probe result: a stale provider's whole model list stays
    // gated while a second authed provider keeps its models searchable.
    let mut auth = auth_without_env(&serde_json::json!({
        "anthropic": { "type": "api_key", "key": "sk-ant" },
        "openai": { "type": "api_key", "key": "sk-oai" }
    }));
    assert!(auth.mark_auth_stale("anthropic"));
    let registry = ModelRegistry::in_memory(auth);
    let searchable = registry.get_rlm_searchable_models();
    assert!(searchable.iter().all(|model| model.provider != "anthropic"));
    assert!(searchable.iter().any(|model| model.provider == "openai"));
    // `has_auth` is stale-aware (a marked credential is not
    // "configured"), so the available set gates the stale provider's
    // models too - the same semantics at the tip and with the memo.
    let available = registry.get_available();
    assert!(!available.iter().any(|model| model.provider == "anthropic"));
    assert!(available.iter().any(|model| model.provider == "openai"));
    assert!(available
        .iter()
        .all(|model| model.provider != "zz-no-provider"));
}

#[test]
fn models_json_custom_models_and_auth_header() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    std::fs::write(
        &models_path,
        r#"{ "providers": { "custom": {
            "baseUrl": "https://custom.example", "apiKey": "custom-key",
            "api": "openai-completions", "authHeader": true,
            "models": [ { "id": "my-model" } ]
        } } }"#,
    )
    .unwrap();
    let auth = auth_with(&serde_json::json!({}));
    let mut registry = ModelRegistry::create(auth, &models_path);
    assert!(registry.get_error().is_none());
    let custom = registry
        .get_all()
        .iter()
        .find(|m| m.provider == "custom" && m.id == "my-model")
        .expect("custom model merged")
        .clone();
    assert_eq!(custom.base_url, "https://custom.example");
    assert!(registry.get_available().iter().any(|m| m.id == "my-model"));
    let auth_result = registry.get_api_key_and_headers(&custom, None);
    assert!(auth_result.ok);
    assert_eq!(auth_result.api_key.as_deref(), Some("custom-key"));
    assert_eq!(
        auth_result.headers.as_ref().unwrap().get("Authorization"),
        Some(&"Bearer custom-key".to_string())
    );
}

/// One refreshing lookup per `get_api_key_and_headers` call: an expired
/// OAuth credential with a failing refresh serves the configured
/// `models.json` fallback key after exactly one refresh attempt — the
/// live seam's per-request re-resolution must never re-fetch a token
/// the same resolution just failed to refresh.
#[test]
fn get_api_key_and_headers_attempts_one_refresh_per_call() {
    struct CountingFailingRefresh(std::sync::Mutex<usize>);
    impl crate::auth::manager::OAuthIntegration for CountingFailingRefresh {
        fn api_key_for(
            &self,
            _provider: &str,
            credential: &crate::auth::types::AuthCredential,
        ) -> Option<String> {
            match credential {
                crate::auth::types::AuthCredential::Oauth { access, .. } => Some(access.clone()),
                _ => None,
            }
        }

        fn refresh(
            &self,
            _provider: &str,
            _credentials: &crate::auth::types::AuthStorageData,
        ) -> Result<crate::auth::types::AuthCredential, String> {
            *self.0.lock().unwrap() += 1;
            Err("the token call failed".to_string())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    std::fs::write(
        &models_path,
        r#"{ "providers": { "battery": {
            "baseUrl": "https://battery.example", "apiKey": "sk-config-fallback",
            "api": "openai-completions",
            "models": [ { "id": "mock-1" } ]
        } } }"#,
    )
    .unwrap();
    let data = AuthStorageData(
        serde_json::json!({
            "battery": { "type": "oauth", "access": "stale-access", "refresh": "r", "expires": 1 }
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
    );
    let refreshes = std::sync::Arc::new(CountingFailingRefresh(std::sync::Mutex::new(0)));
    let auth = AuthStorage::in_memory_without_env(&data, refreshes.clone());
    let mut registry = ModelRegistry::create(auth, &models_path);
    let battery = registry
        .get_all()
        .iter()
        .find(|model| model.provider == "battery" && model.id == "mock-1")
        .expect("the custom model merges")
        .clone();
    let resolved = registry.get_api_key_and_headers(&battery, None);
    assert!(resolved.ok);
    assert_eq!(
        resolved.api_key.as_deref(),
        Some("sk-config-fallback"),
        "the failed refresh falls back to the configured key"
    );
    assert_eq!(
        *refreshes.0.lock().unwrap(),
        1,
        "one lookup, one refresh attempt"
    );

    // An unexpired stored credential serves with no refresh attempt
    // at all.
    let fresh = AuthStorageData(
        serde_json::json!({
            "battery": {
                "type": "oauth", "access": "live-access", "refresh": "r",
                "expires": 4_102_444_800_000i64
            }
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
    );
    let refreshes = std::sync::Arc::new(CountingFailingRefresh(std::sync::Mutex::new(0)));
    let auth = AuthStorage::in_memory_without_env(&fresh, refreshes.clone());
    let mut registry = ModelRegistry::create(auth, &models_path);
    let resolved = registry.get_api_key_and_headers(&battery, None);
    assert_eq!(resolved.api_key.as_deref(), Some("live-access"));
    assert_eq!(*refreshes.0.lock().unwrap(), 0, "no refresh fires");
}

/// An expired OAuth credential whose refresh fails, with no other key to
/// serve, fails the resolution with the re-login sentence (not a keyless
/// request that surfaces as "No API key").
#[test]
fn a_failed_refresh_with_nothing_else_to_serve_fails_with_the_re_login_sentence() {
    struct RevokedGrant;
    impl crate::auth::manager::OAuthIntegration for RevokedGrant {
        fn api_key_for(
            &self,
            _provider: &str,
            _credential: &crate::auth::types::AuthCredential,
        ) -> Option<String> {
            None
        }

        fn refresh(
            &self,
            _provider: &str,
            _credentials: &AuthStorageData,
        ) -> Result<crate::auth::types::AuthCredential, String> {
            Err("invalid_grant".to_string())
        }
    }
    let data = AuthStorageData(
        serde_json::json!({
            "anthropic": {
                "type": "oauth", "access": "expired-access", "refresh": "stored-refresh", "expires": 1
            }
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
    );
    let mut registry = ModelRegistry::in_memory(AuthStorage::in_memory_without_env(
        &data,
        Arc::new(RevokedGrant),
    ));
    assert_eq!(
        registry.get_api_key_and_headers(&model("m", "anthropic"), None),
        ResolvedRequestAuth {
            ok: false,
            error: Some(
                "Authentication failed for \"anthropic\": the stored credential could not be refreshed (invalid_grant).\n\nRun /login to update credentials."
                    .to_string()
            ),
            ..Default::default()
        }
    );
}

#[test]
fn models_json_error_keeps_built_ins() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    std::fs::write(&models_path, "{ not json").unwrap();
    let registry = ModelRegistry::create(auth_with(&serde_json::json!({})), &models_path);
    assert!(registry.get_error().is_some());
    assert!(!registry.get_all().is_empty());
}

#[test]
fn header_precedence_model_over_provider() {
    let mut registry = ModelRegistry::in_memory(auth_with(&serde_json::json!({
        "anthropic": { "type": "api_key", "key": "sk-ant" }
    })));
    let mut m = model("m", "anthropic");
    m.headers = Some(BTreeMap::from([(
        "X-Model".to_string(),
        "model".to_string(),
    )]));
    let result = registry.get_api_key_and_headers(&m, None);
    assert_eq!(result.api_key.as_deref(), Some("sk-ant"));
    assert_eq!(
        result.headers.as_ref().unwrap().get("X-Model").unwrap(),
        "model"
    );
    // Request headers win over everything.
    let request = BTreeMap::from([("X-Model".to_string(), "request".to_string())]);
    let result = registry.get_api_key_and_headers(&m, Some(&request));
    assert_eq!(
        result.headers.as_ref().unwrap().get("X-Model").unwrap(),
        "request"
    );
}

#[test]
fn live_scope_keyed_cache_merges_over_the_compiled_prime_inference_models() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    std::fs::write(
        &models_path,
        r#"{ "providers": { "custom": {
            "baseUrl": "https://custom.example", "apiKey": "custom-key",
            "api": "openai-completions", "authHeader": true,
            "models": [ { "id": "my-model" } ]
        } } }"#,
    )
    .unwrap();
    // A live-catalog snapshot scoped to these credentials: one compiled
    // model repriced, one new entry, well past the coverage floor so
    // the build accepts it. The scope-keyed cache serves this scope's
    // snapshot only; another credential never sees it.
    let auth = auth_without_env(&serde_json::json!({
        "prime-inference": { "type": "api_key", "key": "live-key",
            "primeTeam": { "teamId": "team-1", "name": "Team 1" } }
    }));
    let compiled = pa_models::transports::prime_inference_offline_entries();
    let repriced = &compiled[0];
    let mut entries = Vec::new();
    for model in &compiled {
        entries.push(serde_json::json!({
            "id": model.id,
            "display_name": model.name,
            "pricing": {
                "input_usd_per_mtok": if model.id == repriced.id { 7.0 } else { model.cost.input.as_f64() },
                "output_usd_per_mtok": model.cost.output.as_f64(),
            },
            "specs": {
                "context_window": model.context_window,
                "max_output_tokens": model.max_tokens,
                "supports_reasoning": model.reasoning,
                "modalities": { "input": ["text"], "output": ["text"] },
            },
        }));
    }
    entries.push(serde_json::json!({
        "id": "anthropic/live-only-model",
        "display_name": "Live Only Model",
        "pricing": { "input_usd_per_mtok": 1.0, "output_usd_per_mtok": 2.0 },
        "specs": {
            "context_window": 64000, "max_output_tokens": 8192,
            "supports_reasoning": false,
            "modalities": { "input": ["text"], "output": ["text"] },
        },
    }));
    let scope = pa_models::prime_inference::scope_key("live-key", "team-1");
    let snapshot = serde_json::json!({
        "url": format!("{}/models", super::super::prime_inference::PRIME_INFERENCE_BASE_URL),
        "scope": scope,
        "fetchedAt": 1,
        "payload": { "data": entries },
    });
    std::fs::create_dir_all(dir.path().join("models")).unwrap();
    std::fs::write(
        dir.path().join("models/prime-inference-models-cache.json"),
        serde_json::to_vec(&snapshot).unwrap(),
    )
    .unwrap();
    let mut registry = ModelRegistry::create(auth, &models_path);
    let all = registry.get_all().to_vec();
    // The live repriced model replaced its compiled template (other
    // providers may serve the same id; match the provider too).
    let repriced_model = all
        .iter()
        .find(|model| model.id == repriced.id && model.provider == "prime-inference")
        .expect("repriced model");
    assert_eq!(repriced_model.cost.input.as_f64(), 7.0);
    assert_eq!(
        repriced_model.base_url,
        super::super::prime_inference::PRIME_INFERENCE_BASE_URL
    );
    assert!(all
        .iter()
        .any(|model| model.id == "anthropic/live-only-model"));
    assert!(all.iter().any(|model| model.id == "my-model"));
    assert!(all
        .iter()
        .any(|model| model.provider == "anthropic" && model.id != repriced.id));
    let other_auth = auth_without_env(&serde_json::json!({
        "prime-inference": { "type": "api_key", "key": "other-key",
            "primeTeam": { "teamId": "team-2", "name": "Team 2" } }
    }));
    registry.auth = other_auth;
    registry.refresh();
    let all = registry.get_all().to_vec();
    let compiled_price = compiled
        .iter()
        .find(|model| model.id == repriced.id)
        .unwrap();
    let still_compiled = all
        .iter()
        .find(|model| model.id == repriced.id && model.provider == "prime-inference")
        .expect("compiled fallback for the other scope");
    assert_eq!(
        still_compiled.cost.input.as_f64(),
        compiled_price.cost.input.as_f64()
    );
    assert!(!all
        .iter()
        .any(|model| model.id == "anthropic/live-only-model"));
}

#[test]
fn a_missing_or_corrupt_cache_falls_back_to_the_bundled_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let models_path = dir.path().join("models.json");
    std::fs::write(&models_path, "{ not json").unwrap();
    std::fs::write(
        dir.path().join("prime-inference-models-cache.json"),
        "{ not json",
    )
    .unwrap();
    let registry = ModelRegistry::create(auth_with(&serde_json::json!({})), &models_path);
    assert!(registry
        .get_all()
        .iter()
        .any(|model| model.provider == "prime-inference"));
    assert!(registry.get_error().is_some());
}

#[test]
fn explicit_private_ids_are_authorized() {
    let registry = ModelRegistry::in_memory(auth_with(&serde_json::json!({})));
    let private_model = model("internal/custom-private", "prime-inference");
    assert!(!registry.is_authorized_private_model(&private_model));
}

#[test]
fn a_stored_copilot_credential_rewrites_its_models_base_url() {
    // TS `githubCopilotOAuthProvider.modifyModels`: the token's
    // proxy endpoint wins.
    let auth = auth_without_env(&serde_json::json!({
        "github-copilot": {
            "type": "oauth",
            "access": "tid=1;exp=2;proxy-ep=proxy.enterprise.githubcopilot.com",
            "refresh": "gh", "expires": 4_102_444_800_000i64
        }
    }));
    let registry = ModelRegistry::in_memory(auth);
    let grok = registry
        .get_all()
        .iter()
        .find(|model| model.provider == "github-copilot")
        .expect("the copilot models render");
    assert_eq!(grok.base_url, "https://api.enterprise.githubcopilot.com");
    // An enterprise credential without a proxy endpoint routes onto
    // the enterprise API.
    let auth = auth_without_env(&serde_json::json!({
        "github-copilot": {
            "type": "oauth",
            "access": "plain-token", "refresh": "gh", "expires": 4_102_444_800_000i64,
            "enterpriseUrl": "company.ghe.com"
        }
    }));
    let registry = ModelRegistry::in_memory(auth);
    let grok = registry
        .get_all()
        .iter()
        .find(|model| model.provider == "github-copilot")
        .expect("the copilot models render");
    assert_eq!(grok.base_url, "https://copilot-api.company.ghe.com");
}

#[test]
fn a_stored_xai_subscription_switches_its_models_onto_responses() {
    let auth = auth_without_env(&serde_json::json!({
        "xai": {
            "type": "oauth",
            "access": "grok",
            "refresh": "r",
            "expires": 4_102_444_800_000i64,
        }
    }));
    let registry = ModelRegistry::in_memory(auth);
    let grok = registry
        .get_all()
        .iter()
        .find(|model| model.provider == "xai")
        .expect("the xai model renders");
    assert_eq!(grok.api, "openai-responses");
    assert_eq!(grok.base_url, "https://api.x.ai/v1");
    // The catalog's xai model is non-reasoning: "off" is the only
    // supported level whatever the subscription map nulls (the
    // helper answers the non-reasoning branch first).
    let supported = pa_types::ai::thinking_levels::get_supported_thinking_levels(grok);
    assert_eq!(supported, vec![ModelThinkingLevel::Off]);
    // The compat is the shared-key-only object (TS
    // `supportsLongCacheRetention: false`); the responses provider
    // decodes it directly (its own test covers the decode).
    let compat = grok.compat.as_ref().expect("the compat rides the model");
    assert_eq!(
        compat.raw.get("supportsLongCacheRetention"),
        Some(&serde_json::json!(false))
    );
    // The TS flow's explicit maps stay per model id (unit level;
    // the offline catalog no longer carries those models).
    let map_46 = xai_subscription_thinking_map("grok-4.6");
    assert_eq!(map_46.get(&ModelThinkingLevel::Off), Some(&None));
    assert_eq!(
        map_46.get(&ModelThinkingLevel::Xhigh),
        Some(&Some("xhigh".to_string()))
    );
    let map_43 = xai_subscription_thinking_map("grok-4.3");
    assert_eq!(
        map_43.get(&ModelThinkingLevel::Off),
        Some(&Some("none".to_string()))
    );
}

/// A model that already declares addressable levels keeps them under the
/// subscription — a blanket replacement collapsed a thinking-capable route
/// onto the all-null default arm (the `/effort` false refusal).
#[test]
fn a_subscription_model_keeps_its_own_thinking_level_map() {
    let mut grok = model("grok-build-0.1", "xai");
    grok.reasoning = true;
    grok.thinking_level_map =
        Some(std::iter::once((ModelThinkingLevel::Off, Some("none".to_string()))).collect());
    let adapted = xai_subscription_model(&grok);
    assert_eq!(adapted.thinking_level_map, grok.thinking_level_map);

    let bare = model("grok-4.5", "xai");
    assert!(bare.thinking_level_map.is_none());
    let adapted = xai_subscription_model(&bare);
    assert_eq!(
        adapted.thinking_level_map,
        Some(xai_subscription_thinking_map("grok-4.5"))
    );
}

/// TS `getApiKeyAndHeaders`'s per-call request model for xAI: the stored
/// subscription serves the adapted (openai-responses) shape, an API-key
/// credential serves the configured shape — even for a model captured
/// under the subscription (the slot's shape re-resolves onto the
/// current credential's).
#[test]
fn the_request_model_follows_the_xai_credential_shape_per_call() {
    let auth = auth_without_env(&serde_json::json!({
        "xai": {
            "type": "oauth",
            "access": "grok",
            "refresh": "r",
            "expires": 4_102_444_800_000i64,
        }
    }));
    let mut registry = ModelRegistry::in_memory(auth);
    let configured = registry
        .get_all()
        .iter()
        .find(|model| model.provider == "xai")
        .expect("the xai model renders")
        .clone();
    assert_eq!(
        configured.api, "openai-responses",
        "the subscription adapted the registry model at load"
    );
    let resolved = registry.get_api_key_and_headers(&configured, None);
    assert_eq!(resolved.api_key.as_deref(), Some("grok"));
    let request_model = resolved
        .request_model
        .expect("the xAI resolution serves a request model");
    assert_eq!(request_model.api, "openai-responses");
    assert_eq!(request_model.base_url, "https://api.x.ai/v1");

    // An API-key credential: the registry stays on the configured shape,
    // and a model captured under the subscription (the slot's shape)
    // re-resolves onto the configured shape.
    let auth = auth_without_env(&serde_json::json!({
        "xai": { "type": "api_key", "key": "sk-xai" }
    }));
    let mut registry = ModelRegistry::in_memory(auth);
    let configured = registry
        .get_all()
        .iter()
        .find(|model| model.provider == "xai")
        .expect("the xai model renders")
        .clone();
    assert_eq!(configured.api, "openai-completions");
    let captured = xai_subscription_model(&configured);
    let resolved = registry.get_api_key_and_headers(&captured, None);
    assert_eq!(resolved.api_key.as_deref(), Some("sk-xai"));
    let request_model = resolved
        .request_model
        .expect("the xAI resolution serves a request model");
    assert_eq!(request_model.api, "openai-completions");
    assert_eq!(request_model, configured);
}

#[test]
fn without_a_stored_xai_subscription_the_models_stay_on_completions() {
    let registry = ModelRegistry::in_memory(auth_without_env(&serde_json::json!({})));
    let grok = registry
        .get_all()
        .iter()
        .find(|model| model.provider == "xai")
        .expect("the xai model renders");
    assert_eq!(grok.api, "openai-completions");
    assert!(grok.thinking_level_map.is_none());
    assert!(grok.compat.is_none());
}

#[tokio::test]
async fn scope_readiness_timeout_keeps_models_available_before_refresh() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let auth = auth_without_env(&serde_json::json!({
        "prime-inference": {
            "type": "api_key", "key": "fixture-key",
            "primeTeam": {"teamId": "team-1", "name": "Fixture"}
        }
    }));
    let mut registry = ModelRegistry::in_memory(auth);
    registry.catalog = Arc::new(pa_models::ModelCatalog::with_urls(None, None, &url, &url));
    let existing = model("internal/existing", "prime-inference");
    let missing = model("internal/missing", "prime-inference");
    registry.models = vec![existing.clone(), missing];
    registry.authorized_private_ids.insert(existing.id.clone());
    registry.authorized_private_models = vec![existing.clone()];
    registry.authorized_team_id = Some("team-1".to_string());
    let patterns = vec![
        "prime-inference/internal/existing".to_string(),
        "prime-inference/internal/missing".to_string(),
    ];
    let resolved = super::super::session_restore::resolve_model_scope_from_models_with_readiness(
        &mut registry,
        &patterns,
        Some(("prime-inference", "internal/missing")),
        false,
        0,
    )
    .await;
    assert!(
        registry.authorized_private_ids.is_empty(),
        "refresh started before timing out"
    );
    assert_eq!(
        resolved
            .into_iter()
            .map(|entry| entry.model)
            .collect::<Vec<_>>(),
        vec![existing]
    );
}

#[test]
fn a_prime_base_url_override_voids_the_live_serving_label() {
    let dir = tempfile::tempdir().unwrap();
    let auth = auth_without_env(&serde_json::json!({
        "prime-inference": { "type": "api_key", "key": "live-key",
            "primeTeam": { "teamId": "team-1", "name": "Team 1" } }
    }));
    // Every compiled route labeled hosted, so the snapshot passes the coverage gate.
    let compiled = pa_models::transports::prime_inference_offline_entries();
    let entries: Vec<_> = compiled
        .iter()
        .map(|model| {
            serde_json::json!({
                "id": model.id,
                "serving": "hosted",
                "pricing": { "input_usd_per_mtok": 1.0, "output_usd_per_mtok": 1.0 },
            })
        })
        .collect();
    let snapshot = serde_json::json!({
        "url": format!("{}/models", super::super::prime_inference::PRIME_INFERENCE_BASE_URL),
        "scope": pa_models::prime_inference::scope_key("live-key", "team-1"),
        "fetchedAt": 1,
        "payload": { "data": entries },
    });
    std::fs::create_dir_all(dir.path().join("models")).unwrap();
    std::fs::write(
        dir.path().join("models/prime-inference-models-cache.json"),
        serde_json::to_vec(&snapshot).unwrap(),
    )
    .unwrap();
    let models_path = dir.path().join("models.json");
    std::fs::write(&models_path, "{}").unwrap();
    let mut registry = ModelRegistry::create(auth, &models_path);
    let probe = |registry: &ModelRegistry| {
        registry
            .get_all()
            .iter()
            .find(|model| model.id == compiled[0].id && model.provider == "prime-inference")
            .cloned()
            .unwrap()
    };
    assert_eq!(
        probe(&registry).serving,
        Some(pa_types::ai::ModelServing::Hosted)
    );

    std::fs::write(
        &models_path,
        r#"{ "providers": { "prime-inference": { "baseUrl": "https://my-gateway.example/v1" } } }"#,
    )
    .unwrap();
    registry.refresh();
    let overridden = probe(&registry);
    assert_eq!(overridden.base_url, "https://my-gateway.example/v1");
    assert_eq!(overridden.serving, None);
}
