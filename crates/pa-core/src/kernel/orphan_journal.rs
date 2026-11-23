//! Orphan-process journal: the runtime journals every `bash()` process group
//! under the kernel pid into the file named by
//! `PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL`; the host reaps those
//! groups when a killed/crashed kernel cannot run its own shutdown hook.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::json;

/// Environment variable naming the journal file.
pub const ORPHAN_PROCESS_JOURNAL_ENV: &str = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveOrphanProcess {
    pub pid: i32,
    pub kernel_pid: Option<i32>,
    /// Missing on identity-free records: old journalsthe POSIX group-scoped kill stays best-effort
    /// safe.
    pub process_start_id: Option<String>,
}

fn journal_path() -> Option<std::path::PathBuf> {
    let path = std::env::var(ORPHAN_PROCESS_JOURNAL_ENV).ok()?;
    if path.is_empty() {
        return None;
    }
    Some(PathBuf::from(path))
}

/// Pid-reuse identity (`proc:<starttime>`), shared with pa-daemon through
/// `pa_types::platform::process`.
#[must_use]
pub fn get_process_start_id(pid: i32) -> Option<String> {
    if pid <= 0 {
        return None;
    }
    pa_types::platform::process::process_start_id(pid as u32)
}

/// Record a process as active/inactive in the journal. Best-effort: process
/// tracking must never make a successfully spawned command fail.
pub fn record_orphan_process_state(pid: i32, active: bool) {
    let Some(path) = journal_path() else {
        return;
    };
    if pid <= 0 {
        return;
    }
    let process_start_id = if active {
        get_process_start_id(pid)
    } else {
        None
    };
    let record = json!({
        "version": 1,
        "pid": pid,
        "ownerPid": std::process::id(),
        "active": active,
        "recordedAt": iso8601_now(),
    });
    let record = match process_start_id {
        Some(id) => {
            let mut map = record;
            map["processStartId"] = json!(id);
            map
        }
        None => record,
    };
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    crate::platform::perms::set_private_mode(&mut options);
    let Ok(mut file) = options.open(&path) else {
        return;
    };
    let _ = writeln!(file, "{record}");
    let _ = file.sync_all();
}

fn iso8601_now() -> String {
    // RFC3339 UTC timestamp with second precision; the field is informational.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let (year, month, day, hh, mm, ss) = civil_from_unix(secs);
    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    // Howard Hinnant's civil_from_days algorithm.
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    );
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d, hh, mm, ss)
}

/// Read the still-active orphan processes a journal recorded for one owner
/// pid — the host reads its own pid; the supervisor reads a dead worker's.
///
/// # Errors
///
/// Returns an error when the journal file cannot be read (a missing file is an empty record).
///
/// # Panics
///
/// The `pid` unwrap is unreachable behind the validity filter.
pub fn read_active_orphan_processes(
    path: &Path,
    owner_pid: i64,
) -> anyhow::Result<Vec<ActiveOrphanProcess>> {
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut latest: HashMap<i64, serde_json::Value> = HashMap::new();
    for line in contents.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
            // A crash can truncate only the final append.
            continue;
        };
        let valid = record["version"] == 1
            && record["pid"].as_i64().is_some_and(|p| p > 0)
            && record["ownerPid"].as_i64() == Some(owner_pid)
            && record["active"].is_boolean()
            && record["recordedAt"].is_string();
        if valid {
            latest.insert(record["pid"].as_i64().unwrap(), record);
        }
    }
    let mut out: Vec<ActiveOrphanProcess> = latest
        .into_values()
        .filter(|record| record["active"].as_bool() == Some(true))
        .map(|record| ActiveOrphanProcess {
            pid: record["pid"].as_i64().unwrap() as i32,
            kernel_pid: record["kernelPid"].as_i64().map(|p| p as i32),
            process_start_id: record["processStartId"].as_str().map(str::to_string),
        })
        .collect();
    out.sort_by_key(|o| o.pid);
    Ok(out)
}

