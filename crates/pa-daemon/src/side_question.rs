//! The worker's live side-question runs.
//!
//! Port of the TS daemon-mode side-question surface: the run registry
//! (`sideQuestionRuns`), the `start_side_question`/`abort_side_question`
//! handlers with their exact error strings, and the `side_question_event`
//! frames the worker pushes to the supervisor. The LLM turn itself is one
//! `SessionEngine::run_side_question` call; this module owns everything
//! around it (guards, abort, events, registry lifetime).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

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

    /// Abort and drop every run owned by `client_id` (TS
    /// `abortSideQuestionsFor`): used on detach and session close. The run
    /// tasks observe the abort, emit their cancelled event, and find the
    /// registry entry already gone.
    pub(crate) fn abort_for_client(&self, client_id: &str) {
        let mut runs = self.runs.lock().unwrap();
        let owned: Vec<String> = runs
            .iter()
            .filter(|(_, run)| run.client_id == client_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in owned {
            if let Some(run) = runs.remove(&id) {
                run.abort.abort();
            }
        }
    }

    /// Abort and drop every live run (session close).
    pub(crate) fn abort_all(&self) {
        let mut runs = self.runs.lock().unwrap();
        let ids: Vec<String> = runs.keys().cloned().collect();
        for id in ids {
            if let Some(run) = runs.remove(&id) {
                run.abort.abort();
            }
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
            // Every terminal event removes the run (TS deletes on
            // non-running events and on run failure).
            runs.lock().unwrap().remove(&side_question_id);
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
            emit_side_question_frame(&events, &active_session_id, event);
        });
    }
}

/// Broadcast one `side_question_event` frame for the worker's session.
fn emit_side_question_frame(events: &Arc<EventPump>, active_session_id: &str, event: Value) {
    let outbound = DaemonOutbound::SideQuestionEvent {
        active_session_id: active_session_id.to_string(),
        event,
        rest: Default::default(),
    };
    let payload = serde_json::to_vec(&outbound).unwrap_or_default();
    events.send(OutboundFrame::side_question_event(payload));
}
