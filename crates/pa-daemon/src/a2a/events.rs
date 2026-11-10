//! The daemon session-event pump: one consumer task that routes every
//! ordered `session_event` frame (tagged with its `activeSessionId`) to
//! the context's head task and translates it into A2A task state and
//! artifact chunks. The terminal settle rides the `PromptAndWait`
//! response (the worker flushes session events before the response
//! leaves its socket), so the pump owns exactly the streamed reply
//! text.
//!
//! Turn windows: each session's frames bracket into `turn_start` ..
//! `turn_end` windows (the worker's per-model-step boundary markers).
//! The window text — the step's assistant messages, joined by a blank
//! line — is the positional attribution a task's final artifact claims
//! at its prompt response when its run's accumulator holds no reply
//! (see `server.rs`), so a turn no A2A task owns never lands its text
//! in the next task's artifact: its window is claimed by no response.
//!
//! Run ownership: a worker delivery brackets `agent_start` ..
//! `agent_end` — one or MORE model-step windows (a tool-calling run
//! closes a window per tool round, and the run's reply is all of
//! them). The worker tags each `agent_start` with its run anchor's
//! delivery identity — the client admission id the delivery named,
//! the supervisor-assigned wire admission id, and the
//! engine-continuation source — and the pump resolves that identity
//! against the conversation's own state, never the session's shape
//! alone: the conversation's own delivery (its prompt, its retries —
//! the head task's own client admission id, matching the recorded wire
//! id) and the session's own engine continuation (a goal driver, a
//! post-compaction run) accumulate into the owning task; another
//! client's delivery on the shared session — a daemon prompt
//! (admission-named with ITS own id or not), a TUI user, an agent
//! message, a scheduled job — credits to nothing: its reply never
//! lands in the A2A task's artifact, history, or live stream. The one
//! residual: a foreign prompt written in the instant between the
//! session's idle answer and the task's prompt write can join the
//! same batch; the batch's run then carries the foreign anchor's
//! identity, its frames credit to nothing, and the positional window
//! claim answers the task (the documented idle-instant residual,
//! unchanged).
//!
//! A task's own first run (the run its prompt anchored) parks its
//! whole reply at `agent_end` — the response claims it however many
//! model steps the run closed.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::Mutex;

use super::server::A2aState;

/// One session's turn-window state: the open window's assistant text
/// and the FIFO of closed windows' texts, claimed in order by the
/// session's prompt responses (turns complete in FIFO order, and each
/// `PromptAndWait` response rides its own turn's completion). Each
/// closed window carries its close sequence number: a prompt response
/// claims the FIRST window closed after ITS dispatch anchor (the task's
/// own turn — a follow-up turn the daemon admitted at the same boundary
/// can interleave its frames before the response, and "the newest" would
/// steal that turn's reply).
#[derive(Debug, Default)]
pub(crate) struct TurnWindow {
    open: bool,
    text: String,
    closed: VecDeque<(u64, String)>,
    seq: u64,
}

/// The per-session turn-window table (the pump's attribution source).
#[derive(Debug, Default)]
pub(crate) struct TurnWindows {
    sessions: BTreeMap<String, TurnWindow>,
}

impl TurnWindows {
    /// Open a window (the session's turn started).
    fn open(&mut self, session_id: &str) {
        let window = self.sessions.entry(session_id.to_string()).or_default();
        window.open = true;
        window.text.clear();
    }

    /// One assistant message's text joined into the open window
    /// (messages separated by a blank line — the artifact rule).
    fn assistant_message(&mut self, session_id: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        let window = self.sessions.entry(session_id.to_string()).or_default();
        if !window.text.is_empty() {
            window.text.push_str("\n\n");
        }
        window.text.push_str(text);
    }

    /// Close the window and park its text for the task whose prompt
    /// response follows it. Only the newest parked windows stay (the
    /// claims are positional, so a turn no task owns never grows the
    /// table).
    fn close(&mut self, session_id: &str) {
        if let Some(window) = self.sessions.get_mut(session_id) {
            window.open = false;
            window.seq += 1;
            let seq = window.seq;
            window
                .closed
                .push_back((seq, std::mem::take(&mut window.text)));
            while window.closed.len() > 2 {
                window.closed.pop_front();
            }
        }
    }

    /// The close-sequence number the session's NEXT window will carry
    /// (the dispatch anchor a prompt's response claims after).
    pub(crate) fn next_seq(&self, session_id: &str) -> u64 {
        self.sessions
            .get(session_id)
            .map_or(1, |window| window.seq + 1)
    }

    /// Claim the session's newest closed window text (a run
    /// accumulator's step: the run's own windows, newest first).
    pub(crate) fn claim_closed(&mut self, session_id: &str) -> Option<String> {
        self.sessions
            .get_mut(session_id)
            .and_then(|window| window.closed.pop_back())
            .map(|(_, text)| text)
    }

    /// Claim the window the anchor names (the task's own turn: the
    /// flush barrier orders its response after its own frames, and the
    /// anchor — the close sequence the session's NEXT window carries,
    /// read at the prompt's dispatch — is exactly that turn's number,
    /// even when a follow-up turn the daemon admitted at the same
    /// boundary closed its window first). An evicted anchor window
    /// claims nothing: the streamed deltas are the reply authority
    /// then, never a foreign window.
    pub(crate) fn claim_after(&mut self, session_id: &str, anchor: u64) -> Option<String> {
        let window = self.sessions.get_mut(session_id)?;
        let position = window.closed.iter().position(|(seq, _)| *seq == anchor)?;
        window.closed.remove(position).map(|(_, text)| text)
    }

    /// Whether a window is open (frames outside a window credit to no
    /// task).
    fn is_open(&self, session_id: &str) -> bool {
        self.sessions
            .get(session_id)
            .is_some_and(|window| window.open)
    }

    /// Drop one session's window entry: the live-context bound's
    /// eviction ends the conversation (its binding leaves the table
    /// with the session), and a re-host re-keys the routing to the
    /// fresh worker's id — the abandoned key's entry is unreachable
    /// from both sides, so it leaves with the binding (the table
    /// stays a function of the live conversation set, never of every
    /// session id the pump ever saw).
    pub(crate) fn remove(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }
}

