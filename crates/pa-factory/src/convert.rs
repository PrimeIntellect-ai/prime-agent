//! Convert a stored v1 spec (machine or dag form) into a machine directory.
//!
//! Inline prompts become `prompts/<state>.md`, transitions become `next`
//! and `join`, and budgets become duration words. A v1 guard has no
//! machine.toml form (a route switches on a typed enum), so a spec with
//! guards is refused with the guard spelled out; so are harness subagent
//! references and Python modules imported from the session's directory,
//! which a shareable directory cannot carry.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde_json::{Map, Value};

use crate::duration::format_duration_ms;
use crate::load::{CONTEXT_FILE, MACHINE_FILE};
use crate::machine::FORMAT_VERSION;

/// The library fields of the machine being converted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineMeta {
    pub name: String,
    pub description: String,
    pub version: u64,
    pub author: Option<String>,
}

/// One file of a converted machine directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirFile {
    /// Relative to the machine directory.
    pub path: String,
    pub content: String,
}

#[derive(Default)]
struct StateOut {
    id: String,
    lines: Vec<String>,
    next: Vec<String>,
    join: Vec<String>,
}

/// Convert a v1 spec into machine directory files.
///
/// # Errors
/// Returns one sentence per part of the spec that has no machine.toml form.
pub fn convert_spec(spec: &Value, meta: &MachineMeta) -> Result<Vec<DirFile>, Vec<String>> {
    let machine = if spec.get("nodes").is_some() {
        dag_to_machine(spec)?
    } else {
        spec.clone()
    };
    let mut problems = Vec::new();
    let mut files = Vec::new();
    let run = machine
        .get("run")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let run_policy = run.get("failure_policy").and_then(Value::as_str);
    if let Some(budget) = run.get("budget_ms").and_then(Value::as_u64) {
        if format_duration_ms(budget).is_none() {
            problems.push(format!(
                "run.budget_ms {budget} is not a whole number of seconds"
            ));
        }
    }
    let states = machine
        .get("states")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut order: Vec<StateOut> = Vec::new();
    for state in &states {
        match convert_state(state, run_policy, &mut files) {
            Ok(converted) => order.push(converted),
            Err(mut errors) => problems.append(&mut errors),
        }
    }
    let transitions = machine
        .get("transitions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    attach_transitions(&transitions, &mut order, &mut problems);
    if !problems.is_empty() {
        return Err(problems);
    }
    files.insert(
        0,
        DirFile {
            path: MACHINE_FILE.to_string(),
            content: machine_toml(meta, &run, &order),
        },
    );
    Ok(files)
}

/// Unguarded transitions become `next`; a join's members each name it in
/// `next` and the target lists them in `join`. Guards are refused.
fn attach_transitions(transitions: &[Value], order: &mut [StateOut], problems: &mut Vec<String>) {
    let index: BTreeMap<String, usize> = order
        .iter()
        .enumerate()
        .map(|(i, state)| (state.id.clone(), i))
        .collect();
    for transition in transitions {
        let to = transition
            .get("to")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Some(when) = transition.get("when") {
            let from = transition
                .get("from")
                .map(Value::to_string)
                .unwrap_or_default();
            problems.push(format!(
                "the guarded transition {from} -> {to} (when {when}) has no machine.toml form: switch on an enum output with route, or compute the choice in a python state"
            ));
            continue;
        }
        if transition
            .get("on")
            .and_then(Value::as_str)
            .is_some_and(|on| on != "settled")
        {
            problems.push(format!(
                "the transition to {to} fires on something other than settled"
            ));
            continue;
        }
        match transition.get("from") {
            Some(Value::String(from)) => match index.get(from) {
                Some(&at) => order[at].next.push(to),
                None => problems.push(format!("a transition starts at unknown state {from:?}")),
            },
            Some(Value::Array(members)) => {
                let members: Vec<String> = members
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect();
                for member in &members {
                    if let Some(&at) = index.get(member) {
                        order[at].next.push(to.clone());
                    }
                }
                match index.get(&to) {
                    Some(&at) => order[at].join = members,
                    None => problems.push(format!("a join ends at unknown state {to:?}")),
                }
            }
            _ => problems.push(format!("the transition to {to} has no from")),
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one arm per v1 state key, written in machine.toml order"
)]
fn convert_state(
    state: &Value,
    run_policy: Option<&str>,
    files: &mut Vec<DirFile>,
) -> Result<StateOut, Vec<String>> {
    let id = state
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut problems = Vec::new();
    let mut lines = Vec::new();
    if state.get("entry").and_then(Value::as_bool) == Some(true) {
        lines.push("entry = true".to_string());
    }
    let inputs: Vec<&Value> = state
        .get("inputs")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default();
    let input_names: Vec<&str> = inputs
        .iter()
        .filter_map(|input| input.get("name").and_then(Value::as_str))
        .collect();
    match (state.get("subagent"), state.get("python")) {
        (Some(Value::Object(subagent)), None) => {
            for key in subagent.keys() {
                if !matches!(key.as_str(), "prompt" | "model" | "thinking" | "name") {
                    problems.push(format!(
                        "state {id}: the subagent key {key:?} has no machine.toml form (an agent takes prompt, model, thinking, name)"
                    ));
                }
            }
            let prompt = subagent.get("prompt").and_then(Value::as_str).unwrap_or_default();
            let file = format!("prompts/{id}.md");
            if file == CONTEXT_FILE {
                problems.push(format!("state {id}: rename it; prompts/_context.md is the shared context file"));
            }
            files.push(DirFile { path: file.clone(), content: format!("{}\n", to_machine_placeholders(prompt, &input_names).trim_end()) });
            let mut agent = vec![format!("prompt = {}", quote(&file))];
            for key in ["model", "thinking", "name"] {
                if let Some(value) = subagent.get(key).and_then(Value::as_str) {
                    agent.push(format!("{key} = {}", quote(value)));
                }
            }
            lines.push(format!("agent = {{ {} }}", agent.join(", ")));
        }
        (Some(Value::String(reference)), None) => problems.push(format!(
            "state {id} runs the harness subagent {reference:?}; a machine directory cannot carry a harness reference, so inline its prompt first"
        )),
        (None, Some(python)) => {
            let import = python.get("import").and_then(Value::as_str).unwrap_or_default();
            let callable = python.get("callable").and_then(Value::as_str).unwrap_or_default();
            problems.push(format!(
                "state {id} imports {import}.{callable} from the session's working directory; copy the module to nodes/{import}.py and set run = \"nodes/{import}.py:{callable}\""
            ));
        }
        _ => problems.push(format!("state {id} has neither an inline subagent nor a python call")),
    }
    if !inputs.is_empty() {
        let bindings: Vec<String> = inputs
            .iter()
            .map(|input| {
                let name = input
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let from = input
                    .get("from")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let mark = if input.get("optional").and_then(Value::as_bool) == Some(true) {
                    "?"
                } else {
                    ""
                };
                format!("{name} = {}", quote(&format!("{from}{mark}")))
            })
            .collect();
        lines.push(format!("inputs = {{ {} }}", bindings.join(", ")));
    }
    if let Some(outputs) = state
        .get("outputs")
        .and_then(Value::as_array)
        .filter(|outputs| !outputs.is_empty())
    {
        let ports: Vec<String> = outputs
            .iter()
            .map(|output| {
                let name = output
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let kind = output.get("type").and_then(Value::as_str).unwrap_or("json");
                format!("{name} = {}", quote(kind))
            })
            .collect();
        lines.push(format!("outputs = {{ {} }}", ports.join(", ")));
    }
    if let Some(entries) = state
        .get("max_entries")
        .and_then(Value::as_u64)
        .filter(|entries| *entries != 1)
    {
        lines.push(format!("max_entries = {entries}"));
    }
    if let Some(retries) = state
        .get("retries")
        .and_then(Value::as_u64)
        .filter(|retries| *retries != 0)
    {
        lines.push(format!("retries = {retries}"));
    }
    if let Some(budget) = state.get("budget_ms").and_then(Value::as_u64) {
        match format_duration_ms(budget) {
            Some(words) => lines.push(format!("budget = {}", quote(&words))),
            None => problems.push(format!(
                "state {id}: budget_ms {budget} is not a whole number of seconds"
            )),
        }
    }
    if let Some(policy) = state
        .get("failure_policy")
        .and_then(Value::as_str)
        .filter(|policy| Some(*policy) != run_policy)
    {
        lines.push(format!("failure_policy = {}", quote(policy)));
    }
    if let Some(foreach) = state.get("foreach") {
        let over = foreach
            .get("over")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let max = foreach.get("max").and_then(Value::as_u64).unwrap_or(1);
        lines.push(format!(
            "foreach = {{ over = {}, max = {max} }}",
            quote(over)
        ));
    }
    if state.get("lifecycle").and_then(Value::as_str) == Some("resident") {
        lines.push("resident = true".to_string());
    }
    if problems.is_empty() {
        Ok(StateOut {
            id,
            lines,
            ..StateOut::default()
        })
    } else {
        Err(problems)
    }
}

/// The dag form's machine shape: one state per node, entered once; a node
/// with no dependencies is an entry; a node with several waits on a join.
fn dag_to_machine(spec: &Value) -> Result<Value, Vec<String>> {
    let nodes = spec
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut states = Vec::new();
    let mut transitions = Vec::new();
    for node in nodes {
        let Some(mut state) = node.as_object().cloned() else {
            return Err(vec!["a dag node is not an object".to_string()]);
        };
        let id = state
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut deps: Vec<String> = Vec::new();
        let declared = state
            .remove("depends_on")
            .and_then(|deps| deps.as_array().cloned())
            .unwrap_or_default();
        let sources = state
            .get("inputs")
            .and_then(Value::as_array)
            .map(|inputs| {
                inputs
                    .iter()
                    .filter_map(|input| input.get("from").and_then(Value::as_str))
                    .filter_map(|from| from.split_once('.'))
                    .map(|(node, _)| Value::String(node.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for dep in declared.iter().chain(&sources).filter_map(Value::as_str) {
            if !deps.iter().any(|seen| seen == dep) {
                deps.push(dep.to_string());
            }
        }
        if deps.is_empty() {
            state.insert("entry".to_string(), Value::Bool(true));
        } else if deps.len() == 1 {
            transitions.push(serde_json::json!({"from": deps[0], "to": id}));
        } else {
            transitions.push(serde_json::json!({"from": deps, "to": id}));
        }
        states.push(Value::Object(state));
    }
    let mut machine = Map::new();
    if let Some(run) = spec.get("run") {
        machine.insert("run".to_string(), run.clone());
    }
    machine.insert("states".to_string(), Value::Array(states));
    machine.insert("transitions".to_string(), Value::Array(transitions));
    Ok(Value::Object(machine))
}

/// `{name}` placeholders for declared inputs become `{{name}}`.
fn to_machine_placeholders(prompt: &str, inputs: &[&str]) -> String {
    let mut out = String::with_capacity(prompt.len() + 16);
    let mut rest = prompt;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open..];
        if let Some(inner) = after.strip_prefix("{{") {
            out.push_str("{{");
            rest = inner;
            continue;
        }
        let name = after[1..].find('}').map(|close| &after[1..=close]);
        match name {
            Some(name) if inputs.contains(&name) => {
                out.push_str("{{");
                out.push_str(name);
                out.push_str("}}");
                rest = &after[name.len() + 2..];
            }
            Some(_) | None => {
                out.push('{');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn quote(text: &str) -> String {
    toml::Value::String(text.to_string()).to_string()
}

fn machine_toml(meta: &MachineMeta, run: &Map<String, Value>, states: &[StateOut]) -> String {
    let mut out = format!(
        "format = {FORMAT_VERSION}\nname = {}\nversion = {}\ndescription = {}\n",
        quote(&meta.name),
        meta.version,
        quote(&meta.description)
    );
    if let Some(author) = &meta.author {
        let _ = writeln!(out, "author = {}", quote(author));
    }
    let mut run_lines = Vec::new();
    if let Some(words) = run
        .get("budget_ms")
        .and_then(Value::as_u64)
        .and_then(format_duration_ms)
    {
        run_lines.push(format!("budget = {}", quote(&words)));
    }
    for key in ["max_parallel", "max_children", "max_transitions"] {
        if let Some(value) = run.get(key).and_then(Value::as_u64) {
            run_lines.push(format!("{key} = {value}"));
        }
    }
    if let Some(policy) = run.get("failure_policy").and_then(Value::as_str) {
        run_lines.push(format!("failure_policy = {}", quote(policy)));
    }
    if !run_lines.is_empty() {
        let _ = write!(out, "\n[run]\n{}\n", run_lines.join("\n"));
    }
    for state in states {
        let _ = write!(out, "\n[states.{}]\n", state.id);
        for line in &state.lines {
            out.push_str(line);
            out.push('\n');
        }
        if !state.join.is_empty() {
            let members: Vec<String> = state.join.iter().map(|member| quote(member)).collect();
            let _ = writeln!(out, "join = [{}]", members.join(", "));
        }
        match state.next.as_slice() {
            [] => {}
            [one] => {
                let _ = writeln!(out, "next = {}", quote(one));
            }
            many => {
                let targets: Vec<String> = many.iter().map(|target| quote(target)).collect();
                let _ = writeln!(out, "next = [{}]", targets.join(", "));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_placeholders_double_once_each() {
        assert_eq!(
            to_machine_placeholders(
                "Check {prs}, then {prs} again; keep {other}, {{prs}} and {",
                &["prs"]
            ),
            "Check {{prs}}, then {{prs}} again; keep {other}, {{prs}} and {"
        );
    }
}
