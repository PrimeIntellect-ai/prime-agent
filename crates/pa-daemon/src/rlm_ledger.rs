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
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::lease::canonical_session_path;
use crate::util::now_iso;

// The read-back machinery (the wire record grammar, the line parser, the
// replay state + stat-identity cache records, the edge join keys, the
// path canonicalizers, and the `live_edges` liveness resolver with its
// session-artifacts index) moved to the child module at the same tree
// position (rlm_ledger::replay); the use-binding keeps the facade
// impl's bare-name resolution (the `replay`/`new`/`rlm_ledger_path`/
// `edge_is_live`/`live_edges` callers).
mod replay;

use replay::{
    canonicalize_dir, edge_key, file_identity, is_file, parse_ledger_line, sole_edge_by_child_id,
    LedgerRecord, LivePathResolver, ReplaySnapshot, ReplayState,
};

// The legacy-registry concern (the pre-ledger per-parent registry
// reader, its bounded header-line probe, and the per-child display
// sidecar entry + atomic writer) moved to the child module at the same
// tree position (rlm_ledger::legacy_registry); the re-exports keep the
// facade's paths stable (rlm_roster.rs, update_roster.rs, and
// supervisor/{adoption,worker_lifecycle}.rs), the pub(crate) binding
// keeps the seed caller resolving, and the cfg(test) binding keeps the
// tests glob resolving without a non-test unused import.
mod legacy_registry;

pub(crate) use legacy_registry::read_legacy_registry;
#[cfg(test)]
use legacy_registry::{legacy_registry_path, LEGACY_REGISTRY_HEADER_READ_MAX_BYTES};
pub use legacy_registry::{
    read_rlm_subagent_display, write_rlm_subagent_display, LegacyRlmSubagentEntry,
    RlmSubagentDisplayEntry,
};

// The test mass (the ledger battery) moved to the child module at the
// same tree position (rlm_ledger::tests); the #[cfg(test)] decl rides
// at the facade tail.

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
    /// The wire names (`user`, `parent-teardown`, `revoked`, `gc`).
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
    /// The child's captured own usage at deletion: the amendment delete
    /// record's durable snapshot (TS `SessionUsageSummary` shape), which
    /// keeps a tombstoned child's spend billable after its transcript is
    /// gone. `None` on legacy tombstones and live edges.
    pub deleted_usage: Option<crate::session_usage::SessionUsageSummary>,
}

/// Inputs for `append_spawn` (validated like a record the reader would
/// refuse to read back).
#[derive(Debug, Clone)]
pub struct RlmSpawnInput {
    pub child_id: String,
    pub parent: String,
    pub child: String,
    pub depth: u32,
    pub name: String,
}

/// The per-sessions-dir spawn ledger. Reads are guarded by a file stat
/// snapshot; the first operation seeds a missing ledger from the legacy
/// per-parent registries (a seeding failure degrades to an empty ledger and
/// is never fail-closed).
pub struct RlmSpawnLedger {
    path: PathBuf,
    agent_dir: PathBuf,
    canonical_sessions_dir: PathBuf,
    seed_attempted: AtomicBool,
    cache: Mutex<Option<ReplaySnapshot>>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

/// Ledger path for one sessions dir (TS `rlmLedgerPath`): a 16-hex sha256 of
/// the canonical sessions dir under `<agent-dir>/rlm-ledger/`.
#[must_use]
pub fn rlm_ledger_path(agent_dir: &Path, sessions_dir: &Path) -> PathBuf {
    let canonical = canonicalize_dir(sessions_dir);
    let hash = crate::paths::hash_key(&canonical.to_string_lossy(), 16);
    agent_dir.join(RLM_LEDGER_DIR).join(format!("{hash}.jsonl"))
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
            // The artifact tree the path resolver walks anchors to the
            // canonical agent dir (the same realpath form the sessions
            // dir takes), so resolved edges carry one path form.
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
    /// live edges (a per-process advisory check, exactly like the TS writer).
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
        self.append_record(&json!({
            "v": 1,
            "op": "spawn",
            "at": now_iso(),
            "childId": input.child_id,
            "parent": canonical_session_path(Path::new(&input.parent)).to_string_lossy(),
            "child": child_path_text,
            "depth": input.depth,
            "name": input.name,
        }))
    }

    /// Record a rename for a known child edge.
    ///
    /// # Errors
    ///
    /// Returns an error when the rename record cannot be appended (the
    /// ledger directory, open, serialization, write, or sync fails).
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
    /// Returns an error when the tombstone record cannot be appended
    /// (the ledger directory, open, serialization, write, or sync
    /// fails).
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

