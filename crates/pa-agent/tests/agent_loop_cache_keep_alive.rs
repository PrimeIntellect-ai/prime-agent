//! Prompt-cache keep-alive loop tests: the window decision (fires only
//! when a tool batch outlasts the cache window, once per window, stopping
//! at turn end), the replayed request shape (`max_tokens = 1`, identical
//! messages, discarded response), and the opt-out resolution.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_agent::abort::AbortSignal;
use pa_agent::agent::{Agent, AgentOptions, CacheKeepAliveResolver};
use pa_agent::agent_loop::{CacheKeepAliveConfig, CacheKeepAliveFire, CacheKeepAliveFireFn};
use pa_agent::scripted::ScriptedProvider;
use pa_agent::stream::{LlmContext, StreamFn};
use pa_agent::types::{
    AgentMessage, AgentTool, AgentToolResult, AgentToolUpdateCallback, Model, StopReason,
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

/// Tool that sleeps `delay_ms` before answering.
struct SlowTool {
    delay_ms: u64,
}

impl AgentTool for SlowTool {
    fn name(&self) -> &'static str {
        "slow"
    }

    fn description(&self) -> &'static str {
        "Sleeps, then answers."
    }

    fn parameters(&self) -> &serde_json::Value {
        static SCHEMA: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
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
            tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
            Ok(AgentToolResult::text("done"))
        })
    }
}

/// One recorded stream call: the request shape the keep-alive replays.
#[derive(Debug, Clone)]
struct RecordedCall {
    model: Model,
    context: LlmContext,
    max_tokens: Option<u64>,
}

struct RecordingProvider {
    scripted: Arc<ScriptedProvider>,
    calls: Arc<Mutex<Vec<RecordedCall>>>,
}

