//! `OpenAI` Completions conversion: reasoning-details signatures, messages, and tools.
//! Section of the port of `packages/ai/src/providers/openai-completions.ts`.

use serde_json::{json, Map, Value};

use crate::models::{calculate_cost, CostOverrides};
use crate::providers::openai_completions::{decode_reasoning_details, ResolvedCompat};
use crate::providers::transform_messages::transform_messages_with_normalizer;
use crate::types::{
    AssistantContent, Context, MessageExt, Model, ModelInput, StopReason, TextContent,
    ThinkingContent, Tool, ToolCall, Usage, UsageCost, UserMessageContent, UserOrToolContent,
};
use crate::utils_inner::sanitize_unicode::sanitize_surrogates;

/// Convert a conversation into Chat Completions `messages` params.
/// Port of `convertMessages` including tool-result bridging and image replay.
pub fn convert_messages(model: &Model, context: &Context, compat: &ResolvedCompat) -> Vec<Value> {
    use crate::types::Message;
    let mut params: Vec<Value> = Vec::new();

    let transformed =
        transform_messages_with_normalizer(&context.messages, model, &|id, model, _| {
            Some(normalize_tool_call_id(id, model))
        });

    if let Some(system_prompt) = &context.system_prompt {
        let use_developer_role = model.reasoning && compat.supports_developer_role;
        let role = if use_developer_role {
            "developer"
        } else {
            "system"
        };
        params.push(json!({
            "role": role,
            "content": sanitize_surrogates(system_prompt),
        }));
    }

    let mut last_role: Option<&'static str> = None;
    let mut index = 0usize;
    while index < transformed.len() {
        let msg = &transformed[index];
        // Some providers don't allow user messages directly after tool results.
        if compat.requires_assistant_after_tool_result
            && last_role == Some("toolResult")
            && matches!(msg, Message::User(_))
        {
            params.push(json!({
                "role": "assistant",
                "content": "I have processed the tool results.",
            }));
        }

        match msg {
            Message::User(user) => match &user.content {
                UserMessageContent::Text(text) => params.push(json!({
                    "role": "user",
                    "content": sanitize_surrogates(text),
                })),
                UserMessageContent::Blocks(blocks) => {
                    let content: Vec<Value> = blocks
                        .iter()
                        .map(|item| match crate::types::user_block_payload(item) {
                            crate::types::UserBlockPayload::Text(text) => json!({
                                "type": "text",
                                "text": sanitize_surrogates(text),
                            }),
                            crate::types::UserBlockPayload::Image { data, mime_type } => json!({
                                "type": "image_url",
                                "image_url": { "url": format!("data:{mime_type};base64,{data}") },
                            }),
                            crate::types::UserBlockPayload::Opaque(json) => json!({
                                "type": "text",
                                "text": sanitize_surrogates(&json),
                            }),
                        })
                        .collect();
                    if content.is_empty() {
                        index += 1;
                        continue;
                    }
                    params.push(json!({
                        "role": "user",
                        "content": content,
                    }));
                }
            },
            Message::Assistant(assistant) => {
                let mut assistant_msg = Map::new();
                assistant_msg.insert("role".into(), json!("assistant"));
                // Some providers don't accept null content; use empty string instead.
                assistant_msg.insert(
                    "content".into(),
                    if compat.requires_assistant_after_tool_result {
                        json!("")
                    } else {
                        Value::Null
                    },
                );

                let text_blocks: Vec<&TextContent> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantContent::Text(text) if !text.text.trim().is_empty() => Some(text),
                        _ => None,
                    })
                    .collect();
                let assistant_text = text_blocks
                    .iter()
                    .map(|block| sanitize_surrogates(&block.text))
                    .collect::<String>();

                let replay_reasoning_details: Vec<Value> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantContent::Thinking(thinking) => {
                            decode_reasoning_details(thinking.thinking_signature.as_deref())
                        }
                        _ => None,
                    })
                    .flatten()
                    .collect();
                if !replay_reasoning_details.is_empty() {
                    assistant_msg
                        .insert("reasoning_details".into(), json!(replay_reasoning_details));
                }

                let non_empty_thinking_blocks: Vec<&ThinkingContent> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantContent::Thinking(thinking)
                            if decode_reasoning_details(thinking.thinking_signature.as_deref())
                                .is_none()
                                && !thinking.thinking.trim().is_empty() =>
                        {
                            Some(thinking)
                        }
                        _ => None,
                    })
                    .collect();

                if !non_empty_thinking_blocks.is_empty() {
                    if compat.requires_thinking_as_text {
                        let thinking_text = non_empty_thinking_blocks
                            .iter()
                            .map(|block| sanitize_surrogates(&block.thinking))
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        assistant_msg.insert(
                            "content".into(),
                            json!([{
                                "type": "text",
                                "text": thinking_text,
                            }]),
                        );
                        for block in &text_blocks {
                            assistant_msg["content"]
                                .as_array_mut()
                                .expect("content is an array")
                                .push(json!({
                                    "type": "text",
                                    "text": sanitize_surrogates(&block.text),
                                }));
                        }
                    } else {
                        // Always send assistant text as a plain string.
                        if !assistant_text.is_empty() {
                            assistant_msg.insert("content".into(), json!(assistant_text));
                        }

                        let reasoning_text = non_empty_thinking_blocks
                            .iter()
                            .map(|block| sanitize_surrogates(&block.thinking))
                            .collect::<Vec<_>>()
                            .join("\n");
                        let reasoning_field =
                            if compat.requires_reasoning_content_on_assistant_messages {
                                Some("reasoning_content")
                            } else {
                                non_empty_thinking_blocks[0].thinking_signature.as_deref()
                            };
                        match reasoning_field {
                            Some(field) => {
                                assistant_msg.insert(field.to_string(), json!(reasoning_text));
                            }
                            None => {
                                assistant_msg.insert(
                                    "content".into(),
                                    if assistant_text.is_empty() {
                                        json!(reasoning_text)
                                    } else {
                                        json!(format!("{reasoning_text}\n\n{assistant_text}"))
                                    },
                                );
                            }
                        }
                    }
                } else if !assistant_text.is_empty() {
                    assistant_msg.insert("content".into(), json!(assistant_text));
                }

                let tool_calls: Vec<&ToolCall> = assistant
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantContent::ToolCall(tool_call) => Some(tool_call),
                        _ => None,
                    })
                    .collect();
                if !tool_calls.is_empty() {
                    assistant_msg.insert(
                        "tool_calls".into(),
                        json!(tool_calls
                            .iter()
                            .map(|tool_call| json!({
                                "id": tool_call.id,
                                "type": "function",
                                "function": {
                                    "name": tool_call.name,
                                    "arguments": serde_json::Value::Object(tool_call.arguments.clone()).to_string(),
                                },
                            }))
                            .collect::<Vec<_>>()),
                    );
                    let reasoning_details: Vec<Value> = tool_calls
                        .iter()
                        .filter_map(|tool_call| {
                            tool_call
                                .thought_signature
                                .as_ref()
                                .and_then(|signature| serde_json::from_str(signature).ok())
                        })
                        .collect();
                    if !reasoning_details.is_empty() && replay_reasoning_details.is_empty() {
                        assistant_msg.insert("reasoning_details".into(), json!(reasoning_details));
                    }
                }
                if compat.requires_reasoning_content_on_assistant_messages
                    && model.reasoning
                    && !assistant_msg.contains_key("reasoning_content")
                {
                    assistant_msg.insert("reasoning_content".into(), json!(""));
                }
                if !replay_reasoning_details.is_empty()
                    && assistant_msg.get("content") == Some(&Value::Null)
                    && !assistant_msg.contains_key("tool_calls")
                {
                    assistant_msg.insert("content".into(), json!(""));
                }
                // Skip assistant messages that have no content and no tool calls.
                let content = assistant_msg.get("content");
                let has_content = match content {
                    Some(Value::Null) | None => false,
                    Some(Value::String(text)) => !text.is_empty(),
                    Some(Value::Array(array)) => !array.is_empty(),
                    Some(_) => true,
                };
                if !has_content
                    && !assistant_msg.contains_key("tool_calls")
                    && replay_reasoning_details.is_empty()
                {
                    index += 1;
                    continue;
                }
                params.push(Value::Object(assistant_msg));
            }
            Message::ToolResult(_) => {
                let mut image_blocks: Vec<Value> = Vec::new();
                let mut j = index;
                while j < transformed.len() {
                    let Message::ToolResult(tool_msg) = &transformed[j] else {
                        break;
                    };

                    let text_result = tool_msg
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            UserOrToolContent::Text(text) => Some(text.text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    let has_images = tool_msg
                        .content
                        .iter()
                        .any(|block| matches!(block, UserOrToolContent::Image(_)));

                    let has_text = !text_result.is_empty();
                    let mut tool_result_msg = Map::new();
                    tool_result_msg.insert("role".into(), json!("tool"));
                    tool_result_msg.insert(
                        "content".into(),
                        json!(sanitize_surrogates(if has_text {
                            text_result.as_str()
                        } else if has_images {
                            "(see attached image)"
                        } else {
                            ""
                        })),
                    );
                    tool_result_msg.insert("tool_call_id".into(), json!(tool_msg.tool_call_id));
                    if compat.requires_tool_result_name && !tool_msg.tool_name.is_empty() {
                        tool_result_msg.insert("name".into(), json!(tool_msg.tool_name));
                    }
                    params.push(Value::Object(tool_result_msg));

                    if has_images
                        && model
                            .input
                            .iter()
                            .any(|mode| matches!(mode, ModelInput::Image))
                    {
                        for block in &tool_msg.content {
                            if let UserOrToolContent::Image(image) = block {
                                image_blocks.push(json!({
                                    "type": "image_url",
                                    "image_url": { "url": format!("data:{};base64,{}", image.mime_type, image.data) },
                                }));
                            }
                        }
                    }
                    j += 1;
                }

                index = j;
                if image_blocks.is_empty() {
                    last_role = Some("toolResult");
                } else {
                    if compat.requires_assistant_after_tool_result {
                        params.push(json!({
                            "role": "assistant",
                            "content": "I have processed the tool results.",
                        }));
                    }
                    let mut content = vec![json!({
                        "type": "text",
                        "text": "Attached image(s) from tool result:",
                    })];
                    content.extend(image_blocks);
                    params.push(json!({
                        "role": "user",
                        "content": content,
                    }));
                    last_role = Some("user");
                }
                continue;
            }
        }

        last_role = Some(msg.role());
        index += 1;
    }

    params
}

