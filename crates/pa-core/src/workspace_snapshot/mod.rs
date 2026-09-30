//! Cloud workspace snapshots.
//!
//! [`create_workspace_snapshot`] captures a git worktree's working state —
//! the delta from HEAD (modified, staged, and deleted tracked paths) plus
//! every nonignored untracked file — into an isolated staging directory
//! as a portable, self-verifying artifact: content-addressed blobs plus a
//! manifest that hashes them. [`verify_workspace_snapshot`] re-checks a
//! staged snapshot offline before it is uploaded anywhere.
//!
//! The baseline is the caller's explicit choice ([`BaselineMode`]):
//! HEAD's tree content staged through the same filters as the delta (no
//! git history ships, and the secret file-name denylist applies to both
//! layers), or none at all. That is not a secret-safety guarantee - a
//! credential under an innocuous name still stages, in either layer.
//! The capture is bounded (entry count, baseline count, per-file size,
//! total size) and deliberately incomplete in a recorded way:
//! credential-shaped file names, symlinks whose targets escape the
//! worktree (and paths whose ancestors became symlinks), nested
//! repositories, submodule gitlinks, and absent sparse-checkout
//! (skip-worktree) paths are excluded and listed in the manifest, so a
//! materializer knows exactly what was and was not captured. This is
//! foundation plumbing for cloud sessions; nothing wires it to a
//! user-facing toggle yet, and there is no transport here - staging and
//! verification only.

mod git;
mod manifest;
#[cfg(test)]
mod tests;
mod verify;

pub use manifest::{Baseline, CapturedEntry, ExcludeReason, ExcludedEntry, SnapshotManifest};
pub use verify::verify_workspace_snapshot;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use sha1::{Digest as Sha1Digest, Sha1};
use sha2::Sha256;

use git::{GitStatus, HeadTreeEntry, StatusEntry};
use manifest::{
    is_safe_relative_path, symlink_target_stays_inside, BLOBS_DIR, MANIFEST_FILE, MANIFEST_VERSION,
};

/// The hex length of a SHA-256 git object id (the alternate object
/// format's length; SHA-1's 40 is the historical default).
const SHA256_OID_HEX_LEN: usize = 64;

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
    /// Maximum number of HEAD-tree paths staged as the baseline.
    pub max_baseline_entries: usize,
    /// Timeout for each git child process.
    pub git_timeout_ms: u64,
}

impl Default for SnapshotLimits {
    /// 20,000 delta entries, 100,000 baseline paths, 512 MiB total
    /// captured content, 64 MiB per file, 10s per git call.
    fn default() -> Self {
        Self {
            max_entries: 20_000,
            max_total_bytes: 512 * 1024 * 1024,
            max_file_bytes: 64 * 1024 * 1024,
            max_baseline_entries: 100_000,
            git_timeout_ms: 10_000,
        }
    }
}

