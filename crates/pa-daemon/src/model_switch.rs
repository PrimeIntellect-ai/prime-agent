//! The live model/thinking switches: the worker arms for the daemon
//! `set_model` and `set_thinking_level` commands (TS daemon-mode
//! `case "set_model"` / `case "set_thinking_level"`). The engine owns the
//! runtime switch (agent model, provider target, effective level); this
//! module owns the wire contract: resolution through the registry, the
//! durable `model_change` / `thinking_level_change` rows, the settings
//! defaults the TS session persists on a switch, and the response data.

use serde_json::Value;

use crate::engine::EngineModelSelection;
use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

/// The wire levels a thinking switch accepts (TS `ThinkingLevel`).
const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

impl Worker {
    /// `set_model { provider, modelId }`: resolve the model through the
    /// registry's available catalog, enforce the daemon model allowlist
    /// (settings `allowedModels`: a model outside the allowlist fails
    /// loudly, never a fallback), switch the engine, record the durable
    /// `model_change` row, and persist the settings default (TS
    /// `session.setModel`). Unknown models fail with the TS message. The
    /// engine switch parks the engine's runtime, so it runs on the blocking
    /// pool like the turn path.
    pub(crate) async fn handle_set_model(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_model") {
            return response;
        }
        let Some(provider) = payload.get("provider").and_then(Value::as_str) else {
            return response_failure(None, "set_model", "set_model requires a provider", None);
        };
        let Some(model_id) = payload.get("modelId").and_then(Value::as_str) else {
            return response_failure(None, "set_model", "set_model requires a modelId", None);
        };
        let model = match resolve_available_model(&self.config.agent_dir, provider, model_id) {
            Ok(model) => model,
            Err(error) => return response_failure(None, "set_model", &error.to_string(), None),
        };
        // The daemon model allowlist (settings `allowedModels`): a switch
        // to a model outside the allowlist fails loudly — the daemon never
        // falls back to a different route — and the refusal emits the
        // adoption event (`model refused`) through the worker engine.
        let selector = format!("{provider}/{model_id}");
        let cwd = {
            let core = self.core.lock().unwrap();
            core.cwd.clone()
        };
        let allowlist =
            crate::model_allowlist::load(std::path::Path::new(&cwd), &self.config.agent_dir);
        if let Err(refusal) = crate::model_allowlist::assert_allowed(Some(&allowlist), &selector) {
            if let Some(agent_engine) = &self.agent_engine {
                agent_engine.note_model_refused("set_model", &selector);
            }
            return response_failure(None, "set_model", &refusal.to_string(), None);
        }
        let engine = std::sync::Arc::clone(&self.engine);
        let core = std::sync::Arc::clone(&self.core);
        let agent_dir = self.config.agent_dir.clone();
        let provider = provider.to_string();
        let model_id = model_id.to_string();
        let switched = tokio::task::spawn_blocking(move || {
            if !engine.switch_model(EngineModelSelection {
                provider: Some(provider.clone()),
                model: Some(model_id.clone()),
                api_key: None,
                thinking: None,
            }) {
                return None;
            }
            let cwd = {
                let mut core = core.lock().unwrap();
                if let Some(store) = core.store.as_mut() {
                    // TS `appendModelChange` records every switch, even to
                    // the current model.
                    let _ = store.persist_entry(
                        "model_change",
                        serde_json::json!({ "provider": provider, "modelId": model_id }),
                    );
                }
                core.cwd.clone()
            };
            // TS `session.setModel` persists the default provider/model so
            // the next session starts on the switched model.
            let mut settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
            let _ = settings.set_default_model_and_provider(provider, model_id);
            Some(())
        })
        .await
        .unwrap_or(None);
        if switched.is_none() {
            return response_failure(
                None,
                "set_model",
                "This session does not support model switching",
                None,
            );
        }
        response_success(
            None,
            "set_model",
            Some(serde_json::to_value(&model).unwrap_or(Value::Null)),
        )
    }

    /// `set_thinking_level { level }`: apply the requested level through the
    /// engine (clamped to the model's supported levels) and record the
    /// durable `thinking_level_change` row only when the effective level
    /// changed (TS `session.setThinkingLevel`). The settings default
    /// follows like the TS session's `setDefaultThinkingLevel`. The engine
    /// switch parks the engine's runtime, so it runs on the blocking pool.
    pub(crate) async fn handle_set_thinking_level(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_thinking_level") {
            return response;
        }
        let Some(level) = payload.get("level").and_then(Value::as_str) else {
            return response_failure(
                None,
                "set_thinking_level",
                "Invalid thinking level: expected a string",
                None,
            );
        };
        let Some(parsed) = pa_ai::models::thinking_level_from_str(level) else {
            return response_failure(
                None,
                "set_thinking_level",
                &format!(
                    "Invalid thinking level \"{level}\". Valid values: {}",
                    THINKING_LEVELS.join(", ")
                ),
                None,
            );
        };
        let previous = self.engine.effective_thinking_level();
        let engine = std::sync::Arc::clone(&self.engine);
        let core = std::sync::Arc::clone(&self.core);
        let agent_dir = self.config.agent_dir.clone();
        let reasoning = self
            .engine
            .model_metadata()
            .and_then(|model| model.get("reasoning").and_then(Value::as_bool))
            .unwrap_or(false);
        let applied = tokio::task::spawn_blocking(move || {
            if !engine.switch_thinking_level(parsed) {
                return None;
            }
            let effective = engine
                .effective_thinking_level()
                .unwrap_or_else(|| "off".to_string());
            // TS records the durable row only when the effective level
            // changed.
            if previous.as_deref() == Some(effective.as_str()) {
                return Some(effective);
            }
            let cwd = {
                let mut core = core.lock().unwrap();
                if let Some(store) = core.store.as_mut() {
                    let _ = store.persist_entry(
                        "thinking_level_change",
                        serde_json::json!({ "thinkingLevel": effective }),
                    );
                }
                core.cwd.clone()
            };
            // TS persists the default when the model can think or the level
            // is a real reasoning request; the persisted value is the
            // clamped effective level, not the raw request.
            if reasoning || effective != "off" {
                let effective_level = pa_ai::models::thinking_level_from_str(&effective)
                    .expect("the engine reports a valid wire level");
                let mut settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
                let _ = settings.set_default_thinking_level(
                    pa_core::settings::ThinkingLevelSetting::from_model_level(effective_level),
                );
            }
            Some(effective)
        })
        .await
        .unwrap_or(None);
        if applied.is_none() {
            return response_failure(
                None,
                "set_thinking_level",
                "This session does not support thinking levels",
                None,
            );
        }
        response_success(None, "set_thinking_level", None)
    }
}

