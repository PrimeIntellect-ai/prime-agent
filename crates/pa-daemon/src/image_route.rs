//! Image-model routing for dispatched turns (`settings.imageModel`): a
//! batch attaching image blocks runs on the configured image model while
//! the session model keeps identifying the session; an unusable reference
//! fails the turn with the actionable refusal — nothing silently
//! downgrades the images.

use pa_core::session_engine::provider_adapter::{
    json_round_trip, map_thinking_level, ProviderTarget,
};

use crate::agent_engine::AgentSessionEngine;

/// The routed image-model serving state for one dispatched episode: the
/// image model serves while the session model keeps identifying the session.
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
    /// cannot run.
    pub(crate) session_target: Option<ProviderTarget>,
}

impl AgentSessionEngine {
    /// The routing decision for one dispatched turn batch: `Ok(None)` when
    /// the batch does not route (no images, a vision session model, or
    /// `images.blockImages`); `Err` is the actionable refusal.
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
        // Route acceptance uses the same resolved-auth result the arm
        // installs: a provider can be signed in while its key resolution
        // still fails, and a route accepted on the status probe alone
        // would arm an unauthenticated target. Keyed (provider, id): one
        // provider's authenticated row must not vouch for another
        // provider's same-id model.
        let pinned_api_key = self.current_selection().api_key.is_some();
        let resolvable_auth: std::collections::HashSet<(String, String)> = available
            .iter()
            .filter(|model| {
                registry
                    .get_api_key_and_headers(model, model.headers.as_ref())
                    .ok
            })
            .map(|model| (model.provider.clone(), model.id.clone()))
            .collect();
        let route = pa_core::models::resolve_image_model_override(
            &pa_core::models::ImageModelRoutingInputs {
                session_model: &session_model,
                thinking_level: self.effective_thinking(),
                service_tier: *self.service_tier.read().expect("service tier lock"),
                image_model_reference: image_model_reference.as_deref(),
                available_models: &available,
                // Keyed (provider, id): one provider's authenticated row must
                // not vouch for another provider's same-id model.
                has_configured_auth: &|model| {
                    pinned_api_key
                        || resolvable_auth.contains(&(model.provider.clone(), model.id.clone()))
                },
                block_images,
            },
        )
        .map_err(anyhow::Error::msg)?;
        Ok(route)
    }

    /// Arm (or clear) the dispatched batch's image-model route: the
    /// resolved image model becomes the episode's serving target, applied
    /// at every model-turn attempt; a text-only session model with an
    /// unusable or missing `settings.imageModel` returns the refusal.
    pub(crate) fn arm_image_turn_route(&self, carries_images: bool) -> Result<(), String> {
        // The lock spans the route's auth resolution and its publication:
        // a `/reload` in between would refresh a route the arm then
        // overwrites with the older pair.
        let _reload_serialized = self
            .reload_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let route = self
            .resolve_image_turn_route(carries_images)
            .map_err(|error| format!("{error:#}"))?;
        let route = match route {
            Some(resolved) => {
                // The daemon's model allowlist is fail-closed on every
                // model the session runs on: a routed image model excluded
                // by `allowedModels` must not bypass it.
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
                        headers: self.resolve_request_key_and_headers(&resolved.model).1,
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

    /// Whether an injected custom row attaches image blocks: injected
    /// rows route like user turns.
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
    /// the build-time target cannot clobber it): the provider target and
    /// the agent's per-run override swap to the routed image model.
    ///
    /// The route lock is held through the slot write: a `/reload` that
    /// refreshes the armed route's auth and then the slot's can never be
    /// overtaken by an older clone of this route installing itself after
    /// the refresh — the clone and its install are one critical section.
    pub(crate) fn apply_armed_image_route(&self, agent: &std::sync::Arc<pa_agent::agent::Agent>) {
        // The lock spans the session-target capture AND the route install:
        // `/reload` refreshes the armed route, releases the route lock,
        // then rebinds the live slot — an apply in that window would
        // capture the pre-reload session target (and a later clear would
        // restore it over the reload's pair). Both run under the same
        // lock: whichever runs last leaves the newest store standing.
        let _reload_serialized = self
            .reload_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut slot = self
            .image_route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(route) = slot.as_mut() else {
            return;
        };
        // The first swap of the episode captures the session target it
        // replaces (the later builds re-write the slot with the session
        // model).
        if route.session_target.is_none() {
            route
                .session_target
                .clone_from(&self.provider_target.read().expect("provider target lock"));
        }
        let route = route.clone();
        agent.set_model_override(Some(route.agent_override));
        *self.provider_target.write().expect("provider target lock") = Some(route.target);
    }

    /// Install the armed route's target as the serving slot: the route
    /// lock is held through the slot write, so the clone and its install
    /// are one critical section — a `/reload` that refreshes the armed
    /// route and then the slot can never be overtaken by an older clone
    /// (the failover switch and restore install through here too).
    /// Returns `false` when no route is armed.
    pub(crate) fn install_armed_route_target(&self) -> bool {
        let slot = self
            .image_route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(route) = slot.as_ref() else {
            return false;
        };
        let target = route.target.clone();
        *self.provider_target.write().expect("provider target lock") = Some(target);
        true
    }

    /// Clear the armed route and restore the session's serving target (a
    /// fresh resolution, so a mid-episode model switch is honored): the
    /// next dispatched batch re-evaluates the routing against it.
    pub(crate) fn clear_image_route(&self) {
        // The lock spans the route take AND the clear's resolve-and-install:
        // the reload refreshes the armed route in place, so a clear that
        // took the route first would leave the reload unable to refresh
        // the detached pair, and the clear's fallback restore would then
        // clobber the reload's slot refresh with the pre-reload
        // `session_target`. Both run under the same lock — whichever runs
        // last leaves the newest store standing. This runs on the turn's
        // blocking thread (the worker parks the turn there), so the
        // synchronous resolution never touches an async executor worker.
        let _reload_serialized = self
            .reload_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let route = self
            .image_route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let Some(route) = route else {
            return;
        };
        // The agent override clears even when the session target cannot be
        // rebuilt: the next run must not silently serve on the routed
        // image model (a stale pin beats a leftover routed image target).
        let agent = self.turn_agent.lock().expect("turn agent lock").clone();
        if let Some(agent) = agent {
            agent.set_model_override(None);
        }
        let mut target = match self.resolve_model() {
            Ok(model) => match self.resolve_request_key_and_headers_and_store_health(&model) {
                (api_key, headers, true) => Some(ProviderTarget {
                    service_tier: *self.service_tier.read().expect("service tier lock"),
                    api_key,
                    headers,
                    model,
                }),
                // A store with no live credential resolves the configured
                // fallback key, which never replaces a serving pair
                // (the reload's own gate): restore the captured session
                // target instead.
                _ => route.session_target,
            },
            Err(_) => route.session_target,
        };
        if let Some(target) = target.take() {
            *self.provider_target.write().expect("provider target lock") = Some(target);
        }
    }

    /// Whether an image-model route is armed for the running episode (the
    /// failover primary capture keys off it: a routed episode's failover
    /// restores the routed target).
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

    fn write_image_settings(dir: &std::path::Path, settings: &serde_json::Value) {
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
        settings: &serde_json::Value,
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
            &serde_json::json!({ "imageModel": "battery/mock-vision" }),
        );
        let route = engine
            .resolve_image_turn_route(true)
            .expect("the configured reference routes");
        let route = route.expect("the text-only session model routes");
        assert_eq!(route.model.id, "mock-vision");
        assert_eq!(route.model.provider, "battery");
        let none = engine
            .resolve_image_turn_route(false)
            .expect("image-free batches stay on the session model");
        assert!(none.is_none());
    }

    #[test]
    fn image_route_refusals_name_the_setting() {
        let dir = tempfile::TempDir::new().unwrap();
        let engine = image_route_engine(dir.path(), &serde_json::json!({}));
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
        let dir = tempfile::TempDir::new().unwrap();
        let engine = image_route_engine(
            dir.path(),
            &serde_json::json!({ "imageModel": "nope/nothere" }),
        );
        let error = engine
            .resolve_image_turn_route(true)
            .expect_err("the reference must resolve");
        assert!(
            format!("{error}").contains("could not be resolved"),
            "{error}"
        );
        let dir = tempfile::TempDir::new().unwrap();
        let engine = image_route_engine(
            dir.path(),
            &serde_json::json!({
                "imageModel": "battery/mock-vision",
                "images": { "blockImages": true }
            }),
        );
        let none = engine
            .resolve_image_turn_route(true)
            .expect("blocked images disable routing");
        assert!(none.is_none());
    }

    /// The end-to-end routed episode: the settled assistant row tags the
    /// image model, and the settle restores the session target (TS: the
    /// next dispatch re-evaluates the routing).
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
            &serde_json::json!({ "imageModel": "battery/mock-vision" }),
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
        // it (attribution follows the override model, never the session
        // model).
        assert_eq!(turn_end["model"], serde_json::json!("mock-vision"));
        assert_eq!(turn_end["provider"], serde_json::json!("battery"));
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
        let engine = image_route_engine(dir.path(), &serde_json::json!({}));
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
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, EngineEvent::TurnEnd { .. })),
            "the refused turn produced no model turn"
        );
        registration.unregister();
    }
}
