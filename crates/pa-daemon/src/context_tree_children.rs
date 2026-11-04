//! The persisted RLM child nodes of the /context tree: the live registry covers only children THIS
//! worker spawned; every other child is read from its persisted session dir. Deliberate TS
//! divergences: grandchildren live under the sibling tree (TS nests them inside `sub-<id>/`);
//! a deleted subagent's transcript stays hidden via durable ledger tombstones at every level
//! (TS: memory only) and its spend rides a `deleted` row from the ledger's deleted-spend fold,
//! the same fold the agents view bills; every child carries its ledger edge's factory run tag.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use pa_core::models::ModelRegistry;

use crate::session_stats::store_context_usage;
use crate::session_store::SessionFile;

/// Label cap (TS `compactLabel`'s default).
const LABEL_MAX_CHARS: usize = 80;
const ELLIPSIS: &str = "...";

/// The RLM ledger facts the walk reads, keyed by the parent session file
/// (canonicalized): the tombstoned child ids whose transcripts stay hidden
/// and the billable deleted children (the agents view's deleted-spend
/// fold); plus each child's factory run tag, keyed by the child's own
/// session file (child ids are only unique under one parent).
#[derive(Debug, Default)]
pub struct ContextLedger {
    tombstoned: HashMap<PathBuf, HashSet<String>>,
    tombstoned_files: HashSet<PathBuf>,
    deleted: HashMap<PathBuf, Vec<crate::rlm_ledger::DeletedChildUsage>>,
    factory: HashMap<PathBuf, crate::rlm_ledger::RlmFactoryTag>,
}

impl ContextLedger {
    /// Read the facts from one ledger. An unreadable ledger degrades to no
    /// filtering and no deleted rows.
    pub fn read(ledger: &crate::rlm_ledger::RlmSpawnLedger) -> Self {
        let mut facts = Self::default();
        let (edges, deleted) = ledger.edges_with_deleted_children().unwrap_or_default();
        // A reused path with a live edge bills as live, like the ledger's
        // deleted-spend fold; an older tombstone must not hide its new owner.
        let live_files: HashSet<PathBuf> = edges
            .iter()
            .filter(|edge| edge.deleted.is_none())
            .map(|edge| crate::lease::canonical_session_path(Path::new(&edge.child)))
            .collect();
        // Replay order: the last edge at a child session file decides its tag.
        for edge in edges {
            let child = crate::lease::canonical_session_path(Path::new(&edge.child));
            match edge.factory.clone() {
                Some(tag) => facts.factory.insert(child, tag),
                None => facts.factory.remove(&child),
            };
            if edge.deleted.is_some() {
                let file = crate::lease::canonical_session_path(Path::new(&edge.child));
                if !live_files.contains(&file) {
                    facts.tombstoned_files.insert(file);
                }
                facts
                    .tombstoned
                    .entry(crate::lease::canonical_session_path(Path::new(
                        &edge.parent,
                    )))
                    .or_default()
                    .insert(edge.child_id);
            }
        }
        for (parent, children) in deleted {
            facts.deleted.insert(PathBuf::from(parent), children);
        }
        facts
    }

    /// The tombstoned child ids of one parent session file.
    pub fn tombstoned_ids(&self, parent_file: &Path) -> HashSet<String> {
        self.tombstoned
            .get(&crate::lease::canonical_session_path(parent_file))
            .cloned()
            .unwrap_or_default()
    }

    /// Whether this exact session file was tombstoned; called on the blocking walk.
    pub(crate) fn is_tombstoned_file(&self, path: &Path) -> bool {
        self.tombstoned_files
            .contains(&crate::lease::canonical_session_path(path))
    }

    /// Set a child node's `factory` run tag from the ledger edge of its
    /// session file.
    fn tag(&self, node: &mut Value, session_file: &Path) {
        if let Some(tag) = self
            .factory
            .get(&crate::lease::canonical_session_path(session_file))
        {
            node["factory"] = json!(tag);
        }
    }

