//! The goal driver: goal-state lifecycle, usage accounting, budget limits,
//! and continuation context. Port of the goal machinery in agent-session.ts
//! (the `_goalState` half), with persistence via `thread_goal_state` custom
//! entries and the branch-seed/reload rules.

use pa_types::session::CustomMessage;

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

/// The goal timer's contract (operator ruling 2026-09-28):
/// `time_used_seconds` is the goal's AGE — the plain wall clock since
/// the goal's creation, computed fresh from `created_at` on every read.
/// Nothing folds and nothing accumulates: the pre-ruling
/// `accounting_started_at` anchor compounded each accounting write's
/// elapsed-since-anchor onto the persisted `time_used_seconds` (the
/// operator's 2h-old goal read 73h; the orchestrator's 1.4h goal read
/// 242.8h across 388 persisted rows), so the anchor machinery is deleted
/// entirely — `created_at` is set once at [`GoalDriver::start`] and never
/// re-based, making the stale-anchor class structurally impossible.
///
/// TS divergence (agent-session.ts `_goalWithAccountedWallClock`): TS
/// re-baselines an `_goalAccountingStartedAt` anchor at each accounting
/// fold and charges only active-status wall clock. The creation-based
/// ruling is simpler and deliberately different: a paused or idle goal
/// still displays its age, and the timer never depends on any anchor.
pub fn creation_elapsed_seconds(created_at: Option<u64>, now: u64) -> u64 {
    created_at.map_or(0, |created| now.saturating_sub(created) / 1000)
}

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
    /// Ids of assistant messages already counted (double-counting guard).
    accounted_messages: std::collections::HashSet<String>,
    /// TS `_goalContinuationAwaitsRlmWork`: a continuation is owed behind
    /// unsettled RLM descendant work. In-memory only (never persisted,
    /// never rehydrated): descendant quiescence is a live-session fact.
    owed_continuation_for_rlm_work: bool,
    /// A minted continuation its surface has not admitted yet. While set,
    /// no mint site mints or re-arms another (the
    /// pending-never-re-arms contract: exactly one continuation per owed
    /// boundary — a queued-but-unconsumed continuation never duplicates).
    /// The surface releases it at admission
    /// ([`GoalDriver::continuation_consumed`]); a rollback or a goal
    /// going inactive drops it with the mint. In-memory only (never
    /// persisted, never rehydrated). An atomic behind an [`Arc`] so
    /// admission surfaces that cannot take the async driver lock (a
    /// spawned settle task, a nested `block_on`) release it through
    /// [`GoalDriver::pending_continuation_handle`].
    pending_continuation: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

