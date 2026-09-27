//! Filesystem layout: agent dir, sessions dir, logs, worker descriptors.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};

pub const AGENT_DIR_ENV: &str = "PRIME_AGENT_CODING_AGENT_DIR";
pub const SESSION_DIR_ENV: &str = "PRIME_AGENT_SESSION_DIR";
pub const CONFIG_DIR_NAME: &str = ".prime/agent";

/// The home directory for state layout. Unresolvable home is an explicit
/// error, not a degraded `/tmp` default: the daemon owns durable state and
/// must refuse to start rather than write it outside the user profile
/// (TS `getAgentDir` throws when `os.homedir()` fails).
///
/// # Errors
///
/// Returns an error when the home directory cannot be resolved from the
/// supported environment variables.
pub fn home_dir() -> Result<PathBuf> {
    pa_types::platform::home_dir()
        .ok_or_else(|| anyhow!("home directory not found: set HOME (or USERPROFILE on Windows)"))
}

/// Expand a leading `~`/`~/` against [`home_dir`]; other paths pass through.
///
/// # Errors
///
/// Returns an error when expanding `~`/`~/` needs the home directory and
/// [`home_dir`] cannot resolve it; every other path passes through
/// unchanged.
pub fn expand_tilde(path: &str) -> Result<PathBuf> {
    if let Some(rest) = path.strip_prefix("~/") {
        Ok(home_dir()?.join(rest))
    } else if path == "~" {
        home_dir()
    } else {
        Ok(PathBuf::from(path))
    }
}

/// The agent state root: the `PRIME_AGENT_CODING_AGENT_DIR` override
/// when set (tilde expanded), else `.prime/agent` under the home
/// directory.
///
/// # Errors
///
/// Returns an error when the override cannot be tilde-expanded, or when the
/// fallback needs the home directory and [`home_dir`] cannot resolve it.
pub fn agent_dir() -> Result<PathBuf> {
    match std::env::var_os(AGENT_DIR_ENV) {
        Some(dir) if !dir.is_empty() => expand_tilde(&dir.to_string_lossy()),
        _ => Ok(home_dir()?.join(CONFIG_DIR_NAME)),
    }
}

/// The sessions root: the `PRIME_AGENT_SESSION_DIR` override when set
/// (tilde expanded), else `<agent-dir>/sessions`.
///
/// # Errors
///
/// Returns an error when the override cannot be tilde-expanded.
pub fn sessions_dir(agent_dir: &Path) -> Result<PathBuf> {
    match std::env::var_os(SESSION_DIR_ENV) {
        Some(dir) if !dir.is_empty() => expand_tilde(&dir.to_string_lossy()),
        _ => Ok(agent_dir.join("sessions")),
    }
}

pub fn logs_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join("logs")
}

/// Create the directory (and any missing parents), then restrict its
/// permissions to the current user.
///
/// # Errors
///
/// Returns an error when directory creation fails; the permission
/// restriction is best effort and never fails the call.
pub fn ensure_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    let _ = pa_core::platform::perms::restrict_dir(path);
    Ok(())
}

/// sha256 hex, first `chars` characters.
pub fn hash_key(input: &str, chars: usize) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().fold(String::new(), |mut key, b| {
        use std::fmt::Write;
        write!(key, "{b:02x}").expect("write to String");
        key
    })[..chars]
        .to_string()
}

/// Log path for a daemon socket (port of `getDaemonLogPath`): readable basename
/// plus an 8-char hash of the normalized socket path.
pub fn daemon_log_path(socket_path: &Path, agent_dir: &Path) -> PathBuf {
    let normalized = socket_path.to_string_lossy().to_string();
    let base = socket_path.file_name().map_or_else(
        || "daemon.sock".to_string(),
        |n| n.to_string_lossy().to_string(),
    );
    logs_dir(agent_dir).join(format!("{base}.{}.log", hash_key(&normalized, 8)))
}

/// Rotating log appender: keep the file bounded with one generation rotation
/// (port of `appendRotatingLog`).
pub struct RotatingLog {
    path: PathBuf,
    max_bytes: u64,
}

impl RotatingLog {
    pub fn new(path: PathBuf) -> Self {
        RotatingLog {
            path,
            max_bytes: 5 * 1024 * 1024,
        }
    }

    pub fn append(&self, line: &str) {
        // The log lives in `<agent-dir>/logs`; create it if this is the first
        // write (a fresh agent dir has no logs directory yet).
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        else {
            return;
        };
        let payload = format!("{line}\n");
        if let Ok(metadata) = file.metadata() {
            if metadata.len() + payload.len() as u64 > self.max_bytes {
                drop(file);
                let rotated = self.path.with_extension("log.1");
                let _ = std::fs::rename(&self.path, &rotated);
                match std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)
                {
                    Ok(reopened) => file = reopened,
                    Err(_) => return,
                }
            }
        }
        let _ = file.write_all(payload.as_bytes());
    }
}

use std::io::Write as _;

/// Age of a file's mtime, for stale-lease detection.
pub fn mtime_age(path: &Path) -> Option<Duration> {
    let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    SystemTime::now().duration_since(modified).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_path_hashes_socket() {
        let path = daemon_log_path(
            Path::new("/tmp/prime-agent-1/daemon.sock"),
            Path::new("/ad"),
        );
        assert!(path.starts_with("/ad/logs"));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("daemon.sock."));
        let other = daemon_log_path(
            Path::new("/tmp/prime-agent-2/daemon.sock"),
            Path::new("/ad"),
        );
        assert_ne!(path, other);
    }
}
