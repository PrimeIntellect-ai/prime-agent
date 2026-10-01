//! The usage math (moved with its concern): the model registry resolution
//! the create path shares, the TS `Usage` wire shape (`empty_usage`), the
//! add/subtract folds, and the own/total + by-model attribution computations;
//! the unit battery rides inline.
use super::{json, ModelRegistry, Value};

/// The worker's model registry (auth storage + `models.json`, with the
/// on-disk private-authorization cache adopted so create-time resolution
/// sees the same availability the create path does).
pub(crate) fn worker_model_registry(agent_dir: &std::path::Path) -> ModelRegistry {
    let auth = pa_core::auth::AuthStorage::create(agent_dir);
    let mut registry = ModelRegistry::create(auth, agent_dir.join("models.json"));
    registry.load_private_authorization_from_cache();
    registry
}

/// The TS `Usage` wire shape (the TS `emptyUsage`).
pub(crate) fn empty_usage() -> Value {
    json!({
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "total": 0,
        },
    })
}

/// TS `addAssistantUsage`: fold one usage block into a running total.
fn add_usage(total: &mut Value, usage: &Value) {
    let add_field = |total: &mut Value, field: &str, usage: &Value| {
        let current = total.get(field).and_then(Value::as_u64).unwrap_or(0);
        let add = usage.get(field).and_then(Value::as_u64).unwrap_or(0);
        total[field] = json!(current + add);
    };
    for field in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] {
        add_field(total, field, usage);
    }
    for field in ["input", "output", "cacheRead", "cacheWrite", "total"] {
        let cost = total
            .get_mut("cost")
            .and_then(Value::as_object_mut)
            .expect("usage totals always carry the cost block");
        // The running total is a float after the first add (TS costs are
        // floats); reading it as u64 dropped everything already banked.
        let current = cost.get(field).and_then(Value::as_f64).unwrap_or(0.0);
        let add = usage
            .get("cost")
            .and_then(|cost| cost.get(field))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        cost.insert(field.to_string(), json!(current + add));
    }
}

/// TS `subtractAssistantUsage`: remove one usage block, clamping at zero.
fn subtract_usage(total: &mut Value, usage: &Value) {
    let sub_field = |total: &mut Value, field: &str, usage: &Value| {
        let current = total.get(field).and_then(Value::as_u64).unwrap_or(0);
        let sub = usage.get(field).and_then(Value::as_u64).unwrap_or(0);
        total[field] = json!(current.saturating_sub(sub));
    };
    for field in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] {
        sub_field(total, field, usage);
    }
    for field in ["input", "output", "cacheRead", "cacheWrite", "total"] {
        let cost = total
            .get_mut("cost")
            .and_then(Value::as_object_mut)
            .expect("usage totals always carry the cost block");
        let current = cost.get(field).and_then(Value::as_f64).unwrap_or(0.0);
        let sub = usage
            .get("cost")
            .and_then(|cost| cost.get(field))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        cost.insert(field.to_string(), json!((current - sub).max(0.0)));
    }
}

/// TS `computeOwnAndTotalUsage`: the branch's cumulative assistant usage
/// (`totalUsage`, attributions included) minus the child usage
/// attributions targeting those assistants (`ownUsage`). Totals stay
/// cumulative across compactions: compaction shrinks the model-facing
/// context, not what the session spent.
pub(crate) fn compute_own_and_total_usage(
    branch: &[&crate::session_store::SessionEntry],
    all_entries: &[crate::session_store::SessionEntry],
) -> (Value, Value) {
    let mut total = empty_usage();
    let mut branch_assistant_ids = std::collections::HashSet::new();
    for entry in branch {
        if entry.type_ == "message" {
            let Some(message) = entry.fields.get("message") else {
                continue;
            };
            if message.get("role").and_then(Value::as_str) == Some("assistant") {
                branch_assistant_ids.insert(entry.id.clone());
                if let Some(usage) = message.get("usage") {
                    add_usage(&mut total, usage);
                }
            }
        } else if matches!(entry.type_.as_str(), "compaction" | "branch_summary") {
            if let Some(usage) = entry.fields.get("usage") {
                add_usage(&mut total, usage);
            }
        }
    }
    let mut own = total.clone();
    for entry in all_entries {
        if entry.type_ != "child_usage_attributed" {
            continue;
        }
        let Some(target_id) = entry.fields.get("targetId").and_then(Value::as_str) else {
            continue;
        };
        if branch_assistant_ids.contains(target_id) {
            if let Some(child_usage) = entry.fields.get("childUsage") {
                subtract_usage(&mut own, child_usage);
            }
        }
    }
    (own, total)
}

