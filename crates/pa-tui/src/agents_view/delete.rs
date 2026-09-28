//! The stop-or-delete flow: the armed confirm (TS `pendingDeleteAgent` /
//! `pendingKillSubagent`), the wire dispatch the confirm executes, and
//! the no-effect outcome summary (moved with its concern).
use super::*;

/// The armed stop-or-delete row (TS `pendingDeleteAgent` /
/// `pendingKillSubagent`): which row waits on the second press, and the
/// word its hint renders (`stop` while the row has live work, `delete`
/// otherwise — TS `hasLiveWork`). The session key rides along so a
/// roster replacement (the same identity, a NEW live session) retires
/// the arm: the second press must confirm the session it will act on,
/// never silently act on its replacement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PendingDelete {
    pub(super) identity: String,
    pub(super) stop: bool,
    /// The row's live-session key (or the session-file key for saved
    /// rows) at arm time.
    pub(super) session_key: Option<String>,
}

/// One stop-or-delete dispatch the run loop executes (the wire variant
/// follows the row kind — TS `handleDeleteSelected`'s branches).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum DeleteAction {
    /// A running subagent: stop it via its parent's session
    /// (`cancel_rlm_child`).
    StopSubagent {
        active_session_id: String,
        child_id: String,
        name: String,
    },
    /// An idle subagent: delete the row via its parent's session
    /// (`delete_rlm_subagent`).
    DeleteSubagent {
        active_session_id: String,
        child_id: String,
        name: String,
    },
    /// A live agent: stop the session (`kill`).
    StopAgent {
        active_session_id: String,
        name: String,
    },
    /// A saved, non-live agent: delete the session file
    /// (`delete_saved_session`).
    DeleteSavedSession { session_path: String, name: String },
}

impl DeleteAction {
    /// The status line's success text (the wire word plus the row).
    fn success_message(&self) -> String {
        match self {
            DeleteAction::StopSubagent { name, .. } | DeleteAction::StopAgent { name, .. } => {
                format!("Stopped {name}")
            }
            DeleteAction::DeleteSubagent { name, .. } => {
                format!("Deleted {name}")
            }
            DeleteAction::DeleteSavedSession { name, .. } => {
                format!("Deleted session {name}")
            }
        }
    }

    /// The failure prefix (the arm's wire word).
    fn fail_word(&self) -> &'static str {
        match self {
            DeleteAction::StopSubagent { .. } | DeleteAction::StopAgent { .. } => "Stop",
            DeleteAction::DeleteSubagent { .. } | DeleteAction::DeleteSavedSession { .. } => {
                "Delete"
            }
        }
    }

    /// Whether the wire's own outcome fields say the effect actually
    /// happened (the honest-success check: a `cancelled: false` or a
    /// `deleted: false` in a `success` response means the command ran
    /// but changed nothing — reported as such, never as success).
    pub(super) fn effect_happened(&self, response: &pa_types::daemon::DaemonResponse) -> bool {
        let Some(data) = response.data.as_ref() else {
            return true;
        };
        match self {
            DeleteAction::StopSubagent { .. } => {
                data.get("cancelled") != Some(&serde_json::json!(false))
            }
            DeleteAction::DeleteSubagent { .. } => {
                data.get("deleted") != Some(&serde_json::json!(false))
            }
            DeleteAction::StopAgent { .. } => true,
            DeleteAction::DeleteSavedSession { .. } => {
                data.get("ok").map(serde_json::Value::as_bool) != Some(Some(false))
            }
        }
    }
}

/// The no-effect status summary: the wire's own explanation (`error`
/// or `reason`) beats a bare `ok: false`, a string value renders bare,
/// and a payload with no explanation falls back to its own text.
pub(super) fn no_effect_summary(data: Option<&serde_json::Value>) -> String {
    data.and_then(|data| {
        data.get("error")
            .or_else(|| data.get("reason"))
            .or_else(|| data.get("ok"))
            .or(Some(data))
    })
    .map_or_else(
        || "nothing changed".to_string(),
        |value| {
            value
                .as_str()
                .map_or_else(|| value.to_string(), str::to_string)
        },
    )
}

