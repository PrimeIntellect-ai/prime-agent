//! The ai wire-type unit battery: tier eligibility, round trips, serde shapes.
use super::*;

/// A minimal model for the tier-eligibility predicate (the same combinations as TS #2144's gating
/// tests).
fn tier_model(provider: &str, api: &str, id: &str) -> Model {
    let zero_cost = || ModelCost {
        input: JsNumber(0.0),
        output: JsNumber(0.0),
        cache_read: JsNumber(0.0),
        cache_write: JsNumber(0.0),
    };
    Model {
        id: id.to_string(),
        name: id.to_string(),
        api: api.to_string(),
        provider: provider.to_string(),
        base_url: "https://example.invalid/v1".to_string(),
        reasoning: false,
        thinking_level_map: None,
        input: Vec::new(),
        cost: zero_cost(),
        context_window: 0,
        max_tokens: 0,
        featured: None,
        headers: None,
        compat: None,
    }
}

#[test]
fn service_tier_eligibility_matches_ts() {
    use ServiceTier::*;
    // `default` is always accepted (it means no tier request at all).
    for (provider, api, id) in [
        ("anthropic", "anthropic-messages", "claude-fable-5"),
        ("openrouter", "openai-completions", "openai/gpt-5.5"),
        ("openai", "openai-responses", "gpt-5.5"),
    ] {
        let model = tier_model(provider, api, id);
        assert!(supports_service_tier(&model, Default));
    }
    // OpenRouter accepts flex/priority for every completions model and nothing else.
    let openrouter = tier_model("openrouter", "openai-completions", "openai/qwen-4.9");
    assert!(supports_service_tier(&openrouter, Flex));
    assert!(supports_service_tier(&openrouter, Priority));
    assert!(!supports_service_tier(&openrouter, Auto));
    assert!(!supports_service_tier(&openrouter, Scale));
    // The Responses APIs take auto/scale everywhere, priority on the
    // eligible ids (#2144), and flex only on the API-key backend's ids.
    let codex = tier_model("openai-codex", "openai-codex-responses", "gpt-5.5");
    assert!(supports_service_tier(&codex, Auto));
    assert!(supports_service_tier(&codex, Scale));
    assert!(supports_service_tier(&codex, Priority));
    assert!(!supports_service_tier(&codex, Flex));
    let codex_astra = tier_model("openai-codex", "openai-codex-responses", "gpt-6-astra");
    assert!(supports_service_tier(&codex_astra, Priority));
    let openai = tier_model("openai", "openai-responses", "gpt-5.4");
    assert!(supports_service_tier(&openai, Flex));
    let codex_ineligible = tier_model("openai-codex", "openai-codex-responses", "gpt-5.1");
    assert!(!supports_service_tier(&codex_ineligible, Priority));
    // Completions models outside OpenRouter never take a tier.
    let direct = tier_model("openai", "openai-completions", "gpt-5.5");
    assert!(!supports_service_tier(&direct, Priority));
    // #2144 makes the OpenRouter completions models fast-mode-eligible too.
    assert!(supports_fast_mode(&codex));
    assert!(supports_fast_mode(&openrouter));
    assert!(!supports_fast_mode(&codex_ineligible));
}

#[test]
fn clamp_service_tier_degrades_unsupported_requests() {
    use ServiceTier::*;
    let openai = tier_model("openai", "openai-responses", "gpt-5.5");
    let other = tier_model("anthropic", "anthropic-messages", "claude-fable-5");
    assert_eq!(clamp_service_tier(Some(&openai), Some(Flex)), Some(Flex));
    assert_eq!(clamp_service_tier(Some(&other), Some(Flex)), Some(Default));
    assert_eq!(
        clamp_service_tier(Some(&other), Some(Priority)),
        Some(Default)
    );
    // An absent model clamps every non-default tier (TS `model == null`).
    assert_eq!(clamp_service_tier(None, Some(Priority)), Some(Default));
    // Default and an unset preference pass through untouched.
    assert_eq!(clamp_service_tier(None, Some(Default)), Some(Default));
    assert_eq!(clamp_service_tier(None, None), None);
}

fn rt<T: serde::Serialize + for<'de> Deserialize<'de>>(json: &str) -> String {
    let parsed: T = serde_json::from_str(json).expect("deserialize");
    serde_json::to_string(&parsed).expect("serialize")
}

fn assert_roundtrip<T: serde::Serialize + for<'de> Deserialize<'de>>(json: &str) {
    let original: Value = serde_json::from_str(json).unwrap();
    let out = rt::<T>(json);
    let reparsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(original, reparsed, "round trip changed the value: {out}");
}

