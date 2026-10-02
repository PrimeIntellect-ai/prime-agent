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

/// Tests that resolve the env-gated switch need the three override vars
/// cleared (the Cargo test config sets `DO_NOT_TRACK`); restore after.
/// The env is process-wide, so these tests (and the packages env tests)
/// serialize through the shared env lock while they hold it.
const TELEMETRY_ENV_VARS: [&str; 3] = ["DO_NOT_TRACK", "PI_OFFLINE", "PRIME_AGENT_TELEMETRY"];

struct CleanTelemetryEnv {
    saved: Vec<(&'static str, Option<String>)>,
    _env_lock: std::sync::MutexGuard<'static, ()>,
}

impl Default for CleanTelemetryEnv {
    fn default() -> Self {
        // Held first: the vars may not be touched while another env test
        // runs.
        let env_lock = crate::packages::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let saved = TELEMETRY_ENV_VARS
            .iter()
            .map(|var| {
                let value = std::env::var(var).ok();
                std::env::remove_var(var);
                (*var, value)
            })
            .collect();
        Self {
            saved,
            _env_lock: env_lock,
        }
    }
}

impl Drop for CleanTelemetryEnv {
    fn drop(&mut self) {
        // The manual drop runs before the field drops: the restore lands
        // while the env lock is still held.
        for (var, value) in self.saved.drain(..) {
            match value {
                Some(value) => std::env::set_var(var, value),
                None => std::env::remove_var(var),
            }
        }
    }
}

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
        telemetry_enabled: None,
        recording: true,
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

/// Tool calls fold into the run: built-in tools by name, MCP and custom
/// tools only as aggregates, and no raw tool name rides any event.
#[tokio::test]
async fn tool_calls_fold_into_run_aggregates() {
    let fixture = fixture();
    let assistant = assistant_message();
    emit(&fixture, AgentEvent::AgentStart);
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    for (tool, is_error, start, end) in [
        ("bash", false, 1_000, 1_040),
        ("bash", true, 1_100, 1_110),
        ("edit", false, 1_200, 1_205),
        ("mcp__github__create_issue", false, 1_300, 1_350),
        ("private-extension-tool", false, 1_400, 1_401),
    ] {
        let (tool_start, tool_end) = tool_execution_event(tool, is_error);
        fixture.clock.set(start);
        emit(&fixture, tool_start);
        fixture.clock.set(end);
        emit(&fixture, tool_end);
    }
    emit(&fixture, message_end_event(assistant));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    emit(&fixture, AgentEvent::AgentStart);
    let runs = event_properties(&fixture.mock, "agent run completed").await;
    let run = &runs[0];
    assert_eq!(run["tool_call_count"], serde_json::json!(5));
    assert_eq!(run["tool_error_count"], serde_json::json!(1));
    assert_eq!(run["tool_bash_call_count"], serde_json::json!(2));
    assert_eq!(run["tool_bash_error_count"], serde_json::json!(1));
    assert_eq!(run["tool_bash_duration_ms"], serde_json::json!(50));
    assert_eq!(run["tool_bash_max_duration_ms"], serde_json::json!(40));
    assert_eq!(run["tool_edit_call_count"], serde_json::json!(1));
    assert_eq!(run["mcp_tool_call_count"], serde_json::json!(1));
    assert_eq!(run["custom_tool_call_count"], serde_json::json!(1));
    assert!(
        run.get("tool_read_call_count").is_none(),
        "unused tools stay absent"
    );
    let names: Vec<String> = fixture.mock.event_names();
    assert_eq!(names, ["agent run completed"], "no per-call events");
    let all = serde_json::to_string(&fixture.mock.events()).unwrap();
    assert!(!all.contains("github"));
    assert!(!all.contains("private-extension-tool"));
}

/// Skills, RLM child usage, MCP connector use, kernel boots, and feature
/// outcomes count into `agent session ended` instead of their own events.
#[tokio::test]
async fn session_counters_ride_session_ended() {
    let fixture = fixture();
    let counters = Arc::new(SessionCounters::default());
    let mut telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    telemetry.counters = Arc::clone(&counters);
    telemetry.note_skill_used();
    telemetry.note_skill_used();
    telemetry.note_child_usage_attributed(50_208, 2_929, 0, 0, 0.008_995_7);
    counters.note_mcp_connector_use();
    counters.note_kernel_bootstrap(true, true, 1_200);
    counters.note_kernel_bootstrap(false, false, 300);
    telemetry.note_feature_outcome("goal", "completed", Some("create"));
    telemetry.note_feature_outcome("not-a-feature", "completed", None);
    telemetry.end().await.unwrap();
    assert_eq!(fixture.mock.event_names(), ["agent session ended"]);
    let ended = &event_properties(&fixture.mock, "agent session ended").await[0];
    assert_eq!(ended["skill_use_count"], serde_json::json!(2));
    assert_eq!(ended["rlm_child_usage_count"], serde_json::json!(1));
    assert_eq!(ended["rlm_child_input_tokens"], serde_json::json!(50_208));
    assert_eq!(ended["rlm_child_output_tokens"], serde_json::json!(2_929));
    assert!((ended["rlm_child_cost"].as_f64().unwrap() - 0.008_995_7).abs() < 1e-9);
    assert_eq!(ended["mcp_connector_use_count"], serde_json::json!(1));
    assert_eq!(ended["kernel_bootstrap_count"], serde_json::json!(2));
    assert_eq!(ended["kernel_bootstrap_cold_count"], serde_json::json!(1));
    assert_eq!(ended["kernel_bootstrap_failed_count"], serde_json::json!(1));
    assert_eq!(ended["kernel_bootstrap_max_ms"], serde_json::json!(1_200));
    assert_eq!(ended["feature_goal_completed_count"], serde_json::json!(1));
}

/// `build_client` reuses the installation id a TS install wrote to
/// `telemetry.json` (one user across both products) and mirrors events to
/// the local JSONL file under that id.
#[tokio::test]
async fn build_client_reuses_the_ts_installation_id_and_mirrors() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let ts_id = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    std::fs::write(
        agent_dir.join("telemetry.json"),
        format!("{{\n  \"version\": 1,\n  \"installationId\": \"{ts_id}\"\n}}"),
    )
    .unwrap();
    let settings = crate::settings::SettingsManager::create(dir.path(), &agent_dir);
    let client = build_client(&settings, &agent_dir);
    assert_eq!(client.install_id(), ts_id);
    client.track("agent started", base_properties("interactive"));
    client.flush().await.unwrap();
    // The live switch gates every sink, the mirror included: the repo's
    // cargo env (`DO_NOT_TRACK=1`) keeps it off under `cargo test`.
    let mirror = std::fs::read_to_string(agent_dir.join("telemetry.jsonl")).ok();
    if telemetry_switch(&settings).enabled() {
        let mirror = mirror.expect("the mirror recorded the event");
        let line: serde_json::Value = serde_json::from_str(mirror.lines().next().unwrap()).unwrap();
        assert_eq!(line["distinct_id"], ts_id);
        assert_eq!(line["name"], "agent started");
    } else {
        assert!(
            mirror.is_none(),
            "nothing is recorded while telemetry is off"
        );
    }
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
async fn the_prompt_trigger_and_run_index_ride_the_completed_run() {
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
    assert!(
        event_properties(&fixture.mock, "agent run started")
            .await
            .is_empty(),
        "no run-start event: the trigger rides the completed run"
    );
    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["trigger"], serde_json::json!("prompt"));
    assert_eq!(runs[0]["run_index"], serde_json::json!(1));
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
    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["trigger"], serde_json::json!("continuation"));
}

