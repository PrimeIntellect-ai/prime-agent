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
///
/// # Errors
///
/// Returns the last attempt's error when every download attempt fails;
/// when the wall-clock budget expires before an attempt runs, the
/// budget-expiry error replaces it.
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
    use futures::StreamExt;
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
fn sweep_staging(releases: &Path) {
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
/// The probe is resource-bounded in both directions: a timed-out or
/// over-long-writing child is killed (`kill_on_drop`, plus the explicit
/// kill once the read bound is hit), and stdout is read to a bounded
/// length, so a payload binary that hangs or streams cannot exhaust the
/// updater.
///
/// # Errors
///
/// Returns an error when the probe child cannot be spawned, exposes no
/// stdout pipe, times out or overruns its bounds, or exits without
/// success. A successful probe returns the trimmed stdout verbatim:
/// empty output and non-version text are `Ok`, not errors.
pub async fn binary_reported_version(exe: &Path) -> Result<String> {
    const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
    const MAX_VERSION_OUTPUT: usize = 512;
    let deadline = tokio::time::Instant::now() + PROBE_TIMEOUT;
    let mut child = tokio::process::Command::new(exe)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        // A dropped timeout future must never leave the probe running.
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("run {} --version", exe.display()))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("{} --version produced no stdout", exe.display()))?;
    let mut output = Vec::new();
    let read = tokio::time::timeout_at(deadline, async {
        use tokio::io::AsyncReadExt;
        let mut buffer = [0u8; 128];
        loop {
            if output.len() >= MAX_VERSION_OUTPUT {
                break;
            }
            let read = stdout.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            output.extend_from_slice(&buffer[..read]);
            if output.contains(&b'\n') {
                break;
            }
        }
        std::io::Result::Ok(())
    })
    .await
    .map_err(|_| anyhow!("{} --version timed out", exe.display()))?;
    read.with_context(|| format!("read the {} --version output", exe.display()))?;
    // A well-behaved binary has exited by now; a hung or over-writing one
    // is killed only when the overall probe budget expires.
    let status = (if let Ok(status) = tokio::time::timeout_at(deadline, child.wait()).await {
        status
    } else {
        let _ = child.kill().await;
        anyhow::bail!("{} --version timed out", exe.display())
    })
    .with_context(|| format!("wait for {} --version", exe.display()))?;
    if !status.success() {
        anyhow::bail!("{} --version exited with {status}", exe.display());
    }
    Ok(String::from_utf8_lossy(&output).trim().to_string())
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
///
/// # Errors
///
/// Returns an error when the existing release fails re-validation, the
/// staging scratch cannot be created, the archive's digest no longer
/// matches after extraction, the unpack fails, or the staged tree cannot
/// be renamed or fsynced into place.
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
        // The archive could change on disk between the download's
        // verification and the extract; re-verify the digest of the file
        // that was actually unpacked.
        let observed = file_digest(archive)?;
        if observed != archive_sha256 {
            anyhow::bail!(
                "the release archive changed during staging: expected {archive_sha256}, observed {observed}"
            );
        }
        Ok(())
    });
    let result = staged
        .and_then(|()| finish_staging(&staging, &release_dir, archive_sha256, install_source));
    let _ = std::fs::remove_dir_all(&staging);
    result.map(|()| release_dir)
}

/// The streaming sha256 of one file (bounded memory for large payloads).
fn file_digest(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = std::io::Read::read(&mut file, &mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex(&digest.finalize()))
}

