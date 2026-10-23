//! Synthetic payload receipts: serializer interoperability, not cryptographic acceptance.
use super::*;
use crate::types::{CacheRetention, Usage};
use serde_json::json;

fn model(api: &str, provider: &str, id: &str) -> Model {
    serde_json::from_value(json!({
        "id": id, "name": id, "api": api, "provider": provider,
        "baseUrl": "http://localhost", "reasoning": true, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128_000, "maxTokens": 8192
    }))
    .unwrap()
}

fn history(source: &Model, content: &serde_json::Value) -> Context {
    Context {
        system_prompt: Some("Synthetic shared prefix".into()),
        messages: vec![serde_json::from_value(json!({
            "role": "assistant", "api": source.api, "provider": source.provider, "model": source.id,
            "timestamp": 0, "stopReason": "stop", "usage": Usage::default(), "content": content
        }))
        .unwrap()],
        tools: None,
    }
}

#[test]
fn unsigned_non_claude_anthropic_thinking_replays_on_the_same_model() {
    let source = model("anthropic-messages", "fireworks", "deepseek-v4");
    let claude = model("anthropic-messages", "anthropic", "claude-sonnet-4-6");
    let bedrock = model(
        "bedrock-converse-stream",
        "amazon-bedrock",
        "anthropic.claude-sonnet-4-6-v1",
    );
    for signature in [None, Some("")] {
        let context = history(
            &source,
            &json!([
                { "type": "thinking", "thinking": "SYNTHETIC_PLAN", "thinkingSignature": signature },
                { "type": "text", "text": "Synthetic answer" }
            ]),
        );
        let original = context.messages.clone();
        assert_eq!(validate_reasoning_replay(&source, &context), Ok(()));
        assert_eq!(
            crate::providers::anthropic::convert_messages(
                &context, &source, /*is_oauth_token*/ false, None
            ),
            vec![json!({ "role": "assistant", "content": [
                { "type": "thinking", "thinking": "SYNTHETIC_PLAN", "signature": "" },
                { "type": "text", "text": "Synthetic answer" }
            ] })]
        );
        for destination in [&claude, &bedrock] {
            let error = validate_reasoning_replay(destination, &context).unwrap_err();
            assert!(
                error.contains("requires the original reasoning signature"),
                "{error}"
            );
        }
        assert_eq!(context.messages, original);
    }
}

#[test]
fn redacted_non_claude_anthropic_thinking_requires_its_opaque_payload() {
    let source = model("anthropic-messages", "fireworks", "deepseek-v4");
    for signature in [None, Some(""), Some("reasoning_content")] {
        let context = history(
            &source,
            &json!([
                { "type": "thinking", "thinking": "[Reasoning redacted]", "thinkingSignature": signature, "redacted": true }
            ]),
        );
        let original = context.messages.clone();
        let error = validate_reasoning_replay(&source, &context).unwrap_err();
        assert!(
            error.contains("requires the original reasoning signature"),
            "{error}"
        );
        assert_eq!(context.messages, original);
    }
}

#[test]
fn completions_channel_markers_are_not_anthropic_reasoning_signatures() {
    let source = model("openai-completions", "zai", "glm-fixture");
    let destination = model("anthropic-messages", "kimi", "kimi-k3");
    for marker in REASONING_FIELDS {
        let context = history(
            &source,
            &json!([
                { "type": "thinking", "thinking": "SYNTHETIC_PLAN", "thinkingSignature": marker }
            ]),
        );
        let original = context.messages.clone();
        let error = validate_reasoning_replay(&destination, &context).unwrap_err();
        assert!(
            error.contains("requires the original reasoning signature"),
            "{error}"
        );
        assert_eq!(context.messages, original);
    }
}

