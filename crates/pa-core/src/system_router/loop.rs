//! The System 1 step loop: observe -> decide (ONE call) -> gate -> execute ->
//! record. Rust port of `packages/coding-agent/src/core/system-router/loop.ts`
//! (#2484).
//!
//! Mirrors the `SystemOneHarness` controller: a probability on every
//! transition, confidence gates per risk, refusal streaks and a repetition
//! guard toward `stuck`, explicit budgets, and a complete trace.
//!
//! One deliberate divergence from the TS reference: JS promises cannot be
//! cancelled, so the TS loop races uncancellable work against timers and
//! aborts via `AbortController` and detached handlers. Rust futures cancel on
//! drop, so every await point here is a `select!` over the work, the segment
//! deadline, and the external abort signal; the observable results (terminal
//! reasons, summaries, counters, trace) match the TS loop. One boundary
//! differs on purpose: a terminal observation that wins the biased race in
//! the same poll the deadline fires lands as `done`. The TS loop's post-race
//! clock check drops it, but that window is nearly unreachable behind
//! `Promise.race`, while the biased `select!` makes it the designed path for
//! finished work — and losing the environment's final state would tell
//! System 2 a finished episode timed out.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pa_agent::abort::AbortSignal;
use tokio::time::Instant;

use super::action_space::{
    compile_action_space, compile_decision_prompt, format_history_entry, gate_label,
    gate_threshold, observation_digest, CompiledActionSpace,
};
use super::decide::RouterDecisionFn;
use super::types::{
    RouterCloseOptions, RouterEnvironment, RouterGateSpec, RouterGateTrace, RouterGateVerdict,
    RouterModelInfo, RouterObservation, RouterRunStatus, RouterStepTrace, RouterUsage,
    SystemRouterRunResult, ESCALATE_ACTION, FINISH_ACTION,
};

/// Consecutive gate refusals before the loop stops as stuck.
pub const ROUTER_REFUSAL_STREAK_LIMIT: u32 = 3;
/// The same action with the same params on the same observation, this many
/// times, is stuck.
pub const ROUTER_REPETITION_LIMIT: u32 = 2;
/// Bounded cleanup grace handed to `close` past the deadline.
pub const ROUTER_CLOSE_GRACE_MS: u64 = 500;

/// One loop run's inputs.
pub struct SystemRouterLoopOptions {
    pub env: Arc<dyn RouterEnvironment>,
    pub goal: String,
    pub actions: BTreeMap<String, super::types::RouterActionSpec>,
    pub decide: RouterDecisionFn,
    pub model: RouterModelInfo,
    pub gate: RouterGateSpec,
    pub max_steps: u32,
    /// The caller-declared segment timeout, interpolated into every timeout
    /// summary so System 2 sees the figure it set.
    pub timeout_ms: u64,
    /// The wall-clock budget left for the loop. The segment runner passes
    /// what remains of the declared timeout after adapter init; `None` runs
    /// the loop on the full `timeout_ms`.
    pub budget_ms: Option<u64>,
    pub history_steps: u32,
    pub observation_chars: u32,
    /// External abort (host shutdown): ends the run `failed("aborted")`.
    pub signal: Option<AbortSignal>,
}

/// The mutable loop accounting that renders a terminal result.
struct LoopState {
    trace: Vec<RouterStepTrace>,
    usage: RouterUsage,
    executed: u64,
    refused: u64,
    model: RouterModelInfo,
}

impl LoopState {
    fn finish(
        &self,
        status: RouterRunStatus,
        reason: &str,
        summary: String,
    ) -> SystemRouterRunResult {
        SystemRouterRunResult {
            status,
            reason: reason.to_string(),
            steps: self.trace.len(),
            executed: self.executed,
            refused: self.refused,
            trace: self.trace.clone(),
            summary,
            model: self.model.clone(),
            usage: self.usage,
        }
    }
}

/// Whether some work finished, the segment deadline elapsed, or the external
/// signal aborted.
pub(super) enum Race<T> {
    Done(T),
    Deadline,
    Aborted,
}

/// Race one operation against the segment deadline and the external abort
/// signal. Work never starts once the budget is gone (a timer-lag gap must not
/// dispatch a new side effect).
pub(super) async fn race<T, F>(signal: Option<&AbortSignal>, deadline: Instant, work: F) -> Race<T>
where
    F: Future<Output = T>,
{
    if signal.is_some_and(AbortSignal::is_aborted) {
        return Race::Aborted;
    }
    if Instant::now() >= deadline {
        return Race::Deadline;
    }
    tokio::pin!(work);
    let timeout = tokio::time::sleep_until(deadline);
    tokio::pin!(timeout);
    // Biased: finished work is never discarded for a deadline that became
    // ready in the same poll, and an abort outranks a simultaneous deadline.
    if let Some(signal) = signal {
        tokio::select! {
            biased;
            value = &mut work => Race::Done(value),
            () = signal.aborted() => Race::Aborted,
            () = &mut timeout => Race::Deadline,
        }
    } else {
        tokio::select! {
            biased;
            value = &mut work => Race::Done(value),
            () = &mut timeout => Race::Deadline,
        }
    }
}

