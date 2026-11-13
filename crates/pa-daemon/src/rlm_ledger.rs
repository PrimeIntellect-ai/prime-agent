//! The daemon-owned RLM spawn ledger: one append-only JSONL file per sessions
//! dir recording spawn, rename, and delete admissions. Family topology
//! (parent/child edges, depths, names) is read back from this file instead of
//! being re-derived from session files, so historical and non-resident
//! children stay roster-visible after passivation. Mirrors the record
//! grammar, bounds, and legacy-registry seeding of the TS
//! `modes/daemon/rlm-ledger.ts`; unlike TS, replay logs and skips a
//! malformed line instead of failing the whole read.
//!
//! Writers: the supervisor appends at admission moments (spawn at child
//! create, rename at subagent rename, delete at subagent delete). Readers:
//! every roster surface that must show non-resident children (`list --all`,
//! the saved-session catalog). Appends are single small `O_APPEND` writes
//! whose atomicity we rely on for cross-process interleaving; reads re-read
//! the whole file behind a stat guard, so staleness is bounded to in-flight
//! appends.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::lease::canonical_session_path;
use crate::util::now_iso;
pub use pa_core::session_engine::rlm_host::RlmFactoryTag;

mod replay;

use replay::{
    canonicalize_dir, edge_key, file_identity, is_file, parse_ledger_line, sole_edge_by_child_id,
    LedgerRecord, LivePathResolver, ReplaySnapshot, ReplayState,
};

mod legacy_registry;

pub(crate) use legacy_registry::read_legacy_registry;
#[cfg(test)]
use legacy_registry::{legacy_registry_path, LEGACY_REGISTRY_HEADER_READ_MAX_BYTES};
pub use legacy_registry::{
    read_rlm_subagent_display, write_rlm_subagent_display, LegacyRlmSubagentEntry,
    RlmSubagentDisplayEntry,
};

/// Ledger files live under `<agent-dir>/rlm-ledger/`, one per sessions dir.
pub const RLM_LEDGER_DIR: &str = "rlm-ledger";
/// Bounded read: a ledger beyond these limits fails closed loudly.
pub const RLM_LEDGER_MAX_BYTES: u64 = 32 * 1024 * 1024;
pub const RLM_LEDGER_MAX_RECORDS: usize = 100_000;

/// Why a child's edge was tombstoned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RlmLedgerDeleteReason {
    User,
    ParentTeardown,
    Revoked,
    Gc,
}

impl RlmLedgerDeleteReason {
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Self::User),
            "parent-teardown" => Some(Self::ParentTeardown),
            "revoked" => Some(Self::Revoked),
            "gc" => Some(Self::Gc),
            _ => None,
        }
    }

    fn wire_name(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::ParentTeardown => "parent-teardown",
            Self::Revoked => "revoked",
            Self::Gc => "gc",
        }
    }
}

/// One live family edge after replay (last writer wins per childId+child).
/// Edges are replay-ordered: the append order of the ledger file.
#[derive(Debug, Clone, PartialEq)]
pub struct RlmLedgerEdge {
    pub child_id: String,
    pub parent: String,
    pub child: String,
    pub depth: u32,
    pub name: String,
    pub deleted: Option<RlmLedgerDeleteReason>,
    /// The own usage older builds captured on the tombstone. The usage
    /// ledger imports it once for a deleted child whose transcript is gone;
    /// this build writes none.
    pub deleted_usage: Option<crate::session_usage::SessionUsageSummary>,
    /// The factory run that spawned the child (spawn records written
    /// before the tag existed read `None`); it survives the tombstone.
    pub factory: Option<RlmFactoryTag>,
}

/// A session's durable id: its session file's name stem. Spawn records,
/// usage-ledger shards, and saved rows all key a session by it.
#[must_use]
pub(crate) fn durable_session_id(session_file: &Path) -> Option<String> {
    Some(session_file.file_stem()?.to_string_lossy().into_owned())
}

/// Every spawn the ledger recorded, tombstones included, keyed by durable
/// session id at the recorded paths: a deleted or moved transcript keeps its
/// edge. The usage ledger folds family totals over it.
#[derive(Debug, Default)]
pub(crate) struct SpawnTree {
    children: HashMap<String, Vec<String>>,
    nodes: HashMap<String, SpawnNode>,
}

