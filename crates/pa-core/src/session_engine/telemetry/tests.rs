//! The telemetry unit battery (moved with its concerns): the scripted
//! run state machine, the outcome/provider/model/error categories, and the
//! session-end finalize surface.
use std::time::Duration;

use pa_agent::stream::AssistantMessageEvent;
use pa_agent::types::{
    AgentMessage, AssistantContent, Message as LoopMessage, StopReason, TextContent,
    ToolResultContent, Usage,
};
use pa_telemetry::{MockSink, TelemetryClient, TelemetryClientConfig};

use super::*;

/// Controllable clock: tests move it between emits.
#[derive(Clone, Default)]
struct TestClock {
    millis: Arc<std::sync::atomic::AtomicU64>,
}

impl TestClock {
    fn set(&self, millis: u64) {
        self.millis
            .store(millis, std::sync::atomic::Ordering::Relaxed);
    }
}

fn client_for(mock: &std::sync::Arc<MockSink>) -> TelemetryClient {
    let mut config = TelemetryClientConfig::new("install-1");
    // Flush per event so assertions see every tracked event without an
    // explicit flush round-trip.
    config.batch_size = 1;
    config.flush_interval = Duration::from_mins(10);
    config.sinks = vec![mock.clone() as Arc<dyn pa_telemetry::TelemetrySink>];
    TelemetryClient::spawn(config).expect("spawn client")
}

struct Fixture {
    client: TelemetryClient,
    state: Arc<Mutex<TelemetryState>>,
    clock: TestClock,
    mock: std::sync::Arc<MockSink>,
}

/// A subscriber fed by scripted events — the state machine without a
/// live agent (same `handle_event` call the subscription uses).
fn fixture() -> Fixture {
    fixture_with_clock(TestClock::default())
}

fn fixture_with_clock(clock: TestClock) -> Fixture {
    let mock = std::sync::Arc::new(MockSink::new());
    let client = client_for(&mock);
    let now: Arc<dyn Fn() -> u64 + Send + Sync> = {
        let millis = clock.millis.clone();
        Arc::new(move || millis.load(std::sync::atomic::Ordering::Relaxed))
    };
    let state = Arc::new(Mutex::new(TelemetryState {
        session_id: "session-1".to_string(),
        started_at: 1_000,
        totals: SessionTotals::default(),
        active_run: None,
        tool_starts: HashMap::new(),
        now,
    }));
    Fixture {
        client,
        state,
        clock,
        mock,
    }
}

fn emit(fixture: &Fixture, event: AgentEvent) {
    handle_event(&fixture.client, "interactive", &fixture.state, event)
        .expect("telemetry event handled");
}

fn assistant_message() -> AssistantMessage {
    AssistantMessage {
        content: vec![AssistantContent::Text(TextContent {
            text: "private assistant text".to_string(),
            text_signature: None,
        })],
        api: "test".to_string(),
        provider: "openai".to_string(),
        model: "gpt-test".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: Usage {
            input: 100,
            output: 20,
            cache_read: 50,
            cache_write: 0,
            total_tokens: 170,
            cost: pa_agent::types::UsageCost::default(),
        },
        stop_reason: StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
    }
}

fn assistant_with_error(error: &str) -> AssistantMessage {
    let mut message = assistant_message();
    message.stop_reason = StopReason::Error;
    message.error_message = Some(error.to_string());
    message
}

fn user_message() -> AgentMessage {
    AgentMessage::user("private prompt")
}

fn text_delta_event(message: &AssistantMessage) -> AgentEvent {
    AgentEvent::MessageUpdate {
        message: AgentMessage::Standard(LoopMessage::Assistant(message.clone())),
        assistant_message_event: Box::new(AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: "private streamed text".to_string(),
            partial: message.clone(),
        }),
    }
}

fn message_end_event(message: AssistantMessage) -> AgentEvent {
    AgentEvent::MessageEnd {
        message: AgentMessage::Standard(LoopMessage::Assistant(message)),
    }
}

fn tool_execution_event(tool: &str, is_error: bool) -> (AgentEvent, AgentEvent) {
    (
        AgentEvent::ToolExecutionStart {
            tool_call_id: format!("{tool}-1"),
            tool_name: tool.to_string(),
            args: serde_json::json!({ "command": "private command" }),
        },
        AgentEvent::ToolExecutionEnd {
            tool_call_id: format!("{tool}-1"),
            tool_name: tool.to_string(),
            result: pa_agent::types::AgentToolResult {
                content: vec![ToolResultContent::text("private tool output")],
                details: serde_json::Value::Null,
                terminate: None,
            },
            is_error,
        },
    )
}

