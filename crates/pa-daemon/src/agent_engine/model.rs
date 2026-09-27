//! The agent-session engine's model concern: the startup/restore
//! model-resolution cluster (the TS `createAgentSession` chain), the
//! session's live-model and thinking-level surfaces, the request API-key
//! seam, and the persisted max-depth read.

use super::*;

impl AgentSessionEngine {
    /// The TS `createAgentSession` startup chain (the no-flagged-model
    /// arm of [`Self::resolve_registry_model`]): the saved settings
    /// default, then the featured default, then the first available
    /// model — resolved against `registry`'s current view.
    fn startup_chain_model(&self, registry: &pa_core::models::ModelRegistry) -> Option<Model> {
        let available: Vec<Model> = registry.get_available().into_iter().cloned().collect();
        let all: Vec<Model> = registry.get_all().to_vec();
        let settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        pa_core::models::find_initial_model(&pa_core::models::InitialModelOptions {
            cli_provider: None,
            cli_model: None,
            scoped_models: &[],
            is_continuing: false,
            default_provider: settings.get_default_provider(),
            default_model_id: settings.get_default_model(),
            all_models: &all,
            available_models: &available,
        })
        .or_else(|| all.first().cloned())
    }

    /// The runtime-config reset at every session restore (TS
    /// `switchSession` -> `createRuntime` -> `createAgentSession`): the
    /// session's model selection returns to the session runtime config
    /// (the spawn-time fallback folded with the create command's explicit
    /// flags, TS's merged `sessionConfig`), so a mid-session `/model`
    /// switch belongs to the session it switched and never to the
    /// moved-to one — whose own file pins what it should run on.
    ///
    /// The cached thinking level is always dropped: it was computed
    /// against the dropped selection (or the previous session's restored
    /// model). TS `createAgentSession` resolves the model first and
    /// clamps the thinking level against it, so the clamp must follow the
    /// resolution the moved-to session actually runs on — the restore
    /// re-resolves the level once it has recorded its decision, and the
    /// first read after a flagged reset (an explicit selection the
    /// restore returns early for) resolves lazily against that selection.
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
    /// [`SessionEngine::restore_session_model`]): reset the selection to
    /// the spawn-time fallback (the TS runtime-config reset), read the
    /// session file's saved model context, give the in-flight
    /// catalog/auth refreshes the bounded readiness window, and record
    /// the decision for this file. Explicit spawn flags win (TS
    /// `options.model`); a session with no saved model keeps the startup
    /// chain; a restore that still misses after the window records the
    /// fallback (`model_fallback_message`, never silent).
    pub(super) async fn restore_session_model_at(&self, session_path: &std::path::Path) {
        // An unpersisted session (an in-memory fork or a no-session
        // worker's replacement) has no file to read: TS restores its
        // branch context, whose `model_change` row is the live branch's
        // own — the model the session already runs on — so the
        // runtime-config reset must not run with nothing to restore.
        if session_path.as_os_str().is_empty() {
            return;
        }
        self.reset_selection_to_spawn_fallback();
        // TS `buildSessionContext()`: the session file pins the model it
        // last ran on and the thinking level it last set. The scan is
        // plain file work on a potentially large session file — park it
        // on a blocking thread.
        let path = session_path.to_path_buf();
        let Ok(saved) = tokio::task::spawn_blocking(move || saved_session_context(&path)).await
        else {
            return;
        };
        let Some(saved) = saved else {
            return;
        };
        // TS `createAgentSession` re-reads the session's saved thinking
        // level at every boot (`hasThinkingEntry ?
        // existingSession.thinkingLevel` — sdk.ts) when the runtime config
        // carries no explicit flag: the moved-to session's pinned level
        // wins over the settings/medium default. The level re-clamps
        // against the model below (the reset dropped the cache).
        if self.current_selection().thinking.is_none() {
            if let Some(level) = saved.thinking {
                self.configure_model(EngineModelSelection {
                    thinking: Some(level),
                    ..Default::default()
                });
            }
        }
        // An explicit create flag wins for the MODEL (TS `options.model`)
        // — the saved thinking above still applies, then the restore skips
        // the model's readiness window entirely.
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
            // The TS `modelFallbackMessage`: the restore miss is on the
            // record — the startup chain owns the session, and the
            // summary publishes what happened (never silent).
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
        // The decision is on the record now, so the level must resolve
        // against the model this session actually runs on (the restored
        // pin, or the startup chain after a missed window) — TS
        // `createAgentSession` resolves the model first and clamps the
        // thinking level against it. A concurrent summary/roster read may
        // have populated the cache against the startup chain while the
        // restore was still awaiting: drop the cache once more so the
        // post-decision resolution wins for every later reader (the reset
        // dropped it too, but the window in between is concurrent).
        *self
            .effective_thinking
            .write()
            .expect("effective thinking lock") = None;
        let _ = self.effective_thinking();
    }

