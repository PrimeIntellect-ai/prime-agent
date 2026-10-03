//! System 1 / System 2 harness router: the run-spec types, the environment
//! contract, and the trace/result shapes. Rust port of
//! `packages/coding-agent/src/core/system-router/types.ts` (#2484).
//!
//! The session model (System 2) declares an environment with a finite action
//! space and a System 1 action model. The router then runs the action-only
//! step loop: observe -> decide (ONE model call per step, thinking off,
//! single choice from the declared action space + confidence) -> gate ->
//! execute -> record. System 2 steers between segments: it sets or updates
//! the goal, reviews the returned trace, and re-invokes the router with a
//! new goal or thresholds.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

use serde::Serialize;
use serde_json::Value;

pub const DEFAULT_ROUTER_MAX_STEPS: u32 = 25;
pub const MAX_ROUTER_STEPS: u32 = 200;
pub const DEFAULT_ROUTER_TIMEOUT_MS: u64 = 120_000;
pub const MAX_ROUTER_TIMEOUT_MS: u64 = 600_000;
pub const DEFAULT_ROUTER_HISTORY_STEPS: u32 = 8;
pub const MAX_ROUTER_HISTORY_STEPS: u32 = 32;
pub const DEFAULT_ROUTER_OBSERVATION_CHARS: u32 = 6_000;
pub const MAX_ROUTER_OBSERVATION_CHARS: u32 = 32_000;
pub const DEFAULT_ROUTER_ENV_REQUEST_TIMEOUT_MS: u64 = 30_000;
pub const MAX_ROUTER_ENV_REQUEST_TIMEOUT_MS: u64 = 120_000;

/// The loop-owned terminal actions, reserved in any declared action space.
pub const FINISH_ACTION: &str = "finish";
/// The loop-owned escalation action, reserved in any declared action space.
pub const ESCALATE_ACTION: &str = "escalate";

/// Confidence gate thresholds per risk level (the `SystemOneHarness` defaults).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ResolvedGate {
    pub read: f64,
    pub write: f64,
    pub destructive: f64,
    pub finish: f64,
}

/// The `SystemOneHarness` default gate thresholds.
#[must_use]
pub fn default_router_gate() -> ResolvedGate {
    ResolvedGate {
        read: 0.5,
        write: 0.6,
        destructive: 0.8,
        finish: 0.5,
    }
}

/// The risk class of a declared action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouterActionRisk {
    Read,
    Write,
    Destructive,
}

impl RouterActionRisk {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            RouterActionRisk::Read => "read",
            RouterActionRisk::Write => "write",
            RouterActionRisk::Destructive => "destructive",
        }
    }
}

/// A finite parameter: every allowed value with a one-line description.
#[derive(Debug, Clone, PartialEq)]
pub struct RouterActionParamSpec {
    pub choices: BTreeMap<String, String>,
}

/// One declared action: what it does, its risk, and its finite parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct RouterActionSpec {
    /// What executing this action does. The action model reads this verbatim.
    pub description: String,
    pub risk: RouterActionRisk,
    pub params: BTreeMap<String, RouterActionParamSpec>,
}

/// A partial gate spec as declared by the caller (absent keys take defaults).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RouterGateSpec {
    pub read: Option<f64>,
    pub write: Option<f64>,
    pub destructive: Option<f64>,
    pub finish: Option<f64>,
}

/// Resolve a partial gate spec against the defaults.
#[must_use]
pub fn resolve_gate(spec: RouterGateSpec) -> ResolvedGate {
    let defaults = default_router_gate();
    ResolvedGate {
        read: spec.read.unwrap_or(defaults.read),
        write: spec.write.unwrap_or(defaults.write),
        destructive: spec.destructive.unwrap_or(defaults.destructive),
        finish: spec.finish.unwrap_or(defaults.finish),
    }
}

