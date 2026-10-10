//! The registry-mutation concern: run cancellation, inactive-child
//! deletes with their tombstone receipts, the close walk, the target
//! lookup/resolution, and the ledger reseed; the close-failure no-op
//! marker is registry-only.
use std::path::{Path, PathBuf};

use super::{
    bail, json, rlm_child_label, Arc, ChildCloseReason, ChildRecord, Context, DaemonCommand,
    DeletedChild, Map, Mutex, Result, SupervisorChildSessionsInner, KILL_TIMEOUT_MS,
};
use crate::lease::canonical_session_path;

/// The already-gone marker inside a close failure: a close walking a
/// child that died earlier must not fail (a missing child session is a completed no-op).
fn unknown_session(error: &anyhow::Error) -> Option<()> {
    error.chain().find_map(|cause| {
        cause
            .to_string()
            .starts_with("Unknown active session:")
            .then_some(())
    })
}

impl SupervisorChildSessionsInner {
    /// Record a delete receipt's tombstone: keyed by child id, so two
    /// deletes racing the same selector overwrite it instead of stacking a duplicate.
    pub(super) fn remember_deleted_child(&self, record: &ChildRecord) {
        let deleted = DeletedChild {
            rlm_child_id: record.rlm_child_id.clone(),
            active_session_id: record.active_session_id.clone(),
            session_id: record.session_id.clone(),
            session_name: record.session_name.clone(),
            session_dir: record.session_dir.clone(),
            started_at_ms: record.started_at_ms,
            status: record.roster_status(),
            answer_preview: record.answer_preview.clone(),
            error: record
                .error
                .clone()
                .unwrap_or_else(|| "Deleted by parent orchestrator".to_string()),
        };
        self.deleted_children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(deleted.rlm_child_id.clone(), deleted);
    }

    /// Abort one child's live run (see
    /// [`SupervisorChildSessions::cancel_child_run`]): claim the notice,
    /// settle the row as `cancelled`, then abort the worker's in-flight
    /// turn (best-effort; the registry is the user-visible state).
    pub(super) async fn cancel_child_run(&self, child_id: &str) -> bool {
        let children = self.children.lock().await.clone();
        for record in &children {
            let (matched, running, active_session_id) = {
                let record = record.lock().await;
                (
                    record.rlm_child_id == child_id,
                    record.settled_status.is_none(),
                    record.active_session_id.clone(),
                )
            };
            // A fruitless match keeps walking: child ids are only
            // mkdir-unique among siblings, so a colliding live run
            // elsewhere must stay reachable.
            if !matched || !running {
                continue;
            }
            {
                let mut record = record.lock().await;
                // The no-reply terminal notice is suppressed for a
                // cancelled run; a settle watcher that already claimed it
                // keeps its claim.
                record.notice_delivered = true;
                record.settled_status = Some("cancelled");
                record.error = Some("Cancelled by user".to_string());
            }
            self.emit_child_update(record).await;
            // Capture before the abort: the completed turns' usage (the
            // aborted turn's partial row folds nowhere) must not die with
            // the run.
            self.emit_child_usage(record).await;
            let abort = DaemonCommand::Abort {
                id: None,
                active_session_id: active_session_id.clone(),
                rest: Map::default(),
            };
            let _ = self
                .command(&abort, KILL_TIMEOUT_MS)
                .await
                .with_context(|| format!("abort RLM child session {active_session_id}"));
            // The settled/cancelled child releases an owed goal continuation.
            self.fire_settle_hook(record).await;
            return true;
        }
        false
    }

