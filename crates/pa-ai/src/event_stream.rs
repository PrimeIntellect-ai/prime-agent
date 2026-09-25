//! Assistant message event stream.
//!
//! Ported from `packages/ai/src/utils/event-stream.ts`. The stream carries the
//! provider event protocol: `start` first, then partial updates, terminating
//! with exactly one of `done` (success) or `error` (failure/abort). Producers
//! push events through [`AssistantMessageEventWriter`]; consumers iterate the
//! [`AssistantMessageEventStream`] and can await
//! [`AssistantMessageEventStream::result`].
//!
//! The event type itself is the shared [`AssistantMessageEvent`] from
//! `pa-types` (the wire shape); the helpers below are an extension trait
//! because the type is owned by `pa-types`.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll, Waker};

use futures::Stream;

pub use crate::types::{AssistantContent, AssistantMessage, AssistantMessageEvent, StopReason};

/// Provider-side helpers over the shared [`AssistantMessageEvent`] wire enum.
pub trait AssistantMessageEventExt {
    /// Stable event-type name, matching the TS wire `type` tag.
    fn event_type(&self) -> &'static str;
    /// True for the two terminal event kinds.
    fn is_terminal(&self) -> bool;
    /// The final message carried by a terminal event, if any.
    fn terminal_message(&self) -> Option<AssistantMessage>;
    /// The partial assistant message the event refers to.
    fn partial(&self) -> &AssistantMessage;
    /// Content index carried by content-block events (start/delta/end).
    fn content_index(&self) -> Option<u64>;
    /// Text delta for `*_delta` events.
    fn delta(&self) -> Option<&str>;
}

impl AssistantMessageEventExt for AssistantMessageEvent {
    fn event_type(&self) -> &'static str {
        match self {
            AssistantMessageEvent::Start { .. } => "start",
            AssistantMessageEvent::TextStart { .. } => "text_start",
            AssistantMessageEvent::TextDelta { .. } => "text_delta",
            AssistantMessageEvent::TextEnd { .. } => "text_end",
            AssistantMessageEvent::ThinkingStart { .. } => "thinking_start",
            AssistantMessageEvent::ThinkingDelta { .. } => "thinking_delta",
            AssistantMessageEvent::ThinkingEnd { .. } => "thinking_end",
            AssistantMessageEvent::ToolcallStart { .. } => "toolcall_start",
            AssistantMessageEvent::ToolcallDelta { .. } => "toolcall_delta",
            AssistantMessageEvent::ToolcallEnd { .. } => "toolcall_end",
            AssistantMessageEvent::Done { .. } => "done",
            AssistantMessageEvent::Error { .. } => "error",
        }
    }

    fn is_terminal(&self) -> bool {
        matches!(
            self,
            AssistantMessageEvent::Done { .. } | AssistantMessageEvent::Error { .. }
        )
    }

    fn terminal_message(&self) -> Option<AssistantMessage> {
        match self {
            AssistantMessageEvent::Done { message, .. } => Some(message.clone()),
            AssistantMessageEvent::Error { error, .. } => Some(error.clone()),
            _ => None,
        }
    }

    fn partial(&self) -> &AssistantMessage {
        match self {
            AssistantMessageEvent::Start { partial }
            | AssistantMessageEvent::TextStart { partial, .. }
            | AssistantMessageEvent::TextDelta { partial, .. }
            | AssistantMessageEvent::TextEnd { partial, .. }
            | AssistantMessageEvent::ThinkingStart { partial, .. }
            | AssistantMessageEvent::ThinkingDelta { partial, .. }
            | AssistantMessageEvent::ThinkingEnd { partial, .. }
            | AssistantMessageEvent::ToolcallStart { partial, .. }
            | AssistantMessageEvent::ToolcallDelta { partial, .. }
            | AssistantMessageEvent::ToolcallEnd { partial, .. }
            | AssistantMessageEvent::Done {
                message: partial, ..
            }
            | AssistantMessageEvent::Error { error: partial, .. } => partial,
        }
    }

    fn content_index(&self) -> Option<u64> {
        match self {
            AssistantMessageEvent::TextStart { content_index, .. }
            | AssistantMessageEvent::TextDelta { content_index, .. }
            | AssistantMessageEvent::TextEnd { content_index, .. }
            | AssistantMessageEvent::ThinkingStart { content_index, .. }
            | AssistantMessageEvent::ThinkingDelta { content_index, .. }
            | AssistantMessageEvent::ThinkingEnd { content_index, .. }
            | AssistantMessageEvent::ToolcallStart { content_index, .. }
            | AssistantMessageEvent::ToolcallDelta { content_index, .. }
            | AssistantMessageEvent::ToolcallEnd { content_index, .. } => Some(*content_index),
            _ => None,
        }
    }

    fn delta(&self) -> Option<&str> {
        match self {
            AssistantMessageEvent::TextDelta { delta, .. }
            | AssistantMessageEvent::ThinkingDelta { delta, .. }
            | AssistantMessageEvent::ToolcallDelta { delta, .. } => Some(delta),
            _ => None,
        }
    }
}

