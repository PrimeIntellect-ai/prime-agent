//! `compat` validation for catalog entries (`isModelCompat` in the TS).
//!
//! Ported from `packages/ai/src/model-compat-schema.ts`: the top-level keys
//! of a `compat` object must match the schema the model's `api` selects
//! (unknown keys reject the entry), and every value must match its declared
//! type. Nested objects (`OpenRouter` routing preferences, Vercel gateway
//! routing, price caps, percentile thresholds) keep the TS default of
//! allowing additional properties, so the check here is structural, per the
//! `TypeBox` validators — deliberately independent of the permissive
//! `pa_types` wire structs.

use serde_json::Value;

const OPENAI_COMPLETIONS_KEYS: &[&str] = &[
    "zaiToolStream",
    "sendSessionAffinityHeaders",
    "supportsStore",
    "supportsDeveloperRole",
    "supportsReasoningEffort",
    "supportsUsageInStreaming",
    "maxTokensField",
    "requiresToolResultName",
    "requiresAssistantAfterToolResult",
    "requiresThinkingAsText",
    "requiresReasoningContentOnAssistantMessages",
    "thinkingFormat",
    "cacheControlFormat",
    "openRouterRouting",
    "vercelGatewayRouting",
    "supportsStrictMode",
    "supportsLongCacheRetention",
];

const OPENAI_RESPONSES_KEYS: &[&str] = &["sendSessionIdHeader", "supportsLongCacheRetention"];

const ANTHROPIC_MESSAGES_KEYS: &[&str] = &[
    "supportsEagerToolInputStreaming",
    "supportsLongCacheRetention",
];

const THINKING_FORMATS: &[&str] = &[
    "openai",
    "openrouter",
    "deepseek",
    "zai",
    "qwen",
    "qwen-chat-template",
];

/// Whether a catalog entry's `compat` object is valid for its `api`.
///
/// `None` (no compat) is always valid. APIs without a declared compat shape
/// reject every compat object: catalog data can only select among transports
/// the client knows, and unknown compat surfaces are exactly that.
///
/// # Panics
///
/// Never panics: the key-table `expect` is unreachable behind the preceding
/// `None` early return.
pub fn is_model_compat(api: &str, compat: Option<&serde_json::Map<String, Value>>) -> bool {
    let Some(compat) = compat else {
        return true;
    };
    let keys = match api {
        "openai-completions" => Some(OPENAI_COMPLETIONS_KEYS),
        "openai-responses" | "openai-codex-responses" | "azure-openai-responses" => {
            Some(OPENAI_RESPONSES_KEYS)
        }
        "anthropic-messages" => Some(ANTHROPIC_MESSAGES_KEYS),
        _ => None,
    };
    if keys.is_none() {
        return false;
    }
    let keys = keys.expect("checked");
    compat.keys().all(|key| keys.contains(&key.as_str()))
        && compat
            .iter()
            .all(|(key, value)| field_valid(api, key, value))
}

fn field_valid(api: &str, key: &str, value: &Value) -> bool {
    if api != "openai-completions" {
        // Responses/anthropic compat: every declared key is a boolean.
        return value.is_boolean();
    }
    match key {
        "maxTokensField" => matches!(value.as_str(), Some("max_completion_tokens" | "max_tokens")),
        "thinkingFormat" => THINKING_FORMATS.contains(&value.as_str().unwrap_or_default()),
        "cacheControlFormat" => value.as_str() == Some("anthropic"),
        "openRouterRouting" => open_router_routing_valid(value),
        "vercelGatewayRouting" => vercel_gateway_routing_valid(value),
        _ => value.is_boolean(),
    }
}

