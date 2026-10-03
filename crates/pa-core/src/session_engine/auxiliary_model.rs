//! Auxiliary-model routing for background summarizer passes (TS #2411's
//! `_resolveAuxiliaryModel`): compaction and branch summaries resolve
//! their model through the `auxiliaryModel` setting, so their one-off
//! prompts run off the session model and the session's provider
//! prompt-cache prefix stays intact. An unset, equal, or unusable selector
//! falls back to the session model.

use std::path::PathBuf;

use pa_types::ai::Model;

/// The routing context: the working directory and agent directory the
/// settings (`auxiliaryModel`, `allowedModels`) and the model registry
/// (`models.json`, auth storage) resolve against. Embeddings wire one at
/// session assembly; `None` at a call site keeps the session model
/// (verification harnesses, in-memory sessions).
#[derive(Debug, Clone)]
pub struct AuxiliaryModelContext {
    pub cwd: PathBuf,
    pub agent_dir: PathBuf,
}

/// The session fallback for a summarizer call, WITH its merged request
/// headers: the registry (auth storage + models.json) is the single owner
/// of the team header, so a fallback call ships the session's team (the
/// session directory's prime CLI context, else the stored team) exactly
/// like the session's own requests (TS `_resolveAuxiliaryModel`'s fallback
/// resolves through the same storage the session request path uses).
pub(crate) fn session_fallback_with_headers(
    context: &AuxiliaryModelContext,
    session_model: &Model,
    session_api_key: Option<String>,
) -> ResolvedAuxiliaryModel {
    let mut registry = crate::models::ModelRegistry::for_session(&context.agent_dir, &context.cwd);
    let resolved = registry.get_api_key_and_headers(session_model, session_model.headers.as_ref());
    ResolvedAuxiliaryModel {
        model: session_model.clone(),
        api_key: session_api_key,
        headers: resolved.headers,
    }
}

/// One routed summarizer target: the model the pass runs on, the key it
/// sends, and the merged request headers its provider needs (TS
/// `_resolveAuxiliaryModel`'s `{ model, apiKey, headers }`). The session
/// fallback resolves its headers through the same registry the session's
/// own requests use.
#[derive(Debug, Clone)]
pub struct ResolvedAuxiliaryModel {
    pub model: Model,
    pub api_key: Option<String>,
    pub headers: Option<std::collections::BTreeMap<String, String>>,
}

/// The fallback warning (TS `_resolveAuxiliaryModel`'s `console.warn`).
/// The selector is logged, never the auth-stack error details: those can
/// embed credential material (TS `CodeQL` `js/clear-text-logging`).
fn warn_fallback(selector: &str, purpose: &str) {
    eprintln!(
        "Warning: auxiliaryModel \"{selector}\" unusable for {purpose}; using the session model."
    );
}

