//! The goal driver: goal-state lifecycle, usage accounting, budget limits,
//! and continuation context. Port of the goal machinery in agent-session.ts
//! (the `_goalState` half), with persistence via `thread_goal_state` custom
//! entries and the branch-seed/reload rules.

use pa_types::session::CustomMessage;

use super::provider_retry::provider_stream_failure_kind;
use crate::goals::{
    create_goal_context_message, empty_goal_state, goal_token_delta_for_usage,
    normalize_goal_state, validate_goal_budget, validate_goal_objective, GoalContextKind,
    GoalState, GoalStatus, GOAL_STATE_CUSTOM_TYPE,
};
use crate::session::manager::SessionManager;

/// The goal-state reload rule at a branch rebuild (TS
/// `_reloadGoalStateFromBranch`'s `monotonicTokens` option): a context
/// rebuild with a summary continues the same timeline, a plain branch
/// move is time travel and keeps faithful branch semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalBranchReload {
    /// A summary context rebuild (compaction-style cut): the rebuilt
    /// branch's last persisted goal entry can lag the in-memory state
    /// (queue/flush races; child-usage attribution landing late), so the
    /// same goal's accounting counters clamp to the max and its status or
    /// an already-fired gate (budget limit, pause, completion) never
    /// regresses across the cold boundary. A different goal adopts
    /// faithfully.
    SameTimeline,
    /// A plain branch move (tree navigation without a summary): the moved
    /// branch's own latest persisted goal state adopts as-is, even when
    /// it is older — the goal state follows the branch cut.
    FaithfulBranch,
}

/// Wall-clock accounting anchor for time-used attribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct AccountingStartedAt(pub u64);

/// What happened after accounting one assistant turn's usage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageOutcome {
    Accounted,
    /// The goal hit its token budget and moved to `budget_limited`.
    BudgetReached,
    /// The goal was not active; usage was ignored.
    Ignored,
}

pub struct GoalDriver {
    state: GoalState,
    accounting_started_at: Option<AccountingStartedAt>,
    /// Ids of assistant messages already counted (double-counting guard).
    accounted_messages: std::collections::HashSet<String>,
    /// TS `_goalContinuationAwaitsRlmWork`: a continuation is owed behind
    /// unsettled RLM descendant work. In-memory only (never persisted,
    /// never rehydrated): descendant quiescence is a live-session fact.
    owed_continuation_for_rlm_work: bool,
    /// The consecutive-no-progress continuation bookkeeping (the hot-loop
    /// killer, the 402 diagnosis's (b)): a mint consult that finds the
    /// just-settled turn produced no output counts once (keyed by the
    /// turn's timestamp), arms the doubling backoff window, and at the
    /// cap finishes the goal. A progress turn resets the streak. In-memory
    /// only: the restart paths are guarded by the stale-row handling at
    /// rehydration and the mint's own progress check re-derives from the
    /// just-settled turn.
    no_progress_streak: u32,
    no_progress_backoff_until_ms: u64,
    counted_no_progress_turn_ms: Option<i64>,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// How many consecutive no-output turns the continuation mint tolerates
/// before the goal finishes (the 402 diagnosis's small cap).
const CONTINUATION_NO_PROGRESS_CAP: u32 = 3;

/// The backoff base for consecutive no-output turns (10s, 20s, 40s ...):
/// each retry of a no-progress continuation waits twice as long.
const CONTINUATION_NO_PROGRESS_BACKOFF_BASE_MS: u64 = 10_000;

/// The just-settled turn's provider-failure text when the turn settled
/// as a terminal provider failure (stop reason `error`, with a recorded
/// stream failure that is not the quota-park class — the parked turn is
/// the park's pause, not the goal's death). `None` for healthy, aborted,
/// or parked turns.
pub fn terminal_provider_failure(message: &pa_agent::types::AssistantMessage) -> Option<String> {
    if message.stop_reason != pa_agent::types::StopReason::Error {
        return None;
    }
    if provider_stream_failure_kind(message).as_deref() == Some("rate_limit") {
        return None;
    }
    Some(
        message
            .error_message
            .clone()
            .filter(|error| !error.is_empty())
            .unwrap_or_else(|| "Assistant response failed".to_string()),
    )
}

impl GoalDriver {
    pub fn new() -> Self {
        Self {
            state: empty_goal_state(),
            accounting_started_at: None,
            accounted_messages: std::collections::HashSet::default(),
            owed_continuation_for_rlm_work: false,
            no_progress_streak: 0,
            no_progress_backoff_until_ms: 0,
            counted_no_progress_turn_ms: None,
        }
    }

    /// Rehydrate the driver from the session branch (latest persisted
    /// entry). The restore-resurrection guard (the 402 diagnosis's (d)):
    /// an `active` newest row whose trailing turn failed on a provider
    /// error (the terminal finish never persisted — a worker death or
    /// restart interrupted the settle) adopts the failure as the goal's
    /// terminal state instead of resurrecting the loop; the resume sites
    /// then deliver no continuations into the dead provider.
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

    /// The branch's latest valid persisted goal state (TS
    /// `_loadPersistedGoalState`: newest-first scan over the branch's
    /// custom entries; `emptyGoalState()` when no valid entry exists).
    pub fn latest_persisted_state(session: &SessionManager) -> GoalState {
        session.active_goal_state().unwrap_or_else(empty_goal_state)
    }

    /// Reload the goal state from the session's current branch (TS
    /// `_reloadGoalStateFromBranch` at the `_navigateTree` tail): the
    /// branch's latest persisted entry adopts under [`rule`], and the
    /// wall-clock anchor restarts like the TS `_goalAccountingStartedAt`
    /// reset (active goals re-anchor at the reload; everything else drops
    /// the anchor).
    pub fn reload_from_branch(&mut self, session: &SessionManager, rule: GoalBranchReload) {
        let previous = self.state.clone();
        let reloaded = Self::latest_persisted_state(session);
        self.state = match rule {
            GoalBranchReload::SameTimeline
                if reloaded.goal_id.is_some() && reloaded.goal_id == previous.goal_id =>
            {
                // The counters clamp to the max; every other field (status,
                // objective, budget, an already-fired gate) keeps the
                // in-memory state, mirroring the TS `{ ...previous, max }`
                // spread (both sides are normalized, so `active` stays
                // consistent with the kept status).
                GoalState {
                    tokens_used: previous.tokens_used.max(reloaded.tokens_used),
                    continuations_used: previous
                        .continuations_used
                        .max(reloaded.continuations_used),
                    time_used_seconds: previous.time_used_seconds.max(reloaded.time_used_seconds),
                    ..previous
                }
            }
            _ => reloaded,
        };
        self.accounting_started_at =
            (self.state.status == GoalStatus::Active).then_some(AccountingStartedAt(now_millis()));
    }