fn string_list_valid(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn open_router_routing_valid(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.iter().all(|(key, value)| match key.as_str() {
        "allow_fallbacks" | "require_parameters" | "zdr" | "enforce_distillable_text" => {
            value.is_boolean()
        }
        "data_collection" => matches!(value.as_str(), Some("deny" | "allow")),
        "order" | "only" | "ignore" | "quantizations" => string_list_valid(value),
        "sort" => sort_valid(value),
        "max_price" => max_price_valid(value),
        "preferred_min_throughput" | "preferred_max_latency" => threshold_valid(value),
        _ => false,
    })
}

fn sort_valid(value: &Value) -> bool {
    if value.is_string() {
        return true;
    }
    let Some(object) = value.as_object() else {
        return false;
    };
    object.iter().all(|(key, value)| match key.as_str() {
        "by" => value.is_string(),
        "partition" => value.is_string() || value.is_null(),
        _ => false,
    })
}

fn max_price_valid(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let allowed = ["prompt", "completion", "image", "audio", "request"];
    object.keys().all(|key| allowed.contains(&key.as_str()))
        && object
            .iter()
            .all(|(_, value)| value.is_number() || value.is_string())
}

fn threshold_valid(value: &Value) -> bool {
    if value.is_number() {
        return true;
    }
    let Some(object) = value.as_object() else {
        return false;
    };
    object.iter().all(|(key, value)| match key.as_str() {
        "p50" | "p75" | "p90" | "p99" => value.is_number(),
        _ => false,
    })
}

fn vercel_gateway_routing_valid(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.iter().all(|(key, value)| match key.as_str() {
        "only" | "order" => string_list_valid(value),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn compat(value: Value) -> serde_json::Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    #[test]
    fn absent_compat_is_always_valid() {
        assert!(is_model_compat("gemini", None));
        assert!(is_model_compat("openai-completions", None));
    }

    #[test]
    fn completions_compat_accepts_declared_keys_only() {
        assert!(is_model_compat(
            "openai-completions",
            Some(&compat(
                json!({"supportsStore": true, "thinkingFormat": "zai"})
            ))
        ));
        assert!(!is_model_compat(
            "openai-completions",
            Some(&compat(json!({"supportsStore": true, "nope": 1})))
        ));
        assert!(!is_model_compat(
            "openai-completions",
            Some(&compat(json!({"supportsStore": "yes"})))
        ));
        assert!(!is_model_compat(
            "openai-completions",
            Some(&compat(json!({"thinkingFormat": "ultra"})))
        ));
        assert!(!is_model_compat(
            "openai-completions",
            Some(&compat(json!({"cacheControlFormat": "openai"})))
        ));
        assert!(!is_model_compat(
            "openai-completions",
            Some(&compat(json!({"maxTokensField": "maxOutputTokens"})))
        ));
        assert!(is_model_compat(
            "openai-completions",
            Some(&compat(json!({"maxTokensField": "max_completion_tokens"})))
        ));
    }

    #[test]
    fn responses_compat_shape() {
        assert!(is_model_compat(
            "openai-responses",
            Some(&compat(json!({"sendSessionIdHeader": true})))
        ));
        assert!(is_model_compat(
            "azure-openai-responses",
            Some(&compat(json!({"supportsLongCacheRetention": false})))
        ));
        assert!(!is_model_compat(
            "openai-responses",
            Some(&compat(json!({"supportsStore": true})))
        ));
        assert!(!is_model_compat(
            "openai-responses",
            Some(&compat(json!({"sendSessionIdHeader": "no"})))
        ));
    }

    #[test]
    fn anthropic_compat_shape() {
        assert!(is_model_compat(
            "anthropic-messages",
            Some(&compat(json!({"supportsEagerToolInputStreaming": true})))
        ));
        assert!(!is_model_compat(
            "anthropic-messages",
            Some(&compat(json!({"sendSessionIdHeader": true})))
        ));
    }

    #[test]
    fn unknown_api_rejects_compat_objects() {
        assert!(!is_model_compat(
            "gemini",
            Some(&compat(json!({"supportsLongCacheRetention": true})))
        ));
    }

    #[test]
    fn nested_routing_types_are_checked() {
        assert!(is_model_compat(
            "openai-completions",
            Some(&compat(
                json!({"openRouterRouting": {"allow_fallbacks": true, "order": ["a"]}})
            ))
        ));
        assert!(!is_model_compat(
            "openai-completions",
            Some(&compat(
                json!({"openRouterRouting": {"allow_fallbacks": "yes"}})
            ))
        ));
        assert!(!is_model_compat(
            "openai-completions",
            Some(&compat(
                json!({"openRouterRouting": {"data_collection": "maybe"}})
            ))
        ));
        assert!(is_model_compat(
            "openai-completions",
            Some(&compat(
                json!({"openRouterRouting": {"data_collection": "deny"}})
            ))
        ));
        assert!(is_model_compat(
            "openai-completions",
            Some(&compat(json!({"openRouterRouting": {
                "sort": {"by": "throughput", "partition": null},
                "max_price": {"prompt": "auto", "completion": 1.5},
                "preferred_min_throughput": {"p50": 100},
                "preferred_max_latency": 30,
            }})))
        ));
        assert!(!is_model_compat(
            "openai-completions",
            Some(&compat(
                json!({"openRouterRouting": {"max_price": {"prompt": {"deep": 1}}}})
            ))
        ));
        assert!(is_model_compat(
            "openai-completions",
            Some(&compat(
                json!({"vercelGatewayRouting": {"only": ["prov-a"], "order": []}})
            ))
        ));
        assert!(!is_model_compat(
            "openai-completions",
            Some(&compat(json!({"vercelGatewayRouting": {"only": "prov-a"}})))
        ));
    }
}
