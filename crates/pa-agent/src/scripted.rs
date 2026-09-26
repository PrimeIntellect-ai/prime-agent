//! Faux scripted provider used by tests and early integrations.
//!
//! Implements the [`crate::stream::ModelStream`] protocol from a script of
//! turns: each turn is a list of [`AssistantMessageEvent`] steps (with
//! optional sleeps), a start-time failure, or a stall that resolves as an
//! aborted stream when the abort signal fires. This mirrors how a real
//! provider behaves under abort (`proxy.ts` cancels the body read and emits a
//! terminal `error` event with `stopReason: "aborted"`).
//!
//! The script surface is deliberately small: later, the `pa-ai` crate's real
//! providers replace this; the loop cannot tell the difference because both
//! implement the same trait.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::stream::{AssistantMessageEvent, LlmContext, ModelStream, StreamFn};
use crate::types::{
    AssistantContent, AssistantMessage, Model, StopReason, TextContent, ToolCall, Usage,
};

/// One step in a scripted turn.
#[derive(Debug, Clone)]
pub enum ScriptStep {
    Event(Box<AssistantMessageEvent>),
    SleepMs(u64),
}

/// A scripted provider turn.
#[derive(Debug, Clone)]
pub enum ScriptedTurn {
    /// Full event script; must end with a terminal `done`/`error` event
    /// (like a well-formed provider stream).
    Events(Vec<ScriptStep>),
    /// The stream function call itself fails (violating the TS `StreamFn`
    /// contract; exercises the loop's run-failure path).
    FailStart(String),
    /// Emit the prelude, then stall until the abort signal fires, then emit a
    /// terminal `error` event with `stopReason: "aborted"` - how a provider
    /// stream behaves when the user aborts mid-stream.
    Stalled { prelude: Vec<ScriptStep> },
}

/// Faux provider serving scripted turns in order.
pub struct ScriptedProvider {
    model: Model,
    turns: Mutex<VecDeque<ScriptedTurn>>,
    /// Recorded LLM contexts, one per stream call (for assertions).
    calls: Mutex<Vec<LlmContext>>,
}

impl ScriptedProvider {
    pub fn new(model: Model) -> Self {
        ScriptedProvider {
            model,
            turns: Mutex::new(VecDeque::new()),
            calls: Mutex::new(Vec::new()),
        }
    }

    /// Queue a scripted turn.
    ///
    /// # Panics
    ///
    /// Panics if the `turns` mutex is poisoned (another thread panicked while
    /// holding it).
    pub fn push_turn(&self, turn: ScriptedTurn) {
        self.turns.lock().unwrap().push_back(turn);
    }

    /// Queue a plain-text assistant response turn.
    pub fn push_text_turn(&self, text: &str) {
        self.push_turn(ScriptedTurn::Events(text_turn_steps(&self.model, text)));
    }

    /// Queue an assistant response turn that optionally starts with text and
    /// then requests tool calls (`reason: toolUse`).
    pub fn push_tool_call_turn(
        &self,
        text: Option<&str>,
        tool_calls: Vec<(&str, &str, serde_json::Value)>,
    ) {
        self.push_turn(ScriptedTurn::Events(tool_call_turn_steps(
            &self.model,
            text,
            tool_calls,
        )));
    }

    /// Queue a mid-stream provider failure: text streams, then the stream
    /// terminates with `stopReason: "error"` and the given message.
    pub fn push_stream_failure_turn(&self, partial_text: &str, error_message: &str) {
        self.push_turn(ScriptedTurn::Events(stream_failure_steps(
            &self.model,
            partial_text,
            error_message,
        )));
    }

    /// Queue a stalled turn: emits `partial_text`, then stalls until abort.
    pub fn push_stalled_turn(&self, partial_text: &str) {
        let mut prelude = vec![ScriptStep::Event(Box::new(AssistantMessageEvent::Start {
            partial: empty_partial(&self.model),
        }))];
        if !partial_text.is_empty() {
            prelude.extend(text_delta_steps(
                &empty_partial(&self.model),
                0,
                partial_text,
            ));
        }
        self.push_turn(ScriptedTurn::Stalled { prelude });
    }

    /// Queue a start-time stream function failure.
    pub fn push_fail_start_turn(&self, message: &str) {
        self.push_turn(ScriptedTurn::FailStart(message.to_string()));
    }

    /// Recorded LLM contexts (one per stream call).
    ///
    /// # Panics
    ///
    /// Panics if the `calls` mutex is poisoned (another thread panicked while
    /// holding it).
    pub fn calls(&self) -> Vec<LlmContext> {
        self.calls.lock().unwrap().clone()
    }

