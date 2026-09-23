//! Supervisor-side roster serving: subscribe/unsubscribe handling, worker
//! roster deltas, the ledger seed that keeps passivated RLM children in
//! the live roster, and the `roster_update` pushes subscribers receive
//! (the roster arms of TS `daemon-supervisor.ts`; the store itself lives in
//! `agent_roster.rs`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pa_types::daemon::agent_roster::{roster_agent_id_for_summary, AgentRosterEntry};
use pa_types::daemon::DaemonOutbound;
use serde_json::{json, Value};

use crate::lease::canonical_session_path;
use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::registry::ResidentWorker;
use crate::rlm_ledger::RlmLedgerEdge;
use crate::session_store::read_session_info;
use crate::supervisor::{ClientRouting, Supervisor, ROUTE_TIMEOUT_MS};

impl Supervisor {
    /// `roster_subscribe` (TS: sets the client flag and answers with the
    /// full roster snapshot; the caller stores the flag). The ledger seed
    /// runs first so a new subscriber sees the whole family immediately:
    /// resident rows plus every passivated ledger descendant of them.
    pub(crate) async fn handle_roster_subscribe(
        self: &Arc<Self>,
        command_id: &str,
        type_name: &str,
    ) -> DaemonResponse {
        self.seed_roster_ledger().await;
        let roster = self.roster.lock().unwrap().entries();
        response_success(
            Some(command_id),
            type_name,
            Some(json!({ "roster": roster })),
        )
    }

    /// TS `seedRosterLedger`: seed passivated ledger-descended children
    /// into the live roster for subscribers. Roots are the resident
    /// workers' session files; only live edges descending from a root
    /// seed (descent is membership at any step of the parent walk, so a
    /// worker registered mid-tree seeds its descendants, never its
    /// siblings or ancestors); an edge whose agent id or session file is
    /// already rostered never writes a second row. Failures degrade to a
    /// log line, exactly like the TS boot seed: the seed must never fail
    /// the surface that triggered it.
    pub(crate) async fn seed_roster_ledger(self: &Arc<Self>) {
        let roots = self.roster_seed_roots().await;
        if roots.is_empty() {
            return;
        }
        // The seed degrades to a log line on any failure, exactly like
        // the TS boot seed (including the unresolvable-home error the
        // ledger's sessions dir reports).
        let ledger = match self.rlm_spawn_ledger_for(None).await {
            Ok(ledger) => ledger,
            Err(error) => {
                self.log_line(&format!(
                    "Could not seed the agent roster from the spawn ledger: {error:#}"
                ));
                return;
            }
        };
        let edges = match ledger.live_edges() {
            Ok(edges) => edges,
            Err(error) => {
                self.log_line(&format!(
                    "Could not seed the agent roster from the spawn ledger: {error:#}"
                ));
                return;
            }
        };
        let parent_by_child: HashMap<PathBuf, PathBuf> = edges
            .iter()
            .map(|edge| {
                (
                    canonical_session_path(Path::new(&edge.child)),
                    canonical_session_path(Path::new(&edge.parent)),
                )
            })
            .collect();
        // Hydration reads one child at a time, outside the roster lock
        // (TS: a large ledger must not fan out into concurrent reads).
        let mut candidates = Vec::new();
        for edge in &edges {
            let parent = canonical_session_path(Path::new(&edge.parent));
            if !family_descends_from(&parent_by_child, &parent, &roots) {
                continue;
            }
            candidates.push(SeededRosterEntry::for_edge(edge));
        }
        if candidates.is_empty() {
            return;
        }
        let mut changed = Vec::new();
        {
            let mut roster = self.roster.lock().unwrap();
            for candidate in candidates {
                if roster.get(&candidate.agent_id).is_some() {
                    continue;
                }
                if roster.has_session_file(&candidate.child_file) {
                    continue;
                }
                changed.push(roster.write_seeded(candidate.summary, candidate.seeded_cwd));
            }
        }
        self.push_roster_update(changed, Vec::new());
    }

