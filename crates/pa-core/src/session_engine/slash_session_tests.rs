use super::*;
use pa_agent::agent::{AgentInitialState, AgentOptions};
use pa_agent::scripted::ScriptedProvider;

fn test_model() -> pa_agent::types::Model {
    serde_json::from_value(serde_json::json!({
        "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
        "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 1000, "maxTokens": 100
    }))
    .unwrap()
}

#[tokio::test]
async fn session_commands_never_reach_the_model() {
    let provider = Arc::new(ScriptedProvider::new(test_model()));
    provider.push_text_turn("unused");
    let options = AgentOptions {
        initial_state: AgentInitialState {
            model: Some(test_model()),
            ..Default::default()
        },
        stream_fn: Some(provider.stream_fn()),
        ..Default::default()
    };
    let agent = Agent::new(options);
    let tmp = tempfile::tempdir().unwrap();
    let session = SessionManager::in_memory(tmp.path());
    let engine = AgentSession::new(Arc::new(agent), session, vec![])
        .await
        .unwrap();
    let outcome = engine
        .prompt("/compact focus on tests", PromptOptions::default())
        .await
        .unwrap();
    match &outcome {
        PromptOutcome::SessionCommand(command) => {
            assert_eq!(command.name, "compact");
            assert_eq!(command.args, "focus on tests");
        }
        PromptOutcome::Prompt => panic!("expected a session command"),
    }
    // No model call and no persisted user message.
    assert!(provider.calls().is_empty());
    assert!(engine.entries().await.is_empty());
}
