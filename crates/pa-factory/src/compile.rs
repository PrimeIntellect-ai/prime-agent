//! Compile a loaded machine to the canonical spec the executor runs.
//!
//! The canonical spec is the JSON machine form `rlm.factory` validates and
//! runs today (`{"run", "params", "states", "transitions"}`). Compiling
//! binds the params, assembles each agent prompt (shared context, the
//! state's prompt, its rubric, and a generated Outputs section), and turns
//! `next`, `route`, and `join` into transitions.

use std::fmt::Write as _;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::load::{routed_slot, MACHINE_FILE};
use crate::machine::{Agent, Diagnostic, Machine, Output, State, Work};
use crate::types::{self, check_value, record_names, Type};

/// Compile `machine` with the params given at start.
///
/// Each given param is type-checked; an absent one takes its default, and
/// one with no default is an error.
///
/// # Errors
/// Returns every param problem, or a python file whose absolute path
/// cannot be resolved.
pub fn compile(machine: &Machine, given: &Map<String, Value>) -> Result<Value, Vec<Diagnostic>> {
    let mut problems = Vec::new();
    let params = bind_params(machine, given, &mut problems);
    let mut states = Vec::new();
    for state in &machine.states {
        match compile_state(machine, state) {
            Ok(compiled) => states.push(compiled),
            Err(problem) => problems.push(problem),
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let mut spec = Map::new();
    spec.insert("run".to_string(), compile_run(machine));
    if !params.is_empty() {
        spec.insert("params".to_string(), Value::Object(params));
    }
    spec.insert("states".to_string(), Value::Array(states));
    spec.insert(
        "transitions".to_string(),
        Value::Array(transitions(machine)),
    );
    Ok(Value::Object(spec))
}

fn bind_params(
    machine: &Machine,
    given: &Map<String, Value>,
    problems: &mut Vec<Diagnostic>,
) -> Map<String, Value> {
    for name in given.keys() {
        if machine.param(name).is_none() {
            let declared: Vec<&str> = machine
                .params
                .iter()
                .map(|param| param.name.as_str())
                .collect();
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                "params",
                format!(
                    "unknown param {name:?} (declared: {})",
                    if declared.is_empty() {
                        "none".to_string()
                    } else {
                        declared.join(", ")
                    }
                ),
            ));
        }
    }
    let mut bound = Map::new();
    for param in &machine.params {
        let value = match (given.get(&param.name), &param.default) {
            (Some(value), _) => {
                if let Err(error) = check_value(
                    &param.ty,
                    value,
                    &machine.records,
                    &format!("params.{}", param.name),
                ) {
                    problems.push(Diagnostic::new(MACHINE_FILE, "", error));
                }
                value.clone()
            }
            (None, Some(default)) => default.clone(),
            (None, None) => {
                problems.push(Diagnostic::new(
                    MACHINE_FILE,
                    format!("params.{}", param.name),
                    format!(
                        "required: pass it when the live machine starts ({}={})",
                        param.name,
                        types::describe(&param.ty)
                    ),
                ));
                continue;
            }
        };
        bound.insert(param.name.clone(), value);
    }
    bound
}

fn compile_run(machine: &Machine) -> Value {
    let run = &machine.run;
    let mut out = Map::new();
    let fields = [
        ("budget_ms", run.budget_ms),
        ("max_parallel", run.max_parallel),
        ("max_children", run.max_children),
        ("max_transitions", run.max_transitions),
    ];
    for (key, value) in fields {
        if let Some(value) = value {
            out.insert(key.to_string(), json!(value));
        }
    }
    if let Some(policy) = run.failure_policy {
        out.insert("failure_policy".to_string(), json!(policy.as_str()));
    }
    Value::Object(out)
}

