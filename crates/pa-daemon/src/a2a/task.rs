//! The A2A task registry: the in-memory table mapping every protocol
//! task onto its context's prompt turn, with the per-task stream sinks
//! that fan events out to SSE subscribers (spec 3.5.2: every active
//! stream for a task receives the same events in the same order; closing
//! one stream must not affect the others).
//!
//! Retention: the registry keeps every live task (its text, history,
//! and any stream sink) and the newest [`MAX_RETAINED_TERMINAL_TASKS`]
//! terminal tasks — a bounded window `GetTask`/`ListTasks` keep serving
//! (the memory ceiling: a task's footprint is its prompt and reply
//! text, so the retained window is the cap an authenticated client can
//! grow; the oldest terminal task beyond it leaves, never a live or
//! just-settled one a flow still reads); a restart loses all task
//! lookup — a restart is a new agent, not a continuation.

use std::collections::{BTreeMap, VecDeque};

use tokio::sync::mpsc::Receiver as StreamReceiver;
use tokio::sync::mpsc::Sender as StreamSender;
use tokio::sync::Notify;

use super::types::{
    Artifact, Message, Part, Role, StreamResponse, Task, TaskArtifactUpdateEvent, TaskState,
    TaskStatus, TaskStatusUpdateEvent,
};

/// The page sizes `ListTasks` serves (spec 3.1.4: default at most 50,
/// maximum 100).
pub const DEFAULT_PAGE_SIZE: u32 = 50;
pub const MAX_PAGE_SIZE: u32 = 100;

/// The retained terminal-task window (the registry's memory ceiling,
/// beside `a2a.maxContexts`'s live-context bound): the newest
/// [`MAX_RETAINED_TERMINAL_TASKS`] terminal tasks stay readable through
/// `GetTask`/`ListTasks` — every flow that can still act on a task
/// reads one far newer than the window's oldest — and the oldest
/// terminal task beyond the window leaves the registry at the settle
/// that pushed it out. The default page is 50 and the maximum 100, so
/// the window holds several full pages of finished history.
pub const MAX_RETAINED_TERMINAL_TASKS: usize = 256;

/// The per-subscriber SSE queue bound: a healthy reader drains at its
/// connection's pace and never reaches it, while a reader that stopped
/// (a stalled TCP window, a client that walked away) is DROPPED at the
/// bound — its stream closes, the task stays queryable through
/// `GetTask` — and the publish path never blocks on the slow reader
/// (`try_send`, never an awaited send). Without the bound a
/// non-reading subscriber accumulates the task's whole history off the
/// registry's own retention ceilings, frame by frame, with no limit.
const SUBSCRIBER_QUEUE_FRAMES: usize = 1024;

/// One `ListTasks` page token: the registry's own run id, the boundary
/// row the last page ended on (its `updated_at` and id), encoded so
/// the walk resumes STRICTLY after that point in the sort order — a
/// row that updated between pages moves ahead of the boundary and is
/// never replayed, and a row that left the filter never restarts the
/// walk at page one. The run id binds the token to the registry that
/// minted it: the registry lives in memory, so every token a client
/// holds is unminted after a restart, and a walk resumed with one
/// ends at its honest invalid-params instead of silently restarting
/// (or ending) against a table it never paged.
fn encode_page_token(nonce: u64, updated_at: u64, id: &str) -> String {
    format!("{nonce:x}:{updated_at}:{id}")
}

/// Decode one page token into its boundary (the `updated_at` + id pair
/// the walk resumes after). `None` answers the caller's invalid-params:
/// the token is not one this server minted — a foreign run id, a
/// malformed shape — and the walk never silently restarts at page one.
fn decode_page_token(nonce: u64, token: &str) -> Option<(u64, String)> {
    let (bound_nonce, rest) = token.split_once(':')?;
    // The run id rides HEX (the encode's `{nonce:x}` cut); the
    // boundary's `updated_at` stays decimal.
    if u64::from_str_radix(bound_nonce, 16).ok()? != nonce {
        return None;
    }
    let (updated_at, id) = rest.split_once(':')?;
    let updated_at = updated_at.parse().ok()?;
    let id = id.trim();
    (!id.is_empty()).then(|| (updated_at, id.to_string()))
}

/// The artifact name of the turn's reply text.
pub const RESPONSE_ARTIFACT_NAME: &str = "response";

/// One received user message of a task: the client's `messageId` (the
/// creator sets it, spec 4.1.4) and the received parts (the task's
/// history keeps the client's own message shape, spec 4.1.4 — never a
/// merged stand-in; the daemon prompt the flow sends carries its own
/// joined text).
#[derive(Debug, Clone)]
struct ReceivedMessage {
    message_id: Option<String>,
    parts: Vec<Part>,
}

/// The task's prompt handoff to the daemon: `Waiting` (admitted, no
/// daemon work yet), `Writing` (the flow claimed the write and the
/// prompt is on its way to the socket), `Dispatched` (the daemon
/// registered its admission).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptDispatch {
    Waiting,
    Writing,
    Dispatched,
}

/// One reply's captured verdict. The reply-owing flows (the sends,
/// the cancel) claim their task's verdict at the registry step that
/// accepts their work — the send's admission, the cancel's
/// acceptance — and the task's first
/// terminal settle captures its final snapshot into every live claim
/// under the same registry lock that advances the retention window.
/// A reply reads the task's own truth — the live registry row while
/// the window keeps it, the claim's captured snapshot once the window
/// advanced past it — never a fabricated verdict: the capture and the
/// prune share one critical section, so one or the other always
/// answers.
#[derive(Debug, Clone)]
pub struct VerdictClaim {
    /// The reply's own history projection (its request's
    /// `historyLength`).
    history_length: Option<u32>,
    slot: std::sync::Arc<std::sync::Mutex<Option<Task>>>,
}

/// One reply-owing reader's registered claim: the reader owns the
/// slot (its `VerdictClaim`), and the registry holds this NON-OWNING
/// registration — a reader that already answered or disconnected
/// (its claim dropped) prunes at the next registration and never
/// costs a settle its snapshot work. A settled task captures into
/// exactly the claims that still owe a reply.
#[derive(Debug)]
struct VerdictRegistration {
    /// The reply's own history projection (its request's
    /// `historyLength`).
    history_length: Option<u32>,
    slot: std::sync::Weak<std::sync::Mutex<Option<Task>>>,
}

impl VerdictClaim {
    /// The captured verdict, once the settle filled the claim.
    #[must_use]
    pub fn captured(&self) -> Option<Task> {
        self.slot.lock().expect("verdict claim lock").clone()
    }

    /// The reply's own history projection (its request's
    /// `historyLength`).
    #[must_use]
    pub fn history_length(&self) -> Option<u32> {
        self.history_length
    }
}

/// One registered task: the mapping onto one prompt turn.
#[derive(Debug)]
pub struct TaskEntry {
    /// The protocol task id: the public id A2A clients name. The
    /// daemon wire never carries it — the prompt's admission is the
    /// task's minted delivery id ([`Self::delivery_id`]), so the
    /// daemon's admission cancel serves `CancelTask` through that
    /// identity, never verbatim by the public id.
    pub id: String,
    pub context_id: String,
    /// The daemon session hosting the turn.
    pub session_id: String,
    state: TaskState,
    /// The task's received user messages (its admission), each with
    /// the client's own `messageId`.
    user_messages: Vec<ReceivedMessage>,
    /// The stable agent message id of the task's reply history.
    agent_message_id: String,
    assistant_text: String,
    /// The failed-turn reason, carried by the FAILED status message.
    error: Option<String>,
    updated_at: u64,
    /// The task's prompt handoff to the daemon (see `PromptDispatch`).
    dispatch: PromptDispatch,
    /// Set when the task's own prompt response settled while the
    /// daemon's autonomous continuation still owed turns (a goal
    /// driver, a post-compaction run, RLM child follow-ups): the run's
    /// windows credit to the task, and the flow's headless-completion
    /// step settles it once the run finished.
    awaiting_completion: bool,
    /// The turn-window close sequence the pump's response step claims
    /// after (the session's next-close number at the prompt's dispatch —
    /// the task's OWN window, however many follow-up turns interleave
    /// their frames before the response).
    window_anchor: Option<u64>,
    /// The supervisor-assigned wire admission id the task's own first
    /// run carried (the daemon rewrites the prompt's admission id — the
    /// task's delivery id, never the public task id — to a fresh
    /// `supervisor-admission:*` id on the wire): recorded at the run's
    /// `agent_start`, so the task's later own runs (a retry) match it
    /// and a foreign admission-named delivery — a different wire id —
    /// never credits.
    wire_admission: Option<String>,
    /// The task's own delivery identity: the admission id its prompt
    /// carries on the daemon wire and its runs carry as
    /// `clientAdmissionId`. Minted per task, never the public task id —
    /// a client admission id is unique only within one daemon
    /// connection, so another client may send the same task id, but no
    /// foreign run can carry this id: attribution, the cancel ladder,
    /// the withdrawal, and the scoped completion wait all name it.
    delivery_id: String,
    /// The reply of the task's own first run (the run its prompt
    /// anchored), parked at the run's `agent_end` and claimed by the
    /// prompt response: the whole run's text, never one model-step
    /// window (a tool-calling turn's artifact is all of its rounds).
    initial_run_reply: Option<String>,
    /// Engine continuation runs that closed BEFORE the task's prompt
    /// response arrived (the response lags the run the daemon minted
    /// behind the prompt — a goal driver, a post-compaction run):
    /// the response's settle step applies them in run order, the same
    /// settlement a post-response continuation's `agent_end` owns.
    /// Each entry carries its park order (the registry-wide counter).
    parked_autonomous: VecDeque<(u64, Option<String>, Option<String>)>,
    /// The failure reason of an autonomous continuation run (the run
    /// recognized the error; the flow's final settlement reads it — a
    /// failed continuation never settles behind a successful prompt).
    continuation_error: Option<String>,
    /// The task's in-flight `CancelTask` withdrawals (each withdraw arm
    /// opens one at its dispatch; its receipt closes it): the count is
    /// the withdrawal's authority over the task's ONE terminal verdict —
    /// while any is in flight, the completion settle parks its verdict
    /// (see [`Self::deferred_verdict`]) and the receipt that stopped work
    /// settles the CANCELED the client asked for, published ONCE as the
    /// first terminal verdict. A count, never a boolean: a second,
    /// refused withdrawal cannot erase the first still-pending one.
    withdraw_inflight: usize,
    /// The terminal verdict the completion settle parked behind an
    /// in-flight withdrawal: the receipt publishes it when the withdrawal
    /// refused (the task keeps its own course), and an accepted receipt
    /// settles CANCELED instead — the parked verdict dying with the
    /// settle, never revised behind closed streams.
    deferred_verdict: Option<(TaskState, Option<String>)>,
    /// The cancel ladder accepted the task's own running-turn abort (its
    /// `owned` answer): the abort can end the engine's tool phase with a
    /// success outcome, and a success response on a marked task settles
    /// CANCELED — the client asked for the stop, whatever partial
    /// artifact the aborted turn produced.
    cancel_abort_marked: bool,
    /// The task's in-flight cancel ladders (each cancel's ladder arm
    /// opens one at its dispatch and that ladder's own response resolves
    /// it): the worker aborts the running turn BEFORE the `owned`
    /// response travels, so the task's own success response and
    /// completion barrier can settle while the receipt is still in
    /// flight — the completion settle parks its verdict behind this
    /// authority (see [`Self::deferred_verdict`]) and each ladder's
    /// response resolves its own share (`owned` publishes the stop the
    /// client asked for; a refusal publishes what the task's own run
    /// produced). A COUNT, never a boolean: two overlapping ladders
    /// each own the verdict while their receipts travel, so one
    /// ladder's expiry cannot release the verdict another still owns.
    ladder_inflight: usize,
    /// Wakes a cancel waiting for the prompt-dispatch handoff (shared
    /// so the wait can outlive the registry guard).
    dispatch_notify: std::sync::Arc<Notify>,
    /// The active SSE subscriber sinks, pruned on every publish: each
    /// holds at most [`SUBSCRIBER_QUEUE_FRAMES`] queued frames, and a
    /// subscriber that stopped draining is DROPPED at the bound, never
    /// buffered without limit.
    streams: Vec<StreamSender<StreamResponse>>,
    /// The reply claims registered by the flows that owe this task a
    /// reply (see [`VerdictClaim`]): the first terminal settle
    /// captures the task's final snapshot into each LIVE registration
    /// under the same registry lock that retires the task, so a reply
    /// read after the retention window advanced past the task still
    /// answers its own verdict. The registrations are non-owning (see
    /// [`VerdictRegistration`]): a reader that already answered or
    /// disconnected prunes at the next registration, so a long-running
    /// task never retains its dead readers' claims.
    verdict_claims: Vec<VerdictRegistration>,
}

