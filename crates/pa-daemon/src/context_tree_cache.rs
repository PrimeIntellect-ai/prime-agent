//! The `get_context_tree` children cache: the background refresh behind
//! `/context`'s children rows.
//!
//! The children of the context tree are store-dependent disk data: each
//! persisted child dir's newest session file is read and parsed, usage
//! recomputed, and grandchildren walked recursively
//! (`context_tree_children`). On a grown session store that walk is a
//! multi-second read, so it runs here as a single-flight background
//! refresh and `get_context_tree` serves the cached snapshot instantly:
//!
//! - the root node (usage totals, context usage, label, model) is
//!   computed from the in-memory store on every request
//!   (`state_getters::handle_get_context_tree`);
//! - the live roster stays fresh per read: the registry snapshot is read
//!   per request and its identity/status overlaid on the cached bodies
//!   (a child that settled between refreshes keeps its last cached row
//!   until the next refresh files it under the persisted children);
//! - the cached bodies (usage, model, grandchildren) are as fresh as the
//!   last completed refresh — a display tree's point-in-time snapshot,
//!   the same staleness the walk always accepted implicitly by racing
//!   child turns;
//! - the refresh re-arms on every read older than [`REFRESH_TTL`] (and
//!   immediately when the session changed — fork/switch), is warmed at
//!   create/attach, and is replaced-session-guarded: a snapshot from
//!   another session never serves.
//!
//! A cold cache serves the root plus live rows alone; the full tree
//! fills on the next read after the walk lands.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{json, Value};

use crate::state_getters::empty_usage;

/// The refresh poke window: a read older than this re-arms the background
/// walk (one walk in flight at a time). The TTL bounds the age of the
/// cached usage/grandchildren bodies only — live identities and statuses
/// are overlaid fresh on every request.
pub(crate) const REFRESH_TTL: Duration = Duration::from_secs(1);

/// One completed background walk.
#[derive(Debug, Clone)]
pub(crate) struct CachedWalk {
    pub(crate) computed_at: Instant,
    /// The durable session id the walk resolved against: a replaced
    /// session (fork/switch) invalidates the snapshot on read — the old
    /// session's children must never leak into the new session's tree.
    session_id: String,
    /// Live-child nodes keyed by the registry's child id (the walk's
    /// file-derived body with the refresh-time identity overlay; serve
    /// re-overlays the fresh identity).
    live_nodes: HashMap<String, Value>,
    /// Persisted child dirs' nodes (everything the walk loaded that was
    /// not live at refresh time), in the walk's mtime order.
    persisted: Vec<Value>,
}

/// The per-worker context-tree cache: the data swap under a std mutex
/// (never held across an await) plus the single-flight refresh guard.
#[derive(Debug, Default)]
pub(crate) struct ContextTreeCache {
    state: Mutex<Option<CachedWalk>>,
    refresh: tokio::sync::Mutex<()>,
}

