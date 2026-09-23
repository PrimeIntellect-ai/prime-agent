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

/// The staging scratch prefix under `releases/`: a staging directory is
/// renamed into its final release name only after the payload validates,
/// so a crash can never leave a partial directory under a release name
/// (and the boot-time `.stage-*` sweep below never sees a live one).
const STAGING_PREFIX: &str = ".stage-";

/// Remove leftover staging scratch from interrupted installs (staging
/// directories are never a release; the rename into place is atomic).
pub fn sweep_staging(releases: &Path) {
    let Ok(entries) = std::fs::read_dir(releases) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(STAGING_PREFIX) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// The `--version` probe of a release binary (TS `native-update.ts` runs
/// the same probe with a 10 s timeout). The binary's own report is the
/// version the release layout must carry: a directory whose name claims a
/// different version is an inconsistent installation, never a candidate.
pub async fn binary_reported_version(exe: &Path) -> Result<String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::process::Command::new(exe)
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| anyhow!("{} --version timed out", exe.display()))?
    .with_context(|| format!("run {} --version", exe.display()))?;
    if !output.status.success() {
        anyhow::bail!("{} --version exited with {output:?}", exe.display());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Extract the verified archive into
/// `releases/<version>-<platform>-<sha256>/` under the install root and
/// write the installer metadata (`.archive-sha256`, `.install-source`).
/// The payload is unpacked into staging scratch and renamed into place
/// only after it validates, so a crash never leaves a partial directory
/// under the release name, and an existing release with the same name is
/// re-validated before reuse: a damaged or foreign staging is never
/// silently reactivated. Returns the release directory (spec §7: the
/// candidate is created at `Downloading`/`Staged` and never removed by the
/// update flow).
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
    if let Some(existing) = existing_release(&release_dir, archive_sha256)? {
        return Ok(existing);
    }
    let staging = fresh_staging(root)?;
    let staged = unpack_archive_into(archive, &staging).and_then(|()| {
        for asset in RELEASE_ASSETS {
            if !staging.join(asset).exists() {
                anyhow::bail!("the staged release is missing {asset}");
            }
        }
        Ok(())
    });
    let result = staged.and_then(|()| finish_staging(&staging, &release_dir, archive_sha256, install_source));
    let _ = std::fs::remove_dir_all(&staging);
    result.map(|()| release_dir)
}

