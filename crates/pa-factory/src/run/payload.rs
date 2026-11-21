//! Payloads: the typed input record of one state entry.
//!
//! Each input of a state is a [`Binding`]: a name, a port type, and a
//! [`Selector`] that names a parent output. [`plan_payloads`] reads every
//! binding of a canonical spec before the run starts. A reference to a
//! state or a port that does not exist fails there, with the port named.
//! At run time, [`PayloadPlan::bind`] copies the selected values into a
//! [`Payload`]. The values stay typed JSON. No value goes through a text
//! template.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde_json::{Map, Value};

use super::selector::{Selection, Selector, SelectorError, Settle, Unavailable};

/// The type of an input or output port in a canonical spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortType {
    Text,
    Json,
}

impl PortType {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "text" => Some(Self::Text),
            "json" => Some(Self::Json),
            _ => None,
        }
    }
}

impl fmt::Display for PortType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Text => "text",
            Self::Json => "json",
        })
    }
}

/// One input of a state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub name: String,
    pub ty: PortType,
    pub selector: Selector,
    /// An optional input binds `null` when its source has no value.
    pub optional: bool,
}

/// One child for each item of a list input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FanOut {
    pub over: String,
    pub max: u64,
}

/// The checked inputs of one state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadPlan {
    state: String,
    bindings: Vec<Binding>,
    foreach: Option<FanOut>,
}

/// The view of one source state that [`PayloadPlan::bind`] reads.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SourceView<'a> {
    /// The settled entries, oldest first.
    pub settles: &'a [Settle],
    /// True when an entry of the source is pending or running.
    pub live: bool,
}

/// The result of [`PayloadPlan::bind`].
#[derive(Debug, Clone, PartialEq)]
pub enum Bind {
    /// A source has not settled yet. The entry stays pending.
    Wait,
    Ready(Payload),
    /// The entry fails. A binding failure does not retry, because the
    /// same settles give the same failure.
    Failed(BindError),
}

/// The bound inputs of one state entry.
#[derive(Debug, Clone, PartialEq)]
pub struct Payload {
    /// One field for each input that is not the foreach input.
    pub fields: Map<String, Value>,
    /// The foreach input and its items, when the state fans out.
    pub fan: Option<(FanOut, Vec<Value>)>,
}

impl Payload {
    /// One record for each child. Without foreach, this is one record:
    /// the fields. With foreach, each of the first `max` items gives one
    /// record: the fields and the item at the foreach input.
    #[must_use]
    pub fn records(&self) -> Vec<Map<String, Value>> {
        let Some((foreach, items)) = &self.fan else {
            return vec![self.fields.clone()];
        };
        items
            .iter()
            .take(usize::try_from(foreach.max).unwrap_or(usize::MAX))
            .map(|item| {
                let mut record = self.fields.clone();
                record.insert(foreach.over.clone(), item.clone());
                record
            })
            .collect()
    }

    /// The items after the first `max`. No child receives them.
    #[must_use]
    pub fn dropped(&self) -> usize {
        self.fan.as_ref().map_or(0, |(foreach, items)| {
            items
                .len()
                .saturating_sub(usize::try_from(foreach.max).unwrap_or(usize::MAX))
        })
    }
}

impl PayloadPlan {
    #[must_use]
    pub fn state(&self) -> &str {
        &self.state
    }

    #[must_use]
    pub fn bindings(&self) -> &[Binding] {
        &self.bindings
    }