/// Wall-clock milliseconds (TS `Date.now()`).
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn observation_chars(observation: &RouterObservation) -> usize {
    observation.text.chars().count()
}

/// Run one bounded System 1 segment.
///
/// # Errors
///
/// Returns an error only when the declared action space cannot be compiled
/// (a reserved or empty space); every runtime failure is a `failed` result.
pub async fn run_system_router_loop(
    options: SystemRouterLoopOptions,
) -> anyhow::Result<SystemRouterRunResult> {
    let budget_ms = options.budget_ms.unwrap_or(options.timeout_ms);
    let deadline = Instant::now() + Duration::from_millis(budget_ms);
    let result = run_loop(&options, deadline).await;
    // Adapter cleanup must not extend the segment: hand `close` the remaining
    // budget plus the bounded grace.
    let remaining_ms = deadline
        .saturating_duration_since(Instant::now())
        .as_millis() as u64;
    options
        .env
        .close(RouterCloseOptions {
            budget_ms: Some(remaining_ms.saturating_add(ROUTER_CLOSE_GRACE_MS)),
        })
        .await;
    result
}

async fn run_loop(
    options: &SystemRouterLoopOptions,
    deadline: Instant,
) -> anyhow::Result<SystemRouterRunResult> {
    // Validate and compile the declared space; a reserved name or an empty
    // space fails before the adapter is touched.
    let compiled: CompiledActionSpace = compile_action_space(&options.actions)?;
    let by_name = &compiled.by_name;
    let history_steps = options.history_steps as usize;
    let observation_budget = options.observation_chars as usize;
    let mut state = LoopState {
        trace: Vec::new(),
        usage: RouterUsage::default(),
        executed: 0,
        refused: 0,
        model: options.model.clone(),
    };
    let mut history: Vec<String> = Vec::new();
    let mut refusal_streak: u32 = 0;
    let mut repeat_digest: Option<String> = None;
    let mut repeat_counts: HashMap<String, u32> = HashMap::new();
    let signal = options.signal.as_ref();

    // A pre-aborted signal must not mutate the external environment first.
    if signal.is_some_and(AbortSignal::is_aborted) {
        return Ok(state.finish(
            RouterRunStatus::Failed,
            "aborted",
            "Router aborted before reset.".to_string(),
        ));
    }
    match race(signal, deadline, options.env.reset(&options.goal)).await {
        Race::Aborted => {
            return Ok(state.finish(
                RouterRunStatus::Failed,
                "aborted",
                "Router aborted before reset.".to_string(),
            ))
        }
        Race::Deadline => {
            return Ok(state.finish(
                RouterRunStatus::Incomplete,
                "timeout",
                format!(
                "Stopped before the first step: the segment timeout of {}ms elapsed during reset.",
                options.timeout_ms
            ),
            ))
        }
        Race::Done(Err(error)) => {
            return Ok(state.finish(
                RouterRunStatus::Failed,
                "environment_error",
                format!("Environment failed resetting at segment start: {error}"),
            ))
        }
        Race::Done(Ok(())) => {}
    }

    for step in 0..options.max_steps as usize {
        if signal.is_some_and(AbortSignal::is_aborted) {
            return Ok(state.finish(
                RouterRunStatus::Failed,
                "aborted",
                "Router aborted before the current step.".to_string(),
            ));
        }
        let observation = match race(signal, deadline, options.env.observe()).await {
            Race::Aborted => {
                return Ok(state.finish(
                    RouterRunStatus::Failed,
                    "aborted",
                    "Router aborted while observing the current step.".to_string(),
                ))
            }
            Race::Deadline => {
                return Ok(state.finish(
                    RouterRunStatus::Incomplete,
                    "timeout",
                    format!(
                        "Stopped at step {step}: the segment timeout of {}ms elapsed.",
                        options.timeout_ms
                    ),
                ))
            }
            Race::Done(Err(error)) => {
                return Ok(state.finish(
                    RouterRunStatus::Failed,
                    "environment_error",
                    format!("Environment failed observing at step {step}: {error}"),
                ))
            }
            Race::Done(Ok(observation)) => observation,
        };
        // A terminal observation that won the biased race lands before the
        // deadline ends the segment: the environment already delivered its
        // final state, and dropping it would tell System 2 a finished
        // episode timed out and may be restarted.
        if observation.terminal {
            return Ok(state.finish(
                RouterRunStatus::Done,
                "environment_terminal",
                format!(
                    "Environment reported terminal state at step {step} after {} executed action(s).",
                    state.executed
                ),
            ));
        }
        // The leftover budget still guards the decision dispatch: a drained
        // segment must not start a new side effect.
        if Instant::now() >= deadline {
            return Ok(state.finish(
                RouterRunStatus::Incomplete,
                "timeout",
                format!(
                    "Stopped at step {step}: the segment timeout of {}ms elapsed while observing.",
                    options.timeout_ms
                ),
            ));
        }
        let digest = observation_digest(&observation);
        let prompt = compile_decision_prompt(
            &options.goal,
            &observation,
            if history_steps > 0 {
                &history[history.len().saturating_sub(history_steps)..]
            } else {
                &[]
            },
            &compiled,
            observation_budget,
        );
        let decision_started_ms = now_ms();
        let decision_started = Instant::now();
        let decision = match race(
            signal,
            deadline,
            (options.decide)(super::decide::RouterDecisionRequest {
                prompt,
                image: observation.image.clone(),
                signal: options.signal.clone(),
            }),
        )
        .await
        {
            Race::Aborted => {
                return Ok(state.finish(
                    RouterRunStatus::Failed,
                    "aborted",
                    "Router aborted during the current step.".to_string(),
                ))
            }
            Race::Deadline => {
                return Ok(state.finish(
                    RouterRunStatus::Incomplete,
                    "timeout",
                    format!(
                        "Stopped at step {step}: the segment timeout of {}ms elapsed mid-decision.",
                        options.timeout_ms
                    ),
                ))
            }
            Race::Done(Err(error)) => {
                return Ok(state.finish(
                    RouterRunStatus::Failed,
                    "decision_model_error",
                    format!("Decision function threw at step {step}: {error}"),
                ))
            }
            Race::Done(Ok(decision)) => decision,
        };
        let latency_ms = decision_started.elapsed().as_millis() as u64;
        if let Some(usage) = decision.usage {
            state.usage.add(usage);
        }

        if let Some(model_error) = decision.model_error {
            state.trace.push(RouterStepTrace {
                step,
                timestamp_ms: decision_started_ms,
                latency_ms,
                action: None,
                params: BTreeMap::new(),
                confidence: None,
                gate: RouterGateTrace {
                    threshold: 0.0,
                    verdict: RouterGateVerdict::ParseFailure,
                },
                observation_digest: digest,
                observation_chars: observation_chars(&observation),
                result: model_error.clone(),
                terminal: false,
                thinking_level: options.model.thinking_level.clone(),
                usage: decision.usage,
            });
            return Ok(state.finish(
                RouterRunStatus::Failed,
                "decision_model_error",
                format!("Decision model failed at step {step}: {model_error}"),
            ));
        }

        let action = decision.action.as_ref().and_then(|name| by_name.get(name));
        let (Some(action), Some(confidence)) = (action, decision.confidence) else {
            refusal_streak += 1;
            state.refused += 1;
            let reason = decision
                .parse_error
                .clone()
                .unwrap_or_else(|| "decision was not a valid choice".to_string());
            state.trace.push(RouterStepTrace {
                step,
                timestamp_ms: decision_started_ms,
                latency_ms,
                action: None,
                params: BTreeMap::new(),
                confidence: None,
                gate: RouterGateTrace {
                    threshold: 0.0,
                    verdict: RouterGateVerdict::ParseFailure,
                },
                observation_digest: digest,
                observation_chars: observation_chars(&observation),
                result: format!("refused: {reason}"),
                terminal: false,
                thinking_level: options.model.thinking_level.clone(),
                usage: decision.usage,
            });
            if refusal_streak >= ROUTER_REFUSAL_STREAK_LIMIT {
                return Ok(state.finish(
                    RouterRunStatus::Stuck,
                    "no_confident_decision",
                    format!(
                        "Stopped at step {step}: {refusal_streak} consecutive decisions were not a valid choice from the action space."
                    ),
                ));
            }
            history.push("invalid decision -> refused".to_string());
            continue;
        };

        let threshold = gate_threshold(options.gate, action);
        if confidence < threshold {
            refusal_streak += 1;
            state.refused += 1;
            let result = format!(
                "refused: confidence {:.2} below {} gate {:.2}",
                confidence,
                gate_label(action),
                threshold
            );
            state.trace.push(RouterStepTrace {
                step,
                timestamp_ms: decision_started_ms,
                latency_ms,
                action: Some(action.name.clone()),
                params: decision.params.clone(),
                confidence: Some(confidence),
                gate: RouterGateTrace {
                    threshold,
                    verdict: RouterGateVerdict::Refused,
                },
                observation_digest: digest,
                observation_chars: observation_chars(&observation),
                result,
                terminal: false,
                thinking_level: options.model.thinking_level.clone(),
                usage: decision.usage,
            });
            history.push(format_history_entry(
                &action.name,
                &decision.params,
                "refused below gate",
            ));
            if refusal_streak >= ROUTER_REFUSAL_STREAK_LIMIT {
                return Ok(state.finish(
                    RouterRunStatus::Stuck,
                    "no_confident_decision",
                    format!(
                        "Stopped at step {step}: no action cleared its confidence gate for {refusal_streak} consecutive decisions."
                    ),
                ));
            }
            continue;
        }

        // The gate passed; an abort during the in-flight decision must not be
        // reported as successful work (e.g. finish after a shutdown signal).
        if signal.is_some_and(AbortSignal::is_aborted) {
            return Ok(state.finish(
                RouterRunStatus::Failed,
                "aborted",
                "Router aborted during the current step.".to_string(),
            ));
        }
        refusal_streak = 0;
        if action.name == FINISH_ACTION {
            state.trace.push(RouterStepTrace {
                step,
                timestamp_ms: decision_started_ms,
                latency_ms,
                action: Some(action.name.clone()),
                params: BTreeMap::new(),
                confidence: Some(confidence),
                gate: RouterGateTrace {
                    threshold,
                    verdict: RouterGateVerdict::Pass,
                },
                observation_digest: digest,
                observation_chars: observation_chars(&observation),
                result: "goal declared reached".to_string(),
                terminal: true,
                thinking_level: options.model.thinking_level.clone(),
                usage: decision.usage,
            });
            return Ok(state.finish(
                RouterRunStatus::Done,
                "goal_reached",
                format!(
                    "Goal declared reached at step {step} after {} executed action(s).",
                    state.executed
                ),
            ));
        }
        if action.name == ESCALATE_ACTION {
            state.trace.push(RouterStepTrace {
                step,
                timestamp_ms: decision_started_ms,
                latency_ms,
                action: Some(action.name.clone()),
                params: BTreeMap::new(),
                confidence: Some(confidence),
                gate: RouterGateTrace {
                    threshold,
                    verdict: RouterGateVerdict::Pass,
                },
                observation_digest: digest,
                observation_chars: observation_chars(&observation),
                result: "escalation requested".to_string(),
                terminal: true,
                thinking_level: options.model.thinking_level.clone(),
                usage: decision.usage,
            });
            return Ok(state.finish(
                RouterRunStatus::Escalated,
                "escalation_requested",
                format!(
                    "Escalated at step {step} after {} executed action(s); review the trace and steer.",
                    state.executed
                ),
            ));
        }

        // Repeated-state detection: the same action with the same params on the
        // same observation, adjacent or interleaved with other repeats.
        // Canonical (key-sorted) JSON of the params: `BTreeMap` serializes
        // sorted, so the signature cannot collide the way `key=value&...` can.
        let canonical_params = serde_json::to_string(&decision.params).unwrap_or_default();
        let signature = format!("{digest}:{}:{canonical_params}", action.name);
        if repeat_digest.as_deref() != Some(digest.as_str()) {
            // The observation moved: past counts are stale.
            repeat_counts.clear();
            repeat_digest = Some(digest.clone());
        }
        let repeat_count = repeat_counts.get(&signature).copied().unwrap_or(0);
        repeat_counts.insert(signature, repeat_count + 1);
        if repeat_count + 1 >= ROUTER_REPETITION_LIMIT {
            state.refused += 1;
            state.trace.push(RouterStepTrace {
                step,
                timestamp_ms: decision_started_ms,
                latency_ms,
                action: Some(action.name.clone()),
                params: decision.params.clone(),
                confidence: Some(confidence),
                gate: RouterGateTrace {
                    threshold,
                    verdict: RouterGateVerdict::Pass,
                },
                observation_digest: digest,
                observation_chars: observation_chars(&observation),
                result: format!(
                    "repeated {} on the same observation {} times",
                    action.name,
                    repeat_count + 1
                ),
                terminal: false,
                thinking_level: options.model.thinking_level.clone(),
                usage: decision.usage,
            });
            return Ok(state.finish(
                RouterRunStatus::Stuck,
                "repeated_state",
                format!(
                    "Stopped at step {step}: {} repeated on the same observation {} times.",
                    action.name,
                    repeat_count + 1
                ),
            ));
        }

        // Execute only while the wall-clock budget remains: a dispatched action
        // applies a side effect the loop cannot take back.
        if Instant::now() >= deadline {
            return Ok(state.finish(
                RouterRunStatus::Incomplete,
                "timeout",
                format!(
                    "Stopped at step {step}: the segment timeout of {}ms elapsed before execution.",
                    options.timeout_ms
                ),
            ));
        }
        let execution = race(
            signal,
            deadline,
            options.env.execute(&action.name, &decision.params),
        )
        .await;
        match execution {
            Race::Aborted => {
                return Ok(state.finish(
                    RouterRunStatus::Failed,
                    "aborted",
                    "Router aborted during the current step.".to_string(),
                ))
            }
            Race::Deadline => {
                // The dispatch already reached the adapter: record the unknown
                // outcome and count the execution, instead of letting a
                // supervisor retry a possibly-applied action.
                state.executed += 1;
                state.trace.push(RouterStepTrace {
                    step,
                    timestamp_ms: decision_started_ms,
                    latency_ms,
                    action: Some(action.name.clone()),
                    params: decision.params.clone(),
                    confidence: Some(confidence),
                    gate: RouterGateTrace {
                        threshold,
                        verdict: RouterGateVerdict::Pass,
                    },
                    observation_digest: digest,
                    observation_chars: observation_chars(&observation),
                    result: format!(
                        "dispatched {}; outcome unknown (segment timeout elapsed mid-execution)",
                        action.name
                    ),
                    terminal: false,
                    thinking_level: options.model.thinking_level.clone(),
                    usage: decision.usage,
                });
                return Ok(state.finish(
                    RouterRunStatus::Incomplete,
                    "timeout",
                    format!(
                        "Stopped at step {step}: the segment timeout of {}ms elapsed mid-execution; the dispatched action's outcome is unknown.",
                        options.timeout_ms
                    ),
                ));
            }
            Race::Done(Err(error)) => {
                // The dispatch may have reached the adapter before the
                // rejection: count the execution and record the unknown
                // outcome.
                state.executed += 1;
                let message = format!(
                    "Environment failed executing {} at step {step}: {error} (outcome unknown)",
                    action.name
                );
                state.trace.push(RouterStepTrace {
                    step,
                    timestamp_ms: decision_started_ms,
                    latency_ms,
                    action: Some(action.name.clone()),
                    params: decision.params.clone(),
                    confidence: Some(confidence),
                    gate: RouterGateTrace {
                        threshold,
                        verdict: RouterGateVerdict::Pass,
                    },
                    observation_digest: digest,
                    observation_chars: observation_chars(&observation),
                    result: message.clone(),
                    terminal: false,
                    thinking_level: options.model.thinking_level.clone(),
                    usage: decision.usage,
                });
                return Ok(state.finish(RouterRunStatus::Failed, "environment_error", message));
            }
            Race::Done(Ok(execution)) => {
                state.executed += 1;
                // The execution result text a trace entry carries (240-char cap).
                let result_text = if execution.text.chars().count() > 240 {
                    format!(
                        "{}...",
                        execution.text.chars().take(237).collect::<String>()
                    )
                } else {
                    execution.text.clone()
                };
                state.trace.push(RouterStepTrace {
                    step,
                    timestamp_ms: decision_started_ms,
                    latency_ms,
                    action: Some(action.name.clone()),
                    params: decision.params.clone(),
                    confidence: Some(confidence),
                    gate: RouterGateTrace {
                        threshold,
                        verdict: RouterGateVerdict::Pass,
                    },
                    observation_digest: digest,
                    observation_chars: observation_chars(&observation),
                    result: result_text.clone(),
                    terminal: execution.terminal,
                    thinking_level: options.model.thinking_level.clone(),
                    usage: decision.usage,
                });
                history.push(format_history_entry(
                    &action.name,
                    &decision.params,
                    &result_text,
                ));
                if execution.terminal {
                    return Ok(state.finish(
                        RouterRunStatus::Done,
                        "environment_terminal",
                        format!(
                            "Environment reported terminal state at step {step} after {} executed action(s).",
                            state.executed
                        ),
                    ));
                }
            }
        }
    }
    Ok(state.finish(
        RouterRunStatus::Incomplete,
        "max_steps",
        format!(
            "Stopped after {} steps: the segment step budget is exhausted; review the trace and steer.",
            options.max_steps
        ),
    ))
}

// The unit battery lives in the child module (loop::tests).
#[cfg(test)]
mod tests;
