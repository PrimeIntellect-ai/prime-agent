//! Provider retry policy: the single shared policy for provider-failure
//! retries (permanent kinds, Retry-After-aware capped delays).
//!
//! Two consumers exist: the session auto-retry loop and one-shot completion
//! helpers (side questions, compaction, refinement, session summaries). The
//! decision logic is pure and clock-free so tests stay deterministic; the
//! caller owns the actual sleep/attempt cycle.
//!
//! Structured failures ride the assistant message as a
//! `provider_stream_failure` diagnostic whose details carry the classified
//! kind, HTTP status, and server-requested `retryAfterMs`.

use pa_agent::abort::AbortSignal;
use pa_agent::types::{AssistantMessage, StopReason};
use serde_json::Value;

/// The shared retry policy (TS `ProviderRetryPolicy`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRetryPolicy {
    pub enabled: bool,
    pub max_retries: u32,
    pub base_delay_ms: u64,
    /// Max server-requested retry delay before giving up; 0 disables the cap.
    pub max_retry_delay_ms: u64,
    /// Ceiling on the exponential backoff itself. The TS quick-retry loop
    /// grows without bound, so the default is unbounded; the provider
    /// failover schedule caps its doubling (30s).
    pub max_delay_ms: u64,
}

/// No backoff ceiling (the TS quick-retry schedule).
pub const UNBOUNDED_BACKOFF_MS: u64 = u64::MAX;

/// Default policy (TS `DEFAULT_PROVIDER_RETRY_POLICY`; also the settings
/// defaults: `retry.enabled` true, `maxRetries` 3, `baseDelayMs` 2000,
/// `provider.maxRetryDelayMs` 60000).
pub const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = ProviderRetryPolicy {
    enabled: true,
    max_retries: 3,
    base_delay_ms: 2000,
    max_retry_delay_ms: 60000,
    max_delay_ms: UNBOUNDED_BACKOFF_MS,
};

/// Resolution of one retry-delay decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRetryDelay {
    /// Wait `delay_ms`, then retry.
    Wait { delay_ms: u64 },
    /// The server-requested wait exceeds the policy cap; give up.
    ExceedsCap { retry_after_ms: u64 },
}

/// Node caps timers at 2^31-1 ms; longer delays overflow setTimeout and fire
/// after ~1ms. Cap the computed wait at the same bound.
const MAX_TIMER_DELAY_MS: u64 = 2_147_483_647;

/// Local listener/lifecycle crashes are not provider failures; never retry them.
pub fn is_agent_lifecycle_failure(message: &AssistantMessage) -> bool {
    message.diagnostics.as_ref().is_some_and(|diagnostics| {
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.kind == "agent_lifecycle_failure")
    })
}

/// The faux test provider's queue running dry is deterministic; retrying it
/// only stalls tests.
pub fn is_faux_provider_queue_exhausted(message: &AssistantMessage) -> bool {
    message.provider == "faux"
        && message.error_message.as_deref() == Some("No more faux responses queued")
}

/// A context-overflow failure (TS `_isRetryableError`'s overflow guard): the
/// request itself is too large, so re-issuing it unchanged can never succeed.
/// The session-level compact-and-retry recovery owns it instead.
pub fn is_context_overflow_failure(message: &AssistantMessage, context_window: u64) -> bool {
    // The shared overflow classifier works over the wire message shape;
    // a round-trip failure means no usage/error fields to inspect.
    let Some(wire) = serde_json::to_value(message)
        .ok()
        .and_then(|value| serde_json::from_value::<pa_types::ai::AssistantMessage>(value).ok())
    else {
        return false;
    };
    pa_ai::is_context_overflow(&wire, (context_window > 0).then_some(context_window))
}

/// The model router's tool-use rejection marker (observed on
/// prime-inference as a 404 whose body the SDK surfaces verbatim:
/// `404 No endpoints found that support tool use. Try disabling ...`).
/// Matched case-insensitively against the user-facing failure text,
/// but only together with the classified 404 status: the text alone is
/// provider-controllable and must never steer the retry policy on its
/// own (a transient 5xx quoting the same words stays retryable).
const UNSUPPORTED_TOOL_FAILURE_MARKER: &str = "no endpoints found that support tool use";

