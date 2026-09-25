//! The agents-view data layer: one reconcile of the daemon's live roster and
//! the saved-session catalog into unified records, then section grouping,
//! search, and the row/layout shapes the view renders. Pure functions on
//! JSON summaries (the wire forms the supervisor serves), mirroring the TS
//! agents-view state module; the view module owns input and painting.

use std::collections::HashMap;

use pa_types::daemon::agent_roster::AgentRosterStatus;
use serde_json::Value;

use crate::agents_view_search::score_search;
use crate::width::str_width;

/// One of the three sections every unified record sorts into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Running,
    Idle,
    Inactive,
}

/// The display heading of a section.
pub fn section_title(section: Section) -> &'static str {
    match section {
        Section::Running => "Running",
        Section::Idle => "Idle",
        Section::Inactive => "Inactive",
    }
}

pub(crate) fn section_rank(section: Section) -> u8 {
    match section {
        Section::Running => 0,
        Section::Idle => 1,
        Section::Inactive => 2,
    }
}

fn section_from_status(status: AgentRosterStatus) -> Section {
    match status {
        AgentRosterStatus::Running => Section::Running,
        AgentRosterStatus::Idle => Section::Idle,
        AgentRosterStatus::Inactive => Section::Inactive,
    }
}

/// One merged row source: the live roster summary, the saved catalog row, or
/// both. Daemon data stays authoritative; saved data only enriches the
/// durable/search fields.
#[derive(Debug, Clone, PartialEq)]
pub struct UnifiedRecord {
    /// The slim session summary of a roster entry (`summary` field).
    pub daemon: Option<Value>,
    /// One saved-session catalog row (`session_list_item.session`).
    pub saved: Option<Value>,
    /// The supervisor's classification of the roster entry.
    pub status: Option<AgentRosterStatus>,
    /// `queued` / `recovering` / `failed` (set only for exceptional states).
    pub status_label: Option<String>,
    /// The stable UI key (first alias).
    pub identity: String,
    /// Every key this record is reachable by (selection survival).
    pub aliases: Vec<String>,
    pub section: Section,
    /// The picker's match targets: the name, the durable session id,
    /// and the cwd (see `agents_view_search`).
    pub search: SessionSearchText,
    /// The query-relevance score behind the ranked list (lower is better);
    /// `None` for retained ancestors and unqueried rosters.
    pub search_score: Option<f64>,
}

fn get_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// The canonical file identity (TS canonicalizes; the saved catalog already
/// serves absolute paths, so lexical normalization is enough here).
fn file_identity(path: &str) -> String {
    format!("file:{path}")
}

/// The aliases of one roster entry summary, in TS order.
fn daemon_aliases(summary: &Value) -> Vec<String> {
    let mut aliases = Vec::new();
    if get_str(summary, "runtimeKind") == Some("subagent") && summary.get("rlmChildId").is_some() {
        // The roster entry's agentId is the parent-qualified child id (TS
        // computes it client-side from the summary fields; pa-types owns the
        // one formula).
        let agent_id = pa_types::daemon::agent_roster::roster_agent_id_for_summary(summary);
        aliases.push(format!("agent:{agent_id}"));
    }
    if let Some(file) = get_str(summary, "sessionFile") {
        aliases.push(file_identity(file));
    }
    if let Some(id) = get_str(summary, "sessionId") {
        aliases.push(format!("session:{id}"));
    }
    if let Some(active) = get_str(summary, "activeSessionId") {
        aliases.push(format!("active:{active}"));
    }
    if let Some(id) = get_str(summary, "id") {
        aliases.push(format!("active:{id}"));
    }
    aliases
}

fn saved_aliases(saved: &Value) -> Vec<String> {
    let mut aliases = Vec::new();
    if let Some(path) = get_str(saved, "path") {
        aliases.push(file_identity(path));
    }
    if let Some(id) = get_str(saved, "id") {
        aliases.push(format!("session:{id}"));
    }
    aliases
}

/// The picker targets of one roster entry: the session NAME (primary),
/// the durable session ID (paste-a-prefix targeting), and the CWD — the
/// restricted corpus of `agents_view_search`. Daemon data wins for
/// joined records; saved rows carry the durable name for archived
/// sessions.
fn daemon_search_text(summary: &Value) -> SessionSearchText {
    SessionSearchText {
        name: get_str(summary, "sessionName")
            .map(str::to_string)
            .unwrap_or_default(),
        id: get_str(summary, "sessionId")
            .map(str::to_string)
            .unwrap_or_default(),
        cwd: get_str(summary, "cwd")
            .map(str::to_string)
            .unwrap_or_default(),
    }
}

