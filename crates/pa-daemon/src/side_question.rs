//! The worker's live side-question runs.
//!
//! Port of the TS daemon-mode side-question surface: the run registry
//! (`sideQuestionRuns`), the `start_side_question`/`abort_side_question`
//! handlers with their exact error strings, and the `side_question_event`
//! frames the worker pushes to the supervisor. The LLM turn itself is one
//! `SessionEngine::run_side_question` call; this module owns everything
//! around it (guards, abort, events, registry lifetime).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::engine::{
    side_question_event_value, SessionEngine, SideQuestionOutcome, SideQuestionRequest,
    SIDE_QUESTION_STATUS_RUNNING,
};
use crate::protocol::{response_failure, response_success, DaemonOutbound, DaemonResponse};
use crate::worker::{EventPump, OutboundFrame};
use pa_core::session_engine::side_question::{SideQuestionSink, SideQuestionTurn};

/// A live run (TS `sideQuestionRuns` entries): which client owns it and how
/// to abort it.
struct SideQuestionRun {
    client_id: String,
    abort: pa_agent::abort::AbortController,
}

/// The worker's side-question machinery: registry plus the command handlers.
pub(crate) struct SideQuestionManager {
    engine: Arc<dyn SessionEngine>,
    events: Arc<EventPump>,
    active_session_id: String,
    runs: Arc<Mutex<HashMap<String, SideQuestionRun>>>,
    /// Set (under the registry lock) once a close path (`shutdown`, `kill`)
    /// begins aborting: the close must own the registry's tail — no run may
    /// be admitted after the aborts, or its pane would wedge on a turn no
    /// terminal event will ever settle when the worker exits.
    closing: AtomicBool,
}

impl SideQuestionManager {
    pub(crate) fn new(
        engine: Arc<dyn SessionEngine>,
        events: Arc<EventPump>,
        active_session_id: String,
    ) -> Self {
        SideQuestionManager {
            engine,
            events,
            active_session_id,
            runs: Arc::new(Mutex::new(HashMap::new())),
            closing: AtomicBool::new(false),
        }
    }

