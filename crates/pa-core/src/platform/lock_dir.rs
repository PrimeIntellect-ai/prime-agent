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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// The process-local registry of witnessed guard paths currently held by
/// THIS process: the same-process arm of the takeover protocol. On
/// macOS/BSD `flock` is per-process (a probe by the holder's own process
/// succeeds, and closing the probe fd releases the process's locks), so
/// every `flock` probe this module runs must be CROSS-PROCESS by
/// construction - the registry answers same-process contention here,
/// before any probe: the path is in the set exactly while a `LockDir`
/// witness of this process holds it, and the in-process guard callers
/// (the daemon's registry re-entrancy) serialize on this set through
/// their `WouldBlock` retry ladders, the same signal a cross-process
/// holder produces.
#[cfg(unix)]
fn held_by_this_process() -> &'static Mutex<std::collections::HashSet<PathBuf>> {
    static HELD: std::sync::OnceLock<Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    HELD.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// Same-process contention: the path is registered while a witness of
/// this process holds it.
#[cfg(unix)]
fn locally_held(path: &Path) -> bool {
    held_by_this_process()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(path)
}

/// Register a witnessed path as held by this process.
#[cfg(unix)]
fn register_locally_held(path: &Path) {
    held_by_this_process()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(path.to_path_buf());
}

