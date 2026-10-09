//! Daemon socket lifecycle: endpoint naming and identity live in
//! [`crate::platform`]; the bind/connect calls go through the shared transport
//! traits in `pa_types::platform`, so Unix socket files today and named pipes later
//! differ only in the implementation module.

use std::path::Path;
use std::time::Duration;

#[cfg(unix)]
use anyhow::anyhow;
use anyhow::Result;

#[cfg(unix)]
pub use crate::platform::socket_dir;
pub use crate::platform::{
    default_daemon_socket_path, socket_identity, worker_socket_path, SocketIdentity,
};

/// Try to connect to an endpoint within `timeout`; true when a peer accepts.
pub async fn can_connect(path: &Path, timeout: Duration) -> bool {
    let connect = pa_types::platform::transport::connect_transport(path);
    match tokio::time::timeout(timeout, connect).await {
        Ok(Ok(stream)) => {
            drop(stream);
            true
        }
        _ => false,
    }
}

/// Staleness after which the cleanup lock of a crashed holder is reclaimed.
/// Unix only: every taker of the cleanup lock sits behind the unix stale-file wall.
#[cfg(unix)]
const LOCK_STALE_AFTER: Duration = Duration::from_secs(5);
/// The bounded grace a lease refresh tolerates a stale-reclaim dance's
/// transient displacement before declaring compromise (a live dance
/// completes in microseconds; only persisting displacements count).
#[cfg(unix)]
const LEASE_DISPLACEMENT_GRACE: Duration = Duration::from_millis(250);
/// Live-lock retry cadence and cap (600 retries): ~15s total.
#[cfg(unix)]
const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(unix)]
const LOCK_RETRIES: u32 = 600;

/// Acquire the cross-process cleanup lock (proper-lockfile's empty
/// `{path}.lock` directory): held for the whole probe/unlink sequence, so a
/// competing startup worker cannot bind a live listener in between.
#[cfg(unix)]
async fn acquire_cleanup_lock(path: &Path) -> Result<pa_core::platform::LockDir> {
    let lock_path = path.to_path_buf();
    for attempt in 0..=LOCK_RETRIES {
        // The acquisition can wait up to the reclaim-guard budget on the
        // sidecar while a stale-reclaim dance holds it - off the async
        // executor, never blocking a Tokio worker thread.
        let attempt_path = lock_path.clone();
        match tokio::task::spawn_blocking(move || {
            pa_core::platform::LockDir::acquire(&attempt_path, LOCK_STALE_AFTER)
        })
        .await
        {
            Ok(Ok(lock)) => return Ok(lock),
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Ok(Err(error)) => return Err(anyhow!("Daemon socket cleanup lock: {error}")),
            Err(join_error) => return Err(anyhow!("Daemon socket cleanup lock: {join_error}")),
        }
        if attempt == LOCK_RETRIES {
            break;
        }
        tokio::time::sleep(LOCK_RETRY_INTERVAL).await;
    }
    Err(anyhow!(
        "Timed out waiting for the daemon socket cleanup lock: {}",
        path.display()
    ))
}

/// The pinned handle is the ownership witness for the acquired lock: a
/// path that no longer resolves to it means the lock was displaced
/// mid-acquisition, so refuse rather than adopt the successor's lease.
#[cfg(unix)]
fn assert_path_pins(lock_path: &Path, lock_dir: &std::fs::File) -> Result<SocketIdentity> {
    let identity = metadata_identity(&lock_dir.metadata()?);
    if !lock_identity_matches(lock_path, &identity) {
        return Err(anyhow!(
            "Daemon socket lock {} was replaced while acquiring it",
            lock_path.display()
        ));
    }
    Ok(identity)
}

/// A supervisor-lifetime proper-lockfile lease on `{socket}.lock`.
/// The opened directory pins the acquired inode across stale takeovers: a
/// displaced holder never refreshes or removes the successor's lock.
#[cfg(unix)]
#[derive(Debug)]
pub struct SocketLease {
    socket_path: std::path::PathBuf,
    lock_path: std::path::PathBuf,
    lock_dir: std::fs::File,
    identity: SocketIdentity,
    compromised: std::sync::Arc<std::sync::atomic::AtomicBool>,
    compromise_tx: tokio::sync::watch::Sender<bool>,
    refresh_stop: std::sync::mpsc::Sender<()>,
    refresh: Option<std::thread::JoinHandle<()>>,
}

