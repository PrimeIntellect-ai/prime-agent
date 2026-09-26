//! Minimal model-facing streaming surface for the agent loop.
//!
//! This is a *local* trait for the `pa-agent` loop, deliberately narrow and
//! documented for later unification with the `pa-ai` provider layer. It
//! mirrors the parts of the TS provider layer (packages/ai) the loop consumes:
//!
//! - `AssistantMessageEvent` protocol: `start`, content deltas/ends, then a
//!   terminal `done` or `error` event carrying the final [`types::AssistantMessage`].
//! - `AssistantMessageEventStream`: push events from a producer, iterate them
//!   as a consumer, and resolve a final result once a terminal event arrives
//!   (the TS `EventStream` shape).
//!
//! Contract identical to the TS `StreamFn`: the provider must not throw for
//! request/model/runtime failures - failures are encoded in the returned stream
//! as a terminal `error` event with `stopReason` "error" or "aborted" and an
//! `errorMessage`. A `StreamFn` in Rust may still return `Err`, which the loop
//! treats as a run failure (TS ends the stream with an empty result there).

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};

use crate::types::{AssistantMessage, Model, StopReason, ThinkingLevel, ToolCall};

/// Event protocol for a model stream (the TS `AssistantMessageEvent` shape).
///
/// Streams emit `Start` before partial updates, then terminate with either
/// `Done` carrying the final successful message or `Error` carrying the final
/// message with `stop_reason` `Error` or `Aborted`.
#[derive(Debug, Clone)]
pub enum AssistantMessageEvent {
    Start {
        partial: AssistantMessage,
    },
    TextStart {
        content_index: usize,
        partial: AssistantMessage,
    },
    TextDelta {
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    TextEnd {
        content_index: usize,
        content: String,
        partial: AssistantMessage,
    },
    ThinkingStart {
        content_index: usize,
        partial: AssistantMessage,
    },
    ThinkingDelta {
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    ThinkingEnd {
        content_index: usize,
        partial: AssistantMessage,
    },
    ToolCallStart {
        content_index: usize,
        partial: AssistantMessage,
    },
    ToolCallDelta {
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    ToolCallEnd {
        content_index: usize,
        tool_call: ToolCall,
        partial: AssistantMessage,
    },
    Done {
        reason: StopReason,
        message: AssistantMessage,
    },
    Error {
        reason: StopReason,
        error: AssistantMessage,
    },
}

impl AssistantMessageEvent {
    /// Terminal message for a `Done`/`Error` event (TS `getTerminalMessage`).
    pub fn terminal_message(&self) -> Option<&AssistantMessage> {
        match self {
            AssistantMessageEvent::Done { message, .. } => Some(message),
            AssistantMessageEvent::Error { error, .. } => Some(error),
            _ => None,
        }
    }

    /// True for the partial-update events the loop applies to the streaming
    /// message (`text_*`, `thinking_*`, `toolcall_*`).
    pub fn is_delta(&self) -> bool {
        matches!(
            self,
            AssistantMessageEvent::TextStart { .. }
                | AssistantMessageEvent::TextDelta { .. }
                | AssistantMessageEvent::TextEnd { .. }
                | AssistantMessageEvent::ThinkingStart { .. }
                | AssistantMessageEvent::ThinkingDelta { .. }
                | AssistantMessageEvent::ThinkingEnd { .. }
                | AssistantMessageEvent::ToolCallStart { .. }
                | AssistantMessageEvent::ToolCallDelta { .. }
                | AssistantMessageEvent::ToolCallEnd { .. }
        )
    }
}

/// Tool definition sent to the model in the LLM context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema for the parameters.
    pub parameters: serde_json::Value,
}

/// LLM-bound context (the TS `Context` shape).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmContext {
    pub system_prompt: Option<String>,
    pub messages: Vec<crate::types::Message>,
    pub tools: Vec<ToolDefinition>,
}

/// Provider response as the response hook sees it (the TS `ProviderResponse`
/// `{ status, headers }` shape; the pa-ai mirror lives in `pa-types`).
#[derive(Debug, Clone)]
pub struct ProviderResponse {
    pub status: u16,
    /// Ordered (`BTreeMap`): response metadata can serialize into failure
    /// diagnostics on the wire; unordered iteration would leak random key
    /// order into the bytes.
    pub headers: std::collections::BTreeMap<String, String>,
}

/// Hook invoked with the outbound provider payload before sending; return
/// `Some` to replace the payload (TS `onPayload`). The payload crosses in
/// its wire shape (JSON), not as a provider-crate type.
pub type OnPayloadHook =
    std::sync::Arc<dyn Fn(serde_json::Value, &Model) -> Option<serde_json::Value> + Send + Sync>;

/// Hook invoked after the HTTP response is received and before the body is
/// read (TS `onResponse`).
pub type OnResponseHook = std::sync::Arc<dyn Fn(ProviderResponse, &Model) + Send + Sync>;

/// Stream request options (subset of the TS `SimpleStreamOptions` the loop
/// uses, plus the request hooks the TS options carry).
#[derive(Clone)]
pub struct StreamRequestOptions {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u64>,
    pub reasoning: ThinkingLevel,
    pub session_id: Option<String>,
    pub api_key: Option<String>,
    pub signal: crate::abort::AbortSignal,
    /// Outbound-payload hook (TS `SimpleStreamOptions.onPayload`). `None`
    /// leaves the payload untouched; the provider client invokes it once
    /// per request before the body is sent.
    pub on_payload: Option<OnPayloadHook>,
    /// Response-headers hook (TS `SimpleStreamOptions.onResponse`). Invoked
    /// once per request after the response headers arrive.
    pub on_response: Option<OnResponseHook>,
}

impl std::fmt::Debug for StreamRequestOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamRequestOptions")
            .field("temperature", &self.temperature)
            .field("max_tokens", &self.max_tokens)
            .field("reasoning", &self.reasoning)
            .field("session_id", &self.session_id)
            .field("api_key", &self.api_key.as_ref().map(|_| "<set>"))
            .field("signal", &self.signal)
            .field("on_payload", &self.on_payload.is_some())
            .field("on_response", &self.on_response.is_some())
            .finish()
    }
}

