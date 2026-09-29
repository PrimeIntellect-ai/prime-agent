//! The engine trait-side test battery (moved with its concern).
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[test]
fn scripted_engine_replays_then_echoes() {
    let engine = ScriptedEngine::from_value(
        &json!({"responses": ["first", {"text": "second", "delayMs": 0}]}),
    )
    .unwrap();
    let request_for = |message: &str| PromptRequest {
        batch: Vec::new(),
        images: Vec::new(),
        message: message.to_string(),
        source: "test".to_string(),
        agent_message_id: None,
        custom_message: None,
    };
    let collect = |engine: &ScriptedEngine, index: usize, message: &str| {
        let mut final_message = None;
        engine.run_prompt(index, request_for(message), &|| false, &mut |event| {
            if let EngineEvent::AssistantMessage(value) = event {
                final_message = Some(value);
            }
            true
        });
        final_message
    };
    assert_eq!(collect(&engine, 0, "hi").unwrap()["content"], "first");
    assert_eq!(collect(&engine, 1, "go").unwrap()["content"], "second");
    assert_eq!(
        collect(&engine, 2, "more").unwrap()["content"],
        "echo: more"
    );
}

#[test]
fn cancellation_stops_the_prompt() {
    let engine = ScriptedEngine::default();
    let seen = Arc::new(AtomicUsize::new(0));
    let seen_clone = seen.clone();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "x".into(),
            source: "test".into(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            seen_clone.fetch_add(1, Ordering::SeqCst);
            match event {
                EngineEvent::UserMessage(_) => false, // cancel right away
                _ => true,
            }
        },
    );
    assert_eq!(seen.load(Ordering::SeqCst), 2); // user message + done
}
