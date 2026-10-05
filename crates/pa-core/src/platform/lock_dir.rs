//! Cross-process directory locks, byte-compatible with the TS product's
//! `proper-lockfile` 4.1.2 convention.
//!
//! The TS product (auth.json, settings.json, cron state, session-lease
//! guards) locks a file by creating an EMPTY DIRECTORY at `{file}.lock`,
//! bumping its mtime, and removing the directory on release. Staleness is
//! judged from that mtime alone - there is no pid or owner file. A regular
//! file at the lock path is not a valid lock in this protocol; it is removed
//! on acquisition (older Rust builds left flock files there, which broke TS
//! startup with ENOTDIR).
//!
//! Held locks are expected to be short (read-modify-write of one small JSON
//! document); a long hold keeps the lock fresh via [`LockDir::refresh`] -
//! the port of the TS sync lock's unref'd update timer - and never removes
//! a lock whose inode changed hands ([`LockDir::release_when_owned`]; the
//! successor's own staleness sweep reclaims the abandoned artifact).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Minimum staleness threshold, like proper-lockfile's floor.
const MIN_STALE: Duration = Duration::from_secs(2);

/// The mtime bump proper-lockfile's precision probe writes: the next whole
/// second plus 5ms, so a millisecond-precision filesystem records a time
/// that is "not on the second".
fn probe_mtime() -> (i64, i64) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();
    let seconds = (now_ms + 999).div_euclid(1000);
    (seconds, 5_000_000)
}