/// The branch's own usage broken down by serving model (the operator's
/// cost question: a session that switches models mid-conversation — or
/// hosts subagents on other models — shows which model billed what).
///
/// Each assistant row folds into the bucket of the model on its message
/// envelope (the request-time serving model — cost blocks were computed
/// against that model's rates, so each bucket holds only spend billed at
/// those rates); `compaction` / `branch_summary` rows fold on the model
/// their entry records when the summary call named one (TS #2411 routes
/// branch summaries to a configured auxiliary model — the timeline names
/// the session's current model, not the routed one that billed) and
/// otherwise follow the branch's `model_change` timeline, seeded on a
/// windowed load with the retained-window boundary's model (the newest
/// `model_change` in the discarded prefix — the leaf's model would bill
/// the boundary's early summarizer rows on the wrong side of a post-
/// boundary switch).
/// Child-usage attributions subtract from the target row's model bucket
/// exactly like [`compute_own_and_total_usage`] subtracts from
/// `ownUsage`, so the buckets sum to the node's own usage — and the sum
/// is verified against the caller's `own_usage` before the breakdown is
/// served. `None` when any usage-carrying row resolves to no model (a
/// foreign file without `model_change` rows or model-tagged assistants),
/// or when the buckets cannot reconcile: an attribution larger than its
/// target row's bucket clamps inside that bucket while the plain fold
/// subtracts the same amount from the combined pool, so the buckets
/// would overstate the node. A partial breakdown would not add up to the
/// displayed totals, so the caller omits the field and the display
/// degrades to the plain TS totals.
pub(crate) fn compute_own_usage_by_model(
    branch: &[&crate::session_store::SessionEntry],
    all_entries: &[crate::session_store::SessionEntry],
    own_usage: &Value,
    initial_model: Option<&(String, String)>,
) -> Option<Vec<Value>> {
    // The buckets in first-seen order: JSON arrays keep the fold order,
    // so the display renders the model the session started on first.
    let mut order: Vec<(String, String)> = Vec::new();
    let mut position: std::collections::HashMap<(String, String), usize> =
        std::collections::HashMap::new();
    let mut buckets: Vec<Value> = Vec::new();
    // The branch's model timeline seeded with the retained-window
    // boundary's model when the load kept only a window (a reopened
    // compacted session's retained branch starts at the boundary — its
    // early rows billed on the boundary's model, not the leaf's, and a
    // full history keeps `None` so a foreign file still omits the
    // breakdown) and the assistant id -> bucket map the attribution
    // subtraction reads.
    let mut current: Option<(String, String)> = initial_model.cloned();
    let mut assistant_buckets: std::collections::HashMap<&str, usize> =
        std::collections::HashMap::new();
    let mut unresolved = false;
    let mut bucket_for =
        |key: Option<(String, String)>, buckets: &mut Vec<Value>| -> Option<usize> {
            let key = key?;
            let at = *position.entry(key.clone()).or_insert_with(|| {
                order.push(key);
                buckets.push(empty_usage());
                buckets.len() - 1
            });
            Some(at)
        };
    for entry in branch {
        let usage = match entry.type_.as_str() {
            "model_change" => {
                let provider = entry
                    .fields
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let model_id = entry
                    .fields
                    .get("modelId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                current = (!provider.is_empty() && !model_id.is_empty())
                    .then(|| (provider.to_string(), model_id.to_string()));
                continue;
            }
            "message" => {
                let Some(message) = entry.fields.get("message") else {
                    continue;
                };
                if message.get("role").and_then(Value::as_str) != Some("assistant") {
                    continue;
                }
                let usage = message.get("usage");
                if usage.is_none() {
                    // An assistant row without usage bills nothing; the
                    // own-usage fold skips it the same way (an attribution
                    // targeting it subtracts from a zero base).
                    continue;
                }
                // The serving model on the envelope outranks the timeline
                // (the row is the request's own record).
                let provider = message
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let model_id = message
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let key = (!provider.is_empty() && !model_id.is_empty())
                    .then(|| (provider.to_string(), model_id.to_string()))
                    .or(current.clone());
                match bucket_for(key, &mut buckets) {
                    Some(at) => {
                        add_usage(&mut buckets[at], usage.expect("checked"));
                        assistant_buckets.insert(entry.id.as_str(), at);
                    }
                    None => unresolved = true,
                }
                continue;
            }
            "compaction" | "branch_summary" => entry.fields.get("usage"),
            _ => continue,
        };
        if let Some(usage) = usage {
            // A row that records the model its summary call served on
            // (TS #2411's auxiliary routing — persisted on the entry)
            // outranks the timeline: the branch timeline names the
            // session's current model, not the routed one that billed.
            let row_model = (|| {
                let provider = entry.fields.get("provider")?.as_str()?;
                let model_id = entry.fields.get("modelId")?.as_str()?;
                (!provider.is_empty() && !model_id.is_empty())
                    .then(|| (provider.to_string(), model_id.to_string()))
            })();
            match bucket_for(row_model.or_else(|| current.clone()), &mut buckets) {
                Some(at) => add_usage(&mut buckets[at], usage),
                None => unresolved = true,
            }
        }
    }
    if unresolved {
        return None;
    }
    for entry in all_entries {
        if entry.type_ != "child_usage_attributed" {
            continue;
        }
        let Some(target_id) = entry.fields.get("targetId").and_then(Value::as_str) else {
            continue;
        };
        let (Some(at), Some(child_usage)) = (
            assistant_buckets.get(target_id).copied(),
            entry.fields.get("childUsage"),
        ) else {
            continue;
        };
        subtract_usage(&mut buckets[at], child_usage);
    }
    // Reconciliation: the buckets must sum to the node's own usage. The
    // per-bucket attribution subtraction clamps inside the target row's
    // bucket while the plain fold subtracts from the combined pool, so
    // an attribution larger than its target row's spend (or one whose
    // target row carries no usage) leaves the buckets overstating the
    // node. Omit the breakdown then — the unresolved-model contract: a
    // breakdown that cannot add up is worse than none. Token fields
    // compare exactly; the cost fields allow the last-ulp drift of two
    // differently ordered float sums.
    let mut summed = empty_usage();
    for bucket in &buckets {
        add_usage(&mut summed, bucket);
    }
    for field in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] {
        if summed[field] != own_usage[field] {
            return None;
        }
    }
    for field in ["input", "output", "cacheRead", "cacheWrite", "total"] {
        let summed_cost = summed["cost"][field].as_f64().unwrap_or_default();
        let own_cost = own_usage["cost"][field].as_f64().unwrap_or_default();
        if (summed_cost - own_cost).abs() > 1e-9 * (1.0 + summed_cost.max(own_cost)) {
            return None;
        }
    }
    Some(
        order
            .into_iter()
            .zip(buckets)
            .map(|((provider, model_id), own_usage)| {
                json!({ "provider": provider, "id": model_id, "ownUsage": own_usage })
            })
            .collect(),
    )
}

