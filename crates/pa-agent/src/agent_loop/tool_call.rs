//! Single tool-call pipeline: argument preparation and schema validation,
//! the `beforeToolCall`/`afterToolCall` hooks, abort racing, streamed
//! `tool_execution_update` emission, and the resulting tool outcome.

use std::sync::Arc;

use crate::abort::{is_abort_error, AbortSignal};
use crate::types::{
    AfterToolCallContext, AgentContext, AgentEvent, AgentMessage, AgentTool, AgentToolResult,
    AgentToolUpdateCallback, AssistantMessage, BeforeToolCallContext, ToolCall,
    ToolProgressCadence, ToolResultMessage,
};

use super::abort::race_with_abort;
use super::tools::{find_tool, FinalizedToolCallOutcome, Preparation, PreparedToolCall};
use super::{AgentEventSink, AgentLoopConfig};

/// Tool lookup, `prepareArguments`, schema validation, and the
/// `beforeToolCall` hook. Never fails; errors become immediate error tool
/// results exactly like the TS catch-all.
pub(crate) async fn prepare_tool_call(
    current_context: &AgentContext,
    assistant_message: &AssistantMessage,
    tool_call: &ToolCall,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
) -> Preparation {
    let Some(tool) = find_tool(&current_context.tools, &tool_call.name) else {
        return Preparation::Immediate {
            result: AgentToolResult::error(format!("Tool {} not found", tool_call.name)),
            is_error: true,
        };
    };

    let result = prepare_tool_call_inner(
        tool,
        assistant_message,
        tool_call,
        current_context,
        config,
        signal,
    )
    .await;
    match result {
        Ok(preparation) => preparation,
        Err(error) => Preparation::Immediate {
            result: AgentToolResult::error(format!("{error:#}")),
            is_error: true,
        },
    }
}

async fn prepare_tool_call_inner(
    tool: &Arc<dyn AgentTool>,
    assistant_message: &AssistantMessage,
    tool_call: &ToolCall,
    current_context: &AgentContext,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
) -> anyhow::Result<Preparation> {
    let prepared_tool_call = match tool.prepare_arguments(&tool_call.arguments) {
        Some(prepared) => ToolCall {
            arguments: prepared,
            ..tool_call.clone()
        },
        None => tool_call.clone(),
    };
    let validated_args = crate::validation::validate_tool_arguments(
        tool_call.name.as_str(),
        tool.parameters(),
        &prepared_tool_call.arguments,
    )
    .map_err(anyhow::Error::msg)?;

    if let Some(before_tool_call) = config.before_tool_call.as_ref() {
        let before_result = race_with_abort(
            before_tool_call(
                BeforeToolCallContext {
                    resolved_tool_name: tool.name().to_string(),
                    assistant_message: assistant_message.clone(),
                    tool_call: tool_call.clone(),
                    args: validated_args.clone(),
                    context: config.tool_hook_context.snapshot(current_context),
                },
                signal.cloned().unwrap_or_default(),
            ),
            signal,
        )
        .await?;
        if before_result.as_ref().is_some_and(|r| r.block) {
            let reason = before_result
                .and_then(|r| r.reason)
                .unwrap_or_else(|| "Tool execution was blocked".to_string());
            return Ok(Preparation::Immediate {
                result: AgentToolResult::error(reason),
                is_error: true,
            });
        }
    }

    Ok(Preparation::Prepared(PreparedToolCall {
        tool_call: tool_call.clone(),
        tool: Arc::clone(tool),
        args: validated_args,
    }))
}

pub(crate) struct ExecutedToolCallOutcome {
    result: AgentToolResult,
    is_error: bool,
}

