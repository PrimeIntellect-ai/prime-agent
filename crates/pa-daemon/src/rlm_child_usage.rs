//! The child-side half of RLM usage attribution: splitting one child's
//! session rows into per-origin batches (the engine-side producer owns the rest).
//!
//! Origin labels: the task prompt is the spawn kickoff row (`spawn_task`);
//! user rows are `direct_user`; `error`/`aborted` fold nowhere. Billed
//! non-message rows (compactions, side calls) take the origin of the turn they
//! follow.

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

/// A grandchild's attribution row whose target an earlier window already billed: that read
/// carried only the attributions present then, so this row's own `childUsage` is still unbilled
/// (returned with the target's index, whose turn labels the origin). An attribution into a
/// target inside the window bills nothing itself: the open's fold already put every
/// attribution in the file into the target's usage.
fn late_attribution(
    entries: &[SessionEntry],
    from: usize,
    entry: &SessionEntry,
) -> Option<(Usage, usize)> {
    if entry.type_ != "child_usage_attributed" {
        return None;
    }
    let target_id = entry.fields.get("targetId")?.as_str()?;
    let target = entries
        .iter()
        .take(from)
        .rposition(|row| row.id == target_id)?;
    // A late row must use the same target eligibility as an in-window folded completion.
    assistant_usage(&entries[target])?;
    let usage = serde_json::from_value(entry.fields.get("childUsage")?.clone()).ok()?;
    Some((usage, target))
}

/// The per-origin usage delta of rows `[from..]`, in first-seen origin order, plus the next cursor:
/// every parsed row is consumed, attributed or not, so the walk never rescans.
pub(crate) fn child_usage_batches(
    entries: &[SessionEntry],
    from: usize,
) -> (Vec<(ChildUsageOrigin, Usage)>, usize) {
    let mut batches: Vec<(ChildUsageOrigin, Usage)> = Vec::new();
    for (index, entry) in entries.iter().enumerate().skip(from) {
        // Keep a late attribution's original target origin; compactions,
        // branch summaries, and side calls bill at their own row's origin.
        let billed = late_attribution(entries, from, entry).or_else(|| {
            assistant_usage(entry)
                .or_else(|| crate::session_usage::billed_store_row(entry).map(|row| row.usage))
                .map(|usage| (usage, index))
        });
        let Some((usage, origin_row)) = billed else {
            continue;
        };
        let origin = child_usage_origin(entries, origin_row);
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
    /// (two `spawn_task` completions, the child's compaction, and its
    /// refinement call sum their fields).
    #[test]
    fn batches_sum_across_completions_of_one_origin() {
        let entries = vec![
            spawn_kickoff_row("c0", "ship the lane"),
            assistant_row("a1", &captured_usage(10, 5, 0, 0.01), "toolUse"),
            assistant_row("a2", &captured_usage(20, 8, 0, 0.02), "stop"),
            row(
                "compaction",
                "k1",
                json!({"summary": "so far", "usage": captured_usage(40, 4, 44, 0.04)}),
            ),
            row(
                "custom",
                "r1",
                json!({"customType": "model_usage", "data": {
                    "source": "refine", "provider": "p", "modelId": "m",
                    "usage": captured_usage(7, 1, 8, 0.005),
                }}),
            ),
        ];
        let (batches, cursor) = child_usage_batches(&entries, 0);
        assert_eq!(cursor, 5);
        let [(origin, usage)] = batches[..] else {
            panic!("one batch: {batches:?}");
        };
        assert_eq!(origin, ChildUsageOrigin::SpawnTask);
        assert_eq!(usage.input, 77);
        assert_eq!(usage.output, 18);
        assert!((usage.cost.total.as_f64() - 0.075).abs() < 1e-9);
        let _ = usage_of(&entries[1]);
    }

    /// A grandchild's spend that lands after the parent read its target row still reaches the
    /// parent: the late attribution bills its `childUsage` under the target turn's origin, while
    /// an attribution into a target in the same window rides the folded target only once.
    #[test]
    fn late_grandchild_attributions_bill_once() {
        let attribution = |id: &str, target: &str, child: Value, aggregate: Value| {
            row(
                "child_usage_attributed",
                id,
                json!({"targetId": target, "origin": "spawn_task",
                       "childUsage": child, "aggregateUsage": aggregate}),
            )
        };
        let mut entries = vec![
            spawn_kickoff_row("c0", "ship the lane"),
            assistant_row("a1", &captured_usage(100, 10, 110, 0.0), "toolUse"),
        ];
        let (first, cursor) = child_usage_batches(&entries, 0);
        assert_eq!(first[0].1.input, 100);

        entries.push(attribution(
            "g1",
            "a1",
            captured_usage(30, 3, 33, 0.0),
            captured_usage(130, 13, 110, 0.0),
        ));
        entries.push(user_row("u1"));
        entries.push(assistant_row(
            "a2",
            &captured_usage(5, 1, 6, 0.0),
            "toolUse",
        ));
        entries.push(attribution(
            "g2",
            "a2",
            captured_usage(7, 2, 9, 0.0),
            captured_usage(12, 3, 6, 0.0),
        ));
        // The reopen's fold: each target carries its latest aggregate.
        entries[1].fields["message"]["usage"] = captured_usage(130, 13, 110, 0.0);
        entries[4].fields["message"]["usage"] = captured_usage(12, 3, 6, 0.0);
        let (second, next) = child_usage_batches(&entries, cursor);
        assert_eq!(next, entries.len());
        let [(spawn_origin, late), (user_origin, folded)] = second[..] else {
            panic!("two batches: {second:?}");
        };
        assert_eq!(spawn_origin, ChildUsageOrigin::SpawnTask);
        assert_eq!((late.input, late.output), (30, 3));
        assert_eq!(user_origin, ChildUsageOrigin::DirectUser);
        assert_eq!((folded.input, folded.output), (12, 3));
    }

    #[test]
    fn late_attributions_preserve_target_exclusions() {
        for stop_reason in ["error", "aborted"] {
            let entries = vec![
                spawn_kickoff_row("c0", "ship the lane"),
                assistant_row("a1", &captured_usage(130, 13, 110, 0.03), stop_reason),
                row(
                    "child_usage_attributed",
                    "g1",
                    json!({"targetId": "a1", "origin": "spawn_task",
                           "childUsage": captured_usage(30, 3, 33, 0.01),
                           "aggregateUsage": captured_usage(130, 13, 110, 0.03)}),
                ),
            ];
            // The existing exclusion must not depend on whether the target was read earlier.
            for from in [0, 2] {
                assert_eq!(
                    child_usage_batches(&entries, from),
                    (Vec::new(), entries.len()),
                    "{stop_reason} target, cursor {from}"
                );
            }
        }
    }
}
