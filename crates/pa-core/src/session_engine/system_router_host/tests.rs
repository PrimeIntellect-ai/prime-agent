//! The `system_router.run` host-request battery: action-model precedence,
//! auth preflight, the allowlist pin, and one registry round trip.

use std::path::Path;

use serde_json::json;

use crate::kernel::shared::HostRequestPayload;

use super::*;

const MODELS_JSON: &str = r#"{
  "providers": {
    "testprov": {
      "baseUrl": "http://localhost:9",
      "apiKey": "router-key",
      "api": "openai-completions",
      "models": [
        { "id": "session-model", "name": "Session Model", "contextWindow": 128000 },
        { "id": "subagent-model", "name": "Subagent Model", "contextWindow": 128000 },
        { "id": "action-model", "name": "Action Model", "contextWindow": 128000 }
      ]
    }
  }
}"#;

fn write_catalog(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("models.json"), MODELS_JSON).unwrap();
}

fn session_model() -> Model {
    // The agent-side descriptor's own wire names (`base_url`, not the ai
    // side's `baseUrl`): a session model the catalog does not carry must
    // survive the crossing back with these fields intact.
    serde_json::from_value(json!({
        "id": "session-model", "name": "Session Model", "api": "openai-completions",
        "provider": "testprov", "base_url": "http://localhost:9", "reasoning": false,
        "cost": { "input": 1.5, "output": 2.5, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128_000, "maxTokens": 4096
    }))
    .unwrap()
}

fn host_config(
    dir: &Path,
    subagent_default_model: Option<&str>,
    allowed_models: Option<Vec<String>>,
) -> SystemRouterHostConfig {
    SystemRouterHostConfig {
        agent_dir: dir.to_path_buf(),
        cwd: dir.to_path_buf(),
        session_model: session_model(),
        session_id: "session-1".to_string(),
        subagent_default_model: subagent_default_model.map(str::to_string),
        allowed_models,
        policy: crate::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY,
    }
}

/// The action-model precedence: spec selector, then the configured subagent
/// default, then the session model.
#[test]
fn the_action_model_falls_back_in_the_documented_order() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    let config = host_config(dir.path(), Some("testprov/subagent-model"), None);
    let cases = [
        (Some("testprov/action-model"), "action-model"),
        (Some("  action-model  "), "action-model"),
        (None, "subagent-model"),
    ];
    for (reference, expected) in cases {
        let (model, api_key, _headers) = resolve_action_model(&config, reference).unwrap();
        assert_eq!(model.id, expected, "reference {reference:?}");
        assert_eq!(api_key.as_deref(), Some("router-key"));
    }
    // No spec model and no subagent default: the session model.
    let config = host_config(dir.path(), None, None);
    let (model, _, _) = resolve_action_model(&config, None).unwrap();
    assert_eq!(model.id, "session-model");
    // A subagent default equal to the session selector keeps the session model.
    let config = host_config(dir.path(), Some("testprov/session-model"), None);
    let (model, _, _) = resolve_action_model(&config, None).unwrap();
    assert_eq!(model.id, "session-model");
}

#[test]
fn an_unresolvable_action_model_is_refused_loudly() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    let config = host_config(dir.path(), None, None);
    let error = resolve_action_model(&config, Some("testprov/missing")).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Requested system-router model \"testprov/missing\" is unavailable, unauthenticated, or expired; selectors use the form \"provider/model-id\" (e.g. \"prime-inference/internal/glm-5.3-fast\")"
    );
}

#[test]
fn the_allowlist_pin_refuses_a_resolved_action_model() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    let config = host_config(dir.path(), None, Some(vec!["other/*".to_string()]));
    let error = resolve_action_model(&config, Some("testprov/action-model")).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Requested system-router model \"testprov/action-model\" is blocked by the model allowlist"
    );
    // A selector inside the pin resolves.
    let config = host_config(dir.path(), None, Some(vec!["testprov/*".to_string()]));
    let (model, _, _) = resolve_action_model(&config, Some("testprov/action-model")).unwrap();
    assert_eq!(model.id, "action-model");
}

