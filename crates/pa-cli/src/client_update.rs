//! The composition root's `/update` runner: the installer funnel with the
//! output captured — the TUI stays mounted while the install runs, so the
//! installer's own progress never writes to the live frame, and the
//! failure tail becomes the error row's message. It follows the same
//! update channel as `prime-agent update`. The same body
//! `prime-agent update` runs (pa-core's installer module), so the TUI and
//! the CLI cannot diverge.
//!
//! THE WINDOWS EXCEPTION: on Windows the TUI process can be the install's
//! payload binary itself, so the funnel hands off instead of capturing
//! (Windows holds a running payload directory un-renameable — the install
//! can only publish once this process exits). The terminal is handed back
//! whole first (the same best-effort restore every TUI exit runs), the
//! handoff line prints on the restored screen, and the process exits: the
//! note this run would send never lands (the app is gone with it).

use pa_core::update::installer::{self, InstallerOutput};

/// The `/update` funnel handle (the interactive options carry it).
#[derive(Clone, Default)]
pub struct ClientUpdate;

impl pa_tui::update_command::UpdateCommands for ClientUpdate {
    fn run_update(&self) -> pa_tui::update_command::UpdateRunFuture {
        Box::pin(async {
            match installer::run_installer(
                Some(crate::installer_update::requested_installer_channel(None)),
                InstallerOutput::Capture,
            )
            .await
            {
                Ok(installer::RunOutcome::Installed(installed)) => Ok(installed
                    .version
                    .unwrap_or_else(|| "the latest build".to_string())),
                // THE WINDOWS PAYLOAD HANDOFF (the module doc above): the
                // terminal is restored, the handoff line lands on the
                // restored screen, and the process exits — the detached
                // installer publishes once it is gone.
                Ok(installer::RunOutcome::Handoff) => {
                    pa_tui::exit_restore::restore_terminal();
                    println!("{}", installer::HANDOFF_LINE);
                    std::process::exit(0);
                }
                Err(failure) => Err(failure.message),
            }
        })
    }
}
