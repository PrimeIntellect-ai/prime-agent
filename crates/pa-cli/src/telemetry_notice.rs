//! The first-run telemetry disclosure (TS `agent-session-services`): once
//! per installation the fixed text prints to stderr before a mode's output
//! starts. Interactive launches defer it behind onboarding (a first
//! interactive run belongs to the onboarding screen, so the notice surfaces
//! on the next launch); every other mode discloses immediately (TS
//! `deferTelemetryNoticeForOnboarding: executionMode === "interactive"`).
//! Divergence from TS: the TS product renders the notice as a session
//! diagnostic; the Rust build prints it to the process's stderr, which
//! keeps the same text visible without a daemon-side diagnostics
//! round-trip.

use crate::mode::RuntimeConfig;

/// Print the once-per-installation telemetry notice when it is due:
/// telemetry enabled (env override, then settings — the `RunOptions`
/// resolution), not yet shown, and either not deferred or onboarding
/// already marked itself shown.
pub(crate) fn print_if_due(config: &RuntimeConfig, defer_for_onboarding: bool) {
    if config.telemetry_disabled {
        return;
    }
    let mut settings = pa_core::settings::SettingsManager::create(&config.cwd, &config.agent_dir);
    if defer_for_onboarding && !settings.get_onboarding_shown() {
        return;
    }
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
        print_if_due(&config, false);
        assert!(notice_shown(dir.path()), "the first headless run discloses");
        print_if_due(&config, false);
        // The once-per-installation gate is the settings flag, so the
        // second call is a no-op by construction.
    }

    #[test]
    fn deferred_disclosure_waits_for_onboarding() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let config = config_for(dir.path(), false);
        print_if_due(&config, true);
        assert!(
            !notice_shown(dir.path()),
            "an interactive run without onboarding does not disclose yet"
        );
        let mut settings =
            pa_core::settings::SettingsManager::create(dir.path(), dir.path().join("agent"));
        settings
            .set_onboarding_shown(true)
            .expect("onboarding shown");
        print_if_due(&config, true);
        assert!(
            notice_shown(dir.path()),
            "the launch after onboarding discloses"
        );
    }

    #[test]
    fn disabled_never_discloses() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        print_if_due(&config_for(dir.path(), true), false);
        assert!(
            !notice_shown(dir.path()),
            "an opted-out run sends no notice"
        );
    }
}