#[cfg(test)]
mod usage_tests {
    use super::*;

    /// The own/total split (TS `computeOwnAndTotalUsage`): attributions
    /// subtract from own usage only, matched by target across every entry.
    #[test]
    fn own_usage_subtracts_child_attributions() {
        let assistant = json!({
            "type": "message", "id": "m1",
            "message": {
                "role": "assistant", "content": "text",
                "usage": {
                    "input": 100, "output": 10, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 110,
                    "cost": { "input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0, "total": 3 },
                },
            },
        });
        let attribution = json!({
            "type": "child_usage_attributed", "id": "a1",
            "targetId": "m1",
            "childUsage": {
                "input": 40, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                "totalTokens": 45,
                "cost": { "input": 0.5, "output": 1, "cacheRead": 0, "cacheWrite": 0, "total": 1.5 },
            },
        });
        let entry = |value: &Value, id: &str| crate::session_store::SessionEntry {
            type_: value["type"].as_str().expect("type").to_string(),
            id: id.to_string(),
            parent_id: None,
            timestamp: "2024-01-01T00:00:00.000Z".to_string(),
            fields: value
                .as_object()
                .expect("object")
                .clone()
                .into_iter()
                .collect(),
        };
        let assistant_entry = entry(&assistant, "m1");
        let attribution_entry = entry(&attribution, "a1");
        let entries = vec![
            assistant_entry.clone(),
            attribution_entry.clone(),
            attribution_entry.clone(),
        ];
        let branch_refs: Vec<&crate::session_store::SessionEntry> = entries.iter().collect();
        let (own, total) = compute_own_and_total_usage(&branch_refs, &entries);
        assert_eq!(total["input"], json!(100));
        assert_eq!(total["totalTokens"], json!(110));
        assert_eq!(own["input"], json!(20), "two attributions subtract twice");
        // Subtraction clamps at zero instead of going negative (TS
        // attribution-drift guard).
        let entries_more = vec![
            assistant_entry,
            attribution_entry.clone(),
            attribution_entry.clone(),
            attribution_entry.clone(),
            attribution_entry.clone(),
            attribution_entry,
        ];
        let branch_refs_more: Vec<&crate::session_store::SessionEntry> =
            entries_more.iter().collect();
        let (own, _) = compute_own_and_total_usage(&branch_refs_more, &entries_more);
        assert_eq!(own["input"], json!(0));
        assert_eq!(own["cost"]["total"].as_f64(), Some(0.0));
    }

    /// A `branch_summary` row served by an auxiliary model (TS #2411)
    /// bills on the model its entry records, not the branch timeline's
    /// current model: the routed call billed at the auxiliary model's
    /// rates, so its spend belongs to that model's bucket while the
    /// buckets still reconcile with the plain own-usage fold (the
    /// Macroscope wrong-bucket round).
    #[test]
    fn branch_summary_usage_bills_on_the_row_recorded_auxiliary_model() {
        let entry = |value: &Value, id: &str| crate::session_store::SessionEntry {
            type_: value["type"].as_str().expect("type").to_string(),
            id: id.to_string(),
            parent_id: None,
            timestamp: "2024-01-01T00:00:00.000Z".to_string(),
            fields: value
                .as_object()
                .expect("object")
                .clone()
                .into_iter()
                .collect(),
        };
        let usage = |input: u64, output: u64| {
            json!({
                "input": input, "output": output, "cacheRead": 0, "cacheWrite": 0,
                "totalTokens": input + output,
                "cost": {"input": 0.1, "output": 0.2, "cacheRead": 0, "cacheWrite": 0, "total": 0.3},
            })
        };
        let entries = vec![
            entry(
                &json!({"type": "model_change", "provider": "openai", "modelId": "gpt-a"}),
                "m0",
            ),
            entry(
                &json!({
                    "type": "message",
                    "message": {"role": "assistant", "content": "on it", "provider": "openai", "model": "gpt-a", "usage": usage(100, 10)},
                }),
                "e1",
            ),
            entry(
                &json!({
                    "type": "branch_summary",
                    "summary": "explored",
                    "usage": usage(50, 5),
                    "provider": "anthropic",
                    "modelId": "aux-opus-4",
                }),
                "b1",
            ),
        ];
        let branch: Vec<&crate::session_store::SessionEntry> = entries.iter().collect();
        let (own, _) = compute_own_and_total_usage(&branch, &entries);
        let breakdown =
            compute_own_usage_by_model(&branch, &entries, &own, None).expect("resolved");
        assert_eq!(breakdown.len(), 2);
        assert_eq!(breakdown[0]["provider"], json!("openai"));
        assert_eq!(breakdown[0]["id"], json!("gpt-a"));
        assert_eq!(breakdown[0]["ownUsage"]["totalTokens"], json!(110));
        // The auxiliary summary lands on the routed model's bucket, not
        // the timeline's current model.
        assert_eq!(breakdown[1]["provider"], json!("anthropic"));
        assert_eq!(breakdown[1]["id"], json!("aux-opus-4"));
        assert_eq!(breakdown[1]["ownUsage"]["totalTokens"], json!(55));
    }

    /// A windowed load (a reopened compacted session) seeds the timeline
    /// with the retained-window boundary's model: retained usage rows
    /// before the branch's first `model_change` still resolve a bucket and
    /// the breakdown is served instead of omitted — the target case this
    /// change exists for (the Bugbot windowed-omission round). The same
    /// walk without a seed (a full-history foreign file without
    /// `model_change` rows) keeps omitting the breakdown.
    #[test]
    fn window_seed_resolves_rows_before_the_first_model_change() {
        let entry = |value: &Value, id: &str| crate::session_store::SessionEntry {
            type_: value["type"].as_str().expect("type").to_string(),
            id: id.to_string(),
            parent_id: None,
            timestamp: "2024-01-01T00:00:00.000Z".to_string(),
            fields: value
                .as_object()
                .expect("object")
                .clone()
                .into_iter()
                .collect(),
        };
        let usage = |input: u64, output: u64| {
            json!({
                "input": input, "output": output, "cacheRead": 0, "cacheWrite": 0,
                "totalTokens": input + output,
                "cost": {"input": 0.1, "output": 0.2, "cacheRead": 0, "cacheWrite": 0, "total": 0.3},
            })
        };
        // The retained branch starts at the compaction boundary: the
        // summarizer's usage row carries no model of its own (an
        // unattributed row) and no `model_change` row precedes it on the walk.
        let entries = vec![
            entry(
                &json!({"type": "branch_summary", "summary": "cut", "usage": usage(30, 3)}),
                "b1",
            ),
            entry(
                &json!({
                    "type": "message",
                    "message": {"role": "assistant", "content": "resumed", "provider": "openai", "model": "gpt-a", "usage": usage(100, 10)},
                }),
                "e1",
            ),
        ];
        let branch: Vec<&crate::session_store::SessionEntry> = entries.iter().collect();
        let (own, _) = compute_own_and_total_usage(&branch, &entries);
        let seeded = compute_own_usage_by_model(
            &branch,
            &entries,
            &own,
            Some(&("openai".to_string(), "gpt-a".to_string())),
        )
        .expect("the seed resolves the boundary rows");
        assert_eq!(seeded.len(), 1);
        assert_eq!(seeded[0]["provider"], json!("openai"));
        assert_eq!(seeded[0]["id"], json!("gpt-a"));
        assert_eq!(seeded[0]["ownUsage"]["totalTokens"], json!(143));
        // The unseeded walk keeps the foreign-file contract: a branch
        // whose usage rows resolve to no model omits the breakdown.
        assert_eq!(
            compute_own_usage_by_model(&branch, &entries, &own, None),
            None
        );
    }
}
