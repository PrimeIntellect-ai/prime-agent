//! The segment runner: always init the adapter, resolve the action space
//! (the spec's declaration wins over the adapter's defaults), run the loop,
//! and close the adapter on every path. Rust port of
//! `packages/coding-agent/src/core/system-router/segment.ts` (#2484).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use pa_agent::abort::AbortSignal;
use pa_types::ai::Model;
use tokio::time::Instant;

use crate::session_engine::provider_retry::ProviderRetryPolicy;

use super::action_space::compile_action_space;
use super::decide::{
    create_model_decision_function, router_thinking_level, RouterDecisionContext, RouterDecisionFn,
};
use super::r#loop::{
    race, run_system_router_loop, Race, SystemRouterLoopOptions, ROUTER_CLOSE_GRACE_MS,
};
use super::stdio_environment::StdioRouterEnvironment;
use super::types::{
    parse_environment_actions, ParsedSystemRouterRunSpec, RouterCloseOptions, RouterModelInfo,
    RouterRunStatus, RouterSegmentEnvironment, RouterUsage, SystemRouterRunResult,
};

/// One segment run's resolved model, auth, and environment seam.
pub struct RouterSegmentOptions {
    pub model: Model,
    pub api_key: Option<String>,
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    pub session_id: Option<String>,
    pub policy: ProviderRetryPolicy,
    /// Defaults to a [`StdioRouterEnvironment`] built from the spec.
    pub env: Option<Arc<dyn RouterSegmentEnvironment>>,
    /// The decision-function override (the verification seam, like the
    /// compaction `SummarizerFn`): the model-backed function is built when
    /// this is `None`.
    pub decide: Option<RouterDecisionFn>,
    /// The adapter working directory when the spec declares none. The
    /// session passes its own working directory, so a relative adapter
    /// command or path resolves against the session, not the host process
    /// (the two differ in a daemon worker switched onto another session).
    /// A relative declared `environment.stdio.cwd` joins this directory too
    /// ([`resolve_adapter_cwd`]): `current_dir` on a raw relative path
    /// would resolve against the host process cwd instead.
    pub default_cwd: Option<String>,
    /// External abort (host shutdown): ends the run `failed("aborted")`.
    pub signal: Option<AbortSignal>,
}

/// Resolve the adapter's working directory: the spec's declared cwd wins,
/// but a relative one joins the session working directory (the
/// `default_cwd`), because `current_dir` on a raw relative path resolves
/// against the host process cwd and the two differ in a daemon worker
/// switched onto another session: the adapter would run in the wrong
/// place (#3184 review). An empty declared cwd is omitted, not a path
/// (the TS segment seam's truthiness spread, `cwd ? { cwd } : {}`):
/// models often emit `""` for optional fields, and `current_dir` on an
/// empty path fails the spawn, so the run falls back to the session
/// working directory (#3184 review). A declared cwd stays raw when the
/// session declares no working directory: there is nothing to resolve
/// against, so it keeps the host-process semantics of the TS `spawn`
/// default.
fn resolve_adapter_cwd(declared: Option<&str>, session: Option<&str>) -> Option<String> {
    let declared = declared.filter(|declared| !declared.is_empty());
    match (declared, session) {
        (Some(declared), Some(session)) if !Path::new(declared).is_absolute() => Some(
            Path::new(session)
                .join(declared)
                .to_string_lossy()
                .into_owned(),
        ),
        (Some(declared), _) => Some(declared.to_string()),
        (None, session) => session.map(str::to_string),
    }
}

/// Run one bounded router segment. The adapter is closed on every path,
/// including init failures and a missing action space, so the subprocess
/// never leaks.
///
/// # Errors
///
/// Returns an error when the adapter cannot be initialized, init exceeds the
/// segment timeout, the resolved action space is malformed, or no action
/// space exists.
pub async fn run_router_segment(
    spec: &ParsedSystemRouterRunSpec,
    options: RouterSegmentOptions,
) -> anyhow::Result<SystemRouterRunResult> {
    let env: Arc<dyn RouterSegmentEnvironment> = options.env.clone().unwrap_or_else(|| {
        Arc::new(StdioRouterEnvironment::new(
            spec.environment.stdio.command.clone(),
            resolve_adapter_cwd(
                spec.environment.stdio.cwd.as_deref(),
                options.default_cwd.as_deref(),
            ),
            spec.environment.stdio.request_timeout_ms,
            spec.environment.stdio.init.clone(),
        ))
    });
    let deadline = Instant::now() + Duration::from_millis(spec.timeout_ms);
    let result = run_segment(spec, &options, Arc::clone(&env), deadline).await;
    // The loop closes the env on its own paths; this guards the window between
    // init and the loop so the adapter process never leaks. The grace keeps a
    // wedged-but-forwardable container adapter stoppable.
    let remaining_ms = deadline
        .saturating_duration_since(Instant::now())
        .as_millis() as u64;
    env.close(RouterCloseOptions {
        budget_ms: Some(remaining_ms.saturating_add(ROUTER_CLOSE_GRACE_MS)),
    })
    .await;
    result
}