/// Unregister a witnessed path (any release/abandonment path).
#[cfg(unix)]
fn unregister_locally_held(path: &Path) {
    held_by_this_process()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(path);
}

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

    /// `winbase.h` `BY_HANDLE_FILE_INFORMATION`, the
    /// `GetFileInformationByHandle` output: the per-file identity fields
    /// the lock ownership comparison reads are `nFileIndexHigh/Low`.
    #[repr(C)]
    struct ByHandleFileInformation {
        dwFileAttributes: u32,
        ftCreationTime: FileTime,
        ftLastAccessTime: FileTime,
        ftLastWriteTime: FileTime,
        dwVolumeSerialNumber: u32,
        nFileSizeHigh: u32,
        nFileSizeLow: u32,
        nNumberOfLinks: u32,
        nFileIndexHigh: u32,
        nFileIndexLow: u32,
    }

    extern "system" {
        fn GetFileInformationByHandle(
            handle: Handle,
            file_information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    /// The directory's file index, the number Node reports as `ino` on
    /// Windows (`statSync(..., { bigint: true }).ino`) and the TS
    /// `guardStolen` compare runs against. `None` when the open or the
    /// query fails, or on a volume with no per-file identity (a zero
    /// index) - the TS `guardIno === undefined` arm.
    pub(crate) fn file_index(path: &Path) -> Option<u64> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        // A zero desired-access handle carries only metadata queries, so
        // the identity read works even where attribute writes are denied.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                0,
                FILE_SHARE_ALL,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if handle as isize == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut information = ByHandleFileInformation {
            dwFileAttributes: 0,
            ftCreationTime: FileTime {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            ftLastAccessTime: FileTime {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            ftLastWriteTime: FileTime {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            dwVolumeSerialNumber: 0,
            nFileSizeHigh: 0,
            nFileSizeLow: 0,
            nNumberOfLinks: 0,
            nFileIndexHigh: 0,
            nFileIndexLow: 0,
        };
        let ok =
            unsafe { GetFileInformationByHandle(handle, std::ptr::from_mut(&mut information)) };
        unsafe { CloseHandle(handle) };
        if ok == 0 {
            return None;
        }
        let index =
            (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
        (index != 0).then_some(index)
    }
}

/// The witness handle type: the owned directory fd where the platform
/// has a directory `flock` (unix), a unit elsewhere (`Option<()>` keeps
/// the field and the `mut self` of the consuming releases uniform across
/// platforms; the witness is never taken there).
#[cfg(unix)]
type WitnessFd = std::os::fd::OwnedFd;
#[cfg(not(unix))]
type WitnessFd = ();

/// An exclusive cross-process lock on `{path}.lock`, released on drop by
/// removing the directory. The directory's ownership identity is captured
/// at acquisition - the inode (TS `guardIno`) and the mtime probe the
/// acquisition itself wrote (proper-lockfile's remembered `lock.mtime`) -
/// so a long hold can re-check whose lock it still is (the TS sync lock's
/// compromise rules). On unix the acquisition also holds an `flock` on
/// the directory itself ([`LockDir::witness_fd`]): a kernel-witnessed
/// live-holder claim the mtime/inode pair cannot forge, so one rust
/// process never reclaims another live rust holder's lock however long
/// the holder stalls (the stale mtime stays the DEAD-holder heuristic it
/// was always meant to be; proper-lockfile itself takes no flock, so a
/// TS successor is untouched by it - the divergence is disclosed at
/// [`LockDir::witness_fd`]).
#[derive(Debug)]
pub struct LockDir {
    path: PathBuf,
    /// Whether this guard's removal was already handled (a guarded
    /// removal or an abandonment set it): Drop's plain release runs at
    /// most once, so a successor's fresh lock at the vacated path never
    /// sees a second rmdir - while the guard still drops NORMALLY (its
    /// heap fields freed, its registry entry unregistered), never
    /// forgotten whole.
    finished: AtomicBool,
    /// The lock directory's identity captured at acquisition (the inode;
    /// TS `guardIno`), `None` where the platform cannot observe it.
    owned: Option<u64>,
    /// The `flock`-witnessed handle on the acquired directory (unix; see
    /// [`LockDir::witness_fd`]). `None` where the platform has no
    /// directory `flock`. The fd pins this guard's inode for its whole
    /// lifetime and closes with it, so a crashed holder's witness
    /// vanishes with its process - the crash-oracle contract.
    witness: Option<WitnessFd>,
    /// The (sec, nsec) mtime probe this guard last wrote (proper-lockfile's
    /// `lock.mtime`: the updater records the exact value its `utimes` call
    /// wrote, and its `isMtimeOurs` equality - a lock whose observed mtime
    /// is not that value carries someone else's touch - is the mtime half
    /// of ownership this port had dropped; the inode is the other half).
    /// `None` where the platform has no probe. Behind a mutex because the
    /// refresher thread (the TS update timer) records each tick while the
    /// guarded release reads the record.
    owned_mtime: Mutex<Option<(i64, i64)>>,
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
        let path = Self::path_for(file);
        Self::acquire_unguarded(&path, stale_after, false)
    }

    /// [`LockDir::acquire`] at an explicit lock-directory path - for
    /// protocols that name the lock directory itself (the TS supervisor
    /// registry guard locks its directory at `<registryDir>/.guard`, not
    /// at `<file>.lock`), so a rust process and a TS process serialize on
    /// the SAME on-disk lock. This path takes the live-holder witness
    /// ([`LockDir::witness_fd`]): a rust holder's lock cannot be
    /// stale-reclaimed by another rust process while it lives.
    ///
    /// # Errors
    ///
    /// Returns [`io::ErrorKind::WouldBlock`] when a fresh lock is held by
    /// another process, and any underlying I/O error (missing parent,
    /// permissions, stale-reclaim failures) as-is.
    pub fn acquire_at(path: &Path, stale_after: Duration) -> io::Result<Self> {
        Self::acquire_unguarded(path, stale_after, true)
    }

    /// The shared acquisition core: `witnessed` decides whether the guard
    /// takes the live-holder `flock` (the registry-guard path does; the
    /// `{file}.lock` convention does not, keeping proper-lockfile's pure
    /// mtime protocol for those users).
    fn acquire_unguarded(path: &Path, stale_after: Duration, witnessed: bool) -> io::Result<Self> {
        let path = path.to_path_buf();
        let stale_after = stale_after.max(MIN_STALE);
        // Same-process contention first (unix): a witnessed guard already
        // held by THIS process is answered from the registry - before any
        // `flock` probe runs - so probes stay cross-process by
        // construction. The in-process re-entrancy (the daemon's renewal
        // thread against a guard caller) serializes on this `WouldBlock`
        // through the caller's retry ladder, exactly like cross-process
        // contention.
        #[cfg(unix)]
        if witnessed && locally_held(&path) {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("Lock file is already being held: {}", path.display()),
            ));
        }
        match Self::create(&path) {
            Ok(probe) => Self::acquired(path, probe, witnessed),
            // Only an existing path is a lock collision; any other failure
            // (missing parent, permissions) is a real error, like the TS
            // protocol's non-EEXIST path - never masked as contention.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Self::judge_and_reclaim(&path, stale_after)?;
                // The judge path removed (or raced away) the incumbent: one
                // fresh attempt; a reappearing rival is contention.
                match Self::create(&path) {
                    Ok(probe) => Self::acquired(path, probe, witnessed),
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
    /// same way, right after acquisition). The freshly stat'ed mtime must
    /// be the probe `create` just wrote: a suspension between the mkdir
    /// and this stat lets the fresh lock age past the staleness
    /// threshold, and a successor's rmdir+mkdir swaps in a replacement
    /// carrying the successor's OWN probe - adopting that directory would
    /// make this guard refresh and release the successor's lock. A
    /// mismatch is the same WOULDBLOCK-style contention `judge_and_reclaim`
    /// reports for a fresh rival (the caller ladders retry on it), never a
    /// silent success on a foreign directory.
    ///
    /// The comparison is exact equality on the (sec, nsec) pair, no
    /// tolerance: the probe writes the pair verbatim through
    /// `utimensat`/`SetFileTime`, the stat round trip preserves it
    /// (`mtime_matches_the_proper_lockfile_probe_shape` pins the shape),
    /// and proper-lockfile's `isMtimeOurs` is the same exact `getTime()`
    /// compare. Verified only where the inode is observable: an
    /// unstat'able directory keeps the TS `guardIno === undefined`
    /// convention (timer-driven detection only), and a platform without a
    /// probe has no value to compare.
    fn acquired(path: PathBuf, probe: Option<(i64, i64)>, witnessed: bool) -> io::Result<Self> {
        let owned = Self::ownership_id(&path);
        let adopted = match (owned, probe) {
            // Both identity halves observable: the directory at the path
            // must carry the probe this process just wrote.
            (Some(_), Some(probe)) => Self::observed_mtime(&path) == Some(probe),
            // No identity half to verify: adoption as before.
            (None, _) | (_, None) => true,
        };
        if !adopted {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("Lock file is already being held: {}", path.display()),
            ));
        }
        // The live-holder witness: an flock on the directory just created,
        // taken while the identity pair is still verifiably ours. A WouldBlock
        // here means the directory changed hands between the probe check and
        // the flock - the same contention, never an adoption. The witnessed
        // path is registered in the process-local set the same moment, so
        // same-process re-entrancy sees contention BEFORE any probe runs
        // (the per-process flock platforms - macOS/BSD - stay sound).
        #[cfg(unix)]
        let witness = if witnessed {
            match Self::witness_fd(&path) {
                Ok(witness) => witness,
                Err(error) => {
                    // The directory this process just created could not be
                    // witnessed (it changed hands in the microsecond window,
                    // or the flock failed): the acquisition unwinds, and the
                    // artifact must not stay orphaned at the path (a fresh
                    // orphan wedges every other holder for the whole
                    // staleness window). Remove it when it is still
                    // verifiably ours - park-capture first, re-verify on the
                    // parked name (the same discipline as the guarded
                    // release), never the successor's.
                    Self::remove_owned_artifact(&path, owned, probe);
                    return Err(error);
                }
            }
        } else {
            None
        };
        #[cfg(not(unix))]
        let witness: Option<WitnessFd> = {
            // No directory flock off-unix: the witness is never taken (the
            // flag stays read here for the signature's uniformity).
            let _ = witnessed;
            None
        };
        #[cfg(unix)]
        if witness.is_some() {
            register_locally_held(&path);
        }
        Ok(LockDir {
            owned,
            owned_mtime: Mutex::new(probe),
            witness,
            finished: AtomicBool::new(false),
            path,
        })
    }

    /// The `flock`-witnessed directory handle: a kernel truth the stat-based
    /// identity pair cannot forge. On unix the acquisition opens the created
    /// directory and holds an exclusive non-blocking `flock` on it for the
    /// lock's whole lifetime; [`LockDir::judge_and_reclaim`]'s takeover gate
    /// then refuses a stale mtime while a live holder's fd still flocks the
    /// directory (the takeover waits, the way it should, for the holder's
    /// process to die), so the inode/mtime pair can never collide in a
    /// rust-to-rust takeover - the pair stays the protection against
    /// flock-blind takers (TS proper-lockfile) alone. This is a deliberate
    /// hardening divergence from proper-lockfile 4.1.2, which takes no
    /// flock: the lock directory's bytes, mtime shape, and staleness
    /// protocol are untouched (a TS process reads the lock exactly as
    /// before; an `flock` is invisible to it), and on the crash-oracle
    /// nothing changes - a dead holder's fd is closed by the kernel with
    /// its process, freeing the witness exactly when the stale heuristic
    /// wants it. The `{file}.lock` convention (`acquire`) never takes the
    /// witness, so its incumbents always pass the takeover gate instantly.
    /// Unix only: the platforms without a directory `flock` keep the
    /// identity checks as the whole protection.
    #[cfg(unix)]
    fn witness_fd(path: &Path) -> io::Result<Option<WitnessFd>> {
        {
            use std::os::fd::AsRawFd;
            let fd = match fs::File::open(path) {
                Ok(dir) => dir,
                // The directory vanished (a racing release): the caller's
                // retry ladder owns it - plain contention, like the TS
                // protocol's ELOCKED family.
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!("Lock file is already being held: {}", path.display()),
                    ));
                }
                Err(error) => return Err(error),
            };
            // The flock witness runs on every unix platform. On Linux it is
            // per-open-file-description (a second open in the SAME process
            // conflicts with the first holder's lock); on macOS/BSD it is
            // PER-PROCESS (a probe by the holder's own process succeeds,
            // and closing the probe fd releases the process's locks). The
            // per-process platforms are handled by the registry layer:
            // same-process contention is answered by `locally_held`
            // BEFORE any probe runs (see `acquire_unguarded`), so every
            // `flock` this module takes or probes is cross-process by
            // construction - sound everywhere. The registry also covers
            // the daemon's in-process guard re-entrancy (the renewal
            // thread and the guard callers serialize through the
            // `WouldBlock` ladder on the registered path).
            //
            // An open directory fd carries no write state (O_RDONLY), so
            // the flock is only the witness; it closes with the handle.
            let held = unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if held != 0 {
                let error = io::Error::last_os_error();
                return match error.kind() {
                    io::ErrorKind::WouldBlock => Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!("Lock file is already being held: {}", path.display()),
                    )),
                    // The NFS emulation signature: exclusive flock on
                    // NFS is a client-side fcntl lock, and a fcntl write
                    // lock needs a WRITABLE descriptor - a directory can
                    // never be opened writable (EISDIR everywhere), so an
                    // NFS-mounted registry cannot carry the witness at
                    // all. Degrade to the witness-less protocol
                    // (proper-lockfile's own: it never flocks, and its
                    // mtime-only guard works on NFS) instead of failing
                    // the whole acquisition.
                    io::ErrorKind::PermissionDenied => {
                        tracing::warn!(
                            "the directory lock cannot take an exclusive flock at {} (an NFS-style filesystem: the witness degrades to the mtime-only protocol)",
                            path.display()
                        );
                        Ok(None)
                    }
                    _ => Err(error),
                };
            }
            Ok(Some(fd.into()))
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

    /// The lock directory's identity on Windows: the NTFS file index
    /// (`GetFileInformationByHandle`'s `nFileIndexHigh/Low`), the same
    /// number Node's `statSync(guardPath, { bigint: true }).ino` reports
    /// and the TS `guardStolen` comparison runs on Windows. A zero index
    /// (FAT-family volumes, where no per-file identity exists) reads as
    /// unobservable - TS's `guardIno === undefined` arm, timer-driven
    /// detection only.
    #[cfg(windows)]
    fn ownership_id(path: &Path) -> Option<u64> {
        win32::file_index(path)
    }

    /// No directory identity observable on this platform (TS
    /// `guardIno === undefined`): only timer-driven detection applies.
    #[cfg(not(any(unix, windows)))]
    fn ownership_id(_path: &Path) -> Option<u64> {
        None
    }

    /// The lock directory's observed mtime as the (sec, nsec) pair the
    /// probe writes - the half of the ownership identity proper-lockfile's
    /// updater runs its `isMtimeOurs` equality against (the value a
    /// successor's own probe overwrites). `None` when the directory cannot
    /// be stat'ed - the TS `catch` arm.
    fn observed_mtime(path: &Path) -> Option<(i64, i64)> {
        let modified = fs::symlink_metadata(path).ok()?.modified().ok()?;
        let since_epoch = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
        Some((
            since_epoch.as_secs() as i64,
            i64::from(since_epoch.subsec_nanos()),
        ))
    }

    /// The mkdir is the acquisition signal: EEXIST is the only collision.
    /// Returns the probe the write stamped - the mtime half of the
    /// acquisition identity (proper-lockfile's probe hands its `stat.mtime`
    /// back to the lock object the same way).
    #[cfg(unix)]
    fn create(path: &Path) -> io::Result<Option<(i64, i64)>> {
        fs::create_dir(path)?;
        let (sec, nanos) = probe_mtime();
        if let Err(error) = set_mtime(path, sec, nanos) {
            // Never leave a lock artifact behind a failed probe.
            let _ = fs::remove_dir(path);
            return Err(error);
        }
        Ok(Some((sec, nanos)))
    }

    /// The mkdir is the acquisition signal; the mtime probe makes the
    /// staleness judgment meaningful on NTFS too (directory mtimes would
    /// otherwise sit on the second, and stale takeovers would misjudge).
    #[cfg(windows)]
    fn create(path: &Path) -> io::Result<Option<(i64, i64)>> {
        fs::create_dir(path)?;
        let (sec, nanos) = probe_mtime();
        if let Err(error) = set_mtime(path, sec, nanos) {
            // Never leave a lock artifact behind a failed probe.
            let _ = fs::remove_dir(path);
            return Err(error);
        }
        Ok(Some((sec, nanos)))
    }

    #[cfg(not(any(unix, windows)))]
    fn create(path: &Path) -> io::Result<Option<(i64, i64)>> {
        // No mtime probe on this platform: staleness is judged from the
        // filesystem's own directory mtime.
        fs::create_dir(path)?;
        Ok(None)
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
        if !metadata.is_dir() {
            // Live lock: contention.
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("Lock file is already being held: {}", path.display()),
            ));
        }
        // Pre-judge on the original stat: a fresh lock is plain contention
        // and never parked (the park is the stale-removal step alone - a
        // contender parking a fresh rival's lock would churn every retry).
        let modified = metadata.modified()?;
        let age = std::time::SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default();
        if age <= stale_after {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("Lock file is already being held: {}", path.display()),
            ));
        }
        // The live-holder witness gate, ON THE PATH and BEFORE the park:
        // a stale mtime never reclaims a directory a live rust holder
        // still flocks - the takeover waits for the holder's process to
        // die, the way the stale heuristic always wanted. Gate before park
        // matters: parking a LIVE incumbent would vacate the public path
        // under its holder's feet (a contender could take the path while
        // the holder's action still runs) - only a flock-FREE incumbent,
        // one whose holder is dead (its fd closed, the witness released),
        // may be captured and vacated, exactly like the plain rmdir this
        // replaces. The gate's flock attempt resolves the path's CURRENT
        // occupant, and a flock-free incumbent cannot GAIN a live holder
        // in the gate-to-park window (its holder is dead - permanently).
        #[cfg(unix)]
        {
            if Self::dir_flock_held(path) {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!("Lock file is already being held: {}", path.display()),
                ));
            }
        }
        // The occupant CLAIM, held through the capture (the `_claim`
        // binding keeps its fd open until this reclaim returns): an
        // exclusive flock on the incumbent itself, taken on the path's
        // CURRENT directory. A live rust holder that raced onto the path
        // since the gate blocks the claim (contention - the capture never
        // touches a live lock), and while the claim is held no rust actor
        // can replace the incumbent (every rust takeover gates on this
        // flock), so the park below captures exactly the directory the
        // claim verified.
        #[cfg(unix)]
        let _claim = match Self::claim_occupant(path, stale_after) {
            Ok(claim) => claim,
            // A live occupant under the claim: contention.
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!("Lock file is already being held: {}", path.display()),
                ));
            }
            // The occupant vanished mid-claim: retry the create.
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        // The stale candidate: the atomic capture - whatever the path
        // holds goes to the park, and every check runs ON THE PARKED NAME,
        // where no other process can swap the directory between a check
        // and the act.
        let parked = Self::park_name_of(path);
        match fs::rename(path, &parked) {
            // A racing holder released it first: retry the create.
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
            Ok(()) => {}
        }
        // The staleness re-judge, on the parked name: the directory the
        // capture took may be a replacement that arrived after the first
        // stat judged stale - its fresh mtime says so here, harmlessly.
        let parked_metadata = match fs::symlink_metadata(&parked) {
            Ok(metadata) => metadata,
            // Vanished (nothing creates park names; a concurrent park of
            // the same lock is impossible): treat as reclaimed.
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if parked_metadata.is_dir() {
            let parked_modified = parked_metadata.modified()?;
            let parked_age = std::time::SystemTime::now()
                .duration_since(parked_modified)
                .unwrap_or_default();
            if parked_age > stale_after {
                // Stale: remove the parked name and let the caller retry.
                match fs::remove_dir(&parked) {
                    Ok(()) => return Ok(()),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error),
                }
            }
        }
        // A live or fresh replacement lock: put it back, never removed.
        Self::restore_parked(&parked, path)?;
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("Lock file is already being held: {}", path.display()),
        ))
    }

    /// The park name for an atomic capture of the lock directory: unique
    /// per process and per capture (the park is created by exactly one
    /// process and no protocol ever looks at it), parked beside the lock
    /// itself so the rename stays on one filesystem. A crash between the
    /// rename and the restore leaves an empty park directory behind -
    /// inert garbage the protocol never reads.
    fn park_name_of(path: &Path) -> PathBuf {
        static PARK_SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let sequence = PARK_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let mut name = path.as_os_str().to_os_string();
        name.push(format!(".park.{}.{}", std::process::id(), sequence));
        PathBuf::from(name)
    }

    /// The unwinding acquisition's cleanup (unix): remove the just-created
    /// lock directory on the witness-failure path - but only when it is
    /// still verifiably ours, verified ON THE ORIGINAL PATH before the
    /// artifact is ever touched: a rename-first cleanup would park a
    /// live successor's replacement off the public path (its refresher
    /// would abort and a third party could take the vacated path), the
    /// exact displacement the takeover paths refuse. The removal window
    /// is legal-actor-free: our artifact is fresh (no TS takeover can
    /// judge it stale), unwitnessed (this is the witness-failure unwind),
    /// and a rust successor's claim gates on the flock it holds - not
    /// ours to conflict. A foreign occupant is left entirely alone.
    #[cfg(unix)]
    fn remove_owned_artifact(path: &Path, owned: Option<u64>, probe: Option<(i64, i64)>) {
        let still_ours = probe.is_some_and(|probe| {
            Self::observed_mtime(path) == Some(probe)
                && owned.is_some_and(|owned| Self::ownership_id(path) == Some(owned))
        });
        if still_ours {
            let _ = fs::remove_dir(path);
        }
        // Not ours at the path: the successor's lock is never touched -
        // no rename, no park, no displacement.
    }

    /// Put a parked directory back at the lock path: `RENAME_NOREPLACE`
    /// on Linux (an atomic refusal when the path was re-created
    /// meanwhile), degrading to the stat-then-rename protocol when the
    /// filesystem under it rejects the flag; elsewhere the path is
    /// stat'ed first and the microseconds window is disclosed (a lock
    /// created between the stat and the rename is replaced - non-Linux
    /// unix, and Linux mounts without `RENAME_NOREPLACE`). A restore
    /// that cannot happen leaves the park behind - inert garbage the
    /// protocol never reads - and the displaced occupant's own machinery
    /// detects the foreign lock at its next identity check and fails
    /// closed.
    fn restore_parked(parked: &Path, path: &Path) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::ffi::OsStrExt;
            const RENAME_NOREPLACE: u32 = 1;
            let parked_c = std::ffi::CString::new(parked.as_os_str().as_bytes()).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("park name not encodable: {}", parked.display()),
                )
            })?;
            let path_c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("lock path not encodable: {}", path.display()),
                )
            })?;
            // A re-taken path is usually a guard hold in flight (the
            // guarded actions are read-modify-write cycles measured in
            // microseconds): the restore retries for a short bounded
            // window before the park is abandoned, so a live displaced
            // lock almost always returns to the path. The abandonment
            // (the displaced holder's next mtime write fails and it
            // aborts, fail-closed) stays the last resort.
            let mut attempts = 10;
            loop {
                let result = unsafe {
                    libc::renameat2(
                        libc::AT_FDCWD,
                        parked_c.as_ptr(),
                        libc::AT_FDCWD,
                        path_c.as_ptr(),
                        RENAME_NOREPLACE,
                    )
                };
                if result == 0 {
                    return Ok(());
                }
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::AlreadyExists && attempts > 0 {
                    attempts -= 1;
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                return match error.kind() {
                    // The park vanished (a concurrent cleanup): done.
                    io::ErrorKind::NotFound => Ok(()),
                    // The path stayed re-taken through the whole window: the
                    // park is ABANDONED (the callers retry only on
                    // WouldBlock contention, never on this) - the displaced
                    // holder's next mtime write fails and it aborts,
                    // fail-closed.
                    io::ErrorKind::AlreadyExists => {
                        tracing::warn!(
                            "abandoned a parked lock directory beside {} (the path stayed re-taken)",
                            path.display()
                        );
                        Ok(())
                    }
                    // Filesystems without `RENAME_NOREPLACE` (some FUSE,
                    // NFS, overlay mounts answer EINVAL/ENOSYS/EOPNOTSUPP
                    // to the flag): the atomic refusal is unavailable, so
                    // the restore degrades to the disclosed stat-then-rename
                    // protocol - the same bounded window the non-Linux unix
                    // arm always runs - rather than failing the reclaim and
                    // leaving the lock parked off the public path.
                    _ if matches!(
                        error.raw_os_error(),
                        Some(libc::EINVAL | libc::ENOSYS | libc::EOPNOTSUPP | libc::ENOTTY)
                    ) =>
                    {
                        tracing::warn!(
                            "the filesystem under {} does not support RENAME_NOREPLACE (the parked-lock restore degrades to the stat-then-rename protocol)",
                            path.display()
                        );
                        Self::restore_parked_plain_rename(parked, path)
                    }
                    _ => Err(error),
                };
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            Self::restore_parked_plain_rename(parked, path)
        }
    }

    /// The disclosed stat-then-rename restore (non-Linux unix, and the
    /// Linux degrade for filesystems without `RENAME_NOREPLACE`): a
    /// re-taken path is usually a hold in flight, so the restore retries
    /// for a short bounded window before the park is abandoned.
    fn restore_parked_plain_rename(parked: &Path, path: &Path) -> io::Result<()> {
        let mut attempts = 10;
        loop {
            if fs::symlink_metadata(path).is_ok() {
                if attempts == 0 {
                    tracing::warn!(
                        "abandoned a parked lock directory beside {} (the path stayed re-taken)",
                        path.display()
                    );
                    return Ok(());
                }
                attempts -= 1;
                std::thread::sleep(Duration::from_millis(20));
                continue;
            }
            match fs::rename(parked, path) {
                Ok(()) => return Ok(()),
                // The park vanished (a concurrent cleanup): done.
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                // The path was taken in the stat-rename window: retry.
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if attempts == 0 {
                        tracing::warn!(
                            "abandoned a parked lock directory beside {} (the path stayed re-taken)",
                            path.display()
                        );
                        return Ok(());
                    }
                    attempts -= 1;
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// The occupant claim for a stale takeover (unix): a LOOP of open,
    /// flock, and re-validate, ending in an exclusive non-blocking `flock`
    /// on an incumbent that is BOTH still the path's occupant AND stale -
    /// held (the returned fd) through the capture. The loop closes the
    /// open-to-flock TOCTOU (open a stale X, pause, a rival reclaims and
    /// witnesses a fresh occupant: an unvalidated flock would land on the
    /// OLD unlinked fd while the park grabs the fresh live one): after the
    /// flock, the fd's own identity is re-checked against the path (a
    /// changed occupant restarts the loop on the NEW one) and the fd's
    /// own fstat re-judges staleness (a fresh occupant is plain
    /// contention). `NotFound` (the occupant vanished between the
    /// steps) restarts the loop too - it exits with the vanished
    /// occupant's retry. The fd is the claim's lifetime: dropped when
    /// the reclaim returns.
    #[cfg(unix)]
    fn claim_occupant(path: &Path, stale_after: Duration) -> io::Result<std::os::fd::OwnedFd> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::MetadataExt;
        // The claim is bounded: a mismatched occupant restarts the loop
        // on the new one, but a path that persistently fails its
        // fd-vs-path identity check (a degraded stat, a churning
        // occupant) must not spin the acquire forever - after the cap
        // the claim reports contention, the caller's honest conservative
        // answer.
        let mut attempts = 8u32;
        loop {
            // The open resolves the path's CURRENT occupant atomically.
            let dir = match fs::File::open(path) {
                Ok(dir) => dir,
                // Vanished: surfaced for the caller to treat as the
                // reclaimed-remnant retry (its create can take the empty
                // path directly).
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(error),
                Err(error) => return Err(error),
            };
            // The flock on the opened inode: a live witness-holder on
            // this occupant (or another reclaim's claim) is contention.
            let held = unsafe { libc::flock(dir.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if held != 0 {
                let error = io::Error::last_os_error();
                match error.kind() {
                    io::ErrorKind::WouldBlock => {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            format!("Lock file is already being held: {}", path.display()),
                        ));
                    }
                    // The NFS emulation signature (an unwitnessable
                    // filesystem - see [`LockDir::witness_fd`]): the flock
                    // pin is impossible here, but the mtime-only claim
                    // still runs its FULL re-validation below - the
                    // fd-vs-occupant identity check and the fd's own
                    // staleness re-judge are plain stat/mtime reads that
                    // work on NFS (proper-lockfile's own re-validate is
                    // the mtime check) - so the degraded claim is
                    // re-validated exactly like the flocked one, only
                    // unpinned.
                    io::ErrorKind::PermissionDenied => {
                        tracing::warn!(
                            "the directory lock cannot take an exclusive flock at {} (an NFS-style filesystem: the takeover claim degrades to the unpinned mtime-only re-validation)",
                            path.display()
                        );
                    }
                    _ => return Err(error),
                }
            }
            let claimed = fs::metadata(path).map(|metadata| metadata.ino());
            let fd_metadata = dir.metadata();
            match (claimed, fd_metadata) {
                (Ok(claimed), Ok(fd_metadata)) if Some(claimed) == Some(fd_metadata.ino()) => {
                    // The flocked fd is still the occupant. Re-judge the
                    // staleness on the fd's OWN metadata (immune to path
                    // swaps): a fresh occupant is a live lock - never a
                    // capture candidate.
                    let modified = fd_metadata.modified()?;
                    let age = std::time::SystemTime::now()
                        .duration_since(modified)
                        .unwrap_or_default();
                    if age <= stale_after {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            format!("Lock file is already being held: {}", path.display()),
                        ));
                    }
                    return Ok(dir.into());
                }
                // The occupant changed under the claim (or vanished, or
                // the stat failed): the fd's flock released with this
                // iteration's drop - loop to claim the NEW occupant,
                // within the attempt cap above.
                _ => {
                    attempts = attempts.saturating_sub(1);
                    if attempts == 0 {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            format!(
                                "the occupant at {} did not stabilize for the claim",
                                path.display()
                            ),
                        ));
                    }
                }
            }
        }
    }

    /// True while another process holds the live-holder `flock` witness on
    /// the lock DIRECTORY (the probe `flock` [`LockDir::witness_fd`] takes
    /// at acquisition). An unopenable path means no witness holder: the
    /// stale judgment alone decides.
    #[cfg(unix)]
    fn dir_flock_held(path: &Path) -> bool {
        use std::os::unix::io::AsRawFd;
        let Ok(dir) = fs::File::open(path) else {
            return false;
        };
        (unsafe { libc::flock(dir.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
            && io::Error::last_os_error().kind() == io::ErrorKind::WouldBlock)
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
    /// The check and the write are two steps, so the tick closes on a
    /// re-stat: the probe is recorded (proper-lockfile's `lock.mtime =
    /// mtime`, the exact value the `utimes` call wrote) and then BOTH
    /// identity halves must show it - the inode still the acquired one,
    /// the observed mtime exactly the recorded probe (the `isMtimeOurs`
    /// equality, exact, no tolerance). A takeover between the check and
    /// the write redirects the write onto the successor's fresh
    /// directory, and the post-write re-stat is what catches that before
    /// a success is reported.
    ///
    /// # Errors
    ///
    /// Returns an error when the lock directory changed hands (or cannot
    /// be stat'ed), when the lock no longer carries the probe this guard
    /// wrote, and when the mtime probe write fails.
    ///
    /// # Panics
    ///
    /// Panics only on a poisoned `owned_mtime` mutex - a sibling already
    /// panicked while holding the lock's record.
    pub fn refresh(&self) -> io::Result<()> {
        if self.is_stolen() {
            return Err(io::Error::other("the lock directory changed hands"));
        }
        let probe = Self::reprobe_mtime(&self.path)?;
        *self.owned_mtime.lock().unwrap() = probe;
        self.assert_probe_landed(probe)
    }

    /// The post-write half of a tick: the probe write must have landed on
    /// the lock directory this guard acquired and left the mtime this
    /// guard wrote. proper-lockfile reports its updater failures to
    /// `onCompromised` and stops the timer; the successor's replacement -
    /// a rmdir+mkdir between the ownership check and the probe write -
    /// carries a foreign inode and its own probe, and either half
    /// reporting foreign is the compromise (the caller latches it).
    fn assert_probe_landed(&self, probe: Option<(i64, i64)>) -> io::Result<()> {
        if self.is_stolen() {
            return Err(io::Error::other("the lock directory changed hands"));
        }
        if probe.is_some_and(|probe| Self::observed_mtime(&self.path) != Some(probe)) {
            return Err(io::Error::other(
                "the lock's mtime is not the one this guard wrote",
            ));
        }
        Ok(())
    }

    /// The acquisition probe re-run - the same ceil-plus-5 ms shape, so
    /// the staleness judgment keeps its meaning (see `create`'s platform
    /// split). Returns the probe the write stamped, the value the tick
    /// records and re-stats against (proper-lockfile's updater remembers
    /// the exact `utimes` mtime the same way).
    #[cfg(any(unix, windows))]
    fn reprobe_mtime(path: &Path) -> io::Result<Option<(i64, i64)>> {
        let (sec, nanos) = probe_mtime();
        set_mtime(path, sec, nanos)?;
        Ok(Some((sec, nanos)))
    }

    /// No mtime probe on this platform (see `create`): staleness rides the
    /// directory's own mtime.
    #[cfg(not(any(unix, windows)))]
    fn reprobe_mtime(_path: &Path) -> io::Result<Option<(i64, i64)>> {
        Ok(None)
    }

    /// Release only when the lock directory is still the one this guard
    /// acquired: removing a stolen lock would delete the successor's lock
    /// (TS: a stolen-but-undetected guard is never released - "the
    /// abandoned updater notices the foreign mtime on its next tick and
    /// cleans itself up"). An unobservable identity releases like the plain
    /// drop (TS's `guardStolen()` is false for `guardIno === undefined`).
    ///
    /// The inode check and the rmdir are two steps, so the removal is
    /// bound to BOTH identity halves: the lock's observed mtime must also
    /// be the last probe this guard wrote (the `isMtimeOurs` rule that a
    /// lock is ours only while it carries the mtime we wrote, applied at
    /// the removal; a platform without a probe has no mtime half to
    /// verify, the same unobservable-identity fallback). A successor that
    /// reclaims the stale lock between the check and the rmdir leaves a
    /// fresh directory whose mtime is its OWN probe - foreign to the
    /// record - so the removal is refused and the successor's lock leaks
    /// like the stolen case, for its staleness sweep to reclaim.
    ///
    /// Consuming: [`Drop`] would run the plain release afterwards, and a
    /// successor may already hold a fresh lock at the path the guarded
    /// removal vacated - the double release could delete it - so the guard
    /// is forgotten once its guarded removal ran.
    ///
    /// # Panics
    ///
    /// Panics only on a poisoned `owned_mtime` mutex - a sibling already
    /// panicked while holding the lock's record.
    pub fn release_when_owned(mut self) {
        let mtime_ours = self
            .owned_mtime
            .lock()
            .unwrap()
            .is_none_or(|probe| Self::observed_mtime(&self.path) == Some(probe));
        // The kernel-truth verification, ON THE PATH: a witnessed guard's
        // own flock attempt on the occupant must BLOCK (the occupant is
        // this guard's inode - a replacement that collides on inode
        // number and probe mtime is still a different kernel object, and
        // the attempt on it succeeds, recognizing it as foreign); the
        // identity pair and the recorded probe stay the portable
        // witnesses alongside. No park: a release vacates the path by
        // definition, and the check-to-remove window has no legal actor -
        // a rust successor's takeover is flock-gated by this guard's own
        // held witness, and a flock-blind taker needs the staleness this
        // guard just refreshed away (proper-lockfile's unlock runs the
        // same check-then-remove against the same window).
        let still_ours = mtime_ours && !self.is_stolen();
        #[cfg(target_os = "linux")]
        let still_ours = match self.witness.as_ref() {
            Some(_) => still_ours && Self::was_witness_held(&self.path),
            // An unwitnessed guard has no kernel truth to consult - the
            // identity pair alone decides, as before.
            None => still_ours,
        };
        if still_ours {
            self.release();
        } else {
            // The occupant is a successor's: never removed (that would
            // delete the successor's lock) - the artifact leaks for its
            // own staleness sweep, exactly like the stolen case.
        }
        self.abandon_witness();
        // The removal decision is settled: mark the guard finished so its
        // Drop never runs the plain release again (a successor's fresh
        // lock at the vacated path must not see a second rmdir), then let
        // the guard DROP NORMALLY - the fields (the path buffer, the mtime
        // record) are freed and the registry entry unregisters in Drop,
        // never leaked whole by a forget.
        self.finished.store(true, Ordering::Relaxed);
    }

    /// Whether a lock path's occupant carries this guard's own `flock`
    /// witness (unix): the `flock` attempt on the path blocks exactly when
    /// this guard's witness fd still holds the occupant's inode - the
    /// kernel-object identity the stat pair cannot forge (a replacement
    /// that reuses the inode number and repeats the same-second probe is
    /// still a different kernel object, and the attempt on it succeeds,
    /// briefly taking and releasing the foreign flock it acquired).
    #[cfg(target_os = "linux")]
    fn was_witness_held(path: &Path) -> bool {
        Self::dir_flock_held(path)
    }

    /// Abandon the guard artifact without removing anything at the path: a
    /// stolen or foreign-mtime lock must never be released (that would
    /// delete the successor's lock), but the witness fd must not leak
    /// either - it is closed here, the kernel reclaims the pinned inode,
    /// and the abandoned artifact at the path goes stale for the
    /// successor's own sweep (TS: "A stolen-but-undetected guard is never
    /// released: that would delete the successor's lock.").
    pub fn disarm(mut self) {
        self.abandon_witness();
        // Marked finished: Drop's plain release is suppressed (the
        // abandoned artifact stays at the path), and the guard still drops
        // normally - fields freed, registry entry unregistered.
        self.finished.store(true, Ordering::Relaxed);
    }

    /// Close the live-holder witness handle (a no-op on platforms without
    /// one) so a consuming abandonment never leaks the fd.
    fn abandon_witness(&mut self) {
        let _ = std::mem::take(&mut self.witness);
    }
}

impl Drop for LockDir {
    fn drop(&mut self) {
        // The plain release runs at most once: a guarded removal or an
        // abandonment marked the guard finished, and its successor's fresh
        // lock at the vacated path must never see a second rmdir.
        if !self.finished.swap(true, Ordering::Relaxed) {
            self.release();
        }
        #[cfg(unix)]
        {
            unregister_locally_held(&self.path);
        }
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
        // The thief's rmdir+mkdir re-creates the lock directory. A plain
        // immediate steal can land the recreated directory back on the
        // just-freed inode number on this filesystem (the identity-pair
        // collision class), so the steal pins the acquired inode out of
        // the allocator first: the acquired directory is renamed to a
        // parking name (its inode stays ALLOCATED, so the recreation
        // cannot reuse it), then the thief's mkdir takes the path - the
        // deterministic form of a real successor's steal, with the
        // evidence preserved.
        let parked = dir.path().join("acquired-parked");
        std::fs::rename(&path, &parked).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(
            guard.is_stolen(),
            "the recreated lock is not the acquired one (the acquired inode is pinned under the park)"
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
        // After the steal (the acquired directory parked out of the
        // allocator first so the recreation cannot reuse its inode), the
        // successor's lock directory survives.
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let parked = dir.path().join("thief-parked");
        std::fs::rename(&path, &parked).unwrap();
        std::fs::create_dir(&path).unwrap();
        guard.release_when_owned();
        assert!(
            path.is_dir(),
            "the guarded release never deletes the successor's lock"
        );
    }

    /// The live-holder witness gate: a stale mtime alone never reclaims a
    /// lock whose holder still lives. The holder's flock pins the takeover
    /// for its whole lifetime (the review bot's collision experiment -
    /// rmdir+mkdir reusing the inode and the same-second probe - cannot
    /// even begin), and the crash-oracle stays intact: the dropped
    /// holder's fd closes, the witness vanishes, and the stale takeover
    /// proceeds.
    #[test]
    #[cfg(unix)]
    fn a_stale_mtime_never_reclaims_a_live_witness_holder() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let holder = LockDir::acquire_at(&lock_of(&file), MIN_STALE).unwrap();
        let path = lock_of(&file);
        // Age the lock far past the staleness threshold while the holder
        // lives: the takeover gate must still answer contention.
        set_mtime(&path, 1, 0).unwrap();
        let error = LockDir::acquire(&file, MIN_STALE).unwrap_err();
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::WouldBlock,
            "a live holder's stale mtime is not a reclaim signal"
        );
        // The crash-oracle: the holder's fd closes with it (the kernel's
        // side of the witness), and the stale takeover proceeds.
        drop(holder);
        let successor = LockDir::acquire_at(&path, MIN_STALE)
            .expect("a dead holder's stale lock reclaims the moment the witness closes");
        assert!(
            std::fs::metadata(&path).unwrap().is_dir(),
            "the successor holds a fresh lock directory at the path"
        );
        drop(successor);
    }

    #[test]
    #[cfg(unix)]
    fn adoption_refuses_a_directory_with_a_foreign_probe() {
        // The review bot's suspension window at the acquisition (the probe
        // write and the ownership stat are two steps; a suspended holder
        // resumes looking at a successor's replacement), forced at its
        // aftermath: `create` wrote our probe, and the directory the
        // adoption then stats is the successor's - rmdir+mkdir with a
        // fresh allocation, carrying the successor's OWN probe. The
        // adoption must refuse it as contention (the ladders' retry
        // signal), never record the successor's inode as owned.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json.lock");
        let probe = LockDir::create(&path).unwrap().expect("the unix probe");
        std::fs::remove_dir(&path).unwrap();
        std::fs::create_dir(dir.path().join("successor-bumper")).unwrap();
        std::fs::create_dir(&path).unwrap();
        // The successor's own probe: a fresh ceil-second value, foreign to
        // ours by the exact-equality compare.
        set_mtime(&path, 123, 456).unwrap();
        let error = LockDir::acquired(path.clone(), Some(probe), true)
            .expect_err("a directory with a foreign probe is never adopted");
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::WouldBlock,
            "the refusal is the contention every acquire ladder retries on"
        );
        assert!(
            std::fs::metadata(&path).unwrap().is_dir(),
            "the successor's lock survives the refused adoption"
        );
    }

    #[test]
    #[cfg(unix)]
    fn refresh_catches_a_takeover_between_the_check_and_the_write() {
        // The review bot's refresh window: the ownership check and the
        // probe write are two steps, so a takeover between them lands the
        // write on the successor's fresh directory - the tick's post-write
        // re-stat is what must report it, not the pre-write check. The
        // first tick pins the happy path; the window is then forced with
        // the tick's own steps (write, record) before the takeover.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        guard
            .refresh()
            .expect("the first tick lands on the owned lock");
        let path = lock_of(&file);
        let probe = LockDir::reprobe_mtime(&path)
            .unwrap()
            .expect("the unix probe");
        *guard.owned_mtime.lock().unwrap() = Some(probe);
        // The takeover between the tick's write and its re-stat: the
        // acquired directory is renamed to a parking name first (its
        // inode stays allocated, so the recreation at the path cannot
        // reuse it), then the thief's mkdir takes the path - the
        // deterministic form of the successor's takeover.
        let parked = dir.path().join("thief-parked");
        std::fs::rename(&path, &parked).unwrap();
        std::fs::create_dir(&path).unwrap();
        let error = guard
            .assert_probe_landed(Some(probe))
            .expect_err("the re-stat catches the successor's directory");
        // Either half of the identity pair is a compromise report: the
        // recreated directory's inode when it differs, the mtime that is
        // not the recorded probe when the allocator reused the inode.
        assert!(
            error.to_string() == "the lock directory changed hands"
                || error.to_string() == "the lock's mtime is not the one this guard wrote",
            "an unexpected error for a compromised hold: {error}"
        );
        // End to end: once stolen, no tick ever reports a fresh hold.
        let error = guard
            .refresh()
            .expect_err("a stolen lock is never refreshed");
        assert!(
            error.to_string() == "the lock directory changed hands"
                || error.to_string() == "the lock's mtime is not the one this guard wrote",
            "an unexpected error for a compromised hold: {error}"
        );
    }

    /// The unwinding acquisition's cleanup: the just-created artifact is
    /// removed when it is still verifiably ours, and a successor's
    /// replacement at the path is restored untouched (the witness-failure
    /// path - cursor's orphaned-lock-directory finding).
    #[test]
    #[cfg(unix)]
    fn the_unwitnessed_artifact_cleans_up_only_when_ours() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json.lock");
        // OUR artifact: create's probe, still at the path -> removed.
        let probe = LockDir::create(&path).unwrap().expect("the unix probe");
        let owned = LockDir::ownership_id(&path);
        LockDir::remove_owned_artifact(&path, owned, Some(probe));
        assert!(!path.exists(), "the unwitnessed artifact never orphans");
        // The successor's replacement: its own probe at the path ->
        // never touched (no rename, no park), never removed.
        let probe = LockDir::create(&path).unwrap().expect("the unix probe");
        let owned = LockDir::ownership_id(&path);
        set_mtime(&path, 123, 456).unwrap();
        LockDir::remove_owned_artifact(&path, owned, Some(probe));
        assert!(path.is_dir(), "the successor's replacement is untouched");
        std::fs::remove_dir(&path).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn refresh_reports_a_rival_touch_between_the_write_and_the_restat() {
        // The same window's other landing: the probe write stayed on our
        // own directory, but a rival's touch overwrote the mtime before
        // the re-stat - the inode still ours, the mtime no longer the one
        // this guard just wrote (the `isMtimeOurs` failure proper-lockfile
        // reports to `onCompromised`).
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        std::fs::write(&file, "{}").unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let path = lock_of(&file);
        let probe = LockDir::reprobe_mtime(&path)
            .unwrap()
            .expect("the unix probe");
        set_mtime(&path, 123, 456).unwrap();
        let error = guard
            .assert_probe_landed(Some(probe))
            .expect_err("a foreign mtime is never a fresh hold");
        assert_eq!(
            error.to_string(),
            "the lock's mtime is not the one this guard wrote"
        );
    }

    #[test]
    #[cfg(unix)]
    fn release_when_owned_refuses_a_foreign_mtime() {
        // The review bot's release TOCTOU forced at its observable: a
        // successor that reclaims between the inode check and the rmdir
        // leaves a fresh lock whose mtime is its own probe - foreign to
        // the record this guard keeps. The removal is bound to the last
        // probe this guard wrote, so it refuses and the artifact leaks
        // for the successor's staleness sweep, exactly like the stolen
        // case.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("auth.json");
        std::fs::write(&file, "{}").unwrap();
        let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        // The rival's touch on our very directory: the inode still ours,
        // the mtime not the one this guard wrote.
        set_mtime(&lock_of(&file), 123, 456).unwrap();
        guard.release_when_owned();
        assert!(
            lock_of(&file).is_dir(),
            "a foreign mtime is never ours to remove"
        );
    }

    /// The plain-rename restore (the non-Linux arm, and the Linux
    /// degrade for filesystems without `RENAME_NOREPLACE` - cursor's
    /// missing-degraded-fallback finding): a free path takes the park
    /// back atomically enough for the protocol, and a park that
    /// vanished to a concurrent cleanup is a success, never an error.
    #[test]
    #[cfg(unix)]
    fn the_plain_rename_restore_takes_a_free_path_and_tolerates_a_vanished_park() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json.lock");
        let parked = LockDir::park_name_of(&path);
        // The displaced park: an empty directory beside the path.
        std::fs::create_dir(&parked).unwrap();
        LockDir::restore_parked_plain_rename(&parked, &path).unwrap();
        assert!(path.is_dir(), "the park returned to the public path");
        assert!(!parked.exists(), "the park name is spent");
        std::fs::remove_dir(&path).unwrap();
        // The vanished park: a concurrent cleanup already removed it.
        LockDir::restore_parked_plain_rename(&parked, &path)
            .unwrap_or_else(|error| panic!("a vanished park is done, not an error: {error}"));
        assert!(!path.exists(), "a vanished park restores nothing");
    }
}