impl Default for StreamRequestOptions {
    fn default() -> Self {
        StreamRequestOptions {
            temperature: None,
            max_tokens: None,
            reasoning: ThinkingLevel::Off,
            session_id: None,
            api_key: None,
            signal: crate::abort::AbortSignal::never(),
            on_payload: None,
            on_response: None,
        }
    }
}

/// The streaming surface the agent loop consumes.
///
/// The TS reference iterates an `AssistantMessageEventStream` and awaits
/// `result()`; this trait is the Rust equivalent. `next_event` returns `None`
/// when the event sequence is exhausted. `result` must resolve after a
/// terminal event; a stream that ends without one returns an error (the TS
/// version would hang forever - that deadlock is converted into an `Err`).
pub trait ModelStream: Send {
    fn next_event(&mut self) -> crate::BoxFut<'_, Option<AssistantMessageEvent>>;
    /// Final assistant message; resolves after a terminal `done`/`error` event
    /// or an explicit `end(result)`.
    fn result(&mut self) -> crate::BoxFut<'_, anyhow::Result<AssistantMessage>>;
    /// Close/cancel the underlying stream (TS `iterator.return()`), used when
    /// the agent aborts mid-stream. Must be idempotent.
    fn close(&mut self) {}
}

/// Stream function used by the agent loop (TS `StreamFn`).
///
/// Receives the model, the LLM-bound context, and the request options, and
/// returns a [`ModelStream`] asynchronously.
pub type StreamFn = Arc<
    dyn Fn(
            Model,
            LlmContext,
            StreamRequestOptions,
        ) -> crate::BoxFut<'static, anyhow::Result<Box<dyn ModelStream>>>
        + Send
        + Sync,
>;

struct SharedStreamState {
    result: std::sync::Mutex<Option<AssistantMessage>>,
    notify: Notify,
    closed: std::sync::Mutex<bool>,
}

/// Producer handle of an [`AssistantMessageEventStream`] (the TS
/// `EventStream<AssistantMessageEvent, AssistantMessage>` shape).
#[derive(Clone)]
pub struct AssistantMessageEventStreamHandle {
    tx: mpsc::UnboundedSender<AssistantMessageEvent>,
    shared: Arc<SharedStreamState>,
}

