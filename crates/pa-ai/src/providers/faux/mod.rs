//! Faux provider: deterministic in-process responses for tests and tooling.
//! Full port of `providers/faux.ts`, including usage estimation, per-session
//! prompt-cache simulation, token-paced streaming with aborts, and queued
//! response factories.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::event_stream::{
    create_assistant_message_event_stream, AssistantMessageEventStream, AssistantMessageEventWriter,
};
use crate::registry::{register_api_provider, unregister_api_providers, Provider};
use crate::types::{
    done_reason, error_reason, zero_model_cost, AssistantContent, AssistantMessage,
    AssistantMessageEvent, Context, ErrorStopReason, ImageContent, Message, MessageExt, Model,
    ModelCost, ModelInput, SimpleStreamOptions, StopReason, StreamOptions, TextContent,
    ThinkingContent, ToolCall, ToolResultMessage, Usage, UserMessageContent,
};
use crate::utils_inner::diagnostics::now_ms;
use rand::Rng;

const DEFAULT_API: &str = "faux";
const DEFAULT_PROVIDER: &str = "faux";
const DEFAULT_MODEL_ID: &str = "faux-1";
const DEFAULT_MODEL_NAME: &str = "Faux Model";
const DEFAULT_BASE_URL: &str = "http://localhost:0";
const DEFAULT_MIN_TOKEN_SIZE: usize = 3;
const DEFAULT_MAX_TOKEN_SIZE: usize = 5;

fn default_usage() -> Usage {
    Usage::default()
}

/// Model definition accepted by `register_faux_provider`.
#[derive(Debug, Clone, Default)]
pub struct FauxModelDefinition {
    pub id: String,
    pub name: Option<String>,
    pub reasoning: Option<bool>,
    pub input: Option<Vec<ModelInput>>,
    pub cost: Option<ModelCost>,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
}

pub fn faux_text(text: &str) -> AssistantContent {
    AssistantContent::Text(TextContent {
        text: text.to_string(),
        text_signature: None,
        rest: Default::default(),
    })
}

pub fn faux_thinking(thinking: &str) -> AssistantContent {
    AssistantContent::Thinking(ThinkingContent {
        thinking: thinking.to_string(),
        thinking_signature: None,
        redacted: None,
        rest: Default::default(),
    })
}

pub fn faux_tool_call(
    name: &str,
    arguments: serde_json::Value,
    id: Option<&str>,
) -> AssistantContent {
    AssistantContent::ToolCall(ToolCall {
        id: id.map_or_else(|| random_id("tool"), std::string::ToString::to_string),
        name: name.to_string(),
        arguments: arguments.as_object().cloned().unwrap_or_default(),
        thought_signature: None,
        rest: Default::default(),
    })
}

fn normalize_faux_assistant_content(content: String) -> Vec<AssistantContent> {
    vec![faux_text(&content)]
}

/// Build a faux assistant message from plain text (mirrors the TS
/// `fauxAssistantMessage` string overload).
pub fn faux_assistant_text_message(
    text: &str,
    options: FauxAssistantMessageOptions,
) -> AssistantMessage {
    faux_assistant_message(normalize_faux_assistant_content(text.to_string()), options)
}

/// Build a faux assistant message (helper mirroring `fauxAssistantMessage`).
pub fn faux_assistant_message(
    content: Vec<AssistantContent>,
    options: FauxAssistantMessageOptions,
) -> AssistantMessage {
    AssistantMessage {
        content,
        api: DEFAULT_API.to_string(),
        provider: DEFAULT_PROVIDER.to_string(),
        model: DEFAULT_MODEL_ID.to_string(),
        response_model: None,
        response_id: options.response_id,
        diagnostics: Some(Vec::new()),
        usage: default_usage(),
        stop_reason: options.stop_reason.unwrap_or(StopReason::Stop),
        stop_reason_raw: None,
        error_message: options.error_message,
        timestamp: options.timestamp.unwrap_or_else(now_ms),
        rest: Default::default(),
    }
}

