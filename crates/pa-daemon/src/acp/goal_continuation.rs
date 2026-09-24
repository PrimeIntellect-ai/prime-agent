//! The direct-ACP goal continuation boundary: the goal arms of the
//! settled-turn loop on the in-process ACP transport.
//!
//! TS ruling (the #244 direct-ACP gap, read off agent-session.ts,
//! agent-loop.ts, and in-process-agent-connection.ts): the TS ACP mode
//! hosts the goal continuation loop — not as a mode-level construct, but
//! inside the session's own turn run. `AgentSession` installs
//! `agent.getContinuationMessages` (`_installAgentContinuationHook`), the
//! agent loop consults the hook at its natural turn end (`runLoop`), and
//! the in-process `promptAndWait` runs that loop directly, so the direct
//! ACP path drives every continuation INSIDE the one `session/prompt`
//! request: continuation turns surface as events of the same prompt turn,
//! and the response settles only after the goal run ends (complete /
//! paused / budget_limited / error, or genuinely nothing more to do). The
//! daemon-attached transport rides the worker's queue (the #244 lane);
//! this module is the in-process counterpart: the prompt turn's settle
//! loop consults the same arms at each settled boundary.
//!
//! Arms ported per settled boundary (TS `_shouldStopAfterTurn`'s goal arms
//! plus `_getContinuationMessages`'s goal arm, which takes exclusive
//! priority over the autonomous arm):
//! - the budget-limit wrap-up steer: the turn that crossed the goal's
//!   token budget runs the budget-limit context as the next turn (TS
//!   `_accountGoalUsageForAssistantMessage` arming the steer),
//! - the natural continuation mint (TS `_getGoalContinuationMessages`):
//!   an active goal mints one goal-context turn per settled boundary.
//!
//! Two TS gates hold trivially on this surface: the RLM quiescence
//! deferral (`_hasUnsettledRlmQuiescenceWork` — the in-process engine
//! runs with `NoRlmChildren`, so no descendant work can exist) and the
//! queued-input deferral (`queuedActionCount > 0` — the ACP connection
//! admits one prompt turn at a time, so no session input can queue behind
//! the running turn). Neither mint therefore defers or rolls back here.

use pa_core::goals::{create_goal_context_message, GoalContextKind, GoalStatus};
use pa_types::session::CustomMessage;

use super::session::AcpSession;
use super::AcpModeState;

/// The goal boundary's decision for the settle loop: one minted turn to
/// run as the next turn of the same prompt, or nothing (the boundary
/// proceeds to the autonomous arm).
pub(super) enum GoalFollowUp {
    None,
    /// Boxed: the message's insertion-ordered JSON maps (preserve_order,
    /// wire parity) would dwarf the empty variant (`large_enum_variant`).
    Turn(Box<CustomMessage>),
}

/// Mint one goal continuation and announce it (the shared
/// `continuationsUsed` bump publishes before the continuation turn
/// starts, mirroring the TS `_setGoalState` -> `_emitGoalUpdate` at every
/// mint site). `None` when the goal cannot mint (inactive, or no
/// objective); the caller decides what that means at its own site.
pub(super) async fn mint_goal_continuation(
    mode: &AcpModeState,
    session: &AcpSession,
) -> Option<CustomMessage> {
    let persistence = mode.engine.session.shared_persistence();
    let mut driver = mode.engine.goal_driver.lock().await;
    if !driver.owns_continuation_wakeup() {
        return None;
    }
    let mut persistence = persistence.lock().await;
    let message = match driver.next_continuation_message(&mut persistence) {
        Ok(message) => message,
        Err(error) => {
            // TS `_getGoalContinuationMessages`'s catch arm: a failed
            // persist fails the goal with the write error and mints
            // nothing (the settle hook must not reject).
            let error_text = format!("{error:#}");
            eprintln!("pa-daemon: goal continuation mint persist failed: {error_text}");
            if let Err(finish_error) = driver.finish_for_terminal_message(
                &mut persistence,
                pa_types::ai::StopReason::Error,
                Some(&error_text),
            ) {
                eprintln!("pa-daemon: goal error finish also failed: {finish_error:#}");
            }
            drop(driver);
            session.publish_goal_update().await;
            return None;
        }
    };
    drop(driver);
    session.publish_goal_update().await;
    message
}