fn retry_start(telemetry: &SessionTelemetry, attempt: u32, delay_ms: u64, backup: bool) {
    telemetry.note_auto_retry_event(&AutoRetryEvent::Start {
        attempt,
        max_attempts: 3,
        delay_ms,
        error_message: String::new(),
        reason: if backup {
            crate::session_engine::auto_retry::RetryStartReason::Backup {
                backup_model: "backup/m".to_string(),
            }
        } else {
            crate::session_engine::auto_retry::RetryStartReason::Quick
        },
    });
}

/// One model attempt inside the current run: the attempt's start, the
/// model call, its end.
fn attempt(fixture: &Fixture, message: AssistantMessage) {
    emit(fixture, AgentEvent::AgentStart);
    emit(fixture, AgentEvent::TurnStart);
    emit(fixture, message_end_event(message));
    emit(
        fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
}

/// TS one-run-per-turn: a turn that retried twice and then succeeded is
/// exactly one `agent run completed`, with `retry_count` 2, the success
/// outcome of the final attempt, and the failed attempts folded into the
/// error counters.
#[tokio::test]
async fn retries_fold_into_one_run_that_succeeds() {
    let fixture = fixture();
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    let failed = assistant_with_error("API Error: 429 rate limit exceeded with /home/user/secret");
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    attempt(&fixture, failed.clone());
    retry_start(&telemetry, 1, 500, false);
    attempt(&fixture, failed);
    retry_start(&telemetry, 2, 1_000, true);
    let mut recovered = assistant_message();
    recovered.usage.cost.total = 0.012;
    attempt(&fixture, recovered);
    telemetry.note_auto_retry_event(&AutoRetryEvent::End {
        success: true,
        attempt: 2,
        final_error: None,
        restored_model: None,
    });
    telemetry.end().await.unwrap();

    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1, "one run per turn");
    let run = &runs[0];
    assert_eq!(run["outcome"], serde_json::json!("success"));
    assert_eq!(run["error_category"], serde_json::Value::Null);
    assert_eq!(run["retry_count"], serde_json::json!(2));
    assert_eq!(run["failover_count"], serde_json::json!(1));
    assert_eq!(run["retry_wait_ms"], serde_json::json!(1_500));
    assert_eq!(run["model_call_count"], serde_json::json!(3));
    assert_eq!(run["turn_count"], serde_json::json!(3));
    assert_eq!(run["model_error_count"], serde_json::json!(2));
    assert_eq!(run["error_rate_limit_count"], serde_json::json!(2));
    // A recovered failure keeps the turn's cost.
    assert_eq!(run["usage_complete"], serde_json::json!(true));
    assert_eq!(run["estimated_cost_usd"], serde_json::json!(0.012));
    let ended = event_properties(&fixture.mock, "agent session ended").await;
    assert_eq!(ended[0]["run_count"], serde_json::json!(1));
    assert_eq!(ended[0]["successful_run_count"], serde_json::json!(1));
    assert_eq!(ended[0]["failed_run_count"], serde_json::json!(0));
    assert_eq!(ended[0]["retry_count"], serde_json::json!(2));
    // The privacy contract: no raw provider text anywhere.
    let all = serde_json::to_string(&fixture.mock.events()).unwrap();
    assert!(!all.contains("API Error"));
    assert!(!all.contains("/home/user/secret"));
}

