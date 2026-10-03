//! Daemon socket lifecycle (port of daemon-socket.ts).
//!
//! Endpoint naming and identity live in [`crate::platform`]; the bind/connect
//! calls go through the shared transport traits in `pa_types::platform`, so
//! Unix socket files today and named pipes later differ only in the
//! implementation module.

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

/// Staleness after which the cleanup lock of a crashed holder is reclaimed
/// (TS `DAEMON_SOCKET_LOCK_STALE_MS`). Unix only: every taker of the
/// cleanup lock sits behind the unix stale-file wall.
#[cfg(unix)]
const LOCK_STALE_AFTER: Duration = Duration::from_secs(5);
/// Live-lock retry cadence (TS `DAEMON_SOCKET_RELEASE_POLL_MS`) and cap
/// (TS `acquireDaemonSocketPathLease`'s 600 retries): ~15s total.
#[cfg(unix)]
const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(unix)]
const LOCK_RETRIES: u32 = 600;

/// Acquire the cross-process cleanup lock (TS `acquireDaemonSocketPathLease`):
/// proper-lockfile's empty `{path}.lock` directory. Holding it for the whole
/// probe/unlink sequence is what closes the unlink's check-then-act window -
/// a competing startup worker must queue here, so it cannot pass its own
/// stale probe and bind a live listener between this process's identity
/// check and its unlink.
#[cfg(unix)]
async fn acquire_cleanup_lock(path: &Path) -> Result<pa_core::platform::LockDir> {
    for attempt in 0..=LOCK_RETRIES {
        match pa_core::platform::LockDir::acquire(path, LOCK_STALE_AFTER) {
            Ok(lock) => return Ok(lock),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(anyhow!("Daemon socket cleanup lock: {error}")),
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
    /// Returns an error if the directory cannot be created or locked.
    pub async fn acquire(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            crate::paths::ensure_dir(parent)?;
        }
        let lock = acquire_cleanup_lock(path).await?;
        let lock_path = lock.into_path();
        // If the open fails, ownership is unprovable; leave the artifact to
        // expire instead of risking removal of a racing successor's lock.
        let lock_dir = std::fs::File::open(&lock_path)?;
        let identity = metadata_identity(&lock_dir.metadata()?);
        let compromised = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (compromise_tx, _) = tokio::sync::watch::channel(false);
        let task_path = lock_path.clone();
        let task_dir = lock_dir.try_clone()?;
        let task_identity = identity.clone();
        let task_compromised = std::sync::Arc::clone(&compromised);
        let task_tx = compromise_tx.clone();
        let (refresh_stop, stop_rx) = std::sync::mpsc::channel();
        let refresh = std::thread::spawn(move || {
            while stop_rx.recv_timeout(Duration::from_secs(1)).is_err() {
                if !lock_identity_matches(&task_path, &task_identity)
                    || task_dir.set_modified(std::time::SystemTime::now()).is_err()
                    || !lock_identity_matches(&task_path, &task_identity)
                {
                    task_compromised.store(true, std::sync::atomic::Ordering::Release);
                    task_tx.send_replace(true);
                    break;
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

    /// Whether ownership of this exact lock inode was lost.
    #[must_use]
    pub fn compromised(&self) -> bool {
        self.compromised.load(std::sync::atomic::Ordering::Acquire)
            || !lock_identity_matches(&self.lock_path, &self.identity)
    }

    /// Resolve when this lease loses its lock directory.
    pub async fn wait_compromised(&self) {
        let mut changes = self.compromise_tx.subscribe();
        while !self.compromised() {
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
        if self.compromised() {
            return Err(anyhow!(
                "Daemon socket lease for {} was compromised",
                path.display()
            ));
        }
        Ok(())
    }

    /// Best-effort unlink of only the bound socket owned by this holder.
    /// On compromise, leave the successor's socket untouched.
    pub fn cleanup_socket_path(&self, path: &Path, expected: Option<SocketIdentity>) {
        if self.assert_path_held(path).is_err() {
            return;
        }
        let Some(expected) = expected else { return };
        if socket_identity(path) == Some(expected) && self.assert_path_held(path).is_ok() {
            let _ = std::fs::remove_file(path);
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
        // A successor that reclaimed a stale lock must never be released by us.
        if !self.compromised() {
            let _ = std::fs::remove_dir(&self.lock_path);
        }
        let _ = &self.lock_dir;
    }
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
///
/// Unix only: a stale socket file blocks `bind`. Named-pipe endpoints
/// (Windows) have no filesystem residue - the first listener creates the
/// pipe - so preparing the path is a no-op there (the TS `prepareDaemonSocketPath`
/// returns early on win32 for the same reason).
///
/// # Errors
///
/// Returns an error when the parent directory cannot be created, the
/// socket path cannot be stat'ed, a live listener already answers on the
/// socket (in use), the cross-process cleanup lock cannot be acquired,
/// or the locked cleanup itself fails.
#[cfg(unix)]
pub async fn prepare_socket_path(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        crate::paths::ensure_dir(parent)?;
    }
    // lstat, not `Path::exists()`: a dangling symlink still blocks `bind`
    // while `exists()` - which follows links - denies it, and it must reach
    // the probe to fail with the non-socket diagnostic.
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(anyhow!("Daemon socket path stat failed: {error}")),
        Ok(_) => {}
    }
    // Quick refusal before taking the cross-process lock (TS
    // `prepareDaemonSocketPath` checks a live listener first, so a second
    // daemon fails fast instead of queueing behind the first).
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

/// Probe + grace wait + unlink for a probed-stale socket file (TS
/// `prepareUnixDaemonSocketPath`); the caller owns the cleanup lock.
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

/// Final gate before unlinking a probed-stale socket file: refuse while a
/// live listener answers, and remove only the exact inode that was probed
/// stale - a file replaced between the probe and the unlink stays untouched.
/// The caller holds the cleanup lock, so competing startup workers are
/// serialized out of this check-then-act window; the identity gate covers
/// processes that do not take the lock (non-pa-daemon), like the TS gate
/// behind proper-lockfile's lease. Unix only: named-pipe endpoints leave
/// no socket file to unlink, so the whole path stays unix.
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

/// Windows arm of [`prepare_socket_path`]: named-pipe endpoints have
/// no filesystem residue (the first listener creates the pipe), so
/// preparing the path is a no-op (the TS `prepareDaemonSocketPath`
/// returns early on win32 for the same reason).
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
/// incarnation. No-op for named pipes (no file to clean up).
///
/// The remove runs under the cleanup lock's best-effort twin (TS
/// `cleanupDaemonSocketPath` takes proper-lockfile's sync lock with zero
/// retries): contention means another daemon owns the socket path, so its
/// cleanup - not ours - covers the identity gate's check-then-act window.
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

/// Restrict the bound socket file to its owner (Unix mode 0o600; Windows
/// named pipes use ACLs on the pipe object instead).
pub fn restrict_socket_path(path: &Path) {
    let _ = pa_core::platform::perms::restrict_file(path);
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
        lease.cleanup_socket_path(&socket, socket_identity(&socket));
        assert!(!socket.exists());
        drop(listener);
        drop(lease);
        assert!(!pa_core::platform::LockDir::path_for(&socket).exists());
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
        // The dangling link itself survives the refusal.
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
        // The live socket file survives untouched and still accepts.
        assert!(socket.exists());
        assert!(can_connect(&socket, Duration::from_millis(250)).await);
        drop(listener);
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
        // Move the probed file aside instead of unlinking it: its inode
        // stays allocated, so the replacement bound at the path is
        // guaranteed a different inode. A descriptor cannot pin a socket
        // (open() fails with ENXIO) and a freed inode can be handed
        // straight back to the replacement, which the gate cannot see.
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
        // `{path}.lock` directory, exactly what LockDir::acquire sees as a
        // live proper-lockfile lock.
        let rival_lock = dir.path().join("daemon.sock.lock");
        std::fs::create_dir(&rival_lock).unwrap();
        let socket_arg = socket.clone();
        let mut pending = tokio::spawn(async move { prepare_socket_path(&socket_arg).await });
        // The cleanup must not unlink while the rival holds the lock.
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
        // A rival's live lock skips the cleanup: the socket file survives.
        cleanup_socket_path(&socket, Some(identity.clone()));
        assert!(socket.exists());
        // Once the rival releases, the same cleanup removes the socket.
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
        // A lock whose holder crashed (mtime past LOCK_STALE_AFTER) is
        // reclaimed instead of waiting out the full retry budget.
        tokio::time::timeout(Duration::from_secs(2), prepare_socket_path(&socket))
            .await
            .unwrap()
            .unwrap();
        assert!(!socket.exists(), "stale socket file must be unlinked");
    }
}