    /// Bind each input from the latest settle of its source.
    ///
    /// A required input waits until its source settles. An optional input
    /// binds `null` when its source has no value, but it waits when its
    /// source is another state that is live. An optional foreach input
    /// with no value binds no items. A required input whose source
    /// settled with no value fails the entry.
    pub fn bind<'a>(&self, source: impl Fn(&str) -> SourceView<'a>) -> Bind {
        let mut fields = Map::new();
        let mut fan = None;
        for binding in &self.bindings {
            let view = source(&binding.selector.state);
            let over = self
                .foreach
                .as_ref()
                .filter(|foreach| foreach.over == binding.name);
            let value = match binding.selector.select(view.settles) {
                Selection::Value(value) => value,
                Selection::NotSettled
                    if binding.optional && view.live && binding.selector.state != self.state =>
                {
                    return Bind::Wait;
                }
                Selection::NotSettled | Selection::Unavailable(_) if binding.optional => {
                    match over {
                        Some(foreach) => fan = Some((foreach.clone(), Vec::new())),
                        None => {
                            fields.insert(binding.name.clone(), Value::Null);
                        }
                    }
                    continue;
                }
                Selection::NotSettled => return Bind::Wait,
                Selection::Unavailable(reason) => {
                    return Bind::Failed(BindError {
                        input: binding.name.clone(),
                        selector: binding.selector.clone(),
                        failure: BindFailure::Unavailable(reason),
                    });
                }
            };
            if let Some(foreach) = over {
                let Value::Array(items) = value else {
                    return Bind::Failed(BindError {
                        input: binding.name.clone(),
                        selector: binding.selector.clone(),
                        failure: BindFailure::NotAList,
                    });
                };
                fan = Some((foreach.clone(), items.clone()));
                continue;
            }
            let value = match (binding.ty, value) {
                (PortType::Text, Value::String(_)) | (PortType::Json, _) => value.clone(),
                (PortType::Text, other) => Value::String(other.to_string()),
            };
            fields.insert(binding.name.clone(), value);
        }
        Bind::Ready(Payload { fields, fan })
    }
}

/// Why [`PayloadPlan::bind`] failed an entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindError {
    pub input: String,
    pub selector: Selector,
    pub failure: BindFailure,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindFailure {
    Unavailable(Unavailable),
    /// The foreach input is not a JSON list.
    NotAList,
}

impl fmt::Display for BindError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self {
            input,
            selector,
            failure,
        } = self;
        match failure {
            BindFailure::Unavailable(reason) => {
                write!(
                    f,
                    "input {input:?} from {selector} is unavailable: {reason}"
                )
            }
            BindFailure::NotAList => {
                write!(
                    f,
                    "foreach input {input:?} from {selector} is not a JSON list"
                )
            }
        }
    }
}

/// Read and check the inputs of every state of a canonical spec, by
/// state id.
///
/// # Errors
///
/// Returns every [`PlanError`] in the spec.
pub fn plan_payloads(spec: &Value) -> Result<BTreeMap<String, PayloadPlan>, Vec<PlanError>> {
    let states: Vec<&Value> = spec
        .get("states")
        .and_then(Value::as_array)
        .map(|states| states.iter().collect())
        .unwrap_or_default();
    let by_id: BTreeMap<&str, &Value> = states
        .iter()
        .filter_map(|state| Some((state.get("id")?.as_str()?, *state)))
        .collect();
    let mut plans = BTreeMap::new();
    let mut errors = Vec::new();
    for (id, state) in &by_id {
        let mut problem = |input: &str, problem: PlanProblem| {
            errors.push(PlanError {
                state: (*id).to_string(),
                input: input.to_string(),
                problem,
            });
        };
        let mut bindings = Vec::new();
        let mut names = BTreeSet::new();
        for raw in port_list(state, "inputs") {
            let name = raw.get("name").and_then(Value::as_str).unwrap_or_default();
            match read_binding(raw, &by_id) {
                Err(found) => problem(name, found),
                Ok(_) if !names.insert(name) => problem(name, PlanProblem::DuplicateInput),
                Ok(binding) => bindings.push(binding),
            }
        }
        let foreach = state.get("foreach").map(|foreach| FanOut {
            over: foreach
                .get("over")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            max: foreach.get("max").and_then(Value::as_u64).unwrap_or(0),
        });
        if let Some(foreach) = &foreach {
            let over_json = bindings
                .iter()
                .any(|binding| binding.name == foreach.over && binding.ty == PortType::Json);
            if !over_json {
                problem(&foreach.over, PlanProblem::ForeachOver);
            }
        }
        plans.insert(
            (*id).to_string(),
            PayloadPlan {
                state: (*id).to_string(),
                bindings,
                foreach,
            },
        );
    }
    if errors.is_empty() {
        Ok(plans)
    } else {
        Err(errors)
    }
}

