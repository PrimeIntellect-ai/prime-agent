//! Cross-process directory locks, byte-compatible with the TS product's
//! `proper-lockfile` 4.1.2 convention: ordinary locks are empty directories
//! at `{file}.lock`; harness-state locks add an owner file for safe stale reclaim.

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

// The `libc::timespec` field names are the syscall's own vocabulary; the struct-literal shorthand
// below is the point.
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

/// Windows: set the directory's last-write time via `CreateFileW` (with
/// `FILE_FLAG_BACKUP_SEMANTICS`, the only way to open a directory) +
/// `SetFileTime` - the mtime probe `utimensat` performs on Unix.
// The `libc::timespec` field names are the syscall's own vocabulary; the struct-literal shorthand
// below is the point.
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
    /// `winnt.h` `FILE_SHARE_READ | WRITE | DELETE`: a concurrent stat of the lock dir must not be
    /// blocked.
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
/// removing the directory.
#[derive(Debug)]
pub struct LockDir {
    path: PathBuf,
    owner: Option<String>,
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
    /// bump its mtime. A fresh foreign lock surfaces as
    /// [`io::ErrorKind::WouldBlock`] (the TS protocol's ELOCKED); a lock
    /// older than `stale_after` is removed and retried once.
    ///
    /// # Errors
    ///
    /// [`io::ErrorKind::WouldBlock`] for a fresh foreign lock; other I/O errors as-is.
    pub fn acquire(file: &Path, stale_after: Duration) -> io::Result<Self> {
        Self::acquire_with_owner(file, stale_after, None)
    }

