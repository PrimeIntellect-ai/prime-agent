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
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            if let Some(root) = pa_core::update::install::install_root_of(&executable) {
                // Reuse the CLI's managed activation/restart transaction.
                // Capturing the child keeps its progress off the live frame.
                let output = tokio::process::Command::new(executable)
                    .arg("update")
                    .env(
                        crate::public_command::SELF_UPDATE_INTERACTIVE_CHILD_ENV,
                        "1",
                    )
                    .stdin(std::process::Stdio::null())
                    .output()
                    .await
                    .map_err(|error| format!("could not start the update: {error}"))?;
                if !output.status.success() && output.status.code() != Some(75) {
                    return Err(format!(
                        "{}{}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    ));
                }
                return pa_core::update::install::read_installation(
                    &root,
                    pa_core::update::install::CURRENT_LAUNCHER,
                )
                .map(|installed| installed.version().to_string())
                .map_err(|error| error.to_string());
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
