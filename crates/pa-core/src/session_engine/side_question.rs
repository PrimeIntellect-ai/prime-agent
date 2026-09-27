//! Side questions: a temporary side thread cloned from the main conversation
//! that answers a question without interrupting the main work.
//!
//! Each run clones the live main conversation into a fresh loop with the same
//! system prompt, model, thinking level, and tool declarations, so the
//! provider-side KV-cacheable prefix is preserved for the side call; earlier
//! side turns are replayed after the cloned conversation so follow-ups see the
//! newest main-thread context. Tool execution is blocked (`before_tool_call`)
//! and a turn cap backstops a model that keeps calling deactivated tools.
//!
//! Side-question results never enter the session history; the caller streams
//! them to its own sink and owns delivery.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use pa_agent::abort::{race_with_abort, AbortSignal};
use pa_agent::agent::{Agent, AgentInitialState, AgentOptions};
use pa_agent::agent_loop::{BeforeToolCallFn, ShouldStopAfterTurnFn};
use pa_agent::types::{
    AssistantContent, AssistantMessage, Message, StopReason, TextContent, UserContent, UserMessage,
    UserPart,
};

use super::provider_retry::{
    is_agent_lifecycle_failure, is_faux_provider_queue_exhausted,
    is_permanent_provider_failure_kind, provider_retry_delay, provider_stream_failure_kind,
    provider_stream_failure_retry_after_ms, provider_stream_failure_status, ProviderRetryDelay,
    ProviderRetryPolicy,
};

/// Sink receiving partial side-question answers while the run streams.
/// Returning `false` requests the run to abort.
pub type SideQuestionSink = Arc<dyn Fn(&str) -> bool + Send + Sync>;

const SIDE_QUESTION_INSTRUCTION: &str = "The user asked this via `/btw` — a temporary side thread cloned from the main conversation to answer a question without interrupting the main work. Tools (including `ipython`) are deactivated in this side thread and return an error if called; answer using only the conversation context above. The user may send follow-up side questions. Nothing here is added to the main session, so don't start or plan main-session work from this thread.";

const SIDE_QUESTION_TOOL_BLOCKED: &str =
    "Tools are deactivated in this side thread. Answer from the conversation context.";

/// Backstop for a model that keeps calling deactivated tools instead of answering.
const SIDE_QUESTION_MAX_TURNS: u32 = 3;

/// Prompt sent to the side loop: the question wrapped in a side-question tag,
/// with the side-thread instruction prepended on the first turn.
pub fn side_question_prompt(question: &str, is_first_turn: bool) -> String {
    let body = if is_first_turn {
        format!("{SIDE_QUESTION_INSTRUCTION}\n\n{question}")
    } else {
        question.to_string()
    };
    format!("<side_question>\n{body}\n</side_question>")
}

/// One completed side-question exchange, replayed into a follow-up run.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SideQuestionTurn {
    pub question: String,
    pub answer: String,
}

/// How a side-question run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SideQuestionStatus {
    /// The run finished with a final answer.
    Complete,
    /// The caller aborted the run.
    Cancelled,
    /// The provider or engine failed.
    Error,
}

/// Result of one side-question run: the accumulated answer plus its outcome.
#[derive(Debug, Clone, PartialEq)]
pub struct SideQuestionResult {
    pub status: SideQuestionStatus,
    pub answer: String,
    pub error_message: Option<String>,
}

impl SideQuestionResult {
    fn cancelled(answer: String) -> Self {
        SideQuestionResult {
            status: SideQuestionStatus::Cancelled,
            answer,
            error_message: None,
        }
    }

    fn failed(answer: String, error_message: String) -> Self {
        SideQuestionResult {
            status: SideQuestionStatus::Error,
            answer,
            error_message: Some(error_message),
        }
    }
}

/// Text of an assistant message (text blocks joined).
fn assistant_text(message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            AssistantContent::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect()
}

