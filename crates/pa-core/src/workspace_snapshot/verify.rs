//! Offline verification of a staged snapshot: every manifest claim is
//! checked against the staged blobs and the blob set against the
//! manifest, so an incomplete or tampered staging area fails loudly
//! before it is uploaded anywhere.

use std::collections::{HashMap, HashSet};
use std::io::Read as _;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::manifest::{
    is_safe_relative_path, symlink_target_stays_inside, Baseline, CapturedEntry, ExcludedEntry,
    SnapshotManifest, BLOBS_DIR, MANIFEST_FILE, MANIFEST_VERSION,
};
use super::SnapshotError;

/// The length of a git commit id.
const COMMIT_HEX_LEN: usize = 40;
/// The alternate object format's commit id length (SHA-256 repositories).
const SHA256_COMMIT_HEX_LEN: usize = 64;

/// The length of a SHA-256 digest.
const DIGEST_HEX_LEN: usize = 64;

/// Hard cap on a manifest read into memory: entry counts are bounded at
/// capture (`max_entries` + `max_baseline_entries`), so a manifest past
/// this size is tampering, not payload.
pub(crate) const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;

/// Whether a captured-entry list may record deletions: the worktree
/// delta does (a tracked path may have been removed from the worktree),
/// but a HEAD-tree baseline restates content the tree holds, so a
/// deletion there is a contradictory instruction for the materializer.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Deletions {
    Allowed,
    Forbidden,
}

/// Verify a staged snapshot: parse the manifest, re-hash every blob
/// (delta and baseline alike), and reject unreferenced or missing blobs.
/// Returns the verified manifest.
///
/// # Errors
/// Returns [`SnapshotError::Manifest`] when the manifest is missing,
/// unreadable, invalid JSON, or an unsupported version, and
/// [`SnapshotError::Verification`] when any structural or content
/// integrity claim fails.
pub fn verify_workspace_snapshot(staging_dir: &Path) -> Result<SnapshotManifest, SnapshotError> {
    let manifest_path = staging_dir.join(MANIFEST_FILE);
    let manifest = read_manifest(&manifest_path)?;
    verify_structure(staging_dir, &manifest)?;
    verify_baseline_invariant(staging_dir, &manifest)?;
    verify_blobs(staging_dir, &manifest)?;
    Ok(manifest)
}

fn read_manifest(path: &Path) -> Result<SnapshotManifest, SnapshotError> {
    let reject = |detail: String| SnapshotError::Manifest {
        path: path.to_path_buf(),
        detail,
    };
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| reject(format!("unreadable: {error}")))?;
    // A named pipe (or a device) named as the manifest would otherwise
    // pass the length check — a FIFO reports length zero — and block
    // the open until a writer appears; anything but a regular file is
    // a malformed staging area.
    if !metadata.is_file() {
        return Err(reject("manifest is not a regular file".to_string()));
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(reject(format!(
            "manifest is {} bytes, cap is {MAX_MANIFEST_BYTES}",
            metadata.len()
        )));
    }
    let file = std::fs::File::open(path).map_err(|error| reject(format!("unreadable: {error}")))?;
    let mut bytes = Vec::new();
    std::io::Read::take(file, MAX_MANIFEST_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| reject(format!("unreadable: {error}")))?;
    let manifest: SnapshotManifest =
        serde_json::from_slice(&bytes).map_err(|error| reject(format!("invalid JSON: {error}")))?;
    if manifest.version != MANIFEST_VERSION {
        return Err(reject(format!(
            "unsupported version {} (expected {MANIFEST_VERSION})",
            manifest.version
        )));
    }
    Ok(manifest)
}

