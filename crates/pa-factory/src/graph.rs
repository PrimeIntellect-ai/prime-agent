//! Checks on how a machine's states fit together.
//!
//! Every input names a real port, every route covers every value of the
//! type it switches on, every join is waited for by its members, and every
//! state is reachable from an entry state. A machine that passes cannot
//! stall on an unrouted value or a port that does not exist.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::load::{routed_slot, CONTEXT_FILE, MACHINE_FILE};
use crate::machine::{Diagnostic, Machine, Reference, State, Work};
use crate::types::Type;

pub(crate) fn check(machine: &Machine) -> Vec<Diagnostic> {
    let mut problems = Vec::new();
    let mut report =
        |at: String, message: String| problems.push(Diagnostic::new(MACHINE_FILE, at, message));
    if !machine.states.iter().any(|state| state.entry) {
        report(
            "states".to_string(),
            "no entry state: mark the first state with entry = true".to_string(),
        );
    }
    let mut labels: BTreeMap<&str, &str> = BTreeMap::new();
    for state in &machine.states {
        if let Work::Agent(agent) = &state.work {
            if let Some(label) = &agent.label {
                if let Some(first) = labels.insert(label, &state.id) {
                    report(
                        format!("states.{}.agent.name", state.id),
                        format!("{label:?} already labels state {first:?}"),
                    );
                }
            }
        }
    }
    let joins: BTreeMap<&str, &State> = machine
        .states
        .iter()
        .filter(|state| !state.join.is_empty())
        .map(|state| (state.id.as_str(), state))
        .collect();
    for state in &machine.states {
        check_inputs(machine, state, &mut report);
        check_shape(machine, state, &mut report);
        check_edges(machine, state, &joins, &mut report);
        check_join(machine, state, &mut report);
    }
    check_reachable(machine, &mut report);
    for state in &machine.states {
        if let Work::Agent(agent) = &state.work {
            check_placeholders(
                machine,
                state,
                &agent.prompt_file,
                &agent.prompt,
                &mut problems,
            );
            if let Some(context) = &machine.context {
                check_placeholders(machine, state, CONTEXT_FILE, context, &mut problems);
            }
        }
    }
    problems
}

fn check_inputs(machine: &Machine, state: &State, report: &mut impl FnMut(String, String)) {
    for input in &state.inputs {
        let at = format!("states.{}.inputs.{}", state.id, input.name);
        if machine.param(&input.name).is_some() {
            report(
                at.clone(),
                format!("{:?} is also a param; rename the input", input.name),
            );
        }
        let Reference::Port(selector) = &input.from else {
            // The loader checked the asset path; an asset is always there.
            continue;
        };
        let Some(source) = machine.state(&selector.state) else {
            report(at, format!("{:?} names no state", input.to_string()));
            continue;
        };
        if source.resident {
            report(
                at,
                format!(
                    "{} is resident; nothing can read from a resident",
                    selector.state
                ),
            );
            continue;
        }
        if source.output(&selector.port).is_none() {
            let ports: Vec<&str> = source
                .outputs
                .iter()
                .map(|output| output.name.as_str())
                .collect();
            report(
                at.clone(),
                format!(
                    "{} has no output {:?} (it has: {})",
                    selector.state,
                    selector.port,
                    if ports.is_empty() {
                        "none".to_string()
                    } else {
                        ports.join(", ")
                    }
                ),
            );
        }
        if selector.state == state.id && !input.optional {
            report(
                at.clone(),
                "a state cannot require its own output: mark the self-input optional with ?"
                    .to_string(),
            );
        }
        if state.entry && !input.optional {
            report(at, "an entry state's inputs must be optional (add ?): its first entry has nothing to bind".to_string());
        }
    }
}

