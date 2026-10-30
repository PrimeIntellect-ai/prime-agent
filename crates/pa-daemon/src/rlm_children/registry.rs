//! The registry-mutation concern: run cancellation, inactive-child
//! deletes with their tombstone receipts, the close walk, the target
//! lookup/resolution, and the ledger reseed; the close-failure no-op
//! marker is registry-only.
use std::path::{Path, PathBuf};

use super::{
    bail, json, rlm_child_label, Arc, ChildCloseReason, ChildRecord, Context, DaemonCommand,
    DeletedChild, Map, Mutex, Result, SupervisorChildSessionsInner, KILL_TIMEOUT_MS,
};

use pa_core::session_engine::semantic_edges::ChildCancelledReason;

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
    /// settle the row as `cancelled` (so a parked watcher cannot append a
    /// clean `child_returned` beside the cancel line), then abort the
    /// worker's in-flight turn (best-effort; the registry is the
    /// user-visible state). A refused abort is undone wholesale: the child
    /// never got the command, so the row stays live and un-settled, the
    /// terminal notice claim restores its pre-cancel value, a later
    /// confirmed cancel can still record the edge — and the answer is
    /// `false` (the `cancel_rlm_child` wire contract reports the
    /// confirmed effect, so a user whose cancel never reached the child
    /// can retry).
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
            let notice_was_delivered = {
                let mut record = record.lock().await;
                // The no-reply terminal notice is suppressed for a
                // cancelled run; a settle watcher that already claimed it
                // keeps its claim.
                let notice_was_delivered = record.notice_delivered;
                record.notice_delivered = true;
                record.settled_status = Some("cancelled");
                record.error = Some("Cancelled by user".to_string());
                notice_was_delivered
            };
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
            let abort_result = self
                .command(&abort, KILL_TIMEOUT_MS)
                .await
                .with_context(|| format!("abort RLM child session {active_session_id}"));
            // The cancel line records the confirmed effect only (nano-rlm
            // #202 records after its `terminate`): an abort that reached
            // the child, or one whose session is already gone (a dead
            // child is cancelled), leaves the line; a real abort failure
            // keeps the edge absent, so a later successful cancel of the
            // still-running child can still record it (the dedup never saw
            // the failed attempt).
            let cancelled_confirmed = abort_result.is_ok()
                || abort_result
                    .as_ref()
                    .err()
                    .is_some_and(|error| unknown_session(error).is_some());
            if cancelled_confirmed {
                self.record_child_cancelled(record, ChildCancelledReason::UserCancel)
                    .await;
            } else {
                // The abort was refused for a real reason: the child never
                // got the command, so undo the whole pre-abort claim — the
                // row stays live, the terminal notice stays owed, and no
                // settle hook fires (a still-running child must not open
                // the quiescence barrier or release an owed continuation).
                // A later confirmed cancel (a retry, a close, a delete) can
                // then still record the parent -> child edge. The notice
                // claim restores its PRE-cancel value: a watcher that had
                // already claimed the terminal notice keeps the claim, and
                // an unclaimed one stays owed exactly once.
                let mut row = record.lock().await;
                row.settled_status = None;
                row.error = None;
                row.notice_delivered = notice_was_delivered;
                drop(row);
                // The pre-abort update published `cancelled`; publish the
                // restored live row so subscribers do not keep showing a
                // child that is still running as cancelled.
                self.emit_child_update(record).await;
                // The wire contract answers the confirmed effect: the
                // child never got the command, so the cancel did not
                // happen — the user sees `cancelled: false` and can retry.
                return false;
            }
            // The settled/cancelled child releases an owed goal continuation.
            self.fire_settle_hook(record).await;
            return true;
        }
        false
    }

    /// Delete one inactive child by id: refresh the registry row first, refuse one still in flight,
    /// and tear a settled one down with its ledger tombstone (same as `rlm.delete_subagent`).
    pub(super) async fn delete_inactive_subagent(&self, child_id: &str) -> Result<&'static str> {
        if !self.replay_retired_usage(Some(child_id)).await {
            bail!("RLM child usage remains owed after retirement; retry deletion");
        }
        let children = self.children.lock().await.clone();
        for record in &children {
            let matched = record.lock().await.rlm_child_id == child_id;
            if !matched {
                continue;
            }
            let rename_lock = record.lock().await.rename_lock.clone();
            let _guard = rename_lock.lock().await;
            let already_terminated = self.has_retired_usage(record);
            if !self
                .children
                .lock()
                .await
                .iter()
                .any(|held| Arc::ptr_eq(held, record))
            {
                continue;
            }
            // Freshness pass: a child that just went idle settles here
            // and stays deletable.
            if !already_terminated {
                self.refresh_record(record).await;
            }
            let (running, active_session_id) = {
                let record = record.lock().await;
                (
                    record.settled_status.is_none(),
                    record.active_session_id.clone(),
                )
            };
            if running && !already_terminated {
                return Ok("running");
            }
            // Capture before the unlink: a deleted child's already-durable
            // rows are its only remaining spend record on the parent side.
            if !already_terminated {
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
                self.retain_retired_usage(
                    record,
                    super::RetirementIntent::Delete { was_running: false },
                );
                self.emit_child_usage(record).await;
            }
            let usage_persisted = self.forget_child_usage(record).await;
            self.finish_retirement(record).await;
            if usage_persisted {
                self.remove_retired_usage(record);
            }
            if !usage_persisted {
                bail!("RLM child usage remains owed after retirement; retry deletion");
            }
            return Ok("deleted");
        }
        if self
            .deleted_children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(child_id)
        {
            Ok("deleted")
        } else {
            Ok("not_found")
        }
    }

    /// A child whose session is already gone is a completed no-op; every
    /// other close failure is kept (walk all children, rethrow the first error).
    pub(super) async fn close_children_inner(&self, reason: ChildCloseReason) -> Result<()> {
        let usage_persisted = self.replay_retired_usage(None).await;
        let children = self.children.lock().await.clone();
        let mut close_error = (!usage_persisted)
            .then(|| anyhow::anyhow!("RLM child usage remains owed after retirement; retry close"));
        for record in &children {
            let rename_lock = record.lock().await.rename_lock.clone();
            let _guard = rename_lock.lock().await;
            if !self
                .children
                .lock()
                .await
                .iter()
                .any(|held| Arc::ptr_eq(held, record))
            {
                continue;
            }
            if !self.has_retired_usage(record) {
                {
                    let mut record = record.lock().await;
                    record.closed_by_parent = true;
                    record.notice_delivered = true;
                }
                self.emit_child_usage(record).await;
                let (active_session_id, was_running) = {
                    let mut record = record.lock().await;
                    let was_running = record.settled_status.is_none();
                    // A close that kills a live run settles the row
                    // `cancelled` (the same registry state
                    // `cancel_child_run` leaves): a watcher parked inside
                    // its wait slice can then never refresh the killed run
                    // back to `done` and record a clean `child_returned`
                    // beside the cancel line.
                    if was_running {
                        record.settled_status = Some("cancelled");
                    }
                    (record.active_session_id.clone(), was_running)
                };
                if let Err(error) = self.kill_child(&active_session_id, reason).await {
                    if unknown_session(&error).is_none() {
                        // The kill never landed: undo the pre-kill settle so
                        // the still-live child is not reported cancelled, and
                        // a later successful stop can still record its cancel
                        // edge (the recorder's dedup never saw this attempt).
                        if was_running {
                            record.lock().await.settled_status = None;
                        }
                        close_error.get_or_insert(error);
                        continue;
                    }
                }
                // A session-kill close of a live run is the parent's
                // cancel (nano-rlm #202's killed-child gap): a killed
                // child leaves a cancel line, not a clean disappearance.
                // Only the kill close records it — a daemon lifecycle
                // close (Shutdown: the resume entry survives; Replaced:
                // cron jobs survive) is NOT a parent action, so its line
                // would mislabel every restart/upgrade with running
                // children as a parent cancel anchored to a stale
                // request (and the dedup would make it permanent).
                if was_running && matches!(reason, ChildCloseReason::Killed) {
                    self.record_child_cancelled(record, ChildCancelledReason::CloseKilled)
                        .await;
                }
                self.retain_retired_usage(record, super::RetirementIntent::Close);
                self.emit_child_usage(record).await;
            }
            let usage_persisted = self.forget_child_usage(record).await;
            self.finish_retirement(record).await;
            if usage_persisted {
                self.remove_retired_usage(record);
            } else {
                close_error.get_or_insert_with(|| {
                    anyhow::anyhow!("RLM child usage remains owed after retirement; retry close")
                });
            }
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

    /// Complete a confirmed retirement once, including an interrupted caller's bookkeeping.
    pub(super) async fn finish_retirement(&self, record: &Arc<Mutex<ChildRecord>>) {
        if record.lock().await.retirement_finished {
            return;
        }
        let intent = self
            .retirement_intent(record)
            .expect("confirmed retirement receipt");
        let deleted = matches!(intent, super::RetirementIntent::Delete { .. });
        let cancelled_by_delete = matches!(
            intent,
            super::RetirementIntent::Delete { was_running: true }
        );
        let child_id = {
            let mut row = record.lock().await;
            row.closed_by_parent = true;
            match intent {
                super::RetirementIntent::Delete { was_running } => {
                    if was_running {
                        row.settled_status = Some("cancelled");
                        row.error = Some("Deleted by parent orchestrator".into());
                    }
                    self.remember_deleted_child(&row);
                }
                super::RetirementIntent::Close => {
                    row.notice_delivered = true;
                }
            }
            row.rlm_child_id.clone()
        };
        // A delete that killed a live run is the parent's cancel (nano-rlm
        // #202's delete gap): the child's cancel line lands before the
        // registry row is gone, so a deleted child never vanishes from the
        // semantic graph.
        if cancelled_by_delete {
            self.record_child_cancelled(record, ChildCancelledReason::ParentDelete)
                .await;
        }
        if deleted {
            let sink = self
                .child_update_sink
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            let row = {
                let mut row = record.lock().await;
                if row.retirement_roster_emitted {
                    None
                } else {
                    row.retirement_roster_emitted = true;
                    Some(if cancelled_by_delete {
                        row.snapshot_value()
                    } else {
                        json!({
                            "id": row.rlm_child_id, "activeSessionId": row.active_session_id,
                            "sessionName": row.session_name, "label": row.session_name,
                            "status": "cancelled", "sessionDir": row.session_dir,
                            "error": "Deleted by parent orchestrator"
                        })
                    })
                }
            };
            if let (Some(sink), Some(row)) = (sink, row) {
                sink(row);
            }
        }
        self.children
            .lock()
            .await
            .retain(|held| !Arc::ptr_eq(held, record));
        if deleted {
            let notify = self
                .delete_notifier
                .lock()
                .expect("delete notifier lock")
                .clone();
            let claimed = {
                let mut row = record.lock().await;
                let claimed = !row.retirement_notified;
                row.retirement_notified = true;
                claimed
            };
            if let Some(notify) = notify.filter(|_| claimed) {
                notify(&child_id);
            }
            let notice = {
                let mut row = record.lock().await;
                let claimed = cancelled_by_delete && !row.notice_delivered;
                row.notice_delivered = true;
                claimed.then(|| super::RlmChildTerminalNotice::Cancelled {
                    child_id: row.rlm_child_id.clone(),
                    session_name: row.session_name.clone(),
                    reason: Some("Deleted by parent orchestrator".into()),
                })
            };
            if let Some(notice) = notice {
                self.deliver_terminal_notice(
                    record,
                    super::create_rlm_child_terminal_notice(&notice, super::now_ms()),
                )
                .await;
            }
        }
        self.refresh_running().await;
        let notify_hook = {
            let mut row = record.lock().await;
            row.settled = true;
            row.retirement_finished = true;
            deleted
        };
        // No await follows the completion claim: cancellation cannot strand its notifications.
        self.settle_notify.notify_waiters();
        if notify_hook {
            let hook = self
                .settle_hook
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            if let Some(hook) = hook {
                std::thread::spawn(move || hook());
            }
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
    let edges = ledger
        .live_edges_of_parent(parent_file)
        .unwrap_or_else(|error| {
            eprintln!("pa-daemon: RLM ledger reseed skipped: {error:#}");
            Vec::new()
        });
    let mut records = Vec::new();
    for edge in edges {
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
            decision_child: false,
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
            progress_note: None,
            tool_use_count: None,
            live_observation: None,
            direct_observation: Arc::new(Mutex::new(())),
            notice_delivered: true,
            factory: edge.factory.is_some(),
            prompt_admitted: true,
            error: None,
            closed_by_parent: false,
            retiring: false,
            retirement_finished: false,
            retirement_notified: false,
            retirement_roster_emitted: false,
            usage_registration_forgotten: false,
            session_file: Some(edge.child),
            attributed_rows: None,
            pending_usage_report: None,
            usage_watch_live: false,
            usage_rearm: false,
            emit_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            last_emitted_status: None,
            rename_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        });
    }
    records
}