/// Resolve one `(provider, modelId)` pair against the registry's available
/// catalog (auth-configured models). The TS `set_model` handler looks the
/// model up in the refreshed available list, so an unavailable or unknown
/// model fails with the same message.
fn resolve_available_model(
    agent_dir: &std::path::Path,
    provider: &str,
    model_id: &str,
) -> anyhow::Result<pa_types::ai::Model> {
    let auth = pa_core::auth::AuthStorage::create(agent_dir);
    let mut registry = pa_core::models::ModelRegistry::create(auth, agent_dir.join("models.json"));
    registry.load_private_authorization_from_cache();
    registry
        .get_available()
        .into_iter()
        .find(|model| model.provider == provider && model.id == model_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Model not found: {provider}/{model_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn worker_config(dir: &std::path::Path) -> crate::worker::WorkerConfig {
        crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "allowlist-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        }
    }

    /// A models.json fixture the `set_model` resolution reads (same shape
    /// as the setting-switches tests).
    fn models_fixture(dir: &std::path::Path) {
        std::fs::create_dir_all(dir.join("agent")).expect("agent dir");
        std::fs::write(
            dir.join("agent").join("models.json"),
            json!({
                "providers": {
                    "prime-inference": {
                        "api": "openai-completions",
                        "baseUrl": "http://127.0.0.1:9/v1",
                        "apiKey": "sk-test",
                        "models": [
                            { "id": "mock-1", "name": "Mock 1", "api": "openai-completions",
                              "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128000,
                              "maxTokens": 4096 }
                        ]
                    }
                }
            })
            .to_string(),
        )
        .expect("write models.json");
    }

    /// The daemon model allowlist enforcement point: `set_model` refuses a
    /// resolvable model outside settings `allowedModels` loudly (never a
    /// fallback), and an allowing allowlist (or none) keeps the switch
    /// path — the scripted harness then fails past the gate with its own
    /// non-switching refusal, proving the gate opened.
    #[tokio::test]
    async fn set_model_refuses_models_outside_the_allowlist() {
        async fn dispatch_set_model(
            worker: &std::sync::Arc<crate::worker::Worker>,
        ) -> crate::protocol::DaemonResponse {
            worker
                .dispatch(
                    "set_model",
                    &json!({
                        "activeSessionId": "allowlist-session",
                        "provider": "prime-inference",
                        "modelId": "mock-1"
                    }),
                )
                .await
        }

        // An allowlist that pins a different provider refuses the switch
        // with the loud message.
        let dir = std::env::temp_dir().join(format!("pa-worker-al-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        models_fixture(&dir);
        std::fs::write(
            dir.join("agent").join("settings.json"),
            json!({ "allowedModels": ["anthropic/*"] }).to_string(),
        )
        .unwrap();
        let worker = std::sync::Arc::new(crate::worker::Worker::new(worker_config(&dir), None));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": dir }))
            .await;
        assert!(created.success, "create failed: {created:?}");
        let response = dispatch_set_model(&worker).await;
        assert!(!response.success);
        assert_eq!(response.command, "set_model");
        assert_eq!(
            response.error.as_deref(),
            Some("Model \"prime-inference/mock-1\" is blocked by the daemon model allowlist (settings \"allowedModels\"); the daemon never falls back to a different model. Allow it in the settings or pick an allowed model.")
        );

        // An allowing allowlist (a matching glob) opens the gate: the
        // scripted engine then fails with its own non-switching message.
        std::fs::write(
            dir.join("agent").join("settings.json"),
            json!({ "allowedModels": ["prime-inference/*"] }).to_string(),
        )
        .unwrap();
        let response = dispatch_set_model(&worker).await;
        assert!(
            !response.success,
            "the scripted harness does not switch models"
        );
        assert_eq!(
            response.error.as_deref(),
            Some("This session does not support model switching")
        );

        // No allowlist configured: the TS behavior (the gate is a no-op).
        std::fs::remove_file(dir.join("agent").join("settings.json")).unwrap();
        let response = dispatch_set_model(&worker).await;
        assert_eq!(
            response.error.as_deref(),
            Some("This session does not support model switching")
        );
    }

    #[test]
    fn thinking_levels_wire_names_match_the_enum() {
        // Every wire name must parse; the list is the exact TS `ThinkingLevel`
        // vocabulary.
        for level in THINKING_LEVELS {
            assert!(
                pa_ai::models::thinking_level_from_str(level).is_some(),
                "{level} must parse"
            );
        }
        assert!(pa_ai::models::thinking_level_from_str("sideways").is_none());
    }

    #[test]
    fn resolution_errors_carry_the_ts_message() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("models.json"),
            serde_json::json!({
                "providers": {
                    "prime-inference": {
                        "api": "openai-completions",
                        "baseUrl": "http://127.0.0.1:9/v1",
                        "apiKey": "sk-test",
                        "models": [
                            { "id": "mock-1", "name": "Mock 1", "api": "openai-completions",
                              "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128000,
                              "maxTokens": 4096 }
                        ]
                    }
                }
            })
            .to_string(),
        )
        .expect("write models.json");
        let model =
            resolve_available_model(dir.path(), "prime-inference", "mock-1").expect("resolves");
        assert_eq!(model.id, "mock-1");
        let error = resolve_available_model(dir.path(), "prime-inference", "nope")
            .expect_err("unknown model fails");
        assert_eq!(error.to_string(), "Model not found: prime-inference/nope");
    }
}
