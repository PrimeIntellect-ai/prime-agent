//! The stale-reclaim dance and its reclaim-sidecar serialization
//! (the acquire/release orchestration lives in the parent): the sidecar
//! flock primitives, the stale judge, and the Linux exchange
//! choreography that reclaims an incumbent without ever vacating the
//! public path.

#[cfg(unix)]
use super::lock_dir_setup::is_fresh_name_swap;
#[cfg(target_os = "linux")]
use super::lock_dir_setup::{create_private_dir_guarded, setup_private_dir};
use std::fs;
use std::io;
use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::time::Duration;

#[cfg(unix)]
use super::identity_at;
#[cfg(target_os = "linux")]
use super::process_owner_record;
#[cfg(unix)]
use super::remove_candidate_dir;
#[cfg(target_os = "linux")]
use super::rename_noreplace;
#[cfg(all(test, target_os = "linux"))]
use super::set_mtime;
use super::LockDir;
/// Open the sidecar for flock, hardened against a planted or
/// umask-tightened path: a FIFO or other non-regular file at the
/// predictable sidecar name would block an ordinary `.open()` forever
/// (a FIFO write-open waits for a reader), and a hostile umask (0277)
/// strips the owner-write bit at creation so every later write-open
/// fails EACCES - wedging every judge behind permanent contention. The
/// open is nonblocking and no-follow, the file type must be a regular
/// file (checked through the descriptor), and a read-only descriptor is
/// sufficient: `flock` needs no write permission, and the mode is
/// repaired best-effort through the descriptor so later writers can
/// open normally. Anything else at the sidecar path (a symlink, a
/// directory, a device) fails closed - `None`, contention, the
/// documented floor for a hostile sidecar.
#[cfg(target_os = "linux")]
fn open_sidecar(path: &Path) -> Option<fs::File> {
    // The sidecar path's RAW bytes: `to_string_lossy` would replace
    // every non-UTF-8 byte with U+FFFD and open a path that generally
    // does not exist, wedging every guard acquisition for valid Unix
    // lock directories. The old OpenOptions::open used the path's own
    // bytes; this keeps that exact behavior under the hardened flags.
    let raw_path =
        std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(path.as_os_str())).ok()?;
    // The creation attempt is O_EXCL: success means THIS call created
    // the sidecar, and only then may its mode be repaired - a hostile
    // umask (0477) tightens the fresh 0600 creation to 0200. An
    // existing regular file at the sidecar path (a hardlink to a
    // foreign owner-owned file) is NEVER chmod'ed on the ordinary path:
    // the never-touch-foreign-entry rule holds.
    let create = unsafe {
        libc::open(
            raw_path.as_ptr(),
            libc::O_RDWR
                | libc::O_CREAT
                | libc::O_EXCL
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK
                | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if create >= 0 {
        if let Some(file) = regular_or_close(create) {
            use std::os::fd::AsRawFd;
            unsafe { libc::fchmod(file.as_raw_fd(), 0o600) };
            return Some(file);
        }
        return None;
    }
    // An existing entry (or a transient error): open WITHOUT creating
    // and without ever changing an existing file's mode.
    let existing = unsafe {
        libc::open(
            raw_path.as_ptr(),
            libc::O_RDWR | libc::O_CLOEXEC | libc::O_NONBLOCK | libc::O_NOFOLLOW,
        )
    };
    if existing >= 0 {
        // An ordinary regular sidecar: no repair, no chmod - the file
        // is assumed to be the protocol's own (or a foreign entry the
        // protocol never touches beyond flocking it).
        return regular_or_close(existing);
    }
    // An access-mode denial on an existing sidecar (a prior umask-0477
    // creation left mode 0200: both read opens fail; or a 0400 sidecar
    // denies write): recover through whichever access mode the mode
    // admits, repair the mode through that descriptor, and reopen
    // read-write - NFS requires a WRITABLE descriptor for an exclusive
    // flock. This repair only ever applies to a file that denied the
    // protocol's own read-write open at the protocol's own sidecar
    // path: the tight modes this reaches (0200/0400) are exactly the
    // ones the protocol's earlier umask-bitten creations produced.
    let errno = std::io::Error::last_os_error();
    if errno.raw_os_error() == Some(libc::EACCES) || errno.raw_os_error() == Some(libc::EROFS) {
        for fallback_mode in [libc::O_WRONLY, libc::O_RDONLY] {
            let ro = unsafe {
                libc::open(
                    raw_path.as_ptr(),
                    fallback_mode | libc::O_CLOEXEC | libc::O_NONBLOCK | libc::O_NOFOLLOW,
                )
            };
            if ro < 0 {
                continue;
            }
            if let Some(file) = regular_or_close(ro) {
                // A HEURISTIC, not authentication: these attributes
                // (single link, and exactly one of the protocol's two
                // umask-bitten creation modes - 0200 from umask 0477,
                // 0400 from 0277) exclude every foreign entry the
                // protocol can distinguish, but a single-link
                // restrictive-mode regular file planted directly at the
                // sidecar path is INDISTINGUISHABLE from a genuine
                // legacy sidecar, and repairing it (fchmod 0600) is an
                // ACCEPTED, DOCUMENTED RISK: an actor with write access
                // to the lock's own parent directory (the only way to
                // plant such a file) can already replace the lock
                // directory itself, so the mode repair on their inode
                // adds no new capability. Everything the heuristic CAN
                // exclude it does: hardlinks (nlink > 1) and every other
                // mode fail closed - `None`, contention, the documented
                // floor for a hostile sidecar.
                use std::os::fd::AsRawFd;
                let mut stat: libc::stat = unsafe { std::mem::zeroed() };
                let statted =
                    unsafe { libc::fstat(file.as_raw_fd(), std::ptr::addr_of_mut!(stat)) } == 0;
                let mode = stat.st_mode & 0o777;
                let plausibly_legacy =
                    statted && stat.st_nlink == 1 && (mode == 0o200 || mode == 0o400);
                if !plausibly_legacy {
                    return None;
                }
                unsafe { libc::fchmod(file.as_raw_fd(), 0o600) };
                let rw = unsafe {
                    libc::open(
                        raw_path.as_ptr(),
                        libc::O_RDWR | libc::O_CLOEXEC | libc::O_NONBLOCK | libc::O_NOFOLLOW,
                    )
                };
                if rw >= 0 {
                    // The repaired mode admits a read-write reopen
                    // (regular_or_close owns the reopen's descriptor
                    // lifecycle; on a non-regular reopen it closes rw
                    // itself).
                    if let Some(rw_file) = regular_or_close(rw) {
                        drop(file);
                        return Some(rw_file);
                    }
                }
                // Local filesystems flock on any descriptor fine; the
                // repair keeps future writers working.
                return Some(file);
            }
        }
    }
    None
}

/// Wrap a raw descriptor as a `File` only when it is a regular file;
/// close it otherwise. A planted FIFO, directory, symlink
/// (`O_NOFOLLOW`),
/// or device at the sidecar path never reaches the flock loop.
#[cfg(target_os = "linux")]
fn regular_or_close(fd: i32) -> Option<fs::File> {
    use std::os::unix::io::FromRawFd;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, std::ptr::addr_of_mut!(stat)) } == 0
        && stat.st_mode & libc::S_IFMT == libc::S_IFREG
    {
        return Some(unsafe { fs::File::from_raw_fd(fd) });
    }
    unsafe { libc::close(fd) };
    None
}