/// The manual/direct install (`prime-agent update --archive`): stage a
/// locally-built release payload — a payload directory or a release
/// archive — into `releases/<version>-<platform>-<sha256>/` and return the
/// release directory with the version the payload binary reports. The
/// version always comes from the payload binary's `--version` output
/// (never a hand-typed string), and the release name's digest is the
/// canonical digest of the STAGED tree (computed after the copy or
/// extract, so the digest names exactly the bytes that were staged). The
/// payload is copied into staging scratch, fsynced, and renamed into
/// place: a manual install can never write over a running binary (the
/// in-place `cp` class of corrupted installs) and a crash can never leave
/// a partial release under its final name.
///
/// # Errors
///
/// Returns an error when the payload path cannot be resolved or is not a
/// directory or regular file, when the staging scratch cannot be created,
/// when the payload's `--version` probe fails, when the copy fails its
/// digest check, or when the staged tree cannot be renamed into place.
pub async fn stage_local_payload(
    payload: &Path,
    root: &Path,
    install_source: &str,
) -> Result<(PathBuf, String)> {
    let payload = payload
        .canonicalize()
        .with_context(|| format!("read the release payload at {}", payload.display()))?;
    // Only a directory or a regular file is a payload: a device or FIFO
    // would block or exhaust the updater during staging.
    let payload_kind = std::fs::symlink_metadata(&payload)
        .map(|metadata| metadata.file_type())
        .with_context(|| format!("read the release payload at {}", payload.display()))?;
    if !(payload_kind.is_dir() || payload_kind.is_file()) {
        anyhow::bail!(
            "the release payload {} is not a directory or a regular file",
            payload.display()
        );
    }
    let staging = fresh_staging(root)?;
    let version = match stage_payload_version(&payload, &staging).await {
        Ok(version) => version,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    // The digest names the staged bytes (not the source path, which can
    // change underneath a concurrent writer).
    let digest = release_tree_digest(&staging)?;
    let candidate = root.join("releases").join(format!(
        "{version}-{platform}-{digest}",
        platform = current_platform_alias()
    ));
    // Byte-identical re-staging reuses the validated release; the
    // operator's --source is authoritative for future updates.
    match existing_release(&candidate, &digest) {
        Ok(Some(existing)) => {
            let _ = std::fs::remove_dir_all(&staging);
            update_install_source(&existing, install_source)?;
            return Ok((existing, version));
        }
        Ok(None) => {}
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    }
    if let Err(error) = finish_staging(&staging, &candidate, &digest, install_source) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    Ok((candidate, version))
}

/// The recorded install origin of a reused release follows the operator's
/// current `--source` (future channel updates resolve from it).
fn update_install_source(release_dir: &Path, install_source: &str) -> Result<()> {
    let path = release_dir.join(".install-source");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.trim() == install_source.trim() {
        return Ok(());
    }
    std::fs::write(&path, install_source).with_context(|| format!("write {}", path.display()))?;
    std::fs::File::open(&path)?.sync_all()?;
    super::install::sync_directory(release_dir)
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
    let binary = staging.join("prime-agent");
    if !binary.is_file() {
        anyhow::bail!("the release payload is missing prime-agent");
    }
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
    std::fs::create_dir_all(&releases).with_context(|| format!("create {}", releases.display()))?;
    sweep_staging(&releases);
    let staging = releases.join(format!("{STAGING_PREFIX}{}", uuid::Uuid::now_v7().simple()));
    std::fs::create_dir_all(&staging).with_context(|| format!("create {}", staging.display()))?;
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
        for entry in
            std::fs::read_dir(directory).with_context(|| format!("read {}", directory.display()))?
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

/// Validate a staged payload, write the installer metadata, make the
/// binary executable, fsync the tree, and rename it into its release
/// name (the atomic staging boundary).
fn finish_staging(
    staging: &Path,
    release_dir: &Path,
    archive_sha256: &str,
    install_source: &str,
) -> Result<()> {
    if !super::install::install_source_is_valid(install_source) {
        anyhow::bail!("the install source {install_source:?} is not an http(s) URL");
    }
    for asset in RELEASE_ASSETS {
        if !staging.join(asset).exists() {
            anyhow::bail!("the staged release is missing {asset}");
        }
    }
    let binary = staging.join("prime-agent");
    make_executable(&binary)?;
    std::fs::write(staging.join(".archive-sha256"), archive_sha256)?;
    std::fs::write(staging.join(".install-source"), install_source)?;
    sync_release_tree(staging)?;
    std::fs::rename(staging, release_dir)
        .with_context(|| format!("stage the release into {}", release_dir.display()))?;
    if let Some(releases) = release_dir.parent() {
        super::install::sync_directory(releases)?;
    }
    Ok(())
}

/// The canonical digest of a staged payload tree: the sha256 over every
/// entry's contents (streamed, so memory stays bounded), chained with each
/// entry's archive-relative path in its OS-native byte form and its
/// permission mode — so identical byte content under different names or
/// permission bits never reuses an earlier release. Deterministic across
/// machines: a re-staged identical payload always lands on the same
/// release name.
fn release_tree_digest(dir: &Path) -> Result<String> {
    let mut entries: Vec<(Vec<u8>, PathBuf)> = Vec::new();
    collect_payload_entries(dir, &[], &mut entries)?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    for (relative, path) in &entries {
        digest.update(relative);
        digest.update(b"\0");
        let metadata = std::fs::symlink_metadata(path)
            .with_context(|| format!("read the metadata of {}", path.display()))?;
        if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(path)
                .with_context(|| format!("read the link at {}", path.display()))?;
            digest
                .update(super::release::sha256_hex(target.to_string_lossy().as_bytes()).as_bytes());
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                digest.update(format!("{:o}", metadata.permissions().mode()).as_bytes());
            }
            #[cfg(not(unix))]
            let _ = &metadata;
            digest.update(b"\0");
            digest.update(file_digest(path)?.as_bytes());
        }
        digest.update(b"\n");
    }
    Ok(hex(&digest.finalize()))
}

