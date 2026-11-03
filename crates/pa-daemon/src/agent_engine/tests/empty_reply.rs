//! The empty-of-substance contract e2e (the silent-stop bug class): a
//! clean-stopped reply whose entire visible content is missing — or the
//! observed actionless stub with thinking present — never ends the turn
//! silently. One bounded retry re-admits the answer-as-text instruction as
//! an injected custom row; a second empty reply surfaces a visible error.

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

/// The plain user texts of the live loop context (what the next request
/// and any resume rebuild see).
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

/// The content texts of the live loop context's custom rows of one type
/// (the deferred first-turn harness digest also rides the context as a
/// custom row; every row type is read by its own name).
fn context_custom_texts(engine: &AgentSessionEngine, custom_type: &str) -> Vec<String> {
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
                pa_agent::types::AgentMessage::Custom(custom) => {
                    (custom.payload.get("customType").and_then(Value::as_str) == Some(custom_type))
                        .then(|| {
                            custom
                                .payload
                                .get("content")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                        .flatten()
                }
                pa_agent::types::AgentMessage::Standard(_) => None,
            })
            .collect()
    })
}

/// The injected retry rows one run emitted (the retry's customType — the
/// first-turn harness digest also rides a custom row, by its own name).
fn retry_rows(events: &[EngineEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::CustomMessage(value)
                if value.get("customType").and_then(Value::as_str)
                    == Some(EMPTY_REPLY_RETRY_CUSTOM_TYPE) =>
            {
                value
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }
            _ => None,
        })
        .collect()
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
            "reasoning": true,
            "responses": [
                thinking_only_stop(),
                {"text": "Here is the full answer, as text."}
            ],
        }),
        &["explain 6699"],
    );
    // The retry admitted exactly one instruction row, as an injected custom
    // row after the empty reply — exactly one retry, never two, and never a
    // user row (the user never typed it).
    assert_eq!(user_texts(&events), vec!["explain 6699"]);
    assert_eq!(
        retry_rows(&events),
        vec![EMPTY_REPLY_RETRY_INSTRUCTION.to_string()],
        "the retry's instruction rides one injected custom row"
    );
    // The first reply was the silent stop; the retry landed the answer.
    let assistants = assistant_rows(&events);
    assert_eq!(assistants.len(), 2, "one empty reply plus its retry");
    assert!(has_thinking(&assistants[0]));
    assert_eq!(text_of(&assistants[0]), "");
    assert_eq!(text_of(&assistants[1]), "Here is the full answer, as text.");
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    // The instruction row joined the conversation context like any admitted
    // row: the next request and any resume rebuild see it.
    assert_eq!(context_user_texts(&engine), vec!["explain 6699"]);
    assert_eq!(
        context_custom_texts(&engine, EMPTY_REPLY_RETRY_CUSTOM_TYPE),
        vec![EMPTY_REPLY_RETRY_INSTRUCTION.to_string()]
    );
    // The retry never moves the session's thinking level: no level
    // machinery rides the contract.
    assert_eq!(
        live_thinking_level(&engine).as_deref(),
        Some("medium"),
        "the session's own thinking level survives the retry"
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
    assert_eq!(user_texts(&events), vec!["what changed?"]);
    assert_eq!(
        retry_rows(&events),
        vec![EMPTY_REPLY_RETRY_INSTRUCTION.to_string()],
        "the stub class rides the same one-retry contract"
    );
    let assistants = assistant_rows(&events);
    assert_eq!(text_of(&assistants[1]), "The answer, finally.");
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    assert_eq!(context_user_texts(&engine), vec!["what changed?"]);
    assert_eq!(
        context_custom_texts(&engine, EMPTY_REPLY_RETRY_CUSTOM_TYPE),
        vec![EMPTY_REPLY_RETRY_INSTRUCTION.to_string()]
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
    // The retry fired once (the injected instruction row), and the turn
    // ended with the visible error — never silence.
    assert_eq!(user_texts(&events), vec!["explain 6699"]);
    assert_eq!(
        retry_rows(&events),
        vec![EMPTY_REPLY_RETRY_INSTRUCTION.to_string()]
    );
    assert_eq!(
        events.last(),
        Some(&EngineEvent::Done(Err(EMPTY_REPLY_TURN_ERROR.to_string()))),
        "the second empty reply surfaces the error: {:?}",
        events.last()
    );
}

/// The agent's live thinking level after the turn (the empty-reply retry
/// never moves it).
fn live_thinking_level(engine: &AgentSessionEngine) -> Option<String> {
    let guard = engine.session.blocking_lock();
    let core = guard.as_deref()?;
    engine.runtime.block_on(async {
        let state = core.session.agent().state().await;
        Some(format!("{:?}", state.thinking_level).to_lowercase())
    })
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
            source: PromptSource::User,
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
    assert!(retry_rows(&events).is_empty());
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}

/// Run one admitted request through a fresh faux engine.
fn run_prompt_request(
    script: &serde_json::Value,
    request: PromptRequest,
) -> (std::sync::Arc<AgentSessionEngine>, Vec<EngineEvent>) {
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
        faux_script: Some(script.to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    engine.register_arc();
    let mut events = Vec::new();
    engine.run_prompt(0, request, &|| false, &mut |event| {
        events.push(event);
        true
    });
    (engine, events)
}

/// A turn the session's machinery woke (a scheduler fire: a plain text row
/// the user never typed) never retries its empty reply — silence is the
/// correct answer, and the retry instruction row would be spurious.
#[test]
fn a_system_prompted_empty_reply_never_retries() {
    let (engine, events) = run_prompt_request(
        &json!({
            "engine": "faux",
            "responses": [thinking_only_stop(), {"text": "never reached"}],
        }),
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "resume the parked work".to_string(),
            source: PromptSource::System,
            agent_message_id: None,
            custom_message: None,
        },
    );
    // The turn ends with the settled reply: no instruction row, no second
    // provider call, no error.
    assert_eq!(user_texts(&events), vec!["resume the parked work"]);
    assert!(retry_rows(&events).is_empty());
    let assistants = assistant_rows(&events);
    assert_eq!(assistants.len(), 1, "no retry ever fired");
    assert_eq!(text_of(assistants.last().unwrap()), "");
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    assert_eq!(context_user_texts(&engine), vec!["resume the parked work"]);
}

/// An agent-message turn (an injected custom row) never retries its empty
/// reply either: the notice asks for no action, and the model obeying it
/// must not be re-prompted into filler text.
#[test]
fn an_agent_message_turns_empty_reply_never_retries() {
    let (engine, events) = run_prompt_request(
        &json!({
            "engine": "faux",
            "responses": [thinking_only_stop(), {"text": "never reached"}],
        }),
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "sibling update: the queue drained".to_string(),
            source: PromptSource::System,
            agent_message_id: None,
            custom_message: Some(json!({
                "role": "custom",
                "customType": "agent_message",
                "content": "sibling update: the queue drained",
                "display": true,
                "timestamp": 0
            })),
        },
    );
    // The custom row admitted once; the empty reply stands as the answer.
    assert!(user_texts(&events).is_empty());
    assert!(retry_rows(&events).is_empty());
    let assistants = assistant_rows(&events);
    assert_eq!(assistants.len(), 1, "no retry ever fired");
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    assert_eq!(
        context_custom_texts(&engine, "agent_message"),
        vec!["sibling update: the queue drained".to_string()]
    );
    assert!(context_custom_texts(&engine, EMPTY_REPLY_RETRY_CUSTOM_TYPE).is_empty());
}
