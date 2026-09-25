//! Public streaming facade.
//! Ported from `packages/ai/src/stream.ts`.

use std::sync::Arc;

use crate::event_stream::AssistantMessageEventStream;
use crate::providers::simple_options::default_request_max_tokens;
use crate::registry::{ensure_builtins, get_api_provider};
use crate::types::{AssistantMessage, Context, Model, SimpleStreamOptions, StreamOptions};
use crate::utils_inner::ProviderError;

fn resolve_provider(api: &str) -> Result<Arc<dyn crate::registry::Provider>, ProviderError> {
    ensure_builtins();
    get_api_provider(api)
        .ok_or_else(|| ProviderError::Message(format!("No API provider registered for api: {api}")))
}

// ---------------------------------------------------------------------------
// Combined-ceiling output clamp
// ---------------------------------------------------------------------------

/// Estimate a request's input tokens before it is sent: chars/4 over the
/// text the provider will serialize, images at 1,200 tokens each. The same
/// conservative policy the session engine's compaction estimator applies
/// (`pa-core` cannot be a dependency here, so the heuristic is restated).
fn estimated_input_tokens(context: &Context) -> u64 {
    const TOOL_ENVELOPE_CHARS: u64 = 48;
    let mut chars = context
        .system_prompt
        .as_deref()
        .map_or(0, |text| text.chars().count()) as u64;
    // Tool definitions serialize into every request (the provider sends
    // each schema on every call), so they claim input room like the
    // tool-call arguments below. Providers wrap each schema in their own
    // envelope on the wire (OpenAI-completions:
    // `{"type":"function","function":...}` plus flags like `strict`), so
    // every tool also counts the widest envelope's chars.
    for tool in context.tools.iter().flatten() {
        chars = chars.saturating_add(
            serde_json::to_string(tool)
                .map_or(0, |json| TOOL_ENVELOPE_CHARS + json.chars().count() as u64),
        );
    }
    for message in &context.messages {
        chars = chars.saturating_add(match message {
            crate::types::Message::User(user) => match &user.content {
                crate::types::UserMessageContent::Text(text) => text.chars().count() as u64,
                crate::types::UserMessageContent::Blocks(blocks) => {
                    user_content_block_chars(blocks)
                }
            },
            crate::types::Message::Assistant(assistant) => assistant
                .content
                .iter()
                .map(|block| match block {
                    crate::types::AssistantContent::Text(text) => text.text.chars().count() as u64,
                    crate::types::AssistantContent::Thinking(thinking) => {
                        thinking.thinking.chars().count() as u64
                    }
                    crate::types::AssistantContent::ToolCall(call) => {
                        call.name.chars().count() as u64
                            + serde_json::to_string(&call.arguments)
                                .map_or(0, |json| json.chars().count() as u64)
                    }
                })
                .sum(),
            crate::types::Message::ToolResult(result) => user_content_block_chars(&result.content),
        });
    }
    chars.div_ceil(4)
}

/// Text chars plus 4,800 per image (1,200 tokens) — the session engine's
/// per-image estimate; raw blocks count their serialized JSON (`user_block_payload`
/// passes un-modeled blocks through as text, so their bytes reach the prompt).
fn user_content_block_chars(blocks: &[crate::types::UserOrToolContent]) -> u64 {
    blocks
        .iter()
        .map(|block| match block {
            crate::types::UserOrToolContent::Text(text) => text.text.chars().count() as u64,
            crate::types::UserOrToolContent::Image(_) => 4_800,
            crate::types::UserOrToolContent::Raw(value) => {
                serde_json::to_string(value).map_or(0, |json| json.chars().count() as u64)
            }
        })
        .sum()
}

