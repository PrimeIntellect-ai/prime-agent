//! Real-provider stream adapter: pa-ai completion streaming bridged into
//! the pa-agent loop's `StreamFn`/`ModelStream`, crossing the crate
//! boundary by wire-shape (JSON) round-trip; shared by pa-cli and
//! pa-daemon.

use std::sync::Arc;

use pa_agent::stream::{LlmContext, ModelStream, StreamFn, StreamRequestOptions};
use pa_agent::types::{Model as AgentModel, ThinkingLevel};
use pa_types::ai::Model;

/// Wire-shape conversion at the pa-agent/pa-ai boundary: both sides
/// serialize to the same camelCase wire shapes.
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
#[must_use]
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
#[must_use]
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

/// Adapt the loop-level payload hook to the pa-ai hook shape. A failed
/// round-trip keeps the payload unchanged — hooks never fail the request.
fn agent_payload_hook_to_ai(hook: pa_agent::stream::OnPayloadHook) -> pa_ai::types::OnPayloadHook {
    std::sync::Arc::new(move |payload: serde_json::Value, model: &Model| {
        match json_round_trip::<_, pa_agent::types::Model>(model) {
            Some(agent_model) => hook(payload, &agent_model),
            None => Some(payload),
        }
    })
}

/// Adapt the loop-level response hook to the pa-ai hook shape; a failed
/// round-trip drops the hook call (advisory, never fatal).
fn agent_response_hook_to_ai(
    hook: pa_agent::stream::OnResponseHook,
) -> pa_ai::types::OnResponseHook {
    std::sync::Arc::new(
        move |response: pa_ai::types::ProviderResponse, model: &Model| {
            let agent_response = pa_agent::stream::ProviderResponse {
                status: response.status,
                headers: response.headers,
            };
            if let Some(agent_model) = json_round_trip::<_, pa_agent::types::Model>(model) {
                hook(agent_response, &agent_model);
            }
        },
    )
}

/// The mutable provider target a live session's stream reads per call
/// (daemon `set_model` and the failover switch swap it).
#[derive(Debug, Clone)]
pub struct ProviderTarget {
    pub api_key: Option<String>,
    pub model: Model,
    pub service_tier: Option<pa_types::ai::ServiceTier>,
    /// The auth-resolved provider-request headers: a live `set_model` carries
    /// them through to the stream like the build-time resolution does.
    pub headers: Option<std::collections::BTreeMap<String, String>>,
}

/// A real pa-ai stream adapter reading its target from a shared slot the host can swap live
/// (`set_model`, failover); `None` only before the host sets the build-time target.
///
/// # Panics
///
/// Panics at stream time if the provider target lock is poisoned, or if the
/// target slot was never set before the first stream.
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
            Box::pin(async move {
                stream_once(&model, api_key, service_tier, headers, context, options)
            })
        },
    )
}

/// Resolves request auth at stream time, per provider call. The daemon wires
/// this to the credential store's refreshing lookup so a rotated credential
/// (a `/login` from another process) or an expired OAuth token (refreshed in
/// place) reaches the live session's next request without a restart.
///
/// The resolver is synchronous by contract: it reads auth.json, may run a
/// `!command` credential, and may refresh an expired token at its endpoint —
/// the stream runs it off the executor and under the turn's abort signal.
///
/// The resolution is the registry's own [`crate::models::ResolvedRequestAuth`]:
/// `request_model` carries the per-call request model (TS `requestModel`).
pub type LiveAuthResolver = Arc<dyn Fn(&Model) -> crate::models::ResolvedRequestAuth + Send + Sync>;