fn check_shape(machine: &Machine, state: &State, report: &mut impl FnMut(String, String)) {
    let at = format!("states.{}", state.id);
    // The executor refuses a state budget past the run's (the run pauses
    // first), so the loader does too.
    if let (Some(budget), Some(run)) = (state.budget_ms, machine.run.budget_ms) {
        if budget > run {
            report(
                format!("{at}.budget"),
                "exceeds the run budget; raise run.budget or lower this one".to_string(),
            );
        }
    }
    let python = matches!(state.work, Work::Python(_));
    if let Some(foreach) = &state.foreach {
        if python || state.resident {
            report(
                format!("{at}.foreach"),
                "only agent task states can fan out with foreach".to_string(),
            );
        }
        match state.input(&foreach.over) {
            None => report(
                format!("{at}.foreach.over"),
                format!("{:?} is not an input of this state", foreach.over),
            ),
            Some(input) => {
                let ty = match &input.from {
                    Reference::Port(selector) => machine
                        .state(&selector.state)
                        .and_then(|source| source.output(&selector.port))
                        .map(|output| &output.slot.ty),
                    Reference::Asset(_) => Some(&Type::Text),
                };
                if !matches!(ty, Some(Type::List(_) | Type::Json) | None) {
                    report(
                        format!("{at}.foreach.over"),
                        format!("{:?} is not a list", foreach.over),
                    );
                }
            }
        }
    }
    if state.resident {
        if python {
            report(
                format!("{at}.resident"),
                "a python state cannot be resident".to_string(),
            );
        }
        if !state.outputs.is_empty()
            || !state.next.is_empty()
            || state.route.is_some()
            || state.retries.is_some()
        {
            report(
                format!("{at}.resident"),
                "a resident declares no outputs, next, route, or retries".to_string(),
            );
        }
    }
}

fn check_edges(
    machine: &Machine,
    state: &State,
    joins: &BTreeMap<&str, &State>,
    report: &mut impl FnMut(String, String),
) {
    let at = format!("states.{}", state.id);
    if !state.next.is_empty() && state.route.is_some() {
        report(at.clone(), "use next or route, not both".to_string());
    }
    let mut seen = BTreeSet::new();
    for target in &state.next {
        if !seen.insert(target) {
            report(format!("{at}.next"), format!("{target:?} is listed twice"));
        } else if machine.state(target).is_none() {
            report(format!("{at}.next"), format!("{target:?} names no state"));
        } else if let Some(join) = joins.get(target.as_str()) {
            if !join.join.contains(&state.id) {
                report(
                    format!("{at}.next"),
                    format!(
                        "{target} joins {}; add {} to its join list or route elsewhere",
                        join.join.join(", "),
                        state.id
                    ),
                );
            }
        }
    }
    if let Some(route) = &state.route {
        match routed_slot(state, route, &machine.records) {
            Err(error) => report(format!("{at}.route"), error),
            Ok(slot) => {
                let values: Vec<String> = match &slot.ty {
                    Type::Enum(values) => values.clone(),
                    Type::Bool => vec!["true".to_string(), "false".to_string()],
                    other => {
                        report(format!("{at}.route"), format!("route on {:?}: a route switches on an enum or bool, not {}; compute the choice in a python state", route.port, crate::types::describe(other)));
                        Vec::new()
                    }
                };
                if slot.optional {
                    report(
                        format!("{at}.route"),
                        "a route cannot switch on an optional field".to_string(),
                    );
                }
                let arms: BTreeSet<&str> =
                    route.arms.iter().map(|(value, _)| value.as_str()).collect();
                let missing: Vec<&str> = values
                    .iter()
                    .map(String::as_str)
                    .filter(|value| !arms.contains(value))
                    .collect();
                if !values.is_empty() && !missing.is_empty() {
                    report(
                        format!("{at}.route"),
                        format!(
                            "no route for {}: every value needs a target",
                            missing.join(", ")
                        ),
                    );
                }
                for (value, target) in &route.arms {
                    if !values.is_empty() && !values.contains(value) {
                        report(
                            format!("{at}.route.{value}"),
                            format!(
                                "{value:?} is not a value of {} (values: {})",
                                route.port,
                                values.join(", ")
                            ),
                        );
                    }
                    if machine.state(target).is_none() {
                        report(
                            format!("{at}.route.{value}"),
                            format!("{target:?} names no state"),
                        );
                    } else if joins.contains_key(target.as_str()) {
                        report(
                            format!("{at}.route.{value}"),
                            format!("{target} is a join; a join's members reach it with next"),
                        );
                    }
                }
            }
        }
    }
}

