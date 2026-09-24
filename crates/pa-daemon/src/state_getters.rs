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
    /// overlays — `heartbeat` (this worker owns no cron store, so the
    /// overlay is the TS null) and `recap` (only when a live summary
    /// exists; this port's worker summaries surface through the roster,
    /// so the persisted recap stays).
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
        let (label, context_usage, own_usage, total_usage, session_id) = {
            let core = self.core.lock().unwrap();
            let store = core.store.as_ref();
            let label = store
                .and_then(|store| store.session_name().map(str::to_string))
                .unwrap_or_else(|| "main agent".to_string());
            let context_usage = store.and_then(|store| {
                crate::session_stats::store_context_usage(store, self.engine.model_context_window())
            });
            let session_id = store.map(|store| store.session_id().to_string());
            let (own_usage, total_usage) = match store {
                Some(store) => {
                    let branch = store.branch_bridged();
                    let all_entries = store.entries();
                    compute_own_and_total_usage(&branch, all_entries)
                }
                None => (empty_usage(), empty_usage()),
            };
            (label, context_usage, own_usage, total_usage, session_id)
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

    /// `get_commands` (TS `createAgentConnectionCommands`): extension
    /// commands, prompt templates, then skills.
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

/// The worker's model registry (auth storage + `models.json`, with the
/// on-disk private-authorization cache adopted so create-time resolution
/// sees the same availability the create path does).
pub(crate) fn worker_model_registry(agent_dir: &std::path::Path) -> ModelRegistry {
    let auth = pa_core::auth::AuthStorage::create(agent_dir);
    let mut registry = ModelRegistry::create(auth, agent_dir.join("models.json"));
    registry.load_private_authorization_from_cache();
    registry
}

/// The TS `Usage` wire shape (the TS `emptyUsage`).
pub(crate) fn empty_usage() -> Value {
    json!({
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "total": 0,
        },
    })
}

/// TS `addAssistantUsage`: fold one usage block into a running total.
fn add_usage(total: &mut Value, usage: &Value) {
    let add_field = |total: &mut Value, field: &str, usage: &Value| {
        let current = total.get(field).and_then(Value::as_u64).unwrap_or(0);
        let add = usage.get(field).and_then(Value::as_u64).unwrap_or(0);
        total[field] = json!(current + add);
    };
    for field in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] {
        add_field(total, field, usage);
    }
    for field in ["input", "output", "cacheRead", "cacheWrite", "total"] {
        let cost = total
            .get_mut("cost")
            .and_then(Value::as_object_mut)
            .expect("usage totals always carry the cost block");
        // The running total is a float after the first add (TS costs are
        // floats); reading it as u64 dropped everything already banked.
        let current = cost.get(field).and_then(Value::as_f64).unwrap_or(0.0);
        let add = usage
            .get("cost")
            .and_then(|cost| cost.get(field))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        cost.insert(field.to_string(), json!(current + add));
    }
}

/// TS `subtractAssistantUsage`: remove one usage block, clamping at zero.
fn subtract_usage(total: &mut Value, usage: &Value) {
    let sub_field = |total: &mut Value, field: &str, usage: &Value| {
        let current = total.get(field).and_then(Value::as_u64).unwrap_or(0);
        let sub = usage.get(field).and_then(Value::as_u64).unwrap_or(0);
        total[field] = json!(current.saturating_sub(sub));
    };
    for field in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] {
        sub_field(total, field, usage);
    }
    for field in ["input", "output", "cacheRead", "cacheWrite", "total"] {
        let cost = total
            .get_mut("cost")
            .and_then(Value::as_object_mut)
            .expect("usage totals always carry the cost block");
        let current = cost.get(field).and_then(Value::as_f64).unwrap_or(0.0);
        let sub = usage
            .get("cost")
            .and_then(|cost| cost.get(field))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        cost.insert(field.to_string(), json!((current - sub).max(0.0)));
    }
}

