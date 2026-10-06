//! Cross-process directory locks, byte-compatible with the TS product's
//! `proper-lockfile` 4.1.2 convention: a lock is an EMPTY DIRECTORY at
//! `{file}.lock`, staleness is judged from its bumped mtime alone (no pid
//! or owner file), and a regular file at the lock path is removed on acquisition.

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

/// The mtime probe through the pinned handle: only the pinned inode's
/// timestamps change, never a replacement at the public pathname.
// The `tv_sec`/`tv_nsec` pair is the POSIX timespec vocabulary, same as
// the path-based probe.
#[allow(clippy::similar_names)]
#[cfg(unix)]
fn set_mtime_handle(dir: &fs::File, tv_sec: i64, tv_nsec: i64) -> io::Result<()> {
    let modified = std::time::UNIX_EPOCH
        + std::time::Duration::new(tv_sec.max(0) as u64, tv_nsec.clamp(0, 999_999_999) as u32);
    dir.set_times(std::fs::FileTimes::new().set_modified(modified))
}

/// True while `path` still resolves to the inode the handle pins.
#[cfg(unix)]
fn path_pins(path: &Path, dir: &fs::File) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(path), dir.metadata()) {
        (Ok(path_metadata), Ok(dir_metadata)) => {
            path_metadata.dev() == dir_metadata.dev() && path_metadata.ino() == dir_metadata.ino()
        }
        _ => false,
    }
}

/// A private sibling name scoped to one lock path (the candidate
/// directory on linux, the lease release's claim in the daemon): unique
/// per process and nanosecond, in the lock's own directory so a rename
/// across the two names stays same-filesystem. Unix only.
#[must_use]
#[cfg(unix)]
pub fn private_sibling_for(path: &Path, tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |age| age.as_nanos());
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{tag}-{}-{nanos}", std::process::id()));
    PathBuf::from(name)
}

/// A compact private sibling name for socket-file claims: the claim is
/// liveness-probed through its own pathname, and after the long-path
/// re-anchor the probeable budget is the basename - the long form's
/// 37-byte suffix would push a 71-byte socket basename past the
/// `AF_UNIX` address limit and force a conservative restore, where the
/// compact form keeps it probeable. Uniqueness keeps the same
/// structure (process id plus nanosecond tail): the only collision
/// window is one process re-claiming the same path within the same
/// nanosecond tail, which the one-lease-per-path lifecycle excludes.
#[must_use]
#[cfg(unix)]
pub fn compact_sibling_for(path: &Path, tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |age| age.as_nanos());
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(
        ".{tag}{:x}{:x}",
        std::process::id(),
        (nanos & 0xff_ffff) as u64
    ));
    PathBuf::from(name)
}

/// The dev+ino identity at `path`, or `None` when it cannot be stat'ed.
#[cfg(unix)]
fn identity_at(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(path)
        .ok()
        .map(|metadata| (metadata.dev(), metadata.ino()))
}

/// `renameat2` with `RENAME_NOREPLACE` (linux): publish without ever
/// replacing an existing entry, so the atomic publish is the lock's
/// admission signal exactly like the mkdir of the TS protocol. Hand-
/// declared per repo policy (pinned constants, no extra dependency).
#[cfg(target_os = "linux")]
mod rename_noreplace {
    use std::ffi::CString;
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    /// `include/uapi/linux/fs.h`: fail with EEXIST instead of replacing
    /// the target.
    const RENAME_NOREPLACE: libc::c_uint = 1;

    pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
        let from_c = CString::new(from.as_os_str().as_bytes())?;
        let to_c = CString::new(to.as_os_str().as_bytes())?;
        // AT_FDCWD: both paths resolve from the process root like the
        // utimensat probe below; relative lock paths resolve against cwd.
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                from_c.as_ptr(),
                libc::AT_FDCWD,
                to_c.as_ptr(),
                RENAME_NOREPLACE,
            )
        };
        if result == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// Atomically move a filesystem entry to `to` without ever replacing an
