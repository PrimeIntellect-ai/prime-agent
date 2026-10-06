//! The child-side half of RLM usage attribution: splitting one child's
//! session rows into per-origin batches (the engine-side producer owns the rest).
//!
//! Origin labels: the task prompt is the spawn kickoff row (`spawn_task`);
//! user rows are `direct_user`; `error`/`aborted` fold nowhere.

use pa_types::ai::Usage;
use pa_types::session::ChildUsageOrigin;

use crate::session_store::SessionEntry;

/// Whether one row is a `message` entry of the given role.
fn message_role(entry: &SessionEntry, role: &str) -> bool {
    entry.type_ == "message"
        && entry
            .fields
            .get("message")
            .and_then(|message| message.get("role"))
            .and_then(serde_json::Value::as_str)
            == Some(role)
}

/// The nearest preceding user or agent-session message row labels a completion's origin; non-agent
/// custom rows and plain user rows label `direct_user`.
fn child_usage_origin(entries: &[SessionEntry], assistant_index: usize) -> ChildUsageOrigin {
    for index in (0..assistant_index).rev() {
        let entry = &entries[index];
        if message_role(entry, "user") {
            return ChildUsageOrigin::DirectUser;
        }
        if entry.type_ != "custom_message" {
            continue;
        }
        let is_agent_message = entry
            .fields
            .get("customType")
            .and_then(serde_json::Value::as_str)
            == Some(pa_core::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE);
        let message_id = entry
            .fields
            .get("details")
            .and_then(|details| details.get("id"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        return if is_agent_message && message_id.starts_with("spawn:") {
            ChildUsageOrigin::SpawnTask
        } else if is_agent_message {
            ChildUsageOrigin::AgentMessage
        } else {
            ChildUsageOrigin::DirectUser
        };
    }
    ChildUsageOrigin::DirectUser
}

/// One child assistant row's foldable usage: `message` rows with the assistant role and a
/// non-error, non-aborted stop reason (TS folds the child's `message_end` completions only).
fn assistant_usage(entry: &SessionEntry) -> Option<Usage> {
    if entry.type_ != "message" {
        return None;
    }
    let message = entry.fields.get("message")?;
    if message.get("role").and_then(serde_json::Value::as_str) != Some("assistant") {
        return None;
    }
    match message
        .get("stopReason")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
    {
        "error" | "aborted" => return None,
        _ => {}
    }
    message
        .get("usage")
        .cloned()
        .and_then(|usage| serde_json::from_value(usage).ok())
}

/// The per-origin usage delta of rows `[from..]`, in first-seen origin order, plus the next cursor:
/// every parsed row is consumed, attributed or not, so the walk never rescans.
pub(crate) fn child_usage_batches(
    entries: &[SessionEntry],
    from: usize,
) -> (Vec<(ChildUsageOrigin, Usage)>, usize) {
    let mut batches: Vec<(ChildUsageOrigin, Usage)> = Vec::new();
    for (index, entry) in entries.iter().enumerate().skip(from) {
        let Some(usage) = assistant_usage(entry) else {
            continue;
        };
        let origin = child_usage_origin(entries, index);
        match batches.iter_mut().find(|(origin_, _)| *origin_ == origin) {
            Some((_, total)) => {
                pa_core::session_engine::rlm_usage::add_assistant_usage(total, &usage);
            }
            None => batches.push((origin, usage)),
        }
    }
    (batches, entries.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn row(type_: &str, id: &str, fields: Value) -> SessionEntry {
        SessionEntry {
            type_: type_.to_string(),
            id: id.to_string(),
            parent_id: None,
            timestamp: "2026-09-23T00:00:00.000Z".to_string(),
            fields,
        }
    }

    fn user_row(id: &str) -> SessionEntry {
        row(
            "message",
            id,
            json!({"message": {"role": "user", "content": [{"type": "text", "text": "hi"}], "timestamp": 0}}),
        )
    }

    /// One assistant message row; `stop_reason` defaults to `toolUse`
    /// (completions mid-run), the usage block a real captured shape.
    fn assistant_row(id: &str, usage: &Value, stop_reason: &str) -> SessionEntry {
        row(
            "message",
            id,
            json!({"message": {"role": "assistant", "content": [], "stopReason": stop_reason, "usage": usage}}),
        )
    }

    fn custom_message_row(id: &str, custom_type: &str, details: &Value) -> SessionEntry {
        row(
            "custom_message",
            id,
            json!({"customType": custom_type, "details": details, "content": {"text": ""}, "display": true}),
        )
    }

    /// The spawn kickoff row (TS `spawnMessage`: the `agent_message` custom
    /// row with `details.id "spawn:<id>"`).
    fn spawn_kickoff_row(id: &str, message: &str) -> SessionEntry {
        custom_message_row(
            id,
            "agent_message",
            &json!({"id": "spawn:sub-1", "message": message}),
        )
    }

    fn captured_usage(input: u64, output: u64, total_tokens: u64, cost_total: f64) -> Value {
        json!({
            "input": input, "output": output, "cacheRead": 0, "cacheWrite": 0,
            "totalTokens": total_tokens,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": cost_total}
        })
    }

    fn usage_of(entry: &SessionEntry) -> Usage {
        serde_json::from_value(entry.fields["message"]["usage"].clone()).unwrap()
    }

    /// The origin walk over a real child-file shape: the spawn kickoff row
    /// is the task prompt, an agent-message custom row relabels the origin,
    /// a later user row is a direct user prompt, and an aborted
    /// completion folds nowhere. The captured numbers verify the
    /// `spawn_task` batch: 50,208 input + 2,929 output, $0.0089957.
    #[test]
    fn origin_walk_and_cursor_over_a_child_file() {
        let entries = vec![
            spawn_kickoff_row("c0", "ship the lane"),
            assistant_row(
                "a1",
                &captured_usage(50_208, 2_929, 53_137, 0.008_995_7),
                "toolUse",
            ),
            custom_message_row(
                "c1",
                "agent_message",
                &json!({"id": "agentmsg_1", "message": "follow up"}),
            ),
            assistant_row("a2", &captured_usage(1_000, 100, 1_100, 0.001), "stop"),
            user_row("u2"),
            assistant_row("a3", &captured_usage(200, 50, 250, 0.0005), "stop"),
            assistant_row("a4", &captured_usage(999, 9, 1_008, 9.9), "aborted"),
        ];
        let (batches, cursor) = child_usage_batches(&entries, 0);
        assert_eq!(cursor, entries.len());
        assert_eq!(
            batches
                .iter()
                .map(|(origin, _)| *origin)
                .collect::<Vec<_>>(),
            [
                ChildUsageOrigin::SpawnTask,
                ChildUsageOrigin::AgentMessage,
                ChildUsageOrigin::DirectUser
            ]
        );
        let (origin, usage) = &batches[0];
        assert_eq!(*origin, ChildUsageOrigin::SpawnTask);
        assert_eq!(usage.input, 50_208);
        assert_eq!(usage.output, 2_929);
        assert!((usage.cost.total.as_f64() - 0.008_995_7).abs() < 1e-9);
        let (_, agent_usage) = &batches[1];
        assert_eq!(agent_usage.input, 1_000);
        assert!(batches.iter().all(|(_, usage)| usage.input != 999));

        let (again, cursor_again) = child_usage_batches(&entries, cursor);
        assert!(again.is_empty());
        assert_eq!(cursor_again, entries.len());

        // A delta window: a second run's rows only.
        let mut grown = entries.clone();
        grown.push(custom_message_row(
            "c2",
            "agent_message",
            &json!({"id": "agentmsg_2", "message": "more"}),
        ));
        grown.push(assistant_row("a5", &captured_usage(5, 1, 6, 0.0), "stop"));
        let (delta, next) = child_usage_batches(&grown, entries.len());
        assert_eq!(next, grown.len());
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].0, ChildUsageOrigin::AgentMessage);
        assert_eq!(delta[0].1.input, 5);
        assert_eq!(delta[0].1.output, 1);
    }

    /// The usage fold itself: rows accumulate per origin across the walk
    /// (two `spawn_task` completions sum their fields).
    #[test]
    fn batches_sum_across_completions_of_one_origin() {
        let entries = vec![
            spawn_kickoff_row("c0", "ship the lane"),
            assistant_row("a1", &captured_usage(10, 5, 0, 0.01), "toolUse"),
            assistant_row("a2", &captured_usage(20, 8, 0, 0.02), "stop"),
        ];
        let (batches, cursor) = child_usage_batches(&entries, 0);
        assert_eq!(cursor, 3);
        let [(origin, usage)] = batches[..] else {
            panic!("one batch: {batches:?}");
        };
        assert_eq!(origin, ChildUsageOrigin::SpawnTask);
        assert_eq!(usage.input, 30);
        assert_eq!(usage.output, 13);
        assert!((usage.cost.total.as_f64() - 0.03).abs() < 1e-9);
        let _ = usage_of(&entries[1]);
    }
}
