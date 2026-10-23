//! Validate reasoning replay before constructing a destination request. Unsupported or
//! signature-bound history must surface a limitation, never become answer text or disappear.

use crate::providers::openai_completions::{
    decode_reasoning_details, get_compat, REASONING_FIELDS,
};
use crate::types::{AssistantContent, AssistantMessage, Context, Message, Model, StopReason};
use base64::Engine as _;

const REPLAY_RECOVERY: &str = "Switch back to a compatible provider, model and account, or start a new session. Compacting may keep recent reasoning and leave this error unresolved.";

pub(crate) const CLAUDE_BINDING_DIAGNOSTICS_BETA: &str = "thinking-binding-controls-2026-08-01";

fn has_native_bedrock_reasoning(source: &AssistantMessage) -> bool {
    source.api == "bedrock-converse-stream"
        && source.content.iter().any(|block| {
            matches!(block, AssistantContent::Thinking(thinking)
            if thinking.redacted.unwrap_or(false)
                || thinking.thinking_signature.as_deref().is_some_and(|signature|
                    !signature.trim().is_empty() && !REASONING_FIELDS.contains(&signature)))
        })
}

/// Native state produced by this exact Bedrock destination is replay provenance for
/// opaque profile identifiers. It establishes representation support, not cryptographic
/// model/account/prefix readability; those bindings remain authoritative at the provider.
pub(crate) fn is_claude_replay_destination(model: &Model, context: &Context) -> bool {
    matches!(
        model.api.as_str(),
        "anthropic-messages" | "bedrock-converse-stream"
    ) && (crate::providers::bedrock::is_anthropic_claude_model(model)
        || model.api == "bedrock-converse-stream"
            && context.messages.iter().any(|message| {
                matches!(message, Message::Assistant(source)
                    if !matches!(source.stop_reason, StopReason::Error | StopReason::Aborted)
                        && source.api == model.api && source.provider == model.provider
                        && source.model == model.id && has_native_bedrock_reasoning(source))
            }))
}

/// Report native binding drops without including reasoning or opaque payloads in errors.
pub(crate) fn validate_input_transformations(
    value: Option<&serde_json::Value>,
) -> Result<(), String> {
    if value
        .and_then(serde_json::Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("type").and_then(serde_json::Value::as_str) == Some("thinking_dropped")
            })
        })
    {
        return Err(format!("The provider dropped replayed reasoning because its native model, account, or conversation binding was not satisfied. Original session history is unchanged. {REPLAY_RECOVERY}"));
    }
    Ok(())
}

/// Request native binding diagnostics for signed Claude history, including account changes
/// invisible to provider/model identifiers. This never selects a drop/relaxation policy.
pub(crate) fn has_claude_reasoning_replay(model: &Model, context: &Context) -> bool {
    is_claude_replay_destination(model, context)
        && context.messages.iter().any(|message| matches!(message, Message::Assistant(source)
            if !matches!(source.stop_reason, StopReason::Error | StopReason::Aborted)
                && source.content.iter().any(|block| matches!(block, AssistantContent::Thinking(_)))))
}

