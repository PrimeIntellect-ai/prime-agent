//! MCP sampling policy: which servers may ask this machine's model for a completion,
//! how far a request is bounded, and how its messages map onto an agent turn.
//!
//! Default deny, per server, revocable: `settings.mcpSampling.allowedServers` names the
//! servers that may ask (an exact match against the configured `mcpServers` key — no
//! wildcard, no global switch). An unset or empty list refuses every request **before**
//! any model call is made, so the default path costs nothing.

use pa_agent::types::{
    AssistantContent, AssistantMessage, Message, StopReason, TextContent, Usage, UserContent,
    UserMessage, UserPart,
};
use serde_json::Value;

use crate::settings::McpSamplingSettings;

/// The cap a request is clamped to when the settings carry none.
pub const DEFAULT_SAMPLING_MAX_TOKENS: u64 = 512;
/// The hard ceiling: a server's `maxTokens` never exceeds this.
pub const MAX_SAMPLING_MAX_TOKENS: u64 = 4096;
const MAX_SAMPLING_MESSAGES: usize = 32;
const MAX_SAMPLING_CHARS: usize = 64 * 1024;

/// Whether `server` may request a sampling completion under `policy`.
#[must_use]
pub fn sampling_allowed(policy: &McpSamplingSettings, server: &str) -> bool {
    !server.is_empty() && policy.allowed_servers.iter().any(|name| name == server)
}

/// The token cap for one request: the server's request, the policy cap, and the hard
/// ceiling, whichever is smallest (a missing value takes the policy's, then the default).
#[must_use]
pub fn clamp_sampling_max_tokens(requested: Option<u64>, policy: &McpSamplingSettings) -> u64 {
    let policy_cap = policy
        .max_tokens
        .unwrap_or(DEFAULT_SAMPLING_MAX_TOKENS)
        .min(MAX_SAMPLING_MAX_TOKENS);
    requested.unwrap_or(policy_cap).min(policy_cap)
}

/// Convert the sampling request's messages into agent messages, bounded and text-only.
///
/// `sampling/createMessage` may carry images or audio; this product's turn is text, so a
/// non-text block is refused with an explicit error rather than dropped silently.
///
/// # Errors
///
/// Returns the reason when the request is empty, over the message or character cap, or
/// carries a shape this turn cannot send.
pub fn sampling_messages(messages: &[Value]) -> Result<Vec<Message>, String> {
    if messages.is_empty() {
        return Err("the sampling request carries no messages".to_string());
    }
    if messages.len() > MAX_SAMPLING_MESSAGES {
        return Err(format!(
            "the sampling request carries more than {MAX_SAMPLING_MESSAGES} messages"
        ));
    }
    let mut total = 0usize;
    let mut converted = Vec::with_capacity(messages.len());
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| "a sampling message has no role".to_string())?;
        let text = sampling_text(message.get("content"))?;
        total += text.chars().count();
        if total > MAX_SAMPLING_CHARS {
            return Err(format!(
                "the sampling request carries more than {MAX_SAMPLING_CHARS} characters"
            ));
        }
        let text_content = TextContent {
            text: text.clone(),
            text_signature: None,
        };
        match role {
            "user" => converted.push(Message::User(UserMessage {
                content: UserContent::Parts(vec![UserPart::Text(text_content)]),
                timestamp: 0,
            })),
            "assistant" => converted.push(Message::Assistant(AssistantMessage {
                content: vec![AssistantContent::Text(text_content)],
                api: String::new(),
                provider: String::new(),
                model: String::new(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: Usage::zero(),
                stop_reason: StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
            })),
            other => return Err(format!("a sampling message has an unknown role `{other}`")),
        }
    }
    Ok(converted)
}