#[cfg(unix)]
impl SocketLease {
    /// Wait up to 15s for the exclusive lease; refresh it every second
    /// while the supervisor owns its socket, matching proper-lockfile.
    ///
    /// # Errors
    ///
    /// Returns an error if the directory cannot be created or locked, or if
    /// the acquired lock was replaced before its inode could be pinned.
    pub async fn acquire(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            crate::paths::ensure_dir(parent)?;
        }
        let lock = acquire_cleanup_lock(path).await?;
        let (lock_path, lock_dir) = lock.into_parts();
        // The handle pins the inode this supervisor acquired: if the path
        // check or metadata read fails, ownership is unprovable, so leave
        // the artifact to expire instead of risking removal of a racing
        // successor's lock.
        let identity = assert_path_pins(&lock_path, &lock_dir)?;
        let compromised = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (compromise_tx, _) = tokio::sync::watch::channel(false);
        let task_path = lock_path.clone();
        let task_dir = match lock_dir.try_clone() {
            Ok(dir) => dir,
            Err(error) => {
                // Never leave the just-acquired lock artifact behind a
                // failed handle clone: it would block the next startup
                // behind the stale threshold. The same claim-verify
                // choreography as the lease release removes it - only a
                // directory whose pinned inode still matches this
                // acquisition is removed, and a displaced successor is
                // restored, never unlinked.
                #[cfg(target_os = "linux")]
                release_lock_dir_identity(&lock_path, &identity, &lock_dir);
                #[cfg(not(target_os = "linux"))]
                let _ = (&lock_path, &identity);
                return Err(error.into());
            }
        };
        let task_identity = identity.clone();
        let task_compromised = std::sync::Arc::clone(&compromised);
        let task_tx = compromise_tx.clone();
        let (refresh_stop, stop_rx) = std::sync::mpsc::channel();
        let refresh = std::thread::spawn(move || {
            while stop_rx.recv_timeout(Duration::from_secs(1)).is_err() {
                // The sidecar gates the mtime WRITE only (a dance or
                // release pass in progress must not race a refresh
                // mid-verification); the identity CHECK always runs -
                // a suspended dance leaves a placeholder at the public
                // path, and the monitor must observe that displacement
                // instead of sleeping through it.
                #[cfg(target_os = "linux")]
                let guarded = pa_core::platform::try_reclaim_guard(
                    &task_path,
                    std::time::Duration::from_millis(100),
                );
                let lost = !lock_identity_matches(&task_path, &task_identity);
                #[cfg(target_os = "linux")]
                let write_error = match guarded {
                    Some(guard) => {
                        let failed = task_dir.set_modified(std::time::SystemTime::now()).is_err();
                        drop(guard);
                        failed
                    }
                    // Unguarded (a dance or release pass holds the
                    // sidecar): skip this tick's refresh entirely when
                    // the lease is undisplaced - the identity check
                    // still ran, the next tick retries the write.
                    None if !lost => continue,
                    None => false,
                };
                #[cfg(not(target_os = "linux"))]
                let write_error = task_dir.set_modified(std::time::SystemTime::now()).is_err();
                if lost || write_error || !lock_identity_matches(&task_path, &task_identity) {
                    handle_refresh_failure(
                        lost,
                        write_error,
                        &task_dir,
                        &task_path,
                        &task_identity,
                        &task_compromised,
                        &task_tx,
                    );
                }
            }
        });
        Ok(Self {
            socket_path: path.to_path_buf(),
            lock_path,
            lock_dir,
            identity,
            compromised,
            compromise_tx,
            refresh_stop,
            refresh: Some(refresh),
        })
    }

    /// Whether the lock path still names this lease's pinned inode.
    fn path_lost(&self) -> bool {
        !lock_identity_matches(&self.lock_path, &self.identity)
    }

    /// Whether ownership of this exact lock inode was lost.
    #[must_use]
    pub fn compromised(&self) -> bool {
        self.compromised.load(std::sync::atomic::Ordering::Acquire) || self.path_lost()
    }

    /// Compromise verdict for the direct synchronous callers (boot
    /// fences, the serve-completion recheck, Drop): a single transient
    /// identity mismatch - a stale-reclaim dance holding this lease's
    /// directory displaced for the microseconds of its exchange - gets
    /// the same bounded grace the refresh thread has; a displacement
    /// persisting past the grace is a real compromise. A cached
    /// compromise flag set by the refresh thread is definitive without
    /// re-probing.
    fn compromised_after_grace(&self) -> bool {
        if self.compromised.load(std::sync::atomic::Ordering::Acquire) {
            return true;
        }
        if !self.path_lost() {
            return false;
        }
        std::thread::sleep(LEASE_DISPLACEMENT_GRACE);
        // The cached flag set by the refresh thread during the grace is
        // definitive even if the path reappeared: compromise stays
        // compromise, never downgraded by a restoration.
        self.compromised.load(std::sync::atomic::Ordering::Acquire) || self.path_lost()
    }

    /// Resolve when this lease loses its lock directory. A single
    /// transient mismatch (a reclaim dance's displacement) gets the
    /// same bounded grace before it counts; a displacement persisting
    /// past the grace is a real compromise.
    pub async fn wait_compromised(&self) {
        let mut changes = self.compromise_tx.subscribe();
        loop {
            // The cached flag is definitive on its own; a path mismatch
            // alone gets the grace (the check order matters: compromised()
            // includes the transient path loss and must not gate the
            // grace branch).
            if self.compromised.load(std::sync::atomic::Ordering::Acquire) {
                break;
            }
            if self.path_lost() {
                tokio::time::sleep(LEASE_DISPLACEMENT_GRACE).await;
                if self.compromised() {
                    break;
                }
                continue;
            }
            if changes.changed().await.is_err() {
                break;
            }
        }
    }

    /// # Errors
    ///
    /// Returns an error if this lease was displaced or compromised.
    pub fn assert_held(&self) -> Result<()> {
        self.assert_path_held(&self.socket_path)
    }

    fn assert_path_held(&self, path: &Path) -> Result<()> {
        if path != self.socket_path {
            return Err(anyhow!(
                "Daemon socket lease does not match {}",
                path.display()
            ));
        }
        if self.compromised_after_grace() {
            return Err(anyhow!(
                "Daemon socket lease for {} was compromised",
                path.display()
            ));
        }
        Ok(())
    }

    /// Claim the socket file at `path` under a private name in its own
    /// directory. On filesystems without a no-replace rename (NFS, FUSE)
    /// the claim fails and the cleanup no-ops: the leftover socket file
    /// is self-healing - the next bind's stale-socket prepare removes a
    /// file nothing serves, so unlike the lock directory it never blocks
    /// a startup. A short, basename-independent name keeps the claim
    /// probeable through the `AF_UNIX` address budget no matter how long
    /// the original basename is, and the full-nanosecond process-unique
    /// suffix never wraps. The claim is a no-replace rename, so a live
    /// claimed file preserved by an earlier window (a no-replace restore
    /// that failed because a newer holder owned the vacated path) can
    /// never be overwritten by a later claim; a taken name regenerates
    /// the suffix instead. Returns `None` when the path is empty or no
    /// free claim name is found.
    #[cfg(target_os = "linux")]
    fn claim_under_private_name(path: &std::path::Path) -> Option<std::path::PathBuf> {
        let parent = path.parent()?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |age| age.as_nanos());
        let pid = std::process::id();
        for attempt in 0..8 {
            // The attempt counter de-conflicts even a monotonically
            // stalled clock: pid + nanos + attempt is unique in-process,
            // and the no-replace rename rejects any other collision.
            let claim = parent.join(format!(".u{pid:x}{nanos:x}{attempt:x}"));
            match pa_core::platform::move_without_replacing(path, &claim) {
                Ok(()) => return Some(claim),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return None,
            }
        }
        None
    }

    /// Best-effort unlink of only the bound socket owned by this holder.
    /// On compromise, leave the successor's socket untouched. The socket
    /// file is first claimed under a private name with one atomic rename,
    /// and the liveness probe then binds to the claimed inode through the
    /// private pathname - the claim is ours alone, so no path swap can
    /// slide a live successor between the probe and the removal: the
    /// checked inode is the inode probed is the inode removed. A live or
    /// unknown verdict restores the claimed file without ever clobbering
    /// a newer holder of the vacated path (Linux is the only definitive
    /// verdict; elsewhere the probe fails closed, the exit cleanup
    /// preserves the path, and the next bind's stale-socket prepare
    /// cleans a file nothing serves).
    pub fn cleanup_socket_path(&self, path: &Path, expected: Option<SocketIdentity>) {
        if self.assert_path_held(path).is_err() {
            return;
        }
        let Some(expected) = expected else { return };
        if socket_identity(path) != Some(expected.clone()) {
            return;
        }
        if self.assert_path_held(path).is_err() {
            return;
        }
        // The claim-probe-remove choreography is Linux-only: only there
        // does the definitely-closed verdict exist, and only there can
        // the no-replace moves run. Elsewhere the exit cleanup preserves
        // the path and the next bind's stale-socket prepare cleans a
        // file nothing serves.
        #[cfg(target_os = "linux")]
        {
            let Some(claim) = Self::claim_under_private_name(path) else {
                // Nothing at the path is ours to unlink, or no free
                // claim name could be found.
                return;
            };
            if socket_identity(&claim) == Some(expected) && self.assert_path_held(path).is_ok() {
                // The claimed inode is this holder's own. It is removed
                // only on a definitely-closed verdict probed through the
                // private pathname - the claim cannot be swapped from
                // under this probe, and a poisoned capture (a successor
                // bound during the bind->capture gap) naming the
                // successor's own inode gets its live socket restored,
                // never removed.
                if pa_types::platform::transport::unix_listener_definitely_closed(&claim) {
                    let _ = std::fs::remove_file(&claim);
                } else {
                    let _ = pa_core::platform::move_without_replacing(&claim, path);
                    // A newer holder owns the vacated path: the live
                    // claimed file keeps its private entry (never remove
                    // a live inode's last path entry); its listener
                    // fences on the displaced inode.
                }
            } else if pa_core::platform::move_without_replacing(&claim, path).is_err()
                && pa_types::platform::transport::unix_listener_definitely_closed(&claim)
            {
                // The claim is not ours and cannot go back to a path a
                // newer holder owns: remove it only on a
                // definitely-closed verdict.
                let _ = std::fs::remove_file(&claim);
            }
        }
    }
}

