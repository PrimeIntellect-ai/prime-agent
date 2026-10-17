//! The RLM ledger's read-back machinery: the wire record grammar and its
//! line parser, the replay state and the stat-identity cache records, the
//! edge join keys, the path canonicalizers, and the `live_edges`
//! liveness resolver with its session-artifacts index.
use anyhow::Context as _;

use super::{
    bail, canonical_session_path, fs, json, Arc, HashMap, Mutex, OnceLock, Path, PathBuf, Result,
    RlmLedgerDeleteReason, RlmLedgerEdge, Value,
};

/// One replayed ledger record (`meta` records carry no edge and are skipped).
#[derive(Debug, Clone, PartialEq)]
pub(super) enum LedgerRecord {
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
/// record is rejected rather than billing a partial number.
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
/// else - which replay logs and skips: one bad line costs one record, never
/// the ledger.
pub(super) fn parse_ledger_line(line: &str, index: usize) -> Result<Option<LedgerRecord>> {
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
            if depth < 1 || depth > u64::from(u32::MAX) {
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
            // The amendment record carries the deleted child's captured
            // own usage; old readers skip unknown fields (no version bump).
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
#[derive(Debug, Default)]
pub(super) struct ReplayState {
    pub(super) edges: Vec<RlmLedgerEdge>,
    pub(super) index: HashMap<String, usize>,
    pub(super) artifact_index: OnceLock<Mutex<ArtifactIndex>>,
    pub(super) deleted_bucket: Mutex<Option<DeletedBucket>>,
}

/// Ledger rows are immutable within a replay, but file moves and transcript
/// edits can change the inputs of the deleted-spend fold without any append.
#[derive(Debug)]
pub(super) struct DeletedBucket {
    pub(super) inputs: Vec<Option<FileIdentity>>,
    pub(super) usage: HashMap<String, crate::session_usage::SessionUsageSummary>,
}

pub(super) fn edge_key(child_id: &str, child: &str) -> String {
    format!(
        "{child_id}\u{0}{}",
        canonical_session_path(Path::new(child)).to_string_lossy()
    )
}

/// One `live_edges` liveness pass: a recorded path that stats resolves
/// as itself; a moved file resolves through its durable session id (the
/// file-name stem) against the sessions dir and the artifacts tree.
pub(super) struct LivePathResolver<'a> {
    agent_dir: PathBuf,
    sessions_dir: PathBuf,
    pub(super) resolved: HashMap<String, Option<PathBuf>>,
    artifact_index: &'a OnceLock<Mutex<ArtifactIndex>>,
    artifact_checked: bool,
}

impl<'a> LivePathResolver<'a> {
    pub(super) fn new(
        agent_dir: PathBuf,
        sessions_dir: PathBuf,
        artifact_index: &'a OnceLock<Mutex<ArtifactIndex>>,
    ) -> Self {
        LivePathResolver {
            agent_dir,
            sessions_dir,
            resolved: HashMap::new(),
            artifact_index,
            artifact_checked: false,
        }
    }

    /// The live session file for one recorded edge path, `None` when the
    /// session is gone everywhere (the edge endpoint is dead).
    pub(super) fn resolve(&mut self, recorded: &str) -> Result<Option<PathBuf>> {
        if let Some(hit) = self.resolved.get(recorded) {
            return Ok(hit.clone());
        }
        let live = self.resolve_uncached(recorded)?;
        self.resolved.insert(recorded.to_string(), live.clone());
        Ok(live)
    }

    fn resolve_uncached(&mut self, recorded: &str) -> Result<Option<PathBuf>> {
        let recorded_path = Path::new(recorded);
        if is_file(recorded_path) {
            return Ok(Some(recorded_path.to_path_buf()));
        }
        let Some(stem) = recorded_path.file_stem() else {
            return Ok(None);
        };
        let id = stem.to_string_lossy();
        if id.is_empty() {
            return Ok(None);
        }
        let sessions_candidate = self.sessions_dir.join(format!("{id}.jsonl"));
        if is_file(&sessions_candidate) {
            return Ok(Some(sessions_candidate));
        }
        let mut index = self
            .artifact_index
            .get_or_init(|| Mutex::new(artifact_session_index(&self.agent_dir)))
            .lock()
            .map_err(|_| anyhow::anyhow!("artifact index cache lock poisoned"))?;
        // Directory identities cover additions, deletion and relocation, including
        // new partitions. Check once per read; unchanged misses retain the shared
        // negative result instead of enumerating every artifact file again.
        if !self.artifact_checked {
            if index
                .directories
                .iter()
                .any(|(path, identity)| path_identity(path) != *identity)
            {
                *index = artifact_session_index(&self.agent_dir);
            }
            self.artifact_checked = true;
        }
        Ok(index
            .paths
            .get(id.as_ref())
            .filter(|path| is_file(path))
            .cloned())
    }
}

#[derive(Debug, Default)]
pub(super) struct ArtifactIndex {
    paths: HashMap<String, PathBuf>,
    directories: Vec<(PathBuf, Option<FileIdentity>)>,
}

#[cfg(test)]
thread_local! {
    pub(super) static ARTIFACT_SCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The session files under the artifacts tree, keyed by their durable session id (the file-name
/// stem); non-session `.jsonl` sidecars key by their own stems and never collide.
fn artifact_session_index(agent_dir: &Path) -> ArtifactIndex {
    #[cfg(test)]
    ARTIFACT_SCANS.with(|count| count.set(count.get() + 1));
    let mut index = ArtifactIndex::default();
    let root = agent_dir.join(crate::context_tree_children::RLM_SESSION_ARTIFACTS_DIR);
    index.directories.push((root.clone(), path_identity(&root)));
    let Ok(parents) = std::fs::read_dir(&root) else {
        return index;
    };
    for parent in parents.flatten() {
        index
            .directories
            .push((parent.path(), path_identity(&parent.path())));
        let Ok(subs) = std::fs::read_dir(parent.path()) else {
            continue;
        };
        for sub in subs.flatten() {
            index
                .directories
                .push((sub.path(), path_identity(&sub.path())));
            let Ok(files) = std::fs::read_dir(sub.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                    if let Some(stem) = path.file_stem() {
                        index.paths.insert(stem.to_string_lossy().to_string(), path);
                    }
                }
            }
        }
    }
    index
}

#[derive(Debug)]
pub(super) struct ReplaySnapshot {
    pub(super) identity: FileIdentity,
    pub(super) state: Arc<ReplayState>,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub(super) struct FileIdentity {
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
pub(super) fn canonicalize_dir(dir: &Path) -> PathBuf {
    let resolved = resolve_path(dir);
    resolved.canonicalize().unwrap_or(resolved)
}

/// Resolve a rename/delete record whose canonical key does not join an edge
/// (a symlink retargeted after the record was written): a childId carried by
/// exactly one edge is the last durable identity they share.
pub(super) fn sole_edge_by_child_id(state: &ReplayState, child_id: &str) -> Option<usize> {
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

pub(super) fn file_identity(path: &Path) -> Result<Option<FileIdentity>> {
    Ok(path_identity(path))
}

fn path_identity(path: &Path) -> Option<FileIdentity> {
    let Ok(metadata) = fs::metadata(path) else {
        return None;
    };
    Some(FileIdentity {
        size: metadata.len(),
        mtime: metadata.modified().ok(),
        #[cfg(unix)]
        ino: {
            use std::os::unix::fs::MetadataExt;
            Some(metadata.ino())
        },
    })
}

pub(super) fn is_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file())
}