/// Wait for the telemetry worker to drain tracked events, then read.
async fn event_properties(
    mock: &MockSink,
    name: &str,
) -> Vec<serde_json::Map<String, serde_json::Value>> {
    tokio::time::sleep(Duration::from_millis(10)).await;
    mock.events()
        .iter()
        .filter(|event| event.name == name)
        .map(|event| {
            serde_json::to_value(&event.properties)
                .expect("properties serialize")
                .as_object()
                .expect("properties are an object")
                .clone()
        })
        .collect()
}

/// TS "emits aggregate metrics without message or tool content": one run
/// through the full event sequence, exact counters, and no content leak.
#[tokio::test]
async fn emits_aggregate_metrics_without_content() {
    let fixture = fixture();
    let assistant = assistant_message();

    fixture.clock.set(1_000);
    emit(&fixture, AgentEvent::AgentStart);
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    fixture.clock.set(1_010);
    emit(&fixture, AgentEvent::TurnStart);
    fixture.clock.set(1_035);
    emit(&fixture, text_delta_event(&assistant));
    fixture.clock.set(1_050);
    let (tool_start, tool_end) = tool_execution_event("bash", false);
    emit(&fixture, tool_start);
    emit(&fixture, tool_end);
    fixture.clock.set(1_100);
    emit(&fixture, message_end_event(assistant.clone()));
    fixture.clock.set(1_125);
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    // Deferred finalize: AgentEnd alone must not seal the run yet (the
    // post-run compaction window stays open).
    assert!(event_properties(&fixture.mock, "agent run completed")
        .await
        .is_empty());

    // Session end finalizes the open run and emits the session totals.
    fixture.clock.set(1_200);
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    telemetry.end().await.unwrap();

    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    assert_eq!(run["outcome"], serde_json::json!("success"));
    assert_eq!(run["duration_ms"], serde_json::json!(125));
    assert_eq!(run["visible_ttft_ms"], serde_json::json!(25));
    assert_eq!(run["first_model_event_ms"], serde_json::json!(25));
    assert_eq!(run["model_latency_ms"], serde_json::json!(90));
    assert_eq!(run["turn_count"], serde_json::json!(1));
    assert_eq!(run["tool_call_count"], serde_json::json!(1));
    assert_eq!(run["tool_error_count"], serde_json::json!(0));
    assert_eq!(run["input_tokens"], serde_json::json!(100));
    assert_eq!(run["output_tokens"], serde_json::json!(20));
    assert_eq!(run["cache_read_tokens"], serde_json::json!(50));
    assert_eq!(run["total_tokens"], serde_json::json!(170));
    assert_eq!(run["retry_count"], serde_json::json!(0));
    assert_eq!(run["provider_category"], serde_json::json!("openai"));
    assert_eq!(run["model_category"], serde_json::json!("gpt"));
    assert_eq!(run["session_id"], serde_json::json!("session-1"));
    assert_eq!(run["execution_mode"], serde_json::json!("interactive"));
    assert_eq!(run["schema_version"], serde_json::json!(1));

    // Privacy: no private prompt/tool/assistant text anywhere.
    let all = serde_json::to_string(&fixture.mock.events()).unwrap();
    assert!(!all.contains("private"));
    assert!(!all.contains("session-1.jsonl"));

    let ended = event_properties(&fixture.mock, "agent session ended").await;
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0]["duration_ms"], serde_json::json!(200));
    assert_eq!(ended[0]["prompt_count"], serde_json::json!(1));
    assert_eq!(ended[0]["run_count"], serde_json::json!(1));
    assert_eq!(ended[0]["successful_run_count"], serde_json::json!(1));
    assert_eq!(ended[0]["total_tokens"], serde_json::json!(170));
}