/// A turn whose retries are exhausted is one run with the error outcome
/// of its final attempt.
#[tokio::test]
async fn exhausted_retries_are_one_failed_run() {
    let fixture = fixture();
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    let failed = assistant_with_error("network connection reset");
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    attempt(&fixture, failed.clone());
    retry_start(&telemetry, 1, 500, false);
    attempt(&fixture, failed.clone());
    retry_start(&telemetry, 2, 500, false);
    attempt(&fixture, failed);
    telemetry.note_auto_retry_event(&AutoRetryEvent::End {
        success: false,
        attempt: 2,
        final_error: Some("network".to_string()),
        restored_model: None,
    });
    telemetry.end().await.unwrap();

    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1, "one run per turn");
    assert_eq!(runs[0]["outcome"], serde_json::json!("error"));
    assert_eq!(runs[0]["error_category"], serde_json::json!("network"));
    assert_eq!(runs[0]["retry_count"], serde_json::json!(2));
    assert_eq!(runs[0]["model_error_count"], serde_json::json!(3));
    assert_eq!(runs[0]["error_network_count"], serde_json::json!(3));
    assert_eq!(runs[0]["stop_reason"], serde_json::json!("error"));
    let ended = event_properties(&fixture.mock, "agent session ended").await;
    assert_eq!(ended[0]["failed_run_count"], serde_json::json!(1));
    assert_eq!(ended[0]["run_count"], serde_json::json!(1));
}

/// A retry whose wait is cancelled closes its run: the next user turn is
/// a run of its own, not a continuation of the abandoned retry.
#[tokio::test]
async fn a_cancelled_retry_never_absorbs_the_next_turn() {
    let fixture = fixture();
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    attempt(&fixture, assistant_with_error("network connection reset"));
    retry_start(&telemetry, 1, 500, false);
    telemetry.note_auto_retry_event(&AutoRetryEvent::End {
        success: false,
        attempt: 1,
        final_error: Some("Retry cancelled".to_string()),
        restored_model: None,
    });
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    attempt(&fixture, assistant_message());
    telemetry.end().await.unwrap();

    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 2, "the next turn is its own run");
    assert_eq!(runs[0]["outcome"], serde_json::json!("error"));
    assert_eq!(runs[0]["retry_count"], serde_json::json!(1));
    assert_eq!(runs[1]["outcome"], serde_json::json!("success"));
    assert_eq!(runs[1]["retry_count"], serde_json::json!(0));
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