/// Race the tool against abort, stream `tool_execution_update` events
/// through a background emitter task, and return an error tool result when
/// the tool fails (or aborts, with the TS message "Tool execution aborted").
pub(crate) async fn execute_prepared_tool_call(
    prepared: &PreparedToolCall,
    progress: ToolProgressCadence,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
) -> ExecutedToolCallOutcome {
    let accepting_updates = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let (update_tx, mut update_rx) = tokio::sync::mpsc::unbounded_channel::<AgentToolResult>();
    let update_tx_for_callback = update_tx.clone();

    let tool_call_id = prepared.tool_call.id.clone();
    let tool_name = prepared.tool.name().to_string();
    let args = prepared.tool_call.arguments.clone();
    let sink = Arc::clone(emit);
    let started_at = std::time::Instant::now();
    // Lifecycle heartbeat: quiet until `progress.after_ms`, then one
    // `ToolExecutionProgress` event every `progress.every_ms` while the call
    // still runs. The guard aborts the task on EVERY exit path — return,
    // panic, and cancellation of this frame — so the unbounded tick loop
    // never leaks as a detached task.
    let mut heartbeat = HeartbeatGuard(Some(spawn_tool_heartbeat(
        Arc::clone(emit),
        tool_call_id.clone(),
        tool_name.clone(),
        started_at,
        progress,
    )));
    let signal_for_updates = signal.cloned().unwrap_or_default();
    let emit_updates = tokio::spawn(async move {
        while let Some(partial_result) = update_rx.recv().await {
            sink(AgentEvent::ToolExecutionUpdate {
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                args: args.clone(),
                partial_result,
            })
            .await?;
        }
        Ok(())
    });

    let on_update: AgentToolUpdateCallback = {
        let accepting_updates = Arc::clone(&accepting_updates);
        Arc::new(move |partial_result: AgentToolResult| {
            if !accepting_updates.load(std::sync::atomic::Ordering::SeqCst)
                || signal_for_updates.is_aborted()
            {
                return;
            }
            let _ = update_tx_for_callback.send(partial_result);
        })
    };

    let execute_result = race_with_abort(
        (Arc::clone(&prepared.tool)).execute(
            prepared.tool_call.id.clone(),
            prepared.args.clone(),
            signal.cloned().unwrap_or_default(),
            on_update,
        ),
        signal,
    )
    .await;
    heartbeat.stop();
    let elapsed_ms = elapsed_ms_since(started_at);

    accepting_updates.store(false, std::sync::atomic::Ordering::SeqCst);
    drop(update_tx);

    match execute_result {
        Ok(result) => {
            // Success path: a failing update emitter mirrors a rejecting
            // updateEvents promise in TS; an aborted drain (the call itself
            // succeeded) settles cleanly.
            if let Err(error) = settle_success_drain(emit_updates, signal).await {
                return ExecutedToolCallOutcome {
                    result: error_tool_result(signal, &error, elapsed_ms),
                    is_error: true,
                };
            }
            ExecutedToolCallOutcome {
                result,
                is_error: false,
            }
        }
        Err(error) => {
            // TS drains the pending update emissions on the error path,
            // swallowing every failure (`Promise.all(...).catch(() => undefined)`).
            let _ = race_with_abort(
                async {
                    emit_updates
                        .await
                        .map_err(anyhow::Error::from)
                        .and_then(|drained| drained)
                },
                signal,
            )
            .await;
            ExecutedToolCallOutcome {
                result: error_tool_result(signal, &error, elapsed_ms),
                is_error: true,
            }
        }
    }
}

/// Aborts the heartbeat task on every exit path. Dropping the bare
/// `JoinHandle` only detaches the unbounded tick task: on a panic or a
/// cancellation (a dropped `execute_prepared_tool_call` future) the explicit
/// `stop()` never runs, and the detached task would keep emitting
/// `ToolExecutionProgress` — and pin the event sink — forever.
struct HeartbeatGuard(Option<tokio::task::JoinHandle<()>>);