/// The manual/direct install (`prime-agent update --archive`): stage a
/// locally-built release payload — a payload directory or a release
/// archive — into `releases/<version>-<platform>-<sha256>/` and return the
/// release directory with the version the payload binary reports. The
/// version always comes from the payload binary's `--version` output
/// (never a hand-typed string), the release name's digest is the canonical
/// payload digest, and the payload is copied into staging scratch, fsynced,
/// and renamed into place: a manual install can never write over a running
/// binary (the in-place `cp` class of corrupted installs) and a crash can
/// never leave a partial release under its final name.
pub async fn stage_local_payload(
    payload: &Path,
    root: &Path,
    install_source: &str,
) -> Result<(PathBuf, String)> {
    let payload = payload
        .canonicalize()
        .with_context(|| format!("read the release payload at {}", payload.display()))?;
    let digest = if payload.is_dir() {
        release_tree_digest(&payload)?
    } else {
        let bytes = std::fs::read(&payload)
            .with_context(|| format!("read {}", payload.display()))?;
        super::release::sha256_hex(&bytes)
    };
    let staging = fresh_staging(root)?;
    let version = match stage_payload_version(&payload, &staging).await {
        Ok(version) => version,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let candidate = root.join("releases").join(format!(
        "{version}-{platform}-{digest}",
        platform = current_platform_alias()
    ));
    // Byte-identical re-staging reuses the validated release.
    if let Some(existing) = existing_release(&candidate, &digest)? {
        let _ = std::fs::remove_dir_all(&staging);
        return Ok((existing, version));
    }
    if let Err(error) = finish_staging(&staging, &candidate, &digest, install_source) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    Ok((candidate, version))
}

/// Copy or extract the payload into staging scratch, check the release
/// assets, and probe the binary's `--version` (the version a release
/// claims is the one its binary reports — never a hand-typed string).
async fn stage_payload_version(payload: &Path, staging: &Path) -> Result<String> {
    if payload.is_dir() {
        copy_payload_tree(payload, staging)?;
    } else {
        unpack_archive_into(payload, staging)?;
    }
    for asset in RELEASE_ASSETS {
        if !staging.join(asset).exists() {
            anyhow::bail!("the release payload is missing {asset}");
        }
    }
    let binary = staging.join("prime-agent");
    make_executable(&binary)?;
    let version = binary_reported_version(&binary).await?;
    // The release name embeds the version; a binary that does not report a
    // parseable version cannot be staged under the managed layout.
    if version.is_empty()
        || version.contains('/')
        || super::version::parse_package_version(&version).is_none()
    {
        anyhow::bail!(
            "the release binary reports version {version:?}, which is not a release version"
        );
    }
    Ok(version)
}

/// A previously staged release with this name, re-validated: the digest
/// names the directory so byte-identical re-staging is a no-op, but only
/// after the existing payload re-validates — a damaged staging must never
/// be reused.
fn existing_release(release_dir: &Path, archive_sha256: &str) -> Result<Option<PathBuf>> {
    if !release_dir.exists() {
        return Ok(None);
    }
    super::install::validate_release_dir(release_dir, archive_sha256).with_context(|| {
        format!(
            "the existing release {} is damaged; remove it before updating",
            release_dir.display()
        )
    })?;
    Ok(Some(release_dir.to_path_buf()))
}

/// A fresh staging scratch directory under `releases/`.
fn fresh_staging(root: &Path) -> Result<PathBuf> {
    let releases = root.join("releases");
    std::fs::create_dir_all(&releases)
        .with_context(|| format!("create {}", releases.display()))?;
    sweep_staging(&releases);
    let staging = releases.join(format!("{STAGING_PREFIX}{}", uuid::Uuid::now_v7().simple()));
    std::fs::create_dir_all(&staging)
        .with_context(|| format!("create {}", staging.display()))?;
    Ok(staging)
}

/// Unpack a release archive at the staging root (the tar crate rejects
/// absolute paths and `..` components by default; entries unpack at the
/// archive root, installer-ci-design.md §5).
fn unpack_archive_into(archive: &Path, staging: &Path) -> Result<()> {
    let file =
        std::fs::File::open(archive).with_context(|| format!("open {}", archive.display()))?;
    let decompressed = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decompressed);
    tar.unpack(staging)
        .with_context(|| format!("extract the release into {}", staging.display()))
}

/// fsync a staged payload tree (files, then directories deepest-first) so
/// the rename into place can never expose a release whose data did not
/// survive a crash.
fn sync_release_tree(root: &Path) -> Result<()> {
    fn walk(directory: &Path, directories: &mut Vec<PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(directory)
            .with_context(|| format!("read {}", directory.display()))?
        {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                directories.push(path.clone());
                walk(&path, directories)?;
            } else if file_type.is_file() {
                std::fs::File::open(&path)?.sync_all()?;
            }
        }
        Ok(())
    }
    let mut directories = Vec::new();
    walk(root, &mut directories)?;
    for directory in directories.iter().rev() {
        super::install::sync_directory(directory)?;
    }
    super::install::sync_directory(root)
}

/// The canonical digest of a payload directory: the sha256 over every
/// file's contents, chained with each file's archive-relative path
/// (sorted, `/`-separated, symlinks by target). Deterministic across
/// machines, so a re-staged identical payload always lands on the same
/// release name.
pub fn release_tree_digest(dir: &Path) -> Result<String> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_payload_entries(dir, "", &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    for (relative, path) in &files {
        digest.update(relative.as_bytes());
        digest.update(b"\0");
        let contents = match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                std::fs::read_link(path)
                    .with_context(|| format!("read the link at {}", path.display()))?
                    .to_string_lossy()
                    .as_bytes()
                    .to_vec()
            }
            _ => std::fs::read(path)
                .with_context(|| format!("read {}", path.display()))?,
        };
        digest.update(super::release::sha256_hex(&contents).as_bytes());
        digest.update(b"\n");
    }
    Ok(hex(&digest.finalize()))
}

