//! Read a machine directory into a [`Machine`].
//!
//! Loading parses `machine.toml`, reads every file it names, and checks each
//! state on its own. [`crate::graph`] then checks how the states fit
//! together. Both collect every problem instead of stopping at the first,
//! so one `factory validate` run lists everything to fix.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

use serde::Deserialize;
use serde_json::Value;
use toml::Spanned;

use crate::duration::parse_duration_ms;
use crate::limits::{
    FOREACH_MAX, MAX_CHILDREN, MAX_ENTRIES, MAX_PARALLEL, MAX_RETRIES, MAX_STATES, MAX_TRANSITIONS,
};
use crate::machine::{
    Agent, Diagnostic, FailurePolicy, Foreach, Input, Machine, Output, Param, PythonCall, Route,
    Rubric, RubricRule, RunSettings, State, Work, FORMAT_VERSION,
};
use crate::types::{self, parse_slot, parse_type, record_names, Records, Slot, Type};

pub const MACHINE_FILE: &str = "machine.toml";
pub const CONTEXT_FILE: &str = "prompts/_context.md";

const LABEL_MAX_CHARS: usize = 64;
const SEVERITIES: [&str; 4] = ["blocker", "major", "minor", "nit"];

/// Entries of a TOML table in the order the file wrote them.
///
/// The workspace's `toml` keeps tables sorted, so order comes from the
/// keys' spans.
type Ordered<V> = BTreeMap<Spanned<String>, V>;

