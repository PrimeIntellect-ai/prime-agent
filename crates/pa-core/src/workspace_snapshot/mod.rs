//! Cloud workspace snapshots.
//!
//! [`create_workspace_snapshot`] captures a git worktree's working state —
//! the delta from HEAD (modified, staged, and deleted tracked paths) plus
//! every nonignored untracked file — into an isolated staging directory
//! as a portable, self-verifying artifact: content-addressed blobs plus a
//! manifest that hashes them. [`verify_workspace_snapshot`] re-checks a
//! staged snapshot offline before it is uploaded anywhere.
//!
//! The capture is bounded (entry count, per-file size, total size) and
//! deliberately incomplete in a recorded way: credential-shaped file
//! names, symlinks whose targets escape the worktree, nested repositories,
//! and submodule gitlinks are excluded and listed in the manifest, so a
//! materializer knows exactly what was and was not captured. This is
//! foundation plumbing for cloud sessions; nothing wires it to a
//! user-facing toggle yet, and there is no transport here — staging and
//! verification only.

mod git;
mod manifest;
#[cfg(test)]
mod tests;
mod verify;

pub use manifest::{CapturedEntry, ExcludeReason, ExcludedEntry, SnapshotManifest};
pub use verify::verify_workspace_snapshot;

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use git::{GitStatus, StatusEntry};
use manifest::{
    is_safe_relative_path, symlink_target_stays_inside, BLOBS_DIR, MANIFEST_FILE, MANIFEST_VERSION,
};

/// Bounds that keep a snapshot small and predictable: a worktree past
/// these fails loudly instead of staging an unbounded payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotLimits {
    /// Maximum number of `git status` entries (captured, deleted, and
    /// excluded paths together).
    pub max_entries: usize,
    /// Maximum total size of captured file content.
    pub max_total_bytes: u64,
    /// Maximum size of one captured file.
    pub max_file_bytes: u64,
    /// Timeout for each git child process.
    pub git_timeout_ms: u64,
}

impl Default for SnapshotLimits {
    /// 20,000 entries, 512 MiB total, 64 MiB per file, 10s per git call.
    fn default() -> Self {
        Self {
            max_entries: 20_000,
            max_total_bytes: 512 * 1024 * 1024,
            max_file_bytes: 64 * 1024 * 1024,
            git_timeout_ms: 10_000,
        }
    }
}

/// The outcome of a successful snapshot: where it staged and what it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceSnapshot {
    /// The staging directory the snapshot was written into.
    pub staging_dir: PathBuf,
    /// The manifest's path (`<staging_dir>/manifest.json`).
    pub manifest_path: PathBuf,
    /// The staged manifest.
    pub manifest: SnapshotManifest,
}

/// Failures of [`create_workspace_snapshot`] and
/// [`verify_workspace_snapshot`].
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    /// The directory is not inside a git worktree.
    #[error("{} is not a git worktree: {detail}", path.display())]
    NotAWorktree { path: PathBuf, detail: String },
    /// A git child process failed or timed out.
    #[error("git failed: {detail}")]
    Git { detail: String },
    /// `git status` emitted a record this parser does not accept.
    #[error("malformed git status output: {detail}")]
    MalformedStatus { detail: String },
    /// The staging directory exists with prior content.
    #[error("staging directory {} exists and is not empty", path.display())]
    StagingDirNotEmpty { path: PathBuf },
    /// The staging directory lies inside the snapshotted worktree, which
    /// would capture the snapshot into itself.
    #[error("staging directory {} lies inside the snapshotted worktree", path.display())]
    StagingDirInsideWorktree { path: PathBuf },
    /// A [`SnapshotLimits`] bound was exceeded; `detail` names the
    /// offending path or size.
    #[error("snapshot limit exceeded ({limit}): {detail}")]
    Limit { limit: String, detail: String },
    /// A filesystem error at `path`.
    #[error("io error at {}: {source}", path.display())]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// The staged manifest is missing, unreadable, invalid JSON, or an
    /// unsupported version.
    #[error("manifest at {} is invalid: {detail}", path.display())]
    Manifest { path: PathBuf, detail: String },
    /// The staged snapshot failed an integrity check.
    #[error("snapshot at {} failed verification: {detail}", staging_dir.display())]
    Verification {
        staging_dir: PathBuf,
        detail: String,
    },
}