/// The worker journal's active shell records — a `kernelPid` distinguishes
/// the runtime's `bash()` records from the host's own kernel-process
/// records. The parse half of the continuation gates' durable term
/// ([`LiveBackgroundShellJournal`]); the liveness filter runs on every
/// read, never on the cache (a record alive at one boundary may die before
/// the next).
fn read_active_shell_records(path: &Path, owner_pid: i64) -> Vec<ActiveOrphanProcess> {
    let Ok(orphans) = read_active_orphan_processes(path, owner_pid) else {
        return Vec::new();
    };
    orphans
        .into_iter()
        .filter(|orphan| {
            let Some(kernel_pid) = orphan.kernel_pid else {
                return false;
            };
            orphan.pid > 0 && orphan.pid != kernel_pid
        })
        .collect()
}

/// Whether an active shell record's pid still names the same live process
/// (the recorded start-id matches; a record without one has a live pid —
/// the same best-effort trust the reaper applies).
fn shell_record_still_live(orphan: &ActiveOrphanProcess) -> bool {
    match orphan.process_start_id.as_deref() {
        // A matching recorded identity proves liveness; a mismatch is a
        // recycled pid.
        Some(_) => is_orphan_process_identity_current(orphan),
        None => crate::platform::process::pid_exists(orphan.pid as u32),
    }
}

/// The journal stamp (file size, mtime nanos) a memoized parse keys on.
type JournalStamp = (u64, u128);

/// A memoized durable-term read for the per-boundary continuation consults
/// (goal and `/autonomous`): a kernel lost without graceful cleanup leaves
/// its shells alive with durable active records but no in-memory registry
/// entry, and their `[bash-done]` notice died with the kernel. The
/// append-only journal parses only when its `(size, mtime)` changed —
/// always-on sessions pay one parse per shell event, not one per turn
/// end — while the liveness filter re-probes every call (a shell that
/// dies without touching the journal must still drop out of the count).
pub struct LiveBackgroundShellJournal {
    path: PathBuf,
    owner_pid: i64,
    parsed: std::sync::Mutex<Option<(JournalStamp, Vec<ActiveOrphanProcess>)>>,
}

impl LiveBackgroundShellJournal {
    /// The journal at `path`, read for `owner_pid`'s shell records.
    #[must_use]
    pub fn new(path: impl Into<PathBuf>, owner_pid: i64) -> Self {
        Self {
            path: path.into(),
            owner_pid,
            parsed: std::sync::Mutex::new(None),
        }
    }

    /// The still-live shell records (the recorded pid still names the same
    /// process): a fresh parse when the journal changed, the cached records
    /// otherwise, and the liveness filter always.
    pub fn live_shells(&self) -> Vec<ActiveOrphanProcess> {
        let Ok(metadata) = std::fs::metadata(&self.path) else {
            return Vec::new();
        };
        let stamp = (
            metadata.len(),
            metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos()),
        );
        let records = {
            let mut cached = match self.parsed.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            if let Some((cached_stamp, records)) = cached.as_ref() {
                if *cached_stamp == stamp {
                    return records
                        .iter()
                        .filter(|orphan| shell_record_still_live(orphan))
                        .cloned()
                        .collect();
                }
            }
            let records = read_active_shell_records(&self.path, self.owner_pid);
            *cached = Some((stamp, records.clone()));
            records
        };
        records
            .into_iter()
            .filter(shell_record_still_live)
            .collect()
    }
}

/// True when the record's pid identity still matches the live process, so
/// killing it cannot hit a reused pid.
#[must_use]
pub fn is_orphan_process_identity_current(orphan: &ActiveOrphanProcess) -> bool {
    match &orphan.process_start_id {
        None => false,
        Some(recorded) => get_process_start_id(orphan.pid).as_deref() == Some(recorded.as_str()),
    }
}

fn should_reap(orphan: &ActiveOrphanProcess) -> bool {
    match orphan.process_start_id {
        // Identity-free records: POSIX keeps the best-effort kill.
        None => true,
        Some(_) => is_orphan_process_identity_current(orphan),
    }
}

/// Kill a journaled orphan: its process group first (`bash()` children are
/// group-contained), then the bare pid.
#[must_use]
pub fn kill_orphan_process(pid: i32) -> bool {
    crate::platform::process::kill_process_group_or_pid(pid)
}

