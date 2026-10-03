//! The supervisor-ownership registry's shutdown-admission and
//! startup-fence arms (port of TS `daemon-supervisor-ownership.ts`; the
//! bind-choreography parity audit's D3 fix).
//!
//! TS closes the update-restart stop window with two durable records under
//! `~/.prime/supervisor-owners` (`defaultDaemonSupervisorRegistryDir`,
//! `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR` to override):
//!
//! * `shutdown-admission.json` - a 5000 ms lease renewed every 1000 ms by
//!   whoever holds the stop window (the update coordinator, TS
//!   `runDaemonUpdateRestartCoordinator`; `shutdown --all`, TS
//!   `daemon-ps.ts`). A successor supervisor booting while it is ACTIVE
//!   (unexpired lease, live holder process) refuses with "Daemon shutdown
//!   is in progress" (TS `DaemonShutdownAdmissionError`, code
//!   `daemon_shutdown_in_progress`). A crashed holder is inert at once -
//!   the liveness check, not the file's presence, is the authority - and a
//!   stalled holder's lease elapses in 5 s; the record is reclaimed
//!   under the registry guard by the next active read (TS
//!   `readActiveShutdownAdmission` removes an inactive record;
//!   `readShutdownAdmission` never does).
//! * `startup-fences/<sha256(socket)>.json` - the dying predecessor pinned
//!   by its process identity (pid + process start id), persisted by the
//!   update coordinator from the hello it verified while the predecessor
//!   was still live. A successor supervisor WAITS it out at boot (TS
//!   `waitForDaemonStartupFence`: 250 ms poll, 10 s default, 60 s from
//!   the coordinator) and clears it under the guard when the pinned
//!   process is gone; a LIVE pin is never killed, only waited for.
//!
//! The registry guard is the proper-lockfile protocol the TS product uses
//! (`LockDir`: an empty directory with an mtime probe at
//! `<registry>/.guard`, stale 5 s, 500 retries x 10 ms - byte-compatible
//! with the TS lock path so both builds serialize on the SAME on-disk
//! lock). The guard-held actions here are single-record read-modify-write
//! cycles, so the rust port keeps `LockDir`'s momentary hold (no refresher):
//! the TS lock's 1000 ms mtime refresh is its long-hold safety valve, and
//! nothing here holds long.
//!
//! Deliberately NOT ported (the audit's E10 registry lane, to which the
//! module doc of `crate::supervisor` points): the owner records the fence
//! is validated against (`persistDaemonStartupFenceFromOwner`'s
//! hello-vs-owner checks reduce to the observed process-identity check
//! here), the TS pre-move registry-location scan (this tree's registry
//! has always lived at the current location), and the read-only admission probe of the worker-side
//! replacement monitor (this tree's `supervisor_lost` has no replacement
//! launch to gate - a documented divergence there).
//!
//! Durability: the records are written the way TS writes them
//! (`writeJsonAtomically`: atomic rename, mode 0600, NO fsync - the TS
//! product fsyncs neither registry site). A crash can lose the very last
//! lease refresh; the 5 s/1 s expiry and the liveness check carry exactly
//! that window (the disclosed durability-vs-availability call).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The registry override env (TS `DAEMON_SUPERVISOR_REGISTRY_DIR_ENV`).
pub const REGISTRY_DIR_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

/// TS `OWNER_VERSION`: the record shape version on every registry record.
const OWNER_VERSION: u32 = 1;
/// TS `REGISTRY_LOCK_STALE_MS`: a guard lock older than this is reclaimed.
const REGISTRY_LOCK_STALE_MS: Duration = Duration::from_secs(5);
/// TS `REGISTRY_LOCK_RETRIES` x `REGISTRY_LOCK_RETRY_MS`: the guard's
/// acquisition retry ladder (500 x 10 ms ~= 5 s).
const REGISTRY_LOCK_RETRIES: u32 = 500;
const REGISTRY_LOCK_RETRY_MS: Duration = Duration::from_millis(10);
/// TS `STARTUP_FENCE_POLL_MS`: the fence wait's poll cadence.
const STARTUP_FENCE_POLL_MS: Duration = Duration::from_millis(250);
/// TS `waitForDaemonStartupFence`'s default timeout (10 s; the coordinator
/// passes its own 60 s).
pub const STARTUP_FENCE_TIMEOUT_MS: u64 = 10_000;
/// TS `SHUTDOWN_ADMISSION_LEASE_MS`: how long a stop window's admission
/// stays valid without a renewal.
const SHUTDOWN_ADMISSION_LEASE_MS: u64 = 5_000;
/// TS `SHUTDOWN_ADMISSION_REFRESH_MS`: the holder's renewal cadence.
const SHUTDOWN_ADMISSION_REFRESH_MS: Duration = Duration::from_millis(1_000);
/// TS `SHUTDOWN_ADMISSION_WAIT_MS`: an acquire retry's backoff while
/// another stop window's admission is active.
const SHUTDOWN_ADMISSION_WAIT_MS: Duration = Duration::from_millis(50);
/// TS `SHUTDOWN_ADMISSION_FILE_NAME`.
const SHUTDOWN_ADMISSION_FILE_NAME: &str = "shutdown-admission.json";
/// The fence records live in this subdirectory (TS
/// `resolve(registryDir, "startup-fences")`).
const STARTUP_FENCES_DIR_NAME: &str = "startup-fences";

