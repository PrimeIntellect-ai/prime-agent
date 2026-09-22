//! The persisted RLM child nodes of the /context tree: the port of the TS
//! `core/context-tree.ts` disk walk (`loadContextTreeChildFromDisk` /
//! `loadContextTreeChildrenFromDisk`). The worker's live child registry
//! covers only children THIS worker spawned; every other child — idle,
//! settled, or orphaned by a worker restart — is read from its persisted
//! session dir under the session's artifact tree
//! (`session-artifacts/<session-id>/sub-<id>/<session>.jsonl`), recursively
//! for grandchildren, so the tree survives child disposal and session
//! resume exactly like the TS session's tree.
//!
//! Porting deltas against the TS (both narrower than the TS surface):
//! the TS prefers a resident child's live in-process session over its
//! file; daemon children live in separate worker processes, so the file
//! is always the source here (it carries the same rows at settle
//! boundaries, TS `loadContextTreeChildFromDisk`'s own fallback), and
//! the TS child-node cache is not ported yet (the walk runs per
//! /context call, not per top-bar refresh).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use pa_core::models::ModelRegistry;

use crate::session_stats::store_context_usage;
use crate::session_store::SessionFile;

/// Label cap (TS `compactLabel`'s default).
const LABEL_MAX_CHARS: usize = 80;
const ELLIPSIS: &str = "...";

/// The session's RLM session dir for child reads (TS
/// `_rlmSessionDirForReading` / `getSessionArtifactDir` implied by the
/// conversation-log path: `dirname(dirname(file))/session-artifacts/<id>`).
pub fn session_artifact_dir(session_file: &Path) -> Option<PathBuf> {
    pa_core::session_engine::harness_digest::session_artifact_dir_for_log(session_file)
}

/// Build one child node from its persisted session dir (TS
/// `loadContextTreeChildFromDisk`): the newest session file's usage
/// totals over the gap-bridged branch, the label from the first user
/// message, the terminal status from the last assistant turn, the model
/// from its `model_change` entries, the context utilization against the
/// registry's window, and the recursive grandchild nodes from nested
/// `sub-*` dirs. `None` when the dir holds no readable session (TS
/// `findSessionFile` miss).
pub fn load_context_tree_child(child_dir: &Path, registry: &ModelRegistry) -> Option<Value> {
    // The newest VALID session file: artifact dirs carry sibling
    // `.jsonl` files (`semantic-edges.jsonl`, harness state) that are not
    // sessions, so candidates are tried newest-first until one opens.
    let store = newest_session_files(child_dir)
        .iter()
        .filter_map(|file| SessionFile::open(file).ok())
        .next()?;
    let branch = store.branch();
    let durable_branch: Vec<_> = store.branch_bridged().into_iter().cloned().collect();
    let all_entries: Vec<_> = store.entries().to_vec();
    let (own_usage, total_usage) =
        crate::state_getters::compute_own_and_total_usage(&durable_branch, &all_entries);
    let label = branch
        .iter()
        .find_map(|entry| branch_user_label(entry))
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
        let window = context_window_of(registry, provider, model_id);
        if let Some(usage) = store_context_usage(&store, window) {
            node["contextUsage"] = usage;
        }
    }
    node["children"] = Value::Array(
        child_session_dirs(child_dir)
            .into_iter()
            .filter_map(|grandchild| load_context_tree_child(&grandchild, registry))
            .collect::<Vec<_>>(),
    );
    Some(node)
}

