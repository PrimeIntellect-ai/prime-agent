//! The in-process host battery: hermetic engines over scripted providers
//! (no kernel boots — the scripted models never call tools), driving the
//! host trait and the family controllers directly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pa_agent::scripted::ScriptedProvider;
use pa_agent::stream::StreamFn;
use pa_agent::types::Model as AgentModel;
use serde_json::json;

use super::family::{FamilySelf, InProcessFamilyController};
use super::{InProcessRlmHost, InProcessRlmHostConfig, DEFAULT_RLM_MAX_DEPTH};
use crate::models::registry::ModelRegistry;
use crate::session::manager::{NewSessionOptions, SessionManager};
use crate::session_engine::agent_messaging::{
    AgentMessageController, AgentMessageSendInput, AgentObserveController,
};
use crate::session_engine::engine::{create_session, SessionEngine, SessionEngineConfig};
use crate::session_engine::rlm_host::{
    RlmChildResult, RlmCreateSessionRequest, RlmSpawnRequest, RlmSubagentHost,
};
use crate::session_engine::rlm_in_process::StreamFnFactory;
use crate::session_engine::QueuedDelivery;

/// A per-model scripted stream catalog: the parent and every child run on
/// their own scripted provider keyed by model id.
struct ScriptCatalog {
    providers: Mutex<HashMap<String, Arc<ScriptedProvider>>>,
}

impl ScriptCatalog {
    fn new() -> Self {
        Self {
            providers: Mutex::new(HashMap::new()),
        }
    }

    fn provider(self: &Arc<Self>, model_id: &str) -> Arc<ScriptedProvider> {
        Arc::clone(
            self.providers
                .lock()
                .unwrap()
                .entry(model_id.to_string())
                .or_insert_with(|| Arc::new(ScriptedProvider::new(script_model(model_id)))),
        )
    }

    fn stream_fn(self: &Arc<Self>, model_id: &str) -> StreamFn {
        self.provider(model_id).stream_fn()
    }

    fn factory(self: &Arc<Self>) -> StreamFnFactory {
        let catalog = Arc::clone(self);
        Arc::new(move |model: &AgentModel| catalog.stream_fn(&model.id))
    }
}

/// The minimal agent model shape the scripted provider needs.
fn script_model(id: &str) -> AgentModel {
    serde_json::from_value(json!({
        "id": id, "name": id, "api": "openai-completions", "provider": "test-provider",
        "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 1000, "maxTokens": 100
    }))
    .unwrap()
}

/// One resident guest rig: a bound parent engine, its in-process host, and
/// the scripted catalog its children spawn through.
struct TestRig {
    root: tempfile::TempDir,
    agent_dir: PathBuf,
    catalog: Arc<ScriptCatalog>,
    host: Arc<InProcessRlmHost>,
    engine: Arc<SessionEngine>,
}

impl TestRig {
    async fn new() -> Self {
        Self::with_depth(0, DEFAULT_RLM_MAX_DEPTH).await
    }

