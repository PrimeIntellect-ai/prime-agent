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

/// Remove a stale socket file after verifying nothing is listening.
///
/// Unix only: a stale socket file blocks `bind`. Named-pipe endpoints
/// (Windows) have no filesystem residue - the first listener creates the
/// pipe - so preparing the path is a no-op there (the TS `prepareDaemonSocketPath`
/// returns early on win32 for the same reason).
#[cfg(unix)]
pub async fn prepare_socket_path(path: &Path) -> Result<()> {
    use std::os::unix::fs::FileTypeExt;
    if let Some(parent) = path.parent() {
        crate::paths::ensure_dir(parent)?;
    }
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
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1000);
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
    std::fs::remove_file(path)?;
    Ok(())
}

#[cfg(not(unix))]
pub async fn prepare_socket_path(_path: &Path) -> Result<()> {
    Ok(())
}

/// Remove the socket file when it still belongs to this supervisor
/// incarnation. No-op for named pipes (no file to clean up).
pub fn cleanup_socket_path(path: &Path, expected_identity: Option<SocketIdentity>) {
    if !path.exists() {
        return;
    }
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
