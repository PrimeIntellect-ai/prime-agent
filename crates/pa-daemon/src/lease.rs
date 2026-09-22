//! Session leases (port of core/session-lease.ts).
//!
//! One process may host one runtime per canonical session file. A lease is a
//! directory `<agent-dir>/session-leases/<sha256(path)>.lock` containing
//! `owner.json`; acquisition is an atomic rename of a candidate directory, and
//! stale owners (dead pid, or a recycled pid whose start identity changed) are
//! reclaimed. A separate guard lock serializes lease updates.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const SESSION_LEASES_ENABLED_ENV: &str = "PRIME_AGENT_INTERNAL_SESSION_LEASES";
pub const SESSION_LEASE_OWNER_ID_ENV: &str = "PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseOwner {
    version: u32,
    token: String,
    pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    process_start_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active_session_id: Option<String>,
    session_path: String,
    created_at: String,
}

/// Error matching the TS wire shape (`session_already_active`).
#[derive(Debug, thiserror::Error)]
#[error("Session is already active in {owner}: {session_path}")]
pub struct SessionAlreadyActiveError {
    pub session_path: String,
    pub active_session_id: Option<String>,
    pub owner: String,
}

impl SessionAlreadyActiveError {
    fn for_owner(session_path: &str, owner: Option<&LeaseOwner>) -> Self {
        SessionAlreadyActiveError {
            session_path: session_path.to_string(),
            active_session_id: owner
                .and_then(|o| o.active_session_id.clone())
                .filter(|id| !id.is_empty()),
            owner: owner
                .and_then(|o| o.active_session_id.clone())
                .unwrap_or_else(|| "another process".to_string()),
        }
    }
}

pub fn canonical_session_path(path: &Path) -> PathBuf {
    match path.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => match path.parent().map(|parent| parent.canonicalize()) {
            Some(Ok(parent)) => parent.join(path.file_name().unwrap_or_default()),
            _ => path.to_path_buf(),
        },
    }
}

/// `proc:<starttime>` start identity (TS `getProcessStartId`); shared with
/// pa-core through `pa_types::platform`.
pub fn get_process_start_id(pid: u32) -> Option<String> {
    pa_types::platform::process::process_start_id(pid)
}

/// True only for a process that is actually running: zombies do not count.
/// Errors when the platform cannot answer (the caller treats an unverifiable
/// owner as alive rather than reclaiming its lease).
pub fn is_process_alive(pid: u32) -> anyhow::Result<bool> {
    pa_types::platform::process::is_process_alive(pid)
}

