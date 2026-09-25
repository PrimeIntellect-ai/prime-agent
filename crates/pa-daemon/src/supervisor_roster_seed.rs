//! The roster's seeding and hydration arms: the boot ledger seed that
//! keeps passivated RLM children in the live roster, the create path's
//! edge-only family seed, and the bounded background hydration that
//! fills their durable display rows (the seed arms of TS
//! `daemon-supervisor.ts`'s roster code; subscribe, worker deltas,
//! pushes, and stop-passivation live in `supervisor_roster.rs`).

use serde_json::Map;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pa_types::daemon::agent_roster::{roster_agent_id_for_summary, AgentRosterEntry};
use serde_json::{json, Value};

use crate::lease::canonical_session_path;
use crate::rlm_ledger::RlmLedgerEdge;
use crate::session_store::read_session_info;
use crate::supervisor::Supervisor;

impl Supervisor {
    /// TS `seedRosterLedger`: seed passivated ledger-descended children
    /// into the live roster. Runs exactly once per boot, in the
    /// background, after adoption settles ([`Self::spawn_roster_boot_seed`])
    /// so the registry holds the seed roots. Roots are the resident
    /// workers' session files; only live edges
    /// descending from a root seed (descent is membership at any step of
    /// the parent walk, so a worker registered mid-tree seeds its
    /// descendants, never its siblings or ancestors); a row already
    /// rostered by agent id or session file is skipped BEFORE its one
    /// hydration read, never re-read. Failures degrade to a log line,
    /// exactly like the TS boot seed: the seed must never fail the
    /// surface that triggered it.
    async fn seed_roster_ledger(self: &Arc<Self>) {
        let roots = self.roster_seed_roots().await;
        if roots.is_empty() {
            return;
        }
        // The seed degrades to a log line on any failure, exactly like
        // the TS boot seed (including the unresolvable-home error the
        // ledger's sessions dir reports).
        let (edges, parent_by_child) = match self.live_edges_and_parents().await {
            Ok(view) => view,
            Err(error) => {
                self.log_line(&format!(
                    "Could not seed the agent roster from the spawn ledger: {error:#}"
                ));
                return;
            }
        };
        // Roots re-snapshot after the ledger awaits: a root that
        // stopped while the ledger was being read must not receive
        // seeded rows (its passivation already settled and never
        // revisits them).
        let roots = self.roster_seed_roots().await;
        // The ledger handle for the per-write liveness revalidation
        // (memoized by the supervisor: the same instance the edge
        // snapshot read, so its replay cache carries the deletions
        // that land during this seed).
        let Ok(ledger) = self.rlm_spawn_ledger_for(None).await else {
            return;
        };
        let mut changed = Vec::new();
        let mut retry = Vec::new();
        for edge in &edges {
            let parent = canonical_session_path(Path::new(&edge.parent));
            if !family_descends_from(&parent_by_child, &parent, &roots) {
                continue;
            }
            let candidate = SeededRosterEntry::edge_only(edge);
            // The collision guards run BEFORE the hydration read (TS's
            // has/hasSessionFile order): a row the roster already holds
            // never re-reads its transcript, whatever the family size -
            // except an unhydrated seeded row, which stays a hydration
            // candidate (its transcript gets one more read while the
            // identity gate still protects the row; TS
            // `hydrateSeededEntry`'s lazy retry, ported onto the arms
            // that re-walk a family).
            if let Some(existing) = self.roster_row_for_candidate(&candidate) {
                if existing.seeded_cwd == Some(true) {
                    retry.push(existing);
                }
                continue;
            }
            // Hydration reads one child at a time, outside the roster
            // lock and on the blocking pool (TS: a large ledger must
            // not fan out into concurrent reads).
            let candidate = candidate.hydrate().await;
            // The hydrate awaited, so both sides of the edge are
            // revalidated immediately before the write: a root that
            // stopped, or a child whose edge a completed delete
            // tombstoned during the read, must not receive rows (the
            // delete's roster removal already settled and never
            // revisits them).
            if !ledger.edge_is_live(&edge.child_id, &edge.child)
                || !family_descends_from(&parent_by_child, &parent, &self.roster_seed_roots().await)
            {
                continue;
            }
            let mut roster = self.roster.lock().unwrap();
            // Re-check under the lock: the Rust seed runs beside live
            // workers (TS seeds before adoption), so a worker row can
            // land during the read - the seed never clobbers it.
            if roster.get(&candidate.agent_id).is_some()
                || roster.has_session_file(&candidate.child_file)
            {
                continue;
            }
            changed.push(roster.write_seeded(candidate.summary, candidate.seeded_cwd));
        }
        self.push_seeded_rows(changed);
        // Unhydrated seeded rows the guards found already rostered get
        // their retry here, after the fresh rows: serial, one read per
        // row, and a write-back only while the row is still the exact
        // one that was snapshotted.
        self.hydrate_seeded_rows(retry).await;
    }

