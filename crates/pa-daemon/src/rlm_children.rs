//! Supervisor-backed RLM child sessions: the daemon's implementation of the
//! pa-core [`RlmSubagentHost`] seam. `rlm.spawn` and `rlm.create_session`
//! create real daemon sessions through the supervisor link (one supervised
//! worker process per child), prompt them, and keep the parent-side roster
//! the kernel reads through `rlm.list_subagents`, `rlm.collect`, and
//! `rlm.delete_subagent`.
//!
//! Mechanism note (PORTING-NOTES): the TS daemon hosts children in-process
//! (`createRlmSubagentRuntime`); this redesign gives every child its own
//! supervised worker process, created through the supervisor like any other
//! session. The kernel-visible surface (handles, roster rows, collect
//! snapshots, selector errors) is TS parity.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use pa_core::kernel::rlm_runtime::create_default_rlm_subagent_session_name;
use pa_core::session_engine::rlm_host::{
    RlmChildResult, RlmCreateSessionHandle, RlmCreateSessionRequest, RlmDeleteSubagentResult,
    RlmHostFuture, RlmSpawnHandle, RlmSpawnRequest, RlmSubagentActivity, RlmSubagentEntry,
    RlmSubagentHost,
};
use pa_core::session_engine::rlm_notices::{
    create_rlm_child_terminal_notice, RlmChildTerminalNotice,
};
use pa_types::daemon::{DaemonCommand, DaemonSessionLifecycle, PromptInput};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::rlm_child_model::{
    assert_thinking_supported, compact_rlm_text, resolve_child_model, rlm_child_label,
};
use crate::supervisor_link::SupervisorLink;
use crate::util::now_ms;

/// Depth bound without an explicit override (TS `resolveRlmMaxDepth` default).
pub const DEFAULT_RLM_MAX_DEPTH: u32 = 2;

/// How long a detached child prompt waits for its spawning parent turn to
/// complete before prompting anyway (a stuck turn must not orphan the
/// child's task; the watcher still settles it).
const TURN_DONE_WAIT_SECS: u64 = 60;

/// Grace between the first idle observation of a child and the settle
/// decision (see the stability re-check in `watch_child_settle`).
const WATCH_SETTLE_GRACE_MS: u64 = 250;
/// Deadline for one child-session create over the link (TS uses 120s).
const CREATE_TIMEOUT_MS: u64 = 120_000;
const PROMPT_TIMEOUT_MS: u64 = 30_000;
const STATE_TIMEOUT_MS: u64 = 30_000;
const KILL_TIMEOUT_MS: u64 = 30_000;
/// Grace over a collect budget passed to the worker `wait_for_idle`.
const IDLE_WAIT_GRACE_MS: u64 = 5_000;
/// Budget for one terminal-notice delivery over the supervisor route.
const NOTICE_DELIVERY_TIMEOUT_MS: u64 = 30_000;
/// Prompts longer than this are not mirrored into create runtime metadata.
const RUNTIME_METADATA_PROMPT_MAX: usize = 4096;
/// One wait slice of the settle watcher: the supervisor's long-poll budget
/// for `wait_for_idle` covers it; longer runs re-slice.
const WATCH_WAIT_SLICE_MS: u64 = 60_000;
/// Re-poll cadence after a wait slice ends without a settled child.
const WATCH_POLL_INTERVAL_MS: u64 = 2_000;
/// Log persistent worker unavailability without abandoning the child: the
/// supervisor can restart later, and roster reads never poll the worker.
const WATCH_UNREACHABLE_LOG_INTERVAL: u32 = 150;
/// The parent identity children are spawned from: recursion bounds, the
/// inherited model selector and thinking level, and the parent session's
/// persistence identity.
#[derive(Debug, Clone, Default)]
pub struct ParentIdentity {
    pub rlm_depth: u32,
    pub rlm_max_depth: u32,
    /// Parent model selector (`provider/id`); children inherit it.
    pub model: Option<String>,
    /// Parent working directory; children inherit it.
    pub cwd: Option<String>,
    /// Persisted parent session id (keys the session-artifacts tree).
    pub session_id: Option<String>,
    /// Parent session file path.
    pub session_file: Option<String>,
    /// Default thinking level children inherit.
    pub thinking: Option<String>,
    /// Verification seam: create children with a scripted engine file.
    pub child_script: Option<String>,
}

impl ParentIdentity {
    /// Identity with the default depth bound (TS `resolveRlmMaxDepth`).
    pub fn with_default_depth() -> Self {
        Self {
            rlm_max_depth: DEFAULT_RLM_MAX_DEPTH,
            ..Default::default()
        }
    }
}

/// One child's family-addressing identity: the same facts the RLM roster
/// row carries, snapshotted without a worker refresh. The agent-message
/// family view (and only it) reads children through this shape.
#[derive(Debug, Clone)]
pub struct RlmChildIdentity {
    pub rlm_child_id: String,
    pub active_session_id: String,
    pub session_id: Option<String>,
    pub session_name: String,
}

/// One tracked child session.
#[derive(Debug)]
struct ChildRecord {
    rlm_child_id: String,
    session_name: String,
    active_session_id: String,
    session_id: Option<String>,
    session_dir: String,
    label: String,
    started_at_ms: u64,
    /// Terminal state (`done` | `error` | `cancelled`); running while
    /// absent.
    settled_status: Option<&'static str>,
    answer_preview: Option<String>,
    answer_captured: bool,
    /// An agent message from this child reached the parent since its task
    /// was admitted (TS `_parentReplyCount`): the no-reply terminal notice
    /// is withheld once set.
    replied_since_task: bool,
    /// The terminal notice for this child was claimed: exactly one of the
    /// settle watcher, the delete path, or a late natural settle delivers
    /// it (double-claim races collapse here).
    notice_delivered: bool,
    /// The task prompt was admitted (the detached task reached its
    /// `prompt_child` call). Readers must not settle a pre-prompt child:
    /// it is idle with an empty queue by construction, which is exactly
    /// the idle shape a premature settle reads.
    prompt_admitted: bool,
    /// Terminal error text (TS `run.error`): the cancel reason for a
    /// cancelled run, the failure text for a failed one.
    error: Option<String>,
    /// The parent session closed while this child ran (a replacement
    /// teardown or a session close): the settle watcher exits without a
    /// notice — TS closes the child with the parent (`closeChildSessions`)
    /// and no terminal notice is owed to a session that is being torn
    /// down.
    closed_by_parent: bool,
}

impl ChildRecord {
    /// Raw run status: `running` | `done` | `error` | `cancelled`.
    fn status(&self) -> &'static str {
        self.settled_status.unwrap_or("running")
    }

    /// Kernel-roster status: `running` | `completed` | `error` |
    /// `cancelled` (TS keeps a cancelled run's status verbatim in the
    /// registry row).
    fn roster_status(&self) -> &'static str {
        match self.status() {
            "done" => "completed",
            "error" => "error",
            "cancelled" => "cancelled",
            _ => "running",
        }
    }

    fn matches(&self, target: &str) -> bool {
        self.rlm_child_id == target
            || self.active_session_id == target
            || self.session_name == target
            || self.session_id.as_deref() == Some(target)
    }
}

/// RLM children as supervisor-managed daemon sessions. A cheap shared handle:
/// the daemon hands the same children registry to every kernel handler call.
pub struct SupervisorChildSessions {
    inner: Arc<SupervisorChildSessionsInner>,
}

