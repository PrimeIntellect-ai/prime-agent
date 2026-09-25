//! Live token-stream coalescing on the worker broadcast path.
//!
//! With live turn-event forwarding (see `agent_engine`), one assistant
//! message streams as one `message_update` wire event per provider delta,
//! each carrying the full partial message. Providers emit tens to hundreds
//! of deltas per second, so the turn's emit path parks those frames in a
//! single-slot coalescer instead of broadcasting every one: a flusher task
//! emits at most one parked update per interval, while every other frame
//! (`message_start`, `message_end`, tool events, `turn_end`) flushes the parked
//! update first and then goes out immediately, so wire order and
//! event-sequence order stay identical to uncoalesced streaming.
//!
//! A superseded snapshot is equivalent for the message content (the newest
//! frame carries the full partial), but the frames' `assistantMessageEvent`
//! deltas are ADDITIVE — downstream consumers map delta text to chunks (the
//! ACP adapter) and activity labels. The coalescer therefore merges the
//! parked frame's delta text instead of dropping it: a burst of same-kind
//! deltas broadcasts as one frame whose delta is the concatenated run. A
//! block-end stream event (`text_end` and friends) flushes the parked frame
//! instead of superseding it, so no delta run is ever cut short.
//!
//! The parked frame is serialized once, at flush: the provider's per-delta
//! cost is a `Value` clone (the snapshot it already built), not a
//! full-payload serialization.
//!
//! The supervisor stays payload-free: coalescing happens in the worker, on
//! the worker -> client session-event stream (direct-attach or
//! supervisor-routed), before any broadcast.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use crate::protocol::{create_daemon_event_meta, DaemonOutbound};
use crate::worker::OutboundFrame;

/// One parked update flushes per interval; anything parked longer is a
/// stream stall, so this bounds both broadcast rate and update staleness.
pub(crate) const UPDATE_FLUSH_INTERVAL: Duration = Duration::from_millis(50);

/// The session identity a flushed frame is stamped with (the frame is
/// built at flush time, not at park time).
#[derive(Clone)]
struct SessionIdentity {
    active_session_id: String,
    generation: String,
}

/// The parked `message_update`: the newest full-message snapshot plus the
/// merged additive delta run of the superseded frames.
struct PendingUpdate {
    message: Value,
    /// The stream event kind of the parked run (`text_delta`, ...).
    kind: String,
    /// The concatenated delta text of every merged frame of the same kind.
    delta: String,
    /// The broadcast sequence the newest parked frame consumed.
    sequence: u64,
}

/// Single-slot coalescer for one turn's `message_update` frames. Shared
/// between the turn's emit path (park/direct-send) and the flusher task;
/// every broadcast happens under `inner`, so frame order is total.
pub(crate) struct TurnStreamCoalescer {
    inner: Mutex<CoalescerInner>,
    session: SessionIdentity,
}

struct CoalescerInner {
    /// The latest parked update. Replaced by newer snapshots of the same
    /// stream-event kind (their delta text merges into `delta`).
    pending: Option<PendingUpdate>,
    /// The turn ended: park no more, flush nothing, stop the flusher.
    closed: bool,
}

impl TurnStreamCoalescer {
    pub(crate) fn new(active_session_id: String, generation: String) -> Self {
        TurnStreamCoalescer {
            inner: Mutex::new(CoalescerInner {
                pending: None,
                closed: false,
            }),
            session: SessionIdentity {
                active_session_id,
                generation,
            },
        }
    }