async fn run_segment(
    spec: &ParsedSystemRouterRunSpec,
    options: &RouterSegmentOptions,
    env: Arc<dyn RouterSegmentEnvironment>,
    deadline: Instant,
) -> anyhow::Result<SystemRouterRunResult> {
    let signal = options.signal.as_ref();
    if signal.is_some_and(AbortSignal::is_aborted) {
        // Disposal can win the race before the segment starts: do not even
        // spawn the adapter for an already-aborted run.
        return Ok(segment_aborted_result(
            &options.model,
            "Router aborted before the segment started.",
        ));
    }
    // The segment timeout bounds the whole segment, adapter init included.
    let environment = match race(signal, deadline, env.init()).await {
        Race::Aborted => {
            return Ok(segment_aborted_result(
                &options.model,
                "Router aborted during adapter init.",
            ))
        }
        Race::Deadline => anyhow::bail!(
            "environment adapter init exceeded the segment timeout of {}ms",
            spec.timeout_ms
        ),
        Race::Done(Err(error)) => {
            anyhow::bail!("environment adapter init failed: {error}")
        }
        Race::Done(Ok(environment)) => environment,
    };
    // Init can win the race in the same tick the budget expires; a leftover
    // budget below 1ms must not hand the loop a 1ms deadline that still
    // dispatches reset past the declared segment timeout.
    let loop_budget_ms = deadline
        .saturating_duration_since(Instant::now())
        .as_millis() as u64;
    if loop_budget_ms == 0 {
        anyhow::bail!(
            "environment adapter init exceeded the segment timeout of {}ms",
            spec.timeout_ms
        );
    }
    let supplied = environment
        .as_ref()
        .and_then(|environment| environment.get("actions"));
    let actions = parse_environment_actions(spec.actions.as_ref(), supplied)?;
    let Some(actions) = actions else {
        anyhow::bail!(
            "system_router.run has no action space: declare one or use an adapter that supplies its own"
        );
    };
    let compiled = Arc::new(compile_action_space(&actions)?);
    let decide = options.decide.clone().unwrap_or_else(|| {
        create_model_decision_function(RouterDecisionContext {
            model: options.model.clone(),
            api_key: options.api_key.clone(),
            headers: options.headers.clone(),
            session_id: options.session_id.clone(),
            policy: options.policy.clone(),
            actions: compiled,
        })
    });
    run_system_router_loop(SystemRouterLoopOptions {
        env,
        goal: spec.goal.clone(),
        actions,
        decide,
        model: RouterModelInfo {
            provider: options.model.provider.clone(),
            id: options.model.id.clone(),
            thinking_level: router_thinking_level(&options.model)
                .wire_name()
                .to_string(),
        },
        gate: spec.gate,
        max_steps: spec.max_steps,
        // The declared figure for the summaries; the leftover is only the
        // loop's clock, so a slow init must not rewrite the reported timeout.
        timeout_ms: spec.timeout_ms,
        budget_ms: Some(loop_budget_ms),
        history_steps: spec.history_steps,
        observation_chars: spec.observation_chars,
        signal: options.signal.clone(),
    })
    .await
}

/// The `failed("aborted")` result for a segment that never recorded a step.
fn segment_aborted_result(model: &Model, summary: &str) -> SystemRouterRunResult {
    SystemRouterRunResult {
        status: RouterRunStatus::Failed,
        reason: "aborted".to_string(),
        steps: 0,
        executed: 0,
        refused: 0,
        trace: Vec::new(),
        summary: summary.to_string(),
        model: RouterModelInfo {
            provider: model.provider.clone(),
            id: model.id.clone(),
            thinking_level: router_thinking_level(model).wire_name().to_string(),
        },
        usage: RouterUsage::default(),
    }
}

// The unit battery lives in the child module (segment::tests).
#[cfg(test)]
mod tests;
