//! The model/setting switches (protocol breadth wave b3): the worker arms
//! for the daemon commands that flip live session settings — `cycle_model`,
//! `set_scoped_models`, `cycle_thinking_level`, `set_service_tier`,
//! `set_transport`, `set_steering_mode`, `set_follow_up_mode`,
//! `set_auto_compaction`, `set_auto_retry`, `abort_retry` (TS daemon-mode
//! cases). The wire
//! contracts are TS-verbatim; the durable rows and settings defaults follow
//! the same TS session methods the existing `set_model` /
//! `set_thinking_level` arms port.

use serde_json::{json, Value};

use pa_types::ai::{ServiceTier, Transport};

use crate::engine::EngineModelSelection;
use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

/// The queue-mode wire vocabulary (TS `AgentConnectionQueueMode`).
const QUEUE_MODES: &[&str] = &["all", "one-at-a-time"];

/// TS `supportsFastMode`: the fast-mode (priority) tier exists on
/// gpt-5.4/5.5/5.6 models served over the responses APIs.
pub(crate) fn supports_fast_mode(model_id: &str) -> bool {
    let eligible = model_id == "gpt-5.4"
        || model_id == "gpt-5.5"
        || model_id == "gpt-5.6"
        || model_id.starts_with("gpt-5.6-");
    // The provider check needs the full model; this worker-side helper is
    // keyed on the model id only (the eligible ids are exclusive to the
    // responses providers), matching the TS eligibility list.
    eligible
}

/// The wire name of a service tier (the serde lowercase form).
pub(crate) fn service_tier_wire_name(tier: ServiceTier) -> &'static str {
    match tier {
        ServiceTier::Auto => "auto",
        ServiceTier::Default => "default",
        ServiceTier::Flex => "flex",
        ServiceTier::Scale => "scale",
        ServiceTier::Priority => "priority",
    }
}

/// TS `_getEffectiveServiceTier`: a `priority` request on a model without
/// fast mode degrades to `default`; every other tier passes through.
/// `None` (the settings default "auto") passes as `Auto`.
pub(crate) fn effective_service_tier(
    tier: Option<ServiceTier>,
    fast_mode: bool,
) -> Option<ServiceTier> {
    match tier {
        Some(ServiceTier::Priority) if !fast_mode => Some(ServiceTier::Default),
        other => other,
    }
}

/// The model's fast-mode support as the worker sees it (the engine's
/// resolved model metadata, when there is one).
fn engine_fast_mode(engine: &dyn crate::engine::SessionEngine) -> bool {
    let model = engine.model_metadata();
    model
        .as_ref()
        .and_then(|model| model.get("id"))
        .and_then(Value::as_str)
        .map(supports_fast_mode)
        .unwrap_or(false)
}

