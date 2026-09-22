//! Orphan-process journal: how the host tracks bash() children a kernel left
//! behind, so a killed/crashed kernel cannot leak process groups.
//!
//! The Python runtime journals every `bash()` process group under the kernel
//! pid (`kernelPid`) into the file named by `PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL`;
//! the host reaps those groups when the kernel dies without running its
//! shutdown hook.
//!
//! Ported from `core/orphan-process-journal.ts`.

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
    /// Missing on identity-free records: old journals or host writes whose
    /// start-id query failed. Identity-free records cannot prove the pid still
    /// names the journaled process; on POSIX the group-scoped kill stays
    /// best-effort safe, so they may still be reaped.
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

/// Read the still-active orphan processes recorded by this host process.
pub fn read_active_orphan_processes(path: &Path) -> anyhow::Result<Vec<ActiveOrphanProcess>> {
    let owner_pid = std::process::id() as i64;
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
            && record["pid"].as_i64().map(|p| p > 0).unwrap_or(false)
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

/// True when the record's pid identity still matches the live process, so
/// killing it cannot hit a reused pid.
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

/// Kill a journaled orphan: its process group first (bash() children are
/// group-contained), then the bare pid.
pub fn kill_orphan_process(pid: i32) -> bool {
    crate::platform::process::kill_process_group_or_pid(pid)
}

/// Kill still-active bash() children journaled by the given kernel pid;
/// sibling kernels' records are untouched.
pub fn reap_kernel_orphan_processes(kernel_pid: i32) {
    let Some(path) = journal_path() else {
        return;
    };
    if kernel_pid <= 0 {
        return;
    }
    let Ok(orphans) = read_active_orphan_processes(&path) else {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_start_id_reads_proc() {
        let id = get_process_start_id(std::process::id() as i32);
        let id = id.expect("own pid must be readable");
        assert!(id.starts_with("proc:"));
    }

    #[test]
    fn civil_conversion_known_dates() {
        assert_eq!(civil_from_unix(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(civil_from_unix(1_700_000_000), (2023, 11, 14, 22, 13, 20));
    }
}
