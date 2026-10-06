//! The `get_context_tree` children cache: the background refresh behind
//! `/context`'s children rows. The children walk is multi-second disk data
//! on a grown store, so it runs as a single-flight background refresh; a
//! snapshot from another session never serves. A cold cache serves the
//! live rows alone.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{json, Value};

use crate::state_getters::empty_usage;

/// The refresh poke window: a read older than this re-arms the background
/// walk (one walk in flight at a time). Bounds only the cached bodies.
pub(crate) const REFRESH_TTL: Duration = Duration::from_secs(1);

/// One completed background walk.
#[derive(Debug, Clone)]
pub(crate) struct CachedWalk {
    pub(crate) computed_at: Instant,
    /// The durable session id the walk resolved against: a replaced
    /// session (fork/switch) invalidates the snapshot on read.
    session_id: String,
    /// Live-child nodes keyed by the registry's child id (the walk's
    /// file-derived body; serve re-overlays the fresh identity).
    live_nodes: HashMap<String, Value>,
    /// Persisted child dirs' nodes, in the walk's mtime order.
    persisted: Vec<Value>,
}

/// The per-worker context-tree cache: the data swap under a std mutex
/// (never held across an await) plus the single-flight refresh guard.
#[derive(Debug, Default)]
pub(crate) struct ContextTreeCache {
    state: Mutex<Option<CachedWalk>>,
    refresh: tokio::sync::Mutex<()>,
    /// Child ids invalidated since the last walk stored: an in-flight walk
    /// that started BEFORE a deletion must not republish the child.
    invalidated: Mutex<HashSet<String>>,
    /// A poke that arrived while another walk held the guard and targets a
    /// session the in-flight walk does NOT serve: the completing walk
    /// re-arms it. The last poke wins.
    pending: Mutex<Option<(String, Option<PathBuf>)>>,
    /// The session the CURRENT in-flight walk serves (the published
    /// snapshot is NOT a proxy for it: after a fork the in-flight walk
    /// serves the new session while the published one is still the old).
    in_flight: Mutex<Option<String>>,
}

impl ContextTreeCache {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Assemble the `get_context_tree` children from the cache and the fresh
    /// live roster snapshot: every live child appears with its fresh identity
    /// and status over the cached body (or the usage-empty fallback), then
    /// the settled and persisted children minus any whose id went live.
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
                // this session's tree: serve the live rows alone.
                Some(walk.session_id.as_str()) == current_session_id
            });
        let invalidated = {
            let invalidated = self
                .invalidated
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            invalidated.clone()
        };
        let deleted = |node: &Value| {
            node.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| invalidated.contains(id))
        };
        // A live row's cached body: the live-node entry first, then the
        // persisted row with the same id — a child that went live AFTER the
        // walk's roster snapshot often already carries real usage in `persisted`.
        let mut persisted_by_id: HashMap<String, Value> = HashMap::new();
        if let Some(walk) = cached.as_ref() {
            for node in &walk.persisted {
                if let Some(id) = node.get("id").and_then(Value::as_str) {
                    persisted_by_id.insert(id.to_string(), node.clone());
                }
            }
        }
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
            if invalidated.contains(id) {
                // A deletion that outran the roster removal: the row must not come back.
                continue;
            }
            let mut node = cached
                .as_ref()
                .and_then(|walk| walk.live_nodes.get(id))
                .cloned()
                .or_else(|| persisted_by_id.get(id).cloned())
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
            // Settled since the refresh: keep the last cached body until the next refresh files it.
            children.extend(walk.live_nodes.into_values().filter(|node| {
                node.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !live_ids.contains(id))
                    && !deleted(node)
            }));
            children.extend(walk.persisted.into_iter().filter(|node| {
                node.get("id")
                    .and_then(Value::as_str)
                    .is_none_or(|id| !live_ids.contains(id))
                    && !deleted(node)
            }));
        }
        children
    }

    /// Drop one child's cached rows (the `delete_subagent` boundary): a
    /// deleted subagent leaves the tree immediately, not at the next refresh.
    pub(crate) fn invalidate_child(&self, child_id: &str) {
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(walk) = state.as_mut() {
                walk.live_nodes.remove(child_id);
                walk.persisted
                    .retain(|node| node.get("id").and_then(Value::as_str) != Some(child_id));
            }
        }
        self.invalidated
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(child_id.to_string());
    }

    /// Re-arm the background walk when the cached snapshot is missing, older
    /// than [`REFRESH_TTL`], or was taken for a DIFFERENT session. Single
    /// flight: while one walk is in progress, pokes return without spawning.
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
            // No session yet (the create path warms before the store lands): nothing to walk.
            let Some(first) = current_session_id else {
                return;
            };
            let mut request = (first, session_file);
            loop {
                let Ok(_guard) = cache.refresh.try_lock() else {
                    // A walk is in flight: record this poke unless the in-flight walk already
                    // serves this session — the completing walk re-arms a DIFFERENT session's
                    // tree itself. `in_flight` is the guard holder's own record.
                    let in_flight = {
                        let in_flight = cache
                            .in_flight
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        in_flight.clone()
                    };
                    if in_flight.as_deref() != Some(request.0.as_str()) {
                        *cache
                            .pending
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(request);
                    }
                    return;
                };
                let (session_id, session_file) = request;
                *cache
                    .in_flight
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(session_id.clone());
                // Another task may have completed a fresh walk between this poke's TTL check
                // and its guard acquisition: recheck so redundant walks cannot serialize.
                let already_fresh = {
                    let state = cache
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    state.as_ref().is_some_and(|walk| {
                        walk.session_id == session_id && walk.computed_at.elapsed() < REFRESH_TTL
                    })
                };
                if already_fresh {
                    request = match cache
                        .pending
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .take()
                    {
                        Some((pending_id, pending_file)) if pending_id != session_id => {
                            (pending_id, pending_file)
                        }
                        _ => {
                            *cache
                                .in_flight
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                            return;
                        }
                    };
                    continue;
                }
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
                    Ok(Ok((mut live_nodes, mut persisted))) => {
                        let mut invalidated = cache
                            .invalidated
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        // Deletions that landed while this walk ran must not be
                        // republished by the stale snapshot. The set drains here.
                        for child_id in invalidated.iter() {
                            live_nodes.remove(child_id);
                            persisted.retain(|node| {
                                node.get("id").and_then(Value::as_str) != Some(child_id)
                            });
                        }
                        invalidated.clear();
                        let mut state = cache
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        *state = Some(CachedWalk {
                            computed_at: Instant::now(),
                            session_id: session_id.clone(),
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
                // Drain a pending session (a replaced session that poked
                // while this walk ran): serve it in this same task.
                request = match cache
                    .pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                {
                    Some((pending_id, pending_file)) if pending_id != session_id => {
                        (pending_id, pending_file)
                    }
                    _ => {
                        *cache
                            .in_flight
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                        return;
                    }
                };
            }
        });
    }
}