    /// The `StreamFn` for this provider.
    ///
    /// # Panics
    ///
    /// The returned stream function panics if the `calls` or `turns` mutex is
    /// poisoned (another thread panicked while holding one of them).
    pub fn stream_fn(self: &Arc<Self>) -> StreamFn {
        let provider = Arc::clone(self);
        Arc::new(move |_model, context, _options| {
            let provider = Arc::clone(&provider);
            Box::pin(async move {
                provider.calls.lock().unwrap().push(context);
                let Some(turn) = provider.turns.lock().unwrap().pop_front() else {
                    anyhow::bail!("ScriptedProvider exhausted: no scripted turn available");
                };
                match turn {
                    ScriptedTurn::FailStart(message) => Err(anyhow::anyhow!(message)),
                    ScriptedTurn::Events(steps) => Ok(Box::new(ScriptedStream::events(
                        provider.model.clone(),
                        steps,
                    ))
                        as Box<dyn ModelStream>),
                    ScriptedTurn::Stalled { prelude } => Ok(Box::new(ScriptedStream::stalled(
                        provider.model.clone(),
                        prelude,
                    ))
                        as Box<dyn ModelStream>),
                }
            })
        })
    }
}

// ---------------------------------------------------------------------------
// Scripted stream implementation
// ---------------------------------------------------------------------------

struct ScriptedStreamInner {
    result: Mutex<Option<AssistantMessage>>,
    notify: tokio::sync::Notify,
}

enum ScriptedMode {
    Events(VecDeque<ScriptStep>),
    /// After the prelude is exhausted, stall forever: the agent loop races
    /// `next_event` against its abort signal, so an abort during the stall is
    /// handled by the loop exactly like the TS reference (the loop synthesizes
    /// the aborted assistant message; the stream is closed via
    /// [`ModelStream::close`]).
    Stalled(VecDeque<ScriptStep>),
}

struct ScriptedStream {
    mode: ScriptedMode,
    inner: Arc<ScriptedStreamInner>,
    finished: bool,
}

impl ScriptedStream {
    fn events(_model: Model, steps: Vec<ScriptStep>) -> Self {
        ScriptedStream {
            mode: ScriptedMode::Events(steps.into()),
            inner: Arc::new(ScriptedStreamInner {
                result: Mutex::new(None),
                notify: tokio::sync::Notify::new(),
            }),
            finished: false,
        }
    }

    fn stalled(_model: Model, prelude: Vec<ScriptStep>) -> Self {
        ScriptedStream {
            mode: ScriptedMode::Stalled(prelude.into()),
            inner: Arc::new(ScriptedStreamInner {
                result: Mutex::new(None),
                notify: tokio::sync::Notify::new(),
            }),
            finished: false,
        }
    }

    fn set_result(&self, message: AssistantMessage) {
        {
            let mut result = self.inner.result.lock().unwrap();
            *result = Some(message);
        }
        self.inner.notify.notify_waiters();
    }
}

impl ModelStream for ScriptedStream {
    fn next_event(&mut self) -> crate::BoxFut<'_, Option<AssistantMessageEvent>> {
        Box::pin(async {
            if self.finished {
                return None;
            }
            loop {
                match &mut self.mode {
                    ScriptedMode::Events(steps) => match steps.pop_front() {
                        Some(ScriptStep::SleepMs(ms)) => {
                            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                        }
                        Some(ScriptStep::Event(event)) => {
                            let event = *event;
                            if let Some(message) = event.terminal_message() {
                                self.set_result(message.clone());
                                self.finished = true;
                            }
                            return Some(event);
                        }
                        None => {
                            self.finished = true;
                            return None;
                        }
                    },
                    ScriptedMode::Stalled(prelude) => {
                        match prelude.pop_front() {
                            Some(ScriptStep::SleepMs(ms)) => {
                                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                            }
                            Some(ScriptStep::Event(event)) => {
                                if let Some(message) = event.terminal_message() {
                                    self.set_result(message.clone());
                                    self.finished = true;
                                }
                                return Some(*event);
                            }
                            None => {
                                // Stall: the loop's abort race is the only way
                                // out (or a `close()` drops this future).
                                std::future::pending::<()>().await;
                                return None;
                            }
                        }
                    }
                }
            }
        })
    }

    fn result(&mut self) -> crate::BoxFut<'_, anyhow::Result<AssistantMessage>> {
        Box::pin(async {
            loop {
                if let Some(message) = self.inner.result.lock().unwrap().clone() {
                    return Ok(message);
                }
                let notified = self.inner.notify.notified();
                if let Some(message) = self.inner.result.lock().unwrap().clone() {
                    return Ok(message);
                }
                notified.await;
            }
        })
    }

    fn close(&mut self) {
        self.finished = true;
    }
}

// ---------------------------------------------------------------------------
// Script builders
// ---------------------------------------------------------------------------

fn empty_partial(model: &Model) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: Usage::zero(),
        stop_reason: StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: crate::now_ms(),
    }
}