/// The class of the session's running delivery (the run anchor's own
/// identity, tagged on `agent_start` by the worker): the conversation's
/// own delivery (its prompt carries an admission id — the only
/// admission-named deliveries a cooperative daemon client writes on
/// this session), the session's own engine continuation (a goal
/// driver, a post-compaction run — the `engineContinuation` flag the
/// worker tags), or another client's delivery (a daemon prompt, a
/// TUI user, a `follow_up` — the run anchor names none of the
/// conversation's identities). A run's frames credit to a task only
/// through the first two; a foreign delivery's reply never lands in
/// the A2A task's artifact, history, or live stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunOwner {
    /// The A2A conversation's own delivery (its prompt, its
    /// retries): the run's frames credit to the task the delivery
    /// named — matched by identity, never by class.
    Admission,
    /// The session's own engine continuation (a goal driver, a
    /// post-compaction run): the run's frames credit to the head task
    /// waiting it out.
    Autonomous,
    /// Another client's delivery on the same session (a daemon
    /// prompt — admission-named or not — an agent message, a
    /// scheduled job): the run's frames credit to nothing.
    Foreign,
}

impl RunOwner {
    /// Whether the run's frames credit to the conversation's tasks.
    fn owned(self) -> bool {
        !matches!(self, Self::Foreign)
    }
}

/// The context's head task id when the head owns the session's
/// running turn — a task whose prompt response settled while the
/// daemon's autonomous continuation still owes turns
/// (`awaiting_completion`): the autonomous runs' bookkeeping keys on
/// it. The owner holds the queue head, so at most one task per
/// context ever owns.
fn run_owning_head(state: &A2aState, session_id: &str) -> Option<String> {
    let context = state.sessions.get(session_id)?;
    state
        .registry
        .head(context)
        .filter(|task| task.awaiting_completion())
        .map(|task| task.id.clone())
}

/// The context's head task while its prompt response has not settled
/// (dispatched, not yet awaiting its continuations): an engine
/// continuation that closed before the response parks its result on
/// it — the response's settle step applies the parked lot (the same
/// settlement a post-response continuation's `agent_end` owns), so a
/// lagging response never drops the session's own continuation
/// output or its outcome.
fn dispatched_head(state: &A2aState, session_id: &str) -> Option<String> {
    let context = state.sessions.get(session_id)?;
    state
        .registry
        .head(context)
        .filter(|task| {
            task.prompt_dispatched() && !task.state().is_terminal() && !task.awaiting_completion()
        })
        .map(|task| task.id.clone())
}

/// Resolve the run anchor's identity from its `agent_start` frame
/// against the conversation's own state: the worker tags every run
/// with its delivery's identity (the client admission id the delivery
/// named, the supervisor-assigned wire admission id, and the
/// engine-continuation source), and the credit follows the
/// IDENTITY, never the class — the head task's own admission is the
/// only one that credits, so another daemon client's admission-named
/// prompt on the shared session (its own admission id, its own wire
/// id) credits nothing, and an injected run that is not the session's
/// own continuation (an agent message, a scheduled job) credits
/// nothing either.
///
/// The match: the head task's delivery id (the unique admission id
/// this mode minted and sent with its prompt — never the public task
/// id) is what the frame's `clientAdmissionId` must carry; the wire
/// admission id the supervisor assigned is recorded at the first own
/// run and every later own run of the same delivery (a retry — the
/// re-emit carries the anchor's tags) must carry the same one. A
/// foreign delivery cannot spoof the client id: a client admission id
/// is unique only within one daemon connection, so the delivery id is
/// server-minted — another connection may reuse the task's public id
/// as its own admission, but no run it drives can carry this
/// conversation's delivery id, and its distinct wire id matches no
/// recorded one either.
fn resolve_run_start(
    state: &mut A2aState,
    session_id: &str,
    event: &Value,
) -> (RunOwner, Option<String>) {
    let context = state.sessions.get(session_id).cloned().unwrap_or_default();
    let client_admission = event.get("clientAdmissionId").and_then(Value::as_str);
    let wire_admission = event.get("admissionId").and_then(Value::as_str);
    if event.get("engineContinuation").and_then(Value::as_bool) == Some(true) {
        // A minted continuation carries the delivery id of the delivery
        // whose turn minted it (the worker stamps the running
        // delivery's id on every continuation it mints): the
        // conversation's own continuation names the task the credit
        // belongs to, and that identity stays with the run — a
        // foreign daemon client's engine continuation (its own goal
        // loop, minted behind ITS delivery on the shared session)
        // names its own id and credits nothing, exactly like its
        // prompt. An un-stamped continuation keeps the session-owned
        // credit (the head resolution below routes it).
        let credit_task =
            run_owning_head(state, session_id).or_else(|| dispatched_head(state, session_id));
        let credit_delivery = credit_task
            .as_deref()
            .and_then(|task_id| state.registry.task(task_id))
            .map(|task| task.delivery_id().to_string());
        let own = match (client_admission, credit_delivery.as_deref()) {
            (Some(client_admission), Some(credit)) => client_admission == credit,
            (Some(_), None) => false,
            (None, _) => true,
        };
        return (
            if own {
                RunOwner::Autonomous
            } else {
                RunOwner::Foreign
            },
            credit_task.filter(|_| own),
        );
    }
    let Some(head) = state.registry.head(&context) else {
        return (RunOwner::Foreign, None);
    };
    let recorded = head.wire_admission();
    let head_id = head.id.clone();
    let head_delivery = head.delivery_id().to_string();
    let own = match client_admission {
        // The frame's client admission id must carry the task's own
        // delivery id (the unique admission its prompt sent): another
        // daemon connection may reuse the task's PUBLIC id as its own
        // admission, and that run is foreign, whatever its wire id.
        Some(client_admission) => {
            client_admission == head_delivery
                && recorded.is_none_or(|recorded| wire_admission == Some(recorded))
        }
        // A retry carries the wire id alone (the re-emit carries the
        // anchor's).
        None => recorded.is_some_and(|recorded| wire_admission == Some(recorded)),
    };
    if !own {
        return (RunOwner::Foreign, None);
    }
    if let Some(wire_admission) = wire_admission.filter(|_| recorded.is_none()) {
        state
            .registry
            .record_wire_admission(&head_id, wire_admission);
    }
    (RunOwner::Admission, Some(head_id))
}

/// One session's in-flight run accumulation: the run's assistant text
/// (its windows joined) and its failure marker — collected while the
/// run belongs to the conversation (its own admission delivery, or
/// the session's own continuation).
#[derive(Debug, Default)]
struct RunAccumulator {
    owner: Option<RunOwner>,
    /// The task the run's frames credit to, resolved from the
    /// delivery's identity at the run's open (`Admission` runs only):
    /// stable across the frames — the state re-checks at each credit,
    /// but the IDENTITY never re-resolves (a head rotation mid-run
    /// must not redirect the run's frames to the next task).
    own_task: Option<String>,
    text: String,
    error: Option<String>,
    steps: usize,
}

