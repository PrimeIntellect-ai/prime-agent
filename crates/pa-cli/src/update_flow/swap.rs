//! The staged activation (spec §4 `Activating`, TS `native-update.ts` probe
//! parity): the `.activation-state` rollback pointer, the `bin/previous`
//! symlink, and the atomic `bin/prime-agent` repoint.

use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};

/// The `--version`/`--help` probe timeout (TS `native-update.ts` runs both
/// probes with a 10 s timeout).
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// The `.activation-state` contents (spec §7: both link targets plus the
/// `update_id`; written at `Activating`, deleted on `Complete`).
pub struct ActivationState {
    pub current_target: String,
    pub previous_target: String,
    pub update_id: String,
}

impl ActivationState {
    pub fn render(&self) -> String {
        format!(
            "{}\n{}\n{}\n",
            self.current_target, self.previous_target, self.update_id
        )
    }
}

/// Repoint the launcher symlinks for one activation (spec §4 `Stopped ->
/// Activating`): record the recovery state, move the old current target to
/// `bin/previous`, then atomically point `bin/prime-agent` at the
/// candidate. Every symlink write is create-tmp + rename, so a reader
/// never observes a missing launcher.
///
/// # Errors
/// Returns an error when the `.activation-state` recovery record cannot be
/// written or made durable, or when the `previous` or current launcher
/// repoint fails.
pub fn activate(
    root: &Path,
    current_target: &str,
    candidate_target: &str,
    update_id: &str,
) -> Result<()> {
    let state = ActivationState {
        current_target: current_target.to_string(),
        previous_target: current_target.to_string(),
        update_id: update_id.to_string(),
    };
    let state_path = root.join(".activation-state");
    std::fs::write(&state_path, state.render())
        .with_context(|| format!("write {}", state_path.display()))?;
    // The rollback record must be durable BEFORE any launcher moves: a
    // crash between the write and the repoint would otherwise leave a
    // truncated state file that `read_rollback_installation` trusts over
    // the (still-valid) `bin/previous` link.
    std::fs::File::open(&state_path)?.sync_all()?;
    pa_core::update::install::sync_directory(root)?;
    write_launcher(
        root,
        pa_core::update::install::PREVIOUS_LAUNCHER,
        current_target,
    )?;
    write_launcher(
        root,
        pa_core::update::install::CURRENT_LAUNCHER,
        candidate_target,
    )?;
    Ok(())
}

/// Repoint the launcher back at the previous release (spec §4 `Rollback`):
/// the previous target is already recorded; the swap is the same atomic
/// write.
///
/// # Errors
/// Returns an error when the current launcher repoint fails.
pub fn restore_previous(root: &Path, previous_target: &str) -> Result<()> {
    write_launcher(
        root,
        pa_core::update::install::CURRENT_LAUNCHER,
        previous_target,
    )
}

/// Delete the activation state on `Complete` (spec §7: deleted after the new
/// supervisor's hello; a leftover file is only a recovery hint).
///
/// # Errors
/// Returns an error when the `.activation-state` file cannot be removed.
pub fn clear_activation_state(root: &Path) -> Result<()> {
    let path = root.join(".activation-state");
    if path.exists() {
        std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
    }
    Ok(())
}

/// One atomic launcher repoint: `<root>/bin/<link>` -> `../releases/<...>`.
fn write_launcher(root: &Path, link: &str, target: &str) -> Result<()> {
    let launcher = root.join("bin").join(link);
    let temporary = launcher.with_extension("swap-tmp");
    let _ = std::fs::remove_file(&temporary);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, &temporary)
            .with_context(|| format!("stage the {link} launcher"))?;
        std::fs::rename(&temporary, &launcher)
            .with_context(|| format!("point the {link} launcher at {target}"))?;
        if let Some(bin) = launcher.parent() {
            pa_core::update::install::sync_directory(bin)?;
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        // The staged activation requires unix symlink semantics.
        let _ = target;
        anyhow::bail!("the staged activation requires unix symlink semantics");
    }
}