#[test]
fn empty_signed_claude_reasoning_round_trips_across_native_adapters() {
    let anthropic = model("anthropic-messages", "anthropic", "claude-sonnet-4-6");
    let bedrock = model(
        "bedrock-converse-stream",
        "amazon-bedrock",
        "anthropic.claude-sonnet-4-6-v1",
    );
    let profile = model(
        "bedrock-converse-stream",
        "amazon-bedrock",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/synthetic",
    );
    for source in [&anthropic, &bedrock, &profile] {
        let context = history(
            source,
            &json!([
                { "type": "thinking", "thinking": "", "thinkingSignature": "SYNTHETIC_SIGNATURE" },
                { "type": "text", "text": "Synthetic answer" }
            ]),
        );
        let original = context.messages.clone();
        assert_eq!(validate_reasoning_replay(&anthropic, &context), Ok(()));
        assert_eq!(validate_reasoning_replay(&bedrock, &context), Ok(()));
        assert_eq!(
            crate::providers::anthropic::convert_messages(
                &context, &anthropic, /*is_oauth_token*/ false, None
            ),
            vec![json!({ "role": "assistant", "content": [
            { "type": "thinking", "thinking": "", "signature": "SYNTHETIC_SIGNATURE" },
            { "type": "text", "text": "Synthetic answer" }
        ] })]
        );
        assert_eq!(
            crate::providers::bedrock::convert_messages(&context, &bedrock, CacheRetention::None),
            vec![json!({ "role": "assistant", "content": [
                { "reasoningContent": { "reasoningText": { "text": "", "signature": "SYNTHETIC_SIGNATURE" } } },
                { "text": "Synthetic answer" }
            ] })]
        );
        assert_eq!(context.messages, original);
    }
}

#[test]
fn opaque_claude_payload_round_trips_without_rewriting_or_becoming_text() {
    let anthropic = model("anthropic-messages", "anthropic", "claude-sonnet-4-6");
    let bedrock = model(
        "bedrock-converse-stream",
        "amazon-bedrock",
        "anthropic.claude-sonnet-4-6-v1",
    );
    let encoded = base64::engine::general_purpose::STANDARD.encode(b"SYNTHETIC_OPAQUE_BYTES");
    let profile = model(
        "bedrock-converse-stream",
        "amazon-bedrock",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/synthetic",
    );
    for source in [&anthropic, &bedrock, &profile] {
        let context = history(
            source,
            &json!([
                { "type": "thinking", "thinking": "[Reasoning redacted]", "thinkingSignature": encoded, "redacted": true }
            ]),
        );
        let original = context.messages.clone();
        assert_eq!(validate_reasoning_replay(&anthropic, &context), Ok(()));
        assert_eq!(validate_reasoning_replay(&bedrock, &context), Ok(()));
        assert_eq!(
            crate::providers::anthropic::convert_messages(
                &context, &anthropic, /*is_oauth_token*/ false, None
            ),
            vec![
                json!({ "role": "assistant", "content": [{ "type": "redacted_thinking", "data": encoded }] })
            ]
        );
        assert_eq!(
            crate::providers::bedrock::convert_messages(&context, &bedrock, CacheRetention::None),
            vec![
                json!({ "role": "assistant", "content": [{ "reasoningContent": { "redactedContent": encoded } }] })
            ]
        );
        assert_eq!(context.messages, original);
    }
}

#[test]
fn plaintext_source_identity_does_not_override_destination_support() {
    let source = model("openai-completions", "zai", "glm-fixture");
    let destination = model(
        "openai-completions",
        "prime-inference",
        "internal/deepseek-fixture",
    );
    let context = history(
        &source,
        &json!([
            { "type": "thinking", "thinking": "SYNTHETIC_PLAN", "thinkingSignature": "reasoning_content" }
        ]),
    );
    let original = context.messages.clone();
    assert_eq!(validate_reasoning_replay(&destination, &context), Ok(()));
    let compat = crate::providers::openai_completions::get_compat(&destination);
    assert_eq!(
        compat.reasoning_replay_field.as_deref(),
        Some("reasoning_content")
    );
    assert_eq!(
        crate::providers::openai_completions::convert_messages(&destination, &context, &compat)
            .unwrap(),
        vec![
            json!({ "role": "system", "content": "Synthetic shared prefix" }),
            json!({ "role": "assistant", "content": "", "reasoning_content": "SYNTHETIC_PLAN" })
        ]
    );
    for field in ["reasoning", "reasoning_text"] {
        let mut configured = model("openai-completions", "configured-destination", "fixture");
        configured.compat =
            Some(serde_json::from_value(json!({ "reasoningReplayField": field })).unwrap());
        let compat = crate::providers::openai_completions::get_compat(&configured);
        assert_eq!(
            crate::providers::openai_completions::convert_messages(&configured, &context, &compat)
                .unwrap(),
            vec![
                json!({ "role": "developer", "content": "Synthetic shared prefix" }),
                json!({ "role": "assistant", "content": "", field: "SYNTHETIC_PLAN" })
            ]
        );
    }
    assert_eq!(context.messages, original);
}