/// Whether [`create_workspace_snapshot`] ships the baseline alongside the
/// delta. Explicit and required at every call site. The `HeadTree`
/// baseline stages HEAD's tree content only - no commits, no reverted
/// content from prior revisions - and the credential-shaped file-name
/// filter applies to it exactly as to the delta. None of that is a
/// secret-safety guarantee: a credential under an innocuous file name
/// still stages, in either layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BaselineMode {
    /// Stage HEAD's tree content into the snapshot, so a guest
    /// materializes the base revision offline (unpushed worktrees
    /// included) without inheriting any git history.
    HeadTree,
    /// Ship the delta only; the manifest records an `external` baseline
    /// and the consumer must obtain the head commit itself, refusing to
    /// materialize when it cannot.
    External,
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
    /// The worktree changed under the capture: a baseline path's staged
    /// bytes (or its presence, or its mode) no longer reproduce what HEAD
    /// records, so the snapshot fails loudly instead of shipping a
    /// baseline that is not the stated commit.
    #[error("worktree changed during capture: {detail}")]
    ConcurrentMutation { detail: String },
    /// Capture cannot enforce owner-only staging permissions on this platform.
    #[error("workspace snapshot capture requires Unix owner-only file permissions")]
    UnsupportedPlatform,
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
/// `staging_dir`, under `limits`, shipping the baseline according to
/// `baseline_mode` (see [`BaselineMode`] for what a baseline does and
/// does not protect).
///
/// The staging directory is created if missing, tightened to owner-only
/// (0700), must otherwise be empty, and must lie outside the worktree.
/// The snapshot layout is `manifest.json` plus `blobs/<sha256>`
/// content-addressed blobs (staged owner-only, 0600) covering both the
/// delta and - in [`BaselineMode::HeadTree`] - the HEAD-tree baseline;
/// the manifest is written last, after everything it describes.
///
/// This capture is supported only on Unix. On other platforms the
/// permission wall cannot enforce owner-only modes, so capture refuses
/// before creating the staging directory. The secret skip is a filename-
/// shaped denylist only: ordinary-named files containing secrets stage
/// verbatim. The snapshot directory is secret-bearing; every consumer
/// must treat it as credentials.
///
/// Capture reads, hashes, and writes files synchronously inside this
/// async function (up to the configured entry and byte caps). Callers
/// must run the entire capture via `tokio::task::spawn_blocking` with
/// `tokio::runtime::Handle::block_on` rather than block a Tokio worker.
///
/// # Errors
/// Returns [`SnapshotError::UnsupportedPlatform`] on non-Unix targets,
/// [`SnapshotError::NotAWorktree`] when `root` is not inside a git worktree,
/// staging-guard errors for an unusable staging directory,
/// [`SnapshotError::Limit`] when a bound is exceeded, and git/io errors
/// for the enumeration, baseline, and capture steps.
#[tracing::instrument(
    level = "debug",
    name = "workspace_snapshot_create",
    skip_all,
    fields(root = %root.display())
)]
pub async fn create_workspace_snapshot(
    root: &Path,
    staging_dir: &Path,
    baseline_mode: BaselineMode,
    limits: &SnapshotLimits,
) -> Result<WorkspaceSnapshot, SnapshotError> {
    if !cfg!(unix) {
        return Err(SnapshotError::UnsupportedPlatform);
    }
    let worktree_root = git::resolve_worktree_root(root, limits.git_timeout_ms).await?;
    prepare_staging_dir(staging_dir, &worktree_root)?;
    let status = git::read_worktree_status(&worktree_root, limits.git_timeout_ms).await?;
    // Baseline, in the mode the caller chose. An unborn repository has
    // no commits and no tracked paths to restore - its delta already is
    // the whole worktree - so it stages no baseline and the manifest
    // says so explicitly (head commit and baseline are both null).
    let head_tree = match (&status.head_commit, baseline_mode) {
        (None, _) | (Some(_), BaselineMode::External) => Vec::new(),
        // Enumerate the tree of the commit status just reported, never
        // `HEAD` again: another process committing in between would
        // otherwise pair the old `head_commit` with a newer HEAD's tree.
        // With the enumeration pinned, the manifest's delta, baseline,
        // and head commit all describe one revision, and any later
        // worktree drift fails loudly per path instead.
        (Some(commit), BaselineMode::HeadTree) => {
            git::read_head_tree(&worktree_root, commit, limits.git_timeout_ms).await?
        }
    };
    let manifest = build_manifest(
        &worktree_root,
        staging_dir,
        &status,
        baseline_mode,
        &head_tree,
        limits,
    )?;
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
    crate::platform::perms::create_dir_all_private(staging_dir)
        .map_err(|error| io_error(staging_dir, error))?;
    let is_empty = std::fs::read_dir(staging_dir)
        .map_err(|error| io_error(staging_dir, error))?
        .next()
        .is_none();
    if !is_empty {
        return Err(SnapshotError::StagingDirNotEmpty {
            path: staging_dir.to_path_buf(),
        });
    }
    tighten_private(staging_dir)?;
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

/// Classify the delta (every `git status` entry) and the HEAD-tree
/// baseline the caller chose, staging content-addressed blobs and
/// recording in-root symlinks, tracked deletions, and every deliberate
/// exclusion with its reason.
fn build_manifest(
    worktree_root: &Path,
    staging_dir: &Path,
    status: &GitStatus,
    baseline_mode: BaselineMode,
    head_tree: &[HeadTreeEntry],
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
    if head_tree.len() > limits.max_baseline_entries {
        return Err(limit_error(
            "max_baseline_entries",
            format!(
                "{} paths in HEAD's tree, cap is {}",
                head_tree.len(),
                limits.max_baseline_entries
            ),
        ));
    }
    let blobs_dir = staging_dir.join(BLOBS_DIR);
    crate::platform::perms::create_dir_all_private(&blobs_dir)
        .map_err(|error| io_error(&blobs_dir, error))?;
    tighten_private(&blobs_dir)?;
    let mut captured: Vec<CapturedEntry> = Vec::new();
    let mut excluded: Vec<ExcludedEntry> = Vec::new();
    let mut total_bytes: u64 = 0;
    // One path, one row: `git rm --cached` leaves a tracked deletion and
    // the same path back as untracked in one `git status` run. The later
    // (untracked) row describes the worktree leaf that actually ships, so
    // it replaces the tracked row; both classify the same leaf, and a
    // duplicated path would trip verify's strictly-sorted check.
    let mut delta_rows: Vec<&StatusEntry> = Vec::with_capacity(status.entries.len());
    let mut seen: HashSet<&str> = HashSet::with_capacity(status.entries.len());
    for entry in status.entries.iter().rev() {
        if seen.insert(entry.path()) {
            delta_rows.push(entry);
        }
    }
    delta_rows.reverse();
    for entry in delta_rows {
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
            // absence from the worktree is recorded (as a deletion). The
            // probe refuses symlinked ancestors like every other read and
            // classifies the leaf kind WITHOUT reading content: the
            // bytes a replaced gitlink's stand-in file would cost are
            // discarded anyway, so they never touch the read budget.
            match open_leaf(worktree_root, path, 0, true) {
                Ok(OpenLeaf::Missing) => captured.push(CapturedEntry::Deleted {
                    path: path.to_string(),
                    status: entry_status(entry),
                }),
                Ok(OpenLeaf::AncestorSymlink) => excluded.push(ExcludedEntry {
                    path: path.to_string(),
                    reason: ExcludeReason::SymlinkedAncestor,
                }),
                Ok(OpenLeaf::File { .. } | OpenLeaf::Symlink { .. } | OpenLeaf::NotRegularFile) => {
                    excluded.push(ExcludedEntry {
                        path: path.to_string(),
                        reason: ExcludeReason::Submodule,
                    });
                }
                Err(error) => return Err(io_error(&worktree_root.join(path), error)),
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
        match capture_leaf(
            worktree_root,
            &blobs_dir,
            path,
            &entry_status(entry),
            None,
            limits,
            &mut total_bytes,
        )? {
            LeafOutcome::Entry(entry) => captured.push(entry),
            LeafOutcome::Excluded(reason) => excluded.push(ExcludedEntry {
                path: path.to_string(),
                reason,
            }),
            // A tracked path missing from the worktree is a deletion; an
            // untracked path that vanished mid-capture never existed.
            LeafOutcome::Missing if !is_untracked => captured.push(CapturedEntry::Deleted {
                path: path.to_string(),
                status: entry_status(entry),
            }),
            LeafOutcome::Missing => {}
        }
    }
    let baseline = match (&status.head_commit, baseline_mode) {
        (None, _) => None,
        (Some(_), BaselineMode::External) => Some(Baseline::External),
        (Some(_), BaselineMode::HeadTree) => {
            // HEAD's tree content, staged from the worktree (a path git
            // status does not list matches HEAD), minus every path the
            // delta already carries - the delta holds the newer state.
            // No history ships and the same secret denylist applies; a
            // credential under an innocuous name still stages, in either
            // layer.
            let covered: HashSet<&str> = status.entries.iter().map(StatusEntry::path).collect();
            let mut entries: Vec<CapturedEntry> = Vec::new();
            let mut baseline_excluded: Vec<ExcludedEntry> = Vec::new();
            for tree_entry in head_tree {
                if covered.contains(tree_entry.path.as_str()) {
                    continue;
                }
                if tree_entry.gitlink {
                    baseline_excluded.push(ExcludedEntry {
                        path: tree_entry.path.clone(),
                        reason: ExcludeReason::Submodule,
                    });
                    continue;
                }
                match capture_leaf(
                    worktree_root,
                    &blobs_dir,
                    &tree_entry.path,
                    &tree_entry.mode,
                    Some(tree_entry),
                    limits,
                    &mut total_bytes,
                )? {
                    LeafOutcome::Entry(entry) => entries.push(entry),
                    LeafOutcome::Excluded(reason) => baseline_excluded.push(ExcludedEntry {
                        path: tree_entry.path.clone(),
                        reason,
                    }),
                    LeafOutcome::Missing if tree_entry.skip_worktree => {
                        baseline_excluded.push(ExcludedEntry {
                            path: tree_entry.path.clone(),
                            reason: ExcludeReason::SkipWorktree,
                        });
                    }
                    // The path HEAD records is absent from the worktree
                    // (or turned into something unreadable): the baseline
                    // can no longer be the stated commit, so the snapshot
                    // fails loudly rather than omitting silently.
                    LeafOutcome::Missing => {
                        return Err(SnapshotError::ConcurrentMutation {
                            detail: format!(
                                "{:?} vanished from the worktree during capture",
                                tree_entry.path
                            ),
                        })
                    }
                }
            }
            Some(Baseline::HeadTree {
                entries,
                excluded: baseline_excluded,
            })
        }
    };
    Ok(SnapshotManifest {
        version: MANIFEST_VERSION,
        head_commit: status.head_commit.clone(),
        baseline,
        captured,
        excluded,
    })
}

/// The git blob object id of `content` (`git hash-object` equivalent):
/// the object-format hash of `blob <len>\0` followed by the bytes. The
/// HEAD-tree baseline verifies every staged entry against the object id
/// `ls-tree` recorded, so the manifest's baseline provably is the stated
/// commit's content; the format follows the repository (SHA-1 or SHA-256).
pub(crate) fn git_blob_oid(content: &[u8], sha256: bool) -> String {
    let header = format!("blob {}\0", content.len());
    let digest = if sha256 {
        let mut hasher = Sha256::new();
        hasher.update(header.as_bytes());
        hasher.update(content);
        format!("{:x}", hasher.finalize())
    } else {
        let mut hasher = Sha1::new();
        hasher.update(header.as_bytes());
        hasher.update(content);
        format!("{:x}", hasher.finalize())
    };
    digest
}

/// What a single path's worktree leaf turned out to be.
#[derive(Debug)]
enum LeafOutcome {
    Entry(CapturedEntry),
    Excluded(ExcludeReason),
    Missing,
}

/// What a path's leaf opened as, with every component walked via
/// `openat` with `O_NOFOLLOW` on unix: no step follows a symlink.
#[cfg(unix)]
enum OpenLeaf {
    File {
        content: Vec<u8>,
        executable: bool,
    },
    Symlink {
        target: String,
    },
    /// An ancestor directory is a symlink: the leaf - if any - lives
    /// outside the worktree and is never read.
    AncestorSymlink,
    Missing,
    NotRegularFile,
}

/// Open one raw fd with `O_NOFOLLOW`, closing it on drop; the guard keeps
/// the walk's error paths leak-free without unsafe constructors.
#[cfg(unix)]
struct FdGuard(nix::libc::c_int);

#[cfg(unix)]
impl Drop for FdGuard {
    fn drop(&mut self) {
        let _ = nix::unistd::close(self.0);
    }
}

/// Open `path` beneath `root`, refusing to follow any symlink at any
/// step (unix): ancestors via `openat(O_DIRECTORY | O_NOFOLLOW)`, the
/// leaf via `openat(O_NOFOLLOW)` or `readlinkat`. A symlink swapped in
/// after the walk started still cannot redirect the read, because every
/// component is pinned by its opened fd, not its path.
#[cfg(unix)]
fn open_leaf(
    root: &Path,
    path: &str,
    max_bytes: usize,
    classify_only: bool,
) -> std::io::Result<OpenLeaf> {
    use nix::fcntl::{openat, AtFlags, OFlag};
    use nix::sys::stat::{fstat, fstatat, Mode, SFlag};
    let dir_flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let root = openat(None, root, dir_flags, Mode::empty()).map_err(io_from_errno)?;
    let mut dir = FdGuard(root);
    let components: Vec<&str> = path.split('/').filter(|c| !c.is_empty()).collect();
    for component in &components[..components.len().saturating_sub(1)] {
        let component = *component;
        let fd = match openat(Some(dir.0), component, dir_flags, Mode::empty()) {
            Ok(fd) => FdGuard(fd),
            // The O_DIRECTORY|O_NOFOLLOW open of a symlink fails ELOOP
            // on older linux and ENOTDIR on current linux and darwin;
            // ENOTDIR also means a non-directory stands there, under
            // which the path does not exist.
            Err(nix::errno::Errno::ELOOP) => return Ok(OpenLeaf::AncestorSymlink),
            Err(nix::errno::Errno::ENOTDIR) => {
                let stat = fstatat(Some(dir.0), component, AtFlags::AT_SYMLINK_NOFOLLOW)
                    .map_err(io_from_errno)?;
                return Ok(
                    if stat.st_mode & SFlag::S_IFMT.bits() == SFlag::S_IFLNK.bits() {
                        OpenLeaf::AncestorSymlink
                    } else {
                        OpenLeaf::Missing
                    },
                );
            }
            Err(nix::errno::Errno::ENOENT) => return Ok(OpenLeaf::Missing),
            Err(errno) => return Err(io_from_errno(errno)),
        };
        dir = fd;
    }
    if let Some(leaf) = components.last() {
        let leaf = *leaf;
        // O_NONBLOCK: opening a FIFO (or a device) read-only blocks
        // until a writer or driver appears - an untracked named pipe in
        // the worktree would otherwise hang the whole capture. Regular
        // files ignore the flag, and the fstat below classifies before
        // any read happens.
        match openat(
            Some(dir.0),
            leaf,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => {
                let fd = FdGuard(fd);
                let metadata = fstat(fd.0).map_err(io_from_errno)?;
                let mode = nix::sys::stat::SFlag::from_bits_truncate(metadata.st_mode);
                if mode.contains(nix::sys::stat::SFlag::S_IFREG) {
                    if classify_only {
                        // A kind-only probe (the replaced-gitlink path):
                        // the leaf is classified from the fstat alone, so
                        // discarded bytes never reach the read budget.
                        return Ok(OpenLeaf::File {
                            content: Vec::new(),
                            executable: metadata.st_mode & 0o111 != 0,
                        });
                    }
                    let mut content = Vec::new();
                    let mut buffer = vec![0u8; 128 * 1024];
                    loop {
                        let read = nix::unistd::read(fd.0, &mut buffer).map_err(io_from_errno)?;
                        if read == 0 {
                            return Ok(OpenLeaf::File {
                                content,
                                executable: metadata.st_mode & 0o111 != 0,
                            });
                        }
                        content.extend_from_slice(&buffer[..read]);
                        // Past the caller's cap, stop reading: the size
                        // check errors on the oversized capture instead
                        // of buffering an unbounded raced-grown file.
                        if content.len() > max_bytes {
                            return Ok(OpenLeaf::File {
                                content,
                                executable: metadata.st_mode & 0o111 != 0,
                            });
                        }
                    }
                }
                // A directory, fifo, socket, or device: not portable
                // content.
                Ok(OpenLeaf::NotRegularFile)
            }
            // O_NOFOLLOW on a symlink leaf: read the link through the
            // pinned parent fd instead.
            Err(nix::errno::Errno::ELOOP) => {
                let target = nix::fcntl::readlinkat(Some(dir.0), leaf).map_err(io_from_errno)?;
                let target = target.into_string().map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::InvalidData, "non-UTF-8 link target")
                })?;
                Ok(OpenLeaf::Symlink { target })
            }
            Err(nix::errno::Errno::ENOENT) => Ok(OpenLeaf::Missing),
            // A unix socket path: present, but nothing regular to read.
            // linux reports ENXIO, darwin EOPNOTSUPP.
            Err(nix::errno::Errno::ENXIO | nix::errno::Errno::EOPNOTSUPP) => {
                Ok(OpenLeaf::NotRegularFile)
            }
            Err(errno) => Err(io_from_errno(errno)),
        }
    } else {
        Ok(OpenLeaf::Missing)
    }
}

