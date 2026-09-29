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
        session_id: "0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a".to_string(),
        started_at: 1_000,
        totals: SessionTotals::default(),
        active_run: None,
        tool_starts: HashMap::new(),
        active_error: None,
        consecutive_failure_count: 0,
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
    handle_event(&fixture.client, "interactive", &fixture.state, event);
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
        message: std::sync::Arc::new(AgentMessage::Standard(LoopMessage::Assistant(
            message.clone(),
        ))),
        assistant_message_event: std::sync::Arc::new(AssistantMessageEvent::TextDelta {
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
    assert_eq!(
        run["session_id"],
        serde_json::json!("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a")
    );
    assert_eq!(run["execution_mode"], serde_json::json!("interactive"));
    assert_eq!(run["schema_version"], serde_json::json!(2));

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
    telemetry.note_compaction(Some(45));
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
    telemetry.note_compaction(Some(45));
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

/// `agent run started` (v2): fires once per run window, at the right
/// moment, with the prompt trigger when a user message drives the run
/// and a `run_index` that pairs it with the completed event.
#[tokio::test]
async fn run_started_fires_with_prompt_trigger_and_run_index() {
    let fixture = fixture();
    let assistant = assistant_message();
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    fixture.clock.set(1_000);
    emit(&fixture, AgentEvent::AgentStart);
    emit(&fixture, AgentEvent::TurnStart);
    // The user message right after AgentStart names the trigger.
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    emit(&fixture, message_end_event(assistant.clone()));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    fixture.clock.set(2_000);
    emit(&fixture, AgentEvent::AgentStart);
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    let starts = event_properties(&fixture.mock, "agent run started").await;
    assert_eq!(starts.len(), 2, "one per run window");
    assert_eq!(starts[0]["trigger"], serde_json::json!("prompt"));
    assert_eq!(starts[0]["run_index"], serde_json::json!(1));
    assert_eq!(starts[1]["run_index"], serde_json::json!(2));
    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["run_index"], serde_json::json!(1));
    assert_eq!(
        starts[0]["run_id"], runs[0]["run_id"],
        "the run started/completed pair shares the run id"
    );
}

/// A continuation run (the auto-retry re-entry: no user message inside
/// the window) reports the continuation trigger.
#[tokio::test]
async fn continuation_run_reports_continuation_trigger() {
    let fixture = fixture();
    let assistant = assistant_message();
    emit(&fixture, AgentEvent::AgentStart);
    emit(&fixture, AgentEvent::TurnStart);
    // No user message: the first model event names the trigger.
    emit(&fixture, message_end_event(assistant));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    emit(&fixture, AgentEvent::AgentStart);
    let starts = event_properties(&fixture.mock, "agent run started").await;
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0]["trigger"], serde_json::json!("continuation"));
}

