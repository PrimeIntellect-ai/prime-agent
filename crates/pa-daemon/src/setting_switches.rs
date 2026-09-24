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

/// TS `supportsServiceTier` as the worker sees it: the engine's resolved
/// model metadata (provider, api, id) against the shared pa-types
/// eligibility fields. A session without a resolved model supports only
/// the `default` tier, exactly like the TS `model == null` arm.
pub(crate) fn engine_supports_service_tier(
    engine: &dyn crate::engine::SessionEngine,
    tier: ServiceTier,
) -> bool {
    let model = engine.model_metadata();
    model
        .as_ref()
        .and_then(|model| {
            Some(pa_types::ai::supports_service_tier_fields(
                model.get("provider")?.as_str()?,
                model.get("api")?.as_str()?,
                model.get("id")?.as_str()?,
                tier,
            ))
        })
        .unwrap_or(false)
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

/// TS `_getEffectiveServiceTier` (#2144's `clampServiceTier`): a tier the
/// current model does not support degrades to `default`. An unset
/// (`null`) preference passes through; `None` on the wire reads as `auto`
/// (see [`service_tier_wire_name`]).
pub(crate) fn effective_service_tier(
    tier: Option<ServiceTier>,
    engine: &dyn crate::engine::SessionEngine,
) -> Option<ServiceTier> {
    match tier {
        None | Some(ServiceTier::Default) => tier,
        Some(tier) => engine_supports_service_tier(engine, tier)
            .then_some(tier)
            .or(Some(ServiceTier::Default)),
    }
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
        // The daemon model allowlist gate, before the switch attempt: an
        // off-list candidate answers the cycle with the loud refusal (the
        // engine's switch guard would also refuse it, but the response
        // should say why) and emits the `model refused` event.
        {
            let selector = format!("{provider}/{model_id}");
            let cwd = {
                let core = self.core.lock().unwrap();
                core.cwd.clone()
            };
            let allowlist =
                crate::model_allowlist::load(std::path::Path::new(&cwd), &self.config.agent_dir);
            if let Err(refusal) = crate::model_allowlist::assert_allowed(&allowlist, &selector) {
                // The event rides the typed refusal only (the other seams'
                // rule): a fail-closed unreadable-allowlist error is a
                // settings problem, not an allowlist refusal.
                if refusal
                    .downcast_ref::<pa_core::models::ModelAllowlistRefusal>()
                    .is_some()
                {
                    if let Some(agent_engine) = &self.agent_engine {
                        agent_engine.note_model_refused("cycle_model", &selector);
                    }
                }
                return response_failure(None, "cycle_model", &refusal.to_string(), None);
            }
        }
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
                    let _ = store.persist_entry(
                        "model_change",
                        json!({ "provider": provider, "modelId": model_id }),
                    );
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
        // The cycled model (and any level the switch clamps) reaches the
        // roster surfaces immediately: the TS `cycle_model` daemon handler
        // schedules a roster flush after the switch, matching `set_model`.
        self.push_roster_delta();
        // The new model may not keep the priority tier (TS
        // `_clampServiceTierForModel`).
        self.clamp_service_tier_for_model();
        let (thinking_level, service_tier) = {
            let core = self.core.lock().unwrap();
            (
                self.engine
                    .effective_thinking_level()
                    .unwrap_or_else(|| "off".to_string()),
                effective_service_tier(core.service_tier, self.engine.as_ref())
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
    /// (TS `_clampServiceTierForModel` on a model switch, #2144's
    /// `clampServiceTier`): a preference the switched-to model does not
    /// support degrades to `default`, the engine's request slot follows the
    /// clamp, and the `service_tier_changed` session event follows the
    /// flip. The stored preference keeps the requested tier, so switching
    /// back to (or resuming on) a capable model re-applies it.
    fn clamp_service_tier_for_model(&self) {
        let (preference, clamped) = {
            let core = self.core.lock().unwrap();
            (
                core.service_tier,
                effective_service_tier(core.service_tier, self.engine.as_ref()),
            )
        };
        if clamped != preference {
            self.engine.configure_service_tier(clamped);
            self.emit_worker_event(json!({
                "type": "service_tier_changed",
                "serviceTier": service_tier_wire_name(clamped.unwrap_or(ServiceTier::Auto)),
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
        self.core.lock().unwrap().scoped_models.clone_from(scoped);
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

    /// `set_service_tier { serviceTier }` (TS `session.setServiceTier`,
    /// #2144 semantics): the preference and the durable `service_tier_change`
    /// row keep the REQUESTED tier (only the active state clamps), so
    /// switching to (or resuming on) a capable model re-applies it; the
    /// settings default persists only when the model supports the tier; and
    /// the `service_tier_changed` event follows an effective change. An
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
        let effective = effective_service_tier(Some(tier), self.engine.as_ref()).unwrap_or(tier);
        let (preference_changed, effective_changed, cwd) = {
            let mut core = self.core.lock().unwrap();
            let preference = core.service_tier;
            let previous_effective = effective_service_tier(preference, self.engine.as_ref())
                .unwrap_or(ServiceTier::Auto);
            core.service_tier = Some(tier);
            let effective_changed = previous_effective != effective;
            let preference_changed = preference != Some(tier);
            let mut cwd = core.cwd.clone();
            if preference_changed {
                if let Some(store) = core.store.as_mut() {
                    // The same durable row the creation prefix writes (TS
                    // `appendServiceTierChange(serviceTier)` — the
                    // REQUESTED tier, not the clamped one).
                    let _ =
                        store.persist_entry("service_tier_change", json!({ "serviceTier": tier }));
                }
                cwd.clone_from(&core.cwd);
            }
            (preference_changed, effective_changed, cwd)
        };
        self.engine.configure_service_tier(Some(effective));
        if preference_changed && engine_supports_service_tier(self.engine.as_ref(), tier) {
            // TS persists the default only when the model supports the
            // tier (#2144: `supportsServiceTier(this.model, serviceTier)`).
            let mut settings =
                pa_core::settings::SettingsManager::create(&cwd, &self.config.agent_dir);
            let _ = settings.set_default_service_tier(tier);
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
        // TS `session.setSteeringMode`/`setFollowUpMode` write the live
        // agent's queue mode (`this.agent.steeringMode = mode`): the
        // engine's agent-level queues drain per the new mode from the
        // next boundary (the worker lane's delivery mode already carries
        // the `core.steering_mode`/`core.follow_up_mode` update above).
        if command == "set_steering_mode" {
            self.engine.set_queue_modes(Some(mode), None);
        } else {
            self.engine.set_queue_modes(None, Some(mode));
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
    /// default service tier ("default", not the old hard-coded "auto")
    /// and the queue modes. The steering default is "all" (every queued
    /// steer co-delivers as ONE turn at the next tool-call boundary);
    /// the follow-up default is "one-at-a-time".
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
        assert_eq!(
            data["steeringMode"],
            json!("all"),
            "the product default batches the parked steering prefix"
        );
        assert_eq!(
            data["followUpMode"],
            json!("one-at-a-time"),
            "the follow-up default keeps the TS one-per-turn behavior"
        );
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
                    "contextWindow": 128_000, "maxTokens": 4096,
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

    /// `cycle_model` answers the daemon model-allowlist refusal with the
    /// loud message (the refusal reason, not the generic non-switching
    /// error) and never attempts the switch. The scoped list pins the
    /// cycle to the two fixture models, so the next candidate is the
    /// off-allowlist mock.
    #[tokio::test]
    async fn cycle_model_refuses_models_outside_the_allowlist() {
        let dir = std::env::temp_dir().join(format!("pa-worker-cm3-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        models_fixture(&dir, 2);
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        std::fs::write(
            dir.join("agent").join("settings.json"),
            json!({ "allowedModels": ["anthropic/*"] }).to_string(),
        )
        .unwrap();
        let worker = Arc::new(Worker::new(worker_config(&dir), None));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": dir }))
            .await;
        assert!(created.success);
        let scoped = worker
            .dispatch(
                "set_scoped_models",
                &json!({
                    "activeSessionId": "switch-session",
                    "scopedModels": [
                        { "model": { "provider": "prime-inference", "id": "mock-1" } },
                        { "model": { "provider": "prime-inference", "id": "mock-2" } }
                    ]
                }),
            )
            .await;
        assert!(scoped.success, "scoped fixture: {scoped:?}");
        let response = worker
            .dispatch(
                "cycle_model",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert!(!response.success);
        assert_eq!(response.command, "cycle_model");
        let error = response.error.expect("refusal message");
        assert!(
            error.contains("blocked by the daemon model allowlist"),
            "{error}"
        );
        assert!(
            !error.contains("does not support model switching"),
            "{error}"
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

    /// `set_service_tier` records the durable row on change (the row keeps
    /// the REQUESTED tier while an unsupported request clamps to `default`
    /// in the active state — TS #2144), and an unchanged request records
    /// nothing more.
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
                        .map(|entry| entry.fields.clone())
                        .collect::<Vec<serde_json::Value>>()
                })
                .unwrap_or_default()
        };
        let baseline = tier_rows(&worker).len();
        let response = worker
            .dispatch(
                "set_service_tier",
                &json!({ "activeSessionId": "switch-session", "serviceTier": "priority" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        // The scripted engine reports no model: priority clamps to default
        // in the active state...
        let state = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert_eq!(state.data.expect("data")["serviceTier"], json!("default"));
        // ...but the durable row keeps the requested tier, so resuming on
        // a capable model re-applies it.
        let rows = tier_rows(&worker);
        assert_eq!(rows.len(), baseline + 1, "one new preference row");
        assert_eq!(
            rows.last().and_then(|row| row.get("serviceTier")),
            Some(&json!("priority"))
        );
        // An unchanged request is a no-op success (no new row).
        let response = worker
            .dispatch(
                "set_service_tier",
                &json!({ "activeSessionId": "switch-session", "serviceTier": "priority" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(tier_rows(&worker).len(), baseline + 1);
        // A `flex` preference clamps the same way (the scripted engine
        // reports no model) and records its own requested tier.
        let response = worker
            .dispatch(
                "set_service_tier",
                &json!({ "activeSessionId": "switch-session", "serviceTier": "flex" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let rows = tier_rows(&worker);
        assert_eq!(rows.len(), baseline + 2);
        assert_eq!(
            rows.last().and_then(|row| row.get("serviceTier")),
            Some(&json!("flex"))
        );
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