/// existing entry there: a live lock at the destination fails with
/// [`io::ErrorKind::AlreadyExists`] instead of being clobbered. Linux
/// only - this is `renameat2(RENAME_NOREPLACE)`, which no other unix
/// provides; there is no portable no-replace rename.
///
/// # Errors
///
/// Returns [`io::ErrorKind::AlreadyExists`] when `to` is occupied (the
/// caller keeps `from`), and any underlying I/O error as-is.
#[cfg(target_os = "linux")]
pub fn move_without_replacing(from: &Path, to: &Path) -> io::Result<()> {
    rename_noreplace::rename(from, to)
}

// The `libc::timespec` field names are the syscall's own vocabulary;
// the struct-literal shorthand below is the point.
#[allow(clippy::similar_names)]
#[cfg(all(unix, test))]
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

/// The freshly acquired lock: the handle pinning its inode on unix.
#[cfg(unix)]
type Created = fs::File;
#[cfg(not(unix))]
type Created = ();

/// An exclusive cross-process lock on `{path}.lock`, released on drop by
/// removing the directory.
#[derive(Debug)]
pub struct LockDir {
    path: PathBuf,
    /// Handle pinning the acquired lock directory's inode: the mtime
    /// probe acts through it and long-lived holders read their identity
    /// from it, never from the replaceable public pathname (unix only).
    #[cfg(unix)]
    dir: fs::File,
}

impl LockDir {
    /// Lock path for the guarded file.
    #[must_use]
    pub fn path_for(file: &Path) -> PathBuf {
        let mut path = file.as_os_str().to_os_string();
        path.push(".lock");
        PathBuf::from(path)
    }

    #[cfg(unix)]
    fn created(path: PathBuf, dir: Created) -> Self {
        Self { path, dir }
    }

    #[cfg(not(unix))]
    fn created(path: PathBuf, _created: Created) -> Self {
        Self { path }
    }