/// The fallback order's last resort: a session model the catalog does not
/// carry (a scripted or in-memory model, one the searchable set cannot
/// return) still resolves. The agent-side descriptor crosses back to the ai
/// side field by field; the two `Model`s do not share a wire shape (the
/// agent side serializes `base_url` and never carries `input`), so the
/// earlier wire-shape round trip never produced a model and the session
/// model errored as unavailable even when it was the intended action model.
#[test]
fn a_non_catalog_session_model_still_resolves_as_the_action_model() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path()).unwrap();
    // A catalog that carries other testprov models but not the session
    // one: the searchable set must miss it, so the resolution rides the
    // session-model fallback, not the catalog.
    std::fs::write(
        dir.path().join("models.json"),
        r#"{
          "providers": {
            "testprov": {
              "baseUrl": "http://localhost:9",
              "apiKey": "router-key",
              "api": "openai-completions",
              "models": [
                { "id": "action-model", "name": "Action Model", "contextWindow": 128000 }
              ]
            }
          }
        }"#,
    )
    .unwrap();
    let config = host_config(dir.path(), None, None);
    let (model, api_key, _headers) = resolve_action_model(&config, None).unwrap();
    assert_eq!(model.provider, "testprov");
    assert_eq!(model.id, "session-model");
    assert_eq!(model.api, "openai-completions");
    assert_eq!(model.base_url, "http://localhost:9");
    assert_eq!(model.context_window, 128_000);
    assert_eq!(model.max_tokens, 4096);
    assert_eq!(model.cost.input.as_f64(), 1.5);
    // The fallback model runs the same auth preflight as a catalog model:
    // the provider's credential resolves from the registry.
    assert_eq!(api_key.as_deref(), Some("router-key"));
    // The explicit session selector resolves through the same fallback.
    let (model, _, _) = resolve_action_model(&config, Some("testprov/session-model")).unwrap();
    assert_eq!(model.id, "session-model");
}

/// The short-form session-model fallback (the "Short-form session
/// fallback misses" review finding): a reference that names the session
/// model in the TS short form — a suffix of the full selector, so the
/// bare id "session-model" names "testprov/session-model" — must reach
/// the same session-model crossing as the full form when the catalog does
/// not carry the session model, instead of reporting it unavailable. TS
/// parity (`_resolveRlmSubagentModel`): "The parent model can be missing
/// from the authenticated catalog (offline discovery or expired
/// credentials) while staying selectable, so it backs the short-form
/// lookup when the catalog has no match."
#[test]
fn a_short_form_session_model_still_resolves_as_the_action_model() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path()).unwrap();
    // A catalog that carries other testprov models (one with a slashed
    // id, the private prime-inference shape) but no model whose selector
    // ends with "/session-model": the short form has no catalog match,
    // so the session model backs it.
    std::fs::write(
        dir.path().join("models.json"),
        r#"{
          "providers": {
            "testprov": {
              "baseUrl": "http://localhost:9",
              "apiKey": "router-key",
              "api": "openai-completions",
              "models": [
                { "id": "action-model", "name": "Action Model", "contextWindow": 128000 },
                { "id": "internal/glm-5.3-fast", "name": "GLM 5.3 Fast", "contextWindow": 400000 }
              ]
            }
          }
        }"#,
    )
    .unwrap();
    let config = host_config(dir.path(), None, None);
    // The bare-id short form of the session selector, as the spec's model.
    let (model, api_key, _headers) = resolve_action_model(&config, Some("session-model")).unwrap();
    assert_eq!(model.provider, "testprov");
    assert_eq!(model.id, "session-model");
    assert_eq!(model.api, "openai-completions");
    assert_eq!(model.base_url, "http://localhost:9");
    assert_eq!(model.context_window, 128_000);
    assert_eq!(model.max_tokens, 4096);
    // The fallback model runs the same auth preflight as a catalog model:
    // the provider's credential resolves from the registry.
    assert_eq!(api_key.as_deref(), Some("router-key"));
    // The suffix rule is case-insensitive.
    let (model, _, _) = resolve_action_model(&config, Some("Session-Model")).unwrap();
    assert_eq!(model.id, "session-model");
    // A short-form subagent default takes the same path (the TS
    // resolution takes `spec.model ?? default` as one reference).
    let config = host_config(dir.path(), Some("session-model"), None);
    let (model, _, _) = resolve_action_model(&config, None).unwrap();
    assert_eq!(model.id, "session-model");
}

