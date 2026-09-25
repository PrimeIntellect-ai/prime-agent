//! Tool-call batch execution (TS `executeToolCalls`): sequential and parallel
//! dispatch, per-tool preparation outcomes, batch termination, and tool-result
//! message emission. Section of the port of
//! `packages/agent/src/agent-loop.ts`.

use std::sync::Arc;

use crate::abort::AbortSignal;
use crate::types::{
    AgentContext, AgentEvent, AgentTool, AgentToolResult, AssistantMessage, ToolCall,
    ToolExecutionMode, ToolResultMessage,
};

use super::run::clone_context;
use super::tool_call::{
    create_tool_result_message, emit_tool_execution_end, emit_tool_result_message,
    execute_prepared_tool_call, finalize_executed_tool_call, prepare_tool_call,
};
use super::{AgentEventSink, AgentLoopConfig};

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

pub(crate) struct ExecutedToolCallBatch {
    pub(crate) messages: Vec<ToolResultMessage>,
    pub(crate) terminate: bool,
}

pub(crate) struct FinalizedToolCallOutcome {
    pub(crate) tool_call: ToolCall,
    pub(crate) result: AgentToolResult,
    pub(crate) is_error: bool,
}

/// Port of `executeToolCalls`.
pub(crate) async fn execute_tool_calls(
    current_context: &AgentContext,
    assistant_message: &AssistantMessage,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
) -> anyhow::Result<ExecutedToolCallBatch> {
    let tool_calls = assistant_message
        .tool_calls()
        .into_iter()
        .cloned()
        .collect::<Vec<ToolCall>>();
    let has_sequential_tool_call = tool_calls.iter().any(|tc| {
        current_context
            .tools
            .iter()
            .find(|t| t.name() == tc.name)
            .and_then(|tool| tool.execution_mode())
            == Some(ToolExecutionMode::Sequential)
    });
    if config.tool_execution == ToolExecutionMode::Sequential || has_sequential_tool_call {
        execute_tool_calls_sequential(
            current_context,
            assistant_message,
            &tool_calls,
            config,
            signal,
            emit,
        )
        .await
    } else {
        execute_tool_calls_parallel(
            current_context,
            assistant_message,
            &tool_calls,
            config,
            signal,
            emit,
        )
        .await
    }
}

/// Port of `executeToolCallsSequential`.
async fn execute_tool_calls_sequential(
    current_context: &AgentContext,
    assistant_message: &AssistantMessage,
    tool_calls: &[ToolCall],
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
) -> anyhow::Result<ExecutedToolCallBatch> {
    let mut finalized_calls: Vec<FinalizedToolCallOutcome> = Vec::new();
    let mut messages: Vec<ToolResultMessage> = Vec::new();

    for tool_call in tool_calls {
        if signal.is_some_and(AbortSignal::is_aborted) {
            break;
        }

        emit(AgentEvent::ToolExecutionStart {
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            args: tool_call.arguments.clone(),
        })
        .await?;

        let preparation = prepare_tool_call(
            current_context,
            assistant_message,
            tool_call,
            config,
            signal,
        )
        .await;
        let finalized = match preparation {
            Preparation::Immediate { result, is_error } => FinalizedToolCallOutcome {
                tool_call: tool_call.clone(),
                result,
                is_error,
            },
            Preparation::Prepared(prepared) => {
                let executed = execute_prepared_tool_call(&prepared, signal, emit).await;
                finalize_executed_tool_call(
                    current_context,
                    assistant_message,
                    &prepared,
                    executed,
                    config,
                    signal,
                )
                .await?
            }
        };

        emit_tool_execution_end(&finalized, emit).await?;
        let tool_result_message = create_tool_result_message(&finalized);
        emit_tool_result_message(&tool_result_message, emit).await?;
        messages.push(tool_result_message);
        finalized_calls.push(finalized);

        if signal.is_some_and(AbortSignal::is_aborted) {
            break;
        }
    }

    Ok(ExecutedToolCallBatch {
        messages,
        terminate: should_terminate_tool_batch(&finalized_calls),
    })
}