/// One spawned session: its parent (the first spawn record wins) and its
/// recorded transcript path.
#[derive(Debug)]
pub(crate) struct SpawnNode {
    pub(crate) parent: String,
    pub(crate) file: PathBuf,
    /// The own usage an older build captured on the child's tombstone.
    pub(crate) deleted_usage: Option<crate::session_usage::SessionUsageSummary>,
}

impl SpawnTree {
    fn of(edges: &[RlmLedgerEdge]) -> Self {
        let mut tree = Self::default();
        for edge in edges {
            let (Some(child), Some(parent)) = (
                durable_session_id(Path::new(&edge.child)),
                durable_session_id(Path::new(&edge.parent)),
            ) else {
                continue;
            };
            if child == parent {
                continue;
            }
            match tree.nodes.entry(child) {
                std::collections::hash_map::Entry::Occupied(mut node) => {
                    if node.get().deleted_usage.is_none() {
                        node.get_mut().deleted_usage.clone_from(&edge.deleted_usage);
                    }
                }
                std::collections::hash_map::Entry::Vacant(slot) => {
                    tree.children
                        .entry(parent.clone())
                        .or_default()
                        .push(slot.key().clone());
                    slot.insert(SpawnNode {
                        parent,
                        file: PathBuf::from(&edge.child),
                        deleted_usage: edge.deleted_usage.clone(),
                    });
                }
            }
        }
        tree
    }

    /// The direct children ever spawned by one session.
    pub(crate) fn children(&self, session_id: &str) -> &[String] {
        self.children.get(session_id).map_or(&[], Vec::as_slice)
    }

    pub(crate) fn node(&self, session_id: &str) -> Option<&SpawnNode> {
        self.nodes.get(session_id)
    }
}

/// Inputs for `append_spawn` (validated like a record the reader would refuse to read back).
#[derive(Debug, Clone)]
pub struct RlmSpawnInput {
    pub child_id: String,
    pub parent: String,
    pub child: String,
    pub depth: u32,
    pub name: String,
    pub factory: Option<RlmFactoryTag>,
}

/// The per-sessions-dir spawn ledger. Reads are guarded by a file stat snapshot; a missing ledger
/// is seeded from the legacy registries (seed failure degrades to empty, never fail-closed).
pub struct RlmSpawnLedger {
    path: PathBuf,
    agent_dir: PathBuf,
    canonical_sessions_dir: PathBuf,
    seed_attempted: AtomicBool,
    cache: Mutex<Option<ReplaySnapshot>>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

/// Ledger path for one sessions dir: a 16-hex sha256 of the canonical
/// sessions dir under `<agent-dir>/rlm-ledger/`.
#[must_use]
pub fn rlm_ledger_path(agent_dir: &Path, sessions_dir: &Path) -> PathBuf {
    let canonical = canonicalize_dir(sessions_dir);
    let hash = crate::paths::hash_key(&canonical.to_string_lossy(), 16);
    agent_dir.join(RLM_LEDGER_DIR).join(format!("{hash}.jsonl"))
}

/// The liveness pass shared by the live-edge reads: deleted edges never
/// resolve; the survivors' recorded endpoints do - a dead endpoint drops
/// the edge, a moved path resolves through its durable session id - and
/// the resolved paths replace the recorded ones.
fn resolve_live_edges(
    state: &ReplayState,
    resolver: &mut LivePathResolver,
) -> Result<Vec<RlmLedgerEdge>> {
    let mut edges = Vec::with_capacity(state.edges.len());
    for edge in &state.edges {
        if edge.deleted.is_some() {
            continue;
        }
        let (Some(child), Some(parent)) = (
            resolver.resolve(&edge.child)?,
            resolver.resolve(&edge.parent)?,
        ) else {
            continue;
        };
        edges.push(RlmLedgerEdge {
            parent: parent.to_string_lossy().to_string(),
            child: child.to_string_lossy().to_string(),
            ..edge.clone()
        });
    }
    Ok(edges)
}

/// Fold parsed records into the replayed edge set, keeping only the
/// records whose child id `keep` selects.
fn fold_records(records: Vec<LedgerRecord>, keep: impl Fn(&str) -> bool) -> ReplayState {
    let mut state = ReplayState::default();
    for record in records {
        match record {
            LedgerRecord::Spawn {
                child_id,
                parent,
                child,
                depth,
                name,
                factory,
            } if keep(&child_id) => {
                let key = edge_key(&child_id, &child);
                let edge = RlmLedgerEdge {
                    child_id,
                    parent,
                    child,
                    depth,
                    name,
                    deleted: None,
                    deleted_usage: None,
                    factory,
                };
                if let Some(at) = state.index.get(&key).copied() {
                    state.edges[at] = edge;
                } else {
                    state.index.insert(key, state.edges.len());
                    state.edges.push(edge);
                }
            }
            LedgerRecord::Rename {
                child_id,
                child,
                name,
            } if keep(&child_id) => {
                let key = edge_key(&child_id, &child);
                if let Some(&at) = state.index.get(&key) {
                    state.edges[at].name = name;
                } else if let Some(at) = sole_edge_by_child_id(&state, &child_id) {
                    state.edges[at].name = name;
                }
            }
            LedgerRecord::Delete {
                child_id,
                child,
                reason,
                usage,
            } if keep(&child_id) => {
                let key = edge_key(&child_id, &child);
                let at = match state.index.get(&key).copied() {
                    Some(at) => Some(at),
                    None => sole_edge_by_child_id(&state, &child_id),
                };
                if let Some(at) = at {
                    state.edges[at].deleted = Some(reason);
                    // The snapshot is sticky: a re-tombstone without a usage
                    // block never clears it.
                    if usage.is_some() {
                        state.edges[at].deleted_usage = usage;
                    }
                }
            }
            _ => {}
        }
    }
    for (at, edge) in state.edges.iter().enumerate() {
        if edge.deleted.is_some() {
            continue;
        }
        if let Some(id) = Path::new(&edge.parent).file_stem() {
            state
                .children_by_parent_id
                .entry(id.to_string_lossy().into_owned())
                .or_default()
                .push(at);
        }
    }
    state
}

impl RlmSpawnLedger {
    /// Ledger over one sessions dir, with a caller-supplied log sink for
    /// degraded reads and seed skips.
    pub fn new(
        agent_dir: &Path,
        sessions_dir: &Path,
        log: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        Self {
            path: rlm_ledger_path(agent_dir, sessions_dir),
            // Canonical agent dir: the resolver's tree anchor takes the
            // same realpath form as the sessions dir (one path form).
            agent_dir: canonicalize_dir(agent_dir),
            canonical_sessions_dir: canonicalize_dir(sessions_dir),
            seed_attempted: AtomicBool::new(false),
            cache: Mutex::new(None),
            log: Box::new(log),
        }
    }

