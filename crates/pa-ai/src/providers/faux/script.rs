//! Scripted faux provider registration from a JSON script (the verification
//! seam shared by pa-cli's `PRIME_AGENT_FAUX_SCRIPT` harness and the daemon
//! worker). Entries carry plain text or content-block arrays (thinking, text,
//! tool calls) so visual and behavioral harnesses can script full turns.

use serde_json::Value;

use super::{
    faux_assistant_message, faux_text, faux_thinking, faux_tool_call, register_faux_provider,
    FauxAssistantMessageOptions, FauxModelDefinition, FauxProviderRegistration, FauxResponseStep,
    RegisterFauxProviderOptions,
};
use crate::types::StopReason;

/// A parsed faux script: model definition plus queued response steps.
#[derive(Clone)]
pub struct FauxScript {
    pub model: FauxModelDefinition,
    pub tokens_per_second: Option<f64>,
    pub responses: Vec<FauxResponseStep>,
}

/// Parse a `{"responses": [...], "modelId": ..., "tokensPerSecond": ...}` script.
///
/// Entry forms: a plain string, `{"text": "..."}`, or
/// `{"content": [{"type": "thinking"|"text"|"toolCall", ...}], "stopReason"?}`.
/// The stop reason defaults to `toolUse` when the entry carries a tool call.
///
/// # Errors
///
/// Returns `Err` when the script is not a JSON object, when `responses` is not
/// an array, or when a response entry or content block is malformed (wrong
/// entry or block type, unknown stop reason, or missing block fields).
pub fn parse_faux_script(script: &Value) -> Result<FauxScript, String> {
    let Some(object) = script.as_object() else {
        return Err("the faux script must be a JSON object".to_string());
    };
    let model = FauxModelDefinition {
        id: object
            .get("modelId")
            .and_then(Value::as_str)
            .unwrap_or("faux-1")
            .to_string(),
        name: Some(
            object
                .get("modelName")
                .and_then(Value::as_str)
                .unwrap_or("Faux Model")
                .to_string(),
        ),
        reasoning: Some(
            object
                .get("reasoning")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        input: Some(vec![
            crate::types::ModelInput::Text,
            crate::types::ModelInput::Image,
        ]),
        cost: None,
        context_window: Some(
            object
                .get("contextWindow")
                .and_then(Value::as_u64)
                .unwrap_or(128_000),
        ),
        // The default request budget mirrors the registry faux model;
        // scripts override it (the combined input+output ceiling fixtures
        // need a small window and a small output budget).
        max_tokens: Some(
            object
                .get("maxTokens")
                .and_then(Value::as_u64)
                .unwrap_or(16_384),
        ),
    };
    let tokens_per_second = object
        .get("tokensPerSecond")
        .and_then(Value::as_f64)
        .filter(|rate| *rate > 0.0);
    let responses = match object.get("responses") {
        None => Vec::new(),
        Some(Value::Array(entries)) => entries
            .iter()
            .map(parse_script_step)
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("the faux script responses must be an array".to_string()),
    };
    Ok(FauxScript {
        model,
        tokens_per_second,
        responses,
    })
}

/// Parse one scripted response entry into a queued faux step.
fn parse_script_step(entry: &Value) -> Result<FauxResponseStep, String> {
    let content = match entry {
        Value::String(text) => vec![faux_text(text)],
        Value::Object(map) => {
            if let Some(blocks) = map.get("content").and_then(Value::as_array) {
                blocks
                    .iter()
                    .map(parse_content_block)
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                vec![faux_text(
                    map.get("text").and_then(Value::as_str).unwrap_or_default(),
                )]
            }
        }
        _ => return Err("a faux script response must be a string or object".to_string()),
    };
    let stop_reason = match entry.get("stopReason").and_then(Value::as_str) {
        Some("stop") => Some(StopReason::Stop),
        Some("length") => Some(StopReason::Length),
        Some("toolUse") => Some(StopReason::ToolUse),
        Some("error") => Some(StopReason::Error),
        Some("aborted") => Some(StopReason::Aborted),
        Some(other) => return Err(format!("unknown faux script stopReason {other}")),
        None => None,
    };
    // Optional scripted error text (verification harness only): rides the
    // message with `stopReason: "error"`, so overflow-recovery harnesses can
    // script provider overflow responses.
    let error_message = entry
        .get("errorMessage")
        .and_then(Value::as_str)
        .map(str::to_string);
    let stop_reason = stop_reason.unwrap_or({
        let has_tool_call = content
            .iter()
            .any(|block| matches!(block, super::AssistantContent::ToolCall(_)));
        if has_tool_call {
            StopReason::ToolUse
        } else {
            StopReason::Stop
        }
    });
    // Optional harness pacing: `delayMs` holds the stream closed before
    // the first delta (verification harness only).
    let delay_ms = entry
        .get("delayMs")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let message = faux_assistant_message(
        content,
        FauxAssistantMessageOptions {
            stop_reason: Some(stop_reason),
            error_message,
            ..Default::default()
        },
    );
    Ok(if delay_ms > 0 {
        FauxResponseStep::Delayed { message, delay_ms }
    } else {
        FauxResponseStep::Message(message)
    })
}

/// Parse one scripted content block (thinking, text, or tool call).
fn parse_content_block(block: &Value) -> Result<super::AssistantContent, String> {
    let Some(object) = block.as_object() else {
        return Err("a faux script content block must be an object".to_string());
    };
    match object.get("type").and_then(Value::as_str) {
        Some("thinking") => Ok(faux_thinking(
            object
                .get("thinking")
                .and_then(Value::as_str)
                .ok_or("a thinking block needs thinking text")?,
        )),
        Some("text") => Ok(faux_text(
            object
                .get("text")
                .and_then(Value::as_str)
                .ok_or("a text block needs text")?,
        )),
        Some("toolCall") => {
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .ok_or("a toolCall block needs a name")?;
            let arguments = object.get("arguments").cloned().unwrap_or(Value::Null);
            let id = object.get("id").and_then(Value::as_str);
            Ok(faux_tool_call(name, arguments, id))
        }
        Some(other) => Err(format!("unknown faux script content type {other}")),
        None => Err("a faux script content block needs a type".to_string()),
    }
}

/// Register a faux provider from a parsed script and queue its responses.
pub fn register_faux_provider_from_script(script: &FauxScript) -> FauxProviderRegistration {
    let registration = register_faux_provider(RegisterFauxProviderOptions {
        api: Some("faux".to_string()),
        provider: Some("faux".to_string()),
        models: Some(vec![script.model.clone()]),
        tokens_per_second: script.tokens_per_second,
        token_size_min: None,
        token_size_max: None,
    });
    registration.set_responses(script.responses.clone());
    registration
}
