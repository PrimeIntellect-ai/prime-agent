//! Continual harness state: entries, refinement events, persistence, merge,
//! history, and prompt rendering. Port of core/refinement/refinement.ts
//! (state half).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Refinement entry kinds (the continual harness component set).
pub const REFINEMENT_KINDS: [&str; 4] = ["prompt", "memory", "skill", "subagent"];

/// Directory name under the agent dir (or session artifact dir).
pub const HARNESS_STATE_DIR_NAME: &str = "harness";
/// Cross-session refinement history file name.
pub const REFINEMENT_HISTORY_FILE_NAME: &str = "refinement_history.jsonl";

/// Default overview limits (TS `DEFAULT_OVERVIEW_*` constants).
pub const DEFAULT_OVERVIEW_ENTRY_LIMIT: usize = 3;
pub const DEFAULT_OVERVIEW_REFINEMENT_LIMIT: usize = 10;
pub const DEFAULT_OVERVIEW_CONTENT_LIMIT: usize = 140;

/// Harness component kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefinementKind {
    Prompt,
    Memory,
    Skill,
    Subagent,
}

/// Edit action against a harness entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefinementAction {
    Create,
    Update,
    Delete,
}

/// Session scope of a harness entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessScope {
    Local,
    Global,
}

/// One editable continual harness entry. The TS entry schema keeps
/// `created_at`/`updated_at` snake-cased (the rest of the fields are
/// single words); the wire result and the saved state file both carry the
/// TS naming.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessEntry {
    pub id: String,
    pub kind: RefinementKind,
    pub title: String,
    pub content: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<HarnessScope>,
    pub reference: serde_json::Map<String, serde_json::Value>,
    #[serde(rename = "arguments")]
    pub arguments: serde_json::Map<String, serde_json::Value>,
    pub metadata: serde_json::Map<String, serde_json::Value>,
    pub source: String,
    #[serde(rename = "created_at")]
    pub created_at: String,
    #[serde(rename = "updated_at")]
    pub updated_at: String,
    pub version: u64,
}

/// One refinement event record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRefinementEvent {
    pub id: String,
    pub trigger: String,
    pub changes: Vec<String>,
    pub evidence: String,
    pub outcome: String,
    /// The TS event schema keeps the snake-cased `created_at` (the rest of
    /// the fields are single words).
    #[serde(rename = "created_at")]
    pub created_at: String,
}

/// The persisted continual harness state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HarnessState {
    pub schema: u64,
    /// Entries keyed by kind, then id. Ordered (`BTreeMap`): the state
    /// serializes to the on-disk harness JSON, and unordered iteration
    /// would write random key order (and churn the file between runs).
    pub entries: BTreeMap<RefinementKind, BTreeMap<String, HarnessEntry>>,
    pub refinements: Vec<HarnessRefinementEvent>,
}

pub fn empty_harness_state() -> HarnessState {
    HarnessState {
        schema: 1,
        entries: [
            (RefinementKind::Prompt, BTreeMap::new()),
            (RefinementKind::Memory, BTreeMap::new()),
            (RefinementKind::Skill, BTreeMap::new()),
            (RefinementKind::Subagent, BTreeMap::new()),
        ]
        .into_iter()
        .collect(),
        refinements: Vec::new(),
    }
}

fn kind_from_name(name: &str) -> RefinementKind {
    match name {
        "prompt" => RefinementKind::Prompt,
        "memory" => RefinementKind::Memory,
        "skill" => RefinementKind::Skill,
        _ => RefinementKind::Subagent,
    }
}

pub fn get_global_harness_state_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join(HARNESS_STATE_DIR_NAME)
}

pub fn get_local_harness_state_dir(session_artifact_dir: Option<&Path>) -> Option<PathBuf> {
    session_artifact_dir.map(|dir| dir.join(HARNESS_STATE_DIR_NAME))
}

pub fn get_harness_state_path(harness_state_dir: &Path) -> PathBuf {
    harness_state_dir.join("harness_state.json")
}

