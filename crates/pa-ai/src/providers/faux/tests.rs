//! Faux provider tests mirroring `packages/ai/test/faux-provider.test.ts`.

use std::sync::Arc;

use serde_json::Map;

use super::*;
use crate::event_stream::AssistantMessageEventExt;
use crate::registry::get_api_provider;
use crate::stream::{complete, stream};
use crate::types::{ErrorStopReason, Tool, UserMessage, UserOrToolContent};

fn user_text(text: &str) -> Message {
    Message::User(UserMessage {
        content: UserMessageContent::Text(text.to_string()),
        timestamp: 0,
        rest: Map::default(),
    })
}

fn text_msg(text: &str) -> FauxResponseStep {
    FauxResponseStep::Message(faux_assistant_message(
        vec![faux_text(text)],
        FauxAssistantMessageOptions::default(),
    ))
}

fn register() -> FauxProviderRegistration {
    register_faux_provider(RegisterFauxProviderOptions::default())
}

async fn event_types(model: &Model, context: &Context) -> Vec<&'static str> {
    let events = stream(model, context, None).unwrap().collect().await;
    events
        .iter()
        .map(crate::event_stream::AssistantMessageEventExt::event_type)
        .collect()
}

#[tokio::test]
async fn registers_a_custom_provider_and_estimates_usage() {
    let registration = register();
    registration.set_responses(vec![text_msg("hello world")]);

    let context = Context {
        system_prompt: Some("Be concise.".into()),
        messages: vec![user_text("hi there")],
        tools: None,
    };

    let response = complete(&registration.get_model(), &context, None)
        .await
        .unwrap();
    assert_eq!(response.content, vec![faux_text("hello world")]);
    assert!(response.usage.input > 0);
    assert!(response.usage.output > 0);
    assert_eq!(
        response.usage.total_tokens,
        response.usage.input + response.usage.output
    );
    assert_eq!(registration.call_count(), 1);
    registration.unregister();
}

