//! The `prime-agent sessions` operator table: one line per agent — name,
//! status, activity, staleness, last error, usage — rendered from the same
//! daemon `list` summaries `prime-agent list` reads, ported from
//! `cli/sessions-table-format.ts`. The activity wording comes from the
//! shared roster branch table
//! ([`pa_types::daemon::agent_roster::session_activity_detail`]) so this
//! table and the agents view tell the same story. Colors are TTY-only in
//! TS; this output is color-free like TS piped output (the `list` table's
//! rule).

use pa_tui::ansi::strip_ansi;
use pa_tui::info_commands::js_to_fixed;
use pa_tui::width::{str_width, truncate_to_width};
use pa_types::daemon::agent_roster::{
    classify_summary_value, session_activity_detail, AgentRosterStatus, SessionActivityOptions,
};
use serde_json::Value;

use crate::daemon_session_list::{
    format_session_age, format_session_display_id, format_table, string_field,
};

/// Display-width cap for free-text cells (names, recaps, error text) so one
/// long line never stretches the row; wide glyphs count as their terminal
/// columns (TS `MAX_CELL_CHARS`).
const MAX_CELL_CHARS: usize = 60;

/// The sessions table's columns.
const SESSIONS_HEADERS: [&str; 6] = ["name", "status", "activity", "last heard", "error", "usage"];

/// One-line-per-agent operator table for `prime-agent sessions` (TS
/// `formatSessionsTable`).
pub(crate) fn format_sessions_table(sessions: &[&Value], now_ms: u64) -> String {
    let mut sorted = sessions.to_vec();
    sorted.sort_by_key(|summary| sessions_sort_key(summary));
    let rows: Vec<[String; 6]> = sorted
        .iter()
        .map(|summary| {
            [
                truncate_cell(&session_name_cell(summary)),
                sessions_status_label(summary).to_string(),
                truncate_cell(&session_activity_cell(summary)),
                // lastHeardFromAt is the supervisor's staleness mark, served
                // only when a worker's roster frames go stale; healthy
                // workers carry no heard-from timestamp, so the cell stays
                // empty rather than mislabeling the session-file mtime as a
                // heard-from time (the agents view keys the same label on
                // the mark's presence).
                format_session_age(string_field(summary, "lastHeardFromAt"), now_ms),
                truncate_cell(&session_error_cell(summary).unwrap_or_default()),
                format_usage_cell(summary.get("usage")),
            ]
        })
        .collect();
    format_table(&SESSIONS_HEADERS, &rows)
}

/// Failures first, then recovering/running, then idle, then everything else
/// (TS `sessionsSortKey`); the sort is stable so equal-key rows keep their
/// roster order.
fn sessions_sort_key(summary: &Value) -> u8 {
    let status_label = string_field(summary, "statusLabel");
    let worker_state = string_field(summary, "workerState");
    let roster = sessions_roster_status(summary);
    if status_label == Some("failed") || worker_state == Some("failed") {
        return 0;
    }
    if status_label == Some("recovering") || worker_state == Some("recovering") {
        return 1;
    }
    if status_label == Some("queued") || roster == "running" {
        return 2;
    }
    if roster == "idle" {
        return 3;
    }
    4
}

/// The roster status of one row (TS `sessionRosterStatus`): the ledger's
/// classification when the wire carries it, else the shared formula.
fn sessions_roster_status(summary: &Value) -> &str {
    string_field(summary, "rosterStatus").unwrap_or_else(|| {
        match classify_summary_value(summary, false) {
            AgentRosterStatus::Running => "running",
            AgentRosterStatus::Idle => "idle",
            AgentRosterStatus::Inactive => "inactive",
        }
    })
}

/// The status column (TS `sessionsStatusLabel`): an exceptional ledger mark
/// overrides the plain roster status.
fn sessions_status_label(summary: &Value) -> &str {
    string_field(summary, "statusLabel").unwrap_or_else(|| sessions_roster_status(summary))
}

/// The activity column (TS `sessionActivityCell`): the shared branch
/// table's detail, with the session recap after a separator when one
/// exists. The table's knobs: the heartbeat mark is just "heartbeat" (no
/// countdown; a static table has no live next-run timer) and the idle
/// fallback is empty (the status column already says idle).
fn session_activity_cell(summary: &Value) -> String {
    let detail = session_activity_detail(
        summary,
        &SessionActivityOptions {
            heartbeat_label: "heartbeat".to_string(),
            idle_label: String::new(),
        },
    );
    let recap = compact_cell_text(string_field(summary, "summary"));
    [Some(detail), recap]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" \u{b7} ")
}

