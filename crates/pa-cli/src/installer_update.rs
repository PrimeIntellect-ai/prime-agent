//! The `prime-agent update` body: the TS->Rust migration path. One step —
//! the update fetches the installer from the OFFICIAL DOMAIN endpoint
//! (`https://app.primeintellect.ai/prime-agent/install.sh`, never a
//! GitHub raw or workflow URL) and runs it; the script uninstalls the
//! TypeScript version, installs the latest Rust build of the update
//! channel, and never touches `~/.prime/agent` (the sessions and
//! configuration). The TUI's `/update` runs the same core out-of-band
//! (`client_update.rs`), so the two surfaces cannot diverge.

use pa_core::update::installer::{self, InstallerOutput};
use pa_core::update::version::UpdateChannel;

/// One parsed `prime-agent update` invocation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateOptions {
    /// `--check`: print the latest release of the update channel vs the
    /// running binary's version, without installing.
    pub check: bool,
    /// `--nightly` / `--stable`: switch the update channel (persisted once
    /// the update completes).
    pub channel: Option<UpdateChannel>,
}

/// The saved `updateChannel` setting (`/nightly on|off`, `--nightly`,
/// `--stable`).
fn saved_channel() -> Option<UpdateChannel> {
    let cwd = std::env::current_dir().ok()?;
    let saved = pa_core::settings::SettingsManager::create(&cwd, crate::config::get_agent_dir())
        .get_update_channel()?;
    Some(match saved {
        pa_core::settings::UpdateChannel::Stable => UpdateChannel::Stable,
        pa_core::settings::UpdateChannel::Nightly => UpdateChannel::Nightly,
    })
}

/// The installer's channel name for an update channel.
fn installer_channel(channel: UpdateChannel) -> &'static str {
    match channel {
        UpdateChannel::Stable => "stable",
        UpdateChannel::Nightly => "beta",
    }
}

/// The channel the installer runs with: an explicit flag, else the saved
/// setting. `None` keeps the channel the install marker records.
#[must_use]
pub fn requested_installer_channel(flag: Option<UpdateChannel>) -> Option<&'static str> {
    flag.or_else(saved_channel).map(installer_channel)
}

/// Run the update command: the funnel (the installer script owns the
/// whole move) or the `--check` report. Returns the process exit code.
pub fn run(options: &UpdateOptions) -> i32 {
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        eprintln!("Error: could not start the update runtime.");
        return 1;
    };
    if options.check {
        return runtime.block_on(run_check());
    }
    // The RESOLVED URL, not the const: a PRIME_AGENT_RUST_INSTALLER_URL
    // pin (a test or a pinned install) changes where the funnel actually
    // fetches from, and the banner must not claim a source the run will
    // not use.
    println!(
        "Updating to the latest Rust build — fetching the installer from {}:",
        installer::installer_script_url()
    );
    let channel = requested_installer_channel(options.channel);
    match runtime.block_on(installer::run_installer(channel, InstallerOutput::Inherit)) {
        Ok(installed) => {
            match installed.version {
                Some(version) => {
                    println!("updated to {version} — restart prime-agent to run the new build");
                }
                None => {
                    println!(
                        "updated to the latest build — restart prime-agent to run the new build"
                    );
                }
            }
            if let Some(channel) = options.channel {
                save_channel(channel);
            }
            0
        }
        Err(failure) => {
            eprintln!("Error: {}", failure.message);
            1
        }
    }
}

/// Persist an explicit channel switch (`--nightly` / `--stable`) after a
/// completed update.
fn save_channel(channel: UpdateChannel) {
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    let setting = match channel {
        UpdateChannel::Stable => pa_core::settings::UpdateChannel::Stable,
        UpdateChannel::Nightly => pa_core::settings::UpdateChannel::Nightly,
    };
    let mut settings =
        pa_core::settings::SettingsManager::create(&cwd, crate::config::get_agent_dir());
    if settings.set_update_channel(setting).is_ok() {
        println!("Updates now follow the {} channel.", channel.wire_name());
    }
}

/// The `--check` report: the running version vs the update channel's
/// published release (`latest.json` / `beta.json`). Nothing downloads.
async fn run_check() -> i32 {
    let running = crate::config::version();
    let channel = match requested_installer_channel(None)
        .or_else(|| installer::installed_channel(&installer::install_prefix()))
    {
        Some("stable") => UpdateChannel::Stable,
        Some(_) => UpdateChannel::Nightly,
        None => pa_core::update::version::resolve_update_channel(running, None),
    };
    let base = installer::download_base_url();
    println!("Running:  {running}");
    println!("Channel:  {}", channel.wire_name());
    let latest = pa_core::update::release::latest_release(
        running,
        Some(channel),
        &base,
        std::time::Duration::from_secs(10),
    )
    .await;
    let Ok(Some(latest)) = latest else {
        eprintln!(
            "Error: could not read the {} release manifest at {base}/{}",
            channel.wire_name(),
            channel.manifest_path()
        );
        return 1;
    };
    println!(
        "Latest:   {} ({base}/{})",
        latest.version,
        channel.manifest_path()
    );
    println!(
        "{}",
        check_verdict(!pa_core::update::version::is_newer_package_version(
            &latest.version,
            running
        ))
    );
    0
}

/// The `--check` verdict line.
fn check_verdict(up_to_date: bool) -> &'static str {
    if up_to_date {
        "Up to date."
    } else {
        "An update is available — run `prime-agent update` to install it."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_check_verdict_names_the_install_command() {
        assert_eq!(check_verdict(true), "Up to date.");
        assert_eq!(
            check_verdict(false),
            "An update is available — run `prime-agent update` to install it."
        );
    }

    #[test]
    fn the_nightly_channel_runs_the_installer_on_beta() {
        assert_eq!(installer_channel(UpdateChannel::Nightly), "beta");
        assert_eq!(installer_channel(UpdateChannel::Stable), "stable");
    }
}