    pub fn ledger_path(&self) -> &Path {
        &self.path
    }

    fn log(&self, message: &str) {
        (self.log)(message);
    }

    /// Record a spawn admission. The child session path must be unique among
    /// live edges (a per-process advisory check).
    ///
    /// # Errors
    ///
    /// Returns an error when the spawn input is invalid (an empty child
    /// id, parent, or child session path, or a zero depth), when another
    /// live edge already claims the child session path, when the ledger
    /// replay fails (an oversized ledger), or when the record cannot
    /// be appended.
    pub fn append_spawn(&self, input: &RlmSpawnInput) -> Result<()> {
        if input.child_id.is_empty()
            || input.parent.is_empty()
            || input.child.is_empty()
            || input.depth < 1
        {
            bail!(
                "RLM ledger: invalid spawn for {} (depth {})",
                if input.child_id.is_empty() {
                    "<missing childId>"
                } else {
                    &input.child_id
                },
                input.depth
            );
        }
        let child_path = canonical_session_path(Path::new(&input.child));
        let child_path_text = child_path.to_string_lossy().to_string();
        let state = self.replay_cached()?;
        for edge in &state.edges {
            let edge_child = canonical_session_path(Path::new(&edge.child));
            if edge.deleted.is_none() && edge_child == child_path && edge.child_id != input.child_id
            {
                bail!(
                    "RLM ledger: duplicate child session path {child_path_text} (already {})",
                    edge.child_id
                );
            }
        }
        let mut record = json!({
            "v": 1,
            "op": "spawn",
            "at": now_iso(),
            "childId": input.child_id,
            "parent": canonical_session_path(Path::new(&input.parent)).to_string_lossy(),
            "child": child_path_text,
            "depth": input.depth,
            "name": input.name,
        });
        // Optional: old readers skip the unknown field (no version bump).
        if let Some(factory) = &input.factory {
            record["factory"] = json!(factory);
        }
        self.append_record(&record)
    }