fn saved_search_text(saved: &Value) -> SessionSearchText {
    SessionSearchText {
        name: get_str(saved, "name")
            .map(str::to_string)
            .unwrap_or_default(),
        id: get_str(saved, "id").map(str::to_string).unwrap_or_default(),
        cwd: get_str(saved, "cwd")
            .map(str::to_string)
            .unwrap_or_default(),
    }
}

/// Merge saved targets into a live record's (daemon data wins).
fn enrich_search_text(live: &SessionSearchText, saved: &SessionSearchText) -> SessionSearchText {
    let pick = |live_value: &str, saved_value: &str| {
        if live_value.is_empty() {
            saved_value.to_string()
        } else {
            live_value.to_string()
        }
    };
    SessionSearchText {
        name: pick(&live.name, &saved.name),
        id: pick(&live.id, &saved.id),
        cwd: pick(&live.cwd, &saved.cwd),
    }
}

/// Merge the live roster entries and the saved catalog rows into unified
/// records without inventing runtime ancestry: roster data wins, saved rows
/// only join through a shared alias and enrich search text.
pub fn reconcile_unified_sessions(roster: &[Value], saved: &[Value]) -> Vec<UnifiedRecord> {
    let mut records: Vec<UnifiedRecord> = Vec::new();
    let mut by_alias: HashMap<String, usize> = HashMap::new();

    for entry in roster {
        let summary = entry.get("summary").cloned().unwrap_or(Value::Null);
        // TS `shouldShowAgentsViewSession`: only live rows render. A
        // message-less top-level draft (lifecycle "draft") never surfaces a
        // conversation-less roster row; subagent workers are live before
        // their first message and the ledger seeds carry live.
        if get_str(&summary, "lifecycle") != Some("live") {
            continue;
        }
        let status = entry
            .get("status")
            .and_then(Value::as_str)
            .and_then(parse_status);
        let status_label = get_str(entry, "statusLabel").map(str::to_string);
        let aliases = daemon_aliases(&summary);
        let Some(identity) = aliases.first().cloned() else {
            continue;
        };
        let section = status.map_or(Section::Idle, section_from_status);
        let search = daemon_search_text(&summary);
        let index = records.len();
        for alias in &aliases {
            by_alias.insert(alias.clone(), index);
        }
        records.push(UnifiedRecord {
            daemon: Some(summary),
            saved: None,
            status,
            status_label,
            identity,
            aliases,
            section,
            search,
            search_score: None,
        });
    }

    for row in saved {
        let aliases = saved_aliases(row);
        let Some(identity) = aliases.first().cloned() else {
            continue;
        };
        let joined = aliases
            .iter()
            .find_map(|alias| by_alias.get(alias))
            .copied();
        if let Some(index) = joined {
            // Saved data enriches the live record's durable fields.
            let record = &mut records[index];
            record.saved = Some(row.clone());
            for alias in &aliases {
                if !record.aliases.contains(alias) {
                    record.aliases.push(alias.clone());
                }
                by_alias.insert(alias.clone(), index);
            }
            let live = daemon_search_text(record.daemon.as_ref().unwrap_or(&Value::Null));
            let saved_text = saved_search_text(row);
            record.search = enrich_search_text(&live, &saved_text);
            continue;
        }
        let index = records.len();
        let search = saved_search_text(row);
        for alias in &aliases {
            by_alias.insert(alias.clone(), index);
        }
        records.push(UnifiedRecord {
            daemon: None,
            saved: Some(row.clone()),
            status: None,
            status_label: None,
            identity,
            aliases,
            section: Section::Inactive,
            search,
            search_score: None,
        });
    }
    records
}

fn parse_status(status: &str) -> Option<AgentRosterStatus> {
    match status {
        "running" => Some(AgentRosterStatus::Running),
        "idle" => Some(AgentRosterStatus::Idle),
        "inactive" => Some(AgentRosterStatus::Inactive),
        _ => None,
    }
}

