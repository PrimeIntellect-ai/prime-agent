//! Parsing of ipython execution `details` for the cell card, a port of the
//! data-reading half of TS `ipython-cell.ts`: the details record
//! (structured stdout/stderr/result/error fields), the background-shell
//! handle repr, literal shell launches, and the edit-confirmation and
//! agent-message-receipt suppressions that keep already-summarized output
//! off the cell rows.

use serde_json::Value;

/// Parsed `details` of one ipython execution result.
pub(crate) struct IpythonDetails {
    pub(crate) duration_ms: Option<f64>,
    pub(crate) status: Option<String>,
    pub(crate) error_ename: Option<String>,
    pub(crate) stdout: Option<String>,
    pub(crate) stderr: Option<String>,
    pub(crate) result: Option<String>,
    pub(crate) background_output: Option<String>,
    pub(crate) error: Option<IpythonError>,
    pub(crate) diffs: Vec<Value>,
    pub(crate) sent_agent_messages: Vec<Value>,
}

pub(crate) struct IpythonError {
    pub(crate) ename: String,
    pub(crate) evalue: String,
    pub(crate) traceback: Vec<String>,
}

pub(crate) fn read_error_details(value: &Value) -> Option<IpythonError> {
    let record = value.as_object()?;
    let ename = record.get("ename")?.as_str()?.to_string();
    Some(IpythonError {
        ename,
        evalue: record
            .get("evalue")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        traceback: record
            .get("traceback")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

impl IpythonDetails {
    pub(crate) fn parse(details: &Value) -> IpythonDetails {
        let empty = IpythonDetails {
            duration_ms: None,
            status: None,
            error_ename: None,
            stdout: None,
            stderr: None,
            result: None,
            background_output: None,
            error: None,
            diffs: Vec::new(),
            sent_agent_messages: Vec::new(),
        };
        let Some(record) = details.as_object() else {
            return empty;
        };
        let error = record.get("error").and_then(read_error_details);
        IpythonDetails {
            duration_ms: record.get("durationMs").and_then(Value::as_f64),
            status: record
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string),
            error_ename: error.as_ref().map(|e| e.ename.clone()).or_else(|| {
                record
                    .get("errorEname")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }),
            stdout: record
                .get("stdout")
                .and_then(Value::as_str)
                .map(str::to_string),
            stderr: record
                .get("stderr")
                .and_then(Value::as_str)
                .map(str::to_string),
            result: record
                .get("result")
                .and_then(Value::as_str)
                .map(str::to_string),
            background_output: record
                .get("backgroundOutput")
                .and_then(Value::as_str)
                .map(str::to_string),
            error,
            diffs: record
                .get("diffs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            sent_agent_messages: record
                .get("sentAgentMessages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }
    }
}

/// `formatDuration`: whole `ms` below a second, tenths above.
pub(crate) fn format_duration(duration_ms: f64) -> String {
    if duration_ms < 1000.0 {
        format!("{}ms", duration_ms.round())
    } else {
        format!("{:.1}s", duration_ms / 1000.0)
    }
}

/// Strip one layer of repr quotes so an `execute_result` string compares
/// cleanly (TS `stripReprQuotes`).
pub(crate) fn strip_repr_quotes(text: &str) -> &str {
    let trimmed = text.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('\'') && trimmed.ends_with('\''))
            || (trimmed.starts_with('"') && trimmed.ends_with('"')))
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    }
}

/// True when `text` is the edit skill's "Edited <path>" confirmation for one
/// of the cell's diffs (TS `isEditConfirmation`).
pub(crate) fn is_edit_confirmation(text: Option<&str>, diffs: &[Value]) -> bool {
    let Some(text) = text else {
        return false;
    };
    let stripped = strip_repr_quotes(text);
    diffs.iter().any(|diff| {
        diff.get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| stripped == format!("Edited {path}"))
    })
}

/// One parsed sent agent message (TS `SentAgentMessageDisplay`): the body
/// text, whether the receipt is `delivered` (vs `queued`), and the
/// counterpart agent's display name (TS `formatAgentMessageParticipant`
/// with the `"sent"` direction: name, then active session id, session id,
/// then `unknown`; the `to <role>` prefix and the role word fold into the
/// viewer-relative arrow — the operator's 2026-09-25 directive).
pub(crate) struct SentAgentMessage {
    pub(crate) message: String,
    pub(crate) delivered: bool,
    pub(crate) counterpart: String,
}

/// Parse one `sentAgentMessages` entry; `None` on a malformed record
/// (a missing message or target leaves nothing renderable).
pub(crate) fn parse_sent_agent_message(value: &Value) -> Option<SentAgentMessage> {
    let message = value.get("message")?.as_str()?.to_string();
    let delivered = value.get("deliveryStatus").and_then(Value::as_str) == Some("delivered");
    let target = value.get("target").unwrap_or(&Value::Null);
    let counterpart = ["sessionName", "activeSessionId", "sessionId"]
        .iter()
        .find_map(|key| {
            target
                .get(*key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|name| !name.trim().is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string());
    Some(SentAgentMessage {
        message,
        delivered,
        counterpart,
    })
}

/// True when `text` is the `agent_message.send` receipt dict for one of the
/// sent messages already summarized above the output (TS
/// `isAgentMessageReceipt`).
pub(crate) fn is_agent_message_receipt(text: Option<&str>, messages: &[Value]) -> bool {
    let Some(text) = text else {
        return false;
    };
    if messages.is_empty() {
        return false;
    }
    let stripped = strip_repr_quotes(text);
    messages.iter().any(|message| {
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            return false;
        };
        stripped.starts_with(&format!("{{'id': '{id}"))
            || stripped.starts_with(&format!("{{\"id\": \"{id}"))
    })
}

/// A background shell launched by the cell (TS `readBackgroundShellHandle`:
/// the result is a `<BashHandle pid=... running|exit_code=N command=...>`
/// repr and the cell launches that literal command).
pub(crate) struct BackgroundShell {
    pub(crate) exit_code: Option<i64>,
}

/// TS `readLiteralShellLaunch`: the cell is a single `bash('...')` call
/// (optionally assigned, optionally preceded by the rlm import).
pub(crate) fn literal_shell_command(code: &str) -> Option<String> {
    let launch: Vec<&str> = code
        .trim()
        .split('\n')
        .filter(|line| {
            !line.trim().is_empty() && !line.trim_start().starts_with("from rlm import bash")
        })
        .filter(|line| line.trim() != "import rlm")
        .collect();
    let source = launch.first()?.trim_end();
    let open = source.find('(')?;
    if !source.ends_with(')') {
        return None;
    }
    let head = &source[..open];
    let call = head.trim_end();
    // `(?:([A-Za-z_]\w*)\s*=\s*)?(?:rlm\.)?bash`
    let call_name = call.strip_suffix("bash")?;
    let call_name = call_name.strip_suffix(".rlm").unwrap_or(call_name);
    if !call_name.is_empty() {
        let trimmed = call_name.trim();
        let var = trimmed.strip_suffix('=').map(str::trim_end)?;
        if var.is_empty()
            || !var
                .chars()
                .next()
                .is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
            || !var.chars().all(|c| c == '_' || c.is_ascii_alphanumeric())
        {
            return None;
        }
    }
    read_python_string(source[open + 1..source.len() - 1].trim())
}

/// A single-quoted or double-quoted python string literal body (TS
/// `readPythonString`).
pub(crate) fn read_python_string(text: &str) -> Option<String> {
    let mut chars = text.chars();
    let quote = chars.next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let mut out = String::new();
    while let Some(c) = chars.next() {
        if c == '\\' {
            out.push(chars.next()?);
            continue;
        }
        if c == quote {
            return Some(out);
        }
        out.push(c);
    }
    None
}

pub(crate) fn read_background_shell(code: &str, details: &Value) -> Option<BackgroundShell> {
    let result = details.get("result")?.as_str()?;
    let trimmed = result.trim();
    let rest = trimmed.strip_prefix("<BashHandle pid=")?;
    let (pid, rest) = rest.split_once(' ')?;
    if pid.parse::<u64>().ok()? == 0 {
        return None;
    }
    let (state, rest) = rest.split_once(' ')?;
    let exit_code = if state == "running" {
        None
    } else {
        let code = state.strip_prefix("exit_code=")?.parse::<i64>().ok()?;
        Some(code)
    };
    if !rest.starts_with("command=") || !rest.ends_with('>') {
        return None;
    }
    let command = read_python_string(&rest["command=".len()..rest.len() - 1])?;
    if literal_shell_command(code).as_deref() != Some(command.as_str()) {
        return None;
    }
    Some(BackgroundShell { exit_code })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sent_agent_message_shapes() {
        // The delivered receipt with a full target and role.
        let delivered = parse_sent_agent_message(&serde_json::json!({
            "id": "agentmsg_1",
            "message": "Ping.",
            "deliveryStatus": "delivered",
            "receiverRole": "parent",
            "target": { "activeSessionId": "a1", "sessionId": "s1", "sessionName": "Worker" },
        }))
        .expect("delivered receipt");
        assert!(delivered.delivered);
        assert_eq!(delivered.message, "Ping.");
        assert_eq!(delivered.counterpart, "Worker");
        // Name -> active session id -> session id -> unknown (TS
        // `formatAgentMessageParticipant` fallback order).
        let by_active = parse_sent_agent_message(&serde_json::json!({
            "id": "agentmsg_2",
            "message": "Ping.",
            "deliveryStatus": "queued",
            "receiverRole": "sibling",
            "target": { "activeSessionId": "a1", "sessionId": "s1" },
        }))
        .expect("queued receipt");
        assert!(!by_active.delivered);
        assert_eq!(by_active.counterpart, "a1");
        let by_session = parse_sent_agent_message(&serde_json::json!({
            "id": "agentmsg_3",
            "message": "Ping.",
            "deliveryStatus": "queued",
            "target": { "sessionId": "s1" },
        }))
        .expect("bare target");
        assert_eq!(by_session.counterpart, "s1");
        let unknown = parse_sent_agent_message(&serde_json::json!({
            "id": "agentmsg_4",
            "message": "Ping.",
            "deliveryStatus": "queued",
        }))
        .expect("missing target falls back to unknown");
        assert_eq!(unknown.counterpart, "unknown");
        // A missing message renders nothing.
        assert!(parse_sent_agent_message(&serde_json::json!({
            "id": "agentmsg_5",
            "deliveryStatus": "delivered",
        }))
        .is_none());
    }
}