/// Load harness state; a corrupt or unreadable file degrades to empty rather
/// than throwing (prompt builds run on every turn).
///
/// # Panics
///
/// The `get_mut(kind).unwrap()` on the per-kind entry maps cannot panic:
/// the empty state pre-populates every kind map.
pub fn load_harness_state(harness_state_dir: &Path, scope: HarnessScope) -> HarnessState {
    let state_path = get_harness_state_path(harness_state_dir);
    let Ok(raw) = std::fs::read_to_string(&state_path) else {
        return empty_harness_state();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return empty_harness_state();
    };
    let Some(parsed_obj) = parsed.as_object() else {
        return empty_harness_state();
    };
    let mut state = empty_harness_state();
    state.schema = parsed_obj
        .get("schema")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1);
    for kind in REFINEMENT_KINDS {
        let kind_key = kind_from_name(kind);
        if let Some(records) = parsed_obj
            .get("entries")
            .and_then(|entries| entries.get(kind))
            .and_then(|records| records.as_object())
        {
            for (id, raw_entry) in records {
                let Ok(mut entry) = serde_json::from_value::<HarnessEntry>(raw_entry.clone())
                else {
                    continue;
                };
                entry.scope = Some(entry.scope.unwrap_or(scope));
                state
                    .entries
                    .get_mut(&kind_key)
                    .unwrap()
                    .insert(id.clone(), entry);
            }
        }
    }
    if let Some(refinements) = parsed_obj
        .get("refinements")
        .and_then(|value| value.as_array())
    {
        state.refinements = refinements
            .iter()
            .filter_map(|event| serde_json::from_value(event.clone()).ok())
            .collect();
    }
    state
}

/// Merge global + local states: local ids conflict-prefixed with their scope.
///
/// # Panics
///
/// The `get_mut(kind).unwrap()` on the per-kind entry maps cannot panic:
/// the empty state pre-populates every kind map.
pub fn merge_harness_states(
    global_state: &HarnessState,
    local_state: Option<&HarnessState>,
) -> HarnessState {
    let mut merged = empty_harness_state();
    merged.schema = global_state
        .schema
        .max(local_state.map_or(1, |state| state.schema));
    for kind in REFINEMENT_KINDS {
        let kind_key = kind_from_name(kind);
        let global_entries = &global_state.entries[&kind_key];
        for (id, entry) in global_entries {
            let mut scoped = entry.clone();
            scoped.scope = Some(HarnessScope::Global);
            merged
                .entries
                .get_mut(&kind_key)
                .unwrap()
                .insert(id.clone(), scoped);
        }
        if let Some(local_entries) = local_state.map(|state| &state.entries[&kind_key]) {
            for (id, entry) in local_entries {
                let mut scoped = entry.clone();
                scoped.scope = Some(HarnessScope::Local);
                let merged_id = if merged.entries[&kind_key].contains_key(id) {
                    format!("local:{id}")
                } else {
                    id.clone()
                };
                merged
                    .entries
                    .get_mut(&kind_key)
                    .unwrap()
                    .insert(merged_id, scoped);
            }
        }
    }
    merged.refinements.clone_from(&global_state.refinements);
    if let Some(local_state) = local_state {
        merged.refinements.extend(local_state.refinements.clone());
    }
    merged
}

/// Atomically save harness state (0o600 for new files).
///
/// # Errors
///
/// Returns an error when the harness directory cannot be created, the state
/// cannot be serialized, or the atomic write fails.
pub fn save_harness_state(
    harness_state_dir: &Path,
    state: &HarnessState,
) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(harness_state_dir)?;
    let state_path = get_harness_state_path(harness_state_dir);
    let content = format!("{}\n", serde_json::to_string_pretty(state)?);
    crate::settings::storage::atomic_write(&state_path, &content)?;
    Ok(state_path)
}

pub fn get_refinement_history_path(harness_state_dir: &Path) -> PathBuf {
    harness_state_dir.join(REFINEMENT_HISTORY_FILE_NAME)
}

/// One refinement outcome (applied-edit record), persisted for rollback.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefinementResult {
    pub id: String,
    pub summary: String,
    pub rationale: String,
    pub expected_outcome: String,
    pub applied_edits: Vec<AppliedRefinementEdit>,
    pub harness_state_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<HarnessScope>,
}

/// One applied (or failed) edit with before/after snapshots. The wire shape
/// is the TS `AppliedRefinementEdit extends RefinementEdit`: the planned
/// edit's own fields (title, content, path, reference, arguments,
/// metadata) ride along with the snapshots.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRefinementEdit {
    pub action: RefinementAction,
    pub kind: RefinementKind,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<HarnessEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<HarnessEntry>,
    pub applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl AppliedRefinementEdit {
    /// Start one applied-edit row from a planned edit: the TS wire shape
    /// (`AppliedRefinementEdit extends RefinementEdit`) carries the plan's
    /// own fields; the applying branch fills the action/kind/id resolution
    /// and the outcome fields (before/after, applied, error).
    fn planned(
        edit: &planner::RefinementEdit,
        action: RefinementAction,
        kind: RefinementKind,
        id: String,
    ) -> Self {
        Self {
            action,
            kind,
            id,
            title: edit.title.clone(),
            content: edit.content.clone(),
            path: edit.path.clone(),
            reference: edit.reference.clone(),
            arguments: edit.arguments.clone(),
            metadata: edit.metadata.clone(),
            before: None,
            after: None,
            applied: false,
            error: None,
            reason: edit.reason.clone(),
        }
    }
}