/// The goal boundary consult for the settle loop: the budget steer runs
/// first (TS `_shouldStopAfterTurn` precedes the continuation hook), then
/// the natural mint (TS `_getGoalContinuationMessages`). The budget
/// crossing is the settle loop's read of the usage listener's flag; a
/// false alarm (the goal since completed or cleared) falls through to the
/// natural mint.
pub(super) async fn goal_follow_up(mode: &AcpModeState, session: &AcpSession) -> GoalFollowUp {
    if session.take_goal_budget_crossed() {
        let steer = {
            let driver = mode.engine.goal_driver.lock().await;
            let state = driver.state();
            match state.status {
                GoalStatus::BudgetLimited => {
                    create_goal_context_message(state, GoalContextKind::BudgetLimit).ok()
                }
                _ => None,
            }
        };
        if let Some(message) = steer {
            return GoalFollowUp::Turn(Box::new(message));
        }
    }
    match mint_goal_continuation(mode, session).await {
        Some(message) => GoalFollowUp::Turn(Box::new(message)),
        None => GoalFollowUp::None,
    }
}

/// Withdraw a threshold-queue mint whose compaction was cancelled (TS
/// `_clearQueuedGoalContinuationAfterCancelledThresholdCompaction`): the
/// slot rolls back so the next natural stop re-mints without
/// double-counting.
pub(super) async fn rollback_goal_mint(mode: &AcpModeState) {
    let persistence = mode.engine.session.shared_persistence();
    let mut driver = mode.engine.goal_driver.lock().await;
    let mut persistence = persistence.lock().await;
    if let Err(error) = driver.rollback_continuation_mint(&mut persistence) {
        // The restore hook must not reject: warn and keep the slot as-is.
        eprintln!("pa-daemon: goal mint rollback persist failed: {error:#}");
    }
}

/// TS `_finishGoalForTerminalAssistantMessage` for a failed run: an
/// error assistant message fails an active goal (an abort keeps it). The
/// state change announces through the shared goal-update channel.
pub(super) async fn fail_goal_for_terminal_error(
    mode: &AcpModeState,
    session: &AcpSession,
    error_message: Option<&str>,
) {
    let persistence = mode.engine.session.shared_persistence();
    let mut driver = mode.engine.goal_driver.lock().await;
    let mut persistence = persistence.lock().await;
    if let Err(error) = driver.finish_for_terminal_message(
        &mut persistence,
        pa_types::ai::StopReason::Error,
        error_message,
    ) {
        // The terminal hook is best-effort (TS's throws out of the
        // agent-end handler): the failed turn already carries the error.
        eprintln!("pa-daemon: goal terminal finish persist failed: {error:#}");
    }
    drop(driver);
    session.publish_goal_update().await;
}