/// TS `computeOwnAndTotalUsage`: the branch's cumulative assistant usage
/// (`totalUsage`, attributions included) minus the child usage
/// attributions targeting those assistants (`ownUsage`). Totals stay
/// cumulative across compactions: compaction shrinks the model-facing
/// context, not what the session spent.
pub(crate) fn compute_own_and_total_usage(
    branch: &[&crate::session_store::SessionEntry],
    all_entries: &[crate::session_store::SessionEntry],
) -> (Value, Value) {
    let mut total = empty_usage();
    let mut branch_assistant_ids = std::collections::HashSet::new();
    for entry in branch {
        if entry.type_ == "message" {
            let Some(message) = entry.fields.get("message") else {
                continue;
            };
            if message.get("role").and_then(Value::as_str) == Some("assistant") {
                branch_assistant_ids.insert(entry.id.clone());
                if let Some(usage) = message.get("usage") {
                    add_usage(&mut total, usage);
                }
            }
        } else if matches!(entry.type_.as_str(), "compaction" | "branch_summary") {
            if let Some(usage) = entry.fields.get("usage") {
                add_usage(&mut total, usage);
            }
        }
    }
    let mut own = total.clone();
    for entry in all_entries {
        if entry.type_ != "child_usage_attributed" {
            continue;
        }
        let Some(target_id) = entry.fields.get("targetId").and_then(Value::as_str) else {
            continue;
        };
        if branch_assistant_ids.contains(target_id) {
            if let Some(child_usage) = entry.fields.get("childUsage") {
                subtract_usage(&mut own, child_usage);
            }
        }
    }
    (own, total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    /// A created worker backed by an existing session file (the store's
    /// path, so the artifact tree beside it resolves).
    async fn created_worker_at(
        root: &std::path::Path,
        session_file: &std::path::Path,
    ) -> Arc<Worker> {
        std::fs::create_dir_all(root).unwrap();
        let config = crate::worker::WorkerConfig {
            socket_path: root.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "getter-session".to_string(),
            agent_dir: root.join("agent"),
            recovery_journal_path: root.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({
                    "sessionPath": session_file.display().to_string(),
                    "cwd": "/tmp",
                    "name": "getters",
                }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    async fn created_worker() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-sg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "getter-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "getters" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    /// `get_connection_state` answers the TS `AgentConnectionState` block
    /// with the daemon overlay: `heartbeat` is present and null (no cron
    /// store on this worker).
    #[tokio::test]
    async fn get_connection_state_matches_the_ts_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let data = response.data.expect("connection state data");
        assert_eq!(data["activeSessionId"], "getter-session");
        assert_eq!(data["cwd"], "/tmp");
        assert_eq!(data["heartbeat"], Value::Null);
        for field in [
            "thinkingLevel",
            "serviceTier",
            "availableThinkingLevels",
            "isStreaming",
            "isCompacting",
            "isBashRunning",
            "retryAttempt",
            "steeringMode",
            "followUpMode",
            "sessionId",
            "leafId",
            "autoCompactionEnabled",
            "messageCount",
            "sessionActions",
            "compactionCount",
            "goal",
            "scopedModels",
            "activeToolNames",
        ] {
            assert!(data.get(field).is_some(), "missing {field}: {data}");
        }
        // A session that has not been created answers the TS
        // initializing refusal.
        let fresh = Arc::new(Worker::new(
            {
                let mut config = worker.config.clone();
                config.active_session_id = "fresh-session".to_string();
                config
            },
            None,
        ));
        let response = fresh
            .dispatch(
                "get_connection_state",
                &json!({ "activeSessionId": "fresh-session" }),
            )
            .await;
        assert!(!response.success);
        assert_eq!(
            response.error.as_deref(),
            Some("Session is still initializing")
        );
    }

    /// `get_rlm_children`: the child roster plus the pre-walk event
    /// sequence; a worker without children answers the empty roster.
    #[tokio::test]
    async fn get_rlm_children_carries_the_sequence() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "get_rlm_children",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let data = response.data.expect("data");
        assert_eq!(data["children"], json!([]));
        let sequence = data["eventSequence"].as_u64().expect("event sequence");
        // A subsequent read captures the same sequence until an event
        // bumps it (TS freshness contract).
        let again = worker
            .dispatch(
                "get_rlm_children",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert_eq!(again.data.expect("data")["eventSequence"], json!(sequence));
    }

    /// `get_context_tree`: the root node with usage totals over the
    /// persisted branch; child attributions move the split between
    /// `ownUsage` and `totalUsage` (TS `computeOwnAndTotalUsage`).
    #[tokio::test]
    async fn get_context_tree_matches_the_ts_root_node() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "get_context_tree",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let tree = response.data.expect("data");
        assert_eq!(tree["id"], "root");
        assert_eq!(tree["label"], "getters");
        assert_eq!(tree["status"], "active");
        assert_eq!(tree["children"], json!([]));
        assert_eq!(tree["ownUsage"]["totalTokens"], json!(0));

        // One assistant turn seeds usage totals (the scripted usage block).
        let _ = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "getter-session", "message": "hi" }),
            )
            .await;
        let response = worker
            .dispatch(
                "get_context_tree",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        let tree = response.data.expect("data");
        assert_eq!(tree["ownUsage"]["input"], json!(120));
        assert_eq!(tree["totalUsage"]["totalTokens"], json!(128));
        assert_eq!(tree["totalUsage"]["cost"]["total"].as_f64(), Some(0.0));
    }

    /// The captured-attribution fixture over the full daemon path (create
    /// from a copy of the fixture file, so the repo fixture stays
    /// read-only): the load-time fold makes the root's own/total split
    /// TS-exact. `ownUsage` is the assistant's own row (input 2690, cost
    /// $0 — `totalTokens` clamps to zero because the six attributions'
    /// child `totalTokens` (54289) exceeds the aggregate's unchanged
    /// 23032, TS `subtractAssistantUsage`'s clamp); `totalUsage` carries
    /// the attributed child spend (input 52898, cost $0.0089957,
    /// `totalTokens` stays 23032).
    #[tokio::test]
    async fn get_context_tree_folds_the_captured_attributions() {
        let root = std::env::temp_dir().join(format!("pa-worker-af-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/attribution-fold-captured.jsonl");
        let session_file = root.join("captured.jsonl");
        std::fs::copy(&fixture, &session_file).unwrap();
        let worker = created_worker_at(&root, &session_file).await;
        let response = worker
            .dispatch(
                "get_context_tree",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let tree = response.data.expect("data");
        assert_eq!(tree["ownUsage"]["input"], json!(2690));
        assert_eq!(tree["ownUsage"]["output"], json!(2934));
        assert_eq!(tree["ownUsage"]["cacheRead"], json!(17408));
        assert_eq!(tree["ownUsage"]["totalTokens"], json!(0));
        // The six sequential per-entry subtractions leave float-order noise
        // in the last ulps (TS `subtractAssistantUsage` walks the same
        // order), so own cost pins at ~0, not bit-exact zero.
        assert!(
            tree["ownUsage"]["cost"]["total"].as_f64().unwrap().abs() < 1e-12,
            "own cost {} is not ~0",
            tree["ownUsage"]["cost"]["total"]
        );
        assert_eq!(tree["totalUsage"]["input"], json!(52898));
        assert_eq!(tree["totalUsage"]["output"], json!(5863));
        assert_eq!(tree["totalUsage"]["cacheRead"], json!(18560));
        assert_eq!(tree["totalUsage"]["totalTokens"], json!(23032));
        assert_eq!(
            tree["totalUsage"]["cost"]["total"].as_f64(),
            Some(0.008_995_7)
        );
        // `get_session_stats` reports the same folded totals over the
        // gap-bridged branch.
        let stats = worker
            .dispatch(
                "get_session_stats",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(stats.success, "failed: {stats:?}");
        let stats = stats.data.expect("data");
        assert_eq!(stats["tokens"]["input"], json!(52898));
        assert_eq!(stats["tokens"]["output"], json!(5863));
        assert_eq!(stats["tokens"]["cacheRead"], json!(18560));
        assert_eq!(stats["cost"].as_f64(), Some(0.008_995_7));
    }

    /// `get_context_tree` surfaces the persisted child sessions under the
    /// session's artifact tree (idle, settled, and restart-orphaned
    /// subagents all appear, with their real usage and recursive
    /// grandchildren — TS `loadContextTreeChildrenFromDisk`). The artifact
    /// tree is keyed by the worker's agent dir and the durable session id,
    /// exactly where `child_session_dir` writes; a session file outside
    /// the agent dir must not change that.
    #[tokio::test]
    async fn get_context_tree_lists_persisted_children() {
        let root = std::env::temp_dir().join(format!("pa-worker-ct-{}", uuid::Uuid::new_v4()));
        let agent_dir = root.join("agent");
        let sessions = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let session_id = "01a0ct-1111-2222-3333-444444444444";
        let session_file = sessions.join(format!("{session_id}.jsonl"));
        let usage = json!({
            "input": 30, "output": 6, "cacheRead": 0, "cacheWrite": 0,
            "totalTokens": 36,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
        });
        let content = [
            json!({"type": "session", "version": 3, "id": session_id, "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "hi"}}),
            json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "assistant", "content": [{ "type": "text", "text": "hello" }], "provider": "prime-inference", "model": "internal/glm-5.3-fast", "usage": usage}}),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        std::fs::write(&session_file, content).unwrap();
        // The artifact tree lives under the worker's agent dir (the writer's
        // addressing): one settled child with a grandchild in the child's own
        // sibling tree.
        let artifacts = agent_dir.join("session-artifacts");
        let child_session = "01a0child-1111-2222-3333-4444444444";
        let grandchild_session = "01a0grand-1111-2222-3333-4444444444";
        let write_child = |stop: &str| {
            [
                json!({"type": "message", "id": "c1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "fix the login bug"}}),
                json!({"type": "message", "id": "c2", "parentId": "c1", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "assistant", "content": [{ "type": "text", "text": "done" }], "provider": "prime-inference", "model": "internal/glm-5.3-fast", "stopReason": stop, "usage": {"input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 15, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}}}),
            ]
        };
        let write_session = |dir: &std::path::Path, session: &str, stop: &str| {
            std::fs::create_dir_all(dir).unwrap();
            let mut lines = vec![
                json!({"type": "session", "version": 3, "id": session, "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            ];
            lines.extend(write_child(stop));
            std::fs::write(
                dir.join(format!("{session}.jsonl")),
                lines
                    .iter()
                    .map(std::string::ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
            .unwrap();
        };
        let child_dir = artifacts.join(session_id).join("sub-003f741a");
        write_session(&child_dir, child_session, "stop");
        let grandchild_dir = artifacts.join(child_session).join("sub-00aa00aa");
        write_session(&grandchild_dir, grandchild_session, "stop");
        // A second child the user deleted: the ledger tombstone must keep it
        // out of the tree.
        let deleted_dir = artifacts.join(session_id).join("sub-deadbeef");
        let deleted_session = "01a0dead-1111-2222-3333-4444444444";
        write_session(&deleted_dir, deleted_session, "stop");
        let ledger = crate::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &sessions, |_| {});
        ledger
            .append_spawn(crate::rlm_ledger::RlmSpawnInput {
                child_id: "sub-deadbeef".to_string(),
                parent: session_file.display().to_string(),
                child: deleted_dir.display().to_string(),
                depth: 1,
                name: "deleted-child".to_string(),
            })
            .unwrap();
        ledger
            .append_delete(
                "sub-deadbeef",
                &deleted_dir.display().to_string(),
                crate::rlm_ledger::RlmLedgerDeleteReason::User,
            )
            .unwrap();

        let worker = created_worker_at(&root, &session_file).await;
        // The children come from the background cache refresh (the create
        // warm armed it): a cold read serves the root from memory
        // instantly, and the persisted tree fills when the walk lands.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let children = loop {
            let response = worker
                .dispatch(
                    "get_context_tree",
                    &json!({ "activeSessionId": "getter-session" }),
                )
                .await;
            assert!(response.success, "failed: {response:?}");
            let tree = response.data.expect("data");
            assert_eq!(
                tree["ownUsage"]["input"],
                json!(30),
                "the root usage counts"
            );
            let children = tree["children"].as_array().cloned().unwrap_or_default();
            if children.len() == 1 || std::time::Instant::now() > deadline {
                break children;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        assert_eq!(
            children.len(),
            1,
            "the persisted child appears, the deleted one stays hidden: {children:?}"
        );
        let child = &children[0];
        assert_eq!(child["id"], json!("sub-003f741a"));
        assert_eq!(child["status"], json!("done"));
        assert_eq!(child["label"], json!("fix the login bug"));
        assert_eq!(child["ownUsage"]["totalTokens"], json!(15));
        let grandchildren = child["children"].as_array().expect("grandchildren");
        assert_eq!(grandchildren.len(), 1);
        assert_eq!(grandchildren[0]["id"], json!("sub-00aa00aa"));
        assert_eq!(grandchildren[0]["ownUsage"]["totalTokens"], json!(15));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The own/total split (TS `computeOwnAndTotalUsage`): attributions
    /// subtract from own usage only, matched by target across every entry.
    #[test]
    fn own_usage_subtracts_child_attributions() {
        let assistant = json!({
            "type": "message", "id": "m1",
            "message": {
                "role": "assistant", "content": "text",
                "usage": {
                    "input": 100, "output": 10, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 110,
                    "cost": { "input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0, "total": 3 },
                },
            },
        });
        let attribution = json!({
            "type": "child_usage_attributed", "id": "a1",
            "targetId": "m1",
            "childUsage": {
                "input": 40, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                "totalTokens": 45,
                "cost": { "input": 0.5, "output": 1, "cacheRead": 0, "cacheWrite": 0, "total": 1.5 },
            },
        });
        let entry = |value: &Value, id: &str| crate::session_store::SessionEntry {
            type_: value["type"].as_str().expect("type").to_string(),
            id: id.to_string(),
            parent_id: None,
            timestamp: "2024-01-01T00:00:00.000Z".to_string(),
            fields: value
                .as_object()
                .expect("object")
                .clone()
                .into_iter()
                .collect(),
        };
        let assistant_entry = entry(&assistant, "m1");
        let attribution_entry = entry(&attribution, "a1");
        let entries = vec![
            assistant_entry.clone(),
            attribution_entry.clone(),
            attribution_entry.clone(),
        ];
        let branch_refs: Vec<&crate::session_store::SessionEntry> = entries.iter().collect();
        let (own, total) = compute_own_and_total_usage(&branch_refs, &entries);
        assert_eq!(total["input"], json!(100));
        assert_eq!(total["totalTokens"], json!(110));
        assert_eq!(own["input"], json!(20), "two attributions subtract twice");
        // Subtraction clamps at zero instead of going negative (TS
        // attribution-drift guard).
        let entries_more = vec![
            assistant_entry,
            attribution_entry.clone(),
            attribution_entry.clone(),
            attribution_entry.clone(),
            attribution_entry.clone(),
            attribution_entry,
        ];
        let branch_refs_more: Vec<&crate::session_store::SessionEntry> =
            entries_more.iter().collect();
        let (own, _) = compute_own_and_total_usage(&branch_refs_more, &entries_more);
        assert_eq!(own["input"], json!(0));
        assert_eq!(own["cost"]["total"].as_f64(), Some(0.0));
    }

    /// `get_commands` / `get_resource_snapshot` on the scripted engine:
    /// the TS loader shapes over empty lists.
    #[tokio::test]
    async fn commands_and_resources_match_the_empty_loader_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "get_commands",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(response.data.expect("data"), json!({ "commands": [] }));
        let response = worker
            .dispatch(
                "get_resource_snapshot",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(
            response.data.expect("data"),
            crate::engine::empty_resource_snapshot()
        );
    }

    /// `get_session_context`: the resolved context at the leaf — messages,
    /// effective thinking level, service tier, and model selector.
    #[tokio::test]
    async fn get_session_context_matches_the_ts_context_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "get_session_context",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let context = response.data.expect("data")["context"].clone();
        assert!(context.get("messages").is_some());
        assert!(context.get("thinkingLevel").is_some());
        assert!(context.get("serviceTier").is_some());
        assert!(context.get("model").is_some());

        // One turn lands its accepted user message on the resolved
        // context. (The scripted harness's synthetic assistant row carries
        // no stop reason, so it does not round-trip into the typed entry
        // form the walk consumes; real engine rows do.)
        let _ = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "getter-session", "message": "hello" }),
            )
            .await;
        let response = worker
            .dispatch(
                "get_session_context",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        let context = response.data.expect("data")["context"].clone();
        let roles: Vec<String> = context["messages"]
            .as_array()
            .expect("messages array")
            .iter()
            .filter_map(|message| {
                message
                    .get("role")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        assert!(roles.iter().any(|role| role == "user"));
        assert_eq!(context["messages"][0]["content"], json!("hello"));
    }

    /// `get_system_prompt` / `get_tool_definition`: the scripted engine
    /// has no prompt (empty string, the TS key present) and no tools (the
    /// `toolDefinition` key omitted, like the TS `undefined` field).
    #[tokio::test]
    async fn system_prompt_and_tool_definition_match_the_ts_shapes() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "get_system_prompt",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(response.data.expect("data"), json!({ "systemPrompt": "" }));

        let response = worker
            .dispatch(
                "get_tool_definition",
                &json!({ "activeSessionId": "getter-session", "name": "ipython" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(response.data.expect("data"), json!({}));

        let response = worker
            .dispatch(
                "get_tool_definition",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(!response.success);
        assert_eq!(
            response.error.as_deref(),
            Some("get_tool_definition requires a name")
        );
    }

    /// `get_rlm_max_depth_status`: the TS source vocabulary (the b6 wave
    /// replaced the provisional "settings" label; an unseeded scripted
    /// session reports the shared default).
    #[tokio::test]
    async fn rlm_max_depth_status_matches_the_ts_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "get_rlm_max_depth_status",
                &json!({ "activeSessionId": "getter-session" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(
            response.data.expect("data"),
            json!({ "maxDepth": crate::rlm_children::DEFAULT_RLM_MAX_DEPTH, "source": "default" })
        );
    }

    /// `get_model_catalog` / `get_available_models` against a fixture
    /// registry (TS `refreshModelCatalog` / `refreshAvailableModels`).
    #[tokio::test]
    async fn model_catalog_and_available_models_match_the_ts_shapes() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("agent")).expect("agent dir");
        std::fs::write(
            dir.path().join("agent").join("models.json"),
            json!({
                "providers": {
                    "prime-inference": {
                        "api": "openai-completions",
                        "baseUrl": "http://127.0.0.1:9/v1",
                        "apiKey": "sk-test",
                        "models": [
                            { "id": "mock-1", "name": "Mock 1", "api": "openai-completions",
                              "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128_000,
                              "maxTokens": 4096 },
                            { "id": "mock-2", "name": "Mock 2", "api": "openai-completions",
                              "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128_000,
                              "maxTokens": 4096 }
                        ]
                    }
                }
            })
            .to_string(),
        )
        .expect("write models.json");
        let config = crate::worker::WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "catalog-session".to_string(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": "/tmp" }))
            .await;
        assert!(created.success, "create failed: {created:?}");

        let response = worker
            .dispatch(
                "get_model_catalog",
                &json!({ "activeSessionId": "catalog-session" }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let catalog = response.data.expect("data");
        assert_eq!(
            catalog["models"]
                .as_array()
                .expect("models")
                .iter()
                .filter(|model| model["id"] == json!("mock-1"))
                .count(),
            1
        );
        assert_eq!(catalog["configuredProviders"], json!(["prime-inference"]));

        let response = worker
            .dispatch(
                "get_available_models",
                &json!({ "activeSessionId": "catalog-session" }),
            )
            .await;
        assert!(response.success);
        let available = response.data.expect("data");
        let models = available["models"].as_array().expect("models");
        // The registry also serves the built-in catalog when the box has
        // configured auth for it; the fixture provider must be complete.
        assert!(
            models
                .iter()
                .filter(|model| model["provider"] == json!("prime-inference"))
                .count()
                >= 2
        );
        assert!(models.iter().any(|model| model["id"] == json!("mock-1")));
    }
}
