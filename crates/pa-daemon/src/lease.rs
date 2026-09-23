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
            // An owner without a session id is still identifiable by its
            // pid (the descriptive session-open error surfaces it).
            owner: owner
                .and_then(|o| o.active_session_id.clone())
                .filter(|id| !id.is_empty())
                .or_else(|| owner.map(|o| format!("another process (pid {})", o.pid)))
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

/// A guard older than this is stale and gets reclaimed (TS `stale: 5000`).
const STALE_GUARD_AFTER: Duration = Duration::from_secs(5);

/// Attempts before a fast guard acquisition surfaces its failure: the TS
/// `withLeaseGuard` budget of 100 retries at ~12ms.
const FAST_GUARD_ATTEMPTS: u32 = 100;

/// Wait past the stale window, covering the retry cadence between a
/// stale reclaim and the next acquisition attempt.
const THROUGH_STALE_SLACK: Duration = Duration::from_millis(500);

/// How long a guard acquisition waits for a foreign holder.
#[derive(Clone, Copy)]
enum GuardWait {
    /// The fast budget. The release and append paths hold the guard only
    /// for their own sub-millisecond bookkeeping, so a guard that stays
    /// busy for longer belongs to a genuinely stuck peer and surfaces
    /// as a failure instead of stalling the caller.
    Fast,
    /// Outlast the stale window: a holder killed mid-mutation (kill -9)
    /// can never release its guard, so an acquisition on the create/open
    /// path must survive until the stale reclaim instead of failing
    /// while the reclaim is still seconds away.
    ThroughStale,
}

