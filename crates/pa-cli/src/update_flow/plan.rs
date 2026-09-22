//! The update plan (TS `getNativeUpdatePlan` port): decide update vs
//! rollback vs skip before any FSM state runs, with the TS refusal
//! messages kept verbatim so the CLI surfaces the same text.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use pa_core::update::install::{
    current_platform_alias, read_installation, read_rollback_installation, CURRENT_LAUNCHER,
};
use pa_core::update::release::{artifact_for_platform, latest_release};
use pa_core::update::version::{
    is_base_version_downgrade, is_release_update_candidate, UpdateChannel,
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

/// Plan one update run (TS `getNativeUpdatePlan` parity: same refusals,
/// same messages, plus the Rust flow's staging facts).
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
    let Some(release) =
        latest_release(installation.version(), channel, &base_url, MANIFEST_TIMEOUT)
            .await
            .with_context(|| {
                "Could not resolve a compiled release. The installed version was kept."
            })?
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
    if is_base_version_downgrade(&release.version, installation.version()) {
        return Ok(UpdatePlan::Skipped {
            reason: format!(
                "The channel's current release {} is older than the installed {}; the installed version was kept.",
                release.version,
                installation.version()
            ),
        });
    }
    if !force && !is_release_update_candidate(&release.version, installation.version(), channel) {
        return Ok(UpdatePlan::Skipped {
            reason: format!(
                "No update candidate: the installed version {} is current.",
                installation.version()
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
