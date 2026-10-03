//! The first-run onboarding concern (moved with its concern): the
//! startup-model probe over the findInitialModel chain, the settings
//! sink behind the pa-tui onboarding trait, and the startup task
//! assembly the interactive launch mounts.

use super::{PathBuf, Result, RunOptions};

/// The startup-model resolution inputs (TS `findInitialModel`'s chain),
/// captured at task construction: the onboarding flow re-resolves the
/// model state at its own boundaries — the branch (TS
/// `isOnboardingModelReady` at flow start) and the completion gate (TS
/// re-reads `getOnboardingState` before `markOnboardingShown`) — because
/// the flow's own sign-in can change the answer.
#[derive(Clone)]
pub(super) struct StartupModelProbe {
    pub(super) cwd: PathBuf,
    pub(super) agent_dir: PathBuf,
    pub(super) cli_provider: Option<String>,
    pub(super) cli_model: Option<String>,
    /// The `--models` scope pattern list, resolved against the fresh
    /// catalog on every probe.
    pub(super) models: Option<Vec<String>>,
    pub(super) is_continuing: bool,
    /// An explicit `--api-key` counts as configured auth (it rides the
    /// resolved model's provider as a runtime key).
    pub(super) api_key: Option<String>,
}

impl StartupModelProbe {
    /// The resolution (TS `findInitialModel` + `isOnboardingModelReady`):
    /// the startup model, and whether it carries configured auth.
    fn resolve(&self) -> (Option<pa_types::ai::Model>, bool) {
        let settings = pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir);
        // The session directory's saved Prime context counts as signed in
        // there, as its requests use it.
        let mut registry = pa_core::models::ModelRegistry::for_session(&self.agent_dir, &self.cwd);
        // Sync resolution on a fresh registry must adopt the on-disk private
        // authorization cache before `get_available` (same rule as the daemon
        // create path).
        registry.load_private_authorization_from_cache();
        let all: Vec<pa_types::ai::Model> = registry.get_all().to_vec();
        let available: Vec<pa_types::ai::Model> =
            registry.get_available().into_iter().cloned().collect();
        let scoped = self
            .models
            .as_deref()
            .map(|patterns| pa_core::models::resolve_model_scope_from_models(patterns, &available))
            .unwrap_or_default();
        let startup_model =
            pa_core::models::find_initial_model(&pa_core::models::InitialModelOptions {
                cli_provider: self.cli_provider.as_deref(),
                cli_model: self.cli_model.as_deref(),
                scoped_models: &scoped,
                is_continuing: self.is_continuing,
                default_provider: settings.get_default_provider(),
                default_model_id: settings.get_default_model(),
                all_models: &all,
                available_models: &available,
            });
        let ready = match &startup_model {
            Some(model) => registry.has_configured_auth(model) || self.api_key.is_some(),
            None => false,
        };
        (startup_model, ready)
    }

    /// The completion telemetry's category columns (TS
    /// `captureOnboardingCompleted`): the resolved startup model's
    /// provider category and the credential source's auth category.
    /// The storage's status candidates cover stored, environment, and
    /// stale credentials; a model the storage cannot explain is ready
    /// through a models.json provider key (the registry's request-auth
    /// resolves it) or the `--api-key` flag (a runtime key the daemon
    /// installs — the flag is the client's evidence). Best-effort — a
    /// resolution failure reports the unknown columns.
    fn telemetry_categories(&self) -> (String, String) {
        use pa_core::auth::AuthSource;
        let Some(model) = self.resolve().0 else {
            return ("none".to_string(), "unknown".to_string());
        };
        let provider_category =
            pa_core::session_engine::telemetry::provider_category(Some(&model.provider));
        let auth = pa_core::auth::AuthStorage::for_session(&self.agent_dir, &self.cwd);
        let status = auth.get_auth_status(&model.provider);
        let credential = auth.get_all().credential(&model.provider);
        let auth_category = match status.source {
            // TS `telemetryAuthCategory`: the stored credential reports
            // its type.
            Some(AuthSource::Stored) => credential.as_ref().map_or_else(
                || "stored".to_string(),
                |credential| credential.credential_type().to_string(),
            ),
            Some(AuthSource::Runtime) => "runtime_api_key".to_string(),
            Some(AuthSource::Environment) => "environment".to_string(),
            Some(AuthSource::PrimeCli) => "prime_cli".to_string(),
            Some(AuthSource::ModelsJsonKey | AuthSource::ModelsJsonCommand) => {
                "models_json".to_string()
            }
            Some(AuthSource::Fallback) => "fallback".to_string(),
            Some(AuthSource::Stale) => "stale".to_string(),
            None => {
                // The `--api-key` flag rides as a runtime key the daemon
                // installs; the registry's request-auth resolves a
                // models.json provider key only when one actually
                // resolves (`ok` alone is not evidence of a key).
                if self.api_key.is_some() {
                    "runtime_api_key".to_string()
                } else {
                    let mut registry = pa_core::models::ModelRegistry::create(
                        auth,
                        self.agent_dir.join("models.json"),
                    );
                    if registry
                        .get_api_key_and_headers(&model, None)
                        .api_key
                        .is_some()
                    {
                        "models_json".to_string()
                    } else {
                        "none".to_string()
                    }
                }
            }
        };
        (auth_category, provider_category)
    }
}