/// The stdio adapter spec: the command, its cwd, its per-request timeout, and
/// the opaque init payload forwarded to the adapter.
#[derive(Debug, Clone, PartialEq)]
pub struct RouterStdioEnvironmentSpec {
    /// Adapter command. The first element is the executable, the rest args.
    pub command: Vec<String>,
    /// Working directory for the adapter process.
    pub cwd: Option<String>,
    /// Per-request adapter timeout in milliseconds.
    pub request_timeout_ms: u64,
    /// Initialisation payload forwarded to the adapter (e.g. ROM path).
    pub init: Option<Value>,
}

/// The environment spec: v1 only declares a stdio adapter.
#[derive(Debug, Clone, PartialEq)]
pub struct RouterEnvironmentSpec {
    pub stdio: RouterStdioEnvironmentSpec,
}

/// A validated run spec: budgets are always concrete numbers after parsing.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSystemRouterRunSpec {
    pub goal: String,
    /// Declared finite action space. `None` when the environment supplies it.
    pub actions: Option<BTreeMap<String, RouterActionSpec>>,
    pub environment: RouterEnvironmentSpec,
    /// System 1 action-model selector.
    pub model: Option<String>,
    pub max_steps: u32,
    pub timeout_ms: u64,
    pub history_steps: u32,
    pub observation_chars: u32,
    pub gate: RouterGateSpec,
}

/// What the environment reports to the loop each step.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RouterObservation {
    /// Legible state summary.
    pub text: String,
    /// Structured scalars rendered as `key: value` lines after the text.
    pub fields: BTreeMap<String, Value>,
    /// Base64 PNG screenshot, included only when the action model takes images.
    pub image: Option<String>,
    pub terminal: bool,
}

/// What the environment reports after executing an action.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RouterExecution {
    pub text: String,
    pub terminal: bool,
}

/// Options for stopping an adapter: `budget_ms` bounds the graceful wait.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RouterCloseOptions {
    pub budget_ms: Option<u64>,
}

/// The environment adapter contract: reset, observe, execute, close.
pub trait RouterEnvironment: Send + Sync {
    fn reset<'a>(
        &'a self,
        goal: &'a str,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>>;

    fn observe<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<RouterObservation>> + Send + 'a>>;

    fn execute<'a>(
        &'a self,
        action: &'a str,
        params: &'a BTreeMap<String, String>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<RouterExecution>> + Send + 'a>>;

    /// Stop the adapter; cleanup never fails the run.
    fn close<'a>(
        &'a self,
        options: RouterCloseOptions,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}

/// The environment the segment runner needs: the loop contract plus init.
pub trait RouterSegmentEnvironment: RouterEnvironment {
    /// Initialize the adapter and return its environment info (default action
    /// space) when it supplies one.
    fn init<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Option<Value>>> + Send + 'a>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RouterGateVerdict {
    Pass,
    Refused,
    ParseFailure,
}

/// One recorded step: observation digest, action, gate verdict, result, usage.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterStepTrace {
    /// 0-based decision index.
    pub step: usize,
    pub timestamp_ms: u64,
    /// Model round-trip milliseconds.
    pub latency_ms: u64,
    pub action: Option<String>,
    pub params: BTreeMap<String, String>,
    pub confidence: Option<f64>,
    pub gate: RouterGateTrace,
    /// fnv1a (32-bit) digest of the observation for repeated-state detection.
    pub observation_digest: String,
    pub observation_chars: usize,
    /// Execution result text or the refusal reason.
    pub result: String,
    pub terminal: bool,
    pub thinking_level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<RouterUsage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct RouterGateTrace {
    pub threshold: f64,
    pub verdict: RouterGateVerdict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RouterRunStatus {
    Done,
    Incomplete,
    Stuck,
    Failed,
    Escalated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl RouterUsage {
    pub fn add(&mut self, other: RouterUsage) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
    }
}

/// The model the System 1 decision calls ran on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterModelInfo {
    pub provider: String,
    pub id: String,
    pub thinking_level: String,
}

