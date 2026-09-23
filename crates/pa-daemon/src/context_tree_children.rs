//! The persisted RLM child nodes of the /context tree: the daemon-side
//! port of the TS `core/context-tree.ts` disk walk
//! (`loadContextTreeChildFromDisk` / `loadContextTreeChildrenFromDisk`).
//! The worker's live child registry covers only children THIS worker
//! spawned; every other child — idle, settled, or orphaned by a worker
//! restart — is read from its persisted session dir, so the tree survives
//! child disposal and session resume exactly like the TS session's tree.
//!
//! Layout (the port's own writer, `rlm_children.rs`:
//! `SupervisorChildSessions::child_session_dir`): children of a session
//! live under `<agent-dir>/session-artifacts/<parent-session-id>/sub-<id>/`,
//! and GRANDCHILDREN under the sibling tree
//! `<agent-dir>/session-artifacts/<child-session-id>/sub-<id>/`. The TS
//! nests grandchildren inside `sub-<id>/sub-<id>/`, but nothing in this
//! port writes that layout, so the walk follows the writer, one level per
//! session id.
//!
//! Deliberate deltas against the TS: the TS prefers a resident child's
//! live in-process session over its file (daemon children live in
//! separate worker processes, so the file is always the source here —
//! the same rows at settle boundaries, TS's own
//! `loadContextTreeChildFromDisk` fallback); and user-deleted subagents
//! stay hidden — the TS re-surfaces them after a restart because its
//! deletion guard is in-memory only, while this port consults the
//! durable RLM ledger tombstones at every level of the walk (the caller
//! resolves this session's deletions into skip ids and hands the whole
//! record down, so each recursion level skips its own).
//! The TS child-node cache is not ported yet (the walk runs per
//! /context call, not per top-bar refresh).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use pa_core::models::ModelRegistry;

use crate::session_stats::store_context_usage;
use crate::session_store::SessionFile;

/// Label cap (TS `compactLabel`'s default).
const LABEL_MAX_CHARS: usize = 80;
const ELLIPSIS: &str = "...";

/// User-deleted child ids keyed by the deleted child's parent session
/// file path (the RLM ledger's durable tombstones, canonicalized): every
/// level of the walk consults its own session's deletions.
pub type TombstonedChildren = HashMap<PathBuf, HashSet<String>>;

/// The artifact tree root every session's children live under
/// (`child_session_dir` writes `<agent-dir>/session-artifacts/<id>/...`).
pub fn session_artifacts_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join("session-artifacts")
}

/// Build one child node from its persisted session dir (TS
/// `loadContextTreeChildFromDisk`): the newest valid session file's usage
/// totals over the gap-bridged branch, the label from the first user
/// message, the terminal status from the last assistant turn, the model
/// from its `model_change` entries, the context utilization against the
/// registry's window, and the recursive grandchild nodes from the
/// child's own session id's tree. The child's own deleted subagents stay
/// hidden at the next level: `tombstones` carries the ledger's deletion
/// record keyed by the deleted child's parent session file. `None` when
/// the dir holds no readable session (TS `findSessionFile` miss).
pub fn load_context_tree_child(
    artifacts_root: &Path,
    child_dir: &Path,
    registry: &ModelRegistry,
    tombstones: &TombstonedChildren,
) -> Option<Value> {
    // The newest VALID session file: artifact dirs carry sibling `.jsonl`
    // files (`semantic-edges.jsonl`, harness state) that are not sessions,
    // so candidates are tried newest-first until one opens.
    let store = newest_session_files(child_dir)
        .iter()
        .filter_map(|file| SessionFile::open(file).ok())
        .next()?;
    // Label, status, and model follow the same gap-bridged branch as the
    // usage totals: a ghost-parent gap must not strip a child of its
    // identity either. The context estimate below stays strict — it
    // mirrors the model-facing truth.
    let branch = store
        .branch_bridged()
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    let all_entries = store.entries().to_vec();
    let (own_usage, total_usage) =
        crate::state_getters::compute_own_and_total_usage(&branch, &all_entries);
    let label = branch
        .iter()
        .find_map(branch_user_label)
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "child agent".to_string());
    let status = status_from_branch(&branch);
    let model = branch_model(&branch);
    let mut node = json!({
        "id": child_dir.file_name()?.to_string_lossy(),
        "label": label,
        "status": status,
        "ownUsage": own_usage,
        "totalUsage": total_usage,
        "children": Value::Array(Vec::new()),
    });
    if let Some((provider, model_id)) = &model {
        node["model"] = json!({ "provider": provider, "id": model_id });
        if let Some(usage) =
            store_context_usage(&store, context_window_of(registry, provider, model_id))
        {
            node["contextUsage"] = usage;
        }
    }
    // The child's own deleted subagents stay hidden one level down: the
    // tombstones key by the deleted child's parent session file, and the
    // grandchild edges' parent is this child's session file.
    let deleted_ids = tombstones
        .get(&crate::lease::canonical_session_path(&store.path))
        .cloned()
        .unwrap_or_default();
    node["children"] = Value::Array(load_context_tree_children(
        artifacts_root,
        store.session_id(),
        registry,
        &deleted_ids,
        tombstones,
    ));
    Some(node)
}