/// End to end through the real client and the real analytics sink to a
/// local stub endpoint: a scripted interactive session (start, one run
/// with a tool call, end) posts TS-shaped bodies, and every legacy event
/// carries the full TS property set in the TS vocabulary.
#[tokio::test]
async fn legacy_events_reach_the_analytics_endpoint_in_the_ts_shape() {
    use std::io::{Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://{}/api/v1/agent-analytics/events",
        listener.local_addr().unwrap()
    );
    let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                let n = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..n]);
                let text = String::from_utf8_lossy(&request);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        let body: serde_json::Value =
                            serde_json::from_slice(&request[end + 4..end + 4 + length]).unwrap();
                        let accepted = body["events"].as_array().map_or(0, Vec::len);
                        let reply = format!("{{\"accepted\":{accepted}}}");
                        // Hand the body over before answering: the flush
                        // returns once the reply is read, and the test
                        // collects right after it.
                        let _ = tx.send(body);
                        let _ = write!(
                            stream,
                            "HTTP/1.1 202 Accepted\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                            reply.len()
                        );
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
        }
    });

    let install_id = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    let mut config = TelemetryClientConfig::new(install_id);
    config.flush_interval = Duration::from_mins(10);
    config.sinks = vec![
        Arc::new(pa_telemetry::AnalyticsSink::new(url)) as Arc<dyn pa_telemetry::TelemetrySink>
    ];
    let client = TelemetryClient::spawn(config).unwrap();
    let mut fixture = fixture();
    fixture.client = client.clone();

    let mut started = base_properties("interactive");
    started.set(
        "session_id",
        Value::from("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a"),
    );
    client.track("agent started", started);
    let assistant = assistant_message();
    emit(&fixture, AgentEvent::AgentStart);
    emit(
        &fixture,
        AgentEvent::MessageStart {
            message: user_message(),
        },
    );
    emit(&fixture, AgentEvent::TurnStart);
    emit(&fixture, text_delta_event(&assistant));
    let (tool_start, tool_end) = tool_execution_event("bash", false);
    emit(&fixture, tool_start);
    emit(&fixture, tool_end);
    emit(&fixture, message_end_event(assistant));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    let telemetry =
        SessionTelemetry::detached(client, fixture.state.clone(), "interactive".to_string());
    telemetry.end().await.unwrap();

    let bodies: Vec<serde_json::Value> = rx.try_iter().collect();
    assert!(!bodies.is_empty(), "the stub received the batches");
    for body in &bodies {
        println!("{}", serde_json::to_string_pretty(body).unwrap());
        let mut keys: Vec<&String> = body.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            ["events", "installation_id"],
            "the TS envelope, nothing else"
        );
        assert_eq!(body["installation_id"], install_id);
        for event in body["events"].as_array().unwrap() {
            let mut keys: Vec<&String> = event.as_object().unwrap().keys().collect();
            keys.sort();
            assert_eq!(keys, ["id", "name", "properties", "timestamp"]);
        }
    }
    let events: Vec<&serde_json::Value> = bodies
        .iter()
        .flat_map(|body| body["events"].as_array().unwrap())
        .collect();
    let base = [
        "version",
        "os_family",
        "architecture",
        "install_method",
        "execution_mode",
        "libc",
        "libc_version",
        "cpu_baseline",
        "os_release",
        "os_product_version",
    ];
    let ts_keys: [(&str, &[&str]); 3] = [
        ("agent started", &["session_id"]),
        (
            "agent run completed",
            &[
                "session_id",
                "outcome",
                "duration_ms",
                "visible_ttft_ms",
                "first_model_event_ms",
                "model_latency_ms",
                "max_model_latency_ms",
                "model_call_count",
                "turn_count",
                "tool_call_count",
                "tool_error_count",
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
                "total_tokens",
                "compaction_count",
                "retry_count",
                "provider_category",
                "model_category",
                "error_category",
            ],
        ),
        (
            "agent session ended",
            &[
                "session_id",
                "duration_ms",
                "prompt_count",
                "run_count",
                "successful_run_count",
                "failed_run_count",
                "aborted_run_count",
                "tool_call_count",
                "compaction_count",
                "model_call_count",
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
                "total_tokens",
            ],
        ),
    ];
    for (name, keys) in ts_keys {
        let event = events
            .iter()
            .find(|event| event["name"] == name)
            .unwrap_or_else(|| panic!("{name} was sent"));
        let properties = event["properties"].as_object().unwrap();
        for key in base.iter().chain(keys.iter()) {
            assert!(
                properties.contains_key(*key),
                "{name} carries the TS key {key}"
            );
        }
        assert_eq!(properties["execution_mode"], "interactive");
        assert!(["linux", "darwin", "win32", "freebsd", "android"]
            .contains(&properties["os_family"].as_str().unwrap()));
        assert!(
            ["x64", "arm64", "ia32", "arm", "s390x", "ppc64", "riscv64", "loong64"]
                .contains(&properties["architecture"].as_str().unwrap())
        );
    }
    let run = events
        .iter()
        .find(|event| event["name"] == "agent run completed")
        .unwrap();
    assert_eq!(run["properties"]["outcome"], "success");
    assert_eq!(run["properties"]["provider_category"], "openai");
    assert_eq!(run["properties"]["model_category"], "gpt");
    assert_eq!(run["properties"]["error_category"], serde_json::Value::Null);
    // TS sums the session's tool calls from its runs (one call, counted once).
    let ended = events
        .iter()
        .find(|event| event["name"] == "agent session ended")
        .unwrap();
    assert_eq!(ended["properties"]["tool_call_count"], 1);
    std::fs::write(
        std::env::temp_dir().join("pa-telemetry-e2e-bodies.json"),
        serde_json::to_string_pretty(&bodies).unwrap(),
    )
    .unwrap();
}