/// Consumer side of the event stream; implements [`ModelStream`].
pub struct AssistantMessageEventStream {
    rx: mpsc::UnboundedReceiver<AssistantMessageEvent>,
    shared: Arc<SharedStreamState>,
    closed: bool,
}

/// Create a connected event stream pair.
pub fn event_stream() -> (
    AssistantMessageEventStreamHandle,
    AssistantMessageEventStream,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let shared = Arc::new(SharedStreamState {
        result: std::sync::Mutex::new(None),
        notify: Notify::new(),
        closed: std::sync::Mutex::new(false),
    });
    (
        AssistantMessageEventStreamHandle {
            tx,
            shared: shared.clone(),
        },
        AssistantMessageEventStream {
            rx,
            shared,
            closed: false,
        },
    )
}

impl AssistantMessageEventStreamHandle {
    /// Push an event. Ignored after the stream was ended or closed, and after a
    /// terminal event resolved the result (TS `EventStream.push` after `done`).
    ///
    /// # Panics
    ///
    /// Panics if the `closed` mutex is poisoned, or if the `result` mutex
    /// is poisoned while storing a terminal event's message (another
    /// thread panicked while holding one of them).
    pub fn push(&self, event: AssistantMessageEvent) {
        if *self.shared.closed.lock().unwrap() {
            return;
        }
        if let Some(message) = event.terminal_message() {
            let mut result = self.shared.result.lock().unwrap();
            if result.is_none() {
                *result = Some(message.clone());
                self.shared.notify.notify_waiters();
            }
        }
        let _ = self.tx.send(event);
    }

    /// End the stream, optionally resolving `result()`.
    ///
    /// Like the TS `EventStream.end`, already-queued events are still yielded
    /// by the consumer before iteration finishes; further pushes are ignored.
    ///
    /// # Panics
    ///
    /// Panics if the `closed` mutex is poisoned, or if the `result` mutex
    /// is poisoned while storing a supplied result (another thread
    /// panicked while holding one of them).
    pub fn end(&self, result: Option<AssistantMessage>) {
        *self.shared.closed.lock().unwrap() = true;
        if let Some(message) = result {
            let mut result_slot = self.shared.result.lock().unwrap();
            if result_slot.is_none() {
                *result_slot = Some(message);
            }
        }
        self.shared.notify.notify_waiters();
    }
}

impl AssistantMessageEventStream {
    /// Drain any already-queued events, returning `None` once the queue is
    /// empty and the stream was ended/closed.
    fn try_next(&mut self) -> Option<AssistantMessageEvent> {
        if *self.shared.closed.lock().unwrap() {
            return self.rx.try_recv().ok();
        }
        None
    }
}

impl ModelStream for AssistantMessageEventStream {
    fn next_event(&mut self) -> crate::BoxFut<'_, Option<AssistantMessageEvent>> {
        Box::pin(async {
            if self.closed {
                return self.try_next();
            }
            loop {
                if *self.shared.closed.lock().unwrap() {
                    self.closed = true;
                    return self.try_next();
                }
                let notified = self.shared.notify.notified();
                tokio::select! {
                    event = self.rx.recv() => return event,
                    () = notified => {
                        if *self.shared.closed.lock().unwrap() {
                            self.closed = true;
                            return self.try_next();
                        }
                        // A terminal event resolved `result()` early (its push
                        // notifies waiters); keep waiting for channel events.
                    }
                }
            }
        })
    }

    fn result(&mut self) -> crate::BoxFut<'_, anyhow::Result<AssistantMessage>> {
        Box::pin(async {
            loop {
                if let Some(message) = self.shared.result.lock().unwrap().clone() {
                    return Ok(message);
                }
                if *self.shared.closed.lock().unwrap() {
                    // Stream ended without a terminal event; unlike TS (which
                    // hangs forever), surface an error.
                    return Err(anyhow::anyhow!(
                        "Assistant message event stream ended without a terminal done/error event"
                    ));
                }
                let notified = self.shared.notify.notified();
                if let Some(message) = self.shared.result.lock().unwrap().clone() {
                    return Ok(message);
                }
                notified.await;
            }
        })
    }

    fn close(&mut self) {
        self.closed = true;
        self.rx.close();
        *self.shared.closed.lock().unwrap() = true;
        self.shared.notify.notify_waiters();
    }
}
