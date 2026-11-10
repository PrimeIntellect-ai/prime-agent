//! The agent-session engine's model concern: the startup/restore
//! model-resolution cluster (the TS `createAgentSession` chain), the
//! session's live-model and thinking-level surfaces, and the request
//! API-key seam.

use super::{
    AgentSessionEngine, EngineModelSelection, Model, RestoredSessionModel, SessionEngine,
    StartupScope,
};

impl AgentSessionEngine {
    /// The startup chain: the saved settings default, then the featured
    /// default, then the first available model.
    fn startup_chain_model(&self, registry: &pa_core::models::ModelRegistry) -> Option<Model> {
        let available: Vec<Model> = registry.get_available().into_iter().cloned().collect();
        let all: Vec<Model> = registry.get_all().to_vec();
        let settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        let default = settings
            .get_default_provider()
            .zip(settings.get_default_model())
            .map(|(provider, model)| (provider.to_string(), model.to_string()));
        // The create-time `--models` scope: a fresh session starts on the
        // saved default when in scope, else the first scoped model.
        let scope = self
            .startup_scope
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .unwrap_or_default();
        let resolved = pa_core::models::find_initial_model(&pa_core::models::InitialModelOptions {
            cli_provider: None,
            cli_model: None,
            scoped_models: &scope.scoped_models,
            is_continuing: scope.is_continuing,
            default_provider: default.as_ref().map(|(provider, _)| provider.as_str()),
            default_model_id: default.as_ref().map(|(_, model)| model.as_str()),
            all_models: &all,
            available_models: &available,
        })
        .or_else(|| all.first().cloned());
        if let (Some(model), Some(default)) = (&resolved, &default) {
            self.record_startup_default_fallback(model, default, &scope, &available, &all);
        }
        resolved
    }

    fn record_startup_default_fallback(
        &self,
        model: &Model,
        default: &(String, String),
        scope: &StartupScope,
        available_models: &[Model],
        all_models: &[Model],
    ) {
        let (provider, model_id) = default;
        if scope.is_continuing || (model.provider == *provider && model.id == *model_id) {
            return;
        }
        let session_file = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .unwrap_or_default();
        let mut decision = self
            .restored_model
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if decision
            .as_ref()
            .is_some_and(|decision| decision.session_file == session_file)
        {
            return;
        }
        let wanted = scope.patterns.is_empty()
            || pa_core::models::scope_patterns_select_reference(
                &scope.patterns,
                provider,
                model_id,
                available_models,
                all_models,
            );
        if !wanted {
            return;
        }
        let message = format!(
            "Default model {provider}/{model_id} is not available. Using {}/{}",
            model.provider, model.id
        );
        eprintln!("{message}");
        *decision = Some(RestoredSessionModel {
            session_file,
            model: None,
            fallback_message: Some(message),
        });
    }

    /// The runtime-config reset at every session restore: the create's own
    /// flags survive every replacement; the cached thinking level drops (the
    /// clamp follows the moved-to model).
    fn reset_selection_to_spawn_fallback(&self) {
        *self
            .effective_thinking
            .write()
            .expect("effective thinking lock") = None;
        {
            let initial = self
                .initial_selection
                .read()
                .expect("initial selection lock")
                .clone();
            let mut current = self.selection.write().expect("model selection lock");
            if current.provider == initial.provider
                && current.model == initial.model
                && current.api_key == initial.api_key
                && current.thinking == initial.thinking
            {
                return;
            }
            *current = initial;
        }
    }