// The `libc::timespec` field names are the syscall's own vocabulary -
// the struct-literal shorthand below is the point of the params.
#[allow(clippy::similar_names)]
#[cfg(unix)]
fn set_mtime(path: &Path, tv_sec: i64, tv_nsec: i64) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    // Lock paths come from agent-dir joins, but keep the NUL case an error
    // instead of truncating the path inside libc.
    let path_c = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let times = [
        libc::timespec { tv_sec, tv_nsec },
        libc::timespec { tv_sec, tv_nsec },
    ];
    // Relative lock paths (a relative agent dir) resolve against the
    // process cwd through AT_FDCWD.
    let result = unsafe { libc::utimensat(libc::AT_FDCWD, path_c.as_ptr(), times.as_ptr(), 0) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Windows: the directory's last-write time via `CreateFileW` (the only
/// way to open a directory is `FILE_FLAG_BACKUP_SEMANTICS`) +
/// `SetFileTime` - the mtime probe proper-lockfile performs with
/// `utimensat` on Unix.
// The `libc::timespec` field names are the syscall's own vocabulary -
// the struct-literal shorthand below is the point of the params.
#[allow(clippy::similar_names)]
#[cfg(windows)]
fn set_mtime(path: &Path, tv_sec: i64, tv_nsec: i64) -> io::Result<()> {
    win32::set_last_write_time(path, tv_sec, tv_nsec)
}

#[cfg(not(any(unix, windows)))]
fn set_mtime(_path: &Path, _tv_sec: i64, _tv_nsec: i64) -> io::Result<()> {
    Err(io::Error::other(
        "directory lock mtime probe is not implemented on this platform",
    ))
}

/// The kernel32 file-time surface for the lock probe, hand-declared (repo
/// policy: pinned constants/externs, no windows-sys dependency).
#[cfg(windows)]
mod win32 {
    #![allow(non_snake_case)]

    use std::ffi::c_void;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    /// `winbase.h`: required to open a directory handle.
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    /// `winbase.h`: write access to the file's times.
    const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
    /// `winnt.h` `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`:
    /// a concurrent stat of the lock dir must not be blocked.
    const FILE_SHARE_ALL: u32 = 0x0000_0007;
    /// `winbase.h` `OPEN_EXISTING`.
    const OPEN_EXISTING: u32 = 3;
    /// `winbase.h`: `CreateFileW` returns this (not null) on failure.
    const INVALID_HANDLE_VALUE: isize = -1;

    /// A Win32 `FILETIME`: 100ns ticks since 1601-01-01 UTC, split 32/32.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FileTime {
        dwLowDateTime: u32,
        dwHighDateTime: u32,
    }

    type Handle = *mut c_void;

    extern "system" {
        fn CreateFileW(
            filename: *const u16,
            desired_access: u32,
            share_mode: u32,
            security_attributes: *mut c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: Handle,
        ) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn SetFileTime(
            handle: Handle,
            creation_time: *const FileTime,
            last_access_time: *const FileTime,
            last_write_time: *const FileTime,
        ) -> i32;
    }

    /// `(tv_sec, tv_nsec)` -> FILETIME. The Windows epoch trails the Unix
    /// epoch by 11644473600 seconds; the sub-second part is nanoseconds
    /// against FILETIME's 100ns ticks.
    // `tv_sec`/`tv_nsec` are the POSIX timespec spellings the callers
    // pass through; the pair is the domain's own vocabulary.
    #[allow(clippy::similar_names)]
    fn unix_to_filetime(tv_sec: i64, tv_nsec: i64) -> FileTime {
        const EPOCH_DELTA_TICKS: i64 = 11_644_473_600 * 10_000_000;
        let ticks = tv_sec * 10_000_000 + EPOCH_DELTA_TICKS + tv_nsec / 100;
        FileTime {
            dwLowDateTime: ticks as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        }
    }

    /// Set the directory's last-write time. The `tv_sec`/`tv_nsec` pair
    /// is the POSIX timespec vocabulary, same as `unix_to_filetime`.
    #[allow(clippy::similar_names)]
    pub(crate) fn set_last_write_time(path: &Path, tv_sec: i64, tv_nsec: i64) -> io::Result<()> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_WRITE_ATTRIBUTES,
                FILE_SHARE_ALL,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if handle as isize == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let last_write = unix_to_filetime(tv_sec, tv_nsec);
        let ok = unsafe {
            SetFileTime(
                handle,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::from_ref(&last_write),
            )
        };
        unsafe { CloseHandle(handle) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// An exclusive cross-process lock on `{path}.lock`, released on drop by
/// removing the directory. The directory's ownership identity is captured
/// at acquisition, so a long hold can re-check whose lock it still is
/// (the TS sync lock's compromise rules).
#[derive(Debug)]
pub struct LockDir {
    path: PathBuf,
    /// The lock directory's identity captured at acquisition (the inode;
    /// TS `guardIno`), `None` where the platform cannot observe it.
    owned: Option<u64>,
}

impl LockDir {
    /// Lock path for the guarded file.
    #[must_use]
    pub fn path_for(file: &Path) -> PathBuf {
        let mut path = file.as_os_str().to_os_string();
        path.push(".lock");
        PathBuf::from(path)
    }

    /// Acquire exclusively: create `{file}.lock` as an empty directory and
    /// bump its mtime. A fresh lock held by another process surfaces as
    /// [`io::ErrorKind::WouldBlock`] (the TS protocol's ELOCKED); callers
    /// own retry policy. A lock older than `stale_after` is removed and
    /// retried once, so a crashed holder cannot wedge the file.
    ///
    /// # Errors
    ///
    /// Returns [`io::ErrorKind::WouldBlock`] when a fresh lock is held by
    /// another process, and any underlying I/O error (missing parent,
    /// permissions, stale-reclaim failures) as-is.
    pub fn acquire(file: &Path, stale_after: Duration) -> io::Result<Self> {
        Self::acquire_at(&Self::path_for(file), stale_after)
    }

    /// [`LockDir::acquire`] at an explicit lock-directory path - for
    /// protocols that name the lock directory itself (the TS supervisor
    /// registry guard locks its directory at `<registryDir>/.guard`, not
    /// at `<file>.lock`), so a rust process and a TS process serialize on
    /// the SAME on-disk lock.
    ///
    /// # Errors
    ///
    /// Returns [`io::ErrorKind::WouldBlock`] when a fresh lock is held by
    /// another process, and any underlying I/O error (missing parent,
    /// permissions, stale-reclaim failures) as-is.
    pub fn acquire_at(path: &Path, stale_after: Duration) -> io::Result<Self> {
        let path = path.to_path_buf();
        let stale_after = stale_after.max(MIN_STALE);
        match Self::create(&path) {
            Ok(()) => Ok(Self::acquired(path)),
            // Only an existing path is a lock collision; any other failure
            // (missing parent, permissions) is a real error, like the TS
            // protocol's non-EEXIST path - never masked as contention.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Self::judge_and_reclaim(&path, stale_after)?;
                // The judge path removed (or raced away) the incumbent: one
                // fresh attempt; a reappearing rival is contention.
                match Self::create(&path) {
                    Ok(()) => Ok(Self::acquired(path)),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            format!("Lock file is already being held: {}", path.display()),
                        ))
                    }
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        }
    }

    /// The guard bound to the lock directory it just created: the
    /// ownership identity captured right after the mkdir is the one a
    /// refresh or a guarded release re-checks (TS captures `guardIno` the
    /// same way, right after acquisition).
    fn acquired(path: PathBuf) -> Self {
        LockDir {
            owned: Self::ownership_id(&path),
            path,
        }
    }

    /// The lock directory's ownership identity (TS `guardIno`): the inode
    /// where std can observe it (TS `statSync(guardPath, { bigint: true })
    /// .ino`), `None` otherwise - an unstat'able directory is what the TS
    /// catch leaves `guardIno` at. Captured at acquisition, re-run by
    /// [`LockDir::is_stolen`].
    #[cfg(unix)]
    fn ownership_id(path: &Path) -> Option<u64> {
        use std::os::unix::fs::MetadataExt;
        fs::symlink_metadata(path)
            .ok()
            .as_ref()
            .map(fs::Metadata::ino)
    }

    /// std cannot observe a directory's identity on this platform (TS
    /// `guardIno === undefined`): only timer-driven detection applies.
    #[cfg(not(unix))]
    fn ownership_id(_path: &Path) -> Option<u64> {
        None
    }

    /// The mkdir is the acquisition signal: EEXIST is the only collision.
    #[cfg(unix)]
    fn create(path: &Path) -> io::Result<()> {
        fs::create_dir(path)?;
        let (sec, nanos) = probe_mtime();
        if let Err(error) = set_mtime(path, sec, nanos) {
            // Never leave a lock artifact behind a failed probe.
            let _ = fs::remove_dir(path);
            return Err(error);
        }
        Ok(())
    }

    /// The mkdir is the acquisition signal; the mtime probe makes the
    /// staleness judgment meaningful on NTFS too (directory mtimes would
    /// otherwise sit on the second, and stale takeovers would misjudge).
    #[cfg(windows)]
    fn create(path: &Path) -> io::Result<()> {
        fs::create_dir(path)?;
        let (sec, nanos) = probe_mtime();
        if let Err(error) = set_mtime(path, sec, nanos) {
            // Never leave a lock artifact behind a failed probe.
            let _ = fs::remove_dir(path);
            return Err(error);
        }
        Ok(())
    }

    #[cfg(not(any(unix, windows)))]
    fn create(path: &Path) -> io::Result<()> {
        // No mtime probe on this platform: staleness is judged from the
        // filesystem's own directory mtime.
        fs::create_dir(path)
    }

    /// Decide the fate of an incumbent at `path`. Returns only when the
    /// incumbent was removed (or vanished) and acquisition may be retried;
    /// surfaces `WouldBlock` while a live or not-yet-stale lock holds it.
    fn judge_and_reclaim(path: &Path, stale_after: Duration) -> io::Result<()> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            // Removed meanwhile: retry the create.
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if metadata.is_file() {
            // A regular file is not a lock in this protocol (a pre-compat
            // Rust build or foreign artifact): remove it and retry - but
            // only when no live flock holder guards it, so a concurrently
            // running pre-compat binary is not clobbered mid-write.
            #[cfg(unix)]
            {
                if Self::legacy_flock_held(path) {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!("Lock file is already being held: {}", path.display()),
                    ));
                }
            }
            match fs::remove_file(path) {
                Ok(()) => return Ok(()),
                // A racing reclaim removed it first: retry the create.
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error),
            }
        }
        if metadata.is_dir() {
            let modified = metadata.modified()?;
            let age = std::time::SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default();
            if age > stale_after {
                // Stale: remove and let the caller retry.
                match fs::remove_dir(path) {
                    Ok(()) => return Ok(()),
                    // A racing holder released it first.
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error),
                }
            }
        }
        // Live lock: contention.
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("Lock file is already being held: {}", path.display()),
        ))
    }

    /// True while another process holds the pre-compat flock on a legacy
    /// lock FILE. Its absence (or an unopenable path) means nobody guards
    /// it, so the artifact can be reclaimed safely.
    #[cfg(unix)]
    fn legacy_flock_held(path: &Path) -> bool {
        use std::os::unix::io::AsRawFd;
        let Ok(file) = fs::OpenOptions::new().write(true).open(path) else {
            return false;
        };
        (unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
            && io::Error::last_os_error().kind() == io::ErrorKind::WouldBlock)
    }

    /// Release: remove the lock directory. A missing directory means someone
    /// else already reclaimed it (e.g. a stale takeover) - matching the TS
    /// release, which tolerates ENOENT. Other failures are surfaced to the
    /// trace log; `Drop` cannot propagate.
    pub fn release(&self) {
        if let Err(error) = fs::remove_dir(&self.path) {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::warn!("failed to release lock {}: {error}", self.path.display());
            }
        }
    }

    /// Whether the directory at the lock path is still the one this guard
    /// acquired (TS `guardStolen`): a steal is rmdir+mkdir (a successor's
    /// stale takeover of the same path), which swaps the inode. An
    /// unobservable identity (`None`) is never stolen - there only the
    /// refresher's timer-driven detection applies (TS
    /// `guardIno === undefined`) - and a directory that cannot be stat'ed
    /// is (TS's `guardStolen` catch). Synchronous by design: the check TS
    /// runs where its timer cannot (`assertGuardHeld`).
    #[must_use]
    pub fn is_stolen(&self) -> bool {
        let Some(owned) = self.owned else {
            return false;
        };
        Self::ownership_id(&self.path) != Some(owned)
    }

    /// The long-hold safety valve the TS sync lock runs as an unref'd timer
    /// (proper-lockfile's `update` option): re-probe the mtime, so a stall
    /// in the holder cannot age the lock past the staleness threshold a
    /// successor reclaims on. The ownership check runs first - the probe
    /// must land on the lock directory this guard acquired, not a
    /// successor's - and a lost identity or a failed probe write is the
    /// error proper-lockfile reports to `onCompromised` (which also stops
    /// the updater; the caller treats the hold as over).
    ///
    /// # Errors
    ///
    /// Returns an error when the lock directory changed hands (or cannot
    /// be stat'ed) and when the mtime probe write fails.
    pub fn refresh(&self) -> io::Result<()> {
        if self.is_stolen() {
            return Err(io::Error::other("the lock directory changed hands"));
        }
        Self::reprobe_mtime(&self.path)
    }

    /// The acquisition probe re-run - the same ceil-plus-5 ms shape, so
    /// the staleness judgment keeps its meaning (see `create`'s platform
    /// split).
    #[cfg(any(unix, windows))]
    fn reprobe_mtime(path: &Path) -> io::Result<()> {
        let (sec, nanos) = probe_mtime();
        set_mtime(path, sec, nanos)
    }

    /// No mtime probe on this platform (see `create`): staleness rides the
    /// directory's own mtime.
    #[cfg(not(any(unix, windows)))]
    fn reprobe_mtime(_path: &Path) -> io::Result<()> {
        Ok(())
    }

    /// Release only when the lock directory is still the one this guard
    /// acquired: removing a stolen lock would delete the successor's lock
    /// (TS: a stolen-but-undetected guard is never released - "the
    /// abandoned updater notices the foreign mtime on its next tick and
    /// cleans itself up"). An unobservable identity releases like the plain
    /// drop (TS's `guardStolen()` is false for `guardIno === undefined`).
    ///
    /// Consuming: [`Drop`] would run the plain release afterwards, and a
    /// successor may already hold a fresh lock at the path the guarded
    /// removal vacated - the double release could delete it - so the guard
    /// is forgotten once its guarded removal ran.
    pub fn release_when_owned(self) {
        if !self.is_stolen() {
            self.release();
        }
        std::mem::forget(self);
    }
}

