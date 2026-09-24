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
    // Every control character flattens (not only line breaks): a
    // roster-controlled value cannot smuggle ANSI/OSC sequences into the
    // refusal text.
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
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

/// The roster row for a known holder id (the daemon refusal already
/// names it): a live row whose active session id matches. The
/// path-keyed lookup alone can miss when the caller's resume path does
/// not canonicalize against the process cwd (a relative path).
pub fn holder_by_id(rows: &[Value], holder_id: &str) -> Option<SessionHolder> {
    rows.iter().find_map(|row| {
        let id = row
            .get("activeSessionId")
            .or_else(|| row.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())?;
        if id != holder_id {
            return None;
        }
        Some(SessionHolder {
            id: single_line(id),
            name: row
                .get("sessionName")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .map(single_line),
            cwd: row.get("cwd").and_then(Value::as_str).map(single_line),
            model: row
                .get("model")
                .and_then(model_label)
                .as_deref()
                .map(single_line),
        })
    })
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

/// The suggested `--resume <holder>` argument, shell-quoted so a holder id
/// the daemon or a roster row controls can never break the suggested
/// command (or inject a second one). Unix: POSIX single quotes with the
/// embedded-quote escape - the exact form a shell round-trips
/// byte-identically, and inert for the hex ids the product mints.
/// Windows (`cmd.exe` passes the whole token through and the CLI's own
/// argument parser splits on the quotes): double quotes with the
/// embedded-quote doubling, the CRT parsing rule.
pub(crate) fn quoted_resume_arg(id: &str) -> String {
    #[cfg(windows)]
    {
        // The CRT parsing rule: a backslash run before a quote (or before
        // the closing quote) folds 2n -> n, so every backslash doubles and
        // every embedded quote escapes - neither can terminate the
        // argument.
        format!(
            "--resume \"{}\"",
            id.replace('\\', "\\\\").replace('"', "\\\"")
        )
    }
    #[cfg(not(windows))]
    {
        format!("--resume '{}'", id.replace('\'', "'\\''"))
    }
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
        "Attach to it instead: prime-agent {}",
        quoted_resume_arg(&holder.id)
    ));
    lines.push("Or wait: the file unlocks when that session exits.".to_string());
    lines.join("\n")
}

