//! The structural check of a factory JSON spec (machine form, or dag sugar
//! that compiles to it). This is the one validator: harness writes, run
//! starts, the machine library, and `factory import` all ask it. Error
//! sentences render values the way the runtime always printed them (Python
//! `repr`), so they read the same in every surface.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt::Write as _;

use serde_json::{Map, Value};

use crate::limits::check_spec_limits;

const FAILURE_POLICIES: [&str; 3] = ["fail_fast", "continue", "escalate"];
const PORT_TYPES: [&str; 2] = ["text", "json"];
const LIFECYCLES: [&str; 2] = ["task", "resident"];
const TRANSITION_ON_KINDS: [&str; 1] = ["settled"];
const GUARD_OPS: [&str; 8] = ["eq", "ne", "gt", "gte", "lt", "lte", "exists", "contains"];
const SUBAGENT_NAME_MAX_LENGTH: usize = 64;
/// Nesting bound on one guard comparison value (`when.value`).
const MAX_GUARD_VALUE_DEPTH: usize = 256;

/// Every structural problem of a factory spec, then its numeric limits;
/// empty when the spec is valid.
#[must_use]
pub fn check_spec(spec: &Value) -> Vec<String> {
    let mut errors = check_structure(spec);
    errors.extend(check_spec_limits(spec));
    errors
}

/// The structural rules alone (the form, states, ports, guards, joins).
fn check_structure(spec: &Value) -> Vec<String> {
    let Some(object) = spec.as_object() else {
        return vec!["factory dag must be a JSON object".to_string()];
    };
    let machine_form = object.contains_key("states") || object.contains_key("transitions");
    if machine_form && object.contains_key("nodes") {
        return vec!["pass either dag or machine form, not both".to_string()];
    }
    if machine_form {
        return check_machine(spec);
    }
    match compile_dag(object) {
        Ok(machine) => check_machine(&machine),
        Err(errors) => errors,
    }
}