/// Run one side question against a clone of the parent conversation.
///
/// The run streams partial answers to `sink` (returning `false` aborts the
/// run), honors `signal` for external aborts, and retries provider failures
/// per `retry_policy`. It never mutates the parent agent or its history.
pub async fn run_side_question(
    parent: &Arc<Agent>,
    question: &str,
    previous_turns: &[SideQuestionTurn],
    retry_policy: &ProviderRetryPolicy,
    signal: &AbortSignal,
    sink: &SideQuestionSink,
) -> SideQuestionResult {
    let parent_state = parent.state().await;
    if parent_state.model == pa_agent::types::Model::unknown() {
        return SideQuestionResult::failed(
            String::new(),
            "Select a model before asking a side question".to_string(),
        );
    }
    let Some(stream_fn) = parent.stream_fn().cloned() else {
        return SideQuestionResult::failed(
            String::new(),
            "Select a model before asking a side question".to_string(),
        );
    };

    // Each turn re-clones the live main conversation, so follow-ups always see
    // the newest main-thread context; earlier side turns replay after it.
    let mut messages = parent_state.messages.clone();
    for (index, turn) in previous_turns.iter().enumerate() {
        messages.push(pa_agent::types::AgentMessage::Standard(Message::User(
            UserMessage {
                content: UserContent::Parts(vec![UserPart::Text(TextContent {
                    text: side_question_prompt(&turn.question, index == 0),
                    text_signature: None,
                })]),
                timestamp: pa_agent::now_ms(),
            },
        )));
        messages.push(pa_agent::types::AgentMessage::Standard(Message::Assistant(
            AssistantMessage {
                content: vec![AssistantContent::Text(TextContent {
                    text: turn.answer.clone(),
                    text_signature: None,
                })],
                api: parent_state.model.api.clone(),
                provider: parent_state.model.provider.clone(),
                model: parent_state.model.id.clone(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_agent::types::Usage::zero(),
                stop_reason: StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: pa_agent::now_ms(),
            },
        )));
    }
    // A turn-capped run can end on tool results, so its outcome lives in the
    // assistant turns it appended rather than in its last message.
    let cloned_message_count = messages.len();

    let turn_count = Arc::new(AtomicU32::new(0));
    let should_stop_after_turn: ShouldStopAfterTurnFn = {
        let turn_count = Arc::clone(&turn_count);
        Arc::new(move |context| {
            let turn_count = Arc::clone(&turn_count);
            Box::pin(async move {
                let count = turn_count.fetch_add(1, Ordering::SeqCst) + 1;
                let no_tool_call = !context
                    .message
                    .content
                    .iter()
                    .any(|block| matches!(block, AssistantContent::ToolCall(_)));
                Ok(count >= SIDE_QUESTION_MAX_TURNS || no_tool_call)
            })
        })
    };
    let before_tool_call: BeforeToolCallFn = Arc::new(|_context, _signal| {
        Box::pin(async move {
            Ok(Some(pa_agent::types::BeforeToolCallResult {
                block: true,
                reason: Some(SIDE_QUESTION_TOOL_BLOCKED.to_string()),
            }))
        })
    });
    let side_agent = Arc::new(Agent::new(AgentOptions {
        initial_state: AgentInitialState {
            system_prompt: Some(parent_state.system_prompt.clone()),
            model: Some(parent_state.model.clone()),
            thinking_level: Some(parent_state.thinking_level),
            tools: Some(parent_state.tools.clone()),
            messages: Some(messages),
        },
        stream_fn: Some(stream_fn),
        before_tool_call: Some(before_tool_call),
        should_stop_after_turn: Some(should_stop_after_turn),
        ..Default::default()
    }));

    // Streaming events carry one partial turn at a time, so they only fill in
    // text as it arrives; the answer of the whole run is derived at the end.
    let (update_tx, update_rx) = std::sync::mpsc::channel::<String>();
    let update_tx = Arc::new(update_tx);
    let subscription = side_agent
        .subscribe(move |event, _signal| {
            let update_tx = Arc::clone(&update_tx);
            Box::pin(async move {
                match &event {
                    pa_agent::types::AgentEvent::MessageUpdate { message, .. }
                    | pa_agent::types::AgentEvent::MessageEnd { message } => {
                        if let pa_agent::types::AgentMessage::Standard(Message::Assistant(
                            assistant,
                        )) = message
                        {
                            let text = assistant_text(assistant);
                            if !text.is_empty() {
                                let _ = update_tx.send(text);
                            }
                        }
                    }
                    _ => {}
                }
                Ok(())
            })
        })
        .await;

    let result = run_attempts(
        &side_agent,
        question,
        previous_turns,
        cloned_message_count,
        retry_policy,
        signal,
        sink,
        &update_rx,
    )
    .await;
    let () = subscription.unsubscribe().await;
    result
}

/// The retrying completion cycle: prompt (first attempt), then drop the
/// failed assistant turn and continue, with the shared provider retry policy
/// (standalone side runs bypass the session auto-retry loop, so retry here).
#[allow(clippy::too_many_arguments)]
async fn run_attempts(
    side_agent: &Arc<Agent>,
    question: &str,
    previous_turns: &[SideQuestionTurn],
    cloned_message_count: usize,
    retry_policy: &ProviderRetryPolicy,
    signal: &AbortSignal,
    sink: &SideQuestionSink,
    update_rx: &std::sync::mpsc::Receiver<String>,
) -> SideQuestionResult {
    let mut answer = String::new();
    if signal.is_aborted() {
        return SideQuestionResult::cancelled(answer);
    }
    let max_retries = if retry_policy.enabled {
        retry_policy.max_retries
    } else {
        0
    };
    let mut retries_performed = 0u32;
    let mut prompted = false;
    let final_message: anyhow::Result<Option<AssistantMessage>> = loop {
        let prompt = side_question_prompt(question, previous_turns.is_empty());
        let outcome = run_attempt(
            side_agent,
            prompt,
            prompted,
            cloned_message_count,
            signal,
            sink,
            update_rx,
            &mut answer,
        )
        .await;
        prompted = true;
        let message = match outcome {
            AttemptOutcome::Aborted => break Ok(None),
            AttemptOutcome::Finished(turn) => match *turn {
                None => {
                    let error = side_agent.state().await.error_message.unwrap_or_else(|| {
                        "Side question produced no assistant message".to_string()
                    });
                    break Err(anyhow::anyhow!(error));
                }
                Some(message) => message,
            },
        };
        if message.stop_reason != StopReason::Error {
            break Ok(Some(message));
        }
        if retries_performed >= max_retries
            || is_agent_lifecycle_failure(&message)
            || is_faux_provider_queue_exhausted(&message)
        {
            break Ok(Some(message));
        }
        let kind = provider_stream_failure_kind(&message);
        let status = provider_stream_failure_status(&message);
        if is_permanent_provider_failure_kind(kind.as_deref(), retries_performed, status) {
            break Ok(Some(message));
        }
        let delay = provider_retry_delay(
            retries_performed + 1,
            provider_stream_failure_retry_after_ms(&message),
            retry_policy,
        );
        let ProviderRetryDelay::Wait { delay_ms } = delay else {
            break Ok(Some(message));
        };
        // A cancel that raced the failure is an abort, not a provider failure.
        if race_with_abort(
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)),
            signal,
        )
        .await
        .is_err()
        {
            break Ok(None);
        }
        retries_performed += 1;
    };

    let message = match final_message {
        Ok(Some(message)) => message,
        Ok(None) => return SideQuestionResult::cancelled(answer),
        Err(error) => return SideQuestionResult::failed(answer, error.to_string()),
    };
    if message.stop_reason == StopReason::Error {
        let error = message
            .error_message
            .clone()
            .unwrap_or_else(|| "Side question produced no assistant message".to_string());
        return SideQuestionResult::failed(answer, error);
    }
    // A run that ends on a tool turn was answered in an earlier turn; a
    // textless final turn without tool calls is a genuinely empty answer.
    let final_answer = if message
        .content
        .iter()
        .any(|block| matches!(block, AssistantContent::ToolCall(_)))
    {
        assistant_turns_after(side_agent, cloned_message_count)
            .await
            .iter()
            .rev()
            .map(assistant_text)
            .find(|text| !text.is_empty())
            .unwrap_or_default()
    } else {
        assistant_text(&message)
    };
    SideQuestionResult {
        status: SideQuestionStatus::Complete,
        answer: final_answer,
        error_message: None,
    }
}

