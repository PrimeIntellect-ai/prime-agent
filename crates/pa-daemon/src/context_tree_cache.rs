//! The `get_context_tree` children cache: the grown-store latency fix for
//! the operator's `/context` timeout ("timed out after 10000ms waiting for
//! the Prime Agent daemon response", 2026-09-24).
//!
//! The context-tree walk is store-dependent disk work: every live child's
//! session file is re-read and fully parsed, then every persisted child dir
//! under the session's artifact tree is opened newest-file-first and
//! recursively walked for grandchildren (`context_tree_children`). On a
//! grown fleet store (hundreds of subagent session dirs, child files in
//! the megabytes — measured live on the devbox: 66 persisted children over
//! 553MB of artifacts answering `get_context_tree` in 14-19s per call,
//! while `get_session_stats` over the same in-memory store answered in
//! 0.1s) that walk takes many seconds, and because `/context` awaited it
//! inline the request spent the whole walk inside the worker's dispatch.
//!
//! Product invariant (operator directive, 2026-09-24): no user-visible
//! command may queue behind multi-second work — in-memory data answers from
//! memory, and store-dependent snapshots come from a background refresh.
//! The cache keeps the walk's expensive part (file reads and parses) on a
//! background task while everything in memory stays fresh per request:
//! - the root node (usage totals, context usage, label, model) is computed
//!   from the in-memory store on every request (`state_getters`);
//! - live roster children keep fresh identity and status: the registry
//!   snapshot is read per request and overlaid over the cached bodies;
//! - the cached bodies (usage, model, grandchildren) are as fresh as the
//!   last completed refresh — a display tree's point-in-time snapshot,
//!   the same staleness the walk always accepted implicitly by racing
//!   child turns; live statuses never lag.
//!
//! The refresh is poked on every read older than [`REFRESH_TTL`] (single
//! flight: one walk in progress at a time) and warmed at session open
//! (create/attach), so the first `/context` after a worker start usually
//! finds the cache already filled; a cold-cache read serves the root plus
//! live children instantly and the full persisted tree on the next read.

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
    /// unreadable), then the persisted children — a persisted dir whose id
    /// went live since the refresh is dropped, because its live row
    /// already shows. A cold cache yields the live rows alone (the disk
    /// tree fills on the next read after the warm/poked walk lands).
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
            children.extend(walk.persisted.into_iter().filter(|node| {
                node.get("id")
                    .and_then(Value::as_str)
                    .is_none_or(|id| !live_ids.contains(id))
            }));
        }
        children
    }

    /// Re-arm the background walk when the cached snapshot is missing or
    /// older than [`REFRESH_TTL`]. Single flight: while one walk is in
    /// progress, pokes return without spawning (the in-flight walk stores
    /// a newer snapshot than any poke could). The engine's roster
    /// snapshot is read inside the task, so sync callers (create/attach
    /// warm, the request handler) never block on it.
    pub(crate) fn poke_refresh(
        self: &Arc<Self>,
        engine: Arc<dyn crate::engine::SessionEngine>,
        agent_dir: PathBuf,
        session_id: Option<String>,
        session_file: Option<PathBuf>,
    ) {
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state
                .as_ref()
                .is_some_and(|walk| walk.computed_at.elapsed() < REFRESH_TTL)
            {
                return;
            }
        }
        let Ok(guard) = self.refresh.try_lock() else {
            return;
        };
        let cache = Arc::clone(self);
        tokio::spawn(async move {
            // No session yet (the create path warms before the store
            // lands): nothing to walk, the next read re-arms.
            let Some(session_id) = session_id else {
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
            drop(guard);
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
