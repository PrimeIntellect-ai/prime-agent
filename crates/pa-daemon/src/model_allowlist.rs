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

/// The daemon allowlist (settings `allowedModels`, global scope): `None`
/// is unrestricted (TS parity).
pub(crate) fn load(cwd: &Path, agent_dir: &Path) -> Option<Vec<String>> {
    pa_core::settings::SettingsManager::create(cwd, agent_dir).get_allowed_models()
}

/// Enforce the allowlist on a resolved selector: `Ok(())` when allowed
/// (and when no allowlist is configured), the loud typed refusal
/// otherwise.
pub(crate) fn assert_allowed(allowlist: Option<&[String]>, selector: &str) -> Result<()> {
    let Some(allowlist) = allowlist else {
        return Ok(());
    };
    if pa_core::models::model_allowed(selector, allowlist) {
        return Ok(());
    }
    Err(ModelAllowlistRefusal {
        selector: selector.to_string(),
    }
    .into())
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
        assert_eq!(load(dir.path(), &agent_dir), None);
        // The global scope carries the allowlist.
        write_settings(&agent_dir, r#"{"allowedModels": ["prime-inference/*"]}"#);
        assert_eq!(
            load(dir.path(), &agent_dir),
            Some(vec!["prime-inference/*".to_string()])
        );
        // A project scope cannot weaken the global pin: the project dir is
        // the temp dir itself.
        write_settings(
            &dir.path().join(".prime").join("agent"),
            r#"{"allowedModels": []}"#,
        );
        assert_eq!(
            load(dir.path(), &agent_dir),
            Some(vec!["prime-inference/*".to_string()])
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
            Some(vec!["prime-inference/internal/*".to_string()])
        );
        // A list that trims to empty behaves as unset.
        write_settings(&agent_dir, r#"{"allowedModels": [" ", ""]}"#);
        assert_eq!(load(dir.path(), &agent_dir), None);
    }

    #[test]
    fn assert_allowed_passes_without_an_allowlist_and_types_the_refusal() {
        // No allowlist: everything passes (TS parity).
        assert_allowed(None, "anything/model").unwrap();
        // Allowed by the allowlist.
        assert_allowed(
            Some(&["prime-inference/*".to_string()]),
            "prime-inference/internal/glm-5.3-fast",
        )
        .unwrap();
        // Refused: the typed error downcasts for the telemetry seam.
        let error = assert_allowed(Some(&["prime-inference/*".to_string()]), "zai/glm-5.3")
            .expect_err("refused");
        let refusal = error
            .downcast_ref::<ModelAllowlistRefusal>()
            .expect("typed refusal");
        assert_eq!(refusal.selector, "zai/glm-5.3");
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
