//! The empty-of-substance contract e2e (the silent-stop bug class): a
//! clean-stopped reply whose entire visible content is missing — or a
//! degenerate stub with thinking present — never ends the turn silently.
//! One bounded retry re-admits the explicit answer-as-text instruction; a
//! second empty reply surfaces a visible error.

use super::*;

/// The assistant messages one run settled, in wire form.
fn assistant_rows(events: &[EngineEvent]) -> Vec<serde_json::Value> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::AssistantMessage(message) => Some(message.clone()),
            _ => None,
        })
        .collect()
}

/// One reply's joined text (the empty string when it has no text blocks).
fn text_of(message: &serde_json::Value) -> String {
    message["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default()
}

/// Whether one reply carries a thinking block.
fn has_thinking(message: &serde_json::Value) -> bool {
    message["content"].as_array().is_some_and(|blocks| {
        blocks
            .iter()
            .any(|block| block.get("type").and_then(Value::as_str) == Some("thinking"))
    })
}

/// The user texts of the live loop context (what the next request and any
/// resume rebuild see).
fn context_user_texts(engine: &AgentSessionEngine) -> Vec<String> {
    let guard = engine.session.blocking_lock();
    let Some(core) = guard.as_deref() else {
        return Vec::new();
    };
    engine.runtime.block_on(async {
        let state = core.session.agent().state().await;
        state
            .messages
            .iter()
            .filter_map(|message| match message {
                pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::User(user)) => {
                    match &user.content {
                        pa_agent::types::UserContent::Text(text) => Some(text.clone()),
                        pa_agent::types::UserContent::Parts(parts) => Some(
                            parts
                                .iter()
                                .filter_map(|part| match part {
                                    pa_agent::types::UserPart::Text(text) => {
                                        Some(text.text.clone())
                                    }
                                    pa_agent::types::UserPart::Image(_) => None,
                                })
                                .collect::<String>(),
                        ),
                    }
                }
                _ => None,
            })
            .collect()
    })
}

/// A thinking-only reply that stops clean (the trace's silent shape).
fn thinking_only_stop() -> serde_json::Value {
    json!({
        "content": [
            {"type": "thinking", "thinking": "The user asked again, so I should give a simpler explanation. The core idea is that duplicate uploads duplicate runs, and the slow query scans the full history every time."},
            {"type": "thinking", "thinking": ""}
        ],
        "stopReason": "stop",
    })
}

#[test]
fn a_thinking_only_clean_stop_retries_once_and_lands() {
    let (engine, events) = run_prompts(
        &json!({
            "engine": "faux",
            "responses": [
                thinking_only_stop(),
                {"text": "Here is the full answer, as text."}
            ],
        }),
        &["explain 6699"],
    );
    // The retry admitted exactly one instruction row, after the empty
    // reply — exactly one retry, never two.
    let users = user_texts(&events);
    assert_eq!(users, vec!["explain 6699", EMPTY_REPLY_RETRY_INSTRUCTION]);
    // The first reply was the silent stop; the retry landed the answer.
    let assistants = assistant_rows(&events);
    assert_eq!(assistants.len(), 2, "one empty reply plus its retry");
    assert!(has_thinking(&assistants[0]));
    assert_eq!(text_of(&assistants[0]), "");
    assert_eq!(text_of(&assistants[1]), "Here is the full answer, as text.");
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    // The instruction row joined the conversation context like any
    // admitted prompt: the next request and any resume rebuild see it.
    assert_eq!(
        context_user_texts(&engine),
        vec!["explain 6699", EMPTY_REPLY_RETRY_INSTRUCTION]
    );
}

#[test]
fn a_stub_class_reply_rides_the_same_retry() {
    // The observed progression's later stage: the model prints a
    // degenerate sentinel instead of nothing at all.
    let (engine, events) = run_prompts(
        &json!({
            "engine": "faux",
            "responses": [
                {
                    "content": [
                        {"type": "thinking", "thinking": "planned the whole answer"},
                        {"type": "text", "text": "(no action)"}
                    ],
                    "stopReason": "stop"
                },
                {"text": "The answer, finally."}
            ],
        }),
        &["what changed?"],
    );
    let users = user_texts(&events);
    assert_eq!(
        users,
        vec!["what changed?", EMPTY_REPLY_RETRY_INSTRUCTION],
        "the stub class rides the same one-retry contract"
    );
    let assistants = assistant_rows(&events);
    assert_eq!(text_of(&assistants[1]), "The answer, finally.");
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    assert_eq!(
        context_user_texts(&engine),
        vec!["what changed?", EMPTY_REPLY_RETRY_INSTRUCTION]
    );
}

