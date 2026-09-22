//! Rename-onto-destination with a bounded Windows retry.
//!
//! Windows raises transient EPERM/EACCES/EBUSY when the destination of a
//! rename is held open (antivirus, search indexer) and the underlying
//! `MoveFileExW(REPLACE_EXISTING)` fails. Every durable persist write
//! (temp file + rename onto the destination) retries that failure class a
//! bounded number of times before surfacing the error, matching the TS
//! product where `writeFileAtomicSync` wraps every durable write. Unix
//! renames never see this failure mode - EPERM/EACCES there are real
//! permission problems - so the retry never fires off Windows.
//!
//! This crate sits at the bottom of the workspace dependency graph and
//! every persist owner (pa-telemetry's install id, pa-core's settings and
//! session persists, pa-daemon's descriptors/journals/session store)
//! already depends on it, so the shared primitive lives here; pa-core
//! re-exports it as `platform::rename_onto` so its platform wall stays the
//! engine's single platform entry.

use std::fs;
use std::io;
use std::path::Path;
use std::thread;
use std::time::Duration;

/// Total attempts before a transient rename failure surfaces
/// (TS `WIN32_RENAME_ATTEMPTS`).
const WIN32_RENAME_ATTEMPTS: u32 = 5;

/// Destination-busy failure classes that deserve a retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RenameFailure {
    /// The access-denied family: std decodes it to `PermissionDenied`
    /// (libuv surfaces the same codes as EPERM/EACCES).
    AccessDenied,
    /// The destination is held with sharing restrictions: libuv EBUSY.
    Busy,
    /// Any other failure: surface immediately.
    Fatal,
}

/// Whether a failed rename deserves another attempt on the given platform,
/// and how long to wait first (`10ms * attempt`). `None` means the error
/// surfaces. Attempts are 1-based; the cap allows `WIN32_RENAME_ATTEMPTS`
/// total rename tries.
pub(crate) fn retry_delay_ms(
    platform_windows: bool,
    failure: RenameFailure,
    attempt: u32,
) -> Option<u64> {
    if !platform_windows || failure == RenameFailure::Fatal || attempt >= WIN32_RENAME_ATTEMPTS {
        return None;
    }
    Some(10 * u64::from(attempt))
}

/// Classify a rename failure by its decoded kind and raw OS error code.
/// Like TS `renameOntoSync` (which decodes the errno on every platform),
/// classification runs everywhere; `retry_delay_ms` is what gates it to
/// win32, so Unix EPERM/EACCES still surface immediately there.
fn classify_kind(kind: io::ErrorKind, raw_os_error: Option<i32>) -> RenameFailure {
    // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION (libuv EBUSY) stay
    // raw in std; everything else access-related decodes to
    // PermissionDenied.
    if matches!(raw_os_error, Some(32) | Some(33)) {
        return RenameFailure::Busy;
    }
    if kind == io::ErrorKind::PermissionDenied {
        return RenameFailure::AccessDenied;
    }
    RenameFailure::Fatal
}

fn classify(error: &io::Error) -> RenameFailure {
    classify_kind(error.kind(), error.raw_os_error())
}

/// Rename `from` onto `to`, replacing an existing destination.
///
/// On Windows, retries destination-busy failures (EPERM/EACCES/EBUSY) up to
/// [`WIN32_RENAME_ATTEMPTS`] total attempts with a `10ms * attempt` backoff;
/// every other failure - and every failure on Unix - surfaces immediately.
pub fn rename_onto(from: &Path, to: &Path) -> io::Result<()> {
    let platform_windows = cfg!(windows);
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => match retry_delay_ms(platform_windows, classify(&error), attempt) {
                Some(delay) => {
                    thread::sleep(Duration::from_millis(delay));
                    attempt += 1;
                }
                None => return Err(error),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win32_retries_busy_failures_with_linear_backoff_until_cap() {
        for failure in [RenameFailure::AccessDenied, RenameFailure::Busy] {
            for attempt in 1..WIN32_RENAME_ATTEMPTS {
                assert_eq!(
                    retry_delay_ms(true, failure, attempt),
                    Some(10 * u64::from(attempt)),
                    "failure={failure:?} attempt={attempt}"
                );
            }
            assert_eq!(
                retry_delay_ms(true, failure, WIN32_RENAME_ATTEMPTS),
                None,
                "failure={failure:?}"
            );
            assert_eq!(
                retry_delay_ms(true, failure, WIN32_RENAME_ATTEMPTS + 3),
                None,
                "failure={failure:?}"
            );
        }
    }

    #[test]
    fn unix_and_fatal_failures_never_retry() {
        for failure in [
            RenameFailure::AccessDenied,
            RenameFailure::Busy,
            RenameFailure::Fatal,
        ] {
            for attempt in 1..=WIN32_RENAME_ATTEMPTS {
                assert_eq!(
                    retry_delay_ms(false, failure, attempt),
                    None,
                    "failure={failure:?} attempt={attempt}"
                );
            }
        }
        for attempt in 1..=WIN32_RENAME_ATTEMPTS {
            assert_eq!(retry_delay_ms(true, RenameFailure::Fatal, attempt), None);
        }
    }

    #[test]
    fn rename_onto_replaces_destination() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from.json");
        let to = dir.path().join("to.json");
        std::fs::write(&from, b"next").unwrap();
        std::fs::write(&to, b"previous").unwrap();
        rename_onto(&from, &to).unwrap();
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "next");
        assert!(!from.exists());
    }

    #[test]
    fn rename_onto_missing_source_surfaces_the_error() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("missing");
        let to = dir.path().join("to.json");
        let error = rename_onto(&from, &to).expect_err("rename of a missing source must fail");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn classification_marks_only_the_win32_busy_family_transient() {
        use io::ErrorKind;
        // The access-denied family (libuv EPERM/EACCES).
        assert_eq!(
            classify_kind(ErrorKind::PermissionDenied, None),
            RenameFailure::AccessDenied
        );
        // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION (libuv EBUSY);
        // the raw code wins over the decoded kind.
        assert_eq!(
            classify_kind(ErrorKind::Other, Some(32)),
            RenameFailure::Busy
        );
        assert_eq!(
            classify_kind(ErrorKind::Other, Some(33)),
            RenameFailure::Busy
        );
        assert_eq!(
            classify_kind(ErrorKind::PermissionDenied, Some(32)),
            RenameFailure::Busy
        );
        // Everything else is fatal.
        assert_eq!(
            classify_kind(ErrorKind::NotFound, None),
            RenameFailure::Fatal
        );
        assert_eq!(
            classify_kind(ErrorKind::Other, Some(5)),
            RenameFailure::Fatal
        );
    }

    #[test]
    #[cfg(unix)]
    fn unix_surfaces_real_permission_failures() {
        // Classification runs on every platform like TS `renameOntoSync`
        // (which decodes the errno before the win32 check); the platform
        // gate is what stops a Unix EACCES from ever retrying.
        let denied = io::Error::from_raw_os_error(13); // EACCES
        assert_eq!(classify(&denied), RenameFailure::AccessDenied);
        assert_eq!(retry_delay_ms(false, classify(&denied), 1), None);
    }
}