/// The complete trace of one bounded segment.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemRouterRunResult {
    pub status: RouterRunStatus,
    /// Machine-readable terminal reason (e.g. `environment_terminal`).
    pub reason: String,
    /// Trace entries recorded this segment (executed + refused + terminal).
    pub steps: usize,
    pub executed: u64,
    pub refused: u64,
    pub trace: Vec<RouterStepTrace>,
    /// Harness-rendered terminal sentence; never the model's own words.
    pub summary: String,
    pub model: RouterModelInfo,
    pub usage: RouterUsage,
}

fn as_string(value: &Value, what: &str) -> anyhow::Result<String> {
    match value.as_str() {
        Some(text) if !text.trim().is_empty() => Ok(text.to_string()),
        _ => anyhow::bail!("system_router.run {what} must be a non-empty string"),
    }
}

/// Whether a JSON number is a whole number in `[1, max]` (the TS
/// `Number.isInteger` + range check): returns the value when it is.
#[allow(clippy::float_cmp)] // whole-number check by design: `fract() == 0.0` is the predicate
fn whole_number(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 {
        return None;
    }
    if number < 1.0 {
        return None;
    }
    Some(number as u64)
}

fn as_port_number(
    value: Option<&Value>,
    what: &str,
    fallback: u64,
    max: u64,
) -> anyhow::Result<u64> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    match whole_number(value) {
        Some(number) if number <= max => Ok(number),
        _ => anyhow::bail!("system_router.run {what} must be a whole number in [1, {max}]"),
    }
}

