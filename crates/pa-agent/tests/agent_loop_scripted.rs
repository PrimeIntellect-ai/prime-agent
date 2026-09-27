//! Scripted-loop verifier tests for the agent crate.
//!
//! Each test replays a scripted tool-call conversation through the loop via the
//! [`ScriptedProvider`] faux provider, checking the semantics ported from
//! `packages/agent/src/agent-loop.ts`: normal turns, parallel tool calls, tool
//! errors, mid-turn provider stream failures with retry, user abort
//! mid-stream, and max-iteration stops.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use pa_agent::abort::AbortSignal;
use pa_agent::agent::{Agent, AgentOptions};
use pa_agent::agent_loop::{run_agent_loop_continue, AgentEventSink, AgentLoopConfig};
use pa_agent::scripted::ScriptedProvider;
use pa_agent::stream::AssistantMessageEvent;
use pa_agent::types::{
    AgentContext, AgentEvent, AgentMessage, AgentTool, AgentToolResult, AgentToolUpdateCallback,
    AssistantContent, AssistantMessage, Message, Model, StopReason, TextContent, ToolExecutionMode,
    ToolResultContent, ToolResultMessage, UserContent,
};

fn test_model() -> Model {
    Model {
        id: "test-model".into(),
        name: "Test Model".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: String::new(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 100_000,
        max_tokens: 4_096,
    }
}

/// Echo tool: returns its `text` argument, optionally after a delay and/or
/// failing. Records concurrent executions.
struct EchoTool {
    name: &'static str,
    delay_ms: u64,
    fail: bool,
    concurrent: AtomicUsize,
    max_concurrent: AtomicUsize,
    calls: AtomicUsize,
}

impl EchoTool {
    fn new(name: &'static str) -> Arc<Self> {
        Self::with_options(name, 0, false)
    }

    fn with_options(name: &'static str, delay_ms: u64, fail: bool) -> Arc<Self> {
        Arc::new(EchoTool {
            name,
            delay_ms,
            fail,
            concurrent: AtomicUsize::new(0),
            max_concurrent: AtomicUsize::new(0),
            calls: AtomicUsize::new(0),
        })
    }
}

impl AgentTool for EchoTool {
    fn name(&self) -> &str {
        self.name
    }

    fn description(&self) -> &'static str {
        "Echoes its text argument back."
    }

    fn parameters(&self) -> &serde_json::Value {
        static SCHEMA: OnceLock<serde_json::Value> = OnceLock::new();
        SCHEMA.get_or_init(|| {
            serde_json::json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"],
            })
        })
    }

    fn execute(
        self: Arc<Self>,
        _tool_call_id: String,
        params: serde_json::Value,
        _signal: AbortSignal,
        _on_update: AgentToolUpdateCallback,
    ) -> pa_agent::BoxFut<'static, anyhow::Result<AgentToolResult>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let running = self.concurrent.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_concurrent.fetch_max(running, Ordering::SeqCst);
            if self.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
            }
            self.concurrent.fetch_sub(1, Ordering::SeqCst);
            if self.fail {
                anyhow::bail!("boom from {}", self.name);
            }
            let text = params
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            Ok(AgentToolResult::text(format!("echo:{text}")))
        })
    }
}

/// Tool that requests run termination via `terminate: true`.
#[derive(Default)]
struct TerminatingTool;

impl AgentTool for TerminatingTool {
    fn name(&self) -> &'static str {
        "stop_tool"
    }

    fn description(&self) -> &'static str {
        "Stops the agent run."
    }

    fn parameters(&self) -> &serde_json::Value {
        static SCHEMA: OnceLock<serde_json::Value> = OnceLock::new();
        SCHEMA.get_or_init(|| serde_json::json!({ "type": "object", "properties": {} }))
    }

    fn execute(
        self: Arc<Self>,
        _tool_call_id: String,
        _params: serde_json::Value,
        _signal: AbortSignal,
        _on_update: AgentToolUpdateCallback,
    ) -> pa_agent::BoxFut<'static, anyhow::Result<AgentToolResult>> {
        Box::pin(async move {
            let mut result = AgentToolResult::text("stopping");
            result.terminate = Some(true);
            Ok(result)
        })
    }
}

