//! Image-model routing for the daemon worker's dispatched turns (TS
//! #2453's `settings.imageModel`): a batch whose delivered messages attach
//! image blocks runs on the configured image-capable model while the
//! session model keeps identifying the session for UI and persistence.
//! An unusable or missing reference fails the turn with the actionable
//! refusal naming the setting — nothing silently downgrades the images to
//! "(image omitted)" placeholders.
//!
//! The decision is armed at turn dispatch (`run_prompt`), re-applied at
//! every model-turn attempt (so retries and post-compaction continuations
//! keep serving the routed model, and the session build cannot clobber
//! the swap), and cleared with the session target restored when the
//! episode settles. The helpers live here; the dispatch, preflight, and
//! failover integration points stay in [`crate::agent_engine`].

use pa_core::session_engine::provider_adapter::{
    json_round_trip, map_thinking_level, ProviderTarget,
};

use crate::agent_engine::AgentSessionEngine;

/// The routed image-model serving state for one dispatched episode (TS
/// `AgentModelOverride` + the provider target the daemon's stream reads per
/// call): turns whose delivered messages attach image blocks run on the
/// configured `settings.imageModel` while the session model keeps
/// identifying the session for UI and persistence.
#[derive(Clone)]
pub(crate) struct ImageRoute {
    /// The stream's provider target for the episode (the image model, its
    /// resolved key, and the session tier clamped for it).
    pub(crate) target: ProviderTarget,
    /// The agent's per-run override (the image model + the session thinking
    /// level clamped for it) feeding the loop config.
    pub(crate) agent_override: pa_agent::agent::AgentModelOverride,
    /// The session's serving target captured at the first swap: the
    /// episode-settle restore writes it back when the fresh recompute
    /// cannot run (a resolution failure must not leave the routed target
    /// serving later turns).
    pub(crate) session_target: Option<ProviderTarget>,
}

impl AgentSessionEngine {
    /// TS `_imageModelOverrideForTurns` + `resolveImageModelOverride`: the
    /// routing decision for one dispatched turn batch. `carries_images` is
    /// the batch's delivered image blocks (the primary prompt's plus the
    /// batched rows'). `Ok(None)` when the batch does not route (no
    /// images, a vision session model, or `images.blockImages`); `Err` is
    /// the actionable refusal that fails the turn.
    pub(crate) fn resolve_image_turn_route(
        &self,
        carries_images: bool,
    ) -> anyhow::Result<Option<pa_core::models::ResolvedImageModel>> {
        if !carries_images {
            return Ok(None);
        }
        let session_model = self.session_model()?;
        let settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        let image_model_reference = settings.get_image_model();
        let block_images = settings.get_block_images();
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        registry.load_private_authorization_from_cache();
        let available: Vec<pa_types::ai::Model> =
            registry.get_available().into_iter().cloned().collect();
        let route = pa_core::models::resolve_image_model_override(
            &pa_core::models::ImageModelRoutingInputs {
                session_model: &session_model,
                thinking_level: self.effective_thinking(),
                service_tier: *self.service_tier.read().expect("service tier lock"),
                image_model_reference: image_model_reference.as_deref(),
                available_models: &available,
                has_configured_auth: &|model| registry.has_configured_auth(model),
                block_images,
            },
        )
        .map_err(anyhow::Error::msg)?;
        Ok(route)
    }

