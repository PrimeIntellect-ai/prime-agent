//! Inline (daemonless) RLM subagents for the print runtime: the
//! in-process child-session host over a tree of session nodes, the
//! agent-messaging controller for that tree, the quiescence drive that
//! holds a print run open until every admitted descendant settles, and
//! the exit disposal. TS parity is `_createInlineRlmSubagentRuntime` +
//! `waitForRlmQuiescence` minus the #2270 bug (print must wait for RLM
//! quiescence, not just headless idle).

use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use pa_core::session_engine::agent_messaging::{
    create_agent_session_message_id, create_agent_session_message_prompt,
    create_agent_session_message_row, AgentFamilyMember, AgentFamilyRelationship,
    AgentMessageController, AgentMessageDeliveryStatus, AgentMessagePromptPayload,
    AgentMessageReceipt, AgentMessageSendInput, AgentSessionMessageRowPayload,
};
use pa_core::session_engine::engine::SessionEngine;
use pa_core::session_engine::goal_boundary::custom_message_to_loop_row;
use pa_core::session_engine::provider_adapter::model_thinking_level;
use pa_core::session_engine::rlm_host::{
    resolve_rlm_max_depth, rlm_child_session_dir, rlm_create_session_daemonless_error,
    rlm_depth_limit_error, spawn_name_unavailable_error, RlmChildResult, RlmCreateSessionHandle,
    RlmCreateSessionRequest, RlmDeleteSubagentResult, RlmHostFuture, RlmSpawnHandle,
    RlmSpawnRequest, RlmSubagentEntry, RlmSubagentHost,
};

use pa_core::session_engine::rlm_notices::{
    create_rlm_child_failure_message, create_rlm_child_terminal_notice, RlmChildTerminalNotice,
};
use pa_daemon::rlm_child_model::{cap_text, compact_rlm_text, ANSWER_TEXT_MAX_CHARS};
use pa_types::ai::Model;
use pa_types::session::CustomMessage;
use serde_json::{json, Value};
use tokio::sync::{Mutex, Notify};

use crate::print_boundary::TurnBoundary;
use crate::print_runtime::{ChildEngineOverrides, ChildLane, FauxChildQueue, HeadlessEmbedding};

/// Everything a spawned child inherits from the print invocation: the
/// invocation's own config (cwd, agent dir, prompt/skill paths) and the
/// parsed faux script when the run is scripted.
pub(crate) struct PrintRecipe {
    pub options: crate::mode::RunOptions,
    pub faux: Option<Value>,
}

/// One inline session in the print process: the root print session or a
/// spawned child. The node tree is the one ownership graph behind the
/// host, the messaging controller, and the quiescence drive.
pub(crate) struct InlineSessionNode {
    /// The durable session id (family addressing, the artifacts tree).
    pub(crate) session_id: String,
    pub(crate) session_file: Option<String>,
    /// The session's directory (the spawn handle and roster rows carry it).
    pub(crate) session_dir: String,
    /// The recorded session name (children: the spawn name).
    session_name: std::sync::Mutex<Option<String>>,
    /// Serializes same-parent spawn admissions (the name check through
    /// the children push); host requests run as detached tasks.
    spawn_gate: tokio::sync::Mutex<()>,
    /// Serializes message admission with disposal; never held across an await.
    delivery_gate: std::sync::Mutex<()>,
    pub(crate) depth: u32,
    pub(crate) max_depth: u32,
    /// The session's model selector (`provider/id`), inherited by children.
    model_selector: std::sync::Mutex<Option<String>>,
    /// The session's effective thinking level, inherited by children.
    thinking: std::sync::Mutex<Option<pa_types::ai::ModelThinkingLevel>>,
    pub(crate) parent: Option<Weak<InlineSessionNode>>,
    pub(crate) children: Mutex<Vec<Arc<InlineChild>>>,
    /// The session's engine, set right after the build (the host is
    /// passed into the engine config before the engine exists).
    engine: OnceLock<Weak<SessionEngine>>,
    /// Fired on every event the quiescence drive waits for: a delivered
    /// message, a child's settle, a re-run, a disposal.
    pub(crate) activity: Notify,
    pub(crate) recipe: Arc<PrintRecipe>,
    /// Set by `rlm.delete_subagent` and the exit disposal: the drive
    /// loops and the driver task observe it and stop.
    disposed: std::sync::atomic::AtomicBool,
}

impl InlineSessionNode {
    /// The live parent node, when this node is a spawned child.
    fn parent_node(&self) -> Option<Arc<InlineSessionNode>> {
        self.parent.as_ref().and_then(Weak::upgrade)
    }

