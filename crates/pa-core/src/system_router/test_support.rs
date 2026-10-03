//! Test doubles shared by the system-router unit batteries: a scripted
//! environment and a scripted decision function.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::decide::{RouterDecisionFn, RouterDecisionOutcome, RouterDecisionRequest};
use super::types::{
    RouterCloseOptions, RouterEnvironment, RouterExecution, RouterObservation,
    RouterSegmentEnvironment, RouterUsage,
};

/// One scripted environment program: what each phase returns.
pub struct ScriptedEnvironment {
    resets: Mutex<VecDeque<Result<(), String>>>,
    observations: Mutex<VecDeque<Result<RouterObservation, String>>>,
    executions: Mutex<VecDeque<Result<RouterExecution, String>>>,
    /// Every `observe` reply waits this many milliseconds first: the
    /// deadline-window batteries race a reply against the segment budget.
    observe_delay_ms: Mutex<u64>,
    /// Every `reset`/`observe`/`execute` call, in order, as
    /// `"reset"`/`"observe"`/`"execute:<action>"`.
    pub calls: Arc<Mutex<Vec<String>>>,
    /// How many times `close` ran.
    pub closes: Arc<Mutex<u32>>,
    /// The action space the adapter reports from `init`, when any.
    init_actions: Mutex<Option<Value>>,
    /// The `init` failure message, when any.
    init_error: Mutex<Option<String>>,
}

impl ScriptedEnvironment {
    #[must_use]
    pub fn new(observations: Vec<RouterObservation>) -> Arc<Self> {
        Arc::new(Self {
            resets: Mutex::new(VecDeque::from(vec![Ok(())])),
            observations: Mutex::new(observations.into_iter().map(Ok).collect()),
            executions: Mutex::new(VecDeque::new()),
            observe_delay_ms: Mutex::new(0),
            calls: Arc::new(Mutex::new(Vec::new())),
            closes: Arc::new(Mutex::new(0)),
            init_actions: Mutex::new(None),
            init_error: Mutex::new(None),
        })
    }

    /// Report an adapter-supplied default action space from `init`.
    #[must_use]
    pub fn then_init_actions(self: &Arc<Self>, actions: Value) -> Arc<Self> {
        *self.init_actions.lock().unwrap() = Some(actions);
        Arc::clone(self)
    }

    /// Fail `init` with `error`.
    #[must_use]
    pub fn then_init_error(self: &Arc<Self>, error: &str) -> Arc<Self> {
        *self.init_error.lock().unwrap() = Some(error.to_string());
        Arc::clone(self)
    }

    /// Delay every `observe` reply by `delay_ms` (the deadline-window
    /// batteries complete the reply in the same poll the budget fires).
    #[must_use]
    pub fn with_observe_delay_ms(self: &Arc<Self>, delay_ms: u64) -> Arc<Self> {
        *self.observe_delay_ms.lock().unwrap() = delay_ms;
        Arc::clone(self)
    }

    /// The same observation forever (the repeated-state case).
    #[must_use]
    pub fn with_observation(observation: RouterObservation) -> Arc<Self> {
        Arc::new(Self {
            resets: Mutex::new(VecDeque::from(vec![Ok(())])),
            observations: Mutex::new(VecDeque::from(vec![Ok(observation)])),
            executions: Mutex::new(VecDeque::new()),
            observe_delay_ms: Mutex::new(0),
            calls: Arc::new(Mutex::new(Vec::new())),
            closes: Arc::new(Mutex::new(0)),
            init_actions: Mutex::new(None),
            init_error: Mutex::new(None),
        })
    }

    /// Queue the next `reset` outcome (`Ok` when `error` is `None`).
    #[must_use]
    pub fn reset_with(self: &Arc<Self>, error: Option<&str>) -> Arc<Self> {
        let mut resets = self.resets.lock().unwrap();
        resets.clear();
        resets.push_back(match error {
            Some(error) => Err(error.to_string()),
            None => Ok(()),
        });
        drop(resets);
        Arc::clone(self)
    }

    /// Queue one observable execution outcome.
    #[must_use]
    pub fn then_execute(self: &Arc<Self>, text: &str, terminal: bool) -> Arc<Self> {
        self.executions
            .lock()
            .unwrap()
            .push_back(Ok(RouterExecution {
                text: text.to_string(),
                terminal,
            }));
        Arc::clone(self)
    }

    #[must_use]
    pub fn then_execute_error(self: &Arc<Self>, error: &str) -> Arc<Self> {
        self.executions
            .lock()
            .unwrap()
            .push_back(Err(error.to_string()));
        Arc::clone(self)
    }
}