    /// Arm (or clear) the dispatched batch's image-model route: the
    /// resolved image model becomes the episode's serving target (the
    /// provider slot + the agent's per-run override), applied at every
    /// model-turn attempt so retries and post-compaction continuations
    /// keep serving it. A text-only session model with an unusable or
    /// missing `settings.imageModel` returns the actionable refusal.
    pub(crate) fn arm_image_turn_route(&self, carries_images: bool) -> Result<(), String> {
        let route = self
            .resolve_image_turn_route(carries_images)
            .map_err(|error| format!("{error:#}"))?;
        let route = match route {
            Some(resolved) => {
                // The daemon's model allowlist is fail-closed on every model
                // the session runs on (the switch, child-model, and failover
                // paths all assert it): a routed image model excluded by
                // `allowedModels` must not bypass it.
                let selector = format!("{}/{}", resolved.model.provider, resolved.model.id);
                let allowlist = crate::model_allowlist::load(&self.cwd(), &self.config.agent_dir);
                if let Err(refusal) = crate::model_allowlist::assert_allowed(&allowlist, &selector)
                {
                    self.note_model_refused("image_route", &selector);
                    return Err(format!("{refusal:#}"));
                }
                Some(resolved)
            }
            None => None,
        };
        let armed = match route {
            Some(resolved) => {
                let agent_model = json_round_trip(&resolved.model)
                    .ok_or_else(|| "model conversion failed".to_string())?;
                Some(ImageRoute {
                    target: ProviderTarget {
                        service_tier: resolved.service_tier,
                        api_key: self.resolve_request_api_key(&resolved.model),
                        model: resolved.model.clone(),
                    },
                    agent_override: pa_agent::agent::AgentModelOverride {
                        thinking_level: map_thinking_level(resolved.thinking_level),
                        model: agent_model,
                    },
                    // Captured at the first swap in
                    // [`Self::apply_armed_image_route`].
                    session_target: None,
                })
            }
            None => None,
        };
        *self
            .image_route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = armed;
        Ok(())
    }

    /// Whether an injected custom row attaches image blocks (TS
    /// `messageCarriesImages` checks every delivered message's content, the
    /// custom rows included): injected rows route like user turns.
    pub(crate) fn custom_message_carries_images(
        message: &pa_types::session::CustomMessage,
    ) -> bool {
        match &message.content {
            pa_types::ai::UserContent::Blocks(blocks) => blocks
                .iter()
                .any(|block| matches!(block, pa_types::ai::UserContentBlock::Image(_))),
            pa_types::ai::UserContent::Text(_) => false,
        }
    }

    /// Apply the armed route to a model turn (after the session build, so
    /// the build-time target cannot clobber it): the stream's provider
    /// target and the agent's per-run model override swap to the routed
    /// image model for the episode.
    pub(crate) fn apply_armed_image_route(&self, agent: &std::sync::Arc<pa_agent::agent::Agent>) {
        let mut slot = self
            .image_route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(route) = slot.as_mut() else {
            return;
        };
        // The first swap of the episode captures the session target it
        // replaces (the later builds re-write the slot with the session
        // model, so only the swap preceding them holds it).
        if route.session_target.is_none() {
            route.session_target = self
                .provider_target
                .read()
                .expect("provider target lock")
                .clone();
        }
        let route = route.clone();
        drop(slot);
        agent.set_model_override(Some(route.agent_override));
        *self.provider_target.write().expect("provider target lock") = Some(route.target);
    }

    /// Clear the armed route and restore the session's serving target (a
    /// fresh resolution, so a mid-episode model switch is honored): the
    /// next dispatched batch re-evaluates the routing against it (TS
    /// `_clearModelOverrideWhenIdle` + the next-dispatch re-evaluation).
    pub(crate) fn clear_image_route(&self) {
        let route = self
            .image_route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let Some(route) = route else {
            return;
        };
        // The agent override clears even when the session target cannot be
        // rebuilt (an auth/read failure): the next run must not silently
        // serve on the routed image model — the captured session target
        // restores the slot instead (a stale pin beats a leftover routed
        // image target serving later image-free turns).
        let agent = self.turn_agent.lock().expect("turn agent lock").clone();
        if let Some(agent) = agent {
            agent.set_model_override(None);
        }
        let mut target = match self.resolve_model() {
            Ok(model) => Some(ProviderTarget {
                service_tier: *self.service_tier.read().expect("service tier lock"),
                api_key: self.resolve_request_api_key(&model),
                model,
            }),
            Err(_) => route.session_target,
        };
        if let Some(target) = target.take() {
            *self.provider_target.write().expect("provider target lock") = Some(target);
        }
    }