    pub(crate) fn is_disposed(&self) -> bool {
        self.disposed.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub(crate) fn session_name(&self) -> Option<String> {
        self.session_name.lock().unwrap().clone()
    }

    /// The endpoint block a delivered row's `from`/`target` fields carry.
    fn endpoint(&self) -> Value {
        let mut endpoint = json!({
            "activeSessionId": self.session_id,
            "sessionId": self.session_id,
        });
        if let Some(name) = self.session_name() {
            endpoint["sessionName"] = json!(name);
        }
        endpoint
    }

    /// The session's own name for prompts (the recorded name, else the id).
    fn sender_name(&self) -> String {
        self.session_name()
            .unwrap_or_else(|| self.session_id.clone())
    }

    /// Resolve one direct child by every selector the roster exposes.
    async fn find_child(&self, target: &str) -> Result<Arc<InlineChild>, String> {
        let children: Vec<Arc<InlineChild>> = self.children.lock().await.clone();
        let mut matches = Vec::new();
        for child in &children {
            let name = child.node.session_name();
            if child.rlm_child_id == target
                || child.node.session_id == target
                || name.as_deref() == Some(target)
            {
                matches.push(Arc::clone(child));
            }
        }
        match matches.len() {
            0 => Err(format!(
                "No direct RLM child matches \"{target}\" in the current parent session"
            )),
            1 => Ok(matches.into_iter().next().expect("one match")),
            _ => Err(format!(
                "RLM child selector \"{target}\" is ambiguous in the current parent session"
            )),
        }
    }
}

/// One spawned child: its node, engine, driver task, and live state.
pub(crate) struct InlineChild {
    pub(crate) rlm_child_id: String,
    pub(crate) node: Arc<InlineSessionNode>,
    pub(crate) engine: Arc<SessionEngine>,
    /// The child's model and request auth (the drive's boundary calls).
    model: Model,
    api_key: Option<String>,
    driver: Mutex<Option<tokio::task::JoinHandle<()>>>,
    state: Mutex<InlineChildState>,
}

struct InlineChildState {
    /// `running` | `done` | `error` | `cancelled`.
    status: &'static str,
    settled: bool,
    /// The full final-answer text, bounded by [`ANSWER_TEXT_MAX_CHARS`].
    answer_text: Option<String>,
    error: Option<String>,
    started_at_ms: u64,
    /// An agent message to the parent arrived since the task was
    /// admitted; the no-reply terminal notice is withheld once set.
    replied_since_task: bool,
}

/// The print root's node: the max-depth bound resolves here (chat
/// override > global setting > env > default — the print root inherits
/// nothing).
pub(crate) fn root_node(
    options: &crate::mode::RunOptions,
    session_manager: &pa_core::session::manager::SessionManager,
    faux: Option<Value>,
) -> Arc<InlineSessionNode> {
    let (max_depth, _) = resolve_rlm_max_depth(
        session_manager
            .get_session_file()
            .map(|path| path.display().to_string())
            .as_deref(),
        /*inherited*/ None,
        &options.config.cwd,
        &options.config.agent_dir,
    );
    Arc::new(InlineSessionNode {
        session_id: session_manager.get_session_id().to_string(),
        session_file: session_manager
            .get_session_file()
            .map(|path| path.display().to_string()),
        session_dir: session_manager.get_session_dir().display().to_string(),
        session_name: std::sync::Mutex::new(None),
        spawn_gate: tokio::sync::Mutex::new(()),
        delivery_gate: std::sync::Mutex::new(()),
        depth: 0,
        max_depth: u32::try_from(max_depth).unwrap_or(u32::MAX),
        model_selector: std::sync::Mutex::new(None),
        thinking: std::sync::Mutex::new(None),
        parent: None,
        children: Mutex::new(Vec::new()),
        engine: OnceLock::new(),
        activity: Notify::new(),
        recipe: Arc::new(PrintRecipe {
            options: options.clone(),
            faux,
        }),
        disposed: std::sync::atomic::AtomicBool::new(false),
    })
}

/// Publish the built engine onto its node: the host and the messaging
/// controller reach the session through this weak edge.
pub(crate) async fn adopt_built_engine(
    node: &Arc<InlineSessionNode>,
    engine: &Arc<SessionEngine>,
    model: &Model,
) {
    let _ = node.engine.set(Arc::downgrade(engine));
    *node.model_selector.lock().unwrap() = Some(format!("{}/{}", model.provider, model.id));
    let level = engine.session.agent().state().await.thinking_level;
    *node.thinking.lock().unwrap() = Some(model_thinking_level(level));
}

/// The inline host and the agent-message handlers one engine build wires
/// over its node (the root and every child get both).
pub(crate) fn inline_subagent_wiring(
    node: &Arc<InlineSessionNode>,
) -> (
    Arc<dyn RlmSubagentHost>,
    pa_core::kernel::shared::HostRequestHandlers,
) {
    let mut handlers = pa_core::kernel::shared::HostRequestHandlers::default();
    pa_core::session_engine::agent_messaging::register_agent_message_host_handlers(
        std::sync::Arc::new(InlineMessages(Arc::clone(node))),
        &mut handlers,
    );
    (Arc::new(InlineHost(Arc::clone(node))), handlers)
}

// The quiescence drive

/// Whether one child has live work (TS `child.isSessionActive`): not
/// settled, or a delivered row waiting in its lane, or a turn streaming.
/// The quiescence predicate, the collect wait, and the roster rows all
/// read this one fact — never a second bookkeeping writer — so a
/// follow-up delivered to a settled child reads unsettled until its
/// driver re-admits the run. A disposed child keeps no live work: its
/// terminal verdict stands.
async fn child_is_unsettled(child: &Arc<InlineChild>) -> bool {
    if child.node.is_disposed() {
        return false;
    }
    if !child.state.lock().await.settled {
        return true;
    }
    let agent = child.engine.session.agent();
    agent.has_queued_messages() || agent.state().await.is_streaming
}

/// Whether inline subagent work is unsettled (TS
/// `_hasUnsettledRlmQuiescenceWork`): a running child, a delivered row
/// waiting in a child's lane, or a row queued on the root's own agent.
/// The goal/autonomous continuation gates and the drive's return read
/// this one predicate: the live session state — not a bookkeeping flag
/// alone — is the fact (TS `child.isSessionActive`).
pub(crate) async fn has_unsettled_rlm_work(node: &Arc<InlineSessionNode>) -> bool {
    for child in node.children.lock().await.iter() {
        if child_is_unsettled(child).await {
            return true;
        }
    }
    node.engine
        .get()
        .and_then(Weak::upgrade)
        .is_some_and(|engine| engine.session.agent().has_queued_messages())
}

/// Drive one inline session to quiescence: drain delivered messages as
/// turns (through the print turn-boundary pair), wait out unsettled
/// descendants, and return once the session is idle with an empty queue
/// and a settled subtree — `true` when any turn drained (the drive loop
/// re-enters the boundary so the turns it armed drain).
pub(crate) async fn drive_to_quiescence(
    node: &Arc<InlineSessionNode>,
    engine: &Arc<SessionEngine>,
    boundary: &mut TurnBoundary,
    model: &Model,
    api_key: Option<String>,
    global_harness_dir: std::path::PathBuf,
) -> Result<bool, String> {
    let mut drained = false;
    loop {
        if node.is_disposed() {
            return Ok(drained);
        }
        // The wake registers before the checks (the enable-then-check
        // pattern): a settle or delivery that lands mid-scan still wakes
        // the parked drive; `notify_waiters` is the one event source.
        let notified = node.activity.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let agent = engine.session.agent();
        let streaming = agent.state().await.is_streaming;
        if !streaming && agent.has_queued_messages() {
            boundary
                .run_pre_turn(engine, model, api_key.clone())
                .await?;
            agent
                .continue_run()
                .await
                .map_err(|error| format!("{error:#}"))?;
            agent.wait_for_idle().await;
            boundary
                .run_at_settled_turn(engine, model, api_key.clone(), global_harness_dir.clone())
                .await?;
            drained = true;
            continue;
        }
        if !streaming && !has_unsettled_rlm_work(node).await {
            // A settle that landed mid-scan fires the armed wake: poll
            // it once instead of returning a false quiescence (the zero
            // timeout is the one non-blocking poll).
            if tokio::time::timeout(std::time::Duration::ZERO, notified.as_mut())
                .await
                .is_ok()
            {
                continue;
            }
            return Ok(drained);
        }
        notified.await;
    }
}

/// One child's driver task: run its task to quiescence, settle it, then
/// keep listening — a settled child re-runs on a later message until it
/// is disposed or deleted (TS `child.isSessionActive`).
async fn drive_child(child: Arc<InlineChild>) {
    let global_harness_dir = pa_core::refinement::get_global_harness_state_dir(
        &child.node.recipe.options.config.agent_dir,
    );
    loop {
        let mut boundary = TurnBoundary::new(/*json_mode*/ false);
        let run_error = drive_to_quiescence(
            &child.node,
            &child.engine,
            &mut boundary,
            &child.model,
            child.api_key.clone(),
            global_harness_dir.clone(),
        )
        .await
        .err();
        if child.node.is_disposed() {
            return;
        }
        settle_child(&child, run_error).await;
        // A settled child keeps listening: the enable-then-check park —
        // a delivered row that lands mid-scan still wakes the driver.
        loop {
            let notified = child.node.activity.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if child.node.is_disposed() {
                return;
            }
            if child.engine.session.agent().has_queued_messages() {
                break;
            }
            notified.await;
        }
        let mut state = child.state.lock().await;
        state.settled = false;
        state.status = "running";
        state.started_at_ms = crate::util_time::now_ms();
        state.error = None;
    }
}

/// Settle one child: capture its last assistant text as the answer,
/// publish the terminal status, deliver the no-reply notice or the
/// failure row to the parent, and fire the parent's activity. A terminal
/// assistant row that stopped on a provider error settles failed like a
/// drive error (the run path itself returns `Ok` for it).
async fn settle_child(child: &Arc<InlineChild>, run_error: Option<String>) {
    // The last assistant row: its text is the answer the collect envelope
    // and the no-reply notice carry (trailing non-assistant rows are
    // skipped); a provider-error stop on it is the terminal error.
    let (answer, terminal_error) =
        if let Some(pa_types::session::AgentMessage::Assistant(assistant)) =
            child.engine.session.last_assistant_message().await
        {
            let text = assistant
                .content
                .iter()
                .filter_map(|block| match block {
                    pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
                    pa_types::ai::AssistantContentBlock::Thinking(_)
                    | pa_types::ai::AssistantContentBlock::ToolCall(_) => None,
                })
                .collect::<String>();
            let terminal_error = if assistant.stop_reason == pa_types::ai::StopReason::Error {
                Some(
                    assistant
                        .error_message
                        .unwrap_or_else(|| "Assistant response failed".to_string()),
                )
            } else {
                None
            };
            ((!text.is_empty()).then_some(text), terminal_error)
        } else {
            (None, None)
        };
    let name = child
        .node
        .session_name()
        .unwrap_or_else(|| child.rlm_child_id.clone());
    let parent = child.node.parent_node();
    {
        let mut state = child.state.lock().await;
        if state.settled || child.node.is_disposed() {
            return;
        }
        state.settled = true;
        state.answer_text = answer.map(|text| cap_text(&text, ANSWER_TEXT_MAX_CHARS));
        let notice = if let Some(error) = run_error.or(terminal_error) {
            state.status = "error";
            state.error = Some(error.clone());
            Some(create_rlm_child_failure_message(
                &child.rlm_child_id,
                &name,
                &error,
                crate::util_time::now_ms(),
            ))
        } else {
            state.status = "done";
            (!state.replied_since_task).then(|| {
                create_rlm_child_terminal_notice(
                    &RlmChildTerminalNotice::CompletedWithoutReply {
                        child_id: child.rlm_child_id.clone(),
                        session_name: name.clone(),
                        last_assistant_text_preview: state
                            .answer_text
                            .as_deref()
                            .map(compact_rlm_text),
                    },
                    crate::util_time::now_ms(),
                )
            })
        };
        // The notice queues on the parent's lane while this lock is held:
        // every reader of `settled` reads it under this same lock, so none
        // can observe the settled child before the parent's queue holds its
        // row — the quiescence check reads the child state before the
        // parent's queue and cannot return through the gap.
        if let (Some(parent), Some(notice)) = (&parent, notice) {
            let delivered = match serde_json::to_value(notice) {
                Ok(value) => deliver_row(parent, value),
                Err(error) => Err(anyhow::anyhow!(
                    "the notice failed its wire conversion: {error}"
                )),
            };
            if let Err(error) = delivered {
                eprintln!("pa-cli: RLM child notice was not delivered: {error:#}");
            }
        }
    }
    if let Some(parent) = parent {
        parent.activity.notify_waiters();
    }
}

/// Deliver one custom row to a node's session: steer the loop form into
/// the agent's steering lane (a streaming target picks it up at its next
/// turn boundary; the quiescence drive drains it when idle), then fire
/// the node's activity. One delivery path for kickoffs, replies, and
/// notices alike.
fn deliver_row(node: &Arc<InlineSessionNode>, row: Value) -> anyhow::Result<()> {
    let _delivery_guard = node.delivery_gate.lock().unwrap();
    if node.is_disposed() {
        anyhow::bail!("Cannot deliver to a disposed inline session");
    }
    let custom: CustomMessage = serde_json::from_value(row).map_err(|error| {
        anyhow::anyhow!("the delivered row failed its wire conversion: {error}")
    })?;
    let engine = node
        .engine
        .get()
        .and_then(Weak::upgrade)
        .ok_or_else(|| anyhow::anyhow!("the target session is not running"))?;
    let loop_row = custom_message_to_loop_row(&custom)
        .ok_or_else(|| anyhow::anyhow!("the delivered row failed its loop conversion"))?;
    engine.session.agent().steer(loop_row);
    node.activity.notify_waiters();
    Ok(())
}

// The exit disposal (TS `disposeHostedSubagentRuntimes`)

/// Tear one inline child down, its subtree with it: mark it disposed,
/// abort any running turn, dispose the kernel with a final namespace
/// snapshot, and join the driver task. No child kernel may outlive the
/// print process.
async fn dispose_child(child: &Arc<InlineChild>) {
    let mut pending = vec![Arc::clone(child)];
    while let Some(current) = pending.pop() {
        {
            let _delivery_guard = current.node.delivery_gate.lock().unwrap();
            current
                .node
                .disposed
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        current.node.activity.notify_waiters();
        current.engine.session.agent().abort();
        current.engine.dispose_kernel().await;
        if let Some(driver) = current.driver.lock().await.take() {
            let _ = driver.await;
        }
        pending.extend(std::mem::take(&mut *current.node.children.lock().await));
    }
}

/// Tear every inline descendant of the root down.
pub(crate) async fn dispose_inline_subagents(root: &Arc<InlineSessionNode>) {
    {
        let _delivery_guard = root.delivery_gate.lock().unwrap();
        root.disposed
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    root.activity.notify_waiters();
    let children = std::mem::take(&mut *root.children.lock().await);
    for child in children {
        dispose_child(&child).await;
    }
}

// The host (the `rlm.*` kernel surface)

/// The inline child-session host: one node per parent, its children in
/// the same process, driven by the quiescence loop.
struct InlineHost(Arc<InlineSessionNode>);

impl RlmSubagentHost for InlineHost {
    /// Admit one inline child (TS `_startRlmChildRun` minus the usage
    /// attribution the daemonless host does not keep): depth gate, name
    /// uniqueness, model resolution, the child session + engine, the
    /// kickoff row, and the driver task. Returns at admission; the task
    /// run is the driver's.
    fn spawn(&self, request: RlmSpawnRequest) -> RlmHostFuture<RlmSpawnHandle> {
        let node = Arc::clone(&self.0);
        Box::pin(async move {
            if node.depth >= node.max_depth {
                return Err(rlm_depth_limit_error(node.depth, node.max_depth));
            }
            let recipe = Arc::clone(&node.recipe);
            let config = &recipe.options.config;
            let child_id = format!("sub-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
            let name = request.name.clone().unwrap_or_else(|| {
                pa_core::kernel::rlm_runtime::create_default_rlm_subagent_session_name(
                    &request.prompt,
                    &child_id,
                )
            });
            // Host requests run as detached tasks: same-parent spawns
            // serialize on the node's spawn gate so the name check and the
            // push are atomic.
            let spawn_gate = node.spawn_gate.lock().await;
            if node.is_disposed() {
                anyhow::bail!("Cannot spawn from a disposed inline session");
            }
            {
                let children = node.children.lock().await.clone();
                for child in &children {
                    if child.node.session_name().as_deref() == Some(name.as_str()) {
                        return Err(spawn_name_unavailable_error(&name, node.depth + 1));
                    }
                }
            }
            // The child's thinking: the requested level, else the parent's
            // effective one; a real-provider child clamps it to what its
            // model supports.
            let thinking = request
                .thinking
                .as_deref()
                .and_then(pa_ai::models::thinking_level_from_str)
                .or(*node.thinking.lock().unwrap())
                .unwrap_or(pa_types::ai::ModelThinkingLevel::Medium);
            // The model lane: a scripted child runs its own faux queue under
            // `children.<spawn name>`; a real-provider child resolves against
            // the catalog, inheriting the parent's selector.
            let (selector, lane, thinking) = if let Some(script) = recipe.faux.as_ref() {
                let queue = script
                .get("children")
                .and_then(|children| children.get(&name))
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "PRIME_AGENT_FAUX_SCRIPT has no \"children.{name}\" entry: a scripted print run \
                         must script every spawned child"
                    )
                })?;
                let steps = crate::print_runtime::faux_response_steps(
                    queue
                        .get("responses")
                        .and_then(Value::as_array)
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                            "PRIME_AGENT_FAUX_SCRIPT children.{name} requires a responses array"
                        )
                        })?,
                )
                .map_err(anyhow::Error::msg)?;
                let repeat_last = queue
                    .get("repeatLastResponse")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                (
                    "faux/faux-1".to_string(),
                    ChildLane::Faux(FauxChildQueue {
                        child_id: child_id.clone(),
                        steps,
                        repeat_last,
                    }),
                    thinking,
                )
            } else {
                let selector = pa_daemon::rlm_child_model::resolve_child_model_unchecked(
                    &config.agent_dir,
                    request.model.as_deref(),
                    node.model_selector.lock().unwrap().as_deref(),
                    "subagent",
                )
                .map_err(|error| anyhow::anyhow!("{error:#}"))?;
                pa_daemon::rlm_child_model::assert_thinking_supported(
                    &config.agent_dir,
                    request.thinking.as_deref(),
                    &selector,
                )
                .map_err(|error| anyhow::anyhow!("{error:#}"))?;
                let auth = pa_core::auth::AuthStorage::create(&config.agent_dir);
                let mut registry = pa_core::models::ModelRegistry::create(
                    auth,
                    config.agent_dir.join("models.json"),
                );
                registry.load_private_authorization_from_cache();
                let all: Vec<Model> = registry.get_all().to_vec();
                let resolved =
                    pa_core::models::resolve_cli_model(/*cli_provider*/ None, &selector, &all);
                if let Some(error) = resolved.error {
                    return Err(anyhow::Error::msg(error));
                }
                let Some(model) = resolved.model else {
                    return Err(anyhow::Error::msg("No matching model found."));
                };
                let thinking = pa_ai::models::clamp_thinking_level(&model, thinking);
                (selector, ChildLane::Real(Box::new(model)), thinking)
            };
            // The child's session: its own directory under the parent's
            // artifacts tree; a persisted parent gives the child its own file
            // with the parent edge, a no-session parent keeps the child in
            // memory (TS `_createInlineRlmSubagentRuntime`), still pinned to
            // the child's dir for its artifacts.
            let child_dir = rlm_child_session_dir(
                &config.agent_dir,
                node.session_file
                    .is_some()
                    .then(|| node.session_id.clone())
                    .as_deref(),
                &child_id,
            )?;
            let mut child_manager = if let Some(parent_file) = &node.session_file {
                let mut manager =
                    pa_core::session::manager::SessionManager::persisted(&config.cwd, &child_dir);
                manager.new_session(&pa_core::session::manager::NewSessionOptions {
                    parent_session: Some(parent_file.clone()),
                    rlm_depth: Some(u64::from(node.depth + 1)),
                    ..Default::default()
                });
                manager
            } else {
                pa_core::session::manager::SessionManager::in_memory_in_session_dir(
                    &config.cwd,
                    &child_dir,
                )
            };
            child_manager
                .append_session_info(&name)
                .map_err(anyhow::Error::from)?;
            let child_node = Arc::new(InlineSessionNode {
                session_id: child_manager.get_session_id().to_string(),
                session_file: child_manager
                    .get_session_file()
                    .map(|path| path.display().to_string()),
                session_dir: child_dir.display().to_string(),
                session_name: std::sync::Mutex::new(Some(name.clone())),
                spawn_gate: tokio::sync::Mutex::new(()),
                delivery_gate: std::sync::Mutex::new(()),
                depth: node.depth + 1,
                max_depth: node.max_depth,
                model_selector: std::sync::Mutex::new(Some(selector.clone())),
                thinking: std::sync::Mutex::new(Some(thinking)),
                parent: Some(Arc::downgrade(&node)),
                children: Mutex::new(Vec::new()),
                engine: OnceLock::new(),
                activity: Notify::new(),
                recipe: Arc::clone(&recipe),
                disposed: std::sync::atomic::AtomicBool::new(false),
            });
            let overrides = ChildEngineOverrides {
                node: Arc::clone(&child_node),
                lane,
                thinking,
                semantic_parent_session_id: Some(node.session_id.clone()),
                spawned_by_request_id: request.spawned_by_request_id.clone(),
            };
            let headless = crate::print_runtime::build_engine(
                &recipe.options,
                recipe.faux.as_ref(),
                Some(child_manager),
                "subagent",
                &HeadlessEmbedding::Child(Box::new(overrides)),
            )
            .await
            .map_err(anyhow::Error::msg)?;
            let engine = Arc::new(headless.engine);
            let _ = child_node.engine.set(Arc::downgrade(&engine));
            let child = Arc::new(InlineChild {
                rlm_child_id: child_id.clone(),
                node: Arc::clone(&child_node),
                engine: Arc::clone(&engine),
                model: headless.model,
                api_key: headless.api_key,
                driver: Mutex::new(None),
                state: Mutex::new(InlineChildState {
                    status: "running",
                    settled: false,
                    answer_text: None,
                    error: None,
                    started_at_ms: crate::util_time::now_ms(),
                    replied_since_task: false,
                }),
            });
            // Teardown can run while the engine is being built. Check while
            // holding the roster lock so disposal either takes this child or
            // admission rejects it; no child can land after the teardown drain.
            let mut children = node.children.lock().await;
            if node.is_disposed() {
                drop(children);
                engine.dispose_kernel().await;
                anyhow::bail!("Cannot spawn from a disposed inline session");
            }
            children.push(Arc::clone(&child));
            drop(children);
            drop(spawn_gate);
            // The kickoff: the task prompt rides the parent's `agent_message` row
            // (TS `spawnMessage`), delivered through the one steer path.
            let kickoff_content = format!("[task from parent]\n\n{}", request.prompt);
            let kickoff_row = create_agent_session_message_row(&AgentSessionMessageRowPayload {
                id: &format!("spawn:{child_id}"),
                prompt: &kickoff_content,
                message: &request.prompt,
                from: &node.endpoint(),
                from_relationship: Some(AgentFamilyRelationship::Parent),
                target: None,
                timestamp: crate::util_time::now_ms(),
            });
            deliver_row(&child_node, kickoff_row)?;
            let driver = tokio::spawn(drive_child(Arc::clone(&child)));
            *child.driver.lock().await = Some(driver);
            Ok(RlmSpawnHandle {
                rlm_child_id: child_id,
                name,
                session_dir: child_node.session_dir.clone(),
                model: selector,
            })
        })
    }

    fn create_session(
        &self,
        _request: RlmCreateSessionRequest,
    ) -> RlmHostFuture<RlmCreateSessionHandle> {
        Box::pin(async { Err(rlm_create_session_daemonless_error()) })
    }

    fn list_subagents(&self) -> RlmHostFuture<Vec<RlmSubagentEntry>> {
        let node = Arc::clone(&self.0);
        Box::pin(async move {
            let children = node.children.lock().await.clone();
            let mut entries = Vec::with_capacity(children.len());
            for child in &children {
                let unsettled = child_is_unsettled(child).await;
                let state = child.state.lock().await;
                entries.push(roster_entry(child, &state, unsettled));
            }
            Ok(entries)
        })
    }

    fn delete_subagent(&self, target: String) -> RlmHostFuture<RlmDeleteSubagentResult> {
        let node = Arc::clone(&self.0);
        Box::pin(async move {
            let child = node.find_child(&target).await.map_err(anyhow::Error::msg)?;
            let was_running = !child.state.lock().await.settled;
            // Cancel the child and its subtree: runs abort, kernels get
            // their final snapshots, drivers join.
            dispose_child(&child).await;
            let unsettled = child_is_unsettled(&child).await;
            let entry = {
                let mut state = child.state.lock().await;
                state.settled = true;
                if was_running {
                    state.status = "cancelled";
                    state.error = Some("Deleted by parent orchestrator".to_string());
                }
                roster_entry(&child, &state, unsettled)
            };
            node.children
                .lock()
                .await
                .retain(|other| !Arc::ptr_eq(other, &child));
            // The settle that the parked parent drive waits for.
            node.activity.notify_waiters();
            Ok(RlmDeleteSubagentResult {
                subagent: entry,
                outcome: Some("deleted"),
            })
        })
    }

    fn collect(&self, targets: Vec<String>, timeout_ms: u64) -> RlmHostFuture<Vec<RlmChildResult>> {
        let node = Arc::clone(&self.0);
        Box::pin(async move {
            let children: Vec<Arc<InlineChild>> = if targets.is_empty() {
                node.children.lock().await.clone()
            } else {
                let mut resolved = Vec::with_capacity(targets.len());
                for target in &targets {
                    resolved.push(node.find_child(target).await.map_err(anyhow::Error::msg)?);
                }
                resolved
            };
            let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                // The wake registers before the snapshot: a settle that
                // lands mid-scan still wakes the collect.
                let notified = node.activity.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let mut all_settled = true;
                let mut results = Vec::with_capacity(children.len());
                for child in &children {
                    let unsettled = child_is_unsettled(child).await;
                    let state = child.state.lock().await;
                    all_settled &= !unsettled;
                    results.push(RlmChildResult {
                        rlm_child_id: child.rlm_child_id.clone(),
                        session_name: Some(
                            child
                                .node
                                .session_name()
                                .unwrap_or_else(|| child.rlm_child_id.clone()),
                        ),
                        session_dir: Some(child.node.session_dir.clone()),
                        status: if unsettled { "running" } else { state.status },
                        settled: !unsettled,
                        answer_preview: state.answer_text.as_deref().map(compact_rlm_text),
                        answer_text: state.answer_text.clone(),
                        error: state.error.clone(),
                        duration_ms: Some(
                            crate::util_time::now_ms().saturating_sub(state.started_at_ms),
                        ),
                        tool_use_count: None,
                        replied_since_task: Some(state.replied_since_task),
                    });
                }
                if all_settled || deadline <= tokio::time::Instant::now() {
                    return Ok(results);
                }
                let _ = tokio::time::timeout_at(deadline, notified.as_mut()).await;
            }
        })
    }

    fn rename(&self, name: String, session_id: Option<String>) -> RlmHostFuture<String> {
        let node = Arc::clone(&self.0);
        Box::pin(async move {
            let self_target = session_id
                .as_deref()
                .is_none_or(|target| target == node.session_id);
            if self_target {
                rename_session(&node, &name).await?;
                return Ok(name);
            }
            let target = session_id.unwrap_or_default();
            let children = node.children.lock().await.clone();
            let mut by_ids = None;
            let mut by_name = false;
            for child in &children {
                if child.node.session_id == target || child.rlm_child_id == target {
                    by_ids = Some(Arc::clone(child));
                    break;
                }
                if child.node.session_name().as_deref() == Some(target.as_str()) {
                    by_name = true;
                }
            }
            let Some(child) = by_ids else {
                if by_name {
                    anyhow::bail!(
                        "rlm.rename session_id \"{target}\" must be the full session id or a child handle, not a session name or id suffix"
                    );
                }
                anyhow::bail!(
                    "rlm.rename can only rename the current session or one of its direct children"
                );
            };
            rename_session(&child.node, &name).await?;
            Ok(name)
        })
    }
}

