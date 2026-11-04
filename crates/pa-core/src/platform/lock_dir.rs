//! Cross-process directory locks, byte-compatible with the TS product's
//! `proper-lockfile` 4.1.2 convention: ordinary locks are empty directories
//! at `{file}.lock`; harness-state locks add an owner file for safe stale reclaim.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(unix)]
use std::ffi::CStr;
#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

/// Minimum staleness threshold, like proper-lockfile's floor.
const MIN_STALE: Duration = Duration::from_secs(2);
const MAX_OWNER_RECORD_BYTES: u64 = 256;

fn read_owner_file(file: fs::File) -> io::Result<String> {
    use std::io::Read;

    let mut recorded = String::new();
    file.take(MAX_OWNER_RECORD_BYTES + 1)
        .read_to_string(&mut recorded)?;
    if recorded.len() > MAX_OWNER_RECORD_BYTES as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Lock owner record is too large",
        ));
    }
    Ok(recorded)
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LockIdentity {
    dev: libc::dev_t,
    ino: libc::ino_t,
}

#[cfg(unix)]
fn stat_at(parent: &fs::File, name: &CStr) -> io::Result<Option<libc::stat>> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(error)
        };
    }
    Ok(Some(unsafe { stat.assume_init() }))
}

#[cfg(unix)]
fn stat_file(file: &fs::File) -> io::Result<libc::stat> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { stat.assume_init() })
}

#[cfg(unix)]
fn open_lock_dir_at(parent: &fs::File, name: &CStr) -> io::Result<fs::File> {
    // A restrictive umask can remove read permission from a new lock
    // directory before its final mode is applied. Search-only handles still
    // allow owner-file operations relative to the pinned directory.
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "freebsd"))]
    let access = libc::O_PATH;
    #[cfg(any(
        target_vendor = "apple",
        target_os = "netbsd",
        target_os = "solaris",
        target_os = "illumos",
        target_os = "aix"
    ))]
    let access = libc::O_SEARCH;
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "freebsd",
        target_vendor = "apple",
        target_os = "netbsd",
        target_os = "solaris",
        target_os = "illumos",
        target_os = "aix"
    )))]
    let access = libc::O_RDONLY;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            access | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // openat returned an owned descriptor.
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn lock_identity(stat: &libc::stat) -> LockIdentity {
    LockIdentity {
        dev: stat.st_dev,
        ino: stat.st_ino,
    }
}

#[cfg(unix)]
fn read_owner_at(dir: &fs::File) -> io::Result<String> {
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c"owner".as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // openat returned an owned descriptor.
    read_owner_file(unsafe { fs::File::from_raw_fd(fd) })
}

