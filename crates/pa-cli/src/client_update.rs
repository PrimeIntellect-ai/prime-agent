//! The composition root's `/update` runner: the installer funnel with the
//! output captured — the TUI stays mounted while the install runs, so the
//! installer's own progress never writes to the live frame, and the
//! failure tail becomes the error row's message. It follows the same
//! update channel as `prime-agent update`. Both surfaces consult the
//! same pa-core Homebrew detector before entering the installer funnel.

use pa_core::update::homebrew;
use pa_core::update::installer::{self, InstallerOutput};

#[derive(Clone, Default)]
pub struct ClientUpdate;

impl pa_tui::update_command::UpdateCommands for ClientUpdate {
    fn run_update(&self) -> pa_tui::update_command::UpdateRunFuture {
        Box::pin(async {
            if let Some(kind) = std::env::current_exe()
                .ok()
                .as_deref()
                .and_then(homebrew::managed_kind)
            {
                if let Ok(cwd) = std::env::current_dir() {
                    let agent_dir = crate::config::get_agent_dir();
                    let settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
                    if !crate::mode::telemetry_disabled(&settings) {
                        let client =
                            pa_core::session_engine::telemetry::build_client(&settings, &agent_dir);
                        pa_telemetry::UpdateHomebrewRefusal {
                            kind: kind.as_str(),
                        }
                        .track(&client);
                        // The TUI already owns a runtime; draining in the
                        // background cannot delay the refusal row.
                        tokio::spawn(async move {
                            let _ = client.shutdown().await;
                        });
                    }
                }
                return Err(homebrew::upgrade_instruction(kind));
            }
            match installer::run_installer(
                Some(crate::installer_update::requested_installer_channel(None)),
                InstallerOutput::Capture,
            )
            .await
            {
                Ok(installed) => Ok(installed
                    .version
                    .unwrap_or_else(|| "the latest build".to_string())),
                Err(failure) => Err(failure.message),
            }
        })
    }
}