fn check_join(machine: &Machine, state: &State, report: &mut impl FnMut(String, String)) {
    let at = format!("states.{}", state.id);
    if !state.join.is_empty() {
        if state.join.len() < 2 {
            report(
                format!("{at}.join"),
                "a join waits for two or more states".to_string(),
            );
        }
        let mut members = BTreeSet::new();
        for member in &state.join {
            if !members.insert(member) {
                report(format!("{at}.join"), format!("{member:?} is listed twice"));
                continue;
            }
            match machine.state(member) {
                None => report(format!("{at}.join"), format!("{member:?} names no state")),
                Some(found) if !found.next.contains(&state.id) => {
                    report(
                        format!("{at}.join"),
                        format!("{member} must name {} in its next", state.id),
                    );
                }
                Some(_) => {}
            }
        }
    }
}

fn check_reachable(machine: &Machine, report: &mut impl FnMut(String, String)) {
    let mut reached: BTreeSet<&str> = BTreeSet::new();
    let mut queue: VecDeque<&str> = machine
        .states
        .iter()
        .filter(|state| state.entry)
        .map(|state| state.id.as_str())
        .collect();
    while let Some(id) = queue.pop_front() {
        if !reached.insert(id) {
            continue;
        }
        if let Some(state) = machine.state(id) {
            let routed = state
                .route
                .iter()
                .flat_map(|route| route.arms.iter().map(|(_, target)| target));
            queue.extend(state.next.iter().chain(routed).map(String::as_str));
        }
    }
    for state in &machine.states {
        if !reached.contains(state.id.as_str()) {
            report(
                format!("states.{}", state.id),
                "unreachable: no entry state leads here through next or route".to_string(),
            );
        }
    }
}

/// The `{{name}}` placeholders in a prompt, and any `{name}` written with
/// single braces where `{{name}}` was meant.
pub(crate) fn scan_placeholders(text: &str) -> (Vec<&str>, Vec<&str>) {
    let mut doubled = Vec::new();
    let mut single = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        let after = &rest[open..];
        if let Some(inner) = after.strip_prefix("{{") {
            if let Some(close) = inner.find("}}") {
                let name = inner[..close].trim();
                if crate::load::is_identifier(name) {
                    doubled.push(name);
                }
                rest = &inner[close + 2..];
                continue;
            }
            rest = inner;
            continue;
        }
        let inner = &after[1..];
        if let Some(close) = inner.find('}') {
            let name = &inner[..close];
            if crate::load::is_identifier(name) {
                single.push(name);
            }
        }
        rest = inner;
    }
    (doubled, single)
}

fn check_placeholders(
    machine: &Machine,
    state: &State,
    file: &str,
    text: &str,
    problems: &mut Vec<Diagnostic>,
) {
    let known = |name: &str| machine.param(name).is_some() || state.input(name).is_some();
    let (doubled, single) = scan_placeholders(text);
    for name in doubled {
        if !known(name) {
            let at = format!("states.{}", state.id);
            problems.push(Diagnostic::new(
                file,
                at,
                format!("{{{{{name}}}}} is neither a param nor an input of this state"),
            ));
        }
    }
    for name in single {
        if known(name) {
            problems.push(Diagnostic::new(
                file,
                format!("states.{}", state.id),
                format!("{{{name}}} has single braces; write {{{{{name}}}}} to insert the value"),
            ));
        }
    }
}