impl Worker {
    /// `cycle_model { direction? }` (TS `session.cycleModel`): cycle within
    /// the scoped model list when one is set (each entry clamped to the
    /// available catalog), else within the available catalog. Fewer than
    /// two candidates answer success with `null` data, like TS.
    pub(crate) async fn handle_cycle_model(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("cycle_model") {
            return response;
        }
        let backward = payload.get("direction").and_then(Value::as_str) == Some("backward");
        let (scoped, current) = {
            let core = self.core.lock().unwrap();
            (
                core.scoped_models.clone(),
                self.engine.model_metadata().and_then(|model| {
                    Some((
                        model.get("provider")?.as_str()?.to_string(),
                        model.get("id")?.as_str()?.to_string(),
                    ))
                }),
            )
        };
        // The candidate list: scoped entries (available ones only), else
        // the available catalog (TS `_cycleScopedModel` / `_cycleAvailableModel`).
        let registry = crate::state_getters::worker_model_registry(&self.config.agent_dir);
        let available: Vec<pa_types::ai::Model> =
            registry.get_available().into_iter().cloned().collect();
        let is_scoped = !scoped.is_empty();
        let candidates: Vec<(Option<String>, Option<pa_types::ai::Model>)> = if is_scoped {
            scoped
                .iter()
                .filter_map(|entry| {
                    let model = entry.get("model")?;
                    let provider = model.get("provider")?.as_str()?;
                    let id = model.get("id")?.as_str()?;
                    available
                        .iter()
                        .find(|candidate| candidate.provider == provider && candidate.id == id)
                        .map(|candidate| {
                            (
                                entry
                                    .get("thinkingLevel")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                Some(candidate.clone()),
                            )
                        })
                })
                .collect()
        } else {
            available
                .into_iter()
                .map(|model| (None, Some(model)))
                .collect()
        };
        if candidates.len() <= 1 {
            // TS `result ?? null`: no cycle happened.
            return response_success(None, "cycle_model", Some(Value::Null));
        }
        let current_index = current
            .and_then(|(provider, id)| {
                candidates.iter().position(|(_, candidate)| {
                    candidate
                        .as_ref()
                        .is_some_and(|model| model.provider == provider && model.id == id)
                })
            })
            .unwrap_or(0);
        let len = candidates.len();
        let next_index = if backward {
            (current_index + len - 1) % len
        } else {
            (current_index + 1) % len
        };
        let (scoped_thinking, next_model) =
            candidates.get(next_index).cloned().unwrap_or((None, None));
        let Some(next_model) = next_model else {
            return response_success(None, "cycle_model", Some(Value::Null));
        };
        let provider = next_model.provider.clone();
        let model_id = next_model.id.clone();
        let engine = std::sync::Arc::clone(&self.engine);
        let core = std::sync::Arc::clone(&self.core);
        let agent_dir = self.config.agent_dir.clone();
        let switched = tokio::task::spawn_blocking(move || {
            if !engine.switch_model(EngineModelSelection {
                provider: Some(provider.clone()),
                model: Some(model_id.clone()),
                api_key: None,
                thinking: None,
            }) {
                return None;
            }
            // A scoped entry may pin the level for the switched-to model
            // (TS `_getThinkingLevelForModelSwitch(next.thinkingLevel)`).
            if let Some(level) = scoped_thinking
                .as_deref()
                .and_then(pa_ai::models::thinking_level_from_str)
            {
                if !engine.switch_thinking_level(level) {
                    return None;
                }
            }
            let cwd = {
                let mut core = core.lock().unwrap();
                if let Some(store) = core.store.as_mut() {
                    // TS `appendModelChange` records every switch.
                    let _ = store.append_model_change(&provider, &model_id);
                    let _ = store.rewrite();
                }
                core.cwd.clone()
            };
            // TS persists the default so the next session starts here.
            let mut settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
            let _ = settings.set_default_model_and_provider(provider, model_id);
            Some(())
        })
        .await
        .unwrap_or(None);
        if switched.is_none() {
            return response_failure(
                None,
                "cycle_model",
                "This session does not support model switching",
                None,
            );
        }
        // The new model may not keep the priority tier (TS
        // `_clampServiceTierForModel`).
        self.clamp_service_tier_for_model();
        let (thinking_level, service_tier) = {
            let core = self.core.lock().unwrap();
            (
                self.engine
                    .effective_thinking_level()
                    .unwrap_or_else(|| "off".to_string()),
                effective_service_tier(core.service_tier, engine_fast_mode(self.engine.as_ref()))
                    .unwrap_or(ServiceTier::Auto),
            )
        };
        response_success(
            None,
            "cycle_model",
            Some(json!({
                "model": next_model,
                "thinkingLevel": thinking_level,
                "serviceTier": service_tier_wire_name(service_tier),
                "isScoped": is_scoped,
            })),
        )
    }

    /// Re-clamp the effective service tier for the engine's current model
    /// (TS `_clampServiceTierForModel` on a model switch): a `priority`
    /// preference on a model without fast mode degrades to `default` and
    /// the `service_tier_changed` session event follows the flip.
    fn clamp_service_tier_for_model(&self) {
        let (previous, fast_mode) = {
            let core = self.core.lock().unwrap();
            (
                effective_service_tier(core.service_tier, true).unwrap_or(ServiceTier::Auto),
                engine_fast_mode(self.engine.as_ref()),
            )
        };
        let effective = effective_service_tier(Some(previous), fast_mode).unwrap_or(previous);
        if effective != previous {
            self.emit_worker_event(json!({
                "type": "service_tier_changed",
                "serviceTier": service_tier_wire_name(effective),
            }));
        }
    }