    /// Record a rename for a known child edge.
    ///
    /// # Errors
    ///
    /// Returns an error when the rename record cannot be appended.
    pub fn append_rename(&self, child_id: &str, child: &str, name: &str) -> Result<()> {
        let child_path = canonical_session_path(Path::new(child));
        self.append_record(&json!({
            "v": 1,
            "op": "rename",
            "at": now_iso(),
            "childId": child_id,
            "child": child_path.to_string_lossy(),
            "name": name,
        }))
    }

    /// Rename by child session path alone (an offline rename knows no
    /// childId): one rename record for every live edge at that path.
    ///
    /// # Errors
    ///
    /// Returns an error when the replay fails (an oversized ledger)
    /// or one of the rename records cannot be appended.
    pub fn append_rename_by_child_path(&self, child: &str, name: &str) -> Result<()> {
        let target = canonical_session_path(Path::new(child));
        let state = self.replay_cached()?;
        for edge in &state.edges {
            if edge.deleted.is_none() && canonical_session_path(Path::new(&edge.child)) == target {
                self.append_record(&json!({
                    "v": 1,
                    "op": "rename",
                    "at": now_iso(),
                    "childId": edge.child_id,
                    "child": target.to_string_lossy(),
                    "name": name,
                }))?;
            }
        }
        Ok(())
    }

    /// Tombstone a child's edge.
    ///
    /// # Errors
    ///
    /// Returns an error when the tombstone record cannot be appended.
    pub fn append_delete(
        &self,
        child_id: &str,
        child: &str,
        reason: RlmLedgerDeleteReason,
    ) -> Result<()> {
        let child_path = canonical_session_path(Path::new(child));
        self.append_record(&json!({
            "v": 1,
            "op": "delete",
            "at": now_iso(),
            "childId": child_id,
            "child": child_path.to_string_lossy(),
            "reason": reason.wire_name(),
        }))
    }

    /// Tombstone every edge for one child session path (duplicate edges from raced or corrupt
    /// appends; a live one would resurrect a later recreation at that path as a subagent).
    ///
    /// # Errors
    ///
    /// Returns an error when the replay fails or one of the tombstone records cannot be appended.
    pub fn tombstone_child_path(
        &self,
        child: &str,
        reason: RlmLedgerDeleteReason,
    ) -> Result<Vec<RlmLedgerEdge>> {
        let target = canonical_session_path(Path::new(child));
        let state = self.replay_cached()?;
        let matching: Vec<RlmLedgerEdge> = state
            .edges
            .iter()
            .filter(|edge| canonical_session_path(Path::new(&edge.child)) == target)
            .cloned()
            .collect();
        for edge in &matching {
            self.append_delete(&edge.child_id, &edge.child, reason)?;
        }
        Ok(matching)
    }

    /// Every recorded spawn as a tree of durable session ids, cached with
    /// the replay (a new record yields a new tree).
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger replay fails (an oversized ledger).
    pub(crate) fn spawn_tree(&self) -> Result<Arc<SpawnTree>> {
        self.seed_once()?;
        let state = self.replay_cached()?;
        Ok(Arc::clone(
            state
                .spawn_tree
                .get_or_init(|| Arc::new(SpawnTree::of(&state.edges))),
        ))
    }

    /// Seed and replay the ledger ahead of its first reader; a failed
    /// replay is left to that reader, which reports it.
    pub(crate) fn warm(&self) {
        if self.seed_once().is_ok() {
            drop(self.replay_cached());
        }
    }

