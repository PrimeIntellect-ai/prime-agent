//! Candidate staging (spec §4 `Downloading`/`Staged`): stream the release
//! archive with a live sha256 digest, extract it into
//! `releases/<version>-<platform>-<sha256>/`, and write the installer
//! metadata (`install.rs` validates it on every later read).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};

use super::install::{current_platform_alias, RELEASE_ASSETS};

/// The download + staging budget (spec §9 `Downloading`): one wall-clock
/// budget shared by all attempts (default 300 s, 3 attempts).
#[derive(Debug, Clone, Copy)]
pub struct DownloadBudget {
    /// Overall wall-clock budget across all attempts.
    pub total_ms: u64,
    pub attempts: u32,
}

/// Stream `url` to `destination` verifying the archive digest while bytes
/// arrive (a digest mismatch is caught without a second pass). Retries the
/// whole download while the budget remains.
pub async fn download_archive(
    url: &str,
    expected_sha256: &str,
    destination: &Path,
    budget: DownloadBudget,
    user_agent: &str,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_millis(budget.total_ms.max(1));
    let mut last_error = anyhow!("no download attempt ran");
    for attempt in 1..=budget.attempts.max(1) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            anyhow::bail!("the download budget expired before attempt {attempt}");
        }
        match download_once(url, expected_sha256, destination, remaining, user_agent).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = error;
            }
        }
    }
    Err(last_error).with_context(|| format!("download {url} within the update budget"))
}

async fn download_once(
    url: &str,
    expected_sha256: &str,
    destination: &Path,
    timeout: Duration,
    user_agent: &str,
) -> Result<()> {
    let response = reqwest::Client::new()
        .get(url)
        .header("User-Agent", user_agent)
        .timeout(timeout)
        .send()
        .await
        .with_context(|| format!("request {url}"))?;
    if !response.status().is_success() {
        anyhow::bail!("download {url} returned {}", response.status());
    }
    let temporary = destination.with_extension("part");
    let mut digest = Sha256::new();
    let mut file = std::fs::File::create(&temporary)
        .with_context(|| format!("create {}", temporary.display()))?;
    let mut stream = response.bytes_stream();
    use futures::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("read the archive stream")?;
        digest.update(&chunk);
        std::io::Write::write_all(&mut file, &chunk)
            .with_context(|| format!("write {}", temporary.display()))?;
    }
    file.sync_data().context("sync the downloaded archive")?;
    drop(file);
    let observed = hex(&digest.finalize());
    if observed != expected_sha256 {
        let _ = std::fs::remove_file(&temporary);
        anyhow::bail!("archive digest mismatch: expected {expected_sha256}, observed {observed}");
    }
    std::fs::rename(&temporary, destination)
        .with_context(|| format!("finalize {}", destination.display()))?;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Extract the verified archive into
/// `releases/<version>-<platform>-<sha256>/` under the install root and
/// write the installer metadata (`.archive-sha256`, `.install-source`).
/// Returns the release directory (spec §7: the candidate is created at
/// `Downloading`/`Staged` and never removed by the update flow).
pub fn stage_archive(
    archive: &Path,
    archive_sha256: &str,
    root: &Path,
    version: &str,
    install_source: &str,
) -> Result<PathBuf> {
    let release_dir = root.join("releases").join(format!(
        "{version}-{platform}-{archive_sha256}",
        platform = current_platform_alias()
    ));
    if release_dir.exists() {
        // A previous interrupted update staged the same candidate; the
        // digest names the directory, so re-staging is a no-op.
        return Ok(release_dir);
    }
    std::fs::create_dir_all(&release_dir)
        .with_context(|| format!("create {}", release_dir.display()))?;
    let file =
        std::fs::File::open(archive).with_context(|| format!("open {}", archive.display()))?;
    let decompressed = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decompressed);
    // The tar crate rejects absolute paths and `..` components by default;
    // entries unpack at the archive root (installer-ci-design.md §5).
    tar.unpack(&release_dir)
        .with_context(|| format!("extract the release into {}", release_dir.display()))?;
    for asset in RELEASE_ASSETS {
        if !release_dir.join(asset).exists() {
            anyhow::bail!("the staged release is missing {asset}");
        }
    }
    let binary = release_dir.join("prime-agent");
    make_executable(&binary)?;
    std::fs::write(release_dir.join(".archive-sha256"), archive_sha256)?;
    std::fs::write(release_dir.join(".install-source"), install_source)?;
    if let Some(parent) = release_dir.parent() {
        sync_directory(parent)?;
    }
    Ok(release_dir)
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let permissions = std::fs::metadata(path)?.permissions();
    std::fs::set_permissions(
        path,
        std::fs::Permissions::from_mode(permissions.mode() | 0o755),
    )?;
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<()> {
    Ok(())
}

/// fsync a directory so staged entries survive a crash between `Staged` and
/// `Activating` (the swap must never point at an unreferenced inode). A
/// directory fd opened read-only accepts `sync_all` on POSIX platforms.
fn sync_directory(path: &Path) -> Result<()> {
    let dir = std::fs::File::open(path)?;
    dir.sync_all()
        .with_context(|| format!("fsync {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::release::sha256_hex;

    /// A fixture archive with the exact release payload (installer-ci-design
    /// §5), deterministically packed.
    fn fixture_archive(dir: &Path, name: &str) -> (PathBuf, String) {
        let staging = dir.join("staging");
        std::fs::create_dir_all(staging.join("prime-agent-runtime")).unwrap();
        std::fs::create_dir_all(staging.join("skills")).unwrap();
        std::fs::create_dir_all(staging.join("docs")).unwrap();
        for file in ["prime-agent", "LICENSE", "README.md"] {
            std::fs::write(staging.join(file), "payload").unwrap();
        }
        let archive = dir.join(name);
        let file = std::fs::File::create(&archive).unwrap();
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut tar = tar::Builder::new(encoder);
        for entry in ["prime-agent", "LICENSE", "README.md"] {
            tar.append_path_with_name(staging.join(entry), entry)
                .unwrap();
        }
        for dir_entry in ["prime-agent-runtime", "skills", "docs"] {
            tar.append_dir_all(dir_entry, staging.join(dir_entry))
                .unwrap();
        }
        let encoder = tar.into_inner().unwrap();
        encoder.finish().unwrap();
        let bytes = std::fs::read(&archive).unwrap();
        (archive, sha256_hex(&bytes))
    }

    #[test]
    fn stages_and_revalidates_a_release() {
        let dir = tempfile::tempdir().unwrap();
        let (archive, sha) = fixture_archive(dir.path(), "candidate.tar.gz");
        let root = dir.path().join("install-root");
        std::fs::create_dir_all(&root).unwrap();
        let release_dir =
            stage_archive(&archive, &sha, &root, "0.2.0", "https://example.com").unwrap();
        assert!(release_dir.ends_with(format!(
            "releases/0.2.0-{platform}-{sha}",
            platform = current_platform_alias()
        )));
        for asset in RELEASE_ASSETS {
            assert!(release_dir.join(asset).exists(), "{asset} missing");
        }
        assert_eq!(
            std::fs::read_to_string(release_dir.join(".archive-sha256")).unwrap(),
            sha
        );
        // Re-staging the same digest is a no-op.
        let again = stage_archive(&archive, &sha, &root, "0.2.0", "https://example.com").unwrap();
        assert_eq!(again, release_dir);
    }
}
