//! Equivalence tests for the streamed session reader: the line-by-line
//! `SessionFile::open` must behave exactly like the whole-body
//! `read_to_string` reader it replaced (the reference below is that old
//! code, verbatim) — invariant-by-test, not by reasoning.

use super::{fold_child_usage_attributions, SessionEntry, SessionFile};
use serde_json::Value;
use std::io::Write;

/// The pre-streaming reference reader: the `read_to_string` + `lines`
/// path the streamed open replaced.
fn whole_file_reference(path: &std::path::Path) -> anyhow::Result<Vec<SessionEntry>> {
    let content = std::fs::read_to_string(path)?;
    let mut lines = content.lines().filter(|line| !line.trim().is_empty());
    let first = lines
        .next()
        .ok_or_else(|| anyhow::anyhow!("empty session file"))?;
    let header_value: Value = serde_json::from_str(first.trim())?;
    if header_value.get("type").and_then(Value::as_str) != Some("session") {
        anyhow::bail!("missing session header");
    }
    let mut entries = Vec::new();
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<SessionEntry>(trimmed) {
            entries.push(entry);
        }
    }
    fold_child_usage_attributions(&mut entries);
    Ok(entries)
}

fn write_session(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pa-stream-{name}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("session.jsonl");
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(bytes).unwrap();
    path
}

fn assert_streamed_equals_reference(name: &str, bytes: &[u8]) {
    let path = write_session(name, bytes);
    let streamed = SessionFile::open(&path).expect("the streamed open succeeds");
    let reference = whole_file_reference(&path).expect("the reference open succeeds");
    let streamed_rows: Vec<String> = streamed
        .entries()
        .iter()
        .map(|entry| serde_json::to_string(entry).unwrap())
        .collect();
    let reference_rows: Vec<String> = reference
        .iter()
        .map(|entry| serde_json::to_string(entry).unwrap())
        .collect();
    assert_eq!(
        streamed_rows, reference_rows,
        "{name}: the streamed open must equal the whole-file reader row for row"
    );
}

#[test]
fn streamed_open_matches_the_whole_file_reader_on_crlf_blank_and_unterminated_files() {
    // CRLF endings, a CR-only blank line, a malformed row skipped
    // mid-file, and no trailing newline: both readers must produce the
    // identical entry sequence.
    let mut bytes = Vec::new();
    bytes.extend_from_slice(
        b"{\"type\":\"session\",\"id\":\"s\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"/tmp\",\"version\":3}\r\n",
    );
    bytes.extend_from_slice(b"\r\n");
    bytes.extend_from_slice(
        b"{\"type\":\"message\",\"id\":\"a\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\r\n",
    );
    bytes.extend_from_slice(b"{not json}\r\n");
    bytes.extend_from_slice(
        b"{\"type\":\"message\",\"id\":\"b\",\"parent_id\":\"a\",\"timestamp\":\"2026-01-01T00:00:02Z\",\"message\":{\"role\":\"assistant\",\"content\":\"hi there\"}}\r\n",
    );
    bytes.extend_from_slice(b" \r\n");
    bytes.extend_from_slice(
        b"{\"type\":\"session_info\",\"id\":\"c\",\"parent_id\":\"b\",\"timestamp\":\"2026-01-01T00:00:03Z\",\"name\":\"wire bytes\"}",
    );
    assert_streamed_equals_reference("crlf-blank-unterminated", &bytes);
}

#[test]
fn streamed_open_matches_the_whole_file_reader_on_unix_files_with_a_trailing_newline() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(
        b"{\"type\":\"session\",\"id\":\"s\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"/tmp\",\"version\":3}\n",
    );
    bytes.extend_from_slice(
        b"{\"type\":\"message\",\"id\":\"a\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"one\"}}\n",
    );
    bytes.extend_from_slice(b"\n");
    bytes.extend_from_slice(
        b"{\"type\":\"message\",\"id\":\"b\",\"parent_id\":\"a\",\"timestamp\":\"2026-01-01T00:00:02Z\",\"message\":{\"role\":\"assistant\",\"content\":\"two\"}}\n",
    );
    assert_streamed_equals_reference("unix-trailing-newline", &bytes);
}

#[test]
fn streamed_open_fails_on_invalid_utf8_like_the_whole_file_read() {
    // The whole-body `read_to_string` failed on invalid UTF-8 anywhere in
    // the file; the streamed read surfaces the same failure as an open
    // error instead of silently skipping the row.
    let mut bytes = Vec::new();
    bytes.extend_from_slice(
        b"{\"type\":\"session\",\"id\":\"s\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"/tmp\",\"version\":3}\n",
    );
    bytes.extend_from_slice(
        b"{\"type\":\"message\",\"id\":\"a\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"\xff\xfe\"}}\n",
    );
    let path = write_session("invalid-utf8", &bytes);
    assert!(
        SessionFile::open(&path).is_err(),
        "invalid UTF-8 must fail the open, not skip the row"
    );
    assert!(whole_file_reference(&path).is_err());
}

#[test]
fn streamed_open_keeps_the_empty_and_missing_header_errors() {
    let empty = write_session("empty", b"");
    assert!(SessionFile::open(&empty).is_err(), "an empty file errors");
    let wrong_header = write_session(
        "wrong-header",
        b"{\"type\":\"message\",\"id\":\"a\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"no header\"}}\n",
    );
    assert!(
        SessionFile::open(&wrong_header).is_err(),
        "a file without a session header errors"
    );
}
