//! The goal mint's progress gate (the 402 diagnosis's (a)/(b)): the
//! just-settled turn's examination — the terminal kill, the quota-park
//! refusal window, the durable no-progress streak with its doubling
//! backoff, and the order-safety rules (the examined-turn dedup, the
//! unconditional kill, the unconditional cap). Split out of the goal
//! driver module (the repo's file-size convention): the driver's core
//! lifecycle stays in the parent, the progress concern lands in its own
//! child beside it.

use super::{now_millis, GoalDriver};
use crate::goals::{GoalState, GoalStatus};
use crate::session::manager::SessionManager;
use crate::session_engine::provider_retry::provider_stream_failure_kind;

/// How many consecutive no-output turns the continuation mint tolerates
/// before the goal finishes (the 402 diagnosis's small cap).
pub(crate) const CONTINUATION_NO_PROGRESS_CAP: u32 = 3;

/// The backoff base for consecutive no-output turns (10s, 20s, 40s ...):
/// each retry of a no-progress continuation waits twice as long.
pub(crate) const CONTINUATION_NO_PROGRESS_BACKOFF_BASE_MS: u64 = 10_000;

/// The durable one-shot wake's cron label (the no-progress backoff's
/// `quota-resume` analogue): the daemon's boundary sites arm a one-shot
/// cron job at [`GoalDriver::backoff_wake_at`] whose prompt is the wake
/// marker, so the backoff's 10s/20s/40s retry actually runs instead of
/// stalling until an unrelated boundary event.
pub const GOAL_BACKOFF_WAKE_CRON_LABEL: &str = "goal-backoff-wake";

/// The wake marker prompt (the goal-backoff analogue of
/// `QUOTA_RESUME_MARKER_TEXT`): the scheduler fires it into the session's
/// follow-up lane; its turn re-probes the provider, and the turn's own
/// natural boundary re-consults the mint with the window passed.
pub const GOAL_BACKOFF_WAKE_MARKER_TEXT: &str = "<goal_backoff_wake>\nThe goal continuation backoff window (the consecutive-no-progress cap) has elapsed; this wake is automatic. Continue the goal work from where it stopped.\n</goal_backoff_wake>";

/// Whether the turn produced any output: a no-output turn is an EMPTY
/// content block list OR one whose every block is itself empty (the
/// abort conversion's corpse shape carries a single empty text part —
/// `vec![Text { text: "" }]` — which the bare `is_empty` check would
/// mistake for progress). Tool calls are always output.
#[must_use]
pub fn turn_produced_no_output(message: &pa_agent::types::AssistantMessage) -> bool {
    message.content.iter().all(|part| match part {
        pa_agent::types::AssistantContent::Text(text) => text.text.is_empty(),
        pa_agent::types::AssistantContent::Thinking(thinking) => thinking.thinking.is_empty(),
        pa_agent::types::AssistantContent::ToolCall(_) => false,
    })
}