#[test]
fn a_healthy_reply_never_triggers_the_retry() {
    let (engine, events) = run_prompts(
        &json!({
            "engine": "faux",
            "responses": [
                {
                    "content": [
                        {"type": "thinking", "thinking": "planned the answer"},
                        {"type": "text", "text": "A full, healthy answer."}
                    ],
                    "stopReason": "stop"
                }
            ],
        }),
        &["hello"],
    );
    // No instruction row, exactly one assistant reply: the healthy turn
    // paid nothing for the contract.
    assert_eq!(user_texts(&events), vec!["hello"]);
    let assistants = assistant_rows(&events);
    assert_eq!(assistants.len(), 1);
    assert_eq!(text_of(&assistants[0]), "A full, healthy answer.");
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    assert_eq!(context_user_texts(&engine), vec!["hello"]);
}

#[test]
fn a_second_consecutive_empty_reply_surfaces_the_error() {
    let (_engine, events) = run_prompts(
        &json!({
            "engine": "faux",
            "responses": [thinking_only_stop(), thinking_only_stop()],
        }),
        &["explain 6699"],
    );
    // The retry fired once (the instruction row), and the turn ended with
    // the visible error — never silence.
    assert_eq!(
        user_texts(&events),
        vec!["explain 6699", EMPTY_REPLY_RETRY_INSTRUCTION]
    );
    assert_eq!(
        events.last(),
        Some(&EngineEvent::Done(Err(EMPTY_REPLY_TURN_ERROR.to_string()))),
        "the second empty reply surfaces the error: {:?}",
        events.last()
    );
}

/// The agent's live thinking level after the turn (the step-down must have
/// restored it).
fn live_thinking_level(engine: &AgentSessionEngine) -> Option<String> {
    let guard = engine.session.blocking_lock();
    let core = guard.as_deref()?;
    engine.runtime.block_on(async {
        let state = core.session.agent().state().await;
        Some(format!("{:?}", state.thinking_level).to_lowercase())
    })
}

/// A reasoning model's empty reply retries through the thinking step-down
/// arm: the retry runs one rung lower and the session's own level is
/// restored after the turn.
#[test]
fn a_reasoning_models_empty_reply_steps_the_retry_one_rung_down() {
    let (engine, events) = run_prompts(
        &json!({
            "engine": "faux",
            "reasoning": true,
            "responses": [
                {
                    "content": [
                        {"type": "thinking", "thinking": "planned the full answer"},
                        {"type": "thinking", "thinking": ""}
                    ],
                    "stopReason": "stop"
                },
                {"text": "The answer, at a lower thinking rung."}
            ],
        }),
        &["explain the trace"],
    );
    assert_eq!(
        user_texts(&events),
        vec!["explain the trace", EMPTY_REPLY_RETRY_INSTRUCTION],
        "the step-down retry still admits exactly one instruction row"
    );
    let assistants = assistant_rows(&events);
    assert_eq!(
        text_of(&assistants[1]),
        "The answer, at a lower thinking rung."
    );
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    // The step-down is retry-scoped: the session's medium level survives.
    assert_eq!(
        live_thinking_level(&engine).as_deref(),
        Some("medium"),
        "the session's own thinking level is restored after the retry"
    );
}

/// An abort landing between the empty reply and the retry suppresses the
/// retry: the turn ends with the already-settled reply, never re-issuing a
/// request after the user cancelled.
#[test]
fn an_abort_before_the_retry_suppresses_it() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(
            json!({
                "engine": "faux",
                "responses": [
                    {"content": [{"type": "thinking", "thinking": "silent"}], "stopReason": "stop"},
                    {"text": "never reached"}
                ],
            })
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    engine.register_arc();
    // The abort flips once the empty reply settles: the retry decision sees
    // it and never re-issues.
    let flipped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flipped_aborted = std::sync::Arc::clone(&flipped);
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "explain the trace".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &move || flipped_aborted.load(std::sync::atomic::Ordering::SeqCst),
        &mut |event| {
            if matches!(event, EngineEvent::AssistantMessage(_)) {
                flipped.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            events.push(event);
            true
        },
    );
    assert_eq!(
        user_texts(&events),
        vec!["explain the trace"],
        "an aborted turn never re-issues the retry request"
    );
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}