struct SupervisorChildSessionsInner {
    link: Arc<SupervisorLink>,
    agent_dir: PathBuf,
    parent_active_session_id: String,
    // The identity lock is only ever a data swap (never held across an
    // await), so a std mutex keeps the setter callable from sync engine
    // paths (the create command) without a runtime `block_on`.
    identity: std::sync::Mutex<ParentIdentity>,
    children: Mutex<Vec<Arc<Mutex<ChildRecord>>>>,
    /// Bumped once per completed parent turn (the worker's `EngineEvent::Done`
    /// boundary). Prompt tasks spawned mid-turn wait for the next bump so
    /// the parent's continuation request is always in flight (and its
    /// response recorded) before the child's first model turn starts — the
    /// deterministic ordering TS gets from its single-threaded event loop.
    turn_done: tokio::sync::watch::Sender<u64>,
    /// The parent engine's child-settle hook (goal continuation resume);
    /// `None` until the engine wires it.
    settle_hook: std::sync::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl Clone for SupervisorChildSessions {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl SupervisorChildSessions {
    /// Children registry bound to one parent session worker.
    pub fn new(
        link: Arc<SupervisorLink>,
        agent_dir: PathBuf,
        parent_active_session_id: String,
    ) -> Self {
        Self {
            inner: Arc::new(SupervisorChildSessionsInner {
                link,
                agent_dir,
                parent_active_session_id,
                identity: std::sync::Mutex::new(ParentIdentity::with_default_depth()),
                children: Mutex::new(Vec::new()),
                turn_done: tokio::sync::watch::Sender::new(0),
                settle_hook: std::sync::Mutex::new(None),
            }),
        }
    }

    /// The worker saw the parent's turn end: release prompt tasks waiting
    /// on the boundary (called once per `EngineEvent::Done`).
    pub fn notify_turn_done(&self) {
        self.inner.turn_done.send_modify(|value| *value += 1);
    }

    /// Register the child-settle hook (TS
    /// `_maybeResumeGoalContinuationAfterRlmWork`'s settle sites): fired
    /// once per settled child run — the natural settle watcher, the
    /// cancel walk, and the delete path — so a goal continuation owed
    /// behind descendant work re-evaluates when descendants settle.
    pub fn set_settle_hook(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.inner.settle_hook.lock().expect("settle hook lock") = Some(hook);
    }

    /// Whether any tracked child run is still unsettled (TS
    /// `_hasUnsettledRlmQuiescenceWork`'s child-run arm: a record without
    /// a terminal state).
    pub async fn any_running(&self) -> bool {
        let children = self.inner.children.lock().await;
        for record in children.iter() {
            if record.lock().await.settled_status.is_none() {
                return true;
            }
        }
        false
    }

    /// Close every tracked child session with the parent session (TS
    /// `closeChildSessions`, the daemon host's
    /// `disposeRlmSubagentRuntimes` for the replacement teardown, and the
    /// `closeSessionOnce` cascade every session close runs). The ruling:
    /// a parent that replaces or closes its runtime disposes its
    /// supervisor-backed children - a plain stop, not a delete (no
    /// `rlmLedgerDelete` marker, so the spawn edge and the passive roster
    /// row survive like TS), no terminal notice (the parent session is
    /// going away), and each child's own close cascades to its children
    /// through the child worker's kill handler.
    pub async fn close_children(&self) -> Result<()> {
        self.inner.close_children_inner().await
    }

    /// Replace the parent identity (the worker session sets it once its own
    /// session exists).
    pub fn set_identity(&self, identity: ParentIdentity) {
        *self.inner.identity.lock().expect("identity lock") = identity;
    }

    /// The inherited RLM depth bound (TS `getRlmMaxDepthStatus().maxDepth`
    /// before any chat override).
    pub fn rlm_max_depth(&self) -> u32 {
        self.inner
            .identity
            .lock()
            .expect("identity lock")
            .rlm_max_depth
    }

    /// Wire snapshots of the tracked children (TS
    /// `RlmChildAgentSnapshot`, the `get_rlm_children` response and the
    /// context-tree children): the child id, its live identity, label,
    /// run status, elapsed duration, answer preview, and session dir.
    /// `parent_id` (the parent's own RLM node id) is overlaid by the
    /// worker, which owns that identity.
    pub async fn child_snapshots(&self) -> Vec<Value> {
        let model = self
            .inner
            .identity
            .lock()
            .expect("identity lock")
            .model
            .clone();
        let children = self.inner.children.lock().await;
        let mut snapshots = Vec::new();
        for record in children.iter() {
            let record = record.lock().await;
            let mut snapshot = json!({
                "id": record.rlm_child_id,
                "activeSessionId": record.active_session_id,
                "sessionName": record.session_name,
                "label": record.label,
                "status": record.status(),
                "durationMs": now_ms().saturating_sub(record.started_at_ms),
                "sessionDir": record.session_dir,
            });
            if let Some(model) = &model {
                snapshot["model"] = json!(model);
            }
            if let Some(answer) = &record.answer_preview {
                snapshot["answerPreview"] = json!(answer);
            }
            snapshots.push(snapshot);
        }
        snapshots
    }

    /// The children registry snapshot behind the `agent_message` family
    /// view: the same registry `rlm.list_subagents` reads (the resident
    /// child set of this parent), without the per-child worker refresh -
    /// addressing never blocks on a status round trip.
    pub async fn child_identities(&self) -> Vec<RlmChildIdentity> {
        let children = self.inner.children.lock().await;
        let mut identities = Vec::with_capacity(children.len());
        for record in children.iter() {
            let record = record.lock().await;
            identities.push(RlmChildIdentity {
                rlm_child_id: record.rlm_child_id.clone(),
                active_session_id: record.active_session_id.clone(),
                session_id: record.session_id.clone(),
                session_name: record.session_name.clone(),
            });
        }
        identities
    }

    /// Record that `child_active_session_id` sent an agent message to this
    /// parent since its task was admitted. The settle watcher reads the
    /// flag before delivering a no-reply terminal notice (TS
    /// `_parentReplyCount`).
    pub async fn mark_replied(&self, child_active_session_id: &str) {
        let children = self.inner.children.lock().await;
        for record in children.iter() {
            let mut record = record.lock().await;
            if record.active_session_id == child_active_session_id {
                record.replied_since_task = true;
                return;
            }
        }
    }

    /// Test seam: admit one child record without the supervisor round trip
    /// (the controller tests exercise the family join on registry state).
    #[cfg(test)]
    pub(crate) async fn push_test_child(&self, identity: RlmChildIdentity) {
        self.inner
            .children
            .lock()
            .await
            .push(Arc::new(Mutex::new(ChildRecord {
                rlm_child_id: identity.rlm_child_id,
                session_name: identity.session_name,
                active_session_id: identity.active_session_id,
                session_id: identity.session_id,
                session_dir: String::new(),
                label: String::new(),
                started_at_ms: 0,
                settled_status: None,
                answer_preview: None,
                answer_captured: false,
                replied_since_task: false,
                notice_delivered: false,
                prompt_admitted: true,
                error: None,
                closed_by_parent: false,
            })));
    }

    /// Set only the inherited model selector (the engine resolves its model
    /// when it builds the session, after the create command arrived).
    pub fn set_model(&self, model: String) {
        self.inner.identity.lock().expect("identity lock").model = Some(model);
    }

    /// Set the session's RLM depth bound (TS `setRlmMaxDepth`): the
    /// registry is the bound every spawn checks, so the override is the
    /// live limit children respect immediately.
    pub fn set_rlm_max_depth(&self, max_depth: u32) {
        self.inner
            .identity
            .lock()
            .expect("identity lock")
            .rlm_max_depth = max_depth;
    }

    /// Cancel one live child run by id (TS `cancelRlmChildRun`): abort the
    /// child worker's in-flight turn and claim its terminal notice (the
    /// no-reply notice is suppressed, exactly the TS
    /// `run.suppressTerminalNotice` path). Returns whether a live run was
    /// cancelled; an unknown or already-settled child id answers `false`.
    pub async fn cancel_child_run(&self, child_id: &str) -> bool {
        self.inner.cancel_child_run(child_id).await
    }

    /// Delete one inactive child by id (TS `deleteInactiveRlmSubagent`):
    /// `"running"` when the child still has work in flight (the caller
    /// answers the wire `reason: "running"` refusal), `"deleted"` once the
    /// child is torn down with its ledger tombstone, `"not_found"` for an
    /// unknown id. A teardown failure surfaces as `Err` (the TS delete
    /// throws through the wire arm).
    pub async fn delete_inactive_subagent(&self, child_id: &str) -> Result<&'static str> {
        self.inner.delete_inactive_subagent(child_id).await
    }

    fn entry(record: &ChildRecord) -> RlmSubagentEntry {
        let running = record.settled_status.is_none();
        RlmSubagentEntry {
            rlm_child_id: record.rlm_child_id.clone(),
            active_session_id: Some(record.active_session_id.clone()),
            session_id: record.session_id.clone(),
            session_name: record.session_name.clone(),
            session_dir: record.session_dir.clone(),
            status: record.roster_status(),
            // Live tool introspection across worker processes is a follow-up
            // (PORTING-NOTES); a running child reports `executing`.
            activity: running.then_some(RlmSubagentActivity {
                kind: "executing",
                tool_name: None,
            }),
            tool_use_count: None,
            duration_ms: Some(now_ms().saturating_sub(record.started_at_ms)),
            answer_preview: record.answer_preview.clone(),
            replied_since_task: None,
            progress_note: None,
            label: (!record.label.is_empty()).then(|| record.label.clone()),
            last_activity_at: Some(record.started_at_ms),
            activity_stale_ms: None,
        }
    }

    fn collect_result(record: &ChildRecord) -> RlmChildResult {
        RlmChildResult {
            rlm_child_id: record.rlm_child_id.clone(),
            session_name: Some(record.session_name.clone()),
            session_dir: Some(record.session_dir.clone()),
            status: record.status(),
            settled: record.settled_status.is_some(),
            answer_preview: record.answer_preview.clone(),
            error: record.error.clone(),
            duration_ms: Some(now_ms().saturating_sub(record.started_at_ms)),
            tool_use_count: None,
            replied_since_task: None,
        }
    }
}

impl SupervisorChildSessionsInner {
    /// Fire the settle hook off-thread (the settle sites run inside
    /// watcher tasks; the hook owns its own scheduling).
    pub(crate) fn fire_settle_hook(&self) {
        let hook = self.settle_hook.lock().expect("settle hook lock").clone();
        if let Some(hook) = hook {
            std::thread::spawn(move || hook());
        }
    }
    /// Wait for the parent turn that spawned a task to complete (generation
    /// strictly greater than the one captured at spawn admission). Bounded:
    /// a turn that never settles releases the child anyway.
    pub async fn wait_turn_done(&self, generation: u64) {
        let mut receiver = self.turn_done.subscribe();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(TURN_DONE_WAIT_SECS),
            receiver.wait_for(|value| *value > generation),
        )
        .await;
    }