impl ContextTreeCache {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Assemble the `get_context_tree` children from the cache and the
    /// fresh live roster snapshot: every live child appears with its fresh
    /// identity and status over the cached body (the same minimal
    /// usage-empty fallback the walk uses for a live child whose dir is
    /// unreadable). A child that was live at refresh and has since
    /// settled (its worker exited) keeps its last cached row until the
    /// next refresh files it under the persisted children — a settling
    /// child never vanishes from the tree between refreshes. Then the
    /// persisted children, minus any whose id went live since the refresh
    /// (its live row already shows). A cold cache yields the live rows
    /// alone (the disk tree fills on the next read after the
    /// warm/poked walk lands).
    pub(crate) fn serve_children(
        &self,
        current_session_id: Option<&str>,
        snapshots: &[Value],
    ) -> Vec<Value> {
        let cached = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .filter(|walk| {
                // A snapshot from a previous session (fork/switch) is not
                // this session's tree: serve the live rows alone and let
                // the poke refresh the new session.
                Some(walk.session_id.as_str()) == current_session_id
            });
        let mut children = Vec::with_capacity(
            snapshots.len() + cached.as_ref().map_or(0, |walk| walk.persisted.len()),
        );
        let mut live_ids: HashSet<String> = HashSet::with_capacity(snapshots.len());
        for snapshot in snapshots {
            let id = snapshot
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            live_ids.insert(id.to_string());
            let mut node = cached
                .as_ref()
                .and_then(|walk| walk.live_nodes.get(id))
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "ownUsage": empty_usage(),
                        "totalUsage": empty_usage(),
                        "children": [],
                    })
                });
            node["id"] = snapshot.get("id").cloned().unwrap_or(Value::Null);
            node["label"] = snapshot.get("label").cloned().unwrap_or(Value::Null);
            node["status"] = snapshot.get("status").cloned().unwrap_or(Value::Null);
            children.push(node);
        }
        if let Some(walk) = cached {
            // Settled since the refresh: keep the last cached body in the
            // tree until the next refresh files it under the persisted
            // children (the registry no longer lists it; the disk walk
            // will).
            children.extend(walk.live_nodes.into_values().filter(|node| {
                node.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !live_ids.contains(id))
            }));
            children.extend(walk.persisted.into_iter().filter(|node| {
                node.get("id")
                    .and_then(Value::as_str)
                    .is_none_or(|id| !live_ids.contains(id))
            }));
        }
        children
    }

    /// Re-arm the background walk when the cached snapshot is missing,
    /// older than [`REFRESH_TTL`], or was taken for a DIFFERENT session
    /// (a fork/switch replacement must walk its own tree immediately, not
    /// wait out the previous session's TTL). Single flight: while one
    /// walk is in progress, pokes return without spawning (the in-flight
    /// walk stores a newer snapshot than any poke could). The engine's
    /// roster snapshot is read inside the task, so sync callers
    /// (create/attach warm, the request handler) never block on it.
    pub(crate) fn poke_refresh(
        self: &Arc<Self>,
        engine: Arc<dyn crate::engine::SessionEngine>,
        agent_dir: PathBuf,
        current_session_id: Option<String>,
        session_file: Option<PathBuf>,
    ) {
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.as_ref().is_some_and(|walk| {
                Some(walk.session_id.as_str()) == current_session_id.as_deref()
                    && walk.computed_at.elapsed() < REFRESH_TTL
            }) {
                return;
            }
        }
        let cache = Arc::clone(self);
        tokio::spawn(async move {
            // No session yet (the create path warms before the store
            // lands): nothing to walk, the next read re-arms.
            let Some(session_id) = current_session_id else {
                return;
            };
            // Single flight: the guard is taken inside the task, against
            // the owned cache clone (a guard on `self` cannot outlive
            // this method's borrow); while one walk is in progress a
            // poke's task takes nothing and returns, and the in-flight
            // walk stores a newer snapshot than any poke could.
            let Ok(_guard) = cache.refresh.try_lock() else {
                return;
            };
            let snapshots = engine.rlm_child_snapshots().await;
            let registry_dir = agent_dir.clone();
            let walk_session_id = session_id.clone();
            let walk_session_file = session_file.clone();
            let walk = tokio::task::spawn_blocking(move || {
                walk_children(
                    &registry_dir,
                    &walk_session_id,
                    &snapshots,
                    walk_session_file.as_deref(),
                )
            })
            .await;
            match walk {
                Ok(Ok((live_nodes, persisted))) => {
                    let mut state = cache
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    *state = Some(CachedWalk {
                        computed_at: Instant::now(),
                        session_id,
                        live_nodes,
                        persisted,
                    });
                }
                Ok(Err(error)) => {
                    eprintln!("context tree walk failed: {error:#}");
                }
                Err(error) => {
                    eprintln!("context tree walk join failed: {error:#}");
                }
            }
            // The single-flight guard drops with the task, releasing the
            // next poke's walk.
        });
    }
}

