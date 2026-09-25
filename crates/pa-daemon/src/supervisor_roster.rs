//! Supervisor-side roster serving: subscribe/unsubscribe handling, worker
//! roster deltas, the stop-path passivation, and the `roster_update`
//! pushes subscribers receive (the roster arms of TS
//! `daemon-supervisor.ts`; the store itself lives in `agent_roster.rs`,
//! and the seeding/hydration arms live in `supervisor_roster_seed.rs`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pa_types::daemon::agent_roster::AgentRosterEntry;
use pa_types::daemon::DaemonOutbound;
use serde_json::{json, Value};

use crate::lease::canonical_session_path;
use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::registry::ResidentWorker;
use crate::supervisor::{ClientRouting, Supervisor, ROUTE_TIMEOUT_MS};
use crate::supervisor_roster_seed::family_descends_from;

/// `worker_roster_delta`'s parsed frame (worker.rs `push_roster_delta`):
/// the summary, the removals, the sending worker's per-connection sequence
/// counter (the stale-delta gate's input: the roster's per-worker watermark
/// drops a delayed older snapshot, matching the TS worker's ordered socket
/// delivery), and the sending worker process instance (the generation the
/// roster's stale-delta slot names; a replacement process restarts the
/// counter under a new instance and the registration flips the slot to it).
pub(crate) struct WorkerRosterDelta {
    pub worker_token: String,
    pub summary: Value,
    pub removed: Vec<String>,
    pub sequence: Option<u64>,
    pub worker_instance_id: Option<String>,
}

impl Supervisor {
    /// `roster_subscribe` (TS: sets the client flag and answers with the
    /// full roster snapshot; the caller stores the flag). Pure in-memory:
    /// the boot seed and the create path's family seed
    /// (`supervisor_roster_seed.rs`) publish `roster_update` for rows
    /// that land between subscribes, so the answer itself never reads
    /// the ledger or a transcript.
    pub(crate) async fn handle_roster_subscribe(
        self: &Arc<Self>,
        command_id: &str,
        type_name: &str,
    ) -> DaemonResponse {
        // A registration seed's pushes must never overtake this answer
        // (a client that applies the push first and then the snapshot
        // would lose the seeded rows): drain the in-flight seed tasks
        // and await them to completion BEFORE the snapshot is read.
        // Finished handles await instantly; the take-and-await also
        // bounds the retained set on every subscribe.
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

    /// The seed roots (TS: every worker's `sessionFile` with the durable
    /// create's `sessionPath` as fallback), canonicalized.
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

    /// `roster_unsubscribe`.
    pub(crate) fn handle_roster_unsubscribe(
        &self,
        command_id: &str,
        type_name: &str,
    ) -> DaemonResponse {
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
        // The stale-delta gate and the write share ONE roster lock
        // acquisition: two accepted deltas must never write in reverse
        // order (each supervisor connection runs its own task), so the
        // accept order is the apply order. The gate drops both a delayed
        // older snapshot (a newer sequence already applied) and any frame
        // from a generation the roster's slot no longer names (a replaced
        // process's delayed delivery — stale by construction), and the
        // supervisor answers success for a stale delta (delivered, just
        // superseded). The summary write and any removals batch into the
        // single frame the one push carries (TS `applyWorkerRosterDelta`
        // + its coalescing `scheduleRosterPush`), never one push per
        // mutation.
        let mut changed = Vec::new();
        let mut removed_ids = Vec::new();
        {
            let mut roster = self.roster.lock().unwrap();
            if !roster.accept_delta_sequence(
                &resident.worker_id,
                worker_instance_id.as_deref().unwrap_or(""),
                sequence.unwrap_or(0),
            ) {
                return response_success(Some(command_id), type_name, None);
            }
            let entry = roster.write_summary(summary, Some(&resident.worker_id), None);
            changed.push(entry);
            for agent_id in removed {
                if roster.get(&agent_id).is_some() {
                    roster.delete(&agent_id);
                    removed_ids.push(agent_id);
                }
            }
        }
        self.push_roster_update(changed, removed_ids);
        response_success(Some(command_id), type_name, None)
    }

    /// Write one summary into the roster and push the change to
    /// subscribers. Returns the classified entry. Test-support arm: the
    /// production paths write through the sequence-gated
    /// [`Self::write_roster_summary_for_resident`] (the authoritative
    /// pull write); the plain write remains for the roster tests that
    /// place rows directly.
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
        // The counter stamp stays an Option: ABSENT means unsequenced
        // (a legacy summary that predates the sequence wire field) — an
        // authoritative write — while PRESENT-and-zero is the worker's
        // counter before its first push, a sequenced snapshot the gate
        // orders like any other (a delayed zero-counter pull must not
        // overwrite a newer delta's state, and a predecessor's must not
        // overwrite the replacement's row).
        let counter = summary
            .get("rosterDeltaSequence")
            .and_then(serde_json::Value::as_u64);
        let entry = {
            let mut roster = self.roster.lock().unwrap();
            if !roster.accept_roster_pull(&resident.worker_id, &instance, counter) {
                return None;
            }
            roster.write_summary(summary.clone(), Some(&resident.worker_id), None)
        };
        self.push_roster_update(vec![entry.clone()], Vec::new());
        Some(entry)
    }

    /// Refresh one resident worker's entry from its live `get_state`
    /// (registration, adoption, and create flows).
    pub(crate) async fn refresh_roster_entry(self: &Arc<Self>, resident: &Arc<ResidentWorker>) {
        let response = self
            .route_command(resident, "get_state", json!({}), ROUTE_TIMEOUT_MS)
            .await;
        if let Ok(response) = response {
            if response.success {
                if let Some(data) = response.data {
                    self.write_roster_summary_for_resident(resident, &data)
                        .await;
                }
            }
        }
    }