impl TaskEntry {
    fn new(
        id: String,
        context_id: String,
        session_id: String,
        user_message_id: Option<String>,
        user_parts: Vec<Part>,
    ) -> Self {
        let now = crate::util::now_ms();
        Self {
            id,
            context_id,
            session_id,
            state: TaskState::Submitted,
            user_messages: vec![ReceivedMessage {
                message_id: user_message_id,
                parts: user_parts,
            }],
            agent_message_id: uuid::Uuid::new_v4().to_string(),
            assistant_text: String::new(),
            error: None,
            updated_at: now,
            dispatch: PromptDispatch::Waiting,
            awaiting_completion: false,
            window_anchor: None,
            wire_admission: None,
            delivery_id: uuid::Uuid::new_v4().to_string(),
            initial_run_reply: None,
            parked_autonomous: VecDeque::new(),
            continuation_error: None,
            withdraw_inflight: 0,
            deferred_verdict: None,
            cancel_abort_marked: false,
            ladder_inflight: 0,
            dispatch_notify: std::sync::Arc::new(Notify::new()),
            streams: Vec::new(),
            verdict_claims: Vec::new(),
        }
    }

    /// The live and total registered verdict claims (see
    /// [`VerdictRegistration`]): the flows' leak discriminators — a
    /// reader that already answered or disconnected leaves no live
    /// registration behind.
    #[cfg(test)]
    pub(crate) fn verdict_claim_counts(&self) -> (usize, usize) {
        (
            self.verdict_claims
                .iter()
                .filter(|claim| claim.slot.upgrade().is_some())
                .count(),
            self.verdict_claims.len(),
        )
    }

    fn user_message(&self, received: &ReceivedMessage) -> Message {
        Message {
            message_id: received
                .message_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            context_id: Some(self.context_id.clone()),
            task_id: Some(self.id.clone()),
            role: Role::User,
            parts: received.parts.clone(),
            metadata: None,
            extensions: None,
            reference_task_ids: None,
        }
    }

    fn agent_message(&self, text: &str) -> Message {
        Message {
            message_id: self.agent_message_id.clone(),
            context_id: Some(self.context_id.clone()),
            task_id: Some(self.id.clone()),
            role: Role::Agent,
            parts: vec![Part::text(text)],
            metadata: None,
            extensions: None,
            reference_task_ids: None,
        }
    }

    fn status_message(&self, text: &str) -> Message {
        self.agent_message(text)
    }

    /// The accumulated reply text (the artifact source).
    pub fn artifact_text(&self) -> &str {
        &self.assistant_text
    }

    /// The task's current lifecycle state.
    pub fn state(&self) -> TaskState {
        self.state
    }

    /// Whether the task's prompt reached the daemon (the pump parks a
    /// session's own continuation only on dispatched heads: the
    /// prompt is written, so a run minted behind it belongs to the
    /// task).
    pub fn prompt_dispatched(&self) -> bool {
        self.dispatch == PromptDispatch::Dispatched
    }

    /// Whether the task's flow claimed the prompt write (the prompt on
    /// its way to the socket, or the daemon already registered its
    /// admission): the task's OWN run can start the moment the write
    /// hits the socket, so the pump credits a session's live frames to
    /// a writing head too — the flow claimed the write on a quiet
    /// session, and the only turn that can run from that instant is
    /// the task's own.
    pub fn prompt_write_claimed(&self) -> bool {
        matches!(
            self.dispatch,
            PromptDispatch::Writing | PromptDispatch::Dispatched
        )
    }

    /// The supervisor-assigned wire admission id the task's own first
    /// run carried, once the pump saw that run (see
    /// [`TaskEntry::wire_admission`]): `None` until the task's own
    /// run started.
    pub fn wire_admission(&self) -> Option<&str> {
        self.wire_admission.as_deref()
    }

    /// Whether the task's prompt response settled while the daemon's
    /// autonomous continuation still owes turns (the flow's
    /// headless-completion settle owns the task).
    pub fn awaiting_completion(&self) -> bool {
        self.awaiting_completion
    }

    /// The task's own delivery identity (see [`TaskEntry::delivery_id`]):
    /// the admission id its prompt carries on the daemon wire, unique per
    /// dispatch.
    pub fn delivery_id(&self) -> &str {
        &self.delivery_id
    }

    /// The prompt's turn-window dispatch anchor (the session's
    /// next-close sequence at the dispatch; `None` when no flow behind
    /// the prompt recorded one).
    pub fn window_anchor(&self) -> Option<u64> {
        self.window_anchor
    }

    /// The task's current `Task` wire object (spec 4.1.1), with the
    /// history trimmed by `history_length` (spec 3.2.4: unset means no
    /// limit, 0 omits history entirely) and the artifact projection the
    /// caller asks for (`ListTasks` omits artifacts by default, spec
    /// 3.1.4; `GetTask` always carries them).
    fn snapshot(&self, history_length: Option<u32>, include_artifacts: bool) -> Task {
        let mut history = Vec::new();
        if history_length.unwrap_or(u32::MAX) > 0 {
            history.extend(self.user_messages.iter().map(|m| self.user_message(m)));
            if !self.assistant_text.is_empty() {
                history.push(self.agent_message(&self.assistant_text));
            }
            let limit = usize::try_from(history_length.unwrap_or(u32::MAX))
                .unwrap_or(usize::MAX)
                .min(history.len());
            history = history.split_off(history.len().saturating_sub(limit));
        }
        let artifacts = if !include_artifacts || self.assistant_text.is_empty() {
            Vec::new()
        } else {
            vec![self.artifact()]
        };
        let status_message = self.error.as_ref().map(|error| self.status_message(error));
        Task {
            id: self.id.clone(),
            context_id: Some(self.context_id.clone()),
            status: TaskStatus {
                state: self.state,
                message: status_message,
                timestamp: Some(crate::util::iso_from_unix_ms(self.updated_at)),
            },
            artifacts,
            history,
            metadata: None,
        }
    }

    /// Register one stream subscriber, pruning the disconnected sinks a
    /// silent WORKING task would otherwise retain between publishes
    /// (the register site is the only prune such a task gets, so
    /// repeated subscribe/disconnect pairs stay bounded by live
    /// readers).
    fn register_stream(&mut self, tx: StreamSender<StreamResponse>) {
        self.streams.retain(|sink| !sink.is_closed());
        self.streams.push(tx);
    }

    /// The task's response artifact: the turn's reply text.
    fn artifact(&self) -> Artifact {
        Artifact {
            artifact_id: format!("artifact-{}", self.id),
            name: Some(RESPONSE_ARTIFACT_NAME.to_string()),
            description: None,
            parts: vec![Part::text(self.assistant_text.clone())],
            metadata: None,
            extensions: None,
        }
    }
}

/// The verdict of [`TaskRegistry::settle_undispatched`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UndispatchedCancel {
    /// The registry settled the task CANCELED directly.
    Settled,
    /// The prompt is written or being written; the daemon's cancel
    /// ladder owns the task.
    HandedOff,
    /// The task already settled.
    Terminal,
    /// No such task.
    Unknown,
}

/// The registry of live tasks plus each context's admission queue (the
/// order a context's queued tasks reach their turns — sessions run one
/// turn at a time). Live session frames credit to the task that owns
/// the running turn (the turn-window correlation, see `events.rs`), not
/// to the queue head.
#[derive(Default)]
pub struct TaskRegistry {
    tasks: BTreeMap<String, TaskEntry>,
    /// The per-context queues of unsettled task ids, admission order.
    queues: BTreeMap<String, VecDeque<String>>,
    /// The terminal tasks in settle order (the retention window's
    /// queue): the oldest beyond [`MAX_RETAINED_TERMINAL_TASKS`] leaves
    /// the registry at the settle that pushes the window past its bound.
    terminal_order: VecDeque<String>,
    /// Fires on every queue rotation, so a flow waiting for its turn at
    /// the head re-checks under the registry guard.
    head_notify: std::sync::Arc<Notify>,
    /// The park-order counter: every pre-response parked engine
    /// continuation stamps the next number, so the response's settle
    /// step applies the parked lots in the pump's frame order.
    park_order: u64,
    /// The page tokens' run id (see [`encode_page_token`]): minted once
    /// per registry, so a token another server run minted decodes as
    /// unminted and answers the caller's invalid-params.
    page_token_nonce: u64,
}

impl TaskRegistry {
    #[must_use]
    pub fn new() -> Self {
        // The page-token run id: the last 16 hex characters of a random
        // UUID (the display-id cut, wider). `default()` stays test-only
        // (0x0 is as valid a run id as any — the shape, not the value,
        // decides the mint).
        let uuid = uuid::Uuid::new_v4().simple().to_string();
        let page_token_nonce = u64::from_str_radix(&uuid[(uuid.len() - 16)..], 16).unwrap_or(0);
        Self {
            page_token_nonce,
            ..Self::default()
        }
    }

    /// Register one admitted task and queue it on its context.
    pub fn admit(
        &mut self,
        id: String,
        context_id: String,
        session_id: String,
        user_message_id: Option<String>,
        user_parts: Vec<Part>,
    ) {
        let entry = TaskEntry::new(
            id.clone(),
            context_id.clone(),
            session_id,
            user_message_id,
            user_parts,
        );
        self.tasks.insert(id.clone(), entry);
        self.queues.entry(context_id).or_default().push_back(id);
    }

    /// Claim the task's prompt write (the flow reached its turn at the
    /// context head with a quiet session): `Waiting` becomes `Writing`
    /// so a concurrent `CancelTask` cannot settle a prompt that is on
    /// its way to the socket. `false` when the task already settled or
    /// the write was claimed — the flow writes nothing then.
    pub fn mark_prompt_writing(&mut self, id: &str) -> bool {
        let claimed = self.with_task(id, |entry| {
            if entry.dispatch == PromptDispatch::Waiting && !entry.state.is_terminal() {
                entry.dispatch = PromptDispatch::Writing;
                true
            } else {
                false
            }
        });
        claimed.unwrap_or(false)
    }

