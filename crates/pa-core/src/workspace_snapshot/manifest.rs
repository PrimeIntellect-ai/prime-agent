//! The workspace snapshot manifest: the portable, verifiable description
//! of a captured worktree delta.
//!
//! A staged snapshot directory is
//!
//! ```text
//! <staging>/manifest.json    this module's types, written last
//! <staging>/blobs/<sha256>    content-addressed file blobs
//! ```
//!
//! Every manifest path is a repo-relative POSIX path in git's own form, so
//! a snapshot stages the same content on any filesystem. The manifest is
//! written after all blobs, so a reader that sees it holds a complete
//! set; determinism (path-sorted entries, no timestamps) makes two
//! snapshots of the same worktree byte-identical.

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

/// The manifest format version this build reads and writes.
pub const MANIFEST_VERSION: u32 = 2;

/// The manifest file name inside a staging directory.
pub const MANIFEST_FILE: &str = "manifest.json";

/// The blob directory name inside a staging directory.
pub const BLOBS_DIR: &str = "blobs";

/// A captured worktree path: file content staged as a blob, an in-root
/// symlink, or a deletion recorded for the materializer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CapturedEntry {
    /// A regular file staged as a content-addressed blob; `sha256` and
    /// `bytes` describe the blob and `executable` its mode bit.
    File {
        path: String,
        status: String,
        sha256: String,
        bytes: u64,
        executable: bool,
    },
    /// A symlink whose target resolves inside the worktree; the link is
    /// recreated from `target` verbatim (no blob).
    Symlink {
        path: String,
        status: String,
        target: String,
    },
    /// A tracked path absent from the worktree; the materializer removes
    /// it after checking out HEAD.
    Deleted { path: String, status: String },
}

impl CapturedEntry {
    /// The entry's repo-relative path.
    #[must_use]
    pub fn path(&self) -> &str {
        match self {
            CapturedEntry::File { path, .. }
            | CapturedEntry::Symlink { path, .. }
            | CapturedEntry::Deleted { path, .. } => path,
        }
    }
}

/// Why a path was deliberately left uncaptured.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExcludeReason {
    /// A credential-shaped file name (`.env*`, `*.pem`, `id_rsa`, ...).
    Secret,
    /// A symlink whose target escapes the worktree root.
    EscapingSymlink,
    /// An untracked directory that is itself a git repository.
    NestedRepository,
    /// A submodule gitlink reference.
    Submodule,
    /// A path that is neither a regular file nor a symlink (a directory,
    /// fifo, socket, or device).
    NotRegularFile,
    /// A path whose ancestor directory is a symlink; the leaf resolves
    /// outside the worktree and is never read.
    SymlinkedAncestor,
    /// A HEAD path the index marks skip-worktree that is absent from the
    /// worktree (outside a sparse checkout): absent by design, so the
    /// baseline records it instead of failing.
    SkipWorktree,
}

/// A path excluded from capture, with the reason it was left out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExcludedEntry {
    pub path: String,
    pub reason: ExcludeReason,
}

/// The baseline of a staged snapshot, stated explicitly so a materializer
/// never guesses. Present exactly when `head_commit` is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Baseline {
    /// HEAD's tree content staged as content-addressed blobs, minus
    /// secret-named paths (the same denylist the delta applies) and
    /// minus every path the delta already covers (the delta carries the
    /// newer state). No git history ships - no commits, no reverted
    /// content from any prior revision - and nothing here is a
    /// secret-safety guarantee: a credential under an innocuous name
    /// still stages, in the baseline or the delta. Entries are files and
    /// symlinks only - a deletion is not baseline content - and
    /// verification rejects any path claimed by more than one list, so
    /// the materializer never receives contradictory instructions for
    /// the same path (full HEAD-tree coverage itself stays a creator
    /// invariant: it cannot be proven offline from a commit id alone).
    HeadTree {
        entries: Vec<CapturedEntry>,
        excluded: Vec<ExcludedEntry>,
    },
    /// No baseline staged; the consumer must obtain `head_commit` itself
    /// (e.g. via the origin remote) and refuse to materialize when it
    /// cannot. Nothing here makes that reachable.
    External,
}

/// The manifest of one staged snapshot; `captured` and `excluded` are
/// sorted by path and written deterministically.
///
/// Invariant: `baseline` is present if and only if `head_commit` is. A
/// committed repository always declares which baseline it ships - a
/// staged bundle or an explicit external reference - and an unborn one
/// (no commits, every path untracked) needs none because its delta is
/// the whole worktree. Verification rejects any other combination, so a
/// missing or ambiguous baseline is never silent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotManifest {
    pub version: u32,
    pub head_commit: Option<String>,
    pub baseline: Option<Baseline>,
    pub captured: Vec<CapturedEntry>,
    pub excluded: Vec<ExcludedEntry>,
}

/// True for a repo-relative POSIX path that is safe to join onto a root:
/// non-empty, backslash-free (a backslash is a Windows separator, so a
/// portable manifest never records it inside a path either), with no
/// absolute, parent, or current-directory components.
pub(crate) fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// True when the symlink `target` of the entry at `entry_path` resolves
/// inside the worktree: relative, colon-free and backslash-free (portable
/// across platforms: `\` is a Windows separator, so a UNC, drive-root, or
/// `..\` climb has no faithful portable meaning here), and never climbing
/// above the root via `..`.
pub(crate) fn symlink_target_stays_inside(entry_path: &str, target: &str) -> bool {
    if target.is_empty() || target.starts_with('/') || target.contains(':') || target.contains('\\')
    {
        return false;
    }
    let base_dir = entry_path.rsplit_once('/').map_or("", |(parent, _)| parent);
    let mut depth: i64 = 0;
    base_dir
        .split('/')
        .chain(target.split('/'))
        .filter(|segment| !segment.is_empty())
        .all(|segment| match segment {
            ".." => {
                depth -= 1;
                depth >= 0
            }
            "." => true,
            _ => {
                depth += 1;
                true
            }
        })
}