// -- Shared state ------------------------------------------------------------

#[derive(Default)]
struct SharedState {
    done: bool,
    queue: VecDeque<AssistantMessageEvent>,
    waker: Option<Waker>,
    resolved: Option<AssistantMessage>,
    waiters: Vec<tokio::sync::oneshot::Sender<AssistantMessage>>,
}

impl SharedState {
    /// Push a terminal event's message as the final result. First writer wins.
    fn resolve(&mut self, message: AssistantMessage) {
        if self.resolved.is_none() {
            self.resolved = Some(message);
            let waiters = std::mem::take(&mut self.waiters);
            for sender in waiters {
                if let Some(message) = &self.resolved {
                    let _ = sender.send(message.clone());
                }
            }
        }
    }
}

struct Shared {
    state: Mutex<SharedState>,
}

impl Shared {
    fn push(&self, event: AssistantMessageEvent) {
        let mut state = self.state.lock().unwrap();
        if state.done {
            return;
        }
        if event.is_terminal() {
            state.done = true;
            if let Some(message) = event.terminal_message() {
                state.resolve(message);
            }
        }
        state.queue.push_back(event);
        if let Some(waker) = state.waker.take() {
            waker.wake();
        }
    }

    fn end(&self, result: Option<AssistantMessage>) {
        let mut state = self.state.lock().unwrap();
        state.done = true;
        if let Some(result) = result {
            state.resolve(result);
        }
        if let Some(waker) = state.waker.take() {
            waker.wake();
        }
    }
}

// -- Writer ------------------------------------------------------------------

/// Producer handle for an assistant message event stream.
#[derive(Clone)]
pub struct AssistantMessageEventWriter {
    shared: Arc<Shared>,
}

impl AssistantMessageEventWriter {
    /// Queue an event. Events pushed after the stream terminated are dropped,
    /// matching the TS reference.
    pub fn push(&self, event: AssistantMessageEvent) {
        self.shared.push(event);
    }

    /// Terminate the stream. `result` becomes the final result when provided.
    pub fn end(&self, result: Option<AssistantMessage>) {
        self.shared.end(result);
    }

    pub fn is_done(&self) -> bool {
        self.shared.state.lock().unwrap().done
    }
}

// -- Reader ------------------------------------------------------------------

/// Async iterable stream of [`AssistantMessageEvent`] with a final-result future.
pub struct AssistantMessageEventStream {
    shared: Arc<Shared>,
}

impl AssistantMessageEventStream {
    /// Create a linked writer/stream pair.
    pub fn new() -> (AssistantMessageEventWriter, Self) {
        let shared = Arc::new(Shared {
            state: Mutex::new(SharedState::default()),
        });
        (
            AssistantMessageEventWriter {
                shared: shared.clone(),
            },
            Self { shared },
        )
    }

    /// Collect all remaining events (draining, for tests and tooling).
    pub async fn collect(mut self) -> Vec<AssistantMessageEvent> {
        let mut events = Vec::new();
        while let Some(event) = self.next_event().await {
            events.push(event);
        }
        events
    }

    /// Await the next event, or None once the stream terminated.
    pub async fn next_event(&mut self) -> Option<AssistantMessageEvent> {
        futures::future::poll_fn(|cx| self.poll_next_event(cx)).await
    }