/// The documented short-form fallback order (TS `_resolveRlmSubagentModel`:
/// the exact match, then a unique catalog short form, then the parent
/// model when the catalog has no match; "Several catalog matches still
/// leave the reference unresolved"): a unique catalog suffix match
/// resolves before the session model backs the lookup, and several
/// matches leave the reference unresolved even when the session model
/// would back it.
#[test]
fn the_short_form_falls_back_in_the_documented_order() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path()).unwrap();
    std::fs::write(
        dir.path().join("models.json"),
        r#"{
          "providers": {
            "testprov": {
              "baseUrl": "http://localhost:9",
              "apiKey": "router-key",
              "api": "openai-completions",
              "models": [
                { "id": "internal/glm-5.3-fast", "name": "GLM 5.3 Fast", "contextWindow": 400000 },
                { "id": "nested/session-model", "name": "Nested Session Model", "contextWindow": 128000 }
              ]
            }
          }
        }"#,
    )
    .unwrap();
    let config = host_config(dir.path(), None, None);
    // A catalog model the exact matcher cannot reach by its slashed id
    // resolves by its unique short form.
    let (model, _, _) = resolve_action_model(&config, Some("glm-5.3-fast")).unwrap();
    assert_eq!(model.provider, "testprov");
    assert_eq!(model.id, "internal/glm-5.3-fast");
    // The unique catalog short form resolves before the session model
    // backs the lookup: "nested/session-model" and the session selector
    // both end with "/session-model", and the catalog model wins.
    let (model, _, _) = resolve_action_model(&config, Some("session-model")).unwrap();
    assert_eq!(model.id, "nested/session-model");
    assert_ne!(model.id, config.session_model.id);

    // Several catalog matches still leave the reference unresolved, even
    // though the session model would back the same short form.
    std::fs::write(
        dir.path().join("models.json"),
        r#"{
          "providers": {
            "testprov": {
              "baseUrl": "http://localhost:9",
              "apiKey": "router-key",
              "api": "openai-completions",
              "models": [
                { "id": "first/nested/session-model", "name": "First", "contextWindow": 128000 },
                { "id": "second/nested/session-model", "name": "Second", "contextWindow": 128000 }
              ]
            }
          }
        }"#,
    )
    .unwrap();
    let config = host_config(dir.path(), None, None);
    let error = resolve_action_model(&config, Some("session-model")).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("is unavailable, unauthenticated, or expired"),
        "unexpected error: {error}"
    );
}

/// A stale or expired session-model provider must fail the resolution
/// loudly (the TS parent-model branch: "a stale or expired provider has
/// to fail the spawn here instead of starting a child that fails its
/// first model request") instead of resolving the fallback model with a
/// dead credential. The catalog itself cannot carry the session model
/// here (the stale filter keeps the provider out of the searchable set),
/// so this pins the fallback's own gate, for the full form and the short
/// form alike.
#[test]
fn a_stale_session_model_provider_fails_instead_of_resolving() {
    let auth_data = crate::auth::types::AuthStorageData(
        json!({ "testprov": { "type": "api_key", "key": "stale-key" } })
            .as_object()
            .cloned()
            .unwrap_or_default(),
    );
    let mut auth = crate::auth::manager::AuthStorage::in_memory_without_env(
        &auth_data,
        std::sync::Arc::new(crate::auth::manager::NoOAuth),
    );
    assert!(auth.mark_auth_stale("testprov"));
    let registry = ModelRegistry::in_memory(auth);
    let dir = tempfile::tempdir().unwrap();
    let config = host_config(dir.path(), None, None);
    let selector = session_selector(&config);
    let error = resolve_reference(&registry, &config, &selector, &selector).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("is unavailable, unauthenticated, or expired"),
        "unexpected error: {error}"
    );
    // The gate covers the short form too: a bare-id reference to a stale
    // session model fails just as loudly.
    let error = resolve_reference(&registry, &config, "session-model", &selector).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("is unavailable, unauthenticated, or expired"),
        "unexpected error: {error}"
    );
}

