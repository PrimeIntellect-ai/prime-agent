//! Context overflow detection: the provider pattern table and the silent-overflow heuristics.

use regex::Regex;
use std::sync::OnceLock;

use crate::types::{AssistantContent, AssistantMessage, StopReason};

fn overflow_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"prompt is too long",                             // Anthropic token overflow
            r"request_too_large", // Anthropic request byte-size overflow (HTTP 413)
            r"input is too long for requested model", // Amazon Bedrock
            r"exceeds the context window", // OpenAI (Completions & Responses API)
            r"(?i)input token count.*exceeds the maximum", // Google (Gemini)
            r"(?i)maximum prompt length is \d+", // xAI (Grok)
            r"(?i)reduce the length of the messages", // Groq
            r"(?i)maximum context length is \d+ tokens", // OpenRouter (all backends)
            r"(?i)exceeds the model's maximum context length", // LiteLLM
            r"(?i)exceeds the limit of \d+", // GitHub Copilot
            r"(?i)exceeds the available context size", // llama.cpp server
            r"(?i)greater than the context length", // LM Studio
            r"(?i)context window exceeds limit", // MiniMax
            r"(?i)exceeded model token limit", // Kimi For Coding
            r"(?i)too large for model with \d+ maximum context length", // Mistral
            r"(?i)model_context_window_exceeded", // z.ai non-standard finish_reason surfaced as error text
            r"(?i)combined input and output tokens", // Prime Inference-style combined ceilings
            r"(?i)accepts at most \d+ combined",  // "accepts at most 1048576 combined tokens"
            r"(?i)reduce the input length or requested output length", // combined-limit remedy text
            r"(?i)prompt too long; exceeded (?:max )?context length", // Ollama explicit overflow error
            r"(?i)context[_ ]length[_ ]exceeded",                     // Generic fallback
            r"(?i)too many tokens",                                   // Generic fallback
            r"(?i)token limit exceeded",                              // Generic fallback
            r"(?i)^4(?:00|13)\s*(?:status code)?\s*\(no body\)", // Cerebras: 400/413 with no body
            // Any HTTP 413 is a request-size overflow regardless of provider or body
            // wording: an oversized request body can never succeed on retry, so
            // it belongs with the compact-and-retry arm, not the error ladder.
            // The primary claim is the structured status on the
            // `provider_stream_failure` diagnostic (`is_context_overflow` reads
            // it); the arms below cover message-text-only paths - the
            // SDK-composed `"413 <body>"`, the `"X API error (413): ..."`
            // composition, and the 413 wording families.
            r"(?i)^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))",
            // "413 Request Entity Too Large" (nginx), "request entity too large"
            // (express/body-parser), "request body too large" (Go MaxBytesReader).
            r"(?i)request[_ ](?:body|entity)[_ ](?:is[_ ])?too[_ ]large",
            r"(?i)exceeds the body size limit", // Prime Inference 413 wording
            r"(?i)payload too large",           // the HTTP 413 reason phrase
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("static regex"))
        .collect()
    })
}

fn non_overflow_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?i)^(Throttling error|Service unavailable):", // AWS Bedrock non-overflow errors
            r"(?i)rate limit",                               // Generic rate limiting
            r"(?i)too many requests",                        // Generic HTTP 429 style
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("static regex"))
        .collect()
    })
}