    /// Mark the task's prompt as written to the daemon, record its
    /// turn-window dispatch anchor (the session's next-close sequence,
    /// read by the caller from the pump's window table), and wake a
    /// `CancelTask` waiting on the handoff (the task is publicly
    /// acknowledged before the daemon registers the admission; a cancel
    /// landing in that window waits for the write, then retries the
    /// daemon's `unknown` status on its own observable signal).
    pub fn mark_prompt_dispatched(&mut self, id: &str, window_anchor: Option<u64>) {
        if let Some(entry) = self.tasks.get_mut(id) {
            entry.dispatch = PromptDispatch::Dispatched;
            entry.window_anchor = window_anchor;
            // `notify_one` stores a permit when no waiter is parked, so
            // a waiter subscribing after the mark still wakes at once.
            entry.dispatch_notify.notify_one();
        }
        // The dispatched task is WORKING at its own turn's start (spec
        // 3.4.2: WORKING once the agent begins processing), not at its
        // first assistant frame — a provider's whole time to first
        // token is the task already working, and a `taskId` continuation
        // or `ListTasks(status=working)` must not misreport it.
        self.mark_working(id);
    }

    /// Record the wire admission id the task's own first run carried
    /// (the pump's identity resolution): the first own run claims the
    /// recording; every later own run of the same delivery must carry
    /// the same id (see [`TaskEntry::wire_admission`]).
    pub fn record_wire_admission(&mut self, id: &str, wire_admission: &str) {
        self.with_task(id, |entry| {
            if entry.wire_admission.is_none() {
                entry.wire_admission = Some(wire_admission.to_string());
            }
        });
    }

    /// Settle a task whose prompt was never written (its flow is still
    /// waiting for the context's queue head or a quiet session): there
    /// is no daemon work to withdraw, so the registry settles it
    /// directly. `HandedOff` answers a prompt that is written or being
    /// written (the daemon's own cancel ladder owns it); `Terminal` a
    /// task that already settled; `Unknown` a task that does not exist.
    pub fn settle_undispatched(&mut self, id: &str) -> UndispatchedCancel {
        let Some(entry) = self.tasks.get(id) else {
            return UndispatchedCancel::Unknown;
        };
        match (entry.dispatch, entry.state.is_terminal()) {
            (PromptDispatch::Waiting, false) => {}
            (PromptDispatch::Waiting | PromptDispatch::Writing, true) => {
                return UndispatchedCancel::Terminal;
            }
            (PromptDispatch::Writing | PromptDispatch::Dispatched, _) => {
                return UndispatchedCancel::HandedOff;
            }
        }
        self.settle(id, TaskState::Canceled, None);
        UndispatchedCancel::Settled
    }

    /// The write turnstile's wake signal (fired on every queue
    /// rotation), cloned out so a send flow can park for its head
    /// WITHOUT the state guard: the pump's settle must be able to
    /// rotate the head while queued flows are parked on it (the server
    /// owns the wait — see `server.rs`).
    pub fn head_wake(&self) -> std::sync::Arc<Notify> {
        std::sync::Arc::clone(&self.head_notify)
    }

    /// Mark the post-response continuation (the prompt response settled
    /// successfully with nothing owed): the daemon's autonomous run
    /// still owes turns, its windows credit to the task, and the
    /// flow's headless-completion step settles it.
    pub fn mark_awaiting_completion(&mut self, id: &str) {
        self.with_task(id, |entry| {
            if !entry.state.is_terminal() {
                entry.awaiting_completion = true;
            }
        });
    }

    /// Close one continuation run of a task whose prompt response
    /// already settled (`awaiting_completion`, the pump's `agent_end`
    /// step): the run's joined text extends the task's artifact — the
    /// live stream already carried it when the deltas streamed (the
    /// ends-with check publishes nothing), and the windowed text
    /// replaces or appends when they did not (the fallback when the
    /// deltas missed the reply). A trailing blank-line separator — the
    /// optimistic join the live stream appends at an assistant
    /// message's start — never doubles. A run that failed carries its
    /// reason to the final settlement (a failed continuation never
    /// settles behind a successful prompt); its text still extends the
    /// artifact — the work's partial output is real.
    pub fn continuation_run_closed(
        &mut self,
        id: &str,
        run_text: Option<&str>,
        error: Option<&str>,
    ) {
        if error.is_some() {
            self.with_task(id, |entry| {
                if !entry.state.is_terminal() && entry.awaiting_completion {
                    entry.continuation_error = error.map(str::to_string);
                }
            });
        } else {
            // A successful continuation recovers a parked failure
            // (the auto-retry re-ran the delivery and it answered):
            // the final settlement keeps the run's own outcome, never
            // an earlier attempt's transient error.
            self.with_task(id, |entry| {
                if !entry.state.is_terminal() && entry.awaiting_completion {
                    entry.continuation_error = None;
                }
            });
        }
        let Some(text) = run_text.filter(|text| !text.is_empty()) else {
            return;
        };
        let current = self
            .with_task(id, |entry| {
                if entry.state.is_terminal() || !entry.awaiting_completion {
                    return None;
                }
                Some(entry.assistant_text.clone())
            })
            .flatten();
        let Some(current) = current else { return };
        if current.ends_with(text) {
            return;
        }
        let joined = if current.is_empty() {
            text.to_string()
        } else if current.ends_with("\n\n") {
            format!("{current}{text}")
        } else {
            format!("{current}\n\n{text}")
        };
        self.set_artifact_text(id, &joined);
    }

    /// Take the failure reason an autonomous continuation run recorded
    /// (the flow's final settlement reads it once — a failed
    /// continuation settles the task FAILED with the run's own reason,
    /// never behind the successful prompt's verdict).
    pub fn take_continuation_error(&mut self, id: &str) -> Option<String> {
        self.with_task(id, |entry| entry.continuation_error.take())
            .flatten()
    }

    /// Open one in-flight `CancelTask` withdrawal (the cancel's
    /// withdraw arm, under the state guard before its dispatch): the
    /// withdrawal owns the task's ONE terminal verdict from here — the
    /// completion settle that lands inside the flight parks its verdict
    /// (see [`Self::park_deferred_verdict`]) and the receipt resolves
    /// it.
    pub fn mark_withdraw_inflight(&mut self, id: &str) {
        self.with_task(id, |entry| entry.withdraw_inflight += 1);
    }

    /// Resolve one withdrawal's receipt: an accepted receipt (`stopped`:
    /// the withdrawal succeeded — the client's cancel of its own
    /// awaiting task is the stop's authority, whatever the sweep named)
    /// settles CANCELED as the task's FIRST terminal verdict — at once,
    /// whatever other withdrawals are still in flight (their receipts
    /// then answer a terminal task, and the settle's own close zeroes
    /// the count, so a later receipt can never publish the verdict the
    /// completion settle parked behind the flight). A refused receipt
    /// decrements the count and publishes the parked verdict only at
    /// zero AND while no cancel ladder is still in flight — an
    /// in-flight ladder owns the verdict until its own answer resolves
    /// it (see [`Self::resolve_ladder_owned`] /
    /// [`Self::resolve_ladder_refused`]): a retried cancel's refused
    /// receipt landing while the first cancel's ladder `owned` still
    /// travels never publishes the verdict the completion settle
    /// parked behind EITHER authority (or settles nothing when none
    /// parked — the task keeps its own course).
    pub fn close_withdraw_inflight(&mut self, id: &str, stopped: bool) {
        if self.task(id).is_some_and(|task| task.state().is_terminal()) {
            return;
        }
        if stopped {
            self.settle(id, TaskState::Canceled, None);
            return;
        }
        let last = self
            .with_task(id, |entry| {
                entry.withdraw_inflight = entry.withdraw_inflight.saturating_sub(1);
                entry.withdraw_inflight == 0
            })
            .unwrap_or(false);
        if !last || self.ladder_inflight(id) {
            return;
        }
        self.settle_deferred_verdict(id);
    }

    /// Publish the verdict the completion settle parked behind a
    /// pending cancel authority, with the ladder's accepted abort
    /// applied where its mark stands: a COMPLETED verdict on a marked
    /// task is the stop the client asked for — CANCELED — never the
    /// raw completion a retried cancel's parked settle would publish
    /// past the mark (see [`Self::mark_cancel_abort`]).
    fn settle_deferred_verdict(&mut self, id: &str) {
        if let Some((state, error)) = self.take_deferred_verdict(id) {
            let (state, error) = if state == TaskState::Completed && self.cancel_abort_marked(id) {
                (TaskState::Canceled, None)
            } else {
                (state, error)
            };
            self.settle(id, state, error);
        }
    }

    /// Park the verdict the completion settle would publish, behind the
    /// task's in-flight cancel authorities — a withdrawal's receipt or
    /// a ladder's `owned`/refusal answer (the settle calls this instead
    /// of publishing while either is pending): the authority's receipt
    /// publishes it — as it stands for a refusal, through the standing
    /// mark for an accepted abort (see [`Self::settle_deferred_verdict`]).
    pub fn park_deferred_verdict(&mut self, id: &str, state: TaskState, error: Option<String>) {
        self.with_task(id, |entry| {
            if entry.withdraw_inflight > 0 || entry.ladder_inflight > 0 {
                entry.deferred_verdict = Some((state, error));
            }
        });
    }

    /// Take the parked verdict (the refused receipt's publish).
    fn take_deferred_verdict(&mut self, id: &str) -> Option<(TaskState, Option<String>)> {
        self.with_task(id, |entry| entry.deferred_verdict.take())
            .flatten()
    }

    /// Whether a `CancelTask` withdrawal is in flight for the task: the
    /// completion settle consults it before publishing — an in-flight
    /// withdrawal owns the task's one terminal verdict, whatever the
    /// completion holds.
    pub fn withdraw_inflight(&self, id: &str) -> bool {
        self.task(id).is_some_and(|task| task.withdraw_inflight > 0)
    }

    /// Mark the task's cancel ladder as having accepted its own
    /// running-turn abort (the `owned` answer): a success response on a
    /// marked task settles CANCELED (see
    /// [`TaskEntry::cancel_abort_marked`]).
    pub fn mark_cancel_abort(&mut self, id: &str) {
        self.with_task(id, |entry| {
            if !entry.state.is_terminal() {
                entry.cancel_abort_marked = true;
            }
        });
    }

    /// Whether the cancel ladder accepted the task's running-turn abort.
    pub fn cancel_abort_marked(&self, id: &str) -> bool {
        self.task(id).is_some_and(|task| task.cancel_abort_marked)
    }

    /// Open the task's in-flight cancel ladder (the cancel's ladder arm,
    /// under the state guard BEFORE its dispatch): the worker aborts
    /// the running turn before the ladder's response travels, so a
    /// completion settle that lands while the receipt is in flight
    /// parks behind this authority instead of publishing — the
    /// ladder's response resolves it (see
    /// [`Self::resolve_ladder_owned`] /
    /// [`Self::resolve_ladder_refused`]). Overlapping ladders each
    /// open their own share of the authority, so each resolves only
    /// its own.
    pub fn mark_ladder_inflight(&mut self, id: &str) {
        self.with_task(id, |entry| entry.ladder_inflight += 1);
    }

    /// Whether the task has a cancel ladder in flight: the completion
    /// settle consults it before publishing — an in-flight ladder owns
    /// the task's one terminal verdict while its receipt travels.
    pub fn ladder_inflight(&self, id: &str) -> bool {
        self.task(id).is_some_and(|task| task.ladder_inflight > 0)
    }