    /// `start_side_question` (TS handler): one run per client per session;
    /// the response acknowledges before the run answers, results stream as
    /// `side_question_event` frames.
    pub(crate) fn start(&self, payload: &Value) -> DaemonResponse {
        let side_question_id = payload
            .get("sideQuestionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if side_question_id.is_empty() {
            return response_failure(
                None,
                "start_side_question",
                "Side question id is required",
                None,
            );
        }
        let question = payload
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if question.is_empty() {
            return response_failure(
                None,
                "start_side_question",
                "Question cannot be empty",
                None,
            );
        }
        let client_id = payload
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or("anonymous")
            .to_string();
        let previous_turns: Vec<SideQuestionTurn> = payload
            .get("previousTurns")
            .and_then(Value::as_array)
            .map(|turns| {
                turns
                    .iter()
                    .filter_map(|turn| serde_json::from_value(turn.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        let controller = pa_agent::abort::AbortController::new();
        {
            let mut runs = self.runs.lock().unwrap();
            // The admission check rides the registry lock: `abort_all` sets
            // `closing` under the same lock before it aborts, so a start is
            // either admitted before the close's aborts (and aborted with
            // the rest) or rejected once the close owns the registry.
            if self.closing.load(Ordering::SeqCst) {
                return response_failure(
                    None,
                    "start_side_question",
                    &format!("Active session {} is closing", self.active_session_id),
                    None,
                );
            }
            if runs.contains_key(&side_question_id) {
                return response_failure(
                    None,
                    "start_side_question",
                    &format!("Side question already exists: {side_question_id}"),
                    None,
                );
            }
            if runs.values().any(|run| run.client_id == client_id) {
                return response_failure(
                    None,
                    "start_side_question",
                    "A side question is already running for this client and session",
                    None,
                );
            }
            runs.insert(
                side_question_id.clone(),
                SideQuestionRun {
                    client_id,
                    abort: controller.clone(),
                },
            );
        }
        self.spawn_run(side_question_id, question, previous_turns, controller);
        response_success(None, "start_side_question", None)
    }

    /// `abort_side_question` (TS handler): only the owner client can abort.
    pub(crate) fn abort(&self, payload: &Value) -> DaemonResponse {
        let side_question_id = payload
            .get("sideQuestionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let client_id = payload
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or("anonymous")
            .to_string();
        let runs = self.runs.lock().unwrap();
        let aborted = match runs.get(&side_question_id) {
            Some(run) if run.client_id == client_id => {
                run.abort.abort();
                true
            }
            _ => false,
        };
        response_success(
            None,
            "abort_side_question",
            Some(json!({ "aborted": aborted })),
        )
    }

    /// Abort every run owned by `client_id` (TS `abortSideQuestionsFor`),
    /// the detach path. The entries STAY registered: each run emits its
    /// terminal cancelled event and then drops its own entry, so the
    /// registry only drains after the frames queued — a detach racing a
    /// close cannot empty the registry underneath the close's settle and
    /// let the worker exit before the cancelled events reached the pump.
    pub(crate) fn abort_for_client(&self, client_id: &str) {
        let runs = self.runs.lock().unwrap();
        for run in runs.values() {
            if run.client_id == client_id {
                run.abort.abort();
            }
        }
    }

    /// Abort every live run (session close) and close the admission gate.
    /// The run tasks observe the abort, emit their cancelled event, and
    /// drop their own registry entries as they settle; the terminal frame
    /// precedes the removal, so the drained registry means every cancelled
    /// event was queued. No run may be admitted after the gate closes: a
    /// start racing the close would wedge its pane on a turn no terminal
    /// event will ever settle when the worker exits.
    pub(crate) fn abort_all(&self) {
        let runs = self.runs.lock().unwrap();
        self.closing.store(true, Ordering::SeqCst);
        for run in runs.values() {
            run.abort.abort();
        }
    }

    /// Abort every live run and wait (bounded) for their terminal events to
    /// queue on the event pump. The close paths (`shutdown`, `kill`) must
    /// deliver the cancelled events before the process exits: TS
    /// `closeSession` aborts the session's side questions per attached
    /// client, and each run's `done` chain writes the cancelled event before
    /// the client sockets end — the client releases its follow-up guard and
    /// renders the cancelled turn instead of waiting on a run whose worker
    /// is gone.
    pub(crate) async fn abort_all_and_settle(&self, settle_timeout: Duration) {
        self.abort_all();
        let deadline = tokio::time::Instant::now() + settle_timeout;
        loop {
            let drained = self.runs.lock().unwrap().is_empty();
            if drained || tokio::time::Instant::now() >= deadline {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Spawn the run task: the engine call runs on a blocking thread while
    /// the task emits the event frames and owns the registry lifetime.
    fn spawn_run(
        &self,
        side_question_id: String,
        question: String,
        previous_turns: Vec<SideQuestionTurn>,
        controller: pa_agent::abort::AbortController,
    ) {
        let engine = Arc::clone(&self.engine);
        let runs = Arc::clone(&self.runs);
        let sink_events = self.events.clone();
        let sink_active_session_id = self.active_session_id.clone();
        let events = self.events.clone();
        let active_session_id = self.active_session_id.clone();
        let sink_request = SideQuestionRequest {
            side_question_id: side_question_id.clone(),
            question: question.clone(),
            previous_turns: Vec::new(),
        };
        let engine_request = SideQuestionRequest {
            side_question_id: side_question_id.clone(),
            question: question.clone(),
            previous_turns,
        };
        // The streaming sink emits one running event per partial answer.
        let sink: SideQuestionSink = Arc::new(move |answer| {
            let event = side_question_event_value(
                &sink_request,
                answer,
                SIDE_QUESTION_STATUS_RUNNING,
                None,
            );
            emit_side_question_frame(&sink_events, &sink_active_session_id, event);
            true
        });
        tokio::spawn(async move {
            // The run opens with a running event before the engine streams
            // anything (TS emits `running` at the start of the done chain).
            let initial = SideQuestionRequest {
                side_question_id: side_question_id.clone(),
                question: question.clone(),
                previous_turns: Vec::new(),
            };
            emit_side_question_frame(
                &events,
                &active_session_id,
                side_question_event_value(&initial, "", SIDE_QUESTION_STATUS_RUNNING, None),
            );
            let outcome = {
                let engine = Arc::clone(&engine);
                let signal = controller.signal();
                let sink = Arc::clone(&sink);
                tokio::task::spawn_blocking(move || {
                    engine.run_side_question(engine_request, &signal, &sink)
                })
                .await
            };
            let outcome = outcome.unwrap_or_else(|join_error| SideQuestionOutcome::Failed {
                answer: String::new(),
                error: format!("side question run failed: {join_error}"),
            });
            let event_request = SideQuestionRequest {
                side_question_id: side_question_id.clone(),
                question,
                previous_turns: Vec::new(),
            };
            let event = side_question_event_value(
                &event_request,
                outcome.answer(),
                outcome.status_str(),
                outcome.error_message(),
            );
            // The terminal frame queues BEFORE the registry entry drops (TS
            // deletes the run inside the terminal emit itself), so a close
            // path waiting on the drained registry also knows every terminal
            // event reached the event pump.
            emit_side_question_frame(&events, &active_session_id, event);
            runs.lock().unwrap().remove(&side_question_id);
        });
    }
}

/// Broadcast one `side_question_event` frame for the worker's session.
fn emit_side_question_frame(events: &Arc<EventPump>, active_session_id: &str, event: Value) {
    let outbound = DaemonOutbound::SideQuestionEvent {
        active_session_id: active_session_id.to_string(),
        event,
        rest: Map::default(),
    };
    let payload = serde_json::to_vec(&outbound).unwrap_or_default();
    events.send(OutboundFrame::side_question_event(payload));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{
        BranchSummaryOutcome, BranchSummaryRequest, CompactionOutcome, CompactionRequest,
        EngineEvent, PromptRequest, SessionEngine, SideQuestionOutcome, SideQuestionRequest,
    };

    /// A side-question engine that parks until the abort lands, then settles
    /// cancelled with the partial answer still streamed (the real engine's
    /// teardown shape: the signal races the provider stream).
    struct AbortableEngine;

    impl SessionEngine for AbortableEngine {
        fn run_prompt(
            &self,
            _prompt_index: usize,
            _request: PromptRequest,
            _aborted: &dyn Fn() -> bool,
            emit: &mut dyn FnMut(EngineEvent) -> bool,
        ) {
            emit(EngineEvent::Done(Ok(())));
        }

        fn run_side_question(
            &self,
            _request: SideQuestionRequest,
            signal: &pa_agent::abort::AbortSignal,
            _sink: &pa_core::session_engine::side_question::SideQuestionSink,
        ) -> SideQuestionOutcome {
            while !signal.is_aborted() {
                std::thread::sleep(Duration::from_millis(5));
            }
            SideQuestionOutcome::Aborted {
                answer: "partial".to_string(),
            }
        }

        fn run_compaction(
            &self,
            _request: CompactionRequest,
            _signal: &pa_agent::abort::AbortSignal,
        ) -> CompactionOutcome {
            CompactionOutcome::Skipped {
                message: "nothing to compact".to_string(),
            }
        }

        fn run_branch_summary(
            &self,
            _request: BranchSummaryRequest,
            _signal: &pa_agent::abort::AbortSignal,
        ) -> BranchSummaryOutcome {
            BranchSummaryOutcome::Failed {
                error: "unsupported".to_string(),
            }
        }

        fn rebuild_session_context(
            &self,
            _branch_entries: Vec<pa_types::session::FileEntry>,
            _goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    fn start_payload(id: &str, client: &str) -> Value {
        json!({
            "sideQuestionId": id,
            "clientId": client,
            "question": "what?",
        })
    }

    /// The close paths (`shutdown`, `kill`) abort every live run and wait
    /// for the cancelled events to queue before the process exits: the
    /// settle returns only after the terminal frame reached the pump and the
    /// registry drained, so the client releases its follow-up guard (TS
    /// `closeSession`'s `abortSideQuestionsFor`).
    #[tokio::test]
    async fn shutdown_settle_queues_the_cancelled_events() {
        let pump = Arc::new(EventPump::new());
        let mut receiver = pump.subscribe();
        let manager = SideQuestionManager::new(
            Arc::new(AbortableEngine),
            Arc::clone(&pump),
            "sess-1".to_string(),
        );
        let response = manager.start(&start_payload("sq-1", "client-1"));
        assert!(response.success, "{response:?}");

        manager.abort_all_and_settle(Duration::from_secs(2)).await;

        let mut statuses = Vec::new();
        while let Ok(frame) = receiver.try_recv() {
            let payload: Value = serde_json::from_slice(&frame.payload).unwrap();
            let event = payload.get("event").expect("side question event");
            statuses.push(
                event
                    .get("status")
                    .and_then(Value::as_str)
                    .expect("status")
                    .to_string(),
            );
        }
        assert_eq!(
            statuses,
            vec!["running".to_string(), "cancelled".to_string()],
            "the initial running event and the terminal cancelled event both queued"
        );
        assert!(
            manager.runs.lock().unwrap().is_empty(),
            "the settled run left the registry"
        );
    }

    /// A close owns the registry's tail: once the aborts began, a racing
    /// start is rejected instead of being admitted into a worker about to
    /// exit (its pane would wedge on a turn no terminal event will ever
    /// settle). The gate rides the registry lock, so a start is either
    /// admitted before the aborts and aborted with the rest or rejected.
    #[tokio::test]
    async fn start_during_the_close_is_rejected() {
        let pump = Arc::new(EventPump::new());
        let manager = SideQuestionManager::new(
            Arc::new(AbortableEngine),
            Arc::clone(&pump),
            "sess-1".to_string(),
        );
        let response = manager.start(&start_payload("sq-1", "client-1"));
        assert!(response.success, "{response:?}");

        manager.abort_all_and_settle(Duration::from_secs(2)).await;

        let late = manager.start(&start_payload("sq-2", "client-1"));
        assert!(!late.success, "a start after the close began is rejected");
        assert!(
            late.error
                .as_deref()
                .is_some_and(|message| message.contains("is closing")),
            "the rejection says the session is closing: {late:?}"
        );
    }

    /// The detach abort keeps the registry entry until the run's terminal
    /// cancelled event queued: a detach racing a close must not empty the
    /// registry underneath the close's settle, or the worker could exit
    /// before the cancelled frames reached the pump.
    #[tokio::test]
    async fn detach_abort_settles_the_entry_it_aborts() {
        let pump = Arc::new(EventPump::new());
        let mut receiver = pump.subscribe();
        let manager = SideQuestionManager::new(
            Arc::new(AbortableEngine),
            Arc::clone(&pump),
            "sess-1".to_string(),
        );
        let response = manager.start(&start_payload("sq-1", "client-1"));
        assert!(response.success, "{response:?}");

        manager.abort_for_client("client-1");

        // The aborted run settles on its own: the terminal frame queues and
        // the entry drops after it (bounded by the engine's abort latency).
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !manager.runs.lock().unwrap().is_empty() {
            assert!(
                std::time::Instant::now() < deadline,
                "the detached run's entry never settled out of the registry"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let mut statuses = Vec::new();
        while let Ok(frame) = receiver.try_recv() {
            let payload: Value = serde_json::from_slice(&frame.payload).unwrap();
            let event = payload.get("event").expect("side question event");
            statuses.push(
                event
                    .get("status")
                    .and_then(Value::as_str)
                    .expect("status")
                    .to_string(),
            );
        }
        assert_eq!(
            statuses,
            vec!["running".to_string(), "cancelled".to_string()],
            "the detached run still queued its terminal cancelled event"
        );
    }
}
