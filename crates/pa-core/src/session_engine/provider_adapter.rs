//! Real-provider stream adapter: pa-ai completion streaming bridged into the
//! pa-agent loop's `StreamFn`/`ModelStream`, crossing the crate boundary by
//! wire-shape (JSON) round-trip. Shared by pa-cli (print/json modes) and
//! pa-daemon (session workers).

use std::sync::Arc;

use pa_agent::stream::{LlmContext, ModelStream, StreamFn, StreamRequestOptions};
use pa_agent::types::{Model as AgentModel, ThinkingLevel};
use pa_types::ai::Model;

/// Wire-shape conversion at the pa-agent/pa-ai boundary: both sides serialize
/// to the same camelCase wire shapes.
pub fn json_round_trip<T, U>(value: &T) -> Option<U>
where
    T: serde::Serialize,
    U: serde::de::DeserializeOwned,
{
    serde_json::to_value(value)
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
}

/// Thinking-level mapping across the two crates.
pub fn map_thinking_level(level: pa_types::ai::ModelThinkingLevel) -> ThinkingLevel {
    match level {
        pa_types::ai::ModelThinkingLevel::Off => ThinkingLevel::Off,
        pa_types::ai::ModelThinkingLevel::Minimal => ThinkingLevel::Minimal,
        pa_types::ai::ModelThinkingLevel::Low => ThinkingLevel::Low,
        pa_types::ai::ModelThinkingLevel::Medium => ThinkingLevel::Medium,
        pa_types::ai::ModelThinkingLevel::High => ThinkingLevel::High,
        pa_types::ai::ModelThinkingLevel::Xhigh => ThinkingLevel::Xhigh,
        pa_types::ai::ModelThinkingLevel::Max => ThinkingLevel::Max,
    }
}

/// The inverse of [`map_thinking_level`]: the pa-types view of the agent
/// state's thinking level.
pub fn model_thinking_level(level: ThinkingLevel) -> pa_types::ai::ModelThinkingLevel {
    match level {
        ThinkingLevel::Off => pa_types::ai::ModelThinkingLevel::Off,
        ThinkingLevel::Minimal => pa_types::ai::ModelThinkingLevel::Minimal,
        ThinkingLevel::Low => pa_types::ai::ModelThinkingLevel::Low,
        ThinkingLevel::Medium => pa_types::ai::ModelThinkingLevel::Medium,
        ThinkingLevel::High => pa_types::ai::ModelThinkingLevel::High,
        ThinkingLevel::Xhigh => pa_types::ai::ModelThinkingLevel::Xhigh,
        ThinkingLevel::Max => pa_types::ai::ModelThinkingLevel::Max,
    }
}

/// The mutable provider target a live session's stream reads per call:
/// daemon `set_model` swaps it without rebuilding the session, and the
/// provider-failover switch swaps it for the switched-to provider.
#[derive(Debug, Clone)]
pub struct ProviderTarget {
    pub api_key: Option<String>,
    pub model: Model,
    pub service_tier: Option<pa_types::ai::ServiceTier>,
    /// The auth-resolved request headers (the registry's merged headers —
    /// the auth storage's provider headers such as `X-Prime-Team-ID`,
    /// plus models.json provider headers): the single-owner path the TS
    /// routes through `getApiKeyAndHeaders` (TS #2497 removed the
    /// provider-side team-header fallback; the merged headers ship here).
    pub headers: std::collections::HashMap<String, String>,
}

/// A real pa-ai provider stream adapter for the agent loop, reading its
/// target from a shared slot the host can swap live (`set_model`, provider
/// failover). The slot is `None` only before the host sets the build-time
/// target; the adapter never runs before that.
pub fn switchable_stream_fn(target: Arc<std::sync::RwLock<Option<ProviderTarget>>>) -> StreamFn {
    Arc::new(
        move |_requested: AgentModel, context: LlmContext, options: StreamRequestOptions| {
            let ProviderTarget {
                api_key,
                model,
                service_tier,
                headers,
            } = target
                .read()
                .expect("provider target lock")
                .clone()
                .expect("provider target set before the first stream");
            Box::pin(
                async move { stream_once(model, api_key, service_tier, headers, context, options) },
            )
        },
    )
}

