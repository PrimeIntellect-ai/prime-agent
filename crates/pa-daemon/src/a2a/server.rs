//! The A2A mode server: the protocol flows over the daemon-attached
//! transport. Every A2A conversation `contextId` hosts one daemon
//! session (created and attached like the ACP mode's startup session);
//! every protocol task maps onto one prompt turn — `PromptAndWait` with
//! the task's delivery identity (a server-minted admission id, unique
//! per task and never the public task id), so the daemon's native
//! admission cancel serves `CancelTask` for queued and running turns
//! alike (spec 3.1.5), and the turn's assistant text becomes the task's
//! artifact, streamed as SSE `artifactUpdate` chunks (spec 3.1.2).
//!
//! The settle rides the pump's frame-ordered steps: a tagged
//! `PromptAndWait` response settles its queue head as the pump's
//! synchronous step (the later frames route behind it), and a task
//! waiting out an autonomous continuation settles after the run's own
//! frames (see `events.rs`). The worker flushes its session events
//! before the response leaves its socket, so the accumulated artifact
//! text is complete when the settle publishes the terminal status.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pa_types::daemon::{
    DaemonCommand, DaemonErrorInfo, DaemonResponse, DaemonSessionLifecycle, PromptInput,
    StreamingBehavior,
};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc::Receiver as StreamReceiver;
use tokio::sync::{oneshot, Mutex};

use crate::mode_link::DaemonLink;
use crate::worker::{
    PROMPT_ABORTED_BEFORE_DELIVERY, PROMPT_ADMISSION_CANCELLED, PROMPT_CANCELLED_BEFORE_START,
    QUEUED_PROMPT_CLEARED, QUEUED_PROMPT_DELETED,
};

use pa_telemetry::TelemetryClient;

use super::card::{self, CardOptions};
use super::events::on_session_event;
use super::jsonrpc::{self, A2aError};
use super::task::{TaskEntry, TaskRegistry};
use super::types::{
    CancelTaskParams, GetTaskParams, ListTasksParams, ListTasksResponse, Part, SendMessageRequest,
    StreamResponse, TaskState,
};

/// The launch options of the A2A mode (mirrors the ACP mode's
/// `DaemonAcpOptions`).
#[derive(Clone)]
pub struct A2aOptions {
    pub socket_path: PathBuf,
    pub bind_host: String,
    pub bind_port: u16,
    /// The required bearer token (configured, or minted per run when
    /// none is): every task route demands it — the daemon's control
    /// socket is owner-only and the TCP listener must not be the
    /// weaker surface — while the well-known Agent Card route stays
    /// public (spec 14.3).
    pub bearer_token: String,
    /// The minted token's agent dir (set only when the token was
    /// minted): the file itself is named per bound port and written
    /// owner-only once the listener binds — never before, and never
    /// under a second server's name, so a failed or parallel start
    /// cannot overwrite the running server's token file — and its
    /// path printed for the operator.
    pub minted_token_dir: Option<PathBuf>,
    /// The configured public base URL (`a2a.publicBaseUrl`): the card's
    /// interface URL and the accepted `Host` authority behind a
    /// TLS-terminating front; unset serves the bound endpoint.
    pub public_base_url: Option<String>,
    /// The live-context bound (`a2a.maxContexts`, default 64): beyond
    /// it the least recently used idle context's worker stops.
    pub max_contexts: Option<usize>,
    pub card_name: String,
    pub card_description: String,
    pub product_version: String,
    /// The daemon session create for new contexts (the CLI flags'
    /// session config).
    pub create: DaemonCommand,
    /// The adoption-telemetry client (unset when disabled): the served
    /// request events are fire-and-forget from the request path.
    pub telemetry: Option<TelemetryClient>,
}

/// The default live-context bound (the `a2a.maxContexts` setting
/// overrides it): the server keeps at most this many conversation
/// contexts — the bound that keeps its worker count a function of the
/// conversation table, never the request rate.
pub const DEFAULT_MAX_LIVE_CONTEXTS: usize = 64;

/// The parked-queue recheck cadence for the waits that must observe a
/// quiet session: a foreign abort that lands MID-WAIT re-parks the
/// queue behind a fresh suspension and the daemon's idle wait never
/// answers a suspended non-empty lane, so each wait re-issues its
/// detached resume on this cadence — the wedge unwedges at the next
/// tick, never at the abort's mercy.
const PARKED_QUEUE_RECHECK: std::time::Duration = std::time::Duration::from_millis(500);

/// The exit's telemetry drain bound (the same shared 500 ms the
/// interactive modes join their exit flushes under, kept beside this
/// mode's exit because the crate boundary keeps the constant from a
/// single home): the adoption events a short run queued reach the
/// mirror within it, or drop — the exit never hangs on delivery.
const TELEMETRY_EXIT_TIMEOUT_MS: u64 = 500;

/// One context's session binding.
#[derive(Debug, Clone)]
pub(crate) struct ContextSession {
    /// The worker's current active session id (the command selector).
    pub active_id: String,
    /// The durable selector (the session-file stem): it survives the
    /// worker's idle passivation — a re-attach addresses it and the
    /// answered active id re-keys the binding (a re-hosted session
    /// answers its fresh worker's id, and the event routing keys on
    /// it). The live-context bound's eviction ends the conversation
    /// instead: it removes the context's binding outright, so a send
    /// naming the evicted context answers the documented
    /// unknown-contextId error.
    pub durable_id: String,
    /// The conversation's session file: the re-open's address. A
    /// client-owned context (`--no-session`) carries none — its worker
    /// never passivates, so its re-attach rides the durable id alone.
    pub session_file: Option<String>,
}

/// One context's in-flight attach round (see [`ensure_attached`]):
/// the verdict cell the round's owner fills before releasing — a
/// concurrent caller waits the round out and joins the same answer.
type AttachRound = Arc<tokio::sync::Mutex<Option<Result<(), String>>>>;

/// The mutable server state: the task registry and the context/session
/// bindings.
pub struct A2aState {
    pub registry: TaskRegistry,
    /// Daemon session id -> A2A context id (the events' routing key).
    pub sessions: BTreeMap<String, String>,
    /// A2A context id -> the context's session binding.
    pub contexts: BTreeMap<String, ContextSession>,
    /// The per-session turn-window table (the artifact attribution).
    pub windows: super::events::TurnWindows,
    /// The per-session run accumulators (the autonomous continuation
    /// attribution, see `events.rs`).
    pub runs: super::events::RunAccumulators,
    /// The per-context create template (the name is set per context).
    pub create: DaemonCommand,
    /// Whether context sessions are client-owned (`--no-session`).
    pub client_owned: bool,
    /// The live-context bound (`a2a.maxContexts`, the default 64).
    max_contexts: usize,
    /// The contexts whose session the A2A client is currently attached
    /// to: a context detaches once its task queue drains (the daemon's
    /// idle passivation can reclaim its worker) and the next send
    /// re-attaches.
    attached: BTreeSet<String>,
    /// In-flight session detaches a re-attach must wait out: the daemon
    /// sees Detach before the next Attach, never the reverse (a
    /// reversed pair would drop the fresh attachment).
    detaching: BTreeMap<String, oneshot::Receiver<()>>,
    /// The in-flight attach rounds (see [`ensure_attached`]): the first
    /// caller for a detached context owns its round and publishes the
    /// `attached` mark only on success; a concurrent caller joins the
    /// round's recorded verdict instead of treating the in-flight
    /// attach as already standing (the daemon subscribes this client
    /// only once the attach answers, so a successor that wrote its
    /// prompt first would run on a worker its frames never reach).
    attaching: BTreeMap<String, AttachRound>,
    /// The last-use clock of every live context (the eviction order).
    context_use: BTreeMap<String, u64>,
    /// The in-flight context creations (the live-context bound's
    /// reservation: each holds one slot from the guard-checked reserve
    /// to its atomic insertion, so concurrent new conversations cannot
    /// all observe the same free slot and overshoot the bound).
    creating: usize,
    /// The contexts a live-context reclamation is closing right now
    /// (the stop's reservation): a send never admits a task against
    /// them — it waits the reclamation's own lock out and re-validates
    /// (the binding survived the refused stop, or the conversation
    /// ended with the eviction).
    closing: BTreeMap<String, Arc<tokio::sync::Mutex<()>>>,
    /// The sessions with one outstanding detached `ResumeQueue` (see
    /// [`resume_parked_queue_detached`]): the wait cadences re-issue
    /// behind the marker, never one command line per tick against a
    /// writer the peer stopped draining.
    resume_in_flight: BTreeSet<String>,
    /// The per-session pre-write idle barriers (see [`IdleBarrier`]):
    /// one coalesced `WaitForIdle` exchange per session, so canceled
    /// pre-write waits never stack dead pending requests.
    idle_barriers: BTreeMap<String, Arc<IdleBarrier>>,
    /// The mode's exit began (the teardown's settlement pass): no task
    /// admits after it — the send flow's admission observes the flag
    /// under the same guard that would admit it, so the exit's
    /// settlement snapshot is final (no task it never saw can run on
    /// with no client and no withdrawal naming it).
    shutting_down: bool,
}

/// One session's shared pre-write idle barrier (the coalesced
/// `WaitForIdle` exchange): the first flow that needs the session
/// quiet issues the single exchange and registers it under the
/// session id; every later flow waits the same answer instead of
/// issuing its own request. A detached owner task holds the exchange
/// until the daemon answers it (or the link closes) — a canceled
/// waiter leaves nothing behind: the exchange lives on, the next queue
/// head waits on it, and repeated send/cancel pairs against a foreign
/// turn that never ends cost ONE pending request per session, never
/// one dead pending slot per abandoned send.
pub(crate) struct IdleBarrier {
    /// The shared exchange's answer: `None` while in flight, then
    /// `Ok(())` (the daemon answered the session idle) or the failure
    /// text (a refused response, a transport error). Every waiter
    /// reads the same value.
    answer: tokio::sync::watch::Sender<Option<Result<(), String>>>,
}

impl IdleBarrier {
    fn new() -> Self {
        Self {
            answer: tokio::sync::watch::Sender::new(None),
        }
    }

    /// The exchange's wait handle: one answer subscription per waiter.
    fn subscribe(&self) -> tokio::sync::watch::Receiver<Option<Result<(), String>>> {
        self.answer.subscribe()
    }
}

/// The session's idle barrier: the registered one, or a fresh exchange
/// a detached owner task holds until the daemon answers it. The
/// registration and the issue are one state-lock step, so at most one
/// exchange per session is ever in flight.
async fn idle_barrier(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    session_id: &str,
) -> Arc<IdleBarrier> {
    let mut guard = state.lock().await;
    if let Some(barrier) = guard.idle_barriers.get(session_id) {
        return Arc::clone(barrier);
    }
    let barrier = Arc::new(IdleBarrier::new());
    guard
        .idle_barriers
        .insert(session_id.to_string(), Arc::clone(&barrier));
    drop(guard);
    let link = Arc::clone(link);
    let state = Arc::clone(state);
    let session_id = session_id.to_string();
    let owner = Arc::clone(&barrier);
    tokio::spawn(async move {
        let answer = match link.send_until_close(DaemonCommand::WaitForIdle {
            id: None,
            active_session_id: session_id.clone(),
            wait_for_rlm_quiescence: None,
            rest: Map::default(),
        }) {
            Ok(pending) => match pending.wait(&link).await {
                Ok(response) if response.success => Ok(()),
                Ok(response) => Err(response
                    .error
                    .unwrap_or_else(|| "the idle wait failed".to_string())),
                Err(error) => Err(error.to_string()),
            },
            Err(error) => Err(error.to_string()),
        };
        // The unregistration precedes the publish: a flow that starts
        // after the answer issues its own fresh exchange (the answered
        // barrier's idle instant is stale for it), while the flows
        // already waiting on this barrier read the answer.
        let mut guard = state.lock().await;
        if guard
            .idle_barriers
            .get(&session_id)
            .is_some_and(|held| Arc::ptr_eq(held, &owner))
        {
            guard.idle_barriers.remove(&session_id);
        }
        drop(guard);
        // `send_replace` keeps the answer for a subscriber that arrives
        // after it (a plain `send` drops the value while no receiver
        // exists — the flow that registered this barrier would then wait
        // a live sender's `None` forever, hung on an exchange the daemon
        // already answered).
        owner.answer.send_replace(Some(answer));
    });
    barrier
}

impl A2aState {
    /// Record one use of a context (its place in the eviction order).
    fn touch_context(&mut self, context_id: &str) {
        self.context_use
            .insert(context_id.to_string(), crate::util::now_ms());
    }
}

/// One served A2A request: the full-response or SSE-streaming verdict of
/// the dispatch.
pub(crate) enum Dispatch {
    Reply(Value),
    /// An SSE stream (spec 3.1.2/3.1.6): the request id (every frame
    /// is its JSON-RPC envelope), the first frame — the task's current
    /// snapshot — and the live ordered frames until the task's terminal
    /// one closes the stream.
    Stream(Value, Value, StreamReceiver<StreamResponse>),
}

/// One send flow's acknowledgement to the HTTP handler: the live task
/// (the flow still running; the handler subscribes its stream) with
/// the reply's claimed verdict — the handler's reply-time read falls
/// back to it once the retention window advanced past the task — or
/// the final reply.
enum SendFlowOutcome {
    Admitted {
        task_id: String,
        claim: super::task::VerdictClaim,
    },
    Settled(Value),
}

/// The A2A JSON-RPC surface entry: serve the mode until shutdown.
///
/// # Errors
///
/// Returns an error before any HTTP request is served when the daemon
/// socket connect or the listener bind fails.
///
/// # Panics
///
/// Panics when the HTTP accept loop task fails before shutdown (a
/// spawned-task join error: the listener's own failures are the
/// `Errors` case above).
pub async fn run_daemon_attached_a2a_mode(options: A2aOptions) -> anyhow::Result<i32> {
    let client_owned = matches!(
        &options.create,
        DaemonCommand::Create {
            lifecycle: Some(DaemonSessionLifecycle::ClientOwned),
            ..
        }
    );
    let link = Arc::new(DaemonLink::connect(&options.socket_path, "a2a").await?);
    let state = Arc::new(Mutex::new(A2aState {
        registry: TaskRegistry::new(),
        sessions: BTreeMap::new(),
        contexts: BTreeMap::new(),
        windows: super::events::TurnWindows::default(),
        runs: super::events::RunAccumulators::default(),
        create: options.create.clone(),
        client_owned,
        max_contexts: options
            .max_contexts
            .unwrap_or(DEFAULT_MAX_LIVE_CONTEXTS)
            .max(1),
        attached: BTreeSet::new(),
        detaching: BTreeMap::new(),
        attaching: BTreeMap::new(),
        context_use: BTreeMap::new(),
        creating: 0,
        closing: BTreeMap::new(),
        resume_in_flight: BTreeSet::new(),
        idle_barriers: BTreeMap::new(),
        shutting_down: false,
    }));

    // The mode's graceful SIGTERM watch (the signal a supervisor's
    // plain `kill` sends), installed at the entry so every startup
    // line the mode later prints — the listener's readiness line
    // among them — proves the graceful exit is armed: a `kill` that
    // lands after readiness never races an uninstalled handler into
    // the default hard death. The Windows process model carries no
    // portable terminate signal for a single-child mode, so the watch
    // there never fires and the mode's other exits own it.
    #[cfg(unix)]
    let mut sigterm = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        Ok(stream) => Some(stream),
        Err(error) => {
            eprintln!("a2a: SIGTERM handler unavailable ({error}); relying on the other exits");
            None
        }
    };
    #[cfg(not(unix))]
    let mut sigterm = ();
    // The interrupt watch (a terminal Ctrl-C) arms at the entry for
    // the same reason: the exit select's `ctrl_c` arm registers its
    // handler only at the select's first poll, and a Ctrl-C landing
    // between the minted token file's write and that poll would take
    // the default hard death — leaving the very file behind whose
    // removal the mode claims at every graceful exit. The non-unix
    // process model keeps the select's portable arm below instead
    // (the watch never fires there).
    #[cfg(unix)]
    let mut sigint = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
    {
        Ok(stream) => Some(stream),
        Err(error) => {
            eprintln!("a2a: SIGINT handler unavailable ({error}); relying on the other exits");
            None
        }
    };
    #[cfg(not(unix))]
    let mut sigint = ();

    // The session-event pump: one consumer owns the frame ordering
    // (responses matched by id, events routed by session, and a task's
    // prompt response settling its queue head before later frames
    // route). The pump's end records the close and signals the mode.
    {
        let link = Arc::clone(&link);
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            while receive_link_frame(&link, &state).await {}
            link.closed.store(true, std::sync::atomic::Ordering::SeqCst);
            link.pending.lock().unwrap().clear();
            link.tags.lock().unwrap().clear();
            link.closed_signal.notify_one();
        });
    }

    // The bind precedes the card: the advertised interface URL is the
    // configured public base URL when one exists (the front's address,
    // spec 8.3.1's accurate interface URL), else the bound endpoint (a
    // port-0 bind advertises its ephemeral port; an IPv6 bind brackets —
    // `SocketAddr`'s Display — so the URL stays parseable).
    let listener =
        tokio::net::TcpListener::bind((options.bind_host.as_str(), options.bind_port)).await?;
    let bound = listener.local_addr()?;
    // The minted token file writes only now — the listener is bound, so
    // THIS run owns its address and a failed earlier start never
    // overwrote a running server's token (a second bind on the same
    // address failed before this line). The file is named for the
    // BOUND ADDRESS (the IP in filename-safe form — an IPv6 literal's
    // colons are invalid in a Windows file name), never a per-run id:
    // the bind is exclusive, so the name is one address's one file —
    // a later run on the same address replaces only a DEAD run's
    // token (two listeners sharing one port on different addresses
    // still write one file each; a port-0 run never collides with a
    // fixed-port run's file). The file leaves at the mode's own exits
    // (the server task's end, ctrl_c, SIGTERM, and the link closing):
    // the live set is bounded by the concurrent binds, never one
    // owner-only secret file per run — a hard kill (SIGKILL) can
    // still orphan the one file it never got to remove.
    // The file is created owner-only through the open itself (never a
    // world-readable window a local account could read through a
    // descriptor it opened in the gap), and a write failure exits: a
    // token nobody can read would serve every task route a 401 with
    // nothing explaining it.
    let minted_token_path = options.minted_token_dir.as_ref().map(|dir| {
        let bound_address = bound.ip().to_string().replace([':', '.'], "-");
        dir.join(format!(
            "{A2A_TOKEN_FILE_PREFIX}-{}-{bound_address}",
            bound.port(),
        ))
    });
    if let Some(path) = &minted_token_path {
        write_minted_token_file(path, &options.bearer_token)?;
        eprintln!(
            "a2a: no bearer token configured; minted one for this run and wrote it to {} (present it as \"Authorization: Bearer <token>\")",
            path.display()
        );
    }
    let card_options = CardOptions {
        name: options.card_name.clone(),
        description: options.card_description.clone(),
        product_version: options.product_version.clone(),
        interface_url: options
            .public_base_url
            .clone()
            .unwrap_or_else(|| format!("http://{bound}/")),
    };
    let public_authority = options
        .public_base_url
        .as_deref()
        .and_then(super::http::PublicAuthority::parse);
    // The one startup line a harness or user can wait on (the ACP
    // mode's stderr-disclosure pattern).
    eprintln!("a2a: listening on http://{bound}");

    // The exit's drain handle: the serve task below consumes the
    // client (one clone shares its worker), so the exit keeps its own.
    let exit_flush = options.telemetry.clone();
    let mut server = tokio::spawn(super::http::serve(
        listener,
        Arc::clone(&state),
        Arc::clone(&link),
        card_options,
        options.bearer_token.clone(),
        public_authority,
        options.telemetry,
    ));
    // (the token rides as the required credential it is — see
    // `A2aOptions::bearer_token`)
    let mut link_closed = std::pin::pin!(link.closed_signal.notified());
    // The graceful exits the mode owns: ctrl_c (SIGINT) and SIGTERM
    // (the watch installed at the entry, without which the mode would
    // die mid-run and its minted token file would outlive it). The
    // select's every arm funnels into the ONE exit below, where the
    // owned sessions stop and the minted token file leaves with the
    // mode.
    let exit: anyhow::Result<()> = tokio::select! {
        result = &mut server => result.expect("the accept loop runs until shutdown"),
        () = wait_sigint(&mut sigint) => {
            // The accept loop stops with the mode: dropping its handle
            // only detaches the task (a live listener would keep
            // admitting tasks against the exit's settlement below).
            server.abort();
            Ok(())
        }
        () = &mut link_closed => {
            // The supervisor socket closed (a shutdown, restart, or
            // update): the daemon-backed flows cannot be served, so the
            // mode ends with a non-zero exit instead of a zombie card.
            server.abort();
            Err(anyhow::anyhow!(
                "the daemon connection closed; restart the A2A server to reattach"
            ))
        }
        () = wait_sigterm(&mut sigterm) => {
            server.abort();
            Ok(())
        }
    };
    teardown(&link, &state).await;
    if let Some(path) = &minted_token_path {
        let _ = std::fs::remove_file(path);
    }
    // The mode's own telemetry drain: the client's delivery window (a
    // timed batch flush) never covers a short run, and the runtime that
    // hosts its worker dies with this process once the mode returns —
    // the exit drains the queued events under the same shared bound the
    // interactive modes' exits join their flushes under (delivered or
    // dropped, never a hung exit), so a try-out run that serves one
    // request and quits still reports it.
    if let Some(client) = exit_flush.as_ref() {
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(TELEMETRY_EXIT_TIMEOUT_MS),
            client.shutdown(),
        )
        .await;
    }
    exit.map(|()| 0)
}

/// Wait the mode's SIGTERM watch for its NEXT signal: the stream the
/// mode installs at its entry (a `kill` racing an uninstalled handler
/// dies the default hard death, so the watch must predate the
/// readiness lines that prove it armed). A `None` watch — an
/// uninstalled handler, a platform without a portable terminate
/// signal — never fires; the mode's other exits own it.
#[cfg(unix)]
async fn wait_sigterm(sigterm: &mut Option<tokio::signal::unix::Signal>) {
    match sigterm.as_mut() {
        Some(stream) => {
            stream.recv().await;
        }
        None => std::future::pending::<()>().await,
    }
}

/// The Windows process model carries no portable terminate signal for
/// a single-child mode: the watch never fires there, and the mode's
/// other exits own it.
#[cfg(not(unix))]
async fn wait_sigterm(_sigterm: &mut ()) {
    std::future::pending::<()>().await;
}

/// Wait the mode's interrupt watch for its NEXT signal (see
/// [`wait_sigterm`]): the entry-armed watch answers a terminal Ctrl-C
/// through the mode's ONE graceful exit, so the owned sessions stop
/// and the minted token file leaves. A `None` watch — an uninstalled
/// handler — never fires; the mode's other exits own it.
#[cfg(unix)]
async fn wait_sigint(sigint: &mut Option<tokio::signal::unix::Signal>) {
    match sigint.as_mut() {
        Some(stream) => {
            stream.recv().await;
        }
        None => std::future::pending::<()>().await,
    }
}

/// The non-unix exit keeps the portable `ctrl_c` arm: no `SignalKind`
/// watch installs there, and the select's own arm owns the interrupt.
#[cfg(not(unix))]
async fn wait_sigint(_sigint: &mut ()) {
    let _ = tokio::signal::ctrl_c().await;
}

/// Route one link frame. A response whose id carries a task tag first
/// takes its frame-ordered task step synchronously (the prompt
/// response claims the task's turn window and hands the settle to the
/// flow's completion step), then wakes the request's waiter. Events
/// route to the session's head task.
async fn receive_link_frame(link: &Arc<DaemonLink>, state: &Arc<Mutex<A2aState>>) -> bool {
    use crate::mode_link::LinkFrame;
    let frame = {
        let mut frames = link.frames.lock().await;
        frames.recv().await
    };
    match frame {
        Some(LinkFrame::Response(response)) => {
            let id = response.id.clone().unwrap_or_default();
            let tag = link.tags.lock().unwrap().remove(&id);
            if let Some(task_id) = tag {
                settle_prompt_at_pump(state, &task_id, response.success).await;
            }
            if let Some(tx) = link.pending.lock().unwrap().remove(&id) {
                let _ = tx.send(response);
            }
            true
        }
        Some(LinkFrame::Event(event)) => {
            on_session_event(state, &event).await;
            true
        }
        Some(LinkFrame::SessionBinding(binding)) => {
            on_session_binding(state, &binding).await;
            true
        }
        // The heartbeat catalog is a TUI/ACP surface; the A2A protocol
        // has no counterpart.
        Some(LinkFrame::HeartbeatsChanged) => true,
        None => false,
    }
}

/// The supervisor's stale-id rebind notice (`session_binding`, its own
/// top-level frame — `pa-types` `DaemonOutbound::SessionBinding`, the
/// same frame the TUI parses at the top level): a re-host re-keyed a
/// session, and the pump's routing map plus the context binding follow
/// (the context's durable identity is unchanged — only the worker's
/// active id moved). Without the re-key, a replaced worker's events
/// carry an id the routing map dropped, and every queued task on the
/// context settles with no streamed text.
async fn on_session_binding(state: &Arc<Mutex<A2aState>>, binding: &Value) {
    let previous = binding
        .get("previousActiveSessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let current = binding
        .get("activeSessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut guard = state.lock().await;
    let Some(context_id) = guard.sessions.remove(&previous) else {
        return;
    };
    // The abandoned id's turn-window and run entries go with the
    // re-key: the frames route under the fresh id from here on, so
    // the old entries are unreachable (the tables never grow with
    // every re-host).
    guard.windows.remove(&previous);
    guard.runs.drop_session(&previous);
    if !current.is_empty() {
        guard.sessions.insert(current.clone(), context_id.clone());
    }
    if let Some(session) = guard.contexts.get_mut(&context_id) {
        session.active_id = current;
    }
}

/// The pump's synchronous step at one task's prompt response: the
/// task's artifact becomes its own run's parked reply — the whole
/// agent run its prompt anchored (the flush barrier orders the
/// response after the run's frames), however many model steps the run
/// closed. The run-reply claim is the artifact authority; the
/// dispatch-anchored window claim is the fallback when no owned run
/// closed before the response (a lost or untagged frame stream),
/// immune to an interleaving turn no task owns. Only a successful
/// turn claims: a failed or withdrawn response settles no reply, and
/// a parked window may belong to a turn no task owns.
///
/// An otherwise-successful turn keeps the head (marked
/// `awaiting_completion`): the daemon's autonomous continuation — a
/// goal driver, a post-compaction run, RLM child follow-ups — still
/// owes turns after the response, their runs credit to the task
/// (see `events.rs`), and the flow's headless-completion step settles
/// the task once the run finished (the ACP mode waits the same run
/// out through `WaitForHeadlessCompletion`).
async fn settle_prompt_at_pump(state: &Arc<Mutex<A2aState>>, task_id: &str, success: bool) {
    let mut guard = state.lock().await;
    let Some(entry) = guard.registry.task(task_id) else {
        return;
    };
    let session_id = entry.session_id.clone();
    // The task's own run reply first (the artifact authority), the
    // dispatch-anchored window claim as the fallback (a follow-up turn
    // the daemon admitted at the turn's end can interleave its frames
    // before the response — "the newest closed window" would steal
    // that turn's reply; the anchor names the task's own). An
    // unanchored claim (no flow behind the prompt) falls back to the
    // newest closed window.
    let anchor = guard
        .registry
        .task(task_id)
        .and_then(TaskEntry::window_anchor);
    let window_text = match (success, anchor) {
        (true, Some(anchor)) => guard
            .registry
            .take_initial_run_reply(task_id)
            .or_else(|| guard.windows.claim_after(&session_id, anchor)),
        (true, None) => guard
            .registry
            .take_initial_run_reply(task_id)
            .or_else(|| guard.windows.claim_closed(&session_id)),
        (false, _) => None,
    };

    if let Some(text) = window_text.filter(|text| !text.is_empty()) {
        if guard
            .registry
            .task(task_id)
            .is_some_and(|task| task.artifact_text() != text)
        {
            guard.registry.set_artifact_text(task_id, &text);
        }
    }
    if success {
        guard.registry.mark_awaiting_completion(task_id);
        // An engine continuation that closed before the response (the
        // response lagged the run the daemon minted behind the prompt)
        // parked its result on the dispatched head: apply the parked
        // lot in its run order — the same settlement a post-response
        // continuation's `agent_end` owns, so the continuation's
        // output reaches the artifact and its outcome carries to the
        // final settlement, whatever the response's ordering.
        for (_, text, error) in guard.registry.take_parked_autonomous(task_id) {
            guard
                .registry
                .continuation_run_closed(task_id, text.as_deref(), error.as_deref());
        }
        return;
    }
    // A failed or withdrawn response retires at once, and its parked
    // pre-response continuation results go with it: a continuation's
    // parked result is never applied to a retired head.
    guard.registry.take_parked_autonomous(task_id);
    guard.registry.retire(task_id);
}

/// The bound on the teardown withdrawal's no-op retry (a prompt that
/// left for the daemon between the exit's snapshot and its receipt may
/// still sit in the supervisor's dispatch; the bound is a liveness
/// guard, the same window the cancel ladder retries).
const TEARDOWN_WITHDRAW_RETRY_BOUND: std::time::Duration = std::time::Duration::from_secs(2);
/// The retry cadence of [`TEARDOWN_WITHDRAW_RETRY_BOUND`] (the cancel
/// ladder's own cadence).
const TEARDOWN_WITHDRAW_RETRY_CADENCE: std::time::Duration = std::time::Duration::from_millis(10);

/// Stop the work this server admitted, then the owned context
/// sessions (a resident session keeps running: the daemon's durability
/// model, not this process's). The exit is ONE settlement decision
/// made under the state guard: the shutting-down mark refuses every
/// later admission (a send flow observes it at its admission, under
/// the same guard), each live task whose prompt never reached the
/// daemon settles CANCELED there — nothing in the daemon names it, and
/// its flow's write step observes the terminal row under the same
/// guard — and each live dispatched task's delivery is withdrawn with
/// the no-op retry (the same `WithdrawAdmission` the `CancelTask`
/// withdraw arm sends, keyed by [`TaskEntry::delivery_id`]: it sweeps
/// the task's queued rows and aborts its running turn; a prompt that
/// left for the daemon between the snapshot and its receipt may still
/// sit in the supervisor's dispatch, and the retry closes exactly
/// that window) — an operator's SIGINT stops the turns the server
/// owns, they never run on in the daemon with no client left to
/// answer (the ACP mode cancels its running prompt at connection end
/// the same way; the A2A mode's every exit funnels through here).
/// Each receipt is read only to decide that bounded retry, and the
/// loop stops once the receipt names swept rows, an aborted turn, or a
/// task whose own response already arrived (`awaiting_completion`: no
/// handoff can be in flight, and the work its closed run delegated
/// keeps running) — and each exchange rides the link's own request
/// bound.
async fn teardown(link: &Arc<DaemonLink>, state: &Arc<Mutex<A2aState>>) {
    let (withdrawals, owned_sessions): (Vec<(String, String, String)>, Vec<String>) = {
        let mut guard = state.lock().await;
        guard.shutting_down = true;
        let (undispatched, dispatched) = guard.registry.shutdown_live_split();
        for task_id in &undispatched {
            guard.registry.settle(task_id, TaskState::Canceled, None);
        }
        let owned_sessions = if guard.client_owned {
            guard
                .contexts
                .values()
                .map(|session| session.active_id.clone())
                .collect()
        } else {
            Vec::new()
        };
        (dispatched, owned_sessions)
    };
    for (task_id, session_id, delivery_id) in withdrawals {
        let deadline = std::time::Instant::now() + TEARDOWN_WITHDRAW_RETRY_BOUND;
        loop {
            let Ok(response) = link
                .request(DaemonCommand::WithdrawAdmission {
                    id: None,
                    active_session_id: session_id.clone(),
                    admission_id: delivery_id.clone(),
                    rest: Map::default(),
                })
                .await
            else {
                // The link is gone (the daemon connection closed) or
                // its request bound expired (`mode_link`'s 30 s
                // REQUEST_TIMEOUT — one wedged worker can cost the
                // exit that much): no retry can reach it inside the
                // bound, and the exit owes the receipt nothing — the
                // mode ends with the link.
                break;
            };
            // The receipt's stop verdict (the worker's answer names
            // the rows it swept and the turn it aborted): a success
            // that swept rows or aborted the turn stopped the
            // delivery's daemon-side work.
            let swept = response.success
                && response.data.as_ref().is_some_and(|data| {
                    data.get("steering")
                        .and_then(Value::as_array)
                        .is_some_and(|rows| !rows.is_empty())
                        || data
                            .get("followUp")
                            .and_then(Value::as_array)
                            .is_some_and(|rows| !rows.is_empty())
                        || data
                            .get("aborted")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                });
            if swept {
                break;
            }
            // A no-op receipt names owed work only while the task's own
            // response is still outstanding (a prompt whose handoff
            // raced the exit's snapshot may sit in the supervisor's
            // dispatch). The task settled on its own while the receipt
            // traveled, or its own response already arrived
            // (`awaiting_completion`: no handoff can be in flight, and
            // the work its closed run delegated keeps running): nothing
            // of it remains to stop.
            if response.success
                && state
                    .lock()
                    .await
                    .registry
                    .task(&task_id)
                    .is_some_and(|task| task.state().is_terminal() || task.awaiting_completion())
            {
                break;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(TEARDOWN_WITHDRAW_RETRY_CADENCE).await;
        }
    }
    for session_id in owned_sessions {
        let _ = link
            .request(DaemonCommand::CompleteOwnedSession {
                id: None,
                active_session_id: session_id,
                rest: Map::default(),
            })
            .await;
    }
}

/// One served-request adoption event (fire-and-forget, primitives
/// only; the catalog's vocabulary pins the method/outcome enums): the
/// base properties ride under the event's own (the same attribution
/// every emitter's events carry — schema, version, execution mode,
/// workload origin — so a CI, TCK, or internal run never reads as user
/// adoption).
pub(crate) fn track_request_served(
    telemetry: Option<&TelemetryClient>,
    method: &str,
    outcome: &str,
) {
    if let Some(client) = telemetry {
        let mut properties = pa_telemetry::base_properties("a2a");
        properties.set("method", json!(method));
        properties.set("outcome", json!(outcome));
        client.track("a2a request served", properties);
    }
}

/// The A2A method dispatch: one JSON-RPC request in, one reply or one
/// SSE stream out.
///
/// The served methods (spec 9.4): `SendMessage`, `SendStreamingMessage`,
/// `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`.
/// Push-notification configuration and the extended agent card are
/// capability-gated off
/// (the card declares them false; the errors are the spec's -32003 /
/// -32004).
pub(crate) async fn dispatch(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    request: jsonrpc::IncomingRequest,
) -> Dispatch {
    let jsonrpc::IncomingRequest { id, method, params } = request;
    match method.as_str() {
        "SendMessage" => send_message(link, state, id, params, Streaming::No).await,
        "SendStreamingMessage" => send_message(link, state, id, params, Streaming::Yes).await,
        "GetTask" => get_task(state, id, params).await,
        "ListTasks" => list_tasks(state, id, params).await,
        "CancelTask" => cancel_task(link, state, id, params).await,
        "SubscribeToTask" => subscribe_to_task(state, id, params).await,
        "CreateTaskPushNotificationConfig"
        | "GetTaskPushNotificationConfig"
        | "ListTaskPushNotificationConfigs"
        | "DeleteTaskPushNotificationConfig" => Dispatch::Reply(jsonrpc::a2a_error_response(
            &id,
            A2aError::PushNotificationNotSupported,
            None,
        )),
        "GetExtendedAgentCard" => Dispatch::Reply(jsonrpc::a2a_error_response(
            &id,
            A2aError::UnsupportedOperation,
            None,
        )),
        _ => Dispatch::Reply(jsonrpc::error_response(
            &id,
            jsonrpc::METHOD_NOT_FOUND,
            "Method not found",
            None,
        )),
    }
}

/// Whether a send streams its reply over SSE.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Streaming {
    Yes,
    No,
}

/// The message text of one request: the parts joined with a newline,
/// every part textual (the card's declared input mode), non-empty. An
/// all-text message whose text is empty is a parameter error (an
/// empty `message.parts` text carries no content to process), never
/// the content-type error a non-text part answers — the part IS text,
/// the request is just empty.
fn message_text(id: &Value, request: &SendMessageRequest) -> Result<String, Value> {
    if request.message.parts.is_empty() {
        return Err(jsonrpc::invalid_params_response(
            id,
            "message.parts",
            "message.parts must not be empty",
        ));
    }
    for part in &request.message.parts {
        if !part.is_valid() {
            return Err(jsonrpc::invalid_params_response(
                id,
                "message.parts",
                "each part must contain exactly one of text, raw, url, data",
            ));
        }
    }
    match Part::join_text(&request.message.parts) {
        Some(text) if !text.is_empty() => Ok(text),
        Some(_) => Err(jsonrpc::invalid_params_response(
            id,
            "message.parts",
            "the message's text parts carry no text",
        )),
        None => Err(jsonrpc::a2a_error_response(
            id,
            A2aError::ContentTypeNotSupported,
            Some(&json!({ "supported": card::INPUT_MODE })),
        )),
    }
}

/// One send (`SendMessage` / `SendStreamingMessage`).
///
/// The flow (spec 3.1.1/3.1.2): route the context (a `taskId`
/// continuation is refused, the v1 answer), admit one task per turn,
/// dispatch the prompt with the task's delivery id as its admission
/// id, and answer — the blocking mode awaits the turn's settle, the
/// streaming mode returns the task's snapshot followed by its live
/// frames, and a `returnImmediately` send returns right away with the
/// task admitted. The whole flow runs detached from the HTTP handler's
/// future, so a client disconnect can no longer drop the settle
/// (stranding a WORKING task and its context queue head) or orphan a
/// created session.
async fn send_message(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    id: Value,
    params: Value,
    streaming: Streaming,
) -> Dispatch {
    let mut request: SendMessageRequest = match serde_json::from_value(params) {
        Ok(request) => request,
        Err(error) => {
            return Dispatch::Reply(jsonrpc::invalid_params_response(
                &id,
                "params",
                &error.to_string(),
            ));
        }
    };
    // proto3's non-optional scalars (the same rule the `ListTasks`
    // boundary applies): `Message.taskId` and `Message.contextId` are
    // plain strings, so a client DTO that serializes its explicit
    // defaults sends the same wire value as an omission —
    // `taskId: ""` is a new task (never a -32001 for a task that does
    // not exist), `contextId: ""` starts a conversation (never the
    // unknown-context -32602).
    request.message.task_id = request
        .message
        .task_id
        .take()
        .filter(|task_id| !task_id.is_empty());
    request.message.context_id = request
        .message
        .context_id
        .take()
        .filter(|context_id| !context_id.is_empty());
    let text = match message_text(&id, &request) {
        Ok(text) => text,
        Err(reply) => return Dispatch::Reply(reply),
    };

    // An inline push configuration is a request this server cannot
    // honor (the card declares push off, spec 3.2.2's -32003) — on a
    // first send and on a continuation alike, before any context or
    // prompt side effect.
    if request
        .configuration
        .as_ref()
        .is_some_and(|config| config.task_push_notification_config.is_some())
    {
        return Dispatch::Reply(jsonrpc::a2a_error_response(
            &id,
            A2aError::PushNotificationNotSupported,
            None,
        ));
    }

    // A `taskId` continuation (spec 3.4.3) is refused in v1: the
    // turn-based session model has no mid-turn injection, so every
    // known task — SUBMITTED, WORKING, or terminal alike — answers the
    // spec's -32004 (the terminal rejection is a MUST, the running
    // state has no honest steering to offer) and the client sends a new
    // message on the context instead. An unknown id stays the spec's
    // -32001.
    if let Some(task_id) = request.message.task_id.clone() {
        let known = state.lock().await.registry.task(&task_id).is_some();
        if !known {
            return Dispatch::Reply(jsonrpc::a2a_error_response(
                &id,
                A2aError::TaskNotFound,
                Some(&json!({ "taskId": task_id })),
            ));
        }
        return Dispatch::Reply(jsonrpc::a2a_error_response(
            &id,
            A2aError::UnsupportedOperation,
            Some(
                &json!({ "reason": "this server does not continue tasks by taskId; send a new message on the context instead" }),
            ),
        ));
    }

    // The mode's exit owns this server: no new task admits after the
    // teardown's settlement pass began. The send flow's admission
    // re-checks the flag under the guard that admits (the check here
    // only keeps the request from spawning a context create against a
    // server that is going away).
    if state.lock().await.shutting_down {
        return Dispatch::Reply(jsonrpc::error_response(
            &id,
            jsonrpc::INTERNAL_ERROR,
            "the A2A server is shutting down; retry against a restarted server",
            None,
        ));
    }

    // The flow runs to completion however the HTTP connection ends.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SendFlowOutcome>();
    {
        let link = Arc::clone(link);
        let state = Arc::clone(state);
        let id = id.clone();
        let request = request.clone();
        let text = text.clone();
        tokio::spawn(async move {
            run_send_flow(&link, &state, id, request, streaming, text, tx).await;
        });
    }
    match rx.recv().await {
        Some(SendFlowOutcome::Settled(reply)) => Dispatch::Reply(reply),
        Some(SendFlowOutcome::Admitted { task_id, claim }) => {
            match streaming {
                // The snapshot and the stream register under one
                // registry guard (spec 3.5.2's ordered events): a
                // chunk published after the guard is only in the live
                // stream, one published before it only in the snapshot
                // — never both, never neither. The first SSE frame
                // wraps the task snapshot in the stream response's
                // oneof (`StreamResponse::Task`, spec 3.2.3/9.4.2 — a
                // bare `Task` result would make a conforming client
                // lose the task id and strict ProtoJSON reject the
                // frame); the return-immediately send below keeps the
                // `SendMessageResponse` wrapper (spec 9.4.1).
                Streaming::Yes => {
                    let (snapshot, stream) = {
                        let mut guard = state.lock().await;
                        let subscribed = guard
                            .registry
                            .subscribe_with_snapshot(&task_id, claim.history_length());
                        if let Some((snapshot, stream)) = subscribed {
                            (Some(snapshot), Some(stream))
                        } else {
                            // The flow finished before the handler
                            // subscribed: a successful streaming method
                            // still answers SSE (spec 9.4.2) — the
                            // task's own verdict (the registry's row
                            // while the window keeps it, the claim's
                            // captured snapshot once it advanced past
                            // it) first, its terminal frame closing a
                            // finite stream — never a JSON reply raced
                            // out of the stream shape.
                            let verdict = guard
                                .registry
                                .snapshot(&task_id, claim.history_length())
                                .or_else(|| claim.captured());
                            (verdict, None)
                        }
                    };
                    let snapshot = snapshot
                        .expect("the admission's verdict claim answers the task's own truth");
                    let stream = stream.unwrap_or_else(|| {
                        super::task::TaskRegistry::terminal_stream_for_status(
                            &task_id,
                            snapshot.context_id.as_deref().unwrap_or_default(),
                            snapshot.status.clone(),
                        )
                    });
                    Dispatch::Stream(id.clone(), stream_first_frame(&id, &snapshot), stream)
                }
                Streaming::No => Dispatch::Reply(send_reply(state, &claim, &id, &task_id).await),
            }
        }
        None => Dispatch::Reply(jsonrpc::error_response(
            &id,
            jsonrpc::INTERNAL_ERROR,
            "the send flow ended before answering",
            None,
        )),
    }
}

/// The write turnstile's wait: the flow's task reaches its context's
/// queue head — its turn to write the prompt — or settles first
/// (`false`). Each check locks the state for its read only and the
/// park holds no guard, so the pump's settle keeps rotating heads while
/// queued flows are parked here (a parked flow must never freeze the
/// pump — the registry's `head_wake` is cloned out for exactly that).
async fn await_turn_at_head(state: &Arc<Mutex<A2aState>>, context_id: &str, task_id: &str) -> bool {
    let notify = state.lock().await.registry.head_wake();
    loop {
        // Register before checking: a rotation that lands between the
        // check and the park still wakes the wait.
        let notified = notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let (is_head, gone) = {
            let guard = state.lock().await;
            (
                guard
                    .registry
                    .head(context_id)
                    .is_some_and(|task| task.id == task_id),
                guard
                    .registry
                    .task(task_id)
                    .is_none_or(|task| task.state().is_terminal()),
            )
        };
        if is_head {
            return true;
        }
        if gone {
            return false;
        }
        notified.await;
    }
}

/// One send's daemon flow, detached from the connection: create the
/// context, admit the task, dispatch the prompt, and settle the task
/// — the acknowledgement rides the channel (`Admitted` once the task
/// is live for the streaming and return-immediately modes, `Settled`
/// for the blocking mode and for failures).
///
/// The flow's reply owns a verdict claim (see
/// [`super::task::VerdictClaim`]) registered at the admission: the
/// task can settle at any of its waits, and the reply's claim-aware
/// read answers the task's own verdict — the registry's row while the
/// retention window keeps it, the claim's captured snapshot once the
/// window advanced past it — never a fabricated verdict.
async fn run_send_flow(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    id: Value,
    request: SendMessageRequest,
    streaming: Streaming,
    text: String,
    tx: tokio::sync::mpsc::UnboundedSender<SendFlowOutcome>,
) {
    let task_id = uuid::Uuid::new_v4().to_string();
    send_flow_to_settle(link, state, id, &task_id, request, streaming, text, tx).await;
}

/// The send flow's body behind the reply's verdict claim (see
/// [`super::task::VerdictClaim`]).
#[allow(clippy::too_many_arguments)] // the send's full request shape, one arg each
async fn send_flow_to_settle(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    id: Value,
    task_id: &str,
    request: SendMessageRequest,
    streaming: Streaming,
    text: String,
    tx: tokio::sync::mpsc::UnboundedSender<SendFlowOutcome>,
) {
    // The context routing (spec 3.4.1): an absent context starts one, a
    // known context continues it, an unknown client-supplied context id
    // is rejected (the server generates its own context ids). The
    // validation and the task's admission are ONE registry-guard step:
    // a concurrent conversation's eviction may sit between them
    // otherwise, and the admitted task would address a binding that no
    // longer exists.
    let task_id = task_id.to_string();
    let message_id = request.message.message_id.clone();
    let history_length = request
        .configuration
        .as_ref()
        .and_then(|config| config.history_length);
    let blocking = streaming == Streaming::No && request.blocking();
    let message_parts = request.message.parts.clone();
    let (context_id, session_id) = if let Some(context_id) = request.message.context_id.as_deref() {
        // The admission holds one registry-guard step with the context
        // validation (above) — and with the eviction's closing
        // reservation: a context the live-context reclamation is
        // closing never admits. The send waits the reclamation's own
        // lock out (the binding survived the refused stop or the
        // conversation ended with the eviction) and re-validates, so
        // the acknowledged task always addresses a binding the stop
        // already settled — never a session the kill closed under it.
        let mut guard = state.lock().await;
        loop {
            if guard.shutting_down {
                drop(guard);
                let _ = tx.send(SendFlowOutcome::Settled(jsonrpc::error_response(
                    &id,
                    jsonrpc::INTERNAL_ERROR,
                    "the A2A server is shutting down; retry against a restarted server",
                    None,
                )));
                return;
            }
            if !guard.contexts.contains_key(context_id) {
                drop(guard);
                let _ = tx.send(SendFlowOutcome::Settled(jsonrpc::invalid_params_response(
                    &id,
                    "contextId",
                    "unknown contextId; send without contextId to start a conversation",
                )));
                return;
            }
            if let Some(closing) = guard.closing.get(context_id).cloned() {
                drop(guard);
                {
                    // The reclamation's own lock: it releases only when
                    // the stop settled (the map entry is gone first, so
                    // the re-validation below never waits twice).
                    let _held = closing.lock().await;
                }
                guard = state.lock().await;
                continue;
            }
            break;
        }
        guard.touch_context(context_id);
        let session_id = guard
            .contexts
            .get(context_id)
            .map(|session| session.active_id.clone())
            .expect("the validated context carries its binding");
        guard.registry.admit(
            task_id.clone(),
            context_id.to_string(),
            session_id.clone(),
            (!message_id.is_empty()).then_some(message_id.clone()),
            message_parts,
        );
        (context_id.to_string(), session_id)
    } else {
        // The new conversation: the create reserves its capacity and
        // answers the binding; the flow registers the context and
        // admits its first task under one guard (the reservation
        // releases with the insertion, never before).
        let (context_id, binding, created_session_id) = match create_context(link, state).await {
            Ok(created) => created,
            Err(error) => {
                let _ = tx.send(SendFlowOutcome::Settled(jsonrpc::error_response(
                    &id,
                    jsonrpc::INTERNAL_ERROR,
                    &error,
                    None,
                )));
                return;
            }
        };
        let mut guard = state.lock().await;
        if guard.shutting_down {
            // The reservation releases with the refusal, like every
            // failure path below: the slot never leaks.
            guard.creating = guard.creating.saturating_sub(1);
            let owned = guard.client_owned;
            drop(guard);
            // The exit began while this conversation's session was
            // being created: nothing admits against the exit's
            // settlement snapshot, and the just-created owned session
            // leaves with the mode — a session the exit's snapshot
            // never saw would outlive it as an orphaned resident.
            if owned {
                let _ = link
                    .request(DaemonCommand::CompleteOwnedSession {
                        id: None,
                        active_session_id: created_session_id.clone(),
                        rest: Map::default(),
                    })
                    .await;
            }
            let _ = tx.send(SendFlowOutcome::Settled(jsonrpc::error_response(
                &id,
                jsonrpc::INTERNAL_ERROR,
                "the A2A server is shutting down; retry against a restarted server",
                None,
            )));
            return;
        }
        guard
            .sessions
            .insert(created_session_id.clone(), context_id.clone());
        guard.contexts.insert(context_id.clone(), binding);
        guard.attached.insert(context_id.clone());
        guard.creating = guard.creating.saturating_sub(1);
        guard.touch_context(&context_id);
        let session_id = created_session_id;
        guard.registry.admit(
            task_id.clone(),
            context_id.clone(),
            session_id.clone(),
            (!message_id.is_empty()).then_some(message_id.clone()),
            message_parts,
        );
        (context_id, session_id)
    };

    // The reply's verdict claim (see [`run_send_flow`]): the task
    // exists from here on, every wait below can settle it, and the
    // settle captures the task's final snapshot into the claim under
    // the registry lock that advances the retention window — the
    // claim-aware reply answers the task's own verdict whether the
    // window keeps the row or has already pruned it.
    let claim = state
        .lock()
        .await
        .registry
        .claim_verdict(&task_id, history_length)
        .expect("the just-admitted task takes the reply's verdict claim");
    if !blocking {
        // The streaming and return-immediately acknowledgement: the
        // task is admitted (spec 3.2.2: the non-blocking modes answer at
        // task creation). The daemon handoff — and everything the
        // settle does after it — keeps running in this detached flow;
        // the handler subscribes its stream under the same registry
        // guard as its snapshot read (the admission, not the stream,
        // rides the channel — the claim rides with it).
        if tx
            .send(SendFlowOutcome::Admitted {
                task_id: task_id.clone(),
                claim: claim.clone(),
            })
            .is_err()
        {
            // The client left; the flow still settles the task so the
            // context queue head retires.
        }
    }

    // The context's queue head is the write turnstile: the registry's
    // admission order and the daemon's write order agree exactly (the
    // predecessor's settle rotates the head under this wait).
    if !await_turn_at_head(state, &context_id, &task_id).await {
        // The task settled without ever being head (a cancel of the
        // acknowledged task): the honest answer is its claimed verdict.
        let _ = tx.send(SendFlowOutcome::Settled(
            send_reply(state, &claim, &id, &task_id).await,
        ));
        return;
    }
    // The context's session must be attached before the flow writes to
    // it: an idle-detached context re-attaches here (the session
    // persists on disk, so the daemon re-hosts it). A re-host answers
    // a fresh worker's active id: the task's own binding (the pump's
    // attribution, every cancel and continuation addressing the
    // session) and this flow's selector re-bind to it BEFORE the
    // prompt is written — a stale create-time id would address a
    // worker the daemon replaced, and the pump would collect the reply
    // under an id the routing dropped.
    if let Err(error) = ensure_attached(link, state, &context_id).await {
        state
            .lock()
            .await
            .registry
            .settle(&task_id, TaskState::Failed, Some(error.clone()));
        let _ = tx.send(SendFlowOutcome::Settled(jsonrpc::error_response(
            &id,
            jsonrpc::INTERNAL_ERROR,
            &error,
            None,
        )));
        return;
    }
    let session_id = {
        let mut guard = state.lock().await;
        let fresh = guard
            .contexts
            .get(&context_id)
            .map_or(session_id, |session| session.active_id.clone());
        guard.registry.rebind_session(&task_id, &fresh);
        fresh
    };
    // The session must be quiet before the prompt is written: an
    // in-flight or queued foreign turn (a daemon prompt, a TUI user, a
    // heartbeat) finishes first, so the turn that runs after this
    // write is the task's own — its live frames and claimed window are
    // exactly its reply, never another turn's text. The wait is
    // uncapped (the link's close is the liveness bound, the same bound
    // the `PromptAndWait` below rides): the daemon budgets `WaitForIdle`
    // as a turn-long command, and a foreign turn that outlasts the
    // link's short request cap would otherwise fail a task that only
    // needed to keep waiting.
    // The exchange is the session's ONE shared idle barrier (see
    // [`idle_barrier`]): the first flow needing the quiet issues it, a
    // canceled flow leaves it in flight for the next queue head, and
    // repeated send/cancel pairs against one never-ending foreign
    // turn never stack one dead pending request per send.
    // The idle wait races the task's own terminal settle: a CancelTask
    // settling the acknowledged task while its turn waits out a foreign
    // one publishes the terminal frame on the task's stream, and the
    // flow answers the settled snapshot AT ONCE instead of holding the
    // blocking reply until the foreign turn ends. The foreign turn is
    // never aborted — the flow simply stops reading the barrier's
    // answer (the exchange itself lives until the daemon answers it,
    // so no pending slot is abandoned behind the foreign turn).
    // A post-abort suspension parks the session's queue behind the
    // abort: resume it before the wait so the parked rows drain as
    // ordinary foreign turns instead of wedging the wait (the abort's
    // suspension survives the aborted turn's own settle — the runner
    // never drains a suspended lane). The detached resume keeps the
    // wait's own races in front of its receipt, and the tick arm below
    // re-issues it against a suspension that lands MID-WAIT.
    resume_parked_queue_detached(link, state, &session_id).await;
    let mut settle_stream = state.lock().await.registry.subscribe(&task_id);
    let barrier = idle_barrier(link, state, &session_id).await;
    let mut idle = barrier.subscribe();
    let response = loop {
        // A task that settled before this flow subscribed answers at
        // once too (subscribe answers None for a terminal task).
        let Some(stream) = settle_stream.as_mut() else {
            break None;
        };
        // A barrier that already answered while this flow raced its
        // subscription reads the answer directly.
        if let Some(answer) = idle.borrow().clone() {
            break Some(answer);
        }
        tokio::select! {
            changed = idle.changed() => match changed {
                Ok(()) => {}
                // The barrier's sender lives in its Arc, held by the
                // state and the owner task; the channel closes only
                // after the publish, which the borrow above already
                // answered. Any close before an answer is a dead
                // exchange: fail honestly, never hang the flow.
                Err(_) => break Some(
                    idle.borrow()
                        .clone()
                        .unwrap_or_else(|| Err("the idle barrier closed".to_string())),
                ),
            },
            frame = stream.recv() => match frame {
                Some(StreamResponse::StatusUpdate(event)) if event.status.state.is_terminal() => {
                    break None;
                }
                Some(_) => {}
                None => break None,
            },
            // A foreign abort that landed mid-wait re-parked the queue
            // behind a fresh suspension (the runner never drains a
            // suspended lane), and the idle wait never answers a
            // suspended non-empty lane: the one resume before the wait
            // cannot cover it. The detached re-resume on this cadence
            // unwedges the wait — and its receipt never blocks the arm
            // (see [`resume_parked_queue_detached`]).
            () = tokio::time::sleep(PARKED_QUEUE_RECHECK) => {
                resume_parked_queue_detached(link, state, &session_id).await;
            }
        }
    };
    match response {
        Some(Ok(())) => {}
        Some(Err(error)) => {
            state
                .lock()
                .await
                .registry
                .settle(&task_id, TaskState::Failed, Some(error));
            let _ = tx.send(SendFlowOutcome::Settled(jsonrpc::error_response(
                &id,
                jsonrpc::INTERNAL_ERROR,
                "the session never settled before the task's turn",
                None,
            )));
            // The flow's own context identity — never a task-registry
            // lookup: the terminal retention window may have pruned the
            // task's row while this flow waited, and the cleanup must
            // still release the idle hold.
            detach_context_if_idle(link, state, &context_id).await;
            return;
        }
        None => {
            // The task settled while its turn waited (a cancel of the
            // acknowledged task): the honest answer is its claimed
            // verdict — the same answer the write-claim arm serves
            // below, without waiting out the foreign turn. A cancel
            // that settled the task DURING this flow's attach round
            // ran its own idle detach before the round published the
            // `attached` mark (the detach then observed nothing), so
            // this flow — the only writer that watched the round
            // publish — releases the now-idle hold: a context with no
            // live task must not keep its worker pinned. The detach is
            // idle-gated, so a successor admitted meanwhile (the
            // queue's next head) keeps its attachment.
            let _ = tx.send(SendFlowOutcome::Settled(
                send_reply(state, &claim, &id, &task_id).await,
            ));
            // The flow's own context identity — never a task-registry
            // lookup: the cancel settled this task long before the
            // attach round answered, the terminal retention window may
            // have pruned its row meanwhile, and the cleanup must still
            // release the idle hold the round attached.
            detach_context_if_idle(link, state, &context_id).await;
            return;
        }
    }
    // The write claim: a cancel that settled the task during the waits
    // leaves nothing to write (and a settled task's settle answers the
    // cancel), so the flow stops without touching the daemon.
    if !state.lock().await.registry.mark_prompt_writing(&task_id) {
        let _ = tx.send(SendFlowOutcome::Settled(
            send_reply(state, &claim, &id, &task_id).await,
        ));
        return;
    }

    // The prompt's dispatch anchor: the next window the session will
    // close is the task's own turn (the flow dispatched on a quiet
    // session), so the pump's response step claims exactly it.
    let window_anchor = state.lock().await.windows.next_seq(&session_id);
    // The task's delivery identity — the unique admission id this
    // prompt carries (never the public task id: another daemon client
    // may send the same id as its own admission, and the task's runs,
    // withdrawal, and scoped quiescence all resolve by THIS one).
    let delivery_id = {
        let guard = state.lock().await;
        guard
            .registry
            .task(&task_id)
            .map_or_else(|| task_id.clone(), |task| task.delivery_id().to_string())
    };
    let prompt = DaemonCommand::PromptAndWait {
        id: None,
        active_session_id: session_id,
        message: text,
        input: PromptInput {
            content: None,
            images: None,
            // The ACP mode's resume contract: a prompt carrying a
            // streaming behavior resumes the post-abort queued-input
            // suspension, so a send after a cancellation runs.
            streaming_behavior: Some(StreamingBehavior::FollowUp),
            queue_if_busy: None,
            expand_prompt_templates: None,
            source: None,
            agent_message_id: None,
            custom_message: None,
            queue_key: None,
            prefix_messages: None,
            admission_id: Some(delivery_id),
            rlm_notice_nonce: None,
        },
        // The task-per-turn isolation rides the row: the prompt's row
        // batches with no other delivery (the intake reads the member
        // into the row's `delivery_scoped` flag), so two tasks queued
        // on one session answer one reply each, never a co-delivered
        // turn whose single reply one task's response would claim.
        rest: Map::from_iter([("deliveryScoped".to_string(), json!(true))]),
    };

    // The prompt write and its public dispatch mark are ONE state-guard
    // step. The daemon's writer makes the line visible before the call
    // returns, so a pump task on the shared runtime can run the turn's
    // first frames in any gap between the write and the mark — the
    // frames would credit to a head the pump classes as unwritten and
    // the task's whole reply dies there. The guard closes the gap: the
    // pump's first observation of the turn reads a dispatched head (a
    // writing head credits its own run too, see
    // [`super::task::TaskEntry::prompt_write_claimed`], but the mark is
    // the contract the response, the windows, and a `CancelTask`'s
    // handoff wait all read). A `CancelTask` landing in this window
    // waits on the mark before it reaches the daemon, so an
    // acknowledged task is never uncancelable merely because its
    // detached request is still in the handoff. A write that fails
    // settles the task under the same guard, before any frame of it
    // exists.
    let pending = {
        let mut guard = state.lock().await;
        // The write claim and the send are one guarded step, so the
        // task's liveness is decided under the same lock that marks
        // the dispatch: a task that settled between the claim and
        // this step — the teardown's settlement pass, or any other
        // terminal settle — writes nothing, or its prompt would run in
        // the daemon behind a terminal registry row, named by no
        // withdrawal.
        let still_live = guard
            .registry
            .task(&task_id)
            .is_some_and(|task| !task.state().is_terminal());
        if !still_live {
            drop(guard);
            let _ = tx.send(SendFlowOutcome::Settled(
                send_reply(state, &claim, &id, &task_id).await,
            ));
            return;
        }
        match link.send_until_close_tagged(prompt, &task_id) {
            Ok(pending) => {
                guard
                    .registry
                    .mark_prompt_dispatched(&task_id, Some(window_anchor));
                pending
            }
            Err(error) => {
                guard
                    .registry
                    .settle(&task_id, TaskState::Failed, Some(error.to_string()));
                let _ = tx.send(SendFlowOutcome::Settled(jsonrpc::error_response(
                    &id,
                    jsonrpc::INTERNAL_ERROR,
                    &error.to_string(),
                    None,
                )));
                drop(guard);
                detach_context_if_idle(link, state, &context_id).await;
                return;
            }
        }
    };

    let response = pending.wait(link).await;
    match response {
        Ok(response) => {
            settle_from_response(link, state, &task_id, response).await;
        }
        Err(error) => {
            state.lock().await.registry.settle(
                &task_id,
                TaskState::Failed,
                Some(error.to_string()),
            );
        }
    }
    // The blocking answer (spec 3.2.2) reads the terminal verdict
    // BEFORE any post-settle await: the settle already landed, and the
    // claim-aware read answers the task's own verdict — the registry's
    // row while the retention window keeps it, the claim's captured
    // snapshot once it advanced past it — so the detach below cannot
    // wedge the reply behind the window's bound. A pending cancel
    // authority parked the verdict instead of publishing it: the
    // blocking reply waits the authority's receipt out — the answer is
    // the task's own terminal outcome, never the live WORKING row a
    // still-traveling withdrawal receipt would read.
    let settled_reply = if blocking {
        await_settled_verdict(state, &task_id).await;
        Some(send_reply(state, &claim, &id, &task_id).await)
    } else {
        None
    };
    // The context's queue may have drained: an idle context detaches
    // so the daemon's passivation can reclaim its worker (the next
    // send re-attaches). The flow's own context identity — never a
    // task-registry lookup: the terminal retention window may have
    // pruned the settled task's row while the blocking reply waited.
    detach_context_if_idle(link, state, &context_id).await;
    if let Some(reply) = settled_reply {
        let _ = tx.send(SendFlowOutcome::Settled(reply));
    }
}

/// The blocking send's parked-verdict wait (spec 3.2.2): a pending
/// cancel authority — an in-flight `CancelTask` withdrawal or cancel
/// ladder — owns the task's one terminal verdict while its receipt
/// travels, and the completion settle parked its verdict behind it; the
/// blocking reply parks here until the receipt resolves it (an
/// accepted withdrawal settles CANCELED, a refused one publishes the
/// parked verdict, and the detached dispatches always close their
/// authority, so the wait always ends). A task that settled meanwhile
/// answers at its stream's terminal frame; one that settled before the
/// subscription never opens a stream — the flow's verdict claim
/// carries the settled truth either way.
async fn await_settled_verdict(state: &Arc<Mutex<A2aState>>, task_id: &str) {
    let Some(mut stream) = state.lock().await.registry.subscribe(task_id) else {
        return;
    };
    loop {
        match stream.recv().await {
            Some(StreamResponse::StatusUpdate(event)) if event.status.state.is_terminal() => {
                return;
            }
            Some(_) => {}
            None => {
                let terminal = {
                    let guard = state.lock().await;
                    guard
                        .registry
                        .task(task_id)
                        .is_none_or(|task| task.state().is_terminal())
                };
                if terminal {
                    return;
                }
                match state.lock().await.registry.subscribe(task_id) {
                    Some(next) => stream = next,
                    // A live task always subscribes (the terminal
                    // guard under the registry's own lock): a
                    // `None` re-subscribe can only be a settle this
                    // loop's read raced, and the claim-aware reply
                    // answers it.
                    None => return,
                }
            }
        }
    }
}

/// One `GetTask` (spec 3.1.3): the registry's snapshot — the bare
/// `Task` result the spec's method table declares (9.4.1), the unknown
/// id the spec's -32001.
async fn get_task(state: &Arc<Mutex<A2aState>>, id: Value, params: Value) -> Dispatch {
    let params = match serde_json::from_value::<GetTaskParams>(params) {
        Ok(params) => params,
        Err(error) => {
            return Dispatch::Reply(jsonrpc::invalid_params_response(
                &id,
                "params",
                &error.to_string(),
            ));
        }
    };
    let snapshot = state
        .lock()
        .await
        .registry
        .snapshot(&params.id, params.history_length);
    match snapshot {
        Some(task) => Dispatch::Reply(jsonrpc::response(
            &id,
            &serde_json::to_value(task).unwrap_or(Value::Null),
        )),
        None => Dispatch::Reply(jsonrpc::a2a_error_response(
            &id,
            A2aError::TaskNotFound,
            Some(&json!({ "taskId": params.id })),
        )),
    }
}

/// One `ListTasks` (spec 3.1.4): the registry's page, newest first.
async fn list_tasks(state: &Arc<Mutex<A2aState>>, id: Value, params: Value) -> Dispatch {
    let params = match serde_json::from_value::<ListTasksParams>(params) {
        Ok(params) => params,
        Err(error) => {
            return Dispatch::Reply(jsonrpc::invalid_params_response(
                &id,
                "params",
                &error.to_string(),
            ));
        }
    };
    // The wire timestamp is `google.protobuf.Timestamp`'s JSON form —
    // the RFC 3339 string (offsets applied, sub-millisecond precision
    // preserved) or the `{seconds, nanos}` object — parsed at the
    // boundary into epoch nanoseconds; anything else is a parameter
    // error, never a silent no-filter.
    let status_timestamp_after = params
        .status_timestamp_after
        .as_ref()
        .map(|timestamp| timestamp.nanos);
    // proto3's non-optional scalars (spec 5.7: "optional" is the only
    // mechanism that distinguishes an explicitly set field from an
    // omitted one): `contextId`, `status`, and `pageToken` carry no
    // presence, so a client DTO that serializes its explicit defaults
    // sends the same wire value as an omission — `pageToken: ""` is
    // page one (never a foreign-token -32602), `contextId: ""` and
    // `status: TASK_STATE_UNSPECIFIED` are no filters at all (never an
    // empty result).
    // The proto pins the page bound (spec 6.5: "The minimum value is
    // 1. The maximum value is 100"): an out-of-range `pageSize` is the
    // named invalid parameter, never a silently clamped page a client
    // cannot tell from the one it asked for (the negative case fails
    // the u32 parse above).
    if params
        .page_size
        .is_some_and(|size| !(1..=crate::a2a::task::MAX_PAGE_SIZE).contains(&size))
    {
        return Dispatch::Reply(jsonrpc::invalid_params_response(
            &id,
            "pageSize",
            &format!(
                "Must be between 1 and {} inclusive, got {}",
                crate::a2a::task::MAX_PAGE_SIZE,
                params.page_size.unwrap_or_default(),
            ),
        ));
    }
    let context_id = params
        .context_id
        .filter(|context_id| !context_id.is_empty());
    let status = params
        .status
        .filter(|status| *status != TaskState::Unspecified);
    let page_token = params
        .page_token
        .filter(|page_token| !page_token.is_empty());
    let Some((tasks, next_page_token, page_size, total_size)) = state.lock().await.registry.list(
        context_id.as_deref(),
        status,
        status_timestamp_after,
        params.include_artifacts.unwrap_or(false),
        params.history_length,
        params.page_size,
        page_token.as_deref(),
    ) else {
        // The token is not one this server minted (a foreign run id,
        // a malformed shape — the registry's unminted-token arm): the
        // honest invalid-params (-32602), never a silent restart of
        // the walk at page one.
        return Dispatch::Reply(jsonrpc::invalid_params_response(
            &id,
            "pageToken",
            "not a page token this server minted",
        ));
    };
    let response = ListTasksResponse {
        tasks,
        next_page_token,
        page_size,
        total_size,
    };
    Dispatch::Reply(jsonrpc::response(
        &id,
        &serde_json::to_value(response).unwrap_or(Value::Null),
    ))
}

/// One `CancelTask` (spec 3.1.5): the daemon's admission cancel does
/// the work — a queued admission withdraws before delivery, a running
/// one aborts its turn (both through `cancelOwned`), and a terminal
/// task answers the spec's -32002.
async fn cancel_task(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    id: Value,
    params: Value,
) -> Dispatch {
    let params = match serde_json::from_value::<CancelTaskParams>(params) {
        Ok(params) => params,
        Err(error) => {
            return Dispatch::Reply(jsonrpc::invalid_params_response(
                &id,
                "params",
                &error.to_string(),
            ));
        }
    };
    // The acceptance of the live task and its reply's verdict claim
    // are ONE registry step: the daemon ladder, the withdrawal, and
    // every wait below can be answered long after the task's own flow
    // settled it, and other tasks' settles advance the retention
    // window meanwhile — the cancel's reply reads THIS task's own
    // verdict from the acceptance to the capture, never only at its
    // final wait (see [`super::task::VerdictClaim`]).
    let (accepted, session_id, claim) = {
        let mut guard = state.lock().await;
        let Some(task) = guard
            .registry
            .task(&params.id)
            .map(|task| (!task.state().is_terminal(), task.session_id.clone()))
        else {
            return Dispatch::Reply(jsonrpc::a2a_error_response(
                &id,
                A2aError::TaskNotFound,
                Some(&json!({ "taskId": params.id })),
            ));
        };
        let (accepted, session_id) = task;
        let claim = if accepted {
            guard.registry.claim_verdict(&params.id, None)
        } else {
            None
        };
        (accepted, session_id, claim)
    };
    if !accepted {
        return Dispatch::Reply(jsonrpc::a2a_error_response(
            &id,
            A2aError::TaskNotCancelable,
            Some(&json!({ "taskId": params.id })),
        ));
    }
    let claim = claim.expect("the accepted task takes the reply's verdict claim");
    // A task whose prompt was never written (its flow is still waiting
    // for the context's queue head or a quiet session) has no daemon
    // work to withdraw: the registry settles it directly, and the flow's
    // write claim observes the terminal task under the same guard.
    // The acceptance's verdict claim carries the settle's verdict to
    // this arm's capture: the settle captures the task's final
    // snapshot into the claim under the same lock that advances the
    // terminal retention window, so the reply below reads the cancel's
    // own CANCELED whether the window keeps the row or has already
    // pruned it.
    let undispatched = {
        let mut guard = state.lock().await;
        guard.registry.settle_undispatched(&params.id)
    };
    match undispatched {
        super::task::UndispatchedCancel::Settled => {
            let settled = bare_reply(state, &claim, &id, &params.id).await;
            detach_task_context_if_idle(link, state, &params.id).await;
            return Dispatch::Reply(settled);
        }
        super::task::UndispatchedCancel::Terminal => {
            return Dispatch::Reply(jsonrpc::a2a_error_response(
                &id,
                A2aError::TaskNotCancelable,
                Some(&json!({ "taskId": params.id })),
            ));
        }
        super::task::UndispatchedCancel::Unknown => {
            return Dispatch::Reply(jsonrpc::a2a_error_response(
                &id,
                A2aError::TaskNotFound,
                Some(&json!({ "taskId": params.id })),
            ));
        }
        // The prompt is written or being written: the daemon's cancel
        // ladder owns the task.
        super::task::UndispatchedCancel::HandedOff => {}
    }
    // An acknowledged task whose detached flow has not written its
    // prompt yet would answer `unknown` at the daemon; the cancel
    // waits for the dispatch handoff (bounded), so the cancel reaches
    // a registered admission instead of a refusal. The dispatch state
    // reads under one guard; the wait parks on the cloned notify
    // holding NO guard — the pump, the send flows, and every other
    // request keep running while it waits (an `if let` on the locked
    // read would hold the guard across the wait: bind it first).
    let dispatch_state = state
        .lock()
        .await
        .registry
        .prompt_dispatch_state(&params.id);
    if let Some((false, notify)) = dispatch_state {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), notify.notified()).await;
    }
    if state
        .lock()
        .await
        .registry
        .task(&params.id)
        .is_none_or(|task| task.state().is_terminal())
    {
        // The flow failed before dispatch and settled the task; the
        // spec's terminal refusal is the honest answer.
        return Dispatch::Reply(jsonrpc::a2a_error_response(
            &id,
            A2aError::TaskNotCancelable,
            Some(&json!({ "taskId": params.id })),
        ));
    }
    // Watching the stream while cancelling: the terminal frame (the
    // settle's status update) answers the spec's "updated Task with
    // cancellation status" once the withdraw or abort lands.
    let mut stream = {
        let mut guard = state.lock().await;
        match guard.registry.subscribe(&params.id) {
            Some(stream) => stream,
            None => {
                // The task settled between the terminal check and the
                // subscription: the spec's terminal refusal.
                return Dispatch::Reply(jsonrpc::a2a_error_response(
                    &id,
                    A2aError::TaskNotCancelable,
                    Some(&json!({ "taskId": params.id })),
                ));
            }
        }
    };
    // A task the registry already knows owes work (its response settled
    // into the awaiting-completion state) has no admission for the
    // ladder to find: the 2 s unknown-retry would only burn the cancel's
    // window against the owed run's own settle. The sweep path owns it
    // at once.
    let owed_already = state
        .lock()
        .await
        .registry
        .task(&params.id)
        .is_some_and(super::task::TaskEntry::awaiting_completion);
    // The task's delivery identity (the unique admission id its prompt
    // carried): the ladder resolves THAT admission in the supervisor's
    // registry — the public task id names the task to A2A clients only,
    // and another daemon connection may send the same id as its own
    // admission.
    let delivery_id = {
        let guard = state.lock().await;
        guard
            .registry
            .task(&params.id)
            .map(|task| task.delivery_id().to_string())
    };
    let cancelled = if owed_already {
        None
    } else {
        // The ladder's pending authority opens under the same guard,
        // BEFORE the dispatch: the worker aborts the running turn
        // before the ladder's `owned` response travels, so the task's
        // own success response and completion barrier can settle while
        // the receipt is still in flight — the completion settle parks
        // its verdict behind the authority, and the ladder's response
        // resolves it (`owned` publishes the stop the client asked
        // for; a refusal publishes what the task's own run produced).
        state.lock().await.registry.mark_ladder_inflight(&params.id);
        // The ladder resolves OUTSIDE this request future: hyper
        // drops the handler at the client's EOF, and an exchange
        // awaited inline would leak the pending authority — the
        // parked verdict would never publish, wedging the task at its
        // context's queue head. The detached task owns the retried
        // exchange AND the authority's resolve; this reply only
        // awaits its answer.
        let (outcome_tx, outcome_rx) = tokio::sync::oneshot::channel();
        {
            let link = Arc::clone(link);
            let state = Arc::clone(state);
            let session_id = session_id.clone();
            // A vanished task's `None` sends no admission: the ladder
            // answers `unknown` and the loop's honest refusal settles
            // below.
            let admission_id = delivery_id.clone().unwrap_or_default();
            let task_id = params.id.clone();
            tokio::spawn(async move {
                // The daemon cancel, retried while the supervisor's
                // concurrent dispatch has not registered the admission
                // yet (its own response is the readiness signal; the
                // bound is a liveness guard).
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                let mut outcome = None;
                loop {
                    let response = link
                        .request(DaemonCommand::CancelPromptAdmission {
                            id: None,
                            active_session_id: session_id.clone(),
                            admission_id: admission_id.clone(),
                            cancel_owned: Some(true),
                            rest: Map::default(),
                        })
                        .await;
                    match response {
                        Ok(response) => {
                            let status = response
                                .data
                                .as_ref()
                                .and_then(|data| data.get("status"))
                                .and_then(Value::as_str)
                                .unwrap_or("unknown")
                                .to_string();
                            if status != "unknown" {
                                outcome = Some(Ok(response));
                                break;
                            }
                        }
                        Err(error) => {
                            outcome = Some(Err(error));
                            break;
                        }
                    }
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                    if state
                        .lock()
                        .await
                        .registry
                        .task(&task_id)
                        .is_some_and(|task| task.state().is_terminal())
                    {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                match &outcome {
                    Some(Ok(response)) if response.success => {
                        let status = response
                            .data
                            .as_ref()
                            .and_then(|data| data.get("status"))
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        if status == "cancelled" {
                            // The withdrawal really happened: the
                            // registry settles the CANCELED the client
                            // asked for as the FIRST terminal verdict,
                            // and the claim-aware reply below carries
                            // it (see the undispatched arm).
                            state
                                .lock()
                                .await
                                .registry
                                .settle(&task_id, TaskState::Canceled, None);
                        } else if status == "owned" {
                            state.lock().await.registry.resolve_ladder_owned(&task_id);
                        } else {
                            state.lock().await.registry.resolve_ladder_refused(&task_id);
                        }
                    }
                    _ => {
                        state.lock().await.registry.resolve_ladder_refused(&task_id);
                    }
                }
                let _ = outcome_tx.send(outcome);
            });
        }
        outcome_rx.await.ok().flatten()
    };
    match cancelled {
        Some(Ok(response)) if response.success => {
            // The daemon's status vocabulary is "cancelled" (a waiting
            // admission dropped before its route, or a retained
            // admission's owned cancel whose forward reached the
            // worker: the queued deliveries naming it were swept and
            // the running turn aborted). Only that answer settles the
            // registry directly — the withdrawal really happened. An
            // "unknown" settles nothing: a task that survives it was
            // not canceled, and its owed run settles it with the run's
            // own outcome when it closes. The `owned` answer resolved
            // its authority in the detached exchange above (the mark —
            // not the run's settle — owns the verdict); this arm's
            // remaining work is the direct settle's reply.
            let status = response
                .data
                .as_ref()
                .and_then(|data| data.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if status == "cancelled" {
                // The detached exchange settled the CANCELED the
                // client asked for as the FIRST terminal verdict; the
                // acceptance's verdict claim carries it to this
                // capture (see the undispatched arm): the terminal
                // window's prune advances behind other tasks' settles —
                // and behind the daemon receipt this arm arrived from —
                // and the answer carries the cancel's own verdict from
                // the claim, never a fabricated one for a row the
                // window pruned.
                let settled = bare_reply(state, &claim, &id, &params.id).await;
                // The direct settle may have drained the context: an
                // idle context detaches so the daemon's passivation can
                // reclaim its worker.
                detach_task_context_if_idle(link, state, &params.id).await;
                return Dispatch::Reply(settled);
            }
        }
        Some(Ok(response)) => {
            return Dispatch::Reply(jsonrpc::error_response(
                &id,
                jsonrpc::INTERNAL_ERROR,
                &response
                    .error
                    .unwrap_or_else(|| "cancel failed".to_string()),
                None,
            ));
        }
        Some(Err(error)) => {
            return Dispatch::Reply(jsonrpc::error_response(
                &id,
                jsonrpc::INTERNAL_ERROR,
                &error.to_string(),
                None,
            ));
        }
        None => {
            // The admission ladder has no handle: the prompt's admission
            // cleared at its settle. A task waiting out the daemon's
            // autonomous continuation reaches here (`awaiting_completion`:
            // the supervisor no longer holds the admission, but the run
            // the task waits on is the session's own — the minted
            // continuation carries the task's client id, so the
            // withdraw below sweeps the queued rows and aborts the
            // running turn, and its loop stop pauses the goal and drops
            // the owed autonomous deferral, so the loop cannot re-mint
            // the canceled task another turn behind the unsettled
            // children). The owed state is
            // frame-ordered at the pump but can race this cancel (the
            // task's response still in flight): observe it bounded
            // before refusing — a spurious refusal would make a
            // cancelable task look terminal-canceled.
            let observe_deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
            let owed = loop {
                let awaiting = state
                    .lock()
                    .await
                    .registry
                    .task(&params.id)
                    .is_some_and(super::task::TaskEntry::awaiting_completion);
                if awaiting {
                    break true;
                }
                if std::time::Instant::now() >= observe_deadline {
                    break false;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            };
            if !owed {
                // No handle and nothing owed: the task is publicly
                // acknowledged but the daemon has no cancel for it.
                return Dispatch::Reply(jsonrpc::a2a_error_response(
                    &id,
                    A2aError::TaskNotCancelable,
                    Some(&json!({ "taskId": params.id })),
                ));
            }
            // The session-level withdraw is identity-scoped, never a
            // clear: every delivery this conversation named carries the
            // task's delivery id — the unique admission id the A2A
            // server mints per task and its prompt carries on the wire
            // (the engine's minted continuations carry it too, stamped
            // from the owning turn at their mint) — so
            // `withdraw_admission` takes exactly the task's own queued
            // rows and aborts the turn running its own delivery:
            // another client's rows (its own admissions, its plain
            // prompts, a TUI user's) survive untouched, attached or
            // not, queued or running — even one that reuses the task's
            // public id, whose delivery id this conversation never
            // named. The session file survives either way; the next
            // send re-hosts the conversation through the re-open.
            //
            // The withdrawal's in-flight mark opens under the same
            // guard, BEFORE the dispatch: the run the withdraw aborts
            // can close while the receipt is still in flight, and the
            // completion settle that follows parks its verdict behind
            // the mark. The receipt resolves it: an accepted withdrawal
            // settles the CANCELED the client asked for as the FIRST
            // terminal verdict; a refused one publishes the parked
            // completion (or failure) the task's own run produced. A
            // terminal task keeps its first verdict.
            let delivery = {
                let guard = state.lock().await;
                guard
                    .registry
                    .task(&params.id)
                    .map(|task| task.delivery_id().to_string())
            };
            let Some(delivery) = delivery else {
                return Dispatch::Reply(jsonrpc::a2a_error_response(
                    &id,
                    A2aError::TaskNotCancelable,
                    Some(&json!({ "taskId": params.id })),
                ));
            };
            state
                .lock()
                .await
                .registry
                .mark_withdraw_inflight(&params.id);
            // The withdrawal resolves OUTSIDE this request future: hyper
            // drops the handler at the client's EOF, and a dispatch
            // awaited inline would leak the in-flight count — the
            // parked verdict would never publish, and the task would
            // wedge its context's queue head with every later send on
            // the conversation waiting behind it. The detached task
            // owns the dispatch AND the count's close; this reply only
            // awaits its answer.
            let (receipt_tx, receipt_rx) = tokio::sync::oneshot::channel();
            {
                let link = Arc::clone(link);
                let state = Arc::clone(state);
                let session_id = session_id.clone();
                let task_id = params.id.clone();
                tokio::spawn(async move {
                    let receipt = match link
                        .request(DaemonCommand::WithdrawAdmission {
                            id: None,
                            active_session_id: session_id,
                            admission_id: delivery,
                            rest: Map::default(),
                        })
                        .await
                    {
                        // The client's cancel of its own awaiting
                        // task settles CANCELED on every successful
                        // withdrawal — the main/TS abort contract: the
                        // sweep and the abort are the stop's daemon-side
                        // arms, and whatever the delivery still drives
                        // when they name nothing (an unsettled child's
                        // notice turn, a mid-flight continuation mint)
                        // runs on uncredited — its frames resolve
                        // Foreign against the settled task, never a
                        // verdict revision. A failed receipt (the
                        // worker refused the withdrawal) is the honest
                        // refusal below, never a fabricated CANCELED.
                        Ok(response) => Ok(response.success),
                        // The dispatch failed before the daemon
                        // answered: the receipt closes the in-flight
                        // count with no withdrawal verdict, publishing
                        // whatever the completion settle parked behind
                        // it, and the task keeps its own course.
                        Err(error) => Err(error.to_string()),
                    };
                    // The receipt resolves the withdrawal's authority:
                    // an accepted withdrawal settles the CANCELED the
                    // client asked for as the FIRST terminal verdict —
                    // at once, whatever other withdrawals are still in
                    // flight; a refused one releases the parked verdict
                    // (a naturally failed continuation settles FAILED,
                    // a completion the receipt raced settles its own
                    // verdict) — never a fabricated CANCELED behind it.
                    let stopped = receipt.as_ref().copied().unwrap_or(false);
                    state
                        .lock()
                        .await
                        .registry
                        .close_withdraw_inflight(&task_id, stopped);
                    let _ = receipt_tx.send(receipt);
                });
            }
            let stopped = match receipt_rx.await {
                Ok(Ok(stopped)) => stopped,
                Ok(Err(error)) => {
                    return Dispatch::Reply(jsonrpc::error_response(
                        &id,
                        jsonrpc::INTERNAL_ERROR,
                        &error,
                        None,
                    ));
                }
                Err(_) => {
                    return Dispatch::Reply(jsonrpc::error_response(
                        &id,
                        jsonrpc::INTERNAL_ERROR,
                        "the withdrawal's detached dispatch ended without a receipt",
                        None,
                    ));
                }
            };
            if !stopped {
                // The worker refused the withdrawal (the session it
                // addressed is gone, the request malformed): the spec's
                // honest refusal. The receipt's in-flight close already
                // published whatever the task's own run parked behind
                // the mark, so the refusal never strands a verdict.
                return Dispatch::Reply(jsonrpc::a2a_error_response(
                    &id,
                    A2aError::TaskNotCancelable,
                    Some(&json!({ "taskId": params.id })),
                ));
            }
            // The withdraw settled the conversation's own queued
            // flows on the withdrawn contract and aborted its running
            // delivery: the receipt's close published the task's CANCELED
            // as the FIRST terminal verdict. The acceptance's verdict
            // claim carries the settle's verdict to this capture (see
            // the undispatched arm): the terminal window's prune
            // advances behind other tasks' settles — and behind the
            // withdrawal receipt this arm arrived from — and the
            // answer carries the cancel's own verdict from the claim,
            // never a fabricated one.
            let settled = bare_reply(state, &claim, &id, &params.id).await;
            detach_task_context_if_idle(link, state, &params.id).await;
            return Dispatch::Reply(settled);
        }
    }
    // Await the terminal frame, bounded by the abort settle window
    // (the worker's abort path is prompt; the bound is a liveness
    // guard, not a correctness timer). A liveness expiry answers the
    // task's live snapshot — the abort was accepted; a proved
    // terminal refusal it is not. The acceptance's verdict claim spans
    // this wait and its reply alike: the task's settle can land while
    // this cancel is parked — or while the ladder's receipt was still
    // in flight — and the reply reads the task's own verdict from the
    // claim once the window advanced past it, never a fabricated one.
    let _settled = wait_settled(&mut stream).await;
    Dispatch::Reply(bare_reply(state, &claim, &id, &params.id).await)
}

/// Resume the session's parked queued input before a wait that must
/// observe a quiet session: a post-abort `queued_input_suspended`
/// session parks every queue-visible row (the runner never drains a
/// suspended lane), so an idle wait that only waits would hold forever
/// with a parked row in front of it — the prompt's own resume (a
/// streaming behavior, the ACP contract) never reaches its write past
/// that wait. The resume is DETACHED, and the waits it precedes
/// re-issue it on the [`PARKED_QUEUE_RECHECK`] cadence: its response
/// must never sit in front of the wait's own races (a cancel settling
/// the task must answer at once, not behind the resume's receipt), and
/// a foreign abort that lands MID-WAIT re-parks the queue behind a
/// fresh suspension the one pre-wait resume can no longer clear — the
/// cadence's re-issue unwedges the wait at its next tick. The command
/// is idempotent — an un-suspended or empty session answers its no-op
/// failure, which this flow ignores: only the resume's side effect
/// matters here.
async fn resume_parked_queue_detached(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    session_id: &str,
) {
    // One outstanding ResumeQueue per session: a cadence tick behind a
    // request the peer has not answered yet sees the marker and skips.
    // The marker clears on the request's actual completion — its
    // response, or the link's close (the untimed exchange below) — and
    // NEVER on a timeout: the link's channel is unbounded, and a
    // timed-out request reclaims only the pending-response slot, never
    // the line the writer still owes the stalled peer, so a timeout
    // would clear the marker while the unsent line sits queued and the
    // next tick would queue one more — one stale ResumeQueue line
    // every timeout, forever. A stalled peer holds exactly one
    // outstanding request instead; a peer that recovers answers it and
    // the cadence resumes.
    if !state
        .lock()
        .await
        .resume_in_flight
        .insert(session_id.to_string())
    {
        return;
    }
    let link = Arc::clone(link);
    let state = Arc::clone(state);
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        let _ = link
            .request_until_close(DaemonCommand::ResumeQueue {
                id: None,
                active_session_id: session_id.clone(),
                rest: Map::default(),
            })
            .await;
        state.lock().await.resume_in_flight.remove(&session_id);
    });
}

/// The bounded settle watch (the cancel flow's liveness guard): `true`
/// only when the terminal frame arrived within the bound.
async fn wait_settled(stream: &mut StreamReceiver<StreamResponse>) -> bool {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while let Some(frame) = stream.recv().await {
            if let StreamResponse::StatusUpdate(event) = &frame {
                if event.status.state.is_terminal() {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

/// One `SubscribeToTask` (spec 3.1.6): join the live stream of an
/// unsettled task — the task snapshot wrapped in the stream response
/// oneof first (`StreamResponse::Task`, spec 3.2.3/9.4.2 — the same
/// first frame `SendStreamingMessage` answers, never a bare `Task`
/// result a conforming client cannot read), the terminal frame closing
/// the stream.
async fn subscribe_to_task(state: &Arc<Mutex<A2aState>>, id: Value, params: Value) -> Dispatch {
    let params = match serde_json::from_value::<GetTaskParams>(params) {
        Ok(params) => params,
        Err(error) => {
            return Dispatch::Reply(jsonrpc::invalid_params_response(
                &id,
                "params",
                &error.to_string(),
            ));
        }
    };
    let mut guard = state.lock().await;
    let terminal = guard
        .registry
        .task(&params.id)
        .is_some_and(|task| task.state().is_terminal());
    if terminal {
        return Dispatch::Reply(jsonrpc::a2a_error_response(
            &id,
            A2aError::UnsupportedOperation,
            Some(&json!({ "reason": "the task is in a terminal state" })),
        ));
    }
    let Some((snapshot, stream)) = guard
        .registry
        .subscribe_with_snapshot(&params.id, params.history_length)
    else {
        return Dispatch::Reply(jsonrpc::a2a_error_response(
            &id,
            A2aError::TaskNotFound,
            Some(&json!({ "taskId": params.id })),
        ));
    };
    Dispatch::Stream(id.clone(), stream_first_frame(&id, &snapshot), stream)
}

/// The first SSE frame's JSON-RPC envelope: the task snapshot wrapped
/// in the stream payload's oneof member (`StreamResponse`'s `task`,
/// spec 3.2.3/9.4.2 — every streaming data frame carries exactly one
/// of the oneof members; a bare `Task` shape makes a conforming client
/// lose the task id and strict `ProtoJSON` reject the frame). `GetTask`
/// and `CancelTask` keep the bare `Task` result the spec's method
/// table declares.
fn stream_first_frame(id: &Value, snapshot: &super::types::Task) -> Value {
    jsonrpc::response(
        id,
        &serde_json::to_value(StreamResponse::Task(snapshot.clone())).unwrap_or(Value::Null),
    )
}

/// The settle verdict of one daemon response: success completes, the
/// cancelled-turn wire errors cancel (the daemon's distinct settle
/// strings — an aborted run, a withdrawal before delivery, a queued
/// prompt dropped by an admission cancel, a route refused after its
/// admission was cancelled), any other failure fails the task with the
/// error text as its status message.
fn settle_verdict(response: &DaemonResponse) -> (TaskState, Option<String>) {
    if response.success {
        return (TaskState::Completed, None);
    }
    let error = response
        .error
        .clone()
        .unwrap_or_else(|| "the turn failed".to_string());
    // The typed settle kind is the cancellation's authority: an
    // aborted or withdrawn turn settles CANCELED whatever its wire
    // text (the worker attaches the kind). The supervisor's
    // cancellation-ladder strings below keep the text fallback for
    // the paths that carry no kind; the engine's genuine no-response
    // failure shares the abort's text and is NOT in the set — a real
    // turn failure reads FAILED, never CANCELED (a state that says
    // the client asked for it).
    if response.error_info.as_ref() == Some(&DaemonErrorInfo::PromptSettleCancelled) {
        return (TaskState::Canceled, Some(error));
    }
    let state = if [
        PROMPT_ABORTED_BEFORE_DELIVERY,
        PROMPT_ADMISSION_CANCELLED,
        QUEUED_PROMPT_DELETED,
        // The task's own admission's cancel withdraws its queued prompt
        // (the TS cancel-withdraw text) and the operator's whole-queue
        // clear withdraws it the same way (its own wire text, TS
        // clearQueue's).
        PROMPT_CANCELLED_BEFORE_START,
        QUEUED_PROMPT_CLEARED,
    ]
    .contains(&error.as_str())
    {
        TaskState::Canceled
    } else {
        TaskState::Failed
    };
    (state, Some(error))
}

/// Settle one task from its `PromptAndWait` response.
///
/// The pump's synchronous response step already ran (see
/// `settle_prompt_at_pump`): a task whose turn succeeded stays live
/// there and settles here, after the daemon's autonomous run finished
/// — the blocking reply then reads the task's settled state, and a
/// `CancelTask`'s direct settle ends the wait with the task's own
/// terminal state. The headless-completion wait (with RLM quiescence)
/// holds while a goal driver, a post-compaction continuation, or RLM
/// child follow-ups still owe turns, and the continuation runs credit
/// their windows to the task's artifact on the way (the pump's
/// continuation step, see `events.rs`) — the settle carries the run's
/// whole output, never just the first turn's (the ACP mode waits the
/// same run out through `WaitForHeadlessCompletion`). A failed or
/// degraded wait settles anyway: the task's own turn succeeded, and
/// the completion accounting is best-effort. A turn that produced no
/// assistant text settles with its honest empty artifact: the window
/// claim is the reply authority, and the session-global last answer is
/// never proof of this task's output.
async fn settle_from_response(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    task_id: &str,
    response: DaemonResponse,
) {
    let (state_name, error) = settle_verdict(&response);
    if state_name == TaskState::Completed {
        // The completion wait: the response settled the task's own
        // turn; the run may still owe autonomous turns, so the settle
        // lands after the session reached quiescence. The wait RACES
        // the task's own terminal settle — a concurrent `CancelTask`
        // settles the acknowledged task directly (the withdraw's
        // sweep), and the blocking reply must answer the cancel's
        // snapshot at once instead of parking on the session-wide
        // barrier — the same terminal signal the pre-write idle wait
        // races. A task that settled before this subscribe skips the
        // wait entirely: its first verdict stands.
        let session_id = {
            let guard = state.lock().await;
            guard
                .registry
                .task(task_id)
                .map(|task| task.session_id.clone())
        };
        // The completion barrier's refusal (the typed overload answer):
        // `None` while the wait was refused or never ran, so the tail
        // settles the refusal as the flow's error instead of the
        // completion.
        let mut refused = None;
        if let Some(session_id) = session_id {
            // The completion wait rides the same idle barrier: a
            // post-abort suspension parked mid-run rows would wedge it
            // after the task's own turn already finished — the resume
            // drains them while the wait holds the settle for the
            // task's own continuation turns. Detached, with the same
            // cadence re-issue against a suspension that lands
            // mid-wait (see the pre-write wait's tick arm).
            resume_parked_queue_detached(link, state, &session_id).await;
            let mut settle_stream = {
                let mut guard = state.lock().await;
                guard.registry.subscribe(task_id)
            };
            // The task's delivery id scopes the quiescence barrier to
            // the children THIS task's delivery spawned: the shared
            // session hosts other clients' children too, and a foreign
            // held child never keeps a fully answered task WORKING
            // behind it.
            let delivery_id = {
                let guard = state.lock().await;
                guard.registry.task(task_id).map_or_else(
                    || task_id.to_string(),
                    |task| task.delivery_id().to_string(),
                )
            };
            if let Ok(pending) = link.send_until_close(DaemonCommand::WaitForHeadlessCompletion {
                id: None,
                active_session_id: session_id.clone(),
                wait_for_rlm_quiescence: Some(true),
                admission_id: Some(delivery_id),
                rest: Map::default(),
            }) {
                let completion = pending.wait(link);
                tokio::pin!(completion);
                if let Some(mut stream) = settle_stream.take() {
                    loop {
                        tokio::select! {
                            response = &mut completion => {
                                // A refused barrier is not quiescence:
                                // the worker's typed overload refusal
                                // proves nothing about the run the task
                                // still owes (its children, its
                                // continuations), so the task never
                                // settles COMPLETED behind it — the
                                // refusal is the flow's error, settled
                                // FAILED with its text. A transport
                                // failure (an Err below in the outer
                                // arm) keeps the degraded best-effort
                                // settle: the wait never answered.
                                refused = match response {
                                    Ok(response) if !response.success => Some(
                                        response
                                            .error
                                            .unwrap_or_else(|| "the completion wait was refused".to_string()),
                                    ),
                                    _ => None,
                                };
                                break;
                            }
                            frame = stream.recv() => match frame {
                                Some(StreamResponse::StatusUpdate(event)) if event.status.state.is_terminal() => {
                                    // The task settled meanwhile (a
                                    // cancel): the unread completion
                                    // response clears at the link's
                                    // routing, exactly like a client
                                    // that disconnected.
                                    break;
                                }
                                Some(_) => {}
                                // A closed stream is a subscriber dropped
                                // at the queue bound, never the task's
                                // settle: the wait resubscribes while
                                // the task still lives — a terminal task
                                // (or a retention prune) ends the wait
                                // on its own state instead.
                                None => {
                                    let terminal = {
                                        let guard = state.lock().await;
                                        guard
                                            .registry
                                            .task(task_id)
                                            .is_none_or(|task| task.state().is_terminal())
                                    };
                                    if terminal {
                                        break;
                                    }
                                    match state.lock().await.registry.subscribe(task_id) {
                                        Some(next) => stream = next,
                                        None => break,
                                    }
                                }
                            },
                            // A foreign abort that landed mid-wait
                            // re-parked the queue behind a fresh
                            // suspension: the cadence's detached
                            // re-resume unwedges this barrier exactly
                            // like the pre-write wait's tick arm.
                            () = tokio::time::sleep(PARKED_QUEUE_RECHECK) => {
                                resume_parked_queue_detached(link, state, &session_id).await;
                            }
                        }
                    }
                } else {
                    // The task settled before this subscribe: the
                    // first verdict stands and the wait adds nothing —
                    // the unread completion response clears at the
                    // link's routing, exactly like the raced arm.
                }
            }
        }
        if let Some(refusal) = refused {
            finalize_response_settle(state, task_id, TaskState::Failed, Some(refusal)).await;
            return;
        }
        finalize_response_settle(state, task_id, state_name, error).await;
        return;
    }
    state
        .lock()
        .await
        .registry
        .settle(task_id, state_name, error);
}

/// The settle after the completion wait: a task that settled meanwhile
/// (a concurrent cancel) keeps its first verdict. An autonomous
/// continuation run that failed carries its own reason — the task
/// settles FAILED with the run's outcome, never behind the successful
/// prompt's verdict (the run the task waited on is the task's work).
/// An in-flight cancel authority owns the task's one terminal verdict
/// while it is unresolved — a `CancelTask` withdrawal whose receipt
/// still travels, or a cancel ladder whose `owned` response does: the
/// settle parks its verdict behind the flight instead of publishing,
/// and the authority's receipt resolves it (an accepted withdrawal or
/// the ladder's owned abort settles CANCELED as the first verdict; a
/// refused one publishes the parked verdict, whatever it holds, with
/// the ladder's standing mark applied). No error text is cancellation
/// authority on its own: the engine's genuine no-response failure
/// shares the aborted turn's text, so a refused withdrawal's FAILED
/// stays FAILED and only the receipt (or the cancel ladder's accepted
/// abort, below) settles CANCELED.
async fn finalize_response_settle(
    state: &Arc<Mutex<A2aState>>,
    task_id: &str,
    state_name: TaskState,
    error: Option<String>,
) {
    let continuation_error = state.lock().await.registry.take_continuation_error(task_id);
    let mut guard = state.lock().await;
    if guard
        .registry
        .task(task_id)
        .is_some_and(|task| task.state().is_terminal())
    {
        return;
    }
    let (state_name, error) = match continuation_error {
        Some(reason) => (TaskState::Failed, Some(reason)),
        None => (state_name, error),
    };
    if guard.registry.withdraw_inflight(task_id) || guard.registry.ladder_inflight(task_id) {
        guard
            .registry
            .park_deferred_verdict(task_id, state_name, error);
        return;
    }
    // The cancel ladder's accepted running-turn abort: the abort can end
    // the engine's tool phase with a success outcome, and the stop the
    // client asked for is the verdict — CANCELED, whatever partial
    // artifact the aborted turn produced.
    let (state_name, error) =
        if state_name == TaskState::Completed && guard.registry.cancel_abort_marked(task_id) {
            (TaskState::Canceled, None)
        } else {
            (state_name, error)
        };
    guard.registry.settle(task_id, state_name, error);
}

/// One reply's claimed truth: the task's own snapshot — the registry's
/// row while the retention window keeps it, the verdict claim's
/// captured snapshot once the window advanced past it (the settle
/// filled the claim under the prune's own lock, so one or the other
/// always answers). A reply never fabricates a verdict for a task it
/// served.
async fn claimed_task_snapshot(
    state: &Arc<Mutex<A2aState>>,
    claim: &super::task::VerdictClaim,
    task_id: &str,
) -> Value {
    let snapshot = {
        let guard = state.lock().await;
        guard
            .registry
            .snapshot(task_id, claim.history_length())
            .or_else(|| claim.captured())
            .expect("the settle filled the claim under the prune's own lock")
    };
    serde_json::to_value(snapshot).unwrap_or(Value::Null)
}

/// The reply of one served task: the JSON-RPC success envelope with the
/// task's claimed snapshot (`SendMessageResponse` carries the task,
/// spec 9.4.1).
async fn send_reply(
    state: &Arc<Mutex<A2aState>>,
    claim: &super::task::VerdictClaim,
    id: &Value,
    task_id: &str,
) -> Value {
    let snapshot = claimed_task_snapshot(state, claim, task_id).await;
    jsonrpc::response(id, &json!({ "task": snapshot }))
}

/// The reply of one cancelled task: the JSON-RPC success envelope with
/// the bare `Task` result (`CancelTask` returns the task itself, spec
/// 9.4.1 — not the `SendMessageResponse` wrapper the sends answer
/// with).
async fn bare_reply(
    state: &Arc<Mutex<A2aState>>,
    claim: &super::task::VerdictClaim,
    id: &Value,
    task_id: &str,
) -> Value {
    let snapshot = claimed_task_snapshot(state, claim, task_id).await;
    jsonrpc::response(id, &snapshot)
}

/// The daemon link's attach for one context session: the context's
/// creation attaches by its fresh active id, and a re-attach (see
/// [`ensure_attached`]) carries the same shape addressed at the
/// context's durable selector — a session persisting on disk
/// re-hosts on attach, whatever became of the worker the create-time
/// active id named.
fn attach_request(session_id: String) -> DaemonCommand {
    DaemonCommand::Attach {
        id: None,
        active_session_id: session_id,
        client_id: None,
        capabilities: None,
        resume_cursor: None,
        telemetry_disabled: None,
        recovery_config: None,
        env: None,
        launch_env: None,
        rest: Map::default(),
    }
}

/// A context's session must be attached before the flow writes to it.
/// A context with a session file RE-OPENS it: the mode's own create
/// template re-addressed at the conversation's file revives the
/// worker over its durable config — the engine, provider, model and
/// launch env of the conversation that created it (the daemon's
/// generic wake of a passivated file would revive with a bare
/// cwd-only config, ending the conversation's engine mid-flight) —
/// while a live worker is reused unchanged; the answered active id
/// re-keys the context binding so the pump's event routing and every
/// later command address the live worker. A client-owned context
/// (`--no-session`, no file — its worker never passivates) re-attaches
/// through its durable selector directly. A re-attach waits out an
/// in-flight detach first, so the daemon sees Detach before the
/// re-open's Attach — never the reverse (a reversed pair would drop
/// the fresh attachment). One attach round runs per detached
/// context: the first caller owns it, and a concurrent caller (a send
/// admitted behind a canceled head) waits it out and joins its verdict
/// instead of treating the in-flight attach as already standing — the
/// daemon subscribes this client only once the attach answers, so a
/// successor that wrote its prompt first would run on a worker its
/// frames never reach. The `attached` mark publishes only on success,
/// and a failed round retires its slot so a later send retries.
async fn ensure_attached(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    context_id: &str,
) -> Result<(), String> {
    let (session, round) = {
        let mut guard = state.lock().await;
        if guard.attached.contains(context_id) {
            return Ok(());
        }
        let Some(session) = guard.contexts.get(context_id).cloned() else {
            return Ok(());
        };
        let round = guard
            .attaching
            .entry(context_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
            .clone();
        guard.touch_context(context_id);
        (session, round)
    };
    let mut verdict = round.lock().await;
    if let Some(recorded) = verdict.clone() {
        // A concurrent caller's round already answered: join its verdict.
        return recorded;
    }
    let result: Result<(), String> = async {
        // The round's owner waits out an in-flight detach before its
        // attach: the daemon sees Detach before Attach, never the
        // reverse. The receiver comes out under a short guard, then
        // waits with NO guard held: an `if let` on the locked read
        // would hold A2aState across the await, and the sole frame
        // pump — the only reader that can deliver the Detach receipt
        // (any session event queued ahead of it takes the same guard)
        // — would block on this round until the 30-second request
        // timeout, stalling the whole server.
        let detach = state.lock().await.detaching.remove(context_id);
        if let Some(detach) = detach {
            let _ = detach.await;
        }
        let mut attach_selector = session.durable_id.clone();
        if let Some(file) = &session.session_file {
            // The re-open: the create template over the conversation's file
            // (no name — the file keeps its own; the fresh-name row belongs
            // to a fresh session).
            let reopened = {
                let guard = state.lock().await;
                let mut create = guard.create.clone();
                if let DaemonCommand::Create {
                    session_path, name, ..
                } = &mut create
                {
                    *session_path = Some(file.clone());
                    *name = None;
                }
                create
            };
            let reopened = match link.request(reopened).await {
                Ok(response) => response,
                Err(error) => return Err(error.to_string()),
            };
            if !reopened.success {
                return Err(reopened
                    .error
                    .unwrap_or_else(|| "session re-open failed".to_string()));
            }
            rekey_context_session(state, context_id, &reopened).await;
            // The attach binds the client to the live worker the re-open
            // answered (the create-time id may be stale).
            attach_selector = state
                .lock()
                .await
                .contexts
                .get(context_id)
                .map(|binding| binding.active_id.clone())
                .unwrap_or(session.durable_id.clone());
        }
        let attached = match link.request(attach_request(attach_selector)).await {
            Ok(response) => response,
            Err(error) => return Err(error.to_string()),
        };
        if !attached.success {
            return Err(attached
                .error
                .unwrap_or_else(|| "session attach failed".to_string()));
        }
        rekey_context_session(state, context_id, &attached).await;
        Ok(())
    }
    .await;
    // Publish the attachment and retire the round's slot under one
    // guard — a caller arriving between the two would start a
    // duplicate round against an attached context — then hand the
    // round's waiting callers the same verdict. The reclamation
    // defers to an in-flight round (see [`evict_one_idle_context`]),
    // so the binding cannot leave the table while the round runs; the
    // guard still refuses a mark for a context that no longer exists.
    // A failed round publishes no mark, so a later send retries.
    {
        let mut guard = state.lock().await;
        if result.is_ok() && guard.contexts.contains_key(context_id) {
            guard.attached.insert(context_id.to_string());
        }
        guard.attaching.remove(context_id);
    }
    *verdict = Some(result.clone());
    result
}

/// Re-key a context's session binding from a re-open or attach answer:
/// a re-host (a passivated session revived over its file) answers the
/// fresh worker's active id, and the events' routing plus every later
/// command must address it — the previous id names nothing anymore.
async fn rekey_context_session(
    state: &Arc<Mutex<A2aState>>,
    context_id: &str,
    attached: &DaemonResponse,
) {
    let answered = attached
        .data
        .as_ref()
        .and_then(|data| data.get("activeSessionId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if answered.is_empty() {
        return;
    }
    let mut guard = state.lock().await;
    let Some(previous) = guard
        .contexts
        .get(context_id)
        .map(|session| session.active_id.clone())
    else {
        return;
    };
    if previous == answered {
        return;
    }
    guard.sessions.remove(&previous);
    // The abandoned id's turn-window and run entries go with the
    // re-key (the same removal `on_session_binding` runs for the
    // pump-side re-key): the frames route under the fresh id from here
    // on, so the old entries are unreachable — a response-driven
    // re-key of an idle-detached context never sees the binding
    // notification that would clean them, and every re-open would
    // leave another parked window behind.
    guard.windows.remove(&previous);
    guard.runs.drop_session(&previous);
    guard
        .sessions
        .insert(answered.clone(), context_id.to_string());
    if let Some(session) = guard.contexts.get_mut(context_id) {
        session.active_id = answered;
    }
}

/// The idle detach: once a context's task queue has drained (its last
/// task settled — the registry's queues hold every unsettled id), the
/// A2A client detaches from its session so the daemon's idle
/// passivation can reclaim the worker (an attached session never
/// passivates — the worker's eviction gate). The next send on the
/// context re-attaches ([`ensure_attached`]); the session itself stays
/// resident on disk. No-op for a context with a live task or one
/// already detached.
///
/// Callers are the request and flow paths — never the frame pump: the
/// pump is the link's only frame reader, so a `link::request` awaited
/// inside it self-blocks until the request's own timeout (the response
/// sits in the frame channel the pump would have to read). The flow
/// that owns a settled task reaches its tail detach on its own task.
async fn detach_context_if_idle(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    context_id: &str,
) {
    let (session_id, done) = {
        let mut guard = state.lock().await;
        if guard.registry.head(context_id).is_some() {
            return;
        }
        if !guard.attached.remove(context_id) {
            return;
        }
        let Some(session_id) = guard
            .contexts
            .get(context_id)
            .map(|session| session.active_id.clone())
        else {
            return;
        };
        let (done, detach) = oneshot::channel();
        guard.detaching.insert(context_id.to_string(), detach);
        (session_id, done)
    };
    let _ = link
        .request(DaemonCommand::Detach {
            id: None,
            active_session_id: Some(session_id),
            rest: Map::default(),
        })
        .await;
    let _ = done.send(());
}

/// The idle detach through a task's id (the cancel paths know only
/// the task; a send flow cleans up through its own context identity).
async fn detach_task_context_if_idle(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    task_id: &str,
) {
    let context_id = state
        .lock()
        .await
        .registry
        .task(task_id)
        .map(|task| task.context_id.clone());
    let Some(context_id) = context_id else {
        return;
    };
    detach_context_if_idle(link, state, &context_id).await;
}

/// Create one new conversation context: a daemon session created and
/// attached on the mode's create template, named by the context so the
/// session lists read honestly. The context keeps the session's
/// durable selector (the session-file stem): the worker's idle
/// passivation can end the session, and the next send re-attaches
/// through it. The live-context bound's eviction is different — it
/// removes the context's binding outright, so a send naming the
/// evicted context answers the unknown-contextId error.
///
/// The live-context bound: a full table evicts the least recently used
/// IDLE context — its worker stops, its session file and its tasks
/// stay queryable — and a table with no idle context refuses the new
/// conversation: the server's worker count stays a function of its
/// conversation table, never the request rate.
async fn create_context(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
) -> Result<(String, ContextSession, String), String> {
    let context_id = uuid::Uuid::new_v4().to_string();
    // The capacity reservation and the create template build under one
    // guard: the in-flight count holds one slot from here to the flow's
    // atomic insertion (or this path's failure release), so concurrent
    // new conversations cannot all observe the same free slot and
    // overshoot the bound.
    let mut guard = state.lock().await;
    guard.creating += 1;
    let at_bound = guard.contexts.len() + guard.creating > guard.max_contexts;
    let mut create = guard.create.clone();
    if let DaemonCommand::Create { name, .. } = &mut create {
        *name = Some(format!("a2a-{}", &context_id[..8]));
    }
    drop(guard);
    if at_bound {
        // The table is at the bound: reclaim one idle context, else
        // refuse (the reservation releases with the refusal, never
        // before — a creator that released and still proceeded would
        // overshoot the bound past its own uncounted create).
        if !evict_one_idle_context(link, state).await {
            let mut guard = state.lock().await;
            if guard.contexts.len() + guard.creating > guard.max_contexts {
                guard.creating -= 1;
                return Err(
                    "the A2A server's live context table is full; retry once a running task completes"
                        .to_string(),
                );
            }
        }
    }
    match create_session_binding(link, state, create).await {
        Ok((binding, active_session_id)) => Ok((context_id, binding, active_session_id)),
        Err(error) => {
            // Every failure path releases the reservation: the slot
            // never leaks past the failed conversation.
            let mut guard = state.lock().await;
            guard.creating = guard.creating.saturating_sub(1);
            Err(error)
        }
    }
}

/// The daemon create and attach of one new conversation (the reserved
/// half of [`create_context`]): the answered binding, with the created
/// active id. The context is NOT registered here — the send flow
/// registers it and admits its first task under one guard.
async fn create_session_binding(
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<A2aState>>,
    create: DaemonCommand,
) -> Result<(ContextSession, String), String> {
    let created = link
        .request(create)
        .await
        .map_err(|error| error.to_string())?;
    if !created.success {
        return Err(created
            .error
            .unwrap_or_else(|| "session create failed".to_string()));
    }
    let summary = created.data.as_ref();
    let active_session_id = summary
        .and_then(|summary| summary.get("activeSessionId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if active_session_id.is_empty() {
        return Err("the created session carries no id".to_string());
    }
    // The durable identity: the session file — its stem is the id that
    // survives the worker (the file is the identity the daemon re-hosts)
    // and its path is the re-open's address — falling back to the
    // create-time active id when the summary carries no file. A
    // client-owned context answers an EMPTY file (`--no-session`): it
    // carries none, or its re-attach would re-open a pathed create
    // over a client-owned session the daemon refuses.
    let (durable_id, session_file) = summary
        .and_then(|summary| summary.get("sessionFile"))
        .and_then(Value::as_str)
        .filter(|file| !file.is_empty())
        .map(PathBuf::from)
        .map_or_else(
            || (active_session_id.clone(), None),
            |file| {
                (
                    file.file_stem().map_or_else(
                        || active_session_id.clone(),
                        |stem| stem.to_string_lossy().to_string(),
                    ),
                    Some(file.display().to_string()),
                )
            },
        );
    let attached = link
        .request(attach_request(active_session_id.clone()))
        .await
        .map_err(|error| error.to_string())?;
    if !attached.success {
        // A failed attach releases the created session the way the ACP
        // mode's EOF teardown does.
        if state.lock().await.client_owned {
            let _ = link
                .request(DaemonCommand::CompleteOwnedSession {
                    id: None,
                    active_session_id: active_session_id.clone(),
                    rest: Map::default(),
                })
                .await;
        }
        return Err(attached
            .error
            .unwrap_or_else(|| "session attach failed".to_string()));
    }
    Ok((
        ContextSession {
            active_id: active_session_id.clone(),
            durable_id,
            session_file,
        },
        active_session_id,
    ))
}

/// The minted token file's name prefix: one file per bound address
/// (`a2a-token-<port>-<address>` in the agent dir, the IP in
/// filename-safe form). The file leaves at the mode's own exits (see
/// `run_daemon_attached_a2a_mode`), so the agent dir's minted set
/// stays bounded by the distinct binds a server can hold at once — a
/// hard kill (SIGKILL) can still orphan the one file it never got to
/// remove.
const A2A_TOKEN_FILE_PREFIX: &str = "a2a-token";

/// Write the minted token file owner-only (the agent dir is created
/// private when missing): the open itself carries the private mode —
/// no world-readable window — and any failure is the caller's error
/// (a token nobody can read serves every task route a 401).
fn write_minted_token_file(path: &Path, token: &str) -> anyhow::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        pa_core::platform::perms::create_dir_all_private(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    pa_core::platform::perms::set_private_mode(&mut options);
    let mut file = options.open(path)?;
    file.write_all(format!("{token}\n").as_bytes())?;
    file.flush()?;
    pa_core::platform::perms::restrict_open_file(&file)?;
    Ok(())
}

/// The live session row the daemon serves for one active id (`list`'s
/// resident summary): the streaming flag and the attached-client count
/// — the daemon's own answers for whether the session holds work and
/// who else is attached. `None` when the daemon answers no row (a
/// passivated worker: nothing to gate).
async fn session_row(link: &Arc<DaemonLink>, active_session_id: &str) -> Option<Value> {
    let list = link
        .request(DaemonCommand::List {
            id: None,
            all: None,
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: Map::default(),
        })
        .await
        .ok()?;
    list.data?
        .get("sessions")?
        .as_array()?
        .iter()
        .find(|row| row.get("activeSessionId").and_then(Value::as_str) == Some(active_session_id))
        .cloned()
}

/// Evict one idle LRU context for a new conversation (the live-context
/// bound's reclamation): the local task queue is not the session's
/// whole life — another daemon client may hold work on the same session
/// (a TUI user, a foreign prompt, a `follow_up`) — so the idle check
/// and the stop are ONE worker-owned decision (`kill_if_idle`): a
/// session holding a turn or queued work refuses the kill, however it
/// got there after any earlier row was read. The row read stays only
/// as a cheap pre-filter (a streaming row names work the worker would
/// refuse anyway); the next idle candidate is tried on a refusal, and a
/// table with no quiet idle context refuses the new conversation.
/// `false` answers a table with nothing to reclaim.
async fn evict_one_idle_context(link: &Arc<DaemonLink>, state: &Arc<Mutex<A2aState>>) -> bool {
    // The idle candidates in LRU order, read once under the guard (the
    // daemon row reads below hold no lock).
    let candidates: Vec<(String, String)> = {
        let guard = state.lock().await;
        let mut contexts: Vec<(&String, &u64)> = guard
            .context_use
            .iter()
            .filter(|(context, _)| guard.registry.head(context).is_none())
            .collect();
        contexts.sort_by_key(|(_, used)| **used);
        contexts
            .into_iter()
            .filter_map(|(context, _)| {
                guard
                    .contexts
                    .get(context)
                    .map(|session| (context.clone(), session.active_id.clone()))
            })
            .collect()
    };
    for (context, active_session_id) in candidates {
        // The cheap pre-filter, never the decision: a row reporting
        // streaming (any client's turn) names a session the worker
        // would refuse anyway. The attached-client count is the
        // pre-filter's weak half — the link's own Detach below leaves
        // only foreign observers counted, so a quiet row with one
        // observer passes here and the worker's own attached-client
        // refusal (the one decision that cannot be invalidated by a
        // client acting between the read and the stop) keeps the
        // session and answers the next idle candidate. A row that
        // fails to load (a passivated worker, a lost response)
        // decides nothing.
        if session_row(link, &active_session_id)
            .await
            .is_some_and(|row| {
                row.get("isStreaming")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
        {
            continue;
        }
        // The reservation: the reclamation owns the candidate from the
        // state guard on — the same guard the send's admission holds,
        // with the head re-check — so no send admits a task against
        // the binding the stop below closes (a send that named the
        // context while the candidate read ran has its head task
        // answered here; a send that arrives next waits the stop out
        // and re-validates). A candidate another reclamation already
        // owns is skipped, never fought over — and so is a candidate
        // whose re-attach round is still in flight: the round re-opens
        // the session and attaches the worker it answers, and a stop
        // that removed the binding mid-round would strand that late
        // attachment with no binding left to name it. The round
        // registers and retires its slot under the same guard, so the
        // check never misses a round; the reclamation takes the context
        // at its next pass once the round settled.
        let (held, active_session_id) = {
            let mut guard = state.lock().await;
            if guard.registry.head(&context).is_some() {
                continue;
            }
            if guard.closing.contains_key(&context) {
                continue;
            }
            if guard.attaching.contains_key(&context) {
                continue;
            }
            // The binding revalidated under the reservation's own
            // guard: a re-open that finished while the row read ran
            // retires its attaching slot and re-keys the binding to a
            // fresh worker — the stop and the cleanup below name the
            // binding the table holds NOW, never the pre-read
            // snapshot's session (a vanished binding leaves the
            // candidate: the re-open ended the conversation it named).
            let Some(active_session_id) = guard
                .contexts
                .get(&context)
                .map(|session| session.active_id.clone())
            else {
                continue;
            };
            let closing = Arc::new(tokio::sync::Mutex::new(()));
            guard.closing.insert(context.clone(), Arc::clone(&closing));
            (closing, active_session_id)
        };
        let held_guard = held.lock().await;
        // The stop is one worker-owned decision (`kill_if_idle`): a
        // session holding a turn or queued work — however it got
        // there after the row was read — refuses the kill and keeps
        // its work; the reclamation moves to the next idle candidate.
        // The Detach lands first (the reversed pair would drop it);
        // a refused kill leaves the context in the table, and the next
        // send re-attaches the link.
        let _ = link
            .request(DaemonCommand::Detach {
                id: None,
                active_session_id: Some(active_session_id.clone()),
                rest: Map::default(),
            })
            .await;
        let kill = link
            .request(DaemonCommand::KillIfIdle {
                id: None,
                active_session_id: active_session_id.clone(),
                rest: Map::default(),
            })
            .await;
        // The worker's own refusal is the ONE answer that keeps the
        // candidate (it holds a turn or queued work — however it got
        // there after any earlier row was read), and so does the
        // saturated route's typed refusal (a worker at its in-flight
        // bound is a busy one, and the request never left the
        // supervisor): every other failure leaves the stop's contract
        // to the caller exactly like the unconditional kill it
        // replaces (a passivated worker's unknown-session route, a
        // lease bookkeeping failure — the context's session is gone or
        // idle either way, and the reclamation takes it).
        let stopped = match kill {
            Ok(response) => response.success || !crate::worker::kill_refused_by_worker(&response),
            Err(_) => true,
        };
        // The reservation holds through the removal decision: a send
        // must not admit against the binding while the settled stop's
        // table write is still pending (the closed session's runtime
        // would fail the task the way the race this reservation closes
        // did). The map entry leaves before the held lock does, so a
        // send that re-validates next sees the settled state — the
        // binding survived the refused stop or the conversation ended.
        let mut evicted = false;
        if stopped {
            let removed = {
                let mut guard = state.lock().await;
                // The candidate may have gained a task while the stop
                // ran: only an idle context leaves the table.
                if guard.registry.head(&context).is_none() {
                    guard
                        .contexts
                        .remove(&context)
                        .map(|session| session.active_id)
                        .is_some_and(|removed_id| {
                            // The cleanup names the binding actually
                            // removed, never the snapshot: a re-open
                            // that re-keyed the binding mid-stop leaves
                            // its fresh route under the fresh id.
                            guard.sessions.remove(&removed_id);
                            // The conversation's turn-window entry leaves
                            // with its binding: the entry is unreachable
                            // past the eviction (the table stays bounded
                            // with the conversation set).
                            guard.windows.remove(&removed_id);
                            guard.runs.drop_session(&removed_id);
                            guard.attached.remove(&context);
                            guard.detaching.remove(&context);
                            guard.context_use.remove(&context);
                            true
                        })
                } else {
                    false
                }
            };
            evicted = removed;
        }
        let mut guard = state.lock().await;
        guard.closing.remove(&context);
        drop(guard);
        drop(held_guard);
        if !evicted {
            continue;
        }
        return true;
    }
    false
}

/// Test-only state constructor (the events and pump tests).
#[cfg(test)]
impl A2aState {
    pub(super) fn for_test(registry: TaskRegistry, sessions: BTreeMap<String, String>) -> Self {
        Self {
            registry,
            contexts: sessions
                .iter()
                .map(|(session, context)| {
                    (
                        context.clone(),
                        ContextSession {
                            active_id: session.clone(),
                            durable_id: session.clone(),
                            session_file: None,
                        },
                    )
                })
                .collect(),
            sessions,
            windows: super::events::TurnWindows::default(),
            runs: super::events::RunAccumulators::default(),
            // The real create template (the production state carries the
            // mode's own): a test that wants another shape overwrites
            // the field, and a flow against the fake supervisor sends
            // the command it would send in production.
            create: DaemonCommand::Create {
                id: None,
                session_path: None,
                continue_recent: None,
                no_session: None,
                name: None,
                config: None,
                telemetry_disabled: None,
                runtime_metadata: None,
                lifecycle: None,
                env: None,
                launch_env: None,
                rest: Map::default(),
            },
            client_owned: false,
            max_contexts: DEFAULT_MAX_LIVE_CONTEXTS,
            attached: BTreeSet::new(),
            detaching: BTreeMap::new(),
            attaching: BTreeMap::new(),
            context_use: BTreeMap::new(),
            creating: 0,
            closing: BTreeMap::new(),
            resume_in_flight: BTreeSet::new(),
            idle_barriers: BTreeMap::new(),
            shutting_down: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mode_link::LinkFrame;
    use crate::worker::ABORTED_TURN_SETTLE_ERROR;
    use tokio::sync::mpsc;

    /// The settle table: success completes; the typed kind is the
    /// cancellation's authority (an aborted or withdrawn turn carries
    /// it, whatever the wire text); the supervisor's ladder strings
    /// stay cancelable without a kind; the engine's genuine
    /// no-response failure — the abort's text without a kind — reads
    /// FAILED, never CANCELED (a state that says the client asked for
    /// it).
    #[test]
    fn the_settle_verdict_maps_the_daemon_response() {
        let response = |success: bool, error: Option<&str>| DaemonResponse {
            id: None,
            command: "prompt_and_wait".into(),
            success,
            error: error.map(str::to_string),
            data: None,
            error_info: None,
        };
        let completed = settle_verdict(&response(true, None));
        assert_eq!(completed, (TaskState::Completed, None));

        for cancelled in [
            PROMPT_ABORTED_BEFORE_DELIVERY,
            PROMPT_ADMISSION_CANCELLED,
            QUEUED_PROMPT_DELETED,
            crate::worker::PROMPT_CANCELLED_BEFORE_START,
            crate::worker::QUEUED_PROMPT_CLEARED,
        ] {
            let canceled = settle_verdict(&response(false, Some(cancelled)));
            assert_eq!(canceled.0, TaskState::Canceled, "{cancelled}");
            assert_eq!(canceled.1.as_deref(), Some(cancelled));
        }

        let failed = settle_verdict(&response(false, Some("API Error: 500")));
        assert_eq!(failed.0, TaskState::Failed);
        assert_eq!(failed.1.as_deref(), Some("API Error: 500"));

        // The engine's no-response failure and the abort share the wire
        // text: only the typed kind separates the cancellation.
        let no_response = settle_verdict(&response(false, Some(ABORTED_TURN_SETTLE_ERROR)));
        assert_eq!(
            no_response,
            (
                TaskState::Failed,
                Some(ABORTED_TURN_SETTLE_ERROR.to_string())
            ),
            "the abort's text with no kind is a genuine turn failure"
        );
        let aborted = DaemonResponse {
            error_info: Some(DaemonErrorInfo::PromptSettleCancelled),
            ..response(false, Some(ABORTED_TURN_SETTLE_ERROR))
        };
        assert_eq!(
            settle_verdict(&aborted),
            (
                TaskState::Canceled,
                Some(ABORTED_TURN_SETTLE_ERROR.to_string())
            ),
            "the typed kind is the cancellation's authority"
        );
    }

    /// The pump's deterministic ordering pin: `[A's frames][response A]
    /// [B's frames]` — A's prompt response retires A's queue head and
    /// claims A's turn window before B's frames route, so B's text lands
    /// in B's artifact alone and A's artifact is exactly A's own turn.
    #[tokio::test]
    async fn a_prompt_response_retires_the_head_before_later_frames() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "a".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("task A")],
        );
        registry.admit(
            "b".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("task B")],
        );
        // Both flows wrote their prompts (the pump credits dispatched
        // heads only; the pre-dispatch head receives no frame).
        registry.mark_prompt_writing("a");
        registry.mark_prompt_writing("b");
        registry.mark_prompt_dispatched("a", None);
        registry.mark_prompt_dispatched("b", None);
        // The delivery identities the worker tags each own run with (the
        // unique admission ids the prompts carried — never the public
        // task ids).
        let delivery_a = registry
            .task("a")
            .expect("task A")
            .delivery_id()
            .to_string();
        let delivery_b = registry
            .task("b")
            .expect("task B")
            .delivery_id()
            .to_string();
        let sessions = BTreeMap::from([("s".to_string(), "ctx".to_string())]);
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, sessions)));

        let frame = |event: Value| serde_json::json!({ "type": "session_event", "activeSessionId": "s", "event": event });
        let message_end = |text: &str| {
            frame(serde_json::json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] },
            }))
        };
        // A's turn: its frames, then its prompt response (the pump
        // step claims the parked run reply; the flow's settle below
        // retires). The worker tags each run with its delivery identity.
        on_session_event(
            &state,
            &frame(serde_json::json!({
                "type": "agent_start",
                "admissionId": "a",
                "clientAdmissionId": delivery_a,
            })),
        )
        .await;
        on_session_event(&state, &frame(serde_json::json!({ "type": "turn_start" }))).await;
        on_session_event(
            &state,
            &frame(serde_json::json!({
                "type": "message_update",
                "message": { "role": "assistant", "content": [] },
                "assistantMessageEvent": { "type": "text_delta", "delta": "A-ONLY" },
            })),
        )
        .await;
        on_session_event(&state, &message_end("A-ONLY")).await;
        on_session_event(&state, &frame(serde_json::json!({ "type": "turn_end" }))).await;
        settle_prompt_at_pump(&state, "a", true).await;
        finalize_response_settle(&state, "a", TaskState::Completed, None).await;
        // B's turn: its frames route after A's settle, credited to B
        // through its own tagged run.
        on_session_event(
            &state,
            &frame(serde_json::json!({
                "type": "agent_start",
                "admissionId": "b",
                "clientAdmissionId": delivery_b,
            })),
        )
        .await;
        on_session_event(&state, &frame(serde_json::json!({ "type": "turn_start" }))).await;
        on_session_event(
            &state,
            &frame(serde_json::json!({
                "type": "message_update",
                "message": { "role": "assistant", "content": [] },
                "assistantMessageEvent": { "type": "text_delta", "delta": "B-ONLY" },
            })),
        )
        .await;
        on_session_event(&state, &message_end("B-ONLY")).await;
        on_session_event(&state, &frame(serde_json::json!({ "type": "turn_end" }))).await;

        let a = state
            .lock()
            .await
            .registry
            .snapshot("a", None)
            .expect("task A");
        assert_eq!(
            a.artifacts[0].parts[0].text.as_deref(),
            Some("A-ONLY"),
            "A's artifact is A's own turn: {a:?}"
        );
        let b = state
            .lock()
            .await
            .registry
            .snapshot("b", None)
            .expect("task B");
        assert_eq!(
            b.artifacts[0].parts[0].text.as_deref(),
            Some("B-ONLY"),
            "B's artifact is B's own turn: {b:?}"
        );
    }

    /// The write turnstile (`await_turn_at_head`): a flow waits for its
    /// context's queue head — the head answers at once, the
    /// predecessor's retire rotates the queue and ends the next task's
    /// wait, and a task that settles without reaching the head answers
    /// `false`. The wait parks holding NO state guard: a parked queued
    /// flow must never freeze the pump (the settle below runs while a
    /// second flow could be parked).
    #[tokio::test]
    async fn the_head_turnstile_waits_for_the_retire() {
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
        let sessions = BTreeMap::from([("s-1".to_string(), "ctx-1".to_string())]);
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, sessions)));
        assert!(
            await_turn_at_head(&state, "ctx-1", "t-1").await,
            "the head answers at once"
        );

        // The queued task's wait ends when the predecessor's settle
        // retires it from the queue — the park releases the guard, so
        // the settle (which locks the state) completes underneath it.
        let queued = {
            let state = Arc::clone(&state);
            tokio::spawn(async move { await_turn_at_head(&state, "ctx-1", "t-2").await })
        };
        tokio::task::yield_now().await;
        {
            let mut guard = state.lock().await;
            guard.registry.settle("t-1", TaskState::Completed, None);
        }
        // The wait is bounded: without the settle's head notify the
        // parked wait would hang the test instead of failing it.
        let turned = tokio::time::timeout(std::time::Duration::from_secs(2), queued).await;
        assert!(
            turned
                .expect("the queued wait must end once the head retires")
                .expect("the join must not panic"),
            "the retire rotated the head and ended the queued task's wait"
        );
        assert!(
            await_turn_at_head(&state, "ctx-1", "t-2").await,
            "the new head answers at once"
        );
        {
            let mut guard = state.lock().await;
            guard.registry.settle("t-2", TaskState::Canceled, None);
        }
        assert!(
            !await_turn_at_head(&state, "ctx-1", "t-2").await,
            "a settled task never reaches the head"
        );
    }

    /// The pump's untracked-turn isolation: a turn no task owns (a
    /// session turn between two A2A tasks) never lands its text in the
    /// next task's artifact — its window is claimed by no prompt
    /// response.
    #[tokio::test]
    async fn an_untracked_turn_never_reaches_the_next_task_artifact() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "first".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("one")],
        );
        let sessions = BTreeMap::from([("s".to_string(), "ctx".to_string())]);
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, sessions)));
        let frame = |event: Value| serde_json::json!({ "type": "session_event", "activeSessionId": "s", "event": event });
        let turn = |text: &str| {
            [
                frame(serde_json::json!({ "type": "turn_start" })),
                frame(serde_json::json!({
                    "type": "message_update",
                    "message": { "role": "assistant", "content": [] },
                    "assistantMessageEvent": { "type": "text_delta", "delta": text },
                })),
                frame(serde_json::json!({
                    "type": "message_end",
                    "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] },
                })),
                frame(serde_json::json!({ "type": "turn_end" })),
            ]
        };
        // The first task's turn and response (the flow's settle retires
        // the head before the next task's turn runs, the real order the
        // turnstile guarantees).
        for event in turn("FIRST-REPLY") {
            on_session_event(&state, &event).await;
        }
        settle_prompt_at_pump(&state, "first", true).await;
        finalize_response_settle(&state, "first", TaskState::Completed, None).await;
        // An untracked turn runs while the next task is queued behind it.
        state.lock().await.registry.admit(
            "second".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("two")],
        );
        for event in turn("UNTRACKED-TURN-TEXT") {
            on_session_event(&state, &event).await;
        }
        // The second task's own turn and response.
        for event in turn("SECOND-REPLY") {
            on_session_event(&state, &event).await;
        }
        settle_prompt_at_pump(&state, "second", true).await;

        let second = state
            .lock()
            .await
            .registry
            .snapshot("second", None)
            .expect("task");
        assert_eq!(
            second.artifacts[0].parts[0].text.as_deref(),
            Some("SECOND-REPLY"),
            "the untracked turn's text never joined the task's artifact: {second:?}"
        );
    }

    /// The fake supervisor socket: one JSONL peer that scripts its
    /// responses by command type (the link-level seam for the flow
    /// pins — the request/response exchange, no worker behind it).
    /// `silent_attaches` leaves that many attach requests unanswered
    /// (the request times out); `idle_delay` holds the idle wait.
    // Unix-only scaffolding: the fake supervisor binds a Unix-domain
    // socket (`tokio::net::UnixListener`), so the helpers and their
    // dependent tests gate per item — the required
    // x86_64-pc-windows-gnu cross-check must compile the suite.
    #[cfg(unix)]
    #[allow(clippy::too_many_arguments)]
    fn spawn_fake_supervisor(
        requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        silent_attaches: usize,
        idle_delay: std::time::Duration,
        list_rows: Vec<Value>,
        mut park_kill: Option<oneshot::Receiver<()>>,
    ) -> std::path::PathBuf {
        use tokio::io::AsyncBufReadExt as _;
        use tokio::io::AsyncWriteExt as _;
        let socket =
            std::env::temp_dir().join(format!("pa-fake-a2a-{}.sock", uuid::Uuid::new_v4()));
        let listener = tokio::net::UnixListener::bind(&socket).expect("the fake binds");
        tokio::spawn(async move {
            let mut silent_attaches = silent_attaches;
            let (peer, _) = listener.accept().await.expect("the fake accepts");
            let (read_half, mut writer) = tokio::io::split(peer);
            let mut reader = tokio::io::BufReader::new(read_half);
            let _ = writer
                .write_all(
                    format!(
                        "{{\"type\":\"daemon_hello\",\"protocol\":{{\"name\":\"prime-agent.daemon\",\"version\":{}}}}}\n",
                        pa_types::daemon::DAEMON_PROTOCOL_VERSION
                    )
                    .as_bytes(),
                )
                .await;
            // The outbound pump: one serialized writer for every
            // answer, so a command the fake holds (the idle exchange)
            // never blocks its own loop — the daemon answers commands
            // concurrently, and the pins' recorded-request ORDER is the
            // loop's read order either way.
            let (outbound, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let mut writer = writer;
            tokio::spawn(async move {
                while let Some(rendered) = out_rx.recv().await {
                    if writer.write_all(rendered.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
            let mut line = String::new();
            loop {
                line.clear();
                if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                    return;
                }
                let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                let id = value.get("id").and_then(Value::as_str).map(str::to_string);
                let command = value
                    .get("command")
                    .and_then(|command| command.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                // The recorded attach and create name the session they
                // addressed (the durable-selector and re-open pins: a
                // re-attach addresses the binding's selector, a
                // re-open addresses the conversation's file).
                let recorded = match command.as_str() {
                    "attach" => format!(
                        "attach {}",
                        value
                            .pointer("/command/activeSessionId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                    ),
                    "create" => format!(
                        "create {}",
                        value
                            .pointer("/command/sessionPath")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                    ),
                    "detach" | "kill" | "kill_if_idle" | "withdraw_admission" => format!(
                        "{command} {}",
                        value
                            .pointer("/command/activeSessionId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                    ),
                    other => other.to_string(),
                };
                requests.lock().unwrap().push(recorded);
                let idle_hold = command == "wait_for_idle";
                let data = match command.as_str() {
                    "attach" if silent_attaches > 0 => {
                        // The silent attach: no answer (the request
                        // times out; a later retry answers).
                        silent_attaches -= 1;
                        continue;
                    }
                    "attach" => Some(json!({ "activeSessionId": "fake-active-id" })),
                    "list" => Some(json!({ "sessions": list_rows })),
                    "kill_if_idle" => {
                        // The parked reclaim: the held close lets a test
                        // race its own send against the in-flight stop.
                        if let Some(release) = park_kill.as_mut() {
                            let _ = release.await;
                        }
                        Some(json!({
                            "activeSessionId": "fake-active-id",
                            "sessionFile": "/tmp/fake-a2a-session.jsonl",
                        }))
                    }
                    _ => Some(json!({
                        "activeSessionId": "fake-active-id",
                        "sessionFile": "/tmp/fake-a2a-session.jsonl",
                    })),
                };
                let response = crate::protocol::response_line(&DaemonResponse {
                    id,
                    command,
                    success: true,
                    error: None,
                    data,
                    error_info: None,
                });
                let mut rendered = serde_json::to_string(&response).expect("serializes");
                rendered.push('\n');
                if idle_hold {
                    // The held idle exchange answers after the delay, on
                    // its own task — the loop keeps reading and serving
                    // every other command meanwhile (the daemon's own
                    // concurrency).
                    let outbound = outbound.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(idle_delay).await;
                        let _ = outbound.send(rendered);
                    });
                } else {
                    let _ = outbound.send(rendered);
                }
            }
        });
        socket
    }

    /// The link plus its running frame pump over one fake supervisor.
    /// `park_kill` holds the fake's `kill_if_idle` answer until its
    /// channel releases, so a test can race work against an in-flight
    /// reclamation.
    #[cfg(unix)]
    async fn fake_link(
        requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        silent_attaches: usize,
        idle_delay: std::time::Duration,
        list_rows: Vec<Value>,
        park_kill: Option<oneshot::Receiver<()>>,
    ) -> (Arc<DaemonLink>, Arc<Mutex<A2aState>>) {
        let socket =
            spawn_fake_supervisor(requests, silent_attaches, idle_delay, list_rows, park_kill);
        let link = Arc::new(DaemonLink::connect(&socket, "a2a").await.expect("connects"));
        let state = Arc::new(Mutex::new(A2aState::for_test(
            TaskRegistry::new(),
            BTreeMap::new(),
        )));
        tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { while receive_link_frame(&link, &state).await {} }
        });
        tokio::task::yield_now().await;
        (link, state)
    }

    /// A failed or withdrawn prompt response claims no window: the
    /// newest parked window may belong to a turn no task owns, and a
    /// refused task must not adopt its text (the success claim is the
    /// artifact correction; the refusal settles with no artifact).
    #[tokio::test]
    async fn a_failed_prompt_response_claims_no_turn_window() {
        let registry = TaskRegistry::new();
        let sessions = BTreeMap::from([("s".to_string(), "ctx".to_string())]);
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, sessions)));
        let frame = |event: Value| serde_json::json!({ "type": "session_event", "activeSessionId": "s", "event": event });
        // A turn no task owns runs and parks its window (no head task
        // was admitted, so its live chunks credited to nothing).
        for event in [
            frame(serde_json::json!({ "type": "turn_start" })),
            frame(serde_json::json!({
                "type": "message_update",
                "message": { "role": "assistant", "content": [] },
                "assistantMessageEvent": { "type": "text_delta", "delta": "UNOWNED" },
            })),
            frame(serde_json::json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "UNOWNED" }] },
            })),
            frame(serde_json::json!({ "type": "turn_end" })),
        ] {
            on_session_event(&state, &event).await;
        }
        // A task queued behind another turn is canceled before it ever
        // runs: its withdrawn response must claim nothing.
        state.lock().await.registry.admit(
            "gone".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("queued")],
        );
        settle_prompt_at_pump(&state, "gone", false).await;
        let gone = state
            .lock()
            .await
            .registry
            .snapshot("gone", None)
            .expect("task");
        assert!(
            gone.artifacts.is_empty(),
            "the withdrawn task adopted no foreign window: {gone:?}"
        );
    }

    /// The pre-write idle wait outlasts the link's short request cap:
    /// a session held by a foreign turn for longer than the cap
    /// (a TUI user's turn, a heartbeat, a goal continuation) still
    /// serves its queued task once the session quiets — the wait rides
    /// the uncapped link exchange (the close is the liveness bound),
    /// not the 30 s request cap that would fail the task instead.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn the_pre_write_idle_wait_outlasts_the_request_cap() {
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (link, state) = fake_link(
            std::sync::Arc::clone(&requests),
            0,
            std::time::Duration::from_secs(31),
            Vec::new(),
            None,
        )
        .await;
        let request: SendMessageRequest = serde_json::from_value(json!({
            "message": {
                "messageId": "m-1",
                "role": "ROLE_USER",
                "parts": [{ "text": "hello" }],
            },
        }))
        .expect("parses");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        run_send_flow(
            &link,
            &state,
            json!(1),
            request,
            Streaming::No,
            "hello".to_string(),
            tx,
        )
        .await;
        let settled = rx.recv().await.expect("the flow settled");
        let SendFlowOutcome::Settled(reply) = settled else {
            panic!("the blocking flow answers its settled task");
        };

        let state_name = reply["result"]["task"]["status"]["state"]
            .as_str()
            .expect("the state");
        assert_eq!(
            state_name, "TASK_STATE_COMPLETED",
            "the task outlasted the 31 s foreign turn: {reply}"
        );
    }

    /// A canceled pre-write wait leaves no dead request: the session's
    /// idle barrier survives the cancel and the next queue head waits
    /// on the same exchange, so repeated send/cancel pairs against a
    /// foreign turn that never ends keep ONE in-flight idle request —
    /// never one abandoned `WaitForIdle` pending slot per canceled
    /// send (the issued-command log and the link's pending map are the
    /// growth surfaces the probe reads).
    #[cfg(unix)]
    #[tokio::test]
    async fn canceled_pre_write_waits_release_their_pending_slots() {
        // Real clock: the fake holds the idle exchange for 60 s — orders
        // of magnitude past the whole send/cancel pin — so the barrier
        // is still unanswered at every assertion.
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (link, state) = fake_link(
            std::sync::Arc::clone(&requests),
            0,
            std::time::Duration::from_secs(60),
            Vec::new(),
            None,
        )
        .await;
        let context_id = "ctx-cancels".to_string();
        {
            let mut guard = state.lock().await;
            guard.contexts.insert(
                context_id.clone(),
                ContextSession {
                    active_id: "fake-active-id".to_string(),
                    durable_id: "fake-durable".to_string(),
                    session_file: None,
                },
            );
            guard
                .sessions
                .insert("fake-active-id".to_string(), context_id.clone());
            guard.attached.insert(context_id.clone());
        }
        for round in 0..5u32 {
            let request: SendMessageRequest = serde_json::from_value(json!({
                "message": {
                    "messageId": format!("m-{round}"),
                    "role": "ROLE_USER",
                    "parts": [{ "text": "held" }],
                    "contextId": context_id.clone(),
                },
                "configuration": { "returnImmediately": true },
            }))
            .expect("parses");
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            // The handler's own shape: the flow runs detached, its
            // acknowledgement on the channel (an inline await would
            // hold the round on the fake's held exchange).
            let flow = {
                let link = Arc::clone(&link);
                let state = Arc::clone(&state);
                let id = json!(round);
                let text = "held".to_string();
                tokio::spawn(async move {
                    run_send_flow(&link, &state, id, request, Streaming::No, text, tx).await;
                })
            };
            let admitted = rx.recv().await.expect("the flow acknowledges");
            let SendFlowOutcome::Admitted { task_id, .. } = admitted else {
                panic!("the return-immediately send acknowledges its task");
            };
            // The cancel settles the undispatched task directly; the
            // parked flow answers on its own settle frames.
            let cancel = cancel_task(&link, &state, json!(round), json!({ "id": task_id })).await;
            let Dispatch::Reply(reply) = cancel else {
                panic!("the cancel answers a reply");
            };
            assert_eq!(
                reply["result"]["status"]["state"], "TASK_STATE_CANCELED",
                "the canceled pre-write task answers its verdict: {reply}"
            );
            let settled = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
                .await
                .expect("the flow settles behind the cancel")
                .expect("the flow answers once");
            let SendFlowOutcome::Settled(_) = settled else {
                panic!("the flow's settled outcome arrives");
            };
            flow.await.expect("the flow task ends cleanly");
        }
        // The one exchange: every send after the first waited the same
        // registered barrier (a per-flow exchange would have issued one
        // `wait_for_idle` line per round).
        let issued = requests.lock().unwrap().clone();
        let idle_requests = issued
            .iter()
            .filter(|line| line.as_str() == "wait_for_idle")
            .count();
        assert_eq!(
            idle_requests, 1,
            "the session's five send/cancel pairs issued ONE idle exchange: {issued:?}"
        );
        // The link's pending map holds the single held exchange (the
        // only request the fake never answers); every other exchange —
        // the attaches, the detaches, the resumes — completed.
        let pending = link.pending.lock().unwrap().len();
        assert!(
            pending <= 2,
            "the canceled pre-write waits left no dead pending slots: {pending} pending, commands: {issued:?}"
        );
        let barriers = state.lock().await.idle_barriers.len();
        assert_eq!(
            barriers, 1,
            "the session's barrier is the one registered exchange"
        );
    }

    /// A failed re-attach releases the optimistic mark: a later send
    /// retries the attach instead of treating the failed one as
    /// standing (a hung mark would skip the attach and treat the
    /// unattached session as served).
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn a_failed_reattach_releases_the_attach_mark() {
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (link, state) = fake_link(
            std::sync::Arc::clone(&requests),
            1,
            std::time::Duration::ZERO,
            Vec::new(),
            None,
        )
        .await;
        // A client-owned context (no session file: no re-open, the
        // durable-selector attach path) whose binding exists but is not
        // attached.
        {
            let mut guard = state.lock().await;
            guard.contexts.insert(
                "ctx".to_string(),
                ContextSession {
                    active_id: "fake-active-id".to_string(),
                    durable_id: "fake-durable".to_string(),
                    session_file: None,
                },
            );
        }
        // The first attach times out (the silent answer).
        let first = ensure_attached(&link, &state, "ctx").await;
        assert!(first.is_err(), "the silent attach fails: {first:?}");
        // The retry attaches: the mark cleared, so the second request
        // reached the daemon (two attach lines, not one).
        ensure_attached(&link, &state, "ctx")
            .await
            .expect("the retry attaches");
        let recorded = requests.lock().unwrap().clone();
        assert_eq!(
            recorded,
            vec![
                "attach fake-durable".to_string(),
                "attach fake-durable".to_string(),
            ],
            "the client-owned re-attach addressed its durable selector twice: {recorded:?}"
        );
    }

    /// A context with a session file re-opens it: the create template
    /// re-addressed at the conversation's file re-hosts the worker over
    /// its durable config, the answered active id re-keys the routing
    /// and the binding, and the client attach that follows addresses
    /// the answered id — never the stale create-time one.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_rehosted_reopen_rekeys_the_binding() {
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (link, state) = fake_link(
            std::sync::Arc::clone(&requests),
            0,
            std::time::Duration::ZERO,
            Vec::new(),
            None,
        )
        .await;
        {
            let mut guard = state.lock().await;
            guard.create = DaemonCommand::Create {
                id: None,
                session_path: None,
                continue_recent: None,
                no_session: None,
                name: None,
                config: None,
                telemetry_disabled: None,
                runtime_metadata: None,
                lifecycle: None,
                env: None,
                launch_env: None,
                rest: Map::default(),
            };
            guard.contexts.insert(
                "ctx".to_string(),
                ContextSession {
                    active_id: "stale-active-id".to_string(),
                    durable_id: "fake-durable".to_string(),
                    session_file: Some("/tmp/fake-a2a-session.jsonl".to_string()),
                },
            );
            guard
                .sessions
                .insert("stale-active-id".to_string(), "ctx".to_string());
        }
        ensure_attached(&link, &state, "ctx")
            .await
            .expect("the re-open answers");
        let recorded = requests.lock().unwrap().clone();
        assert_eq!(
            recorded,
            vec![
                "create /tmp/fake-a2a-session.jsonl".to_string(),
                "attach fake-active-id".to_string(),
            ],
            "the re-open addressed the conversation's file, then the answered id: {recorded:?}"
        );
        let guard = state.lock().await;
        assert!(
            !guard.sessions.contains_key("stale-active-id"),
            "the stale id no longer routes"
        );
        assert_eq!(
            guard.sessions.get("fake-active-id").map(String::as_str),
            Some("ctx"),
            "the answered id routes the context"
        );
        assert_eq!(
            guard
                .contexts
                .get("ctx")
                .map(|session| session.active_id.as_str()),
            Some("fake-active-id"),
            "the binding carries the answered id"
        );
    }

    /// A send admitted behind a canceled head never runs ahead of the
    /// head's in-flight re-attach: the first flow's attach round is
    /// withheld by the peer, the head is canceled while its round
    /// runs, and the successor joins the round instead of treating
    /// the in-flight attach as already standing — the daemon
    /// subscribes this client only once the attach answers, so a
    /// successor prompt written before it would run on a worker its
    /// frames never reach.
    #[tokio::test]
    async fn a_canceled_head_reattach_keeps_the_successor_behind_the_attach() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        state.lock().await.attached.remove("ctx-slow");
        let (first_tx, mut first_rx) = mpsc::unbounded_channel();
        let first = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                send_flow_to_settle(
                    &link,
                    &state,
                    json!(1),
                    "first",
                    serde_json::from_value(json!({
                        "message": {"messageId": "m1", "contextId": "ctx-slow", "role": "ROLE_USER", "parts": [{"text": "first"}]},
                        "configuration": {"returnImmediately": true}
                    }))
                    .unwrap(),
                    Streaming::No,
                    "first".to_string(),
                    first_tx,
                )
                .await;
            }
        });
        first_rx.recv().await.unwrap();
        // This command has not established its attachment yet.
        let attach = held_command(&mut requests, &frames, "attach").await;
        let (next_tx, mut next_rx) = mpsc::unbounded_channel();
        let next = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                send_flow_to_settle(
                    &link,
                    &state,
                    json!(2),
                    "next",
                    serde_json::from_value(json!({
                        "message": {"messageId": "m2", "contextId": "ctx-slow", "role": "ROLE_USER", "parts": [{"text": "next"}]},
                        "configuration": {"returnImmediately": true}
                    }))
                    .unwrap(),
                    Streaming::No,
                    "next".to_string(),
                    next_tx,
                )
                .await;
            }
        });
        next_rx.recv().await.unwrap();
        // Canceling the still-undispatched head rotates the queue to
        // the successor while the head's attach is still in flight.
        let cancelled = cancel_task(&link, &state, json!(3), json!({"id": "first"})).await;
        let Dispatch::Reply(cancelled) = cancelled else {
            panic!("the cancel answers with a reply");
        };
        assert_eq!(
            cancelled["result"]["status"]["state"],
            "TASK_STATE_CANCELED"
        );
        // While the head's attach is withheld, the successor must not
        // write its prompt: the successor joins the in-flight round.
        let early_prompt = tokio::time::timeout(std::time::Duration::from_millis(500), async {
            loop {
                let wire = requests.recv().await.unwrap();
                let request: Value = serde_json::from_str(&wire).unwrap();
                if request["command"]["type"] == "prompt_and_wait" {
                    break request;
                }
                peer_reply(&frames, &request, None);
            }
        })
        .await
        .ok();
        peer_reply(&frames, &attach, Some(json!({"activeSessionId": "slow"})));
        if let Some(prompt) = &early_prompt {
            peer_reply(&frames, prompt, None);
        }
        drain_and_reply(requests, frames);
        tokio::time::timeout(std::time::Duration::from_secs(3), first)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), next)
            .await
            .unwrap()
            .unwrap();
        assert!(
            early_prompt.is_none(),
            "canceling the reattaching head cannot treat an in-flight attach as an established attachment for its successor"
        );
    }

    /// The re-attach's Detach wait holds NO state: a send that reaches
    /// its re-attach while a prior idle Detach is pending must not pin
    /// the global `A2aState` across the wait — the sole frame pump (the
    /// only reader that can deliver the Detach receipt) takes the same
    /// guard, so a session event queued ahead of the receipt would
    /// wedge it behind the round's held guard until the 30-second
    /// request timeout, stalling every task API with it.
    #[tokio::test]
    async fn a_reattach_wait_releases_the_global_state_and_the_pump() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        {
            let mut guard = state.lock().await;
            guard.contexts.insert(
                "ctx-slow".to_string(),
                ContextSession {
                    active_id: "slow".to_string(),
                    durable_id: "slow-durable".to_string(),
                    session_file: None,
                },
            );
        }
        // The prior settle's idle detach: the Detach request is held by
        // the peer, so its receipt stays pending in `detaching`.
        let detached = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                detach_context_if_idle(&link, &state, "ctx-slow").await;
            }
        });
        let detach_request = held_command(&mut requests, &frames, "detach").await;
        // The next send's re-attach takes the round and waits out the
        // pending Detach before its own attach.
        let attach = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { ensure_attached(&link, &state, "ctx-slow").await }
        });
        // The round reached its Detach wait: the receiver left the
        // `detaching` table (the removal is the wait's first step, and
        // it publishes through the state the poll itself locks).
        let round_at_wait = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if !state.lock().await.detaching.contains_key("ctx-slow") {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(
            round_at_wait.is_ok(),
            "the re-attach round never reached its pending-Detach wait"
        );
        // A session event queues AHEAD of the Detach receipt: the pump
        // must process it (it takes the same guard) and still deliver
        // the receipt that ends the round's wait.
        frames
            .send(LinkFrame::Event(json!({
                "type": "session_event",
                "activeSessionId": "slow",
                "event": { "type": "turn_start" },
            })))
            .expect("the frame channel stays open");
        peer_reply(&frames, &detach_request, None);
        let state_free = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if state.try_lock().is_ok() {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(
            state_free.is_ok(),
            "the re-attach round must not hold A2aState across its Detach wait"
        );
        // The round proceeds to its attach and publishes the mark.
        let attach_request = held_command(&mut requests, &frames, "attach").await;
        peer_reply(
            &frames,
            &attach_request,
            Some(json!({ "activeSessionId": "slow" })),
        );
        drain_and_reply(requests, frames);
        attach
            .await
            .expect("the re-attach completes")
            .expect("the attach answers");
        assert!(
            state.lock().await.attached.contains("ctx-slow"),
            "the successful round published the attachment"
        );
        detached.await.expect("the detach flow ends");
    }

    /// A cancel that settles the only task during its own re-attach
    /// round must not leave the idle worker attached once the round
    /// publishes: the cancel's own idle detach ran before the round
    /// published the `attached` mark (the detach observed nothing), so
    /// the flow — the only writer that watched the round publish —
    /// releases the now-idle hold at its settled exit. Without it, a
    /// normal persisted session never idle-passivates until another
    /// send, the LRU reclamation, or the mode's exit.
    #[tokio::test]
    async fn a_canceled_reattach_detaches_the_idle_worker_after_the_round() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        {
            let mut guard = state.lock().await;
            guard.create = DaemonCommand::Create {
                id: None,
                session_path: None,
                continue_recent: None,
                no_session: None,
                name: None,
                config: None,
                telemetry_disabled: None,
                runtime_metadata: None,
                lifecycle: None,
                env: None,
                launch_env: None,
                rest: Map::default(),
            };
            guard.contexts.insert(
                "ctx-slow".to_string(),
                ContextSession {
                    active_id: "stale-active-id".to_string(),
                    durable_id: "slow-durable".to_string(),
                    session_file: Some("/tmp/fake-a2a-session.jsonl".to_string()),
                },
            );
            // The idle-detached context: the flow's re-attach is the
            // round's owner.
            guard.attached.remove("ctx-slow");
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            let tx = tx;
            async move {
                send_flow_to_settle(
                    &link,
                    &state,
                    json!(1),
                    "first",
                    serde_json::from_value(json!({
                        "message": {"messageId": "m1", "contextId": "ctx-slow", "role": "ROLE_USER", "parts": [{"text": "first"}]},
                        "configuration": {"returnImmediately": true}
                    }))
                    .unwrap(),
                    Streaming::No,
                    "first".to_string(),
                    tx,
                )
                .await;
            }
        });
        rx.recv().await.expect("the task acknowledges");
        // The flow's re-open answers; the attach is withheld while the
        // cancel lands.
        let reopened = held_command(&mut requests, &frames, "create").await;
        peer_reply(
            &frames,
            &reopened,
            Some(json!({ "activeSessionId": "slow" })),
        );
        let attach_request = held_command(&mut requests, &frames, "attach").await;
        let cancelled = cancel_task(&link, &state, json!(3), json!({ "id": "first" })).await;
        let Dispatch::Reply(cancelled) = cancelled else {
            panic!("the cancel answers with a reply");
        };
        assert_eq!(
            cancelled["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the undispatched cancel settles the task"
        );
        // The round completes and publishes the attachment; the flow
        // observes its settled task and must release the idle hold.
        peer_reply(
            &frames,
            &attach_request,
            Some(json!({ "activeSessionId": "slow" })),
        );
        let detach_request = held_command(&mut requests, &frames, "detach").await;
        peer_reply(&frames, &detach_request, None);
        drain_and_reply(requests, frames);
        flow.await.expect("the canceled flow ends");
        assert!(
            !state.lock().await.attached.contains("ctx-slow"),
            "the flow's settled exit detached the idle worker the round attached"
        );
    }

    /// A cancel that settles the only task during its own re-attach
    /// round releases the idle hold through the FLOW's context identity:
    /// the retention window may prune the canceled task's row before
    /// the round answers (256 newer terminal settles), and a cleanup
    /// that read the task's row would find nothing to detach — the
    /// idle worker would stay pinned against the daemon's passivation
    /// until another send, a reclamation, or the exit.
    #[tokio::test]
    async fn a_canceled_reattach_detaches_the_idle_worker_after_pruning() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        {
            let mut guard = state.lock().await;
            guard.create = DaemonCommand::Create {
                id: None,
                session_path: None,
                continue_recent: None,
                no_session: None,
                name: None,
                config: None,
                telemetry_disabled: None,
                runtime_metadata: None,
                lifecycle: None,
                env: None,
                launch_env: None,
                rest: Map::default(),
            };
            guard.contexts.insert(
                "ctx-slow".to_string(),
                ContextSession {
                    active_id: "stale-active-id".to_string(),
                    durable_id: "slow-durable".to_string(),
                    session_file: Some("/tmp/fake-a2a-session.jsonl".to_string()),
                },
            );
            guard.attached.remove("ctx-slow");
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            let tx = tx;
            async move {
                send_flow_to_settle(
                    &link,
                    &state,
                    json!(1),
                    "first",
                    serde_json::from_value(json!({
                        "message": {"messageId": "m1", "contextId": "ctx-slow", "role": "ROLE_USER", "parts": [{"text": "first"}]},
                        "configuration": {"returnImmediately": true}
                    }))
                    .unwrap(),
                    Streaming::No,
                    "first".to_string(),
                    tx,
                )
                .await;
            }
        });
        rx.recv().await.expect("the task acknowledges");
        // The flow's re-open answers; the attach is withheld while the
        // cancel lands.
        let reopened = held_command(&mut requests, &frames, "create").await;
        peer_reply(
            &frames,
            &reopened,
            Some(json!({ "activeSessionId": "slow" })),
        );
        let attach_request = held_command(&mut requests, &frames, "attach").await;
        let cancelled = cancel_task(&link, &state, json!(3), json!({ "id": "first" })).await;
        let Dispatch::Reply(cancelled) = cancelled else {
            panic!("the cancel answers with a reply");
        };
        assert_eq!(
            cancelled["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the undispatched cancel settles the task"
        );
        // The retention window advances past the canceled task's row
        // before the attach answers: the flow's cleanup must not need
        // it.
        {
            let mut guard = state.lock().await;
            advance_the_terminal_window(&mut guard);
            assert!(
                guard.registry.task("first").is_none(),
                "the retention window pruned the canceled task's row"
            );
        }
        peer_reply(
            &frames,
            &attach_request,
            Some(json!({ "activeSessionId": "slow" })),
        );
        let detach_request = held_command(&mut requests, &frames, "detach").await;
        assert_eq!(
            detach_request["command"]["activeSessionId"], "slow",
            "the flow's cleanup detaches the worker the round re-opened"
        );
        peer_reply(&frames, &detach_request, None);
        drain_and_reply(requests, frames);
        flow.await.expect("the canceled flow ends");
        assert!(
            !state.lock().await.attached.contains("ctx-slow"),
            "the flow's settled exit detached the pruned task's idle worker"
        );
    }

    /// A top-level `session_binding` frame (the supervisor's stale-id
    /// rebind notice, the same frame the TUI parses at the top level)
    /// re-keys the pump's routing: a re-hosted session's frames carry
    /// the new active id, and the map must follow before they arrive.
    #[tokio::test]
    async fn a_session_binding_frame_rekeys_the_routing() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx".into(),
            "new-active".into(),
            None,
            vec![Part::text("hi")],
        );
        let sessions = BTreeMap::from([("old-active".to_string(), "ctx".to_string())]);
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, sessions)));
        {
            let mut guard = state.lock().await;
            guard.contexts.insert(
                "ctx".to_string(),
                ContextSession {
                    active_id: "old-active".to_string(),
                    durable_id: "durable".to_string(),
                    session_file: None,
                },
            );
        }
        // The old id's turn window closed once (the pump's entry).
        for event in [
            serde_json::json!({ "type": "session_event", "activeSessionId": "old-active", "event": { "type": "turn_start" } }),
            serde_json::json!({ "type": "session_event", "activeSessionId": "old-active", "event": { "type": "turn_end" } }),
        ] {
            on_session_event(&state, &event).await;
        }
        on_session_binding(
            &state,
            &json!({
                "type": "session_binding",
                "previousActiveSessionId": "old-active",
                "activeSessionId": "new-active",
            }),
        )
        .await;
        let guard = state.lock().await;
        assert!(
            !guard.sessions.contains_key("old-active"),
            "the previous id no longer routes"
        );
        assert_eq!(
            guard.sessions.get("new-active").map(String::as_str),
            Some("ctx")
        );
        assert_eq!(
            guard
                .contexts
                .get("ctx")
                .map(|session| session.active_id.as_str()),
            Some("new-active")
        );
        assert_eq!(
            guard.windows.next_seq("old-active"),
            1,
            "the abandoned id's turn-window entry left with the re-key (a fresh entry answers 1)"
        );
    }

    /// The eviction reclaims the least recently used IDLE context — a
    /// busy context (a queued task) never evicts, and the daemon's own
    /// row gates the reclaim: a session whose row reports streaming
    /// (another client's turn in flight on the shared session) is never
    /// killed, the next idle candidate answers instead.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_eviction_picks_the_oldest_quiet_idle_context() {
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        // Both idle candidates report quiet rows.
        let (link, state) = fake_link(
            std::sync::Arc::clone(&requests),
            0,
            std::time::Duration::ZERO,
            vec![
                json!({ "activeSessionId": "ctx-old-active", "isStreaming": false }),
                json!({ "activeSessionId": "ctx-new-active", "isStreaming": false }),
            ],
            None,
        )
        .await;
        {
            let mut guard = state.lock().await;
            for context in ["ctx-old", "ctx-new"] {
                guard.contexts.insert(
                    context.to_string(),
                    ContextSession {
                        active_id: format!("{context}-active"),
                        durable_id: format!("{context}-durable"),
                        session_file: None,
                    },
                );
                guard
                    .sessions
                    .insert(format!("{context}-active"), context.to_string());
                guard.touch_context(context);
            }
            guard.context_use.insert("ctx-old".to_string(), 100);
            guard.context_use.insert("ctx-new".to_string(), 200);
        }
        // The old context's session closed one turn window (the pump's
        // entry exists before the eviction reclaims it).
        for event in [
            serde_json::json!({ "type": "session_event", "activeSessionId": "ctx-old-active", "event": { "type": "turn_start" } }),
            serde_json::json!({ "type": "session_event", "activeSessionId": "ctx-old-active", "event": { "type": "turn_end" } }),
        ] {
            on_session_event(&state, &event).await;
        }
        assert!(
            evict_one_idle_context(&link, &state).await,
            "an idle quiet context reclaims"
        );
        {
            let guard = state.lock().await;
            assert!(
                !guard.contexts.contains_key("ctx-old"),
                "the oldest idle context reclaimed"
            );
            assert!(guard.contexts.contains_key("ctx-new"));
            assert_eq!(
                guard.windows.next_seq("ctx-old-active"),
                1,
                "the evicted session's turn-window entry left with its binding"
            );
        }
        assert_eq!(
            requests.lock().unwrap().as_slice(),
            [
                "list",
                "detach ctx-old-active",
                "kill_if_idle ctx-old-active"
            ],
            "the reclaim read the daemon's rows, then detached and killed the evicted id"
        );

        // A queued (unsettled) task keeps its context busy: it is not a
        // candidate, and a table whose only context is busy reclaims
        // nothing.
        state.lock().await.registry.admit(
            "t-1".into(),
            "ctx-new".into(),
            "ctx-new-active".into(),
            None,
            vec![Part::text("busy")],
        );
        assert!(
            !evict_one_idle_context(&link, &state).await,
            "a busy context never reclaims"
        );
    }

    /// The daemon's row gates the reclaim: the oldest idle context's
    /// session is streaming (another client's turn), so the reclaim
    /// passes it by and takes the next idle candidate — never the
    /// foreign turn's session.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_eviction_never_takes_a_streaming_session() {
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (link, state) = fake_link(
            std::sync::Arc::clone(&requests),
            0,
            std::time::Duration::ZERO,
            vec![
                json!({ "activeSessionId": "ctx-old-active", "isStreaming": true }),
                json!({ "activeSessionId": "ctx-new-active", "isStreaming": false }),
            ],
            None,
        )
        .await;
        {
            let mut guard = state.lock().await;
            for context in ["ctx-old", "ctx-new"] {
                guard.contexts.insert(
                    context.to_string(),
                    ContextSession {
                        active_id: format!("{context}-active"),
                        durable_id: format!("{context}-durable"),
                        session_file: None,
                    },
                );
                guard.touch_context(context);
            }
            guard.context_use.insert("ctx-old".to_string(), 100);
            guard.context_use.insert("ctx-new".to_string(), 200);
        }
        assert!(
            evict_one_idle_context(&link, &state).await,
            "the quiet candidate reclaims"
        );
        {
            let guard = state.lock().await;
            assert!(
                guard.contexts.contains_key("ctx-old"),
                "the streaming session's context survives"
            );
            assert!(!guard.contexts.contains_key("ctx-new"));
        }
        assert_eq!(
            requests.lock().unwrap().as_slice(),
            [
                "list",
                "list",
                "detach ctx-new-active",
                "kill_if_idle ctx-new-active"
            ],
            "the streaming row was read and passed by, the quiet one reclaimed"
        );
    }

    /// A send never admits against a closing eviction: the reclaim's
    /// reservation owns the candidate from the state guard (the same
    /// guard the send's admission holds), so a send naming the context
    /// while its stop runs never acknowledges a task the closed session
    /// would fail — it waits the stop out and re-validates: the
    /// binding survived a refused stop, or the conversation ended with
    /// the honest unknown-contextId answer.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn a_send_never_admits_against_a_closing_eviction() {
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (release_kill, release_rx) = oneshot::channel::<()>();
        let (link, state) = fake_link(
            std::sync::Arc::clone(&requests),
            0,
            std::time::Duration::ZERO,
            vec![json!({ "activeSessionId": "ctx-old-active", "isStreaming": false })],
            Some(release_rx),
        )
        .await;
        {
            let mut guard = state.lock().await;
            guard.contexts.insert(
                "ctx-old".to_string(),
                ContextSession {
                    active_id: "ctx-old-active".to_string(),
                    durable_id: "ctx-old-durable".to_string(),
                    session_file: None,
                },
            );
            guard
                .sessions
                .insert("ctx-old-active".to_string(), "ctx-old".to_string());
            guard.touch_context("ctx-old");
        }
        // The reclaim parks on its kill (the fake holds the answer
        // until released): the recorded request is the observable
        // readiness that the stop is in flight with its reservation.
        let evict = {
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            tokio::spawn(async move { evict_one_idle_context(&link, &state).await })
        };
        loop {
            if requests
                .lock()
                .unwrap()
                .iter()
                .any(|request| request == "kill_if_idle ctx-old-active")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        assert!(
            state.lock().await.closing.contains_key("ctx-old"),
            "the reclaim reserved its candidate before the stop ran"
        );
        // The racing send names the context the stop is closing.
        let request: SendMessageRequest = serde_json::from_value(json!({
            "message": {
                "messageId": "m-race",
                "contextId": "ctx-old",
                "role": "ROLE_USER",
                "parts": [{ "text": "race the stop" }],
            },
        }))
        .expect("parses");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let send = {
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                run_send_flow(
                    &link,
                    &state,
                    json!(1),
                    request,
                    Streaming::No,
                    "race the stop".to_string(),
                    tx,
                )
                .await;
            })
        };
        // No task admits while the stop runs: the head stays empty
        // through the poll window (a revert that admits at once fails
        // the first iteration).
        for _ in 0..200 {
            assert!(
                state.lock().await.registry.head("ctx-old").is_none(),
                "the send never admits a task against the closing binding"
            );
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        // The stop completes: the binding ended, and the parked send
        // answers the honest unknown-contextId error — never an
        // acknowledged task on the closed session.
        drop(release_kill);
        assert!(
            evict.await.expect("the reclaim task"),
            "the parked stop reclaims its context"
        );
        let settled = rx.recv().await.expect("the parked send answers");
        let SendFlowOutcome::Settled(reply) = settled else {
            panic!("the raced send never acknowledged a task");
        };
        assert_eq!(reply["error"]["code"], -32602, "{reply}");
        assert!(
            reply["error"]["data"][0]["fieldViolations"][0]["description"]
                .as_str()
                .is_some_and(|message| message.contains("unknown contextId")),
            "the send names the conversation's honest end: {reply}"
        );
        assert!(send.await.is_ok());
    }

    /// The reclamation defers to a context whose re-attach round is
    /// still in flight: the round re-opens the session and attaches the
    /// worker the re-open answers, so a stop that removed the binding
    /// mid-round would strand that late attachment with no binding left
    /// to name it — a worker outside the bound with no owner. The
    /// reclamation takes the context at its next pass once the round
    /// settled; here the canceled flow's own cleanup releases the
    /// worker the round attached.
    #[tokio::test]
    async fn a_reclamation_defers_to_an_in_flight_reattach_round() {
        let (link, state, mut requests, frames) = scripted_peer(&[("old", "ctx-slow")]);
        {
            let mut guard = state.lock().await;
            guard.create = DaemonCommand::Create {
                id: None,
                session_path: None,
                continue_recent: None,
                no_session: None,
                name: None,
                config: None,
                telemetry_disabled: None,
                runtime_metadata: None,
                lifecycle: None,
                env: None,
                launch_env: None,
                rest: Map::default(),
            };
            guard.contexts.insert(
                "ctx-slow".to_string(),
                ContextSession {
                    active_id: "old".to_string(),
                    durable_id: "slow-durable".to_string(),
                    session_file: Some("/tmp/fake-a2a-session.jsonl".to_string()),
                },
            );
            guard.attached.remove("ctx-slow");
            guard.max_contexts = 1;
            guard.touch_context("ctx-slow");
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            let tx = tx;
            async move {
                send_flow_to_settle(
                    &link,
                    &state,
                    json!(1),
                    "first",
                    serde_json::from_value(json!({
                        "message": {"messageId": "m1", "contextId": "ctx-slow", "role": "ROLE_USER", "parts": [{"text": "first"}]},
                        "configuration": {"returnImmediately": true}
                    }))
                    .unwrap(),
                    Streaming::No,
                    "first".to_string(),
                    tx,
                )
                .await;
            }
        });
        rx.recv().await.expect("the task acknowledges");
        // The round's re-open is dispatched but not answered yet.
        let reopened = held_command(&mut requests, &frames, "create").await;
        // The cancel settles the round's only task: the context is idle
        // while the round still runs.
        let cancelled = cancel_task(&link, &state, json!(3), json!({ "id": "first" })).await;
        let Dispatch::Reply(cancelled) = cancelled else {
            panic!("the cancel answers with a reply");
        };
        assert_eq!(
            cancelled["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the undispatched cancel settles the task"
        );
        let eviction = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { evict_one_idle_context(&link, &state).await }
        });
        let list = held_command(&mut requests, &frames, "list").await;
        peer_reply(&frames, &list, Some(json!({ "sessions": [] })));
        // The in-flight round keeps its binding: the reclamation answers
        // nothing-reclaimed instead of racing the round's worker.
        assert!(
            !eviction.await.unwrap(),
            "the reclamation must not reclaim a context whose attach round is in flight"
        );
        assert!(
            state.lock().await.contexts.contains_key("ctx-slow"),
            "the in-flight round's binding stays in the table"
        );
        // The round finishes: the re-open answers a fresh worker, the
        // attach binds it, and the canceled flow's cleanup releases it.
        peer_reply(
            &frames,
            &reopened,
            Some(json!({ "activeSessionId": "fresh" })),
        );
        let attach = held_command(&mut requests, &frames, "attach").await;
        assert_eq!(
            attach["command"]["activeSessionId"], "fresh",
            "the round attaches the worker the re-open answered"
        );
        peer_reply(
            &frames,
            &attach,
            Some(json!({ "activeSessionId": "fresh" })),
        );
        let detach = held_command(&mut requests, &frames, "detach").await;
        assert_eq!(
            detach["command"]["activeSessionId"], "fresh",
            "the flow's cleanup detaches the worker the round attached"
        );
        peer_reply(&frames, &detach, None);
        drain_and_reply(requests, frames);
        flow.await.expect("the canceled flow ends");
        assert!(
            !state.lock().await.attached.contains("ctx-slow"),
            "the flow's settled exit released the round's attachment"
        );
    }

    /// The main/TS abort contract: a `CancelTask` on the task awaiting
    /// its completion settles CANCELED on every successful withdrawal —
    /// the children window's shape (the task's own run closed, its
    /// spawned child still runs, nothing queued, no turn running; the
    /// sweep names nothing) answers CANCELED at once, and the child's
    /// later notice turn resolves Foreign, never a verdict revision.
    /// Only the worker's refusal (a failed receipt) answers the honest
    /// `TaskNotCancelable`.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_withdrawal_success_settles_the_cancel_even_when_it_names_no_work() {
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (link, state) = fake_link(
            std::sync::Arc::clone(&requests),
            0,
            std::time::Duration::ZERO,
            Vec::new(),
            None,
        )
        .await;
        // The awaiting task arrives through the registry's own marks
        // (the pump's awaiting frame set them in production).
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("/goal write three lines")],
        );
        registry.mark_prompt_writing("t-1");
        registry.mark_prompt_dispatched("t-1", Some(1));
        registry.mark_awaiting_completion("t-1");
        {
            let mut guard = state.lock().await;
            guard.registry = registry;
        }
        let dispatch = cancel_task(&link, &state, json!(1), json!({ "id": "t-1" })).await;
        let Dispatch::Reply(reply) = dispatch else {
            panic!("the cancel answers one reply");
        };
        assert_eq!(
            reply["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the cancel of the awaiting task settles CANCELED on a successful withdrawal, whatever the sweep named: {reply}"
        );
        assert_eq!(
            state
                .lock()
                .await
                .registry
                .task("t-1")
                .map(TaskEntry::state),
            Some(TaskState::Canceled),
            "the receipt settled the task's FIRST terminal verdict"
        );
    }

    /// An engine continuation that closed BEFORE the original response
    /// reached the pump parks its result on the dispatched head: the
    /// response's settle step applies the parked lot in run order —
    /// the continuation's text reaches the artifact after the task's
    /// own reply, and a failed continuation's outcome carries to the
    /// final settlement — never the pre-response drop that lost the
    /// output and settled a failed continuation behind the prompt's
    /// verdict.
    #[tokio::test]
    async fn an_autonomous_continuation_before_the_response_settles_at_it() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("original")],
        );
        registry.mark_prompt_writing("t-1");
        registry.mark_prompt_dispatched("t-1", Some(1));
        let delivery = registry
            .task("t-1")
            .expect("the admitted task")
            .delivery_id()
            .to_string();
        let sessions = BTreeMap::from([("s".to_string(), "ctx".to_string())]);
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, sessions)));
        let frame = |event: Value| serde_json::json!({ "type": "session_event", "activeSessionId": "s", "event": event });
        // The task's own run closes first (its reply parks for the
        // response), then the goal driver's continuations run and
        // close — all before the response arrives. The worker tags the
        // own run with its delivery identity (the unique admission id
        // its prompt carried — never the public task id).
        let own_run = [
            frame(serde_json::json!({
                "type": "agent_start",
                "admissionId": "t-1",
                "clientAdmissionId": delivery,
            })),
            frame(serde_json::json!({ "type": "turn_start" })),
            frame(serde_json::json!({
                "type": "message_update",
                "message": { "role": "assistant", "content": [] },
                "assistantMessageEvent": { "type": "text_delta", "delta": "ORIGINAL" },
            })),
            frame(serde_json::json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "ORIGINAL" }] },
            })),
            frame(serde_json::json!({ "type": "turn_end" })),
            frame(serde_json::json!({ "type": "agent_end" })),
        ];
        let continuation = |reply: Option<&str>, error: Option<&str>| {
            let mut frames = vec![
                frame(serde_json::json!({
                    "type": "agent_start",
                    "engineContinuation": true,
                })),
                frame(serde_json::json!({ "type": "turn_start" })),
            ];
            if let Some(reply) = reply {
                frames.extend([
                    frame(serde_json::json!({
                        "type": "message_update",
                        "message": { "role": "assistant", "content": [] },
                        "assistantMessageEvent": { "type": "text_delta", "delta": reply },
                    })),
                    frame(serde_json::json!({
                        "type": "message_end",
                        "message": { "role": "assistant", "content": [{ "type": "text", "text": reply }] },
                    })),
                ]);
            }
            let mut turn_end = serde_json::json!({ "type": "turn_end" });
            if let Some(error) = error {
                turn_end["error"] = serde_json::json!(error);
            }
            frames.push(frame(turn_end));
            frames.push(frame(serde_json::json!({ "type": "agent_end" })));
            frames
        };
        for event in own_run {
            on_session_event(&state, &event).await;
        }
        for event in continuation(Some("GOAL-1"), None) {
            on_session_event(&state, &event).await;
        }
        for event in continuation(None, Some("native autonomous failure")) {
            on_session_event(&state, &event).await;
        }
        // The original response arrives LAST: the settle applies the
        // parked continuation lot in its run order.
        settle_prompt_at_pump(&state, "t-1", true).await;
        let task = state.lock().await.registry.snapshot("t-1", None).unwrap();
        assert_eq!(
            task.status.state,
            TaskState::Working,
            "the task waits out its remaining continuations: {task:?}"
        );
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("ORIGINAL\n\nGOAL-1"),
            "the parked continuation reached the artifact after the task's own reply: {task:?}"
        );
        let error = state.lock().await.registry.take_continuation_error("t-1");
        assert_eq!(
            error.as_deref(),
            Some("native autonomous failure"),
            "the parked failed continuation carries its outcome to the final settlement"
        );
    }

    /// An autonomous continuation run that failed carries its reason to
    /// the final settlement: a task whose initial turn succeeded never
    /// settles COMPLETED behind a failed continuation — the run's
    /// outcome is the task's outcome.
    #[tokio::test]
    async fn a_failed_autonomous_continuation_fails_the_settlement() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("original")],
        );
        registry.mark_prompt_writing("t-1");
        registry.mark_prompt_dispatched("t-1", Some(1));
        let sessions = BTreeMap::from([("s".to_string(), "ctx".to_string())]);
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, sessions)));
        {
            let mut guard = state.lock().await;
            guard.registry.set_artifact_text("t-1", "ORIGINAL");
            guard.registry.mark_awaiting_completion("t-1");
        }
        let frame = |event: Value| serde_json::json!({ "type": "session_event", "activeSessionId": "s", "event": event });
        for event in [
            frame(serde_json::json!({
                "type": "agent_start",
                "engineContinuation": true,
            })),
            frame(serde_json::json!({ "type": "turn_start" })),
            frame(serde_json::json!({ "type": "turn_end", "error": "provider failed" })),
            frame(serde_json::json!({ "type": "agent_end" })),
        ] {
            on_session_event(&state, &event).await;
        }
        // The flow's final settle would complete the task behind the
        // successful prompt's verdict — the continuation's outcome
        // wins.
        finalize_response_settle(&state, "t-1", TaskState::Completed, None).await;
        let task = state.lock().await.registry.snapshot("t-1", None).unwrap();
        assert_eq!(
            task.status.state,
            TaskState::Failed,
            "the failed continuation fails the task: {task:?}"
        );
        assert_eq!(
            task.status
                .message
                .as_ref()
                .and_then(|message| message.parts.first())
                .and_then(|part| part.text.as_deref()),
            Some("provider failed"),
            "the run's reason is the failure message: {task:?}"
        );
    }

    /// A stamped continuation that runs BEFORE its task's prompt
    /// response streams its deltas LIVE into the dispatched head's
    /// artifact: the run's own identity (resolved at its open and kept
    /// through the run) addresses the task, so the streamed chunk and
    /// the stream reach the task before the response — a pre-response
    /// continuation is the task's own work in flight, never output that
    /// only appears when the response applies the parked lot. The close
    /// still parks for the response's settle (the artifact keeps the
    /// streamed text either way).
    #[tokio::test]
    async fn a_pre_response_continuation_streams_live_before_its_response() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("original")],
        );
        registry.mark_prompt_writing("t-1");
        registry.mark_prompt_dispatched("t-1", Some(1));
        // The continuation's stamp is the worker's own: the delivery id
        // of the delivery whose turn minted it (never the public task
        // id).
        let delivery = registry
            .task("t-1")
            .expect("the admitted task")
            .delivery_id()
            .to_string();
        let sessions = BTreeMap::from([("s".to_string(), "ctx".to_string())]);
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, sessions)));
        let frame = |event: Value| serde_json::json!({ "type": "session_event", "activeSessionId": "s", "event": event });
        let mut stream = {
            let mut guard = state.lock().await;
            guard.registry.subscribe("t-1").expect("subscribable")
        };
        // The task's own stamped continuation runs while the response is
        // still in flight: the dispatched head receives its deltas live.
        for event in [
            frame(serde_json::json!({
                "type": "agent_start",
                "engineContinuation": true,
                "clientAdmissionId": delivery,
            })),
            frame(serde_json::json!({ "type": "turn_start" })),
            frame(serde_json::json!({
                "type": "message_update",
                "message": { "role": "assistant", "content": [] },
                "assistantMessageEvent": { "type": "text_delta", "delta": "LIVE-DELTA" },
            })),
            frame(serde_json::json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "LIVE-DELTA" }]
                },
            })),
        ] {
            on_session_event(&state, &event).await;
        }
        {
            let task = state.lock().await.registry.snapshot("t-1", None).unwrap();
            assert_eq!(
                task.artifacts[0].parts[0].text.as_deref(),
                Some("LIVE-DELTA"),
                "the pre-response continuation's deltas stream live into the dispatched head's artifact: {task:?}"
            );
        }
        assert!(
            stream.try_recv().is_ok(),
            "the live delta reached the task's stream before its response"
        );
        // The run closes before the response: the close parks for the
        // response's settle, and the settle applies it without
        // duplicating the streamed text.
        for event in [
            frame(serde_json::json!({ "type": "turn_end" })),
            frame(serde_json::json!({ "type": "agent_end" })),
        ] {
            on_session_event(&state, &event).await;
        }
        settle_prompt_at_pump(&state, "t-1", true).await;
        let task = state.lock().await.registry.snapshot("t-1", None).unwrap();
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("LIVE-DELTA"),
            "the applied park keeps the streamed text once: {task:?}"
        );
    }

    /// A stream queue overflow never ends the completion wait either:
    /// the wait parks on the daemon's headless-completion response
    /// with the task's terminal frames raced beside it, and a burst
    /// past the subscriber queue's bound drops the race's stream
    /// receiver — the channel close is a LAG DROP, never permission
    /// to finalize the completion while the daemon's own response is
    /// still held. The wait resubscribes until the response or the
    /// task's own settle ends it.
    #[tokio::test]
    async fn a_completion_wait_survives_stream_queue_overflow() {
        let (link, state, seen, _release) = controlled_link("wait_for_headless_completion");
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "burst".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("burst");
            guard.registry.mark_prompt_dispatched("burst", None);
            guard.registry.mark_awaiting_completion("burst");
        }
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                settle_from_response(
                    &link,
                    &state,
                    "burst",
                    DaemonResponse {
                        id: None,
                        command: "prompt_and_wait".into(),
                        success: true,
                        error: None,
                        error_info: None,
                        data: None,
                    },
                )
                .await;
            }
        });
        seen.await.expect("the own completion command is held");
        // The burst drops the settle race's stream receiver while the
        // completion response stays held.
        {
            let mut guard = state.lock().await;
            for _ in 0..8192 {
                guard.registry.append_artifact_chunk("burst", "x");
            }
        }
        let outcome = tokio::time::timeout(std::time::Duration::from_millis(250), flow).await;
        let status = state.lock().await.registry.task("burst").unwrap().state();
        assert!(
            outcome.is_err(),
            "the completion wait survives its stream's queue overflow; the task stays {status:?} behind its held daemon response"
        );
    }

    /// A run's owner entries leave with the session binding they name:
    /// a re-host's re-key drops the abandoned id's run entries (the
    /// open accumulator's frames route under the fresh id), and a
    /// context's eviction drops its session's — the run table stays
    /// bounded with the conversation set, never one open accumulator
    /// per historical session id forever.
    #[tokio::test]
    async fn open_run_owners_leave_with_the_context_binding() {
        let (link, state, _seen, _release) = controlled_link("unused");
        let mut previous = "slow".to_string();
        for index in 0..512 {
            for event in [
                json!({ "type": "agent_start", "clientAdmissionId": "foreign" }),
                json!({ "type": "agent_end" }),
            ] {
                on_session_event(
                    &state,
                    &json!({
                        "type": "session_event",
                        "activeSessionId": previous,
                        "event": event
                    }),
                )
                .await;
            }
            let next = format!("slow-rehost-{index}");
            on_session_binding(
                &state,
                &json!({ "previousActiveSessionId": previous, "activeSessionId": next }),
            )
            .await;
            previous = next;
        }
        // 512 re-hosts later, every abandoned id's entry is gone —
        // the fresh id of each re-key opens no run until the next
        // iteration's frames (the unfixed table holds all 512).
        let debug = format!("{:?}", state.lock().await.runs);
        let entries = debug.matches("Some(Foreign)").count();
        assert_eq!(
            entries, 0,
            "the re-keys drop every abandoned id's closed-run owner"
        );
        // The attach answer's re-key drops the same way: one OPEN run
        // under the current id (its close removes the accumulator
        // itself — the entry the re-key must drop is the open one),
        // then the re-host under a fresh id.
        for event in [json!({ "type": "agent_start", "clientAdmissionId": "foreign" })] {
            on_session_event(
                &state,
                &json!({
                    "type": "session_event",
                    "activeSessionId": previous,
                    "event": event
                }),
            )
            .await;
        }
        let debug = format!("{:?}", state.lock().await.runs);
        let entries = debug.matches("Some(Foreign)").count();
        assert_eq!(
            entries, 1,
            "the current id's open run sits in the table before its re-key"
        );
        let attached = DaemonResponse {
            id: None,
            command: "attach".into(),
            success: true,
            error: None,
            error_info: None,
            data: Some(json!({ "activeSessionId": "slow-fresh" })),
        };
        rekey_context_session(&state, "ctx-slow", &attached).await;
        let debug = format!("{:?}", state.lock().await.runs);
        let entries = debug.matches("Some(Foreign)").count();
        assert_eq!(
            entries, 0,
            "the attach answer's re-key drops the old id's open run"
        );
        // The re-hosted binding opens its own run — the entry the
        // context's eviction must then drop.
        for event in [json!({ "type": "agent_start", "clientAdmissionId": "foreign" })] {
            on_session_event(
                &state,
                &json!({
                    "type": "session_event",
                    "activeSessionId": "slow-fresh",
                    "event": event
                }),
            )
            .await;
        }
        let debug = format!("{:?}", state.lock().await.runs);
        let entries = debug.matches("Some(Foreign)").count();
        assert_eq!(
            entries, 1,
            "the re-hosted id's open run sits in the table before the eviction"
        );
        // The context's eviction drops the last binding's entry too.
        assert!(
            !evict_one_idle_context(&link, &state).await,
            "control: an untouched context is no eviction candidate"
        );
        state.lock().await.touch_context("ctx-slow");
        assert!(
            evict_one_idle_context(&link, &state).await,
            "the idle context evicts"
        );
        let guard = state.lock().await;
        assert!(!guard.contexts.contains_key("ctx-slow"));
        let debug = format!("{:?}", guard.runs);
        let entries = debug.matches("Some(Foreign)").count();
        assert_eq!(entries, 0, "the eviction drops the last binding's open run");
    }

    /// A foreign client's engine continuation never owns the head: a
    /// minted continuation carries the client id of the delivery whose
    /// turn minted it (the worker stamps the running delivery's id),
    /// and the conversation's credit matches that identity against the
    /// awaiting head — a foreign daemon client's own goal loop on the
    /// shared session names its own id, credits nothing, and the
    /// awaiting task's artifact keeps exactly its own run's reply
    /// (the unfixed table credits every engine continuation on the
    /// session).
    #[tokio::test]
    async fn a_foreign_engine_continuation_never_owns_the_head() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "own-task".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("our prompt")],
        );
        registry.mark_prompt_writing("own-task");
        registry.mark_prompt_dispatched("own-task", None);
        registry.set_artifact_text("own-task", "OWN-REPLY");
        registry.mark_awaiting_completion("own-task");
        let state = Arc::new(Mutex::new(A2aState::for_test(
            registry,
            BTreeMap::from([("s".to_string(), "ctx".to_string())]),
        )));
        for event in [
            json!({
                "type": "agent_start",
                "clientAdmissionId": "foreign-task",
                "engineContinuation": true
            }),
            json!({ "type": "turn_start" }),
            json!({ "type": "message_start", "message": { "role": "assistant" } }),
            json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "text_delta", "delta": "FOREIGN-CONTINUATION" }
            }),
            json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [
                    { "type": "text", "text": "FOREIGN-CONTINUATION" }
                ] }
            }),
            json!({ "type": "turn_end" }),
            json!({ "type": "agent_end" }),
        ] {
            on_session_event(
                &state,
                &json!({ "type": "session_event", "activeSessionId": "s", "event": event }),
            )
            .await;
        }
        finalize_response_settle(&state, "own-task", TaskState::Completed, None).await;
        let task = state
            .lock()
            .await
            .registry
            .snapshot("own-task", None)
            .unwrap();
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("OWN-REPLY"),
            "the engine-minted row is owned by the delivery whose clientAdmissionId it carries: {task:?}"
        );
    }

    /// A failed or withdrawn response retires at once and its parked
    /// lots go with it: a pre-response engine continuation's parked
    /// result is never applied to a retired head, and it never
    /// strands on the task either.
    #[tokio::test]
    async fn a_failed_response_drops_its_parked_lots() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("original")],
        );
        registry.mark_prompt_writing("t-1");
        registry.mark_prompt_dispatched("t-1", Some(1));
        let sessions = BTreeMap::from([("s".to_string(), "ctx".to_string())]);
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, sessions)));
        let frame = |event: Value| serde_json::json!({ "type": "session_event", "activeSessionId": "s", "event": event });
        for event in [
            frame(serde_json::json!({
                "type": "agent_start",
                "admissionId": "wire-1",
                "clientAdmissionId": "t-1",
            })),
            frame(serde_json::json!({ "type": "turn_start" })),
            frame(serde_json::json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "ORIGINAL" }] },
            })),
            frame(serde_json::json!({ "type": "turn_end" })),
            frame(serde_json::json!({ "type": "agent_end" })),
        ] {
            on_session_event(&state, &event).await;
        }
        for event in [
            frame(serde_json::json!({
                "type": "agent_start",
                "engineContinuation": true,
            })),
            frame(serde_json::json!({ "type": "turn_start" })),
            frame(serde_json::json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "GOAL-1" }] },
            })),
            frame(serde_json::json!({ "type": "turn_end" })),
            frame(serde_json::json!({ "type": "agent_end" })),
        ] {
            on_session_event(&state, &event).await;
        }
        // The failed response retires the head at once.
        settle_prompt_at_pump(&state, "t-1", false).await;
        let mut guard = state.lock().await;
        assert!(
            guard.registry.take_parked_autonomous("t-1").is_empty(),
            "the retire drops the parked continuation lot"
        );
    }

    /// The artifact rule joins a run's model steps on the text that
    /// landed, never on the step count: a tool-first run (its first
    /// step a tool call with no text) opens its reply with the first
    /// text that lands — never a leading blank line.
    #[tokio::test]
    async fn a_tool_first_run_does_not_open_with_a_blank_line() {
        let mut registry = TaskRegistry::new();
        registry.admit(
            "t-1".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("original")],
        );
        registry.mark_prompt_writing("t-1");
        registry.mark_prompt_dispatched("t-1", Some(1));
        let delivery = registry
            .task("t-1")
            .expect("the admitted task")
            .delivery_id()
            .to_string();
        let sessions = BTreeMap::from([("s".to_string(), "ctx".to_string())]);
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, sessions)));
        let frame = |event: Value| serde_json::json!({ "type": "session_event", "activeSessionId": "s", "event": event });
        for event in [
            frame(serde_json::json!({
                "type": "agent_start",
                "admissionId": "wire-1",
                "clientAdmissionId": delivery,
            })),
            // The first model step is a tool call with no text.
            frame(serde_json::json!({ "type": "turn_start" })),
            frame(serde_json::json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [
                    { "type": "toolCall", "name": "bash", "arguments": { "command": "true" } }
                ] },
            })),
            frame(serde_json::json!({ "type": "turn_end" })),
            // The second step answers.
            frame(serde_json::json!({ "type": "turn_start" })),
            frame(serde_json::json!({
                "type": "message_update",
                "message": { "role": "assistant", "content": [] },
                "assistantMessageEvent": { "type": "text_delta", "delta": "The answer is 42." },
            })),
            frame(serde_json::json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "The answer is 42." }] },
            })),
            frame(serde_json::json!({ "type": "turn_end" })),
            frame(serde_json::json!({ "type": "agent_end" })),
        ] {
            on_session_event(&state, &event).await;
        }
        settle_prompt_at_pump(&state, "t-1", true).await;
        let task = state.lock().await.registry.snapshot("t-1", None).unwrap();
        assert_eq!(
            task.artifacts[0].parts[0].text.as_deref(),
            Some("The answer is 42."),
            "the tool-first run's reply opens with its first text, never a blank line: {task:?}"
        );
    }

    /// The message-text contract: an all-text message whose text is
    /// empty is the parameter error on `message.parts` (the part IS
    /// text — the request is just empty), while a non-text part stays
    /// the content-type error.
    #[test]
    fn empty_text_answers_params_and_non_text_answers_content_type() {
        let id = serde_json::json!(1);
        let empty: SendMessageRequest = serde_json::from_value(serde_json::json!({
            "message": {
                "messageId": "m-1",
                "role": "ROLE_USER",
                "parts": [{ "text": "" }],
            },
        }))
        .expect("parses");
        let error = message_text(&id, &empty).expect_err("the empty text is refused");
        assert_eq!(
            error["error"]["code"], -32602,
            "the parameter error: {error}"
        );
        assert!(
            error["error"]["data"][0]["fieldViolations"][0]["field"]
                .as_str()
                .is_some_and(|field| field.contains("message.parts")),
            "the violation names the empty parts: {error}"
        );
        let non_text: SendMessageRequest = serde_json::from_value(serde_json::json!({
            "message": {
                "messageId": "m-2",
                "role": "ROLE_USER",
                "parts": [{ "raw": "aGk=", "filename": "note.txt" }],
            },
        }))
        .expect("parses");
        let error = message_text(&id, &non_text).expect_err("the non-text part is refused");
        assert_eq!(
            error["error"]["code"], -32005,
            "the content-type error: {error}"
        );
    }

    /// A controlled link for the flow-level pins below: every command
    /// answers success at once, EXCEPT the one `hold` command addressed
    /// at the "slow" session, whose response parks until `release`
    /// fires — the flow's own awaits observed at their boundary.
    fn controlled_link(
        hold: &'static str,
    ) -> (
        Arc<DaemonLink>,
        Arc<Mutex<A2aState>>,
        oneshot::Receiver<()>,
        oneshot::Sender<()>,
    ) {
        let (writer, mut requests) = mpsc::unbounded_channel::<String>();
        let (frames_tx, frames) = mpsc::unbounded_channel();
        let link = Arc::new(DaemonLink {
            client_kind: "a2a".into(),
            writer,
            pending: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            tags: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            closed_signal: Arc::new(tokio::sync::Notify::new()),
            frames: Mutex::new(frames),
            protocol_version: pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let sessions = BTreeMap::from([
            ("slow".to_string(), "ctx-slow".to_string()),
            ("fast".to_string(), "ctx-fast".to_string()),
        ]);
        let mut guard = A2aState::for_test(TaskRegistry::new(), sessions);
        guard
            .attached
            .extend(["ctx-slow".to_string(), "ctx-fast".to_string()]);
        let state = Arc::new(Mutex::new(guard));
        let (seen_tx, seen_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        tokio::spawn(async move {
            let mut seen_tx = Some(seen_tx);
            let mut release_rx = Some(release_rx);
            while let Some(line) = requests.recv().await {
                let envelope: Value = serde_json::from_str(&line).expect("the envelope parses");
                let command = envelope
                    .pointer("/command/type")
                    .and_then(Value::as_str)
                    .expect("the command name")
                    .to_string();
                let session = envelope
                    .pointer("/command/activeSessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let data = match command.as_str() {
                    "attach" => Some(json!({ "activeSessionId": session })),
                    // A new conversation's create: the answered binding
                    // the send flow registers (the session the answer
                    // names is the one the flow attaches next).
                    "create" => Some(json!({ "activeSessionId": "slow" })),
                    "withdraw_admission" => Some(json!({
                        "aborted": true,
                        "steering": [],
                        "followUp": [],
                    })),
                    "cancel_prompt_admission" => Some(json!({ "status": "cancelled" })),
                    _ => None,
                };
                let response = DaemonResponse {
                    id: envelope
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    command: command.clone(),
                    success: true,
                    error: None,
                    error_info: None,
                    data,
                };
                if command == hold && session == "slow" && release_rx.is_some() {
                    let release = release_rx.take().expect("one hold");
                    let _ = seen_tx.take().expect("one signal").send(());
                    let frames = frames_tx.clone();
                    tokio::spawn(async move {
                        let _ = release.await;
                        let _ = frames.send(LinkFrame::Response(response));
                    });
                } else {
                    let _ = frames_tx.send(LinkFrame::Response(response));
                }
            }
        });
        tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { while receive_link_frame(&link, &state).await {} }
        });
        (link, state, seen_rx, release_tx)
    }

    /// One blocking send through the real `send_message` flow.
    async fn blocking_send(
        link: &Arc<DaemonLink>,
        state: &Arc<Mutex<A2aState>>,
        context: &str,
        id: u32,
    ) -> Value {
        let params = json!({
            "message": {
                "messageId": format!("message-{id}"),
                "contextId": context,
                "role": "ROLE_USER",
                "parts": [{ "text": "prompt" }],
            }
        });
        match send_message(link, state, json!(id), params, Streaming::No).await {
            Dispatch::Reply(reply) => reply,
            Dispatch::Stream(..) => panic!("the blocking method must reply"),
        }
    }

    /// The blocking reply survives the terminal window's advance: the
    /// flow settles its task, then awaits the context's Detach — other
    /// tasks' settles prune THIS task from the 256-task retention
    /// window during that await — and the reply still carries the
    /// task's real completion from the claim the settle filled under
    /// the prune's own lock, never a fabricated verdict.
    #[tokio::test]
    async fn a_blocking_reply_survives_the_terminal_windows_advance() {
        let (link, state, seen, release) = controlled_link("detach");
        let slow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { blocking_send(&link, &state, "ctx-slow", 1).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("the held detach is the flow's own")
            .expect("the signal arrives");
        let first = {
            let guard = state.lock().await;
            guard
                .registry
                .list(Some("ctx-slow"), None, None, true, None, None, None)
                .expect("listed")
                .0[0]
                .clone()
        };
        assert_eq!(
            first.status.state,
            TaskState::Completed,
            "the task settled before the flow awaited Detach"
        );
        for id in
            2..=(u32::try_from(super::super::task::MAX_RETAINED_TERMINAL_TASKS).expect("fits") + 1)
        {
            let fast = blocking_send(&link, &state, "ctx-fast", id).await;
            assert_eq!(
                fast.pointer("/result/task/status/state")
                    .and_then(Value::as_str),
                Some("TASK_STATE_COMPLETED"),
                "the fast context's sends answer their own completions"
            );
        }
        // The window's advance prunes the waiting flow's task while
        // its Detach is held — no reader mechanism pins the row — and
        // the reply below still reads its own verdict from the claim
        // the settle filled under the prune's own lock (the
        // fabricated FAILED of a pruned row is the failure the claim
        // exists to prevent).
        assert!(
            state.lock().await.registry.task(&first.id).is_none(),
            "the window advances past the flow's task while its detach is held"
        );
        release.send(()).expect("the held detach answers");
        let answer = slow.await.expect("the flow completes");
        assert_eq!(
            answer
                .pointer("/result/task/status/state")
                .and_then(Value::as_str),
            Some("TASK_STATE_COMPLETED"),
            "retention cannot rewrite the just-finished blocking send: {answer}"
        );
        assert!(
            state.lock().await.registry.task(&first.id).is_none(),
            "the retention window stays pruned after the reply"
        );
    }

    /// The non-blocking send's HTTP handler reads its reply at its own
    /// scheduling, long after its detached flow finished: the flow's
    /// task settles, the terminal window advances past it, and the
    /// handler's reply still carries the task's own verdict — the
    /// admission's verdict claim captured it under the prune's own
    /// lock. The `returnImmediately` arm answers the
    /// `SendMessageResponse` envelope with the task's own completion,
    /// never a fabricated verdict.
    #[tokio::test]
    async fn a_delayed_return_immediately_reply_keeps_its_tasks_verdict() {
        use std::future::Future as _;
        let (link, state, seen, release) = controlled_link("wait_for_headless_completion");
        let mut handler = Box::pin(send_message(
            &link,
            &state,
            json!(101),
            json!({
                "message": {
                    "messageId": "m-admission",
                    "contextId": "ctx-slow",
                    "role": "ROLE_USER",
                    "parts": [{ "text": "prompt" }]
                },
                "configuration": { "returnImmediately": true }
            }),
            Streaming::No,
        ));
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(handler.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("the flow reaches its completion wait while its handler is not polled")
            .expect("the completion boundary");
        let victim = state
            .lock()
            .await
            .registry
            .head("ctx-slow")
            .unwrap()
            .id
            .clone();
        release.send(()).expect("the completion answers");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let settled = {
                    let guard = state.lock().await;
                    guard
                        .registry
                        .task(&victim)
                        .is_some_and(|task| task.state() == TaskState::Completed)
                };
                if settled {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the detached flow settles its task while its handler is not polled");
        {
            let mut guard = state.lock().await;
            advance_the_terminal_window(&mut guard);
            assert!(
                guard.registry.task(&victim).is_none(),
                "the admitted task was pruned before its HTTP acknowledgement read"
            );
        }
        match handler.await {
            Dispatch::Reply(reply) => assert_eq!(
                reply["result"]["task"]["status"]["state"],
                "TASK_STATE_COMPLETED",
                "the unread admission keeps the completed task's own verdict, never invents one: {reply}"
            ),
            Dispatch::Stream(..) => panic!("returnImmediately must reply"),
        }
    }

    /// The same scheduling for the streaming send: the handler resumes
    /// after its task settled and the window advanced past it, and a
    /// successful streaming method still answers SSE (spec 9.4.2) — the
    /// claimed verdict's snapshot in the first frame, its terminal
    /// frame closing a finite stream — never a JSON reply raced out of
    /// the stream shape.
    #[tokio::test]
    async fn a_delayed_streaming_reply_keeps_its_initial_sse() {
        use std::future::Future as _;
        let (link, state, seen, release) = controlled_link("wait_for_headless_completion");
        let mut handler = Box::pin(send_message(
            &link,
            &state,
            json!(102),
            json!({
                "message": {
                    "messageId": "m-stream",
                    "contextId": "ctx-slow",
                    "role": "ROLE_USER",
                    "parts": [{ "text": "prompt" }]
                }
            }),
            Streaming::Yes,
        ));
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(handler.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("the flow reaches its completion wait while its handler is not polled")
            .expect("the completion boundary");
        let victim = state
            .lock()
            .await
            .registry
            .head("ctx-slow")
            .unwrap()
            .id
            .clone();
        release.send(()).expect("the completion answers");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let settled = {
                    let guard = state.lock().await;
                    guard
                        .registry
                        .task(&victim)
                        .is_some_and(|task| task.state() == TaskState::Completed)
                };
                if settled {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the detached flow settles its task while its handler is not polled");
        {
            let mut guard = state.lock().await;
            advance_the_terminal_window(&mut guard);
            assert!(
                guard.registry.task(&victim).is_none(),
                "the admitted task was pruned before its HTTP first-frame read"
            );
        }
        match handler.await {
            Dispatch::Stream(_, first, _) => assert_eq!(
                first["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
                "the stream starts with the task's own verdict"
            ),
            Dispatch::Reply(reply) => {
                panic!("an accepted streaming send stays SSE, never a JSON reply: {reply}")
            }
        }
    }

    /// The undispatched cancel's reply survives the detach it awaits
    /// (the `UndispatchedCancel::Settled` arm): the settle answers,
    /// then the flow detaches the drained context — other contexts'
    /// completions can prune THIS task from the 256-task retention
    /// window during that await — and the reply must still carry the
    /// cancel's CANCELED verdict, never the fabricated FAILED of a
    /// snapshot read after the prune.
    #[tokio::test]
    async fn an_undispatched_cancels_reply_survives_its_detach() {
        let (link, state, seen, release) = controlled_link("detach");
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
        }
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(1), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask is non-streaming"),
                }
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("the cancel reaches its Detach")
            .expect("the boundary signal");
        assert_eq!(
            state
                .lock()
                .await
                .registry
                .snapshot("victim", None)
                .unwrap()
                .status
                .state,
            TaskState::Canceled,
            "the cancel settles CANCELED before the detach"
        );
        // The retention window advances under the held Detach: the
        // canceled task leaves the registry.
        {
            let mut guard = state.lock().await;
            for index in 0..super::super::task::MAX_RETAINED_TERMINAL_TASKS {
                let id = format!("fast-{index}");
                guard.registry.admit(
                    id.clone(),
                    "ctx-fast".into(),
                    "fast".into(),
                    None,
                    vec![Part::text("prompt")],
                );
                guard.registry.settle(&id, TaskState::Completed, None);
            }
            assert!(
                guard.registry.task("victim").is_none(),
                "the rolling terminal window pruned the canceled task"
            );
        }
        release.send(()).expect("the held detach answers");
        let answer = tokio::time::timeout(std::time::Duration::from_secs(5), cancel)
            .await
            .expect("the cancel answers")
            .unwrap();
        assert_eq!(
            answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the cancel's own verdict survives the detach it awaits: {answer}"
        );
    }

    /// The owed-work cancel's reply survives its detach (the withdraw
    /// arm): the withdrawal settles CANCELED, the snapshot reads BEFORE
    /// the post-settle Detach await, and the retention window's
    /// advance under that await can never rewrite the answer.
    #[tokio::test]
    async fn a_withdrawn_cancels_reply_survives_its_detach() {
        let (link, state, seen, release) = controlled_link("detach");
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
            guard.registry.mark_awaiting_completion("victim");
        }
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(1), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask is non-streaming"),
                }
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("the cancel reaches its Detach")
            .expect("the boundary signal");
        assert_eq!(
            state
                .lock()
                .await
                .registry
                .snapshot("victim", None)
                .unwrap()
                .status
                .state,
            TaskState::Canceled,
            "the withdrawal settles CANCELED before the detach"
        );
        {
            let mut guard = state.lock().await;
            for index in 0..super::super::task::MAX_RETAINED_TERMINAL_TASKS {
                let id = format!("fast-{index}");
                guard.registry.admit(
                    id.clone(),
                    "ctx-fast".into(),
                    "fast".into(),
                    None,
                    vec![Part::text("prompt")],
                );
                guard.registry.settle(&id, TaskState::Completed, None);
            }
            assert!(
                guard.registry.task("victim").is_none(),
                "the rolling terminal window pruned the canceled task"
            );
        }
        release.send(()).expect("the held detach answers");
        let answer = tokio::time::timeout(std::time::Duration::from_secs(5), cancel)
            .await
            .expect("the cancel answers")
            .unwrap();
        assert_eq!(
            answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the cancel's own verdict survives the detach it awaits: {answer}"
        );
    }

    /// The direct ladder cancel's reply survives its detach (the
    /// `CancelPromptAdmission` success arm): the daemon answers
    /// `cancelled`, the registry settles CANCELED, and the flow
    /// detaches the drained context — other contexts' completions can
    /// prune THIS task from the 256-task retention window during that
    /// await — and the reply must still carry the cancel's CANCELED
    /// verdict, never the fabricated FAILED of a snapshot read after
    /// the prune.
    #[tokio::test]
    async fn a_direct_cancels_reply_survives_its_detach() {
        let (link, state, seen, release) = controlled_link("detach");
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
        }
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(1), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask is non-streaming"),
                }
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("the cancel reaches its Detach")
            .expect("the boundary signal");
        assert_eq!(
            state
                .lock()
                .await
                .registry
                .snapshot("victim", None)
                .unwrap()
                .status
                .state,
            TaskState::Canceled,
            "the ladder's cancelled answer settles CANCELED before the detach"
        );
        // The retention window advances under the held Detach: the
        // canceled task leaves the registry.
        {
            let mut guard = state.lock().await;
            for index in 0..super::super::task::MAX_RETAINED_TERMINAL_TASKS {
                let id = format!("fast-{index}");
                guard.registry.admit(
                    id.clone(),
                    "ctx-fast".into(),
                    "fast".into(),
                    None,
                    vec![Part::text("prompt")],
                );
                guard.registry.settle(&id, TaskState::Completed, None);
            }
            assert!(
                guard.registry.task("victim").is_none(),
                "the rolling terminal window pruned the canceled task"
            );
        }
        release.send(()).expect("the held detach answers");
        let answer = tokio::time::timeout(std::time::Duration::from_secs(5), cancel)
            .await
            .expect("the cancel answers")
            .unwrap();
        assert_eq!(
            answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the cancel's own verdict survives the detach it awaits: {answer}"
        );
    }

    /// Advance the retention window past its bound: 256 newer terminal
    /// settles on the fast context (the fixture the late-receipt pins
    /// hold their reader through).
    fn advance_the_terminal_window(guard: &mut A2aState) {
        for index in 0..super::super::task::MAX_RETAINED_TERMINAL_TASKS {
            let id = format!("fast-{index}");
            guard.registry.admit(
                id.clone(),
                "ctx-fast".into(),
                "fast".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.settle(&id, TaskState::Completed, None);
        }
    }

    /// A late `CancelPromptAdmission` receipt cannot outlive its
    /// acceptance's verdict claim: the ladder's success response can
    /// be answered long after the task's own flow settled it (the
    /// worker's cancel of a waiting admission is prompt, the prompt
    /// waiter unwinds on its own), and other contexts' settles
    /// advance the 256-task window behind it — the settle captured
    /// the task's final snapshot into the claim under the prune's own
    /// lock, so the success arm's capture reads the task's own
    /// CANCELED verdict, never a fabricated one.
    #[tokio::test]
    async fn a_late_cancel_receipt_reads_the_tasks_own_verdict() {
        let (link, state, seen, release) = controlled_link("cancel_prompt_admission");
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
        }
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(1), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask is non-streaming"),
                }
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("the cancel reaches its ladder")
            .expect("the boundary signal");
        // The task's own flow settles CANCELED while the ladder's
        // receipt is still in flight.
        state
            .lock()
            .await
            .registry
            .settle("victim", TaskState::Canceled, None);
        {
            let mut guard = state.lock().await;
            advance_the_terminal_window(&mut guard);
            assert!(
                guard.registry.task("victim").is_none(),
                "the window advances past the task while its cancel's receipt is in flight"
            );
        }
        release.send(()).expect("the held receipt answers");
        let answer = tokio::time::timeout(std::time::Duration::from_secs(5), cancel)
            .await
            .expect("the cancel answers")
            .unwrap();
        assert_eq!(
            answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the late receipt's capture reads the task's own verdict: {answer}"
        );
    }

    /// The wait arm's reply reads the same way: a ladder receipt whose
    /// status is not the direct settle (`aborted` — the abort was
    /// accepted, the settle lands on the stream) answers through the
    /// wait, and the window's advance between the task's settle and
    /// the wait's wake prunes the task before the reply reads it —
    /// the acceptance's verdict claim, not the wait, owns the
    /// verdict's truth.
    #[tokio::test]
    async fn a_late_aborted_receipt_reads_its_own_verdict() {
        let (writer, mut requests) = mpsc::unbounded_channel::<String>();
        let (frames_tx, frames) = mpsc::unbounded_channel();
        let link = Arc::new(DaemonLink {
            client_kind: "a2a".into(),
            writer,
            pending: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            tags: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            closed_signal: Arc::new(tokio::sync::Notify::new()),
            frames: Mutex::new(frames),
            protocol_version: pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let mut guard = A2aState::for_test(
            TaskRegistry::new(),
            BTreeMap::from([
                ("slow".to_string(), "ctx-slow".to_string()),
                ("fast".to_string(), "ctx-fast".to_string()),
            ]),
        );
        guard
            .attached
            .extend(["ctx-slow".to_string(), "ctx-fast".to_string()]);
        guard.registry.admit(
            "victim".into(),
            "ctx-slow".into(),
            "slow".into(),
            None,
            vec![Part::text("prompt")],
        );
        guard.registry.mark_prompt_writing("victim");
        guard.registry.mark_prompt_dispatched("victim", None);
        let state = Arc::new(Mutex::new(guard));
        tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { while receive_link_frame(&link, &state).await {} }
        });
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(1), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask is non-streaming"),
                }
            }
        });
        // The ladder's receipt: held while the task settles and the
        // window advances under it, then answered with the abort's
        // in-flight status.
        let request: Value =
            serde_json::from_str(&requests.recv().await.expect("the ladder asks")).unwrap();
        assert_eq!(request["command"]["type"], "cancel_prompt_admission");
        state
            .lock()
            .await
            .registry
            .settle("victim", TaskState::Canceled, None);
        {
            let mut guard = state.lock().await;
            advance_the_terminal_window(&mut guard);
            assert!(
                guard.registry.task("victim").is_none(),
                "the window advances past the task while its cancel's receipt is in flight"
            );
        }
        frames_tx
            .send(LinkFrame::Response(DaemonResponse {
                id: request
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                command: "cancel_prompt_admission".into(),
                success: true,
                error: None,
                error_info: None,
                data: Some(json!({ "status": "aborted" })),
            }))
            .expect("the receipt routes");
        let answer = tokio::time::timeout(std::time::Duration::from_secs(5), cancel)
            .await
            .expect("the cancel answers")
            .unwrap();
        assert_eq!(
            answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the wait arm's reply reads the task's own verdict: {answer}"
        );
    }

    /// The withdraw arm's reply reads the same way: the withdrawal
    /// receipt can be answered long after the task's own settle (the
    /// sweep is the worker's, the receipt the supervisor's), and the
    /// window's advance behind other settles prunes the task before
    /// the arm's capture reads it — the acceptance's verdict claim
    /// carries the task's own verdict past the prune.
    #[tokio::test]
    async fn a_late_withdraw_receipt_reads_its_own_verdict() {
        let (link, state, seen, release) = controlled_link("withdraw_admission");
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
            guard.registry.mark_awaiting_completion("victim");
        }
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(1), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask is non-streaming"),
                }
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("the cancel reaches its withdrawal")
            .expect("the boundary signal");
        state
            .lock()
            .await
            .registry
            .settle("victim", TaskState::Canceled, None);
        {
            let mut guard = state.lock().await;
            advance_the_terminal_window(&mut guard);
            assert!(
                guard.registry.task("victim").is_none(),
                "the window advances past the task while its cancel's receipt is in flight"
            );
        }
        release.send(()).expect("the held receipt answers");
        let answer = tokio::time::timeout(std::time::Duration::from_secs(5), cancel)
            .await
            .expect("the cancel answers")
            .unwrap();
        assert_eq!(
            answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the withdraw arm's reply reads the task's own verdict: {answer}"
        );
    }

    /// A cancel settles the undispatched task while the flow's
    /// parked-queue resume AND idle wait are still unanswered: the
    /// resume's receipt must never sit in front of the wait's own
    /// terminal race — the blocking reply answers the cancel's verdict
    /// at once, with both responses still pending.
    #[tokio::test]
    async fn a_cancel_wakes_a_send_before_its_waits_resume_answers() {
        let (writer, requests) = mpsc::unbounded_channel::<String>();
        let (frames_tx, frames) = mpsc::unbounded_channel();
        let link = Arc::new(DaemonLink {
            client_kind: "a2a".into(),
            writer,
            pending: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            tags: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            closed_signal: Arc::new(tokio::sync::Notify::new()),
            frames: Mutex::new(frames),
            protocol_version: pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let mut guard = A2aState::for_test(
            TaskRegistry::new(),
            BTreeMap::from([("slow".to_string(), "ctx-slow".to_string())]),
        );
        guard.attached.insert("ctx-slow".to_string());
        let state = Arc::new(Mutex::new(guard));
        tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { while receive_link_frame(&link, &state).await {} }
        });
        // The responder holds BOTH the resume and the idle responses:
        // every other request answers at once.
        let (idle_seen_tx, idle_seen_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn({
            let mut requests = requests;
            let frames_tx = frames_tx.clone();
            let mut idle_seen_tx = Some(idle_seen_tx);
            async move {
                while let Some(line) = requests.recv().await {
                    let request: Value = serde_json::from_str(&line).expect("the envelope parses");
                    let command = request["command"]["type"].as_str().unwrap_or_default();
                    let mut response = DaemonResponse {
                        id: request
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        command: command.to_string(),
                        success: true,
                        error: None,
                        error_info: None,
                        data: None,
                    };
                    if command == "prompt_and_wait" {
                        response.data = Some(json!({ "output": "done" }));
                    }
                    match command {
                        // Held: the resume's receipt and the idle wait
                        // both stay unanswered for the whole pin.
                        "resume_queue" | "wait_for_idle" => {
                            if command == "wait_for_idle" {
                                if let Some(tx) = idle_seen_tx.take() {
                                    let _ = tx.send(());
                                }
                            }
                            continue;
                        }
                        _ => {}
                    }
                    frames_tx
                        .send(LinkFrame::Response(response))
                        .expect("the response routes");
                }
            }
        });
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { blocking_send(&link, &state, "ctx-slow", 1).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), idle_seen_rx)
            .await
            .expect("the flow reaches its idle wait with the resume pending")
            .expect("the boundary signal");
        // The task is undispatched: the cancel settles it directly and
        // publishes the terminal frame the flow's select races on.
        let victim = state
            .lock()
            .await
            .registry
            .head("ctx-slow")
            .unwrap()
            .id
            .clone();
        let cancel = cancel_task(&link, &state, json!(2), json!({ "id": victim })).await;
        match cancel {
            Dispatch::Reply(reply) => assert_eq!(
                reply["result"]["status"]["state"], "TASK_STATE_CANCELED",
                "the cancel settles the undispatched task: {reply}"
            ),
            Dispatch::Stream(..) => panic!("CancelTask is non-streaming"),
        }
        let answered = tokio::time::timeout(std::time::Duration::from_secs(2), flow).await;
        assert!(
            answered.is_ok(),
            "the canceled blocking send answered while its resume and idle responses were still pending"
        );
        let answer = answered.unwrap().expect("the flow completes");
        assert_eq!(
            answer
                .pointer("/result/task/status/state")
                .and_then(Value::as_str),
            Some("TASK_STATE_CANCELED"),
            "the send's reply reads the cancel's verdict: {answer}"
        );
    }

    /// The completion wait's own resume cannot park the blocking reply
    /// either: the task's prompt answered COMPLETED, the completion
    /// barrier's parked-queue resume is still unanswered, and the
    /// reply must settle without waiting for it — the resume is
    /// detached, its receipt never in front of the wait.
    #[tokio::test]
    async fn a_completed_sends_reply_does_not_wait_the_completion_resume() {
        let (writer, requests) = mpsc::unbounded_channel::<String>();
        let (frames_tx, frames) = mpsc::unbounded_channel();
        let link = Arc::new(DaemonLink {
            client_kind: "a2a".into(),
            writer,
            pending: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            tags: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            closed_signal: Arc::new(tokio::sync::Notify::new()),
            frames: Mutex::new(frames),
            protocol_version: pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let mut guard = A2aState::for_test(
            TaskRegistry::new(),
            BTreeMap::from([("slow".to_string(), "ctx-slow".to_string())]),
        );
        guard.attached.insert("ctx-slow".to_string());
        let state = Arc::new(Mutex::new(guard));
        tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { while receive_link_frame(&link, &state).await {} }
        });
        // The responder answers everything but the SECOND resume — the
        // completion barrier's — which it holds for the whole pin.
        let (resume_seen_tx, resume_seen_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn({
            let mut requests = requests;
            let frames_tx = frames_tx.clone();
            let mut resumes = 0u32;
            let mut resume_seen_tx = Some(resume_seen_tx);
            async move {
                while let Some(line) = requests.recv().await {
                    let request: Value = serde_json::from_str(&line).expect("the envelope parses");
                    let command = request["command"]["type"].as_str().unwrap_or_default();
                    let mut response = DaemonResponse {
                        id: request
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        command: command.to_string(),
                        success: true,
                        error: None,
                        error_info: None,
                        data: None,
                    };
                    if command == "prompt_and_wait" {
                        response.data = Some(json!({ "output": "done" }));
                    }
                    if command == "resume_queue" {
                        resumes += 1;
                        if resumes == 2 {
                            if let Some(tx) = resume_seen_tx.take() {
                                let _ = tx.send(());
                            }
                            // The completion barrier's resume: held.
                            continue;
                        }
                    }
                    frames_tx
                        .send(LinkFrame::Response(response))
                        .expect("the response routes");
                }
            }
        });
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { blocking_send(&link, &state, "ctx-slow", 1).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), resume_seen_rx)
            .await
            .expect("the flow reaches its completion wait's resume")
            .expect("the boundary signal");
        let answered = tokio::time::timeout(std::time::Duration::from_secs(2), flow).await;
        assert!(
            answered.is_ok(),
            "the completed send's reply waited for the completion resume's receipt"
        );
        let answer = answered.unwrap().expect("the flow completes");
        assert_eq!(
            answer
                .pointer("/result/task/status/state")
                .and_then(Value::as_str),
            Some("TASK_STATE_COMPLETED"),
            "the reply carries the task's completion: {answer}"
        );
    }

    /// A pending pre-write wait keeps re-issuing its parked-queue
    /// resume: a foreign abort that lands while the flow waits out a
    /// foreign turn re-parks the queue behind a fresh suspension, and
    /// the flow — its wait held before its own prompt is written —
    /// would wedge forever without the cadence's re-resume. The tick
    /// arm is the completion barrier's twin (the abort-during-the-wait
    /// e2e drives the whole path against the real daemon).
    #[tokio::test]
    async fn a_pending_pre_write_wait_keeps_resuming_the_parked_queue() {
        let (writer, requests) = mpsc::unbounded_channel::<String>();
        let (frames_tx, frames) = mpsc::unbounded_channel();
        let link = Arc::new(DaemonLink {
            client_kind: "a2a".into(),
            writer,
            pending: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            tags: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            closed_signal: Arc::new(tokio::sync::Notify::new()),
            frames: Mutex::new(frames),
            protocol_version: pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let mut guard = A2aState::for_test(
            TaskRegistry::new(),
            BTreeMap::from([("slow".to_string(), "ctx-slow".to_string())]),
        );
        guard.attached.insert("ctx-slow".to_string());
        let state = Arc::new(Mutex::new(guard));
        tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { while receive_link_frame(&link, &state).await {} }
        });
        // The responder answers everything but the flow's pre-write
        // idle wait, which it holds until the pin releases it — the
        // cadence's resume requests must be counted while the wait
        // pends.
        let (held_tx, held_rx) =
            tokio::sync::oneshot::channel::<tokio::sync::oneshot::Sender<()>>();
        let resumes = Arc::new(std::sync::atomic::AtomicU32::new(0));
        tokio::spawn({
            let mut requests = requests;
            let frames_tx = frames_tx.clone();
            let resumes = Arc::clone(&resumes);
            let mut held_tx = Some(held_tx);
            async move {
                while let Some(line) = requests.recv().await {
                    let request: Value = serde_json::from_str(&line).expect("the envelope parses");
                    let command = request["command"]["type"].as_str().unwrap_or_default();
                    let response = DaemonResponse {
                        id: request
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        command: command.to_string(),
                        success: true,
                        error: None,
                        error_info: None,
                        data: if command == "prompt_and_wait" {
                            Some(json!({ "output": "done" }))
                        } else {
                            None
                        },
                    };
                    if command == "resume_queue" {
                        resumes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    if command == "wait_for_idle" {
                        if let Some(tx) = held_tx.take() {
                            let frames_tx = frames_tx.clone();
                            let (release_tx, release_rx) = tokio::sync::oneshot::channel();
                            let _ = tx.send(release_tx);
                            tokio::spawn(async move {
                                let _ = release_rx.await;
                                let _ = frames_tx.send(LinkFrame::Response(response));
                            });
                            // The idle wait's response is held until
                            // the pin releases it.
                            continue;
                        }
                    }
                    frames_tx
                        .send(LinkFrame::Response(response))
                        .expect("the response routes");
                }
            }
        });
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { blocking_send(&link, &state, "ctx-slow", 1).await }
        });
        let release = tokio::time::timeout(std::time::Duration::from_secs(5), held_rx)
            .await
            .expect("the flow reaches its pre-write wait")
            .expect("the wait signal");
        // Two cadence beats while the idle wait holds: the tick's
        // re-resumes arrive on the responder's resume count.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let entry_resumes = resumes.load(std::sync::atomic::Ordering::SeqCst);
        loop {
            let counted = resumes.load(std::sync::atomic::Ordering::SeqCst);
            if counted >= entry_resumes + 2 || std::time::Instant::now() > deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let counted = resumes.load(std::sync::atomic::Ordering::SeqCst);
        release.send(()).expect("the idle wait answers");
        let answer = tokio::time::timeout(std::time::Duration::from_secs(5), flow)
            .await
            .expect("the flow completes")
            .expect("the reply arrives");
        assert_eq!(
            answer
                .pointer("/result/task/status/state")
                .and_then(Value::as_str),
            Some("TASK_STATE_COMPLETED"),
            "the reply carries the task's completion: {answer}"
        );
        assert!(
            counted >= entry_resumes + 2,
            "the pending pre-write wait re-issued its parked-queue resume on the cadence: {counted} of {entry_resumes} at entry"
        );
    }

    /// A pending completion wait keeps re-issuing its parked-queue
    /// resume: a foreign abort that lands mid-wait re-parks the queue
    /// behind a fresh suspension, and the barrier — held past the
    /// task's own turn — would wedge forever without the cadence's
    /// re-resume (the pre-write wait's tick arm carries the same
    /// recheck; the wedge e2e pins it end to end).
    #[tokio::test]
    async fn a_pending_completion_wait_keeps_resuming_the_parked_queue() {
        let (writer, requests) = mpsc::unbounded_channel::<String>();
        let (frames_tx, frames) = mpsc::unbounded_channel();
        let link = Arc::new(DaemonLink {
            client_kind: "a2a".into(),
            writer,
            pending: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            tags: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            closed_signal: Arc::new(tokio::sync::Notify::new()),
            frames: Mutex::new(frames),
            protocol_version: pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let mut guard = A2aState::for_test(
            TaskRegistry::new(),
            BTreeMap::from([("slow".to_string(), "ctx-slow".to_string())]),
        );
        guard.attached.insert("ctx-slow".to_string());
        let state = Arc::new(Mutex::new(guard));
        tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { while receive_link_frame(&link, &state).await {} }
        });
        // The responder answers everything but the completion barrier
        // itself, which a detached task holds (the loop keeps reading —
        // the cadence's resume requests must be counted while the
        // barrier pends).
        let (held_tx, held_rx) =
            tokio::sync::oneshot::channel::<tokio::sync::oneshot::Sender<()>>();
        let resumes = Arc::new(std::sync::atomic::AtomicU32::new(0));
        tokio::spawn({
            let mut requests = requests;
            let frames_tx = frames_tx.clone();
            let resumes = Arc::clone(&resumes);
            let mut held_tx = Some(held_tx);
            async move {
                while let Some(line) = requests.recv().await {
                    let request: Value = serde_json::from_str(&line).expect("the envelope parses");
                    let command = request["command"]["type"].as_str().unwrap_or_default();
                    let response = DaemonResponse {
                        id: request
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        command: command.to_string(),
                        success: true,
                        error: None,
                        error_info: None,
                        data: if command == "prompt_and_wait" {
                            Some(json!({ "output": "done" }))
                        } else {
                            None
                        },
                    };
                    if command == "resume_queue" {
                        resumes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    if command == "wait_for_headless_completion" {
                        if let Some(tx) = held_tx.take() {
                            let frames_tx = frames_tx.clone();
                            let (release_tx, release_rx) = tokio::sync::oneshot::channel();
                            let _ = tx.send(release_tx);
                            tokio::spawn(async move {
                                let _ = release_rx.await;
                                let _ = frames_tx.send(LinkFrame::Response(response));
                            });
                            // The barrier's response is held until the
                            // pin releases it.
                            continue;
                        }
                    }
                    frames_tx
                        .send(LinkFrame::Response(response))
                        .expect("the response routes");
                }
            }
        });
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { blocking_send(&link, &state, "ctx-slow", 1).await }
        });
        let release = tokio::time::timeout(std::time::Duration::from_secs(5), held_rx)
            .await
            .expect("the flow reaches its completion barrier")
            .expect("the barrier signal");
        // Two cadence beats while the barrier holds: the tick's
        // re-resumes arrive on the responder's resume count.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let entry_resumes = resumes.load(std::sync::atomic::Ordering::SeqCst);
        loop {
            let counted = resumes.load(std::sync::atomic::Ordering::SeqCst);
            if counted >= entry_resumes + 2 || std::time::Instant::now() > deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let counted = resumes.load(std::sync::atomic::Ordering::SeqCst);
        release.send(()).expect("the barrier answers");
        let answer = tokio::time::timeout(std::time::Duration::from_secs(5), flow)
            .await
            .expect("the flow completes")
            .expect("the reply arrives");
        assert_eq!(
            answer
                .pointer("/result/task/status/state")
                .and_then(Value::as_str),
            Some("TASK_STATE_COMPLETED"),
            "the reply carries the task's completion: {answer}"
        );
        assert!(
            counted >= entry_resumes + 2,
            "the pending completion wait re-issued its parked-queue resume on the cadence: {counted} of {entry_resumes} at entry"
        );
    }

    /// One waiting task never buffers one `ResumeQueue` line per
    /// cadence tick against a link whose peer stopped draining: the
    /// detached resume keeps ONE outstanding request per session — a
    /// tick behind the marker skips, and the request's own timeout
    /// re-issues the next one, so the writer queue stays bounded by
    /// the request's liveness clock instead of the wait's cadence
    /// (the uncapped idle wait would otherwise park for the whole
    /// 300 virtual seconds below).
    #[tokio::test(start_paused = true)]
    async fn a_stalled_link_never_buffers_unlimited_resumes() {
        let (writer, requests) = mpsc::unbounded_channel::<String>();
        let (_frames_tx, frames) = mpsc::unbounded_channel();
        let link = Arc::new(DaemonLink {
            client_kind: "a2a".into(),
            writer,
            pending: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            tags: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            closed_signal: Arc::new(tokio::sync::Notify::new()),
            frames: Mutex::new(frames),
            protocol_version: pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let mut guard = A2aState::for_test(
            TaskRegistry::new(),
            BTreeMap::from([("slow".to_string(), "ctx-slow".to_string())]),
        );
        guard.attached.insert("ctx-slow".to_string());
        let state = Arc::new(Mutex::new(guard));
        let reply = send_message(
            &link,
            &state,
            json!(103),
            json!({
                "message": {
                    "messageId": "m-stalled-link", "contextId": "ctx-slow",
                    "role": "ROLE_USER", "parts": [{ "text": "prompt" }]
                },
                "configuration": { "returnImmediately": true }
            }),
            Streaming::No,
        )
        .await;
        assert!(matches!(reply, Dispatch::Reply(_)));
        // The first idle wait and its first resume have been written.
        while requests.len() < 2 {
            tokio::task::yield_now().await;
        }
        // The link writer stopped behind a blocked socket: no queued
        // line is consumed, although the connection is open.
        for _ in 0..600 {
            tokio::time::advance(PARKED_QUEUE_RECHECK).await;
            tokio::task::yield_now().await;
        }
        let queued = requests.len();
        assert!(
            queued <= 64,
            "one waiting task must not buffer resumes forever when its writer cannot drain: queued={queued}"
        );
    }

    /// A `CancelTask` ends the blocking send's post-response completion
    /// wait: the flow races the session-wide headless barrier against
    /// the task's own terminal settle (the same terminal signal the
    /// pre-write idle wait races), so the blocking reply answers the
    /// cancel's CANCELED snapshot at once — never parked until an
    /// unrelated continuation barrier ends.
    #[tokio::test]
    async fn a_cancel_ends_the_blocking_completion_wait() {
        let (link, state, seen, release) = controlled_link("wait_for_headless_completion");
        let mut slow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { blocking_send(&link, &state, "ctx-slow", 1).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("the held completion wait is the flow's own")
            .expect("the signal arrives");
        let task = {
            let guard = state.lock().await;
            guard
                .registry
                .list(Some("ctx-slow"), None, None, true, None, None, None)
                .expect("listed")
                .0[0]
                .clone()
        };
        let cancel = cancel_task(&link, &state, json!(2), json!({ "id": task.id })).await;
        let Dispatch::Reply(cancel) = cancel else {
            panic!("the cancel replies")
        };
        assert_eq!(
            cancel
                .pointer("/result/status/state")
                .and_then(Value::as_str),
            Some("TASK_STATE_CANCELED"),
            "the cancel settles the owed task: {cancel}"
        );
        let answered = tokio::time::timeout(std::time::Duration::from_millis(100), &mut slow).await;
        let returned = answered.is_ok();
        release.send(()).expect("the held completion answers");
        let final_reply = match answered {
            Ok(reply) => reply.expect("the flow completes"),
            Err(_) => slow.await.expect("the flow completes after the release"),
        };
        assert_eq!(
            final_reply
                .pointer("/result/task/status/state")
                .and_then(Value::as_str),
            Some("TASK_STATE_CANCELED"),
            "the blocking send answers the cancel's own verdict: {final_reply}"
        );
        assert!(
            returned,
            "the blocking send answered without waiting the session-wide completion barrier out"
        );
    }

    /// A response-driven context re-key (an idle-detached context's
    /// re-open) retires the abandoned session id's TURN-WINDOW entry
    /// with its routing and run entries: the binding notification that
    /// normally cleans the pump-side tables cannot reach a detached
    /// context, so every re-open would leave another unreachable
    /// window behind — parked assistant text included — and only the
    /// latest id ever got cleaned.
    #[tokio::test]
    async fn turn_windows_leave_with_an_attach_rekey() {
        let (link, state, _seen, _release) = controlled_link("unused");
        let mut previous = "slow".to_string();
        for index in 0..512 {
            for event in [
                json!({"type": "agent_start", "clientAdmissionId": "foreign"}),
                json!({ "type": "turn_start" }),
                json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "old foreign answer" }]
                    }
                }),
                json!({ "type": "turn_end" }),
                json!({ "type": "agent_end" }),
            ] {
                on_session_event(
                    &state,
                    &json!({
                        "type": "session_event",
                        "activeSessionId": previous,
                        "event": event,
                    }),
                )
                .await;
            }
            let next = format!("slow-rehost-{index}");
            rekey_context_session(
                &state,
                "ctx-slow",
                &DaemonResponse {
                    id: None,
                    command: "create".into(),
                    success: true,
                    error: None,
                    error_info: None,
                    data: Some(json!({ "activeSessionId": next })),
                },
            )
            .await;
            previous = next;
        }
        state.lock().await.touch_context("ctx-slow");
        assert!(
            evict_one_idle_context(&link, &state).await,
            "the final live binding is evicted"
        );
        let guard = state.lock().await;
        let debug = format!("{:?}", guard.windows);
        let windows = debug.matches("TurnWindow {").count();
        assert!(
            !guard.contexts.contains_key("ctx-slow"),
            "the eviction removed the context"
        );
        assert_eq!(
            windows, 0,
            "the abandoned session ids' windows leave with their re-keys: {windows} windows remain"
        );
    }

    /// A blocking send parked at its headless-completion wait keeps
    /// its reply's verdict across the terminal retention window's
    /// advance: the task can settle while it waits (a concurrent
    /// `CancelTask` runs exactly this settle on the owed work) and 256
    /// other tasks' settles prune the row under it, and the reply
    /// that wakes reads the task's own verdict and artifact from the
    /// claim the settle filled under the prune's own lock — never a
    /// fabricated verdict.
    #[tokio::test]
    async fn a_blocking_reply_survives_pruning_before_its_wait_wakes() {
        let (link, state, seen, _release) = controlled_link("wait_for_headless_completion");
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { blocking_send(&link, &state, "ctx-slow", 1).await }
        });
        seen.await
            .expect("the blocking send reached its completion wait");
        let victim = {
            let guard = state.lock().await;
            guard.registry.head("ctx-slow").unwrap().id.clone()
        };
        {
            let mut guard = state.lock().await;
            guard.registry.set_artifact_text(&victim, "OWN-ANSWER");
            // The concurrent CancelTask withdraw-success arm performs
            // this exact settle while the blocking send waits.
            guard.registry.settle(&victim, TaskState::Canceled, None);
            for index in 0..super::super::task::MAX_RETAINED_TERMINAL_TASKS {
                let id = format!("fast-{index}");
                guard.registry.admit(
                    id.clone(),
                    "ctx-fast".into(),
                    "fast".into(),
                    None,
                    vec![Part::text("fast")],
                );
                guard.registry.settle(&id, TaskState::Completed, None);
            }
            assert!(
                guard.registry.task(&victim).is_none(),
                "the window advances past the flow's just-canceled task while it waits"
            );
        }
        let answer = tokio::time::timeout(std::time::Duration::from_secs(5), flow)
            .await
            .expect("the terminal stream wakes the flow")
            .unwrap();
        assert_eq!(
            answer
                .pointer("/result/task/status/state")
                .and_then(Value::as_str),
            Some("TASK_STATE_CANCELED"),
            "the blocking reply keeps its actual cancel verdict: {answer}"
        );
        assert_eq!(
            answer
                .pointer("/result/task/artifacts/0/parts/0/text")
                .and_then(Value::as_str),
            Some("OWN-ANSWER"),
            "the reply carries the task's own artifact: {answer}"
        );
        // The row stays pruned: the reply answered from the claim, and
        // no reader mechanism re-enters the task into the window.
        assert!(
            state.lock().await.registry.task(&victim).is_none(),
            "the retention window stays pruned after the reply"
        );
    }

    /// The undispatched cancel's settle and its reply capture run under
    /// ONE registry guard: a competing cancel's own settle between the
    /// two locks would advance the terminal retention window past the
    /// just-canceled task before this arm reads it — and the answer
    /// would fabricate FAILED for a task it canceled itself. The
    /// choreography drives the real `cancel_task` with 256 mutex
    /// waiters queued between its settle and its capture.
    #[tokio::test]
    async fn an_undispatched_cancels_verdict_survives_competing_settles() {
        use std::future::Future as _;
        let (link, state, _, _) = controlled_link("never");
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            for index in 0..super::super::task::MAX_RETAINED_TERMINAL_TASKS {
                guard.registry.admit(
                    format!("other-{index}"),
                    "ctx-fast".into(),
                    "fast".into(),
                    None,
                    vec![Part::text("prompt")],
                );
            }
        }
        let held = state.lock().await;
        let cancel = cancel_task(&link, &state, json!(7), json!({ "id": "victim" }));
        tokio::pin!(cancel);
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(cancel.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        let gate = state.lock();
        tokio::pin!(gate);
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(gate.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        drop(held);
        // The cancel's settle-undispatched lock is next; its 256
        // settle-undispatched waiters queue behind it.
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(cancel.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        let gate_guard = gate.await;
        let mut prunes = Vec::new();
        for index in 0..super::super::task::MAX_RETAINED_TERMINAL_TASKS {
            let state = Arc::clone(&state);
            let mut prune = Box::pin(async move {
                let mut guard = state.lock().await;
                assert_eq!(
                    guard
                        .registry
                        .settle_undispatched(&format!("other-{index}")),
                    super::super::task::UndispatchedCancel::Settled
                );
            });
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(prune.as_mut().poll(cx)))
                    .await
                    .is_pending()
            );
            prunes.push(prune);
        }
        drop(gate_guard);
        // The 256 competing settles all land while the cancel holds its
        // own capture.
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(cancel.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        for prune in prunes {
            prune.await;
        }
        let answer = match cancel.await {
            Dispatch::Reply(reply) => reply,
            Dispatch::Stream(..) => panic!("CancelTask is non-streaming"),
        };
        assert_eq!(
            answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the cancel's snapshot capture is atomic with its settle: {answer}"
        );
    }

    /// A stalled daemon link never queues a second `ResumeQueue` line:
    /// the resume's coalescing marker clears on the request's actual
    /// completion — its response, or the link's close — never on the
    /// response timeout. The timeout reclaims only the pending-response
    /// slot, not the line the unbounded writer still owes the stalled
    /// peer, so a timeout that cleared the marker would queue one
    /// stale line every timeout, forever; the untimed exchange holds
    /// exactly one outstanding request against a peer that never
    /// answers instead (and a peer that recovers answers it, letting
    /// the cadence resume). The cadence ticks past dozens of the old
    /// 30-second timeouts across the run.
    #[tokio::test(start_paused = true)]
    async fn a_stalled_daemon_links_parked_queue_resume_never_queues_another() {
        let (writer, requests) = mpsc::unbounded_channel::<String>();
        let (_frames_tx, frames) = mpsc::unbounded_channel();
        let link = Arc::new(DaemonLink {
            client_kind: "a2a".into(),
            writer,
            pending: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            tags: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            closed_signal: Arc::new(tokio::sync::Notify::new()),
            frames: Mutex::new(frames),
            protocol_version: pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let state = Arc::new(Mutex::new(A2aState::for_test(
            TaskRegistry::new(),
            BTreeMap::new(),
        )));
        for _ in 0..12_000 {
            resume_parked_queue_detached(&link, &state, "slow").await;
            tokio::task::yield_now().await;
            tokio::time::advance(PARKED_QUEUE_RECHECK).await;
            tokio::task::yield_now().await;
        }
        assert!(
            requests.len() <= 1,
            "one stalled session holds one outstanding resume, never one stale line per timeout: {} queued",
            requests.len()
        );
    }

    /// Failed cancels leave no live verdict claim either: 512
    /// completed -32002 replies mean 512 dropped claims, and the
    /// non-owning registrations prune — the awaiting task retains
    /// nothing for its eventual settle to snapshot per dead reader.
    #[tokio::test]
    async fn failed_cancels_leave_no_live_verdict_claims() {
        let (writer, mut requests) = mpsc::unbounded_channel::<String>();
        let (frames_tx, frames) = mpsc::unbounded_channel();
        let link = Arc::new(DaemonLink {
            client_kind: "a2a".into(),
            writer,
            pending: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            tags: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            closed_signal: Arc::new(tokio::sync::Notify::new()),
            frames: Mutex::new(frames),
            protocol_version: pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let mut registry = TaskRegistry::new();
        registry.admit(
            "victim".into(),
            "ctx".into(),
            "s".into(),
            None,
            vec![Part::text("prompt")],
        );
        registry.mark_prompt_writing("victim");
        registry.mark_prompt_dispatched("victim", None);
        registry.mark_awaiting_completion("victim");
        let state = Arc::new(Mutex::new(A2aState::for_test(
            registry,
            BTreeMap::from([("s".to_string(), "ctx".to_string())]),
        )));
        // The responder answers every command with the worker's
        // refused withdrawal (a failed receipt): the honest -32002 the
        // failed cancel path answers, never a settled verdict — a
        // successful withdrawal settles the task CANCELED at once (the
        // work it delegated keeps running), and the leaked-claim check
        // would read a settled task's counts instead.
        tokio::spawn(async move {
            while let Some(line) = requests.recv().await {
                let envelope: Value = serde_json::from_str(&line).expect("the envelope parses");
                let response = DaemonResponse {
                    id: envelope
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    command: envelope
                        .pointer("/command/type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    success: false,
                    error: None,
                    error_info: None,
                    data: Some(json!({ "aborted": false, "steering": [], "followUp": [] })),
                };
                let _ = frames_tx.send(LinkFrame::Response(response));
            }
        });
        let pump = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { while receive_link_frame(&link, &state).await {} }
        });
        for request in 0..512 {
            match cancel_task(&link, &state, json!(request), json!({ "id": "victim" })).await {
                Dispatch::Reply(reply) => assert_eq!(
                    reply["error"]["code"], -32002,
                    "the no-op withdrawal refuses the cancel honestly: {reply}"
                ),
                Dispatch::Stream(..) => panic!("a cancel failure replies"),
            }
        }
        pump.abort();
        let guard = state.lock().await;
        let entry = guard.registry.task("victim").expect("the task stays live");
        let (live, registered) = entry.verdict_claim_counts();
        assert_eq!(
            live, 0,
            "no live request owns these captures: {registered} registered"
        );
    }

    /// proto3's non-optional scalars serialize their explicit defaults
    /// exactly like an omission (spec 5.7: only `optional` fields carry
    /// presence): a client DTO that always writes `contextId`,
    /// `status`, and `pageToken` sends `""`/`TASK_STATE_UNSPECIFIED`
    /// where the spec means "no filter"/"page one" — the empty
    /// pageToken starts the walk instead of answering the foreign-token
    /// -32602, and the empty context and the unspecified status list
    /// everything instead of nothing.
    #[tokio::test]
    async fn proto_default_valued_list_filters_read_as_omissions() {
        let registry = TaskRegistry::new();
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, BTreeMap::new())));
        for (task, context) in [("t-1", "ctx-a"), ("t-2", "ctx-a"), ("t-3", "ctx-b")] {
            state.lock().await.registry.admit(
                task.into(),
                context.into(),
                format!("{context}-active"),
                None,
                vec![Part::text("prompt")],
            );
            state
                .lock()
                .await
                .registry
                .settle(task, TaskState::Completed, None);
        }
        let total_of = |params: Value| {
            let state = Arc::clone(&state);
            async move {
                match list_tasks(&state, json!(1), params).await {
                    Dispatch::Reply(reply) => reply["result"]["totalSize"]
                        .as_u64()
                        .expect("the list answers a page: {reply:?}"),
                    Dispatch::Stream(..) => panic!("ListTasks is non-streaming"),
                }
            }
        };
        assert_eq!(
            total_of(json!({})).await,
            3,
            "the omitted-filter control lists every retained task"
        );
        assert_eq!(
            total_of(json!({ "pageToken": "" })).await,
            3,
            "an explicit empty pageToken is page one, never a foreign-token -32602"
        );
        assert_eq!(
            total_of(json!({ "contextId": "" })).await,
            3,
            "an explicit empty contextId filters nothing"
        );
        assert_eq!(
            total_of(json!({ "status": "TASK_STATE_UNSPECIFIED" })).await,
            3,
            "the unspecified status is the spec's no-filter default"
        );
        // The REAL filter still filters (a default-valued DTO must not
        // have relaxed the named filters).
        assert_eq!(
            total_of(json!({ "contextId": "ctx-a" })).await,
            2,
            "a named context still scopes the page"
        );
        assert_eq!(
            total_of(json!({ "status": "TASK_STATE_COMPLETED" })).await,
            3,
            "a named status still filters"
        );
    }

    /// An out-of-range `pageSize` answers the named invalid parameter
    /// (spec 6.5: the bound is 1..=100): the value-level check rides
    /// beside the u32 parse — a negative size already fails the parse,
    /// and a 0 or 150 would otherwise clamp silently into a page the
    /// client cannot tell from the one it asked for.
    #[tokio::test]
    async fn an_out_of_range_list_page_size_answers_the_named_violation() {
        let registry = TaskRegistry::new();
        let state = Arc::new(Mutex::new(A2aState::for_test(registry, BTreeMap::new())));
        for index in 0..150 {
            let task = format!("page-{index}");
            let context = format!("ctx-page-{}", index % 3);
            state.lock().await.registry.admit(
                task.clone(),
                context.clone(),
                "ctx-page-active".into(),
                None,
                vec![Part::text("prompt")],
            );
            state
                .lock()
                .await
                .registry
                .settle(&task, TaskState::Completed, None);
        }
        for size in [0u64, 150] {
            let reply = match list_tasks(&state, json!(1), json!({ "pageSize": size })).await {
                Dispatch::Reply(reply) => reply,
                Dispatch::Stream(..) => panic!("ListTasks is non-streaming"),
            };
            assert_eq!(
                reply["error"]["code"], -32602,
                "the out-of-range pageSize is an invalid parameter: {reply}"
            );
            let violation = &reply["error"]["data"][0]["fieldViolations"][0];
            assert_eq!(
                violation["field"], "pageSize",
                "the violation names the field: {reply}"
            );
            assert!(
                violation["description"]
                    .as_str()
                    .is_some_and(|message| message.contains(&format!("got {size}"))),
                "the violation reports the value: {reply}"
            );
        }
        let in_range = match list_tasks(&state, json!(2), json!({ "pageSize": 100 })).await {
            Dispatch::Reply(reply) => reply,
            Dispatch::Stream(..) => panic!("ListTasks is non-streaming"),
        };
        assert_eq!(
            in_range["result"]["tasks"].as_array().map(Vec::len),
            Some(100),
            "the in-range bound serves its page: {in_range}"
        );
        assert_eq!(
            in_range["result"]["totalSize"], 150,
            "the walk keeps the whole count: {in_range}"
        );
    }

    /// A completed idle exchange stays observable for a subscriber that
    /// arrives after it answered: the detached owner can finish the
    /// whole exchange before the first waiter subscribes on the
    /// multi-thread runtime, so a publication that drops the value
    /// while no receiver exists would leave a live barrier holding
    /// `None` forever — a blocking send hung on an exchange the daemon
    /// already answered.
    #[tokio::test]
    async fn a_completed_idle_exchange_stays_observable_for_a_late_subscriber() {
        let (link, state, _, _) = controlled_link("never");
        let barrier = idle_barrier(&link, &state, "slow").await;
        assert_eq!(barrier.answer.receiver_count(), 0);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while Arc::strong_count(&barrier) > 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the actual detached owner completed its idle exchange");
        let mut idle = barrier.subscribe();
        let answer = idle.borrow().clone();
        let next = tokio::time::timeout(std::time::Duration::from_millis(50), idle.changed()).await;
        assert_eq!(
            answer,
            Some(Ok(())),
            "the completed idle exchange must remain observable: future_change={next:?}"
        );
    }

    /// The daemon's own run can answer before the flow's dispatch mark
    /// lands (the writer makes the prompt line visible first): the
    /// frames credit to the head the pump classes from its write claim,
    /// so the reply parks and the response's claim step keeps it — the
    /// task's answer survives its own turn racing the mark.
    #[tokio::test]
    async fn a_run_racing_the_dispatch_mark_keeps_its_reply() {
        let (link, state, _, _) = controlled_link("never");
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                Some("message".into()),
                vec![Part::text("prompt")],
            );
            assert!(guard.registry.mark_prompt_writing("victim"));
        }
        let anchor = state.lock().await.windows.next_seq("slow");
        for event in [
            json!({"type":"agent_start", "admissionId":"wire", "clientAdmissionId":"victim", "engineContinuation":false}),
            json!({"type":"turn_start"}),
            json!({"type":"message_start", "message":{"role":"assistant","content":[]}}),
            json!({"type":"message_update", "assistantMessageEvent":{"type":"text_delta","delta":"OWN-ANSWER"}}),
            json!({"type":"message_end", "message":{"role":"assistant","content":[{"type":"text","text":"OWN-ANSWER"}]}}),
            json!({"type":"turn_end"}),
            json!({"type":"agent_end"}),
        ] {
            on_session_event(
                &state,
                &json!({"type":"session_event","activeSessionId":"slow","event":event}),
            )
            .await;
        }
        state
            .lock()
            .await
            .registry
            .mark_prompt_dispatched("victim", Some(anchor));
        settle_prompt_at_pump(&state, "victim", true).await;
        finalize_response_settle(&state, "victim", TaskState::Completed, None).await;
        let answer = state
            .lock()
            .await
            .registry
            .snapshot("victim", None)
            .unwrap();
        assert_eq!(
            answer
                .artifacts
                .first()
                .and_then(|a| a.parts.first())
                .and_then(|p| p.text.as_deref()),
            Some("OWN-ANSWER"),
            "the daemon's own run replied before the post-write mark: {answer:?}"
        );
        drop(link);
    }

    /// The ordered control of the same run: the mark precedes the
    /// frames, and the reply keeps identically.
    #[tokio::test]
    async fn a_dispatched_head_keeps_the_run_reply_in_order() {
        let (link, state, _, _) = controlled_link("never");
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                Some("message".into()),
                vec![Part::text("prompt")],
            );
            assert!(guard.registry.mark_prompt_writing("victim"));
            guard.registry.mark_prompt_dispatched("victim", None);
        }
        let anchor = state.lock().await.windows.next_seq("slow");
        for event in [
            json!({"type":"agent_start", "admissionId":"wire", "clientAdmissionId":"victim", "engineContinuation":false}),
            json!({"type":"turn_start"}),
            json!({"type":"message_start", "message":{"role":"assistant","content":[]}}),
            json!({"type":"message_update", "assistantMessageEvent":{"type":"text_delta","delta":"OWN-ANSWER"}}),
            json!({"type":"message_end", "message":{"role":"assistant","content":[{"type":"text","text":"OWN-ANSWER"}]}}),
            json!({"type":"turn_end"}),
            json!({"type":"agent_end"}),
        ] {
            on_session_event(
                &state,
                &json!({"type":"session_event","activeSessionId":"slow","event":event}),
            )
            .await;
        }
        let _ = anchor;
        settle_prompt_at_pump(&state, "victim", true).await;
        finalize_response_settle(&state, "victim", TaskState::Completed, None).await;
        let answer = state
            .lock()
            .await
            .registry
            .snapshot("victim", None)
            .unwrap();
        assert_eq!(
            answer
                .artifacts
                .first()
                .and_then(|a| a.parts.first())
                .and_then(|p| p.text.as_deref()),
            Some("OWN-ANSWER"),
            "the ordered dispatch control must retain the same daemon reply: {answer:?}"
        );
        drop(link);
    }

    /// An accepted withdrawal is the ONE authority over the task's
    /// terminal verdict: the continuation it aborted closes while the
    /// receipt is still in flight, and the completion settle parks its
    /// verdict behind the in-flight withdrawal instead of publishing —
    /// the receipt settles CANCELED as the FIRST terminal verdict, the
    /// parked one dies unpublished, and the live stream's terminal
    /// frame, the captured claim, and the cancel's reply all report
    /// the same state.
    #[tokio::test]
    async fn an_accepted_withdrawal_publishes_one_verdict_the_stream_reports() {
        let (link, state, seen, release) = controlled_link("withdraw_admission");
        let claim = {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                Some("message".into()),
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
            guard.registry.mark_awaiting_completion("victim");
            guard.registry.claim_verdict("victim", None).unwrap()
        };
        let stream = match subscribe_to_task(&state, json!(2), json!({ "id": "victim" })).await {
            Dispatch::Stream(_, _, stream) => stream,
            Dispatch::Reply(reply) => panic!("live subscription refused: {reply}"),
        };
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { cancel_task(&link, &state, json!(3), json!({ "id": "victim" })).await }
        });
        seen.await
            .expect("withdraw accepted before its held answer");
        state.lock().await.registry.continuation_run_closed(
            "victim",
            None,
            Some(ABORTED_TURN_SETTLE_ERROR),
        );
        finalize_response_settle(&state, "victim", TaskState::Completed, None).await;
        // The settle parked its verdict behind the in-flight withdrawal;
        // the receipt publishes the one terminal verdict.
        release.send(()).expect("withdraw answer released");
        let mut stream = stream;
        let terminal = stream.recv().await.expect("the receipt's terminal frame");
        assert!(
            stream.recv().await.is_none(),
            "the terminal frame closed the stream"
        );
        let reply = match cancel.await.unwrap() {
            Dispatch::Reply(reply) => reply,
            Dispatch::Stream(..) => panic!("cancel replies"),
        };
        let captured = claim.captured().unwrap();
        let StreamResponse::StatusUpdate(event) = terminal else {
            panic!("expected a terminal status update");
        };
        assert_eq!(
            serde_json::to_value(event.status.state).unwrap(),
            reply["result"]["status"]["state"],
            "the stream, the captured claim ({:?}), and the cancel must report one terminal verdict",
            captured.status.state
        );
        assert_eq!(
            reply["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the accepted withdrawal owns the verdict: {reply}"
        );
    }

    /// The same accepted withdrawal after the retention window advanced
    /// past the task: the verdict claim captured the CANCELED at the
    /// settle, so the cancel's reply answers the same one verdict the
    /// stream already reported — never the stale FAILED a row rewrite
    /// would have missed.
    #[tokio::test]
    async fn an_accepted_withdrawals_verdict_claim_survives_the_retention_window() {
        let (link, state, seen, release) = controlled_link("withdraw_admission");
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                Some("message".into()),
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
            guard.registry.mark_awaiting_completion("victim");
        }
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { cancel_task(&link, &state, json!(3), json!({ "id": "victim" })).await }
        });
        seen.await
            .expect("withdraw accepted before its held answer");
        state.lock().await.registry.continuation_run_closed(
            "victim",
            None,
            Some(ABORTED_TURN_SETTLE_ERROR),
        );
        finalize_response_settle(&state, "victim", TaskState::Completed, None).await;
        release.send(()).expect("withdraw answer released");
        // The receipt published the CANCELED as the first verdict and
        // captured it into the reply's claim; the retention window's
        // advance past the settled row must not change the answer.
        {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !state
                .lock()
                .await
                .registry
                .task("victim")
                .is_some_and(|task| task.state().is_terminal())
            {
                assert!(
                    std::time::Instant::now() < deadline,
                    "the receipt never settled"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
        {
            let mut guard = state.lock().await;
            advance_the_terminal_window(&mut guard);
            assert!(guard.registry.task("victim").is_none());
        }
        let reply = match cancel.await.unwrap() {
            Dispatch::Reply(reply) => reply,
            Dispatch::Stream(..) => panic!("cancel replies"),
        };
        assert_eq!(
            reply["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the verdict claim keeps the accepted withdrawal's cancel outcome: {reply}"
        );
    }

    /// A daemon link the test drives by hand: every request envelope
    /// lands on the returned channel for assertion, and the test
    /// answers each command itself — held or immediate — through the
    /// frame writer. The double never invents a response body: the
    /// withdrawal-receipt and completion-barrier probes pin exactly
    /// what the worker answers, and the envelopes stay assertable.
    fn scripted_peer(
        sessions: &[(&'static str, &'static str)],
    ) -> (
        Arc<DaemonLink>,
        Arc<Mutex<A2aState>>,
        mpsc::UnboundedReceiver<String>,
        mpsc::UnboundedSender<LinkFrame>,
    ) {
        let (writer, requests) = mpsc::unbounded_channel::<String>();
        let (frames_tx, frames) = mpsc::unbounded_channel();
        let link = Arc::new(DaemonLink {
            client_kind: "a2a".into(),
            writer,
            pending: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            tags: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            closed_signal: Arc::new(tokio::sync::Notify::new()),
            frames: Mutex::new(frames),
            protocol_version: pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            next_request_id: std::sync::atomic::AtomicU64::new(0),
        });
        let mut guard = A2aState::for_test(
            TaskRegistry::new(),
            sessions
                .iter()
                .map(|(session, context)| (session.to_string(), context.to_string()))
                .collect(),
        );
        for (_, context) in sessions {
            guard.attached.insert(context.to_string());
        }
        let state = Arc::new(Mutex::new(guard));
        let pump_link = Arc::clone(&link);
        let pump_state = Arc::clone(&state);
        tokio::spawn(async move { while receive_link_frame(&pump_link, &pump_state).await {} });
        (link, state, requests, frames_tx)
    }

    /// Answer one recorded request with a success envelope carrying
    /// `data` (the double never invents an error; the refusal probes
    /// build their own `DaemonResponse`).
    fn peer_reply(frames: &mpsc::UnboundedSender<LinkFrame>, request: &Value, data: Option<Value>) {
        frames
            .send(LinkFrame::Response(DaemonResponse {
                id: request["id"].as_str().map(str::to_string),
                command: request["command"]["type"]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                success: true,
                error: None,
                error_info: None,
                data,
            }))
            .expect("the frame channel stays open");
    }

    /// Wait for the named command's request envelope, answering every
    /// other command the flow dispatches meanwhile (the completion
    /// wait's `resume_queue` cadence, the idle `detach`) so the held
    /// command's probe never wedges on a side request.
    async fn held_command(
        requests: &mut mpsc::UnboundedReceiver<String>,
        frames: &mpsc::UnboundedSender<LinkFrame>,
        expected: &str,
    ) -> Value {
        loop {
            let line = tokio::time::timeout(std::time::Duration::from_secs(5), requests.recv())
                .await
                .expect("the expected command is dispatched")
                .expect("the link stays open");
            let request: Value = serde_json::from_str(&line).expect("the envelope parses");
            if request["command"]["type"] == expected {
                return request;
            }
            peer_reply(frames, &request, None);
        }
    }

    /// Answer every further command the flows dispatch (the cancel's
    /// idle `detach`), until the test drops its halves.
    fn drain_and_reply(
        mut requests: mpsc::UnboundedReceiver<String>,
        frames: mpsc::UnboundedSender<LinkFrame>,
    ) {
        tokio::spawn(async move {
            while let Some(line) = requests.recv().await {
                if let Ok(request) = serde_json::from_str::<Value>(&line) {
                    peer_reply(&frames, &request, None);
                }
            }
        });
    }

    /// One hand-admitted task awaiting its completion: the state every
    /// withdrawal-receipt probe stands on.
    async fn peer_task_awaiting_completion(state: &Arc<Mutex<A2aState>>, task_id: &str) {
        let mut guard = state.lock().await;
        guard.registry.admit(
            task_id.into(),
            "ctx-slow".into(),
            "slow".into(),
            None,
            vec![Part::text("prompt")],
        );
        guard.registry.mark_prompt_writing(task_id);
        guard.registry.mark_prompt_dispatched(task_id, None);
        guard.registry.mark_awaiting_completion(task_id);
    }

    /// A completion that races the withdrawal's receipt never publishes:
    /// the completion barrier can release BEFORE the receipt (the task
    /// spawns children; the child settles while the receipt still
    /// travels), and the settle that follows parks its verdict behind
    /// the in-flight withdrawal instead of publishing a COMPLETED the
    /// receipt could never revise — the successful receipt settles the
    /// CANCELED the client asked for as the FIRST terminal verdict
    /// (the children window's shape: the sweep names nothing, the
    /// cancel still stops the task), the parked verdict dies
    /// unpublished, and the live stream's terminal frame reports the
    /// same one verdict.
    #[tokio::test]
    async fn a_completion_racing_the_withdrawal_receipt_never_publishes() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        peer_task_awaiting_completion(&state, "victim").await;
        let mut stream = state
            .lock()
            .await
            .registry
            .subscribe("victim")
            .expect("the live task subscribes");
        let settle = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                settle_from_response(
                    &link,
                    &state,
                    "victim",
                    DaemonResponse {
                        id: None,
                        command: "prompt_and_wait".into(),
                        success: true,
                        data: None,
                        error: None,
                        error_info: None,
                    },
                )
                .await;
            }
        });
        let barrier = held_command(&mut requests, &frames, "wait_for_headless_completion").await;
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(10), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let withdrawal = held_command(&mut requests, &frames, "withdraw_admission").await;
        let delivery = state
            .lock()
            .await
            .registry
            .task("victim")
            .expect("the admitted task")
            .delivery_id()
            .to_string();
        assert_eq!(
            withdrawal["command"]["admissionId"], delivery,
            "the withdraw names the task's delivery identity, never the public id: {withdrawal}"
        );
        assert!(
            state.lock().await.registry.withdraw_inflight("victim"),
            "the withdraw arm opened the in-flight mark"
        );
        // The completion barrier releases BEFORE the withdrawal's
        // receipt (the task's child settled while the receipt still
        // travels): no parent run aborted, so nothing but the receipt
        // decides the verdict.
        peer_reply(&frames, &barrier, Some(json!({})));
        settle.await.expect("the settle completes");
        let parked = state
            .lock()
            .await
            .registry
            .task("victim")
            .expect("the task keeps its row")
            .state();
        assert!(
            !parked.is_terminal(),
            "no verdict publishes while the withdrawal is in flight: {parked:?}"
        );
        peer_reply(
            &frames,
            &withdrawal,
            Some(json!({ "aborted": false, "steering": [], "followUp": [] })),
        );
        drain_and_reply(requests, frames);
        let terminal = stream.recv().await.expect("the receipt's terminal frame");
        assert!(
            stream.recv().await.is_none(),
            "the terminal frame closed the stream"
        );
        let answer = cancel.await.unwrap();
        let StreamResponse::StatusUpdate(event) = terminal else {
            panic!("a terminal status update");
        };
        assert_eq!(
            serde_json::to_value(event.status.state).unwrap(),
            answer["result"]["status"]["state"],
            "the stream and the cancel report one verdict"
        );
        assert_eq!(
            answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the successful receipt owns the cancel's verdict, never the completion that raced it: {answer}"
        );
    }

    /// A refused withdrawal releases the parked verdict unchanged: the
    /// engine's genuine no-response failure shares the aborted turn's
    /// settle text, and no error text alone is cancellation authority —
    /// the supervisor's typed overload refusal (the request never
    /// reached the worker) answers -32002 and the task keeps the
    /// FAILED its own run produced.
    #[tokio::test]
    async fn a_refused_withdrawal_keeps_the_tasks_own_failure() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        peer_task_awaiting_completion(&state, "victim").await;
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(10), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let withdrawal = held_command(&mut requests, &frames, "withdraw_admission").await;
        // The task's own continuation failed while the withdrawal was
        // still in flight: the settle parks the FAILED behind the mark.
        state.lock().await.registry.continuation_run_closed(
            "victim",
            None,
            Some(ABORTED_TURN_SETTLE_ERROR),
        );
        finalize_response_settle(&state, "victim", TaskState::Completed, None).await;
        let mut refusal = crate::backpressure::overloaded_response("withdraw_admission", "slow");
        refusal.id = withdrawal["id"].as_str().map(str::to_string);
        frames
            .send(LinkFrame::Response(refusal))
            .expect("the frame channel stays open");
        drain_and_reply(requests, frames);
        let answer = cancel.await.unwrap();
        assert_eq!(
            answer["error"]["code"], -32002,
            "the refused withdrawal is the honest refusal: {answer}"
        );
        assert_eq!(
            state
                .lock()
                .await
                .registry
                .task("victim")
                .expect("the refused cancel keeps the task")
                .state(),
            TaskState::Failed,
            "a refused withdrawal never turns a genuine failure into a cancel"
        );
    }

    /// Two concurrent withdrawals on one task each carry their own
    /// authority: the second's successful receipt settles the CANCELED
    /// at once (the first accepted cancel settles at once, whichever
    /// receipt lands first), the first still-pending withdrawal keeps
    /// its own share of the count, and the first's later receipt then
    /// answers the terminal task — never the FAILED the aborted
    /// continuation raced in behind the settled verdict.
    #[tokio::test]
    async fn a_second_cancel_receipt_settles_the_one_verdict_first() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        peer_task_awaiting_completion(&state, "victim").await;
        let first = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(10), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let accepted = held_command(&mut requests, &frames, "withdraw_admission").await;
        assert!(state.lock().await.registry.withdraw_inflight("victim"));
        let second = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(11), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let noop = held_command(&mut requests, &frames, "withdraw_admission").await;
        peer_reply(
            &frames,
            &noop,
            Some(json!({ "aborted": false, "steering": [], "followUp": [] })),
        );
        // The receipt settles CANCELED at once and the second cancel's
        // reply path runs its idle detach: the drain must stand before
        // the join or the peer never answers the detach.
        drain_and_reply(requests, frames.clone());
        let second_answer = second.await.unwrap();
        assert_eq!(
            second_answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the second cancel's receipt settles the CANCELED at once: {second_answer}"
        );
        // The aborted continuation closes behind the settled verdict:
        // its park publishes nothing — a terminal task keeps its first
        // verdict.
        state.lock().await.registry.continuation_run_closed(
            "victim",
            None,
            Some(ABORTED_TURN_SETTLE_ERROR),
        );
        finalize_response_settle(&state, "victim", TaskState::Completed, None).await;
        peer_reply(
            &frames,
            &accepted,
            Some(json!({ "aborted": true, "steering": [], "followUp": [] })),
        );
        let first_answer = first.await.unwrap();
        assert_eq!(
            first_answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the first withdrawal's receipt answers the terminal task's one verdict: {first_answer}"
        );
    }

    /// A refused completion barrier is not quiescence: the worker's
    /// typed overload refusal proves nothing about the work the task
    /// still owes (its children, its continuations), so the flow never
    /// settles COMPLETED behind it — the refusal is the flow's error,
    /// FAILED with its text.
    #[tokio::test]
    async fn a_refused_completion_wait_is_not_quiescence() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        peer_task_awaiting_completion(&state, "victim").await;
        let settle = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                settle_from_response(
                    &link,
                    &state,
                    "victim",
                    DaemonResponse {
                        id: None,
                        command: "prompt_and_wait".into(),
                        success: true,
                        data: None,
                        error: None,
                        error_info: None,
                    },
                )
                .await;
            }
        });
        let barrier = held_command(&mut requests, &frames, "wait_for_headless_completion").await;
        let mut refusal =
            crate::backpressure::overloaded_response("wait_for_headless_completion", "slow");
        refusal.id = barrier["id"].as_str().map(str::to_string);
        frames
            .send(LinkFrame::Response(refusal))
            .expect("the frame channel stays open");
        settle.await.expect("the settle completes");
        let snapshot = state
            .lock()
            .await
            .registry
            .snapshot("victim", None)
            .expect("the refused barrier settles the task");
        assert_eq!(
            snapshot.status.state,
            TaskState::Failed,
            "a refused barrier never publishes the completion: {:?}",
            snapshot.status.state
        );
        let text = snapshot
            .status
            .message
            .as_ref()
            .and_then(|message| message.parts.first())
            .and_then(|part| part.text.as_deref())
            .unwrap_or_default();
        assert!(
            text.contains("overloaded"),
            "the refusal is the flow's error text: {text}"
        );
    }

    /// The cancel ladder's accepted running-turn abort owns the verdict:
    /// the abort can end the engine's tool phase with a success outcome,
    /// and the stop the client asked for is the answer. The acceptance
    /// settles the task CANCELED at once, and the success settle the
    /// abort raced — the response the aborted run still emitted — can
    /// never revise that first verdict.
    #[tokio::test]
    async fn an_owned_ladder_abort_settles_the_success_it_raced_to_canceled() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
        }
        let delivery = state
            .lock()
            .await
            .registry
            .task("victim")
            .expect("the admitted task")
            .delivery_id()
            .to_string();
        assert_ne!(
            delivery, "victim",
            "the delivery id is the server-minted admission, never the public task id"
        );
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(10), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let ladder = held_command(&mut requests, &frames, "cancel_prompt_admission").await;
        peer_reply(&frames, &ladder, Some(json!({ "status": "owned" })));
        // The `owned` receipt rides the pump: the settle reads on a
        // bounded poll, never on the send's instant.
        {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                if state
                    .lock()
                    .await
                    .registry
                    .task("victim")
                    .is_some_and(|task| task.state() == TaskState::Canceled)
                {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "the ladder's acceptance never settled the task canceled"
                );
                tokio::task::yield_now().await;
            }
        }
        // The aborted tool phase ends the engine run with a success
        // outcome: the settle the cancel raced. The task already holds
        // its one terminal verdict, and the settle keeps it — never a
        // COMPLETED revision.
        finalize_response_settle(&state, "victim", TaskState::Completed, None).await;
        drain_and_reply(requests, frames);
        let answer = cancel.await.unwrap();
        assert_eq!(
            answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the accepted abort owns the verdict the success settle raced: {answer}"
        );
        assert_eq!(
            state
                .lock()
                .await
                .registry
                .task("victim")
                .expect("the settled task keeps its row")
                .state(),
            TaskState::Canceled
        );
    }

    /// The prompt's admission is the task's DELIVERY identity: the
    /// server-minted id its queued rows, running turn, spawned
    /// children, and engine continuations all carry — so the ladder,
    /// the withdrawal, and the scoped completion wait name exactly the
    /// task's own work. A client admission id is unique only within
    /// one daemon connection, so the PUBLIC task id must never ride
    /// the wire as an admission: another client may send it as its
    /// own, and the worker's identity-scoped sweep would take both.
    #[tokio::test]
    async fn the_prompt_carries_the_tasks_delivery_identity() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        let send = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match send_message(
                    &link,
                    &state,
                    json!(7),
                    json!({
                        "message": {
                            "messageId": "message-7",
                            "contextId": "ctx-slow",
                            "role": "ROLE_USER",
                            "parts": [{ "text": "prompt" }],
                        },
                        "configuration": { "returnImmediately": true },
                    }),
                    Streaming::No,
                )
                .await
                {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("the return-immediately send replies"),
                }
            }
        });
        let prompt = held_command(&mut requests, &frames, "prompt_and_wait").await;
        let reply = send.await.unwrap();
        assert!(
            reply.get("error").is_none(),
            "the return-immediately send acknowledges its task: {reply}"
        );
        let task_id = reply["result"]["task"]["id"]
            .as_str()
            .expect("the acknowledged task")
            .to_string();
        let delivery = state
            .lock()
            .await
            .registry
            .task(&task_id)
            .expect("the admitted task")
            .delivery_id()
            .to_string();
        assert_ne!(
            delivery, task_id,
            "the delivery id is minted per task, never the public id"
        );
        assert_eq!(
            prompt["command"]["admissionId"], delivery,
            "the prompt's admission is the task's delivery identity: {prompt}"
        );
        peer_reply(&frames, &prompt, None);
        let barrier = held_command(&mut requests, &frames, "wait_for_headless_completion").await;
        peer_reply(&frames, &barrier, Some(json!({})));
        drain_and_reply(requests, frames);
    }

    /// proto3's non-optional scalars: a client DTO that serializes its
    /// explicit defaults sends `Message.taskId: ""` and
    /// `Message.contextId: ""` — the same wire values as omissions
    /// (the `ListTasks` boundary's rule). An empty `taskId` never
    /// answers the continuation -32001 for a task that does not exist,
    /// and an empty `contextId` never answers the unknown-context
    /// -32602: both start a new task exactly like the omitted forms.
    #[tokio::test]
    async fn proto_default_valued_message_ids_read_as_omissions() {
        let (link, state, _, _) = controlled_link("never");
        // `taskId: ""` on a known context: a new task, never the
        // -32001 of a continuation naming a task that does not exist.
        let reply = match send_message(
            &link,
            &state,
            json!(1),
            json!({
                "message": {
                    "messageId": "message-1",
                    "contextId": "ctx-slow",
                    "taskId": "",
                    "role": "ROLE_USER",
                    "parts": [{ "text": "prompt" }],
                }
            }),
            Streaming::No,
        )
        .await
        {
            Dispatch::Reply(reply) => reply,
            Dispatch::Stream(..) => panic!("the blocking method replies"),
        };
        assert!(
            reply.get("error").is_none(),
            "an empty taskId is an omission, never a continuation: {reply}"
        );
        assert_eq!(
            reply["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
            "the empty-id send settles its task: {reply}"
        );
        // `contextId: ""`: a new conversation, never the -32602 of an
        // unknown context.
        let reply = match send_message(
            &link,
            &state,
            json!(2),
            json!({
                "message": {
                    "messageId": "message-2",
                    "contextId": "",
                    "role": "ROLE_USER",
                    "parts": [{ "text": "prompt" }],
                }
            }),
            Streaming::No,
        )
        .await
        {
            Dispatch::Reply(reply) => reply,
            Dispatch::Stream(..) => panic!("the blocking method replies"),
        };
        assert!(
            reply.get("error").is_none(),
            "an empty contextId is an omission, never an unknown context: {reply}"
        );
        assert_eq!(
            reply["result"]["task"]["status"]["state"], "TASK_STATE_COMPLETED",
            "the empty-context send settles its task: {reply}"
        );
    }

    /// A client admission id is unique only within ONE daemon
    /// connection: another connection may send the task's PUBLIC id
    /// as its own admission, and a run of that foreign delivery is not
    /// the task's own run. The own run carries the task's server-minted
    /// delivery id (the unique admission its prompt sent), so the
    /// foreign run credits nothing — never the artifact either: a
    /// foreign run before the prompt's handoff must not poison the
    /// anchor the own run's three-window turn needs.
    #[tokio::test]
    async fn a_foreign_connection_reusing_the_public_id_cannot_poison_the_own_run() {
        let (link, state, _, _) = controlled_link("unused");
        // Two connections' admission tables accept the same id: the
        // id is per-connection unique, not global.
        let table_a = crate::prompt_admission::PromptAdmissionTable::default();
        let table_b = crate::prompt_admission::PromptAdmissionTable::default();
        assert!(table_a.register("slow", "victim").is_ok());
        assert!(table_b.register("slow", "victim").is_ok());
        state.lock().await.registry.admit(
            "victim".into(),
            "ctx-slow".into(),
            "slow".into(),
            None,
            vec![Part::text("prompt")],
        );
        let delivery = state
            .lock()
            .await
            .registry
            .task("victim")
            .expect("the admitted task")
            .delivery_id()
            .to_string();
        // A foreign client's run reusing the PUBLIC id lands while the
        // task's own prompt still waits for its write turn.
        for event in [
            json!({
                "type": "agent_start",
                "admissionId": "supervisor-admission:foreign",
                "clientAdmissionId": "victim",
                "engineContinuation": false,
            }),
            json!({ "type": "turn_start" }),
            json!({
                "type": "message_end",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "FOREIGN" }] },
            }),
            json!({ "type": "turn_end" }),
            json!({ "type": "agent_end" }),
        ] {
            on_session_event(
                &state,
                &json!({ "type": "session_event", "activeSessionId": "slow", "event": event }),
            )
            .await;
        }
        let anchor = state.lock().await.windows.next_seq("slow");
        {
            let mut guard = state.lock().await;
            guard.registry.mark_prompt_writing("victim");
            guard
                .registry
                .mark_prompt_dispatched("victim", Some(anchor));
        }
        // The task's own run carries the DELIVERY id, and a normal
        // three-step tool-calling run exceeds the positional fallback's
        // two-window retention: only identity credit keeps its
        // artifact.
        on_session_event(
            &state,
            &json!({
                "type": "session_event", "activeSessionId": "slow",
                "event": {
                    "type": "agent_start",
                    "admissionId": "supervisor-admission:own",
                    "clientAdmissionId": delivery,
                    "engineContinuation": false,
                },
            }),
        )
        .await;
        for step in ["OWN-1", "OWN-2", "OWN-3"] {
            for event in [
                json!({ "type": "turn_start" }),
                json!({ "type": "message_start", "message": { "role": "assistant", "content": [] } }),
                json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": step } }),
                json!({
                    "type": "message_end",
                    "message": { "role": "assistant", "content": [{ "type": "text", "text": step }] },
                }),
                json!({ "type": "turn_end" }),
            ] {
                on_session_event(
                    &state,
                    &json!({ "type": "session_event", "activeSessionId": "slow", "event": event }),
                )
                .await;
            }
        }
        on_session_event(
            &state,
            &json!({
                "type": "session_event", "activeSessionId": "slow",
                "event": { "type": "agent_end" },
            }),
        )
        .await;
        settle_prompt_at_pump(&state, "victim", true).await;
        finalize_response_settle(&state, "victim", TaskState::Completed, None).await;
        let task = state
            .lock()
            .await
            .registry
            .snapshot("victim", None)
            .expect("the task settles");
        assert_eq!(
            task.artifacts
                .first()
                .and_then(|artifact| artifact.parts.first())
                .and_then(|part| part.text.as_deref()),
            Some("OWN-1\n\nOWN-2\n\nOWN-3"),
            "a foreign connection reusing the public id never steals the own run: {task:?}"
        );
        drop(link);
    }

    /// Two overlapping withdrawals on one owed task: the ACCEPTED receipt
    /// lands first, while the second withdrawal is still in flight. The
    /// accepted stop settles CANCELED at once — the first terminal
    /// verdict, whatever receipts follow — and the second's receipt
    /// answers the terminal task's one verdict instead of publishing
    /// the verdict the completion settle parked behind its own flight:
    /// no reply order loses the cancel the first withdrawal executed.
    #[tokio::test]
    async fn an_accepted_first_withdrawal_settles_canceled_at_once() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        peer_task_awaiting_completion(&state, "victim").await;
        let mut stream = state.lock().await.registry.subscribe("victim").unwrap();
        let first = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(10), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let accepted = held_command(&mut requests, &frames, "withdraw_admission").await;
        let second = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(11), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let noop = held_command(&mut requests, &frames, "withdraw_admission").await;
        // The worker processed the first withdraw first: the accepted
        // receipt lands while the second withdrawal is still in
        // flight.
        peer_reply(
            &frames,
            &accepted,
            Some(json!({ "aborted": false, "steering": [], "followUp": [] })),
        );
        // The accepted receipt settled CANCELED at once, and the first
        // cancel's reply path now runs its idle detach: the drain must
        // stand before the join or the peer never answers the detach.
        // The drain owns its own sender clone — the no-op receipt's
        // reply below still rides the pin's `frames` handle.
        drain_and_reply(requests, frames.clone());
        let first_answer = first.await.unwrap();
        assert_eq!(
            first_answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the accepted withdrawal answers the cancel it executed: {first_answer}"
        );
        // The aborted continuation closes while the second withdrawal's
        // receipt still travels: its verdict parks behind the flight.
        state.lock().await.registry.continuation_run_closed(
            "victim",
            None,
            Some(ABORTED_TURN_SETTLE_ERROR),
        );
        finalize_response_settle(&state, "victim", TaskState::Completed, None).await;
        peer_reply(
            &frames,
            &noop,
            Some(json!({ "aborted": false, "steering": [], "followUp": [] })),
        );
        let second_answer = second.await.unwrap();
        let terminal = stream.recv().await;
        let final_state = state
            .lock()
            .await
            .registry
            .task("victim")
            .map(TaskEntry::state);
        assert_eq!(
            second_answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the second receipt answers the terminal task's one verdict, never the parked completion: {second_answer}"
        );
        assert_eq!(
            final_state,
            Some(TaskState::Canceled),
            "the task the first withdrawal stopped keeps its canceled verdict"
        );
        match terminal {
            Some(StreamResponse::StatusUpdate(event)) => assert_eq!(
                event.status.state,
                TaskState::Canceled,
                "the stream reports the withdrawal's own verdict"
            ),
            other => panic!("the terminal frame answers the stream: {other:?}"),
        }
    }

    /// A `CancelTask` whose HTTP client disconnects while its withdrawal
    /// receipt is in flight still resolves the withdrawal: hyper drops
    /// the handler future at the EOF, and a dispatch awaited inside it
    /// would leak the in-flight count — the task's verdict would park
    /// forever behind the mark, and the task would wedge its context's
    /// queue head with every later send on the conversation waiting
    /// behind it. The withdrawal resolves outside the request future,
    /// so the dropped request leaves the same verdict a served one
    /// would.
    #[tokio::test]
    async fn a_dropped_cancel_request_still_settles_the_withdrawal() {
        use tokio::io::AsyncWriteExt as _;
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        peer_task_awaiting_completion(&state, "victim").await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(super::super::http::serve(
            listener,
            Arc::clone(&state),
            Arc::clone(&link),
            super::super::card::CardOptions {
                name: "probe".into(),
                description: "probe".into(),
                product_version: "0".into(),
                interface_url: format!("http://{addr}/"),
            },
            "tok".into(),
            None,
            None,
        ));
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"CancelTask","params":{"id":"victim"}}"#;
        let mut tcp = tokio::net::TcpStream::connect(addr).await.expect("connect");
        let request = format!(
            "POST / HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer tok\r\nContent-Type: application/json\r\nA2A-Version: 1.0\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        tcp.write_all(request.as_bytes()).await.expect("write");
        let withdrawal = held_command(&mut requests, &frames, "withdraw_admission").await;
        assert!(state.lock().await.registry.withdraw_inflight("victim"));
        // The client gives up while the receipt travels (a client-side
        // timeout, a closed connection): hyper drops the handler.
        drop(tcp);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        // The withdrawn continuation's completion settle lands.
        state.lock().await.registry.continuation_run_closed(
            "victim",
            None,
            Some(ABORTED_TURN_SETTLE_ERROR),
        );
        finalize_response_settle(&state, "victim", TaskState::Completed, None).await;
        // The worker's receipt arrives after the handler died: the
        // detached resolution still owns it.
        peer_reply(
            &frames,
            &withdrawal,
            Some(json!({ "aborted": true, "steering": [], "followUp": [] })),
        );
        drain_and_reply(requests, frames);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let (task_state, inflight) = {
            let guard = state.lock().await;
            (
                guard.registry.task("victim").map(TaskEntry::state),
                guard.registry.withdraw_inflight("victim"),
            )
        };
        // The settled task retired from its context's queue: a later
        // send's task takes the head.
        let head = {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "next".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("the next message on the context")],
            );
            guard.registry.head("ctx-slow").map(|task| task.id.clone())
        };
        server.abort();
        assert!(
            task_state.is_some_and(TaskState::is_terminal),
            "the dropped request's withdrawal still settles the task: {task_state:?}"
        );
        assert!(
            !inflight,
            "the dropped request's withdrawal closes its in-flight count"
        );
        assert_eq!(
            head.as_deref(),
            Some("next"),
            "the settled task retired from its context's queue head"
        );
    }

    /// A completion settle can overtake the ladder's `owned` receipt (the
    /// worker aborts the tool phase BEFORE its response travels): the
    /// settle parks behind the ladder's pending authority, and the
    /// receipt resolves it to the stop the client asked for — the
    /// cancel answers CANCELED, never the COMPLETED the racing settle
    /// produced before the mark could land.
    #[tokio::test]
    async fn an_owned_abort_settle_overtaking_its_receipt_settles_canceled() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
        }
        let mut stream = state.lock().await.registry.subscribe("victim").unwrap();
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(10), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let ladder = held_command(&mut requests, &frames, "cancel_prompt_admission").await;
        // The worker has performed the abort. The independently routed
        // prompt response and successful barrier beat the ladder's
        // response to the A2A server.
        settle_prompt_at_pump(&state, "victim", true).await;
        let settle = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                settle_from_response(
                    &link,
                    &state,
                    "victim",
                    DaemonResponse {
                        id: None,
                        command: "prompt_and_wait".into(),
                        success: true,
                        data: None,
                        error: None,
                        error_info: None,
                    },
                )
                .await;
            }
        });
        let barrier = held_command(&mut requests, &frames, "wait_for_headless_completion").await;
        peer_reply(&frames, &barrier, Some(json!({})));
        settle.await.unwrap();
        // The settle parked behind the ladder's pending authority: the
        // task still owes its one terminal verdict, and nothing
        // published to the stream yet.
        let (parked, marked) = {
            let guard = state.lock().await;
            (
                guard
                    .registry
                    .task("victim")
                    .is_some_and(|task| !task.state().is_terminal()),
                guard.registry.cancel_abort_marked("victim"),
            )
        };
        assert!(
            parked,
            "the racing settle parks behind the ladder's receipt"
        );
        assert!(!marked, "the ladder's receipt has not arrived yet");
        peer_reply(&frames, &ladder, Some(json!({ "status": "owned" })));
        // The ladder's `owned` resolution publishes the parked settle
        // through the standing mark at once — the ladder's own
        // resolution, with no withdrawal riding the acceptance.
        drain_and_reply(requests, frames);
        let answer = cancel.await.unwrap();
        let verdict = state
            .lock()
            .await
            .registry
            .snapshot("victim", None)
            .unwrap();
        assert_eq!(
            answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the accepted tool abort owns the verdict even when its settle beats the receipt: {answer}"
        );
        assert_eq!(
            verdict.status.state,
            TaskState::Canceled,
            "the stored task keeps the same one verdict"
        );
        match stream.recv().await {
            Some(StreamResponse::StatusUpdate(event)) => assert_eq!(
                event.status.state,
                TaskState::Canceled,
                "the stream's terminal frame reports the ladder's stop"
            ),
            other => panic!("the terminal frame answers the stream: {other:?}"),
        }
    }

    /// An accepted abort never waits out the task's run-on children: the
    /// `owned` resolution settles CANCELED at once, and the scoped
    /// completion barrier the children still hold answers to a task that
    /// already owns its verdict. The cancel answers without the barrier;
    /// the children's own turns finish against the settled task's
    /// foreign routing.
    #[tokio::test]
    async fn an_owned_abort_settles_canceled_while_its_children_hold_the_barrier() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
        }
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(10), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let ladder = held_command(&mut requests, &frames, "cancel_prompt_admission").await;
        peer_reply(&frames, &ladder, Some(json!({ "status": "owned" })));
        // The aborted run still answers success: the pump's response
        // step reads a task that already holds its verdict.
        settle_prompt_at_pump(&state, "victim", true).await;
        let settle = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                settle_from_response(
                    &link,
                    &state,
                    "victim",
                    DaemonResponse {
                        id: None,
                        command: "prompt_and_wait".into(),
                        success: true,
                        data: None,
                        error: None,
                        error_info: None,
                    },
                )
                .await;
            }
        });
        // The run-on child holds the scoped completion barrier: the
        // cancel must answer without it.
        let barrier = held_command(&mut requests, &frames, "wait_for_headless_completion").await;
        let answer = tokio::time::timeout(std::time::Duration::from_secs(4), cancel)
            .await
            .unwrap()
            .unwrap();
        let at_answer = state
            .lock()
            .await
            .registry
            .task("victim")
            .expect("the settled task keeps its row")
            .state();
        assert_eq!(
            answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the accepted abort answers at once, never behind the run-on children: {answer}"
        );
        assert_eq!(
            at_answer,
            TaskState::Canceled,
            "the registry holds the cancel's verdict while the barrier is still pending"
        );
        peer_reply(&frames, &barrier, None);
        drain_and_reply(requests, frames);
        settle.await.unwrap();
    }

    /// A retried cancel's withdrawal receipt settles the CANCELED while
    /// the FIRST cancel's ladder `owned` answer is still in flight: an
    /// accepted receipt is the first terminal verdict whatever other
    /// authority is pending, and the ladder's late `owned` then
    /// resolves on a terminal task — no verdict revision, one answer
    /// for both cancels, the stream reporting the same one CANCELED.
    #[tokio::test]
    async fn a_withdrawal_receipt_settles_canceled_while_the_ladder_is_in_flight() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
        }
        let mut stream = state.lock().await.registry.subscribe("victim").unwrap();
        let first = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(10), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let ladder = held_command(&mut requests, &frames, "cancel_prompt_admission").await;
        // The worker performed the ladder's abort; the independently
        // routed prompt response and successful completion barrier beat
        // the ladder's `owned` answer (the overtaking pin's premise).
        settle_prompt_at_pump(&state, "victim", true).await;
        let settle = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                settle_from_response(
                    &link,
                    &state,
                    "victim",
                    DaemonResponse {
                        id: None,
                        command: "prompt_and_wait".into(),
                        success: true,
                        data: None,
                        error: None,
                        error_info: None,
                    },
                )
                .await;
            }
        });
        let barrier = held_command(&mut requests, &frames, "wait_for_headless_completion").await;
        peer_reply(&frames, &barrier, Some(json!({})));
        settle.await.unwrap();
        // The client retries its cancel: the racing settle made the task
        // owed, so the retry takes the withdraw arm behind the still
        // in-flight ladder.
        let second = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(11), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let retry = held_command(&mut requests, &frames, "withdraw_admission").await;
        // The retry's withdraw finds nothing left to stop, and its
        // successful receipt settles the CANCELED at once — the ladder's
        // `owned` answer is still in flight.
        peer_reply(
            &frames,
            &retry,
            Some(json!({ "aborted": false, "steering": [], "followUp": [] })),
        );
        // The receipt rides the pump: the settle reads on a bounded
        // poll, never on the send's instant.
        let after_receipt = {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                let settled = state
                    .lock()
                    .await
                    .registry
                    .task("victim")
                    .map(TaskEntry::state);
                if settled == Some(TaskState::Canceled) {
                    break settled;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "the retry's receipt never settled the CANCELED: {settled:?}"
                );
                tokio::task::yield_now().await;
            }
        };
        // The ladder's `owned` lands last and revises nothing: the task
        // is terminal.
        peer_reply(&frames, &ladder, Some(json!({ "status": "owned" })));
        drain_and_reply(requests, frames);
        let first_answer = first.await.unwrap();
        let second_answer = second.await.unwrap();
        let final_state = state
            .lock()
            .await
            .registry
            .task("victim")
            .map(TaskEntry::state);
        assert_eq!(
            after_receipt,
            Some(TaskState::Canceled),
            "the retry's receipt settles the first terminal verdict while the ladder is in flight: {after_receipt:?}"
        );
        assert_eq!(
            first_answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the ladder's late owned answer reports the settled verdict: {first_answer}"
        );
        assert_eq!(
            second_answer["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "the retry's receipt owns the same one verdict: {second_answer}"
        );
        assert_eq!(
            final_state,
            Some(TaskState::Canceled),
            "the late ladder resolution revises no published verdict"
        );
        match stream.recv().await {
            Some(StreamResponse::StatusUpdate(event)) => assert_eq!(
                event.status.state,
                TaskState::Canceled,
                "the stream's terminal frame reports the one settled verdict"
            ),
            other => panic!("the terminal frame answers the stream: {other:?}"),
        }
    }

    /// The ladder's accepted abort resolves from the DETACHED exchange,
    /// never the request future: a `CancelTask` whose HTTP client
    /// disconnects before the ladder answers leaves hyper dropping the
    /// handler at the EOF, and an exchange awaited inside the request
    /// future would die with it — the task's verdict would park behind
    /// the ladder's authority forever. The resolution lands whatever
    /// the client did.
    #[tokio::test]
    async fn a_dropped_cancel_request_still_settles_the_owned_abort() {
        use tokio::io::AsyncWriteExt as _;
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(super::super::http::serve(
            listener,
            Arc::clone(&state),
            Arc::clone(&link),
            super::super::card::CardOptions {
                name: "probe".into(),
                description: "probe".into(),
                product_version: "0".into(),
                interface_url: format!("http://{addr}/"),
            },
            "tok".into(),
            None,
            None,
        ));
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"CancelTask","params":{"id":"victim"}}"#;
        let mut tcp = tokio::net::TcpStream::connect(addr).await.expect("connect");
        let request = format!(
            "POST / HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer tok\r\nContent-Type: application/json\r\nA2A-Version: 1.0\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        tcp.write_all(request.as_bytes()).await.expect("write");
        let ladder = held_command(&mut requests, &frames, "cancel_prompt_admission").await;
        assert!(state.lock().await.registry.ladder_inflight("victim"));
        // The client gives up while the ladder's answer travels: hyper
        // drops the handler.
        drop(tcp);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        // The completion settles behind the dropped request — its
        // verdict parks behind the ladder's pending authority.
        settle_prompt_at_pump(&state, "victim", true).await;
        let settle = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                settle_from_response(
                    &link,
                    &state,
                    "victim",
                    DaemonResponse {
                        id: None,
                        command: "prompt_and_wait".into(),
                        success: true,
                        data: None,
                        error: None,
                        error_info: None,
                    },
                )
                .await;
            }
        });
        let barrier = held_command(&mut requests, &frames, "wait_for_headless_completion").await;
        peer_reply(&frames, &barrier, Some(json!({})));
        settle.await.unwrap();
        // The ladder's `owned` answer lands after the handler died: the
        // detached resolution publishes the parked verdict through the
        // mark.
        peer_reply(&frames, &ladder, Some(json!({ "status": "owned" })));
        drain_and_reply(requests, frames);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let final_state = state
            .lock()
            .await
            .registry
            .task("victim")
            .map(TaskEntry::state);
        server.abort();
        assert_eq!(
            final_state,
            Some(TaskState::Canceled),
            "the dropped request's ladder still settles the task canceled"
        );
    }

    /// The blocking `SendMessage` (spec 3.2.2) answers the task's own
    /// terminal outcome: a `CancelTask` whose withdrawal receipt is
    /// still in flight owns the task's one terminal verdict — the
    /// completion settle parked it — and the blocking reply waits the
    /// receipt's resolution out instead of answering the live WORKING
    /// row.
    #[tokio::test]
    async fn a_blocking_send_waits_for_a_pending_withdrawals_verdict() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        let send = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match send_message(
                    &link,
                    &state,
                    json!(7),
                    json!({
                        "message": {"messageId": "message-7", "contextId": "ctx-slow", "role": "ROLE_USER", "parts": [{"text": "prompt"}]}
                    }),
                    Streaming::No,
                )
                .await
                {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("blocking send replies"),
                }
            }
        });
        let prompt = held_command(&mut requests, &frames, "prompt_and_wait").await;
        let task_id = state
            .lock()
            .await
            .registry
            .head("ctx-slow")
            .unwrap()
            .id
            .clone();
        peer_reply(&frames, &prompt, None);
        let barrier = held_command(&mut requests, &frames, "wait_for_headless_completion").await;
        let cancel = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            let task_id = task_id.clone();
            async move {
                match cancel_task(&link, &state, json!(10), json!({ "id": task_id })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("cancel replies"),
                }
            }
        });
        let withdrawal = held_command(&mut requests, &frames, "withdraw_admission").await;
        peer_reply(&frames, &barrier, Some(json!({})));
        // No withdrawal receipt has arrived, so the blocking send owes
        // the terminal verdict. An early answer is the defect measured.
        let mut send = send;
        let early = tokio::time::timeout(std::time::Duration::from_secs(2), &mut send).await;
        peer_reply(
            &frames,
            &withdrawal,
            Some(json!({ "aborted": false, "steering": [], "followUp": [] })),
        );
        drain_and_reply(requests, frames);
        let cancel_reply = cancel.await.unwrap();
        match early {
            Ok(Ok(reply)) => panic!(
                "the blocking send answered before the withdrawal's verdict: {reply}; cancel={cancel_reply}"
            ),
            Ok(Err(error)) => panic!("the blocking send join failed: {error}"),
            Err(_) => {
                let reply = send.await.unwrap();
                assert_eq!(
                    reply["result"]["task"]["status"]["state"], "TASK_STATE_CANCELED",
                    "the blocking send answers the resolved withdrawal's verdict: {reply}"
                );
            }
        }
    }

    /// The mode's exit is one settlement decision under the state guard
    /// (the exit settles the queued task mid-flow): the
    /// shutting-down mark refuses every
    /// later admission, every live task whose prompt never reached the
    /// daemon settles CANCELED at the exit — nothing in the daemon names
    /// it, and its flow's write step observes the terminal row under the
    /// same guard — and only the dispatched deliveries withdraw. A queued
    /// task's flow must therefore never write its prompt after the exit's
    /// withdrawal walk began, whatever rotation the walk's own aborts
    /// cause.
    #[tokio::test]
    async fn the_exit_settles_the_queued_task_before_its_flow_can_write() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        let head_delivery = {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "b-head".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("head")],
            );
            guard.registry.mark_prompt_writing("b-head");
            guard.registry.mark_prompt_dispatched("b-head", None);
            guard
                .registry
                .task("b-head")
                .map(TaskEntry::delivery_id)
                .unwrap()
                .to_string()
        };

        // A queued send (returnImmediately) behind the dispatched head.
        let (tx, mut rx) = mpsc::unbounded_channel();
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                let request: SendMessageRequest = serde_json::from_value(json!({
                    "message": {
                        "role": "ROLE_USER",
                        "messageId": "m-queued",
                        "contextId": "ctx-slow",
                        "parts": [{ "text": "queued" }],
                    },
                    "configuration": { "returnImmediately": true },
                }))
                .expect("the request parses");
                send_flow_to_settle(
                    &link,
                    &state,
                    json!(5),
                    "a-queued",
                    request,
                    Streaming::No,
                    "queued".into(),
                    tx,
                )
                .await;
            }
        });
        match rx.recv().await {
            Some(SendFlowOutcome::Admitted { .. }) => {}
            Some(SendFlowOutcome::Settled(reply)) => {
                panic!("the queued task is acknowledged, not settled at once: {reply}")
            }
            None => panic!("the queued task is acknowledged before the flow settles"),
        }
        let queued_delivery = state
            .lock()
            .await
            .registry
            .task("a-queued")
            .map(TaskEntry::delivery_id)
            .unwrap()
            .to_string();
        assert_ne!(head_delivery, queued_delivery);
        // The operator's SIGINT: the exit makes its settlement decision.
        let exit = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { teardown(&link, &state).await }
        });
        // The undispatched queued task is settled at the exit (CANCELED),
        // never withdrawn; the one withdrawal belongs to the dispatched head.
        let withdrawal = held_command(&mut requests, &frames, "withdraw_admission").await;
        assert_eq!(
            withdrawal["command"]["admissionId"], head_delivery,
            "the exit withdraws only the dispatched deliveries"
        );
        assert_ne!(
            withdrawal["command"]["admissionId"], queued_delivery,
            "an undispatched task is settled CANCELED at the exit, not withdrawn"
        );
        peer_reply(
            &frames,
            &withdrawal,
            Some(json!({ "aborted": true, "steering": [], "followUp": [] })),
        );
        // The head's aborted rotation frees the queue: the queued flow
        // must observe its terminal row and answer — never write.
        settle_prompt_at_pump(&state, "b-head", false).await;
        state
            .lock()
            .await
            .registry
            .settle("b-head", TaskState::Canceled, None);
        let mut late_prompt = None;
        loop {
            let next =
                tokio::time::timeout(std::time::Duration::from_secs(2), requests.recv()).await;
            let Ok(Some(envelope)) = next else { break };
            let request: Value = serde_json::from_str(&envelope).unwrap();
            if request["command"]["type"] == "prompt_and_wait" {
                late_prompt = Some(request.clone());
                peer_reply(&frames, &request, None);
                break;
            }
            peer_reply(&frames, &request, None);
        }
        drain_and_reply(requests, frames);
        exit.await.unwrap();
        let queued_state = state
            .lock()
            .await
            .registry
            .task("a-queued")
            .map(TaskEntry::state);
        assert_eq!(queued_state, Some(TaskState::Canceled));
        assert!(
            late_prompt.is_none(),
            "the exit's snapshot is final: no queued task writes its prompt after the exit (late_prompt={late_prompt:?})"
        );
        flow.abort();
    }

    /// A teardown can land BETWEEN the send flow's write claim
    /// (`mark_prompt_writing`) and its guarded send step. The tokio
    /// mutex is FIFO, so the ordering is deterministic: the flow queues
    /// for its claim, the real `teardown` queues behind it, and the
    /// flow's next lock request queues behind the teardown. The teardown
    /// then sees a Writing task, settles it CANCELED, and the send step
    /// must write nothing — a prompt written after that settlement
    /// would run in the daemon behind a terminal registry row, named by
    /// no withdrawal.
    #[tokio::test]
    async fn the_exit_between_the_write_claim_and_the_send_writes_nothing() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                send_flow_to_settle(
                    &link,
                    &state,
                    json!(1),
                    "a-claimed",
                    serde_json::from_value(json!({
                        "message": {"messageId": "m1", "contextId": "ctx-slow", "role": "ROLE_USER", "parts": [{"text": "must not start after the exit"}]},
                        "configuration": {"returnImmediately": true}
                    }))
                    .unwrap(),
                    Streaming::No,
                    "must not start after the exit".into(),
                    tx,
                )
                .await;
            }
        });
        let _ack = rx.recv().await.expect("the task was acknowledged");
        let idle = held_command(&mut requests, &frames, "wait_for_idle").await;
        // Hold the state lock, then answer the idle barrier: the barrier
        // owner queues for the lock to unregister before it publishes.
        let held = state.lock().await;
        peer_reply(&frames, &idle, None);
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        drop(held);
        // FIFO: the owner (queued first) unregisters and publishes, then
        // hands the lock to this test.
        let held = state.lock().await;
        assert!(
            !held.idle_barriers.contains_key("slow"),
            "the barrier owner published before the test re-took the lock"
        );
        // The woken flow runs to its claim and queues behind this test.
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        // The exit queues behind the flow's claim.
        let exit = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { teardown(&link, &state).await }
        });
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        drop(held);
        let mut leaked_prompt = None;
        loop {
            let next =
                tokio::time::timeout(std::time::Duration::from_secs(2), requests.recv()).await;
            let Ok(Some(envelope)) = next else { break };
            let request: Value = serde_json::from_str(&envelope).unwrap();
            if request["command"]["type"] == "prompt_and_wait" {
                leaked_prompt = Some(request.clone());
                peer_reply(&frames, &request, None);
                break;
            }
            peer_reply(&frames, &request, None);
        }
        drain_and_reply(requests, frames);
        exit.await.unwrap();
        let (state_after, claimed) = {
            let guard = state.lock().await;
            let task = guard.registry.task("a-claimed").unwrap();
            (task.state(), task.prompt_write_claimed())
        };
        eprintln!(
            "exit-claim-probe claimed_before_exit={claimed} state={state_after:?} leaked_prompt={}",
            leaked_prompt.is_some()
        );
        assert!(
            claimed,
            "the test must exercise the window: the flow claimed the write before the exit settled it"
        );
        assert_eq!(state_after, TaskState::Canceled);
        assert!(
            leaked_prompt.is_none(),
            "the exit settled the claimed task, yet its flow wrote the prompt: {leaked_prompt:?}"
        );
        flow.abort();
    }

    /// The same exit decision for a task waiting for a QUIET session
    /// (past the queue turnstile, before the write): its flow parks at the
    /// shared idle barrier, the exit settles it CANCELED under the guard,
    /// and the barrier's own late answer cannot carry it to a write — the
    /// write claim observes the terminal row under the same guard.
    #[tokio::test]
    async fn the_exit_settles_the_waiting_flow_before_it_can_write() {
        let (link, state, mut requests, frames) =
            scripted_peer(&[("slow", "ctx-slow"), ("held", "ctx-held")]);
        // A dispatched task on ANOTHER context keeps the exit's withdrawal
        // walk awaiting a receipt (ordinary multi-context teardown).
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "z-held".into(),
                "ctx-held".into(),
                "held".into(),
                None,
                vec![Part::text("held turn")],
            );
            guard.registry.mark_prompt_writing("z-held");
            guard.registry.mark_prompt_dispatched("z-held", None);
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                send_flow_to_settle(
                    &link,
                    &state,
                    json!(1),
                    "a-waiting",
                    serde_json::from_value(json!({
                        "message": {"messageId": "m1", "contextId": "ctx-slow", "role": "ROLE_USER", "parts": [{"text": "must not start after shutdown"}]},
                        "configuration": {"returnImmediately": true}
                    }))
                    .unwrap(),
                    Streaming::No,
                    "must not start after shutdown".into(),
                    tx,
                )
                .await;
            }
        });
        let _ack = rx.recv().await.expect("the waiting task was acknowledged");
        // The flow is the context's head and waits the session's quiet.
        let idle = held_command(&mut requests, &frames, "wait_for_idle").await;
        let exit = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { teardown(&link, &state).await }
        });
        // The waiting task settles CANCELED at the exit (no withdrawal for
        // it); the one withdrawal belongs to the other context's dispatched
        // task.
        let withdrawal = held_command(&mut requests, &frames, "withdraw_admission").await;
        assert_eq!(
            withdrawal["command"]["activeSessionId"], "held",
            "the exit withdraws only the dispatched deliveries"
        );
        // The idle barrier answers while the exit's withdrawal is still in
        // flight: the waiting flow observes its terminal row and answers,
        // never writing its prompt.
        peer_reply(&frames, &idle, None);
        let mut leaked_prompt = None;
        loop {
            let next =
                tokio::time::timeout(std::time::Duration::from_secs(2), requests.recv()).await;
            let Ok(Some(envelope)) = next else { break };
            let request: Value = serde_json::from_str(&envelope).unwrap();
            if request["command"]["type"] == "prompt_and_wait" {
                leaked_prompt = Some(request.clone());
                peer_reply(&frames, &request, None);
                break;
            }
            peer_reply(&frames, &request, None);
        }
        peer_reply(
            &frames,
            &withdrawal,
            Some(json!({ "aborted": true, "steering": [], "followUp": [] })),
        );
        drain_and_reply(requests, frames);
        exit.await.unwrap();
        let waiting_state = state
            .lock()
            .await
            .registry
            .task("a-waiting")
            .map(TaskEntry::state);
        assert_eq!(waiting_state, Some(TaskState::Canceled));
        assert!(
            leaked_prompt.is_none(),
            "a live task must not write a new prompt after the exit settled it: {leaked_prompt:?}"
        );
        flow.abort();
    }

    /// A send that reaches the listener AFTER the exit began admits
    /// nothing: the shutting-down mark refuses it at the HTTP entry and at
    /// the admission guard alike (the accept loop is aborted in production;
    /// this probe drives the live listener the way the select's ownership
    /// leaves it, so the flag is the admission gate under test).
    #[tokio::test]
    async fn the_exit_refuses_new_http_tasks_after_shutdown_began() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let (link, state, mut requests, frames) =
            scripted_peer(&[("slow", "ctx-slow"), ("new", "ctx-new")]);
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "anchor".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("held turn")],
            );
            guard.registry.mark_prompt_writing("anchor");
            guard.registry.mark_prompt_dispatched("anchor", None);
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(super::super::http::serve(
            listener,
            Arc::clone(&state),
            Arc::clone(&link),
            super::super::card::CardOptions {
                name: "probe".into(),
                description: "probe".into(),
                product_version: "0".into(),
                interface_url: format!("http://{addr}/"),
            },
            "tok".into(),
            None,
            None,
        ));
        let abort_server = server.abort_handle();
        // The mode's signal arm wins the select: the accept loop's handle is
        // dropped exactly the way the run function's select leaves it.
        tokio::select! {
            result = server => panic!("the accept loop ended before shutdown: {result:?}"),
            () = std::future::ready(()) => {}
        }
        let exit = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { teardown(&link, &state).await }
        });
        let withdrawal = held_command(&mut requests, &frames, "withdraw_admission").await;
        // A new authenticated SendMessage reaches the still-live listener.
        let client = tokio::spawn(async move {
            let body = r#"{"jsonrpc":"2.0","id":19,"method":"SendMessage","params":{"message":{"messageId":"m19","contextId":"ctx-new","role":"ROLE_USER","parts":[{"text":"new work during exit"}]},"configuration":{"returnImmediately":true}}}"#;
            let mut tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
            let wire = format!("POST / HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer tok\r\nA2A-Version: 1.0\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            tcp.write_all(wire.as_bytes()).await.unwrap();
            let mut bytes = Vec::new();
            tcp.read_to_end(&mut bytes).await.unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let mut new_prompt = None;
        loop {
            let next =
                tokio::time::timeout(std::time::Duration::from_secs(2), requests.recv()).await;
            let Ok(Some(envelope)) = next else { break };
            let request: Value = serde_json::from_str(&envelope).unwrap();
            if request["command"]["type"] == "prompt_and_wait" {
                new_prompt = Some(request.clone());
                peer_reply(&frames, &request, None);
                break;
            }
            peer_reply(&frames, &request, None);
        }
        peer_reply(
            &frames,
            &withdrawal,
            Some(json!({ "aborted": true, "steering": [], "followUp": [] })),
        );
        drain_and_reply(requests, frames);
        exit.await.unwrap();
        abort_server.abort();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), client)
            .await
            .expect("the client's request answers")
            .unwrap();
        assert!(
            new_prompt.is_none(),
            "a send that lands after the exit began admits no task: {new_prompt:?}"
        );
        assert!(
            !reply.contains("\"result\":{\"task\""),
            "the shutdown send answers an error, never an admitted task: {reply}"
        );
        assert!(
            reply.contains("shutting down"),
            "the refusal names the shutdown: {reply}"
        );
    }

    /// The exit's withdrawal walk stops at the first success receipt for
    /// a task whose own response already arrived (`awaiting_completion`):
    /// the worker answers those with the empty success (the task's run
    /// closed, nothing is queued, no turn runs, and the work its closed
    /// run delegated keeps running), so a retry loop that read the no-op
    /// answer as owed work would spin the retry bound per task — an
    /// exchange every 10 ms — and delay the exit's owned-session
    /// settlement behind them.
    #[tokio::test]
    async fn the_exit_stops_withdrawing_a_task_whose_own_response_arrived() {
        let (link, state, mut requests, frames) =
            scripted_peer(&[("slow", "ctx-slow"), ("two", "ctx-two")]);
        peer_task_awaiting_completion(&state, "victim").await;
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim-two".into(),
                "ctx-two".into(),
                "two".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim-two");
            guard.registry.mark_prompt_dispatched("victim-two", None);
            guard.registry.mark_awaiting_completion("victim-two");
        }
        let withdrawals = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let withdrawals = Arc::clone(&withdrawals);
            let frames = frames.clone();
            tokio::spawn(async move {
                while let Some(line) = requests.recv().await {
                    let request: Value = serde_json::from_str(&line).unwrap();
                    if request["command"]["type"] == "withdraw_admission" {
                        withdrawals.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        peer_reply(
                            &frames,
                            &request,
                            Some(json!({ "aborted": false, "steering": [], "followUp": [] })),
                        );
                    } else {
                        peer_reply(&frames, &request, None);
                    }
                }
            });
        }
        let started = std::time::Instant::now();
        teardown(&link, &state).await;
        let sent = withdrawals.load(std::sync::atomic::Ordering::SeqCst);
        assert!(
            sent <= 2,
            "the exit withdrew {sent} times for two answered tasks"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_millis(500),
            "the exit spun its no-op retry: {} ms for two answered tasks",
            started.elapsed().as_millis()
        );
    }

    /// Two overlapping cancel ladders each own the task's verdict while
    /// their receipts travel: the first ladder's
    /// unknown-status expiry must not release the verdict the second
    /// ladder's accepted abort still owns — a count, never a boolean, so
    /// the parked COMPLETED publishes as CANCELED only when every ladder
    /// resolved.
    #[tokio::test]
    async fn one_ladder_expiry_cannot_release_another_ladders_verdict() {
        let (link, state, mut requests, frames) = scripted_peer(&[("slow", "ctx-slow")]);
        {
            let mut guard = state.lock().await;
            guard.registry.admit(
                "victim".into(),
                "ctx-slow".into(),
                "slow".into(),
                None,
                vec![Part::text("prompt")],
            );
            guard.registry.mark_prompt_writing("victim");
            guard.registry.mark_prompt_dispatched("victim", None);
        }
        let mut first = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(1), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let ladder_a = held_command(&mut requests, &frames, "cancel_prompt_admission").await;
        let second = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                match cancel_task(&link, &state, json!(2), json!({ "id": "victim" })).await {
                    Dispatch::Reply(reply) => reply,
                    Dispatch::Stream(..) => panic!("CancelTask replies"),
                }
            }
        });
        let ladder_b = held_command(&mut requests, &frames, "cancel_prompt_admission").await;
        // B's worker abort has already closed the turn, but B's own
        // response still travels. The prompt response and completion
        // barrier arrive on the independent prompt route first.
        settle_prompt_at_pump(&state, "victim", true).await;
        let settle = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move {
                settle_from_response(
                    &link,
                    &state,
                    "victim",
                    DaemonResponse {
                        id: None,
                        command: "prompt_and_wait".into(),
                        success: true,
                        data: None,
                        error: None,
                        error_info: None,
                    },
                )
                .await;
            }
        });
        let barrier = held_command(&mut requests, &frames, "wait_for_headless_completion").await;
        peer_reply(&frames, &barrier, Some(json!({})));
        settle.await.unwrap();
        assert_eq!(
            state.lock().await.registry.task("victim").unwrap().state(),
            TaskState::Working,
            "the completion parked its verdict behind the two ladders"
        );
        // A never found an admission: after B's abort the worker cleared
        // it. Keep answering its real unknown-status retries until A's own
        // window ends (the operation's observable exit, not a fixed sleep).
        peer_reply(&frames, &ladder_a, Some(json!({ "status": "unknown" })));
        let _first_answer = tokio::time::timeout(std::time::Duration::from_secs(8), async {
            loop {
                tokio::select! {
                    answer = &mut first => break answer.unwrap(),
                    envelope = requests.recv() => {
                        let request: Value = serde_json::from_str(&envelope.unwrap()).unwrap();
                        if request["command"]["type"] == "cancel_prompt_admission" {
                            peer_reply(&frames, &request, Some(json!({ "status": "unknown" })));
                        } else {
                            // The expiry window's owed withdraw gets the
                            // worker's REFUSAL: a successful withdrawal
                            // settles the CANCELED at once (the work it
                            // delegated keeps running), and the pin holds
                            // the refused receipt's respect for the
                            // second ladder's still-pending authority.
                            frames
                                .send(LinkFrame::Response(DaemonResponse {
                                    id: request
                                        .get("id")
                                        .and_then(Value::as_str)
                                        .map(str::to_string),
                                    command: request
                                        .pointer("/command/type")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_string(),
                                    success: false,
                                    error: None,
                                    error_info: None,
                                    data: Some(json!({ "aborted": false, "steering": [], "followUp": [] })),
                                }))
                                .expect("the frame channel stays open");
                        }
                    }
                }
            }
        })
        .await
        .expect("the first cancel's window ends");
        let after_a = state
            .lock()
            .await
            .registry
            .task("victim")
            .map(TaskEntry::state);
        assert_eq!(
            after_a,
            Some(TaskState::Working),
            "the first ladder's expiry must not release the verdict the second ladder still owns"
        );
        // B's accepted abort resolves the last share: the parked verdict
        // publishes through the standing mark as CANCELED — the ladder's
        // own resolution.
        peer_reply(&frames, &ladder_b, Some(json!({ "status": "owned" })));
        drain_and_reply(requests, frames);
        let _second_answer = second.await.unwrap();
        let final_state = state
            .lock()
            .await
            .registry
            .task("victim")
            .map(TaskEntry::state);
        assert_eq!(
            final_state,
            Some(TaskState::Canceled),
            "A's refusal must not release the verdict still owned by B's accepted abort"
        );
    }

    /// A re-open that both starts and finishes while the eviction's
    /// `list` pre-filter is awaiting its answer re-keys the binding the
    /// candidate snapshot named: the eviction must revalidate the
    /// binding when it takes its reservation — the stop and the
    /// cleanup below name the binding the table holds NOW — or it
    /// kills the retired worker and leaves the fresh session's route
    /// unreachable behind a removed context (an eviction loop that
    /// keeps taking candidates never reclaims the growth).
    #[tokio::test]
    async fn an_eviction_revalidates_the_binding_after_its_prefilter() {
        let (link, state, mut requests, frames) = scripted_peer(&[("old", "ctx-slow")]);
        {
            let mut guard = state.lock().await;
            guard.contexts.insert(
                "ctx-slow".to_string(),
                ContextSession {
                    active_id: "old".to_string(),
                    durable_id: "r23-durable".to_string(),
                    session_file: Some("/tmp/fake-a2a-r23-session.jsonl".to_string()),
                },
            );
            guard.attached.remove("ctx-slow");
            guard.max_contexts = 1;
            guard.touch_context("ctx-slow");
        }
        // The eviction takes its candidate and parks on the `list`
        // pre-filter while the canceled flow's re-open round still runs.
        let eviction = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            async move { evict_one_idle_context(&link, &state).await }
        });
        let list = held_command(&mut requests, &frames, "list").await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let flow = tokio::spawn({
            let link = Arc::clone(&link);
            let state = Arc::clone(&state);
            let tx = tx;
            async move {
                send_flow_to_settle(
                    &link,
                    &state,
                    json!(1),
                    "first",
                    serde_json::from_value(json!({
                        "message": {
                            "messageId": "m1",
                            "contextId": "ctx-slow",
                            "role": "ROLE_USER",
                            "parts": [{ "text": "first" }],
                        },
                        "configuration": { "returnImmediately": true },
                    }))
                    .unwrap(),
                    Streaming::No,
                    "first".to_string(),
                    tx,
                )
                .await;
            }
        });
        rx.recv().await.expect("the task acknowledges");
        let reopened = held_command(&mut requests, &frames, "create").await;
        let canceled = cancel_task(&link, &state, json!(3), json!({ "id": "first" })).await;
        let Dispatch::Reply(canceled) = canceled else {
            panic!("CancelTask replies");
        };
        assert_eq!(
            canceled["result"]["status"]["state"], "TASK_STATE_CANCELED",
            "{canceled}"
        );
        // The round finishes INSIDE the eviction's parked pre-filter:
        // the re-open answers a fresh worker, the attach binds it, and
        // the flow's tail detach releases it — the binding now names
        // the fresh worker while the eviction still holds its
        // pre-read snapshot.
        peer_reply(
            &frames,
            &reopened,
            Some(json!({ "activeSessionId": "fresh" })),
        );
        let attach = held_command(&mut requests, &frames, "attach").await;
        assert_eq!(
            attach["command"]["activeSessionId"], "fresh",
            "the round attaches the worker the re-open answered"
        );
        peer_reply(
            &frames,
            &attach,
            Some(json!({ "activeSessionId": "fresh" })),
        );
        let detached = held_command(&mut requests, &frames, "detach").await;
        assert_eq!(
            detached["command"]["activeSessionId"], "fresh",
            "the flow's cleanup detaches the round's worker"
        );
        peer_reply(&frames, &detached, None);
        flow.await.expect("the canceled flow ends");
        // The pre-filter answers on the finished round: the eviction
        // must take the binding the table holds (fresh), never the
        // snapshot's retired worker.
        peer_reply(&frames, &list, Some(json!({ "sessions": [] })));
        let detach = held_command(&mut requests, &frames, "detach").await;
        assert_eq!(
            detach["command"]["activeSessionId"], "fresh",
            "the eviction stops the binding the table holds now, never the pre-read snapshot"
        );
        peer_reply(&frames, &detach, None);
        let kill = held_command(&mut requests, &frames, "kill_if_idle").await;
        peer_reply(&frames, &kill, None);
        assert!(
            eviction.await.unwrap(),
            "the revalidated eviction reclaims its context"
        );
        let guard = state.lock().await;
        assert!(
            guard.contexts.is_empty(),
            "the conversation's binding left with the eviction"
        );
        assert!(
            guard.sessions.is_empty(),
            "no unreachable session route outlives the removed binding: {:?}",
            guard.sessions
        );
    }
}
