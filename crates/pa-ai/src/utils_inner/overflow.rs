//! Context overflow detection.
//! Ported from `packages/ai/src/utils/overflow.ts`, including the provider
//! pattern table and the silent-overflow heuristics.

use regex::Regex;
use std::sync::OnceLock;

use serde_json::Map;

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

/// Check if an assistant message represents a context overflow error.
///
/// Handles error-based overflow (`stop_reason` "error" with a pattern-matching
/// message), silent overflow (usage.input exceeds the context window while the
/// stream reported success), and length-stop overflow (server truncates input,
/// returns `stop_reason` "length" with zero output).
pub fn is_context_overflow(message: &AssistantMessage, context_window: Option<u64>) -> bool {
    if message.stop_reason == StopReason::Error {
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

        // Length-stop overflow (Xiaomi MiMo style): server truncates oversized
        // input to fit the context window, leaving no room for output.
        if message.stop_reason == StopReason::Length && message.usage.output == 0 {
            let input_tokens = message.usage.input + message.usage.cache_read;
            if (input_tokens as f64) >= context_window as f64 * 0.99 {
                return true;
            }
        }
    }

    false
}

/// Convenience used by providers when assembling error messages from a raw body.
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
        // The live Prime Inference 400: input + requested output over a
        // combined ceiling — no single-part wording matches any older
        // pattern.
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
        // The remedy wording without the leading "combined" phrasing still
        // matches the combined-limit arm.
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
}
