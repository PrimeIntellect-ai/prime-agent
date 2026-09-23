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

use super::provider_retry::{
    is_agent_lifecycle_failure, is_context_overflow_failure, is_faux_provider_queue_exhausted,
    is_permanent_provider_failure_kind, is_unsupported_tool_failure, jittered_delay_ms,
    provider_retry_delay, provider_stream_failure_kind, provider_stream_failure_retry_after_ms,
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
pub async fn run_turn_with_auto_retry<A, AF, E, EF, W, WF>(
    policy: &ProviderRetryPolicy,
    context_window: u64,
    signal: Option<&AbortSignal>,
    mut attempt: A,
    mut emit: E,
    mut wait: W,
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
        // Non-retryable failures never enter the TS retry bookkeeping: with
        // no retry performed they surface with no events at all, and a
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
            if retries_performed > 0 {
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
                jittered_delay_ms(delay_ms, retry_jitter_rand01())
            }
            ProviderRetryDelay::ExceedsCap { retry_after_ms } => {
                emit(AutoRetryEvent::End {
                    success: false,
                    attempt: retries_performed - 1,
                    restored_model: None,
                    final_error: Some(format!(
                        "Provider requested a {}s wait before retrying (above retry.provider.maxRetryDelayMs={}ms): {}",
                        retry_after_ms.div_ceil(1000),
                        policy.max_retry_delay_ms,
                        message.error_message.as_deref().unwrap_or("unknown error"),
                    )),
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

#[cfg(test)]
mod tests {
    use super::super::provider_retry::UNBOUNDED_BACKOFF_MS;
    use super::*;
    use pa_agent::types::{AssistantContent, AssistantMessageDiagnostic, TextContent, Usage};
    use std::sync::Arc;
    use std::sync::Mutex;

    fn error_message(
        kind: Option<&str>,
        status: Option<u16>,
        retry_after_ms: Option<u64>,
    ) -> AssistantMessage {
        let details = serde_json::json!({
            "kind": kind,
            "status": status,
            "retryAfterMs": retry_after_ms,
        });
        AssistantMessage {
            content: vec![AssistantContent::Text(TextContent {
                text: String::new(),
                text_signature: None,
            })],
            api: String::new(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: Some(vec![AssistantMessageDiagnostic {
                kind: "provider_stream_failure".to_string(),
                timestamp: 0,
                error: None,
                details: Some(details),
            }]),
            usage: Usage::zero(),
            stop_reason: StopReason::Error,
            stop_reason_raw: None,
            error_message: Some("provider down".to_string()),
            timestamp: 0,
        }
    }

    fn ok_message() -> AssistantMessage {
        AssistantMessage {
            content: vec![AssistantContent::Text(TextContent {
                text: "done".to_string(),
                text_signature: None,
            })],
            api: String::new(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::zero(),
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
        }
    }

    fn fast_policy() -> ProviderRetryPolicy {
        ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 5,
            max_retry_delay_ms: 50,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        }
    }

    #[tokio::test]
    async fn transient_failure_is_retried_until_success_with_events() {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = Arc::clone(&events);
        let message = run_turn_with_auto_retry(
            &fast_policy(),
            0,
            None,
            || {
                let attempts = Arc::clone(&attempts);
                async move {
                    let attempt = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    if attempt < 3 {
                        Ok(error_message(Some("server_error"), Some(500), None))
                    } else {
                        Ok(ok_message())
                    }
                }
            },
            move |event| {
                let events = Arc::clone(&events_for_emit);
                async move {
                    events.lock().unwrap().push(event);
                    Ok(())
                }
            },
            |_| async { true },
        )
        .await
        .unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert_eq!(message.stop_reason, StopReason::Stop);
        // Two retry starts (one per retry) and one success end. The delays
        // sit in the jitter band around the 5ms/10ms ladder steps
        // (jittered: [4, 7] and [8, 14] with the ±20% rounding headroom).
        let events = events.lock().unwrap().clone();
        assert_eq!(events.len(), 3, "two starts + one end: {events:?}");
        let shape_matches = matches!(
            events.as_slice(),
            [
                AutoRetryEvent::Start {
                    attempt: 1,
                    max_attempts: 3,
                    error_message: error_one,
                    reason: RetryStartReason::Quick,
                    ..
                },
                AutoRetryEvent::Start {
                    attempt: 2,
                    max_attempts: 3,
                    error_message: error_two,
                    reason: RetryStartReason::Quick,
                    ..
                },
                AutoRetryEvent::End {
                    success: true,
                    attempt: 2,
                    final_error: None,
                    restored_model: None,
                },
            ] if error_one == "provider down" && error_two == "provider down"
        );
        assert!(shape_matches, "unexpected events: {events:?}");
        let delays: Vec<u64> = events
            .iter()
            .filter_map(|event| match event {
                AutoRetryEvent::Start { delay_ms, .. } => Some(*delay_ms),
                _ => None,
            })
            .collect();
        assert_eq!(delays.len(), 2, "two retry starts: {events:?}");
        assert!(
            (4..=7).contains(&delays[0]) && (8..=14).contains(&delays[1]),
            "jittered delays {delays:?} outside the [4,7]/[8,14] bands"
        );
    }

    #[tokio::test]
    async fn exhausted_retries_surface_the_final_error() {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = Arc::clone(&events);
        let message = run_turn_with_auto_retry(
            &fast_policy(),
            0,
            None,
            || {
                let attempts = Arc::clone(&attempts);
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(error_message(Some("server_error"), None, None))
                }
            },
            move |event| {
                let events = Arc::clone(&events_for_emit);
                async move {
                    events.lock().unwrap().push(event);
                    Ok(())
                }
            },
            |_| async { true },
        )
        .await
        .unwrap();
        // One initial attempt plus three retries.
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 4);
        assert_eq!(message.stop_reason, StopReason::Error);
        let events = events.lock().unwrap().clone();
        assert_eq!(
            events.last(),
            Some(&AutoRetryEvent::End {
                success: false,
                attempt: 3,
                final_error: Some("provider down".to_string()),
                restored_model: None,
            })
        );
        assert_eq!(events.len(), 4); // three starts + one end
    }

    #[tokio::test]
    async fn permanent_failures_never_retry_and_emit_no_events() {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = Arc::clone(&events);
        let message = run_turn_with_auto_retry(
            &fast_policy(),
            0,
            None,
            || {
                let attempts = Arc::clone(&attempts);
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(error_message(Some("invalid_request"), Some(400), None))
                }
            },
            move |event| {
                let events = Arc::clone(&events_for_emit);
                async move {
                    events.lock().unwrap().push(event);
                    Ok(())
                }
            },
            |_| async { true },
        )
        .await
        .unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(message.stop_reason, StopReason::Error);
        // No retry happened, so no events: the caller renders the failed
        // assistant message itself (TS only emits retry events once a retry
        // was actually attempted).
        assert!(events.lock().unwrap().is_empty());
    }

    /// A context overflow can never succeed unchanged (TS
    /// `_isRetryableError`'s overflow guard): the turn surfaces the error
    /// immediately so the compact-and-retry recovery owns it.
    #[tokio::test]
    async fn context_overflow_never_enters_the_retry_loop() {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = Arc::clone(&events);
        let message = run_turn_with_auto_retry(
            &fast_policy(),
            200_000,
            None,
            || {
                let attempts = Arc::clone(&attempts);
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let mut overflow = error_message(None, None, None);
                    overflow.diagnostics = None;
                    overflow.error_message =
                        Some("prompt is too long: 213462 tokens > 200000 maximum".to_string());
                    Ok(overflow)
                }
            },
            move |event| {
                let events = Arc::clone(&events_for_emit);
                async move {
                    events.lock().unwrap().push(event);
                    Ok(())
                }
            },
            |_| async { true },
        )
        .await
        .unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(message.stop_reason, StopReason::Error);
        assert!(events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelled_wait_aborts_with_retry_cancelled() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = Arc::clone(&events);
        let mut attempts = 0;
        let message = run_turn_with_auto_retry(
            &fast_policy(),
            0,
            None,
            || {
                attempts += 1;
                async { Ok(error_message(Some("server_error"), None, None)) }
            },
            move |event| {
                let events = Arc::clone(&events_for_emit);
                async move {
                    events.lock().unwrap().push(event);
                    Ok(())
                }
            },
            |_| async { false },
        )
        .await
        .unwrap();
        assert_eq!(attempts, 1);
        assert_eq!(message.stop_reason, StopReason::Aborted);
        // TS `_retryAfterDelay`'s abort path closes the started retry.
        assert_eq!(
            events.lock().unwrap().last(),
            Some(&AutoRetryEvent::End {
                success: false,
                attempt: 1,
                final_error: Some("Retry cancelled".to_string()),
                restored_model: None,
            })
        );
    }

    #[tokio::test]
    async fn aborted_signal_racing_failure_stops_aborted() {
        let controller = pa_agent::abort::AbortController::new();
        controller.abort();
        let message = run_turn_with_auto_retry(
            &fast_policy(),
            0,
            Some(&controller.signal()),
            || async { Ok(error_message(Some("server_error"), None, None)) },
            |_| async { Ok(()) },
            |_| async { true },
        )
        .await
        .unwrap();
        assert_eq!(message.stop_reason, StopReason::Aborted);
    }

    #[tokio::test]
    async fn server_retry_after_over_cap_ends_the_loop() {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = Arc::clone(&events);
        let message = run_turn_with_auto_retry(
            &fast_policy(),
            0,
            None,
            || {
                let attempts = Arc::clone(&attempts);
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(error_message(Some("rate_limit"), Some(429), Some(500)))
                }
            },
            move |event| {
                let events = Arc::clone(&events_for_emit);
                async move {
                    events.lock().unwrap().push(event);
                    Ok(())
                }
            },
            |_| async { true },
        )
        .await
        .unwrap();
        // The cap (50ms) rejects the server's 500ms wait on the first retry
        // request; the loop stops and reports the refused wait (TS
        // `exceeds-cap` end event, attempt 0 because no retry finished).
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(message.stop_reason, StopReason::Error);
        assert_eq!(
            events.lock().unwrap().as_slice(),
            &[AutoRetryEvent::End {
                success: false,
                attempt: 0,
                final_error: Some(
                    "Provider requested a 1s wait before retrying (above retry.provider.maxRetryDelayMs=50ms): provider down"
                        .to_string(),
                ),
                restored_model: None,
            }]
        );
    }

    #[tokio::test]
    async fn disabled_policy_never_retries_or_emits() {
        let policy = ProviderRetryPolicy {
            enabled: false,
            ..fast_policy()
        };
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = Arc::clone(&events);
        let message = run_turn_with_auto_retry(
            &policy,
            0,
            None,
            || {
                let attempts = Arc::clone(&attempts);
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(error_message(Some("server_error"), None, None))
                }
            },
            move |event| {
                let events = Arc::clone(&events_for_emit);
                async move {
                    events.lock().unwrap().push(event);
                    Ok(())
                }
            },
            |_| async { true },
        )
        .await
        .unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(message.stop_reason, StopReason::Error);
        assert!(events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn attempt_errors_propagate() {
        let error = run_turn_with_auto_retry(
            &fast_policy(),
            0,
            None,
            || async { Err(anyhow::anyhow!("turn crashed")) },
            |_| async { Ok(()) },
            |_| async { true },
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "turn crashed");
    }

    /// The router's tool-use 404 ("No endpoints found that support tool
    /// use") is a permanent capability mismatch: the turn surfaces with
    /// no retry events, exactly like the other non-retryable kinds.
    #[tokio::test]
    async fn unsupported_tool_failures_surface_without_retry_events() {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = Arc::clone(&events);
        let message = run_turn_with_auto_retry(
            &fast_policy(),
            0,
            None,
            || {
                let attempts = Arc::clone(&attempts);
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let mut unsupported = error_message(Some("invalid_request"), Some(404), None);
                    unsupported.error_message =
                        Some("404 No endpoints found that support tool use.".to_string());
                    Ok(unsupported)
                }
            },
            move |event| {
                let events = Arc::clone(&events_for_emit);
                async move {
                    events.lock().unwrap().push(event);
                    Ok(())
                }
            },
            |_| async { true },
        )
        .await
        .unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(message.stop_reason, StopReason::Error);
        assert!(events.lock().unwrap().is_empty());
    }
}
