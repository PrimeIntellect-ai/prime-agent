//! The data concern (moved with its concern): the cron-job wire shape, the catalog
//! rows, the scope/sort vocabulary, and the label/countdown helpers the view and the
//! columns render from.

use super::*;

/// One cron job as the view needs it (TS `AgentCronJob`), parsed from the
/// daemon's `heartbeats_list` wire shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeartbeatJob {
    pub id: String,
    /// `active` / `paused` (the catalog only carries these two).
    pub status: String,
    /// `heartbeat` (user) or `rlm_heartbeat` (agent).
    pub source: Option<String>,
    /// `steer` / `follow_up` (defaults to steer).
    pub delivery_mode: Option<String>,
    pub active_session_id: String,
    pub session_id: String,
    pub label: Option<String>,
    pub prompt: String,
    /// The schedule expression (TS `job.schedule.expression`).
    pub schedule_expression: String,
    pub created_at: String,
    pub next_run_at: Option<String>,
    pub last_error: Option<String>,
    pub run_count: u64,
}

impl HeartbeatJob {
    /// The job's status word, `active` or `paused`.
    pub(super) fn is_active(&self) -> bool {
        self.status == "active"
    }

    /// Whether an agent created this job (TS source label test).
    fn is_user_created(&self) -> bool {
        self.source.as_deref() == Some("heartbeat")
    }
}

/// One catalog row (TS `AgentConnectionHeartbeat`): a job plus the saved
/// session's display name and first message, when the daemon knows them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeartbeatEntry {
    pub job: HeartbeatJob,
    pub session_name: Option<String>,
    pub first_message: Option<String>,
}

/// Parse one cron-job wire object (TS `AgentCronJob`). `None` when the id
/// is missing: rows without a parseable id drop, matching the
/// supervisor's own id-keyed merge.
pub fn parse_heartbeat_job(job: &Value) -> Option<HeartbeatJob> {
    // Every daemon-supplied string renders somewhere in the view (the
    // table cells, the subtitle, the detail pairs): control characters
    // scrub at the parse boundary — an ANSI/OSC sequence in catalog data
    // can never execute terminal control operations when rendered.
    let text = |field: &str| {
        job.get(field)
            .and_then(Value::as_str)
            .map(crate::menu_panel::scrub_controls)
    };
    let id = text("id").filter(|id| !id.is_empty())?;
    Some(HeartbeatJob {
        id,
        status: text("status").unwrap_or_else(|| "active".to_string()),
        source: text("source"),
        delivery_mode: text("deliveryMode"),
        active_session_id: text("activeSessionId").unwrap_or_default(),
        session_id: text("sessionId").unwrap_or_default(),
        label: text("label").filter(|label| !label.trim().is_empty()),
        prompt: text("prompt").unwrap_or_default(),
        schedule_expression: job
            .get("schedule")
            .and_then(|schedule| schedule.get("expression"))
            .and_then(Value::as_str)
            .map(crate::menu_panel::scrub_controls)
            .unwrap_or_default(),
        created_at: text("createdAt").unwrap_or_default(),
        next_run_at: text("nextRunAt"),
        last_error: text("lastError"),
        run_count: job
            .get("runCount")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
    })
}

/// Parse the daemon `heartbeats_list` response data (the `heartbeats`
/// array) into catalog rows.
pub fn parse_heartbeats(data: &Value) -> Vec<HeartbeatEntry> {
    let Some(rows) = data.get("heartbeats").and_then(Value::as_array) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let job = parse_heartbeat_job(row.get("job")?)?;
            Some(HeartbeatEntry {
                job,
                session_name: row
                    .get("sessionName")
                    .and_then(Value::as_str)
                    .map(crate::menu_panel::scrub_controls),
                first_message: row
                    .get("firstMessage")
                    .and_then(Value::as_str)
                    .map(crate::menu_panel::scrub_controls),
            })
        })
        .collect()
}

