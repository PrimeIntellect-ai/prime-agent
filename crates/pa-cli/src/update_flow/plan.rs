//! The update plan (TS `getNativeUpdatePlan` port): decide update vs
//! rollback vs skip before any FSM state runs, with the TS refusal
//! messages kept verbatim so the CLI surfaces the same text.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use pa_core::update::install::{
    current_platform_alias, read_installation, read_rollback_installation, running_release,
    RunningRelease, CURRENT_LAUNCHER,
};
use pa_core::update::release::{artifact_for_platform, latest_release};
use pa_core::update::version::{
    has_prerelease_tag, is_base_version_downgrade, is_release_update_candidate,
    resolve_update_channel, UpdateChannel,
};

/// The manifest fetch timeout (TS `DEFAULT_VERSION_CHECK_TIMEOUT_MS`).
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(10);

/// One update decision.
pub enum UpdatePlan {
    /// Download and stage the candidate; the coordinator (the new binary)
    /// runs the rest of the FSM.
    Update {
        version: String,
        archive_url: String,
        archive_sha256: String,
        /// The base URL the manifest came from (staged as `.install-source`).
        base_url: String,
    },
    /// The manual/direct install (`--archive`): the payload is already
    /// staged (scratch + fsync + atomic rename) with the version probed
    /// from the binary; nothing is downloaded.
    Direct {
        version: String,
        candidate_dir: PathBuf,
    },
    /// Boot the previous release back (the coordinator IS the previous
    /// binary; the normal FSM swaps the launcher back).
    Rollback {
        version: String,
        coordinator_exe: PathBuf,
        candidate_dir: PathBuf,
    },
    /// Nothing to do; the status terminal is `Skipped` with the reason.
    Skipped { reason: String },
}

/// The download base URL: the env override, then the installation's source.
fn download_base_url(override_url: Option<&str>, install_source: &str) -> String {
    override_url
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .unwrap_or(install_source)
        .trim_end_matches('/')
        .to_string()
}

/// The update baseline: the release the RUNNING binary occupies. The
/// comparison the plan makes is against this release's version — never a
/// launcher that can point elsewhere — and a binary whose own release
/// directory does not parse (a hand-named `0.10.0-rust-<sha>` dogfood
/// directory) is refused as a baseline: the updater must never plan an
/// update "from" a version its binary does not report.
pub fn running_release_anchor() -> Result<RunningRelease> {
    let executable = std::env::current_exe().context("resolve the running executable")?;
    running_release(&executable)
}

/// Plan one update run (TS `getNativeUpdatePlan` parity: same refusals,
/// same messages, plus the Rust flow's staging facts; the update baseline
/// anchors on the running binary's release directory, stricter than TS's
/// launcher read, so an inconsistent installation is refused before any
/// candidate is selected).
pub async fn plan(
    install_root: &Path,
    force: bool,
    rollback: bool,
    channel: Option<UpdateChannel>,
    download_base_override: Option<&str>,
) -> Result<UpdatePlan> {
    let active = read_installation(install_root, CURRENT_LAUNCHER);
    let installation = match active {
        Ok(installation) => Some(installation),
        Err(_) => read_installation(install_root, "previous").ok(),
    };
    let Some(installation) = installation else {
        anyhow::bail!(
            "The compiled installation is damaged. Run the published installer again to repair it."
        );
    };
    let base_url = download_base_url(download_base_override, &installation.base_url);
    if rollback {
        let previous = read_rollback_installation(install_root)
            .map_err(|_| anyhow!("No valid previous compiled release is available."))?;
        if previous.executable() == installation.executable() {
            anyhow::bail!("No valid previous compiled release is available.");
        }
        // The TS rollback probes the previous executable before planning.
        super::swap::validate_candidate(previous.executable(), previous.version())
            .await
            .map_err(|_| {
                anyhow!("The previous compiled release executable could not be validated.")
            })?;
        return Ok(UpdatePlan::Rollback {
            version: previous.version().to_string(),
            coordinator_exe: previous.executable().to_path_buf(),
            candidate_dir: previous.target.release_dir.clone(),
        });
    }
    // The baseline anchor: the running binary's release. The active
    // launcher must name the same release — a launcher pointing at a
    // different release than the running binary is an inconsistent
    // installation (the direct-link dogfood layout), and planning from it
    // is how an obsolete train got selected over newer code.
    let running = running_release_anchor().map_err(|error| {
        anyhow!("This binary does not run from a managed release directory: {error:#}. Update from a binary installed by the Prime Agent installer.")
    })?;
    if let Ok(active_installation) = &active {
        if active_installation.target.release_dir != running.release_dir {
            anyhow::bail!(
                "The installation is inconsistent: the active launcher points at {} while this binary runs from {}. Repair the launcher before updating.",
                active_installation.target.release_dir.display(),
                running.release_dir.display()
            );
        }
    }
    let Some(release) = latest_release(
        running.version.as_str(),
        channel,
        &base_url,
        MANIFEST_TIMEOUT,
    )
    .await
    .with_context(|| "Could not resolve a compiled release. The installed version was kept.")?
    else {
        return Ok(UpdatePlan::Skipped {
            reason: "Could not resolve a compiled release; the installed version was kept."
                .to_string(),
        });
    };
    if release.version.is_empty()
        || pa_core::update::version::parse_package_version(&release.version).is_none()
    {
        return Ok(UpdatePlan::Skipped {
            reason: "Could not resolve a compiled release; the installed version was kept."
                .to_string(),
        });
    }
    // A tagged build is a train that was never promoted: the stable
    // channel publishes untagged releases, and installing a tagged version
    // over newer code is the obsolete-train incident (`--force` overrides).
    let effective_channel =
        channel.unwrap_or_else(|| resolve_update_channel(running.version.as_str(), None));
    if !force && effective_channel == UpdateChannel::Stable && has_prerelease_tag(&release.version)
    {
        return Ok(UpdatePlan::Skipped {
            reason: format!(
                "The stable channel published a pre-release build ({}); the installed version was kept.",
                release.version
            ),
        });
    }
    if is_base_version_downgrade(&release.version, running.version.as_str()) {
        return Ok(UpdatePlan::Skipped {
            reason: format!(
                "The channel's current release {} is older than the installed {}; the installed version was kept.",
                release.version, running.version
            ),
        });
    }
    if !force && !is_release_update_candidate(&release.version, running.version.as_str(), channel) {
        return Ok(UpdatePlan::Skipped {
            reason: format!(
                "No update candidate: the installed version {} is current.",
                running.version
            ),
        });
    }
    let artifact = artifact_for_platform(&release).map_err(|_| {
        anyhow!(
            "No verified compiled archive is available for {}.",
            current_platform_alias()
        )
    })?;
    let archive_url = format!("{base_url}/{}", artifact.file);
    let archive_sha256 = artifact.sha256.clone();
    Ok(UpdatePlan::Update {
        version: release.version,
        archive_url,
        archive_sha256,
        base_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_base_url_prefers_the_override() {
        assert_eq!(
            download_base_url(Some("https://mirror.example.com/"), "https://primary"),
            "https://mirror.example.com"
        );
        assert_eq!(
            download_base_url(Some("  "), "https://primary/"),
            "https://primary"
        );
    }
}
