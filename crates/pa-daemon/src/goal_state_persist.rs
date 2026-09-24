//! Durable thread-goal state: the read half of the `thread_goal_state`
//! persistence contract. The worker's session file is the one durable store
//! (TS keeps a single session store, so `_loadPersistedGoalState` reads the
//! same rows `appendCustomEntry` wrote); the daemon engine's in-memory
//! branch is fresh on every build, so a recovery rebuild rehydrates the
//! goal driver from the file's latest `thread_goal_state` custom entry —
//! status, objective, usage counters, and continuation counts included.

use pa_core::goals::{
    is_persisted_goal_state, normalize_goal_state, GoalState, GOAL_STATE_CUSTOM_TYPE,
};
use pa_types::session::FileEntry;
use serde_json::Value;
use std::path::Path;

use crate::session_store::SessionFile;

/// The session's last persisted goal state: the latest valid
/// `thread_goal_state` custom entry on the file's branch (TS
/// `_loadPersistedGoalState`, which scans the branch newest-first).
/// `None` when the file is missing, unreadable, or carries no valid goal
/// entry — the caller keeps the fresh driver's empty state, exactly the
/// TS fallthrough to `emptyGoalState()`.
pub(crate) fn persisted_goal_state(path: Option<&Path>) -> Option<GoalState> {
    let path = path?;
    if let Ok(Some(window)) = pa_core::session::window::WindowedSessionStore::open(path) {
        return window.goal_state().cloned();
    }
    let file = SessionFile::open(path).ok()?;
    file.branch()
        .iter()
        .rev()
        .find_map(|entry| goal_state_from_raw(&entry.type_, &entry.fields))
}

/// The same scan over a moved branch's entries (a tree navigation that
/// lands before the first build re-seeds the session onto that branch;
/// the branch's own latest goal entry wins, faithful branch semantics).
pub(crate) fn goal_state_in_branch(entries: &[FileEntry]) -> Option<GoalState> {
    entries.iter().rev().find_map(|entry| match entry {
        FileEntry::Custom { payload, .. } => {
            let data = payload.data.clone().unwrap_or(Value::Null);
            (payload.custom_type == GOAL_STATE_CUSTOM_TYPE)
                .then(|| goal_state_from_value(&data))
                .flatten()
        }
        _ => None,
    })
}

/// Parse one persisted entry (raw store shape: `customType`/`data` fields)
/// into the normalized goal state, validating like the TS
/// `isPersistedGoalState` guard before parsing.
fn goal_state_from_raw(type_: &str, fields: &Value) -> Option<GoalState> {
    if type_ != "custom" {
        return None;
    }
    if fields.get("customType").and_then(Value::as_str) != Some(GOAL_STATE_CUSTOM_TYPE) {
        return None;
    }
    goal_state_from_value(fields.get("data").unwrap_or(&Value::Null))
}

