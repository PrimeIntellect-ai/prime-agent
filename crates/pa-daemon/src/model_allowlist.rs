//! The daemon's enforcement of the settings `allowedModels` allowlist: the
//! worker-side model-resolution seams (`set_model`, the RLM child-model
//! resolution, and the worker's startup model chain) refuse a model
//! outside the allowlist loudly (a [`ModelAllowlistRefusal`] error
//! surfaces to the caller; the daemon never falls back to a different
//! model) and emit the adoption event (`model refused`, schema v1).

use std::path::Path;
use std::sync::OnceLock;

use anyhow::Result;

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
    cwd: std::path::PathBuf,
    agent_dir: std::path::PathBuf,
    enabled: bool,
    client: OnceLock<TelemetryClient>,
}

impl ModelRefusalTelemetry {
    pub fn new(
        cwd: std::path::PathBuf,
        agent_dir: std::path::PathBuf,
        telemetry_disabled: bool,
    ) -> Self {
        Self {
            cwd,
            agent_dir,
            enabled: !telemetry_disabled,
            client: OnceLock::new(),
        }
    }

    /// Emit the refusal's `model refused` event (best-effort; no-op when
    /// opted out).
    pub fn note_refused(&self, surface: &str, selector: &str) {
        if !self.enabled {
            return;
        }
        let client = self.client.get_or_init(|| {
            let settings = pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir);
            pa_core::session_engine::telemetry::build_client(&settings, &self.agent_dir)
        });
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

    #[test]
    fn refusal_telemetry_honors_the_opt_out() {
        let dir = tempfile::tempdir().expect("tempdir");
        let disabled =
            ModelRefusalTelemetry::new(dir.path().to_path_buf(), dir.path().to_path_buf(), true);
        disabled.note_refused("set_model", "zai/glm-5.3");
        assert!(disabled.client.get().is_none(), "no client when opted out");
        let enabled =
            ModelRefusalTelemetry::new(dir.path().to_path_buf(), dir.path().to_path_buf(), false);
        enabled.note_refused("set_model", "zai/glm-5.3");
        assert!(enabled.client.get().is_some(), "client built on first note");
    }
}
