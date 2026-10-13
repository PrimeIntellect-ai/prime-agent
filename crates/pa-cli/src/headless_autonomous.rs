//! The autonomous run state for headless print/json runs — the verifier and
//! eval composition surface. After every settled turn the [`ShellAutonomousDriver`]
//! runs the gate commands in the session cwd (the #98 seams, unmodified); the
//! continuation rides the natural-turn-end hook ([`crate::print_autonomous`]),
//! a stop surfaces only through the exit code and its stderr line.

use std::path::PathBuf;
use std::sync::Arc;

use pa_core::autonomous::{
    autonomous_limit_reason, autonomous_status, create_autonomous_runtime_state,
    describe_autonomous_limit, latest_autonomous_gate_attempt, now_millis, AgentAutonomousConfig,
    AutonomousDriver, AutonomousFollowUp, AutonomousRuntimeState, ShellAutonomousDriver,
};
use pa_core::session_engine::engine::SessionEngine;
use pa_core::session_engine::provider_adapter::json_round_trip;
use pa_types::ai::Model;
use pa_types::session::CustomMessage;

use crate::args::AutonomousConfig;

/// The autonomous runtime config from the typed CLI flags: any
/// autonomous flag enables the run.
pub fn autonomous_runtime_config(config: &AutonomousConfig) -> AgentAutonomousConfig {
    AgentAutonomousConfig {
        enabled: Some(true),
        max_continuations: config.max_continuations.map(u64::from),
        max_turns: config.max_turns.map(u64::from),
        max_tokens: config.max_tokens,
        timeout_ms: config.timeout_ms,
        continuation_prompt: None,
        gates: config
            .gates
            .as_ref()
            .map(|gates| pa_core::autonomous::AgentAutonomousGateConfig {
                commands: Some(gates.commands.clone()),
                max_retries: gates.max_retries.map(u64::from),
                timeout_ms: gates.timeout_ms,
            }),
        subagent_keep_alive_ms: None,
    }
}

/// One headless autonomous run: the runtime state plus the shell-gate driver.
pub struct HeadlessAutonomous {
    state: Arc<tokio::sync::Mutex<AutonomousRuntimeState>>,
    driver: ShellAutonomousDriver,
    /// The continuation the threshold arm minted ahead of its compaction,
    /// held for the settled boundary's queued `followUp` admission.
    held: tokio::sync::Mutex<Option<String>>,
    /// A continuation is held behind unsettled inline-subagent work (TS
    /// `_holdAutonomousContinuationForRlmWork`): the flag only — the
    /// decision and its count happen at the post-settle delivery.
    awaits_rlm_work: std::sync::atomic::AtomicBool,
}

impl HeadlessAutonomous {
    /// Build the run from the CLI flags; the gates run in the session cwd.
    pub fn from_cli(config: &AutonomousConfig, cwd: impl Into<PathBuf>) -> Self {
        let runtime_config = autonomous_runtime_config(config);
        let state = create_autonomous_runtime_state(Some(&runtime_config), None);
        Self::from_state(state, cwd)
    }

    /// The session's default run: a print run without CLI flags starts
    /// disabled, and `/autonomous on` rewrites it live.
    pub fn disabled(cwd: impl Into<PathBuf>) -> Self {
        let state = create_autonomous_runtime_state(None, None);
        Self::from_state(state, cwd)
    }