    /// One `deleted` row per billable deleted child of one parent session
    /// file, with its per-model split when the capture recorded one (the
    /// split's tokens equal the summary's; the billed cost stays the
    /// summary's). Without a split, the summary's `inputTokens` already
    /// include cache reads and writes.
    pub fn deleted_nodes(&self, parent_file: &Path) -> Vec<Value> {
        let Some(children) = self
            .deleted
            .get(&crate::lease::canonical_session_path(parent_file))
        else {
            return Vec::new();
        };
        children
            .iter()
            .map(|child| {
                let summary = &child.usage;
                let (input, cache_read, cache_write) = match &child.by_model {
                    Some(models) => (
                        models.iter().map(|model| model.input).sum(),
                        models.iter().map(|model| model.cache_read).sum(),
                        models.iter().map(|model| model.cache_write).sum(),
                    ),
                    None => (summary.input_tokens, 0, 0),
                };
                let usage = usage_value(
                    input,
                    summary.output_tokens,
                    cache_read,
                    cache_write,
                    summary.cost,
                );
                // Its own id namespace: a live child reusing the id must
                // never collide with (or invalidate) the deleted spend.
                let mut node = json!({
                    "id": format!("deleted:{}", child.child_file),
                    "label": child.name,
                    "status": "deleted",
                    "deleted": true,
                    "ownUsage": usage,
                    "totalUsage": usage,
                    "children": [],
                });
                if let Some(tag) = &child.factory {
                    node["factory"] = json!(tag);
                }
                if let Some(models) = &child.by_model {
                    let buckets: Vec<Value> = models
                        .iter()
                        .map(|model| {
                            json!({
                                "provider": model.provider,
                                "id": model.id,
                                "ownUsage": usage_value(
                                    model.input,
                                    model.output,
                                    model.cache_read,
                                    model.cache_write,
                                    model.cost,
                                ),
                            })
                        })
                        .collect();
                    node["ownUsageByModel"] = json!(buckets);
                }
                node
            })
            .collect()
    }
}

/// The `Usage` wire shape for one token split and its billed total (the
/// ledger keeps no per-category cost).
fn usage_value(input: u64, output: u64, cache_read: u64, cache_write: u64, cost: f64) -> Value {
    json!({
        "input": input,
        "output": output,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "totalTokens": input + output + cache_read + cache_write,
        "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "total": cost,
        },
    })
}

/// The artifact tree root every session's children live under
/// (`child_session_dir` writes `<agent-dir>/session-artifacts/<id>/...`).
pub const RLM_SESSION_ARTIFACTS_DIR: &str = "session-artifacts";

/// The artifact tree root path for one agent dir.
pub fn session_artifacts_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join(RLM_SESSION_ARTIFACTS_DIR)
}

/// Build one child node from its persisted session dir (TS `loadContextTreeChildFromDisk`):
/// usage totals over the gap-bridged branch, the label, status, model, and the recursive
/// grandchild nodes. `None` when the dir holds no readable session.
pub fn load_context_tree_child(
    artifacts_root: &Path,
    child_dir: &Path,
    registry: &ModelRegistry,
    ledger: &ContextLedger,
) -> Option<Value> {
    load_context_tree_child_with_path(artifacts_root, child_dir, registry, ledger)
        .filter(|(path, _)| !ledger.is_tombstoned_file(path))
        .map(|(_, node)| node)
}

/// The node and the exact file it read, so a stale live roster snapshot
/// can be fenced against durable tombstones without hiding a reused id.
pub(crate) fn load_context_tree_child_with_path(
    artifacts_root: &Path,
    child_dir: &Path,
    registry: &ModelRegistry,
    ledger: &ContextLedger,
) -> Option<(PathBuf, Value)> {
    // The newest VALID session file: artifact dirs carry sibling `.jsonl`
    // files that are not sessions, so candidates are tried newest-first.
    let store = newest_session_files(child_dir)
        .iter()
        .find_map(|file| SessionFile::open(file).ok())?;
    // Label, status, and model follow the same gap-bridged branch as the
    // usage totals: a ghost-parent gap must not strip a child of its identity.
    let branch = store.branch_bridged();
    let all_entries = store.entries();
    let (own_usage, total_usage) =
        crate::state_getters::compute_own_and_total_usage(&branch, all_entries);
    // The per-model own-usage breakdown rides the child node too (a child
    // that itself switched models shows which model billed its spend).
    let own_usage_by_model = crate::state_getters::compute_own_usage_by_model(
        &branch,
        all_entries,
        &own_usage,
        store.window_boundary_model().as_ref(),
    );
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
        if let Some(usage) =
            store_context_usage(&store, context_window_of(registry, provider, model_id))
        {
            node["contextUsage"] = usage;
        }
    }
    if let Some(by_model) = own_usage_by_model {
        node["ownUsageByModel"] = json!(by_model);
    }
    ledger.tag(&mut node, &store.path);
    // The child's own deleted subagents stay hidden one level down and
    // bill through their deleted rows: the ledger keys by the deleted
    // child's parent session file.
    let mut children = load_context_tree_children(
        artifacts_root,
        store.session_id(),
        registry,
        &ledger.tombstoned_ids(&store.path),
        ledger,
    );
    children.extend(ledger.deleted_nodes(&store.path));
    node["children"] = Value::Array(children);
    Some((store.path, node))
}