fn assistant_text(message: &AgentMessage) -> &AssistantMessage {
    match message {
        AgentMessage::Standard(Message::Assistant(assistant)) => assistant,
        other => panic!("expected assistant message, got {other:?}"),
    }
}

fn tool_result(message: &AgentMessage) -> &ToolResultMessage {
    match message {
        AgentMessage::Standard(Message::ToolResult(result)) => result,
        other => panic!("expected toolResult message, got {other:?}"),
    }
}

fn single_text(content: &[ToolResultContent]) -> &str {
    match content {
        [ToolResultContent::Text(TextContent { text, .. })] => text,
        other => panic!("expected single text block, got {other:?}"),
    }
}

fn event_type(event: &AgentEvent) -> &'static str {
    match event {
        AgentEvent::AgentStart => "agent_start",
        AgentEvent::AgentEnd { .. } => "agent_end",
        AgentEvent::TurnStart => "turn_start",
        AgentEvent::TurnEnd { .. } => "turn_end",
        AgentEvent::MessageStart { .. } => "message_start",
        AgentEvent::MessageUpdate { .. } => "message_update",
        AgentEvent::MessageEnd { .. } => "message_end",
        AgentEvent::ToolExecutionStart { .. } => "tool_execution_start",
        AgentEvent::ToolExecutionUpdate { .. } => "tool_execution_update",
        AgentEvent::ToolExecutionEnd { .. } => "tool_execution_end",
    }
}

/// Build an agent wired to the scripted provider, with an event-type log.
async fn scripted_agent(
    tools: Vec<Arc<dyn AgentTool>>,
) -> (Agent, Arc<ScriptedProvider>, Arc<Mutex<Vec<&'static str>>>) {
    scripted_agent_with(tools, None).await
}

async fn scripted_agent_with(
    tools: Vec<Arc<dyn AgentTool>>,
    tool_execution: Option<ToolExecutionMode>,
) -> (Agent, Arc<ScriptedProvider>, Arc<Mutex<Vec<&'static str>>>) {
    let provider = Arc::new(ScriptedProvider::new(test_model()));
    let events: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let agent = Agent::new(AgentOptions {
        initial_state: pa_agent::agent::AgentInitialState {
            tools: Some(tools),
            ..Default::default()
        },
        stream_fn: Some(provider.stream_fn()),
        tool_execution,
        ..Default::default()
    });
    agent.set_model(test_model()).await;
    agent
        .subscribe({
            let events = Arc::clone(&events);
            move |event, _signal| {
                let events = Arc::clone(&events);
                Box::pin(async move {
                    events.lock().unwrap().push(event_type(&event));
                    Ok(())
                })
            }
        })
        .await;
    (agent, provider, events)
}

#[tokio::test]
async fn normal_turn_streams_and_completes() {
    let (agent, provider, events) = scripted_agent(vec![]).await;
    provider.push_text_turn("hello world");

    agent.prompt("hi").await.unwrap();
    agent.wait_for_idle().await;

    let state = agent.state().await;
    assert_eq!(state.messages.len(), 2);
    assert!(matches!(
        &state.messages[0],
        AgentMessage::Standard(Message::User(_))
    ));
    let assistant = assistant_text(&state.messages[1]);
    match &assistant.content[..] {
        [AssistantContent::Text(TextContent { text, .. })] => assert_eq!(text, "hello world"),
        other => panic!("expected single text block, got {other:?}"),
    }
    assert_eq!(assistant.stop_reason, StopReason::Stop);
    assert!(state.error_message.is_none());
    assert!(!state.is_streaming);

    let log: Vec<&str> = events.lock().unwrap().clone();
    assert_eq!(
        log,
        vec![
            "agent_start",
            "turn_start",
            "message_start",
            "message_end",
            "message_start",
            "message_update",
            "message_update",
            "message_update",
            "message_update",
            "message_end",
            "turn_end",
            "agent_end",
        ],
        "event order must match the TS loop for a normal turn"
    );
}