    /// Whether an image-model route is armed for the running episode (the
    /// failover primary capture keys off it: a routed episode's failover
    /// restores the routed target, not the session model).
    pub(crate) fn armed_image_route(&self) -> Option<ImageRoute> {
        self.image_route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_engine::{tests::FAUX_TEST_LOCK, AgentEngineConfig};
    use crate::engine::SessionEngine as _;
    use crate::engine::{EngineEvent, EngineModelSelection, PromptRequest};

    // Image-model routing (TS #2453's `settings.imageModel`): a
    // text-only session model + an image-attaching batch routes to the
    // configured image model, or the turn fails with the actionable
    // refusal. The battery pair: a text-only session model and a
    // vision-capable image model, both on a models.json provider whose
    // api the faux registry serves.

    fn write_image_pair_models_json(agent_dir: &std::path::Path) {
        std::fs::create_dir_all(agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("models.json"),
            serde_json::json!({
                "providers": {
                    "battery": {
                        "api": "mock-battery",
                        "baseUrl": "http://127.0.0.1:9",
                        "apiKey": "sk-battery",
                        "models": [
                            {
                                "id": "mock-1",
                                "name": "Mock 1",
                                "api": "mock-battery",
                                "contextWindow": 128_000,
                                "maxTokens": 4096
                            },
                            {
                                "id": "mock-vision",
                                "name": "Mock Vision",
                                "api": "mock-battery",
                                "contextWindow": 128_000,
                                "maxTokens": 4096,
                                "input": ["text", "image"]
                            }
                        ]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    fn write_image_settings(dir: &std::path::Path, settings: serde_json::Value) {
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        std::fs::write(
            dir.join("agent").join("settings.json"),
            settings.to_string(),
        )
        .unwrap();
    }

    /// The engine battery pair: models.json with the text-only session
    /// model pinned by the create config and the vision image model.
    fn image_route_engine(
        dir: &std::path::Path,
        settings: serde_json::Value,
    ) -> AgentSessionEngine {
        let agent_dir = dir.join("agent");
        write_image_pair_models_json(&agent_dir);
        write_image_settings(dir, settings);
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.to_path_buf(),
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
        engine.configure_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-1".to_string()),
            api_key: None,
            thinking: None,
        });
        engine
    }

    fn one_image() -> Vec<pa_agent::types::ImageContent> {
        vec![pa_agent::types::ImageContent {
            data: "aGk=".to_string(),
            mime_type: "image/png".to_string(),
        }]
    }

    #[test]
    fn image_route_resolves_the_configured_image_model() {
        let dir = tempfile::TempDir::new().unwrap();
        let engine = image_route_engine(
            dir.path(),
            serde_json::json!({ "imageModel": "battery/mock-vision" }),
        );
        let route = engine
            .resolve_image_turn_route(true)
            .expect("the configured reference routes");
        let route = route.expect("the text-only session model routes");
        assert_eq!(route.model.id, "mock-vision");
        assert_eq!(route.model.provider, "battery");
        // An image-free batch never routes.
        let none = engine
            .resolve_image_turn_route(false)
            .expect("image-free batches stay on the session model");
        assert!(none.is_none());
    }

    #[test]
    fn image_route_refusals_name_the_setting() {
        let dir = tempfile::TempDir::new().unwrap();
        // Without imageModel the turn fails with the TS refusal naming the
        // setting and the session model.
        let engine = image_route_engine(dir.path(), serde_json::json!({}));
        let error = engine
            .resolve_image_turn_route(true)
            .expect_err("no imageModel configured");
        assert!(
            format!("{error}").contains("does not accept image input"),
            "{error}"
        );
        assert!(format!("{error}").contains("battery/mock-1"), "{error}");
        assert!(
            format!("{error}").contains("Set imageModel in settings.json"),
            "{error}"
        );
        // An unusable reference refuses with its own message.
        let dir = tempfile::TempDir::new().unwrap();
        let engine = image_route_engine(
            dir.path(),
            serde_json::json!({ "imageModel": "nope/nothere" }),
        );
        let error = engine
            .resolve_image_turn_route(true)
            .expect_err("the reference must resolve");
        assert!(
            format!("{error}").contains("could not be resolved"),
            "{error}"
        );
        // `images.blockImages` disables routing: no refusal, no route.
        let dir = tempfile::TempDir::new().unwrap();
        let engine = image_route_engine(
            dir.path(),
            serde_json::json!({
                "imageModel": "battery/mock-vision",
                "images": { "blockImages": true }
            }),
        );
        let none = engine
            .resolve_image_turn_route(true)
            .expect("blocked images disable routing");
        assert!(none.is_none());
    }

    /// The end-to-end routed episode: an image-attaching prompt on the
    /// text-only session model serves on the configured image model (the
    /// settled assistant row tags it), and the episode's settle restores
    /// the session target and clears the agent override (TS: the next
    /// dispatch re-evaluates the routing against the session model).
    #[test]
    fn image_turn_serves_on_the_image_model_and_restores() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("mock-battery".to_string()),
                provider: Some("battery".to_string()),
                models: Some(vec![
                    pa_ai::faux::FauxModelDefinition {
                        id: "mock-1".to_string(),
                        name: Some("Mock 1".to_string()),
                        reasoning: Some(false),
                        input: Some(vec![pa_types::ai::ModelInput::Text]),
                        cost: None,
                        context_window: Some(128_000),
                        max_tokens: Some(4096),
                    },
                    pa_ai::faux::FauxModelDefinition {
                        id: "mock-vision".to_string(),
                        name: Some("Mock Vision".to_string()),
                        reasoning: Some(false),
                        input: Some(vec![
                            pa_types::ai::ModelInput::Text,
                            pa_types::ai::ModelInput::Image,
                        ]),
                        cost: None,
                        context_window: Some(128_000),
                        max_tokens: Some(4096),
                    },
                ]),
                ..Default::default()
            });
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "vision reply",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let dir = tempfile::TempDir::new().unwrap();
        let engine = image_route_engine(
            dir.path(),
            serde_json::json!({ "imageModel": "battery/mock-vision" }),
        );
        let mut events = Vec::new();
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: one_image(),
                message: "describe this".to_string(),
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
        let turn_end = events
            .iter()
            .find_map(|event| match event {
                EngineEvent::TurnEnd { message, .. } => Some(message.clone()),
                _ => None,
            })
            .expect("the routed turn settled");
        // The routed run's assistant row tags the image model that served
        // it (TS: run failures and assistant attribution follow the
        // override model, never the session model).
        assert_eq!(turn_end["model"], serde_json::json!("mock-vision"));
        assert_eq!(turn_end["provider"], serde_json::json!("battery"));
        // The episode's settle restored the session target and cleared the
        // agent override: the next image-free turn serves mock-1 again.
        assert_eq!(engine.session_model().unwrap().id, "mock-1");
        let agent = engine
            .turn_agent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .expect("session built by the routed turn");
        assert!(agent.model_override().is_none());
        registration.unregister();
    }

    /// Without `imageModel`, the image-attaching turn fails at dispatch
    /// with the actionable refusal (no silent image downgrade): the run
    /// ends with `Done(Err(refusal))` and no assistant row ran.
    #[test]
    fn image_turn_without_image_model_fails_with_the_refusal() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("mock-battery".to_string()),
                provider: Some("battery".to_string()),
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "mock-1".to_string(),
                    name: Some("Mock 1".to_string()),
                    reasoning: Some(false),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    cost: None,
                    context_window: Some(128_000),
                    max_tokens: Some(4096),
                }]),
                ..Default::default()
            });
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "should not run",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let dir = tempfile::TempDir::new().unwrap();
        let engine = image_route_engine(dir.path(), serde_json::json!({}));
        let mut events = Vec::new();
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: one_image(),
                message: "describe this".to_string(),
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
        let refusal = events
            .iter()
            .find_map(|event| match event {
                EngineEvent::Done(Err(error)) => Some(error.clone()),
                _ => None,
            })
            .expect("the turn fails at dispatch");
        assert!(refusal.contains("does not accept image input"), "{refusal}");
        assert!(
            refusal.contains("Set imageModel in settings.json"),
            "{refusal}"
        );
        // No assistant row ran: the provider never saw the turn.
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, EngineEvent::TurnEnd { .. })),
            "the refused turn produced no model turn"
        );
        registration.unregister();
    }
}