    /// The boot seed task: `seed_roster_ledger` exactly once, in the
    /// background, once adoption has settled (the adoption pass calls
    /// this as its last step and hands the handle back). TS awaits its
    /// seed before adoption at boot; the Rust daemon deliberately
    /// accepts connections before and during adoption, so the seed runs
    /// after the registry is populated instead - and its one
    /// `roster_update` publish carries the seeded rows to every client
    /// that subscribed before it finished.
    pub(crate) fn spawn_roster_boot_seed(self: &Arc<Self>) {
        // The boot seed rides the same ordering barrier as the
        // registration seeds: spawn + register under the lock a
        // subscribe drains (the handle is owned by the table; callers
        // that need completion drain it exactly like the subscribe).
        if let Ok(mut pending) = self.pending_registration_seeds.lock() {
            // Self-pruning (see the registration seed): finished
            // handles drop; a live seed is never prunable.
            pending.retain(|handle| !handle.is_finished());
            let supervisor = Arc::clone(self);
            pending.push(tokio::spawn(async move {
                supervisor.seed_roster_ledger().await;
            }));
        }
    }

    /// The registration seed: a worker that registers after the boot
    /// seed (a supervisor restart's re-registration, a mid-tree
    /// resume, a wakened ledger child) publishes its passive ledger
    /// family in the background. TS reseeds the family when the
    /// worker's first roster snapshot applies
    /// (`applyWorkerRosterSnapshot`, which re-walks the worker's
    /// family edges and writes the rows the delta did not claim), and
    /// this port's workers push only their own summary, so the daemon
    /// walks the family here instead - registration answers on the
    /// client's open path, and the seed never blocks it.
    pub(crate) fn spawn_roster_registration_seed(self: &Arc<Self>, root: &Path) {
        // The spawn and the registration happen under the same lock a
        // subscribe drains: a seed is either in the table a subscribe
        // takes (and is awaited before its snapshot) or it spawns after
        // the take (and its pushes land after the response - either way
        // the push cannot overtake the snapshot answer). The hydration
        // stays DETACHED inside the task: the tracked work is the
        // lightweight seed (the ledger walk and the edge-only row
        // writes), never the serial transcript reads - a subscribe must
        // not block on hydration (that would reintroduce the
        // large-session open latency this PR removes).
        if let Ok(mut pending) = self.pending_registration_seeds.lock() {
            // Self-pruning: a daemon without subscribers must not
            // accumulate one retained handle per registration (an
            // eventual subscribe would drain the whole backlog).
            // Finished handles drop here - a live seed is never
            // prunable, and the barrier keeps every unfinished seed.
            pending.retain(|handle| !handle.is_finished());
            let supervisor = Arc::clone(self);
            let root = root.to_path_buf();
            let handle = tokio::spawn(async move {
                let seeded = supervisor.seed_roster_family_edges(&root).await;
                if !seeded.is_empty() {
                    // The bounded background hydration reads each newly
                    // seeded row's transcript once, detached: TS's
                    // `applyWorkerRosterSnapshot` hydrates per edge, but
                    // the ordering barrier only needs the rows
                    // themselves.
                    drop(supervisor.spawn_seeded_hydration(seeded));
                }
            });
            pending.push(handle);
        }
    }

    /// The default ledger's live edges and their canonical child->parent
    /// map, shared by every seed and passivation walk.
    pub(crate) async fn live_edges_and_parents(
        self: &Arc<Self>,
    ) -> anyhow::Result<(Vec<RlmLedgerEdge>, HashMap<PathBuf, PathBuf>)> {
        let ledger = self.rlm_spawn_ledger_for(None).await?;
        let edges = ledger.live_edges()?;
        let parent_by_child = edges
            .iter()
            .map(|edge| {
                (
                    canonical_session_path(Path::new(&edge.child)),
                    canonical_session_path(Path::new(&edge.parent)),
                )
            })
            .collect();
        Ok((edges, parent_by_child))
    }

    /// The seeded candidate's roster row when already present (TS
    /// `roster().has` + `hasSessionFile`): by agent id or session file.
    fn roster_row_for_candidate(&self, candidate: &SeededRosterEntry) -> Option<AgentRosterEntry> {
        let roster = self.roster.lock().unwrap();
        roster
            .get(&candidate.agent_id)
            .or_else(|| roster.by_session_file(&candidate.child_file))
            .cloned()
    }

