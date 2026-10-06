//! The goal driver: goal-state lifecycle, usage accounting, budget limits,
//! and continuation context, with persistence via `thread_goal_state`
//! custom entries and the branch-seed/reload rules.

use pa_types::session::CustomMessage;

use crate::goals::{
    create_goal_context_message, empty_goal_state, goal_token_delta_for_usage,
    normalize_goal_state, validate_goal_budget, validate_goal_objective, GoalContextKind,
    GoalState, GoalStatus, GOAL_STATE_CUSTOM_TYPE,
};
use crate::session::manager::SessionManager;

/// The goal-state reload rule at a branch rebuild: a summary rebuild
/// continues the same timeline; a plain branch move is time travel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalBranchReload {
    /// A summary context rebuild: the rebuilt branch's last persisted goal
    /// entry can lag (queue/flush races), so the same goal's counters clamp
    /// to the max and its status or a fired gate never regresses.
    SameTimeline,
    /// A plain branch move (tree navigation without a summary): the moved
    /// branch's latest persisted goal state adopts as-is, even when older.
    FaithfulBranch,
}

/// The goal timer's contract (operator ruling 2026-09-28): `time_used_seconds` is
/// the goal's AGE — the wall clock since `created_at`, computed fresh on every read.
/// TS divergence (`_goalWithAccountedWallClock`): TS re-baselines an anchor at
/// each fold and charges only active-status wall clock.
#[must_use]
pub fn creation_elapsed_seconds(created_at: Option<u64>, now: u64) -> u64 {
    created_at.map_or(0, |created| now.saturating_sub(created) / 1000)
}

/// What happened after accounting one assistant turn's usage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageOutcome {
    Accounted,
    BudgetReached,
    Ignored,
}

