//! The in-process RPC connection: one live engine slot, the loop-event
//! subscription that forwards raw session-event frames, and the
//! whole-session replacement drive (`new_session`/`switch_session`/`fork`).

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use pa_agent::agent::Subscription;
use pa_core::session_engine::engine::SessionEngine;
use pa_core::session_engine::provider_adapter::ProviderTarget;
use pa_core::session_engine::session_events::agent_event_json;
use pa_types::ai::Model;

use super::LineWriter;

/// One assembled engine, the live provider target its stream reads
/// (`set_model` swaps it without rebuilding), and the session lease the
/// factory acquired for the opened file (dropped on replacement).
pub struct RpcEngineHandle {
    pub engine: Arc<SessionEngine>,
    pub model: Model,
    pub api_key: Option<String>,
    pub provider_target: Arc<std::sync::RwLock<Option<ProviderTarget>>>,
    /// The cross-process ownership lease on the opened session file
    /// (`None` for fresh/in-memory sessions the factory created itself).
    pub session_lease: Option<crate::lease::SessionLease>,
}

/// A whole-session replacement request: a fresh session (optionally under
/// a parent session) or an existing session file to open.
pub enum RpcEngineRequest {
    New {
        parent_session: Option<String>,
        /// The ACTIVE session's cwd (not the CLI startup directory); the
        /// factory falls back to the startup cwd when absent.
        cwd: Option<std::path::PathBuf>,
    },
    Open {
        session_path: PathBuf,
        /// The same-path reopen: the caller adopted the current lease, so
        /// the factory must not re-acquire (its open guard would refuse our own holder).
        reuse_lease: bool,
    },
}