fn in_file_order<V>(table: Ordered<V>) -> Vec<(String, V)> {
    let mut entries: Vec<(Spanned<String>, V)> = table.into_iter().collect();
    entries.sort_by_key(|(key, _)| key.span().start);
    entries
        .into_iter()
        .map(|(key, value)| (key.into_inner(), value))
        .collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMachine {
    #[expect(dead_code, reason = "read and checked before this struct parses")]
    format: i64,
    name: String,
    version: i64,
    description: String,
    author: Option<String>,
    #[serde(default)]
    params: Ordered<RawParam>,
    #[serde(default)]
    run: RawRun,
    #[serde(default)]
    roles: BTreeMap<String, RawRole>,
    #[serde(default)]
    types: BTreeMap<String, Ordered<String>>,
    #[serde(default)]
    states: Ordered<RawState>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawParam {
    #[serde(rename = "type")]
    ty: String,
    default: Option<toml::Value>,
    description: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawRun {
    budget: Option<String>,
    max_parallel: Option<i64>,
    max_children: Option<i64>,
    max_transitions: Option<i64>,
    failure_policy: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRole {
    model: String,
    thinking: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawState {
    #[serde(default)]
    entry: bool,
    kind: Option<String>,
    agent: Option<RawAgent>,
    run: Option<String>,
    #[serde(default)]
    inputs: Ordered<String>,
    #[serde(default)]
    outputs: Ordered<String>,
    next: Option<OneOrMany>,
    route: Option<BTreeMap<String, String>>,
    #[serde(default)]
    join: Vec<String>,
    max_entries: Option<i64>,
    retries: Option<i64>,
    budget: Option<String>,
    failure_policy: Option<String>,
    foreach: Option<RawForeach>,
    #[serde(default)]
    resident: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAgent {
    prompt: String,
    role: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    name: Option<String>,
    rubric: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawForeach {
    over: String,
    max: i64,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OneOrMany {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRubric {
    #[serde(default)]
    rule: Vec<RawRule>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRule {
    id: String,
    check: String,
    default: String,
}

/// Load and check one machine directory.
///
/// # Errors
/// Returns every problem found, in file order.
pub fn load_machine_dir(dir: &Path) -> Result<Machine, Vec<Diagnostic>> {
    let text = std::fs::read_to_string(dir.join(MACHINE_FILE)).map_err(|error| {
        vec![Diagnostic::new(
            MACHINE_FILE,
            "",
            format!("cannot read {}: {error}", dir.join(MACHINE_FILE).display()),
        )]
    })?;
    let machine = parse_machine(dir, &text)?;
    let problems = crate::graph::check(&machine);
    if problems.is_empty() {
        Ok(machine)
    } else {
        Err(problems)
    }
}

fn parse_machine(dir: &Path, text: &str) -> Result<Machine, Vec<Diagnostic>> {
    let syntax = |error: toml::de::Error| {
        vec![Diagnostic::new(
            MACHINE_FILE,
            "",
            error.message().trim().to_string() + &line_suffix(text, error.span()),
        )]
    };
    let table: toml::Table = toml::from_str(text).map_err(syntax)?;
    match table.get("format") {
        Some(toml::Value::Integer(FORMAT_VERSION)) => {}
        Some(toml::Value::Integer(newer)) if *newer > FORMAT_VERSION => {
            return Err(vec![Diagnostic::new(
                MACHINE_FILE,
                "format",
                format!(
                    "format {newer} is newer than this Prime Agent reads (format {FORMAT_VERSION}); update Prime Agent"
                ),
            )]);
        }
        Some(other) => {
            return Err(vec![Diagnostic::new(
                MACHINE_FILE,
                "format",
                format!("expected format = {FORMAT_VERSION}, got {other}"),
            )]);
        }
        None => {
            return Err(vec![Diagnostic::new(
                MACHINE_FILE,
                "format",
                format!("missing; the first line of machine.toml is format = {FORMAT_VERSION}"),
            )]);
        }
    }
    let raw: RawMachine = toml::from_str(text).map_err(syntax)?;
    let mut problems = Vec::new();
    let machine = build_machine(dir, raw, &mut problems);
    if problems.is_empty() {
        Ok(machine)
    } else {
        Err(problems)
    }
}

fn line_suffix(text: &str, span: Option<std::ops::Range<usize>>) -> String {
    span.map_or_else(String::new, |span| {
        let line = text[..span.start.min(text.len())].matches('\n').count() + 1;
        format!(" (line {line})")
    })
}

fn build_machine(dir: &Path, raw: RawMachine, problems: &mut Vec<Diagnostic>) -> Machine {
    let mut report =
        |at: &str, message: String| problems.push(Diagnostic::new(MACHINE_FILE, at, message));
    if !is_machine_name(&raw.name) {
        report(
            "name",
            format!(
                "{:?} is not a machine name: lowercase letters, digits and -, at most 64 characters",
                raw.name
            ),
        );
    }
    let version = u64::try_from(raw.version)
        .ok()
        .filter(|v| *v >= 1)
        .unwrap_or_else(|| {
            report(
                "version",
                format!("must be a positive integer, got {}", raw.version),
            );
            1
        });
    if raw.description.trim().is_empty() {
        report("description", "cannot be empty".to_string());
    }

    let records = build_records(raw.types, problems);
    let params = build_params(raw.params, &records, problems);
    let run = build_run(raw.run, problems);
    let roles = raw.roles;
    let context = read_text_file(dir, CONTEXT_FILE, "", problems, Presence::Optional);

    let mut states = Vec::new();
    let raw_states = in_file_order(raw.states);
    if raw_states.is_empty() {
        problems.push(Diagnostic::new(
            MACHINE_FILE,
            "states",
            "a machine needs at least one state",
        ));
    }
    if raw_states.len() > MAX_STATES {
        problems.push(Diagnostic::new(
            MACHINE_FILE,
            "states",
            format!("at most {MAX_STATES} states, got {}", raw_states.len()),
        ));
    }
    for (id, raw_state) in raw_states {
        if let Some(state) = build_state(dir, &id, raw_state, &roles, &records, problems) {
            states.push(state);
        }
    }
    Machine {
        dir: dir.to_path_buf(),
        name: raw.name,
        version,
        description: raw.description,
        author: raw.author,
        params,
        run,
        records,
        context,
        states,
    }
}

pub(crate) fn is_machine_name(text: &str) -> bool {
    crate::library::machine_name_errors(text).is_empty()
}

pub(crate) fn is_state_id(text: &str) -> bool {
    text.len() <= 64 && types::is_word(text) && !text.contains('_')
}

/// A name usable as a Python identifier and a prompt placeholder.
pub(crate) fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first == '_')
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn build_records(
    raw: BTreeMap<String, Ordered<String>>,
    problems: &mut Vec<Diagnostic>,
) -> Records {
    let mut records = Records::default();
    for (name, fields) in raw {
        let at = format!("types.{name}");
        if !types::is_word(&name) || is_builtin_type_name(&name) {
            problems.push(Diagnostic::new(MACHINE_FILE, &at, format!("{name:?} cannot name a record: use a lowercase word that is not a built-in type")));
            continue;
        }
        let mut parsed = Vec::new();
        for (field, text) in in_file_order(fields) {
            if !is_identifier(&field) {
                problems.push(Diagnostic::new(
                    MACHINE_FILE,
                    format!("{at}.{field}"),
                    "field names are lowercase identifiers (a-z, 0-9, _)",
                ));
                continue;
            }
            match parse_slot(&text) {
                Ok(slot) => parsed.push((field, slot)),
                Err(error) => problems.push(Diagnostic::new(
                    MACHINE_FILE,
                    format!("{at}.{field}"),
                    error,
                )),
            }
        }
        if parsed.is_empty() {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                &at,
                "a record needs at least one field",
            ));
        }
        records.0.insert(name, parsed);
    }
    for (name, fields) in &records.0 {
        for (field, slot) in fields {
            for referenced in record_names(&slot.ty) {
                if !records.0.contains_key(referenced) {
                    problems.push(Diagnostic::new(
                        MACHINE_FILE,
                        format!("types.{name}.{field}"),
                        format!(
                            "unknown type {referenced:?}; declare it under [types.{referenced}]"
                        ),
                    ));
                }
            }
        }
        if refers_to(&records, name, name, &mut BTreeSet::new()) {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                format!("types.{name}"),
                "a record cannot contain itself, directly or through another record",
            ));
        }
    }
    records
}

fn is_builtin_type_name(name: &str) -> bool {
    matches!(
        name,
        "text" | "int" | "float" | "bool" | "file" | "json" | "enum" | "list"
    )
}

fn refers_to(records: &Records, from: &str, target: &str, seen: &mut BTreeSet<String>) -> bool {
    if !seen.insert(from.to_string()) {
        return false;
    }
    records
        .fields(from)
        .unwrap_or_default()
        .iter()
        .any(|(_, slot)| {
            record_names(&slot.ty)
                .into_iter()
                .any(|name| name == target || refers_to(records, name, target, seen))
        })
}

fn build_params(
    raw: Ordered<RawParam>,
    records: &Records,
    problems: &mut Vec<Diagnostic>,
) -> Vec<Param> {
    let mut params = Vec::new();
    for (name, param) in in_file_order(raw) {
        let at = format!("params.{name}");
        if !is_identifier(&name) {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                &at,
                "param names are lowercase identifiers (a-z, 0-9, _)",
            ));
            continue;
        }
        let ty = match parse_type(&param.ty) {
            Ok(ty) => ty,
            Err(error) => {
                problems.push(Diagnostic::new(MACHINE_FILE, format!("{at}.type"), error));
                continue;
            }
        };
        if let Some(missing) = record_names(&ty)
            .into_iter()
            .find(|name| !records.0.contains_key(*name))
        {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                format!("{at}.type"),
                format!("unknown type {missing:?}"),
            ));
            continue;
        }
        let default = param.default.map(|value| {
            let json = toml_to_json(value);
            if let Err(error) = types::check_value(&ty, &json, records, &format!("{at}.default")) {
                problems.push(Diagnostic::new(MACHINE_FILE, "", error));
            }
            json
        });
        params.push(Param {
            name,
            ty,
            default,
            description: param.description,
        });
    }
    params
}

pub(crate) fn toml_to_json(value: toml::Value) -> Value {
    match value {
        toml::Value::String(text) => Value::String(text),
        toml::Value::Integer(number) => Value::from(number),
        toml::Value::Float(number) => Value::from(number),
        toml::Value::Boolean(flag) => Value::Bool(flag),
        toml::Value::Datetime(datetime) => Value::String(datetime.to_string()),
        toml::Value::Array(items) => Value::Array(items.into_iter().map(toml_to_json).collect()),
        toml::Value::Table(table) => Value::Object(
            table
                .into_iter()
                .map(|(key, value)| (key, toml_to_json(value)))
                .collect(),
        ),
    }
}

fn build_run(raw: RawRun, problems: &mut Vec<Diagnostic>) -> RunSettings {
    RunSettings {
        budget_ms: raw
            .budget
            .and_then(|text| duration(&text, "run.budget", problems)),
        max_parallel: raw
            .max_parallel
            .and_then(|value| bounded(value, 1, MAX_PARALLEL, "run.max_parallel", problems)),
        max_children: raw
            .max_children
            .and_then(|value| bounded(value, 1, MAX_CHILDREN, "run.max_children", problems)),
        max_transitions: raw
            .max_transitions
            .and_then(|value| bounded(value, 1, MAX_TRANSITIONS, "run.max_transitions", problems)),
        failure_policy: raw
            .failure_policy
            .and_then(|text| policy(&text, "run.failure_policy", problems)),
    }
}

fn duration(text: &str, at: &str, problems: &mut Vec<Diagnostic>) -> Option<u64> {
    parse_duration_ms(text)
        .map_err(|error| problems.push(Diagnostic::new(MACHINE_FILE, at, error)))
        .ok()
}

fn bounded(
    value: i64,
    low: i64,
    high: i64,
    at: &str,
    problems: &mut Vec<Diagnostic>,
) -> Option<u64> {
    if (low..=high).contains(&value) {
        u64::try_from(value).ok()
    } else {
        problems.push(Diagnostic::new(
            MACHINE_FILE,
            at,
            format!("must be {low} to {high}, got {value}"),
        ));
        None
    }
}

fn policy(text: &str, at: &str, problems: &mut Vec<Diagnostic>) -> Option<FailurePolicy> {
    let parsed = FailurePolicy::parse(text);
    if parsed.is_none() {
        problems.push(Diagnostic::new(
            MACHINE_FILE,
            at,
            format!(
                "{text:?} is not a failure policy: use {}",
                FailurePolicy::NAMES.join(", ")
            ),
        ));
    }
    parsed
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Presence {
    Required,
    Optional,
}

/// Read a UTF-8 file the machine names. The path stays inside the dir.
fn read_text_file(
    dir: &Path,
    relative: &str,
    at: &str,
    problems: &mut Vec<Diagnostic>,
    presence: Presence,
) -> Option<String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        problems.push(Diagnostic::new(
            MACHINE_FILE,
            at,
            format!("{relative:?} must be a relative path inside the machine directory"),
        ));
        return None;
    }
    let full = dir.join(path);
    // A relative in-dir path can still leave the dir through a symlink
    // (`prompts/a.md -> /tmp/secret`), which would put outside content into
    // a child prompt. An existing file must canonicalize under the machine
    // dir; a missing one falls through to the read below, which reports it.
    if let (Ok(dir_canonical), Ok(full_canonical)) = (dir.canonicalize(), full.canonicalize()) {
        if !full_canonical.starts_with(&dir_canonical) {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                at,
                format!(
                    "{relative:?} escapes the machine directory (a symlink pointing outside it)"
                ),
            ));
            return None;
        }
    }
    match std::fs::read(&full) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) if text.trim().is_empty() => {
                problems.push(Diagnostic::new(relative, "", "the file is empty"));
                None
            }
            Ok(text) => Some(text),
            Err(_) => {
                problems.push(Diagnostic::new(relative, "", "not valid UTF-8"));
                None
            }
        },
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && presence == Presence::Optional =>
        {
            None
        }
        Err(error) => {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                at,
                format!("cannot read {relative}: {error}"),
            ));
            None
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one pass over a state's keys in declaration order; each arm is a few lines"
)]
fn build_state(
    dir: &Path,
    id: &str,
    raw: RawState,
    roles: &BTreeMap<String, RawRole>,
    records: &Records,
    problems: &mut Vec<Diagnostic>,
) -> Option<State> {
    let at = format!("states.{id}");
    let start = problems.len();
    let mut report = |key: &str, message: String| {
        let path = if key.is_empty() {
            at.clone()
        } else {
            format!("{at}.{key}")
        };
        problems.push(Diagnostic::new(MACHINE_FILE, path, message));
    };
    if !is_state_id(id) {
        report(
            "",
            format!(
                "{id:?} is not a state id: lowercase letters, digits and -, at most 64 characters"
            ),
        );
    }

    let work = match (raw.kind.as_deref(), raw.agent, raw.run) {
        (None, Some(agent), None) => build_agent(dir, &at, agent, roles, problems).map(Work::Agent),
        (Some("python"), None, Some(target)) => {
            build_python(dir, &at, &target, problems).map(Work::Python)
        }
        (Some("python"), Some(_), _) => {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                &at,
                "a python state has run = \"<file>.py:<function>\", not agent",
            ));
            None
        }
        (Some("python"), None, None) => {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                format!("{at}.run"),
                "a python state needs run = \"nodes/<file>.py:<function>\"",
            ));
            None
        }
        (None, None, _) => {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                &at,
                "a state runs an agent (agent = { prompt = ... }) or Python (kind = \"python\")",
            ));
            None
        }
        (None, Some(_), Some(_)) => {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                format!("{at}.run"),
                "run belongs to python states; this state has agent",
            ));
            None
        }
        (Some(other), _, _) => {
            problems.push(Diagnostic::new(MACHINE_FILE, format!("{at}.kind"), format!("{other:?} is not a state kind: leave kind out for an agent state, or use \"python\"")));
            None
        }
    };

    let mut inputs = Vec::new();
    for (name, from) in in_file_order(raw.inputs) {
        let key = format!("{at}.inputs.{name}");
        if !is_identifier(&name) {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                &key,
                "input names are lowercase identifiers (a-z, 0-9, _)",
            ));
            continue;
        }
        let (reference, optional) = match from.strip_suffix('?') {
            Some(reference) => (reference, true),
            None => (from.as_str(), false),
        };
        match reference.split_once('.') {
            Some((state, port)) if !state.is_empty() && !port.is_empty() && !port.contains('.') => inputs.push(Input {
                name,
                state: state.to_string(),
                port: port.to_string(),
                optional,
            }),
            _ => problems.push(Diagnostic::new(MACHINE_FILE, &key, format!("{from:?} must name a state's output as \"<state>.<port>\" (add ? when optional)"))),
        }
    }

    let mut outputs = Vec::new();
    for (name, text) in in_file_order(raw.outputs) {
        let key = format!("{at}.outputs.{name}");
        if !is_identifier(&name) {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                &key,
                "output names are lowercase identifiers (a-z, 0-9, _)",
            ));
            continue;
        }
        match parse_slot(&text) {
            Ok(slot) => {
                if let Some(missing) = record_names(&slot.ty)
                    .into_iter()
                    .find(|name| !records.0.contains_key(*name))
                {
                    problems.push(Diagnostic::new(
                        MACHINE_FILE,
                        &key,
                        format!("unknown type {missing:?}; declare it under [types.{missing}]"),
                    ));
                } else if slot.optional {
                    problems.push(Diagnostic::new(MACHINE_FILE, &key, "optional outputs need typed emit (rlm.factory.emit); this build captures outputs from the final answer, so every output is required"));
                } else {
                    outputs.push(Output { name, slot });
                }
            }
            Err(error) => problems.push(Diagnostic::new(MACHINE_FILE, &key, error)),
        }
    }

    let next = match raw.next {
        None => Vec::new(),
        Some(OneOrMany::One(target)) => vec![target],
        Some(OneOrMany::Many(targets)) => targets,
    };
    let route = raw
        .route
        .and_then(|table| build_route(&at, table, problems));
    let max_entries = raw
        .max_entries
        .and_then(|value| bounded(value, 1, MAX_ENTRIES, &format!("{at}.max_entries"), problems));
    let retries = raw
        .retries
        .and_then(|value| bounded(value, 0, MAX_RETRIES, &format!("{at}.retries"), problems));
    let budget_ms = raw
        .budget
        .and_then(|text| duration(&text, &format!("{at}.budget"), problems));
    let failure_policy = raw
        .failure_policy
        .and_then(|text| policy(&text, &format!("{at}.failure_policy"), problems));
    let foreach = raw.foreach.and_then(|foreach| {
        bounded(
            foreach.max,
            1,
            FOREACH_MAX,
            &format!("{at}.foreach.max"),
            problems,
        )
        .map(|max| Foreach {
            over: foreach.over,
            max,
        })
    });

    let work = work?;
    (problems.len() == start).then(|| State {
        id: id.to_string(),
        entry: raw.entry,
        work,
        inputs,
        outputs,
        next,
        route,
        join: raw.join,
        max_entries,
        retries,
        budget_ms,
        failure_policy,
        foreach,
        resident: raw.resident,
    })
}

