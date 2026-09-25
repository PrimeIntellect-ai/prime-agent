//! The saved-session roster scan (`list_sessions`): the listing loop gated
//! by a bounded first-line header read (the `isValidSessionFile`
//! precedent). A file whose complete first line is not a session header is
//! skipped without its fold; the rows stay the fold's own values: a
//! perf-only reshape, the row contract is the fold's (now the #2713
//! resumable scan: the gate runs first, then `read_session_info`).

use std::fs;
use std::path::Path;
use std::time::SystemTime;

use crate::session_store::{
    parse_session_header_line, read_first_line_bounded, read_session_info, SessionInfo,
    SESSION_LIST_HEADER_READ_MAX_BYTES,
};

/// The bounded header read's verdict for one roster file.
enum HeaderGate {
    /// The complete first line is a valid `session` header: the fold fills
    /// the row.
    Header,
    /// The complete first line is not a session header. Harness-written
    /// session files lead with their header (`session_header_line` writes it
    /// first), so the file is not a session: skip it without the fold.
    NotAHeader,
    /// The first line does not end within the bound (an over-long header, an
    /// unreadable file): the bounded read cannot judge the file, the fold
    /// decides.
    Unjudged,
}

fn bounded_header_gate(path: &Path) -> HeaderGate {
    let Some(line) = read_first_line_bounded(path, SESSION_LIST_HEADER_READ_MAX_BYTES) else {
        return HeaderGate::Unjudged;
    };
    let Ok(text) = std::str::from_utf8(&line) else {
        // A full read of the file would fail on the same bytes
        // (`read_to_string`).
        return HeaderGate::NotAHeader;
    };
    if text.trim().is_empty() {
        // A blank first line judges nothing: the fold skips blank lines and
        // may find the header on a later one (TS skips blank lines the same
        // way), so the fold decides.
        return HeaderGate::Unjudged;
    }
    if parse_session_header_line(text).is_some() {
        HeaderGate::Header
    } else {
        HeaderGate::NotAHeader
    }
}

/// One file's roster row: `None` when the file produces none.
fn roster_session_info(path: &Path) -> Option<SessionInfo> {
    match bounded_header_gate(path) {
        HeaderGate::NotAHeader => None,
        HeaderGate::Header | HeaderGate::Unjudged => read_session_info(path),
    }
}

/// List every valid session file in a directory, most recently modified first
/// (port of `SessionManager.listAll`): the directory read supplies the rows'
/// identity keys (entry order, mtime), the bounded header gate skips foreign
/// files without their fold, and the rich-field fold runs sequentially -
/// a measured parallel fold loses to cross-core cacheline/futex costs on a
/// loaded multi-core box (425ms vs 137ms over 1412 files), so the fold stays
/// the loop the scan replaced.
pub fn list_sessions(session_dir: &Path) -> Vec<SessionInfo> {
    let Ok(read) = fs::read_dir(session_dir) else {
        return Vec::new();
    };
    let mut infos: Vec<(SessionInfo, SystemTime)> = read
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .filter_map(|path| {
            let modified = fs::metadata(&path).and_then(|m| m.modified()).ok()?;
            roster_session_info(&path).map(|info| (info, modified))
        })
        .collect();
    infos.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    infos.into_iter().map(|(info, _)| info).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::{session_file_name, SessionFile};
    use serde_json::json;
    use std::path::PathBuf;

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
            session.append_message(json!({
                "role": "user", "content": format!("user {turn}"), "timestamp": (turn + 1) as u64
            }));
            session.append_message(json!({
                "role": "assistant", "content": format!("assistant {turn}"),
                "provider": "p", "model": "m", "timestamp": (turn + 1) as u64
            }));
        }
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        path
    }

    /// The scan this module replaced: sequential folds collected in
    /// directory order, stable-sorted by mtime. The scan's oracle.
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
    fn skips_a_file_whose_first_line_is_not_a_session_header() {
        let dir = temp_dir();
        write_session(&dir, "/repo/a", None, 1);
        let foreign = dir.join("foreign.jsonl");
        fs::write(&foreign, "not a session file at all\n").unwrap();
        let mistyped = dir.join("mistyped.jsonl");
        fs::write(
            &mistyped,
            r#"{"type":"message","id":"x1","timestamp":"t"}\n"#,
        )
        .unwrap();
        let scanned = list_sessions(&dir);
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].cwd, "/repo/a");
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
    // A wall-clock probe, not a correctness test: it only prints timings of a
    // real sessions dir (PA_ROSTER_BENCH_DIR), so it runs on demand with
    // `cargo test -p pa-daemon --release -- --ignored roster_scan_wall_clock --nocapture`.
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
}
