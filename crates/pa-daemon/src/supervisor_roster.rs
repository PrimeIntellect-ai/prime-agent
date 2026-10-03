//! Supervisor-side roster serving: subscribe/unsubscribe handling, worker
//! roster deltas, the stop-path passivation, and the `roster_update`
//! pushes subscribers receive (the roster arms of TS
//! `daemon-supervisor.ts`; the store itself lives in `agent_roster.rs`,
//! and the seeding/hydration arms live in `supervisor_roster_seed.rs`).

use serde_json::Map;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use pa_types::daemon::agent_roster::AgentRosterEntry;
use pa_types::daemon::DaemonOutbound;
use serde_json::{json, Value};

use crate::backpressure::RouteAdmission;
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

/// A cold mesh scan pays bounded connect timeouts for every offline
/// peer; `list` waits no longer than this for it and serves last-known
/// rows instead (TS `REMOTE_MESH_LIST_REFRESH_WAIT_MS`).
pub(crate) const REMOTE_MESH_LIST_REFRESH_WAIT: Duration = Duration::from_millis(5_000);
/// The `send_message` fallback shares the bounded refresh on a tighter
/// budget: the sender is waiting on an error path, so discovery must not
/// hold it for `list`'s span (TS `REMOTE_MESH_MESSAGE_REFRESH_WAIT_MS`).
pub(crate) const REMOTE_MESH_MESSAGE_REFRESH_WAIT: Duration = Duration::from_millis(2_000);
/// `list_agent_peers` answers a worker request bounded by
/// [`AGENT_PEER_LIST_REQUEST_TIMEOUT_MS`], and a cold mesh scan pays
/// bounded connect timeouts for every offline peer: the refresh takes
/// half that budget and serves last-known rows, so the local siblings and
/// the response fit in the rest instead of racing the worker's timeout
/// to a silent empty peer list (TS `REMOTE_MESH_PEERS_REFRESH_WAIT_MS`).
pub(crate) const REMOTE_MESH_PEERS_REFRESH_WAIT: Duration =
    Duration::from_millis(crate::protocol::AGENT_PEER_LIST_REQUEST_TIMEOUT_MS / 2);

impl Supervisor {
    /// The mesh's refreshed entries for the roster snapshot (TS
    /// `rosterEntriesForClient`'s mesh arm): remote mesh rows have no
    /// worker, so visibility is unconditional, and the snapshot answers
    /// from the cache - a scan started now lands as an ordinary roster
    /// push, so subscribe never blocks on tailnet peers.
    pub(crate) fn remote_roster_entries(&self) -> Vec<AgentRosterEntry> {
        self.remote_mesh
            .as_ref()
            .map(crate::remote_mesh::RemoteAgentMeshState::entries_for_clients)
            .unwrap_or_default()
    }

    /// Bounded on-demand mesh refresh (TS `refreshRemoteMesh`): a no-op
    /// when no mesh source is configured.
    pub(crate) async fn refresh_remote_mesh(&self, wait: Duration) {
        if let Some(mesh) = self.remote_mesh.as_ref() {
            if mesh.enabled() {
                mesh.refresh_awaiting(wait).await;
            }
        }
    }

    /// Fresh depth-0 peer rows (TS `remotePeerSummaries`):
    /// `list_agent_peers` refreshes the mesh itself on a budget that fits
    /// the worker's request window.
    pub(crate) async fn remote_peer_summaries(&self) -> Vec<Value> {
        self.refresh_remote_mesh(REMOTE_MESH_PEERS_REFRESH_WAIT)
            .await;
        self.remote_mesh
            .as_ref()
            .map(crate::remote_mesh::RemoteAgentMeshState::peer_summaries)
            .unwrap_or_default()
    }

