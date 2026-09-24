//! The daemon-owned RLM spawn ledger: one append-only JSONL file per sessions
//! dir recording spawn, rename, and delete admissions. Family topology
//! (parent/child edges, depths, names) is read back from this file instead of
//! being re-derived from session files, so historical and non-resident
//! children stay roster-visible after passivation. Mirrors the record
//! grammar, bounds, replay semantics, and legacy-registry seeding of the
//! TS `modes/daemon/rlm-ledger.ts`.
//!
//! Writers: the supervisor appends at admission moments (spawn at child
//! create, rename at subagent rename, delete at subagent delete). Readers:
//! every roster surface that must show non-resident children (`list --all`,
//! the saved-session catalog). Appends are single small O_APPEND writes
//! whose atomicity we rely on for cross-process interleaving; reads re-read
//! the whole file behind a stat guard, so staleness is bounded to in-flight
//! appends.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::lease::canonical_session_path;
use crate::util::now_iso;

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

/// One replayed ledger record (`meta` records carry no edge and are skipped).
#[derive(Debug, Clone, PartialEq)]
enum LedgerRecord {
    Spawn {
        child_id: String,
        parent: String,
        child: String,
        depth: u32,
        name: String,
    },
    Rename {
        child_id: String,
        child: String,
        name: String,
    },
    Delete {
        child_id: String,
        child: String,
        reason: RlmLedgerDeleteReason,
        usage: Option<crate::session_usage::SessionUsageSummary>,
    },
}

