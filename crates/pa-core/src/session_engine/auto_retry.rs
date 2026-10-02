//! Interactive provider-failure auto-retry: the session-level retry loop for
//! user-driven turns (TS `AgentSession` `_handleRetryableError` /
//! `_retryAfterDelay` / `_finishActiveRetryWithFailure`).
//!
//! The one-shot completion helper in [`super::provider_retry`] serves
//! side questions, compaction, and refinement; this module is the interactive
//! counterpart that re-issues the whole failed turn. It owns only the retry
//! decision and the event surface: the caller drives the actual turn (and
//! removes the failed assistant message from the loop context before
//! re-issuing, like the TS loop does).
//!
//! Retry events are delivered as data so any host (daemon worker, direct
//! attach) can serialize them onto its own event plane with the TS wire
//! shape (`auto_retry_start` / `auto_retry_end`).

use std::future::Future;

use pa_agent::abort::AbortSignal;
use pa_agent::types::{AssistantMessage, StopReason};

use super::provider_park::{is_quota_block_failure, ParkDecisionCallback};
use super::provider_retry::{
    has_provider_stream_failure, is_agent_lifecycle_failure, is_context_overflow_failure,
    is_faux_provider_queue_exhausted, is_permanent_provider_failure_kind,
    is_unsupported_tool_failure, jittered_delay_ms, provider_retry_delay,
    provider_stream_failure_kind, provider_stream_failure_retry_after_ms,
    provider_stream_failure_status, retry_jitter_rand01, ProviderRetryDelay, ProviderRetryPolicy,
};

/// Why one `auto_retry_start` fired (the TS wire `reason` field).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryStartReason {
    /// Ordinary quick retry on the current provider.
    Quick,
    /// The failed turn re-routes to another configured provider serving the
    /// same model; `backup_model` is the `"provider/model-id"` reference.
    Backup { backup_model: String },
}

/// One retry-loop event, in the TS wire vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoRetryEvent {
    /// `auto_retry_start`: the loop parks the failed turn and waits.
    Start {
        /// 1-based retry number.
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        error_message: String,
        /// Which kind of retry this is (quick retry vs provider switch).
        reason: RetryStartReason,
    },
    /// `auto_retry_end`: the loop settled. `attempt` is the number of retries
    /// performed; `final_error` is present exactly when `success` is false;
    /// `restored_model` is the `"provider/model-id"` primary restored after
    /// a provider-switch retry succeeded.
    End {
        success: bool,
        attempt: u32,
        final_error: Option<String>,
        restored_model: Option<String>,
    },
}

