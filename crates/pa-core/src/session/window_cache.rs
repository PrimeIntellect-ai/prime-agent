//! Disposable, generation-certified session window snapshots.
use super::window::{WindowReadStats, WindowStats};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, Metadata};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Generation {
    len: u64,
    dev: u64,
    ino: u64,
    mtime: i64,
    mtime_ns: i64,
    ctime: i64,
    ctime_ns: i64,
}
impl Generation {
    #[cfg(unix)]
    pub(super) fn of(meta: &Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            len: meta.len(),
            dev: meta.dev(),
            ino: meta.ino(),
            mtime: meta.mtime(),
            mtime_ns: meta.mtime_nsec(),
            ctime: meta.ctime(),
            ctime_ns: meta.ctime_nsec(),
        }
    }
    #[cfg(not(unix))]
    pub(super) fn of(meta: &Metadata) -> Self {
        Self {
            len: meta.len(),
            dev: 0,
            ino: 0,
            mtime: 0,
            mtime_ns: 0,
            ctime: 0,
            ctime_ns: 0,
        }
    }
    pub(super) fn valid(&self, file: &File, path: &Path) -> io::Result<bool> {
        Ok(cfg!(unix)
            && *self == Self::of(&file.metadata()?)
            && *self == Self::of(&std::fs::metadata(path)?))
    }
}
/// The snapshot format version. 5: `WindowStats` gained
/// `summarization_cost` (v4 sidecars deserialize it as zero and
/// undercount the discarded prefix's summarizer bill — they must not
/// serve). 4: the older-path stats fold child usage attributions (v3
/// sidecars carry pre-fold totals and must not serve).
pub(super) const SNAPSHOT_VERSION: u32 = 6;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Snapshot {
    pub version: u32,
    pub generation: Generation,
    pub header: String,
    pub start: u64,
    pub leaf: String,
    pub thinking: String,
    pub thinking_present: bool,
    pub tier: Option<pa_types::ai::ServiceTier>,
    pub tier_present: bool,
    pub model: Option<(String, String)>,
    pub boundary_model: Option<(String, String)>,
    pub metadata: Vec<String>,
    pub message_count: usize,
    pub compaction_count: usize,
    pub stats: WindowStats,
    pub first_user: Option<serde_json::Value>,
    pub goal: Option<crate::goals::GoalState>,
    pub non_bootstrap: bool,
}
fn cache_path(path: &Path) -> PathBuf {
    path.with_extension("window-cache.json")
}

fn live_snapshots() -> &'static Mutex<HashMap<PathBuf, Snapshot>> {
    static SNAPSHOTS: OnceLock<Mutex<HashMap<PathBuf, Snapshot>>> = OnceLock::new();
    SNAPSHOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn load(path: &Path, file: &File, stats: &mut WindowReadStats) -> Option<Snapshot> {
    // Clone out of the guard before the staleness check: the `if let`
    // scrutinee guard would live through the block and self-deadlock on
    // the eviction re-lock.
    let live = live_snapshots().lock().ok()?.get(path).cloned();
    if let Some(snapshot) = live {
        if snapshot.version == SNAPSHOT_VERSION && snapshot.generation.valid(file, path).ok()? {
            stats.cache_bytes += serde_json::to_vec(&snapshot).ok()?.len() as u64;
            return Some(snapshot);
        }
        live_snapshots().lock().ok()?.remove(path);
    }
    let data = std::fs::read(cache_path(path)).ok()?;
    stats.cache_bytes += data.len() as u64;
    let snapshot: Snapshot = serde_json::from_slice(&data).ok()?;
    if snapshot.version != SNAPSHOT_VERSION || !snapshot.generation.valid(file, path).ok()? {
        return None;
    }
    live_snapshots()
        .lock()
        .ok()?
        .insert(path.to_owned(), snapshot.clone());
    Some(snapshot)
}
/// Drop the in-process snapshot so a test exercises the on-disk sidecar.
#[cfg(test)]
pub(super) fn evict_live_snapshot(path: &Path) {
    if let Ok(mut snapshots) = live_snapshots().lock() {
        snapshots.remove(path);
    }
}

pub(super) fn save(path: &Path, snapshot: &Snapshot) -> io::Result<()> {
    let temp = path.with_extension(format!("window-cache-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        // One buffered flush instead of one write per serialized fragment:
        // the sidecar is disposable, but the syscall storm (hundreds of
        // single-byte writes per open) showed up on the cold-open path.
        let mut writer = std::io::BufWriter::new(file);
        serde_json::to_writer(&mut writer, snapshot)?;
        writer.flush()?;
        std::fs::rename(&temp, cache_path(path))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    } else if let Ok(mut snapshots) = live_snapshots().lock() {
        snapshots.insert(path.to_owned(), snapshot.clone());
    }
    result
}

/// Persist the live certified snapshot for `path` to the sidecar cache.
///
/// # Errors
///
/// Returns the sidecar write error when a live snapshot exists and saving
/// it fails; a path without a live snapshot succeeds without touching the
/// disk.
pub fn flush(path: &Path) -> io::Result<()> {
    let snapshot = live_snapshots()
        .lock()
        .ok()
        .and_then(|snapshots| snapshots.get(path).cloned());
    match snapshot {
        Some(snapshot) => save(path, &snapshot),
        None => Ok(()),
    }
}
/// Ownership required before extending a certified session snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppendOwnership {
    /// Caller retains the canonical session's exclusive runtime lease through
    /// this entire call. Noncooperative external writes are unsupported.
    SessionLeaseHeld,
    /// No runtime lease: append without publishing an incremental snapshot.
    Unleased,
}
/// Cached append-mode session descriptors (unix only): durable appends
/// reuse one open file per path instead of paying open+close per row.
/// Write and `fdatasync` still run on every append, so on-disk bytes and
/// crash-safety are unchanged.
fn append_handles() -> &'static Mutex<HashMap<PathBuf, std::sync::Arc<Mutex<File>>>> {
    static HANDLES: OnceLock<Mutex<HashMap<PathBuf, std::sync::Arc<Mutex<File>>>>> =
        OnceLock::new();
    HANDLES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Open (or reuse) the append descriptor for `path`.
