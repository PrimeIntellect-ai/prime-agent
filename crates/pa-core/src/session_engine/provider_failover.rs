//! Provider failover: keeps a turn alive across configured providers serving the same model — a
//! spent per-provider retry budget re-routes to the next provider in catalog order; the decision
//! logic is pure, the caller owns the sleep/switch. Divergence (operator ruling 2026-09-23): retry
//! waits carry ±20% jitter (TS has none).

use std::future::Future;

use pa_agent::abort::AbortSignal;
use pa_agent::types::{AssistantMessage, StopReason};
use pa_types::ai::Model;

use super::auto_retry::{run_turn_with_auto_retry, AutoRetryEvent, RetryStartReason};
use super::provider_park::{is_quota_block_failure, ParkDecisionCallback};
use super::provider_retry::{
    has_provider_stream_failure, is_agent_lifecycle_failure, is_context_overflow_failure,
    is_faux_provider_queue_exhausted, is_permanent_provider_failure_kind,
    is_unsupported_tool_failure, jittered_delay_ms, provider_retry_delay,
    provider_stream_failure_kind, provider_stream_failure_retry_after_ms,
    provider_stream_failure_status, retry_jitter_rand01, ProviderRetryDelay, ProviderRetryPolicy,
};

/// Per-provider retry budget and backoff schedule (settings
/// `retry.failover`). With no failover candidate the TS quick-retry
/// policy alone governs the turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFailoverPolicy {
    pub enabled: bool,
    pub max_retries: u32,
    /// First backoff delay (doubles each retry).
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

/// 3 retries per provider, 1s doubling backoff capped at 30s.
/// (SANCTIONED DIVERGENCE, operator ruling 2026-09-23 "30 retries is a
/// lot for provider failures": this was 5.)
pub const DEFAULT_PROVIDER_FAILOVER_POLICY: ProviderFailoverPolicy = ProviderFailoverPolicy {
    enabled: true,
    max_retries: 3,
    base_delay_ms: 1000,
    max_delay_ms: 30000,
};

/// The whole-episode retry ceiling (SANCTIONED DIVERGENCE, operator
/// ruling 2026-09-23): the band tops at 8, the same anchor as TS's own
/// provider-wait `maxParks: 8` — the chain gives up after 8 retries no
/// matter how many candidates remain.
pub const MAX_TOTAL_PROVIDER_RETRIES: u32 = 8;

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

/// Backoff delay before retry `attempt` (1-based) on one provider; a server-requested wait
/// (`Retry-After`) is honored like the TS quick-retry delay.
#[must_use]
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

