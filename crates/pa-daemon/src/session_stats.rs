//! `get_session_stats` over the worker session store: port of
//! `AgentSession.getSessionStats` / `getContextUsage` (TS
//! `core/agent-session.ts`, shapes from `core/session-stats.ts`) and the
//! `estimateContextTokens` / `estimateTokens` heuristics from
//! the same code serves scripted and real engine sessions. The token-estimate
//! helpers live in `pa_types::usage` (shared with pa-core's `compact.status`
//! host request).

use serde_json::{json, Value};

use pa_types::usage::{calculate_context_tokens, estimate_tokens, valid_assistant_usage};

use crate::session_store::{SessionEntry, SessionFile};

/// Compute the `get_session_stats` response data for one session file.
/// `context_window` is the engine model's context window; `None` (or zero)
/// omits `contextUsage`, matching TS sessions without a model.
pub fn session_stats(store: &SessionFile, context_window: Option<u64>) -> Value {
    let branch = store.branch();
    let messages: Vec<&Value> = branch
        .iter()
        .filter(|entry| entry.type_ == "message")
        .filter_map(|entry| entry.fields.get("message"))
        .collect();
    let mut user_messages = 0u64;
    let mut assistant_messages = 0u64;
    let mut tool_results = 0u64;
    let mut tool_calls = 0u64;
    let mut input = 0u64;
    let mut output = 0u64;
    let mut cache_read = 0u64;
    let mut cache_write = 0u64;
    let mut cost = 0.0f64;
    for message in &messages {
        match message.get("role").and_then(Value::as_str) {
            Some("user") => user_messages += 1,
            Some("assistant") => {
                assistant_messages += 1;
                tool_calls += tool_call_count(message);
                if let Some(usage) = message.get("usage") {
                    input += usage
                        .get("input")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    output += usage
                        .get("output")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    cache_read += usage
                        .get("cacheRead")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    cache_write += usage
                        .get("cacheWrite")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    cost += usage
                        .get("cost")
                        .and_then(|cost| cost.get("total"))
                        .and_then(Value::as_f64)
                        .unwrap_or_default();
                }
            }
            Some("toolResult") => tool_results += 1,
            _ => {}
        }
    }
    let mut stats = json!({
        "sessionFile": store.path.display().to_string(),
        "sessionId": store.session_id(),
        "userMessages": user_messages,
        "assistantMessages": assistant_messages,
        "toolCalls": tool_calls,
        "toolResults": tool_results,
        "totalMessages": messages.len(),
        "tokens": {
            "input": input,
            "output": output,
            "cacheRead": cache_read,
            "cacheWrite": cache_write,
            "total": input + output + cache_read + cache_write,
        },
        "cost": cost,
    });
    if let Some(usage) = context_usage(&branch, &messages, context_window) {
        stats["contextUsage"] = usage;
    }
    stats
}

/// `contextUsage` for one whole store (the `get_context_tree` root node):
/// `None` when the context window is unknown, matching `session_stats`.
pub(crate) fn store_context_usage(
    store: &SessionFile,
    context_window: Option<u64>,
) -> Option<Value> {
    let branch = store.branch();
    let messages: Vec<&Value> = branch
        .iter()
        .filter(|entry| entry.type_ == "message")
        .filter_map(|entry| entry.fields.get("message"))
        .collect();
    context_usage(&branch, &messages, context_window)
}

/// `toolCall` content blocks on one assistant message.
fn tool_call_count(message: &Value) -> u64 {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("toolCall"))
                .count() as u64
        })
        .unwrap_or_default()
}

/// Estimated context usage (TS `getContextUsage`): the last valid assistant
/// usage plus trailing message estimates, `null` tokens right after a
/// compaction without a usable post-compaction usage. `None` when the
/// context window is unknown.
fn context_usage(
    branch: &[&SessionEntry],
    messages: &[&Value],
    context_window: Option<u64>,
) -> Option<Value> {
    let context_window = context_window.filter(|window| *window > 0)?;

    // The latest compaction entry on the branch, if any (TS
    // `getLatestCompactionEntry`).
    let compaction_index = branch.iter().rposition(|entry| entry.type_ == "compaction");
    if let Some(compaction_index) = compaction_index {
        // Only usage from an assistant that responded after the compaction
        // boundary is trustworthy: earlier usage reflects the pre-compaction
        // context size.
        let post_compaction_usage = branch
            .iter()
            .rev()
            .take(branch.len() - compaction_index - 1)
            .filter_map(|entry| entry.fields.get("message"))
            .find_map(valid_assistant_usage);
        let usable = post_compaction_usage
            .map(|usage| calculate_context_tokens(&usage) > 0)
            .unwrap_or(false);
        if !usable {
            return Some(json!({
                "tokens": Value::Null,
                "contextWindow": context_window,
                "percent": Value::Null,
            }));
        }
    }

    // TS `estimateContextTokens`: the last valid assistant usage anchors the
    // estimate; messages after it are added with the chars/4 heuristic.
    let mut tokens = 0u64;
    match messages
        .iter()
        .rposition(|message| valid_assistant_usage(message).is_some())
    {
        Some(last_usage_index) => {
            let usage = valid_assistant_usage(messages[last_usage_index]).expect("checked");
            tokens += calculate_context_tokens(&usage);
            tokens += messages[last_usage_index + 1..]
                .iter()
                .map(|message| estimate_tokens(message))
                .sum::<u64>();
        }
        None => {
            tokens += messages
                .iter()
                .map(|message| estimate_tokens(message))
                .sum::<u64>();
        }
    }
    let percent = tokens as f64 / context_window as f64 * 100.0;
    Some(json!({
        "tokens": tokens,
        "contextWindow": context_window,
        "percent": percent,
    }))
}