#[derive(Debug, Clone, Default)]
pub struct FauxAssistantMessageOptions {
    pub stop_reason: Option<StopReason>,
    pub error_message: Option<String>,
    pub response_id: Option<String>,
    pub timestamp: Option<u64>,
}

/// Response step: a fixed message or a factory computing one per call.
pub type FauxResponseFactory = Arc<
    dyn Fn(&Context, Option<&StreamOptions>, u64, &Model) -> Result<AssistantMessage, String>
        + Send
        + Sync,
>;

#[derive(Clone)]
#[allow(clippy::large_enum_variant)] // the TS shape is a tagged union of the same payloads
pub enum FauxResponseStep {
    Message(AssistantMessage),
    /// A message whose stream starts after `delay_ms` (harness pacing: the
    /// delay holds the request in flight so verification harnesses can
    /// capture mid-turn states). Verification harness only.
    Delayed {
        message: AssistantMessage,
        delay_ms: u64,
    },
    Factory(FauxResponseFactory),
}

/// Registration handle returned by `register_faux_provider`.
pub struct FauxProviderRegistration {
    pub api: String,
    pub models: Vec<Model>,
    source_id: String,
    state: Arc<FauxSharedState>,
}

#[derive(Default)]
struct FauxSharedState {
    call_count: Mutex<u64>,
    received_api_keys: Mutex<Vec<Option<String>>>,
    pending: Mutex<Vec<FauxResponseStep>>,
    prompt_cache: Mutex<HashMap<String, String>>,
}

impl FauxProviderRegistration {
    /// Default (first) model.
    pub fn get_model(&self) -> Model {
        self.models[0].clone()
    }

    /// Look up a model by id.
    pub fn get_model_by_id(&self, model_id: &str) -> Option<Model> {
        self.models
            .iter()
            .find(|model| model.id == model_id)
            .cloned()
    }

    /// Call count across all requests against this registration.
    pub fn call_count(&self) -> u64 {
        *self.state.call_count.lock().unwrap()
    }

    /// The API key each recorded request carried (per call, in order):
    /// summarizer arms that must follow the session's live key pin on it.
    pub fn received_api_keys(&self) -> Vec<Option<String>> {
        self.state.received_api_keys.lock().unwrap().clone()
    }

    /// Replace the queued responses.
    pub fn set_responses(&self, responses: Vec<FauxResponseStep>) {
        *self.state.pending.lock().unwrap() = responses;
    }

    /// Append to the queued responses.
    pub fn append_responses(&self, responses: Vec<FauxResponseStep>) {
        self.state.pending.lock().unwrap().extend(responses);
    }

    pub fn get_pending_response_count(&self) -> usize {
        self.state.pending.lock().unwrap().len()
    }

    /// Unregister the provider from the api registry.
    pub fn unregister(&self) {
        unregister_api_providers(&self.source_id);
    }
}

fn estimate_tokens(text: &str) -> u64 {
    (text.chars().count() as f64 / 4.0).ceil() as u64
}

pub fn random_id(prefix: &str) -> String {
    let mut rng = rand::thread_rng();
    let random: u32 = rng.gen();
    format!("{prefix}:{}:{random:x}", now_ms())
}