/// Capture the working state of the git worktree containing `root` into
/// `staging_dir`, under `limits`.
///
/// The staging directory is created if missing and must otherwise be
/// empty, and it must lie outside the worktree. The snapshot layout is
/// `manifest.json` plus `blobs/<sha256>` content-addressed blobs; the
/// manifest is written last, after all blobs.
///
/// # Errors
/// Returns [`SnapshotError::NotAWorktree`] when `root` is not inside a
/// git worktree, staging-guard errors for an unusable staging directory,
/// [`SnapshotError::Limit`] when a bound is exceeded, and git/io errors
/// for the enumeration and capture steps.
#[tracing::instrument(
    level = "debug",
    name = "workspace_snapshot_create",
    skip_all,
    fields(root = %root.display())
)]
pub async fn create_workspace_snapshot(
    root: &Path,
    staging_dir: &Path,
    limits: &SnapshotLimits,
) -> Result<WorkspaceSnapshot, SnapshotError> {
    let worktree_root = git::resolve_worktree_root(root, limits.git_timeout_ms).await?;
    prepare_staging_dir(staging_dir, &worktree_root)?;
    let status = git::read_worktree_status(&worktree_root, limits.git_timeout_ms).await?;
    let manifest = build_manifest(&worktree_root, staging_dir, &status, limits)?;
    let manifest_path = write_manifest(staging_dir, &manifest)?;
    Ok(WorkspaceSnapshot {
        staging_dir: staging_dir.to_path_buf(),
        manifest_path,
        manifest,
    })
}

/// Create the staging directory if needed, then reject prior content and
/// a location inside the worktree (which would capture the snapshot into
/// itself).
fn prepare_staging_dir(staging_dir: &Path, worktree_root: &Path) -> Result<(), SnapshotError> {
    std::fs::create_dir_all(staging_dir).map_err(|error| io_error(staging_dir, error))?;
    let is_empty = std::fs::read_dir(staging_dir)
        .map_err(|error| io_error(staging_dir, error))?
        .next()
        .is_none();
    if !is_empty {
        return Err(SnapshotError::StagingDirNotEmpty {
            path: staging_dir.to_path_buf(),
        });
    }
    let staging_canonical = staging_dir
        .canonicalize()
        .map_err(|error| io_error(staging_dir, error))?;
    let root_canonical = worktree_root
        .canonicalize()
        .map_err(|error| io_error(worktree_root, error))?;
    if staging_canonical != root_canonical && staging_canonical.starts_with(&root_canonical) {
        return Err(SnapshotError::StagingDirInsideWorktree {
            path: staging_dir.to_path_buf(),
        });
    }
    Ok(())
}

/// Classify every status entry and stage the result: captured files become
/// content-addressed blobs, in-root symlinks and tracked deletions become
/// manifest entries, and everything deliberately uncaptured becomes an
/// excluded entry with its reason.
fn build_manifest(
    worktree_root: &Path,
    staging_dir: &Path,
    status: &GitStatus,
    limits: &SnapshotLimits,
) -> Result<SnapshotManifest, SnapshotError> {
    if status.entries.len() > limits.max_entries {
        return Err(limit_error(
            "max_entries",
            format!(
                "{} paths changed, cap is {}",
                status.entries.len(),
                limits.max_entries
            ),
        ));
    }
    let blobs_dir = staging_dir.join(BLOBS_DIR);
    std::fs::create_dir_all(&blobs_dir).map_err(|error| io_error(&blobs_dir, error))?;
    let mut captured: Vec<CapturedEntry> = Vec::new();
    let mut excluded: Vec<ExcludedEntry> = Vec::new();
    let mut total_bytes: u64 = 0;
    for entry in &status.entries {
        let path = entry.path();
        if !is_safe_relative_path(path) {
            return Err(SnapshotError::MalformedStatus {
                detail: format!("unsafe path {path:?}"),
            });
        }
        if is_secret_path(path) {
            excluded.push(ExcludedEntry {
                path: path.to_string(),
                reason: ExcludeReason::Secret,
            });
            continue;
        }
        let gitlink = matches!(entry, StatusEntry::Tracked { gitlink: true, .. });
        if gitlink {
            // A submodule reference's content is never captured; only its
            // absence from the worktree is recorded (as a deletion).
            if worktree_root.join(path).symlink_metadata().is_ok() {
                excluded.push(ExcludedEntry {
                    path: path.to_string(),
                    reason: ExcludeReason::Submodule,
                });
            } else {
                captured.push(CapturedEntry::Deleted {
                    path: path.to_string(),
                    status: entry_status(entry),
                });
            }
            continue;
        }
        let is_untracked = matches!(entry, StatusEntry::Untracked { .. });
        if is_untracked && path.ends_with('/') {
            // A directory git declined to recurse into: a nested
            // repository, shipped whole by other means or not at all.
            excluded.push(ExcludedEntry {
                path: path.to_string(),
                reason: ExcludeReason::NestedRepository,
            });
            continue;
        }
        let absolute = worktree_root.join(path);
        match std::fs::symlink_metadata(&absolute) {
            Ok(metadata) if metadata.is_symlink() => {
                let target =
                    std::fs::read_link(&absolute).map_err(|error| io_error(&absolute, error))?;
                let target = target
                    .to_str()
                    .ok_or_else(|| SnapshotError::MalformedStatus {
                        detail: format!("non-UTF-8 symlink target at {path:?}"),
                    })?;
                if symlink_target_stays_inside(path, target) {
                    captured.push(CapturedEntry::Symlink {
                        path: path.to_string(),
                        status: entry_status(entry),
                        target: target.to_string(),
                    });
                } else {
                    excluded.push(ExcludedEntry {
                        path: path.to_string(),
                        reason: ExcludeReason::EscapingSymlink,
                    });
                }
            }
            Ok(metadata) if metadata.is_file() => {
                let content =
                    std::fs::read(&absolute).map_err(|error| io_error(&absolute, error))?;
                if content.len() as u64 > limits.max_file_bytes {
                    return Err(limit_error(
                        "max_file_bytes",
                        format!(
                            "{path} is {} bytes, cap is {}",
                            content.len(),
                            limits.max_file_bytes
                        ),
                    ));
                }
                total_bytes += content.len() as u64;
                if total_bytes > limits.max_total_bytes {
                    return Err(limit_error(
                        "max_total_bytes",
                        format!(
                            "{total_bytes} bytes of captured content, cap is {}",
                            limits.max_total_bytes
                        ),
                    ));
                }
                let sha256 = format!("{:x}", Sha256::digest(&content));
                let blob = blobs_dir.join(&sha256);
                if std::fs::symlink_metadata(&blob).is_err() {
                    std::fs::write(&blob, &content).map_err(|error| io_error(&blob, error))?;
                }
                captured.push(CapturedEntry::File {
                    path: path.to_string(),
                    status: entry_status(entry),
                    sha256,
                    bytes: content.len() as u64,
                    executable: is_executable(&metadata),
                });
            }
            // A directory or special file a tracked path turned into, or
            // an untracked fifo/socket: not portable content.
            Ok(_) => excluded.push(ExcludedEntry {
                path: path.to_string(),
                reason: ExcludeReason::NotRegularFile,
            }),
            // A tracked path missing from the worktree is a deletion; an
            // untracked path that vanished mid-capture never existed.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !is_untracked {
                    captured.push(CapturedEntry::Deleted {
                        path: path.to_string(),
                        status: entry_status(entry),
                    });
                }
            }
            Err(error) => return Err(io_error(&absolute, error)),
        }
    }
    Ok(SnapshotManifest {
        version: MANIFEST_VERSION,
        head_commit: status.head_commit.clone(),
        captured,
        excluded,
    })
}