/// A fixture whose recording seams consult a live switch the test flips:
/// the same shape [`install_session_telemetry`] installs from the wiring
/// (minus the write-path epoch tracking, which the production switch
/// registers and the zero-event-flap test exercises separately).
fn fixture_with_switch(telemetry_enabled: Arc<dyn Fn() -> bool + Send + Sync>) -> Fixture {
    let mock = std::sync::Arc::new(MockSink::new());
    let client = client_for(&mock);
    let clock = TestClock::default();
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
        telemetry_enabled: Some(RecordingSwitch::test(telemetry_enabled)),
        recording: true,
        now,
    }));
    Fixture {
        client,
        state,
        clock,
        mock,
    }
}

/// The TUI counters' rule, ported to the session surface: while telemetry
/// is off nothing counts, so turning it on later never sends what
/// happened while it was off.
#[tokio::test]
async fn off_period_session_counters_never_count() {
    let on = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let switch: Arc<dyn Fn() -> bool + Send + Sync> = {
        let on = Arc::clone(&on);
        Arc::new(move || on.load(std::sync::atomic::Ordering::Relaxed))
    };
    let fixture = fixture_with_switch(Arc::clone(&switch));
    let counters = Arc::new(SessionCounters::default());
    counters.set_telemetry_enabled(Arc::clone(&switch));
    let mut telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    telemetry.counters = Arc::clone(&counters);

    // Off: a skill use, a connector use, a kernel boot, a feature
    // outcome, and a child usage row all record nothing — the counters'
    // switch is the same live gate the engine installs at creation, so
    // the pre-install MCP/kernel window records nothing either.
    telemetry.note_skill_used();
    counters.note_mcp_connector_use();
    counters.note_kernel_bootstrap(true, true, 1_200);
    telemetry.note_feature_outcome("goal", "completed", Some("create"));
    telemetry.note_child_usage_attributed(50_208, 2_929, 0, 0, 0.008_995_7);

    // On: the same seams record again.
    on.store(true, std::sync::atomic::Ordering::Relaxed);
    telemetry.note_skill_used();
    telemetry.note_skill_used();

    telemetry.end().await.unwrap();
    let ended = &event_properties(&fixture.mock, "agent session ended").await[0];
    assert_eq!(ended["skill_use_count"], serde_json::json!(2));
    assert_eq!(
        ended["mcp_connector_use_count"],
        serde_json::json!(0),
        "the off-period connector use never counted"
    );
    assert_eq!(
        ended["rlm_child_usage_count"],
        serde_json::json!(0),
        "the off-period child usage never counted"
    );
    assert_eq!(
        ended["kernel_bootstrap_count"],
        serde_json::json!(0),
        "the off-period kernel boot never counted"
    );
    assert_eq!(
        ended["rlm_child_input_tokens"],
        serde_json::json!(0),
        "the off-period child tokens never counted"
    );
    let feature_keys: Vec<_> = ended
        .keys()
        .filter(|key| key.starts_with("feature_"))
        .collect();
    assert!(
        feature_keys.is_empty(),
        "the off-period feature outcome never counted"
    );
}

