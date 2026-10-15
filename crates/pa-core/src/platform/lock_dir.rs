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
    /// The creation identity (device, inode) of the directory this
    /// guard created: a displaced holder never releases a successor's
    /// lock (a judge may park the directory aside and a rival may
    /// re-lock the path; the recorded identity keeps the drop from
    /// removing the rival's directory). The creation-probe mtime alone
    /// cannot tell two locks created inside the same wall-second apart.
    created: Option<(u64, u64)>,
}

/// The creation identity of a lock directory, unique per creation on
/// every platform (dev+inode on Unix, the NTFS file index on Windows).
#[cfg(unix)]
#[allow(clippy::unnecessary_wraps)] // the Windows twin is fallible; one shape
fn lock_identity(meta: &fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((meta.dev(), meta.ino()))
}

#[cfg(windows)]
fn lock_identity(meta: &fs::Metadata) -> Option<(u64, u64)> {
    // The NTFS file index needs an unstable feature; the probe-bumped
    // creation mtime is the Windows identity (it can false-match a
    // rival created inside the same wall-second - a platform limitation
    // the owner checks still bound).
    let modified = meta.modified().ok()?;
    let duration = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some((duration.as_secs(), u64::from(duration.subsec_nanos())))
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
            Ok(()) => Ok(Self::guard_for(path, owner)),
            // Only an existing path is a lock collision; other failures
            // (missing parent, permissions) are real errors, never contention.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Self::judge_and_reclaim(&path, stale_after)?;
                // The judge path removed (or raced away) the incumbent: one
                // fresh attempt; a reappearing rival is contention.
                match Self::create(&path, owner.as_deref()) {
                    Ok(()) => Ok(Self::guard_for(path, owner)),
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

    /// Wrap the created lock directory in a guard recording its creation
    /// mtime: a displaced holder's drop never releases a successor's
    /// lock at the canonical path.
    fn guard_for(path: PathBuf, owner: Option<String>) -> Self {
        let created = fs::symlink_metadata(&path)
            .ok()
            .and_then(|meta| lock_identity(&meta));
        LockDir {
            path,
            owner,
            created,
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
        if self
            .owner
            .as_ref()
            .is_some_and(|owner| !Self::owner_matches(&self.path, owner))
        {
            return Err(io::Error::other(format!(
                "harness state lock lost: {}",
                self.path.display()
            )));
        }
        Ok(())
    }

    fn owner_matches(path: &Path, owner: &str) -> bool {
        fs::read_to_string(path.join("owner")).is_ok_and(|recorded| recorded.trim() == owner)
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
            matches!(
                pa_types::platform::process::is_process_alive(pid),
                Ok(false)
            )
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
    /// Restore a directory this judge parked aside but never observed
    /// stale. The restore never overwrites an occupant: on Unix a rename
    /// onto an existing empty directory replaces it, so the move must be
    /// conditional on the path being absent. The path's current occupant
    /// is itself short-lived (a live lock): retry while it releases; if
    /// restoration stays impossible, the parked directory stays put as
    /// residue — a live lock is never deleted and never displaced onto.
    fn restore_or_park(aside: &Path, path: &Path) {
        for _ in 0..25 {
            if Self::restore_once_if_absent(aside, path) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// One atomic-or-refused restore attempt: the parked directory moves
    /// to `path` only when `path` is absent — never replacing a rival
    /// that re-locked the canonical path between a check and the move.
    /// On Linux the move is `renameat2` with `RENAME_NOREPLACE` (no
    /// check-then-rename window at all). Elsewhere the best available
    /// approximation is the two-step check-then-rename; POSIX rename
    /// only replaces EMPTY directories, so an owned occupant (a directory
    /// holding its `owner` file) still refuses the overwrite natively.
    fn restore_once_if_absent(aside: &Path, path: &Path) -> bool {
        #[cfg(target_os = "linux")]
        {
            let Ok(aside_name) = std::ffi::CString::new(aside.as_os_str().as_encoded_bytes())
            else {
                return false;
            };
            let Ok(path_name) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else {
                return false;
            };
            // Raw syscall: the wrapper is absent from older glibc.
            let rc = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    libc::AT_FDCWD,
                    aside_name.as_ptr(),
                    libc::AT_FDCWD,
                    path_name.as_ptr(),
                    libc::RENAME_NOREPLACE,
                )
            };
            if rc == 0 {
                return true;
            }
            // The raw syscall reports failures through errno — read it
            // before any other call can overwrite the thread-local value.
            let errno = unsafe { *libc::__errno_location() };
            if errno == libc::ENOSYS || errno == libc::EINVAL || errno == libc::EOPNOTSUPP {
                // The kernel or the filesystem lacks RENAME_NOREPLACE:
                // fall back to the guarded two-step move. The tiny
                // check-to-rename window it reopens beats a parked
                // successor that never returns to the canonical path —
                // permanent residue would hand a second exclusion to
                // another process while the original holder still
                // believes it owns the lock.
                return Self::guarded_two_step_restore(aside, path);
            }
            // EEXIST/ENOTEMPTY: the path holds an occupant — the retry
            // loop waits it out. Any other error (ENOENT for a vanished
            // parked directory, I/O failures): nothing restored this
            // attempt.
            false
        }
        #[cfg(not(target_os = "linux"))]
        {
            Self::guarded_two_step_restore(aside, path)
        }
    }

    /// The best-effort restore where no conditional move exists: the
    /// two-step check-then-rename. POSIX rename only replaces EMPTY
    /// directories, so an owned occupant (a directory holding its
    /// `owner` file) refuses the overwrite natively; only a bare
    /// unowned directory is exposed to the window between the check and
    /// the move.
    fn guarded_two_step_restore(aside: &Path, path: &Path) -> bool {
        !path.exists() && fs::rename(aside, path).is_ok()
    }

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
                if recorded
                    .as_deref()
                    .is_some_and(|owner| !Self::owner_dead(owner))
                {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!("Lock file is already being held: {}", path.display()),
                    ));
                }
                // The observation narrows to the rename: re-read the
                // owner immediately before renaming — a successor another
                // waiter installed meanwhile shows a different owner file
                // and is reported as contention without ever moving off
                // the canonical path.
                if fs::read_to_string(&owner_path).ok().as_deref() != recorded.as_deref() {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!("Lock file is already being held: {}", path.display()),
                    ));
                }
                // Stale by observation: hand the observation to the
                // rename decision. Split from the checks so the
                // collision case (a successor installed between the
                // observation and the rename) is testable directly.
                return Self::reclaim_observed(path, &metadata, modified);
            }
        }
        // Live lock: contention.
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("Lock file is already being held: {}", path.display()),
        ))
    }

    /// The rename-verify-dispose decision for a lock whose observation
    /// passed the staleness checks. `observed`/`observed_modified` are
    /// what this judge measured BEFORE the rename; whatever the rename
    /// actually grabs must match both the observed mtime AND the
    /// observed directory identity (probe mtime can collide for locks
    /// created in the same wall-second, the inode cannot) — a mismatch
    /// means a live successor was grabbed and is restored untouched,
    /// never deleted.
    fn reclaim_observed(
        path: &Path,
        observed: &fs::Metadata,
        observed_modified: std::time::SystemTime,
    ) -> io::Result<()> {
        let aside = path.with_extension(format!("stale-{}", uuid::Uuid::new_v4()));
        match fs::rename(path, &aside) {
            Ok(()) => {
                let renamed_is_observed = fs::symlink_metadata(&aside).is_ok_and(|renamed_meta| {
                    renamed_meta
                        .modified()
                        .is_ok_and(|renamed_modified| renamed_modified == observed_modified)
                        && lock_identity(&renamed_meta) == lock_identity(observed)
                });
                if renamed_is_observed {
                    // The observed stale lock: delete and let the caller
                    // retry the create.
                    if let Err(error) = fs::remove_dir_all(&aside) {
                        if error.kind() != io::ErrorKind::NotFound {
                            return Err(error);
                        }
                    }
                    return Ok(());
                }
                // A live successor holds the path now: restore it
                // untouched — never delete a lock that was not observed
                // stale — and report contention.
                Self::restore_or_park(&aside, path);
                Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!("Lock file is already being held: {}", path.display()),
                ))
            }
            // A racing holder or reclamer acted first: retry the create.
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
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
        // A displaced guard never releases a successor's lock: the
        // directory at the canonical path must still carry this guard's
        // creation mtime. A judge that parked this directory aside left
        // the path empty (nothing to release) or to a rival (whose lock
        // survives this drop). The check runs BEFORE the owner-file
        // removal: removing a child updates the directory's own mtime.
        if let Some(created) = self.created {
            match fs::symlink_metadata(&self.path) {
                Ok(meta) => {
                    if lock_identity(&meta) != Some(created) {
                        return;
                    }
                }
                // Already gone: the release tolerates ENOENT as before.
                Err(error) if error.kind() == io::ErrorKind::NotFound => return,
                Err(error) => {
                    tracing::warn!(
                        "failed to inspect lock {} before release: {error}",
                        self.path.display()
                    );
                    return;
                }
            }
        }
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

