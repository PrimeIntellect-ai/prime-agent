//! The `prime-agent update` body: the TS->Rust migration path. One step —
//! the update fetches the update channel's installer (stable: the official
//! domain's `https://app.primeintellect.ai/prime-agent/install.sh`;
//! nightly: the download base's `install-beta.sh`; never a GitHub raw or
//! workflow URL) and runs it; the script uninstalls the
//! TypeScript version, installs the latest Rust build of the update
//! channel, and never touches `~/.prime/agent` (the sessions and
//! configuration). The TUI's `/update` runs the same core out-of-band
//! (`client_update.rs`), so the two surfaces cannot diverge.

use pa_core::update::install::current_platform_alias;
use pa_core::update::installer::{self, InstallerOutput};
use pa_core::update::release::{artifact_for_platform, LatestRelease};
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

/// The update channel: the flag, else the saved `updateChannel` setting,
/// else the install marker's channel, else the one the running version
/// implies (a `-beta*` build is a nightly install).
fn resolve_channel(
    flag: Option<UpdateChannel>,
    saved: Option<UpdateChannel>,
    marker: Option<&str>,
    running: &str,
) -> UpdateChannel {
    flag.or(saved)
        .or(marker.map(|marker| match marker {
            "stable" => UpdateChannel::Stable,
            _ => UpdateChannel::Nightly,
        }))
        .unwrap_or_else(|| pa_core::update::version::resolve_update_channel(running, None))
}

/// The channel `update`, `update --check`, and `/update` follow.
fn update_channel(flag: Option<UpdateChannel>) -> UpdateChannel {
    resolve_channel(
        flag,
        saved_channel(),
        installer::installed_channel(&installer::install_prefix()),
        crate::config::version(),
    )
}