    /// Adopt an already-persisted goal state without re-persisting it: a
    /// recovery rebuild continues the durable state verbatim (the
    /// `thread_goal_state` row already records it, and the accounting
    /// anchor restarts wall-clock attribution like the TS constructor's
    /// `_goalState = this._loadPersistedGoalState()`).
    pub fn restore_persisted(state: GoalState) -> Self {
        let mut driver = Self::new();
        driver.restore_from_persisted(state);
        driver
    }

    /// [`GoalDriver::restore_persisted`]'s in-place form, for the driver
    /// behind the session's shared handle: adopts the persisted state and
    /// restarts the wall-clock anchor, never re-persisting (the durable
    /// row already exists) and never resetting the per-message
    /// double-counting guard (a fresh build starts it empty anyway).
    pub fn restore_from_persisted(&mut self, state: GoalState) {
        self.state = normalize_goal_state(state);
        self.accounting_started_at =
            (self.state.status == GoalStatus::Active).then_some(AccountingStartedAt(now_millis()));
    }

    pub fn state(&self) -> &GoalState {
        &self.state
    }

    /// Whether the branch may be seeded with an initial goal: only bootstrap
    /// entries (model/thinking changes) and no prior persisted goal.
    pub fn is_branch_seedable(session: &SessionManager) -> bool {
        !session.has_non_bootstrap_entries()
    }