impl RouterEnvironment for ScriptedEnvironment {
    fn reset<'a>(
        &'a self,
        _goal: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push("reset".to_string());
            self.resets
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(()))
                .map_err(|error| anyhow::anyhow!("{error}"))
        })
    }

    fn observe<'a>(
        &'a self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<RouterObservation>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.calls.lock().unwrap().push("observe".to_string());
            let delay_ms = *self.observe_delay_ms.lock().unwrap();
            if delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
            let mut observations = self.observations.lock().unwrap();
            let next = match observations.len() {
                // The last queued observation repeats: the loop's repeated-state
                // and refusal-streak paths need a stable observation.
                1 => observations
                    .front()
                    .map(|queued| queued.clone().map_err(|error| clone_error(&error))),
                0 => Some(Ok(RouterObservation {
                    text: "empty".to_string(),
                    ..RouterObservation::default()
                })),
                _ => observations
                    .pop_front()
                    .map(|queued| queued.map_err(|error| clone_error(&error))),
            };
            next.unwrap()
        })
    }

    fn execute<'a>(
        &'a self,
        action: &'a str,
        _params: &'a BTreeMap<String, String>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<RouterExecution>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.calls.lock().unwrap().push(format!("execute:{action}"));
            let mut executions = self.executions.lock().unwrap();
            let next = match executions.len() {
                0 => Some(Ok(RouterExecution {
                    text: "ok".to_string(),
                    terminal: false,
                })),
                1 => executions
                    .front()
                    .map(|queued| queued.clone().map_err(|error| clone_error(&error))),
                _ => executions
                    .pop_front()
                    .map(|queued| queued.map_err(|error| clone_error(&error))),
            };
            next.unwrap()
        })
    }

    fn close<'a>(
        &'a self,
        _options: RouterCloseOptions,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            *self.closes.lock().unwrap() += 1;
        })
    }
}

impl RouterSegmentEnvironment for ScriptedEnvironment {
    fn init<'a>(
        &'a self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<Option<Value>>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.calls.lock().unwrap().push("init".to_string());
            if let Some(error) = self.init_error.lock().unwrap().clone() {
                return Err(anyhow::anyhow!("{error}"));
            }
            Ok(self
                .init_actions
                .lock()
                .unwrap()
                .as_ref()
                .map(|actions| serde_json::json!({ "actions": actions })))
        })
    }
}

/// A decision-function program: each call pops the next outcome; over-run is
/// an error (a segment that asks for more decisions than the test queued).
#[must_use]
pub fn scripted_decide(outcomes: Vec<RouterDecisionOutcome>) -> RouterDecisionFn {
    let outcomes = Arc::new(Mutex::new(VecDeque::from(outcomes)));
    Arc::new(move |_request: RouterDecisionRequest| {
        let outcomes = Arc::clone(&outcomes);
        Box::pin(async move {
            outcomes
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| anyhow::anyhow!("scripted decisions exhausted"))
        })
    })
}

/// A decision function that sleeps past any small segment budget.
#[must_use]
pub fn slow_decide() -> RouterDecisionFn {
    Arc::new(move |_request: RouterDecisionRequest| {
        Box::pin(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            Ok(valid_decision("wait", &[], 0.99))
        })
    })
}

/// A valid single-choice decision.
#[must_use]
pub fn valid_decision(
    action: &str,
    params: &[(&str, &str)],
    confidence: f64,
) -> RouterDecisionOutcome {
    RouterDecisionOutcome {
        action: Some(action.to_string()),
        params: params
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
        confidence: Some(confidence),
        parse_error: None,
        model_error: None,
        usage: Some(RouterUsage {
            input_tokens: 7,
            output_tokens: 3,
        }),
    }
}

/// A refusal outcome (an unparseable or out-of-space reply).
#[must_use]
pub fn refused_decision(reason: &str) -> RouterDecisionOutcome {
    RouterDecisionOutcome {
        action: None,
        params: BTreeMap::new(),
        confidence: None,
        parse_error: Some(reason.to_string()),
        model_error: None,
        usage: Some(RouterUsage {
            input_tokens: 11,
            output_tokens: 0,
        }),
    }
}

/// A model-failure outcome.
#[must_use]
pub fn model_error_decision(message: &str) -> RouterDecisionOutcome {
    RouterDecisionOutcome {
        action: None,
        params: BTreeMap::new(),
        confidence: None,
        parse_error: None,
        model_error: Some(message.to_string()),
        usage: None,
    }
}

/// The two-action space used across the batteries: a read `look` and a write
/// `press` with one finite parameter.
#[must_use]
pub fn sample_action_space() -> BTreeMap<String, super::types::RouterActionSpec> {
    let mut params: BTreeMap<String, super::types::RouterActionParamSpec> = BTreeMap::new();
    params.insert(
        "button".to_string(),
        super::types::RouterActionParamSpec {
            choices: BTreeMap::from([
                ("a".to_string(), "the A button".to_string()),
                ("b".to_string(), "the B button".to_string()),
            ]),
        },
    );
    BTreeMap::from([
        (
            "look".to_string(),
            super::types::RouterActionSpec {
                description: "Look at the screen.".to_string(),
                risk: super::types::RouterActionRisk::Read,
                params: BTreeMap::new(),
            },
        ),
        (
            "press".to_string(),
            super::types::RouterActionSpec {
                description: "Press a button.".to_string(),
                risk: super::types::RouterActionRisk::Write,
                params,
            },
        ),
    ])
}

/// Rebuild an error from a queued message (queued results stay cloneable).
fn clone_error(message: &str) -> anyhow::Error {
    anyhow::anyhow!("{message}")
}

/// One observation helper.
#[must_use]
pub fn observation(text: &str) -> RouterObservation {
    RouterObservation {
        text: text.to_string(),
        ..RouterObservation::default()
    }
}