/// Infer a result scope from its edits' before/after scopes.
pub fn infer_refinement_result_scope(result: &RefinementResult) -> Option<HarnessScope> {
    if let Some(scope) = result.scope {
        return Some(scope);
    }
    let mut scopes: Vec<HarnessScope> = Vec::new();
    for edit in &result.applied_edits {
        let scope = edit
            .after
            .as_ref()
            .or(edit.before.as_ref())
            .and_then(|entry| entry.scope);
        if let Some(scope) = scope {
            if !scopes.contains(&scope) {
                scopes.push(scope);
            }
        }
    }
    (scopes.len() == 1).then(|| scopes[0])
}

/// Append a refinement to the global history log (JSONL).
///
/// # Errors
///
/// Returns an error when the harness directory cannot be created, the
/// refinement cannot be serialized, or the history file cannot be opened or
/// appended to.
pub fn append_global_refinement(
    harness_state_dir: &Path,
    result: &RefinementResult,
) -> anyhow::Result<PathBuf> {
    use std::io::Write;
    std::fs::create_dir_all(harness_state_dir)?;
    let history_path = get_refinement_history_path(harness_state_dir);
    let mut line = serde_json::to_string(result)?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&history_path)?;
    file.write_all(line.as_bytes())?;
    Ok(history_path)
}

/// Load the global refinement history; malformed lines are skipped.
pub fn load_global_refinement_history(harness_state_dir: &Path) -> Vec<RefinementResult> {
    let history_path = get_refinement_history_path(harness_state_dir);
    let Ok(content) = std::fs::read_to_string(&history_path) else {
        return Vec::new();
    };
    let mut results = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(mut result) = serde_json::from_str::<RefinementResult>(trimmed) {
            if result.scope.is_none() {
                result.scope = Some(HarnessScope::Global);
            }
            results.push(result);
        }
    }
    results
}

/// Merge global and session history by id; session entries win, inheriting an
/// existing scope when they carry none.
pub fn merge_refinement_history(
    global: &[RefinementResult],
    session: &[RefinementResult],
) -> Vec<RefinementResult> {
    let mut by_id: std::collections::BTreeMap<String, RefinementResult> =
        std::collections::BTreeMap::default();
    for result in global {
        by_id.insert(result.id.clone(), result.clone());
    }
    for result in session {
        let entry = match by_id.get(&result.id) {
            Some(existing) if result.scope.is_none() && existing.scope.is_some() => {
                let mut merged = result.clone();
                merged.scope = existing.scope;
                merged
            }
            _ => result.clone(),
        };
        by_id.insert(result.id.clone(), entry);
    }
    by_id.into_values().collect()
}

pub(crate) fn compact_text(text: &str, max_length: usize) -> String {
    let normalized: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_length {
        return normalized;
    }
    let keep = max_length.saturating_sub(3);
    let truncated: String = normalized.chars().take(keep).collect();
    format!("{truncated}...")
}

/// Digest-notation notice body for a refinement.
pub fn format_refinement_notice_body(result: &RefinementResult) -> String {
    let mut lines = vec![compact_text(
        &result.summary,
        DEFAULT_OVERVIEW_CONTENT_LIMIT,
    )];
    for edit in &result.applied_edits {
        if !edit.applied {
            continue;
        }
        let entry = edit.after.as_ref().or(edit.before.as_ref());
        let scope = entry
            .and_then(|entry| entry.scope)
            .or(result.scope)
            .unwrap_or(HarnessScope::Local);
        let title = entry.map_or(edit.id.as_str(), |entry| entry.title.as_str());
        let content = entry
            .map(|entry| entry.content.as_str())
            .unwrap_or_default();
        lines.push(format!(
            "- {} {} [{}] {}: {}",
            action_name(edit.action),
            kind_name(edit.kind),
            scope_prefix(scope, &edit.id),
            title,
            compact_text(content, DEFAULT_OVERVIEW_CONTENT_LIMIT)
        ));
    }
    lines.join("\n")
}

fn action_name(action: RefinementAction) -> &'static str {
    match action {
        RefinementAction::Create => "create",
        RefinementAction::Update => "update",
        RefinementAction::Delete => "delete",
    }
}

fn kind_name(kind: RefinementKind) -> &'static str {
    match kind {
        RefinementKind::Prompt => "prompt",
        RefinementKind::Memory => "memory",
        RefinementKind::Skill => "skill",
        RefinementKind::Subagent => "subagent",
    }
}

fn scope_prefix(scope: HarnessScope, id: &str) -> String {
    format!(
        "{}:{id}",
        match scope {
            HarnessScope::Local => "local",
            HarnessScope::Global => "global",
        }
    )
}

pub mod executor;
pub mod planner;
pub mod ranking;

