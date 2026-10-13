//! Supervisor-side roster serving: subscribe/unsubscribe handling, worker
//! roster deltas, the stop-path passivation, and the `roster_update` pushes subscribers receive.

use serde_json::Map;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pa_types::daemon::agent_roster::AgentRosterEntry;
use pa_types::daemon::DaemonOutbound;
use serde_json::{json, Value};

use crate::backpressure::RouteAdmission;
use crate::lease::canonical_session_path;
use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::registry::ResidentWorker;
use crate::supervisor::{ClientRouting, Supervisor, ROUTE_TIMEOUT_MS};
use crate::supervisor_roster_seed::family_descends_from;

/// `worker_roster_delta`'s parsed frame. `sequence` feeds the stale-delta
/// gate (the per-worker watermark drops a delayed older snapshot);
/// `worker_instance_id` is the generation the gate's slot names (a
/// replacement process restarts the counter under a new instance).
pub(crate) struct WorkerRosterDelta {
    pub worker_token: String,
    pub summary: Value,
    pub removed: Vec<String>,
    pub sequence: Option<u64>,
    pub worker_instance_id: Option<String>,
}

impl Supervisor {
    /// `roster_subscribe`: answer with the full roster snapshot (the
    /// caller stores the client flag). Pure in-memory.
    pub(crate) async fn handle_roster_subscribe(
        self: &Arc<Self>,
        command_id: &str,
        type_name: &str,
    ) -> DaemonResponse {
        // A registration seed's pushes must never overtake this answer
        // (a client applying the push first loses the seeded rows).
        let pending = std::mem::take(&mut *self.pending_registration_seeds.lock().unwrap());
        for handle in pending {
            let _ = handle.await;
        }
        let roster = self.roster.lock().unwrap().entries();
        response_success(
            Some(command_id),
            type_name,
            Some(json!({ "roster": roster })),
        )
    }

    /// The seed roots: every worker's `sessionFile` (the durable create's
    /// `sessionPath` as fallback), canonicalized.
    pub(crate) async fn roster_seed_roots(self: &Arc<Self>) -> HashSet<PathBuf> {
        let mut roots = HashSet::new();
        for resident in self.registry.list().await {
            let descriptor = resident.descriptor.lock().await;
            let root = descriptor
                .session_file
                .clone()
                .or_else(|| descriptor.create_command.session_path.clone());
            if let Some(root) = root {
                roots.insert(canonical_session_path(Path::new(&root)));
            }
        }
        roots
    }

    pub(crate) fn handle_roster_unsubscribe(command_id: &str, type_name: &str) -> DaemonResponse {
        response_success(Some(command_id), type_name, None)
    }

    pub(crate) async fn handle_worker_roster_delta(
        self: &Arc<Self>,
        command_id: &str,
        type_name: &str,
        delta: WorkerRosterDelta,
    ) -> DaemonResponse {
        let WorkerRosterDelta {
            worker_token,
            summary,
            removed,
            sequence,
            worker_instance_id,
        } = delta;
        let Some(resident) = self.registry.find_by_token(&worker_token).await else {
            return response_failure(
                Some(command_id),
                type_name,
                "Worker authentication failed",
                None,
            );
        };
        // One per-worker critical section spans the roster write and the
        // identity follow (the descriptor lock): no half-applied swap; the
        // gate and the write share one roster lock, so accept order is
        // apply order.
        let mut changed = Vec::new();
        let mut removed_ids = Vec::new();
        {
            let mut descriptor = resident.descriptor.lock().await;
            {
                let mut roster = self.roster.lock().unwrap();
                if !roster.accept_delta_sequence(
                    &resident.worker_id,
                    worker_instance_id.as_deref().unwrap_or(""),
                    sequence.unwrap_or(0),
                ) {
                    return response_success(Some(command_id), type_name, None);
                }
                let entry = roster.write_summary(summary.clone(), Some(&resident.worker_id), None);
                // The worker's root slot can swap to a new durable
                // session: the superseded row must not present as live.
                for swapped in roster.swapped_out_root_rows(&resident.worker_id, &entry) {
                    roster.delete(&swapped);
                    removed_ids.push(swapped);
                }
                changed.push(entry);
                for agent_id in removed {
                    if roster.get(&agent_id).is_some() {
                        roster.delete(&agent_id);
                        removed_ids.push(agent_id);
                    }
                }
            }
            // The supervisor-side identity follows the write inside the
            // same critical section; the boot quarantine lifts ONLY on a
            // root-identity-bearing write.
            let root_identity_bearing =
                self.sync_root_identity_from_roster(&resident, &mut descriptor);
            if root_identity_bearing {
                resident.clear_identity_quarantine();
            }
        }
        self.push_roster_update(changed, removed_ids);
        response_success(Some(command_id), type_name, None)
    }

