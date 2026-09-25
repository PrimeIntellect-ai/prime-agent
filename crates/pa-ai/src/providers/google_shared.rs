//! Google Generative AI / Vertex shared utilities.
//! Port of `packages/ai/src/providers/google-shared.ts`: message/tool
//! conversion with thought-signature replay, thinking budgets and levels,
//! finish-reason and tool-choice mapping. The shared stream-chunk processor
//! lives in [`crate::providers::google_stream`].

use serde_json::{json, Map, Value};

use crate::providers::transform_messages::transform_messages_with_normalizer;
use crate::types::{AssistantContent, Context, Model, ModelExt, StopReason, ThinkingBudgets, Tool};
use crate::utils_inner::sanitize_unicode::sanitize_surrogates;

#[allow(unused_imports)]
pub use crate::providers::google_stream::GoogleStreamState;

pub const API_GOOGLE_GENERATIVE_AI: &str = "google-generative-ai";
pub const API_GOOGLE_VERTEX: &str = "google-vertex";

/// Thinking level values accepted by Gemini 3 models (`GoogleThinkingLevel`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // full TS option surface; the UNSPECIFIED variant is accepted wire input
pub enum GoogleThinkingLevel {
    ThinkingLevelUnspecified,
    Minimal,
    Low,
    Medium,
    High,
}

impl GoogleThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            GoogleThinkingLevel::ThinkingLevelUnspecified => "THINKING_LEVEL_UNSPECIFIED",
            GoogleThinkingLevel::Minimal => "MINIMAL",
            GoogleThinkingLevel::Low => "LOW",
            GoogleThinkingLevel::Medium => "MEDIUM",
            GoogleThinkingLevel::High => "HIGH",
        }
    }
}

/// Budget-based thinking levels in the model-facing thinking surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GoogleBudgetThinkingLevel {
    Minimal,
    Low,
    Medium,
    High,
}

impl GoogleBudgetThinkingLevel {
    fn budget_key(self) -> &'static str {
        match self {
            GoogleBudgetThinkingLevel::Minimal => "minimal",
            GoogleBudgetThinkingLevel::Low => "low",
            GoogleBudgetThinkingLevel::Medium => "medium",
            GoogleBudgetThinkingLevel::High => "high",
        }
    }
}

/// Thinking budget for budget-based Gemini models (-1 = dynamic).
pub fn get_google_thinking_budget(
    model_id: &str,
    effort: GoogleBudgetThinkingLevel,
    custom_budgets: Option<&ThinkingBudgets>,
) -> i64 {
    let custom = match effort {
        GoogleBudgetThinkingLevel::Minimal => custom_budgets.and_then(|b| b.minimal),
        GoogleBudgetThinkingLevel::Low => custom_budgets.and_then(|b| b.low),
        GoogleBudgetThinkingLevel::Medium => custom_budgets.and_then(|b| b.medium),
        GoogleBudgetThinkingLevel::High => custom_budgets.and_then(|b| b.high),
    };
    if let Some(custom) = custom {
        return custom as i64;
    }

    let (minimal, low, medium, high): (i64, i64, i64, i64) = if model_id.contains("2.5-pro") {
        (128, 2048, 8192, 32768)
    } else if model_id.contains("2.5-flash-lite") {
        (512, 2048, 8192, 24576)
    } else if model_id.contains("2.5-flash") {
        (128, 2048, 8192, 24576)
    } else {
        return -1;
    };
    match effort.budget_key() {
        "minimal" => minimal,
        "low" => low,
        "medium" => medium,
        "high" => high,
        _ => -1,
    }
}

/// Whether a streamed Gemini part should be treated as thinking content.
///
/// Protocol note: `thought: true` is the definitive marker; `thoughtSignature`
/// can appear on ANY part type and does NOT indicate thinking content.
pub fn is_thinking_part(part: &Value) -> bool {
    part.get("thought") == Some(&json!(true))
}

