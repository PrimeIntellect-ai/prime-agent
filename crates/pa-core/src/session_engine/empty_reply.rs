//! The empty-of-substance reply contract: a clean-stopped assistant reply
//! whose entire visible content is missing or an observed actionless stub is
//! a silent turn end — the user sees nothing, nothing retries, nothing
//! errors. The observed shape (the silent-stop bug class): a reasoning model
//! replies with thinking blocks and no usable text, and the provider
//! concludes normally (`stop`, not `length`) — so the turn-completion accept
//! path takes it as a valid turn end. The classification here feeds the
//! turn runner's one bounded retry.

use pa_agent::types::{AssistantContent, AssistantMessage, StopReason};

/// The observed actionless stub (`print(no action)` in the report trace).
/// Never matched without thinking blocks present (see
/// [`is_empty_of_substance`]), so a terse legitimate answer from a
/// non-reasoning reply never trips the retry.
const STUB_SENTINEL: &str = "(no action)";

/// Whether the reply is empty of substance: a clean-stopped (`stop`) reply
/// whose visible text is missing entirely, or the observed actionless stub
/// when thinking blocks were present. A reply with tool calls is never empty
/// of substance (tool work is a live turn), and neither is any other stop
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

/// The degenerate stub classes: blank text (the observed blank prints), or
/// the observed actionless sentinel. A short answer is a real answer — a
/// reasoning model asked "2+2?" that thinks and replies "4" must never trip
/// the retry.
fn is_degenerate_stub(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.is_empty() || trimmed.to_ascii_lowercase() == STUB_SENTINEL
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
        // The observed classes: the blank reply, and the actionless stub
        // (the parenthesized self-report, matched case-insensitively).
        for stub in ["", " ", "\n\t", "(no action)", "(NO ACTION)"] {
            assert!(
                is_empty_of_substance(&with_thinking(stub)),
                "stub {stub:?} with thinking is empty of substance"
            );
        }
        // A short answer is a real answer, with or without thinking: "4",
        // "Y", "." never trip the retry.
        for plain in [".", "…", "4", "Y", "✓", "no", "42"] {
            assert!(
                !is_empty_of_substance(&reply(StopReason::Stop, vec![text(plain)])),
                "plain {plain:?} without thinking is the reply's answer"
            );
            assert!(
                !is_empty_of_substance(&with_thinking(plain)),
                "short answer {plain:?} with thinking is the reply's answer"
            );
        }
        // The never-observed sentinel spellings stay real answers — matching
        // invented model wording drifts.
        for plain in [
            "(none)",
            "(no output)",
            "(nothing)",
            "no action",
            "NO ACTION",
        ] {
            assert!(
                !is_empty_of_substance(&with_thinking(plain)),
                "unobserved sentinel {plain:?} is a real answer"
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
}
