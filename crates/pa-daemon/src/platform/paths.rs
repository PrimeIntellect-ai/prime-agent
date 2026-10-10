//! Per-OS daemon endpoint naming: Unix socket files under
//! `<tmpdir>/prime-agent-<uid>/`, with a short `/tmp` fallback on macOS;
//! Windows named pipes in the `\\.\\pipe\\` namespace (fixed daemon pipe,
//! hashed worker pipes).
use std::path::{Path, PathBuf};

use crate::paths::hash_key;

/// Default directory holding daemon socket files, reserving room for workers.
#[cfg(unix)]
pub fn socket_dir() -> PathBuf {
    let uid = pa_core::platform::process::current_user_id();
    let tmp = std::env::var_os("TMPDIR").map_or_else(|| PathBuf::from("/tmp"), PathBuf::from);
    socket_dir_for_tmp(&tmp, uid)
}

/// Reserve room for the longest generated endpoint, not just daemon.sock.
/// Linux re-anchors deep endpoints through directory descriptors. macOS
/// cannot, so use a short per-user directory when TMPDIR would not fit.
#[cfg(unix)]
fn socket_dir_for_tmp(tmp: &Path, uid: u32) -> PathBuf {
    let name = format!("prime-agent-{uid}");
    let directory = tmp.join(&name);
    #[cfg(target_os = "macos")]
    {
        let worker_name_bytes = "worker-".len() + 12 + 1 + 12 + ".sock".len();
        if directory.as_os_str().len() + 1 + worker_name_bytes
            > pa_types::platform::transport::MAX_UNIX_SOCKET_PATH_BYTES
        {
            return Path::new("/tmp").join(name);
        }
    }
    directory
}

/// The socket-dir half of a discovery state root on Windows: TS computes
/// `<tmpdir>/prime-agent-user` so `DaemonStateRoot` keeps one shape.
#[cfg(not(unix))]
#[must_use]
pub fn socket_dir() -> PathBuf {
    std::env::temp_dir().join("prime-agent-user")
}

/// Default supervisor endpoint: `daemon.sock` in the socket dir (Unix) or
/// the fixed daemon pipe name (Windows).
#[cfg(unix)]
#[must_use]
pub fn default_daemon_socket_path() -> PathBuf {
    socket_dir().join("daemon.sock")
}

#[cfg(not(unix))]
#[must_use]
pub fn default_daemon_socket_path() -> PathBuf {
    PathBuf::from(r"\\.\pipe\prime-agent-daemon")
}

/// Worker endpoint in the socket directory: hashed supervisor key plus the
/// worker id prefix (TS `workerSocketPath`).
#[cfg(unix)]
#[must_use]
pub fn worker_socket_path(supervisor_socket_path: &Path, worker_id: &str) -> PathBuf {
    let key = hash_key(&supervisor_socket_path.to_string_lossy(), 12);
    socket_dir().join(format!(
        "worker-{key}-{}.sock",
        &worker_id[..12.min(worker_id.len())]
    ))
}

#[cfg(not(unix))]
#[must_use]
pub fn worker_socket_path(supervisor_socket_path: &Path, worker_id: &str) -> PathBuf {
    let key = hash_key(&supervisor_socket_path.to_string_lossy(), 12);
    PathBuf::from(format!(
        r"\\.\pipe\prime-agent-worker-{key}-{}",
        &worker_id[..12.min(worker_id.len())]
    ))
}

// Socket-filesystem identity is the shared platform contract
// `pa_types::platform::socket_identity`: the same helper serves stale-file
// cleanup here and direct-transport ticket validation in the clients.

pub use pa_types::daemon::SocketIdentity;
pub use pa_types::platform::socket_identity;
#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn default_socket_uses_the_same_real_uid_as_the_typescript_daemon() {
        let output = std::process::Command::new("id")
            .arg("-ru")
            .output()
            .unwrap();
        assert!(output.status.success());
        let uid = String::from_utf8(output.stdout).unwrap();
        assert_eq!(
            socket_dir().file_name().unwrap(),
            std::ffi::OsStr::new(&format!("prime-agent-{}", uid.trim()))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn socket_directory_reserves_space_for_workers_at_the_native_limit() {
        use pa_types::platform::transport::MAX_UNIX_SOCKET_PATH_BYTES;
        let uid = 501;
        let worker_name = "worker-0123456789ab-0123456789ab.sock";
        let user_directory = format!("prime-agent-{uid}");
        let tmp_len = MAX_UNIX_SOCKET_PATH_BYTES - worker_name.len() - user_directory.len() - 2;
        let tmp = PathBuf::from(format!("/{}", "t".repeat(tmp_len - 1)));
        let directory = socket_dir_for_tmp(&tmp, uid);
        assert_eq!(directory, tmp.join(&user_directory));
        assert_eq!(
            directory.join(worker_name).as_os_str().len(),
            MAX_UNIX_SOCKET_PATH_BYTES
        );
        let too_long = PathBuf::from(format!("{}t", tmp.display()));
        assert_eq!(
            socket_dir_for_tmp(&too_long, uid),
            Path::new("/tmp").join(user_directory)
        );
    }

    #[test]
    fn worker_socket_names_are_deterministic() {
        let supervisor = Path::new("/tmp/prime-agent-1/daemon.sock");
        let a = worker_socket_path(supervisor, "0123456789abcdef");
        let b = worker_socket_path(supervisor, "fedcba9876543210");
        assert_ne!(a, b);
        // Only the first 12 id characters key the name.
        assert_eq!(a, worker_socket_path(supervisor, "0123456789abffff"));
        #[cfg(unix)]
        assert!(a.starts_with(socket_dir()));
    }

    /// The Windows endpoint names (TS win32 arms): the fixed daemon pipe
    /// name and the hashed worker pipe name in the `\\.\\pipe\\` namespace.
    #[test]
    #[cfg(windows)]
    fn windows_endpoints_are_the_ts_pipe_names() {
        assert_eq!(
            default_daemon_socket_path(),
            PathBuf::from(r"\\.\pipe\prime-agent-daemon")
        );
        let supervisor = Path::new(r"\\.\pipe\prime-agent-daemon");
        let a = worker_socket_path(supervisor, "0123456789abcdef");
        let rendered = a.to_string_lossy();
        assert!(
            rendered.starts_with(r"\\.\pipe\prime-agent-worker-"),
            "the worker pipe namespace: {rendered}"
        );
        assert!(
            rendered.ends_with("-0123456789ab"),
            "the 12-char id suffix: {rendered}"
        );
    }
}