    /// Test-support arm: production paths write through the sequence-gated
    /// [`Self::write_roster_summary_for_resident`].
    #[cfg(test)]
    pub(crate) fn write_roster_summary(
        &self,
        summary: &Value,
        worker_id: Option<&str>,
    ) -> Option<AgentRosterEntry> {
        let entry = self
            .roster
            .lock()
            .unwrap()
            .write_summary(summary.clone(), worker_id, None);
        self.push_roster_update(vec![entry.clone()], Vec::new());
        Some(entry)
    }

    pub(crate) async fn write_roster_summary_for_resident(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        summary: &Value,
    ) -> Option<AgentRosterEntry> {
        let stamped_instance = summary
            .get("workerInstanceId")
            .and_then(serde_json::Value::as_str)
            .filter(|stamped| !stamped.is_empty());
        let instance = match stamped_instance {
            Some(stamped) => stamped.to_string(),
            None => resident
                .descriptor
                .lock()
                .await
                .worker_instance_id
                .clone()
                .unwrap_or_default(),
        };
        // The counter stamp stays an Option: ABSENT means unsequenced (a
        // legacy summary predating the field) — an authoritative write;
        // PRESENT-and-zero orders like any other snapshot.
        let counter = summary
            .get("rosterDeltaSequence")
            .and_then(serde_json::Value::as_u64);
        let (entry, swapped) = {
            // The pull shares the delta path's per-worker critical
            // section.
            let mut descriptor = resident.descriptor.lock().await;
            let (entry, swapped) = {
                let mut roster = self.roster.lock().unwrap();
                if !roster.accept_roster_pull(&resident.worker_id, &instance, counter) {
                    return None;
                }
                let entry = roster.write_summary(summary.clone(), Some(&resident.worker_id), None);
                // The pull sees the same root-slot swap: the superseded
                // row retires, and the identity follow re-binds.
                let swapped = roster.swapped_out_root_rows(&resident.worker_id, &entry);
                for agent_id in &swapped {
                    roster.delete(agent_id);
                }
                (entry, swapped)
            };
            let root_identity_bearing =
                self.sync_root_identity_from_roster(resident, &mut descriptor);
            if root_identity_bearing {
                resident.clear_identity_quarantine();
            }
            (entry, swapped)
        };
        self.push_roster_update(vec![entry.clone()], swapped);
        Some(entry)
    }