fn parse_risk(value: Option<&Value>, what: &str) -> anyhow::Result<RouterActionRisk> {
    let Some(value) = value else {
        return Ok(RouterActionRisk::Write);
    };
    match value.as_str() {
        Some("read") => Ok(RouterActionRisk::Read),
        Some("write") => Ok(RouterActionRisk::Write),
        Some("destructive") => Ok(RouterActionRisk::Destructive),
        _ => anyhow::bail!(r#"system_router.run {what} must be "read", "write", or "destructive""#),
    }
}

/// The `snake_case` action/param name rule (`^[a-z0-9_]{1,32}$`).
fn is_snake_case_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// Parse the declared action space. `None` is not accepted here: callers use
/// [`parse_environment_actions`] for the omit-then-inherit case.
///
/// # Errors
///
/// Returns an error when the value is not a non-empty object of valid action
/// declarations (reserved names, malformed params, empty choice sets).
pub fn parse_action_space(value: &Value) -> anyhow::Result<BTreeMap<String, RouterActionSpec>> {
    let Some(record) = value.as_object() else {
        anyhow::bail!(
            "system_router.run actions must be a non-empty object of actions, or omitted when the environment supplies its own"
        );
    };
    if record.is_empty() {
        anyhow::bail!(
            "system_router.run actions must be a non-empty object of actions, or omitted when the environment supplies its own"
        );
    }
    let mut actions: BTreeMap<String, RouterActionSpec> = BTreeMap::new();
    for (name, raw) in record {
        if !is_snake_case_name(name) {
            anyhow::bail!(
                "system_router.run action name \"{name}\" must be lowercase snake_case (max 32 chars)"
            );
        }
        if name == "__proto__" {
            anyhow::bail!("system_router.run action name \"{name}\" is reserved");
        }
        if name == FINISH_ACTION || name == ESCALATE_ACTION {
            anyhow::bail!(
                "system_router.run action name \"{name}\" is reserved for the loop itself"
            );
        }
        let Some(raw) = raw.as_object() else {
            anyhow::bail!("system_router.run action \"{name}\" must be an object");
        };
        let Some(description) = raw.get("description") else {
            anyhow::bail!(
                "system_router.run action \"{name}\" description must be a non-empty string"
            );
        };
        let description = as_string(description, &format!("action \"{name}\" description"))?;
        let risk = parse_risk(raw.get("risk"), &format!("action \"{name}\" risk"))?;
        let mut params: BTreeMap<String, RouterActionParamSpec> = BTreeMap::new();
        if let Some(raw_params) = raw.get("params") {
            let Some(raw_params) = raw_params.as_object() else {
                anyhow::bail!(
                    "system_router.run action \"{name}\" params must be an object when provided"
                );
            };
            for (param_name, raw_param) in raw_params {
                if !is_snake_case_name(param_name) {
                    anyhow::bail!(
                        "system_router.run action \"{name}\" param name \"{param_name}\" must be lowercase snake_case (max 32 chars)"
                    );
                }
                if param_name == "__proto__" {
                    anyhow::bail!(
                        "system_router.run action \"{name}\" param name \"{param_name}\" is reserved"
                    );
                }
                let choices = raw_param
                    .as_object()
                    .and_then(|raw_param| raw_param.get("choices"))
                    .and_then(Value::as_object);
                let Some(choices) = choices.filter(|choices| !choices.is_empty()) else {
                    anyhow::bail!(
                        "system_router.run action \"{name}\" param \"{param_name}\" must declare a non-empty finite choices set"
                    );
                };
                let mut parsed_choices: BTreeMap<String, String> = BTreeMap::new();
                for (choice, description) in choices {
                    let Some(description) = description.as_str() else {
                        anyhow::bail!(
                            "system_router.run action \"{name}\" param \"{param_name}\" choice \"{choice}\" needs a non-empty description"
                        );
                    };
                    if description.trim().is_empty() {
                        anyhow::bail!(
                            "system_router.run action \"{name}\" param \"{param_name}\" choice \"{choice}\" needs a non-empty description"
                        );
                    }
                    if choice.is_empty() {
                        anyhow::bail!(
                            "system_router.run action \"{name}\" param \"{param_name}\" has an empty choice value"
                        );
                    }
                    parsed_choices.insert(choice.clone(), description.to_string());
                }
                params.insert(
                    param_name.clone(),
                    RouterActionParamSpec {
                        choices: parsed_choices,
                    },
                );
            }
        }
        actions.insert(
            name.clone(),
            RouterActionSpec {
                description,
                risk,
                params,
            },
        );
    }
    Ok(actions)
}

/// Resolve the run's action space: the spec's declaration wins; the
/// environment's supplied defaults are parsed and validated otherwise.
///
/// # Errors
///
/// Returns an error when a supplied (environment) action space is malformed.
pub fn parse_environment_actions(
    declared: Option<&BTreeMap<String, RouterActionSpec>>,
    supplied: Option<&Value>,
) -> anyhow::Result<Option<BTreeMap<String, RouterActionSpec>>> {
    if let Some(declared) = declared {
        return Ok(Some(declared.clone()));
    }
    match supplied {
        None => Ok(None),
        Some(value) => Ok(Some(parse_action_space(value)?)),
    }
}

fn parse_gate(value: Option<&Value>) -> anyhow::Result<RouterGateSpec> {
    let Some(value) = value else {
        return Ok(RouterGateSpec::default());
    };
    let Some(record) = value.as_object() else {
        anyhow::bail!("system_router.run gate must be an object when provided");
    };
    let mut gate = RouterGateSpec::default();
    for (risk, slot) in [
        ("read", &mut gate.read),
        ("write", &mut gate.write),
        ("destructive", &mut gate.destructive),
        ("finish", &mut gate.finish),
    ] {
        if let Some(threshold) = record.get(risk) {
            let Some(number) = threshold.as_f64() else {
                anyhow::bail!("system_router.run gate.{risk} must be a number in [0, 1]");
            };
            if !number.is_finite() || !(0.0..=1.0).contains(&number) {
                anyhow::bail!("system_router.run gate.{risk} must be a number in [0, 1]");
            }
            *slot = Some(number);
        }
    }
    Ok(gate)
}

/// Parse and validate an untrusted `system_router.run` payload into a run spec.
///
/// # Errors
///
/// Returns an error when the payload is not an object or any field is
/// malformed (goal, environment, action space, gate, model, budgets).
pub fn parse_system_router_run_spec(payload: &Value) -> anyhow::Result<ParsedSystemRouterRunSpec> {
    let Some(payload) = payload.as_object() else {
        anyhow::bail!("system_router.run payload must be an object");
    };
    let Some(goal) = payload.get("goal") else {
        anyhow::bail!("system_router.run goal must be a non-empty string");
    };
    let goal = as_string(goal, "goal")?;
    let Some(environment) = payload.get("environment").and_then(Value::as_object) else {
        anyhow::bail!("system_router.run environment must be an object with a stdio adapter");
    };
    let Some(stdio) = environment.get("stdio").and_then(Value::as_object) else {
        anyhow::bail!("system_router.run environment must be an object with a stdio adapter");
    };
    let Some(command) = stdio.get("command").and_then(Value::as_array) else {
        anyhow::bail!(
            "system_router.run environment.stdio.command must be a non-empty string array"
        );
    };
    if command.is_empty() {
        anyhow::bail!(
            "system_router.run environment.stdio.command must be a non-empty string array"
        );
    }
    let mut parts = Vec::with_capacity(command.len());
    for part in command {
        match part.as_str() {
            Some(text) if !text.trim().is_empty() => parts.push(text.trim().to_string()),
            _ => anyhow::bail!(
                "system_router.run environment.stdio.command must be a non-empty string array"
            ),
        }
    }
    let cwd = match stdio.get("cwd") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "system_router.run environment.stdio.cwd must be a string when provided"
                    )
                })?
                .to_string(),
        ),
    };
    let request_timeout_ms = as_port_number(
        stdio.get("requestTimeoutMs"),
        "environment.stdio.requestTimeoutMs",
        DEFAULT_ROUTER_ENV_REQUEST_TIMEOUT_MS,
        MAX_ROUTER_ENV_REQUEST_TIMEOUT_MS,
    )?;
    let init = stdio.get("init").cloned();
    let actions = match payload.get("actions") {
        None | Some(Value::Null) => None,
        Some(value) => Some(parse_action_space(value)?),
    };
    let gate = parse_gate(payload.get("gate"))?;
    let model = match payload.get("model") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let text = value
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "system_router.run model must be a non-empty string when provided"
                    )
                })?;
            Some(text.trim().to_string())
        }
    };
    Ok(ParsedSystemRouterRunSpec {
        goal,
        actions,
        environment: RouterEnvironmentSpec {
            stdio: RouterStdioEnvironmentSpec {
                command: parts,
                cwd,
                request_timeout_ms,
                init,
            },
        },
        model,
        max_steps: as_port_number(
            payload.get("maxSteps"),
            "maxSteps",
            u64::from(DEFAULT_ROUTER_MAX_STEPS),
            u64::from(MAX_ROUTER_STEPS),
        )? as u32,
        timeout_ms: as_port_number(
            payload.get("timeoutMs"),
            "timeoutMs",
            DEFAULT_ROUTER_TIMEOUT_MS,
            MAX_ROUTER_TIMEOUT_MS,
        )?,
        history_steps: as_port_number(
            payload.get("historySteps"),
            "historySteps",
            u64::from(DEFAULT_ROUTER_HISTORY_STEPS),
            u64::from(MAX_ROUTER_HISTORY_STEPS),
        )? as u32,
        observation_chars: as_port_number(
            payload.get("observationChars"),
            "observationChars",
            u64::from(DEFAULT_ROUTER_OBSERVATION_CHARS),
            u64::from(MAX_ROUTER_OBSERVATION_CHARS),
        )? as u32,
        gate,
    })
}

// The unit battery lives in the child module (types::tests).
#[cfg(test)]
mod tests;