/// The run state machine stops recording while telemetry is off: a run
/// that happened in the off period never reports, and a later enable
/// sends only what the on period recorded.
#[tokio::test]
async fn off_period_run_facts_never_send() {
    let on = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let switch: Arc<dyn Fn() -> bool + Send + Sync> = {
        let on = Arc::clone(&on);
        Arc::new(move || on.load(std::sync::atomic::Ordering::Relaxed))
    };
    let fixture = fixture_with_switch(switch);
    let assistant = assistant_message();

    // A whole run while off: start, a turn, a tool call, and its end.
    fixture.clock.set(1_000);
    emit(&fixture, AgentEvent::AgentStart);
    emit(&fixture, AgentEvent::TurnStart);
    let (tool_start, tool_end) = tool_execution_event("bash", false);
    emit(&fixture, tool_start);
    emit(&fixture, tool_end);
    fixture.clock.set(1_100);
    emit(&fixture, message_end_event(assistant.clone()));
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );

    // On again: the next run records normally.
    on.store(true, std::sync::atomic::Ordering::Relaxed);
    fixture.clock.set(2_000);
    emit(&fixture, AgentEvent::AgentStart);
    fixture.clock.set(2_050);
    emit(&fixture, AgentEvent::TurnStart);
    fixture.clock.set(2_100);
    emit(&fixture, message_end_event(assistant.clone()));
    fixture.clock.set(2_150);
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );

    fixture.clock.set(2_200);
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    telemetry.end().await.unwrap();

    // One run completed: the on-period run. The off-period run never
    // existed, and its tool call never entered the session totals.
    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1, "only the on-period run reports");
    assert_eq!(runs[0]["turn_count"], serde_json::json!(1));
    assert_eq!(runs[0]["input_tokens"], serde_json::json!(100));
    let ended = &event_properties(&fixture.mock, "agent session ended").await[0];
    assert_eq!(ended["run_count"], serde_json::json!(1));
    assert_eq!(ended["tool_call_count"], serde_json::json!(0));
}

/// The recording switch resolves live: a fresh invocation reads the
/// settings as they are now, so the turn-boundary asks (and the
/// client's flush gate) observe a mid-session opt-out or re-enable the
/// moment it is saved. The events between boundaries deliberately use
/// the boundary cache; this proves only the raw switch has no cache of
/// its own.
#[test]
fn recording_switch_flips_immediately_with_the_settings() {
    let _env = CleanTelemetryEnv::default();
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let mut settings = crate::settings::SettingsManager::create(dir.path(), &agent_dir);
    settings.set_telemetry_enabled(true).unwrap();
    let switch = telemetry_enabled_switch(dir.path(), &agent_dir);
    assert!((switch.enabled)(), "on in settings records");

    // The off lands without a cache window: nothing the seams ask
    // after the flip may still see the pre-flip answer.
    settings.set_telemetry_enabled(false).unwrap();
    assert!(!(switch.enabled)(), "the off applies immediately");

    // The re-enable lands the same way.
    settings.set_telemetry_enabled(true).unwrap();
    assert!((switch.enabled)(), "the on applies immediately too");
}