/// Python's `repr` of a JSON value, the form every error sentence uses.
#[must_use]
pub fn py_repr(value: &Value) -> String {
    match value {
        Value::Null => "None".to_string(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(number) => match (number.as_i64(), number.as_u64(), number.as_f64()) {
            (Some(int), _, _) => int.to_string(),
            (None, Some(int), _) => int.to_string(),
            (_, _, Some(float)) => py_float(float),
            _ => number.to_string(),
        },
        Value::String(text) => py_str(text),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(py_repr).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(key, item)| format!("{}: {}", py_str(key), py_repr(item)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn py_float(float: f64) -> String {
    let text = format!("{float:?}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

fn py_str(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::with_capacity(text.len() + 2);
    out.push(quote);
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                let _ = write!(out, "\\x{:02x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

fn str_list(items: &[&str]) -> String {
    format!(
        "[{}]",
        items
            .iter()
            .map(|item| py_str(item))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn nonempty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn is_int(value: Option<&Value>) -> bool {
    value.is_some_and(|value| value.is_i64() || value.is_u64())
}

fn positive_int(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|value| *value > 0)
}

fn is_number(value: Option<&Value>) -> bool {
    value.is_some_and(Value::is_number)
}

fn is_scalar(value: Option<&Value>) -> bool {
    !matches!(value, Some(Value::Array(_) | Value::Object(_)))
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

fn repr_opt(value: Option<&Value>) -> String {
    value.map_or_else(|| "None".to_string(), py_repr)
}

fn valid_node_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn valid_param_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first == '_')
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn port_list<'a>(node: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    node.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Port name to type for the well-formed entries of a port list.
fn declared_port_types(node: &Map<String, Value>, key: &str) -> BTreeMap<String, String> {
    let mut ports = BTreeMap::new();
    for entry in port_list(node, key) {
        let (Some(name), Some(port_type)) = (
            nonempty_str(entry.get("name")),
            entry.get("type").and_then(Value::as_str),
        ) else {
            continue;
        };
        if PORT_TYPES.contains(&port_type) {
            ports.insert(name.to_string(), port_type.to_string());
        }
    }
    ports
}

fn input_sources(node: &Map<String, Value>) -> Vec<String> {
    port_list(node, "inputs")
        .iter()
        .filter_map(|input| input.get("from").and_then(Value::as_str))
        .filter_map(|source| source.split_once('.').map(|(state, _)| state.to_string()))
        .collect()
}

fn is_resident(node: &Map<String, Value>) -> bool {
    node.get("lifecycle").and_then(Value::as_str) == Some("resident")
}

fn value_is_finite(value: &Value, depth: usize) -> bool {
    if depth > MAX_GUARD_VALUE_DEPTH {
        return false;
    }
    match value {
        Value::Array(items) => items.iter().all(|item| value_is_finite(item, depth + 1)),
        Value::Object(map) => map.values().all(|item| value_is_finite(item, depth + 1)),
        _ => true,
    }
}

/// Run-block checks shared by both forms; returns the run budget.
fn check_run_fields(run: Option<&Map<String, Value>>, errors: &mut Vec<String>) -> Option<u64> {
    let run = run?;
    if run.contains_key("budget_ms") && positive_int(run.get("budget_ms")).is_none() {
        errors.push("run budget_ms must be a positive integer".to_string());
    }
    let budget = positive_int(run.get("budget_ms"));
    if run.contains_key("failure_policy")
        && !run
            .get("failure_policy")
            .and_then(Value::as_str)
            .is_some_and(|policy| FAILURE_POLICIES.contains(&policy))
    {
        errors.push(format!(
            "run failure_policy must be one of {}, got {}",
            str_list(&FAILURE_POLICIES),
            repr_opt(run.get("failure_policy"))
        ));
    }
    budget
}

/// Field rules shared by dag nodes (`noun` "node") and machine states.
#[expect(
    clippy::too_many_lines,
    reason = "one block per state field, in the runtime's order"
)]
fn check_state_fields(
    state: &Map<String, Value>,
    run_budget: Option<u64>,
    states_by_id: &[(String, &Map<String, Value>)],
    noun: &str,
    errors: &mut Vec<String>,
) {
    let id = state.get("id").and_then(Value::as_str).unwrap_or_default();
    let lifecycle = state.get("lifecycle");
    if state.contains_key("lifecycle")
        && !lifecycle
            .and_then(Value::as_str)
            .is_some_and(|lifecycle| LIFECYCLES.contains(&lifecycle))
    {
        errors.push(format!(
            "{noun} {id} lifecycle must be 'task' or 'resident', got {}",
            repr_opt(lifecycle)
        ));
    }
    let resident = is_resident(state);
    if state.get("wait").is_some_and(|wait| !wait.is_null()) {
        errors.push(format!(
            "{noun} {id}: wait states require the watch host handlers (rlm.watch.*); they arrive with the communication series - remove the wait block until then"
        ));
    }
    let subagent = state.get("subagent");
    if state.contains_key("python") {
        let python = state.get("python").and_then(Value::as_object);
        if state.contains_key("subagent") {
            errors.push(format!(
                "{noun} {id} declares both subagent and python; use exactly one"
            ));
        }
        match python {
            Some(python)
                if nonempty_str(python.get("import")).is_some()
                    && nonempty_str(python.get("callable")).is_some() =>
            {
                if python.contains_key("path")
                    && !nonempty_str(python.get("path"))
                        .is_some_and(|path| std::path::Path::new(path).has_root())
                {
                    errors.push(format!(
                        "{noun} {id} python path must be an absolute directory when provided"
                    ));
                }
            }
            _ => errors.push(format!(
                "{noun} {id} python requires non-empty 'import' and 'callable' strings"
            )),
        }
        if resident {
            errors.push(format!("python {noun} {id} cannot be resident"));
        }
        if state.contains_key("foreach") {
            errors.push(format!("python {noun} {id} cannot use foreach"));
        }
    } else if nonempty_str(subagent).is_some() {
        // A harness subagent entry id or title, resolved at run time.
    } else if let Some(inline) = subagent.and_then(Value::as_object) {
        if inline
            .get("prompt")
            .and_then(Value::as_str)
            .is_none_or(|prompt| prompt.trim().is_empty())
        {
            errors.push(format!(
                "{noun} {id} inline subagent requires a non-empty prompt"
            ));
        }
        for key in ["name", "model", "thinking"] {
            match inline.get(key) {
                None | Some(Value::Null) => {}
                Some(Value::String(text)) if !text.trim().is_empty() => {}
                Some(_) => errors.push(format!(
                    "{noun} {id} inline subagent {key} must be a non-empty string when provided"
                )),
            }
        }
        if let Some(name) = inline.get("name").and_then(Value::as_str) {
            let length = name.trim().chars().count();
            if length > SUBAGENT_NAME_MAX_LENGTH {
                errors.push(format!(
                    "{noun} {id} inline subagent name must be at most {SUBAGENT_NAME_MAX_LENGTH} characters, got {length}"
                ));
            }
        }
    } else {
        errors.push(format!(
            "{noun} {id} requires a subagent: a harness subagent id/title string or an inline object with a prompt (or a python state: {{\"python\": {{\"import\": \"<module>\", \"callable\": \"<function>\"}}}})"
        ));
    }
    if state.contains_key("emit")
        && !state
            .get("emit")
            .and_then(Value::as_object)
            .is_some_and(|emit| emit.get("outputs").is_some_and(Value::is_array))
    {
        errors.push(format!(
            "{noun} {id} emit must be an object with an outputs list"
        ));
    }
    if state.contains_key("budget_ms") {
        match positive_int(state.get("budget_ms")) {
            None => errors.push(format!("{noun} {id} budget_ms must be a positive integer")),
            Some(budget) => {
                if let Some(run_budget) = run_budget.filter(|run_budget| budget > *run_budget) {
                    errors.push(format!(
                        "{noun} {id} budget_ms {budget} exceeds the run budget_ms {run_budget}"
                    ));
                }
            }
        }
    }
    if state.contains_key("retries")
        && !state
            .get("retries")
            .filter(|retries| is_int(Some(retries)))
            .and_then(Value::as_i64)
            .is_some_and(|retries| (0..=crate::limits::MAX_RETRIES).contains(&retries))
    {
        errors.push(format!(
            "{noun} {id} retries must be an integer between 0 and {}",
            crate::limits::MAX_RETRIES
        ));
    } else if resident && state.get("retries").and_then(Value::as_i64).unwrap_or(0) > 0 {
        errors.push(format!("resident {noun} {id} cannot declare retries"));
    }
    if state.contains_key("failure_policy")
        && !state
            .get("failure_policy")
            .and_then(Value::as_str)
            .is_some_and(|policy| FAILURE_POLICIES.contains(&policy))
    {
        errors.push(format!(
            "{noun} {id} failure_policy must be one of {}, got {}",
            str_list(&FAILURE_POLICIES),
            repr_opt(state.get("failure_policy"))
        ));
    }
    match state.get("outputs") {
        None | Some(Value::Null) => {}
        Some(Value::Array(outputs)) => {
            if resident && !outputs.is_empty() {
                errors.push(format!("resident {noun} {id} cannot declare outputs"));
            }
        }
        Some(_) => errors.push(format!("{noun} {id} outputs must be a list")),
    }
    let mut seen_outputs = HashSet::new();
    let mut reported_outputs = HashSet::new();
    for (index, output) in port_list(state, "outputs").iter().enumerate() {
        let Some(output) = output.as_object() else {
            errors.push(format!("{noun} {id} outputs[{index}] must be an object"));
            continue;
        };
        let name = output.get("name");
        match nonempty_str(name) {
            None => errors.push(format!(
                "{noun} {id} outputs[{index}] requires a non-empty name"
            )),
            Some(text) if !seen_outputs.insert(text) => {
                if reported_outputs.insert(text) {
                    errors.push(format!(
                        "{noun} {id} declares duplicate output name {}",
                        py_str(text)
                    ));
                }
            }
            Some(_) => {}
        }
        if !output
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|port_type| PORT_TYPES.contains(&port_type))
        {
            errors.push(format!(
                "{noun} {id} output {} type must be 'text' or 'json'",
                repr_opt(name)
            ));
        }
    }
    if state
        .get("inputs")
        .is_some_and(|inputs| !inputs.is_null() && !inputs.is_array())
    {
        errors.push(format!("{noun} {id} inputs must be a list"));
    }
    // One output-type map per source state, however many inputs read it.
    let mut output_types_by_source: BTreeMap<&str, BTreeMap<String, String>> = BTreeMap::new();
    let mut seen_inputs = HashSet::new();
    let mut reported_inputs = HashSet::new();
    for (index, input) in port_list(state, "inputs").iter().enumerate() {
        let Some(input) = input.as_object() else {
            errors.push(format!("{noun} {id} inputs[{index}] must be an object"));
            continue;
        };
        let name = input.get("name");
        let name_repr = repr_opt(name);
        if input
            .get("optional")
            .is_some_and(|optional| !optional.is_null() && !optional.is_boolean())
        {
            errors.push(format!(
                "{noun} {id} input {name_repr} optional must be a boolean when provided"
            ));
        }
        match nonempty_str(name) {
            None => errors.push(format!(
                "{noun} {id} inputs[{index}] requires a non-empty name"
            )),
            Some(text) if !seen_inputs.insert(text) => {
                if reported_inputs.insert(text) {
                    errors.push(format!(
                        "{noun} {id} declares duplicate input name {}",
                        py_str(text)
                    ));
                }
            }
            Some(_) => {}
        }
        let port_type = input
            .get("type")
            .and_then(Value::as_str)
            .filter(|port_type| PORT_TYPES.contains(port_type));
        if port_type.is_none() {
            errors.push(format!(
                "{noun} {id} input {name_repr} type must be 'text' or 'json'"
            ));
        }
        let Some((src_id, src_output)) = input
            .get("from")
            .and_then(Value::as_str)
            .and_then(|source| source.split_once('.'))
        else {
            errors.push(format!(
                "{noun} {id} input {name_repr} requires a 'from' reference of the form '<node_id>.<output_name>'"
            ));
            continue;
        };
        let Some((_, src)) = states_by_id.iter().find(|(state_id, _)| state_id == src_id) else {
            errors.push(format!(
                "{noun} {id} input {name_repr} references unknown {noun} {}",
                py_str(src_id)
            ));
            continue;
        };
        if is_resident(src) {
            errors.push(format!(
                "{noun} {id} input {name_repr} cannot read from resident {noun} {}",
                py_str(src_id)
            ));
            continue;
        }
        let src_types = output_types_by_source
            .entry(src_id)
            .or_insert_with(|| declared_port_types(src, "outputs"));
        match src_types.get(src_output) {
            None => errors.push(format!(
                "{noun} {id} input {name_repr} references output {} that {noun} {} does not declare",
                py_str(src_output),
                py_str(src_id)
            )),
            Some(src_type) => {
                if let Some(port_type) = port_type.filter(|port_type| port_type != src_type) {
                    errors.push(format!(
                        "{noun} {id} input {name_repr} of type {} cannot read from output {} of type {}",
                        py_str(port_type),
                        py_str(src_output),
                        py_str(src_type)
                    ));
                }
            }
        }
    }
    if let Some(foreach) = state.get("foreach").filter(|foreach| !foreach.is_null()) {
        if resident {
            errors.push(format!("resident {noun} {id} cannot use foreach"));
        }
        match foreach.as_object() {
            None => errors.push(format!("{noun} {id} foreach must be an object")),
            Some(foreach) => match nonempty_str(foreach.get("over")) {
                None => errors.push(format!(
                    "{noun} {id} foreach.over must be a non-empty input name"
                )),
                Some(over) => match declared_port_types(state, "inputs").get(over) {
                    None => errors.push(format!(
                        "{noun} {id} foreach.over must name one of this {noun}'s inputs, got {}",
                        py_str(over)
                    )),
                    Some(port_type) if port_type != "json" => errors.push(format!(
                        "{noun} {id} foreach.over input {} must have type 'json'",
                        py_str(over)
                    )),
                    Some(_) => {}
                },
            },
        }
    }
}

fn check_guard(when: &Value, index: usize, src: &Map<String, Value>, errors: &mut Vec<String>) {
    let Some(when) = when.as_object() else {
        errors.push(format!("transitions[{index}] when must be an object"));
        return;
    };
    let src_types = declared_port_types(src, "outputs");
    match nonempty_str(when.get("output")) {
        None => errors.push(format!(
            "transitions[{index}] when requires a non-empty output"
        )),
        Some(output) => match src_types.get(output) {
            None => errors.push(format!(
                "transitions[{index}] when.output {} is not a declared output of state {}",
                py_str(output),
                repr_opt(src.get("id"))
            )),
            Some(output_type) => {
                if let Some(path) = when.get("path").filter(|path| !path.is_null()) {
                    if nonempty_str(Some(path)).is_none() {
                        errors.push(format!(
                            "transitions[{index}] when.path must be a non-empty dotted path"
                        ));
                    } else if output_type != "json" {
                        errors.push(format!(
                            "transitions[{index}] when.path requires a json output, got text output {}",
                            py_str(output)
                        ));
                    }
                }
            }
        },
    }
    let op = when
        .get("op")
        .and_then(Value::as_str)
        .filter(|op| GUARD_OPS.contains(op));
    let Some(op) = op else {
        errors.push(format!(
            "transitions[{index}] when.op must be one of {}, got {}",
            str_list(&GUARD_OPS),
            repr_opt(when.get("op"))
        ));
        return;
    };
    if op == "exists" {
        return;
    }
    let value = when.get("value");
    match op {
        "gt" | "gte" | "lt" | "lte" if !is_number(value) => errors.push(format!(
            "transitions[{index}] when.op {} requires a numeric value",
            py_str(op)
        )),
        "contains" if value.and_then(Value::as_array).is_none_or(Vec::is_empty) => {
            errors.push(format!(
                "transitions[{index}] when.op 'contains' requires a non-empty list value"
            ));
        }
        "eq" | "ne" if !is_scalar(value) => errors.push(format!(
            "transitions[{index}] when.op {} requires a scalar value",
            py_str(op)
        )),
        _ => {}
    }
    if !value.is_none_or(|value| value_is_finite(value, 0)) {
        errors.push(format!(
            "transitions[{index}] when.value must be finite JSON data (JSON carries no NaN or Infinity, and only JSON shapes serialize: lists, objects, strings, numbers, booleans, null, and no container nests deeper than {MAX_GUARD_VALUE_DEPTH} levels)"
        ));
    }
}

/// True when `candidate` is a spawn label `base` can produce: `base-i<n>`
/// (n >= 1) and `base-a<n>` (n >= 2) parts.
fn suffixed_spawn_form(base: &str, candidate: &str) -> bool {
    let Some(remainder) = candidate
        .strip_prefix(base)
        .and_then(|rest| rest.strip_prefix('-'))
    else {
        return false;
    };
    remainder.split('-').all(|part| {
        let mut chars = part.chars();
        let kind = chars.next();
        let digits = chars.as_str();
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        let number: u128 = digits.parse().unwrap_or(u128::MAX);
        match kind {
            Some('i') => number >= 1,
            Some('a') => number >= 2,
            _ => false,
        }
    })
}

/// Collect the well-formed states by id (first one wins), reporting
/// malformed and duplicate ids under `list_name[index]`.
fn states_by_id<'a>(
    items: &'a [Value],
    list_name: &str,
    noun: &str,
    errors: &mut Vec<String>,
) -> Vec<(String, &'a Map<String, Value>)> {
    let mut seen = HashSet::new();
    let mut states = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let Some(state) = item.as_object() else {
            errors.push(format!("{list_name}[{index}] must be an object"));
            continue;
        };
        match nonempty_str(state.get("id")) {
            None => errors.push(format!("{list_name}[{index}] requires a non-empty id")),
            Some(id) if !valid_node_id(id) => errors.push(format!(
                "{list_name}[{index}] id must match ^[a-z0-9][a-z0-9-]{{0,63}}$, got {}",
                py_str(id)
            )),
            Some(id) if !seen.insert(id.to_string()) => errors.push(format!(
                "{list_name}[{index}] duplicates {noun} id {}",
                py_str(id)
            )),
            Some(id) => states.push((id.to_string(), state)),
        }
    }
    states
}

#[expect(
    clippy::too_many_lines,
    reason = "the machine rules in the runtime's order"
)]
fn check_machine(machine: &Value) -> Vec<String> {
    let Some(machine) = machine.as_object() else {
        return vec!["factory machine must be a JSON object".to_string()];
    };
    let mut errors = Vec::new();
    let mut run = None;
    match machine.get("run") {
        None | Some(Value::Null) => {}
        Some(Value::Object(object)) => run = Some(object),
        Some(_) => errors.push("run must be an object".to_string()),
    }
    let run_budget = check_run_fields(run, &mut errors);
    let mut param_names = BTreeSet::new();
    match machine.get("params") {
        None | Some(Value::Null) => {}
        Some(Value::Object(params)) if params.keys().all(|key| valid_param_name(key)) => {
            param_names = params.keys().cloned().collect();
        }
        Some(_) => {
            errors.push("params must be an object keyed by lowercase identifiers".to_string());
        }
    }
    let Some(states) = machine.get("states").and_then(Value::as_array) else {
        errors.push("factory machine requires a states list".to_string());
        return errors;
    };
    if states.is_empty() {
        errors.push("factory machine must declare at least one state".to_string());
        return errors;
    }
    let by_id = states_by_id(states, "states", "state", &mut errors);
    let mut seen_names: Vec<(String, String)> = Vec::new();
    for (state_id, state) in &by_id {
        check_state_fields(state, run_budget, &by_id, "state", &mut errors);
        for input in port_list(state, "inputs") {
            if let Some(name) = input
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| param_names.contains(*name))
            {
                errors.push(format!(
                    "state {state_id} input {} is also a param; rename the input",
                    py_str(name)
                ));
            }
        }
        if let Some(name) = state
            .get("subagent")
            .and_then(Value::as_object)
            .and_then(|subagent| nonempty_str(subagent.get("name")))
        {
            let name = name.trim();
            let configured = |key: &str| {
                seen_names
                    .iter()
                    .find(|(seen, _)| seen == key)
                    .map(|(_, owner)| owner.clone())
            };
            let base_seen = seen_names
                .iter()
                .find(|(seen, _)| suffixed_spawn_form(seen, name));
            let base_current = if base_seen.is_some() {
                None
            } else {
                seen_names
                    .iter()
                    .find(|(seen, _)| suffixed_spawn_form(name, seen))
            };
            if let Some(owner) = configured(name) {
                errors.push(format!(
                    "state {state_id} subagent name {} is already configured by state {}",
                    py_str(name),
                    py_str(&owner)
                ));
            } else if let Some((base, owner)) = base_seen {
                errors.push(format!(
                    "state {state_id} subagent name {} collides with the suffixed spawn labels of state {} (configured {}): re-entry, foreach, and retries name children {}-i<n> and {}-a<n>",
                    py_str(name),
                    py_str(owner),
                    py_str(base),
                    py_str(base),
                    py_str(base)
                ));
            } else if let Some((base, owner)) = base_current {
                errors.push(format!(
                    "state {state_id} subagent name {} suffixed by re-entry, foreach, and retries ({}-i<n>, {}-a<n>) collides with state {} (configured {})",
                    py_str(name),
                    py_str(name),
                    py_str(name),
                    py_str(owner),
                    py_str(base)
                ));
            } else {
                seen_names.push((name.to_string(), state_id.clone()));
            }
        }
        if state.get("entry").is_some_and(|entry| !entry.is_boolean()) {
            errors.push(format!("state {state_id} entry must be a boolean"));
        }
        for input in port_list(state, "inputs") {
            let Some(input) = input.as_object() else {
                continue;
            };
            if truthy(input.get("optional")) {
                continue;
            }
            if state.get("entry") == Some(&Value::Bool(true)) {
                errors.push(format!(
                    "entry state {state_id} input {} must be optional: an entry state's first entry has no upstream settle to bind",
                    repr_opt(input.get("name"))
                ));
                continue;
            }
            if input
                .get("from")
                .and_then(Value::as_str)
                .and_then(|source| source.split_once('.'))
                .is_some_and(|(source, _)| source == state_id)
            {
                errors.push(format!(
                    "state {state_id} input {} cannot require itself: mark the self-input optional - a required one can never bind on the state's first entry",
                    repr_opt(input.get("name"))
                ));
            }
        }
    }
    if !by_id.is_empty()
        && !by_id
            .iter()
            .any(|(_, state)| state.get("entry") == Some(&Value::Bool(true)))
    {
        errors.push("factory machine requires at least one entry state".to_string());
    }
    let transitions = match machine.get("transitions") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(transitions)) => transitions.as_slice(),
        Some(_) => {
            errors.push("factory machine transitions must be a list".to_string());
            return errors;
        }
    };
    let lookup = |id: &str| {
        by_id
            .iter()
            .find(|(state_id, _)| state_id == id)
            .map(|(_, state)| *state)
    };
    for (index, transition) in transitions.iter().enumerate() {
        let Some(transition) = transition.as_object() else {
            errors.push(format!("transitions[{index}] must be an object"));
            continue;
        };
        let mut sources: Vec<&str> = Vec::new();
        match transition.get("from") {
            Some(Value::Array(items)) => {
                let names: Vec<Option<&str>> =
                    items.iter().map(|item| nonempty_str(Some(item))).collect();
                if items.is_empty() {
                    errors.push(format!(
                        "transitions[{index}] from must name at least one state"
                    ));
                } else if names.iter().any(Option::is_none) {
                    errors.push(format!(
                        "transitions[{index}] from entries must be non-empty state id strings"
                    ));
                } else {
                    let names: Vec<&str> = names.into_iter().flatten().collect();
                    let unique: HashSet<&str> = names.iter().copied().collect();
                    if unique.len() != names.len() {
                        errors.push(format!("transitions[{index}] from must not repeat a state"));
                    } else if let Some(missing) = names.iter().find(|name| lookup(name).is_none()) {
                        errors.push(format!(
                            "transitions[{index}] references unknown from-state {}",
                            py_str(missing)
                        ));
                    }
                }
                sources = items
                    .iter()
                    .filter_map(|item| nonempty_str(Some(item)))
                    .collect();
                if transition.get("when").is_some_and(|when| !when.is_null()) {
                    errors.push(format!(
                        "transitions[{index}] with multiple from-states cannot carry a when guard; use single-state transitions for guards"
                    ));
                }
            }
            from => match nonempty_str(from) {
                Some(source) => {
                    sources.push(source);
                    if lookup(source).is_none() {
                        errors.push(format!(
                            "transitions[{index}] references unknown from-state {}",
                            py_str(source)
                        ));
                    }
                }
                None => errors.push(format!("transitions[{index}] requires a non-empty from")),
            },
        }
        match nonempty_str(transition.get("to")) {
            None => errors.push(format!("transitions[{index}] requires a non-empty to")),
            Some(to) if lookup(to).is_none() => errors.push(format!(
                "transitions[{index}] references unknown to-state {}",
                py_str(to)
            )),
            Some(_) => {}
        }
        if let Some(on) = transition.get("on") {
            if !on
                .as_str()
                .is_some_and(|on| TRANSITION_ON_KINDS.contains(&on))
            {
                errors.push(format!(
                    "transitions[{index}] on must be one of {}, got {}",
                    str_list(&TRANSITION_ON_KINDS),
                    py_repr(on)
                ));
            }
        }
        let single = matches!(transition.get("from"), Some(Value::String(_)))
            || matches!(transition.get("from"), Some(Value::Array(items)) if items.len() == 1);
        for source in &sources {
            let Some(src) = lookup(source) else { continue };
            if is_resident(src) {
                errors.push(format!(
                    "transitions[{index}] cannot leave resident state {}",
                    py_str(source)
                ));
            }
            if single {
                if let Some(when) = transition.get("when").filter(|when| !when.is_null()) {
                    check_guard(when, index, src, &mut errors);
                }
            }
        }
    }
    errors
}