#[cfg(all(test, unix))]
thread_local! {
    static BEFORE_LOCK_CREATE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static AFTER_LOCK_MKDIR: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static BEFORE_STALE_DIR_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

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

/// An exclusive cross-process lock on `{path}.lock`, released on drop by
/// removing the directory.
#[derive(Debug)]
pub struct LockDir {
    path: PathBuf,
    owner: Option<String>,
    #[cfg(unix)]
    parent: fs::File,
    #[cfg(unix)]
    identity: LockIdentity,
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
        #[cfg(unix)]
        let parent = {
            // Search-only handles preserve the existing ability to create a
            // lock in a writable/searchable directory without read access.
            #[cfg(any(target_os = "linux", target_os = "android"))]
            let flags = libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC;
            #[cfg(target_vendor = "apple")]
            let flags = libc::O_SEARCH | libc::O_CLOEXEC;
            #[cfg(all(
                unix,
                not(any(target_os = "linux", target_os = "android", target_vendor = "apple"))
            ))]
            let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;
            let parent_path = CString::new(Self::parent_path(&path).as_os_str().as_bytes())?;
            let fd = unsafe { libc::open(parent_path.as_ptr(), flags) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // open returned an owned descriptor.
            unsafe { fs::File::from_raw_fd(fd) }
        };
        #[cfg(all(test, unix))]
        BEFORE_LOCK_CREATE.with(|hook| {
            if let Some(callback) = hook.borrow_mut().take() {
                callback();
            }
        });
        #[cfg(unix)]
        let first_create = Self::create_at(&path, owner.as_deref(), &parent);
        #[cfg(not(unix))]
        let first_create = Self::create(&path, owner.as_deref());
        match first_create {
            Ok(created) => {
                #[cfg(not(unix))]
                let () = created;
                let guard = LockDir {
                    path,
                    owner,
                    #[cfg(unix)]
                    parent,
                    #[cfg(unix)]
                    identity: created,
                };
                #[cfg(unix)]
                Self::check_parent(&guard.parent, &guard.path)?;
                Ok(guard)
            }
            // Only an existing path is a lock collision; other failures
            // (missing parent, permissions) are real errors, never contention.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                #[cfg(unix)]
                Self::judge_and_reclaim_at(&path, stale_after, &parent)?;
                #[cfg(not(unix))]
                Self::judge_and_reclaim(&path, stale_after)?;
                // The judge path removed (or raced away) the incumbent: one
                // fresh attempt; a reappearing rival is contention.
                #[cfg(unix)]
                let next_create = Self::create_at(&path, owner.as_deref(), &parent);
                #[cfg(not(unix))]
                let next_create = Self::create(&path, owner.as_deref());
                match next_create {
                    Ok(created) => {
                        #[cfg(not(unix))]
                        let () = created;
                        let guard = LockDir {
                            path,
                            owner,
                            #[cfg(unix)]
                            parent,
                            #[cfg(unix)]
                            identity: created,
                        };
                        #[cfg(unix)]
                        Self::check_parent(&guard.parent, &guard.path)?;
                        Ok(guard)
                    }
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

    #[cfg(unix)]
    fn parent_path(path: &Path) -> &Path {
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
    }

    #[cfg(unix)]
    fn check_parent(parent: &fs::File, path: &Path) -> io::Result<()> {
        use std::os::unix::fs::MetadataExt;
        let opened = parent.metadata()?;
        let current = fs::metadata(Self::parent_path(path))?;
        if opened.dev() != current.dev() || opened.ino() != current.ino() {
            return Err(io::Error::other(
                "Lock directory parent changed while acquiring",
            ));
        }
        Ok(())
    }

    #[cfg(unix)]
    fn current_lock_matches(&self, name: &CStr) -> io::Result<bool> {
        Ok(stat_at(&self.parent, name)?.is_some_and(|stat| {
            stat.st_mode & libc::S_IFMT == libc::S_IFDIR && lock_identity(&stat) == self.identity
        }))
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
        if let Some(owner) = &self.owner {
            #[cfg(unix)]
            let matches = (|| -> io::Result<bool> {
                Self::check_parent(&self.parent, &self.path)?;
                let name = self
                    .path
                    .file_name()
                    .ok_or_else(|| io::Error::other("Lock path has no name"))?;
                let name = CString::new(name.as_bytes())?;
                if !self.current_lock_matches(&name)? {
                    return Ok(false);
                }
                let dir = open_lock_dir_at(&self.parent, &name)?;
                Ok(lock_identity(&stat_file(&dir)?) == self.identity
                    && read_owner_at(&dir).is_ok_and(|recorded| recorded.trim() == owner))
            })()
            .unwrap_or(false);
            #[cfg(not(unix))]
            let matches = Self::owner_matches(&self.path, owner);
            if !matches {
                return Err(io::Error::other(format!(
                    "harness state lock lost: {}",
                    self.path.display()
                )));
            }
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn owner_matches(path: &Path, owner: &str) -> bool {
        fs::File::open(path.join("owner"))
            .and_then(read_owner_file)
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
    /// All initialization is relative to the parent opened before acquisition;
    /// replacing an ancestor cannot put the lock or owner file elsewhere.
    #[cfg(unix)]
    fn create_at(path: &Path, owner: Option<&str>, parent: &fs::File) -> io::Result<LockIdentity> {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let name = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Lock path has no name"))?;
        let name = CString::new(name.as_bytes())?;
        let mode = if owner.is_some() { 0o700 } else { 0o777 };
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), mode) } != 0 {
            return Err(io::Error::last_os_error());
        }
        #[cfg(test)]
        AFTER_LOCK_MKDIR.with(|hook| {
            if let Some(callback) = hook.borrow_mut().take() {
                callback();
            }
        });
        let mut owned_dir: Option<fs::File> = None;
        let mut owned_dir_verified = false;
        let mut owner_file_created = false;
        let mut created_identity = None;
        let result = (|| {
            let created = stat_at(parent, &name)?
                .filter(|stat| stat.st_mode & libc::S_IFMT == libc::S_IFDIR)
                .map(|stat| lock_identity(&stat))
                .ok_or_else(|| io::Error::other("Created lock directory changed"))?;
            created_identity = Some(created);
            if let Some(owner) = owner {
                owned_dir = Some(open_lock_dir_at(parent, &name)?);
                let dir = owned_dir.as_ref().expect("opened lock directory");
                if lock_identity(&stat_file(dir)?) != created {
                    return Err(io::Error::other("Created lock directory changed"));
                }
                owned_dir_verified = true;
                // fchmod on O_PATH is unavailable; resolving "." from the
                // pinned directory handle changes this directory, not a
                // replacement at the fixed lock name.
                if unsafe { libc::fchmodat(dir.as_raw_fd(), c".".as_ptr(), 0o700, 0) } != 0 {
                    return Err(io::Error::last_os_error());
                }
                let owner_fd = unsafe {
                    libc::openat(
                        dir.as_raw_fd(),
                        c"owner".as_ptr(),
                        libc::O_WRONLY
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        0o600,
                    )
                };
                if owner_fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                owner_file_created = true;
                // openat returned an owned descriptor.
                let mut owner_file = unsafe { fs::File::from_raw_fd(owner_fd) };
                owner_file.write_all(format!("{owner}\n").as_bytes())?;
                owner_file.set_permissions(fs::Permissions::from_mode(0o600))?;
            }
            let (seconds, nanos) = probe_mtime();
            let times = [
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: nanos,
                },
                libc::timespec {
                    tv_sec: seconds,
                    tv_nsec: nanos,
                },
            ];
            if unsafe {
                libc::utimensat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    times.as_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            if !stat_at(parent, &name)?.is_some_and(|stat| lock_identity(&stat) == created) {
                return Err(io::Error::other("Created lock directory changed"));
            }
            Ok(created)
        })();
        if result.is_err() {
            if let Some(dir) = owned_dir
                .as_ref()
                .filter(|_| owned_dir_verified && owner_file_created)
            {
                let _ = unsafe { libc::unlinkat(dir.as_raw_fd(), c"owner".as_ptr(), 0) };
            }
            if created_identity.is_some_and(|created| {
                stat_at(parent, &name)
                    .ok()
                    .flatten()
                    .is_some_and(|stat| lock_identity(&stat) == created)
            }) {
                let _ = unsafe {
                    libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR)
                };
            }
        }
        result
    }

    /// Windows retains the TS-compatible path-based create and time probe.
    #[cfg(windows)]
    fn create(path: &Path, owner: Option<&str>) -> io::Result<()> {
        fs::create_dir(path)?;
        let result = (|| {
            if let Some(owner) = owner {
                fs::write(path.join("owner"), format!("{owner}\n"))?;
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
    #[cfg(unix)]
    fn judge_and_reclaim_at(
        path: &Path,
        stale_after: Duration,
        parent: &fs::File,
    ) -> io::Result<()> {
        let name = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Lock path has no name"))?;
        let name = CString::new(name.as_bytes())?;
        let Some(stat) = stat_at(parent, &name)? else {
            return Ok(());
        };
        let kind = stat.st_mode & libc::S_IFMT;
        let incumbent = lock_identity(&stat);
        if kind == libc::S_IFREG {
            if Self::legacy_flock_held_at(parent, &name) {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!("Lock file is already being held: {}", path.display()),
                ));
            }
            match stat_at(parent, &name)? {
                None => return Ok(()),
                Some(current) if lock_identity(&current) == incumbent => {}
                Some(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!(
                            "Lock file changed while being reclaimed: {}",
                            path.display()
                        ),
                    ));
                }
            }
            if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(error)
            };
        }
        if kind == libc::S_IFDIR {
            let now_ns = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as i128;
            let modified_ns =
                i128::from(stat.st_mtime) * 1_000_000_000 + i128::from(stat.st_mtime_nsec);
            if now_ns.saturating_sub(modified_ns) > stale_after.as_nanos() as i128 {
                #[cfg(test)]
                BEFORE_STALE_DIR_OPEN.with(|hook| {
                    if let Some(callback) = hook.borrow_mut().take() {
                        callback();
                    }
                });
                let dir = match open_lock_dir_at(parent, &name) {
                    Ok(dir) => dir,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error),
                };
                if lock_identity(&stat_file(&dir)?) != incumbent {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!(
                            "Lock directory changed while being reclaimed: {}",
                            path.display()
                        ),
                    ));
                }
                if read_owner_at(&dir)
                    .ok()
                    .as_deref()
                    .is_some_and(|owner| !Self::owner_dead(owner))
                {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!("Lock file is already being held: {}", path.display()),
                    ));
                }
                if unsafe { libc::unlinkat(dir.as_raw_fd(), c"owner".as_ptr(), 0) } != 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::NotFound {
                        return Err(error);
                    }
                }
                match stat_at(parent, &name)? {
                    None => return Ok(()),
                    Some(current) if lock_identity(&current) == incumbent => {}
                    Some(_) => {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            format!(
                                "Lock directory changed while being reclaimed: {}",
                                path.display()
                            ),
                        ));
                    }
                }
                if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }
                    != 0
                {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::NotFound {
                        return Err(error);
                    }
                }
                return Ok(());
            }
        }
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("Lock file is already being held: {}", path.display()),
        ))
    }

    #[cfg(not(unix))]
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
                let recorded = fs::File::open(&owner_path).and_then(read_owner_file).ok();
                if recorded
                    .as_deref()
                    .is_some_and(|owner| !Self::owner_dead(owner))
                {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!("Lock file is already being held: {}", path.display()),
                    ));
                }
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
    fn legacy_flock_held_at(parent: &fs::File, name: &CStr) -> bool {
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return false;
        }
        // openat returned an owned descriptor.
        let file = unsafe { fs::File::from_raw_fd(fd) };
        (unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
            && io::Error::last_os_error().kind() == io::ErrorKind::WouldBlock)
    }

    /// Release: remove the lock directory. A missing directory means someone
    /// else already reclaimed it (the TS release tolerates ENOENT); other
    /// failures go to the trace log (`Drop` cannot propagate).
    pub fn release(&self) {
        #[cfg(unix)]
        {
            let Some(name) = self.path.file_name() else {
                tracing::warn!(
                    "failed to release lock {}: missing file name",
                    self.path.display()
                );
                return;
            };
            let Ok(name) = CString::new(name.as_bytes()) else {
                tracing::warn!(
                    "failed to release lock {}: invalid file name",
                    self.path.display()
                );
                return;
            };
            match self.current_lock_matches(&name) {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => {
                    tracing::warn!("failed to release lock {}: {error}", self.path.display());
                    return;
                }
            }
            if let Some(owner) = &self.owner {
                // Open the lock relative to its original parent. A renamed
                // ancestor cannot redirect the owner check or cleanup.
                let Ok(dir) = open_lock_dir_at(&self.parent, &name) else {
                    return;
                };
                if !stat_file(&dir).is_ok_and(|stat| lock_identity(&stat) == self.identity) {
                    return;
                }
                if !read_owner_at(&dir).is_ok_and(|recorded| recorded.trim() == owner) {
                    return;
                }
                if unsafe { libc::unlinkat(dir.as_raw_fd(), c"owner".as_ptr(), 0) } != 0 {
                    tracing::warn!(
                        "failed to release lock {}: {}",
                        self.path.display(),
                        io::Error::last_os_error()
                    );
                    return;
                }
            }
            match self.current_lock_matches(&name) {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => {
                    tracing::warn!("failed to release lock {}: {error}", self.path.display());
                    return;
                }
            }
            if unsafe { libc::unlinkat(self.parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }
                != 0
            {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::NotFound {
                    tracing::warn!("failed to release lock {}: {error}", self.path.display());
                }
            }
        }
        #[cfg(not(unix))]
        {
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

    #[cfg(unix)]
    fn in_restrictive_umask_subprocess(test_filter: &str, check: impl FnOnce()) {
        if std::env::var_os("PRIME_LOCK_DIR_UMASK_CHILD").is_some() {
            unsafe { libc::umask(0o477) };
            check();
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg(test_filter)
            .arg("--test-threads=1")
            .arg("--nocapture")
            .env("PRIME_LOCK_DIR_UMASK_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "restricted-umask child failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

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

    #[cfg(unix)]
    #[test]
    fn release_removes_its_original_lock_after_an_ancestor_swap() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let moved = root.path().join("project-moved");
        let outside = root.path().join("outside");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&outside).unwrap();
        let guard = LockDir::acquire(&project.join("settings.json"), MIN_STALE).unwrap();
        let original_lock = moved.join("settings.json.lock");
        let outside_lock = outside.join("settings.json.lock");
        fs::create_dir(&outside_lock).unwrap();

        fs::rename(&project, &moved).unwrap();
        symlink(&outside, &project).unwrap();
        drop(guard);

        assert!(
            outside_lock.is_dir(),
            "release must not remove a foreign lock"
        );
        assert!(!original_lock.exists(), "release must remove its own lock");
    }

    #[cfg(unix)]
    #[test]
    fn acquisition_does_not_create_an_owned_lock_in_a_swapped_parent() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let moved = root.path().join("project-moved");
        let outside = root.path().join("outside");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&outside).unwrap();
        let file = project.join("state.json");
        let outside_lock = outside.join("state.json.lock");

        BEFORE_LOCK_CREATE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                fs::rename(&project, &moved).unwrap();
                symlink(&outside, &project).unwrap();
            }));
        });
        let result = LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE);

        assert!(
            result.is_err(),
            "a changed parent path must stop acquisition"
        );
        assert!(
            !outside_lock.exists(),
            "acquisition must not leave an external lock"
        );
        assert!(
            !root.path().join("project-moved/state.json.lock").exists(),
            "a failed owned acquisition must remove the lock it created"
        );
    }

    #[cfg(unix)]
    #[test]
    fn stale_reclaim_does_not_remove_a_lock_in_a_swapped_parent() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let moved = root.path().join("project-moved");
        let outside = root.path().join("outside");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&outside).unwrap();
        let file = project.join("state.json");
        let project_lock = LockDir::path_for(&file);
        let outside_lock = outside.join("state.json.lock");
        fs::create_dir(&project_lock).unwrap();
        fs::create_dir(&outside_lock).unwrap();
        set_mtime(&project_lock, 1, 0).unwrap();
        set_mtime(&outside_lock, 1, 0).unwrap();

        BEFORE_LOCK_CREATE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                fs::rename(&project, &moved).unwrap();
                symlink(&outside, &project).unwrap();
            }));
        });
        let result = LockDir::acquire(&file, MIN_STALE);

        assert!(
            result.is_err(),
            "a changed parent path must stop acquisition"
        );
        assert!(
            outside_lock.is_dir(),
            "reclaim must not remove an external lock"
        );
        assert!(
            !root.path().join("project-moved/state.json.lock").exists(),
            "a failed acquisition must clean up only the lock it created"
        );
    }

    #[cfg(unix)]
    #[test]
    fn release_removes_its_original_lock_after_a_regular_directory_swap() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let moved = root.path().join("project-moved");
        let outside = root.path().join("outside");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&outside).unwrap();
        let guard = LockDir::acquire(&project.join("settings.json"), MIN_STALE).unwrap();
        let original_lock = moved.join("settings.json.lock");
        let outside_lock = outside.join("settings.json.lock");
        fs::create_dir(&outside_lock).unwrap();

        fs::rename(&project, &moved).unwrap();
        fs::rename(&outside, &project).unwrap();
        drop(guard);
        fs::rename(&project, &outside).unwrap();

        assert!(
            outside_lock.is_dir(),
            "release must not remove a foreign lock"
        );
        assert!(!original_lock.exists(), "release must remove its own lock");
    }

    #[cfg(unix)]
    #[test]
    fn release_keeps_a_replacement_lock_in_the_original_parent() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("settings.json");
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let lock = LockDir::path_for(&file);
        let moved = root.path().join("original-lock");
        fs::rename(&lock, &moved).unwrap();
        fs::create_dir(&lock).unwrap();

        drop(guard);

        assert!(lock.is_dir(), "release must not remove a replacement lock");
        assert!(
            moved.is_dir(),
            "the original lock was moved by another writer"
        );
    }

    #[cfg(unix)]
    #[test]
    fn owned_release_checks_and_removes_its_original_owner_file() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let moved = root.path().join("project-moved");
        let outside = root.path().join("outside");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&outside).unwrap();
        let guard = LockDir::acquire_owned_retrying(
            &project.join("state.json"),
            Duration::from_secs(10),
            1,
            MIN_STALE,
        )
        .unwrap();
        let outside_lock = outside.join("state.json.lock");
        fs::create_dir(&outside_lock).unwrap();
        let recorded = fs::read_to_string(guard.path.join("owner")).unwrap();
        fs::write(outside_lock.join("owner"), &recorded).unwrap();

        fs::rename(&project, &moved).unwrap();
        symlink(&outside, &project).unwrap();
        drop(guard);

        assert_eq!(
            fs::read_to_string(outside_lock.join("owner")).unwrap(),
            recorded
        );
        assert!(!moved.join("state.json.lock").exists());
    }

    #[cfg(unix)]
    #[test]
    fn owned_check_rejects_a_copied_token_in_a_swapped_parent() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let moved = root.path().join("project-moved");
        let outside = root.path().join("outside");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&outside).unwrap();
        let file = project.join("state.json");
        let guard =
            LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
        let recorded = fs::read_to_string(guard.path.join("owner")).unwrap();
        let outside_lock = outside.join("state.json.lock");
        fs::create_dir(&outside_lock).unwrap();
        fs::write(outside_lock.join("owner"), recorded).unwrap();

        fs::rename(&project, &moved).unwrap();
        symlink(&outside, &project).unwrap();

        assert!(guard.ensure_owned().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn linked_lock_parent_keeps_its_layout_and_cleans_up() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real-project");
        let linked = root.path().join("linked-project");
        fs::create_dir(&real).unwrap();
        symlink(&real, &linked).unwrap();
        let file = linked.join("settings.json");
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let target_lock = real.join("settings.json.lock");

        assert!(target_lock.is_dir());
        assert!(fs::read_dir(&target_lock).unwrap().next().is_none());
        drop(guard);

        assert!(!target_lock.exists());
        assert!(fs::symlink_metadata(linked)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn writable_searchable_parent_does_not_need_read_permission() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let restricted = root.path().join("restricted");
        fs::create_dir(&restricted).unwrap();
        fs::set_permissions(&restricted, fs::Permissions::from_mode(0o300)).unwrap();
        let file = restricted.join("settings.json");
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        assert!(lock_of(&file).is_dir());
        drop(guard);
        assert!(!lock_of(&file).exists());
        fs::set_permissions(&restricted, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn owned_lock_acquires_with_restrictive_umask() {
        in_restrictive_umask_subprocess("owned_lock_acquires_with_restrictive_umask", || {
            use std::os::unix::fs::PermissionsExt;

            let root = tempfile::tempdir().unwrap();
            let file = root.path().join("harness_state.json");
            let guard = LockDir::acquire_owned_retrying(&file, MIN_STALE, 1, MIN_STALE).unwrap();
            assert_eq!(
                fs::metadata(&guard.path).unwrap().permissions().mode() & 0o777,
                0o700
            );
            guard.ensure_owned().unwrap();
            drop(guard);
            assert!(!LockDir::path_for(&file).exists());
        });
    }

    #[cfg(unix)]
    #[test]
    fn stale_lock_reclaims_with_restrictive_umask() {
        in_restrictive_umask_subprocess("stale_lock_reclaims_with_restrictive_umask", || {
            let root = tempfile::tempdir().unwrap();
            let file = root.path().join("settings.json");
            let lock = LockDir::path_for(&file);
            fs::create_dir(&lock).unwrap();
            set_mtime(&lock, 1, 0).unwrap();
            let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
            drop(guard);
            assert!(!lock.exists());
        });
    }

    #[cfg(unix)]
    #[test]
    fn stale_lock_vanishing_before_open_allows_retry() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("settings.json");
        let lock = LockDir::path_for(&file);
        fs::create_dir(&lock).unwrap();
        set_mtime(&lock, 1, 0).unwrap();
        BEFORE_STALE_DIR_OPEN.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || fs::remove_dir(&lock).unwrap()));
        });
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        drop(guard);
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
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("harness_state.json");
        let guard =
            LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
        assert_eq!(
            fs::metadata(&guard.path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(guard.path.join("owner"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        set_mtime(&guard.path, 1, 0).unwrap();
        let error = LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        guard.ensure_owned().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn owned_lock_is_private_from_the_mkdir_step() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("state.json");
        let lock = LockDir::path_for(&file);
        let observed = std::rc::Rc::new(std::cell::Cell::new(None));
        let observed_in_hook = observed.clone();
        AFTER_LOCK_MKDIR.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                let mode = fs::metadata(&lock).unwrap().permissions().mode() & 0o777;
                observed_in_hook.set(Some(mode));
            }));
        });

        let guard =
            LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
        assert_eq!(observed.get().unwrap() & 0o077, 0);
        drop(guard);
    }

    #[cfg(unix)]
    #[test]
    fn oversized_owner_record_is_rejected_without_reading_it_all() {
        let root = tempfile::tempdir().unwrap();
        let owner = root.path().join("owner");
        fs::write(&owner, vec![b'x'; 257]).unwrap();
        let dir = fs::File::open(root.path()).unwrap();

        let error = read_owner_at(&dir).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
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