pub struct GoalDriver {
    state: GoalState,
    /// Ids of assistant messages already counted (double-counting guard).
    accounted_messages: std::collections::HashSet<String>,
    /// A continuation is owed behind unsettled RLM descendant work.
    /// In-memory only: descendant quiescence is a live-session fact.
    owed_continuation_for_rlm_work: bool,
    /// A minted continuation its surface has not admitted yet; while set no
    /// mint site re-arms another. In-memory only.
    pending_continuation: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The consecutive-no-progress bookkeeping: a mint consult that finds the
    /// just-settled turn produced no output arms the backoff window and at
    /// the cap finishes the goal. In-memory only.
    no_progress_streak: u32,
    no_progress_backoff_until_ms: u64,
    /// The quota-park refusal window (in-memory; separate so no probe
    /// wake is ever scheduled into a parked session).
    parked_refusal_until_ms: u64,
    /// The last turn the streak counted (re-consult dedup): adopted from the
    /// durable `no_progress_turn_ms` so a restart never re-counts the same corpse.
    counted_no_progress_turn_ms: Option<i64>,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

mod progress;

use progress::CONTINUATION_NO_PROGRESS_CAP;
pub use progress::{terminal_provider_failure, turn_produced_no_output};
pub use progress::{GOAL_BACKOFF_WAKE_CRON_LABEL, GOAL_BACKOFF_WAKE_MARKER_TEXT};

impl GoalDriver {
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: empty_goal_state(),
            accounted_messages: std::collections::HashSet::default(),
            owed_continuation_for_rlm_work: false,
            pending_continuation: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            no_progress_streak: 0,
            no_progress_backoff_until_ms: 0,
            parked_refusal_until_ms: 0,
            counted_no_progress_turn_ms: None,
        }
    }

    /// Rehydrate from the session branch's latest persisted entry: an `active`
    /// newest row that failed on a provider error adopts the failure as terminal.
    #[must_use]
    pub fn load_persisted(session: &SessionManager) -> Self {
        let mut state = Self::latest_persisted_state(session);
        if state.status == GoalStatus::Active {
            if let Some(error) = session.stale_active_goal_failure() {
                state = GoalState {
                    active: false,
                    status: GoalStatus::Error,
                    last_reason: Some(error.clone()),
                    last_error: Some(error),
                    ..state
                };
            }
        }
        Self::restore_persisted(state)
    }

    /// The branch's latest valid persisted goal state, or the empty
    /// state when none exists.
    pub fn latest_persisted_state(session: &SessionManager) -> GoalState {
        session.active_goal_state().unwrap_or_else(empty_goal_state)
    }

    /// Reload the goal state from the session's current branch: the
    /// branch's latest persisted entry adopts under [`rule`].
    pub fn reload_from_branch(&mut self, session: &SessionManager, rule: GoalBranchReload) {
        let previous = self.state.clone();
        let reloaded = Self::latest_persisted_state(session);
        self.state = match rule {
            GoalBranchReload::SameTimeline
                if reloaded.goal_id.is_some() && reloaded.goal_id == previous.goal_id =>
            {
                // The counters clamp to the max; every other field keeps the in-memory state.
                GoalState {
                    tokens_used: previous.tokens_used.max(reloaded.tokens_used),
                    continuations_used: previous
                        .continuations_used
                        .max(reloaded.continuations_used),
                    time_used_seconds: previous.time_used_seconds.max(reloaded.time_used_seconds),
                    ..previous
                }
            }
            _ => {
                // A different goal (or none) adopts: the previous goal's pending
                // mint and deferral would block the adopted goal's continuations.
                self.continuation_consumed();
                self.owed_continuation_for_rlm_work = false;
                // The adopted goal's own durable streak applies; the backoff
                // window does not survive the move.
                self.no_progress_streak = reloaded.no_progress_streak.unwrap_or(0);
                self.no_progress_backoff_until_ms = 0;
                self.parked_refusal_until_ms = 0;
                self.counted_no_progress_turn_ms = reloaded.no_progress_turn_ms;
                // The restore-resurrection guard applies here as in `load_persisted`.
                if reloaded.status == GoalStatus::Active {
                    match session.stale_active_goal_failure() {
                        Some(error) => GoalState {
                            active: false,
                            status: GoalStatus::Error,
                            last_reason: Some(error.clone()),
                            last_error: Some(error),
                            ..reloaded
                        },
                        None => reloaded,
                    }
                } else {
                    reloaded
                }
            }
        };
    }

    /// Adopt an already-persisted goal state without re-persisting it:
    /// a recovery rebuild continues the durable state verbatim.
    #[must_use]
    pub fn restore_persisted(state: GoalState) -> Self {
        let mut driver = Self::new();
        driver.restore_from_persisted(state);
        driver
    }

    /// [`GoalDriver::restore_persisted`]'s in-place form: adopts the persisted
    /// state without re-persisting or resetting the double-counting guard.
    pub fn restore_from_persisted(&mut self, state: GoalState) {
        self.state = normalize_goal_state(state);
        // The no-progress streak is durable (a restart cannot reset it
        // and un-cap a degenerate loop); the backoff window is not.
        self.no_progress_streak = self.state.no_progress_streak.unwrap_or(0);
        self.no_progress_backoff_until_ms = 0;
        self.parked_refusal_until_ms = 0;
        self.counted_no_progress_turn_ms = self.state.no_progress_turn_ms;
        self.continuation_consumed();
    }

    #[must_use]
    pub fn state(&self) -> &GoalState {
        &self.state
    }

    /// The served goal state: `time_used_seconds` reads the age fresh from
    /// `created_at`; a state without `created_at` keeps its persisted value.
    #[must_use]
    pub fn state_with_creation_elapsed(&self) -> GoalState {
        match self.state.created_at {
            Some(created_at) => GoalState {
                time_used_seconds: creation_elapsed_seconds(Some(created_at), now_millis()),
                ..self.state.clone()
            },
            None => self.state.clone(),
        }
    }

    /// Whether the branch may be seeded with an initial goal: only bootstrap
    /// entries (model/thinking changes) and no prior persisted goal.
    #[must_use]
    pub fn is_branch_seedable(session: &SessionManager) -> bool {
        !session.has_non_bootstrap_entries()
    }

    /// Start a new goal (validates objective and budget).
    ///
    /// # Errors
    ///
    /// Returns an error when validation fails or the state cannot be persisted.
    pub fn start(
        &mut self,
        session: &mut SessionManager,
        objective_text: &str,
        token_budget: Option<u64>,
    ) -> anyhow::Result<GoalState> {
        let objective = validate_goal_objective(objective_text)?;
        let budget = validate_goal_budget(token_budget)?;
        let now = now_millis();
        let goal = GoalState {
            active: true,
            status: GoalStatus::Active,
            goal_id: Some(uuid::Uuid::new_v4().to_string()),
            objective: Some(objective),
            token_budget: budget,
            tokens_used: 0,
            time_used_seconds: 0,
            continuations_used: 0,
            created_at: Some(now),
            // A fresh goal never inherits the previous goal's no-progress streak.
            no_progress_streak: Some(0),
            no_progress_turn_ms: None,
            updated_at: Some(now),
            last_reason: None,
            last_error: None,
        };
        let previous_accounted = std::mem::take(&mut self.accounted_messages);
        let previous_owed = self.owed_continuation_for_rlm_work;
        let previous_pending = self.pending_continuation();
        self.owed_continuation_for_rlm_work = false;
        let previous_streak = self.no_progress_streak;
        let previous_backoff = self.no_progress_backoff_until_ms;
        let previous_parked = self.parked_refusal_until_ms;
        let previous_counted = self.counted_no_progress_turn_ms;
        self.no_progress_streak = 0;
        self.no_progress_backoff_until_ms = 0;
        self.parked_refusal_until_ms = 0;
        self.counted_no_progress_turn_ms = None;
        self.continuation_consumed();
        if let Err(error) = self.set_state(session, goal) {
            // A failed start leaves the previous goal's bookkeeping intact
            // (the no-progress cap included).
            self.accounted_messages = previous_accounted;
            self.owed_continuation_for_rlm_work = previous_owed;
            self.no_progress_streak = previous_streak;
            self.no_progress_backoff_until_ms = previous_backoff;
            self.parked_refusal_until_ms = previous_parked;
            self.counted_no_progress_turn_ms = previous_counted;
            if previous_pending {
                self.mark_continuation_pending();
            }
            return Err(error);
        }
        Ok(self.state_with_creation_elapsed())
    }

    /// Clear the goal entirely (empty state).
    ///
    /// # Errors
    ///
    /// Returns an error when the cleared goal state cannot be persisted.
    pub fn clear(&mut self, session: &mut SessionManager) -> anyhow::Result<()> {
        self.set_state(session, empty_goal_state())?;
        // Clearing drops any owed or pending continuation with the queued contexts.
        self.owed_continuation_for_rlm_work = false;
        self.continuation_consumed();
        Ok(())
    }

    fn set_state(&mut self, session: &mut SessionManager, next: GoalState) -> anyhow::Result<()> {
        let now = now_millis();
        let normalized = normalize_goal_state(GoalState {
            updated_at: Some(now),
            ..next
        });
        // Every durable row carries the goal's age at the write:
        // `time_used_seconds` recomputes from `created_at`, never accumulates.
        let normalized = match normalized.created_at {
            Some(created_at) => GoalState {
                time_used_seconds: creation_elapsed_seconds(Some(created_at), now),
                ..normalized
            },
            None => normalized,
        };
        let value = serde_json::to_value(&normalized)?;
        session.append_custom_entry(GOAL_STATE_CUSTOM_TYPE, Some(value))?;
        session.flush_now()?;
        // A goal leaving the active state drops its pending mint: a continuation
        // owed to a dead goal never wedges the next one's mint.
        if normalized.status != GoalStatus::Active {
            self.continuation_consumed();
        }
        self.state = normalized;
        Ok(())
    }

    /// Account one assistant turn's usage. Double-counts are suppressed by
    /// message id. Returns whether the budget was reached.
    ///
    /// # Errors
    ///
    /// Returns an error when the accounted goal state cannot be persisted.
    pub fn record_assistant_usage(
        &mut self,
        session: &mut SessionManager,
        message_id: &str,
        usage: &pa_types::ai::Usage,
    ) -> anyhow::Result<UsageOutcome> {
        if self.state.status != GoalStatus::Active {
            return Ok(UsageOutcome::Ignored);
        }
        // The double-counting guard stays open until the state is durable:
        // a failed persist must let the retry account this message again.
        if self.accounted_messages.contains(message_id) {
            return Ok(UsageOutcome::Ignored);
        }
        let token_delta = goal_token_delta_for_usage(usage.input as i64, usage.output as i64);
        let next_goal = GoalState {
            tokens_used: self.state.tokens_used + token_delta,
            ..self.state.clone()
        };
        let budget_reached = next_goal
            .token_budget
            .is_some_and(|budget| next_goal.tokens_used >= budget);
        let outcome = if budget_reached {
            let token_budget = next_goal.token_budget;
            let budget_reason = token_budget
                .map(|budget| format!("Reached {budget} token goal budget"))
                .unwrap_or_default();
            self.set_state(
                session,
                GoalState {
                    active: false,
                    status: GoalStatus::BudgetLimited,
                    last_reason: Some(budget_reason),
                    last_error: None,
                    ..next_goal
                },
            )?;
            UsageOutcome::BudgetReached
        } else {
            self.set_state(session, next_goal)?;
            UsageOutcome::Accounted
        };
        self.accounted_messages.insert(message_id.to_string());
        Ok(outcome)
    }

    /// Pause the goal (no-op when not active).
    ///
    /// # Errors
    ///
    /// Returns an error when the paused goal state cannot be persisted.
    pub fn pause(&mut self, session: &mut SessionManager, reason: &str) -> anyhow::Result<()> {
        if self.state.status != GoalStatus::Active {
            return Ok(());
        }
        self.set_state(
            session,
            GoalState {
                active: false,
                status: GoalStatus::Paused,
                last_reason: Some(reason.to_string()),
                last_error: None,
                ..self.state.clone()
            },
        )?;
        // The deferral drops after the durable write: a failed persist
        // keeps the previous goal's deferral as it was.
        self.owed_continuation_for_rlm_work = false;
        self.continuation_consumed();
        Ok(())
    }

    /// Resume a paused/budget-limited goal. Returns the continuation context
    /// message when the goal becomes active again.
    ///
    /// # Errors
    ///
    /// Returns an error when the resumed state or its continuation message cannot be persisted.
    pub fn resume(
        &mut self,
        session: &mut SessionManager,
    ) -> anyhow::Result<Option<CustomMessage>> {
        if self.state.objective.is_none() {
            return Ok(None);
        }
        if !matches!(
            self.state.status,
            GoalStatus::Paused | GoalStatus::BudgetLimited
        ) {
            return Ok(None);
        }
        let exhausted = self
            .state
            .token_budget
            .is_some_and(|budget| self.state.tokens_used >= budget);
        let next_status = if exhausted {
            GoalStatus::BudgetLimited
        } else {
            GoalStatus::Active
        };
        self.set_state(
            session,
            GoalState {
                active: next_status == GoalStatus::Active,
                status: next_status,
                // The reason is only set for an exhausted budget (which
                // stays budget_limited); a live resume clears it.
                last_reason: exhausted.then(|| "Goal token budget already reached".to_string()),
                last_error: None,
                ..self.state.clone()
            },
        )?;
        if next_status == GoalStatus::Active {
            return Ok(
                create_goal_context_message(&self.state, GoalContextKind::Continuation).ok(),
            );
        }
        Ok(None)
    }

    /// Complete the goal (host `goal.complete()`).
    ///
    /// # Errors
    ///
    /// Returns an error when the completed goal state cannot be persisted.
    pub fn complete(&mut self, session: &mut SessionManager) -> anyhow::Result<()> {
        if self.state.objective.is_none() || self.state.status == GoalStatus::Idle {
            return Ok(());
        }
        self.set_state(
            session,
            GoalState {
                active: false,
                status: GoalStatus::Complete,
                last_reason: Some("Goal achieved".to_string()),
                last_error: None,
                ..self.state.clone()
            },
        )
    }

    /// Terminal-assistant handling: `aborted` keeps the goal, `error` fails it.
    ///
    /// # Errors
    ///
    /// Returns an error when the terminal goal state cannot be persisted.
    pub fn finish_for_terminal_message(
        &mut self,
        session: &mut SessionManager,
        stop_reason: pa_types::ai::StopReason,
        error_message: Option<&str>,
    ) -> anyhow::Result<()> {
        use pa_types::ai::StopReason;
        if self.state.status != GoalStatus::Active {
            return Ok(());
        }
        if let StopReason::Error = stop_reason {
            let reason = error_message
                .filter(|message| !message.is_empty())
                .unwrap_or("Assistant response failed");
            self.set_state(
                session,
                GoalState {
                    active: false,
                    status: GoalStatus::Error,
                    last_reason: Some(reason.to_string()),
                    last_error: Some(reason.to_string()),
                    ..self.state.clone()
                },
            )?;
        }
        Ok(())
    }

    /// Build the next continuation context, consuming one continuation
    /// slot; the state change persists before the turn is admitted.
    ///
    /// # Errors
    ///
    /// Returns an error when the state or its context message cannot be persisted or built.
    pub fn next_continuation_message(
        &mut self,
        session: &mut SessionManager,
        last_turn: Option<&pa_agent::types::AssistantMessage>,
    ) -> anyhow::Result<Option<CustomMessage>> {
        if self.state.status != GoalStatus::Active || self.state.objective.is_none() {
            return Ok(None);
        }
        // SANCTIONED DIVERGENCE (the 402 diagnosis, operator ruling): the
        // mint checks progress. TS mints whenever the goal is Active; here
        // the just-settled turn gates the mint.
        if let Some(turn) = last_turn {
            if !self.progress_gate(session, turn)? {
                return Ok(None);
            }
        }

        // The cap enforcement is UNCONDITIONAL: a restored goal already
        // at the cap finishes at the FIRST consult.
        if self.state.status == GoalStatus::Active
            && self.no_progress_streak >= CONTINUATION_NO_PROGRESS_CAP
        {
            let reason =
                "Goal continuation cap reached: consecutive turns made no progress".to_string();
            self.set_state(
                session,
                GoalState {
                    active: false,
                    status: GoalStatus::Error,
                    no_progress_streak: Some(self.no_progress_streak),
                    last_reason: Some(reason.clone()),
                    last_error: Some(reason),
                    ..self.state.clone()
                },
            )?;
            return Ok(None);
        }
        // A consult inside either window mints nothing; the next boundary
        // after the window re-mints (the goal stays Active — a delay, not a death).
        let now = now_millis();
        if now < self.no_progress_backoff_until_ms || now < self.parked_refusal_until_ms {
            return Ok(None);
        }
        // The pending-never-re-arms contract: a minted-but-unadmitted
        // continuation blocks every further mint — never duplicates.
        if self.pending_continuation() {
            return Ok(None);
        }
        self.set_state(
            session,
            GoalState {
                continuations_used: self.state.continuations_used + 1,
                last_reason: None,
                last_error: None,
                ..self.state.clone()
            },
        )?;
        let message = create_goal_context_message(&self.state, GoalContextKind::Continuation).ok();
        // The mint is owed to the calling surface until it admits the turn; a rollback un-mints it.
        if message.is_some() {
            self.mark_continuation_pending();
        }
        Ok(message)
    }

    /// Defer the continuation while descendant RLM work is unsettled: the
    /// natural turn end arms it, descendant settlement delivers it
    /// ([`GoalDriver::take_owed_continuation`]).
    pub fn mark_continuation_owed(&mut self) {
        if self.pending_continuation() {
            return;
        }
        self.owed_continuation_for_rlm_work = true;
    }

    #[must_use]
    pub fn owes_continuation(&self) -> bool {
        self.owed_continuation_for_rlm_work
    }

    /// Deliver the owed continuation once, consuming one slot: an inactive
    /// goal drops the deferral, a live one mints; a failed mint restores it.
    ///
    /// # Errors
    ///
    /// Returns the mint error of the owed continuation.
    pub fn take_owed_continuation(
        &mut self,
        session: &mut SessionManager,
        last_turn: Option<&pa_agent::types::AssistantMessage>,
    ) -> anyhow::Result<Option<CustomMessage>> {
        let owed = self.owed_continuation_for_rlm_work;
        if !owed {
            return Ok(None);
        }
        if self.pending_continuation() {
            return Ok(None);
        }
        self.owed_continuation_for_rlm_work = false;
        match self.next_continuation_message(session, last_turn) {
            Ok(None) => {
                // A refusal drops the deferral for an inactive goal; a live
                // goal in backoff keeps it, so a later boundary still delivers.
                if self.state.status == GoalStatus::Active {
                    self.owed_continuation_for_rlm_work = true;
                }
                Ok(None)
            }
            Ok(message) => Ok(message),
            Err(error) => {
                self.owed_continuation_for_rlm_work = true;
                Err(error)
            }
        }
    }

    /// The surface admitted the minted continuation: the pending guard
    /// releases, so the next boundary may mint again.
    pub fn continuation_consumed(&mut self) {
        self.pending_continuation
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether a minted continuation is still waiting for its surface's
    /// admission (the pending-never-re-arms guard).
    #[must_use]
    pub fn pending_continuation(&self) -> bool {
        self.pending_continuation
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The pending guard's lock-free handle: admission surfaces that cannot
    /// take the async driver lock release the guard through it.
    #[must_use]
    pub fn pending_continuation_handle(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        std::sync::Arc::clone(&self.pending_continuation)
    }

    /// Arm the pending guard: one minted continuation is owed to the
    /// calling surface until it admits the turn.
    fn mark_continuation_pending(&mut self) {
        self.pending_continuation
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Roll back one just-minted continuation: the next boundary
    /// re-mints instead of double-counting.
    ///
    /// # Errors
    ///
    /// Returns an error when the rolled-back goal state cannot be persisted.
    pub fn rollback_continuation_mint(
        &mut self,
        session: &mut SessionManager,
    ) -> anyhow::Result<()> {
        if self.state.continuations_used == 0 {
            // The rolled-back mint never reaches a turn: the pending guard releases with the slot.
            self.continuation_consumed();
            return Ok(());
        }
        let rolled_back = self.set_state(
            session,
            GoalState {
                continuations_used: self.state.continuations_used - 1,
                ..self.state.clone()
            },
        );
        // The pending guard releases on both outcomes. The CALLER must drop
        // the re-owe on that failure: the slot stays spent.
        self.continuation_consumed();
        rolled_back
    }

    /// The current consecutive-no-output-turn streak; the in-module
    /// tests read it directly.
    #[cfg(test)]
    #[must_use]
    pub fn no_progress_streak(&self) -> u32 {
        self.no_progress_streak
    }

    /// The armed backoff window's deadline, when the goal is Active and the
    /// window is open: the daemon's boundary sites schedule a wake here.
    #[must_use]
    pub fn backoff_wake_at(&self) -> Option<u64> {
        let until = self.no_progress_backoff_until_ms;
        (self.state.status == GoalStatus::Active && until > now_millis()).then_some(until)
    }

    #[must_use]
    pub fn owns_continuation_wakeup(&self) -> bool {
        self.state.status == GoalStatus::Active && self.state.objective.is_some()
    }

    #[must_use]
    pub fn active_objective(&self) -> Option<String> {
        (self.state.status == GoalStatus::Active)
            .then(|| self.state.objective.clone())
            .flatten()
    }
}

impl Default for GoalDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests;