    /// Send one daemon command over the supervisor link and return its
    /// response data. The link owns timeouts/reconnects; this only maps the
    /// command to its wire value.
    async fn command(&self, command: &DaemonCommand, timeout_ms: u64) -> Result<Value> {
        let wire = serde_json::to_value(command).context("serialize supervisor link command")?;
        self.link
            .request_success(wire, Duration::from_millis(timeout_ms))
            .await
    }

    /// A child session name conflicts when any retained or live child of
    /// this parent already holds it (the parent-side half of the TS
    /// `_assertRlmSubagentSessionNameAvailable` check; the supervisor's
    /// create assertion is the daemon-wide half).
    async fn assert_name_available(&self, name: &str, depth: u32) -> Result<()> {
        let children = self.children.lock().await;
        for record in children.iter() {
            if record.lock().await.session_name == name {
                bail!(
                    "Agent name \"{name}\" is unavailable: an agent of that name already exists at depth {depth} under this parent"
                );
            }
        }
        Ok(())
    }

    /// The per-child session directory under the parent's artifacts tree
    /// (TS `_createChildRlmSessionDir`); the child session persists inside it.
    fn child_session_dir(&self, child_id: &str, identity: &ParentIdentity) -> Result<PathBuf> {
        let base = match &identity.session_id {
            Some(session_id) => self
                .agent_dir
                .join("session-artifacts")
                .join(session_id)
                .join(child_id),
            // No persistent parent artifacts dir: an ephemeral temp dir, the
            // TS `_createEphemeralRlmSessionDir` fallback.
            None => std::env::temp_dir().join(format!("prime-agent-rlm-{child_id}")),
        };
        std::fs::create_dir_all(&base)
            .with_context(|| format!("create RLM child session dir {}", base.display()))?;
        Ok(base)
    }

    /// Create one child session over the supervisor link (no prompt yet).
    /// `depth` is the child's recursion depth; `session_dir` holds its
    /// persisted session; `model` is the resolved `provider/id` selector.
    #[allow(clippy::too_many_arguments)]
    async fn create_child(
        &self,
        child_id: &str,
        name: Option<&str>,
        // The spawned task's prompt, mirrored into the create runtime
        // metadata (`None` for a depth-0 resident session).
        prompt: Option<&str>,
        depth: u32,
        model: &str,
        thinking: Option<&str>,
        cwd: &str,
        session_dir: &Path,
        runtime_metadata: Option<Value>,
        identity: &ParentIdentity,
    ) -> Result<CreatedChild> {
        let mut config = json!({
            "cwd": cwd,
            "sessionDir": session_dir.to_string_lossy(),
            "rlmDepth": depth,
            "rlmMaxDepth": identity.rlm_max_depth,
        });
        if let Some((provider, id)) = model.split_once('/') {
            config["provider"] = json!(provider);
            config["model"] = json!(id);
        } else {
            config["model"] = json!(model);
        }
        if let Some(thinking) = thinking {
            config["thinking"] = json!(thinking);
        }
        if let Some(parent_file) = &identity.session_file {
            config["parentSessionPath"] = json!(parent_file);
        }
        if let Some(script) = &identity.child_script {
            config["script"] = json!(script);
            // The scripted engine rides the identity down the recursion
            // (the TS child runtime inherits the parent's sessionConfig, so
            // a harness child spawns harness grandchildren the same way).
            config["childScript"] = json!(script);
        }
        // Runtime metadata mirrors the TS subagent runtime identity; a
        // depth-0 resident session carries none (it is a plain root session).
        let runtime_metadata = runtime_metadata.map(|mut metadata| {
            if let Some(session_id) = &identity.session_id {
                metadata["parentSessionId"] = json!(session_id);
            }
            if let Some(parent_file) = &identity.session_file {
                metadata["parentSessionFile"] = json!(parent_file);
            }
            if let Some(prompt) =
                prompt.filter(|prompt| prompt.len() <= RUNTIME_METADATA_PROMPT_MAX)
            {
                metadata["prompt"] = json!(prompt);
            }
            // The resolved model rides the metadata so the supervisor's
            // display entry carries it for passive hydration.
            if let Some((provider, model_id)) = model.split_once('/') {
                metadata["model"] = json!({ "provider": provider, "modelId": model_id });
            }
            metadata
        });
        let create = DaemonCommand::Create {
            id: None,
            session_path: None,
            continue_recent: None,
            no_session: None,
            name: name.map(str::to_string),
            config: Some(config),
            // RLM children never report telemetry (the depth-0 gate in the
            // session engine installs nothing); the worker's own opt-out
            // stays process-level.
            telemetry_disabled: None,
            runtime_metadata,
            lifecycle: Some(DaemonSessionLifecycle::Resident),
            env: None,
            launch_env: None,
            rest: Default::default(),
        };
        let summary = self
            .command(&create, CREATE_TIMEOUT_MS)
            .await
            .with_context(|| format!("spawn RLM child session {child_id}"))?;
        let created = CreatedChild::from_summary(&summary, session_dir)?;
        Ok(created)
    }