#[cfg(unix)]
impl Drop for SocketLease {
    fn drop(&mut self) {
        let _ = self.refresh_stop.send(());
        if let Some(refresh) = self.refresh.take() {
            let _ = refresh.join();
        }
        // The pinned fd prevents inode reuse while this lease is alive.
        // A successor that reclaimed a stale lock must never be released
        // by us. Linux runs the claim-verify-release choreography;
        // platforms and mounts without a no-replace rename never remove:
        // the lock directory is left to expire through the stale window -
        // a deliberate divergence from proper-lockfile's unconditional
        // release remove - and a reclaiming successor's directory is
        // never touched.
        // ONE compromise verdict, cached before branching: two probes
        // could straddle a dance's restoration (true then false) and
        // mark a lease the release then half-strips, or the reverse
        // (false then true) and skip both marker and release.
        #[cfg(target_os = "linux")]
        let compromised = self.compromised_after_grace();
        #[cfg(not(target_os = "linux"))]
        let compromised = self.compromised();
        if compromised {
            // A compromised or guard-blocked release still MARKS the
            // lease directory released through the pinned fd (pa-core's
            // openat helper - this crate forbids unsafe): the fd follows
            // the inode through every exchange, so the marker lands in
            // this lease's directory wherever it lives; a concurrent
            // reclaim dance then consumes the abandoned directory
            // instead of restoring it, and no judge refuses it behind
            // this process's live pid - mirroring LockDir::release's
            // marker path for the same case.
            #[cfg(target_os = "linux")]
            pa_core::platform::mark_released_through(&self.lock_dir);
        } else {
            self.release_lock_dir();
        }
        let _ = &self.lock_dir;
    }
}