/// Build the nodes for every persisted child dir of one session (TS
/// `loadContextTreeChildrenFromDisk`): the `sub-*` dirs under
/// `<artifacts_root>/<session_id>/`, skipping already-represented ids.
pub fn load_context_tree_children(
    artifacts_root: &Path,
    session_id: &str,
    registry: &ModelRegistry,
    skip_ids: &HashSet<String>,
    ledger: &ContextLedger,
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
            load_context_tree_child(artifacts_root, &child_dir, registry, ledger)
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
        .filter_map(std::result::Result::ok)
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

/// The `.jsonl` files in a dir, newest first: opens keep the first
/// readable session, skipping non-session siblings.
fn newest_session_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(std::result::Result::ok)
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
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(child_dir.join(format!("{session_id}.jsonl")), content).unwrap();
        child_dir
    }

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
            &ContextLedger::default(),
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
        let node =
            load_context_tree_child(&artifacts, &errored, &registry(), &ContextLedger::default())
                .expect("node builds");
        assert_eq!(node["status"], json!("error"));
        let aborted = write_child(&parent, "sub-aborted", "01a0child-0002", "aborted");
        let node =
            load_context_tree_child(&artifacts, &aborted, &registry(), &ContextLedger::default())
                .expect("node builds");
        assert_eq!(node["status"], json!("cancelled"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A subagent's node attributes its spend to ITS model: the by-model bucket
    /// subtracts the grandchild's attribution exactly like `ownUsage`
    /// ($0.065 = $0.088 aggregate - $0.023 grandchild).
    #[test]
    fn disk_child_attributes_its_own_spend_to_its_model() {
        let root = dir();
        let artifacts = root.join("session-artifacts");
        let parent = artifacts.join("01a0parent-0000");
        let child_dir = parent.join("sub-opus-worker");
        std::fs::create_dir_all(&child_dir).unwrap();
        let own_usage = json!({
            "input": 5000, "output": 1000, "cacheRead": 0, "cacheWrite": 0,
            "totalTokens": 6100,
            "cost": {"input": 0.025, "output": 0.025, "cacheRead": 0,
                      "cacheWrite": 0, "total": 0.065},
        });
        let child_usage = json!({
            "input": 1000, "output": 200, "cacheRead": 0, "cacheWrite": 0,
            "totalTokens": 300,
            "cost": {"input": 0.01, "output": 0.01, "cacheRead": 0,
                      "cacheWrite": 0, "total": 0.023},
        });
        let aggregate_usage = json!({
            "input": 6000, "output": 1200, "cacheRead": 0, "cacheWrite": 0,
            "totalTokens": 6100,
            "cost": {"input": 0.035, "output": 0.035, "cacheRead": 0,
                      "cacheWrite": 0, "total": 0.088},
        });
        let lines = [
            json!({
                "type": "session", "version": 3, "id": "01a0child-opus",
                "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp",
            }),
            json!({
                "type": "model_change", "id": "c0", "parentId": null,
                "timestamp": "2026-09-22T00:00:00.500Z",
                "provider": "anthropic", "modelId": "claude-opus-4-6",
            }),
            json!({
                "type": "message", "id": "c1", "parentId": "c0",
                "timestamp": "2026-09-22T00:00:01.000Z",
                "message": {"role": "user", "content": "port the audit trail"},
            }),
            json!({
                "type": "message", "id": "c2", "parentId": "c1",
                "timestamp": "2026-09-22T00:00:02.000Z",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "done" }],
                    "provider": "anthropic", "model": "claude-opus-4-6",
                    "stopReason": "stop", "usage": own_usage,
                },
            }),
            json!({
                "type": "child_usage_attributed", "id": "c3", "parentId": "c2",
                "timestamp": "2026-09-22T00:00:03.000Z",
                "targetId": "c2", "childUsage": child_usage,
                "aggregateUsage": aggregate_usage,
            }),
        ];
        let content = lines
            .iter()
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(child_dir.join("01a0child-opus.jsonl"), content).unwrap();
        let node = load_context_tree_child(
            &artifacts,
            &child_dir,
            &registry(),
            &ContextLedger::default(),
        )
        .expect("node builds");
        assert_eq!(
            node["model"],
            json!({ "provider": "anthropic", "id": "claude-opus-4-6" })
        );
        // The own/total split keeps the accounting reader's contract.
        assert_eq!(node["ownUsage"]["input"], json!(5000));
        assert_eq!(node["ownUsage"]["output"], json!(1000));
        assert_eq!(node["totalUsage"]["input"], json!(6000));
        assert_eq!(
            node["ownUsage"]["cost"]["total"].as_f64(),
            Some(0.088 - 0.023)
        );
        let buckets = node["ownUsageByModel"]
            .as_array()
            .expect("the by-model breakdown is present");
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0]["provider"], json!("anthropic"));
        assert_eq!(buckets[0]["id"], json!("claude-opus-4-6"));
        assert_eq!(buckets[0]["ownUsage"]["input"], json!(5000));
        assert_eq!(buckets[0]["ownUsage"]["output"], json!(1000));
        assert_eq!(buckets[0]["ownUsage"]["totalTokens"], json!(5800));
        assert_eq!(
            buckets[0]["ownUsage"]["cost"]["total"].as_f64(),
            Some(0.088 - 0.023)
        );
        // A file whose usage rows resolve to no model degrades to the
        // plain totals: no partial breakdown (an absent wire field).
        let modelless = parent.join("sub-modelless");
        std::fs::create_dir_all(&modelless).unwrap();
        let bare = [
            json!({
                "type": "session", "version": 3, "id": "01a0child-bare",
                "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp",
            }),
            json!({
                "type": "message", "id": "b1", "parentId": null,
                "timestamp": "2026-09-22T00:00:01.000Z",
                "message": {"role": "user", "content": "hi"},
            }),
            json!({
                "type": "message", "id": "b2", "parentId": "b1",
                "timestamp": "2026-09-22T00:00:02.000Z",
                "message": {"role": "assistant",
                            "content": [{ "type": "text", "text": "x" }],
                            "stopReason": "stop", "usage": own_usage},
            }),
        ];
        let content = bare
            .iter()
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(modelless.join("01a0child-bare.jsonl"), content).unwrap();
        let node = load_context_tree_child(
            &artifacts,
            &modelless,
            &registry(),
            &ContextLedger::default(),
        )
        .expect("node builds");
        assert!(node.get("ownUsageByModel").is_none());
        assert!(node.get("model").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

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
            &HashSet::default(),
            &ContextLedger::default(),
        );
        assert_eq!(nodes.len(), 2, "non-sub dirs and empty dirs drop out");

        let skip: HashSet<String> = ["sub-a".to_string()].into_iter().collect();
        let nodes = load_context_tree_children(
            &artifacts,
            "01a0parent-0000",
            &registry,
            &skip,
            &ContextLedger::default(),
        );
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0]["id"], json!("sub-b"));
        let _ = std::fs::remove_dir_all(&root);
    }

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
            &ContextLedger::default(),
        )
        .expect("node builds");
        let grandchildren = node["children"].as_array().expect("children");
        assert_eq!(grandchildren.len(), 1, "the decoy dir drops out");
        assert_eq!(grandchildren[0]["id"], json!("sub-grand"));
        assert_eq!(grandchildren[0]["ownUsage"]["totalTokens"], json!(15));
        let _ = std::fs::remove_dir_all(&root);
    }

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
        let mut ledger = ContextLedger::default();
        ledger
            .tombstoned
            .entry(crate::lease::canonical_session_path(
                &child_dir.join("01a0child-0000.jsonl"),
            ))
            .or_default()
            .insert("sub-dead".to_string());
        let node = load_context_tree_child(&artifacts, &child_dir, &registry(), &ledger)
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
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(child_dir.join("01a0child-0000.jsonl"), content).unwrap();
        let node = load_context_tree_child(
            &artifacts,
            &child_dir,
            &registry(),
            &ContextLedger::default(),
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

    #[test]
    fn session_artifacts_dir_follows_the_agent_dir() {
        assert_eq!(
            session_artifacts_dir(Path::new("/agent")),
            Path::new("/agent/session-artifacts"),
        );
    }
}