    /// Start a new goal (validates objective and budget).
    ///
    /// # Errors
    ///
    /// Returns an error when the objective or budget fails validation, or
    /// when the new goal state cannot be persisted.
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
            updated_at: Some(now),
            last_reason: None,
            last_error: None,
        };
        let previous_anchor = self.accounting_started_at;
        let previous_accounted = std::mem::take(&mut self.accounted_messages);
        let previous_owed = self.owed_continuation_for_rlm_work;
        self.accounting_started_at = Some(AccountingStartedAt(now));
        // TS `_startGoal`: a fresh goal starts with no owed continuation.
        self.owed_continuation_for_rlm_work = false;
        if let Err(error) = self.set_state(session, goal) {
            // A failed start leaves the previous accounting intact.
            self.accounting_started_at = previous_anchor;
            self.accounted_messages = previous_accounted;
            self.owed_continuation_for_rlm_work = previous_owed;
            return Err(error);
        }
        Ok(self.state.clone())
    }

    /// Clear the goal entirely (empty state).
    ///
    /// # Errors
    ///
    /// Returns an error when the cleared goal state cannot be persisted.
    pub fn clear(&mut self, session: &mut SessionManager) -> anyhow::Result<()> {
        self.set_state(session, empty_goal_state())?;
        self.accounting_started_at = None;
        // TS `_clearGoal` routes through `_clearQueuedGoalContexts`, which
        // drops any owed continuation with the queued contexts.
        self.owed_continuation_for_rlm_work = false;
        Ok(())
    }

    /// Time-used attribution: fold wall-clock time since accounting started.
    fn with_accounted_wall_clock(&self) -> GoalState {
        let Some(started) = self.accounting_started_at else {
            return self.state.clone();
        };
        let elapsed_seconds = now_millis().saturating_sub(started.0) / 1000;
        GoalState {
            time_used_seconds: self.state.time_used_seconds + elapsed_seconds,
            ..self.state.clone()
        }
    }

    fn set_state(&mut self, session: &mut SessionManager, next: GoalState) -> anyhow::Result<()> {
        let normalized = normalize_goal_state(GoalState {
            updated_at: Some(now_millis()),
            ..next
        });
        let value = serde_json::to_value(&normalized)?;
        session.append_custom_entry(GOAL_STATE_CUSTOM_TYPE, Some(value))?;
        session.flush_now()?;
        // Anchor accounting only once the state is durable: a failed resume
        // must not start charging wall-clock against a paused goal.
        if normalized.status == GoalStatus::Active {
            self.accounting_started_at
                .get_or_insert(AccountingStartedAt(now_millis()));
        } else {
            self.accounting_started_at = None;
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
        let goal = self.with_accounted_wall_clock();
        let next_goal = GoalState {
            tokens_used: goal.tokens_used + token_delta,
            ..goal
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
        // Account the message only after the durable write lands.
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
        let goal = self.with_accounted_wall_clock();
        self.set_state(
            session,
            GoalState {
                active: false,
                status: GoalStatus::Paused,
                last_reason: Some(reason.to_string()),
                last_error: None,
                ..goal
            },
        )?;
        // TS `_pauseGoal` routes through `_clearQueuedGoalContexts`, which
        // drops any owed continuation with the queued contexts — after the
        // durable write, so a failed persist keeps the previous goal's
        // deferral exactly as it was.
        self.owed_continuation_for_rlm_work = false;
        Ok(())
    }

    /// Resume a paused/budget-limited goal. Returns the continuation context
    /// message when the goal becomes active again.
    ///
    /// # Errors
    ///
    /// Returns an error when the resumed goal state or its continuation
    /// message cannot be persisted.
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
                // TS `_resumeGoal`: the reason is only set for an exhausted
                // budget (which stays budget_limited); a live resume clears it.
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
        let goal = self.with_accounted_wall_clock();
        self.set_state(
            session,
            GoalState {
                active: false,
                status: GoalStatus::Complete,
                last_reason: Some("Goal achieved".to_string()),
                last_error: None,
                ..goal
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
            let goal = self.with_accounted_wall_clock();
            self.set_state(
                session,
                GoalState {
                    active: false,
                    status: GoalStatus::Error,
                    last_reason: Some(reason.to_string()),
                    last_error: Some(reason.to_string()),
                    ..goal
                },
            )?;
        }
        Ok(())
    }

    /// Build the next continuation context, consuming one continuation
    /// slot. The state change persists (TS `_getGoalContinuationMessages`
    /// and `_maybeResumeGoalContinuationAfterRlmWork` both run the mint
    /// through `_setGoalState`, which appends the `thread_goal_state`
    /// entry before the continuation turn is admitted).
    ///
    /// # Errors
    ///
    /// Returns an error when the continuation-consumed goal state or its
    /// context message cannot be persisted or built.
    pub fn next_continuation_message(
        &mut self,
        session: &mut SessionManager,
        last_turn: Option<&pa_agent::types::AssistantMessage>,
    ) -> anyhow::Result<Option<CustomMessage>> {
        if self.state.status != GoalStatus::Active || self.state.objective.is_none() {
            return Ok(None);
        }
        // SANCTIONED DIVERGENCE (the 402 diagnosis, operator ruling): the
        // mint checks progress. TS `_getGoalContinuationMessages` mints
        // whenever the goal is Active — whether the previous turn
        // produced 2,000 tokens of work or an empty 402 corpse is
        // invisible to it, so a dead provider drove the operator's
        // 64-continuation hot loop. The just-settled turn now gates the
        // mint: a provider failure finishes the goal (mirroring
        // `finish_for_terminal_message`), a no-output turn counts toward
        // the consecutive cap with backoff, and only a turn that produced
        // output continues the loop.
        if let Some(turn) = last_turn {
            if let Some(error) = terminal_provider_failure(turn) {
                self.finish_for_terminal_message(
                    session,
                    pa_types::ai::StopReason::Error,
                    Some(&error),
                )?;
                return Ok(None);
            }
            if turn.content.is_empty() {
                // The turn produced no output: a corpse that is not a
                // provider failure (an abort conversion, a degenerate
                // empty settle) still made no progress. Count the turn
                // once and arm the doubling backoff window — this
                // consult refuses, and a later boundary after the window
                // passes re-mints (the fall-through consult of the SAME
                // turn only checks the gate). At the cap the goal
                // finishes: the loop-killer for EVERY survival arm, not
                // just the engine's error arm.
                if self.counted_no_progress_turn_ms != Some(turn.timestamp) {
                    self.counted_no_progress_turn_ms = Some(turn.timestamp);
                    self.no_progress_streak += 1;
                    self.no_progress_backoff_until_ms = now_millis()
                        + CONTINUATION_NO_PROGRESS_BACKOFF_BASE_MS
                            * 2u64.saturating_pow(self.no_progress_streak.saturating_sub(1));
                    if self.no_progress_streak >= CONTINUATION_NO_PROGRESS_CAP {
                        let goal = self.with_accounted_wall_clock();
                        let reason =
                            "Goal continuation cap reached: consecutive turns made no progress"
                                .to_string();
                        self.set_state(
                            session,
                            GoalState {
                                active: false,
                                status: GoalStatus::Error,
                                last_reason: Some(reason.clone()),
                                last_error: Some(reason),
                                ..goal
                            },
                        )?;
                        return Ok(None);
                    }
                    return Ok(None);
                }
                // An already-counted turn falls through to the backoff
                // gate below: once the window passes, the mint retries
                // (the retry's own turn counts again if it too makes no
                // progress).
            } else {
                // The turn produced output: the streak resets and any
                // armed backoff window clears.
                self.no_progress_streak = 0;
                self.no_progress_backoff_until_ms = 0;
                self.counted_no_progress_turn_ms = Some(turn.timestamp);
            }
        }
        // The backoff gate: a consult inside the window mints nothing;
        // the next boundary after the window re-mints (the goal stays
        // Active — this is a delay, not a death).
        if now_millis() < self.no_progress_backoff_until_ms {
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
        Ok(create_goal_context_message(&self.state, GoalContextKind::Continuation).ok())
    }

    /// TS `_getGoalContinuationMessages`'s quiescence arm: the natural
    /// turn end defers the continuation while descendant RLM work is
    /// unsettled. The mint consumes nothing while it waits; descendant
    /// settlement delivers it (`take_owed_continuation`).
    pub fn mark_continuation_owed(&mut self) {
        self.owed_continuation_for_rlm_work = true;
    }

    /// Whether a continuation is currently owed behind descendant work
    /// (TS `_goalContinuationAwaitsRlmWork`).
    pub fn owes_continuation(&self) -> bool {
        self.owed_continuation_for_rlm_work
    }

    /// TS `_maybeResumeGoalContinuationAfterRlmWork`: deliver the owed
    /// continuation once, consuming one slot. Clears the flag — an
    /// inactive goal drops the deferral (minting nothing), a live one
    /// mints; a failed mint restores the deferral so the boundary
    /// retries. `None` when no continuation was owed or the goal
    /// cannot mint.
    ///
    /// # Errors
    ///
    /// Returns the mint error of the owed continuation (the deferral is
    /// restored for the next boundary).
    pub fn take_owed_continuation(
        &mut self,
        session: &mut SessionManager,
        last_turn: Option<&pa_agent::types::AssistantMessage>,
    ) -> anyhow::Result<Option<CustomMessage>> {
        let owed = self.owed_continuation_for_rlm_work;
        self.owed_continuation_for_rlm_work = false;
        if !owed {
            return Ok(None);
        }
        match self.next_continuation_message(session, last_turn) {
            Ok(None) => {
                // The mint refused for progress reasons (the goal
                // finished, or the backoff window): an inactive goal
                // drops the deferral (TS); a live goal in backoff keeps
                // it, so a later boundary after the window still
                // delivers the owed continuation.
                if self.state.status == GoalStatus::Active {
                    self.owed_continuation_for_rlm_work = true;
                }
                Ok(None)
            }
            Ok(message) => Ok(message),
            Err(error) => {
                // A failed mint (the durable continuation slot never landed)
                // restores the deferral: the natural boundary retries instead
                // of silently dropping the owed continuation.
                self.owed_continuation_for_rlm_work = true;
                Err(error)
            }
        }
    }

    /// Roll back one just-minted continuation (TS `_getContinuationMessages`
    /// restores the goal snapshot when new session input arrived during the
    /// mint; the threshold-cancel rollback decrements the same way): the
    /// next boundary re-mints instead of double-counting.
    ///
    /// # Errors
    ///
    /// Returns an error when the rolled-back goal state cannot be
    /// persisted.
    pub fn rollback_continuation_mint(
        &mut self,
        session: &mut SessionManager,
    ) -> anyhow::Result<()> {
        if self.state.continuations_used == 0 {
            return Ok(());
        }
        self.set_state(
            session,
            GoalState {
                continuations_used: self.state.continuations_used - 1,
                ..self.state.clone()
            },
        )
    }

    /// Whether the goal drives session wake-ups.
    pub fn owns_continuation_wakeup(&self) -> bool {
        self.state.status == GoalStatus::Active && self.state.objective.is_some()
    }

    /// The active objective, when set and active.
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
mod tests {
    use super::*;
    use crate::goals::MAX_THREAD_GOAL_OBJECTIVE_CHARS;
    use crate::session::manager::SessionManager;
    use pa_types::ai::UserContent;
    use std::fmt::Write as _;

    fn persisted_session() -> SessionManager {
        let dir = tempfile::TempDir::new().unwrap();
        let session_dir = dir.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut session = SessionManager::in_memory(dir.path());
        session.materialize_session_file(Some(session_dir));
        session
    }

    /// A failed provider turn in the pa-agent wire shape (the mint's
    /// progress-check input), carrying the `provider_stream_failure`
    /// diagnostic the classification reads.
    fn test_error_turn(
        kind: &str,
        status: Option<u16>,
        error: &str,
    ) -> pa_agent::types::AssistantMessage {
        pa_agent::types::AssistantMessage {
            content: Vec::new(),
            api: String::new(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: Some(vec![pa_agent::types::AssistantMessageDiagnostic {
                kind: "provider_stream_failure".to_string(),
                timestamp: 0,
                error: None,
                details: Some(serde_json::json!({
                    "kind": kind,
                    "status": status,
                })),
            }]),
            usage: pa_agent::types::Usage::zero(),
            stop_reason: pa_agent::types::StopReason::Error,
            stop_reason_raw: None,
            error_message: Some(error.to_string()),
            timestamp: 0,
        }
    }

    /// A turn that settled without output and without a provider failure
    /// (an abort conversion's corpse, or a degenerate empty settle).
    fn test_empty_turn(timestamp: i64) -> pa_agent::types::AssistantMessage {
        pa_agent::types::AssistantMessage {
            content: Vec::new(),
            api: String::new(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_agent::types::Usage::zero(),
            stop_reason: pa_agent::types::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp,
        }
    }

    /// A turn that produced output: progress.
    fn test_progress_turn(timestamp: i64) -> pa_agent::types::AssistantMessage {
        pa_agent::types::AssistantMessage {
            content: vec![pa_agent::types::AssistantContent::Text(
                pa_agent::types::TextContent {
                    text: "made progress".to_string(),
                    text_signature: None,
                },
            )],
            api: String::new(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_agent::types::Usage::zero(),
            stop_reason: pa_agent::types::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp,
        }
    }

    /// A failed provider turn in the session wire shape (the durable
    /// row the stale-row scan reads).
    fn wire_error_turn(
        kind: &str,
        status: Option<u16>,
        error: &str,
        timestamp: u64,
    ) -> pa_types::ai::AssistantMessage {
        pa_types::ai::AssistantMessage {
            content: Vec::new(),
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: Some(vec![pa_types::ai::AssistantMessageDiagnostic {
                type_: "provider_stream_failure".to_string(),
                timestamp: 0,
                error: None,
                details: Some(
                    serde_json::json!({
                        "kind": kind,
                        "status": status,
                    })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                ),
            }]),
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::Error,
            stop_reason_raw: None,
            error_message: Some(error.to_string()),
            timestamp,
            rest: serde_json::Map::default(),
        }
    }

    fn usage(input: u64, output: u64) -> pa_types::ai::Usage {
        pa_types::ai::Usage {
            input,
            output,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn compacted_goal_restore_and_mutation_do_not_hydrate_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("goal.jsonl");
        let expected = GoalState {
            active: true,
            status: GoalStatus::Active,
            goal_id: Some("goal".to_owned()),
            objective: Some("finish work".to_owned()),
            tokens_used: 17,
            ..empty_goal_state()
        };
        let rows = [
            serde_json::json!({"type":"session","version":3,"id":"s","cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
            serde_json::json!({"type":"custom","id":"goal","parentId":null,"customType":GOAL_STATE_CUSTOM_TYPE,"data":expected}),
            serde_json::json!({"type":"message","id":"old","parentId":"goal","message":{"role":"user","content":"old history","timestamp":0}}),
            serde_json::json!({"type":"message","id":"kept","parentId":"old","message":{"role":"user","content":"retained","timestamp":0}}),
            serde_json::json!({"type":"compaction","id":"compact","parentId":"kept","summary":"summary","firstKeptEntryId":"kept","tokensBefore":1000}),
            serde_json::json!({"type":"custom","id":"invalid","parentId":"compact","customType":GOAL_STATE_CUSTOM_TYPE,"data":{"active":true}}),
        ];
        let original: String = rows.iter().fold(String::new(), |mut output, row| {
            let _ = writeln!(output, "{row}");
            output
        });
        std::fs::write(&path, &original).unwrap();
        let mut session = SessionManager::open_windowed(dir.path(), dir.path(), &path)
            .await
            .unwrap();
        assert!(!session.is_full_history());
        assert!(!GoalDriver::is_branch_seedable(&session));
        let mut driver = GoalDriver::load_persisted(&session);
        assert_eq!(driver.state(), &expected);
        driver.pause(&mut session, "pause").unwrap();
        assert_eq!(GoalDriver::load_persisted(&session).state(), driver.state());
        assert!(!session.is_full_history());
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .starts_with(&original));
    }

    #[test]
    fn start_resume_pause_lifecycle() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        assert_eq!(driver.state(), &empty_goal_state());
        let goal = driver
            .start(&mut session, "  ship the mission  ", Some(1000))
            .unwrap();
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.objective.as_deref(), Some("ship the mission"));
        assert_eq!(goal.token_budget, Some(1000));
        assert!(goal.goal_id.is_some());
        assert!(driver.owns_continuation_wakeup());
        // Validation errors.
        assert!(driver.start(&mut session, "", None).is_err());
        let long = "x".repeat(MAX_THREAD_GOAL_OBJECTIVE_CHARS + 1);
        assert!(driver.start(&mut session, &long, None).is_err());
        assert!(driver.start(&mut session, "ok", Some(0)).is_err());
        // Pause keeps the objective; resume returns a continuation context.
        driver.pause(&mut session, "Paused by user").unwrap();
        assert_eq!(driver.state().status, GoalStatus::Paused);
        assert!(!driver.owns_continuation_wakeup());
        let continuation = driver.resume(&mut session).unwrap().unwrap();
        assert_eq!(
            continuation.custom_type,
            crate::goals::GOAL_CONTEXT_CUSTOM_TYPE
        );
        let UserContent::Text(text) = &continuation.content else {
            panic!("expected text content");
        };
        assert!(text.starts_with("[goal: continuation]"));
        // Rehydrating from the session restores the active goal.
        let reloaded = GoalDriver::load_persisted(&session);
        assert_eq!(reloaded.state().status, GoalStatus::Active);
        assert_eq!(
            reloaded.state().objective.as_deref(),
            Some("ship the mission")
        );
        // Clear resets everything.
        driver.clear(&mut session).unwrap();
        assert_eq!(driver.state().status, GoalStatus::Idle);
        assert_eq!(driver.state().objective, None);
    }

    #[test]
    fn usage_accounting_and_budget_limit() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", Some(100)).unwrap();
        assert_eq!(
            driver
                .record_assistant_usage(&mut session, "a1", &usage(30, 10))
                .unwrap(),
            UsageOutcome::Accounted
        );
        assert_eq!(driver.state().tokens_used, 40);
        // Double-counting the same message is ignored.
        assert_eq!(
            driver
                .record_assistant_usage(&mut session, "a1", &usage(30, 10))
                .unwrap(),
            UsageOutcome::Ignored
        );
        assert_eq!(driver.state().tokens_used, 40);
        // Budget reached transitions to budget_limited.
        assert_eq!(
            driver
                .record_assistant_usage(&mut session, "a2", &usage(50, 10))
                .unwrap(),
            UsageOutcome::BudgetReached
        );
        assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
        assert_eq!(
            driver.state().last_reason.as_deref(),
            Some("Reached 100 token goal budget")
        );
        // Usage while inactive is ignored.
        assert_eq!(
            driver
                .record_assistant_usage(&mut session, "a3", &usage(50, 10))
                .unwrap(),
            UsageOutcome::Ignored
        );
        // Resuming an exhausted goal stays budget_limited.
        assert!(driver.resume(&mut session).unwrap().is_none());
        assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
    }

    #[test]
    fn terminal_messages_fail_or_keep_the_goal() {
        use pa_types::ai::StopReason;
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        // Aborted keeps the goal active.
        driver
            .finish_for_terminal_message(&mut session, StopReason::Aborted, None)
            .unwrap();
        assert_eq!(driver.state().status, GoalStatus::Active);
        // Error fails it with the provided message.
        driver
            .finish_for_terminal_message(&mut session, StopReason::Error, Some("provider exploded"))
            .unwrap();
        assert_eq!(driver.state().status, GoalStatus::Error);
        assert_eq!(
            driver.state().last_error.as_deref(),
            Some("provider exploded")
        );
        // Terminal handling is inert when the goal is not active.
        driver
            .finish_for_terminal_message(&mut session, StopReason::Error, None)
            .unwrap();
        assert_eq!(driver.state().status, GoalStatus::Error);
    }

    #[test]
    fn continuations_increment() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        let first = driver
            .next_continuation_message(&mut session, None)
            .unwrap()
            .unwrap();
        let UserContent::Text(text) = &first.content else {
            panic!("expected text content");
        };
        assert!(text.contains("- status: active"));
        assert_eq!(driver.state().continuations_used, 1);
        assert!(driver
            .next_continuation_message(&mut session, None)
            .unwrap()
            .is_some());
        assert_eq!(driver.state().continuations_used, 2);
        // Inactive goals produce no continuations.
        driver.pause(&mut session, "Paused by user").unwrap();
        assert!(driver
            .next_continuation_message(&mut session, None)
            .unwrap()
            .is_none());
        // The mint persists the state change: the session branch's latest
        // goal-state entry carries the incremented count.
        driver.start(&mut session, "work again", None).unwrap();
        assert!(driver
            .next_continuation_message(&mut session, None)
            .unwrap()
            .is_some());
        assert_eq!(driver.state().continuations_used, 1);
        let reloaded = GoalDriver::load_persisted(&session);
        assert_eq!(reloaded.state().continuations_used, 1);
    }

    /// THE 402 REGRESSION (the diagnosis's (a), the repro's acceptance):
    /// the mint refuses the continuation when the just-settled turn
    /// errored, and finishes the goal with the turn's error text instead
    /// of re-prompting the dead provider. The hot loop dies at the first
    /// failed boundary.
    #[test]
    fn the_mint_refuses_and_finishes_on_an_errored_turn() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        let corpse = test_error_turn("server_error", None, "402 Payment required: wallet drained");
        assert!(driver
            .next_continuation_message(&mut session, Some(&corpse))
            .unwrap()
            .is_none());
        assert_eq!(driver.state().status, GoalStatus::Error);
        assert_eq!(
            driver.state().last_error.as_deref(),
            Some("402 Payment required: wallet drained")
        );
        assert!(!driver.owns_continuation_wakeup());
        // The refusal persisted: a reload keeps the goal dead.
        assert_eq!(
            GoalDriver::load_persisted(&session).state().status,
            GoalStatus::Error
        );
    }

    /// The quota-park class keeps the goal (TS `_finishQuotaParkedTurn`:
    /// the parked turn is the park's pause, not the goal's death): a
    /// rate-limited corpse never triggers the mint's hard finish — the
    /// goal stays Active for the park's wake. The empty parked corpse
    /// still counts toward the no-output backoff (a delay, not a death),
    /// so this consult mints nothing; the next progress turn mints
    /// normally.
    #[test]
    fn a_rate_limited_turn_keeps_the_goal_alive() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        let parked = test_error_turn("rate_limit", Some(429), "429 Too many concurrent requests");
        assert!(driver
            .next_continuation_message(&mut session, Some(&parked))
            .unwrap()
            .is_none());
        assert_eq!(driver.state().status, GoalStatus::Active);
        assert!(driver.state().last_error.is_none());
        // The park's wake turn makes progress: the mint resumes.
        let wake_progress = test_progress_turn(7);
        assert!(driver
            .next_continuation_message(&mut session, Some(&wake_progress))
            .unwrap()
            .is_some());
        assert_eq!(driver.state().continuations_used, 1);
    }

    /// The consecutive-no-output cap with backoff (the diagnosis's (b)):
    /// a turn that produced no output counts once; the consult refuses
    /// while the backoff window is armed; the third distinct no-output
    /// turn finishes the goal. A turn that produced output resets the
    /// streak.
    #[test]
    fn no_output_turns_count_to_the_cap_and_backoff() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        let empty_one = test_empty_turn(1);
        // The first no-output turn: counted, refused, the goal lives.
        assert!(driver
            .next_continuation_message(&mut session, Some(&empty_one))
            .unwrap()
            .is_none());
        assert_eq!(driver.state().status, GoalStatus::Active);
        assert_eq!(driver.state().continuations_used, 0);
        // The same turn re-consulted inside the window: still refused,
        // not re-counted.
        assert!(driver
            .next_continuation_message(&mut session, Some(&empty_one))
            .unwrap()
            .is_none());
        // A second distinct no-output turn: counted again.
        let empty_two = test_empty_turn(2);
        assert!(driver
            .next_continuation_message(&mut session, Some(&empty_two))
            .unwrap()
            .is_none());
        assert_eq!(driver.state().status, GoalStatus::Active);
        // A progress turn resets the streak and mints.
        let progress = test_progress_turn(3);
        assert!(driver
            .next_continuation_message(&mut session, Some(&progress))
            .unwrap()
            .is_some());
        assert_eq!(driver.state().continuations_used, 1);
        // Three consecutive no-output turns (the fresh streak): the
        // third hits the cap and finishes the goal.
        for timestamp in 4..=6 {
            let empty = test_empty_turn(timestamp);
            assert!(driver
                .next_continuation_message(&mut session, Some(&empty))
                .unwrap()
                .is_none());
        }
        assert_eq!(driver.state().status, GoalStatus::Error);
        assert_eq!(
            driver.state().last_reason.as_deref(),
            Some("Goal continuation cap reached: consecutive turns made no progress")
        );
        // The cap persisted: a reload keeps the goal dead.
        assert_eq!(
            GoalDriver::load_persisted(&session).state().status,
            GoalStatus::Error
        );
    }

    /// The restore-resurrection guard (the diagnosis's (d)): an active
    /// newest goal row with a terminal provider failure settled after it
    /// (the interrupted settle — the worker died before the error row
    /// persisted) adopts the failure as the goal's terminal state at
    /// rehydration instead of resurrecting the loop.
    #[test]
    fn load_persisted_adopts_the_stale_active_failure() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        // The mint's active row is the newest goal row; the corpse
        // message persists after it (message_end precedes the settle's
        // error row — the interrupted-settle ordering).
        driver
            .next_continuation_message(&mut session, None)
            .unwrap();
        session
            .append_message(pa_types::session::AgentMessage::Assistant(wire_error_turn(
                "invalid_request",
                Some(402),
                "402 Insufficient balance",
                0,
            )))
            .unwrap();
        let rehydrated = GoalDriver::load_persisted(&session);
        assert_eq!(rehydrated.state().status, GoalStatus::Error);
        assert_eq!(
            rehydrated.state().last_error.as_deref(),
            Some("402 Insufficient balance")
        );
        // The rate-limit corpse is the park's pause: the goal resurrects
        // (the park wake owns the resume).
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        driver
            .next_continuation_message(&mut session, None)
            .unwrap();
        session
            .append_message(pa_types::session::AgentMessage::Assistant(wire_error_turn(
                "rate_limit",
                Some(429),
                "429 Too many requests",
                0,
            )))
            .unwrap();
        assert_eq!(
            GoalDriver::load_persisted(&session).state().status,
            GoalStatus::Active
        );
        // A settled terminal row (the error row landed after the corpse)
        // is the newest row: no stale adoption, the error stands on its
        // own.
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        driver
            .finish_for_terminal_message(
                &mut session,
                pa_types::ai::StopReason::Error,
                Some("settled failure"),
            )
            .unwrap();
        assert_eq!(
            GoalDriver::load_persisted(&session).state().status,
            GoalStatus::Error
        );
    }

    /// TS `_getGoalContinuationMessages`'s quiescence arm and
    /// `_maybeResumeGoalContinuationAfterRlmWork`: the owed continuation
    /// waits without consuming a slot, delivers exactly once when taken,
    /// and drops for an inactive goal instead of minting.
    #[test]
    fn owed_continuation_defers_and_delivers_once() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        // Deferral: no slot consumed while the continuation waits.
        assert!(!driver.owes_continuation());
        driver.mark_continuation_owed();
        assert!(driver.owes_continuation());
        assert_eq!(driver.state().continuations_used, 0);
        // Delivery: one slot consumed, the flag clears.
        let delivered = driver
            .take_owed_continuation(&mut session, None)
            .unwrap()
            .unwrap();
        let UserContent::Text(text) = &delivered.content else {
            panic!("expected text content");
        };
        assert!(text.starts_with("[goal: continuation]"));
        assert_eq!(driver.state().continuations_used, 1);
        assert!(!driver.owes_continuation());
        // A second take (a racing settle site) delivers nothing.
        assert!(driver
            .take_owed_continuation(&mut session, None)
            .unwrap()
            .is_none());
        assert_eq!(driver.state().continuations_used, 1);
        // An inactive goal drops the deferral without minting (TS:
        // "drops the deferral for inactive goals").
        driver.mark_continuation_owed();
        driver.pause(&mut session, "Paused by user").unwrap();
        assert!(driver
            .take_owed_continuation(&mut session, None)
            .unwrap()
            .is_none());
        assert_eq!(driver.state().continuations_used, 1);
        assert!(!driver.owes_continuation());
        // Pause/clear/start reset the flag with the queued contexts.
        driver.mark_continuation_owed();
        driver.clear(&mut session).unwrap();
        assert!(!driver.owes_continuation());
        driver.start(&mut session, "again", None).unwrap();
        driver.mark_continuation_owed();
        driver.start(&mut session, "once more", None).unwrap();
        assert!(!driver.owes_continuation());
    }

    /// The mint rollback (TS `_getContinuationMessages`'s arrival-epoch
    /// restore): a rolled-back mint decrements the slot so the next
    /// boundary re-mints without double-counting.
    #[test]
    fn rollback_continuation_mint_restores_the_count() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        assert!(driver
            .next_continuation_message(&mut session, None)
            .unwrap()
            .is_some());
        assert_eq!(driver.state().continuations_used, 1);
        driver.rollback_continuation_mint(&mut session).unwrap();
        assert_eq!(driver.state().continuations_used, 0);
        // The rollback persists: the reloaded branch sees the restored
        // count (TS `_setGoalState` re-persists the snapshot).
        assert_eq!(
            GoalDriver::load_persisted(&session)
                .state()
                .continuations_used,
            0
        );
        // The next mint counts from the restored slot.
        assert!(driver
            .next_continuation_message(&mut session, None)
            .unwrap()
            .is_some());
        assert_eq!(driver.state().continuations_used, 1);
    }

    /// TS `_resumeGoal` semantics: resume continues the same goal (same
    /// id and objective, no re-creation) and only sets a reason when the
    /// budget is already exhausted.
    #[test]
    fn resume_resolves_the_existing_goal() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "ship it", None).unwrap();
        driver.pause(&mut session, "Paused by user").unwrap();
        let paused = driver.state().clone();
        assert!(driver.resume(&mut session).unwrap().is_some());
        assert_eq!(driver.state().goal_id, paused.goal_id);
        assert_eq!(driver.state().objective.as_deref(), Some("ship it"));
        assert_eq!(driver.state().status, GoalStatus::Active);
        assert!(driver.state().last_reason.is_none());
        // An exhausted budget stays budget_limited with the TS reason.
        let mut limited = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut limited, "ship it", Some(100)).unwrap();
        driver
            .record_assistant_usage(&mut limited, "a1", &usage(120, 0))
            .unwrap();
        assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
        assert!(driver.resume(&mut limited).unwrap().is_none());
        assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
        assert_eq!(
            driver.state().last_reason.as_deref(),
            Some("Goal token budget already reached")
        );
    }

    /// TS `_loadPersistedGoalState` construction rehydration: the
    /// persisted state (counts included) is adopted verbatim, wall-clock
    /// attribution restarts for an active goal, and nothing re-persists.
    #[test]
    fn restore_persisted_adopts_the_state_without_rewriting_it() {
        let state = GoalState {
            active: true,
            status: GoalStatus::Active,
            goal_id: Some("goal-1".to_string()),
            objective: Some("ship the port".to_string()),
            token_budget: Some(1000),
            tokens_used: 340,
            time_used_seconds: 12,
            continuations_used: 2,
            created_at: Some(1),
            updated_at: Some(2),
            last_reason: None,
            last_error: None,
        };
        let driver = GoalDriver::restore_persisted(state);
        assert_eq!(driver.state().status, GoalStatus::Active);
        assert_eq!(driver.state().objective.as_deref(), Some("ship the port"));
        assert_eq!(driver.state().tokens_used, 340);
        assert_eq!(driver.state().continuations_used, 2);
        assert!(driver.owns_continuation_wakeup());
        assert_eq!(driver.active_objective().as_deref(), Some("ship the port"));
        // A budget_limited state stays inactive: no wakeup, no anchor.
        let limited = GoalDriver::restore_persisted(GoalState {
            active: false,
            status: GoalStatus::BudgetLimited,
            objective: Some("ship the port".to_string()),
            continuations_used: 5,
            tokens_used: 1000,
            token_budget: Some(1000),
            ..empty_goal_state()
        });
        assert!(!limited.owns_continuation_wakeup());
        assert!(limited.active_objective().is_none());
        // The next continuation continues the persisted count.
        let mut session = persisted_session();
        let mut driver = GoalDriver::restore_persisted(GoalState {
            active: true,
            status: GoalStatus::Active,
            objective: Some("ship the port".to_string()),
            continuations_used: 2,
            ..empty_goal_state()
        });
        assert!(driver
            .next_continuation_message(&mut session, None)
            .unwrap()
            .is_some());
        assert_eq!(driver.state().continuations_used, 3);
    }

    #[test]
    fn branch_seedable_rules() {
        let mut session = persisted_session();
        assert!(GoalDriver::is_branch_seedable(&session));
        // A persisted goal means the branch is not seedable.
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        assert!(!GoalDriver::is_branch_seedable(&session));
        // Messages also block seeding.
        let mut other = persisted_session();
        other
            .append_message(pa_types::session::AgentMessage::User(
                pa_types::ai::UserMessage {
                    content: UserContent::Text("hi".to_string()),
                    timestamp: 0,
                    rest: serde_json::Map::default(),
                },
            ))
            .unwrap();
        assert!(!GoalDriver::is_branch_seedable(&other));
    }

    /// Append one raw `thread_goal_state` row (the TS test seam
    /// `sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, ...)`)
    /// so a reload can observe a branch entry the driver did not write
    /// through its own state machine.
    fn append_goal_row(session: &mut SessionManager, state: &GoalState) {
        let value = serde_json::to_value(state).unwrap();
        session
            .append_custom_entry(GOAL_STATE_CUSTOM_TYPE, Some(value))
            .unwrap();
    }

    /// TS `agent-session-goal.test.ts` "reloads the goal state from the
    /// branch after a summary context rebuild" (the monotonic arm): a
    /// stale same-goal snapshot never regresses the accounting, while a
    /// plain branch move stays faithful to the branch even when lower.
    #[test]
    fn same_timeline_reload_never_regresses_the_same_goal() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "do work", None).unwrap();
        let goal_id = driver.state().goal_id.clone();
        assert_eq!(driver.state().status, GoalStatus::Active);

        // Bill usage through the same path a real assistant message uses.
        assert_eq!(
            driver
                .record_assistant_usage(&mut session, "a1", &usage(40, 10))
                .unwrap(),
            UsageOutcome::Accounted
        );
        assert!(driver.state().tokens_used >= 50);

        // Simulate a stale persisted snapshot for the SAME goal: an older
        // accounting entry re-persisted after the newer usage (queue/flush
        // race, or child-usage attribution landing after the branch write).
        append_goal_row(
            &mut session,
            &GoalState {
                tokens_used: 1,
                continuations_used: 0,
                time_used_seconds: 0,
                ..driver.state().clone()
            },
        );

        // A summary navigation (compaction) continues the same timeline:
        // the same goal's accounting must not regress to the stale row.
        driver.reload_from_branch(&session, GoalBranchReload::SameTimeline);
        assert_eq!(driver.state().status, GoalStatus::Active);
        assert_eq!(driver.state().goal_id, goal_id);
        assert!(driver.state().tokens_used >= 50);

        // Plain branch moves are time travel and stay faithful to the
        // branch's last persisted entry, even when it is lower.
        driver.reload_from_branch(&session, GoalBranchReload::FaithfulBranch);
        assert_eq!(driver.state().goal_id, goal_id);
        assert_eq!(driver.state().tokens_used, 1);
    }

    /// TS `agent-session-goal.test.ts` "keeps a fired budget gate
    /// monotonic across summary context rebuilds": the gate that already
    /// fired survives the same-timeline reload and the counter never
    /// regresses.
    #[test]
    fn same_timeline_reload_keeps_a_fired_budget_gate() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "do work", Some(100)).unwrap();
        let goal_id = driver.state().goal_id.clone();

        // Bill usage until the budget gate fires.
        assert_eq!(
            driver
                .record_assistant_usage(&mut session, "a1", &usage(60, 50))
                .unwrap(),
            UsageOutcome::BudgetReached
        );
        assert_eq!(driver.state().status, GoalStatus::BudgetLimited);

        // A stale branch snapshot for the same goal predates the gate.
        append_goal_row(
            &mut session,
            &GoalState {
                active: true,
                status: GoalStatus::Active,
                tokens_used: 10,
                ..driver.state().clone()
            },
        );

        // A summary rebuild continues the same timeline: the gate that
        // already fired must survive, and the counter must not regress.
        driver.reload_from_branch(&session, GoalBranchReload::SameTimeline);
        assert_eq!(driver.state().status, GoalStatus::BudgetLimited);
        assert_eq!(driver.state().goal_id, goal_id);
        assert!(driver.state().tokens_used >= 110);
    }

    /// A different goal on the moved branch adopts faithfully even under
    /// the same-timeline rule (TS clamps only
    /// `reloaded.goalId === previous.goalId`).
    #[test]
    fn same_timeline_reload_adopts_a_different_goal_faithfully() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "first goal", None).unwrap();
        assert_eq!(
            driver
                .record_assistant_usage(&mut session, "a1", &usage(40, 10))
                .unwrap(),
            UsageOutcome::Accounted
        );

        // The moved branch carries another goal with lower counters.
        append_goal_row(
            &mut session,
            &GoalState {
                active: true,
                status: GoalStatus::Active,
                goal_id: Some("other-goal".to_string()),
                objective: Some("second goal".to_string()),
                tokens_used: 3,
                continuations_used: 0,
                time_used_seconds: 0,
                ..empty_goal_state()
            },
        );
        driver.reload_from_branch(&session, GoalBranchReload::SameTimeline);
        assert_eq!(driver.state().goal_id.as_deref(), Some("other-goal"));
        assert_eq!(driver.state().objective.as_deref(), Some("second goal"));
        assert_eq!(driver.state().tokens_used, 3);

        // A newer persisted state adopts faithfully as well: the branch's
        // own row wins on both arms when the ids differ.
        append_goal_row(
            &mut session,
            &GoalState {
                active: true,
                status: GoalStatus::Active,
                goal_id: Some("other-goal".to_string()),
                objective: Some("second goal".to_string()),
                tokens_used: 500,
                continuations_used: 4,
                time_used_seconds: 9,
                ..empty_goal_state()
            },
        );
        driver.reload_from_branch(&session, GoalBranchReload::FaithfulBranch);
        assert_eq!(driver.state().tokens_used, 500);
        assert_eq!(driver.state().continuations_used, 4);
        assert_eq!(driver.state().time_used_seconds, 9);
    }

    /// The reload's newest-first scan skips invalid rows (TS
    /// `isPersistedGoalState` guard) and the empty state is the
    /// no-entry fallthrough; the wall-clock anchor follows the reloaded
    /// status like the TS `_goalAccountingStartedAt` reset.
    #[test]
    fn reload_skips_invalid_rows_and_restarts_the_anchor() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "do work", None).unwrap();

        // An invalid row (missing the counters) lands after the valid one:
        // the scan skips it and keeps the branch's last VALID entry.
        session
            .append_custom_entry(
                GOAL_STATE_CUSTOM_TYPE,
                Some(serde_json::json!({
                    "active": true,
                    "status": "active",
                })),
            )
            .unwrap();
        driver.reload_from_branch(&session, GoalBranchReload::FaithfulBranch);
        assert_eq!(driver.state().status, GoalStatus::Active);
        assert!(driver.state().goal_id.is_some());
        assert!(driver.accounting_started_at.is_some());

        // A branch without any goal entry reloads to the empty state and
        // drops the anchor.
        let mut fresh = persisted_session();
        fresh
            .append_message(pa_types::session::AgentMessage::User(
                pa_types::ai::UserMessage {
                    content: UserContent::Text("no goal here".to_string()),
                    timestamp: 0,
                    rest: serde_json::Map::default(),
                },
            ))
            .unwrap();
        driver.reload_from_branch(&fresh, GoalBranchReload::FaithfulBranch);
        assert_eq!(driver.state(), &empty_goal_state());
        assert!(driver.accounting_started_at.is_none());
    }
}