    /// The restored-from-session resolution for the engine's current
    /// session file (TS `createAgentSession`'s restored-from-session
    /// step): a decision computed for this file resolves its pinned model
    /// through the same exact-match path a flagged selection takes — a
    /// catalog flap rebuilds the private route template on the same id
    /// (`build_fallback_model`), never silently drifting to the featured
    /// default. A decision for another file (a replacement flow that has
    /// not recomputed yet) is ignored.
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

    /// Emit the daemon model-allowlist refusal's adoption event (schema
    /// v1 `model refused`) from any of this worker's enforcement seams.
    /// The telemetry binds to the engine's live cwd, so a session that
    /// moved directories reports through the current project scope.
    pub(crate) fn note_model_refused(&self, surface: &str, selector: &str) {
        self.model_refusal_telemetry
            .note_refused(surface, selector, &self.cwd());
    }

    /// Resolve the model through the composed registry, then enforce the
    /// settings `allowedModels` allowlist: a resolution outside the
    /// allowlist fails loudly here (the silent-fallback guarantee — the
    /// startup chain never lands a session on a model the daemon may not
    /// resolve to), and the refusal emits `model refused`.
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
    /// arm (TS `resolveCliModel`) or the TS `createAgentSession` startup
    /// chain.
    fn resolve_registry_model_unchecked(&self) -> anyhow::Result<Model> {
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        // A fresh registry gates private Prime Inference models out until the
        // async authorization refresh runs; adopt the on-disk authorization
        // cache so create-time resolution can pick the session's private
        // model (e.g. internal/glm-5.3-fast).
        registry.load_private_authorization_from_cache();
        let selection = self.current_selection();
        let Some(model_name) = selection.model.as_deref() else {
            // No flagged model: the restored-from-session decision comes
            // first (TS `createAgentSession`), then the startup chain —
            // the saved settings default, then the featured default, then
            // the first available model.
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
        // TS `resolveCliModel` resolves against `modelRegistry.getAll()`
        // — the full catalog, not the auth-configured list ("use *all*
        // models here, not just models with pre-configured auth. This
        // allows --api-key to be used for first-time setup"): a saved or
        // switched model keeps resolving when no provider credential is
        // visible to the worker, and the turn's run-start auth validation
        // reports the missing credential with the TS message instead.
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
    pub(crate) fn resolve_model(&self) -> anyhow::Result<Model> {
        if let Some(script) = &self.config.faux_script {
            if let Some(model) = self.faux_model.get() {
                return Ok(model.clone());
            }
            let model = faux_model_from_script(script)?;
            let _ = self.faux_model.set(model.clone());
            return Ok(model);
        }
        self.resolve_registry_model()
    }

    /// The session's live model for summarization-side model calls
    /// (compaction summarizers, branch summaries, side questions, and the
    /// compaction-triggered refinement): the provider target the built
    /// session's stream reads per call — the model the session is actually
    /// running on. TS `_runAutoCompaction` runs its summarizer on
    /// `this.model`, the session's live model, never a fresh resolution.
    ///
    /// [`Self::resolve_model`] consults a registry built from scratch each
    /// call (startup chain over the live catalog, settings, and auth), so
    /// two consecutive calls can resolve differently and a summarizer arm
    /// can land on a provider the session never used — the R8 report: a
    /// live prime-inference session whose threshold auto-compaction
    /// resolved to `amazon-bedrock` and failed with "No AWS credentials
    /// available for Bedrock" while the session's turns kept streaming
    /// through the target's provider. The turn loop already follows the
    /// target (the stream reads it per call); the summarizer arms follow
    /// the same chain.
    ///
    /// Falls back to [`Self::resolve_model`] before the session's first
    /// build (the target is set at build): the same resolution the build
    /// itself would make, for the surfaces that can run before any turn
    /// (the `/compact` wire command on a fresh session).
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

    /// The effective session thinking level (the sdk.ts `createAgentSession`
    /// order): the create-config flag, then the settings default, then
    /// "medium" — always clamped to what the model supports, where the
    /// model is the one the session actually runs on (the restored pin
    /// after a session-model restore, the explicit selection after a
    /// flagged create); a model that cannot be resolved degrades to
    /// "off". Resolved once at the create/restore seam and cached so
    /// summary/state calls stay side-effect-free while turns run.
    pub(super) fn effective_thinking(&self) -> pa_types::ai::ModelThinkingLevel {
        if let Some(level) = *self
            .effective_thinking
            .read()
            .expect("effective thinking lock")
        {
            return level;
        }
        let requested = self
            .current_selection()
            .thinking
            .or_else(|| {
                let settings =
                    pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
                settings
                    .get_default_thinking_level()
                    .map(pa_core::settings::ThinkingLevelSetting::model_level)
            })
            // TS `DEFAULT_THINKING_LEVEL`.
            .unwrap_or(pa_types::ai::ModelThinkingLevel::Medium);
        let resolved = match self.resolve_model() {
            Ok(model) => pa_ai::models::clamp_thinking_level(&model, requested),
            Err(_) => pa_types::ai::ModelThinkingLevel::Off,
        };
        *self
            .effective_thinking
            .write()
            .expect("effective thinking lock") = Some(resolved);
        resolved
    }

    /// Resolve the request API key for `model`: the create-config key (the
    /// TS `setRuntimeApiKey` path), else the registry's auth resolution
    /// The request-time api key AND its resolved provider headers (the
    /// selection's own headers lead; the registry resolves the model's
    /// configured ones otherwise): the provider target carries both, so
    /// models needing custom or auth headers send them on every
    /// request — the same resolution `set_model`'s swap applies.
    pub(crate) fn resolve_request_key_and_headers(
        &self,
        model: &Model,
    ) -> (
        Option<String>,
        Option<std::collections::BTreeMap<String, String>>,
    ) {
        if let Some(api_key) = &self.current_selection().api_key {
            return (Some(api_key.clone()), model.headers.clone());
        }
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        let resolved = registry.get_api_key_and_headers(model, model.headers.as_ref());
        (resolved.api_key, resolved.headers)
    }

    /// (auth storage, then the models.json provider `apiKey` — the same
    /// sources `getApiKeyAndHeaders` merges in the TS product).
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
}

/// The last persisted `rlm_max_depth_state` custom entry in a session
/// file (TS `_loadPersistedRlmMaxDepthState`): the chat override a
/// resumed session re-seeds its depth bound from. `None` when the file
/// carries no override (or cannot be read - an unreadable file keeps the
/// create-carried bound, exactly the TS fallthrough).
pub(crate) fn persisted_rlm_max_depth(path: Option<&str>) -> Option<u64> {
    let path = std::path::Path::new(path?);
    let content = std::fs::read_to_string(path).ok()?;
    crate::session_store::parse_session_entries(&content)
        .iter()
        .rev()
        .find_map(|entry| {
            (entry.get("type").and_then(Value::as_str) == Some("custom")
                && entry.get("customType").and_then(Value::as_str) == Some("rlm_max_depth_state"))
            .then(|| {
                entry
                    .get("data")
                    .and_then(|data| data.get("maxDepth"))
                    .and_then(Value::as_u64)
            })
            .flatten()
        })
}

/// The saved model context of a session file (TS
/// `buildSessionContext().model`): the model the session last ran on —
/// the last `model_change` row, else the last assistant message's
/// provider/model. `None` when the file carries no model context (a
/// fresh session) or cannot be read (the create flow owns that failure).
/// The session file's saved model context (TS `buildSessionContext`): the
/// pinned `(provider, model)` and the saved thinking level — present only
/// when the file carries a `thinking_level_change` row (TS
/// `hasThinkingEntry`).
pub(crate) struct SavedSessionContext {
    pub(crate) model: Option<(String, String)>,
    pub(crate) thinking: Option<pa_types::ai::ModelThinkingLevel>,
}

pub(crate) fn saved_session_context(path: &std::path::Path) -> Option<SavedSessionContext> {
    // Windowed-first: the windowed store answers the same saved-context
    // semantics (the window walk's model/thinking overlays cover rows the
    // retained window dropped; `restored_settings` applies them plus any
    // post-window live rows) without parsing the full history — the cold
    // resume of a large compacted session otherwise pays a full-file parse
    // here just to read two scalars. Unsupported or malformed-retained
    // files fall back to the full open inside `open_windowed` itself, so
    // every fallback path keeps the pre-windowed behavior.
    let store = crate::session_store::SessionFile::open_windowed(path).ok()?;
    let context = store.restored_settings();
    let thinking = store
        .has_thinking_level()
        .then(|| pa_ai::models::thinking_level_from_str(&context.thinking_level))
        .flatten();
    Some(SavedSessionContext {
        model: context.model,
        thinking,
    })
}
