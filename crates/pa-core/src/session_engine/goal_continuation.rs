//! The goal continuation consult: the one decision every surface (the
//! daemon's boundary and settle sites, the print drive loop) runs before a
//! goal continuation turn. The surface answers the gates and acts on the
//! decision; the consult owns the gate order and the mint.

use pa_types::session::CustomMessage;

use super::goal_driver::{turn_produced_no_output, GoalDriver};
use crate::session::manager::SessionManager;

/// What asks for the continuation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContinuationTrigger {
    /// A natural turn end: an active goal mints its next continuation.
    TurnEnd,
    /// Work that held the boundary settled: only an owed continuation delivers.
    OwedRetry,
}

/// The surface's gate answers, read just before the consult.
#[derive(Debug, Clone, Copy, Default)]
pub struct ContinuationGates {
    /// Queued session input owns the boundary.
    pub input_queued: bool,
    /// Unsettled descendant work (RLM children, background `bash()` handles)
    /// holds the continuation.
    pub work_unsettled: bool,
}

/// The consult's outcome.
#[derive(Debug)]
pub enum GoalContinuationDecision {
    /// No active goal owns the boundary (an armed deferral is dropped), or a
    /// retry found nothing owed.
    NotOwned,
    /// Queued input owns the boundary; its own turn end consults again.
    QueuedInput,
    /// The continuation is owed behind unsettled work, not consumed.
    Owed,
    /// The goal owns the boundary but minted nothing: the progress gate
    /// refused, a minted continuation is still pending, or the persist
    /// failed (which fails the goal).
    NotMinted { drop_failed_pair: bool },
    /// One continuation slot is spent; the surface admits the row.
    Minted {
        message: Box<CustomMessage>,
        drop_failed_pair: bool,
    },
}

impl GoalContinuationDecision {
    /// Whether the surface drops the failed continuation pair from the live
    /// loop. Only a consult that passed the gates drops it: a deferred one
    /// must leave the no-progress turn for the later consult to read.
    #[must_use]
    pub fn drops_failed_pair(&self) -> bool {
        matches!(
            self,
            Self::NotMinted {
                drop_failed_pair: true
            } | Self::Minted {
                drop_failed_pair: true,
                ..
            }
        )
    }
}

/// Run the consult: ownership, then queued input, then unsettled work, then
/// the mint. `last_turn` is the just-settled assistant turn, read before the
/// driver lock (the session mutex never nests under it).
pub async fn consult_goal_continuation(
    driver: &tokio::sync::Mutex<GoalDriver>,
    persistence: &tokio::sync::Mutex<SessionManager>,
    last_turn: Option<&pa_agent::types::AssistantMessage>,
    trigger: ContinuationTrigger,
    gates: ContinuationGates,
) -> GoalContinuationDecision {
    let mut driver = driver.lock().await;
    if !driver.owns_continuation_wakeup() {
        if driver.owes_continuation() {
            let mut session = persistence.lock().await;
            // An inactive goal's take only clears the deferral.
            let _ = driver.take_owed_continuation(&mut session, None);
        }
        return GoalContinuationDecision::NotOwned;
    }
    if trigger == ContinuationTrigger::OwedRetry && !driver.owes_continuation() {
        return GoalContinuationDecision::NotOwned;
    }
    if gates.input_queued {
        return GoalContinuationDecision::QueuedInput;
    }
    if gates.work_unsettled {
        driver.mark_continuation_owed();
        return GoalContinuationDecision::Owed;
    }
    let drop_failed_pair = last_turn.is_some_and(|turn| {
        turn.stop_reason == pa_agent::types::StopReason::Error || turn_produced_no_output(turn)
    });
    let mut session = persistence.lock().await;
    let minted = if driver.owes_continuation() {
        driver.take_owed_continuation(&mut session, last_turn)
    } else {
        driver.next_continuation_message(&mut session, last_turn)
    };
    match minted {
        Ok(Some(message)) => GoalContinuationDecision::Minted {
            message: Box::new(message),
            drop_failed_pair,
        },
        Ok(None) => GoalContinuationDecision::NotMinted { drop_failed_pair },
        Err(error) => {
            let message = format!("{error:#}");
            tracing::warn!("goal continuation mint failed the persist: {message}");
            // Best-effort: its own persist failure must not reject the boundary either.
            if let Err(fail_error) = driver.finish_for_terminal_message(
                &mut session,
                pa_types::ai::StopReason::Error,
                Some(&message),
            ) {
                tracing::warn!("goal error finish also failed: {fail_error:#}");
            }
            GoalContinuationDecision::NotMinted { drop_failed_pair }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A turn that settled without output (no provider failure).
    fn empty_turn(timestamp: i64) -> pa_agent::types::AssistantMessage {
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

    /// A consult deferred behind unsettled work leaves the failed pair for the
    /// later consult to read; the consult that passes the gates drops it.
    #[tokio::test]
    async fn only_a_consult_past_the_gates_drops_the_failed_pair() {
        let dir = tempfile::TempDir::new().unwrap();
        let session_dir = dir.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut session = SessionManager::in_memory(dir.path());
        session.materialize_session_file(Some(session_dir));
        let mut driver = GoalDriver::new();
        driver.start(&mut session, "work", None).unwrap();
        let no_output = empty_turn(driver.state().created_at.unwrap() as i64 + 1);
        let driver = tokio::sync::Mutex::new(driver);
        let session = tokio::sync::Mutex::new(session);

        let held = consult_goal_continuation(
            &driver,
            &session,
            Some(&no_output),
            ContinuationTrigger::TurnEnd,
            ContinuationGates {
                input_queued: false,
                work_unsettled: true,
            },
        )
        .await;
        assert!(matches!(held, GoalContinuationDecision::Owed), "{held:?}");
        assert!(!held.drops_failed_pair());

        let settled = consult_goal_continuation(
            &driver,
            &session,
            Some(&no_output),
            ContinuationTrigger::OwedRetry,
            ContinuationGates::default(),
        )
        .await;
        assert!(settled.drops_failed_pair(), "{settled:?}");
    }
}
