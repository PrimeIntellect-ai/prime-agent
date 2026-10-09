//! The action space, the observation digest, and prompt compilation. Rust
//! port of `packages/coding-agent/src/core/system-router/action-space.ts`
//! (#2484).

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;

use serde_json::{Map, Value};

use super::types::{
    resolve_gate, RouterActionParamSpec, RouterActionRisk, RouterActionSpec, RouterGateSpec,
    RouterObservation, ESCALATE_ACTION, FINISH_ACTION,
};

/// fnv1a (32-bit, 8 hex chars) digest for repeated-state detection. The
/// material is canonicalized (recursively key-sorted) so identical
/// observations with differently-ordered fields produce the same digest, and
/// hashed over UTF-16 code units to match the TS `charCodeAt` loop.
#[must_use]
pub fn observation_digest(observation: &RouterObservation) -> String {
    let mut material = Map::new();
    material.insert("text".to_string(), Value::String(observation.text.clone()));
    material.insert(
        "fields".to_string(),
        if observation.fields.is_empty() {
            Value::Null
        } else {
            Value::Object(
                observation
                    .fields
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            )
        },
    );
    if let Some(image) = &observation.image {
        material.insert("image".to_string(), Value::String(image.clone()));
    }
    let material = canonical_json(&Value::Object(material));
    let mut hash: u32 = 0x811c_9dc5;
    for unit in material.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

/// Recursive, key-sorted, compact JSON (the TS key-sorting replacer).
fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(items) => {
            let rendered = items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{rendered}]")
        }
        Value::Object(record) => {
            let mut keys: Vec<&String> = record.keys().collect();
            keys.sort();
            let rendered = keys
                .into_iter()
                .map(|key| {
                    let encoded = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
                    let value = record
                        .get(key.as_str())
                        .map_or_else(|| "null".to_string(), canonical_json);
                    format!("{encoded}:{value}")
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{rendered}}}")
        }
    }
}

/// The marker carried by a truncated observation.
const OBSERVATION_TRUNCATION_MARKER: &str = "\n<observation truncated>";

/// Truncate the observation text to `budget` characters, carrying a marker.
#[must_use]
pub fn truncate_observation(text: &str, budget: usize) -> String {
    if text.chars().count() <= budget {
        return text.to_string();
    }
    let keep = budget.saturating_sub(OBSERVATION_TRUNCATION_MARKER.chars().count());
    let mut truncated: String = text.chars().take(keep).collect();
    truncated.push_str(OBSERVATION_TRUNCATION_MARKER);
    truncated
}

/// One compiled action: the declared space plus the loop-owned terminal
/// actions.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledAction {
    pub name: String,
    pub description: String,
    pub risk: RouterActionRisk,
    pub params: BTreeMap<String, RouterActionParamSpec>,
}

/// The compiled action space: names in render order and the lookup by name.
#[derive(Debug, Clone)]
pub struct CompiledActionSpace {
    pub action_names: Vec<String>,
    pub by_name: HashMap<String, CompiledAction>,
}

/// Compile the declared space, appending the loop-owned `finish` and
/// `escalate` actions.
///
/// # Errors
///
/// Returns an error when a declared action reuses a loop-owned name (the
/// outer spec parser already rejects them; this is the loop's own guard).
pub fn compile_action_space(
    actions: &BTreeMap<String, RouterActionSpec>,
) -> anyhow::Result<CompiledActionSpace> {
    for name in actions.keys() {
        if name == FINISH_ACTION || name == ESCALATE_ACTION {
            anyhow::bail!("action name \"{name}\" is reserved for the loop itself");
        }
    }
    let mut by_name = HashMap::with_capacity(actions.len() + 2);
    let mut action_names = Vec::with_capacity(actions.len() + 2);
    for (name, spec) in actions {
        by_name.insert(
            name.clone(),
            CompiledAction {
                name: name.clone(),
                description: spec.description.clone(),
                risk: spec.risk,
                params: spec.params.clone(),
            },
        );
        action_names.push(name.clone());
    }
    for (name, description) in [
        (
            FINISH_ACTION,
            "Declare the goal reached and stop the loop now.",
        ),
        (
            ESCALATE_ACTION,
            "Stop the loop and hand control back to the supervising model for a new plan.",
        ),
    ] {
        by_name.insert(
            name.to_string(),
            CompiledAction {
                name: name.to_string(),
                description: description.to_string(),
                risk: RouterActionRisk::Read,
                params: BTreeMap::new(),
            },
        );
        action_names.push(name.to_string());
    }
    Ok(CompiledActionSpace {
        action_names,
        by_name,
    })
}