    /// Refresh one resident worker's entry from its live `get_state` (registration, adoption, and
    /// create flows); `false` means the identity reconciliation did not run.
    pub(crate) async fn refresh_roster_entry(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
    ) -> bool {
        let response = self
            .route_command_typed(
                resident,
                "get_state",
                json!({}),
                ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await;
        let Ok(response) = response else {
            return false;
        };
        if !response.success {
            return false;
        }
        let Some(data) = response.data else {
            return false;
        };
        self.write_roster_summary_for_resident(resident, &data)
            .await
            .is_some()
    }

    /// `passivate_roster_worker` (TS `flipWorkerRosterEntriesInactive`,
    /// in place — no ledger reseed): the TOP-LEVEL row passivates keeping
    /// every durable display field (`lifecycle` stays `"live"`); an
    /// ephemeral worker's rows die; a subagent row keeps the family walk.
    pub(crate) async fn passivate_roster_worker(
        self: &Arc<Self>,
        worker_id: &str,
        ephemeral: bool,
    ) {
        let (owned, unowned_at_start) = {
            let mut roster = self.roster.lock().unwrap();
            let owned: Vec<AgentRosterEntry> = roster
                .entries_for_worker(worker_id)
                .into_iter()
                .cloned()
                .collect();
            // The unowned rows are snapshotted here: a family whose root
            // registers while this pass awaits would read as unanchored; the
            // snapshot scopes the sweep to rows existing at stop start.
            let unowned_at_start: Vec<AgentRosterEntry> = roster
                .entries()
                .into_iter()
                .filter(|entry| entry.worker_id.is_none())
                .collect();
            // The sequence slot dies BEFORE the ledger/roots awaits: a
            // stop that awaits first would race a re-registration and
            // delete the replacement's FRESH slot.
            roster.forget_worker_sequences(worker_id);
            (owned, unowned_at_start)
        };
        // The stopping worker's family view — live edges and surviving
        // resident roots — decides each subagent row's fate; a ledger
        // failure degrades to an empty view.
        let ledger_view = self.live_edges_and_parents().await;
        let empty_view: (
            Vec<crate::rlm_ledger::RlmLedgerEdge>,
            HashMap<PathBuf, PathBuf>,
        ) = (Vec::new(), HashMap::new());
        let (_, parent_by_child) = ledger_view.as_ref().unwrap_or(&empty_view);
        let roots = self.roster_seed_roots().await;
        // The stop's own ledger event: an RLM delete tombstoned its child
        // before the stop began, and the shutdown route was the
        // transcript's flush barrier, so the fold beside the ledger view
        // reads the final bucket - the later capture amendment yields the
        // same value, so no second push follows it.
        let bucket_fold = self.deleted_descendant_usage_bucket().await;
        // The ledger/roots awaits opened a late-write window. Only
        // rows that carry the STOPPED generation settle here: the
        // stopped worker's own in-flight delta can have written a row
        // the snapshot missed (settle it), but a same-session
        // re-registration reuses the worker id (the sequence-slot fix
        // assumes it) and its replacement rows are LIVE. The registry
        // decides, OUTSIDE the roster lock (an await cannot run under
        // it): the passivation caller removed the stopped resident
        // before this call, so a resident that is BACK in the registry
        // by now belongs to the replacement - return and let the
        // replacement's own registration/refresh own its rows (a
        // just-resumed session must not vanish or render inactive).
        let replacement_live = self
            .registry
            .get(worker_id)
            .await
            .is_some_and(|resident| !resident.route_state().retired);
        if replacement_live {
            return;
        }
        let mut changed = Vec::new();
        let mut removed = Vec::new();
        {
            let mut roster = self.roster.lock().unwrap();
            // The refreshed bucket applies FIRST: the settle loop's
            // passivated rewrites then attach the new value at store
            // time, and the rewritten rows ship in this same push - the
            // child's removal and its parent's new bucket together, with
            // no frame in between where the spend dips.
            if let Some((ticket, bucket)) = bucket_fold {
                changed.extend(roster.set_deleted_descendant_usage(ticket, bucket));
            }
            let mut settle: Vec<AgentRosterEntry> = owned;
            for late in roster.entries_for_worker(worker_id).into_iter().cloned() {
                if !settle
                    .iter()
                    .any(|entry: &AgentRosterEntry| entry.agent_id == late.agent_id)
                {
                    settle.push(late);
                }
            }
            for entry in settle {
                if roster
                    .get(&entry.agent_id)
                    .is_none_or(|current| current.worker_id.as_deref() != Some(worker_id))
                {
                    continue;
                }
                // TOP-LEVEL rows passivate in place (the view merges them
                // with the saved catalog row); a SUBAGENT row keeps the
                // family walk.
                let subagent = entry
                    .summary
                    .get("rlmChildId")
                    .and_then(Value::as_str)
                    .is_some();
                let anchored = !subagent
                    || entry
                        .summary
                        .get("sessionFile")
                        .and_then(Value::as_str)
                        .is_some_and(|file| {
                            parent_by_child
                                .get(&canonical_session_path(Path::new(file)))
                                .is_some_and(|parent| {
                                    family_descends_from(parent_by_child, parent, &roots)
                                })
                        });
                if !ephemeral && entry.queued_child != Some(true) && anchored {
                    let passivated =
                        roster.write_summary(passivated_summary(entry.summary), None, None);
                    changed.push(passivated);
                } else {
                    roster.delete(&entry.agent_id);
                    removed.push(entry.agent_id);
                }
            }
            // The seeded unowned rows outlived their departed root and
            // flashed as top-level rows: settle them with the same anchor
            // verdict as the owned rows, scoped to the snapshot.
            if ledger_view.is_ok() {
                for entry in &unowned_at_start {
                    if roster
                        .get(&entry.agent_id)
                        .is_none_or(|current| current.worker_id.is_some())
                    {
                        continue;
                    }
                    let subagent = entry
                        .summary
                        .get("rlmChildId")
                        .and_then(Value::as_str)
                        .is_some();
                    // Only seeded subagent rows are the sweep's business:
                    // a passivated TOP-LEVEL row is not a dead family's
                    // flash.
                    if !subagent {
                        continue;
                    }
                    let anchored = entry
                        .summary
                        .get("sessionFile")
                        .and_then(Value::as_str)
                        .is_some_and(|file| {
                            parent_by_child
                                .get(&canonical_session_path(Path::new(file)))
                                .is_some_and(|parent| {
                                    family_descends_from(parent_by_child, parent, &roots)
                                })
                        });
                    if !anchored {
                        roster.delete(&entry.agent_id);
                        removed.push(entry.agent_id.clone());
                    }
                }
            }
        }
        self.push_roster_update(changed, removed);
    }

    /// Push one `roster_update` to subscribed clients, content-diffed
    /// per entry against the last published form: an identical rewrite broadcasts nothing.
    pub(crate) fn push_roster_update(&self, changed: Vec<AgentRosterEntry>, removed: Vec<String>) {
        // ONE lock acquisition spans the diff, the rebase, and the send:
        // interleaved pushes would deliver stale A after B and then
        // suppress the correction.
        let mut last = self.last_published_roster.lock().unwrap();
        let mut changed = changed;
        changed.retain(|entry| {
            let Some(published) = serde_json::to_value(entry).ok() else {
                return true; // an unserializable entry always ships
            };
            let id = entry.agent_id.clone();
            let is_new = match last.get(&id) {
                Some(previous) => *previous != published,
                None => true,
            };
            if is_new {
                last.insert(id, published);
            }
            is_new
        });
        let mut removed = removed;
        removed.retain(|id| last.remove(id).is_some());
        if changed.is_empty() && removed.is_empty() {
            return;
        }
        let update = DaemonOutbound::RosterUpdate {
            changed: serde_json::to_value(changed).unwrap_or(Value::Null),
            removed: (!removed.is_empty()).then_some(removed),
            resync: None,
            rest: Map::default(),
        };
        let Ok(payload) = serde_json::to_value(&update) else {
            return;
        };
        let _ = self.events.send((
            ClientRouting::RosterSubscribers,
            std::sync::Arc::new(payload),
        ));
    }

    /// Broadcast one `roster_update` WITHOUT the content-diff guard (the
    /// seeded-row publish's replay contract): the content still REBASES the
    /// last-published map, so a later identical mutation drops.
    pub(crate) fn push_roster_update_unguarded(
        &self,
        changed: &[AgentRosterEntry],
        removed: Vec<String>,
    ) {
        if changed.is_empty() && removed.is_empty() {
            return;
        }
        // The rebase and the send share one lock hold.
        let mut last = self.last_published_roster.lock().unwrap();
        for entry in changed {
            if let Ok(published) = serde_json::to_value(entry) {
                last.insert(entry.agent_id.clone(), published);
            }
            // An unserializable row still shipped; dropping its map
            // entry only makes a later push ship again.
        }
        for id in &removed {
            last.remove(id);
        }
        let update = DaemonOutbound::RosterUpdate {
            changed: serde_json::to_value(changed).unwrap_or(Value::Null),
            removed: (!removed.is_empty()).then_some(removed),
            resync: None,
            rest: Map::default(),
        };
        let Ok(payload) = serde_json::to_value(&update) else {
            return;
        };
        let _ = self.events.send((
            ClientRouting::RosterSubscribers,
            std::sync::Arc::new(payload),
        ));
    }
}

/// TS `passivatedWorkerRosterEntry`: keep every durable display field,
/// strip only the live-runtime fields (heartbeat/cron marks survive).
fn passivated_summary(summary: Value) -> Value {
    let mut summary = summary;
    let Some(object) = summary.as_object_mut() else {
        return summary;
    };
    let keep_heartbeat = object
        .get("hasRegisteredHeartbeat")
        .and_then(Value::as_bool)
        == Some(true);
    let keep_cron = object.get("hasRegisteredCronJob").and_then(Value::as_bool) == Some(true);
    for key in [
        "activeSessionId",
        "directAttachedClients",
        "hasActiveHeartbeat",
        "hasRegisteredHeartbeat",
        "hasRegisteredCronJob",
        "hasRunningRlmChildren",
        "isBashRunning",
        "isRunningTools",
        "workerState",
        "workerPid",
    ] {
        object.remove(key);
    }
    object.insert("activity".to_string(), json!("idle"));
    object.insert("isSessionActive".to_string(), json!(false));
    object.insert("isStreaming".to_string(), json!(false));
    object.insert("isCompacting".to_string(), json!(false));
    object.insert("attachedClients".to_string(), json!(0));
    if keep_heartbeat {
        object.insert("hasRegisteredHeartbeat".to_string(), json!(true));
    }
    if keep_cron {
        object.insert("hasRegisteredCronJob".to_string(), json!(true));
    }
    if let Some(session_id) = object.get("sessionId").and_then(Value::as_str) {
        object.insert("id".to_string(), json!(session_id));
    }
    normalize_model_to_durable_pair(object);
    summary
}

/// The passivated row's `model` is the DURABLE pair `{provider, modelId}` the ledger-seed hydrate
/// writes and the agents view reads; a live summary's fuller descriptor collapses to it.
fn normalize_model_to_durable_pair(object: &mut serde_json::Map<String, Value>) {
    let Some(model) = object.get("model") else {
        return;
    };
    let Some(provider) = model.get("provider").and_then(Value::as_str) else {
        return;
    };
    if model.get("modelId").and_then(Value::as_str).is_some() {
        return;
    }
    let Some(model_id) = model.get("id").and_then(Value::as_str) else {
        return;
    };
    object.insert(
        "model".to_string(),
        json!({ "provider": provider, "modelId": model_id }),
    );
}

/// Drain the pushed roster frames (the events a subscribed client
/// pump forwards); anything else on the channel is not a roster push.
#[cfg(test)]
fn drain_roster_pushes(
    events: &mut tokio::sync::broadcast::Receiver<(ClientRouting, std::sync::Arc<Value>)>,
) -> Vec<Value> {
    let mut pushes = Vec::new();
    loop {
        match events.try_recv() {
            Ok((ClientRouting::RosterSubscribers, payload)) => pushes.push((*payload).clone()),
            Ok(_) => {}
            Err(
                tokio::sync::broadcast::error::TryRecvError::Empty
                | tokio::sync::broadcast::error::TryRecvError::Closed,
            ) => break,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(missed)) => {
                panic!("roster push subscriber lagged by {missed}; drain per delta");
            }
        }
    }
    pushes
}

#[cfg(test)]
mod delta_push;
#[cfg(test)]
mod passivation;