/// Resolve a background summarizer pass's model through the
/// `auxiliaryModel` setting (TS #2411's `_resolveAuxiliaryModel`).
///
/// `session_model` + `session_api_key` are the fallback the caller
/// resolved for its own turns; `required_context_tokens` is the size of
/// the request the pass will issue (None when unknown): a known auxiliary
/// context window smaller than the request falls back to the session
/// model instead of failing over-limit on the wire, and an unknown
/// window keeps the routing rather than guessing.
#[must_use]
pub fn resolve_auxiliary_model(
    context: &AuxiliaryModelContext,
    purpose: &str,
    session_model: &Model,
    session_api_key: Option<&str>,
    required_context_tokens: Option<u64>,
) -> ResolvedAuxiliaryModel {
    let fallback = || {
        session_fallback_with_headers(context, session_model, session_api_key.map(str::to_string))
    };
    let settings = crate::settings::SettingsManager::create(&context.cwd, &context.agent_dir);
    // A malformed or whitespace value behaves as unset (TS
    // `getAuxiliaryModel`): the pass falls back to the session model.
    let selector = settings
        .get_auxiliary_model()
        .map(|selector| selector.trim().to_lowercase())
        .filter(|selector| !selector.is_empty());
    let Some(selector) = selector else {
        return fallback();
    };
    if format!("{}/{}", session_model.provider, session_model.id).to_lowercase() == selector {
        return fallback();
    }
    // The daemon's `allowedModels` pin (rust-only guardrail, no TS
    // equivalent) covers every model the product could run a pass on: a
    // selector outside the pin falls back to the (allowlisted) session
    // model instead of calling a forbidden model. A summarizer must
    // never fail loudly over the guardrail.
    if let Some(allowlist) = settings.get_allowed_models() {
        if !crate::models::model_allowed(&selector, &allowlist) {
            warn_fallback(&selector, purpose);
            return fallback();
        }
    }
    // The TS find runs over the authenticated, non-stale catalog
    // (`_authenticatedRlmModels`); the registry's searchable set is the
    // same filter.
    let mut registry = crate::models::ModelRegistry::for_session(&context.agent_dir, &context.cwd);
    registry.load_private_authorization_from_cache();
    let model = registry
        .get_rlm_searchable_models()
        .into_iter()
        .find(|model| format!("{}/{}", model.provider, model.id).to_lowercase() == selector)
        .cloned();
    let Some(model) = model else {
        warn_fallback(&selector, purpose);
        return fallback();
    };
    let resolved = registry.get_api_key_and_headers(&model, model.headers.as_ref());
    if !resolved.ok {
        warn_fallback(&selector, purpose);
        return fallback();
    }
    if let Some(required) = required_context_tokens {
        if model.context_window > 0 && model.context_window < required {
            warn_fallback(&selector, purpose);
            return fallback();
        }
    }
    ResolvedAuxiliaryModel {
        model,
        api_key: resolved.api_key,
        headers: resolved.headers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, provider: &str, context_window: u64) -> Model {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "api": "openai-completions", "provider": provider,
            "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": context_window, "maxTokens": 100
        }))
        .unwrap()
    }

    /// The custom provider the auxiliary model lives under (an `apiKey` on
    /// the provider config is configured auth for the registry).
    const MODELS_JSON: &str = r#"{
      "providers": {
        "testaux": {
          "baseUrl": "http://localhost:9",
          "apiKey": "aux-key",
          "api": "openai-completions",
          "models": [ { "id": "aux-model", "name": "Aux Model", "contextWindow": 128000 } ]
        }
      }
    }"#;

    /// The tempdir must outlive the resolve call (the registry reads
    /// models.json on demand); each test keeps the handle in scope.
    fn context_with_settings(
        settings: &serde_json::Value,
    ) -> (tempfile::TempDir, AuxiliaryModelContext) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            serde_json::to_string_pretty(&settings).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.path().join("models.json"), MODELS_JSON).unwrap();
        let context = AuxiliaryModelContext {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().to_path_buf(),
        };
        (dir, context)
    }

    /// The session fallback resolves its MERGED headers through the same
    /// registry the session's own requests use (Cursor PR #2755: with the
    /// provider-side team-header fallback deleted, the fallback summarizer
    /// call is the only other path that must carry the stored team).
    #[test]
    fn the_session_fallback_keeps_the_merged_headers() {
        let (dir, context) = context_with_settings(&serde_json::json!({}));
        std::fs::write(
            dir.path().join("auth.json"),
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
        let session = model("session-model", "prime-inference", 8_000);
        let routed = session_fallback_with_headers(&context, &session, Some("override".into()));
        assert_eq!(routed.model.id, "session-model");
        assert_eq!(routed.api_key.as_deref(), Some("override"));
        let headers = routed.headers.expect("the fallback keeps merged headers");
        assert_eq!(
            headers.get("X-Prime-Team-ID").map(String::as_str),
            Some("team-1"),
            "the stored team ships on the fallback summarizer call"
        );
    }

    /// A session directory pinned to a Prime team (`prime switch <team>
    /// --local`) bills its summarizer passes to that team, like the
    /// session's own turns: both the session fallback and a routed
    /// `auxiliaryModel` resolve the directory context.
    #[test]
    fn summarizer_passes_carry_the_session_directory_team() {
        let (dir, context) = context_with_settings(&serde_json::json!({
            "auxiliaryModel": "prime-inference/z-ai/glm-5.3",
        }));
        std::fs::write(
            dir.path().join("auth.json"),
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
        std::fs::create_dir_all(dir.path().join(".prime")).unwrap();
        std::fs::write(
            dir.path().join(".prime/context.json"),
            r#"{"team_id": "pinned-team"}"#,
        )
        .unwrap();
        let team = |routed: &ResolvedAuxiliaryModel| {
            routed
                .headers
                .as_ref()
                .and_then(|headers| headers.get("X-Prime-Team-ID").cloned())
        };
        let session = model("session-model", "prime-inference", 8_000);
        let fallback = session_fallback_with_headers(&context, &session, None);
        assert_eq!(team(&fallback).as_deref(), Some("pinned-team"));
        let routed = resolve_auxiliary_model(&context, "compaction summary", &session, None, None);
        assert_eq!(routed.model.id, "z-ai/glm-5.3");
        assert_eq!(team(&routed).as_deref(), Some("pinned-team"));
    }

    #[test]
    fn unset_selector_keeps_the_session_model() {
        let (_dir, context) = context_with_settings(&serde_json::json!({}));
        let session = model("session-model", "faux", 8_000);
        let routed = resolve_auxiliary_model(
            &context,
            "compaction summary",
            &session,
            Some("session-key"),
            None,
        );
        assert_eq!(routed.model.id, "session-model");
        assert_eq!(routed.api_key.as_deref(), Some("session-key"));
    }

    #[test]
    fn selector_equal_to_the_session_model_keeps_the_session_model() {
        let (_dir, context) =
            context_with_settings(&serde_json::json!({ "auxiliaryModel": "faux/session-model" }));
        let session = model("session-model", "faux", 8_000);
        let routed = resolve_auxiliary_model(
            &context,
            "compaction summary",
            &session,
            Some("session-key"),
            None,
        );
        assert_eq!(routed.model.id, "session-model");
        assert_eq!(routed.api_key.as_deref(), Some("session-key"));
    }

    #[test]
    fn configured_selector_routes_to_the_auxiliary_model() {
        let (_dir, context) =
            context_with_settings(&serde_json::json!({ "auxiliaryModel": "testaux/aux-model" }));
        let session = model("session-model", "faux", 8_000);
        let routed = resolve_auxiliary_model(
            &context,
            "compaction summary",
            &session,
            Some("session-key"),
            None,
        );
        assert_eq!(routed.model.id, "aux-model");
        // The auxiliary call runs on the auxiliary model's own key, never
        // the session's.
        assert_eq!(routed.api_key.as_deref(), Some("aux-key"));
        // The fallback carries no headers.
        assert_eq!(routed.headers, None);
    }

    #[test]
    fn unknown_selector_falls_back_to_the_session_model() {
        let (_dir, context) =
            context_with_settings(&serde_json::json!({ "auxiliaryModel": "testaux/missing" }));
        let session = model("session-model", "faux", 8_000);
        let routed = resolve_auxiliary_model(
            &context,
            "branch summary",
            &session,
            Some("session-key"),
            None,
        );
        assert_eq!(routed.model.id, "session-model");
        assert_eq!(routed.api_key.as_deref(), Some("session-key"));
    }

    #[test]
    fn too_small_window_falls_back_to_the_session_model() {
        let (_dir, context) =
            context_with_settings(&serde_json::json!({ "auxiliaryModel": "testaux/aux-model" }));
        let session = model("session-model", "faux", 8_000);
        // The required size exceeds the auxiliary window (128000): the
        // routing falls back instead of failing over-limit on the wire.
        let routed = resolve_auxiliary_model(
            &context,
            "compaction summary",
            &session,
            Some("session-key"),
            Some(200_000),
        );
        assert_eq!(routed.model.id, "session-model");
        // A window that fits keeps the routing.
        let routed = resolve_auxiliary_model(
            &context,
            "compaction summary",
            &session,
            Some("session-key"),
            Some(1_000),
        );
        assert_eq!(routed.model.id, "aux-model");
    }

    #[test]
    fn selector_outside_the_allowlist_falls_back() {
        let (_dir, context) = context_with_settings(&serde_json::json!({
            "auxiliaryModel": "testaux/aux-model",
            "allowedModels": ["faux/session-model"],
        }));
        let session = model("session-model", "faux", 8_000);
        let routed = resolve_auxiliary_model(
            &context,
            "compaction summary",
            &session,
            Some("session-key"),
            None,
        );
        assert_eq!(routed.model.id, "session-model");
        assert_eq!(routed.api_key.as_deref(), Some("session-key"));
    }
}