/// Normalize a tool call ID for providers that reject long/pipe-separated IDs.
pub fn normalize_tool_call_id(id: &str, model: &Model) -> String {
    if id.contains('|') {
        let call_id = id.split('|').next().unwrap_or("");
        call_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .take(40)
            .collect()
    } else if model.provider == "openai" {
        id.chars().take(40).collect()
    } else {
        id.to_string()
    }
}

pub fn convert_tools(tools: &[Tool], compat: &ResolvedCompat) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            let mut function = Map::new();
            function.insert("name".into(), json!(tool.name));
            function.insert("description".into(), json!(tool.description));
            function.insert("parameters".into(), tool.parameters.clone());
            // Only include strict if provider supports it. Some reject unknown fields.
            if compat.supports_strict_mode {
                function.insert("strict".into(), json!(false));
            }
            json!({
                "type": "function",
                "function": Value::Object(function),
            })
        })
        .collect()
}

pub(crate) fn parse_chunk_usage(
    raw_usage: &Value,
    model: &Model,
    cache_write_cost: Option<f64>,
) -> Usage {
    let get_u64 = |value: &Value| value.as_u64().unwrap_or(0);
    let prompt_tokens = raw_usage.get("prompt_tokens").map_or(0, get_u64);
    let reported_cached_tokens = raw_usage
        .get("prompt_tokens_details")
        .and_then(|details| details.get("cached_tokens"))
        .map(get_u64)
        .or_else(|| raw_usage.get("prompt_cache_hit_tokens").map(get_u64))
        .unwrap_or(0);
    let cache_write_tokens = raw_usage
        .get("prompt_tokens_details")
        .and_then(|details| details.get("cache_write_tokens"))
        .map_or(0, get_u64);

    // Normalize to the provider-layer usage accounting semantics:
    // - cacheRead: hits from cache created by previous requests only
    // - cacheWrite: tokens written to cache in this request
    // Some OpenAI-compatible providers (observed on OpenRouter) report
    // cached_tokens as (previous hits + current writes). Remove cacheWrite from
    // cacheRead in that case.
    let cache_read_tokens = if cache_write_tokens > 0 {
        reported_cached_tokens.saturating_sub(cache_write_tokens)
    } else {
        reported_cached_tokens
    };

    let input = prompt_tokens
        .saturating_sub(cache_read_tokens)
        .saturating_sub(cache_write_tokens);
    // OpenAI completion_tokens already includes reasoning_tokens.
    let output_tokens = raw_usage.get("completion_tokens").map_or(0, get_u64);
    let mut usage = Usage {
        input,
        output: output_tokens,
        cache_read: cache_read_tokens,
        cache_write: cache_write_tokens,
        total_tokens: input + output_tokens + cache_read_tokens + cache_write_tokens,
        cost: UsageCost::default(),
    };
    calculate_cost(
        model,
        &mut usage,
        cache_write_cost
            .map(|cache_write| CostOverrides {
                cache_write: Some(cache_write),
            })
            .as_ref(),
    );
    // OpenRouter reports billing truth in usage, already priced by the endpoint
    // and service tier that served the request
    // (https://openrouter.ai/docs/api-reference/overview). Trust it over the
    // catalog-rate estimate, scaling the component breakdown to match.
    let reported_cost = if model.provider == "openrouter" {
        openrouter_reported_cost(raw_usage)
    } else {
        None
    };
    if let Some(reported_cost) = reported_cost {
        if usage.cost.total.as_f64() > 0.0 {
            let scale = reported_cost / usage.cost.total.as_f64();
            usage.cost.input = (usage.cost.input.as_f64() * scale).into();
            usage.cost.output = (usage.cost.output.as_f64() * scale).into();
            usage.cost.cache_read = (usage.cost.cache_read.as_f64() * scale).into();
            usage.cost.cache_write = (usage.cost.cache_write.as_f64() * scale).into();
        } else if usage.total_tokens > 0 {
            // No catalog rates to apportion by: attribute by token counts instead.
            let total_tokens = usage.total_tokens as f64;
            usage.cost.input = (reported_cost * usage.input as f64 / total_tokens).into();
            usage.cost.output = (reported_cost * usage.output as f64 / total_tokens).into();
            usage.cost.cache_read = (reported_cost * usage.cache_read as f64 / total_tokens).into();
            usage.cost.cache_write =
                (reported_cost * usage.cache_write as f64 / total_tokens).into();
        }
        usage.cost.total = reported_cost.into();
    }
    usage
}