    /// The live family below `roots`, walked through the replay's parent
    /// index: the cost follows the families' size, not the ledger's. Each
    /// call re-resolves the endpoints it visits (restore, relocation,
    /// deletion, and symlink retargets append no ledger row). A node's
    /// children are the live edges recorded under its durable session id -
    /// that of its canonical path or of the path it was reached by - whose
    /// resolved parent is the node itself. Edges carry canonical endpoints,
    /// in walk order; each descendant appears once.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger replay fails (an oversized ledger)
    /// or a prior panic poisoned the artifact index lock.
    pub(crate) fn family_edges(
        &self,
        roots: impl IntoIterator<Item = PathBuf>,
    ) -> Result<Vec<RlmLedgerEdge>> {
        self.seed_once()?;
        let state = self.replay_cached()?;
        let mut resolver = LivePathResolver::new(
            self.agent_dir.clone(),
            self.canonical_sessions_dir.clone(),
            &state.artifact_index,
        );
        let mut visited = HashSet::new();
        let mut queue = Vec::new();
        for root in roots {
            let node = canonical_session_path(&root);
            if visited.insert(node.clone()) {
                queue.push((node, root));
            }
        }
        let mut edges = Vec::new();
        while let Some((node, reached_by)) = queue.pop() {
            let mut ids = vec![node.file_stem()];
            if reached_by.file_stem() != node.file_stem() {
                ids.push(reached_by.file_stem());
            }
            for id in ids.into_iter().flatten() {
                let Some(indices) = state
                    .children_by_parent_id
                    .get(id.to_string_lossy().as_ref())
                else {
                    continue;
                };
                for &at in indices {
                    let edge = &state.edges[at];
                    let Some(parent) = resolver.resolve(&edge.parent)? else {
                        continue;
                    };
                    if canonical_session_path(&parent) != node {
                        continue;
                    }
                    let Some(child) = resolver.resolve(&edge.child)? else {
                        continue;
                    };
                    let child = canonical_session_path(&child);
                    if !visited.insert(child.clone()) {
                        continue;
                    }
                    edges.push(RlmLedgerEdge {
                        parent: node.to_string_lossy().into_owned(),
                        child: child.to_string_lossy().into_owned(),
                        ..edge.clone()
                    });
                    queue.push((child, PathBuf::from(&edge.child)));
                }
            }
        }
        Ok(edges)
    }

    /// Replay edges without liveness reconciliation. Deleted edges are
    /// filtered by default; tombstones carry their delete reason.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger replay fails (an oversized
    /// ledger); a missing ledger replays empty.
    pub fn edges(&self, include_deleted: bool) -> Result<Vec<RlmLedgerEdge>> {
        self.seed_once()?;
        let state = self.replay_cached()?;
        Ok(state
            .edges
            .iter()
            .filter(|edge| include_deleted || edge.deleted.is_none())
            .cloned()
            .collect())
    }

    /// Live edges reconciled by liveness of their recorded endpoints: a dead endpoint drops the
    /// edge; a MOVED path resolves through its durable session id first.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger replay fails (an oversized
    /// ledger); a missing ledger replays empty, and only the liveness
    /// resolution drops edges.
    pub fn live_edges(&self) -> Result<Vec<RlmLedgerEdge>> {
        self.seed_once()?;
        let state = self.replay_cached()?;
        let mut resolver = LivePathResolver::new(
            self.agent_dir.clone(),
            self.canonical_sessions_dir.clone(),
            &state.artifact_index,
        );
        resolve_live_edges(&state, &mut resolver)
    }

    /// The opened parent file's live edges: only the records of children
    /// spawned by that parent file (matched by its durable session id,
    /// the file-name stem) fold and resolve, and only those whose
    /// resolved parent IS the parent file remain. A parent's read never
    /// stats, or walks the artifacts tree for, another parent's edges.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger replay fails (an oversized
    /// ledger); a missing ledger replays empty, and only the liveness
    /// resolution drops edges.
    pub fn live_edges_of_parent(&self, parent_file: &Path) -> Result<Vec<RlmLedgerEdge>> {
        self.seed_once()?;
        let parent_file = canonical_session_path(parent_file);
        let state = self.replay_of_parent(&parent_file)?;
        let mut resolver = LivePathResolver::new(
            self.agent_dir.clone(),
            self.canonical_sessions_dir.clone(),
            &state.artifact_index,
        );
        let mut edges = resolve_live_edges(&state, &mut resolver)?;
        edges.retain(|edge| canonical_session_path(Path::new(&edge.parent)) == parent_file);
        Ok(edges)
    }

    /// Whether the given spawn edge is still live (not tombstoned, and
    /// both its child and parent transcripts present - the same
    /// reconciliation `live_edges` applies) - the seed arms' per-write
    /// liveness revalidation: an edge deleted (or a file removed) while
    /// a seed was mid-read never writes its row. The child id is
    /// matched together with the child path: ids can be shared by
    /// edges with different paths, and only the exact edge a seed
    /// snapshotted counts as live. An unreadable (oversized) ledger reads
    /// as not-live.
    pub fn edge_is_live(&self, child_id: &str, child: &str) -> bool {
        let canonical_child = canonical_session_path(Path::new(child));
        self.seed_once().is_ok()
            && self.replay_cached().is_ok_and(|state| {
                let is_live = |edge: &RlmLedgerEdge| {
                    edge.child_id == child_id
                        && edge.deleted.is_none()
                        && canonical_session_path(Path::new(&edge.child)) == canonical_child
                        && is_file(Path::new(&edge.child))
                        && is_file(Path::new(&edge.parent))
                };
                // Most reads prove liveness through the index. Its keys
                // were canonicalized at replay, though: a file replaced
                // by a symlink does not change the ledger's stat identity.
                // A stale key or tombstoned alias cannot prove absence;
                // preserve the original read-time path comparison then.
                state
                    .index
                    .get(&edge_key(child_id, child))
                    .is_some_and(|&at| is_live(&state.edges[at]))
                    || state.edges.iter().any(is_live)
            })
    }