impl Drop for LockDir {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock_of(file: &Path) -> PathBuf {
        LockDir::path_for(file)
    }

    #[test]
    fn lock_is_an_empty_directory_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        {
            let _guard = LockDir::acquire(&file, MIN_STALE).unwrap();
            let path = lock_of(&file);
            let metadata = std::fs::metadata(&path).unwrap();
            assert!(metadata.is_dir(), "lock must be a directory");
            assert!(std::fs::read_dir(&path).unwrap().next().is_none());
        }
        assert!(!lock_of(&file).exists(), "release removes the directory");
    }

    #[test]
    fn acquire_at_locks_the_exact_named_path() {
        // The TS supervisor registry guards its directory with a lock
        // directory named exactly `<registryDir>/.guard` (proper-lockfile's
        // lockfilePath), so a rust visitor must be able to take the same
        // on-disk lock - not the `{file}.lock` convention - with the same
        // empty-directory body and the same off-second mtime probe a TS
        // holder writes (byte-compatibility both directions).
        let dir = tempfile::tempdir().unwrap();
        let guard = dir.path().join(".guard");
        {
            let _held = LockDir::acquire_at(&guard, MIN_STALE).unwrap();
            assert!(guard.is_dir(), "the named path itself is the lock");
            assert!(
                std::fs::read_dir(&guard).unwrap().next().is_none(),
                "the lock body is the empty directory proper-lockfile writes"
            );
            assert!(!lock_of(&guard).exists(), "no .lock twin is created");
            let modified = std::fs::metadata(&guard)
                .unwrap()
                .modified()
                .unwrap()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap();
            assert_eq!(
                modified.as_millis() % 1000,
                5,
                "the same ceil-plus-5ms probe a TS holder's lock carries"
            );
            assert!(
                LockDir::acquire_at(&guard, MIN_STALE).is_err(),
                "a fresh named lock is contention"
            );
        }
        assert!(!guard.exists(), "release removes the named lock");
    }

    #[test]
    fn mtime_matches_the_proper_lockfile_probe_shape() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let _guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let modified = std::fs::metadata(lock_of(&file))
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap();
        // Ceil to the next second plus 5ms, so millisecond-precision
        // filesystems never record a time "on the second".
        assert_eq!(modified.as_millis() % 1000, 5);
        assert!(
            modified.as_millis()
                >= std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
        );
    }

    #[test]
    fn second_acquire_reports_contention() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        std::fs::write(&file, "{}").unwrap();
        let _guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let error = LockDir::acquire(&file, MIN_STALE).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
    }

    #[test]
    fn stale_lock_is_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let stale = lock_of(&file);
        std::fs::create_dir(&stale).unwrap();
        // Age it past the staleness threshold.
        set_mtime(&stale, 1, 0).unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let metadata = std::fs::metadata(&stale).unwrap();
        assert!(metadata.is_dir());
        drop(guard);
        assert!(!stale.exists());
    }

    #[test]
    fn legacy_lock_file_is_removed_not_choked_on() {
        // A pre-compat Rust build left flock FILES at the lock path; the TS
        // product rmdir()s them and dies with ENOTDIR. Acquision must heal
        // the artifact instead of failing.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        std::fs::write(lock_of(&file), "legacy flock artifact").unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        assert!(std::fs::metadata(lock_of(&file)).unwrap().is_dir());
        drop(guard);
        assert!(!lock_of(&file).exists());
    }

    #[test]
    fn refresh_keeps_the_lock_fresh() {
        // The long-hold valve: a refresh tick re-probes the mtime, so an
        // aged lock stops being stale and a visitor sees contention, not a
        // reclaim (proper-lockfile's update timer's whole job).
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        set_mtime(&lock_of(&file), 1, 0).unwrap();
        guard.refresh().unwrap();
        let error = LockDir::acquire(&file, MIN_STALE).unwrap_err();
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::WouldBlock,
            "a refreshed lock is live, not stale"
        );
    }

    #[test]
    #[cfg(unix)]
    fn refresh_reports_a_stolen_lock() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let path = lock_of(&file);
        // The thief's rmdir+mkdir re-creates the lock directory; a fresh
        // mkdir in between pins the recreator to a different inode, the
        // way a real successor's mkdir is one allocation among others.
        std::fs::remove_dir(&path).unwrap();
        std::fs::create_dir(dir.path().join("thief-bumper")).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(
            guard.is_stolen(),
            "the recreated lock is not the acquired one"
        );
        let error = guard
            .refresh()
            .expect_err("the refresh probe must not land on the successor's lock");
        assert_eq!(error.to_string(), "the lock directory changed hands");
    }

    #[test]
    #[cfg(unix)]
    fn release_when_owned_leaves_a_stolen_lock_alone() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let path = lock_of(&file);
        // While owned, the guarded release removes like the plain one.
        LockDir::acquire(&file, MIN_STALE)
            .unwrap()
            .release_when_owned();
        assert!(!path.exists(), "an owned guard releases normally");
        // After the steal (rmdir+mkdir, a fresh allocation in between),
        // the successor's lock directory survives.
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        std::fs::remove_dir(&path).unwrap();
        std::fs::create_dir(dir.path().join("thief-bumper")).unwrap();
        std::fs::create_dir(&path).unwrap();
        guard.release_when_owned();
        assert!(
            path.is_dir(),
            "the guarded release never deletes the successor's lock"
        );
    }
}