/// A router rejection for a model that cannot serve tool use. Unlike the
/// plain routing-blip 404 (transient), the request's tools make this a
/// permanent capability mismatch: every provider serving the same model
/// rejects it identically, so it is never retried and never fails over.
pub fn is_unsupported_tool_failure(message: &AssistantMessage) -> bool {
    provider_stream_failure_status(message) == Some(404)
        && message.error_message.as_deref().is_some_and(|error| {
            error
                .to_ascii_lowercase()
                .contains(UNSUPPORTED_TOOL_FAILURE_MARKER)
        })
}

/// The `details` payload of the `provider_stream_failure` diagnostic.
pub fn provider_stream_failure_details(message: &AssistantMessage) -> Option<&Value> {
    message
        .diagnostics
        .as_ref()?
        .iter()
        .find(|diagnostic| diagnostic.kind == "provider_stream_failure")
        .and_then(|diagnostic| diagnostic.details.as_ref())
        .filter(|details| details.is_object())
}

pub fn provider_stream_failure_kind(message: &AssistantMessage) -> Option<String> {
    provider_stream_failure_details(message)?
        .get("kind")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub fn provider_stream_failure_retry_after_ms(message: &AssistantMessage) -> Option<u64> {
    provider_stream_failure_details(message)?
        .get("retryAfterMs")
        .and_then(Value::as_u64)
}

pub fn provider_stream_failure_status(message: &AssistantMessage) -> Option<u16> {
    provider_stream_failure_details(message)?
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
}

/// Deterministic rejections never retry; auth gets one retry before it can be
/// marked stale. A 404 is the exception: a live model briefly 404s on routing
/// blips, so it counts as transient unavailability, not a permanent rejection.
pub fn is_permanent_provider_failure_kind(
    kind: Option<&str>,
    retries_performed: u32,
    status: Option<u16>,
) -> bool {
    match kind {
        Some("invalid_request") if status == Some(404) => false,
        Some("invalid_request") | Some("refusal") | Some("permission") => true,
        Some("auth") => retries_performed > 0,
        _ => false,
    }
}

/// Jitter band on the computed backoff (SANCTIONED DIVERGENCE from TS
/// `providerRetryDelay`, which has none): every retry wait stretches or
/// shrinks by up to [`RETRY_JITTER_FRACTION`] on each side, so a fleet of
/// sessions hammering one rate-limited provider does not re-converge on the
/// same exponential-ladder ticks (the 429-storm operator incident: every
/// session retried in lockstep). The jittered value is what the caller
/// waits AND what `auto_retry_start` reports, so the live countdown stays
/// honest.
const RETRY_JITTER_FRACTION: f64 = 0.2;

/// The retry wait for `delay_ms`, jittered by `rand01` (a uniform sample in
/// `[0, 1]`; `0.5` is the no-change identity). Pure so tests stay
/// deterministic: `jittered_delay_ms(1000, 0.0) == 800`,
/// `jittered_delay_ms(1000, 1.0) == 1200`.
pub fn jittered_delay_ms(delay_ms: u64, rand01: f64) -> u64 {
    let rand01 = rand01.clamp(0.0, 1.0);
    let factor = 1.0 + RETRY_JITTER_FRACTION * (2.0 * rand01 - 1.0);
    ((delay_ms as f64) * factor).round() as u64
}

/// One uniform sample in `[0, 1]` for [`jittered_delay_ms`]: a time-seeded
/// xorshift step (uniformity is not security here, only spread across
/// concurrent processes).
pub fn retry_jitter_rand01() -> f64 {
    static CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos() as u64 ^ (duration.as_secs() << 32))
        .unwrap_or(0);
    let mut x = nanos ^ count.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    (x % 10_000) as f64 / 10_000.0
}