/// The installer's channel name for [`update_channel`].
#[must_use]
pub fn requested_installer_channel(flag: Option<UpdateChannel>) -> &'static str {
    installer_channel(update_channel(flag))
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
        return runtime.block_on(run_check(options.channel));
    }
    // The RESOLVED URL, not the const: a PRIME_AGENT_RUST_INSTALLER_URL
    // pin (a test or a pinned install) changes where the funnel actually
    // fetches from, and the banner must not claim a source the run will
    // not use.
    let channel = requested_installer_channel(options.channel);
    println!(
        "Updating to the latest Rust build — fetching the installer from {}:",
        installer::installer_script_url(Some(channel))
    );
    match runtime.block_on(installer::run_installer(
        Some(channel),
        InstallerOutput::Inherit,
    )) {
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

/// The local operation on an installer install: `--rollback` restores the
/// previous version the last install kept, `--archive` installs a local
/// release archive. Both run the installer script bundled into this build
/// against the prefix the running binary was installed under. Returns the
/// process exit code.
pub fn run_local(prefix: &std::path::Path, archive: Option<&std::path::Path>) -> i32 {
    let archive = match archive.map(std::path::absolute).transpose() {
        Ok(archive) => archive,
        Err(error) => {
            eprintln!("Error: could not resolve the archive path: {error}");
            return 1;
        }
    };
    let args: Vec<&std::ffi::OsStr> = match &archive {
        Some(path) => vec!["--archive".as_ref(), path.as_os_str()],
        None => vec!["--rollback".as_ref()],
    };
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        eprintln!("Error: could not start the update runtime.");
        return 1;
    };
    #[cfg(windows)]
    let handed_off = installer::caller_owns_payload(prefix);
    match runtime.block_on(installer::run_bundled_installer(prefix, &args)) {
        Ok(installed) => {
            #[cfg(windows)]
            if handed_off {
                // The handed-off child prints its own outcome to the
                // inherited terminal after this process exits; this
                // process never saw the landed version, so the "rolled
                // back to" line would lie. The announcement rides here —
                // the child is spawned by now, so a refused pre-flight
                // (which returns Err below) never announced a background
                // run that does not exist.
                println!(
                    "the {} continues in the background after this command exits — Windows only releases the payload once this process does",
                    if archive.is_some() { "archive install" } else { "rollback" }
                );
                return 0;
            }
            let done = if archive.is_some() {
                "installed"
            } else {
                "rolled back to"
            };
            let version = installed.version.as_deref().unwrap_or("the previous build");
            println!("{done} {version} — restart prime-agent to run it");
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
async fn run_check(flag: Option<UpdateChannel>) -> i32 {
    let target = match installer::current_target() {
        Ok(target) => target,
        Err(error) => {
            eprintln!("Error: {error:#}");
            return 1;
        }
    };
    let running = crate::config::version();
    let channel = update_channel(flag);
    let base = installer::download_base_url();
    println!("Platform: {target}");
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
    println!("{}", check_verdict(&latest, running, channel, flag));
    0
}

/// The `--check` verdict line: the channel's update policy decides (a
/// channel switch accepts a same-base prerelease), an update needs a
/// build for this platform, and the suggested command repeats the channel
/// flag the check was given.
fn check_verdict(
    latest: &LatestRelease,
    running: &str,
    channel: UpdateChannel,
    flag: Option<UpdateChannel>,
) -> String {
    if !pa_core::update::version::is_release_update_candidate(
        &latest.version,
        running,
        Some(channel),
    ) {
        return "Up to date.".to_string();
    }
    if artifact_for_platform(latest).is_err() {
        return format!(
            "{} is the latest {} release, but no build of it is published for {}.",
            latest.version,
            channel.wire_name(),
            current_platform_alias()
        );
    }
    let command = match flag {
        Some(UpdateChannel::Nightly) => "prime-agent update --nightly",
        Some(UpdateChannel::Stable) => "prime-agent update --stable",
        None => "prime-agent update",
    };
    format!("An update is available — run `{command}` to install it.")
}

#[cfg(test)]
mod tests {
    use super::*;

    use pa_core::update::release::ReleaseArtifact;

    /// A release with a build for this platform.
    fn release(version: &str) -> LatestRelease {
        let platform = current_platform_alias();
        LatestRelease {
            version: version.to_string(),
            artifacts: vec![ReleaseArtifact {
                platform: platform.to_string(),
                file: format!("prime-agent-{version}-{platform}.tar.gz"),
                sha256: "0".repeat(64),
            }],
        }
    }

    #[test]
    fn the_check_verdict_follows_the_channel_policy() {
        assert_eq!(
            check_verdict(&release("1.2.3"), "1.2.3", UpdateChannel::Stable, None),
            "Up to date."
        );
        assert_eq!(
            check_verdict(&release("1.2.4"), "1.2.3", UpdateChannel::Stable, None),
            "An update is available — run `prime-agent update` to install it."
        );
        // A switch onto nightly accepts the same-base prerelease the
        // installer would install.
        assert_eq!(
            check_verdict(
                &release("1.2.3-beta.5"),
                "1.2.3",
                UpdateChannel::Nightly,
                Some(UpdateChannel::Nightly)
            ),
            "An update is available — run `prime-agent update --nightly` to install it."
        );
        assert_eq!(
            check_verdict(
                &release("1.2.2-beta.5"),
                "1.2.3",
                UpdateChannel::Nightly,
                None
            ),
            "Up to date."
        );
    }

    #[test]
    fn the_check_verdict_needs_a_build_for_this_platform() {
        let unbuilt = LatestRelease {
            version: "1.2.4".to_string(),
            artifacts: Vec::new(),
        };
        assert_eq!(
            check_verdict(&unbuilt, "1.2.3", UpdateChannel::Stable, None),
            format!(
                "1.2.4 is the latest stable release, but no build of it is published for {}.",
                current_platform_alias()
            )
        );
    }

    #[test]
    fn the_channel_resolves_flag_then_saved_then_marker_then_version() {
        use UpdateChannel::{Nightly, Stable};
        assert_eq!(
            resolve_channel(Some(Stable), Some(Nightly), Some("beta"), "1.2.3-beta.1"),
            Stable
        );
        assert_eq!(
            resolve_channel(None, Some(Nightly), Some("stable"), "1.2.3"),
            Nightly
        );
        assert_eq!(
            resolve_channel(None, None, Some("stable"), "1.2.3-beta.1"),
            Stable
        );
        assert_eq!(resolve_channel(None, None, Some("beta"), "1.2.3"), Nightly);
        assert_eq!(resolve_channel(None, None, None, "1.2.3-beta.1"), Nightly);
        assert_eq!(resolve_channel(None, None, None, "1.2.3"), Stable);
    }

    #[test]
    fn the_nightly_channel_runs_the_installer_on_beta() {
        assert_eq!(installer_channel(UpdateChannel::Nightly), "beta");
        assert_eq!(installer_channel(UpdateChannel::Stable), "stable");
    }
}