/// Build the nodes for every persisted child dir of one session (TS
/// `loadContextTreeChildrenFromDisk`): the `sub-*` dirs under
/// `<artifacts_root>/<session_id>/`, skipping the ids already represented
/// live or tombstoned in the RLM ledger (the caller resolves this
/// session's deletions into `skip_ids`; `tombstones` carries every
/// session's record so each recursion level resolves its own).
pub fn load_context_tree_children(
    artifacts_root: &Path,
    session_id: &str,
    registry: &ModelRegistry,
    skip_ids: &HashSet<String>,
    tombstones: &TombstonedChildren,
) -> Vec<Value> {
    child_session_dirs(&artifacts_root.join(session_id))
        .into_iter()
        .filter(|child_dir| {
            child_dir.file_name().is_some_and(|name| {
                let name = name.to_string_lossy();
                !skip_ids.contains(name.as_ref())
            })
        })
        .filter_map(|child_dir| {
            load_context_tree_child(artifacts_root, &child_dir, registry, tombstones)
        })
        .collect()
}

/// `sub-*` child session dirs sorted by modification time (TS
/// `listChildSessionDirs`).
fn child_session_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("sub-"))
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let mtime = entry.metadata().ok()?.modified().ok()?;
            Some((mtime, entry.path()))
        })
        .collect();
    dirs.sort_by_key(|(mtime, _)| *mtime);
    dirs.into_iter().map(|(_, path)| path).collect()
}

/// The `.jsonl` files in a dir, newest first (TS `findSessionFile`
/// considers every `.jsonl`; this port opens them newest-first and keeps
/// the first that is a readable session, skipping non-session siblings).
fn newest_session_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".jsonl"))
        .filter_map(|entry| {
            let mtime = entry.metadata().ok()?.modified().ok()?;
            Some((mtime, entry.path()))
        })
        .collect();
    files.sort_by_key(|(mtime, _)| std::cmp::Reverse(*mtime));
    files.into_iter().map(|(_, path)| path).collect()
}

/// The first user message's compacted text on the branch (TS
/// `readUserMessageText` + `compactLabel`).
fn branch_user_label(entry: &crate::session_store::SessionEntry) -> Option<String> {
    let message = entry.fields.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let text = match message.get("content") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(blocks)) => Some(
            blocks
                .iter()
                .filter_map(|block| {
                    (block.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| block.get("text").and_then(Value::as_str))
                        .flatten()
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }?;
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(compact_label(&compact))
}

/// Collapse to one line and cap at 80 chars with an ellipsis (TS
/// `compactLabel`).
fn compact_label(text: &str) -> String {
    if text.chars().count() <= LABEL_MAX_CHARS {
        return text.to_string();
    }
    let kept: String = text
        .chars()
        .take(LABEL_MAX_CHARS - ELLIPSIS.len())
        .collect();
    format!("{}{}", kept.trim_end(), ELLIPSIS)
}

/// The terminal status a persisted branch implies (TS `statusFromBranch`):
/// errored and aborted runs must not render as successful.
fn status_from_branch(branch: &[crate::session_store::SessionEntry]) -> &'static str {
    for entry in branch.iter().rev() {
        let Some(message) = entry.fields.get("message") else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        return match message.get("stopReason").and_then(Value::as_str) {
            Some("error") => "error",
            Some("aborted") => "cancelled",
            _ => "done",
        };
    }
    "done"
}

