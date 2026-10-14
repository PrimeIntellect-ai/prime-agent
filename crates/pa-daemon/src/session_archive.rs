//! Session archiving: retired sessions MOVE (never delete) to
//! `<agent-dir>/sessions-archive` under two settings rules — age and count
//! (oldest first). Protected sessions (resident workers, active scheduled jobs)
//! are counted but never archived; restore moves a session back before its
//! worker spawns, so every selector still finds it.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Context, Result};
use pa_core::settings::SessionArchivePolicy;

use crate::lease::canonical_session_path;
use crate::session_store::session_file_name;

/// Archive directory name under the agent dir.
pub const ARCHIVE_DIR_NAME: &str = "sessions-archive";

/// The archive location for one agent dir.
pub fn archive_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join(ARCHIVE_DIR_NAME)
}

/// One sessions-dir file the policy evaluates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepCandidate {
    pub path: PathBuf,
    pub session_id: String,
    pub modified: SystemTime,
    /// Resident or scheduled-work-protected: never archived, but counted
    /// toward the count cap.
    pub protected: bool,
}

/// Sessions the policy retires, oldest first (the order they archive).
pub fn plan_archive<'a>(
    candidates: &'a [SweepCandidate],
    policy: &SessionArchivePolicy,
    now: SystemTime,
) -> Vec<&'a SweepCandidate> {
    let max_age = policy
        .max_age_days
        .map(|days| Duration::from_secs(days * 24 * 60 * 60));
    let mut doomed: Vec<&SweepCandidate> = Vec::new();
    for candidate in candidates {
        if candidate.protected {
            continue;
        }
        if let (Some(max_age), Ok(age)) = (max_age, now.duration_since(candidate.modified)) {
            // The boundary is inclusive: a session is archival the moment it
            // reaches the age threshold.
            if age >= max_age {
                doomed.push(candidate);
            }
        }
    }
    if let Some(max_sessions) = policy.max_sessions {
        if candidates.len() > max_sessions {
            // Keep the newest `max_sessions` files by mtime (ties by path
            // for determinism); everything older archives unless protected.
            let mut ranked: Vec<&SweepCandidate> = candidates.iter().collect();
            ranked.sort_by(|left, right| {
                right
                    .modified
                    .cmp(&left.modified)
                    .then_with(|| left.path.cmp(&right.path))
            });
            doomed.extend(ranked[max_sessions..].iter().filter(|c| !c.protected));
        }
    }
    doomed.sort_by(|left, right| {
        left.modified
            .cmp(&right.modified)
            .then_with(|| left.path.cmp(&right.path))
    });
    doomed.dedup_by_key(|candidate| candidate.path.clone());
    doomed
}

/// The ownership context a sweep re-asserts at every destructive step:
/// the supervisor's shutdown flags and the socket lease's no-grace
/// compromise verdict, plus the lease's reclaim-sidecar exclusion held
/// across the short commit. A takeover that displaces the lock
/// directory trips the lease verdict on the very next poll - the 250ms
/// displacement grace never runs here - and a COMPLIANT successor
/// (judge or reclaim dance) must hold the same sidecar before it can
/// displace anything, so the commit cannot race a protocol-following
/// takeover.
pub(crate) struct SweepOwnership<'a> {
    /// The supervisor's shutdown flags (the fence raises them
    /// synchronously at lease-loss discovery).
    pub is_shutting_down: &'a (dyn Fn() -> bool + Send + Sync),
    /// The lease probe: `None` only where no lease exists (the
    /// non-housekeeping test paths); a sweep under the supervisor
    /// always carries one. Unix only - the lease machinery itself is
    /// unix-scoped, and a sweep without it re-asserts the supervisor
    /// flags alone (a ruled platform-scope limitation).
    #[cfg(unix)]
    pub lease: Option<&'a crate::socket::LeaseProbe>,
}

/// The sweep's lease-probe slot: the real probe on unix (the lease
/// machinery is unix-scoped); a void slot on the platforms without it.
#[cfg(unix)]
pub(crate) type SweepLease<'a> = Option<&'a crate::socket::LeaseProbe>;
#[cfg(not(unix))]
pub(crate) type SweepLease<'a> = Option<&'a ()>;

impl<'a> SweepOwnership<'a> {
    pub(crate) fn new(
        is_shutting_down: &'a (dyn Fn() -> bool + Send + Sync),
        lease: SweepLease<'a>,
    ) -> Self {
        #[cfg(not(unix))]
        let _ = lease; // the void slot keeps the signature uniform
        Self {
            is_shutting_down,
            #[cfg(unix)]
            lease,
        }
    }
}

/// The outcome of the commit-time ownership guard.
enum CommitGuard {
    /// The reclaim-sidecar exclusion is held and ownership is still
    /// ours: the caller performs the short commit and then drops the
    /// exclusion to release it. Linux only (the reclaim sidecar is
    /// renameat2-based).
    #[cfg(target_os = "linux")]
    Held(std::fs::File),
    /// No lease context (the non-housekeeping callers): the supervisor
    /// flags alone decided and the commit proceeds unguarded.
    Leaseless,
    /// Ownership was refused (flags up, lease compromised, or the
    /// exclusion could not be acquired): the source stays in place and
    /// the caller unwinds any staged copy.
    Refused,
}

impl SweepOwnership<'_> {
    /// The per-candidate pre-check: the cheap synchronous flags.
    fn may_continue(&self) -> bool {
        !(self.is_shutting_down)()
    }

    /// The commit-time re-assert under the reclaim-sidecar exclusion:
    /// acquire the lease's sidecar, then re-ask the shutdown flags AND
    /// the lease's no-grace compromise verdict while it is held. The
    /// exclusion is held for the REASSERT + the short commit only -
    /// never across the long cross-device copy (the lease heartbeat
    /// skips its mtime write while the sidecar is taken, so a
    /// whole-pass hold would age the lock toward the stale threshold
    /// and invite the very takeover it guards against).
    #[cfg(target_os = "linux")]
    async fn commit_guard(&self) -> Result<CommitGuard> {
        let Some(lease) = self.lease else {
            return Ok(CommitGuard::Leaseless);
        };
        let budget = Duration::from_millis(500);
        // `Ok(None)` = the budget expired (a suspended dance holds the
        // sidecar); `Err` = the acquisition task itself failed. Both
        // fail closed as a refusal.
        let Some(exclusion) = lease.hold_reclaim_exclusion(budget).await? else {
            return Ok(CommitGuard::Refused);
        };
        if (self.is_shutting_down)() || lease.compromised() {
            drop(exclusion);
            return Ok(CommitGuard::Refused);
        }
        Ok(CommitGuard::Held(exclusion))
    }

    /// The non-Linux commit: no reclaim sidecar exists (a ruled
    /// platform-scope limitation), so the supervisor flags alone
    /// re-assert at commit time.
    #[cfg(not(target_os = "linux"))]
    // The call sites await the same shape on every platform.
    #[allow(clippy::unused_async, clippy::unused_async_trait_impl)]
    async fn commit_guard(&self) -> Result<CommitGuard> {
        if self.may_continue() {
            return Ok(CommitGuard::Leaseless);
        }
        Ok(CommitGuard::Refused)
    }
}

