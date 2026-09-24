//! Descriptive session-open failures (operator-directed product
//! improvement): when a session refuses to open because another holder
//! owns it, the error names the holder and suggests what to do next.
//!
//! The TS refusal (`SessionAlreadyActiveError`) stops at the holder id:
//! "Session is already active in {id}: {path}". The Rust product keeps
//! that first line byte-identical (the print-mode e2e and the daemon wire
//! shape both pin it) and appends the holder's identity and next steps —
//! a sanctioned divergence documented per the #289 precedent.

use serde_json::Value;
use std::path::Path;

/// The live session holding a session file (one roster row's fields).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionHolder {
    /// The holder's active session id (the attach selector).
    pub id: String,
    /// The session's display name, when the row carries one.
    pub name: Option<String>,
    /// The session's working directory, when the row carries one.
    pub cwd: Option<String>,
    /// The session's model label, when the row carries one.
    pub model: Option<String>,
}

/// Find the roster row currently hosting `session_path`: the first row
/// whose `sessionFile` canonicalizes to the same file. Rows without a
/// matching file are skipped, so unrelated sessions never answer.
pub fn holder_from_roster(rows: &[Value], session_path: &Path) -> Option<SessionHolder> {
    let target = canonical_form(session_path);
    rows.iter().find_map(|row| {
        let file = row.get("sessionFile").and_then(Value::as_str)?;
        if canonical_form(Path::new(file)) != target {
            return None;
        }
        let id = row
            .get("activeSessionId")
            .or_else(|| row.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())?;
        Some(SessionHolder {
            id: single_line(id),
            name: row
                .get("sessionName")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .map(single_line),
            cwd: row.get("cwd").and_then(Value::as_str).map(single_line),
            // Live roster rows carry `model` as `{id, provider}` (the
            // worker's `get_state` summary); a display string is accepted
            // for the mock/older shapes.
            model: row
                .get("model")
                .and_then(model_label)
                .as_deref()
                .map(single_line),
        })
    })
}

/// One roster-controlled field flattened to a single line: line breaks
/// collapse to spaces so a renamed session (or any roster-controlled
/// value) cannot inject lines into the refusal text.
fn single_line(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

/// The model label of a `model` roster field: a display string, or the
/// `{id, provider}` object's id (the provider only when no id rides).
fn model_label(model: &Value) -> Option<String> {
    match model {
        Value::String(label) => Some(label.to_string()),
        Value::Object(map) => map
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| map.get("provider").and_then(Value::as_str))
            .map(str::to_string),
        _ => None,
    }
}

/// The roster rows of a daemon `list` response payload.
pub fn roster_rows(data: &Value) -> &[Value] {
    data.get("sessions")
        .and_then(Value::as_array)
        .map(|rows| rows.as_slice())
        .unwrap_or(&[])
}

/// The first line of the refusal: the TS `SessionAlreadyActiveError`
/// message, byte-identical.
pub(crate) fn already_active_line(holder: &str, session_path: &Path) -> String {
    format!(
        "Session is already active in {holder}: {}",
        session_path.display()
    )
}

/// The descriptive refusal for a holder the live roster identifies: the
/// TS first line, then the holder's identity and the next steps (attach
/// to the live session instead of reopening the file).
pub fn already_active_error(holder: &SessionHolder, session_path: &Path) -> String {
    let mut lines = vec![already_active_line(&holder.id, session_path)];
    let mut identity = format!("Holder: session {}", holder.id);
    if let Some(name) = &holder.name {
        identity.push_str(&format!(" \u{201c}{name}\u{201d}"));
    }
    if let Some(cwd) = &holder.cwd {
        identity.push_str(&format!(" \u{b7} cwd {cwd}"));
    }
    if let Some(model) = &holder.model {
        identity.push_str(&format!(" \u{b7} model {model}"));
    }
    lines.push(identity);
    lines.push(format!(
        "Attach to it instead: prime-agent --resume {}",
        holder.id
    ));
    lines.push("Or wait: the file unlocks when that session exits.".to_string());
    lines.join("\n")
}

/// The descriptive refusal when the holder is not in the live roster (a
/// foreign process owns the file's runtime lease): the TS first line
/// with the anonymous owner, then the next steps that still apply.
pub fn already_active_unknown_holder(holder: &str, session_path: &Path) -> String {
    let mut lines = vec![already_active_line(holder, session_path)];
    lines.push(
        "The holder is not a session on this daemon (another process owns the file's lease)."
            .to_string(),
    );
    lines.push(
        "It unlocks when that process exits; to browse live sessions, run: prime-agent agents"
            .to_string(),
    );
    lines.join("\n")
}

