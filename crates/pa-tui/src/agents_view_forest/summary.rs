use serde_json::Value;

use super::SelectionKey;

/// A summary field's non-empty string value.
fn get_str<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// The model column text: the bare model id plus `:level` when a thinking
/// level is active ("off" reads as noise and stays bare).
pub(crate) fn session_model(summary: &Value) -> String {
    // Live workers publish the model object with `id` (the engine's
    // `model_metadata`); seeded roster rows and saved-session rows carry
    // `modelId` (the persisted selector). Both read as the full model id.
    let Some(id) = get_str(summary, "model")
        .or_else(|| {
            summary
                .get("model")
                .and_then(|model| model.get("id").or_else(|| model.get("modelId")))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
        })
        .or_else(|| {
            // Remote mesh rows carry a display-only model identity (their
            // daemon's full model object never crosses the wire; TS #2516
            // `remoteModel`).
            summary
                .get("remoteModel")
                .and_then(|model| model.get("modelId"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
        })
    else {
        return "-".to_string();
    };
    let bare = id.rsplit('/').next().unwrap_or(id).to_string();
    match get_str(summary, "thinkingLevel") {
        Some(level) if level != "off" => format!("{bare}:{level}"),
        _ => bare,
    }
}

#[must_use]
pub fn session_title(summary: &Value) -> String {
    let cwd_basename = get_str(summary, "cwd").map(|cwd| {
        std::path::Path::new(cwd)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    });
    for candidate in [
        get_str(summary, "sessionName"),
        get_str(summary, "firstMessage"),
        cwd_basename.as_deref(),
        get_str(summary, "sessionId"),
        get_str(summary, "id"),
    ] {
        let normalized = candidate
            .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        if !normalized.is_empty() {
            return normalized;
        }
    }
    "Untitled agent".to_string()
}

/// A remote row publishes a peer's own session ids, so every id-derived
/// key scopes them to their host (TS #2516 `identityScope`): a local
/// session with the same ids keeps its own row, its own identity, and
/// its own selection.
#[must_use]
pub fn identity_scope(summary: &Value) -> String {
    summary
        .get("remoteHost")
        .and_then(Value::as_str)
        .filter(|host| !host.is_empty())
        .map(|host| format!("remote:{host}:"))
        .unwrap_or_default()
}

/// The stable row identity of one summary (TS `getAgentsViewSummaryIdentity`):
/// the roster-qualified child id for subagents, else file, active, session.
/// Remote rows scope their id identities by host (TS #2516's review fix:
/// hiding a local live copy must never hide a remote row that shares its
/// ids).
#[must_use]
pub fn summary_identity(summary: &Value) -> String {
    let get = |field: &str| {
        summary
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    if get("runtimeKind") == Some("subagent") && summary.get("rlmChildId").is_some() {
        return format!(
            "agent:{}",
            pa_types::daemon::agent_roster::roster_agent_id_for_summary(summary)
        );
    }
    let scope = identity_scope(summary);
    if let Some(file) = get("sessionFile") {
        return format!("file:{file}");
    }
    if let Some(active) = get("activeSessionId") {
        return format!("{scope}active:{active}");
    }
    format!("{scope}session:{}", get("sessionId").unwrap_or_default())
}

/// The selection key of one summary (TS `getAgentsViewSelectionKey`): the
/// id fallbacks carry the row's `remoteHost`, so they only match rows in
/// the same host scope (TS #2516's review fix: a local session that
/// reuses a remote row's ids can never take that row's selection).
#[must_use]
pub fn selection_key(summary: &Value) -> SelectionKey {
    let get = |field: &str| {
        summary
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    SelectionKey {
        session_id: get("sessionId"),
        active_session_id: get("activeSessionId"),
        remote_host: get("remoteHost"),
    }
}
