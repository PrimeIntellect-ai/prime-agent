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
///
/// TS `getSessionStats` sums `state.messages` — the in-memory
/// conversation, which after a compaction holds only what the latest
/// compaction kept (the session reloads at the boundary, so the
/// pre-boundary ancestry is gone from the active transcript; the
/// saved-list rows and the `/context` totals stay whole-file cumulative
/// on their own walks). TS `buildSessionContext` walks the leaf-to-root
/// PATH only, so the token/cost totals walk the ACTIVE BRANCH
/// (gap-bridged: a ghost-parent gap — one lost append — never drops
/// spend the session really logged) from the latest compaction's
/// `firstKeptEntryId` onward: a `branch_to` that moved away from a fork
/// leaves the abandoned sibling rows OUT of the rebuilt in-memory list,
/// and a compaction sitting on that abandoned branch never bounds the
/// active one. The summarizer's own usage rides the `compaction` entry,
/// never a message, so it stays out of the active totals. `contextUsage`
/// keeps the strict branch — the context estimate mirrors what the
/// model actually sees.
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
    // A windowed store never loads the discarded prefix, but without a
    // compaction boundary the kept region covers the whole chain: TS
    // `getSessionStats` sums `state.messages`, which still holds those
    // rows — the window is a load optimization, not a session state, so
    // the active totals must equal the full store's walk. The window
    // walk's older-path stats carry exactly the discarded prefix's
    // on-chain spend (attribution-folded). With a boundary, the retained
    // region IS the kept region: the discarded prefix is pre-cut
    // ancestry TS drops, and nothing is added.
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
    let costs = session_cost_split(store);
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
        "totalCost": costs.total,
        // The split behind the title's own + subagent aggregate pair:
        // the two halves sum to `totalCost`.
        "ownCost": costs.own,
        "subagentsCost": costs.subagents,
    });
    if let Some(usage) = context_usage(&branch, &messages, context_window) {
        stats["contextUsage"] = usage;
    }
    stats
}

/// The whole-session spend split into the session's own bill and its
/// descendant subagents' aggregate (the top bar's ask: the title shows
/// `"$own + $subagents (subagents)"`, both labeled — the agents view's
/// collapsed-row aggregate is the same rule over its forest records).
/// `total` is the pre-split `totalCost` fold: the `/context` root
/// `totalUsage`'s fold over the gap-bridged branch — cumulative across
/// compactions, priced per record (model switches and cache classes
/// correct by construction) — plus a windowed store's discarded-prefix
/// cost, so the two halves sum to what the title showed before the
/// split. Attributed child spend rides the parent's assistant rows (the
/// child-usage attribution fold lands descendant costs there, including
/// a deleted child's spend attributed before its deletion), so the walk
/// already carries every subagent's bill; `subagents` is the attributed
/// half — the retained region's own/total attribution gap plus the
/// discarded prefix's captured child batches.
struct SessionCostSplit {
    own: f64,
    subagents: f64,
    total: f64,
}

fn session_cost_split(store: &SessionFile) -> SessionCostSplit {
    let branch = store.branch_bridged();
    let all_entries = store.entries();
    let (own_usage, total_usage) =
        crate::state_getters::compute_own_and_total_usage(&branch, all_entries);
    let usage_cost = |usage: &Value| {
        usage
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or_default()
    };
    let retained_own = usage_cost(&own_usage);
    let retained_total = usage_cost(&total_usage);
    // The retained region's subagent spend is the attribution gap (the
    // own fold clamps at zero, so the difference is never negative).
    let retained_subagents = retained_total - retained_own;
    // The discarded prefix: its folded assistant rows plus the
    // `compaction` / `branch_summary` spend — the in-window walk bills
    // the retained region's summarizer rows, and the prefix's must
    // land here or the full-session total undercounts (the
    // summarizer's usage rides the entry, never a message — the
    // window stats' message fold alone misses them). The prefix's
    // captured child batches are the subagent half of the same folded
    // rows.
    let (prefix, prefix_subagents) = match store.window.as_ref() {
        Some(window) => {
            let stats = &window.older_path_stats;
            (
                stats.cost + stats.summarization_cost,
                stats.attributed_child_cost,
            )
        }
        None => (0.0, 0.0),
    };
    // The prefix's own half clamps at zero: attribution drift (or a
    // malformed batch) can push the child sums past the rows the walk
    // counted, and the full reader's own fold clamps per field the
    // same way — `ownCost` never goes negative, the aggregate never
    // exceeds the counted bill, and the pair still sums to `totalCost`.
    let prefix_subagents = prefix_subagents.min(prefix);
    SessionCostSplit {
        own: retained_own + (prefix - prefix_subagents),
        subagents: retained_subagents + prefix_subagents,
        total: retained_total + prefix,
    }
}