impl HeartbeatGuard {
    /// Stop the heartbeat on the normal path (ticks stop before the
    /// drain/result emission); `drop` covers panic and cancellation.
    fn stop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Drain the update emitter on the success path, racing the drain against
/// abort: an aborted drain settles cleanly, any other failure surfaces as
/// the call's error.
async fn settle_success_drain(
    emit_updates: tokio::task::JoinHandle<anyhow::Result<()>>,
    signal: Option<&AbortSignal>,
) -> anyhow::Result<()> {
    match race_with_abort(
        async {
            emit_updates
                .await
                .map_err(|error| anyhow::anyhow!("Tool update emitter task failed: {error}"))
        },
        signal,
    )
    .await
    {
        Ok(update_result) => update_result,
        Err(error) => {
            let aborted = signal.is_some_and(AbortSignal::is_aborted);
            if aborted && is_abort_error(&error) {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

/// Elapsed milliseconds since a call started (millis fit `u64`; the
/// saturating conversion only guards the type-level truncation lint).
fn elapsed_ms_since(started_at: std::time::Instant) -> u64 {
    u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// The heartbeat task behind the `ToolExecutionProgress` events: quiet until
/// `progress.after_ms`, then one event every `progress.every_ms` while the
/// call runs; aborted by the caller once the execution race settles.
fn spawn_tool_heartbeat(
    sink: AgentEventSink,
    tool_call_id: String,
    tool_name: String,
    started_at: std::time::Instant,
    progress: ToolProgressCadence,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(progress.after_ms)).await;
        loop {
            let _ = sink(AgentEvent::ToolExecutionProgress {
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                elapsed_ms: elapsed_ms_since(started_at),
            })
            .await;
            tokio::time::sleep(std::time::Duration::from_millis(progress.every_ms)).await;
        }
    })
}

fn error_tool_result(
    signal: Option<&AbortSignal>,
    error: &anyhow::Error,
    elapsed_ms: u64,
) -> AgentToolResult {
    let aborted = signal.is_some_and(AbortSignal::is_aborted);
    let mut result = if aborted {
        AgentToolResult::error("Tool execution aborted")
    } else {
        AgentToolResult::error(format!("{error:#}"))
    };
    // The aborted/killed completion carries the elapsed duration: without
    // it the trace shows an aborted call but never how long it ran.
    result.details = serde_json::json!({
        "status": if aborted { "aborted" } else { "error" },
        "durationMs": elapsed_ms,
    });
    result
}

/// Apply the `afterToolCall` overrides.
pub(crate) async fn finalize_executed_tool_call(
    current_context: &AgentContext,
    assistant_message: &AssistantMessage,
    prepared: &PreparedToolCall,
    executed: ExecutedToolCallOutcome,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
) -> anyhow::Result<FinalizedToolCallOutcome> {
    let mut result = executed.result;
    let mut is_error = executed.is_error;

    if let Some(after_tool_call) = config.after_tool_call.as_ref() {
        let after_result = race_with_abort(
            after_tool_call(
                AfterToolCallContext {
                    resolved_tool_name: prepared.tool.name().to_string(),
                    assistant_message: assistant_message.clone(),
                    tool_call: prepared.tool_call.clone(),
                    args: prepared.args.clone(),
                    result: result.clone(),
                    is_error,
                    context: config.tool_hook_context.snapshot(current_context),
                },
                signal.cloned().unwrap_or_default(),
            ),
            signal,
        )
        .await;
        match after_result {
            Ok(Some(overrides)) => {
                // Field-by-field merge, no deep merge (TS semantics).
                let mut merged = result;
                if let Some(content) = overrides.content {
                    merged.content = content;
                }
                if let Some(details) = overrides.details {
                    merged.details = details;
                }
                if let Some(terminate) = overrides.terminate {
                    merged.terminate = Some(terminate);
                }
                if let Some(error) = overrides.is_error {
                    is_error = error;
                }
                result = merged;
            }
            Ok(None) => {}
            // An abort raced the callback: the executed result (including an
            // aborted execution's status and duration) stays authoritative.
            Err(_) if signal.is_some_and(AbortSignal::is_aborted) => {}
            Err(error) => {
                result = AgentToolResult::error(format!("{error:#}"));
                is_error = true;
            }
        }
    }

    Ok(FinalizedToolCallOutcome {
        tool_call: prepared.tool_call.clone(),
        result,
        is_error,
    })
}

pub(crate) async fn emit_tool_execution_end(
    finalized: &FinalizedToolCallOutcome,
    emit: &AgentEventSink,
) -> anyhow::Result<()> {
    emit(AgentEvent::ToolExecutionEnd {
        tool_call_id: finalized.tool_call.id.clone(),
        tool_name: finalized.tool_call.name.clone(),
        result: finalized.result.clone(),
        is_error: finalized.is_error,
    })
    .await
}

pub(crate) fn create_tool_result_message(
    finalized: &FinalizedToolCallOutcome,
) -> ToolResultMessage {
    ToolResultMessage {
        tool_call_id: finalized.tool_call.id.clone(),
        tool_name: finalized.tool_call.name.clone(),
        content: finalized.result.content.clone(),
        details: if finalized.result.details.is_null() {
            None
        } else {
            Some(finalized.result.details.clone())
        },
        is_error: finalized.is_error,
        timestamp: crate::now_ms(),
    }
}

pub(crate) async fn emit_tool_result_message(
    tool_result_message: &ToolResultMessage,
    emit: &AgentEventSink,
) -> anyhow::Result<()> {
    emit(AgentEvent::MessageStart {
        message: AgentMessage::from(tool_result_message.clone()),
    })
    .await?;
    emit(AgentEvent::MessageEnd {
        message: AgentMessage::from(tool_result_message.clone()),
    })
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct NeverTool;

    impl AgentTool for NeverTool {
        fn name(&self) -> &'static str {
            "never"
        }
        fn description(&self) -> &'static str {
            "never finishes on its own"
        }
        fn parameters(&self) -> &serde_json::Value {
            static PARAMETERS: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
            PARAMETERS.get_or_init(|| serde_json::json!({ "type": "object" }))
        }
        fn execute(
            self: Arc<Self>,
            _tool_call_id: String,
            _params: serde_json::Value,
            _signal: crate::abort::AbortSignal,
            _on_update: AgentToolUpdateCallback,
        ) -> crate::BoxFut<'static, anyhow::Result<AgentToolResult>> {
            Box::pin(std::future::pending())
        }
    }