/// Drive `attempt` under the shared retry policy until it settles.
///
/// `attempt` runs one turn and returns its final assistant message; a turn
/// whose final message has stop reason `Error` is a provider failure and is
/// classified against the policy. `emit` observes the retry events as they
/// happen; `wait` sleeps one delay (returning `false` aborts the loop, like
/// the TS abort controller). Returns the final assistant message — error or
/// not — so the caller renders it like every other outcome.
///
/// `park` is the quota-park seam (TS #2375): consulted when a
/// server-requested wait exceeds the policy cap (this port's
/// `reset-too-far`). A `Some` outcome parks the session — the chain
/// surfaces the parked status as the final `auto_retry_end` instead of
/// the give-up — and `None` keeps the immediate give-up.
///
/// # Errors
///
/// Returns the `attempt` future's error when a turn attempt fails, or the
/// `emit` callback's error while observing retry events.
#[allow(clippy::too_many_arguments)]
pub async fn run_turn_with_auto_retry<A, AF, E, EF, W, WF>(
    policy: &ProviderRetryPolicy,
    context_window: u64,
    signal: Option<&AbortSignal>,
    mut attempt: A,
    mut emit: E,
    mut wait: W,
    mut park: Option<ParkDecisionCallback<'_>>,
) -> anyhow::Result<AssistantMessage>
where
    A: FnMut() -> AF,
    AF: Future<Output = anyhow::Result<AssistantMessage>>,
    E: FnMut(AutoRetryEvent) -> EF,
    EF: Future<Output = anyhow::Result<()>>,
    W: FnMut(std::time::Duration) -> WF,
    WF: Future<Output = bool>,
{
    let mut retries_performed = 0u32;
    loop {
        let message = attempt().await?;
        if message.stop_reason != StopReason::Error {
            if retries_performed > 0 {
                emit(AutoRetryEvent::End {
                    success: true,
                    attempt: retries_performed,
                    final_error: None,
                    restored_model: None,
                })
                .await?;
            }
            return Ok(message);
        }
        if signal.is_some_and(AbortSignal::is_aborted) {
            return Ok(with_stop_reason_aborted(message));
        }
        // Non-retryable failures never enter the TS retry bookkeeping: a
        // permanent failure that follows earlier transient retries only
        // closes the active retry (`_finishActiveRetryWithFailure`).
        let non_retryable = is_agent_lifecycle_failure(&message)
            || is_faux_provider_queue_exhausted(&message)
            // A context overflow can never succeed unchanged (TS
            // `_isRetryableError`): the compact-and-retry recovery owns it.
            || is_context_overflow_failure(&message, context_window)
            || is_unsupported_tool_failure(&message)
            || is_permanent_provider_failure_kind(
                provider_stream_failure_kind(&message).as_deref(),
                retries_performed,
                provider_stream_failure_status(&message),
            );
        if !policy.enabled || non_retryable {
            // SANCTIONED DIVERGENCE (the 402 diagnosis, operator ruling):
            // the outcome row is FAILURE-scoped, not episode-scoped. TS
            // only emits retry events once a retry was attempted, so a
            // permanent classification on the FIRST attempt settled with
            // no events at all — the disclosure row the machinery exists
            // for never fired (the operator's silent empty message). A
            // provider failure with a recorded stream failure discloses
            // at attempt 0; the self-managed arms stay silent (the
            // overflow's compact-and-retry recovery owns its disclosure,
            // lifecycle and faux failures are not provider failures).
            if retries_performed > 0
                || (has_provider_stream_failure(&message)
                    && !is_context_overflow_failure(&message, context_window))
            {
                emit(AutoRetryEvent::End {
                    success: false,
                    attempt: retries_performed,
                    final_error: Some(final_error_of(&message)),
                    restored_model: None,
                })
                .await?;
            }
            return Ok(message);
        }
        // TS `_handleRetryableError` bumps the attempt counter before
        // deciding, so the exhaustion check compares past `max_retries`.
        retries_performed += 1;
        let delay = provider_retry_delay(
            retries_performed,
            provider_stream_failure_retry_after_ms(&message),
            policy,
        );
        let delay_ms = match delay {
            // Jittered (SANCTIONED DIVERGENCE, operator ruling 2026-09-23):
            // the jittered value is both waited and reported, so the
            // interactive countdown stays honest while a fleet of retried
            // sessions spreads off the same exponential-ladder ticks.
            ProviderRetryDelay::Wait { delay_ms } => {
                // TS routes the server-requested-wait arms to the bounded
                // wait path BEFORE the quick-retry exhaustion check (the
                // `waitClass === "quota"` arm precedes the maxRetries
                // give-up), so the exhaustion arm never preempts the
                // park decision: a quota-blocked attempt on the final
                // retry still parks when the reset is too far.
                if retries_performed > policy.max_retries {
                    emit(AutoRetryEvent::End {
                        success: false,
                        attempt: retries_performed - 1,
                        final_error: Some(final_error_of(&message)),
                        restored_model: None,
                    })
                    .await?;
                    return Ok(message);
                }
                jittered_delay_ms(delay_ms, retry_jitter_rand01())
            }
            ProviderRetryDelay::ExceedsCap { retry_after_ms } => {
                // The give-up sentence of this arm is the park's abort
                // message (the TS wait loop's `reset-too-far` analogue).
                let abort = format!(
                    "Provider requested a {}s wait before retrying (above retry.provider.maxRetryDelayMs={}ms)",
                    retry_after_ms.div_ceil(1000),
                    policy.max_retry_delay_ms,
                );
                // The park seam is a quota-failure seam (TS parks only
                // from the wait path's `usage` arm): other
                // server-requested waits keep the give-up.
                let parked = if is_quota_block_failure(&message) {
                    match park.as_deref_mut() {
                        Some(park) => park(message.clone(), &abort).await,
                        None => None,
                    }
                } else {
                    None
                };
                let final_error = match parked {
                    // The turn settles as the park's pause, not its death:
                    // the parked status replaces the give-up (TS
                    // `_finishQuotaParkedTurn`'s `finalError`).
                    Some(outcome) => outcome.status_message,
                    None => format!(
                        "{abort}: {}",
                        message.error_message.as_deref().unwrap_or("unknown error"),
                    ),
                };
                emit(AutoRetryEvent::End {
                    success: false,
                    attempt: retries_performed - 1,
                    restored_model: None,
                    final_error: Some(final_error),
                })
                .await?;
                return Ok(message);
            }
        };
        emit(AutoRetryEvent::Start {
            attempt: retries_performed,
            max_attempts: policy.max_retries,
            delay_ms,
            error_message: final_error_of(&message),
            reason: RetryStartReason::Quick,
        })
        .await?;
        if !wait(std::time::Duration::from_millis(delay_ms)).await {
            emit(AutoRetryEvent::End {
                success: false,
                attempt: retries_performed,
                final_error: Some("Retry cancelled".to_string()),
                restored_model: None,
            })
            .await?;
            return Ok(with_stop_reason_aborted(message));
        }
    }
}

/// The user-visible error text of a failed turn (TS `errorMessage || "Unknown error"`).
fn final_error_of(message: &AssistantMessage) -> String {
    message
        .error_message
        .as_deref()
        .filter(|error| !error.is_empty())
        .unwrap_or("Unknown error")
        .to_string()
}

fn with_stop_reason_aborted(mut message: AssistantMessage) -> AssistantMessage {
    message.stop_reason = StopReason::Aborted;
    message
}

// The inline unit battery moved to the child module at the same tree
// position (session_engine::auto_retry::tests); its use-super glob keeps
// resolving through this facade's bindings (the request-timing precedent,
// #3084).
#[cfg(test)]
mod tests;