/// The composition root's engine assembly; pa-cli owns the assembly
/// (cwd, model resolution, auth), not this mode.
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
    /// Connection outputs buffered while a prompt response is pending:
    /// `Some` arms buffering, the flush emits the buffered frames in order.
    pending_outputs: Arc<tokio::sync::Mutex<Option<Vec<serde_json::Value>>>>,
    /// One replacement at a time: a fork racing a `switch_session` must not interleave.
    replacement: tokio::sync::Mutex<()>,
    /// Bumped on every whole-session replacement: pumps spawned against
    /// the replaced engine retire instead of delivering.
    pump_epoch: Arc<AtomicU64>,
    /// True for the whole span of a replacement: a pump kicked mid-swap
    /// carries a current generation and identity, so those checks cannot
    /// see it — it must not deliver onto the engine being disposed.
    replacing: Arc<AtomicBool>,
    /// Fired when a signal exit (SIGTERM/SIGHUP) begins: an in-flight
    /// replacement aborts, so the exit never queues behind a settle.
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
            replacing: Arc::new(AtomicBool::new(false)),
            signal_shutdown: std::sync::Arc::new(tokio_util::sync::CancellationToken::new()),
        };
        session.resubscribe().await;
        session
    }

    pub async fn handle(&self) -> tokio::sync::RwLockReadGuard<'_, RpcEngineHandle> {
        self.handle.read().await
    }

    /// The handle for mutation (the model-selection swap: provider target,
    /// model, and api key move together under the write guard).
    pub async fn handle_mut(&self) -> tokio::sync::RwLockWriteGuard<'_, RpcEngineHandle> {
        self.handle.write().await
    }

    pub async fn set_prompt_response_pending(&self, pending: bool) {
        let mut pending_outputs = self.pending_outputs.lock().await;
        if pending && pending_outputs.is_none() {
            *pending_outputs = Some(Vec::new());
        }
    }

    /// Disarm the buffer and emit its frames in order, one step so no
    /// event slips between them; the cell stays locked until enqueued.
    pub async fn flush_connection_events(&self) {
        let mut pending_outputs = self.pending_outputs.lock().await;
        let buffered = pending_outputs.take().unwrap_or_default();
        for event in buffered {
            self.writer.write(event);
        }
    }

    /// Publish one connection output through the same buffering seam
    /// (buffers while a prompt response is pending).
    pub async fn write_connection_output(&self, frame: serde_json::Value) {
        let mut pending_outputs = self.pending_outputs.lock().await;
        if let Some(buffer) = pending_outputs.as_mut() {
            buffer.push(frame);
        } else {
            self.writer.write(frame);
        }
    }

    pub fn pump_generation(&self) -> u64 {
        self.pump_epoch.load(Ordering::SeqCst)
    }

    pub fn is_replacing(&self) -> bool {
        self.replacing.load(Ordering::SeqCst)
    }

    /// Arm the replacement-in-flight gate; the returned guard clears it
    /// on drop, so every return path releases the gate exactly once.
    fn replacing_gate(&self) -> ReplacingGate<'_> {
        self.replacing.store(true, Ordering::SeqCst);
        ReplacingGate(&self.replacing)
    }

    /// Whether `engine` is the live handle's engine (pointer identity): a replace bumps the
    /// generation BEFORE swapping the handle, so the identity check closes that sampling window.
    pub async fn engine_is_live(&self, engine: &std::sync::Arc<SessionEngine>) -> bool {
        std::sync::Arc::ptr_eq(&self.handle.read().await.engine, engine)
    }

    /// Subscribe the current engine's loop events as raw session-event
    /// frames; replaces the previous subscription.
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
                    if let Some(event) = agent_event_json(&event) {
                        let mut pending_outputs = pending_outputs.lock().await;
                        if let Some(buffer) = pending_outputs.as_mut() {
                            buffer.push(event);
                        } else {
                            writer.write(event);
                        }
                    }
                    Ok(())
                })
            })
            .await
    }

    /// Retire the queued-input pumps: the signal exit paths call this
    /// the instant the abort fires, so no pump delivers before the exit.
    pub fn retire_pumps(&self) {
        self.pump_epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Acquire the whole-session replacement lease: one replacement flow
    /// at a time; the fork path holds it across its read/branch/swap.
    pub async fn replacement_lease(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.replacement.lock().await
    }

    /// Begin the signal exit (SIGTERM/SIGHUP): in-flight replacements'
    /// settles abort and new replacements are refused.
    pub fn fire_shutdown(&self) {
        self.signal_shutdown.cancel();
    }

    pub fn shutdown_fired(&self) -> bool {
        self.signal_shutdown.is_cancelled()
    }

    /// Whole-session replacement with the lease already held by the caller.
    ///
    /// # Errors
    ///
    /// Returns the factory's assembly error when the replacement engine cannot
    /// be built (the live session stays serving).
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
        let mut adopted_lease = None;
        let mut request = request;
        // Retire the pumps spawned against the replaced engine BEFORE the
        // settle: a queued pump waking during the wait sees the moved epoch;
        // the in-flight gate retires a pump KICKED mid-settle.
        let _replacing = self.replacing_gate();
        self.pump_epoch.fetch_add(1, Ordering::SeqCst);
        // Settle the running turn BEFORE the factory opens the file: the
        // turn's final rows land in the history the replacement hydrates
        // from, and its final events still reach the client.
        // Unguarded settle: an RPC `abort` arriving mid-settle must reach the agent (a guarded
        // settle would wait a provider call out).
        {
            let agent = {
                let handle = self.handle.read().await;
                std::sync::Arc::clone(handle.engine.session.agent())
            };
            let shutdown_during_settle = tokio::select! {
                () = agent.wait_for_idle() => false,
                () = self.signal_shutdown.cancelled() => true,
            };
            if shutdown_during_settle {
                return Err("A signal exit is in progress".to_string());
            }
        }
        let mut handle = tokio::select! {
            guard = self.handle.write() => guard,
            () = self.signal_shutdown.cancelled() => {
                return Err("A signal exit is in progress".to_string());
            }
        };
        // A prompt or steer admitted onto the old engine inside the
        // guard-free settle window: the re-acquired write guard blocks every
        // new admission. Deliberate divergence from TS (open before teardown).
        //
        // Reopening the currently-owned file: ADOPT the current lease HERE
        // under the write guard (no refusal path re-acquires it).
        if let RpcEngineRequest::Open {
            session_path,
            reuse_lease,
        } = &mut request
        {
            let canonical = crate::lease::canonical_session_path(session_path);
            let same_path = handle
                .session_lease
                .as_ref()
                .is_some_and(|lease| lease.session_path == canonical);
            if same_path {
                adopted_lease = handle.session_lease.take();
                *reuse_lease = true;
            }
        }
        // Build the replacement after the settle: a failed assembly
        // leaves the live session serving; the adopted lease goes back
        // onto the held handle.
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
        // The teardown aborts only now that the replacement exists; the
        // check re-samples the LIVE streaming state, catching a turn
        // admitted after the re-acquire.
        if handle.engine.session.agent().state().await.is_streaming {
            handle.engine.session.agent().abort();
            handle.engine.session.agent().wait_for_idle().await;
        }
        // Subscribe the replacement BEFORE publishing the handle: a prompt
        // dispatched the instant the handle lands never drops its first events.
        let subscription =
            Self::engine_subscription(&replacement.engine, &self.pending_outputs, &self.writer)
                .await;
        if let Some(subscription) = self.subscription.lock().await.take() {
            subscription.unsubscribe().await;
        }
        // The teardown races the shutdown broadcast: a signal during the
        // disposal cancels the swap; the adopted lease returns with it.
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
        // The adopted same-path lease rides the replacement; a fresh-open
        // replacement carries the lease the factory's open guard acquired.
        if adopted_lease.is_some() {
            replacement.session_lease = adopted_lease;
        }
        *handle = replacement;
        *self.subscription.lock().await = Some(subscription);
        Ok(())
    }

    /// Whole-session replacement: build, settle, dispose, swap, resubscribe.
    ///
    /// # Errors
    ///
    /// Returns the factory's assembly error when the replacement engine cannot be built.
    pub async fn replace(&self, request: RpcEngineRequest) -> Result<(), String> {
        let _lease = self.replacement.lock().await;
        self.replace_locked(request).await
    }

    /// The stdin-close settle: retires the queued-input pumps, waits the
    /// running turn out, unsubscribes, and disposes the kernel. The handle
    /// retains its lease: bounded kernel disposal may leave host writers
    /// alive while the process drains its output.
    pub async fn dispose(&self) {
        // Retire the detached pumps first: none may deliver queued input
        // onto the session this settle is about to dispose.
        self.pump_epoch.fetch_add(1, Ordering::SeqCst);
        let engine = self.handle.read().await.engine.clone();
        // The settle precedes the unsubscribe: the turn's trailing frames
        // and terminal `agent_end` still stream while it settles.
        engine.session.agent().wait_for_idle().await;
        if let Some(subscription) = self.subscription.lock().await.take() {
            subscription.unsubscribe().await;
        }
        engine.dispose_kernel().await;
    }
}

/// The replacement-in-flight gate's release: clears the flag on drop so
/// every return path of `replace_locked` releases the gate exactly once.
struct ReplacingGate<'a>(&'a AtomicBool);

impl Drop for ReplacingGate<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