    /// The create-time session-model restore (see
    /// [`SessionEngine::restore_session_model`]): reset the selection to the
    /// spawn-time fallback, read the saved model context, give the in-flight
    /// refreshes the bounded readiness window, and record the decision.
    /// Explicit spawn flags win; a miss records the fallback (never silent).
    pub(super) async fn restore_session_model_at(
        &self,
        session_path: &std::path::Path,
        pre_read: Option<crate::engine::SavedSessionContext>,
    ) {
        // An unpersisted session (an in-memory fork or a no-session worker's
        // replacement) has no file to read: the reset must not run with
        // nothing to restore.
        if session_path.as_os_str().is_empty() {
            return;
        }
        self.reset_selection_to_spawn_fallback();
        // The file pins the model and thinking level. A caller that already
        // read the context hands it in; otherwise the scan is plain file work on
        // a potentially large file — park it on a blocking thread.
        let saved = if let Some(saved) = pre_read {
            saved
        } else {
            let path = session_path.to_path_buf();
            let Ok(saved) = tokio::task::spawn_blocking(move || saved_session_context(&path)).await
            else {
                return;
            };
            let Some(saved) = saved else {
                return;
            };
            saved
        };
        // TS `createAgentSession` re-reads the saved thinking level at every
        // boot when the runtime config carries no explicit flag: the pinned
        // level wins over the settings/medium default.
        if self.current_selection().thinking.is_none() {
            if let Some(level) = saved.thinking {
                self.configure_model(EngineModelSelection {
                    thinking: Some(level),
                    ..Default::default()
                });
            }
        }
        // An explicit create flag wins for the MODEL — the saved thinking
        // above still applies, and the restore skips the model's readiness
        // window entirely.
        if self.current_selection().model.is_some() {
            return;
        }
        let Some((provider, model_id)) = saved.model else {
            return;
        };
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        registry.load_private_authorization_from_cache();
        let restored = pa_core::models::find_session_model_with_readiness_wait(
            &mut registry,
            &provider,
            &model_id,
            pa_core::models::SESSION_MODEL_RESTORE_READINESS_TIMEOUT_MS,
        )
        .await;
        let (model, fallback_message) = if let Some(restored) = restored {
            (Some((restored.provider, restored.id)), None)
        } else {
            // The restore miss is on the record — the startup chain owns the
            // session.
            let fallback = self.startup_chain_model(&registry);
            let message = match &fallback {
                Some(fallback) => format!(
                    "Could not restore model {provider}/{model_id}. Using {}/{}",
                    fallback.provider, fallback.id
                ),
                None => format!("Could not restore model {provider}/{model_id}"),
            };
            eprintln!("{message}");
            (None, Some(message))
        };
        *self
            .restored_model
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(RestoredSessionModel {
            session_file: session_path.to_path_buf(),
            model,
            fallback_message,
        });
        // The decision is on the record, so the level must resolve against the
        // model this session runs on; a concurrent read may have populated the
        // cache against the startup chain, so drop it once more.
        *self
            .effective_thinking
            .write()
            .expect("effective thinking lock") = None;
        let _ = self.effective_thinking();
    }

    /// The restored-from-session resolution for the engine's current session
    /// file: a catalog flap never silently drifts to the featured default; a
    /// decision for another file is ignored.
    fn restored_model_resolution(
        &self,
        registry: &pa_core::models::ModelRegistry,
    ) -> Option<Model> {
        let decision = self
            .restored_model
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        let (provider, model_id) = decision.model?;
        let current = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        if decision.session_file != current {
            return None;
        }
        pa_core::models::resolve_cli_model(Some(&provider), &model_id, registry.get_all()).model
    }

    /// Emit the daemon model-allowlist refusal's adoption event (schema v1
    /// `model refused`) from any of this worker's enforcement seams.
    pub(crate) fn note_model_refused(&self, surface: &str, selector: &str) {
        self.model_refusal_telemetry
            .note_refused(surface, selector, &self.cwd());
    }

