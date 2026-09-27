//! Cross-process bootstrap lock for the kernel venv, ported from
//! `utils/dir-lock.ts`: a `link(2)`-published lock file whose owner is a
//! live pid; stale locks are renamed aside, verified, then reclaimed.

use std::io::Write;
use std::path::{Path, PathBuf};

use super::venv::{
    BOOTSTRAP_LOCK_NAME, BOOTSTRAP_LOCK_RETRY_MS, BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS,
};

fn is_process_alive(pid: u32) -> bool {
    crate::platform::process::pid_exists(pid)
}

/// A `link(2)`-published lock file: born with owner content, EEXIST the only
/// collision signal; stale locks are renamed aside, verified, then reclaimed.
/// Ported from `utils/dir-lock.ts`.
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

/// Serialize concurrent bootstraps across processes on the same venv.
pub(crate) async fn acquire_bootstrap_lock(venv: &Path) -> anyhow::Result<impl Drop> {
    let lock_dir = venv.with_file_name(format!(
        "{}{}",
        venv.file_name().unwrap_or_default().to_string_lossy(),
        BOOTSTRAP_LOCK_NAME
    ));
    std::fs::create_dir_all(lock_dir.parent().unwrap_or(Path::new("/")))?;
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
                tokio::time::sleep(std::time::Duration::from_millis(BOOTSTRAP_LOCK_RETRY_MS)).await;
            }
        }
    }
}
