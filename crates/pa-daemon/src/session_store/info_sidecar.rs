//! The persisted scan-state sidecar: `<stem>.info-cache.json`, written
//! beside the session file when the runtime lease is released and loaded
//! on a process-cache miss, so a warm resume folds only the appended tail
//! instead of rescanning the whole file. pa-daemon owns the sidecar:
//! the scan state is this crate's type, and it certifies differently from
//! pa-core's window snapshot (an exact generation there, a grown-file
//! resume with a prefix check here). Only the lease holder writes (the
//! worker at release); every reader loads.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::info::{session_info_cache, SessionScanState};

/// The sidecar format version: a sidecar serves only at exactly this
/// version; any other version (an older or a newer build's) is a cold
/// scan, the behavior without a sidecar. Bump on any change to
/// [`SessionScanAccumulator`](super::info::SessionScanAccumulator) or
/// [`UsageScan`](crate::session_usage::UsageScan) - the persisted fold's
/// fields or semantics.
const INFO_SIDECAR_VERSION: u32 = 1;

/// The on-disk envelope: the version gate plus the scan state.
#[derive(Serialize, Deserialize)]
struct InfoSidecar {
    version: u32,
    state: SessionScanState,
}

fn sidecar_path(path: &Path) -> PathBuf {
    path.with_extension("info-cache.json")
}

/// Load the persisted scan state for `path`: `None` on any failure - a
/// missing sidecar, an unparsable one, or a version this build does not
/// serve - so the caller scans cold, exactly as it does without one.
#[must_use]
pub(super) fn load(path: &Path) -> Option<SessionScanState> {
    let data = std::fs::read(sidecar_path(path)).ok()?;
    let sidecar: InfoSidecar = serde_json::from_slice(&data).ok()?;
    (sidecar.version == INFO_SIDECAR_VERSION).then_some(sidecar.state)
}

/// The lease-release write: persist the cached scan state for `path` (the
/// path form the lease holder opened and read the file by - the scan
/// cache's key, and the form the load derives the sidecar path from) so
/// the next process that opens the file folds only what was appended
/// since. A fresh temp file, then the rename - a torn write never
/// replaces a loadable sidecar, and a reader that races the rename sees
/// either the old or the new whole file. A miss writes nothing; a failed
/// write costs the next open its warm resume, nothing more - the same
/// error policy as the window sidecar's flush.
pub(crate) fn persist_info_sidecar(path: &Path) {
    let Some(state) = session_info_cache().lock().ok().and_then(|cache| {
        cache
            .states
            .get(path)
            .map(SessionScanState::clone_for_resume)
    }) else {
        return;
    };
    let temp = path.with_extension(format!("info-cache-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        // Buffered: the serialized state is megabytes of small map
        // entries, and an unbuffered file writer would turn every
        // serialized fragment into its own write syscall.
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        // The sidecar carries message text (the search corpus, the first
        // message): the temp is owner-only like the session files
        // (`persist.rs`'s writer), and the rename carries the mode onto
        // the sidecar.
        pa_core::platform::perms::set_private_mode(&mut options);
        let mut file = io::BufWriter::new(options.open(&temp)?);
        serde_json::to_writer(
            &mut file,
            &InfoSidecar {
                version: INFO_SIDECAR_VERSION,
                state,
            },
        )?;
        file.flush()?;
        pa_core::platform::rename_onto(&temp, &sidecar_path(path))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
}