/// One sweep over the sessions directory: collect, plan, move the doomed files
/// into the archive. Idempotent; a move failure skips that file.
pub async fn sweep_sessions(
    sessions_dir: &Path,
    archive_dir: &Path,
    protected: &HashSet<PathBuf>,
    policy: &SessionArchivePolicy,
    now: SystemTime,
    ownership: &SweepOwnership<'_>,
) -> Result<Vec<String>> {
    if policy.max_age_days.is_none() && policy.max_sessions.is_none() {
        return Ok(Vec::new());
    }
    let candidates = collect_candidates(sessions_dir, protected)?;
    let doomed = plan_archive(&candidates, policy, now);
    if doomed.is_empty() {
        return Ok(Vec::new());
    }
    fs::create_dir_all(archive_dir)
        .with_context(|| format!("create archive dir {}", archive_dir.display()))?;
    let mut archived = Vec::new();
    for candidate in doomed {
        // Per-candidate ownership stop: the caller's fence may have
        // declared the lease lost (or the supervisor is shutting down)
        // AFTER this loop snapshot was taken; a successor may have
        // adopted the sessions in this window. A stale-snapshot move
        // would archive a file the successor is serving, so the loop
        // re-asks the caller before EACH move - the bounded step
        // ownership guard the fence needs to make its abort stick even
        // against an already-running sweep.
        if !ownership.may_continue() {
            break;
        }
        let destination = archive_dir.join(session_file_name(&candidate.session_id));
        if destination.exists() {
            // A same-id file already archived: leave the live file alone
            // rather than clobber history (this guards a corrupted archive).
            continue;
        }
        // Cross-device candidates stage the (long, interruptible) copy
        // OUTSIDE any guard first; the short destructive commit below
        // re-asserts ownership under the reclaim-sidecar exclusion.
        let staged = if same_device(&candidate.path, archive_dir) {
            None
        } else {
            match stage_copy(&candidate.path, &destination) {
                // The RAII guard owns the stage's cleanup from the very
                // first moment: a refusal, a publish error, or a TASK
                // CANCELLATION (the fence aborts the sweep while the
                // exclusion acquisition is pending) all drop the guard
                // and leave nothing behind.
                Ok(staged) => Some(StagedFile::new(staged)),
                Err(error) => {
                    eprintln!(
                        "session archive: could not stage {}: {error:#}",
                        candidate.path.display()
                    );
                    continue;
                }
            }
        };
        // The short commit: exclusion + no-grace lease re-assert, then
        // the no-replace move, then release. Fail closed on refusal -
        // the staged guard (if any) unwinds itself on every early exit.
        let exclusion: Option<std::fs::File> = match ownership.commit_guard().await {
            #[cfg(target_os = "linux")]
            Ok(CommitGuard::Held(exclusion)) => Some(exclusion),
            Ok(CommitGuard::Leaseless) => None,
            Ok(CommitGuard::Refused) => {
                // Refused (flags up, lease compromised, or the sidecar
                // could not be acquired): leave the source, stop the
                // sweep - the staged guard's `Drop` unlinks the stage.
                break;
            }
            Err(error) => {
                // Acquisition failed: fail closed the same way.
                eprintln!(
                    "session archive: ownership exclusion failed at {}: {error:#}",
                    candidate.path.display()
                );
                break;
            }
        };
        // Still ours under the guard: the no-replace commit (atomic
        // same-device rename, or the staged hard-link publish + source
        // removal) runs while the exclusion is held, then releases.
        let outcome = commit_no_replace(&candidate.path, staged, &destination);
        drop(exclusion);
        match outcome {
            Ok(MoveOutcome::Moved) => archived.push(candidate.session_id.clone()),
            Ok(MoveOutcome::Unwound) => break,
            Err(error) => {
                // A failed move leaves the session in place; the sweep retries on its next
                // pass.
                eprintln!(
                    "session archive: could not move {}: {error:#}",
                    candidate.path.display()
                );
            }
        }
    }
    Ok(archived)
}

