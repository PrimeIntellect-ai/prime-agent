//! The saved-session catalog and peer-roster surface (protocol breadth
//! wave b11): the supervisor arms for `rename_saved_session`,
//! `delete_saved_session`, and `list_agent_peers` (TS daemon-supervisor
//! cases), the worker arms the selector forms forward to (TS daemon-mode
//! cases), and the shared catalog writes (TS daemon-catalog-process
//! `rename`/`delete` over `SessionManager.open().appendSessionInfo` /
//! `deleteSessionFile`).
//!
//! Rename walks the TS ladder: the name-reservation input (live roster row
//! or saved session, else `Session not found`), the pending-name
//! reservation, the family name-availability assertion, and then either
//! the offline catalog rename (append the `session_info` entry, the RLM
//! ledger rename, the roster row rewrite) or the forward to the live
//! worker. Delete refuses the active session, tombstones the RLM ledger
//! unless the session is positively top-level, deletes the file (trash
//! first, unlink fallback — plus the artifact partition), and drops the
//! roster row.

use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use pa_types::daemon::DaemonCommand;

use crate::lease::canonical_session_path;
use crate::protocol::{response_failure, response_line, response_success, DaemonResponse};
use crate::session_store::{read_session_info, SessionFile};
use crate::supervisor::Supervisor;
use crate::worker::Worker;

/// The session-name-unavailability error (TS
/// `formatAgentSessionNameUnavailable`).
fn name_unavailable_error(name: &str, depth: u32) -> String {
    format!(
        "Agent name \"{name}\" is unavailable: an agent of that name already exists at depth {depth} under this parent"
    )
}

/// The reservation key (TS `sessionNameReservationKey`): the JSON-encoded
/// `[depth, parentType, parentValue, name]` tuple - the parent keyed by
/// its path, its persisted id, or the root scope.
fn reservation_key(scope: &NameScope) -> String {
    let (parent_type, parent_value) = match (
        scope.depth,
        scope.parent_session_path.as_deref(),
        scope.parent_session_id.as_deref(),
    ) {
        (0, _, _) => ("root".to_string(), String::new()),
        (_, Some(path), _) => (
            "path".to_string(),
            canonical_session_path(Path::new(path))
                .to_string_lossy()
                .to_string(),
        ),
        (_, None, Some(id)) => ("id".to_string(), id.to_string()),
        (_, None, None) => ("root".to_string(), String::new()),
    };
    json!([scope.depth, parent_type, parent_value, scope.name]).to_string()
}

/// The TS name scope a rename target carries into the availability check.
struct NameScope {
    /// The renamed session's own id (the availability check ignores it).
    id: String,
    name: String,
    depth: u32,
    parent_session_id: Option<String>,
    parent_session_path: Option<String>,
}

/// One family-catalog row (TS `AgentFamilyCatalogEntry`): the fields the
/// name-availability assertion reads.
struct FamilyRow {
    id: String,
    name: Option<String>,
    depth: u32,
    parent_session_path: Option<String>,
}

/// TS `sameAgentSessionNameParent`: depth-0 rows share one scope; deeper
/// rows must share the parent path.
fn same_name_parent(left: &FamilyRow, right: &NameScope) -> bool {
    if left.depth == 0 && right.depth == 0 {
        return true;
    }
    if left.depth != right.depth {
        return false;
    }
    left.parent_session_path.is_some() && left.parent_session_path == right.parent_session_path
}

/// Append one `session_info` name entry to a saved session file (TS
/// catalog `rename`).
pub(crate) fn append_saved_session_name(path: &Path, name: &str) -> anyhow::Result<()> {
    let mut session = SessionFile::open(path)?;
    session.append_session_info(name);
    session.rewrite()
}