    /// `set_scoped_models { scopedModels }` (TS
    /// `session.setScopedModels`): store the scoped model list the cycler
    /// and the connection state surface.
    pub(crate) fn handle_set_scoped_models(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_scoped_models") {
            return response;
        }
        let Some(scoped) = payload.get("scopedModels").and_then(Value::as_array) else {
            return response_failure(
                None,
                "set_scoped_models",
                "set_scoped_models requires a scopedModels array",
                None,
            );
        };
        for entry in scoped {
            let model = entry
                .get("model")
                .and_then(Value::as_object)
                .filter(|model| {
                    model.get("provider").and_then(Value::as_str).is_some()
                        && model.get("id").and_then(Value::as_str).is_some()
                });
            if model.is_none() {
                return response_failure(
                    None,
                    "set_scoped_models",
                    "set_scoped_models requires scopedModels entries with a model",
                    None,
                );
            }
            if let Some(level) = entry.get("thinkingLevel") {
                if level
                    .as_str()
                    .and_then(pa_ai::models::thinking_level_from_str)
                    .is_none()
                {
                    return response_failure(
                        None,
                        "set_scoped_models",
                        "Invalid thinking level: expected one of off, minimal, low, medium, high, xhigh, max",
                        None,
                    );
                }
            }
        }
        self.core.lock().unwrap().scoped_models = scoped.clone();
        response_success(None, "set_scoped_models", None)
    }

    /// `cycle_thinking_level` (TS `session.cycleThinkingLevel`): models
    /// without reasoning answer success with `null` data; reasoning models
    /// cycle through their supported levels (the same durable-row and
    /// settings flow as `set_thinking_level`).
    pub(crate) async fn handle_cycle_thinking_level(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("cycle_thinking_level") {
            return response;
        }
        // TS `supportsThinking()`: the model must support reasoning.
        let reasoning = self
            .engine
            .model_metadata()
            .and_then(|model| model.get("reasoning").and_then(Value::as_bool))
            .unwrap_or(false);
        if !reasoning {
            return response_success(None, "cycle_thinking_level", Some(Value::Null));
        }
        let levels = self
            .engine
            .supported_thinking_levels()
            .unwrap_or_else(|| vec!["off".to_string()]);
        if levels.is_empty() {
            return response_success(None, "cycle_thinking_level", Some(Value::Null));
        }
        let current = self
            .engine
            .effective_thinking_level()
            .unwrap_or_else(|| "off".to_string());
        // TS: `indexOf` -1 cycles to the first level.
        let index = levels.iter().position(|level| *level == current);
        let next = match index {
            Some(index) => &levels[(index + 1) % levels.len()],
            None => &levels[0],
        };
        let applied = self
            .handle_set_thinking_level(&json!({ "level": next }))
            .await;
        if !applied.success {
            return applied;
        }
        response_success(None, "cycle_thinking_level", Some(json!({ "level": next })))
    }

    /// `set_service_tier { serviceTier }` (TS `session.setServiceTier`):
    /// record the preference, the durable `service_tier_change` row on a
    /// change, the settings default (when the model supports fast mode),
    /// and the `service_tier_changed` event on an effective change. An
    /// unchanged request answers success without side effects.
    pub(crate) fn handle_set_service_tier(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_service_tier") {
            return response;
        }
        let Some(tier) = payload
            .get("serviceTier")
            .cloned()
            .filter(|value| !value.is_null())
            .and_then(|value| serde_json::from_value::<ServiceTier>(value).ok())
        else {
            return response_failure(
                None,
                "set_service_tier",
                "set_service_tier requires a serviceTier",
                None,
            );
        };
        let fast_mode = engine_fast_mode(self.engine.as_ref());
        let effective = effective_service_tier(Some(tier), fast_mode).unwrap_or(tier);
        let (preference_changed, effective_changed, cwd) = {
            let mut core = self.core.lock().unwrap();
            let preference = core.service_tier;
            let previous_effective =
                effective_service_tier(preference, fast_mode).unwrap_or(ServiceTier::Auto);
            core.service_tier = Some(tier);
            let effective_changed = previous_effective != effective;
            let preference_changed = preference != Some(tier);
            let mut cwd = core.cwd.clone();
            if preference_changed {
                if let Some(store) = core.store.as_mut() {
                    // The same durable row the creation prefix writes (TS
                    // `appendServiceTierChange`).
                    let _ = store
                        .append_entry("service_tier_change", json!({ "serviceTier": effective }));
                    let _ = store.rewrite();
                }
                cwd = core.cwd.clone();
            }
            (preference_changed, effective_changed, cwd)
        };
        if preference_changed && fast_mode {
            // TS persists the default only when the model keeps fast mode.
            let mut settings =
                pa_core::settings::SettingsManager::create(&cwd, &self.config.agent_dir);
            let _ = settings.set_default_service_tier(effective);
        }
        if effective_changed {
            self.emit_worker_event(json!({
                "type": "service_tier_changed",
                "serviceTier": service_tier_wire_name(effective),
            }));
        }
        response_success(None, "set_service_tier", None)
    }

    /// `set_transport { transport }` (TS `settingsManager.setTransport` +
    /// `agent.transport`): persist the transport setting. The live stream
    /// resolves transport per request from settings in this port, so the
    /// persisted default is the whole switch.
    pub(crate) fn handle_set_transport(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_transport") {
            return response;
        }
        let transport = payload
            .get("transport")
            .cloned()
            .and_then(|value| serde_json::from_value::<Transport>(value).ok());
        let Some(transport) = transport else {
            return response_failure(
                None,
                "set_transport",
                "set_transport requires a transport",
                None,
            );
        };
        let core = self.core.lock().unwrap();
        let cwd = core.cwd.clone();
        drop(core);
        let setting = match transport {
            Transport::Auto => pa_core::settings::TransportSetting::Auto,
            Transport::Sse => pa_core::settings::TransportSetting::Sse,
            Transport::Websocket | Transport::WebsocketCached => {
                pa_core::settings::TransportSetting::WebSocket
            }
        };
        let mut settings = pa_core::settings::SettingsManager::create(&cwd, &self.config.agent_dir);
        if let Err(error) = settings.set_transport(setting) {
            return response_failure(None, "set_transport", &error.to_string(), None);
        }
        response_success(None, "set_transport", None)
    }

    /// `set_steering_mode` / `set_follow_up_mode { mode }` (TS
    /// `session.setSteeringMode` / `setFollowUpMode`): the queue delivery
    /// mode, persisted to settings and surfaced on the connection state.
    pub(crate) fn handle_set_queue_mode(&self, command: &str, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created(command) {
            return response;
        }
        let Some(mode) = payload.get("mode").and_then(Value::as_str) else {
            return response_failure(
                None,
                command,
                &format!("{command} requires mode \"all\" or \"one-at-a-time\""),
                None,
            );
        };
        if !QUEUE_MODES.contains(&mode) {
            return response_failure(
                None,
                command,
                &format!("{command} requires mode \"all\" or \"one-at-a-time\""),
                None,
            );
        }
        let setting = match mode {
            "all" => pa_core::settings::QueueModeSetting::All,
            _ => pa_core::settings::QueueModeSetting::OneAtATime,
        };
        {
            let mut core = self.core.lock().unwrap();
            if command == "set_steering_mode" {
                core.steering_mode = mode.to_string();
            } else {
                core.follow_up_mode = mode.to_string();
            }
        }
        let core = self.core.lock().unwrap();
        let cwd = core.cwd.clone();
        drop(core);
        let mut settings = pa_core::settings::SettingsManager::create(&cwd, &self.config.agent_dir);
        let persisted = if command == "set_steering_mode" {
            settings.set_steering_mode(setting)
        } else {
            settings.set_follow_up_mode(setting)
        };
        if let Err(error) = persisted {
            return response_failure(None, command, &error.to_string(), None);
        }
        response_success(None, command, None)
    }

    /// `set_auto_retry { enabled }` (TS `session.setAutoRetryEnabled`):
    /// the provider retry policy reads the setting on every turn.
    pub(crate) fn handle_set_auto_retry(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_auto_retry") {
            return response;
        }
        let Some(enabled) = payload.get("enabled").and_then(Value::as_bool) else {
            return response_failure(
                None,
                "set_auto_retry",
                "set_auto_retry requires enabled",
                None,
            );
        };
        let core = self.core.lock().unwrap();
        let cwd = core.cwd.clone();
        drop(core);
        let mut settings = pa_core::settings::SettingsManager::create(&cwd, &self.config.agent_dir);
        if let Err(error) = settings.set_retry_enabled(enabled) {
            return response_failure(None, "set_auto_retry", &error.to_string(), None);
        }
        response_success(None, "set_auto_retry", None)
    }

    /// `set_auto_compaction { enabled }` (TS `session.setAutoCompactionEnabled`
    /// → `settingsManager.setCompactionEnabled`): the connection-state flag
    /// and the settings value change together — TS's connection state reads
    /// the settings manager, so the persisted write is the change and a
    /// restarted session re-seeds its flag from it. A failed settings save
    /// fails the command without flipping the flag.
    pub(crate) fn handle_set_auto_compaction(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_auto_compaction") {
            return response;
        }
        let enabled = payload
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let core = self.core.lock().unwrap();
        let cwd = core.cwd.clone();
        drop(core);
        let mut settings = pa_core::settings::SettingsManager::create(&cwd, &self.config.agent_dir);
        if let Err(error) = settings.set_compaction_enabled(enabled) {
            return response_failure(None, "set_auto_compaction", &error.to_string(), None);
        }
        self.compaction.set_auto_compaction(enabled);
        response_success(None, "set_auto_compaction", None)
    }

    /// `abort_retry` (TS `session.abortRetry`): stop an in-flight retry.
    /// The turn's abort probe reads the flag (the retry wait loop polls
    /// it); the next turn start clears it.
    pub(crate) fn handle_abort_retry(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("abort_retry") {
            return response;
        }
        self.core.lock().unwrap().retry_abort_requested = true;
        response_success(None, "abort_retry", None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn worker_config(dir: &std::path::Path) -> crate::worker::WorkerConfig {
        crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "switch-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        }
    }

    async fn created_worker() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-sw-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let worker = Arc::new(Worker::new(worker_config(&dir), None));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": dir }))
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    /// The connection state carries the settings-seeded switches: the TS
    /// default service tier ("default", not the old hard-coded "auto") and
    /// the queue modes.
    #[tokio::test]
    async fn connection_state_seeds_the_settings_switches() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        let data = response.data.expect("data");
        assert_eq!(data["serviceTier"], json!("default"));
        // TS settings defaults: both queue modes start "one-at-a-time".
        assert_eq!(data["steeringMode"], json!("one-at-a-time"));
        assert_eq!(data["followUpMode"], json!("one-at-a-time"));
        assert_eq!(data["scopedModels"], json!([]));
    }

    /// A models.json fixture the registry reads (one provider with
    /// `count` mock models, all auth-configured).
    fn models_fixture(dir: &std::path::Path, count: usize) {
        std::fs::create_dir_all(dir.join("agent")).expect("agent dir");
        let models: Vec<Value> = (1..=count)
            .map(|index| {
                json!({
                    "id": format!("mock-{index}"), "name": format!("Mock {index}"),
                    "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/v1",
                    "contextWindow": 128000, "maxTokens": 4096,
                })
            })
            .collect();
        std::fs::write(
            dir.join("agent").join("models.json"),
            json!({
                "providers": {
                    "prime-inference": {
                        "api": "openai-completions",
                        "baseUrl": "http://127.0.0.1:9/v1",
                        "apiKey": "sk-test",
                        "models": models,
                    }
                }
            })
            .to_string(),
        )
        .expect("write models.json");
    }

    /// Two candidates on a session that cannot switch (the scripted
    /// harness) fail with the `set_model` refusal; the response command
    /// stays `cycle_model`.
    #[tokio::test]
    async fn cycle_model_on_a_non_switching_engine_fails_like_set_model() {
        let dir = std::env::temp_dir().join(format!("pa-worker-cm2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        models_fixture(&dir, 2);
        let worker = Arc::new(Worker::new(worker_config(&dir), None));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": dir }))
            .await;
        assert!(created.success);
        let response = worker
            .dispatch(
                "cycle_model",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert!(!response.success);
        assert_eq!(response.command, "cycle_model");
        assert_eq!(
            response.error.as_deref(),
            Some("This session does not support model switching")
        );
    }

    /// `set_scoped_models` stores the list (visible on the connection
    /// state) and rejects malformed entries with daemon-level failures.
    #[tokio::test]
    async fn set_scoped_models_stores_and_validates() {
        let worker = created_worker().await;
        let scoped = json!([
            { "model": { "provider": "prime-inference", "id": "mock-1" } },
            {
                "model": { "provider": "prime-inference", "id": "mock-2" },
                "thinkingLevel": "high",
            },
        ]);
        let response = worker
            .dispatch(
                "set_scoped_models",
                &json!({ "activeSessionId": "switch-session", "scopedModels": scoped }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let state = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert_eq!(state.data.expect("data")["scopedModels"], scoped);

        for bad in [
            json!({ "activeSessionId": "switch-session" }),
            json!({ "activeSessionId": "switch-session", "scopedModels": [{}] }),
            json!({
                "activeSessionId": "switch-session",
                "scopedModels": [{ "model": { "provider": "p", "id": "m" }, "thinkingLevel": "sideways" }],
            }),
        ] {
            let response = worker.dispatch("set_scoped_models", &bad).await;
            assert!(!response.success, "must reject: {bad}");
        }
    }

    /// `cycle_thinking_level` without a reasoning model answers success
    /// with `null` data (TS `supportsThinking()`).
    #[tokio::test]
    async fn cycle_thinking_level_without_reasoning_answers_null() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "cycle_thinking_level",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(response.data, Some(Value::Null));
    }

    /// `set_service_tier` records the durable row on change (the priority
    /// request clamps to `default` without fast mode), and an unchanged
    /// request records nothing more.
    #[tokio::test]
    async fn set_service_tier_records_the_durable_row() {
        let worker = created_worker().await;
        let tier_rows = |worker: &Worker| {
            worker
                .core
                .lock()
                .unwrap()
                .store
                .as_ref()
                .map(|store| {
                    store
                        .entries()
                        .iter()
                        .filter(|entry| entry.type_ == "service_tier_change")
                        .count()
                })
                .unwrap_or(0)
        };
        let baseline = tier_rows(&worker);
        let response = worker
            .dispatch(
                "set_service_tier",
                &json!({ "activeSessionId": "switch-session", "serviceTier": "priority" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        // The scripted engine reports no model: priority clamps to default.
        let state = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert_eq!(state.data.expect("data")["serviceTier"], json!("default"));
        let rows = {
            let core = worker.core.lock().unwrap();
            core.store
                .as_ref()
                .map(|store| {
                    store
                        .entries()
                        .iter()
                        .filter(|entry| entry.type_ == "service_tier_change")
                        .count()
                })
                .unwrap_or(0)
        };
        assert_eq!(rows, baseline + 1, "one new preference row");
        // An unchanged request is a no-op success (no new row).
        let response = worker
            .dispatch(
                "set_service_tier",
                &json!({ "activeSessionId": "switch-session", "serviceTier": "priority" }),
            )
            .await;
        assert!(response.success);
        let rows = {
            let core = worker.core.lock().unwrap();
            core.store
                .as_ref()
                .map(|store| {
                    store
                        .entries()
                        .iter()
                        .filter(|entry| entry.type_ == "service_tier_change")
                        .count()
                })
                .unwrap_or(0)
        };
        assert_eq!(rows, baseline + 1);
        let response = worker
            .dispatch(
                "set_service_tier",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert!(!response.success);
    }

    /// `set_transport` persists the settings value; an unknown transport
    /// fails the command.
    #[tokio::test]
    async fn set_transport_persists_the_setting() {
        let dir = std::env::temp_dir().join(format!("pa-worker-tr-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        let worker = Arc::new(Worker::new(worker_config(&dir), None));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": dir }))
            .await;
        assert!(created.success);
        let response = worker
            .dispatch(
                "set_transport",
                &json!({ "activeSessionId": "switch-session", "transport": "websocket" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let settings = pa_core::settings::SettingsManager::create(&dir, dir.join("agent"));
        assert!(matches!(
            settings.get_transport(),
            pa_core::settings::TransportSetting::WebSocket
        ));
        let response = worker
            .dispatch(
                "set_transport",
                &json!({ "activeSessionId": "switch-session", "transport": "teleport" }),
            )
            .await;
        assert!(!response.success);
    }

    /// The queue-mode switches update the connection state and reject the
    /// values outside the TS vocabulary.
    #[tokio::test]
    async fn queue_mode_switches_update_the_state() {
        let worker = created_worker().await;
        for (command, field) in [
            ("set_steering_mode", "steeringMode"),
            ("set_follow_up_mode", "followUpMode"),
        ] {
            let response = worker
                .dispatch(
                    command,
                    &json!({ "activeSessionId": "switch-session", "mode": "one-at-a-time" }),
                )
                .await;
            assert!(response.success, "{command} failed: {response:?}");
            let state = worker
                .dispatch(
                    "get_connection_state",
                    &json!({ "activeSessionId": "switch-session" }),
                )
                .await;
            assert_eq!(state.data.expect("data")[field], json!("one-at-a-time"));
            let response = worker
                .dispatch(
                    command,
                    &json!({ "activeSessionId": "switch-session", "mode": "bogus" }),
                )
                .await;
            assert!(!response.success);
            let response = worker
                .dispatch(
                    command,
                    &json!({ "activeSessionId": "switch-session", "mode": "all" }),
                )
                .await;
            assert!(response.success);
        }
    }

    /// `set_auto_retry` persists the toggle the retry policy reads.
    #[tokio::test]
    async fn set_auto_retry_persists_the_toggle() {
        let dir = std::env::temp_dir().join(format!("pa-worker-ar-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        let worker = Arc::new(Worker::new(worker_config(&dir), None));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": dir }))
            .await;
        assert!(created.success);
        let response = worker
            .dispatch(
                "set_auto_retry",
                &json!({ "activeSessionId": "switch-session", "enabled": false }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let settings = pa_core::settings::SettingsManager::create(&dir, dir.join("agent"));
        let policy = settings.get_provider_retry_policy();
        assert!(!policy.enabled);
    }

    /// `set_auto_compaction` flips the connection-state flag and persists
    /// the settings value; a session created afterwards re-seeds its flag
    /// from the persisted toggle (TS: the connection state reads the
    /// settings manager, so the value survives a daemon restart).
    #[tokio::test]
    async fn set_auto_compaction_persists_the_toggle() {
        let dir = std::env::temp_dir().join(format!("pa-worker-ac-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        let worker = Arc::new(Worker::new(worker_config(&dir), None));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": dir }))
            .await;
        assert!(created.success);
        let state = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        // TS default: auto-compaction is on until the user opts out.
        assert_eq!(
            state.data.expect("data")["autoCompactionEnabled"],
            json!(true)
        );
        let response = worker
            .dispatch(
                "set_auto_compaction",
                &json!({ "activeSessionId": "switch-session", "enabled": false }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let state = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert_eq!(
            state.data.expect("data")["autoCompactionEnabled"],
            json!(false)
        );
        let settings = pa_core::settings::SettingsManager::create(&dir, dir.join("agent"));
        assert!(!settings.get_compaction_enabled());
        // A restarted session on the same dirs re-seeds the flag from the
        // persisted setting (the `create` settings-seeded switches).
        let worker = Arc::new(Worker::new(worker_config(&dir), None));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": dir }))
            .await;
        assert!(created.success);
        let state = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert_eq!(
            state.data.expect("data")["autoCompactionEnabled"],
            json!(false)
        );
    }

    /// A failed settings write fails the command and leaves the flag
    /// unchanged (TS: the connection state is the settings value, so a
    /// thrown save flips nothing).
    #[tokio::test]
    async fn set_auto_compaction_fails_without_flipping_on_a_failed_save() {
        let dir = std::env::temp_dir().join(format!("pa-worker-acf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // A file where the agent dir would be: the settings save cannot
        // create agent/settings.json.
        std::fs::write(dir.join("agent"), b"not a directory").unwrap();
        let worker = Arc::new(Worker::new(worker_config(&dir), None));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": dir }))
            .await;
        assert!(created.success);
        let response = worker
            .dispatch(
                "set_auto_compaction",
                &json!({ "activeSessionId": "switch-session", "enabled": false }),
            )
            .await;
        assert!(!response.success, "must fail: {response:?}");
        let state = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert_eq!(
            state.data.expect("data")["autoCompactionEnabled"],
            json!(true)
        );
    }

    /// `abort_retry` always answers success (TS aborts only an in-flight
    /// retry; without one the command is still a success).
    #[tokio::test]
    async fn abort_retry_answers_success() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "abort_retry",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
    }
}
