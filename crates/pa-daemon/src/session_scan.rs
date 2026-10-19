//! The saved-session roster scan (`list_sessions`), gated by a bounded
//! first-line header read: a parseable non-`session` first record skips the
//! file, while an unparseable or blank first line leaves the fold to decide
//! (TS never invalidates on a parse failure).

use std::cmp::Reverse;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use crate::session_store::{
    parse_session_header_line, persist_info_sidecar, read_first_line_bounded_from,
    read_session_info_from, SessionInfo, SESSION_LIST_HEADER_READ_MAX_BYTES,
};

/// The bounded header read's verdict for one roster file.
enum HeaderGate {
    /// The complete first line is a valid `session` header: the fold fills
    /// the row.
    Header,
    /// A parseable first record that is not the `session` header: TS marks
    /// the file invalid (`acc.invalid`) — skip it without the fold.
    NotAHeader,
    /// The first line does not end within the bound (an over-long header, an
    /// unreadable file): the fold decides.
    Unjudged,
}

fn bounded_header_gate(file: &mut fs::File) -> HeaderGate {
    let Some(line) = read_first_line_bounded_from(file, SESSION_LIST_HEADER_READ_MAX_BYTES) else {
        return HeaderGate::Unjudged;
    };
    let Ok(text) = std::str::from_utf8(&line) else {
        // A full read of the file would fail on the same bytes (`read_to_string`).
        return HeaderGate::NotAHeader;
    };
    if text.trim().is_empty() {
        // A blank first line judges nothing: the fold skips blank lines and
        // may find the header on a later one.
        return HeaderGate::Unjudged;
    }
    // Parse failures never invalidate the file (TS `foldSessionScanLine`):
    // a later `session` header may still produce the row, so the fold decides.
    if serde_json::from_str::<serde_json::Value>(text).is_err() {
        return HeaderGate::Unjudged;
    }
    // A parseable first record that is not the `session` header marks the
    // file invalid (TS `acc.invalid`): the gate skips it without the fold.
    if parse_session_header_line(text).is_some() {
        HeaderGate::Header
    } else {
        HeaderGate::NotAHeader
    }
}

/// One file's roster row: `None` when the file produces none. One open serves
/// the gate and the fold, pinning both to the same inode (a rename racing two
/// handles could judge one file and fold another). A fold the sidecar did not
/// cover backfills it, so the next cold process loads this row cheaply.
fn roster_session_info(path: &Path) -> Option<SessionInfo> {
    let mut file = fs::File::open(path).ok()?;
    match bounded_header_gate(&mut file) {
        HeaderGate::NotAHeader => None,
        HeaderGate::Header | HeaderGate::Unjudged => {
            let (info, sidecar_behind) = read_session_info_from(&mut file, path)?;
            if sidecar_behind {
                persist_info_sidecar(path);
            }
            Some(info)
        }
    }
}

/// One walk over the store: the folded rows, the files after the walk, and
/// the cursor that resumes after the last walked file (`None` at the end).
pub struct SessionPage {
    pub infos: Vec<SessionInfo>,
    pub remaining: usize,
    pub next_cursor: Option<String>,
}

/// The walk order's key: newest mtime first, the file name breaking ties, so
/// the initial snapshot order is total.
type WalkKey = (Reverse<u128>, String);

struct WalkSnapshot {
    session_dir: PathBuf,
    files: Arc<Vec<PathBuf>>,
    last_used: Instant,
}

fn walk_snapshots() -> &'static Mutex<HashMap<String, WalkSnapshot>> {
    static SNAPSHOTS: OnceLock<Mutex<HashMap<String, WalkSnapshot>>> = OnceLock::new();
    SNAPSHOTS.get_or_init(Default::default)
}

fn snapshot_files(session_dir: &Path, cursor: Option<&str>) -> (String, Arc<Vec<PathBuf>>, usize) {
    if let Some((id, offset)) = cursor
        .and_then(|cursor| cursor.strip_prefix("snapshot:"))
        .and_then(|cursor| cursor.split_once(':'))
        .and_then(|(id, offset)| offset.parse::<usize>().ok().map(|offset| (id, offset)))
    {
        let mut snapshots = walk_snapshots()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        snapshots.retain(|_, snapshot| snapshot.last_used.elapsed() < Duration::from_secs(300));
        if let Some(snapshot) = snapshots.get_mut(id) {
            if snapshot.session_dir == session_dir && offset <= snapshot.files.len() {
                snapshot.last_used = Instant::now();
                return (id.to_string(), Arc::clone(&snapshot.files), offset);
            }
        }
    }
    let mut files: Vec<(WalkKey, PathBuf)> = fs::read_dir(session_dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .filter_map(|path| {
            let modified = fs::metadata(&path).and_then(|m| m.modified()).ok()?;
            let modified_ns = modified
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_nanos());
            let name = path.file_name()?.to_string_lossy().into_owned();
            Some(((Reverse(modified_ns), name), path))
        })
        .collect();
    files.sort_unstable();
    (
        uuid::Uuid::new_v4().to_string(),
        Arc::new(files.into_iter().map(|(_, path)| path).collect()),
        0,
    )
}