impl RecordingProvider {
    fn new(model: Model) -> Self {
        RecordingProvider {
            scripted: Arc::new(ScriptedProvider::new(model)),
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn stream_fn(self: &Arc<Self>) -> StreamFn {
        let provider = Arc::clone(self);
        Arc::new(move |model, context, options| {
            let provider = Arc::clone(&provider);
            Box::pin(async move {
                provider.calls.lock().unwrap().push(RecordedCall {
                    model: model.clone(),
                    context: context.clone(),
                    max_tokens: options.max_tokens,
                });
                (Arc::clone(&provider.scripted).stream_fn())(model, context, options).await
            })
        })
    }
}

/// One observed warm fire.
#[derive(Debug, Clone)]
struct ObservedFire {
    usage: Option<pa_agent::types::Usage>,
    error: Option<String>,
}

fn on_fire_collector() -> (CacheKeepAliveFireFn, Arc<Mutex<Vec<ObservedFire>>>) {
    let fires: Arc<Mutex<Vec<ObservedFire>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&fires);
    let on_fire: CacheKeepAliveFireFn = Arc::new(move |fire: CacheKeepAliveFire| {
        let sink = Arc::clone(&sink);
        Box::pin(async move {
            sink.lock().unwrap().push(ObservedFire {
                usage: fire.usage,
                error: fire.error,
            });
        })
    });
    (on_fire, fires)
}

fn keep_alive_policy(
    rearm_after: Duration,
    on_fire: CacheKeepAliveFireFn,
) -> CacheKeepAliveResolver {
    Arc::new(move |_model| {
        Some(CacheKeepAliveConfig {
            rearm_after,
            on_fire: Arc::clone(&on_fire),
        })
    })
}

/// Build an agent over the recording provider, with a keep-alive policy
/// resolving for every model.
async fn keep_alive_agent(
    tool: Arc<dyn AgentTool>,
    rearm_after: Duration,
) -> (Agent, Arc<RecordingProvider>, Arc<Mutex<Vec<ObservedFire>>>) {
    let provider = Arc::new(RecordingProvider::new(test_model()));
    let (on_fire, fires) = on_fire_collector();
    let agent = Agent::new(AgentOptions {
        initial_state: pa_agent::agent::AgentInitialState {
            tools: Some(vec![tool]),
            ..Default::default()
        },
        stream_fn: Some(provider.stream_fn()),
        cache_keep_alive: Some(keep_alive_policy(rearm_after, on_fire)),
        ..Default::default()
    });
    agent.set_model(test_model()).await;
    (agent, provider, fires)
}

/// Yield until the detached warm-request tasks settle (the paused clock
/// advances instantly, so this never waits real time).
async fn let_fires_settle<T>(journal: &Arc<Mutex<Vec<T>>>, expected: usize) {
    for _ in 0..200 {
        if journal.lock().unwrap().len() >= expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

/// A tool batch outlasting the window fires ONE warm request per window
/// (the window re-arms after each fire), and firing stops at turn end.
#[tokio::test(start_paused = true)]
async fn fires_once_per_window_and_stops_at_turn_end() {
    // Window 100ms, tool 250ms: fires at t=100 and t=200, batch done at
    // t=250. The next request (the post-tool-result turn) never fires.
    let (agent, provider, fires) = keep_alive_agent(
        Arc::new(SlowTool { delay_ms: 250 }),
        Duration::from_millis(100),
    )
    .await;
    provider
        .scripted
        .push_tool_call_turn(None, vec![("call-1", "slow", serde_json::json!({}))]);
    provider.scripted.push_text_turn("warm-1");
    provider.scripted.push_text_turn("warm-2");
    provider.scripted.push_text_turn("final");

    agent.prompt("run the slow tool").await.unwrap();
    agent.wait_for_idle().await;
    let_fires_settle(&fires, 2).await;

    {
        let fires = fires.lock().unwrap();
        assert_eq!(
            fires.len(),
            2,
            "two windows elapsed, so exactly two warm requests: {fires:?}"
        );
        assert!(
            fires.iter().all(|fire| fire.error.is_none()),
            "the scripted warm replies settle: {fires:?}"
        );
    }
    // Turn end stops the firing: only the two scripted warm replies were
    // consumed (a third fire would exhaust the script and error).
    let state = agent.state().await;
    let texts: Vec<&str> = state
        .messages
        .iter()
        .filter_map(|message| match message {
            AgentMessage::Standard(pa_agent::types::Message::Assistant(assistant)) => {
                assistant.content.iter().find_map(|block| match block {
                    pa_agent::types::AssistantContent::Text(text) => Some(text.text.as_str()),
                    _ => None,
                })
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        texts,
        vec!["final"],
        "warm replies are discarded: {texts:?}"
    );
}

/// A tool batch that settles inside the window never fires.
#[tokio::test(start_paused = true)]
async fn does_not_fire_on_short_waits() {
    let (agent, provider, fires) = keep_alive_agent(
        Arc::new(SlowTool { delay_ms: 40 }),
        Duration::from_millis(100),
    )
    .await;
    provider
        .scripted
        .push_tool_call_turn(None, vec![("call-1", "slow", serde_json::json!({}))]);
    provider.scripted.push_text_turn("final");

    agent.prompt("run the quick tool").await.unwrap();
    agent.wait_for_idle().await;
    let_fires_settle(&fires, 1).await;

    assert!(
        fires.lock().unwrap().is_empty(),
        "a short tool wait fires nothing"
    );
    {
        let calls = provider.calls.lock().unwrap();
        assert_eq!(
            calls.len(),
            2,
            "only the tool-call request and the continuation: {calls:?}"
        );
    }
}

/// The warm request replays the recorded request shape with
/// `max_tokens = 1` and identical messages, and its response is
/// discarded (only the final turn's text stays in the conversation).
#[tokio::test(start_paused = true)]
async fn warm_request_replays_the_request_shape_with_one_token_cap() {
    let (agent, provider, _fires) = keep_alive_agent(
        Arc::new(SlowTool { delay_ms: 150 }),
        Duration::from_millis(100),
    )
    .await;
    provider
        .scripted
        .push_tool_call_turn(None, vec![("call-1", "slow", serde_json::json!({}))]);
    provider.scripted.push_text_turn("warm");
    provider.scripted.push_text_turn("final");

    agent.prompt("run the tool").await.unwrap();
    agent.wait_for_idle().await;
    let_fires_settle(&provider.calls, 3).await;

    {
        let calls = provider.calls.lock().unwrap();
        assert_eq!(
            calls.len(),
            3,
            "tool-call request, warm request, continuation"
        );
        let (request, warm, continuation) = (&calls[0], &calls[1], &calls[2]);
        // The real requests run uncapped; the warm request caps at one token.
        assert_eq!(request.max_tokens, None);
        assert_eq!(
            warm.max_tokens,
            Some(1),
            "the warm request is a one-token read"
        );
        assert_eq!(continuation.max_tokens, None);
        // The identical request shape: same model, same messages.
        assert_eq!(
            serde_json::to_value(&warm.model).unwrap(),
            serde_json::to_value(&request.model).unwrap(),
        );
        assert_eq!(
            serde_json::to_value(&warm.context).unwrap(),
            serde_json::to_value(&request.context).unwrap(),
            "the warm request replays the exact messages of the request it re-arms"
        );
    }
    // And the discarded response never entered the conversation.
    let state = agent.state().await;
    assert!(state.messages.iter().all(|message| !matches!(
        message,
        AgentMessage::Standard(pa_agent::types::Message::Assistant(assistant))
            if assistant.content.iter().any(|block| matches!(block,
                pa_agent::types::AssistantContent::Text(text) if text.text == "warm"))
    )));
}

/// A resolver that answers `None` (the settings opt-out) keeps the loop
/// on the plain batch path: no warm calls at all.
#[tokio::test(start_paused = true)]
async fn opt_out_resolves_no_policy_and_never_fires() {
    let provider = Arc::new(RecordingProvider::new(test_model()));
    let agent = Agent::new(AgentOptions {
        initial_state: pa_agent::agent::AgentInitialState {
            tools: Some(vec![
                Arc::new(SlowTool { delay_ms: 250 }) as Arc<dyn AgentTool>
            ]),
            ..Default::default()
        },
        stream_fn: Some(provider.stream_fn()),
        cache_keep_alive: Some(Arc::new(|_model: &Model| None)),
        ..Default::default()
    });
    agent.set_model(test_model()).await;
    provider
        .scripted
        .push_tool_call_turn(None, vec![("call-1", "slow", serde_json::json!({}))]);
    provider.scripted.push_text_turn("final");

    agent.prompt("run the slow tool").await.unwrap();
    agent.wait_for_idle().await;
    let_fires_settle(&provider.calls, 3).await;

    let calls = provider.calls.lock().unwrap();
    assert_eq!(
        calls.len(),
        2,
        "the opt-out never sends warm requests: {calls:?}"
    );
}

/// A warm reply's settled usage reaches the `on_fire` hook (the accounting
/// seam the engine wires to the durable row), and a failed warm request
/// reports its error without failing the turn.
#[tokio::test(start_paused = true)]
async fn fired_usage_reaches_the_hook() {
    let (agent, provider, fires) = keep_alive_agent(
        Arc::new(SlowTool { delay_ms: 250 }),
        Duration::from_millis(100),
    )
    .await;
    provider
        .scripted
        .push_tool_call_turn(None, vec![("call-1", "slow", serde_json::json!({}))]);
    // First fire settles with a usage block (a cache read); the second
    // fails at start (the provider is down) — both report through the
    // hook, and the turn proceeds either way.
    provider
        .scripted
        .push_turn(pa_agent::scripted::ScriptedTurn::Events(vec![
            pa_agent::scripted::ScriptStep::Event(Box::new(
                pa_agent::stream::AssistantMessageEvent::Done {
                    reason: StopReason::Stop,
                    message: warm_reply_with_usage(),
                },
            )),
        ]));
    provider.scripted.push_fail_start_turn("provider down");
    provider.scripted.push_text_turn("final");

    agent.prompt("run the slow tool").await.unwrap();
    agent.wait_for_idle().await;
    let_fires_settle(&fires, 2).await;

    {
        let fires = fires.lock().unwrap();
        assert_eq!(fires.len(), 2, "one fire per window: {fires:?}");
        assert_eq!(
            fires[0].usage.as_ref().map(|usage| usage.cache_read),
            Some(12_000),
            "the settled warm reply's usage reaches the hook: {:?}",
            fires[0]
        );
        assert!(fires[0].error.is_none());
        assert_eq!(
            fires[1].error.as_deref(),
            Some("provider down"),
            "a failed warm request reports the error, never the usage"
        );
        assert!(fires[1].usage.is_none());
    }
    // The turn itself completed normally.
    let state = agent.state().await;
    assert!(
        state.messages.iter().any(|message| matches!(
            message,
            AgentMessage::Standard(pa_agent::types::Message::Assistant(assistant))
                if assistant.stop_reason == StopReason::Stop
        )),
        "a swallowed warm failure never fails the turn"
    );
}

/// A settled warm reply carrying the usage block the accounting seam
/// expects (a real warm response is one output token plus the cache
/// read of the whole cached prefix).
fn warm_reply_with_usage() -> pa_agent::types::AssistantMessage {
    let model = test_model();
    pa_agent::types::AssistantMessage {
        content: vec![],
        api: model.api,
        provider: model.provider,
        model: model.id,
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_agent::types::Usage {
            input: 12,
            output: 1,
            cache_read: 12_000,
            cache_write: 0,
            total_tokens: 12_013,
            cost: pa_agent::types::UsageCost {
                input: 0.000_012,
                output: 0.000_075,
                cache_read: 0.001_2,
                cache_write: 0.0,
                total: 0.001_287,
            },
        },
        stop_reason: StopReason::Stop,
        error_message: None,
        stop_reason_raw: None,
        timestamp: 0,
    }
}
