//! The legacy subagent topology surfaces (moved with their concern):
//! the pre-ledger per-parent registry reader with its bounded
//! header-line probe, and the per-child display sidecar entry with
//! its atomic writer.
use std::io::Write as _;

use anyhow::Context as _;

use super::{fs, Deserialize, HashMap, Path, PathBuf, Result, Serialize, Value};

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
#[must_use]
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
///
/// # Errors
///
/// Returns an error when the display directory cannot be created, the
/// entry cannot be serialized, or the atomic temp write or rename onto
/// the display file fails; a refused write over a tombstone answers
/// `Ok(false)`.
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

/// The bounded header read cap for the legacy registry probe: the header
/// id the probe extracts rides the file's first line, so the read stays
/// bounded to a line instead of the parent transcript's whole bytes (a
/// multi-megabyte parent's registry probe must not read megabytes to
/// extract one id). A first line longer than the cap reads as absent -
/// the same judgment `read_first_line_bounded`'s callers make, and far
/// past any real session header (the 512-byte list gate's class).
pub(super) const LEGACY_REGISTRY_HEADER_READ_MAX_BYTES: usize = 64 * 1024;

/// The legacy registry path for one parent session file (TS
/// `legacyRlmSubagentRegistryPath`): the parent's artifacts dir, keyed by
/// the session header id. The id rides the file's first line, so the
/// probe reads that line bounded instead of the whole transcript: the
/// passive roster walk probes every live child's parent once per walk,
/// and the whole-file read made each catalog fetch linear in the
/// family's total transcript bytes (a deep tree of large parents re-read
/// every parent transcript per `list_saved_sessions`).
pub(super) fn legacy_registry_path(session_file: &Path) -> Option<PathBuf> {
    let line = crate::session_store::read_first_line_bounded(
        session_file,
        LEGACY_REGISTRY_HEADER_READ_MAX_BYTES,
    )?;
    let text = std::str::from_utf8(&line).ok()?;
    let header: Value = serde_json::from_str(text.trim()).ok()?;
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