    fn acquire_with_owner(
        file: &Path,
        stale_after: Duration,
        owner: Option<String>,
    ) -> io::Result<Self> {
        let path = Self::path_for(file);
        let stale_after = stale_after.max(MIN_STALE);
        match Self::create(&path, owner.as_deref()) {
            Ok(()) => Ok(LockDir { path, owner }),
            // Only an existing path is a lock collision; other failures
            // (missing parent, permissions) are real errors, never contention.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Self::judge_and_reclaim(&path, stale_after)?;
                // The judge path removed (or raced away) the incumbent: one
                // fresh attempt; a reappearing rival is contention.
                match Self::create(&path, owner.as_deref()) {
                    Ok(()) => Ok(LockDir { path, owner }),
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

    /// [`Self::acquire`] with a bounded retry: only a fresh foreign lock
    /// (`WouldBlock`) is retried, sleeping `interval` between attempts;
    /// any other error returns immediately, and the final `WouldBlock`
    /// is returned after the last attempt.
    ///
    /// # Errors
    ///
    /// The last [`io::ErrorKind::WouldBlock`] when all attempts contend;
    /// other I/O errors as-is.
    pub fn acquire_retrying(
        file: &Path,
        stale_after: Duration,
        attempts: u32,
        interval: Duration,
    ) -> io::Result<Self> {
        let mut attempt = 0;
        loop {
            match Self::acquire(file, stale_after) {
                Ok(guard) => return Ok(guard),
                Err(error) if error.kind() != io::ErrorKind::WouldBlock => return Err(error),
                Err(error) => {
                    attempt += 1;
                    if attempt >= attempts {
                        return Err(error);
                    }
                    std::thread::sleep(interval);
                }
            }
        }
    }

    /// Acquire a harness-state lock with a PID and per-process token.
    /// Only a provably dead owner can be reclaimed after `stale_after`.
    ///
    /// # Errors
    ///
    /// Returns lock contention or an I/O error from acquisition.
    pub fn acquire_owned_retrying(
        file: &Path,
        stale_after: Duration,
        attempts: u32,
        interval: Duration,
    ) -> io::Result<Self> {
        static PROCESS_TOKEN: std::sync::OnceLock<uuid::Uuid> = std::sync::OnceLock::new();
        let token = PROCESS_TOKEN.get_or_init(uuid::Uuid::new_v4);
        let owner = format!("{} {token}.{}", std::process::id(), uuid::Uuid::new_v4());
        let mut attempt = 0;
        loop {
            match Self::acquire_with_owner(file, stale_after, Some(owner.clone())) {
                Ok(guard) => return Ok(guard),
                Err(error) if error.kind() != io::ErrorKind::WouldBlock => return Err(error),
                Err(error) => {
                    attempt += 1;
                    if attempt >= attempts {
                        return Err(error);
                    }
                    std::thread::sleep(interval);
                }
            }
        }
    }

    /// Check that an owned lock is still held before writing its state file.
    ///
    /// # Errors
    ///
    /// Returns an error if the owner file no longer matches this guard.
    pub fn ensure_owned(&self) -> io::Result<()> {
        if self.owner.as_ref().is_some_and(|owner| !Self::owner_matches(&self.path, owner)) {
            return Err(io::Error::other(format!(
                "harness state lock lost: {}",
                self.path.display()
            )));
        }
        Ok(())
    }

    fn owner_matches(path: &Path, owner: &str) -> bool {
        fs::read_to_string(path.join("owner"))
            .is_ok_and(|recorded| recorded.trim() == owner)
    }

    fn owner_dead(recorded: &str) -> bool {
        let Some((pid, token)) = recorded.trim().split_once(' ') else {
            return true;
        };
        if token.is_empty() {
            return true;
        }
        let Ok(pid) = pid.parse::<u32>() else {
            return true;
        };
        if pid == 0 || pid > i32::MAX as u32 {
            return true;
        }
        #[cfg(unix)]
        {
            let result = unsafe { libc::kill(pid as i32, 0) };
            result != 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
        #[cfg(windows)]
        {
            matches!(pa_types::platform::process::is_process_alive(pid), Ok(false))
        }
        #[cfg(not(any(unix, windows)))]
        {
            false
        }
    }

    /// The mkdir is the acquisition signal: EEXIST is the only collision.
    #[cfg(any(unix, windows))]
    fn create(path: &Path, owner: Option<&str>) -> io::Result<()> {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir(path)?;
        let result = (|| {
            if let Some(owner) = owner {
                #[cfg(unix)]
                {
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
                }
                fs::write(path.join("owner"), format!("{owner}\n"))?;
                #[cfg(unix)]
                fs::set_permissions(path.join("owner"), fs::Permissions::from_mode(0o600))?;
            }
            let (sec, nanos) = probe_mtime();
            set_mtime(path, sec, nanos)
        })();
        if result.is_err() {
            let _ = fs::remove_file(path.join("owner"));
            let _ = fs::remove_dir(path);
        }
        result
    }

    #[cfg(not(any(unix, windows)))]
    fn create(path: &Path, owner: Option<&str>) -> io::Result<()> {
        fs::create_dir(path)?;
        if let Some(owner) = owner {
            if let Err(error) = fs::write(path.join("owner"), format!("{owner}\n")) {
                let _ = fs::remove_dir(path);
                return Err(error);
            }
        }
        Ok(())
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
            // only when no live flock holder guards it.
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
                let owner_path = path.join("owner");
                let recorded = fs::read_to_string(&owner_path).ok();
                if recorded.as_deref().is_some_and(|owner| !Self::owner_dead(owner)) {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!("Lock file is already being held: {}", path.display()),
                    ));
                }
                if recorded.is_some() {
                    match fs::remove_file(&owner_path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error),
                    }
                }
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
    /// else already reclaimed it (the TS release tolerates ENOENT); other
    /// failures go to the trace log (`Drop` cannot propagate).
    pub fn release(&self) {
        if let Some(owner) = &self.owner {
            if !Self::owner_matches(&self.path, owner) {
                return;
            }
            if let Err(error) = fs::remove_file(self.path.join("owner")) {
                tracing::warn!("failed to release lock {}: {error}", self.path.display());
                return;
            }
        }
        if let Err(error) = fs::remove_dir(&self.path) {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::warn!("failed to release lock {}: {error}", self.path.display());
            }
        }
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

    #[cfg(unix)]
    #[test]
    fn live_owned_lock_cannot_be_stolen_after_stale_age() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("harness_state.json");
        let guard = LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE)
            .unwrap();
        set_mtime(&guard.path, 1, 0).unwrap();
        let error = LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        guard.ensure_owned().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn dead_owned_lock_is_reclaimed_and_old_guard_cannot_remove_successor() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("harness_state.json");
        let old = LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE)
            .unwrap();
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let dead_pid = child.id();
        child.wait().unwrap();
        fs::write(old.path.join("owner"), format!("{dead_pid} dead-token\n")).unwrap();
        set_mtime(&old.path, 1, 0).unwrap();
        let next = LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE)
            .unwrap();
        assert!(old.ensure_owned().is_err());
        drop(old);
        next.ensure_owned().unwrap();
        drop(next);
        assert!(!LockDir::path_for(&file).exists());
    }

    #[test]
    fn legacy_lock_file_is_removed_not_choked_on() {
        // A pre-compat Rust build left flock FILES at the lock path (the TS
        // product rmdir()s them and dies with ENOTDIR): acquisition must heal.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        std::fs::write(lock_of(&file), "legacy flock artifact").unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        assert!(std::fs::metadata(lock_of(&file)).unwrap().is_dir());
        drop(guard);
        assert!(!lock_of(&file).exists());
    }
}
