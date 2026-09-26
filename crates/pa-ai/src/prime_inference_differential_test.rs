//! Live differential test against the prime-inference endpoint.
//!
//! Streams the captured real SSE exchange with `z-ai/glm-5.3-flash` (saved in
//! `tests/testdata/prime_inference_glm53_flash.sse`) through a local replay
//! server, runs both the TS reference provider (via `tests/differential/`)
//! and this Rust port against it, and requires identical assistant text and
//! usage accounting.
//!
//! Ignored by default (needs the replay server and the TS baseline). Run:
//!
//! ```sh
//! tests/differential/run.sh
//! ```

use serde_json::{json, Map, Value};

use crate::providers::openai_completions::{stream_openai_completions, OpenAICompletionsOptions};
use crate::types::{AssistantContent, Model, StopReason, StreamOptions};

/// Model entry mirroring the prime-inference catalog entry for
/// `z-ai/glm-5.3-flash`.
fn glm_53_flash(base_url: &str) -> Model {
    let compat_json = json!({
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true,
        "maxTokensField": "max_tokens",
        "supportsStrictMode": false,
    });
    Model {
        id: "z-ai/glm-5.3-flash".into(),
        name: "GLM 5.3 Flash".into(),
        api: "openai-completions".into(),
        provider: "prime-inference".into(),
        base_url: base_url.into(),
        reasoning: true,
        thinking_level_map: None,
        input: vec![
            crate::types::ModelInput::Text,
            crate::types::ModelInput::Image,
        ],
        cost: crate::types::ModelCost {
            input: 0.15.into(),
            output: 0.5.into(),
            cache_read: 0.0.into(),
            cache_write: 0.0.into(),
        },
        context_window: 1_310_720,
        max_tokens: 131_072,
        featured: None,
        headers: None,
        compat: Some(crate::types::ModelCompat::from_kind(
            crate::types::CompatKind::OpenAiCompletions(Box::new(
                serde_json::from_value(compat_json).expect("compat parses"),
            )),
        )),
    }
}

async fn normalized_result(model: &Model) -> Value {
    let context = crate::types::Context {
        system_prompt: Some("You are a helpful assistant. Be concise.".into()),
        messages: vec![crate::types::Message::User(crate::types::UserMessage {
            content: crate::types::UserMessageContent::Text(
                "In one short sentence: what is the capital of France, and what is 7 times 8?"
                    .into(),
            ),
            timestamp: 1_789_529_142_000,
            rest: Map::default(),
        })],
        tools: None,
    };
    let options = OpenAICompletionsOptions::from_base(StreamOptions {
        api_key: Some("replay".into()),
        ..Default::default()
    });
    let stream = stream_openai_completions(model, &context, Some(&options));
    let result = stream.result().await;
    let content: Vec<Value> = result
        .content
        .iter()
        .map(|block| match block {
            AssistantContent::Thinking(thinking) => {
                // Match the TS driver normalization: `redacted` is omitted when
                // unset (undefined fields are dropped by JSON.stringify).
                let mut value = json!({
                    "type": "thinking",
                    "thinking": thinking.thinking,
                });
                if let Some(redacted) = thinking.redacted {
                    value["redacted"] = json!(redacted);
                }
                value
            }
            AssistantContent::Text(text) => json!({
                "type": "text",
                "text": text.text,
            }),
            AssistantContent::ToolCall(tool_call) => json!({
                "type": "toolCall",
                "id": tool_call.id,
                "name": tool_call.name,
                "arguments": tool_call.arguments,
            }),
        })
        .collect();
    json!({
        "content": content,
        "usage": {
            "input": result.usage.input,
            "output": result.usage.output,
            "cacheRead": result.usage.cache_read,
            "cacheWrite": result.usage.cache_write,
            "totalTokens": result.usage.total_tokens,
            "cost": {
                "input": result.usage.cost.input.as_f64(),
                "output": result.usage.cost.output.as_f64(),
                "cacheRead": result.usage.cost.cache_read.as_f64(),
                "cacheWrite": result.usage.cost.cache_write.as_f64(),
                "total": result.usage.cost.total.as_f64(),
            },
        },
        "stopReason": result.stop_reason,
        "responseModel": result.response_model,
        "responseId": result.response_id,
        "errorMessage": result.error_message,
    })
}

#[tokio::test]
#[ignore = "needs the SSE replay server and the TS baseline; run tests/differential/run.sh"]
async fn differential_prime_inference_glm_53_flash() {
    let replay_base_url = std::env::var("PA_DIFF_REPLAY_URL")
        .expect("PA_DIFF_REPLAY_URL must point at the replay server base URL");
    let expected_path = std::env::var("PA_DIFF_EXPECTED")
        .expect("PA_DIFF_EXPECTED must point at the TS baseline JSON file");
    let expected_text = std::fs::read_to_string(&expected_path).expect("read TS baseline");
    let expected: Value = serde_json::from_str(&expected_text).expect("parse TS baseline");

    let model = glm_53_flash(&replay_base_url);
    let actual = normalized_result(&model).await;

    // Compare content and identity fields exactly.
    assert_eq!(
        actual["content"], expected["content"],
        "assistant content differs from the TS reference"
    );
    assert_eq!(
        actual["stopReason"], expected["stopReason"],
        "stop reason differs from the TS reference"
    );
    assert_eq!(
        actual["responseId"], expected["responseId"],
        "response id differs from the TS reference"
    );
    assert_eq!(
        actual["responseModel"], expected["responseModel"],
        "response model differs from the TS reference"
    );
    assert_eq!(
        actual["errorMessage"], expected["errorMessage"],
        "error message differs from the TS reference"
    );

    // Usage accounting: token counts exact, costs within float epsilon.
    for field in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] {
        assert_eq!(
            actual["usage"][field], expected["usage"][field],
            "usage.{field} differs from the TS reference"
        );
    }
    for field in ["input", "output", "cacheRead", "cacheWrite", "total"] {
        let left = actual["usage"]["cost"][field].as_f64().unwrap_or(0.0);
        let right = expected["usage"]["cost"][field].as_f64().unwrap_or(0.0);
        assert!(
            (left - right).abs() < 1e-9,
            "usage.cost.{field} differs from the TS reference: {left} vs {right}"
        );
    }

    // Stop reason should be a clean stop for the captured stream.
    assert_eq!(expected["stopReason"], json!("stop"));
    let _ = StopReason::Stop;
}