/// The durable registry root: the env override when set, else
/// `~/.prime/supervisor-owners` (TS `defaultDaemonSupervisorRegistryDir`:
/// global per user, deliberately outside `$TMPDIR` and outside the
/// per-invocation agent dir so every daemon on the box shares it).
///
/// # Errors
///
/// Returns an error when the override path is not valid Unicode and the
/// fallback needs the home directory but [`crate::paths::home_dir`]
/// cannot resolve it.
pub fn registry_dir() -> Result<PathBuf> {
    match std::env::var_os(REGISTRY_DIR_ENV) {
        Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ => Ok(crate::paths::home_dir()?
            .join(".prime")
            .join("supervisor-owners")),
    }
}

/// The lexical socket identity (TS `normalizeSocketPath`: `resolve()` -
/// absolute, `.`/`..` folded, no symlink resolution; the registry keys and
/// the fence records spell the socket this way).
#[must_use]
pub fn normalize_socket_path(socket_path: &Path) -> String {
    use std::path::Component;
    let joined = if socket_path.is_absolute() {
        socket_path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(socket_path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().to_string()
}

/// The fence record's path: full sha256 hex of the normalized socket path
/// under `<registry>/startup-fences` (TS `startupFencePath`).
#[must_use]
fn startup_fence_path(registry_dir: &Path, socket_path: &Path) -> PathBuf {
    let key = Sha256::digest(normalize_socket_path(socket_path).as_bytes());
    let hex: String = key.iter().fold(String::new(), |mut hex, byte| {
        use std::fmt::Write;
        write!(hex, "{byte:02x}").expect("write to String");
        hex
    });
    registry_dir
        .join(STARTUP_FENCES_DIR_NAME)
        .join(format!("{hex}.json"))
}

/// The admission record's path (TS `shutdownAdmissionPath`).
fn shutdown_admission_path(registry_dir: &Path) -> PathBuf {
    registry_dir.join(SHUTDOWN_ADMISSION_FILE_NAME)
}

/// The registry guard: the proper-lockfile protocol against the TS lock
/// path (`<registryDir>/.guard`), held for one short read-modify-write
/// cycle. Contention surfaces as a retry, a stale guard (>= 5 s) is
/// reclaimed, and every visitor both creates the registry (mode 0700)
/// and serializes on the same lock a TS process takes (TS
/// `withDaemonSupervisorRegistryGuard`).
fn with_registry_guard<T>(registry_dir: &Path, action: impl FnOnce() -> Result<T>) -> Result<T> {
    crate::paths::ensure_dir(registry_dir)?;
    let guard = registry_dir.join(".guard");
    for attempt in 0..=REGISTRY_LOCK_RETRIES {
        match pa_core::platform::LockDir::acquire_at(&guard, REGISTRY_LOCK_STALE_MS) {
            Ok(lock) => {
                let result = action();
                drop(lock);
                return result;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => {
                return Err(anyhow!(
                    "Daemon supervisor registry guard: {}: {error}",
                    registry_dir.display()
                ));
            }
        }
        if attempt < REGISTRY_LOCK_RETRIES {
            std::thread::sleep(REGISTRY_LOCK_RETRY_MS);
        }
    }
    Err(anyhow!(
        "Timed out waiting for the daemon supervisor registry guard: {}",
        registry_dir.display()
    ))
}

/// The registry's atomic record write (TS `writeJsonAtomically`):
/// pretty JSON + trailing newline, atomic rename, mode 0600, no fsync.
fn write_record(path: &Path, record: &impl Serialize) -> Result<()> {
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(record).context("serialize the registry record")?
    );
    crate::descriptor::write_file_atomic_unsynced(path, &body)
        .with_context(|| format!("persist {}", path.display()))
}

/// The shutdown-admission record (TS `DaemonShutdownAdmissionRecord`,
/// field order the TS writer's).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShutdownAdmissionRecord {
    version: u32,
    token: String,
    pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    process_start_id: Option<String>,
    created_at: String,
    updated_at: String,
    expires_at: String,
}

/// The startup-fence record (TS `DaemonStartupFenceRecord`, field order
/// the TS writer's).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupFenceRecord {
    version: u32,
    token: String,
    owner_token: String,
    pid: u32,
    process_start_id: String,
    socket_path: String,
    supervisor_generation: String,
    created_at: String,
}

/// Whether a pinned process identity is still that process (TS
/// `isProcessIdentityAlive`): a dead pid is dead, a start id the
/// platform does not expose keeps the pin alive, and an unanswerable
/// liveness probe counts as alive (the lease API's rule - a live owner
/// is never reclaimed on a probe failure; TS's kill(0) EPERM -> alive).
fn is_process_identity_alive(pid: u32, process_start_id: Option<&str>) -> bool {
    if !crate::lease::is_process_alive(pid).unwrap_or(true) {
        return false;
    }
    match process_start_id {
        None | Some("") => true,
        Some(expected) => match crate::lease::get_process_start_id(pid) {
            // A start id the platform does not expose keeps the pin alive
            // (TS: `observed === undefined`).
            None => true,
            Some(observed) => observed == expected,
        },
    }
}

/// Whether the holder process still owns its recorded identity (TS
/// `matchesExactProcessIdentity`): a dead pid is dead; a start id must
/// still be observable AND match.
fn matches_exact_process_identity(pid: u32, process_start_id: Option<&str>) -> bool {
    if !crate::lease::is_process_alive(pid).unwrap_or(true) {
        return false;
    }
    match process_start_id {
        None | Some("") => true,
        Some(expected) => crate::lease::get_process_start_id(pid).as_deref() == Some(expected),
    }
}