/// [`switchable_stream_fn`] plus the per-request auth re-resolution the TS
/// session stream performs on every call (`getApiKeyAndHeaders` inside its
/// `streamFn`, v0.9.8 sdk.ts:301-313): the slot keeps the model and the
/// service tier, and the resolution is the call's whole request auth. A
/// resolution that cannot serve fails the call with its auth error; a
/// resolution that serves sends its own answer — the live credential, or
/// the configured `models.json` fallback key when no credential serves,
/// exactly the TS resolution's own fallback arm. A captured pair never
/// resends: re-serving the credential pinned at session start is the
/// stale-token loop this seam exists to end.
///
/// The resolution runs inside the returned future on a blocking thread, so
/// auth-file reads, `!command` spawns, and an OAuth refresh never block the
/// executor or the abort race: a turn abort settles the stream immediately —
/// never after the refresh — and the provider request is never admitted
/// after the abort.
///
/// # Panics
///
/// Panics at stream time if the provider target lock is poisoned or the
/// target slot was never set before the first stream.
pub fn switchable_stream_fn_with_live_auth(
    target: Arc<std::sync::RwLock<Option<ProviderTarget>>>,
    live_auth: LiveAuthResolver,
) -> StreamFn {
    Arc::new(
        move |_requested: AgentModel, context: LlmContext, options: StreamRequestOptions| {
            let target = Arc::clone(&target);
            let live_auth = Arc::clone(&live_auth);
            Box::pin(async move {
                let mut target_value = target
                    .read()
                    .expect("provider target lock")
                    .clone()
                    .expect("provider target set before the first stream");
                // The resolution is blocking I/O (an auth-file read, a
                // `!command` spawn, an OAuth refresh): run it off the
                // executor and race it with the turn's abort signal, so a
                // Stop settles the stream immediately and the provider
                // request is never admitted after the abort.
                let signal = options.signal.clone();
                let resolve_model = target_value.model.clone();
                let resolution = tokio::task::spawn_blocking(move || live_auth(&resolve_model));
                let resolved = tokio::select! {
                    resolved = resolution => {
                        // A panicking resolver fails this call only; the
                        // next call resolves afresh.
                        resolved.map_err(|error| {
                            anyhow::anyhow!("request auth resolution failed: {error}")
                        })?
                    }
                    () = signal.aborted() => return Err(pa_agent::abort::aborted_error()),
                };
                if signal.is_aborted() {
                    return Err(pa_agent::abort::aborted_error());
                }
                if !resolved.ok {
                    // The TS streamFn throws the resolution's auth error
                    // (v0.9.8 sdk.ts:303-305): the call fails, the next
                    // call re-resolves — a captured pair never rescues it.
                    return Err(anyhow::anyhow!(resolved
                        .error
                        .unwrap_or_else(|| "request auth resolution failed".to_string())));
                }
                // The resolution's own answer serves: its api key (a live
                // credential or the configured fallback key — never a
                // captured pair), its headers, and the per-call request
                // model when it carries one.
                if let Some(model) = resolved.request_model {
                    target_value.model = model;
                }
                target_value.api_key = resolved.api_key;
                target_value.headers = resolved.headers;
                let ProviderTarget {
                    api_key,
                    model,
                    service_tier,
                    headers,
                } = target_value;
                stream_once(&model, api_key, service_tier, headers, context, options)
            })
        },
    )
}

/// Stream one completion against `model` with `api_key` and the auth-resolved
/// request `headers`: the per-request tail the switchable seams and the CLI's
/// route-authoritative variant share.
///
/// # Errors
///
/// Returns the provider stream's error when the request fails (the
/// per-attempt failures the retry driver classifies).
pub fn stream_once(
    model: &Model,
    api_key: Option<String>,
    service_tier: Option<pa_types::ai::ServiceTier>,
    headers: Option<std::collections::BTreeMap<String, String>>,
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
    // The turn's abort signal reaches the transport: the in-flight request races this
    // token; the loop's abort paths fire it through [`ModelStream::close`] or the drop.
    let cancel = tokio_util::sync::CancellationToken::new();
    let stream_options = pa_ai::types::SimpleStreamOptions {
        base: pa_ai::types::StreamOptions {
            temperature: options.temperature,
            max_tokens: options.max_tokens,
            signal: Some(cancel.clone()),
            api_key,
            // A request that pins its transport (side questions ride SSE so they stay off the
            // session's Codex socket and its continuation) carries it through.
            transport: options.transport.as_ref().and_then(json_round_trip),
            service_tier,
            cache_retention: None,
            session_id: options.session_id.clone(),
            // The loop-level request hooks cross the crate boundary here: the payload
            // hook may replace the wire payload, the response hook observes headers.
            on_payload: options.on_payload.map(agent_payload_hook_to_ai),
            on_response: options.on_response.map(agent_response_hook_to_ai),
            // StreamOptions carries a plain map; the target's ordered
            // (BTreeMap) resolution converts here, with the request's own
            // headers (the semantic request id) merged over it — TS
            // providers' `mergeHeaders(..., optionsHeaders)` order, the
            // options win.
            headers: {
                let mut merged = headers;
                if let Some(request_headers) = options.headers.clone() {
                    merged
                        .get_or_insert_with(std::collections::BTreeMap::new)
                        .extend(request_headers);
                }
                merged.map(|headers| headers.into_iter().collect())
            },
            metadata: None,
            timeout_ms: None,
        },
        reasoning: Some(model_thinking_level(options.reasoning)),
        thinking_budgets: None,
    };
    let stream = pa_ai::stream_simple(model, &ai_context, Some(stream_options))
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    // Pump pa-ai events into the loop's event stream, verbatim.
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

/// A stream adapter pinned to one target (headless runtimes resolve
/// their model once, so the slot never changes).
#[must_use]
pub fn real_stream_fn(api_key: Option<String>, model: Model) -> StreamFn {
    switchable_stream_fn(Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
        api_key,
        model,
        service_tier: None,
        headers: None,
    }))))
}

/// Convert one pa-ai stream event into the pa-agent loop's event enum.
/// Payloads cross the boundary by wire-shape (JSON) round-trip.
///
/// # Panics
///
/// Panics when an assistant message cannot round-trip across the two
/// crates' wire shapes (a structural shape-mismatch bug).
#[must_use]
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