/// Delay before retry `attempt` (1-based), honoring a server-requested wait.
pub fn provider_retry_delay(
    attempt: u32,
    retry_after_ms: Option<u64>,
    policy: &ProviderRetryPolicy,
) -> ProviderRetryDelay {
    if let Some(retry_after_ms) = retry_after_ms {
        if policy.max_retry_delay_ms > 0 && retry_after_ms > policy.max_retry_delay_ms {
            return ProviderRetryDelay::ExceedsCap { retry_after_ms };
        }
    }
    let exponential = policy
        .base_delay_ms
        .saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))
        .min(policy.max_delay_ms);
    let delay_ms = exponential
        .max(retry_after_ms.unwrap_or(0))
        .min(MAX_TIMER_DELAY_MS);
    ProviderRetryDelay::Wait { delay_ms }
}

/// One-shot completion with the shared retry policy, for consumers outside the
/// session auto-retry loop (provider clients never retry internally).
///
/// `attempt` produces one assistant message per call; a message whose stop
/// reason is `error` is classified against the policy and retried when
/// transient. `wait` sleeps one retry delay; returning `false` marks the wait
/// aborted and stops the loop with `Aborted` (a cancel that raced the failure
/// is an abort, not a provider failure). An attempt error propagates to the
/// caller, like a `throw` inside the TS attempt closure.
///
/// The wait future is injectable so deterministic callers (scripts, tests)
/// can avoid real timers; poll it with any executor (`futures` works).
pub async fn complete_with_provider_retry<A, AF, W, WF>(
    policy: &ProviderRetryPolicy,
    signal: Option<&AbortSignal>,
    mut wait: W,
    mut attempt: A,
) -> anyhow::Result<AssistantMessage>
where
    A: FnMut() -> AF,
    AF: std::future::Future<Output = anyhow::Result<AssistantMessage>>,
    W: FnMut(std::time::Duration) -> WF,
    WF: std::future::Future<Output = bool>,
{
    let max_retries = if policy.enabled {
        policy.max_retries
    } else {
        0
    };
    let mut retries_performed = 0u32;
    loop {
        let message = attempt().await?;
        if message.stop_reason != StopReason::Error {
            return Ok(message);
        }
        if signal.is_some_and(AbortSignal::is_aborted) {
            return Ok(with_stop_reason_aborted(message));
        }
        if retries_performed >= max_retries
            || is_agent_lifecycle_failure(&message)
            || is_faux_provider_queue_exhausted(&message)
            || is_unsupported_tool_failure(&message)
        {
            return Ok(message);
        }
        let kind = provider_stream_failure_kind(&message);
        let status = provider_stream_failure_status(&message);
        if is_permanent_provider_failure_kind(kind.as_deref(), retries_performed, status) {
            return Ok(message);
        }
        let delay = provider_retry_delay(
            retries_performed + 1,
            provider_stream_failure_retry_after_ms(&message),
            policy,
        );
        let ProviderRetryDelay::Wait { delay_ms } = delay else {
            return Ok(message);
        };
        let delay_ms = jittered_delay_ms(delay_ms, retry_jitter_rand01());
        if !wait(std::time::Duration::from_millis(delay_ms)).await {
            return Ok(with_stop_reason_aborted(message));
        }
        retries_performed += 1;
    }
}