/// The refresh tick's failure path: a transient write error retries
/// under the sidecar after the grace (a persistent failure is a
/// compromise, never letting the lock age silently past the stale
/// threshold), and an identity displacement walks the grace before
/// declaring compromise - a live reclaim dance restores the directory,
/// a persistent displacement (a suspended dance's placeholder, or a
/// real takeover) is a compromise.
#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn handle_refresh_failure(
    lost: bool,
    write_error: bool,
    task_dir: &std::fs::File,
    task_path: &Path,
    task_identity: &SocketIdentity,
    task_compromised: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    task_tx: &tokio::sync::watch::Sender<bool>,
) {
    if write_error && !lost {
        // Retry the mtime write after the grace - under the sidecar
        // again: an unguarded retry could refresh a stale judge's
        // claimed inode mid-verification, the exact race the heartbeat
        // coordination exists to prevent.
        std::thread::sleep(LEASE_DISPLACEMENT_GRACE);
        #[cfg(target_os = "linux")]
        {
            match pa_core::platform::try_reclaim_guard(
                task_path,
                std::time::Duration::from_millis(100),
            ) {
                // A dance or release pass is active: defer the retry to
                // the next tick.
                None => return,
                Some(retry_guard) => {
                    let retry_failed = task_dir.set_modified(std::time::SystemTime::now()).is_err()
                        || !lock_identity_matches(task_path, task_identity);
                    drop(retry_guard);
                    if retry_failed {
                        task_compromised.store(true, std::sync::atomic::Ordering::Release);
                        task_tx.send_replace(true);
                    }
                    return;
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            if task_dir.set_modified(std::time::SystemTime::now()).is_err()
                || !lock_identity_matches(task_path, task_identity)
            {
                task_compromised.store(true, std::sync::atomic::Ordering::Release);
                task_tx.send_replace(true);
            }
            return;
        }
    }
    // A stale-reclaim dance may hold this lease's directory displaced for
    // the microseconds of its exchange: tolerate a bounded grace before
    // declaring compromise - a live dance restores the directory and the
    // lease keeps serving; only a displacement persisting past the grace
    // is a compromise.
    std::thread::sleep(LEASE_DISPLACEMENT_GRACE);
    if !lock_identity_matches(task_path, task_identity) {
        task_compromised.store(true, std::sync::atomic::Ordering::Release);
        task_tx.send_replace(true);
    }
}

/// The lease release: Linux runs the airtight claim-verify-release
/// choreography (`release_lock_dir_identity` below). Other unix
/// platforms, and Linux mounts whose filesystem rejects `renameat2`
/// (NFS, FUSE - the same mounts where the acquisition falls back to the
/// mkdir protocol), have no successor-safe removal: every
/// check-then-act remove can delete a successor that stale-reclaimed
/// this lock in the window between the check and the remove, and no
/// user-space margin bounds the scheduler's part in that window. The
/// release there is a deliberate no-op: the lock directory is left to
/// expire through the stale window, and a reclaiming successor's
/// directory is never touched. This is a deliberate DIVERGENCE from
/// proper-lockfile, which removes its lock unconditionally on release
/// (`removeLock`/`onExit` in lockfile.js) and accepts that window; the
/// price of successor safety here is one stale window on the next
/// startup where the no-replace primitive does not exist (macOS's
/// `renameatx_np` is not used either).
#[cfg(unix)]
impl SocketLease {
    #[cfg(target_os = "linux")]
    fn release_lock_dir(&self) {
        release_lock_dir_identity(&self.lock_path, &self.identity, &self.lock_dir);
    }

    #[cfg(not(target_os = "linux"))]
    fn release_lock_dir(&self) {
        // No no-replace rename exists here: never remove (see above).
    }
}

/// The claim-verify-release choreography for a held lock directory
/// (Linux only, like the socket cleanup it mirrors), under the
/// mandatory reclaim guard: the lock directory is EXCHANGED with a
/// blocking placeholder (a `renameat2` swap - the public path is never
/// vacated, so a concurrent startup can never acquire the gap), removed
/// only when the exchanged inode still matches the acquisition's
/// identity, and a displaced successor is swapped back home atomically
/// (occupancy cannot fail, so the delete-a-foreign-directory arm is
/// unrepresentable). A takeover landing between the identity check and
/// the removal can never have its own lock unlinked, and the public
/// path is continuously held by either the lease or the placeholder.
#[cfg(target_os = "linux")]
fn release_lock_dir_identity(
    lock_path: &Path,
    identity: &SocketIdentity,
    lock_dir: &std::fs::File,
) {
    // Serialize with any concurrent stale-reclaim dance (the sidecar's
    // flock): the lease's release choreography and the dance's
    // exchanges must never interleave on the same lock directory. The
    // guard is MANDATORY: without it (a suspended dance holds the
    // sidecar past the budget) the choreography is skipped entirely and
    // the lease artifact expires through the stale window instead, the
    // documented floor.
    let Some(guarded) =
        pa_core::platform::try_reclaim_guard(lock_path, std::time::Duration::from_millis(100))
    else {
        // A suspended dance holds the sidecar past the budget: the
        // choreography is skipped, and the lease artifact is MARKED
        // released through the pinned fd (the fd follows the inode
        // through every exchange) so the dance consumes the directory
        // instead of restoring it - the same marker path a compromised
        // lease takes. Without the marker the abandoned inode could be
        // swapped back onto the public lock path and the next daemon
        // would wait out a full stale window on a lock nobody holds.
        pa_core::platform::mark_released_through(lock_dir);
        return;
    };
    let Some(parent) = lock_path.parent() else {
        drop(guarded);
        return;
    };
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |age| age.as_nanos());
    let pid = std::process::id();
    for attempt in 0..8 {
        let placeholder = parent.join(format!(".l{pid:x}{nanos:x}{attempt:x}"));
        if let Err(_error) = std::fs::create_dir(&placeholder) {
            continue;
        }
        // The placeholder carries this process's live owner record for
        // the whole exchange interval: a suspended release leaves a
        // live-owned artifact at the public path, never a vacancy.
        let owner_record = format!(
            "{} {:#x}\n",
            std::process::id(),
            uuid::Uuid::new_v4().as_u128()
        );
        if std::fs::write(placeholder.join("owner"), owner_record).is_err() {
            let _ = std::fs::remove_dir(&placeholder);
            drop(guarded);
            return;
        }
        // The created placeholder's identity: on an AMBIGUOUS exchange
        // error the swap may have completed with the incumbent (or a
        // racing successor) at the private name - the cleanup below
        // deletes the placeholder only after proving the private name
        // still resolves to THIS created inode, exactly like the
        // publish-error proof in the acquisition path.
        let placeholder_identity = std::fs::symlink_metadata(&placeholder)
            .ok()
            .map(|metadata| {
                use std::os::unix::fs::MetadataExt;
                (metadata.dev(), metadata.ino())
            });
        // The exchange: the public path holds the placeholder while the
        // incumbent sits at the private name.
        if pa_core::platform::exchange_paths(lock_path, &placeholder).is_err() {
            // The exchange errored - but an error does NOT prove the
            // public path was never displaced: the swap may have
            // completed with the incumbent (or a racing successor) at
            // the private name. The cleanup runs ONLY on a positive
            // identity match with this process's created placeholder -
            // both stats must succeed and agree - so an ambiguous
            // result preserves the displaced lock. A missing public
            // path means the lease directory vanished - the release is
            // complete. An unsupported-rename mount means this
            // choreography cannot run here at all - the artifact
            // expires through the stale window, the documented floor.
            let identity_proved = placeholder_identity.is_some_and(|expected| {
                std::fs::symlink_metadata(&placeholder)
                    .ok()
                    .map(|metadata| {
                        use std::os::unix::fs::MetadataExt;
                        (metadata.dev(), metadata.ino())
                    })
                    == Some(expected)
            });
            if identity_proved {
                let _ = std::fs::remove_file(placeholder.join("owner"));
                let _ = std::fs::remove_dir(&placeholder);
            }
            drop(guarded);
            return;
        }
        {
            {
                if lock_identity_matches(&placeholder, identity) {
                    // This lease's directory, held where nothing can
                    // replace it: remove it completely, then clear the
                    // placeholder from the public path.
                    let _ = std::fs::remove_file(placeholder.join("owner"));
                    let _ = std::fs::remove_dir(&placeholder);
                    let _ = std::fs::remove_file(lock_path.join("owner"));
                    let _ = std::fs::remove_dir(lock_path);
                } else {
                    // Not this lease's directory: a successor's live
                    // lock. Swap it home atomically and remove the
                    // placeholder ONLY after a verified successful swap
                    // - a failed swap leaves the successor's directory
                    // at the private name, and stripping the placeholder
                    // (the same name) would delete the foreign lock.
                    // Fail closed: preserve the displaced lease.
                    if pa_core::platform::exchange_paths(lock_path, &placeholder).is_ok() {
                        let _ = std::fs::remove_file(placeholder.join("owner"));
                        let _ = std::fs::remove_dir(&placeholder);
                    }
                }
                drop(guarded);
                return;
            }
        }
    }
    drop(guarded);
}

#[cfg(unix)]
fn metadata_identity(metadata: &std::fs::Metadata) -> SocketIdentity {
    use std::os::unix::fs::MetadataExt;
    SocketIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
    }
}

#[cfg(unix)]
fn lock_identity_matches(path: &Path, expected: &SocketIdentity) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.file_type().is_dir() && metadata_identity(&metadata) == *expected
    })
}

/// Remove a stale socket file after verifying nothing is listening.
/// Unix only: a stale socket file blocks `bind`; named pipes have no filesystem
/// residue, so preparing the path is a no-op there.
///
/// # Errors
///
/// Returns an error when the parent directory cannot be created, a live listener
/// answers, the cleanup lock cannot be acquired, or the cleanup fails.
#[cfg(unix)]
pub async fn prepare_socket_path(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        crate::paths::ensure_dir(parent)?;
    }
    // lstat, not `Path::exists()`: a dangling symlink still blocks `bind`
    // while `exists()` (which follows links) denies it.
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(anyhow!("Daemon socket path stat failed: {error}")),
        Ok(_) => {}
    }
    // Quick refusal before taking the cross-process lock: a second daemon
    // fails fast instead of queueing.
    if can_connect(path, Duration::from_millis(250)).await {
        return Err(anyhow!("Daemon socket already in use: {}", path.display()));
    }
    let _lock = acquire_cleanup_lock(path).await?;
    prepare_locked_socket_path(path, None).await
}

/// Prepare under the supervisor-lifetime lease. Unlike the short-lived
/// cleanup lock, this lease remains held through bind and the accept loop.
///
/// # Errors
///
/// Returns an error if the lease is compromised, the path is non-socket, or
/// a live listener or replaced inode prevents stale cleanup.
#[cfg(unix)]
pub async fn prepare_socket_path_with_lease(path: &Path, lease: &SocketLease) -> Result<()> {
    lease.assert_path_held(path)?;
    if let Some(parent) = path.parent() {
        crate::paths::ensure_dir(parent)?;
    }
    prepare_locked_socket_path(path, Some(lease)).await
}

