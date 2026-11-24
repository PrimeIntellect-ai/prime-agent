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

/// A leftover staging entry beside the venv or its lock is removed when the
/// pid in its name is dead or when it is older than this horizon.
const BOOTSTRAP_STAGING_STALE_AFTER: Duration = Duration::from_hours(1);

/// The staging kinds beside the venv: build candidates and recovered partial
/// trees. A retired `<venv>.stale-*` copy is not staging: recovery may need it,
/// and only a completed swap removes it.
const VENV_STAGING_KINDS: [&str; 2] = ["candidate-", "partial-"];

/// The staging kinds beside the lock: publication candidates and stale renames.
const LOCK_STAGING_KINDS: [&str; 2] = ["candidate-", "stale-"];

/// Best-effort removal of staging leftovers beside the venv and its lock.
///
/// Runs only while the caller holds the bootstrap lock, so no live bootstrap
/// owns a matching entry. An entry whose embedded pid is dead, or that is
/// older than `horizon`, is removed; a removal failure is ignored, because the
/// sweep must never fail the bootstrap (a Windows entry still in use fails
/// here and is retried by the next acquisition).
pub(crate) fn sweep_stale_staging(dir: &Path, base: &str, kinds: &[&str], horizon: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{base}.");
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        let Some(pid_rest) = kinds.iter().find_map(|kind| rest.strip_prefix(kind)) else {
            continue;
        };
        let pid = strict_pid(Some(pid_rest.split('-').next().unwrap_or("")));
        let age = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok());
        let stale =
            pid.is_some_and(|pid| !is_process_alive(pid)) || age.is_some_and(|age| age >= horizon);
        if stale {
            let path = entry.path();
            let _ = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        }
    }
}

/// Releases the bootstrap lock when the leader's guard drops.
pub(crate) struct LockGuard(PathBuf);

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Recover an interrupted swap, then sweep dead staging entries.
///
/// A process can die after renaming the live venv aside but before moving its
/// candidate into place. Recovery is best effort: when a retired copy cannot be
/// renamed back (for example a Windows process still holds it), the rebuild
/// repairs the live path. The sweep never touches a retired copy.
fn recover_then_sweep(venv: &Path, lock_dir: &Path) {
    let _ = super::venv::recover_interrupted_venv_swap(venv);
    // Nothing live can own these entries: the lock is held.
    let parent = lock_dir.parent().unwrap_or(Path::new("/"));
    for (base, kinds) in [
        (venv.file_name(), VENV_STAGING_KINDS.as_slice()),
        (lock_dir.file_name(), LOCK_STAGING_KINDS.as_slice()),
    ] {
        if let Some(base) = base {
            sweep_stale_staging(
                parent,
                &base.to_string_lossy(),
                kinds,
                BOOTSTRAP_STAGING_STALE_AFTER,
            );
        }
    }
}