    /// The ladder's `owned` answer resolves its pending authority: the
    /// accepted abort owns the task's verdict and settles it at once,
    /// whatever other cancel authorities are still in flight — a
    /// pending receipt can neither delay the stop the worker already
    /// accepted nor publish anything after it (their receipts then
    /// answer a terminal task, and the settle's own close zeroes the
    /// counts, so no later refusal can strand the accepted abort
    /// unpublished behind a run-on child). A verdict the completion
    /// settle parked behind the ladder publishes as the stop the client
    /// asked for (CANCELED — the mark this resolve installs applies the
    /// same conversion the publish path reads), and with nothing parked
    /// the abort settles CANCELED directly. The work the aborted turn
    /// already delegated keeps running, and its later notice turns
    /// resolve foreign to the settled task, so the task never waits the
    /// descendants out.
    pub fn resolve_ladder_owned(&mut self, id: &str) {
        if self.task(id).is_some_and(|task| task.state().is_terminal()) {
            return;
        }
        let _ = self.with_task(id, |entry| {
            entry.ladder_inflight = entry.ladder_inflight.saturating_sub(1);
        });
        self.mark_cancel_abort(id);
        let parked = self
            .with_task(id, |entry| entry.deferred_verdict.is_some())
            .unwrap_or(false);
        if parked {
            self.settle_deferred_verdict(id);
        } else {
            self.settle(id, TaskState::Canceled, None);
        }
    }

    /// The ladder's refusal (an `unknown` that outlived its window, an
    /// error response, a transport failure, a request future dropped at
    /// the client's EOF) resolves its pending authority the same way a
    /// refused withdrawal does: the verdict the task's own run parked
    /// behind the ladder publishes as it stands — no stop was accepted,
    /// and the task keeps its own course.
    pub fn resolve_ladder_refused(&mut self, id: &str) {
        if self.task(id).is_some_and(|task| task.state().is_terminal()) {
            return;
        }
        let last = self
            .with_task(id, |entry| {
                entry.ladder_inflight = entry.ladder_inflight.saturating_sub(1);
                entry.ladder_inflight == 0
            })
            .unwrap_or(false);
        if !last || self.withdraw_inflight(id) {
            return;
        }
        self.settle_deferred_verdict(id);
    }

    /// Park the reply of the task's own first run (the run its prompt
    /// anchored, closed at `agent_end` before the prompt response
    /// arrived — the flush barrier orders the response after the run's
    /// frames): the response claims it as the artifact. The whole
    /// run's text is the reply, never one model-step window (a
    /// tool-calling turn's artifact is all of its rounds).
    pub fn park_initial_run_reply(&mut self, id: &str, text: Option<&str>) {
        self.with_task(id, |entry| {
            if !entry.state.is_terminal() && entry.prompt_write_claimed() {
                // The newest owned run before the response is the
                // turn's answer: a retry or continuation of the run
                // takes the reply over (the failed first attempt's
                // text is never the artifact).
                entry.initial_run_reply = text.map(str::to_string);
            }
        });
    }

    /// Park one engine continuation run that closed before the task's
    /// prompt response arrived (the response lags the run the daemon
    /// minted behind the prompt): the response's settle step applies
    /// the parked lot in run order — the same settlement a
    /// post-response continuation's `agent_end` owns, so the
    /// continuation's output and its outcome are never dropped behind
    /// the ordering.
    pub fn park_autonomous_run(&mut self, id: &str, run_text: Option<&str>, error: Option<&str>) {
        self.park_order += 1;
        let order = self.park_order;
        self.with_task(id, |entry| {
            if !entry.state.is_terminal() && entry.prompt_dispatched() {
                entry.parked_autonomous.push_back((
                    order,
                    run_text.map(str::to_string),
                    error.map(str::to_string),
                ));
            }
        });
    }

    /// Take the task's parked pre-response continuation results (the
    /// response's settle step applies them once, in order).
    pub fn take_parked_autonomous(
        &mut self,
        id: &str,
    ) -> Vec<(u64, Option<String>, Option<String>)> {
        self.with_task(id, |entry| entry.parked_autonomous.drain(..).collect())
            .unwrap_or_default()
    }

    /// The task's parked initial-run reply, claimed by the prompt
    /// response (the whole-run artifact authority; `None` when no owned
    /// run closed before the response — the window claim is the
    /// fallback then).
    pub fn take_initial_run_reply(&mut self, id: &str) -> Option<String> {
        self.with_task(id, |entry| entry.initial_run_reply.take())
            .flatten()
    }

    /// Rebind a task to its session's fresh active id (a re-host
    /// replaced the worker): the events' routing key and the daemon
    /// command selector follow.
    pub fn rebind_session(&mut self, id: &str, session_id: &str) {
        self.with_task(id, |entry| {
            entry.session_id = session_id.to_string();
        });
    }

    /// The task's dispatch-handoff state: whether the prompt is already
    /// written (or the task is terminal — a failed dispatch settles
    /// the task, ending the wait), plus the signal that fires when the
    /// dispatch lands. The caller awaits the signal without holding the
    /// registry.
    pub fn prompt_dispatch_state(&self, id: &str) -> Option<(bool, std::sync::Arc<Notify>)> {
        self.tasks.get(id).map(|entry| {
            (
                entry.dispatch == PromptDispatch::Dispatched || entry.state.is_terminal(),
                std::sync::Arc::clone(&entry.dispatch_notify),
            )
        })
    }

    /// The task at the head of a context's queue: the one the session's
    /// events belong to.
    pub fn head(&self, context_id: &str) -> Option<&TaskEntry> {
        self.queues
            .get(context_id)
            .and_then(VecDeque::front)
            .and_then(|id| self.tasks.get(id))
    }

    /// Look up one task for `GetTask` / `CancelTask` / subscription.
    pub fn task(&self, id: &str) -> Option<&TaskEntry> {
        self.tasks.get(id)
    }

    /// The mode's teardown split (the exit's settlement decision, read
    /// under the state guard that refuses new admissions): every live
    /// task whose prompt never reached the daemon — still waiting for
    /// its context's queue head or a quiet session, or claimed for a
    /// write whose send step has not run — settles CANCELED at the exit
    /// (nothing in the daemon names it, and its flow's write step
    /// observes the terminal row under the same guard), so their ids
    /// answer first; the live dispatched tasks answer their
    /// `(task id, daemon session, delivery identity)` triples for the
    /// withdrawal walk (their prompts may sit in the supervisor's
    /// dispatch, so the walk retries a no-op receipt).
    pub fn shutdown_live_split(&self) -> (Vec<String>, Vec<(String, String, String)>) {
        let mut undispatched = Vec::new();
        let mut dispatched = Vec::new();
        for (id, entry) in &self.tasks {
            if entry.state.is_terminal() {
                continue;
            }
            if entry.dispatch == PromptDispatch::Dispatched {
                dispatched.push((
                    id.clone(),
                    entry.session_id.clone(),
                    entry.delivery_id.clone(),
                ));
            } else {
                undispatched.push(id.clone());
            }
        }
        (undispatched, dispatched)
    }

    /// Mutate one task under a guard and return the borrow.
    fn with_task<R>(&mut self, id: &str, f: impl FnOnce(&mut TaskEntry) -> R) -> Option<R> {
        self.tasks.get_mut(id).map(f)
    }

    /// Subscribe to a task's stream (spec 3.5.2): every publish after
    /// this lands on the returned receiver until the task settles. A
    /// terminal task subscribes to nothing — checked under the same
    /// guard that registers the sink, so a subscribe that follows an
    /// awaited step (a cancel's sweep) can never park a receiver no
    /// later event will close.
    pub fn subscribe(&mut self, id: &str) -> Option<StreamReceiver<StreamResponse>> {
        let (tx, rx) = tokio::sync::mpsc::channel(SUBSCRIBER_QUEUE_FRAMES);
        self.with_task(id, |entry| {
            if entry.state.is_terminal() {
                return None;
            }
            entry.register_stream(tx);
            Some(())
        })
        .flatten()?;
        Some(rx)
    }

    /// Subscribe to a task's stream and capture its snapshot under the
    /// same registry guard (spec 3.5.2's ordered events): a publish
    /// after the guard is only in the live stream, one before it only
    /// in the snapshot — never both, never neither. A terminal task
    /// answers `None` (no receiver a later event would strand).
    pub fn subscribe_with_snapshot(
        &mut self,
        id: &str,
        history_length: Option<u32>,
    ) -> Option<(Task, StreamReceiver<StreamResponse>)> {
        let (tx, rx) = tokio::sync::mpsc::channel(SUBSCRIBER_QUEUE_FRAMES);
        self.with_task(id, |entry| {
            if entry.state.is_terminal() {
                return None;
            }
            entry.register_stream(tx);
            Some(entry.snapshot(history_length, true))
        })
        .flatten()
        .map(|snapshot| (snapshot, rx))
    }

    /// A finite one-frame stream for a settled task's verdict: the
    /// terminal status frame answers the subscriber and closes the
    /// stream — a successful streaming method stays SSE whatever the
    /// scheduling (spec 9.4.2), never a JSON reply raced out of the
    /// stream shape. The verdict is the caller's snapshot (the
    /// registry's row while the window keeps it, a reply claim's
    /// captured verdict once it advanced past it).
    #[must_use]
    pub fn terminal_stream_for_status(
        task_id: &str,
        context_id: &str,
        status: TaskStatus,
    ) -> StreamReceiver<StreamResponse> {
        let event = TaskStatusUpdateEvent {
            task_id: task_id.to_string(),
            context_id: context_id.to_string(),
            status,
            metadata: None,
        };
        let (tx, rx) = tokio::sync::mpsc::channel(SUBSCRIBER_QUEUE_FRAMES);
        // A fresh queue holds its first frame; `try_send` keeps this
        // sync fn un-awaited (the publish path's own vocabulary).
        let _ = tx.try_send(StreamResponse::StatusUpdate(event));
        rx
    }

    /// Publish one stream response to every active subscriber: a closed
    /// sink and a subscriber at its queue bound both leave the list (a
    /// non-reading subscriber is DROPPED, never buffered past its
    /// bound, never awaited — the pump keeps its frame order whatever
    /// one slow reader does); the last-chunk close is the subscriber's
    /// own SSE decision, driven by the terminal frame.
    fn publish(&mut self, id: &str, response: &StreamResponse) {
        self.with_task(id, |entry| {
            entry
                .streams
                .retain(|sink| sink.try_send(response.clone()).is_ok());
            entry.updated_at = crate::util::now_ms();
        });
    }

    /// The task entered `WORKING` — the transition's publish (spec
    /// 3.5.2: events in order). The dispatch mark routes through here
    /// (WORKING at its own turn's start, not at its first assistant
    /// frame).
    pub fn mark_working(&mut self, id: &str) {
        self.publish_status(id, TaskState::Working, None);
    }

    /// One text delta of the turn's reply: the artifact chunk a
    /// streaming client appends (spec 3.1.2: `TaskArtifactUpdateEvent`).
    /// The first chunk of an artifact creates it (`append: false`); a
    /// chunk extending a previously sent artifact appends (`append:
    /// true`, the proto's rule: append requires the artifact to
    /// exist — a first chunk sent as an append is a protocol error a
    /// conforming client rejects).
    pub fn append_artifact_chunk(&mut self, id: &str, chunk: &str) {
        let append = self
            .with_task(id, |entry| {
                let extends = !entry.assistant_text.is_empty();
                entry.assistant_text.push_str(chunk);
                extends
            })
            .unwrap_or(true);
        let Some(entry) = self.tasks.get(id) else {
            return;
        };
        let event = TaskArtifactUpdateEvent {
            task_id: entry.id.clone(),
            context_id: entry.context_id.clone(),
            artifact: Artifact {
                artifact_id: format!("artifact-{}", entry.id),
                name: Some(RESPONSE_ARTIFACT_NAME.to_string()),
                description: None,
                parts: vec![Part::text(chunk)],
                metadata: None,
                extensions: None,
            },
            append: Some(append),
            last_chunk: Some(false),
            metadata: None,
        };
        let response = StreamResponse::ArtifactUpdate(event);
        self.publish(id, &response);
    }

