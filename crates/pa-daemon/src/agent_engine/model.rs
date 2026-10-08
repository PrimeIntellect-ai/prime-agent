//! The agent-session engine's model concern: the startup/restore
//! model-resolution cluster (the TS `createAgentSession` chain), the
//! session's live-model and thinking-level surfaces, the request API-key
//! seam, and the persisted max-depth read.

use super::{
    AgentSessionEngine, EngineModelSelection, Model, RestoredSessionModel, SessionEngine, Value,
};

impl AgentSessionEngine {
    /// The startup chain: the saved settings default, then the featured
    /// default, then the first available model.
    fn startup_chain_model(&self, registry: &pa_core::models::ModelRegistry) -> Option<Model> {
        let available: Vec<Model> = registry.get_available().into_iter().cloned().collect();
        let all: Vec<Model> = registry.get_all().to_vec();
        let settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        // The create-time `--models` scope: a fresh session starts on the
        // saved default when in scope, else the first scoped model.
        let (scoped_models, is_continuing) = match self
            .startup_scope
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            Some(scope) => (scope.scoped_models, scope.is_continuing),
            None => (Vec::new(), false),
        };
        pa_core::models::find_initial_model(&pa_core::models::InitialModelOptions {
            cli_provider: None,
            cli_model: None,
            scoped_models: &scoped_models,
            is_continuing,
            default_provider: settings.get_default_provider(),
            default_model_id: settings.get_default_model(),
            all_models: &all,
            available_models: &available,
        })
        .or_else(|| all.first().cloned())
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

    /// The request-time api key AND its resolved provider headers (the
    /// selection's own headers lead; the registry resolves the model's
    /// otherwise): models needing custom or auth headers send them on every
    /// request.
    pub(crate) fn resolve_request_key_and_headers(
        &self,
        model: &Model,
    ) -> (
        Option<String>,
        Option<std::collections::BTreeMap<String, String>>,
    ) {
        let (api_key, headers, _store_healthy) =
            self.resolve_request_key_and_headers_and_store_health(model);
        (api_key, headers)
    }

    /// [`Self::resolve_request_key_and_headers`] plus the auth store's
    /// read health: `false` means the store's last load failed (an
    /// unreadable `auth.json`), in which case the registry resolves the
    /// configured fallback key — not a stored credential. A caller that
    /// replaces last-good auth with a resolved pair must check this the
    /// way `/reload`'s gate does.
    pub(crate) fn resolve_request_key_and_headers_and_store_health(
        &self,
        model: &Model,
    ) -> (
        Option<String>,
        Option<std::collections::BTreeMap<String, String>>,
        bool,
    ) {
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let store_healthy = auth.load_error().is_none();
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        let resolved = registry.get_api_key_and_headers(model, model.headers.as_ref());
        if let Some(api_key) = &self.current_selection().api_key {
            // The create-config key override pins the key, never the headers:
            // the registry's merged headers still ship, exactly like the TS
            // `getApiKeyAndHeaders` override path. The override lives in
            // memory, so the pair stands regardless of the store's health.
            return (Some(api_key.clone()), resolved.headers, true);
        }
        (resolved.api_key, resolved.headers, store_healthy)
    }

    pub(crate) fn resolve_request_api_key(&self, model: &Model) -> Option<String> {
        if let Some(api_key) = &self.current_selection().api_key {
            return Some(api_key.clone());
        }
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        registry
            .get_api_key_and_headers(model, model.headers.as_ref())
            .api_key
    }

    /// The primary target a failover episode restores: the captured model
    /// with the request auth RE-RESOLVED from the store (a credential
    /// rotated — and reloaded — during the failover serves from the store,
    /// never the pre-failover capture; the capture only backs a resolution
    /// that yields nothing).
    pub(crate) fn restored_primary_target(
        &self,
        primary: &Model,
        captured_api_key: Option<String>,
        captured_headers: Option<std::collections::BTreeMap<String, String>>,
    ) -> pa_core::session_engine::provider_adapter::ProviderTarget {
        let (api_key, headers, store_healthy) =
            self.resolve_request_key_and_headers_and_store_health(primary);
        // The capture backs the restore when the store resolves nothing
        // OR the store itself failed to read: an unreadable `auth.json`
        // makes the fresh resolution fall to the configured fallback key,
        // which is not a credential — the captured pair is the last-good
        // one, exactly the overwrite `/reload`'s gate avoids. A healthy
        // resolution REPLACES the pair, headers included.
        let (api_key, headers) = match api_key {
            Some(api_key) if store_healthy => (Some(api_key), headers),
            _ => (captured_api_key, captured_headers),
        };
        pa_core::session_engine::provider_adapter::ProviderTarget {
            service_tier: *self.service_tier.read().expect("service tier lock"),
            api_key,
            model: primary.clone(),
            headers,
        }
    }
}

/// The last persisted `rlm_max_depth_state` custom entry in a session
/// file (TS `_loadPersistedRlmMaxDepthState`): the chat override a resumed
/// session re-seeds its depth bound from. `None` when absent or unreadable.
/// Same contract as the reference oracle (`agent_engine/tests.rs`): whole
/// file valid UTF-8, newest-first, malformed lines skip.
pub(crate) fn persisted_rlm_max_depth(path: Option<&str>) -> Option<u64> {
    let path = std::path::Path::new(path?);
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::BufReader::new(std::fs::File::open(path).ok()?),
        &mut bytes,
    )
    .ok()?;
    let content = std::str::from_utf8(&bytes).ok()?;
    content
        .lines()
        .rev()
        // The exact union gate: a matching row's raw text carries either the
        // `customType` literal or a `\u`-escape (serde never letter-escapes),
        // so the union admits every line the reference could match;
        // `rlm_max_depth_row` judges the candidates by the decoded fields.
        .filter(|line| line.contains("rlm_max_depth_state") || line.contains("\\u"))
        .find_map(rlm_max_depth_row)
}

/// One candidate line's depth bound: `Some(depth)` for a matching custom
/// row with a parseable `data.maxDepth`, `None` otherwise.
fn rlm_max_depth_row(line: &str) -> Option<u64> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("custom") {
        return None;
    }
    if value.get("customType").and_then(Value::as_str) != Some("rlm_max_depth_state") {
        return None;
    }
    value
        .get("data")
        .and_then(|data| data.get("maxDepth"))
        .and_then(Value::as_u64)
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