/// Build `text_start` / `text_delta` / `text_end` steps appending `text` at
/// `content_index` onto the given base partial.
fn text_delta_steps(base: &AssistantMessage, content_index: usize, text: &str) -> Vec<ScriptStep> {
    let mut steps = Vec::new();
    let mut partial = base.clone();
    partial.content.push(AssistantContent::Text(TextContent {
        text: String::new(),
        text_signature: None,
    }));
    steps.push(ScriptStep::Event(Box::new(
        AssistantMessageEvent::TextStart {
            content_index,
            partial: partial.clone(),
        },
    )));
    for chunk in text.as_bytes().chunks(8) {
        let delta = String::from_utf8_lossy(chunk).to_string();
        if let Some(AssistantContent::Text(text_content)) = partial.content.get_mut(content_index) {
            text_content.text.push_str(&delta);
        }
        steps.push(ScriptStep::Event(Box::new(
            AssistantMessageEvent::TextDelta {
                content_index,
                delta,
                partial: partial.clone(),
            },
        )));
    }
    let final_text =
        if let Some(AssistantContent::Text(text_content)) = partial.content.get(content_index) {
            text_content.text.clone()
        } else {
            String::new()
        };
    steps.push(ScriptStep::Event(Box::new(
        AssistantMessageEvent::TextEnd {
            content_index,
            content: final_text,
            partial: partial.clone(),
        },
    )));
    steps
}

/// A complete text response turn (`stopReason: stop`).
pub fn text_turn_steps(model: &Model, text: &str) -> Vec<ScriptStep> {
    let base = empty_partial(model);
    let mut steps = vec![ScriptStep::Event(Box::new(AssistantMessageEvent::Start {
        partial: base.clone(),
    }))];
    steps.extend(text_delta_steps(&base, 0, text));
    // The final message carries the accumulated text content from the last
    // delta partial (the base partial is empty by construction).
    let final_message = steps
        .iter()
        .rev()
        .find_map(|step| match step {
            ScriptStep::Event(event) => match &**event {
                AssistantMessageEvent::TextEnd { partial, .. } => Some(partial.clone()),
                _ => None,
            },
            ScriptStep::SleepMs(_) => None,
        })
        .unwrap_or_else(|| {
            let mut partial = base.clone();
            partial.content.push(AssistantContent::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
            }));
            partial
        });
    steps.push(ScriptStep::Event(Box::new(AssistantMessageEvent::Done {
        reason: StopReason::Stop,
        message: final_message,
    })));
    steps
}

/// A tool-call response turn (`stopReason: toolUse`).
pub fn tool_call_turn_steps(
    model: &Model,
    text: Option<&str>,
    tool_calls: Vec<(&str, &str, serde_json::Value)>,
) -> Vec<ScriptStep> {
    let base = empty_partial(model);
    let mut steps = vec![ScriptStep::Event(Box::new(AssistantMessageEvent::Start {
        partial: base.clone(),
    }))];
    let mut partial = base;
    let mut content_index = 0usize;
    if let Some(text) = text {
        steps.extend(text_delta_steps(&partial, 0, text));
        if let Some(AssistantContent::Text(text_content)) = partial.content.get_mut(0) {
            text_content.text = text.to_string();
        }
        content_index = 1;
    }
    for (id, name, arguments) in tool_calls {
        let tool_call = ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments,
            thought_signature: None,
        };
        steps.push(ScriptStep::Event(Box::new(
            AssistantMessageEvent::ToolCallStart {
                content_index,
                partial: partial.clone(),
            },
        )));
        let json = serde_json::to_string(&tool_call.arguments).unwrap_or_else(|_| "{}".to_string());
        steps.push(ScriptStep::Event(Box::new(
            AssistantMessageEvent::ToolCallDelta {
                content_index,
                delta: json,
                partial: partial.clone(),
            },
        )));
        partial
            .content
            .push(AssistantContent::ToolCall(tool_call.clone()));
        steps.push(ScriptStep::Event(Box::new(
            AssistantMessageEvent::ToolCallEnd {
                content_index,
                tool_call,
                partial: partial.clone(),
            },
        )));
        content_index += 1;
    }
    steps.push(ScriptStep::Event(Box::new(AssistantMessageEvent::Done {
        reason: StopReason::ToolUse,
        message: partial,
    })));
    steps
}

/// A stream that delivers `partial_text` and then fails mid-turn
/// (`stopReason: error`).
pub fn stream_failure_steps(
    model: &Model,
    partial_text: &str,
    error_message: &str,
) -> Vec<ScriptStep> {
    let base = empty_partial(model);
    let mut steps = vec![ScriptStep::Event(Box::new(AssistantMessageEvent::Start {
        partial: base.clone(),
    }))];
    steps.extend(text_delta_steps(&base, 0, partial_text));
    let mut error_message_partial = base;
    error_message_partial
        .content
        .push(AssistantContent::Text(TextContent {
            text: partial_text.to_string(),
            text_signature: None,
        }));
    error_message_partial.stop_reason = StopReason::Error;
    error_message_partial.error_message = Some(error_message.to_string());
    steps.push(ScriptStep::Event(Box::new(AssistantMessageEvent::Error {
        reason: StopReason::Error,
        error: error_message_partial,
    })));
    steps
}