/// The user's real spend for an `OpenRouter` request, or `None` to keep the
/// catalog estimate. `usage.cost` only carries what `OpenRouter` charged the
/// account's credits: for BYOK requests that is just `OpenRouter`'s fee, so
/// real spend is the upstream provider's bill plus that fee. A cost of 0 can
/// mean not-billed-via-credits (e.g. `:free` endpoints) rather than free, so
/// it keeps the catalog estimate.
fn openrouter_reported_cost(raw_usage: &Value) -> Option<f64> {
    let credits = raw_usage
        .get("cost")
        .and_then(Value::as_f64)
        .filter(|cost| *cost > 0.0);
    if raw_usage.get("is_byok").and_then(Value::as_bool) == Some(true) {
        let upstream = raw_usage
            .get("cost_details")
            .and_then(|details| details.get("upstream_inference_cost"))
            .and_then(Value::as_f64);
        return upstream
            .filter(|upstream| *upstream > 0.0)
            .map(|upstream| upstream + credits.unwrap_or(0.0));
    }
    credits
}

pub(crate) fn map_stop_reason(reason: &str) -> (StopReason, Option<String>) {
    match reason {
        "stop" | "end" => (StopReason::Stop, None),
        "length" => (StopReason::Length, None),
        "function_call" | "tool_calls" => (StopReason::ToolUse, None),
        "content_filter" => (
            StopReason::Error,
            Some("Provider finish_reason: content_filter".to_string()),
        ),
        "network_error" => (
            StopReason::Error,
            Some("Provider finish_reason: network_error".to_string()),
        ),
        other => (
            StopReason::Error,
            Some(format!("Provider finish_reason: {other}")),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ModelCost, ModelInput};
    use pa_types::JsNumber;

    fn model(provider: &str, input: f64, output: f64) -> Model {
        Model {
            id: "m".into(),
            name: "m".into(),
            api: "openai-completions".into(),
            provider: provider.into(),
            base_url: "http://localhost".into(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![ModelInput::Text],
            cost: ModelCost {
                input: JsNumber::from(input),
                output: JsNumber::from(output),
                cache_read: JsNumber::from(0.0),
                cache_write: JsNumber::from(0.0),
            },
            context_window: 128_000,
            max_tokens: 8192,
            featured: None,
            headers: None,
            compat: None,
        }
    }

    enum ByokBilling {
        NotByok,
        FeeOnly,
        WithUpstreamBill(f64),
    }

    fn raw_usage(cost: f64, byok: ByokBilling) -> Value {
        let mut raw = json!({
            "prompt_tokens": 50_000,
            "completion_tokens": 50_000,
            "total_tokens": 100_000,
            "cost": cost,
        });
        match byok {
            ByokBilling::NotByok => {}
            ByokBilling::FeeOnly => raw["is_byok"] = json!(true),
            ByokBilling::WithUpstreamBill(upstream) => {
                raw["is_byok"] = json!(true);
                raw["cost_details"] = json!({ "upstream_inference_cost": upstream });
            }
        }
        raw
    }

    #[test]
    fn openrouter_zero_reported_cost_keeps_catalog_estimate() {
        let model = model("openrouter", 0.5, 0.5);
        // A cost of 0 can mean not-billed-via-credits (:free endpoints)
        // rather than free, so the catalog estimate stays.
        let usage = parse_chunk_usage(&raw_usage(0.0, ByokBilling::NotByok), &model, None);
        assert!((usage.cost.total.as_f64() - 0.05).abs() < 1e-9);
    }

    #[test]
    fn openrouter_byok_without_upstream_keeps_catalog_estimate() {
        let model = model("openrouter", 0.5, 0.5);
        // BYOK credits are only OpenRouter's fee; without the upstream bill
        // the real spend is unknown, so the catalog estimate stays.
        let usage = parse_chunk_usage(&raw_usage(0.003, ByokBilling::FeeOnly), &model, None);
        assert!((usage.cost.total.as_f64() - 0.05).abs() < 1e-9);
    }

    #[test]
    fn openrouter_byok_upstream_cost_replaces_catalog_estimate() {
        let model = model("openrouter", 0.5, 0.5);
        // Credits charged by OpenRouter plus the upstream provider's bill.
        let usage = parse_chunk_usage(
            &raw_usage(0.003, ByokBilling::WithUpstreamBill(0.2)),
            &model,
            None,
        );
        assert!((usage.cost.input.as_f64() - 0.1015).abs() < 1e-9);
        assert!((usage.cost.output.as_f64() - 0.1015).abs() < 1e-9);
        assert!((usage.cost.total.as_f64() - 0.203).abs() < 1e-9);
    }

    #[test]
    fn openrouter_reported_cost_apportioned_by_tokens_without_rates() {
        let model = model("openrouter", 0.0, 0.0);
        let raw = json!({"prompt_tokens": 40_000, "completion_tokens": 10_000, "total_tokens": 50_000, "cost": 0.15});
        let usage = parse_chunk_usage(&raw, &model, None);
        assert!((usage.cost.input.as_f64() - 0.12).abs() < 1e-9);
        assert!((usage.cost.output.as_f64() - 0.03).abs() < 1e-9);
        assert!((usage.cost.cache_read.as_f64() - 0.0).abs() < 1e-9);
        assert!((usage.cost.total.as_f64() - 0.15).abs() < 1e-9);
    }

    #[test]
    fn non_openrouter_provider_ignores_reported_cost() {
        let model = model("zai", 0.5, 0.5);
        let usage = parse_chunk_usage(&raw_usage(0.07, ByokBilling::NotByok), &model, None);
        assert!((usage.cost.total.as_f64() - 0.05).abs() < 1e-9);
    }
}