///
/// # Errors
///
/// Surfaces the open error unchanged: the first append to a missing file
/// fails exactly as a per-call open would.
#[cfg(unix)]
fn cached_append_handle(path: &Path) -> io::Result<std::sync::Arc<Mutex<File>>> {
    let mut handles = append_handles()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(handle) = handles.get(path) {
        return Ok(std::sync::Arc::clone(handle));
    }
    let file = std::fs::OpenOptions::new().append(true).open(path)?;
    let handle = std::sync::Arc::new(Mutex::new(file));
    handles.insert(path.to_owned(), std::sync::Arc::clone(&handle));
    Ok(handle)
}

/// Drop `path`'s cached append descriptor (if any): the next append
/// reopens by path. Every in-process replace or removal of a session file
/// must invalidate here so appends land on the file that exists now, not
/// an unlinked inode.
pub fn invalidate_cached_append(path: &Path) {
    if let Ok(mut handles) = append_handles().lock() {
        handles.remove(path);
    }
}

/// True when the descriptor's file was replaced (rename onto the path) or
/// unlinked: POSIX drops the old inode's link count to zero, so one cheap
/// fstat detects a stale descriptor cross-process.
#[cfg(unix)]
fn handle_unlinked(file: &File) -> bool {
    use std::os::unix::fs::MetadataExt;
    file.metadata().map(|meta| meta.nlink() == 0).unwrap_or(true)
}

/// Append authoritative JSONL bytes. Only a caller holding the existing session
/// lease may incrementally certify the cache. Rows must have fresh writer IDs.
/// Cache failures never fail a successful durable append.
///
/// # Errors
///
/// Returns the underlying I/O error while performing the durable append
/// itself (open, write, flush, sync); a failed incremental cache
/// certification is dropped, not surfaced.
pub fn append_cached(path: &Path, bytes: &[u8], ownership: AppendOwnership) -> io::Result<()> {
    #[cfg(unix)]
    {
        // One bounded reopen pass when the cached descriptor went stale
        // (the file was replaced or unlinked since the last append); the
        // append then lands on the file that exists now, as a per-call
        // open always did.
        for _ in 0..2 {
            let handle = cached_append_handle(path)?;
            let mut file = handle
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !handle_unlinked(&file) {
                return append_with(&mut file, path, bytes, ownership);
            }
            drop(file);
            invalidate_cached_append(path);
        }
    }
    let mut file = std::fs::OpenOptions::new().append(true).open(path)?;
    append_with(&mut file, path, bytes, ownership)
}

/// Write-and-sync over an already-open append descriptor, then run the
/// incremental snapshot certification.
///
/// # Errors
///
/// Surfaces the write or `fdatasync` error (a failed write also drops the
/// cached descriptor so the next append reopens); a failed incremental
/// cache certification is dropped, not surfaced.
fn append_with(
    file: &mut File,
    path: &Path,
    bytes: &[u8],
    ownership: AppendOwnership,
) -> io::Result<()> {
    let written = (|| -> io::Result<()> {
        file.write_all(bytes)?;
        file.sync_data()
    })();
    if let Err(error) = written {
        #[cfg(unix)]
        invalidate_cached_append(path);
        return Err(error);
    }
    if ownership != AppendOwnership::SessionLeaseHeld || !bytes.ends_with(b"\n") {
        if let Ok(mut snapshots) = live_snapshots().lock() {
            snapshots.remove(path);
        }
        return Ok(());
    }
    let generation = Generation::of(&file.metadata()?);
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Ok(());
    };
    let Ok(mut snapshots) = live_snapshots().lock() else {
        return Ok(());
    };
    let Some(snapshot) = snapshots.get_mut(path) else {
        return Ok(());
    };
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<pa_types::session::FileEntry>(line) else {
            snapshots.remove(path);
            return Ok(());
        };
        if entry.parent_id() != Some(snapshot.leaf.as_str())
            || matches!(
                entry,
                pa_types::session::FileEntry::Compaction { .. }
                    | pa_types::session::FileEntry::ChildUsageAttributed { .. }
            )
        {
            snapshots.remove(path);
            return Ok(());
        }
        let Some(id) = entry.id() else {
            snapshots.remove(path);
            return Ok(());
        };
        if id == snapshot.leaf {
            snapshots.remove(path);
            return Ok(());
        }
        id.clone_into(&mut snapshot.leaf);
        super::window::update_snapshot(snapshot, &entry);
    }
    snapshot.generation = generation;
    Ok(())
}

// JSON decimal parsing need not round-trip every IEEE value. The subtotal must
// retain its bits so continuing chronological additions matches the full reader.
pub(super) mod float_bits {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(value.to_bits())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
        u64::deserialize(deserializer).map(f64::from_bits)
    }
}
