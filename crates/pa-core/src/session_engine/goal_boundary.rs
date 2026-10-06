//! The session engine's goal boundary arms, shared by the headless drivers:
//! the natural-turn-end mint, the budget-limit wrap-up steer, the usage
//! accounting, and the terminal-error finish — each transport drives the
//! same state machine.

use pa_types::session::CustomMessage;

use super::engine::SessionEngine;
use super::goal_driver::UsageOutcome;
use crate::goals::{create_goal_context_message, GoalContextKind, GoalStatus};

/// Convert one custom row to its loop form via the shared wire shape, for
/// embeddings that admit minted goal rows through the continuation hook.
#[must_use]
pub fn custom_message_to_loop_row(
    message: &pa_types::session::CustomMessage,
) -> Option<pa_agent::types::AgentMessage> {
    serde_json::from_value(
        serde_json::to_value(pa_types::session::AgentMessage::Custom(message.clone())).ok()?,
    )
    .ok()
}

impl SessionEngine {
    /// Seed the CLI `--goal` objective: a depth-0 caller on a seedable branch
    /// starts the goal and queues its continuation as the next turn's row;
    /// returns whether the seed landed.
    ///
    /// # Errors
    ///
    /// Returns an error when validation fails or the continuation row cannot be created.
    pub async fn seed_initial_goal(
        &self,
        objective: &str,
        token_budget: Option<u64>,
    ) -> anyhow::Result<bool> {
        let persistence = self.session.shared_persistence();
        // The driver-first lock order the other arms use: one order
        // across the boundary stays deadlock-free.
        let mut driver = self.goal_driver.lock().await;
        let mut session = persistence.lock().await;
        if !super::goal_driver::GoalDriver::is_branch_seedable(&session) {
            return Ok(false);
        }
        let state = driver.start(&mut session, objective, token_budget)?;
        drop(session);
        drop(driver);
        let context = create_goal_context_message(&state, GoalContextKind::Continuation)?;
        self.session.queue_next_turn_row(context);
        Ok(true)
    }

    /// Account one settled assistant turn: non-error, non-aborted turns
    /// spend the budget; a crossing moves the goal to `budget_limited`.
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

    /// The budget-limit wrap-up context: a `budget_limited` goal steers
    /// the run with this message next; `None` outside that state.
    pub async fn goal_budget_limit_steer(&self) -> Option<CustomMessage> {
        let driver = self.goal_driver.lock().await;
        match driver.state().status {
            GoalStatus::BudgetLimited => {}
            _ => return None,
        }
        create_goal_context_message(
            &driver.state_with_creation_elapsed(),
            GoalContextKind::BudgetLimit,
        )
        .ok()
    }

    /// Mint one goal continuation: an active goal consumes one slot and returns
    /// its context row; a failed persist fails the goal and mints nothing.
    pub async fn mint_goal_continuation(&self) -> Option<CustomMessage> {
        // The just-settled turn gates the mint (read before the driver lock),
        // and a trailing failed continuation pair stops riding the context.
        let last_turn: Option<pa_agent::types::AssistantMessage> = self
            .session
            .last_assistant_message()
            .await
            .and_then(|wire| match wire {
                pa_types::session::AgentMessage::Assistant(assistant) => {
                    super::provider_adapter::json_round_trip(&assistant)
                }
                _ => None,
            });
        if last_turn
            .as_ref()
            .is_some_and(|turn: &pa_agent::types::AssistantMessage| {
                turn.stop_reason == pa_agent::types::StopReason::Error
                    || super::goal_driver::turn_produced_no_output(turn)
            })
        {
            self.session.drop_failed_goal_continuation().await;
        }
        let persistence = self.session.shared_persistence();
        let mut driver = self.goal_driver.lock().await;
        if !driver.owns_continuation_wakeup() {
            return None;
        }
        let mut session = persistence.lock().await;
        match driver.next_continuation_message(&mut session, last_turn.as_ref()) {
            Ok(message) => message,
            Err(error) => {
                let message = format!("{error:#}");
                tracing::warn!("goal continuation mint failed the persist: {message}");
                // Best-effort: its own persist failure must not reject
                // the boundary hook either.
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

    /// A failed terminal assistant message fails an active goal: the error
    /// text becomes the terminal reason; an abort keeps the goal.
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

    /// The current goal state (the drivers' publish-dedupe read): the
    /// timer reads the goal's creation-based age fresh.
    pub async fn goal_state(&self) -> crate::goals::GoalState {
        self.goal_driver.lock().await.state_with_creation_elapsed()
    }

    /// Release the pending-continuation guard: the surface admitted (or
    /// withdrew) the minted continuation, so the next boundary mints again.
    pub async fn clear_pending_goal_continuation(&self) {
        self.goal_driver.lock().await.continuation_consumed();
    }
}