/// The per-session run accumulators (the pump's own state; one open
/// accumulator per session while a run is in flight — the owner tags
/// what the run's close routes to).
#[derive(Debug, Default)]
pub(crate) struct RunAccumulators {
    sessions: BTreeMap<String, RunAccumulator>,
}

impl RunAccumulators {
    /// Begin a run's accumulation (its `agent_start`, whatever the
    /// delivery's class): the frames of one delivery bracket here
    /// (`agent_start` .. `agent_end`), and the anchor's class decides
    /// what they credit to.
    fn open(&mut self, session_id: &str, owner: Option<RunOwner>, own_task: Option<String>) {
        let accumulator = self.sessions.entry(session_id.to_string()).or_default();
        accumulator.owner = owner;
        accumulator.own_task = own_task;
        accumulator.text.clear();
        accumulator.error = None;
        accumulator.steps = 0;
    }

    /// The open run's owner (`None` when no run is in flight).
    fn owner(&self, session_id: &str) -> Option<RunOwner> {
        self.sessions
            .get(session_id)
            .and_then(|accumulator| accumulator.owner)
    }

    /// The open run's resolved own task (`Admission` runs; `None`
    /// otherwise).
    fn own_task(&self, session_id: &str) -> Option<String> {
        self.sessions
            .get(session_id)
            .and_then(|accumulator| accumulator.own_task.clone())
    }

    /// Whether an owned run is in flight on the session.
    fn owns_running_turn(&self, session_id: &str) -> bool {
        self.owner(session_id).is_some_and(RunOwner::owned)
    }

    /// One closed window of the open run (its `turn_end`): the window's
    /// text joins the run's reply (the artifact rule's blank line),
    /// and a failure marker on the boundary records the run's outcome.
    fn window_closed(&mut self, session_id: &str, text: Option<&str>, error: Option<&str>) {
        let Some(accumulator) = self.sessions.get_mut(session_id) else {
            return;
        };
        if let Some(error) = error {
            accumulator.error = Some(error.to_string());
        }
        if let Some(text) = text.filter(|text| !text.is_empty()) {
            // The join keys on text already landed, never on the step
            // count: a tool-call round's text-less window still bumps
            // `steps`, and joining on it would open a tool-first run's
            // reply with a blank line.
            if !accumulator.text.is_empty() {
                accumulator.text.push_str("\n\n");
            }
            accumulator.text.push_str(text);
        }
        accumulator.steps += 1;
    }

    /// The run's frames are done (its `agent_end`): the owner, reply
    /// text, and failure marker leave with the caller; the accumulator
    /// closes.
    fn close(&mut self, session_id: &str) -> Option<ClosedRun> {
        let accumulator = self.sessions.remove(session_id)?;
        Some(ClosedRun::from(accumulator))
    }

    /// A session's binding is gone (a re-host's re-key, a context's
    /// eviction): its run identities are unreachable past the removal
    /// — the open accumulator would never close (its frames route
    /// under the fresh id) — so the entry leaves with the binding,
    /// and the table stays bounded with the conversation set, never
    /// one entry per historical session id forever.
    pub(crate) fn drop_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }
}

/// One closed run's accrued outcome (the accumulator's close).
#[derive(Debug)]
struct ClosedRun {
    owner: Option<RunOwner>,
    own_task: Option<String>,
    text: String,
    error: Option<String>,
}

impl From<RunAccumulator> for ClosedRun {
    fn from(accumulator: RunAccumulator) -> Self {
        Self {
            owner: accumulator.owner,
            own_task: accumulator.own_task,
            text: accumulator.text,
            error: accumulator.error,
        }
    }
}

/// The failure of one `turn_end` boundary: the top-level `error` (the
/// fallback `Done` settle), the engine's real terminal shape
/// (`message.stopReason` carrying `error`/`errorMessage` — a provider
/// failure emits no top-level error), or the aborted stop reason (the
/// abort's shared settle text).
fn turn_end_error(event: &Value) -> Option<String> {
    if let Some(error) = event.get("error").and_then(Value::as_str) {
        return Some(error.to_string());
    }
    let message = event.get("message")?;
    match message.get("stopReason").and_then(Value::as_str) {
        Some("error") => Some(
            message
                .get("errorMessage")
                .and_then(Value::as_str)
                .unwrap_or("the turn failed")
                .to_string(),
        ),
        Some("aborted") => Some(crate::worker::ABORTED_TURN_SETTLE_ERROR.to_string()),
        _ => None,
    }
}

/// The joined text of one assistant `message_end` frame: its text
/// content blocks in order (the wire `content` array's `text` members).
fn assistant_message_text(event: &Value) -> Option<String> {
    let message = event.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let mut text = String::new();
    for block in message.get("content")?.as_array()? {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            text.push_str(
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
        }
    }
    Some(text)
}