/// A provider with no credential is not searchable: a reference to another
/// model on it reports the model as unavailable, unauthenticated, or
/// expired. The session model itself still resolves through the fallback
/// (TS: the parent model is in active use, and a provider with no
/// credential at all is neither stale nor expired; the auth preflight is
/// what passes or fails it).
#[test]
fn a_provider_without_a_credential_is_not_searchable() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path()).unwrap();
    std::fs::write(
        dir.path().join("models.json"),
        r#"{
          "providers": {
            "testprov": {
              "baseUrl": "http://localhost:9",
              "api": "openai-completions",
              "models": [
                { "id": "session-model", "name": "Session Model", "contextWindow": 128000 },
                { "id": "other-model", "name": "Other Model", "contextWindow": 128000 }
              ]
            }
          }
        }"#,
    )
    .unwrap();
    let config = host_config(dir.path(), None, None);
    let error = resolve_action_model(&config, Some("testprov/other-model")).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("is unavailable, unauthenticated, or expired"),
        "unexpected error: {error}"
    );
    let (model, api_key, _) = resolve_action_model(&config, None).unwrap();
    assert_eq!(model.id, "session-model");
    assert_eq!(api_key.as_deref(), None);
}

/// The scripted-session scenario at the handler level: a session model the
/// catalog does not carry (no models.json carries it) must still resolve
/// and reach the segment — the failure below is the adapter's, not the
/// model's (the pre-fix behavior errored "unavailable" before the segment).
#[tokio::test]
async fn the_registered_handler_runs_a_non_catalog_session_model() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path()).unwrap();
    let mut handlers = HostRequestHandlers::default();
    register_system_router_handlers(&mut handlers, host_config(dir.path(), None, None));
    let handler = handlers
        .get("system_router.run")
        .expect("the system_router.run handler is registered")
        .clone();
    let payload = HostRequestPayload {
        data: json!({
            "type": "system_router.run",
            "goal": "reach the overworld",
            "timeoutMs": 150,
            "actions": { "look": { "description": "Look at the screen." } },
            "environment": { "stdio": { "command": ["sh", "-c", "exit 0"] } }
        }),
        cell_source_code: None,
    };
    let error = handler(payload).await.unwrap_err().to_string();
    assert!(
        error.contains("environment adapter init failed")
            || error.contains("environment adapter failed to start"),
        "unexpected error: {error}"
    );
}

/// One registry round trip: the handler parses the spec, resolves the action
/// model and auth, and reaches the segment (whose adapter cannot start).
#[tokio::test]
async fn the_registered_handler_reaches_the_segment() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    let mut handlers = HostRequestHandlers::default();
    register_system_router_handlers(
        &mut handlers,
        host_config(dir.path(), None, Some(vec!["testprov/*".to_string()])),
    );
    let handler = handlers
        .get("system_router.run")
        .expect("the system_router.run handler is registered")
        .clone();
    let payload = HostRequestPayload {
        data: json!({
            "type": "system_router.run",
            "goal": "reach the overworld",
            "model": "testprov/action-model",
            "timeoutMs": 150,
            "actions": { "look": { "description": "Look at the screen." } },
            "environment": { "stdio": { "command": ["sh", "-c", "exit 0"] } }
        }),
        cell_source_code: None,
    };
    let error = handler(payload).await.unwrap_err().to_string();
    assert!(
        error.contains("environment adapter init failed")
            || error.contains("environment adapter failed to start"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn the_registered_handler_rejects_a_malformed_spec() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    let mut handlers = HostRequestHandlers::default();
    register_system_router_handlers(&mut handlers, host_config(dir.path(), None, None));
    let handler = handlers.get("system_router.run").unwrap().clone();
    let payload = HostRequestPayload {
        data: json!({ "type": "system_router.run" }),
        cell_source_code: None,
    };
    let error = handler(payload).await.unwrap_err().to_string();
    assert!(
        error.contains("system_router.run goal must be a non-empty string"),
        "{error}"
    );
}