    /// Replace the accumulated artifact text — the fallback when the
    /// deltas missed the reply, the pump's exact turn-window claim, or
    /// the honest empty answer that clears a stale streamed reply. A
    /// changed text publishes one complete `artifactUpdate` (`append:
    /// false`) so an already-connected stream receives the replacement
    /// before the terminal status closes it; an unchanged text (the
    /// normal streamed case) publishes nothing new. A changed-to-empty
    /// text publishes the empty replacement: without it a live stream
    /// keeps the stale text it already received while `GetTask`
    /// correctly reports no artifact.
    pub fn set_artifact_text(&mut self, id: &str, text: &str) {
        let changed = self
            .with_task(id, |entry| {
                let changed = entry.assistant_text != text;
                if changed {
                    entry.assistant_text.clear();
                    entry.assistant_text.push_str(text);
                    entry.updated_at = crate::util::now_ms();
                }
                changed
            })
            .unwrap_or(false);
        if !changed {
            return;
        }
        let Some(entry) = self.tasks.get(id) else {
            return;
        };
        let event = TaskArtifactUpdateEvent {
            task_id: entry.id.clone(),
            context_id: entry.context_id.clone(),
            artifact: entry.artifact(),
            append: Some(false),
            last_chunk: Some(true),
            metadata: None,
        };
        let response = StreamResponse::ArtifactUpdate(event);
        self.publish(id, &response);
    }

    /// Publish one status transition. A terminal task keeps its first
    /// verdict, and a transition to the state it already holds publishes
    /// nothing (the WORKING mark at dispatch and the pump's own frame
    /// path both idempotent).
    fn publish_status(&mut self, id: &str, state: TaskState, error: Option<String>) {
        let Some(response) = self
            .with_task(id, |entry| {
                if entry.state.is_terminal() || entry.state == state {
                    return None;
                }
                entry.state = state;
                // The message text borrows the error before it moves
                // into the entry: one message build, no clone.
                let message = error.as_deref().map(|error| entry.status_message(error));
                entry.error = error;
                let event = TaskStatusUpdateEvent {
                    task_id: entry.id.clone(),
                    context_id: entry.context_id.clone(),
                    status: TaskStatus {
                        state,
                        message,
                        timestamp: Some(crate::util::iso_from_unix_ms(crate::util::now_ms())),
                    },
                    metadata: None,
                };
                Some(StreamResponse::StatusUpdate(event))
            })
            .flatten()
        else {
            return;
        };
        self.publish(id, &response);
    }

    /// Retire the task from its context's queue (the pump's synchronous
    /// step at the task's prompt response, so later session frames
    /// credit to the next queued task). Idempotent; the settle's own
    /// retirement runs through here too.
    pub fn retire(&mut self, id: &str) {
        let Some(entry) = self.tasks.get(id) else {
            return;
        };
        let context_id = entry.context_id.clone();
        if let Some(queue) = self.queues.get_mut(&context_id) {
            queue.retain(|queued| queued != id);
            if queue.is_empty() {
                self.queues.remove(&context_id);
            }
        }
        // The rotation is the write turnstile's wake: the next head's
        // flow sees its turn under the registry guard.
        self.head_notify.notify_waiters();
    }

    /// Settle the task (its turn's `PromptAndWait` answered, its
    /// cancellation landed, or its deferred continuation closed):
    /// publish the terminal transition and retire it from its context's
    /// queue. A terminal task stays settled — the first verdict wins.
    /// The parked run data dies with the settle (the terminal task's
    /// late pump steps discard it).
    pub fn settle(&mut self, id: &str, state: TaskState, error: Option<String>) {
        let newly_terminal = state.is_terminal()
            && self
                .task(id)
                .is_some_and(|task| !task.state().is_terminal());
        self.publish_status(id, state, error);
        // The terminal frame closes every stream (spec 3.1.2): the
        // sinks go away with the queue retirement, and the reply claims
        // capture the settled truth — under the same registry lock that
        // retires the task and (below) advances the retention window,
        // so a reply read after the window moved past the task still
        // answers its own verdict.
        if let Some(entry) = self.tasks.get_mut(id) {
            entry.streams.clear();
            entry.initial_run_reply = None;
            entry.parked_autonomous.clear();
            // A terminal task owes no more cancel authority: the first
            // verdict stands, the parked one dies unpublished, and a
            // late receipt's count close is the no-op above.
            entry.withdraw_inflight = 0;
            entry.deferred_verdict = None;
            entry.cancel_abort_marked = false;
            entry.ladder_inflight = 0;
            for claim in std::mem::take(&mut entry.verdict_claims) {
                // A reader that already answered or disconnected (its
                // claim dropped, the slot died with it) owes no reply:
                // the upgrade fails and the settle skips its snapshot
                // work entirely.
                if let Some(slot) = claim.slot.upgrade() {
                    *slot.lock().expect("verdict claim lock") =
                        Some(entry.snapshot(claim.history_length, true));
                }
            }
        }
        self.retire(id);
        if newly_terminal {
            // The retention window (see [`MAX_RETAINED_TERMINAL_TASKS`]):
            // the just-settled task is always the window's newest — every
            // flow still reading it (its own blocking send, a late
            // `GetTask`, the SSE close) is served — and the oldest
            // terminal task beyond the window leaves the registry.
            self.terminal_order.push_back(id.to_string());
            self.prune_terminal();
        }
    }

    /// Claim one reply's verdict for a task the caller's registry step
    /// just accepted (the send's admission, the cancel's acceptance —
    /// all under the same guard): the
    /// task's first terminal settle captures its final snapshot into
    /// the claim, and a task that already settled captures its
    /// standing verdict at registration.
    pub fn claim_verdict(&mut self, id: &str, history_length: Option<u32>) -> Option<VerdictClaim> {
        let slot = std::sync::Arc::new(std::sync::Mutex::new(None));
        self.with_task(id, |entry| {
            if entry.state.is_terminal() {
                *slot.lock().expect("verdict claim lock") =
                    Some(entry.snapshot(history_length, true));
            } else {
                // The registration is non-owning: prune the readers
                // that already answered or disconnected (their slots
                // died with their claims), then register this one — a
                // long-running task never accumulates its dead
                // readers' claims, and the settle below captures into
                // exactly the readers that still owe a reply.
                entry
                    .verdict_claims
                    .retain(|claim| claim.slot.upgrade().is_some());
                entry.verdict_claims.push(VerdictRegistration {
                    history_length,
                    slot: std::sync::Arc::downgrade(&slot),
                });
            }
        })
        .map(|()| VerdictClaim {
            history_length,
            slot,
        })
    }

    /// The retention window's prune: only terminal tasks OLDER than the
    /// newest [`MAX_RETAINED_TERMINAL_TASKS`] rows leave the registry —
    /// the window is exactly the newest rows. A reply that still owes a
    /// client an answer reads its verdict from the claim its flow
    /// registered at its acceptance: the settle captured the final
    /// snapshot into it under this same critical section, so the
    /// window stays its bound exactly, never the bound plus live
    /// readers' rows.
    fn prune_terminal(&mut self) {
        while self.terminal_order.len() > MAX_RETAINED_TERMINAL_TASKS {
            let Some(oldest) = self.terminal_order.pop_front() else {
                break;
            };
            self.tasks.remove(&oldest);
        }
    }

    /// One task's snapshot for `GetTask` (artifacts always included).
    pub fn snapshot(&self, id: &str, history_length: Option<u32>) -> Option<Task> {
        self.task(id)
            .map(|entry| entry.snapshot(history_length, true))
    }