/// Append one durable `session_info` name row to a node's session.
async fn rename_session(node: &Arc<InlineSessionNode>, name: &str) -> anyhow::Result<()> {
    let parent = node.parent_node();
    let _name_guard = if let Some(parent) = &parent {
        Some(parent.spawn_gate.lock().await)
    } else {
        None
    };
    if let Some(parent) = &parent {
        for sibling in parent.children.lock().await.iter() {
            if !Arc::ptr_eq(&sibling.node, node)
                && sibling.node.session_name().as_deref() == Some(name)
            {
                return Err(spawn_name_unavailable_error(name, node.depth));
            }
        }
    }
    let engine = node
        .engine
        .get()
        .and_then(Weak::upgrade)
        .ok_or_else(|| anyhow::anyhow!("the target session is not running"))?;
    let persistence = engine.session.shared_persistence();
    let mut session = persistence.lock().await;
    session
        .append_session_info(name)
        .map_err(anyhow::Error::from)?;
    *node.session_name.lock().unwrap() = Some(name.to_string());
    Ok(())
}

fn roster_entry(
    child: &Arc<InlineChild>,
    state: &InlineChildState,
    unsettled: bool,
) -> RlmSubagentEntry {
    RlmSubagentEntry {
        rlm_child_id: child.rlm_child_id.clone(),
        active_session_id: Some(child.node.session_id.clone()),
        session_id: Some(child.node.session_id.clone()),
        session_name: child
            .node
            .session_name()
            .unwrap_or_else(|| child.rlm_child_id.clone()),
        session_dir: child.node.session_dir.clone(),
        status: if unsettled {
            "running"
        } else {
            match state.status {
                "done" => "completed",
                other => other,
            }
        },
        activity: None,
        tool_use_count: None,
        duration_ms: Some(crate::util_time::now_ms().saturating_sub(state.started_at_ms)),
        answer_preview: state.answer_text.as_deref().map(compact_rlm_text),
        replied_since_task: Some(state.replied_since_task),
        progress_note: None,
        label: None,
        last_activity_at: Some(state.started_at_ms),
        activity_stale_ms: None,
    }
}

