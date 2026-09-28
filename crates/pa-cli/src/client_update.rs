//! The composition root's `/update` runner: the installer funnel with the
//! output captured — the TUI stays mounted while the install runs, so the
//! installer's own progress never writes to the live frame, and the
//! failure tail becomes the error row's message. The same body
//! `prime-agent update` runs (pa-core's installer module), so the TUI and
//! the CLI cannot diverge.

use pa_core::update::installer::{self, InstallerOutput};

/// The `/update` funnel handle (the interactive options carry it).
#[derive(Clone, Default)]
pub struct ClientUpdate;

impl pa_tui::update_command::UpdateCommands for ClientUpdate {
    fn run_update(&self) -> pa_tui::update_command::UpdateRunFuture {
        Box::pin(async {
            match installer::run_installer(InstallerOutput::Capture).await {
                Ok(installed) => Ok(installed
                    .version
                    .unwrap_or_else(|| "the latest build".to_string())),
                Err(failure) => Err(failure.message),
            }
        })
    }
}
