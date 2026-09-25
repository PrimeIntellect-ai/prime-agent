//! Session archiving: the disk-side retirement mechanism for the sessions
//! directory (roadmap: the directory must not grow forever).
//!
//! Sessions the sweep retires MOVE (never delete) to
//! `<agent-dir>/sessions-archive`, mirroring the sessions-dir layout one file
//! per `<uuid>.jsonl`. Two independent rules (settings `sessionArchive*`,
//! defaults 30 days / 200 sessions; each can be off):
//!
//! - age: a session untouched for `maxAgeDays` days (file mtime) archives;
//! - count: beyond `maxSessions` files, the oldest by mtime archive.
//!
//! Protected sessions (resident workers, sessions with active scheduled
//! jobs) are never archived; the count rule counts them toward the cap but
//! spares them. Restore is the resume path: an archived session resolves
//! through the saved-session catalog and moves back into the sessions
//! directory before its worker spawns, so it is addressable again by every
//! existing selector (TS parity: an archived session stays reachable via
//! `--resume <selector>`).
//!
//! Windows-readiness: paths resolve through `pa_types::platform::home_dir`
//! via the agent dir; moves fall back to copy+delete when rename cannot
//! cross filesystems.

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

/// One sweep over the sessions directory: collect candidates, plan, move
/// the doomed files into the archive. Returns the archived session ids.
/// Idempotent; a move failure skips that file (the next sweep retries).
pub fn sweep_sessions(
    sessions_dir: &Path,
    archive_dir: &Path,
    protected: &HashSet<PathBuf>,
    policy: &SessionArchivePolicy,
    now: SystemTime,
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
        let destination = archive_dir.join(session_file_name(&candidate.session_id));
        if destination.exists() {
            // A same-id file already archived: leave the live file alone
            // rather than clobber history; the id is not a duplicate in
            // practice, so this only guards a corrupted archive.
            continue;
        }
        match move_file(&candidate.path, &destination) {
            Ok(()) => archived.push(candidate.session_id.clone()),
            Err(error) => {
                // A failed move leaves the session in place; the sweep
                // retries on its next pass. Degrade, never fail the batch.
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
    move_file(&source, &destination)?;
    Ok(destination)
}

/// Rename with a copy+delete fallback (rename fails across filesystems).
fn move_file(source: &Path, destination: &Path) -> Result<()> {
    // Either leg ends with the source path gone or the destination
    // replaced: cached append descriptors for both paths are stale.
    let outcome = if let Ok(()) = fs::rename(source, destination) {
        Ok(())
    } else {
        fs::copy(source, destination)
            .with_context(|| format!("copy {} -> {}", source.display(), destination.display()))?;
        fs::remove_file(source).with_context(|| format!("remove {}", source.display()))?;
        Ok(())
    };
    pa_core::session::window::invalidate_cached_append(source);
    pa_core::session::window::invalidate_cached_append(destination);
    outcome
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
        if header.id.is_empty() {
            continue;
        }
        candidates.push(SweepCandidate {
            protected: protected.contains(&canonical_session_path(&path)),
            session_id: header.id,
            path,
            modified,
        });
    }
    Ok(candidates)
}

// ---------------------------------------------------------------------------
// Supervisor sweep seam
// ---------------------------------------------------------------------------

/// Sweep cadence (TS idle-eviction precedent: a boot sweep, then a
/// periodic re-sweep at the TS max sweep interval).
const SWEEP_INTERVAL: Duration = Duration::from_mins(5);
/// The periodic loop sleeps in chunks so a shutdown exits promptly.
const SWEEP_SLEEP_CHUNK: Duration = Duration::from_secs(5);

/// The daemon's archive-sweep loop: one sweep at boot, then every
/// [`SWEEP_INTERVAL`] until the supervisor shuts down. Sweep failures log
/// and retry on the next pass (the sweep is best-effort housekeeping; it
/// must never take the daemon down).
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
/// protected paths (resident workers' session files plus sessions with
/// active scheduled jobs — the disk analogue of the TS idle-eviction
/// `hasRegisteredCronJob` guard), and move the retired sessions into the
/// archive directory.
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
    // must never move (TS `hasRegisteredCronJob` parity for the disk sweep).
    for job in crate::update_roster::scan_scheduled_jobs(&agent_dir) {
        if job.status == pa_core::cron::JobStatus::Active && !job.session_file.is_empty() {
            protected.insert(canonical_session_path(Path::new(&job.session_file)));
        }
    }
    let archived = sweep_sessions(
        &sessions_dir,
        &archive_dir(&agent_dir),
        &protected,
        &policy,
        SystemTime::now(),
    )?;
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
        // The boundary is inclusive: 30 days untouched is archival;
        // the plan reports oldest first.
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
        // Cap 2 keeps the two newest ("a", "b"); the rest archive, except
        // the protected file which is counted toward the cap (it ranks)
        // but never archives.
        let candidates = [
            candidate("a", 1, false, now),
            candidate("b", 2, false, now),
            candidate("c", 3, false, now),
            candidate("protected-old", 9, true, now),
        ];
        let doomed = plan_archive(&candidates, &policy(None, Some(2)), now);
        let ids: Vec<&str> = doomed.iter().map(|c| c.session_id.as_str()).collect();
        assert_eq!(ids, vec!["c"]);
        // The protected file beyond the cap stays too: it ranks into the
        // doomed set but the plan spares it.
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
        // "old" hits the age rule; "b" is beyond the count cap but not
        // aged. Both go, oldest first.
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

        let doomed = sweep_sessions(
            &sessions,
            &archive,
            &HashSet::new(),
            &policy(Some(30), None),
            SystemTime::now(),
        )
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
        let doomed = sweep_sessions(
            &sessions,
            &dir.path().join("archive"),
            &HashSet::new(),
            &policy(None, None),
            SystemTime::now(),
        )
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
}