/// Drive one turn through the provider-failover chain. With failover disabled or no candidates this
/// is exactly [`run_turn_with_auto_retry`] under `quick_policy`; otherwise each provider gets
/// `failover.max_retries` quick retries, and a spent budget switches to the next candidate
/// immediately. `switch` re-binds the session to a provider; `restore` hands the primary back and
/// returns its `"provider/model-id"`.
///
/// # Errors
///
/// Returns the final attempt's error when every candidate exhausts its
/// budget, or a callback's error as it surfaces. An `attempt` that
/// errors outright propagates immediately, without spending budget.
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
    mut park: Option<ParkDecisionCallback<'_>>,
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
        // The pass-through moves the park seam: the loop below cannot
        // reach (and must not reborrow) it.
        return run_turn_with_auto_retry(
            quick_policy,
            context_window,
            signal,
            attempt,
            emit,
            wait,
            park,
        )
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
        // rejected request fails the same way on every provider.
        let non_retryable = is_agent_lifecycle_failure(&message)
            || is_faux_provider_queue_exhausted(&message)
            // A context overflow fails identically on every provider (TS
            // `_isRetryableError`): the recovery owns it.
            || is_context_overflow_failure(&message, context_window)
            || is_unsupported_tool_failure(&message)
            || is_permanent_provider_failure_kind(
                provider_stream_failure_kind(&message).as_deref(),
                total_retries,
                provider_stream_failure_status(&message),
            );
        if non_retryable {
            if switched {
                let _ = restore().await?;
            }
            // SANCTIONED DIVERGENCE (the 402 diagnosis, operator ruling):
            // a first-attempt provider failure still discloses at
            // attempt 0; the self-managed arms (overflow recovery,
            // lifecycle, faux) stay silent.
            if total_retries > 0
                || (has_provider_stream_failure(&message)
                    && !is_context_overflow_failure(&message, context_window))
            {
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
        // The whole-episode ceiling binds first: a long candidate chain
        // gives up here instead of stacking per-provider budgets.
        if total_retries > MAX_TOTAL_PROVIDER_RETRIES {
            if switched {
                let _ = restore().await?;
            }
            emit(AutoRetryEvent::End {
                success: false,
                attempt: total_retries - 1,
                final_error: Some(final_error_of(&message)),
                restored_model: None,
            })
            .await?;
            return Ok(message);
        }
        if retries_on_provider > failover.max_retries {
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
            // The TS backup-model retry re-issues immediately (`delayMs: 0`).
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
            // Jittered (SANCTIONED DIVERGENCE, operator ruling
            // 2026-09-23): the jittered value is both waited and
            // reported.
            ProviderRetryDelay::Wait { delay_ms } => {
                jittered_delay_ms(delay_ms, retry_jitter_rand01())
            }
            ProviderRetryDelay::ExceedsCap { retry_after_ms } => {
                if switched {
                    let _ = restore().await?;
                }
                // The give-up sentence here is the park's abort message
                // (TS `reset-too-far`).
                let abort = format!(
                    "Provider requested a {}s wait before retrying (above retry.provider.maxRetryDelayMs={}ms)",
                    retry_after_ms.div_ceil(1000),
                    quick_policy.max_retry_delay_ms,
                );
                // The park seam is a quota-failure seam: other
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
                    // The parked status replaces the give-up (TS
                    // `_finishQuotaParkedTurn`'s `finalError`).
                    Some(outcome) => outcome.status_message,
                    None => format!(
                        "{abort}: {}",
                        message.error_message.as_deref().unwrap_or("unknown error"),
                    ),
                };
                emit(AutoRetryEvent::End {
                    success: false,
                    attempt: total_retries - 1,
                    final_error: Some(final_error),
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

/// The user-visible error text of a failed turn.
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
            "contextWindow": 128_000, "maxTokens": 8192
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

    /// Run the driver over a scripted attempt sequence (one assistant
    /// message per attempt).
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
            None,
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
        assert_eq!(schedule, vec![1000, 2000, 4000, 8000, 16000, 30000, 30000]);
        assert_eq!(
            failover_retry_delay(1, Some(5000), &failover, 60000),
            ProviderRetryDelay::Wait { delay_ms: 5000 }
        );
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
        assert_eq!(harness.attempts, 4);
        assert_eq!(harness.switches, vec!["backup-a/glm-5.3"]);
        assert_eq!(harness.restores, vec![Some("primary/glm-5.3".to_string())]);
        // Two jittered quick waits on the primary, then the immediate backup re-issue.
        assert_eq!(harness.waits.len(), 2, "waits: {:?}", harness.waits);
        assert!(
            (4..=7).contains(&harness.waits[0]) && (8..=14).contains(&harness.waits[1]),
            "jittered waits {:?} outside the [4,7]/[8,14] bands",
            harness.waits
        );
        let delays: Vec<u64> = harness
            .events
            .iter()
            .filter_map(|event| match event {
                AutoRetryEvent::Start {
                    delay_ms,
                    reason: RetryStartReason::Quick,
                    ..
                } => Some(*delay_ms),
                _ => None,
            })
            .collect();
        assert_eq!(
            delays, harness.waits,
            "reported == waited: {:?}",
            harness.events
        );
        let shape_matches = matches!(
            harness.events.as_slice(),
            [
                AutoRetryEvent::Start {
                    attempt: 1,
                    max_attempts: 2,
                    error_message: error_one,
                    reason: RetryStartReason::Quick,
                    ..
                },
                AutoRetryEvent::Start {
                    attempt: 2,
                    max_attempts: 2,
                    error_message: error_two,
                    reason: RetryStartReason::Quick,
                    ..
                },
                AutoRetryEvent::Start {
                    attempt: 3,
                    max_attempts: 2,
                    delay_ms: 0,
                    error_message: error_three,
                    reason: RetryStartReason::Backup {
                        backup_model: switched_model,
                    },
                },
                AutoRetryEvent::End {
                    success: true,
                    attempt: 3,
                    final_error: None,
                    restored_model,
                },
            ] if error_one == "primary down 1"
                && error_two == "primary down 2"
                && error_three == "primary down 3"
                && switched_model == "backup-a/glm-5.3"
                && restored_model.as_deref() == Some("primary/glm-5.3")
        );
        assert!(shape_matches, "events: {:?}", harness.events);
    }

    /// Operator ruling 2026-09-23: the chain gives up at
    /// [`MAX_TOTAL_PROVIDER_RETRIES`] retries.
    #[tokio::test]
    async fn a_long_candidate_chain_gives_up_at_the_episode_cap() {
        // Six backup candidates: without the cap the walk would consume
        // (1 + candidates) * (1 + budget) attempts (the ~30 the operator ruled out).
        let candidates: Vec<Model> = (1..=6)
            .map(|index| model(&format!("backup-{index}")))
            .collect();
        let script: Vec<AssistantMessage> = (0..32)
            .map(|index| error_message(Some("server_error"), Some(500), &format!("down {index}")))
            .collect();
        let harness = drive(&fast_failover(), &candidates, script).await;
        assert_eq!(harness.attempts, 1 + MAX_TOTAL_PROVIDER_RETRIES as usize);
        // With the 2-retry budget, providers spend at retries 3 and 6.
        assert_eq!(
            harness.switches.len(),
            2,
            "switches inside the cap: {:?}",
            harness.switches
        );
        let end = harness.events.last().expect("end event");
        assert_eq!(
            end,
            &AutoRetryEvent::End {
                success: false,
                attempt: MAX_TOTAL_PROVIDER_RETRIES,
                final_error: Some("down 8".to_string()),
                restored_model: None,
            }
        );
        assert!(
            harness.events.iter().all(|event| !matches!(
                event,
                AutoRetryEvent::Start { attempt, .. } if *attempt > MAX_TOTAL_PROVIDER_RETRIES
            )),
            "no attempt exceeds the episode cap: {:?}",
            harness.events
        );
    }

    #[tokio::test]
    async fn all_providers_failing_surfaces_the_final_error() {
        let candidates = vec![model("backup-a"), model("backup-b")];
        let script: Vec<AssistantMessage> = (0..9)
            .map(|index| error_message(Some("server_error"), Some(500), &format!("down {index}")))
            .collect();
        let harness = drive(&fast_failover(), &candidates, script).await;
        assert_eq!(harness.attempts, 9);
        assert_eq!(
            harness.switches,
            vec!["backup-a/glm-5.3", "backup-b/glm-5.3"]
        );
        assert_eq!(
            harness.restores,
            vec![Some("primary/glm-5.3".to_string()); 1]
        );
        let end = harness.events.last().expect("end event");
        // The episode cap ends the chain after the 9th attempt.
        assert_eq!(
            end,
            &AutoRetryEvent::End {
                success: false,
                attempt: MAX_TOTAL_PROVIDER_RETRIES,
                final_error: Some("down 8".to_string()),
                restored_model: None,
            }
        );
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

    /// The 402 diagnosis: no provider failure settles silently.
    #[tokio::test]
    async fn permanent_failures_never_walk_the_chain_but_disclose() {
        let candidates = vec![model("backup-a")];
        let script = vec![error_message(
            Some("invalid_request"),
            Some(400),
            "bad request",
        )];
        let harness = drive(&fast_failover(), &candidates, script).await;
        assert_eq!(harness.attempts, 1);
        assert!(harness.switches.is_empty());
        assert_eq!(
            harness.events.as_slice(),
            &[AutoRetryEvent::End {
                success: false,
                attempt: 0,
                final_error: Some("bad request".to_string()),
                restored_model: None,
            }]
        );
    }

    /// The router's tool-use 404 is permanent even though a plain 404 is
    /// transient (the dogfood incident): every provider rejects tools identically.
    #[tokio::test]
    async fn unsupported_tool_failures_never_walk_the_chain_but_disclose() {
        let candidates = vec![model("backup-a")];
        let script = vec![error_message(
            Some("invalid_request"),
            Some(404),
            "404 No endpoints found that support tool use. Try disabling \"ipython\".",
        )];
        let harness = drive(&fast_failover(), &candidates, script).await;
        assert_eq!(harness.attempts, 1);
        assert!(harness.switches.is_empty());
        assert_eq!(
            harness.events.as_slice(),
            &[AutoRetryEvent::End {
                success: false,
                attempt: 0,
                final_error: Some(
                    "404 No endpoints found that support tool use. Try disabling \"ipython\"."
                        .to_string(),
                ),
                restored_model: None,
            }]
        );
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
        // Jittered around the 2s/4s/8s ladder (±20% with rounding
        // headroom: [1600, 2800], [3200, 5600], [6400, 11200]).
        let band = |base: u64| (base * 4 / 5, base * 7 / 5);
        for (wait, base) in harness.waits.iter().zip([2000u64, 4000, 8000]) {
            let (low, high) = band(base);
            assert!(
                (low..=high).contains(wait),
                "jittered wait {wait} outside [{low}, {high}]: {:?}",
                harness.waits
            );
        }
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

        // No candidates: identical quick-loop behavior.
        let script: Vec<AssistantMessage> = (0..4)
            .map(|index| error_message(Some("server_error"), None, &format!("down {index}")))
            .collect();
        let harness = drive(&fast_failover(), &[], script).await;
        assert_eq!(harness.attempts, 4);
        assert!(harness.switches.is_empty());
        let band = |base: u64| (base * 4 / 5, base * 7 / 5);
        for (wait, base) in harness.waits.iter().zip([2000u64, 4000, 8000]) {
            let (low, high) = band(base);
            assert!(
                (low..=high).contains(wait),
                "jittered wait {wait} outside [{low}, {high}]: {:?}",
                harness.waits
            );
        }
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

    /// The compact-and-retry recovery owns it (TS `_isRetryableError`).
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