    /// Park one `message_update` frame: the newest full-message snapshot
    /// wins, and the frame's delta text merges into the parked run (same
    /// kind) or starts a fresh run (a `*_start` event carries no delta, so
    /// a kind switch never loses text). Returns `false` when the turn
    /// already ended (the caller drops the frame instead of broadcasting a
    /// stale streaming event).
    pub(crate) fn park_update(
        &self,
        message: Value,
        kind: &str,
        delta: &str,
        sequence: u64,
    ) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.closed {
            return false;
        }
        match &mut inner.pending {
            // Same kind: the newer snapshot wins and its delta text joins
            // the run (deltas are additive for delta-mapping consumers).
            Some(pending) if pending.kind == kind => {
                pending.delta.push_str(delta);
                pending.message = message;
                pending.sequence = sequence;
            }
            // Kind switch: the newer snapshot wins whole. A `*_start`
            // event carries no delta, so nothing additive is lost.
            _ => {
                inner.pending = Some(PendingUpdate {
                    message,
                    kind: kind.to_string(),
                    delta: delta.to_string(),
                    sequence,
                });
            }
        }
        true
    }

    /// Broadcast every `payloads` frame directly, after flushing any parked
    /// update first (the parked snapshot is ordered before the frames that
    /// supersede it). All sends happen under the coalescer lock, so the
    /// flusher can never interleave between the parked update and its
    /// settling frame.
    pub(crate) fn send_direct(&self, payloads: &[Vec<u8>], events: &crate::worker::EventPump) {
        let mut inner = self.inner.lock().unwrap();
        self.flush_locked(&mut inner, events);
        for payload in payloads {
            events.send(OutboundFrame::session_event(payload.clone()));
        }
    }

    /// Flusher tick: broadcast the parked update when one is waiting.
    /// Returns `false` once the turn closed and the flusher should stop.
    pub(crate) fn flush_pending(&self, events: &crate::worker::EventPump) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.closed {
            return false;
        }
        self.flush_locked(&mut inner, events);
        true
    }

    /// End of turn: nothing parked after this point is broadcast (an aborted
    /// turn's stale partial must not appear after its settle events), and
    /// anything still parked is dropped.
    pub(crate) fn close(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.closed = true;
        inner.pending = None;
    }

    /// Serialize and broadcast the parked update (the caller holds `inner`).
    fn flush_locked(&self, inner: &mut CoalescerInner, events: &crate::worker::EventPump) {
        let Some(pending) = inner.pending.take() else {
            return;
        };
        let mut event = json!({
            "type": "message_update",
            "message": pending.message,
        });
        if !pending.kind.is_empty() {
            let mut stream_event = json!({ "type": pending.kind });
            if !pending.delta.is_empty() {
                stream_event["delta"] = json!(pending.delta);
            }
            event["assistantMessageEvent"] = stream_event;
        }
        let meta = create_daemon_event_meta(
            &self.session.active_session_id,
            pending.sequence,
            None,
            Some(&self.session.generation),
        );
        let outbound = DaemonOutbound::SessionEvent {
            active_session_id: self.session.active_session_id.clone(),
            event,
            meta: Some(meta),
            rest: Default::default(),
        };
        let payload = serde_json::to_vec(&outbound).unwrap_or_default();
        events.send(OutboundFrame::session_event(payload));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_payload(event: &Value) -> Vec<u8> {
        serde_json::to_vec(&json!({ "event": event })).unwrap_or_default()
    }

    fn subscribe() -> (
        crate::worker::EventPump,
        broadcast::Receiver<Arc<OutboundFrame>>,
    ) {
        let pump = crate::worker::EventPump::new();
        let rx = pump.subscribe();
        (pump, rx)
    }

    fn session_event_of(frame: std::sync::Arc<OutboundFrame>) -> Value {
        serde_json::from_slice::<Value>(&frame.payload).expect("session event payload")
    }

    use std::sync::Arc;
    use tokio::sync::broadcast;

    #[test]
    fn direct_sends_flush_the_parked_update_first() {
        let (pump, mut rx) = subscribe();
        let coalescer = TurnStreamCoalescer::new("s1".to_string(), "g1".to_string());
        assert!(coalescer.park_update(json!({ "text": "partial" }), "text_delta", "part", 1));
        // The parked update waits for the flusher until a direct frame
        // arrives: the direct send must broadcast the parked snapshot first.
        coalescer.send_direct(&[event_payload(&json!({ "type": "message_end" }))], &pump);
        let first = session_event_of(rx.try_recv().unwrap());
        assert_eq!(first["event"]["type"], "message_update");
        assert_eq!(first["event"]["message"]["text"], "partial");
        let second = session_event_of(rx.try_recv().unwrap());
        assert_eq!(second["event"]["type"], "message_end");
        assert!(rx.try_recv().is_err(), "no further frames");
    }

    /// Superseded snapshots merge their delta text: a coalesced burst must
    /// still deliver the whole delta run to delta-mapping consumers (the
    /// ACP adapter), not just the last delta.
    #[test]
    fn a_newer_snapshot_merges_the_superseded_deltas() {
        let (pump, mut rx) = subscribe();
        let coalescer = TurnStreamCoalescer::new("s1".to_string(), "g1".to_string());
        assert!(coalescer.park_update(json!({ "text": "The" }), "text_delta", "The ", 1));
        assert!(coalescer.park_update(json!({ "text": "The Thames" }), "text_delta", "Thames ", 2));
        assert!(coalescer.park_update(
            json!({ "text": "The Thames flows" }),
            "text_delta",
            "flows",
            3
        ));
        assert!(coalescer.flush_pending(&pump));
        let flushed = session_event_of(rx.try_recv().unwrap());
        assert_eq!(flushed["event"]["message"]["text"], "The Thames flows");
        assert_eq!(
            flushed["event"]["assistantMessageEvent"]["delta"],
            "The Thames flows"
        );
        // The flushed frame carries the newest frame's broadcast sequence.
        assert_eq!(flushed["meta"]["sequence"], 3);
        assert!(
            rx.try_recv().is_err(),
            "the superseded snapshots are merged"
        );
    }

    /// A kind switch (a `*_start` event carries no delta) starts a fresh
    /// run without losing the merged text of the previous kind: the newer
    /// snapshot wins, the previous kind's delta run is superseded whole.
    #[test]
    fn a_kind_switch_replaces_the_run() {
        let (pump, mut rx) = subscribe();
        let coalescer = TurnStreamCoalescer::new("s1".to_string(), "g1".to_string());
        assert!(coalescer.park_update(json!({ "text": "think" }), "thinking_delta", "think", 1));
        assert!(coalescer.park_update(json!({ "text": "thinkanswer" }), "text_delta", "answer", 2));
        coalescer.send_direct(&[event_payload(&json!({ "type": "turn_end" }))], &pump);
        let flushed = session_event_of(rx.try_recv().unwrap());
        assert_eq!(
            flushed["event"]["assistantMessageEvent"]["type"],
            "text_delta"
        );
        assert_eq!(flushed["event"]["assistantMessageEvent"]["delta"], "answer");
        let direct = session_event_of(rx.try_recv().unwrap());
        assert_eq!(direct["event"]["type"], "turn_end");
        assert!(
            rx.try_recv().is_err(),
            "no frames beyond the flushed run and the direct one"
        );
    }

    #[test]
    fn close_stops_parking_and_flushing() {
        let (pump, mut rx) = subscribe();
        let coalescer = TurnStreamCoalescer::new("s1".to_string(), "g1".to_string());
        assert!(coalescer.park_update(json!({ "text": "partial" }), "text_delta", "p", 1));
        coalescer.close();
        assert!(!coalescer.park_update(json!({ "text": "stale" }), "text_delta", "s", 2));
        assert!(!coalescer.flush_pending(&pump), "the flusher stops");
        assert!(rx.try_recv().is_err(), "a closed turn parks nothing");
    }

    #[test]
    fn flush_without_parked_frames_is_a_kept_alive_noop() {
        let (pump, mut rx) = subscribe();
        let coalescer = TurnStreamCoalescer::new("s1".to_string(), "g1".to_string());
        assert!(coalescer.flush_pending(&pump));
        assert!(rx.try_recv().is_err());
    }
}