    fn from_state(state: AutonomousRuntimeState, cwd: impl Into<PathBuf>) -> Self {
        Self {
            state: Arc::new(tokio::sync::Mutex::new(state)),
            driver: ShellAutonomousDriver::new(cwd),
            held: tokio::sync::Mutex::new(None),
            awaits_rlm_work: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// The runtime state handle (the session-command executor mutates the
    /// same state the accounting subscription and the drive loop read).
    pub(crate) fn state_handle(&self) -> Arc<tokio::sync::Mutex<AutonomousRuntimeState>> {
        Arc::clone(&self.state)
    }

    /// Per-message usage accounting: every settled assistant message forwards to
    /// the driver as it arrives (the daemon worker runs the same policy).
    pub async fn wire_accounting(
        &self,
        agent: &Arc<pa_agent::agent::Agent>,
    ) -> pa_agent::agent::Subscription {
        let state = Arc::clone(&self.state);
        let driver = self.driver.clone();
        agent
            .subscribe(move |event, _signal| {
                let state = Arc::clone(&state);
                let driver = driver.clone();
                Box::pin(async move {
                    if let pa_agent::types::AgentEvent::MessageEnd {
                        message:
                            pa_agent::types::AgentMessage::Standard(
                                pa_agent::types::Message::Assistant(assistant),
                            ),
                    } = &event
                    {
                        if let Some(message) =
                            json_round_trip::<_, pa_types::ai::AssistantMessage>(assistant)
                        {
                            let mut state = state.lock().await;
                            driver.account_message(&mut state, &message);
                        }
                    }
                    Ok(())
                })
            })
            .await
    }

    /// The in-run continuation decision for one settled turn: the driver decides,
    /// `Continue` returns the text, a stop (or inactive mode) ends the loop.
    pub(crate) async fn follow_up_text(
        &self,
        message: &pa_agent::types::AssistantMessage,
    ) -> Option<String> {
        let message = json_round_trip::<_, pa_types::ai::AssistantMessage>(message)?;
        let follow_up = {
            let mut state = self.state.lock().await;
            self.driver.after_turn(&mut state, &message).await
        };
        match follow_up {
            AutonomousFollowUp::Continue { text } => Some(text),
            AutonomousFollowUp::Inactive | AutonomousFollowUp::Stop { .. } => None,
        }
    }

    /// Hold the continuation the threshold arm minted ahead of its compaction; the
    /// boundary compacts at the settled turn, then `drive_boundary` admits it.
    pub(crate) async fn hold_threshold_continuation(&self, text: String) {
        *self.held.lock().await = Some(text);
    }

    /// Hold the continuation while inline-subagent work settles (TS
    /// `_holdAutonomousContinuationForRlmWork`): nothing is spent on the
    /// pre-settle turn — a disabled mode or a spent run holds nothing, so
    /// the normal mint applies their stop. Returns whether the hold owns
    /// the boundary (the hook mints no row).
    pub(crate) async fn hold_rlm_continuation(&self) -> bool {
        let state = self.state.lock().await;
        if !state.enabled || autonomous_limit_reason(&state, now_millis()).is_some() {
            return false;
        }
        self.awaits_rlm_work
            .store(true, std::sync::atomic::Ordering::SeqCst);
        true
    }

    /// The RLM settle site (the daemon's `autonomous_children_settled`):
    /// deliver the held continuation once the descendants settled —
    /// decided fresh from the latest settled turn and counted at the
    /// delivery, dropped behind a goal that owns the wake-up. Returns
    /// whether a held flag was consumed.
    pub(crate) async fn deliver_rlm_continuation(
        &self,
        engine: &SessionEngine,
        boundary: &mut crate::print_boundary::TurnBoundary,
        model: &Model,
        api_key: Option<String>,
        global_harness_dir: PathBuf,
    ) -> Result<bool, String> {
        if !self
            .awaits_rlm_work
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(false);
        }
        // An active goal's own continuation loop owns the wake-up: the
        // held turn is dropped behind it.
        if engine.goal_owns_continuation_wakeup().await {
            return Ok(true);
        }
        let Some(message) = engine.latest_settled_assistant().await else {
            return Ok(true);
        };
        if let Some(text) = self.follow_up_text(&message).await {
            boundary
                .admit_continuation(engine, model, api_key, &text, global_harness_dir)
                .await?;
        }
        Ok(true)
    }

    /// The settled boundary's autonomous drain: each held continuation runs as
    /// this invocation's follow-up turn; a re-crossing threshold holds the
    /// next. Returns whether any turn ran.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn drive_boundary(
        &self,
        engine: &SessionEngine,
        boundary: &mut crate::print_boundary::TurnBoundary,
        model: &Model,
        api_key: Option<String>,
        global_harness_dir: PathBuf,
    ) -> Result<bool, String> {
        let mut ran = false;
        while let Some(text) = self.held.lock().await.take() {
            boundary
                .admit_continuation(
                    engine,
                    model,
                    api_key.clone(),
                    &text,
                    global_harness_dir.clone(),
                )
                .await?;
            ran = true;
        }
        Ok(ran)
    }

    /// The print-mode exit contract: stderr text when the run must exit
    /// non-zero — a configured gate still failing (after its retry window or
    /// an autonomous limit), or an ungated run stopping before terminal
    /// evidence.
    pub async fn exit_stderr(&self) -> Option<String> {
        let state = self.state.lock().await;
        let status = autonomous_status(&state);
        let now = now_millis();
        let limit = autonomous_limit_reason(&state, now);
        if let Some(failure) = status
            .last_gate_failure
            .as_ref()
            .filter(|_| status.enabled && !status.gates.commands.is_empty())
        {
            let limit_text = limit
                .map(|reason| {
                    format!(
                        "; autonomous limit reached: {}",
                        describe_autonomous_limit(&status, reason, now)
                    )
                })
                .unwrap_or_default();
            return Some(format!(
                "Autonomous quality gate still failing after attempt {}/{}: {}{}",
                latest_autonomous_gate_attempt(&status),
                status.gates.max_retries,
                failure.exit_text,
                limit_text
            ));
        }
        if status.enabled && status.gates.commands.is_empty() {
            if let Some(reason) = limit {
                return Some(format!(
                    "Autonomous run stopped before terminal evidence; {}",
                    describe_autonomous_limit(&status, reason, now)
                ));
            }
        }
        None
    }
}

async fn latest_assistant(engine: &SessionEngine) -> Option<pa_types::ai::AssistantMessage> {
    let state = engine.session.agent().state().await;
    state
        .messages
        .iter()
        .rev()
        .find_map(|message| match message {
            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(
                assistant,
            )) => json_round_trip(assistant),
            _ => None,
        })
}

/// The latest settled assistant message's error text, when the loop's terminal
/// state is a failed model request.
pub(crate) async fn latest_assistant_error(engine: &SessionEngine) -> Option<Option<String>> {
    latest_assistant(engine).await.and_then(|message| {
        (message.stop_reason == pa_types::ai::StopReason::Error)
            .then(|| message.error_message.clone())
    })
}

/// The wire shape of one durable custom row for the json event stream: the
/// custom message in the shared message wire form.
pub fn custom_row_wire_value(row: &CustomMessage) -> serde_json::Value {
    serde_json::to_value(pa_types::session::AgentMessage::Custom(row.clone()))
        .unwrap_or(serde_json::Value::Null)
}