/// Check destination channels and signature bindings without modifying source history.
///
/// # Errors
///
/// Returns a user-visible limitation when the destination cannot retain the reasoning representation.
// Keep destination checks together so a new channel cannot bypass signature validation.
#[allow(clippy::too_many_lines)]
pub(crate) fn validate_reasoning_replay(model: &Model, context: &Context) -> Result<(), String> {
    let claude_destination = is_claude_replay_destination(model, context);
    for message in &context.messages {
        let Message::Assistant(assistant) = message else {
            continue;
        };
        if matches!(
            assistant.stop_reason,
            StopReason::Error | StopReason::Aborted
        ) {
            continue;
        }
        let same_protocol = assistant.provider == model.provider && assistant.api == model.api;
        let same_model = same_protocol && assistant.model == model.id;
        let claude_bridge = !same_protocol
            && claude_destination
            && (assistant.api == "anthropic-messages" || has_native_bedrock_reasoning(assistant));
        let limitation = |detail: &str| {
            format!(
            "Cannot replay reasoning from {}/{} to {}/{}: {detail}. Original session history is unchanged. {REPLAY_RECOVERY}",
            assistant.provider, assistant.model, model.provider, model.id,
        )
        };
        for block in &assistant.content {
            if let AssistantContent::Text(text) = block {
                if matches!(
                    assistant.api.as_str(),
                    "google-generative-ai" | "google-vertex"
                ) && text.text_signature.is_some()
                    && (!same_model
                        || !crate::providers::google_shared::is_valid_thought_signature(
                            text.text_signature.as_deref(),
                        ))
                {
                    return Err(limitation(
                        "the Google adapter cannot retain this text block's source-bound thought signature",
                    ));
                }
            }
            if let AssistantContent::ToolCall(call) = block {
                if let Some(signature) = call.thought_signature.as_deref() {
                    if !same_protocol {
                        return Err(limitation("the tool call carries a source-bound thought signature; destination compatibility has not been verified"));
                    }
                    let supported = match model.api.as_str() {
                        "google-generative-ai" | "google-vertex" => {
                            same_model
                                && crate::providers::google_shared::is_valid_thought_signature(
                                    Some(signature),
                                )
                        }
                        "openai-completions" => {
                            serde_json::from_str::<serde_json::Value>(signature)
                                .is_ok_and(|value| value.is_object())
                        }
                        _ => false,
                    };
                    if !supported {
                        return Err(limitation(
                            "the destination adapter cannot replay this tool thought signature",
                        ));
                    }
                }
            }
            let AssistantContent::Thinking(thinking) = block else {
                continue;
            };
            let channel_marker = thinking
                .thinking_signature
                .as_deref()
                .filter(|field| REASONING_FIELDS.contains(field));
            if !same_protocol
                && !claude_bridge
                && (thinking.redacted.unwrap_or(false)
                    || thinking
                        .thinking_signature
                        .as_deref()
                        .is_some_and(|signature| !signature.trim().is_empty())
                        && channel_marker.is_none())
            {
                return Err(limitation("the reasoning carries a source-bound signature or opaque payload that cannot be translated into plaintext reasoning"));
            }
            if model.api == "openai-completions" {
                let compat = get_compat(model);
                if compat.requires_thinking_as_text {
                    return Err(limitation(
                        "this route requires reasoning as answer text, which is disabled",
                    ));
                }
                let structured_same_protocol = same_protocol
                    && decode_reasoning_details(thinking.thinking_signature.as_deref()).is_some();
                if thinking
                    .thinking_signature
                    .as_deref()
                    .is_some_and(|signature| !signature.trim().is_empty())
                    && channel_marker.is_none()
                    && !structured_same_protocol
                {
                    return Err(limitation(
                        "the Completions adapter cannot replay this source-bound signature",
                    ));
                }
                if thinking.redacted.unwrap_or(false) && !structured_same_protocol {
                    return Err(limitation(
                        "this route cannot replay the opaque reasoning payload",
                    ));
                }
                if compat
                    .reasoning_replay_field
                    .as_deref()
                    .is_some_and(|field| !REASONING_FIELDS.contains(&field))
                {
                    return Err(limitation("the destination reasoning replay field is not a supported reasoning channel"));
                }
                if compat.reasoning_replay_field.is_none()
                    // A field-name marker is protocol metadata, not a model-bound signature.
                    && !((same_model || same_protocol && model.reasoning) && channel_marker.is_some())
                    && !structured_same_protocol
                {
                    return Err(limitation("the destination has no supported reasoning replay channel for this history"));
                }
            } else if matches!(model.api.as_str(), "google-generative-ai" | "google-vertex")
                && !same_model
            {
                return Err(limitation("the Google adapter cannot retain reasoning and thought signatures across this model switch"));
            } else if model.api == "bedrock-converse-stream" && thinking.redacted.unwrap_or(false) {
                if !claude_destination
                    || thinking
                        .thinking_signature
                        .as_deref()
                        .is_none_or(|payload| {
                            base64::engine::general_purpose::STANDARD
                                .decode(payload)
                                .is_err()
                        })
                {
                    return Err(limitation(
                        "the Bedrock destination cannot replay this opaque reasoning payload",
                    ));
                }
            } else if model.api == "mistral-conversations"
                && thinking
                    .thinking_signature
                    .as_deref()
                    .is_some_and(|signature| {
                        !signature.trim().is_empty() && !REASONING_FIELDS.contains(&signature)
                    })
            {
                return Err(limitation(
                    "the Mistral adapter has no thought-signature replay field",
                ));
            } else if matches!(model.api.as_str(), "google-generative-ai" | "google-vertex")
                && thinking
                    .thinking_signature
                    .as_deref()
                    .is_some_and(|signature| {
                        !crate::providers::google_shared::is_valid_thought_signature(Some(
                            signature,
                        ))
                    })
            {
                return Err(limitation(
                    "the original Google thought signature is not valid base64",
                ));
            } else if model.api == "bedrock-converse-stream"
                && !claude_destination
                && thinking
                    .thinking_signature
                    .as_deref()
                    .is_some_and(|signature| {
                        !signature.trim().is_empty() && !REASONING_FIELDS.contains(&signature)
                    })
            {
                return Err(limitation(
                    "the Bedrock adapter cannot replay this reasoning signature for the destination model",
                ));
            } else if (claude_destination
                || model.api == "anthropic-messages"
                    && (thinking.redacted.unwrap_or(false) || channel_marker.is_some()))
                && thinking
                    .thinking_signature
                    .as_deref()
                    .is_none_or(|signature| {
                        signature.trim().is_empty() || REASONING_FIELDS.contains(&signature)
                    })
            {
                return Err(limitation(
                    "this destination requires the original reasoning signature",
                ));
            } else if matches!(
                model.api.as_str(),
                "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
            ) && thinking
                .thinking_signature
                .as_deref()
                .and_then(|signature| serde_json::from_str::<serde_json::Value>(signature).ok())
                .is_none_or(|item| {
                    item.get("type").and_then(serde_json::Value::as_str) != Some("reasoning")
                })
            {
                return Err(limitation("the Responses API requires a replayable reasoning item, not unsigned reasoning text"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(api: &str, signature: Option<&str>) -> (Model, Context) {
        let model = serde_json::from_value(json!({
            "id": "destination", "name": "fixture", "api": api, "provider": "fixture-provider",
            "baseUrl": "http://localhost", "reasoning": true, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128_000, "maxTokens": 8192
        }))
        .unwrap();
        let context = Context {
            system_prompt: None,
            messages: vec![serde_json::from_value(json!({
                "role": "assistant", "api": api, "provider": "fixture-provider", "model": "source",
                "timestamp": 0, "stopReason": "stop", "usage": crate::types::Usage::default(),
                "content": [{ "type": "thinking", "thinking": "SYNTHETIC_PLAN", "thinkingSignature": signature }]
            })).unwrap()],
            tools: None,
        };
        (model, context)
    }

    #[test]
    fn native_reasoning_protocol_does_not_require_identical_model_ids() {
        for (api, signature) in [
            ("anthropic-messages", Some("NATIVE_SIGNATURE")),
            (
                "openai-responses",
                Some(r#"{"type":"reasoning","encrypted_content":"SYNTHETIC_OPAQUE"}"#),
            ),
            ("mistral-conversations", None),
            // Bedrock initializes unsigned reasoning with an empty signature placeholder.
            ("bedrock-converse-stream", Some("")),
            ("openai-completions", Some("reasoning_content")),
        ] {
            let (model, context) = fixture(api, signature);
            let original = context.messages.clone();
            assert_eq!(validate_reasoning_replay(&model, &context), Ok(()));
            assert_eq!(context.messages, original);
        }
    }

    #[test]
    fn bedrock_claude_profile_keeps_its_original_signature_without_model_id_guessing() {
        let (mut model, context) =
            fixture("bedrock-converse-stream", Some("NATIVE_CLAUDE_SIGNATURE"));
        // The Bedrock serializer recognizes Claude application profiles from their names too.
        model.name = "Claude application profile".into();
        let original = context.messages.clone();
        assert_eq!(validate_reasoning_replay(&model, &context), Ok(()));
        assert_eq!(context.messages, original);
    }

    #[test]
    fn google_signed_text_is_replayable_only_where_the_adapter_retains_its_signature() {
        let (mut model, mut context) = fixture("google-generative-ai", None);
        let Message::Assistant(assistant) = &mut context.messages[0] else {
            unreachable!()
        };
        assistant.content = vec![serde_json::from_value(json!({
            "type": "text", "text": "Synthetic answer", "textSignature": "YWJj"
        }))
        .unwrap()];
        let original = context.messages.clone();
        for api in ["google-generative-ai", "openai-completions"] {
            model.api = api.into();
            let error = validate_reasoning_replay(&model, &context).unwrap_err();
            assert!(error.contains("text block's source-bound thought signature"));
            assert!(!error.contains("YWJj"));
            assert_eq!(context.messages, original);
        }
        model.api = "google-generative-ai".into();
        model.id = "source".into();
        assert_eq!(validate_reasoning_replay(&model, &context), Ok(()));
        assert_eq!(context.messages, original);
    }

    #[test]
    fn incompatible_representations_fail_without_losing_original_reasoning() {
        for (api, signature, expected) in [
            (
                "anthropic-messages",
                Some("reasoning_content"),
                "requires the original reasoning signature",
            ),
            (
                "openai-responses",
                None,
                "requires a replayable reasoning item",
            ),
            (
                "google-generative-ai",
                Some("YWJj"),
                "cannot retain reasoning",
            ),
            (
                "openai-completions",
                Some("BOUND_SIGNATURE"),
                "cannot replay this source-bound signature",
            ),
            (
                "bedrock-converse-stream",
                Some("NATIVE_CLAUDE_SIGNATURE"),
                "cannot replay this reasoning signature",
            ),
        ] {
            let (mut model, context) = fixture(api, signature);
            if api == "anthropic-messages" {
                model.name = "Claude fixture".into();
            }
            let original = context.messages.clone();
            let error = validate_reasoning_replay(&model, &context).unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains("SYNTHETIC_PLAN"));
            assert_eq!(context.messages, original);
        }
    }
}

#[cfg(test)]
mod wire_tests;