    /// The deletion's durable usage amendment (TS has no equivalent: its
    /// bucket re-reads the tombstoned child's transcript, which a normal
    /// delete removes - the Macroscope race). The amendment is a second
    /// delete record for the same edge carrying the captured own-usage
    /// snapshot; replay's last-writer-wins merges it into the tombstoned
    /// edge, so the spend survives the transcript's removal, a saved-
    /// session delete, and daemon restarts.
    ///
    /// # Errors
    ///
    /// Returns an error when the usage snapshot cannot be serialized or
    /// the tombstone record cannot be appended; a snapshot replay would
    /// reject (a non-finite or negative cost) rides as absent — the
    /// bare tombstone still lands.
    pub fn append_delete_with_usage(
        &self,
        child_id: &str,
        child: &str,
        reason: RlmLedgerDeleteReason,
        usage: &crate::session_usage::SessionUsageSummary,
    ) -> Result<()> {
        let child_path = canonical_session_path(Path::new(child));
        // The writer never records what the reader refuses: replay
        // rejects a negative or NaN usage cost outright, which would
        // drop the whole tombstone record. That includes negative
        // zero - `is_sign_negative()` is how replay reads it, and
        // `>= 0.0` alone would have passed `-0.0` through. A session
        // file may carry such a cost (the file's own summary read
        // preserves it), so a snapshot the reader would reject rides as
        // absent - the tombstone still lands bare (the historical-gap
        // zero).
        if !usage.cost.is_finite() || usage.cost.is_sign_negative() {
            return self.append_delete(child_id, child, reason);
        }
        let usage = serde_json::to_value(usage)
            .with_context(|| "serialize the deleted child usage snapshot")?;
        self.append_record(&json!({
            "v": 1,
            "op": "delete",
            "at": now_iso(),
            "childId": child_id,
            "child": child_path.to_string_lossy(),
            "reason": reason.wire_name(),
            "usage": usage,
        }))
    }

    /// Tombstone every edge for one child session path (a path may hold
    /// duplicate edges from raced or corrupt appends; a live one would
    /// resurrect a later recreation at that path as a subagent).
    ///
    /// # Errors
    ///
    /// Returns an error when the replay fails or one of the tombstone
    /// records cannot be appended.
    pub fn tombstone_child_path(
        &self,
        child: &str,
        reason: RlmLedgerDeleteReason,
    ) -> Result<Vec<RlmLedgerEdge>> {
        self.tombstone_child_path_with_usage(child, reason, None)
    }