/// The branch's effective model (TS walks `model_change` entries, last
/// wins).
fn branch_model(branch: &[crate::session_store::SessionEntry]) -> Option<(String, String)> {
    branch.iter().rev().find_map(|entry| {
        (entry.type_ == "model_change").then(|| {
            let provider = entry
                .fields
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let model_id = entry
                .fields
                .get("modelId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            (provider, model_id)
        })
    })
}

/// The registry's context window for one model (the TS
/// `ContextWindowResolver`).
fn context_window_of(registry: &ModelRegistry, provider: &str, model_id: &str) -> Option<u64> {
    registry
        .get_all()
        .iter()
        .find(|model| model.provider == provider && model.id == model_id)
        .map(|model| model.context_window)
        .filter(|window| *window > 0)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-ctc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn registry() -> ModelRegistry {
        let root = dir();
        pa_core::models::ModelRegistry::create(
            pa_core::auth::AuthStorage::create(&root),
            root.join("models.json"),
        )
    }

    /// Write one child session file with a user row and an assistant row
    /// carrying usage; returns the child dir.
    fn write_child(parent_dir: &Path, name: &str, session_id: &str, stop: &str) -> PathBuf {
        let child_dir = parent_dir.join(name);
        std::fs::create_dir_all(&child_dir).unwrap();
        let lines = [
            json!({
                "type": "session", "version": 3, "id": session_id,
                "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp",
            }),
            json!({
                "type": "model_change", "id": "c0", "parentId": null,
                "timestamp": "2026-09-22T00:00:00.500Z",
                "provider": "prime-inference", "modelId": "internal/glm-5.3-fast",
            }),
            json!({
                "type": "message", "id": "c1", "parentId": "c0",
                "timestamp": "2026-09-22T00:00:01.000Z",
                "message": {"role": "user", "content": "  fix the   login bug  please "},
            }),
            json!({
                "type": "message", "id": "c2", "parentId": "c1",
                "timestamp": "2026-09-22T00:00:02.000Z",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "done" }],
                    "provider": "prime-inference", "model": "internal/glm-5.3-fast",
                    "stopReason": stop,
                    "usage": {
                        "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                        "totalTokens": 15,
                        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
                    },
                },
            }),
        ];
        let content = lines
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(child_dir.join(format!("{session_id}.jsonl")), content).unwrap();
        child_dir
    }

    /// A settled child loads from its session dir with real usage, the
    /// prompt label, the terminal status, and the model (TS
    /// `loadContextTreeChildFromDisk`).
    #[test]
    fn disk_children_carry_usage_label_status_and_model() {
        let root = dir();
        let artifacts = root.join("session-artifacts");
        let parent = artifacts.join("01a0parent-0000");
        let child_dir = write_child(&parent, "sub-003f741a", "01a0child-0000", "stop");
        let node = load_context_tree_child(
            &artifacts,
            &child_dir,
            &registry(),
            &TombstonedChildren::new(),
        )
        .expect("node builds");
        assert_eq!(node["id"], json!("sub-003f741a"));
        assert_eq!(node["label"], json!("fix the login bug please"));
        assert_eq!(node["status"], json!("done"));
        assert_eq!(node["ownUsage"]["input"], json!(10));
        assert_eq!(node["ownUsage"]["totalTokens"], json!(15));
        assert_eq!(
            node["model"],
            json!({ "provider": "prime-inference", "id": "internal/glm-5.3-fast" })
        );

        // An errored child renders as errored; an aborted one as cancelled.
        let errored = write_child(&parent, "sub-errored", "01a0child-0001", "error");
        let node = load_context_tree_child(
            &artifacts,
            &errored,
            &registry(),
            &TombstonedChildren::new(),
        )
        .expect("node builds");
        assert_eq!(node["status"], json!("error"));
        let aborted = write_child(&parent, "sub-aborted", "01a0child-0002", "aborted");
        let node = load_context_tree_child(
            &artifacts,
            &aborted,
            &registry(),
            &TombstonedChildren::new(),
        )
        .expect("node builds");
        assert_eq!(node["status"], json!("cancelled"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The walk lists one session's `sub-*` dirs and skips the ids handed
    /// in (TS `loadContextTreeChildrenFromDisk`'s `skipIds`).
    #[test]
    fn walk_lists_sub_dirs_and_skips_ids() {
        let root = dir();
        let artifacts = root.join("session-artifacts");
        let parent = artifacts.join("01a0parent-0000");
        write_child(&parent, "sub-a", "01a0child-a", "stop");
        write_child(&parent, "sub-b", "01a0child-b", "stop");
        std::fs::create_dir_all(parent.join("not-a-child")).unwrap();
        let registry = registry();
        let nodes = load_context_tree_children(
            &artifacts,
            "01a0parent-0000",
            &registry,
            &Default::default(),
            &TombstonedChildren::new(),
        );
        assert_eq!(nodes.len(), 2, "non-sub dirs and empty dirs drop out");

        let skip: HashSet<String> = ["sub-a".to_string()].into_iter().collect();
        let nodes = load_context_tree_children(
            &artifacts,
            "01a0parent-0000",
            &registry,
            &skip,
            &TombstonedChildren::new(),
        );
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0]["id"], json!("sub-b"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Grandchildren load from the CHILD's own session id's tree (the port's
    /// writer puts them in the sibling artifact tree, not nested inside the
    /// child dir), and dirs without a readable session drop out.
    #[test]
    fn grandchildren_load_from_the_childs_sibling_tree() {
        let root = dir();
        let artifacts = root.join("session-artifacts");
        let child_dir = write_child(
            &artifacts.join("01a0parent-0000"),
            "sub-parent",
            "01a0child-0000",
            "stop",
        );
        // A grandchild session under the child's own artifact tree, plus a
        // nested decoy dir inside the child dir that must NOT be walked.
        write_child(
            &artifacts.join("01a0child-0000"),
            "sub-grand",
            "01a0grand-0000",
            "stop",
        );
        std::fs::create_dir_all(child_dir.join("sub-nested-decoy")).unwrap();
        let node = load_context_tree_child(
            &artifacts,
            &child_dir,
            &registry(),
            &TombstonedChildren::new(),
        )
        .expect("node builds");
        let grandchildren = node["children"].as_array().expect("children");
        assert_eq!(grandchildren.len(), 1, "the decoy dir drops out");
        assert_eq!(grandchildren[0]["id"], json!("sub-grand"));
        assert_eq!(grandchildren[0]["ownUsage"]["totalTokens"], json!(15));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A deleted grandchild stays hidden: the tombstone record keys by
    /// the grandchild's parent session file (the child's own file), so
    /// the recursion into the child's tree skips its deleted ids while
    /// live grandchildren still load.
    #[test]
    fn deleted_grandchildren_stay_hidden() {
        let root = dir();
        let artifacts = root.join("session-artifacts");
        let child_dir = write_child(
            &artifacts.join("01a0parent-0000"),
            "sub-parent",
            "01a0child-0000",
            "stop",
        );
        write_child(
            &artifacts.join("01a0child-0000"),
            "sub-alive",
            "01a0grand-0000",
            "stop",
        );
        write_child(
            &artifacts.join("01a0child-0000"),
            "sub-dead",
            "01a0grand-0001",
            "stop",
        );
        let mut tombstones = TombstonedChildren::new();
        tombstones
            .entry(crate::lease::canonical_session_path(
                &child_dir.join("01a0child-0000.jsonl"),
            ))
            .or_default()
            .insert("sub-dead".to_string());
        let node = load_context_tree_child(&artifacts, &child_dir, &registry(), &tombstones)
            .expect("node builds");
        let grandchildren = node["children"].as_array().expect("children");
        assert_eq!(
            grandchildren.len(),
            1,
            "the tombstoned grandchild drops out"
        );
        assert_eq!(grandchildren[0]["id"], json!("sub-alive"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A child file with a ghost-parent gap still reports its real usage
    /// and identity (the bridged accounting walk) — the corrupted files
    /// real daemon sessions carry.
    #[test]
    fn ghost_gapped_child_files_still_report_usage() {
        let root = dir();
        let artifacts = root.join("session-artifacts");
        let child_dir = artifacts.join("01a0parent-0000").join("sub-ghosty");
        std::fs::create_dir_all(&child_dir).unwrap();
        let lines = [
            json!({"type": "session", "version": 3, "id": "01a0child-0000", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "model_change", "id": "m0", "parentId": null, "timestamp": "2026-09-22T00:00:00.100Z", "provider": "prime-inference", "modelId": "internal/glm-5.3-fast"}),
            json!({"type": "message", "id": "g1", "parentId": "m0", "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "assistant", "content": [{ "type": "text", "text": "hi" }], "provider": "prime-inference", "model": "internal/glm-5.3-fast", "usage": {"input": 7, "output": 2, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 9, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}}}),
            json!({"type": "message", "id": "g2", "parentId": "8b5f0d21", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "user", "content": "after the gap"}}),
        ];
        let content = lines
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(child_dir.join("01a0child-0000.jsonl"), content).unwrap();
        let node = load_context_tree_child(
            &artifacts,
            &child_dir,
            &registry(),
            &TombstonedChildren::new(),
        )
        .expect("node builds");
        assert_eq!(node["ownUsage"]["input"], json!(7));
        assert_eq!(node["ownUsage"]["totalTokens"], json!(9));
        // The identity survives the gap too: model, label, and status come
        // from the bridged branch.
        assert_eq!(node["label"], json!("after the gap"));
        assert_eq!(node["status"], json!("done"));
        assert_eq!(
            node["model"],
            json!({ "provider": "prime-inference", "id": "internal/glm-5.3-fast" })
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The artifact tree root follows the agent dir (the writer's own
    /// addressing).
    #[test]
    fn session_artifacts_dir_follows_the_agent_dir() {
        assert_eq!(
            session_artifacts_dir(Path::new("/agent")),
            Path::new("/agent/session-artifacts"),
        );
    }
}
