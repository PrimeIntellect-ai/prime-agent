//! The empty-of-substance reply contract: a clean-stopped assistant reply
//! whose entire visible content is missing or a degenerate stub is a silent
//! turn end — the user sees nothing, nothing retries, nothing errors. The
//! shape (the silent-stop bug class): a reasoning model burns part of the
//! output budget on thinking before the answer starts, the provider then
//! concludes normally (`stop`, not `length`) with thinking-only content, and
//! the turn-completion accept path takes it as a valid turn end. The
//! classification here feeds the turn runner's one bounded retry.

use pa_agent::types::{AssistantContent, AssistantMessage, StopReason};
use pa_types::ai::thinking_levels::{
    get_supported_thinking_levels, thinking_level_index, EXTENDED_THINKING_LEVELS,
};
use pa_types::ai::{Model, ModelThinkingLevel};

/// The parenthesized self-reports of an actionless turn — the observed
/// `print(no action)` class of stub replies. Never matched without thinking
/// blocks present (see [`is_empty_of_substance`]), so a terse legitimate
/// answer from a non-reasoning reply never trips the retry.
const STUB_SENTINELS: [&str; 5] = [
    "(no action)",
    "no action",
    "(none)",
    "(no output)",
    "(nothing)",
];

/// Whether the reply is empty of substance: a clean-stopped (`stop`) reply
/// whose visible text is missing entirely, or degenerate stub text —
/// whitespace, a single character, or an actionless sentinel — when
/// thinking blocks were present. A reply with tool calls is never empty of
/// substance (tool work is a live turn), and neither is any other stop
/// reason: the provider's own `length`/`error`/`toolUse` classes keep their
/// existing machinery.
#[must_use]
pub fn is_empty_of_substance(message: &AssistantMessage) -> bool {
    if message.stop_reason != StopReason::Stop {
        return false;
    }
    if message
        .content
        .iter()
        .any(|block| matches!(block, AssistantContent::ToolCall(_)))
    {
        return false;
    }
    let text = message
        .content
        .iter()
        .filter_map(|block| match block {
            AssistantContent::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<String>();
    if text.is_empty() {
        // No text blocks at all: the thinking-only clean stop, or an
        // entirely empty reply. Both end the turn silently.
        return true;
    }
    let has_thinking = message
        .content
        .iter()
        .any(|block| matches!(block, AssistantContent::Thinking(_)));
    has_thinking && is_degenerate_stub(&text)
}

/// The degenerate stub classes: whitespace, a single character, or an
/// actionless sentinel.
fn is_degenerate_stub(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.is_empty()
        || trimmed.chars().count() == 1
        || STUB_SENTINELS.contains(&trimmed.to_ascii_lowercase().as_str())
}

/// One rung down the thinking ladder where the model supports the step: the
/// empty-reply retry's reasoning relief — a lower effort level burns less of
/// the output budget on thinking, leaving the answer text room in the same
/// budget. The ladder's floor, or an unsupported rung (a model that maps the
/// next-lower level to null), keeps the current level.
#[must_use]
pub fn thinking_step_lower(model: &Model, level: ModelThinkingLevel) -> ModelThinkingLevel {
    let index = thinking_level_index(level);
    if index == 0 {
        return level;
    }
    let lower = EXTENDED_THINKING_LEVELS[index - 1];
    if get_supported_thinking_levels(model).contains(&lower) {
        lower
    } else {
        level
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_agent::types::{TextContent, ThinkingContent, ToolCall, Usage};
    use serde_json::json;

    fn reply(stop_reason: StopReason, content: Vec<AssistantContent>) -> AssistantMessage {
        AssistantMessage {
            content,
            api: "faux".to_string(),
            provider: "faux".to_string(),
            model: "faux-1".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::zero(),
            stop_reason,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
        }
    }

    fn text(content: &str) -> AssistantContent {
        AssistantContent::Text(TextContent {
            text: content.to_string(),
            text_signature: None,
        })
    }

    fn thinking(content: &str) -> AssistantContent {
        AssistantContent::Thinking(ThinkingContent {
            thinking: content.to_string(),
            thinking_signature: None,
            redacted: None,
        })
    }

    fn model(reasoning: bool) -> Model {
        serde_json::from_value(json!({
            "id": "m", "name": "m", "api": "openai-completions", "provider": "p",
            "baseUrl": "http://localhost", "reasoning": reasoning, "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 128_000, "maxTokens": 8_192,
        }))
        .unwrap()
    }

    #[test]
    fn a_thinking_only_clean_stop_is_empty_of_substance() {
        // Oscar's silent-stop trace: the reply plans the whole answer in
        // thinking, then stops with no text block at all.
        let message = reply(
            StopReason::Stop,
            vec![thinking("the answer is 42, explained simply"), thinking("")],
        );
        assert!(is_empty_of_substance(&message));
        // The same reply with no thinking blocks is still a silent end.
        assert!(is_empty_of_substance(&reply(StopReason::Stop, Vec::new())));
    }

    #[test]
    fn stub_class_text_trips_only_when_thinking_was_present() {
        let with_thinking = |content: &str| {
            reply(
                StopReason::Stop,
                vec![thinking("planned the answer"), text(content)],
            )
        };
        // The observed progression: blank, ".", "(no action)".
        for stub in [
            "",
            " ",
            "\n\t",
            ".",
            "…",
            "(no action)",
            "NO ACTION",
            "(none)",
        ] {
            assert!(
                is_empty_of_substance(&with_thinking(stub)),
                "stub {stub:?} with thinking is empty of substance"
            );
        }
        // A terse legitimate answer from a reply with no thinking blocks
        // never trips the retry.
        for plain in [".", "no", "(none)", "42"] {
            assert!(
                !is_empty_of_substance(&reply(StopReason::Stop, vec![text(plain)])),
                "plain {plain:?} without thinking is the reply's answer"
            );
        }
    }

    #[test]
    fn a_healthy_reply_is_never_empty_of_substance() {
        let healthy = reply(
            StopReason::Stop,
            vec![
                thinking("planned the answer"),
                text("Here is the answer: 42."),
            ],
        );
        assert!(!is_empty_of_substance(&healthy));
        // Tool work is a live turn, never a silent end.
        let tool_call = AssistantContent::ToolCall(ToolCall {
            id: "c".to_string(),
            name: "bash".to_string(),
            arguments: json!({}),
            thought_signature: None,
        });
        assert!(!is_empty_of_substance(&reply(
            StopReason::ToolUse,
            vec![thinking("need a command"), tool_call]
        )));
        // A stub stopped for length keeps the provider's own signal.
        assert!(!is_empty_of_substance(&reply(
            StopReason::Length,
            vec![thinking("cut off"), text(".")]
        )));
    }

    #[test]
    fn the_step_lowers_one_rung_where_supported() {
        let reasoning_model = model(true);
        // A bare reasoning model serves off..high (xhigh/max need explicit
        // mappings), so the ladder steps inside that span.
        assert_eq!(
            thinking_step_lower(&reasoning_model, ModelThinkingLevel::High),
            ModelThinkingLevel::Medium
        );
        assert_eq!(
            thinking_step_lower(&reasoning_model, ModelThinkingLevel::Medium),
            ModelThinkingLevel::Low
        );
        // A model with every rung mapped steps down from the top.
        let fully_mapped = Model {
            thinking_level_map: Some(pa_types::ai::thinking_level_map(&[
                (ModelThinkingLevel::Off, Some("off")),
                (ModelThinkingLevel::Minimal, Some("minimal")),
                (ModelThinkingLevel::Low, Some("low")),
                (ModelThinkingLevel::Medium, Some("medium")),
                (ModelThinkingLevel::High, Some("high")),
                (ModelThinkingLevel::Xhigh, Some("xhigh")),
                (ModelThinkingLevel::Max, Some("max")),
            ])),
            ..model(true)
        };
        assert_eq!(
            thinking_step_lower(&fully_mapped, ModelThinkingLevel::Max),
            ModelThinkingLevel::Xhigh
        );
        // The ladder's floor stays put.
        assert_eq!(
            thinking_step_lower(&reasoning_model, ModelThinkingLevel::Off),
            ModelThinkingLevel::Off
        );
        // A model that maps the next-lower rung to null keeps the level.
        let gated = Model {
            reasoning: true,
            thinking_level_map: Some(pa_types::ai::thinking_level_map(&[
                (ModelThinkingLevel::Off, Some("off")),
                (ModelThinkingLevel::Minimal, None),
                (ModelThinkingLevel::Low, Some("low")),
                (ModelThinkingLevel::Medium, None),
                (ModelThinkingLevel::High, Some("high")),
            ])),
            ..model(true)
        };
        assert_eq!(
            thinking_step_lower(&gated, ModelThinkingLevel::Low),
            ModelThinkingLevel::Low,
            "minimal is mapped to null: the low rung stays"
        );
        assert_eq!(
            thinking_step_lower(&gated, ModelThinkingLevel::High),
            ModelThinkingLevel::High,
            "medium is mapped to null: the unsupported step keeps the high rung"
        );
        // A model with no thinking surface has no step to take.
        let plain = model(false);
        assert_eq!(
            thinking_step_lower(&plain, ModelThinkingLevel::Off),
            ModelThinkingLevel::Off
        );
    }
}