    /// The seed roots (TS: every worker's `sessionFile` with the durable
    /// create's `sessionPath` as fallback), canonicalized.
    async fn roster_seed_roots(self: &Arc<Self>) -> HashSet<PathBuf> {
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

    /// `worker_roster_delta`: a worker pushes its slim session summary (the
    /// Rust-native form of the TS `roster_delta` worker frame) so the
    /// roster tracks live status without polling. Authenticated by the
    /// worker token, like `worker_register`. One delta pushes one
    /// `roster_update`: the summary write and any removals batch into a
    /// single frame (TS `applyWorkerRosterDelta` + its coalescing
    /// `scheduleRosterPush`), never one push per mutation.
    pub(crate) async fn handle_worker_roster_delta(
        self: &Arc<Self>,
        command_id: &str,
        type_name: &str,
        worker_token: &str,
        summary: Value,
        removed: Vec<String>,
    ) -> DaemonResponse {
        let Some(resident) = self.registry.find_by_token(worker_token).await else {
            return response_failure(
                Some(command_id),
                type_name,
                "Worker authentication failed",
                None,
            );
        };
        // The delta write skips `write_roster_summary`'s per-write push
        // (that helper serves the create/adoption flows, where one write
        // is one push): the entry write and the removals batch into one
        // `roster_update`, the TS `applyWorkerRosterDelta` cadence (its
        // scheduleRosterPush coalesces the whole frame's mutations).
        let changed = vec![
            self.roster
                .lock()
                .unwrap()
                .write_summary(summary, Some(&resident.worker_id), None),
        ];
        let mut removed_ids = Vec::new();
        for agent_id in removed {
            let mut roster = self.roster.lock().unwrap();
            if roster.get(&agent_id).is_some() {
                roster.delete(&agent_id);
                removed_ids.push(agent_id);
            }
        }
        self.push_roster_update(changed, removed_ids);
        response_success(Some(command_id), type_name, None)
    }

    /// Write one summary into the roster and push the change to
    /// subscribers. Returns the classified entry.
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

    /// Refresh one resident worker's entry from its live `get_state`
    /// (registration, adoption, and create flows).
    pub(crate) async fn refresh_roster_entry(self: &Arc<Self>, resident: &Arc<ResidentWorker>) {
        let response = self
            .route_command(resident, "get_state", json!({}), ROUTE_TIMEOUT_MS)
            .await;
        if let Ok(response) = response {
            if response.success {
                if let Some(data) = response.data {
                    self.write_roster_summary(&data, Some(&resident.worker_id));
                }
            }
        }
    }

    /// Remove a stopped worker's entries and push the removals.
    pub(crate) fn remove_roster_worker(&self, worker_id: &str) {
        let removed: Vec<String> = {
            let mut roster = self.roster.lock().unwrap();
            let ids: Vec<String> = roster
                .entries_for_worker(worker_id)
                .iter()
                .map(|entry| entry.agent_id.clone())
                .collect();
            for id in &ids {
                roster.delete(id);
            }
            ids
        };
        self.push_roster_update(Vec::new(), removed);
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

/// One seeded roster row candidate: the edge-built summary, the roster
/// agent id it keys under, the canonical child file (the duplicate
/// guard), and whether the cwd stayed unhydrated (TS `seededCwd`).
struct SeededRosterEntry {
    agent_id: String,
    child_file: String,
    summary: Value,
    seeded_cwd: bool,
}

impl SeededRosterEntry {
    /// TS `rosterEntryForSpawnLedgerEdge` + `hydratedSeedEntry`: the row
    /// comes from the edge alone, with the cwd hydrated from the child's
    /// session file when it reads (an unreadable file keeps the dirname
    /// fallback and carries `seededCwd` for a later lazy hydration).
    fn for_edge(edge: &RlmLedgerEdge) -> Self {
        let child = Path::new(&edge.child);
        let persisted_session_id = child
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let dirname = child
            .parent()
            .map(|dir| dir.to_string_lossy().to_string())
            .unwrap_or_default();
        // The session-file read hydrates display fields only (topology is
        // the edge's): the cwd, the persisted model selector, and the
        // persisted thinking level - the same durable rows a live worker's
        // summary reports, so a passivated subagent keeps rendering
        // "model:level" in the agents view.
        let mut model = Value::Null;
        let mut thinking_level = Value::Null;
        let (cwd, seeded_cwd) = match read_session_info(child) {
            Some(info) => {
                if let Some((provider, model_id)) = &info.model {
                    model = json!({ "provider": provider, "modelId": model_id });
                }
                if let Some(level) = &info.thinking_level {
                    thinking_level = json!(level);
                }
                (info.cwd, false)
            }
            None => (dirname, true),
        };
        let mut summary = json!({
            "id": persisted_session_id,
            "lifecycle": "live",
            "activity": "idle",
            "isSessionActive": false,
            "runtimeKind": "subagent",
            "rlmDepth": edge.depth,
            "sessionId": persisted_session_id,
            "sessionFile": edge.child,
            "sessionName": edge.name,
            "cwd": cwd,
            "isStreaming": false,
            "isCompacting": false,
            "attachedClients": 0,
            "messageCount": 0,
            "parentSessionPath": edge.parent,
            "rlmChildId": edge.child_id,
        });
        if let Some(object) = summary.as_object_mut() {
            if !model.is_null() {
                object.insert("model".to_string(), model);
            }
            if !thinking_level.is_null() {
                object.insert("thinkingLevel".to_string(), thinking_level);
            }
        }
        Self {
            agent_id: roster_agent_id_for_summary(&summary),
            child_file: canonical_session_path(child).to_string_lossy().to_string(),
            summary,
            seeded_cwd,
        }
    }
}

/// TS `rosterFamilyDescendsFrom`: descent is membership at any step of
/// the parent walk (workers can register mid-tree, e.g. a resumed
/// subagent transcript), never a comparison against the ultimate root
/// alone. The cycle guard is the visited set.
fn family_descends_from(
    parent_by_child: &HashMap<PathBuf, PathBuf>,
    start: &Path,
    roots: &HashSet<PathBuf>,
) -> bool {
    let mut visited = HashSet::new();
    let mut current = start.to_path_buf();
    while visited.insert(current.clone()) {
        if roots.contains(&current) {
            return true;
        }
        match parent_by_child.get(&current) {
            Some(parent) => current = parent.clone(),
            None => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rlm_ledger::RlmLedgerEdge;

    fn edge(child_id: &str, parent: &str, child: &str, depth: u32, name: &str) -> RlmLedgerEdge {
        RlmLedgerEdge {
            child_id: child_id.to_string(),
            parent: parent.to_string(),
            child: child.to_string(),
            depth,
            name: name.to_string(),
            deleted: None,
        }
    }

    fn roots(paths: &[&str]) -> HashSet<PathBuf> {
        paths.iter().map(|path| PathBuf::from(*path)).collect()
    }

    #[test]
    fn descent_matches_at_any_parent_walk_step() {
        let edges = [
            edge("c1", "/live/root.jsonl", "/gone/c1.jsonl", 1, "w1"),
            edge("c2", "/gone/c1.jsonl", "/gone/c2.jsonl", 2, "w2"),
            edge("c3", "/dead/root.jsonl", "/dead/c3.jsonl", 1, "w3"),
        ];
        let parent_by_child: HashMap<PathBuf, PathBuf> = edges
            .iter()
            .map(|edge| {
                (
                    PathBuf::from(edge.child.as_str()),
                    PathBuf::from(edge.parent.as_str()),
                )
            })
            .collect();
        // A chain of any length under a live root descends from it.
        assert!(family_descends_from(
            &parent_by_child,
            Path::new("/live/root.jsonl"),
            &roots(&["/live/root.jsonl"])
        ));
        assert!(family_descends_from(
            &parent_by_child,
            Path::new("/gone/c1.jsonl"),
            &roots(&["/live/root.jsonl"])
        ));
        // A dead family never descends, and a sibling root never claims
        // another family's chain.
        assert!(!family_descends_from(
            &parent_by_child,
            Path::new("/dead/root.jsonl"),
            &roots(&["/live/root.jsonl"])
        ));
        assert!(!family_descends_from(
            &parent_by_child,
            Path::new("/dead/c3.jsonl"),
            &roots(&["/live/root.jsonl"])
        ));
        // A mid-tree root seeds its descendant, never its sibling.
        assert!(family_descends_from(
            &parent_by_child,
            Path::new("/gone/c1.jsonl"),
            &roots(&["/gone/c1.jsonl"])
        ));
        assert!(!family_descends_from(
            &parent_by_child,
            Path::new("/dead/root.jsonl"),
            &roots(&["/gone/c1.jsonl"])
        ));
    }

    #[test]
    fn seeded_rows_shape_matches_the_ts_entry() {
        let dir = std::env::temp_dir().join(format!("pa-seed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let child = dir.join("sub-9.jsonl");
        // The child file carries the durable display rows a live worker's
        // summary reports: the model selector and the thinking level.
        std::fs::write(
            &child,
            "{\"type\":\"session\",\"version\":3,\"id\":\"persisted-id\",\"timestamp\":\"t\",\"cwd\":\"/tmp/project\"}\n             {\"type\":\"model_change\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":\"t\",\"provider\":\"p\",\"modelId\":\"m\"}\n             {\"type\":\"thinking_level_change\",\"id\":\"t1\",\"parentId\":\"m1\",\"timestamp\":\"t\",\"thinkingLevel\":\"high\"}\n",
        )
        .unwrap();
        let candidate = SeededRosterEntry::for_edge(&edge(
            "sub-9",
            "/live/root.jsonl",
            &child.to_string_lossy(),
            1,
            "worker-a",
        ));
        // The hydrated row: cwd from the child file, no seed marker.
        assert!(!candidate.seeded_cwd);
        assert_eq!(candidate.summary["cwd"], "/tmp/project");
        // TS `rosterEntryForSpawnLedgerEdge`: the persisted session id is
        // the child file stem, never read from the file's own header.
        assert_eq!(candidate.summary["sessionId"], "sub-9");
        assert_eq!(candidate.summary["runtimeKind"], "subagent");
        assert_eq!(candidate.summary["rlmChildId"], "sub-9");
        assert_eq!(candidate.summary["rlmDepth"], 1);
        assert_eq!(candidate.summary["sessionName"], "worker-a");
        assert_eq!(candidate.summary["messageCount"], 0);
        assert_eq!(candidate.summary["parentSessionPath"], "/live/root.jsonl");
        assert_eq!(candidate.summary["isSessionActive"], false);
        // The durable display rows hydrate the seeded row: a passivated
        // subagent keeps rendering "model:level" in the agents view.
        assert_eq!(
            candidate.summary["model"],
            json!({ "provider": "p", "modelId": "m" })
        );
        assert_eq!(candidate.summary["thinkingLevel"], json!("high"));
        // The agent id keys parentPath#childId like the resident row.
        assert_eq!(candidate.agent_id, "/live/root.jsonl#sub-9");
        assert_eq!(
            candidate.child_file,
            child.canonicalize().unwrap().to_string_lossy().to_string()
        );

        // An unreadable child file: dirname fallback plus seededCwd.
        let missing = SeededRosterEntry::for_edge(&edge(
            "sub-x",
            "/live/root.jsonl",
            "/artifacts/gone/sub-x.jsonl",
            2,
            "w",
        ));
        assert!(missing.seeded_cwd);
        assert_eq!(missing.summary["cwd"], "/artifacts/gone");
        assert_eq!(missing.summary["sessionId"], "sub-x");
        // No readable child file: no durable rows to hydrate, so no model
        // or thinking level rides the seeded row.
        assert!(missing.summary.get("model").is_none());
        assert!(missing.summary.get("thinkingLevel").is_none());
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
                Ok(_) => continue,
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(missed)) => {
                    panic!("roster push subscriber lagged by {missed}; drain per delta");
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
            }
        }
        pushes
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
                "delta-token",
                flip_summary(dir.path(), true),
                Vec::new(),
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
                "delta-token",
                flip_summary(dir.path(), false),
                Vec::new(),
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
                "delta-token",
                child_summary,
                Vec::new(),
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
                "delta-token",
                flip_summary(dir.path(), true),
                vec![child_agent_id.clone()],
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
                    "delta-token",
                    summary,
                    Vec::new(),
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
                    "delta-token",
                    summary,
                    Vec::new(),
                )
                .await;
            handler_nanos += start.elapsed().as_nanos();
            for push in drain_roster_pushes(&mut events) {
                pushes += 1;
                payload_bytes += serde_json::to_string(&push)
                    .map(|payload| payload.len())
                    .unwrap_or(0);
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