/// Write the manifest deterministically (path-sorted entries, no
/// timestamps) via a temp file and rename, so a reader that sees it holds
/// a complete blob set.
fn write_manifest(
    staging_dir: &Path,
    manifest: &SnapshotManifest,
) -> Result<PathBuf, SnapshotError> {
    let manifest_path = staging_dir.join(MANIFEST_FILE);
    let bytes = serde_json::to_vec(manifest).map_err(|error| SnapshotError::Manifest {
        path: manifest_path.clone(),
        detail: format!("serialization failed: {error}"),
    })?;
    let temp_path = staging_dir.join(format!("{MANIFEST_FILE}.tmp"));
    std::fs::write(&temp_path, &bytes).map_err(|error| io_error(&temp_path, error))?;
    crate::platform::rename_onto(&temp_path, &manifest_path)
        .map_err(|error| io_error(&manifest_path, error))?;
    Ok(manifest_path)
}

/// The `git status` XY pair for an entry, or `"??"` for untracked paths;
/// recorded in the manifest for diagnostics.
fn entry_status(entry: &StatusEntry) -> String {
    match entry {
        StatusEntry::Tracked { xy, .. } => xy.clone(),
        StatusEntry::Untracked { .. } => "??".to_string(),
    }
}

/// File names never captured, tracked or not: credential-shaped locals
/// that must not ride along to a remote staging area. Deliberately small
/// and exact — broadening the list is a policy decision, not a drive-by.
pub(crate) fn is_secret_path(path: &str) -> bool {
    const EXACT_NAMES: &[&str] = &[
        ".env",
        ".envrc",
        ".npmrc",
        ".netrc",
        ".git-credentials",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
    ];
    const SECRET_SUFFIXES: &[&str] = &[".pem", ".key", ".p12", ".pfx"];
    let name = match path.rsplit_once('/') {
        Some((_, name)) => name,
        None => path,
    };
    EXACT_NAMES.contains(&name)
        || name.starts_with(".env.")
        || SECRET_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

fn limit_error(limit: &str, detail: String) -> SnapshotError {
    SnapshotError::Limit {
        limit: limit.to_string(),
        detail,
    }
}

fn io_error(path: &Path, error: std::io::Error) -> SnapshotError {
    SnapshotError::Io {
        path: path.to_path_buf(),
        source: error,
    }
}

/// The captured executable bit, portably (the one mode git and every
/// target filesystem agrees on).
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        false
    }
}