/// Serialize concurrent bootstraps across processes on the same venv.
///
/// Single flight: the caller that publishes the lock is the only builder.
/// Every other caller polls `ready` while it waits and returns `None` once the
/// leader's venv is usable, so waiters never rebuild and never fail a wait
/// that the leader was about to win.
pub(crate) async fn acquire_bootstrap_lock(
    venv: &Path,
    ready: &(dyn Fn() -> bool + Sync),
) -> anyhow::Result<Option<impl Drop>> {
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
                let lock_guard = LockGuard(lock_dir.clone());
                recover_then_sweep(venv, &lock_dir);
                return Ok(Some(lock_guard));
            }
            DirLockAttempt::Held | DirLockAttempt::Reclaimed => {
                // The leader may have finished between attempts: a ready venv
                // ends the wait without a second rebuild.
                if ready() {
                    return Ok(None);
                }
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
    use crate::kernel::bootstrap::kernel_venv_python;
    use crate::kernel::bootstrap::tests::write_complete_venv;

    /// A pid that is certainly dead: a child that has already exited. A huge
    /// constant will not do: the maximum pid casts to -1, and a signal probe
    /// with -1 succeeds, so it would read as a live process.
    fn dead_pid() -> u32 {
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit"])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }

    #[test]
    fn the_staging_sweep_removes_dead_entries_and_keeps_live_ones() {
        let root = tempfile::tempdir().unwrap();
        // A pid that is certainly gone: every dead-pid leftover is swept.
        let dead = dead_pid();
        let partial = root.path().join(format!("kernel-venv.partial-{dead}-1111"));
        std::fs::create_dir_all(partial.join("bin")).unwrap();
        let candidate = root
            .path()
            .join(format!("kernel-venv.candidate-{dead}-2222"));
        std::fs::write(&candidate, "half-built").unwrap();
        // This process is alive: its entry is not litter.
        let live = root
            .path()
            .join(format!("kernel-venv.candidate-{}-3333", std::process::id()));
        std::fs::create_dir_all(&live).unwrap();
        // Unrelated siblings never match the staging kinds.
        let other = root.path().join("kernel-venv.elsewhere");
        std::fs::write(&other, "x").unwrap();

        sweep_stale_staging(
            root.path(),
            "kernel-venv",
            &VENV_STAGING_KINDS,
            BOOTSTRAP_STAGING_STALE_AFTER,
        );

        assert!(!partial.exists(), "a dead pid's partial tree is swept");
        assert!(!candidate.exists(), "a dead pid's candidate is swept");
        assert!(live.exists(), "a live pid's entry is kept");
        assert!(other.exists(), "an unrelated sibling is kept");
    }

    #[test]
    fn the_staging_sweep_removes_entries_past_the_age_horizon() {
        let root = tempfile::tempdir().unwrap();
        // No parseable pid: only age can condemn this entry. A zero horizon
        // makes every entry at least as old as the horizon.
        let unnamed = root.path().join("kernel-venv.bootstrap.lock.stale-nopid");
        std::fs::write(&unnamed, "x").unwrap();
        sweep_stale_staging(
            root.path(),
            "kernel-venv.bootstrap.lock",
            &LOCK_STAGING_KINDS,
            Duration::ZERO,
        );
        assert!(!unnamed.exists(), "an entry past the horizon is swept");
        // A retired venv copy is kept on purpose, however old.
        let retired = root.path().join("kernel-venv.stale-1");
        std::fs::create_dir_all(&retired).unwrap();
        sweep_stale_staging(
            root.path(),
            "kernel-venv",
            &VENV_STAGING_KINDS,
            Duration::ZERO,
        );
        assert!(retired.exists(), "a retired venv copy is not staging");
    }

    #[tokio::test]
    async fn acquiring_the_lock_sweeps_a_dead_bootstraps_aftermath() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        let dead = dead_pid();
        let partial = root.path().join(format!("kernel-venv.partial-{dead}-4444"));
        std::fs::create_dir_all(&partial).unwrap();
        let lock_candidate = root
            .path()
            .join(format!("kernel-venv.bootstrap.lock.candidate-{dead}-5555"));
        std::fs::write(&lock_candidate, "0").unwrap();

        let guard = acquire_bootstrap_lock(&venv, &|| false).await.unwrap();
        assert!(guard.is_some(), "the sweep runs under the acquired lock");
        assert!(!partial.exists(), "the leader swept the dead partial tree");
        assert!(
            !lock_candidate.exists(),
            "the leader swept the dead lock candidate"
        );
    }

    #[tokio::test]
    async fn a_new_leader_restores_a_complete_venv_left_aside_by_a_killed_swap() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        let dead = dead_pid();
        let aside = root.path().join("kernel-venv.stale-1");
        write_complete_venv(&aside, "working interpreter");
        std::fs::write(
            venv.with_file_name("kernel-venv.bootstrap.lock"),
            format!("{dead}\n"),
        )
        .unwrap();

        let guard = acquire_bootstrap_lock(&venv, &|| false).await.unwrap();
        assert!(guard.is_some());
        assert!(kernel_venv_python(&venv).is_file());
        assert!(venv.join("pyvenv.cfg").is_file());
        assert!(!aside.exists(), "recovery consumes the restored copy");
    }

    #[tokio::test]
    async fn a_new_leader_replaces_a_partial_live_venv_from_a_complete_aside() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        let dead = dead_pid();
        let aside = root.path().join("kernel-venv.stale-1");
        write_complete_venv(&aside, "working interpreter");
        std::fs::create_dir_all(venv.join("lib/python3.11/site-packages")).unwrap();
        std::fs::write(
            venv.with_file_name("kernel-venv.bootstrap.lock"),
            format!("{dead}\n"),
        )
        .unwrap();

        let guard = acquire_bootstrap_lock(&venv, &|| false).await.unwrap();
        assert!(guard.is_some());
        assert!(kernel_venv_python(&venv).is_file());
        assert!(venv.join("pyvenv.cfg").is_file());
        assert!(!aside.exists(), "recovery consumes the restored copy");
        let partials: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".partial-"))
            .collect();
        assert!(
            partials.is_empty(),
            "recovery removes the incomplete tree: {partials:?}"
        );
    }

    #[tokio::test]
    async fn a_new_leader_keeps_a_complete_live_venv_over_an_old_aside() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        // A swap killed after its second rename leaves both trees complete.
        let aside = root.path().join("kernel-venv.stale-1");
        write_complete_venv(&venv, "new interpreter");
        write_complete_venv(&aside, "old interpreter");

        let guard = acquire_bootstrap_lock(&venv, &|| false).await.unwrap();
        assert!(guard.is_some());
        assert_eq!(
            std::fs::read_to_string(kernel_venv_python(&venv)).unwrap(),
            "new interpreter"
        );
        assert!(aside.exists(), "the leader keeps the retired copy");
    }

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
            acquire_bootstrap_lock(&venv, &|| false),
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
            acquire_bootstrap_lock(&venv, &|| false),
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
        let owner = acquire_bootstrap_lock(&venv, &|| false)
            .await
            .unwrap()
            .unwrap();
        let mut waiter = Box::pin(acquire_bootstrap_lock(&venv, &|| false));
        assert!(matches!(
            futures::poll!(&mut waiter),
            std::task::Poll::Pending
        ));
        drop(owner);
        let successor = waiter.await.unwrap().unwrap();
        assert!(lock.exists());
        drop(successor);
        assert!(!lock.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_a_waiter_preserves_the_owner_and_cleans_candidates() {
        let root = tempfile::tempdir().unwrap();
        let venv = root.path().join("kernel-venv");
        let lock = root.path().join("kernel-venv.bootstrap.lock");
        let owner = acquire_bootstrap_lock(&venv, &|| false)
            .await
            .unwrap()
            .unwrap();
        let mut waiter = Box::pin(acquire_bootstrap_lock(&venv, &|| false));
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