#[tokio::test]
async fn supports_helper_blocks_for_text_thinking_and_tool_calls() {
    let registration = register();
    registration.set_responses(vec![FauxResponseStep::Message(faux_assistant_message(
        vec![
            faux_thinking("think"),
            faux_tool_call("echo", serde_json::json!({"text": "hi"}), None),
            faux_text("done"),
        ],
        FauxAssistantMessageOptions {
            stop_reason: Some(StopReason::ToolUse),
            ..Default::default()
        },
    ))]);

    let response = complete(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(response.content[0], faux_thinking("think"));
    match &response.content[1] {
        AssistantContent::ToolCall(tool_call) => {
            assert_eq!(tool_call.name, "echo");
            assert_eq!(
                tool_call.arguments,
                serde_json::json!({"text": "hi"})
                    .as_object()
                    .cloned()
                    .unwrap()
            );
            assert!(!tool_call.id.is_empty());
        }
        other => panic!("expected tool call, got {other:?}"),
    }
    assert_eq!(response.content[2], faux_text("done"));
    assert_eq!(response.stop_reason, StopReason::ToolUse);
    registration.unregister();
}

#[tokio::test]
async fn supports_multiple_models_with_per_model_reasoning_and_model_aware_factories() {
    let registration = register_faux_provider(RegisterFauxProviderOptions {
        models: Some(vec![
            FauxModelDefinition {
                id: "faux-fast".into(),
                name: Some("Faux Fast".into()),
                reasoning: Some(false),
                ..Default::default()
            },
            FauxModelDefinition {
                id: "faux-thinker".into(),
                name: Some("Faux Thinker".into()),
                reasoning: Some(true),
                ..Default::default()
            },
        ]),
        ..Default::default()
    });
    let make_factory = || {
        FauxResponseStep::Factory(Arc::new(|_context, _options, _count, model| {
            Ok(faux_assistant_message(
                vec![faux_text(&format!("{}:{}", model.id, model.reasoning))],
                FauxAssistantMessageOptions::default(),
            ))
        }))
    };
    registration.set_responses(vec![make_factory(), make_factory()]);

    assert_eq!(
        registration
            .models
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        vec!["faux-fast", "faux-thinker"]
    );
    assert!(!registration.get_model().reasoning);
    assert!(!registration.get_model_by_id("faux-fast").unwrap().reasoning);
    assert!(
        registration
            .get_model_by_id("faux-thinker")
            .unwrap()
            .reasoning
    );

    let fast = complete(
        &registration.get_model_by_id("faux-fast").unwrap(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        None,
    )
    .await
    .unwrap();
    let thinker = complete(
        &registration.get_model_by_id("faux-thinker").unwrap(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(fast.content, vec![faux_text("faux-fast:false")]);
    assert_eq!(thinker.content, vec![faux_text("faux-thinker:true")]);
    registration.unregister();
}

#[tokio::test]
async fn rewrites_api_provider_and_model_on_returned_messages() {
    let registration = register_faux_provider(RegisterFauxProviderOptions {
        api: Some("faux:test".into()),
        provider: Some("faux-provider".into()),
        models: Some(vec![FauxModelDefinition {
            id: "faux-model".into(),
            ..Default::default()
        }]),
        ..Default::default()
    });
    registration.set_responses(vec![text_msg("hello")]);

    let response = complete(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(response.api, "faux:test");
    assert_eq!(response.provider, "faux-provider");
    assert_eq!(response.model, "faux-model");
    registration.unregister();
}

#[tokio::test]
async fn consumes_queued_responses_in_order_and_errors_when_exhausted() {
    let registration = register();
    registration.set_responses(vec![text_msg("first"), text_msg("second")]);

    let context = Context {
        system_prompt: None,
        messages: vec![user_text("hi")],
        tools: None,
    };
    let first = complete(&registration.get_model(), &context, None)
        .await
        .unwrap();
    let second = complete(&registration.get_model(), &context, None)
        .await
        .unwrap();
    let exhausted = complete(&registration.get_model(), &context, None)
        .await
        .unwrap();

    assert_eq!(first.content, vec![faux_text("first")]);
    assert_eq!(second.content, vec![faux_text("second")]);
    assert_eq!(exhausted.stop_reason, StopReason::Error);
    assert_eq!(
        exhausted.error_message.as_deref(),
        Some("No more faux responses queued")
    );
    assert_eq!(registration.get_pending_response_count(), 0);
    assert_eq!(registration.call_count(), 3);
    registration.unregister();
}

#[tokio::test]
async fn can_replace_and_append_queued_responses() {
    let registration = register();
    registration.set_responses(vec![text_msg("first")]);

    let context = Context {
        system_prompt: None,
        messages: vec![user_text("hi")],
        tools: None,
    };
    assert_eq!(
        complete(&registration.get_model(), &context, None)
            .await
            .unwrap()
            .content,
        vec![faux_text("first")]
    );
    assert_eq!(registration.get_pending_response_count(), 0);

    registration.set_responses(vec![text_msg("second")]);
    assert_eq!(registration.get_pending_response_count(), 1);
    assert_eq!(
        complete(&registration.get_model(), &context, None)
            .await
            .unwrap()
            .content,
        vec![faux_text("second")]
    );

    registration.append_responses(vec![text_msg("third"), text_msg("fourth")]);
    assert_eq!(registration.get_pending_response_count(), 2);
    assert_eq!(
        complete(&registration.get_model(), &context, None)
            .await
            .unwrap()
            .content,
        vec![faux_text("third")]
    );
    assert_eq!(
        complete(&registration.get_model(), &context, None)
            .await
            .unwrap()
            .content,
        vec![faux_text("fourth")]
    );
    assert_eq!(registration.get_pending_response_count(), 0);
    registration.unregister();
}

#[tokio::test]
async fn supports_async_response_factories() {
    let registration = register();
    registration.set_responses(vec![FauxResponseStep::Factory(Arc::new(
        |context, _options, call_count, _model| {
            Ok(faux_assistant_message(
                vec![faux_text(&format!(
                    "{}:{}",
                    context.messages.len(),
                    call_count
                ))],
                FauxAssistantMessageOptions::default(),
            ))
        },
    ))]);

    let response = complete(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(response.content, vec![faux_text("1:1")]);
    registration.unregister();
}

#[tokio::test]
async fn emits_an_error_when_a_response_factory_throws() {
    let registration = register();
    registration.set_responses(vec![FauxResponseStep::Factory(Arc::new(
        |_context, _options, _count, _model| Err("boom".to_string()),
    ))]);

    let events = stream(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        None,
    )
    .unwrap()
    .collect()
    .await;

    assert_eq!(events.len(), 1);
    match &events[0] {
        AssistantMessageEvent::Error {
            reason: ErrorStopReason::Error,
            error,
        } => {
            assert_eq!(error.stop_reason, StopReason::Error);
            assert_eq!(error.error_message.as_deref(), Some("boom"));
        }
        other => panic!("expected error event, got {}", other.event_type()),
    }
    registration.unregister();
}

#[tokio::test]
async fn estimates_prompt_and_output_tokens_from_serialized_context() {
    let registration = register();
    registration.set_responses(vec![text_msg("done")]);

    let tool = Tool {
        name: "echo".into(),
        description: "Echo back text".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": false
        }),
    };
    let context = Context {
        system_prompt: Some("sys".into()),
        messages: vec![
            Message::User(UserMessage {
                content: UserMessageContent::Blocks(vec![
                    UserOrToolContent::Text(TextContent {
                        text: "hello".into(),
                        text_signature: None,
                        rest: Map::default(),
                    }),
                    UserOrToolContent::Image(ImageContent {
                        mime_type: "image/png".into(),
                        data: "abcd".into(),
                        rest: Map::default(),
                    }),
                ]),
                timestamp: 1,
                rest: Map::default(),
            }),
            Message::Assistant(faux_assistant_message(
                vec![faux_text("prior")],
                FauxAssistantMessageOptions::default(),
            )),
            Message::ToolResult(ToolResultMessage {
                tool_call_id: "tool-1".into(),
                tool_name: "echo".into(),
                content: vec![UserOrToolContent::Text(TextContent {
                    text: "tool out".into(),
                    text_signature: None,
                    rest: Map::default(),
                })],
                details: None,
                is_error: false,
                timestamp: 2,
                rest: Map::default(),
            }),
        ],
        tools: Some(vec![tool]),
    };

    let response = complete(&registration.get_model(), &context, None)
        .await
        .unwrap();
    let prompt_text = [
        "system:sys".to_string(),
        "user:hello\n[image:image/png:4]".to_string(),
        "assistant:prior".to_string(),
        "toolResult:echo\ntool out".to_string(),
        format!(
            "tools:{}",
            serde_json::to_string(&[Tool {
                name: "echo".into(),
                description: "Echo back text".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": false
                }),
            }])
            .unwrap()
        ),
    ]
    .join("\n\n");
    let expected_prompt_tokens = estimate_tokens(&prompt_text);
    let expected_output_tokens = estimate_tokens("done");

    assert_eq!(response.usage.input, expected_prompt_tokens);
    assert_eq!(response.usage.output, expected_output_tokens);
    assert_eq!(response.usage.cache_read, 0);
    assert_eq!(response.usage.cache_write, 0);
    assert_eq!(
        response.usage.total_tokens,
        expected_prompt_tokens + expected_output_tokens
    );
    registration.unregister();
}

#[tokio::test]
async fn does_not_share_cache_across_sessions_or_requests_without_session_id() {
    let registration = register();
    registration.set_responses(vec![
        text_msg("first"),
        text_msg("second"),
        text_msg("third"),
    ]);

    let mut context = Context {
        system_prompt: None,
        messages: vec![user_text("hello")],
        tools: None,
    };

    let first = complete(
        &registration.get_model(),
        &context,
        Some(StreamOptions {
            session_id: Some("session-1".into()),
            cache_retention: Some(crate::types::CacheRetention::Short),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert!(first.usage.cache_write > 0);
    context.messages.push(Message::Assistant(first));
    context.messages.push(user_text("follow up"));

    let second = complete(
        &registration.get_model(),
        &context,
        Some(StreamOptions {
            session_id: Some("session-2".into()),
            cache_retention: Some(crate::types::CacheRetention::Short),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert_eq!(second.usage.cache_read, 0);
    assert!(second.usage.cache_write > 0);

    let third = complete(&registration.get_model(), &context, None)
        .await
        .unwrap();
    assert_eq!(third.usage.cache_read, 0);
    assert_eq!(third.usage.cache_write, 0);
    registration.unregister();
}

#[tokio::test]
async fn simulates_prompt_caching_per_session_id() {
    let registration = register();
    registration.set_responses(vec![text_msg("first"), text_msg("second")]);

    let mut context = Context {
        system_prompt: Some("Be concise.".into()),
        messages: vec![user_text("hello")],
        tools: None,
    };

    let first = complete(
        &registration.get_model(),
        &context,
        Some(StreamOptions {
            session_id: Some("session-1".into()),
            cache_retention: Some(crate::types::CacheRetention::Short),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert_eq!(first.usage.cache_read, 0);
    assert!(first.usage.cache_write > 0);

    context.messages.push(Message::Assistant(first));
    context.messages.push(user_text("follow up"));

    let second = complete(
        &registration.get_model(),
        &context,
        Some(StreamOptions {
            session_id: Some("session-1".into()),
            cache_retention: Some(crate::types::CacheRetention::Short),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert!(second.usage.cache_read > 0);
    assert!(second.usage.input + second.usage.cache_read > second.usage.input);
    registration.unregister();
}

#[tokio::test]
async fn does_not_simulate_caching_when_cache_retention_is_none() {
    let registration = register();
    registration.set_responses(vec![text_msg("first"), text_msg("second")]);

    let mut context = Context {
        system_prompt: None,
        messages: vec![user_text("hello")],
        tools: None,
    };

    let first = complete(
        &registration.get_model(),
        &context,
        Some(StreamOptions {
            session_id: Some("session-1".into()),
            cache_retention: Some(crate::types::CacheRetention::None),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    context.messages.push(Message::Assistant(first));
    context.messages.push(user_text("follow up"));
    let second = complete(
        &registration.get_model(),
        &context,
        Some(StreamOptions {
            session_id: Some("session-1".into()),
            cache_retention: Some(crate::types::CacheRetention::None),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert_eq!(second.usage.cache_read, 0);
    assert_eq!(second.usage.cache_write, 0);
    registration.unregister();
}

#[tokio::test]
async fn streams_thinking_text_and_partial_tool_call_deltas() {
    let registration = register();
    registration.set_responses(vec![FauxResponseStep::Message(faux_assistant_message(
        vec![
            faux_thinking("thinking text"),
            faux_text("answer text"),
            faux_tool_call(
                "echo",
                serde_json::json!({"text": "hi", "count": 12}),
                Some("tool-1"),
            ),
        ],
        FauxAssistantMessageOptions {
            stop_reason: Some(StopReason::ToolUse),
            ..Default::default()
        },
    ))]);

    let events = stream(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        None,
    )
    .unwrap()
    .collect()
    .await;

    let mut tool_call_deltas: Vec<String> = Vec::new();
    let mut kinds: Vec<&str> = Vec::new();
    for event in &events {
        kinds.push(event.event_type());
        if let AssistantMessageEvent::ToolcallDelta { delta, .. } = event {
            tool_call_deltas.push(delta.clone());
        }
    }
    for expected in [
        "thinking_start",
        "thinking_delta",
        "text_start",
        "text_delta",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
    ] {
        assert!(
            kinds.contains(&expected),
            "missing event {expected} in {kinds:?}"
        );
    }
    assert!(tool_call_deltas.len() > 1);
    let joined = tool_call_deltas.join("");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&joined).unwrap(),
        serde_json::json!({"text": "hi", "count": 12})
    );
    registration.unregister();
}

#[tokio::test]
async fn streams_an_exact_event_order_for_fixed_size_chunks() {
    let registration = register_faux_provider(RegisterFauxProviderOptions {
        token_size_min: Some(1),
        token_size_max: Some(1),
        ..Default::default()
    });
    registration.set_responses(vec![FauxResponseStep::Message(faux_assistant_message(
        vec![
            faux_thinking("go"),
            faux_text("ok"),
            faux_tool_call("echo", serde_json::json!({}), Some("tool-1")),
        ],
        FauxAssistantMessageOptions {
            stop_reason: Some(StopReason::ToolUse),
            ..Default::default()
        },
    ))]);

    let types = event_types(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
    )
    .await;

    assert_eq!(
        types,
        vec![
            "start",
            "thinking_start",
            "thinking_delta",
            "thinking_end",
            "text_start",
            "text_delta",
            "text_end",
            "toolcall_start",
            "toolcall_delta",
            "toolcall_end",
            "done",
        ]
    );
    registration.unregister();
}

#[tokio::test]
async fn streams_multiple_tool_calls_in_one_message() {
    let registration = register();
    registration.set_responses(vec![FauxResponseStep::Message(faux_assistant_message(
        vec![
            faux_tool_call("echo", serde_json::json!({"text": "one"}), Some("tool-1")),
            faux_tool_call("echo", serde_json::json!({"text": "two"}), Some("tool-2")),
        ],
        FauxAssistantMessageOptions {
            stop_reason: Some(StopReason::ToolUse),
            ..Default::default()
        },
    ))]);

    let events = stream(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        None,
    )
    .unwrap()
    .collect()
    .await;

    assert_eq!(
        events
            .iter()
            .filter(|e| e.event_type() == "toolcall_start")
            .count(),
        2
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e.event_type() == "toolcall_end")
            .count(),
        2
    );
    registration.unregister();
}

fn error_step(message: &str, stop_reason: StopReason) -> FauxResponseStep {
    let mut m = faux_assistant_message(
        vec![faux_text("partial")],
        FauxAssistantMessageOptions::default(),
    );
    m.stop_reason = stop_reason;
    m.error_message = Some(message.to_string());
    FauxResponseStep::Message(m)
}

#[tokio::test]
async fn streams_an_explicit_assistant_error_message_as_a_terminal_error() {
    let registration = register_faux_provider(RegisterFauxProviderOptions {
        token_size_min: Some(2),
        token_size_max: Some(2),
        ..Default::default()
    });
    registration.set_responses(vec![error_step("upstream failed", StopReason::Error)]);

    let events = stream(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        None,
    )
    .unwrap()
    .collect()
    .await;

    let types: Vec<&str> = events
        .iter()
        .map(crate::event_stream::AssistantMessageEventExt::event_type)
        .collect();
    assert_eq!(
        types,
        vec!["start", "text_start", "text_delta", "text_end", "error"]
    );
    match events.last().unwrap() {
        AssistantMessageEvent::Error { reason, error } => {
            assert_eq!(*reason, ErrorStopReason::Error);
            assert_eq!(error.stop_reason, StopReason::Error);
            assert_eq!(error.error_message.as_deref(), Some("upstream failed"));
        }
        other => panic!("expected error event, got {}", other.event_type()),
    }
    registration.unregister();
}

#[tokio::test]
async fn streams_an_explicit_assistant_aborted_message_as_a_terminal_error() {
    let registration = register_faux_provider(RegisterFauxProviderOptions {
        token_size_min: Some(2),
        token_size_max: Some(2),
        ..Default::default()
    });
    registration.set_responses(vec![error_step("Request was aborted", StopReason::Aborted)]);

    let events = stream(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        None,
    )
    .unwrap()
    .collect()
    .await;

    let types: Vec<&str> = events
        .iter()
        .map(crate::event_stream::AssistantMessageEventExt::event_type)
        .collect();
    assert_eq!(
        types,
        vec!["start", "text_start", "text_delta", "text_end", "error"]
    );
    match events.last().unwrap() {
        AssistantMessageEvent::Error { reason, error } => {
            assert_eq!(*reason, ErrorStopReason::Aborted);
            assert_eq!(error.stop_reason, StopReason::Aborted);
            assert_eq!(error.error_message.as_deref(), Some("Request was aborted"));
        }
        other => panic!("expected error event, got {}", other.event_type()),
    }
    registration.unregister();
}

fn paced_registration(tokens_per_second: f64, size: usize) -> FauxProviderRegistration {
    register_faux_provider(RegisterFauxProviderOptions {
        tokens_per_second: Some(tokens_per_second),
        token_size_min: Some(size),
        token_size_max: Some(size),
        ..Default::default()
    })
}

#[tokio::test]
async fn supports_aborting_before_the_first_chunk() {
    let registration = paced_registration(50.0, 3);
    registration.set_responses(vec![text_msg("abcdefghijklmnopqrstuvwxyz")]);

    let signal = tokio_util::sync::CancellationToken::new();
    signal.cancel();
    let events = stream(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        Some(StreamOptions {
            signal: Some(signal),
            ..Default::default()
        }),
    )
    .unwrap()
    .collect()
    .await;

    assert_eq!(events.len(), 1);
    match &events[0] {
        AssistantMessageEvent::Error {
            reason: ErrorStopReason::Aborted,
            error,
        } => {
            assert_eq!(error.stop_reason, StopReason::Aborted);
        }
        other => panic!("expected aborted error, got {}", other.event_type()),
    }
    registration.unregister();
}

#[tokio::test]
async fn supports_aborting_mid_text_stream_when_paced() {
    let registration = paced_registration(100.0, 3);
    registration.set_responses(vec![text_msg("abcdefghijklmnopqrstuvwxyz")]);

    let signal = tokio_util::sync::CancellationToken::new();
    let mut types: Vec<&'static str> = Vec::new();
    let mut text_delta_count = 0usize;
    let mut s = stream(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        Some(StreamOptions {
            signal: Some(signal.clone()),
            ..Default::default()
        }),
    )
    .unwrap();
    while let Some(event) = s.next_event().await {
        types.push(event.event_type());
        if event.event_type() == "text_delta" {
            text_delta_count += 1;
            signal.cancel();
        }
    }

    assert_eq!(text_delta_count, 1);
    assert!(types.contains(&"text_start"));
    assert!(types.contains(&"text_delta"));
    assert!(types.contains(&"error"));
    assert!(!types.contains(&"text_end"));
    registration.unregister();
}

#[tokio::test]
async fn supports_aborting_mid_thinking_stream_when_paced() {
    let registration = paced_registration(100.0, 3);
    let mut message = faux_assistant_message(
        vec![faux_text("ignored")],
        FauxAssistantMessageOptions::default(),
    );
    message.content = vec![faux_thinking("abcdefghijklmnopqrstuvwxyz")];
    registration.set_responses(vec![FauxResponseStep::Message(message)]);

    let signal = tokio_util::sync::CancellationToken::new();
    let mut types: Vec<&'static str> = Vec::new();
    let mut thinking_delta_count = 0usize;
    let mut s = stream(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        Some(StreamOptions {
            signal: Some(signal.clone()),
            ..Default::default()
        }),
    )
    .unwrap();
    while let Some(event) = s.next_event().await {
        types.push(event.event_type());
        if event.event_type() == "thinking_delta" {
            thinking_delta_count += 1;
            signal.cancel();
        }
    }

    assert_eq!(thinking_delta_count, 1);
    assert!(types.contains(&"thinking_start"));
    assert!(types.contains(&"thinking_delta"));
    assert!(types.contains(&"error"));
    assert!(!types.contains(&"thinking_end"));
    registration.unregister();
}

#[tokio::test]
async fn supports_aborting_mid_toolcall_stream_when_paced() {
    let registration = paced_registration(100.0, 3);
    let mut message = faux_assistant_message(
        vec![faux_text("done")],
        FauxAssistantMessageOptions::default(),
    );
    message.content = vec![AssistantContent::ToolCall(ToolCall {
        id: "tool-1".into(),
        name: "echo".into(),
        arguments: serde_json::json!({"text": "abcdefghijklmnopqrstuvwxyz", "count": 123_456_789})
            .as_object()
            .cloned()
            .unwrap(),
        thought_signature: None,
        rest: Map::default(),
    })];
    message.stop_reason = StopReason::ToolUse;
    registration.set_responses(vec![FauxResponseStep::Message(message)]);

    let signal = tokio_util::sync::CancellationToken::new();
    let mut types: Vec<&'static str> = Vec::new();
    let mut toolcall_delta_count = 0usize;
    let mut s = stream(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        Some(StreamOptions {
            signal: Some(signal.clone()),
            ..Default::default()
        }),
    )
    .unwrap();
    while let Some(event) = s.next_event().await {
        types.push(event.event_type());
        if event.event_type() == "toolcall_delta" {
            toolcall_delta_count += 1;
            signal.cancel();
        }
    }

    assert_eq!(toolcall_delta_count, 1);
    assert!(types.contains(&"toolcall_start"));
    assert!(types.contains(&"toolcall_delta"));
    assert!(types.contains(&"error"));
    assert!(!types.contains(&"toolcall_end"));
    registration.unregister();
}

#[tokio::test]
async fn unregisters_the_provider() {
    // No registry reset here: clearing the process-wide registry races with
    // the other faux tests' registrations. The registration's api id is
    // unique (`random_id`) and `unregister` removes by source id, so the
    // lookup below is deterministic without nuking parallel tests.
    let registration = register();
    registration.set_responses(vec![text_msg("hello")]);
    let api = registration.api.clone();
    registration.unregister();

    assert!(get_api_provider(&api).is_none());
    let result = complete(
        &registration.get_model(),
        &Context {
            system_prompt: None,
            messages: vec![user_text("hi")],
            tools: None,
        },
        None,
    )
    .await;
    assert!(
        result.is_err(),
        "expected no API provider registered for api: {api}"
    );
}