/// One full artifact-tree walk: the model registry, the ledger tombstones,
/// every live child's file-derived node, and every persisted child dir under
/// the session's artifact tree. Blocking pool only.
fn walk_children(
    agent_dir: &Path,
    session_id: &str,
    snapshots: &[Value],
    session_file: Option<&Path>,
) -> Result<(HashMap<String, Value>, Vec<Value>)> {
    let registry = crate::state_getters::worker_model_registry(agent_dir);
    let artifacts_root = crate::context_tree_children::session_artifacts_dir(agent_dir);
    // User-deleted subagents stay hidden at every depth: the tombstones key by the deleted
    // child's parent session file, so this session's deletions resolve into the root skip
    // set and each recursion level its own. Unreadable ledgers degrade to no filtering.
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
    // Live children: the node carries the child's real usage and its
    // recursive grandchildren; the registry supplies the fresher identity.
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

    #[test]
    fn live_identity_overlays_the_cached_body() {
        let cache = cache_with_walk("session-a", &[("child-live", 100)], &[]);
        let children =
            cache.serve_children(Some("session-a"), &[snapshot("child-live", "working")]);
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["status"], json!("working"));
        assert_eq!(children[0]["totalUsage"]["input"], json!(100));
    }

    #[test]
    fn invalidated_children_leave_the_tree_immediately() {
        let cache = cache_with_walk("session-a", &[("child-live", 100)], &["child-disk"]);
        cache.invalidate_child("child-live");
        cache.invalidate_child("child-disk");
        let children = cache.serve_children(Some("session-a"), &[]);
        assert!(
            children.is_empty(),
            "deleted children must leave the tree immediately: {children:?}"
        );
        // A stale snapshot published after the invalidation must not bring
        // the child back at serve time.
        *cache.state.lock().unwrap() = Some(CachedWalk {
            computed_at: Instant::now(),
            session_id: "session-a".to_string(),
            live_nodes: [(
                "child-live".to_string(),
                json!({ "id": "child-live", "totalUsage": empty_usage() }),
            )]
            .into_iter()
            .collect(),
            persisted: vec![json!({
                "id": "child-disk",
                "totalUsage": empty_usage(),
            })],
        });
        let children = cache.serve_children(Some("session-a"), &[]);
        assert!(
            children.is_empty(),
            "a stale walk's publish must not resurrect a deleted child: {children:?}"
        );
    }

    #[test]
    fn an_in_flight_walk_cannot_republish_a_deleted_child() {
        let cache = cache_with_walk("session-a", &[("child-live", 100)], &[]);
        cache.invalidate_child("child-live");
        // Simulate the in-flight walk's store step (the stale snapshot
        // still contains the child).
        let mut live_nodes = HashMap::new();
        live_nodes.insert(
            "child-live".to_string(),
            json!({ "id": "child-live", "totalUsage": empty_usage() }),
        );
        let mut invalidated = cache
            .invalidated
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for child_id in invalidated.iter() {
            live_nodes.remove(child_id);
        }
        invalidated.clear();
        assert!(
            live_nodes.is_empty(),
            "the deleted child must not be republished"
        );
    }

    #[test]
    fn a_newly_live_child_rides_its_cached_persisted_usage() {
        // The persisted row carries REAL usage (the seeded tree's spend) —
        // the live snapshot only supplies identity, so a served
        // totalUsage matching it proves the persisted body rode the row.
        let cache = Arc::new(ContextTreeCache::new());
        *cache.state.lock().unwrap() = Some(CachedWalk {
            computed_at: Instant::now(),
            session_id: "session-a".to_string(),
            live_nodes: HashMap::new(),
            persisted: vec![json!({
                "id": "sub-late",
                "label": "persisted child",
                "status": "idle",
                "ownUsage": empty_usage(),
                "totalUsage": { "input": 77, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 77, "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 } },
                "children": [],
            })],
        });
        let children = cache.serve_children(Some("session-a"), &[snapshot("sub-late", "working")]);
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["id"], json!("sub-late"));
        assert_eq!(
            children[0]["status"],
            json!("working"),
            "the fresh live identity"
        );
        assert_eq!(
            children[0]["totalUsage"]["input"],
            json!(77),
            "the persisted row's body served the live row: {children:?}"
        );
    }

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