#[cfg(unix)]
fn io_from_errno(errno: nix::errno::Errno) -> std::io::Error {
    std::io::Error::from_raw_os_error(errno as i32)
}

/// Non-unix fallback: component validation before the read. Without
/// `openat`, an untrusted concurrent actor can still swap an ancestor
/// for a symlink between the check and the read, so the residual race is
/// documented rather than closed: staging on non-unix targets must not
/// run with untrusted concurrent filesystem actors.
#[cfg(not(unix))]
enum OpenLeaf {
    File { content: Vec<u8>, executable: bool },
    Symlink { target: String },
    AncestorSymlink,
    Missing,
    NotRegularFile,
}

#[cfg(not(unix))]
fn open_leaf(
    root: &Path,
    path: &str,
    max_bytes: usize,
    classify_only: bool,
) -> std::io::Result<OpenLeaf> {
    let components: Vec<&str> = path.split('/').filter(|c| !c.is_empty()).collect();
    let mut prefix = PathBuf::new();
    for component in &components[..components.len().saturating_sub(1)] {
        prefix.push(component);
        if let Ok(metadata) = std::fs::symlink_metadata(root.join(&prefix)) {
            if metadata.is_symlink() {
                return Ok(OpenLeaf::AncestorSymlink);
            }
        }
    }
    let absolute = root.join(path);
    let metadata = match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata,
        // A tracked deletion or a leaf that vanished between the status
        // run and this open is a missing leaf, not a capture error
        // (the unix arm's ENOENT path, in the std error kind).
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(OpenLeaf::Missing),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() {
        return Ok(OpenLeaf::Symlink {
            target: std::fs::read_link(&absolute)?
                .to_string_lossy()
                .into_owned(),
        });
    }
    if metadata.is_file() {
        if classify_only {
            // A kind-only probe (the replaced-gitlink path): the leaf
            // is classified from the metadata alone, so discarded bytes
            // never reach the read budget.
            return Ok(OpenLeaf::File {
                content: Vec::new(),
                executable: false,
            });
        }
        let mut file = std::fs::File::open(&absolute)?;
        let mut content = Vec::new();
        let mut buffer = vec![0u8; 128 * 1024];
        loop {
            let read = std::io::Read::read(&mut file, &mut buffer)?;
            if read == 0 {
                break;
            }
            content.extend_from_slice(&buffer[..read]);
            // Past the caller's cap, stop reading: the caller's size
            // check errors on the oversized capture instead of
            // buffering an unbounded raced-grown file whole.
            if content.len() > max_bytes {
                break;
            }
        }
        return Ok(OpenLeaf::File {
            content,
            executable: false,
        });
    }
    Ok(OpenLeaf::NotRegularFile)
}

