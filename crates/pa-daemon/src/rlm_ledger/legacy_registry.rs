//! The legacy subagent topology surface: the pre-ledger per-parent
//! registry reader with its bounded header-line probe.
use super::{fs, Deserialize, HashMap, Path, PathBuf, Serialize, Value};

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

/// The bounded header read cap for the legacy registry probe: the header id rides the file's first
/// line, so the read stays bounded; a first line longer than the cap reads as absent.
pub(super) const LEGACY_REGISTRY_HEADER_READ_MAX_BYTES: usize = 64 * 1024;

/// The legacy registry path for one parent session file: the parent's
/// artifacts dir, keyed by the session header id. The probe stays bounded
/// — the passive walk probes every parent once, so a whole-file read
/// would be linear in transcript bytes.
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

/// Tolerant reader for a per-parent legacy registry (TS `readLegacyRlmSubagentRegistry`): latest
/// entry per childId, malformed lines ignored, a missing file an empty registry.
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