/// TS "waits for post-run compaction before finalizing run metrics":
/// a compaction drained after `AgentEnd` still counts into that run.
#[tokio::test]
async fn post_run_compaction_counts_into_the_open_run() {
    let fixture = fixture();
    let assistant = assistant_message();

    emit(&fixture, AgentEvent::AgentStart);
    emit(&fixture, message_end_event(assistant.clone()));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    assert!(event_properties(&fixture.mock, "agent run completed")
        .await
        .is_empty());

    // The scheduled compaction drains between AgentEnd and the next run.
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    telemetry.note_compaction();
    emit(&fixture, AgentEvent::AgentStart);

    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["compaction_count"], serde_json::json!(1));
}

/// A compaction with no open run (between runs) does not inflate session
/// totals — TS counts compactions only while a run exists.
#[tokio::test]
async fn compaction_between_runs_is_not_counted() {
    let fixture = fixture();
    emit(&fixture, AgentEvent::AgentStart);
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    // No run finalized yet (one open, ended). Finalize it, then compact.
    emit(&fixture, AgentEvent::AgentStart);
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    emit(&fixture, AgentEvent::AgentStart);
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    emit(&fixture, AgentEvent::AgentStart);
    telemetry.note_compaction();
    let runs = event_properties(&fixture.mock, "agent run completed").await;
    // Third run has no compaction; second run has none either.
    assert!(runs
        .iter()
        .all(|run| run["compaction_count"] == serde_json::json!(0)));
}

/// Error and abort outcomes carry the TS `runOutcome` semantics and the
/// error-category classifier.
#[tokio::test]
async fn error_and_aborted_outcomes() {
    let fixture = fixture();
    let failed = assistant_with_error("API Error: 429 rate limit exceeded");
    emit(&fixture, AgentEvent::AgentStart);
    emit(&fixture, message_end_event(failed));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    emit(&fixture, AgentEvent::AgentStart);
    let mut aborted_message = assistant_message();
    aborted_message.stop_reason = StopReason::Aborted;
    emit(&fixture, message_end_event(aborted_message));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    emit(&fixture, AgentEvent::AgentStart);

    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0]["outcome"], serde_json::json!("error"));
    assert_eq!(runs[0]["error_category"], serde_json::json!("rate_limit"));
    assert_eq!(runs[1]["outcome"], serde_json::json!("aborted"));
    assert_eq!(runs[1]["error_category"], serde_json::Value::Null);
}

/// Error-category classifier matrix (TS `errorCategory`).
#[test]
fn error_categories() {
    fn category(error: &str) -> String {
        let message = assistant_with_error(error);
        error_category(Some(&message))
            .as_str()
            .expect("category")
            .to_string()
    }
    assert_eq!(category("Unauthorized: invalid api key"), "authentication");
    assert_eq!(category("403 forbidden"), "authentication");
    assert_eq!(category("credential expired"), "authentication");
    assert_eq!(category("429 quota exceeded"), "rate_limit");
    assert_eq!(category("request timed out"), "timeout");
    assert_eq!(category("context length too long"), "context_limit");
    assert_eq!(category("maximum context length exceeded"), "context_limit");
    assert_eq!(category("network socket connection reset"), "network");
    assert_eq!(category("fetch failed"), "network");
    assert_eq!(
        category("503 overloaded, service unavailable"),
        "provider_unavailable"
    );
    assert_eq!(category("something unexpected happened"), "other");
    assert_eq!(
        error_category(Some(&assistant_message())),
        serde_json::Value::Null
    );
}

/// Provider/model categories (TS `telemetryProviderCategory` /
/// `modelCategory`).
#[test]
fn provider_and_model_categories() {
    assert_eq!(provider_category(Some("prime")), "prime");
    assert_eq!(provider_category(Some("ANTHROPIC")), "anthropic");
    assert_eq!(provider_category(Some("custom-host")), "custom");
    assert_eq!(provider_category(None), "unknown");
    assert_eq!(model_category("glm-4.6"), "glm");
    assert_eq!(model_category("Claude-Sonnet-4"), "claude");
    assert_eq!(model_category("kimi-k2"), "kimi");
    assert_eq!(model_category("my-finetune"), "custom");
}

