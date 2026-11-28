//! The worker arms for the daemon commands that flip live session settings:
//! `cycle_model`, `cycle_thinking_level`,
//! `set_service_tier`, `set_transport`, `set_steering_mode`,
//! `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry`, and
//! `abort_retry`; the wire contracts are TS-verbatim.

use serde_json::{json, Value};

use pa_types::ai::{ServiceTier, Transport};

use crate::engine::EngineModelSelection;
use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

const QUEUE_MODES: &[&str] = &["all", "one-at-a-time"];

/// Whether the engine's resolved model supports `tier`; a session without
/// a resolved model supports only the `default` tier.
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
        .unwrap_or(tier == ServiceTier::Default)
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

/// A tier the current model does not support degrades to `default`; an
/// unset preference passes through, and `None` on the wire reads as `auto`.
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
    /// `cycle_model { direction? }`: cycle within the available catalog; fewer
    /// than two candidates answer success with `null` data.
    pub(crate) async fn handle_cycle_model(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("cycle_model") {
            return response;
        }
        // Same serialization as `set_model`: the switch and tier re-clamp
        // run under the replacement gate.
        let _replacement_gate = self.replacement_gate.lock().await;
        let backward = payload.get("direction").and_then(Value::as_str) == Some("backward");
        let current = self.engine.model_metadata().and_then(|model| {
            Some((
                model.get("provider")?.as_str()?.to_string(),
                model.get("id")?.as_str()?.to_string(),
            ))
        });
        let registry = crate::state_getters::worker_model_registry(&self.config.agent_dir);
        let candidates: Vec<pa_types::ai::Model> =
            registry.get_available().into_iter().cloned().collect();
        if candidates.len() <= 1 {
            return response_success(None, "cycle_model", Some(Value::Null));
        }
        let current_index = current
            .and_then(|(provider, id)| {
                candidates
                    .iter()
                    .position(|model| model.provider == provider && model.id == id)
            })
            .unwrap_or(0);
        let len = candidates.len();
        let next_index = if backward {
            (current_index + len - 1) % len
        } else {
            (current_index + 1) % len
        };
        let next_model = candidates[next_index].clone();
        let provider = next_model.provider.clone();
        let model_id = next_model.id.clone();
        // The allowlist gate before the switch: an off-list candidate answers with the loud
        // refusal (the engine would also refuse it, but the response should say why).
        {
            let selector = format!("{provider}/{model_id}");
            let cwd = {
                let core = self.core.lock().unwrap();
                core.cwd.clone()
            };
            let allowlist =
                crate::model_allowlist::load(std::path::Path::new(&cwd), &self.config.agent_dir);
            if let Err(refusal) = crate::model_allowlist::assert_allowed(&allowlist, &selector) {
                // The event rides the typed refusal only: a fail-closed unreadable-allowlist
                // error is a settings problem, not an allowlist refusal.
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
            let cwd = {
                let mut core = core.lock().unwrap();
                if let Some(store) = core.store.as_mut() {
                    let _ = store.persist_entry(
                        "model_change",
                        json!({ "provider": provider, "modelId": model_id }),
                    );
                }
                core.cwd.clone()
            };
            // Persist the default so the next session starts here.
            let mut settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
            let _ = settings.set_default_model_and_provider(&provider, &model_id);
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
        // The new model may not keep the tier: the clamp runs BEFORE the roster
        // flush so the published snapshot never carries the previous model's tier.
        self.clamp_service_tier_for_model();
        // The cycled model must reach the roster surfaces immediately.
        self.push_roster_delta();
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
            })),
        )
    }

    /// Re-clamp the effective tier for the current model: an unsupported
    /// preference degrades to `default`, and the engine's request slot follows
    /// the model switch; the event fires only when the ACTIVE tier moves.
    pub(crate) fn clamp_service_tier_for_model(&self) {
        // The preference/active pair and the engine's request slot move under one lock: concurrent
        // commands must never see the active tier and the provider target disagree.
        let (changed, clamped) = {
            let mut core = self.core.lock().unwrap();
            let clamped = effective_service_tier(core.service_tier, self.engine.as_ref());
            let previous_active = core.active_service_tier;
            core.active_service_tier = clamped;
            self.engine.configure_service_tier(clamped);
            (clamped != previous_active, clamped)
        };
        if changed {
            self.emit_worker_event(json!({
                "type": "service_tier_changed",
                "serviceTier": service_tier_wire_name(clamped.unwrap_or(ServiceTier::Auto)),
            }));
        }
    }

    /// Replacement sessions re-seed the tier like a create: the file's
    /// `service_tier_change` row, else the settings default, then re-clamp.
    pub(crate) fn reseed_service_tier_for_replacement(&self) {
        let (restored, cwd) = {
            let core = self.core.lock().unwrap();
            let restored = core.store.as_ref().and_then(|store| {
                store
                    .has_service_tier()
                    .then(|| store.restored_settings().service_tier)
            });
            (restored, core.cwd.clone())
        };
        let default_tier = pa_core::settings::SettingsManager::create(&cwd, &self.config.agent_dir)
            .get_default_service_tier();
        {
            let mut core = self.core.lock().unwrap();
            core.service_tier = restored.unwrap_or(Some(default_tier));
        }
        self.clamp_service_tier_for_model();
    }

    /// `cycle_thinking_level`: reasoning models cycle their supported levels (the same flow as
    /// `set_thinking_level`); models without reasoning answer success with `null` data.
    pub(crate) async fn handle_cycle_thinking_level(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("cycle_thinking_level") {
            return response;
        }
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

    /// `set_service_tier { serviceTier }`: the preference and the durable row keep the
    /// REQUESTED tier (only the active state clamps), so a capable model re-applies it.
    pub(crate) async fn handle_set_service_tier(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_service_tier") {
            return response;
        }
        // The tier mutation runs under the replacement gate so a session swap's re-seed can never
        // interleave with an in-flight tier change.
        let _replacement_gate = self.replacement_gate.lock().await;
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
            // The engine's request slot moves under the SAME lock as the core publish:
            // a concurrent turn must never read the new state with the old-tier target.
            self.engine.configure_service_tier(Some(effective));
            let preference = core.service_tier;
            let previous_active = core.active_service_tier;
            core.service_tier = Some(tier);
            core.active_service_tier = Some(effective);
            let effective_changed = previous_active != Some(effective);
            let preference_changed = preference != Some(tier);
            let mut cwd = core.cwd.clone();
            if preference_changed {
                if let Some(store) = core.store.as_mut() {
                    // The durable row keeps the REQUESTED tier, not the clamped one.
                    let _ =
                        store.persist_entry("service_tier_change", json!({ "serviceTier": tier }));
                }
                cwd.clone_from(&core.cwd);
            }
            (preference_changed, effective_changed, cwd)
        };
        if preference_changed && engine_supports_service_tier(self.engine.as_ref(), tier) {
            // Persist the default only when the model supports the tier.
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

    /// `set_transport { transport }`: persist the transport setting; the live stream resolves
    /// transport per request from settings, so the persisted default is the whole switch.
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

    /// `set_steering_mode` / `set_follow_up_mode { mode }`: the queue delivery mode, persisted
    /// to settings and surfaced on the connection state.
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
        // The live agent's queue mode is written here too: the engine's
        // queues drain per the new mode from the next boundary.
        if command == "set_steering_mode" {
            self.engine.set_queue_modes(Some(mode), None);
        } else {
            self.engine.set_queue_modes(None, Some(mode));
        }
        response_success(None, command, None)
    }

    /// `set_auto_retry { enabled }`: the provider retry policy reads the setting on every turn.
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

    /// `set_auto_compaction { enabled }`: the connection-state flag, the built session's
    /// live toggle, and the settings value change together; a failed save fails the
    /// command without flipping the flag.
    pub(crate) async fn handle_set_auto_compaction(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_auto_compaction") {
            return response;
        }
        let enabled = payload
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let cwd = self.core.lock().unwrap().cwd.clone();
        let mut settings = pa_core::settings::SettingsManager::create(&cwd, &self.config.agent_dir);
        if let Err(error) = settings.set_compaction_enabled(enabled) {
            return response_failure(None, "set_auto_compaction", &error.to_string(), None);
        }
        self.compaction.set_auto_compaction(enabled).await;
        response_success(None, "set_auto_compaction", None)
    }

    /// `abort_retry`: stop an in-flight retry; the turn's abort probe polls the flag and the
    /// next turn start clears it.
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

    /// The connection state carries the settings-seeded defaults: service tier "default"
    /// (not "auto"), steering "all" (queued steers co-deliver as ONE turn),
    /// follow-up "one-at-a-time".
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
    }

    /// One provider with `count` mock models, all auth-configured.
    fn models_fixture(dir: &std::path::Path, count: usize) {
        std::fs::create_dir_all(dir.join("agent")).expect("agent dir");
        let models: Vec<Value> = (1..=count)
            .map(|index| {
                json!({
                    "id": format!("mock-{index}"), "name": format!("Mock {index}"),
                    "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/v1",
                    "contextWindow": 128_000, "maxTokens": 4096, "reasoning": true,
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

    #[tokio::test]
    async fn cycle_model_refuses_models_outside_the_allowlist() {
        let dir = std::env::temp_dir().join(format!("pa-worker-cm3-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        models_fixture(&dir, 2);
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        std::fs::write(
            dir.join("agent").join("settings.json"),
            json!({ "allowedModels": ["no-such-provider/*"] }).to_string(),
        )
        .unwrap();
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

    /// The durable row keeps the REQUESTED tier while an unsupported request clamps to
    /// `default` in the active state.
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
        let response = worker
            .dispatch(
                "set_service_tier",
                &json!({ "activeSessionId": "switch-session", "serviceTier": "priority" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(tier_rows(&worker).len(), baseline + 1);
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

    /// On the scripted engine (no model) the restored preference re-clamps the tier to `default`.
    #[tokio::test]
    async fn replacement_reseed_restores_the_tier_preference() {
        let worker = created_worker().await;
        worker.reseed_service_tier_for_replacement();
        let (preference, active) = {
            let core = worker.core.lock().unwrap();
            (core.service_tier, core.active_service_tier)
        };
        assert_eq!(preference, Some(ServiceTier::Default));
        assert_eq!(active, Some(ServiceTier::Default));
        {
            let mut core = worker.core.lock().unwrap();
            if let Some(store) = core.store.as_mut() {
                let _ = store
                    .persist_entry("service_tier_change", json!({ "serviceTier": "priority" }));
            }
        }
        worker.reseed_service_tier_for_replacement();
        let (preference, active) = {
            let core = worker.core.lock().unwrap();
            (core.service_tier, core.active_service_tier)
        };
        assert_eq!(preference, Some(ServiceTier::Priority));
        assert_eq!(active, Some(ServiceTier::Default));
        let state = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "switch-session" }),
            )
            .await;
        assert_eq!(state.data.expect("data")["serviceTier"], json!("default"));
    }

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
        // A restarted session re-seeds the flag from the persisted setting.
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

    /// The threshold `compaction_start` events since the last drain.
    fn threshold_compaction_starts(
        subscription: &mut tokio::sync::broadcast::Receiver<Arc<crate::worker::OutboundFrame>>,
    ) -> usize {
        let mut count = 0;
        while let Ok(frame) = subscription.try_recv() {
            if frame.outbound_type != "session_event" {
                continue;
            }
            let outbound: Value = serde_json::from_slice(&frame.payload).unwrap_or_default();
            if outbound["event"]["type"] == "compaction_start"
                && outbound["event"]["reason"] == "threshold"
            {
                count += 1;
            }
        }
        count
    }

    /// The toggle reaches an already-built session: the threshold arm follows
    /// it at the next turn boundary in both directions. The reserve leaves a
    /// threshold of 1616 tokens on the faux model (128k window, 16k output
    /// budget), below any real turn, so every turn is due while the toggle is on.
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn set_auto_compaction_reaches_the_built_session() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("agent")).unwrap();
        std::fs::write(
            dir.path().join("agent").join("settings.json"),
            json!({ "compaction": { "enabled": false, "reserveTokens": 110_000, "keepRecentTokens": 10 } })
                .to_string(),
        )
        .unwrap();
        let mut config = worker_config(dir.path());
        config.script = Some(json!({
            "engine": "faux",
            "responses": vec!["reply"; 8],
        }));
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": dir.path() }))
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        for (enabled, message, compacts) in [
            (None, "first", false),
            (Some(true), "second", true),
            (Some(false), "third", false),
        ] {
            if let Some(enabled) = enabled {
                let toggled = worker
                    .dispatch(
                        "set_auto_compaction",
                        &json!({ "activeSessionId": "switch-session", "enabled": enabled }),
                    )
                    .await;
                assert!(toggled.success, "toggle failed: {toggled:?}");
            }
            let turn = worker
                .dispatch(
                    "prompt_and_wait",
                    &json!({ "activeSessionId": "switch-session", "message": message }),
                )
                .await;
            assert!(turn.success, "the {message} turn failed: {turn:?}");
            assert_eq!(
                threshold_compaction_starts(&mut subscription) > 0,
                compacts,
                "the {message} turn's threshold compaction (toggle {enabled:?})"
            );
        }
    }

    #[tokio::test]
    async fn set_auto_compaction_fails_without_flipping_on_a_failed_save() {
        let dir = std::env::temp_dir().join(format!("pa-worker-acf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // A file where the agent dir would be: the settings save cannot create agent/settings.json.
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
