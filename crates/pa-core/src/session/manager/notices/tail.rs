//! The durable-tail half of the strict notice append: file/truncation
//! sync, pre-append tail hygiene (an earlier failed write's partial
//! line must not splice onto the next append), and the post-failure
//! reconcile against the stable serialized line and the prior offset -
//! truncate a partial prefix, re-sync a fully landed line, or surface
//! an unrecognizable tail for the caller to poison the writer.

use std::fs::OpenOptions;
use std::io::{self, ErrorKind, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;

/// A torn-tail reverse scan never reads more than the repair suspicion
/// window (`manager::repair` keeps the same bound).
const TAIL_SCAN_WINDOW_BYTES: usize = 1024 * 1024;

/// The error a poisoned writer fails fast with (the stored repair
/// failure, reconstructed - `io::Error` is not `Clone`).
pub(super) fn poisoned_error(poison: &Arc<io::Error>) -> io::Error {
    io::Error::new(poison.kind(), poison.to_string())
}

/// Flush a session file's already-landed bytes to stable storage.
///
/// # Errors
///
/// Returns the underlying error when the file cannot be opened or
/// synced.
pub(super) fn sync_file(path: &Path) -> io::Result<()> {
    let file = OpenOptions::new().append(true).open(path)?;
    file.sync_data()
}

/// Truncate a file to `len` and sync the truncation.
///
/// # Errors
///
/// Returns the underlying error when the file cannot be opened,
/// truncated, or synced.
pub(super) fn truncate_and_sync(path: &Path, len: u64) -> io::Result<()> {
    let file = OpenOptions::new().write(true).open(path)?;
    file.set_len(len)?;
    file.sync_all()
}

/// Confirm the file ends on a complete line before an append: a torn
/// tail left by an earlier failed write would splice the next line onto
/// garbage. A partial tail is truncated back to the last complete line;
/// a tail with no complete line at all is surfaced (open-time repair
/// owns that damage). Returns the confirmed clean length.
///
/// # Errors
///
/// Returns the underlying I/O error when the file cannot be read or
/// repaired, or [`ErrorKind::InvalidData`] when no complete line
/// precedes the torn tail.
pub(super) fn ensure_clean_tail(path: &Path) -> io::Result<u64> {
    let len = std::fs::metadata(path)?.len();
    if len == 0 {
        return Ok(0);
    }
    let mut file = std::fs::File::open(path)?;
    let mut last = [0_u8; 1];
    file.seek(SeekFrom::Start(len - 1))?;
    file.read_exact(&mut last)?;
    if last[0] == b'\n' {
        return Ok(len);
    }
    let window = (len as usize).min(TAIL_SCAN_WINDOW_BYTES);
    let mut buffer = vec![0_u8; window];
    file.seek(SeekFrom::Start(len - window as u64))?;
    file.read_exact(&mut buffer)?;
    let Some(position) = buffer.iter().rposition(|byte| *byte == b'\n') else {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "no complete line precedes the torn session tail",
        ));
    };
    let clean_len = len - (window as u64) + position as u64 + 1;
    truncate_and_sync(path, clean_len)?;
    Ok(clean_len)
}

/// What a failed append left behind, after reconciliation.
#[derive(Debug)]
pub(super) enum ReconciledTail {
    /// The complete line landed despite the error; a re-sync confirmed
    /// it - the row is durable, nothing to rewrite.
    Complete,
    /// Nothing of this line survived (a partial prefix was truncated
    /// and synced away) - safe to retry the same line.
    Truncated,
}

/// Reconcile the raw tail after a failed single-line append against the
/// stable serialized line and the prior offset: a fully landed line is
/// re-synced, a partial prefix is truncated back to the prior offset,
/// and anything else (a shrunken or unrecognizable tail) is surfaced for
/// the caller to poison the writer.
///
/// # Errors
///
/// Returns the underlying I/O error when the tail cannot be read,
/// truncated, or re-synced, or [`ErrorKind::InvalidData`] when the tail
/// matches neither the line nor a prefix of it.
pub(super) fn reconcile_tail(
    path: &Path,
    prior_len: u64,
    line: &[u8],
) -> io::Result<ReconciledTail> {
    let len = std::fs::metadata(path).map_or(0, |metadata| metadata.len());
    if len < prior_len {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "session tail shrank below the prior offset",
        ));
    }
    if len == prior_len {
        return Ok(ReconciledTail::Truncated);
    }
    let mut tail = vec![0_u8; (len - prior_len) as usize];
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(prior_len))?;
    file.read_exact(&mut tail)?;
    if tail.as_slice() == line {
        sync_file(path)?;
        return Ok(ReconciledTail::Complete);
    }
    if !tail.is_empty() && line.starts_with(&tail) {
        truncate_and_sync(path, prior_len)?;
        return Ok(ReconciledTail::Truncated);
    }
    Err(io::Error::new(
        ErrorKind::InvalidData,
        "unrecognizable session tail after a failed append",
    ))
}
