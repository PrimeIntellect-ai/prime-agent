//! The transitions of a canonical spec and their guards.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::{Map, Value};

/// The states a transition starts from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sources {
    /// The transition fires when this state settles.
    One(String),
    /// A join: the transition fires when every state settled.
    Join(Vec<String>),
}

/// An equality test on one output of the settled state: a `route` arm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guard {
    pub port: String,
    /// A dotted path into a record output (`route.on = "port.field"`).
    pub path: Option<String>,
    pub value: Value,
}

impl Guard {
    /// True when the output at the port and path exists and is equal to
    /// the value. JSON equality is strict: `true` is not equal to `1`.
    #[must_use]
    pub fn passes(&self, outputs: &Map<String, Value>) -> bool {
        let Some(mut current) = outputs.get(&self.port) else {
            return false;
        };
        if let Some(path) = &self.path {
            for part in path.split('.') {
                match current.as_object().and_then(|object| object.get(part)) {
                    Some(next) => current = next,
                    None => return false,
                }
            }
        }
        *current == self.value
    }
}

/// One transition of a canonical spec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transition {
    pub from: Sources,
    pub to: String,
    /// `None` means the transition fires on every settle.
    pub guard: Option<Guard>,
}

/// A canonical spec's transitions, with each state's outgoing transitions.
/// The position in the spec's `transitions` list is the canonical index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransitionIndex {
    all: Vec<Transition>,
    outgoing: BTreeMap<String, Vec<usize>>,
}

impl TransitionIndex {
    /// Read the `transitions` list of a canonical spec. A join is an
    /// outgoing transition of each of its sources, with one canonical
    /// index.
    ///
    /// # Errors
    ///
    /// Returns a [`SpecError`] for a transition that has no target, a
    /// join with fewer than two sources, a transition that fires on a
    /// signal other than `settled`, or a guard other than `eq`.
    pub fn from_spec(spec: &Value) -> Result<Self, SpecError> {
        let Some(Value::Array(listed)) = spec.get("transitions") else {
            return Err(SpecError("transitions is not a list".to_string()));
        };
        let mut all = Vec::with_capacity(listed.len());
        let mut outgoing: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for (index, raw) in listed.iter().enumerate() {
            let transition = parse_transition(raw)
                .map_err(|problem| SpecError(format!("transitions[{index}]: {problem}")))?;
            let sources = match &transition.from {
                Sources::One(source) => std::slice::from_ref(source),
                Sources::Join(sources) => sources.as_slice(),
            };
            for source in sources {
                outgoing.entry(source.clone()).or_default().push(index);
            }
            all.push(transition);
        }
        Ok(Self { all, outgoing })
    }

    /// The transition at a canonical index.
    #[must_use]
    pub fn get(&self, index: usize) -> Option<&Transition> {
        self.all.get(index)
    }

    /// The outgoing transitions of `state` in canonical order, with their
    /// canonical indexes.
    pub fn outgoing<'a>(&'a self, state: &str) -> impl Iterator<Item = (usize, &'a Transition)> {
        self.outgoing
            .get(state)
            .into_iter()
            .flatten()
            .map(|&index| (index, &self.all[index]))
    }
}

fn parse_transition(raw: &Value) -> Result<Transition, String> {
    let to = raw
        .get("to")
        .and_then(Value::as_str)
        .ok_or("to is not a state id")?
        .to_string();
    let from = match raw.get("from") {
        Some(Value::String(source)) => Sources::One(source.clone()),
        Some(Value::Array(sources)) if sources.len() >= 2 => Sources::Join(
            sources
                .iter()
                .map(|source| source.as_str().map(str::to_string))
                .collect::<Option<_>>()
                .ok_or("a join source is not a state id")?,
        ),
        Some(_) | None => return Err("from is not a state id or a list of two or more".into()),
    };
    if let Some(on) = raw.get("on") {
        if on != "settled" {
            return Err(format!("on {on} is not \"settled\""));
        }
    }
    let guard = raw.get("when").map(parse_guard).transpose()?;
    Ok(Transition { from, to, guard })
}

fn parse_guard(when: &Value) -> Result<Guard, String> {
    let op = when.get("op").and_then(Value::as_str);
    if op != Some("eq") {
        return Err(format!("the guard op {op:?} is not \"eq\""));
    }
    let port = when
        .get("output")
        .and_then(Value::as_str)
        .ok_or("the guard has no output")?
        .to_string();
    let path = match when.get("path") {
        None => None,
        Some(Value::String(path)) => Some(path.clone()),
        Some(_) => return Err("the guard path is not text".to_string()),
    };
    let value = when.get("value").cloned().ok_or("the guard has no value")?;
    Ok(Guard { port, path, value })
}

/// A canonical spec that the run model cannot read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecError(pub String);

impl fmt::Display for SpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SpecError {}