    /// Create and promptly admit one child's task (the depth-0 resident
    /// session path: the prompt is part of the awaited admission).
    #[allow(clippy::too_many_arguments)]
    async fn launch_child(
        &self,
        child_id: &str,
        name: Option<&str>,
        prompt: &str,
        depth: u32,
        model: &str,
        thinking: Option<&str>,
        cwd: &str,
        session_dir: &Path,
        runtime_metadata: Option<Value>,
        identity: &ParentIdentity,
    ) -> Result<CreatedChild> {
        let created = self
            .create_child(
                child_id,
                name,
                None,
                depth,
                model,
                thinking,
                cwd,
                session_dir,
                runtime_metadata,
                identity,
            )
            .await?;
        // A failed prompt tears the just-created session down (TS kills the
        // created session in the create-path catch block).
        if let Err(error) = self.prompt_child(&created.active_session_id, prompt).await {
            let _ = self.kill_child(&created.active_session_id).await;
            return Err(error);
        }
        Ok(created)
    }

    /// Parse a created-session summary into its ids (TS `createRlmRootSession`
    /// reads `activeSessionId`/`sessionId`/`sessionFile`/`sessionName`).
    fn created_summary_ids(summary: &Value) -> Result<CreatedSessionIds> {
        let active_session_id = summary
            .get("activeSessionId")
            .or_else(|| summary.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow!("supervisor returned a session summary without an id"))?;
        Ok(CreatedSessionIds {
            active_session_id: active_session_id.to_string(),
            session_id: summary
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
            session_file: summary
                .get("sessionFile")
                .and_then(Value::as_str)
                .map(str::to_string),
            session_name: summary
                .get("sessionName")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    async fn prompt_child(&self, active_session_id: &str, prompt: &str) -> Result<()> {
        let command = DaemonCommand::Prompt {
            id: None,
            active_session_id: active_session_id.to_string(),
            message: prompt.to_string(),
            input: PromptInput {
                content: None,
                images: None,
                streaming_behavior: None,
                queue_if_busy: None,
                expand_prompt_templates: None,
                source: Some(json!("rpc")),
                agent_message_id: None,
                custom_message: None,
                queue_key: None,
                prefix_messages: None,
                admission_id: None,
            },
            rest: Default::default(),
        };
        self.command(&command, PROMPT_TIMEOUT_MS)
            .await
            .with_context(|| format!("prompt RLM child session {active_session_id}"))?;
        Ok(())
    }

    async fn kill_child(&self, active_session_id: &str) -> Result<()> {
        let command = DaemonCommand::Kill {
            id: None,
            active_session_id: active_session_id.to_string(),
            rest: Default::default(),
        };
        self.command(&command, KILL_TIMEOUT_MS)
            .await
            .with_context(|| format!("kill RLM child session {active_session_id}"))?;
        Ok(())
    }

    /// Whether the child worker still has work in flight (streaming or
    /// queued). `Err` means the child cannot be reached right now.
    async fn child_busy(&self, active_session_id: &str) -> Result<bool> {
        let command = DaemonCommand::GetState {
            id: None,
            active_session_id: active_session_id.to_string(),
            rest: Default::default(),
        };
        let state = self.command(&command, STATE_TIMEOUT_MS).await?;
        Ok(state
            .get("isStreaming")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || state
                .get("sessionActions")
                .and_then(|actions| actions.get("queuedCount"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > 0)
    }

    /// The child's final answer text, compacted for the roster preview.
    async fn child_answer(&self, active_session_id: &str) -> Result<Option<String>> {
        let command = DaemonCommand::GetLastAssistantText {
            id: None,
            active_session_id: active_session_id.to_string(),
            rest: Default::default(),
        };
        let answer = self.command(&command, STATE_TIMEOUT_MS).await?;
        Ok(answer
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(compact_rlm_text))
    }

    /// Best-effort bounded wait for one child to go idle. The wait is a
    /// snapshot helper, not a gate: its timeout is not an error, and the
    /// caller re-reads the child's state afterwards (TS collect: "a
    /// timeout returns current snapshots, never an error").
    async fn wait_for_child(&self, active_session_id: &str, budget: Duration) {
        if budget.is_zero() {
            return;
        }
        let command = DaemonCommand::WaitForIdle {
            id: None,
            active_session_id: active_session_id.to_string(),
            rest: Default::default(),
        };
        let _ = self
            .command(&command, budget.as_millis() as u64 + IDLE_WAIT_GRACE_MS)
            .await;
    }

    /// Refresh one record against its worker: settle a child whose worker
    /// ran out of work and capture its answer once. An unreachable child
    /// keeps its last known state (the supervisor may be restarting).
    async fn refresh_record(&self, record: &Arc<Mutex<ChildRecord>>) {
        {
            let record = record.lock().await;
            if !record.prompt_admitted {
                return;
            }
        }
        let active_session_id = record.lock().await.active_session_id.clone();
        let busy = self.child_busy(&active_session_id).await;
        if !matches!(busy, Ok(false)) {
            return;
        }
        // Capture the answer before taking the record lock (the capture is
        // a link round trip).
        let answer = self.child_answer(&active_session_id).await.ok().flatten();
        let mut record = record.lock().await;
        if record.settled_status.is_none() {
            record.settled_status = Some("done");
            // A settled preview is never overwritten with a later miss, but
            // a `None` capture (the settle raced the admission-to-run
            // hand-off) recovers on a later refresh.
            if !record.answer_captured || record.answer_preview.is_none() {
                record.answer_preview = answer;
                record.answer_captured = true;
            }
        }
    }

    /// Watch one admitted child until its run settles, then deliver the
    /// parent's terminal notice when the child never replied (TS
    /// `deliverTerminalMessageToParent` on the detached run task). The
    /// watcher owns no registry state: it stops as soon as the record is
    /// removed (deleted children carry their own cancelled notice).
    async fn watch_child_settle(&self, record: &Arc<Mutex<ChildRecord>>) {
        let mut unreachable_polls: u32 = 0;
        loop {
            // The parent's session closed with this child running (a
            // replacement teardown or a session close): the child dies with
            // the parent (TS `closeChildSessions`) and no notice is owed to
            // the torn-down session - the watch ends without polling the
            // killed child.
            if record.lock().await.closed_by_parent {
                return;
            }
            let active_session_id = record.lock().await.active_session_id.clone();
            // One bounded idle-wait slice: a slice that times out while the
            // child still runs re-slices; the returned slice means the child
            // drained its queue.
            self.wait_for_child(
                &active_session_id,
                Duration::from_millis(WATCH_WAIT_SLICE_MS),
            )
            .await;
            self.refresh_record(record).await;
            let settled = record.lock().await.settled_status.is_some();
            if settled {
                // Stability re-check: a prompt admitted to an idle worker
                // can read idle once between the admission and the turn
                // pop (the queue snapshot and the busy flag change under
                // different locks on the far side of a socket). A short
                // grace closes that window; a child that went busy again
                // (a queued continuation) keeps watching.
                tokio::time::sleep(Duration::from_millis(WATCH_SETTLE_GRACE_MS)).await;
                if !matches!(self.child_busy(&active_session_id).await, Ok(false)) {
                    record.lock().await.settled_status = None;
                    continue;
                }
                self.refresh_record(record).await;
                self.deliver_settle_notice(record).await;
                // A settled child releases an owed goal continuation (TS
                // `_maybeResumeGoalContinuationAfterRlmWork` at the child
                // settle sites).
                self.fire_settle_hook();
                return;
            }
            // Still running (a timed-out slice or a re-queued continuation):
            // re-check liveness so a dead worker cannot spin the watch.
            let busy = self.child_busy(&active_session_id).await;
            match busy {
                Ok(_) => unreachable_polls = 0,
                Err(_) => {
                    unreachable_polls += 1;
                    if unreachable_polls >= WATCH_UNREACHABLE_LOG_INTERVAL {
                        eprintln!(
                            "pa-daemon: RLM child settle watcher is waiting for unreachable child {active_session_id}"
                        );
                        unreachable_polls = 0;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(WATCH_POLL_INTERVAL_MS)).await;
        }
    }

    /// Deliver the no-reply terminal notice for a settled child that never
    /// sent an agent message to the parent. Exactly-once: the record's
    /// notice claim collapses the races between the watcher, a natural
    /// settle during `delete_subagent`, and the delete path itself.
    async fn deliver_settle_notice(&self, record: &Arc<Mutex<ChildRecord>>) {
        let notice = {
            let mut record = record.lock().await;
            if record.notice_delivered || record.replied_since_task {
                return;
            }
            record.notice_delivered = true;
            RlmChildTerminalNotice::CompletedWithoutReply {
                child_id: record.rlm_child_id.clone(),
                session_name: record.session_name.clone(),
                last_assistant_text_preview: record.answer_preview.clone(),
            }
        };
        self.deliver_terminal_notice(&notice).await;
    }

    /// Deliver one terminal notice into the parent session: the notice rides
    /// the supervisor's `follow_up` route as an injected custom turn (the
    /// row renders in the parent transcript and the turn runs on the
    /// notice content, the TS `followUp` notice action).
    async fn deliver_terminal_notice(&self, notice: &RlmChildTerminalNotice) {
        let message = create_rlm_child_terminal_notice(notice, now_ms());
        let Some(content) = custom_message_text(&message) else {
            eprintln!("pa-daemon: RLM child notice carried no text content");
            return;
        };
        let wire = serde_json::to_value(pa_types::session::AgentMessage::Custom(message))
            .unwrap_or(Value::Null);
        let command = DaemonCommand::FollowUp {
            id: None,
            active_session_id: self.parent_active_session_id.clone(),
            message: content,
            input: PromptInput {
                content: None,
                images: None,
                streaming_behavior: None,
                queue_if_busy: None,
                expand_prompt_templates: None,
                source: None,
                agent_message_id: None,
                custom_message: Some(wire),
                queue_key: None,
                prefix_messages: None,
                admission_id: None,
            },
            rest: Default::default(),
        };
        if let Err(error) = self.command(&command, NOTICE_DELIVERY_TIMEOUT_MS).await {
            eprintln!(
                "pa-daemon: RLM child terminal notice was not delivered to the parent session: {error:#}"
            );
        }
    }

    /// Abort one child's live run (see
    /// [`SupervisorChildSessions::cancel_child_run`], the TS
    /// `cancelRlmChildRun` walk): claim the terminal notice, settle the
    /// registry row as `cancelled`, then abort the child worker's
    /// in-flight turn (best-effort: an unreachable child keeps its
    /// cancelled row - the registry is the user-visible state).
    async fn cancel_child_run(&self, child_id: &str) -> bool {
        let children = self.children.lock().await.clone();
        for record in &children {
            let (matched, running, active_session_id) = {
                let record = record.lock().await;
                (
                    record.rlm_child_id == child_id,
                    record.settled_status.is_none(),
                    record.active_session_id.clone(),
                )
            };
            // A fruitless match keeps walking: child ids are only
            // mkdir-unique among siblings, so a colliding live run
            // elsewhere must stay reachable (TS parity).
            if !matched || !running {
                continue;
            }
            {
                let mut record = record.lock().await;
                // The no-reply terminal notice is suppressed for a
                // cancelled run (TS `run.suppressTerminalNotice = true`);
                // a settle watcher that already claimed it keeps its claim
                // (the double-claim race collapses).
                record.notice_delivered = true;
                record.settled_status = Some("cancelled");
                record.error = Some("Cancelled by user".to_string());
            }
            let abort = DaemonCommand::Abort {
                id: None,
                active_session_id: active_session_id.clone(),
                rest: Default::default(),
            };
            let _ = self
                .command(&abort, KILL_TIMEOUT_MS)
                .await
                .with_context(|| format!("abort RLM child session {active_session_id}"));
            // The settled/cancelled child releases an owed goal
            // continuation.
            self.fire_settle_hook();
            return true;
        }
        false
    }

    /// Delete one inactive child by id (TS `deleteInactiveRlmSubagent`):
    /// refresh the registry row first (the TS listing pass), refuse a child
    /// that still has work in flight, and tear a settled one down with its
    /// ledger tombstone (the same kill boundary `rlm.delete_subagent`
    /// uses, so the passive roster row goes with the process).
    async fn delete_inactive_subagent(&self, child_id: &str) -> Result<&'static str> {
        let children = self.children.lock().await.clone();
        for record in &children {
            let matched = record.lock().await.rlm_child_id == child_id;
            if !matched {
                continue;
            }
            // Freshness pass (TS `listRlmSubagents` inside the delete): a
            // child that just went idle settles here and stays deletable.
            self.refresh_record(record).await;
            let (running, active_session_id) = {
                let record = record.lock().await;
                (
                    record.settled_status.is_none(),
                    record.active_session_id.clone(),
                )
            };
            if running {
                return Ok("running");
            }
            let command = DaemonCommand::Kill {
                id: None,
                active_session_id: active_session_id.clone(),
                rest: serde_json::Map::from_iter([
                    ("rlmLedgerDelete".to_string(), json!("user")),
                    ("rlmChildId".to_string(), json!(child_id)),
                ]),
            };
            self.command(&command, KILL_TIMEOUT_MS)
                .await
                .with_context(|| format!("kill RLM child \"{child_id}\""))?;
            self.children
                .lock()
                .await
                .retain(|candidate| !Arc::ptr_eq(candidate, record));
            // The deleted child is a TS resume site for the owed goal
            // continuation (`_finishRlmRunDeletion`).
            self.fire_settle_hook();
            return Ok("deleted");
        }
        Ok("not_found")
    }

    /// A child whose session is already gone is a completed no-op (the TS
    /// `sessions.has` early return); every other close failure is kept and
    /// returned with the remaining children still closed - TS
    /// `closeChildSessions` walks all children and rethrows the first
    /// error.
    async fn close_children_inner(&self) -> Result<()> {
        let children = self.children.lock().await.clone();
        let mut close_error: Option<anyhow::Error> = None;
        for record in &children {
            {
                let mut record = record.lock().await;
                record.closed_by_parent = true;
                record.notice_delivered = true;
            }
            let active_session_id = record.lock().await.active_session_id.clone();
            if let Err(error) = self.kill_child(&active_session_id).await {
                if unknown_session(&error).is_some() {
                    // Already gone: TS `closeSessionOnce`'s `sessions.has`
                    // check turns a missing child into a no-op success.
                    self.children
                        .lock()
                        .await
                        .retain(|candidate| !Arc::ptr_eq(candidate, record));
                    continue;
                }
                close_error.get_or_insert(error);
                continue;
            }
            self.children
                .lock()
                .await
                .retain(|candidate| !Arc::ptr_eq(candidate, record));
        }
        match close_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// The one record matching a selector, or the TS selector errors
    /// (`No direct RLM {kind} matches ...` / `... is ambiguous ...`).
    async fn resolve_record(
        &self,
        target: &str,
        miss_kind: &str,
    ) -> Result<Arc<Mutex<ChildRecord>>> {
        let children = self.children.lock().await;
        let mut matches: Vec<Arc<Mutex<ChildRecord>>> = Vec::new();
        for record in children.iter() {
            if record.lock().await.matches(target) {
                matches.push(Arc::clone(record));
            }
        }
        match matches.len() {
            0 => bail!(
                "No direct RLM {miss_kind} matches \"{target}\" in the current parent session"
            ),
            1 => Ok(Arc::clone(matches.first().expect("one match"))),
            _ => bail!(
                "RLM {miss_kind} selector \"{target}\" is ambiguous in the current parent session"
            ),
        }
    }
}

/// Parsed ids of one created child session.
struct CreatedSessionIds {
    active_session_id: String,
    session_id: Option<String>,
    session_file: Option<String>,
    session_name: Option<String>,
}

struct CreatedChild {
    active_session_id: String,
    session_id: Option<String>,
    session_file: Option<String>,
    session_name: Option<String>,
    session_dir: String,
    summary_rlm_depth: Option<u64>,
}

impl CreatedChild {
    fn from_summary(summary: &Value, session_dir: &Path) -> Result<Self> {
        let ids = SupervisorChildSessionsInner::created_summary_ids(summary)?;
        Ok(Self {
            active_session_id: ids.active_session_id,
            session_id: ids.session_id,
            session_file: ids.session_file,
            session_name: ids.session_name,
            session_dir: session_dir.to_string_lossy().to_string(),
            summary_rlm_depth: summary.get("rlmDepth").and_then(Value::as_u64),
        })
    }
}

/// The already-gone marker inside a close failure (the supervisor's
/// `Unknown active session` route failure): TS `closeSessionOnce` treats a
/// missing child session as a completed no-op, so a close walking a child
/// that died earlier must not fail.
fn unknown_session(error: &anyhow::Error) -> Option<()> {
    error.chain().find_map(|cause| {
        cause
            .to_string()
            .starts_with("Unknown active session:")
            .then_some(())
    })
}

/// The plain text of a custom row's content (the notice turn's model
/// prompt); `None` for non-text content shapes.
fn custom_message_text(message: &pa_types::session::CustomMessage) -> Option<String> {
    match &message.content {
        pa_types::ai::UserContent::Text(text) => Some(text.clone()),
        _ => None,
    }
}

impl RlmSubagentHost for SupervisorChildSessions {
    fn spawn(&self, request: RlmSpawnRequest) -> RlmHostFuture<RlmSpawnHandle> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            let identity = this.identity.lock().expect("identity lock").clone();
            if identity.rlm_depth >= identity.rlm_max_depth {
                bail!(
                    "RLM recursion depth limit reached (RLM_DEPTH={}, RLM_MAX_DEPTH={})",
                    identity.rlm_depth,
                    identity.rlm_max_depth
                );
            }
            let child_id = format!("sub-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
            let name = request.name.clone().unwrap_or_else(|| {
                create_default_rlm_subagent_session_name(&request.prompt, &child_id)
            });
            this.assert_name_available(&name, identity.rlm_depth + 1)
                .await?;
            let model = resolve_child_model(
                &this.agent_dir,
                request.model.as_deref(),
                identity.model.as_deref(),
                "subagent",
            )?;
            assert_thinking_supported(&this.agent_dir, request.thinking.as_deref(), &model)?;
            let thinking = request.thinking.as_deref().or(identity.thinking.as_deref());
            let child_dir = this.child_session_dir(&child_id, &identity)?;
            let cwd = identity.cwd.clone().unwrap_or_else(|| "/".to_string());
            let runtime_metadata = json!({
                "kind": "subagent",
                "rlmChildId": child_id,
                "parentActiveSessionId": this.parent_active_session_id,
                "rlmDepth": identity.rlm_depth + 1,
                "createdAt": now_ms(),
            });
            let created = this
                .create_child(
                    &child_id,
                    Some(&name),
                    Some(&request.prompt),
                    identity.rlm_depth + 1,
                    &model,
                    thinking,
                    &cwd,
                    &child_dir,
                    Some(runtime_metadata),
                    &identity,
                )
                .await?;
            let record = ChildRecord {
                rlm_child_id: child_id.clone(),
                session_name: created.session_name.clone().unwrap_or_else(|| name.clone()),
                active_session_id: created.active_session_id.clone(),
                session_id: created.session_id,
                session_dir: created.session_dir.clone(),
                label: rlm_child_label(&request.prompt),
                started_at_ms: now_ms(),
                settled_status: None,
                answer_preview: None,
                answer_captured: false,
                replied_since_task: false,
                notice_delivered: false,
                prompt_admitted: false,
                error: None,
                closed_by_parent: false,
            };
            let record = Arc::new(Mutex::new(record));
            this.children.lock().await.push(Arc::clone(&record));
            // The task prompt runs detached from the spawn admission (TS
            // `void (async () => ...)`): the handle returns at registration
            // and the child's first turn starts after the parent's own
            // continuation request is in flight. The watcher starts once
            // the prompt is admitted (it idles on a pre-prompt child).
            let watcher_this = Arc::clone(&this);
            let watcher_record = Arc::clone(&record);
            let prompt = request.prompt.clone();
            let child_active_session_id = created.active_session_id.clone();
            // Capture the current turn boundary before detaching: spawn
            // admission happens mid-turn, so the parent's continuation
            // request (already issued for this turn's tool result) is
            // guaranteed to reach the provider first (see
            // `wait_turn_done`).
            let turn_generation = *this.turn_done.subscribe().borrow();
            tokio::spawn(async move {
                watcher_this.wait_turn_done(turn_generation).await;
                // The parent session closed before the prompt admitted (a
                // replacement teardown or a session close between the spawn
                // and the turn boundary): the child is closed with the
                // parent, so the detached task prompt never fires.
                if watcher_record.lock().await.closed_by_parent {
                    return;
                }
                watcher_record.lock().await.prompt_admitted = true;
                if let Err(error) = watcher_this
                    .prompt_child(&child_active_session_id, &prompt)
                    .await
                {
                    eprintln!(
                        "pa-daemon: RLM child task prompt failed for {child_active_session_id}: {error:#}"
                    );
                    let _ = watcher_this.kill_child(&child_active_session_id).await;
                    watcher_record.lock().await.settled_status = Some("error");
                    return;
                }
                watcher_this.watch_child_settle(&watcher_record).await;
            });
            Ok(RlmSpawnHandle {
                rlm_child_id: child_id,
                name,
                session_dir: created.session_dir,
                model,
            })
        })
    }

    fn create_session(
        &self,
        request: RlmCreateSessionRequest,
    ) -> RlmHostFuture<RlmCreateSessionHandle> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            let identity = this.identity.lock().expect("identity lock").clone();
            if identity.rlm_depth != 0 {
                bail!("rlm.create_session is available only from a depth-0 session");
            }
            let model = resolve_child_model(
                &this.agent_dir,
                request.model.as_deref(),
                identity.model.as_deref(),
                "top-level session",
            )?;
            assert_thinking_supported(&this.agent_dir, request.thinking.as_deref(), &model)?;
            // A depth-0 resident session is created exactly like a client
            // `create`: the shared sessions dir and the requested cwd
            // (TS `resolve(this._cwd, rawCwd)`), no per-child artifacts dir.
            let cwd = match &request.cwd {
                Some(cwd) if Path::new(cwd).is_absolute() => PathBuf::from(cwd),
                Some(cwd) => Path::new(identity.cwd.as_deref().unwrap_or("/")).join(cwd),
                None => PathBuf::from(identity.cwd.clone().unwrap_or_else(|| "/".to_string())),
            };
            let sessions_dir = crate::paths::sessions_dir(&this.agent_dir)?;
            std::fs::create_dir_all(&sessions_dir)
                .with_context(|| format!("create sessions dir {}", sessions_dir.display()))?;
            let thinking = request.thinking.as_deref().or(identity.thinking.as_deref());
            let created = this
                .launch_child(
                    "root",
                    request.name.as_deref(),
                    &request.prompt,
                    0,
                    &model,
                    thinking,
                    &cwd.to_string_lossy(),
                    &sessions_dir,
                    None,
                    &identity,
                )
                .await?;
            // The TS create-path summary validation: a resident depth-0
            // session must never report another depth.
            if created.summary_rlm_depth.is_some_and(|depth| depth != 0) {
                bail!("Daemon supervisor returned an invalid depth-0 session summary");
            }
            Ok(RlmCreateSessionHandle {
                active_session_id: created.active_session_id.clone(),
                session_id: created
                    .session_id
                    .clone()
                    .unwrap_or_else(|| created.active_session_id.clone()),
                name: created
                    .session_name
                    .clone()
                    .unwrap_or_else(|| created.active_session_id.clone()),
                session_file: created.session_file.unwrap_or_default(),
                model,
            })
        })
    }

    fn list_subagents(&self) -> RlmHostFuture<Vec<RlmSubagentEntry>> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            let records = this.children.lock().await.clone();
            let mut entries = Vec::with_capacity(records.len());
            for record in &records {
                // The settle watcher owns worker refreshes. A roster read is a
                // snapshot and must not queue behind a long supervisor request.
                let record = record.lock().await;
                entries.push(SupervisorChildSessions::entry(&record));
            }
            Ok(entries)
        })
    }

    fn delete_subagent(&self, target: String) -> RlmHostFuture<RlmDeleteSubagentResult> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            // Selector errors surface unwrapped (TS parity: the
            // `No direct RLM subagent matches ...` message is the product
            // surface); only the kill below gets a delete context.
            let record = this.resolve_record(&target, "subagent").await?;
            let active_session_id = record.lock().await.active_session_id.clone();
            // Kill first: a failed kill keeps the child tracked so the caller
            // can retry; a successful kill removes it from the registry.
            // The `rlmLedgerDelete` marker tells the supervisor this kill
            // is a delete (a plain stop must not tombstone the child).
            let record_guard = record.lock().await;
            let command = DaemonCommand::Kill {
                id: None,
                active_session_id: active_session_id.clone(),
                rest: serde_json::Map::from_iter([
                    ("rlmLedgerDelete".to_string(), json!("user")),
                    ("rlmChildId".to_string(), json!(record_guard.rlm_child_id)),
                ]),
            };
            drop(record_guard);
            let was_running = record.lock().await.settled_status.is_none();
            this.command(&command, KILL_TIMEOUT_MS)
                .await
                .with_context(|| format!("kill RLM child \"{target}\""))?;
            let entry = {
                let record = record.lock().await;
                SupervisorChildSessions::entry(&record)
            };
            // A still-running child was cut short by the delete: the parent
            // session receives the cancelled terminal notice (TS
            // `completeDeletion`, reason `Deleted by parent orchestrator`).
            // The settle watcher stops silently once the record leaves the
            // registry, so the delete path owns this notice.
            if was_running {
                let notice = {
                    let mut record = record.lock().await;
                    let claimed = !record.notice_delivered;
                    record.notice_delivered = true;
                    claimed.then(|| RlmChildTerminalNotice::Cancelled {
                        child_id: record.rlm_child_id.clone(),
                        session_name: record.session_name.clone(),
                        reason: Some("Deleted by parent orchestrator".to_string()),
                    })
                };
                if let Some(notice) = notice {
                    this.deliver_terminal_notice(&notice).await;
                }
            }
            this.children
                .lock()
                .await
                .retain(|candidate| !Arc::ptr_eq(candidate, &record));
            Ok(RlmDeleteSubagentResult {
                subagent: entry,
                outcome: Some("deleted"),
            })
        })
    }

    fn collect(&self, targets: Vec<String>, timeout_ms: u64) -> RlmHostFuture<Vec<RlmChildResult>> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            // Resolve targets outside the registry lock: `resolve_record`
            // takes it too, and the tokio mutex is not re-entrant.
            let records = if targets.is_empty() {
                this.children.lock().await.clone()
            } else {
                let mut records = Vec::with_capacity(targets.len());
                for target in &targets {
                    records.push(this.resolve_record(target, "child").await?);
                }
                records
            };
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            let mut results = Vec::with_capacity(records.len());
            for record in &records {
                this.refresh_record(record).await;
                let still_running = record.lock().await.settled_status.is_none();
                if still_running {
                    // Wait inside the shared budget, then re-read the child:
                    // a timeout yields the current snapshot, never an error.
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let active_session_id = record.lock().await.active_session_id.clone();
                    this.wait_for_child(&active_session_id, remaining).await;
                    this.refresh_record(record).await;
                }
                let result = {
                    let record = record.lock().await;
                    SupervisorChildSessions::collect_result(&record)
                };
                results.push(result);
            }
            Ok(results)
        })
    }
}