fn collect_payload_entries(
    directory: &Path,
    prefix: &[u8],
    files: &mut Vec<(Vec<u8>, PathBuf)>,
) -> Result<()> {
    for entry in
        std::fs::read_dir(directory).with_context(|| format!("read {}", directory.display()))?
    {
        let entry = entry?;
        let name = entry.file_name();
        let mut relative = prefix.to_vec();
        if !relative.is_empty() {
            relative.push(b'/');
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            relative.extend_from_slice(name.as_bytes());
        }
        #[cfg(not(unix))]
        {
            relative.extend_from_slice(name.to_string_lossy().as_bytes());
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_payload_entries(&path, &relative, files)?;
        } else if file_type.is_file() || file_type.is_symlink() {
            files.push((relative, path));
        } else {
            // FIFOs, devices, and sockets are not payload content: reading
            // one would block or never end.
            anyhow::bail!(
                "{} is a special file, not release payload content",
                path.display()
            );
        }
    }
    Ok(())
}

/// Copy a payload directory into staging scratch (never over a release):
/// regular files copy with their mode, symlinks re-link to the same
/// target. The source stays untouched — the only in-place mutation this
/// flow performs is the atomic rename of the staging directory itself.
fn copy_payload_tree(from: &Path, to: &Path) -> Result<()> {
    for entry in std::fs::read_dir(from).with_context(|| format!("read {}", from.display()))? {
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
        std::fs::write(release_dir.join(".archive-sha256"), format!("{sha}0")).unwrap();
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
            format!("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo {version}; fi\nexit 0\n"),
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
        // A reused release follows the operator's current install source.
        let (reused, _) =
            stage_local_payload(&payload, &root, "https://mirror.example.com/tree/def")
                .await
                .unwrap();
        assert_eq!(reused, release_dir);
        assert_eq!(
            std::fs::read_to_string(reused.join(".install-source")).unwrap(),
            "https://mirror.example.com/tree/def"
        );
        // A changed payload stages under a different name (a new digest).
        std::fs::write(payload.join("README.md"), "changed").unwrap();
        let (changed, _) =
            stage_local_payload(&payload, &root, "https://mirror.example.com/tree/def")
                .await
                .unwrap();
        assert_ne!(changed, release_dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_permission_change_stages_a_new_release() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let payload = fixture_payload(dir.path(), "payload", "9.9.9");
        let root = dir.path().join("install-root");
        std::fs::create_dir_all(&root).unwrap();
        let (first, _) = stage_local_payload(&payload, &root, "https://example.com")
            .await
            .unwrap();
        // The same bytes with a different executable bit are a different
        // payload: the digest must not reuse the earlier release.
        let helper = payload.join("README.md");
        let mut permissions = std::fs::metadata(&helper).unwrap().permissions();
        permissions.set_mode(permissions.mode() | 0o111);
        std::fs::set_permissions(&helper, permissions).unwrap();
        let (second, _) = stage_local_payload(&payload, &root, "https://example.com")
            .await
            .unwrap();
        assert_ne!(second, first);
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
            tar.append_path_with_name(payload.join(entry), entry)
                .unwrap();
        }
        for dir_entry in ["prime-agent-runtime", "skills", "docs"] {
            tar.append_dir_all(dir_entry, payload.join(dir_entry))
                .unwrap();
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
        let (archive, _archive_file_sha) =
            fixture_versioned_archive(dir.path(), "candidate.tar.gz", "1.2.3");
        // The release name's digest is the canonical digest of the STAGED
        // tree (the extracted archive content), not the archive file's own
        // sha256 — the archive fixture above carries the same content as
        // this payload tree, so their tree digests are equal.
        let extracted = fixture_payload(dir.path(), "extracted", "1.2.3");
        let expected_digest = release_tree_digest(&extracted).unwrap();
        let root = dir.path().join("install-root");
        std::fs::create_dir_all(&root).unwrap();
        let (release_dir, version) = stage_local_payload(&archive, &root, "https://example.com")
            .await
            .unwrap();
        assert_eq!(version, "1.2.3");
        assert!(release_dir.ends_with(format!(
            "releases/1.2.3-{platform}-{expected_digest}",
            platform = current_platform_alias()
        )));
        assert_eq!(
            std::fs::read_to_string(release_dir.join(".archive-sha256")).unwrap(),
            expected_digest
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
        assert!(stage_local_payload(&payload, &root, "https://example.com")
            .await
            .is_err());
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
