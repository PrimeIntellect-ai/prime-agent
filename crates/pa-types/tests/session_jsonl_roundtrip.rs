//! Round-trip tests over captured session JSONL shapes.
//!
//! The committed corpus in `tests/data/` is the verifier: every line must
//! deserialize into [`FileEntry`] and re-serialize to the same JSON value,
//! including the live-session shapes that once failed the sweep (un-tagged
//! user text blocks) and unknown entry types. Live session files are real
//! user data on the host, so they are only read when explicitly opted in
//! with `PA_TYPES_LIVE_SESSIONS=1`; the default test run is hermetic.

use pa_types::session::FileEntry;
use serde_json::Value;
use std::path::PathBuf;

/// PR #277 made the loader tolerant of foreign spellings: the raw `OpenAI`
/// wire value `tool_calls` deserializes through `StopReason`'s serde alias
/// to the canonical `toolUse`, so a captured foreign line reserializes with
/// the canonical spelling. The corpus keeps the foreign line as captured
/// (it is the record of what the loader must accept), so the comparison
/// canonicalizes that one known alias instead of asserting identity on it.
fn canonicalize_foreign_spelling(mut value: Value) -> Value {
    if let Some(stop_reason) = value
        .get_mut("message")
        .and_then(Value::as_object_mut)
        .and_then(|message| message.get_mut("stopReason"))
    {
        if stop_reason == "tool_calls" {
            *stop_reason = Value::String("toolUse".to_string());
        }
    }
    value
}

fn roundtrip_file(path: &std::path::Path) -> usize {
    let data = std::fs::read_to_string(path).expect("read session file");
    let mut lines = 0usize;
    for (n, line) in data.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed: FileEntry = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("{}:{}: deserialize failed: {e}", path.display(), n + 1));
        let reserialized = serde_json::to_string(&parsed).expect("serialize entry");
        let original: Value = serde_json::from_str(line).unwrap();
        let roundtripped: Value = serde_json::from_str(&reserialized).unwrap();
        assert_eq!(
            canonicalize_foreign_spelling(original),
            roundtripped,
            "{}:{}: round trip changed the value\n  {}\n  {}",
            path.display(),
            n + 1,
            line,
            reserialized
        );
        lines += 1;
    }
    lines
}

#[test]
fn committed_fixture_roundtrips() {
    let mut lines = 0usize;
    for entry in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        lines += roundtrip_file(&path);
    }
    assert!(lines > 0, "no fixture lines found to verify");
}

/// Live sessions are opt-in: they are real user data whose presence and
/// contents vary per machine (and per daemon crash), so a default test run
/// must not depend on them. Set `PA_TYPES_LIVE_SESSIONS=1` (optionally with
/// `PA_TYPES_SESSIONS_DIR` pointing at a sessions tree) to sweep them.
#[test]
fn live_captured_sessions_roundtrip_losslessly() {
    if std::env::var_os("PA_TYPES_LIVE_SESSIONS").as_deref() != Some(std::ffi::OsStr::new("1")) {
        eprintln!("PA_TYPES_LIVE_SESSIONS not set; skipping live-data sweep");
        return;
    }
    let dir = std::env::var_os("PA_TYPES_SESSIONS_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| {
                PathBuf::from(h)
                    .join(".prime")
                    .join("agent")
                    .join("sessions")
            })
        })
        .unwrap_or_else(|| panic!("PA_TYPES_LIVE_SESSIONS=1 but no sessions dir configured"));
    assert!(dir.is_dir(), "sessions dir not found: {}", dir.display());
    let mut files = 0usize;
    let mut lines = 0usize;
    let mut stack = vec![dir];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).expect("read sessions dir");
        for entry in entries {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                lines += roundtrip_file(&path);
                files += 1;
            }
        }
    }
    assert!(files > 0, "no session files found to verify");
    eprintln!("round-tripped {lines} lines across {files} session files");
}