/// Stream one completion against `model` with `api_key` and the
/// auth-resolved request `headers`.
fn stream_once(
    model: Model,
    api_key: Option<String>,
    service_tier: Option<pa_types::ai::ServiceTier>,
    headers: std::collections::HashMap<String, String>,
    context: LlmContext,
    options: StreamRequestOptions,
) -> anyhow::Result<Box<dyn ModelStream>> {
    let messages: Vec<pa_types::ai::Message> = context
        .messages
        .iter()
        .filter_map(json_round_trip)
        .collect();
    let tools: Vec<pa_types::ai::Tool> = context.tools.iter().filter_map(json_round_trip).collect();
    let ai_context = pa_types::ai::Context {
        system_prompt: context.system_prompt,
        messages,
        tools: Some(tools),
    };
    // The turn's abort signal reaches the transport (TS passes the run's
    // AbortController signal into the stream options, so the fetch itself
    // cancels): the in-flight request races this token, and the loop's
    // abort paths fire it through [`ModelStream::close`] (TS
    // `closeIterator`) or the stream's drop, long before the response
    // would settle on its own.
    let cancel = tokio_util::sync::CancellationToken::new();
    let stream_options = pa_ai::types::SimpleStreamOptions {
        base: pa_ai::types::StreamOptions {
            temperature: options.temperature,
            max_tokens: options.max_tokens,
            signal: Some(cancel.clone()),
            api_key,
            transport: None,
            service_tier,
            cache_retention: None,
            session_id: options.session_id.clone(),
            on_payload: None,
            on_response: None,
            headers: (!headers.is_empty()).then(|| headers),
            metadata: None,
            timeout_ms: None,
        },
        reasoning: Some(model_thinking_level(options.reasoning)),
        thinking_budgets: None,
    };
    let stream = pa_ai::stream_simple(&model, &ai_context, Some(stream_options))
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    // Pump pa-ai events into a pa-agent event stream (the loop's
    // ModelStream): each provider event is forwarded verbatim.
    let (handle, consumer) = pa_agent::stream::event_stream();
    let forwarder = tokio::spawn(async move {
        let mut stream = stream;
        while let Some(event) = stream.next_event().await {
            if let Some(converted) = convert_stream_event(&event) {
                handle.push(converted);
            }
        }
        let result = stream.result().await;
        if let Some(converted) = json_round_trip::<_, pa_agent::types::AssistantMessage>(&result) {
            handle.end(Some(converted));
        } else {
            handle.end(None);
        }
    });
    // Keep the pump task alive as long as the stream lives.
    let (forwarder, consumer) = (forwarder, consumer);
    Ok(consumer_pump(forwarder, consumer, cancel))
}

/// A stream adapter pinned to one target: the headless runtimes (print and
/// json modes) resolve their model once, so the slot never changes.
pub fn real_stream_fn(api_key: Option<String>, model: Model) -> StreamFn {
    switchable_stream_fn(Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
        api_key,
        model,
        service_tier: None,
        headers: Default::default(),
    }))))
}

/// Convert one pa-ai stream event into the pa-agent loop's event enum.
/// Payloads cross the boundary by wire-shape (JSON) round-trip.
pub fn convert_stream_event(
    event: &pa_types::ai::AssistantMessageEvent,
) -> Option<pa_agent::stream::AssistantMessageEvent> {
    use pa_agent::stream::AssistantMessageEvent as Out;
    use pa_types::ai::AssistantMessageEvent as In;
    fn convert_partial(
        message: &pa_types::ai::AssistantMessage,
    ) -> pa_agent::types::AssistantMessage {
        json_round_trip(message).expect("assistant wire shapes match")
    }
    Some(match event {
        In::Start { partial } => Out::Start {
            partial: convert_partial(partial),
        },
        In::TextStart {
            content_index,
            partial,
        } => Out::TextStart {
            content_index: *content_index as usize,
            partial: convert_partial(partial),
        },
        In::TextDelta {
            content_index,
            delta,
            partial,
        } => Out::TextDelta {
            content_index: *content_index as usize,
            delta: delta.clone(),
            partial: convert_partial(partial),
        },
        In::TextEnd {
            content_index,
            content,
            partial,
        } => Out::TextEnd {
            content_index: *content_index as usize,
            content: content.clone(),
            partial: convert_partial(partial),
        },
        In::ThinkingStart {
            content_index,
            partial,
        } => Out::ThinkingStart {
            content_index: *content_index as usize,
            partial: convert_partial(partial),
        },
        In::ThinkingDelta {
            content_index,
            delta,
            partial,
        } => Out::ThinkingDelta {
            content_index: *content_index as usize,
            delta: delta.clone(),
            partial: convert_partial(partial),
        },
        In::ThinkingEnd {
            content_index,
            partial,
            ..
        } => Out::ThinkingEnd {
            content_index: *content_index as usize,
            partial: convert_partial(partial),
        },
        In::ToolcallStart {
            content_index,
            partial,
        } => Out::ToolCallStart {
            content_index: *content_index as usize,
            partial: convert_partial(partial),
        },
        In::ToolcallDelta {
            content_index,
            delta,
            partial,
        } => Out::ToolCallDelta {
            content_index: *content_index as usize,
            delta: delta.clone(),
            partial: convert_partial(partial),
        },
        In::ToolcallEnd {
            content_index,
            tool_call,
            partial,
        } => Out::ToolCallEnd {
            content_index: *content_index as usize,
            tool_call: json_round_trip(tool_call).expect("tool call wire shapes match"),
            partial: convert_partial(partial),
        },
        In::Done { reason, message } => Out::Done {
            reason: json_round_trip(reason).expect("stop reason wire shapes match"),
            message: convert_partial(message),
        },
        In::Error { reason, error } => Out::Error {
            reason: json_round_trip(reason).expect("stop reason wire shapes match"),
            error: convert_partial(error),
        },
    })
}

