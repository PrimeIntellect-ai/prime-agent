//! The daemon's enforcement of the settings `allowedModels` allowlist: the
//! worker-side model-resolution seams (`set_model`, the RLM child-model
//! resolution, and the worker's startup model chain) refuse a model
//! outside the allowlist loudly (a [`ModelAllowlistRefusal`] error
//! surfaces to the caller; the daemon never falls back to a different
//! model) and emit the adoption event (`model refused`, schema v1).

use anyhow::Result;
use std::path::Path;

use pa_core::models::ModelAllowlistRefusal;
use pa_telemetry::TelemetryClient;

/// The daemon allowlist's loaded state (settings `allowedModels`, global
/// scope). A security guardrail fails CLOSED: a settings document that
/// could not be loaded is an unknown policy, never an unrestricted one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonAllowlist {
    /// No `allowedModels` configured: unrestricted (TS parity).
    Unrestricted,
    /// The configured patterns.
    Allowed(Vec<String>),
    /// The global settings document could not be loaded (lock contention,
    /// read, or parse failure): the configured policy is unknown, so every
    /// resolution fails loudly instead of bypassing it.
    Unreadable(String),
}

/// Load the daemon allowlist state (settings `allowedModels`, global
/// scope).
pub(crate) fn load(cwd: &Path, agent_dir: &Path) -> DaemonAllowlist {
    let settings = pa_core::settings::SettingsManager::create(cwd, agent_dir);
    if let Some(error) = settings
        .errors()
        .iter()
        .find(|error| error.scope == pa_core::settings::SettingsScope::Global)
    {
        return DaemonAllowlist::Unreadable(error.message.clone());
    }
    match settings.get_allowed_models() {
        Some(patterns) => DaemonAllowlist::Allowed(patterns),
        None => DaemonAllowlist::Unrestricted,
    }
}

/// Enforce the allowlist on a resolved selector: `Ok(())` when allowed
/// (and when no allowlist is configured), the loud typed refusal for an
/// off-allowlist model, and a fail-closed error when the configured
/// policy could not be read.
pub(crate) fn assert_allowed(allowlist: Option<&DaemonAllowlist>, selector: &str) -> Result<()> {
    match allowlist {
        None | Some(DaemonAllowlist::Unrestricted) => Ok(()),
        Some(DaemonAllowlist::Allowed(patterns)) => {
            if pa_core::models::model_allowed(selector, patterns) {
                Ok(())
            } else {
                Err(ModelAllowlistRefusal {
                    selector: selector.to_string(),
                }
                .into())
            }
        }
        Some(DaemonAllowlist::Unreadable(error)) => Err(anyhow::anyhow!(
            "The daemon model allowlist could not be read (settings load failed: {error}); \
             refusing to resolve model \"{selector}\" — the daemon fails closed instead of \
             bypassing the configured allowedModels policy. Fix settings.json and retry."
        )),
    }
}

/// The worker's refusal telemetry: one lazily-built client shared by the
/// worker's enforcement seams, kept for the worker lifetime (the sinks
/// batch asynchronously, so a dropped client loses the event). `None`
/// telemetry when the create command opted the session out — the same
/// gate the worker's session telemetry honors.
pub struct ModelRefusalTelemetry {
    agent_dir: std::path::PathBuf,
    enabled: bool,
    client: std::sync::Mutex<Option<(std::path::PathBuf, TelemetryClient)>>,
    /// Already-noted `(surface, selector)` pairs: one event per distinct
    /// refusal per worker, so a polling getter that re-resolves a refused
    /// model (the connection-state surface) never spams the event.
    noted: std::sync::Mutex<std::collections::HashSet<(String, String)>>,
}