/// Delete a session file (TS `deleteSessionFile`): try the `trash` CLI
/// first, fall back to unlink, and remove the session's artifact partition
/// once the file itself is gone. Answers the TS `DeleteSessionFileResult`
/// wire object.
pub(crate) fn delete_session_file(path: &Path) -> Value {
    let trash = StdCommand::new("trash").arg("--").arg(path).output();
    let removed_by_trash = match trash {
        Ok(output) => output.status.success() || !path.exists(),
        Err(_) => false,
    };
    if removed_by_trash {
        remove_session_artifacts(path);
        return json!({ "ok": true, "method": "trash" });
    }
    match std::fs::remove_file(path) {
        Ok(()) => {
            remove_session_artifacts(path);
            json!({ "ok": true, "method": "unlink" })
        }
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

/// Remove the session's artifact partition (TS `deleteSessionArtifacts`):
/// `<root>/session-artifacts/<id>`, only once the session file is gone.
fn remove_session_artifacts(session_path: &Path) {
    let Some(stem) = session_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
    else {
        return;
    };
    let Some(artifacts) = crate::scheduled_jobs::session_artifact_dir(session_path, stem) else {
        return;
    };
    let _ = std::fs::remove_dir_all(artifacts);
}

/// The RLM ledger rename for an offline saved-session rename (best effort,
/// TS logs and continues).
pub(crate) fn ledger_rename_by_child_path(
    agent_dir: &Path,
    sessions_dir: &Path,
    child_path: &str,
    name: &str,
) {
    let ledger = crate::rlm_ledger::RlmSpawnLedger::new(agent_dir, sessions_dir, |_| {});
    if let Err(error) = ledger.append_rename_by_child_path(child_path, name) {
        eprintln!("failed to append RLM ledger rename: {error:#}");
    }
}

/// TS `tombstoneSavedSessionDelete`: tombstone every ledger edge at the
/// deleted path unless the session is positively top-level (a known
/// top-level summary, or a readable session info with no parent and
/// depth 0).
pub(crate) fn tombstone_saved_session_delete(
    agent_dir: &Path,
    sessions_dir: &Path,
    session_path: &str,
    known_runtime_kind: Option<&str>,
) {
    let deleted_info = read_session_info(Path::new(session_path));
    let known_child = known_runtime_kind == Some("subagent")
        || deleted_info
            .as_ref()
            .is_some_and(|info| info.parent_session_path.is_some() || info.rlm_depth > 0);
    let positively_top_level =
        !known_child && (known_runtime_kind.is_some() || deleted_info.is_some());
    if positively_top_level {
        return;
    }
    let ledger = crate::rlm_ledger::RlmSpawnLedger::new(agent_dir, sessions_dir, |_| {});
    if let Err(error) =
        ledger.tombstone_child_path(session_path, crate::rlm_ledger::RlmLedgerDeleteReason::User)
    {
        eprintln!("failed to append RLM ledger delete tombstone: {error:#}");
    }
}

impl Supervisor {
    /// The family-catalog rows (TS `familyCatalogEntries`): the roster
    /// rows plus the saved depth-0 sessions the roster does not know.
    fn family_rows(&self, extra_sessions_dir: Option<&Path>) -> Vec<FamilyRow> {
        let mut rows = Vec::new();
        {
            let roster = self
                .roster
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for entry in roster.entries() {
                let summary = &entry.summary;
                rows.push(FamilyRow {
                    id: summary
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    name: summary
                        .get("sessionName")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    depth: summary.get("rlmDepth").and_then(Value::as_u64).unwrap_or(0) as u32,
                    parent_session_path: summary
                        .get("parentSessionPath")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
            }
        }
        if let Some(dir) = extra_sessions_dir {
            // TS scans the catalog for depth-0 rows only: a parented file
            // without a recorded depth reads as -1 and stays out.
            for info in crate::session_store::list_sessions(dir) {
                if info.rlm_depth != 0 || info.parent_session_path.is_some() {
                    continue;
                }
                rows.push(FamilyRow {
                    id: info.id.clone(),
                    name: info.name.clone(),
                    depth: 0,
                    parent_session_path: None,
                });
            }
        }
        rows
    }

    /// TS `assertAgentSessionNameAvailable`: a same-name, same-depth,
    /// same-parent row that is not the renamed session itself conflicts.
    fn assert_family_name_available(&self, scope: &NameScope) -> Result<(), String> {
        let rows = self.family_rows(self.sessions_dir_path().as_deref());
        for row in rows {
            if row.id == scope.id || row.name.as_deref() != Some(scope.name.as_str()) {
                continue;
            }
            if row.depth == scope.depth && same_name_parent(&row, scope) {
                return Err(name_unavailable_error(&scope.name, scope.depth));
            }
        }
        Ok(())
    }

    /// The supervisor's sessions dir (the catalog's scan root).
    fn sessions_dir_path(&self) -> Option<PathBuf> {
        crate::paths::sessions_dir(&self.options.agent_dir).ok()
    }

    /// The name-reservation input (TS `savedSessionNameReservationInput`):
    /// the live roster row for the path, else the saved session info;
    /// a miss answers `Session not found`.
    async fn saved_session_name_scope(
        &self,
        session_path: &str,
        name: String,
    ) -> Result<NameScope, String> {
        let canonical = canonical_session_path(Path::new(session_path))
            .to_string_lossy()
            .to_string();
        let roster_row = {
            let roster = self
                .roster
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            roster.by_session_file(&canonical).map(|entry| {
                let summary = &entry.summary;
                NameScope {
                    id: summary
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    name: name.clone(),
                    depth: summary.get("rlmDepth").and_then(Value::as_u64).unwrap_or(0) as u32,
                    parent_session_id: summary
                        .get("parentSessionId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    parent_session_path: summary
                        .get("parentSessionPath")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                }
            })
        };
        if let Some(scope) = roster_row {
            return Ok(scope);
        }
        match read_session_info(Path::new(session_path)) {
            Some(info) => Ok(NameScope {
                id: info.id.clone(),
                name,
                depth: info.rlm_depth,
                parent_session_id: None,
                parent_session_path: info.parent_session_path.clone(),
            }),
            None => Err(format!("Session not found: {session_path}")),
        }
    }

    /// `rename_saved_session` (TS supervisor arm): the reservation ladder,
    /// then the offline catalog rename or the forward to the live worker.
    pub(crate) async fn handle_rename_saved_session(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let DaemonCommand::RenameSavedSession {
            active_session_id,
            session_path,
            name,
            ..
        } = command
        else {
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    "invalid command",
                    None,
                ))],
                false,
            );
        };
        let scope = match self
            .saved_session_name_scope(session_path, name.trim().to_string())
            .await
        {
            Ok(scope) => scope,
            Err(error) => {
                return (
                    vec![response_line(&response_failure(
                        Some(command_id),
                        type_name,
                        &error,
                        None,
                    ))],
                    false,
                )
            }
        };
        // The pending-name reservation (TS `withSessionNameReservation`):
        // a concurrent rename of the same name in the same scope fails
        // with the unavailability error.
        let key = reservation_key(&scope);
        let reserved = {
            let mut pending = self
                .pending_session_names
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            pending.insert(key.clone())
        };
        if !reserved {
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    &name_unavailable_error(&scope.name, scope.depth),
                    None,
                ))],
                false,
            );
        }
        let availability = self.assert_family_name_available(&scope);
        self.pending_session_names
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key);
        if let Err(error) = availability {
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    &error,
                    None,
                ))],
                false,
            );
        }
        if active_session_id.is_none() {
            // The offline catalog rename (TS `catalog.rename`): append the
            // session_info entry, the ledger rename, and the roster row
            // rewrite.
            let path = Path::new(session_path);
            if let Err(error) = append_saved_session_name(path, &scope.name) {
                return (
                    vec![response_line(&response_failure(
                        Some(command_id),
                        type_name,
                        &error.to_string(),
                        None,
                    ))],
                    false,
                );
            }
            if let Some(sessions_dir) = self.sessions_dir_path() {
                ledger_rename_by_child_path(
                    &self.options.agent_dir,
                    &sessions_dir,
                    session_path,
                    &scope.name,
                );
            }
            self.rewrite_roster_session_name(session_path, &scope.name);
            return (
                vec![response_line(&response_success(
                    Some(command_id),
                    type_name,
                    None,
                ))],
                false,
            );
        }
        // The live form forwards to the owning worker (TS rewrites the
        // selector onto the resolved summary's ids).
        self.route_client_command(
            command,
            client_id,
            attached,
            command_id.to_string(),
            type_name.to_string(),
        )
        .await
    }

    /// The roster row rewrite of an offline rename (TS `writeRosterEntry`
    /// with the summary's new sessionName).
    fn rewrite_roster_session_name(&self, session_path: &str, name: &str) {
        let canonical = canonical_session_path(Path::new(session_path))
            .to_string_lossy()
            .to_string();
        let changed = {
            let mut roster = self
                .roster
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(entry) = roster.by_session_file(&canonical).cloned() else {
                return;
            };
            let mut summary = entry.summary.clone();
            summary["sessionName"] = json!(name);
            let worker_id = entry.worker_id.clone();
            let status_label = entry.status_label.clone();
            Some(roster.write_summary(summary, worker_id.as_deref(), status_label.as_deref()))
        };
        if let Some(entry) = changed {
            self.push_roster_update(vec![entry], Vec::new());
        }
    }

    /// `delete_saved_session` selector-less (TS supervisor arm): refuse the
    /// active session, let a live connected worker own the delete,
    /// tombstone the ledger, delete the file, drop the roster row.
    pub(crate) async fn handle_delete_saved_session(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let DaemonCommand::DeleteSavedSession { session_path, .. } = command else {
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    "invalid command",
                    None,
                ))],
                false,
            );
        };
        let canonical = canonical_session_path(Path::new(session_path))
            .to_string_lossy()
            .to_string();
        let roster_entry = {
            let roster = self
                .roster
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            roster.by_session_file(&canonical).cloned()
        };
        if let Some(entry) = roster_entry.as_ref() {
            let active = entry
                .summary
                .get("activeSessionId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty());
            if active {
                return (
                    vec![response_line(&response_failure(
                        Some(command_id),
                        type_name,
                        "Cannot delete the currently active session",
                        None,
                    ))],
                    false,
                );
            }
        }
        // A worker still hosting the file owns the delete (TS forwards to
        // a connected owner or refuses while it is unreachable). A
        // worker another client owns is invisible: the delete answers the
        // unknown-target error (TS `assertWorkerAccessibleToClient`).
        if let Some(owner) = self.registry.find_by_session_file(session_path).await {
            let owner_id = {
                let descriptor = owner.descriptor.lock().await;
                descriptor.owner_client_id.clone()
            };
            if owner_id.is_some_and(|owner| owner != client_id) {
                return (
                    vec![response_line(&response_failure(
                        Some(command_id),
                        type_name,
                        &format!("Unknown active session: {session_path}"),
                        None,
                    ))],
                    false,
                );
            }
            if self.is_live_connected_worker(&owner).await {
                let mut response = self
                    .forward_with_catalog_timeout(&owner, command, client_id)
                    .await;
                response.id = Some(command_id.to_string());
                // The owning worker deleted the file: its binding dies with
                // it (no successor worker can ever take the file over).
                if response
                    .data
                    .as_ref()
                    .and_then(|data| data.get("ok"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    self.session_bindings.forget_file(&canonical);
                }
                return (vec![response_line(&response)], false);
            }
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    "Session worker is recovering; retry the delete once it is reachable",
                    None,
                ))],
                false,
            );
        }
        let sessions_dir = self.sessions_dir_path();
        tombstone_saved_session_delete(
            &self.options.agent_dir,
            sessions_dir.as_deref().unwrap_or(&self.options.agent_dir),
            session_path,
            roster_entry
                .as_ref()
                .and_then(|entry| entry.summary.get("runtimeKind"))
                .and_then(Value::as_str),
        );
        let result = delete_session_file(Path::new(session_path));
        let removed = result.get("ok").and_then(Value::as_bool) == Some(true);
        if removed {
            // The deleted file's binding dies with it: a stale id for the
            // session can never rebind again (no successor worker can take
            // the file over), so the entries drop instead of leaking for
            // the daemon's lifetime. `canonical` was resolved while the
            // file still existed - the same key the table stores.
            self.session_bindings.forget_file(&canonical);
            if let Some(entry) = roster_entry {
                let agent_id = entry.agent_id.clone();
                self.roster
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .delete(&agent_id);
                self.push_roster_update(Vec::new(), vec![agent_id]);
            }
        }
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                Some(result),
            ))],
            false,
        )
    }

    /// `list_agent_peers` (TS supervisor arm): the requester authenticates
    /// with its worker token; every other live ready connected worker with
    /// a rostered root row answers as a peer summary.
    pub(crate) async fn handle_list_agent_peers(
        self: &Arc<Self>,
        command: &DaemonCommand,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let DaemonCommand::ListAgentPeers { worker_token, .. } = command else {
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    "invalid command",
                    None,
                ))],
                false,
            );
        };
        let Some(requester) = self.registry.find_by_token(worker_token).await else {
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    "Worker authentication failed",
                    None,
                ))],
                false,
            );
        };
        let mut peers = Vec::new();
        for resident in self.registry.list().await {
            if resident.worker_id == requester.worker_id
                || !self.is_live_connected_worker(&resident).await
            {
                continue;
            }
            let root_active_session_id = {
                let descriptor = resident.descriptor.lock().await;
                descriptor.root_active_session_id.clone()
            };
            if root_active_session_id.is_empty() {
                continue;
            }
            let summary = {
                let roster = self
                    .roster
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                roster
                    .by_active_session_id(&root_active_session_id)
                    .map(|entry| entry.summary.clone())
            };
            if let Some(summary) = summary {
                peers.push(agent_peer_summary(&summary));
            }
        }
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                Some(json!({ "peers": peers })),
            ))],
            false,
        )
    }
}