/// `totalTokens` when present, else the four-field sum (TS
/// `calculateContextTokens` over the raw usage object).
#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, fields: Value) -> Value {
        let mut value = json!({ "role": role });
        if let (Some(object), Some(fields)) = (value.as_object_mut(), fields.as_object()) {
            for (key, field) in fields {
                object.insert(key.clone(), field.clone());
            }
        }
        value
    }

    fn store_with(entries: &[(&str, Value)]) -> SessionFile {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let path = dir.path().join("session.jsonl");
        let mut lines = vec![json!({
            "type": "session", "version": 3, "id": "s1",
            "timestamp": "2026-09-16T02:10:02.842Z", "cwd": "/tmp",
        })
        .to_string()];
        let mut parent_id = Option::<String>::None;
        for (index, (type_, fields)) in entries.iter().enumerate() {
            let id = format!("e{index}");
            let mut entry = json!({
                "type": type_,
                "id": id,
                "timestamp": "2026-09-16T02:11:00.000Z",
            });
            if let (Some(object), Some(fields)) = (entry.as_object_mut(), fields.as_object()) {
                for (key, field) in fields {
                    object.insert(key.clone(), field.clone());
                }
                if let Some(parent) = &parent_id {
                    object.insert("parentId".to_string(), json!(parent));
                }
            }
            parent_id = Some(id);
            lines.push(entry.to_string());
        }
        let content = lines.join("\n");
        std::fs::write(&path, content).expect("write session");
        SessionFile::open(&path).expect("open session file")
    }

    fn entry_with_usage(total_tokens: u64) -> (&'static str, Value) {
        let usage = if total_tokens > 0 {
            json!({
                "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                "totalTokens": total_tokens,
                "cost": { "total": 0.25 },
            })
        } else {
            json!({
                "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                "cost": { "total": 0.25 },
            })
        };
        (
            "message",
            json!({
                "message": message("assistant", json!({
                    "content": [
                        { "type": "text", "text": "hello" },
                        { "type": "toolCall", "name": "bash", "arguments": { "command": "ls" } },
                    ],
                    "usage": usage,
                }))
            }),
        )
    }

    #[test]
    fn counts_messages_tool_calls_and_tokens() {
        let store = store_with(&[
            (
                "message",
                json!({ "message": message("user", json!({ "content": "hi there" })) }),
            ),
            entry_with_usage(128),
            (
                "message",
                json!({ "message": message("toolResult", json!({ "content": "out" })) }),
            ),
        ]);
        let stats = session_stats(&store, Some(1000));
        let expected = json!({
            "sessionFile": store.path.display().to_string(),
            "sessionId": "s1",
            "userMessages": 1,
            "assistantMessages": 1,
            "toolCalls": 1,
            "toolResults": 1,
            "totalMessages": 3,
            "tokens": { "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "total": 15 },
            "cost": 0.25,
            "contextUsage": { "tokens": 129, "contextWindow": 1000, "percent": 12.9 },
        });
        assert_eq!(stats, expected);
    }

    #[test]
    fn context_usage_sums_trailing_estimates() {
        // No usage at all: everything is estimated.
        let store = store_with(&[(
            "message",
            json!({ "message": message("user", json!({ "content": "12345678" })) }),
        )]);
        let stats = session_stats(&store, Some(1000));
        assert_eq!(stats["contextUsage"]["tokens"], 2, "8 chars / 4");
        assert_eq!(stats["contextUsage"]["percent"], 0.2);
    }

    #[test]
    fn compaction_without_post_usage_returns_null_tokens() {
        let store = store_with(&[
            (
                "message",
                json!({ "message": message("user", json!({ "content": "hi" })) }),
            ),
            entry_with_usage(50),
            ("compaction", json!({ "firstKeptEntryId": "e2" })),
            (
                "message",
                json!({ "message": message("user", json!({ "content": "again" })) }),
            ),
        ]);
        let stats = session_stats(&store, Some(1000));
        assert_eq!(stats["contextUsage"]["tokens"], Value::Null);
        assert_eq!(stats["contextUsage"]["percent"], Value::Null);
        assert_eq!(stats["contextUsage"]["contextWindow"], 1000);
    }

    #[test]
    fn compaction_with_post_usage_estimates() {
        let store = store_with(&[
            entry_with_usage(50),
            ("compaction", json!({ "firstKeptEntryId": "e1" })),
            entry_with_usage(300),
            (
                "message",
                json!({ "message": message("user", json!({ "content": "1234" })) }),
            ),
        ]);
        let stats = session_stats(&store, Some(1000));
        assert_eq!(
            stats["contextUsage"]["tokens"], 301,
            "300 usage + 1 estimated"
        );
    }

    #[test]
    fn no_context_window_omits_usage() {
        let store = store_with(&[entry_with_usage(128)]);
        let stats = session_stats(&store, None);
        assert!(stats.get("contextUsage").is_none());
    }

    #[test]
    fn aborted_assistant_usage_is_skipped() {
        let store = store_with(&[
            (
                "message",
                json!({ "message": message("assistant", json!({
                    "content": [{ "type": "text", "text": "partial" }],
                    "stopReason": "aborted",
                    "usage": { "input": 1, "output": 1, "totalTokens": 500 },
                })) }),
            ),
            entry_with_usage(128),
        ]);
        let stats = session_stats(&store, Some(1000));
        // The aborted turn still counts as an assistant message, but only
        // the valid usage anchors the estimate.
        assert_eq!(stats["assistantMessages"], 2);
        // Token totals sum every assistant usage, aborted or not (TS
        // getSessionStats does not filter on stopReason).
        assert_eq!(stats["tokens"]["total"], 17);
        assert_eq!(stats["contextUsage"]["tokens"], 128);
    }
}