#[test]
fn native_binding_drops_are_explicit_without_signature_or_reasoning_disclosure() {
    for reason in [
        "model_binding_mismatch",
        "organization_binding_mismatch",
        "prefix_binding_mismatch",
    ] {
        let transformations = json!([{ "type": "thinking_dropped", "reason": reason, "path": "messages.1.content.0" }]);
        let error = validate_input_transformations(Some(&transformations)).unwrap_err();
        assert!(error.contains("provider dropped replayed reasoning"));
        assert!(!error.contains("messages.1.content.0"));
    }
    assert_eq!(validate_input_transformations(Some(&json!([]))), Ok(()));
}

#[test]
fn openrouter_native_details_replay_without_a_plaintext_catalog_capability() {
    let source = model("openai-completions", "openrouter", "source");
    let destination = model("openai-completions", "openrouter", "destination");
    let details = vec![
        json!({"type": "reasoning.encrypted", "data": "SYNTHETIC_OPAQUE", "format": "synthetic", "index": 0}),
    ];
    let signature = crate::providers::openai_completions::encode_reasoning_details(&details);
    let context = history(
        &source,
        &json!([{ "type": "thinking", "thinking": "", "thinkingSignature": signature, "redacted": true }]),
    );
    let original = context.messages.clone();
    assert_eq!(validate_reasoning_replay(&destination, &context), Ok(()));
    let compat = crate::providers::openai_completions::get_compat(&destination);
    assert_eq!(
        crate::providers::openai_completions::convert_messages(&destination, &context, &compat)
            .unwrap(),
        vec![
            json!({"role": "developer", "content": "Synthetic shared prefix"}),
            json!({"role": "assistant", "content": "", "reasoning_details": details})
        ]
    );
    assert_eq!(context.messages, original);
}

#[test]
fn opaque_bedrock_profile_replays_its_own_signed_and_redacted_state() {
    let profile = model(
        "bedrock-converse-stream",
        "amazon-bedrock",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/synthetic",
    );
    let opaque = base64::engine::general_purpose::STANDARD.encode(b"SYNTHETIC_OPAQUE_BYTES");
    for (block, expected) in [
        (
            json!({"type": "thinking", "thinking": "", "thinkingSignature": "SYNTHETIC_SIGNATURE"}),
            json!({"reasoningContent": {"reasoningText": {"text": "", "signature": "SYNTHETIC_SIGNATURE"}}}),
        ),
        (
            json!({"type": "thinking", "thinking": "[Reasoning redacted]", "thinkingSignature": opaque, "redacted": true}),
            json!({"reasoningContent": {"redactedContent": opaque}}),
        ),
    ] {
        let context = history(
            &profile,
            &json!([block, {"type": "text", "text": "SYNTHETIC_ANSWER"}]),
        );
        let original = context.messages.clone();
        assert_eq!(validate_reasoning_replay(&profile, &context), Ok(()));
        assert!(has_claude_reasoning_replay(&profile, &context));
        assert_eq!(
            crate::providers::bedrock::convert_messages(&context, &profile, CacheRetention::None),
            vec![json!({"role": "assistant", "content": [expected, {"text": "SYNTHETIC_ANSWER"}]})]
        );
        assert_eq!(context.messages, original);
    }
}