/// The canonical form of a session path matching
/// `pa_daemon::lease::canonical_session_path` without pa-tui depending
/// on pa-daemon.
fn canonical_form(path: &Path) -> std::path::PathBuf {
    match path.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => match path.parent().map(|parent| parent.canonicalize()) {
            Some(Ok(parent)) => parent.join(path.file_name().unwrap_or_default()),
            _ => path.to_path_buf(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(file: &str, id: &str, name: Option<&str>, cwd: Option<&str>) -> Value {
        let mut row = json!({"sessionFile": file, "activeSessionId": id});
        if let Some(name) = name {
            row["sessionName"] = json!(name);
        }
        if let Some(cwd) = cwd {
            row["cwd"] = json!(cwd);
        }
        row
    }

    /// The first line stays byte-identical to the TS refusal message.
    #[test]
    fn the_first_line_matches_the_ts_refusal() {
        assert_eq!(
            already_active_line("abc123", Path::new("/s/a.jsonl")),
            "Session is already active in abc123: /s/a.jsonl"
        );
    }

    /// The roster identifies the holder row by canonical file path and
    /// surfaces its identity fields; unrelated rows never answer.
    #[test]
    fn the_roster_names_the_holder() {
        let file = std::env::temp_dir().join("holder-probe.jsonl");
        std::fs::write(&file, "{}").unwrap();
        let rows = vec![
            row("/s/other.jsonl", "other", None, None),
            row(
                &file.display().to_string(),
                "holder-1",
                Some("lane work"),
                Some("/w"),
            ),
        ];
        let holder = holder_from_roster(&rows, &file).expect("the matching row answers");
        assert_eq!(holder.id, "holder-1");
        assert_eq!(holder.name.as_deref(), Some("lane work"));
        assert_eq!(holder.cwd.as_deref(), Some("/w"));
        let text = already_active_error(&holder, &file);
        assert!(text.starts_with(&format!(
            "Session is already active in holder-1: {}\n",
            file.display()
        )));
        assert!(text.contains("Holder: session holder-1 \u{201c}lane work\u{201d} \u{b7} cwd /w"));
        assert!(text.contains("Attach to it instead: prime-agent --resume holder-1"));
        assert!(text.contains("the file unlocks when that session exits"));
    }

    /// A holder without optional identity fields renders the id-only
    /// identity line.
    #[test]
    fn a_bare_holder_row_renders_the_id_only_identity() {
        let holder = SessionHolder {
            id: "live-9".to_string(),
            name: None,
            cwd: None,
            model: None,
        };
        let text = already_active_error(&holder, Path::new("/s/a.jsonl"));
        assert!(text
            .contains("Holder: session live-9\nAttach to it instead: prime-agent --resume live-9"));
    }

    /// A holder outside the live roster keeps the TS first line and
    /// points at the process lease instead of an attach selector.
    #[test]
    fn a_foreign_holder_gets_process_guidance() {
        let text =
            already_active_unknown_holder("another process (pid 4242)", Path::new("/s/a.jsonl"));
        assert!(text
            .starts_with("Session is already active in another process (pid 4242): /s/a.jsonl\n"));
        assert!(text.contains("not a session on this daemon"));
        assert!(text.contains("prime-agent agents"));
    }

    /// The roster extraction tolerates the payload wrapper.
    #[test]
    fn roster_rows_reads_the_sessions_array() {
        let data = json!({"sessions": [row("/s/a.jsonl", "a", None, None)], "other": 1});
        assert_eq!(roster_rows(&data).len(), 1);
        assert_eq!(roster_rows(&json!({})).len(), 0);
    }

    /// The roster's `model` rides as an object (`{id, provider}`): the
    /// holder line still shows the model id.
    #[test]
    fn the_holder_reads_the_object_model_field() {
        let file = std::env::temp_dir().join("holder-model.jsonl");
        std::fs::write(&file, "{}").unwrap();
        let mut row = row(&file.display().to_string(), "h1", None, None);
        row["model"] = json!({"id": "z-ai/glm-5.3", "provider": "prime-inference"});
        let holder =
            holder_from_roster(std::slice::from_ref(&row), &file).expect("the row answers");
        assert_eq!(holder.model.as_deref(), Some("z-ai/glm-5.3"));
        let text = already_active_error(&holder, &file);
        assert!(text.contains("\u{b7} model z-ai/glm-5.3"), "{text}");
    }

    /// Roster-controlled fields cannot inject lines: every interpolated
    /// value collapses its line breaks.
    #[test]
    fn roster_controlled_fields_cannot_inject_lines() {
        let file = std::env::temp_dir().join("holder-inject.jsonl");
        std::fs::write(&file, "{}").unwrap();
        let mut row = row(&file.display().to_string(), "h1", None, None);
        row["sessionName"] = json!("injected\nname");
        row["cwd"] = json!("/w\n/w2");
        let holder =
            holder_from_roster(std::slice::from_ref(&row), &file).expect("the row answers");
        let text = already_active_error(&holder, &file);
        // The identity stays ONE line: every break flattened to a space.
        let identity = text
            .lines()
            .find(|line| line.starts_with("Holder:"))
            .expect("the identity line renders");
        assert!(identity.contains("injected name"), "{identity}");
        assert!(identity.contains("cwd /w /w2"), "{identity}");
    }
}

/// The owner id named in a "Session is already active in {owner}: ..."
/// refusal (the lease error's first line). `None` for any other text.
pub fn owner_from_refusal(message: &str) -> Option<String> {
    const PREFIX: &str = "Session is already active in ";
    const SUFFIX: &str = ": ";
    let start = message.find(PREFIX)? + PREFIX.len();
    let rest = &message[start..];
    let end = rest.find(SUFFIX)?;
    let owner = &rest[..end];
    (!owner.is_empty()).then(|| owner.to_string())
}

#[cfg(test)]
mod owner_tests {
    use super::*;

    #[test]
    fn the_owner_extracts_from_a_refusal_line() {
        assert_eq!(
            owner_from_refusal(
                "session worker create failed: Session is already active in abc123: /s/a.jsonl"
            )
            .as_deref(),
            Some("abc123")
        );
        assert_eq!(
            owner_from_refusal("Session is already active in another process (pid 42): /s/a.jsonl")
                .as_deref(),
            Some("another process (pid 42)")
        );
    }

    #[test]
    fn other_failures_extract_nothing() {
        assert!(owner_from_refusal("Could not check active sessions: boom").is_none());
        assert!(owner_from_refusal("Session is already active in : /s/a.jsonl").is_none());
    }
}