/// The launcher's current link target (the `../releases/...` text).
///
/// # Errors
/// Returns an error when the launcher symlink cannot be read or its
/// target is not valid UTF-8.
pub fn launcher_target(root: &Path, link: &str) -> Result<String> {
    let launcher = root.join("bin").join(link);
    let target =
        std::fs::read_link(&launcher).with_context(|| format!("read the {link} launcher"))?;
    target
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("the {link} launcher target is not valid UTF-8"))
}

/// The validation probes of the candidate executable (TS `native-update.ts`
/// parity): `--version` must print exactly `version`, `--help` must exit
/// cleanly. Both run detached with a hard timeout.
///
/// # Errors
/// Returns an error when the candidate binary's reported version cannot
/// be obtained, when it differs from `version`, or when the `--help` probe
/// fails, times out, or exits nonzero.
pub async fn validate_candidate(exe: &Path, version: &str) -> Result<()> {
    // The release name and the binary it holds must agree: a directory
    // claiming a version its binary does not report is an inconsistent
    // release, never a candidate.
    let reported = pa_core::update::download::binary_reported_version(exe).await?;
    if reported != version {
        anyhow::bail!("the staged binary reports version {reported:?}, expected {version:?}");
    }
    probe(exe, &["--help"], PROBE_TIMEOUT).await?;
    Ok(())
}

/// Run one probe and return its stdout (an error message on failure).
async fn probe(exe: &Path, args: &[&str], timeout: Duration) -> Result<String> {
    let output = tokio::time::timeout(
        timeout,
        tokio::process::Command::new(exe)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| anyhow!("{} {:?} timed out", exe.display(), args))?
    .with_context(|| format!("run {} {:?}", exe.display(), args))?;
    if !output.status.success() {
        anyhow::bail!("{} {:?} exited with {output:?}", exe.display(), args);
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn managed_root(dir: &Path) -> PathBuf {
        let root = dir.join("install-root");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("releases").join("0.1.0-linux-x64-0")).unwrap();
        std::fs::create_dir_all(root.join("releases").join("0.2.0-linux-x64-0")).unwrap();
        std::fs::write(root.join(".managed"), "prime-agent-native-v1").unwrap();
        std::os::unix::fs::symlink(
            "../releases/0.1.0-linux-x64-0/prime-agent",
            root.join("bin").join("prime-agent"),
        )
        .unwrap();
        root
    }

    #[test]
    fn activation_moves_previous_and_points_current() {
        let dir = tempfile::tempdir().unwrap();
        let root = managed_root(dir.path());
        activate(
            &root,
            "../releases/0.1.0-linux-x64-0/prime-agent",
            "../releases/0.2.0-linux-x64-0/prime-agent",
            "u1",
        )
        .unwrap();
        assert_eq!(
            launcher_target(&root, "prime-agent").unwrap(),
            "../releases/0.2.0-linux-x64-0/prime-agent"
        );
        assert_eq!(
            launcher_target(&root, "previous").unwrap(),
            "../releases/0.1.0-linux-x64-0/prime-agent"
        );
        let state = std::fs::read_to_string(root.join(".activation-state")).unwrap();
        assert!(state.starts_with("../releases/0.1.0-linux-x64-0/prime-agent\n"));
        assert!(state.ends_with("u1\n"));
        // Rollback repoints the current launcher at the previous target.
        restore_previous(&root, "../releases/0.1.0-linux-x64-0/prime-agent").unwrap();
        assert_eq!(
            launcher_target(&root, "prime-agent").unwrap(),
            "../releases/0.1.0-linux-x64-0/prime-agent"
        );
        // Complete clears the recovery hint.
        clear_activation_state(&root).unwrap();
        assert!(!root.join(".activation-state").exists());
    }

    #[tokio::test]
    async fn the_candidate_probe_reports_stdout_and_failures() {
        // A clean exit with stdout parses; a failing command is an error.
        let ok = probe(Path::new("/bin/sh"), &["-c", "true"], PROBE_TIMEOUT)
            .await
            .unwrap();
        assert!(ok.is_empty());
        assert!(
            probe(Path::new("/bin/sh"), &["-c", "exit 3"], PROBE_TIMEOUT)
                .await
                .is_err()
        );
    }
}