    /// Resolve the model through the composed registry, then enforce the
    /// settings `allowedModels` allowlist: a resolution outside the allowlist
    /// fails loudly here (never a silent fallback), emitting `model refused`.
    pub(super) fn resolve_registry_model(&self) -> anyhow::Result<Model> {
        let model = self.resolve_registry_model_unchecked()?;
        let selector = format!("{}/{}", model.provider, model.id);
        let allowlist = crate::model_allowlist::load(&self.cwd(), &self.config.agent_dir);
        if let Err(refusal) = crate::model_allowlist::assert_allowed(&allowlist, &selector) {
            if let Some(refusal) = refusal.downcast_ref::<pa_core::models::ModelAllowlistRefusal>()
            {
                self.note_model_refused("session_start", &refusal.selector);
            }
            return Err(refusal);
        }
        Ok(model)
    }

    /// The registry resolution before the allowlist gate: the flagged-model
    /// arm or the startup chain.
    fn resolve_registry_model_unchecked(&self) -> anyhow::Result<Model> {
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        // A fresh registry gates private Prime Inference models out until the
        // async authorization refresh runs; adopt the on-disk cache so
        // create-time resolution can pick the session's private model.
        registry.load_private_authorization_from_cache();
        let selection = self.current_selection();
        let Some(model_name) = selection.model.as_deref() else {
            if let Some(model) = self.restored_model_resolution(&registry) {
                return Ok(model);
            }
            let Some(model) = self.startup_chain_model(&registry) else {
                anyhow::bail!(
                    "No models available. Check your installation or add models to models.json."
                );
            };
            return Ok(model);
        };
        // The full catalog, not the auth-configured list: a saved or switched
        // model keeps resolving when no credential is visible; run-start auth
        // validation reports it.
        let all: Vec<Model> = registry.get_all().to_vec();
        let resolved =
            pa_core::models::resolve_cli_model(selection.provider.as_deref(), model_name, &all);
        if let Some(error) = resolved.error {
            anyhow::bail!("{error}");
        }
        resolved
            .model
            .ok_or_else(|| anyhow::anyhow!("No matching model found."))
    }

    /// Test seam: a scripted faux provider (same script contract as pa-cli's
    /// print runtime) drives the engine without the network. The provider
    /// registers once per engine: its queued responses then span the whole
    /// session (multi-turn scripts), instead of replaying from the top on
    /// every model resolution.
    ///
    /// The script model serves the session while the selection is unset or
    /// names it; any other selection resolves through the registry (a
    /// models.json faux-api model streams through the same registered
    /// provider).
    pub(crate) fn resolve_model(&self) -> anyhow::Result<Model> {
        if let Some(script) = &self.config.faux_script {
            let model = if let Some(model) = self.faux_model.get() {
                model.clone()
            } else {
                let model = faux_model_from_script(script)?;
                let _ = self.faux_model.set(model.clone());
                model
            };
            let selection = self.current_selection();
            let names_script_model = selection
                .provider
                .as_deref()
                .is_none_or(|provider| provider == model.provider.as_str())
                && selection
                    .model
                    .as_deref()
                    .is_none_or(|model_id| model_id == model.id.as_str());
            if names_script_model {
                return Ok(model);
            }
            return self.resolve_registry_model();
        }
        self.resolve_registry_model()
    }

    /// The session's live model for summarization-side model calls
    /// (compaction, branch summaries, side questions): the provider target
    /// the stream reads per call — never a fresh resolution
    /// ([`Self::resolve_model`] can resolve differently). Falls back to it
    /// before the session's first build.
    pub(crate) fn session_model(&self) -> anyhow::Result<Model> {
        if let Some(target) = self
            .provider_target
            .read()
            .expect("provider target lock")
            .clone()
        {
            return Ok(target.model);
        }
        self.resolve_model()
    }