    /// Poll for the next queued event: `Ready` with one when queued, `None`
    /// once the stream terminated, or `Pending` (after registering the waker)
    /// until an event arrives.
    ///
    /// # Panics
    ///
    /// Panics if the shared-state `Mutex` is poisoned (a thread panicked
    /// while holding the lock).
    pub fn poll_next_event(
        &mut self,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<AssistantMessageEvent>> {
        let mut state = self.shared.state.lock().unwrap();
        if let Some(event) = state.queue.pop_front() {
            return Poll::Ready(Some(event));
        }
        if state.done {
            return Poll::Ready(None);
        }
        state.waker = Some(cx.waker().clone());
        Poll::Pending
    }

    /// Await the final assistant message carried by the terminal event.
    ///
    /// # Panics
    ///
    /// Panics if the shared-state `Mutex` is poisoned (a thread panicked
    /// while holding the lock), or if the stream terminates without resolving
    /// a final assistant message.
    pub async fn result(self) -> AssistantMessage {
        if let Some(message) = self.try_result() {
            return message;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut state = self.shared.state.lock().unwrap();
            if let Some(message) = &state.resolved {
                return message.clone();
            }
            state.waiters.push(tx);
        }
        match rx.await {
            Ok(message) => message,
            Err(_) => {
                // Sender dropped without send: re-check the resolved slot.
                self.try_result()
                    .expect("event stream resolved without a final message")
            }
        }
    }

    fn try_result(&self) -> Option<AssistantMessage> {
        self.shared.state.lock().unwrap().resolved.clone()
    }
}

impl Default for AssistantMessageEventStream {
    fn default() -> Self {
        Self::new().1
    }
}

impl Stream for AssistantMessageEventStream {
    type Item = AssistantMessageEvent;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        self.poll_next_event(cx)
    }
}

/// Convenience constructor matching the TS `createAssistantMessageEventStream()`.
pub fn create_assistant_message_event_stream(
) -> (AssistantMessageEventWriter, AssistantMessageEventStream) {
    AssistantMessageEventStream::new()
}

/// Initial assistant message shape shared by every provider.
/// Initial assistant message shape shared by every provider.
#[allow(dead_code)] // provider constructors use this once each port lands
pub fn initial_assistant_message(api: &str, provider: &str, model_id: &str) -> AssistantMessage {
    AssistantMessage {
        content: Vec::new(),
        api: api.to_string(),
        provider: provider.to_string(),
        model: model_id.to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: crate::types::Usage::default(),
        stop_reason: StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64),
        rest: Default::default(),
    }
}

/// Empty assistant content helper for stream constructors.
#[allow(dead_code)] // provider constructors use this once each port lands
pub fn empty_content() -> Vec<AssistantContent> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AssistantContent, DoneStopReason, ErrorStopReason, TextContent, Usage};

    fn sample_message(text: &str) -> AssistantMessage {
        AssistantMessage {
            content: vec![AssistantContent::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
                rest: Default::default(),
            })],
            api: "test".into(),
            provider: "test".into(),
            model: "test-model".into(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Default::default(),
        }
    }

    #[tokio::test]
    async fn streams_events_in_order_and_resolves_result() {
        let (writer, mut stream) = AssistantMessageEventStream::new();
        let final_message = sample_message("hi");
        let start_message = sample_message("");
        writer.push(AssistantMessageEvent::Start {
            partial: start_message.clone(),
        });
        writer.push(AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: "hi".into(),
            partial: start_message,
        });
        writer.push(AssistantMessageEvent::Done {
            reason: DoneStopReason::Stop,
            message: final_message.clone(),
        });

        let mut types = Vec::new();
        while let Some(event) = stream.next_event().await {
            types.push(event.event_type().to_string());
        }
        assert_eq!(types, vec!["start", "text_delta", "done"]);
        assert_eq!(final_message.content.len(), 1);
    }

    #[tokio::test]
    async fn result_resolves_from_terminal_event() {
        let (writer, stream) = AssistantMessageEventStream::new();
        let mut message = sample_message("done");
        message.stop_reason = StopReason::Error;
        writer.push(AssistantMessageEvent::Error {
            reason: ErrorStopReason::Error,
            error: message.clone(),
        });
        let resolved = stream.result().await;
        assert_eq!(resolved.stop_reason, StopReason::Error);
        assert_eq!(resolved.content, message.content);
    }

    #[tokio::test]
    async fn drops_events_after_done() {
        let (writer, mut stream) = AssistantMessageEventStream::new();
        writer.push(AssistantMessageEvent::Done {
            reason: DoneStopReason::Stop,
            message: sample_message("done"),
        });
        assert!(writer.is_done());
        writer.push(AssistantMessageEvent::Start {
            partial: sample_message(""),
        });
        let first = stream.next_event().await.unwrap();
        assert_eq!(first.event_type(), "done");
        assert!(stream.next_event().await.is_none());
    }
}