/// Kill still-active `bash()` children journaled by the given kernel pid;
/// sibling kernels' records are untouched.
pub fn reap_kernel_orphan_processes(kernel_pid: i32) {
    let Some(path) = journal_path() else {
        return;
    };
    if kernel_pid <= 0 {
        return;
    }
    let Ok(orphans) = read_active_orphan_processes(&path, i64::from(std::process::id())) else {
        return;
    };
    for orphan in orphans {
        if orphan.kernel_pid != Some(kernel_pid) || orphan.pid == kernel_pid {
            continue;
        }
        if !should_reap(&orphan) {
            continue;
        }
        if kill_orphan_process(orphan.pid) {
            record_orphan_process_state(orphan.pid, false);
        }
    }
}

/// Kill the still-active `bash()` process groups a dead worker's kernels
/// journaled, then clear the journal (TS `recoverUncertainWorkerOperations`'
/// orphan sweep, owner-scoped to the worker's own pid). The journal is
/// kept only when a kill failed and every record carried an identity, so
/// the next recovery pass can safely retry.
pub fn reap_worker_orphan_processes(path: &Path, worker_pid: i32) {
    if worker_pid <= 0 {
        return;
    }
    let Ok(orphans) = read_active_orphan_processes(path, i64::from(worker_pid)) else {
        return;
    };
    let mut reap_failed = false;
    let mut retry_is_safe = true;
    for orphan in orphans {
        if orphan.process_start_id.is_none() {
            retry_is_safe = false;
        }
        if !should_reap(&orphan) {
            continue;
        }
        if !kill_orphan_process(orphan.pid) {
            reap_failed = true;
        }
    }
    if !reap_failed || !retry_is_safe {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_start_id_reads_the_platform_ladder() {
        // Linux answers from /proc (`proc:`); macOS/BSD answer
        // `ps:<lstart>` - the same ladder TS `getProcessStartId` walks.
        let id = get_process_start_id(std::process::id() as i32);
        let id = id.expect("own pid must be readable");
        assert!(id.starts_with("proc:") || id.starts_with("ps:"));
    }

    #[test]
    fn civil_conversion_known_dates() {
        assert_eq!(civil_from_unix(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(civil_from_unix(1_700_000_000), (2023, 11, 14, 22, 13, 20));
    }

    /// The worker reap's journal-clearing rule for the records a live-reap
    /// e2e cannot stage: a dead pid journaled identity-free (the kill is
    /// attempted; whether it fails or hits a reused pid, a blind retry is
    /// unsafe, so the journal is spent) and the same pid journaled with a
    /// stale identity (the start-id check never reaps a reused pid).
    #[test]
    fn worker_reap_spends_stale_and_identity_free_records() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("w.orphans.jsonl");
        let owner = i64::from(std::process::id());
        let mut child = std::process::Command::new("sleep")
            .arg("0")
            .spawn()
            .expect("spawn short-lived child");
        let dead_pid = child.id() as i32;
        let _ = child.wait();
        let identity_free = json!({
            "version": 1,
            "pid": dead_pid,
            "ownerPid": owner,
            "active": true,
            "recordedAt": iso8601_now(),
        });
        let stale_identity = json!({
            "version": 1,
            "pid": dead_pid,
            "ownerPid": owner,
            "active": true,
            "processStartId": "proc:1",
            "recordedAt": iso8601_now(),
        });
        for record in [identity_free, stale_identity] {
            // Separate sweeps: the reader retains only the latest row per pid.
            std::fs::write(&path, format!("{record}\n")).expect("write journal");
            let active = read_active_orphan_processes(&path, owner).expect("read journal");
            assert_eq!(active.len(), 1);
            assert_eq!(
                active[0].process_start_id.as_deref(),
                record["processStartId"].as_str()
            );
            reap_worker_orphan_processes(&path, owner as i32);
            assert!(
                !path.exists(),
                "the journal is spent, not kept for a blind retry"
            );
        }
    }

    /// The continuation gates' durable term: only the runtime's shell
    /// records (a `kernelPid`) whose pid still names the same live process
    /// count. A kernel lost without graceful cleanup leaves exactly these
    /// behind: alive, durable, and invisible to the replacement kernel's
    /// empty registry.
    #[test]
    fn live_shell_reader_counts_only_live_shell_records() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("w.orphans.jsonl");
        let owner = i64::from(std::process::id());
        let dead_kernel_pid = 999_999_i32;
        let mut live_shell = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn live shell");
        let live_identity =
            get_process_start_id(live_shell.id() as i32).expect("live shell identity");
        let mut dead_shell = std::process::Command::new("sleep")
            .arg("0")
            .spawn()
            .expect("spawn dead shell");
        let dead_pid = dead_shell.id() as i32;
        let _ = dead_shell.wait();
        let live_pid = i64::from(live_shell.id());
        let records = [
            // The live shell: counted.
            json!({
                "version": 1, "pid": live_pid, "ownerPid": owner,
                "kernelPid": dead_kernel_pid, "active": true,
                "processStartId": live_identity, "recordedAt": iso8601_now(),
            }),
            // A dead shell's record: not counted (the recorded identity no
            // longer matches the gone pid).
            json!({
                "version": 1, "pid": i64::from(dead_pid), "ownerPid": owner,
                "kernelPid": dead_kernel_pid, "active": true,
                "processStartId": "proc:1", "recordedAt": iso8601_now(),
            }),
            // The host's own kernel-process record (no kernelPid): never a
            // shell, not counted even though the pid is alive.
            json!({
                "version": 1, "pid": i64::from(std::process::id()), "ownerPid": owner,
                "active": true, "recordedAt": iso8601_now(),
            }),
            // A settled shell's inactive record: not counted.
            json!({
                "version": 1, "pid": i64::from(dead_pid), "ownerPid": owner,
                "kernelPid": dead_kernel_pid, "active": false,
                "recordedAt": iso8601_now(),
            }),
        ];
        std::fs::write(
            &path,
            records
                .iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .expect("write journal");
        let live = LiveBackgroundShellJournal::new(&path, owner).live_shells();
        assert_eq!(live.len(), 1, "only the live shell counts: {live:?}");
        assert_eq!(live[0].pid, live_shell.id() as i32);
        // The identity-free arm: the runtime writes no start-id when its
        // probe failed at spawn; a live pid still counts.
        let mut identity_free_shell = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn identity-free shell");
        std::fs::write(
            &path,
            records
                .iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
                + &json!({
                    "version": 1, "pid": i64::from(identity_free_shell.id()),
                    "ownerPid": owner, "kernelPid": dead_kernel_pid, "active": true,
                    "recordedAt": iso8601_now(),
                })
                .to_string()
                + "\n",
        )
        .expect("write journal");
        let live = LiveBackgroundShellJournal::new(&path, owner).live_shells();
        assert_eq!(
            live.len(),
            2,
            "the identity-free live shell counts: {live:?}"
        );
        // The memoized per-boundary read: the journal re-parses when the
        // file changes and the liveness filter re-probes every call (a
        // shell dying without touching the journal drops out).
        let reader = LiveBackgroundShellJournal::new(&path, owner);
        assert_eq!(reader.live_shells().len(), 2);
        let _ = identity_free_shell.kill();
        let _ = identity_free_shell.wait();
        assert_eq!(
            reader.live_shells().len(),
            1,
            "a shell that died without touching the journal must drop from the count"
        );
        // The recycled-pid form: a live pid whose recorded identity is
        // wrong never counts.
        std::fs::write(
            &path,
            format!(
                "{}\n",
                json!({
                    "version": 1, "pid": live_pid, "ownerPid": owner,
                    "kernelPid": dead_kernel_pid, "active": true,
                    "processStartId": "proc:1", "recordedAt": iso8601_now(),
                })
            ),
        )
        .expect("write journal");
        assert!(
            LiveBackgroundShellJournal::new(&path, owner)
                .live_shells()
                .is_empty(),
            "a recycled pid's record must not count"
        );
        let _ = live_shell.kill();
        let _ = live_shell.wait();
    }
}