/// Persistence for the first-run onboarding answers: the global settings
/// file (TS `setAgentTracesEnabled` / `markOnboardingShown` + flush).
pub(super) struct SettingsOnboardingSink {
    pub(super) cwd: PathBuf,
    pub(super) agent_dir: PathBuf,
    /// When the onboarding task was created: the `onboarding completed`
    /// duration measures sink creation to completion (the TUI starts the
    /// flow right away; a fresh home answers the question, a home with a
    /// standing choice completes silently).
    pub(super) created_at: std::time::Instant,
    /// The flow's `onboarding_id` (#2117): pairs the `onboarding stage`
    /// events and the `onboarding completed` enrichment.
    pub(super) onboarding_id: String,
    /// Whether the `ready` stage already fired (the mount-time snapshot);
    /// a mid-flow sign-in's completion-time readiness emits it then, once.
    pub(super) ready_emitted: std::sync::atomic::AtomicBool,
    /// The startup-model probe (the completion telemetry's category
    /// columns: the resolved startup model and its auth source).
    pub(super) probe: StartupModelProbe,
    /// The success outcome was reported (the completion marker ran).
    pub(super) completion_reported: std::sync::atomic::AtomicBool,
}

impl SettingsOnboardingSink {
    /// The `onboarding completed` properties (TS
    /// `captureOnboardingCompleted`): the auth and provider categories read
    /// the resolved startup model (`getCurrentModel` + its auth status).
    fn completed_properties(&self, outcome: &str, duration_ms: u64) -> pa_telemetry::Properties {
        let mut properties = pa_telemetry::base_properties("interactive");
        properties.set("duration_ms", serde_json::Value::from(duration_ms));
        properties.set("outcome", serde_json::Value::from(outcome));
        let (auth_category, provider_category) = self.probe.telemetry_categories();
        properties.set("auth_category", serde_json::Value::from(auth_category));
        properties.set(
            "provider_category",
            serde_json::Value::from(provider_category),
        );
        properties.set(
            "onboarding_id",
            serde_json::Value::from(self.onboarding_id.as_str()),
        );
        properties
    }

    /// Track `onboarding completed` with an unfinished `outcome` on a fresh
    /// client and return it, or `None` when nothing is reported.
    pub(super) fn track_incomplete(&self, outcome: &str) -> Option<pa_telemetry::TelemetryClient> {
        // A completed flow whose marker failed to persist already reported
        // its success.
        if self
            .completion_reported
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return None;
        }
        let settings = pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir);
        if crate::mode::telemetry_disabled(&settings) {
            return None;
        }
        let client = pa_core::session_engine::telemetry::build_client(&settings, &self.agent_dir);
        let duration_ms = self.created_at.elapsed().as_millis() as u64;
        client.track(
            "onboarding completed",
            self.completed_properties(outcome, duration_ms),
        );
        Some(client)
    }
}

impl pa_tui::interactive::OnboardingSink for SettingsOnboardingSink {
    fn onboarding_shown(&self) -> bool {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
            .get_onboarding_shown()
    }

    fn agent_traces_choice_written(&self) -> bool {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
            .agent_traces_choice_written()
    }

    fn set_agent_traces_enabled(&self, enabled: bool) -> Result<()> {
        let mut settings = pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir);
        settings.set_agent_traces_enabled(enabled)
    }

    fn mark_onboarding_complete(&self) -> Result<()> {
        let mut settings = pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir);
        settings.set_onboarding_shown(true)?;
        // `onboarding completed` (schema v1) with the success outcome: the
        // marker writes only on a completed flow. Best-effort like all
        // telemetry.
        self.completion_reported
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if !crate::mode::telemetry_disabled(&settings) {
            let client =
                pa_core::session_engine::telemetry::build_client(&settings, &self.agent_dir);
            let duration_ms = self.created_at.elapsed().as_millis() as u64;
            client.track(
                "onboarding completed",
                self.completed_properties("success", duration_ms),
            );
            // The `exit` stage (#2117 `onboarding stage`): the completion
            // marker's own stage event, paired by `onboarding_id`. The
            // final flush rides the client's drop (the worker drains once
            // every handle is gone - no missed fires).
            // A sign-in during the flow makes the readiness land late:
            // the `ready` stage fires at the completion moment when the
            // probe resolves ready and it never fired at mount time (the
            // stage facts carry no time data).
            if !self.ready_emitted.load(std::sync::atomic::Ordering::SeqCst)
                && self.probe.resolve().1
            {
                self.ready_emitted
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                pa_telemetry::OnboardingStage {
                    onboarding_id: self.onboarding_id.clone(),
                    stage: "ready",
                    outcome: "configured",
                    duration_ms: None,
                    auth_category: Some("none"),
                    entry_reason: Some("first_setup"),
                    timing_scope: Some("system_work"),
                }
                .track(&client);
            }
            pa_telemetry::OnboardingStage {
                onboarding_id: self.onboarding_id.clone(),
                stage: "exit",
                outcome: "completed",
                duration_ms: Some(duration_ms),
                auth_category: Some("none"),
                entry_reason: Some("first_setup"),
                timing_scope: Some("elapsed_including_user_wait"),
            }
            .track(&client);
        }
        Ok(())
    }

    fn onboarding_incomplete(
        &self,
        outcome: &'static str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let client = self.track_incomplete(outcome);
        Box::pin(async move {
            // The exit keys quit the app right after: wait out the final
            // flush (bounded by the sink's request timeout) so the runtime
            // teardown cannot abort the worker before it delivers.
            if let Some(client) = client {
                let _ = client.shutdown().await;
            }
        })
    }
}