/// Retain thought signatures during streaming: some backends only send
/// `thoughtSignature` on the first delta of a block; keep the last non-empty
/// one. Never merges or moves signatures across distinct parts.
pub fn retain_thought_signature(existing: Option<&str>, incoming: Option<&str>) -> Option<String> {
    if let Some(incoming) = incoming {
        if !incoming.is_empty() {
            return Some(incoming.to_string());
        }
    }
    existing.map(std::string::ToString::to_string)
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
fn is_valid_thought_signature(signature: Option<&str>) -> bool {
    let Some(signature) = signature else {
        return false;
    };
    if signature.len() % 4 != 0 {
        return false;
    }
    !signature.is_empty()
        && signature
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

/// Retain a thought signature only for the originating provider/model and when
/// it is valid base64.
fn resolve_thought_signature(
    is_same_provider_and_model: bool,
    signature: Option<&str>,
) -> Option<String> {
    if is_same_provider_and_model && is_valid_thought_signature(signature) {
        signature.map(std::string::ToString::to_string)
    } else {
        None
    }
}

/// Whether this Google API model requires tool-call IDs on function calls.
pub fn requires_tool_call_id(model_id: &str) -> bool {
    model_id.starts_with("claude-") || model_id.starts_with("gpt-oss-")
}

fn get_gemini_major_version(model_id: &str) -> Option<u64> {
    let lower = model_id.to_lowercase();
    let stripped = lower.strip_prefix("gemini").map_or(lower.as_str(), |rest| {
        rest.strip_prefix("-live").unwrap_or(rest)
    });
    let digits = stripped.strip_prefix('-')?;
    let major: String = digits.chars().take_while(char::is_ascii_digit).collect();
    major.parse().ok()
}

fn supports_multimodal_function_response(model_id: &str) -> bool {
    match get_gemini_major_version(model_id) {
        Some(version) => version >= 3,
        None => true,
    }
}

/// Convert internal context to Google `contents[]`, preserving replayable
/// signatures only when protocol-valid.
pub fn convert_messages(model: &Model, context: &Context) -> Vec<Value> {
    use crate::types::{Message, UserMessageContent, UserOrToolContent};
    let mut contents: Vec<Value> = Vec::new();
    let normalize_tool_call_id = |id: &str| -> String {
        if !requires_tool_call_id(&model.id) {
            return id.to_string();
        }
        id.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .take(64)
            .collect()
    };

    let transformed =
        transform_messages_with_normalizer(&context.messages, model, &|id, _model, _source| {
            Some(normalize_tool_call_id(id))
        });

    for msg in &transformed {
        match msg {
            Message::User(user) => match &user.content {
                UserMessageContent::Text(text) => contents.push(json!({
                    "role": "user",
                    "parts": [{ "text": sanitize_surrogates(text) }],
                })),
                UserMessageContent::Blocks(blocks) => {
                    let parts: Vec<Value> = blocks
                        .iter()
                        .map(|item| match crate::types::user_block_payload(item) {
                            crate::types::UserBlockPayload::Text(text) => {
                                json!({ "text": sanitize_surrogates(text) })
                            }
                            crate::types::UserBlockPayload::Image { data, mime_type } => json!({
                                "inlineData": {
                                    "mimeType": mime_type,
                                    "data": data,
                                },
                            }),
                            crate::types::UserBlockPayload::Opaque(json) => {
                                json!({ "text": sanitize_surrogates(&json) })
                            }
                        })
                        .collect();
                    if parts.is_empty() {
                        continue;
                    }
                    contents.push(json!({
                        "role": "user",
                        "parts": parts,
                    }));
                }
            },
            Message::Assistant(assistant) => {
                let is_same_provider_and_model =
                    assistant.provider == model.provider && assistant.model == model.id;
                let mut parts: Vec<Value> = Vec::new();

                for block in &assistant.content {
                    match block {
                        AssistantContent::Text(text) => {
                            if text.text.trim().is_empty() {
                                continue;
                            }
                            let mut part = Map::new();
                            part.insert("text".into(), json!(sanitize_surrogates(&text.text)));
                            if let Some(signature) = resolve_thought_signature(
                                is_same_provider_and_model,
                                text.text_signature.as_deref(),
                            ) {
                                part.insert("thoughtSignature".into(), json!(signature));
                            }
                            parts.push(Value::Object(part));
                        }
                        AssistantContent::Thinking(thinking) => {
                            if thinking.thinking.trim().is_empty() {
                                continue;
                            }
                            // Only keep as thinking block if same provider AND
                            // same model; otherwise convert to plain text.
                            let mut part = Map::new();
                            if is_same_provider_and_model {
                                part.insert("thought".into(), json!(true));
                                if let Some(signature) = resolve_thought_signature(
                                    is_same_provider_and_model,
                                    thinking.thinking_signature.as_deref(),
                                ) {
                                    part.insert("thoughtSignature".into(), json!(signature));
                                }
                            }
                            part.insert(
                                "text".into(),
                                json!(sanitize_surrogates(&thinking.thinking)),
                            );
                            parts.push(Value::Object(part));
                        }
                        AssistantContent::ToolCall(tool_call) => {
                            let mut function_call = Map::new();
                            function_call.insert("name".into(), json!(tool_call.name));
                            function_call
                                .insert("args".into(), Value::Object(tool_call.arguments.clone()));
                            if requires_tool_call_id(&model.id) {
                                function_call.insert("id".into(), json!(tool_call.id));
                            }
                            let mut part = Map::new();
                            part.insert("functionCall".into(), Value::Object(function_call));
                            if let Some(signature) = resolve_thought_signature(
                                is_same_provider_and_model,
                                tool_call.thought_signature.as_deref(),
                            ) {
                                part.insert("thoughtSignature".into(), json!(signature));
                            }
                            parts.push(Value::Object(part));
                        }
                    }
                }

                if parts.is_empty() {
                    continue;
                }
                contents.push(json!({
                    "role": "model",
                    "parts": parts,
                }));
            }
            Message::ToolResult(tool_result) => {
                let text_result = tool_result
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        UserOrToolContent::Text(text) => Some(text.text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let image_content: Vec<Value> = if model.supports_image_input() {
                    tool_result
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            UserOrToolContent::Image(image) => Some(json!({
                                "inlineData": {
                                    "mimeType": image.mime_type,
                                    "data": image.data,
                                },
                            })),
                            _ => None,
                        })
                        .collect()
                } else {
                    Vec::new()
                };

                let has_text = !text_result.is_empty();
                let has_images = !image_content.is_empty();
                let model_supports_multimodal_function_response =
                    supports_multimodal_function_response(&model.id);

                // Use "output" for success, "error" for errors per SDK docs.
                let response_value = if has_text {
                    sanitize_surrogates(&text_result)
                } else if has_images {
                    "(see attached image)".to_string()
                } else {
                    String::new()
                };

                let mut function_response = Map::new();
                function_response.insert("name".into(), json!(tool_result.tool_name));
                function_response.insert(
                    "response".into(),
                    if tool_result.is_error {
                        json!({ "error": response_value })
                    } else {
                        json!({ "output": response_value })
                    },
                );
                if has_images && model_supports_multimodal_function_response {
                    function_response.insert("parts".into(), json!(image_content));
                }
                if requires_tool_call_id(&model.id) {
                    function_response.insert("id".into(), json!(tool_result.tool_call_id));
                }
                let function_response_part = json!({
                    "functionResponse": Value::Object(function_response),
                });

                // Cloud Code Assist requires all function responses in a single
                // user turn: merge into the previous one when possible.
                if let Some(last) = contents.last_mut() {
                    let is_user = last.get("role").and_then(|value| value.as_str()) == Some("user");
                    let has_function_response = last
                        .get("parts")
                        .and_then(|value| value.as_array())
                        .is_some_and(|parts| {
                            parts
                                .iter()
                                .any(|part| part.get("functionResponse").is_some())
                        });
                    if is_user && has_function_response {
                        last.get_mut("parts")
                            .and_then(|value| value.as_array_mut())
                            .expect("parts is an array")
                            .push(function_response_part);
                        // For Gemini < 3, images go in a separate user turn.
                        if has_images && !model_supports_multimodal_function_response {
                            contents.push(json!({
                                "role": "user",
                                "parts": [{"text": "Tool result image:"}],
                            }));
                        }
                        continue;
                    }
                }
                contents.push(json!({
                    "role": "user",
                    "parts": [function_response_part],
                }));

                // For Gemini < 3, add images in a separate user message.
                if has_images && !model_supports_multimodal_function_response {
                    contents.push(json!({
                        "role": "user",
                        "parts": [{"text": "Tool result image:"}],
                    }));
                }
            }
        }
    }

    contents
}

const JSON_SCHEMA_META_DECLARATIONS: [&str; 7] = [
    "$schema",
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$vocabulary",
    "$comment",
    "$defs",
    // "definitions" is the pre-draft-2019-09 equivalent of $defs.
];

fn sanitize_for_openapi(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut result = Map::new();
            for (key, value) in map {
                if JSON_SCHEMA_META_DECLARATIONS.contains(&key.as_str()) || key == "definitions" {
                    continue;
                }
                result.insert(key.clone(), sanitize_for_openapi(value));
            }
            Value::Object(result)
        }
        Value::Array(array) => Value::Array(array.iter().map(sanitize_for_openapi).collect()),
        other => other.clone(),
    }
}