/// Clamp the requested output budget against the model's combined
/// input+output ceiling: a provider that enforces `input + max_tokens <=
/// contextWindow` rejects an unsatisfiable request outright (the live
/// 400: 1,017,457 input + 32,000 requested output on a 1,048,576 window),
/// so the facade shrinks the output budget to whatever room the estimated
/// input leaves. The estimate covers the full serialized request — system
/// prompt, tool schemas, message text, raw blocks, images — so it tracks
/// the provider's own input count instead of leaving uncounted bytes to
/// overflow it.
///
/// The TS facade never clamps (`packages/ai/src/providers/simple-options.ts`
/// caps only at `min(model.maxTokens, 32000)`); this is a deliberate
/// Rust-side guard. Budget-folding thinking providers (Anthropic, Bedrock)
/// add their thinking budget after this clamp and cap it at
/// `model.max_tokens`; the compaction threshold's headroom and the overflow
/// recovery arm remain the guards for that corner.
fn clamp_output_budget(model: &Model, context: &Context, options: Option<&mut StreamOptions>) {
    let Some(options) = options else {
        return;
    };
    if model.context_window == 0 {
        return; // combined ceiling unknown — leave the request alone
    }
    let requested = options
        .max_tokens
        .or_else(|| default_request_max_tokens(model));
    let Some(requested) = requested else {
        return; // no default budget to clamp
    };
    let available = model
        .context_window
        .saturating_sub(estimated_input_tokens(context));
    // Zero room means the input alone fills the window — no budget can
    // save the request, so it stays as sent for the overflow recovery arm.
    if requested > available && available > 0 {
        options.max_tokens = Some(available);
    }
}

/// Start streaming a completion for `model` using provider-native options.
///
/// # Errors
///
/// Returns `Err` when no API provider is registered for `model.api`.
pub fn stream(
    model: &Model,
    context: &Context,
    options: Option<StreamOptions>,
) -> Result<AssistantMessageEventStream, ProviderError> {
    let provider = resolve_provider(&model.api)?;
    let mut options = options;
    clamp_output_budget(model, context, options.as_mut());
    Ok(provider.stream(model, context, options.as_ref()))
}

/// Await the final assistant message of a provider-native stream.
///
/// # Errors
///
/// Returns `Err` when no API provider is registered for `model.api`.
pub async fn complete(
    model: &Model,
    context: &Context,
    options: Option<StreamOptions>,
) -> Result<AssistantMessage, ProviderError> {
    let stream = stream(model, context, options)?;
    Ok(stream.result().await)
}

/// Start a streaming completion with unified reasoning options (`streamSimple`).
///
/// # Errors
///
/// Returns `Err` when no API provider is registered for `model.api`.
pub fn stream_simple(
    model: &Model,
    context: &Context,
    options: Option<SimpleStreamOptions>,
) -> Result<AssistantMessageEventStream, ProviderError> {
    let provider = resolve_provider(&model.api)?;
    let mut options = options;
    // A `None` caller still gets the default output budget downstream
    // (`build_base_options` fills `min(model.maxTokens, 32000)`), so
    // materialize the options to clamp that default too. The materialized
    // default builds the same request otherwise.
    let simple = options.get_or_insert_with(SimpleStreamOptions::default);
    clamp_output_budget(model, context, Some(&mut simple.base));
    Ok(provider.stream_simple(model, context, options.as_ref()))
}