// The messaging controller (the `agent_message.*` kernel surface)

/// The family roster and delivery controller over one node's tree
/// position: the parent, the siblings, and the children.
struct InlineMessages(Arc<InlineSessionNode>);

impl AgentMessageController for InlineMessages {
    async fn family(&self) -> anyhow::Result<Vec<AgentFamilyMember>> {
        let node = &self.0;
        let mut members = Vec::new();
        let mut siblings = Vec::new();
        if let Some(parent) = node.parent_node() {
            members.push(AgentFamilyMember {
                relationship: AgentFamilyRelationship::Parent,
                id: parent.session_id.clone(),
                name: parent.session_name().filter(|name| !name.is_empty()),
                aliases: Vec::new(),
            });
            for sibling in parent.children.lock().await.clone() {
                if Arc::ptr_eq(&sibling.node, node) {
                    continue;
                }
                siblings.push(AgentFamilyMember {
                    relationship: AgentFamilyRelationship::Sibling,
                    id: sibling.node.session_id.clone(),
                    name: sibling.node.session_name(),
                    aliases: vec![sibling.rlm_child_id.clone()],
                });
            }
        }
        siblings.sort_by(|left, right| left.member_name().cmp(right.member_name()));
        let mut children = Vec::new();
        for child in node.children.lock().await.clone() {
            children.push(AgentFamilyMember {
                relationship: AgentFamilyRelationship::Child,
                id: child.node.session_id.clone(),
                name: child.node.session_name(),
                aliases: vec![child.rlm_child_id.clone()],
            });
        }
        children.sort_by(|left, right| left.member_name().cmp(right.member_name()));
        members.extend(siblings);
        members.extend(children);
        Ok(members)
    }

