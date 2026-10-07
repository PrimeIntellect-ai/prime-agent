//! Plain-fsync durability for append-only row writes.

use std::fs::File;
use std::io;
use std::path::Path;

/// fsync a directory so a completed rename survives a crash.
///
/// # Errors
///
/// Returns an error when the directory cannot be opened or synced.
pub fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

/// Flush one file's written bytes with a plain `fsync(2)`; std's
/// `sync_data`/`sync_all` take the `F_FULLFSYNC` barrier on Apple.
///
/// # Errors
///
/// Returns the OS error when the sync fails.
#[cfg(unix)]
pub fn fsync(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    nix::unistd::fsync(file.as_raw_fd()).map_err(io::Error::from)
}

/// # Errors
///
/// Returns the underlying I/O error when the sync fails.
#[cfg(not(unix))]
pub fn fsync(file: &File) -> io::Result<()> {
    file.sync_data()
}