#[tokio::test]
async fn tool_call_turn_dispatches_and_feeds_result_back() {
    let echo = EchoTool::new("echo");
    let (agent, provider, _events) = scripted_agent(vec![echo.clone()]).await;
    provider.push_tool_call_turn(
        Some("calling the tool"),
        vec![("call-1", "echo", serde_json::json!({ "text": "hi" }))],
    );
    provider.push_text_turn("done");

    agent.prompt("use the tool").await.unwrap();
    agent.wait_for_idle().await;

    assert_eq!(echo.calls.load(Ordering::SeqCst), 1);

    // Second provider call must see user, assistant, toolResult in order.
    let calls = provider.calls();
    assert_eq!(calls.len(), 2);
    let second = &calls[1];
    assert_eq!(second.messages.len(), 3);
    assert!(matches!(&second.messages[0], Message::User(_)));
    assert!(matches!(&second.messages[1], Message::Assistant(_)));
    let result = match &second.messages[2] {
        Message::ToolResult(result) => result,
        other => panic!("expected toolResult, got {other:?}"),
    };
    assert_eq!(result.tool_call_id, "call-1");
    assert!(!result.is_error);
    assert_eq!(single_text(&result.content), "echo:hi");

    let state = agent.state().await;
    // user, assistant(toolUse), toolResult, assistant(final text)
    assert_eq!(state.messages.len(), 4);
    assert_eq!(
        assistant_text(&state.messages[3]).stop_reason,
        StopReason::Stop
    );
}

#[tokio::test]
async fn parallel_tool_calls_execute_concurrently_and_emit_in_order() {
    // Both calls target the same slow tool: overlap shows up as its
    // concurrent-execution high-water mark.
    let slow = EchoTool::with_options("echo", 150, false);
    let (agent, provider, _events) = scripted_agent(vec![slow.clone()]).await;
    provider.push_tool_call_turn(
        None,
        vec![
            ("call-a", "echo", serde_json::json!({ "text": "a" })),
            ("call-b", "echo", serde_json::json!({ "text": "b" })),
        ],
    );
    provider.push_text_turn("all done");

    agent.prompt("go").await.unwrap();
    agent.wait_for_idle().await;

    // Parallel mode (default toolExecution): the calls overlapped.
    assert!(
        slow.max_concurrent.load(Ordering::SeqCst) >= 2,
        "parallel tool calls must overlap"
    );

    // Tool-result messages are appended in assistant source order.
    let state = agent.state().await;
    assert_eq!(tool_result(&state.messages[2]).tool_call_id, "call-a");
    assert_eq!(tool_result(&state.messages[3]).tool_call_id, "call-b");
}

#[tokio::test]
async fn sequential_tool_calls_run_one_at_a_time() {
    let tool = EchoTool::with_options("echo_seq", 60, false);
    let (agent, provider, _events) =
        scripted_agent_with(vec![tool.clone()], Some(ToolExecutionMode::Sequential)).await;
    provider.push_tool_call_turn(
        None,
        vec![
            ("call-1", "echo_seq", serde_json::json!({ "text": "1" })),
            ("call-2", "echo_seq", serde_json::json!({ "text": "2" })),
        ],
    );
    provider.push_text_turn("done");

    agent.prompt("go").await.unwrap();
    agent.wait_for_idle().await;

    assert_eq!(
        tool.max_concurrent.load(Ordering::SeqCst),
        1,
        "sequential mode must never overlap executions"
    );
}

#[tokio::test]
async fn tool_error_produces_error_tool_result_and_loop_continues() {
    let failing = EchoTool::with_options("bad_tool", 0, true);
    let (agent, provider, _events) = scripted_agent(vec![failing.clone()]).await;
    provider.push_tool_call_turn(
        None,
        vec![("call-1", "bad_tool", serde_json::json!({ "text": "x" }))],
    );
    provider.push_text_turn("recovered");

    agent.prompt("try the tool").await.unwrap();
    agent.wait_for_idle().await;

    assert_eq!(failing.calls.load(Ordering::SeqCst), 1);
    let state = agent.state().await;
    let result = tool_result(&state.messages[2]);
    assert!(result.is_error);
    assert_eq!(single_text(&result.content), "boom from bad_tool");
    // The loop continues: the model sees the error result and answers.
    assert_eq!(state.messages.len(), 4);
    assert!(matches!(
        &state.messages[3],
        AgentMessage::Standard(Message::Assistant(_))
    ));
}