/// Decorate the daemon's ORIGINAL refusal for the interactive create
/// path: the original message stays verbatim (never reconstructed from a
/// possibly-relative caller path), and the holder guidance rides the SAME
/// line — the agents-view handoff renders the refusal on a single status
/// line, so a multiline decoration would hide the holder and the next
/// steps behind the first paragraph.
pub fn decorate_interactive_refusal(
    original: &str,
    holder: Option<SessionHolder>,
    owner: &str,
) -> String {
    let first = original.lines().next().unwrap_or(original);
    let guidance = match holder {
        Some(h) => {
            let mut identity = format!("Holder: session {}", h.id);
            if let Some(name) = &h.name {
                identity.push_str(&format!(" \u{201c}{name}\u{201d}"));
            }
            if let Some(cwd) = &h.cwd {
                identity.push_str(&format!(" \u{b7} cwd {cwd}"));
            }
            if let Some(model) = &h.model {
                identity.push_str(&format!(" \u{b7} model {model}"));
            }
            format!(
                "{identity} \u{b7} Attach instead: prime-agent {} \u{b7} The file unlocks when that session exits",
                quoted_resume_arg(&h.id)
            )
        }
        None if owner.starts_with("another process") => format!(
            "The holder is {owner} \u{b7} It unlocks when that process exits \u{b7} Browse live sessions: prime-agent agents"
        ),
        // A session-id holder the roster cannot see (a leftover worker of a
        // dead daemon holding the runtime lease, or another daemon's
        // worker on a shared agent dir): "retry shortly" would be a false
        // promise - no worker on THIS daemon will ever answer that id - so
        // the guidance names what the holder can be and the two real ways
        // around it (the holder's exit unlocks the file; a daemon boot
        // reaps same-socket leftovers, clearing the stale lease).
        None => format!(
            "Holder: session {owner} (no worker on this daemon serves it - another daemon's worker or a leftover process holds the file) \u{b7} Restarting this daemon reaps same-socket leftovers \u{b7} The file unlocks when that process exits"
        ),
    };
    format!("{first} \u{b7} {guidance}")
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
        assert!(text.contains("Attach to it instead: prime-agent --resume 'holder-1'"));
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
        assert!(text.contains(
            "Holder: session live-9\nAttach to it instead: prime-agent --resume 'live-9'"
        ));
    }

    /// The roster extraction tolerates the payload wrapper.
    #[test]
    fn roster_rows_reads_the_sessions_array() {
        let data = json!({"sessions": [row("/s/a.jsonl", "a", None, None)], "other": 1});
        assert_eq!(roster_rows(&data).len(), 1);
        assert_eq!(roster_rows(&json!({})).len(), 0);
    }

    /// The id-keyed fallback finds the holder when the caller's path
    /// cannot canonicalize (a relative resume path): the refusal's own
    /// holder id matches the live row.
    #[test]
    fn the_id_fallback_finds_the_holder() {
        let rows = vec![row(
            "/abs/other.jsonl",
            "holder-9",
            Some("lane work"),
            Some("/w"),
        )];
        let holder = holder_by_id(&rows, "holder-9").expect("the id row answers");
        assert_eq!(holder.name.as_deref(), Some("lane work"));
        assert_eq!(holder.cwd.as_deref(), Some("/w"));
        assert!(holder_by_id(&rows, "someone-else").is_none());
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
mod decorate_tests {
    use super::*;

    /// The interactive decoration preserves the original refusal line
    /// verbatim and rides the guidance on the SAME line (the
    /// agents-view status strip shows one line only).
    #[test]
    fn the_interactive_decoration_keeps_one_line() {
        let original =
            "session worker create failed: Session is already active in abc123: /tmp/s.jsonl";
        let holder = SessionHolder {
            id: "abc123".to_string(),
            name: Some("lane work".to_string()),
            cwd: Some("/w".to_string()),
            model: None,
        };
        let text = decorate_interactive_refusal(original, Some(holder), "abc123");
        assert!(!text.contains('\n'), "one line: {text:?}");
        assert!(
            text.starts_with(original),
            "the original line is verbatim: {text}"
        );
        assert!(
            text.contains("Holder: session abc123 \u{201c}lane work\u{201d} \u{b7} cwd /w"),
            "{text}"
        );
        assert!(
            text.contains("Attach instead: prime-agent --resume 'abc123'"),
            "{text}"
        );
    }

    /// A session-id holder the roster cannot see gets session-shaped
    /// guidance that does not promise a retry that cannot succeed: the
    /// holder is named as foreign (another daemon's worker or a leftover
    /// process), with the two real ways around it (a daemon boot reaps
    /// same-socket leftovers; the holder's exit unlocks the file).
    #[test]
    fn an_unseen_session_holder_gets_session_guidance() {
        let original = "Session is already active in 4be64bca6a0a: /tmp/s.jsonl";
        let text = decorate_interactive_refusal(original, None, "4be64bca6a0a");
        assert!(
            text.contains("Holder: session 4be64bca6a0a (no worker on this daemon serves it"),
            "{text}"
        );
        assert!(
            text.contains("Restarting this daemon reaps same-socket leftovers"),
            "{text}"
        );
        assert!(
            text.contains("The file unlocks when that process exits"),
            "{text}"
        );
        // The false promise is gone: no retry hint for a holder this
        // daemon cannot reach.
        assert!(!text.contains("retry shortly"), "{text}");
        assert!(!text.contains("not a session on this daemon"), "{text}");
    }

    /// The suggested command quotes the holder id: a roster- or
    /// daemon-controlled id with spaces or quotes can never break the
    /// suggestion (or smuggle a second argument into it).
    #[test]
    fn the_resume_suggestion_quotes_a_hostile_holder_id() {
        // The holder the roster identifies (the Some arm) names the id in
        // the suggested command: the hostile id must ride single-quoted.
        let holder = SessionHolder {
            id: "245ddb974b6d; rm -rf /".to_string(),
            name: None,
            cwd: None,
            model: None,
        };
        let original = "Session is already active in 245ddb974b6d; rm -rf /: /tmp/s.jsonl";
        let text =
            decorate_interactive_refusal(original, Some(holder.clone()), "245ddb974b6d; rm -rf /");
        assert!(
            text.contains("--resume '245ddb974b6d; rm -rf /'"),
            "the hostile id rides single-quoted: {text}"
        );
        assert!(
            !text.contains("--resume 245ddb974b6d;"),
            "no unquoted splice survives: {text}"
        );
        // The print-mode refusal quotes the same way.
        let printed = already_active_error(&holder, Path::new("/tmp/s.jsonl"));
        assert!(
            printed.contains("--resume '245ddb974b6d; rm -rf /'"),
            "the print-mode line quotes too: {printed}"
        );
        // The embedded-quote escape: an id carrying a single quote still
        // round-trips as ONE argument.
        assert_eq!(
            quoted_resume_arg("it's"),
            "--resume 'it'\\''s'",
            "the POSIX escape form"
        );
        // The unseen-holder arm (no roster row) suggests the daemon-restart
        // path instead - it never interpolates the id into a command.
        let unseen = decorate_interactive_refusal(original, None, "245ddb974b6d; rm -rf /");
        assert!(
            !unseen.contains("--resume"),
            "the unseen arm suggests no command to splice into: {unseen}"
        );
    }

    /// A process holder keeps the process-shaped guidance.
    #[test]
    fn a_process_holder_keeps_process_guidance() {
        let original = "Session is already active in another process (pid 42): /tmp/s.jsonl";
        let text = decorate_interactive_refusal(original, None, "another process (pid 42)");
        assert!(
            text.contains("The holder is another process (pid 42)"),
            "{text}"
        );
        assert!(text.contains("prime-agent agents"), "{text}");
    }
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