/// Map one daemon `session_event` frame onto its context's head task.
///
/// The frames a prime-agent turn emits (see `pa_core::session_engine::
/// session_events::agent_event_json`): `turn_start`/`turn_end` bracket
/// one delivered batch; `message_start`/`message_update`/`message_end`
/// bracket assistant messages (the updates carrying
/// `assistantMessageEvent` deltas), `tool_execution_*` reports tool
/// runs. The A2A v1 surface maps the assistant text stream; tool
/// activity has no task-artifact surface in v1 (a status message would
/// leak provider-facing detail), so it maps to nothing — the same
/// discipline the ACP layer's default arm holds.
pub(crate) async fn on_session_event(state: &Arc<Mutex<A2aState>>, event: &Value) {
    let session_id = event
        .get("activeSessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let event = event.get("event").cloned().unwrap_or(Value::Null);
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let context_id = {
        let guard = state.lock().await;
        guard.sessions.get(&session_id).cloned().unwrap_or_default()
    };
    if context_id.is_empty() {
        return;
    }
    // The turn-window bookkeeping rides every known session's frames,
    // whether or not a task is queued (the pump owns attribution).
    match event_type {
        "agent_start" => {
            let mut guard = state.lock().await;
            // One delivery's run opened: the anchor's identity resolves
            // against the conversation's own state (see
            // `resolve_run_start`), and the frames' credit follows it.
            let (owner, own_task) = resolve_run_start(&mut guard, &session_id, &event);
            guard.runs.open(&session_id, Some(owner), own_task);
            return;
        }
        "turn_start" => {
            let mut guard = state.lock().await;
            guard.windows.open(&session_id);
            return;
        }
        "turn_end" => {
            let mut guard = state.lock().await;
            guard.windows.close(&session_id);
            // A run's window closed: into the open owned run's
            // accumulator (its claimed text and failure marker are the
            // run's, not the registry's yet — the prompt response's
            // claim source stays untouched); a foreign run's windows
            // stay parked, claimed by no one.
            if guard.runs.owns_running_turn(&session_id) {
                let error = turn_end_error(&event);
                let text = guard.windows.claim_closed(&session_id);
                guard
                    .runs
                    .window_closed(&session_id, text.as_deref(), error.as_deref());
            }
            return;
        }
        "agent_end" => {
            let mut guard = state.lock().await;
            let Some(closed) = guard.runs.close(&session_id) else {
                return;
            };
            let ClosedRun {
                owner,
                own_task,
                text,
                error,
            } = closed;
            let Some(owner) = owner.filter(|owner| owner.owned()) else {
                return;
            };
            match owner {
                RunOwner::Admission => {
                    // The conversation's own delivery closed. An owned
                    // run before the task's prompt response parks (the
                    // initial run's reply) for the response's claim
                    // step. The run's identity resolved at its open —
                    // the frames' credit and this close address the
                    // same task.
                    let Some(task_id) = own_task.filter(|id| {
                        guard
                            .registry
                            .task(id)
                            .is_some_and(|task| !task.state().is_terminal())
                    }) else {
                        return;
                    };
                    if guard
                        .registry
                        .task(&task_id)
                        .is_some_and(super::task::TaskEntry::awaiting_completion)
                    {
                        // An admission run whose response already
                        // settled (a retry of the task's own turn):
                        // the run extends the artifact like an
                        // autonomous continuation.
                        guard.registry.continuation_run_closed(
                            &task_id,
                            Some(text.as_str()),
                            error.as_deref(),
                        );
                    } else {
                        guard
                            .registry
                            .park_initial_run_reply(&task_id, Some(text.as_str()));
                    }
                }
                RunOwner::Autonomous => {
                    // The session's own continuation closed: the owning
                    // head takes the text (and the failure, carried to
                    // the final settlement). `run_owning_head` is the
                    // whole close-side resolution: a credited head that
                    // is not awaiting is still dispatched (its response
                    // has not settled), and the `dispatched_head` park
                    // below addresses it — the run's own identity
                    // (`own_task`, kept through the run for the LIVE
                    // route) resolves to the same task here, so no
                    // second resolution exists to add.
                    let Some(task_id) = run_owning_head(&guard, &session_id) else {
                        // The continuation closed before the task's
                        // prompt response arrived (the response lags
                        // the run the daemon minted behind the prompt):
                        // the dispatched head parks the result, and
                        // the response's settle step applies it —
                        // never the pre-response drop that lost the
                        // continuation's output and settled a failed
                        // continuation behind the prompt's verdict.
                        let Some(task_id) = dispatched_head(&guard, &session_id) else {
                            return;
                        };
                        guard.registry.park_autonomous_run(
                            &task_id,
                            Some(text.as_str()),
                            error.as_deref(),
                        );
                        return;
                    };
                    guard.registry.continuation_run_closed(
                        &task_id,
                        Some(text.as_str()),
                        error.as_deref(),
                    );
                }
                RunOwner::Foreign => {}
            }
            return;
        }
        _ => {}
    }
    // Only assistant text is the reply stream; thinking deltas are not
    // artifact content (the ACP layer's same split between
    // AgentMessageChunk and AgentThoughtChunk). A tool-result or user
    // message's start carries no separator: the artifact rule's blank
    // line joins assistant messages only, and a mid-turn user or tool
    // row never doubles it.
    let (delta, separator) = match event_type {
        "message_start" => {
            let role = event
                .get("message")
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str);
            (None, role == Some("assistant"))
        }
        "message_end" => {
            let text = assistant_message_text(&event);
            if let Some(text) = text.filter(|text| !text.is_empty()) {
                let mut guard = state.lock().await;
                guard.windows.assistant_message(&session_id, &text);
            }
            (None, false)
        }
        "message_update" => {
            // Only assistant deltas are the reply stream; the
            // `assistantMessageEvent` member rides assistant rows.
            let delta = event
                .get("assistantMessageEvent")
                .filter(|stream| stream.get("type") == Some(&Value::String("text_delta".into())))
                .and_then(|stream| stream.get("delta"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            ((!delta.is_empty()).then_some(delta.to_string()), false)
        }
        _ => return,
    };
    let mut guard = state.lock().await;
    if !guard.windows.is_open(&session_id) {
        // Frames outside a turn window credit to no task (the window is
        // the attribution unit; a stray frame is not a turn's reply).
        return;
    }
    // The running turn's owner decides the credit (see `RunOwner`): a
    // head whose prompt write was never claimed owns no turn, and a
    // foreign delivery's frames — a daemon prompt, a TUI user, another
    // client's `follow_up` on the shared session — are never the
    // task's stream or artifact.
    let task_id = match guard.runs.owner(&session_id) {
        Some(RunOwner::Admission) => guard.runs.own_task(&session_id).filter(|id| {
            guard
                .registry
                .task(id)
                .is_some_and(|task| !task.state().is_terminal() && task.prompt_write_claimed())
        }),
        Some(RunOwner::Autonomous) => guard
            .runs
            .own_task(&session_id)
            .filter(|id| {
                guard
                    .registry
                    .task(id)
                    .is_some_and(|task| !task.state().is_terminal())
            })
            .or_else(|| run_owning_head(&guard, &session_id)),
        Some(RunOwner::Foreign) | None => None,
    };
    let Some(task_id) = task_id else {
        return;
    };
    if let Some(delta) = delta {
        guard.registry.append_artifact_chunk(&task_id, &delta);
    } else if separator
        && guard
            .registry
            .task(&task_id)
            .is_some_and(|task| !task.artifact_text().is_empty())
    {
        // The artifact rule's blank-line join, applied to the live
        // stream too: a second assistant message of the same turn
        // separates from the first with the same blank line the final
        // artifact carries, so the streamed chunks and the artifact
        // read identically.
        guard.registry.append_artifact_chunk(&task_id, "\n\n");
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::a2a::task::TaskRegistry;
    use crate::a2a::types::{Part, TaskState};

    /// The pump state a test needs: a registry and the session map.
    fn state_with(session: &str, context: &str) -> Arc<Mutex<A2aState>> {
        let mut sessions = BTreeMap::new();
        sessions.insert(session.to_string(), context.to_string());
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            context.into(),
            session.into(),
            None,
            vec![Part::text("hi")],
        );
        // The flow wrote the task's prompt (the pump credits
        // dispatched heads only).
        registry.mark_prompt_writing("t-1");
        registry.mark_prompt_dispatched("t-1", None);
        let guard_state = A2aState::for_test(registry, sessions);
        Arc::new(Mutex::new(guard_state))
    }

    fn session_event(session: &str, event: &Value) -> Value {
        serde_json::json!({
            "type": "session_event",
            "activeSessionId": session,
            "event": event,
        })
    }

    /// The lifecycle frames of one turn map to WORKING + artifact
    /// chunks in order; thinking deltas and tool frames map to nothing.
    /// A second assistant message of the same turn separates with the
    /// artifact rule's blank line.
    #[tokio::test]
    async fn assistant_frames_drive_the_reply_stream() {
        let state = state_with("s-1", "ctx-1");
        let mut stream = {
            let mut guard = state.lock().await;
            guard.registry.subscribe("t-1").expect("subscribable")
        };

        // The worker tags the conversation's own run with its delivery
        // identity (the unique admission id the A2A server minted for
        // the task and its prompt carried — never the public task id).
        let delivery = state
            .lock()
            .await
            .registry
            .task("t-1")
            .expect("the admitted task")
            .delivery_id()
            .to_string();
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "agent_start",
                    "admissionId": "t-1",
                    "clientAdmissionId": delivery,
                }),
            ),
        )
        .await;
        on_session_event(
            &state,
            &session_event("s-1", &serde_json::json!({ "type": "turn_start" })),
        )
        .await;
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_start",
                    "message": { "role": "assistant", "content": [] },
                }),
            ),
        )
        .await;
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_update",
                    "message": { "role": "assistant", "content": [] },
                    "assistantMessageEvent": { "type": "thinking_delta", "delta": "(hidden)" },
                }),
            ),
        )
        .await;
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "tool_execution_start",
                    "toolCallId": "tc-1",
                    "toolName": "bash",
                }),
            ),
        )
        .await;
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_update",
                    "message": { "role": "assistant", "content": [] },
                    "assistantMessageEvent": { "type": "text_delta", "delta": "Hello" },
                }),
            ),
        )
        .await;
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_end",
                    "message": { "role": "assistant", "content": [{ "type": "text", "text": "Hello" }] },
                }),
            ),
        )
        .await;
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_start",
                    "message": { "role": "assistant", "content": [] },
                }),
            ),
        )
        .await;
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_update",
                    "message": { "role": "assistant", "content": [] },
                    "assistantMessageEvent": { "type": "text_delta", "delta": "again" },
                }),
            ),
        )
        .await;

        let task = {
            let guard = state.lock().await;
            guard.registry.snapshot("t-1", None).expect("snapshot")
        };
        assert_eq!(task.status.state, TaskState::Working);
        let frames: Vec<_> = std::iter::from_fn(|| stream.try_recv().ok()).collect();
        // The artifact chunks alone (the separator chunk joins the second
        // message): the thinking delta and the tool frame published
        // nothing, and the WORKING transition already published at the
        // prompt's dispatch (before this subscription — the state
        // constructor dispatched the task).
        let texts: Vec<String> = frames
            .iter()
            .filter_map(|frame| match frame {
                super::super::types::StreamResponse::ArtifactUpdate(event) => event
                    .artifact
                    .parts
                    .first()
                    .and_then(|part| part.text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec!["Hello".to_string(), "\n\n".to_string(), "again".to_string()]
        );
        assert_eq!(frames.len(), 3, "{frames:?}");

        // The running task's artifact carries the accumulated reply text
        // (the streamed chunks ARE the artifact, spec 4.1.7).
        let task = {
            let guard = state.lock().await;
            guard.registry.snapshot("t-1", None).expect("snapshot")
        };
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("Hello\n\nagain")
        );

        // The closed window's text is the same joined form (the claim
        // source of the final artifact).
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_end",
                    "message": { "role": "assistant", "content": [{ "type": "text", "text": "again" }] },
                }),
            ),
        )
        .await;
        on_session_event(
            &state,
            &session_event("s-1", &serde_json::json!({ "type": "turn_end" })),
        )
        .await;
        // The run's close parks the whole reply for the response's
        // claim (the accumulator claimed the window at the turn's end).
        on_session_event(
            &state,
            &session_event("s-1", &serde_json::json!({ "type": "agent_end" })),
        )
        .await;
        let parked = {
            let mut guard = state.lock().await;
            guard.registry.take_initial_run_reply("t-1")
        };
        assert_eq!(parked.as_deref(), Some("Hello\n\nagain"));
    }

    /// Events of an unknown session (no context) are dropped, not
    /// misattributed — and a second turn's window starts clean.
    #[tokio::test]
    async fn an_unknown_session_maps_to_nothing() {
        let state = state_with("s-1", "ctx-1");
        on_session_event(
            &state,
            &session_event(
                "s-other",
                &serde_json::json!({
                    "type": "turn_start",
                }),
            ),
        )
        .await;
        on_session_event(
            &state,
            &session_event(
                "s-other",
                &serde_json::json!({
                    "type": "message_start",
                    "message": { "role": "assistant" },
                }),
            ),
        )
        .await;
        let guard = state.lock().await;
        let task = guard.registry.snapshot("t-1", None).unwrap();
        // The dispatched task holds its dispatch mark (WORKING at its
        // own turn's start); the unknown session's events never touched
        // it.
        assert_eq!(task.status.state, TaskState::Working);
        assert!(task.artifacts.is_empty());
    }

    /// Frames outside any open window credit to no task: the window is
    /// the attribution unit.
    #[tokio::test]
    async fn frames_outside_a_turn_window_credit_to_nothing() {
        let state = state_with("s-1", "ctx-1");
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_update",
                    "message": { "role": "assistant", "content": [] },
                    "assistantMessageEvent": { "type": "text_delta", "delta": "stray" },
                }),
            ),
        )
        .await;
        let guard = state.lock().await;
        let task = guard.registry.snapshot("t-1", None).unwrap();
        // The dispatch mark stands (WORKING at its own turn's start);
        // the windowless frames credited nothing.
        assert_eq!(task.status.state, TaskState::Working);
        assert!(task.artifacts.is_empty());
    }

    /// A head whose prompt was never written to the daemon owns no turn:
    /// a foreign turn running while the task waits for its write (a
    /// daemon prompt, a TUI user, a heartbeat wake) publishes nothing
    /// to the task — not its status, not its artifact.
    #[tokio::test]
    async fn a_predispatch_head_receives_no_live_frames() {
        let mut sessions = BTreeMap::new();
        sessions.insert("s-1".to_string(), "ctx-1".to_string());
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx-1".into(),
            "s-1".into(),
            None,
            vec![Part::text("hi")],
        );
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, sessions)));
        let mut stream = {
            let mut guard = state.lock().await;
            guard.registry.subscribe("t-1").expect("subscribable")
        };

        on_session_event(
            &state,
            &session_event("s-1", &serde_json::json!({ "type": "turn_start" })),
        )
        .await;
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_update",
                    "message": { "role": "assistant", "content": [] },
                    "assistantMessageEvent": { "type": "text_delta", "delta": "FOREIGN-LIVE-TEXT" },
                }),
            ),
        )
        .await;
        on_session_event(
            &state,
            &session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_end",
                    "message": { "role": "assistant", "content": [{ "type": "text", "text": "FOREIGN-LIVE-TEXT" }] },
                }),
            ),
        )
        .await;
        on_session_event(
            &state,
            &session_event("s-1", &serde_json::json!({ "type": "turn_end" })),
        )
        .await;

        let guard = state.lock().await;
        let task = guard.registry.snapshot("t-1", None).unwrap();
        assert_eq!(task.status.state, TaskState::Submitted);
        assert!(task.artifacts.is_empty(), "no foreign artifact: {task:?}");
        drop(guard);
        assert!(
            stream.try_recv().is_err(),
            "the foreign turn published no live frame"
        );
    }

    /// The auto-retry recovers a failed autonomous continuation: the
    /// errored continuation parks its verdict, the retry clears the
    /// park, and the recovered continuation leaves the final
    /// settlement COMPLETED — never FAILED behind the transient first
    /// attempt.
    #[tokio::test]
    async fn an_auto_retried_autonomous_continuation_recovers() {
        let state = state_with("s-1", "ctx-1");
        {
            let mut guard = state.lock().await;
            guard.registry.mark_awaiting_completion("t-1");
        }
        // The first continuation attempt fails (a transient provider
        // error), the goal driver's retry clears the park and recovers.
        for event in [
            serde_json::json!({
                "type": "agent_start",
                "engineContinuation": true,
            }),
            serde_json::json!({ "type": "turn_start" }),
            serde_json::json!({ "type": "turn_end", "error": "transient upstream glitch" }),
            serde_json::json!({ "type": "agent_end" }),
            serde_json::json!({ "type": "auto_retry_start", "attempt": 1 }),
            serde_json::json!({
                "type": "agent_start",
                "engineContinuation": true,
            }),
            serde_json::json!({ "type": "turn_start" }),
            serde_json::json!({
                "type": "message_update",
                "message": { "role": "assistant", "content": [] },
                "assistantMessageEvent": { "type": "text_delta", "delta": "GOAL-RESUMED" },
            }),
            serde_json::json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "GOAL-RESUMED" }] },
            }),
            serde_json::json!({ "type": "turn_end", "message": { "role": "assistant" } }),
            serde_json::json!({ "type": "agent_end" }),
        ] {
            on_session_event(&state, &session_event("s-1", &event)).await;
        }
        // The prompt response's final settlement (the flow's verdict
        // step) reads the continuation's outcome.
        let error = state.lock().await.registry.take_continuation_error("t-1");
        assert_eq!(
            error, None,
            "the recovered continuation left no parked failure"
        );
        let guard = state.lock().await;
        let task = guard.registry.snapshot("t-1", None).unwrap();
        assert_eq!(task.status.state, TaskState::Working);
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("GOAL-RESUMED"),
            "the recovered continuation is the artifact: {task:?}"
        );
    }

    /// An agent message another client delivers to the shared session
    /// shares the `injected` policy but is NOT the session's own
    /// engine continuation (no `engineContinuation` tag): its reply
    /// never reaches the held task's artifact, history, or stream.
    #[tokio::test]
    async fn an_agent_message_run_never_reaches_the_task() {
        let state = state_with("s-1", "ctx-1");
        // The task's own reply is the artifact; the task waits out its
        // autonomous continuations (`awaiting_completion`).
        {
            let mut guard = state.lock().await;
            guard.registry.set_artifact_text("t-1", "OWN-ANSWER");
            guard.registry.mark_awaiting_completion("t-1");
        }
        let mut stream = {
            let mut guard = state.lock().await;
            guard.registry.subscribe("t-1").expect("subscribable")
        };
        // Another client's agent message runs on the shared session:
        // the injected policy, no engine continuation tag.
        for event in [
            serde_json::json!({
                "type": "agent_start",
            }),
            serde_json::json!({ "type": "turn_start" }),
            serde_json::json!({
                "type": "message_update",
                "message": { "role": "assistant", "content": [] },
                "assistantMessageEvent": { "type": "text_delta", "delta": "AGENT-MSG-REPLY" },
            }),
            serde_json::json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "AGENT-MSG-REPLY" }] },
            }),
            serde_json::json!({ "type": "turn_end", "message": { "role": "assistant" } }),
            serde_json::json!({ "type": "agent_end" }),
        ] {
            on_session_event(&state, &session_event("s-1", &event)).await;
        }
        let guard = state.lock().await;
        let task = guard.registry.snapshot("t-1", None).unwrap();
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("OWN-ANSWER"),
            "the agent message's reply never lands in the task: {task:?}"
        );
        assert_eq!(
            task.history.len(),
            2,
            "only the task's own row and its own answer: {task:?}"
        );
        assert_eq!(
            task.history[1].parts[0].text.as_deref(),
            Some("OWN-ANSWER"),
            "the history carries only the task's own answer: {task:?}"
        );
        drop(guard);
        assert!(
            stream.try_recv().is_err(),
            "no foreign frame reached the subscriber"
        );
    }

    /// Another daemon client's admission-named prompt — its OWN wire
    /// admission id and its own client admission id — never credits to
    /// the held task: the identity match, never the class, decides.
    #[tokio::test]
    async fn a_foreign_admission_run_never_reaches_the_task() {
        let state = state_with("s-1", "ctx-1");
        {
            let mut guard = state.lock().await;
            guard.registry.set_artifact_text("t-1", "OWN-ANSWER");
            guard.registry.mark_awaiting_completion("t-1");
        }
        let mut stream = {
            let mut guard = state.lock().await;
            guard.registry.subscribe("t-1").expect("subscribable")
        };
        for event in [
            serde_json::json!({
                "type": "agent_start",
                "admissionId": "supervisor-admission:foreign-1",
                "clientAdmissionId": "some-other-task",
            }),
            serde_json::json!({ "type": "turn_start" }),
            serde_json::json!({
                "type": "message_update",
                "message": { "role": "assistant", "content": [] },
                "assistantMessageEvent": { "type": "text_delta", "delta": "FOREIGN-SECRET" },
            }),
            serde_json::json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "FOREIGN-SECRET" }] },
            }),
            serde_json::json!({ "type": "turn_end", "message": { "role": "assistant" } }),
            serde_json::json!({ "type": "agent_end" }),
        ] {
            on_session_event(&state, &session_event("s-1", &event)).await;
        }
        let guard = state.lock().await;
        let task = guard.registry.snapshot("t-1", None).unwrap();
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("OWN-ANSWER"),
            "the foreign admission run's reply never lands in the task: {task:?}"
        );
        assert_eq!(
            task.history.len(),
            2,
            "only the task's own row and its own answer: {task:?}"
        );
        assert_eq!(
            task.history[1].parts[0].text.as_deref(),
            Some("OWN-ANSWER"),
            "the history carries only the task's own answer: {task:?}"
        );
        drop(guard);
        assert!(
            stream.try_recv().is_err(),
            "no foreign frame reached the subscriber"
        );
    }

    /// A minted continuation's stamp decides its credit: the worker
    /// stamps every continuation it mints with the driving delivery's
    /// identity (the client id the delivery named, or its wire id —
    /// the supervisor's rewrite, or the worker's pickup mint for a
    /// plain delivery), so a continuation naming a FOREIGN delivery
    /// credits nothing to the waiting task — exactly like that
    /// delivery's own prompt. Only the session's own un-stamped
    /// continuation (a post-compact mint with no driving delivery)
    /// keeps the session-owned credit below.
    #[tokio::test]
    async fn a_foreign_stamped_continuation_never_reaches_the_task() {
        let state = state_with("s-1", "ctx-1");
        {
            let mut guard = state.lock().await;
            guard.registry.set_artifact_text("t-1", "OWN-ANSWER");
            guard.registry.mark_awaiting_completion("t-1");
        }
        let mut stream = {
            let mut guard = state.lock().await;
            guard.registry.subscribe("t-1").expect("subscribable")
        };
        // The continuation a plain daemon delivery's goal loop mints:
        // `engineContinuation` plus the delivery's identity (the wire
        // id — the client named none, the supervisor assigned one).
        for event in [
            session_event(
                "s-1",
                &serde_json::json!({
                    "type": "agent_start",
                    "engineContinuation": true,
                    "clientAdmissionId": "supervisor-admission:foreign-1",
                }),
            ),
            session_event("s-1", &serde_json::json!({ "type": "turn_start" })),
            session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_update",
                    "message": { "role": "assistant", "content": [] },
                    "assistantMessageEvent": { "type": "text_delta", "delta": "FOREIGN-GOAL" },
                }),
            ),
            session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "FOREIGN-GOAL" }]
                    },
                }),
            ),
            session_event("s-1", &serde_json::json!({ "type": "turn_end" })),
            session_event("s-1", &serde_json::json!({ "type": "agent_end" })),
        ] {
            on_session_event(&state, &event).await;
        }
        let guard = state.lock().await;
        let task = guard.registry.snapshot("t-1", None).unwrap();
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("OWN-ANSWER"),
            "the foreign delivery's minted continuation never reaches the task: {task:?}"
        );
        drop(guard);
        assert!(
            stream.try_recv().is_err(),
            "no foreign continuation frame reached the subscriber"
        );
    }

    /// An autonomous continuation run credits to a task whose prompt
    /// response already settled (`awaiting_completion`): the run's
    /// windowed text extends the artifact — exactly once, whether the
    /// live stream carried the deltas or they were missed.
    #[tokio::test]
    async fn an_autonomous_continuation_run_extends_the_artifact() {
        let state = state_with("s-1", "ctx-1");
        {
            let mut guard = state.lock().await;
            guard.registry.set_artifact_text("t-1", "FIRST-TURN");
            guard.registry.mark_awaiting_completion("t-1");
        }
        let run = |reply: &str, with_delta: bool| {
            let mut frames = vec![
                // The session's own injected continuation: no admission
                // id, the injected turn policy.
                session_event(
                    "s-1",
                    &serde_json::json!({
                        "type": "agent_start",
                        "engineContinuation": true,
                    }),
                ),
                session_event("s-1", &serde_json::json!({ "type": "turn_start" })),
                // The assistant message's start carries the artifact
                // rule's blank-line separator (the live join).
                session_event(
                    "s-1",
                    &serde_json::json!({
                        "type": "message_start",
                        "message": { "role": "assistant", "content": [] },
                    }),
                ),
            ];
            if with_delta {
                frames.push(session_event(
                    "s-1",
                    &serde_json::json!({
                        "type": "message_update",
                        "message": { "role": "assistant", "content": [] },
                        "assistantMessageEvent": { "type": "text_delta", "delta": reply },
                    }),
                ));
            }
            frames.push(session_event(
                "s-1",
                &serde_json::json!({
                    "type": "message_end",
                    "message": { "role": "assistant", "content": [{ "type": "text", "text": reply }] },
                }),
            ));
            frames.push(session_event(
                "s-1",
                &serde_json::json!({ "type": "turn_end" }),
            ));
            frames.push(session_event(
                "s-1",
                &serde_json::json!({ "type": "agent_end" }),
            ));
            frames
        };
        // The streamed run: the deltas already carried the text — the
        // run's close publishes no replacement.
        for event in run("CONTINUATION-ONE", true) {
            on_session_event(&state, &event).await;
        }
        {
            let guard = state.lock().await;
            let task = guard.registry.snapshot("t-1", None).unwrap();
            assert_eq!(
                task.artifacts[0].parts[0].text.as_deref(),
                Some("FIRST-TURN\n\nCONTINUATION-ONE"),
                "the streamed continuation extends the artifact: {task:?}"
            );
        }
        // The missed-delta run: the windowed text appends anyway.
        for event in run("CONTINUATION-TWO", false) {
            on_session_event(&state, &event).await;
        }
        let guard = state.lock().await;
        let task = guard.registry.snapshot("t-1", None).unwrap();
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("FIRST-TURN\n\nCONTINUATION-ONE\n\nCONTINUATION-TWO"),
            "the windowed continuation extends the artifact: {task:?}"
        );
        assert_ne!(task.status.state, TaskState::Completed, "{task:?}");
    }

    /// The claim contract: the dispatch anchor names the session's NEXT
    /// close sequence, and the claim takes exactly that window — the
    /// first reply of a dispatched prompt (a final-message-only turn)
    /// claims its own window, never a later one.
    #[tokio::test]
    async fn the_dispatch_anchor_claims_the_replys_own_window() {
        let mut windows = TurnWindows::default();
        let anchor = windows.next_seq("s-1");
        assert_eq!(anchor, 1, "a fresh session's next close carries sequence 1");
        // A final-message-only turn closes exactly the anchored window.
        windows.assistant_message("s-1", "EXACT-REPLY");
        windows.close("s-1");
        assert_eq!(
            windows.claim_after("s-1", anchor).as_deref(),
            Some("EXACT-REPLY"),
            "the anchored window claims"
        );
        assert!(
            windows.claim_after("s-1", anchor).is_none(),
            "the claim removes the window"
        );
        // A following foreign window never serves the anchor again.
        windows.assistant_message("s-1", "FOREIGN-REPLY");
        windows.close("s-1");
        assert!(
            windows.claim_after("s-1", anchor).is_none(),
            "an evicted anchor claims nothing"
        );
    }

    /// A foreign delivery's frames never reach the task: a queued or
    /// direct run without the conversation's own admission id (a daemon
    /// prompt, a TUI user, another client's `follow_up`) credits no
    /// artifact, history, or stream — and an admission id the head task
    /// does not own credits nothing either.
    #[tokio::test]
    async fn foreign_runs_never_reach_the_task() {
        let state = state_with("s-1", "ctx-1");
        let mut stream = {
            let mut guard = state.lock().await;
            guard.registry.subscribe("t-1").expect("subscribable")
        };
        // A no-admission run (the daemon assigns its own supervisor
        // admission ids, so this mode's own deliveries arrive
        // admission-NAMED while a plain foreign prompt, a TUI user, or
        // another client's `follow_up` carries none).
        let start = serde_json::json!({ "type": "agent_start" });
        {
            on_session_event(&state, &session_event("s-1", &start)).await;
            on_session_event(
                &state,
                &session_event("s-1", &serde_json::json!({ "type": "turn_start" })),
            )
            .await;
            on_session_event(
                &state,
                &session_event(
                    "s-1",
                    &serde_json::json!({
                        "type": "message_update",
                        "message": { "role": "assistant", "content": [] },
                        "assistantMessageEvent": { "type": "text_delta", "delta": "FOREIGN-TEXT" },
                    }),
                ),
            )
            .await;
            on_session_event(
                &state,
                &session_event(
                    "s-1",
                    &serde_json::json!({
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "content": [{ "type": "text", "text": "FOREIGN-TEXT" }]
                        },
                    }),
                ),
            )
            .await;
            on_session_event(
                &state,
                &session_event("s-1", &serde_json::json!({ "type": "turn_end" })),
            )
            .await;
            on_session_event(
                &state,
                &session_event("s-1", &serde_json::json!({ "type": "agent_end" })),
            )
            .await;
        }
        let guard = state.lock().await;
        let task = guard.registry.snapshot("t-1", None).unwrap();
        assert!(
            task.artifacts.is_empty(),
            "a foreign run's text never reached the task: {task:?}"
        );
        assert_eq!(task.history.len(), 1, "only the task's own row: {task:?}");
        drop(guard);
        assert!(
            stream.try_recv().is_err(),
            "no foreign frame reached the subscriber"
        );
    }

    /// The RLM child terminal notice turn — the parent's answer to its
    /// own children's results, the run the completion barrier waits out
    /// under RLM quiescence — credits to the waiting task when the
    /// notice carries the spawning delivery's stamp (the server's
    /// contract: "RLM child follow-ups ... still owe turns after the
    /// response, their runs credit to the task"), and an unstamped
    /// notice (children spawned outside any delivery) credits nothing:
    /// the credit follows the identity, never the row class.
    #[tokio::test]
    async fn a_stamped_child_notice_turn_reaches_its_waiting_tasks_artifact() {
        let run = |anchor: serde_json::Value| {
            [
                session_event("s-1", &anchor),
                session_event("s-1", &serde_json::json!({ "type": "turn_start" })),
                session_event(
                    "s-1",
                    &serde_json::json!({
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "content": [{ "type": "text", "text": "CHILD-RESULTS-SUMMARY" }]
                        },
                    }),
                ),
                session_event("s-1", &serde_json::json!({ "type": "turn_end" })),
                session_event("s-1", &serde_json::json!({ "type": "agent_end" })),
            ]
        };
        {
            let state = state_with("s-1", "ctx-1");
            let delivery = {
                let mut guard = state.lock().await;
                guard
                    .registry
                    .set_artifact_text("t-1", "SPAWNED-THE-CHILDREN");
                guard.registry.mark_awaiting_completion("t-1");
                guard
                    .registry
                    .task("t-1")
                    .expect("the admitted task")
                    .delivery_id()
                    .to_string()
            };
            // The notice carries the spawning delivery's stamp — the
            // delivery id the worker writes, never the public task id.
            for event in run(serde_json::json!({
                "type": "agent_start",
                "clientAdmissionId": delivery,
                "engineContinuation": true,
            })) {
                on_session_event(&state, &event).await;
            }
            let guard = state.lock().await;
            let task = guard.registry.snapshot("t-1", None).unwrap();
            let artifact = task.artifacts[0].parts[0].text.clone().unwrap_or_default();
            assert_eq!(
                artifact, "SPAWNED-THE-CHILDREN\n\nCHILD-RESULTS-SUMMARY",
                "the stamped notice run credits the waiting task: {artifact:?}"
            );
        }
        {
            let state = state_with("s-1", "ctx-1");
            {
                let mut guard = state.lock().await;
                guard
                    .registry
                    .set_artifact_text("t-1", "SPAWNED-THE-CHILDREN");
                guard.registry.mark_awaiting_completion("t-1");
            }
            for event in run(serde_json::json!({ "type": "agent_start" })) {
                on_session_event(&state, &event).await;
            }
            let guard = state.lock().await;
            let task = guard.registry.snapshot("t-1", None).unwrap();
            let artifact = task.artifacts[0].parts[0].text.clone().unwrap_or_default();
            assert_eq!(
                artifact, "SPAWNED-THE-CHILDREN",
                "an unstamped notice (no delivery spawned the children) credits nothing: {artifact:?}"
            );
        }
    }
}