/// The merged summary a row renders and acts on (TS `summaryForUnifiedRecord`):
/// the live summary when one exists, with saved fields filling the gaps;
/// saved-only records synthesize the archived shape.
pub fn summary_for_record(record: &UnifiedRecord) -> Value {
    let saved = record.saved.as_ref();
    if let Some(daemon) = &record.daemon {
        let mut merged = daemon.clone();
        if let Some(saved) = saved {
            // Saved fields only fill gaps in the live summary (TS
            // `summaryForUnifiedRecord`); live data stays authoritative.
            let enrich = |merged: &mut Value, field: &str, saved: &Value| {
                if merged.get(field).is_none_or(Value::is_null) {
                    if let Some(value) = saved.get(field).filter(|v| !v.is_null()) {
                        merged[field] = value.clone();
                    }
                }
            };
            enrich(
                &mut merged,
                "sessionName",
                &serde_json::json!({ "sessionName": saved.get("name") }),
            );
            enrich(&mut merged, "firstMessage", saved);
            enrich(&mut merged, "usage", saved);
            enrich(&mut merged, "sessionFile", saved);
            enrich(&mut merged, "parentSessionPath", saved);
            enrich(&mut merged, "created", saved);
            enrich(&mut merged, "modified", saved);
            enrich(
                &mut merged,
                "lastActivityAt",
                &serde_json::json!({ "lastActivityAt": saved.get("modified") }),
            );
            if merged.get("model").is_none_or(Value::is_null) {
                if let Some(model) = saved.get("model") {
                    merged["model"] = json_model(model);
                }
            }
            // The saved catalog row carries the persisted thinking level
            // (the daemon's `thinkingLevel`): it fills the same gap the
            // model does, so a row the live summary lost its level for
            // keeps rendering "model:level".
            enrich(&mut merged, "thinkingLevel", saved);
        }
        merged
    } else {
        let saved = saved.cloned().unwrap_or(Value::Null);
        let id = get_str(&saved, "id").unwrap_or_default().to_string();
        let modified = get_str(&saved, "modified").unwrap_or_default().to_string();
        let created = get_str(&saved, "created").unwrap_or_default().to_string();
        let mut summary = serde_json::json!({
            "id": id,
            "sessionId": id,
            "lifecycle": "archived",
            "activity": "idle",
            "isSessionActive": false,
            // TS synthesizes the runtime kind from the saved depth (a saved
            // child with a parent path but no depth is depth 1).
            "runtimeKind": if saved.get("rlmDepth").and_then(Value::as_u64)
                .unwrap_or(if saved.get("parentSessionPath").is_some() { 1 } else { 0 })
                > 0 { "subagent" } else { "top-level" },
            "cwd": saved.get("cwd").cloned().unwrap_or(Value::Null),
            "sessionFile": saved.get("path").cloned().unwrap_or(Value::Null),
            "parentSessionPath": saved.get("parentSessionPath").cloned().unwrap_or(Value::Null),
            "rlmDepth": saved.get("rlmDepth").cloned().unwrap_or(Value::Null),
            "sessionName": saved.get("name").cloned().unwrap_or(Value::Null),
            "isStreaming": false,
            "isCompacting": false,
            "attachedClients": 0,
            "messageCount": saved.get("messageCount").cloned().unwrap_or(Value::Null),
            "created": created,
            "modified": modified,
            "lastActivityAt": modified,
            "firstMessage": saved.get("firstMessage").cloned().unwrap_or(Value::Null),
            "model": json_model(saved.get("model").unwrap_or(&Value::Null)),
            "thinkingLevel": saved.get("thinkingLevel").cloned().unwrap_or(Value::Null),
        });
        // A saved row without a persisted level stays key-absent, like the
        // daemon's saved-session summary rows.
        if summary.get("thinkingLevel").is_none_or(Value::is_null) {
            if let Some(object) = summary.as_object_mut() {
                object.remove("thinkingLevel");
            }
        }
        summary
    }
}

fn json_model(model: &Value) -> Value {
    let model_id = model.get("modelId").cloned().unwrap_or(Value::Null);
    let provider = model.get("provider").cloned().unwrap_or(Value::Null);
    serde_json::json!({ "id": model_id, "provider": provider })
}

