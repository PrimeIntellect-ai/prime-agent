//! Per-worker stderr capture for spawn diagnostics: each session worker's
//! stderr goes to a per-worker log file under the daemon's logs dir
//! (`<agent-dir>/logs/`, the same layout as the supervisor's own rotating
//! log), and a bounded tail of that file rides the not-ready launch errors
//! (the Codex `app-server-daemon` behavior: `pid_start.rs` opens the file,
//! `pid.rs` reads a 4 KiB tail into the "did not become ready" context).
//!
//! Retention rule: the file is truncated at every spawn of its worker, so
//! it holds exactly the current launch's stderr (never the previous
//! attempt's), and the spawn-time prune keeps only the newest
//! [`RETAINED_FILES`] worker logs by modified time, deleting the older
//! ones — but never a log younger than [`PRUNE_PROTECTION_SECS`] and
//! never the just-opened log itself (coarse-mtime ties could sort either
//! into the deletion window). The tail a not-ready error carries is the
//! last [`TAIL_BYTES`] of the file.

use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

/// The stderr tail attached to not-ready launch failures (Codex
/// `STDERR_LOG_TAIL_BYTES`).
const TAIL_BYTES: u64 = 4096;

/// How many worker stderr logs the daemon retains (the spawn-time prune
/// cap; see the module docs for the full retention rule).
const RETAINED_FILES: usize = 64;

/// Logs younger than this are never prune targets: a launch's log must
/// survive from its spawn until the launch settles (the probe and auth
/// fit inside the platform launch budgets — the 30s Unix default, the
/// 90s Windows default, and the e2e override), so one concurrent spawn's
/// prune cannot unlink another's fresh log.
const PRUNE_PROTECTION_SECS: u64 = 120;

/// The worker's stderr log: `worker-<id>.stderr.log` under the daemon's
/// logs dir, the existing state-dir convention the supervisor's own log
/// uses.
pub(crate) fn log_path(agent_dir: &Path, worker_id: &str) -> PathBuf {
    crate::paths::logs_dir(agent_dir).join(format!("worker-{worker_id}.stderr.log"))
}

/// Open the worker's stderr log for a spawn: the file is created (or
/// truncated from a previous launch) so the child starts with an empty
/// log, then the logs dir is pruned to the retention cap. The caller
/// hands the file to the child as its `Stdio::stderr`.
///
/// # Errors
///
/// Returns an error when the logs dir cannot be created or the file
/// cannot be opened for writing: the daemon owns durable state, so a
/// worker whose stderr cannot be captured does not launch detached with
/// its diagnostics silently lost (the Codex `open_stderr_log` rule).
pub(crate) fn open_for_spawn(log_path: &Path) -> Result<File> {
    let logs_dir = log_path
        .parent()
        .context("worker stderr log has no parent dir")?;
    crate::paths::ensure_dir(logs_dir)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(log_path)
        .with_context(|| format!("open worker stderr log {}", log_path.display()))?;
    prune_retained(logs_dir, log_path);
    Ok(file)
}

/// Keep only the newest [`RETAINED_FILES`] worker stderr logs (by modified
/// time) and delete the rest: worker ids are minted per launch, so without
/// the prune every session a daemon ever hosted would leave a log behind.
/// The just-opened log (`keep`) is spared if coarse-mtime ties sort it
/// into the deletion window: the child holds its descriptor, but a later
/// tail read opens by pathname. Logs younger than
/// [`PRUNE_PROTECTION_SECS`] are never prune targets either: concurrent
/// launches each know only their own `keep`, so only their age protects
/// one spawn's fresh log from another spawn's prune. Deletion of the rest
/// is best-effort (a live worker's file may be open; an unlinked file
/// keeps receiving the child's writes until it exits).
fn prune_retained(logs_dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(logs_dir) else {
        return;
    };
    let mut logs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("worker-") && name.ends_with(".stderr.log"))
        })
        .filter_map(|path| {
            let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
            // A future mtime (clock skew) reads as not-yet-elapsed, i.e.
            // protected: a skewed clock must not turn a fresh launch's
            // log into a prune target.
            let fresh = modified.elapsed().map_or(true, |age| {
                age < std::time::Duration::from_secs(PRUNE_PROTECTION_SECS)
            });
            if fresh {
                return None;
            }
            Some((modified, path))
        })
        .collect();
    if logs.len() <= RETAINED_FILES {
        return;
    }
    logs.sort_by_key(|(modified, _)| *modified);
    let excess = logs.len() - RETAINED_FILES;
    let mut deleted = 0;
    for (_, path) in &logs {
        if deleted == excess {
            break;
        }
        if path == keep {
            continue;
        }
        let _ = std::fs::remove_file(path);
        deleted += 1;
    }
}