/// The executor's port kind: `text` binds the whole answer, everything
/// else is a JSON value.
fn port_kind(ty: &Type) -> &'static str {
    match ty {
        Type::Text => "text",
        Type::Int
        | Type::Float
        | Type::Bool
        | Type::File
        | Type::Json
        | Type::Enum(_)
        | Type::List(_)
        | Type::Record(_) => "json",
    }
}

fn compile_state(machine: &Machine, state: &State) -> Result<Value, Diagnostic> {
    let mut out = Map::new();
    out.insert("id".to_string(), json!(state.id));
    if state.entry {
        out.insert("entry".to_string(), json!(true));
    }
    match &state.work {
        Work::Agent(agent) => {
            let mut subagent = Map::new();
            subagent.insert(
                "prompt".to_string(),
                json!(assemble_prompt(machine, state, agent)),
            );
            for (key, value) in [
                ("name", &agent.label),
                ("model", &agent.model),
                ("thinking", &agent.thinking),
            ] {
                if let Some(value) = value {
                    subagent.insert(key.to_string(), json!(value));
                }
            }
            out.insert("subagent".to_string(), Value::Object(subagent));
        }
        Work::Python(call) => {
            let file = std::path::absolute(machine.dir.join(&call.file)).map_err(|error| {
                Diagnostic::new(
                    MACHINE_FILE,
                    format!("states.{}.run", state.id),
                    format!("cannot resolve {}: {error}", call.file),
                )
            })?;
            let module = file
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default();
            let directory = file.parent().map(Path::to_string_lossy).unwrap_or_default();
            out.insert(
                "python".to_string(),
                json!({"import": module, "callable": call.function, "path": directory}),
            );
        }
    }
    if !state.inputs.is_empty() {
        let inputs: Vec<Value> = state
            .inputs
            .iter()
            .map(|input| {
                let kind = machine
                    .state(&input.state)
                    .and_then(|source| source.output(&input.port))
                    .map_or("json", |output| port_kind(&output.slot.ty));
                let mut binding = json!({"name": input.name, "type": kind, "from": format!("{}.{}", input.state, input.port)});
                if input.optional {
                    binding["optional"] = json!(true);
                }
                binding
            })
            .collect();
        out.insert("inputs".to_string(), Value::Array(inputs));
    }
    if !state.outputs.is_empty() {
        let outputs: Vec<Value> = state
            .outputs
            .iter()
            .map(|output| json!({"name": output.name, "type": port_kind(&output.slot.ty)}))
            .collect();
        out.insert("outputs".to_string(), Value::Array(outputs));
    }
    for (key, value) in [
        ("max_entries", state.max_entries),
        ("retries", state.retries),
        ("budget_ms", state.budget_ms),
    ] {
        if let Some(value) = value {
            out.insert(key.to_string(), json!(value));
        }
    }
    if let Some(policy) = state.failure_policy {
        out.insert("failure_policy".to_string(), json!(policy.as_str()));
    }
    if let Some(foreach) = &state.foreach {
        out.insert(
            "foreach".to_string(),
            json!({"over": foreach.over, "max": foreach.max}),
        );
    }
    if state.resident {
        out.insert("lifecycle".to_string(), json!("resident"));
    }
    Ok(Value::Object(out))
}

/// Context, prompt, rubric, then the generated Outputs section, with each
/// `{{name}}` turned into the executor's `{name}` placeholder.
fn assemble_prompt(machine: &Machine, state: &State, agent: &Agent) -> String {
    let mut prompt = String::new();
    if let Some(context) = &machine.context {
        prompt.push_str(context.trim_end());
        prompt.push_str("\n\n");
    }
    prompt.push_str(agent.prompt.trim_end());
    if let Some(rubric) = &agent.rubric {
        prompt.push_str("\n\n## Rubric\n\nJudge against these rules. Each finding names the rule it falls under and carries that rule's severity unless the evidence argues for another.\n\n");
        for rule in &rubric.rules {
            let _ = writeln!(
                prompt,
                "- `{}` ({}): {}",
                rule.id,
                rule.default,
                rule.check.trim()
            );
        }
        prompt.truncate(prompt.trim_end().len());
    }
    if !state.outputs.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(&outputs_section(machine, &state.outputs));
    }
    to_executor_placeholders(&prompt)
}