/// Serialize lease-directory mutations with a guard directory lock.
///
/// The guard is a bare `<lease>.guard` directory: TS (`proper-lockfile`)
/// reclaims a foreign guard by rmdir, so it must stay empty on every
/// platform. The holder removes it when the action ends; a holder that
/// dies mid-action leaves it behind, and only the `STALE_GUARD_AFTER`
/// mtime window reclaims it (a bare guard carries no holder identity to
/// consult). `GuardWait` picks whether an acquisition outlives that
/// window - a fresh guard of a dead holder blocks a session open forever
/// if the open gives up first.
fn with_lease_guard<T>(
    directory: &Path,
    wait: GuardWait,
    action: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let guard = PathBuf::from(format!("{}.guard", directory.display()));
    let deadline = match wait {
        GuardWait::Fast => None,
        GuardWait::ThroughStale => {
            Some(std::time::Instant::now() + STALE_GUARD_AFTER + THROUGH_STALE_SLACK)
        }
    };
    let mut acquired = false;
    let mut attempt = 0u32;
    loop {
        match fs::create_dir(&guard) {
            Ok(()) => {
                acquired = true;
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // Every contention consumes the budget, stale or not: a
                // reclaim that keeps failing (permissions, or a peer
                // re-creating the guard) must burn out like any other
                // busy guard instead of spinning past the deadline.
                attempt += 1;
                let exhausted = match deadline {
                    Some(deadline) => std::time::Instant::now() >= deadline,
                    None => attempt >= FAST_GUARD_ATTEMPTS,
                };
                if exhausted {
                    break;
                }
                // Stale guard: a holder that died without cleanup. The
                // bare guard carries no holder identity (TS reclaims a
                // foreign guard by rmdir, so it must stay empty), so the
                // lease's owner is the stand-in: steal only when the
                // owner is provably dead or the lease never finished
                // acquiring. A live owner may hold the guard mid-append,
                // and taking it would break the append's exactly-one-
                // commit serialization; the one contender a dead owner
                // still allows - another acquirer racing this one - is
                // tolerated by acquire's own contention retries. A
                // successful reclaim retries immediately; anything else
                // falls through to the cadence so it stays paced.
                if crate::paths::mtime_age(&guard).is_some_and(|age| age > STALE_GUARD_AFTER)
                    && match read_owner(directory) {
                        Ok(Some(owner)) => !owner_alive(&owner),
                        Ok(None) => true,
                        Err(_) => false,
                    }
                    && fs::remove_dir_all(&guard).is_ok()
                {
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
        let _ = pa_core::session::window::flush_cache(&self.session_path);
        let _ = with_lease_guard(&self.directory, GuardWait::Fast, || {
            if let Ok(Some(owner)) = read_owner(&self.directory) {
                if owner.token == self.token {
                    reclaim_stale(&self.directory);
                }
            }
            Ok(())
        });
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        self.release();
    }
}

impl SessionLease {
    pub(crate) fn acquire_target(&self, path: &Path) -> Result<std::sync::Arc<Self>> {
        let agent_dir = self
            .directory
            .parent()
            .and_then(Path::parent)
            .expect("lease directory has agent root");
        acquire_runtime_session_lease(path, agent_dir).map(std::sync::Arc::new)
    }

    pub(crate) fn append(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        anyhow::ensure!(
            !self.released.load(std::sync::atomic::Ordering::SeqCst)
                && canonical_session_path(path) == self.session_path,
            "session lease does not own append target"
        );
        with_lease_guard(&self.directory, GuardWait::Fast, || {
            let owner = read_owner(&self.directory)?;
            anyhow::ensure!(
                owner
                    .as_ref()
                    .is_some_and(|owner| owner.token == self.token)
                    && !self.released.load(std::sync::atomic::Ordering::SeqCst),
                "session lease lost ownership before append"
            );
            pa_core::session::window::append_cached(
                path,
                bytes,
                pa_core::session::window::AppendOwnership::SessionLeaseHeld,
            )?;
            Ok(())
        })
    }
}

/// The live owner of a session file's runtime lease, when one exists: the
/// process identity another supervisor — or a surviving worker of any
/// daemon sharing this agent dir — would collide with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveLeaseOwner {
    pub pid: u32,
}

/// Whether a live process holds the session file's runtime lease: read the
/// shared `session-leases` ownership record (never acquiring, never
/// reclaiming) and keep only a provably-live owner. The lease table is the
/// one cross-daemon ownership record a shared agent dir offers, so the
/// automatic revival paths (boot adoption, the scheduled-work re-arm)
/// probe it before spawning a rival worker over a file another daemon's
/// worker already serves — one owning daemon. A dead owner, a missing
/// record, or an unreadable one answers `None` (a stale record is not
/// live ownership).
pub fn live_lease_owner(agent_dir: &Path, session_path: &Path) -> Option<LiveLeaseOwner> {
    let directory = lease_directory(agent_dir, session_path);
    let owner = read_owner(&directory).ok()??;
    if !owner_alive(&owner) {
        return None;
    }
    Some(LiveLeaseOwner { pid: owner.pid })
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
    acquire_runtime_session_lease(session_path, agent_dir).map(Some)
}

/// Acquire mandatory runtime ownership before opening or writing a session.
pub(crate) fn acquire_runtime_session_lease(
    session_path: &Path,
    agent_dir: &Path,
) -> Result<SessionLease> {
    let canonical = canonical_session_path(session_path);
    let root = agent_dir.join("session-leases");
    fs::create_dir_all(&root)?;
    let directory = lease_directory(agent_dir, &canonical);

    // The open path outlasts the stale window: a guard left by a holder
    // killed mid-mutation can never be released by its dead owner, and
    // failing the relaunch while the stale reclaim is still seconds away
    // would leave a kill -9'd session unrevivable for the whole window.
    with_lease_guard(&directory, GuardWait::ThroughStale, || {
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
                    return Ok(SessionLease {
                        session_path: canonical.clone(),
                        directory: directory.clone(),
                        token,
                        released: std::sync::atomic::AtomicBool::new(false),
                    });
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
    fn process_start_id_reflects_the_platform_ladder() {
        // Linux answers from /proc (`proc:`); macOS/BSD from `ps lstart=`
        // (`ps:`) - the same ladder TS `getProcessStartId` walks.
        let start = get_process_start_id(std::process::id());
        assert!(start.is_some());
        let id = start.unwrap();
        assert!(id.starts_with("proc:") || id.starts_with("ps:"));
        assert!(get_process_start_id(0).is_none());
    }

    #[test]
    fn runtime_lease_is_mandatory_and_shared_until_last_owner_drops() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, "{}").unwrap();
        let lease = std::sync::Arc::new(acquire_runtime_session_lease(&path, dir.path()).unwrap());
        let shared = lease.clone();
        assert!(acquire_runtime_session_lease(&path, dir.path()).is_err());
        drop(lease);
        assert!(acquire_runtime_session_lease(&path, dir.path()).is_err());
        drop(shared);
        let next = acquire_runtime_session_lease(&path, dir.path()).unwrap();
        assert_eq!(next.session_path, canonical_session_path(&path));
    }

    #[test]
    fn final_owner_token_check_allows_exactly_one_racing_writer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, "{}\n").unwrap();
        let stale = acquire_runtime_session_lease(&path, dir.path()).unwrap();
        let directory = stale.directory.clone();
        let replacement = LeaseOwner {
            version: 1,
            token: "replacement".to_owned(),
            pid: std::process::id(),
            process_start_id: get_process_start_id(std::process::id()),
            active_session_id: None,
            session_path: canonical_session_path(&path).to_string_lossy().to_string(),
            created_at: crate::util::now_iso(),
        };
        std::fs::write(
            directory.join("owner.json"),
            serde_json::to_string_pretty(&replacement).unwrap() + "\n",
        )
        .unwrap();
        let winner = SessionLease {
            session_path: canonical_session_path(&path),
            directory,
            token: replacement.token,
            released: std::sync::atomic::AtomicBool::new(false),
        };
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let path_a = path.clone();
        let path_b = path.clone();
        let barrier_a = barrier.clone();
        let barrier_b = barrier.clone();
        let stale = std::sync::Arc::new(stale);
        let winner = std::sync::Arc::new(winner);
        let stale_task = {
            let stale = stale.clone();
            std::thread::spawn(move || {
                barrier_a.wait();
                stale.append(&path_a, b"stale\n")
            })
        };
        let winner_task = {
            let winner = winner.clone();
            std::thread::spawn(move || {
                barrier_b.wait();
                winner.append(&path_b, b"winner\n")
            })
        };
        barrier.wait();
        let results = [stale_task.join().unwrap(), winner_task.join().unwrap()];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{}\nwinner\n");
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

    /// The state a kill -9 mid-mutation leaves behind: a lease owned by
    /// a dead process plus a brand-new guard its dead holder can never
    /// remove. The open path must wait out the stale window and reclaim
    /// both instead of failing while the reclaim is still seconds away.
    #[test]
    fn create_path_outlasts_a_fresh_guard_of_a_dead_holder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, "{}\n").unwrap();
        // `pid: 0` is provably dead through the same liveness ladder the
        // reclaimer applies to real crashed holders.
        let owner = LeaseOwner {
            version: 1,
            token: "dead-holder".to_owned(),
            pid: 0,
            process_start_id: get_process_start_id(0),
            active_session_id: None,
            session_path: canonical_session_path(&path).to_string_lossy().to_string(),
            created_at: crate::util::now_iso(),
        };
        let directory = lease_directory(dir.path(), &canonical_session_path(&path));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("owner.json"),
            serde_json::to_string_pretty(&owner).unwrap() + "\n",
        )
        .unwrap();
        std::fs::create_dir(format!("{}.guard", directory.display())).unwrap();
        let started = std::time::Instant::now();
        let lease = acquire_runtime_session_lease(&path, dir.path()).unwrap();
        // The guard was brand new: a fresh guard is never stolen early,
        // so success proves the open waited out the stale window. The
        // guard ages from its creation, a hair before `started`, so the
        // bound allows that setup gap.
        let elapsed = started.elapsed();
        assert!(
            elapsed >= STALE_GUARD_AFTER - Duration::from_millis(250),
            "the fresh guard was not waited out: {elapsed:?}"
        );
        // Generous ceiling: the reclaim fires right after the window, and
        // only a scheduler stall between iterations can stretch the gap.
        assert!(
            elapsed < STALE_GUARD_AFTER + THROUGH_STALE_SLACK + Duration::from_secs(10),
            "the stale reclaim overran its window: {elapsed:?}"
        );
        lease.release();
    }

    /// A guard past the stale window whose lease owner is alive is never
    /// stolen: the open path waits out its deadline and fails instead of
    /// breaking the live owner's append serialization (the bare guard
    /// carries no identity, so the owner's liveness is all a steal can
    /// consult).
    #[cfg(unix)]
    #[test]
    fn stale_guard_of_a_live_owner_is_never_stolen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, "{}\n").unwrap();
        let lease = acquire_runtime_session_lease(&path, dir.path()).unwrap();
        let guard = format!("{}.guard", lease.directory.display());
        std::fs::create_dir(&guard).unwrap();
        let old = std::time::SystemTime::now() - STALE_GUARD_AFTER - Duration::from_secs(1);
        std::fs::File::open(&guard)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let started = std::time::Instant::now();
        let error = acquire_runtime_session_lease(&path, dir.path()).unwrap_err();
        let elapsed = started.elapsed();
        assert!(
            error
                .to_string()
                .contains("Could not coordinate session lease"),
            "unexpected error: {error}"
        );
        assert!(
            elapsed >= STALE_GUARD_AFTER,
            "the wait was cut short: {elapsed:?}"
        );
        assert!(
            elapsed < STALE_GUARD_AFTER + THROUGH_STALE_SLACK + Duration::from_secs(10),
            "the wait overran its deadline: {elapsed:?}"
        );
        assert!(
            std::fs::symlink_metadata(&guard)
                .unwrap()
                .file_type()
                .is_dir(),
            "the live owner's guard was stolen"
        );
        std::fs::remove_dir(&guard).unwrap();
        lease.release();
    }

    /// A stale-guard reclaim whose removal keeps failing must burn the
    /// budget instead of spinning past it on immediate retries.
    #[cfg(unix)]
    #[test]
    fn stale_guard_reclaim_failure_stays_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, "{}\n").unwrap();
        // A dead owner (pid 0) whose guard reads stale but can never be
        // reclaimed: `remove_dir_all` on a plain file fails on every
        // retry, root included, so the open must pace itself out.
        let owner = LeaseOwner {
            version: 1,
            token: "dead-holder".to_owned(),
            pid: 0,
            process_start_id: get_process_start_id(0),
            active_session_id: None,
            session_path: canonical_session_path(&path).to_string_lossy().to_string(),
            created_at: crate::util::now_iso(),
        };
        let directory = lease_directory(dir.path(), &canonical_session_path(&path));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("owner.json"),
            serde_json::to_string_pretty(&owner).unwrap() + "\n",
        )
        .unwrap();
        let guard = format!("{}.guard", directory.display());
        std::fs::write(&guard, b"stale").unwrap();
        let old = std::time::SystemTime::now() - STALE_GUARD_AFTER - Duration::from_secs(1);
        std::fs::File::open(&guard)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let started = std::time::Instant::now();
        let error = acquire_runtime_session_lease(&path, dir.path()).unwrap_err();
        let elapsed = started.elapsed();
        assert!(
            error
                .to_string()
                .contains("Could not coordinate session lease"),
            "unexpected open error: {error}"
        );
        assert!(
            elapsed < STALE_GUARD_AFTER + THROUGH_STALE_SLACK + Duration::from_secs(2),
            "the failed reclaim outlived its deadline: {elapsed:?}"
        );
        std::fs::remove_file(&guard).unwrap();
        let _ = fs::remove_dir_all(&directory);
    }

    /// The append path keeps the fast budget: a fresh foreign guard
    /// fails the append promptly instead of stalling the turn for the
    /// whole stale window.
    #[test]
    fn append_fails_fast_behind_a_fresh_guard() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, "{}\n").unwrap();
        let lease = acquire_runtime_session_lease(&path, dir.path()).unwrap();
        let guard = format!("{}.guard", lease.directory.display());
        std::fs::create_dir(&guard).unwrap();
        let started = std::time::Instant::now();
        let error = lease.append(&path, b"blocked\n").unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Could not coordinate session lease"),
            "unexpected append error: {error}"
        );
        assert!(
            started.elapsed() < STALE_GUARD_AFTER,
            "append waited out the stale window: {:?}",
            started.elapsed()
        );
        std::fs::remove_dir(&guard).unwrap();
        lease.release();
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
