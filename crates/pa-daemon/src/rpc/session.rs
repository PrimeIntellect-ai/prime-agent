//! The in-process RPC connection: one live engine slot, the loop-event
//! subscription that forwards raw session-event frames, and the
//! whole-session replacement `new_session` / `switch_session` / `fork`
//! drive (TS `InProcessAgentConnection` + the runtime host's session
//! replacement flows).

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use pa_agent::agent::Subscription;
use pa_core::session_engine::engine::SessionEngine;
use pa_core::session_engine::provider_adapter::ProviderTarget;
use pa_core::session_engine::session_events::agent_event_json;
use pa_types::ai::Model;

use super::LineWriter;

/// One assembled engine plus the live provider target its stream reads
/// (`set_model` swaps the target without rebuilding the session).
pub struct RpcEngineHandle {
    pub engine: Arc<SessionEngine>,
    pub model: Model,
    pub api_key: Option<String>,
    pub provider_target: Arc<std::sync::RwLock<Option<ProviderTarget>>>,
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
    /// them). Events arriving after this write directly again.
    pub async fn flush_connection_events(&self) {
        let buffered: Vec<serde_json::Value> = {
            let mut pending_outputs = self.pending_outputs.lock().await;
            pending_outputs.take().unwrap_or_default()
        };
        for event in buffered {
            self.writer.write(event);
        }
    }

    /// Subscribe the current engine's loop events as raw session-event
    /// frames (TS forwards `event.event` verbatim); replaces the previous
    /// subscription.
    async fn resubscribe(&self) {
        let engine = self.handle.read().await.engine.clone();
        let pending_outputs = Arc::clone(&self.pending_outputs);
        let writer = self.writer.clone();
        let subscription = engine
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
            .await;
        *self.subscription.lock().await = Some(subscription);
    }

    /// Whole-session replacement (TS `teardownForReplacement` ->
    /// `buildAndApplyReplacement`): unsubscribe the old feed, wait the
    /// running turn out, dispose the old kernel, build the replacement
    /// through the factory, swap the slot, and resubscribe.
    ///
    /// # Errors
    ///
    /// Returns the factory's assembly error when the replacement engine
    /// cannot be built.
    pub async fn replace(&self, request: RpcEngineRequest) -> Result<(), String> {
        let factory = self
            .factory
            .clone()
            .ok_or_else(|| "Session switching is not wired for this RPC transport".to_string())?;
        let _replacement = self.replacement.lock().await;
        if let Some(subscription) = self.subscription.lock().await.take() {
            subscription.unsubscribe().await;
        }
        let old = self.handle.read().await.engine.clone();
        old.session.agent().wait_for_idle().await;
        old.dispose_kernel().await;
        let replacement = factory(request).await?;
        *self.handle.write().await = replacement;
        self.resubscribe().await;
        Ok(())
    }

    /// The stdin-close settle (TS `onInputEnd` -> `waitForIdle` ->
    /// `shutdown`): waits the running turn out, then disposes the kernel.
    pub async fn dispose(&self) {
        let engine = self.handle.read().await.engine.clone();
        if let Some(subscription) = self.subscription.lock().await.take() {
            subscription.unsubscribe().await;
        }
        engine.session.agent().wait_for_idle().await;
        engine.dispose_kernel().await;
    }
}