    fn seed_once(&self) -> Result<()> {
        if self.seed_attempted.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        match self.seed() {
            Ok(()) => Ok(()),
            Err(error) => {
                // A broken seed degrades to an empty ledger; it never
                // fail-closes the read path.
                self.log(&format!("RLM ledger seeding failed: {error:#}"));
                Ok(())
            }
        }
    }

    /// Replay behind the stat guard: a file whose identity snapshot is
    /// unchanged reuses the cached edges. A missing file replays empty.
    fn replay_cached(&self) -> Result<Arc<ReplayState>> {
        let identity = file_identity(&self.path)?;
        let mut cache = self.cache.lock().expect("ledger cache lock");
        if let (Some(identity), Some(cached)) = (&identity, cache.as_ref()) {
            if *identity == cached.identity {
                return Ok(Arc::clone(&cached.state));
            }
        }
        let state = Arc::new(self.replay()?);
        if let Some(identity) = identity {
            *cache = Some(ReplaySnapshot {
                identity,
                state: Arc::clone(&state),
            });
        }
        Ok(state)
    }

    fn replay(&self) -> Result<ReplayState> {
        Ok(fold_records(self.read_records()?, |_| true))
    }

    /// The opened parent file's subset of the replayed ledger: fold only
    /// the records of children spawned by `parent_file` (matched by its
    /// durable session id, the file-name stem). Every join, including
    /// the sole-child-id fallback, stays within one child id, so the
    /// subset fold equals the full fold restricted to that parent's
    /// children.
    fn replay_of_parent(&self, parent_file: &Path) -> Result<ReplayState> {
        let records = self.read_records()?;
        let own: HashSet<String> = records
            .iter()
            .filter_map(|record| match record {
                LedgerRecord::Spawn {
                    child_id, parent, ..
                } if Path::new(parent).file_stem() == parent_file.file_stem() => {
                    Some(child_id.clone())
                }
                _ => None,
            })
            .collect();
        Ok(fold_records(records, |child_id| own.contains(child_id)))
    }

    /// The whole ledger's parsed records within its read bounds: the
    /// byte and record-count caps apply to the whole file; a missing
    /// ledger reads empty, and one torn or unknown line skips that
    /// record only.
    fn read_records(&self) -> Result<Vec<LedgerRecord>> {
        let Ok(bytes) = fs::read(&self.path) else {
            return Ok(Vec::new());
        };
        if bytes.len() as u64 > RLM_LEDGER_MAX_BYTES {
            bail!(
                "RLM ledger {} exceeds {RLM_LEDGER_MAX_BYTES} bytes; refusing to read",
                self.path.display()
            );
        }
        // A torn write inside a multibyte name must spoil one line, not
        // the whole file.
        let content = String::from_utf8_lossy(&bytes);
        let mut records = Vec::new();
        let mut lines = 0usize;
        for (index, line) in content.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            lines += 1;
            if lines > RLM_LEDGER_MAX_RECORDS {
                bail!(
                    "RLM ledger {} exceeds {RLM_LEDGER_MAX_RECORDS} records; refusing to read",
                    self.path.display()
                );
            }
            match parse_ledger_line(line, index) {
                Ok(Some(record)) => records.push(record),
                Ok(None) => {
                    self.log(&format!(
                        "RLM ledger: skipped record with unknown op on line {}",
                        index + 1
                    ));
                }
                Err(error) => {
                    self.log(&format!(
                        "RLM ledger {}: skipped {error:#}",
                        self.path.display()
                    ));
                }
            }
        }
        Ok(records)
    }