/// One full artifact-tree walk (the computation `handle_get_context_tree`
/// ran inline per request before the cache): the model registry, the RLM
/// ledger's tombstones, every live child's file-derived node, and every
/// persisted child dir under the session's own artifact tree. Runs on the
/// blocking pool only; never on the request path.
fn walk_children(
    agent_dir: &Path,
    session_id: &str,
    snapshots: &[Value],
    session_file: Option<&Path>,
) -> Result<(HashMap<String, Value>, Vec<Value>)> {
    let registry = crate::state_getters::worker_model_registry(agent_dir);
    let artifacts_root = crate::context_tree_children::session_artifacts_dir(agent_dir);
    // User-deleted subagents stay hidden at every depth: the ledger's
    // tombstones key by the deleted child's parent session file, so this
    // session's deletions resolve into the root skip set and the record
    // hands down for each recursion level to resolve its own (the TS
    // in-memory guard is its restart-behavior; the ledger is the durable
    // authority here). Unreadable ledgers degrade to no filtering, never
    // a failed tree.
    let mut skip_ids: HashSet<String> = snapshots
        .iter()
        .filter_map(|child| child.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let mut tombstones = crate::context_tree_children::TombstonedChildren::new();
    let sessions_dir = agent_dir.join("sessions");
    let ledger = crate::rlm_ledger::RlmSpawnLedger::new(agent_dir, &sessions_dir, |_| {});
    if let Ok(edges) = ledger.edges(true) {
        for edge in edges {
            if edge.deleted.is_some() {
                tombstones
                    .entry(crate::lease::canonical_session_path(Path::new(
                        &edge.parent,
                    )))
                    .or_default()
                    .insert(edge.child_id.clone());
            }
        }
    }
    if let Some(session_file) = session_file {
        if let Some(deleted) = tombstones.get(&crate::lease::canonical_session_path(session_file)) {
            skip_ids.extend(deleted.iter().cloned());
        }
    }
    // Live children (TS: `run.session?.getContextTree() ??
    // loadContextTreeChildFromDisk(...)`): the node carries the child's
    // real usage and its recursive grandchildren; the registry supplies
    // the fresher identity.
    let mut live_nodes = HashMap::with_capacity(snapshots.len());
    for child in snapshots {
        let mut node = child
            .get("sessionDir")
            .and_then(Value::as_str)
            .and_then(|dir| {
                crate::context_tree_children::load_context_tree_child(
                    &artifacts_root,
                    Path::new(dir),
                    &registry,
                    &tombstones,
                )
            })
            .unwrap_or_else(|| {
                json!({
                    "ownUsage": empty_usage(),
                    "totalUsage": empty_usage(),
                    "children": [],
                })
            });
        node["id"] = child.get("id").cloned().unwrap_or(Value::Null);
        node["label"] = child.get("label").cloned().unwrap_or(Value::Null);
        node["status"] = child.get("status").cloned().unwrap_or(Value::Null);
        let id = node
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        live_nodes.insert(id, node);
    }
    let persisted = crate::context_tree_children::load_context_tree_children(
        &artifacts_root,
        session_id,
        &registry,
        &skip_ids,
        &tombstones,
    );
    Ok((live_nodes, persisted))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seed the cache with one completed walk.
    fn cache_with_walk(
        session_id: &str,
        live: &[(&str, u64)],
        persisted: &[&str],
    ) -> Arc<ContextTreeCache> {
        let cache = Arc::new(ContextTreeCache::new());
        *cache.state.lock().unwrap() = Some(CachedWalk {
            computed_at: Instant::now(),
            session_id: session_id.to_string(),
            live_nodes: live
                .iter()
                .map(|(id, input)| {
                    (
                        id.to_string(),
                        json!({
                            "id": id,
                            "label": "child",
                            "status": "completed",
                            "ownUsage": empty_usage(),
                            "totalUsage": { "input": input, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": input, "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 } },
                            "children": [],
                        }),
                    )
                })
                .collect(),
            persisted: persisted
                .iter()
                .map(|id| {
                    json!({
                        "id": id,
                        "label": "persisted child",
                        "status": "idle",
                        "ownUsage": empty_usage(),
                        "totalUsage": empty_usage(),
                        "children": [],
                    })
                })
                .collect(),
        });
        cache
    }

    fn snapshot(id: &str, status: &str) -> Value {
        json!({ "id": id, "label": "child", "status": status })
    }

    /// A child that was live at refresh and has since settled (the
    /// registry no longer lists it) keeps its last cached row until the
    /// next refresh files it under the persisted children — it never
    /// vanishes from the tree between refreshes.
    #[test]
    fn settled_children_keep_their_cached_row() {
        let cache = cache_with_walk("session-a", &[("child-live", 100)], &[]);
        // The roster no longer lists the child (it settled).
        let children = cache.serve_children(Some("session-a"), &[]);
        assert_eq!(children.len(), 1, "the settled child keeps its row");
        assert_eq!(children[0]["id"], json!("child-live"));
        assert_eq!(
            children[0]["totalUsage"]["input"],
            json!(100),
            "the cached body's usage rides the row"
        );
    }

    /// A snapshot taken for another session (fork/switch) never serves:
    /// the new session's tree starts from its live rows alone.
    #[test]
    fn replaced_session_snapshots_never_serve() {
        let cache = cache_with_walk("session-old", &[("child-live", 100)], &["child-disk"]);
        let children = cache.serve_children(Some("session-new"), &[]);
        assert!(
            children.is_empty(),
            "the previous session's children must not leak: {children:?}"
        );
        // The same session still serves.
        let children = cache.serve_children(Some("session-old"), &[]);
        assert_eq!(children.len(), 2, "live backfill + persisted row");
    }

    /// The live overlay wins over the cached identity: a running child's
    /// status is fresh even while its cached usage body is a refresh old.
    #[test]
    fn live_identity_overlays_the_cached_body() {
        let cache = cache_with_walk("session-a", &[("child-live", 100)], &[]);
        let children =
            cache.serve_children(Some("session-a"), &[snapshot("child-live", "working")]);
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["status"], json!("working"));
        assert_eq!(children[0]["totalUsage"]["input"], json!(100));
    }

    /// A cold cache yields the live rows alone (the disk tree fills on the
    /// next read after the warm/poked walk lands).
    #[test]
    fn cold_cache_serves_live_rows_with_the_usage_fallback() {
        let cache = ContextTreeCache::new();
        let children =
            cache.serve_children(Some("session-a"), &[snapshot("child-cold", "working")]);
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["id"], json!("child-cold"));
        assert_eq!(
            children[0]["totalUsage"]["input"],
            json!(0),
            "the fallback node is usage-empty until the walk lands"
        );
    }
}