/// TS `agentPeerSummary`: the roster row's summary projected onto the
/// agent-message peer shape.
fn agent_peer_summary(summary: &Value) -> Value {
    let mut peer = json!({
        "activeSessionId": summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .or_else(|| summary.get("id").and_then(Value::as_str))
            .unwrap_or_default(),
        "sessionId": summary
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "runtimeKind": summary
            .get("runtimeKind")
            .and_then(Value::as_str)
            .unwrap_or("top-level"),
        "cwd": summary.get("cwd").and_then(Value::as_str).unwrap_or_default(),
        "isStreaming": summary
            .get("isStreaming")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "unfinishedActionCount": summary
            .get("unfinishedActionCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    });
    if let Some(name) = summary.get("sessionName").and_then(Value::as_str) {
        peer["sessionName"] = json!(name);
    }
    for key in [
        "parentActiveSessionId",
        "parentSessionId",
        "parentSessionPath",
    ] {
        if let Some(value) = summary.get(key).filter(|value| !value.is_null()) {
            peer[key] = value.clone();
        }
    }
    if let Some(file) = summary.get("sessionFile").and_then(Value::as_str) {
        peer["sessionPath"] = json!(file);
    }
    if let Some(depth) = summary.get("rlmDepth").and_then(Value::as_u64) {
        peer["rlmDepth"] = json!(depth);
    }
    if let Some(kind) = summary.get("rosterStatus").and_then(Value::as_str) {
        peer["status"] = json!(kind);
    } else {
        peer["status"] = json!("idle");
    }
    if let Some(child_id) = summary.get("rlmChildId").and_then(Value::as_str) {
        peer["rlmChildId"] = json!(child_id);
    }
    peer
}

impl Worker {
    /// `rename_saved_session` (TS daemon-mode case): a live target renames
    /// through the session's own rename path (answering with no data, the
    /// TS shape); an offline file gets the catalog append.
    pub(crate) async fn handle_rename_saved_session(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("rename_saved_session") {
            return response;
        }
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if name.is_empty() {
            return response_failure(
                None,
                "rename_saved_session",
                "Session name cannot be empty",
                None,
            );
        }
        let session_path = payload
            .get("sessionPath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let own_file = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            core.store.as_ref().is_some_and(|store| {
                !store.path.as_os_str().is_empty()
                    && canonical_session_path(&store.path)
                        == canonical_session_path(Path::new(session_path))
            })
        };
        if own_file {
            // The live form answers `success(id, "rename_saved_session")`
            // with no data, unlike the `rename` command's summary.
            let mut payload = Map::new();
            payload.insert("name".to_string(), json!(name));
            let mut response = self.handle_rename("rename_saved_session", &Value::Object(payload));
            response.data = None;
            return response;
        }
        let path = Path::new(session_path);
        if read_session_info(path).is_none() {
            return response_failure(
                None,
                "rename_saved_session",
                &format!("Session not found: {session_path}"),
                None,
            );
        }
        match append_saved_session_name(path, &name) {
            Ok(()) => response_success(None, "rename_saved_session", None),
            Err(error) => response_failure(None, "rename_saved_session", &error.to_string(), None),
        }
    }

    /// `delete_saved_session` (TS daemon-mode case): refuse the live
    /// session, tombstone the ledger, delete the file and its artifacts,
    /// answer the delete result.
    pub(crate) async fn handle_delete_saved_session(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("delete_saved_session") {
            return response;
        }
        let session_path = payload
            .get("sessionPath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let path = Path::new(session_path);
        let own_file = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            core.store.as_ref().is_some_and(|store| {
                !store.path.as_os_str().is_empty()
                    && canonical_session_path(&store.path) == canonical_session_path(path)
            })
        };
        if own_file {
            return response_failure(
                None,
                "delete_saved_session",
                "Cannot delete the currently active session",
                None,
            );
        }
        let sessions_dir = crate::paths::sessions_dir(&self.config.agent_dir)
            .unwrap_or_else(|_| self.config.agent_dir.join("sessions"));
        tombstone_saved_session_delete(&self.config.agent_dir, &sessions_dir, session_path, None);
        let result = delete_session_file(path);
        if result.get("ok").and_then(Value::as_bool) == Some(true) {
            // The deleted file's scheduled jobs die with its artifact
            // partition (delete_session_file removed it) — the same
            // `cancelScheduledJobsForSessionFile` effect.
            self.scheduled.wake().await;
        }
        response_success(None, "delete_saved_session", Some(result))
    }
}