#[tokio::test]
async fn unknown_tool_name_yields_error_tool_result() {
    let echo = EchoTool::new("echo");
    let (agent, provider, _events) = scripted_agent(vec![echo.clone()]).await;
    provider.push_tool_call_turn(
        None,
        vec![("call-1", "nonexistent", serde_json::json!({ "text": "x" }))],
    );
    provider.push_text_turn("ok");

    agent.prompt("go").await.unwrap();
    agent.wait_for_idle().await;

    assert_eq!(echo.calls.load(Ordering::SeqCst), 0);
    let state = agent.state().await;
    let result = tool_result(&state.messages[2]);
    assert!(result.is_error);
    assert_eq!(single_text(&result.content), "Tool nonexistent not found");
}

#[tokio::test]
async fn provider_stream_failure_mid_turn_ends_run_and_retry_continues() {
    let (agent, provider, _events) = scripted_agent(vec![]).await;
    // The stream delivers partial text, then fails mid-turn.
    provider.push_stream_failure_turn("partial answer", "connection reset by peer");

    agent.prompt("hello").await.unwrap();
    agent.wait_for_idle().await;

    let state = agent.state().await;
    assert_eq!(state.messages.len(), 2);
    let failed = assistant_text(&state.messages[1]);
    assert_eq!(failed.stop_reason, StopReason::Error);
    assert_eq!(
        failed.error_message.as_deref(),
        Some("connection reset by peer")
    );
    assert!(
        matches!(&failed.content[..], [AssistantContent::Text(TextContent { text, .. })] if text == "partial answer")
    );
    assert_eq!(
        state.error_message.as_deref(),
        Some("connection reset by peer")
    );

    // Retry: `runAgentLoopContinue` is the documented retry path; the context
    // still ends in a user message, so the retry produces a fresh answer.
    let retry_provider = Arc::new(ScriptedProvider::new(test_model()));
    retry_provider.push_text_turn("retried answer");
    let config = AgentLoopConfig::new(test_model(), AgentLoopConfig::default_convert_to_llm());
    let context = AgentContext {
        system_prompt: String::new(),
        tools: Vec::new(),
        messages: vec![AgentMessage::user("hello")],
    };
    let retry_events: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let emit: AgentEventSink = {
        let retry_events = Arc::clone(&retry_events);
        Arc::new(move |event| {
            let retry_events = Arc::clone(&retry_events);
            Box::pin(async move {
                retry_events.lock().unwrap().push(event_type(&event));
                Ok(())
            })
        })
    };
    let stream_fn = retry_provider.stream_fn();
    let messages = run_agent_loop_continue(context, &config, emit, None, Some(&stream_fn))
        .await
        .unwrap();
    assert_eq!(messages.len(), 1);
    let retried = assistant_text(&messages[0]);
    assert_eq!(retried.stop_reason, StopReason::Stop);
    assert!(
        matches!(&retried.content[..], [AssistantContent::Text(TextContent { text, .. })] if text == "retried answer")
    );
    let log: Vec<&str> = retry_events.lock().unwrap().clone();
    assert_eq!(
        log,
        vec![
            "agent_start",
            "turn_start",
            "message_start",
            "message_update",
            "message_update",
            "message_update",
            "message_update",
            "message_end",
            "turn_end",
            "agent_end",
        ]
    );
}

