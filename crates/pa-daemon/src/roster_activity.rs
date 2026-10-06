//! Worker-side roster activity feed: keeps the supervisor's roster fresh
//! mid-turn. The port watches the worker's event pump and feeds a
//! coalescing push queue whose single consumer composes the summary
//! fresh at flush time and ships one `worker_roster_delta` per burst.

use std::sync::Arc;

use crate::worker::{EventPump, OutboundFrame};

/// Disables the worker's roster pushes (tests and local harness runs
/// that spin workers without a supervisor).
pub(crate) const ROSTER_PUSH_DISABLE_ENV: &str = "PA_WORKER_DISABLE_ROSTER_PUSH";

/// The session event types that trigger a roster flush: each edge moves
/// a summary field the roster consumers render (`thinking_level_changed`
/// has no Rust frame yet; it stays listed for when it does).
pub(crate) const ROSTER_SESSION_EVENT_TRIGGERS: &[&str] = &[
    "turn_start",
    "turn_end",
    "bash_start",
    "bash_end",
    "compaction_start",
    "compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "tool_execution_start",
    "tool_execution_end",
    "message_end",
    "session_action_update",
    "session_info_changed",
    "thinking_level_changed",
];

/// Whether one broadcast frame triggers a roster flush: session events by event type, plus the
/// `session_closed`/`session_replaced` payload tags, which the worker frames as session events.
pub(crate) fn frame_triggers_roster_flush(frame: &OutboundFrame) -> bool {
    #[derive(serde::Deserialize)]
    struct Envelope<'a> {
        #[serde(rename = "type", borrow)]
        kind: &'a str,
        #[serde(borrow, default)]
        event: Option<EventType<'a>>,
    }
    #[derive(serde::Deserialize)]
    struct EventType<'a> {
        #[serde(rename = "type", borrow)]
        kind: &'a str,
    }
    if frame.outbound_type != "session_event" {
        return false;
    }
    // The payload is parsed only for session-event frames, so a
    // non-trigger frame costs one discriminant check.
    match serde_json::from_slice::<Envelope>(&frame.payload) {
        Ok(envelope) => match envelope.kind {
            "session_closed" | "session_replaced" => true,
            _ => envelope
                .event
                .is_some_and(|event| ROSTER_SESSION_EVENT_TRIGGERS.contains(&event.kind)),
        },
        Err(_) => false,
    }
}

/// The coalescing roster push queue: producers set one pending flag; the
/// single consumer composes the summary fresh at flush time — one
/// `worker_roster_delta` per burst, the backlog bounded at one request.
pub(crate) struct RosterPushQueue {
    inner: Option<Arc<PushState>>,
}

/// The shared hand-off: one pending flag (the whole backlog) and the
/// notify that wakes the consumer when the flag turns true.
struct PushState {
    notify: tokio::sync::Notify,
    pending: std::sync::atomic::AtomicBool,
}

impl Clone for RosterPushQueue {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl RosterPushQueue {
    /// The queue with no consumer: pushes are no-ops (no supervisor
    /// endpoint, or [`ROSTER_PUSH_DISABLE_ENV`]).
    pub(crate) fn disabled() -> Self {
        Self { inner: None }
    }

    /// Enqueue one flush request: the first request of a burst wakes
    /// the consumer, every later one only keeps the flag set.
    pub(crate) fn push(&self) {
        let Some(state) = &self.inner else {
            return;
        };
        if !state
            .pending
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            state.notify.notify_one();
        }
    }

    /// Spawn the flush consumer: flushes serialize here, so a wedged
    /// supervisor delays pushes but never reorders them.
    pub(crate) fn spawn(context: crate::worker::RosterPushContext) -> Self {
        if std::env::var_os(ROSTER_PUSH_DISABLE_ENV).is_some()
            || context.worker_token.is_empty()
            || context.roster_link.socket_path().as_os_str().is_empty()
        {
            return Self::disabled();
        }
        let state = Arc::new(PushState {
            notify: tokio::sync::Notify::new(),
            pending: std::sync::atomic::AtomicBool::new(false),
        });
        let consumer = Arc::clone(&state);
        tokio::spawn(async move {
            loop {
                consumer.notify.notified().await;
                // One flush per burst: a request that lands mid-flush
                // re-arms the flag and stores a notify permit.
                consumer
                    .pending
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                crate::worker::push_roster_delta(&context);
            }
        });
        Self { inner: Some(state) }
    }
}

/// The children watcher: a session whose RLM children start or finish
/// changes its own summary (it stays working while any child runs), so
/// every flip of the registry's running verdict enqueues a flush request.
/// The watcher ends when the children registry goes away.
pub(crate) fn spawn_running_children_watch(
    children: &crate::rlm_children::SupervisorChildSessions,
    queue: RosterPushQueue,
) {
    if queue.inner.is_none() {
        return;
    }
    let mut running = children.subscribe_running();
    tokio::spawn(async move {
        while running.changed().await.is_ok() {
            queue.push();
        }
    });
}