fn port_list<'a>(state: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    state
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn read_binding(raw: &Value, by_id: &BTreeMap<&str, &Value>) -> Result<Binding, PlanProblem> {
    let malformed = |what: &str| PlanProblem::Malformed(what.to_string());
    let name = raw
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| malformed("the input has no name"))?;
    let ty = raw
        .get("type")
        .and_then(Value::as_str)
        .and_then(PortType::parse)
        .ok_or_else(|| malformed("the type is not \"text\" or \"json\""))?;
    let optional = match raw.get("optional") {
        None => false,
        Some(Value::Bool(optional)) => *optional,
        Some(_) => return Err(malformed("optional is not a boolean")),
    };
    let reference = raw
        .get("from")
        .and_then(Value::as_str)
        .ok_or_else(|| malformed("from is not text"))?;
    let selector = Selector::parse(reference).map_err(PlanProblem::Selector)?;
    let source = by_id
        .get(selector.state.as_str())
        .ok_or_else(|| PlanProblem::UnknownState(selector.state.clone()))?;
    if source.get("lifecycle").and_then(Value::as_str) == Some("resident") {
        return Err(PlanProblem::ResidentSource(selector.state));
    }
    let output = port_list(source, "outputs")
        .find(|output| output.get("name").and_then(Value::as_str) == Some(&selector.port))
        .ok_or_else(|| PlanProblem::MissingPort(selector.clone()))?;
    let output_ty = output
        .get("type")
        .and_then(Value::as_str)
        .and_then(PortType::parse)
        .unwrap_or(PortType::Text);
    if output_ty != ty {
        return Err(PlanProblem::TypeMismatch {
            selector,
            input: ty,
            output: output_ty,
        });
    }
    Ok(Binding {
        name: name.to_string(),
        ty,
        selector,
        optional,
    })
}

/// One input that a run cannot bind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanError {
    pub state: String,
    pub input: String,
    pub problem: PlanProblem,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanProblem {
    /// A field of the input has the wrong shape.
    Malformed(String),
    DuplicateInput,
    Selector(SelectorError),
    UnknownState(String),
    /// A resident state does not settle, so no input can read it.
    ResidentSource(String),
    /// The source state does not declare the port.
    MissingPort(Selector),
    TypeMismatch {
        selector: Selector,
        input: PortType,
        output: PortType,
    },
    /// The foreach input is not a json input of the state.
    ForeachOver,
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self {
            state,
            input,
            problem,
        } = self;
        write!(f, "state {state:?} input {input:?}: ")?;
        match problem {
            PlanProblem::Malformed(what) => f.write_str(what),
            PlanProblem::DuplicateInput => f.write_str("the state declares this input twice"),
            PlanProblem::Selector(error) => write!(f, "{error}"),
            PlanProblem::UnknownState(source) => write!(f, "{source:?} names no state"),
            PlanProblem::ResidentSource(source) => {
                write!(f, "cannot read from resident state {source:?}")
            }
            PlanProblem::MissingPort(selector) => write!(
                f,
                "state {:?} does not declare output {:?}",
                selector.state, selector.port
            ),
            PlanProblem::TypeMismatch {
                selector,
                input: ty,
                output,
            } => write!(f, "a {ty} input cannot read the {output} output {selector}"),
            PlanProblem::ForeachOver => {
                f.write_str("foreach.over is not a json input of this state")
            }
        }
    }
}

impl std::error::Error for PlanError {}

#[cfg(test)]
mod tests;
