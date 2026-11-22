//! The loaded, checked form of a machine directory.

use std::fmt;
use std::path::PathBuf;

use serde_json::Value;

use crate::types::{Records, Slot, Type};

/// The format version this build reads and writes (`format = 1`).
pub const FORMAT_VERSION: i64 = 1;

/// One machine directory after loading and validation.
#[derive(Debug, Clone, PartialEq)]
pub struct Machine {
    pub dir: PathBuf,
    pub name: String,
    pub version: u64,
    pub description: String,
    pub author: Option<String>,
    pub params: Vec<Param>,
    pub run: RunSettings,
    pub records: Records,
    /// `prompts/_context.md`, prepended to every agent state's prompt.
    pub context: Option<String>,
    /// States in the order the file declares them.
    pub states: Vec<State>,
}

impl Machine {
    /// The files a reader inspects for each state, relative to the machine
    /// dir: an agent state's shared context, prompt, and rubric; a python
    /// state's module.
    #[must_use]
    pub fn state_files(&self) -> Vec<(String, Vec<String>)> {
        self.states
            .iter()
            .map(|state| {
                let files = match &state.work {
                    Work::Agent(agent) => {
                        let mut files = Vec::new();
                        if self.context.is_some() {
                            files.push(crate::load::CONTEXT_FILE.to_string());
                        }
                        files.push(agent.prompt_file.clone());
                        if let Some(rubric) = &agent.rubric {
                            files.push(rubric.file.clone());
                        }
                        files
                    }
                    Work::Python(call) => vec![call.file.clone()],
                };
                (state.id.clone(), files)
            })
            .collect()
    }

    #[must_use]
    pub fn state(&self, id: &str) -> Option<&State> {
        self.states.iter().find(|state| state.id == id)
    }

    #[must_use]
    pub fn param(&self, name: &str) -> Option<&Param> {
        self.params.iter().find(|param| param.name == name)
    }
}

/// A value given when a live machine starts.
#[derive(Debug, Clone, PartialEq)]
pub struct Param {
    pub name: String,
    pub ty: Type,
    /// Absent means the param is required at start.
    pub default: Option<Value>,
    pub description: Option<String>,
}

/// Machine-wide bounds; absent fields take the executor's defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunSettings {
    pub budget_ms: Option<u64>,
    pub max_parallel: Option<u64>,
    pub max_children: Option<u64>,
    pub max_transitions: Option<u64>,
    pub failure_policy: Option<FailurePolicy>,
}

/// What a failed entry does to its live machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailurePolicy {
    FailFast,
    Continue,
    Escalate,
}

impl FailurePolicy {
    pub(crate) const NAMES: [&'static str; 3] = ["fail_fast", "continue", "escalate"];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FailFast => "fail_fast",
            Self::Continue => "continue",
            Self::Escalate => "escalate",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Self> {
        match text {
            "fail_fast" => Some(Self::FailFast),
            "continue" => Some(Self::Continue),
            "escalate" => Some(Self::Escalate),
            _ => None,
        }
    }
}

/// One state of the machine.
#[derive(Debug, Clone, PartialEq)]
pub struct State {
    pub id: String,
    pub entry: bool,
    pub work: Work,
    pub inputs: Vec<Input>,
    pub outputs: Vec<Output>,
    /// Unconditional successors (a list fans out).
    pub next: Vec<String>,
    /// A switch on one enum or bool port.
    pub route: Option<Route>,
    /// The states this one waits for; each names this state in `next`.
    pub join: Vec<String>,
    pub max_entries: Option<u64>,
    pub retries: Option<u64>,
    pub budget_ms: Option<u64>,
    pub failure_policy: Option<FailurePolicy>,
    pub foreach: Option<Foreach>,
    /// Stays alive under the parent session after the live machine ends.
    pub resident: bool,
}

impl State {
    #[must_use]
    pub fn output(&self, name: &str) -> Option<&Output> {
        self.outputs.iter().find(|output| output.name == name)
    }

    #[must_use]
    pub fn input(&self, name: &str) -> Option<&Input> {
        self.inputs.iter().find(|input| input.name == name)
    }
}

/// What a state runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Work {
    Agent(Agent),
    Python(PythonCall),
}

/// A spawned child agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agent {
    /// The prompt file, relative to the machine dir.
    pub prompt_file: String,
    pub prompt: String,
    /// The `[roles]` entry the model came from, when one was named.
    pub role: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    /// The child's label; defaults to the executor's generated one.
    pub label: Option<String>,
    pub rubric: Option<Rubric>,
}

/// A plain Python function in the machine dir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PythonCall {
    /// The `.py` file, relative to the machine dir.
    pub file: String,
    pub function: String,
}

/// One input binding: `name = "state.port"` (`?` when optional).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Input {
    pub name: String,
    pub state: String,
    pub port: String,
    pub optional: bool,
}

impl fmt::Display for Input {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mark = if self.optional { "?" } else { "" };
        write!(f, "{}.{}{mark}", self.state, self.port)
    }
}

/// One declared output port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    pub name: String,
    pub slot: Slot,
}

/// `route = { on = "port" | "port.field", <value> = "<state>", ... }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub port: String,
    pub field: Option<String>,
    /// (value, target) in the routed type's value order.
    pub arms: Vec<(String, String)>,
}

/// One child per item of a list input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Foreach {
    pub over: String,
    pub max: u64,
}

/// Judging criteria from a rubric file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rubric {
    pub file: String,
    pub rules: Vec<RubricRule>,
}

/// One rubric rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RubricRule {
    pub id: String,
    pub check: String,
    /// The severity a finding under this rule carries unless argued otherwise.
    pub default: String,
}

/// One problem found while loading, validating, or compiling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    /// The file, relative to the machine dir (`machine.toml`, `prompts/x.md`).
    pub file: String,
    /// The key path inside it, or empty.
    pub at: String,
    pub message: String,
}

impl Diagnostic {
    pub(crate) fn new(file: &str, at: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            file: file.to_string(),
            at: at.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.at.is_empty() {
            write!(f, "{}: {}", self.file, self.message)
        } else {
            write!(f, "{}: {}: {}", self.file, self.at, self.message)
        }
    }
}