/// One stop-or-delete wire dispatch (TS `handleDeleteSelected`'s arms):
/// the call runs off the key loop with a client clone and its outcome
/// re-enters the loop as a `DeleteResult` status line — the live roster
/// push refreshes the rows behind it, so the stopped or deleted row
/// leaves the list on the next roster event, not on the status itself.
pub(super) fn spawn_delete_dispatch(
    client: &DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    action: DeleteAction,
) -> tokio::task::JoinHandle<()> {
    let client = client.clone();
    tokio::spawn(async move {
        let request = match &action {
            DeleteAction::StopSubagent {
                active_session_id,
                child_id,
                ..
            } => DaemonCommand::CancelRlmChild {
                id: None,
                active_session_id: active_session_id.clone(),
                child_id: child_id.clone(),
                rest: serde_json::Map::default(),
            },
            DeleteAction::DeleteSubagent {
                active_session_id,
                child_id,
                ..
            } => DaemonCommand::DeleteRlmSubagent {
                id: None,
                active_session_id: active_session_id.clone(),
                child_id: child_id.clone(),
                rest: serde_json::Map::default(),
            },
            DeleteAction::StopAgent {
                active_session_id, ..
            } => DaemonCommand::Kill {
                id: None,
                active_session_id: active_session_id.clone(),
                rest: serde_json::Map::default(),
            },
            DeleteAction::DeleteSavedSession { session_path, .. } => {
                DaemonCommand::DeleteSavedSession {
                    id: None,
                    active_session_id: None,
                    session_path: session_path.clone(),
                    rest: serde_json::Map::default(),
                }
            }
        };
        let outcome = match client.request(request).await {
            Ok(response) if response.success && action.effect_happened(&response) => {
                action.success_message()
            }
            Ok(response) if response.success => {
                // The wire ran but changed nothing: the status carries
                // what the wire said, never the button's hope.
                let summary = no_effect_summary(response.data.as_ref());
                format!("{} did not change anything: {summary}", action.fail_word())
            }
            Ok(response) => {
                let error = response
                    .error
                    .unwrap_or_else(|| "the command failed".into());
                format!("{} failed: {error}", action.fail_word())
            }
            Err(error) => format!("{} failed: {error}", action.fail_word()),
        };
        let deleted_saved_path = match &action {
            DeleteAction::DeleteSavedSession { session_path, .. }
                if outcome.starts_with("Deleted session") =>
            {
                Some(session_path.clone())
            }
            DeleteAction::DeleteSavedSession { .. }
            | DeleteAction::StopSubagent { .. }
            | DeleteAction::DeleteSubagent { .. }
            | DeleteAction::StopAgent { .. } => None,
        };
        let _ = ui_tx.send(UiInput::DeleteResult {
            message: outcome,
            deleted_saved_path,
        });
    })
}

impl AgentsViewMode {
    pub(super) fn delete_arm_target(&self) -> Option<PendingDelete> {
        let row = self.rows.get(self.selected)?;
        let stop = self.delete_arm_word(row);
        match row.kind {
            RowKind::SubagentSummary => None,
            // An agent with a live session stops (TS `stopAgentForDeletion`
            // keys on the session's existence — an idle-but-live row still
            // stops, never deletes its file); a saved-only row deletes.
            RowKind::Agent if row.summary.get("activeSessionId").is_some() => row
                .summary
                .get("activeSessionId")
                .map(Value::as_str)
                .map(|_| ()),
            // A scoped view's promoted direct child is an Agent-kind row
            // carrying the child id: it rides the child arms, never the
            // agent arms.
            RowKind::Agent if row.summary.get("rlmChildId").is_some() => {
                row.summary.get("rlmChildId").map(Value::as_str).map(|_| ())
            }
            RowKind::Agent => row
                .summary
                .get("sessionFile")
                .map(Value::as_str)
                .map(|_| ()),
            RowKind::Subagent => row.summary.get("rlmChildId").map(Value::as_str).map(|_| ()),
        }?;
        // A child arm only when its dispatch can resolve: the parent
        // session (the summary's parentActiveSessionId, or the parent
        // row's live session) must exist, or the second press would be a
        // confirmed no-op.
        let parent_session_missing = !row
            .summary
            .get("parentActiveSessionId")
            .is_some_and(Value::is_string)
            && row
                .parent_identity
                .as_deref()
                .and_then(|identity| self.rows.iter().find(|row| row.identity == identity))
                .and_then(|parent| {
                    parent
                        .summary
                        .get("activeSessionId")
                        .and_then(Value::as_str)
                })
                .is_none();
        if (row.kind == RowKind::Subagent || row.summary.get("rlmChildId").is_some())
            && parent_session_missing
        {
            return None;
        }
        Some(PendingDelete {
            identity: row.identity.clone(),
            stop,
            session_key: self.armed_session_key(row),
        })
    }

