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

use std::collections::HashMap;
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RlmLedgerEdge {
    pub child_id: String,
    pub parent: String,
    pub child: String,
    pub depth: u32,
    pub name: String,
    pub deleted: Option<RlmLedgerDeleteReason>,
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
    },
}

fn str_field(record: &Value, key: &str) -> Option<String> {
    record.get(key).and_then(Value::as_str).map(str::to_string)
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
            Ok(Some(LedgerRecord::Delete {
                child_id,
                child,
                reason,
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
    agent_dir: PathBuf,
    canonical_sessions_dir: PathBuf,
    seed_attempted: AtomicBool,
    cache: Mutex<Option<ReplaySnapshot>>,
    log: Box<dyn Fn(&str) + Send + Sync>,
}

/// One `live_edges` liveness pass: a recorded path that stats resolves as
/// itself; a recorded path whose file moved resolves through its durable
/// session id (the file-name stem) against the sessions dir and the
/// session-artifacts tree the port writes. The per-pass cache keeps the
/// artifact walk to at most one pass per ledger read.
struct LivePathResolver {
    agent_dir: PathBuf,
    sessions_dir: PathBuf,
    resolved: HashMap<String, Option<PathBuf>>,
    artifact_index: Option<HashMap<String, PathBuf>>,
}

impl LivePathResolver {
    fn new(agent_dir: PathBuf, sessions_dir: PathBuf) -> Self {
        LivePathResolver {
            agent_dir,
            sessions_dir,
            resolved: HashMap::new(),
            artifact_index: None,
        }
    }

    /// The live session file for one recorded edge path, `None` when the
    /// session is gone everywhere (the edge endpoint is dead).
    fn resolve(&mut self, recorded: &str) -> Option<PathBuf> {
        if let Some(hit) = self.resolved.get(recorded) {
            return hit.clone();
        }
        let live = self.resolve_uncached(recorded);
        self.resolved.insert(recorded.to_string(), live.clone());
        live
    }

    fn resolve_uncached(&mut self, recorded: &str) -> Option<PathBuf> {
        let recorded_path = Path::new(recorded);
        if is_file(recorded_path) {
            return Some(recorded_path.to_path_buf());
        }
        let id = recorded_path.file_stem()?.to_string_lossy().to_string();
        if id.is_empty() {
            return None;
        }
        let sessions_candidate = self.sessions_dir.join(format!("{id}.jsonl"));
        if is_file(&sessions_candidate) {
            return Some(sessions_candidate);
        }
        let index = self
            .artifact_index
            .get_or_insert_with(|| artifact_session_index(&self.agent_dir));
        index.get(&id).cloned()
    }
}

/// The session files under the artifacts tree, keyed by their durable
/// session id (the file-name stem): `<agent-dir>/session-artifacts/
/// <parent-session-id>/sub-<id>/<child>.jsonl`, one level per session id.
/// Non-session `.jsonl` sidecars (semantic edges, harness state) key by
/// their own stems and never collide with session-id lookups.
fn artifact_session_index(agent_dir: &Path) -> HashMap<String, PathBuf> {
    let mut index = HashMap::new();
    let root = agent_dir.join(crate::context_tree_children::RLM_SESSION_ARTIFACTS_DIR);
    let Ok(parents) = std::fs::read_dir(&root) else {
        return index;
    };
    for parent in parents.flatten() {
        let Ok(subs) = std::fs::read_dir(parent.path()) else {
            continue;
        };
        for sub in subs.flatten() {
            let Ok(files) = std::fs::read_dir(sub.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                    if let Some(stem) = path.file_stem() {
                        index.insert(stem.to_string_lossy().to_string(), path);
                    }
                }
            }
        }
    }
    index
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

    /// Tombstone every edge for one child session path (a path may hold
    /// duplicate edges from raced or corrupt appends; a live one would
    /// resurrect a later recreation at that path as a subagent).
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

    /// Live edges reconciled by liveness of their recorded endpoints: a
    /// parent or child whose session file no longer exists drops the
    /// edge. A recorded path whose file MOVED (a storage-root migration,
    /// an artifacts re-parenting) resolves through its durable session id
    /// first — the sessions dir and the session-artifacts tree hold the
    /// same session under a different root — and the returned edge
    /// carries the resolved path, so a restart-era child never anchors to
    /// a stale path. Only a session with no live file anywhere is dead.
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
                } => {
                    let key = edge_key(&child_id, &child);
                    let at = match state.index.get(&key).copied() {
                        Some(at) => Some(at),
                        None => sole_edge_by_child_id(&state, &child_id),
                    };
                    if let Some(at) = at {
                        state.edges[at].deleted = Some(reason);
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

    /// A ledger over an explicit agent dir and sessions dir (the artifact
    /// tree roots under the agent dir).
    fn ledger_over(agent_dir: &Path, sessions_dir: &Path) -> RlmSpawnLedger {
        RlmSpawnLedger::new(agent_dir, sessions_dir, |_| {})
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

    /// A recorded edge path whose file moved (a storage-root migration)
    /// resolves through its durable session id — the sessions dir or the
    /// session-artifacts tree — and the returned edge carries the
    /// resolved path; a session with no file anywhere stays dead.
    #[test]
    fn moved_edge_paths_resolve_through_the_session_id() {
        let agent_dir = temp_dir("agent");
        let sessions_dir = agent_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let ledger = ledger_over(&agent_dir, &sessions_dir);

        // The parent moved: recorded under an old root, now resident in
        // the artifacts tree; the child moved into the sessions dir.
        let recorded_parent = "/old-root/sessions/sess-p.jsonl";
        let recorded_child = "/old-root/session-artifacts/sess-p/sub-1/sess-c.jsonl";
        let live_parent = agent_dir
            .join("session-artifacts")
            .join("sess-g")
            .join("sub-9")
            .join("sess-p.jsonl");
        let live_child = sessions_dir.join("sess-c.jsonl");
        fs::create_dir_all(live_parent.parent().unwrap()).unwrap();
        fs::write(&live_parent, "{}").unwrap();
        fs::write(&live_child, "{}").unwrap();
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: "sub-1".into(),
                parent: recorded_parent.into(),
                child: recorded_child.into(),
                depth: 1,
                name: "w".into(),
            })
            .unwrap();

        let edges = ledger.live_edges().unwrap();
        assert_eq!(edges.len(), 1, "{edges:?}");
        // The resolved paths are canonicalized (the sessions dir the
        // resolver anchors to is canonical).
        let canonical = |path: &Path| -> String {
            crate::lease::canonical_session_path(path)
                .to_string_lossy()
                .to_string()
        };
        assert_eq!(
            edges[0].parent,
            canonical(&live_parent),
            "the parent edge resolves to the migrated path"
        );
        assert_eq!(
            edges[0].child,
            canonical(&live_child),
            "the child edge resolves to the migrated path"
        );

        // A session with no file anywhere is dead: the edge drops.
        fs::remove_file(&live_child).unwrap();
        assert!(ledger.live_edges().unwrap().is_empty());
        // The raw replay keeps the recorded paths untouched.
        let raw = ledger.edges(false).unwrap();
        assert_eq!(raw.len(), 1);
        assert_eq!(raw[0].parent, recorded_parent);
        assert_eq!(raw[0].child, recorded_child);
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
}