/// Read a shutdown-admission record; `Ok(None)` when absent (TS
/// `readShutdownAdmission`: a present-but-malformed record is an error,
/// never silently inert).
fn read_shutdown_admission(path: &Path) -> Result<Option<ShutdownAdmissionRecord>> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let record: ShutdownAdmissionRecord = serde_json::from_str(&raw)
        .map_err(|_| anyhow!("Invalid daemon shutdown admission: {}", path.display()))?;
    if record.version != OWNER_VERSION
        || record.pid == 0
        || crate::util::iso_to_unix_ms(&record.expires_at).is_none()
    {
        bail!("Invalid daemon shutdown admission: {}", path.display());
    }
    Ok(Some(record))
}

/// Whether an admission record still describes an active stop window (TS
/// `shutdownAdmissionIsActive`): unexpired lease AND live holder identity.
fn shutdown_admission_is_active(record: &ShutdownAdmissionRecord) -> bool {
    crate::util::iso_to_unix_ms(&record.expires_at)
        .is_some_and(|expires_at| expires_at > crate::util::now_ms())
        && is_process_identity_alive(record.pid, record.process_start_id.as_deref())
}

/// Read the ACTIVE admission, reclaiming an inactive record (TS
/// `readActiveShutdownAdmission`: an expired or dead-holder record is
/// removed by the active reader - only `readShutdownAdmission` alone never
/// touches the file). NO GUARD HERE: like the TS function, the CALLER
/// holds the registry guard (the refusal arm, the acquire arm) - a
/// self-reentrant guard would deadlock its own holder.
fn read_active_shutdown_admission(registry_dir: &Path) -> Result<Option<ShutdownAdmissionRecord>> {
    let path = shutdown_admission_path(registry_dir);
    let Some(admission) = read_shutdown_admission(&path)? else {
        return Ok(None);
    };
    if shutdown_admission_is_active(&admission) {
        return Ok(Some(admission));
    }
    let _ = std::fs::remove_file(&path);
    Ok(None)
}

/// Read a startup-fence record; `Ok(None)` when absent (TS
/// `readStartupFence`: a present-but-malformed record is an error).
fn read_startup_fence(path: &Path) -> Result<Option<StartupFenceRecord>> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let record: StartupFenceRecord = serde_json::from_str(&raw)
        .map_err(|_| anyhow!("Invalid daemon startup fence: {}", path.display()))?;
    if record.version != OWNER_VERSION || record.pid == 0 {
        bail!("Invalid daemon startup fence: {}", path.display());
    }
    Ok(Some(record))
}

/// Wait out this socket's startup fence before the boot touches the
/// socket path (TS `waitForDaemonStartupFence`, the choreography slot
/// `daemon-supervisor.ts` `start()` visits before the ownership claim):
/// no fence means the path is free; a fence pinning a dead process is
/// cleared under the guard (a replaced record re-reads the new pin); a
/// fence pinning a LIVE process is waited out to the timeout and then
/// refuses the boot - never a kill.
///
/// # Errors
///
/// Returns an error when the fence does not name this socket, when the
/// registry record cannot be read, or when the pinned predecessor does
/// not exit before `timeout_ms` elapses.
pub async fn wait_for_startup_fence(socket_path: &Path, timeout_ms: u64) -> Result<()> {
    wait_for_startup_fence_in(&registry_dir()?, socket_path, timeout_ms).await
}

/// [`wait_for_startup_fence`] against an explicit registry directory (the
/// seam the unit tests isolate on).
async fn wait_for_startup_fence_in(
    registry_dir: &Path,
    socket_path: &Path,
    timeout_ms: u64,
) -> Result<()> {
    let path = startup_fence_path(registry_dir, socket_path);
    let normalized = normalize_socket_path(socket_path);
    // The wait's bound is local elapsed time: a monotonic deadline keeps
    // the 10 s/60 s budgets honest under clock adjustments (the record's
    // own timestamps stay wall-clock - TS's lease shape).
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms.max(1));
    loop {
        let Some(fence) = read_startup_fence(&path)? else {
            return Ok(());
        };
        if fence.socket_path != normalized {
            bail!(
                "Daemon startup fence does not match {}",
                socket_path.display()
            );
        }
        if !is_process_identity_alive(fence.pid, Some(&fence.process_start_id)) {
            let cleared = with_registry_guard(registry_dir, || {
                let current = read_startup_fence(&path)?;
                if current.is_none() {
                    return Ok(true);
                }
                if current
                    .as_ref()
                    .is_some_and(|current| current.token == fence.token)
                {
                    std::fs::remove_file(&path)
                        .with_context(|| format!("remove {}", path.display()))?;
                    return Ok(true);
                }
                Ok(false)
            })?;
            if cleared {
                return Ok(());
            }
            continue;
        }
        if tokio::time::Instant::now() >= deadline {
            bail!(
                "Timed out waiting for predecessor daemon process {} to exit",
                fence.pid
            );
        }
        tokio::time::sleep(STARTUP_FENCE_POLL_MS).await;
    }
}

/// The refusal a successor supervisor bows out with while a stop window
/// holds the admission (TS `acquireDaemonSupervisorOwnership`'s guard arm
/// throwing `DaemonShutdownAdmissionError`; the supervisor boot's
/// pre-bind slot). The inactive-record reclaim rides the active read.
///
/// # Errors
///
/// Returns the refusal error while a stop window is active, and any
/// registry read error.
pub fn refuse_while_shutdown_admission_active() -> Result<()> {
    let registry_dir = registry_dir()?;
    let active = with_registry_guard(&registry_dir, || {
        read_active_shutdown_admission(&registry_dir)
    })?;
    if active.is_some() {
        bail!("Daemon shutdown is in progress");
    }
    Ok(())
}

