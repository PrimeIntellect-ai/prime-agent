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
    prepare_locked_socket_path(path).await
}

/// Probe + grace wait + unlink for a probed-stale socket file (TS
/// `prepareUnixDaemonSocketPath`); the caller owns the cleanup lock.
#[cfg(unix)]
async fn prepare_locked_socket_path(path: &Path) -> Result<()> {
    use std::os::unix::fs::FileTypeExt;
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return Ok(());
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
    unlink_stale_socket(path, stale_identity).await
}

/// Final gate before unlinking a probed-stale socket file: refuse while a
/// live listener answers, and remove only the exact inode that was probed
/// stale - a file replaced between the probe and the unlink stays untouched.
/// The caller holds the cleanup lock, so competing startup workers are
/// serialized out of this check-then-act window; the identity gate covers
/// processes that do not take the lock (non-pa-daemon), like the TS gate
/// behind proper-lockfile's lease. Unix only: named-pipe endpoints leave
/// no socket file to unlink, so the whole path stays unix.
#[cfg(unix)]
async fn unlink_stale_socket(path: &Path, expected: SocketIdentity) -> Result<()> {
    if can_connect(path, Duration::from_millis(250)).await {
        return Err(anyhow!("Daemon socket already in use: {}", path.display()));
    }
    match socket_identity(path) {
        None => Ok(()),
        Some(current) if current == expected => {
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

/// The exit cleanup after the owner's own listener is closed (the TS
/// graceful-shutdown sequence closes before cleanup). A successor's live
/// listener must survive even when a poisoned bind-time identity capture
/// names the successor's inode. A nonblocking connect can distinguish a
/// definitely closed listener (`ECONNREFUSED`) from a saturated backlog
/// (`EAGAIN` on Linux); unknown outcomes preserve the socket path. Only
/// after definite refusal may the existing cleanup lock and identity gate
/// unlink the stale, still-ours socket. TS cleanup checks identity alone,
/// so the poisoned-capture case remains a disclosed TS difference.
#[cfg(unix)]
pub fn cleanup_socket_path_after_close(path: &Path, expected_identity: Option<SocketIdentity>) {
    if !path.exists() || !pa_types::platform::transport::unix_listener_definitely_closed(path) {
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

    /// Dropping the bound listener is the graceful close the exit
    /// cleanups run before their unlink (the TS `server.close` step,
    /// daemon-mode.ts:8011-8018): the bind releases (a fresh connect is
    /// refused) while the socket FILE survives (the close never
    /// unlinks), an in-flight accepted stream keeps serving across the
    /// close, and the listener's own fd is closed while the in-flight
    /// stream's fd stays open - no fd is leaked on the bound socket
    /// across the exit sequence.
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
        drop(listener);
        assert!(
            !fd_exists(listener_fd),
            "the listener's fd closed at the drop: no fd leaked on the bound socket"
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
        // The same matching identity now describes a dead file: the
        // probe passes it through and the gate unlinks it.
        cleanup_socket_path_after_close(&socket, Some(poisoned));
        assert!(!socket.exists(), "the dead still-ours file is unlinked");
        std::fs::remove_file(&aside).unwrap();
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
