//! The self-update command core (TS `handlePackageCommand`'s self-update
//! half): the nightly-switch confirmation, the persisted-channel default,
//! the native staged-activation update, and the completed-run channel
//! persist. `prime-agent update` and `prime-agent package update`'s self
//! target both run this one body, so the two entry points cannot diverge.

use pa_core::update::version::UpdateChannel;

/// One parsed self-update invocation: `prime-agent update`'s options or the
/// `package update` self target's (the package path never carries the
/// direct-install payload pair).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelfUpdateOptions {
    pub force: bool,
    pub rollback: bool,
    pub channel: Option<UpdateChannel>,
    /// The manual/direct install payload (`prime-agent update --archive`).
    pub archive: Option<std::path::PathBuf>,
    /// The `http(s)://` origin recorded as the release's install source.
    pub source: Option<String>,
}

/// The settings `UpdateChannel` in the update vocabulary's wire name
/// ("stable"/"nightly") — both entries read and persist one wire format.
pub fn settings_channel_wire_name(channel: pa_core::settings::UpdateChannel) -> &'static str {
    UpdateChannel::wire_name(match channel {
        pa_core::settings::UpdateChannel::Stable => UpdateChannel::Stable,
        pa_core::settings::UpdateChannel::Nightly => UpdateChannel::Nightly,
    })
}

/// The nightly-switch confirmation (TS `handlePackageCommand`'s update
/// case): warn, then confirm the switch unless `--force`. Declining — or a
/// non-tty shell run without `--force` — changes nothing, not even
/// extensions. Returns the abort exit code (75 for the interactive update
/// child so the TUI can tell an aborted switch from a failure, else 1) when
/// the run must stop, or `None` to proceed (also when no explicit nightly
/// switch is requested).
pub fn confirm_nightly_switch(
    force: bool,
    channel: Option<UpdateChannel>,
    persisted_wire: Option<&str>,
    stdin_is_terminal: bool,
) -> Option<i32> {
    if channel != Some(UpdateChannel::Nightly) || persisted_wire == Some("nightly") {
        return None;
    }
    println!(
        "Nightly releases are unreleased Prime Agent builds. They can be broken, and a broken update can leave Prime Agent unusable until you roll back or reinstall."
    );
    let abort_code = if std::env::var(crate::public_command::SELF_UPDATE_INTERACTIVE_CHILD_ENV)
        .as_deref()
        == Ok("1")
    {
        75
    } else {
        1
    };
    if !force {
        if !stdin_is_terminal {
            eprintln!(
                "Switching to the nightly channel needs confirmation. Re-run with --force to proceed."
            );
            return Some(abort_code);
        }
        if !crate::daemon_discovery::stop::prompt_yes_no(
            "Switching to the nightly channel and continue with the update?",
        ) {
            println!("Update cancelled. Nothing was changed.");
            return Some(abort_code);
        }
    }
    None
}

/// Run the native self-update (the staged-activation update flow) with the
/// persisted-channel default and the TS `commitChannel` persist of a
/// completed run. Returns the process exit code; failures print the update
/// command's `Error: …` line and exit 1 — including the installer-ownership
/// message a binary the Prime Agent installer does not own produces verbatim
/// (the actionable, install-method-specific instruction).
pub fn run(options: &SelfUpdateOptions, persisted_wire: Option<String>) -> i32 {
    // The effective channel: an explicit flag wins, else the persisted
    // one, else the running version infers it.
    let channel = options
        .channel
        .or_else(|| persisted_wire.as_deref().and_then(UpdateChannel::from_wire));
    let command_options = crate::update_flow::update_command::UpdateCommandOptions {
        force: options.force,
        rollback: options.rollback,
        channel,
        archive: options.archive.clone(),
        source: options.source.clone(),
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Error: Could not start the update runtime: {error}.");
            return 1;
        }
    };
    match runtime.block_on(crate::update_flow::update_command::run_update_command(
        &command_options,
    )) {
        Ok(code) => {
            // TS `commitChannel`: a completed run persists an explicit
            // switch (Complete and Skipped alike — a channel pin applies
            // even when no newer release was needed) and reports it. The
            // not-attempted exit (75) reaches here only as the child-mode
            // no-change skip: a declined confirmation never runs the flow.
            let flag_wire = options.channel.map(UpdateChannel::wire_name);
            if (code == 0 || code == 75)
                && flag_wire.is_some()
                && flag_wire != persisted_wire.as_deref()
            {
                let wire = flag_wire.unwrap_or_default();
                if let Ok(cwd) = std::env::current_dir() {
                    let settings_channel = match wire {
                        "nightly" => pa_core::settings::UpdateChannel::Nightly,
                        _ => pa_core::settings::UpdateChannel::Stable,
                    };
                    let mut settings = pa_core::settings::SettingsManager::create(
                        &cwd,
                        crate::config::get_agent_dir(),
                    );
                    if settings.set_update_channel(settings_channel).is_ok() {
                        println!("Updates now follow the {wire} channel.");
                    }
                }
            }
            code
        }
        Err(error) => {
            eprintln!("Error: {error:#}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A non-tty stdin: the shell caller's confirm path.
    const NON_TTY: bool = false;

    #[test]
    fn a_nightly_switch_needs_confirmation_on_a_non_tty_run() {
        let abort =
            confirm_nightly_switch(false, Some(UpdateChannel::Nightly), Some("stable"), NON_TTY);
        assert_eq!(abort, Some(1), "an unconfirmed switch aborts with failure");
        // Already on the nightly channel: no switch, no confirmation.
        assert_eq!(
            confirm_nightly_switch(
                false,
                Some(UpdateChannel::Nightly),
                Some("nightly"),
                NON_TTY
            ),
            None
        );
        // The stable channel and no explicit channel never confirm.
        assert_eq!(
            confirm_nightly_switch(false, Some(UpdateChannel::Stable), Some("stable"), NON_TTY),
            None
        );
        assert_eq!(confirm_nightly_switch(false, None, None, NON_TTY), None);
    }

    #[test]
    fn force_confirms_the_switch_without_a_tty() {
        assert_eq!(
            confirm_nightly_switch(true, Some(UpdateChannel::Nightly), Some("stable"), NON_TTY),
            None,
            "--force is how a scripted switch skips the confirmation"
        );
    }

    #[test]
    fn the_settings_wire_name_matches_the_update_vocabulary() {
        assert_eq!(
            settings_channel_wire_name(pa_core::settings::UpdateChannel::Stable),
            "stable"
        );
        assert_eq!(
            settings_channel_wire_name(pa_core::settings::UpdateChannel::Nightly),
            "nightly"
        );
    }
}