/// Build the nodes for every persisted child dir under the session's
/// artifact dir, skipping the ids already represented live (TS
/// `loadContextTreeChildrenFromDisk`'s `skipIds`).
pub fn load_context_tree_children(
    artifact_dir: &Path,
    registry: &ModelRegistry,
    skip_ids: &std::collections::HashSet<String>,
) -> Vec<Value> {
    child_session_dirs(artifact_dir)
        .into_iter()
        .filter(|dir| {
            dir.file_name()
                .map(|name| {
                    let name = name.to_string_lossy();
                    !skip_ids.contains(name.as_ref())
                })
                .unwrap_or(false)
        })
        .filter_map(|dir| load_context_tree_child(&dir, registry))
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

/// The first user message's compacted text on a branch (TS
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
fn status_from_branch(branch: &[&crate::session_store::SessionEntry]) -> &'static str {
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
fn branch_model(branch: &[&crate::session_store::SessionEntry]) -> Option<(String, String)> {
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

    /// Write one child session file with a user row, an assistant row
    /// carrying usage, and a model change; returns the dir.
    fn write_child(parent_dir: &Path, name: &str, session_id: &str, status: &str) -> PathBuf {
        let child_dir = parent_dir.join(name);
        std::fs::create_dir_all(&child_dir).unwrap();
        let stop = match status {
            "done" => "stop",
            "error" => "error",
            "cancelled" => "aborted",
            other => other,
        };
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
        let child_dir = write_child(&root, "sub-003f741a", "child-1", "done");
        let node = load_context_tree_child(&child_dir, &registry()).expect("node builds");
        assert_eq!(node["id"], json!("sub-003f741a"));
        assert_eq!(node["label"], json!("fix the login bug please"));
        assert_eq!(node["status"], json!("done"));
        assert_eq!(node["ownUsage"]["input"], json!(10));
        assert_eq!(node["ownUsage"]["totalTokens"], json!(15));
        assert_eq!(
            node["model"],
            json!({
                "provider": "prime-inference", "id": "internal/glm-5.3-fast",
            })
        );
        assert_eq!(node["children"], json!([]));

        // An errored child renders as errored; an aborted one as cancelled.
        let errored = write_child(&root, "sub-errored", "child-2", "error");
        let node = load_context_tree_child(&errored, &registry()).expect("node builds");
        assert_eq!(node["status"], json!("error"));
        let aborted = write_child(&root, "sub-aborted", "child-3", "cancelled");
        let node = load_context_tree_child(&aborted, &registry()).expect("node builds");
        assert_eq!(node["status"], json!("cancelled"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The walk lists `sub-*` dirs and skips the ids already represented
    /// live (TS `loadContextTreeChildrenFromDisk`'s `skipIds`).
    #[test]
    fn walk_lists_sub_dirs_and_skips_live_ids() {
        let root = dir();
        write_child(&root, "sub-a", "child-a", "done");
        write_child(&root, "sub-b", "child-b", "done");
        std::fs::create_dir_all(root.join("not-a-child")).unwrap();
        let registry = registry();
        let nodes = load_context_tree_children(&root, &registry, &Default::default());
        assert_eq!(nodes.len(), 2, "non-sub dirs and empty dirs drop out");

        let skip: std::collections::HashSet<String> = ["sub-a".to_string()].into_iter().collect();
        let nodes = load_context_tree_children(&root, &registry, &skip);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0]["id"], json!("sub-b"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Grandchildren nest recursively (TS recurses into nested `sub-*`
    /// dirs), and a dir without a readable session drops out.
    #[test]
    fn grandchildren_nest_and_unreadable_dirs_drop() {
        let root = dir();
        let child_dir = write_child(&root, "sub-parent", "child-p", "done");
        write_child(&child_dir, "sub-grand", "child-g", "done");
        std::fs::create_dir_all(child_dir.join("sub-empty")).unwrap();
        let node = load_context_tree_child(&child_dir, &registry()).expect("node builds");
        let grandchildren = node["children"].as_array().expect("children");
        assert_eq!(grandchildren.len(), 1, "the empty dir drops out");
        assert_eq!(grandchildren[0]["id"], json!("sub-grand"));
        assert_eq!(grandchildren[0]["ownUsage"]["totalTokens"], json!(15));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A child file with a ghost-parent gap still reports its real usage
    /// (the bridged accounting walk) — the corrupted files real daemon
    /// sessions carry.
    #[test]
    fn ghost_gapped_child_files_still_report_usage() {
        let root = dir();
        let child_dir = root.join("sub-ghosty");
        std::fs::create_dir_all(&child_dir).unwrap();
        let lines = [
            json!({"type": "session", "version": 3, "id": "c", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "message", "id": "g1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "assistant", "content": [{ "type": "text", "text": "hi" }], "usage": {"input": 7, "output": 2, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 9, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}}}),
            json!({"type": "message", "id": "g2", "parentId": "8b5f0d21", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "user", "content": "after the gap"}}),
        ];
        let content = lines
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(child_dir.join("c.jsonl"), content).unwrap();
        let node = load_context_tree_child(&child_dir, &registry()).expect("node builds");
        assert_eq!(node["ownUsage"]["input"], json!(7));
        assert_eq!(node["ownUsage"]["totalTokens"], json!(9));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The artifact dir implied by a session file: sibling
    /// `session-artifacts/<id>` of the sessions dir.
    #[test]
    fn session_artifact_dir_follows_the_session_file() {
        let file = Path::new("/agent/sessions/01a0-abc.jsonl");
        assert_eq!(
            session_artifact_dir(file).as_deref(),
            Some(Path::new("/agent/session-artifacts/01a0-abc")),
        );
        assert_eq!(session_artifact_dir(Path::new("bare.jsonl")), None);
    }
}