fn build_agent(
    dir: &Path,
    at: &str,
    raw: RawAgent,
    roles: &BTreeMap<String, RawRole>,
    problems: &mut Vec<Diagnostic>,
) -> Option<Agent> {
    let start = problems.len();
    let (model, thinking) = match (&raw.role, raw.model) {
        (Some(role), None) => match roles.get(role) {
            Some(found) if found.model.trim().is_empty() => {
                problems.push(Diagnostic::new(
                    MACHINE_FILE,
                    format!("roles.{role}.model"),
                    "cannot be empty",
                ));
                (None, None)
            }
            Some(found) => (
                Some(found.model.clone()),
                raw.thinking.or_else(|| found.thinking.clone()),
            ),
            None => {
                let known: Vec<&str> = roles.keys().map(String::as_str).collect();
                problems.push(Diagnostic::new(
                    MACHINE_FILE,
                    format!("{at}.agent.role"),
                    format!(
                        "unknown role {role:?} (declared: {})",
                        if known.is_empty() {
                            "none".to_string()
                        } else {
                            known.join(", ")
                        }
                    ),
                ));
                (None, None)
            }
        },
        (Some(_), Some(_)) => {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                format!("{at}.agent"),
                "name a role or a model, not both",
            ));
            (None, None)
        }
        (None, model) => (model, raw.thinking),
    };
    for (key, value) in [
        ("model", &model),
        ("thinking", &thinking),
        ("name", &raw.name),
    ] {
        if value.as_deref().is_some_and(|text| text.trim().is_empty()) {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                format!("{at}.agent.{key}"),
                "cannot be empty",
            ));
        }
    }
    if let Some(label) = &raw.name {
        if label.chars().count() > LABEL_MAX_CHARS {
            problems.push(Diagnostic::new(
                MACHINE_FILE,
                format!("{at}.agent.name"),
                format!("at most {LABEL_MAX_CHARS} characters"),
            ));
        }
    }
    if Path::new(&raw.prompt)
        .extension()
        .is_none_or(|ext| ext != "md")
    {
        problems.push(Diagnostic::new(
            MACHINE_FILE,
            format!("{at}.agent.prompt"),
            format!(
                "{:?} must be a Markdown file (prompts/<name>.md)",
                raw.prompt
            ),
        ));
    }
    let prompt = read_text_file(
        dir,
        &raw.prompt,
        &format!("{at}.agent.prompt"),
        problems,
        Presence::Required,
    );
    let rubric = raw
        .rubric
        .as_deref()
        .and_then(|file| load_rubric(dir, file, &format!("{at}.agent.rubric"), problems));
    let prompt = prompt?;
    (problems.len() == start).then_some(Agent {
        prompt_file: raw.prompt,
        prompt,
        role: raw.role,
        model,
        thinking,
        label: raw.name,
        rubric,
    })
}