/// `agent tool summary` (v2): per-category call/failure/recovered
/// counts and durations at run finalize; a failure later followed by a
/// success of the same category counts as recovered.
#[tokio::test]
async fn tool_summary_per_category_with_recovery() {
    let fixture = fixture();
    emit(&fixture, AgentEvent::AgentStart);
    fixture.clock.set(1_000);
    let (bash_start, bash_end) = tool_execution_event("bash", false);
    emit(&fixture, bash_start);
    fixture.clock.set(1_100);
    emit(&fixture, bash_end);
    let (edit_start, edit_end) = tool_execution_event("edit", true);
    emit(&fixture, edit_start);
    fixture.clock.set(1_200);
    emit(&fixture, edit_end);
    // The recovered call: the same category fails then succeeds.
    let (edit_retry_start, edit_retry_end) = tool_execution_event("edit", false);
    emit(&fixture, edit_retry_start);
    fixture.clock.set(1_250);
    emit(&fixture, edit_retry_end);
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    emit(&fixture, AgentEvent::AgentStart);
    let summaries = event_properties(&fixture.mock, "agent tool summary").await;
    assert_eq!(summaries.len(), 2);
    let bash = summaries
        .iter()
        .find(|summary| summary["tool_category"] == serde_json::json!("bash"))
        .expect("bash summary");
    assert_eq!(bash["call_count"], serde_json::json!(1));
    assert_eq!(bash["failure_count"], serde_json::json!(0));
    assert_eq!(bash["duration_ms"], serde_json::json!(100));
    assert_eq!(bash["recovered_count"], serde_json::json!(0));
    let edit = summaries
        .iter()
        .find(|summary| summary["tool_category"] == serde_json::json!("edit"))
        .expect("edit summary");
    assert_eq!(edit["call_count"], serde_json::json!(2));
    assert_eq!(edit["failure_count"], serde_json::json!(1));
    assert_eq!(edit["recovered_count"], serde_json::json!(1));
    assert_eq!(edit["duration_ms"], serde_json::json!(150));
    // The per-execution `agent timing` tool events fired too.
    let timings = event_properties(&fixture.mock, "agent timing").await;
    let tool_timings: Vec<_> = timings
        .iter()
        .filter(|timing| timing["stage"] == serde_json::json!("tool"))
        .collect();
    assert_eq!(tool_timings.len(), 3, "one timing event per execution");
    assert_eq!(tool_timings[0]["duration_ms"], serde_json::json!(100));
    assert_eq!(tool_timings[0]["tool_category"], serde_json::json!("bash"));
    assert_eq!(tool_timings[1]["outcome"], serde_json::json!("error"));
}

/// `agent error` (v2): a failed model call emits one occurrence with
/// the classification (fixed diagnostic only - never the raw provider
/// text), and the retry's success emits the recovery update with the
/// same error id.
#[tokio::test]
async fn error_occurrence_and_recovery_pair_by_error_id() {
    let fixture = fixture();
    let failed = assistant_with_error("API Error: 429 rate limit exceeded with /home/user/secret");
    fixture.clock.set(1_000);
    emit(&fixture, AgentEvent::AgentStart);
    emit(&fixture, AgentEvent::TurnStart);
    fixture.clock.set(1_300);
    emit(&fixture, message_end_event(failed));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    // The retry seam: the wait, then the recovery.
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    telemetry.note_auto_retry_event(&AutoRetryEvent::Start {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 500,
        error_message: String::new(),
        reason: crate::session_engine::auto_retry::RetryStartReason::Quick,
    });
    telemetry.note_auto_retry_event(&AutoRetryEvent::End {
        success: true,
        attempt: 1,
        final_error: None,
        restored_model: None,
    });

    let errors = event_properties(&fixture.mock, "agent error").await;
    assert_eq!(errors.len(), 2, "one occurrence + one recovery update");
    let occurrence = &errors[0];
    assert_eq!(
        occurrence["error_event_kind"],
        serde_json::json!("occurrence")
    );
    assert_eq!(
        occurrence["error_subtype"],
        serde_json::json!("rate_limited")
    );
    assert_eq!(
        occurrence["error_category"],
        serde_json::json!("rate_limit")
    );
    assert_eq!(occurrence["http_status"], serde_json::json!(429));
    assert_eq!(occurrence["component"], serde_json::json!("provider"));
    assert_eq!(occurrence["operation"], serde_json::json!("stream"));
    assert_eq!(occurrence["stage"], serde_json::json!("model_stream"));
    assert_eq!(
        occurrence["consecutive_failure_count"],
        serde_json::json!(1)
    );
    // The privacy contract: no raw provider text anywhere.
    let all = serde_json::to_string(&fixture.mock.events()).unwrap();
    assert!(!all.contains("API Error"));
    assert!(!all.contains("/home/user/secret"));
    assert_eq!(
        occurrence["diagnostic_message"],
        serde_json::json!("Provider rate limit exceeded.")
    );
    assert_eq!(
        occurrence["error_message_redacted"],
        serde_json::json!(true)
    );
    let recovery = &errors[1];
    assert_eq!(
        recovery["error_event_kind"],
        serde_json::json!("recovery_update")
    );
    assert_eq!(
        recovery["recovery_action"],
        serde_json::json!("automatic_retry")
    );
    assert_eq!(recovery["recovery_outcome"], serde_json::json!("success"));
    assert_eq!(recovery["retry_attempt"], serde_json::json!(1));
    assert_eq!(
        occurrence["error_id"], recovery["error_id"],
        "the recovery update pairs with its occurrence"
    );
    // The `time_to_error` and `retry_wait` timing stages.
    let timings = event_properties(&fixture.mock, "agent timing").await;
    let time_to_error = timings
        .iter()
        .find(|timing| timing["stage"] == serde_json::json!("time_to_error"))
        .expect("time_to_error timing");
    assert_eq!(time_to_error["duration_ms"], serde_json::json!(300));
    let retry_wait = timings
        .iter()
        .find(|timing| timing["stage"] == serde_json::json!("retry_wait"))
        .expect("retry_wait timing");
    assert_eq!(retry_wait["duration_ms"], serde_json::json!(500));
    // The failed run window reports the retry counts.
    emit(&fixture, AgentEvent::AgentStart);
    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["outcome"], serde_json::json!("error"));
    assert_eq!(runs[0]["retry_count"], serde_json::json!(1));
    assert_eq!(runs[0]["retry_wait_ms"], serde_json::json!(500));
    assert_eq!(runs[0]["error_subtype"], serde_json::json!("rate_limited"));
    assert_eq!(runs[0]["stop_reason"], serde_json::json!("error"));
    assert_eq!(runs[0]["terminal_outcome"], serde_json::json!("error"));
    assert_eq!(runs[0]["usage_complete"], serde_json::json!(false));
    assert!(
        runs[0].get("estimated_cost_usd").is_none(),
        "incomplete usage never reports a cost"
    );
}