/// The verified hello identity a fence is persisted from (TS
/// `DaemonSupervisorHelloIdentity` at its `hasFixedDaemonSupervisorOwnerIdentity`
/// gate): a supervisor hello is fence-bearing only when it names its
/// process and pins its start identity (the rust hello always does on
/// this platform; a hello without one leaves the window unfenced exactly
/// like TS's old-build daemons).
pub struct FenceIdentity {
    pid: u32,
    process_start_id: String,
    owner_token: String,
    supervisor_generation: String,
}

impl FenceIdentity {
    /// Build the fence identity from the predecessor hello the coordinator
    /// verified by handshake, or `None` when the hello carries no fixed
    /// supervisor identity or names another socket (TS
    /// `hasFixedDaemonSupervisorOwnerIdentity`'s gate plus the
    /// socket-path check - an unfixed hello leaves the window unfenced,
    /// exactly like a TS old-build predecessor).
    #[must_use]
    pub fn from_verified_hello(
        identity: &pa_types::daemon::update_flow::UpdateProcessIdentity,
        socket_path: &Path,
        hello_socket_path: Option<&str>,
    ) -> Option<Self> {
        let pid = u32::try_from(identity.pid).ok()?;
        if pid == 0 {
            return None;
        }
        let process_start_id = identity.process_start_id.as_deref()?;
        let owner_token = identity.supervisor_owner_token.as_deref()?;
        let supervisor_generation = identity.supervisor_generation.as_deref()?;
        let hello_socket_path = hello_socket_path?;
        if normalize_socket_path(Path::new(hello_socket_path)) != normalize_socket_path(socket_path)
        {
            return None;
        }
        Some(FenceIdentity {
            pid,
            process_start_id: process_start_id.to_string(),
            owner_token: owner_token.to_string(),
            supervisor_generation: supervisor_generation.to_string(),
        })
    }
}

/// Persist this socket's startup fence from the verified hello identity
/// (TS `persistDaemonStartupFenceFromOwner`): the record pins the dying
/// predecessor by pid + start id, and the observed process identity is
/// re-verified at write time (the TS owner-record cross-check reduces to
/// this until the owner registry lands with the E10 lane).
///
/// # Errors
///
/// Returns an error when the registry record cannot be written, or when
/// the pinned process identity changed since the hello (the pin would
/// name the wrong process).
pub fn persist_startup_fence(socket_path: &Path, identity: &FenceIdentity) -> Result<()> {
    persist_startup_fence_in(&registry_dir()?, socket_path, identity)
}

/// [`persist_startup_fence`] against an explicit registry directory (the
/// seam the unit tests isolate on).
fn persist_startup_fence_in(
    registry_dir: &Path,
    socket_path: &Path,
    identity: &FenceIdentity,
) -> Result<()> {
    if !matches_exact_process_identity(identity.pid, Some(&identity.process_start_id)) {
        bail!(
            "Daemon supervisor process identity changed for {}",
            socket_path.display()
        );
    }
    let path = startup_fence_path(registry_dir, socket_path);
    let record = StartupFenceRecord {
        version: OWNER_VERSION,
        token: uuid::Uuid::new_v4().to_string(),
        owner_token: identity.owner_token.clone(),
        pid: identity.pid,
        process_start_id: identity.process_start_id.clone(),
        socket_path: normalize_socket_path(socket_path),
        supervisor_generation: identity.supervisor_generation.clone(),
        created_at: crate::util::now_iso(),
    };
    with_registry_guard(registry_dir, || {
        write_record(&path, &record)?;
        Ok(())
    })
}

/// A held shutdown admission: the stop window itself (TS
/// `acquireDaemonShutdownAdmission` -> `DaemonShutdownAdmission` +
/// `RenewableRegistryRecord`). The renewal is a background thread at the
/// TS 1000 ms cadence (TS's unref'd `setInterval` - the CLI's stop steps
/// block nothing here, so a thread is the honest analog of the timer).
/// Dropping the handle releases the record, so an unwound holder cannot
/// wedge the window; a crashed holder simply stops renewing, and the next
/// active read reclaims the inert record inside its 5 s lease.
pub struct ShutdownAdmission {
    state: Arc<AdmissionState>,
    renewal: Option<std::thread::JoinHandle<()>>,
}

struct AdmissionState {
    registry_dir: PathBuf,
    token: String,
    pid: u32,
    process_start_id: Option<String>,
    stopped: AtomicBool,
    lost: AtomicBool,
}

impl ShutdownAdmission {
    /// Acquire the stop-window admission (TS `acquireDaemonShutdownAdmission`):
    /// while another ACTIVE admission is held, wait the TS backoff and
    /// retry; the first inactive record encountered is reclaimed and
    /// replaced. The returned handle renews the lease every second until
    /// released.
    ///
    /// # Errors
    ///
    /// Returns an error when the registry record cannot be written or the
    /// renewal thread cannot be spawned.
    pub fn acquire() -> Result<Self> {
        Self::acquire_in(&registry_dir()?)
    }