#[tokio::test]
async fn user_abort_mid_stream_finalizes_aborted_assistant_message() {
    let (agent, provider, _events) = scripted_agent(vec![]).await;
    // The provider streams partial text and then stalls; only an abort ends it.
    provider.push_stalled_turn("partial before abort");

    let prompt_task = tokio::spawn({
        let agent = agent.clone();
        async move { agent.prompt("hello").await }
    });

    // Wait until the partial text has been streamed, then abort like a user.
    tokio::time::sleep(Duration::from_millis(150)).await;
    agent.abort();

    prompt_task.await.unwrap().unwrap();
    agent.wait_for_idle().await;

    let state = agent.state().await;
    assert_eq!(state.messages.len(), 2);
    let aborted = assistant_text(&state.messages[1]);
    assert_eq!(aborted.stop_reason, StopReason::Aborted);
    assert_eq!(
        aborted.error_message.as_deref(),
        Some("Request was aborted")
    );
    // The partial content streamed before the abort is preserved.
    assert!(
        matches!(&aborted.content[..], [AssistantContent::Text(TextContent { text, .. })] if text == "partial before abort")
    );
    assert!(!state.is_streaming);
    assert!(state.pending_tool_calls.is_empty());
}

#[tokio::test]
async fn abort_during_tool_execution_produces_aborted_tool_result() {
    let slow = EchoTool::with_options("slow_tool", 60_000, false);
    let (agent, provider, _events) = scripted_agent(vec![slow.clone()]).await;
    provider.push_tool_call_turn(
        None,
        vec![("call-1", "slow_tool", serde_json::json!({ "text": "x" }))],
    );

    let prompt_task = tokio::spawn({
        let agent = agent.clone();
        async move { agent.prompt("go").await }
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    agent.abort();

    prompt_task.await.unwrap().unwrap();
    agent.wait_for_idle().await;

    let state = agent.state().await;
    // user, assistant(toolUse), toolResult(aborted) — the TS abort test
    // (agent.test.ts "abort during tool execution") asserts exactly this
    // shape: aborted tool result, no further assistant turn.
    let result = tool_result(&state.messages[2]);
    assert!(result.is_error);
    assert_eq!(single_text(&result.content), "Tool execution aborted");
    assert_eq!(state.messages.len(), 3);
    assert!(state.pending_tool_calls.is_empty());
    assert!(!state.is_streaming);
}

#[tokio::test]
async fn max_iterations_stops_after_configured_turn_count() {
    let echo = EchoTool::new("echo");
    let (_agent, provider, _events) = scripted_agent(vec![echo.clone()]).await;
    // Loop of tool-call turns; the stop hook bounds the iteration count.
    for _ in 0..5 {
        provider.push_tool_call_turn(
            None,
            vec![("call", "echo", serde_json::json!({ "text": "x" }))],
        );
    }

    // Max-turn behavior is host-owned (TS parity): stop before the third turn.
    // `shouldStopBeforeTurn` is evaluated at several boundaries per turn in
    // the TS loop, so the turn count is tracked in `shouldStopAfterTurn`
    // (invoked exactly once per completed turn) and the before-turn hook
    // only reads it.
    let turn_count = Arc::new(AtomicUsize::new(0));
    let count_turns = Arc::clone(&turn_count);
    let turn_count_snapshot = Arc::clone(&turn_count);
    let bounded = Agent::new(AgentOptions {
        initial_state: pa_agent::agent::AgentInitialState {
            tools: Some(vec![echo.clone()]),
            ..Default::default()
        },
        stream_fn: Some(provider.stream_fn()),
        should_stop_after_turn: Some(Arc::new(move |_ctx| {
            let count_turns = Arc::clone(&count_turns);
            Box::pin(async move {
                count_turns.fetch_add(1, Ordering::SeqCst);
                Ok(false)
            })
        })),
        should_stop_before_turn: Some(Arc::new(move || {
            turn_count_snapshot.load(Ordering::SeqCst) >= 2
        })),
        ..Default::default()
    });
    bounded.set_model(test_model()).await;
    bounded.prompt("go").await.unwrap();
    bounded.wait_for_idle().await;

    // Exactly two assistant turns ran (max iterations reached, then stop).
    let state = bounded.state().await;
    let assistant_turns = state
        .messages
        .iter()
        .filter(|m| matches!(m, AgentMessage::Standard(Message::Assistant(_))))
        .count();
    assert_eq!(assistant_turns, 2);
    assert_eq!(echo.calls.load(Ordering::SeqCst), 2);
    assert_eq!(provider.calls().len(), 2);
}

#[tokio::test]
async fn steering_message_injects_before_next_turn() {
    // Slow enough that the mid-run steer (50ms in) lands while turn 1 is
    // still executing its tool call.
    let echo = EchoTool::with_options("echo", 120, false);
    let (agent, provider, _events) = scripted_agent(vec![echo.clone()]).await;
    provider.push_tool_call_turn(
        None,
        vec![("call-1", "echo", serde_json::json!({ "text": "a" }))],
    );
    provider.push_tool_call_turn(
        None,
        vec![("call-2", "echo", serde_json::json!({ "text": "b" }))],
    );
    provider.push_text_turn("finished");

    // `prompt` resolves when the whole run completes (TS parity), so the
    // steering message must be queued concurrently, mid-run.
    let prompt_task = tokio::spawn({
        let agent = agent.clone();
        async move { agent.prompt("start").await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    agent.steer(AgentMessage::user("steered"));
    prompt_task.await.unwrap().unwrap();
    agent.wait_for_idle().await;

    let calls = provider.calls();
    assert!(
        calls.len() >= 2,
        "steering message must start a follow-up turn"
    );
    let last = calls.last().unwrap();
    let user_texts: Vec<&str> = last
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::User(u) => match &u.content {
                UserContent::Text(t) => Some(t.as_str()),
                UserContent::Parts(_) => None,
            },
            _ => None,
        })
        .collect();
    assert!(user_texts.contains(&"steered"));
}

#[tokio::test]
async fn terminate_tool_result_stops_the_run() {
    let (agent, provider, _events) = scripted_agent(vec![Arc::new(TerminatingTool)]).await;
    provider.push_tool_call_turn(None, vec![("call-1", "stop_tool", serde_json::json!({}))]);

    agent.prompt("go").await.unwrap();
    agent.wait_for_idle().await;

    // `terminate: true` on every tool result in the batch ends the run without
    // another model call.
    assert_eq!(provider.calls().len(), 1);
    let state = agent.state().await;
    assert_eq!(state.messages.len(), 3);
    assert!(!state.is_streaming);
}

#[tokio::test]
async fn prompt_while_processing_is_rejected_with_ts_message() {
    let (agent, provider, _events) = scripted_agent(vec![]).await;
    provider.push_stalled_turn("streaming");

    let first = tokio::spawn({
        let agent = agent.clone();
        async move { agent.prompt("first").await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let error = agent.prompt("second").await.unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("Agent is already processing a prompt"),
        "unexpected error: {error:#}"
    );
    agent.abort();
    first.await.unwrap().unwrap();
}

#[test]
fn scripted_event_shapes_round_trip_through_the_event_enum() {
    // Terminal events must expose their message and deltas must not.
    let model = test_model();
    let mut partial = AssistantMessage {
        content: Vec::new(),
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_agent::types::Usage::zero(),
        stop_reason: StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
    };
    let event = AssistantMessageEvent::TextDelta {
        content_index: 0,
        delta: "hi".into(),
        partial: partial.clone(),
    };
    assert!(event.is_delta());
    assert!(event.terminal_message().is_none());
    partial.content.push(AssistantContent::Text(TextContent {
        text: "hi".into(),
        text_signature: None,
    }));
    let done = AssistantMessageEvent::Done {
        reason: StopReason::Stop,
        message: partial,
    };
    assert!(done.terminal_message().is_some());
    assert!(!done.is_delta());

    // Scripted script builders produce well-formed terminal scripts.
    let steps = pa_agent::scripted::text_turn_steps(&model, "hi");
    assert!(steps
        .iter()
        .any(|s| matches!(s, pa_agent::scripted::ScriptStep::Event(event) if event.terminal_message().is_some())));
    let failure = pa_agent::scripted::stream_failure_steps(&model, "partial", "boom");
    assert!(failure.iter().any(|s| matches!(
        s,
        pa_agent::scripted::ScriptStep::Event(event)
            if matches!(**event, AssistantMessageEvent::Error { .. })
    )));
}
