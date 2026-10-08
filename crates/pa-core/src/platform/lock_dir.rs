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

/// Remove an unpublished lock candidate completely: the auxiliary
/// files first (a directory containing them cannot be removed), then the
/// directory. A missing candidate is a non-error (a racing reclaimer).
#[cfg(unix)]
fn remove_candidate_dir(candidate: &Path) -> io::Result<()> {
    for note in ["owner", "claimed-at"] {
        match fs::remove_file(candidate.join(note)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    fs::remove_dir(candidate)
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
    /// `include/uapi/linux/fs.h`: atomically swap the two paths.
    const RENAME_EXCHANGE: libc::c_uint = 2;

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

    /// `renameat2(RENAME_EXCHANGE)`: atomically swap the entries at the
    /// two paths - the stale reclaim's blocking placeholder dance. Both
    /// paths must exist (ENOENT otherwise); the public lock path is
    /// never vacated.
    pub fn exchange(a: &Path, b: &Path) -> io::Result<()> {
        let a_c = CString::new(a.as_os_str().as_bytes())?;
        let b_c = CString::new(b.as_os_str().as_bytes())?;
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                a_c.as_ptr(),
                libc::AT_FDCWD,
                b_c.as_ptr(),
                RENAME_EXCHANGE,
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
    /// Optional so `release` can close it before the removal - on the
    /// filesystems whose acquisitions took the mkdir fallback (NFS, FUSE,
    /// CIFS) an open fd can make the remove return EBUSY and leak the
    /// lock behind a clean exit.
    #[cfg(unix)]
    dir: Option<fs::File>,
    owner: Option<String>,
}

/// The live owner record for this process's reclaim placeholder: the
/// same "pid token" shape the owner-liveness check parses, so a
/// placeholder sitting at a public lock path during a suspended
/// exchange/restore interval is refused by every other judge exactly
/// like a live owned lock.
#[cfg(target_os = "linux")]
fn process_owner_record() -> String {
    static PROCESS_TOKEN: std::sync::OnceLock<uuid::Uuid> = std::sync::OnceLock::new();
    let token = PROCESS_TOKEN.get_or_init(uuid::Uuid::new_v4);
    format!("{} {token}\n", std::process::id())
}

/// The kernel-managed serialization guard for the stale-reclaim dance and
/// the inode-anchored release pass: an flock on a tiny sidecar file, so
/// a crashed or suspended holder releases it with the process - no
/// staleness protocol of its own, no judge recursion.
#[cfg(target_os = "linux")]
fn reclaim_guard_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".rlock");
    PathBuf::from(name)
}

/// Take the reclaim guard for `path` within `budget`, or `None`.
#[cfg(target_os = "linux")]
fn try_reclaim_guard(path: &Path, budget: Duration) -> Option<fs::File> {
    use std::os::unix::io::AsRawFd;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(reclaim_guard_path(path))
        .ok()?;
    let deadline = std::time::Instant::now() + budget;
    loop {
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result == 0 {
            return Some(file);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Mark this guard's directory released through the pinned handle: the
/// fd follows the inode through every exchange, so the marker lands in
/// this guard's directory wherever a reclaim dance has moved it. A
/// released marker outranks a live owner record - the guard itself has
/// declared the release, and no judge may restore or refuse the
/// directory afterwards.
#[cfg(target_os = "linux")]
fn mark_released_through(dir: &fs::File) {
    use std::os::unix::io::AsRawFd;
    let name = c"released";
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT,
            0o600,
        )
    };
    if fd >= 0 {
        unsafe { libc::close(fd) };
    }
}

/// True when a lock directory carries this guard's release marker.
fn released_marker(path: &Path) -> bool {
    path.join("released").exists()
}

/// The outcome of a Linux stale-incumbent reclaim attempt.
#[cfg(target_os = "linux")]
enum StaleClaim {
    /// The judged incumbent was claimed and removed: retry.
    Removed,
    /// The incumbent vanished before the exchange: retry.
    Vanished,
    /// A live successor holds the path: contention, never the floor.
    Successor,
    /// No `renameat2` here: the caller runs the floor sequence.
    Unsupported,
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
    fn created(path: PathBuf, dir: Created, owner: Option<String>) -> Self {
        Self {
            path,
            dir: Some(dir),
            owner,
        }
    }

    #[cfg(not(unix))]
    fn created(path: PathBuf, _created: Created, owner: Option<String>) -> Self {
        Self { path, owner }
    }

    /// Transfer the lock path and the pinned handle to a caller that
    /// manages ownership and release itself (supervisor-lifetime leases
    /// with inode-guarded cleanup). Unix only.
    ///
    /// # Panics
    ///
    /// Panics if the handle is no longer pinned - unreachable in practice,
    /// because nothing takes it before this transfer (`release` only
    /// runs from `Drop`).
    #[must_use]
    #[cfg(unix)]
    pub fn into_parts(self) -> (PathBuf, fs::File) {
        let mut this = std::mem::ManuallyDrop::new(self);
        let path = std::mem::take(&mut this.path);
        // SAFETY: `this` sits in a ManuallyDrop, so no Drop ever runs on
        // it; the handle is read out exactly once and is not
        // double-dropped. The handle is always present here: nothing
        // takes it before the transfer (`release` only runs from Drop).
        let dir = unsafe { std::ptr::read(&raw const this.dir) };
        (path, dir.expect("into_parts transfers the pinned handle"))
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
            Ok(created) => Ok(Self::created(path, created, owner)),
            // Only an existing path is a lock collision; other failures
            // (missing parent, permissions) are real errors, never contention.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Self::judge_and_reclaim(&path, stale_after)?;
                // The judge path removed (or raced away) the incumbent: one
                // fresh attempt; a reappearing rival is contention.
                match Self::create(&path, owner.as_deref()) {
                    Ok(created) => Ok(Self::created(path, created, owner)),
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

    /// The lock is BUILT as a private candidate directory, pinned by the
    /// returned handle, and PUBLISHED with a no-replace rename. The
    /// handle therefore provably refers to the inode this call created,
    /// and a stale takeover racing the public pathname can never make the
    /// holder adopt a successor's lock: a lost publish is plain
    /// contention. EEXIST from the publish is the only collision.
    /// A short, basename-independent candidate name in the lock's own
    /// directory: the candidate never publishes at the lock's own name,
    /// so its component length is its own budget - a lock path whose
    /// component is near the filesystem's limit still acquires, where
    /// the basename-derived sibling form failed the mkdir with
    /// `ENAMETOOLONG` before the compatible fallback protocol could
    /// run. The mkdir is already no-replace (EEXIST is a plain
    /// collision), so a taken name regenerates the suffix instead.
    #[cfg(target_os = "linux")]
    fn claim_candidate_name(path: &Path) -> io::Result<PathBuf> {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |age| age.as_nanos());
        let pid = std::process::id();
        // The mkdir is the no-replace claim: EEXIST is the only
        // collision, so a taken name regenerates the suffix. Every other
        // error is the real acquisition failure and propagates as-is -
        // a missing parent or a permissions denial must not masquerade
        // as contention (the old sibling form's ENAMETOOLONG bug this
        // helper fixes was exactly such a masquerade).
        let mut collision: Option<io::Error> = None;
        for attempt in 0..8 {
            let candidate = parent.join(format!(".c{pid:x}{nanos:x}{attempt:x}"));
            match fs::create_dir(&candidate) {
                Ok(()) => return Ok(candidate),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    collision = collision.or(Some(error));
                }
                Err(error) => return Err(error),
            }
        }
        Err(collision.unwrap_or_else(|| {
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "all lock candidate names are taken",
            )
        }))
    }

    #[cfg(target_os = "linux")]
    fn create(path: &Path, owner: Option<&str>) -> io::Result<Created> {
        let candidate = Self::claim_candidate_name(path)?;
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
            // The pinned handle closes first: on the filesystems that
            // take this path (NFS, FUSE, CIFS) an open fd can make the
            // remove return EBUSY, and this is an abandoned candidate -
            // the fd has no further use.
            drop(dir);
            let _ = fs::remove_dir(&candidate);
            return Err(error);
        }
        if let Some(owner) = owner {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Err(error) =
                    fs::set_permissions(&candidate, fs::Permissions::from_mode(0o700))
                {
                    // The owner record rides the publish: any failure
                    // below abandons the candidate (handle closed, owner
                    // file removed, directory removed), never a leaked
                    // half-published lock.
                    drop(dir);
                    let _ = remove_candidate_dir(&candidate);
                    return Err(error);
                }
            }
            if let Err(error) = fs::write(candidate.join("owner"), format!("{owner}\n")) {
                drop(dir);
                let _ = remove_candidate_dir(&candidate);
                return Err(error);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Err(error) =
                    fs::set_permissions(candidate.join("owner"), fs::Permissions::from_mode(0o600))
                {
                    drop(dir);
                    let _ = remove_candidate_dir(&candidate);
                    return Err(error);
                }
            }
        }
        match rename_noreplace::rename(&candidate, path) {
            Ok(()) => Ok(dir),
            Err(error) if Self::rename_noreplace_unsupported(&error) => {
                // This kernel or filesystem has no RENAME_NOREPLACE: use
                // the compatible mkdir protocol instead of failing the
                // acquisition (settings and daemon startup must keep
                // working wherever the mkdir protocol worked before).
                // The pinned handle closes before the candidate's
                // removal - on these filesystems (NFS, FUSE, CIFS) an
                // open fd can make the remove return EBUSY and fail the
                // acquisition instead of falling back. The candidate
                // must be gone before the mkdir protocol runs: a failed
                // removal leaks a lock artifact beside every acquisition
                // on this filesystem, so the acquisition fails instead
                // of succeeding with the candidate still present.
                drop(dir);
                if let Err(remove_error) = remove_candidate_dir(&candidate) {
                    if remove_error.kind() != io::ErrorKind::NotFound {
                        return Err(remove_error);
                    }
                }
                Self::create_by_mkdir(path, owner)
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
                // A contender holds the path (EEXIST is the common
                // case), or the rename failed clean: the candidate is
                // this call's alone - the pinned handle closes first
                // (EBUSY on the fallback mounts), the owner file goes
                // before the directory, and the incumbent at the public
                // path is never touched.
                drop(dir);
                let _ = remove_candidate_dir(&candidate);
                Err(error)
            }
        }
    }

    /// Reclaim the stale incumbent judged at `path` without ever
    /// vacating the public path and without stranding any holder. The
    /// dance: (1) a private placeholder directory is created carrying a
    /// live owner record for THIS process plus a `claimed-at` note
    /// naming the placeholder itself - a suspension mid-dance leaves a
    /// live-owned lock at the public path that no other judge may
    /// reclaim, and any displaced holder whose release runs during the
    /// interval can find and complete it at the claimed location;
    /// (2) `renameat2(RENAME_EXCHANGE)` atomically swaps the incumbent
    /// with the placeholder, so the public path is never empty; (3) the
    /// exchanged content is removed from the private name ONLY after its
    /// inode matches the snapshotted `incumbent`; (4) any other content
    /// (a successor that replaced the incumbent between the snapshot
    /// and the exchange) is swapped back home with a second exchange,
    /// whose ENOENT means the displaced holder already completed its own
    /// release at the claimed location - the placeholder is then simply
    /// removed and the acquisition retried. Overlapping holders are
    /// unrepresentable: no path is ever vacated and no live holder's
    /// directory is ever removed by another process.
    #[cfg(target_os = "linux")]
    fn claim_stale_incumbent(path: &Path, incumbent: Option<(u64, u64)>) -> io::Result<StaleClaim> {
        // The cheap pre-check: a successor that already replaced the
        // incumbent is detected without moving anything.
        if identity_at(path) != incumbent {
            return Ok(StaleClaim::Successor);
        }
        let Some(parent) = path.parent() else {
            return Ok(StaleClaim::Unsupported);
        };
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |age| age.as_nanos());
        let pid = std::process::id();
        for attempt in 0..8 {
            let placeholder = parent.join(format!(".j{pid:x}{nanos:x}{attempt:x}"));
            if let Err(error) = fs::create_dir(&placeholder) {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    continue;
                }
                return Err(error);
            }
            // The placeholder carries a live owner record for the whole
            // exchange/restore interval: if this process is suspended
            // mid-dance, the placeholder sitting at the public lock path
            // is a stale-dated but LIVE-OWNED lock - another acquirer's
            // judge refuses to reclaim it, exactly like the suspension
            // scenario the owner record exists for. The `claimed-at`
            // note lets a displaced holder's release find and complete
            // itself at the private location.
            // The placeholder's records are private: the directory is
            // restricted to 0700 and the owner/claim notes to 0600
            // before the exchange seats them at the public lock path,
            // where a traversable parent would otherwise expose the
            // owner record to other users.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Err(error) =
                    fs::set_permissions(&placeholder, fs::Permissions::from_mode(0o700))
                {
                    let _ = remove_candidate_dir(&placeholder);
                    return Err(error);
                }
            }
            if let Err(error) = fs::write(placeholder.join("owner"), process_owner_record()) {
                let _ = remove_candidate_dir(&placeholder);
                return Err(error);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Err(error) = fs::set_permissions(
                    placeholder.join("owner"),
                    fs::Permissions::from_mode(0o600),
                ) {
                    let _ = remove_candidate_dir(&placeholder);
                    return Err(error);
                }
            }
            if let Err(error) = fs::write(
                placeholder.join("claimed-at"),
                placeholder
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ) {
                let _ = remove_candidate_dir(&placeholder);
                return Err(error);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Err(error) = fs::set_permissions(
                    placeholder.join("claimed-at"),
                    fs::Permissions::from_mode(0o600),
                ) {
                    let _ = remove_candidate_dir(&placeholder);
                    return Err(error);
                }
            }
            match rename_noreplace::exchange(path, &placeholder) {
                Ok(()) => {
                    if identity_at(&placeholder) == incumbent {
                        // The judged stale incumbent, held at the private
                        // name: remove it there (owner file first). The
                        // placeholder itself still blocks the public
                        // path - remove it too so the caller's retry
                        // sees an empty path; a missing residue was
                        // removed by a displaced holder's release.
                        if let Err(error) = remove_candidate_dir(&placeholder) {
                            if error.kind() != io::ErrorKind::NotFound {
                                return Err(error);
                            }
                        }
                        if let Err(error) = remove_candidate_dir(path) {
                            if error.kind() != io::ErrorKind::NotFound {
                                return Err(error);
                            }
                        }
                        return Ok(StaleClaim::Removed);
                    }
                    // A released guard's directory (its release marker
                    // written through the pinned fd, wherever exchanges
                    // carried the inode) is consumed, never restored: a
                    // dropped guard's live-pid owner record must not
                    // wedge the lock behind a lost release.
                    if released_marker(&placeholder) {
                        if let Err(error) = remove_candidate_dir(&placeholder) {
                            if error.kind() != io::ErrorKind::NotFound {
                                return Err(error);
                            }
                        }
                        if let Err(error) = remove_candidate_dir(path) {
                            if error.kind() != io::ErrorKind::NotFound {
                                return Err(error);
                            }
                        }
                        return Ok(StaleClaim::Vanished);
                    }
                    // The exchanged directory is NOT the judged incumbent:
                    // a live successor. Swap it home atomically - both
                    // paths exist throughout, so the exchange cannot fail
                    // on occupancy.
                    match rename_noreplace::exchange(path, &placeholder) {
                        Ok(()) => {
                            // The placeholder is back at its private name:
                            // remove it (owner file and claim note first).
                            if let Err(error) = remove_candidate_dir(&placeholder) {
                                if error.kind() != io::ErrorKind::NotFound {
                                    return Err(error);
                                }
                            }
                            return Ok(StaleClaim::Successor);
                        }
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {
                            // The displaced holder's release already
                            // consumed its directory at the claimed
                            // location. The placeholder still blocks the
                            // public path: clear it and retry.
                            if let Err(error) = remove_candidate_dir(path) {
                                if error.kind() != io::ErrorKind::NotFound {
                                    return Err(error);
                                }
                            }
                            return Ok(StaleClaim::Vanished);
                        }
                        Err(error) => {
                            let _ = remove_candidate_dir(&placeholder);
                            return Err(error);
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    let _ = remove_candidate_dir(&placeholder);
                    return Ok(StaleClaim::Vanished);
                }
                Err(error) if Self::rename_noreplace_unsupported(&error) => {
                    let _ = remove_candidate_dir(&placeholder);
                    return Ok(StaleClaim::Unsupported);
                }
                Err(error) => {
                    let _ = remove_candidate_dir(&placeholder);
                    return Err(error);
                }
            }
        }
        Ok(StaleClaim::Successor)
    }

    /// True when a no-replace rename failed because the kernel or
    /// filesystem does not implement it (EINVAL: the flag is unknown
    /// here; ENOSYS: no renameat2 at all; EOPNOTSUPP: the filesystem
    /// rejects the flag - NFS, FUSE and similar mounts) - the mkdir
    /// protocol is the compatible fallback. Public because the daemon's
    /// lease release needs the same classification to fall back from
    /// its no-replace claim to the identity-checked release on the same
    /// mounts where the acquisition fell back to mkdir.
    #[cfg(target_os = "linux")]
    #[must_use]
    pub fn rename_noreplace_unsupported(error: &io::Error) -> bool {
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
    fn create_by_mkdir(path: &Path, owner: Option<&str>) -> io::Result<Created> {
        fs::create_dir(path)?;
        // Every failure below removes the fresh public lock completely -
        // owner file first (a directory containing it cannot be removed),
        // then the directory, and the pinned handle (when held) closes
        // first (EBUSY on these mounts) - never leave a lock artifact
        // behind a failed acquisition, least of all one carrying a live
        // owner token (a live PID in the owner file protects the artifact
        // from stale reclaim until that process dies).
        if let Some(owner) = owner {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Err(error) = fs::set_permissions(path, fs::Permissions::from_mode(0o700)) {
                    let _ = fs::remove_dir(path);
                    return Err(error);
                }
            }
            if let Err(error) = fs::write(path.join("owner"), format!("{owner}\n")) {
                let _ = remove_candidate_dir(path);
                return Err(error);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Err(error) =
                    fs::set_permissions(path.join("owner"), fs::Permissions::from_mode(0o600))
                {
                    let _ = remove_candidate_dir(path);
                    return Err(error);
                }
            }
        }
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
                    let _ = remove_candidate_dir(path);
                }
                return Err(error);
            }
        };
        let (sec, nanos) = probe_mtime();
        if let Err(error) = set_mtime_handle(&dir, sec, nanos) {
            // Never leave a lock artifact behind a failed probe - but only
            // this handle's own inode: the path may already be taken.
            if path_pins(path, &dir) {
                drop(dir);
                let _ = remove_candidate_dir(path);
            }
            return Err(error);
        }
        Ok(dir)
    }

    /// The mkdir-protocol create for unix without a no-replace rename.
    #[cfg(all(unix, not(target_os = "linux")))]
    fn create(path: &Path, owner: Option<&str>) -> io::Result<Created> {
        Self::create_by_mkdir(path, owner)
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

    /// The mkdir is the acquisition signal; the mtime probe keeps staleness
    /// meaningful on NTFS (directory mtimes otherwise sit on the second).
    #[cfg(windows)]
    fn create(path: &Path, owner: Option<&str>) -> io::Result<Created> {
        fs::create_dir(path)?;
        let result = (|| {
            if let Some(owner) = owner {
                fs::write(path.join("owner"), format!("{owner}\n"))?;
            }
            let (sec, nanos) = probe_mtime();
            set_mtime(path, sec, nanos)
        })();
        if result.is_err() {
            // Never leave a lock artifact behind a failed owner write or
            // probe.
            let _ = fs::remove_file(path.join("owner"));
            let _ = fs::remove_dir(path);
        }
        result
    }

    #[cfg(not(any(unix, windows)))]
    fn create(path: &Path, owner: Option<&str>) -> io::Result<Created> {
        // No mtime probe on this platform: staleness is judged from the
        // filesystem's own directory mtime.
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
                if recorded
                    .as_deref()
                    .is_some_and(|owner| !Self::owner_dead(owner))
                    && !released_marker(path)
                {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!("Lock file is already being held: {}", path.display()),
                    ));
                }
                #[cfg(target_os = "linux")]
                {
                    // Airtight reclaim where renameat2 exists: under the
                    // reclaim guard (serializing this dance against every
                    // holder release pass), exchange the stale incumbent
                    // with a blocking placeholder and remove it from the
                    // private name only on a claimed-inode == snapshot
                    // match; a live successor is swapped home untouched
                    // and reported as contention - unless its release
                    // marker says its guard already dropped, in which case
                    // it is consumed instead of restored (a released
                    // guard's directory must never wedge behind its live
                    // pid record). Only the Unsupported outcome falls to
                    // the floor sequence below - the enum makes a
                    // fall-through on any other outcome unrepresentable.
                    let incumbent = {
                        use std::os::unix::fs::MetadataExt;
                        Some((metadata.dev(), metadata.ino()))
                    };
                    let guarded = try_reclaim_guard(path, Duration::from_millis(500));
                    match Self::claim_stale_incumbent(path, incumbent)? {
                        StaleClaim::Removed | StaleClaim::Vanished => return Ok(()),
                        StaleClaim::Successor => {
                            return Err(io::Error::new(
                                io::ErrorKind::WouldBlock,
                                format!("Lock file is already being held: {}", path.display()),
                            ));
                        }
                        StaleClaim::Unsupported => {}
                    }
                    drop(guarded);
                }
                // The floor reclaim (no no-replace rename): remove the
                // owner file, then the directory, by pathname - the same
                // residual check-then-act window proper-lockfile's own
                // reclaim has. A successor replacing the incumbent inside
                // this window can be removed here; unreachable on
                // supported Linux (the claim above) and documented on the
                // mounts and platforms without the primitive.
                match fs::remove_file(&owner_path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
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

    /// Release: remove the lock directory. On Linux the pinned handle's
    /// inode identity is the ownership truth, and the removal is an
    /// idempotent pass over every location that could hold it - the
    /// public path and the private location a stale-reclaim dance may
    /// have displaced it to (named by the placeholder's `claimed-at`
    /// note): each location is claimed with one atomic rename, removed
    /// only after the claimed inode still matches the pinned handle,
    /// and restored without clobbering otherwise, so the exchanges of a
    /// concurrent reclaim dance cannot make this release remove
    /// anything but its own directory - and cannot miss it either: a
    /// holder dropping mid-dance completes itself wherever its inode
    /// sits, leaving no live owner record wedged behind a lost release.
    /// The handle closes before any removal (EBUSY on the mkdir-fallback
    /// mounts). Elsewhere the floors apply: an owned lock is removed
    /// only when the owner file still records this guard, and a missing
    /// directory means someone else already reclaimed it (the TS
    /// release tolerates ENOENT); failures go to the trace log (`Drop`
    /// cannot propagate).
    pub fn release(&mut self) {
        #[cfg(target_os = "linux")]
        {
            let pinned = {
                use std::os::unix::fs::MetadataExt;
                self.dir
                    .as_ref()
                    .and_then(|dir| dir.metadata().ok())
                    .map(|metadata| (metadata.dev(), metadata.ino()))
            };
            // Serialize with any concurrent reclaim dance. Without the
            // guard within the budget (the dance's process is suspended),
            // the release marker written through the pinned fd carries
            // the release instead: the dance consumes a marked directory
            // instead of restoring it, and no judge refuses a marked
            // directory behind its live pid record.
            if let Some(guard) = try_reclaim_guard(&self.path, Duration::from_millis(500)) {
                #[cfg(unix)]
                drop(self.dir.take());
                if let Some(pinned) = pinned {
                    self.release_by_inode(&pinned);
                }
                drop(guard);
            } else {
                if let Some(dir) = self.dir.as_ref() {
                    mark_released_through(dir);
                }
                #[cfg(unix)]
                drop(self.dir.take());
            }
            #[cfg(unix)]
            drop(self.dir.take());
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        drop(self.dir.take());
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

    /// The idempotent inode-anchored release pass (Linux), under the
    /// reclaim guard: each candidate location - the public path and the
    /// private location a dance's placeholder may have displaced this
    /// guard to - is EXCHANGED with a blocking placeholder (never
    /// vacated), the exchanged content is removed only when its inode
    /// matches the pinned handle, and a mismatch is swapped back home
    /// atomically, where occupancy cannot fail. The pass re-reads its
    /// candidate locations every attempt until the removal completes.
    #[cfg(target_os = "linux")]
    fn release_by_inode(&self, pinned: &(u64, u64)) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |age| age.as_nanos());
        let pid = std::process::id();
        for attempt in 0..8 {
            let mut locations: Vec<PathBuf> = vec![self.path.clone()];
            if let Some(parent) = self.path.parent() {
                if let Ok(note) = fs::read_to_string(self.path.join("claimed-at")) {
                    let name = note.trim();
                    if !name.is_empty() {
                        locations.push(parent.join(name));
                    }
                }
            }
            for location in locations {
                if identity_at(&location) != Some(*pinned) {
                    continue;
                }
                let placeholder = location.with_file_name(format!(".b{pid:x}{nanos:x}{attempt:x}"));
                if let Err(error) = fs::create_dir(&placeholder) {
                    if error.kind() == io::ErrorKind::AlreadyExists {
                        continue;
                    }
                    return;
                }
                // The placeholder is token-protected and private-moded for
                // the whole interval it may sit at the location.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if fs::set_permissions(&placeholder, fs::Permissions::from_mode(0o700)).is_err()
                    {
                        let _ = remove_candidate_dir(&placeholder);
                        return;
                    }
                }
                if fs::write(placeholder.join("owner"), process_owner_record()).is_err() {
                    let _ = remove_candidate_dir(&placeholder);
                    return;
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(
                        placeholder.join("owner"),
                        fs::Permissions::from_mode(0o600),
                    );
                }
                match rename_noreplace::exchange(&location, &placeholder) {
                    Ok(()) => {
                        if identity_at(&placeholder) == Some(*pinned) {
                            // This guard's directory, held at the private
                            // name where nothing can replace it: remove it
                            // completely, then clear the placeholder from
                            // the location so the lock path is empty.
                            let _ = remove_candidate_dir(&placeholder);
                            let _ = remove_candidate_dir(&location);
                            return;
                        }
                        // Not this guard's content: swap it home atomically
                        // (both paths exist) and clear the placeholder at
                        // its private name.
                        let _ = rename_noreplace::exchange(&location, &placeholder);
                        let _ = remove_candidate_dir(&placeholder);
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        let _ = remove_candidate_dir(&placeholder);
                    }
                    Err(_) => {
                        let _ = remove_candidate_dir(&placeholder);
                        return;
                    }
                }
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

    /// A missing parent must fail as the real error, not as contention:
    /// the short candidate name made `ENAMETOOLONG` unreachable, so the
    /// only remaining acquisition failures are genuine I/O errors, and
    /// acquire must surface them instead of retrying a phantom lock.
    #[test]
    #[cfg(target_os = "linux")]
    fn missing_parent_is_a_real_error_not_contention() {
        let missing = Path::new("/nonexistent-pa-lock-parent-probe/foo");
        let error = LockDir::acquire(missing, MIN_STALE).unwrap_err();
        assert!(
            error.kind() == io::ErrorKind::NotFound,
            "the real missing-parent error must surface: {error}"
        );
    }

    /// A lock path whose component is near the filesystem limit still
    /// acquires: the candidate is a short, basename-independent name, so
    /// the old suffix-driven ENAMETOOLONG cannot recur.
    #[test]
    #[cfg(target_os = "linux")]
    fn long_component_lock_path_still_acquires() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("l".repeat(240));
        std::fs::write(&file, "{}").unwrap();
        {
            let guard = LockDir::acquire(&file, MIN_STALE);
            assert!(
                guard.is_ok(),
                "a near-limit component must acquire: {:?}",
                guard.err()
            );
        }
        assert!(!lock_of(&file).exists());
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
        let handle = LockDir::create_by_mkdir(&lock, None).unwrap();
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

    #[cfg(target_os = "linux")]
    #[test]
    fn displaced_owned_release_completes_at_the_claimed_location() {
        // The stale-reclaim dance displaces a live successor's directory
        // to a private name while a placeholder holds the public path.
        // The successor's guard drops during that interval: its release
        // must complete at the location the placeholder names, or the
        // still-running process's owner record wedges the lock forever.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("harness_state.json");
        let path = LockDir::path_for(&file);
        let guard =
            LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
        // Stand in for the dance: move the guard's directory to a private
        // name and seat a placeholder with a live owner record and a
        // claimed-at note at the public path.
        let displaced_dir = dir.path().join(".j-displaced-probe");
        fs::rename(&path, &displaced_dir).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("owner"), process_owner_record()).unwrap();
        fs::write(path.join("claimed-at"), ".j-displaced-probe").unwrap();
        // Drop the guard mid-dance: the release must consume the
        // displaced directory and leave the placeholder untouched.
        drop(guard);
        assert!(
            !displaced_dir.exists(),
            "the displaced release consumed its own directory at the claimed location"
        );
        assert!(
            path.join("claimed-at").exists(),
            "the placeholder stays until its own process clears it"
        );
        let _ = remove_candidate_dir(&path);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn contended_owned_acquire_leaves_no_candidate_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("harness_state.json");
        // A live incumbent at the public path: every owned acquisition
        // attempt loses the publish (EEXIST) and must clean its private
        // candidate completely - owner file included.
        let _incumbent =
            LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
        let error = LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| {
                entry.file_name().to_string_lossy().starts_with(".c")
                    || entry.file_name().to_string_lossy().contains(".lock.c")
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "contended owned acquires must not leak candidate artifacts"
        );
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
}