/// Await the final assistant message of a simple stream (`completeSimple`).
///
/// # Errors
///
/// Returns `Err` when no API provider is registered for `model.api`.
pub async fn complete_simple(
    model: &Model,
    context: &Context,
    options: Option<SimpleStreamOptions>,
) -> Result<AssistantMessage, ProviderError> {
    let stream = stream_simple(model, context, options)?;
    Ok(stream.result().await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        AssistantContent, AssistantMessage, ImageContent, TextContent, ThinkingContent, ToolCall,
        ToolResultMessage, UserMessage, UserMessageContent, UserOrToolContent, Usage,
    };
    use serde_json::Map;
    use serde_json::json;

    fn test_model(context_window: u64, max_tokens: u64) -> Model {
        serde_json::from_value(json!({
            "id": "m", "name": "m", "api": "openai-completions", "provider": "p",
            "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": context_window, "maxTokens": max_tokens,
        }))
        .expect("test model")
    }

    fn text_context(chars: usize) -> Context {
        Context {
            system_prompt: None,
            messages: vec![crate::types::Message::User(UserMessage {
                content: UserMessageContent::Text("x".repeat(chars)),
                timestamp: 0,
                rest: Map::default(),
            })],
            tools: None,
        }
    }

    #[test]
    fn the_estimate_counts_the_serialized_tool_schemas() {
        let tool: crate::types::Tool = serde_json::from_value(json!({
            "name": "lookup",
            "description": "x".repeat(1_600),
            "parameters": {"type": "object"}
        }))
        .expect("tool parses");
        let serialized = serde_json::to_string(&tool).expect("tool serializes");
        let mut context = text_context(3_000);
        context.tools = Some(vec![tool]);
        // The tool schema's serialized bytes plus its wire envelope join
        // the text under chars/4.
        assert_eq!(
            estimated_input_tokens(&context),
            (3_000 + 48 + serialized.chars().count() as u64).div_ceil(4)
        );
    }

    #[test]
    fn the_estimate_counts_raw_blocks_as_their_serialized_json() {
        // Raw blocks reach the prompt as text (`user_block_payload`'s
        // opaque arm), so their serialized bytes claim input room.
        let value = json!({"unmodeled": "y".repeat(4_000)});
        let serialized = serde_json::to_string(&value).expect("value serializes");
        let mut context = text_context(3_000);
        context
            .messages
            .push(crate::types::Message::User(UserMessage {
                content: UserMessageContent::Blocks(vec![UserOrToolContent::Raw(value)]),
                timestamp: 0,
                rest: Map::default(),
            }));
        assert_eq!(
            estimated_input_tokens(&context),
            (3_000 + serialized.chars().count() as u64).div_ceil(4)
        );
    }

    #[test]
    fn tool_schemas_shrink_the_room_the_clamp_leaves() {
        // A tool-carrying request the text-only estimate called
        // satisfiable now clamps: the schemas eat the output room. The
        // input must still fit the window — zero room leaves the budget
        // for the overflow recovery arm instead.
        let model = test_model(1_000, 40_000);
        let mut context = text_context(3_000); // 750 text tokens
        let tool: crate::types::Tool = serde_json::from_value(json!({
            "name": "lookup",
            "description": "x".repeat(400),
            "parameters": {"type": "object"}
        }))
        .expect("tool parses");
        let serialized = serde_json::to_string(&tool).expect("tool serializes");
        context.tools = Some(vec![tool]);
        let mut options = StreamOptions {
            max_tokens: Some(250),
            ..Default::default()
        };
        clamp_output_budget(&model, &context, Some(&mut options));
        // 250 exactly fit the 750-token text input; the schema's
        // serialized tokens leave less room than the budget requests,
        // so the budget clamps to exactly what is left.
        let room =
            1_000u64.saturating_sub((3_000 + 48 + serialized.chars().count() as u64).div_ceil(4));
        assert_eq!(options.max_tokens, Some(room));
        assert!(room > 0 && room < 250);
    }

    #[test]
    fn clamp_shrinks_an_unsatisfiable_output_budget() {
        // The live failure shape: an input estimate leaving less room than
        // the requested output budget.
        let model = test_model(1_000, 40_000);
        let context = text_context(3_000); // 750 estimated input tokens
        let mut options = StreamOptions {
            max_tokens: Some(400),
            ..Default::default()
        };
        clamp_output_budget(&model, &context, Some(&mut options));
        assert_eq!(options.max_tokens, Some(250));
    }

    #[test]
    fn clamp_resolves_the_default_budget_when_none_set() {
        // The main-loop shape: no explicit max_tokens, so the effective
        // request budget is min(model.maxTokens, 32000).
        let model = test_model(1_000, 40_000);
        let context = text_context(3_600); // 900 estimated input tokens
        let mut options = StreamOptions::default();
        clamp_output_budget(&model, &context, Some(&mut options));
        assert_eq!(options.max_tokens, Some(100));
    }

    #[test]
    fn satisfiable_requests_pass_through_unchanged() {
        let model = test_model(1_000, 40_000);
        let context = text_context(3_000); // 750 estimated input tokens
        let mut options = StreamOptions {
            max_tokens: Some(200),
            ..Default::default()
        };
        clamp_output_budget(&model, &context, Some(&mut options));
        assert_eq!(options.max_tokens, Some(200));
        // No explicit budget and the default fits: nothing materializes.
        let model = test_model(100_000, 4_096); // default request budget 4_096
        let mut options = StreamOptions::default();
        clamp_output_budget(&model, &context, Some(&mut options));
        assert_eq!(options.max_tokens, None);
    }

    #[test]
    fn clamp_takes_whatever_room_exists() {
        // A sub-floor budget still fits: the clamp honors exactly the room
        // the estimate leaves (250 room -> 250 requested output).
        let model = test_model(1_000, 40_000);
        let context = text_context(3_000); // 750 estimated input tokens
        let mut options = StreamOptions {
            max_tokens: Some(400),
            ..Default::default()
        };
        clamp_output_budget(&model, &context, Some(&mut options));
        assert_eq!(options.max_tokens, Some(250));
        // The input estimate fills the window: no budget can save the
        // request, so it stays as sent for the overflow recovery arm.
        let context = text_context(4_400); // 1,100 estimated input tokens
        let mut options = StreamOptions {
            max_tokens: Some(400),
            ..Default::default()
        };
        clamp_output_budget(&model, &context, Some(&mut options));
        assert_eq!(options.max_tokens, Some(400));
    }

    #[test]
    fn unknown_window_and_missing_options_leave_the_request_alone() {
        let model = test_model(0, 40_000);
        let mut options = StreamOptions {
            max_tokens: Some(400),
            ..Default::default()
        };
        clamp_output_budget(&model, &text_context(9_000), Some(&mut options));
        assert_eq!(options.max_tokens, Some(400));
        // A model declaring no max output sends no budget to clamp.
        let model = test_model(1_000, 0);
        let mut options = StreamOptions::default();
        clamp_output_budget(&model, &text_context(4_200), Some(&mut options));
        assert_eq!(options.max_tokens, None);
    }

    #[test]
    fn estimator_counts_text_thinking_tool_calls_and_images() {
        let context = Context {
            system_prompt: Some("1234".to_string()), // 1 token
            messages: vec![
                crate::types::Message::User(UserMessage {
                    content: UserMessageContent::Blocks(vec![
                        UserOrToolContent::Text(TextContent {
                            text: "12345678".to_string(), // 2 tokens
                            text_signature: None,
                            rest: Map::default(),
                        }),
                        UserOrToolContent::Image(ImageContent {
                            data: "QQ==".to_string(),
                            mime_type: "image/png".to_string(),
                            rest: Map::default(),
                        }), // 1,200 tokens
                    ]),
                    timestamp: 0,
                    rest: Map::default(),
                }),
                crate::types::Message::Assistant(AssistantMessage {
                    content: vec![
                        AssistantContent::Thinking(ThinkingContent {
                            thinking: "12345678".to_string(), // 2 tokens
                            thinking_signature: None,
                            redacted: None,
                            rest: Map::default(),
                        }),
                        AssistantContent::ToolCall(ToolCall {
                            id: "c".to_string(),
                            name: "bash".to_string(), // 5 chars
                            arguments: json!({"code": "ls"}).as_object().cloned().unwrap(),
                            // 12 chars
                            thought_signature: None,
                            rest: Map::default(),
                        }),
                    ],
                    api: "openai-completions".into(),
                    provider: "p".into(),
                    model: "m".into(),
                    response_model: None,
                    response_id: None,
                    diagnostics: None,
                    usage: Usage::default(),
                    stop_reason: crate::types::StopReason::Stop,
                    stop_reason_raw: None,
                    error_message: None,
                    timestamp: 0,
                    rest: Map::default(),
                }),
                crate::types::Message::ToolResult(ToolResultMessage {
                    tool_call_id: "c".to_string(),
                    tool_name: "bash".to_string(),
                    content: vec![UserOrToolContent::Text(TextContent {
                        text: "12345678".to_string(), // 2 tokens
                        text_signature: None,
                        rest: Map::default(),
                    })],
                    details: None,
                    is_error: false,
                    timestamp: 0,
                    rest: Map::default(),
                }),
            ],
            tools: None,
        };
        // 1 (system) + 2 + 1_200 + 2 + ceil((5 + 12) / 4) = 5 + 1_200 + 2
        assert_eq!(estimated_input_tokens(&context), 1 + 2 + 1_200 + 2 + 5 + 2);
    }
}