/// The opt-out is the settings write itself: no telemetry state can
/// block it. A squatted (unwritable) install-id state — which used to
/// fail the command — never holds the disable hostage, and the opt-out
/// never touches (or mints) the state file.
#[test]
fn a_disable_lands_even_when_the_telemetry_state_is_unusable() {
    let _env = CleanTelemetryEnv::default();
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let mut settings = crate::settings::SettingsManager::create(dir.path(), &agent_dir);
    settings.set_telemetry_enabled(true).unwrap();
    // The state path is unusable: a directory squats it (no create or
    // rename could ever land there, for any user).
    std::fs::create_dir_all(agent_dir.join("telemetry.json")).unwrap();

    super::set_telemetry_enabled_text(&mut settings, &agent_dir, false).unwrap();
    assert!(
        !crate::settings::SettingsManager::create(dir.path(), &agent_dir).get_telemetry_enabled(),
        "the disable lands regardless of the telemetry state"
    );
    super::set_telemetry_enabled_text(&mut settings, &agent_dir, true).unwrap();
    assert!(
        crate::settings::SettingsManager::create(dir.path(), &agent_dir).get_telemetry_enabled(),
        "the re-enable lands the same way"
    );
}

/// Opting out never mints an identity: a fresh installation with no
/// install-id state disables without creating `telemetry.json`.
#[test]
fn a_disable_on_a_fresh_install_never_mints_the_install_id() {
    let _env = CleanTelemetryEnv::default();
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let mut settings = crate::settings::SettingsManager::create(dir.path(), &agent_dir);

    super::set_telemetry_enabled_text(&mut settings, &agent_dir, false).unwrap();

    assert!(
        !crate::settings::SettingsManager::create(dir.path(), &agent_dir).get_telemetry_enabled(),
        "the opt-out lands"
    );
    assert!(
        !agent_dir.join("telemetry.json").exists(),
        "the opt-out never creates the install-id state"
    );
}

/// A run active when telemetry goes off is severed, not merged: its
/// `AgentEnd` and the next run's `AgentStart` happen in the off period,
/// and the next on-period run starts clean with only its own facts.
#[tokio::test]
async fn a_run_active_when_telemetry_turns_off_is_severed_not_merged() {
    let on = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let switch: Arc<dyn Fn() -> bool + Send + Sync> = {
        let on = Arc::clone(&on);
        Arc::new(move || on.load(std::sync::atomic::Ordering::Relaxed))
    };
    let fixture = fixture_with_switch(switch);
    let assistant = assistant_message();

    // Run 1 starts while on: one turn, one tool call in flight.
    fixture.clock.set(1_000);
    emit(&fixture, AgentEvent::AgentStart);
    fixture.clock.set(1_050);
    emit(&fixture, AgentEvent::TurnStart);
    let (tool_start, _tool_end) = tool_execution_event("bash", false);
    emit(&fixture, tool_start);
    fixture.clock.set(1_100);
    emit(&fixture, message_end_event(assistant.clone()));

    // Telemetry goes off: run 1's tool end, its end, and the next
    // run's start all happen in the off period.
    on.store(false, std::sync::atomic::Ordering::Relaxed);
    fixture.clock.set(1_200);
    let (_tool_start2, tool_end) = tool_execution_event("bash", false);
    emit(&fixture, tool_end);
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );
    fixture.clock.set(1_300);
    emit(&fixture, AgentEvent::AgentStart);

    // Back on: the next run reports only its own window.
    on.store(true, std::sync::atomic::Ordering::Relaxed);
    fixture.clock.set(2_000);
    emit(&fixture, AgentEvent::AgentStart);
    fixture.clock.set(2_050);
    emit(&fixture, AgentEvent::TurnStart);
    fixture.clock.set(2_100);
    emit(&fixture, message_end_event(assistant.clone()));
    fixture.clock.set(2_150);
    emit(
        &fixture,
        AgentEvent::AgentEnd {
            messages: Vec::new(),
        },
    );

    fixture.clock.set(2_200);
    let telemetry = SessionTelemetry::detached(
        fixture.client.clone(),
        fixture.state.clone(),
        "interactive".to_string(),
    );
    telemetry.end().await.unwrap();

    let runs = event_properties(&fixture.mock, "agent run completed").await;
    assert_eq!(runs.len(), 1, "only the on-period run reports");
    assert_eq!(runs[0]["turn_count"], serde_json::json!(1));
    assert_eq!(
        runs[0]["duration_ms"],
        serde_json::json!(150),
        "the severed run never merges: the duration stays in run 2's window"
    );
    let ended = &event_properties(&fixture.mock, "agent session ended").await[0];
    assert_eq!(ended["run_count"], serde_json::json!(1));
    assert_eq!(
        ended["tool_call_count"],
        serde_json::json!(0),
        "the off-period tool end never counts"
    );
}
