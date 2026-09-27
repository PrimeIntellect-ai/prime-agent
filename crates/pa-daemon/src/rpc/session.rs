//! The in-process RPC connection: one live engine slot, the loop-event
//! subscription that forwards raw session-event frames, and the
//! whole-session replacement `new_session` / `switch_session` / `fork`
//! drive (TS `InProcessAgentConnection` + the runtime host's session
//! replacement flows).

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use pa_agent::agent::Subscription;
use pa_core::session_engine::engine::SessionEngine;
use pa_core::session_engine::provider_adapter::ProviderTarget;
use pa_core::session_engine::session_events::agent_event_json;
use pa_types::ai::Model;

use super::LineWriter;

/// One assembled engine plus the live provider target its stream reads
/// (`set_model` swaps the target without rebuilding the session), and
/// the runtime session lease the factory acquired for the opened file
/// (dropped with the handle on replacement — the old session's lease
/// releases exactly when the engine that owned it goes away).
pub struct RpcEngineHandle {
    pub engine: Arc<SessionEngine>,
    pub model: Model,
    pub api_key: Option<String>,
    pub provider_target: Arc<std::sync::RwLock<Option<ProviderTarget>>>,
    /// The cross-process ownership lease on the opened session file
    /// (`None` for fresh/in-memory sessions the factory created itself).
    pub session_lease: Option<crate::lease::SessionLease>,
}

/// A whole-session replacement request (TS `runtimeHost.newSession` /
/// `switchSession` / `fork`): a fresh session (optionally under a parent
/// session) or an existing session file to open.
pub enum RpcEngineRequest {
    New {
        parent_session: Option<String>,
        /// The ACTIVE session's cwd (TS `runtimeHost.newSession` builds
        /// the fresh session over `this.cwd` — the live runtime's
        /// project, not the CLI startup directory): the factory falls
        /// back to the startup cwd when absent.
        cwd: Option<std::path::PathBuf>,
    },
    Open {
        session_path: PathBuf,
        /// The same-path reopen: the caller adopted the current lease
        /// (TS `acquireReplacementLease` reuses it), so the factory must
        /// not re-acquire (its own open guard would refuse our own
        /// holder).
        reuse_lease: bool,
    },
}

/// The composition root's engine assembly: rebuilds the in-process
/// session over the requested target. The RPC mode never rebuilds the
/// engine itself — pa-cli owns the assembly (cwd, model resolution,
/// auth), exactly like the TS runtime host owns `createRuntime`.
pub type RpcEngineFactory = Arc<
    dyn Fn(
            RpcEngineRequest,
        ) -> Pin<Box<dyn Future<Output = Result<RpcEngineHandle, String>> + Send>>
        + Send
        + Sync,
>;

/// The live session state one RPC connection drives.
pub struct RpcSession {
    handle: Arc<tokio::sync::RwLock<RpcEngineHandle>>,
    writer: LineWriter,
    factory: Option<RpcEngineFactory>,
    subscription: tokio::sync::Mutex<Option<Subscription>>,
    /// Connection outputs buffered while a prompt response is pending
    /// (TS `bufferedConnectionOutputs`): `Some` arms buffering, the flush
    /// emits the buffered frames in order.
    pending_outputs: Arc<tokio::sync::Mutex<Option<Vec<serde_json::Value>>>>,
    /// One replacement at a time (TS `acquireReplacementLease`): a fork
    /// racing a `switch_session` must not interleave.
    replacement: tokio::sync::Mutex<()>,
    /// Bumped on every successful whole-session replacement: pumps spawned
    /// against the replaced engine retire instead of delivering queued
    /// input to the disposed session.
    pump_epoch: Arc<AtomicU64>,
    /// Fired when a signal exit (SIGTERM/SIGHUP) begins: an in-flight
    /// replacement stops waiting the running turn out (it aborts and
    /// refuses), and later replacements answer immediately, so the
    /// 143/129 exit never queues behind a replacement's settle.
    signal_shutdown: std::sync::Arc<tokio_util::sync::CancellationToken>,
}