impl GoalDriver {
    pub fn new() -> Self {
        Self {
            state: empty_goal_state(),
            accounted_messages: std::collections::HashSet::default(),
            owed_continuation_for_rlm_work: false,
            pending_continuation: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Rehydrate the driver from the session branch (latest persisted entry).
    pub fn load_persisted(session: &SessionManager) -> Self {
        Self::restore_persisted(Self::latest_persisted_state(session))
    }

    /// The branch's latest valid persisted goal state (TS
    /// `_loadPersistedGoalState`: newest-first scan over the branch's
    /// custom entries; `emptyGoalState()` when no valid entry exists).
    pub fn latest_persisted_state(session: &SessionManager) -> GoalState {
        session.active_goal_state().unwrap_or_else(empty_goal_state)
    }

    /// Reload the goal state from the session's current branch (TS
    /// `_reloadGoalStateFromBranch` at the `_navigateTree` tail): the
    /// branch's latest persisted entry adopts under [`rule`]. The timer
    /// needs no anchor work here — the creation-based contract reads the
    /// adopted state's `created_at` directly (TS re-anchors its
    /// `_goalAccountingStartedAt` at the reload; see
    /// [`creation_elapsed_seconds`]' divergence note).
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
    }

    /// Adopt an already-persisted goal state without re-persisting it: a
    /// recovery rebuild continues the durable state verbatim (the
    /// `thread_goal_state` row already records it, and the creation-based
    /// timer reads the adopted `created_at` — no anchor, no downtime
    /// accrual beyond the age the ruling defines).
    pub fn restore_persisted(state: GoalState) -> Self {
        let mut driver = Self::new();
        driver.restore_from_persisted(state);
        driver
    }

    /// [`GoalDriver::restore_persisted`]'s in-place form, for the driver
    /// behind the session's shared handle: adopts the persisted state
    /// without re-persisting (the durable row already exists) and without
    /// resetting the per-message double-counting guard (a fresh build
    /// starts it empty anyway). The mint bookkeeping (the owed flag, the
    /// pending guard) stays quiescent: descendant quiescence and a
    /// queued-but-unconsumed continuation are live-session facts.
    pub fn restore_from_persisted(&mut self, state: GoalState) {
        self.state = normalize_goal_state(state);
        self.continuation_consumed();
    }

    pub fn state(&self) -> &GoalState {
        &self.state
    }

    /// The served goal state: `time_used_seconds` reads the goal's
    /// creation-based age, computed fresh from `created_at` on every read
    /// (so an actively pursued goal's timer ticks live, an idle goal never
    /// compounds, and a paused goal shows its age). A state without
    /// `created_at` (a pre-contract row normalized before the backfill)
    /// keeps its last persisted `time_used_seconds`.
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
        let previous_accounted = std::mem::take(&mut self.accounted_messages);
        let previous_owed = self.owed_continuation_for_rlm_work;
        let previous_pending = self.pending_continuation();
        // TS `_startGoal`: a fresh goal starts with no owed continuation
        // (and no pending one — `_clearQueuedGoalContexts` drops the queued
        // contexts with the state change).
        self.owed_continuation_for_rlm_work = false;
        self.continuation_consumed();
        if let Err(error) = self.set_state(session, goal) {
            // A failed start leaves the previous goal's bookkeeping intact.
            self.accounted_messages = previous_accounted;
            self.owed_continuation_for_rlm_work = previous_owed;
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
        // TS `_clearGoal` routes through `_clearQueuedGoalContexts`, which
        // drops any owed or pending continuation with the queued contexts.
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
        // The creation-based timer: every durable row carries the goal's
        // age at the write — `time_used_seconds` recomputes from
        // `created_at` (never accumulates), so a rehydrated session serves
        // the same contract the live read does.
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
        // A goal leaving the active state drops its pending mint with the
        // queued contexts (TS `_clearQueuedGoalContexts` at the pause/
        // complete/clear state changes): a continuation owed to a dead
        // goal never wedges the next one's mint.
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
        // TS `_pauseGoal` routes through `_clearQueuedGoalContexts`, which
        // drops any owed or pending continuation with the queued contexts —
        // after the durable write, so a failed persist keeps the previous
        // goal's deferral exactly as it was.
        self.owed_continuation_for_rlm_work = false;
        self.continuation_consumed();
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
    ) -> anyhow::Result<Option<CustomMessage>> {
        if self.state.status != GoalStatus::Active || self.state.objective.is_none() {
            return Ok(None);
        }
        // The pending-never-re-arms contract: a continuation minted but
        // not yet admitted by its surface blocks every further mint —
        // exactly one continuation per owed boundary, never duplicates
        // (the operator's dock saw one boundary deliver several "Goal
        // continuation" turns).
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
        // The mint is owed to the calling surface until it admits the
        // turn ([`GoalDriver::continuation_consumed`]); a rollback
        // un-mints it.
        if message.is_some() {
            self.mark_continuation_pending();
        }
        Ok(message)
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
    ) -> anyhow::Result<Option<CustomMessage>> {
        let owed = self.owed_continuation_for_rlm_work;
        if !owed {
            return Ok(None);
        }
        // A pending continuation holds the deferral: the owed boundary
        // delivers once the previous mint is admitted, never beside it.
        if self.pending_continuation() {
            return Ok(None);
        }
        self.owed_continuation_for_rlm_work = false;
        match self.next_continuation_message(session) {
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

    /// The minted continuation's surface admitted it (the queue push or
    /// the in-run handoff): the pending guard releases, so the next
    /// boundary may mint again. TS clears `_goalContinuationAwaitsRlmWork`
    /// at the same point (`_admitSessionInput`'s follow-up admission).
    pub fn continuation_consumed(&mut self) {
        self.pending_continuation
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether a minted continuation is still waiting for its surface's
    /// admission (the pending-never-re-arms guard).
    pub fn pending_continuation(&self) -> bool {
        self.pending_continuation
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The pending guard's lock-free handle: admission surfaces that
    /// cannot take the async driver lock (a spawned settle task, a nested
    /// `block_on`, the worker's abort-cancel) release the guard through
    /// it (`store(false)`) — the driver's own mint sites still read and
    /// set it under the driver lock.
    pub fn pending_continuation_handle(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        std::sync::Arc::clone(&self.pending_continuation)
    }

    /// Arm the pending guard: one minted continuation is owed to the
    /// calling surface until it admits the turn.
    fn mark_continuation_pending(&mut self) {
        self.pending_continuation
            .store(true, std::sync::atomic::Ordering::SeqCst);
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
        // The rolled-back mint never reaches a turn: the pending guard
        // releases with the slot.
        self.continuation_consumed();
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
            .next_continuation_message(&mut session)
            .unwrap()
            .unwrap();
        let UserContent::Text(text) = &first.content else {
            panic!("expected text content");
        };
        assert!(text.contains("- status: active"));
        assert_eq!(driver.state().continuations_used, 1);
        // The first mint's admission (its surface consumed it) releases the
        // pending guard: the next boundary mints again.
        driver.continuation_consumed();
        assert!(driver
            .next_continuation_message(&mut session)
            .unwrap()
            .is_some());
        assert_eq!(driver.state().continuations_used, 2);
        // Inactive goals produce no continuations.
        driver.pause(&mut session, "Paused by user").unwrap();
        assert!(driver
            .next_continuation_message(&mut session)
            .unwrap()
            .is_none());
        // The mint persists the state change: the session branch's latest
        // goal-state entry carries the incremented count.
        driver.start(&mut session, "work again", None).unwrap();
        assert!(driver
            .next_continuation_message(&mut session)
            .unwrap()
            .is_some());
        assert_eq!(driver.state().continuations_used, 1);
        let reloaded = GoalDriver::load_persisted(&session);
        assert_eq!(reloaded.state().continuations_used, 1);
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
            .take_owed_continuation(&mut session)
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
            .take_owed_continuation(&mut session)
            .unwrap()
            .is_none());
        assert_eq!(driver.state().continuations_used, 1);
        // An inactive goal drops the deferral without minting (TS:
        // "drops the deferral for inactive goals").
        driver.mark_continuation_owed();
        driver.pause(&mut session, "Paused by user").unwrap();
        assert!(driver
            .take_owed_continuation(&mut session)
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
            .next_continuation_message(&mut session)
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
            .next_continuation_message(&mut session)
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
            .next_continuation_message(&mut session)
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
    /// no-entry fallthrough.
    #[test]
    fn reload_skips_invalid_rows() {
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

        // A branch without any goal entry reloads to the empty state.
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
    }

    /// The operator's exact case (2026-09-28): a goal created ~2 hours ago
    /// reads ~2 hours — the creation-based timer computes fresh from
    /// `created_at` on every read, and no accounting write compounds it
    /// (the pre-ruling anchor read 73h for the same goal).
    #[test]
    fn creation_based_timer_reads_the_goals_age() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver
            .start(&mut session, "make the visualizer", None)
            .unwrap();
        // The goal was created 2 hours ago (a rehydrated driver adopts the
        // persisted `created_at`).
        let two_hours_ago = now_millis().saturating_sub(2 * 60 * 60 * 1000);
        let mut reloaded = GoalDriver::restore_persisted(GoalState {
            created_at: Some(two_hours_ago),
            ..GoalDriver::latest_persisted_state(&session)
        });
        // A dozen accounting events must not compound the timer: the read
        // recomputes `now - created_at` fresh every time.
        for index in 0..12 {
            let mut usage = usage(30, 10);
            usage.output += index;
            assert_eq!(
                reloaded
                    .record_assistant_usage(&mut session, &format!("a{index}"), &usage)
                    .unwrap(),
                UsageOutcome::Accounted
            );
        }
        let elapsed = reloaded.state_with_creation_elapsed();
        assert_eq!(elapsed.status, GoalStatus::Active);
        assert!(
            (7_190..=7_210).contains(&elapsed.time_used_seconds),
            "a 2h-old goal reads ~2h, got {}",
            elapsed.time_used_seconds
        );
        // The persisted rows carry the age at write, never an accumulated
        // value (the quadratic compounding class is dead).
        assert!(
            (7_190..=7_210).contains(&reloaded.state().time_used_seconds),
            "the durable row carries the age: {}",
            reloaded.state().time_used_seconds
        );
        // The idle state reads zero: no `created_at`, no age.
        let idle = GoalDriver::new();
        assert_eq!(idle.state_with_creation_elapsed().time_used_seconds, 0);
    }

    /// The paused goal displays the same creation-based age (the goal's
    /// age, not a separately stopped clock — the operator's ruling).
    #[test]
    fn paused_goal_reads_its_age() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "ship it", None).unwrap();
        driver.pause(&mut session, "Paused by user").unwrap();
        assert_eq!(driver.state().status, GoalStatus::Paused);
        // The paused state keeps `created_at`: its served state still reads
        // the goal's age.
        assert!(driver.state().created_at.is_some());
        assert!(
            driver.state_with_creation_elapsed().time_used_seconds <= 1,
            "a freshly paused goal reads its (small) age"
        );
        // A rehydrated paused goal created 2h ago reads ~2h.
        let two_hours_ago = now_millis().saturating_sub(2 * 60 * 60 * 1000);
        let reloaded = GoalDriver::restore_persisted(GoalState {
            created_at: Some(two_hours_ago),
            ..GoalDriver::latest_persisted_state(&session)
        });
        let elapsed = reloaded.state_with_creation_elapsed();
        assert_eq!(elapsed.status, GoalStatus::Paused);
        assert!(
            (7_190..=7_210).contains(&elapsed.time_used_seconds),
            "a paused 2h-old goal reads its age, got {}",
            elapsed.time_used_seconds
        );
    }

    /// Legacy goals persisted before the creation-based contract have no
    /// `created_at`: the load backfills it from `updated_at`, so the row
    /// reads its age sanely instead of compounding nothing.
    #[test]
    fn legacy_goal_without_created_at_backfills_from_updated_at() {
        let mut session = persisted_session();
        let legacy = GoalState {
            active: true,
            status: GoalStatus::Active,
            goal_id: Some("legacy-goal".to_string()),
            objective: Some("legacy pursuit".to_string()),
            tokens_used: 100,
            time_used_seconds: 900,
            continuations_used: 2,
            created_at: None,
            updated_at: Some(now_millis().saturating_sub(60 * 60 * 1000)),
            ..empty_goal_state()
        };
        append_goal_row(&mut session, &legacy);
        let driver = GoalDriver::load_persisted(&session);
        // The backfill: `created_at` adopts `updated_at` (documented
        // migration for pre-contract rows).
        assert_eq!(
            driver.state().created_at,
            driver.state().updated_at,
            "the legacy goal backfills created_at from updated_at"
        );
        let elapsed = driver.state_with_creation_elapsed();
        assert!(
            (3_590..=3_610).contains(&elapsed.time_used_seconds),
            "a legacy 1h-old goal reads ~1h, got {}",
            elapsed.time_used_seconds
        );
        // An empty state (no goal) never fabricates a creation time.
        let mut fresh = persisted_session();
        fresh
            .append_message(pa_types::session::AgentMessage::User(
                pa_types::ai::UserMessage {
                    content: UserContent::Text("no goal".to_string()),
                    timestamp: 0,
                    rest: serde_json::Map::default(),
                },
            ))
            .unwrap();
        assert_eq!(GoalDriver::load_persisted(&fresh).state().created_at, None);
    }

    /// The pending-never-re-arms contract: a minted continuation blocks
    /// every further mint until its surface admits it
    /// (`continuation_consumed`), and a rollback or an inactive state
    /// drops the guard with the mint.
    #[test]
    fn pending_continuation_never_re_arms() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        // The first mint arms the pending guard.
        assert!(driver
            .next_continuation_message(&mut session)
            .unwrap()
            .is_some());
        assert!(driver.pending_continuation());
        // A second mint refuses while the first is pending.
        assert!(
            driver
                .next_continuation_message(&mut session)
                .unwrap()
                .is_none(),
            "a pending continuation must not re-arm another"
        );
        assert_eq!(driver.state().continuations_used, 1);
        // The owed delivery waits behind the pending mint as well: the
        // deferral stays armed instead of minting beside it.
        driver.mark_continuation_owed();
        assert!(driver.owes_continuation());
        assert!(driver
            .take_owed_continuation(&mut session)
            .unwrap()
            .is_none());
        assert!(driver.owes_continuation());
        assert_eq!(driver.state().continuations_used, 1);
        // The admission releases the guard; the owed delivery mints next.
        driver.continuation_consumed();
        assert!(!driver.pending_continuation());
        let delivered = driver.take_owed_continuation(&mut session).unwrap();
        assert!(delivered.is_some());
        assert!(!driver.owes_continuation());
        assert!(driver.pending_continuation());
        assert_eq!(driver.state().continuations_used, 2);
        // A rollback un-mints and releases the guard together.
        driver.rollback_continuation_mint(&mut session).unwrap();
        assert!(!driver.pending_continuation());
        assert_eq!(driver.state().continuations_used, 1);
        // Pausing drops a pending mint with the queued contexts.
        assert!(driver
            .next_continuation_message(&mut session)
            .unwrap()
            .is_some());
        assert!(driver.pending_continuation());
        driver.pause(&mut session, "Paused by user").unwrap();
        assert!(!driver.pending_continuation());
        assert!(
            driver
                .next_continuation_message(&mut session)
                .unwrap()
                .is_none(),
            "an inactive goal mints nothing"
        );
        // A fresh start resets the guard with the queued contexts.
        driver.start(&mut session, "again", None).unwrap();
        assert!(!driver.pending_continuation());
        assert!(driver
            .next_continuation_message(&mut session)
            .unwrap()
            .is_some());
        driver.clear(&mut session).unwrap();
        assert!(!driver.pending_continuation());
    }
}