    /// The saved-session delete's tombstone with the captured usage
    /// snapshot (the file dies right after this, so the snapshot must ride
    /// the tombstone: the bucket's lazy file fallback has nothing to read).
    ///
    /// # Errors
    ///
    /// Returns an error when the replay fails or one of the per-edge
    /// tombstones cannot be appended.
    pub fn tombstone_child_path_with_usage(
        &self,
        child: &str,
        reason: RlmLedgerDeleteReason,
        usage: Option<&crate::session_usage::SessionUsageSummary>,
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
            match usage {
                Some(usage) => {
                    self.append_delete_with_usage(&edge.child_id, &edge.child, reason, usage)?;
                }
                None => self.append_delete(&edge.child_id, &edge.child, reason)?,
            }
        }
        Ok(matching)
    }

    /// Recursive spend of tombstoned descendants keyed by the parent's
    /// canonical session path (TS `deletedDescendantUsageByParent`, the
    /// agents-view cost rollup's bucket): a deleted subagent keeps no row
    /// anywhere, so nothing re-adds its spend once the tombstone drops its
    /// row - this folds the captured spend back per family so cost rollups
    /// bill it to the parent that spent it. Live paths never contribute
    /// (their own rows carry their spend); a tombstoned path that still
    /// has a catalog row bills through that row instead (see the skip
    /// below); the first tombstoned edge claims a path (a raced ledger
    /// must not bill one child to two parents); the fold is an iterative
    /// post-order walk (a pathological chain must not overflow the
    /// stack) that reads each tombstoned child's captured own usage
    /// first and falls back to the transcript's own-usage fold (the
    /// resumable `read_session_info` scan) for legacy tombstones that
    /// predate the capture - a path with neither a snapshot nor a
    /// readable transcript is the documented historical gap (no
    /// fabricated backfill: zero).
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger replay fails (an oversized
    /// ledger).
    pub fn deleted_descendant_usage_by_parent(
        &self,
    ) -> Result<HashMap<String, crate::session_usage::SessionUsageSummary>> {
        use crate::session_usage::SessionUsageSummary;
        let edges = self.edges(true)?;
        let canonical = |path: &str| {
            canonical_session_path(Path::new(path))
                .to_string_lossy()
                .to_string()
        };
        let mut live_paths: HashSet<String> = HashSet::new();
        for edge in &edges {
            if edge.deleted.is_none() {
                live_paths.insert(canonical(&edge.child));
            }
        }
        // First writer wins per path: the earliest tombstoned edge claims
        // the child (and its snapshot) for its parent.
        let mut children_by_parent: HashMap<String, Vec<String>> = HashMap::new();
        let mut snapshot_by_path: HashMap<String, Option<SessionUsageSummary>> = HashMap::new();
        for edge in &edges {
            if edge.deleted.is_none() {
                continue;
            }
            let child = canonical(&edge.child);
            if live_paths.contains(&child) || snapshot_by_path.contains_key(&child) {
                continue;
            }
            // A tombstoned path that still has a catalog row bills
            // through that row instead (the rollup sums the child row
            // AND the parent bucket, so billing both would double the
            // spend): the flat catalog scans this ledger's sessions dir,
            // so the row exists exactly while the file sits directly in
            // it. Real RLM children persist under session-artifacts,
            // where the flat catalog never lists them - the RLM delete
            // keeps that transcript and no row anywhere bills it, so the
            // bucket is the only surface that keeps its spend.
            let child_file = Path::new(&child);
            if child_file.is_file()
                && child_file.parent() == Some(self.canonical_sessions_dir.as_path())
            {
                continue;
            }
            let parent = canonical(&edge.parent);
            snapshot_by_path.insert(child.clone(), edge.deleted_usage.clone());
            children_by_parent.entry(parent).or_default().push(child);
        }
        let zero = || SessionUsageSummary {
            input_tokens: 0,
            output_tokens: 0,
            cost: 0.0,
        };
        let add = |mut left: SessionUsageSummary, right: SessionUsageSummary| {
            // Saturating: the bucket feeds billable rollups — a huge
            // snapshot must not panic in debug or wrap to an underbill in
            // release (the same convention as every other usage sum).
            left.input_tokens = left.input_tokens.saturating_add(right.input_tokens);
            left.output_tokens = left.output_tokens.saturating_add(right.output_tokens);
            left.cost += right.cost;
            left
        };
        let tombstone_usage = |path: &str| -> SessionUsageSummary {
            match snapshot_by_path.get(path).cloned().flatten() {
                Some(snapshot) => snapshot,
                // The legacy fallback is the same own-usage fold, read
                // through the resumable scan: a repeat bucket fold on a
                // surviving legacy transcript is one stat per child.
                None => crate::session_store::read_session_info(Path::new(path))
                    .and_then(|info| info.usage)
                    .unwrap_or_else(zero),
            }
        };
        // Iterative post-order fold with per-path memoization.
        let mut contribution: HashMap<String, SessionUsageSummary> = HashMap::new();
        let mut on_stack: HashSet<String> = HashSet::new();
        for children in children_by_parent.values() {
            for root in children {
                if contribution.contains_key(root) {
                    continue;
                }
                let mut stack = vec![root.clone()];
                on_stack.insert(root.clone());
                while let Some(current) = stack.last().cloned() {
                    if contribution.contains_key(&current) {
                        stack.pop();
                        on_stack.remove(&current);
                        continue;
                    }
                    let pending: Vec<String> = children_by_parent
                        .get(&current)
                        .map(|children| {
                            children
                                .iter()
                                .filter(|path| {
                                    !contribution.contains_key(*path) && !on_stack.contains(*path)
                                })
                                .cloned()
                                .collect()
                        })
                        .unwrap_or_default();
                    if !pending.is_empty() {
                        for path in pending {
                            on_stack.insert(path.clone());
                            stack.push(path);
                        }
                        continue;
                    }
                    stack.pop();
                    on_stack.remove(&current);
                    let mut total = tombstone_usage(&current);
                    for descendant in children_by_parent
                        .get(&current)
                        .map(Vec::as_slice)
                        .unwrap_or_default()
                    {
                        if let Some(folded) = contribution.get(descendant) {
                            total = add(total, folded.clone());
                        }
                    }
                    contribution.insert(current, total);
                }
            }
        }
        let mut usage_by_parent: HashMap<String, SessionUsageSummary> = HashMap::new();
        for (parent, children) in &children_by_parent {
            let mut total = zero();
            for child in children {
                if let Some(folded) = contribution.get(child) {
                    total = add(total, folded.clone());
                }
            }
            if total.input_tokens > 0 || total.output_tokens > 0 || total.cost > 0.0 {
                usage_by_parent.insert(parent.clone(), total);
            }
        }
        Ok(usage_by_parent)
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

    /// Live edges reconciled by liveness of their recorded endpoints: a
    /// parent or child whose session file no longer exists drops the
    /// edge. A recorded path whose file MOVED (a storage-root migration,
    /// an artifacts re-parenting) resolves through its durable session id
    /// first — the sessions dir and the session-artifacts tree hold the
    /// same session under a different root — and the returned edge
    /// carries the resolved path, so a restart-era child never anchors to
    /// a stale path. Only a session with no live file anywhere is dead.
    ///
    /// # Errors
    ///
    /// Returns an error when the ledger replay fails (an oversized
    /// ledger); a missing ledger replays empty, and only the liveness
    /// resolution drops edges.
    pub fn live_edges(&self) -> Result<Vec<RlmLedgerEdge>> {
        self.seed_once()?;
        let state = self.replay_cached()?;
        let mut resolver =
            LivePathResolver::new(self.agent_dir.clone(), self.canonical_sessions_dir.clone());
        let mut edges = Vec::with_capacity(state.edges.len());
        for edge in &state.edges {
            if edge.deleted.is_some() {
                continue;
            }
            let (Some(child), Some(parent)) = (
                resolver.resolve(&edge.child),
                resolver.resolve(&edge.parent),
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
        let child = canonical_session_path(Path::new(child));
        self.seed_once().is_ok()
            && self.replay_cached().is_ok_and(|state| {
                state.edges.iter().any(|edge| {
                    edge.child_id == child_id
                        && edge.deleted.is_none()
                        && canonical_session_path(Path::new(&edge.child)) == child
                        && is_file(Path::new(&edge.child))
                        && is_file(Path::new(&edge.parent))
                })
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
    fn replay_cached(&self) -> Result<ReplayState> {
        let identity = file_identity(&self.path)?;
        let mut cache = self.cache.lock().expect("ledger cache lock");
        if let (Some(identity), Some(cached)) = (&identity, cache.as_ref()) {
            if *identity == cached.identity {
                return Ok(cached.state.clone());
            }
        }
        let state = self.replay()?;
        if let Some(identity) = identity {
            *cache = Some(ReplaySnapshot {
                identity,
                state: state.clone(),
            });
        }
        Ok(state)
    }

    fn replay(&self) -> Result<ReplayState> {
        let Ok(bytes) = fs::read(&self.path) else {
            return Ok(ReplayState::default());
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
        let mut state = ReplayState::default();
        let mut records = 0usize;
        for (index, line) in content.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            records += 1;
            if records > RLM_LEDGER_MAX_RECORDS {
                bail!(
                    "RLM ledger {} exceeds {RLM_LEDGER_MAX_RECORDS} records; refusing to read",
                    self.path.display()
                );
            }
            let record = match parse_ledger_line(line, index) {
                Ok(Some(record)) => record,
                Ok(None) => {
                    self.log(&format!(
                        "RLM ledger: skipped record with unknown op on line {}",
                        index + 1
                    ));
                    continue;
                }
                Err(error) => {
                    self.log(&format!(
                        "RLM ledger {}: skipped {error:#}",
                        self.path.display()
                    ));
                    continue;
                }
            };
            match record {
                LedgerRecord::Spawn {
                    child_id,
                    parent,
                    child,
                    depth,
                    name,
                } => {
                    let key = edge_key(&child_id, &child);
                    if let Some(at) = state.index.get(&key).copied() {
                        state.edges[at] = RlmLedgerEdge {
                            child_id,
                            parent,
                            child,
                            depth,
                            name,
                            deleted: None,
                            deleted_usage: None,
                        };
                    } else {
                        state.index.insert(key.clone(), state.edges.len());
                        state.edges.push(RlmLedgerEdge {
                            child_id,
                            parent,
                            child,
                            depth,
                            name,
                            deleted: None,
                            deleted_usage: None,
                        });
                    }
                }
                LedgerRecord::Rename {
                    child_id,
                    child,
                    name,
                } => {
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
                } => {
                    let key = edge_key(&child_id, &child);
                    let at = match state.index.get(&key).copied() {
                        Some(at) => Some(at),
                        None => sole_edge_by_child_id(&state, &child_id),
                    };
                    if let Some(at) = at {
                        state.edges[at].deleted = Some(reason);
                        // The snapshot is sticky: a re-tombstone without a
                        // usage block (an idempotent retry, a bulk path
                        // tombstone) never clears a captured snapshot; a
                        // fresh capture replaces it (last writer wins).
                        if let Some(usage) = usage {
                            state.edges[at].deleted_usage = Some(usage);
                        }
                    }
                }
            }
        }
        Ok(state)
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

    /// Seed a missing ledger from the legacy per-parent registries, then
    /// publish atomically: the ledger file only exists once the seed is
    /// complete, so an interrupted seed leaves nothing to mis-read, and a
    /// concurrent append wins over the seed (its data is fresher than the
    /// registries).
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
                // data) is unwritable under the spawn invariants; derive
                // parent depth + 1 instead of skipping the edge.
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
