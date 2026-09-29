//! Offline verification of a staged snapshot: every manifest claim is
//! checked against the staged blobs and the blob set against the
//! manifest, so an incomplete or tampered staging area fails loudly
//! before it is uploaded anywhere.

use std::collections::HashSet;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::manifest::{
    is_safe_relative_path, symlink_target_stays_inside, CapturedEntry, SnapshotManifest, BLOBS_DIR,
    MANIFEST_FILE, MANIFEST_VERSION,
};
use super::SnapshotError;

/// The length of a git commit id.
const COMMIT_HEX_LEN: usize = 40;

/// The length of a SHA-256 digest.
const DIGEST_HEX_LEN: usize = 64;

/// Verify a staged snapshot: parse the manifest, re-hash every blob, and
/// reject unreferenced or missing blobs. Returns the verified manifest.
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
    verify_blobs(staging_dir, &manifest)?;
    Ok(manifest)
}

fn read_manifest(path: &Path) -> Result<SnapshotManifest, SnapshotError> {
    let reject = |detail: String| SnapshotError::Manifest {
        path: path.to_path_buf(),
        detail,
    };
    let bytes = std::fs::read(path).map_err(|error| reject(format!("unreadable: {error}")))?;
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

/// Structural checks: safe and strictly path-sorted (hence duplicate-free)
/// entry lists, well-formed digests, and in-root symlink targets.
fn verify_structure(staging_dir: &Path, manifest: &SnapshotManifest) -> Result<(), SnapshotError> {
    let reject = |detail: String| SnapshotError::Verification {
        staging_dir: staging_dir.to_path_buf(),
        detail,
    };
    if let Some(head) = &manifest.head_commit {
        if !is_lower_hex(head, COMMIT_HEX_LEN) {
            return Err(reject(format!("malformed head commit {head:?}")));
        }
    }
    let mut previous: Option<&str> = None;
    for entry in &manifest.captured {
        let path = entry.path();
        if !is_safe_relative_path(path) {
            return Err(reject(format!("unsafe captured path {path:?}")));
        }
        if previous.is_some_and(|prior| prior >= path) {
            return Err(reject(format!(
                "captured entries out of order or duplicated at {path:?}"
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
                    return Err(reject(format!("symlink at {path:?} escapes the worktree")));
                }
            }
            CapturedEntry::Deleted { .. } => {}
        }
    }
    let mut previous: Option<&str> = None;
    for entry in &manifest.excluded {
        if !is_safe_relative_path(&entry.path) {
            return Err(reject(format!("unsafe excluded path {:?}", entry.path)));
        }
        if previous.is_some_and(|prior| prior >= entry.path.as_str()) {
            return Err(reject(format!(
                "excluded entries out of order or duplicated at {:?}",
                entry.path
            )));
        }
        previous = Some(entry.path.as_str());
    }
    Ok(())
}

/// Content checks: every file entry's blob exists with the recorded size
/// and hash, and the blob directory holds nothing unreferenced.
fn verify_blobs(staging_dir: &Path, manifest: &SnapshotManifest) -> Result<(), SnapshotError> {
    let reject = |detail: String| SnapshotError::Verification {
        staging_dir: staging_dir.to_path_buf(),
        detail,
    };
    let blobs_dir = staging_dir.join(BLOBS_DIR);
    let mut referenced: HashSet<&str> = HashSet::new();
    for entry in &manifest.captured {
        let CapturedEntry::File {
            path,
            sha256,
            bytes,
            ..
        } = entry
        else {
            continue;
        };
        referenced.insert(sha256.as_str());
        let blob = blobs_dir.join(sha256);
        let metadata = std::fs::symlink_metadata(&blob)
            .map_err(|error| reject(format!("missing blob {sha256} for {path:?}: {error}")))?;
        if !metadata.is_file() {
            return Err(reject(format!("blob {sha256} is not a regular file")));
        }
        if metadata.len() != *bytes {
            return Err(reject(format!(
                "blob {sha256} for {path:?} is {} bytes, manifest says {bytes}",
                metadata.len()
            )));
        }
        let content = std::fs::read(&blob)
            .map_err(|error| reject(format!("unreadable blob {sha256}: {error}")))?;
        let digest = format!("{:x}", Sha256::digest(&content));
        if digest != *sha256 {
            return Err(reject(format!(
                "blob {sha256} for {path:?} hashes to {digest}"
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