#[cfg(test)]
mod watch_tests {
    use super::*;
    use crate::protocol::{response_failure, response_success};
    use pa_types::platform::transport::bind_transport;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::mpsc;

    /// A scripted JSONL supervisor for the watcher tests: creates one child
    /// session, reports it idle with a final answer, and captures the
    /// `follow_up` commands routed to the parent (the terminal-notice
    /// deliveries). `idle_delay_ms` paces `wait_for_idle` so a test can act
    /// while the child is still "running".
    /// How the fake supervisor answers a child `kill`.
    enum FakeKill {
        Success,
        /// The child session is gone (the route failure a supervisor
        /// answers for a non-resident child).
        UnknownSession,
        /// The kill fails for a real reason (a stuck worker).
        Failure,
    }

    async fn spawn_fake_supervisor(
        socket: std::path::PathBuf,
        follow_up_tx: mpsc::UnboundedSender<Value>,
        idle_delay_ms: u64,
        kill_tx: mpsc::UnboundedSender<Value>,
        kill_behavior: FakeKill,
    ) {
        let kill_behavior = std::sync::Arc::new(kill_behavior);
        let listener = bind_transport(&socket).await.unwrap();
        tokio::spawn(async move {
            loop {
                let Ok(stream) = listener.accept().await else {
                    return;
                };
                let follow_up_tx = follow_up_tx.clone();
                let kill_tx = kill_tx.clone();
                let kill_behavior = std::sync::Arc::clone(&kill_behavior);
                tokio::spawn(async move {
                    let (reader, mut writer) = stream.split();
                    let mut reader = BufReader::new(reader);
                    writer
                        .write_all(
                            b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                        )
                        .await
                        .unwrap();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap() == 0 {
                            return;
                        }
                        let value: Value = serde_json::from_str(line.trim()).unwrap();
                        let id = value["id"].as_str().unwrap_or_default().to_string();
                        let command = value["command"].clone();
                        let command_type: &str = command["type"].as_str().unwrap_or_default();
                        let response = match command_type {
                            "create" => response_success(
                                Some(&id),
                                command_type,
                                Some(json!({
                                    "activeSessionId": "child-live",
                                    "sessionId": "child-file",
                                    "sessionFile": "/tmp/child.jsonl",
                                    "sessionName": "f20-worker",
                                })),
                            ),
                            "prompt" => response_success(Some(&id), command_type, None),
                            "wait_for_idle" => {
                                tokio::time::sleep(std::time::Duration::from_millis(idle_delay_ms))
                                    .await;
                                response_success(Some(&id), command_type, None)
                            }
                            "get_state" => response_success(
                                Some(&id),
                                command_type,
                                Some(json!({
                                    "isStreaming": false,
                                    "sessionActions": { "queuedCount": 0 },
                                })),
                            ),
                            "get_last_assistant_text" => response_success(
                                Some(&id),
                                command_type,
                                Some(json!({ "text": "the child final answer" })),
                            ),
                            "kill" => {
                                let _ = kill_tx.send(command.clone());
                                match *kill_behavior {
                                    FakeKill::Success => {
                                        response_success(Some(&id), command_type, None)
                                    }
                                    FakeKill::UnknownSession => response_failure(
                                        Some(&id),
                                        command_type,
                                        "Unknown active session: child-live",
                                        None,
                                    ),
                                    FakeKill::Failure => response_failure(
                                        Some(&id),
                                        command_type,
                                        "kill refused by the fake supervisor",
                                        None,
                                    ),
                                }
                            }
                            "follow_up" => {
                                let _ = follow_up_tx.send(command.clone());
                                response_success(
                                    Some(&id),
                                    command_type,
                                    Some(json!({ "queued": true })),
                                )
                            }
                            other => response_failure(Some(&id), other, "unexpected command", None),
                        };
                        let mut line = serde_json::to_string(&response).unwrap();
                        line.push('\n');
                        if writer.write_all(line.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
    }

    async fn sessions_with_fake_supervisor(
        follow_up_tx: mpsc::UnboundedSender<Value>,
        idle_delay_ms: u64,
        kill_behavior: FakeKill,
    ) -> (SupervisorChildSessions, mpsc::UnboundedReceiver<Value>) {
        let socket = std::env::temp_dir().join(format!(
            "pa-rlm-watch-{}.sock",
            uuid::Uuid::new_v4().simple()
        ));
        let (kill_tx, kill_rx) = mpsc::unbounded_channel();
        spawn_fake_supervisor(
            socket.clone(),
            follow_up_tx,
            idle_delay_ms,
            kill_tx,
            kill_behavior,
        )
        .await;
        let link = Arc::new(crate::supervisor_link::SupervisorLink::new(socket));
        let sessions =
            SupervisorChildSessions::new(link, std::env::temp_dir(), "parent-live".to_string());
        // A live parent carries its resolved model on the identity; the
        // spawn path resolves the child's model from it.
        sessions.set_identity(ParentIdentity {
            model: Some("mock/mock-1".to_string()),
            cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
            ..ParentIdentity::with_default_depth()
        });
        (sessions, kill_rx)
    }

    async fn spawn_child(sessions: &SupervisorChildSessions) -> RlmSpawnHandle {
        sessions
            .spawn(RlmSpawnRequest {
                prompt: "f20 child task".to_string(),
                name: Some("f20-worker".to_string()),
                model: None,
                thinking: None,
                cell_source_code: None,
            })
            .await
            .expect("spawn must succeed against the fake supervisor")
    }

    #[tokio::test]
    async fn roster_snapshot_does_not_wait_for_a_slow_child_worker() {
        let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
        let (sessions, _kill_rx) =
            sessions_with_fake_supervisor(follow_up_tx, 1_000, FakeKill::Success).await;
        sessions
            .push_test_child(RlmChildIdentity {
                rlm_child_id: "child-id".to_string(),
                active_session_id: "child-live".to_string(),
                session_id: Some("child-file".to_string()),
                session_name: "slow-child".to_string(),
            })
            .await;
        let roster = tokio::time::timeout(Duration::from_millis(10), sessions.list_subagents())
            .await
            .expect("roster must not make a supervisor round trip")
            .expect("roster snapshot");
        assert_eq!(roster.len(), 1);
        assert_eq!(roster[0].status, "running");
    }

    /// A child that settles without replying delivers the no-reply terminal
    /// notice to the parent session as an injected follow-up turn.
    #[tokio::test]
    async fn a_settled_child_without_a_reply_delivers_the_terminal_notice() {
        let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
        let (sessions, _kill_rx) =
            sessions_with_fake_supervisor(follow_up_tx, 0, FakeKill::Success).await;
        let handle = spawn_child(&sessions).await;
        // The worker releases the detached prompt at its turn boundary.
        sessions.notify_turn_done();

        let follow_up =
            tokio::time::timeout(std::time::Duration::from_secs(10), follow_up_rx.recv())
                .await
                .expect("the watcher must deliver the notice")
                .expect("the follow_up channel stays open");
        assert_eq!(follow_up["type"], "follow_up");
        assert_eq!(follow_up["activeSessionId"], "parent-live");
        let custom = &follow_up["customMessage"];
        assert_eq!(custom["role"], "custom");
        assert_eq!(custom["customType"], "rlm_child_terminal_notice");
        assert_eq!(
            custom["content"],
            "[child-exited: no-reply child:f20-worker]\n\nLast assistant text: the child final answer"
        );
        assert_eq!(custom["details"]["childId"], handle.rlm_child_id);
        assert_eq!(custom["details"]["sessionName"], "f20-worker");
        // Exactly one notice lands: the watcher delivers once.
        let extra =
            tokio::time::timeout(std::time::Duration::from_millis(300), follow_up_rx.recv()).await;
        assert!(extra.is_err(), "no second notice may arrive");
    }

    /// One child row exists and is running before the close tests run.
    async fn one_running_child(sessions: &SupervisorChildSessions) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let entries = sessions.list_subagents().await.expect("child roster");
            if let Some(row) = entries.first() {
                assert_eq!(row.status, "running");
                return;
            }
            assert!(Instant::now() < deadline, "child row never appeared");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// `close_children` (TS `closeChildSessions` at the replacement
    /// teardown / session close): every tracked child is stopped through
    /// the supervisor - a plain stop, no delete marker, so the ledger edge
    /// and passive roster row survive - the registry empties, and no
    /// terminal notice is owed to the closing parent session.
    #[tokio::test]
    async fn close_children_stops_the_child_and_clears_the_roster() {
        let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
        // A long idle keeps the child mid-run while the close fires, so the
        // settle watcher is parked instead of raced.
        let (sessions, mut kill_rx) =
            sessions_with_fake_supervisor(follow_up_tx, 10_000, FakeKill::Success).await;
        spawn_child(&sessions).await;
        sessions.notify_turn_done();
        one_running_child(&sessions).await;

        sessions.close_children().await.expect("close children");

        // The stop carried no delete marker: the spawn edge survives (TS
        // `closeSessionOnce` archives; only `recordRlmSubagentDeletion`
        // tombstones).
        let kill = kill_rx
            .recv()
            .await
            .expect("the close must stop the child through the supervisor");
        assert_eq!(kill["type"], "kill");
        assert!(
            !kill.to_string().contains("rlmLedgerDelete"),
            "the replacement close is a stop, not a delete"
        );
        // The registry the replacement session reads starts empty.
        let entries = sessions.list_subagents().await.expect("child roster");
        assert!(
            entries.is_empty(),
            "the closed child stays listed: {entries:?}"
        );
        // No terminal notice is delivered to the closing parent session.
        let extra = tokio::time::timeout(Duration::from_millis(300), follow_up_rx.recv()).await;
        assert!(extra.is_err(), "a closed child must not deliver a notice");
    }

    /// A child whose session is already gone is a completed no-op (the TS
    /// `sessions.has` early return in `closeSessionOnce`), not a close
    /// failure: the registry drops it and the close succeeds.
    #[tokio::test]
    async fn close_children_treats_an_already_gone_child_as_a_no_op() {
        let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
        let (sessions, _kill_rx) =
            sessions_with_fake_supervisor(follow_up_tx, 10_000, FakeKill::UnknownSession).await;
        spawn_child(&sessions).await;
        sessions.notify_turn_done();
        one_running_child(&sessions).await;

        sessions
            .close_children()
            .await
            .expect("an already-gone child must not fail the close");

        let entries = sessions.list_subagents().await.expect("child roster");
        assert!(
            entries.is_empty(),
            "the gone child stays listed: {entries:?}"
        );
    }

    /// A real close failure propagates and keeps the child tracked, so the
    /// caller (the replacement teardown) fails exactly like TS
    /// `teardownForReplacement` rethrowing `disposeHostedSubagentRuntimes`.
    #[tokio::test]
    async fn close_children_keeps_a_failed_child_tracked() {
        let (follow_up_tx, _follow_up_rx) = mpsc::unbounded_channel();
        let (sessions, _kill_rx) =
            sessions_with_fake_supervisor(follow_up_tx, 10_000, FakeKill::Failure).await;
        spawn_child(&sessions).await;
        sessions.notify_turn_done();
        one_running_child(&sessions).await;

        let error = sessions
            .close_children()
            .await
            .expect_err("a real close failure must propagate");
        assert!(
            format!("{error:#}").contains("kill refused"),
            "the close error must surface the kill failure: {error:#}"
        );

        let entries = sessions.list_subagents().await.expect("child roster");
        assert_eq!(entries.len(), 1, "the failed child stays tracked for retry");
    }

    /// A child that sent an agent message back gets no terminal notice: the
    /// reply is the parent's report (TS `_parentReplyCount`).
    #[tokio::test]
    async fn a_replied_child_gets_no_terminal_notice() {
        let (follow_up_tx, mut follow_up_rx) = mpsc::unbounded_channel();
        // A slow idle wait keeps the child "running" while the test marks
        // the reply.
        let (sessions, _kill_rx) =
            sessions_with_fake_supervisor(follow_up_tx, 250, FakeKill::Success).await;
        let handle = spawn_child(&sessions).await;
        assert!(!handle.rlm_child_id.is_empty());
        sessions.mark_replied("child-live").await;
        // The worker releases the detached prompt at its turn boundary.
        sessions.notify_turn_done();

        let extra =
            tokio::time::timeout(std::time::Duration::from_secs(2), follow_up_rx.recv()).await;
        assert!(extra.is_err(), "a replied child must not deliver a notice");
    }
}
