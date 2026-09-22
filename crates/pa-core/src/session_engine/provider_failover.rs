//! Provider failover: the resilience loop that keeps a turn alive across
//! configured providers serving the same model.
//!
//! The TS quick-retry loop (`provider-retry.ts`, ported in
//! [`super::auto_retry`]) re-issues a failed turn on the SAME provider and
//! gives up when the retries run out. When the model is served by more than
//! one configured provider, that give-up is premature: a whole provider
//! outage (the "GLM went down and everything broke" failure mode) kills
//! sessions a sibling provider could have finished. This module generalizes
//! the TS backup-model retry (`agent-session.ts`
//! `_handleBackupModelRetry`/`_restorePrimaryModelAfterBackup`): after the
//! per-provider retry budget is spent, the turn re-routes to the next
//! configured provider serving the same model id and retries there, walking
//! the candidate chain in catalog order. The event vocabulary is the TS
//! wire (`auto_retry_start` with `reason: "backup"` and `backupModel`, and
//! `auto_retry_end` with `restoredModel` on success), so the interactive
//! surface renders the progression without new event types.
//!
//! The decision logic is pure and clock-free; the caller owns the actual
//! sleep/attempt cycle and the model switch (the session loop re-binds the
//! agent's model, thinking level, and session-log row).

use std::future::Future;

use pa_agent::abort::AbortSignal;
use pa_agent::types::{AssistantMessage, StopReason};
use pa_types::ai::Model;

use super::auto_retry::{run_turn_with_auto_retry, AutoRetryEvent, RetryStartReason};
use super::provider_retry::{
    is_agent_lifecycle_failure, is_context_overflow_failure, is_faux_provider_queue_exhausted,
    is_permanent_provider_failure_kind, provider_retry_delay, provider_stream_failure_kind,
    provider_stream_failure_retry_after_ms, provider_stream_failure_status, ProviderRetryDelay,
    ProviderRetryPolicy,
};

/// The provider-failover policy: per-provider retry budget and backoff
/// schedule for the failover loop (settings `retry.failover`).
///
/// When the current provider's quick-retry budget is spent and another
/// configured provider serves the same model, the failover schedule takes
/// over: exponential backoff starting at `base_delay_ms`, doubling each
/// retry, capped at `max_delay_ms`, with up to `max_retries` retries per
/// provider before switching to the next one. With no failover candidate
/// the TS quick-retry policy alone governs the turn (byte-identical
/// surfacing).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFailoverPolicy {
    pub enabled: bool,
    /// Retries per provider before switching to the next provider.
    pub max_retries: u32,
    /// First backoff delay (doubles each retry).
    pub base_delay_ms: u64,
    /// Backoff ceiling per retry.
    pub max_delay_ms: u64,
}

/// Default failover schedule: 5 retries per provider, 1s doubling backoff
/// capped at 30s, before switching to the next provider serving the model.
pub const DEFAULT_PROVIDER_FAILOVER_POLICY: ProviderFailoverPolicy = ProviderFailoverPolicy {
    enabled: true,
    max_retries: 5,
    base_delay_ms: 1000,
    max_delay_ms: 30000,
};

/// The per-provider retry policy the failover loop derives from the
/// failover schedule plus the TS server-requested-wait cap.
fn per_provider_policy(
    failover: &ProviderFailoverPolicy,
    server_wait_cap_ms: u64,
) -> ProviderRetryPolicy {
    ProviderRetryPolicy {
        enabled: true,
        max_retries: failover.max_retries,
        base_delay_ms: failover.base_delay_ms,
        max_retry_delay_ms: server_wait_cap_ms,
        max_delay_ms: failover.max_delay_ms,
    }
}

/// Backoff delay before retry `attempt` (1-based) on one provider:
/// `base_delay_ms` doubling each retry, capped at `max_delay_ms`, honoring
/// a server-requested wait (`Retry-After`) the same way the TS quick-retry
/// delay does.
pub fn failover_retry_delay(
    attempt: u32,
    retry_after_ms: Option<u64>,
    failover: &ProviderFailoverPolicy,
    server_wait_cap_ms: u64,
) -> ProviderRetryDelay {
    provider_retry_delay(
        attempt,
        retry_after_ms,
        &per_provider_policy(failover, server_wait_cap_ms),
    )
}