    /// Transfer the lock path and the pinned handle to a caller that
    /// manages ownership and release itself (supervisor-lifetime leases
    /// with inode-guarded cleanup). Unix only.
    #[must_use]
    #[cfg(unix)]
    pub fn into_parts(self) -> (PathBuf, fs::File) {
        let mut this = std::mem::ManuallyDrop::new(self);
        let path = std::mem::take(&mut this.path);
        // SAFETY: `this` sits in a ManuallyDrop, so no Drop ever runs on
        // it; the handle is read out exactly once and is not double-dropped.
        let dir = unsafe { std::ptr::read(&raw const this.dir) };
        (path, dir)
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
        let path = Self::path_for(file);
        let stale_after = stale_after.max(MIN_STALE);
        match Self::create(&path) {
            Ok(created) => Ok(Self::created(path, created)),
            // Only an existing path is a lock collision; other failures
            // (missing parent, permissions) are real errors, never contention.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Self::judge_and_reclaim(&path, stale_after)?;
                // The judge path removed (or raced away) the incumbent: one
                // fresh attempt; a reappearing rival is contention.
                match Self::create(&path) {
                    Ok(created) => Ok(Self::created(path, created)),
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

    /// The lock is BUILT as a private candidate directory, pinned by the
    /// returned handle, and PUBLISHED with a no-replace rename. The
    /// handle therefore provably refers to the inode this call created,
    /// and a stale takeover racing the public pathname can never make the
    /// holder adopt a successor's lock: a lost publish is plain
    /// contention. EEXIST from the publish is the only collision.
    #[cfg(target_os = "linux")]
    fn create(path: &Path) -> io::Result<Created> {
        let candidate = private_sibling_for(path, "candidate");
        fs::create_dir(&candidate)?;
        let dir = match fs::File::open(&candidate) {
            Ok(dir) => dir,
            Err(error) => {
                // Never leave the private candidate behind a failed pin -
                // nothing else ever removes that private name.
                let _ = fs::remove_dir(&candidate);
                return Err(error);
            }
        };
        let (sec, nanos) = probe_mtime();
        if let Err(error) = set_mtime_handle(&dir, sec, nanos) {
            // Never leave the private candidate behind a failed probe.
            let _ = fs::remove_dir(&candidate);
            return Err(error);
        }
        match rename_noreplace::rename(&candidate, path) {
            Ok(()) => Ok(dir),
            Err(error) if Self::rename_noreplace_unsupported(&error) => {
                // This kernel or filesystem has no RENAME_NOREPLACE: use
                // the compatible mkdir protocol instead of failing the
                // acquisition (settings and daemon startup must keep
                // working wherever the mkdir protocol worked before).
                // The private candidate must be gone before the mkdir
                // protocol runs: a failed removal here would leak a
                // lock artifact beside every acquisition on this
                // filesystem, so the acquisition fails instead of
                // succeeding with the candidate still present.
                if let Err(remove_error) = fs::remove_dir(&candidate) {
                    if remove_error.kind() != io::ErrorKind::NotFound {
                        return Err(remove_error);
                    }
                }
                Self::create_by_mkdir(path)
            }
            Err(error) => {
                // An ambiguous rename failure may still have published the
                // candidate: the pinned handle is the truth - if the path
                // resolves to this candidate's inode, the lock was
                // acquired, not lost, and must not be orphaned at the
                // public path with no holder.
                if path_pins(path, &dir) {
                    return Ok(dir);
                }
                // A contender holds the path (or the rename failed clean):
                // the candidate is this call's alone - remove it, never the
                // incumbent at the public path.
                let _ = fs::remove_dir(&candidate);
                Err(error)
            }
        }
    }

    /// True when a no-replace rename failed because the kernel or
    /// filesystem does not implement it (EINVAL: the flag is unknown
    /// here; ENOSYS: no renameat2 at all; EOPNOTSUPP: the filesystem
    /// rejects the flag - NFS, FUSE and similar mounts) - the mkdir
    /// protocol is the compatible fallback.
    #[cfg(target_os = "linux")]
    fn rename_noreplace_unsupported(error: &io::Error) -> bool {
        matches!(
            error.raw_os_error(),
            Some(libc::EINVAL | libc::ENOSYS | libc::EOPNOTSUPP)
        )
    }

    /// The mkdir is the acquisition signal: EEXIST is the only collision.
    /// The handle pins the created inode right after the mkdir. Scope
    /// decision, stated plainly: without a no-replace rename this
    /// protocol keeps proper-lockfile's own residual window - a
    /// suspension longer than the staleness threshold between the mkdir
    /// and the open can let a stale takeover win first, and the holder
    /// then adopts the successor's lock. The identity checks catch a
    /// displacement after the pin, not one that wins it. On linux this
    /// path only serves filesystems whose kernel has no renameat2
    /// support; CI's unix surface runs the candidate+publish `create`
    /// above, which has no window.
    #[cfg(unix)]
    fn create_by_mkdir(path: &Path) -> io::Result<Created> {
        fs::create_dir(path)?;
        let created = identity_at(path);
        let dir = match fs::File::open(path) {
            Ok(dir) => dir,
            Err(error) => {
                // Never leave a fresh lock artifact behind a failed pin -
                // it would wedge later acquisitions behind contention until
                // it goes stale. Remove only the directory this call
                // created, and only on a positive identity witness: an
                // unstattable capture must not become one (None == None
                // would remove without ownership).
                if created.is_some_and(|identity| identity_at(path) == Some(identity)) {
                    let _ = fs::remove_dir(path);
                }
                return Err(error);
            }
        };
        let (sec, nanos) = probe_mtime();
        if let Err(error) = set_mtime_handle(&dir, sec, nanos) {
            // Never leave a lock artifact behind a failed probe - but only
            // this handle's own inode: the path may already be taken.
            if path_pins(path, &dir) {
                let _ = fs::remove_dir(path);
            }
            return Err(error);
        }
        Ok(dir)
    }

    /// The mkdir-protocol create for unix without a no-replace rename.
    #[cfg(all(unix, not(target_os = "linux")))]
    fn create(path: &Path) -> io::Result<Created> {
        Self::create_by_mkdir(path)
    }

    /// The mkdir is the acquisition signal; the mtime probe keeps staleness
    /// meaningful on NTFS (directory mtimes otherwise sit on the second).
    #[cfg(windows)]
    fn create(path: &Path) -> io::Result<Created> {
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
    fn create(path: &Path) -> io::Result<Created> {
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
    #[cfg(unix)]
    fn pinned_handle_matches_the_created_directory() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let (path, handle) = guard.into_parts();
        let metadata = std::fs::symlink_metadata(&path).unwrap();
        let pinned = handle.metadata().unwrap();
        assert_eq!(
            (metadata.dev(), metadata.ino()),
            (pinned.dev(), pinned.ino())
        );
    }

    #[test]
    #[cfg(unix)]
    fn pinned_handle_survives_a_path_swap() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let (path, handle) = guard.into_parts();
        let acquired = {
            let metadata = handle.metadata().unwrap();
            (metadata.dev(), metadata.ino())
        };
        // A stale takeover of the public pathname: the pinned handle
        // keeps the acquired inode, not the successor's.
        let aside = dir.path().join("displaced.lock");
        std::fs::rename(&path, &aside).unwrap();
        std::fs::create_dir(&path).unwrap();
        let successor = std::fs::symlink_metadata(&path).unwrap();
        let still_pinned = handle.metadata().unwrap();
        assert_eq!((still_pinned.dev(), still_pinned.ino()), acquired);
        assert_ne!(
            acquired,
            (successor.dev(), successor.ino()),
            "the swap must install a different inode or the oracle is vacuous"
        );
    }

    #[test]
    #[cfg(unix)]
    fn into_parts_transfers_the_path_and_pinned_handle() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let (path, handle) = guard.into_parts();
        assert!(path.is_dir());
        let metadata = handle.metadata().unwrap();
        let at_path = std::fs::symlink_metadata(&path).unwrap();
        assert_eq!(
            (metadata.dev(), metadata.ino()),
            (at_path.dev(), at_path.ino())
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn rename_noreplace_unsupported_only_matches_missing_support() {
        use super::LockDir;
        assert!(LockDir::rename_noreplace_unsupported(
            &io::Error::from_raw_os_error(libc::EINVAL)
        ));
        assert!(LockDir::rename_noreplace_unsupported(
            &io::Error::from_raw_os_error(libc::ENOSYS)
        ));
        // NFS/FUSE mounts reject the flag with EOPNOTSUPP: same fallback.
        assert!(LockDir::rename_noreplace_unsupported(
            &io::Error::from_raw_os_error(libc::EOPNOTSUPP)
        ));
        // Contention and real I/O failures must keep their own errors.
        assert!(!LockDir::rename_noreplace_unsupported(
            &io::Error::from_raw_os_error(libc::EEXIST)
        ));
        assert!(!LockDir::rename_noreplace_unsupported(
            &io::Error::from_raw_os_error(libc::EACCES)
        ));
    }

    #[test]
    #[cfg(unix)]
    fn mkdir_protocol_create_pins_and_probes_the_lock() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let lock = lock_of(&file);
        let handle = LockDir::create_by_mkdir(&lock).unwrap();
        let metadata = std::fs::symlink_metadata(&lock).unwrap();
        let pinned = handle.metadata().unwrap();
        assert_eq!(
            (metadata.dev(), metadata.ino()),
            (pinned.dev(), pinned.ino()),
            "the handle must pin the created directory"
        );
        let modified = metadata.modified().unwrap();
        assert_eq!(
            modified
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
                % 1000,
            5,
            "the probe mtime shape must survive the fallback"
        );
        let _ = fs::remove_dir(&lock);
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