/// `tool executed` events: tool name + duration + outcome, no arguments
/// or results, per-execution.
#[tokio::test]
async fn tool_executed_events_carry_name_duration_outcome() {
    let fixture = fixture();
    emit(&fixture, AgentEvent::AgentStart);
    fixture.clock.set(1_000);
    let (tool_start, tool_end) = tool_execution_event("bash", false);
    emit(&fixture, tool_start);
    fixture.clock.set(1_250);
    emit(&fixture, tool_end);
    let (fail_start, fail_end) = tool_execution_event("edit", true);
    emit(&fixture, fail_start);
    fixture.clock.set(1_300);
    emit(&fixture, fail_end);

    let tools = event_properties(&fixture.mock, "tool executed").await;
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["tool_name"], serde_json::json!("bash"));
    assert_eq!(tools[0]["duration_ms"], serde_json::json!(250));
    assert_eq!(tools[0]["is_error"], serde_json::json!(false));
    assert_eq!(tools[1]["tool_name"], serde_json::json!("edit"));
    assert_eq!(tools[1]["is_error"], serde_json::json!(true));
    let all = serde_json::to_string(&fixture.mock.events()).unwrap();
    assert!(!all.contains("private command"));
    assert!(!all.contains("private tool output"));
}

/// `agent command used` events: canonical command name only.
#[tokio::test]
async fn command_used_event_shape() {
    let fixture = fixture();
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    telemetry.note_command_used("compact");
    fixture.client.flush().await.unwrap();
    let commands = event_properties(&fixture.mock, "agent command used").await;
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0]["command_name"], serde_json::json!("compact"));
}

/// `skill used` events: name, kind, and arrival source; never prompt
/// content.
#[tokio::test]
async fn skill_used_event_shape() {
    let fixture = fixture();
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    telemetry.note_skill_used("web-search", "markdown", "prompt");
    telemetry.note_skill_used("agent-message", "python", "steer");
    fixture.client.flush().await.unwrap();
    let skills = event_properties(&fixture.mock, "skill used").await;
    assert_eq!(skills.len(), 2);
    assert_eq!(skills[0]["skill_name"], serde_json::json!("web-search"));
    assert_eq!(skills[0]["skill_kind"], serde_json::json!("markdown"));
    assert_eq!(skills[0]["source"], serde_json::json!("prompt"));
    assert_eq!(skills[1]["skill_name"], serde_json::json!("agent-message"));
    assert_eq!(skills[1]["skill_kind"], serde_json::json!("python"));
    assert_eq!(skills[1]["source"], serde_json::json!("steer"));
    let all = serde_json::to_string(&fixture.mock.events()).unwrap();
    assert!(!all.contains("skill content"));
}

/// `rlm child usage attributed`: the origin label and the batch's
/// primitives; the token counts and cost round-trip, and nothing
/// else rides.
#[tokio::test]
async fn child_usage_attributed_event_shape() {
    let fixture = fixture();
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    telemetry.note_child_usage_attributed("spawn_task", 50_208, 2_929, 0, 0, 0.008_995_7);
    fixture.client.flush().await.unwrap();
    let events = event_properties(&fixture.mock, "rlm child usage attributed").await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["origin"], serde_json::json!("spawn_task"));
    assert_eq!(events[0]["input_tokens"], serde_json::json!(50_208));
    assert_eq!(events[0]["output_tokens"], serde_json::json!(2_929));
    assert_eq!(events[0]["cache_read_tokens"], serde_json::json!(0));
    assert!((events[0]["cost"].as_f64().unwrap() - 0.008_995_7).abs() < 1e-9);
}

/// `build_client`: settings-provided `PostHog` endpoint + the local mirror.
#[tokio::test]
async fn build_client_resolves_settings_posthog_and_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let settings = crate::settings::SettingsManager::create(dir.path(), dir.path().join("agent"));
    // FileSink writes to the agent dir regardless of the PostHog sink.
    let client = build_client(&settings, &dir.path().join("agent"));
    assert!(!client.install_id().is_empty());
    assert_eq!(client.dropped_count(), 0);
}

/// Two runs in one session: totals merge, per-run events separate.
#[tokio::test]
async fn multiple_runs_merge_into_session_totals() {
    let fixture = fixture();
    let assistant = assistant_message();
    for _ in 0..2 {
        emit(&fixture, AgentEvent::AgentStart);
        emit(
            &fixture,
            AgentEvent::MessageStart {
                message: user_message(),
            },
        );
        emit(&fixture, AgentEvent::TurnStart);
        emit(&fixture, message_end_event(assistant.clone()));
        emit(
            &fixture,
            AgentEvent::AgentEnd {
                messages: Vec::new(),
            },
        );
    }
    emit(&fixture, AgentEvent::AgentStart);
    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 2);
}