/// One message's text: a plain string or the concatenated `text` blocks.
fn sampling_text(content: Option<&Value>) -> Result<String, String> {
    match content {
        Some(Value::String(text)) => Ok(text.clone()),
        Some(Value::Array(blocks)) => {
            let mut parts = Vec::with_capacity(blocks.len());
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => parts.push(
                        block
                            .get("text")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "a text sampling block has no text".to_string())?
                            .to_string(),
                    ),
                    Some(other) => {
                        return Err(format!(
                            "the sampling request carries a `{other}` block; only text is supported"
                        ))
                    }
                    None => return Err("a sampling block has no type".to_string()),
                }
            }
            Ok(parts.join("\n"))
        }
        _ => Err("a sampling message has no content".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy(servers: &[&str]) -> McpSamplingSettings {
        McpSamplingSettings {
            allowed_servers: servers.iter().map(|name| (*name).to_string()).collect(),
            model: None,
            max_tokens: None,
        }
    }

    /// The default-deny tooth: with no allow list (or a list that does not name the
    /// server), the request is refused before anything else runs.
    #[test]
    fn nothing_is_allowed_without_an_explicit_per_server_entry() {
        assert!(!sampling_allowed(&policy(&[]), "notion"));
        assert!(!sampling_allowed(&policy(&["github"]), "notion"));
        assert!(!sampling_allowed(&policy(&["notion"]), ""));
        // Exact names only: no prefix, wildcard, or case folding.
        assert!(!sampling_allowed(&policy(&["not"]), "notion"));
        assert!(!sampling_allowed(&policy(&["*"]), "notion"));
        assert!(!sampling_allowed(&policy(&["Notion"]), "notion"));
        assert!(sampling_allowed(&policy(&["notion"]), "notion"));
    }

    #[test]
    fn the_token_cap_clamps_to_the_policy_and_the_ceiling() {
        assert_eq!(
            clamp_sampling_max_tokens(None, &policy(&[])),
            DEFAULT_SAMPLING_MAX_TOKENS
        );
        let capped = McpSamplingSettings {
            max_tokens: Some(1000),
            ..policy(&[])
        };
        assert_eq!(clamp_sampling_max_tokens(None, &capped), 1000);
        assert_eq!(clamp_sampling_max_tokens(Some(4000), &capped), 1000);
        assert_eq!(clamp_sampling_max_tokens(Some(64), &capped), 64);
        let over = McpSamplingSettings {
            max_tokens: Some(MAX_SAMPLING_MAX_TOKENS + 1),
            ..policy(&[])
        };
        assert_eq!(
            clamp_sampling_max_tokens(Some(u64::MAX), &over),
            MAX_SAMPLING_MAX_TOKENS
        );
    }

    #[test]
    fn messages_convert_from_strings_and_text_blocks() {
        let messages = sampling_messages(&[
            json!({"role": "user", "content": "hello"}),
            json!({"role": "assistant", "content": [{"type": "text", "text": "hi"}]}),
        ])
        .expect("text-only messages convert");
        assert_eq!(messages.len(), 2);
        assert!(matches!(messages[0], Message::User(_)));
        assert!(matches!(messages[1], Message::Assistant(_)));
    }

    #[test]
    fn non_text_content_and_bad_shapes_are_refused() {
        assert!(sampling_messages(&[]).is_err());
        assert!(sampling_messages(&[
            json!({"role": "user", "content": [{"type": "image", "data": "x"}]})
        ])
        .is_err());
        assert!(sampling_messages(&[json!({"role": "system", "content": "x"})]).is_err());
        assert!(sampling_messages(&[json!({"role": "user"})]).is_err());
        let too_many: Vec<Value> = (0..=MAX_SAMPLING_MESSAGES)
            .map(|_| json!({"role": "user", "content": "x"}))
            .collect();
        assert!(sampling_messages(&too_many).is_err());
        let huge = "x".repeat(MAX_SAMPLING_CHARS + 1);
        assert!(sampling_messages(&[json!({"role": "user", "content": huge})]).is_err());
    }
}