enum AttemptOutcome {
    Finished(Box<Option<AssistantMessage>>),
    Aborted,
}

/// One attempt: prompt (or recover by dropping the failed assistant turn and
/// continuing), stream partial answers into `sink` while the run settles,
/// and stop early on an external abort or a cancelled sink.
#[allow(clippy::too_many_arguments)]
async fn run_attempt(
    side_agent: &Arc<Agent>,
    prompt: String,
    prompted: bool,
    cloned_message_count: usize,
    signal: &AbortSignal,
    sink: &SideQuestionSink,
    update_rx: &std::sync::mpsc::Receiver<String>,
    answer: &mut String,
) -> AttemptOutcome {
    let attempt: tokio::task::JoinHandle<anyhow::Result<Option<AssistantMessage>>> = {
        let side_agent = Arc::clone(side_agent);
        tokio::spawn(async move {
            let admitted: anyhow::Result<()> = if prompted {
                // Session-loop recovery: drop the failed assistant turn and re-run.
                let state = side_agent.state().await;
                let mut messages = state.messages;
                messages.pop();
                side_agent.set_messages(messages).await;
                side_agent.continue_run().await
            } else {
                side_agent
                    .prompt(pa_agent::agent::AgentPromptInput::text(prompt))
                    .await
            };
            admitted?;
            side_agent.wait_for_idle().await;
            Ok(assistant_turns_after(&side_agent, cloned_message_count)
                .await
                .pop())
        })
    };
    let mut aborted = false;
    loop {
        while let Ok(text) = update_rx.try_recv() {
            if !text.is_empty() && text != *answer {
                answer.clone_from(&text);
                if !sink(answer) {
                    aborted = true;
                    side_agent.abort();
                }
            }
        }
        if signal.is_aborted() && !aborted {
            aborted = true;
            side_agent.abort();
        }
        if attempt.is_finished() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let result = attempt.await;
    if aborted {
        return AttemptOutcome::Aborted;
    }
    match result {
        Ok(Ok(message)) => AttemptOutcome::Finished(Box::new(message)),
        // The attempt task only errors when the prompt was rejected; the
        // outcome then lives in the agent's error state.
        Ok(Err(_)) | Err(_) => AttemptOutcome::Finished(Box::new(None)),
    }
}

/// The assistant messages the side run appended after the cloned prefix.
async fn assistant_turns_after(
    side_agent: &Arc<Agent>,
    cloned_message_count: usize,
) -> Vec<AssistantMessage> {
    let state = side_agent.state().await;
    state
        .messages
        .get(cloned_message_count..)
        .into_iter()
        .flatten()
        .filter_map(|message| match message {
            pa_agent::types::AgentMessage::Standard(Message::Assistant(assistant)) => {
                Some(assistant.clone())
            }
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::provider_retry::UNBOUNDED_BACKOFF_MS;
    use super::*;
    use crate::session_engine::tool_bridge::bridge_tool;
    use crate::tools::tool_definition::{ToolDefinition, ToolExecutionResult};
    use pa_agent::abort::AbortController;
    use pa_agent::scripted::ScriptedProvider;
    use pa_agent::types::AgentTool;
    use std::sync::atomic::AtomicBool;

    fn test_model() -> pa_agent::types::Model {
        serde_json::from_value(serde_json::json!({
            "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
            "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100
        }))
        .unwrap()
    }

    fn fast_retry_policy() -> ProviderRetryPolicy {
        ProviderRetryPolicy {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 1,
            max_retry_delay_ms: 1000,
            max_delay_ms: UNBOUNDED_BACKOFF_MS,
        }
    }

    /// A parent agent with one completed main-thread exchange.
    fn parent_agent(provider: &Arc<ScriptedProvider>) -> Arc<Agent> {
        parent_agent_with_tools(provider, Vec::new())
    }

    fn parent_agent_with_tools(
        provider: &Arc<ScriptedProvider>,
        tools: Vec<Arc<dyn AgentTool>>,
    ) -> Arc<Agent> {
        Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                system_prompt: Some("main system prompt".to_string()),
                model: Some(test_model()),
                thinking_level: None,
                tools: Some(tools),
                messages: Some(vec![
                    pa_agent::types::AgentMessage::user("main thread context"),
                    pa_agent::types::AgentMessage::Standard(Message::Assistant(AssistantMessage {
                        content: vec![AssistantContent::Text(TextContent {
                            text: "main thread reply".to_string(),
                            text_signature: None,
                        })],
                        api: "openai-completions".to_string(),
                        provider: "test".to_string(),
                        model: "m".to_string(),
                        response_model: None,
                        response_id: None,
                        diagnostics: None,
                        usage: pa_agent::types::Usage::zero(),
                        stop_reason: StopReason::Stop,
                        stop_reason_raw: None,
                        error_message: None,
                        timestamp: 0,
                    })),
                ]),
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        }))
    }

    fn flag_tool(executed: Arc<AtomicBool>) -> ToolDefinition {
        ToolDefinition {
            name: "echo".to_string(),
            label: "Echo".to_string(),
            description: "Echoes its input".to_string(),
            prompt_snippet: String::new(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": []
            }),
            execution_mode: None,
            prepare_arguments: None,
            execute: Arc::new(move |_id, _params, _signal, _on_update| {
                let executed = Arc::clone(&executed);
                Box::pin(async move {
                    executed.store(true, Ordering::SeqCst);
                    Ok(ToolExecutionResult::text("tool ran"))
                })
            }),
        }
    }

    async fn run(
        parent: &Arc<Agent>,
        question: &str,
        previous_turns: &[SideQuestionTurn],
        signal: &AbortSignal,
        sink: &SideQuestionSink,
    ) -> SideQuestionResult {
        run_side_question(
            parent,
            question,
            previous_turns,
            &fast_retry_policy(),
            signal,
            sink,
        )
        .await
    }

    fn context_text(provider: &ScriptedProvider) -> String {
        serde_json::to_string(provider.calls().first().expect("one call")).unwrap()
    }

    #[tokio::test]
    async fn answers_from_the_cloned_conversation() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_text_turn("the side answer");
        let parent = parent_agent(&provider);
        let sink: SideQuestionSink = Arc::new(|_| true);
        let result = run(
            &parent,
            "what is the answer?",
            &[],
            &AbortSignal::never(),
            &sink,
        )
        .await;
        assert_eq!(result.status, SideQuestionStatus::Complete);
        assert_eq!(result.answer, "the side answer");
        assert_eq!(result.error_message, None);

        // The side loop saw the cloned main conversation plus the wrapped
        // question (instruction on the first turn).
        let context = context_text(&provider);
        assert!(context.contains("main thread context"));
        assert!(context.contains("main thread reply"));
        assert!(context.contains("<side_question>"));
        assert!(context.contains("deactivated in this side thread"));
        assert!(context.contains("what is the answer?"));

        // Side results never touch the parent history.
        assert_eq!(parent.state().await.messages.len(), 2);
    }

    #[tokio::test]
    async fn previous_turns_replay_after_the_clone() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_text_turn("follow-up answer");
        let parent = parent_agent(&provider);
        let previous = vec![SideQuestionTurn {
            question: "first question".to_string(),
            answer: "first answer".to_string(),
        }];
        let sink: SideQuestionSink = Arc::new(|_| true);
        let result = run(
            &parent,
            "follow-up question",
            &previous,
            &AbortSignal::never(),
            &sink,
        )
        .await;
        assert_eq!(result.status, SideQuestionStatus::Complete);
        assert_eq!(result.answer, "follow-up answer");

        // The replayed turn carries the instruction; the new question does not
        // (it is not the first turn anymore).
        let context = context_text(&provider);
        assert!(context.contains("first question"));
        assert!(context.contains("first answer"));
        assert!(context.contains("follow-up question"));
        assert_eq!(
            context.matches("deactivated in this side thread").count(),
            1
        );
    }

    #[tokio::test]
    async fn provider_failures_are_retried() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_stream_failure_turn("partial stream", "provider stream broke");
        provider.push_text_turn("recovered answer");
        let parent = parent_agent(&provider);
        let sink: SideQuestionSink = Arc::new(|_| true);
        let result = run(&parent, "retry me", &[], &AbortSignal::never(), &sink).await;
        assert_eq!(result.status, SideQuestionStatus::Complete);
        assert_eq!(result.answer, "recovered answer");
        assert_eq!(provider.calls().len(), 2);
    }

    #[tokio::test]
    async fn exhausted_retries_fail_the_run() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_stream_failure_turn("", "provider stream broke");
        provider.push_stream_failure_turn("", "provider stream broke again");
        let parent = parent_agent(&provider);
        let sink: SideQuestionSink = Arc::new(|_| true);
        let result = run(&parent, "fail me", &[], &AbortSignal::never(), &sink).await;
        // Two stream failures retry (transient); the third attempt exhausts
        // the scripted provider, which the loop records as an agent lifecycle
        // failure (never retried) and the run fails with.
        assert_eq!(result.status, SideQuestionStatus::Error);
        assert_eq!(provider.calls().len(), 3);
        assert!(result
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("ScriptedProvider exhausted")));
    }

    #[tokio::test]
    async fn abort_mid_run_cancels_with_partial_answer() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_stalled_turn("partial answer");
        let parent = parent_agent(&provider);
        let controller = AbortController::new();
        let aborter = {
            let controller = controller.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                controller.abort();
            })
        };
        let sink: SideQuestionSink = Arc::new(|_| true);
        let result = run(&parent, "long question", &[], &controller.signal(), &sink).await;
        aborter.await.unwrap();
        assert_eq!(result.status, SideQuestionStatus::Cancelled);
        assert_eq!(result.answer, "partial answer");
        assert_eq!(result.error_message, None);
    }

    #[tokio::test]
    async fn cancelled_sink_aborts_the_run() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_stalled_turn("streaming text");
        let parent = parent_agent(&provider);
        let controller = AbortController::new();
        let signal = controller.signal();
        // The first partial answer cancels the run.
        let sink: SideQuestionSink = Arc::new(str::is_empty);
        let result = run(&parent, "cancel me", &[], &signal, &sink).await;
        assert_eq!(result.status, SideQuestionStatus::Cancelled);
        assert_eq!(result.answer, "streaming text");
    }

    #[tokio::test]
    async fn tool_calls_are_blocked_and_turn_capped() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_tool_call_turn(None, vec![("call-1", "echo", serde_json::json!({}))]);
        provider.push_tool_call_turn(None, vec![("call-2", "echo", serde_json::json!({}))]);
        provider.push_tool_call_turn(None, vec![("call-3", "echo", serde_json::json!({}))]);
        let executed = Arc::new(AtomicBool::new(false));
        let tool = bridge_tool(flag_tool(Arc::clone(&executed)));
        let parent = parent_agent_with_tools(&provider, vec![tool]);
        let sink: SideQuestionSink = Arc::new(|_| true);
        let result = run(
            &parent,
            "keep calling tools",
            &[],
            &AbortSignal::never(),
            &sink,
        )
        .await;
        // The backstop stops the run at the turn cap; no tool ever executed.
        assert_eq!(provider.calls().len(), 3);
        assert!(!executed.load(Ordering::SeqCst));
        assert_eq!(result.status, SideQuestionStatus::Complete);
        assert_eq!(result.answer, "");
    }

    #[tokio::test]
    async fn missing_model_fails_the_run() {
        let provider = Arc::new(ScriptedProvider::new(test_model()));
        provider.push_text_turn("never reached");
        let parent = Arc::new(Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                system_prompt: Some("prompt".to_string()),
                model: None,
                thinking_level: None,
                tools: None,
                messages: None,
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        }));
        let sink: SideQuestionSink = Arc::new(|_| true);
        let result = run(&parent, "question", &[], &AbortSignal::never(), &sink).await;
        assert_eq!(result.status, SideQuestionStatus::Error);
        assert_eq!(
            result.error_message.as_deref(),
            Some("Select a model before asking a side question")
        );
    }
}
