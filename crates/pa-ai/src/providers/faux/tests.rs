//! Faux provider tests mirroring `packages/ai/test/faux-provider.test.ts`.

use serde_json::Map;

use super::*;
use crate::event_stream::AssistantMessageEventExt;
use crate::stream::{complete, stream};
use crate::types::{ErrorStopReason, UserMessage};

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
async fn parses_the_repeat_last_response_script_key_into_the_registration() {
    let parsed = script::parse_faux_script(&serde_json::json!({
        "responses": ["only"],
        "repeatLastResponse": true,
    }))
    .expect("script parses");
    assert!(parsed.repeat_last_response);
    let registration = script::register_faux_provider_from_script(&parsed);

    let context = Context {
        system_prompt: None,
        messages: vec![user_text("hi")],
        tools: None,
    };
    let queued = complete(&registration.get_model(), &context, None)
        .await
        .unwrap();
    let repeated = complete(&registration.get_model(), &context, None)
        .await
        .unwrap();
    assert_eq!(queued.content, vec![faux_text("only")]);
    assert_eq!(repeated.content, vec![faux_text("only")]);
    assert_eq!(registration.get_pending_response_count(), 0);
    assert_eq!(registration.call_count(), 2);
    registration.unregister();

    // The knob stays off unless the script opts in: the finite queue and its exhaustion error are
    // the response-budget contract.
    let parsed = script::parse_faux_script(&serde_json::json!({ "responses": ["only"] }))
        .expect("script parses");
    assert!(!parsed.repeat_last_response);
}

/// #3846: two scripted registrations in one process each keep their own queue.
#[tokio::test]
async fn script_registrations_keep_separate_queues() {
    let script = |reply: &str| {
        script::parse_faux_script(&serde_json::json!({ "responses": [reply] }))
            .expect("script parses")
    };
    let first = script::register_faux_provider_from_script(&script("first"));
    let second = script::register_faux_provider_from_script(&script("second"));

    let context = Context {
        system_prompt: None,
        messages: vec![user_text("hi")],
        tools: None,
    };
    let reply = complete(&first.get_model(), &context, None).await.unwrap();
    assert_eq!(reply.content, vec![faux_text("first")]);
    assert_eq!(second.get_pending_response_count(), 1);
    first.unregister();
    second.unregister();
}

#[tokio::test]
async fn overlapping_streams_in_repeat_last_mode_never_hit_the_exhaustion_error() {
    let registration = register();
    registration.set_repeat_last_response(true);
    registration.set_responses(vec![text_msg("only")]);

    let context = Context {
        system_prompt: None,
        messages: vec![user_text("hi")],
        tools: None,
    };
    let calls: Vec<_> = (0..8)
        .map(|_| {
            let model = registration.get_model();
            let context = context.clone();
            tokio::spawn(async move { complete(&model, &context, None).await })
        })
        .collect();
    for call in calls {
        let response = call.await.unwrap().expect("the call completes");
        assert_eq!(response.content, vec![faux_text("only")]);
        assert_ne!(response.stop_reason, StopReason::Error);
    }
    assert_eq!(registration.get_pending_response_count(), 0);
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