/// A `ModelStream` whose lifetime keeps the pa-ai pump task alive and owns
/// the fetch's cancellation token (the transport half of the turn-abort).
struct PumpedStream {
    _forwarder: tokio::task::JoinHandle<()>,
    stream: pa_agent::stream::AssistantMessageEventStream,
    cancel: tokio_util::sync::CancellationToken,
}

impl Drop for PumpedStream {
    fn drop(&mut self) {
        // The in-flight fetch cancels instead of running to completion
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

    /// Close/cancel: the in-flight fetch cancels immediately. Idempotent
    /// — the token's cancelled state is sticky.
    fn close(&mut self) {
        self.cancel.cancel();
    }
}

#[cfg(test)]
mod tests {
    //! Regression guard for the pa-agent -> pa-ai message boundary: `UserPart`
    //! must stay `type`-tagged like the TS wire format; an untagged variant
    //! silently dropped every `AgentPromptInput::Text` prompt, leaving the
    //! provider with a system prompt only.

    use super::*;
    use crate::models::ResolvedRequestAuth;

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
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            }));
        registration.set_responses(vec![factory.clone(), factory]);
        let model = registration.get_model();
        let target = Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
            api_key: None,
            model: model.clone(),
            service_tier: Some(pa_types::ai::ServiceTier::Priority),
            headers: None,
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

    #[tokio::test]
    async fn a_panicking_live_auth_resolution_fails_only_its_call() {
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("live-auth-panic-test".to_owned()),
                ..Default::default()
            });
        registration.set_repeat_last_response(true);
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "ok",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let target = Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
            api_key: None,
            model: registration.get_model(),
            service_tier: None,
            headers: None,
        })));
        let resolutions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let live_auth: LiveAuthResolver = Arc::new(move |_: &Model| {
            if resolutions.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                panic!("the first resolution panics");
            }
            ResolvedRequestAuth {
                ok: true,
                api_key: Some("live-key".to_string()),
                ..Default::default()
            }
        });
        let stream_fn = switchable_stream_fn_with_live_auth(target, live_auth);
        let call = || {
            stream_fn(
                AgentModel::unknown(),
                LlmContext::default(),
                StreamRequestOptions::default(),
            )
        };
        assert!(
            call().await.is_err(),
            "the panicked resolution fails its call"
        );
        let mut stream = call().await.expect("the next call resolves afresh");
        stream.result().await.unwrap();
        assert_eq!(
            registration.received_api_keys(),
            vec![Some("live-key".to_string())]
        );
        registration.unregister();
    }

    #[tokio::test]
    async fn live_auth_serves_the_resolution_per_call_and_never_resends_a_captured_pair() {
        // One served (api key, headers) pair per provider call.
        type ServedAuth = (
            Option<String>,
            Option<std::collections::HashMap<String, String>>,
        );
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("live-auth-seam-test".to_owned()),
                ..Default::default()
            });
        let received: Arc<std::sync::Mutex<Vec<ServedAuth>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = Arc::clone(&received);
        let factory = pa_ai::faux::FauxResponseStep::Factory(Arc::new(move |_, options, _, _| {
            captured.lock().unwrap().push((
                options.and_then(|options| options.api_key.clone()),
                options.and_then(|options| options.headers.clone()),
            ));
            Ok(pa_ai::faux::faux_assistant_text_message(
                "ok",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ))
        }));
        registration.set_repeat_last_response(true);
        registration.set_responses(vec![factory]);
        let model = registration.get_model();
        let target = Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
            api_key: Some("stale-access".to_string()),
            model: model.clone(),
            service_tier: None,
            // The captured pair carries a team header: a fresh
            // credential WITHOUT one must clear it, not keep serving it
            // on the new key (a re-login from a team key to a personal
            // key leaves no X-Prime-Team-ID behind).
            headers: Some(std::collections::BTreeMap::from([(
                "X-Prime-Team-ID".to_string(),
                "team-old".to_string(),
            )])),
        })));
        // The scripted resolutions, served one per provider call: a
        // resolution that serves no key (a logout with no configured
        // fallback), a fresh rotated credential (with a team header), a
        // fresh credential carrying NO header (the captured header must
        // clear, not linger on the new key), and the `models.json`
        // fallback key (a key that is not a credential, but it IS the
        // resolution's answer — TS serves it when no credential serves).
        // Each entry is a shape the registry produces.
        let queue: Arc<std::sync::Mutex<std::collections::VecDeque<ResolvedRequestAuth>>> =
            Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from(
                vec![
                    ResolvedRequestAuth {
                        ok: true,
                        api_key: None,
                        headers: None,
                        error: None,
                        request_model: None,
                    },
                    ResolvedRequestAuth {
                        ok: true,
                        api_key: Some("fresh-access".to_string()),
                        headers: Some(std::collections::BTreeMap::from([(
                            "X-Prime-Team-ID".to_string(),
                            "team-1".to_string(),
                        )])),
                        error: None,
                        request_model: None,
                    },
                    ResolvedRequestAuth {
                        ok: true,
                        api_key: Some("fresh-access-2".to_string()),
                        headers: None,
                        error: None,
                        request_model: None,
                    },
                    ResolvedRequestAuth {
                        ok: true,
                        api_key: Some("sk-config-fallback".to_string()),
                        headers: None,
                        error: None,
                        request_model: None,
                    },
                ],
            )));
        let consulted: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let resolver_queue = Arc::clone(&queue);
        let resolver_consulted = Arc::clone(&consulted);
        let live_auth: LiveAuthResolver = Arc::new(move |model: &Model| {
            resolver_consulted.lock().unwrap().push(model.id.clone());
            resolver_queue
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_default()
        });
        let stream_fn = switchable_stream_fn_with_live_auth(target, live_auth);
        for (expected_key, expected_header) in [
            // No key resolves: the call streams keyless — the captured
            // pair (its key and its team header) never resends.
            (None, None),
            (Some("fresh-access"), Some("team-1")),
            // The fresh credential carries no header: the captured team
            // header clears — it must not linger on the new key.
            (Some("fresh-access-2"), None),
            // The configured `models.json` fallback key is the
            // resolution's answer: it serves per call, never the
            // captured pair.
            (Some("sk-config-fallback"), None),
        ] {
            let mut stream = stream_fn(
                AgentModel::unknown(),
                LlmContext::default(),
                StreamRequestOptions::default(),
            )
            .await
            .expect("the stream call succeeds");
            stream.result().await.expect("the stream settles");
            let (api_key, headers) = received
                .lock()
                .unwrap()
                .last()
                .cloned()
                .expect("the factory ran");
            assert_eq!(api_key.as_deref(), expected_key, "the served api key");
            assert_eq!(
                headers
                    .as_ref()
                    .and_then(|headers| headers.get("X-Prime-Team-ID").map(String::as_str)),
                expected_header,
                "the served headers: {headers:?}"
            );
        }
        // A resolution that fails (no usable credential, an unreadable
        // store) fails the call with its auth error — the TS streamFn
        // throws it (v0.9.8 sdk.ts:303-305) — and the captured pair never
        // rescues the call.
        queue.lock().unwrap().push_back(ResolvedRequestAuth {
            ok: false,
            api_key: None,
            headers: None,
            error: Some("No API key found for \"battery\"".to_string()),
            request_model: None,
        });
        let Err(error) = stream_fn(
            AgentModel::unknown(),
            LlmContext::default(),
            StreamRequestOptions::default(),
        )
        .await
        else {
            panic!("a failed resolution fails the call")
        };
        assert!(
            error.to_string().contains("No API key found"),
            "the call carries the resolution's auth error: {error}"
        );
        assert_eq!(
            received.lock().unwrap().len(),
            4,
            "the failed call admits no provider request"
        );
        // Every consultation was for the slot's serving model.
        assert_eq!(*consulted.lock().unwrap(), vec![model.id.clone(); 5]);
        registration.unregister();
    }

    /// A resolution that carries a request model (TS `requestModel`: the
    /// xAI request shape follows the credential the resolution serves)
    /// adopts it on the provider call — a live credential or the fallback
    /// key alike; a resolution without one keeps the target's model.
    #[tokio::test]
    async fn live_auth_adopts_a_serving_request_model() {
        // The adapted request model rides a test-only api registered for
        // this test alone: a unique registration is never replaced by
        // `resolve_provider`'s one-time `ensure_builtins` (which
        // re-registers the built-in api names) and no other test's
        // dispatch shares it; the faux records its calls without any
        // network, exactly like the daemon's xai-shape test.
        let adapted_api = "live-auth-adapted-request-model-test".to_string();
        let adapted_registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some(adapted_api.clone()),
                ..Default::default()
            });
        let received: Arc<std::sync::Mutex<Vec<(String, String)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured_adapted = Arc::clone(&received);
        adapted_registration.set_repeat_last_response(true);
        adapted_registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(Arc::new(
            move |_, _options, _, model| {
                captured_adapted
                    .lock()
                    .unwrap()
                    .push((model.id.clone(), model.api.clone()));
                Ok(pa_ai::faux::faux_assistant_text_message(
                    "ok",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            },
        ))]);
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("live-auth-request-model-test".to_owned()),
                ..Default::default()
            });
        let captured = Arc::clone(&received);
        let factory =
            pa_ai::faux::FauxResponseStep::Factory(Arc::new(move |_, _options, _, model| {
                captured
                    .lock()
                    .unwrap()
                    .push((model.id.clone(), model.api.clone()));
                Ok(pa_ai::faux::faux_assistant_text_message(
                    "ok",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ))
            }));
        registration.set_repeat_last_response(true);
        registration.set_responses(vec![factory]);
        let slot_model = registration.get_model();
        let mut adapted_model = slot_model.clone();
        adapted_model.id = "adapted-grok".to_string();
        adapted_model.api = adapted_api.clone();
        let target = Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
            api_key: Some("stale-access".to_string()),
            model: slot_model.clone(),
            service_tier: None,
            headers: None,
        })));
        let queue: Arc<std::sync::Mutex<std::collections::VecDeque<ResolvedRequestAuth>>> =
            Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from(
                vec![
                    ResolvedRequestAuth {
                        ok: true,
                        api_key: Some("fresh-access".to_string()),
                        headers: None,
                        error: None,
                        request_model: Some(adapted_model.clone()),
                    },
                    ResolvedRequestAuth {
                        ok: true,
                        api_key: Some("fresh-access".to_string()),
                        headers: None,
                        error: None,
                        request_model: None,
                    },
                    // A logged-out xAI store resolves no live credential
                    // WITH an API-key-shaped request model (the registry
                    // computes it regardless of the lookup): the resolution's
                    // answer serves per call — the fallback key rides the
                    // API-key shape, and a captured subscription token never
                    // does.
                    ResolvedRequestAuth {
                        ok: true,
                        api_key: Some("sk-config-fallback".to_string()),
                        headers: None,
                        error: None,
                        request_model: Some(adapted_model.clone()),
                    },
                ],
            )));
        let resolver_queue = Arc::clone(&queue);
        let live_auth: LiveAuthResolver = Arc::new(move |_model: &Model| {
            resolver_queue
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_default()
        });
        let stream_fn = switchable_stream_fn_with_live_auth(target, live_auth);
        for _ in 0..3 {
            let mut stream = stream_fn(
                AgentModel::unknown(),
                LlmContext::default(),
                StreamRequestOptions::default(),
            )
            .await
            .expect("the stream call succeeds");
            stream.result().await.expect("the stream settles");
        }
        // Call 1 adopted the served request model; call 2 (no request
        // model) kept the target's model; call 3's resolution carried no
        // live credential but a request model, and the resolution's
        // answer served — the fallback key on the API-key shape, never a
        // captured subscription token.
        assert_eq!(
            *received.lock().unwrap(),
            vec![
                ("adapted-grok".to_string(), adapted_api.clone()),
                (slot_model.id.clone(), slot_model.api.clone()),
                ("adapted-grok".to_string(), adapted_api.clone()),
            ]
        );
        registration.unregister();
        adapted_registration.unregister();
    }

    /// A turn abort during a held OAuth refresh settles the stream
    /// immediately — the abort error, never the refresh's completion —
    /// and the provider request is never admitted after the abort. The
    /// offloaded resolution still lands the refreshed credential, so the
    /// next call serves it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_during_a_held_refresh_returns_the_abort_error_and_serves_nothing() {
        struct HeldRefresh {
            entered: std::sync::mpsc::Sender<()>,
            release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
            completed: std::sync::Arc<std::sync::Mutex<bool>>,
        }
        impl pa_ai::oauth::ProviderHttp for HeldRefresh {
            fn request(
                &self,
                request: pa_ai::oauth::ProviderHttpRequest,
                _timeout_ms: u64,
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<pa_ai::oauth::ProviderHttpResponse, String>,
                        > + Send
                        + '_,
                >,
            > {
                assert_eq!(
                    request.url, "https://platform.claude.com/v1/oauth/token",
                    "the held transport serves the Anthropic token endpoint"
                );
                Box::pin(async move {
                    self.entered.send(()).expect("the abort observer lives");
                    self.release
                        .lock()
                        .expect("release channel")
                        .recv()
                        .expect("the test releases the refresh");
                    *self.completed.lock().expect("completed flag") = true;
                    Ok(pa_ai::oauth::ProviderHttpResponse {
                        status: 200,
                        body: r#"{"access_token":"fresh-access","refresh_token":"fresh-refresh","expires_in":3600}"#
                            .to_owned(),
                    })
                })
            }
        }
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let completed = std::sync::Arc::new(std::sync::Mutex::new(false));
        let http = std::sync::Arc::new(HeldRefresh {
            entered: entered_tx,
            release: std::sync::Mutex::new(release_rx),
            completed: std::sync::Arc::clone(&completed),
        });
        let integration: std::sync::Arc<dyn crate::auth::OAuthIntegration> =
            std::sync::Arc::new(crate::auth::ProviderOAuth::with_transports(
                std::sync::Arc::new(pa_ai::oauth::ReqwestCodexHttp::new()),
                http,
            ));
        let data = crate::auth::AuthStorageData(
            serde_json::json!({
                "anthropic": {
                    "type": "oauth", "access": "expired-access",
                    "refresh": "expired-refresh", "expires": 1
                }
            })
            .as_object()
            .expect("an object")
            .clone(),
        );
        let auth = crate::auth::AuthStorage::in_memory_without_env(&data, integration);
        let registry = std::sync::Arc::new(std::sync::Mutex::new(
            crate::models::ModelRegistry::in_memory(auth),
        ));
        let mut model = registry
            .lock()
            .expect("registry")
            .get_all()
            .iter()
            .find(|candidate| candidate.provider == crate::auth::ANTHROPIC_PROVIDER_ID)
            .expect("the catalog carries an Anthropic model")
            .clone();
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("live-auth-abort-test".to_owned()),
                ..Default::default()
            });
        registration.set_repeat_last_response(true);
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "ok",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        model.api = "live-auth-abort-test".to_string();
        let resolver_registry = std::sync::Arc::clone(&registry);
        let live_auth: LiveAuthResolver = Arc::new(move |model: &Model| {
            resolver_registry
                .lock()
                .expect("registry")
                .get_api_key_and_headers(model, model.headers.as_ref())
        });
        let target = Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
            model,
            api_key: Some("expired-access".to_string()),
            service_tier: None,
            headers: None,
        })));
        let stream_fn = switchable_stream_fn_with_live_auth(target, live_auth);
        let controller = pa_agent::abort::AbortController::new();
        let signal = controller.signal();
        let (ack_tx, ack_rx) = std::sync::mpsc::channel::<()>();
        let aborter = std::thread::spawn(move || {
            entered_rx
                .recv()
                .expect("the held refresh entered the token endpoint");
            controller.abort();
            // The test thread releases the held refresh right after its
            // still-held assertion, so nothing races the assertion. The
            // timeout covers a resolution that runs on the stream's own
            // thread (the abort cannot settle the call there before the
            // refresh completes): the release lands anyway, so the
            // assertions below fail instead of the suite hanging on the
            // held fetch.
            let _ = ack_rx.recv_timeout(std::time::Duration::from_secs(30));
            release_tx.send(()).expect("the release channel is open");
        });
        let outcome = pa_agent::abort::race_with_abort(
            stream_fn(
                AgentModel::unknown(),
                LlmContext::default(),
                StreamRequestOptions {
                    signal: signal.clone(),
                    ..Default::default()
                },
            ),
            &signal,
        )
        .await;
        // The refresh is STILL HELD here: the abort settled the stream
        // without waiting for it. The release follows this assertion in
        // causal order — the observer releases on the ack below, or on
        // its timeout escape — so a slow runner can never flip the flag
        // underneath the assertion.
        assert!(
            !*completed.lock().expect("completed flag"),
            "the abort settled the stream before the refresh completed"
        );
        ack_tx
            .send(())
            .expect("the ack channel is open; the assertion above ran first");
        aborter.join().expect("the abort observer");
        // Flatten the double Result like the production loop's race
        // (`agent_loop::abort::race_with_abort`): the seam's abort error
        // rides the stream future's own Result.
        let Err(error) = outcome.and_then(std::convert::identity) else {
            panic!("the turn abort must win over the held refresh")
        };
        assert!(pa_agent::abort::is_abort_error(&error));
        assert!(
            registration.received_api_keys().is_empty(),
            "no provider request is admitted after the abort"
        );
        // The offloaded resolution completed in the background and landed
        // the refreshed credential: the next provider call serves it.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let stored = registry
                .lock()
                .expect("registry")
                .auth
                .get_all()
                .credential(crate::auth::ANTHROPIC_PROVIDER_ID)
                .map(|credential| match credential {
                    crate::auth::AuthCredential::Oauth { access, .. } => access,
                    _ => String::new(),
                });
            if stored.as_deref() == Some("fresh-access") {
                break;
            }
            assert!(
                deadline > std::time::Instant::now(),
                "the offloaded refresh never landed: {stored:?}"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        registration.unregister();
    }

    /// The post-resolution abort re-check: the abort can land in the same
    /// instant the resolution completes — here the resolver itself fires
    /// the abort, then returns a serving pair — so the unbiased select
    /// sees both arms ready. Whichever arm wins, the seam must settle the
    /// call with the abort error and admit no provider request; the
    /// re-check is the only guard when the resolution arm wins. The loop
    /// runs the race a fixed 40 times (a single fair poll can hand either
    /// arm the win on each run), so the resolution arm gets many chances
    /// to win; the empty received-keys assertion fails a seam that admits
    /// the request on any resolution-arm win.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_abort_landing_with_the_resolution_never_admits_the_request() {
        const RUNS: usize = 40;
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("live-auth-recheck-test".to_owned()),
                ..Default::default()
            });
        registration.set_repeat_last_response(true);
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "ok",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        for _ in 0..RUNS {
            let controller = Arc::new(std::sync::Mutex::new(
                pa_agent::abort::AbortController::new(),
            ));
            let signal = controller.lock().unwrap().signal();
            let resolver_controller = Arc::clone(&controller);
            let resolver: LiveAuthResolver = Arc::new(move |_model| {
                resolver_controller.lock().unwrap().abort();
                ResolvedRequestAuth {
                    ok: true,
                    api_key: Some("fresh-after-abort".to_string()),
                    headers: None,
                    error: None,
                    request_model: None,
                }
            });
            let target = Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
                api_key: Some("captured-key".to_string()),
                model: registration.get_model(),
                service_tier: None,
                headers: None,
            })));
            let stream_fn = switchable_stream_fn_with_live_auth(target, resolver);
            let outcome = stream_fn(
                AgentModel::unknown(),
                LlmContext::default(),
                StreamRequestOptions {
                    signal: signal.clone(),
                    ..Default::default()
                },
            )
            .await;
            assert!(
                pa_agent::abort::is_abort_error(&outcome.err().expect("the abort error")),
                "the abort landing with the resolution settles the call"
            );
        }
        assert!(
            registration.received_api_keys().is_empty(),
            "no provider request is admitted after the abort"
        );
        registration.unregister();
    }

    /// The shared schedule for the detached-refresh store-change pins: a
    /// Stop during an OAuth refresh settles the stream immediately, but
    /// the offloaded resolution keeps
    /// running to completion. When a credential change lands meanwhile,
    /// the detached refresh's commit must keep it — the current entry,
    /// including deletion, stays authoritative and the fetched grant is
    /// discarded. Returns the agent dir (its tempdir kept alive) for the
    /// caller's store assertions.
    async fn an_aborted_refresh_keeps_a_concurrent_store_change(
        store_change: impl FnOnce(&std::path::Path) + Send + 'static,
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        struct HeldRefresh {
            entered: std::sync::mpsc::Sender<()>,
            release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl pa_ai::oauth::ProviderHttp for HeldRefresh {
            fn request(
                &self,
                request: pa_ai::oauth::ProviderHttpRequest,
                _timeout_ms: u64,
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<pa_ai::oauth::ProviderHttpResponse, String>,
                        > + Send
                        + '_,
                >,
            > {
                assert_eq!(
                    request.url, "https://platform.claude.com/v1/oauth/token",
                    "the held transport serves the Anthropic token endpoint"
                );
                Box::pin(async move {
                    self.entered.send(()).expect("the abort observer lives");
                    self.release
                        .lock()
                        .expect("release channel")
                        .recv()
                        .expect("the test releases the refresh");
                    Ok(pa_ai::oauth::ProviderHttpResponse {
                        status: 200,
                        body: r#"{"access_token":"refreshed-access","refresh_token":"rotated-refresh","expires_in":3600}"#
                            .to_owned(),
                    })
                })
            }
        }
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let integration: std::sync::Arc<dyn crate::auth::OAuthIntegration> =
            std::sync::Arc::new(crate::auth::ProviderOAuth::with_transports(
                std::sync::Arc::new(pa_ai::oauth::ReqwestCodexHttp::new()),
                std::sync::Arc::new(HeldRefresh {
                    entered: entered_tx,
                    release: std::sync::Mutex::new(release_rx),
                }),
            ));
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("auth.json"),
            r#"{"anthropic":{"type":"oauth","access":"expired-access","refresh":"old-refresh","expires":1}}"#,
        )
        .unwrap();
        let agent_dir = dir.path().to_path_buf();
        // A fresh store and registry per provider call, over the file the
        // test mutates.
        let resolver_dir = agent_dir.clone();
        let resolver_integration = std::sync::Arc::clone(&integration);
        let live_auth: LiveAuthResolver = Arc::new(move |model: &Model| {
            let auth = crate::auth::AuthStorage::create_with_oauth(
                &resolver_dir,
                std::sync::Arc::clone(&resolver_integration),
            );
            let mut registry =
                crate::models::ModelRegistry::create(auth, resolver_dir.join("models.json"));
            let resolved = registry.get_api_key_and_headers(model, model.headers.as_ref());
            finished_tx.send(()).expect("the finished observer lives");
            resolved
        });
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("live-auth-resurrection-test".to_owned()),
                ..Default::default()
            });
        registration.set_repeat_last_response(true);
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "ok",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let mut model = registration.get_model();
        model.provider = crate::auth::ANTHROPIC_PROVIDER_ID.to_string();
        let target = Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
            model,
            api_key: Some("expired-access".to_string()),
            service_tier: None,
            headers: None,
        })));
        let stream_fn = switchable_stream_fn_with_live_auth(target, live_auth);
        let controller = pa_agent::abort::AbortController::new();
        let signal = controller.signal();
        let aborter_dir = agent_dir.clone();
        let aborter = std::thread::spawn(move || {
            entered_rx
                .recv()
                .expect("the held refresh entered the token endpoint");
            controller.abort();
            // The credential change lands while the detached fetch is
            // held: the store is authoritative when it completes.
            store_change(&aborter_dir);
            release_tx.send(()).expect("the release channel is open");
        });
        let outcome = pa_agent::abort::race_with_abort(
            stream_fn(
                AgentModel::unknown(),
                LlmContext::default(),
                StreamRequestOptions {
                    signal: signal.clone(),
                    ..Default::default()
                },
            ),
            &signal,
        )
        .await;
        aborter.join().expect("the abort observer");
        let Err(error) = outcome.and_then(std::convert::identity) else {
            panic!("the turn abort must win over the held refresh")
        };
        assert!(pa_agent::abort::is_abort_error(&error));
        assert!(
            registration.received_api_keys().is_empty(),
            "no provider request is admitted after the abort"
        );
        // The detached resolution completed: its commit either kept the
        // store change (the guard) or overwrote it (the defect).
        finished_rx
            .recv()
            .expect("the detached resolution completes");
        registration.unregister();
        (dir, agent_dir)
    }

    /// A completed logout survives an aborted refresh that completes
    /// detached: the logged-out grant is never resurrected by the fetched
    /// token's commit.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_aborted_refresh_never_resurrects_a_logout() {
        let (_dir, agent_dir) = an_aborted_refresh_keeps_a_concurrent_store_change(|agent_dir| {
            crate::auth::AuthStorage::create(agent_dir).logout(crate::auth::ANTHROPIC_PROVIDER_ID);
        })
        .await;
        assert!(
            !crate::auth::AuthStorage::create(&agent_dir).has(crate::auth::ANTHROPIC_PROVIDER_ID),
            "logout must stay logged out after the aborted refresh completes: {}",
            std::fs::read_to_string(agent_dir.join("auth.json")).unwrap()
        );
    }

    /// A new API-key login survives an aborted refresh that completes
    /// detached: the stored key is never overwritten with the old grant.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_aborted_refresh_never_overwrites_a_new_api_key_login() {
        let (_dir, agent_dir) = an_aborted_refresh_keeps_a_concurrent_store_change(|agent_dir| {
            crate::auth::AuthStorage::create(agent_dir).set(
                crate::auth::ANTHROPIC_PROVIDER_ID,
                crate::auth::AuthCredential::ApiKey {
                    key: "new-login-key".to_string(),
                    prime_team: None,
                },
            );
        })
        .await;
        assert_eq!(
            crate::auth::AuthStorage::create(&agent_dir)
                .get_api_key(crate::auth::ANTHROPIC_PROVIDER_ID)
                .as_deref(),
            Some("new-login-key"),
            "the new API-key login must survive the aborted refresh: {}",
            std::fs::read_to_string(agent_dir.join("auth.json")).unwrap()
        );
    }

    #[tokio::test]
    async fn requested_transport_reaches_the_provider() {
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("requested-transport-test".to_owned()),
                ..Default::default()
            });
        let received = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = received.clone();
        let factory = pa_ai::faux::FauxResponseStep::Factory(Arc::new(move |_, options, _, _| {
            captured
                .lock()
                .unwrap()
                .push(options.and_then(|options| options.transport));
            Ok(pa_ai::faux::faux_assistant_text_message(
                "ok",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ))
        }));
        registration.set_responses(vec![factory.clone(), factory]);
        let model = registration.get_model();
        for transport in [Some(pa_agent::types::Transport::Sse), None] {
            let mut stream = stream_once(
                &model,
                None,
                None,
                None,
                LlmContext::default(),
                StreamRequestOptions {
                    transport,
                    ..Default::default()
                },
            )
            .unwrap();
            stream.result().await.unwrap();
        }
        assert_eq!(
            *received.lock().unwrap(),
            vec![Some(pa_types::ai::Transport::Sse), None]
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
                        rest: serde_json::Map::default(),
                    }),
                ]),
                timestamp: 1,
                rest: serde_json::Map::default(),
            }))
        );
    }

    /// Regression guard: provider signatures must survive the round-trip. pa-agent has no
    /// catch-all field, so a key-casing mismatch silently dropped them — a Rust-written
    /// session lost the signature TS-written ones carry.
    #[test]
    fn provider_signatures_round_trip_both_directions() {
        let thinking = pa_types::ai::ThinkingContent {
            thinking: "trace".into(),
            thinking_signature: Some("sig-1".into()),
            redacted: None,
            rest: serde_json::Map::default(),
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
            rest: serde_json::Map::default(),
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

    /// A delayed faux response holds the request mid-wait; `ModelStream::close` cancels the fetch
    /// NOW, so the stream settles on the aborted message instead of waiting out the hold.
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
            headers: None,
        })));
        let stream_fn = switchable_stream_fn(target);
        let mut stream = stream_fn(
            pa_agent::types::Model::unknown(),
            LlmContext::default(),
            StreamRequestOptions::default(),
        )
        .await
        .expect("stream start");
        // Abort the turn mid-wait.
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
        // No usage on a mid-wait abort (TS `EMPTY_USAGE`: no partial
        // message ever streamed).
        let usage = settled.usage;
        assert_eq!(usage.total_tokens, 0);
        assert_eq!(usage.input, 0);
        assert_eq!(usage.output, 0);
        assert_eq!(usage.cost.total, 0.0);
        registration.unregister();
    }
}
