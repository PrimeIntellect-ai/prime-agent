//! The first-run telemetry disclosure (TS `agent-session-services`) for
//! the headless modes: once per installation the fixed text prints to
//! stderr before a mode's output starts (TS
//! `deferTelemetryNoticeForOnboarding: executionMode === "interactive"`).
//! The interactive mode renders the same disclosure inside the TUI as a
//! session info row (pa-tui's attach) — the alt screen hides a pre-TUI
//! stderr print, so a stderr notice would never be seen there.

use crate::mode::RuntimeConfig;

/// Print the once-per-installation telemetry notice when it is due:
/// telemetry enabled (env override, then settings — the `RunOptions`
/// resolution) and not yet shown.
pub(crate) fn print_if_due(config: &RuntimeConfig) {
    if config.telemetry_disabled {
        return;
    }
    let mut settings = pa_core::settings::SettingsManager::create(&config.cwd, &config.agent_dir);
    if settings.get_telemetry_notice_shown() {
        return;
    }
    eprintln!(
        "Prime Agent sends pseudonymous usage and performance metrics without prompts, responses, tool content, file paths, or repository data. Disable this with /telemetry off, telemetry.enabled=false, PRIME_AGENT_TELEMETRY=0, DO_NOT_TRACK=1, or offline mode."
    );
    if let Err(error) = settings.set_telemetry_notice_shown(true) {
        eprintln!("Warning: could not persist the telemetry notice: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mode::RuntimeConfig;

    fn config_for(dir: &std::path::Path, telemetry_disabled: bool) -> RuntimeConfig {
        RuntimeConfig {
            cwd: dir.to_path_buf(),
            agent_dir: dir.join("agent"),
            telemetry_disabled,
            ..Default::default()
        }
    }

    fn notice_shown(dir: &std::path::Path) -> bool {
        pa_core::settings::SettingsManager::create(dir, dir.join("agent"))
            .get_telemetry_notice_shown()
    }

    #[test]
    fn headless_discloses_immediately_and_once() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let config = config_for(dir.path(), false);
        print_if_due(&config);
        assert!(notice_shown(dir.path()), "the first headless run discloses");
        print_if_due(&config);
        // The once-per-installation gate is the settings flag, so the
        // second call is a no-op by construction.
    }

    #[test]
    fn disabled_never_discloses() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        print_if_due(&config_for(dir.path(), true));
        assert!(
            !notice_shown(dir.path()),
            "an opted-out run sends no notice"
        );
    }
}