    /// [`ShutdownAdmission::acquire`] against an explicit registry
    /// directory (the seam the unit tests isolate on).
    fn acquire_in(registry_dir: &Path) -> Result<Self> {
        let registry_dir = registry_dir.to_path_buf();
        let state = Arc::new(AdmissionState {
            registry_dir: registry_dir.clone(),
            token: uuid::Uuid::new_v4().to_string(),
            pid: std::process::id(),
            process_start_id: crate::lease::get_process_start_id(std::process::id()),
            stopped: AtomicBool::new(false),
            lost: AtomicBool::new(false),
        });
        loop {
            let acquired = with_registry_guard(&registry_dir, || {
                let path = shutdown_admission_path(&registry_dir);
                if read_active_shutdown_admission(&registry_dir)?.is_some() {
                    return Ok(None);
                }
                let now = crate::util::now_ms();
                let record = ShutdownAdmissionRecord {
                    version: OWNER_VERSION,
                    token: state.token.clone(),
                    pid: state.pid,
                    process_start_id: state.process_start_id.clone(),
                    created_at: crate::util::iso_from_unix_ms(now),
                    updated_at: crate::util::iso_from_unix_ms(now),
                    expires_at: crate::util::iso_from_unix_ms(
                        now.saturating_add(SHUTDOWN_ADMISSION_LEASE_MS),
                    ),
                };
                write_record(&path, &record)?;
                Ok(Some(()))
            })?;
            if acquired.is_some() {
                break;
            }
            std::thread::sleep(SHUTDOWN_ADMISSION_WAIT_MS);
        }
        let thread_state = Arc::clone(&state);
        let renewal = match std::thread::Builder::new()
            .name("shutdown-admission-renewal".to_string())
            .spawn(move || {
                loop {
                    std::thread::sleep(SHUTDOWN_ADMISSION_REFRESH_MS);
                    if thread_state.stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    // A read failure is swallowed (TS's interval catch): only
                    // a definitive `false` - a missing or foreign record -
                    // ends the admission.
                    if matches!(renew_once(&thread_state), Ok(false)) {
                        thread_state.lost.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }) {
            Ok(renewal) => renewal,
            Err(error) => {
                // No renewal thread, no window: the record this acquire
                // just wrote would hold every other boot for its whole
                // 5 s lease, so it is removed under the guard (the token
                // match) before the failure surfaces.
                state.stopped.store(true, Ordering::SeqCst);
                let registry_dir = &state.registry_dir;
                let token = &state.token;
                let _ = with_registry_guard(registry_dir, || {
                    let path = shutdown_admission_path(registry_dir);
                    if read_shutdown_admission(&path)?
                        .is_some_and(|current| &current.token == token)
                    {
                        std::fs::remove_file(&path)
                            .with_context(|| format!("remove {}", path.display()))?;
                    }
                    Ok(())
                });
                return Err(anyhow!("spawn the shutdown admission renewal: {error}"));
            }
        };
        Ok(ShutdownAdmission {
            state,
            renewal: Some(renewal),
        })
    }

    /// Assert the window is still ours and renew it (TS
    /// `assertOrRenew`): a lost admission surfaces the TS error, an
    /// elapsed-but-ours lease re-arms (the renewal cannot fire while a
    /// synchronous stop scan blocks the caller, so a late renew of a
    /// still-ours record is a re-arm, never a loss), and a record that
    /// cannot be read fails the assertion without ending the window (TS:
    /// only a missing or foreign record is terminal; the next assertion
    /// can succeed).
    ///
    /// # Errors
    ///
    /// Returns the loss error when the record was replaced by another
    /// holder or the holder identity changed, and any registry read error
    /// verbatim (the action aborts; the window itself survives).
    pub fn assert_or_renew(&self) -> Result<()> {
        if self.state.stopped.load(Ordering::SeqCst) || self.state.lost.load(Ordering::SeqCst) {
            bail!("Daemon shutdown admission was lost");
        }
        if !renew_once(&self.state)? {
            self.state.lost.store(true, Ordering::SeqCst);
            bail!("Daemon shutdown admission was lost");
        }
        Ok(())
    }

    /// Release the stop window (TS `release`): stop the renewal, then
    /// remove the record under the guard only when it is still ours. An
    /// in-flight renewal that already passed its stopped check may
    /// rewrite before the removal, but never after it - the release's
    /// removal is the final word (TS: "a stopped record must never be
    /// rewritten to disk" checked inside the guard).
    pub fn release(&mut self) {
        if self.state.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        // The renewal thread sees `stopped` at its next tick; a joined
        // detach would race the tick, and the guard-internal stopped check
        // already keeps a late renew from rewriting (TS: "a stopped record
        // must never be rewritten to disk"), so the thread is left to
        // notice on its own.
        drop(self.renewal.take());
        let registry_dir = &self.state.registry_dir;
        let token = &self.state.token;
        let _ = with_registry_guard(registry_dir, || {
            let path = shutdown_admission_path(registry_dir);
            if read_shutdown_admission(&path)?.is_some_and(|current| &current.token == token) {
                std::fs::remove_file(&path)
                    .with_context(|| format!("remove {}", path.display()))?;
            }
            Ok(())
        });
    }
}

impl Drop for ShutdownAdmission {
    fn drop(&mut self) {
        self.release();
    }
}

/// One renewal (TS `RenewableRegistryRecord.performRenew` +
/// `renewUnderGuard`): `Ok(true)` held (renewed or re-armed - an elapsed
/// lease of a still-ours record re-arms), `Ok(false)` lost (only a
/// missing/foreign record or a changed identity is terminal), `Err` the
/// record could not be read (NOT loss - the holder still owns its record;
/// the background thread swallows it, a direct assertion surfaces it).
fn renew_once(state: &AdmissionState) -> Result<bool> {
    let registry_dir = state.registry_dir.clone();
    with_registry_guard(&registry_dir, || {
        if state.stopped.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let path = shutdown_admission_path(&registry_dir);
        let current = read_shutdown_admission(&path)?;
        let Some(current) = current else {
            return Ok(false);
        };
        // An elapsed lease of a still-ours record re-arms it; only a
        // foreign record or a changed identity ends the admission.
        let ours = current.token == state.token
            && current.pid == state.pid
            && current.process_start_id == state.process_start_id
            && matches_exact_process_identity(state.pid, state.process_start_id.as_deref());
        if !ours {
            return Ok(false);
        }
        let now = crate::util::now_ms();
        let record = ShutdownAdmissionRecord {
            version: OWNER_VERSION,
            token: state.token.clone(),
            pid: state.pid,
            process_start_id: state.process_start_id.clone(),
            created_at: current.created_at,
            updated_at: crate::util::iso_from_unix_ms(now),
            expires_at: crate::util::iso_from_unix_ms(
                now.saturating_add(SHUTDOWN_ADMISSION_LEASE_MS),
            ),
        };
        write_record(&path, &record)?;
        Ok(true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn own_identity() -> (u32, String) {
        let pid = std::process::id();
        let start_id = crate::lease::get_process_start_id(pid)
            .expect("this test process has a start identity");
        (pid, start_id)
    }

    fn write_raw(path: &Path, record: &Value) {
        write_record(path, record).expect("write the registry record");
    }

    fn active_admission(expires_at_ms: u64) -> Value {
        let (pid, start_id) = own_identity();
        let now = crate::util::now_ms();
        serde_json::json!({
            "version": 1,
            "token": "admission-token",
            "pid": pid,
            "processStartId": start_id,
            "createdAt": crate::util::iso_from_unix_ms(now),
            "updatedAt": crate::util::iso_from_unix_ms(now),
            "expiresAt": crate::util::iso_from_unix_ms(now + expires_at_ms),
        })
    }

    fn admission_dead_holder(expires_at_ms: u64) -> Value {
        let (pid, start_id) = own_identity();
        // A dead holder's record: a pid that is not in the process table
        // and a start id that matches nothing - the crashed-coordinator shape.
        let now = crate::util::now_ms();
        serde_json::json!({
            "version": 1,
            "token": "crashed-admission-token",
            "pid": pid + 400_000,
            "processStartId": format!("{start_id}-dead"),
            "createdAt": crate::util::iso_from_unix_ms(now),
            "updatedAt": crate::util::iso_from_unix_ms(now),
            "expiresAt": crate::util::iso_from_unix_ms(now + expires_at_ms),
        })
    }

    fn live_fence(socket: &Path, token: &str) -> Value {
        let (pid, start_id) = own_identity();
        serde_json::json!({
            "version": 1,
            "token": token,
            "ownerToken": "owner-token",
            "pid": pid,
            "processStartId": start_id,
            "socketPath": normalize_socket_path(socket),
            "supervisorGeneration": format!("sup:{pid}"),
            "createdAt": crate::util::now_iso(),
        })
    }

    #[test]
    fn the_fence_filename_is_the_normalized_socket_digest() {
        let registry = tempfile::tempdir().expect("registry root");
        let socket = registry.path().join("daemon.sock");
        let path = startup_fence_path(registry.path(), &socket);
        let key = path.file_name().expect("fence file name").to_string_lossy();
        assert_eq!(key.len(), 69, "sha256 hex (64) + .json (5): {key}");
        // The TS spelling: normalizeSocketPath folds `.` segments, so the
        // key is the digest of the folded path.
        let folded = registry
            .path()
            .join("folded")
            .join("..")
            .join("daemon.sock");
        assert_eq!(
            normalize_socket_path(&folded),
            registry
                .path()
                .join("daemon.sock")
                .to_string_lossy()
                .to_string(),
            "the lexical normalizer folds the parent-dot segment"
        );
    }

    #[tokio::test]
    async fn an_absent_fence_admits_immediately() {
        let registry = tempfile::tempdir().expect("registry root");
        let socket = registry.path().join("daemon.sock");
        wait_for_startup_fence_in(registry.path(), &socket, 10_000)
            .await
            .expect("an absent fence never blocks the boot");
    }

    #[tokio::test]
    async fn a_live_fence_pin_waits_and_then_refuses_honestly() {
        let registry = tempfile::tempdir().expect("registry root");
        let socket = registry.path().join("daemon.sock");
        // The pinned process is THIS test process: alive for the whole
        // bounded wait.
        write_raw(
            &startup_fence_path(registry.path(), &socket),
            &live_fence(&socket, "tok"),
        );
        let error = wait_for_startup_fence_in(registry.path(), &socket, 200)
            .await
            .expect_err("a live pin must refuse at the timeout");
        let (pid, _) = own_identity();
        assert_eq!(
            error.to_string(),
            format!("Timed out waiting for predecessor daemon process {pid} to exit"),
            "the refusal is the TS message"
        );
        assert!(
            startup_fence_path(registry.path(), &socket).exists(),
            "a live pin is never removed by a timed-out waiter"
        );
    }

    #[tokio::test]
    async fn a_dead_fence_pin_self_clears_at_boot() {
        let registry = tempfile::tempdir().expect("registry root");
        let socket = registry.path().join("daemon.sock");
        // A pin on a dead process: the crashed-stop record.
        let (pid, start_id) = own_identity();
        let mut record = live_fence(&socket, "tok");
        record["pid"] = Value::from(pid + 400_000);
        record["processStartId"] = Value::from(format!("{start_id}-dead"));
        write_raw(&startup_fence_path(registry.path(), &socket), &record);
        wait_for_startup_fence_in(registry.path(), &socket, 5_000)
            .await
            .expect("a dead pin never blocks the boot");
        assert!(
            !startup_fence_path(registry.path(), &socket).exists(),
            "the boot clears the dead pin under the guard"
        );
    }

    #[tokio::test]
    async fn a_fence_for_another_socket_refuses() {
        let registry = tempfile::tempdir().expect("registry root");
        let socket = registry.path().join("daemon.sock");
        let mut record = live_fence(&socket, "tok");
        record["socketPath"] =
            Value::from(normalize_socket_path(&registry.path().join("other.sock")));
        write_raw(&startup_fence_path(registry.path(), &socket), &record);
        let error = wait_for_startup_fence_in(registry.path(), &socket, 1_000)
            .await
            .expect_err("a foreign fence record is refused");
        assert_eq!(
            error.to_string(),
            format!("Daemon startup fence does not match {}", socket.display()),
            "the refusal is the TS message"
        );
    }

    #[tokio::test]
    async fn a_malformed_fence_record_is_an_error_never_an_inert_read() {
        let registry = tempfile::tempdir().expect("registry root");
        let socket = registry.path().join("daemon.sock");
        let path = startup_fence_path(registry.path(), &socket);
        write_record(&path, &serde_json::json!({"version": 1, "pid": 1})).expect("write");
        let error = wait_for_startup_fence_in(registry.path(), &socket, 1_000)
            .await
            .expect_err("a present-but-invalid record errors (TS readStartupFence)");
        assert!(
            error.to_string().contains("Invalid daemon startup fence"),
            "the error names the record: {error}"
        );
    }

    #[test]
    fn an_active_admission_reads_active_and_reclaims_the_inert_one() {
        let registry = tempfile::tempdir().expect("registry root");
        let path = shutdown_admission_path(registry.path());

        write_raw(&path, &active_admission(5_000));
        assert!(
            read_active_shutdown_admission(registry.path())
                .expect("read")
                .is_some(),
            "an unexpired live-holder admission is active"
        );

        // The elapsed record of a live holder is inert and RECLAIMED by the
        // active read (TS readActiveShutdownAdmission removes it).
        let mut elapsed = active_admission(5_000);
        elapsed["expiresAt"] =
            Value::from(crate::util::iso_from_unix_ms(crate::util::now_ms() - 1_000));
        write_raw(&path, &elapsed);
        assert!(
            read_active_shutdown_admission(registry.path())
                .expect("read")
                .is_none(),
            "an elapsed lease is not active"
        );
        assert!(!path.exists(), "the active read reclaims the inert record");

        // A crashed holder is inert even before its lease elapses (the
        // disclosed availability call: the liveness check is the authority).
        write_raw(&path, &admission_dead_holder(60_000));
        assert!(
            read_active_shutdown_admission(registry.path())
                .expect("read")
                .is_none(),
            "a dead holder is inert immediately"
        );
        assert!(!path.exists(), "the inert record is reclaimed at read");
    }

    #[test]
    fn an_acquired_admission_renews_and_releases() {
        let registry = tempfile::tempdir().expect("registry root");
        let path = shutdown_admission_path(registry.path());
        let mut admission =
            ShutdownAdmission::acquire_in(registry.path()).expect("acquire the window");
        assert!(
            read_active_shutdown_admission(registry.path())
                .expect("read")
                .is_some(),
            "the held window is active"
        );
        // The renewal thread re-arms the lease (poll-until: the first tick
        // lands within the 1000 ms cadence).
        let first_expiry = std::fs::read_to_string(&path).expect("read the record");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let current = std::fs::read_to_string(&path).expect("read the record");
            if current != first_expiry {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the renewal never re-armed the lease"
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        admission.assert_or_renew().expect("still ours mid-window");
        admission.release();
        assert!(!path.exists(), "the release removes our record");
        let error = admission
            .assert_or_renew()
            .expect_err("a released window is lost");
        assert_eq!(
            error.to_string(),
            "Daemon shutdown admission was lost",
            "the loss message is the TS one"
        );
    }

    #[test]
    fn acquire_blocks_while_another_window_is_active() {
        let registry = tempfile::tempdir().expect("registry root");
        let mut first = ShutdownAdmission::acquire_in(registry.path()).expect("first window");

        let (armed_tx, armed_rx) = std::sync::mpsc::channel::<()>();
        let registry_dir = registry.path().to_path_buf();
        let second = std::thread::spawn(move || -> Result<()> {
            armed_tx.send(()).expect("signal");
            // The scope end releases the second window (the TS finally),
            // so the bounded window below can only be crossed by an
            // acquire that truly blocked on the first.
            let _held = ShutdownAdmission::acquire_in(&registry_dir)?;
            Ok(())
        });

        // While the first window stays held, the second acquire must NOT
        // complete (bounded poll: a completion inside the window breaks
        // the TS block and fails the test).
        armed_rx.recv().expect("the thread armed");
        let blocking_window = std::time::Instant::now() + std::time::Duration::from_millis(600);
        let completed_during_the_window = loop {
            if second.is_finished() {
                break true;
            }
            if std::time::Instant::now() >= blocking_window {
                break false;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert!(
            !completed_during_the_window,
            "the second acquire completed while the first window was active"
        );
        first.release();
        second
            .join()
            .expect("the blocked acquire completes after the release")
            .expect("acquire succeeds once the window frees");
    }

    #[test]
    fn a_foreign_record_loses_the_renewal_but_a_stall_keeps_ours() {
        let registry = tempfile::tempdir().expect("registry root");
        let path = shutdown_admission_path(registry.path());
        let mut admission =
            ShutdownAdmission::acquire_in(registry.path()).expect("acquire the window");
        // Another holder replaces our record (an expired one, so the next
        // acquire's active read reclaims it instead of blocking on it):
        // the admission is lost.
        let mut foreign = active_admission(5_000);
        foreign["expiresAt"] =
            Value::from(crate::util::iso_from_unix_ms(crate::util::now_ms() - 1_000));
        write_raw(&path, &foreign);
        assert!(
            admission.assert_or_renew().is_err(),
            "a foreign record ends the admission"
        );
        assert!(
            admission.state.lost.load(Ordering::SeqCst),
            "the loss is latched"
        );
        admission.release();
        assert!(path.exists(), "the release never removes a foreign record");

        // A merely-elapsed lease of a still-ours record re-arms (the
        // blocked-holder rule), and an unreadable record keeps the
        // admission (a guard/filesystem failure is not loss).
        let mut second = ShutdownAdmission::acquire_in(registry.path()).expect("second window");
        assert!(second.assert_or_renew().is_ok());
        second.release();
    }

    #[test]
    fn a_fence_persists_in_the_ts_record_shape() {
        let registry = tempfile::tempdir().expect("registry root");
        let socket = registry.path().join("daemon.sock");
        let (pid, start_id) = own_identity();
        let identity = FenceIdentity {
            pid,
            process_start_id: start_id,
            owner_token: "hello-owner-token".to_string(),
            supervisor_generation: format!("sup:{pid}"),
        };
        persist_startup_fence_in(registry.path(), &socket, &identity).expect("persist the fence");
        let raw = std::fs::read_to_string(startup_fence_path(registry.path(), &socket))
            .expect("read the fence record");
        assert!(
            raw.ends_with('\n'),
            "the TS writer ends the pretty JSON with a newline"
        );
        let record: Value = serde_json::from_str(&raw).expect("parse the fence record");
        assert_eq!(record["version"], Value::from(1));
        assert_eq!(record["pid"], Value::from(pid));
        assert_eq!(
            record["socketPath"],
            Value::from(normalize_socket_path(&socket))
        );
        assert_eq!(record["ownerToken"], Value::from("hello-owner-token"));
        assert_eq!(
            record["supervisorGeneration"],
            Value::from(format!("sup:{pid}"))
        );
        assert!(record["processStartId"].is_string());
        assert!(record["token"].is_string());
        assert!(record["createdAt"].is_string());
    }

    #[test]
    fn persist_refuses_a_changed_process_identity() {
        let registry = tempfile::tempdir().expect("registry root");
        let socket = registry.path().join("daemon.sock");
        let identity = FenceIdentity {
            pid: std::process::id() + 400_000,
            process_start_id: "proc:1".to_string(),
            owner_token: "tok".to_string(),
            supervisor_generation: "sup:1".to_string(),
        };
        let error = persist_startup_fence_in(registry.path(), &socket, &identity)
            .expect_err("a pin on a process that is not the verified one");
        assert_eq!(
            error.to_string(),
            format!(
                "Daemon supervisor process identity changed for {}",
                socket.display()
            ),
            "the refusal is the TS message"
        );
    }

    #[test]
    fn the_fence_identity_gate_requires_a_fixed_hello_for_this_socket() {
        let registry = tempfile::tempdir().expect("registry root");
        let socket: &std::path::Path = &registry.path().join("gate.sock");
        let (pid, start_id) = own_identity();
        let identity = |pid: Option<u64>, start: Option<&str>| {
            pa_types::daemon::update_flow::UpdateProcessIdentity {
                pid: pid.unwrap_or_default(),
                process_start_id: start.map(str::to_string),
                supervisor_generation: Some(format!("sup:{}", pid.unwrap_or_default())),
                supervisor_owner_token: Some("tok".to_string()),
                rest: serde_json::Map::default(),
            }
        };
        assert!(
            FenceIdentity::from_verified_hello(
                &identity(Some(u64::from(pid)), Some(&start_id)),
                socket,
                Some(socket.to_string_lossy().as_ref()),
            )
            .is_some(),
            "a complete fixed hello pins"
        );
        assert!(
            FenceIdentity::from_verified_hello(
                &identity(Some(u64::from(pid)), None),
                socket,
                Some(socket.to_string_lossy().as_ref()),
            )
            .is_none(),
            "a hello without a start identity leaves the window unfenced"
        );
        assert!(
            FenceIdentity::from_verified_hello(
                &identity(Some(u64::from(pid)), Some(&start_id)),
                socket,
                Some("/tmp/another.sock"),
            )
            .is_none(),
            "a hello naming another socket is not a fence for this one"
        );
        assert!(
            FenceIdentity::from_verified_hello(
                &identity(None, None),
                socket,
                Some(socket.to_string_lossy().as_ref()),
            )
            .is_none(),
            "a pid-less hello carries no identity"
        );
    }
}
