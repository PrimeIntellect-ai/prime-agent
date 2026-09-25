//! The session engine's goal boundary arms (TS `agent-session.ts`'s goal
//! hooks), shared by the headless drivers: the natural-turn-end mint, the
//! budget-limit wrap-up steer, the usage accounting, and the terminal-error
//! finish. The TS session installs these on the agent's continuation hook
//! and its message-end/agent-end handlers; the Rust engines expose them as
//! engine methods so each transport (the print driver's in-loop hook, the
//! ACP settle loop, the daemon worker's queue) drives the same one state
//! machine — the goal driver and the persistence handle are the single
//! representation.
//!
//! Surfaces, per the TS site each method ports:
//! - `seed_initial_goal`: the CLI `--goal` construction-time seed (depth-0
//!   branch seeding, the context row riding the next turn).
//! - `record_goal_usage`: `_accountGoalUsageForAssistantMessage` at
//!   `message_end` — settled non-error, non-aborted turns spend the budget;
//!   the crossing flips the goal to `budget_limited`.
//! - `goal_budget_limit_steer`: `_shouldStopAfterTurn`'s budget arm — the
//!   wrap-up context the crossing turn queues as its steer.
//! - `mint_goal_continuation`: `_getGoalContinuationMessages` — an active
//!   goal mints one continuation context per natural turn end.
//! - `rollback_goal_continuation_mint`: the cancelled-threshold-queue and
//!   input-arrival rollbacks (the slot returns for the next boundary).
//! - `fail_goal_for_terminal_error`: `_finishGoalForTerminalAssistantMessage`
//!   — a failed run fails an active goal; an abort keeps it.

use pa_types::session::CustomMessage;

use super::engine::SessionEngine;
use super::goal_driver::UsageOutcome;
use crate::goals::{create_goal_context_message, GoalContextKind, GoalStatus};

/// Convert one custom row to its loop form via the shared wire shape (the
/// same round-trip [`super::AgentSession`]'s injected-prompt path uses), for
/// embeddings that admit minted goal rows through the loop's continuation
/// hook instead of a prompt.
pub fn custom_message_to_loop_row(
    message: &pa_types::session::CustomMessage,
) -> Option<pa_agent::types::AgentMessage> {
    serde_json::from_value(
        serde_json::to_value(pa_types::session::AgentMessage::Custom(message.clone())).ok()?,
    )
    .ok()
}

impl SessionEngine {
    /// Seed the CLI `--goal` objective (TS constructor seeding): a depth-0
    /// caller, a branch that carries only bootstrap entries and no persisted
    /// goal state (`is_branch_seedable`), and a validated objective/budget
    /// start the goal and queue its continuation context as the next turn's
    /// leading row (TS `_pendingNextTurnMessages.push(createGoalContextMessage(
    /// ..., "continuation"))`). Resumed or already-seeded branches keep their
    /// persisted goal untouched. Returns whether the seed landed.
    ///
    /// # Errors
    ///
    /// Returns an error when the objective or budget fails validation, or
    /// when the continuation context row cannot be created. An unseedable
    /// branch returns `Ok(false)` without erroring.
    pub async fn seed_initial_goal(
        &self,
        objective: &str,
        token_budget: Option<u64>,
    ) -> anyhow::Result<bool> {
        let persistence = self.session.shared_persistence();
        // The driver-first lock order the other arms use: the accounting
        // subscription and the continuation hook can never be mid-mutation
        // here (the seed runs before the driver's first arm), but one order
        // across the boundary stays deadlock-free regardless.
        let mut driver = self.goal_driver.lock().await;
        let mut session = persistence.lock().await;
        if !super::goal_driver::GoalDriver::is_branch_seedable(&session) {
            return Ok(false);
        }
        let state = driver.start(&mut session, objective, token_budget)?;
        drop(session);
        drop(driver);
        let context = create_goal_context_message(&state, GoalContextKind::Continuation)?;
        self.session.queue_next_turn_row(context).await;
        Ok(true)
    }

    /// Account one settled assistant turn against the active goal (TS
    /// `_accountGoalUsageForAssistantMessage`): non-error, non-aborted turns
    /// spend the token budget; a crossing moves the goal to `budget_limited`
    /// and reports it so the caller arms its wrap-up steer.
    ///
    /// # Errors
    ///
    /// Returns the driver's error for the accounting (invalid usage or a
    /// failed state persist).
    pub async fn record_goal_usage(
        &self,
        message_id: &str,
        usage: &pa_types::ai::Usage,
    ) -> anyhow::Result<UsageOutcome> {
        let persistence = self.session.shared_persistence();
        let mut driver = self.goal_driver.lock().await;
        let mut session = persistence.lock().await;
        driver.record_assistant_usage(&mut session, message_id, usage)
    }

    /// The budget-limit wrap-up context (TS `_shouldStopAfterTurn`'s budget
    /// arm): a goal the usage crossing flipped to `budget_limited` steers the
    /// run with this message next. `None` when the goal is not in the
    /// budget-limited state.
    pub async fn goal_budget_limit_steer(&self) -> Option<CustomMessage> {
        let driver = self.goal_driver.lock().await;
        match driver.state().status {
            GoalStatus::BudgetLimited => {}
            _ => return None,
        }
        create_goal_context_message(driver.state(), GoalContextKind::BudgetLimit).ok()
    }

    /// Mint one goal continuation (TS `_getGoalContinuationMessages`): an
    /// active goal with an objective consumes one continuation slot and
    /// returns its context row; the state change persists before the turn
    /// is admitted. `None` when the goal cannot mint. A failed persist
    /// fails the goal with the write error and mints nothing (the TS
    /// catch arm: `_finishGoalWithError(error)`, then no continuation —
    /// the hook must not reject).
    pub async fn mint_goal_continuation(&self) -> Option<CustomMessage> {
        let persistence = self.session.shared_persistence();
        let mut driver = self.goal_driver.lock().await;
        if !driver.owns_continuation_wakeup() {
            return None;
        }
        let mut session = persistence.lock().await;
        match driver.next_continuation_message(&mut session) {
            Ok(message) => message,
            Err(error) => {
                let message = format!("{error:#}");
                tracing::warn!("goal continuation mint failed the persist: {message}");
                // TS `_finishGoalWithError`: best-effort — its own persist
                // failure must not reject the boundary hook either.
                if let Err(fail_error) = driver.finish_for_terminal_message(
                    &mut session,
                    pa_types::ai::StopReason::Error,
                    Some(&message),
                ) {
                    tracing::warn!("goal error finish also failed: {fail_error:#}");
                }
                None
            }
        }
    }

    /// A failed terminal assistant message fails an active goal (TS
    /// `_finishGoalForTerminalAssistantMessage` at `agent_end`): the error
    /// text becomes the goal's terminal reason; an abort keeps the goal.
    ///
    /// # Errors
    ///
    /// Returns the driver's error when failing the goal cannot be
    /// persisted.
    pub async fn fail_goal_for_terminal_error(
        &self,
        error_message: Option<&str>,
    ) -> anyhow::Result<()> {
        let persistence = self.session.shared_persistence();
        let mut driver = self.goal_driver.lock().await;
        let mut session = persistence.lock().await;
        driver.finish_for_terminal_message(
            &mut session,
            pa_types::ai::StopReason::Error,
            error_message,
        )
    }

    /// The current goal state (the drivers' publish-dedupe read).
    pub async fn goal_state(&self) -> crate::goals::GoalState {
        self.goal_driver.lock().await.state().clone()
    }
}
