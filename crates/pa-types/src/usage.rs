//! Context-usage estimation over raw message JSON: pure data helpers shared
//! by crates that read session files in different representations
//! (pa-daemon's wire-shaped session store, pa-core's typed session manager).
//! Port of `estimateContextTokens` / `estimateTokens` / `getAssistantUsage`
//! from the TS core (compaction + agent-session).

use serde_json::Value;

/// `totalTokens` when present, else the four-field sum (TS
/// `calculateContextTokens` over the raw usage object).
pub fn calculate_context_tokens(usage: &Value) -> u64 {
    usage
        .get("totalTokens")
        .and_then(Value::as_u64)
        .filter(|total| *total > 0)
        .unwrap_or_else(|| {
            usage
                .get("input")
                .and_then(Value::as_u64)
                .unwrap_or_default()
                + usage
                    .get("output")
                    .and_then(Value::as_u64)
                    .unwrap_or_default()
                + usage
                    .get("cacheRead")
                    .and_then(Value::as_u64)
                    .unwrap_or_default()
                + usage
                    .get("cacheWrite")
                    .and_then(Value::as_u64)
                    .unwrap_or_default()
        })
}

/// Assistant usage that is safe to read (TS `getAssistantUsage` skips
/// aborted and error stops).
pub fn valid_assistant_usage(message: &Value) -> Option<Value> {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    match message.get("stopReason").and_then(Value::as_str) {
        Some("aborted" | "error") => return None,
        _ => {}
    }
    message
        .get("usage")
        .cloned()
        .filter(|usage| !usage.is_null())
}

/// Chars/4 heuristic token estimate (TS `estimateTokens`): text and thinking
/// content counts, tool calls count their serialized arguments, images count
/// as 4800 chars.
pub fn estimate_tokens(message: &Value) -> u64 {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut chars = 0u64;
    match message.get("content") {
        Some(Value::String(text)) if role == "user" || role == "custom" || role == "toolResult" => {
            chars += text.chars().count() as u64;
        }
        Some(Value::Array(blocks)) => {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        chars += block
                            .get("text")
                            .and_then(Value::as_str)
                            .map(|text| text.chars().count() as u64)
                            .unwrap_or_default();
                    }
                    Some("thinking") => {
                        chars += block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .map(|text| text.chars().count() as u64)
                            .unwrap_or_default();
                    }
                    Some("toolCall") => {
                        chars += block
                            .get("name")
                            .and_then(Value::as_str)
                            .map(|name| name.chars().count() as u64)
                            .unwrap_or_default();
                        if let Some(arguments) = block.get("arguments") {
                            chars += serde_json::to_string(arguments)
                                .map(|text| text.chars().count() as u64)
                                .unwrap_or_default();
                        }
                    }
                    Some("image") => {
                        chars += 4800;
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    chars.div_ceil(4)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn total_tokens_wins_when_positive() {
        assert_eq!(
            calculate_context_tokens(&json!({ "totalTokens": 42, "input": 100 })),
            42
        );
        // A zero totalTokens falls back to the four-field sum.
        assert_eq!(
            calculate_context_tokens(
                &json!({ "totalTokens": 0, "input": 10, "output": 20, "cacheRead": 5, "cacheWrite": 7 })
            ),
            42
        );
    }

    #[test]
    fn assistant_usage_skips_aborted_and_error_stops() {
        assert_eq!(
            valid_assistant_usage(&json!({ "role": "user", "usage": { "input": 1 } })),
            None
        );
        assert_eq!(
            valid_assistant_usage(
                &json!({ "role": "assistant", "stopReason": "aborted", "usage": { "input": 1 } })
            ),
            None
        );
        assert_eq!(
            valid_assistant_usage(
                &json!({ "role": "assistant", "stopReason": "error", "usage": { "input": 1 } })
            ),
            None
        );
        let usage = valid_assistant_usage(&json!({ "role": "assistant", "usage": { "input": 3 } }));
        assert_eq!(usage, Some(json!({ "input": 3 })));
    }

    #[test]
    fn estimate_counts_text_thinking_and_tool_calls_by_chars() {
        // 8 chars -> 2 tokens.
        assert_eq!(
            estimate_tokens(&json!({ "role": "user", "content": "12345678" })),
            2
        );
        // Blocks: text + thinking + serialized tool-call arguments + image.
        let message = json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "abcd" },
                { "type": "thinking", "thinking": "efgh" },
                { "type": "toolCall", "name": "ipython", "arguments": { "code": "x = 1" } },
                { "type": "image" },
            ],
        });
        // The tool-call block counts its name plus the serialized arguments
        // (`{"code":"x = 1"}` = 17 chars).
        let expected = (4_u64 + 4 + 7 /*name*/ + 17 /*arguments*/ + 4800).div_ceil(4);
        assert_eq!(estimate_tokens(&message), expected);
        // Plain-string content only counts for user/custom/toolResult roles.
        assert_eq!(
            estimate_tokens(&json!({ "role": "assistant", "content": "12345678" })),
            0
        );
        assert_eq!(
            estimate_tokens(&json!({ "role": "toolResult", "content": "12345678" })),
            2
        );
    }
}