/// Probe + grace wait + unlink for a probed-stale socket file; the caller owns the cleanup lock.
#[cfg(unix)]
async fn prepare_locked_socket_path(path: &Path, lease: Option<&SocketLease>) -> Result<()> {
    use std::os::unix::fs::FileTypeExt;
    if let Some(lease) = lease {
        lease.assert_path_held(path)?;
    }
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(anyhow!("Daemon socket path stat failed: {error}")),
    };
    if !metadata.file_type().is_socket() {
        return Err(anyhow!(
            "Daemon socket path exists and is not a socket: {}",
            path.display()
        ));
    }
    let stale_identity = SocketIdentity {
        dev: std::os::unix::fs::MetadataExt::dev(&metadata),
        ino: std::os::unix::fs::MetadataExt::ino(&metadata),
    };
    if can_connect(path, Duration::from_millis(250)).await {
        return Err(anyhow!("Daemon socket already in use: {}", path.display()));
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
        if !path.exists() {
            return Ok(());
        }
        match socket_identity(path) {
            None => return Ok(()),
            Some(current) if current == stale_identity => {}
            Some(_) => {
                return Err(anyhow!(
                    "Daemon socket changed ownership while waiting for cleanup: {}",
                    path.display()
                ))
            }
        }
        if can_connect(path, Duration::from_millis(250)).await {
            return Err(anyhow!("Daemon socket already in use: {}", path.display()));
        }
    }
    if let Some(lease) = lease {
        lease.assert_path_held(path)?;
    }
    unlink_stale_socket_with_lease(path, stale_identity, lease).await
}

/// Final gate before unlinking a probed-stale socket: refuse while a live
/// listener answers, and remove only the exact inode that was probed stale —
/// a file replaced between the probe and the unlink stays untouched. The
/// identity gate covers processes that do not take the cleanup lock.
#[cfg(all(test, unix))]
async fn unlink_stale_socket(path: &Path, expected: SocketIdentity) -> Result<()> {
    unlink_stale_socket_with_lease(path, expected, None).await
}

#[cfg(unix)]
async fn unlink_stale_socket_with_lease(
    path: &Path,
    expected: SocketIdentity,
    lease: Option<&SocketLease>,
) -> Result<()> {
    if can_connect(path, Duration::from_millis(250)).await {
        return Err(anyhow!("Daemon socket already in use: {}", path.display()));
    }
    match socket_identity(path) {
        None => Ok(()),
        Some(current) if current == expected => {
            if let Some(lease) = lease {
                lease.assert_path_held(path)?;
            }
            std::fs::remove_file(path)?;
            Ok(())
        }
        Some(_) => Err(anyhow!(
            "Daemon socket changed ownership while waiting for cleanup: {}",
            path.display()
        )),
    }
}

/// Windows arm of [`prepare_socket_path`]: named-pipe endpoints have no
/// filesystem residue (the first listener creates the pipe), so preparing
/// the path is a no-op.
///
/// # Errors
///
/// Does not error: there is no path to prepare for a named pipe.
// The signature stays async for the shared unix callers (the await is
// the unix arm's own; the pipe arm has no path to prepare).
#[cfg(not(unix))]
#[cfg_attr(not(unix), allow(clippy::unused_async))]
pub async fn prepare_socket_path(_path: &Path) -> Result<()> {
    Ok(())
}

/// Remove the socket file when it still belongs to this supervisor
/// incarnation (no-op for named pipes). The remove runs best-effort under
/// the cleanup lock: contention means another daemon owns the socket path.
pub fn cleanup_socket_path(path: &Path, expected_identity: Option<SocketIdentity>) {
    if !path.exists() {
        return;
    }
    #[cfg(unix)]
    let Ok(_cleanup_lock) = pa_core::platform::LockDir::acquire(path, LOCK_STALE_AFTER) else {
        return;
    };
    if let Some(expected) = expected_identity {
        match socket_identity(path) {
            Some(current) if current == expected => {}
            _ => return,
        }
    }
    let _ = std::fs::remove_file(path);
}

/// The exit cleanup after the owner's own listener is closed (the TS
/// graceful-shutdown sequence closes before cleanup). A successor's live
/// listener must survive even when a poisoned bind-time identity capture
/// names the successor's inode. A nonblocking connect can distinguish a
/// definitely closed listener (`ECONNREFUSED`) from a saturated backlog
/// (`EAGAIN` on Linux); unknown outcomes preserve the socket path. Only
/// after definite refusal may the existing cleanup lock and identity gate
/// unlink the stale, still-ours socket. TS cleanup checks identity alone,
/// so the poisoned-capture case remains a disclosed TS difference.
///
/// A caller without a captured identity never unlinks: `None` skips
/// `cleanup_socket_path`'s inode gate, so a replacement that binds the
/// path between this probe and that remove would lose its live file to
/// an identity-less unlink. The worker's exit paths wait for the serve
/// handshake's confirmation - which always follows the identity capture -
/// so a registration-refusal exit inside the bind->capture window still
/// reads its own captured identity; `None` reaches here only from exits
/// before the bind (no listener, no file) or from platforms without a
/// file identity (named pipes), and the cleanup stays a no-op.
#[cfg(unix)]
pub fn cleanup_socket_path_after_close(path: &Path, expected_identity: Option<SocketIdentity>) {
    if expected_identity.is_none()
        || !path.exists()
        || !pa_types::platform::transport::unix_listener_definitely_closed(path)
    {
        return;
    }
    cleanup_socket_path(path, expected_identity);
}

#[cfg(not(unix))]
pub fn cleanup_socket_path_after_close(_path: &Path, _expected_identity: Option<SocketIdentity>) {}

/// Restrict the bound socket file to its owner (Unix mode 0o600; Windows
/// named pipes use ACLs on the pipe object instead).
pub fn restrict_socket_path(path: &Path) {
    let _ = pa_core::platform::perms::restrict_file(path);
}

/// The bind-capture gap seam (the `PA_DAEMON_EVENT_LOG` seam family): a
/// replacement landing between the bind and the bind-time identity capture
/// poisons the captured identity - the exact residual the
/// close-listener exit cleanup exists to survive. Production leaves the
/// gap unset, so the bind and the capture stay back-to-back; the
/// poisoned-capture oracle sets the gap so the replacement provably lands
/// in the window instead of racing microseconds.
pub const BIND_CAPTURE_GAP_ENV: &str = "PA_DAEMON_BIND_CAPTURE_GAP_MS";

