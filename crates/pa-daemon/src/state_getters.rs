//! The read-only state getters: the worker arms for the daemon `get_*`
//! commands. Each handler answers the exact TS wire shape; the data comes
//! from the worker's persisted session store, the engine seams, and the
//! model registry.

use serde_json::{json, Value};

use pa_core::models::ModelRegistry;

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

impl Worker {
    /// `get_connection_state`: the connection state block with the TS
    /// `createConnectionState` `heartbeat` overlay (the TS null here).
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

    /// `get_rlm_children`: the authoritative child roster plus the session's
    /// event sequence captured before the walk (the freshness contract).
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
        // (absent for top-level sessions, serialized out on the wire).
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

    /// `get_context_tree`: the root is the session itself (usage totals over
    /// the persisted branch, ghost-parent gaps bridged); the children are the
    /// live RLM roster plus every persisted child dir (tombstoned ids stay
    /// hidden). The disk walk runs in the background cache refresh: this path
    /// serves the cached walk with fresh live identity overlaid (usage lags;
    /// a child's status never lags).
    pub(crate) async fn handle_get_context_tree(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_context_tree") {
            return response;
        }
        // The root node is in-memory data: the usage walk reads the live store
        // borrow-based, so the request answers from memory even on a grown store.
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
            // usage-carrying row resolved to a model (`None` degrades to the plain totals).
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
        // The children come from the cache instantly (fresh live-roster identity and status
        // over the cached bodies) — the walk itself never blocks this response.
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

    /// Arm the background context-tree walk (the inputs resolve against the
    /// current store): called on reads older than the TTL and as the warm at open.
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

    /// `get_resource_snapshot` (TS `createAgentConnectionResourceSnapshot`).
    pub(crate) async fn handle_get_resource_snapshot(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_resource_snapshot") {
            return response;
        }
        let snapshot = self.engine.resource_snapshot().await;
        response_success(None, "get_resource_snapshot", Some(snapshot))
    }

    /// `get_session_context`: the resolved model context at the branch leaf
    /// (messages, thinking level, service tier, last model selector).
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

    /// `get_tool_definition { name }`: the definition of one active tool; an
    /// unknown name answers success with the key omitted (the TS `undefined` field).
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

    /// `get_available_models` (TS `refreshAvailableModels`): the auth-configured models.
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
// The usage math lives in state_getters::usage; the re-exports keep the facade's paths stable.
mod usage;

pub(crate) use usage::{
    compute_own_and_total_usage, compute_own_usage_by_model, empty_usage, worker_model_registry,
};

// The getter battery lives in state_getters::state_getters_tests.
#[cfg(test)]
mod state_getters_tests;