/// The just-settled turn's provider-failure text when the turn settled
/// as a terminal provider failure (stop reason `error`, with a recorded
/// stream failure that is not the quota-park class — the parked turn is
/// the park's pause, not the goal's death). `None` for healthy, aborted,
/// or parked turns.
#[must_use]
pub fn terminal_provider_failure(message: &pa_agent::types::AssistantMessage) -> Option<String> {
    if message.stop_reason != pa_agent::types::StopReason::Error {
        return None;
    }
    // The diagnostic is consulted ONLY to exclude the quota-park class
    // (the aligned predicate: one semantic, two shapes — the wire twin
    // `wire_terminal_provider_failure` and the engine's own error arm).
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
    /// The mint's progress gate: examine the just-settled turn and report
    /// whether the mint may proceed. Every refusal arm (the terminal
    /// kill, the quota-park window, the no-progress strike, the cap)
    /// persists its own state change before returning `false`.
    ///
    /// # Errors
    ///
    /// Returns the error when a state transition fails to persist.
    pub(super) fn progress_gate(
        &mut self,
        session: &mut SessionManager,
        turn: &pa_agent::types::AssistantMessage,
    ) -> anyhow::Result<bool> {
        // The gate's scope: only a turn THIS goal's lifetime produced
        // can judge it. `last_loop_assistant_message` reads the live
        // loop context's newest assistant row — after `/goal start`
        // (or a mint that is not immediately after this goal's own
        // turn) a leftover error corpse from BEFORE the goal began
        // must not finish the fresh goal. The turn's timestamp
        // against the goal's `created_at` bounds the check to the
        // goal's own turns; a legacy state without `created_at` keeps
        // the check (conservative for the resurrection class).
        let turn_is_this_goals = self
            .state
            .created_at
            .is_none_or(|created_at| turn.timestamp > created_at as i64);
        // The examined-turn gate: a row the driver has already judged
        // — or any row at or before it — never re-enters the progress
        // machinery. Without this, the failed pair's removal from the
        // live loop would expose the earlier PROGRESS row, whose
        // consult would reset the streak (the drop-resets-the-cap
        // review finding); re-consults inside the backoff window
        // likewise never re-count.
        let turn_is_new = self
            .counted_no_progress_turn_ms
            .is_none_or(|examined| turn.timestamp > examined);
        // The TERMINAL kill is UNCONDITIONAL — outside the examined
        // gate: the wire assistant rows carry no stable per-attempt id
        // (the error corpses' `responseId` is None; the entry id lives
        // on the file entry, not the loop row), so a timestamp-keyed
        // dedup is not a total order across settle paths — a terminal
        // error that shares (or precedes) the examined turn's
        // millisecond must still refuse the continuation. The kill is
        // idempotent (an already-finished goal never re-enters the
        // mint), so re-consulting an examined corpse is harmless; only
        // the no-progress COUNT keeps the dedup, whose collision is
        // provably safe-direction (a missed strike is a one-strike
        // grace, never a resurrection).
        if turn_is_this_goals {
            if let Some(error) = terminal_provider_failure(turn) {
                self.finish_for_terminal_message(
                    session,
                    pa_types::ai::StopReason::Error,
                    Some(&error),
                )?;
                return Ok(false);
            }
        }
        if turn_is_this_goals && turn_is_new {
            // The quota-park class owns its own retry cadence (the
            // park's wake re-probes; the park's budget declines): a
            // parked corpse never consumes the no-progress budget —
            // three quota parks must not mark an otherwise live goal
            // dead. The refusal STICKS through the PARKED-REFUSAL
            // window, NOT the backoff window (`backoff_wake_at` must
            // never expose a parked refusal, or the daemon would
            // schedule a 10s marker probe into the parked session and
            // keep 429ing a still-limited wallet — the park's own wake
            // owns the retry). A re-consult of the same corpse, or of
            // the older row the pair-drop exposes, refuses inside it;
            // the park's wake turn (minutes later, a NEW row) re-enters
            // normally.
            if provider_stream_failure_kind(turn).as_deref() == Some("rate_limit") {
                self.counted_no_progress_turn_ms = Some(turn.timestamp);
                // An earlier no-progress strike's window is CLEARED here:
                // the parked session owns the retry cadence now, and a
                // live backoff window would expose `backoff_wake_at` —
                // the daemon would schedule a 10s marker probe into the
                // parked session. The durable streak carries the strike;
                // the park's wake turn re-arms the cadence if it too
                // makes no progress.
                self.no_progress_backoff_until_ms = 0;
                self.parked_refusal_until_ms =
                    now_millis() + CONTINUATION_NO_PROGRESS_BACKOFF_BASE_MS;
                return Ok(false);
            }
            if turn_produced_no_output(turn) {
                // The turn produced no output: a corpse that is not a
                // provider failure (an abort conversion's empty text,
                // a degenerate empty settle) still made no progress.
                // Count the turn and arm the doubling backoff window —
                // this consult refuses, and a later boundary after the
                // window passes re-mints. At the cap the goal finishes:
                // the loop-killer for EVERY survival arm, not just the
                // engine's error arm.
                self.counted_no_progress_turn_ms = Some(turn.timestamp);
                self.no_progress_streak += 1;
                self.no_progress_backoff_until_ms = now_millis()
                    + CONTINUATION_NO_PROGRESS_BACKOFF_BASE_MS
                        * 2u64.saturating_pow(self.no_progress_streak.saturating_sub(1));
                // The streak AND the examined-turn key persist with
                // the goal state (the cap counter is durable: a worker
                // restart cannot reset it and un-cap a degenerate loop,
                // and the same corpse never strikes twice however often
                // the session rebuilds).
                self.set_state(
                    session,
                    GoalState {
                        no_progress_streak: Some(self.no_progress_streak),
                        no_progress_turn_ms: Some(turn.timestamp),
                        ..self.state.clone()
                    },
                )?;
                if self.no_progress_streak >= CONTINUATION_NO_PROGRESS_CAP {
                    let reason =
                        "Goal continuation cap reached: consecutive turns made no progress"
                            .to_string();
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
                    return Ok(false);
                }
                return Ok(false);
            }
            // The turn produced output: the streak resets and any
            // armed backoff window clears — and the reset persists (a
            // restart must not inherit a stale streak).
            if self.no_progress_streak != 0 {
                self.no_progress_streak = 0;
                self.no_progress_backoff_until_ms = 0;
                self.parked_refusal_until_ms = 0;
                self.counted_no_progress_turn_ms = Some(turn.timestamp);
                self.set_state(
                    session,
                    GoalState {
                        no_progress_streak: Some(0),
                        no_progress_turn_ms: Some(turn.timestamp),
                        ..self.state.clone()
                    },
                )?;
            }
        }
        Ok(true)
    }
}