/// Structural checks: safe and strictly path-sorted (hence
/// duplicate-free) entry lists, well-formed digests, in-root symlink
/// targets, file-or-symlink baseline items, and globally disjoint path
/// claims - for the delta lists and for a HEAD-tree baseline alike.
/// Whether the baseline covers the head commit's whole tree cannot be
/// proven offline from a commit string alone; that guarantee remains a
/// creator invariant, not a verified manifest property.
fn verify_structure(staging_dir: &Path, manifest: &SnapshotManifest) -> Result<(), SnapshotError> {
    let reject = |detail: String| SnapshotError::Verification {
        staging_dir: staging_dir.to_path_buf(),
        detail,
    };
    if let Some(head) = &manifest.head_commit {
        // Either object format's id is a well-formed commit: SHA-1 (40)
        // or SHA-256 (64) repositories both publish a branch.oid here.
        if !is_lower_hex(head, COMMIT_HEX_LEN) && !is_lower_hex(head, SHA256_COMMIT_HEX_LEN) {
            return Err(reject(format!("malformed head commit {head:?}")));
        }
    }
    verify_captured_list(
        staging_dir,
        &manifest.captured,
        "captured",
        Deletions::Allowed,
    )?;
    verify_excluded_list(staging_dir, &manifest.excluded, "excluded")?;
    if let Some(Baseline::HeadTree { entries, excluded }) = &manifest.baseline {
        verify_captured_list(staging_dir, entries, "baseline", Deletions::Forbidden)?;
        verify_excluded_list(staging_dir, excluded, "baseline excluded")?;
    }
    verify_disjoint_paths(staging_dir, manifest)?;
    Ok(())
}

/// Cross-list path disjointness: every path is stated by at most one of
/// the four lists (delta captured, delta excluded, baseline entries,
/// baseline excluded). The creator sends each status or tree path to
/// exactly one list, so a path claimed twice gives the materializer
/// contradictory instructions - a staged blob alongside an exclusion for
/// the same path, or the delta and the baseline disagreeing about who
/// holds the newer state. Within-list duplicates are already rejected
/// by the sorted-order checks.
fn verify_disjoint_paths(
    staging_dir: &Path,
    manifest: &SnapshotManifest,
) -> Result<(), SnapshotError> {
    let reject = |detail: String| SnapshotError::Verification {
        staging_dir: staging_dir.to_path_buf(),
        detail,
    };
    // Gather every (path, list) claim, then reject the first path a
    // second list also claims.
    let mut claims: Vec<(&str, &str)> = manifest
        .captured
        .iter()
        .map(|entry| (entry.path(), "captured"))
        .chain(
            manifest
                .excluded
                .iter()
                .map(|entry| (entry.path.as_str(), "excluded")),
        )
        .collect();
    if let Some(Baseline::HeadTree { entries, excluded }) = &manifest.baseline {
        claims.extend(entries.iter().map(|entry| (entry.path(), "baseline")));
        claims.extend(
            excluded
                .iter()
                .map(|entry| (entry.path.as_str(), "baseline excluded")),
        );
    }
    let mut claimed: HashMap<&str, &str> = HashMap::new();
    for (path, list) in claims {
        if let Some(prior) = claimed.insert(path, list) {
            return Err(reject(format!(
                "path {path:?} is claimed by both the {prior} and {list} lists"
            )));
        }
    }
    Ok(())
}

fn verify_captured_list(
    staging_dir: &Path,
    entries: &[CapturedEntry],
    list: &str,
    deletions: Deletions,
) -> Result<(), SnapshotError> {
    let reject = |detail: String| SnapshotError::Verification {
        staging_dir: staging_dir.to_path_buf(),
        detail,
    };
    let mut previous: Option<&str> = None;
    for entry in entries {
        let path = entry.path();
        if !is_safe_relative_path(path) {
            return Err(reject(format!("unsafe {list} path {path:?}")));
        }
        if previous.is_some_and(|prior| prior >= path) {
            return Err(reject(format!(
                "{list} entries out of order or duplicated at {path:?}"
            )));
        }
        previous = Some(path);
        match entry {
            CapturedEntry::File { sha256, .. } => {
                if !is_lower_hex(sha256, DIGEST_HEX_LEN) {
                    return Err(reject(format!("malformed blob digest {sha256:?}")));
                }
            }
            CapturedEntry::Symlink { target, .. } => {
                if !symlink_target_stays_inside(path, target) {
                    return Err(reject(format!(
                        "symlink at {path:?} in {list} escapes the worktree"
                    )));
                }
            }
            CapturedEntry::Deleted { .. } => {
                if deletions == Deletions::Forbidden {
                    return Err(reject(format!(
                        "deletion in {list} at {path:?}: baseline entries must be files or symlinks"
                    )));
                }
            }
        }
    }
    Ok(())
}

fn verify_excluded_list(
    staging_dir: &Path,
    entries: &[ExcludedEntry],
    list: &str,
) -> Result<(), SnapshotError> {
    let reject = |detail: String| SnapshotError::Verification {
        staging_dir: staging_dir.to_path_buf(),
        detail,
    };
    let mut previous: Option<&str> = None;
    for entry in entries {
        if !is_safe_relative_path(&entry.path) {
            return Err(reject(format!("unsafe {list} path {:?}", entry.path)));
        }
        if previous.is_some_and(|prior| prior >= entry.path.as_str()) {
            return Err(reject(format!(
                "{list} entries out of order or duplicated at {:?}",
                entry.path
            )));
        }
        previous = Some(entry.path.as_str());
    }
    Ok(())
}