    /// The create path's family seed: a newly resident root (a resumed
    /// parent, a supervisor restart, a spawned child) renders its passive
    /// descendants immediately from the ledger edges alone - but only
    /// while the root is still a resident (the registration seed runs
    /// this walk in the background, and passivation never revisits
    /// seeded rows), so the root's residency is revalidated after the
    /// walk's awaits. TS
    /// `rosterEntryForSpawnLedgerEdge` rows with the dirname cwd and the
    /// `seededCwd` marker, zero transcript reads on the event path - and
    /// returns the written rows for the bounded background hydration,
    /// plus any unhydrated seeded rows the walk re-found (their
    /// transcripts get one more read through the same hydration; the
    /// identity gate keeps a replaced row safe). The duplicate guards
    /// match the boot seed's (by agent id and session file), so a row
    /// only ever seeds once.
    pub(crate) async fn seed_roster_family_edges(
        self: &Arc<Self>,
        root: &Path,
    ) -> Vec<AgentRosterEntry> {
        let roots: HashSet<PathBuf> = HashSet::from([canonical_session_path(root)]);
        // The family seed degrades to nothing on a ledger failure, like
        // the boot seed degrades to its log line.
        let (edges, parent_by_child) = match self.live_edges_and_parents().await {
            Ok(view) => view,
            Err(error) => {
                self.log_line(&format!(
                    "Could not seed the agent roster from the spawn ledger: {error:#}"
                ));
                return Vec::new();
            }
        };
        // The ledger handle for the per-write liveness revalidation
        // (memoized by the supervisor: the same instance the edge
        // snapshot read).
        let Ok(ledger) = self.rlm_spawn_ledger_for(None).await else {
            return Vec::new();
        };
        // The root's residency is revalidated after the awaits: the
        // registration seed runs this walk in the background, so a stop
        // or give-up can settle while the ledger was being read, and
        // passivation only settles rows the stopping worker still owned
        // (seeded rows are unowned) - a dead root must not receive ghost
        // family rows. The walk below holds no further await, so this
        // one check covers every write of the pass (exactly like the
        // boot seed's post-await revalidation).
        if !self
            .roster_seed_roots()
            .await
            .contains(&canonical_session_path(root))
        {
            return Vec::new();
        }
        // The family walk outside the roster lock: the descent check is
        // an in-memory parent walk and the liveness check is a
        // stat-backed ledger read, and neither may block every roster
        // operation behind a large family's registration (the lock is
        // taken only for the duplicate checks and writes).
        let candidates: Vec<&RlmLedgerEdge> = edges
            .iter()
            .filter(|edge| {
                let parent = canonical_session_path(Path::new(&edge.parent));
                family_descends_from(&parent_by_child, &parent, &roots)
                    // The edge snapshot predates this pass by the
                    // ledger-read await: a child deleted in that
                    // window never seeds (its completed delete must
                    // not be followed by a fresh row).
                    && ledger.edge_is_live(&edge.child_id, &edge.child)
            })
            .collect();
        let mut changed = Vec::new();
        let mut retry = Vec::new();
        {
            let mut roster = self.roster.lock().unwrap();
            for edge in candidates {
                let candidate = SeededRosterEntry::edge_only(edge);
                // Present rows never republish (TS has/hasSessionFile);
                // an unhydrated seeded row stays a hydration candidate
                // for the returned set - the walk that re-finds it also
                // offers its transcript one more read.
                if let Some(existing) = roster
                    .get(&candidate.agent_id)
                    .or_else(|| roster.by_session_file(&candidate.child_file))
                {
                    if existing.seeded_cwd == Some(true) {
                        retry.push(existing.clone());
                    }
                    continue;
                }
                changed.push(roster.write_seeded(candidate.summary, candidate.seeded_cwd));
            }
        }
        self.push_seeded_rows(changed.clone());
        // The returned hydration set: fresh rows first, then the
        // unhydrated seeded rows found already rostered - the caller's
        // bounded background hydration reads each once more.
        changed.extend(retry);
        changed
    }

    /// The bounded background hydration over rows the event path seeded
    /// edge-only: serial, one read per row, and a write-back only while
    /// the roster still holds the very row that was snapshotted before
    /// the read (TS `hydrateSeededEntry`'s identity gate - a newer
    /// worker write always wins). An unreadable child file keeps the
    /// row's `seededCwd` marker for a later retry.
    pub(crate) fn spawn_seeded_hydration(
        self: &Arc<Self>,
        seeded: Vec<AgentRosterEntry>,
    ) -> tokio::task::JoinHandle<()> {
        let supervisor = Arc::clone(self);
        tokio::spawn(async move {
            supervisor.hydrate_seeded_rows(seeded).await;
        })
    }

    /// One hydration pass over edge-only seeded rows. Each row reads its
    /// child transcript exactly once (only rows still carrying the
    /// `seededCwd` marker, only while still identical to the row the
    /// seed wrote), and the hydrated rows publish as one update.
    ///
    /// The gate is whole-entry equality - the Rust port of TS's
    /// `current !== entry` object-identity check (`hydrateSeededEntry`).
    /// Rust stores entries as values, so identity is content: a newer
    /// worker write always fails the comparison (its `workerId` gains a
    /// value, its `seededCwd` marker clears, or its summary changes),
    /// and a delete plus re-add of the byte-identical seeded row is the
    /// same still-unhydrated row - hydrating it is this pass's own
    /// intended follow-up, not a clobber.
    async fn hydrate_seeded_rows(self: &Arc<Self>, seeded: Vec<AgentRosterEntry>) {
        let mut changed = Vec::new();
        for entry in seeded {
            let Some(file) = entry
                .summary
                .get("sessionFile")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            // Still the same unhydrated row we wrote: a worker delta or
            // registration that replaced it already wins without the
            // read.
            if !self.seeded_row_unchanged(&entry) {
                continue;
            }
            let mut summary = entry.summary.clone();
            // Hydration reads one child at a time, outside the roster
            // lock; an unreadable file keeps the marker row as-is.
            if !hydrate_summary_display(&mut summary, PathBuf::from(file)).await {
                continue;
            }
            {
                let mut roster = self.roster.lock().unwrap();
                // The identity gate: the write-back lands only while the
                // roster still holds the pre-read row (TS compares the
                // entry object; Rust compares the snapshot).
                if roster.get(&entry.agent_id) != Some(&entry) {
                    continue;
                }
                changed.push(roster.write_seeded(summary, false));
            }
        }
        self.push_seeded_rows(changed);
    }