fn content_to_text(content: &UserMessageContent) -> String {
    match content {
        UserMessageContent::Text(text) => text.clone(),
        UserMessageContent::Blocks(blocks) => blocks
            .iter()
            .map(|block| match crate::types::user_block_payload(block) {
                crate::types::UserBlockPayload::Text(text) => text.to_string(),
                crate::types::UserBlockPayload::Image { data, mime_type } => {
                    format!("[image:{}:{}]", mime_type, data.len())
                }
                crate::types::UserBlockPayload::Opaque(json) => json,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn assistant_content_to_text(content: &[AssistantContent]) -> String {
    content
        .iter()
        .map(|block| match block {
            AssistantContent::Text(text) => text.text.clone(),
            AssistantContent::Thinking(thinking) => thinking.thinking.clone(),
            AssistantContent::ToolCall(tool_call) => {
                format!(
                    "{}:{}",
                    tool_call.name,
                    serde_json::Value::Object(tool_call.arguments.clone())
                )
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool_result_to_text(message: &ToolResultMessage) -> String {
    let mut parts = vec![message.tool_name.clone()];
    parts.extend(message.content.iter().map(|block| {
        match crate::types::user_block_payload(block) {
            crate::types::UserBlockPayload::Text(text) => text.to_string(),
            crate::types::UserBlockPayload::Image { data, mime_type } => {
                format!("[image:{}:{}]", mime_type, data.len())
            }
            crate::types::UserBlockPayload::Opaque(json) => json,
        }
    }));
    parts.join("\n")
}

fn message_to_text(message: &Message) -> String {
    match message {
        Message::User(user) => content_to_text(&user.content),
        Message::Assistant(assistant) => assistant_content_to_text(&assistant.content),
        Message::ToolResult(tool_result) => tool_result_to_text(tool_result),
    }
}

fn serialize_context(context: &Context) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(system_prompt) = &context.system_prompt {
        parts.push(format!("system:{system_prompt}"));
    }
    for message in &context.messages {
        parts.push(format!("{}:{}", message.role(), message_to_text(message)));
    }
    if let Some(tools) = &context.tools {
        if !tools.is_empty() {
            parts.push(format!(
                "tools:{}",
                serde_json::to_string(&tools).unwrap_or_default()
            ));
        }
    }
    parts.join("\n\n")
}

fn common_prefix_length(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let length = a_chars.len().min(b_chars.len());
    let mut index = 0;
    while index < length && a_chars[index] == b_chars[index] {
        index += 1;
    }
    index
}

fn with_usage_estimate(
    mut message: AssistantMessage,
    context: &Context,
    options: Option<&StreamOptions>,
    prompt_cache: &Mutex<HashMap<String, String>>,
) -> AssistantMessage {
    let prompt_text = serialize_context(context);
    let prompt_tokens = estimate_tokens(&prompt_text);
    let output_tokens = estimate_tokens(&assistant_content_to_text(&message.content));
    let mut input = prompt_tokens;
    let mut cache_read = 0u64;
    let mut cache_write = 0u64;
    let session_id = options.and_then(|options| options.session_id.clone());
    let cache_retention_none = options.map(|options| {
        matches!(
            options.cache_retention,
            Some(crate::types::CacheRetention::None)
        )
    });

    if let Some(session_id) = session_id {
        if !cache_retention_none.unwrap_or(false) {
            let mut cache = prompt_cache.lock().unwrap();
            if let Some(previous_prompt) = cache.get(&session_id).cloned() {
                let cached_chars = common_prefix_length(&previous_prompt, &prompt_text);
                let cached_prefix: String = previous_prompt.chars().take(cached_chars).collect();
                cache_read = estimate_tokens(&cached_prefix);
                let remaining: String = prompt_text.chars().skip(cached_chars).collect();
                cache_write = estimate_tokens(&remaining);
                input = prompt_tokens.saturating_sub(cache_read);
            } else {
                cache_write = prompt_tokens;
            }
            cache.insert(session_id, prompt_text);
        }
    }

    message.usage = Usage {
        input,
        output: output_tokens,
        cache_read,
        cache_write,
        total_tokens: input + output_tokens + cache_read + cache_write,
        cost: Default::default(),
    };
    message
}

fn split_string_by_token_size(
    text: &str,
    min_token_size: usize,
    max_token_size: usize,
) -> Vec<String> {
    let mut rng = rand::thread_rng();
    let chars: Vec<char> = text.chars().collect();
    let mut chunks: Vec<String> = Vec::new();
    let mut index = 0usize;
    while index < chars.len() {
        let token_size = rng.gen_range(min_token_size..=max_token_size);
        let char_size = (token_size * 4).max(1);
        let end = (index + char_size).min(chars.len());
        chunks.push(chars[index..end].iter().collect());
        index = end;
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

fn clone_message(
    message: &AssistantMessage,
    api: &str,
    provider: &str,
    model_id: &str,
) -> AssistantMessage {
    let mut cloned = message.clone();
    cloned.api = api.to_string();
    cloned.provider = provider.to_string();
    cloned.model = model_id.to_string();
    // The served message is produced at serve time — a real provider stamps
    // its assistant messages when the stream starts, while a scripted
    // template carries its parse-time stamp. Harness pacing (`delayMs`)
    // resolves before this, so a delayed response lands with its post-delay
    // timestamp.
    cloned.timestamp = now_ms();
    cloned
}

fn create_error_message(
    message: &str,
    api: &str,
    provider: &str,
    model_id: &str,
) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: api.to_string(),
        provider: provider.to_string(),
        model: model_id.to_string(),
        response_model: None,
        response_id: None,
        diagnostics: Some(Vec::new()),
        usage: default_usage(),
        stop_reason: StopReason::Error,
        stop_reason_raw: None,
        error_message: Some(message.to_string()),
        timestamp: now_ms(),
        rest: Default::default(),
    }
}

fn create_aborted_message(partial: &AssistantMessage) -> AssistantMessage {
    let mut aborted = partial.clone();
    aborted.stop_reason = StopReason::Aborted;
    aborted.error_message = Some("Request was aborted".to_string());
    aborted.timestamp = now_ms();
    aborted
}

async fn schedule_chunk(chunk: &str, tokens_per_second: Option<f64>) {
    if let Some(rate) = tokens_per_second {
        if rate > 0.0 {
            let delay_ms = (estimate_tokens(chunk) as f64 / rate) * 1000.0;
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms as u64)).await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_with_deltas(
    writer: &AssistantMessageEventWriter,
    message: &AssistantMessage,
    min_token_size: usize,
    max_token_size: usize,
    tokens_per_second: Option<f64>,
    signal: Option<&tokio_util::sync::CancellationToken>,
) {
    let mut partial = message.clone();
    partial.content = Vec::new();
    if signal.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
        let aborted = create_aborted_message(&partial);
        writer.push(AssistantMessageEvent::Error {
            reason: ErrorStopReason::Aborted,
            error: aborted.clone(),
        });
        writer.end(Some(aborted));
        return;
    }

    writer.push(AssistantMessageEvent::Start {
        partial: partial.clone(),
    });

    for index in 0..message.content.len() {
        if signal.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
            let aborted = create_aborted_message(&partial);
            writer.push(AssistantMessageEvent::Error {
                reason: ErrorStopReason::Aborted,
                error: aborted.clone(),
            });
            writer.end(Some(aborted));
            return;
        }

        let block = message.content[index].clone();

        match block {
            AssistantContent::Thinking(thinking_block) => {
                partial
                    .content
                    .push(AssistantContent::Thinking(ThinkingContent {
                        thinking: String::new(),
                        thinking_signature: None,
                        redacted: None,
                        rest: Default::default(),
                    }));
                writer.push(AssistantMessageEvent::ThinkingStart {
                    content_index: index as u64,
                    partial: partial.clone(),
                });
                for chunk in split_string_by_token_size(
                    &thinking_block.thinking,
                    min_token_size,
                    max_token_size,
                ) {
                    schedule_chunk(&chunk, tokens_per_second).await;
                    if signal.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
                        let aborted = create_aborted_message(&partial);
                        writer.push(AssistantMessageEvent::Error {
                            reason: ErrorStopReason::Aborted,
                            error: aborted.clone(),
                        });
                        writer.end(Some(aborted));
                        return;
                    }
                    if let Some(AssistantContent::Thinking(content)) =
                        partial.content.get_mut(index)
                    {
                        content.thinking += &chunk;
                    }
                    writer.push(AssistantMessageEvent::ThinkingDelta {
                        content_index: index as u64,
                        delta: chunk,
                        partial: partial.clone(),
                    });
                }
                writer.push(AssistantMessageEvent::ThinkingEnd {
                    content_index: index as u64,
                    content: thinking_block.thinking,
                    partial: partial.clone(),
                });
            }
            AssistantContent::Text(text_block) => {
                partial.content.push(AssistantContent::Text(TextContent {
                    text: String::new(),
                    text_signature: None,
                    rest: Default::default(),
                }));
                writer.push(AssistantMessageEvent::TextStart {
                    content_index: index as u64,
                    partial: partial.clone(),
                });
                for chunk in
                    split_string_by_token_size(&text_block.text, min_token_size, max_token_size)
                {
                    schedule_chunk(&chunk, tokens_per_second).await;
                    if signal.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
                        let aborted = create_aborted_message(&partial);
                        writer.push(AssistantMessageEvent::Error {
                            reason: ErrorStopReason::Aborted,
                            error: aborted.clone(),
                        });
                        writer.end(Some(aborted));
                        return;
                    }
                    if let Some(AssistantContent::Text(content)) = partial.content.get_mut(index) {
                        content.text += &chunk;
                    }
                    writer.push(AssistantMessageEvent::TextDelta {
                        content_index: index as u64,
                        delta: chunk,
                        partial: partial.clone(),
                    });
                }
                writer.push(AssistantMessageEvent::TextEnd {
                    content_index: index as u64,
                    content: text_block.text,
                    partial: partial.clone(),
                });
            }
            AssistantContent::ToolCall(tool_call_block) => {
                partial.content.push(AssistantContent::ToolCall(ToolCall {
                    id: tool_call_block.id.clone(),
                    name: tool_call_block.name.clone(),
                    arguments: Default::default(),
                    thought_signature: None,
                    rest: Default::default(),
                }));
                writer.push(AssistantMessageEvent::ToolcallStart {
                    content_index: index as u64,
                    partial: partial.clone(),
                });
                let arguments_text =
                    serde_json::Value::Object(tool_call_block.arguments.clone()).to_string();
                for chunk in
                    split_string_by_token_size(&arguments_text, min_token_size, max_token_size)
                {
                    schedule_chunk(&chunk, tokens_per_second).await;
                    if signal.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
                        let aborted = create_aborted_message(&partial);
                        writer.push(AssistantMessageEvent::Error {
                            reason: ErrorStopReason::Aborted,
                            error: aborted.clone(),
                        });
                        writer.end(Some(aborted));
                        return;
                    }
                    writer.push(AssistantMessageEvent::ToolcallDelta {
                        content_index: index as u64,
                        delta: chunk,
                        partial: partial.clone(),
                    });
                }
                if let Some(AssistantContent::ToolCall(content)) = partial.content.get_mut(index) {
                    content.arguments.clone_from(&tool_call_block.arguments);
                }
                writer.push(AssistantMessageEvent::ToolcallEnd {
                    content_index: index as u64,
                    tool_call: tool_call_block.clone(),
                    partial: partial.clone(),
                });
            }
        }
    }

    if message.stop_reason == StopReason::Error || message.stop_reason == StopReason::Aborted {
        writer.push(AssistantMessageEvent::Error {
            reason: error_reason(message.stop_reason),
            error: message.clone(),
        });
        writer.end(Some(message.clone()));
        return;
    }

    writer.push(AssistantMessageEvent::Done {
        reason: done_reason(message.stop_reason),
        message: message.clone(),
    });
    writer.end(Some(message.clone()));
}

#[derive(Default)]
pub struct RegisterFauxProviderOptions {
    pub api: Option<String>,
    pub provider: Option<String>,
    pub models: Option<Vec<FauxModelDefinition>>,
    pub tokens_per_second: Option<f64>,
    pub token_size_min: Option<usize>,
    pub token_size_max: Option<usize>,
}

/// Register a faux provider and return its handle.
pub fn register_faux_provider(options: RegisterFauxProviderOptions) -> FauxProviderRegistration {
    struct FauxStream {
        api: String,
        provider: String,
        state: Arc<FauxSharedState>,
        min_token_size: usize,
        max_token_size: usize,
        tokens_per_second: Option<f64>,
    }

    impl Provider for FauxStream {
        fn api(&self) -> &str {
            &self.api
        }

        fn stream(
            &self,
            model: &Model,
            context: &Context,
            options: Option<&StreamOptions>,
        ) -> AssistantMessageEventStream {
            let (writer, reader) = create_assistant_message_event_stream();
            let step = self.state.pending.lock().unwrap().pop_front_step();
            *self.state.call_count.lock().unwrap() += 1;
            self.state
                .received_api_keys
                .lock()
                .unwrap()
                .push(options.and_then(|options| options.api_key.clone()));

            let state = self.state.clone();
            let api = self.api.clone();
            let provider = self.provider.clone();
            let model = model.clone();
            let context = context.clone();
            let options = options.cloned();
            let min_token_size = self.min_token_size;
            let max_token_size = self.max_token_size;
            let tokens_per_second = self.tokens_per_second;

            tokio::spawn(async move {
                if let Some(options) = options.as_ref() {
                    if let Some(on_response) = &options.on_response {
                        on_response(
                            crate::types::ProviderResponse {
                                status: 200,
                                headers: Default::default(),
                            },
                            &model,
                        );
                    }
                }
                let Some(step) = step else {
                    let mut message = create_error_message(
                        "No more faux responses queued",
                        &api,
                        &provider,
                        &model.id,
                    );
                    message = with_usage_estimate(
                        message,
                        &context,
                        options.as_ref(),
                        &state.prompt_cache,
                    );
                    writer.push(AssistantMessageEvent::Error {
                        reason: ErrorStopReason::Error,
                        error: message.clone(),
                    });
                    writer.end(Some(message));
                    return;
                };

                let resolved = match step {
                    FauxResponseStep::Message(message) => Ok(message),
                    // The harness pacing delay holds the stream closed
                    // before the first delta: in-flight states (loaders,
                    // spinners) stay visible for the harness's capture
                    // window. The token races the hold, so a turn abort
                    // mid-wait cancels the request like the real transport
                    // (the fetch dies before any event streams).
                    FauxResponseStep::Delayed { message, delay_ms } => {
                        if delay_ms > 0 {
                            let hold =
                                tokio::time::sleep(std::time::Duration::from_millis(delay_ms));
                            let cancelled = if let Some(signal) =
                                options.as_ref().and_then(|options| options.signal.clone())
                            {
                                tokio::select! {
                                    _ = hold => false,
                                    _ = signal.cancelled() => true,
                                }
                            } else {
                                hold.await;
                                false
                            };
                            if cancelled {
                                // The real providers' abort path: the request
                                // dies mid-flight (ProviderError::Aborted),
                                // the stream settles on the aborted message.
                                let mut partial = message.clone();
                                partial.content = Vec::new();
                                let aborted = create_aborted_message(&partial);
                                writer.push(AssistantMessageEvent::Error {
                                    reason: ErrorStopReason::Aborted,
                                    error: aborted.clone(),
                                });
                                writer.end(Some(aborted));
                                return;
                            }
                        }
                        Ok(message)
                    }
                    FauxResponseStep::Factory(factory) => {
                        let call_count = *state.call_count.lock().unwrap();
                        factory(&context, options.as_ref(), call_count, &model)
                    }
                };
                match resolved {
                    Ok(resolved) => {
                        let mut message = clone_message(&resolved, &api, &provider, &model.id);
                        message = with_usage_estimate(
                            message,
                            &context,
                            options.as_ref(),
                            &state.prompt_cache,
                        );
                        stream_with_deltas(
                            &writer,
                            &message,
                            min_token_size,
                            max_token_size,
                            tokens_per_second,
                            options.as_ref().and_then(|options| options.signal.as_ref()),
                        )
                        .await;
                    }
                    Err(error) => {
                        let message = create_error_message(&error, &api, &provider, &model.id);
                        writer.push(AssistantMessageEvent::Error {
                            reason: ErrorStopReason::Error,
                            error: message.clone(),
                        });
                        writer.end(Some(message));
                    }
                }
            });

            reader
        }

        fn stream_simple(
            &self,
            model: &Model,
            context: &Context,
            options: Option<&SimpleStreamOptions>,
        ) -> AssistantMessageEventStream {
            let options = options.map(|simple| simple.base.clone());
            self.stream(model, context, options.as_ref())
        }
    }

    let api = options.api.unwrap_or_else(|| random_id(DEFAULT_API));
    let provider_name = options
        .provider
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
    let source_id = random_id("faux-provider");
    let max = options.token_size_max.unwrap_or(DEFAULT_MAX_TOKEN_SIZE);
    let min = options
        .token_size_min
        .unwrap_or(DEFAULT_MIN_TOKEN_SIZE)
        .clamp(1, max);
    let state = Arc::new(FauxSharedState {
        call_count: Mutex::new(0),
        received_api_keys: Mutex::new(Vec::new()),
        pending: Mutex::new(Vec::new()),
        prompt_cache: Mutex::new(HashMap::new()),
    });
    let tokens_per_second = options.tokens_per_second;

    let model_definitions = options.models.unwrap_or_else(|| {
        vec![FauxModelDefinition {
            id: DEFAULT_MODEL_ID.to_string(),
            name: Some(DEFAULT_MODEL_NAME.to_string()),
            reasoning: Some(false),
            input: Some(vec![ModelInput::Text, ModelInput::Image]),
            cost: None,
            context_window: Some(128_000),
            max_tokens: Some(16_384),
        }]
    });
    let models: Vec<Model> = model_definitions
        .iter()
        .map(|definition| Model {
            id: definition.id.clone(),
            name: definition
                .name
                .clone()
                .unwrap_or_else(|| definition.id.clone()),
            api: api.clone(),
            provider: provider_name.clone(),
            base_url: DEFAULT_BASE_URL.to_string(),
            reasoning: definition.reasoning.unwrap_or(false),
            thinking_level_map: None,
            input: definition
                .input
                .clone()
                .unwrap_or_else(|| vec![ModelInput::Text, ModelInput::Image]),
            cost: definition.cost.unwrap_or_else(zero_model_cost),
            context_window: definition.context_window.unwrap_or(128_000),
            max_tokens: definition.max_tokens.unwrap_or(16_384),
            featured: None,
            headers: None,
            compat: None,
        })
        .collect();

    let stream_impl = FauxStream {
        api: api.clone(),
        provider: provider_name,
        state: state.clone(),
        min_token_size: min,
        max_token_size: max,
        tokens_per_second,
    };
    register_api_provider(Arc::new(stream_impl), Some(&source_id));

    FauxProviderRegistration {
        api,
        models,
        source_id,
        state,
    }
}

trait PopFront {
    fn pop_front_step(&mut self) -> Option<FauxResponseStep>;
}

impl PopFront for Vec<FauxResponseStep> {
    fn pop_front_step(&mut self) -> Option<FauxResponseStep> {
        if self.is_empty() {
            None
        } else {
            Some(self.remove(0))
        }
    }
}

/// Helper: build an image content block (kept next to the other faux helpers).
pub fn faux_image(data: &str, mime_type: &str) -> ImageContent {
    ImageContent {
        data: data.to_string(),
        mime_type: mime_type.to_string(),
        rest: Default::default(),
    }
}

pub mod script;

#[cfg(test)]
mod tests;
