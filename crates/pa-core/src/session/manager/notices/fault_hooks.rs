//! Test-build fault injection for the strict notice append: faults are
//! armed per session file (parallel tests on separate files never
//! cross-talk), each armed fault fires a fixed number of times before
//! disarming (fail-once with `times = 1`), and an injected fault
//! produces EXACTLY the on-disk state a real failure at that stage
//! leaves, so the reconcile/idempotence machinery under test behaves
//! identically.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One injectable stage of the strict durable append.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Fault {
    /// A torn mid-write: a partial line prefix lands unsynced.
    PartialPrewrite,
    /// The complete line lands unsynced, then the sync fails.
    SyncFail,
    /// The wholesale rewrite lands (temp + `sync_all` + rename),
    /// then the containing-directory fsync fails.
    DirFsyncFail,
    /// An existing-file append lands (complete line + file sync) and
    /// the row is indexed, then the containing-directory fsync fails:
    /// success is withheld pending the sync and the idempotent retry
    /// re-syncs the existing row.
    AppendDirSyncFail,
}

#[derive(Default)]
struct Armed {
    partial_prewrite: usize,
    sync_fail: usize,
    dir_fsync_fail: usize,
    append_dir_sync_fail: usize,
}

impl Armed {
    fn slot(&mut self, fault: Fault) -> &mut usize {
        match fault {
            Fault::PartialPrewrite => &mut self.partial_prewrite,
            Fault::SyncFail => &mut self.sync_fail,
            Fault::DirFsyncFail => &mut self.dir_fsync_fail,
            Fault::AppendDirSyncFail => &mut self.append_dir_sync_fail,
        }
    }
}

static ARMED: Mutex<Option<HashMap<PathBuf, Armed>>> = Mutex::new(None);

/// Arm `fault` to fire `times` more times for the session at
/// `session_file`.
pub fn arm(session_file: &Path, fault: Fault, times: usize) {
    let mut armed = ARMED.lock().unwrap();
    let state = armed
        .get_or_insert_with(HashMap::new)
        .entry(session_file.to_path_buf())
        .or_default();
    *state.slot(fault) += times;
}

/// Consume one firing of `fault` for the session at `session_file`.
pub fn take(session_file: &Path, fault: Fault) -> bool {
    let mut armed = ARMED.lock().unwrap();
    let Some(by_path) = armed.as_mut() else {
        return false;
    };
    match by_path.get_mut(session_file) {
        Some(state) => {
            let slot = state.slot(fault);
            if *slot == 0 {
                return false;
            }
            *slot -= 1;
            true
        }
        None => false,
    }
}

/// Disarm every fault armed for the session at `session_file`.
pub fn disarm(session_file: &Path) {
    let mut armed = ARMED.lock().unwrap();
    if let Some(by_path) = armed.as_mut() {
        by_path.remove(session_file);
    }
}

/// The error text an injected fault surfaces as.
pub fn injected_error() -> io::Error {
    io::Error::other("injected fault")
}

/// The single durable-line append, with the prewrite faults in
/// front of the real write: `Some(outcome)` when a fault fired
/// (its on-disk state already landed), `None` to run the real
/// append.
pub fn append_with_fault(session_file: &Path, line: &[u8]) -> Option<io::Result<()>> {
    if take(session_file, Fault::PartialPrewrite) {
        let prefix = &line[..(line.len() / 2).max(1)];
        let outcome = (|| {
            let mut file = OpenOptions::new().append(true).open(session_file)?;
            file.write_all(prefix)?;
            Err(injected_error())
        })();
        return Some(outcome);
    }
    if take(session_file, Fault::SyncFail) {
        let outcome = (|| {
            let mut file = OpenOptions::new().append(true).open(session_file)?;
            file.write_all(line)?;
            Err(injected_error())
        })();
        return Some(outcome);
    }
    None
}