fn with_stop_reason_aborted(mut message: AssistantMessage) -> AssistantMessage {
    message.stop_reason = StopReason::Aborted;
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_agent::types::{AssistantContent, AssistantMessageDiagnostic, TextContent, Usage};

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
            error_message: Some("provider failed".to_string()),
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

    /// The jitter band (SANCTIONED DIVERGENCE, operator ruling 2026-09-23):
    /// the wait stretches/shrinks by up to ±20% around the computed backoff,
    /// clamped inputs stay inside the band, and the mid-point sample is the
    /// identity.
    #[test]
    fn jitter_stays_inside_the_band_and_mid_is_identity() {
        assert_eq!(jittered_delay_ms(1000, 0.5), 1000);
        assert_eq!(jittered_delay_ms(1000, 0.0), 800);
        assert_eq!(jittered_delay_ms(1000, 1.0), 1200);
        assert_eq!(jittered_delay_ms(1000, 7.5), 1200); // clamped high
        assert_eq!(jittered_delay_ms(1000, -0.5), 800); // clamped low
        assert_eq!(jittered_delay_ms(0, 0.1), 0);
        assert_eq!(jittered_delay_ms(1, 0.5), 1);
        assert_eq!(jittered_delay_ms(1, 0.1), 1); // 0.8 rounds to 1
        assert_eq!(jittered_delay_ms(2, 0.0), 2); // 1.6 rounds to 2
                                                  // The live rand stays a valid fraction.
        for _ in 0..64 {
            let sample = retry_jitter_rand01();
            assert!((0.0..=1.0).contains(&sample), "sample {sample}");
        }
    }

    #[test]
    fn retry_delay_exponentially_backs_off() {
        let policy = ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 2000,
            max_retry_delay_ms: 60000,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        };
        assert_eq!(
            provider_retry_delay(1, None, &policy),
            ProviderRetryDelay::Wait { delay_ms: 2000 }
        );
        assert_eq!(
            provider_retry_delay(2, None, &policy),
            ProviderRetryDelay::Wait { delay_ms: 4000 }
        );
        assert_eq!(
            provider_retry_delay(3, None, &policy),
            ProviderRetryDelay::Wait { delay_ms: 8000 }
        );
        // Server-requested wait wins when larger.
        assert_eq!(
            provider_retry_delay(1, Some(9000), &policy),
            ProviderRetryDelay::Wait { delay_ms: 9000 }
        );
    }

    #[test]
    fn retry_delay_caps_server_requests() {
        let policy = ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 2000,
            max_retry_delay_ms: 60000,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        };
        assert_eq!(
            provider_retry_delay(1, Some(60001), &policy),
            ProviderRetryDelay::ExceedsCap {
                retry_after_ms: 60001
            }
        );
        // Cap disabled (0): the server wait is honored.
        let uncapped = ProviderRetryPolicy {
            max_retry_delay_ms: 0,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
            ..policy
        };
        assert_eq!(
            provider_retry_delay(1, Some(120_000), &uncapped),
            ProviderRetryDelay::Wait { delay_ms: 120_000 }
        );
    }

    #[test]
    fn permanent_kinds_never_retry() {
        assert!(is_permanent_provider_failure_kind(
            Some("invalid_request"),
            0,
            Some(400)
        ));
        assert!(is_permanent_provider_failure_kind(Some("refusal"), 0, None));
        assert!(is_permanent_provider_failure_kind(
            Some("permission"),
            0,
            None
        ));
        // Auth retries once before it can be marked stale.
        assert!(!is_permanent_provider_failure_kind(
            Some("auth"),
            0,
            Some(401)
        ));
        assert!(is_permanent_provider_failure_kind(
            Some("auth"),
            1,
            Some(401)
        ));
        // 404 is transient.
        assert!(!is_permanent_provider_failure_kind(
            Some("invalid_request"),
            0,
            Some(404)
        ));
        assert!(!is_permanent_provider_failure_kind(
            Some("server_error"),
            0,
            None
        ));
        assert!(!is_permanent_provider_failure_kind(None, 0, None));
    }

    #[tokio::test]
    async fn transient_failure_is_retried_until_success() {
        let policy = ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 5,
            max_retry_delay_ms: 50,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        };
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempts_for_attempt = std::sync::Arc::clone(&attempts);
        let waited = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
        let waited_for_wait = std::sync::Arc::clone(&waited);
        let message = complete_with_provider_retry(
            &policy,
            None,
            move |delay| {
                let waited = std::sync::Arc::clone(&waited_for_wait);
                async move {
                    waited.lock().unwrap().push(delay.as_millis() as u64);
                    true
                }
            },
            move || {
                let attempts = std::sync::Arc::clone(&attempts_for_attempt);
                async move {
                    let attempt = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    if attempt < 3 {
                        Ok(error_message(Some("server_error"), Some(500), None))
                    } else {
                        Ok(ok_message())
                    }
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
        // The waits sit in the ±20% jitter band around the 5ms/10ms
        // ladder steps (SANCTIONED DIVERGENCE, operator ruling
        // 2026-09-23): [4, 7] and [8, 14] with rounding headroom.
        let waits = waited.lock().unwrap().clone();
        assert_eq!(waits.len(), 2, "two waits: {waits:?}");
        assert!(
            (4..=7).contains(&waits[0]) && (8..=14).contains(&waits[1]),
            "jittered waits {waits:?} outside the [4,7]/[8,14] bands"
        );
        assert_eq!(message.stop_reason, StopReason::Stop);
        let AssistantContent::Text(text) = &message.content[0] else {
            panic!("text content");
        };
        assert_eq!(text.text, "done");
    }

    #[tokio::test]
    async fn retries_exhaust_after_max_retries() {
        let policy = ProviderRetryPolicy {
            enabled: true,
            max_retries: 2,
            base_delay_ms: 5,
            max_retry_delay_ms: 50,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        };
        let mut attempts = 0;
        let message = complete_with_provider_retry(
            &policy,
            None,
            |_| async { true },
            || {
                attempts += 1;
                async { Ok(error_message(Some("server_error"), None, None)) }
            },
        )
        .await
        .unwrap();
        // One initial attempt plus two retries.
        assert_eq!(attempts, 3);
        assert_eq!(message.stop_reason, StopReason::Error);
    }

    #[tokio::test]
    async fn disabled_policy_never_retries() {
        let policy = ProviderRetryPolicy {
            enabled: false,
            max_retries: 5,
            base_delay_ms: 5,
            max_retry_delay_ms: 50,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        };
        let mut attempts = 0;
        let message = complete_with_provider_retry(
            &policy,
            None,
            |_| async { true },
            || {
                attempts += 1;
                async { Ok(error_message(Some("server_error"), None, None)) }
            },
        )
        .await
        .unwrap();
        assert_eq!(attempts, 1);
        assert_eq!(message.stop_reason, StopReason::Error);
    }

    #[tokio::test]
    async fn permanent_failure_returns_without_waiting() {
        let policy = ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 5,
            max_retry_delay_ms: 50,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        };
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempts_for_attempt = std::sync::Arc::clone(&attempts);
        let waited = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let waited_for_wait = std::sync::Arc::clone(&waited);
        let message = complete_with_provider_retry(
            &policy,
            None,
            move |_| {
                let waited = std::sync::Arc::clone(&waited_for_wait);
                async move {
                    waited.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    true
                }
            },
            move || {
                let attempts = std::sync::Arc::clone(&attempts_for_attempt);
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(error_message(Some("invalid_request"), None, Some(400)))
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(waited.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(message.stop_reason, StopReason::Error);
    }

    #[tokio::test]
    async fn aborted_signal_racing_failure_stops_aborted() {
        let policy = ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 5,
            max_retry_delay_ms: 50,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        };
        let controller = pa_agent::abort::AbortController::new();
        controller.abort();
        let message = complete_with_provider_retry(
            &policy,
            Some(&controller.signal()),
            |_| async { true },
            || async { Ok(error_message(Some("server_error"), None, None)) },
        )
        .await
        .unwrap();
        assert_eq!(message.stop_reason, StopReason::Aborted);
    }

    #[tokio::test]
    async fn aborted_wait_stops_aborted() {
        let policy = ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 5,
            max_retry_delay_ms: 50,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        };
        let mut attempts = 0;
        let message = complete_with_provider_retry(
            &policy,
            None,
            |_| async { false },
            || {
                attempts += 1;
                async { Ok(error_message(Some("server_error"), None, None)) }
            },
        )
        .await
        .unwrap();
        assert_eq!(attempts, 1);
        assert_eq!(message.stop_reason, StopReason::Aborted);
    }

    #[tokio::test]
    async fn lifecycle_and_faux_failures_are_never_retried() {
        let policy = ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 5,
            max_retry_delay_ms: 50,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        };
        let mut lifecycle = error_message(None, None, None);
        lifecycle.diagnostics = Some(vec![AssistantMessageDiagnostic {
            kind: "agent_lifecycle_failure".to_string(),
            timestamp: 0,
            error: None,
            details: None,
        }]);
        let mut attempts = 0;
        let message = complete_with_provider_retry(
            &policy,
            None,
            |_| async { true },
            || {
                attempts += 1;
                async { Ok(lifecycle.clone()) }
            },
        )
        .await
        .unwrap();
        assert_eq!(attempts, 1);
        assert_eq!(message.stop_reason, StopReason::Error);

        let mut faux = error_message(None, None, None);
        faux.provider = "faux".to_string();
        faux.error_message = Some("No more faux responses queued".to_string());
        let mut attempts = 0;
        let message = complete_with_provider_retry(
            &policy,
            None,
            |_| async { true },
            || {
                attempts += 1;
                async { Ok(faux.clone()) }
            },
        )
        .await
        .unwrap();
        assert_eq!(attempts, 1);
        assert_eq!(message.stop_reason, StopReason::Error);
    }

    #[tokio::test]
    async fn attempt_errors_propagate() {
        let policy = ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 5,
            max_retry_delay_ms: 50,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        };
        let error = complete_with_provider_retry(
            &policy,
            None,
            |_| async { true },
            || async { Err(anyhow::anyhow!("attempt failed")) },
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "attempt failed");
    }

    #[test]
    fn stream_failure_fields_read_from_diagnostics() {
        let message = error_message(Some("server_error"), Some(500), Some(120));
        assert_eq!(
            provider_stream_failure_kind(&message).as_deref(),
            Some("server_error")
        );
        assert_eq!(provider_stream_failure_status(&message), Some(500));
        assert_eq!(provider_stream_failure_retry_after_ms(&message), Some(120));
        let retry_after = provider_retry_delay(1, Some(120), &DEFAULT_PROVIDER_RETRY_POLICY);
        assert_eq!(retry_after, ProviderRetryDelay::Wait { delay_ms: 2000 });
    }

    /// The router's tool-use rejection (the dogfood incident text) is
    /// permanent, matched case-insensitively — but only together with
    /// the classified 404 status: provider-controllable text alone
    /// never steers the retry policy. A plain routing-blip 404 without
    /// the marker stays transient, and a 5xx quoting the marker stays
    /// retryable.
    #[test]
    fn unsupported_tool_rejections_are_terminal() {
        let mut unsupported = error_message(Some("invalid_request"), Some(404), None);
        unsupported.error_message = Some(
            "404 No endpoints found that support tool use. Try disabling \"ipython\".".to_string(),
        );
        assert!(is_unsupported_tool_failure(&unsupported));
        let mut upper = unsupported;
        upper.error_message = Some("404 NO ENDPOINTS FOUND THAT SUPPORT TOOL USE".to_string());
        assert!(is_unsupported_tool_failure(&upper));
        let mut blip = error_message(Some("invalid_request"), Some(404), None);
        blip.error_message = Some("404 model route not found".to_string());
        assert!(!is_unsupported_tool_failure(&blip));
        // The marker text without the 404 status is not a tool-capability
        // rejection: a transient 5xx quoting the router's words stays
        // retryable (the status gate keeps the text from steering the
        // policy on its own).
        let mut transient = error_message(Some("server_error"), Some(503), None);
        transient.error_message = Some("503 No endpoints found that support tool use".to_string());
        assert!(!is_unsupported_tool_failure(&transient));
        // No classified status at all: same rule.
        let mut unclassified = error_message(Some("server_error"), None, None);
        unclassified.error_message = Some("No endpoints found that support tool use".to_string());
        assert!(!is_unsupported_tool_failure(&unclassified));
        let empty = error_message(Some("server_error"), Some(500), None);
        assert!(!is_unsupported_tool_failure(&empty));
    }

    #[tokio::test]
    async fn unsupported_tool_failures_never_retry() {
        let policy = ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 5,
            max_retry_delay_ms: 50,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        };
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempts_for_attempt = std::sync::Arc::clone(&attempts);
        let message = complete_with_provider_retry(
            &policy,
            None,
            |_| async { true },
            move || {
                let attempts = std::sync::Arc::clone(&attempts_for_attempt);
                async move {
                    attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let mut unsupported = error_message(Some("invalid_request"), Some(404), None);
                    unsupported.error_message =
                        Some("404 No endpoints found that support tool use.".to_string());
                    Ok(unsupported)
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(message.stop_reason, StopReason::Error);
    }
}