/// Restore an archived session into the sessions directory (the resume
/// path): returns the restored file path.
pub fn restore_session(
    archive_dir: &Path,
    sessions_dir: &Path,
    session_id: &str,
) -> Result<PathBuf> {
    let source = archive_dir.join(session_file_name(session_id));
    if !source.is_file() {
        return Err(anyhow!(
            "archived session \"{session_id}\" not found in {}",
            archive_dir.display()
        ));
    }
    let destination = sessions_dir.join(session_file_name(session_id));
    if destination.exists() {
        return Err(anyhow!(
            "session \"{session_id}\" already exists in {}",
            sessions_dir.display()
        ));
    }
    fs::create_dir_all(sessions_dir)
        .with_context(|| format!("create sessions dir {}", sessions_dir.display()))?;
    let may_continue = || true;
    match move_file(&source, &destination, &may_continue)? {
        MoveOutcome::Moved => Ok(destination),
        // A collision (another actor published the live name after the
        // existence check) or a refused guard must NOT report success:
        // the archive source still holds the session and the returned
        // destination may not exist.
        MoveOutcome::Unwound => Err(anyhow!(
            "session \"{session_id}\" could not be moved back to {} without replacing an existing file",
            sessions_dir.display()
        )),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum MoveOutcome {
    /// The file moved: the destination holds it and the source is gone.
    Moved,
    /// The move was UNWOUND mid-flight: the staged copy was removed and
    /// the source still sits where it was - the ownership stop flipped
    /// between the copy and the destructive source removal.
    Unwound,
}

/// The short destructive commit: publish the source (or its staged
/// cross-device copy) under the destination WITHOUT ever replacing an
/// existing entry, then remove the source. `AlreadyExists` is a
/// collision with another archiver (usually the successor's own sweep)
/// and returns [`MoveOutcome::Unwound`] - the caller keeps the source
/// and the same-id guard then treats the session as archived; every
/// OTHER publish failure propagates as a real error (never swallowed
/// into `Unwound`). The caller holds the ownership reassert around this
/// step: it must never run behind a stale snapshot.
fn commit_no_replace(
    source: &Path,
    staged: Option<StagedFile>,
    destination: &Path,
) -> Result<MoveOutcome> {
    #[cfg(target_os = "linux")]
    if staged.is_none() {
        // Same-device on Linux: the atomic no-replace rename (a single
        // kernel operation - `renameat2(RENAME_NOREPLACE)`), the same
        // primitive the lock-dir reclaim uses. Cross-device is handled
        // by the staged copy before this call.
        return match pa_core::platform::move_without_replacing(source, destination) {
            Ok(()) => Ok(MoveOutcome::Moved),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(MoveOutcome::Unwound),
            Err(err) => Err(err)
                .with_context(|| format!("move {} -> {}", source.display(), destination.display())),
        };
    }
    // The link-based no-replace commit: same-device on platforms
    // without renameat2, or the cross-device staged publish. fs::hard_link
    // is atomic and refuses an existing name, so a collision (another
    // daemon already archived this id) never clobbers anyone. The
    // staged guard OWNS the stage cleanup: a refusal or an error
    // returns with the guard still armed, and its `Drop` unlinks the
    // stage - including the cancellation case, where the future is
    // dropped at an await point and the guard's `Drop` is the only
    // cleanup that runs.
    let link_source = staged.as_ref().map_or(source, |stage| stage.path());
    if let Err(err) = fs::hard_link(link_source, destination) {
        if err.kind() == std::io::ErrorKind::AlreadyExists {
            return Ok(MoveOutcome::Unwound);
        }
        return Err(err).with_context(|| {
            format!(
                "publish {} -> {}",
                link_source.display(),
                destination.display()
            )
        });
    }
    fs::remove_file(source).with_context(|| format!("remove {}", source.display()))?;
    if let Some(stage) = staged {
        // The destination holds the inode and the source is gone: the
        // move HAS landed. The stage-name unlink is pure residue
        // cleanup - a failure (e.g. a read-only staging parent) is
        // logged, never a failed move: an `Err` here would make a
        // successful move look failed (restore errors, the sweep
        // undercounts and re-visits a session it already archived).
        let stage = stage.consumed();
        if let Err(err) = fs::remove_file(&stage) {
            eprintln!(
                "session archive: could not unlink the published stage {}: {err}",
                stage.display()
            );
        }
    }
    Ok(MoveOutcome::Moved)
}

/// Stage the (long, interruptible) cross-device copy to a private,
/// unique name: never onto the final archive name (a successor may
/// already hold it - a copy would truncate its file). Nothing outside
/// this stage touches the final name, and the ownership guards stay
/// OFF it (a long copy under the reclaim-sidecar exclusion would age
/// the lease's lock toward the stale threshold).
fn stage_copy(source: &Path, destination: &Path) -> Result<PathBuf> {
    let staged = staging_name(destination);
    if let Err(err) = fs::copy(source, &staged) {
        let _ = fs::remove_file(&staged);
        return Err(err)
            .with_context(|| format!("copy {} -> {}", source.display(), staged.display()));
    }
    Ok(staged)
}

/// Move one session file to the archive (the synchronous,
/// non-housekeeping form used by the restore path): same-device
/// via the no-replace primitives, cross-device via the staged copy,
/// refusing to replace any existing destination. The caller's
/// `may_continue` re-ask runs between the staging and the commit.
fn move_file(
    source: &Path,
    destination: &Path,
    may_continue: &dyn Fn() -> bool,
) -> Result<MoveOutcome> {
    let staged = if same_device(source, destination.parent().unwrap_or(destination)) {
        None
    } else {
        Some(StagedFile::new(stage_copy(source, destination)?))
    };
    if staged.is_some() && !may_continue() {
        // The refusal returns with the guard armed: its `Drop` unwinds
        // the stage, and a cancellation at any await point does too.
        return Ok(MoveOutcome::Unwound);
    }
    commit_no_replace(source, staged, destination)
}

/// Whether two paths sit on the same filesystem. Both sides FOLLOW
/// symlinks (`fs::metadata`): a sessions or archive directory symlinked
/// onto another filesystem reads the target's dev id, so the staged
/// cross-device path is chosen correctly instead of every
/// `renameat2` attempt failing `EXDEV` behind the symlink's own inode.
#[cfg(unix)]
fn same_device(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_device(_a: &Path, _b: &Path) -> bool {
    false
}

/// A private staging name in the destination's directory (same
/// filesystem, so the publish link works) that no other process would
/// produce for the same archive entry.
fn staging_name(destination: &Path) -> PathBuf {
    let file = destination
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    destination.with_file_name(format!(
        ".archiving-{}-{}-{}",
        file,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ))
}

/// A private staged copy whose lifetime owns its cleanup: the `Drop`
/// impl unlinks the staged path, so a refusal, a publish error, or a
/// TASK CANCELLATION landing between the stage and the commit all
/// leave nothing behind (the guard drops when the future is dropped at
/// its await point). A failure to unlink is logged, never swallowed.
struct StagedFile(PathBuf);

impl StagedFile {
    fn new(staged: PathBuf) -> Self {
        Self(staged)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    /// The publish consumed the stage: take the path out so the
    /// `Drop` cleanup cannot run on an already-unlinked name.
    fn consumed(mut self) -> PathBuf {
        std::mem::take(&mut self.0)
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if self.0.as_os_str().is_empty() {
            return;
        }
        if let Err(err) = fs::remove_file(&self.0) {
            eprintln!(
                "archive sweep could not unwind its staged copy {}: {err}",
                self.0.display()
            );
        }
    }
}

/// One candidate per valid session file directly under the sessions dir
/// (the archive layout never nests; subdirectories are not sessions).
fn collect_candidates(
    sessions_dir: &Path,
    protected: &HashSet<PathBuf>,
) -> Result<Vec<SweepCandidate>> {
    let Ok(read) = fs::read_dir(sessions_dir) else {
        return Ok(Vec::new());
    };
    let mut candidates = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(modified) = fs::metadata(&path).and_then(|m| m.modified()).ok() else {
            continue;
        };
        // A session file is a valid first-line `session` header with an id.
        let Some(header) = crate::session_store::read_session_header(&path) else {
            continue;
        };
        candidates.push(SweepCandidate {
            protected: protected.contains(&canonical_session_path(&path)),
            session_id: header.id,
            path,
            modified,
        });
    }
    Ok(candidates)
}

// Supervisor sweep seam

/// Sweep cadence: a boot sweep, then a periodic re-sweep.
const SWEEP_INTERVAL: Duration = Duration::from_mins(5);
/// The periodic loop sleeps in chunks so a shutdown exits promptly.
const SWEEP_SLEEP_CHUNK: Duration = Duration::from_secs(5);

/// The daemon's archive-sweep loop: one sweep at boot, then every
/// [`SWEEP_INTERVAL`]. Failures log and retry (never take the daemon down).
pub(crate) async fn archive_sweep_loop(supervisor: &std::sync::Arc<crate::supervisor::Supervisor>) {
    loop {
        match run_archive_sweep(supervisor).await {
            Ok(()) => {}
            Err(error) => {
                supervisor.log_line(&format!("session archive sweep failed: {error:#}"));
            }
        }
        let mut remaining = SWEEP_INTERVAL;
        while remaining > Duration::ZERO {
            if supervisor.is_shutting_down() {
                return;
            }
            let chunk = remaining.min(SWEEP_SLEEP_CHUNK);
            tokio::time::sleep(chunk).await;
            remaining -= chunk;
        }
    }
}

/// One sweep: resolve the policy from the current settings, collect the
/// protected paths, and move the retired sessions into the archive.
pub(crate) async fn run_archive_sweep(
    supervisor: &std::sync::Arc<crate::supervisor::Supervisor>,
) -> Result<()> {
    use std::collections::HashSet as Set;
    use std::path::Path;

    let agent_dir = supervisor.options.agent_dir.clone();
    let settings = pa_core::settings::SettingsManager::create(
        std::env::current_dir().unwrap_or_default(),
        &agent_dir,
    );
    let policy = settings.get_session_archive_policy();
    let sessions_dir = crate::paths::sessions_dir(&agent_dir)?;
    let mut protected = Set::new();
    for resident in supervisor.registry.list().await {
        let descriptor = resident.descriptor.lock().await;
        if let Some(session_file) = &descriptor.session_file {
            protected.insert(canonical_session_path(Path::new(session_file)));
        }
    }
    // Active scheduled jobs own their saved session files: a wake target
    // must never move.
    for job in crate::update_roster::scan_scheduled_jobs(&agent_dir) {
        if job.status == pa_core::cron::JobStatus::Active && !job.session_file.is_empty() {
            protected.insert(canonical_session_path(Path::new(&job.session_file)));
        }
    }
    // The per-candidate ownership stop: once the lease-loss fence's
    // flags go up (or the daemon begins shutting down), a sweep that
    // is already inside sweep_sessions must stop moving files - a
    // successor may have taken the socket between the loop's snapshot
    // and each individual move. The flags re-ask before EVERY move,
    // and the destructive commit re-asserts the lease's own no-grace
    // compromise verdict under the reclaim-sidecar exclusion - the
    // takeover that displaces the lock mid-copy cannot get the
    // successor's live file unlinked behind the stale snapshot.
    let supervisor_down = std::sync::Arc::clone(supervisor);
    let shutting_down = move || supervisor_down.is_shutting_down();
    #[cfg(unix)]
    let ownership = SweepOwnership::new(
        &shutting_down,
        supervisor
            .sweep_lease_probe
            .get()
            .map(std::convert::AsRef::as_ref),
    );
    #[cfg(not(unix))]
    let ownership = SweepOwnership::new(&shutting_down, None);
    let archived = sweep_sessions(
        &sessions_dir,
        &archive_dir(&agent_dir),
        &protected,
        &policy,
        SystemTime::now(),
        &ownership,
    )
    .await?;
    if !archived.is_empty() {
        supervisor.log_line(&format!(
            "archived {} session(s) into {}",
            archived.len(),
            archive_dir(&agent_dir).display()
        ));
        supervisor.note_sessions_archived(archived.len());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn candidate(id: &str, days_ago: u64, protected: bool, now: SystemTime) -> SweepCandidate {
        SweepCandidate {
            path: PathBuf::from(format!("/sessions/{id}.jsonl")),
            session_id: id.to_string(),
            modified: now - Duration::from_secs(days_ago * 24 * 60 * 60),
            protected,
        }
    }

    fn policy(age: Option<u64>, max_sessions: Option<usize>) -> SessionArchivePolicy {
        SessionArchivePolicy {
            max_age_days: age,
            max_sessions,
        }
    }

    #[test]
    fn age_rule_archives_at_and_past_the_boundary() {
        let now = SystemTime::now();
        let candidates = [
            candidate("fresh", 0, false, now),
            candidate("edge", 30, false, now),
            candidate("old", 31, false, now),
        ];
        let doomed = plan_archive(&candidates, &policy(Some(30), None), now);
        let ids: Vec<&str> = doomed.iter().map(|c| c.session_id.as_str()).collect();
        // The boundary is inclusive: 30 days untouched is archival; oldest first.
        assert_eq!(ids, vec!["old", "edge"]);
    }

    #[test]
    fn age_rule_off_archives_nothing() {
        let now = SystemTime::now();
        let candidates = [candidate("ancient", 400, false, now)];
        let doomed = plan_archive(&candidates, &policy(None, None), now);
        assert!(doomed.is_empty());
    }

    #[test]
    fn count_rule_keeps_the_newest_cap_and_spares_protected() {
        let now = SystemTime::now();
        // Cap 2 keeps the two newest ("a", "b"); the rest archive, except the
        // protected file which is counted toward the cap but never archives.
        let candidates = [
            candidate("a", 1, false, now),
            candidate("b", 2, false, now),
            candidate("c", 3, false, now),
            candidate("protected-old", 9, true, now),
        ];
        let doomed = plan_archive(&candidates, &policy(None, Some(2)), now);
        let ids: Vec<&str> = doomed.iter().map(|c| c.session_id.as_str()).collect();
        assert_eq!(ids, vec!["c"]);
        // The protected file beyond the cap stays too: it ranks into the doomed set but the
        // plan spares it.
        let candidates = [
            candidate("a", 1, false, now),
            candidate("b", 2, false, now),
            candidate("c", 3, false, now),
            candidate("protected-oldest", 4, true, now),
        ];
        let doomed = plan_archive(&candidates, &policy(None, Some(2)), now);
        let ids: Vec<&str> = doomed.iter().map(|c| c.session_id.as_str()).collect();
        assert_eq!(ids, vec!["c"]);
    }

    #[test]
    fn count_rule_under_the_cap_archives_nothing() {
        let now = SystemTime::now();
        let candidates = [
            candidate("a", 100, false, now),
            candidate("b", 200, false, now),
        ];
        let doomed = plan_archive(&candidates, &policy(None, Some(5)), now);
        assert!(doomed.is_empty());
    }

    #[test]
    fn both_rules_union_without_duplicates() {
        let now = SystemTime::now();
        // "old" hits the age rule; "b" is beyond the count cap but not aged — both go, oldest
        // first.
        let candidates = [
            candidate("a", 0, false, now),
            candidate("b", 29, false, now),
            candidate("old", 31, false, now),
        ];
        let doomed = plan_archive(&candidates, &policy(Some(30), Some(1)), now);
        let ids: Vec<&str> = doomed.iter().map(|c| c.session_id.as_str()).collect();
        assert_eq!(ids, vec!["old", "b"]);
    }

    #[test]
    fn sweep_moves_doomed_sessions_and_keeps_the_rest() {
        let dir = tempfile::tempdir().expect("temp dir");
        let sessions = dir.path().join("sessions");
        let archive = dir.path().join("archive");
        fs::create_dir_all(&sessions).expect("sessions dir");
        let fresh = write_session(&sessions, "11111111-1111-1111-1111-111111111111");
        let old = write_session(&sessions, "22222222-2222-2222-2222-222222222222");
        set_mtime_days_ago(&old, 40);
        // A malformed jsonl file is not a session: never moved.
        fs::write(sessions.join("junk.jsonl"), "not a session").expect("junk");

        let doomed = block_on(async {
            let never = || false;
            let ownership = SweepOwnership::new(&never, None);
            sweep_sessions(
                &sessions,
                &archive,
                &HashSet::new(),
                &policy(Some(30), None),
                SystemTime::now(),
                &ownership,
            )
            .await
        })
        .expect("sweep");
        assert_eq!(doomed, vec!["22222222-2222-2222-2222-222222222222"]);
        assert!(fresh.is_file(), "fresh session stays");
        assert!(sessions.join("junk.jsonl").is_file(), "junk stays");
        let archived_file = archive.join(session_file_name("22222222-2222-2222-2222-222222222222"));
        assert!(archived_file.is_file(), "aged session archived");
        assert!(!old.is_file(), "aged session left the sessions dir");
    }

    #[test]
    fn sweep_with_both_rules_off_is_a_noop() {
        let dir = tempfile::tempdir().expect("temp dir");
        let sessions = dir.path().join("sessions");
        fs::create_dir_all(&sessions).expect("sessions dir");
        let old = write_session(&sessions, "33333333-3333-3333-3333-333333333333");
        set_mtime_days_ago(&old, 400);
        let doomed = block_on(async {
            let always = || true;
            let ownership = SweepOwnership::new(&always, None);
            sweep_sessions(
                &sessions,
                &dir.path().join("archive"),
                &HashSet::new(),
                &policy(None, None),
                SystemTime::now(),
                &ownership,
            )
            .await
        })
        .expect("sweep");
        assert!(doomed.is_empty());
        assert!(old.is_file());
    }

    #[test]
    fn restore_round_trips_an_archived_session() {
        let dir = tempfile::tempdir().expect("temp dir");
        let sessions = dir.path().join("sessions");
        let archive = dir.path().join("archive");
        fs::create_dir_all(&archive).expect("archive dir");
        let id = "44444444-4444-4444-4444-444444444444";
        let archived = write_session(&archive, id);
        let restored = restore_session(&archive, &sessions, id).expect("restore");
        assert!(restored.is_file());
        assert!(sessions.join(session_file_name(id)).is_file());
        assert!(!archived.is_file(), "left the archive");
        // Restoring again misses: the file is live again.
        assert!(restore_session(&archive, &sessions, id).is_err());
        // A missing id is a typed miss.
        assert!(restore_session(&archive, &sessions, "missing").is_err());
    }

    /// A minimal valid session file: the `session` header line carries the
    /// id, and the file name matches it (the sessions-dir layout).
    fn write_session(dir: &Path, id: &str) -> PathBuf {
        let path = dir.join(session_file_name(id));
        let header = serde_json::json!({
            "type": "session",
            "id": id,
            "cwd": "/work",
            "timestamp": "2026-01-01T00:00:00.000Z",
        });
        fs::write(&path, format!("{header}\n")).expect("write session");
        path
    }

    fn set_mtime_days_ago(path: &Path, days: u64) {
        let mtime = filetime::FileTime::from_unix_time((days * 24 * 60 * 60) as i64, 0);
        filetime::set_file_mtime(path, mtime).expect("set mtime");
    }

    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
            .block_on(fut)
    }

    #[test]
    fn a_sweep_stops_moving_files_once_the_ownership_stop_flips() {
        // Red-first regression for the fence-abort gap: a sweep already
        // inside sweep_sessions must stop moving files the moment the
        // ownership stop flips (the lease-loss fence's flags go up /
        // the daemon begins shutting down) - a successor may have taken
        // the socket between the loop's snapshot and each individual
        // move, and a stale-snapshot move archives a file the
        // successor is serving. The guard flips after the FIRST move;
        // the second aged session must stay in place. Reverting the
        // per-candidate check (the guard called once at entry, or not
        // at all) makes the second file move and the test fails.
        let dir = tempfile::tempdir().expect("temp dir");
        let sessions = dir.path().join("sessions");
        fs::create_dir_all(&sessions).expect("sessions dir");
        let keep_1 = write_session(&sessions, "44444444-4444-4444-4444-444444444444");
        let keep_2 = write_session(&sessions, "55555555-5555-5555-5555-555555555555");
        set_mtime_days_ago(&keep_1, 40);
        set_mtime_days_ago(&keep_2, 40);
        // The flag-check semantics: the field is IS-SHUTTING-DOWN
        // (true = stop). The leaseless test context asks it once per
        // candidate at the pre-check boundary; the flip lands after
        // the first candidate's full commit, so the SECOND candidate
        // parks at its own pre-check boundary.
        let moved = std::sync::atomic::AtomicUsize::new(0);
        let is_shutting_down = || {
            let seen = moved.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            seen >= 1
        };
        let archived = block_on(async {
            let ownership = SweepOwnership::new(&is_shutting_down, None);
            sweep_sessions(
                &sessions,
                &dir.path().join("archive"),
                &HashSet::new(),
                &policy(Some(30), None),
                SystemTime::now(),
                &ownership,
            )
            .await
        })
        .expect("sweep");
        assert_eq!(archived.len(), 1, "only the pre-flip candidate moves");
        assert!(
            keep_1.is_file() || keep_2.is_file(),
            "the post-flip session stays in place"
        );
        // One of the two moved (the flip lands after exactly one
        // candidate check passes), and the other is still live.
        let remaining = if keep_1.is_file() { keep_1 } else { keep_2 };
        assert!(remaining.is_file(), "the post-flip session was NOT moved");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_copy_path_move_unwinds_when_the_stop_flips_after_the_copy() {
        // Red-first regression for the in-flight synchronous move: the
        // cross-filesystem copy can be long and interruptible; the
        // ownership stop must be RE-ASKED between the staged copy and
        // the destructive source removal. A guard that flips during the
        // copy leaves the source in place and unwinds the staged copy
        // (so the next sweep retries cleanly). The cross-device rename
        // failure is produced by staging the destination on the tmpfs
        // at /dev/shm (a different device from the tempdir). The RAII
        // tempdir_in cleans up even on a panic; the Unwound outcome
        // itself proves the copy path ran (a same-device destination
        // would have taken the atomic rename instead).
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir
            .path()
            .join("61616161-6161-6161-6161-616161616161.jsonl");
        fs::write(&source, "session").expect("source");
        let shm = tempfile::tempdir_in("/dev/shm").expect("/dev/shm tempdir");
        let destination = shm
            .path()
            .join("61616161-6161-6161-6161-616161616161.jsonl");
        // The guard's single in-move call (the post-copy re-ask) must
        // refuse - move_file has no pre-move call of its own (the sweep
        // loop's per-candidate check is the pre-check).
        let outcome = move_file(&source, &destination, &|| false).expect("guarded move");
        assert_eq!(
            outcome,
            MoveOutcome::Unwound,
            "the post-copy refusal unwinds"
        );
        assert!(
            source.is_file(),
            "the successor's source survives the refused removal"
        );
        assert!(
            !destination.exists(),
            "the staged copy is unwound so the next sweep retries"
        );
        // The stage must never sit on the final archive name: nothing
        // else is left behind in the staging directory.
        assert_eq!(
            fs::read_dir(shm.path()).expect("read staging dir").count(),
            0,
            "no staging residue remains"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_copy_path_move_completes_when_the_stop_holds() {
        // The same choreography with the guard holding: the staged copy
        // is published no-replace and the destructive source removal
        // runs (the ownership is still ours).
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir
            .path()
            .join("71717171-7171-7171-7171-717171717171.jsonl");
        fs::write(&source, "session").expect("source");
        let shm = tempfile::tempdir_in("/dev/shm").expect("/dev/shm tempdir");
        let destination = shm
            .path()
            .join("71717171-7171-7171-7171-717171717171.jsonl");
        let outcome = move_file(&source, &destination, &|| true).expect("guarded move");
        assert_eq!(outcome, MoveOutcome::Moved);
        assert!(!source.exists(), "the source moved");
        assert!(destination.is_file(), "the destination holds the session");
        // The stage was consumed by the publish: no residue.
        assert_eq!(
            fs::read_dir(shm.path()).expect("read staging dir").count(),
            1,
            "only the published archive entry remains"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_copy_path_publish_never_clobbers_an_existing_archive_entry() {
        // Red-first regression for the staging design: a successor
        // (its own sweep) may already hold the archive name when this
        // daemon's copy finishes. The publish must REFUSE to clobber
        // it (no truncation of its file, no deletion of its entry),
        // leave the live source in place, and unwind the stage.
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir
            .path()
            .join("81818181-8181-8181-8181-818181818181.jsonl");
        fs::write(&source, "ours").expect("source");
        let shm = tempfile::tempdir_in("/dev/shm").expect("/dev/shm tempdir");
        let destination = shm
            .path()
            .join("81818181-8181-8181-8181-818181818181.jsonl");
        fs::write(&destination, "the successor's archived copy").expect("successor entry");
        let outcome = move_file(&source, &destination, &|| true).expect("guarded move");
        assert_eq!(outcome, MoveOutcome::Unwound, "the publish collides");
        assert_eq!(
            fs::read_to_string(&destination).expect("successor entry"),
            "the successor's archived copy",
            "the successor's archive entry is untouched"
        );
        assert!(source.is_file(), "the live source stays in place");
        assert_eq!(
            fs::read_dir(shm.path()).expect("read staging dir").count(),
            1,
            "only the successor's entry remains - the stage was unwound"
        );
    }

    #[test]
    fn a_same_device_move_refuses_to_clobber_a_publishing_successor() {
        // Red-first regression for the dominant same-filesystem path:
        // another archiver (the successor's own sweep) can publish the
        // archive name between the sweep's destination-exists check and
        // the move. The no-replace commit must REFUSE - the successor's
        // bytes and its entry stay untouched, the live source stays in
        // place. Reverting the fast path to a plain rename (which
        // replaces an existing destination) clobbers the entry and
        // fails this test.
        let dir = tempfile::tempdir().expect("temp dir");
        let sessions = dir.path().join("sessions");
        let archive = dir.path().join("archive");
        fs::create_dir_all(&sessions).expect("sessions dir");
        fs::create_dir_all(&archive).expect("archive dir");
        let source = write_session(&sessions, "92929292-9292-9292-9292-929292929292");
        set_mtime_days_ago(&source, 40);
        // The successor's archive entry, published after the sweep's
        // existence check would have seen "no destination".
        let destination = archive.join(session_file_name("92929292-9292-9292-9292-929292929292"));
        fs::write(&destination, "the successor's archived copy").expect("successor entry");
        // Same filesystem (both dirs under the one tempdir), so the
        // commit takes the atomic no-replace path.
        let outcome = commit_no_replace(&source, None, &destination).expect("commit");
        assert_eq!(outcome, MoveOutcome::Unwound, "the collision refuses");
        assert_eq!(
            fs::read_to_string(&destination).expect("successor entry"),
            "the successor's archived copy",
            "the successor's archive entry is untouched"
        );
        assert!(source.is_file(), "the live source stays in place");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_sweep_refuses_a_commit_after_a_takeover_between_checks() {
        // Red-first regression for the takeover window the flags cannot
        // see: the supervisor shutdown flags stay DOWN (the fence has
        // not fired), but a compliant successor takes the lock
        // directory between the sweep's per-candidate flag check and
        // the destructive commit. The commit-time guard must catch it:
        // the lease probe's no-grace compromise verdict (the lock path
        // no longer names the pinned inode) refuses under the
        // reclaim-sidecar exclusion - the successor's live source
        // stays, and nothing of the successor's changes. Reverting the
        // reassert to the flags alone (no lease verdict) moves the
        // file and fails this test.
        let dir = tempfile::tempdir().expect("temp dir");
        let sessions = dir.path().join("sessions");
        let archive = dir.path().join("archive");
        fs::create_dir_all(&sessions).expect("sessions dir");
        fs::create_dir_all(&archive).expect("archive dir");
        let keep_1 = write_session(&sessions, "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1");
        let keep_2 = write_session(&sessions, "b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2");
        set_mtime_days_ago(&keep_1, 40);
        set_mtime_days_ago(&keep_2, 40);
        // A REAL lease on a real socket: the probe is the production
        // reassert machinery, and the takeover is a REAL displacement
        // (the lock directory renamed away, exactly what a successor's
        // reclaim does).
        let socket = dir.path().join("daemon.sock");
        std::fs::write(&socket, "stale").expect("socket");
        let lease = crate::socket::SocketLease::acquire(&socket)
            .await
            .expect("lease");
        let probe = std::sync::Arc::new(lease.probe());
        let lock_path = pa_core::platform::LockDir::path_for(&socket);
        assert!(!probe.compromised(), "the healthy probe is not compromised");
        // The takeover lands between the first candidate's commit and
        // the second's: the flag closure displaces the lock directory
        // once the first candidate is done and keeps returning "flags
        // down" - the shutdown flags NEVER flip; only the lease's
        // no-grace verdict can refuse the second candidate's commit.
        let checks = std::sync::atomic::AtomicUsize::new(0);
        let displaced = dir.path().join("displaced.lock");
        let hook = move || {
            let seen = checks.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if seen >= 2 {
                // The first candidate fully committed (its pre-check and
                // its commit-time reassert are past): displace NOW, in
                // the second candidate's window.
                let _ = std::fs::rename(&lock_path, &displaced);
            }
            false
        };
        let ownership = SweepOwnership::new(&hook, Some(probe.as_ref()));
        let archived = sweep_sessions(
            &sessions,
            &archive,
            &std::collections::HashSet::new(),
            &policy(Some(30), None),
            SystemTime::now(),
            &ownership,
        )
        .await
        .expect("sweep");
        assert_eq!(archived.len(), 1, "the pre-takeover candidate archives");
        // The takeover's live source stays in place.
        let survivor = if keep_1.is_file() { keep_1 } else { keep_2 };
        assert!(
            survivor.is_file(),
            "the post-takeover live source was NOT moved out from under the successor"
        );
        // Only the pre-takeover candidate sits in the archive.
        assert_eq!(
            fs::read_dir(&archive).expect("archive dir").count(),
            1,
            "no stale-snapshot archive entry appears after the takeover"
        );
        lease.shutdown().await.expect("lease shutdown");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_restore_collision_reports_an_error_instead_of_success() {
        // Red-first regression for the restore outcome propagation: a
        // collision on the LIVE name (another actor published it after
        // the existence check) must NOT report success - the archive
        // source still holds the session and the returned destination
        // may not exist. The cross-device may_continue seam publishes
        // the winner between the existence check and the commit.
        let dir = tempfile::tempdir().expect("temp dir");
        let sessions = dir.path().join("sessions");
        fs::create_dir_all(&sessions).expect("sessions dir");
        // Cross-device (the archive on the /dev/shm tmpfs, the
        // sessions dir on disk) so move_file runs the staged path and
        // its post-stage may_continue seam.
        let shm = tempfile::tempdir_in("/dev/shm").expect("/dev/shm tempdir");
        let id = "c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3";
        let archived = write_session(shm.path(), id);
        let destination = sessions.join(session_file_name(id));
        let may_continue = || {
            fs::write(&destination, "the winner's live file").expect("winner");
            true
        };
        let outcome = move_file(&archived, &destination, &may_continue).expect("move");
        assert_eq!(
            outcome,
            MoveOutcome::Unwound,
            "the collided restore refuses"
        );
        assert!(
            archived.is_file(),
            "the archive source still holds the session"
        );
        assert_eq!(
            fs::read_to_string(&destination).expect("winner"),
            "the winner's live file",
            "the winner's live entry is untouched"
        );
        // And restore_session surfaces the same refusal as an error,
        // never a bogus success: preplant the live name and the
        // restore must fail (the archive source stays).
        let id2 = "d4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4";
        let archived2 = write_session(shm.path(), id2);
        fs::write(sessions.join(session_file_name(id2)), "live").expect("live");
        let err = restore_session(shm.path(), &sessions, id2);
        assert!(err.is_err(), "a collided restore reports an error");
        assert!(
            archived2.is_file(),
            "the archive source still holds the refused session"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_real_supervisors_sweep_actually_archives_aged_sessions() {
        // Production-backed red-first regression for the wiring polarity:
        // run_archive_sweep builds its SweepOwnership from the LIVE
        // supervisor. An inverted callback (a "shutting down" probe
        // that returns true on a HEALTHY supervisor) parks the sweep at
        // the first per-candidate check and nothing ever archives -
        // this test drives the real production path end to end
        // (settings policy, sessions dir, registry, ownership wiring)
        // and fails on that inversion.
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let sessions_dir = crate::paths::sessions_dir(&agent_dir).expect("sessions dir");
        std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
        let aged = write_session(&sessions_dir, "e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5");
        set_mtime_days_ago(&aged, 40);
        let supervisor = std::sync::Arc::new(
            crate::supervisor::Supervisor::new(crate::supervisor::SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: agent_dir.clone(),
            })
            .expect("supervisor"),
        );
        assert!(
            !supervisor.is_shutting_down(),
            "the fixture supervisor is healthy"
        );
        run_archive_sweep(&supervisor).await.expect("sweep");
        let archived =
            archive_dir(&agent_dir).join(session_file_name("e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5"));
        assert!(
            archived.is_file(),
            "a healthy supervisor's sweep archives the aged session"
        );
        assert!(!aged.is_file(), "the aged session left the sessions dir");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_canceled_sweep_leaves_no_staged_copy_behind() {
        // Red-first regression for the cancellation window: the fence
        // aborts the sweep task while the reclaim-sidecar acquisition is
        // pending (the test holds the sidecar for the full budget). The
        // cross-device candidate has already STAGED its private copy at
        // that point; a bare PathBuf would leak the stage forever. The
        // RAII guard's `Drop` (the only cleanup that runs on a dropped
        // future) must unlink it.
        let dir = tempfile::tempdir().expect("temp dir");
        let sessions = dir.path().join("sessions");
        fs::create_dir_all(&sessions).expect("sessions dir");
        let shm = tempfile::tempdir_in("/dev/shm").expect("/dev/shm archive");
        let id = "f6f6f6f6-f6f6-f6f6-f6f6-f6f6f6f6f6f6";
        let source = write_session(&sessions, id);
        set_mtime_days_ago(&source, 40);
        // A real lease + probe: the commit guard really acquires the
        // sidecar, and the test blocks it by holding the sidecar file
        // itself - the acquisition spins inside its 500ms budget.
        let socket = dir.path().join("daemon.sock");
        std::fs::write(&socket, "stale").expect("socket");
        let lease = crate::socket::SocketLease::acquire(&socket)
            .await
            .expect("lease");
        let probe = std::sync::Arc::new(lease.probe());
        let lock_path = pa_core::platform::LockDir::path_for(&socket);
        let held_sidecar =
            pa_core::platform::try_reclaim_guard(&lock_path, Duration::from_millis(200));
        assert!(held_sidecar.is_some(), "the test holds the sidecar");
        let sessions_for_task = sessions.clone();
        let staging_dir = shm.path().to_path_buf();
        let archive_for_task = shm.path().to_path_buf();
        let task = tokio::spawn(async move {
            let never_down = || false;
            let ownership = SweepOwnership::new(&never_down, Some(probe.as_ref()));
            sweep_sessions(
                &sessions_for_task,
                &archive_for_task,
                &std::collections::HashSet::new(),
                &policy(Some(30), None),
                SystemTime::now(),
                &ownership,
            )
            .await
        });
        // Wait until the staged copy exists on disk (the long copy is
        // outside every guard), then abort: the commit guard is now
        // spinning on the held sidecar - exactly the cancellation
        // window.
        let mut staged_seen = false;
        for _ in 0..500 {
            let leaked = fs::read_dir(&staging_dir)
                .expect("read staging dir")
                .count();
            if leaked >= 1 {
                staged_seen = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(staged_seen, "the candidate staged its private copy");
        task.abort();
        let _ = task.await;
        // The RAII guard's Drop must have unlinked the stage: only the
        // empty staging directory remains.
        let residue = fs::read_dir(&staging_dir)
            .expect("read staging dir")
            .count();
        assert_eq!(residue, 0, "a canceled sweep leaves no staged copy behind");
        assert!(source.is_file(), "the live source stays in place");
        drop(held_sidecar);
        lease.shutdown().await.expect("lease shutdown");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_symlinked_archive_dir_takes_the_cross_device_path() {
        // Red-first regression for the symlinked archive directory: the
        // archive dir is a SYMLINK onto another filesystem (tmpfs); the
        // device pre-check must FOLLOW the symlink (the target's dev id),
        // or the fast no-replace rename fails EXDEV on every candidate
        // and nothing ever archives.
        let dir = tempfile::tempdir().expect("temp dir");
        let sessions = dir.path().join("sessions");
        fs::create_dir_all(&sessions).expect("sessions dir");
        let shm = tempfile::tempdir_in("/dev/shm").expect("/dev/shm archive backing");
        let archive_symlink = dir.path().join("archive-link");
        std::os::unix::fs::symlink(shm.path(), &archive_symlink).expect("archive symlink");
        let id = "a7a7a7a7-a7a7-a7a7-a7a7-a7a7a7a7a7a7";
        let source = write_session(&sessions, id);
        set_mtime_days_ago(&source, 40);
        let never_down = || false;
        let ownership = SweepOwnership::new(&never_down, None);
        let archived = sweep_sessions(
            &sessions,
            &archive_symlink,
            &std::collections::HashSet::new(),
            &policy(Some(30), None),
            SystemTime::now(),
            &ownership,
        )
        .await
        .expect("sweep");
        assert_eq!(archived.len(), 1, "the symlinked archive still archives");
        assert!(
            shm.path().join(session_file_name(id)).is_file(),
            "the session landed on the symlink's target filesystem"
        );
        assert!(!source.is_file(), "the aged session left the sessions dir");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_failed_stage_unlink_after_publish_does_not_fail_the_move() {
        // Red-first regression for the post-publish residue: the
        // publish linked the staged inode under the destination and the
        // source is already removed - the move HAS landed. If the
        // stage-name unlink then fails (here: the staging parent is
        // read-only), the commit must still report `Moved`: an `Err`
        // would make a successful move look failed (restore reports a
        // nonexistent failure, the sweep undercounts and re-visits the
        // session it already archived).
        let dir = tempfile::tempdir().expect("temp dir");
        let staging = dir.path().join("staging");
        let target = dir.path().join("target");
        fs::create_dir_all(&staging).expect("staging dir");
        fs::create_dir_all(&target).expect("target dir");
        let source = dir.path().join("source.jsonl");
        fs::write(&source, "session").expect("source");
        let stage = staging.join(".archiving-source.jsonl");
        fs::write(&stage, "staged copy").expect("staged copy");
        // Read-only staging parent: the unlink of the stage name will
        // fail even though everything before it succeeded. ROOT (and
        // any DAC-bypassing run) ignores directory permissions, so a
        // writeable probe means the oracle cannot be built there -
        // restore and skip rather than test the wrong thing.
        let mut perms = fs::metadata(&staging).expect("staging perms").permissions();
        perms.set_readonly(true);
        fs::set_permissions(&staging, perms).expect("staging readonly");
        let restore_writable = || {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o755);
            fs::set_permissions(&staging, perms).expect("staging writable again");
        };
        if fs::write(staging.join("dac-probe"), "probe").is_ok() {
            restore_writable();
            eprintln!("skipping: this run bypasses directory permissions");
            return;
        }
        let destination = target.join("source.jsonl");
        let outcome =
            commit_no_replace(&source, Some(StagedFile::new(stage.clone())), &destination)
                .expect("the landed move reports success");
        assert_eq!(outcome, MoveOutcome::Moved);
        assert!(destination.is_file(), "the destination holds the session");
        assert!(!source.exists(), "the source moved");
        assert!(stage.is_file(), "the residue stage remains (logged)");
        // Restore BEFORE the scope ends: the TempDir drop must be able
        // to unlink the residue inside the staging dir.
        restore_writable();
    }
}