    /// Publish seeded rows only while the roster still holds the exact
    /// row that was written (TS applies `roster_update` entries
    /// idempotently by agent id, so a stale snapshot pushed after a
    /// newer worker write would regress a subscriber's view to the
    /// seeded row): a batch that accumulated across its hydration
    /// awaits publishes only the rows no live worker replaced.
    fn push_seeded_rows(&self, changed: Vec<AgentRosterEntry>) {
        let changed = {
            let roster = self.roster.lock().unwrap();
            changed
                .into_iter()
                .filter(|entry| roster.get(&entry.agent_id) == Some(entry))
                .collect::<Vec<_>>()
        };
        self.push_roster_update(changed, Vec::new());
    }

    /// Whether the roster still holds exactly the given seeded row (the
    /// identity gate's pre-read half).
    fn seeded_row_unchanged(&self, entry: &AgentRosterEntry) -> bool {
        let roster = self.roster.lock().unwrap();
        roster.get(&entry.agent_id) == Some(entry)
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
    /// TS `rosterEntryForSpawnLedgerEdge`: the row comes from the edge
    /// alone - no transcript read. The cwd is the child file's dirname
    /// and `seededCwd` rides the row for its later lazy hydration.
    fn edge_only(edge: &RlmLedgerEdge) -> Self {
        let child = Path::new(&edge.child);
        let persisted_session_id = child
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let dirname = child
            .parent()
            .map(|dir| dir.to_string_lossy().to_string())
            .unwrap_or_default();
        let summary = json!({
            "id": persisted_session_id,
            "lifecycle": "live",
            "activity": "idle",
            "isSessionActive": false,
            "runtimeKind": "subagent",
            "rlmDepth": edge.depth,
            "sessionId": persisted_session_id,
            "sessionFile": edge.child,
            "sessionName": edge.name,
            "cwd": dirname,
            "isStreaming": false,
            "isCompacting": false,
            "attachedClients": 0,
            "messageCount": 0,
            "parentSessionPath": edge.parent,
            "rlmChildId": edge.child_id,
        });
        Self {
            agent_id: roster_agent_id_for_summary(&summary),
            child_file: canonical_session_path(child).to_string_lossy().to_string(),
            summary,
            seeded_cwd: true,
        }
    }

    /// The one lazy hydration read (TS `hydratedSeedEntry`): the child
    /// file's display fields only - topology stays the edge's. An
    /// unreadable file keeps the dirname fallback and the `seededCwd`
    /// marker until a live worker's row replaces it.
    async fn hydrate(mut self) -> Self {
        let file = self
            .summary
            .get("sessionFile")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default();
        if hydrate_summary_display(&mut self.summary, PathBuf::from(file)).await {
            self.seeded_cwd = false;
        }
        self
    }
}

/// The one lazy display read behind both hydration paths (TS
/// `hydratedSeedEntry`): the child file's durable rows - the cwd, the
/// persisted model selector, and the persisted thinking level, the same
/// rows a live worker's summary reports (so a passivated subagent keeps
/// rendering "model:level" in the agents view) - and nothing else.
/// Returns whether the file read. The transcript parse runs on the
/// blocking pool so a large child JSONL never parks a Tokio worker.
async fn hydrate_summary_display(summary: &mut Value, file: PathBuf) -> bool {
    let info = tokio::task::spawn_blocking(move || read_session_info(&file))
        .await
        .ok()
        .flatten();
    let Some(info) = info else {
        return false;
    };
    if let Some(object) = summary.as_object_mut() {
        object.insert("cwd".to_string(), json!(info.cwd));
        if let Some((provider, model_id)) = &info.model {
            object.insert(
                "model".to_string(),
                json!({ "provider": provider, "modelId": model_id }),
            );
        }
        if let Some(level) = &info.thinking_level {
            object.insert("thinkingLevel".to_string(), json!(level));
        }
    }
    true
}

/// TS `rosterFamilyDescendsFrom`: descent is membership at any step of
/// the parent walk (workers can register mid-tree, e.g. a resumed
/// subagent transcript), never a comparison against the ultimate root
/// alone. The cycle guard is the visited set.
pub(crate) fn family_descends_from(
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
pub(crate) mod tests {
    use super::*;
    use crate::registry::ResidentWorker;
    use crate::rlm_ledger::RlmLedgerEdge;
    use crate::supervisor::ClientRouting;
    use pa_types::daemon::agent_roster::AgentRosterStatus;

    fn edge(child_id: &str, parent: &str, child: &str, depth: u32, name: &str) -> RlmLedgerEdge {
        RlmLedgerEdge {
            child_id: child_id.to_string(),
            parent: parent.to_string(),
            child: child.to_string(),
            depth,
            name: name.to_string(),
            deleted: None,
            deleted_usage: None,
        }
    }

    fn roots(paths: &[&str]) -> HashSet<PathBuf> {
        paths.iter().map(|path| PathBuf::from(*path)).collect()
    }

    /// Await every in-flight seed task the way `handle_roster_subscribe`
    /// does (the tests' completion barrier).
    pub(crate) async fn drain_pending_seeds_for_tests(supervisor: &Supervisor) {
        let pending = std::mem::take(&mut *supervisor.pending_registration_seeds.lock().unwrap());
        for handle in pending {
            handle.await.expect("seed task");
        }
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

    #[tokio::test]
    async fn seeded_rows_shape_matches_the_ts_entry() {
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
        let candidate = SeededRosterEntry::edge_only(&edge(
            "sub-9",
            "/live/root.jsonl",
            &child.to_string_lossy(),
            1,
            "worker-a",
        ))
        .hydrate()
        .await;
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
        let missing = SeededRosterEntry::edge_only(&edge(
            "sub-x",
            "/live/root.jsonl",
            "/artifacts/gone/sub-x.jsonl",
            2,
            "w",
        ))
        .hydrate()
        .await;
        assert!(missing.seeded_cwd);
        assert_eq!(missing.summary["cwd"], "/artifacts/gone");
        assert_eq!(missing.summary["sessionId"], "sub-x");
        // No readable child file: no durable rows to hydrate, so no model
        // or thinking level rides the seeded row.
        assert!(missing.summary.get("model").is_none());
        assert!(missing.summary.get("thinkingLevel").is_none());
    }

    // --- Phase 1 fixtures: a supervisor home, a resident root worker, a
    // ledger family, and the push drain ---

    /// A temp supervisor home: the agent dir, the default sessions dir
    /// (the ledger's dir), a root transcript, and a child transcript
    /// carrying the durable display rows the hydration reads.
    pub(crate) async fn roster_fixture() -> (PathBuf, Arc<Supervisor>, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("pa-roster-{}", uuid::Uuid::new_v4()));
        let agent_dir = dir.join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let root_file = sessions_dir.join("root-1.jsonl");
        let child_file = sessions_dir.join("sub-9.jsonl");
        write_display_file(&root_file, "/the/root/cwd");
        write_display_file(&child_file, "/the/real/cwd");
        let supervisor = Arc::new(
            Supervisor::new(crate::supervisor::SupervisorOptions {
                socket_path: dir.join("daemon.sock"),
                agent_dir,
            })
            .expect("supervisor"),
        );
        (dir, supervisor, root_file, child_file)
    }

    /// A session transcript with the durable display rows a live worker's
    /// summary reports (the same shape `read_session_info` parses in
    /// `seeded_rows_shape_matches_the_ts_entry`).
    pub(crate) fn write_display_file(path: &Path, cwd: &str) {
        std::fs::write(
            path,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"persisted-id\",\"timestamp\":\"t\",\"cwd\":\"{cwd}\"}}\n{{\"type\":\"model_change\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":\"t\",\"provider\":\"p\",\"modelId\":\"m\"}}\n{{\"type\":\"thinking_level_change\",\"id\":\"t1\",\"parentId\":\"m1\",\"timestamp\":\"t\",\"thinkingLevel\":\"high\"}}\n"
            ),
        )
        .unwrap();
    }

    /// The ledger edge parent -> child over the supervisor's own sessions
    /// dir (`rlm_spawn_ledger_for` reads exactly this ledger).
    pub(crate) fn append_family_edge(
        agent_dir: &Path,
        sessions_dir: &Path,
        child_id: &str,
        parent: &Path,
        child: &Path,
    ) {
        let ledger = crate::rlm_ledger::RlmSpawnLedger::new(agent_dir, sessions_dir, |_| {});
        ledger
            .append_spawn(crate::rlm_ledger::RlmSpawnInput {
                child_id: child_id.to_string(),
                parent: parent.to_string_lossy().to_string(),
                child: child.to_string_lossy().to_string(),
                depth: 1,
                name: "lane".to_string(),
            })
            .expect("append spawn");
    }

    /// One resident root worker carrying the given session file (the seed
    /// roots' source). Registration alone - the roster row is whatever
    /// the test writes.
    pub(crate) async fn register_root_worker(
        supervisor: &Supervisor,
        worker_id: &str,
        session_file: &Path,
    ) {
        let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
            version: 1,
            worker_id: worker_id.to_string(),
            pid: 4242,
            process_start_id: None,
            socket_path: "/tmp/none.sock".to_string(),
            recovery_journal_path: "/tmp/none.jsonl".to_string(),
            orphan_process_journal_path: None,
            supervisor_socket_path: "/tmp/none.sock".to_string(),
            authentication_token: format!("{worker_id}-token"),
            worker_instance_id: None,
            root_active_session_id: worker_id.to_string(),
            owner_client_id: None,
            root_session_id: None,
            session_file: Some(session_file.to_string_lossy().to_string()),
            session_dir: Some(
                session_file
                    .parent()
                    .map(|dir| dir.to_string_lossy().to_string())
                    .unwrap_or_default(),
            ),
            telemetry_disabled: Some(true),
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
            lifecycle: pa_types::daemon::DaemonWorkerLifecycle::Ready,
            create_command: pa_types::daemon::DurableDaemonCreateCommand {
                session_path: None,
                no_session: None,
                rest: Map::default(),
            },
            consecutive_failures: 0,
            stop_requested_at: None,
            archive_on_stop: None,
            last_failure_at: None,
            last_error: None,
            rest: Map::default(),
        };
        supervisor
            .registry
            .insert(ResidentWorker::new(
                worker_id.to_string(),
                descriptor,
                session_file.with_extension("descriptor.json"),
            ))
            .await;
    }