/// Wrap the consumer so the pump task is aborted when the stream drops.
fn consumer_pump(
    forwarder: tokio::task::JoinHandle<()>,
    consumer: pa_agent::stream::AssistantMessageEventStream,
    cancel: tokio_util::sync::CancellationToken,
) -> Box<dyn ModelStream> {
    Box::new(PumpedStream {
        _forwarder: forwarder,
        stream: consumer,
        cancel,
    })
}

/// A ModelStream whose lifetime keeps the pa-ai pump task alive and owns
/// the fetch's cancellation token (the transport half of the turn-abort:
/// the token cancels the in-flight request exactly where TS's fetch
/// AbortSignal fires).
struct PumpedStream {
    _forwarder: tokio::task::JoinHandle<()>,
    stream: pa_agent::stream::AssistantMessageEventStream,
    cancel: tokio_util::sync::CancellationToken,
}

impl Drop for PumpedStream {
    fn drop(&mut self) {
        // A dropped consumer stops reading events, so the in-flight fetch
        // behind the pump cancels instead of running to completion
        // detached (TS: the fetch dies with its iterator).
        self.cancel.cancel();
    }
}

impl ModelStream for PumpedStream {
    fn next_event(
        &mut self,
    ) -> pa_agent::BoxFut<'_, Option<pa_agent::stream::AssistantMessageEvent>> {
        self.stream.next_event()
    }

    fn result(
        &mut self,
    ) -> pa_agent::BoxFut<'_, anyhow::Result<pa_agent::types::AssistantMessage>> {
        self.stream.result()
    }

    /// Close/cancel the underlying stream (TS `iterator.return()` passed as
    /// `closeIterator` to the abort race): the in-flight fetch cancels
    /// immediately. Idempotent — the token's cancelled state is sticky.
    fn close(&mut self) {
        self.cancel.cancel();
    }
}

#[cfg(test)]
mod tests {
    //! Regression guard for the pa-agent -> pa-ai message boundary: the wire
    //! round-trip must keep user messages. `UserPart` must stay `type`-tagged
    //! like the TS wire format; an untagged variant serializes parts without
    //! `"type"`, the pa-ai shape rejects them, and `real_stream_fn` silently
    //! dropped every prompt admitted via `AgentPromptInput::Text` (content
    //! parts), leaving the provider with a system prompt only.

    use super::*;