    /// Cancelling the call frame (a dropped `execute_prepared_tool_call`
    /// future) must stop the heartbeat task: a detached tick loop would
    /// keep emitting `ToolExecutionProgress` — and pin the event sink —
    /// after the run that owned it is gone.
    #[tokio::test]
    async fn cancelling_the_call_frame_stops_the_heartbeat() {
        let ticks: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));
        let sink: AgentEventSink = {
            let ticks = Arc::clone(&ticks);
            Arc::new(move |event| {
                let ticks = Arc::clone(&ticks);
                Box::pin(async move {
                    if matches!(event, AgentEvent::ToolExecutionProgress { .. }) {
                        *ticks.lock().unwrap() += 1;
                    }
                    Ok(())
                })
            })
        };
        let prepared = PreparedToolCall {
            tool_call: ToolCall {
                id: "call-1".to_string(),
                name: "never".to_string(),
                arguments: serde_json::json!({}),
                thought_signature: None,
            },
            tool: Arc::new(NeverTool),
            args: serde_json::json!({}),
        };
        let progress = ToolProgressCadence {
            after_ms: 25,
            every_ms: 25,
        };
        let execution = tokio::spawn(async move {
            execute_prepared_tool_call(&prepared, progress, None, &sink).await;
        });
        let count = || *ticks.lock().unwrap();
        // Bounded first-tick wait: a broken heartbeat fails the test
        // instead of hanging the suite.
        let first_tick = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while count() == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(
            first_tick.is_ok(),
            "the heartbeat never ticked within 2s at a 25ms cadence"
        );
        // Cancel the frame mid-await: the Drop guard (not the explicit
        // stop) must abort the heartbeat.
        execution.abort();
        // Awaiting the cancelled handle settles only once the frame (and
        // its HeartbeatGuard) has dropped, so the abort is in effect; the
        // settle window absorbs an in-flight tick before sampling.
        let _ = execution.await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let after_cancel = count();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(
            count(),
            after_cancel,
            "the heartbeat must stop when the call frame is cancelled"
        );
    }
}