/// Hide abandoned empty catalog rows (TS `filterEmptyAgentsViewSessions`):
/// an inactive row with no messages, name, usage, or transcript stays out
/// unless the session is the view's anchor.
pub fn filter_empty_sessions(records: &[UnifiedRecord], preserved: &[&str]) -> Vec<UnifiedRecord> {
    // Ancestors of every kept row stay visible (TS filterEmpty… retains the
    // parent chain): nesting must never orphan a child whose parent record
    // looks empty.
    let by_alias: HashMap<&str, usize> = records
        .iter()
        .enumerate()
        .flat_map(|(index, record)| {
            record
                .aliases
                .iter()
                .map(move |alias| (alias.as_str(), index))
        })
        .collect();
    let mut retained = vec![false; records.len()];
    let keep = |index: usize, retained: &mut Vec<bool>| {
        let mut current = Some(index);
        while let Some(position) = current {
            if retained[position] {
                break;
            }
            retained[position] = true;
            current = parent_keys(&records[position])
                .iter()
                .find_map(|key| by_alias.get(key.as_str()))
                .copied();
        }
    };
    for (index, record) in records.iter().enumerate() {
        let summary = summary_for_record(record);
        let keep_row = record.section != Section::Inactive
            || get_str(&summary, "activeSessionId").is_some()
            || summary.get("isSessionActive") == Some(&Value::Bool(true))
            || summary
                .get("attachedClients")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > 0
            || summary
                .get("messageCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > 0
            || get_str(&summary, "sessionName").is_some()
            || get_str(&summary, "firstMessage")
                .is_some_and(|text| !text.trim().is_empty() && text.trim() != "(no messages)")
            || summary
                .get("usage")
                .and_then(|usage| usage.get("cost"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                > 0.0
            || crate::agents_view_forest::is_subagent_summary(&summary)
            || get_str(&summary, "sessionId").is_some_and(|id| preserved.contains(&id));
        if keep_row {
            keep(index, &mut retained);
        }
    }
    records
        .iter()
        .enumerate()
        .filter(|(index, _)| retained[*index])
        .map(|(_, record)| record.clone())
        .collect()
}

pub use crate::agents_view_search::{parse_search_query, ParsedSearchQuery, SessionSearchText};

/// The keys by which a record's parent is referenced (TS `getParentKeys`).
fn parent_keys(record: &UnifiedRecord) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(daemon) = &record.daemon {
        for field in ["parentActiveSessionId", "parentSessionId"] {
            if let Some(id) = get_str(daemon, field) {
                let prefix = if field == "parentActiveSessionId" {
                    "active"
                } else {
                    "session"
                };
                keys.push(format!("{prefix}:{id}"));
            }
        }
        if let Some(path) = get_str(daemon, "parentSessionPath") {
            keys.push(file_identity(path));
        }
    }
    if let Some(parent) = record
        .saved
        .as_ref()
        .and_then(|saved| get_str(saved, "parentSessionPath"))
    {
        keys.push(file_identity(parent));
    }
    keys
}
/// TS `filterUnifiedSessions`: keep the matching records plus every
/// ancestor, so the hierarchy leading to a match stays reachable (a child
/// hit keeps its parent rows in the set). Catalog order decides nesting;
/// hits carry their relevance score (`search_score`, lower is better) for
/// the view's ranked rendering, retained ancestors keep `None`.
pub fn filter_unified_sessions(
    records: &[UnifiedRecord],
    query: &ParsedSearchQuery,
) -> Vec<UnifiedRecord> {
    let by_alias: HashMap<&str, usize> = records
        .iter()
        .enumerate()
        .flat_map(|(index, record)| {
            record
                .aliases
                .iter()
                .map(move |alias| (alias.as_str(), index))
        })
        .collect();
    let mut retained = vec![false; records.len()];
    let mut scores = vec![None; records.len()];
    for index in 0..records.len() {
        // Every directly matching record carries its score, even one
        // already retained as an ancestor of an earlier hit.
        let Some(score) = score_search(&records[index].search, query) else {
            continue;
        };
        scores[index] = Some(score);
        if retained[index] {
            continue;
        }
        let mut current = Some(index);
        while let Some(i) = current {
            if retained[i] {
                break;
            }
            retained[i] = true;
            current = parent_keys(&records[i])
                .iter()
                .find_map(|key| by_alias.get(key.as_str()))
                .copied();
        }
    }
    records
        .iter()
        .enumerate()
        .filter(|(index, _)| retained[*index])
        .map(|(index, record)| {
            let mut record = record.clone();
            record.search_score = scores[index];
            record
        })
        .collect()
}

/// Epoch milliseconds from an RFC 3339 timestamp (`YYYY-MM-DDTHH:MM:SS.sssZ`).
fn iso_to_unix_ms(iso: &str) -> Option<i64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || (bytes[10] != b'T' && bytes[10] != b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year: i64 = iso.get(0..4)?.parse().ok()?;
    let month: i64 = iso.get(5..7)?.parse().ok()?;
    let day: i64 = iso.get(8..10)?.parse().ok()?;
    let hour: i64 = iso.get(11..13)?.parse().ok()?;
    let minute: i64 = iso.get(14..16)?.parse().ok()?;
    let second: i64 = iso.get(17..19)?.parse().ok()?;
    let mut millis: i64 = 0;
    if bytes.len() > 20 && bytes[19] == b'.' {
        let digits: String = iso[20..].chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            let fraction: f64 = format!("0.{digits}").parse().ok()?;
            millis = (fraction * 1000.0) as i64;
        }
    }
    // Days from civil (Howard Hinnant's algorithm, as in pa-daemon's util).
    let years = if month <= 2 { year - 1 } else { year };
    let era = years.div_euclid(400);
    let year_of_era = years.rem_euclid(400);
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1000) + millis)
}

pub(crate) fn timestamp_ms(value: Option<&str>) -> i64 {
    value.and_then(iso_to_unix_ms).unwrap_or(0)
}

/// Relative age (`s`/`m`/`h`/`d`, TS `formatAgentsViewRelativeTime`).
pub fn relative_age(value: Option<&str>, now_ms: u64) -> String {
    let Some(ms) = value.and_then(iso_to_unix_ms) else {
        return String::new();
    };
    let seconds = ((now_ms as i64 - ms) / 1000).max(0) as u64;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    format!("{}d", hours / 24)
}