/// The enriched `agent run completed` (v2): the run pair id, the
/// stop reason, the usage completeness and the estimated cost.
#[tokio::test]
async fn run_completed_v2_enrichment() {
    let fixture = fixture();
    let mut assistant = assistant_message();
    assistant.usage.cost.total = 0.012;
    emit(&fixture, AgentEvent::AgentStart);
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    emit(&fixture, AgentEvent::TurnStart);
    emit(&fixture, message_end_event(assistant));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    emit(&fixture, AgentEvent::AgentStart);
    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["stop_reason"], serde_json::json!("stop"));
    assert_eq!(runs[0]["terminal_outcome"], serde_json::json!("success"));
    assert_eq!(runs[0]["successful_model_call_count"], serde_json::json!(1));
    assert_eq!(runs[0]["usage_complete"], serde_json::json!(true));
    assert_eq!(runs[0]["estimated_cost_usd"], serde_json::json!(0.012));
    let session = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    session.end().await.unwrap();
    let ended = event_properties(&fixture.mock, "agent session ended").await;
    assert_eq!(ended[0]["terminal_outcome"], serde_json::json!("success"));
}

/// A tool failure emits its own error occurrence (component `tools`)
/// without ever uploading the tool output.
#[tokio::test]
async fn tool_failure_emits_tools_error_occurrence() {
    let fixture = fixture();
    emit(&fixture, AgentEvent::AgentStart);
    let (start, end) = tool_execution_event("bash", true);
    emit(&fixture, start);
    emit(&fixture, end);
    let errors = event_properties(&fixture.mock, "agent error").await;
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0]["component"], serde_json::json!("tools"));
    assert_eq!(errors[0]["operation"], serde_json::json!("execute"));
    assert_eq!(errors[0]["stage"], serde_json::json!("tool_execution"));
    let all = serde_json::to_string(&fixture.mock.events()).unwrap();
    assert!(!all.contains("private tool output"));
}

