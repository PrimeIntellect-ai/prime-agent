//! `get_session_stats` over the worker session store, serving scripted and
//! real engine sessions. The token-estimate helpers live in
//! `pa_types::usage` (shared with pa-core's `compact.status` host request).

use serde_json::{json, Value};

use pa_types::usage::{calculate_context_tokens, estimate_tokens, valid_assistant_usage};

use crate::session_store::{SessionEntry, SessionFile};

/// Compute the `get_session_stats` response data for one session file.
/// `context_window` is the engine model's context window; `None` (or zero)
/// omits `contextUsage`.
///
/// The token/cost totals walk the ACTIVE BRANCH (gap-bridged) from the
/// latest compaction's `firstKeptEntryId` onward; the summarizer's own
/// usage rides the `compaction` entry. `contextUsage` keeps the strict branch.
pub fn session_stats(store: &SessionFile, context_window: Option<u64>) -> Value {
    let branch = store.branch();
    let messages: Vec<&Value> = branch
        .iter()
        .filter(|entry| entry.type_ == "message")
        .filter_map(|entry| entry.fields.get("message"))
        .collect();
    let (durable_messages, boundary) = kept_region_messages(store);
    let mut user_messages = 0u64;
    let mut assistant_messages = 0u64;
    let mut tool_results = 0u64;
    let mut tool_calls = 0u64;
    let mut input = 0u64;
    let mut output = 0u64;
    let mut cache_read = 0u64;
    let mut cache_write = 0u64;
    let mut cost = 0.0;
    for message in &durable_messages {
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
    // The window is a load optimization, not a session state: without a
    // compaction boundary the kept region covers the whole chain, and with
    // a boundary the retained region IS the kept region.
    let mut older_total_messages = 0u64;
    if boundary.is_none() {
        if let Some(window) = &store.window {
            let older = &window.older_path_stats;
            user_messages += older.user_messages;
            assistant_messages += older.assistant_messages;
            tool_results += older.tool_results;
            tool_calls += older.tool_calls;
            input += older.input;
            output += older.output;
            cache_read += older.cache_read;
            cache_write += older.cache_write;
            cost += older.cost;
            older_total_messages = older.total_messages;
        }
    }
    let total_messages = durable_messages.len() as u64 + older_total_messages;
    let mut stats = json!({
        "sessionFile": store.path.display().to_string(),
        "sessionId": store.session_id(),
        "userMessages": user_messages,
        "assistantMessages": assistant_messages,
        "toolCalls": tool_calls,
        "toolResults": tool_results,
        "totalMessages": total_messages,
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

/// The messages after the latest ON-CHAIN compaction: the active branch,
/// gap-bridged, restricted to the kept region (an off-chain compaction never
/// bounds it). Returns the messages and the boundary position (`None` = all kept).
fn kept_region_messages(store: &SessionFile) -> (Vec<&Value>, Option<usize>) {
    let entries = store.entries();
    let chain = store.branch_bridged_positions();
    // The latest compaction ON THE CHAIN bounds the kept region; its
    // `firstKeptEntryId` names the first row the post-compaction reload keeps.
    // A torn write that lost the boundary row falls back to the compaction entry.
    let boundary = chain
        .iter()
        .rev()
        .find(|position| entries[**position].type_ == "compaction")
        .map(|compaction| {
            entries[*compaction]
                .fields
                .get("firstKeptEntryId")
                .and_then(Value::as_str)
                .and_then(|id| chain.iter().find(|position| entries[**position].id == id))
                .unwrap_or(compaction)
        });
    let messages = chain
        .iter()
        .filter(|position| match boundary {
            Some(boundary) => **position >= *boundary,
            None => true,
        })
        .filter(|position| entries[**position].type_ == "message")
        .filter_map(|position| entries[*position].fields.get("message"))
        .collect();
    (messages, boundary.copied())
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

/// Estimated context usage: the last valid assistant usage plus trailing
/// message estimates; `null` tokens right after a compaction without a usable
/// post-compaction usage; `None` when the context window is unknown.
fn context_usage(
    branch: &[&SessionEntry],
    messages: &[&Value],
    context_window: Option<u64>,
) -> Option<Value> {
    let context_window = context_window.filter(|window| *window > 0)?;

    // The latest compaction entry on the branch, if any (TS `getLatestCompactionEntry`).
    let compaction_index = branch.iter().rposition(|entry| entry.type_ == "compaction");
    if let Some(compaction_index) = compaction_index {
        // Only usage from an assistant that responded after the compaction
        // boundary is trustworthy (earlier usage reflects the old context size).
        let post_compaction_usage = branch
            .iter()
            .rev()
            .take(branch.len() - compaction_index - 1)
            .filter_map(|entry| entry.fields.get("message"))
            .find_map(valid_assistant_usage);
        let usable =
            post_compaction_usage.is_some_and(|usage| calculate_context_tokens(&usage) > 0);
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

/// `totalTokens` when present, else the four-field sum.
#[cfg(test)]
mod tests;