/// Classify and stage one path's worktree leaf: a regular file becomes a
/// content-addressed blob (owner-only mode), an in-root symlink a link
/// entry, and anything deliberately uncaptured an exclusion reason.
/// `expected`, when present, is HEAD's `ls-tree` record for the path: the
/// captured bytes and mode are verified against it, so a worktree that
/// mutates under the capture fails loudly instead of shipping a baseline
/// that is not the stated commit.
fn capture_leaf(
    worktree_root: &Path,
    blobs_dir: &Path,
    path: &str,
    status: &str,
    expected: Option<&HeadTreeEntry>,
    limits: &SnapshotLimits,
    total_bytes: &mut u64,
) -> Result<LeafOutcome, SnapshotError> {
    if is_secret_path(path) {
        return Ok(LeafOutcome::Excluded(ExcludeReason::Secret));
    }
    let cap = usize::try_from(limits.max_file_bytes).unwrap_or(usize::MAX);
    let absolute = worktree_root.join(path);
    match open_leaf(worktree_root, path, cap, false) {
        Ok(OpenLeaf::AncestorSymlink) => {
            Ok(LeafOutcome::Excluded(ExcludeReason::SymlinkedAncestor))
        }
        Ok(OpenLeaf::Missing) => Ok(LeafOutcome::Missing),
        Ok(OpenLeaf::NotRegularFile) => Ok(LeafOutcome::Excluded(ExcludeReason::NotRegularFile)),
        Ok(OpenLeaf::Symlink { target }) => {
            if symlink_target_stays_inside(path, &target) {
                if let Some(expected) = expected {
                    verify_against_head(
                        path,
                        "120000",
                        &git_blob_oid(target.as_bytes(), expected.oid.len() == SHA256_OID_HEX_LEN),
                        expected,
                    )?;
                }
                Ok(LeafOutcome::Entry(CapturedEntry::Symlink {
                    path: path.to_string(),
                    status: status.to_string(),
                    target,
                }))
            } else {
                Ok(LeafOutcome::Excluded(ExcludeReason::EscapingSymlink))
            }
        }
        Ok(OpenLeaf::File {
            content,
            executable,
        }) => {
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
            *total_bytes += content.len() as u64;
            if *total_bytes > limits.max_total_bytes {
                return Err(limit_error(
                    "max_total_bytes",
                    format!(
                        "{total_bytes} bytes of captured content, cap is {}",
                        limits.max_total_bytes
                    ),
                ));
            }
            let mut executable = executable;
            if let Some(expected) = expected {
                let oid = git_blob_oid(&content, expected.oid.len() == SHA256_OID_HEX_LEN);
                if expected.oid == oid {
                    // A clean leaf restates HEAD's own mode: the object
                    // id is the mutation check, and the filesystem bit
                    // is not git's truth under core.filemode=false
                    // (WSL drvfs, FAT/exFAT).
                    executable = expected.mode == "100755";
                }
                verify_against_head(
                    path,
                    if executable { "100755" } else { "100644" },
                    &oid,
                    expected,
                )?;
            }
            let sha256 = format!("{:x}", Sha256::digest(&content));
            let blob = blobs_dir.join(&sha256);
            if std::fs::symlink_metadata(&blob).is_err() {
                std::fs::write(&blob, &content).map_err(|error| io_error(&blob, error))?;
                tighten_private_file(&blob)?;
            }
            Ok(LeafOutcome::Entry(CapturedEntry::File {
                path: path.to_string(),
                status: status.to_string(),
                sha256,
                bytes: content.len() as u64,
                executable,
            }))
        }
        Err(error) => Err(io_error(&absolute, error)),
    }
}

