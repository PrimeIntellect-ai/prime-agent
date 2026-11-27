//! The factory's numeric bounds. The machine-directory loader and the
//! JSON spec check ([`crate::check_spec`]) both read these, so every
//! machine has one set of limits.

use serde_json::Value;

pub const MAX_STATES: usize = 1024;
pub const MAX_RETRIES: i64 = 10;
pub const MAX_PARALLEL: i64 = 64;
pub const FOREACH_MAX: i64 = 256;
pub const MAX_TRANSITIONS: i64 = 10_000;
pub const MAX_CHILDREN: i64 = 1_000_000;
pub const MAX_ENTRIES: i64 = 1_000_000;

/// The bound errors of a JSON factory spec (machine form, or dag sugar).
/// Only declared values are checked; the executor fills defaults later.
/// `retries` is bounded by the structural check, in its field order.
pub(crate) fn check_spec_limits(spec: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    let in_range = |value: Option<&Value>, low: i64, high: i64| {
        value
            .and_then(Value::as_i64)
            .is_some_and(|value| (low..=high).contains(&value))
    };
    if let Some(run) = spec.get("run").and_then(Value::as_object) {
        if run.contains_key("max_parallel") && !in_range(run.get("max_parallel"), 1, MAX_PARALLEL) {
            errors.push(format!(
                "run max_parallel must be an integer between 1 and {MAX_PARALLEL}"
            ));
        }
        if run.contains_key("max_transitions")
            && !in_range(run.get("max_transitions"), 1, MAX_TRANSITIONS)
        {
            errors.push(format!(
                "run max_transitions must be a positive integer no greater than {MAX_TRANSITIONS}"
            ));
        }
        if run.contains_key("max_children") && !in_range(run.get("max_children"), 1, MAX_CHILDREN) {
            errors.push(format!(
                "run max_children must be a positive integer no greater than {MAX_CHILDREN}"
            ));
        }
    }
    let (noun, states) = match (spec.get("states"), spec.get("nodes")) {
        (Some(Value::Array(states)), _) => ("state", states),
        (_, Some(Value::Array(nodes))) => ("node", nodes),
        _ => return errors,
    };
    if states.len() > MAX_STATES {
        errors.push(format!(
            "a machine has at most {MAX_STATES} {noun}s, got {}",
            states.len()
        ));
    }
    for state in states {
        let id = state.get("id").and_then(Value::as_str).unwrap_or("?");
        if state.get("max_entries").is_some() && !in_range(state.get("max_entries"), 1, MAX_ENTRIES)
        {
            errors.push(format!(
                "{noun} {id} max_entries must be an integer between 1 and {MAX_ENTRIES}"
            ));
        }
        if let Some(foreach) = state.get("foreach").and_then(Value::as_object) {
            if !in_range(foreach.get("max"), 1, FOREACH_MAX) {
                errors.push(format!(
                    "{noun} {id} foreach.max must be an integer between 1 and {FOREACH_MAX}"
                ));
            }
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn declared_values_outside_the_bounds_are_refused() {
        let spec = json!({
            "run": {"max_parallel": 65, "max_transitions": 0, "max_children": "many"},
            "states": [
                {"id": "a", "retries": 11, "max_entries": 0},
                {"id": "b", "foreach": {"over": "xs", "max": 257}},
                {"id": "c", "foreach": {"over": "xs"}},
            ],
        });
        assert_eq!(
            check_spec_limits(&spec),
            [
                "run max_parallel must be an integer between 1 and 64",
                "run max_transitions must be a positive integer no greater than 10000",
                "run max_children must be a positive integer no greater than 1000000",
                "state a max_entries must be an integer between 1 and 1000000",
                "state b foreach.max must be an integer between 1 and 256",
                "state c foreach.max must be an integer between 1 and 256",
            ]
        );
    }

    #[test]
    fn dag_nodes_and_the_bounds_themselves_pass() {
        let spec = json!({
            "run": {"max_parallel": 64, "max_transitions": 10_000, "max_children": 1_000_000},
            "nodes": [{"id": "a", "retries": 10, "foreach": {"over": "xs", "max": 256}}],
        });
        assert!(check_spec_limits(&spec).is_empty());
    }
}