/// Port of `executeToolCallsParallel`.
///
/// `tool_execution_end` is emitted in completion order (from inside the
/// concurrent tasks), while tool-result message events are emitted afterwards
/// in assistant source order, matching the TS reference.
async fn execute_tool_calls_parallel(
    current_context: &AgentContext,
    assistant_message: &AssistantMessage,
    tool_calls: &[ToolCall],
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
) -> anyhow::Result<ExecutedToolCallBatch> {
    enum TaskOrOutcome {
        Task(tokio::task::JoinHandle<anyhow::Result<FinalizedToolCallOutcome>>),
        // Boxed: the finalized outcome holds the tool call's ordered
        // argument map (insertion-ordered for wire parity), which dwarfs
        // the join handle and would trip `large_enum_variant`.
        Outcome(Box<FinalizedToolCallOutcome>),
    }

    let mut entries: Vec<TaskOrOutcome> = Vec::new();

    for tool_call in tool_calls {
        emit(AgentEvent::ToolExecutionStart {
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            args: tool_call.arguments.clone(),
        })
        .await?;

        let preparation = prepare_tool_call(
            current_context,
            assistant_message,
            tool_call,
            config,
            signal,
        )
        .await;
        match preparation {
            Preparation::Immediate { result, is_error } => {
                let finalized = FinalizedToolCallOutcome {
                    tool_call: tool_call.clone(),
                    result,
                    is_error,
                };
                emit_tool_execution_end(&finalized, emit).await?;
                entries.push(TaskOrOutcome::Outcome(Box::new(finalized)));
            }
            Preparation::Prepared(prepared) => {
                let sink = Arc::clone(emit);
                let assistant_message = assistant_message.clone();
                let context = clone_context(current_context);
                let config = config.clone();
                let signal = signal.cloned().unwrap_or_default();
                let prepared = PreparedToolCall {
                    tool_call: prepared.tool_call.clone(),
                    tool: Arc::clone(&prepared.tool),
                    args: prepared.args.clone(),
                };
                let handle = tokio::spawn(async move {
                    let executed =
                        execute_prepared_tool_call(&prepared, Some(&signal), &sink).await;
                    let finalized = finalize_executed_tool_call(
                        &context,
                        &assistant_message,
                        &prepared,
                        executed,
                        &config,
                        Some(&signal),
                    )
                    .await?;
                    emit_tool_execution_end(&finalized, &sink).await?;
                    Ok(finalized)
                });
                entries.push(TaskOrOutcome::Task(handle));
            }
        }
    }

    // Promise.all semantics: await every entry; results stay in source order.
    let mut ordered_finalized_calls: Vec<FinalizedToolCallOutcome> = Vec::new();
    for entry in entries {
        match entry {
            TaskOrOutcome::Outcome(finalized) => ordered_finalized_calls.push(*finalized),
            TaskOrOutcome::Task(handle) => {
                let finalized = handle.await.map_err(|error| {
                    anyhow::anyhow!("Parallel tool execution task failed: {error}")
                })??;
                ordered_finalized_calls.push(finalized);
            }
        }
    }

    let mut messages: Vec<ToolResultMessage> = Vec::new();
    for finalized in &ordered_finalized_calls {
        let tool_result_message = create_tool_result_message(finalized);
        emit_tool_result_message(&tool_result_message, emit).await?;
        messages.push(tool_result_message);
    }

    Ok(ExecutedToolCallBatch {
        messages,
        terminate: should_terminate_tool_batch(&ordered_finalized_calls),
    })
}

pub(crate) enum Preparation {
    Prepared(PreparedToolCall),
    Immediate {
        result: AgentToolResult,
        is_error: bool,
    },
}

pub(crate) struct PreparedToolCall {
    pub(crate) tool_call: ToolCall,
    pub(crate) tool: Arc<dyn AgentTool>,
    pub(crate) args: serde_json::Value,
}

/// Port of `shouldTerminateToolBatch`.
fn should_terminate_tool_batch(finalized_calls: &[FinalizedToolCallOutcome]) -> bool {
    !finalized_calls.is_empty()
        && finalized_calls
            .iter()
            .all(|finalized| finalized.result.terminate == Some(true))
}