/// The HTTP status recorded on the message's `provider_stream_failure` diagnostic by the
/// provider terminal path, when one was recorded.
fn stream_failure_status(message: &AssistantMessage) -> Option<u16> {
    message
        .diagnostics
        .as_ref()?
        .iter()
        .find(|diagnostic| diagnostic.type_ == "provider_stream_failure")
        .and_then(|diagnostic| diagnostic.details.as_ref())
        .and_then(|details| details.get("status"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
}

/// Check if an assistant message represents a context overflow error.
///
/// Handles error-based overflow (`stop_reason` "error" with a pattern-matching message), silent
/// overflow (usage.input exceeds the context window while the stream reported success), and
/// length-stop overflow (server truncates input, returns `stop_reason` "length" with zero output).
#[must_use]
pub fn is_context_overflow(message: &AssistantMessage, context_window: Option<u64>) -> bool {
    if message.stop_reason == StopReason::Error {
        // A 413 recorded on the failure diagnostic is the request-size overflow regardless of
        // how the provider composed the message text (`from_http_status_body` rewrites the
        // text; the structured status covers every provider).
        if stream_failure_status(message) == Some(413) {
            return true;
        }
        if let Some(error_message) = &message.error_message {
            let is_non_overflow = non_overflow_patterns()
                .iter()
                .any(|p| p.is_match(error_message));
            if !is_non_overflow
                && overflow_patterns()
                    .iter()
                    .any(|p| p.is_match(error_message))
            {
                return true;
            }
        }
    }

    if let Some(context_window) = context_window {
        if message.stop_reason == StopReason::Stop {
            let input_tokens = message.usage.input + message.usage.cache_read;
            if input_tokens > context_window {
                return true;
            }
        }

        // Length-stop overflow (Xiaomi MiMo style): server truncates oversized input to fit the
        // context window, leaving no room for output.
        if message.stop_reason == StopReason::Length && message.usage.output == 0 {
            let input_tokens = message.usage.input + message.usage.cache_read;
            // The 0.99 ratio threshold is the TS port's f64 comparison; token counts sit far below 2^53.
            #[allow(clippy::cast_precision_loss)]
            if (input_tokens as f64) >= context_window as f64 * 0.99 {
                return true;
            }
        }
    }

    false
}

/// Convenience used by providers when assembling error messages from a raw body.
#[must_use]
pub fn error_message_has_overflow(error_message: &str) -> bool {
    let is_non_overflow = non_overflow_patterns()
        .iter()
        .any(|p| p.is_match(error_message));
    !is_non_overflow
        && overflow_patterns()
            .iter()
            .any(|p| p.is_match(error_message))
}

#[allow(dead_code)]
fn content_text(message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .map(|block| match block {
            AssistantContent::Text(text) => text.text.clone(),
            _ => String::new(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Usage, UsageCost};
    use crate::utils_inner::stream_failure::{
        format_stream_failure_message, record_stream_failure, ProviderError,
    };
    use serde_json::Map;
    use std::collections::HashMap;

    fn message(
        stop_reason: StopReason,
        error_message: Option<&str>,
        usage: Usage,
    ) -> AssistantMessage {
        AssistantMessage {
            content: Vec::new(),
            api: "openai-completions".into(),
            provider: "test".into(),
            model: "m".into(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage,
            stop_reason,
            stop_reason_raw: None,
            error_message: error_message.map(std::string::ToString::to_string),
            timestamp: 0,
            rest: Map::default(),
        }
    }

    fn usage(input: u64, output: u64, cache_read: u64) -> Usage {
        Usage {
            input,
            output,
            cache_read,
            cache_write: 0,
            total_tokens: input + output + cache_read,
            cost: UsageCost::default(),
        }
    }

    #[test]
    fn detects_error_overflow() {
        let m = message(
            StopReason::Error,
            Some("prompt is too long: 213462 tokens > 200000 maximum"),
            usage(0, 0, 0),
        );
        assert!(is_context_overflow(&m, None));
    }

    #[test]
    fn excludes_rate_limit_noise() {
        let m = message(
            StopReason::Error,
            Some("Throttling error: Too many tokens, please wait before trying again."),
            usage(0, 0, 0),
        );
        assert!(!is_context_overflow(&m, None));
    }

    #[test]
    fn detects_silent_overflow() {
        let m = message(StopReason::Stop, None, usage(100_001, 10, 0));
        assert!(is_context_overflow(&m, Some(100_000)));
    }

    #[test]
    fn detects_length_stop_overflow() {
        let m = message(StopReason::Length, None, usage(99_500, 0, 0));
        assert!(is_context_overflow(&m, Some(100_000)));
    }

    #[test]
    fn detects_combined_input_output_limit_overflow() {
        // The live Prime Inference 400: input + requested output over a combined ceiling — no
        // single-part wording matches any older pattern.
        let m = message(
            StopReason::Error,
            Some(
                "Error: 400 This model configuration accepts at most 1048576 combined input and output tokens. However, your request has 1017457 input tokens and asks for 32000 output tokens (1049457 tokens total). Please reduce the input length or requested output length and try again.",
            ),
            usage(1_017_457, 0, 0),
        );
        assert!(is_context_overflow(&m, Some(1_048_576)));
        assert!(error_message_has_overflow(
            m.error_message.as_deref().unwrap()
        ));
    }

    #[test]
    fn combined_limit_remedy_text_alone_classifies() {
        // The remedy wording without the leading "combined" phrasing still matches the
        // combined-limit arm.
        let m = message(
            StopReason::Error,
            Some("400: Please reduce the input length or requested output length and try again."),
            usage(0, 0, 0),
        );
        assert!(is_context_overflow(&m, None));
    }

    #[test]
    fn normal_success_is_not_overflow() {
        let m = message(StopReason::Stop, None, usage(100, 10, 0));
        assert!(!is_context_overflow(&m, Some(100_000)));
    }

    /// The live Prime Inference 413 (captured against the gateway, 2026-11):
    /// `{"error":{"message":"Hosted decision request exceeds the body size
    /// limit.","type":"invalid_request_error",...}}` on a >=16 MiB request body,
    /// SDK-composed to `"413 <message>"`. The `invalid_request_error` body type
    /// makes the retry classifier settle it as a permanent invalid request; the
    /// overflow table must claim it first so the compact-and-retry arm runs.
    #[test]
    fn four13_status_prefix_classifies() {
        let live = message(
            StopReason::Error,
            Some("413 Hosted decision request exceeds the body size limit."),
            usage(0, 0, 0),
        );
        assert!(is_context_overflow(&live, Some(1_048_576)));
        assert!(error_message_has_overflow(
            live.error_message.as_deref().unwrap()
        ));

        // The same status arm covers the bodyless 413 and providers whose
        // message carries the status inside a prefix instead of at the start.
        for text in [
            "413 status code (no body)",
            "413 Content Too Large",
            "Mistral API error (413): API error occurred: Status 413. Body: \"\"",
        ] {
            let m = message(StopReason::Error, Some(text), usage(0, 0, 0));
            assert!(is_context_overflow(&m, None), "unrecognized: {text}");
        }
    }

    /// The byte-oversize wording family without any status prefix: in-stream
    /// error frames and proxies that quote the 413 wording alone.
    #[test]
    fn byte_oversize_wordings_classify() {
        for text in [
            "Request body too large",
            "Request body is too large",
            "payload too large",
            "Request entity too large",
            "Hosted decision request exceeds the body size limit.",
            r#"{"code":"request_body_too_large","message":"request body too large"}"#,
        ] {
            let m = message(StopReason::Error, Some(text), usage(0, 0, 0));
            assert!(is_context_overflow(&m, None), "unrecognized: {text}");
        }
    }

    /// The byte-oversize class must not swallow other failures: rate-limit
    /// wording stays with the retry ladder, a 413 that is only the leading
    /// digits of a larger number is not a status, and a non-413 status on the
    /// diagnostic does not classify.
    #[test]
    fn byte_oversize_negatives_stay_out() {
        for text in [
            "429 Rate limit: too many requests, retry later",
            "4131 tokens remaining in the window",
        ] {
            let m = message(StopReason::Error, Some(text), usage(0, 0, 0));
            assert!(!is_context_overflow(&m, None), "false positive: {text}");
        }

        let error = ProviderError::from_http_status_body(
            500,
            r#"{"type":"error","error":{"type":"server_error","message":"internal failure"}}"#,
            HashMap::default(),
        );
        let text = format_stream_failure_message(&error);
        assert_eq!(
            text,
            "Provider server error (server_error, 500): internal failure",
        );
        let mut m = message(StopReason::Error, Some(&text), usage(0, 0, 0));
        record_stream_failure(
            ("anthropic", "claude-sonnet-4-5", "anthropic"),
            &mut m,
            &error,
        );
        assert!(!is_context_overflow(&m, None));
    }

    /// A typed 413 through the real provider terminal path:
    /// `from_http_status_body` (anthropic, openai-responses, azure, google,
    /// vertex) rewrites the message to `Provider rejected the request
    /// (<type>, 413): <detail>`, which the status-prefix arm misses, and
    /// `record_stream_failure` records the structured status on the
    /// `provider_stream_failure` diagnostic - the structured check must claim it.
    #[test]
    fn typed_413_stream_failure_classifies() {
        let error = ProviderError::from_http_status_body(
            413,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"Request entity too large"}}"#,
            HashMap::default(),
        );
        let text = format_stream_failure_message(&error);
        assert_eq!(
            text,
            "Provider rejected the request (invalid_request_error, 413): Request entity too large",
        );
        let mut m = message(StopReason::Error, Some(&text), usage(0, 0, 0));
        record_stream_failure(
            ("anthropic", "claude-sonnet-4-5", "anthropic"),
            &mut m,
            &error,
        );
        assert!(is_context_overflow(&m, None));
    }

    /// The structured status is the universal claim: a 413 whose detail
    /// wording matches no table arm still classifies through the status
    /// recorded on the `provider_stream_failure` diagnostic.
    #[test]
    fn structured_413_status_classifies_unenumerated_wording() {
        let error = ProviderError::from_http_status_body(
            413,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"upload exceeds the allowed size"}}"#,
            HashMap::default(),
        );
        let text = format_stream_failure_message(&error);
        assert_eq!(
            text,
            "Provider rejected the request (invalid_request_error, 413): upload exceeds the allowed size",
        );
        let mut m = message(StopReason::Error, Some(&text), usage(0, 0, 0));
        record_stream_failure(
            ("anthropic", "claude-sonnet-4-5", "anthropic"),
            &mut m,
            &error,
        );
        assert!(is_context_overflow(&m, None));
    }
}