/// Convert tools to Gemini function declarations.
///
/// By default uses `parametersJsonSchema` (full JSON Schema). `use_parameters`
/// switches to the legacy OpenAPI `parameters` field (needed for Cloud Code
/// Assist with Claude models).
pub fn convert_tools(tools: &[Tool], use_parameters: bool) -> Option<Vec<Value>> {
    if tools.is_empty() {
        return None;
    }
    Some(vec![json!({
        "functionDeclarations": tools
            .iter()
            .map(|tool| {
                let mut entry = Map::new();
                entry.insert("name".into(), json!(tool.name));
                entry.insert("description".into(), json!(tool.description));
                if use_parameters {
                    entry.insert("parameters".into(), sanitize_for_openapi(&tool.parameters));
                } else {
                    entry.insert("parametersJsonSchema".into(), json!(tool.parameters));
                }
                Value::Object(entry)
            })
            .collect::<Vec<_>>(),
    })])
}

/// Google function-calling modes (`FunctionCallingConfigMode`).
pub fn map_tool_choice(choice: &str) -> &'static str {
    match choice {
        "none" => "NONE",
        "any" => "ANY",
        _ => "AUTO",
    }
}

/// Convert Google finish reasons to the shared stop-reason protocol.
pub fn map_google_stop_reason(reason: &str) -> Result<StopReason, String> {
    match reason {
        "STOP" => Ok(StopReason::Stop),
        "MAX_TOKENS" => Ok(StopReason::Length),
        "BLOCKLIST"
        | "PROHIBITED_CONTENT"
        | "SPII"
        | "SAFETY"
        | "IMAGE_SAFETY"
        | "IMAGE_PROHIBITED_CONTENT"
        | "IMAGE_RECITATION"
        | "IMAGE_OTHER"
        | "RECITATION"
        | "FINISH_REASON_UNSPECIFIED"
        | "OTHER"
        | "LANGUAGE"
        | "MALFORMED_FUNCTION_CALL"
        | "UNEXPECTED_TOOL_CALL"
        | "NO_IMAGE" => Ok(StopReason::Error),
        other => Err(format!("Unhandled stop reason: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Model classification + thinking config
// ---------------------------------------------------------------------------

pub fn is_gemma4_model(model_id: &str) -> bool {
    let lower = model_id.to_lowercase();
    lower.contains("gemma-4") || lower.contains("gemma4")
}

pub fn is_gemini3_pro_model(model_id: &str) -> bool {
    regex_is_match(model_id, r"gemini-3(?:\.\d+)?-pro")
}

pub fn is_gemini3_flash_model(model_id: &str) -> bool {
    regex_is_match(model_id, r"gemini-3(?:\.\d+)?-flash")
}

fn regex_is_match(model_id: &str, pattern: &str) -> bool {
    let regex = regex::Regex::new(pattern).expect("static regex");
    regex.is_match(&model_id.to_lowercase())
}

/// Thinking config for disabled reasoning, per model family.
pub fn get_disabled_thinking_config(model_id: &str) -> Value {
    // Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
    // do not support full thinking-off: use the lowest supported level without
    // includeThoughts so hidden thinking remains invisible.
    if is_gemini3_pro_model(model_id) {
        return json!({ "thinkingLevel": "LOW" });
    }
    if is_gemini3_flash_model(model_id) {
        return json!({ "thinkingLevel": "MINIMAL" });
    }
    if is_gemma4_model(model_id) {
        return json!({ "thinkingLevel": "MINIMAL" });
    }
    // Gemini 2.x supports disabling via thinkingBudget = 0.
    json!({ "thinkingBudget": 0 })
}

/// Map a Prime Agent thinking level to a Gemini 3 thinking level.
pub fn get_thinking_level(
    effort: crate::types::ModelThinkingLevel,
    model_id: &str,
) -> GoogleThinkingLevel {
    use crate::types::ModelThinkingLevel;
    if is_gemini3_pro_model(model_id) {
        return match effort {
            ModelThinkingLevel::Minimal | ModelThinkingLevel::Low => GoogleThinkingLevel::Low,
            _ => GoogleThinkingLevel::High,
        };
    }
    if is_gemma4_model(model_id) {
        return match effort {
            ModelThinkingLevel::Minimal | ModelThinkingLevel::Low => GoogleThinkingLevel::Minimal,
            _ => GoogleThinkingLevel::High,
        };
    }
    match effort {
        ModelThinkingLevel::Minimal => GoogleThinkingLevel::Minimal,
        ModelThinkingLevel::Low => GoogleThinkingLevel::Low,
        ModelThinkingLevel::Medium => GoogleThinkingLevel::Medium,
        _ => GoogleThinkingLevel::High,
    }
}

/// Effort level for budget-based models ("off" clamps up to "high" in TS).
pub fn budget_effort(effort: crate::types::ModelThinkingLevel) -> GoogleBudgetThinkingLevel {
    use crate::types::ModelThinkingLevel;
    match effort {
        ModelThinkingLevel::Minimal => GoogleBudgetThinkingLevel::Minimal,
        ModelThinkingLevel::Low => GoogleBudgetThinkingLevel::Low,
        ModelThinkingLevel::Medium => GoogleBudgetThinkingLevel::Medium,
        _ => GoogleBudgetThinkingLevel::High,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_budgets_per_model() {
        assert_eq!(
            get_google_thinking_budget("gemini-2.5-pro", GoogleBudgetThinkingLevel::High, None),
            32768
        );
        assert_eq!(
            get_google_thinking_budget(
                "gemini-2.5-flash",
                GoogleBudgetThinkingLevel::Minimal,
                None
            ),
            128
        );
        assert_eq!(
            get_google_thinking_budget(
                "gemini-2.5-flash-lite",
                GoogleBudgetThinkingLevel::Low,
                None
            ),
            2048
        );
        assert_eq!(
            get_google_thinking_budget("other-model", GoogleBudgetThinkingLevel::High, None),
            -1
        );
    }

    #[test]
    fn thinking_part_detection() {
        assert!(is_thinking_part(&json!({ "thought": true, "text": "hmm" })));
        // thoughtSignature alone does NOT mark thinking content.
        assert!(!is_thinking_part(
            &json!({ "text": "hi", "thoughtSignature": "AAAA" })
        ));
    }

    #[test]
    fn maps_stop_reasons() {
        assert_eq!(map_google_stop_reason("STOP").unwrap(), StopReason::Stop);
        assert_eq!(
            map_google_stop_reason("MAX_TOKENS").unwrap(),
            StopReason::Length
        );
        assert_eq!(map_google_stop_reason("SAFETY").unwrap(), StopReason::Error);
        assert!(map_google_stop_reason("NEW_THING").is_err());
    }

    #[test]
    fn gemini3_classification() {
        assert!(is_gemini3_pro_model("gemini-3-pro-preview"));
        assert!(is_gemini3_flash_model("Gemini-3.1-Flash"));
        assert!(!is_gemini3_pro_model("gemini-2.5-pro"));
    }
}