/// TS `shouldRunOnboarding`: first launch is defined by the settings flag
/// alone — credentials found on disk (a Prime CLI token, an API key in
/// the environment) never skip the flow, they only make the sign-in step
/// instant. The task carries the startup model state (the resolved model
/// is TS `getCurrentModel` at flow time; the readiness probe decides the
/// branch and gates the completion marker), and the provider auth surface
/// the full flow signs in through. The startup model follows the TS
/// `findInitialModel` chain — explicit flags, the `--models` scope, the
/// saved settings default, the featured default, the first available
/// model.
pub(super) fn onboarding_task(
    options: &RunOptions,
    provider_auth: Option<pa_tui::provider_auth::ProviderAuthCommandsHandle>,
) -> (
    Option<pa_tui::interactive::OnboardingTask>,
    Vec<pa_telemetry::OnboardingStage>,
) {
    let config = &options.config;
    let settings = pa_core::settings::SettingsManager::create(&config.cwd, &config.agent_dir);
    if settings.get_onboarding_shown() {
        return (None, Vec::new());
    }
    let probe = StartupModelProbe {
        cwd: config.cwd.clone(),
        agent_dir: config.agent_dir.clone(),
        cli_provider: config.provider.clone(),
        cli_model: config.model.clone(),
        models: config.models.clone(),
        // A fork launch resolves the startup model as a continuation
        // (#2806): the copy holds the source's rows.
        is_continuing: options.session.resume.is_some()
            || options.session.continue_recent
            || options.session.fork.is_some(),
        api_key: config.api_key.clone(),
    };
    let (current_model, model_ready_now) = probe.resolve();
    let readiness_probe = probe.clone();
    let onboarding_id = uuid::Uuid::new_v4().to_string();
    // `onboarding stage` (v2, #2117): the flow's REAL stages only - the
    // Rust onboarding is the first-run trace question, so `entry` fires
    // when the task mounts and `ready` once the startup model resolved
    // with configured auth (the flow's credential gate); no invented
    // provider-selection or login steps. The records return to the caller
    // because THIS call runs before the interactive runtime exists (a
    // `TelemetryClient` spawned here is inert and the events would drop);
    // `run_interactive_mode` emits them inside its runtime.
    let mount_ready = model_ready_now;
    let pending_stages = if crate::mode::telemetry_disabled(&settings) {
        Vec::new()
    } else {
        let mut stages = vec![pa_telemetry::OnboardingStage {
            onboarding_id: onboarding_id.clone(),
            stage: "entry",
            outcome: "initiated",
            duration_ms: None,
            auth_category: Some("none"),
            entry_reason: Some("first_setup"),
            timing_scope: None,
        }];
        if mount_ready {
            stages.push(pa_telemetry::OnboardingStage {
                onboarding_id: onboarding_id.clone(),
                stage: "ready",
                outcome: "configured",
                duration_ms: None,
                auth_category: Some("none"),
                entry_reason: Some("first_setup"),
                timing_scope: Some("system_work"),
            });
        }
        stages
    };
    let task = pa_tui::interactive::OnboardingTask {
        sink: std::sync::Arc::new(SettingsOnboardingSink {
            cwd: config.cwd.clone(),
            agent_dir: config.agent_dir.clone(),
            created_at: std::time::Instant::now(),
            onboarding_id,
            ready_emitted: std::sync::atomic::AtomicBool::new(mount_ready),
            completion_reported: std::sync::atomic::AtomicBool::new(false),
            probe,
        }),
        model_ready: std::sync::Arc::new(move || readiness_probe.resolve().1),
        current_model,
        provider_auth,
    };
    (Some(task), pending_stages)
}
