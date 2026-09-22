//! The sole producer of ACP `session/update` notifications for one session.
//!
//! ACP notifications are asynchronous, so assigning an id at each call site
//! is insufficient: detached calls can be observed out of order. This
//! producer serializes publication and stamps the *delivered* order:
//! a strictly increasing `eventSequence` per connection, the
//! `promptTurnId` allocated at prompt admission, and a phase
//! (ordinary work / response boundary / terminal quiescence). Updates
//! published before the `session/new` response is queued are held in a
//! buffer and released after it, so no session-scoped update can precede
//! the admission response.

use std::sync::Arc;

use tokio::sync::Mutex;

use super::jsonrpc;
use super::meta::{
    prime_agent_meta, PrimeAgentEventPhase, PrimeAgentOutcome, PrimeAgentSessionMeta,
    PRIME_AGENT_META_NAMESPACE,
};
use super::types::AcpSessionUpdate;
use serde_json::{json, Value};

/// How updates leave the producer: an ordered write queue shared with the
/// response writer, so responses and notifications interleave in
/// publication order.
pub type FrameSink = tokio::sync::mpsc::UnboundedSender<Value>;

/// Per-session update producer.
pub struct UpdateProducer {
    session_id: String,
    sink: FrameSink,
    state: Mutex<ProducerState>,
}

#[derive(Debug, Default)]
struct ProducerState {
    event_sequence: u64,
    next_prompt_turn_id: u64,
    active_prompt_turn_id: u64,
    admission: AdmissionState,
}

#[derive(Debug, Default)]
struct AdmissionState {
    mode: AdmissionMode,
    /// Updates held while `session/new` has not yet replied.
    held: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum AdmissionMode {
    #[default]
    Buffering,
    Open,
    Closed,
}

impl UpdateProducer {
    pub fn new(session_id: impl Into<String>, sink: FrameSink) -> Arc<Self> {
        Arc::new(UpdateProducer {
            session_id: session_id.into(),
            sink,
            state: Mutex::new(ProducerState::default()),
        })
    }

    /// Allocate the causal turn for an accepted prompt. Called before the
    /// first await of the prompt handler so late events cannot relabel an
    /// update onto the next turn.
    pub async fn begin_prompt(&self) -> u64 {
        let mut state = self.state.lock().await;
        state.next_prompt_turn_id += 1;
        state.active_prompt_turn_id = state.next_prompt_turn_id;
        state.active_prompt_turn_id
    }

    /// The turn every non-child update currently belongs to.
    pub async fn active_prompt_turn(&self) -> u64 {
        self.state.lock().await.active_prompt_turn_id
    }

    /// End the prompt turn: after this, connection-scoped updates resume
    /// turn id `0`.
    pub async fn finish_prompt(&self, turn_id: u64) {
        let mut state = self.state.lock().await;
        if state.active_prompt_turn_id == turn_id {
            state.active_prompt_turn_id = 0;
        }
    }

    /// Open admission: the `session/new` response has been queued on the
    /// sink, so held updates may now flow behind it.
    pub async fn commit_session_new_response(&self) {
        let held = {
            let mut state = self.state.lock().await;
            if state.admission.mode != AdmissionMode::Buffering {
                return;
            }
            state.admission.mode = AdmissionMode::Open;
            std::mem::take(&mut state.admission.held)
        };
        for frame in held {
            self.send(frame);
        }
    }

    /// Fence the producer: no further updates are admitted, matching a
    /// closed session until a replacement `session/new` is admitted.
    pub async fn close(&self) {
        let mut state = self.state.lock().await;
        state.admission.mode = AdmissionMode::Closed;
        state.admission.held.clear();
    }

    /// Publish one update with its correlation fields. Returns `false`
    /// when the producer is fenced or the sink is gone; a false boundary
    /// publication fails the prompt (TS reports the same failure).
    pub async fn publish(
        &self,
        update: &AcpSessionUpdate,
        turn_id: u64,
        phase: PrimeAgentEventPhase,
        outcome: Option<PrimeAgentOutcome>,
    ) -> bool {
        let frame = self.correlate(update, turn_id, phase, outcome).await;
        let mut state = self.state.lock().await;
        match state.admission.mode {
            AdmissionMode::Buffering => {
                state.admission.held.push(frame);
                true
            }
            AdmissionMode::Open => {
                self.send(frame);
                true
            }
            AdmissionMode::Closed => false,
        }
    }

    /// Stamp the update with its `eventSequence` and namespace payload.
    async fn correlate(
        &self,
        update: &AcpSessionUpdate,
        turn_id: u64,
        phase: PrimeAgentEventPhase,
        outcome: Option<PrimeAgentOutcome>,
    ) -> Value {
        let mut value = update.to_bare_value();
        let correlation = {
            let mut state = self.state.lock().await;
            state.event_sequence += 1;
            PrimeAgentSessionMeta {
                prompt_turn_id: Some(turn_id),
                event_sequence: Some(state.event_sequence),
                phase: Some(phase),
                outcome,
                ..Default::default()
            }
        };
        // Merge with any namespace payload the update already carries
        // (e.g. ipython rich output): correlation fields are stamped onto
        // the delivered frame, never dropped.
        let meta = value
            .as_object_mut()
            .expect("session updates are objects")
            .entry("_meta")
            .or_insert_with(|| prime_agent_meta(PrimeAgentSessionMeta::default()));
        let namespace = meta
            .as_object_mut()
            .expect("_meta is a namespaced object")
            .entry(PRIME_AGENT_META_NAMESPACE.to_string())
            .or_insert_with(|| json!({}));
        let mut payload =
            serde_json::from_value::<PrimeAgentSessionMeta>(namespace.clone()).unwrap_or_default();
        payload.prompt_turn_id = correlation.prompt_turn_id;
        payload.event_sequence = correlation.event_sequence;
        payload.phase = correlation.phase;
        payload.outcome = correlation.outcome;
        *namespace = serde_json::to_value(&payload).expect("meta payload serializes");
        jsonrpc::notification(
            "session/update",
            json!({ "sessionId": self.session_id, "update": value }),
        )
    }

    fn send(&self, frame: Value) {
        let _ = self.sink.send(frame);
    }
}