/// The kernel-managed serialization guard for the stale-reclaim dance and
/// the inode-anchored release pass: an flock on a tiny sidecar file, so
/// a crashed or suspended holder releases it with the process - no
/// staleness protocol of its own, no judge recursion.
#[cfg(target_os = "linux")]
#[must_use]
pub(super) fn reclaim_guard_path(path: &Path) -> PathBuf {
    // A component-independent short name: the sidecar must not overflow
    // the filesystem's component limit for a near-limit lock name, so
    // the guard is derived from a stable FNV-1a hash of the lock's
    // RESOLVED identity - the canonicalized parent directory plus the raw
    // file name. Two spellings of one lock path (relative vs absolute,
    // dot-dot segments, symlinked parents) must derive the SAME sidecar,
    // or two processes could hold "exclusive" guards for one lock. A
    // hash collision between two different locks in one directory only
    // over-serializes (both contend on one guard), never corrupts; an
    // unstattable parent (the lock's directory must exist for every
    // protocol participant) falls back to the raw text - degraded but
    // deterministic for a lock that could not have been acquired anyway.
    // A bare relative lock ("state.json.lock") has an EMPTY parent (not
    // None): normalize it to "." before canonicalizing, or it hashes a
    // different sidecar than the absolute spelling of the same lock.
    let parent = match path.parent() {
        Some(parent) if parent.as_os_str().is_empty() => Path::new("."),
        Some(parent) => parent,
        None => Path::new("."),
    };
    let canonical = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let bytes = format!("{}/{filename}", canonical.display());
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    canonical.join(format!(".r{hash:016x}"))
}