impl RpcSession {
    /// Adopt the first engine and subscribe its loop events.
    pub async fn adopt(
        handle: RpcEngineHandle,
        factory: Option<RpcEngineFactory>,
        writer: LineWriter,
    ) -> Self {
        let session = Self {
            handle: Arc::new(tokio::sync::RwLock::new(handle)),
            writer,
            factory,
            subscription: tokio::sync::Mutex::new(None),
            pending_outputs: Arc::new(tokio::sync::Mutex::new(None)),
            replacement: tokio::sync::Mutex::new(()),
            pump_epoch: Arc::new(AtomicU64::new(0)),
            signal_shutdown: std::sync::Arc::new(tokio_util::sync::CancellationToken::new()),
        };
        session.resubscribe().await;
        session
    }

    /// The current engine handle.
    pub async fn handle(&self) -> tokio::sync::RwLockReadGuard<'_, RpcEngineHandle> {
        self.handle.read().await
    }

    /// The current engine handle for mutation (the model-selection swap:
    /// provider target, model, and api key move together under the write
    /// guard).
    pub async fn handle_mut(&self) -> tokio::sync::RwLockWriteGuard<'_, RpcEngineHandle> {
        self.handle.write().await
    }

    /// Arm the prompt-response event buffer (TS `promptResponsePending =
    /// true`): while armed, connection events buffer instead of writing.
    pub async fn set_prompt_response_pending(&self, pending: bool) {
        let mut pending_outputs = self.pending_outputs.lock().await;
        if pending && pending_outputs.is_none() {
            *pending_outputs = Some(Vec::new());
        }
    }

    /// The prompt response settled: disarm the buffer and emit its frames
    /// in order (TS `promptResponsePending = false` +
    /// `flushConnectionEvents`, one step so no event can slip between
    /// them). The buffer cell stays locked until the buffered frames are
    /// enqueued, so a concurrent event can never write itself ahead of
    /// the older buffered frames. Events arriving after this write
    /// directly again.
    pub async fn flush_connection_events(&self) {
        let mut pending_outputs = self.pending_outputs.lock().await;
        let buffered = pending_outputs.take().unwrap_or_default();
        for event in buffered {
            self.writer.write(event);
        }
    }

    /// Publish one connection output (a compaction frame, a goal update)
    /// through the same buffering seam the subscribed session events use:
    /// while a prompt response is pending the frame buffers and flushes
    /// after the response (TS connection outputs never precede the prompt
    /// response they belong behind).
    pub async fn write_connection_output(&self, frame: serde_json::Value) {
        let mut pending_outputs = self.pending_outputs.lock().await;
        if let Some(buffer) = pending_outputs.as_mut() {
            buffer.push(frame);
        } else {
            self.writer.write(frame);
        }
    }

    /// The pump generation: a pump spawned against generation `n` retires
    /// once the session replaced its engine (`n` no longer current).
    pub fn pump_generation(&self) -> u64 {
        self.pump_epoch.load(Ordering::SeqCst)
    }

    /// Subscribe the current engine's loop events as raw session-event
    /// frames (TS forwards `event.event` verbatim); replaces the previous
    /// subscription.
    async fn resubscribe(&self) {
        let engine = self.handle.read().await.engine.clone();
        let subscription =
            Self::engine_subscription(&engine, &self.pending_outputs, &self.writer).await;
        *self.subscription.lock().await = Some(subscription);
    }

    /// Create the loop-event subscription for one engine (the frames
    /// forward through the shared prompt-response buffer and writer).
    async fn engine_subscription(
        engine: &Arc<SessionEngine>,
        pending_outputs: &Arc<tokio::sync::Mutex<Option<Vec<serde_json::Value>>>>,
        writer: &LineWriter,
    ) -> Subscription {
        let pending_outputs = Arc::clone(pending_outputs);
        let writer = writer.clone();
        engine
            .session
            .agent()
            .subscribe(move |event, _signal| {
                let pending_outputs = Arc::clone(&pending_outputs);
                let writer = writer.clone();
                Box::pin(async move {
                    if let Some(json) = agent_event_json(&event) {
                        if let Ok(event) = serde_json::from_str::<serde_json::Value>(&json) {
                            let mut pending_outputs = pending_outputs.lock().await;
                            if let Some(buffer) = pending_outputs.as_mut() {
                                buffer.push(event);
                            } else {
                                writer.write(event);
                            }
                        }
                    }
                    Ok(())
                })
            })
            .await
    }

    /// Retire the queued-input pumps (the pump epoch bump): the signal
    /// exit paths call this the instant the abort fires, so a pump
    /// waking as the aborted turn settles never delivers the next
    /// queued row before the exit.
    pub fn retire_pumps(&self) {
        self.pump_epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Acquire the whole-session replacement lease (TS
    /// `acquireReplacementLease`): one replacement flow at a time. The
    /// fork path holds it across its read/branch/swap so a concurrent
    /// `new_session`/`switch_session` cannot interleave between them
    /// (TS's synchronous pre-teardown section has the same effect).
    pub async fn replacement_lease(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.replacement.lock().await
    }

    /// Begin the signal exit (SIGTERM/SIGHUP): the shutdown broadcast
    /// makes any in-flight replacement's settle give way (abort the turn
    /// instead of waiting the model out) and refuses replacements that
    /// would start after the signal.
    pub fn fire_shutdown(&self) {
        self.signal_shutdown.cancel();
    }

    /// Whether the signal exit has begun: replacements refuse and queued
    /// input delivery stays parked (the exit's dispose owns the settle).
    pub fn shutdown_fired(&self) -> bool {
        self.signal_shutdown.is_cancelled()
    }

    /// Whole-session replacement with the lease already held by the
    /// caller (`replacement_lease` / `replace` acquire it).
    ///
    /// # Errors
    ///
    /// Returns the factory's assembly error when the replacement engine
    /// cannot be built (the live session stays serving).
    pub async fn replace_locked(&self, request: RpcEngineRequest) -> Result<(), String> {
        let factory = self
            .factory
            .clone()
            .ok_or_else(|| "Session switching is not wired for this RPC transport".to_string())?;
        // A signal exit has begun: never start a replacement the exit
        // would have to wait out (the 143/129 path aborts and exits).
        if self.signal_shutdown.is_cancelled() {
            return Err("A signal exit is in progress".to_string());
        }
        // Reopening the currently-owned session file: ADOPT the current
        // lease (TS `acquireReplacementLease` reuses the current lease
        // for the same path) — the lease never leaves this process, so
        // no failed build leaves the live session unleased and no
        // cross-process claim window opens.
        let mut adopted_lease = None;
        let mut request = request;
        if let RpcEngineRequest::Open {
            session_path,
            reuse_lease,
        } = &mut request
        {
            let canonical = crate::lease::canonical_session_path(session_path);
            let same_path = {
                let current = self.handle.write().await;
                current
                    .session_lease
                    .as_ref()
                    .is_some_and(|lease| lease.session_path == canonical)
            };
            if same_path {
                adopted_lease = self.handle.write().await.session_lease.take();
                *reuse_lease = true;
            }
        }
        // Retire the pumps spawned against the replaced engine BEFORE the
        // settle: a queued pump that wakes during the wait sees the moved
        // epoch and returns instead of delivering onto the session this
        // swap is about to dispose.
        self.pump_epoch.fetch_add(1, Ordering::SeqCst);
        // The write guard stays held through the settle, the build, and
        // the teardown: it waits out every live reader (a
        // prompt/steer/compact handler holding the handle), so no
        // command can admit a turn onto the old engine. A signal exit
        // gives way instead of queuing behind the guard: the adopted
        // lease (if any) drops with the early return — released, never
        // orphaned — and the exiting process owns nothing further.
        let mut handle = tokio::select! {
            guard = self.handle.write() => guard,
            () = self.signal_shutdown.cancelled() => {
                return Err("A signal exit is in progress".to_string());
            }
        };
        // Settle the running turn BEFORE the factory opens the file: the
        // turn's final rows land in the persisted history the
        // replacement hydrates from (an open before the settle would
        // read a stale tail), and the finishing turn's final events (its
        // `agent_end`) still reach the client — the old feed stays
        // subscribed until after the settle. A signal exit aborts the
        // turn instead of waiting the model out: the settle (and the
        // signal's exit behind it) completes without the in-flight call,
        // and the adopted lease returns to the still-live handle (the
        // refusal path below never publishes a replacement).
        let shutdown_during_settle = {
            let agent = handle.engine.session.agent();
            tokio::select! {
                () = agent.wait_for_idle() => false,
                () = self.signal_shutdown.cancelled() => true,
            }
        };
        if shutdown_during_settle {
            handle.engine.session.agent().abort();
            if adopted_lease.is_some() {
                handle.session_lease = adopted_lease;
            }
            return Err("A signal exit is in progress".to_string());
        }
        // Build the replacement after the settle: a failed assembly
        // leaves the live session serving (idle, subscribed, nothing
        // disposed — only the settle ran), and the adopted lease goes
        // back onto the held handle. The build races the shutdown
        // broadcast too: a signal landing mid-assembly cancels the
        // replacement (the live session answers the exit) instead of
        // holding the lease the signal handler is waiting on.
        let mut replacement = {
            let built = tokio::select! {
                built = factory(request) => built,
                () = self.signal_shutdown.cancelled() => {
                    if adopted_lease.is_some() {
                        handle.session_lease = adopted_lease;
                    }
                    return Err("A signal exit is in progress".to_string());
                }
            };
            match built {
                Ok(replacement) => replacement,
                Err(error) => {
                    if adopted_lease.is_some() {
                        handle.session_lease = adopted_lease;
                    }
                    return Err(error);
                }
            }
        };
        // Subscribe the replacement BEFORE publishing the handle: a
        // prompt dispatched the instant the handle lands finds the
        // subscription attached, so the turn's first events never drop.
        let subscription =
            Self::engine_subscription(&replacement.engine, &self.pending_outputs, &self.writer)
                .await;
        if let Some(subscription) = self.subscription.lock().await.take() {
            subscription.unsubscribe().await;
        }
        // The teardown races the shutdown broadcast: a signal during the
        // old kernel's disposal cancels the swap (the live session stays
        // published — exactly what the exit's abort/dispose targets) and
        // the adopted lease returns with it.
        let disposed = tokio::select! {
            () = handle.engine.dispose_kernel() => true,
            () = self.signal_shutdown.cancelled() => false,
        };
        if !disposed {
            if adopted_lease.is_some() {
                handle.session_lease = adopted_lease;
            }
            return Err("A signal exit is in progress".to_string());
        }
        // The adopted same-path lease rides the replacement (TS reuses
        // the current lease); a fresh-open replacement carries the lease
        // the factory's open guard acquired.
        if adopted_lease.is_some() {
            replacement.session_lease = adopted_lease;
        }
        *handle = replacement;
        *self.subscription.lock().await = Some(subscription);
        Ok(())
    }

    /// Whole-session replacement (TS `buildAndApplyReplacement`'s
    /// build-then-apply flow): build the replacement through the factory
    /// first, then unsubscribe the old feed, wait the running turn out,
    /// dispose the old kernel, swap the slot, and resubscribe.
    ///
    /// # Errors
    ///
    /// Returns the factory's assembly error when the replacement engine
    /// cannot be built.
    pub async fn replace(&self, request: RpcEngineRequest) -> Result<(), String> {
        let _lease = self.replacement.lock().await;
        self.replace_locked(request).await
    }

    /// The stdin-close settle (TS `onInputEnd` -> `waitForIdle` ->
    /// `shutdown`): retires the queued-input pumps, waits the running
    /// turn out, then unsubscribes and disposes the kernel.
    pub async fn dispose(&self) {
        // Retire the detached pumps first: none may deliver queued input
        // onto the session this settle is about to dispose.
        self.pump_epoch.fetch_add(1, Ordering::SeqCst);
        let engine = self.handle.read().await.engine.clone();
        // The settle precedes the unsubscribe (TS `waitForIdle` before
        // `shutdown`): the running turn's trailing frames and terminal
        // `agent_end` still stream while it settles — the subscription
        // retires only ahead of the kernel disposal.
        engine.session.agent().wait_for_idle().await;
        if let Some(subscription) = self.subscription.lock().await.take() {
            subscription.unsubscribe().await;
        }
        engine.dispose_kernel().await;
    }
}