    async fn send_agent_message(
        &self,
        input: AgentMessageSendInput,
    ) -> anyhow::Result<AgentMessageReceipt> {
        let node = &self.0;
        if input.target == node.session_id {
            anyhow::bail!("Agent messaging cannot target the sending session");
        }
        // The sender's relationship to the target: the parent (the
        // sender is its child), a sibling, or one of the sender's own
        // children (the sender is their parent).
        let mut target: Option<(Arc<InlineSessionNode>, AgentFamilyRelationship)> = None;
        if let Some(parent) = node.parent_node() {
            if parent.session_id == input.target {
                target = Some((Arc::clone(&parent), AgentFamilyRelationship::Child));
            }
            if target.is_none() {
                for sibling in parent.children.lock().await.iter() {
                    if !Arc::ptr_eq(&sibling.node, node) && sibling.node.session_id == input.target
                    {
                        target =
                            Some((Arc::clone(&sibling.node), AgentFamilyRelationship::Sibling));
                        break;
                    }
                }
            }
        }
        if target.is_none() {
            for child in node.children.lock().await.iter() {
                if child.node.session_id == input.target {
                    target = Some((Arc::clone(&child.node), AgentFamilyRelationship::Parent));
                    break;
                }
            }
        }
        let Some((target_node, relationship)) = target else {
            anyhow::bail!("No family member matches \"{}\"", input.target);
        };
        // Marked before the delivery, so a fast child's reply cannot race
        // the marking: a reply to the parent withholds the no-reply
        // notice; a fresh task from the parent means silence this round
        // earns it.
        match relationship {
            AgentFamilyRelationship::Child => {
                for child in target_node.children.lock().await.iter() {
                    if Arc::ptr_eq(&child.node, node) {
                        child.state.lock().await.replied_since_task = true;
                    }
                }
            }
            AgentFamilyRelationship::Parent => {
                for child in node.children.lock().await.iter() {
                    if Arc::ptr_eq(&child.node, &target_node) {
                        child.state.lock().await.replied_since_task = false;
                    }
                }
            }
            AgentFamilyRelationship::Sibling => {}
        }
        let prompt = create_agent_session_message_prompt(&AgentMessagePromptPayload {
            message: input.message.clone(),
            sender_name: node.sender_name(),
            from_relationship: Some(relationship),
        });
        let id = create_agent_session_message_id();
        let row = create_agent_session_message_row(&AgentSessionMessageRowPayload {
            id: &id,
            prompt: &prompt,
            message: &input.message,
            from: &node.endpoint(),
            from_relationship: Some(relationship),
            target: Some(&target_node.endpoint()),
            timestamp: crate::util_time::now_ms(),
        });
        let engine = target_node
            .engine
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| anyhow::anyhow!("the target session is not running"))?;
        // One delivery path: the steer lane; a streaming target picks
        // the row up at its next turn boundary, the drive drains it when
        // idle.
        let streaming = engine.session.agent().state().await.is_streaming;
        deliver_row(&target_node, row)?;
        let (delivered_at, queued_at, status) = if streaming {
            (
                None,
                Some(crate::util_time::now_iso8601()),
                AgentMessageDeliveryStatus::Queued,
            )
        } else {
            (
                Some(crate::util_time::now_iso8601()),
                None,
                AgentMessageDeliveryStatus::Delivered,
            )
        };
        Ok(AgentMessageReceipt {
            id,
            target: target_node.session_id.clone(),
            target_session_id: Some(target_node.session_id.clone()),
            target_session_name: target_node.session_name().filter(|name| !name.is_empty()),
            target_runtime_kind: None,
            message: input.message.clone(),
            delivery_status: status,
            delivery_mode: Some("steer"),
            receiver_role: input.receiver_role,
            delivered_at,
            queued_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_options(directory: &std::path::Path) -> crate::mode::RunOptions {
        crate::mode::RunOptions {
            app_mode: crate::mode::AppMode::Print,
            config: crate::mode::RuntimeConfig {
                cwd: directory.to_path_buf(),
                agent_dir: directory.join("agent"),
                ..Default::default()
            },
            session: crate::mode::SessionOptions::default(),
            messages: Vec::new(),
            file_args: Vec::new(),
            daemon_socket: None,
            list_models: None,
            initial_message: None,
            initial_images: Vec::new(),
            verbose: false,
            offline: true,
            agents_view_requested: false,
            attach_agent: None,
        }
    }

    #[tokio::test]
    async fn spawn_waiting_for_admission_rejects_a_disposed_parent() {
        let directory = tempfile::tempdir().unwrap();
        let options = run_options(directory.path());
        std::fs::create_dir_all(&options.config.agent_dir).unwrap();
        let manager = pa_core::session::manager::SessionManager::in_memory(directory.path());
        let mut node = root_node(
            &options,
            &manager,
            Some(json!({
                "responses": ["parent"],
                "children": { "late": { "responses": ["child"] } },
            })),
        );
        Arc::get_mut(&mut node).unwrap().max_depth = 2;
        let gate = node.spawn_gate.lock().await;
        let mut spawn = InlineHost(Arc::clone(&node)).spawn(RlmSpawnRequest {
            prompt: "finish the task".to_string(),
            name: Some("late".to_string()),
            model: None,
            thinking: None,
            spawned_by_request_id: None,
            cell_source_code: None,
        });
        std::future::poll_fn(|context| {
            assert!(spawn.as_mut().poll(context).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        node.disposed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        drop(gate);
        let result = spawn.await;
        let admitted = node.children.lock().await.len();
        dispose_inline_subagents(&node).await;
        let error = result.expect_err("a disposed parent must not admit a queued spawn");
        assert!(error.to_string().contains("disposed"), "{error:#}");
        assert_eq!(admitted, 0);
    }

    #[tokio::test]
    async fn delivery_to_a_disposed_session_rejects_without_queuing() {
        let directory = tempfile::tempdir().unwrap();
        let options = run_options(directory.path());
        std::fs::create_dir_all(&options.config.agent_dir).unwrap();
        let manager = pa_core::session::manager::SessionManager::in_memory(directory.path());
        let script = json!({ "responses": ["parent"] });
        let node = root_node(&options, &manager, Some(script.clone()));
        let headless = crate::print_runtime::build_engine(
            &options,
            Some(&script),
            Some(manager),
            "print",
            &HeadlessEmbedding::Root {
                node: Arc::clone(&node),
            },
        )
        .await
        .unwrap();
        let engine = Arc::new(headless.engine);
        adopt_built_engine(&node, &engine, &headless.model).await;
        let endpoint = node.endpoint();
        let row = create_agent_session_message_row(&AgentSessionMessageRowPayload {
            id: "late-message",
            prompt: "late message",
            message: "late message",
            from: &endpoint,
            from_relationship: None,
            target: Some(&endpoint),
            timestamp: 0,
        });
        dispose_inline_subagents(&node).await;
        assert!(!engine.session.agent().has_queued_messages());
        let result = deliver_row(&node, row);
        let queued = engine.session.agent().has_queued_messages();
        engine.dispose_kernel().await;
        let error = result.expect_err("a disposed session must reject a retained delivery target");
        assert!(error.to_string().contains("disposed"), "{error:#}");
        assert!(
            !queued,
            "rejected delivery must not enqueue an unread message"
        );
    }
}