/// Take the reclaim guard for `path` within `budget`, or `None`.
#[cfg(target_os = "linux")]
#[must_use]
pub fn try_reclaim_guard(path: &Path, budget: Duration) -> Option<fs::File> {
    use std::os::unix::io::AsRawFd;
    let file = open_sidecar(&reclaim_guard_path(path))?;
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

/// True when a lock directory carries this guard's release marker.
/// The marker must be a REGULAR FILE and is checked with lstat
/// semantics: a planted FIFO, device, or symlink to another owner's
/// file reads FALSE - `exists()` follows symlinks and reports any entry,
/// which a hostile marker must never benefit from. The marker's writer
/// (`mark_released_through`) creates exactly a regular file, so this
/// matches every genuine marker.
pub(super) fn released_marker(path: &Path) -> bool {
    std::fs::symlink_metadata(path.join("released"))
        .is_ok_and(|metadata| metadata.file_type().is_file())
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) static DANCE_FAULT: std::sync::Mutex<Vec<(std::path::PathBuf, bool, u8)>> =
    std::sync::Mutex::new(Vec::new());

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn dance_fault_arm(path: std::path::PathBuf, heartbeat: bool, swap_mode: u8) {
    DANCE_FAULT
        .lock()
        .expect("dance fault table lock")
        .push((path, heartbeat, swap_mode));
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn dance_fault_heartbeat(path: &Path) -> bool {
    let Ok(mut armed) = DANCE_FAULT.lock() else {
        return false;
    };
    let Some(entry) = armed
        .iter_mut()
        .find(|(armed_path, _, _)| armed_path == path)
    else {
        return false;
    };
    if entry.1 {
        entry.1 = false;
        true
    } else {
        false
    }
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn dance_fault_swap_mode(path: &Path) -> u8 {
    let Ok(armed) = DANCE_FAULT.lock() else {
        return 0;
    };
    armed
        .iter()
        .find(|(armed_path, _, _)| armed_path == path)
        .map_or(0, |(_, _, mode)| *mode)
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn dance_fault_clear(path: &Path) {
    if let Ok(mut armed) = DANCE_FAULT.lock() {
        armed.retain(|(armed_path, _, _)| armed_path != path);
    }
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
    fn claim_stale_incumbent(
        path: &Path,
        incumbent: Option<(u64, u64)>,
        stale_after: Duration,
    ) -> io::Result<StaleClaim> {
        // The cheap pre-check: a successor that already replaced the
        // incumbent is detected without moving anything, and a path that
        // vanished since the judge's snapshot is retry material, never
        // contention - a one-shot acquire on a now-free path must
        // succeed.
        match identity_at(path) {
            Some(identity) if Some(identity) != incumbent => return Ok(StaleClaim::Successor),
            None => return Ok(StaleClaim::Vanished),
            Some(_) => {}
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
            if let Err(error) = create_private_dir_guarded(&placeholder) {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    continue;
                }
                return Err(error);
            }
            // The placeholder carries a live owner record for the whole
            // exchange/restore interval (a suspended dance leaves a
            // stale-dated but LIVE-OWNED lock at the public path - the
            // suspension scenario the owner record exists for) and the
            // `claimed-at` note a displaced holder's release finds to
            // complete itself at the private location. BOTH notes are
            // written fd-relative through the pinned no-follow handle;
            // nothing touches the pathname again.
            let note = placeholder
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let placeholder_identity =
                match setup_private_dir(&placeholder, Some(&process_owner_record()), Some(&note)) {
                    Ok((_handle, identity)) => Some(identity),
                    Err(error) if is_fresh_name_swap(&error) => {
                        // A swapped entry at the fresh private name (ELOOP
                        // from the no-follow refusal, the emptiness or the
                        // write-handle mismatch sentinel): PRESERVE it
                        // untouched (a blind remove could traverse a
                        // symlink into a victim) and regenerate a fresh
                        // private name.
                        continue;
                    }
                    Err(error) => {
                        // An ordinary setup failure (a pin errno, a note
                        // write through the pinned handle) happens to THIS
                        // dance's own creation - remove it so failed
                        // claims do not accumulate inert dotnames.
                        let _ = remove_candidate_dir(&placeholder);
                        return Err(error);
                    }
                };
            match rename_noreplace::exchange(path, &placeholder) {
                Ok(()) => {
                    // Test-only, path-scoped injection: simulate the live
                    // holder's heartbeat landing mid-dance (the exchanged
                    // incumbent reads fresh again - the live-lease arm
                    // runs).
                    #[cfg(test)]
                    if dance_fault_heartbeat(path) {
                        let _ = set_mtime(&placeholder, 4_102_444_800, 0);
                    }
                    let claimed = identity_at(&placeholder);
                    let released = released_marker(&placeholder);
                    let still_stale = fs::symlink_metadata(&placeholder)
                        .ok()
                        .and_then(|metadata| metadata.modified().ok())
                        .and_then(|mtime| mtime.elapsed().ok())
                        .is_some_and(|age| age > stale_after);
                    // The heartbeat may have refreshed this very inode
                    // after the judge's snapshot: a claimed incumbent
                    // that is no longer stale is a LIVE lease - swap it
                    // home and report contention, never remove it.
                    // The release marker outranks the mtime: creating
                    // `released` REFRESHES the directory mtime, so an
                    // already-released incumbent looks heartbeat-fresh -
                    // a released marker means CONSUME (nobody else will
                    // clean it), never restore.
                    if claimed == incumbent && released {
                        // An already-released incumbent (its guard wrote
                        // the marker through the pinned fd - the marker
                        // write refreshed this mtime, which is why the
                        // stale check above saw freshness): CONSUME it -
                        // nobody else will - and clear the placeholder
                        // so the caller's retry sees an empty path.
                        if let Err(error) = remove_candidate_dir(&placeholder) {
                            if error.kind() != io::ErrorKind::NotFound {
                                let _ = remove_candidate_dir(path);
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
                    if claimed == incumbent && !still_stale {
                        // A freshly heartbeat-refreshed LIVE lease: swap
                        // it home and report contention. The swap's
                        // failure is preserved-closed: the public entry
                        // may have vanished while the displaced lease
                        // remains at the private name - removing that
                        // name would destroy the live lease, so on any
                        // swap failure the displaced inode stays where
                        // it is (an inert private dotname its holder can
                        // still reach through the pinned fd).
                        // The swap-home RESTORES the live incumbent under
                        // the still-held guard. EVERY attempt - success OR
                        // error - is verified by the inode actually sitting
                        // at the public path: an exchange that completed
                        // despite a reported error has already restored the
                        // lease, and a blind retry would swap it away again
                        // and its cleanup would DELETE the live lease. The
                        // public path is never vacated while the fresh
                        // incumbent remains private: a persistent failure
                        // fails CLOSED with this dance's own live-owned
                        // placeholder intact at the public path (a wedge
                        // this process's exit and the stale window later
                        // reclaim - never concurrent ownership, and the
                        // holder's release still finds the private name
                        // through the placeholder's claimed-at note).
                        let mut last_error = None;
                        let mut attempts_left = 4;
                        // Test-only: the ambiguous-completion fault
                        // applies to the FIRST attempt only (the
                        // transient error once, the retry real).
                        #[cfg(test)]
                        let mut mode2_consumed = false;
                        loop {
                            let attempted = {
                                #[cfg(test)]
                                match dance_fault_swap_mode(path) {
                                    // A synthetic failure that exchanges
                                    // NOTHING: every attempt fails.
                                    1 => Err::<(), io::Error>(io::Error::other(
                                        "injected swap-home failure",
                                    )),
                                    // The REAL exchange completes and the
                                    // error is reported anyway - the
                                    // ambiguous completion, ONCE.
                                    2 if !mode2_consumed => {
                                        mode2_consumed = true;
                                        let _ = rename_noreplace::exchange(path, &placeholder);
                                        Err(io::Error::other("injected swap-home failure"))
                                    }
                                    _ => rename_noreplace::exchange(path, &placeholder),
                                }
                                #[cfg(not(test))]
                                rename_noreplace::exchange(path, &placeholder)
                            };
                            if let Err(error) = attempted {
                                if error.kind() == io::ErrorKind::NotFound {
                                    return Err(error);
                                }
                                last_error = Some(error);
                            }
                            // The inode at the public path is the only
                            // restoration truth.
                            let at_public = identity_at(path);
                            if incumbent.is_some_and(|expected| at_public == Some(expected)) {
                                // The live lease is home. Clean this
                                // dance's placeholder residue at the
                                // private name ONLY on a positive match
                                // against its creation witness - a
                                // substituted entry at the private name
                                // is never this call's to remove.
                                if placeholder_identity.is_some_and(|expected| {
                                    identity_at(&placeholder) == Some(expected)
                                }) {
                                    let _ = remove_candidate_dir(&placeholder);
                                }
                                return Ok(StaleClaim::Successor);
                            }
                            if at_public.is_none() {
                                return Err(last_error.unwrap_or_else(|| {
                                    io::Error::new(
                                        io::ErrorKind::NotFound,
                                        "the lock path vanished during the restore",
                                    )
                                }));
                            }
                            // The public path still holds this dance's own
                            // placeholder (or an entry nothing here may
                            // touch): retry a bounded count, then fail
                            // closed with the path held.
                            attempts_left -= 1;
                            if attempts_left == 0 {
                                return Err(last_error.unwrap_or_else(|| {
                                    io::Error::other("the live lease restore never settled")
                                }));
                            }
                        }
                    }
                    if claimed == incumbent {
                        // The judged stale incumbent, held at the private
                        // name: remove it there (owner file first). The
                        // placeholder itself still blocks the public
                        // path - remove it too so the caller's retry
                        // sees an empty path; a missing residue was
                        // removed by a displaced holder's release.
                        if let Err(error) = remove_candidate_dir(&placeholder) {
                            if error.kind() != io::ErrorKind::NotFound {
                                // An un-removable incumbent (foreign
                                // entries in a judged-dead directory)
                                // must not wedge the public path behind
                                // this process's live token: clear the
                                // placeholder and surface the error. The
                                // incumbent stays at the inert private
                                // dotname, never at the public path.
                                let _ = remove_candidate_dir(path);
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
                                let _ = remove_candidate_dir(path);
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
                            // The swap-back failed: the private name
                            // still holds the displaced holder's
                            // directory - never remove it (the dance's
                            // whole point is that another holder's lock
                            // is never unlinked). The public path keeps
                            // the token-protected placeholder until this
                            // process exits, and the displaced holder's
                            // release finds its directory through the
                            // placeholder's claimed-at note.
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
    /// Decide the fate of an incumbent at `path`. Returns only when the
    /// incumbent was removed (or vanished) and acquisition may be retried;
    /// surfaces `WouldBlock` while a live or not-yet-stale lock holds it.
    pub(super) fn judge_and_reclaim(path: &Path, stale_after: Duration) -> io::Result<()> {
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
                // The binding (not a scoped block) keeps the guard
                // alive THROUGH the floor removal below: a successor's
                // judge needs this sidecar to reclaim, so dropping it
                // before the pathname removal opens a gap where the
                // successor publishes a live lock the floor then
                // deletes. The release pass holds its guard across the
                // matching pathname fallback for the same reason; the
                // guard serializes every dance on this lock. The
                // early returns drop it on unwind.
                #[cfg(target_os = "linux")]
                let _reclaim_guard = {
                    let incumbent = {
                        use std::os::unix::fs::MetadataExt;
                        Some((metadata.dev(), metadata.ino()))
                    };
                    let guarded = try_reclaim_guard(path, Duration::from_millis(100));
                    if guarded.is_none() {
                        // Another reclaim dance (or release pass) holds the
                        // serialization guard - likely suspended mid-flight
                        // with a token-protected placeholder at the public
                        // path. The exchange dance must not run unguarded;
                        // report contention and let the caller retry once
                        // the holder completes.
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            format!("Lock file is already being held: {}", path.display()),
                        ));
                    }
                    match Self::claim_stale_incumbent(path, incumbent, stale_after)? {
                        StaleClaim::Removed | StaleClaim::Vanished => return Ok(()),
                        StaleClaim::Successor => {
                            return Err(io::Error::new(
                                io::ErrorKind::WouldBlock,
                                format!("Lock file is already being held: {}", path.display()),
                            ));
                        }
                        StaleClaim::Unsupported => guarded,
                    }
                };
                // The floor reclaim (no no-replace rename): remove every
                // protocol note (owner, claimed-at, and any release
                // marker - a leftover marker makes the plain remove_dir
                // fail ENOTEMPTY and error the next acquire), then the
                // directory, by pathname - the same residual
                // check-then-act window proper-lockfile's own reclaim
                // has. On Linux this runs under the judge's guard, so
                // no judge or release pass interleaves here; the
                // non-Linux Unix floors keep the documented residual
                // window (no sidecar guard exists there).
                #[cfg(unix)]
                match remove_candidate_dir(path) {
                    Ok(()) => return Ok(()),
                    // A racing holder released it first.
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error),
                }
                #[cfg(not(unix))]
                {
                    // Owned locks on these platforms still write the
                    // owner file: remove it before the directory, or
                    // a crashed holder's owned lock cannot be taken over
                    // (the plain remove_dir fails ENOTEMPTY).
                    match fs::remove_file(path.join("owner")) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error),
                    }
                    match fs::remove_dir(path) {
                        Ok(()) => return Ok(()),
                        // A racing holder released it first.
                        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                        Err(error) => return Err(error),
                    }
                }
            }
        }
        // Live lock: contention.
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("Lock file is already being held: {}", path.display()),
        ))
    }
}