/// Baseline invariant: a manifest with a head commit must state which
/// baseline it ships - HEAD-tree content or an explicit external
/// reference - and a manifest without one must not carry a baseline. A
/// missing or ambiguous baseline is never silent.
fn verify_baseline_invariant(
    staging_dir: &Path,
    manifest: &SnapshotManifest,
) -> Result<(), SnapshotError> {
    let reject = |detail: String| SnapshotError::Verification {
        staging_dir: staging_dir.to_path_buf(),
        detail,
    };
    match (&manifest.head_commit, &manifest.baseline) {
        // No commits need no baseline; a committed repository states
        // which baseline it ships either way.
        (None, None) | (Some(_), Some(Baseline::External | Baseline::HeadTree { .. })) => Ok(()),
        (None, Some(_)) => Err(reject("baseline present without a head commit".to_string())),
        (Some(head), None) => Err(reject(format!(
            "head commit {head} has no baseline in the manifest"
        ))),
    }
}

/// Content checks: every file entry's blob (delta or baseline) exists
/// with the recorded size and hash, and the blob directory holds nothing
/// unreferenced.
fn verify_blobs(staging_dir: &Path, manifest: &SnapshotManifest) -> Result<(), SnapshotError> {
    let reject = |detail: String| SnapshotError::Verification {
        staging_dir: staging_dir.to_path_buf(),
        detail,
    };
    let blobs_dir = staging_dir.join(BLOBS_DIR);
    let mut referenced: HashSet<&str> = HashSet::new();
    let mut file_entries: Vec<(&str, &CapturedEntry)> = Vec::new();
    for entry in &manifest.captured {
        file_entries.push(("captured", entry));
    }
    if let Some(Baseline::HeadTree { entries, .. }) = &manifest.baseline {
        for entry in entries {
            file_entries.push(("baseline", entry));
        }
    }
    for (list, entry) in file_entries {
        let CapturedEntry::File {
            path,
            sha256,
            bytes,
            ..
        } = entry
        else {
            continue;
        };
        let first_reference = referenced.insert(sha256.as_str());
        let blob = blobs_dir.join(sha256);
        let metadata = std::fs::symlink_metadata(&blob).map_err(|error| {
            reject(format!(
                "missing blob {sha256} for {list} {path:?}: {error}"
            ))
        })?;
        if !metadata.is_file() {
            return Err(reject(format!("blob {sha256} is not a regular file")));
        }
        // Every entry's size claim is checked against the blob; the
        // expensive content hash runs once per digest — a manifest that
        // shares one blob across many paths cannot amplify it into a
        // re-hash per path.
        if metadata.len() != *bytes {
            return Err(reject(format!(
                "blob {sha256} for {list} {path:?} is {} bytes, manifest says {bytes}",
                metadata.len()
            )));
        }
        if !first_reference {
            continue;
        }
        let mut blob = std::fs::File::open(&blob)
            .map_err(|error| reject(format!("unreadable blob {sha256}: {error}")))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 128 * 1024];
        loop {
            let read = std::io::Read::read(&mut blob, &mut buffer)
                .map_err(|error| reject(format!("unreadable blob {sha256}: {error}")))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        let digest = format!("{:x}", hasher.finalize());
        if digest != *sha256 {
            return Err(reject(format!(
                "blob {sha256} for {list} {path:?} hashes to {digest}"
            )));
        }
    }
    let staged: HashSet<String> = std::fs::read_dir(&blobs_dir)
        .map_err(|error| reject(format!("unreadable blobs directory: {error}")))?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| reject(format!("unreadable blobs directory: {error}")))?;
    let referenced: HashSet<String> = referenced
        .iter()
        .map(|sha256| (*sha256).to_string())
        .collect();
    if let Some(unreferenced) = staged.difference(&referenced).next() {
        return Err(reject(format!("unreferenced blob {unreferenced}")));
    }
    if let Some(missing) = referenced.difference(&staged).next() {
        return Err(reject(format!("missing blob {missing}")));
    }
    Ok(())
}

/// True for a `len`-character lowercase hex string (a git commit id or a
/// SHA-256 digest as the manifest writes them).
fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