fn load_rubric(dir: &Path, file: &str, at: &str, problems: &mut Vec<Diagnostic>) -> Option<Rubric> {
    let text = read_text_file(dir, file, at, problems, Presence::Required)?;
    let raw: RawRubric = match toml::from_str(&text) {
        Ok(raw) => raw,
        Err(error) => {
            problems.push(Diagnostic::new(
                file,
                "",
                error.message().trim().to_string() + &line_suffix(&text, error.span()),
            ));
            return None;
        }
    };
    if raw.rule.is_empty() {
        problems.push(Diagnostic::new(
            file,
            "",
            "a rubric needs at least one [[rule]]",
        ));
        return None;
    }
    let start = problems.len();
    let mut seen = BTreeSet::new();
    for (index, rule) in raw.rule.iter().enumerate() {
        let key = format!("rule[{index}]");
        let id_ok = rule.id.split('.').all(types::is_word);
        if !id_ok {
            problems.push(Diagnostic::new(
                file,
                format!("{key}.id"),
                format!(
                    "{:?} is not a rule id: dotted lowercase words like tests.unpinned",
                    rule.id
                ),
            ));
        } else if !seen.insert(rule.id.as_str()) {
            problems.push(Diagnostic::new(
                file,
                format!("{key}.id"),
                format!("rule {:?} appears twice", rule.id),
            ));
        }
        if rule.check.trim().is_empty() {
            problems.push(Diagnostic::new(
                file,
                format!("{key}.check"),
                "cannot be empty",
            ));
        }
        if !SEVERITIES.contains(&rule.default.as_str()) {
            problems.push(Diagnostic::new(
                file,
                format!("{key}.default"),
                format!(
                    "{:?} is not a severity: use {}",
                    rule.default,
                    SEVERITIES.join(", ")
                ),
            ));
        }
    }
    (problems.len() == start).then(|| Rubric {
        file: file.to_string(),
        rules: raw
            .rule
            .into_iter()
            .map(|rule| RubricRule {
                id: rule.id,
                check: rule.check,
                default: rule.default,
            })
            .collect(),
    })
}