/// Advisory exclusive lock on an open file, released on drop or process
/// death — the platform-walled form of `std::fs::File::lock`. OS file locks
/// (crash-released, no stale-lock reclaim) live here so platform-specific
/// behavior stays auditable in one place, like the directory locks above.
///
/// # Errors
///
/// `WouldBlock` (blocking form: after interruption) never applies; other I/O
/// errors as the platform reports them.
pub fn lock_exclusive(file: &std::fs::File) -> io::Result<()> {
    file.lock()
}

/// Nonblocking [`lock_exclusive`]: any held lock (fresh contention or I/O
/// failure) surfaces as an error carrying the platform's try-lock error.
///
/// # Errors
///
/// The platform's [`std::fs::TryLockError`] (contention included) wrapped in
/// an I/O error; nothing is returned on success.
pub fn try_lock_exclusive(file: &std::fs::File) -> io::Result<()> {
    file.try_lock().map_err(io::Error::other)
}

/// Release an OS file lock without waiting for duplicated or inherited handles
/// to close. The platform wall owns the Unix and Windows unlock semantics.
///
/// # Errors
///
/// Returns the underlying OS error when unlocking fails. Unlocking a handle
/// without a held lock may succeed or return an error, depending on the platform.
pub fn unlock_file(file: &std::fs::File) -> io::Result<()> {
    file.unlock()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock_of(file: &Path) -> PathBuf {
        LockDir::path_for(file)
    }

    /// The one-shot restore refuses an occupied path atomically: even a
    /// freshly created EMPTY lock directory (the exact shape POSIX rename
    /// would replace in the check-to-rename window) survives the restore
    /// attempt untouched — the no-replace move cannot clobber it.
    #[test]
    fn a_one_shot_restore_refuses_an_empty_occupant() {
        let dir = tempfile::tempdir().unwrap();
        let path = lock_of(&dir.path().join("auth.json"));
        let aside = path.with_extension("stale-parked");
        // The parked directory this judge must restore.
        std::fs::create_dir(&aside).unwrap();
        std::fs::write(aside.join("owner"), "999999 tok").unwrap();
        // The rival's lock: a bare EMPTY directory at the canonical
        // path, the exact occupant shape the TOCTOU window could
        // replace.
        std::fs::create_dir(&path).unwrap();
        assert!(
            !LockDir::restore_once_if_absent(&aside, &path),
            "the restore refuses while the rival holds the path"
        );
        assert!(
            path.read_dir().unwrap().next().is_none(),
            "the rival's empty lock directory is untouched"
        );
        assert!(
            aside.join("owner").exists(),
            "the parked directory stays parked"
        );
        // The rival releases: the restore lands.
        std::fs::remove_dir(&path).unwrap();
        assert!(
            LockDir::restore_once_if_absent(&aside, &path),
            "the restore lands once the path frees"
        );
        assert!(
            fs::read_to_string(path.join("owner")).is_ok_and(|owner| owner == "999999 tok"),
            "the parked directory now owns the canonical path"
        );
    }

    /// The restore never overwrites an occupant: a Unix rename onto an
    /// existing empty directory would replace the live lock at the
    /// canonical path — `restore_or_park` restores only into an absent
    /// path.
    #[test]
    fn a_restore_never_overwrites_the_live_occupant() {
        let dir = tempfile::tempdir().unwrap();
        let path = lock_of(&dir.path().join("auth.json"));
        let aside = path.with_extension("stale-parked");
        // The parked directory this judge must restore.
        std::fs::create_dir(&aside).unwrap();
        std::fs::write(aside.join("owner"), "999999 tok").unwrap();
        // A live occupant holds the canonical path.
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("owner"), "1 tok").unwrap();
        LockDir::restore_or_park(&aside, &path);
        assert!(
            fs::read_to_string(path.join("owner")).is_ok_and(|owner| owner == "1 tok"),
            "the occupant's lock is never overwritten"
        );
        assert!(
            aside.join("owner").exists(),
            "the parked directory stays parked while the path is occupied"
        );
        // The occupant releases: the restore lands without overwriting.
        std::fs::remove_file(path.join("owner")).unwrap();
        std::fs::remove_dir(&path).unwrap();
        LockDir::restore_or_park(&aside, &path);
        assert!(
            fs::read_to_string(path.join("owner")).is_ok_and(|owner| owner == "999999 tok"),
            "the parked directory restores once the path is free"
        );
    }

    /// A successor whose probe mtime MATCHES the stale observation (the
    /// same-second collision the probe assigns) still survives the judge's
    /// real rename decision: the directory identity carries the
    /// discrimination the mtime cannot. Both stamps are written
    /// explicitly (no timing premise): the observed stale lock and the
    /// successor share the observed mtime, differ in inode —
    /// `reclaim_observed` restores the successor and reports contention.
    #[cfg(unix)]
    #[test]
    fn a_same_mtime_successor_is_restored_not_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let lock_path = LockDir::path_for(&file);
        // The observed stale lock: a dead-owner directory stamped 10s
        // into the past (the judge's observation premise).
        fs::create_dir(&lock_path).unwrap();
        fs::write(lock_path.join("owner"), "999999 tok").unwrap();
        set_mtime(&lock_path, 10, 500_000_000).unwrap();
        let observed = fs::symlink_metadata(&lock_path).unwrap();
        let observed_modified = observed.modified().unwrap();
        // The successor installed between the observation and the judge's
        // rename: a fresh live-owner directory at the freed path — its
        // inode differs (the observed lock stays alive, renamed aside),
        // and it is stamped with the OBSERVED lock's exact mtime.
        let observed_aside = lock_path.with_extension("stale-observed");
        fs::rename(&lock_path, &observed_aside).unwrap();
        fs::create_dir(&lock_path).unwrap();
        fs::write(
            lock_path.join("owner"),
            format!("{} tok", std::process::id()),
        )
        .unwrap();
        set_mtime(&lock_path, 10, 500_000_000).unwrap();
        let successor_meta = fs::symlink_metadata(&lock_path).unwrap();
        assert_eq!(
            successor_meta.modified().unwrap(),
            observed_modified,
            "premise: the stamps collide exactly (written, not timed)"
        );
        assert_ne!(
            lock_identity(&successor_meta),
            lock_identity(&observed),
            "the inode carries the discrimination the mtime cannot"
        );
        // The judge's real rename decision on this state: the successor
        // must be restored, never deleted, and reported as contention.
        let error = LockDir::reclaim_observed(&lock_path, &observed, observed_modified)
            .expect_err("a successor grab reports contention");
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        // The successor is back at the canonical path, untouched.
        assert!(
            fs::read_to_string(lock_path.join("owner"))
                .is_ok_and(|owner| owner == format!("{} tok", std::process::id())),
            "the successor is restored with its live owner intact"
        );
        // And the matching case: the judge renaming the observed lock
        // itself deletes it. Restore the observed lock to the path and
        // run the decision again — this time the identity matches and
        // the delete proceeds.
        fs::remove_dir_all(&lock_path).unwrap();
        fs::rename(&observed_aside, &lock_path).unwrap();
        set_mtime(&lock_path, 10, 500_000_000).unwrap();
        LockDir::reclaim_observed(&lock_path, &observed, observed_modified)
            .expect("the observed stale lock itself is reclaimed");
        assert!(
            !lock_path.exists(),
            "the observed stale lock is deleted so the caller can retry the create"
        );
        let _ = std::fs::remove_file(&file);
    }

    /// A displaced guard never releases a successor's lock: a judge
    /// parked this guard's directory aside, a rival re-locked the
    /// canonical path, and the guard's own drop leaves the rival's
    /// directory standing.
    #[test]
    fn a_displaced_guard_never_releases_a_successor() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        // A judge parks this guard's directory aside.
        let aside = dir.path().join("parked-aside");
        fs::rename(&guard.path, &aside).unwrap();
        // A rival re-locks the canonical path.
        let rival = LockDir::acquire(&file, MIN_STALE).unwrap();
        guard.release();
        assert!(
            guard.path.exists(),
            "the rival's lock survives the displaced guard's drop"
        );
        rival.release();
        assert!(!guard.path.exists(), "the rival's own release cleans up");
    }

    /// The parked-successor disposition never deletes a live lock: an
    /// occupied path keeps its occupant and the parked directory until
    /// the occupant releases, then the parked directory restores.
    #[test]
    fn a_parked_successor_never_deletes_the_live_occupant() {
        let dir = tempfile::tempdir().unwrap();
        let path = lock_of(&dir.path().join("auth.json"));
        let aside = path.with_extension("stale-parked");
        // The parked directory: a successor this judge moved aside.
        std::fs::create_dir(&aside).unwrap();
        std::fs::write(aside.join("owner"), "999999 tok").unwrap();
        // A live occupant holds the path.
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("owner"), format!("{} tok", std::process::id())).unwrap();
        LockDir::restore_or_park(&aside, &path);
        assert!(
            path.join("owner").exists(),
            "the live occupant is never deleted"
        );
        assert!(
            aside.join("owner").exists(),
            "the parked successor stays parked while the path is occupied"
        );
        // The occupant releases: the parked directory restores untouched.
        std::fs::remove_file(path.join("owner")).unwrap();
        std::fs::remove_dir(&path).unwrap();
        LockDir::restore_or_park(&aside, &path);
        assert!(
            fs::read_to_string(path.join("owner")).is_ok_and(|owner| owner == "999999 tok"),
            "the parked successor restores once the path frees"
        );
        assert!(!aside.exists(), "nothing stays parked after the restore");
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
        let guard =
            LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
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
        let old =
            LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let dead_pid = child.id();
        child.wait().unwrap();
        fs::write(old.path.join("owner"), format!("{dead_pid} dead-token\n")).unwrap();
        set_mtime(&old.path, 1, 0).unwrap();
        let next =
            LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
        assert!(old.ensure_owned().is_err());
        drop(old);
        next.ensure_owned().unwrap();
        drop(next);
        assert!(!LockDir::path_for(&file).exists());
    }

    #[cfg(unix)]
    #[test]
    fn unparseable_owned_lock_is_reclaimed_by_age() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("harness_state.json");
        let path = LockDir::path_for(&file);
        fs::create_dir(&path).unwrap();
        fs::write(path.join("owner"), [0xff]).unwrap();
        set_mtime(&path, 1, 0).unwrap();
        let next =
            LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
        next.ensure_owned().unwrap();
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