/// The confidence gate for an action. The escalation door is never gated: a
/// System 1 model asking System 2 for help must always be honored.
#[must_use]
pub fn gate_threshold(gate: RouterGateSpec, action: &CompiledAction) -> f64 {
    let resolved = resolve_gate(gate);
    if action.name == ESCALATE_ACTION {
        return 0.0;
    }
    if action.name == FINISH_ACTION {
        return resolved.finish;
    }
    match action.risk {
        RouterActionRisk::Read => resolved.read,
        RouterActionRisk::Write => resolved.write,
        RouterActionRisk::Destructive => resolved.destructive,
    }
}

/// The name of the gate whose threshold [`gate_threshold`] applies, as the
/// refusal diagnostic labels it. `finish` is compiled with the `read` risk but
/// gated by `gate.finish`, so its label must be `finish`; every other action
/// is labeled by its own risk (escalation is never gated, so its label never
/// appears in a refusal).
#[must_use]
pub fn gate_label(action: &CompiledAction) -> &'static str {
    if action.name == FINISH_ACTION {
        return "finish";
    }
    action.risk.as_str()
}

/// Render one action into the decision prompt.
fn render_action(action: &CompiledAction) -> String {
    let mut rendered = String::new();
    let _ = write!(
        rendered,
        "- {} [risk={}]: {}",
        action.name,
        action.risk.as_str(),
        action.description
    );
    for (param_name, param) in &action.params {
        let choices = param
            .choices
            .iter()
            .map(|(value, description)| format!("\"{value}\" ({description})"))
            .collect::<Vec<_>>()
            .join(", ");
        let _ = write!(rendered, "\n    param \"{param_name}\": one of {choices}");
    }
    rendered
}

/// One line of bounded history, e.g. `press_a(frames="8") -> screen advanced`.
#[must_use]
pub fn format_history_entry(
    action: &str,
    params: &BTreeMap<String, String>,
    result: &str,
) -> String {
    let rendered_params = params
        .iter()
        .map(|(key, value)| format!("{key}=\"{value}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if result.chars().count() > 160 {
        format!("{}...", result.chars().take(157).collect::<String>())
    } else {
        result.to_string()
    };
    format!("{action}({rendered_params}) -> {suffix}")
}

/// The value rendering for one structured observation field (JS `String`).
fn render_field_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Null => "null".to_string(),
        Value::Number(number) => number.to_string(),
        // Declared fields are scalars; a nested value falls back to its
        // compact JSON rather than being dropped.
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

/// The typed question the System 1 model answers: one choice over the
/// declared action space with its finite parameter values, plus the
/// confidence attached to that choice.
#[must_use]
pub fn compile_decision_prompt(
    goal: &str,
    observation: &RouterObservation,
    history: &[String],
    actions: &CompiledActionSpace,
    observation_chars: usize,
) -> String {
    let field_lines: Vec<String> = observation
        .fields
        .iter()
        .map(|(key, value)| format!("{key}: {}", render_field_value(value)))
        .collect();
    // The budget bounds the whole rendered observation (text plus fields):
    // both halves ride the same prompt the model reads.
    let text = truncate_observation(&observation.text, observation_chars / 2);
    let fields_budget = observation_chars.saturating_sub(text.chars().count());
    let mut kept_fields: Vec<&String> = Vec::new();
    let mut fields_used = 0usize;
    for line in &field_lines {
        let line_len = line.chars().count();
        if fields_used + line_len + 1 > fields_budget.saturating_sub(40) {
            break;
        }
        kept_fields.push(line);
        fields_used += line_len + 1;
    }
    let fields_block = if kept_fields.len() == field_lines.len() {
        kept_fields
            .iter()
            .map(|line| line.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        let shown = kept_fields
            .iter()
            .map(|line| line.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let separator = if shown.is_empty() { "" } else { "\n" };
        format!(
            "{shown}{separator}<{} more fields truncated>",
            field_lines.len() - kept_fields.len()
        )
    };
    let observation_text = [text, fields_block]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let history = if history.is_empty() {
        "<no steps yet>".to_string()
    } else {
        history.join("\n")
    };
    let actions = actions
        .action_names
        .iter()
        .filter_map(|name| actions.by_name.get(name))
        .map(render_action)
        .collect::<Vec<_>>()
        .join("\n");
    let observation_text = if observation_text.is_empty() {
        "<no observation>".to_string()
    } else {
        observation_text
    };
    [
        format!("GOAL\n{goal}"),
        String::new(),
        format!("OBSERVATION\n{observation_text}"),
        String::new(),
        format!("HISTORY (oldest first)\n{history}"),
        String::new(),
        format!("AVAILABLE ACTIONS (choose exactly one)\n{actions}"),
        String::new(),
        "Reply with ONE JSON object and nothing else:\n{\"action\": \"<action name>\", \"params\": {\"<param>\": \"<value>\"}, \"confidence\": <number 0.0-1.0>}\nUse only listed action names and listed parameter values. Omit \"params\" when the action has none. \"confidence\" is your probability that this action is the correct next step.".to_string(),
    ]
    .join("\n")
}

// The unit battery lives in the child module (action_space::tests).
#[cfg(test)]
mod tests;