fn collect_payload_entries(
    root: &Path,
    prefix: &str,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<()> {
    for entry in std::fs::read_dir(root)
        .with_context(|| format!("read {}", root.display()))?
    {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_payload_entries(&path, &relative, files)?;
        } else {
            files.push((relative, path));
        }
    }
    Ok(())
}

/// Copy a payload directory into staging scratch (never over a release):
/// regular files copy with their mode, symlinks re-link to the same
/// target. The source stays untouched — the only in-place mutation this
/// flow performs is the atomic rename of the staging directory itself.
fn copy_payload_tree(from: &Path, to: &Path) -> Result<()> {
    for entry in std::fs::read_dir(from)
        .with_context(|| format!("read {}", from.display()))?
    {
        let entry = entry?;
        let name = entry.file_name();
        let source = entry.path();
        let target = to.join(&name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            std::fs::create_dir_all(&target)
                .with_context(|| format!("create {}", target.display()))?;
            copy_payload_tree(&source, &target)?;
        } else if file_type.is_symlink() {
            #[cfg(unix)]
            {
                let destination = std::fs::read_link(&source)
                    .with_context(|| format!("read the link at {}", source.display()))?;
                std::os::unix::fs::symlink(destination, &target)
                    .with_context(|| format!("link {}", target.display()))?;
            }
        } else {
            std::fs::copy(&source, &target)
                .with_context(|| format!("copy {} to {}", source.display(), target.display()))?;
        }
    }
    Ok(())
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
        // No staging scratch is left behind.
        let releases = root.join("releases");
        for entry in std::fs::read_dir(&releases).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().to_string();
            assert!(!name.starts_with(".stage-"), "staging scratch left: {name}");
        }
    }

    #[test]
    fn never_reuses_a_damaged_release() {
        let dir = tempfile::tempdir().unwrap();
        let (archive, sha) = fixture_archive(dir.path(), "candidate.tar.gz");
        let root = dir.path().join("install-root");
        std::fs::create_dir_all(&root).unwrap();
        let release_dir =
            stage_archive(&archive, &sha, &root, "0.2.0", "https://example.com").unwrap();
        // A damaged release with the same name is refused, never silently
        // reactivated.
        std::fs::remove_file(release_dir.join("README.md")).unwrap();
        let error = stage_archive(&archive, &sha, &root, "0.2.0", "https://example.com");
        assert!(error.is_err());
        // A foreign digest recorded in the name is refused too.
        std::fs::write(release_dir.join("README.md"), "payload").unwrap();
        std::fs::write(release_dir.join(".archive-sha256"), format!("{}0", sha)).unwrap();
        assert!(stage_archive(&archive, &sha, &root, "0.2.0", "https://example.com").is_err());
    }

    /// A payload directory whose `prime-agent` is a script binary reporting
    /// a fixed version — the probe path is the same as a real binary's.
    fn fixture_payload(dir: &Path, name: &str, version: &str) -> PathBuf {
        let payload = dir.join(name);
        std::fs::create_dir_all(payload.join("prime-agent-runtime")).unwrap();
        std::fs::create_dir_all(payload.join("skills")).unwrap();
        std::fs::create_dir_all(payload.join("docs")).unwrap();
        for file in ["LICENSE", "README.md"] {
            std::fs::write(payload.join(file), "payload").unwrap();
        }
        let binary = payload.join("prime-agent");
        std::fs::write(
            &binary,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo {version}; fi\nexit 0\n"
            ),
        )
        .unwrap();
        make_executable(&binary).unwrap();
        payload
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stages_a_local_payload_directory() {
        let dir = tempfile::tempdir().unwrap();
        let payload = fixture_payload(dir.path(), "payload", "9.9.9");
        let root = dir.path().join("install-root");
        std::fs::create_dir_all(&root).unwrap();
        let (release_dir, version) =
            stage_local_payload(&payload, &root, "https://example.com/tree/abc")
                .await
                .unwrap();
        assert_eq!(version, "9.9.9");
        let digest = release_tree_digest(&payload).unwrap();
        assert!(release_dir.ends_with(format!(
            "releases/9.9.9-{platform}-{digest}",
            platform = current_platform_alias()
        )));
        // The version came from the binary probe; the metadata the install
        // layout validates is in place.
        assert_eq!(
            std::fs::read_to_string(release_dir.join(".archive-sha256")).unwrap(),
            digest
        );
        assert_eq!(
            std::fs::read_to_string(release_dir.join(".install-source")).unwrap(),
            "https://example.com/tree/abc"
        );
        // Re-staging the same payload reuses the validated release.
        let (again, again_version) =
            stage_local_payload(&payload, &root, "https://example.com/tree/abc")
                .await
                .unwrap();
        assert_eq!(again, release_dir);
        assert_eq!(again_version, "9.9.9");
        // A changed payload stages under a different name (a new digest).
        std::fs::write(payload.join("README.md"), "changed").unwrap();
        let (changed, _) =
            stage_local_payload(&payload, &root, "https://example.com/tree/abc")
                .await
                .unwrap();
        assert_ne!(changed, release_dir);
    }

    /// A release archive whose `prime-agent` is an executable script
    /// reporting a fixed version (the probe path a real binary takes).
    fn fixture_versioned_archive(dir: &Path, name: &str, version: &str) -> (PathBuf, String) {
        let payload = fixture_payload(dir, "archive-staging", version);
        let archive = dir.join(name);
        let file = std::fs::File::create(&archive).unwrap();
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut tar = tar::Builder::new(encoder);
        for entry in ["prime-agent", "LICENSE", "README.md"] {
            tar.append_path_with_name(payload.join(entry), entry).unwrap();
        }
        for dir_entry in ["prime-agent-runtime", "skills", "docs"] {
            tar.append_dir_all(dir_entry, payload.join(dir_entry)).unwrap();
        }
        let encoder = tar.into_inner().unwrap();
        encoder.finish().unwrap();
        let bytes = std::fs::read(&archive).unwrap();
        (archive, sha256_hex(&bytes))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stages_a_local_archive_and_probes_the_binary() {
        let dir = tempfile::tempdir().unwrap();
        let (archive, sha) = fixture_versioned_archive(dir.path(), "candidate.tar.gz", "1.2.3");
        let root = dir.path().join("install-root");
        std::fs::create_dir_all(&root).unwrap();
        let (release_dir, version) =
            stage_local_payload(&archive, &root, "https://example.com")
                .await
                .unwrap();
        assert_eq!(version, "1.2.3");
        assert!(release_dir.ends_with(format!(
            "releases/1.2.3-{platform}-{sha}",
            platform = current_platform_alias()
        )));
        assert_eq!(
            std::fs::read_to_string(release_dir.join(".archive-sha256")).unwrap(),
            sha
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_a_local_payload_without_a_release_version() {
        let dir = tempfile::tempdir().unwrap();
        // A "binary" that prints garbage: the release name embeds the
        // version, so an unparseable report is refused at staging.
        let payload = fixture_payload(dir.path(), "payload", "not a version");
        let root = dir.path().join("install-root");
        std::fs::create_dir_all(&root).unwrap();
        assert!(
            stage_local_payload(&payload, &root, "https://example.com")
                .await
                .is_err()
        );
    }

    #[test]
    fn tree_digests_are_deterministic_and_content_sensitive() {
        let dir = tempfile::tempdir().unwrap();
        let first = fixture_payload(dir.path(), "one", "9.9.9");
        let second = fixture_payload(dir.path(), "two", "9.9.9");
        assert_eq!(
            release_tree_digest(&first).unwrap(),
            release_tree_digest(&second).unwrap()
        );
        std::fs::write(second.join("README.md"), "different").unwrap();
        assert_ne!(
            release_tree_digest(&first).unwrap(),
            release_tree_digest(&second).unwrap()
        );
    }
}