#[test]
fn user_message_content_string_or_blocks() {
    assert_roundtrip::<Message>(r#"{"role":"user","content":"hello","timestamp":1}"#);
    assert_roundtrip::<Message>(
        r#"{"role":"user","content":[{"type":"text","text":"a"},{"type":"image","data":"QQ==","mimeType":"image/png"}],"timestamp":2}"#,
    );
}

#[test]
fn assistant_message_roundtrip_and_unknown_fields() {
    assert_roundtrip::<Message>(
        r#"{"role":"assistant","content":[{"type":"thinking","thinking":"t","thinkingSignature":"r","redacted":false},{"type":"toolCall","id":"1","name":"bash","arguments":{"code":"ls"},"thoughtSignature":"g"},{"type":"text","text":"done","textSignature":"{\"v\":1,\"id\":\"x\"}"}],"api":"openai-completions","provider":"p","model":"m","responseModel":"m2","responseId":"rid","usage":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4,"totalTokens":10,"cost":{"input":0.5,"output":0.25,"cacheRead":0,"cacheWrite":0,"total":0.75}},"stopReason":"toolUse","stopReasonRaw":"stop_sequence","timestamp":9,"future":"kept"}"#,
    );
}

#[test]
fn stream_event_roundtrip() {
    let msg = r#"{"role":"assistant","content":[],"api":"a","provider":"p","model":"m","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1}"#;
    assert_roundtrip::<AssistantMessageEvent>(&format!(
        r#"{{"type":"text_delta","contentIndex":3,"delta":"abc","partial":{msg}}}"#
    ));
    assert_roundtrip::<AssistantMessageEvent>(&format!(
        r#"{{"type":"done","reason":"toolUse","message":{msg}}}"#
    ));
    assert_roundtrip::<AssistantMessageEvent>(&format!(
        r#"{{"type":"error","reason":"aborted","error":{msg}}}"#
    ));
}

#[test]
fn tool_result_message_roundtrip() {
    assert_roundtrip::<Message>(
        r#"{"role":"toolResult","toolCallId":"c1","toolName":"ipython","content":[{"type":"text","text":"out"}],"details":{"durationMs":3},"isError":false,"timestamp":4}"#,
    );
}

#[test]
fn model_with_compat_roundtrip() {
    // Anthropic-flavored compat is recognized by its distinctive key.
    assert_roundtrip::<Model>(
        r#"{"id":"m","name":"M","api":"anthropic-messages","provider":"anthropic","baseUrl":"https://x","reasoning":true,"input":["text","image"],"cost":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75},"contextWindow":200000,"maxTokens":8192,"thinkingLevelMap":{"minimal":null,"low":"low"},"compat":{"supportsEagerToolInputStreaming":false},"headers":{"x":"y"},"featured":true}"#,
    );
    assert_roundtrip::<Model>(
        r#"{"id":"m2","name":"M2","api":"openai-completions","provider":"p","baseUrl":"https://y","reasoning":false,"input":["text"],"cost":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0},"contextWindow":1000,"maxTokens":100,"compat":{"thinkingFormat":"openrouter","openRouterRouting":{"only":["a"],"sort":{"by":"price","partition":"model"},"max_price":{"prompt":"0.5","completion":2}}}}"#,
    );
}

#[test]
fn user_content_untagged_text_block_roundtrips_losslessly() {
    // Live session files carry user text blocks without a `type` tag (earlier daemon builds); the
    // block round-trips verbatim, no injected tag.
    assert_roundtrip::<Message>(r#"{"role":"user","content":[{"text":"hi"}],"timestamp":3}"#);
}

#[test]
fn user_content_unknown_block_kind_is_preserved() {
    // A newer build's block kind must never fail the load.
    assert_roundtrip::<Message>(
        r#"{"role":"user","content":[{"type":"video","url":"x","meta":{"a":1}}],"timestamp":4}"#,
    );
}

#[test]
fn bare_block_payload_views() {
    let content: UserContent = serde_json::from_str(
        r#"[{"text":"hi"},{"type":"image","data":"QQ==","mimeType":"image/png"},{"type":"file","id":"f"}]"#,
    )
    .unwrap();
    // Tag-strict display text ignores un-modeled blocks (TS `block.type === "text"`).
    assert_eq!(content.text(), "");
    let UserContent::Blocks(blocks) = content else {
        panic!("expected blocks");
    };
    // Provider payload views recover the bare text/image structurally.
    assert_eq!(blocks[0].text(), Some("hi"));
    assert_eq!(blocks[1].image(), Some(("QQ==", "image/png")));
    assert_eq!(blocks[2].text(), None);
    assert_eq!(blocks[2].image(), None);
}

#[test]
fn user_content_text_helper() {
    let content: UserContent = serde_json::from_str(
        r#"[{"type":"text","text":"a b"},{"type":"image","data":"x","mimeType":"i"},{"type":"text","text":"c"}]"#,
    )
    .unwrap();
    assert_eq!(content.text(), "a b c");
}