/// The messages TS `state.messages` holds after the latest compaction:
/// TS `buildSessionContext` walks the leaf-to-root PATH (the active
/// branch only) and keeps the messages from the latest compaction's
/// `firstKeptEntryId` onward — a sibling branch written after the
/// boundary (a `branch_to` moved away from it) is NOT in the rebuilt
/// in-memory list. The walk therefore follows the active branch,
/// gap-bridged (a lost append must not drop spend the session really
/// logged — the accounting bridge), restricted to the kept region; a
/// compaction sitting off the active branch (one written on the branch
/// that was moved away from) never bounds the active list, exactly like
/// the TS path walk that only sees its own ancestry's compaction.
/// Returns the kept-region messages and the boundary position (`None`
/// without a chain compaction — the whole chain is kept).
fn kept_region_messages(store: &SessionFile) -> (Vec<&Value>, Option<usize>) {
    let entries = store.entries();
    let chain = store.branch_bridged_positions();
    // The latest compaction ON THE CHAIN bounds the kept region (TS
    // `buildSessionContext` records the last compaction along its path);
    // its `firstKeptEntryId` names the first row the post-compaction
    // reload keeps. A torn write that lost the boundary row falls back to
    // the compaction entry itself: the rows after it are the
    // post-compaction transcript.
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

/// `totalTokens` when present, else the four-field sum (TS
/// `calculateContextTokens` over the raw usage object).
#[cfg(test)]
mod tests {
    use super::*;

    /// The captured-attribution fixture end to end: `get_session_stats`
    /// reports the folded (attributed) totals — cost $0 → $0.0089957,
    /// input 2690 → 52898 — while `totalTokens` stays 23032 (the
    /// aggregate keeps the row's context size, not a sum).
    #[test]
    fn captured_attribution_fixture_stats_count_the_fold() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/attribution-fold-captured.jsonl");
        let store = SessionFile::open(&path).unwrap();
        let stats = session_stats(&store, None);
        assert_eq!(stats["userMessages"], json!(2));
        assert_eq!(stats["assistantMessages"], json!(1));
        assert_eq!(stats["totalMessages"], json!(3));
        assert_eq!(
            stats["tokens"],
            json!({
                "input": 52898, "output": 5863, "cacheRead": 18560, "cacheWrite": 0,
                "total": 77321,
            })
        );
        assert_eq!(stats["cost"].as_f64(), Some(0.008_995_7));
    }

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

    /// A ghost-parent gap (one lost append) must not zero the token
    /// totals: the usage accounting bridges the gap, while the context
    /// estimate stays on the strict branch (the model-facing truth).
    #[test]
    fn ghost_gap_does_not_zero_the_token_totals() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("ghosted.jsonl");
        let assistant = json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "spent" }],
            "usage": {
                "input": 10, "output": 5, "cacheRead": 100, "cacheWrite": 0,
                "totalTokens": 115,
                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
            },
        })
        .to_string();
        let lines = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
            json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "hi"}}).to_string(),
            json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "message": serde_json::from_str::<serde_json::Value>(&assistant).unwrap()}).to_string(),
            json!({"type": "message", "id": "e3", "parentId": "8b5f0d21", "timestamp": "2026-09-22T00:00:03.000Z", "message": {"role": "user", "content": "after the gap"}}).to_string(),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        let store = SessionFile::open(&path).unwrap();
        assert_eq!(
            store.branch().len(),
            1,
            "the strict walk truncates at the ghost"
        );
        let stats = session_stats(&store, Some(1000));
        assert_eq!(
            stats["tokens"]["input"],
            json!(10),
            "the pre-gap usage counts"
        );
        assert_eq!(stats["tokens"]["output"], json!(5));
        assert_eq!(stats["tokens"]["cacheRead"], json!(100));
        assert_eq!(stats["tokens"]["total"], json!(115));
        assert_eq!(stats["assistantMessages"], json!(1));
        assert_eq!(stats["userMessages"], json!(2));
        // The context estimate anchors on the strict branch only: the gap
        // entry's user message estimates, the pre-gap assistant does not.
        assert_eq!(
            stats["contextUsage"]["tokens"],
            json!(4),
            "13 chars, ceil/4"
        );
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
            // No compaction, no attributions: the full-session total the
            // top bar shows equals the active cost — and with no
            // attributed spend, the split's own half is the whole bill.
            "totalCost": 0.25,
            "ownCost": 0.25,
            "subagentsCost": 0.0,
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

    /// The compaction boundary against the windowed reader, on a minimal
    /// synthetic compacted session (real transcripts are never committed;
    /// the `#[ignore]` test below re-verifies against the local capture).
    /// The pre-cut ancestry, the kept rows that precede the compaction
    /// entry in file order, the summarizer's own usage riding the
    /// compaction entry, and the post-compaction tail all pin their own
    /// numbers, and the parent chain stays intact from leaf to root so the
    /// windowed reader serves a real window that retains only the kept
    /// region - the parity claim is non-trivial: the windowed store never
    /// loads the pre-cut ancestry and must still report the same active
    /// numbers as the full store.
    #[test]
    fn compaction_boundary_serves_the_windowed_reader() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("windowed-boundary.jsonl");
        let usage = |input: u64, output: u64, cache_read: u64, total: u64, cost: f64| {
            // The full `UsageCost` shape: the typed `FileEntry::Compaction`
            // payload parses `usage` (the fixture's rows must deserialize
            // in the window walk), and the cost struct requires every
            // field — a bare `{ "total": ... }` fails the payload parse and
            // the boundary never forms.
            json!({
                "input": input, "output": output, "cacheRead": cache_read,
                "cacheWrite": 0, "totalTokens": total,
                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": cost },
            })
        };
        let row = |id: &str, parent: Option<&str>, value: Value| {
            json!({
                "type": "message", "id": id, "parentId": parent,
                "timestamp": "2026-09-23T00:00:00.000Z",
                "message": value,
            })
            .to_string()
        };
        let user = |id: &str, parent: Option<&str>| {
            row(id, parent, message("user", json!({ "content": "hi" })))
        };
        let assistant = |id: &str, parent: Option<&str>, spent: Value| {
            row(
                id,
                parent,
                message(
                    "assistant",
                    json!({
                        "provider": "prime-inference", "model": "internal/glm-5.3-fast",
                        "content": [{ "type": "text", "text": "hi" }],
                        "stopReason": "stop",
                        "usage": spent,
                    }),
                ),
            )
        };
        let lines = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-23T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
            // Pre-cut ancestry: spend the active stats must not report.
            user("u1", None),
            assistant("a1", Some("u1"), usage(1000, 200, 5000, 6200, 0.75)),
            user("u2", Some("a1")),
            assistant("a2", Some("u2"), usage(800, 150, 3000, 3950, 1.25)),
            // The kept region starts at u3 (firstKeptEntryId); the kept
            // rows precede the compaction entry in file order, as in a
            // real compacted file.
            user("u3", Some("a2")),
            assistant("a3", Some("u3"), usage(600, 120, 2000, 2720, 0.25)),
            json!({
                "type": "compaction", "id": "c1", "parentId": "a3",
                "timestamp": "2026-09-23T00:00:00.000Z",
                "summary": "summary", "firstKeptEntryId": "u3", "tokensBefore": 100,
                "usage": usage(9999, 99, 0, 10098, 0.5),
            })
            .to_string(),
            // Post-compaction tail; a5 is the leaf the window follows.
            user("u4", Some("c1")),
            assistant("a4", Some("u4"), usage(400, 80, 1000, 1480, 0.125)),
            user("u5", Some("a4")),
            assistant("a5", Some("u5"), usage(500, 100, 2500, 3100, 0.5)),
        ];
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        let full = SessionFile::open(&path).unwrap();
        let windowed = SessionFile::open_windowed(&path).unwrap();
        assert!(
            windowed.window.is_some(),
            "the intact ancestry must serve a real window"
        );
        assert!(
            windowed.by_id.contains_key("u3") && !windowed.by_id.contains_key("a2"),
            "the window loads the kept region only, without the pre-cut ancestry"
        );
        let expected = json!({
            "sessionFile": path.display().to_string(),
            "sessionId": "s1",
            "userMessages": 3,
            "assistantMessages": 3,
            "toolCalls": 0,
            "toolResults": 0,
            "totalMessages": 6,
            "tokens": {
                "input": 1_500, "output": 300, "cacheRead": 5_500,
                "cacheWrite": 0, "total": 7_300,
            },
            "cost": 0.875,
            // The full-session total the top bar shows: the whole
            // gap-bridged branch's cumulative spend — the pre-cut
            // ancestry (0.75 + 1.25) plus the kept region (0.25 + 0.125 +
            // 0.5) plus the summarizer's own compaction spend (0.5) —
            // never the post-compaction drop the active `cost` takes.
            "totalCost": 3.375,
            // No attributed child spend anywhere: the own half carries
            // the whole bill and the subagent aggregate is zero.
            "ownCost": 3.375,
            "subagentsCost": 0.0,
            "contextUsage": {
                "tokens": 3_100, "contextWindow": 1_000, "percent": 310.0,
            },
        });
        assert_eq!(session_stats(&full, Some(1_000)), expected);
        // The windowed store (retained region) and the full store walk the
        // same kept region and must serve identical active numbers — and
        // the discarded prefix rides the window stats into the same
        // full-session total.
        assert_eq!(session_stats(&windowed, Some(1_000)), expected);
    }

    /// The audit's captured devbox session (TS-written, sanitized: content
    /// stripped; ids, parentIds, timestamps, roles, usage, and the
    /// compaction row verbatim): one compaction at the audit-captured
    /// boundary where the pre-cut ancestry carries 952 assistant turns /
    /// $0.2900872 / 154,979,520 cacheRead that TS drops from the active
    /// stats, and the kept region is the 2622 turns / $3.921395 TS
    /// reports post-compaction. Real captured transcripts are never
    /// committed; point `PA_ACTIVE_STATS_CAPTURED_FIXTURE` at a local
    /// copy to run it.
    #[test]
    #[ignore = "set PA_ACTIVE_STATS_CAPTURED_FIXTURE to the captured session path"]
    fn captured_compaction_boundary_matches_ts_active_stats() {
        let fixture = std::env::var("PA_ACTIVE_STATS_CAPTURED_FIXTURE")
            .expect("set PA_ACTIVE_STATS_CAPTURED_FIXTURE to the captured session path");
        let path = std::path::PathBuf::from(fixture);
        let full = SessionFile::open(&path).expect("fixture opens");
        let windowed = SessionFile::open_windowed(&path).expect("windowed open");
        assert!(
            windowed.window.is_some(),
            "fixture must exercise the windowed reader"
        );
        let expected = json!({
            "sessionFile": path.display().to_string(),
            "sessionId": "01a0a7fa-3d00-773b-bd1e-a97597d89476",
            "userMessages": 348,
            "assistantMessages": 2622,
            "toolCalls": 748,
            "toolResults": 748,
            "totalMessages": 3718,
            "tokens": {
                "input": 3_667_340,
                "output": 142_884,
                "cacheRead": 219_856_050,
                "cacheWrite": 269_974,
                "total": 223_936_248,
            },
            "cost": 3.921_395,
            "contextUsage": {
                "tokens": 53_519,
                "contextWindow": 200_000,
                "percent": 26.759_500_000_000_003,
            },
        });
        let mut full_stats = session_stats(&full, Some(200_000));
        let full_total_cost = full_stats["totalCost"].as_f64().expect("totalCost");
        full_stats
            .as_object_mut()
            .expect("stats object")
            .remove("totalCost");
        assert_eq!(full_stats, expected);
        // The windowed store (retained region) and the full store walk the
        // same kept region and must serve identical active numbers — and
        // the discarded prefix rides the window stats into the same
        // full-session total.
        let mut windowed_stats = session_stats(&windowed, Some(200_000));
        assert_eq!(
            windowed_stats["totalCost"].as_f64(),
            Some(full_total_cost),
            "the windowed reader must carry the discarded prefix into the total"
        );
        windowed_stats
            .as_object_mut()
            .expect("stats object")
            .remove("totalCost");
        assert_eq!(windowed_stats, expected);
        // The full-session total the top bar shows exceeds the active
        // region's cost by the pre-cut ancestry ($0.2900872) plus the
        // summarizer's own spend.
        assert!(
            full_total_cost > 3.921_395,
            "the cumulative total must not drop the pre-cut spend: {full_total_cost}"
        );
    }

    /// The top bar's full-session total (the operator's ask): a session
    /// whose subagent attributed spend onto a kept assistant row, after a
    /// compaction. The TS active `cost` reads the kept region only
    /// ($0.25 — the folded aggregate, child spend included) and DROPS
    /// the pre-cut ancestry — the inaccurate title number today; the
    /// `totalCost` the title now shows is the whole session + subagents:
    /// the pre-cut turn ($1.0), the summarizer ($0.1), and the kept
    /// parent turn with the child's attributed spend folded in ($0.25).
    #[test]
    fn total_cost_carries_the_session_and_its_subagents_across_compaction() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("title-total.jsonl");
        let usage = |cost: f64| {
            json!({
                "input": 100, "output": 50, "cacheRead": 0, "cacheWrite": 0,
                "totalTokens": 150,
                "cost": { "input": 0, "output": cost, "cacheRead": 0, "cacheWrite": 0, "total": cost },
            })
        };
        let lines = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-23T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
            json!({"type": "message", "id": "u1", "parentId": null, "timestamp": "t", "message": {"role": "user", "content": "hi"}}).to_string(),
            json!({"type": "message", "id": "a1", "parentId": "u1", "timestamp": "t", "message": {"role": "assistant", "provider": "prime-inference", "model": "internal/glm-5.3-fast", "content": [], "stopReason": "stop", "usage": usage(1.0)}}).to_string(),
            json!({"type": "compaction", "id": "c1", "parentId": "a1", "timestamp": "t", "summary": "s", "firstKeptEntryId": "u2", "tokensBefore": 100, "usage": usage(0.1)}).to_string(),
            json!({"type": "message", "id": "u2", "parentId": "c1", "timestamp": "t", "message": {"role": "user", "content": "go"}}).to_string(),
            json!({"type": "message", "id": "a2", "parentId": "u2", "timestamp": "t", "message": {"role": "assistant", "provider": "prime-inference", "model": "internal/glm-5.3-fast", "content": [], "stopReason": "stop", "usage": usage(0.2)}}).to_string(),
            // The subagent's spend lands on the parent's assistant row:
            // the child-usage attribution fold the title total reads.
            json!({
                "type": "child_usage_attributed", "id": "cu1", "parentId": "a2",
                "timestamp": "t", "targetId": "a2",
                "childUsage": usage(0.05),
                "aggregateUsage": usage(0.25),
            })
            .to_string(),
        ];
        std::fs::write(
            &path,
            format!(
                "{}
",
                lines.join(
                    "
"
                )
            ),
        )
        .unwrap();
        let store = SessionFile::open(&path).unwrap();
        let stats = session_stats(&store, None);
        // The TS active cost: the kept region's folded aggregate only.
        assert_eq!(stats["cost"].as_f64(), Some(0.25));
        // The full-session total the top bar shows: own spend across the
        // whole session (pre-cut + kept) + the summarizer + the
        // subagent's attributed spend — exact float order of the fold.
        assert_eq!(stats["totalCost"].as_f64(), Some(1.0 + 0.1 + 0.25));
        // The title's split (own + subagents, labeled): the own half
        // bills the session's own turns (pre-cut $1.0, the summarizer
        // $0.1, the kept turn's raw spend $0.2), the subagent half the
        // attributed spend — and the pair sums back to the pre-split
        // total exactly.
        assert_eq!(stats["ownCost"].as_f64(), Some(1.0 + 0.1 + 0.2));
        assert!((stats["subagentsCost"].as_f64().unwrap() - 0.05).abs() < 1e-9);
        assert_eq!(
            stats["ownCost"].as_f64().unwrap() + stats["subagentsCost"].as_f64().unwrap(),
            stats["totalCost"].as_f64().unwrap()
        );
    }

    /// The title's own/subagent split over a REAL windowed session (the
    /// regression this change adds): a subagent settled BEFORE the
    /// compaction (its attribution targets a discarded-prefix assistant)
    /// and one settled after (attribution on a kept row). Both halves
    /// must split identically on the full and windowed readers — without
    /// the prefix's captured child batches the windowed reader would
    /// bill the pre-cut subagent's $0.0625 to the session's own cost.
    /// Every fixture cost is a dyadic rational, so the folds are exact.
    #[test]
    fn cost_split_bills_the_windowed_prefixs_subagent_batches() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("windowed-split.jsonl");
        let usage = |cost: f64| {
            json!({
                "input": 100, "output": 50, "cacheRead": 0, "cacheWrite": 0,
                "totalTokens": 150,
                "cost": { "input": 0, "output": cost, "cacheRead": 0, "cacheWrite": 0, "total": cost },
            })
        };
        let attribution = |id: &str, parent: &str, target: &str, child: f64, aggregate: f64| {
            json!({
                "type": "child_usage_attributed", "id": id, "parentId": parent,
                "timestamp": "2026-09-23T00:00:00.000Z", "targetId": target,
                "childUsage": usage(child), "aggregateUsage": usage(aggregate),
            })
            .to_string()
        };
        let user = |id: &str, parent: Option<&str>| {
            json!({
                "type": "message", "id": id, "parentId": parent,
                "timestamp": "2026-09-23T00:00:00.000Z",
                "message": {"role": "user", "content": "hi"},
            })
            .to_string()
        };
        let assistant = |id: &str, parent: Option<&str>, cost: f64| {
            json!({
                "type": "message", "id": id, "parentId": parent,
                "timestamp": "2026-09-23T00:00:00.000Z",
                "message": {"role": "assistant", "provider": "prime-inference",
                            "model": "internal/glm-5.3-fast",
                            "content": [{"type": "text", "text": "hi"}],
                            "stopReason": "stop", "usage": usage(cost)},
            })
            .to_string()
        };
        // The real compacted-file layout: the kept rows precede the
        // compaction entry that names them (`firstKeptEntryId`), so the
        // window boundary sits between cu1 and u2 — a1's attributed
        // child spend rides the discarded prefix, a2's the kept region.
        let lines = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-23T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
            user("u1", None),
            assistant("a1", Some("u1"), 0.125),
            attribution("cu1", "a1", "a1", 0.0625, 0.1875),
            user("u2", Some("cu1")),
            assistant("a2", Some("u2"), 0.25),
            json!({
                "type": "compaction", "id": "c1", "parentId": "a2",
                "timestamp": "2026-09-23T00:00:00.000Z",
                "summary": "s", "firstKeptEntryId": "u2", "tokensBefore": 100,
                "usage": usage(0.03125),
            })
            .to_string(),
            attribution("cu2", "c1", "a2", 0.0625, 0.3125),
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let full = SessionFile::open(&path).unwrap();
        let windowed = SessionFile::open_windowed(&path).unwrap();
        assert!(
            windowed.window.is_some(),
            "the fixture must serve a real window"
        );
        // The whole-session bill: the pre-cut turn folded with its
        // child's spend ($0.1875), the retained summarizer ($0.03125),
        // and the kept turn folded with its child's spend ($0.3125) —
        // half of it (2 * $0.0625) is subagent spend.
        let expected = json!({
            "totalCost": 0.53125,
            "ownCost": 0.40625,
            "subagentsCost": 0.125,
        });
        for (label, store) in [("full", &full), ("windowed", &windowed)] {
            let stats = session_stats(store, None);
            assert_eq!(
                stats["totalCost"].as_f64(),
                expected["totalCost"].as_f64(),
                "{label}"
            );
            assert_eq!(
                stats["ownCost"].as_f64(),
                expected["ownCost"].as_f64(),
                "{label}"
            );
            assert_eq!(
                stats["subagentsCost"].as_f64(),
                expected["subagentsCost"].as_f64(),
                "{label}"
            );
        }
    }

    /// The split's halves never invert on attribution drift: a prefix
    /// attribution whose child batch exceeds the rows the walk counted
    /// (here the aggregate lags its own child batch) clamps — the own
    /// half stays non-negative and the aggregate never exceeds the
    /// counted bill, mirroring the full reader's per-field own clamp.
    /// Drifted files may split differently across the full and windowed
    /// readers; the totals still agree, and both halves stay sane on
    /// every open. Every fixture cost is a dyadic rational, so the
    /// folds are exact.
    #[test]
    fn cost_split_clamps_the_prefix_at_zero() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("windowed-drift.jsonl");
        let usage = |cost: f64| {
            json!({
                "input": 100, "output": 50, "cacheRead": 0, "cacheWrite": 0,
                "totalTokens": 150,
                "cost": { "input": 0, "output": cost, "cacheRead": 0, "cacheWrite": 0, "total": cost },
            })
        };
        let row = |value: Value| value.to_string();
        let lines = [
            row(json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-23T00:00:00.000Z", "cwd": "/tmp"})),
            row(json!({"type": "message", "id": "u1", "parentId": null, "timestamp": "t", "message": {"role": "user", "content": "hi"}})),
            row(json!({"type": "message", "id": "a1", "parentId": "u1", "timestamp": "t", "message": {"role": "assistant", "provider": "prime-inference", "model": "internal/glm-5.3-fast", "content": [], "stopReason": "stop", "usage": usage(0.125)}})),
            // A drifted attribution: the child batch ($0.5) exceeds the
            // aggregate its own row reports ($0.1875 - raw $0.125).
            row(json!({
                "type": "child_usage_attributed", "id": "cu1", "parentId": "a1",
                "timestamp": "t", "targetId": "a1",
                "childUsage": usage(0.5), "aggregateUsage": usage(0.1875),
            })),
            row(json!({"type": "message", "id": "u2", "parentId": "cu1", "timestamp": "t", "message": {"role": "user", "content": "go"}})),
            row(json!({"type": "message", "id": "a2", "parentId": "u2", "timestamp": "t", "message": {"role": "assistant", "provider": "prime-inference", "model": "internal/glm-5.3-fast", "content": [], "stopReason": "stop", "usage": usage(0.25)}})),
            row(json!({
                "type": "compaction", "id": "c1", "parentId": "a2",
                "timestamp": "t", "summary": "s", "firstKeptEntryId": "u2", "tokensBefore": 100,
                "usage": usage(0.03125),
            })),
            row(json!({
                "type": "child_usage_attributed", "id": "cu2", "parentId": "c1",
                "timestamp": "t", "targetId": "a2",
                "childUsage": usage(0.0625), "aggregateUsage": usage(0.3125),
            })),
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let windowed = SessionFile::open_windowed(&path).unwrap();
        assert!(
            windowed.window.is_some(),
            "the fixture must serve a real window"
        );
        let stats = session_stats(&windowed, None);
        // Retained ($0.34375: the kept turn's aggregate plus the
        // summarizer) + prefix ($0.1875): the drift clamps the prefix's
        // subagent half to its counted bill, so the own half keeps the
        // retained region's own spend.
        assert_eq!(stats["totalCost"].as_f64(), Some(0.53125));
        assert_eq!(stats["ownCost"].as_f64(), Some(0.28125));
        assert_eq!(stats["subagentsCost"].as_f64(), Some(0.25));
        assert_eq!(
            stats["ownCost"].as_f64().unwrap() + stats["subagentsCost"].as_f64().unwrap(),
            stats["totalCost"].as_f64().unwrap()
        );
    }

    /// The windowed reader must not drop the discarded prefix's
    /// summarizer spend (the Bugbot round's regression): a session with
    /// TWO compactions — the old cut's row in the discarded prefix, the
    /// new cut's row retained — bills both summarizer rows in the
    /// full-session total. Without the window-walk fix the windowed
    /// reader undercounts by the old summarizer's bill (the prefix's
    /// message fold alone never sees a `compaction` entry's usage).
    #[test]
    fn total_cost_bills_the_discarded_prefixs_summarizer_rows() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("windowed-summarizer.jsonl");
        let usage = |cost: f64| {
            json!({
                "input": 100, "output": 50, "cacheRead": 0, "cacheWrite": 0,
                "totalTokens": 150,
                "cost": { "input": 0, "output": cost, "cacheRead": 0, "cacheWrite": 0, "total": cost },
            })
        };
        let row = |value: Value| value.to_string();
        let user = |id: &str, parent: Option<&str>| {
            row(json!({
                "type": "message", "id": id, "parentId": parent,
                "timestamp": "2026-09-23T00:00:00.000Z",
                "message": {"role": "user", "content": "hi"},
            }))
        };
        let assistant = |id: &str, parent: Option<&str>, cost: f64| {
            row(json!({
                "type": "message", "id": id, "parentId": parent,
                "timestamp": "2026-09-23T00:00:00.000Z",
                "message": {"role": "assistant", "provider": "prime-inference",
                            "model": "internal/glm-5.3-fast",
                            "content": [{"type": "text", "text": "hi"}],
                            "stopReason": "stop", "usage": usage(cost)},
            }))
        };
        let compaction = |id: &str, parent: &str, kept: &str, cost: f64| {
            row(json!({
                "type": "compaction", "id": id, "parentId": parent,
                "timestamp": "2026-09-23T00:00:00.000Z",
                "summary": "s", "firstKeptEntryId": kept, "tokensBefore": 100,
                "usage": usage(cost),
            }))
        };
        // The real compacted-file layout: the kept rows precede the
        // compaction entry that names them (`firstKeptEntryId`), one
        // compaction per cut — the old cut's row rides the discarded
        // prefix, the new cut's row the retained region.
        let lines = [
            row(
                json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-23T00:00:00.000Z", "cwd": "/tmp"}),
            ),
            user("u1", None),
            assistant("a1", Some("u1"), 0.5),
            user("u2", Some("a1")),
            assistant("a2", Some("u2"), 0.125),
            compaction("c_early", "a2", "u2", 0.25),
            user("u3", Some("c_early")),
            assistant("a3", Some("u3"), 0.25),
            compaction("c_late", "a3", "u3", 0.5),
            user("u4", Some("c_late")),
            assistant("a4", Some("u4"), 0.5),
        ];
        std::fs::write(
            &path,
            format!(
                "{}
",
                lines.join(
                    "
"
                )
            ),
        )
        .unwrap();
        let full = SessionFile::open(&path).unwrap();
        let windowed = SessionFile::open_windowed(&path).unwrap();
        assert!(
            windowed.window.is_some(),
            "the fixture must serve a real window"
        );
        // Both readers report the same full-session total: the prefix's
        // assistant spend ($0.625) + the old summarizer ($0.25) + the
        // retained turns ($0.75) and summarizer ($0.5) — exact float
        // order of the fold.
        let expected = 0.5 + 0.125 + 0.25 + 0.25 + 0.5 + 0.5;
        assert_eq!(
            session_stats(&full, None)["totalCost"].as_f64(),
            Some(expected)
        );
        assert_eq!(
            session_stats(&windowed, None)["totalCost"].as_f64(),
            Some(expected),
            "the windowed reader must carry the discarded prefix's summarizer spend"
        );
    }

    /// The compaction boundary in miniature: the pre-cut ancestry is spend
    /// the active stats must not report; the kept region — kept rows
    /// before the compaction entry and a ghost-parent row whose parent
    /// was minted but never persisted — is what they must. The
    /// side-question FORK (cm1/a4, chained from the same compaction row
    /// the active line continues from) is spend the RELOADED active list
    /// does not hold: TS `buildSessionContext` walks the leaf-to-root
    /// path only, so a branch moved away from (and the forks it left
    /// behind) stay out of the stats — their spend survives on the
    /// whole-file surfaces (the saved rows, `/context`). The
    /// summarizer's own usage rides the compaction entry and stays out.
    #[test]
    fn compaction_boundary_drops_the_pre_cut_ancestry() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("boundary.jsonl");
        let assistant = |id: &str, parent: Option<&str>, cost: f64| {
            json!({
                "type": "message", "id": id, "parentId": parent,
                "timestamp": "2026-09-23T00:00:00.000Z",
                "message": {
                    "role": "assistant",
                    "provider": "prime-inference", "model": "internal/glm-5.3-fast",
                    "content": [{ "type": "text", "text": "hi" }],
                    "stopReason": "stop",
                    "usage": { "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                               "totalTokens": 15, "cost": { "total": cost } },
                },
            })
            .to_string()
        };
        let user = |id: &str, parent: Option<&str>| {
            json!({
                "type": "message", "id": id, "parentId": parent,
                "timestamp": "2026-09-23T00:00:00.000Z",
                "message": { "role": "user", "content": "hi" },
            })
            .to_string()
        };
        let lines = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-23T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
            user("u1", None),
            assistant("a1", Some("u1"), 0.125),
            user("u2", Some("a1")),
            assistant("a2", Some("u2"), 0.25),
            // The kept region starts at u3 (firstKeptEntryId); the kept
            // rows precede the compaction entry in file order, as in a
            // real compacted file.
            user("u3", Some("a2")),
            assistant("a3", Some("u3"), 0.25),
            json!({
                "type": "compaction", "id": "c1", "parentId": "a3",
                "timestamp": "2026-09-23T00:00:00.000Z",
                "summary": "summary", "firstKeptEntryId": "u3", "tokensBefore": 100,
                "usage": { "input": 999, "output": 9, "cacheRead": 0, "cacheWrite": 0,
                           "totalTokens": 1008, "cost": { "total": 0.75 } },
            })
            .to_string(),
            json!({
                "type": "custom_message", "id": "cm1", "parentId": "c1",
                "timestamp": "2026-09-23T00:00:00.000Z",
                "customType": "agent_message", "content": "side", "display": true,
            })
            .to_string(),
            assistant("a4", Some("cm1"), 0.5),
            user("u4", Some("c1")),
            assistant("a5", Some("u4"), 0.25),
            user("u5", Some("a5")),
            assistant("a6", Some("ghost01"), 0.5),
        ];
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        let full = SessionFile::open(&path).unwrap();
        let windowed = SessionFile::open_windowed(&path).unwrap();
        // The ghost parent dangles the windowed reader's chain-following,
        // so it falls back to the full reader: both stores must still
        // serve the same kept-region numbers.
        assert!(windowed.window.is_none());
        let expected = json!({
            "sessionFile": path.display().to_string(),
            "sessionId": "s1",
            "userMessages": 3,
            "assistantMessages": 3,
            "toolCalls": 0,
            "toolResults": 0,
            "totalMessages": 6,
            "tokens": { "input": 30, "output": 15, "cacheRead": 0, "cacheWrite": 0, "total": 45 },
            "cost": 1.0,
            // The full-session total: the gap-bridged branch reconnects
            // the ghost gap, so the pre-cut ancestry (0.125 + 0.25) rides
            // the cumulative walk with the kept region (0.25 + 0.25 +
            // 0.5) and the summarizer (0.75) — the side-question fork
            // (0.5) stays off the branch, exactly like the /context
            // totals.
            "totalCost": 2.125,
            // No attributions on the gap-bridged branch: the own half
            // is the whole bill.
            "ownCost": 2.125,
            "subagentsCost": 0.0,
            // The strict branch truncates at the ghost parent, so the
            // context estimate anchors on the last row alone.
            "contextUsage": { "tokens": 15, "contextWindow": 1000, "percent": 1.5 },
        });
        assert_eq!(session_stats(&full, Some(1000)), expected);
        assert_eq!(session_stats(&windowed, Some(1000)), expected);
    }

    /// A compaction written on an ABANDONED branch never bounds the
    /// active list: TS `buildSessionContext` records the last compaction
    /// along its leaf-to-root path only, so the active line keeps its own
    /// full history (and the fork's rows — including its compaction and
    /// the fork's post-compaction spend — stay out of the active stats).
    #[test]
    fn an_abandoned_branchs_compaction_never_bounds_the_active_list() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("fork-compaction.jsonl");
        let assistant = |id: &str, parent: Option<&str>, cost: f64| {
            json!({
                "type": "message", "id": id, "parentId": parent,
                "timestamp": "2026-09-23T00:00:00.000Z",
                "message": {
                    "role": "assistant",
                    "provider": "prime-inference", "model": "internal/glm-5.3-fast",
                    "content": [{ "type": "text", "text": "hi" }],
                    "stopReason": "stop",
                    "usage": { "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                               "totalTokens": 15, "cost": { "total": cost } },
                },
            })
            .to_string()
        };
        let user = |id: &str, parent: Option<&str>| {
            json!({
                "type": "message", "id": id, "parentId": parent,
                "timestamp": "2026-09-23T00:00:00.000Z",
                "message": { "role": "user", "content": "hi" },
            })
            .to_string()
        };
        let lines = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-23T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
            user("u1", None),
            assistant("a1", Some("u1"), 0.25),
            user("u2", Some("a1")),
            assistant("a2", Some("u2"), 0.25),
            // An abandoned fork off u2: its rows AND its compaction sit in
            // the file AFTER the fork point but BEFORE the active line
            // continues.
            user("x1", Some("a2")),
            assistant("x2", Some("x1"), 0.25),
            json!({
                "type": "compaction", "id": "cx", "parentId": "x2",
                "timestamp": "2026-09-23T00:00:00.000Z",
                "summary": "fork summary", "firstKeptEntryId": "x1", "tokensBefore": 100,
                "usage": { "input": 999, "output": 9, "cacheRead": 0, "cacheWrite": 0,
                           "totalTokens": 1008, "cost": { "total": 0.75 } },
            })
            .to_string(),
            // The active line continues from a2 (the fork was abandoned).
            user("u3", Some("a2")),
            assistant("a3", Some("u3"), 0.25),
        ];
        std::fs::write(
            &path,
            format!(
                "{}
",
                lines.join(
                    "
"
                )
            ),
        )
        .unwrap();
        let store = SessionFile::open(&path).unwrap();
        let stats = session_stats(&store, None);
        // The active branch keeps its own full history — the abandoned
        // fork's compaction does not bound it (a file-order walk would
        // drop u1..a2 from the "kept region" and count the fork's rows).
        assert_eq!(stats["userMessages"], json!(3));
        assert_eq!(stats["assistantMessages"], json!(3));
        assert_eq!(stats["totalMessages"], json!(6));
        assert_eq!(stats["tokens"]["input"], json!(30));
        assert_eq!(stats["tokens"]["total"], json!(45));
        assert_eq!(stats["cost"], json!(0.75));
    }
}
