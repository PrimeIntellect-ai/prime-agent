//! The read-only state getters (protocol breadth wave b2): the worker
//! arms for the daemon `get_*` commands that surfaced no handler before
//! this wave (TS daemon-mode `case "get_connection_state"` ... `case
//! "get_tool_definition"`). Each handler answers the exact TS wire shape;
//! the data comes from the worker's persisted session store, the engine
//! seams (`SessionEngine::rlm_child_snapshots` / `connection_commands` /
//! `resource_snapshot` / `system_prompt` / `tool_definition` /
//! `rlm_max_depth_status`), and the model registry.

use serde_json::{json, Value};

use pa_core::models::ModelRegistry;

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

impl Worker {
    /// `get_connection_state`: the connection state block (the same shape
    /// the attach snapshot carries) with the TS `createConnectionState`
    /// `heartbeat` overlay (this worker owns no cron store, so the
    /// overlay is the TS null).
    pub(crate) fn handle_get_connection_state(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_connection_state") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let state = self.connection_state_locked(&core);
        drop(core);
        let mut value = serde_json::to_value(&state).unwrap_or(Value::Null);
        value["heartbeat"] = Value::Null;
        response_success(None, "get_connection_state", Some(value))
    }

    /// `get_rlm_children`: the authoritative child roster plus the
    /// session's event sequence captured before the walk (TS
    /// `buildRlmChildSnapshotsWithPassiveRlmSubagents` freshness
    /// contract).
    pub(crate) async fn handle_get_rlm_children(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_rlm_children") {
            return response;
        }
        let event_sequence = {
            let core = self.core.lock().unwrap();
            core.last_event_sequence
        };
        let mut children = self.engine.rlm_child_snapshots().await;
        // The parent's own RLM node id overlays each child's `parentId`
        // (TS `_rlmParentNodeId`; absent for top-level sessions, where TS
        // serializes the field out).
        let parent_id = {
            let core = self.core.lock().unwrap();
            core.rlm_child_id.clone()
        };
        if let Some(parent_id) = parent_id {
            for child in &mut children {
                child["parentId"] = json!(parent_id);
            }
        }
        response_success(
            None,
            "get_rlm_children",
            Some(json!({ "children": children, "eventSequence": event_sequence })),
        )
    }

    /// `get_context_tree` (TS `session.getContextTree`): the root node is
    /// the session itself — label, model, and the cumulative usage totals
    /// over the persisted branch (own usage excludes child usage
    /// attributions; the usage walk bridges ghost-parent gaps so one lost
    /// append cannot zero the session's real spend) — and the children are
    /// the live RLM roster plus every persisted child session dir under the
    /// session's artifact tree (TS live runs + resident children +
    /// `loadContextTreeChildrenFromDisk`): idle, settled, and
    /// restart-orphaned subagents all appear, with their real usage and
    /// recursive grandchildren. A live child's node carries its session
    /// file's usage (the TS disk-fallback shape; the id, label, and status
    /// come from the live registry, the fresher sources for a running
    /// child), and ids tombstoned in the RLM ledger stay hidden at every
    /// depth of the walk. The disk walk and registry reads are blocking
    /// I/O owned by the background cache refresh
    /// (`context_tree_cache`): they run on the blocking pool, never the
    /// runtime worker, and never on this request path — the response
    /// serves the cached walk with the fresh live identity overlaid
    /// (usage and grandchildren lag the last completed refresh; a
    /// running child's status and identity never lag).
    pub(crate) async fn handle_get_context_tree(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_context_tree") {
            return response;
        }
        // The root node is in-memory data: the usage totals and the
        // context estimate walk the live store under the core lock
        // borrow-based (no owned copy of the history), so the request
        // answers from memory in bounded time even on a grown store. The
        // artifact-tree walk is the cache's background refresh
        // (`context_tree_cache`), never the request path.
        let (label, context_usage, own_usage, total_usage, session_id, own_usage_by_model) = {
            let core = self.core.lock().unwrap();
            let store = core.store.as_ref();
            let label = store
                .and_then(|store| store.session_name().map(str::to_string))
                .unwrap_or_else(|| "main agent".to_string());
            let context_usage = store.and_then(|store| {
                crate::session_stats::store_context_usage(store, self.engine.model_context_window())
            });
            let session_id = store.map(|store| store.session_id().to_string());
            // The per-model own-usage breakdown rides the node when every
            // usage-carrying row resolved to a model (None degrades to the
            // plain TS totals): a session that switched models mid-run —
            // or whose subagents billed on other models — shows which
            // model billed what.
            let (own_usage, total_usage, own_usage_by_model) = match store {
                Some(store) => {
                    let branch = store.branch_bridged();
                    let all_entries = store.entries();
                    let (own_usage, total_usage) =
                        compute_own_and_total_usage(&branch, all_entries);
                    let own_usage_by_model = compute_own_usage_by_model(
                        &branch,
                        all_entries,
                        &own_usage,
                        store.window_boundary_model().as_ref(),
                    );
                    (own_usage, total_usage, own_usage_by_model)
                }
                None => (empty_usage(), empty_usage(), None),
            };
            (
                label,
                context_usage,
                own_usage,
                total_usage,
                session_id,
                own_usage_by_model,
            )
        };
        let model = self.engine.model_metadata().and_then(|model| {
            Some(json!({
                "provider": model.get("provider")?,
                "id": model.get("id")?,
            }))
        });
        let snapshots = self.engine.rlm_child_snapshots().await;
        // The children come from the cache instantly (fresh live-roster
        // identity and status over the cached bodies; the background walk
        // in `context_tree_cache` keeps them as fresh as its last
        // refresh) — the walk itself never blocks this response.
        let children = self
            .context_tree
            .serve_children(session_id.as_deref(), &snapshots);
        // Re-arm the background refresh for the next read.
        self.poke_context_tree_refresh();
        let mut tree = json!({
            "id": "root",
            "label": label,
            "status": "active",
            "ownUsage": own_usage,
            "totalUsage": total_usage,
            "children": children,
        });
        if let Some(model) = model {
            tree["model"] = model;
        }
        if let Some(usage) = context_usage {
            tree["contextUsage"] = usage;
        }
        if let Some(by_model) = own_usage_by_model {
            tree["ownUsageByModel"] = json!(by_model);
        }
        response_success(None, "get_context_tree", Some(tree))
    }

    /// Arm the background context-tree walk (`context_tree_cache`) for
    /// this session: the walk inputs resolve against the worker's current
    /// store (the durable session id for the artifact tree, the session
    /// file for the ledger's tombstone record), so a replaced session
    /// never walks the previous tree. Called by the `get_context_tree`
    /// handler (re-arm on every read older than the TTL), and as the
    /// warm at session open (create/attach), so the cache is usually
    /// filled before the first read.
    pub(crate) fn poke_context_tree_refresh(&self) {
        let (session_id, session_file) = {
            let core = self.core.lock().unwrap();
            core.store
                .as_ref()
                .map(|store| (store.session_id().to_string(), store.path.clone()))
                .unzip()
        };
        self.context_tree.poke_refresh(
            self.engine.clone(),
            self.config.agent_dir.clone(),
            session_id,
            session_file,
        );
    }

    /// `get_commands` (TS `createAgentConnectionCommands`): prompt
    /// templates, then skills.
    pub(crate) async fn handle_get_commands(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_commands") {
            return response;
        }
        let commands = self.engine.connection_commands().await;
        response_success(None, "get_commands", Some(json!({ "commands": commands })))
    }

    /// `get_resource_snapshot` (TS
    /// `createAgentConnectionResourceSnapshot`).
    pub(crate) async fn handle_get_resource_snapshot(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_resource_snapshot") {
            return response;
        }
        let snapshot = self.engine.resource_snapshot().await;
        response_success(None, "get_resource_snapshot", Some(snapshot))
    }

    /// `get_session_context` (TS `session.buildSessionContext`): the
    /// resolved model context at the branch leaf — messages, the
    /// effective thinking level and service tier, and the last model
    /// selector.
    pub(crate) fn handle_get_session_context(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_session_context") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let Some(store) = core.store.as_ref() else {
            return response_failure(
                None,
                "get_session_context",
                "Session is still initializing",
                None,
            );
        };
        let entries = store.branch_file_entries();
        let context = pa_core::session::build_session_context(&entries, store.leaf_id());
        let messages: Vec<Value> = context
            .messages
            .iter()
            .map(|message| serde_json::to_value(message).unwrap_or(Value::Null))
            .collect();
        response_success(
            None,
            "get_session_context",
            Some(json!({
                "context": {
                    "messages": messages,
                    "thinkingLevel": context.thinking_level,
                    "serviceTier": context.service_tier,
                    "model": context.model.map(|(provider, model_id)| json!({
                        "provider": provider,
                        "modelId": model_id,
                    })),
                }
            })),
        )
    }

    /// `get_system_prompt` (TS `{ systemPrompt }`).
    pub(crate) async fn handle_get_system_prompt(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_system_prompt") {
            return response;
        }
        let prompt = self.engine.system_prompt().await;
        match prompt {
            Ok(prompt) => response_success(
                None,
                "get_system_prompt",
                Some(json!({ "systemPrompt": prompt })),
            ),
            Err(error) => response_failure(None, "get_system_prompt", &format!("{error:#}"), None),
        }
    }

    /// `get_tool_definition { name }` (TS
    /// `createAgentConnectionToolDefinition`): the definition of one
    /// active tool; an unknown name answers success with the key omitted,
    /// exactly like the TS `undefined` field.
    pub(crate) async fn handle_get_tool_definition(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("get_tool_definition") {
            return response;
        }
        let Some(name) = payload.get("name").and_then(Value::as_str) else {
            return response_failure(
                None,
                "get_tool_definition",
                "get_tool_definition requires a name",
                None,
            );
        };
        let definition = self.engine.tool_definition(name).await;
        let mut data = serde_json::Map::new();
        if let Some(definition) = definition {
            data.insert("toolDefinition".to_string(), definition);
        }
        response_success(None, "get_tool_definition", Some(Value::Object(data)))
    }

    /// `get_rlm_max_depth_status` (TS `getRlmMaxDepthStatus`).
    pub(crate) fn handle_get_rlm_max_depth_status(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_rlm_max_depth_status") {
            return response;
        }
        response_success(
            None,
            "get_rlm_max_depth_status",
            Some(self.engine.rlm_max_depth_status()),
        )
    }

    /// `get_available_models` (TS `refreshAvailableModels`): the
    /// auth-configured models.
    pub(crate) fn handle_get_available_models(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_available_models") {
            return response;
        }
        let registry = worker_model_registry(&self.config.agent_dir);
        let models: Vec<Value> = registry
            .get_available()
            .into_iter()
            .filter_map(|model| serde_json::to_value(model).ok())
            .collect();
        response_success(
            None,
            "get_available_models",
            Some(json!({ "models": models })),
        )
    }
}
// The usage math (the model registry resolution, the TS `Usage` wire shape,
// the add/subtract folds, and the own/total + by-model computations) moved to
// the child module at the same tree position (state_getters::usage); the
// re-exports keep the facade's paths stable (context_tree_cache.rs's
// empty_usage, rlm_child_model.rs's + setting_switches.rs's +
// worker/create.rs's worker_model_registry, context_tree_children.rs's
// compute_*). The private add_usage/subtract_usage folds ride with their
// callers.
mod usage;

pub(crate) use usage::{
    compute_own_and_total_usage, compute_own_usage_by_model, empty_usage, worker_model_registry,
};

// The getter battery moved to the child module at the same tree position
// (state_getters::state_getters_tests); the #[cfg(test)] decl rides at the
// facade tail.
#[cfg(test)]
mod state_getters_tests;
