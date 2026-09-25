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
    New { parent_session: Option<String> },
    Open { session_path: PathBuf },
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

    /// The engine replacement seam, when the composition root wired one.
    pub fn factory(&self) -> Option<&RpcEngineFactory> {
        self.factory.as_ref()
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

    /// Acquire the whole-session replacement lease (TS
    /// `acquireReplacementLease`): one replacement flow at a time. The
    /// fork path holds it across its read/branch/swap so a concurrent
    /// `new_session`/`switch_session` cannot interleave between them
    /// (TS's synchronous pre-teardown section has the same effect).
    pub async fn replacement_lease(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.replacement.lock().await
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
        // Reopening the currently-owned session file: release the current
        // lease BEFORE the factory re-acquires it (TS's
        // `acquireReplacementLease` reuses the current lease for the same
        // path; releasing first lets the fresh acquire succeed).
        if let RpcEngineRequest::Open { session_path } = &request {
            let canonical = crate::lease::canonical_session_path(session_path);
            let same_path = {
                let current = self.handle.read().await;
                current
                    .session_lease
                    .as_ref()
                    .is_some_and(|lease| lease.session_path == canonical)
            };
            if same_path {
                // The dropped lease releases as the take's value drops.
                self.handle.write().await.session_lease.take();
            }
        }
        // Build the replacement BEFORE any teardown: a failed assembly
        // must leave the live session serving (the old kernel keeps its
        // subscription and turns; nothing was disposed). The swap below
        // runs only on a fully assembled replacement.
        let replacement = factory(request).await?;
        // Subscribe the replacement BEFORE publishing the handle: a
        // prompt dispatched the instant the handle lands finds the
        // subscription attached, so the turn's first events never drop.
        let subscription =
            Self::engine_subscription(&replacement.engine, &self.pending_outputs, &self.writer)
                .await;
        if let Some(subscription) = self.subscription.lock().await.take() {
            subscription.unsubscribe().await;
        }
        let old = self.handle.read().await.engine.clone();
        old.session.agent().wait_for_idle().await;
        old.dispose_kernel().await;
        // The write guard waits out every live reader (a prompt/steer
        // handler holding the handle), so the swap lands only once the
        // in-flight handle holders finish.
        *self.handle.write().await = replacement;
        *self.subscription.lock().await = Some(subscription);
        // Retire the pumps spawned against the replaced engine so queued
        // input never delivers to the disposed session.
        self.pump_epoch.fetch_add(1, Ordering::SeqCst);
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
    /// turn out, then disposes the kernel.
    pub async fn dispose(&self) {
        // Retire the detached pumps first: none may deliver queued input
        // onto the session this settle is about to dispose.
        self.pump_epoch.fetch_add(1, Ordering::SeqCst);
        let engine = self.handle.read().await.engine.clone();
        if let Some(subscription) = self.subscription.lock().await.take() {
            subscription.unsubscribe().await;
        }
        engine.session.agent().wait_for_idle().await;
        engine.dispose_kernel().await;
    }
}