fn retain_snapshot(id: String, session_dir: &Path, files: Arc<Vec<PathBuf>>) {
    let mut snapshots = walk_snapshots()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    snapshots.retain(|_, snapshot| snapshot.last_used.elapsed() < Duration::from_secs(300));
    if !snapshots.contains_key(&id) && snapshots.len() >= 32 {
        if let Some(oldest) = snapshots
            .iter()
            .min_by_key(|(_, snapshot)| snapshot.last_used)
            .map(|(id, _)| id.clone())
        {
            snapshots.remove(&oldest);
        }
    }
    snapshots.insert(
        id,
        WalkSnapshot {
            session_dir: session_dir.to_path_buf(),
            files,
            last_used: Instant::now(),
        },
    );
}

/// List every valid session file in a directory, most recently modified first.
/// The rich-field fold runs sequentially: a measured parallel fold loses to
/// cross-core cacheline/futex costs on a loaded box (425ms vs 137ms over 1412 files).
#[must_use]
pub fn list_sessions(session_dir: &Path) -> Vec<SessionInfo> {
    list_sessions_with(session_dir, None, None, |_, _, _| true).infos
}

/// [`list_sessions`] as a page with the saved-catalog stream's per-file
/// callback. The first request snapshots the names in mtime order; continuations retain that
/// file order even when sessions change. Expired cursors restart the walk; the TUI deduplicates
/// repeated paths. At most 32 snapshots are kept, expiring after five idle minutes.
/// The fold walks only the files after `cursor`, at most `limit` of
/// them. `on_row` receives rows as each fold completes, so rows reach the
/// client DURING the scan, newest first. `false` stops the scan.
pub fn list_sessions_with(
    session_dir: &Path,
    cursor: Option<&str>,
    limit: Option<usize>,
    mut on_row: impl FnMut(usize, usize, &SessionInfo) -> bool,
) -> SessionPage {
    let (snapshot_id, snapshot, start) = snapshot_files(session_dir, cursor);
    let files = &snapshot[start..];
    let walk = limit.map_or(files.len(), |limit| limit.max(1).min(files.len()));
    let mut infos = Vec::new();
    let mut walked = 0;
    for (index, path) in files[..walk].iter().enumerate() {
        walked = index + 1;
        if let Some(info) = roster_session_info(path) {
            // `false` stops the scan: the consumer is gone, so the remaining
            // folds serve nobody — the scan returns the rows it has.
            if !on_row(index, walk, &info) {
                break;
            }
            infos.push(info);
        }
    }
    let remaining = files.len() - walked;
    let next_cursor = (remaining > 0).then(|| {
        let cursor = format!("snapshot:{snapshot_id}:{}", start + walked);
        retain_snapshot(snapshot_id, session_dir, Arc::clone(&snapshot));
        cursor
    });
    SessionPage {
        infos,
        remaining,
        next_cursor,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::{read_session_info, session_file_name, SessionFile};
    use serde_json::json;
    use std::time::SystemTime;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-daemon-scan-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Write one valid session file with `message_count` user/assistant turns
    /// and return its path. The rewrite stamps the filesystem mtime.
    fn write_session(dir: &Path, cwd: &str, name: Option<&str>, message_count: usize) -> PathBuf {
        let mut session = SessionFile::create(cwd, None, 0);
        if let Some(name) = name {
            session.append_session_info(name);
        }
        for turn in 0..message_count {
            session.append_message(&json!({
                "role": "user", "content": format!("user {turn}"), "timestamp": (turn + 1) as u64
            }));
            session.append_message(&json!({
                "role": "assistant", "content": format!("assistant {turn}"),
                "provider": "p", "model": "m", "timestamp": (turn + 1) as u64
            }));
        }
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        path
    }

    /// The scan this module replaced: sequential folds in directory order, stable-sorted by
    /// mtime. The scan's oracle.
    fn sequential_list_sessions(session_dir: &Path) -> Vec<SessionInfo> {
        let Ok(read) = fs::read_dir(session_dir) else {
            return Vec::new();
        };
        let mut infos: Vec<(SessionInfo, SystemTime)> = read
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
            .filter_map(|path| {
                let modified = fs::metadata(&path).and_then(|m| m.modified()).ok()?;
                read_session_info(&path).map(|info| (info, modified))
            })
            .collect();
        infos.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
        infos.into_iter().map(|(info, _)| info).collect()
    }

    #[test]
    fn rows_match_the_sequential_fold_and_order() {
        let dir = temp_dir();
        write_session(&dir, "/repo/a", Some("alpha"), 3);
        write_session(&dir, "/repo/b", None, 1);
        write_session(&dir, "/repo/c", Some("gamma"), 12);
        let scanned = list_sessions(&dir);
        assert_eq!(scanned, sequential_list_sessions(&dir));
        assert_eq!(scanned.len(), 3);
        assert_eq!(scanned[0].name.as_deref(), Some("gamma"));
    }

    #[test]
    fn empty_dir_lists_nothing() {
        let dir = temp_dir();
        assert!(list_sessions(&dir).is_empty());
    }

    #[test]
    fn missing_dir_lists_nothing() {
        assert!(list_sessions(&temp_dir().join("absent")).is_empty());
    }

    #[test]
    fn skips_a_file_whose_first_parseable_line_is_not_the_session_header() {
        let dir = temp_dir();
        // A session header preceded by a parseable non-session record: TS marks
        // the file invalid (`acc.invalid`) — skipped even though a header follows.
        let mistyped = dir.join("mistyped.jsonl");
        let mut session = SessionFile::create("/repo/mistyped", None, 0);
        session.set_path(mistyped.clone());
        session.rewrite().unwrap();
        let header_line = fs::read_to_string(&mistyped).unwrap();
        fs::write(
            &mistyped,
            format!("{{\"type\":\"message\",\"id\":\"x1\"}}\n{header_line}"),
        )
        .unwrap();
        // An unparseable first line with no header anywhere is no skip either: the fold decides
        // and finds no row.
        let foreign = dir.join("foreign.jsonl");
        fs::write(&foreign, "not a session file at all\n").unwrap();
        assert!(list_sessions(&dir).is_empty());
    }

    #[test]
    fn still_lists_a_file_with_an_unparseable_first_line_and_a_later_header() {
        let dir = temp_dir();
        // TS never invalidates on a parse failure: a truncated or foreign
        // first line must not hide a recoverable session.
        let path = write_session(&dir, "/repo/junk-first", None, 1);
        let content = fs::read_to_string(&path).unwrap();
        fs::write(&path, format!("not a session file at all\n{content}")).unwrap();
        let scanned = list_sessions(&dir);
        assert_eq!(scanned, sequential_list_sessions(&dir));
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].cwd, "/repo/junk-first");
    }

    #[test]
    fn still_lists_a_file_with_a_leading_blank_line() {
        let dir = temp_dir();
        let path = write_session(&dir, "/repo/blank-first", Some("blank"), 1);
        let content = fs::read_to_string(&path).unwrap();
        fs::write(&path, format!("\n{content}")).unwrap();
        let scanned = list_sessions(&dir);
        assert_eq!(scanned, sequential_list_sessions(&dir));
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].name.as_deref(), Some("blank"));
    }

    #[test]
    fn still_lists_a_file_with_an_over_long_header_line() {
        let dir = temp_dir();
        // A cwd long enough to push the serialized header past the 512-byte
        // bound: the bounded read refuses to judge the line, and the row
        // must still come out exactly as the fold produces it.
        let long_cwd = format!("/repo/{}", "x".repeat(600));
        write_session(&dir, &long_cwd, Some("wide"), 1);
        let scanned = list_sessions(&dir);
        assert_eq!(scanned.len(), 1);
        assert_eq!(
            scanned[0],
            read_session_info(&dir.join(session_file_name(&scanned[0].id))).unwrap()
        );
        assert_eq!(scanned[0].cwd, long_cwd);
    }

    #[test]
    // Runs on demand: `cargo test -p pa-daemon --release -- --ignored roster_scan_wall_clock
    // --nocapture`.
    #[ignore = "wall-clock probe, not a correctness test: prints timings of a real sessions dir (PA_ROSTER_BENCH_DIR)"]
    fn roster_scan_wall_clock() {
        let dir = match std::env::var_os("PA_ROSTER_BENCH_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => Path::new(&std::env::var_os("HOME").unwrap_or_default())
                .join(".prime/agent/sessions"),
        };
        let warm = list_sessions(&dir);
        eprintln!("roster_scan_wall_clock: {} rows (warm pass)", warm.len());
        for _ in 0..3 {
            let started = std::time::Instant::now();
            let infos = list_sessions(&dir);
            eprintln!(
                "roster_scan_wall_clock: {} rows in {:?}",
                infos.len(),
                started.elapsed()
            );
        }
    }

    #[test]
    fn list_sessions_with_emits_rows_newest_first_with_scan_counts() {
        let dir = temp_dir();
        let base = SystemTime::now() - std::time::Duration::from_hours(1);
        for (index, name) in ["old row", "mid row", "new row"].iter().enumerate() {
            let path = write_session(&dir, "/repo/x", Some(name), 1);
            let file = fs::File::options().write(true).open(&path).unwrap();
            let modified = base + std::time::Duration::from_secs(60 * (index as u64 + 1));
            file.set_times(std::fs::FileTimes::new().set_modified(modified))
                .unwrap();
        }
        let mut seen: Vec<(usize, usize, Option<String>)> = Vec::new();
        let rows = list_sessions_with(&dir, None, None, |index, total, info| {
            seen.push((index, total, info.name.clone()));
            true
        })
        .infos;
        assert_eq!(rows.len(), 3);
        assert_eq!(seen.len(), 3, "every row emitted as its fold completes");
        assert_eq!(
            seen[0],
            (0, 3, Some("new row".to_string())),
            "the newest row emits first with scan counts 1-of-3 (the entry anchor's row is frame #1): {seen:?}"
        );
        assert_eq!(
            seen.last().map(|(index, total, _)| (*index, *total)),
            Some((2, 3)),
            "the oldest row emits last: {seen:?}"
        );
        assert_eq!(
            seen.iter()
                .map(|(_, _, name)| name.clone())
                .collect::<Vec<_>>(),
            vec![
                Some("new row".to_string()),
                Some("mid row".to_string()),
                Some("old row".to_string()),
            ],
            "the emission order is newest first: {seen:?}"
        );
    }

    #[test]
    fn list_sessions_with_stops_when_the_consumer_stops() {
        let dir = temp_dir();
        write_session(&dir, "/repo/a", Some("first"), 1);
        write_session(&dir, "/repo/b", Some("second"), 1);
        write_session(&dir, "/repo/c", Some("third"), 1);
        let mut emitted = 0usize;
        let rows = list_sessions_with(&dir, None, None, |_, _, _| {
            emitted += 1;
            emitted < 2
        })
        .infos;
        assert_eq!(emitted, 2, "the scan stops at the consumer's false");
        assert_eq!(rows.len(), 1, "only the emitted row returns: {rows:?}");
    }

    #[test]
    fn a_page_cursor_resumes_after_its_file_even_once_that_file_is_deleted() {
        let dir = temp_dir();
        let base = SystemTime::now() - std::time::Duration::from_hours(1);
        let paths: Vec<PathBuf> = (0..5)
            .map(|index| {
                let path = write_session(&dir, "/repo/x", Some(&format!("row {index}")), 1);
                let file = fs::File::options().write(true).open(&path).unwrap();
                let modified = base + std::time::Duration::from_secs(60 * index);
                file.set_times(std::fs::FileTimes::new().set_modified(modified))
                    .unwrap();
                path
            })
            .collect();
        let names = |page: &SessionPage| {
            page.infos
                .iter()
                .map(|info| info.name.clone().unwrap_or_default())
                .collect::<Vec<_>>()
        };
        let first = list_sessions_with(&dir, None, Some(2), |_, _, _| true);
        assert_eq!(names(&first), ["row 4", "row 3"]);
        assert_eq!(first.remaining, 3);
        fs::remove_file(&paths[3]).unwrap();
        let second =
            list_sessions_with(&dir, first.next_cursor.as_deref(), Some(2), |_, _, _| true);
        assert_eq!(names(&second), ["row 2", "row 1"], "no file skipped");
        assert_eq!(second.remaining, 1);
    }
    #[test]
    fn a_session_modified_between_pages_is_not_skipped() {
        let dir = temp_dir();
        let base = SystemTime::now() - Duration::from_secs(3600);
        let paths: Vec<_> = (0..3)
            .map(|index| {
                let path = write_session(&dir, "/repo/x", Some(&format!("row {index}")), 1);
                fs::File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_modified(base + Duration::from_secs(index))
                    .unwrap();
                path
            })
            .collect();
        let first = list_sessions_with(&dir, None, Some(1), |_, _, _| true);
        assert_eq!(first.infos[0].name.as_deref(), Some("row 2"));
        fs::File::options()
            .write(true)
            .open(&paths[0])
            .unwrap()
            .set_modified(SystemTime::now())
            .unwrap();
        let second =
            list_sessions_with(&dir, first.next_cursor.as_deref(), Some(2), |_, _, _| true);
        assert_eq!(
            second
                .infos
                .iter()
                .map(|info| info.name.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("row 1"), Some("row 0")]
        );
        assert!(second.next_cursor.is_none());
        let replay =
            list_sessions_with(&dir, first.next_cursor.as_deref(), Some(2), |_, _, _| true);
        assert_eq!(
            replay.infos, second.infos,
            "retrying a cursor reads the same file slice"
        );
    }
}