/// The column layout of the list (TS `buildCompactAgentsViewLayout`).
pub struct RowLayout {
    pub legend: String,
    pub name_width: usize,
    pub model_width: usize,
    pub activity_width: usize,
    pub details: HashMap<String, String>,
}

fn table_cell(value: &str, width: usize) -> String {
    let truncated = truncate_text(value, width);
    format!(
        "{truncated}{}",
        " ".repeat(width.saturating_sub(str_width(&truncated)))
    )
}

/// Hard-truncate to a display width (no ellipsis, TS `truncateToWidth(_, "")`).
pub(crate) fn truncate_text(value: &str, width: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for ch in value.chars() {
        let ch_width = crate::width::char_width(ch);
        if used + ch_width > width {
            break;
        }
        out.push(ch);
        used += ch_width;
    }
    out
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn pad_start(value: &str, width: usize) -> String {
    format!(
        "{}{value}",
        " ".repeat(width.saturating_sub(str_width(value)))
    )
}

/// Compute the compact column layout for the rows at `width`.
pub fn build_layout(rows: &[crate::agents_view_forest::AgentsViewRow], width: usize) -> RowLayout {
    let cost_width = rows
        .iter()
        .map(|row| str_width(&format!("${:.2}", row.cost)))
        .max()
        .unwrap_or(0)
        .max(4);
    let age_width = rows
        .iter()
        .map(|row| str_width(&row.age))
        .max()
        .unwrap_or(0)
        .max(3);
    let details_width = cost_width + 2 + age_width;
    let available = width.saturating_sub(details_width + 4);
    let desired_model = rows
        .iter()
        .map(|row| str_width(&row.model))
        .max()
        .unwrap_or(0)
        .max(12);
    let model_width = desired_model.min(32).min(available.saturating_sub(12));
    let name_width = (available.saturating_sub(model_width)).min(28);
    let activity_width = available.saturating_sub(model_width + name_width + 2);
    let detail_line = |cost: &str, age: &str| {
        format!(
            "{}  {}",
            pad_start(cost, cost_width),
            pad_start(age, age_width)
        )
    };
    let mut headings = vec![
        table_cell("Session", name_width),
        table_cell("Model", model_width),
    ];
    if activity_width > 0 {
        headings.push(table_cell("Activity", activity_width));
    }
    headings.push(detail_line("Cost", "Age"));
    let details = rows
        .iter()
        .map(|row| {
            (
                row.identity.clone(),
                detail_line(&format!("${:.2}", row.cost), &row.age),
            )
        })
        .collect();
    RowLayout {
        legend: table_cell(&headings.join("  "), width),
        name_width,
        model_width,
        activity_width,
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents_view_forest::session_title;
    use serde_json::json;

    fn roster_entry(agent: &str, status: &str, summary: Value) -> Value {
        json!({ "agentId": agent, "status": status, "summary": summary })
    }

    #[test]
    fn reconcile_joins_live_and_saved_by_alias() {
        let roster = vec![roster_entry(
            "s1",
            "idle",
            json!({ "sessionId": "s1", "lifecycle": "live", "activeSessionId": "a1", "sessionFile": "/x/s1.jsonl", "firstMessage": "fix the bug" }),
        )];
        let saved = vec![json!({
            "id": "s1",
            "path": "/x/s1.jsonl",
            "name": "Bug fix",
            "messageCount": 4,
        })];
        let records = reconcile_unified_sessions(&roster, &saved);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].section, Section::Idle);
        assert_eq!(records[0].identity, "file:/x/s1.jsonl");
        assert_eq!(records[0].search.name, "Bug fix");
        assert_eq!(records[0].search.id, "s1");
        let summary = summary_for_record(&records[0]);
        assert_eq!(summary["firstMessage"], "fix the bug");
        assert_eq!(summary["sessionName"], "Bug fix");
    }

    /// TS `shouldShowAgentsViewSession`: only live roster rows render — a
    /// message-less top-level draft (lifecycle "draft") never surfaces a
    /// roster row, and a message-less subagent worker is live and visible.
    #[test]
    fn reconcile_hides_draft_roster_rows() {
        let roster = vec![
            roster_entry(
                "draft",
                "idle",
                json!({
                    "sessionId": "draft",
                    "lifecycle": "draft",
                    "activeSessionId": "d1",
                    "sessionFile": "/x/draft.jsonl",
                }),
            ),
            roster_entry(
                "child",
                "idle",
                json!({
                    "sessionId": "child",
                    "lifecycle": "live",
                    "runtimeKind": "subagent",
                    "rlmChildId": "kid",
                    "parentSessionPath": "/x/parent.jsonl",
                    "messageCount": 0,
                }),
            ),
        ];
        let records = reconcile_unified_sessions(&roster, &[]);
        assert_eq!(records.len(), 1);
        assert_eq!(
            get_str(records[0].daemon.as_ref().unwrap(), "sessionId"),
            Some("child")
        );
    }

    /// The persisted thinking level reaches the rendered summary both ways:
    /// the saved catalog row fills a live summary that lost its level, and a
    /// saved-only record carries it directly (TS renders "model:level" for
    /// every session kind; `session_model` shows it whenever present).
    #[test]
    fn summary_merges_the_saved_thinking_level() {
        // The live roster row lost its level (a passivated or restarted
        // worker); the saved catalog row carries the persisted one.
        let roster = vec![roster_entry(
            "s1",
            "idle",
            json!({
                "sessionId": "s1", "lifecycle": "live", "activeSessionId": "a1",
                "sessionFile": "/x/s1.jsonl",
                "model": { "id": "mock-1", "provider": "battery" },
            }),
        )];
        let saved = vec![json!({
            "id": "s1",
            "path": "/x/s1.jsonl",
            "model": { "provider": "battery", "modelId": "mock-1" },
            "thinkingLevel": "high",
            "messageCount": 2,
        })];
        let records = reconcile_unified_sessions(&roster, &saved);
        let summary = summary_for_record(&records[0]);
        assert_eq!(summary["thinkingLevel"], json!("high"));
        // The live summary's own level wins over the saved one.
        let roster_with_level = vec![roster_entry(
            "s1",
            "idle",
            json!({
                "sessionId": "s1", "lifecycle": "live", "activeSessionId": "a1",
                "sessionFile": "/x/s1.jsonl",
                "model": { "id": "mock-1", "provider": "battery" },
                "thinkingLevel": "medium",
            }),
        )];
        let records = reconcile_unified_sessions(&roster_with_level, &saved);
        let summary = summary_for_record(&records[0]);
        assert_eq!(summary["thinkingLevel"], json!("medium"));

        // A saved-only record synthesizes its summary with the level.
        let saved_only = vec![json!({
            "id": "s2",
            "path": "/x/s2.jsonl",
            "model": { "provider": "battery", "modelId": "mock-1" },
            "thinkingLevel": "high",
            "messageCount": 3,
        })];
        let records = reconcile_unified_sessions(&[], &saved_only);
        let summary = summary_for_record(&records[0]);
        assert_eq!(summary["thinkingLevel"], json!("high"));
        // And the rendered Model column shows "model:level".
        assert_eq!(
            crate::agents_view_forest::session_model(&summary),
            "mock-1:high"
        );
        // A saved row without a level stays bare.
        let bare = vec![json!({ "id": "s3", "path": "/x/s3.jsonl", "messageCount": 3 })];
        let records = reconcile_unified_sessions(&[], &bare);
        assert!(summary_for_record(&records[0])
            .get("thinkingLevel")
            .is_none());
    }

    #[test]
    fn saved_only_rows_are_inactive_and_survive_the_empty_filter() {
        let saved = vec![json!({
            "id": "s2",
            "path": "/x/s2.jsonl",
            "firstMessage": "hello world",
            "messageCount": 3,
        })];
        let records = reconcile_unified_sessions(&[], &saved);
        assert_eq!(records[0].section, Section::Inactive);
        let filtered = filter_empty_sessions(&records, &[]);
        assert_eq!(filtered.len(), 1);
        // An empty unnamed saved row hides unless it is preserved.
        let empty = vec![json!({ "id": "s3", "path": "/x/s3.jsonl", "messageCount": 0 })];
        let records = reconcile_unified_sessions(&[], &empty);
        assert!(filter_empty_sessions(&records, &[]).is_empty());
        assert_eq!(filter_empty_sessions(&records, &["s3"]).len(), 1);
    }

    #[test]
    fn rows_sort_by_section_then_recency() {
        let roster = vec![
            roster_entry(
                "idle-old",
                "idle",
                json!({ "sessionId": "i", "lifecycle": "live", "created": "2024-01-01T00:00:00.000Z" }),
            ),
            roster_entry(
                "run",
                "running",
                json!({ "sessionId": "r", "lifecycle": "live" }),
            ),
        ];
        let saved = vec![json!({
            "id": "arch",
            "path": "/x/arch.jsonl",
            "firstMessage": "old chat",
            "messageCount": 2,
        })];
        let records = reconcile_unified_sessions(&roster, &saved);
        let rows = crate::agents_view_forest::build_rows(
            &records,
            None,
            &Default::default(),
            &Default::default(),
            &Default::default(),
            None,
        );
        assert_eq!(rows[0].section, Section::Running);
        assert_eq!(rows[1].section, Section::Idle);
        assert_eq!(rows[2].section, Section::Inactive);
        // TS renderRow: no `lastHeardFromAt`/`statusLabel` on the summary
        // means no activity text, even for an archived saved session.
        assert_eq!(rows[2].status_label, "");
        assert_eq!(rows[2].activity, "");
        assert_eq!(rows[2].model, "-");
    }

    #[test]
    fn search_matches_the_restricted_corpus_case_insensitively() {
        // The picker corpus is the session NAME, the durable ID, and the
        // CWD; the TS corpus fields — first message, transcript text,
        // file paths — never match.
        let saved = vec![json!({
            "id": "sess-alpha",
            "path": "/x/alpha.jsonl",
            "name": "RoSTER worker",
            "firstMessage": "deploy the Gateway",
            "allMessagesText": "the gateway probe returned 503 twice",
            "cwd": "/home/u/API-server",
            "parentSessionPath": "/x/parent.jsonl",
        })];
        let records = reconcile_unified_sessions(&[], &saved);
        let targets = &records[0].search;
        for query in ["alpha", "roster", "ROSTER", "api-server", "sess-al"] {
            let parsed = parse_search_query(query);
            assert!(
                score_search(targets, &parsed).is_some(),
                "query {query:?} should match the restricted corpus"
            );
        }
        // Partial words need the fuzzy path on the name (ordered
        // subsequence).
        assert!(score_search(targets, &parse_search_query("rtwr")).is_some());
        // Content fields are gone from the picker: first messages, the
        // capped transcript, and file paths never match.
        for query in [
            "deploy the gateway",
            "GATEWAY PROBE",
            "gateway deploy finished",
            "alpha.jsonl",
            "parent.jsonl",
            "503",
            "zebra",
        ] {
            let parsed = parse_search_query(query);
            assert!(
                score_search(targets, &parsed).is_none(),
                "query {query:?} must not match content or path fields"
            );
        }
    }

    #[test]
    fn merged_records_take_the_live_name() {
        // A merged record: live daemon summary plus saved enrichment.
        let roster = vec![roster_entry(
            "s1",
            "idle",
            json!({
                "sessionId": "s1",
                "lifecycle": "live",
                "activeSessionId": "a1",
                "sessionFile": "/x/s1.jsonl",
                "sessionName": "tuned retry policy",
                "cwd": "/work/retry",
            }),
        )];
        let saved = vec![json!({
            "id": "s1",
            "path": "/x/s1.jsonl",
            "name": "stale catalog name",
            "allMessagesText": "we bumped the backoff ceiling to 30s",
        })];
        let records = reconcile_unified_sessions(&roster, &saved);
        assert_eq!(records.len(), 1);
        // Daemon data wins for the merged targets; the saved transcript
        // stays out of the corpus.
        assert_eq!(records[0].search.name, "tuned retry policy");
        assert_eq!(records[0].search.id, "s1");
        assert_eq!(records[0].search.cwd, "/work/retry");
        assert!(score_search(&records[0].search, &parse_search_query("retry")).is_some());
        assert!(score_search(&records[0].search, &parse_search_query("backoff")).is_none());
    }

    #[test]
    fn search_retains_the_ancestors_of_a_match() {
        // A saved child session whose parentSessionPath names the parent
        // row: a query matching only the child keeps the parent visible
        // (TS `filterUnifiedSessions` ancestor retention).
        let saved = vec![
            json!({
                "id": "parent",
                "path": "/x/parent.jsonl",
                "name": "root agent",
                "firstMessage": "orchestrate",
                "messageCount": 1,
            }),
            json!({
                "id": "child",
                "path": "/x/child.jsonl",
                "parentSessionPath": "/x/parent.jsonl",
                "name": "child agent",
                "firstMessage": "find the fibonacci bug",
                "messageCount": 1,
            }),
        ];
        // "child" hits the child row's NAME (the corpus no longer
        // carries first messages), and the parent stays as its ancestor.
        let records = reconcile_unified_sessions(&[], &saved);
        let filtered = filter_unified_sessions(&records, &parse_search_query("child"));
        let titles: Vec<&str> = filtered
            .iter()
            .map(|record| {
                get_str(record.saved.as_ref().unwrap_or(&Value::Null), "name").unwrap_or_default()
            })
            .collect();
        assert_eq!(titles, vec!["root agent", "child agent"]);
        // An unrelated query matches nothing, and the parent alone matches
        // only its own query.
        assert!(filter_unified_sessions(&records, &parse_search_query("zebra")).is_empty());
        let parent_only = filter_unified_sessions(&records, &parse_search_query("root"));
        assert_eq!(parent_only.len(), 1);
        assert_eq!(
            get_str(parent_only[0].saved.as_ref().unwrap(), "name"),
            Some("root agent")
        );
    }

    #[test]
    fn title_prefers_name_then_first_message() {
        let named = json!({ "sessionId": "s1", "sessionName": "  My  session ", "cwd": "/a/b" });
        assert_eq!(session_title(&named), "My session");
        let from_cwd = json!({ "sessionId": "s1", "cwd": "/a/b" });
        assert_eq!(session_title(&from_cwd), "b");
        let bare = json!({ "sessionId": "s1" });
        assert_eq!(session_title(&bare), "s1");
    }

    #[test]
    fn relative_age_buckets() {
        // Base: 2025-01-01T00:00:00Z.
        let base = 1_735_689_600u64;
        let iso = |seconds: i64, minutes: i64| {
            // The days-from-civil algorithm in reverse: 2025-01-01 plus
            // (seconds, minutes) offsets is still within January 2025.
            let total = base as i64 + seconds + minutes * 60;
            let days = total.div_euclid(86_400);
            let secs_of_day = total.rem_euclid(86_400);
            let (year, month, day) = civil_test(days);
            format!(
                "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
                secs_of_day / 3600,
                (secs_of_day % 3600) / 60,
                secs_of_day % 60
            )
        };
        let now = base * 1000;
        assert_eq!(relative_age(Some(&iso(-30, 0)), now), "30s");
        assert_eq!(relative_age(Some(&iso(0, -5)), now), "5m");
        assert_eq!(relative_age(Some(&iso(0, -3 * 60)), now), "3h");
        assert_eq!(relative_age(Some(&iso(0, -30 * 60 * 24)), now), "30d");
        assert_eq!(relative_age(None, now), "");
    }

    /// Civil date from days since epoch (test-side oracle: the same Hinnant
    /// algorithm the parser uses, so a round-trip pins the bucketing).
    fn civil_test(days: i64) -> (i64, u32, u32) {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        (if m <= 2 { y + 1 } else { y }, m, d)
    }

    #[test]
    fn layout_legend_and_details() {
        let roster = vec![roster_entry(
            "s1",
            "running",
            json!({
                "sessionId": "s1",
                "lifecycle": "live",
                "usage": { "cost": 1.5 },
            }),
        )];
        let records = reconcile_unified_sessions(&roster, &[]);
        let rows = crate::agents_view_forest::build_rows(
            &records,
            None,
            &Default::default(),
            &Default::default(),
            &Default::default(),
            None,
        );
        let layout = build_layout(&rows, 120);
        assert!(layout.legend.contains("Session"));
        assert!(layout.legend.contains("Model"));
        assert!(layout.legend.contains("Cost"));
        assert_eq!(layout.details["session:s1"].trim_end(), "$1.50");
    }

    #[test]
    fn saved_only_age_reads_modified_first_and_falls_back_to_created() {
        // TS formatSessionDuration: a row without an activeSessionId is a
        // saved-only record - the age column reads `modified` first. The
        // daemon scan's `modified` is the durable fallback (header time,
        // then mtime), so an old record keeps its real age here; pin the
        // ordering so a days-old record can never read as minutes-old
        // through a scan-time value.
        let now = now_ms();
        let iso = |ms: i64| {
            let total = ms.div_euclid(1000);
            let days = total.div_euclid(86_400);
            let secs_of_day = total.rem_euclid(86_400);
            let (year, month, day) = civil_test(days);
            format!(
                "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
                secs_of_day / 3600,
                (secs_of_day % 3600) / 60,
                secs_of_day % 60
            )
        };
        let created_days_ago = iso(now as i64 - 3 * 86_400_000);
        let modified_minutes_ago = iso(now as i64 - 5 * 60_000);
        // The catalog contract the daemon serves: every row carries the
        // scan's durable `modified` (a real message timestamp, the header
        // time, or the file mtime) alongside `created`.
        let saved = vec![json!({
            "id": "old-record",
            "path": "/x/old-record.jsonl",
            "firstMessage": "old task",
            "messageCount": 2,
            "created": created_days_ago,
            "modified": modified_minutes_ago,
        })];
        let records = reconcile_unified_sessions(&[], &saved);
        let rows = crate::agents_view_forest::build_rows(
            &records,
            None,
            &Default::default(),
            &Default::default(),
            None,
        );
        let age = rows
            .iter()
            .find(|row| row.identity.contains("old-record"))
            .map_or_else(
                || {
                    panic!(
                        "no row for the old record, identities: {:?}",
                        rows.iter().map(|row| &row.identity).collect::<Vec<_>>()
                    )
                },
                |row| row.age.clone(),
            );
        // `modified` first: the column reads the durable last-activity
        // value, not `created` - and a scan-time fabrication would read
        // "0s" here, not the record's own five-minute-old value.
        assert_eq!(age, "5m");
    }
}