    /// TS `flipWorkerRosterEntriesInactive` (the Rust form: one pass in
    /// place, no ledger reseed, no transcript read): a stopped worker's
    /// rows settle where they are. An ephemeral (client-owned) worker's
    /// rows and queued children die with the registration; a subagent row
    /// whose ledger edge is tombstoned (or whose transcript is gone) dies
    /// with the deletion; a subagent row still descending from a
    /// surviving resident root passivates - its summary keeps every
    /// durable display field (model, thinking level, cwd) and drops only
    /// the live-only fields (TS `passivatedWorkerRosterEntry`); a
    /// top-level row is removed (a roster that passivated every stopped
    /// top-level row would grow forever).
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
            // The unowned rows this pass may settle, snapshotted where
            // `owned` is: a family whose root registers while this pass
            // awaits (its registration seed writes fresh unowned rows)
            // is missing from the pass's roots/ledger view, so a sweep
            // over the LIVE roster would read those just-seeded rows as
            // unanchored and drop a live resident family's display. The
            // snapshot scopes the sweep to the rows that existed when
            // the stop began - the only rows whose anchors this stop can
            // have changed - and the revalidation below still settles
            // rows a later pass owns.
            let unowned_at_start: Vec<AgentRosterEntry> = roster
                .entries()
                .into_iter()
                .filter(|entry| entry.worker_id.is_none())
                .collect();
            // The sequence slot dies with the rows' snapshot, BEFORE the
            // ledger/roots awaits: a stop that awaits first races a
            // re-registration of the same session (the replacement flips
            // the slot to its own instance and starts pushing) and would
            // then delete the FRESH slot here, after which the gate
            // accepts a predecessor frame as a fresh generation and
            // drops the replacement's live deltas. Clearing under this
            // first lock also bounds the slot map on every stop, even
            // when the worker owns no roster rows.
            roster.forget_worker_sequences(worker_id);
            (owned, unowned_at_start)
        };
        // The stopping worker's family view - live edges and the
        // surviving resident roots (the caller removed the worker from
        // the registry first) - decides each subagent row's fate. This is
        // the old remove+reseed's reach, without its per-family
        // transcript reads; a ledger failure degrades to an empty view
        // for the owned rows, exactly like the old reseed degraded to no
        // rows, while the unowned sweep below stays armed only on the
        // successful read (a transient ledger failure must not read as
        // "no anchors anywhere" for the display rows).
        let ledger_view = self.live_edges_and_parents().await;
        let empty_view: (
            Vec<crate::rlm_ledger::RlmLedgerEdge>,
            HashMap<PathBuf, PathBuf>,
        ) = (Vec::new(), HashMap::new());
        let (_, parent_by_child) = ledger_view.as_ref().unwrap_or(&empty_view);
        let roots = self.roster_seed_roots().await;
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
                // The snapshot predates the ledger/roots awaits: a
                // resumed worker can replace a row meanwhile, and only
                // rows this worker still owns settle here.
                if !roster
                    .get(&entry.agent_id)
                    .is_some_and(|current| current.worker_id.as_deref() == Some(worker_id))
                {
                    continue;
                }
                let subagent = entry
                    .summary
                    .get("rlmChildId")
                    .and_then(Value::as_str)
                    .is_some();
                // A subagent row survives only while a live edge still
                // carries it and a surviving resident root anchors its
                // family walk; everything else (top-level rows included)
                // is removed.
                let anchored = subagent
                    && entry
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
            // The unowned rows - the ones the boot/registration seeds
            // wrote and the loop above passivated - carry no worker, so
            // no stop ever revisited them: the rows a departed root's
            // registration seeded outlived the root (the registration
            // walk runs at register time, while the root is resident),
            // and the agents view rendered them as top-level rows until
            // the saved catalog re-parented them minutes later - the
            // operator's agents-view flash. The passivation's own anchor
            // rule settles them with the same verdict as the owned rows:
            // a subagent row whose family walk no longer reaches a
            // surviving resident root returns to the saved catalog
            // alone (the dead family stays resumable there), while the
            // anchored passivated rows keep their display. The sweep is
            // scoped to the unowned rows snapshotted at the pass's start
            // (rows seeded while this pass awaits belong to a family
            // this stop never anchored - their own registration proved
            // the root resident), and each row is revalidated under this
            // lock: a row that vanished, or a worker claimed since the
            // snapshot, is not this pass's to settle. The sweep needs
            // the ledger view the pass already read; a failed read
            // leaves the display rows untouched.
            if ledger_view.is_ok() {
                for entry in &unowned_at_start {
                    if !roster
                        .get(&entry.agent_id)
                        .is_some_and(|current| current.worker_id.is_none())
                    {
                        continue;
                    }
                    let subagent = entry
                        .summary
                        .get("rlmChildId")
                        .and_then(Value::as_str)
                        .is_some();
                    let anchored = subagent
                        && entry
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

    /// Push one `roster_update` to subscribed clients. The TS supervisor
    /// batches pending mutations into one push; roster writes are low-rate
    /// here, so each mutation pushes immediately and subscribers apply
    /// entries idempotently by agent id.
    pub(crate) fn push_roster_update(&self, changed: Vec<AgentRosterEntry>, removed: Vec<String>) {
        if changed.is_empty() && removed.is_empty() {
            return;
        }
        let update = DaemonOutbound::RosterUpdate {
            changed: serde_json::to_value(&changed).unwrap_or(Value::Null),
            removed: (!removed.is_empty()).then_some(removed),
            resync: None,
            rest: Default::default(),
        };
        let Ok(payload) = serde_json::to_value(&update) else {
            return;
        };
        let _ = self
            .events
            .send((ClientRouting::RosterSubscribers, payload));
    }
}

/// TS `passivatedWorkerRosterEntry`: the stop keeps every durable display
/// field - the model selector, the thinking level, the cwd, the session
/// identity rows - and strips only the live-runtime fields; the heartbeat
/// and cron registration marks survive when they were true.
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

/// The passivated row's `model` is the DURABLE pair
/// `{provider, modelId}` - the same row shape the ledger-seed hydrate
/// writes (`hydrate_summary_display`) and the TS `SessionSummary.model`
/// the agents view reads. A live worker's `get_state` summary carries the
/// fuller live-catalog descriptor `{id, name, provider, reasoning}` (the
/// #2631 reasoning-controls metadata); the stop keeps the durable
/// display field, so the live descriptor collapses to the pair - the id
/// IS the durable model id.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor_roster_seed::tests::{
        append_family_edge, drain_pending_seeds_for_tests, live_child_summary,
        register_root_worker, roster_fixture, roster_row_for_child, write_display_file,
    };
    use pa_types::daemon::agent_roster::AgentRosterStatus;

    /// `roster_subscribe` is a pure in-memory snapshot: a family the
    /// ledger knows (with readable transcripts, unseeded) never enters
    /// the roster through the subscribe answer - the old per-switch
    /// reseed read the whole family here.
    #[tokio::test]
    async fn subscribe_is_a_pure_in_memory_snapshot() {
        let (dir, supervisor, root_file, child_file) = roster_fixture().await;
        register_root_worker(&supervisor, "w-root", &root_file).await;
        let agent_dir = dir.join("agent");
        append_family_edge(
            &agent_dir,
            &agent_dir.join("sessions"),
            "sub-9",
            &root_file,
            &child_file,
        );
        let mut events = supervisor.events.subscribe();
        // The root's live row is the only roster row.
        let mut root_summary = live_child_summary(&root_file, &child_file);
        root_summary["runtimeKind"] = json!("top-level");
        root_summary["sessionId"] = json!("root-persisted");
        root_summary["id"] = json!("root-persisted");
        root_summary["sessionFile"] = json!(root_file.to_string_lossy());
        root_summary.as_object_mut().unwrap().remove("rlmChildId");
        root_summary
            .as_object_mut()
            .unwrap()
            .remove("parentSessionPath");
        supervisor.write_roster_summary(&root_summary, Some("w-root"));
        let _ = drain_roster_pushes(&mut events);

        let first = supervisor
            .handle_roster_subscribe("s1", "roster_subscribe")
            .await;
        assert!(first.success);
        let roster = first.data.expect("roster snapshot")["roster"].clone();
        assert_eq!(
            roster.as_array().map(Vec::len),
            Some(1),
            "only the in-memory row answers: {roster}"
        );
        // A pure snapshot is stable: subscribing again answers the same.
        let second = supervisor
            .handle_roster_subscribe("s2", "roster_subscribe")
            .await;
        assert_eq!(second.data.expect("roster snapshot")["roster"], roster);
        assert!(
            drain_roster_pushes(&mut events).is_empty(),
            "subscribe never pushes"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// TS `flipWorkerRosterEntriesInactive`: a stopped subagent under a
    /// surviving resident root passivates in place - the summary keeps
    /// its model, thinking level, and cwd, and drops only the
    /// live-runtime fields. One push carries the settled row.
    #[tokio::test]
    async fn stop_passivates_an_anchored_child_preserving_display_fields() {
        let (dir, supervisor, root_file, child_file) = roster_fixture().await;
        register_root_worker(&supervisor, "w-root", &root_file).await;
        let agent_dir = dir.join("agent");
        append_family_edge(
            &agent_dir,
            &agent_dir.join("sessions"),
            "sub-9",
            &root_file,
            &child_file,
        );
        let mut events = supervisor.events.subscribe();
        supervisor.write_roster_summary(
            &live_child_summary(&root_file, &child_file),
            Some("w-child"),
        );
        let _ = drain_roster_pushes(&mut events);

        supervisor.passivate_roster_worker("w-child", false).await;
        let pushes = drain_roster_pushes(&mut events);
        assert_eq!(pushes.len(), 1, "one settle push: {pushes:?}");
        assert_eq!(pushes[0]["changed"].as_array().map(Vec::len), Some(1));
        assert!(pushes[0]["removed"].is_null() || pushes[0]["removed"].as_array().is_none());
        let row = roster_row_for_child(&supervisor, "sub-9");
        assert_eq!(row.worker_id, None, "the row is no longer worker-owned");
        assert!(row.summary.get("activeSessionId").is_none());
        assert!(row.summary.get("workerState").is_none());
        assert!(row.summary.get("workerPid").is_none());
        assert_eq!(row.summary["activity"], "idle");
        assert_eq!(row.summary["isStreaming"], false);
        assert_eq!(row.status, AgentRosterStatus::Inactive);
        // The durable display rows survive the stop.
        assert_eq!(row.summary["cwd"], "/the/live/cwd");
        assert_eq!(row.summary["model"]["provider"], "live");
        assert_eq!(row.summary["thinkingLevel"], "low");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A live worker's summary carries the full live-catalog model
    /// descriptor (`{id, name, provider, reasoning}`, the #2631
    /// reasoning-controls metadata); the passivated row keeps the
    /// DURABLE display field - the `{provider, modelId}` pair the
    /// ledger-seed hydrate writes and the agents view reads (the
    /// thinking_level e2e's post-stop assertion).
    #[tokio::test]
    async fn passivation_normalizes_the_live_model_descriptor_to_the_durable_pair() {
        let (dir, supervisor, root_file, child_file) = roster_fixture().await;
        register_root_worker(&supervisor, "w-root", &root_file).await;
        let agent_dir = dir.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        append_family_edge(&agent_dir, &sessions_dir, "sub-9", &root_file, &child_file);
        let mut live = live_child_summary(&root_file, &child_file);
        live["model"] = json!({
            "id": "mock-1",
            "name": "Mock 1",
            "provider": "battery",
            "reasoning": true,
        });
        let _ = supervisor.write_roster_summary(&live, Some("w-child"));
        let mut events = supervisor.events.subscribe();
        let _ = drain_roster_pushes(&mut events);
        supervisor.passivate_roster_worker("w-child", false).await;
        let pushes = drain_roster_pushes(&mut events);
        assert_eq!(pushes.len(), 1, "the passivated row publishes: {pushes:?}");
        let row = roster_row_for_child(&supervisor, "sub-9");
        assert_eq!(
            row.summary["model"],
            json!({ "provider": "battery", "modelId": "mock-1" }),
            "the durable pair, not the live descriptor: {row:?}"
        );
        assert_eq!(row.summary["thinkingLevel"], json!("low"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rows without an anchor are removed, never passivated: a
    /// tombstoned ledger edge (the user deleted the subagent), a live
    /// edge with no resident root, a top-level row, a queued child, and
    /// an ephemeral worker's rows all die with the stop.
    #[tokio::test]
    async fn stop_removes_unanchored_rows() {
        let (dir, supervisor, root_file, child_file) = roster_fixture().await;
        let agent_dir = dir.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        let mut events = supervisor.events.subscribe();

        // A tombstoned child: the edge is deleted, so no live edge
        // carries the row even though the files exist.
        append_family_edge(&agent_dir, &sessions_dir, "sub-9", &root_file, &child_file);
        let ledger = crate::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
        ledger
            .append_delete(
                "sub-9",
                &child_file.to_string_lossy(),
                crate::rlm_ledger::RlmLedgerDeleteReason::User,
            )
            .expect("append delete");
        register_root_worker(&supervisor, "w-root", &root_file).await;
        supervisor.write_roster_summary(
            &live_child_summary(&root_file, &child_file),
            Some("w-child"),
        );
        let _ = drain_roster_pushes(&mut events);
        supervisor.passivate_roster_worker("w-child", false).await;
        let pushes = drain_roster_pushes(&mut events);
        let removed: Vec<String> = pushes[0]["removed"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect();
        assert_eq!(removed.len(), 1, "the tombstoned row dies: {pushes:?}");
        assert!(supervisor.roster.lock().unwrap().get(&removed[0]).is_none());

        // A live edge but no resident root: no surviving root, no row.
        let orphan_file = sessions_dir.join("sub-orphan.jsonl");
        write_display_file(&orphan_file, "/the/orphan/cwd");
        append_family_edge(
            &agent_dir,
            &sessions_dir,
            "sub-orphan",
            &root_file,
            &orphan_file,
        );
        let mut orphan_summary = live_child_summary(&root_file, &orphan_file);
        orphan_summary["rlmChildId"] = json!("sub-orphan");
        supervisor.write_roster_summary(&orphan_summary, Some("w-orphan"));
        // Drop every resident worker: nothing anchors the family.
        for worker in supervisor.registry.list().await {
            supervisor.registry.remove(&worker.worker_id).await;
        }
        let _ = drain_roster_pushes(&mut events);
        supervisor.passivate_roster_worker("w-orphan", false).await;
        let pushes = drain_roster_pushes(&mut events);
        assert!(
            pushes[0]["removed"]
                .as_array()
                .is_some_and(|ids| !ids.is_empty()),
            "an unanchored row dies: {pushes:?}"
        );

        // A top-level row is removed, exactly like the remove+reseed it
        // replaces (the reseed never resurrected roots).
        let mut top_summary = live_child_summary(&root_file, &child_file);
        top_summary["runtimeKind"] = json!("top-level");
        top_summary["sessionId"] = json!("root-persisted");
        top_summary["id"] = json!("root-persisted");
        top_summary["sessionFile"] = json!(root_file.to_string_lossy());
        top_summary.as_object_mut().unwrap().remove("rlmChildId");
        top_summary
            .as_object_mut()
            .unwrap()
            .remove("parentSessionPath");
        supervisor.write_roster_summary(&top_summary, Some("w-top"));
        let _ = drain_roster_pushes(&mut events);
        supervisor.passivate_roster_worker("w-top", false).await;
        let pushes = drain_roster_pushes(&mut events);
        assert!(
            pushes[0]["removed"]
                .as_array()
                .is_some_and(|ids| ids.len() == 1),
            "the top-level row dies: {pushes:?}"
        );

        // A queued child and an ephemeral worker's rows die with the stop.
        let mut queued_summary = live_child_summary(&root_file, &child_file);
        queued_summary["rlmChildId"] = json!("sub-queued");
        queued_summary["queuedChild"] = json!(true);
        let queued_child_file = sessions_dir.join("sub-queued.jsonl");
        write_display_file(&queued_child_file, "/the/queued/cwd");
        append_family_edge(
            &agent_dir,
            &sessions_dir,
            "sub-queued",
            &root_file,
            &queued_child_file,
        );
        queued_summary["sessionFile"] = json!(queued_child_file.to_string_lossy());
        supervisor.write_roster_summary(&queued_summary, Some("w-queued"));
        let _ = drain_roster_pushes(&mut events);
        supervisor.passivate_roster_worker("w-queued", true).await;
        let pushes = drain_roster_pushes(&mut events);
        assert!(
            pushes[0]["removed"]
                .as_array()
                .is_some_and(|ids| ids.len() == 1),
            "the queued/ephemeral row dies: {pushes:?}"
        );
        assert!(supervisor
            .roster
            .lock()
            .unwrap()
            .entries()
            .iter()
            .all(
                |entry| entry.summary.get("rlmChildId").and_then(Value::as_str)
                    != Some("sub-queued")
            ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The unowned half of the stop pass: the rows the boot and
    /// registration seeds write carry no worker, so the family's
    /// departure never revisited them - the rows a departed root seeded
    /// outlived the root and the agents view rendered them as top-level
    /// rows until the saved catalog re-parented them minutes later (the
    /// operator's flash). The anchor rule settles them with the same
    /// verdict as the owned rows: the family that lost its last resident
    /// root returns to the saved catalog alone, while another root's
    /// anchored seeded row keeps its display.
    #[tokio::test]
    async fn stop_prunes_seeded_rows_of_a_family_that_lost_its_root() {
        let (dir, supervisor, root_file, child_file) = roster_fixture().await;
        let agent_dir = dir.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        // The surviving root's family: its seeded child stays anchored
        // through the other root's stop.
        let survivor_file = sessions_dir.join("root-2.jsonl");
        let survivor_child = sessions_dir.join("sub-live.jsonl");
        write_display_file(&survivor_file, "/the/survivor/cwd");
        write_display_file(&survivor_child, "/the/survivor/child/cwd");
        register_root_worker(&supervisor, "w-survivor", &survivor_file).await;
        append_family_edge(
            &agent_dir,
            &sessions_dir,
            "sub-live",
            &survivor_file,
            &survivor_child,
        );
        append_family_edge(&agent_dir, &sessions_dir, "sub-9", &root_file, &child_file);
        register_root_worker(&supervisor, "w-root", &root_file).await;
        // The stopping root owns its own top-level row, like the
        // production stop does (the worker's summary push).
        let mut root_summary = live_child_summary(&root_file, &child_file);
        root_summary["runtimeKind"] = json!("top-level");
        root_summary["sessionId"] = json!("root-persisted");
        root_summary["id"] = json!("root-persisted");
        root_summary["sessionFile"] = json!(root_file.to_string_lossy());
        root_summary.as_object_mut().unwrap().remove("rlmChildId");
        root_summary
            .as_object_mut()
            .unwrap()
            .remove("parentSessionPath");
        supervisor.write_roster_summary(&root_summary, Some("w-root"));
        // The boot seed publishes both families' seeded rows.
        supervisor.spawn_roster_boot_seed();
        drain_pending_seeds_for_tests(&supervisor).await;
        let mut events = supervisor.events.subscribe();
        let _ = drain_roster_pushes(&mut events);
        let _ = roster_row_for_child(&supervisor, "sub-9");
        let _ = roster_row_for_child(&supervisor, "sub-live");

        // The stop: the caller removed the resident from the registry
        // first (both `stop_worker` and the give-up do exactly this).
        supervisor.registry.remove("w-root").await;
        supervisor.passivate_roster_worker("w-root", false).await;

        let pushes = drain_roster_pushes(&mut events);
        let removed: Vec<String> = pushes
            .iter()
            .flat_map(|push| {
                push["removed"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|id| id.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(
            removed.iter().any(|id| id.ends_with("#sub-9")),
            "the orphaned family's seeded row leaves the roster (and the subscribers): {removed:?}"
        );
        let roster = supervisor.roster.lock().unwrap();
        assert!(
            !roster.entries().iter().any(|entry| entry
                .summary
                .get("rlmChildId")
                .and_then(Value::as_str)
                == Some("sub-9")),
            "the departed family's seeded row is gone"
        );
        drop(roster);
        // The surviving root's family keeps its seeded display row.
        let kept = roster_row_for_child(&supervisor, "sub-live");
        assert_eq!(
            kept.worker_id, None,
            "the anchored seeded row stays unowned"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The operator's flash at the response boundary: a store seeded with
    /// hundreds of dead subagent sessions under a family whose root
    /// departs. While the root is resident the roster serves the seeded
    /// family (TS `seedRosterLedger` parity - a resident root's passive
    /// descendants render); the stop must leave the first roster snapshot
    /// clean, so the agents view's first frame never dumps the dead
    /// family's rows as top-level entries.
    #[tokio::test]
    async fn stop_leaves_the_first_roster_snapshot_clean_behind_hundreds_of_seeded_rows() {
        let (dir, supervisor, root_file, _child_file) = roster_fixture().await;
        let agent_dir = dir.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        register_root_worker(&supervisor, "w-root", &root_file).await;
        for index in 0..300 {
            let seeded_child = sessions_dir.join(format!("sub-flash-{index}.jsonl"));
            write_display_file(&seeded_child, "/the/flash/cwd");
            append_family_edge(
                &agent_dir,
                &sessions_dir,
                &format!("sub-flash-{index}"),
                &root_file,
                &seeded_child,
            );
        }
        supervisor.spawn_roster_boot_seed();
        drain_pending_seeds_for_tests(&supervisor).await;
        let before = supervisor
            .handle_roster_subscribe("s1", "roster_subscribe")
            .await;
        let roster = before.data.expect("roster snapshot")["roster"].clone();
        let family_rows = roster
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter(|entry| {
                        entry["summary"]["rlmChildId"]
                            .as_str()
                            .is_some_and(|id| id.starts_with("sub-flash-"))
                    })
                    .count()
            })
            .unwrap_or_default();
        assert_eq!(
            family_rows, 300,
            "a resident root's seeded family serves to subscribers (TS parity)"
        );

        // The root departs: its family loses its only anchor.
        supervisor.registry.remove("w-root").await;
        supervisor.passivate_roster_worker("w-root", false).await;

        let after = supervisor
            .handle_roster_subscribe("s2", "roster_subscribe")
            .await;
        let roster = after.data.expect("roster snapshot")["roster"].clone();
        let family_rows = roster
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter(|entry| {
                        entry["summary"]["rlmChildId"]
                            .as_str()
                            .is_some_and(|id| id.starts_with("sub-flash-"))
                    })
                    .count()
            })
            .unwrap_or_default();
        assert_eq!(
            family_rows, 0,
            "the first roster snapshot behind a departed family is clean: {roster:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// TS `passivatedWorkerRosterEntry` keeps the registration marks that
    // were true and strips the live-runtime fields, including the
    // heartbeat's own active flag.
    #[test]
    fn passivation_keeps_registration_marks_and_strips_live_fields() {
        let passivated = passivated_summary(json!({
            "sessionId": "persisted-id",
            "activeSessionId": "a-child",
            "activity": "working",
            "isSessionActive": true,
            "isStreaming": true,
            "isCompacting": true,
            "attachedClients": 2,
            "directAttachedClients": 2,
            "hasActiveHeartbeat": true,
            "hasRegisteredHeartbeat": true,
            "hasRegisteredCronJob": false,
            "hasRunningRlmChildren": true,
            "isBashRunning": true,
            "isRunningTools": true,
            "workerState": "ready",
            "workerPid": 4242,
            "cwd": "/the/live/cwd",
            "model": { "provider": "live", "modelId": "lm" },
            "thinkingLevel": "low",
        }));
        assert_eq!(passivated["id"], "persisted-id");
        assert_eq!(passivated["activity"], "idle");
        assert_eq!(passivated["isSessionActive"], false);
        assert_eq!(passivated["isStreaming"], false);
        assert_eq!(passivated["isCompacting"], false);
        assert_eq!(passivated["attachedClients"], 0);
        for key in [
            "activeSessionId",
            "directAttachedClients",
            "hasActiveHeartbeat",
            "hasRegisteredCronJob",
            "hasRunningRlmChildren",
            "isBashRunning",
            "isRunningTools",
            "workerState",
            "workerPid",
        ] {
            assert!(passivated.get(key).is_none(), "{key} is live-only");
        }
        assert_eq!(
            passivated["hasRegisteredHeartbeat"], true,
            "the mark survives"
        );
        assert_eq!(passivated["cwd"], "/the/live/cwd");
        assert_eq!(
            passivated["model"],
            json!({ "provider": "live", "modelId": "lm" })
        );
        assert_eq!(passivated["thinkingLevel"], "low");
    }

    /// Live roster parity: a re-registration over the same session file
    /// replaces the passivated row with the live one, so a resumed
    /// session never renders its stale passive row.
    #[tokio::test]
    async fn a_reregistration_replaces_the_passive_row() {
        let (dir, supervisor, root_file, child_file) = roster_fixture().await;
        register_root_worker(&supervisor, "w-root", &root_file).await;
        let agent_dir = dir.join("agent");
        append_family_edge(
            &agent_dir,
            &agent_dir.join("sessions"),
            "sub-9",
            &root_file,
            &child_file,
        );
        let mut events = supervisor.events.subscribe();
        supervisor.write_roster_summary(
            &live_child_summary(&root_file, &child_file),
            Some("w-child"),
        );
        let _ = drain_roster_pushes(&mut events);
        supervisor.passivate_roster_worker("w-child", false).await;
        let _ = drain_roster_pushes(&mut events);

        let mut resumed = live_child_summary(&root_file, &child_file);
        resumed["model"] = json!({ "provider": "resumed", "modelId": "rm" });
        resumed["activity"] = json!("idle");
        resumed["isStreaming"] = json!(false);
        resumed["isSessionActive"] = json!(false);
        supervisor.write_roster_summary(&resumed, Some("w-resumed"));
        let row = roster_row_for_child(&supervisor, "sub-9");
        assert_eq!(row.worker_id.as_deref(), Some("w-resumed"));
        assert_eq!(row.summary["model"]["provider"], "resumed");
        assert_eq!(row.status, AgentRosterStatus::Idle);
        assert_eq!(
            supervisor.roster.lock().unwrap().entries().len(),
            1,
            "the passive row was replaced, not duplicated"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- the `worker_roster_delta` push contract ---

    /// A supervisor with one registered resident worker, carrying the
    /// token `handle_worker_roster_delta` authenticates.
    async fn supervisor_with_registered_worker(dir: &Path) -> Supervisor {
        let supervisor = Supervisor::new(crate::supervisor::SupervisorOptions {
            socket_path: dir.join("daemon.sock"),
            agent_dir: dir.join("agent"),
        })
        .expect("supervisor");
        let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
            version: 1,
            worker_id: "w-delta".to_string(),
            pid: 4242,
            process_start_id: None,
            socket_path: dir.join("worker.sock").to_string_lossy().to_string(),
            recovery_journal_path: dir.join("recovery.jsonl").to_string_lossy().to_string(),
            orphan_process_journal_path: None,
            supervisor_socket_path: dir.join("daemon.sock").to_string_lossy().to_string(),
            authentication_token: "delta-token".to_string(),
            worker_instance_id: None,
            root_active_session_id: "a-delta".to_string(),
            owner_client_id: None,
            root_session_id: None,
            session_file: Some(dir.join("session.jsonl").to_string_lossy().to_string()),
            session_dir: Some(dir.to_string_lossy().to_string()),
            telemetry_disabled: Some(true),
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
            lifecycle: pa_types::daemon::DaemonWorkerLifecycle::Ready,
            create_command: pa_types::daemon::DurableDaemonCreateCommand {
                session_path: None,
                no_session: None,
                rest: Default::default(),
            },
            consecutive_failures: 0,
            stop_requested_at: None,
            archive_on_stop: None,
            last_failure_at: None,
            last_error: None,
            rest: Default::default(),
        };
        supervisor
            .registry
            .insert(ResidentWorker::new(
                "w-delta".to_string(),
                descriptor,
                dir.join("descriptor.json"),
            ))
            .await;
        supervisor
    }

    /// The worker's session summary in the wire shape `push_roster_delta`
    /// sends (worker.rs `session_summary`): the busy flip carries
    /// `activity: "working"` / `isStreaming: true`, the idle flip settles
    /// both back.
    fn flip_summary(dir: &Path, busy: bool) -> Value {
        json!({
            "id": "a-delta",
            "lifecycle": "active",
            "activity": if busy { "working" } else { "idle" },
            "isSessionActive": busy,
            "isStreaming": busy,
            "isCompacting": false,
            "activeSessionId": "a-delta",
            "sessionId": "s-delta",
            "sessionFile": dir.join("session.jsonl").to_string_lossy(),
            "sessionName": "bench",
            "cwd": dir.to_string_lossy(),
            "rlmDepth": 0,
            "runtimeKind": "top-level",
            "messageCount": 12,
            "attachedClients": 0,
            "thinkingLevel": "default",
            "lastActivityAt": "2026-09-23T00:00:00.000Z",
            "created": "2026-09-23T00:00:00.000Z",
            "modified": "2026-09-23T00:00:00.000Z",
            "workerState": "ready",
            "workerPid": 4242,
        })
    }

    /// Drain the pushed roster frames (the events a subscribed client
    /// pump forwards); anything else on the channel is not a roster push.
    fn drain_roster_pushes(
        events: &mut tokio::sync::broadcast::Receiver<(ClientRouting, Value)>,
    ) -> Vec<Value> {
        let mut pushes = Vec::new();
        loop {
            match events.try_recv() {
                Ok((ClientRouting::RosterSubscribers, payload)) => pushes.push(payload),
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

    /// The stale-delta gate at the handler: the worker's per-request
    /// supervisor links deliver deltas unordered, so a delayed older
    /// snapshot (a lower sequence) must not overwrite a newer one — the
    /// TS worker never has this race (its roster deltas ride one ordered
    /// supervisor client socket).
    #[tokio::test]
    async fn worker_roster_delta_drops_stale_sequences() {
        fn summary(level: &str) -> Value {
            serde_json::json!({
                "sessionId": "s1",
                "activeSessionId": "s1",
                "activity": "idle",
                "thinkingLevel": level,
            })
        }
        async fn delta(
            supervisor: &Arc<Supervisor>,
            token: &str,
            level: &str,
            sequence: Option<u64>,
            instance: &str,
        ) -> DaemonResponse {
            supervisor
                .handle_worker_roster_delta(
                    "d",
                    "worker_roster_delta",
                    WorkerRosterDelta {
                        worker_token: token.to_string(),
                        summary: summary(level),
                        removed: Vec::new(),
                        sequence,
                        worker_instance_id: Some(instance.to_string()),
                    },
                )
                .await
        }

        let dir = std::env::temp_dir().join(format!("pa-roster-seq-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let supervisor = Arc::new(
            Supervisor::new(crate::supervisor::SupervisorOptions {
                socket_path: dir.join("supervisor.sock"),
                agent_dir: dir.join("agent"),
            })
            .expect("supervisor"),
        );
        let descriptor: pa_types::daemon::DaemonWorkerDescriptor =
            serde_json::from_value(serde_json::json!({
                "version": 2,
                "workerId": "seq-worker",
                "pid": 0,
                "socketPath": "/tmp/none.sock",
                "recoveryJournalPath": "/tmp/none.jsonl",
                "supervisorSocketPath": "/tmp/none.sock",
                "authenticationToken": "seq-token",
                "workerInstanceId": "i1",
                "rootActiveSessionId": "s1",
                "createdAt": "2026-09-23T00:00:00Z",
                "updatedAt": "2026-09-23T00:00:00Z",
                "lifecycle": "ready",
                "createCommand": {},
                "consecutiveFailures": 0,
            }))
            .expect("descriptor");
        supervisor
            .registry
            .insert(ResidentWorker::new(
                "seq-worker".to_string(),
                descriptor,
                dir.join("descriptor.json"),
            ))
            .await;
        let entry_level = || {
            supervisor
                .roster
                .lock()
                .unwrap()
                .get("s1")
                .map(|entry| entry.summary["thinkingLevel"].clone())
                .expect("the roster entry")
        };
        // A fresh worker's create/registration pull stamps the ZERO        // A fresh worker's create/registration pull stamps the ZERO
        // counter (the worker has pushed nothing yet): it starts the
        // slot and applies — the create path's first authoritative
        // write.
        let resident = supervisor
            .registry
            .get("seq-worker")
            .await
            .expect("resident");
        let mut fresh_pull = summary("off");
        fresh_pull["rosterDeltaSequence"] = serde_json::json!(0);
        fresh_pull["workerInstanceId"] = serde_json::json!("i1");
        let fresh = supervisor
            .write_roster_summary_for_resident(&resident, &fresh_pull)
            .await;
        assert!(
            fresh.is_some(),
            "a stamped-zero pull starts the slot: {fresh:?}"
        );
        assert_eq!(entry_level(), serde_json::json!("off"));
        // In-order deltas apply (the newer level lands).
        let applied = delta(&supervisor, "seq-token", "high", Some(2), "i1").await;
        assert!(applied.success, "sequence 2 applies: {applied:?}");
        assert_eq!(entry_level(), serde_json::json!("high"));
        // The delayed older snapshot (sequence 1, delivered after 2) answers
        // success but never overwrites the newer state.
        let stale = delta(&supervisor, "seq-token", "low", Some(1), "i1").await;
        assert!(
            stale.success,
            "a stale delta still answers success: {stale:?}"
        );
        assert_eq!(
            entry_level(),
            serde_json::json!("high"),
            "the stale snapshot never overwrites the newer one"
        );
        // A newer sequence applies again.
        let applied = delta(&supervisor, "seq-token", "low", Some(3), "i1").await;
        assert!(applied.success, "sequence 3 applies: {applied:?}");
        assert_eq!(entry_level(), serde_json::json!("low"));
        // The authoritative pull gates in the same lock section that
        // writes: the summary's embedded counter (the get_state snapshot
        // read the worker's counter, stamped with the answering
        // instance) applies and raises the watermark, so a delta still in
        // flight when the pull answered is dropped instead of
        // overwriting the pull's fresher state.
        let mut pulled = summary("off");
        pulled["rosterDeltaSequence"] = serde_json::json!(4);
        pulled["workerInstanceId"] = serde_json::json!("i1");
        let pull = supervisor
            .write_roster_summary_for_resident(&resident, &pulled)
            .await;
        assert!(pull.expect("pull entry").summary["thinkingLevel"] == serde_json::json!("off"));
        assert_eq!(entry_level(), serde_json::json!("off"));
        let stale = delta(&supervisor, "seq-token", "high", Some(4), "i1").await;
        assert!(
            stale.success,
            "the in-flight delta answers success: {stale:?}"
        );
        assert_eq!(
            entry_level(),
            serde_json::json!("off"),
            "a delta older than the pull never overwrites the pull"
        );
        // A pull whose counter is below the applied watermark is stale:
        // a delta stamped after the pull's snapshot already applied, so
        // the older in-flight refresh never overwrites it.
        let mut stale_pull = summary("medium");
        stale_pull["rosterDeltaSequence"] = serde_json::json!(3);
        stale_pull["workerInstanceId"] = serde_json::json!("i1");
        assert!(
            supervisor
                .write_roster_summary_for_resident(&resident, &stale_pull)
                .await
                .is_none(),
            "an older in-flight refresh drops"
        );
        assert_eq!(entry_level(), serde_json::json!("off"));
        // A delayed ZERO-counter pull is sequenced like any other: its
        // snapshot was taken before the first push, so once a newer
        // delta applied it is the stale one and drops instead of
        // overwriting the newer state with pre-change data.
        let mut zero_pull = summary("high");
        zero_pull["rosterDeltaSequence"] = serde_json::json!(0);
        zero_pull["workerInstanceId"] = serde_json::json!("i1");
        assert!(
            supervisor
                .write_roster_summary_for_resident(&resident, &zero_pull)
                .await
                .is_none(),
            "a delayed pre-push pull never overwrites a newer delta"
        );
        assert_eq!(entry_level(), serde_json::json!("off"));
        // A replacement process registers (the registration notes the
        // new generation) and its counter-restarted sequences apply —
        // never compared against the predecessor's watermark.
        supervisor
            .roster
            .lock()
            .unwrap()
            .note_worker_generation("seq-worker", "i2");
        let replacement = delta(&supervisor, "seq-token", "medium", Some(1), "i2").await;
        assert!(
            replacement.success,
            "the replacement applies: {replacement:?}"
        );
        assert_eq!(entry_level(), serde_json::json!("medium"));
        // The predecessor's delayed frames drop on the generation
        // mismatch whatever their sequence: the replacement's
        // registration made them stale by construction.
        let predecessor = delta(&supervisor, "seq-token", "high", Some(9_000_000), "i1").await;
        assert!(
            predecessor.success,
            "a superseded frame still answers success: {predecessor:?}"
        );
        assert_eq!(entry_level(), serde_json::json!("medium"));
        // A delayed pull answered by the replaced process drops the same
        // way — its high counter never pins the replacement's restarted
        // counter out of the roster.
        let mut predecessor_pull = summary("low");
        predecessor_pull["rosterDeltaSequence"] = serde_json::json!(9_000_000);
        predecessor_pull["workerInstanceId"] = serde_json::json!("i1");
        assert!(
            supervisor
                .write_roster_summary_for_resident(&resident, &predecessor_pull)
                .await
                .is_none(),
            "a superseded pull drops"
        );
        assert_eq!(entry_level(), serde_json::json!("medium"));
        // The predecessor's DELAYED zero-counter pull drops the same
        // way on the generation mismatch: the stamped zero orders
        // against the slot, it is not the unsequenced legacy value.
        let mut predecessor_zero_pull = summary("low");
        predecessor_zero_pull["rosterDeltaSequence"] = serde_json::json!(0);
        predecessor_zero_pull["workerInstanceId"] = serde_json::json!("i1");
        assert!(
            supervisor
                .write_roster_summary_for_resident(&resident, &predecessor_zero_pull)
                .await
                .is_none(),
            "a superseded zero-counter pull drops"
        );
        assert_eq!(entry_level(), serde_json::json!("medium"));
        // An unsequenced delta applies (a caller that stamped nothing).
        let unsequenced = delta(&supervisor, "seq-token", "low", None, "i2").await;
        assert!(unsequenced.success, "unsequenced applies: {unsequenced:?}");
        assert_eq!(entry_level(), serde_json::json!("low"));
        // A wrong token still fails authentication, before the gate.
        let rejected = delta(&supervisor, "wrong-token", "high", Some(9), "i2").await;
        assert!(
            !rejected.success,
            "authentication still gates: {rejected:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Wrap one delta's fields in the parsed frame shape the handler takes
    /// (unsequenced: these tests exercise the batching cadence, not the
    /// stale-delta gate).
    fn delta_frame(worker_token: &str, summary: Value, removed: Vec<String>) -> WorkerRosterDelta {
        WorkerRosterDelta {
            worker_token: worker_token.to_string(),
            summary,
            removed,
            sequence: None,
            worker_instance_id: None,
        }
    }

    /// TS parity for the delta push cadence (`daemon-supervisor.ts`
    /// `applyWorkerRosterDelta` + `scheduleRosterPush`): one
    /// `worker_roster_delta` produces one `roster_update` — the entry
    /// write and the removals batch into one coalesced flush, never one
    /// push per mutation. A subscriber counts the pushes, so a duplicate
    /// is wire-visible.
    #[tokio::test]
    async fn worker_roster_delta_pushes_one_update_per_flip() {
        let dir = tempfile::tempdir().expect("temp dir");
        let supervisor = Arc::new(supervisor_with_registered_worker(dir.path()).await);
        let mut events = supervisor.events.subscribe();

        // The busy flip of a turn start: one push, running.
        supervisor
            .handle_worker_roster_delta(
                "d1",
                "worker_roster_delta",
                delta_frame("delta-token", flip_summary(dir.path(), true), Vec::new()),
            )
            .await;
        let pushes = drain_roster_pushes(&mut events);
        assert_eq!(pushes.len(), 1, "one roster_update per delta: {pushes:?}");
        assert_eq!(pushes[0]["changed"][0]["status"], "running");
        assert_eq!(
            pushes[0]["changed"][0]["summary"]["activeSessionId"],
            "a-delta"
        );

        // The idle flip at settle: one push, idle.
        supervisor
            .handle_worker_roster_delta(
                "d2",
                "worker_roster_delta",
                delta_frame("delta-token", flip_summary(dir.path(), false), Vec::new()),
            )
            .await;
        let pushes = drain_roster_pushes(&mut events);
        assert_eq!(pushes.len(), 1, "one roster_update per delta: {pushes:?}");
        assert_eq!(pushes[0]["changed"][0]["status"], "idle");
    }

    /// A delta carrying removals batches them with the summary write into
    /// the same single push (the TS apply writes entries and deletes
    /// removals before the one `scheduleRosterPush` flush).
    #[tokio::test]
    async fn worker_roster_delta_batches_removals_into_the_same_push() {
        let dir = tempfile::tempdir().expect("temp dir");
        let supervisor = Arc::new(supervisor_with_registered_worker(dir.path()).await);
        let mut events = supervisor.events.subscribe();

        // A child agent the delta will remove: a subagent summary keyed
        // parent session path + child id.
        let child_summary = json!({
            "activity": "idle",
            "isSessionActive": false,
            "activeSessionId": "a-child",
            "sessionId": "s-child",
            "rlmChildId": "c-1",
            "parentSessionPath": dir
                .path()
                .join("session.jsonl")
                .to_string_lossy(),
            "runtimeKind": "subagent",
            "rlmDepth": 1,
        });
        supervisor
            .handle_worker_roster_delta(
                "d1",
                "worker_roster_delta",
                delta_frame("delta-token", child_summary, Vec::new()),
            )
            .await;
        let child_pushes = drain_roster_pushes(&mut events);
        assert_eq!(
            child_pushes.len(),
            1,
            "one roster_update per delta: {child_pushes:?}"
        );
        let child_agent_id = child_pushes[0]["changed"][0]["agentId"]
            .as_str()
            .expect("child agent id")
            .to_string();

        // One delta carrying both the parent's summary and the child
        // removal: still exactly one push, entry and removal together.
        supervisor
            .handle_worker_roster_delta(
                "d2",
                "worker_roster_delta",
                delta_frame(
                    "delta-token",
                    flip_summary(dir.path(), true),
                    vec![child_agent_id.clone()],
                ),
            )
            .await;
        let pushes = drain_roster_pushes(&mut events);
        assert_eq!(
            pushes.len(),
            1,
            "removals batch into the delta push: {pushes:?}"
        );
        assert_eq!(pushes[0]["changed"].as_array().map(Vec::len), Some(1));
        assert_eq!(pushes[0]["removed"][0], json!(child_agent_id));
    }

    /// The busy/idle flip cadence benchmark: alternating deltas against a
    /// subscribed supervisor, counting `roster_update` pushes and their
    /// serialized payloads per flip. Each push serializes twice
    /// supervisor-side (the changed entries and the outbound frame), so
    /// the serialization count is double the push count. Run with
    /// `cargo test -p pa-daemon roster_delta_push_benchmark -- --ignored
    /// --nocapture`.
    #[ignore]
    #[tokio::test]
    async fn roster_delta_push_benchmark() {
        const FLIPS: usize = 2000;
        const WARMUP_FLIPS: usize = 50;
        let dir = tempfile::tempdir().expect("temp dir");
        let supervisor = Arc::new(supervisor_with_registered_worker(dir.path()).await);
        let mut events = supervisor.events.subscribe();

        // Warm-up flips keep allocator noise out of the timed window.
        for i in 0..WARMUP_FLIPS {
            let summary = flip_summary(dir.path(), i % 2 == 0);
            supervisor
                .handle_worker_roster_delta(
                    "warm",
                    "worker_roster_delta",
                    delta_frame("delta-token", summary.clone(), Vec::new()),
                )
                .await;
            drain_roster_pushes(&mut events);
        }

        let mut pushes = 0usize;
        let mut payload_bytes = 0usize;
        let mut handler_nanos = 0u128;
        for i in 0..FLIPS {
            let summary = flip_summary(dir.path(), i % 2 == 0);
            let start = std::time::Instant::now();
            supervisor
                .handle_worker_roster_delta(
                    "b",
                    "worker_roster_delta",
                    delta_frame("delta-token", summary.clone(), Vec::new()),
                )
                .await;
            handler_nanos += start.elapsed().as_nanos();
            for push in drain_roster_pushes(&mut events) {
                pushes += 1;
                payload_bytes += serde_json::to_string(&push).map_or(0, |payload| payload.len());
            }
        }
        let flips = FLIPS as f64;
        println!("flips: {FLIPS}");
        println!(
            "roster_update pushes: {pushes} ({:.3}/flip)",
            pushes as f64 / flips
        );
        println!(
            "supervisor-side serializations: {} ({:.3}/flip; two per push)",
            2 * pushes,
            2.0 * pushes as f64 / flips
        );
        println!(
            "pushed payload bytes: {payload_bytes} ({:.0}/flip)",
            payload_bytes as f64 / flips
        );
        println!(
            "handler wall time: {:.2} us/flip",
            handler_nanos as f64 / flips / 1000.0
        );
    }
}