fn build_python(
    dir: &Path,
    at: &str,
    target: &str,
    problems: &mut Vec<Diagnostic>,
) -> Option<PythonCall> {
    let key = format!("{at}.run");
    let Some((file, function)) = target.rsplit_once(':') else {
        problems.push(Diagnostic::new(
            MACHINE_FILE,
            &key,
            format!("{target:?} must be \"<file>.py:<function>\""),
        ));
        return None;
    };
    if Path::new(file).extension().is_none_or(|ext| ext != "py") || !is_identifier(function) {
        problems.push(Diagnostic::new(
            MACHINE_FILE,
            &key,
            format!("{target:?} must be \"<file>.py:<function>\" with a lowercase function name"),
        ));
        return None;
    }
    let stem = Path::new(file)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default();
    if !is_identifier(stem) {
        problems.push(Diagnostic::new(
            MACHINE_FILE,
            &key,
            format!("{file:?}: the file name must be an importable module name (a-z, 0-9, _)"),
        ));
        return None;
    }
    let source = read_text_file(dir, file, &key, problems, Presence::Required)?;
    let defines = source.lines().any(|line| {
        let line = line.strip_prefix("async ").unwrap_or(line);
        line.strip_prefix("def ")
            .and_then(|rest| rest.strip_prefix(function))
            .is_some_and(|rest| rest.trim_start().starts_with('('))
    });
    if !defines {
        problems.push(Diagnostic::new(
            file,
            "",
            format!("no top-level def {function}(...) in this file"),
        ));
        return None;
    }
    Some(PythonCall {
        file: file.to_string(),
        function: function.to_string(),
    })
}