    /// The session a child dispatch targets: the summary's
    /// parentActiveSessionId, else the parent row's live session (the
    /// daemon scopes the child lookup by the parent's session — the
    /// child's own activeSessionId is never the target).
    fn child_parent_session_key(&self, row: &AgentsViewRow) -> Option<String> {
        if let Some(parent_id) = row
            .summary
            .get("parentActiveSessionId")
            .and_then(Value::as_str)
        {
            return Some(parent_id.to_string());
        }
        row.parent_identity
            .as_deref()
            .and_then(|identity| self.rows.iter().find(|row| row.identity == identity))
            .and_then(|parent| {
                parent
                    .summary
                    .get("activeSessionId")
                    .and_then(Value::as_str)
            })
            .map(str::to_string)
    }

    /// The arm's session key: the session the execution itself targets —
    /// a child rides its parent's session, a live agent its own, a saved
    /// row its file. A roster change that swaps the key (a re-parented
    /// child above all) retires the confirm: the second press acts on
    /// the session the first press confirmed.
    pub(super) fn armed_session_key(&self, row: &AgentsViewRow) -> Option<String> {
        if row.kind == RowKind::Subagent || row.summary.get("rlmChildId").is_some() {
            return self.child_parent_session_key(row);
        }
        row.summary
            .get("activeSessionId")
            .or_else(|| row.summary.get("sessionFile"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// The row's stop-or-delete word (the hint + the execution gate's
    /// shared derivation): true while the row rides a live session or
    /// the running section (TS `hasLiveWork`), false for a saved-only
    /// row.
    pub(super) fn delete_arm_word(&self, row: &AgentsViewRow) -> bool {
        if row.summary.get("rlmChildId").is_some() {
            // A child rides its own activity (TS `hasLiveWork` over the
            // child): the running section is its live work, an idle
            // child deletes — the retained activeSessionId on an idle
            // child is not live work.
            row.section == crate::agents_view_state::Section::Running
        } else {
            // An agent keys on its session's existence (TS
            // `stopAgentForDeletion`): an idle-but-live agent still
            // stops, never deletes its file.
            row.summary.get("activeSessionId").is_some()
        }
    }

    /// The executed dispatch for the armed row (the second press): the
    /// wire variant follows the row kind, exactly TS
    /// `handleDeleteSelected`'s branches.
    pub(super) fn delete_action_for_selected(&self) -> Option<DeleteAction> {
        let row = self.rows.get(self.selected)?;
        let name = row.title.clone();
        // A promoted direct child (an Agent-kind row carrying rlmChildId)
        // rides the child arms with its own id.
        let child_id = row
            .summary
            .get("rlmChildId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let active_session_id = row
            .summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        // Subagent rows (and promoted children) target the child through
        // the parent's live session.
        if let Some(child_id) = child_id {
            if row.kind == RowKind::SubagentSummary {
                return None;
            }
            // The child arms always run through the PARENT's session: a
            // scoped promoted child has no parent row in the list, so the
            // summary's own parentActiveSessionId carries the parent
            // session; the nested child walks its parent row.
            let active_session_id = self.child_parent_session_key(row)?;
            if self.delete_arm_word(row) {
                return Some(DeleteAction::StopSubagent {
                    active_session_id,
                    child_id,
                    name,
                });
            }
            return Some(DeleteAction::DeleteSubagent {
                active_session_id,
                child_id,
                name,
            });
        }
        // Agent rows: a live session stops (idle-but-live included — TS
        // `stopAgentForDeletion` keys on the session's existence); a
        // saved-only row deletes its file.
        match row.kind {
            RowKind::SubagentSummary | RowKind::Subagent => None,
            RowKind::Agent => {
                if let Some(active_session_id) = active_session_id {
                    Some(DeleteAction::StopAgent {
                        active_session_id,
                        name,
                    })
                } else {
                    let session_path = row.summary.get("sessionFile")?.as_str()?.to_string();
                    Some(DeleteAction::DeleteSavedSession { session_path, name })
                }
            }
        }
    }

    /// The executed delete the run loop takes (the dispatch runs with
    /// the client, off the key loop).
    pub(super) fn take_delete_action(&mut self) -> Option<DeleteAction> {
        self.pending_delete_action.take()
    }

    /// One landed stop-or-delete outcome: the status line reports it,
    /// and a deleted saved row leaves the catalog immediately (the live
    /// roster push covers the other arms; saved rows have no push).
    pub(super) fn delete_result(&mut self, message: String, deleted_saved_path: Option<String>) {
        self.status = Some(message);
        // A deleted saved row leaves the catalog by its own path (the
        // key the daemon deleted), never by the display name.
        if let Some(path) = deleted_saved_path {
            self.deleted_saved_paths.insert(path.clone());
            self.saved.retain(|saved| {
                saved
                    .get("path")
                    .and_then(Value::as_str)
                    .is_none_or(|saved_path| saved_path != path)
            });
            self.rebuild_rows();
        }
    }
}