impl ModelRefusalTelemetry {
    pub fn new(agent_dir: std::path::PathBuf, telemetry_disabled: bool) -> Self {
        Self {
            agent_dir,
            enabled: !telemetry_disabled,
            client: std::sync::Mutex::new(None),
            noted: std::sync::Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Emit the refusal's `model refused` event (best-effort; no-op when
    /// opted out). The client binds to `cwd` — the settings posture is
    /// scoped (the PostHog endpoint and local mirror read the project
    /// scope), so a session that moved directories rebinds instead of
    /// reporting through the old project.
    pub fn note_refused(&self, surface: &str, selector: &str, cwd: &Path) {
        if !self.enabled {
            return;
        }
        let settings = pa_core::settings::SettingsManager::create(cwd, &self.agent_dir);
        // The same gating as the supervisor's `daemon event`: the env
        // override wins, else the merged settings' telemetry switch.
        let enabled = match pa_telemetry::env_telemetry_override() {
            Some(enabled) => enabled,
            None => settings.get_telemetry_enabled(),
        };
        if !enabled {
            return;
        }
        // Once per distinct (surface, selector): repeated resolutions of the
        // same refused model stay silent (the user-facing errors still fire
        // every time; the adoption signal needs one data point).
        {
            let mut noted = self.noted.lock().expect("refusal noted lock");
            if !noted.insert((surface.to_string(), selector.to_string())) {
                return;
            }
        }
        let mut slot = self.client.lock().expect("refusal telemetry lock");
        if !slot.as_ref().is_some_and(|(bound_cwd, _)| bound_cwd == cwd) {
            let client =
                pa_core::session_engine::telemetry::build_client(&settings, &self.agent_dir);
            *slot = Some((cwd.to_path_buf(), client));
        }
        let client = &slot.as_ref().expect("client bound").1;
        let (provider, model_id) = selector.split_once('/').unwrap_or((selector, ""));
        pa_core::session_engine::telemetry::track_model_refused(
            client, surface, provider, model_id,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_settings(dir: &Path, value: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("settings.json"), value).unwrap();
    }

    #[test]
    fn load_reads_the_global_scope_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        // No settings: unrestricted.
        assert!(matches!(
            load(dir.path(), &agent_dir),
            DaemonAllowlist::Unrestricted
        ));
        // The global scope carries the allowlist.
        write_settings(&agent_dir, r#"{"allowedModels": ["prime-inference/*"]}"#);
        assert_eq!(
            load(dir.path(), &agent_dir),
            DaemonAllowlist::Allowed(vec!["prime-inference/*".to_string()])
        );
        // A project scope cannot weaken the global pin: the project dir is
        // the temp dir itself.
        write_settings(
            &dir.path().join(".prime").join("agent"),
            r#"{"allowedModels": []}"#,
        );
        assert_eq!(
            load(dir.path(), &agent_dir),
            DaemonAllowlist::Allowed(vec!["prime-inference/*".to_string()])
        );
    }

    #[test]
    fn load_trims_and_drops_empty_lists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        write_settings(
            &agent_dir,
            r#"{"allowedModels": ["  prime-inference/internal/*  ", ""]}"#,
        );
        assert_eq!(
            load(dir.path(), &agent_dir),
            DaemonAllowlist::Allowed(vec!["prime-inference/internal/*".to_string()])
        );
        // A list that trims to empty behaves as unset.
        write_settings(&agent_dir, r#"{"allowedModels": [" ", ""]}"#);
        assert!(matches!(
            load(dir.path(), &agent_dir),
            DaemonAllowlist::Unrestricted
        ));
    }

    #[test]
    fn assert_allowed_passes_without_an_allowlist_and_types_the_refusal() {
        // No allowlist: everything passes (TS parity).
        assert_allowed(None, "anything/model").unwrap();
        assert_allowed(Some(&DaemonAllowlist::Unrestricted), "anything/model").unwrap();
        // Allowed by the allowlist.
        let allow = DaemonAllowlist::Allowed(vec!["prime-inference/*".to_string()]);
        assert_allowed(Some(&allow), "prime-inference/internal/glm-5.3-fast").unwrap();
        // Refused: the typed error downcasts for the telemetry seam.
        let error = assert_allowed(Some(&allow), "zai/glm-5.3").expect_err("refused");
        let refusal = error
            .downcast_ref::<ModelAllowlistRefusal>()
            .expect("typed refusal");
        assert_eq!(refusal.selector, "zai/glm-5.3");
    }

    /// A settings document that cannot be loaded fails CLOSED: the
    /// configured policy is unknown, so the gate refuses every resolution
    /// with a loud error instead of bypassing the allowlist.
    #[test]
    fn an_unreadable_settings_document_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(agent_dir.join("settings.json"), "{ not json").unwrap();
        let state = load(dir.path(), &agent_dir);
        assert!(
            matches!(state, DaemonAllowlist::Unreadable(ref message) if message.contains("expected"))
        );
        // The gate refuses a would-be-allowed model while unreadable...
        let error =
            assert_allowed(Some(&state), "prime-inference/mock-1").expect_err("fail closed");
        let message = error.to_string();
        assert!(message.contains("could not be read"), "{message}");
        assert!(message.contains("fails closed"), "{message}");
        assert!(
            error.downcast_ref::<ModelAllowlistRefusal>().is_none(),
            "fail-closed is not a pattern refusal"
        );
        // ...and passes nothing as Unrestricted when the document is gone.
        std::fs::remove_file(agent_dir.join("settings.json")).unwrap();
        let state = load(dir.path(), &agent_dir);
        assert!(matches!(state, DaemonAllowlist::Unrestricted));
    }

    #[tokio::test]
    async fn refusal_telemetry_honors_both_opt_outs() {
        let dir = tempfile::tempdir().expect("tempdir");
        // The create-command opt-out: no client ever.
        let disabled = ModelRefusalTelemetry::new(dir.path().to_path_buf(), true);
        disabled.note_refused("set_model", "zai/glm-5.3", dir.path());
        assert!(
            disabled.client.lock().unwrap().is_none(),
            "no client when the create command opted out"
        );
        // The settings opt-out (`telemetry.enabled: false`): no client.
        let agent_dir = dir.path().join("agent");
        let settings_gated = ModelRefusalTelemetry::new(agent_dir.clone(), false);
        write_settings(&agent_dir, r#"{"telemetry": {"enabled": false}}"#);
        settings_gated.note_refused("set_model", "zai/glm-5.3", dir.path());
        assert!(
            settings_gated.client.lock().unwrap().is_none(),
            "no client when settings disable telemetry"
        );
        // No settings: the client builds on the first note.
        let enabled = ModelRefusalTelemetry::new(dir.path().to_path_buf(), false);
        enabled.note_refused("set_model", "zai/glm-5.3", dir.path());
        assert!(
            enabled.client.lock().unwrap().as_ref().is_some(),
            "client built on first note"
        );
    }

    /// One `model refused` per distinct (surface, selector): a polling
    /// getter re-resolving the same refused model stays silent after the
    /// first event.
    #[tokio::test]
    async fn refusal_telemetry_dedupes_repeated_resolves() {
        let dir = tempfile::tempdir().expect("tempdir");
        let telemetry = ModelRefusalTelemetry::new(dir.path().to_path_buf(), false);
        telemetry.note_refused("session_start", "zai/glm-5.3", dir.path());
        assert_eq!(
            telemetry.noted.lock().unwrap().len(),
            1,
            "first refusal noted"
        );
        // The same pair again: no new note, and no client churn.
        telemetry.note_refused("session_start", "zai/glm-5.3", dir.path());
        assert_eq!(telemetry.noted.lock().unwrap().len(), 1);
        // A different selector (or surface) is a new data point.
        telemetry.note_refused("session_start", "zai/glm-5.3-flash", dir.path());
        telemetry.note_refused("spawn", "zai/glm-5.3", dir.path());
        assert_eq!(telemetry.noted.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn refusal_telemetry_rebinds_when_the_cwd_moves() {
        let dir = tempfile::tempdir().expect("tempdir");
        let telemetry = ModelRefusalTelemetry::new(dir.path().join("agent"), false);
        let first = dir.path().join("project-a");
        std::fs::create_dir_all(&first).unwrap();
        telemetry.note_refused("set_model", "zai/glm-5.3", &first);
        assert_eq!(
            telemetry.client.lock().unwrap().as_ref().unwrap().0,
            first,
            "client bound to the live cwd"
        );
        // A moved session rebinds to the new project scope.
        let second = dir.path().join("project-b");
        std::fs::create_dir_all(&second).unwrap();
        telemetry.note_refused("spawn", "zai/glm-5.3", &second);
        assert_eq!(
            telemetry.client.lock().unwrap().as_ref().unwrap().0,
            second,
            "client rebound after the cwd move"
        );
    }
}