    async fn with_depth(depth: u32, max_depth: u32) -> Self {
        // Hermetic credential source (the ambient PRIME_API_KEY must not
        // unlock built-in providers, same discipline as the rlm-host tests).
        struct NoEnvCredentials;
        impl crate::auth::manager::EnvCredentialSource for NoEnvCredentials {
            fn key_names(&self, _provider: &str) -> Option<Vec<String>> {
                None
            }
            fn api_key(&self, _provider: &str) -> Option<String> {
                None
            }
            fn prime_team_id(&self) -> Option<String> {
                None
            }
            fn ambient_identity_material(&self, _provider: &str) -> String {
                String::new()
            }
        }

        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("models.json"),
            json!({
                "providers": {
                    "test-provider": {
                        "baseUrl": "http://localhost:9",
                        "apiKey": "test-key",
                        "api": "openai-completions",
                        "models": [
                            { "id": "glm-5.3", "name": "GLM 5.3", "contextWindow": 1000, "maxTokens": 100 },
                            { "id": "glm-5.3-turbo", "name": "GLM Turbo", "contextWindow": 1000, "maxTokens": 100 }
                        ]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let auth = crate::auth::AuthStorage::in_memory_with_env(
            &crate::auth::types::AuthStorageData::default(),
            Arc::new(crate::auth::NoOAuth),
            Arc::new(NoEnvCredentials),
        );
        let registry = Arc::new(ModelRegistry::create(auth, agent_dir.join("models.json")));
        let catalog = Arc::new(ScriptCatalog::new());
        let host = Arc::new(InProcessRlmHost::new(InProcessRlmHostConfig {
            agent_dir: agent_dir.clone(),
            registry: Arc::clone(&registry),
            stream_fn_factory: catalog.factory(),
            rlm_depth: depth,
            rlm_max_depth: max_depth,
            default_thinking: None,
            remote_family: None,
            root_runtime_kind: None,
        }));
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let mut session_manager = SessionManager::persisted(dir.path(), &sessions_dir);
        session_manager.new_session(&NewSessionOptions {
            id: None,
            parent_session: None,
            rlm_depth: Some(u64::from(depth)),
        });
        let engine = Arc::new(
            create_session(SessionEngineConfig {
                cwd: dir.path().to_path_buf(),
                agent_dir: agent_dir.clone(),
                model: Some(script_model("glm-5.3")),
                stream_fn: Some(catalog.stream_fn("glm-5.3")),
                session_manager: Some(session_manager),
                rlm_depth: Some(depth),
                rlm_subagent_host: Some(Arc::clone(&host) as Arc<dyn RlmSubagentHost>),
                extra_host_handlers: Some(host.family_host_handlers()),
                queued_delivery: QueuedDelivery::SessionPump,
                ..Default::default()
            })
            .await
            .unwrap(),
        );
        host.bind_parent(Arc::clone(&engine)).await.unwrap();
        Self {
            root: dir,
            agent_dir,
            catalog,
            host,
            engine,
        }
    }

    /// One parent turn: queues a scripted parent reply, admits it, and
    /// waits for the run to settle — bumping the turn boundary the
    /// detached child prompts wait on.
    async fn run_parent_turn(&self, reply: &str) {
        self.catalog.provider("glm-5.3").push_text_turn(reply);
        self.engine
            .session
            .prompt("continue", crate::session_engine::PromptOptions::default())
            .await
            .unwrap();
        self.engine.session.agent().wait_for_idle().await;
    }

    /// The first child record (tests spawn at most one live child before
    /// reading it).
    async fn first_child(&self) -> Arc<super::registry::InProcessChildRecord> {
        self.host.children().await.remove(0)
    }

    /// The parent's persisted message/custom rows.
    async fn parent_rows(&self) -> Vec<pa_types::session::FileEntry> {
        self.engine
            .session
            .shared_persistence()
            .lock()
            .await
            .get_entries()
    }
}

fn spawn_request(name: Option<&str>, model: Option<&str>) -> RlmSpawnRequest {
    RlmSpawnRequest {
        prompt: "ship the lane".to_string(),
        name: name.map(str::to_string),
        model: model.map(str::to_string),
        thinking: None,
        cell_source_code: None,
        spawned_by_request_id: None,
    }
}

/// The resolved entry of one `rlm.collect` reply.
fn one(collected: &[RlmChildResult]) -> &RlmChildResult {
    collected.first().expect("one collect result")
}

#[tokio::test]
async fn spawn_admits_settles_and_collects() {
    let rig = TestRig::new().await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child answer");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("worker"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    assert!(handle.rlm_child_id.starts_with("sub-"), "{handle:?}");
    assert_eq!(handle.name, "worker");
    assert_eq!(handle.model, "test-provider/glm-5.3-turbo");
    assert!(Path::new(&handle.session_dir).is_dir());
    // The roster answers immediately: the child is registered and running
    // — no parent turn gates it (TS starts the detached runtime at once).
    let roster = rig.host.list_subagents().await.unwrap();
    assert_eq!(roster.len(), 1);
    assert_eq!(roster[0].status, "running");
    // The child runs and settles on its own; collect waits for the settle.
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    let result = one(&collected);
    assert_eq!(result.status, "done");
    assert!(result.settled);
    assert_eq!(result.answer_preview.as_deref(), Some("child answer"));
    assert_eq!(result.session_name.as_deref(), Some("worker"));
    // The roster row settles too, with the child's durable identity.
    let roster = rig.host.list_subagents().await.unwrap();
    assert_eq!(roster[0].status, "completed");
    assert_eq!(roster[0].tool_use_count, Some(0));
    assert!(roster[0].session_id.is_some());
    // The child session persisted under the parent's artifacts tree with
    // the durable parent edge and depth.
    let header = std::fs::read_to_string(
        Path::new(&handle.session_dir)
            .join(format!("{}.jsonl", roster[0].session_id.clone().unwrap())),
    )
    .unwrap();
    let header: serde_json::Value = serde_json::from_str(header.lines().next().unwrap()).unwrap();
    assert_eq!(header["type"], "session");
    assert_eq!(header["rlmDepth"], 1);
    assert_eq!(
        header["parentSession"],
        rig.engine
            .session
            .shared_persistence()
            .lock()
            .await
            .get_session_file()
            .unwrap()
            .display()
            .to_string()
    );
    // Every child selector form collects.
    for target in [handle.rlm_child_id.as_str(), "worker"] {
        let collected = rig.host.collect(vec![target.to_string()], 0).await.unwrap();
        assert_eq!(one(&collected).status, "done");
    }
    // The unknown selector keeps the TS error.
    let error = rig
        .host
        .collect(vec!["ghost".to_string()], 0)
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "No direct RLM child matches \"ghost\" in the current parent session"
    );
}

#[tokio::test]
async fn duplicate_names_refuse_and_failed_admissions_release() {
    let rig = TestRig::new().await;
    rig.catalog.provider("glm-5.3-turbo").push_text_turn("ok");
    rig.host
        .spawn(spawn_request(
            Some("dup"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let error = rig
        .host
        .spawn(spawn_request(
            Some("dup"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Agent name \"dup\" is unavailable: an agent of that name already exists at depth 1 under this parent"
    );
    // A failed admission released its reservation: the name admits after
    // the failure.
    let error = rig
        .host
        .spawn(spawn_request(Some("fresh"), Some("missing/model")))
        .await
        .unwrap_err();
    assert!(
        error.to_string().starts_with(
            "Requested subagent model \"missing/model\" is unavailable, unauthenticated, or expired"
        ),
        "{error}"
    );
    rig.host
        .spawn(spawn_request(
            Some("fresh"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
}

#[tokio::test]
async fn depth_gate_refuses_with_the_ts_error() {
    // A parent already at the bound cannot spawn (children sit one level
    // deeper).
    let rig = TestRig::with_depth(DEFAULT_RLM_MAX_DEPTH, DEFAULT_RLM_MAX_DEPTH).await;
    let error = rig
        .host
        .spawn(spawn_request(None, Some("test-provider/glm-5.3-turbo")))
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "RLM recursion depth limit reached (RLM_DEPTH=2, RLM_MAX_DEPTH=2)"
    );
}

/// Poll an async probe until it returns `true`, or panic with `what`
/// after the deadline (settle paths run detached).
async fn eventually<F, Fut>(what: &str, mut probe: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if probe().await {
            return;
        }
        assert!(
            std::time::Instant::now() <= deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn model_resolution_and_thinking_errors_match_ts() {
    let rig = TestRig::new().await;
    // A short-form reference resolves through the catalog.
    let handle = rig
        .host
        .spawn(spawn_request(None, Some("glm-5.3-turbo")))
        .await
        .unwrap();
    assert_eq!(handle.model, "test-provider/glm-5.3-turbo");
    // A requested thinking level the model does not support fails with
    // the TS message (the catalog models are non-reasoning).
    let error = rig
        .host
        .spawn(RlmSpawnRequest {
            thinking: Some("high".to_string()),
            ..spawn_request(None, Some("test-provider/glm-5.3-turbo"))
        })
        .await
        .unwrap_err();
    assert!(
        error.to_string().starts_with(
            "Requested thinking level \"high\" is not supported by model \"test-provider/glm-5.3-turbo\"; supported levels:"
        ),
        "{error}"
    );
    // An unbound host refuses with the binding error.
    let unbound = InProcessRlmHost::new(InProcessRlmHostConfig {
        agent_dir: rig.agent_dir.clone(),
        registry: Arc::clone(&rig.host.config().registry),
        stream_fn_factory: rig.catalog.factory(),
        rlm_depth: 0,
        rlm_max_depth: 0,
        default_thinking: None,
        remote_family: None,
        root_runtime_kind: None,
    });
    let error = unbound.spawn(spawn_request(None, None)).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "the in-process RLM host has no parent session bound yet"
    );
}

#[tokio::test]
async fn create_session_refuses_with_the_ts_error() {
    let rig = TestRig::new().await;
    let error = rig
        .host
        .create_session(RlmCreateSessionRequest {
            prompt: "root".to_string(),
            name: None,
            model: None,
            thinking: None,
            cwd: None,
        })
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "rlm.create_session requires a daemon-backed depth-0 session"
    );
}

#[tokio::test]
async fn collect_timeout_returns_running_snapshots() {
    let rig = TestRig::new().await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("slow"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // The stalled child starts immediately and stays running: a
    // zero-timeout collect returns its snapshot, never an error.
    let collected = rig.host.collect(vec![], 0).await.unwrap();
    let result = one(&collected);
    assert_eq!(result.status, "running");
    assert!(!result.settled);
    // A bounded collect on the still-running child also returns its
    // snapshot after the budget.
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 50)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "running");
    // Cleanup: the delete path aborts the stalled run.
    let deleted = rig
        .host
        .delete_subagent(handle.rlm_child_id.clone())
        .await
        .unwrap();
    assert_eq!(deleted.outcome, Some("deleted"));
    assert_eq!(deleted.subagent.status, "cancelled");
    // The tombstone answers the deleted selector with the settled
    // cancelled envelope.
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap();
    let result = one(&collected);
    assert_eq!(result.status, "cancelled");
    assert!(result.settled);
    assert_eq!(
        result.error.as_deref(),
        Some("Deleted by parent orchestrator")
    );
    assert!(rig.host.list_subagents().await.unwrap().is_empty());
}

#[tokio::test]
async fn deleting_a_running_child_delivers_the_cancelled_notice() {
    let rig = TestRig::new().await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("doomed"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // The delete path owns the cancellation row: it claims the notice (no
    // pre-marked flag suppresses it) and admits it on the idle parent.
    rig.catalog
        .provider("glm-5.3")
        .push_text_turn("notice turn");
    // The engine probe captures its weak before the delete clears the
    // registry: the deleted RUNNING child must also release (the abort
    // ends its run, the run task releases the listener, the engine tears
    // down).
    let engine_weak = {
        let child = rig.first_child().await;
        let weak = Arc::downgrade(&child.engine);
        assert!(weak.upgrade().is_some());
        weak
    };
    let deleted = rig
        .host
        .delete_subagent(handle.rlm_child_id.clone())
        .await
        .unwrap();
    assert_eq!(deleted.outcome, Some("deleted"));
    // The cancellation notice admitted BEFORE the settled state landed, so
    // the delete receipt itself implies it: at the receipt's return the
    // notice turn is streaming or its row already persisted — no
    // polling-ahead window exists for a concurrent collect.
    let streaming = rig.engine.session.agent().state().await.is_streaming;
    let notice_admitted = rig.parent_rows().await.iter().any(|entry| {
        matches!(
            entry,
            pa_types::session::FileEntry::CustomMessage { payload, .. }
                if payload.custom_type
                    == crate::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE
        )
    });
    assert!(
        streaming || notice_admitted,
        "the delete receipt implies the cancelled notice admission"
    );
    eventually("the deleted running child's engine to drop", || {
        let probe = engine_weak.clone();
        async move { probe.upgrade().is_none() }
    })
    .await;
    let parent = Arc::clone(&rig.engine);
    let target_id = handle.rlm_child_id.clone();
    eventually("the cancelled notice row", move || {
        let parent = Arc::clone(&parent);
        let target_id = target_id.clone();
        async move {
            let rows = parent
                .session
                .shared_persistence()
                .lock()
                .await
                .get_entries();
            rows.iter().any(|entry| {
                matches!(
                    entry,
                    pa_types::session::FileEntry::CustomMessage { payload, .. }
                        if payload.custom_type
                            == crate::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE
                            && payload.details.as_ref()
                                .and_then(|details| details.get("childId"))
                                .and_then(serde_json::Value::as_str)
                                == Some(target_id.as_str())
                )
            })
        }
    })
    .await;
}

#[tokio::test]
async fn a_deleted_settled_child_releases_its_engine() {
    let rig = TestRig::new().await;
    rig.catalog.provider("glm-5.3-turbo").push_text_turn("done");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("ephemeral"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    // The child engine is reachable through the record before the delete.
    let engine_weak = {
        let child = rig.first_child().await;
        let weak = Arc::downgrade(&child.engine);
        assert!(weak.upgrade().is_some());
        weak
    };
    rig.host
        .delete_subagent(handle.rlm_child_id.clone())
        .await
        .unwrap();
    // The registry dropped the record and the run task released the event
    // listener: the engine (and its kernel) tears down instead of leaking
    // through the agent's listener list.
    eventually("the deleted child's engine to drop", || {
        let probe = engine_weak.clone();
        async move { probe.upgrade().is_none() }
    })
    .await;
}

#[tokio::test]
async fn dropping_the_parent_engine_closes_the_running_subtree() {
    let rig = TestRig::new().await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("subtree"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    // A grandchild runs under the child (the cascade must reach it too).
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("grand partial");
    let _grand = child
        .child_host
        .spawn(spawn_request(
            Some("grand"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child_weak = Arc::downgrade(&child.engine);
    // Scope the strong probe Arcs: the weaks must be the only way the
    // test observes the engines after the teardown.
    let grand_weak = {
        let grand_engine = child
            .child_host
            .children()
            .await
            .first()
            .map(|record| Arc::clone(&record.engine))
            .expect("the grandchild");
        Arc::downgrade(&grand_engine)
    };
    drop(child);
    // Parent teardown: nothing calls close_children — the binding weak
    // dies with the engine, and the detached run tasks close their own
    // runs and their descendant subtrees within a settle slice.
    drop(rig);
    eventually("the child engine to drop", || {
        let probe = child_weak.clone();
        async move { probe.upgrade().is_none() }
    })
    .await;
    eventually("the grandchild engine to drop", || {
        let probe = grand_weak.clone();
        async move { probe.upgrade().is_none() }
    })
    .await;
    let _ = handle;
}

#[tokio::test]
async fn deleting_a_child_closes_its_own_running_descendants() {
    let rig = TestRig::new().await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("parent-of-grand"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // A grandchild runs under the child; the parent-side delete only
    // closes the child record — the closed watch must make the child's
    // run task tear down its own descendant subtree.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("grand partial");
    let child = rig.first_child().await;
    child
        .child_host
        .spawn(spawn_request(
            Some("grand"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child_weak = Arc::downgrade(&child.engine);
    let grand_weak = {
        let grand = child
            .child_host
            .children()
            .await
            .first()
            .map(|record| Arc::clone(&record.engine))
            .expect("the grandchild");
        Arc::downgrade(&grand)
    };
    drop(child);
    rig.host
        .delete_subagent(handle.rlm_child_id.clone())
        .await
        .unwrap();
    eventually("the deleted child's engine to drop", || {
        let probe = child_weak.clone();
        async move { probe.upgrade().is_none() }
    })
    .await;
    eventually("the grandchild engine to drop through the cascade", || {
        let probe = grand_weak.clone();
        async move { probe.upgrade().is_none() }
    })
    .await;
}

#[tokio::test]
async fn a_notice_to_a_busy_parent_is_retained_durably_before_the_run_ends() {
    let rig = TestRig::new().await;
    // The parent runs a stalled turn; the child fails instantly, so its
    // failure notice fires while the parent is busy. The row must be
    // RETAINED on the parent (durable session-file append) BEFORE the
    // child's settle becomes observable — no user turn, no run end, no
    // steering lane, no background task.
    rig.catalog.provider("glm-5.3").push_stalled_turn("busy");
    rig.engine
        .session
        .prompt(
            "hold the line",
            crate::session_engine::PromptOptions {
                return_after_accepted: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let parent = Arc::clone(&rig.engine);
    eventually("the parent to stream its stalled turn", move || {
        let parent = Arc::clone(&parent);
        async move { parent.session.agent().state().await.is_streaming }
    })
    .await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_fail_start_turn("child exploded");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("failing"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // The collect settles only after the retention, so at its return the
    // failure row is already in the parent's durable entries — while the
    // parent's own run is STILL streaming.
    rig.catalog.provider("glm-5.3").push_text_turn("after");
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "error");
    assert!(
        rig.engine.session.agent().state().await.is_streaming,
        "the parent's stalled turn is still running at the collect return"
    );
    let target_id = handle.rlm_child_id.clone();
    let retained = rig.parent_rows().await.iter().any(|entry| {
        matches!(
            entry,
            pa_types::session::FileEntry::CustomMessage { payload, .. }
                if payload.custom_type
                    == crate::session_engine::rlm_notices::RLM_CHILD_FAILURE_CUSTOM_TYPE
                    && payload.details.as_ref()
                        .and_then(|details| details.get("childId"))
                        .and_then(serde_json::Value::as_str)
                        == Some(target_id.as_str())
        )
    });
    assert!(
        retained,
        "the failure notice is retained in the parent's entries before the busy run ends"
    );
    // The busy-parent contract queues the notice for the next model
    // boundary (durable row + queued live delivery, never a user
    // prompt): the durable row is already on raw disk at the settle.
    let parent_file = session_file_of(&rig.engine).await;
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "the retained failure row on raw disk");
    assert_eq!(rows[0].child_id, target_id);
    assert!(rows[0].content.contains("child-failed child:failing"));
    // End the parent's stalled turn: the queued notice drives the next
    // model request without a user prompt, and the row survives.
    rig.engine.session.agent().abort();
    let provider = rig.catalog.provider("glm-5.3");
    let failure_header = "[child-failed child:failing]".to_string();
    eventually(
        "the queued notice to drive the next model request",
        move || {
            let provider = Arc::clone(&provider);
            let header = failure_header.clone();
            async move {
                provider
                    .calls()
                    .last()
                    .is_some_and(|context| request_ends_with_notice(context, &header))
            }
        },
    )
    .await;
    let retained_after = rig.parent_rows().await.iter().any(|entry| {
        matches!(
            entry,
            pa_types::session::FileEntry::CustomMessage { payload, .. }
                if payload.custom_type
                    == crate::session_engine::rlm_notices::RLM_CHILD_FAILURE_CUSTOM_TYPE
        )
    });
    assert!(retained_after);
}

#[tokio::test]
async fn a_delete_on_a_busy_parent_retains_the_cancelled_notice_at_the_receipt() {
    let rig = TestRig::new().await;
    // The parent is busy when the delete's cancellation notice fires: the
    // row is appended durably BEFORE the cancelled verdict settles, so
    // the delete receipt itself implies retention — a concurrent collect
    // can never observe the settled verdict ahead of it.
    rig.catalog.provider("glm-5.3").push_stalled_turn("busy");
    rig.engine
        .session
        .prompt(
            "hold the line",
            crate::session_engine::PromptOptions {
                return_after_accepted: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let parent = Arc::clone(&rig.engine);
    eventually("the parent to stream its stalled turn", move || {
        let parent = Arc::clone(&parent);
        async move { parent.session.agent().state().await.is_streaming }
    })
    .await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("doomed"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let deleted = rig
        .host
        .delete_subagent(handle.rlm_child_id.clone())
        .await
        .unwrap();
    assert_eq!(deleted.outcome, Some("deleted"));
    // At the receipt's return the cancelled notice row is already in the
    // parent's durable entries — while the parent's run still streams,
    // with no user turn and no background delivery.
    let target_id = handle.rlm_child_id.clone();
    let retained = rig.parent_rows().await.iter().any(|entry| {
        matches!(
            entry,
            pa_types::session::FileEntry::CustomMessage { payload, .. }
                if payload.custom_type
                    == crate::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE
                    && payload.details.as_ref()
                        .and_then(|details| details.get("childId"))
                        .and_then(serde_json::Value::as_str)
                        == Some(target_id.as_str())
        )
    });
    assert!(
        retained,
        "the cancelled notice is retained before the delete receipt returns"
    );
    assert!(
        rig.engine.session.agent().state().await.is_streaming,
        "no delivery task ran: the parent's stalled turn is still going"
    );
    // The tombstone envelope answers the deleted selector.
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "cancelled");
    rig.engine.session.agent().abort();
}

#[tokio::test]
async fn deleting_a_settled_child_reports_the_agreed_verdict() {
    let rig = TestRig::new().await;
    rig.catalog.provider("glm-5.3-turbo").push_text_turn("done");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("finished"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    // The run's no-reply notice owns the done verdict; the delete's
    // cancelled claim loses and the receipt reports the AGREED verdict.
    let deleted = rig
        .host
        .delete_subagent(handle.rlm_child_id.clone())
        .await
        .unwrap();
    assert_eq!(deleted.outcome, Some("deleted"));
    assert_eq!(
        deleted.subagent.status, "completed",
        "the receipt reports the run's claimed verdict, not a racing cancelled"
    );
}

#[tokio::test]
async fn an_error_run_settles_only_after_its_failure_notice() {
    let rig = TestRig::new().await;
    // The child's only scripted turn fails at the stream call: the prompt
    // admission itself errors and the run task takes the error verdict.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_fail_start_turn("provider exploded");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("broken"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    rig.catalog
        .provider("glm-5.3")
        .push_text_turn("notice turn");
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    let result = one(&collected);
    assert_eq!(result.status, "error");
    assert!(result.settled);
    // The settled state exposed by the collect already implies the
    // failure notice was admitted (streaming) or its row persisted.
    let streaming = rig.engine.session.agent().state().await.is_streaming;
    let failure_admitted = rig.parent_rows().await.iter().any(|entry| {
        matches!(
            entry,
            pa_types::session::FileEntry::CustomMessage { payload, .. }
                if payload.custom_type
                    == crate::session_engine::rlm_notices::RLM_CHILD_FAILURE_CUSTOM_TYPE
        )
    });
    assert!(
        streaming || failure_admitted,
        "the failure notice admission precedes the error settle"
    );
    let parent = Arc::clone(&rig.engine);
    eventually("the failure notice row", move || {
        let parent = Arc::clone(&parent);
        async move {
            let rows = parent
                .session
                .shared_persistence()
                .lock()
                .await
                .get_entries();
            rows.iter().any(|entry| {
                matches!(
                    entry,
                    pa_types::session::FileEntry::CustomMessage { payload, .. }
                        if payload.custom_type
                            == crate::session_engine::rlm_notices::RLM_CHILD_FAILURE_CUSTOM_TYPE
                )
            })
        }
    })
    .await;
}

#[tokio::test]
async fn child_usage_attributes_into_the_parent_row() {
    let rig = TestRig::new().await;
    rig.run_parent_turn("parent's spawning turn").await;
    rig.catalog.provider("glm-5.3-turbo").push_text_turn("done");
    let handle = rig
        .host
        .spawn(spawn_request(None, Some("test-provider/glm-5.3-turbo")))
        .await
        .unwrap();
    // The kernel's `rlm.run` handler registers the spawn target on the
    // parent's producer; the direct host call does the same registration
    // here so the child's batches fold.
    rig.engine
        .rlm_usage
        .register_spawn(&handle.rlm_child_id)
        .await;
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    let attributions = rig
        .parent_rows()
        .await
        .iter()
        .filter(|entry| {
            matches!(
                entry,
                pa_types::session::FileEntry::ChildUsageAttributed { .. }
            )
        })
        .count();
    assert_eq!(attributions, 1, "one per-origin attribution row");
}

#[tokio::test]
async fn progress_notes_surface_in_the_roster() {
    let rig = TestRig::new().await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("partial");
    let handle = rig
        .host
        .spawn(spawn_request(None, Some("test-provider/glm-5.3-turbo")))
        .await
        .unwrap();
    // The child's own `rlm.progress.note` store feeds the roster row.
    let child = rig.first_child().await;
    let _ = child.engine.rlm.notes.note("halfway there", 1_000).await;
    let roster = rig.host.list_subagents().await.unwrap();
    assert_eq!(roster[0].progress_note.as_deref(), Some("halfway there"));
    let _ = rig.host.delete_subagent(handle.rlm_child_id).await;
}

#[tokio::test]
async fn collect_settles_only_after_the_notice_is_admitted() {
    let rig = TestRig::new().await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("quiet"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // The child settles without an agent-message reply; the settle
    // signal publishes only after the no-reply notice is admitted on the
    // parent, so at the collect return the notice turn is already
    // admitted (streaming) or its row already persisted.
    rig.catalog
        .provider("glm-5.3")
        .push_text_turn("notice reply");
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    let streaming = rig.engine.session.agent().state().await.is_streaming;
    let notice_admitted = rig.parent_rows().await.iter().any(|entry| {
        matches!(
            entry,
            pa_types::session::FileEntry::CustomMessage { payload, .. }
                if payload.custom_type
                    == crate::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE
        )
    });
    assert!(
        streaming || notice_admitted,
        "the no-reply notice admission precedes the collect settle"
    );
    let parent = Arc::clone(&rig.engine);
    eventually("the no-reply notice row", move || {
        let parent = Arc::clone(&parent);
        async move {
            let rows = parent
                .session
                .shared_persistence()
                .lock()
                .await
                .get_entries();
            rows.iter().any(|entry| {
                matches!(
                    entry,
                    pa_types::session::FileEntry::CustomMessage { payload, .. }
                        if payload.custom_type
                            == crate::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE
                )
            })
        }
    })
    .await;
}

#[tokio::test]
async fn a_child_reply_suppresses_the_notice() {
    let rig = TestRig::new().await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("working");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("chatty"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // The child's family controller: the parent is its one family member.
    let child = rig.first_child().await;
    let controller = InProcessFamilyController::new(
        Arc::clone(&child.child_host),
        FamilySelf::Child {
            child_id: handle.rlm_child_id.clone(),
        },
    );
    let family = controller.family().await.unwrap();
    assert_eq!(family.len(), 1);
    assert_eq!(family[0].id, rig.engine.session.session_id().await);
    assert_eq!(family[0].relationship.as_str(), "parent");
    // The requested name is durable session state: the child's own file
    // carries the session-info row, and the parent binding reads it.
    let child_session_name = child
        .engine
        .session
        .shared_persistence()
        .lock()
        .await
        .get_session_name();
    assert_eq!(child_session_name.as_deref(), Some("chatty"));
    // The reply delivers as the parent's own turn; the parent's script
    // needs that turn queued.
    rig.catalog.provider("glm-5.3").push_text_turn("parent ack");
    let receipt = controller
        .send_agent_message(AgentMessageSendInput {
            target: family[0].id.clone(),
            message: "task done, shipping the report".to_string(),
            receiver_role: None,
        })
        .await
        .unwrap();
    assert_eq!(receipt.delivery_status.as_str(), "delivered");
    rig.engine.session.agent().wait_for_idle().await;
    // The reply landed on the parent as the agent-message row.
    let rows = rig.parent_rows().await;
    let reply_rows = rows
        .iter()
        .filter(|entry| {
            matches!(
                entry,
                pa_types::session::FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type
                        == crate::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE
            )
        })
        .count();
    assert_eq!(reply_rows, 1);
    // The child's reply flipped the record's replied flag.
    assert!(child.state().await.replied_since_task);
    // The abort settles the stalled run; the no-reply notice is withheld.
    // Wait until the child's stalled run is actually streaming (an abort
    // before the run registers is a no-op).
    let streaming_child = Arc::clone(&child.engine);
    eventually("the child streams", move || {
        let engine = Arc::clone(&streaming_child);
        async move { engine.session.agent().state().await.is_streaming }
    })
    .await;
    child.engine.session.agent().abort();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    rig.run_parent_turn("drain").await;
    let notice_rows = rig
        .parent_rows()
        .await
        .iter()
        .filter(|entry| {
            matches!(
                entry,
                pa_types::session::FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type
                        == crate::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE
            )
        })
        .count();
    assert_eq!(notice_rows, 0, "the reply suppressed the notice");
}

#[tokio::test]
async fn the_parent_reaches_and_observes_its_children() {
    let rig = TestRig::new().await;
    rig.catalog.provider("glm-5.3-turbo").push_text_turn("done");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("solo"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    // The parent's controller sees the child as its family.
    let controller = InProcessFamilyController::new(Arc::clone(&rig.host), FamilySelf::Root);
    let family = controller.family().await.unwrap();
    assert_eq!(family.len(), 1);
    assert_eq!(family[0].id, handle.rlm_child_id);
    assert_eq!(family[0].name.as_deref(), Some("solo"));
    // The observe roster: the parent (current) plus the child.
    let agents = controller.list_agents().await.unwrap();
    assert_eq!(agents.len(), 2);
    assert!(agents.iter().any(|agent| agent.is_current));
    let parent_session_id = rig.engine.session.session_id().await;
    let child_row = agents
        .iter()
        .find(|agent| agent.session_id != parent_session_id)
        .expect("the child summary")
        .clone();
    assert_eq!(
        child_row.relationship.map(|role| role.as_str()),
        Some("child")
    );
    assert_eq!(child_row.runtime_kind.as_deref(), Some("subagent"));
    // The parent messages the child by name: delivered as the child's
    // own turn.
    let child = rig.first_child().await;
    let _ = child.engine.rlm.notes.note("unrelated", 1).await;
    rig.catalog.provider("glm-5.3-turbo").push_text_turn("ack");
    let receipt = controller
        .send_agent_message(AgentMessageSendInput {
            target: "solo".to_string(),
            message: "status?".to_string(),
            receiver_role: None,
        })
        .await
        .unwrap();
    assert_eq!(receipt.delivery_status.as_str(), "delivered");
    child.engine.session.agent().wait_for_idle().await;
    // The child's transcript carries the rendered prompt row.
    let child_entries = child
        .engine
        .session
        .shared_persistence()
        .lock()
        .await
        .get_entries();
    let has_row = child_entries.iter().any(|entry| {
        matches!(
            entry,
            pa_types::session::FileEntry::CustomMessage { payload, .. }
                if payload.custom_type
                    == crate::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE
        )
    });
    assert!(has_row, "the delivered row persisted on the child");
    // The child's recent messages are observable from the parent.
    let recent = controller
        .recent_messages(&child_row.session_id, 10, 800)
        .await
        .unwrap();
    assert!(!recent.is_empty());
}

#[tokio::test]
async fn an_idle_target_send_returns_at_admission() {
    let rig = TestRig::new().await;
    // The child stalls mid-turn; the parent sends it a message while it
    // is busy: the receipt returns when the steering lane accepts the
    // row, without waiting the child's (never-ending) model turn.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("busy"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    eventually("the child streams", move || {
        let engine = Arc::clone(&child.engine);
        async move { engine.session.agent().state().await.is_streaming }
    })
    .await;
    let controller = InProcessFamilyController::new(Arc::clone(&rig.host), FamilySelf::Root);
    let receipt = controller
        .send_agent_message(AgentMessageSendInput {
            target: handle.rlm_child_id.clone(),
            message: "status?".to_string(),
            receiver_role: None,
        })
        .await
        .unwrap();
    assert_eq!(receipt.delivery_status.as_str(), "queued");
    // An IDLE target admits the injected row and returns at admission:
    // the sender resumes while the target's model turn still runs.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("reply");
    let child2 = rig.first_child().await;
    child2.engine.session.agent().abort();
    child2.engine.session.agent().wait_for_idle().await;
    let controller = InProcessFamilyController::new(
        Arc::clone(&child2.child_host),
        FamilySelf::Child {
            child_id: handle.rlm_child_id.clone(),
        },
    );
    let parent_id = rig.engine.session.session_id().await;
    rig.catalog
        .provider("glm-5.3")
        .push_stalled_turn("parent turn");
    let started = std::time::Instant::now();
    let receipt = controller
        .send_agent_message(AgentMessageSendInput {
            target: parent_id,
            message: "reply while the parent streams".to_string(),
            receiver_role: None,
        })
        .await
        .unwrap();
    // The receipt landed in well under a model turn (admission, not run
    // completion). The atomic admission registers the run slot before the
    // executor flips the streaming state, so the probe waits for the
    // state to confirm the admitted turn is live.
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(receipt.delivery_status.as_str(), "delivered");
    eventually("the admitted parent turn to stream", || {
        let agent = Arc::clone(rig.engine.session.agent());
        async move { agent.state().await.is_streaming }
    })
    .await;
    rig.engine.session.agent().abort();
}

#[tokio::test]
async fn the_child_session_name_lands_in_the_session_file() {
    let rig = TestRig::new().await;
    rig.catalog.provider("glm-5.3-turbo").push_text_turn("done");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("named-worker"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    // The durable file carries the session-info row (a resumed child file
    // reads its own name), not just the registry metadata.
    let child = rig.first_child().await;
    let entries = child
        .engine
        .session
        .shared_persistence()
        .lock()
        .await
        .get_entries();
    let name_row = entries.iter().find_map(|entry| match entry {
        pa_types::session::FileEntry::SessionInfo { payload, .. } => payload.name.clone(),
        _ => None,
    });
    assert_eq!(name_row.as_deref(), Some("named-worker"));
    // The child's own observe row reports the durable name.
    let controller = InProcessFamilyController::new(
        Arc::clone(&child.child_host),
        FamilySelf::Child {
            child_id: handle.rlm_child_id.clone(),
        },
    );
    let agents = controller.list_agents().await.unwrap();
    let self_row = agents
        .iter()
        .find(|agent| agent.is_current)
        .expect("the child's own observe row");
    assert_eq!(self_row.session_name.as_deref(), Some("named-worker"));
}

#[tokio::test]
async fn a_composed_remote_family_routes_sends_beyond_the_local_graph() {
    struct RemoteSurface {
        members: Vec<crate::session_engine::agent_messaging::AgentFamilyMember>,
        sent: Mutex<Vec<String>>,
    }
    impl RemoteSurface {
        /// One remote observe row for the roster join (the seam's optional
        /// observe surface).
        fn remote_row() -> crate::session_engine::agent_messaging::AgentObserveSummary {
            crate::session_engine::agent_messaging::AgentObserveSummary {
                active_session_id: Some("cloud-parent".to_string()),
                session_id: "cloud-parent".to_string(),
                session_name: Some("cloud-parent".to_string()),
                relationship: Some(
                    crate::session_engine::agent_messaging::AgentFamilyRelationship::Parent,
                ),
                runtime_kind: Some("top-level".to_string()),
                status: crate::session_engine::agent_messaging::AgentFamilyStatus::Idle,
                activity: None,
                is_current: false,
                is_streaming: false,
                is_compacting: false,
                attached_clients: 0,
                queued_count: 0,
                is_session_active: true,
            }
        }
    }
    impl super::RlmRemoteFamily for RemoteSurface {
        fn members(
            &self,
        ) -> crate::session_engine::rlm_host::RlmHostFuture<
            Vec<crate::session_engine::agent_messaging::AgentFamilyMember>,
        > {
            let members = self.members.clone();
            Box::pin(async move { Ok(members) })
        }
        fn observe_summaries(
            &self,
        ) -> crate::session_engine::rlm_host::RlmHostFuture<
            Vec<crate::session_engine::agent_messaging::AgentObserveSummary>,
        > {
            Box::pin(async move { Ok(vec![Self::remote_row()]) })
        }
        fn send(
            &self,
            input: AgentMessageSendInput,
        ) -> crate::session_engine::rlm_host::RlmHostFuture<
            crate::session_engine::agent_messaging::AgentMessageReceipt,
        > {
            self.sent.lock().unwrap().push(input.message.clone());
            Box::pin(async move {
                Ok(crate::session_engine::agent_messaging::AgentMessageReceipt {
                    id: "remote".to_string(),
                    target: "cloud-parent".to_string(),
                    target_session_id: None,
                    target_session_name: Some("cloud-parent".to_string()),
                    target_runtime_kind: Some("top-level".to_string()),
                    message: input.message,
                    delivery_status:
                        crate::session_engine::agent_messaging::AgentMessageDeliveryStatus::Delivered,
                    delivery_mode: None,
                    receiver_role: input.receiver_role,
                    delivered_at: None,
                    queued_at: None,
                })
            })
        }
    }
    // The remote seam is a composition concern of the ROOT host: a host
    // built without it stays local-only.
    let rig = TestRig::new().await;
    let controller = InProcessFamilyController::new(Arc::clone(&rig.host), FamilySelf::Root);
    let error = controller
        .send_agent_message(AgentMessageSendInput {
            target: "cloud-parent".to_string(),
            message: "up?".to_string(),
            receiver_role: None,
        })
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("No agent message target matches"),
        "{error}"
    );
    // A composed remote family extends the roster and routes non-local
    // sends through the seam.
    let remote = Arc::new(RemoteSurface {
        members: vec![crate::session_engine::agent_messaging::AgentFamilyMember {
            relationship: crate::session_engine::agent_messaging::AgentFamilyRelationship::Parent,
            id: "cloud-parent".to_string(),
            name: Some("cloud-parent".to_string()),
            aliases: Vec::new(),
        }],
        sent: Mutex::new(Vec::new()),
    });
    let host = Arc::new(InProcessRlmHost::new(super::InProcessRlmHostConfig {
        agent_dir: rig.agent_dir.clone(),
        registry: Arc::clone(&rig.host.config().registry),
        stream_fn_factory: rig.catalog.factory(),
        rlm_depth: 0,
        rlm_max_depth: 0,
        default_thinking: None,
        remote_family: Some(remote.clone() as Arc<dyn super::RlmRemoteFamily>),
        root_runtime_kind: Some("subagent".to_string()),
    }));
    host.bind_parent(Arc::clone(&rig.engine)).await.unwrap();
    let controller = InProcessFamilyController::new(host, FamilySelf::Root);
    let family = controller.family().await.unwrap();
    assert!(family.iter().any(|member| member.id == "cloud-parent"));
    let receipt = controller
        .send_agent_message(AgentMessageSendInput {
            target: "cloud-parent".to_string(),
            message: "up?".to_string(),
            receiver_role: None,
        })
        .await
        .unwrap();
    assert_eq!(receipt.id, "remote");
    assert_eq!(
        remote.sent.lock().unwrap().as_slice(),
        ["up?".to_string()].as_slice()
    );
    // The seam's observe rows ride the roster, and a remote row resolves
    // through get_agent.
    let agents = controller.list_agents().await.unwrap();
    let remote_row = agents
        .iter()
        .find(|agent| agent.session_id == "cloud-parent")
        .expect("the remote observe row");
    assert!(!remote_row.is_current);
    let fetched = controller.get_agent("cloud-parent").await.unwrap();
    assert!(fetched.is_some_and(|agent| agent.session_id == "cloud-parent"));
    // The composed root kind surfaces on the root's own observe row.
    let agents = controller.list_agents().await.unwrap();
    let self_row = agents
        .iter()
        .find(|agent| agent.is_current)
        .expect("the root observe row");
    assert_eq!(self_row.runtime_kind.as_deref(), Some("subagent"));
}

// ---------------------------------------------------------------------------
// The terminal-notice disk battery
// ---------------------------------------------------------------------------
//
// The design's verifier gates driven deterministically against the real
// session JSONL and the recorded provider requests: strict retention
// before settle, first-wins verdicts against delete and close, the
// reply's narrow suppression, grandchildren targeting their own parent,
// replay after reopen, and the injected failure matrix. Nothing here
// trusts the in-memory row index alone.

/// The wire `customType` of the consumption-marker row (the manager's
/// `NOTICE_CONSUMED_CUSTOM_TYPE`, pinned from raw disk).
const RAW_NOTICE_CONSUMED_TYPE: &str = "notice_consumed";

/// The raw JSONL rows of one session file: every line must parse as
/// complete JSON, so a torn or partial write fails here instead of in
/// production's in-memory index.
fn raw_lines(path: &Path) -> Vec<serde_json::Value> {
    let text = std::fs::read_to_string(path).expect("the session file reads");
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("a complete JSONL line"))
        .collect()
}

/// One terminal-notice row read from raw disk.
struct RawNotice {
    custom_type: String,
    /// `cancelled` | `completed_without_reply` for terminal notices,
    /// `error` for failure rows (their details carry no kind).
    kind: String,
    child_id: String,
    notice_key: String,
    content: String,
}

/// The terminal-notice rows (no-reply/cancelled/failure) on raw disk.
fn raw_notice_rows(path: &Path) -> Vec<RawNotice> {
    let terminal = crate::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE;
    let failure = crate::session_engine::rlm_notices::RLM_CHILD_FAILURE_CUSTOM_TYPE;
    raw_lines(path)
        .into_iter()
        .filter_map(|line| {
            let custom_type = line["customType"].as_str()?.to_string();
            if line["type"] != "custom_message"
                || (custom_type != terminal && custom_type != failure)
            {
                return None;
            }
            let kind = if custom_type == failure {
                "error".to_string()
            } else {
                line["details"]["kind"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            };
            Some(RawNotice {
                custom_type,
                kind,
                child_id: line["details"]["childId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                notice_key: line["details"]["noticeKey"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                content: line["content"].as_str().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

/// The raw consumption-marker keys on disk (the wire `noticeKeys` of the
/// marker rows).
fn raw_consumed_keys(path: &Path) -> Vec<String> {
    raw_lines(path)
        .into_iter()
        .filter(|line| line["type"] == "custom" && line["customType"] == RAW_NOTICE_CONSUMED_TYPE)
        .filter_map(|line| {
            line["data"]["noticeKeys"].as_array().map(|keys| {
                keys.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
        })
        .flatten()
        .collect()
}

/// One session's durable file path.
async fn session_file_of(engine: &SessionEngine) -> PathBuf {
    engine
        .session
        .shared_persistence()
        .lock()
        .await
        .get_session_file()
        .map(PathBuf::from)
        .expect("a persisted session file")
}

/// One child's durable file path.
fn child_file(record: &super::registry::InProcessChildRecord) -> PathBuf {
    Path::new(&record.session_dir).join(format!("{}.jsonl", record.session_id))
}

/// The assistant message rows on raw disk.
fn raw_assistant_rows(path: &Path) -> usize {
    raw_lines(path)
        .iter()
        .filter(|line| line["message"]["role"] == "assistant")
        .count()
}

/// Whether the newest context row of one provider request carries the
/// notice text `header` (a notice-only turn: no user prompt rode it).
fn request_ends_with_notice(context: &pa_agent::stream::LlmContext, header: &str) -> bool {
    context
        .messages
        .last()
        .and_then(|message| serde_json::to_string(message).ok())
        .is_some_and(|text| text.contains(header))
}

/// One deterministic seam pause: the production arm confirms arrival
/// (a two-party barrier) and then blocks until the test opens the latch.
/// The latch is stateful — a release before arrival also passes.
#[derive(Clone)]
struct GateLatch {
    arrived: Arc<tokio::sync::Barrier>,
    open: Arc<tokio::sync::watch::Sender<bool>>,
}

impl GateLatch {
    fn new() -> Self {
        let (open, _) = tokio::sync::watch::channel(false);
        Self {
            arrived: Arc::new(tokio::sync::Barrier::new(2)),
            open: Arc::new(open),
        }
    }

    /// The hook side: announce arrival, then wait for the release.
    async fn hold(&self) {
        self.arrived.wait().await;
        let mut released = self.open.subscribe();
        let _ = released.wait_for(|value| *value).await;
    }

    /// The test side: the arm reached the seam.
    async fn reached(&self) {
        self.arrived.wait().await;
    }

    /// The test side: let the arm proceed.
    fn release(&self) {
        self.open.send_replace(true);
    }
}

/// The child-arm seams a test can pause.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionSeam {
    /// After the durable append, before the live enqueue.
    RowDurable,
    /// After the provider responded, before the assistant row lands.
    BeforePersist,
    /// After the assistant row landed, before the consumption marker.
    BeforeMarker,
}

/// The session-seam pause latches of one test. Only the installed seams
/// hold; everything else passes through unheld.
struct SessionGates {
    row_durable: GateLatch,
    before_persist: GateLatch,
    before_marker: GateLatch,
}

impl SessionGates {
    /// Install pause latches for the given seams; unlisted seams pass
    /// through without pausing.
    fn install(engine: &SessionEngine, seams: &[SessionSeam]) -> Self {
        let gates = Self {
            row_durable: GateLatch::new(),
            before_persist: GateLatch::new(),
            before_marker: GateLatch::new(),
        };
        let armed = seams.to_vec();
        let row_hook = gates.row_durable.clone();
        let persist_hook = gates.before_persist.clone();
        let marker_hook = gates.before_marker.clone();
        engine.session.set_terminal_test_gate(Some(Arc::new(
            move |point: crate::session_engine::terminal_inbox::TerminalGatePoint| -> std::pin::Pin<
                std::boxed::Box<dyn std::future::Future<Output = ()> + Send>,
            > {
                let held = match point {
                    crate::session_engine::terminal_inbox::TerminalGatePoint::RowDurable { .. }
                        if armed.contains(&SessionSeam::RowDurable) =>
                    {
                        Some(row_hook.clone())
                    }
                    crate::session_engine::terminal_inbox::TerminalGatePoint::AssistantBeforePersist { .. }
                        if armed.contains(&SessionSeam::BeforePersist) =>
                    {
                        Some(persist_hook.clone())
                    }
                    crate::session_engine::terminal_inbox::TerminalGatePoint::AssistantBeforeMarker { .. }
                        if armed.contains(&SessionSeam::BeforeMarker) =>
                    {
                        Some(marker_hook.clone())
                    }
                    _ => None,
                };
                Box::pin(async move {
                    if let Some(latch) = held {
                        latch.hold().await;
                    }
                })
            },
        )));
        gates
    }
}

/// Pause the child-arm seams — the first-wins claim and the moment just
/// before publication — with two latches. Install BEFORE spawning so the
/// terminal sequence itself pauses.
fn install_child_gates(host: &InProcessRlmHost) -> (GateLatch, GateLatch) {
    let claimed = GateLatch::new();
    let before_publish = GateLatch::new();
    let (claimed_hook, publish_hook) = (claimed.clone(), before_publish.clone());
    host.set_child_test_gate(Some(
        Arc::new(
            move |point: super::ChildGatePoint| -> std::pin::Pin<
                std::boxed::Box<dyn std::future::Future<Output = ()> + Send>,
            > {
                let held = match point {
                    super::ChildGatePoint::Claimed { .. } => Some(claimed_hook.clone()),
                    super::ChildGatePoint::BeforePublish { .. } => Some(publish_hook.clone()),
                };
                Box::pin(async move {
                    if let Some(latch) = held {
                        latch.hold().await;
                    }
                })
            },
        ),
    ));
    (claimed, before_publish)
}

/// The durable facts a killed rig leaves behind: everything a reopen
/// needs to rebuild the same parent session over the same JSONL file.
struct RigFacts {
    dir: tempfile::TempDir,
    agent_dir: PathBuf,
    sessions_dir: PathBuf,
    session_file: PathBuf,
    catalog: Arc<ScriptCatalog>,
    registry: Arc<ModelRegistry>,
}

impl TestRig {
    /// Kill the rig, keeping its durable facts for a reopen. Must not be
    /// called while a session-seam pause holds the manager lock (a kill
    /// inside such a window reads the file path captured earlier and
    /// destructures the rig directly instead).
    async fn into_facts(self) -> RigFacts {
        let TestRig {
            root: dir,
            agent_dir,
            catalog,
            host,
            engine,
        } = self;
        let session_file = engine
            .session
            .shared_persistence()
            .lock()
            .await
            .get_session_file()
            .map(PathBuf::from)
            .expect("the rig session is persisted");
        RigFacts {
            dir,
            agent_dir: agent_dir.clone(),
            sessions_dir: agent_dir.join("sessions"),
            session_file,
            catalog,
            registry: Arc::clone(&host.config().registry),
        }
    }
}

impl RigFacts {
    /// Rebuild the parent session over the same durable file: a fresh
    /// manager over the JSONL, a fresh engine on it, and a fresh host
    /// (unbound — the caller binds it, which replays the unconsumed
    /// notices).
    async fn reopen(&self) -> (Arc<SessionEngine>, Arc<InProcessRlmHost>) {
        let host = Arc::new(InProcessRlmHost::new(InProcessRlmHostConfig {
            agent_dir: self.agent_dir.clone(),
            registry: Arc::clone(&self.registry),
            stream_fn_factory: self.catalog.factory(),
            rlm_depth: 0,
            rlm_max_depth: DEFAULT_RLM_MAX_DEPTH,
            default_thinking: None,
            remote_family: None,
            root_runtime_kind: None,
        }));
        let manager = SessionManager::open(self.dir.path(), &self.sessions_dir, &self.session_file);
        let engine = Arc::new(
            create_session(SessionEngineConfig {
                cwd: self.dir.path().to_path_buf(),
                agent_dir: self.agent_dir.clone(),
                model: Some(script_model("glm-5.3")),
                stream_fn: Some(self.catalog.stream_fn("glm-5.3")),
                session_manager: Some(manager),
                rlm_depth: Some(0),
                rlm_subagent_host: Some(Arc::clone(&host) as Arc<dyn RlmSubagentHost>),
                extra_host_handlers: Some(host.family_host_handlers()),
                queued_delivery: QueuedDelivery::SessionPump,
                ..Default::default()
            })
            .await
            .unwrap(),
        );
        (engine, host)
    }
}

#[tokio::test]
async fn a_busy_fresh_parent_forces_buffered_rows_and_the_notice_to_disk() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    // The fresh parent's durable shape: header plus a session name, no
    // assistant row yet (bookkeeping rows persist, buffered transcript
    // rows defer until the strict append forces them).
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .append_session_info("fresh-rig")
        .unwrap();
    rig.catalog.provider("glm-5.3").push_stalled_turn("busy");
    rig.engine
        .session
        .prompt(
            "hold the line",
            crate::session_engine::PromptOptions {
                return_after_accepted: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let parent = Arc::clone(&rig.engine);
    eventually("the parent to stream its first turn", move || {
        let parent = Arc::clone(&parent);
        async move { parent.session.agent().state().await.is_streaming }
    })
    .await;
    // The child completes while the parent streams its first turn.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("fresher"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    // The settle implies retention: at the collect return the raw file
    // already carries the notice row — and on a fresh session it carries
    // the header, the name row, and the buffered first-turn user row the
    // strict append forced to disk.
    let lines = raw_lines(&parent_file);
    assert!(
        lines.iter().any(|line| line["type"] == "session"),
        "the header row"
    );
    assert!(
        lines
            .iter()
            .any(|line| line["type"] == "session_info" && line["name"] == "fresh-rig"),
        "the name row"
    );
    assert_eq!(
        lines
            .iter()
            .filter(|line| line["message"]["role"] == "user")
            .count(),
        1,
        "the buffered first-turn user row forced to disk"
    );
    assert!(
        lines
            .iter()
            .all(|line| line["message"]["role"] != "assistant"),
        "still no assistant row on the fresh parent"
    );
    let lines_text = serde_json::to_string(&lines).unwrap();
    assert!(lines_text.contains("hold the line"));
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "exactly one durable notice row");
    let parent_id = rig.engine.session.session_id().await;
    assert_eq!(rows[0].kind, "completed_without_reply");
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
    assert_eq!(
        rows[0].notice_key,
        format!("{parent_id}:{}", handle.rlm_child_id)
    );
    assert!(rows[0].content.contains("no-reply child:fresher"));
    // The busy parent is untouched: no user turn, no run end.
    assert!(
        rig.engine.session.agent().state().await.is_streaming,
        "the parent's first turn is still running at the collect return"
    );
    rig.engine.session.agent().abort();
}

#[tokio::test]
async fn a_killed_parent_replays_the_unconsumed_notice_without_a_user_prompt() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.catalog.provider("glm-5.3").push_stalled_turn("busy");
    rig.engine
        .session
        .prompt(
            "hold the line",
            crate::session_engine::PromptOptions {
                return_after_accepted: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let parent = Arc::clone(&rig.engine);
    eventually("the parent to stream", move || {
        let parent = Arc::clone(&parent);
        async move { parent.session.agent().state().await.is_streaming }
    })
    .await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("fresher"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    assert_eq!(raw_notice_rows(&parent_file).len(), 1);
    // The queued notice rides the abort boundary: the pump drives it as a
    // notice-only turn. The provider has no scripted turn left, so the
    // model turn errors — the notice entered a request but no successful
    // assistant row follows, which is exactly the crash interval.
    rig.engine.session.agent().abort();
    let parent_provider = rig.catalog.provider("glm-5.3");
    let notice_header = "[child-exited: no-reply child:fresher]".to_string();
    eventually("the notice-only turn at the idle transition", move || {
        let provider = Arc::clone(&parent_provider);
        let header = notice_header.clone();
        async move {
            provider
                .calls()
                .last()
                .and_then(|context| serde_json::to_string(context).ok())
                .is_some_and(|text| text.contains(&header))
        }
    })
    .await;
    rig.engine.session.agent().wait_for_idle().await;
    // A model request saw the notice but no marker covers it: the notice
    // is durably admitted and pending replay, not consumed.
    let key = format!(
        "{}:{}",
        rig.engine.session.session_id().await,
        handle.rlm_child_id
    );
    let unconsumed: Vec<String> = rig
        .engine
        .session
        .shared_persistence()
        .lock()
        .await
        .unconsumed_terminal_notices()
        .unwrap()
        .into_iter()
        .map(|(pending, _)| pending)
        .collect();
    assert!(
        unconsumed.contains(&key),
        "the model saw the notice but no consumption marker covers it"
    );
    // Kill: the engine, its children, and its pump all die here.
    let facts = rig.into_facts().await;
    assert_eq!(
        raw_notice_rows(&facts.session_file).len(),
        1,
        "the kill left one durable row"
    );
    // Reopen over the same file: the unbound engine RETAINS the
    // unconsumed notice row in its restored context (no silent drop —
    // the binding owns the strip-and-replay), alongside the buffered
    // user row.
    let (engine, host) = facts.reopen().await;
    let context_text = serde_json::to_string(&engine.session.agent().state().await.messages)
        .expect("the restored context serializes");
    assert!(context_text.contains("hold the line"));
    assert!(
        context_text.contains("no-reply child:fresher"),
        "the unbound engine retains the unconsumed notice"
    );
    // The binding replays it: one notice-only turn, no user prompt.
    facts
        .catalog
        .provider("glm-5.3")
        .push_text_turn("reopened ack");
    let calls_before = facts.catalog.provider("glm-5.3").calls().len();
    host.bind_parent(Arc::clone(&engine)).await.unwrap();
    engine.session.agent().wait_for_idle().await;
    let calls = facts.catalog.provider("glm-5.3").calls();
    assert_eq!(
        calls.len(),
        calls_before + 1,
        "the replay drove exactly one notice-only turn"
    );
    assert!(
        request_ends_with_notice(
            calls.last().expect("the replay turn's request"),
            "[child-exited: no-reply child:fresher]"
        ),
        "the replay turn ends on the notice"
    );
    // The binding stripped the retained row and re-admitted it exactly
    // once: the live context holds ONE copy, never two.
    let context_text = serde_json::to_string(&engine.session.agent().state().await.messages)
        .expect("the live context serializes");
    assert_eq!(
        context_text.matches("no-reply child:fresher").count(),
        1,
        "the replayed notice rides the live context exactly once"
    );
    // Exactly one durable row after the replay (the stable key never
    // appends twice), and the successful assistant's consumption marker
    // now covers it.
    assert_eq!(raw_notice_rows(&facts.session_file).len(), 1);
    assert!(raw_consumed_keys(&facts.session_file).contains(&key));
    let unconsumed: Vec<String> = engine
        .session
        .shared_persistence()
        .lock()
        .await
        .unconsumed_terminal_notices()
        .unwrap()
        .into_iter()
        .map(|(pending, _)| pending)
        .collect();
    assert!(unconsumed.is_empty(), "the replay turn consumed the notice");
    // A second reopen finds the notice consumed: it enters the restored
    // context normally and nothing replays it.
    drop(engine);
    drop(host);
    let (engine, host) = facts.reopen().await;
    let context_text = serde_json::to_string(&engine.session.agent().state().await.messages)
        .expect("the restored context serializes");
    assert!(
        context_text.contains("no-reply child:fresher"),
        "the consumed notice rides the restored context"
    );
    let lines_before = raw_lines(&facts.session_file).len();
    let calls_before = facts.catalog.provider("glm-5.3").calls().len();
    host.bind_parent(Arc::clone(&engine)).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    assert_eq!(
        facts.catalog.provider("glm-5.3").calls().len(),
        calls_before,
        "nothing replays a consumed notice"
    );
    assert_eq!(
        raw_lines(&facts.session_file).len(),
        lines_before,
        "a consumed replay appends nothing"
    );
    assert_eq!(raw_notice_rows(&facts.session_file).len(), 1);
}

#[tokio::test]
async fn a_faulted_notice_admission_stays_pending_and_recovers_to_one_row() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("stalled"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let child_engine = Arc::clone(&child.engine);
    eventually("the child to stream", move || {
        let engine = Arc::clone(&child_engine);
        async move { engine.session.agent().state().await.is_streaming }
    })
    .await;
    // The strict append starts failing before it touches the file.
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(true);
    child.engine.session.agent().abort();
    // The claim won; the admission failed; the verdict stays unpublished
    // with a visible diagnostic.
    let child_id = handle.rlm_child_id.clone();
    eventually("the pending admission diagnostic", || {
        let rig = &rig;
        let child_id = child_id.clone();
        async move {
            let collected = rig.host.collect(vec![child_id], 0).await.unwrap();
            let result = one(&collected);
            result.status == "running"
                && result
                    .error
                    .as_deref()
                    .unwrap_or_default()
                    .contains("Terminal notice admission pending")
        }
    })
    .await;
    // A bounded collect returns the pending snapshot — never a hang, and
    // never a premature settle.
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 400)
        .await
        .unwrap();
    let result = one(&collected);
    assert_eq!(result.status, "running");
    assert!(!result.settled);
    // The fault wrote nothing: no row and no partial line on raw disk.
    assert!(raw_notice_rows(&parent_file).is_empty());
    // Recovery: clear the fault; the retry commits the same row and
    // delivers it live as a notice-only turn.
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(false);
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    let result = one(&collected);
    assert_eq!(result.status, "done");
    assert!(result.settled);
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "the retried admission committed one row");
    let parent_id = rig.engine.session.session_id().await;
    assert_eq!(
        rows[0].notice_key,
        format!("{parent_id}:{}", handle.rlm_child_id)
    );
    rig.engine.session.agent().wait_for_idle().await;
    let calls = rig.catalog.provider("glm-5.3").calls();
    assert!(
        request_ends_with_notice(
            calls.last().expect("the notice turn's request"),
            "[child-exited: no-reply child:stalled]"
        ),
        "the recovered admission delivered the notice as the newest context row"
    );
}

#[tokio::test]
async fn a_bare_inbox_close_keeps_the_claim_pending_without_a_row() {
    // The embedding's close order is the recursive host close around the
    // generation close. A bare inbox close while a child's admission is
    // mid-flight violates that order: the winning claim stays pending —
    // no row, no settle, a visible diagnostic — never a fabricated
    // verdict.
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("cut-off"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let child_engine = Arc::clone(&child.engine);
    eventually("the child to stream", move || {
        let engine = Arc::clone(&child_engine);
        async move { engine.session.agent().state().await.is_streaming }
    })
    .await;
    rig.engine.session.close_terminal_inbox().await;
    child.engine.session.agent().abort();
    let child_id = handle.rlm_child_id.clone();
    eventually("the pending admission diagnostic", || {
        let rig = &rig;
        let child_id = child_id.clone();
        async move {
            let collected = rig.host.collect(vec![child_id], 0).await.unwrap();
            let result = one(&collected);
            result.status == "running"
                && result
                    .error
                    .as_deref()
                    .unwrap_or_default()
                    .contains("Terminal notice admission pending")
        }
    })
    .await;
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 400)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "running");
    assert!(
        raw_notice_rows(&parent_file).is_empty(),
        "a closed generation admits no row"
    );
}

#[tokio::test]
async fn delete_racing_completion_agrees_on_one_verdict_one_row() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    // The parent stays idle across the races; these turns absorb the
    // reply delivery and whichever notice turn a winner admits.
    rig.catalog.provider("glm-5.3").push_text_turn("ack one");
    rig.catalog.provider("glm-5.3").push_text_turn("ack two");
    // Race 1: a completing child (an aborted stall settles Done) against
    // the delete. Whoever claims first wins; every interleaving must
    // agree on one verdict and one row.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("racer"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let child_id = handle.rlm_child_id.clone();
    let (deleted, ()) = tokio::join!(
        async { rig.host.delete_subagent(child_id.clone()).await.unwrap() },
        async {
            child.engine.session.agent().abort();
        },
    );
    assert_eq!(deleted.outcome, Some("deleted"));
    let rows: Vec<_> = raw_notice_rows(&parent_file)
        .into_iter()
        .filter(|row| row.child_id == child_id)
        .collect();
    assert_eq!(rows.len(), 1, "one verdict, one durable row");
    match deleted.subagent.status {
        "completed" => assert_eq!(rows[0].kind, "completed_without_reply"),
        "cancelled" => assert_eq!(rows[0].kind, "cancelled"),
        other => panic!("unexpected delete receipt status: {other}"),
    }
    let collected = rig.host.collect(vec![child_id], 0).await.unwrap();
    assert!(one(&collected).settled);
    // Race 2: the same race with an explicit reply in flight. A
    // DoneReplied win leaves no row at all (the reply suppressed the
    // no-reply notice); a cancelled win keeps its cancelled row.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("chatty partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("chatty"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let controller = InProcessFamilyController::new(
        Arc::clone(&child.child_host),
        FamilySelf::Child {
            child_id: handle.rlm_child_id.clone(),
        },
    );
    let family = controller.family().await.unwrap();
    let receipt = controller
        .send_agent_message(AgentMessageSendInput {
            target: family[0].id.clone(),
            message: "task done, shipping the report".to_string(),
            receiver_role: None,
        })
        .await
        .unwrap();
    assert!(matches!(
        receipt.delivery_status.as_str(),
        "delivered" | "queued"
    ));
    let child_id = handle.rlm_child_id.clone();
    let (deleted, ()) = tokio::join!(
        async { rig.host.delete_subagent(child_id.clone()).await.unwrap() },
        async {
            child.engine.session.agent().abort();
        },
    );
    assert_eq!(deleted.outcome, Some("deleted"));
    let rows: Vec<_> = raw_notice_rows(&parent_file)
        .into_iter()
        .filter(|row| row.child_id == child_id)
        .collect();
    match deleted.subagent.status {
        "completed" => assert!(rows.is_empty(), "the reply suppressed the no-reply row"),
        "cancelled" => {
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].kind, "cancelled");
        }
        other => panic!("unexpected delete receipt status: {other}"),
    }
}

#[tokio::test]
async fn rename_updates_child_durable_row_roster_and_self() {
    let rig = TestRig::new().await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("original"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;

    // A child NAME never selects a rename target (TS
    // `renameAgentFamilySession`): the id-only resolution refuses it with
    // the name-not-selectable error.
    let by_name = rig
        .host
        .rename("renamed".to_string(), Some("original".to_string()))
        .await;
    let by_name = by_name.expect_err("a session name never selects a rename");
    assert!(
        by_name.to_string().contains("not a session name"),
        "the name-only target refuses: {by_name}"
    );

    // The rename by child id lands three places: the child's durable
    // session_info row, the roster copy, and the applied answer.
    let applied = rig
        .host
        .rename("renamed".to_string(), Some(handle.rlm_child_id.clone()))
        .await
        .expect("rename by child id");
    assert_eq!(applied, "renamed");
    let child_file = child_file(&child);
    assert!(
        raw_lines(&child_file)
            .iter()
            .any(|line| line["type"] == "session_info" && line["name"] == "renamed"),
        "the child's durable file carries the renamed session_info row"
    );
    let roster = rig.host.list_subagents().await.unwrap();
    assert_eq!(roster[0].session_name, "renamed");

    // The TS sibling-uniqueness refusal: no second live child of this
    // parent may take a held name.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("second partial");
    let second = rig
        .host
        .spawn(spawn_request(
            Some("second"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collision = rig
        .host
        .rename("renamed".to_string(), Some(second.rlm_child_id.clone()))
        .await;
    let collision = collision.expect_err("a held name refuses");
    assert!(
        collision.to_string().contains("unavailable"),
        "the sibling collision refuses: {collision}"
    );

    // The absent session id renames the parent session itself: one
    // durable session_info row on the parent's own file.
    let self_renamed = rig
        .host
        .rename("parent-name".to_string(), None)
        .await
        .expect("self rename");
    assert_eq!(self_renamed, "parent-name");
    let parent_file = session_file_of(&rig.engine).await;
    assert!(
        raw_lines(&parent_file)
            .iter()
            .any(|line| line["type"] == "session_info" && line["name"] == "parent-name"),
        "the parent's durable file carries its own renamed session_info row"
    );
}

#[tokio::test]
async fn close_children_racing_completion_keeps_one_verdict_no_tombstone() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog.provider("glm-5.3").push_text_turn("parent ack");
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("subtree"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    // A grandchild under the child: the close's cascade must reach it.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("grand partial");
    let _grand = child
        .child_host
        .spawn(spawn_request(
            Some("grand"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let grand_weak = {
        let grand = child
            .child_host
            .children()
            .await
            .first()
            .cloned()
            .expect("the grandchild");
        Arc::downgrade(&grand.engine)
    };
    // The completion (an aborted stall settles Done) and the embedding's
    // recursive close genuinely race; both orders must agree.
    let ((), ()) = tokio::join!(rig.host.close_children(), async {
        child.engine.session.agent().abort();
    },);
    // One verdict: the winning claim, the settled status, and the row
    // kind all agree.
    let kind = child.claimed_kind().await.expect("a settled claim");
    let status = child.state().await.settled_status.expect("settled");
    let rows: Vec<_> = raw_notice_rows(&parent_file)
        .into_iter()
        .filter(|row| row.child_id == handle.rlm_child_id)
        .collect();
    match kind {
        super::registry::NoticeKind::Done => {
            assert_eq!(status, "done");
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].kind, "completed_without_reply");
        }
        super::registry::NoticeKind::Closed => {
            assert_eq!(status, "cancelled");
            assert!(rows.is_empty(), "the close claim owes no notice row");
        }
        other => panic!("unexpected claim {other:?}"),
    }
    // The close leaves no tombstone: the selector misses.
    let error = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap_err();
    assert!(
        error.to_string().starts_with("No direct RLM child matches"),
        "{error}"
    );
    assert!(rig.host.list_subagents().await.unwrap().is_empty());
    // The grandchild closed through the cascade and its engine tore down.
    eventually("the grandchild engine to drop", || {
        let probe = grand_weak.clone();
        async move { probe.upgrade().is_none() }
    })
    .await;
    // The unsettled grandchild owed no notice row anywhere.
    let child_file = child_file(&child);
    assert!(
        raw_notice_rows(&child_file).is_empty(),
        "no notice row for an unsettled grandchild"
    );
}

#[tokio::test]
async fn a_grandchilds_terminal_notice_targets_its_own_parent_file() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    // The child runs a stalled task turn: it stays busy while the
    // grandchild completes under it.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child working");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("mid"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let child_engine = Arc::clone(&child.engine);
    eventually("the child to stream", move || {
        let engine = Arc::clone(&child_engine);
        async move { engine.session.agent().state().await.is_streaming }
    })
    .await;
    // The grandchild completes under the busy child.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("grand done");
    let grand = child
        .child_host
        .spawn(spawn_request(
            Some("grand"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collected = child
        .child_host
        .collect(vec![grand.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    // The grandchild's notice landed on ITS parent — the child — as one
    // durable row keyed to the child's session, on the child's file.
    let child_file = child_file(&child);
    let rows = raw_notice_rows(&child_file);
    assert_eq!(rows.len(), 1, "the grandchild's notice on the child's file");
    assert_eq!(rows[0].child_id, grand.rlm_child_id);
    assert_eq!(
        rows[0].notice_key,
        format!("{}:{}", child.session_id, grand.rlm_child_id)
    );
    assert_eq!(rows[0].kind, "completed_without_reply");
    assert!(rows[0].content.contains("no-reply child:grand"));
    // Nothing leaked to the top parent while the child stays busy.
    assert!(raw_notice_rows(&parent_file).is_empty());
    // The busy child receives the notice at its next model boundary: end
    // the stalled turn and let the queue drive the notice-only turn.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("grand ack");
    child.engine.session.agent().abort();
    let child_provider = rig.catalog.provider("glm-5.3-turbo");
    eventually("the child's notice-driven request", move || {
        let provider = Arc::clone(&child_provider);
        async move {
            provider
                .calls()
                .last()
                .and_then(|context| serde_json::to_string(context).ok())
                .is_some_and(|text| text.contains("no-reply child:grand"))
        }
    })
    .await;
    child.engine.session.agent().wait_for_idle().await;
    // The child then settles: its own notice goes to the TOP parent.
    rig.catalog.provider("glm-5.3").push_text_turn("parent ack");
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    let parent_id = rig.engine.session.session_id().await;
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "the child's notice on the top parent's file");
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
    assert_eq!(
        rows[0].notice_key,
        format!("{parent_id}:{}", handle.rlm_child_id)
    );
    assert_eq!(rows[0].kind, "completed_without_reply");
    // Both files stay whole, and the grandchild's row stays exactly one.
    assert_eq!(raw_notice_rows(&child_file).len(), 1);
}

#[tokio::test]
async fn a_replied_child_still_owes_its_failure_row() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    // The child's task prompt fails at the stream call: the error claim
    // fires at once.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_fail_start_turn("child exploded");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("failing"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // The explicit reply suppresses only the no-reply row; the failure
    // row is owed regardless.
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    rig.catalog.provider("glm-5.3").push_text_turn("parent ack");
    let child = rig.first_child().await;
    let controller = InProcessFamilyController::new(
        Arc::clone(&child.child_host),
        FamilySelf::Child {
            child_id: handle.rlm_child_id.clone(),
        },
    );
    let family = controller.family().await.unwrap();
    let receipt = controller
        .send_agent_message(AgentMessageSendInput {
            target: family[0].id.clone(),
            message: "task done, shipping the report".to_string(),
            receiver_role: None,
        })
        .await
        .unwrap();
    assert!(matches!(
        receipt.delivery_status.as_str(),
        "delivered" | "queued"
    ));
    rig.engine.session.agent().wait_for_idle().await;
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    let result = one(&collected);
    assert_eq!(result.status, "error");
    assert!(result.settled);
    assert_eq!(
        result.replied_since_task,
        Some(true),
        "the reply landed before the verdict read"
    );
    // Raw disk: exactly one failure row (the reply does not suppress
    // it), no no-reply row, and the reply's agent-message row once.
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "one failure row");
    assert_eq!(
        rows[0].custom_type,
        crate::session_engine::rlm_notices::RLM_CHILD_FAILURE_CUSTOM_TYPE
    );
    assert_eq!(rows[0].kind, "error");
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
    assert!(rows[0].content.contains("child-failed child:failing"));
    let agent_rows = raw_lines(&parent_file)
        .into_iter()
        .filter(|line| {
            line["type"] == "custom_message"
                && line["customType"]
                    == crate::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE
        })
        .count();
    assert_eq!(agent_rows, 1, "the reply's agent-message row");
    let terminal = crate::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE;
    assert!(
        raw_lines(&parent_file)
            .into_iter()
            .all(|line| line["customType"] != terminal),
        "no no-reply row for the replied child"
    );
}

#[tokio::test]
async fn a_torn_tail_after_a_notice_row_repairs_on_open() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("noted"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    rig.engine.session.agent().wait_for_idle().await;
    assert_eq!(raw_notice_rows(&parent_file).len(), 1);
    // A crash mid-append: a torn fragment with no trailing newline.
    {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&parent_file)
            .unwrap();
        file.write_all(br#"{"type":"custom_message","id":"torn"#)
            .unwrap();
    }
    assert!(std::fs::read_to_string(&parent_file)
        .unwrap()
        .ends_with("torn"));
    // The open repairs the torn tail; the canonical notice row survives.
    let facts = rig.into_facts().await;
    let _reopened =
        SessionManager::open(facts.dir.path(), &facts.sessions_dir, &facts.session_file);
    let text = std::fs::read_to_string(&facts.session_file).unwrap();
    assert!(!text.contains("torn"), "the torn fragment is repaired away");
    let rows = raw_notice_rows(&facts.session_file);
    assert_eq!(
        rows.len(),
        1,
        "the canonical notice row survives the repair"
    );
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
}

#[tokio::test]
async fn notice_admission_orders_disk_live_then_publication() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    // The parent is idle: the failure admission enqueues its own turn.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_fail_start_turn("child exploded");
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    // Hold the transaction between its stages.
    let gates = SessionGates::install(&rig.engine, &[SessionSeam::RowDurable]);
    let (claimed, before_publish) = install_child_gates(&rig.host);
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("ordered"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child_id = handle.rlm_child_id.clone();
    // Stage 1 — the claim: nothing admitted, nothing settled.
    claimed.reached().await;
    assert!(raw_notice_rows(&parent_file).is_empty());
    let collected = rig.host.collect(vec![child_id.clone()], 0).await.unwrap();
    assert_eq!(one(&collected).status, "running");
    // Stage 2 — the row is durable but not yet live: on raw disk, the
    // parent not streaming, the verdict still unpublished.
    claimed.release();
    gates.row_durable.reached().await;
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "the row is durable first");
    assert_eq!(rows[0].child_id, child_id);
    assert_eq!(rows[0].kind, "error");
    assert!(
        !rig.engine.session.agent().state().await.is_streaming,
        "nothing is live yet"
    );
    let collected = rig.host.collect(vec![child_id.clone()], 0).await.unwrap();
    assert_eq!(one(&collected).status, "running");
    // Stage 3 — live registration done, publication not yet: the verdict
    // is still running while the notice turn's request is on the wire.
    gates.row_durable.release();
    before_publish.reached().await;
    let collected = rig.host.collect(vec![child_id.clone()], 0).await.unwrap();
    assert_eq!(
        one(&collected).status,
        "running",
        "no premature settle before publication"
    );
    let provider = rig.catalog.provider("glm-5.3");
    let failure_header = "[child-failed child:ordered]".to_string();
    eventually("the notice-only turn's request", move || {
        let provider = Arc::clone(&provider);
        let header = failure_header.clone();
        async move {
            provider
                .calls()
                .last()
                .is_some_and(|context| request_ends_with_notice(context, &header))
        }
    })
    .await;
    // Stage 4 — publication: only now does the verdict become public.
    rig.host.set_child_test_gate(None);
    rig.engine.session.set_terminal_test_gate(None);
    before_publish.release();
    let collected = rig
        .host
        .collect(vec![child_id.clone()], 10_000)
        .await
        .unwrap();
    let result = one(&collected);
    assert_eq!(result.status, "error");
    assert!(result.settled);
    assert_eq!(
        raw_notice_rows(&parent_file).len(),
        1,
        "one canonical row through the whole transaction"
    );
}

#[tokio::test]
async fn a_delete_racing_a_mid_flight_admission_waits_for_the_agreed_verdict() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let (claimed, before_publish) = install_child_gates(&rig.host);
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("raced"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let child_engine = Arc::clone(&child.engine);
    eventually("the child to stream before abort", move || {
        let engine = Arc::clone(&child_engine);
        async move { engine.session.agent().state().await.is_streaming }
    })
    .await;
    child.engine.session.agent().abort();
    claimed.reached().await;
    // The run holds the claim mid-transaction: nothing admitted yet.
    assert!(raw_notice_rows(&parent_file).is_empty());
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "running");
    // The delete races the held transaction: it must LOSE the claim and
    // wait for the agreed verdict — no cancelled row over a done one.
    let delete = tokio::spawn({
        let host = Arc::clone(&rig.host);
        let target = handle.rlm_child_id.clone();
        async move { host.delete_subagent(target).await.unwrap() }
    });
    claimed.release();
    before_publish.reached().await;
    assert_eq!(raw_notice_rows(&parent_file).len(), 1);
    assert_eq!(
        raw_notice_rows(&parent_file)[0].kind,
        "completed_without_reply",
        "the run's row committed, not a competing cancelled row"
    );
    assert!(
        !delete.is_finished(),
        "the delete still waits for the agreed verdict"
    );
    rig.host.set_child_test_gate(None);
    before_publish.release();
    let deleted = delete.await.expect("the delete task");
    assert_eq!(deleted.outcome, Some("deleted"));
    assert_eq!(
        deleted.subagent.status, "completed",
        "the receipt reports the run's agreed verdict"
    );
    assert_eq!(
        child.state().await.settled_status,
        Some("done"),
        "one verdict, unchanged by the racing delete"
    );
    assert_eq!(raw_notice_rows(&parent_file).len(), 1);
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap();
    assert!(one(&collected).settled);
}

#[tokio::test]
async fn close_children_waits_the_mid_flight_winner_then_settles_once() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let (claimed, before_publish) = install_child_gates(&rig.host);
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("closing"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let child_engine = Arc::clone(&child.engine);
    eventually("the child to stream before abort", move || {
        let engine = Arc::clone(&child_engine);
        async move { engine.session.agent().state().await.is_streaming }
    })
    .await;
    child.engine.session.agent().abort();
    claimed.reached().await;
    assert!(raw_notice_rows(&parent_file).is_empty());
    // The embedding's recursive close races the held transaction: it must
    // wait for the winner's admission, not cancel over it.
    let closer = tokio::spawn({
        let host = Arc::clone(&rig.host);
        async move { host.close_children().await }
    });
    claimed.release();
    before_publish.reached().await;
    // The commit won: the row remains in the original parent's file.
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, "completed_without_reply");
    let provider = rig.catalog.provider("glm-5.3");
    let notice_header = "[child-exited: no-reply child:closing]".to_string();
    eventually("the notice-only turn's request", move || {
        let provider = Arc::clone(&provider);
        let header = notice_header.clone();
        async move {
            provider
                .calls()
                .last()
                .is_some_and(|context| request_ends_with_notice(context, &header))
        }
    })
    .await;
    rig.host.set_child_test_gate(None);
    before_publish.release();
    closer
        .await
        .expect("the close completes without a deadlock");
    // One verdict: the run's done, unchanged by the close.
    assert_eq!(
        child.claimed_kind().await,
        Some(super::registry::NoticeKind::Done)
    );
    assert_eq!(child.state().await.settled_status, Some("done"));
    // The close cleared the registry and left no tombstone.
    assert!(rig.host.list_subagents().await.unwrap().is_empty());
    let error = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap_err();
    assert!(
        error.to_string().starts_with("No direct RLM child matches"),
        "{error}"
    );
    assert_eq!(
        raw_notice_rows(&parent_file).len(),
        1,
        "the committed row survives the close"
    );
}

#[tokio::test]
async fn a_marker_miss_keeps_the_notice_pending_and_retries_next_assistant() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    let parent_id = rig.engine.session.session_id().await;
    // Hold the admission after the row landed (the fault can only be
    // armed there — the marker seam runs under the manager lock).
    let gates = SessionGates::install(
        &rig.engine,
        &[SessionSeam::RowDurable, SessionSeam::BeforeMarker],
    );
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("noted"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // Stage 1 — the row is durable; arm the fault before live delivery.
    gates.row_durable.reached().await;
    assert_eq!(
        raw_notice_rows(&parent_file).len(),
        1,
        "the notice row landed"
    );
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(true);
    gates.row_durable.release();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    // Stage 2 — the notice turn's assistant row is durable; the marker
    // write is the very next step, held here.
    gates.before_marker.reached().await;
    let key = format!("{parent_id}:{}", handle.rlm_child_id);
    assert_eq!(
        raw_assistant_rows(&parent_file),
        2,
        "the notice turn's assistant row is durable"
    );
    assert!(
        !raw_consumed_keys(&parent_file).contains(&key),
        "the marker has not landed yet"
    );
    gates.before_marker.release();
    // The marker write failed: the notice stays pending.
    assert!(
        !raw_consumed_keys(&parent_file).contains(&key),
        "the marker write failed"
    );
    let unconsumed: Vec<String> = rig
        .engine
        .session
        .shared_persistence()
        .lock()
        .await
        .unconsumed_terminal_notices()
        .unwrap()
        .into_iter()
        .map(|(pending, _)| pending)
        .collect();
    assert!(
        unconsumed.contains(&key),
        "a missed marker keeps the notice pending"
    );
    assert_eq!(raw_notice_rows(&parent_file).len(), 1, "still one row");
    // Recovery: the next successful assistant retries the marker.
    rig.engine.session.set_terminal_test_gate(None);
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(false);
    rig.run_parent_turn("second ack").await;
    assert!(
        raw_consumed_keys(&parent_file).contains(&key),
        "the retried marker covers the notice"
    );
    let unconsumed: Vec<String> = rig
        .engine
        .session
        .shared_persistence()
        .lock()
        .await
        .unconsumed_terminal_notices()
        .unwrap()
        .into_iter()
        .map(|(pending, _)| pending)
        .collect();
    assert!(unconsumed.is_empty());
    assert_eq!(raw_notice_rows(&parent_file).len(), 1);
}

#[tokio::test]
async fn a_marker_miss_kill_replays_the_notice_at_least_once() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    let gates = SessionGates::install(
        &rig.engine,
        &[SessionSeam::RowDurable, SessionSeam::BeforeMarker],
    );
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("noted"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // The row landed; arm the fault before live delivery so the marker
    // write (not the notice row) is what fails.
    gates.row_durable.reached().await;
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(true);
    gates.row_durable.release();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    gates.before_marker.reached().await;
    gates.before_marker.release();
    // The marker write failed; the turn itself completed. Kill between
    // the model's consumption and the marker: recovery re-delivers
    // (at-least-once model delivery, exactly one row).
    let key = format!(
        "{}:{}",
        rig.engine.session.session_id().await,
        handle.rlm_child_id
    );
    assert!(!raw_consumed_keys(&parent_file).contains(&key));
    rig.engine.session.set_terminal_test_gate(None);
    rig.engine.session.agent().wait_for_idle().await;
    let facts = rig.into_facts().await;
    let (engine, host) = facts.reopen().await;
    // The unbound engine RETAINS the unconsumed notice (no silent
    // drop); the binding strips it and re-admits it as exactly one
    // notice-only turn.
    let context_text = serde_json::to_string(&engine.session.agent().state().await.messages)
        .expect("the restored context serializes");
    assert!(
        context_text.contains("no-reply child:noted"),
        "the unbound engine retains the unconsumed notice"
    );
    facts
        .catalog
        .provider("glm-5.3")
        .push_text_turn("reopened ack");
    let calls_before = facts.catalog.provider("glm-5.3").calls().len();
    host.bind_parent(Arc::clone(&engine)).await.unwrap();
    engine.session.agent().wait_for_idle().await;
    assert_eq!(
        facts.catalog.provider("glm-5.3").calls().len(),
        calls_before + 1,
        "the replay re-delivered the notice once"
    );
    assert!(request_ends_with_notice(
        facts.catalog.provider("glm-5.3").calls().last().unwrap(),
        "[child-exited: no-reply child:noted]"
    ));
    // The binding stripped the retained row and re-admitted it exactly
    // once: the live context holds ONE copy, never two.
    let context_text = serde_json::to_string(&engine.session.agent().state().await.messages)
        .expect("the live context serializes");
    assert_eq!(
        context_text.matches("no-reply child:noted").count(),
        1,
        "the replayed notice rides the live context exactly once"
    );
    assert_eq!(
        raw_notice_rows(&facts.session_file).len(),
        1,
        "still exactly one durable row"
    );
    // The re-delivered turn's assistant now covers the marker.
    assert!(raw_consumed_keys(&facts.session_file).contains(&key));
    let unconsumed: Vec<String> = engine
        .session
        .shared_persistence()
        .lock()
        .await
        .unconsumed_terminal_notices()
        .unwrap()
        .into_iter()
        .map(|(pending, _)| pending)
        .collect();
    assert!(unconsumed.is_empty());
}

#[tokio::test]
async fn a_kill_between_the_response_and_the_assistant_row_replays_once() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    assert_eq!(
        raw_assistant_rows(&parent_file),
        1,
        "one assistant row before the notice turn"
    );
    // Hold the exact crash window: after the provider responded, before
    // the assistant row lands. Neither the assistant row nor the marker
    // can exist yet.
    let gates = SessionGates::install(
        &rig.engine,
        &[SessionSeam::RowDurable, SessionSeam::BeforePersist],
    );
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("crashed"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // Let the admission run to completion (the row is durable and the
    // notice-only turn is live), then hold inside the turn's persist.
    gates.row_durable.reached().await;
    gates.row_durable.release();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    gates.before_persist.reached().await;
    assert_eq!(
        raw_notice_rows(&parent_file).len(),
        1,
        "the durable notice row"
    );
    assert_eq!(
        raw_assistant_rows(&parent_file),
        1,
        "the notice turn's assistant row has not landed"
    );
    assert!(raw_consumed_keys(&parent_file).is_empty());
    // Kill inside the window — no release: the rig dies with the turn.
    let facts = {
        let registry = Arc::clone(&rig.host.config().registry);
        let TestRig {
            root: dir,
            agent_dir,
            catalog,
            host,
            engine,
        } = rig;
        drop(host);
        drop(engine);
        RigFacts {
            dir,
            agent_dir: agent_dir.clone(),
            sessions_dir: agent_dir.join("sessions"),
            session_file: parent_file,
            catalog,
            registry,
        }
    };
    assert_eq!(raw_notice_rows(&facts.session_file).len(), 1);
    // Reopen: the notice is unconsumed (no assistant row, no marker), so
    // the binding replays it — one notice-only turn.
    let (engine, host) = facts.reopen().await;
    facts
        .catalog
        .provider("glm-5.3")
        .push_text_turn("reopened ack");
    let calls_before = facts.catalog.provider("glm-5.3").calls().len();
    host.bind_parent(Arc::clone(&engine)).await.unwrap();
    engine.session.agent().wait_for_idle().await;
    assert_eq!(
        facts.catalog.provider("glm-5.3").calls().len(),
        calls_before + 1,
        "the replay drove exactly one notice-only turn"
    );
    assert!(request_ends_with_notice(
        facts.catalog.provider("glm-5.3").calls().last().unwrap(),
        "[child-exited: no-reply child:crashed]"
    ));
    assert_eq!(
        raw_notice_rows(&facts.session_file).len(),
        1,
        "the replay never wrote a second row"
    );
    let key = format!(
        "{}:{}",
        engine.session.session_id().await,
        handle.rlm_child_id
    );
    assert!(
        raw_consumed_keys(&facts.session_file).contains(&key),
        "the replay turn's assistant consumed the notice"
    );
}

#[tokio::test]
async fn a_partial_prewrite_is_reconciled_to_one_canonical_row() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    // One torn mid-write: a partial line prefix lands unsynced, then the
    // append fails. The strict append must reconcile the tail and land
    // the row exactly once.
    crate::session::manager::fault_hooks::arm(
        &parent_file,
        crate::session::manager::fault_hooks::Fault::PartialPrewrite,
        1,
    );
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("torn"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(
        rows.len(),
        1,
        "the torn prefix reconciled to one canonical row (every line parses)"
    );
    assert!(rows[0].content.contains("no-reply child:torn"));
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
}

#[tokio::test]
async fn a_sync_failure_after_a_landed_line_is_resynced_once() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    // The complete line lands unsynced, then the sync fails. The
    // reconcile must recognize the landed line and re-sync it — one row,
    // never two.
    crate::session::manager::fault_hooks::arm(
        &parent_file,
        crate::session::manager::fault_hooks::Fault::SyncFail,
        1,
    );
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("synced"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(
        rows.len(),
        1,
        "the landed line was re-synced as the one canonical row"
    );
    assert!(rows[0].content.contains("no-reply child:synced"));
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
}

#[tokio::test]
async fn a_failed_directory_fsync_keeps_one_row_and_the_retry_resyncs() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    // A FRESH parent busy in its first turn: the notice append takes the
    // wholesale-rewrite arm, whose directory fsync fails after the
    // content landed.
    rig.catalog.provider("glm-5.3").push_stalled_turn("busy");
    rig.engine
        .session
        .prompt(
            "hold the line",
            crate::session_engine::PromptOptions {
                return_after_accepted: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let parent = Arc::clone(&rig.engine);
    eventually("the parent to stream its first turn", move || {
        let parent = Arc::clone(&parent);
        async move { parent.session.agent().state().await.is_streaming }
    })
    .await;
    crate::session::manager::fault_hooks::arm(
        &parent_file,
        crate::session::manager::fault_hooks::Fault::DirFsyncFail,
        1,
    );
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("resynced"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // The rewrite landed but the directory fsync failed: the admission
    // stays pending and the retry's stable-key scan re-syncs the same
    // row instead of writing a second one.
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(
        rows.len(),
        1,
        "the landed rewrite is the one row; the retry re-synced it"
    );
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
    // The forced rewrite carried the fresh session's buffered rows too.
    let lines = raw_lines(&parent_file);
    assert!(lines.iter().any(|line| line["type"] == "session"));
    assert_eq!(
        lines
            .iter()
            .filter(|line| line["message"]["role"] == "user")
            .count(),
        1,
        "the buffered first-turn user row rode the forced rewrite"
    );
    rig.engine.session.agent().abort();
}

#[tokio::test]
async fn close_waits_a_claim_held_admission_then_flips_and_returns_promptly() {
    // The close fires while the run holds the CLAIM (nothing admitted).
    // The immutable claim wins: the close must wait for the winner's
    // whole transaction — disk AND live registration — and only then
    // flip the generation, returning promptly with the verdict
    // untouched.
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let (claimed, before_publish) = install_child_gates(&rig.host);
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_fail_start_turn("child exploded");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("held-claim"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    // Stage 1 — the claim is held: the close cannot finish.
    claimed.reached().await;
    let closer = tokio::spawn({
        let host = Arc::clone(&rig.host);
        async move { host.close_children().await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(
        !closer.is_finished(),
        "the close waits the held claim mid-transaction"
    );
    claimed.release();
    // Stage 2 — disk and live registration are done, publication not
    // yet: the close still waits, the verdict is still unpublic.
    before_publish.reached().await;
    assert_eq!(raw_notice_rows(&parent_file).len(), 1, "disk registered");
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "running");
    let provider = rig.catalog.provider("glm-5.3");
    let failure_header = "[child-failed child:held-claim]".to_string();
    eventually("the live notice-only turn", move || {
        let provider = Arc::clone(&provider);
        let header = failure_header.clone();
        async move {
            provider
                .calls()
                .last()
                .is_some_and(|context| request_ends_with_notice(context, &header))
        }
    })
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(!closer.is_finished(), "the close waits the publication too");
    // Release: the winner publishes, the close flips and returns
    // promptly — no exponential backoff, no cancelled re-label.
    let released = std::time::Instant::now();
    rig.host.set_child_test_gate(None);
    before_publish.release();
    closer.await.expect("the close returns");
    assert!(
        released.elapsed() < std::time::Duration::from_secs(5),
        "the close returns promptly once the winner registers"
    );
    assert_eq!(
        child.state().await.settled_status,
        Some("error"),
        "the immutable verdict settles, never a cancelled re-label"
    );
    assert_eq!(
        raw_notice_rows(&parent_file).len(),
        1,
        "one committed row through the whole close"
    );
    assert!(rig.host.list_subagents().await.unwrap().is_empty());
    let error = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap_err();
    assert!(
        error.to_string().starts_with("No direct RLM child matches"),
        "the close leaves no tombstone"
    );
}

#[tokio::test]
async fn close_waits_disk_and_live_from_the_durable_stage_then_returns_promptly() {
    // The close fires while the run holds the admission at the DURABLE
    // stage (the row landed, live registration has not): the close must
    // wait for BOTH, then flip and return promptly.
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let gates = SessionGates::install(&rig.engine, &[SessionSeam::RowDurable]);
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_fail_start_turn("child exploded");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("held-row"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    // The row is durable; the live registration has not happened.
    gates.row_durable.reached().await;
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "the row is durable");
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "running");
    // The close cannot finish ahead of the live registration.
    let closer = tokio::spawn({
        let host = Arc::clone(&rig.host);
        async move { host.close_children().await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(
        !closer.is_finished(),
        "the close waits disk AND live registration"
    );
    // Release: the admission registers live, publishes; the close flips
    // and returns promptly.
    let released = std::time::Instant::now();
    rig.engine.session.set_terminal_test_gate(None);
    gates.row_durable.release();
    closer.await.expect("the close returns");
    assert!(
        released.elapsed() < std::time::Duration::from_secs(5),
        "the close returns promptly once the winner registers live"
    );
    assert_eq!(child.state().await.settled_status, Some("error"));
    assert_eq!(raw_notice_rows(&parent_file).len(), 1);
    let provider = rig.catalog.provider("glm-5.3");
    let failure_header = "[child-failed child:held-row]".to_string();
    eventually("the live notice-only turn", move || {
        let provider = Arc::clone(&provider);
        let header = failure_header.clone();
        async move {
            provider
                .calls()
                .last()
                .is_some_and(|context| request_ends_with_notice(context, &header))
        }
    })
    .await;
    assert!(rig.host.list_subagents().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_rebind_commits_the_row_to_the_original_parent_only() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    // Hold the winner's admission at the durable stage on the ORIGINAL
    // parent, then rebind the host to a fresh sibling session (the
    // daemon's rebuilt-parent shape).
    let gates = SessionGates::install(&rig.engine, &[SessionSeam::RowDurable]);
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_fail_start_turn("child exploded");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("rebound"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let parent_id = rig.engine.session.session_id().await;
    gates.row_durable.reached().await;
    assert_eq!(
        raw_notice_rows(&parent_file).len(),
        1,
        "the original parent holds the durable row"
    );
    // The rebind target: a fresh sibling session in the same tree, on
    // the same host.
    let b_engine = {
        let mut manager =
            SessionManager::persisted(rig.root.path(), &rig.agent_dir.join("sessions"));
        manager.new_session(&NewSessionOptions {
            id: None,
            parent_session: None,
            rlm_depth: Some(0),
        });
        create_session(SessionEngineConfig {
            cwd: rig.root.path().to_path_buf(),
            agent_dir: rig.agent_dir.clone(),
            model: Some(script_model("glm-5.3")),
            stream_fn: Some(rig.catalog.stream_fn("glm-5.3")),
            session_manager: Some(manager),
            rlm_depth: Some(0),
            rlm_subagent_host: Some(Arc::clone(&rig.host) as Arc<dyn RlmSubagentHost>),
            extra_host_handlers: Some(rig.host.family_host_handlers()),
            ..Default::default()
        })
        .await
        .unwrap()
    };
    // The rebind blocks in the children close: the immutable winner must
    // finish its own admission first.
    let b_engine = Arc::new(b_engine);
    let rebinder = tokio::spawn({
        let host = Arc::clone(&rig.host);
        let engine = Arc::clone(&b_engine);
        async move { host.bind_parent(engine).await.unwrap() }
    });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(
        !rebinder.is_finished(),
        "the rebind waits the original parent's winner"
    );
    rig.engine.session.set_terminal_test_gate(None);
    gates.row_durable.release();
    rebinder.await.expect("the rebind completes");
    // The winner committed to the ORIGINAL parent — one row, the
    // original session's key — and the NEW parent carries no duplicate.
    assert_eq!(
        child.state().await.settled_status,
        Some("error"),
        "the immutable verdict settled through the rebind"
    );
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "one row on the original parent");
    assert_eq!(
        rows[0].notice_key,
        format!("{}:{}", parent_id, handle.rlm_child_id),
        "the original parent's stable key"
    );
    assert!(rig.host.list_subagents().await.unwrap().is_empty());
    // The new parent's file exists after one turn and carries no notice
    // row for the child.
    rig.catalog.provider("glm-5.3").push_text_turn("b ack");
    b_engine
        .session
        .prompt("continue", crate::session_engine::PromptOptions::default())
        .await
        .unwrap();
    b_engine.session.agent().wait_for_idle().await;
    let b_file = session_file_of(&b_engine).await;
    assert!(
        raw_notice_rows(&b_file)
            .iter()
            .all(|row| row.child_id != handle.rlm_child_id),
        "no duplicate notice row on the new parent"
    );
    assert_eq!(raw_notice_rows(&b_file).len(), 0);
}

#[tokio::test]
async fn a_persistently_faulted_admission_parks_and_the_close_returns() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    // The fault stays ON: every admission attempt fails before touching
    // the file, forever.
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(true);
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_fail_start_turn("child exploded");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("parked"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let child_id = handle.rlm_child_id.clone();
    eventually("the parked admission diagnostic", || {
        let rig = &rig;
        let child_id = child_id.clone();
        async move {
            let collected = rig.host.collect(vec![child_id], 0).await.unwrap();
            let result = one(&collected);
            result.status == "running"
                && result
                    .error
                    .as_deref()
                    .unwrap_or_default()
                    .contains("Terminal notice admission pending")
        }
    })
    .await;
    // The close parks: the claimant keeps its immutable claim with the
    // diagnostic visible, nothing settles, no row lands, and the close
    // itself returns promptly.
    let started = std::time::Instant::now();
    rig.host.close_children().await;
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "the close returns promptly from a parked admission"
    );
    assert!(
        child.state().await.settled_status.is_none(),
        "a parked claim never settles"
    );
    assert_eq!(
        child.claimed_kind().await,
        Some(super::registry::NoticeKind::Error),
        "the immutable claim stays with its claimant"
    );
    assert!(
        child
            .parked_error()
            .await
            .is_some_and(|error| error.contains("Terminal notice admission pending")),
        "the parked diagnostic stays visible"
    );
    assert!(
        raw_notice_rows(&parent_file).is_empty(),
        "a parked admission lands no row"
    );
    assert!(rig.host.list_subagents().await.unwrap().is_empty());
    let error = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap_err();
    assert!(
        error.to_string().starts_with("No direct RLM child matches"),
        "the parked close leaves no tombstone"
    );
}

#[tokio::test]
async fn a_mid_admission_engine_drop_completes_live_and_disk_then_drops() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let gates = SessionGates::install(&rig.engine, &[SessionSeam::RowDurable]);
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_fail_start_turn("child exploded");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("held-alive"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let engine_weak = Arc::downgrade(&rig.engine);
    let provider = rig.catalog.provider("glm-5.3");
    // The winner holds the durable stage: kill every OTHER strong edge
    // (the rig drops here) — the claimant's own strong hold keeps the
    // original parent alive across its transaction.
    gates.row_durable.reached().await;
    assert_eq!(raw_notice_rows(&parent_file).len(), 1, "the durable row");
    let facts = rig.into_facts().await;
    assert!(
        engine_weak.upgrade().is_some(),
        "the claimant's strong hold keeps the engine alive"
    );
    gates.row_durable.release();
    // The transaction completes on the held-alive parent: live delivery
    // (a real model request), the durable row, the verdict — and only
    // then does the engine actually drop.
    let failure_header = "[child-failed child:held-alive]".to_string();
    eventually("the held-alive notice turn", move || {
        let provider = Arc::clone(&provider);
        let header = failure_header.clone();
        async move {
            provider
                .calls()
                .last()
                .is_some_and(|context| request_ends_with_notice(context, &header))
        }
    })
    .await;
    eventually("the claim to settle", || {
        let child = Arc::clone(&child);
        async move { child.state().await.settled_status.is_some() }
    })
    .await;
    assert_eq!(child.state().await.settled_status, Some("error"));
    let rows = raw_notice_rows(&facts.session_file);
    assert_eq!(rows.len(), 1, "the row survived the engine drop");
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
    eventually("the held engine to drop after completing", || {
        let probe = engine_weak.clone();
        async move { probe.upgrade().is_none() }
    })
    .await;
}

#[tokio::test]
async fn deleting_a_running_child_flushes_its_pending_usage_attribution() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    // The child's task turn completes with usage (the pending batch),
    // and the delete lands inside the settle window: whichever claim
    // wins, the pending usage must flush into the parent's durable
    // attribution row.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child did work");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("used"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // The kernel's `rlm.spawn` handler registers the spawn target on the
    // parent's attribution producer; the direct host call does the same
    // registration here so the flushed batches fold into a durable row.
    rig.engine
        .rlm_usage
        .register_spawn(&handle.rlm_child_id)
        .await;
    let child_id = handle.rlm_child_id.clone();
    eventually("the child's completed turn", || {
        let rig = &rig;
        let child_id = child_id.clone();
        async move {
            let collected = rig.host.collect(vec![child_id], 0).await.unwrap();
            one(&collected).answer_preview.is_some()
        }
    })
    .await;
    let deleted = rig.host.delete_subagent(child_id.clone()).await.unwrap();
    assert_eq!(deleted.outcome, Some("deleted"));
    // The teardown (or the settle that won the race) flushed the pending
    // usage: one durable attribution row on the parent's file.
    eventually("the flushed attribution row", || {
        let parent_file = parent_file.clone();
        async move {
            raw_lines(&parent_file)
                .iter()
                .any(|line| line["type"] == "child_usage_attributed")
        }
    })
    .await;
    let attribution_rows = raw_lines(&parent_file)
        .into_iter()
        .filter(|line| line["type"] == "child_usage_attributed")
        .collect::<Vec<_>>();
    assert_eq!(
        attribution_rows.len(),
        1,
        "one durable attribution row for the deleted child's task"
    );
    assert_eq!(
        attribution_rows[0]["origin"], "spawn_task",
        "the flushed batch is the child's task usage"
    );
    // One terminal notice row agrees with the delete receipt.
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "one terminal notice row");
    match deleted.subagent.status {
        "cancelled" => assert_eq!(rows[0].kind, "cancelled"),
        "completed" => assert_eq!(rows[0].kind, "completed_without_reply"),
        other => panic!("unexpected delete receipt status: {other}"),
    }
}

#[tokio::test]
async fn a_transient_fault_recovers_while_the_close_loser_waits() {
    // A fail-once admission error is TRANSIENT: it must not park the
    // claim. The close's loser wait rides through the retry burst; the
    // cleared fault lets the winner commit disk+live, and the close
    // completes with the WON verdict and row — never a premature
    // parked return, never a cancelled re-label.
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    // The fault fails the first admission attempt only; the test clears
    // it inside the retry burst.
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(true);
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_fail_start_turn("child exploded");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("transient"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let child_id = handle.rlm_child_id.clone();
    eventually("the transient admission error without a park", || {
        let rig = &rig;
        let child = &child;
        let child_id = child_id.clone();
        async move {
            let collected = rig.host.collect(vec![child_id], 0).await.unwrap();
            let result = one(&collected);
            result.status == "running"
                && result
                    .error
                    .as_deref()
                    .unwrap_or_default()
                    .contains("Terminal notice admission pending")
                && !child.state().await.parked
        }
    })
    .await;
    // The close loser waits THROUGH the transient burst — its wait only
    // ends on the settle or a genuine park, not on the error itself.
    let closer = tokio::spawn({
        let host = Arc::clone(&rig.host);
        async move { host.close_children().await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        !closer.is_finished(),
        "a transient admission error does not park the loser's wait"
    );
    // Clear the fault inside the burst: the next retry commits.
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(false);
    closer.await.expect("the close returns");
    // The loser got the WON verdict and row: the immutable error
    // settled under the still-open inbox, never re-labelled.
    assert_eq!(
        child.state().await.settled_status,
        Some("error"),
        "the close loser reports the won verdict, not a parked error"
    );
    assert_eq!(
        child.claimed_kind().await,
        Some(super::registry::NoticeKind::Error)
    );
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "one committed row");
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
    assert_eq!(rows[0].kind, "error");
    let provider = rig.catalog.provider("glm-5.3");
    let failure_header = "[child-failed child:transient]".to_string();
    eventually("the recovered notice-only turn", move || {
        let provider = Arc::clone(&provider);
        let header = failure_header.clone();
        async move {
            provider
                .calls()
                .last()
                .is_some_and(|context| request_ends_with_notice(context, &header))
        }
    })
    .await;
    assert!(rig.host.list_subagents().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_parked_cancelled_delete_retries_and_succeeds_after_the_fault_clears() {
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("retry-delete"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let child_engine = Arc::clone(&child.engine);
    eventually("the child to stream", move || {
        let engine = Arc::clone(&child_engine);
        async move { engine.session.agent().state().await.is_streaming }
    })
    .await;
    // The fault parks the delete's OWN cancelled admission: the first
    // delete refuses with the parked diagnostic, the claim stays with
    // the delete, and nothing settles or lands.
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(true);
    let error = rig
        .host
        .delete_subagent(handle.rlm_child_id.clone())
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Terminal notice admission pending"),
        "{error}"
    );
    assert!(
        child.state().await.settled_status.is_none(),
        "the parked cancelled claim does not settle"
    );
    assert_eq!(
        child.claimed_kind().await,
        Some(super::registry::NoticeKind::Cancelled),
        "the parked claim stays with the delete"
    );
    assert!(child.state().await.parked, "the claim is genuinely parked");
    assert!(
        raw_notice_rows(&parent_file).is_empty(),
        "the parked delete lands no row"
    );
    assert_eq!(
        rig.host.list_subagents().await.unwrap().len(),
        1,
        "the refused delete leaves the record registered"
    );
    // Clear the fault: a retried delete owns its parked Cancelled claim
    // and completes the admission it started.
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(false);
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let deleted = rig
        .host
        .delete_subagent(handle.rlm_child_id.clone())
        .await
        .unwrap();
    assert_eq!(deleted.outcome, Some("deleted"));
    assert_eq!(deleted.subagent.status, "cancelled");
    assert_eq!(
        child.state().await.settled_status,
        Some("cancelled"),
        "the retried delete publishes its own cancelled verdict"
    );
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "one cancelled row after the retry");
    assert_eq!(rows[0].kind, "cancelled");
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
    let parent_id = rig.engine.session.session_id().await;
    assert_eq!(
        rows[0].notice_key,
        format!("{}:{}", parent_id, handle.rlm_child_id)
    );
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap();
    let result = one(&collected);
    assert!(result.settled);
    assert_eq!(result.status, "cancelled");
    assert!(rig.host.list_subagents().await.unwrap().is_empty());
    let provider = rig.catalog.provider("glm-5.3");
    let cancelled_header = "[child-exited: cancelled child:retry-delete]".to_string();
    eventually("the cancelled notice-only turn", move || {
        let provider = Arc::clone(&provider);
        let header = cancelled_header.clone();
        async move {
            provider
                .calls()
                .last()
                .is_some_and(|context| request_ends_with_notice(context, &header))
        }
    })
    .await;
}

#[tokio::test]
async fn a_forced_assistant_persistence_failure_leaves_the_notice_pending() {
    // The forced ASSISTANT-write failure: at the assistant-before-persist
    // pause the parent's JSONL is replaced by a directory, so the
    // ordinary assistant append fails while the notice row stays
    // durable. No assistant row and no consumption marker land; the
    // reopened parent replays the notice (the model request sees it).
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    let backup = PathBuf::from(format!("{}.backup", parent_file.display()));
    // A FRESH parent: no assistant row exists yet, so "no assistant
    // after the failed write" is the literal raw-disk shape.
    let gates = SessionGates::install(&rig.engine, &[SessionSeam::BeforePersist]);
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("persist-failed"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    assert_eq!(one(&collected).status, "done");
    // The notice turn's assistant row is the very next write — held
    // here (the notice row itself is already durable).
    gates.before_persist.reached().await;
    assert_eq!(
        raw_notice_rows(&parent_file).len(),
        1,
        "the durable notice row"
    );
    assert_eq!(
        raw_assistant_rows(&parent_file),
        0,
        "no assistant row before the held write"
    );
    // Swap the session file for a directory: the assistant append fails.
    std::fs::rename(&parent_file, &backup).unwrap();
    std::fs::create_dir(&parent_file).unwrap();
    assert!(parent_file.is_dir());
    gates.before_persist.release();
    // The run settles only after the listener completes — the failed
    // write has happened by the time the agent is idle.
    rig.engine.session.agent().wait_for_idle().await;
    // Restore the original file and read the raw damage: exactly one
    // notice row, no assistant row, no consumption marker.
    std::fs::remove_dir(&parent_file).unwrap();
    std::fs::rename(&backup, &parent_file).unwrap();
    assert_eq!(raw_notice_rows(&parent_file).len(), 1, "one notice row");
    assert_eq!(
        raw_assistant_rows(&parent_file),
        0,
        "the forced assistant write failure landed no assistant row"
    );
    assert!(
        raw_consumed_keys(&parent_file).is_empty(),
        "no consumption marker after the failed assistant write"
    );
    let key = format!(
        "{}:{}",
        rig.engine.session.session_id().await,
        handle.rlm_child_id
    );
    let unconsumed: Vec<String> = rig
        .engine
        .session
        .shared_persistence()
        .lock()
        .await
        .unconsumed_terminal_notices()
        .unwrap()
        .into_iter()
        .map(|(pending, _)| pending)
        .collect();
    assert!(
        unconsumed.contains(&key),
        "the failed assistant write leaves the notice pending"
    );
    // Kill and reopen: the binding replays the unconsumed notice — the
    // reopened parent's model request sees it, and the durable file
    // still holds exactly one row.
    let facts = rig.into_facts().await;
    let (engine, host) = facts.reopen().await;
    facts
        .catalog
        .provider("glm-5.3")
        .push_text_turn("reopened ack");
    let calls_before = facts.catalog.provider("glm-5.3").calls().len();
    host.bind_parent(Arc::clone(&engine)).await.unwrap();
    engine.session.agent().wait_for_idle().await;
    assert_eq!(
        facts.catalog.provider("glm-5.3").calls().len(),
        calls_before + 1,
        "the replay drove exactly one notice-only turn"
    );
    assert!(request_ends_with_notice(
        facts.catalog.provider("glm-5.3").calls().last().unwrap(),
        "[child-exited: no-reply child:persist-failed]"
    ));
    assert_eq!(
        raw_notice_rows(&facts.session_file).len(),
        1,
        "the replay never wrote a second row"
    );
    // The re-delivered turn's successful assistant covers the marker.
    assert!(raw_consumed_keys(&facts.session_file).contains(&key));
    let unconsumed: Vec<String> = engine
        .session
        .shared_persistence()
        .lock()
        .await
        .unconsumed_terminal_notices()
        .unwrap()
        .into_iter()
        .map(|(pending, _)| pending)
        .collect();
    assert!(unconsumed.is_empty());
}

#[tokio::test]
async fn a_fail_once_cancelled_delete_recovers_within_its_own_burst() {
    // A TRANSIENT single admission failure must not park a delete's own
    // Cancelled claim or require a second user delete: the task-abort
    // closed signal is not a parent-generation close, so the claimant
    // keeps its bounded three-attempt burst (250/500ms) while the
    // original parent stays open — and the FIRST delete succeeds.
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("fail-once"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let child_engine = Arc::clone(&child.engine);
    eventually("the child to stream", move || {
        let engine = Arc::clone(&child_engine);
        async move { engine.session.agent().state().await.is_streaming }
    })
    .await;
    // Fail exactly the first admission attempt, then clear the fault
    // inside the burst's backoff window.
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(true);
    let child_id = handle.rlm_child_id.clone();
    let delete = tokio::spawn({
        let host = Arc::clone(&rig.host);
        let target = child_id.clone();
        async move { host.delete_subagent(target).await.unwrap() }
    });
    eventually("the first admission attempt to fail", || {
        let child = &child;
        async move { child.state().await.admission_error.is_some() }
    })
    .await;
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(false);
    // The claimant's own burst retries land the row: the FIRST delete
    // returns a successful cancelled receipt — never a parked refusal
    // and never a second user delete.
    let deleted = delete.await.expect("the first delete succeeds");
    assert_eq!(deleted.outcome, Some("deleted"));
    assert_eq!(deleted.subagent.status, "cancelled");
    assert_eq!(
        child.state().await.settled_status,
        Some("cancelled"),
        "the delete's own burst published its cancelled verdict"
    );
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(rows.len(), 1, "one cancelled row through the burst");
    assert_eq!(rows[0].kind, "cancelled");
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap();
    let result = one(&collected);
    assert!(result.settled);
    assert_eq!(result.status, "cancelled");
    assert!(rig.host.list_subagents().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_parked_claim_is_frozen_against_its_timed_retry_across_a_descendant_close() {
    // The close must atomically freeze a genuinely parked claim against
    // its sparse timed retry: while the closer walks a held descendant
    // subtree, the parked retry must NOT reactivate — no new admission,
    // no settle, no row — and the close completes with the claim still
    // pending.
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    rig.run_parent_turn("first turn").await;
    // A child whose error claim parks (the persistent fault exhausts the
    // three-attempt burst), with a stalled grandchild under it so the
    // closer's descendant walk does real, gatable work.
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(true);
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_fail_start_turn("child exploded");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("frozen"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    eventually("the claim to park after its burst", || {
        let child = &child;
        async move { child.state().await.parked }
    })
    .await;
    assert!(
        child.state().await.settled_status.is_none(),
        "a parked claim never settles"
    );
    // A stalled grandchild under the child; its Claimed/BeforePublish
    // gates hold the closer mid-descendant-walk deterministically.
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("grand partial");
    let (grand_claimed, grand_publish) = install_child_gates(&child.child_host);
    let _grand = child
        .child_host
        .spawn(spawn_request(
            Some("grand"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    // Clear the fault: from here on, ANY reactivated admission would
    // succeed and publish — the only thing standing between the parked
    // claim and a settled row is the close's freeze.
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(false);
    // Fire the close: it observes the parked claim and freezes it, then
    // walks the descendants — which stall at the grandchild's gate.
    let closer = tokio::spawn({
        let host = Arc::clone(&rig.host);
        async move { host.close_children().await }
    });
    grand_claimed.reached().await;
    assert!(
        !closer.is_finished(),
        "the close is held mid-descendant-walk"
    );
    // While the closer is held, the parked retry must have exited WITHOUT
    // reactivating: the run task released its listener (an unfenced
    // retry would still be asleep holding it — and would succeed on the
    // cleared fault at its 5s wake, settling and writing a row).
    eventually("the frozen parked retry to exit", || {
        let child = &child;
        async move { child.state().await.listener.is_none() }
    })
    .await;
    // Let the descendant walk finish; the close completes with the claim
    // STILL parked and unsettled: no reactivation, no row, no tombstone.
    grand_claimed.release();
    grand_publish.reached().await;
    grand_publish.release();
    closer.await.expect("the close completes");
    assert!(
        child.state().await.settled_status.is_none(),
        "the frozen claim never reactivated across the descendant close"
    );
    assert!(child.state().await.parked, "the claim stays parked");
    assert_eq!(
        child.claimed_kind().await,
        Some(super::registry::NoticeKind::Error),
        "the immutable claim stays with its claimant"
    );
    assert!(
        raw_notice_rows(&parent_file).is_empty(),
        "the frozen retry never wrote a row"
    );
    assert!(rig.host.list_subagents().await.unwrap().is_empty());
    let error = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 0)
        .await
        .unwrap_err();
    assert!(
        error.to_string().starts_with("No direct RLM child matches"),
        "the close leaves no tombstone"
    );
}

#[tokio::test]
async fn an_existing_file_dir_sync_fault_keeps_one_row_and_the_retry_resyncs() {
    // The EXISTING-FILE append path must fsync the session directory
    // before a terminal row's success returns. The fault fires once
    // after the row's line + file sync + index landed but before the
    // directory sync: the landed row stays durable, the admission
    // surfaces the failure, and the idempotent retry re-syncs the SAME
    // row — never a second one.
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    // An already-flushed, existing file: the notice append takes the
    // single-line arm (not the fresh wholesale rewrite).
    rig.run_parent_turn("first turn").await;
    crate::session::manager::fault_hooks::arm(
        &parent_file,
        crate::session::manager::fault_hooks::Fault::AppendDirSyncFail,
        1,
    );
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_text_turn("child done");
    rig.catalog.provider("glm-5.3").push_text_turn("notice ack");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("dirsynced"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    let result = one(&collected);
    assert_eq!(result.status, "done");
    assert!(result.settled, "the retry settled the winner");
    // The landed row is the one canonical row: the retry re-synced it
    // in place instead of appending a duplicate.
    let rows = raw_notice_rows(&parent_file);
    assert_eq!(
        rows.len(),
        1,
        "the dir-sync fault left exactly one row (every line parses)"
    );
    assert_eq!(rows[0].child_id, handle.rlm_child_id);
    assert_eq!(rows[0].kind, "completed_without_reply");
    assert!(rows[0].content.contains("no-reply child:dirsynced"));
    let parent_id = rig.engine.session.session_id().await;
    assert_eq!(
        rows[0].notice_key,
        format!("{}:{}", parent_id, handle.rlm_child_id)
    );
}

#[tokio::test]
async fn an_undurable_reply_keeps_done_replied_pending_until_the_row_lands() {
    // A busy parent's explicit reply whose DURABLE admission fails must
    // not let DoneReplied publish: the reserved reply stays pending on
    // the claim, the verdict holds with its diagnostic, and only the
    // recovered durable reply row settles it — with NO terminal notice
    // row ever owed.
    let rig = TestRig::new().await;
    let parent_file = session_file_of(&rig.engine).await;
    // One completed turn first (a real durable file), then the parent
    // stays BUSY across the whole reply sequence.
    rig.run_parent_turn("first turn").await;
    rig.catalog.provider("glm-5.3").push_stalled_turn("busy");
    rig.engine
        .session
        .prompt(
            "hold the line",
            crate::session_engine::PromptOptions {
                return_after_accepted: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let parent = Arc::clone(&rig.engine);
    eventually("the parent to stream", move || {
        let parent = Arc::clone(&parent);
        async move { parent.session.agent().state().await.is_streaming }
    })
    .await;
    rig.catalog
        .provider("glm-5.3-turbo")
        .push_stalled_turn("child partial");
    let handle = rig
        .host
        .spawn(spawn_request(
            Some("replier"),
            Some("test-provider/glm-5.3-turbo"),
        ))
        .await
        .unwrap();
    let child = rig.first_child().await;
    let child_engine = Arc::clone(&child.engine);
    eventually("the child to stream", move || {
        let engine = Arc::clone(&child_engine);
        async move { engine.session.agent().state().await.is_streaming }
    })
    .await;
    // The reply's strict durable admission fails: the send errors, the
    // row is reserved pending on the child, and nothing is durable.
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(true);
    let controller = InProcessFamilyController::new(
        Arc::clone(&child.child_host),
        FamilySelf::Child {
            child_id: handle.rlm_child_id.clone(),
        },
    );
    let family = controller.family().await.unwrap();
    let error = controller
        .send_agent_message(AgentMessageSendInput {
            target: family[0].id.clone(),
            message: "task done, shipping the report".to_string(),
            receiver_role: None,
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("notice append fault"), "{error}");
    assert!(
        raw_lines(&parent_file)
            .into_iter()
            .all(|line| line["customType"]
                != crate::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE),
        "the undurable reply landed no row"
    );
    assert!(
        child.state().await.replied_since_task,
        "the reply is reserved on the claim"
    );
    // The child completes: its DoneReplied claim must stay PENDING with
    // the admission diagnostic while the reply row is undurable.
    child.engine.session.agent().abort();
    let child_id = handle.rlm_child_id.clone();
    eventually("the pending DoneReplied admission diagnostic", || {
        let rig = &rig;
        let child_id = child_id.clone();
        async move {
            let collected = rig.host.collect(vec![child_id], 0).await.unwrap();
            let result = one(&collected);
            result.status == "running"
                && result
                    .error
                    .as_deref()
                    .unwrap_or_default()
                    .contains("Terminal notice admission pending")
        }
    })
    .await;
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 200)
        .await
        .unwrap();
    assert_eq!(
        one(&collected).status,
        "running",
        "the DoneReplied verdict stays pending until the reply is durable"
    );
    let parked_child = Arc::clone(&child);
    eventually("the undurable reply claim to park", move || {
        let record = Arc::clone(&parked_child);
        async move { record.state().await.parked }
    })
    .await;
    // Recover: the durable reply row lands, the claim settles — and no
    // terminal notice row is ever owed for the replied child.
    rig.engine
        .session
        .shared_persistence()
        .lock()
        .await
        .set_notice_append_fault(false);
    let collected = rig
        .host
        .collect(vec![handle.rlm_child_id.clone()], 10_000)
        .await
        .unwrap();
    let result = one(&collected);
    assert_eq!(result.status, "done");
    assert!(result.settled);
    assert_eq!(result.replied_since_task, Some(true));
    assert_eq!(
        child.claimed_kind().await,
        Some(super::registry::NoticeKind::DoneReplied)
    );
    let reply_rows = raw_lines(&parent_file)
        .into_iter()
        .filter(|line| {
            line["type"] == "custom_message"
                && line["customType"]
                    == crate::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE
        })
        .count();
    assert_eq!(reply_rows, 1, "the recovered reply row landed once");
    assert!(
        raw_notice_rows(&parent_file).is_empty(),
        "a durable reply owes no terminal notice row"
    );
    rig.engine.session.agent().abort();
}