/// The pump watcher (TS `observeRosterEvent`): every trigger frame that
/// flows through the worker's event pump enqueues a flush request. The
/// watcher owns a receiver on the pump's broadcast, so it ends with the
/// worker's process (a worker serves one session for its lifetime).
pub(crate) fn spawn_roster_activity_watch(events: &Arc<EventPump>, queue: RosterPushQueue) {
    if queue.inner.is_none() {
        return;
    }
    let mut frames = events.subscribe();
    tokio::spawn(async move {
        loop {
            // `Lagged` only means frames were skipped under a burst: one
            // catch-up flush request keeps the feed converging; only a
            // closed pump ends the watcher.
            match frames.recv().await {
                Ok(frame) => {
                    if frame_triggers_roster_flush(&frame) {
                        queue.push();
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => queue.push(),
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    // The socket-harness test below is the only user of these; the
    // import gates keep the portable tests above import-clean on
    // non-unix targets.
    #[cfg(unix)]
    use crate::supervisor_link::SupervisorLink;
    use serde_json::json;
    #[cfg(unix)]
    use serde_json::Value;
    #[cfg(unix)]
    use std::sync::Mutex;
    #[cfg(unix)]
    use std::time::Duration;

    fn session_event_frame(event: &serde_json::Value) -> OutboundFrame {
        let payload = json!({
            "type": "session_event",
            "activeSessionId": "session-1",
            "event": event,
        });
        OutboundFrame::session_event(serde_json::to_vec(&payload).unwrap())
    }

    #[test]
    fn every_ts_trigger_event_type_flushes() {
        for event_type in ROSTER_SESSION_EVENT_TRIGGERS {
            let frame = session_event_frame(&json!({ "type": event_type }));
            assert!(
                frame_triggers_roster_flush(&frame),
                "{event_type} must trigger a roster flush"
            );
        }
    }

    #[test]
    fn non_trigger_events_and_frame_kinds_stay_silent() {
        for event_type in [
            "message_start",
            "message_update",
            "tool_execution_update",
            "agent_start",
            "agent_end",
            "goal_update",
            "ipython_sent_agent_message",
        ] {
            let frame = session_event_frame(&json!({ "type": event_type }));
            assert!(
                !frame_triggers_roster_flush(&frame),
                "{event_type} must not trigger a roster flush"
            );
        }
        // The non-`session_event` frame kinds the pump carries: a side
        // question does not.
        let side_question_payload = serde_json::to_vec(&json!({
            "type": "side_question_event",
            "activeSessionId": "s",
            "event": { "type": "message_end" },
        }))
        .unwrap();
        assert!(!frame_triggers_roster_flush(
            &OutboundFrame::side_question_event(side_question_payload)
        ));
        // The worker frames `session_closed` payloads as session
        // events: the payload tag flushes.
        let closed_payload = serde_json::to_vec(&json!({
            "type": "session_closed",
            "activeSessionId": "s",
            "reason": "done",
        }))
        .unwrap();
        assert!(frame_triggers_roster_flush(&OutboundFrame::session_event(
            closed_payload
        )));
        let replaced_payload = serde_json::to_vec(&json!({
            "type": "session_replaced",
            "activeSessionId": "s",
        }))
        .unwrap();
        assert!(frame_triggers_roster_flush(&OutboundFrame::session_event(
            replaced_payload
        )));
    }

    #[test]
    fn the_disabled_queue_never_pushes() {
        let queue = RosterPushQueue::disabled();
        queue.push();
    }

    /// One pending flag bounds the backlog: a burst behind a slow
    /// supervisor collapses into a couple of flushes with the latest state.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_burst_collapses_behind_a_slow_supervisor() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let recorded = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = Arc::clone(&recorded);
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let sink = Arc::clone(&sink);
                tokio::spawn(async move {
                    let (reader, mut writer) = stream.into_split();
                    writer
                        .write_all(
                            br#"{"type":"daemon_hello"}
"#,
                        )
                        .await
                        .unwrap();
                    let mut lines = BufReader::new(reader);
                    loop {
                        let mut line = String::new();
                        if lines.read_line(&mut line).await.unwrap_or(0) == 0 {
                            return;
                        }
                        if line.trim().is_empty() {
                            continue;
                        }
                        let Ok(request) = serde_json::from_str::<Value>(line.trim()) else {
                            continue;
                        };
                        // A slow supervisor: the answer lags every request.
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        sink.lock()
                            .unwrap()
                            .push(request["command"]["summary"].clone());
                        let response = serde_json::to_string(&crate::protocol::response_line(
                            &crate::protocol::response_success(
                                request["id"].as_str(),
                                "worker_roster_delta",
                                None,
                            ),
                        ))
                        .unwrap();
                        writer.write_all(response.as_bytes()).await.unwrap();
                        writer.write_all(b"\n").await.unwrap();
                    }
                });
            }
        });
        let engine: Arc<dyn crate::engine::SessionEngine> =
            Arc::new(crate::engine::ScriptedEngine::default());
        let queue = RosterPushQueue::spawn(crate::worker::RosterPushContext {
            core: Arc::new(Mutex::new(crate::worker::SessionCore::test_core(
                None,
                "/tmp".to_string(),
            ))),
            engine,
            user_bash: Arc::new(crate::user_bash::UserBash::new()),
            roster_link: Arc::new(SupervisorLink::new(socket)),
            worker_token: "token".to_string(),
            worker_instance_id: "instance".to_string(),
            roster_delta_sequence: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            roster_push_order: Arc::new(Mutex::new(())),
        });
        for _ in 0..50 {
            queue.push();
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        let summaries = recorded.lock().unwrap().clone();
        assert!(
            !summaries.is_empty(),
            "the queue never flushed behind the slow supervisor"
        );
        assert!(
            summaries.len() <= 3,
            "the burst did not collapse behind the slow supervisor: {} flushes",
            summaries.len()
        );
        assert_eq!(
            summaries.last().cloned().unwrap_or(Value::Null)["activity"],
            json!("idle"),
            "the flush composed a stale or wrong state: {summaries:?}"
        );
        server.abort();
    }
}