    /// The effective session thinking level: the create-config flag, then the
    /// settings default, then "medium" — clamped to what the model supports; an
    /// unresolvable model degrades to "off". Resolved once and cached.
    pub(crate) fn effective_thinking(&self) -> pa_types::ai::ModelThinkingLevel {
        if let Some(level) = *self
            .effective_thinking
            .read()
            .expect("effective thinking lock")
        {
            return level;
        }
        let model = self.resolve_model();
        let selection = self.current_selection();
        let requested = selection
            .thinking
            .or_else(|| {
                // An unflagged fresh session that starts on a scoped entry
                // takes that entry's `:thinking` (the explicit `--thinking`
                // above still wins).
                if selection.model.is_some() {
                    return None;
                }
                let scope = self
                    .startup_scope
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                scope
                    .filter(|scope| !scope.is_continuing)?
                    .scoped_models
                    .iter()
                    .find(|scoped| {
                        model.as_ref().is_ok_and(|model| {
                            scoped.model.provider == model.provider && scoped.model.id == model.id
                        })
                    })?
                    .thinking_level
                    .and_then(|level| {
                        let wire = serde_json::to_value(level).ok()?;
                        wire.as_str()
                            .and_then(pa_ai::models::thinking_level_from_str)
                    })
            })
            .or_else(|| {
                let settings =
                    pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
                settings
                    .get_default_thinking_level()
                    .map(pa_core::settings::ThinkingLevelSetting::model_level)
            })
            // TS `DEFAULT_THINKING_LEVEL`.
            .unwrap_or(pa_types::ai::ModelThinkingLevel::Medium);
        let resolved = match model {
            Ok(model) => pa_ai::models::clamp_thinking_level(&model, requested),
            Err(_) => pa_types::ai::ModelThinkingLevel::Off,
        };
        *self
            .effective_thinking
            .write()
            .expect("effective thinking lock") = Some(resolved);
        resolved
    }

    /// The full request-auth resolution: the registry's single lookup —
    /// possibly refreshing an expired OAuth token through the engine's
    /// OAuth integration. `request_model` carries the per-call xAI
    /// request model the lookup serves (TS `requestModel`); other
    /// providers leave it unset.
    ///
    /// The create-config key rides the store's runtime-override arm (TS
    /// installs `--api-key` with `setRuntimeApiKey` before lookup, v0.9.8
    /// main.ts:862), so the registry's resolution — the key, the headers,
    /// and the xAI request model — follows one winning source: a stored
    /// subscription never re-shapes a session the config keys
    /// explicitly, and a mid-session `/login` never switches the request
    /// model under the override.
    ///
    /// The engine keeps one `AuthStorage` for its life — TS's single
    /// auth-storage instance, whose `reload()` keeps the last read's data
    /// on a read error (v0.9.8 auth-storage.ts:674-687): a failed store
    /// read is NOT a logout. While another writer holds the auth document's
    /// lock, or while auth.json does not parse, the runtime override and
    /// the last-read credential keep serving, and the lookup's own arms
    /// still answer environment keys and the configured `models.json`
    /// fallback — exactly what a healthy store that holds nothing for the
    /// provider would serve.
    ///
    /// The live session's stream consults this per provider call through
    /// the resolver `build_session` wires, so a credential rotated by
    /// another process (`/login`) or an OAuth token refreshed at expiry
    /// serves the next request without a restart. The resolution is
    /// blocking I/O; the stream seam runs it off the executor under the
    /// turn's abort signal.
    pub(crate) fn resolve_request_auth(
        &self,
        model: &Model,
    ) -> pa_core::models::ResolvedRequestAuth {
        // Poison recovery (the repo's pattern): a panic inside one
        // resolution must not break every later provider call — the
        // poisoned store is already `None` (the panicked call took it and
        // never returned it), so the next call rebuilds it from the store.
        let mut store = self
            .request_auth_store
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut auth = store.take().unwrap_or_else(|| {
            pa_core::auth::AuthStorage::create_with_oauth(
                &self.config.agent_dir,
                std::sync::Arc::clone(&self.request_auth_oauth),
            )
        });
        // The per-call reload keeps the resolution live: a credential
        // another process wrote serves the next call, and a failed read
        // keeps the last read's data (the store is engine-lived, so the
        // previous read's credential is still in memory — TS `this.data`).
        auth.reload();
        if let Some(api_key) = &self.current_selection().api_key {
            auth.set_runtime_api_key(&model.provider, api_key.clone());
        }
        // The request-auth registry resolves auth only for the serving
        // provider: its construction never resolves the unrelated Prime
        // Inference credential (a stored `!command` helper must not run
        // on every provider call).
        let mut registry = pa_core::models::ModelRegistry::create_for_request_auth(
            auth,
            self.config.agent_dir.join("models.json"),
        );
        // The registry's single possibly-refreshing lookup answers the key,
        // the headers, the request model, and whether a live source served
        // (the lookup may OAuth-refresh and store a fresh token); a second
        // refreshing lookup here would re-fetch a token the first just
        // failed to refresh.
        let resolved = registry.get_api_key_and_headers(model, model.headers.as_ref());
        // The store returns to the engine carrying whatever the lookup
        // refreshed: the next call's last-read data is the freshest.
        *store = Some(registry.auth);
        resolved
    }