/// Verify one captured baseline leaf against HEAD's `ls-tree` record:
/// the mode must match and the staged bytes must hash to the recorded
/// object id. Any mismatch is a concurrent worktree mutation, a loud
/// error rather than a silently wrong baseline.
fn verify_against_head(
    path: &str,
    mode: &str,
    oid: &str,
    expected: &HeadTreeEntry,
) -> Result<(), SnapshotError> {
    // The object id is the primary mutation detector; the mode is
    // secondary (a host without an observable executable bit reports
    // its derived mode as 100644, so a mutated file must fail on the
    // content first, never on a mode it cannot observe).
    if expected.oid != oid {
        return Err(SnapshotError::ConcurrentMutation {
            detail: format!(
                "{path} hashes to object {oid} but HEAD records {}",
                expected.oid
            ),
        });
    }
    if expected.mode != mode {
        return Err(SnapshotError::ConcurrentMutation {
            detail: format!("{path} is mode {mode} but HEAD records {}", expected.mode),
        });
    }
    Ok(())
}

/// Staged content files (blobs, the manifest) are tightened to
/// owner-only (0600) regardless of umask, so a file later moved out of
/// the private staging directory keeps no group/other access. Both
/// modes route through the platform permission wall.
fn tighten_private(dir: &Path) -> Result<(), SnapshotError> {
    crate::platform::perms::restrict_dir(dir).map_err(|error| io_error(dir, error))
}

fn tighten_private_file(path: &Path) -> Result<(), SnapshotError> {
    crate::platform::perms::restrict_file(path).map_err(|error| io_error(path, error))
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
    // The verifier's manifest cap is a property of the format, so a
    // manifest past it fails the capture loudly instead of producing an
    // artifact verify would always reject (symlink targets do not count
    // toward the content budget, so the entry caps alone do not bound
    // the serialized size).
    if bytes.len() as u64 > verify::MAX_MANIFEST_BYTES {
        return Err(limit_error(
            "max_manifest_bytes",
            format!(
                "manifest is {} bytes, cap is {}",
                bytes.len(),
                verify::MAX_MANIFEST_BYTES
            ),
        ));
    }
    let temp_path = staging_dir.join(format!("{MANIFEST_FILE}.tmp"));
    std::fs::write(&temp_path, &bytes).map_err(|error| io_error(&temp_path, error))?;
    crate::platform::rename_onto(&temp_path, &manifest_path)
        .map_err(|error| io_error(&manifest_path, error))?;
    tighten_private_file(&manifest_path)?;
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
/// and exact - broadening the list is a policy decision, not a drive-by.
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
