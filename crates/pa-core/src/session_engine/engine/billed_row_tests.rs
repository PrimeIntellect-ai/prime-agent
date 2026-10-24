//! The rows that bill a model call outside the agent loop, end to end
//! through `create_session`'s wiring: the session store reports each one to
//! the running goal and the telemetry run.
use super::*;
use pa_agent::scripted::ScriptedProvider;

use crate::session_engine::model_usage::ModelUsage;

fn scripted_model() -> pa_agent::types::Model {
    pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 1_000,
        max_tokens: 100,
        max_tokens_explicit: false,
    }
}

async fn scripted_engine(
    provider: &Arc<ScriptedProvider>,
    telemetry: Option<super::super::telemetry::TelemetryWiring>,
) -> (SessionEngine, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let engine = create_session(SessionEngineConfig {
        on_late_sent_agent_message: None,
        semantic_edges: None,
        cron_store: None,
        queued_steering_probe: None,
        should_stop_after_turn: None,
        image_model_router: None,
        steering_mode: None,
        follow_up_mode: None,
        cwd,
        agent_dir: tmp.path().join("agent"),
        mcp_manager: None,
        model: Some(scripted_model()),
        thinking_level: None,
        stream_fn: Some(provider.stream_fn()),
        tools: vec![],
        custom_system_prompt: None,
        prompt_guidelines: vec![],
        generic_mcp_servers: vec![],
        allow_recursion: None,
        session_manager: None,
        extra_host_handlers: None,
        conversation_log_path: None,
        additional_skill_paths: vec![],
        additional_prompt_paths: vec![],
        extra_builtin_skill_overrides: vec![],
        rlm_subagent_host: None,
        rlm_usage_store: None,
        progress_note_emit: None,
        rlm_depth: None,
        daemonless: true,
        telemetry,
        model_info: None,
        on_background_work_settled: None,
        bash_notice_wake: None,
        prewarm_ipython_kernel: None,
        queued_goal_context_purge: None,
    })
    .await
    .unwrap();
    (engine, tmp)
}

fn usage(input: u64, output: u64, cost: f64) -> pa_types::ai::Usage {
    pa_types::ai::Usage {
        input,
        output,
        total_tokens: input + output,
        cost: pa_types::ai::UsageCost {
            total: pa_types::JsNumber(cost),
            ..Default::default()
        },
        ..Default::default()
    }
}

/// A refinement review billed while the goal runs: the next accounted turn
/// charges its tokens with the turn's own.
#[tokio::test]
async fn a_billed_row_charges_the_running_goal() {
    let provider = Arc::new(ScriptedProvider::new(scripted_model()));
    let (engine, _tmp) = scripted_engine(&provider, None).await;
    {
        let persistence = engine.session.shared_persistence();
        let mut driver = engine.goal_driver.lock().await;
        let mut session = persistence.lock().await;
        driver
            .start(&mut session, "ship the port", Some(100_000))
            .unwrap();
    }
    engine
        .session
        .record_model_usage(ModelUsage::new(
            "refine_review",
            "test",
            "m",
            usage(1_200, 80, 0.0),
        ))
        .await;
    engine
        .record_goal_usage("a-1", &usage(10, 5, 0.0))
        .await
        .unwrap();
    assert_eq!(
        engine.goal_driver.lock().await.state().tokens_used,
        1_200 + 80 + 10 + 5
    );
}

/// A side question asked after the run's last turn still bills that run:
/// the run finalizes at session end with the call in its estimated cost.
#[tokio::test]
async fn a_billed_row_counts_into_the_run_cost() {
    let model = scripted_model();
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    let mut steps = pa_agent::scripted::text_turn_steps(&model, "done");
    if let Some(pa_agent::scripted::ScriptStep::Event(event)) = steps.last_mut() {
        if let pa_agent::stream::AssistantMessageEvent::Done { message, .. } = &mut **event {
            message.usage.input = 100;
            message.usage.output = 10;
            message.usage.total_tokens = 110;
            message.usage.cost.total = 0.5;
        }
    }
    provider.push_turn(pa_agent::scripted::ScriptedTurn::Events(steps));
    let mock = Arc::new(pa_telemetry::MockSink::new());
    let mut config = pa_telemetry::TelemetryClientConfig::new("install-1");
    config.batch_size = 1;
    config.flush_interval = std::time::Duration::from_mins(10);
    config.sinks = vec![mock.clone() as Arc<dyn pa_telemetry::TelemetrySink>];
    let telemetry = super::super::telemetry::TelemetryWiring {
        client: pa_telemetry::TelemetryClient::spawn(config).unwrap(),
        execution_mode: Some("print".to_string()),
        now: None,
        telemetry_enabled: None,
    };
    let (engine, _tmp) = scripted_engine(&provider, Some(telemetry)).await;
    engine
        .prompt("answer", PromptOptions::default())
        .await
        .unwrap();
    engine.session.agent().wait_for_idle().await;
    engine
        .session
        .record_model_usage(ModelUsage::new(
            "side_question",
            "test",
            "m",
            usage(40, 4, 0.25),
        ))
        .await;
    engine.telemetry.as_ref().unwrap().end().await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    let costs: Vec<serde_json::Value> = mock
        .events()
        .iter()
        .filter(|event| event.name == "agent run completed")
        .map(|event| serde_json::to_value(&event.properties).unwrap()["estimated_cost_usd"].clone())
        .collect();
    assert_eq!(costs, vec![serde_json::json!(0.75)]);
}
