//! Full-text search over saved sessions: the ids of the session files whose user or assistant
//! message text contains a query, case-insensitively.

use std::path::Path;

use serde_json::Value;

use crate::session_store::parse_session_header_line;

/// The durable ids of the sessions in `session_dir` whose user or assistant message text
/// contains `query` (case-insensitive). An empty query matches nothing.
#[must_use]
pub(crate) fn search_session_content(session_dir: &Path, query: &str) -> Vec<String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(session_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .filter_map(|path| matching_session_id(&path, &needle))
        .collect()
}

/// The session's header id when one of its messages matches the lowercased `needle`.
fn matching_session_id(path: &Path, needle: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let id = parse_session_header_line(lines.next()?)?.id;
    // JSON writes such a needle verbatim, so a raw-line check skips most lines without a parse;
    // a needle with a space could span two text blocks, which the joined text separates by one.
    let prefilter = needle.is_ascii()
        && !needle.contains(['"', '\\', ' '])
        && !needle.contains(char::is_control);
    lines
        .filter(|line| line.contains(r#""type":"message""#))
        .filter(|line| !prefilter || line.to_ascii_lowercase().contains(needle))
        .any(|line| message_matches(line, needle))
        .then_some(id)
}

fn message_matches(line: &str, needle: &str) -> bool {
    let Ok(entry) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    let Some(message) = entry.get("message") else {
        return false;
    };
    matches!(
        crate::types::message_role(message),
        Some("user" | "assistant")
    ) && crate::types::message_text(message)
        .to_lowercase()
        .contains(needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt::Write as _;

    fn write_session(dir: &Path, id: &str, messages: &[(&str, Value)]) {
        let mut content = format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}}\n"
        );
        for (index, (role, body)) in messages.iter().enumerate() {
            let entry = serde_json::json!({
                "type": "message",
                "id": format!("{id}-{index}"),
                "parentId": null,
                "timestamp": "2024-01-01T00:00:00.000Z",
                "message": { "role": role, "content": body, "timestamp": 0 },
            });
            let _ = writeln!(content, "{entry}");
        }
        std::fs::write(dir.join(format!("{id}.jsonl")), content).unwrap();
    }

    #[test]
    fn matches_user_and_assistant_text_case_insensitively_and_skips_tool_output() {
        let dir = tempfile::tempdir().unwrap();
        write_session(
            dir.path(),
            "user-hit",
            &[("user", serde_json::json!("Bump the Backoff ceiling"))],
        );
        write_session(
            dir.path(),
            "assistant-hit",
            &[(
                "assistant",
                serde_json::json!([{ "type": "text", "text": "the BACKOFF is 30s" }]),
            )],
        );
        write_session(
            dir.path(),
            "tool-only",
            &[
                ("user", serde_json::json!("run the tests")),
                ("toolResult", serde_json::json!("backoff ceiling hit")),
            ],
        );
        write_session(
            dir.path(),
            "unicode-hit",
            &[("user", serde_json::json!("Réessayer après ÉCHEC"))],
        );
        let mut hits = search_session_content(dir.path(), "backoff");
        hits.sort();
        assert_eq!(hits, ["assistant-hit", "user-hit"]);
        assert_eq!(search_session_content(dir.path(), "échec"), ["unicode-hit"]);
    }
}