fn build_route(
    at: &str,
    mut table: BTreeMap<String, String>,
    problems: &mut Vec<Diagnostic>,
) -> Option<Route> {
    let Some(on) = table.remove("on") else {
        problems.push(Diagnostic::new(
            MACHINE_FILE,
            format!("{at}.route"),
            "a route needs on = \"<output>\" (or \"<output>.<field>\")",
        ));
        return None;
    };
    let (port, field) = match on.split_once('.') {
        Some((port, field)) => (port.to_string(), Some(field.to_string())),
        None => (on, None),
    };
    if table.is_empty() {
        problems.push(Diagnostic::new(
            MACHINE_FILE,
            format!("{at}.route"),
            "a route needs at least one <value> = \"<state>\" arm",
        ));
        return None;
    }
    Some(Route {
        port,
        field,
        arms: table.into_iter().collect(),
    })
}

/// The slot a route switches on, when it names a real output (and field).
pub(crate) fn routed_slot<'a>(
    state: &'a State,
    route: &Route,
    records: &'a Records,
) -> Result<&'a Slot, String> {
    let output = state
        .output(&route.port)
        .ok_or_else(|| format!("route on {:?}: this state has no such output", route.port))?;
    let Some(field) = &route.field else {
        return Ok(&output.slot);
    };
    let Type::Record(record) = &output.slot.ty else {
        return Err(format!(
            "route on {}.{field}: {} is not a record",
            route.port, route.port
        ));
    };
    records
        .fields(record)
        .and_then(|fields| fields.iter().find(|(name, _)| name == field))
        .map(|(_, slot)| slot)
        .ok_or_else(|| {
            format!(
                "route on {}.{field}: a {record} has no field {field:?}",
                route.port
            )
        })
}

#[cfg(test)]
pub(crate) mod tests;
