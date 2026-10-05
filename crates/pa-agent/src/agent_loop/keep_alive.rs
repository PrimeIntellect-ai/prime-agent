//! Prompt-cache keep-alive during tool execution (a Rust-era feature; no
//! TS counterpart): while a tool batch is pending, the loop races the
//! batch against a keep-alive timer armed at the provider cache TTL minus
//! a safety margin. When the timer fires first, the loop re-sends the
//! just-issued request shape with `max_tokens = 1` — a nearly-free cache
//! READ that re-arms the prompt cache before its TTL expires — and
//! discards the response.

use std::sync::Arc;

use crate::abort::AbortSignal;
use crate::stream::{LlmContext, StreamFn, StreamRequestOptions};
use crate::types::{AgentContext, AssistantMessage, Model, StopReason, Usage};

use super::tools::{execute_tool_calls, ExecutedToolCallBatch};
use super::{AgentEventSink, AgentLoopConfig, CacheKeepAliveConfig, CacheKeepAliveFire};

/// The request shape of the just-issued assistant request, replayed by the
/// warm request with `max_tokens = 1`: the same messages, the same tools,
/// the same model and provider path, so the provider resolves the same
/// `cache_control` blocks and reads the cached prefix.
#[derive(Debug, Clone)]
pub(crate) struct CacheWarmRequest {
    pub model: Model,
    pub context: LlmContext,
    pub options: StreamRequestOptions,
}

/// The warm request replays the recorded shape with a one-token cap: the
/// response is discarded, so the request only needs to complete.
pub(crate) const WARM_MAX_TOKENS: u64 = 1;

/// The armed keep-alive inputs for one tool batch: the resolved policy,
/// the recorded request shape to replay, and the stream to replay it
/// over.
pub(crate) struct KeepAliveArms {
    pub config: CacheKeepAliveConfig,
    pub warm_request: CacheWarmRequest,
    pub stream_fn: StreamFn,
}

/// Arm the keep-alive for one tool batch, or answer `None` (the plain
/// batch path) when the fire has nothing to replay: no policy for this
/// model, no recorded request shape, or no stream.
pub(crate) fn try_arm(
    keep_alive: Option<CacheKeepAliveConfig>,
    warm_request: Option<CacheWarmRequest>,
    stream_fn: Option<&StreamFn>,
) -> Option<KeepAliveArms> {
    let config = keep_alive?;
    let warm_request = warm_request?;
    let stream_fn = stream_fn.cloned()?;
    Some(KeepAliveArms {
        config,
        warm_request,
        stream_fn,
    })
}

/// Execute the tool batch, firing warm requests while it runs
/// ([`execute_tool_calls`] raced against the keep-alive window).
///
/// The tool batch keeps priority (`biased` select): a batch that settles
/// before the window never fires, and the loop returns the batch the
/// moment it is ready. Each timer fire spawns the warm request detached —
/// it runs concurrently with the still-pending batch, reports through
/// `on_fire` when it settles, and never delays or fails the turn. The
/// window re-arms only after a fire, so at most one warm request is sent
/// per window per tool batch.
pub(crate) async fn execute_tool_calls_with_keep_alive(
    current_context: &AgentContext,
    assistant_message: &AssistantMessage,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
    arms: KeepAliveArms,
) -> anyhow::Result<ExecutedToolCallBatch> {
    let KeepAliveArms {
        config: keep_alive,
        warm_request,
        stream_fn,
    } = arms;
    let batch = execute_tool_calls(current_context, assistant_message, config, signal, emit);
    tokio::pin!(batch);
    loop {
        tokio::select! {
            biased;
            result = &mut batch => return result,
            () = tokio::time::sleep(keep_alive.rearm_after) => {
                // An aborted run stops firing: the tools observe the
                // same signal and settle the batch on their own.
                if signal.is_some_and(AbortSignal::is_aborted) {
                    return batch.await;
                }
                fire_warm_request(&keep_alive, &warm_request, &stream_fn);
            }
        }
    }
}

/// Send one warm request (detached) and report its outcome through
/// `on_fire`. The response is drained and discarded; its usage block is
/// the only thing kept. Failures are swallowed — a failed warm request
/// must never fail the turn, and the next window retries on its own.
fn fire_warm_request(
    keep_alive: &CacheKeepAliveConfig,
    warm_request: &CacheWarmRequest,
    stream_fn: &StreamFn,
) {
    let on_fire = Arc::clone(&keep_alive.on_fire);
    let mut options = warm_request.options.clone();
    options.max_tokens = Some(WARM_MAX_TOKENS);
    let model = warm_request.model.clone();
    let context = warm_request.context.clone();
    let stream_fn = Arc::clone(stream_fn);
    tokio::spawn(async move {
        let mut stream = match stream_fn(model.clone(), context, options).await {
            Ok(stream) => stream,
            Err(error) => {
                on_fire(CacheKeepAliveFire {
                    model,
                    usage: None,
                    error: Some(format!("{error:#}")),
                })
                .await;
                return;
            }
        };
        // Drain the discarded response: the terminal event carries the
        // final message, and the stream's result() settles the request
        // for the provider-side wrappers (the semantic-edge recorder
        // and the timing seam observe the warm request like any other).
        while stream.next_event().await.is_some() {}
        let message: AssistantMessage = match stream.result().await {
            Ok(message) => message,
            Err(error) => {
                stream.close();
                on_fire(CacheKeepAliveFire {
                    model,
                    usage: None,
                    error: Some(format!("{error:#}")),
                })
                .await;
                return;
            }
        };
        let error =
            (matches!(message.stop_reason, StopReason::Error | StopReason::Aborted)).then(|| {
                message
                    .error_message
                    .clone()
                    .unwrap_or_else(|| format!("warm request stopped: {:?}", message.stop_reason))
            });
        let usage = if error.is_none() {
            nonzero_usage(&message.usage)
        } else {
            None
        };
        on_fire(CacheKeepAliveFire {
            model,
            usage,
            error,
        })
        .await;
    });
}

/// The settled warm response\'s usage, or `None` when the provider
/// reported nothing (a failed or aborted stream reports zero usage —
/// the accounting row would only add noise).
fn nonzero_usage(usage: &Usage) -> Option<Usage> {
    let empty = usage.input == 0
        && usage.output == 0
        && usage.cache_read == 0
        && usage.cache_write == 0
        && usage.total_tokens == 0;
    (!empty).then(|| usage.clone())
}
