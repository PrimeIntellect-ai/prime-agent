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
    /// registry's available catalog, switch the engine, record the durable
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
                    let _ = store.append_model_change(&provider, &model_id);
                    let _ = store.rewrite();
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
                    let _ = store.append_thinking_level_change(&effective);
                    let _ = store.rewrite();
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
        let model =
            resolve_available_model(dir.path(), "prime-inference", "mock-1").expect("resolves");
        assert_eq!(model.id, "mock-1");
        let error = resolve_available_model(dir.path(), "prime-inference", "nope")
            .expect_err("unknown model fails");
        assert_eq!(error.to_string(), "Model not found: prime-inference/nope");
    }
}