    /// A live worker's roster summary for the child (the shape a worker
    /// delta pushes): the durable display rows plus the live-runtime
    /// fields passivation must strip.
    pub(crate) fn live_child_summary(root_file: &Path, child_file: &Path) -> Value {
        json!({
            "id": "persisted-id",
            "sessionId": "persisted-id",
            "activeSessionId": "a-child",
            "activity": "working",
            "isSessionActive": true,
            "isStreaming": true,
            "isCompacting": false,
            "attachedClients": 1,
            "runtimeKind": "subagent",
            "rlmChildId": "sub-9",
            "rlmDepth": 1,
            "sessionFile": child_file.to_string_lossy(),
            "sessionName": "lane",
            "cwd": "/the/live/cwd",
            "model": { "provider": "live", "modelId": "lm" },
            "thinkingLevel": "low",
            "parentSessionPath": root_file.to_string_lossy(),
            "workerState": "ready",
            "workerPid": 4242,
            "messageCount": 7,
        })
    }

    /// Drain the pushed roster frames (the events a subscribed client
    /// pump forwards); anything else on the channel is not a roster push.
    pub(crate) fn drain_roster_pushes(
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
                    panic!("roster push subscriber lagged by {missed}; drain per push");
                }
            }
        }
        pushes
    }

    /// The one seeded child row (by ledger child id).
    pub(crate) fn roster_row_for_child(
        supervisor: &Supervisor,
        child_id: &str,
    ) -> AgentRosterEntry {
        supervisor
            .roster
            .lock()
            .unwrap()
            .entries()
            .into_iter()
            .find(|entry| entry.summary.get("rlmChildId").and_then(Value::as_str) == Some(child_id))
            .unwrap_or_else(|| panic!("no roster row for child {child_id}"))
    }

    /// The boot seed hydrates every unseeded descendant exactly once and
    /// publishes one `roster_update` for early subscribers; rows the
    /// roster already holds are skipped before any read.
    #[tokio::test]
    async fn boot_seed_hydrates_once_and_publishes_one_update() {
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

        supervisor.spawn_roster_boot_seed();
        drain_pending_seeds_for_tests(&supervisor).await;
        let pushes = drain_roster_pushes(&mut events);
        assert_eq!(pushes.len(), 1, "one publish: {pushes:?}");
        let row = roster_row_for_child(&supervisor, "sub-9");
        assert_eq!(row.seeded_cwd, None, "the readable file hydrated the cwd");
        assert_eq!(row.summary["cwd"], "/the/real/cwd");
        assert_eq!(
            row.summary["model"],
            json!({ "provider": "p", "modelId": "m" })
        );
        assert_eq!(row.summary["thinkingLevel"], json!("high"));
        assert_eq!(row.worker_id, None);
        assert_eq!(row.status, AgentRosterStatus::Inactive);

        // The seed is once-per-boot: a second run never re-reads the
        // transcripts (the present rows skip first) and never pushes.
        supervisor.seed_roster_ledger().await;
        let pushes = drain_roster_pushes(&mut events);
        assert!(pushes.is_empty(), "present rows skip: {pushes:?}");
        let row_again = roster_row_for_child(&supervisor, "sub-9");
        assert_eq!(
            row_again.summary, row.summary,
            "no rewrite of a present row"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A row the roster already holds never hydrates over it: the boot
    /// seed skips by agent id and session file before any transcript
    /// read, so a live worker's row survives the boot seed intact.
    #[tokio::test]
    async fn boot_seed_skips_rows_the_roster_already_holds() {
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
        supervisor
            .write_roster_summary(&live_child_summary(&root_file, &child_file), Some("w-live"));
        let _ = drain_roster_pushes(&mut events);

        supervisor.spawn_roster_boot_seed();
        drain_pending_seeds_for_tests(&supervisor).await;
        let pushes = drain_roster_pushes(&mut events);
        assert!(pushes.is_empty(), "a present row never reseeds: {pushes:?}");
        let row = roster_row_for_child(&supervisor, "sub-9");
        assert_eq!(row.worker_id.as_deref(), Some("w-live"));
        assert_eq!(
            row.summary["cwd"], "/the/live/cwd",
            "the worker row is untouched"
        );
        assert_eq!(row.summary["model"]["provider"], "live");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The create path's family seed renders the passive family
    /// immediately from the ledger edges - no transcript read on the
    /// event path (the readable child file would have hydrated the cwd
    /// otherwise) - and the bounded background hydration fills the
    /// durable display rows afterwards.
    #[tokio::test]
    async fn family_seed_renders_edges_then_hydrates_in_the_background() {
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

        let seeded = supervisor.seed_roster_family_edges(&root_file).await;
        assert_eq!(seeded.len(), 1);
        let immediate = &seeded[0];
        assert_eq!(
            immediate.seeded_cwd,
            Some(true),
            "the event path never read the file"
        );
        assert_eq!(
            immediate.summary["cwd"],
            child_file.parent().unwrap().to_string_lossy().to_string(),
            "the edge-only row carries the dirname fallback"
        );
        assert!(immediate.summary.get("model").is_none());
        assert!(immediate.summary.get("thinkingLevel").is_none());
        let pushes = drain_roster_pushes(&mut events);
        assert_eq!(pushes.len(), 1, "the immediate rows publish: {pushes:?}");
        assert_eq!(pushes[0]["changed"][0]["seededCwd"], true);

        supervisor
            .spawn_seeded_hydration(seeded)
            .await
            .expect("seeded hydration task");
        let pushes = drain_roster_pushes(&mut events);
        assert_eq!(pushes.len(), 1, "the hydrated rows publish: {pushes:?}");
        let row = roster_row_for_child(&supervisor, "sub-9");
        assert_eq!(row.seeded_cwd, None);
        assert_eq!(row.summary["cwd"], "/the/real/cwd");
        assert_eq!(
            row.summary["model"],
            json!({ "provider": "p", "modelId": "m" })
        );
        assert_eq!(row.summary["thinkingLevel"], json!("high"));
        // The next family pass never re-reads: the present row skips first.
        let reseeded = supervisor.seed_roster_family_edges(&root_file).await;
        assert!(reseeded.is_empty());
        assert!(drain_roster_pushes(&mut events).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The hydration identity gate: a newer worker write always wins - a
    /// stale snapshot's hydration never overwrites the live row.
    #[tokio::test]
    async fn hydration_loses_to_a_newer_worker_write() {
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
        let seeded = supervisor.seed_roster_family_edges(&root_file).await;
        let _ = drain_roster_pushes(&mut events);

        // A worker write lands between the seed and the hydration.
        supervisor
            .write_roster_summary(&live_child_summary(&root_file, &child_file), Some("w-live"));
        let _ = drain_roster_pushes(&mut events);

        // The stale snapshot's hydration pass loses the identity gate.
        supervisor.hydrate_seeded_rows(seeded).await;
        assert!(
            drain_roster_pushes(&mut events).is_empty(),
            "a clobbered row never publishes"
        );
        let row = roster_row_for_child(&supervisor, "sub-9");
        assert_eq!(row.worker_id.as_deref(), Some("w-live"));
        assert_eq!(row.summary["model"]["provider"], "live");
        assert_eq!(row.summary["cwd"], "/the/live/cwd");
        assert_eq!(row.status, AgentRosterStatus::Running);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The seeded publish filter: rows accumulate across a seed's
    /// hydration awaits, so a row a live worker replaced while the
    /// batch ran never publishes (subscribers apply updates
    /// idempotently by agent id - a stale snapshot would regress their
    /// view to the seeded row).
    #[tokio::test]
    async fn stale_seeded_snapshots_never_publish() {
        let (dir, supervisor, root_file, child_file) = roster_fixture().await;
        let agent_dir = dir.join("agent");
        append_family_edge(
            &agent_dir,
            &agent_dir.join("sessions"),
            "sub-9",
            &root_file,
            &child_file,
        );
        // A stale seeded snapshot: the row the family seed wrote.
        let stale = {
            let mut roster = supervisor.roster.lock().unwrap();
            let candidate = crate::supervisor_roster_seed::SeededRosterEntry::edge_only(
                &crate::rlm_ledger::RlmLedgerEdge {
                    child_id: "sub-9".to_string(),
                    parent: root_file.to_string_lossy().to_string(),
                    child: child_file.to_string_lossy().to_string(),
                    depth: 1,
                    name: "w9".to_string(),
                    deleted: None,
                    deleted_usage: None,
                },
            );
            roster.write_seeded(candidate.summary, candidate.seeded_cwd)
        };
        // A newer worker write replaces it and publishes the live row.
        let mut events = supervisor.events.subscribe();
        supervisor
            .write_roster_summary(&live_child_summary(&root_file, &child_file), Some("w-live"));
        assert_eq!(drain_roster_pushes(&mut events).len(), 1);

        // The stale snapshot's publish is dropped by the identity
        // filter: the roster no longer holds that row.
        supervisor.push_seeded_rows(vec![stale]);
        assert!(
            drain_roster_pushes(&mut events).is_empty(),
            "a stale seeded row never publishes"
        );
        // A snapshot the roster still holds verbatim publishes.
        let current = roster_row_for_child(&supervisor, "sub-9");
        supervisor.push_seeded_rows(vec![current]);
        assert_eq!(drain_roster_pushes(&mut events).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An unhydrated seeded row is a hydration candidate on every walk
    /// that re-finds it: a transcript that is unreadable at seed time
    /// (corrupt, but present - the liveness walk drops deleted files)
    /// keeps the `seededCwd` marker, and the next family walk (a
    /// registration seed, a create) offers the file one more read
    /// without republishing the row. A replaced row never loses the
    /// identity gate.
    #[tokio::test]
    async fn an_unhydrated_seeded_row_retries_on_the_next_family_walk() {
        let (dir, supervisor, root_file, child_file) = roster_fixture().await;
        let agent_dir = dir.join("agent");
        append_family_edge(
            &agent_dir,
            &agent_dir.join("sessions"),
            "sub-9",
            &root_file,
            &child_file,
        );
        register_root_worker(&supervisor, "w-root", &root_file).await;
        let mut events = supervisor.events.subscribe();
        // The child transcript is corrupt (present, but no readable
        // session info - a deleted transcript would drop the edge from
        // the liveness walk): the family seed writes the edge-only row
        // and the hydration keeps the marker.
        std::fs::write(&child_file, "not a session transcript\n").expect("corrupt child");
        let seeded = supervisor.seed_roster_family_edges(&root_file).await;
        assert_eq!(seeded.len(), 1);
        supervisor
            .spawn_seeded_hydration(seeded)
            .await
            .expect("hydration task");
        let row = roster_row_for_child(&supervisor, "sub-9");
        assert_eq!(
            row.seeded_cwd,
            Some(true),
            "the unreadable file keeps the marker"
        );
        let _ = drain_roster_pushes(&mut events);

        // The transcript becomes readable: the next walk re-finds the
        // unhydrated row and hands it to the hydration without
        // republishing it.
        write_display_file(&child_file, "/the/real/cwd");
        let retry = supervisor.seed_roster_family_edges(&root_file).await;
        assert_eq!(retry.len(), 1, "the marked row is the candidate");
        assert!(
            drain_roster_pushes(&mut events).is_empty(),
            "a retry never republishes"
        );
        supervisor
            .spawn_seeded_hydration(retry)
            .await
            .expect("hydration task");
        let row = roster_row_for_child(&supervisor, "sub-9");
        assert_eq!(row.seeded_cwd, None, "the retry hydrated the row");
        assert_eq!(row.summary["cwd"], "/the/real/cwd");
        assert_eq!(
            row.summary["model"],
            json!({ "provider": "p", "modelId": "m" })
        );

        // The now-hydrated row is not a candidate again.
        let retry = supervisor.seed_roster_family_edges(&root_file).await;
        assert!(retry.is_empty(), "a hydrated row never re-reads");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The registration seed: a worker that registers after the boot
    /// seed publishes its passive ledger family in the background - the
    /// row lands edge-only first, then the joined hydration fills its
    /// durable display fields.
    #[tokio::test]
    async fn the_registration_seed_publishes_a_late_worker_family() {
        let (dir, supervisor, root_file, child_file) = roster_fixture().await;
        register_root_worker(&supervisor, "w-late", &root_file).await;
        let agent_dir = dir.join("agent");
        append_family_edge(
            &agent_dir,
            &agent_dir.join("sessions"),
            "sub-9",
            &root_file,
            &child_file,
        );
        let mut events = supervisor.events.subscribe();

        supervisor.spawn_roster_registration_seed(&root_file);
        // The subscribe drain: awaiting the in-flight seed tasks exactly
        // like handle_roster_subscribe does, so the pushes have landed
        // before the assertions read them.
        drain_pending_seeds_for_tests(&supervisor).await;
        // The subscribe drain lands the SEED publish; the hydration is
        // detached inside the task, so its publish lands shortly after -
        // a bounded retry-drain waits for it (the subscribe path itself
        // never waits on hydration).
        let mut pushes = drain_roster_pushes(&mut events);
        for _ in 0..100 {
            if pushes.len() >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            pushes.extend(drain_roster_pushes(&mut events));
        }
        assert_eq!(
            pushes.len(),
            2,
            "seed publish + hydration publish: {pushes:?}"
        );
        let row = roster_row_for_child(&supervisor, "sub-9");
        assert_eq!(
            row.seeded_cwd, None,
            "the background hydration filled the row"
        );
        assert_eq!(row.summary["cwd"], "/the/real/cwd");
        assert_eq!(
            row.summary["model"],
            json!({ "provider": "p", "modelId": "m" })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