    /// One durable append; the first record in a fresh file is the meta
    /// header (the same line `seed` publishes).
    fn append_record(&self, record: &Value) -> Result<()> {
        self.seed_once()?;
        if let Some(parent) = self.path.parent() {
            crate::paths::ensure_dir(parent)?;
        }
        let mut line = serde_json::to_string(&record)?;
        line.push('\n');
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&self.path)
            .with_context(|| format!("open RLM ledger {}", self.path.display()))?;
        if file.metadata()?.len() == 0 {
            let meta = json!({
                "v": 1,
                "op": "meta",
                "at": now_iso(),
                "sessionsDir": self.canonical_sessions_dir.to_string_lossy(),
            });
            let mut header = serde_json::to_string(&meta)?;
            header.push('\n');
            file.write_all(header.as_bytes())?;
        } else {
            // A crash can leave the final record torn short of its
            // newline: start on a fresh line so this record never glues
            // onto it.
            let mut last = [0u8; 1];
            file.seek(SeekFrom::End(-1))?;
            file.read_exact(&mut last)?;
            if last[0] != b'\n' {
                line.insert(0, '\n');
            }
        }
        file.write_all(line.as_bytes())?;
        file.sync_all()?;
        // Our own writes must not be served stale from the stat guard.
        self.cache.lock().expect("ledger cache lock").take();
        Ok(())
    }

    /// Seed a missing ledger from the legacy per-parent registries, then publish atomically (an
    /// interrupted seed leaves nothing to mis-read; a concurrent append wins).
    fn seed(&self) -> Result<()> {
        if self.path.exists() {
            return Ok(());
        }
        let Ok(root_entries) = fs::read_dir(&self.canonical_sessions_dir) else {
            return Ok(());
        };
        let mut queue: Vec<(PathBuf, u32)> = root_entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
            .map(|path| (path, 0))
            .collect();
        queue.sort();
        let mut visited: Vec<PathBuf> = queue
            .iter()
            .map(|(path, _)| canonical_session_path(path))
            .collect();
        let mut records = String::new();
        let mut record_count = 0usize;
        while let Some((session_file, depth)) = queue.pop() {
            for entry in read_legacy_registry(&session_file) {
                if entry.status == "deleted" {
                    continue;
                }
                if entry.child_id.is_empty() {
                    self.log("RLM ledger: skipped seeding a registry entry without a childId");
                    continue;
                }
                let child_path = canonical_session_path(Path::new(&entry.session_file));
                if visited.contains(&child_path) {
                    continue;
                }
                visited.push(child_path.clone());
                // A registry depth < 1 (legacy 0-depth entries exist in real
                // data) is unwritable; derive parent depth + 1 instead of
                // skipping the edge.
                let child_depth = if entry.rlm_depth >= 1 {
                    entry.rlm_depth
                } else {
                    depth + 1
                };
                records.push_str(&serde_json::to_string(&json!({
                    "v": 1,
                    "op": "spawn",
                    "at": now_iso(),
                    "childId": entry.child_id,
                    "parent": canonical_session_path(&session_file).to_string_lossy(),
                    "child": child_path.to_string_lossy(),
                    "depth": child_depth,
                    "name": entry.session_name,
                }))?);
                records.push('\n');
                record_count += 1;
                queue.push((PathBuf::from(&entry.session_file), child_depth));
            }
        }
        if records.is_empty() {
            return Ok(());
        }
        if records.len() as u64 > RLM_LEDGER_MAX_BYTES || record_count + 1 > RLM_LEDGER_MAX_RECORDS
        {
            self.log(&format!(
                "RLM ledger: seed exceeds read bounds ({record_count} records, {} bytes); skipping seeding",
                records.len()
            ));
            return Ok(());
        }
        let mut payload = serde_json::to_string(&json!({
            "v": 1,
            "op": "meta",
            "at": now_iso(),
            "sessionsDir": self.canonical_sessions_dir.to_string_lossy(),
        }))?;
        payload.push('\n');
        payload.push_str(&records);
        let dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(dir)?;
        let temp_path = self.path.with_extension(format!(
            "seed-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        {
            let mut file = File::create(&temp_path)?;
            file.write_all(payload.as_bytes())?;
            file.sync_all()?;
        }
        // Atomic no-clobber publish via a hard link: EEXIST means a live
        // append created the real file meanwhile and wins.
        match fs::hard_link(&temp_path, &self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                self.log(&format!(
                    "RLM ledger: link publish unavailable ({error}); skipping seeding"
                ));
            }
        }
        let _ = fs::remove_file(&temp_path);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
