//! Directory-entry durability for wholesale session-file replaces: the
//! rename that lands a rewritten session file must itself be durable, or
//! a hard crash can drop the whole file even though its bytes were
//! synced before the rename. The strict terminal-notice append (the
//! in-process RLM child host's durability strengthening) fsyncs the
//! containing directory after every create/replace rename; the TS
//! product instead tolerates this class through repair-on-open.

use std::fs;
use std::io;
use std::path::Path;

/// Flush a directory entry to stable storage (POSIX `fsync` on a
/// directory fd, which std opens read-only).
///
/// # Errors
///
/// Returns the underlying error when the directory cannot be opened or
/// synced.
#[cfg(unix)]
pub fn sync_dir(dir: &Path) -> io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

/// Windows: no std path opens a directory handle, and the TS product
/// promises no directory fsync on any platform - the port's win32
/// durability story stays the atomic-write + rename-retry contract, and
/// this strengthening is Unix-only (disclosed like the atomic-write
/// audit instead of silently pretending parity).
#[cfg(not(unix))]
#[allow(clippy::unnecessary_wraps)]
pub fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}