/// TS `scopeHeartbeatsToSession`: a heartbeat is in scope when its durable
/// session matches `session_id`, or its live session is the current one or
/// one of the session's RLM children. No session identity shows nothing.
pub fn scope_heartbeats(
    entries: Vec<HeartbeatEntry>,
    active_session_id: Option<&str>,
    session_id: Option<&str>,
    child_active_session_ids: &[String],
) -> Vec<HeartbeatEntry> {
    let Some(session_id) = session_id.filter(|id| !id.is_empty()) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter(|entry| {
            entry.job.session_id == session_id
                || (active_session_id.is_some()
                    && entry.job.active_session_id == active_session_id.unwrap_or_default())
                || child_active_session_ids.contains(&entry.job.active_session_id)
        })
        .collect()
}

/// TS `HeartbeatManagerComponent.heartbeats` sort: session label, then
/// user-created before agent-created, then creation time.
pub fn sort_heartbeats(entries: &mut [HeartbeatEntry]) {
    entries.sort_by(|left, right| {
        let session_order = session_label(left).cmp(&session_label(right));
        if session_order != std::cmp::Ordering::Equal {
            return session_order;
        }
        // User-created (`heartbeat`) rows first: `false` sorts before
        // `true`, so `!user_created` orders user rows ahead of agent rows.
        let source_order = (!left.job.is_user_created()).cmp(&!right.job.is_user_created());
        if source_order != std::cmp::Ordering::Equal {
            return source_order;
        }
        left.job.created_at.cmp(&right.job.created_at)
    });
}

/// TS `sessionLabel`: the saved session's name, else its first message,
/// else the durable session id (all single-line).
pub fn session_label(entry: &HeartbeatEntry) -> String {
    entry
        .session_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(single_line)
        .or_else(|| {
            entry
                .first_message
                .as_deref()
                .map(single_line)
                .filter(|message| !message.is_empty())
        })
        .unwrap_or_else(|| entry.job.session_id.clone())
}

/// TS `sourceLabel`.
pub fn source_label(entry: &HeartbeatEntry) -> &'static str {
    if entry.job.is_user_created() {
        "Created by you"
    } else {
        "Created by agent"
    }
}

/// TS `defaultHeartbeatName`.
pub fn default_heartbeat_name(entry: &HeartbeatEntry) -> &'static str {
    if entry.job.is_user_created() {
        "Your heartbeat"
    } else {
        "Agent-created heartbeat"
    }
}

/// TS `singleLine`: collapse all whitespace runs to single spaces.
pub fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// TS `formatTimestamp`: ISO timestamps cut to `YYYY-MM-DD HH:MM`.
pub fn format_timestamp(value: &str) -> String {
    let Some(cut) = value.get(..16) else {
        return value.to_string();
    };
    let formatted = cut.replacen('T', " ", 1);
    if formatted.contains(' ') && formatted.len() == 16 {
        formatted
    } else {
        value.to_string()
    }
}

/// The next-run label in natural language ("in 45s", "in 5m", "in 10h").
/// The unit rules mirror TS `formatHeartbeatCountdown`: rounded seconds
/// under a minute, then rounded minutes, hours, and days, with a
/// one-second floor so a due or overdue run reads "in 1s". The `in `
/// prefix is the operator's wording (2026-09-26 directive) — TS renders
/// the bare countdown in its agents view and a raw timestamp in its
/// manager, both superseded here. A missing next run keeps the `—`
/// placeholder; a value the clock cannot parse renders raw.
pub fn next_run_label(next_run_at: Option<&str>, now_ms: u64) -> String {
    let Some(value) = next_run_at else {
        return "\u{2014}".to_string();
    };
    let Some(at) = crate::agents_view_state::iso_to_unix_ms(value) else {
        return value.to_string();
    };
    let delta = ((at - now_ms as i64).max(0) as f64) / 1000.0;
    let seconds = (delta.round() as i64).max(1);
    if seconds < 60 {
        return format!("in {seconds}s");
    }
    let minutes = ((seconds as f64) / 60.0).round() as i64;
    if minutes < 60 {
        return format!("in {minutes}m");
    }
    let hours = ((minutes as f64) / 60.0).round() as i64;
    if hours < 24 {
        return format!("in {hours}h");
    }
    let days = ((hours as f64) / 24.0).round() as i64;
    format!("in {days}d")
}
