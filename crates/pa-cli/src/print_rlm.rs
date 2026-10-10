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
use crate::print_runtime::{ChildEngineOverrides, FauxChildQueue, HeadlessEmbedding};

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

    fn mark_disposed(&self) {
        self.disposed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.activity.notify_waiters();
    }

    pub(crate) fn session_name(&self) -> Option<String> {
        self.session_name.lock().unwrap().clone()
    }

    fn set_session_name(&self, name: Option<String>) {
        *self.session_name.lock().unwrap() = name;
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

    async fn has_unsettled_children(&self) -> bool {
        let children = self.children.lock().await;
        for child in children.iter() {
            if child.is_unsettled().await {
                return true;
            }
        }
        false
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

impl InlineChild {
    /// The quiescence predicate (TS `child.isSessionActive`): a child
    /// counts as unsettled while its run is open, its steering lane
    /// holds a delivered row, or its agent streams. The live session
    /// state — not the bookkeeping flag alone — is the fact.
    async fn is_unsettled(&self) -> bool {
        if !self.state.lock().await.settled {
            return true;
        }
        let agent = self.engine.session.agent();
        agent.has_queued_messages() || agent.state().await.is_streaming
    }
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
        None,
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

/// Whether inline subagent work is unsettled (TS
/// `_hasUnsettledRlmQuiescenceWork`): a running child, a delivered row
/// waiting in a child's lane, or a row queued on the root's own agent.
/// The goal/autonomous continuation gates and the drive's return read
/// this one probe.
pub(crate) async fn has_unsettled_rlm_work(node: &Arc<InlineSessionNode>) -> bool {
    if node.has_unsettled_children().await {
        return true;
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
        let mut boundary = TurnBoundary::new(false);
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
    }
}

/// Settle one child: capture its last assistant text as the answer,
/// publish the terminal status, deliver the no-reply notice or the
/// failure row to the parent, and fire the parent's activity.
async fn settle_child(child: &Arc<InlineChild>, run_error: Option<String>) {
    let answer = last_assistant_text(&child.engine).await;
    let name = child
        .node
        .session_name()
        .unwrap_or_else(|| child.rlm_child_id.clone());
    let notice = {
        let mut state = child.state.lock().await;
        if state.settled || child.node.is_disposed() {
            return;
        }
        state.settled = true;
        state.answer_text = answer.map(|text| cap_text(&text, ANSWER_TEXT_MAX_CHARS));
        if let Some(error) = run_error {
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
        }
    };
    if let Some(parent) = child.node.parent_node() {
        if let Some(notice) = notice {
            let delivered = match serde_json::to_value(notice) {
                Ok(value) => deliver_row(&parent, value),
                Err(error) => Err(anyhow::anyhow!(
                    "the notice failed its wire conversion: {error}"
                )),
            };
            if let Err(error) = delivered {
                eprintln!("pa-cli: RLM child notice was not delivered: {error:#}");
            }
        }
        parent.activity.notify_waiters();
    }
}

/// The last assistant row's text (the answer the collect envelope and
/// the no-reply notice carry): trailing non-assistant rows are skipped.
async fn last_assistant_text(engine: &Arc<SessionEngine>) -> Option<String> {
    let message = engine.session.last_assistant_message().await?;
    let pa_types::session::AgentMessage::Assistant(assistant) = message else {
        return None;
    };
    let text = assistant
        .content
        .iter()
        .filter_map(|block| match block {
            pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<String>();
    (!text.is_empty()).then_some(text)
}

/// Deliver one custom row to a node's session: steer the loop form into
/// the agent's steering lane (a streaming target picks it up at its next
/// turn boundary; the quiescence drive drains it when idle), then fire
/// the node's activity. One delivery path for kickoffs, replies, and
/// notices alike.
fn deliver_row(node: &Arc<InlineSessionNode>, row: Value) -> anyhow::Result<()> {
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
        current.node.mark_disposed();
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
    fn spawn(&self, request: RlmSpawnRequest) -> RlmHostFuture<RlmSpawnHandle> {
        let node = Arc::clone(&self.0);
        Box::pin(async move { spawn_inline_child(&node, request).await })
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
                let state = child.state.lock().await;
                entries.push(roster_entry(child, &state));
            }
            Ok(entries)
        })
    }

    fn delete_subagent(&self, target: String) -> RlmHostFuture<RlmDeleteSubagentResult> {
        let node = Arc::clone(&self.0);
        Box::pin(async move {
            let child = node.find_child(&target).await.map_err(anyhow::Error::msg)?;
            let was_running = !child.state.lock().await.settled;
            // Cancel the subtree first (its own children observe their
            // disposed flag and unwind), then the child's run, kernel,
            // and driver.
            dispose_child(&child).await;
            let entry = {
                let mut state = child.state.lock().await;
                state.settled = true;
                if was_running {
                    state.status = "cancelled";
                    state.error = Some("Deleted by parent orchestrator".to_string());
                }
                roster_entry(&child, &state)
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
                    let state = child.state.lock().await;
                    all_settled &= state.settled;
                    results.push(collect_result(child, &state));
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
    node.set_session_name(Some(name.to_string()));
    Ok(())
}

fn roster_entry(child: &Arc<InlineChild>, state: &InlineChildState) -> RlmSubagentEntry {
    RlmSubagentEntry {
        rlm_child_id: child.rlm_child_id.clone(),
        active_session_id: Some(child.node.session_id.clone()),
        session_id: Some(child.node.session_id.clone()),
        session_name: child
            .node
            .session_name()
            .unwrap_or_else(|| child.rlm_child_id.clone()),
        session_dir: child.node.session_dir.clone(),
        status: match state.status {
            "done" => "completed",
            other => other,
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

fn collect_result(child: &Arc<InlineChild>, state: &InlineChildState) -> RlmChildResult {
    RlmChildResult {
        rlm_child_id: child.rlm_child_id.clone(),
        session_name: Some(
            child
                .node
                .session_name()
                .unwrap_or_else(|| child.rlm_child_id.clone()),
        ),
        session_dir: Some(child.node.session_dir.clone()),
        status: state.status,
        settled: state.settled,
        answer_preview: state.answer_text.as_deref().map(compact_rlm_text),
        answer_text: state.answer_text.clone(),
        error: state.error.clone(),
        duration_ms: Some(crate::util_time::now_ms().saturating_sub(state.started_at_ms)),
        tool_use_count: None,
        replied_since_task: Some(state.replied_since_task),
    }
}

// The spawn (one inline child, admitted by the parent's kernel)

/// One real-provider child's resolved model: the selector the spawn
/// handle carries, the full model the engine serves, and the thinking
/// level the child runs.
struct ChildModelInputs {
    selector: String,
    model: Model,
    thinking: pa_types::ai::ModelThinkingLevel,
}

/// The registry resolution a real-provider child runs: the shared
/// child-model chain (`None` inherits the parent's selector), then the
/// full model from the same catalog the parent resolved against.
fn real_child_inputs(
    node: &Arc<InlineSessionNode>,
    request: &RlmSpawnRequest,
) -> Result<ChildModelInputs, String> {
    let config = &node.recipe.options.config;
    let parent_selector = node.model_selector.lock().unwrap().clone();
    let selector = pa_daemon::rlm_child_model::resolve_child_model_unchecked(
        &config.agent_dir,
        request.model.as_deref(),
        parent_selector.as_deref(),
        "subagent",
    )
    .map_err(|error| format!("{error:#}"))?;
    pa_daemon::rlm_child_model::assert_thinking_supported(
        &config.agent_dir,
        request.thinking.as_deref(),
        &selector,
    )
    .map_err(|error| format!("{error:#}"))?;
    let auth = pa_core::auth::AuthStorage::create(&config.agent_dir);
    let mut registry =
        pa_core::models::ModelRegistry::create(auth, config.agent_dir.join("models.json"));
    registry.load_private_authorization_from_cache();
    let all: Vec<Model> = registry.get_all().to_vec();
    let resolved = pa_core::models::resolve_cli_model(None, &selector, &all);
    if let Some(error) = resolved.error {
        return Err(error);
    }
    let Some(model) = resolved.model else {
        return Err("No matching model found.".to_string());
    };
    // The requested level, else the parent's effective level, clamped to
    // what the child model supports.
    let requested = request
        .thinking
        .as_deref()
        .and_then(pa_ai::models::thinking_level_from_str);
    let level = requested
        .or(*node.thinking.lock().unwrap())
        .unwrap_or(pa_types::ai::ModelThinkingLevel::Medium);
    let thinking = pa_ai::models::clamp_thinking_level(&model, level);
    Ok(ChildModelInputs {
        selector,
        model,
        thinking,
    })
}

/// The per-child faux queue a scripted child runs: its own response steps
/// under `children.<spawn name>` in the faux script.
fn faux_child_inputs(
    node: &Arc<InlineSessionNode>,
    request: &RlmSpawnRequest,
    child_id: &str,
) -> Result<(FauxChildQueue, pa_types::ai::ModelThinkingLevel), String> {
    let name = request.name.clone().unwrap_or_default();
    let script = node
        .recipe
        .faux
        .as_ref()
        .and_then(|script| script.get("children"))
        .and_then(|children| children.get(&name))
        .ok_or_else(|| {
            format!(
                "PRIME_AGENT_FAUX_SCRIPT has no \"children.{name}\" entry: a scripted print run \
                 must script every spawned child"
            )
        })?;
    let steps = crate::print_runtime::faux_response_steps(
        script
            .get("responses")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                format!("PRIME_AGENT_FAUX_SCRIPT children.{name} requires a responses array")
            })?,
    )?;
    let repeat_last = script
        .get("repeatLastResponse")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // The requested level, else the parent's, rides the registration's
    // model resolution in the engine build.
    let thinking = request
        .thinking
        .as_deref()
        .and_then(pa_ai::models::thinking_level_from_str)
        .or(*node.thinking.lock().unwrap())
        .unwrap_or(pa_types::ai::ModelThinkingLevel::Medium);
    Ok((
        FauxChildQueue {
            child_id: child_id.to_string(),
            steps,
            repeat_last,
        },
        thinking,
    ))
}

/// Admit one inline child (TS `_startRlmChildRun` minus the usage
/// attribution the daemonless host does not keep): depth gate, name
/// uniqueness, model resolution, the child session + engine, the kickoff
/// row, and the driver task. Returns at admission; the task run is the
/// driver's.
async fn spawn_inline_child(
    node: &Arc<InlineSessionNode>,
    request: RlmSpawnRequest,
) -> anyhow::Result<RlmSpawnHandle> {
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
    // Host requests run as detached tasks: same-parent spawns serialize
    // on the node's spawn gate so the name check and the push are atomic.
    let spawn_gate = node.spawn_gate.lock().await;
    {
        let children = node.children.lock().await.clone();
        for child in &children {
            if child.node.session_name().as_deref() == Some(name.as_str()) {
                return Err(spawn_name_unavailable_error(&name, node.depth + 1));
            }
        }
    }
    // The model lane: a real-provider child resolves against the catalog
    // (inheriting the parent's selector); a scripted child runs its own
    // faux registration, whose identity the builder defines.
    let (model, selector, thinking, faux) = if recipe.faux.is_some() {
        let (queue, thinking) =
            faux_child_inputs(node, &request, &child_id).map_err(anyhow::Error::msg)?;
        (None, "faux/faux-1".to_string(), thinking, Some(queue))
    } else {
        let inputs = real_child_inputs(node, &request).map_err(anyhow::Error::msg)?;
        (
            Some(inputs.model.clone()),
            inputs.selector,
            inputs.thinking,
            None,
        )
    };
    // The child's session: its own directory under the parent's
    // artifacts tree (an ephemeral temp dir without one), a persisted
    // manager with the parent edge, and the spawn name as its
    // `session_info` row (TS `_createInlineRlmSubagentRuntime`).
    let child_dir = rlm_child_session_dir(
        &config.agent_dir,
        node.session_file
            .is_some()
            .then(|| node.session_id.clone())
            .as_deref(),
        &child_id,
    )?;
    // A persisted parent gives the child its own file with the parent
    // edge; a no-session parent keeps the child in memory (TS
    // `_createInlineRlmSubagentRuntime`), still pinned to the child's
    // dir for its artifacts.
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
        pa_core::session::manager::SessionManager::in_memory_in_session_dir(&config.cwd, &child_dir)
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
        depth: node.depth + 1,
        max_depth: node.max_depth,
        model_selector: std::sync::Mutex::new(Some(selector.clone())),
        thinking: std::sync::Mutex::new(Some(thinking)),
        parent: Some(Arc::downgrade(node)),
        children: Mutex::new(Vec::new()),
        engine: OnceLock::new(),
        activity: Notify::new(),
        recipe: Arc::clone(&recipe),
        disposed: std::sync::atomic::AtomicBool::new(false),
    });
    let overrides = ChildEngineOverrides {
        node: Arc::clone(&child_node),
        model,
        thinking,
        faux,
        semantic_parent_session_id: Some(node.session_id.clone()),
        spawned_by_request_id: request.spawned_by_request_id.clone(),
    };
    let headless = match &recipe.faux {
        Some(script) => crate::print_runtime::build_faux_engine_with(
            &recipe.options,
            script,
            Some(child_manager),
            "subagent",
            &HeadlessEmbedding::Child(Box::new(overrides)),
        )
        .await
        .map_err(anyhow::Error::msg)?,
        None => crate::print_runtime::build_headless_engine_with(
            &recipe.options,
            Some(child_manager),
            "subagent",
            &HeadlessEmbedding::Child(Box::new(overrides)),
        )
        .await
        .map_err(anyhow::Error::msg)?,
    };
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
    node.children.lock().await.push(Arc::clone(&child));
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
        let Some((target_node, relationship)) = resolve_family_target(node, &input.target).await
        else {
            anyhow::bail!("No family member matches \"{}\"", input.target);
        };
        // A delivery to the parent from one of its children counts as the
        // child's reply: the settle arm withholds the no-reply notice.
        if relationship == AgentFamilyRelationship::Child {
            mark_child_reply(&target_node, node).await;
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
        // A delivery to a child from its parent is a new task: a child
        // that stays silent this round still earns the no-reply notice.
        if relationship == AgentFamilyRelationship::Parent {
            mark_child_task(node, &target_node).await;
        }
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

/// Resolve one family target and the sender's relationship to it: the
/// parent (the sender is its child), a sibling, or one of the sender's
/// own children (the sender is their parent).
async fn resolve_family_target(
    node: &Arc<InlineSessionNode>,
    target: &str,
) -> Option<(Arc<InlineSessionNode>, AgentFamilyRelationship)> {
    if let Some(parent) = node.parent_node() {
        if parent.session_id == target {
            return Some((parent, AgentFamilyRelationship::Child));
        }
        for sibling in parent.children.lock().await.clone() {
            if !Arc::ptr_eq(&sibling.node, node) && sibling.node.session_id == target {
                return Some((Arc::clone(&sibling.node), AgentFamilyRelationship::Sibling));
            }
        }
    }
    for child in node.children.lock().await.clone() {
        if child.node.session_id == target {
            return Some((Arc::clone(&child.node), AgentFamilyRelationship::Parent));
        }
    }
    None
}

/// Mark one child's reply to its parent (the sender is the child).
async fn mark_child_reply(parent: &Arc<InlineSessionNode>, sender: &Arc<InlineSessionNode>) {
    for child in parent.children.lock().await.iter() {
        if Arc::ptr_eq(&child.node, sender) {
            child.state.lock().await.replied_since_task = true;
        }
    }
}

/// Mark one child's fresh task from its parent (the sender is the
/// parent): the next settle without an intervening reply earns the
/// no-reply notice.
async fn mark_child_task(parent: &Arc<InlineSessionNode>, child: &Arc<InlineSessionNode>) {
    for entry in parent.children.lock().await.iter() {
        if Arc::ptr_eq(&entry.node, child) {
            entry.state.lock().await.replied_since_task = false;
        }
    }
}