/// The stream-gap timing: the largest quiet stretch between model
/// events reports on the run's timing stage.
#[tokio::test]
async fn stream_gap_tracks_the_largest_quiet_stretch() {
    let fixture = fixture();
    let assistant = assistant_message();
    fixture.clock.set(1_000);
    emit(&fixture, AgentEvent::AgentStart);
    emit(&fixture, AgentEvent::TurnStart);
    emit(&fixture, text_delta_event(&assistant));
    fixture.clock.set(1_050);
    emit(&fixture, text_delta_event(&assistant));
    fixture.clock.set(1_200);
    emit(&fixture, text_delta_event(&assistant));
    emit(&fixture, message_end_event(assistant));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    emit(&fixture, AgentEvent::AgentStart);
    let timings = event_properties(&fixture.mock, "agent timing").await;
    let gap = timings
        .iter()
        .find(|timing| timing["stage"] == serde_json::json!("stream_gap"))
        .expect("stream_gap timing");
    assert_eq!(gap["duration_ms"], serde_json::json!(150));
    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs[0]["max_stream_gap_ms"], serde_json::json!(150));
    assert_eq!(runs[0]["run_to_first_text_ms"], serde_json::json!(0));
}

/// The bot-found edges, pinned: the trigger lands on run completed (the
/// catalog lists it), an aborted run's terminal outcome is the #2117
/// `cancelled`, a tool failure never touches the model-failure chain,
/// and a retry give-up never double-counts the chain.
#[tokio::test]
async fn bot_edges_the_trigger_lands_and_terminal_outcome_maps() {
    let fixture = fixture();
    let mut aborted = assistant_message();
    aborted.stop_reason = StopReason::Aborted;
    emit(&fixture, AgentEvent::AgentStart);
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    emit(&fixture, AgentEvent::TurnStart);
    emit(&fixture, message_end_event(aborted));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    emit(&fixture, AgentEvent::AgentStart);
    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["trigger"], serde_json::json!("prompt"));
    assert_eq!(runs[0]["terminal_outcome"], serde_json::json!("cancelled"));
}

#[tokio::test]
async fn bot_edges_tool_failure_never_touches_the_model_failure_chain() {
    let fixture = fixture();
    emit(&fixture, AgentEvent::AgentStart);
    // The model failure counts chain link 1.
    emit(
        &fixture,
        message_end_event(assistant_with_error("API Error: 429 rate limit exceeded")),
    );
    // A tool failure between model failures emits its own occurrence but
    // neither increments nor wipes the model chain.
    let (start, end) = tool_execution_event("bash", true);
    emit(&fixture, start);
    emit(&fixture, end);
    // The next model failure still reports chain link 2.
    emit(
        &fixture,
        message_end_event(assistant_with_error("API Error: 429 rate limit exceeded")),
    );
    let errors = event_properties(&fixture.mock, "agent error").await;
    let model_occurrences: Vec<_> = errors
        .iter()
        .filter(|error| error["component"] == serde_json::json!("provider"))
        .collect();
    assert_eq!(
        model_occurrences[0]["consecutive_failure_count"],
        serde_json::json!(1)
    );
    assert_eq!(
        model_occurrences[1]["consecutive_failure_count"],
        serde_json::json!(2),
        "the tool failure in between never reset the chain"
    );
    let tool_occurrence = errors
        .iter()
        .find(|error| error["component"] == serde_json::json!("tools"))
        .expect("the tool occurrence fired");
    assert!(
        tool_occurrence.get("consecutive_failure_count").is_none(),
        "tool occurrences never carry the model chain counter"
    );
}

#[tokio::test]
async fn bot_edges_the_give_up_never_double_counts_the_chain() {
    let fixture = fixture();
    let failed = assistant_with_error("API Error: 429 rate limit exceeded");
    emit(&fixture, AgentEvent::AgentStart);
    emit(&fixture, message_end_event(failed));
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    // The retry gives up: the failed call already counted its link, and
    // a FAILED retry emits no recovery update at all (the retried
    // attempt's own failure is its own new occurrence when one happens -
    // a mispaired update would claim the wrong recovery).
    telemetry.note_auto_retry_event(&AutoRetryEvent::End {
        success: false,
        attempt: 1,
        final_error: Some("gave up".to_string()),
        restored_model: None,
    });
    let errors = event_properties(&fixture.mock, "agent error").await;
    assert_eq!(
        errors.len(),
        1,
        "the give-up never created a recovery update"
    );
    let occurrence = &errors[0];
    assert_eq!(
        occurrence["consecutive_failure_count"],
        serde_json::json!(1),
        "the give-up never inflated the chain to 2"
    );
}