    /// Publish one mesh roster change batch (the drain task's arm): the
    /// changed rows publish through the same content-diff guard as worker
    /// rows, so an identical remote row broadcasts nothing (the TS
    /// roster-churn fix rides the supervisor's existing guard).
    pub(crate) fn push_mesh_roster_update(&self, changed: &[String], removed: Vec<String>) {
        let entries: Vec<AgentRosterEntry> = changed
            .iter()
            .filter_map(|agent_id| {
                self.remote_mesh
                    .as_ref()
                    .and_then(|mesh| mesh.entry_by_id(agent_id))
            })
            .collect();
        self.push_roster_update(entries, removed);
    }

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
        // The snapshot answers from the mesh cache; a scan started now
        // lands as an ordinary roster push, so subscribe never blocks on
        // tailnet peers (TS #2516's roster_subscribe arm).
        {
            let supervisor = Arc::clone(self);
            tokio::spawn(async move {
                if let Some(mesh) = supervisor.remote_mesh.as_ref() {
                    if mesh.enabled() {
                        let _ = mesh.refresh_if_stale().await;
                    }
                }
            });
        }
        let mut roster = self.roster.lock().unwrap().entries();
        roster.extend(self.remote_roster_entries());
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
        // One per-worker critical section spans the roster write AND the
        // identity follow (the resident's descriptor lock — the same lock
        // every identity reader takes): a routing reader can never observe
        // a half-applied swap, and an older follow can never persist after
        // a newer one (each accepted row carries its own follow inside the
        // same guard, so the persists apply in accept order).
        //
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
                // The worker's root slot can swap to a new durable session
                // (a `new_session`/`switch_session`/`import_jsonl`/`fork`
                // replacement serves a new file under the same address):
                // the row it previously owned for that address described
                // the superseded session, and the roster must not keep
                // presenting it as the worker's live root (TS
                // `flushRoster`'s swapped-in-place removal).
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
            // The roster write is the worker's live word on what it
            // serves: the supervisor-side identity follows it inside the
            // same critical section (the fork-isolation seam — the
            // descriptor, the persisted record, the durable create
            // command, and the binding table all move onto the worker's
            // current session). The boot reconciliation quarantine lifts
            // ONLY on a root-identity-bearing write: the sync answers
            // whether the worker's own root row carried the live word —
            // a subagent/child summary (keying under its own address)
            // never lifts the root's fence.
            let root_identity_bearing =
                self.sync_root_identity_from_roster(&resident, &mut descriptor);
            if root_identity_bearing {
                resident.clear_identity_quarantine();
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
        let (entry, swapped) = {
            // The pull shares the delta path's per-worker critical
            // section (the resident's descriptor lock across the roster
            // write and the identity follow): the registration and
            // refresh pulls land their descriptor/persist/binding moves
            // as one transition, in accept order, never observable
            // half-applied.
            let mut descriptor = resident.descriptor.lock().await;
            let (entry, swapped) = {
                let mut roster = self.roster.lock().unwrap();
                if !roster.accept_roster_pull(&resident.worker_id, &instance, counter) {
                    return None;
                }
                let entry = roster.write_summary(summary.clone(), Some(&resident.worker_id), None);
                // The pull sees the same root-slot swap the deltas do (a
                // registration or refresh landing after a
                // `new_session`/`switch_session`/`import_jsonl`/`fork`
                // replacement): the superseded row retires with the write,
                // and the identity follow below re-binds the
                // supervisor-side identity onto the moved-to session.
                let swapped = roster.swapped_out_root_rows(&resident.worker_id, &entry);
                for agent_id in &swapped {
                    roster.delete(agent_id);
                }
                (entry, swapped)
            };
            // The pull is the worker's own root state by construction, so
            // its accepted write lifts the boot reconciliation quarantine
            // with the identity it just reconciled.
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

    /// Refresh one resident worker's entry from its live `get_state`
    /// (registration, adoption, and create flows). Returns whether the
    /// live state landed: the write carries the root-identity follow, so
    /// a `false` answer means the reconciliation did not run — the caller
    /// logs it and the persisted identity keeps serving until the next
    /// roster write.
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

    /// TS `flipWorkerRosterEntriesInactive` (the Rust form: one pass in
    /// place, no ledger reseed, no transcript read): a stopped worker's
    /// rows settle where they are. An ephemeral (client-owned) worker's
    /// rows and queued children die with the registration; the TOP-LEVEL
    /// row passivates, exactly like TS (TS
    /// `passivatedWorkerRosterEntry` keeps every durable display field -
    /// model, thinking level, cwd - and `lifecycle` stays `"live"`), so a
    /// stopped session's row stays visible in the agents view instead of
    /// vanishing until the next catalog scan re-lists it from disk; a
    /// subagent row keeps the family walk (the live edge and a surviving
    /// resident root anchor it; the tombstoned edge of a deleted child
    /// dies with the deletion). The roster's growth with passivated
    /// top-level rows is daemon-lifetime bounded (TS accepts the same),
    /// and the unowned sweep below still settles the dead seeded
    /// families (the #2716 flash).
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
                // The snapshot predates the ledger/roots awaits: a
                // resumed worker can replace a row meanwhile, and only
                // rows this worker still owns settle here.
                if roster
                    .get(&entry.agent_id)
                    .is_none_or(|current| current.worker_id.as_deref() != Some(worker_id))
                {
                    continue;
                }
                // TS `flipWorkerRosterEntriesInactive` (the non-ephemeral,
                // non-queued arms): a stopped worker's TOP-LEVEL row
                // rewrites passivated (TS `passivatedWorkerRosterEntry`
                // keeps `lifecycle: "live"` and every durable display
                // field), so a stopped session's row stays visible in the
                // view instead of vanishing until a catalog scan re-lists
                // it from disk - the agents view merges the passivated
                // row with its saved catalog row by identity, so it never
                // renders twice, and a re-registration replaces the
                // passive row in place. A SUBAGENT row keeps the family
                // walk: the live edge and a surviving resident root anchor
                // it (the tombstoned edge of a deleted child dies with the
                // deletion; a dead family's child returns to the saved
                // catalog alone - the #2716 flash design).
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
                    // a passivated TOP-LEVEL row is unowned too (the stop
                    // pass cleared its worker), but it is a stopped
                    // session's visible row, not a dead family's flash.
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

    /// Push one `roster_update` to subscribed clients. The TS supervisor
    /// batches pending mutations into one push and content-diffs each
    /// entry against what it last published (TS #2481): an identical
    /// rewrite is dropped from the push (an update whose entries all
    /// match their last published forms broadcasts nothing), so the wire
    /// never re-ships an unchanged row. The diff is per entry, not per
    /// frame: a changed row still reaches subscribers alongside an
    /// unchanged sibling in one push.
    pub(crate) fn push_roster_update(&self, changed: Vec<AgentRosterEntry>, removed: Vec<String>) {
        // ONE lock acquisition spans the diff decision, the baseline
        // rebase, and the send: two concurrent pushes cannot interleave
        // as A-diff+A-rebase, B-diff+B-rebase+B-send, A-send —
        // subscribers would apply stale A after B while the map records
        // B (and then suppresses the correction). The broadcast send is
        // sync (the tokio broadcast channel delivers in send order), so
        // holding the std mutex across it serializes the pushes exactly.
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

    /// Broadcast one `roster_update` WITHOUT the content-diff guard: the
    /// seeded-row publish's replay contract (a row the roster still holds
    /// verbatim re-ships to make sure subscribers have it — see
    /// [`Self::push_seeded_rows`]'s own identity gate, which is that
    /// path's unchanged-row filter). Every mutation-driven push goes
    /// through the guarded [`Self::push_roster_update`] instead. The
    /// shipped content still REBASES the last-published map — the replay
    /// did publish, so a later identical mutation is correctly dropped
    /// and a later removal of the row correctly passes the guard.
    pub(crate) fn push_roster_update_unguarded(
        &self,
        changed: &[AgentRosterEntry],
        removed: Vec<String>,
    ) {
        if changed.is_empty() && removed.is_empty() {
            return;
        }
        // The rebase and the send share one lock hold: the replay's
        // baseline update and its broadcast are one serialized operation
        // (the same ordering guarantee the guarded arm holds).
        let mut last = self.last_published_roster.lock().unwrap();
        for entry in changed {
            if let Ok(published) = serde_json::to_value(entry) {
                last.insert(entry.agent_id.clone(), published);
            }
            // An unserializable row still shipped; dropping its map
            // entry only makes a later identical push ship again
            // (idempotent by agent id), never skips one.
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
mod mesh_tests;
#[cfg(test)]
mod passivation;