/// The name cell (TS `sessionNameCell`): names are user-provided; sanitize
/// them and fall back to the display id when sanitizing leaves nothing.
///
/// # Panics
///
/// Panics when the summary carries no `id`: the table only reads rows the
/// summary guard validated, and the guard requires it.
fn session_name_cell(summary: &Value) -> String {
    let id = string_field(summary, "id").expect("validated summary carries id");
    compact_cell_text(string_field(summary, "sessionName"))
        .unwrap_or_else(|| format_session_display_id(id))
}

/// The error column (TS `sessionErrorCell`): the worker failure mark or the
/// model fallback notice; rows that report neither keep the cell empty.
fn session_error_cell(summary: &Value) -> Option<String> {
    if string_field(summary, "statusLabel") == Some("failed")
        || string_field(summary, "workerState") == Some("failed")
    {
        return Some("worker failed".to_string());
    }
    compact_cell_text(string_field(summary, "modelFallbackMessage"))
}

/// The usage column (TS `formatUsageCell`): tokens in/out plus spend.
fn format_usage_cell(usage: Option<&Value>) -> String {
    let Some(usage) = usage else {
        return String::new();
    };
    let input_tokens = usage
        .get("inputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let output_tokens = usage
        .get("outputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cost = usage
        .get("cost")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    format!(
        "{}/{} ${}",
        format_token_count(input_tokens),
        format_token_count(output_tokens),
        js_to_fixed(cost, 2)
    )
}

/// Token counts at k/m/b scale with one decimal (TS `formatTokenCount`).
fn format_token_count(tokens: u64) -> String {
    if tokens < 1_000 {
        return tokens.to_string();
    }
    let (divisor, suffix) = if tokens < 1_000_000 {
        (1_000_f64, "k")
    } else if tokens < 1_000_000_000 {
        (1_000_000_f64, "m")
    } else {
        (1_000_000_000_f64, "b")
    };
    format!("{}{suffix}", js_to_fixed(tokens as f64 / divisor, 1))
}

/// All free-text cells (names, recaps, error notices) share one sanitizer
/// (TS `compactCellText`): strip ANSI escapes and the C0/C1 controls the
/// strip misses, then compact whitespace, so no cell can clear the screen,
/// move the cursor, restyle later columns, or add table lines. The result
/// is `None` when nothing visible remains.
fn compact_cell_text(value: Option<&str>) -> Option<String> {
    let stripped = strip_ansi(value.unwrap_or_default());
    let mut compacted = String::with_capacity(stripped.len());
    let mut pending_space = false;
    for c in stripped.chars() {
        if is_stripped_control(c) {
            continue;
        }
        // The JS `\s` class also counts the zero-width no-break space.
        if c.is_whitespace() || c == '\u{feff}' {
            pending_space = true;
            continue;
        }
        if pending_space {
            compacted.push(' ');
            pending_space = false;
        }
        compacted.push(c);
    }
    let text = compacted.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// The C0/C1 controls that `stripAnsi` misses and whitespace compaction
/// cannot remove (TS `CONTROL_CHARACTERS`).
fn is_stripped_control(c: char) -> bool {
    let code = c as u32;
    code <= 0x08 || (0x0e..=0x1f).contains(&code) || (0x7f..=0x9f).contains(&code)
}

fn truncate_cell(value: &str) -> String {
    truncate_to_width(value, MAX_CELL_CHARS, "\u{2026}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW_MS: u64 = 1_780_056_000_000; // 2026-05-29T12:00:00.000Z
    const STALE_AT: &str = "2026-05-29T11:50:00.000Z";
    const LONG_ID: &str = "019e71ec-e08a-75a9-b573-fc10e9f8380f";

    /// Base summary: a resident idle session (TS `BASE`).
    fn base_summary() -> Value {
        json!({
            "id": "s",
            "sessionId": "session-s",
            "activeSessionId": "a1",
            "cwd": "/tmp/project",
            "lifecycle": "live",
            "activity": "idle",
            "isSessionActive": false,
            "isStreaming": false,
            "isCompacting": false,
            "attachedClients": 0,
            "messageCount": 2,
            "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
            "modified": "2026-05-29T10:00:00.000Z",
        })
    }

    /// TS `makeSummary`: merge the overrides, then report an active turn
    /// exactly when the activity is `working`.
    fn make_summary(overrides: Value) -> Value {
        let mut summary = base_summary();
        if let (Value::Object(base), Value::Object(over)) = (&mut summary, overrides) {
            for (key, value) in over {
                base.insert(key, value);
            }
        }
        summary["isSessionActive"] = json!(summary["activity"] == "working");
        summary
    }

    /// The exact-row harness (TS `expectTable`): the rendered table must be
    /// the expected rows padded to their own widest cell.
    fn expect_table(case: &str, sessions: &[Value], expected_rows: &[[&str; 6]]) {
        let rows: Vec<&Value> = sessions.iter().collect();
        let table = format_sessions_table(&rows, NOW_MS);
        let widths: [usize; 6] = std::array::from_fn(|column| {
            str_width(SESSIONS_HEADERS[column]).max(
                expected_rows
                    .iter()
                    .map(|row| str_width(row[column]))
                    .max()
                    .unwrap_or(0),
            )
        });
        let pad = |row: [&str; 6]| {
            row.iter()
                .enumerate()
                .map(|(column, cell)| {
                    let pad = " ".repeat(widths[column] - str_width(cell));
                    format!("{cell}{pad}")
                })
                .collect::<Vec<_>>()
                .join("  ")
        };
        let expected: Vec<String> = std::iter::once(pad(SESSIONS_HEADERS))
            .chain(expected_rows.iter().map(|row| pad(*row)))
            .collect();
        let rendered: Vec<&str> = table.lines().collect();
        assert_eq!(rendered, expected, "{case}");
    }

    #[test]
    fn rows_render_the_ts_vectors() {
        let capped_recap = format!("running tools \u{b7} {}…", "a".repeat(43));
        let capped_name = "n".repeat(59);
        let vectors: Vec<(&str, Value, [&str; 6])> = vec![
            (
                "thinking detail",
                json!({ "activity": "working", "isStreaming": true }),
                ["s", "running", "thinking", "", "", ""],
            ),
            (
                "running bash",
                json!({ "activity": "working", "isBashRunning": true }),
                ["s", "running", "running bash", "", "", ""],
            ),
            (
                "compacting",
                json!({ "activity": "working", "isCompacting": true }),
                ["s", "running", "compacting", "", "", ""],
            ),
            (
                "completed verdict",
                json!({ "taskState": "completed" }),
                ["s", "idle", "completed", "", "", ""],
            ),
            (
                "saved status",
                json!({ "activeSessionId": null, "rosterStatus": "inactive" }),
                ["s", "inactive", "", "", "", ""],
            ),
            (
                "queued label",
                json!({ "activity": "working", "statusLabel": "queued" }),
                ["s", "queued", "classifying", "", "", ""],
            ),
            (
                "recovering label",
                json!({ "statusLabel": "recovering" }),
                ["s", "recovering", "", "", "", ""],
            ),
            (
                "failed label",
                json!({ "statusLabel": "failed" }),
                ["s", "failed", "", "", "worker failed", ""],
            ),
            (
                "sanitized model notice",
                json!({ "modelFallbackMessage": "boom\u{0007}\u{001b}[31m!\u{001b}[39m" }),
                ["s", "idle", "", "", "boom!", ""],
            ),
            (
                "staleness",
                json!({ "activity": "working", "lastHeardFromAt": STALE_AT }),
                ["s", "running", "classifying", "10m", "", ""],
            ),
            (
                "usage compact",
                json!({ "usage": { "inputTokens": 1234, "outputTokens": 567, "cost": 0.4234 } }),
                ["s", "idle", "", "", "", "1.2k/567 $0.42"],
            ),
            (
                "sanitizes and truncates the recap appended to the activity detail",
                json!({
                    "activity": "working",
                    "isStreaming": true,
                    "isRunningTools": true,
                    "summary": format!("\u{0007}{}", "a".repeat(100)),
                }),
                ["s", "running", capped_recap.as_str(), "", "", ""],
            ),
            (
                "usage fleet scale",
                json!({
                    "usage": { "inputTokens": 1_626_400_000, "outputTokens": 2_100_000, "cost": 382.85 }
                }),
                ["s", "idle", "", "", "", "1.6b/2.1m $382.85"],
            ),
            (
                "archived rows",
                json!({ "lifecycle": "archived", "rosterStatus": "inactive" }),
                ["s", "inactive", "archived", "", "", ""],
            ),
            (
                "display id fallback",
                json!({ "id": LONG_ID, "sessionName": null }),
                ["fc10e9f8380f", "idle", "", "", "", ""],
            ),
            (
                "newline in name",
                json!({ "sessionName": "sneaky\nagent" }),
                ["sneaky agent", "idle", "", "", "", ""],
            ),
            (
                "ansi in name",
                json!({ "sessionName": "\u{001b}[31mansi\u{001b}[39m agent" }),
                ["ansi agent", "idle", "", "", "", ""],
            ),
            (
                "control chars in name",
                json!({ "sessionName": "beep\u{0007} agent" }),
                ["beep agent", "idle", "", "", "", ""],
            ),
            (
                "blank name",
                json!({ "sessionName": "\u{0007}", "id": LONG_ID }),
                ["fc10e9f8380f", "idle", "", "", "", ""],
            ),
            (
                "long name cap",
                json!({ "sessionName": "n".repeat(200) }),
                [capped_name.as_str(), "idle", "", "", "", ""],
            ),
            (
                "heartbeat",
                json!({ "hasActiveHeartbeat": true }),
                ["s", "idle", "heartbeat", "", "", ""],
            ),
            (
                "ignores queued actions",
                json!({
                    "sessionActions": { "queuedCount": 2, "steering": [], "followUps": [] }
                }),
                ["s", "idle", "", "", "", ""],
            ),
            (
                "starting worker",
                json!({ "activity": "working", "workerState": "starting" }),
                ["s", "running", "starting", "", "", ""],
            ),
            (
                "stopping worker",
                json!({ "workerState": "stopping" }),
                ["s", "idle", "stopping", "", "", ""],
            ),
            (
                "replied subagent",
                json!({ "runtimeKind": "subagent", "repliedSinceTask": true }),
                ["s", "idle", "replied", "", "", ""],
            ),
        ];
        for (case, overrides, expected) in vectors {
            expect_table(case, &[make_summary(overrides)], &[expected]);
        }
        // The empty roster renders the header only.
        expect_table("empty roster renders the header only", &[], &[]);
    }

    #[test]
    fn sorts_failures_first_then_recovering_then_running_then_idle_then_rest() {
        let sessions = vec![
            make_summary(json!({
                "sessionName": "plain-saved",
                "activeSessionId": null,
                "rosterStatus": "inactive",
            })),
            make_summary(
                json!({ "sessionName": "worker", "activity": "working", "isStreaming": true }),
            ),
            // The diagnostics entry is never served by the supervisor list
            // RPC; the row must keep showing the worker mark.
            make_summary(json!({
                "sessionName": "crashed",
                "workerState": "failed",
                "diagnostics": [{ "type": "error", "message": "x" }],
            })),
            make_summary(json!({ "sessionName": "sleeper", "taskState": "completed" })),
            make_summary(json!({ "sessionName": "restarting", "workerState": "recovering" })),
        ];
        expect_table(
            "sort",
            &sessions,
            &[
                ["crashed", "idle", "failed", "", "worker failed", ""],
                ["restarting", "idle", "recovering", "", "", ""],
                ["worker", "running", "thinking", "", "", ""],
                ["sleeper", "idle", "completed", "", "", ""],
                ["plain-saved", "inactive", "", "", "", ""],
            ],
        );
    }

    #[test]
    fn measures_wide_glyph_cells_by_display_width() {
        let sessions = vec![
            make_summary(json!({ "sessionName": "中文" })),
            make_summary(json!({
                "sessionName": "hello",
                "summary": "\u{1f680}".repeat(40),
            })),
        ];
        let rows: Vec<&Value> = sessions.iter().collect();
        let table = format_sessions_table(&rows, NOW_MS);
        let lines: Vec<&str> = table.lines().collect();
        // Scalar-length padding would misalign the CJK name; the recap cap
        // counts display columns, pair-safe.
        assert!(lines[1].starts_with("中文   idle"), "{lines:?}");
        assert!(
            lines[2].contains(&format!("{}…", "\u{1f680}".repeat(29))),
            "{lines:?}"
        );
    }
}