/// Sleep the bounded bind-capture fault-injection gap in debug builds only.
/// Production binaries never pause startup between bind and identity capture.
pub async fn bind_capture_gap() {
    #[cfg(debug_assertions)]
    if let Ok(raw) = std::env::var(BIND_CAPTURE_GAP_ENV) {
        if let Ok(ms @ 1..=2_000) = raw.parse::<u64>() {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use pa_types::platform::transport::bind_transport;

    /// Bind and drop the listener: the socket file outlives the fd with
    /// nobody listening - exactly a crashed worker's residue.
    async fn bind_stale_socket(path: &Path) {
        drop(bind_transport(path).await.expect("bind stale socket"));
    }

    #[tokio::test]
    async fn lifetime_lease_refuses_a_replacement_and_never_releases_successors_lock() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let lease = SocketLease::acquire(&socket).await.unwrap();
        let lock_path = pa_core::platform::LockDir::path_for(&socket);
        assert!(lock_path.is_dir());
        let listener = bind_transport(&socket).await.unwrap();
        let own_socket = socket_identity(&socket);
        let old_dir = dir.path().join("previous.lock");
        std::fs::rename(&lock_path, &old_dir).unwrap();
        std::fs::create_dir(&lock_path).unwrap();
        assert!(lease.compromised());
        lease.cleanup_socket_path(&socket, own_socket);
        assert!(
            socket.exists(),
            "compromised holder cannot unlink its former socket"
        );
        tokio::time::timeout(Duration::from_secs(2), lease.wait_compromised())
            .await
            .unwrap();
        drop(lease);
        assert!(
            lock_path.is_dir(),
            "old lease must not remove successor lock"
        );
        drop(listener);
    }

    #[tokio::test]
    async fn lifetime_lease_guards_stale_cleanup_and_refuses_live_socket() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        bind_stale_socket(&socket).await;
        let lease = SocketLease::acquire(&socket).await.unwrap();
        prepare_socket_path_with_lease(&socket, &lease)
            .await
            .unwrap();
        let listener = bind_transport(&socket).await.unwrap();
        let error = prepare_socket_path_with_lease(&socket, &lease)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("already in use"), "{error}");
        // A live listener at the path outranks even the holder's own
        // identity match: the exit cleanup only takes dead files.
        lease.cleanup_socket_path(&socket, socket_identity(&socket));
        assert!(socket.exists(), "the live socket survives the cleanup");
        drop(listener);
        lease.cleanup_socket_path(&socket, socket_identity(&socket));
        // Linux: the dead file is claimed and unlinked. Elsewhere the
        // probe has no definitive verdict, the exit cleanup preserves
        // the path, and the next bind's stale-socket prepare cleans it.
        #[cfg(target_os = "linux")]
        assert!(!socket.exists(), "the dead socket is claimed and unlinked");
        #[cfg(not(target_os = "linux"))]
        assert!(
            socket.exists(),
            "the conservative cleanup preserves the path"
        );
        drop(lease);
        // The lock directory's release is platform-split: the Linux
        // claim-verify choreography removes it, the no-noreplace floor
        // leaves it to expire through the stale window.
        #[cfg(target_os = "linux")]
        assert!(!pa_core::platform::LockDir::path_for(&socket).exists());
        #[cfg(not(target_os = "linux"))]
        assert!(
            pa_core::platform::LockDir::path_for(&socket).exists(),
            "the leave-expire floor keeps the lock directory for the stale window"
        );
    }

    #[test]
    fn path_pins_refuses_a_lock_replaced_after_the_pin() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let lock_path = pa_core::platform::LockDir::path_for(&socket);
        std::fs::create_dir(&lock_path).unwrap();
        let pinned = std::fs::File::open(&lock_path).unwrap();
        // A stale takeover displaces the pinned inode after the pin.
        let aside = dir.path().join("displaced.lock");
        std::fs::rename(&lock_path, &aside).unwrap();
        std::fs::create_dir(&lock_path).unwrap();
        let error = assert_path_pins(&lock_path, &pinned).unwrap_err();
        assert!(
            error.to_string().contains("replaced while acquiring"),
            "{error}"
        );
        // The refusal leaves the successor's artifact untouched.
        assert!(lock_path.is_dir());
        // The matching case: the pinned inode back at the path is held.
        std::fs::remove_dir(&lock_path).unwrap();
        std::fs::rename(&aside, &lock_path).unwrap();
        assert_path_pins(&lock_path, &pinned).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn release_restores_a_successor_lock_claimed_in_the_takeover_race() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let lease = SocketLease::acquire(&socket).await.unwrap();
        let lock_path = pa_core::platform::LockDir::path_for(&socket);
        // A successor's replacement sits at the lock path - the takeover
        // race the atomic claim exists for; the lease's own directory is
        // displaced and pinned by its fd.
        let own = dir.path().join("own.lock");
        std::fs::rename(&lock_path, &own).unwrap();
        std::fs::create_dir(&lock_path).unwrap();
        // The release must restore the successor's directory, never unlink
        // it, even when it wins the claim on the lock path.
        lease.release_lock_dir();
        assert!(
            lock_path.is_dir(),
            "a claimed successor lock must be restored"
        );
        // The compromised lease still skips the release on drop.
        drop(lease);
        assert!(
            lock_path.is_dir(),
            "a compromised lease must not release the successor's lock"
        );
    }

    /// A long-basename socket stays claim-probeable: the claim is a
    /// basename-independent dotname in the socket's own directory, so
    /// the claim path is short no matter how long the bound name was -
    /// this pins the address-budget fix for names whose sibling-claim
    /// form exceeded the `AF_UNIX` limit.
    #[cfg(all(unix, target_os = "linux"))]
    #[tokio::test]
    async fn socket_cleanup_claims_a_dead_socket_with_a_long_basename() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("x".repeat(82));
        let lease = SocketLease::acquire(&socket).await.unwrap();
        let listener = bind_transport(&socket).await.unwrap();
        let bound = socket_identity(&socket);
        drop(listener);
        lease.cleanup_socket_path(&socket, bound);
        assert!(
            !socket.exists(),
            "the long-named dead socket is claimed and unlinked"
        );
        drop(lease);
        // This test is Linux-only: the claim-verify choreography removes
        // the lock directory with the lease.
        assert!(!pa_core::platform::LockDir::path_for(&socket).exists());
    }

    #[tokio::test]
    async fn socket_cleanup_spares_a_live_successor_and_claims_dead_files() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let lease = SocketLease::acquire(&socket).await.unwrap();
        let lock_path = pa_core::platform::LockDir::path_for(&socket);
        let listener = bind_transport(&socket).await.unwrap();
        let bound = socket_identity(&socket);
        // The exit sequence closes the listener before the cleanup: the
        // dead file is the only thing the claim may take.
        drop(listener);
        lease.cleanup_socket_path(&socket, bound.clone());
        // Linux: the dead file is claimed and unlinked. Elsewhere the
        // probe has no definitive verdict, the exit cleanup preserves
        // the path, and the next bind's stale-socket prepare cleans it.
        #[cfg(target_os = "linux")]
        assert!(
            !socket.exists(),
            "the dead bound socket is claimed and unlinked"
        );
        #[cfg(not(target_os = "linux"))]
        assert!(
            socket.exists(),
            "the conservative cleanup preserves the dead bound socket"
        );
        // A poisoned capture (a replacement bound while the capture was
        // parked in the bind->capture gap) names the successor's own
        // inode; the live-listener probe outranks the identity match -
        // on every unix target. Off Linux the conservative cleanup
        // preserved the dead bound file, so the successor bind goes
        // through the lease's stale-socket prepare (a no-op on Linux,
        // where the cleanup already removed the file).
        prepare_socket_path_with_lease(&socket, &lease)
            .await
            .unwrap();
        let successor = bind_transport(&socket).await.unwrap();
        let poisoned = socket_identity(&socket);
        lease.cleanup_socket_path(&socket, poisoned.clone());
        assert!(
            socket.exists(),
            "the live successor survives the poisoned identity"
        );
        // Once the successor dies, the same cleanup takes its dead file
        // on Linux; elsewhere it preserves it conservatively.
        drop(successor);
        lease.cleanup_socket_path(&socket, poisoned);
        #[cfg(target_os = "linux")]
        assert!(
            !socket.exists(),
            "the dead successor file is claimed and unlinked"
        );
        #[cfg(not(target_os = "linux"))]
        assert!(
            socket.exists(),
            "the conservative cleanup preserves the dead successor file"
        );
        drop(lease);
        // The lock directory's release is platform-split: the Linux
        // claim-verify choreography removes it with the lease, the
        // no-noreplace floor leaves it to expire through the stale
        // window.
        #[cfg(target_os = "linux")]
        assert!(!lock_path.exists());
        #[cfg(not(target_os = "linux"))]
        assert!(
            lock_path.exists(),
            "the leave-expire floor keeps the lock directory for the stale window"
        );
    }

    #[tokio::test]
    async fn missing_path_prepares_as_a_no_op() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        prepare_socket_path(&socket).await.unwrap();
        assert!(!socket.exists());
    }

    #[tokio::test]
    async fn a_dangling_symlink_is_rejected_as_not_a_socket() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        std::os::unix::fs::symlink(dir.path().join("missing.sock"), &socket).unwrap();
        let error = prepare_socket_path(&socket).await.unwrap_err();
        assert!(error.to_string().contains("not a socket"), "{error}");
        assert!(std::fs::symlink_metadata(&socket).is_ok());
    }

    #[tokio::test]
    async fn non_socket_file_at_the_path_is_refused_and_preserved() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        std::fs::write(&socket, b"not a socket").unwrap();
        let error = prepare_socket_path(&socket).await.unwrap_err();
        assert!(error.to_string().contains("not a socket"), "{error}");
        assert!(socket.exists());
    }

    #[tokio::test]
    async fn live_listener_is_never_unlinked() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let listener = bind_transport(&socket).await.unwrap();
        let error = prepare_socket_path(&socket).await.unwrap_err();
        assert!(error.to_string().contains("already in use"), "{error}");
        assert!(socket.exists());
        assert!(can_connect(&socket, Duration::from_millis(250)).await);
        drop(listener);
    }

    /// Dropping the bound listener is the graceful close the exit
    /// cleanups run before their unlink (the TS `server.close` step,
    /// daemon-mode.ts:8011-8018): the bind releases (a fresh connect is
    /// refused) while the socket FILE survives (the close never
    /// unlinks), an in-flight accepted stream keeps serving across the
    /// close, and the listener's own fd is closed while the in-flight
    /// stream's fd stays open - no fd is leaked on the bound socket
    /// across the exit sequence.
    /// The fd-leak oracle reads `/proc/self/fd`, so it runs where that
    /// exists: the neighbors' `target_os = "linux"` gate, not bare `unix`
    /// (macOS has no `/proc` and the fd probes would always read false).
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn dropping_the_listener_is_the_graceful_exit_close() {
        use std::io::Write;
        use std::os::fd::AsRawFd;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        fn fd_exists(fd: std::os::fd::RawFd) -> bool {
            std::fs::read_link(format!("/proc/self/fd/{fd}")).is_ok()
        }

        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        // One accepted connection in flight: the client connected, the
        // listener accepted; the stream must survive the listener's close.
        let mut client = std::os::unix::net::UnixStream::connect(&socket).unwrap();
        let mut accepted = listener.accept().await.unwrap().0;
        let listener_fd = listener.as_raw_fd();
        let accepted_fd = accepted.as_raw_fd();
        assert!(fd_exists(listener_fd));
        // The leak check compares the fd's /proc TARGET (the socket's
        // anon inode), never the bare fd number: parallel tests recycle
        // fd numbers the moment a close lands, so a bare-number probe
        // misreads another test's fresh fd as a leak. The exact socket
        // object is what a leak would still reference.
        let listener_target = std::fs::read_link(format!("/proc/self/fd/{listener_fd}"))
            .expect("the bound listener's fd target before the drop");
        drop(listener);
        let leaked_at_fd = std::fs::read_link(format!("/proc/self/fd/{listener_fd}"));
        assert!(
            !matches!(&leaked_at_fd, Ok(target) if *target == listener_target),
            "the listener's socket object is no longer referenced at the dropped fd: no fd leaked on the bound socket"
        );
        assert!(
            fd_exists(accepted_fd),
            "the in-flight accepted stream's fd survives the close"
        );
        assert!(socket.exists(), "the close never unlinks the file");
        assert!(
            !can_connect(&socket, Duration::from_millis(250)).await,
            "the bind released at the drop"
        );
        // The in-flight stream still moves bytes across the close.
        client.write_all(b"ping").unwrap();
        let mut buffer = [0u8; 4];
        accepted.read_exact(&mut buffer).await.unwrap();
        assert_eq!(&buffer, b"ping");
        assert!(accepted.flush().await.is_ok());
    }

    /// The exit cleanup after the owner's listener closed spares a LIVE
    /// successor even when the expected identity matches that
    /// successor's file exactly - the poisoned capture a replacement
    /// landing in the bind->capture window produces - and still unlinks
    /// the dead file the matching identity describes (the still-ours
    /// direction: a respawn does not wait out the stale-socket path).
    #[tokio::test]
    async fn exit_cleanup_after_close_spares_a_live_successor_with_a_matching_identity() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        // The owner's own bind, closed exactly like the exit sequences
        // close it before their cleanup.
        let owner = bind_transport(&socket).await.unwrap();
        drop(owner);
        // The poisoned capture: the successor binds the path after the
        // owner's file is renamed aside, and the "captured" identity is
        // the successor's own file (a replacement landing in the
        // bind->capture window stores exactly this).
        let aside = dir.path().join("owner.sock");
        std::fs::rename(&socket, &aside).unwrap();
        let successor = bind_transport(&socket).await.unwrap();
        let poisoned = socket_identity(&socket).unwrap();
        cleanup_socket_path_after_close(&socket, Some(poisoned.clone()));
        assert!(
            socket.exists(),
            "a live successor is never unlinked, even with a matching identity"
        );
        assert!(can_connect(&socket, Duration::from_millis(250)).await);
        drop(successor);
        std::fs::remove_file(&aside).unwrap();
    }

    /// The still-ours direction of the close cleanup: the matching
    /// identity now describes a dead file the probe passed as definitely
    /// closed. Linux-only because `unix_listener_definitely_closed` only
    /// rules `ECONNREFUSED` definitive there (a saturated BSD/macOS
    /// backlog also refuses, so those platforms never reach this arm).
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn exit_cleanup_after_close_unlinks_the_dead_still_ours_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let owner = bind_transport(&socket).await.unwrap();
        let identity = socket_identity(&socket).unwrap();
        drop(owner);
        cleanup_socket_path_after_close(&socket, Some(identity));
        assert!(!socket.exists(), "the dead still-ours file is unlinked");
    }

    /// Off Linux the refused probe is ambiguous (a saturated backlog
    /// also refuses), so the close cleanup preserves the dead still-ours
    /// file; the next bind's stale-socket prepare clears it instead.
    #[cfg(not(target_os = "linux"))]
    #[tokio::test]
    async fn exit_cleanup_off_linux_preserves_the_dead_file_until_the_next_bind() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let owner = bind_transport(&socket).await.unwrap();
        let identity = socket_identity(&socket).unwrap();
        drop(owner);
        cleanup_socket_path_after_close(&socket, Some(identity));
        assert!(
            socket.exists(),
            "off Linux the close cleanup never claims a dead file from the probe alone"
        );
        prepare_socket_path(&socket).await.unwrap();
        assert!(
            !socket.exists(),
            "the next bind's stale-socket prepare clears the preserved dead file"
        );
    }

    /// A full accept queue is not proof of a dead listener: the successor's
    /// inode can exactly match a poisoned bind-time identity capture.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn exit_cleanup_preserves_a_backlogged_successor_with_a_matching_identity() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let owner = bind_transport(&socket).await.unwrap();
        drop(owner);
        let aside = dir.path().join("owner.sock");
        std::fs::rename(&socket, &aside).unwrap();
        let successor = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        socket2::SockRef::from(&successor).listen(1).unwrap();
        let poisoned = socket_identity(&socket).unwrap();
        let mut queued = Vec::new();
        // Never accept: hold each successful connection until the queue fills.
        for _ in 0..4 {
            match tokio::time::timeout(
                Duration::from_millis(100),
                tokio::net::UnixStream::connect(&socket),
            )
            .await
            {
                Ok(Ok(stream)) => queued.push(stream),
                _ => break,
            }
        }
        assert!(!queued.is_empty());
        assert!(
            !can_connect(&socket, Duration::from_millis(100)).await,
            "the successor's queue must be saturated for this oracle"
        );
        cleanup_socket_path_after_close(&socket, Some(poisoned.clone()));
        assert!(
            socket.exists(),
            "a live backlogged successor must not be unlinked"
        );
        drop(successor);
        cleanup_socket_path_after_close(&socket, Some(poisoned));
        assert!(
            !socket.exists(),
            "the same inode unlinks after its listener closes"
        );
        drop(queued);
        std::fs::remove_file(&aside).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn exit_cleanup_unlinks_a_closed_listener_on_a_long_socket_path() {
        let dir = tempfile::TempDir::new().unwrap();
        let deep = dir.path().join("a".repeat(80)).join("b".repeat(80));
        std::fs::create_dir_all(&deep).unwrap();
        let socket = deep.join("daemon.sock");
        let owner = bind_transport(&socket).await.unwrap();
        let identity = socket_identity(&socket).unwrap();
        drop(owner);
        cleanup_socket_path_after_close(&socket, Some(identity));
        assert!(!socket.exists(), "deep stale path still unlinks");
    }

    #[tokio::test]
    async fn stale_socket_file_is_removed_and_the_path_rebinds() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        bind_stale_socket(&socket).await;
        assert!(socket.exists());
        prepare_socket_path(&socket).await.unwrap();
        assert!(!socket.exists(), "stale socket file must be unlinked");
        bind_transport(&socket)
            .await
            .expect("bind after stale cleanup");
    }

    #[tokio::test]
    async fn unlink_refuses_a_live_listener_even_when_marked_stale() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let listener = bind_transport(&socket).await.unwrap();
        let stale = socket_identity(&socket).unwrap();
        let error = unlink_stale_socket(&socket, stale).await.unwrap_err();
        assert!(error.to_string().contains("already in use"), "{error}");
        assert!(socket.exists());
        drop(listener);
    }

    #[tokio::test]
    async fn unlink_refuses_a_replaced_file_with_a_new_identity() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        bind_stale_socket(&socket).await;
        let stale = socket_identity(&socket).unwrap();
        // Move the probed file aside instead of unlinking it: its inode stays
        // allocated, so the replacement is guaranteed a different inode (a freed
        // inode could be handed straight back to the replacement).
        let aside = dir.path().join("probed.sock");
        std::fs::rename(&socket, &aside).unwrap();
        bind_stale_socket(&socket).await;
        assert_ne!(socket_identity(&socket).unwrap(), stale);
        let error = unlink_stale_socket(&socket, stale).await.unwrap_err();
        assert!(error.to_string().contains("changed ownership"), "{error}");
        assert!(socket.exists(), "the replacement socket file must survive");
        std::fs::remove_file(&aside).unwrap();
    }

    #[tokio::test]
    async fn unlink_is_a_no_op_when_the_file_is_already_gone() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        unlink_stale_socket(&socket, SocketIdentity { dev: 0, ino: 0 })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cleanup_waits_while_a_rival_startup_holds_the_lock() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        bind_stale_socket(&socket).await;
        // A rival startup worker owns the cleanup lock: a fresh empty
        // `{path}.lock` directory, exactly what LockDir::acquire sees as live.
        let rival_lock = dir.path().join("daemon.sock.lock");
        std::fs::create_dir(&rival_lock).unwrap();
        let socket_arg = socket.clone();
        let mut pending = tokio::spawn(async move { prepare_socket_path(&socket_arg).await });
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut pending)
                .await
                .is_err()
        );
        // The rival releases: the queued cleanup proceeds and frees the lock.
        std::fs::remove_dir(&rival_lock).unwrap();
        pending.await.unwrap().unwrap();
        assert!(!socket.exists(), "stale socket file must be unlinked");
        assert!(
            !rival_lock.exists(),
            "the cleanup lock must be released after use"
        );
    }

    #[test]
    fn cleanup_is_deferred_while_a_rival_holds_the_lock() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let identity = socket_identity(&socket).unwrap();
        let rival_lock = dir.path().join("daemon.sock.lock");
        std::fs::create_dir(&rival_lock).unwrap();
        cleanup_socket_path(&socket, Some(identity.clone()));
        assert!(socket.exists());
        std::fs::remove_dir(&rival_lock).unwrap();
        cleanup_socket_path(&socket, Some(identity));
        assert!(!socket.exists());
        drop(listener);
    }

    #[tokio::test]
    async fn a_stale_cleanup_lock_of_a_crashed_holder_is_reclaimed() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("daemon.sock");
        bind_stale_socket(&socket).await;
        let crashed_lock = dir.path().join("daemon.sock.lock");
        std::fs::create_dir(&crashed_lock).unwrap();
        let six_seconds_ago =
            filetime::FileTime::from_system_time(std::time::SystemTime::now() - LOCK_STALE_AFTER);
        filetime::set_file_mtime(&crashed_lock, six_seconds_ago).unwrap();
        // A lock whose holder crashed (mtime past LOCK_STALE_AFTER) is reclaimed instead of
        // waiting out the full retry budget.
        tokio::time::timeout(Duration::from_secs(2), prepare_socket_path(&socket))
            .await
            .unwrap()
            .unwrap();
        assert!(!socket.exists(), "stale socket file must be unlinked");
    }
}