fn str_field(record: &Value, key: &str) -> Option<String> {
    record.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Parse one delete record's usage snapshot (TS `SessionUsageSummary`
/// wire shape). A present-but-malformed snapshot is a corrupt record: the
/// ledger fails loudly rather than billing a partial number.
fn parse_deleted_usage(
    usage: &Value,
    line_no: usize,
) -> Result<crate::session_usage::SessionUsageSummary> {
    let invalid = || {
        anyhow::Error::msg(format!(
            "malformed RLM ledger line {line_no}: invalid delete usage"
        ))
    };
    let input_tokens = usage
        .get("inputTokens")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let output_tokens = usage
        .get("outputTokens")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let cost = usage
        .get("cost")
        .and_then(Value::as_f64)
        .ok_or_else(invalid)?;
    if cost.is_nan() || cost.is_sign_negative() {
        bail!("malformed RLM ledger line {line_no}: invalid delete usage");
    }
    Ok(crate::session_usage::SessionUsageSummary {
        input_tokens,
        output_tokens,
        cost,
    })
}

/// Parse one ledger line: `v:1` records with a known op, `None` for a known
/// version with an unknown op (forward compatibility), an error for anything
/// else - silently skipping records a reader cannot understand would corrupt
/// topology, so version violations fail loudly.
fn parse_ledger_line(line: &str, index: usize) -> Result<Option<LedgerRecord>> {
    let line_no = index + 1;
    let record: Value = serde_json::from_str(line.trim())
        .with_context(|| format!("malformed RLM ledger line {line_no}"))?;
    if record.get("v") != Some(&json!(1)) {
        bail!("malformed RLM ledger line {line_no}: unsupported record version");
    }
    if record.get("at").and_then(Value::as_str).is_none() {
        bail!("malformed RLM ledger line {line_no}: missing at");
    }
    let op = record.get("op").and_then(Value::as_str).unwrap_or_default();
    let child_id = || str_field(&record, "childId");
    let child = || str_field(&record, "child");
    match op {
        "meta" => Ok(None),
        "spawn" => {
            let (Some(child_id), Some(parent), Some(child), Some(name)) = (
                child_id(),
                str_field(&record, "parent"),
                child(),
                str_field(&record, "name"),
            ) else {
                bail!("malformed RLM ledger line {line_no}: invalid spawn record");
            };
            let Some(depth) = record.get("depth").and_then(Value::as_u64) else {
                bail!("malformed RLM ledger line {line_no}: invalid spawn record");
            };
            if depth < 1 || depth > u32::MAX as u64 {
                bail!("malformed RLM ledger line {line_no}: invalid spawn record");
            }
            Ok(Some(LedgerRecord::Spawn {
                child_id,
                parent,
                child,
                depth: depth as u32,
                name,
            }))
        }
        "rename" => {
            let (Some(child_id), Some(child), Some(name)) =
                (child_id(), child(), str_field(&record, "name"))
            else {
                bail!("malformed RLM ledger line {line_no}: invalid rename record");
            };
            Ok(Some(LedgerRecord::Rename {
                child_id,
                child,
                name,
            }))
        }
        "delete" => {
            let (Some(child_id), Some(child)) = (child_id(), child()) else {
                bail!("malformed RLM ledger line {line_no}: invalid delete record");
            };
            let Some(reason) = record
                .get("reason")
                .and_then(Value::as_str)
                .and_then(RlmLedgerDeleteReason::from_wire)
            else {
                bail!("malformed RLM ledger line {line_no}: invalid delete record");
            };
            // The post-settlement amendment record carries the deleted
            // child's captured own usage. Old readers skip unknown fields,
            // so the snapshot rides the delete record without a version
            // bump; a present-but-malformed snapshot is a corrupt record.
            let usage = match record.get("usage") {
                None => None,
                Some(usage) => Some(parse_deleted_usage(usage, line_no)?),
            };
            Ok(Some(LedgerRecord::Delete {
                child_id,
                child,
                reason,
                usage,
            }))
        }
        _ => Ok(None),
    }
}

/// The replayed edge set: replay order plus a key index for record joins.
#[derive(Debug, Default, Clone)]
struct ReplayState {
    edges: Vec<RlmLedgerEdge>,
    index: HashMap<String, usize>,
}

fn edge_key(child_id: &str, child: &str) -> String {
    format!(
        "{child_id}\u{0}{}",
        canonical_session_path(Path::new(child)).to_string_lossy()
    )
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
    canonical_sessions_dir: PathBuf,
    seed_attempted: AtomicBool,
    cache: Mutex<Option<ReplaySnapshot>>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

#[derive(Debug)]
struct ReplaySnapshot {
    identity: FileIdentity,
    state: ReplayState,
}

#[derive(Debug, PartialEq, Eq, Clone)]
struct FileIdentity {
    size: u64,
    mtime: Option<std::time::SystemTime>,
    #[cfg(unix)]
    ino: Option<u64>,
}

/// Resolve a path lexically (`.`/`..` folded) against the current dir.
fn resolve_path(dir: &Path) -> PathBuf {
    use std::path::Component;
    let joined = if dir.is_absolute() {
        dir.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(dir)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonicalize a directory: realpath when it exists, plain resolve otherwise.
fn canonicalize_dir(dir: &Path) -> PathBuf {
    let resolved = resolve_path(dir);
    resolved.canonicalize().unwrap_or(resolved)
}

/// Ledger path for one sessions dir (TS `rlmLedgerPath`): a 16-hex sha256 of
/// the canonical sessions dir under `<agent-dir>/rlm-ledger/`.
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
    pub fn append_spawn(&self, input: RlmSpawnInput) -> Result<()> {
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
        self.append_record(json!({
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
    pub fn append_rename(&self, child_id: &str, child: &str, name: &str) -> Result<()> {
        let child_path = canonical_session_path(Path::new(child));
        self.append_record(json!({
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
    pub fn append_rename_by_child_path(&self, child: &str, name: &str) -> Result<()> {
        let target = canonical_session_path(Path::new(child));
        let state = self.replay_cached()?;
        for edge in &state.edges {
            if edge.deleted.is_none() && canonical_session_path(Path::new(&edge.child)) == target {
                self.append_record(json!({
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
    pub fn append_delete(
        &self,
        child_id: &str,
        child: &str,
        reason: RlmLedgerDeleteReason,
    ) -> Result<()> {
        let child_path = canonical_session_path(Path::new(child));
        self.append_record(json!({
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
    pub fn append_delete_with_usage(
        &self,
        child_id: &str,
        child: &str,
        reason: RlmLedgerDeleteReason,
        usage: &crate::session_usage::SessionUsageSummary,
    ) -> Result<()> {
        let child_path = canonical_session_path(Path::new(child));
        let usage = serde_json::to_value(usage)
            .with_context(|| "serialize the deleted child usage snapshot")?;
        self.append_record(json!({
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
                    self.append_delete_with_usage(&edge.child_id, &edge.child, reason, usage)?
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
    /// (their own rows carry their spend); the first tombstoned edge claims
    /// a path (a raced ledger must not bill one child to two parents); the
    /// fold is an iterative post-order walk (a pathological chain must not
    /// overflow the stack) that reads each tombstoned child's captured own
    /// usage first and falls back to the whole-file scan for legacy
    /// tombstones that predate the capture - a path with neither a snapshot
    /// nor a readable transcript is the documented historical gap (no
    /// fabricated backfill: zero).
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
            // A tombstoned path whose transcript still exists bills
            // through its own archived row (the RLM delete keeps the
            // file; the rollup sums the child row AND the parent
            // bucket, so reading both would double the spend): the
            // bucket is for files that are gone — the capture rides the
            // tombstone for the day the transcript dies.
            if Path::new(&edge.child).is_file() {
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
                None => crate::session_usage::read_own_usage_summary(Path::new(path))
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

    /// Live edges reconciled by stat: a dead parent or child drops the edge.
    pub fn live_edges(&self) -> Result<Vec<RlmLedgerEdge>> {
        self.seed_once()?;
        let state = self.replay_cached()?;
        Ok(state
            .edges
            .iter()
            .filter(|edge| {
                edge.deleted.is_none()
                    && is_file(Path::new(&edge.child))
                    && is_file(Path::new(&edge.parent))
            })
            .cloned()
            .collect())
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
        let Ok(content) = fs::read_to_string(&self.path) else {
            return Ok(ReplayState::default());
        };
        if content.len() as u64 > RLM_LEDGER_MAX_BYTES {
            bail!(
                "RLM ledger {} exceeds {RLM_LEDGER_MAX_BYTES} bytes; refusing to read",
                self.path.display()
            );
        }
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
            let Some(record) = parse_ledger_line(line, index)
                .with_context(|| format!("RLM ledger {}", self.path.display()))?
            else {
                self.log(&format!(
                    "RLM ledger: skipped record with unknown op on line {}",
                    index + 1
                ));
                continue;
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
                    match state.index.get(&key).copied() {
                        Some(at) => {
                            state.edges[at] = RlmLedgerEdge {
                                child_id,
                                parent,
                                child,
                                depth,
                                name,
                                deleted: None,
                                deleted_usage: None,
                            };
                        }
                        None => {
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
    fn append_record(&self, record: Value) -> Result<()> {
        self.seed_once()?;
        if let Some(parent) = self.path.parent() {
            crate::paths::ensure_dir(parent)?;
        }
        let mut line = serde_json::to_string(&record)?;
        line.push('\n');
        let mut file = OpenOptions::new()
            .create(true)
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
        let root_entries = match fs::read_dir(&self.canonical_sessions_dir) {
            Ok(entries) => entries,
            Err(_) => return Ok(()),
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

/// Resolve a rename/delete record whose canonical key does not join an edge
/// (a symlink retargeted after the record was written): a childId carried by
/// exactly one edge is the last durable identity they share.
fn sole_edge_by_child_id(state: &ReplayState, child_id: &str) -> Option<usize> {
    let mut sole: Option<usize> = None;
    for (at, edge) in state.edges.iter().enumerate() {
        if edge.child_id != child_id {
            continue;
        }
        if sole.is_some() {
            return None;
        }
        sole = Some(at);
    }
    sole
}

fn file_identity(path: &Path) -> Result<Option<FileIdentity>> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(None);
    };
    Ok(Some(FileIdentity {
        size: metadata.len(),
        mtime: metadata.modified().ok(),
        #[cfg(unix)]
        ino: {
            use std::os::unix::fs::MetadataExt;
            Some(metadata.ino())
        },
    }))
}

fn is_file(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

/// One legacy `rlm-subagents.jsonl` registry entry (the pre-ledger topology
/// store; still read for seeding and hydration metadata). The fields beyond
/// the edge (prompt, model, node ids) are display-grade.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRlmSubagentEntry {
    #[serde(default)]
    pub child_id: String,
    #[serde(default)]
    pub session_name: String,
    #[serde(default)]
    pub session_file: String,
    #[serde(default)]
    pub rlm_depth: u32,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub session_dir: String,
    #[serde(default)]
    pub parent_session_id: String,
    #[serde(default)]
    pub parent_session_file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rlm_parent_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(default)]
    pub created_at: u64,
}

/// The per-child display file (`rlm-subagent.json` in the child's session
/// dir): display-grade hydration metadata, never topology.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RlmSubagentDisplayEntry {
    /// Always `rlm_subagent`; a file of any other type is not a display
    /// entry and reads as absent.
    #[serde(default, rename = "type")]
    pub type_tag: String,
    #[serde(default)]
    pub child_id: String,
    #[serde(default)]
    pub session_name: String,
    #[serde(default)]
    pub session_dir: String,
    #[serde(default)]
    pub session_file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rlm_parent_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub created_at: u64,
}

/// Read one child's display entry; `None` when absent, unreadable, or not
/// describing the requested child (a stale file from a re-used session dir).
pub fn read_rlm_subagent_display(child_session_dir: &Path) -> Option<RlmSubagentDisplayEntry> {
    let content = fs::read_to_string(child_session_dir.join("rlm-subagent.json")).ok()?;
    let entry: RlmSubagentDisplayEntry = serde_json::from_str(&content).ok()?;
    if entry.type_tag != "rlm_subagent"
        || !matches!(entry.status.as_str(), "running" | "completed" | "deleted")
    {
        return None;
    }
    Some(entry)
}

/// Atomically write one child's display entry. A non-delete write over a
/// deletion tombstone is refused (the deleted child stays deleted), exactly
/// like the TS display writer.
pub fn write_rlm_subagent_display(entry: &RlmSubagentDisplayEntry) -> Result<bool> {
    if entry.status != "deleted"
        && read_rlm_subagent_display(Path::new(&entry.session_dir))
            .is_some_and(|current| current.status == "deleted")
    {
        return Ok(false);
    }
    let dir = Path::new(&entry.session_dir);
    fs::create_dir_all(dir)?;
    let payload = serde_json::to_string(entry)?;
    // TS `writeFileAtomicSync` temp naming (`${path}.${pid}.${uuid}.tmp`): a
    // unique temp per writer, so two processes writing the same display file
    // (a raced admission and its re-adoption) never share one temp.
    let temp = dir.join(format!(
        "rlm-subagent.json.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    // The temp carries the TS display writer's 0o600 mode; the rename
    // preserves it onto the final file.
    let mut options = fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    pa_core::platform::perms::set_private_mode(&mut options);
    let mut file = options.open(&temp)?;
    file.write_all(format!("{payload}\n").as_bytes())?;
    // TS `writeFileAtomicSync(..., { fsync: true })`: the temp is durable
    // before the rename, so a crash mid-write leaves a stale temp and the
    // previous file intact - never a half-written display state.
    file.sync_all()?;
    pa_core::platform::rename_onto(&temp, &dir.join("rlm-subagent.json"))
        .with_context(|| format!("persist rlm-subagent display at {}", dir.display()))?;
    Ok(true)
}

/// The legacy registry path for one parent session file (TS
/// `legacyRlmSubagentRegistryPath`): the parent's artifacts dir, keyed by
/// the session header id.
fn legacy_registry_path(session_file: &Path) -> Option<PathBuf> {
    let content = fs::read_to_string(session_file).ok()?;
    let header: Value = serde_json::from_str(content.lines().next()?).ok()?;
    let header_id = header.get("id")?.as_str()?;
    // TS `getSessionArtifactsRoot`: the artifacts tree is the sibling of
    // the session file's directory, keyed by the session header id.
    let artifacts_root = session_file.parent()?.parent()?.join("session-artifacts");
    Some(artifacts_root.join(header_id).join("rlm-subagents.jsonl"))
}

/// Tolerant reader for a per-parent legacy registry (TS
/// `readLegacyRlmSubagentRegistry`): latest entry per childId, malformed
/// lines ignored, a missing file an empty registry.
pub(crate) fn read_legacy_registry(session_file: &Path) -> Vec<LegacyRlmSubagentEntry> {
    let Some(registry) = legacy_registry_path(session_file) else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(&registry) else {
        return Vec::new();
    };
    let mut latest: HashMap<String, LegacyRlmSubagentEntry> = HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<LegacyRlmSubagentEntry>(trimmed) else {
            continue;
        };
        if entry.child_id.is_empty()
            || entry.session_file.is_empty()
            || !matches!(entry.status.as_str(), "running" | "completed" | "deleted")
        {
            continue;
        }
        latest.insert(entry.child_id.clone(), entry);
    }
    latest.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-ledger-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ledger_for(dir: &Path) -> RlmSpawnLedger {
        RlmSpawnLedger::new(dir, &dir.join("sessions"), |_| {})
    }

    #[test]
    fn ledger_path_hashes_the_canonical_sessions_dir() {
        let dir = temp_dir("path");
        let a = rlm_ledger_path(&dir, &dir.join("sessions"));
        let b = rlm_ledger_path(&dir, &dir.join("sessions/../sessions"));
        assert_eq!(a, b);
        assert!(a.to_string_lossy().contains(RLM_LEDGER_DIR));
        let c = rlm_ledger_path(&dir, &dir.join("other"));
        assert_ne!(a, c);
    }

    #[test]
    fn spawn_rename_delete_replay_in_order() {
        let dir = temp_dir("replay");
        let ledger = ledger_for(&dir);
        let parent = dir.join("parent.jsonl");
        let child = dir.join("child.jsonl");
        fs::write(&parent, "{\"type\":\"session\",\"id\":\"p\"}").unwrap();
        fs::write(&child, "{\"type\":\"session\",\"id\":\"c\"}").unwrap();
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "sub-1".into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "worker".into(),
            })
            .unwrap();
        ledger
            .append_rename("sub-1", &child.to_string_lossy(), "renamed")
            .unwrap();
        let edges = ledger.edges(false).unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].name, "renamed");
        assert_eq!(edges[0].depth, 1);
        assert!(ledger.live_edges().unwrap().len() == 1);
        ledger
            .append_delete(
                "sub-1",
                &child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
            )
            .unwrap();
        assert!(ledger.edges(false).unwrap().is_empty());
        let tombstones = ledger.edges(true).unwrap();
        assert_eq!(tombstones.len(), 1);
        assert_eq!(tombstones[0].deleted, Some(RlmLedgerDeleteReason::User));
        // The stat guard serves the same replay until the file changes.
        assert_eq!(ledger.edges(true).unwrap(), tombstones);
    }

    #[test]
    fn dead_child_or_parent_drops_from_live_edges() {
        let dir = temp_dir("live");
        let ledger = ledger_for(&dir);
        let parent = dir.join("p.jsonl");
        let child = dir.join("c.jsonl");
        fs::write(&parent, "{}").unwrap();
        fs::write(&child, "{}").unwrap();
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "sub-1".into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "w".into(),
            })
            .unwrap();
        assert_eq!(ledger.live_edges().unwrap().len(), 1);
        fs::remove_file(&child).unwrap();
        assert!(ledger.live_edges().unwrap().is_empty());
        // The edge stays in the raw replay.
        assert_eq!(ledger.edges(false).unwrap().len(), 1);
    }

    #[test]
    fn duplicate_child_path_and_bad_records_fail_loudly() {
        let dir = temp_dir("dup");
        let ledger = ledger_for(&dir);
        let parent = dir.join("p.jsonl");
        let child = dir.join("c.jsonl");
        fs::write(&parent, "{}").unwrap();
        fs::write(&child, "{}").unwrap();
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "sub-1".into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "w".into(),
            })
            .unwrap();
        let duplicate = ledger.append_spawn(RlmSpawnInput {
            child_id: "sub-2".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 1,
            name: "w".into(),
        });
        assert!(duplicate.is_err());
        let depth_zero = ledger.append_spawn(RlmSpawnInput {
            child_id: "sub-3".into(),
            parent: parent.to_string_lossy().into(),
            child: child.to_string_lossy().into(),
            depth: 0,
            name: "w".into(),
        });
        assert!(depth_zero.is_err());
        // A malformed record corrupts topology: the read fails closed.
        let path = ledger.ledger_path().to_path_buf();
        let mut content = fs::read_to_string(&path).unwrap();
        content.push_str("{\"v\":1,\"op\":\"spawn\"}\n");
        fs::write(&path, content).unwrap();
        assert!(ledger.edges(false).is_err());
    }

    #[test]
    fn unknown_op_records_are_skipped_forward_compatible() {
        let dir = temp_dir("fwd");
        let ledger = ledger_for(&dir);
        let path = ledger.ledger_path().to_path_buf();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let parent = dir.join("p.jsonl");
        fs::write(&parent, "{}").unwrap();
        fs::write(
            &path,
            format!(
                "{{\"v\":1,\"op\":\"meta\",\"at\":\"t\",\"sessionsDir\":\"x\"}}\n\
                 {{\"v\":1,\"op\":\"future\",\"at\":\"t\"}}\n\
                 {{\"v\":1,\"op\":\"spawn\",\"at\":\"t\",\"childId\":\"sub-1\",\"parent\":\"{}\",\"child\":\"{}\",\"depth\":1,\"name\":\"w\"}}\n",
                parent.to_string_lossy(),
                parent.to_string_lossy().replace("p.jsonl", "c.jsonl"),
            ),
        )
        .unwrap();
        let edges = ledger.edges(false).unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].child_id, "sub-1");
    }

    #[test]
    fn seeds_from_legacy_registries_once_and_atomically() {
        let dir = temp_dir("seed");
        let sessions = dir.join("sessions");
        let artifacts = dir.join("session-artifacts").join("p1");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&artifacts).unwrap();
        let parent = sessions.join("p1.jsonl");
        fs::write(
            &parent,
            "{\"type\":\"session\",\"id\":\"p1\",\"cwd\":\"/x\"}",
        )
        .unwrap();
        let child = dir.join("child.jsonl");
        fs::write(&child, "{}").unwrap();
        fs::write(
            artifacts.join("rlm-subagents.jsonl"),
            format!(
                "{{\"type\":\"rlm_subagent\",\"childId\":\"sub-9\",\"sessionName\":\"w\",\"sessionFile\":\"{}\",\"rlmDepth\":1,\"status\":\"completed\",\"createdAt\":1}}\n",
                child.to_string_lossy()
            ),
        )
        .unwrap();
        let ledger = ledger_for(&dir);
        let edges = ledger.edges(false).unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].child_id, "sub-9");
        assert_eq!(edges[0].depth, 1);
        assert_eq!(
            edges[0].parent,
            canonical_session_path(&parent)
                .to_string_lossy()
                .to_string()
        );
        // The seed file carries the meta header first.
        let content = fs::read_to_string(ledger.ledger_path()).unwrap();
        let first = content.lines().next().unwrap();
        assert!(first.contains("\"op\":\"meta\""));
    }

    #[test]
    fn display_entries_round_trip_and_tombstones_stick() {
        let dir = temp_dir("display");
        let child_dir = dir.join("sub-1");
        fs::create_dir_all(&child_dir).unwrap();
        let entry = RlmSubagentDisplayEntry {
            type_tag: "rlm_subagent".into(),
            child_id: "sub-1".into(),
            session_name: "w".into(),
            session_dir: child_dir.to_string_lossy().into(),
            session_file: dir.join("c.jsonl").to_string_lossy().into(),
            rlm_parent_node_id: None,
            prompt: Some("do work".into()),
            spawn_code: None,
            model: Some(json!({"provider": "p", "modelId": "m"})),
            status: "running".into(),
            created_at: 1,
        };
        assert!(write_rlm_subagent_display(&entry).unwrap());
        let read = read_rlm_subagent_display(&child_dir).unwrap();
        assert_eq!(read.child_id, "sub-1");
        assert_eq!(read.prompt.as_deref(), Some("do work"));
        let mut tombstone = entry.clone();
        tombstone.status = "deleted".into();
        assert!(write_rlm_subagent_display(&tombstone).unwrap());
        // A resurrection write is refused over a tombstone.
        assert!(!write_rlm_subagent_display(&entry).unwrap());
    }

    #[test]
    fn display_entry_file_is_owner_only() {
        let dir = temp_dir("display-mode");
        let child_dir = dir.join("sub-1");
        fs::create_dir_all(&child_dir).unwrap();
        let entry = RlmSubagentDisplayEntry {
            type_tag: "rlm_subagent".into(),
            child_id: "sub-1".into(),
            session_name: "w".into(),
            session_dir: child_dir.to_string_lossy().into(),
            session_file: dir.join("c.jsonl").to_string_lossy().into(),
            rlm_parent_node_id: None,
            prompt: None,
            spawn_code: None,
            model: None,
            status: "running".into(),
            created_at: 1,
        };
        assert!(write_rlm_subagent_display(&entry).unwrap());
        // The TS display writer creates its temp 0o600; the rename carries
        // that mode onto the visible file.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(child_dir.join("rlm-subagent.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    fn usage_summary(cost: f64) -> crate::session_usage::SessionUsageSummary {
        crate::session_usage::SessionUsageSummary {
            input_tokens: 1_000,
            output_tokens: 100,
            cost,
        }
    }

    /// One assistant row with billable usage (the scan's only foldable
    /// row shape).
    fn assistant_usage_row(id: &str, cost: f64) -> String {
        serde_json::json!({
            "type": "message",
            "id": id,
            "message": {
                "role": "assistant",
                "usage": {
                    "input": 1_000,
                    "output": 100,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 1_100,
                    "cost": { "input": cost, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": cost }
                }
            }
        })
        .to_string()
    }

    /// The deletion amendment's snapshot rides the delete record, merges
    /// into the same tombstoned edge, and survives an idempotent
    /// re-tombstone (sticky) until a fresh capture replaces it.
    #[test]
    fn delete_amendment_carries_the_usage_snapshot() {
        let dir = temp_dir("amendment");
        let ledger = ledger_for(&dir);
        let parent = dir.join("parent.jsonl");
        let child = dir.join("child.jsonl");
        fs::write(&parent, "{}").unwrap();
        fs::write(&child, "{}").unwrap();
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "sub-1".into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "w".into(),
            })
            .unwrap();
        ledger
            .append_delete(
                "sub-1",
                &child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
            )
            .unwrap();
        // No capture yet: the tombstone predates the settlement barrier.
        assert_eq!(
            ledger.edges(true).unwrap()[0].deleted_usage,
            None,
            "a bare tombstone carries no snapshot"
        );
        ledger
            .append_delete_with_usage(
                "sub-1",
                &child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
                &usage_summary(0.40),
            )
            .unwrap();
        let edges = ledger.edges(true).unwrap();
        assert_eq!(edges.len(), 1, "the amendment merges into the one edge");
        assert_eq!(edges[0].deleted, Some(RlmLedgerDeleteReason::User));
        assert_eq!(edges[0].deleted_usage, Some(usage_summary(0.40)));
        // A re-tombstone without usage never clears a captured snapshot.
        ledger
            .append_delete(
                "sub-1",
                &child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
            )
            .unwrap();
        assert_eq!(
            ledger.edges(true).unwrap()[0].deleted_usage,
            Some(usage_summary(0.40)),
            "the snapshot is sticky across re-tombstones"
        );
        // A retried capture replaces it (last writer wins).
        ledger
            .append_delete_with_usage(
                "sub-1",
                &child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
                &usage_summary(0.45),
            )
            .unwrap();
        assert_eq!(
            ledger.edges(true).unwrap()[0].deleted_usage,
            Some(usage_summary(0.45))
        );
    }

    /// A bulk path tombstone (the saved-session delete) carries the
    /// captured usage onto every edge at the path.
    #[test]
    fn tombstone_child_path_with_usage_snapshots_every_edge() {
        let dir = temp_dir("path-usage");
        let ledger = ledger_for(&dir);
        let parent = dir.join("parent.jsonl");
        let child = dir.join("child.jsonl");
        fs::write(&parent, "{}").unwrap();
        fs::write(&child, "{}").unwrap();
        for child_id in ["sub-1", "sub-2"] {
            ledger
                .append_spawn(RlmSpawnInput {
                    child_id: child_id.into(),
                    parent: parent.to_string_lossy().into(),
                    child: child.to_string_lossy().into(),
                    depth: 1,
                    name: "w".into(),
                })
                .unwrap();
            ledger
                .append_delete(
                    child_id,
                    &child.to_string_lossy(),
                    RlmLedgerDeleteReason::User,
                )
                .unwrap();
        }
        let edges = ledger
            .tombstone_child_path_with_usage(
                &child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
                Some(&usage_summary(0.30)),
            )
            .unwrap();
        assert_eq!(edges.len(), 2);
        for edge in ledger.edges(true).unwrap() {
            assert_eq!(edge.deleted_usage, Some(usage_summary(0.30)));
        }
    }

    /// The deleted-descendant bucket: the numeric fixture (own $0 + deleted
    /// child $0.40 + its deleted grandchild $0.10 + live child $0.20 +
    /// surviving grandchild $0.30 => the parent's bucket $0.50, and the
    /// agents-view subtree total $1.00 once the live descendant rows add
    /// their own spend). The snapshots are OWN-ONLY: a snapshot that wrongly
    /// carried the child's aggregate (its own + its attributed grandchild)
    /// would double count the deleted grandchild into $0.60.
    #[test]
    fn bucket_folds_own_snapshots_post_order_without_double_counting() {
        let dir = temp_dir("bucket-fixture");
        let ledger = ledger_for(&dir);
        let sessions = dir.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let parent = sessions.join("p.jsonl");
        let child_1 = sessions.join("c1.jsonl");
        let grandchild_1 = sessions.join("gc1.jsonl");
        let child_2 = sessions.join("c2.jsonl");
        let grandchild_2 = sessions.join("gc2.jsonl");
        for (path, cost) in [
            (&parent, 0.0),
            (&child_1, 0.40),
            (&grandchild_1, 0.10),
            (&child_2, 0.20),
            (&grandchild_2, 0.30),
        ] {
            fs::write(path, assistant_usage_row("m1", cost)).unwrap();
        }
        let spawn = |child_id: &str, parent: &Path, child: &Path, depth: u32| {
            ledger
                .append_spawn(RlmSpawnInput {
                    child_id: child_id.into(),
                    parent: parent.to_string_lossy().into(),
                    child: child.to_string_lossy().into(),
                    depth,
                    name: "w".into(),
                })
                .unwrap();
        };
        spawn("c1", &parent, &child_1, 1);
        spawn("gc1", &child_1, &grandchild_1, 2);
        spawn("c2", &parent, &child_2, 1);
        spawn("gc2", &child_2, &grandchild_2, 2);
        // The deleted child's own spend is 0.40 even though its file also
        // carries the deleted grandchild's attribution (total 0.50): the
        // capture reads own, never the aggregate.
        ledger
            .append_delete_with_usage(
                "c1",
                &child_1.to_string_lossy(),
                RlmLedgerDeleteReason::User,
                &usage_summary(0.40),
            )
            .unwrap();
        ledger
            .append_delete_with_usage(
                "gc1",
                &grandchild_1.to_string_lossy(),
                RlmLedgerDeleteReason::User,
                &usage_summary(0.10),
            )
            .unwrap();
        // The tombstoned children's transcripts are gone (a delete that
        // leaves the file alive rides the row — the bucket is for files
        // that died).
        fs::remove_file(&child_1).unwrap();
        fs::remove_file(&grandchild_1).unwrap();
        // The live child subtree never enters the bucket.
        let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
        let parent_key = crate::lease::canonical_session_path(&parent)
            .to_string_lossy()
            .to_string();
        let child_key = crate::lease::canonical_session_path(&child_1)
            .to_string_lossy()
            .to_string();
        let deleted = bucket
            .get(&parent_key)
            .expect("the parent bills its deleted descendants");
        assert!(
            (deleted.cost - 0.50).abs() < 1e-9,
            "own 0.40 + deleted grandchild 0.10 = 0.50, got {}",
            deleted.cost
        );
        // TS `usageByParent` also keys the tombstoned intermediate parent
        // (its grandchild's fold) - inert: no row exists at a tombstoned
        // child's path to consume it. Live descendants never enter.
        assert!(
            (bucket.get(&child_key).map(|d| d.cost).unwrap_or(0.0) - 0.10).abs() < 1e-9,
            "the tombstoned intermediate keeps its inert TS key"
        );
        assert_eq!(bucket.len(), 2, "live descendants contribute no bucket");
        // The regression pin: a snapshot carrying the child's aggregate
        // (0.50 instead of own 0.40) double counts the grandchild.
        let mut ledger_lines: Vec<String> = fs::read_to_string(ledger.ledger_path())
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        let amend = ledger_lines
            .iter()
            .position(|line| line.contains("\"childId\":\"c1\"") && line.contains("\"usage\""))
            .expect("the c1 amendment");
        ledger_lines[amend] = ledger_lines[amend].replace("\"cost\":0.4}", "\"cost\":0.5}");
        fs::write(ledger.ledger_path(), ledger_lines.join("\n") + "\n").unwrap();
        let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
        let over_billed = bucket.get(&parent_key).unwrap().cost;
        assert!(
            (over_billed - 0.60).abs() < 1e-9,
            "an aggregate snapshot double counts the deleted grandchild: {over_billed}"
        );
    }

    /// Legacy tombstones (pre-capture): a live transcript rides its own
    /// row (the bucket never claims a live file — billing both would
    /// double the spend); once the transcript is gone the documented
    /// historical gap bills zero — never a fabricated number.
    #[test]
    fn bucket_legacy_tombstones_fall_back_then_gap_to_zero() {
        let dir = temp_dir("bucket-legacy");
        let ledger = ledger_for(&dir);
        let sessions = dir.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let parent = sessions.join("p.jsonl");
        let child = sessions.join("c.jsonl");
        fs::write(&parent, "{}").unwrap();
        fs::write(&child, assistant_usage_row("m1", 0.25)).unwrap();
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "sub-1".into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "w".into(),
            })
            .unwrap();
        ledger
            .append_delete(
                "sub-1",
                &child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
            )
            .unwrap();
        let parent_key = crate::lease::canonical_session_path(&parent)
            .to_string_lossy()
            .to_string();
        // A tombstoned path whose transcript still exists rides its own
        // archived row (the rollup sums the row AND the parent bucket, so
        // billing both would double the spend) — the bucket never claims
        // a live file, legacy tombstone or not.
        let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
        assert!(
            !bucket.contains_key(&parent_key),
            "a live transcript rides its own row, not the bucket"
        );
        // The transcript goes (a saved-session delete, a cleanup): no
        // snapshot, no file, no spend — the gap is zero, not invented.
        fs::remove_file(&child).unwrap();
        let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
        assert!(
            !bucket.contains_key(&parent_key),
            "the historical gap bills nothing"
        );
    }

    /// A raced ledger claims each tombstoned path once (first writer wins):
    /// one child path billed to two parents would double the spend.
    #[test]
    fn bucket_claims_each_tombstoned_path_once() {
        let dir = temp_dir("bucket-claim");
        let sessions = dir.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let parent_a = sessions.join("pa.jsonl");
        let parent_b = sessions.join("pb.jsonl");
        let child = sessions.join("c.jsonl");
        for path in [&parent_a, &parent_b] {
            fs::write(path, "{}").unwrap();
        }
        fs::write(&child, assistant_usage_row("m1", 0.15)).unwrap();
        // A corrupt raced ledger: two edges for one child path under two
        // parents, both tombstoned. Hand-written records — the append API
        // refuses the live duplicate path.
        let lines = [
            json!({
                "v": 1, "op": "spawn", "at": "2026-01-01T00:00:00Z",
                "childId": "x1", "parent": parent_a.to_string_lossy(),
                "child": child.to_string_lossy(), "depth": 1, "name": "w",
            }),
            json!({
                "v": 1, "op": "delete", "at": "2026-01-01T00:00:01Z",
                "childId": "x1", "child": child.to_string_lossy(), "reason": "user",
            }),
            json!({
                "v": 1, "op": "spawn", "at": "2026-01-01T00:00:02Z",
                "childId": "x2", "parent": parent_b.to_string_lossy(),
                "child": child.to_string_lossy(), "depth": 1, "name": "w",
            }),
            json!({
                "v": 1, "op": "delete", "at": "2026-01-01T00:00:03Z",
                "childId": "x2", "child": child.to_string_lossy(), "reason": "user",
            }),
        ];
        let body: String = lines.iter().map(|line| format!("{line}\n")).collect();
        let path = rlm_ledger_path(&dir, &sessions);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        let ledger = ledger_for(&dir);
        // The raced child's transcript is gone (the bucket is for files
        // that died — a live file rides its own row).
        fs::remove_file(&child).unwrap();
        let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
        let key_a = crate::lease::canonical_session_path(&parent_a)
            .to_string_lossy()
            .to_string();
        let key_b = crate::lease::canonical_session_path(&parent_b)
            .to_string_lossy()
            .to_string();
        assert!(
            bucket.contains_key(&key_a),
            "the first tombstone claims the path"
        );
        assert!(
            !bucket.contains_key(&key_b),
            "the second parent never bills the same path"
        );
    }

    /// A recreated path is live: its old tombstone never bills spend that
    /// the new live child's own row carries.
    #[test]
    fn bucket_skips_recreated_live_paths() {
        let dir = temp_dir("bucket-live");
        let ledger = ledger_for(&dir);
        let sessions = dir.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let parent = sessions.join("p.jsonl");
        let child = sessions.join("c.jsonl");
        fs::write(&parent, "{}").unwrap();
        fs::write(&child, "{}").unwrap();
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "old".into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "w".into(),
            })
            .unwrap();
        ledger
            .append_delete_with_usage(
                "old",
                &child.to_string_lossy(),
                RlmLedgerDeleteReason::User,
                &usage_summary(0.20),
            )
            .unwrap();
        // A fresh child spawns at the same path: the path is live again.
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "new".into(),
                parent: parent.to_string_lossy().into(),
                child: child.to_string_lossy().into(),
                depth: 1,
                name: "w2".into(),
            })
            .unwrap();
        let bucket = ledger.deleted_descendant_usage_by_parent().unwrap();
        assert!(bucket.is_empty(), "a live path never bills the bucket");
    }
}
