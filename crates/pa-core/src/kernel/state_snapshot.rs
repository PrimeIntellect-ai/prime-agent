//! Locations and result shapes for the kernel's persisted user namespace, revived on session
//! resume. Snapshotting is best-effort and per-variable: a single unpicklable object is skipped and
//! reported, never aborting the whole snapshot.

use std::path::{Path, PathBuf};

/// Default ceiling on a snapshot payload. Over-cap variables are skipped + reported.
pub const DEFAULT_SNAPSHOT_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Default ceiling for one serialized variable.
pub const DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES: u64 = 16 * 1024 * 1024;

const KERNEL_STATE_BASENAME: &str = "kernel-state";

/// One name that could not be serialized, with a short reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotSkip {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SnapshotResult {
    /// Top-level names successfully serialized into the payload.
    pub saved: Vec<String>,
    /// Names that could not be serialized, with a short reason.
    pub skipped: Vec<SnapshotSkip>,
    /// Oversized live variables removed by an explicit compaction snapshot.
    pub pruned: Option<Vec<String>>,
    /// Payload size on disk, in bytes.
    pub bytes: u64,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoreResult {
    /// Names successfully revived into the kernel namespace.
    pub restored: Vec<String>,
    /// Names present in the snapshot that failed to revive, with a short reason.
    pub failed: Vec<SnapshotSkip>,
    pub path: PathBuf,
}

/// Absolute path to the dill payload within a session's artifact directory.
pub fn snapshot_path_in(artifact_dir: impl AsRef<Path>) -> PathBuf {
    artifact_dir
        .as_ref()
        .join(format!("{KERNEL_STATE_BASENAME}.dill"))
}

/// Absolute path to the JSON manifest within a session's artifact directory.
pub fn manifest_path_in(artifact_dir: impl AsRef<Path>) -> PathBuf {
    artifact_dir
        .as_ref()
        .join(format!("{KERNEL_STATE_BASENAME}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_match_ts_layout() {
        assert_eq!(
            snapshot_path_in("/tmp/art"),
            PathBuf::from("/tmp/art/kernel-state.dill")
        );
        assert_eq!(
            manifest_path_in("/tmp/art"),
            PathBuf::from("/tmp/art/kernel-state.json")
        );
    }
}