// Export the compact-text helper for the digest formatter.
pub(crate) use compact_text as compact_harness_text;

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, kind: RefinementKind, scope: HarnessScope, content: &str) -> HarnessEntry {
        HarnessEntry {
            id: id.to_string(),
            kind,
            title: format!("Entry {id}"),
            content: content.to_string(),
            path: format!("/h/{id}"),
            scope: Some(scope),
            reference: serde_json::Map::default(),
            arguments: serde_json::Map::default(),
            metadata: serde_json::Map::default(),
            source: "test".to_string(),
            created_at: "2024-01-01T00:00:00.000Z".to_string(),
            updated_at: "2024-01-01T00:00:00.000Z".to_string(),
            version: 1,
        }
    }

    #[test]
    fn state_round_trips_and_degrades_gracefully() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = get_global_harness_state_dir(tmp.path());
        // Missing dir loads empty.
        let state = load_harness_state(&dir, HarnessScope::Global);
        assert!(state.refinements.is_empty());
        // Save + reload preserves entries.
        let mut state = empty_harness_state();
        state
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .insert(
                "m1".to_string(),
                entry("m1", RefinementKind::Memory, HarnessScope::Global, "a fact"),
            );
        save_harness_state(&dir, &state).unwrap();
        let loaded = load_harness_state(&dir, HarnessScope::Global);
        assert_eq!(
            loaded.entries[&RefinementKind::Memory]["m1"].content,
            "a fact"
        );
        // Corrupt content degrades to empty instead of panicking.
        std::fs::write(get_harness_state_path(&dir), "not json").unwrap();
        assert!(
            load_harness_state(&dir, HarnessScope::Global).entries[&RefinementKind::Memory]
                .is_empty()
        );
    }

    #[test]
    fn merge_prefixed_local_conflicts() {
        let mut global = empty_harness_state();
        global
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .insert(
                "m1".to_string(),
                entry(
                    "m1",
                    RefinementKind::Memory,
                    HarnessScope::Global,
                    "global fact",
                ),
            );
        let mut local = empty_harness_state();
        local
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .insert(
                "m1".to_string(),
                entry(
                    "m1",
                    RefinementKind::Memory,
                    HarnessScope::Local,
                    "local fact",
                ),
            );
        local
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .insert(
                "m2".to_string(),
                entry(
                    "m2",
                    RefinementKind::Memory,
                    HarnessScope::Local,
                    "local only",
                ),
            );
        let merged = merge_harness_states(&global, Some(&local));
        let memories = &merged.entries[&RefinementKind::Memory];
        assert_eq!(memories.len(), 3);
        assert_eq!(memories["m1"].scope, Some(HarnessScope::Global));
        assert_eq!(memories["local:m1"].scope, Some(HarnessScope::Local));
        assert_eq!(memories["m2"].content, "local only");
    }

    #[test]
    fn history_append_load_merge() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = get_global_harness_state_dir(tmp.path());
        let result = RefinementResult {
            id: "r1".to_string(),
            summary: "add a memory".to_string(),
            rationale: "reused twice".to_string(),
            expected_outcome: "faster routing".to_string(),
            applied_edits: vec![],
            harness_state_path: get_harness_state_path(&dir).display().to_string(),
            rollback_of: None,
            scope: None,
        };
        append_global_refinement(&dir, &result).unwrap();
        let loaded = load_global_refinement_history(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].scope, Some(HarnessScope::Global));
        // Session history wins on id conflicts.
        let mut session_result = result;
        session_result.summary = "session version".to_string();
        let merged = merge_refinement_history(&loaded, &[session_result]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].summary, "session version");
        assert_eq!(merged[0].scope, Some(HarnessScope::Global));
    }

    #[test]
    fn notice_body_digest_notation() {
        let result = RefinementResult {
            id: "r1".to_string(),
            summary: "created a memory about the flaky test".to_string(),
            rationale: String::new(),
            expected_outcome: String::new(),
            applied_edits: vec![AppliedRefinementEdit {
                action: RefinementAction::Create,
                kind: RefinementKind::Memory,
                id: "m1".to_string(),
                before: None,
                after: Some(entry(
                    "m1",
                    RefinementKind::Memory,
                    HarnessScope::Global,
                    "dup tests are flaky",
                )),
                applied: true,
                error: None,
                reason: None,
                title: None,
                content: None,
                path: None,
                reference: None,
                arguments: None,
                metadata: None,
            }],
            harness_state_path: String::new(),
            rollback_of: None,
            scope: None,
        };
        let body = format_refinement_notice_body(&result);
        assert!(body.starts_with("created a memory about the flaky test"));
        assert!(body.contains("- create memory [global:m1] Entry m1: dup tests are flaky"));
        // Scope inference from edits.
        assert_eq!(
            infer_refinement_result_scope(&result),
            Some(HarnessScope::Global)
        );
    }
}
