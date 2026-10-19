//! Cross-process bootstrap lock for the kernel venv: a `link(2)`-published
//! lock file whose owner is a live pid; stale locks are renamed aside,
//! verified, then reclaimed.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::venv::{
    BOOTSTRAP_LOCK_NAME, BOOTSTRAP_LOCK_RETRY_MS, BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS,
};

// A PID-only lock cannot distinguish its original owner from an unrelated
// process that later receives the same PID. Never evict a possibly live
// bootstrap: bound the caller's wait instead, including for legacy locks.
const BOOTSTRAP_LOCK_WAIT: Duration = Duration::from_secs(120);

fn is_process_alive(pid: u32) -> bool {
    crate::platform::process::pid_exists(pid)
}

/// A `link(2)`-published lock file: born with owner content, EEXIST the only
/// collision signal.
pub(crate) enum DirLockAttempt {
    Acquired,
    Held,
    Reclaimed,
}

fn strict_pid(raw: Option<&str>) -> Option<u32> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let parsed: u32 = trimmed.parse().ok()?;
    (parsed > 0).then_some(parsed)
}

fn try_acquire_dir_lock(lock_path: &Path) -> anyhow::Result<DirLockAttempt> {
    std::fs::create_dir_all(lock_path.parent().unwrap_or(Path::new("/")))?;
    let token = format!("{}-{}", std::process::id(), uuid::Uuid::new_v4());
    let temp_path = lock_path.with_file_name(format!(
        "{}.candidate-{}",
        lock_path.file_name().unwrap_or_default().to_string_lossy(),
        token
    ));
    {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        crate::platform::perms::set_private_mode(&mut options);
        let mut file = options.open(&temp_path)?;
        writeln!(file, "{}", std::process::id())?;
    }
    // The primary signal: link() publishing the candidate under the lock path.
    if std::fs::hard_link(&temp_path, lock_path).is_ok() {
        let _ = std::fs::remove_file(&temp_path);
        return Ok(DirLockAttempt::Acquired);
    }
    // Judge the incumbent: dead owner (or no owner readable) means stale.
    let judge = match std::fs::read_to_string(lock_path) {
        Ok(raw) => strict_pid(Some(&raw)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let _ = std::fs::remove_file(&temp_path);
            return Ok(DirLockAttempt::Reclaimed);
        }
        Err(error) if error.kind() == std::io::ErrorKind::IsADirectory => {
            // Legacy directory lock from the old protocol.
            let pid_file = lock_path.join("pid");
            match std::fs::read_to_string(pid_file) {
                Ok(raw) => strict_pid(Some(&raw)),
                Err(_) => None,
            }
        }
        Err(_) => None,
    };
    let stale = match judge {
        None => lock_missing_pid_is_stale(lock_path),
        Some(pid) => !is_process_alive(pid),
    };
    let result = if stale {
        let aside_path = lock_path.with_file_name(format!(
            "{}.stale-{}",
            lock_path.file_name().unwrap_or_default().to_string_lossy(),
            token
        ));
        match std::fs::rename(lock_path, &aside_path) {
            Ok(()) => {
                if std::fs::remove_file(&aside_path).is_ok() {
                    DirLockAttempt::Reclaimed
                } else {
                    DirLockAttempt::Held
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => DirLockAttempt::Reclaimed,
            Err(_) => DirLockAttempt::Held,
        }
    } else {
        DirLockAttempt::Held
    };
    let _ = std::fs::remove_file(&temp_path);
    Ok(result)
}

fn lock_missing_pid_is_stale(lock_path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(lock_path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    std::time::SystemTime::now()
        .duration_since(modified)
        .is_ok_and(|age| age.as_millis() as u64 > BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS)
}

/// Whether the bootstrap lock could not be created because the venv's directory
/// denies writes to this user (`EACCES`/`EROFS` on the lock candidate).
pub(crate) fn lock_creation_denied(error: &anyhow::Error) -> bool {
    error
        .root_cause()
        .downcast_ref::<std::io::Error>()
        .is_some_and(|io_error| {
            matches!(
                io_error.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem
            )
        })
}

/// Serialize concurrent bootstraps across processes on the same venv.
pub(crate) async fn acquire_bootstrap_lock(venv: &Path) -> anyhow::Result<impl Drop> {
    let lock_dir = venv.with_file_name(format!(
        "{}{}",
        venv.file_name().unwrap_or_default().to_string_lossy(),
        BOOTSTRAP_LOCK_NAME
    ));
    std::fs::create_dir_all(lock_dir.parent().unwrap_or(Path::new("/")))?;
    let deadline = tokio::time::Instant::now() + BOOTSTRAP_LOCK_WAIT;
    loop {
        match try_acquire_dir_lock(&lock_dir)? {
            DirLockAttempt::Acquired => {
                struct Guard(PathBuf);
                impl Drop for Guard {
                    fn drop(&mut self) {
                        let _ = std::fs::remove_file(&self.0);
                    }
                }
                return Ok(Guard(lock_dir));
            }
            DirLockAttempt::Held | DirLockAttempt::Reclaimed => {
                if tokio::time::Instant::now() >= deadline {
                    anyhow::bail!(
                        "Timed out after {} seconds waiting for the Python kernel bootstrap lock at {}. \
                         Another Prime Agent process may still be setting up this runtime. \
                         Retry after it finishes. If setup was interrupted, verify that no process \
                         is setting up this runtime before removing this lock and retrying.",
                        BOOTSTRAP_LOCK_WAIT.as_secs(),
                        lock_dir.display()
                    );
                }
                tokio::time::sleep_until(deadline.min(
                    tokio::time::Instant::now() + Duration::from_millis(BOOTSTRAP_LOCK_RETRY_MS),
                ))
                .await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn live_pid_file_has_a_bounded_wait_without_removing_the_owner() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        let lock = root.path().join("kernel-venv.bootstrap.lock");
        // An unrelated live PID is indistinguishable from a recycled owner.
        let owner = format!("{}\n", std::process::id());
        std::fs::write(&lock, &owner).unwrap();

        let result = tokio::time::timeout(
            BOOTSTRAP_LOCK_WAIT + Duration::from_secs(1),
            acquire_bootstrap_lock(&venv),
        )
        .await
        .expect("lock acquisition must return an error rather than wait forever");
        let error = match result {
            Ok(_) => panic!("must not acquire a live owner's lock"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("Timed out"), "{error}");
        assert!(error.contains(&lock.display().to_string()), "{error}");
        assert_eq!(std::fs::read_to_string(&lock).unwrap(), owner);
    }

    #[tokio::test(start_paused = true)]
    async fn legacy_directory_has_a_bounded_wait_without_removing_the_owner() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        let lock = root.path().join("kernel-venv.bootstrap.lock");
        std::fs::create_dir(&lock).unwrap();
        let owner = format!("{}\n", std::process::id());
        std::fs::write(lock.join("pid"), &owner).unwrap();

        let result = tokio::time::timeout(
            BOOTSTRAP_LOCK_WAIT + Duration::from_secs(1),
            acquire_bootstrap_lock(&venv),
        )
        .await
        .expect("legacy lock acquisition must also have a deadline");
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(lock.join("pid")).unwrap(), owner);
    }

    #[tokio::test(start_paused = true)]
    async fn an_owner_releasing_before_the_deadline_allows_acquisition() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        let lock = root.path().join("kernel-venv.bootstrap.lock");
        let owner = acquire_bootstrap_lock(&venv).await.unwrap();
        let mut waiter = Box::pin(acquire_bootstrap_lock(&venv));
        assert!(matches!(
            futures::poll!(&mut waiter),
            std::task::Poll::Pending
        ));
        drop(owner);
        let successor = waiter.await.unwrap();
        assert!(lock.exists());
        drop(successor);
        assert!(!lock.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_a_waiter_preserves_the_owner_and_cleans_candidates() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        let lock = root.path().join("kernel-venv.bootstrap.lock");
        let owner = acquire_bootstrap_lock(&venv).await.unwrap();
        let mut waiter = Box::pin(acquire_bootstrap_lock(&venv));
        assert!(matches!(
            futures::poll!(&mut waiter),
            std::task::Poll::Pending
        ));
        drop(waiter);
        assert!(lock.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        drop(owner);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