fn goal_state_from_value(data: &Value) -> Option<GoalState> {
    if !is_persisted_goal_state(data) {
        return None;
    }
    let parsed: GoalState = serde_json::from_value(data.clone()).ok()?;
    Some(normalize_goal_state(parsed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_core::goals::{empty_goal_state, GoalStatus};
    use pa_types::session::SessionHeader;
    use serde_json::json;

    fn custom_goal_entry(data: Value) -> FileEntry {
        FileEntry::Custom {
            payload: pa_types::session::CustomEntry {
                custom_type: GOAL_STATE_CUSTOM_TYPE.to_string(),
                data: Some(data),
                rest: pa_types::JsonMap::new(),
            },
            base: pa_types::session::EntryBase {
                id: Some("g1".to_string()),
                parent_id: None,
                timestamp: None,
                rest: pa_types::JsonMap::new(),
            },
        }
    }

    fn session_file_with_goal_rows(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("session.jsonl");
        let header = json!({
            "type": "session",
            "version": 3,
            "id": "goal-session",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "cwd": dir.display().to_string(),
        });
        let user_row = json!({
            "type": "message",
            "id": "m1",
            "timestamp": "2026-01-01T00:00:01.000Z",
            "message": { "role": "user", "content": "hi", "timestamp": 0 },
        });
        let first_goal = json!({
            "type": "custom",
            "id": "g1",
            "parentId": "m1",
            "timestamp": "2026-01-01T00:00:02.000Z",
            "customType": GOAL_STATE_CUSTOM_TYPE,
            "data": {
                "active": true,
                "status": "active",
                "goalId": "goal-1",
                "objective": "ship the port",
                "tokensUsed": 100,
                "timeUsedSeconds": 5,
                "continuationsUsed": 1,
            },
        });
        let second_goal = json!({
            "type": "custom",
            "id": "g2",
            "parentId": "g1",
            "timestamp": "2026-01-01T00:00:03.000Z",
            "customType": GOAL_STATE_CUSTOM_TYPE,
            "data": {
                "active": true,
                "status": "active",
                "goalId": "goal-1",
                "objective": "ship the port",
                "tokenBudget": 2000,
                "tokensUsed": 340,
                "timeUsedSeconds": 9,
                "continuationsUsed": 2,
            },
        });
        std::fs::write(
            &path,
            [header, user_row, first_goal, second_goal]
                .iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        path
    }

    #[test]
    fn latest_valid_entry_wins() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = session_file_with_goal_rows(dir.path());
        let state = persisted_goal_state(Some(&path)).expect("goal state");
        assert_eq!(state.status, GoalStatus::Active);
        assert_eq!(state.objective.as_deref(), Some("ship the port"));
        assert_eq!(state.goal_id.as_deref(), Some("goal-1"));
        assert_eq!(state.token_budget, Some(2000));
        assert_eq!(state.tokens_used, 340);
        assert_eq!(state.continuations_used, 2);
    }

    #[test]
    fn missing_or_invalid_files_answer_none() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(persisted_goal_state(None), None);
        assert_eq!(
            persisted_goal_state(Some(&dir.path().join("gone.jsonl"))),
            None
        );
        // A file without a valid session header is not a session.
        let junk = dir.path().join("junk.jsonl");
        std::fs::write(&junk, "not json\\n").unwrap();
        assert_eq!(persisted_goal_state(Some(&junk)), None);
        // An empty-but-valid session carries no goal entry.
        let empty = dir.path().join("empty.jsonl");
        std::fs::write(
            &empty,
            format!(
                "{}\\n",
                json!({
                    "type": "session",
                    "version": 3,
                    "id": "e",
                    "timestamp": "2026-01-01T00:00:00.000Z",
                    "cwd": "/tmp",
                })
            ),
        )
        .unwrap();
        assert_eq!(persisted_goal_state(Some(&empty)), None);
    }

    #[test]
    fn invalid_entry_data_is_skipped() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(
            &path,
            [
                json!({
                    "type": "session",
                    "version": 3,
                    "id": "s",
                    "timestamp": "2026-01-01T00:00:00.000Z",
                    "cwd": "/tmp",
                }),
                // Missing the numeric counter fields: not a persisted goal
                // state (TS `isPersistedGoalState` rejects it).
                json!({
                    "type": "custom",
                    "id": "g1",
                    "timestamp": "2026-01-01T00:00:01.000Z",
                    "customType": GOAL_STATE_CUSTOM_TYPE,
                    "data": { "active": true, "status": "active" },
                }),
            ]
            .iter()
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
        )
        .unwrap();
        assert_eq!(persisted_goal_state(Some(&path)), None);
    }

    /// Parity fixture: a real `thread_goal_state` row captured from the TS
    /// binary's session file (the f18 battery run, 2026-09-19) parses and
    /// rehydrates through the Rust reader unchanged — the durable row
    /// shape is the TS one.
    #[test]
    fn captured_ts_row_rehydrates_unchanged() {
        let ts_row = json!({
            "type": "custom",
            "customType": GOAL_STATE_CUSTOM_TYPE,
            "data": {
                "active": true,
                "status": "active",
                "goalId": "a00267c6-b20d-448f-9806-874d85eade5f",
                "objective": "f18 parity objective: land the battery flows",
                "tokensUsed": 30,
                "timeUsedSeconds": 0,
                "continuationsUsed": 0,
                "createdAt": 1789781423253u64,
                "updatedAt": 1789781423340u64,
            },
        });
        let state = goal_state_from_raw("custom", &ts_row).expect("TS row parses");
        assert_eq!(state.status, GoalStatus::Active);
        assert_eq!(
            state.objective.as_deref(),
            Some("f18 parity objective: land the battery flows")
        );
        assert_eq!(state.tokens_used, 30);
        assert_eq!(state.time_used_seconds, 0);
        assert_eq!(state.continuations_used, 0);
        assert_eq!(state.created_at, Some(1789781423253));
    }

    #[test]
    fn branch_entry_scan_matches_the_store_read() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = session_file_with_goal_rows(dir.path());
        let file = SessionFile::open(&path).unwrap();
        let entries: Vec<FileEntry> = file
            .branch()
            .iter()
            .filter_map(|entry| serde_json::to_value(entry).ok())
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect();
        assert_eq!(
            goal_state_in_branch(&entries),
            persisted_goal_state(Some(&path)),
        );
        // A cleared session (idle row) rehydrates the empty state.
        let cleared = goal_state_in_branch(&[custom_goal_entry(
            serde_json::to_value(empty_goal_state()).unwrap(),
        )]);
        assert!(cleared.is_some());
        assert_eq!(cleared.expect("cleared state").status, GoalStatus::Idle);
        // The header does not parse as a goal state.
        let header_only = FileEntry::Header {
            header: SessionHeader {
                id: "e".to_string(),
                version: Some(3),
                timestamp: "2026-01-01T00:00:00.000Z".to_string(),
                cwd: "/tmp".to_string(),
                parent_session: None,
                rlm_depth: None,
                git: None,
                rest: pa_types::JsonMap::new(),
            },
        };
        assert_eq!(goal_state_in_branch(&[header_only]), None);
    }
}
