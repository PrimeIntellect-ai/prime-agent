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
        max_tokens_explicit: false,
        featured: None,
        headers: None,
        compat: None,
        serving: None,
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