    /// The `ListTasks` page (spec 3.1.4): the tasks sorted by last
    /// update descending, filtered by context, state, and the inclusive
    /// `statusTimestampAfter` floor (nanoseconds since the epoch, the
    /// caller's parsed `google.protobuf.Timestamp`, so sub-millisecond
    /// filters compare at their true instant); the rows omit artifacts
    /// unless
    /// `include_artifacts` asks for them (spec: the default omits).
    /// The cursor is the boundary the last page ended on — the last
    /// row's `updated_at` and id, bound to this registry's run id (see
    /// [`encode_page_token`]) — and the walk resumes STRICTLY after it:
    /// a row that updated between pages moves ahead of the boundary and
    /// is never replayed, and a row that left the filter never restarts
    /// the walk at page one. `None` answers the caller's invalid-params:
    /// the token is not one this server minted, never a silent restart.
    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub fn list(
        &self,
        context_id: Option<&str>,
        status: Option<TaskState>,
        status_timestamp_after: Option<i128>,
        include_artifacts: bool,
        history_length: Option<u32>,
        page_size: Option<u32>,
        page_token: Option<&str>,
    ) -> Option<(Vec<Task>, String, u32, u32)> {
        let size = page_size
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE);
        // The boundary decoded BEFORE the table read (an undecodable or
        // foreign-run token never reaches the walk).
        let boundary = match page_token {
            Some(token) => decode_page_token(self.page_token_nonce, token)?,
            None => (0, String::new()),
        };
        let mut rows: Vec<&TaskEntry> = self
            .tasks
            .values()
            .filter(|entry| {
                context_id.is_none_or(|context| entry.context_id == context)
                    && status.is_none_or(|state| entry.state == state)
                    && status_timestamp_after
                        .is_none_or(|after| i128::from(entry.updated_at) * 1_000_000 >= after)
            })
            .collect();
        // The same-millisecond ties break by id descending, so a page
        // walk is deterministic for rows updated together.
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.id.cmp(&a.id)));
        let total = rows.len() as u32;
        // The rows the previous pages already served: every row at or
        // ahead of the boundary in the descending order (the boundary
        // row included, wherever it moved since). The walk resumes
        // strictly after them.
        let after = if page_token.is_some() {
            let (at, id) = boundary;
            rows.partition_point(|entry| (entry.updated_at, entry.id.as_str()) >= (at, id.as_str()))
        } else {
            0
        };
        let page: Vec<Task> = rows
            .iter()
            .skip(after)
            .take(size as usize)
            .map(|entry| entry.snapshot(history_length, include_artifacts))
            .collect();
        let next = if (after + page.len()) < rows.len() {
            rows.get(after + page.len() - 1)
                .map_or_else(String::new, |entry| {
                    encode_page_token(self.page_token_nonce, entry.updated_at, &entry.id)
                })
        } else {
            String::new()
        };
        Some((page, next, size, total))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl super::TaskArtifactUpdateEvent {
        /// Test-only: the first part's text.
        fn parts_text(&self) -> String {
            self.artifact.parts[0].text.clone().unwrap_or_default()
        }
    }

    fn registry() -> (TaskRegistry, String) {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx-1".into(),
            "s-1".into(),
            Some("client-message-1".into()),
            vec![Part::text("What is A2A?")],
        );
        (registry, "t-1".into())
    }

    fn frame_texts(frames: &[StreamResponse]) -> Vec<(Option<bool>, String)> {
        frames
            .iter()
            .filter_map(|frame| match frame {
                StreamResponse::ArtifactUpdate(event) => Some((event.append, event.parts_text())),
                _ => None,
            })
            .collect()
    }

    fn frame_states(frames: &[StreamResponse]) -> Vec<TaskState> {
        frames
            .iter()
            .filter_map(|frame| match frame {
                StreamResponse::StatusUpdate(event) => Some(event.status.state),
                _ => None,
            })
            .collect()
    }

    /// The lifecycle an admitted task walks: SUBMITTED, WORKING on the
    /// first frame, artifact chunks appended, terminal state last.
    #[test]
    fn a_task_walks_the_spec_lifecycle() {
        let (mut registry, id) = registry();
        let mut stream = registry.subscribe(&id).expect("subscribable");

        registry.mark_working(&id);
        registry.append_artifact_chunk(&id, "The ");
        registry.append_artifact_chunk(&id, "A2A protocol.");

        let task = registry.snapshot(&id, None).expect("snapshot");
        assert_eq!(task.status.state, TaskState::Working);
        assert_eq!(
            task.history[0].parts[0].text.as_deref(),
            Some("What is A2A?")
        );
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("The A2A protocol."),
            "the streamed chunks are the artifact"
        );

        registry.settle(&id, TaskState::Completed, None);
        let task = registry.snapshot(&id, None).expect("snapshot");
        assert_eq!(task.status.state, TaskState::Completed);
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("The A2A protocol.")
        );
        assert_eq!(
            task.history[1].parts[0].text.as_deref(),
            Some("The A2A protocol.")
        );

        // The stream saw exactly the spec's ordered frames: the WORKING
        // status, two artifact chunks, the terminal status (spec 3.5.2)
        // — the first chunk CREATED the artifact (append: false, the
        // proto's rule), the second extended it (append: true), and the
        // settled text equaled the streamed chunks, so the settle
        // publishes no third artifact frame.
        let frames: Vec<StreamResponse> = std::iter::from_fn(|| stream.try_recv().ok()).collect();
        assert_eq!(
            frame_states(&frames),
            vec![TaskState::Working, TaskState::Completed]
        );
        assert_eq!(
            frame_texts(&frames),
            vec![
                (Some(false), "The ".to_string()),
                (Some(true), "A2A protocol.".to_string())
            ]
        );
        // The received message ids ride the history verbatim, and the
        // agent message id is one stable id across reads (spec 4.1.4:
        // the creator sets `messageId`; duplicates stay detectable).
        assert_eq!(task.history[0].message_id, "client-message-1");
        let again = registry.snapshot(&id, None).unwrap();
        assert_eq!(again.history[0].message_id, "client-message-1");
        assert_eq!(
            again.history[1].message_id, task.history[1].message_id,
            "the agent message id is stable across reads"
        );
    }

    /// The atomic subscribe-and-snapshot (spec 3.5.2's ordered
    /// events): a chunk published before the guard is only in the
    /// snapshot, one published after it only in the live stream —
    /// never both, never neither (a snapshot read in a second lock
    /// scope would duplicate every frame that lands between them).
    #[test]
    fn a_subscribed_snapshot_never_replays_a_queued_chunk() {
        let (mut registry, id) = registry();
        registry.mark_working(&id);
        registry.append_artifact_chunk(&id, "first");
        let (snapshot, mut stream) = registry
            .subscribe_with_snapshot(&id, None)
            .expect("subscribable");
        assert_eq!(
            snapshot.artifacts[0].parts[0].text.as_deref(),
            Some("first"),
            "the chunk published before the guard is in the snapshot"
        );
        assert!(
            stream.try_recv().is_err(),
            "the snapshot's chunk is not also queued on the stream"
        );
        registry.append_artifact_chunk(&id, "second");
        let frames: Vec<StreamResponse> = std::iter::from_fn(|| stream.try_recv().ok()).collect();
        assert_eq!(
            frame_texts(&frames),
            vec![(Some(true), "second".to_string())],
            "only the post-guard chunk rides the stream: {frames:?}"
        );
        // A terminal task answers no receiver at all.
        registry.settle(&id, TaskState::Completed, None);
        assert!(registry.subscribe_with_snapshot(&id, None).is_none());
    }

    /// The continuation accumulation: the run's windowed text extends
    /// an awaiting-completion task's artifact — exactly once, whether
    /// the deltas streamed or were missed — and ignores terminal or
    /// plain tasks.
    #[test]
    fn a_continuation_run_extends_the_artifact_once() {
        let (mut registry, id) = registry();
        registry.mark_working(&id);
        registry.set_artifact_text(&id, "FIRST-TURN");

        // A plain task (its response not settled by the pump) ignores
        // the run's text.
        registry.continuation_run_closed(&id, Some("IGNORED"), None);
        assert_eq!(
            registry.snapshot(&id, None).unwrap().artifacts[0].parts[0]
                .text
                .as_deref(),
            Some("FIRST-TURN")
        );

        registry.mark_awaiting_completion(&id);
        // The streamed run (the artifact already ends with the run's
        // text) publishes nothing.
        registry.continuation_run_closed(&id, Some("FIRST-TURN"), None);
        // The missed-delta run appends with the blank-line join.
        registry.continuation_run_closed(&id, Some("CONTINUATION"), None);
        assert_eq!(
            registry.snapshot(&id, None).unwrap().artifacts[0].parts[0]
                .text
                .as_deref(),
            Some("FIRST-TURN\n\nCONTINUATION")
        );
        // A terminal task ignores further runs.
        registry.settle(&id, TaskState::Completed, None);
        registry.continuation_run_closed(&id, Some("LATE"), None);
        assert_eq!(
            registry.snapshot(&id, None).unwrap().artifacts[0].parts[0]
                .text
                .as_deref(),
            Some("FIRST-TURN\n\nCONTINUATION")
        );
    }

    /// A later artifact text (the fallback or the pump's window claim)
    /// reaches an already-connected subscriber as one complete
    /// `artifactUpdate` before the terminal status closes the stream.
    #[test]
    fn a_replaced_artifact_publishes_one_complete_update() {
        let (mut registry, id) = registry();
        let mut stream = registry.subscribe(&id).expect("subscribable");
        registry.mark_working(&id);
        registry.set_artifact_text(&id, "the non-streamed reply");
        let task = registry.snapshot(&id, None).unwrap();
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("the non-streamed reply")
        );
        registry.settle(&id, TaskState::Completed, None);
        let frames: Vec<StreamResponse> = std::iter::from_fn(|| stream.try_recv().ok()).collect();
        assert_eq!(
            frame_texts(&frames),
            vec![(Some(false), "the non-streamed reply".to_string())],
            "the replaced artifact is one append:false frame: {frames:?}"
        );
        assert_eq!(
            frame_states(&frames),
            vec![TaskState::Working, TaskState::Completed]
        );
    }

    /// The prompt-dispatch handoff: the dispatch state is the
    /// (bounded) wait's own material — a parked canceler wakes when the
    /// prompt is marked dispatched, a terminal task reads as arrived,
    /// and the wait holds no registry guard (the notify is cloned out
    /// under it).
    #[tokio::test]
    async fn the_prompt_dispatch_handoff_wakes_a_waiting_cancel() {
        let (mut registry, id) = registry();

        let (ready, notify) = registry.prompt_dispatch_state(&id).expect("the task");
        assert!(!ready, "an undispatched prompt keeps the cancel waiting");

        // The wait parks on the cloned notify, outside any guard; the
        // mark wakes it.
        let waiter = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_secs(5), notify.notified()).await
        });
        tokio::task::yield_now().await;
        registry.mark_prompt_dispatched(&id, None);
        assert!(
            waiter.await.unwrap().is_ok(),
            "the dispatched prompt wakes the parked waiter"
        );
        assert!(
            registry.prompt_dispatch_state(&id).unwrap().0,
            "the mark ends the wait at once"
        );

        // A failed dispatch settles the task; the wait then ends on the
        // terminal state alone.
        registry.settle(&id, TaskState::Failed, Some("dispatch failed".into()));
        assert!(
            registry.prompt_dispatch_state(&id).unwrap().0,
            "a terminal task ends the wait immediately"
        );
    }

    /// A failed settle carries the error in the status message.
    #[test]
    fn a_failed_settle_carries_the_error_message() {
        let (mut registry, id) = registry();
        registry.mark_working(&id);
        registry.settle(&id, TaskState::Failed, Some("provider down".into()));
        let task = registry.snapshot(&id, None).expect("snapshot");
        assert_eq!(
            task.status.message.as_ref().unwrap().parts[0]
                .text
                .as_deref(),
            Some("provider down")
        );
    }

    /// `historyLength` trims from the front (spec 3.2.4: the most
    /// recent messages).
    #[test]
    fn history_length_trims_the_oldest() {
        let (mut registry, id) = registry();
        // The turn streamed its reply (the window claim / the streamed
        // chunks are the reply source; the settle carries no text of
        // its own).
        registry.append_artifact_chunk(&id, "answer");
        registry.settle(&id, TaskState::Completed, None);
        let full = registry.snapshot(&id, None).unwrap();
        assert_eq!(full.history.len(), 2);
        let trimmed = registry.snapshot(&id, Some(1)).unwrap();
        assert_eq!(trimmed.history.len(), 1);
        assert_eq!(trimmed.history[0].role, Role::Agent);
        let none = registry.snapshot(&id, Some(0)).unwrap();
        assert!(none.history.is_empty());
    }

    /// Settle is idempotent: a second terminal frame never publishes.
    #[test]
    fn a_settled_task_stays_settled() {
        let (mut registry, id) = registry();
        let mut stream = registry.subscribe(&id).expect("subscribable");
        registry.settle(&id, TaskState::Completed, None);
        registry.settle(&id, TaskState::Failed, Some("late".into()));
        let frames: Vec<StreamResponse> = std::iter::from_fn(|| stream.try_recv().ok()).collect();
        assert_eq!(frames.len(), 1, "only the terminal frame: {frames:?}");
        let task = registry.snapshot(&id, None).unwrap();
        assert_eq!(task.status.state, TaskState::Completed);
    }

    /// The list page: newest first, cursor pagination, filters, and the
    /// always-present (possibly empty) next token (spec 3.1.4).
    #[test]
    fn list_pages_by_last_update_descending() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx-1".into(),
            "s-1".into(),
            None,
            vec![Part::text("one")],
        );
        registry.admit(
            "t-2".into(),
            "ctx-1".into(),
            "s-1".into(),
            None,
            vec![Part::text("two")],
        );
        registry.admit(
            "t-3".into(),
            "ctx-2".into(),
            "s-2".into(),
            None,
            vec![Part::text("three")],
        );
        // The newest-first order is the last-update clock: settle the
        // tasks in turns so their `updated_at` values differ.
        registry.settle("t-1", TaskState::Completed, None);
        registry.settle("t-2", TaskState::Completed, None);
        registry.settle("t-3", TaskState::Completed, None);

        let (page, next, size, total) = registry
            .list(None, None, None, false, None, Some(2), None)
            .expect("listed");
        assert_eq!(size, 2);
        assert_eq!(total, 3);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].id, "t-3");
        // The opaque token carries the boundary row (its updated_at and
        // id), never a bare row id the walk would re-find in a moved
        // table.
        let boundary =
            decode_page_token(registry.page_token_nonce, &next).expect("the next token decodes");
        assert_eq!(
            boundary.1, "t-2",
            "the token's boundary row is the page's last: {next}"
        );

        let (page, next, _, total) = registry
            .list(None, None, None, false, None, Some(2), Some(&next))
            .expect("listed");
        assert_eq!(total, 3);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, "t-1");
        assert_eq!(next, "", "the last page's token is the empty string");

        let (page, _, _, total) = registry
            .list(Some("ctx-1"), None, None, false, None, None, None)
            .expect("listed");
        assert_eq!(total, 2);
        assert!(page
            .iter()
            .all(|task| task.context_id.as_deref() == Some("ctx-1")));

        let (_, _, _, working) = registry
            .list(
                None,
                Some(TaskState::Working),
                None,
                false,
                None,
                None,
                None,
            )
            .expect("listed");
        assert_eq!(working, 0);
    }

    /// The page token carries the boundary ROW (its `updated_at` and
    /// id) and the walk resumes strictly after it: a cursor task that
    /// left
    /// the filter (a status walk whose cursor task settled) never
    /// restarts the walk at page one, and a cursor task that updated
    /// between pages (moved ahead of the boundary) never replays the
    /// rows the earlier pages served. A token this server did not mint
    /// answers `None` — the caller's invalid-params, never a silent
    /// restart.
    #[test]
    fn a_page_token_resumes_after_its_boundary_row() {
        let mut registry = TaskRegistry::new();
        for id in ["t-1", "t-2", "t-3"] {
            registry.admit(
                id.into(),
                "ctx-1".into(),
                "s-1".into(),
                None,
                vec![Part::text(id)],
            );
            registry.mark_working(id);
        }
        // The newest-first order is the last-update clock: assign the
        // updates directly (the walk's determinism, not the wall's).
        for (id, updated_at) in [("t-1", 3000u64), ("t-2", 2000), ("t-3", 1000)] {
            registry.tasks.get_mut(id).expect("admitted").updated_at = updated_at;
        }
        let (page, next, _, _) = registry
            .list(None, None, None, false, None, Some(2), None)
            .expect("listed");
        assert_eq!(
            page.iter().map(|task| task.id.as_str()).collect::<Vec<_>>(),
            ["t-1", "t-2"],
            "the first page serves the newest two rows"
        );

        let token = next;
        // The cursor task leaves the filter: it settles (the status
        // walk is over WORKING tasks now), and the SAME boundary token
        // still walks the filtered table.
        registry.settle("t-2", TaskState::Canceled, None);
        let (page, _, _, total) = registry
            .list(
                None,
                Some(TaskState::Working),
                None,
                false,
                None,
                Some(2),
                Some(&token),
            )
            .expect("listed");
        assert_eq!(total, 2, "the settled cursor task left the WORKING filter");
        assert_eq!(
            page.iter().map(|task| task.id.as_str()).collect::<Vec<_>>(),
            ["t-3"],
            "the filtered walk resumes strictly after the boundary row, never at page one: {page:?}"
        );

        // The cursor task updates between pages: an unfiltered walk
        // over the moved table never replays the rows ahead of the
        // boundary.
        registry
            .tasks
            .get_mut("t-2")
            .expect("settled but retained")
            .updated_at = 9000;
        let (page, _, _, _) = registry
            .list(None, None, None, false, None, Some(2), Some(&token))
            .expect("listed");
        assert_eq!(
            page.iter().map(|task| task.id.as_str()).collect::<Vec<_>>(),
            ["t-3"],
            "the moved cursor row and the rows ahead of the boundary never replay: {page:?}"
        );

        // A token this server did not mint answers None (the caller's
        // invalid-params), never a silent restart at page one.
        assert!(
            registry
                .list(None, None, None, false, None, Some(2), Some("t-2"))
                .is_none(),
            "a bare row id is not a page token"
        );
        assert!(
            registry
                .list(None, None, None, false, None, Some(2), Some("garbage"))
                .is_none(),
            "an undecodable token answers None"
        );
    }

    /// The page token is bound to the registry that minted it: the
    /// registry lives in memory, so every token a client holds is
    /// unminted after a restart — a well-formed boundary a fresh
    /// registry never issued answers `None` (the caller's
    /// invalid-params), never a silent restart of the walk at page one
    /// (a boundary newer than every row) or a silent early end (an
    /// older boundary's empty page).
    #[test]
    fn a_page_token_another_registry_run_minted_answers_none() {
        let mut registry = TaskRegistry::new();
        for (id, updated_at) in [("t-1", 3000u64), ("t-2", 2000), ("t-3", 1000)] {
            registry.admit(
                id.into(),
                "ctx-1".into(),
                "s-1".into(),
                None,
                vec![Part::text(id)],
            );
            registry.tasks.get_mut(id).expect("admitted").updated_at = updated_at;
        }
        // Well-formed boundaries a restart-era client could hold.
        assert!(
            registry
                .list(
                    None,
                    None,
                    None,
                    false,
                    None,
                    Some(2),
                    Some("99999999999:never-minted")
                )
                .is_none(),
            "a newer-than-every-row foreign token never restarts the walk at page one"
        );
        assert!(
            registry
                .list(
                    None,
                    None,
                    None,
                    false,
                    None,
                    Some(2),
                    Some("0:never-minted")
                )
                .is_none(),
            "an older foreign token never ends the walk as a silent empty page"
        );
        // A token a DIFFERENT registry run minted (the same boundary row
        // this registry could have served) is unminted here too.
        let other = TaskRegistry::new();
        let foreign = encode_page_token(other.page_token_nonce, 3000, "t-1");
        assert!(
            registry
                .list(None, None, None, false, None, Some(2), Some(&foreign))
                .is_none(),
            "another registry run's token is not this run's mint"
        );
        // This registry's own mint still walks.
        let (_, next, _, _) = registry
            .list(None, None, None, false, None, Some(2), None)
            .expect("listed");
        assert!(
            registry
                .list(None, None, None, false, None, Some(2), Some(&next))
                .is_some(),
            "the registry's own minted token decodes"
        );
    }

    /// A subscriber that stopped reading is DROPPED at its queue bound:
    /// the publish path never buffers a non-reading subscriber's frames
    /// without limit (the registry's retention ceilings bound the
    /// tasks, not a stalled reader's queue). The DROP is the pin: the
    /// dropped subscriber's receiver ends DISCONNECTED once its queue
    /// drains, and a publish after the drop never reaches it again —
    /// never a silently frame-skipping queue a caught-up reader could
    /// read missing `append: true` chunks from. The task stays
    /// queryable through `GetTask`.
    #[test]
    fn a_slow_reader_is_dropped_at_the_queue_bound() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "task".into(),
            "ctx".into(),
            "session".into(),
            None,
            vec![Part::text("prompt")],
        );
        let (_, mut slow) = registry
            .subscribe_with_snapshot("task", None)
            .expect("subscribable");
        for _ in 0..(SUBSCRIBER_QUEUE_FRAMES * 8) {
            registry.append_artifact_chunk("task", "x");
        }
        // The overflow dropped the subscriber: the queue drains and the
        // receiver ends DISCONNECTED — one more publish before any
        // settle never reaches it (a keep-the-full-queue mutant would
        // deliver the new frame instead).
        while slow.try_recv().is_ok() {}
        registry.append_artifact_chunk("task", "after");
        assert!(
            matches!(
                slow.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
            ),
            "the dropped subscriber's stream is disconnected, never a frame-skipping queue"
        );
        registry.settle("task", TaskState::Completed, None);
        assert!(
            registry.snapshot("task", None).is_some(),
            "the dropped subscriber's task stays queryable"
        );
    }

    /// The retention window (see [`MAX_RETAINED_TERMINAL_TASKS`]): the
    /// newest terminal tasks stay readable through `GetTask`/`ListTasks`
    /// and the oldest beyond the window leave the registry at the settle
    /// that pushes it past its bound — the registry's memory ceiling.
    #[test]
    fn terminal_retirement_keeps_the_bound() {
        let mut registry = TaskRegistry::new();
        let settled: Vec<String> = (0..=MAX_RETAINED_TERMINAL_TASKS)
            .map(|index| format!("t-{index}"))
            .collect();
        for id in &settled {
            registry.admit(
                id.clone(),
                "ctx-1".into(),
                "s-1".into(),
                None,
                vec![Part::text("retention probe")],
            );
        }
        for id in &settled {
            registry.settle(id, TaskState::Completed, None);
        }
        // The just-settled task stays readable; the first settle's task
        // left the registry (the window is the newest
        // MAX_RETAINED_TERMINAL_TASKS terminal tasks).
        assert_eq!(
            registry.tasks.len(),
            MAX_RETAINED_TERMINAL_TASKS,
            "the terminal window keeps its bound"
        );
        assert!(
            registry
                .tasks
                .contains_key(settled.last().expect("the newest")),
            "the just-settled task stays readable"
        );
        assert!(
            !registry.tasks.contains_key(&settled[0]),
            "the oldest terminal task beyond the window left"
        );
        assert!(
            registry.snapshot(&settled[0], None).is_none(),
            "GetTask no longer serves the retired task"
        );
        assert!(
            registry
                .snapshot(settled.last().expect("the newest"), None)
                .is_some(),
            "GetTask serves the retained window's newest"
        );
        // A live task never leaves: the window holds only terminal rows.
        registry.admit(
            "t-live".into(),
            "ctx-1".into(),
            "s-1".into(),
            None,
            vec![Part::text("live")],
        );
        assert!(
            registry.tasks.contains_key("t-live"),
            "the live task stays registered"
        );
    }

    /// The list projection obeys the v1 request contract: rows omit
    /// artifacts unless `includeArtifacts` asks for them, while
    /// `GetTask` always carries the artifact; `statusTimestampAfter` is
    /// the inclusive floor (spec 3.1.4).
    #[test]
    fn list_applies_the_timestamp_floor_and_artifact_projection() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx-1".into(),
            "s-1".into(),
            None,
            vec![Part::text("one")],
        );
        registry.mark_working("t-1");
        registry.append_artifact_chunk("t-1", "first reply");
        registry.settle("t-1", TaskState::Completed, None);
        let t1 = registry.task("t-1").unwrap().updated_at;
        // A strictly-later first update for the second task (the 2 ms
        // park crosses the millisecond clock that orders the rows).
        std::thread::sleep(std::time::Duration::from_millis(2));
        registry.admit(
            "t-2".into(),
            "ctx-1".into(),
            "s-1".into(),
            None,
            vec![Part::text("two")],
        );
        registry.mark_working("t-2");
        registry.append_artifact_chunk("t-2", "second reply");
        registry.settle("t-2", TaskState::Completed, None);
        let t2 = registry.task("t-2").unwrap().updated_at;

        // The artifacts-omitted default (spec: "Defaults to false to
        // reduce payload size"), against an always-present GetTask.
        let (page, _, _, total) = registry
            .list(None, None, None, false, None, None, None)
            .expect("listed");
        assert_eq!(total, 2);
        assert!(page.iter().all(|task| task.artifacts.is_empty()));
        let (page, _, _, _) = registry
            .list(None, None, None, true, None, None, None)
            .expect("listed");
        assert!(page.iter().all(|task| !task.artifacts.is_empty()));
        let get = registry
            .snapshot("t-1", None)
            .expect("GetTask keeps artifacts");
        assert_eq!(
            get.artifacts[0].parts[0].text.as_deref(),
            Some("first reply")
        );

        // The timestamp floor is inclusive: t2's own instant returns
        // t2 (and anything updated at the same millisecond); t1's
        // instant returns both; the future returns nothing. The floor
        // compares at nanosecond scale (the RFC 3339 filter's instant).
        let (_, _, _, at_t2) = registry
            .list(
                None,
                None,
                Some(i128::from(t2) * 1_000_000),
                false,
                None,
                None,
                None,
            )
            .expect("listed");
        assert_eq!(at_t2, 1);
        let (_, _, _, both) = registry
            .list(
                None,
                None,
                Some(i128::from(t1) * 1_000_000),
                false,
                None,
                None,
                None,
            )
            .expect("listed");
        assert_eq!(both, 2);
        let (_, _, _, none) = registry
            .list(
                None,
                None,
                Some(i128::from(t2 + 1) * 1_000_000),
                false,
                None,
                None,
                None,
            )
            .expect("listed");
        assert_eq!(none, 0);
    }

    /// A terminal task subscribes to nothing (spec 3.1.6/3.5.2): a
    /// subscribe that follows an awaited step — a cancel's sweep —
    /// can never park a receiver no later event will close; a live
    /// task still streams.
    #[test]
    fn a_terminal_task_subscribes_to_nothing() {
        let (mut registry, id) = registry();
        assert!(registry.subscribe(&id).is_some(), "a live task streams");
        registry.settle(&id, TaskState::Completed, None);
        assert!(
            registry.subscribe(&id).is_none(),
            "a terminal task parks no stream"
        );
    }

    /// The write claim (`mark_prompt_writing`): a `Waiting` task claims
    /// its prompt write exactly once — the second claim and a claim on
    /// a settled task answer `false`, so a cancel that settles the task
    /// during the handoff leaves nothing to write.
    #[test]
    fn the_prompt_write_claim_is_taken_exactly_once() {
        let (mut registry, id) = registry();
        assert!(registry.mark_prompt_writing(&id), "the first claim wins");
        assert!(
            !registry.mark_prompt_writing(&id),
            "the write claim is not re-takeable"
        );
        registry.settle(&id, TaskState::Canceled, None);
        assert!(
            !registry.mark_prompt_writing(&id),
            "a settled task writes nothing"
        );
    }

    /// The undispatched cancel (`settle_undispatched`): a `Waiting`
    /// task — its flow still parked at the queue head or the idle wait —
    /// settles CANCELED directly (no daemon work exists to withdraw); a
    /// task whose prompt is written or being written hands off to the
    /// daemon's cancel ladder; a terminal task is not cancelable; an
    /// unknown id is not found.
    #[test]
    fn the_undispatched_cancel_settles_only_waiting_tasks() {
        let (mut registry, id) = registry();
        assert_eq!(
            registry.settle_undispatched("nope"),
            UndispatchedCancel::Unknown
        );

        // The write claim hands the task to the daemon's ladder.
        registry.mark_prompt_writing(&id);
        assert_eq!(
            registry.settle_undispatched(&id),
            UndispatchedCancel::HandedOff
        );
        registry.mark_prompt_dispatched(&id, None);
        assert_eq!(
            registry.settle_undispatched(&id),
            UndispatchedCancel::HandedOff
        );

        // A waiting task settles CANCELED directly: the queued sibling
        // behind it is untouched.
        registry.admit(
            "t-2".into(),
            "ctx-1".into(),
            "s-1".into(),
            None,
            vec![Part::text("second")],
        );
        assert_eq!(
            registry.settle_undispatched("t-2"),
            UndispatchedCancel::Settled
        );
        let canceled = registry.snapshot("t-2", None).unwrap();
        assert_eq!(canceled.status.state, TaskState::Canceled);
        assert!(
            registry.head("ctx-1").is_some_and(|task| task.id == id),
            "the settled sibling left the head to its predecessor"
        );

        // A waiting task that already settled (its own undispatched
        // cancel) answers the terminal refusal on the second cancel.
        assert_eq!(
            registry.settle_undispatched("t-2"),
            UndispatchedCancel::Terminal
        );
    }

    /// A settled task's verdict answers a late streaming subscriber
    /// with a finite terminal stream (the SSE-shape contract: a
    /// successful streaming method stays SSE whatever the scheduling —
    /// the subscriber's first frame is the task's terminal status)
    /// built from the task's own snapshot: the registry row's while
    /// the window keeps it, a reply claim's captured verdict once it
    /// advanced past it.
    #[test]
    fn a_terminal_verdict_answers_a_finite_terminal_stream() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx-1".into(),
            "s-1".into(),
            None,
            vec![Part::text("one")],
        );
        registry.settle("t-1", TaskState::Completed, None);
        let snapshot = registry
            .snapshot("t-1", None)
            .expect("the settled task answers its snapshot");
        let mut stream = TaskRegistry::terminal_stream_for_status(
            &snapshot.id,
            snapshot.context_id.as_deref().unwrap_or_default(),
            snapshot.status.clone(),
        );
        let frame = stream.try_recv().expect("the terminal frame");
        match frame {
            StreamResponse::StatusUpdate(event) => {
                assert_eq!(event.status.state, TaskState::Completed);
                assert_eq!(event.task_id, "t-1");
            }
            other => panic!("the terminal stream carries the status update: {other:?}"),
        }
        assert!(
            stream.try_recv().is_err(),
            "the terminal stream closes after its frame"
        );
    }

    /// A silent WORKING task between publishes prunes its
    /// disconnected subscribers at the registration site, so repeated
    /// subscribe/disconnect pairs stay bounded by live readers — a
    /// task paused in a quiet tool call retains no closed sink (a
    /// publish-only prune would keep every one of them until the
    /// next frame).
    #[test]
    fn a_silent_tasks_registration_prunes_disconnected_subscribers() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "working".into(),
            "context".into(),
            "session".into(),
            None,
            vec![Part::text("silent long-running tool")],
        );
        registry.mark_prompt_dispatched("working", Some(1));
        // BOTH registration paths prune, each in isolation: the
        // snapshot-carrying subscribe of the SSE acks and the plain
        // subscribe of the internal waits (the cancel's — a client
        // that disconnects mid-wait drops its
        // receiver, and repeated abandoned waits on a silent task
        // must not grow the sink list until the next publish). One
        // path's registration site must not be the other path's
        // prune: the paths run one after the other, so a revert of
        // either site's prune fails its own loop's assertion.
        for (path, plain) in [("plain", true), ("snapshot", false)] {
            for _ in 0..8192 {
                let receiver = if plain {
                    registry
                        .subscribe("working")
                        .expect("the live task subscribes")
                } else {
                    registry
                        .subscribe_with_snapshot("working", None)
                        .expect("the live task subscribes")
                        .1
                };
                drop(receiver);
            }
            let entry = registry.task("working").expect("the task stays live");
            assert!(
                entry.streams.len() <= 1,
                "a silent live task's {path} registration retains disconnected subscribers: {} registered",
                entry.streams.len()
            );
        }
    }

    /// The window is exactly its bound, and a reply's claimed verdict
    /// survives the window's advance: the settle captured the task's
    /// final snapshot into the claim under the same lock that pruned
    /// the row, so a reply read after [`MAX_RETAINED_TERMINAL_TASKS`]
    /// newer settles still answers the task's own verdict — the
    /// newest rows stay readable through `GetTask` while the reply
    /// keeps the truth of the row the window took.
    #[test]
    fn a_claimed_verdict_survives_the_retention_window() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "victim".into(),
            "ctx-1".into(),
            "s-1".into(),
            None,
            vec![Part::text("v")],
        );
        let claim = registry
            .claim_verdict("victim", None)
            .expect("the live task takes the claim");
        registry.set_artifact_text("victim", "OWN-ANSWER");
        registry.settle("victim", TaskState::Canceled, None);
        for index in 0..MAX_RETAINED_TERMINAL_TASKS {
            let id = format!("newer-{index}");
            registry.admit(
                id.clone(),
                "ctx-1".into(),
                "s-1".into(),
                None,
                vec![Part::text("n")],
            );
            registry.settle(&id, TaskState::Completed, None);
        }
        assert!(
            registry.task("victim").is_none(),
            "the window advanced past the victim: no held rows exist"
        );
        let captured = claim.captured().expect("the settle captured the verdict");
        assert_eq!(captured.status.state, TaskState::Canceled);
        assert_eq!(
            captured.artifacts[0].parts[0]
                .text
                .clone()
                .unwrap_or_default(),
            "OWN-ANSWER",
            "the claim carries the task's own artifact: {captured:?}"
        );
        // A claim registered on an already-settled task captures the
        // standing verdict at its registration.
        let late = registry
            .claim_verdict(&format!("newer-{}", MAX_RETAINED_TERMINAL_TASKS - 1), None)
            .expect("the retained row takes the claim");
        assert_eq!(
            late.captured().expect("the standing verdict").status.state,
            TaskState::Completed
        );
    }

    /// A live task retains only the verdict claims whose readers still
    /// exist: the registration is non-owning (each reader owns its
    /// slot through its own `VerdictClaim`), so a reader that already
    /// answered or disconnected — its claim dropped, the slot died
    /// with it — prunes at the next registration. 8192 register-and-
    /// drop pairs leave no live reader's slot for a settle to
    /// snapshot, never 8192 retained claims the settle would build a
    /// full task snapshot for one by one.
    #[test]
    fn a_live_task_keeps_only_live_readers_verdict_claims() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "working".into(),
            "ctx".into(),
            "session".into(),
            None,
            vec![Part::text("silent task")],
        );
        registry.mark_prompt_dispatched("working", None);
        for _ in 0..8192 {
            drop(
                registry
                    .claim_verdict("working", None)
                    .expect("the live task claims"),
            );
        }
        let entry = registry.task("working").expect("the task stays live");
        let live = entry
            .verdict_claims
            .iter()
            .filter(|claim| claim.slot.upgrade().is_some())
            .count();
        assert_eq!(
            live,
            0,
            "no reader holds a claim on the silent task: {:?}",
            entry.verdict_claims.len()
        );
        assert!(
            entry.verdict_claims.len() <= 1,
            "the dead readers' registrations pruned at each claim: {}",
            entry.verdict_claims.len()
        );
    }

    /// The accepted abort settles the task the moment its `owned`
    /// receipt lands, whatever other cancel authorities are still in
    /// flight: a second ladder pending cannot hold the stop at WORKING
    /// (the settle's own close zeroes the pending counts, so the other
    /// ladder's late resolution answers a terminal task and publishes
    /// nothing — the refusal paths keep their count-based barrier for
    /// the no-stop case). The completion barrier the run-on children
    /// hold waits for nothing either: the CANCELED verdict is the stop
    /// the client asked for.
    #[test]
    fn an_owned_abort_settles_while_another_ladder_stays_in_flight() {
        let (mut registry, id) = registry();
        registry.mark_prompt_writing(&id);
        registry.mark_prompt_dispatched(&id, None);
        registry.mark_ladder_inflight(&id);
        registry.mark_ladder_inflight(&id);
        registry.resolve_ladder_owned(&id);
        assert_eq!(
            registry.task(&id).expect("the task keeps its row").state(),
            TaskState::Canceled,
            "the accepted abort settles at once, never held behind the other ladder's pending authority"
        );
        registry.mark_awaiting_completion(&id);
        registry.resolve_ladder_refused(&id);
        assert_eq!(
            registry.task(&id).expect("the task keeps its row").state(),
            TaskState::Canceled,
            "the overlapping refusal lands on the terminal task and publishes nothing"
        );
    }

    /// The accepted abort settles through a pending withdrawal too: an
    /// overlapping cancel's withdrawal still in flight — its own
    /// receipt refusing later — can neither delay the stop nor strand
    /// it unpublished when no verdict parked (the receipt then answers
    /// a terminal task).
    #[test]
    fn an_owned_abort_settles_through_a_pending_withdrawal() {
        let (mut registry, id) = registry();
        registry.mark_prompt_writing(&id);
        registry.mark_prompt_dispatched(&id, None);
        registry.mark_ladder_inflight(&id);
        registry.mark_withdraw_inflight(&id);
        registry.resolve_ladder_owned(&id);
        assert_eq!(
            registry.task(&id).expect("the task keeps its row").state(),
            TaskState::Canceled,
            "the accepted abort settles at once through the pending withdrawal"
        );
        registry.close_withdraw_inflight(&id, false);
        assert_eq!(
            registry.task(&id).expect("the task keeps its row").state(),
            TaskState::Canceled,
            "the refused withdrawal receipt publishes nothing on the terminal task"
        );
    }
}