    #[tokio::test]
    async fn live_target_service_tier_reaches_provider_and_reset() {
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("restored-service-tier-test".to_owned()),
                ..Default::default()
            });
        let received = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = received.clone();
        let factory =
            pa_ai::faux::FauxResponseStep::Factory(Arc::new(move |_, options, _, model| {
                captured.lock().unwrap().push((
                    model.id.clone(),
                    options.and_then(|options| options.service_tier),
                ));
                Ok(pa_ai::faux::faux_assistant_text_message(
                    "ok",
                    Default::default(),
                ))
            }));
        registration.set_responses(vec![factory.clone(), factory]);
        let model = registration.get_model();
        let target = Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
            api_key: None,
            model: model.clone(),
            service_tier: Some(pa_types::ai::ServiceTier::Priority),
        })));
        let stream_fn = switchable_stream_fn(target.clone());
        for tier in [Some(pa_types::ai::ServiceTier::Priority), None] {
            target.write().unwrap().as_mut().unwrap().service_tier = tier;
            let mut stream = stream_fn(
                AgentModel::unknown(),
                LlmContext::default(),
                StreamRequestOptions::default(),
            )
            .await
            .unwrap();
            stream.result().await.unwrap();
        }
        assert_eq!(
            *received.lock().unwrap(),
            vec![
                (model.id.clone(), Some(pa_types::ai::ServiceTier::Priority)),
                (model.id, None),
            ]
        );
        registration.unregister();
    }

    #[test]
    fn prompt_text_message_round_trips() {
        let message = pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::User(
            pa_agent::types::UserMessage {
                content: pa_agent::types::UserContent::Parts(vec![
                    pa_agent::types::UserPart::Text(pa_agent::types::TextContent {
                        text: "reply with ok".into(),
                        text_signature: None,
                    }),
                ]),
                timestamp: 1,
            },
        ));
        let converted: Option<pa_types::ai::Message> = json_round_trip(&message);
        assert_eq!(
            converted,
            Some(pa_types::ai::Message::User(pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Blocks(vec![
                    pa_types::ai::UserContentBlock::Text(pa_types::ai::TextContent {
                        text: "reply with ok".into(),
                        text_signature: None,
                        rest: Default::default(),
                    }),
                ]),
                timestamp: 1,
                rest: Default::default(),
            }))
        );
    }

    /// Regression guard for the pa-ai -> pa-agent boundary: provider
    /// signatures (`thinkingSignature`, `thoughtSignature`, `textSignature`)
    /// must survive the wire-shape round-trip. pa-agent has no catch-all
    /// field, so a key-casing mismatch silently dropped them — an
    /// unsigned thinking block degraded to plain text in the next
    /// provider request (see the anthropic convert), and a Rust-written
    /// session lost the signature TS-written ones carry.
    #[test]
    fn provider_signatures_round_trip_both_directions() {
        let thinking = pa_types::ai::ThinkingContent {
            thinking: "trace".into(),
            thinking_signature: Some("sig-1".into()),
            redacted: None,
            rest: Default::default(),
        };
        let wire = serde_json::to_value(&thinking).unwrap();
        assert_eq!(
            wire.get("thinkingSignature").and_then(|v| v.as_str()),
            Some("sig-1"),
            "the TS wire key is camelCase: {wire}"
        );
        // pa-ai stream output -> the pa-agent loop's message form.
        let agent_thinking: pa_agent::types::ThinkingContent =
            serde_json::from_value(wire).unwrap();
        assert_eq!(agent_thinking.thinking_signature.as_deref(), Some("sig-1"));
        // The loop's message -> the provider-facing pa-ai form again.
        let back: pa_types::ai::ThinkingContent =
            serde_json::from_value(serde_json::to_value(&agent_thinking).unwrap()).unwrap();
        assert_eq!(back.thinking_signature.as_deref(), Some("sig-1"));
        // The tool-call thought signature (Google) rides the same boundary.
        let tool_call = pa_types::ai::ToolCall {
            id: "toolu_1".into(),
            name: "bash".into(),
            arguments: serde_json::Map::new(),
            thought_signature: Some("sig-2".into()),
            rest: Default::default(),
        };
        let wire = serde_json::to_value(&tool_call).unwrap();
        assert_eq!(
            wire.get("thoughtSignature").and_then(|v| v.as_str()),
            Some("sig-2"),
            "the TS wire key is camelCase: {wire}"
        );
        let agent_tool_call: pa_agent::types::ToolCall = serde_json::from_value(wire).unwrap();
        assert_eq!(agent_tool_call.thought_signature.as_deref(), Some("sig-2"));
    }

    /// The turn-abort cancels the in-flight fetch at the seam: a delayed
    /// faux response holds the request mid-wait; `ModelStream::close`
    /// (the loop's `closeIterator` abort callback, fired the moment the
    /// run's signal aborts) cancels the fetch NOW, so the stream settles
    /// on the aborted message instead of waiting out the provider hold.
    #[tokio::test]
    async fn closing_the_stream_cancels_a_held_fetch_immediately() {
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("held-fetch-close-test".to_string()),
                ..Default::default()
            });
        let model = registration.get_model();
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Delayed {
            message: pa_ai::faux::faux_assistant_text_message(
                "held reply",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
            delay_ms: 60_000,
        }]);
        let target = Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
            api_key: None,
            model: model.clone(),
            service_tier: None,
        })));
        let stream_fn = switchable_stream_fn(target);
        let mut stream = stream_fn(
            pa_agent::types::Model::unknown(),
            LlmContext::default(),
            StreamRequestOptions::default(),
        )
        .await
        .expect("stream start");
        // The hold keeps the response pending; abort the turn (the agent
        // loop's close-on-abort path) mid-wait.
        stream.close();
        let settled = tokio::time::timeout(std::time::Duration::from_secs(5), stream.result())
            .await
            .expect("the closed stream settles immediately, not after the 60s hold")
            .expect("stream result");
        assert_eq!(settled.stop_reason, pa_agent::types::StopReason::Aborted);
        assert_eq!(
            settled.error_message.as_deref(),
            Some("Request was aborted")
        );
        // The aborted turn records no usage (TS EMPTY_USAGE on a mid-wait
        // abort: no partial message ever streamed).
        let usage = settled.usage;
        assert_eq!(usage.total_tokens, 0);
        assert_eq!(usage.input, 0);
        assert_eq!(usage.output, 0);
        assert_eq!(usage.cost.total, 0.0);
        registration.unregister();
    }
}