    /// Delete one inactive child by id: refresh the registry row first, refuse one still in flight,
    /// and tear a settled one down with its ledger tombstone (same as `rlm.delete_subagent`).
    pub(super) async fn delete_inactive_subagent(&self, child_id: &str) -> Result<&'static str> {
        let children = self.children.lock().await.clone();
        for record in &children {
            let matched = record.lock().await.rlm_child_id == child_id;
            if !matched {
                continue;
            }
            // Freshness pass: a child that just went idle settles here
            // and stays deletable.
            self.refresh_record(record).await;
            let (running, active_session_id) = {
                let record = record.lock().await;
                (
                    record.settled_status.is_none(),
                    record.active_session_id.clone(),
                )
            };
            if running {
                return Ok("running");
            }
            // Capture before the unlink: a deleted child's already-durable
            // rows are its only remaining spend record on the parent side.
            self.emit_child_usage(record).await;
            let command = DaemonCommand::Kill {
                id: None,
                active_session_id: active_session_id.clone(),
                rest: serde_json::Map::from_iter([
                    ("rlmLedgerDelete".to_string(), json!("user")),
                    ("rlmChildId".to_string(), json!(child_id)),
                ]),
            };
            self.command(&command, KILL_TIMEOUT_MS)
                .await
                .with_context(|| format!("kill RLM child \"{child_id}\""))?;
            // Rows can land between the pre-kill capture and the kill
            // (a settle racing the kill): the post-kill walk is the last
            // observation; the cursor keeps it free of double-billing.
            self.emit_child_usage(record).await;
            self.forget_child_usage(record).await;
            // Any live usage watcher retires with the record: a
            // follow-up watch must not keep polling the killed worker.
            record.lock().await.closed_by_parent = true;
            // The inactive delete leaves the same tombstone as the live
            // delete, so `collect` answers a just-deleted selector.
            {
                let record = record.lock().await;
                self.remember_deleted_child(&record);
            }
            self.emit_child_removal(record).await;
            self.children
                .lock()
                .await
                .retain(|candidate| !Arc::ptr_eq(candidate, record));
            // The deleted child is a resume site for the owed goal continuation.
            self.fire_settle_hook(record).await;
            return Ok("deleted");
        }
        Ok("not_found")
    }

    /// A child whose session is already gone is a completed no-op; every
    /// other close failure is kept (walk all children, rethrow the first error).
    pub(super) async fn close_children_inner(&self, reason: ChildCloseReason) -> Result<()> {
        let children = self.children.lock().await.clone();
        let mut close_error: Option<anyhow::Error> = None;
        for record in &children {
            {
                let mut record = record.lock().await;
                record.closed_by_parent = true;
                record.notice_delivered = true;
            }
            // Capture before the close: the teardown settles each run;
            // nothing observes the child after the kill.
            self.emit_child_usage(record).await;
            let active_session_id = record.lock().await.active_session_id.clone();
            if let Err(error) = self.kill_child(&active_session_id, reason).await {
                if unknown_session(&error).is_some() {
                    // Already gone: the missing child is a no-op success.
                    // The dead worker's file is frozen — the pre-kill walk
                    // covered its rows; the registration drops with it.
                    self.forget_child_usage(record).await;
                    self.children
                        .lock()
                        .await
                        .retain(|candidate| !Arc::ptr_eq(candidate, record));
                    continue;
                }
                // A failed close keeps the child tracked so the
                // caller can retry.
                close_error.get_or_insert(error);
                continue;
            }
            // Rows can land between the pre-kill capture and the kill:
            // the post-kill walk is the last observation; the registration
            // drops with the child.
            self.emit_child_usage(record).await;
            self.forget_child_usage(record).await;
            self.children
                .lock()
                .await
                .retain(|candidate| !Arc::ptr_eq(candidate, record));
        }
        // The walk changed the registry: wake a parked barrier (a closed
        // child is settled work, settled here by its removal).
        self.refresh_running().await;
        self.settle_notify.notify_waiters();
        match close_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// The one record matching a selector, or `None` (the send hook's
    /// silent miss: a delivered message may target a non-child family member).
    pub(super) async fn find_record(&self, target: &str) -> Option<Arc<Mutex<ChildRecord>>> {
        let children = self.children.lock().await;
        for record in children.iter() {
            if record.lock().await.matches(target) {
                return Some(Arc::clone(record));
            }
        }
        None
    }

    /// The one record matching a selector, or the TS selector errors
    /// (`No direct RLM {kind} matches ...` / `... is ambiguous ...`).
    pub(super) async fn resolve_record(
        &self,
        target: &str,
        miss_kind: &str,
    ) -> Result<Arc<Mutex<ChildRecord>>> {
        let children = self.children.lock().await;
        let mut matches: Vec<Arc<Mutex<ChildRecord>>> = Vec::new();
        for record in children.iter() {
            if record.lock().await.matches(target) {
                matches.push(Arc::clone(record));
            }
        }
        match matches.len() {
            0 => bail!(
                "No direct RLM {miss_kind} matches \"{target}\" in the current parent session"
            ),
            1 => Ok(Arc::clone(matches.first().expect("one match"))),
            _ => bail!(
                "RLM {miss_kind} selector \"{target}\" is ambiguous in the current parent session"
            ),
        }
    }

    /// Rebuild the children registry from the spawn ledger (TS
    /// `listPassiveRlmSubagents`): a restarted parent worker lists its
    /// non-deleted ledger children again, addressed by their durable
    /// session ids. Every reseeded row is settled (nothing is owed), and
    /// its usage cursor starts lazy: the first delivery primes it at the
    /// file's tail.
    pub(super) async fn reseed_from_ledger(&self) {
        let Some(parent_file) = self
            .identity
            .lock()
            .expect("identity lock")
            .session_file
            .clone()
        else {
            return;
        };
        let agent_dir = self.agent_dir.clone();
        let supervisor_socket = self.link.socket_path().clone();
        let parent_file_read = parent_file.clone();
        let records = tokio::task::spawn_blocking(move || {
            ledger_child_records(&agent_dir, &supervisor_socket, Path::new(&parent_file_read))
        })
        .await
        .unwrap_or_default();
        let mut children = self.children.lock().await;
        // A swap rebound the identity mid-read: its own reseed lists the new session's children.
        if self
            .identity
            .lock()
            .expect("identity lock")
            .session_file
            .as_deref()
            != Some(parent_file.as_str())
        {
            return;
        }
        children.extend(
            records
                .into_iter()
                .map(|record| Arc::new(Mutex::new(record))),
        );
    }
}