/// Drive one turn through the provider-failover chain.
///
/// With failover disabled or no candidate providers, this is exactly
/// [`run_turn_with_auto_retry`] under `quick_policy` (the TS quick-retry
/// loop, unchanged surfacing). Otherwise each provider gets up to
/// `failover.max_retries` quick retries on the failover schedule; when the
/// budget is spent the next candidate takes over immediately (the TS
/// backup-model retry re-issues with `delayMs: 0`). `switch` re-binds the
/// session to a provider (agent model + clamped thinking + session-log
/// row); `restore` hands the primary back and returns its
/// `"provider/model-id"`. Success after a switch restores the primary and
/// reports it; every provider exhausting its budget surfaces the final
/// failure like the single-provider loop does.
#[allow(clippy::too_many_arguments)]
pub async fn run_turn_with_provider_failover<A, AF, E, EF, W, WF, S, SF, R, RF>(
    quick_policy: &ProviderRetryPolicy,
    failover: &ProviderFailoverPolicy,
    candidates: &[Model],
    context_window: u64,
    signal: Option<&AbortSignal>,
    mut attempt: A,
    mut emit: E,
    mut wait: W,
    mut switch: S,
    mut restore: R,
) -> anyhow::Result<AssistantMessage>
where
    A: FnMut() -> AF,
    AF: Future<Output = anyhow::Result<AssistantMessage>>,
    E: FnMut(AutoRetryEvent) -> EF,
    EF: Future<Output = anyhow::Result<()>>,
    W: FnMut(std::time::Duration) -> WF,
    WF: Future<Output = bool>,
    S: FnMut(&Model) -> SF,
    SF: Future<Output = anyhow::Result<()>>,
    R: FnMut() -> RF,
    RF: Future<Output = anyhow::Result<Option<String>>>,
{
    if !failover.enabled || candidates.is_empty() {
        return run_turn_with_auto_retry(quick_policy, context_window, signal, attempt, emit, wait)
            .await;
    }
    let mut total_retries = 0u32;
    let mut retries_on_provider = 0u32;
    let mut candidate_index = 0usize;
    let mut switched = false;
    loop {
        let message = attempt().await?;
        if message.stop_reason != StopReason::Error {
            if switched {
                let restored_model = restore().await?;
                emit(AutoRetryEvent::End {
                    success: true,
                    attempt: total_retries,
                    final_error: None,
                    restored_model,
                })
                .await?;
            } else if total_retries > 0 {
                emit(AutoRetryEvent::End {
                    success: true,
                    attempt: total_retries,
                    final_error: None,
                    restored_model: None,
                })
                .await?;
            }
            return Ok(message);
        }
        if signal.is_some_and(AbortSignal::is_aborted) {
            if switched {
                let _ = restore().await?;
            }
            return Ok(with_stop_reason_aborted(message));
        }
        // Permanent and deterministic failures never walk the chain: a
        // rejected request fails the same way on every provider, and
        // lifecycle/faux failures are not provider failures at all.
        let non_retryable = is_agent_lifecycle_failure(&message)
            || is_faux_provider_queue_exhausted(&message)
            // A context overflow fails identically on every provider (TS
            // `_isRetryableError`): the compact-and-retry recovery owns it.
            || is_context_overflow_failure(&message, context_window)
            || is_permanent_provider_failure_kind(
                provider_stream_failure_kind(&message).as_deref(),
                total_retries,
                provider_stream_failure_status(&message),
            );
        if non_retryable {
            if switched {
                let _ = restore().await?;
            }
            if total_retries > 0 {
                emit(AutoRetryEvent::End {
                    success: false,
                    attempt: total_retries,
                    final_error: Some(final_error_of(&message)),
                    restored_model: None,
                })
                .await?;
            }
            return Ok(message);
        }
        total_retries += 1;
        retries_on_provider += 1;
        if retries_on_provider > failover.max_retries {
            // This provider's budget is spent: walk to the next provider
            // serving the same model, or surface the failure.
            let Some(next) = candidates.get(candidate_index) else {
                if switched {
                    let _ = restore().await?;
                }
                emit(AutoRetryEvent::End {
                    success: false,
                    attempt: total_retries,
                    final_error: Some(final_error_of(&message)),
                    restored_model: None,
                })
                .await?;
                return Ok(message);
            };
            candidate_index += 1;
            retries_on_provider = 0;
            let backup_model = format!("{}/{}", next.provider, next.id);
            switch(next).await?;
            switched = true;
            // The TS backup-model retry re-issues immediately on the
            // backup (`delayMs: 0`): no wait, no countdown.
            emit(AutoRetryEvent::Start {
                attempt: total_retries,
                max_attempts: failover.max_retries,
                delay_ms: 0,
                error_message: final_error_of(&message),
                reason: RetryStartReason::Backup { backup_model },
            })
            .await?;
            continue;
        }
        let delay = failover_retry_delay(
            retries_on_provider,
            provider_stream_failure_retry_after_ms(&message),
            failover,
            quick_policy.max_retry_delay_ms,
        );
        let delay_ms = match delay {
            ProviderRetryDelay::Wait { delay_ms } => delay_ms,
            ProviderRetryDelay::ExceedsCap { retry_after_ms } => {
                if switched {
                    let _ = restore().await?;
                }
                emit(AutoRetryEvent::End {
                    success: false,
                    attempt: total_retries - 1,
                    final_error: Some(format!(
                        "Provider requested a {}s wait before retrying (above retry.provider.maxRetryDelayMs={}ms): {}",
                        retry_after_ms.div_ceil(1000),
                        quick_policy.max_retry_delay_ms,
                        message.error_message.as_deref().unwrap_or("unknown error"),
                    )),
                    restored_model: None,
                })
                .await?;
                return Ok(message);
            }
        };
        emit(AutoRetryEvent::Start {
            attempt: retries_on_provider,
            max_attempts: failover.max_retries,
            delay_ms,
            error_message: final_error_of(&message),
            reason: RetryStartReason::Quick,
        })
        .await?;
        if !wait(std::time::Duration::from_millis(delay_ms)).await {
            if switched {
                let _ = restore().await?;
            }
            emit(AutoRetryEvent::End {
                success: false,
                attempt: total_retries,
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
    use super::*;
    use pa_agent::types::{AssistantContent, AssistantMessageDiagnostic, TextContent, Usage};
    use std::sync::Arc;
    use std::sync::Mutex;

    fn model(provider: &str) -> Model {
        serde_json::from_value(serde_json::json!({
            "id": "glm-5.3", "name": "GLM", "api": "openai-completions",
            "provider": provider, "baseUrl": "", "reasoning": false, "input": [],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000, "maxTokens": 8192
        }))
        .unwrap()
    }

    fn error_message(kind: Option<&str>, status: Option<u16>, error: &str) -> AssistantMessage {
        let details = serde_json::json!({ "kind": kind, "status": status });
        AssistantMessage {
            content: vec![AssistantContent::Text(TextContent {
                text: String::new(),
                text_signature: None,
            })],
            api: String::new(),
            provider: "primary".to_string(),
            model: "glm-5.3".to_string(),
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
            error_message: Some(error.to_string()),
            timestamp: 0,
        }
    }

    fn ok_message(text: &str) -> AssistantMessage {
        AssistantMessage {
            content: vec![AssistantContent::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
            })],
            api: String::new(),
            provider: "primary".to_string(),
            model: "glm-5.3".to_string(),
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

    fn quick_policy() -> ProviderRetryPolicy {
        ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 2000,
            max_retry_delay_ms: 60000,
            max_delay_ms: super::super::provider_retry::UNBOUNDED_BACKOFF_MS,
        }
    }

    fn fast_failover() -> ProviderFailoverPolicy {
        ProviderFailoverPolicy {
            enabled: true,
            max_retries: 2,
            base_delay_ms: 5,
            max_delay_ms: 50,
        }
    }

    /// One scripted turn sequence and the observed switches/restores.
    #[derive(Default)]
    struct Harness {
        attempts: usize,
        switches: Vec<String>,
        restores: Vec<Option<String>>,
        waits: Vec<u64>,
        events: Vec<AutoRetryEvent>,
    }

    /// Run the driver over a scripted attempt sequence. Each entry is the
    /// assistant message one attempt returns.
    async fn drive(
        failover: &ProviderFailoverPolicy,
        candidates: &[Model],
        script: Vec<AssistantMessage>,
    ) -> Harness {
        let script = Arc::new(Mutex::new(script));
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let switches: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let restores: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let waits: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let events: Arc<Mutex<Vec<AutoRetryEvent>>> = Arc::new(Mutex::new(Vec::new()));
        run_turn_with_provider_failover(
            &quick_policy(),
            failover,
            candidates,
            0,
            None,
            {
                let script = Arc::clone(&script);
                let attempts = Arc::clone(&attempts);
                move || {
                    let script = Arc::clone(&script);
                    let attempts = Arc::clone(&attempts);
                    async move {
                        attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let mut script = script.lock().unwrap();
                        Ok(script.remove(0))
                    }
                }
            },
            {
                let events = Arc::clone(&events);
                move |event| {
                    let events = Arc::clone(&events);
                    async move {
                        events.lock().unwrap().push(event);
                        Ok(())
                    }
                }
            },
            {
                let waits = Arc::clone(&waits);
                move |delay| {
                    let waits = Arc::clone(&waits);
                    async move {
                        waits.lock().unwrap().push(delay.as_millis() as u64);
                        true
                    }
                }
            },
            {
                let switches = Arc::clone(&switches);
                move |next: &Model| {
                    let switches = Arc::clone(&switches);
                    let next = next.clone();
                    async move {
                        switches
                            .lock()
                            .unwrap()
                            .push(format!("{}/{}", next.provider, next.id));
                        Ok(())
                    }
                }
            },
            {
                let restores = Arc::clone(&restores);
                move || {
                    let restores = Arc::clone(&restores);
                    async move {
                        restores
                            .lock()
                            .unwrap()
                            .push(Some("primary/glm-5.3".to_string()));
                        Ok(Some("primary/glm-5.3".to_string()))
                    }
                }
            },
        )
        .await
        .unwrap();
        // Bind first: the MutexGuard temporaries must drop before the
        // block's locals (a trailing struct literal keeps them alive to
        // the end of the block).
        let harness = Harness {
            attempts: attempts.load(std::sync::atomic::Ordering::SeqCst),
            switches: switches.lock().unwrap().clone(),
            restores: restores.lock().unwrap().clone(),
            waits: waits.lock().unwrap().clone(),
            events: events.lock().unwrap().clone(),
        };
        harness
    }

    #[test]
    fn backoff_schedule_starts_at_base_doubles_and_caps() {
        let failover = ProviderFailoverPolicy {
            enabled: true,
            max_retries: 5,
            base_delay_ms: 1000,
            max_delay_ms: 30000,
        };
        let schedule: Vec<u64> = (1..=7)
            .map(
                |attempt| match failover_retry_delay(attempt, None, &failover, 60000) {
                    ProviderRetryDelay::Wait { delay_ms } => delay_ms,
                    ProviderRetryDelay::ExceedsCap { .. } => panic!("no cap rejection"),
                },
            )
            .collect();
        // 1s doubling: 1, 2, 4, 8, 16, then the 30s ceiling.
        assert_eq!(schedule, vec![1000, 2000, 4000, 8000, 16000, 30000, 30000]);
        // A larger server-requested wait wins over the exponential value.
        assert_eq!(
            failover_retry_delay(1, Some(5000), &failover, 60000),
            ProviderRetryDelay::Wait { delay_ms: 5000 }
        );
        // The TS server-wait cap still refuses absurd waits.
        assert_eq!(
            failover_retry_delay(1, Some(60001), &failover, 60000),
            ProviderRetryDelay::ExceedsCap {
                retry_after_ms: 60001
            }
        );
    }

    #[tokio::test]
    async fn provider_failure_switches_to_the_next_provider_then_succeeds() {
        let candidates = vec![model("backup-a"), model("backup-b")];
        // Two failures exhaust the primary's budget (max_retries 2).
        let script = vec![
            error_message(Some("server_error"), Some(500), "primary down 1"),
            error_message(Some("server_error"), Some(500), "primary down 2"),
            error_message(Some("server_error"), Some(500), "primary down 3"),
            ok_message("recovered on backup"),
        ];
        let harness = drive(&fast_failover(), &candidates, script).await;
        // Initial attempt + 2 retries on the primary, then one attempt on
        // the first backup succeeds.
        assert_eq!(harness.attempts, 4);
        assert_eq!(harness.switches, vec!["backup-a/glm-5.3"]);
        assert_eq!(harness.restores, vec![Some("primary/glm-5.3".to_string())]);
        // Two quick waits on the primary, then the immediate backup
        // re-issue (no wait between the switch and the next attempt).
        assert_eq!(harness.waits, vec![5, 10]);
        // The progression: two quick starts, the backup switch, the
        // restored-success end.
        assert_eq!(
            harness.events,
            vec![
                AutoRetryEvent::Start {
                    attempt: 1,
                    max_attempts: 2,
                    delay_ms: 5,
                    error_message: "primary down 1".to_string(),
                    reason: RetryStartReason::Quick,
                },
                AutoRetryEvent::Start {
                    attempt: 2,
                    max_attempts: 2,
                    delay_ms: 10,
                    error_message: "primary down 2".to_string(),
                    reason: RetryStartReason::Quick,
                },
                AutoRetryEvent::Start {
                    attempt: 3,
                    max_attempts: 2,
                    delay_ms: 0,
                    error_message: "primary down 3".to_string(),
                    reason: RetryStartReason::Backup {
                        backup_model: "backup-a/glm-5.3".to_string()
                    },
                },
                AutoRetryEvent::End {
                    success: true,
                    attempt: 3,
                    final_error: None,
                    restored_model: Some("primary/glm-5.3".to_string()),
                },
            ]
        );
    }

    #[tokio::test]
    async fn all_providers_failing_surfaces_the_final_error() {
        let candidates = vec![model("backup-a"), model("backup-b")];
        // Exhaust the primary (3 attempts), backup-a (3), backup-b (3):
        // 9 scripted failures.
        let script: Vec<AssistantMessage> = (0..9)
            .map(|index| error_message(Some("server_error"), Some(500), &format!("down {index}")))
            .collect();
        let harness = drive(&fast_failover(), &candidates, script).await;
        assert_eq!(harness.attempts, 9);
        assert_eq!(
            harness.switches,
            vec!["backup-a/glm-5.3", "backup-b/glm-5.3"]
        );
        // Every provider restored the primary before the final failure.
        assert_eq!(
            harness.restores,
            vec![Some("primary/glm-5.3".to_string()); 1]
        );
        let end = harness.events.last().expect("end event");
        assert_eq!(
            end,
            &AutoRetryEvent::End {
                success: false,
                attempt: 9,
                final_error: Some("down 8".to_string()),
                restored_model: None,
            }
        );
        // Six quick retries happened across the chain: two per provider.
        let quick_starts = harness
            .events
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    AutoRetryEvent::Start {
                        reason: RetryStartReason::Quick,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(quick_starts, 6);
    }

    #[tokio::test]
    async fn permanent_failures_never_walk_the_chain() {
        let candidates = vec![model("backup-a")];
        let script = vec![error_message(
            Some("invalid_request"),
            Some(400),
            "bad request",
        )];
        let harness = drive(&fast_failover(), &candidates, script).await;
        assert_eq!(harness.attempts, 1);
        assert!(harness.switches.is_empty());
        assert!(harness.events.is_empty());
    }

    #[tokio::test]
    async fn disabled_failover_or_no_candidates_is_the_plain_quick_loop() {
        let candidates = vec![model("backup-a")];
        // Disabled: the quick policy drives (3 retries at 2000ms base).
        let mut disabled = fast_failover();
        disabled.enabled = false;
        let script: Vec<AssistantMessage> = (0..4)
            .map(|index| error_message(Some("server_error"), None, &format!("down {index}")))
            .collect();
        let harness = drive(&disabled, &candidates, script).await;
        assert_eq!(harness.attempts, 4);
        assert!(harness.switches.is_empty());
        assert_eq!(harness.waits, vec![2000, 4000, 8000]);
        let end = harness.events.last().expect("end event");
        assert_eq!(
            end,
            &AutoRetryEvent::End {
                success: false,
                attempt: 3,
                final_error: Some("down 3".to_string()),
                restored_model: None,
            }
        );

        // No candidates: identical quick-loop behavior (the quick policy's
        // own schedule — three retries at its 2000ms base).
        let script: Vec<AssistantMessage> = (0..4)
            .map(|index| error_message(Some("server_error"), None, &format!("down {index}")))
            .collect();
        let harness = drive(&fast_failover(), &[], script).await;
        assert_eq!(harness.attempts, 4);
        assert!(harness.switches.is_empty());
        assert_eq!(harness.waits, vec![2000, 4000, 8000]);
        assert_eq!(harness.events.len(), 4);
    }

    #[tokio::test]
    async fn success_without_retries_emits_no_events() {
        let candidates = vec![model("backup-a")];
        let harness = drive(&fast_failover(), &candidates, vec![ok_message("done")]).await;
        assert_eq!(harness.attempts, 1);
        assert!(harness.events.is_empty());
        assert!(harness.switches.is_empty());
        assert!(harness.restores.is_empty());
    }

    /// A context overflow fails identically on every provider (TS
    /// `_isRetryableError`'s overflow guard): the failure surfaces without
    /// walking the chain, leaving the compact-and-retry recovery to own it.
    #[tokio::test]
    async fn context_overflow_never_walks_the_provider_chain() {
        let candidates = vec![model("backup-a"), model("backup-b")];
        let mut overflow = error_message(None, None, "prompt is too long");
        overflow.diagnostics = None;
        overflow.error_message =
            Some("prompt is too long: 213462 tokens > 200000 maximum".to_string());
        let harness = drive(&fast_failover(), &candidates, vec![overflow]).await;
        assert_eq!(harness.attempts, 1);
        assert!(harness.events.is_empty());
        assert!(harness.switches.is_empty());
        assert!(harness.restores.is_empty());
    }
}