/// How a child hands back its outputs on the current executor: the final
/// answer, with one fenced JSON object for every non-text port.
fn outputs_section(machine: &Machine, outputs: &[Output]) -> String {
    let mut section = String::from("## Outputs\n\n");
    let (text, structured): (Vec<&Output>, Vec<&Output>) = outputs
        .iter()
        .partition(|output| output.slot.ty == Type::Text);
    for output in &text {
        let _ = writeln!(
            section,
            "Your whole final answer becomes the `{}` output.",
            output.name
        );
    }
    if !structured.is_empty() {
        if !text.is_empty() {
            section.push('\n');
        }
        section.push_str("End your final answer with one fenced ```json block holding a single object with exactly these keys:\n\n");
        let mut records: Vec<&str> = Vec::new();
        for output in &structured {
            let _ = writeln!(
                section,
                "- `{}`: {}",
                output.name,
                types::describe(&output.slot.ty)
            );
            collect_records(machine, &output.slot.ty, &mut records);
        }
        for record in records {
            section.push('\n');
            section.push_str(&types::describe_record(record, &machine.records));
        }
    }
    section.truncate(section.trim_end().len());
    section
}

fn collect_records<'a>(machine: &'a Machine, ty: &'a Type, seen: &mut Vec<&'a str>) {
    for name in record_names(ty) {
        if seen.contains(&name) {
            continue;
        }
        seen.push(name);
        for (_, slot) in machine.records.fields(name).unwrap_or_default() {
            collect_records(machine, &slot.ty, seen);
        }
    }
}

fn to_executor_placeholders(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        let inner = &rest[open + 2..];
        match inner.find("}}") {
            Some(close) if crate::load::is_identifier(inner[..close].trim()) => {
                out.push_str(&rest[..open]);
                out.push('{');
                out.push_str(inner[..close].trim());
                out.push('}');
                rest = &inner[close + 2..];
            }
            _ => {
                out.push_str(&rest[..open + 2]);
                rest = inner;
            }
        }
    }
    out.push_str(rest);
    out
}

fn transitions(machine: &Machine) -> Vec<Value> {
    let mut out = Vec::new();
    for state in &machine.states {
        for target in &state.next {
            let joined = machine
                .state(target)
                .is_some_and(|found| found.join.contains(&state.id));
            if !joined {
                out.push(json!({"from": state.id, "to": target}));
            }
        }
        if let Some(route) = &state.route {
            let values: Vec<Value> =
                match routed_slot(state, route, &machine.records).map(|slot| &slot.ty) {
                    Ok(Type::Enum(values)) => values.iter().map(|value| json!(value)).collect(),
                    Ok(Type::Bool) => vec![json!(true), json!(false)],
                    Ok(_) | Err(_) => Vec::new(),
                };
            for value in values {
                let key = value
                    .as_str()
                    .map_or_else(|| value.to_string(), str::to_string);
                if let Some((_, target)) = route.arms.iter().find(|(arm, _)| *arm == key) {
                    let mut when = json!({"output": route.port, "op": "eq", "value": value});
                    if let Some(field) = &route.field {
                        when["path"] = json!(field);
                    }
                    out.push(json!({"from": state.id, "to": target, "when": when}));
                }
            }
        }
        if !state.join.is_empty() {
            out.push(json!({"from": state.join, "to": state.id}));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_become_single_braces() {
        assert_eq!(
            to_executor_placeholders(
                "Do {{ task }} with {{design}}; keep {{ not a name }} and {x}."
            ),
            "Do {task} with {design}; keep {{ not a name }} and {x}."
        );
    }
}