#[cfg(test)]
// The faux provider registry is process-global and shared across the
// daemon engine tests: the std lock serializes every test that drives it,
// and the async tests here hold it across their awaits on purpose (the
// tests are the only contenders, so no cross-task deadlock).
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;
    use crate::agent_engine::FAUX_TEST_LOCK;

    /// The faux model's per-request output budget (maxTokens 16_384 under the
    /// 32_000 request cap): threshold fixtures subtract it from the window
    /// alongside the headroom (the combined input+output ceiling).
    const FAUX_REQUEST_BUDGET: u64 = 16_384;

    use pa_core::session::manager::SessionManager;
    use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
    use pa_core::session_engine::provider_adapter::{json_round_trip, real_stream_fn};
    use serde_json::json;
    use tokio::sync::{mpsc, Mutex};

    use super::super::producer::UpdateProducer;
    use super::super::prompt::handle_session_prompt;
    use super::super::{ConnectionState, SessionEntry};

    /// The ACP meta namespace on the wire.
    const META: &str = "ai.primeintellect.prime-agent";

    /// One armed ACP prompt turn over an in-process faux engine whose
    /// session is persisted (the CLI-built ACP engine shape).
    struct AcpGoalBed {
        mode: AcpModeState,
        state: std::sync::Arc<Mutex<ConnectionState>>,
        session_id: String,
        tx: super::super::producer::FrameSink,
        frames: mpsc::UnboundedReceiver<serde_json::Value>,
        next_request_id: u64,
        pending_id: Option<serde_json::Value>,
        engine: std::sync::Arc<pa_core::session_engine::engine::SessionEngine>,
        /// Held so the engine's cwd outlives the test.
        _dir: tempfile::TempDir,
    }

    impl AcpGoalBed {
        /// Build the bed: a faux engine with compaction enabled over the
        /// given reserve (the harness contract), one hosted session.
        async fn new(script: serde_json::Value, reserve_tokens: u64) -> AcpGoalBed {
            let dir = tempfile::TempDir::new().unwrap();
            let agent_dir = dir.path().join("agent");
            std::fs::create_dir_all(&agent_dir).unwrap();
            std::fs::write(
                agent_dir.join("settings.json"),
                json!({
                    "compaction": {
                        "enabled": true,
                        "reserveTokens": reserve_tokens,
                        "keepRecentTokens": 10,
                    }
                })
                .to_string(),
            )
            .unwrap();
            let parsed = pa_ai::faux::script::parse_faux_script(&script)
                .map_err(anyhow::Error::msg)
                .unwrap();
            let registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
            let model = registration.get_model();
            let agent_model: pa_agent::types::Model =
                json_round_trip(&model).expect("model conversion");
            let stream_fn = real_stream_fn(None, model.clone());
            let mut session_manager = SessionManager::in_memory(dir.path());
            session_manager.materialize_session_file(Some(dir.path().join("sessions")));
            let engine = std::sync::Arc::new(
                create_session(SessionEngineConfig {
                    cron_store: None,
                    queued_steering_probe: None,
                    steering_mode: None,
                    follow_up_mode: None,
                    telemetry: None,
                    cwd: dir.path().to_path_buf(),
                    agent_dir: agent_dir.clone(),
                    mcp_manager: None,
                    model: Some(agent_model),
                    thinking_level: None,
                    stream_fn: Some(stream_fn),
                    tools: Vec::new(),
                    custom_system_prompt: None,
                    prompt_guidelines: Vec::new(),
                    generic_mcp_servers: Vec::new(),
                    allow_recursion: None,
                    session_manager: Some(session_manager),
                    extra_host_handlers: None,
                    conversation_log_path: None,
                    additional_skill_paths: Vec::new(),
                    additional_prompt_paths: Vec::new(),
                    extra_builtin_skill_overrides: Vec::new(),
                    rlm_subagent_host: None,
                    rlm_depth: None,
                    model_info: Some(model.clone()),
                    cli_extension_sources: Vec::new(),
                    extension_tool_allow_list: None,
                    prewarm_ipython_kernel: None,
                    queued_goal_context_purge: None,
                })
                .await
                .unwrap(),
            );
            let (tx, frames) = mpsc::unbounded_channel::<serde_json::Value>();
            let session_id = "acp-goal-session".to_string();
            let producer = UpdateProducer::new(session_id.clone(), tx.clone());
            let autonomous = std::sync::Arc::new(Mutex::new(
                pa_core::autonomous::create_autonomous_runtime_state(None, None),
            ));
            let driver: std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver> =
                std::sync::Arc::new(pa_core::autonomous::ShellAutonomousDriver::new(dir.path()));
            let session = std::sync::Arc::new(
                super::super::session::AcpSession::new(
                    session_id.clone(),
                    engine.clone(),
                    producer.clone(),
                    autonomous,
                    driver,
                )
                .await,
            );
            producer.commit_session_new_response().await;
            let state = std::sync::Arc::new(Mutex::new(ConnectionState {
                session: Some(SessionEntry {
                    session,
                    prompt_task: None,
                }),
                session_new_in_flight: false,
                session_close_in_flight: false,
            }));
            let mode = AcpModeState {
                engine: engine.clone(),
                actual_cwd: std::sync::Arc::new(dir.path().to_path_buf()),
                product_version: std::sync::Arc::new("test".to_string()),
                model: Some(model),
                api_key: None,
                agent_dir: std::sync::Arc::new(agent_dir),
                autonomous_config: None,
                mcp: engine.mcp_manager.clone(),
                mcp_owner_id: std::sync::Arc::new("acp-goal-owner".to_string()),
                mcp_server_names: std::sync::Arc::new(Mutex::new(Vec::new())),
            };
            AcpGoalBed {
                mode,
                state,
                session_id,
                tx,
                frames,
                next_request_id: 0,
                pending_id: None,
                engine,
                _dir: dir,
            }
        }

        /// Admit one prompt through the real ACP prompt handler and read
        /// frames until its response: (response, notifications in order).
        async fn prompt(&mut self, text: String) -> (serde_json::Value, Vec<serde_json::Value>) {
            self.next_request_id += 1;
            let id = serde_json::Value::from(self.next_request_id);
            handle_session_prompt(
                id.clone(),
                json!({
                    "sessionId": self.session_id,
                    "prompt": [{ "type": "text", "text": text }],
                }),
                self.state.clone(),
                self.mode.clone(),
                self.tx.clone(),
            )
            .await;
            let mut notifications = Vec::new();
            loop {
                let Some(frame) = self.frames.recv().await else {
                    panic!("ACP frame channel closed before the response");
                };
                if frame.get("id") == Some(&id)
                    && (frame.get("result").is_some() || frame.get("error").is_some())
                {
                    return (frame, notifications);
                }
                notifications.push(frame);
            }
        }

        /// Fire one prompt without waiting for its response (the settle
        /// loop may hold the turn open; pair with `next_response`).
        async fn fire_prompt(&mut self, text: String) {
            self.next_request_id += 1;
            let id = serde_json::Value::from(self.next_request_id);
            self.pending_id = Some(id.clone());
            handle_session_prompt(
                id,
                json!({
                    "sessionId": self.session_id,
                    "prompt": [{ "type": "text", "text": text }],
                }),
                self.state.clone(),
                self.mode.clone(),
                self.tx.clone(),
            )
            .await;
        }

        /// Send the `session/cancel` notification for the hosted session.
        async fn notify_cancel(&self) {
            super::super::handle_notification(
                "session/cancel".to_string(),
                json!({ "sessionId": self.session_id }),
                self.state.clone(),
            )
            .await;
        }

        /// Read frames until the pending fired prompt answers.
        async fn next_response(&mut self) -> serde_json::Value {
            let id = self.pending_id.clone().expect("a fired prompt");
            loop {
                let frame = self
                    .frames
                    .recv()
                    .await
                    .expect("ACP frame channel closed before the response");
                if frame.get("id") == Some(&id)
                    && (frame.get("result").is_some() || frame.get("error").is_some())
                {
                    return frame;
                }
            }
        }

        /// Start a goal directly on the engine's driver (no session-command
        /// segment runs, so no scripted response is consumed).
        async fn start_goal(&self, objective: &str, budget: Option<u64>) {
            let persistence = self.engine.session.shared_persistence();
            let mut driver = self.engine.goal_driver.lock().await;
            let mut persistence = persistence.lock().await;
            driver.start(&mut persistence, objective, budget).unwrap();
        }

        /// The goal driver's current state.
        async fn goal_state(&self) -> pa_core::goals::GoalState {
            self.engine.goal_driver.lock().await.state().clone()
        }

        /// The positions (notification indexes) of the goal-update and
        /// compaction frames, for ordering assertions.
        fn frame_kinds(notifications: &[serde_json::Value]) -> Vec<&'static str> {
            notifications
                .iter()
                .filter_map(|frame| {
                    let meta = frame
                        .get("params")?
                        .get("update")?
                        .get("_meta")?
                        .get(META)?;
                    if meta.get("goal").is_some_and(|value| !value.is_null()) {
                        Some("goal")
                    } else if meta.get("compaction").is_some_and(|value| !value.is_null()) {
                        Some("compaction")
                    } else {
                        None
                    }
                })
                .collect()
        }

        /// The streamed text answers among a turn's notifications.
        fn streamed_answers(notifications: &[serde_json::Value]) -> Vec<String> {
            notifications
                .iter()
                .filter_map(|frame| {
                    frame
                        .get("params")?
                        .get("update")?
                        .get("content")?
                        .get("text")?
                        .as_str()
                        .map(str::to_string)
                })
                .collect()
        }
    }

    /// The turn-failure detail the settle loop reports (the wire shape
    /// the prompt response carries).
    fn turn_error_details(response: &serde_json::Value) -> String {
        response["error"]["data"]["details"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    /// The natural continuation loop: an active goal mints one
    /// continuation per settled turn, every minted turn runs inside the
    /// same prompt request, and a failed turn fails the goal. The
    /// scripted responses bound the run: the fourth minted turn errors
    /// (no responses left), which fails the goal and settles the prompt
    /// with the turn error.
    #[tokio::test]
    async fn goal_continuation_loop_mints_per_settled_turn() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bed =
            AcpGoalBed::new(json!({ "responses": ["one", "two", "three"] }), 128_000).await;
        let (response, notifications) = bed.prompt("/goal keep working".to_string()).await;
        // Three settled continuation turns ran inside the one prompt;
        // the fourth minted turn hit the exhausted script and failed.
        assert_eq!(
            bed.goal_state().await.continuations_used,
            3,
            "one mint per settled turn"
        );
        assert_eq!(
            bed.goal_state().await.status,
            pa_core::goals::GoalStatus::Error
        );
        let details = turn_error_details(&response);
        assert!(
            details.contains("No more faux responses queued"),
            "response: {response:?}"
        );
        let joined = AcpGoalBed::streamed_answers(&notifications).join("");
        assert!(
            joined.contains("one") && joined.contains("two") && joined.contains("three"),
            "every scripted answer ran: {notifications:?}"
        );
        // The goal-update frames: the start, the minted usage bumps, and
        // the terminal error state.
        let kinds = AcpGoalBed::frame_kinds(&notifications);
        assert!(
            kinds.iter().filter(|kind| **kind == "goal").count() >= 2,
            "frames: {kinds:?}"
        );
    }

    /// The budget-limit wrap-up steer: the turn whose usage crossed the
    /// goal budget runs the budget-limit context as the prompt's last
    /// model segment, the goal settles budget_limited, and no
    /// continuation is minted (the steer consumes no slot).
    #[tokio::test]
    async fn budget_crossing_runs_the_wrap_up_steer_and_settles() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bed = AcpGoalBed::new(
            json!({ "responses": ["GOAL-PROGRESS", "WRAP-UP"] }),
            128_000,
        )
        .await;
        let (response, notifications) = bed
            .prompt("/goal --budget 5 reply with exactly: GOAL-PROGRESS".to_string())
            .await;
        assert_eq!(
            response["result"]["stopReason"], "end_turn",
            "response: {response:?}"
        );
        let goal = bed.goal_state().await;
        assert_eq!(goal.status, pa_core::goals::GoalStatus::BudgetLimited);
        assert_eq!(goal.continuations_used, 0, "the steer consumes no slot");
        // The two model segments streamed their scripted answers (the
        // faux pacing may split one answer into chunks, so the joined
        // text carries the observable contract).
        let joined = AcpGoalBed::streamed_answers(&notifications).join("");
        assert!(
            joined.contains("GOAL-PROGRESS") && joined.contains("WRAP-UP"),
            "the steer ran as the second segment: {notifications:?}"
        );
    }

    /// The threshold arm's goal queue: a crossing turn with an active
    /// goal mints the continuation BEFORE the compaction runs (the
    /// goal-update frame precedes the compaction frame), and the held
    /// turn runs as the post-compaction turn. A skipped compaction keeps
    /// the mint (TS `resumeAfterFailure`); the run continues until the
    /// scripted responses end and the failed turn fails the goal.
    #[tokio::test]
    async fn threshold_arm_queues_the_goal_continuation_before_compacting() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bed = AcpGoalBed::new(
            json!({
                "responses": [
                    "seed reply",
                    "one",
                    "the summary",
                    "two",
                ]
            }),
            // A 500-token combined ceiling (the window minus the faux
            // request budget and the reserve).
            128_000u64.saturating_sub(FAUX_REQUEST_BUDGET + 500),
        )
        .await;
        // The harness shape: a seeded crossing turn whose boundary
        // compaction skips (a single-turn session has nothing to
        // summarize), then the goal's crossing turn whose boundary
        // compaction runs over the seeded turn.
        let (response, _) = bed.prompt(format!("turn one {}", "x".repeat(8_000))).await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        bed.start_goal("keep working", None).await;
        let (response, notifications) = bed.prompt(format!("turn two {}", "x".repeat(8_000))).await;
        // The run continued over the threshold arm's minted turns until
        // the scripted responses ended.
        let details = turn_error_details(&response);
        assert!(
            details.contains("No more faux responses queued"),
            "response: {response:?}"
        );
        assert_eq!(
            bed.goal_state().await.status,
            pa_core::goals::GoalStatus::Error
        );
        assert!(
            bed.goal_state().await.continuations_used >= 2,
            "the queue minted"
        );
        // A compaction ran (the summary) and the goal mint's update frame
        // precedes it: the mint happens before the compaction like the TS
        // event order. (The pre-turn skip disclosure also carries the
        // empty compaction meta, so the ordering check targets the
        // summary-carrying frame.)
        let ran_compaction_at = notifications
            .iter()
            .position(|frame| {
                let meta = &frame["params"]["update"]["_meta"][META]["compaction"];
                meta.get("summary")
                    .is_some_and(|s| s.as_str().unwrap_or_default().contains("the summary"))
            })
            .expect("the threshold compaction ran");
        let mint_goal_at = notifications
            .iter()
            .position(|frame| {
                let meta = &frame["params"]["update"]["_meta"][META];
                meta.get("goal").is_some_and(|value| !value.is_null())
            })
            .expect("a goal frame");
        assert!(
            mint_goal_at < ran_compaction_at,
            "the mint announces before the compaction: {notifications:?}"
        );
    }

    /// The compact-with-active-goal continue (TS `compact()`'s `didCompact`
    /// finally arm): a successful `/compact` with an active goal mints the
    /// continuation and runs it as the command turn's model segment.
    #[tokio::test]
    async fn compact_command_with_active_goal_mints_the_continue() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // No threshold interference (reserve 0 keeps the full window
        // free), and two seeded turns so the manual compact runs (a
        // single-turn session skips).
        let mut bed = AcpGoalBed::new(
            json!({ "responses": ["seed reply", "second reply", "the summary", "continued", "next"] }),
            0,
        )
        .await;
        for seed in ["seed turn one", "seed turn two"] {
            let (response, _) = bed.prompt(seed.to_string()).await;
            assert_eq!(response["result"]["stopReason"], "end_turn");
        }
        bed.start_goal("keep working", None).await;
        let (response, notifications) = bed.prompt("/compact".to_string()).await;
        // The compact ran, the minted continue ran as the segment, and
        // the natural loop continued until the scripted responses ended.
        let details = turn_error_details(&response);
        assert!(
            details.contains("No more faux responses queued"),
            "response: {response:?}"
        );
        // The compact ran (its summary wraps the scripted reply) and the
        // minted continue ran as the command turn's model segment; the
        // armed compact-trigger review services at the continuation
        // turn's boundary (it consumes the next scripted reply), then
        // the natural mint continues the loop until the responses end.
        let compaction_ran = notifications.iter().any(|frame| {
            let meta = &frame["params"]["update"]["_meta"][META]["compaction"];
            meta.get("summary")
                .is_some_and(|s| s.as_str().unwrap_or_default().contains("the summary"))
        });
        assert!(compaction_ran, "the manual compact ran: {notifications:?}");
        let answers = AcpGoalBed::streamed_answers(&notifications);
        assert!(
            answers.contains(&"continued".to_string()),
            "the compact-site continue ran: {notifications:?}"
        );
        assert!(bed.goal_state().await.continuations_used >= 2);
    }

    /// A cancelled threshold compaction withdraws the queued mint: the
    /// slot rolls back (continuationsUsed never counted the withdrawn
    /// turn), and the cancellation settles the prompt.
    #[tokio::test]
    async fn cancelled_threshold_compaction_rolls_back_the_mint() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut bed = AcpGoalBed::new(
            json!({
                "responses": [
                    "seed reply",
                    { "text": "the summary", "delayMs": 30_000 },
                ]
            }),
            // A 500-token combined ceiling (the window minus the faux
            // request budget and the reserve).
            128_000u64.saturating_sub(FAUX_REQUEST_BUDGET + 500),
        )
        .await;
        // The harness shape: a seeded crossing turn (its boundary
        // compaction skips — single turn), then the goal's crossing turn
        // whose boundary compaction runs over the seeded turn.
        let (response, _) = bed.prompt(format!("turn one {}", "x".repeat(8_000))).await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        bed.start_goal("keep working", None).await;
        // Fire the prompt (its settle loop holds in the threshold arm's
        // in-flight compaction), cancel mid-compaction, then read the
        // response: the held stream delays the summarizer long enough for
        // the cancel to land.
        bed.fire_prompt(format!("turn two {}", "x".repeat(8_000)))
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        bed.notify_cancel().await;
        let response = bed.next_response().await;
        assert_eq!(
            response["result"]["stopReason"], "cancelled",
            "response: {response:?}"
        );
        let goal = bed.goal_state().await;
        assert_eq!(goal.status, pa_core::goals::GoalStatus::Active);
        assert_eq!(
            goal.continuations_used, 0,
            "the cancelled arm's mint rolled back"
        );
    }
}