    pub(crate) fn resolve_request_api_key(&self, model: &Model) -> Option<String> {
        if let Some(api_key) = &self.current_selection().api_key {
            return Some(api_key.clone());
        }
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry = pa_core::models::ModelRegistry::create_for_request_auth(
            auth,
            self.config.agent_dir.join("models.json"),
        );
        registry
            .get_api_key_and_headers(model, model.headers.as_ref())
            .api_key
    }

    /// The primary target a failover episode restores: the captured
    /// model with the serving service tier. Request auth needs no
    /// restore — the live session's stream re-resolves it from the
    /// credential store on every provider call, so the slot's auth half
    /// is write-only for the daemon's stream.
    pub(crate) fn restored_primary_target(
        &self,
        primary: &Model,
    ) -> pa_core::session_engine::provider_adapter::ProviderTarget {
        pa_core::session_engine::provider_adapter::ProviderTarget {
            service_tier: *self.service_tier.read().expect("service tier lock"),
            api_key: None,
            model: primary.clone(),
            headers: None,
        }
    }
}

/// The saved model context of a session file: the pinned `(provider,
/// model)` and the saved thinking level, present only when the file carries
/// a `thinking_level_change` row. `None` when the file cannot be read (the
/// create flow owns that failure).
pub(crate) fn saved_session_context(
    path: &std::path::Path,
) -> Option<crate::engine::SavedSessionContext> {
    // Reads the saved (provider, model) + thinking level from the retained
    // window; unsupported files and malformed retained rows fall back to the
    // full open inside `open_windowed`.
    let store = crate::session_store::SessionFile::open_windowed(path).ok()?;
    let has_thinking_level = store.has_thinking_level();
    Some(saved_session_context_from_parts(
        &store.restored_settings(),
        has_thinking_level,
    ))
}

/// The saved context derived from an already-folded `restored_settings()`
/// value: the create path folds the context once, so a pre-read context and a
/// file-read context are identical by construction.
pub(crate) fn saved_session_context_from_parts(
    context: &pa_core::session::SessionContext,
    has_thinking_level: bool,
) -> crate::engine::SavedSessionContext {
    crate::engine::SavedSessionContext {
        model: context.model.clone(),
        thinking: has_thinking_level
            .then(|| pa_ai::models::thinking_level_from_str(&context.thinking_level))
            .flatten(),
    }
}

/// Register the faux provider from a script and return its model. Scripts
/// carry plain-text responses or content-block arrays (thinking, text, tool
/// calls) so harnesses can script full turns. Verification harness only.
fn faux_model_from_script(script: &str) -> anyhow::Result<Model> {
    let script: serde_json::Value = serde_json::from_str(script)?;
    let parsed = pa_ai::faux::script::parse_faux_script(&script).map_err(anyhow::Error::msg)?;
    let registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
    Ok(registration.get_model())
}