/// Read the last [`TAIL_BYTES`] of a worker stderr log, dropping the
/// leading partial line when the file is larger than the tail so the tail
/// starts on a line boundary (the Codex `read_log_tail` shape). The read
/// itself is bounded: the not-ready error can fire while the worker is
/// still running (the auth-budget arm), and an unbounded read would let
/// the worker's ongoing stderr output grow the tail past the cap. Returns
/// `Ok(None)` for a missing or empty log.
///
/// # Errors
///
/// Returns an error when the log cannot be opened, inspected, or read and
/// it exists.
fn read_tail(path: &Path) -> Result<Option<String>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("open worker stderr log {}", path.display()));
        }
    };
    let len = file
        .metadata()
        .with_context(|| format!("inspect worker stderr log {}", path.display()))?
        .len();
    if len == 0 {
        return Ok(None);
    }
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .with_context(|| format!("seek worker stderr log {}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read worker stderr log {}", path.display()))?;
    if start > 0 {
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=newline);
        }
    }
    let contents = String::from_utf8_lossy(&bytes).trim_end().to_string();
    if contents.is_empty() {
        return Ok(None);
    }
    Ok(Some(contents))
}

/// Attach the worker's captured stderr tail to a not-ready launch failure
/// so the error names the panic the supervisor only saw as silence (the
/// Codex `append_stderr_log_tail_context` + `PidLogTail::append_to_context`
/// shape). The base error's headline stays the message's first line; the
/// tail rides below it, one indented line per log line. An unreadable log
/// degrades to a note instead of replacing the launch failure, and a
/// silent worker (empty log) keeps its bare headline.
pub(crate) fn not_ready_with_tail(base: anyhow::Error, log_path: &Path) -> anyhow::Error {
    match read_tail(log_path) {
        Ok(Some(tail)) => anyhow!(
            "{base}\n\nsession worker stderr ({}):\n{}",
            log_path.display(),
            tail.lines()
                .map(|line| format!("  {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        Ok(None) => base,
        Err(error) => anyhow!("{base}\n\nfailed to read session worker stderr log: {error:#}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;

    fn write_log(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        // The name may carry a subpath (the truncation test writes into
        // <agent>/logs/): the parent is created, not just the base dir.
        std::fs::create_dir_all(path.parent().expect("log path parent")).expect("create log dir");
        std::fs::write(&path, contents).expect("write log");
        path
    }

    /// Set the file's mtime to the Unix epoch plus `seconds`, so prune
    /// order is deterministic regardless of filesystem timestamp
    /// granularity (the `session_archive` test convention).
    fn backdate(path: &Path, seconds: i64) {
        let mtime = filetime::FileTime::from_unix_time(seconds, 0);
        filetime::set_file_mtime(path, mtime).expect("set mtime");
    }

    #[test]
    fn tail_reads_the_last_4k_from_a_line_boundary() {
        use std::fmt::Write as _;
        let dir = tempfile::tempdir().expect("temp dir");
        // 8 KiB of numbered lines: the tail must be exactly the last
        // TAIL_BYTES worth, minus the leading partial line.
        let mut contents = String::new();
        let mut line_index = 0;
        while contents.len() < 8192 {
            writeln!(contents, "panic trace line {line_index}").expect("write to String");
            line_index += 1;
        }
        let path = write_log(dir.path(), "worker-a.stderr.log", &contents);
        let tail = read_tail(&path)
            .expect("read tail")
            .expect("non-empty tail");
        assert!(tail.len() <= TAIL_BYTES as usize);
        assert!(
            tail.contains(&format!("panic trace line {}", line_index - 1)),
            "holds the newest line"
        );
        // The dropped leading partial line left the tail on a line
        // boundary: every retained line is whole.
        assert!(
            tail.lines()
                .all(|line| line.starts_with("panic trace line")),
            "no partial line: {tail}"
        );
        assert!(tail.starts_with("panic trace line"));
    }

    #[test]
    fn tail_is_none_for_missing_and_empty_logs() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(matches!(
            read_tail(&dir.path().join("absent.stderr.log")),
            Ok(None)
        ));
        let path = write_log(dir.path(), "worker-a.stderr.log", "");
        assert!(matches!(read_tail(&path), Ok(None)));
    }

    #[test]
    fn spawn_open_truncates_a_leftover_log() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        let path = write_log(
            &agent_dir,
            "logs/worker-a.stderr.log",
            "previous launch panic\n",
        );
        assert_eq!(path, log_path(&agent_dir, "a"));
        let file = open_for_spawn(&path).expect("open for spawn");
        drop(file);
        assert_eq!(
            std::fs::read_to_string(&path).expect("reopen log"),
            "",
            "a new launch starts with an empty log"
        );
    }

    #[test]
    fn not_ready_error_carries_the_tail() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write_log(
            dir.path(),
            "worker-a.stderr.log",
            "Error: bind worker socket failed\nthread 'main' panicked\n",
        );
        let error = not_ready_with_tail(anyhow!("session worker a did not come up in time"), &path);
        let message = format!("{error:#}");
        assert!(
            message.starts_with("session worker a did not come up in time"),
            "headline stays first: {message}"
        );
        assert!(
            message.contains(&format!("session worker stderr ({}):", path.display())),
            "names the captured log: {message}"
        );
        assert!(
            message.contains("  Error: bind worker socket failed"),
            "indents the worker's stderr lines: {message}"
        );
        assert!(message.contains("  thread 'main' panicked"));
    }

    #[test]
    fn not_ready_error_keeps_the_bare_headline_for_a_silent_worker() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write_log(dir.path(), "worker-a.stderr.log", "");
        let error = not_ready_with_tail(anyhow!("session worker a did not come up in time"), &path);
        assert_eq!(
            format!("{error:#}"),
            "session worker a did not come up in time"
        );
    }

    #[test]
    fn prune_keeps_the_newest_retained_logs() {
        let dir = tempfile::tempdir().expect("temp dir");
        let logs_dir = dir.path().join("logs");
        // One file per second of age: RETAINED_FILES plus a few excess.
        for index in 0..(RETAINED_FILES + 6) {
            let path = write_log(
                &logs_dir,
                &format!("worker-{index:03}.stderr.log"),
                "worker died\n",
            );
            backdate(&path, index as i64);
        }
        // A foreign file in the logs dir is never pruned (the daemon's
        // own log lives here too).
        let daemon_log = write_log(&logs_dir, "daemon.sock.abcd1234.log", "supervisor line\n");
        // The just-opened log is the pathological case Macroscope flagged:
        // it sorts OLDEST (a coarse-mtime tie would do this), so the prune
        // must spare it from the deletion window instead of unlinking it
        // while the worker still holds its descriptor.
        let keep = logs_dir.join("worker-000.stderr.log");
        prune_retained(&logs_dir, &keep);
        let mut remaining: Vec<String> = std::fs::read_dir(&logs_dir)
            .expect("read logs dir")
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        remaining.sort();
        assert_eq!(remaining.len(), RETAINED_FILES + 1);
        assert!(
            remaining.contains(&"daemon.sock.abcd1234.log".to_string()),
            "the supervisor's own log is not a prune target"
        );
        let worker_logs: Vec<&String> = remaining
            .iter()
            .filter(|name| name.starts_with("worker-"))
            .collect();
        assert_eq!(worker_logs.len(), RETAINED_FILES);
        assert!(
            remaining.contains(&"worker-000.stderr.log".to_string()),
            "the just-opened log survives even when it sorts into the deletion window"
        );
        assert!(
            worker_logs.iter().all(|name| {
                let index: i64 = name
                    .trim_start_matches("worker-")
                    .trim_end_matches(".stderr.log")
                    .parse()
                    .expect("numbered log");
                index == 0 || index >= 7
            }),
            "the oldest logs (past the spared keep) were the ones pruned: {remaining:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&daemon_log).expect("daemon log readable"),
            "supervisor line\n",
            "foreign logs are only listed, never rewritten"
        );
    }

    #[test]
    fn prune_spares_a_fresh_burst_of_launches() {
        let dir = tempfile::tempdir().expect("temp dir");
        let logs_dir = dir.path().join("logs");
        // A same-tick launch burst: every log carries the current
        // modified time, so every one is inside the prune-protection
        // window and no spawn's prune may touch another's fresh log.
        for index in 0..(RETAINED_FILES + 6) {
            write_log(
                &logs_dir,
                &format!("worker-{index:03}.stderr.log"),
                "worker died\n",
            );
        }
        prune_retained(&logs_dir, Path::new("absent-keep"));
        let fresh = std::fs::read_dir(&logs_dir).expect("read logs dir").count();
        assert_eq!(fresh, RETAINED_FILES + 6, "a fresh burst is not pruned");
        // The burst ages past the window: the same prune collapses it to
        // the retention cap.
        for index in 0..(RETAINED_FILES + 6) {
            backdate(&logs_dir.join(format!("worker-{index:03}.stderr.log")), 0);
        }
        prune_retained(&logs_dir, Path::new("absent-keep"));
        let aged = std::fs::read_dir(&logs_dir).expect("read logs dir").count();
        assert_eq!(aged, RETAINED_FILES, "an aged burst collapses to the cap");
    }
}