/// Dependency edges of one dag node: `depends_on`, then input sources,
/// each once.
fn dag_edges(node: &Map<String, Value>) -> Vec<String> {
    let mut edges: Vec<String> = Vec::new();
    for dep in port_list(node, "depends_on") {
        if let Some(dep) = nonempty_str(Some(dep)) {
            if !edges.iter().any(|edge| edge == dep) {
                edges.push(dep.to_string());
            }
        }
    }
    for source in input_sources(node) {
        if !edges.contains(&source) {
            edges.push(source);
        }
    }
    edges
}

/// Check a dag-form spec and compile it to machine form.
fn compile_dag(dag: &Map<String, Value>) -> Result<Value, Vec<String>> {
    let mut errors = Vec::new();
    let mut run = None;
    match dag.get("run") {
        None | Some(Value::Null) => {}
        Some(Value::Object(object)) => run = Some(object),
        Some(_) => errors.push("run must be an object".to_string()),
    }
    let run_budget = check_run_fields(run, &mut errors);
    let Some(nodes) = dag.get("nodes").and_then(Value::as_array) else {
        errors.push("factory dag requires a nodes list".to_string());
        return Err(errors);
    };
    if nodes.is_empty() {
        errors.push("factory dag must declare at least one node".to_string());
        return Err(errors);
    }
    let by_id = states_by_id(nodes, "nodes", "node", &mut errors);
    for (node_id, node) in &by_id {
        check_state_fields(node, run_budget, &by_id, "node", &mut errors);
        if input_sources(node).iter().any(|source| source == node_id) {
            errors.push(format!("node {node_id} cannot depend on itself"));
        }
        match node.get("depends_on") {
            None | Some(Value::Null) => {}
            Some(Value::Array(deps)) => {
                for dep in deps {
                    match nonempty_str(Some(dep)) {
                        None => errors.push(format!(
                            "node {node_id} depends_on entries must be non-empty node id strings"
                        )),
                        Some(dep) if dep == node_id => {
                            errors.push(format!("node {node_id} cannot depend on itself"));
                        }
                        Some(dep) => match by_id.iter().find(|(id, _)| id == dep) {
                            None => errors.push(format!(
                                "node {node_id} depends on unknown node {}",
                                py_str(dep)
                            )),
                            Some((_, target)) if is_resident(target) => errors.push(format!(
                                "node {node_id} cannot depend on resident node {}",
                                py_str(dep)
                            )),
                            Some(_) => {}
                        },
                    }
                }
            }
            Some(_) => errors.push(format!(
                "node {node_id} depends_on must be a list of node ids"
            )),
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let mut states = Vec::new();
    let mut transitions = Vec::new();
    for node in nodes {
        let node = node.as_object().expect("checked above");
        let edges = dag_edges(node);
        let mut state = Map::new();
        state.insert("id".to_string(), node["id"].clone());
        state.insert("entry".to_string(), Value::Bool(edges.is_empty()));
        state.insert("max_entries".to_string(), Value::from(1));
        for key in [
            "subagent",
            "python",
            "lifecycle",
            "budget_ms",
            "retries",
            "failure_policy",
            "inputs",
            "outputs",
            "foreach",
        ] {
            if let Some(value) = node.get(key) {
                state.insert(key.to_string(), value.clone());
            }
        }
        states.push(Value::Object(state));
        if !edges.is_empty() {
            let from = if edges.len() == 1 {
                Value::from(edges[0].clone())
            } else {
                Value::from(edges)
            };
            transitions.push(serde_json::json!({"from": from, "to": node["id"].clone()}));
        }
    }
    let mut machine = Map::new();
    if let Some(run) = run {
        machine.insert("run".to_string(), Value::Object(run.clone()));
    }
    machine.insert("states".to_string(), Value::Array(states));
    machine.insert("transitions".to_string(), Value::Array(transitions));
    Ok(Value::Object(machine))
}

#[cfg(test)]
mod tests;