/// One parent file's non-deleted ledger edges as settled registry rows
/// (TS `listPassiveRlmSubagents`), read from the ledger the supervisor
/// writes (its persisted default sessions dir): the child file's stem
/// addresses each row both ways - resolve for a resident child, wake
/// for a passive one; an unreadable ledger reads as empty.
fn ledger_child_records(
    agent_dir: &Path,
    supervisor_socket: &Path,
    parent_file: &Path,
) -> Vec<ChildRecord> {
    let Some(sessions_dir) = crate::descriptor::load_supervisor_config(
        &crate::descriptor::descriptor_dir(agent_dir, supervisor_socket)
            .join(crate::descriptor::SUPERVISOR_CONFIG_FILE_NAME),
        supervisor_socket,
    )
    .and_then(|config| config.default_session_dir) else {
        return Vec::new();
    };
    let ledger =
        crate::rlm_ledger::RlmSpawnLedger::new(agent_dir, Path::new(&sessions_dir), |_| {});
    let edges = ledger.live_edges().unwrap_or_else(|error| {
        eprintln!("pa-daemon: RLM ledger reseed skipped: {error:#}");
        Vec::new()
    });
    let parent_file = canonical_session_path(parent_file);
    let mut records = Vec::new();
    for edge in edges {
        if canonical_session_path(Path::new(&edge.parent)) != parent_file {
            continue;
        }
        let child = PathBuf::from(&edge.child);
        let session_id = child
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned());
        let display = child
            .parent()
            .and_then(crate::rlm_ledger::read_rlm_subagent_display)
            .filter(|display| display.child_id == edge.child_id);
        records.push(ChildRecord {
            rlm_child_id: edge.child_id,
            session_name: edge.name,
            active_session_id: session_id.clone().unwrap_or_default(),
            session_id,
            session_dir: child
                .parent()
                .map(|dir| dir.to_string_lossy().into_owned())
                .unwrap_or_default(),
            model: display
                .as_ref()
                .and_then(|display| display.model.as_ref())
                .and_then(|model| {
                    Some(format!(
                        "{}/{}",
                        model.get("provider")?.as_str()?,
                        model.get("modelId")?.as_str()?
                    ))
                })
                .unwrap_or_default(),
            label: rlm_child_label(
                display
                    .as_ref()
                    .and_then(|display| display.prompt.as_deref())
                    .unwrap_or_default(),
            ),
            started_at_ms: display.as_ref().map_or_else(
                || {
                    std::fs::metadata(&child)
                        .ok()
                        .and_then(|metadata| metadata.created().ok())
                        .and_then(|created| created.duration_since(std::time::UNIX_EPOCH).ok())
                        .map_or(0, |duration| duration.as_millis() as u64)
                },
                |display| display.created_at,
            ),
            settled_status: Some(
                if display
                    .as_ref()
                    .is_some_and(|display| display.status == "running")
                {
                    "error"
                } else {
                    "done"
                },
            ),
            settled: true,
            answer_preview: None,
            answer_text: None,
            answer_captured: false,
            replied_since_task: false,
            notice_delivered: true,
            prompt_admitted: true,
            error: None,
            closed_by_parent: false,
            session_file: Some(edge.child),
            attributed_rows: None,
            usage_watch_live: false,
            usage_rearm: false,
            emit_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            last_emitted_status: None,
            rename_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        });
    }
    records
}
