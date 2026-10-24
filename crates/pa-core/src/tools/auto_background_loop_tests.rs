//! The live loop + live bash dispatch promotion contract (integration,
//! in-lib because the tools module is `pub(crate)`): an inline bash tool
//! call past the window settles the TURN — the streamed-update emitter
//! included, so the loop is not wedged until the process exits — returns
//! the synthetic auto-backgrounded result, and the completion notice
//! carries the command's output.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::session_engine::tool_bridge::ToolDefinitionBridge;
use crate::tools::bash::{create_bash_tool_definition_with_options, BashToolOptions};
use pa_agent::agent::{Agent, AgentInitialState, AgentOptions};
use pa_agent::scripted::ScriptedProvider;
use serde_json::json;

fn faux_model() -> pa_agent::types::Model {
    serde_json::from_value(json!({
        "id": "faux-1", "name": "Faux", "api": "test", "provider": "faux",
        "baseUrl": "http://localhost", "reasoning": false,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 200_000, "maxTokens": 4_000
    }))
    .expect("faux loop model")
}

/// The loop-observed contract: a `sleep 5` call with a 300ms window settles
/// the turn at the window (far before the process exits), and the
/// completion notice lands with the command's output.
#[tokio::test]
async fn a_promoted_bash_call_settles_the_turn_and_notifies() {
    let registry = Arc::new(pa_agent::auto_background::AutoBackgroundRegistry::new());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<
        pa_agent::auto_background::AutoBackgroundCompletion,
    >();
    let notice: pa_agent::auto_background::AutoBackgroundNoticeFn = Arc::new(move |completion| {
        tx.send(completion).ok();
    });

    let bash_tool = Arc::new(ToolDefinitionBridge::new(
        create_bash_tool_definition_with_options(
            ".",
            &BashToolOptions {
                auto_background_registry: Some(Arc::clone(&registry)),
                ..BashToolOptions::default()
            },
        ),
    ));

    let model = faux_model();
    let provider = Arc::new(ScriptedProvider::new(model.clone()));
    let agent = Agent::new(AgentOptions {
        initial_state: AgentInitialState {
            tools: Some(vec![bash_tool as Arc<dyn pa_agent::types::AgentTool>]),
            ..Default::default()
        },
        stream_fn: Some(provider.stream_fn()),
        auto_background_after: Some(300),
        auto_background_notice: Some(Arc::clone(&notice)),
        auto_background_registry: Some(Arc::clone(&registry)),
        ..Default::default()
    });
    agent.set_model(model).await;
    provider.push_tool_call_turn(
        None,
        vec![(
            "call-1",
            "bash",
            json!({ "command": "sleep 5; echo settled-lander" }),
        )],
    );
    provider.push_text_turn("done");

    let started = Instant::now();
    agent
        .prompt("run the long build")
        .await
        .expect("turn settles");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(4),
        "the turn must settle at the window while the 5s command keeps running, took {elapsed:?}"
    );

    let completion = tokio::time::timeout(Duration::from_secs(7), rx.recv())
        .await
        .expect("the promoted command's completion must arrive")
        .expect("notice lane open");
    assert_eq!(completion.exit_code, Some(0));
    assert!(
        completion.output.contains("settled-lander"),
        "the notice carries the command's output: {}",
        completion.output
    );
    assert!(
        completion
            .full_output_path
            .as_deref()
            .is_some_and(|path| std::path::Path::new(path).exists()),
        "the forced spill file must exist at the promoted command's completion"
    );
}