fn lease_directory(agent_dir: &Path, session_path: &Path) -> PathBuf {
    let canonical = canonical_session_path(session_path);
    let key = Sha256::digest(canonical.to_string_lossy().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    agent_dir.join("session-leases").join(format!("{key}.lock"))
}

fn leases_enabled() -> bool {
    matches!(
        std::env::var(SESSION_LEASES_ENABLED_ENV).as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

fn read_owner(directory: &Path) -> Result<Option<LeaseOwner>> {
    let owner_path = directory.join("owner.json");
    let content = match fs::read_to_string(&owner_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let owner: LeaseOwner = serde_json::from_str(&content).map_err(|e| {
        anyhow!(
            "Corrupt session lease owner file: {} - {e}",
            owner_path.display()
        )
    })?;
    Ok(Some(owner))
}

fn owner_alive(owner: &LeaseOwner) -> bool {
    match is_process_alive(owner.pid) {
        Ok(true) => {}
        // A provably-dead owner is stale; an unverifiable one counts as
        // alive, like the TS lease (reclaiming a live owner is worse).
        Ok(false) => return false,
        Err(_) => return true,
    }
    match owner.process_start_id.as_deref() {
        None => true,
        Some(expected) => match get_process_start_id(owner.pid) {
            Some(current) => current == expected,
            // Unobservable identity counts as alive, like the TS lease.
            None => true,
        },
    }
}

/// Whether a failed candidate-onto-lease-directory rename means the lease
/// directory already exists (TS `isRenameTargetContention`).
///
/// POSIX: renaming onto an existing directory raises EEXIST/ENOTEMPTY.
/// Windows: the same race surfaces as EPERM/EACCES instead, so those count
/// as contention only when the target actually exists - a real permission
/// problem must still propagate. EBUSY (a destination held open by
/// antivirus/indexer) is never contention: TS leaves it out.
fn is_rename_target_contention(
    directory: &Path,
    error: &std::io::Error,
    platform_windows: bool,
) -> bool {
    match error.kind() {
        std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::DirectoryNotEmpty => true,
        std::io::ErrorKind::PermissionDenied => {
            platform_windows && directory.try_exists().unwrap_or(false)
        }
        _ => false,
    }
}

/// Total attempts before a transient stale-reclaim rename failure surfaces
/// (TS `reclaimStaleLease` caps at 8 with a `10ms * attempt` backoff).
const WIN32_RECLAIM_ATTEMPTS: u32 = 8;

/// Whether a failed stale-reclaim rename deserves another attempt on the
/// given platform, and how long to wait first (`10ms * attempt`). `None`
/// means the failure surfaces. Attempts are 1-based; only the win32
/// destination-busy family (EPERM/EACCES via `PermissionDenied`, EBUSY via
/// raw `ERROR_SHARING_VIOLATION`/`ERROR_LOCK_VIOLATION`) retries.
fn reclaim_retry_delay_ms(
    platform_windows: bool,
    error: &std::io::Error,
    attempt: u32,
) -> Option<u64> {
    if !platform_windows || attempt >= WIN32_RECLAIM_ATTEMPTS {
        return None;
    }
    let transient = error.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(32) | Some(33));
    transient.then(|| 10 * u64::from(attempt))
}

fn reclaim_stale(directory: &Path) -> bool {
    let stale = directory.with_extension(format!(
        "lock.stale-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let platform_windows = cfg!(windows);
    let mut attempt = 1;
    loop {
        match fs::rename(directory, &stale) {
            Ok(()) => {
                let _ = fs::remove_dir_all(&stale);
                return true;
            }
            // The lease path is already free: nothing to reclaim.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(error) => match reclaim_retry_delay_ms(platform_windows, &error, attempt) {
                Some(delay) => {
                    std::thread::sleep(Duration::from_millis(delay));
                    attempt += 1;
                }
                None => return false,
            },
        }
    }
}

/// Serialize lease-directory mutations with a guard directory lock.
fn with_lease_guard<T>(directory: &Path, action: impl FnOnce() -> Result<T>) -> Result<T> {
    let guard = PathBuf::from(format!("{}.guard", directory.display()));
    let mut acquired = false;
    for attempt in 0..100u32 {
        match fs::create_dir(&guard) {
            Ok(()) => {
                acquired = true;
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // Stale guard: a holder that died without cleanup.
                if crate::paths::mtime_age(&guard).is_some_and(|age| age > Duration::from_secs(5)) {
                    let _ = fs::remove_dir_all(&guard);
                    continue;
                }
                std::thread::sleep(Duration::from_millis(10 + (attempt % 5) as u64));
            }
            Err(error) => return Err(error.into()),
        }
    }
    if !acquired {
        return Err(anyhow!(
            "Could not coordinate session lease: {}",
            directory.display()
        ));
    }
    let result = action();
    let _ = fs::remove_dir_all(&guard);
    result
}

/// A held session lease; release removes the directory when still owned.
#[derive(Debug)]
pub struct SessionLease {
    pub session_path: PathBuf,
    directory: PathBuf,
    token: String,
    released: std::sync::atomic::AtomicBool,
}

impl SessionLease {
    pub fn release(&self) {
        if self
            .released
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let _ = with_lease_guard(&self.directory, || {
            if let Ok(Some(owner)) = read_owner(&self.directory) {
                if owner.token == self.token {
                    reclaim_stale(&self.directory);
                }
            }
            Ok(())
        });
    }
}

/// Acquire the lease for one session file. Returns `None` when leases are
/// disabled (default) or `session_path` is empty.
pub fn acquire_session_lease(
    session_path: Option<&Path>,
    agent_dir: &Path,
) -> Result<Option<SessionLease>> {
    let Some(session_path) = session_path.filter(|p| !p.as_os_str().is_empty()) else {
        return Ok(None);
    };
    if !leases_enabled() {
        return Ok(None);
    }
    let canonical = canonical_session_path(session_path);
    let root = agent_dir.join("session-leases");
    fs::create_dir_all(&root)?;
    let directory = lease_directory(agent_dir, &canonical);

    with_lease_guard(&directory, || {
        for _ in 0..3 {
            let token = uuid::Uuid::new_v4().to_string();
            let candidate = directory.with_extension(format!(
                "lock.candidate-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&candidate)?;
            let owner = LeaseOwner {
                version: 1,
                token: token.clone(),
                pid: std::process::id(),
                process_start_id: get_process_start_id(std::process::id()),
                active_session_id: std::env::var(SESSION_LEASE_OWNER_ID_ENV).ok(),
                session_path: canonical.to_string_lossy().to_string(),
                created_at: crate::util::now_iso(),
            };
            let owner_path = candidate.join("owner.json");
            fs::write(&owner_path, serde_json::to_string_pretty(&owner)? + "\n")?;
            match fs::rename(&candidate, &directory) {
                Ok(()) => {
                    return Ok(Some(SessionLease {
                        session_path: canonical.clone(),
                        directory: directory.clone(),
                        token,
                        released: std::sync::atomic::AtomicBool::new(false),
                    }));
                }
                Err(error) => {
                    let _ = fs::remove_dir_all(&candidate);
                    if error.kind() == std::io::ErrorKind::NotFound {
                        continue;
                    }
                    if is_rename_target_contention(&directory, &error, cfg!(windows)) {
                        match read_owner(&directory)? {
                            Some(existing) if owner_alive(&existing) => {
                                return Err(SessionAlreadyActiveError::for_owner(
                                    &canonical.to_string_lossy(),
                                    Some(&existing),
                                )
                                .into());
                            }
                            _ => {
                                reclaim_stale(&directory);
                                continue;
                            }
                        }
                    }
                    return Err(error.into());
                }
            }
        }
        match read_owner(&directory)? {
            Some(owner) if owner_alive(&owner) => Err(SessionAlreadyActiveError::for_owner(
                &canonical.to_string_lossy(),
                Some(&owner),
            )
            .into()),
            _ => Err(anyhow!(
                "Could not acquire session lease: {}",
                canonical.display()
            )),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_start_id_reflects_proc() {
        let start = get_process_start_id(std::process::id());
        assert!(start.is_some());
        assert!(start.unwrap().starts_with("proc:"));
        assert!(get_process_start_id(0).is_none());
    }

    #[test]
    fn lease_conflicts_and_releases() {
        let dir = std::env::temp_dir().join(format!("pa-lease-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var(SESSION_LEASES_ENABLED_ENV, "1");
        let session = dir.join("s.jsonl");
        std::fs::write(&session, "{}").unwrap();
        let lease = acquire_session_lease(Some(&session), &dir)
            .unwrap()
            .unwrap();
        // Second holder conflicts.
        let err = acquire_session_lease(Some(&session), &dir).unwrap_err();
        assert!(err.to_string().contains("already active"));
        lease.release();
        // Released lease can be acquired again.
        let second = acquire_session_lease(Some(&session), &dir)
            .unwrap()
            .unwrap();
        second.release();
        std::env::remove_var(SESSION_LEASES_ENABLED_ENV);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_target_contention_covers_exist_and_not_empty() {
        // TS: EEXIST and ENOTEMPTY are contention on every platform.
        for kind in [
            std::io::ErrorKind::AlreadyExists,
            std::io::ErrorKind::DirectoryNotEmpty,
        ] {
            let error = std::io::Error::from(kind);
            assert!(is_rename_target_contention(
                Path::new("/tmp"),
                &error,
                false
            ));
            assert!(is_rename_target_contention(Path::new("/tmp"), &error, true));
        }
    }

    #[test]
    fn rename_target_contention_denied_only_when_win32_target_exists() {
        // TS: EPERM/EACCES count as contention on win32 when - and only
        // when - the lease directory actually exists.
        let dir = std::env::temp_dir().join(format!("pa-lease-c-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(is_rename_target_contention(&dir, &denied, true));
        assert!(!is_rename_target_contention(&dir, &denied, false));
        let missing = dir.join("missing");
        assert!(!is_rename_target_contention(&missing, &denied, true));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_target_contention_ignores_unrelated_failures() {
        // TS: EBUSY and other codes are never contention (a shared-open
        // destination must surface, not read as a conflict).
        for error in [
            std::io::Error::from(std::io::ErrorKind::Other),
            // ERROR_SHARING_VIOLATION stays raw in std (libuv EBUSY).
            std::io::Error::from_raw_os_error(32),
        ] {
            assert!(!is_rename_target_contention(
                Path::new("/tmp"),
                &error,
                true
            ));
        }
    }

    #[test]
    fn reclaim_retry_is_win32_only_with_linear_backoff_until_cap() {
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let busy = std::io::Error::from_raw_os_error(33);
        for error in [&denied, &busy] {
            for attempt in 1..WIN32_RECLAIM_ATTEMPTS {
                assert_eq!(
                    reclaim_retry_delay_ms(true, error, attempt),
                    Some(10 * u64::from(attempt)),
                    "attempt={attempt}"
                );
            }
            assert_eq!(
                reclaim_retry_delay_ms(true, error, WIN32_RECLAIM_ATTEMPTS),
                None
            );
            assert_eq!(
                reclaim_retry_delay_ms(true, error, WIN32_RECLAIM_ATTEMPTS + 3),
                None
            );
            assert_eq!(reclaim_retry_delay_ms(false, error, 1), None);
        }
        let unrelated = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(reclaim_retry_delay_ms(true, &unrelated, 1), None);
    }
}
